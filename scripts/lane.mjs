#!/usr/bin/env node
// new <slice> <file-or-dir>... [--base <ref>] [--protect <path>]...
// audit <slice> | list | drop <slice> [--force]
// Scope entries are normalized repository-relative paths, never globs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function fail(message) { throw new Error(message); }

function validateSlice(slice) {
  if (typeof slice !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(slice)) {
    fail('slice must start with a letter, digit or underscore and contain only A-Za-z0-9_.-');
  }
  return slice;
}

function normalizeEntry(entry) {
  if (typeof entry !== 'string' || !entry || /[\0\r\n*?\[\]{}]/.test(entry)) {
    fail('scope/protect entries must be nonempty paths; glob patterns are not supported');
  }
  const portable = entry.replace(/\\/g, '/');
  if (path.posix.isAbsolute(portable) || /^[A-Za-z]:/.test(portable)) fail(`absolute path is not allowed: ${entry}`);
  const normalized = path.posix.normalize(portable).replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`path escapes repository or names its root: ${entry}`);
  }
  if (normalized.split('/').some((part) => part.toLowerCase() === '.git')) fail(`Git metadata is not writable: ${entry}`);
  return normalized;
}

// Ancestor matching also handles a directory declared without a trailing slash.
const contains = (entry, file) => file === entry || file.startsWith(`${entry}/`);
const overlaps = (a, b) => contains(a, b) || contains(b, a);
const matches = (entries, file) => entries.some((entry) => contains(entry, file));

function statusPaths(wt, includeIgnored = false) {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
  if (includeIgnored) args.push('--ignored');
  const records = git(args, wt).split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') fail('invalid porcelain status record');
    paths.push(record.slice(3));
    // In -z format a rename/copy is destination NUL source NUL, without quoting.
    if (/[RC]/.test(record.slice(0, 2))) {
      if (!records[i + 1]) fail('missing rename/copy source in porcelain status');
      paths.push(records[++i]);
    }
  }
  return paths;
}

function noSymlinks(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`symlink path is not allowed: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!['new', 'audit', 'list', 'drop'].includes(cmd)) fail('usage: lane.mjs new|audit|list|drop');
  const slice = cmd === 'list' ? undefined : validateSlice(argv.shift());
  let base = 'HEAD';
  let force = false;
  const files = [];
  const protect = ['docs/gates', '.lanes'];
  if (cmd === 'new') {
    while (argv.length) {
      const arg = argv.shift();
      if (arg === '--base' || arg === '--protect') {
        const value = argv.shift();
        if (!value || value.startsWith('-')) fail(`missing value for ${arg}`);
        if (arg === '--base') base = value;
        else protect.push(normalizeEntry(value));
      } else {
        if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
        files.push(normalizeEntry(arg));
      }
    }
    if (!files.length) fail('declare at least one writable file or directory');
  } else if (cmd === 'drop' && argv.length === 1 && argv[0] === '--force') {
    force = true;
  } else if (argv.length) {
    fail(`unexpected arguments for ${cmd}: ${argv.join(' ')}`);
  }

  const cwd = process.cwd();
  const gitCommonDir = path.resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd).trim());
  const firstWorktree = git(['worktree', 'list', '--porcelain', '-z'], cwd).split('\0')[0];
  if (!firstWorktree.startsWith('worktree ')) fail('cannot locate main worktree');
  const root = firstWorktree.slice('worktree '.length);
  if (git(['rev-parse', '--is-bare-repository'], root).trim() === 'true') fail('bare repositories are not supported');
  noSymlinks(root, '.lanes');
  const lanesDir = path.join(root, '.lanes');
  const manifestPath = (id) => path.join(lanesDir, `${validateSlice(id)}.manifest.json`);
  const wtPath = (id) => path.join(lanesDir, validateSlice(id));

  function loadManifest(id) {
    noSymlinks(root, `.lanes/${validateSlice(id)}.manifest.json`);
    const m = JSON.parse(fs.readFileSync(manifestPath(id), 'utf8'));
    validateSlice(m.slice);
    if (m.slice !== id || m.branch !== `lane/${id}` || !/^[a-f0-9]{40,64}$/.test(m.base)
      || !Array.isArray(m.files) || !m.files.length || (m.protect !== undefined && !Array.isArray(m.protect))) {
      fail(`invalid manifest: ${id}`);
    }
    m.files = m.files.map(normalizeEntry);
    m.protect = [...new Set(['docs/gates', '.lanes', ...(m.protect ?? []).map(normalizeEntry)])];
    return m;
  }

  function manifests() {
    if (!fs.existsSync(lanesDir)) return [];
    return fs.readdirSync(lanesDir).filter((name) => name.endsWith('.manifest.json'))
      .map((name) => loadManifest(name.slice(0, -'.manifest.json'.length)));
  }

  if (cmd === 'new') {
    for (const file of files) {
      noSymlinks(root, file);
      if (protect.some((entry) => overlaps(entry, file))) fail(`writable scope intersects protected path: ${file}`);
    }
    if (fs.existsSync(wtPath(slice)) || fs.existsSync(manifestPath(slice))) fail(`lane already exists: ${slice}`);
    for (const m of manifests()) {
      if (files.some((file) => m.files.some((entry) => overlaps(entry, file)))) fail(`scope overlaps active lane: ${m.slice}`);
    }
    if (statusPaths(root).length) fail('main worktree is not clean');
    const baseSha = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], root).trim();
    const excl = path.join(gitCommonDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes('.lanes/')) {
      fs.writeFileSync(excl, cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + '.lanes/\n');
    }
    fs.mkdirSync(lanesDir, { recursive: true });
    git(['worktree', 'add', '-b', `lane/${slice}`, wtPath(slice), baseSha], root);
    const manifest = { slice, base: baseSha, branch: `lane/${slice}`, files, protect, createdAt: new Date().toISOString() };
    fs.writeFileSync(manifestPath(slice), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    console.log(`[lane] OK: ${wtPath(slice)}\n[lane] branch ${manifest.branch} @ ${baseSha.slice(0, 10)}`);
    console.log(`[lane] scope: ${files.join(', ')}\n[lane] protected: ${protect.join(', ')}`);
  }

  if (cmd === 'audit') {
    const m = loadManifest(slice);
    noSymlinks(root, `.lanes/${slice}`);
    const wt = wtPath(slice);
    const head = git(['rev-parse', 'HEAD'], wt).trim();
    const problems = [];
    if (head !== m.base) problems.push(`HEAD moved: ${m.base} -> ${head}`);
    const committed = git(['diff', '--name-only', '-z', '--no-renames', m.base, head, '--'], wt).split('\0').filter(Boolean);
    const changed = [...new Set([...statusPaths(wt), ...committed])];
    const outOfScope = changed.filter((file) => !matches(m.files, file));
    const touchedProtected = changed.filter((file) => matches(m.protect, file));
    if (outOfScope.length) problems.push(`out of scope: ${outOfScope.join(', ')}`);
    if (touchedProtected.length) problems.push(`protected paths changed: ${touchedProtected.join(', ')}`);
    console.log(`[lane] audit ${slice}: ${changed.length} changed paths`);
    for (const file of changed) console.log(`  ${JSON.stringify(file)}`);
    if (problems.length) fail(problems.join('\n[lane] FAIL: '));
    console.log('[lane] PASS: HEAD unchanged, all changes in scope, protected paths untouched');
  }

  if (cmd === 'list') {
    const ms = manifests();
    if (!ms.length) console.log('[lane] no active lanes');
    for (const m of ms) console.log(`${m.slice}  @${m.base.slice(0, 10)}  ${m.createdAt}  [${m.files.join(', ')}]`);
  }

  if (cmd === 'drop') {
    const m = loadManifest(slice);
    noSymlinks(root, `.lanes/${slice}`);
    const wt = wtPath(slice);
    if (!force) {
      if (statusPaths(wt, true).length) fail('worktree is dirty (including ignored files); use --force to discard');
      const mainHead = git(['rev-parse', 'HEAD'], root).trim();
      const heads = [git(['rev-parse', 'HEAD'], wt).trim(), git(['rev-parse', '--verify', `refs/heads/${m.branch}`], root).trim()];
      for (const head of new Set(heads)) {
        try { git(['merge-base', '--is-ancestor', head, mainHead], root); }
        catch { fail('lane has commits not merged into main worktree HEAD; use --force to discard'); }
      }
    }
    git(['worktree', 'remove', ...(force ? ['--force'] : []), wt], root);
    // -D is safe here only after the explicit ancestry checks, or with --force.
    git(['branch', '-D', m.branch], root);
    fs.unlinkSync(manifestPath(slice));
    console.log(`[lane] dropped: ${slice}`);
  }
}

try { main(); }
catch (error) { console.error(`[lane] FAIL: ${error.message}`); process.exitCode = 1; }
