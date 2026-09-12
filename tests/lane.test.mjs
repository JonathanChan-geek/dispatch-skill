import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../scripts/lane.mjs');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (root, file, content) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

// Build isolated fixture history from Git objects, without add/commit/push.
function snapshot(root, entries, parent) {
  const tree = {};
  for (const [file, content] of Object.entries(entries)) {
    const parts = file.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = git(root, ['hash-object', '-w', '--stdin'], content);
  }
  function emit(node) {
    return git(root, ['mktree', '-z'], Object.entries(node).map(([name, value]) => (
      typeof value === 'string' ? `100644 blob ${value}\t${name}\0` : `040000 tree ${emit(value)}\t${name}\0`
    )).join(''));
  }
  const body = `tree ${emit(tree)}\n${parent ? `parent ${parent}\n` : ''}author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture\n`;
  const head = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], body);
  git(root, ['update-ref', 'HEAD', head]);
  git(root, ['read-tree', '--reset', '-u', 'HEAD']);
  return head;
}

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(here, '.lane-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--initial-branch=main', '--template=']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'status.renames', 'true']);
  const entries = {
    'src/a.txt': 'alpha\n', 'src/a2.txt': 'second\n', 'src/中文 文件.txt': 'text\n',
    'outside/旧 文件.txt': 'rename source\n', 'docs/gates/check.md': 'frozen gate\n', ...extra,
  };
  const base = snapshot(root, entries);
  return { root, entries, base, wt: (id) => path.join(root, '.lanes', id) };
}

function run(cwd, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, output: result.stdout + result.stderr };
}
function ok(result) { assert.equal(result.status, 0, result.output); return result; }
function bad(result, pattern) {
  assert.notEqual(result.status, 0, result.output);
  if (pattern) assert.match(result.output, pattern);
  return result;
}

test('slice validation covers all commands, list arguments and manifest contents', (t) => {
  const { root } = fixture(t);
  for (const cmd of ['new', 'audit', 'drop']) {
    for (const id of ['../escape', '..', '/absolute', 'nested/id', 'x\\..\\y', '-bad']) {
      bad(run(root, cmd, id, ...(cmd === 'new' ? ['src/a.txt'] : [])), /slice/);
    }
    bad(run(root, cmd), /slice/);
  }
  bad(run(root, 'list', '../escape'), /unexpected/);
  assert.equal(fs.existsSync(path.join(root, '.lanes')), false);
  ok(run(root, 'new', 'valid', 'src/a.txt'));
  const manifest = path.join(root, '.lanes/valid.manifest.json');
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, JSON.stringify({ ...data, slice: '../escape' }));
  bad(run(root, 'list'), /slice/);
  bad(run(root, 'audit', 'valid'), /slice/);
  bad(run(root, 'drop', 'valid', '--force'), /slice/);
});

test('new rejects missing values, unknown flags, escaping paths and globs', (t) => {
  const { root } = fixture(t);
  for (const args of [[], ['src', '--base'], ['src', '--protect'], ['src', '--unknown'], ['../src'], ['/tmp/src'], ['C:\\src'], ['src/*'], ['src/[ab]'], ['src/?.txt'], ['src/{a,b}']]) {
    bad(run(root, 'new', 'invalid', ...args));
  }
  assert.equal(fs.existsSync(path.join(root, '.lanes')), false);
});

test('normalized scopes cannot overlap active lanes; path boundaries remain distinct', (t) => {
  const { root, base } = fixture(t);
  ok(run(root, 'new', 'one', './src//a.txt', '--base', base));
  bad(run(root, 'new', 'same', 'src/x/../a.txt'), /overlaps active lane/);
  bad(run(root, 'new', 'parent', 'src/'), /overlaps active lane/);
  ok(run(root, 'new', 'sibling', 'src/a2.txt'));
  assert.match(ok(run(root, 'list')).output, /one/);
  ok(run(root, 'drop', 'sibling'));
  ok(run(root, 'drop', 'one'));
  ok(run(root, 'new', 'parent', 'src/'));
  bad(run(root, 'new', 'child', 'src/a.txt'), /overlaps active lane/);
});

test('new rejects protected paths, their ancestors, metadata and symlink scopes', (t) => {
  const { root } = fixture(t);
  for (const file of ['docs/gates/check.md', 'docs/gates/', 'docs/', '.git/config', '.lanes/worker']) {
    bad(run(root, 'new', 'protected', file), /protected|metadata/);
  }
  bad(run(root, 'new', 'custom', 'src/', '--protect', './src/a.txt'), /protected/);
  fs.symlinkSync('src', path.join(root, 'alias'));
  bad(run(root, 'new', 'linked', 'alias/a.txt'), /symlink/);
});

test('new refuses dirty main tree and resolves main root from a lane subdirectory', (t) => {
  const { root, wt } = fixture(t);
  write(root, 'untracked', 'user data');
  bad(run(root, 'new', 'one', 'src/a.txt'), /not clean/);
  fs.unlinkSync(path.join(root, 'untracked'));
  ok(run(root, 'new', 'one', 'src/a.txt'));
  ok(run(path.join(wt('one'), 'src'), 'new', 'two', 'src/a2.txt'));
  assert.ok(fs.existsSync(wt('two')));
});

test('audit accepts Chinese and whitespace paths, but rejects untracked out-of-scope paths', (t) => {
  const { root, wt } = fixture(t);
  ok(run(root, 'new', 'text', 'src/'));
  write(wt('text'), 'src/中文 文件.txt', 'modified\n');
  write(wt('text'), 'src/ 空格 -> 中文 \n.txt', 'untracked\n');
  assert.match(ok(run(root, 'audit', 'text')).output, /中文/);
  write(wt('text'), 'outside/新 文件.txt', 'unexpected');
  bad(run(root, 'audit', 'text'), /out of scope: outside\/新 文件.txt/);
});

test('audit checks both rename paths and always protects gates', (t) => {
  const { root, wt } = fixture(t);
  ok(run(root, 'new', 'renames', 'src/'));
  git(wt('renames'), ['mv', 'outside/旧 文件.txt', 'src/新 -> 文件.txt']);
  git(wt('renames'), ['mv', 'docs/gates/check.md', 'src/check.md']);
  const manifest = path.join(root, '.lanes/renames.manifest.json');
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, JSON.stringify({ ...data, protect: [] }));
  const result = bad(run(root, 'audit', 'renames'), /protected paths changed: docs\/gates\/check.md/);
  assert.match(result.output, /outside\/旧 文件.txt/);
  assert.match(result.output, /src\/新 -> 文件.txt/);
});

test('audit accepts in-scope renames and rejects rename destinations outside scope', (t) => {
  const { root, wt } = fixture(t);
  ok(run(root, 'new', 'renames', 'src/'));
  git(wt('renames'), ['mv', 'src/a.txt', 'src/新 文件.txt']);
  ok(run(root, 'audit', 'renames'));
  git(wt('renames'), ['mv', 'src/a2.txt', 'outside/new.txt']);
  bad(run(root, 'audit', 'renames'), /out of scope: outside\/new.txt/);
});

test('audit includes committed paths when HEAD moves, including gates', (t) => {
  const { root, wt, entries, base } = fixture(t);
  ok(run(root, 'new', 'moved', 'src/'));
  snapshot(wt('moved'), { ...entries, 'docs/gates/check.md': 'changed gate\n' }, base);
  assert.equal(git(wt('moved'), ['status', '--porcelain']), '');
  const result = bad(run(root, 'audit', 'moved'), /HEAD moved/);
  assert.match(result.output, /protected paths changed: docs\/gates\/check.md/);
  assert.match(result.output, /out of scope/);
});

test('drop preserves dirty and ignored files unless --force is explicit', (t) => {
  const { root, wt } = fixture(t, { '.gitignore': 'cache/\n' });
  ok(run(root, 'new', 'dirty', 'src/'));
  write(wt('dirty'), 'src/a.txt', 'valuable data');
  bad(run(root, 'drop', 'dirty'), /dirty/);
  assert.equal(fs.readFileSync(path.join(wt('dirty'), 'src/a.txt'), 'utf8'), 'valuable data');
  bad(run(root, 'drop', 'dirty', '--unknown'), /unexpected/);
  ok(run(root, 'drop', 'dirty', '--force'));
  assert.equal(fs.existsSync(wt('dirty')), false);
  assert.equal(fs.existsSync(path.join(root, '.lanes/dirty.manifest.json')), false);
  ok(run(root, 'new', 'ignored', 'src/'));
  write(wt('ignored'), 'cache/local.bin', 'ignored but valuable');
  bad(run(root, 'drop', 'ignored'), /dirty/);
  ok(run(root, 'drop', 'ignored', '--force'));
});

test('drop refuses unmerged commits, permits merged commits, and force discards', (t) => {
  const { root, wt, entries, base } = fixture(t);
  ok(run(root, 'new', 'unmerged', 'src/'));
  const changed = snapshot(wt('unmerged'), { ...entries, 'src/a.txt': 'new revision\n' }, base);
  bad(run(root, 'drop', 'unmerged'), /not merged/);
  assert.equal(git(root, ['rev-parse', 'refs/heads/lane/unmerged']), changed);
  git(root, ['update-ref', 'HEAD', changed]);
  git(root, ['read-tree', '--reset', '-u', 'HEAD']);
  ok(run(root, 'drop', 'unmerged'));
  ok(run(root, 'new', 'discard', 'src/'));
  snapshot(wt('discard'), { ...entries, 'src/a.txt': 'discard revision\n' }, changed);
  bad(run(root, 'drop', 'discard'), /not merged/);
  ok(run(root, 'drop', 'discard', '--force'));
});

test('drop checks a detached worktree HEAD as well as its lane branch', (t) => {
  const { root, wt, entries, base } = fixture(t);
  ok(run(root, 'new', 'detached', 'src/'));
  const changed = snapshot(wt('detached'), { ...entries, 'src/a.txt': 'detached revision\n' }, base);
  git(wt('detached'), ['update-ref', '--no-deref', 'HEAD', changed]);
  git(root, ['update-ref', 'refs/heads/lane/detached', base]);
  bad(run(root, 'drop', 'detached'), /not merged/);
  ok(run(root, 'drop', 'detached', '--force'));
});
