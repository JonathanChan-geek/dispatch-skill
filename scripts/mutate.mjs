#!/usr/bin/env node
// mutate.mjs <file> <before> <after> [--cmd "pnpm test"]
// mutate.mjs --spec mutations.json
// Spec: [{ name?, file, before, after, cmd? }]. Targets must be tracked and clean.
// Every distinct test command must pass on the originals before any mutation.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
const fail = (message) => { throw new Error(message); };

function parseSpecs(argv) {
  let specs;
  if (argv[0] === '--spec') {
    if (argv.length !== 2 || !argv[1] || argv[1].startsWith('--')) fail('usage: mutate.mjs --spec <json-file>');
    specs = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  } else {
    if (![3, 5].includes(argv.length) || argv[0]?.startsWith('--') || (argv.length === 5 && argv[3] !== '--cmd')) {
      fail('usage: mutate.mjs <file> <before> <after> [--cmd <command>]');
    }
    specs = [{ file: argv[0], before: argv[1], after: argv[2], cmd: argv.length === 5 ? argv[4] : 'pnpm test' }];
  }
  if (!Array.isArray(specs) || !specs.length) fail('spec must be a nonempty array');
  return specs.map((spec) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('each mutation must be an object');
    for (const key of ['file', 'before', 'after']) {
      if (typeof spec[key] !== 'string' || spec[key].includes('\0') || (key !== 'after' && !spec[key].length)) {
        fail(`${key} must be a ${key === 'after' ? '' : 'nonempty '}string without NUL`);
      }
    }
    if (spec.name !== undefined && typeof spec.name !== 'string') fail('name must be a string');
    const cmd = spec.cmd === undefined ? 'pnpm test' : spec.cmd;
    if (typeof cmd !== 'string' || !cmd.trim() || cmd.includes('\0')) fail('cmd must be a nonempty command string');
    if (spec.before === spec.after) fail('before and after must differ');
    return { ...spec, cmd, file: path.resolve(spec.file) };
  });
}

function matchWithEol(source, snippet) {
  for (const candidate of [snippet, snippet.replace(/\r?\n/g, '\r\n'), snippet.replace(/\r\n/g, '\n')]) {
    if (source.includes(candidate)) return candidate;
  }
  return null;
}

function runCommand(cmd) {
  const result = spawnSync(cmd, { shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status === null) fail(`test command did not exit normally: ${result.error?.message ?? result.signal}`);
  return result.status;
}

function main() {
  const specs = parseSpecs(process.argv.slice(2));
  const root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim());
  const originals = new Map();
  for (const { file } of specs) {
    if (originals.has(file)) continue;
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`target is outside repository: ${file}`);
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) fail(`target must be a regular file without symlinks: ${file}`);
    const pathspec = `:(top,literal)${relative.split(path.sep).join('/')}`;
    git(['ls-files', '--error-unmatch', '--', pathspec]);
    const indexFlags = git(['ls-files', '-v', '-z', '--', pathspec]).split('\0').filter(Boolean);
    if (indexFlags.some((entry) => entry[0] === 'S' || /^[a-z]/.test(entry))) {
      fail(`cannot verify clean target with assume-unchanged/skip-worktree flags: ${file}`);
    }
    if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', pathspec])) fail(`target file has uncommitted changes: ${file}`);
    const original = fs.readFileSync(file);
    if (original.includes(0) || !Buffer.from(original.toString('utf8')).equals(original)) fail(`target must be UTF-8 text: ${file}`);
    originals.set(file, original);
  }

  const restore = () => {
    const errors = [];
    for (const [file, original] of originals) {
      try { fs.writeFileSync(file, original); } catch (error) { errors.push(`${file}: ${error.message}`); }
    }
    if (errors.length) fail(`RESTORE_FAILED: ${errors.join('; ')}`);
  };
  let unsuccessful = false;
  try {
    for (const cmd of new Set(specs.map((spec) => spec.cmd))) {
      console.log(`\nBASELINE: ${cmd}`);
      if (runCommand(cmd) !== 0) fail('BASELINE_FAILED: original tests must be green');
      for (const [file, original] of originals) {
        if (!fs.readFileSync(file).equals(original)) fail(`BASELINE_CHANGED_TARGET: ${file}`);
      }
    }
    for (const spec of specs) {
      const original = originals.get(spec.file);
      const source = original.toString('utf8');
      console.log(`\nMUTATION: ${spec.name ?? spec.file}`);
      const matched = matchWithEol(source, spec.before);
      if (matched === null) {
        console.error('MUTATION_NOT_APPLIED: target snippet not found');
        unsuccessful = true;
        continue;
      }
      const crlf = matched.includes('\r\n') || (!matched.includes('\n') && source.includes('\r\n'));
      const replacement = crlf ? spec.after.replace(/\r?\n/g, '\r\n') : spec.after.replace(/\r\n/g, '\n');
      // A function replacement treats $, $&, $1 and backticks as literal source text.
      const mutated = source.replace(matched, () => replacement);
      if (mutated === source) {
        console.error('MUTATION_NOT_APPLIED: replacement is unchanged after EOL normalization');
        unsuccessful = true;
        continue;
      }
      try {
        fs.writeFileSync(spec.file, mutated);
        const red = runCommand(spec.cmd) !== 0;
        console.log(red ? 'MUTATION_KILLED' : 'MUTATION_SURVIVED');
        if (!red) unsuccessful = true;
      } finally {
        restore();
      }
    }
  } finally {
    restore();
  }
  console.log('RESTORED: original target bytes');
  if (unsuccessful) process.exitCode = 1;
}

try { main(); }
catch (error) { console.error(`[mutate] FAIL: ${error.message}`); process.exitCode = 2; }
