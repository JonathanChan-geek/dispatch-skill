import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../scripts/mutate.mjs');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
const command = (code) => `${quote(process.execPath)} -e ${quote(code)}`;
const passing = command('process.exit(0)');
const checking = (file) => command(`const fs = require('node:fs'); process.exit(fs.readFileSync(${JSON.stringify(file)}, 'utf8').includes('good') ? 0 : 1)`);

// Fixture history uses plumbing only, never git add/commit/push.
function fixture(t, entries = { 'target.txt': 'good\n' }) {
  const root = fs.mkdtempSync(path.join(here, '.mutate-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--initial-branch=main', '--template=']);
  git(root, ['config', 'core.autocrlf', 'false']);
  const records = Object.entries(entries).map(([file, content]) => {
    const blob = git(root, ['hash-object', '-w', '--stdin'], content);
    return `100644 blob ${blob}\t${file}\0`;
  });
  const tree = git(root, ['mktree', '-z'], records.join(''));
  const body = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture\n`;
  const head = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], body);
  git(root, ['update-ref', 'HEAD', head]);
  git(root, ['read-tree', '--reset', '-u', 'HEAD']);
  return root;
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
function spec(root, value) {
  fs.writeFileSync(path.join(root, 'mutations.json'), JSON.stringify(value));
  return ['--spec', 'mutations.json'];
}
function restored(root, file, expected) {
  assert.deepEqual(fs.readFileSync(path.join(root, file)), Buffer.from(expected));
  assert.equal(git(root, ['status', '--porcelain', '--', file]), '');
}

test('positional CLI requires a green baseline and restores a killed mutation', (t) => {
  const root = fixture(t);
  const result = ok(run(root, 'target.txt', 'good', 'bad', '--cmd', checking('target.txt')));
  assert.match(result.output, /BASELINE:/);
  assert.match(result.output, /MUTATION_KILLED/);
  restored(root, 'target.txt', 'good\n');
});

test('baseline failure cannot count as a killed mutation and restores target writes', (t) => {
  const root = fixture(t);
  const result = bad(run(root, 'target.txt', 'good', 'bad', '--cmd', command("require('node:fs').writeFileSync('target.txt', 'baseline wrote this'); process.exit(1)")), /BASELINE_FAILED/);
  assert.doesNotMatch(result.output, /MUTATION_KILLED/);
  restored(root, 'target.txt', 'good\n');
});

test('a passing baseline that rewrites a target is rejected and restored', (t) => {
  const root = fixture(t);
  bad(run(root, 'target.txt', 'good', 'bad', '--cmd', command("require('node:fs').writeFileSync('target.txt', 'rewritten')")), /BASELINE_CHANGED_TARGET/);
  restored(root, 'target.txt', 'good\n');
});

test('surviving and unmatched mutations exit nonzero and preserve original bytes', (t) => {
  const root = fixture(t);
  bad(run(root, 'target.txt', 'good', 'bad', '--cmd', passing), /MUTATION_SURVIVED/);
  restored(root, 'target.txt', 'good\n');
  bad(run(root, 'target.txt', 'absent', 'bad', '--cmd', passing), /MUTATION_NOT_APPLIED/);
  restored(root, 'target.txt', 'good\n');
});

test('dirty tracked, staged, untracked and ignored targets are rejected', (t) => {
  const root = fixture(t, { 'target.txt': 'good\n', '.gitignore': 'ignored.txt\n' });
  fs.writeFileSync(path.join(root, 'target.txt'), 'user changes\n');
  bad(run(root, 'target.txt', 'user', 'bad', '--cmd', passing), /uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'user changes\n');
  const blob = git(root, ['hash-object', '-w', '--stdin'], 'user changes\n');
  git(root, ['update-index', '--cacheinfo', `100644,${blob},target.txt`]);
  bad(run(root, 'target.txt', 'user', 'bad', '--cmd', passing), /uncommitted changes/);
  for (const file of ['untracked.txt', 'ignored.txt']) {
    fs.writeFileSync(path.join(root, file), 'good');
    bad(run(root, file, 'good', 'bad', '--cmd', passing));
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'good');
  }
});

test('literal Chinese, spaces and glob-like target names work despite unrelated dirt', (t) => {
  const file = '中文 [abc] 文件.txt';
  const root = fixture(t, { [file]: 'good\n', 'unrelated.txt': 'original\n' });
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'user changes\n');
  ok(run(root, file, 'good', 'bad', '--cmd', checking(file)));
  restored(root, file, 'good\n');
  assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'user changes\n');
});

test('Git flags cannot hide dirty targets from the cleanliness precondition', (t) => {
  const root = fixture(t);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    git(root, ['update-index', `--${flag}`, 'target.txt']);
    fs.writeFileSync(path.join(root, 'target.txt'), 'hidden user changes\n');
    assert.equal(git(root, ['status', '--porcelain', '--', 'target.txt']), '');
    bad(run(root, 'target.txt', 'hidden', 'bad', '--cmd', passing), /cannot verify clean target/);
    assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'hidden user changes\n');
    fs.writeFileSync(path.join(root, 'target.txt'), 'good\n');
    git(root, ['update-index', `--no-${flag}`, 'target.txt']);
  }
});

test('CRLF matching and multiline replacements preserve EOLs and original bytes', (t) => {
  const root = fixture(t, { 'target.txt': 'good\r\nline\r\n' });
  const cmd = command("const fs = require('node:fs'); const value = fs.readFileSync('target.txt', 'utf8'); fs.appendFileSync('seen.jsonl', JSON.stringify(value) + '\\n'); process.exit(value.includes('good') ? 0 : 1)");
  ok(run(root, 'target.txt', 'good\nline', 'bad\nchanged', '--cmd', cmd));
  restored(root, 'target.txt', 'good\r\nline\r\n');
  const seen = fs.readFileSync(path.join(root, 'seen.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(seen, ['good\r\nline\r\n', 'bad\r\nchanged\r\n']);
  fs.unlinkSync(path.join(root, 'seen.jsonl'));
  ok(run(root, 'target.txt', 'good', 'bad\nextra', '--cmd', cmd));
  const single = fs.readFileSync(path.join(root, 'seen.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(single[1], 'bad\r\nextra\r\nline\r\n');
  restored(root, 'target.txt', 'good\r\nline\r\n');
});

test('replacement dollar syntax is literal and empty replacement is supported', (t) => {
  const root = fixture(t);
  const replacement = '$& $$ $1 $`';
  const cmd = command("const fs = require('node:fs'); const value = fs.readFileSync('target.txt', 'utf8'); fs.appendFileSync('seen.jsonl', JSON.stringify(value) + '\\n'); process.exit(value === 'good\\n' ? 0 : 1)");
  ok(run(root, 'target.txt', 'good', replacement, '--cmd', cmd));
  const seen = fs.readFileSync(path.join(root, 'seen.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(seen[1], replacement + '\n');
  ok(run(root, 'target.txt', 'good', '', '--cmd', checking('target.txt')));
  restored(root, 'target.txt', 'good\n');
});

test('--spec runs unique baselines before mutations and each mutation starts from originals', (t) => {
  const root = fixture(t, { 'one.txt': 'good\n', 'two.txt': 'good\n' });
  const cmd = command("const fs = require('node:fs'); const values = ['one.txt', 'two.txt'].map(file => fs.readFileSync(file, 'utf8')); fs.appendFileSync('seen.jsonl', JSON.stringify(values) + '\\n'); process.exit(values.every(value => value.includes('good')) ? 0 : 1)");
  ok(run(root, ...spec(root, [
    { name: 'first', file: 'one.txt', before: 'good', after: 'bad', cmd },
    { name: 'second', file: 'two.txt', before: 'good', after: 'bad', cmd },
  ])));
  const seen = fs.readFileSync(path.join(root, 'seen.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(seen, [['good\n', 'good\n'], ['bad\n', 'good\n'], ['good\n', 'bad\n']]);
  restored(root, 'one.txt', 'good\n');
  restored(root, 'two.txt', 'good\n');
});

test('--spec fails when any baseline is red or any mutation is not applied', (t) => {
  const root = fixture(t);
  const first = { file: 'target.txt', before: 'good', after: 'bad', cmd: checking('target.txt') };
  const result = bad(run(root, ...spec(root, [first, { ...first, cmd: command('process.exit(1)') }])), /BASELINE_FAILED/);
  assert.doesNotMatch(result.output, /MUTATION_KILLED/);
  bad(run(root, ...spec(root, [first, { ...first, before: 'absent' }])), /MUTATION_NOT_APPLIED/);
  restored(root, 'target.txt', 'good\n');
});

test('invalid arguments and malformed specifications fail before changing files', (t) => {
  const root = fixture(t);
  for (const args of [[], ['target.txt'], ['target.txt', 'good'], ['target.txt', 'good', 'bad', '--cmd'], ['target.txt', 'good', 'bad', '--unknown', passing], ['target.txt', '', 'bad'], ['target.txt', 'good', 'good'], ['target.txt', 'good', 'bad', '--cmd', ''], ['--spec'], ['--spec', 'x', 'extra']]) {
    bad(run(root, ...args));
  }
  for (const value of [[], {}, null, [null], [{ file: 'target.txt', before: 'good' }], [{ file: 'target.txt', before: '', after: 'bad' }], [{ file: 'target.txt', before: 'good', after: 'bad', cmd: null }]]) {
    bad(run(root, ...spec(root, value)));
  }
  fs.writeFileSync(path.join(root, 'mutations.json'), '{invalid json');
  bad(run(root, '--spec', 'mutations.json'));
  restored(root, 'target.txt', 'good\n');
});

test('EOL-only no-op mutations are not accepted as applied', (t) => {
  const root = fixture(t, { 'target.txt': 'good\r\n' });
  bad(run(root, 'target.txt', 'good\n', 'good\r\n', '--cmd', passing), /MUTATION_NOT_APPLIED/);
  restored(root, 'target.txt', 'good\r\n');
});
