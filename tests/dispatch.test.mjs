import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts', 'dispatch.mjs');
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'));
  const cwd = path.join(dir, 'workspace with spaces');
  fs.mkdirSync(cwd);
  const bin = path.join(dir, 'fake-worker');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const result = { args, cwd: process.cwd(), worker: process.env.GPT_DISPATCH_WORKER };
const finish = () => {
  if (process.env.MOCK_MODE === 'fail') { console.error('worker failed'); process.exit(7); }
  if (process.env.MOCK_MODE === 'empty') process.exit(0);
  const text = JSON.stringify(result);
  const i = args.indexOf('--output-last-message');
  if (i >= 0) fs.writeFileSync(args[i + 1], text);
  console.log(text);
};
if (process.env.MOCK_MODE === 'hang') {
  console.log('worker ready');
  setInterval(() => {}, 1000);
} else if (args[0] === 'exec') {
  result.prompt = '';
  process.stdin.on('data', d => result.prompt += d);
  process.stdin.on('end', finish);
} else finish();
`, { mode: 0o755 });
  const env = { ...process.env, DISPATCH_HOME: path.join(dir, 'state'), CODEX_BIN: bin, KIMI_BIN: bin, ...extra };
  delete env.GPT_DISPATCH_WORKER;
  const prompt = path.join(dir, 'order.md');
  fs.writeFileSync(prompt, 'Inspect files only. Literal shell syntax: $(touch SHOULD_NOT_EXIST); "quotes".');
  const call = (args) => spawnSync(process.execPath, [runner, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
  const start = (args = []) => {
    const out = call(['start', '--worker', 'codex', '--prompt-file', prompt, ...args]);
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  t.after(() => {
    const jobs = path.join(env.DISPATCH_HOME, 'jobs');
    if (fs.existsSync(jobs)) for (const id of fs.readdirSync(jobs)) call(['cancel', id]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, cwd, env, prompt, call, start };
}

test('Codex background job preserves arguments, stdin, cwd and final report', (t) => {
  const f = fixture(t);
  const job = f.start(['--sandbox', 'workspace-write', '--model', 'custom-gpt', '--effort', 'high']);
  const done = f.call(['wait', job.id, '--poll', '0.02', '--timeout', '5']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).status, 'succeeded');
  const report = JSON.parse(f.call(['result', job.id]).stdout);
  assert.equal(report.cwd, fs.realpathSync(f.cwd));
  assert.equal(report.worker, '1');
  assert.ok(report.args.includes('custom-gpt'));
  assert.ok(report.args.includes('workspace-write'));
  assert.ok(report.args.includes('model_reasoning_effort="high"'));
  assert.match(report.prompt, /\$\(touch SHOULD_NOT_EXIST\)/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'SHOULD_NOT_EXIST')), false);
  assert.equal(fs.readdirSync(path.join(f.env.DISPATCH_HOME, 'locks')).length, 0);
});

test('Kimi runs prompt mode without shell, auto flags or a forced model', (t) => {
  const f = fixture(t);
  const start = f.call(['start', '--worker', 'kimi', '--prompt-file', f.prompt]);
  assert.equal(start.status, 0, start.stderr);
  const job = JSON.parse(start.stdout);
  assert.equal(f.call(['wait', job.id, '--poll', '0.02', '--timeout', '5']).status, 0);
  const report = JSON.parse(f.call(['result', job.id]).stdout);
  assert.equal(report.args[0], '-p');
  assert.match(report.args[1], /\$\(touch SHOULD_NOT_EXIST\)/);
  assert.equal(report.args.length, 2);
});

test('worker failure and empty report cannot masquerade as success', (t) => {
  for (const mode of ['fail', 'empty']) {
    const f = fixture(t, { MOCK_MODE: mode });
    const job = f.start();
    const done = f.call(['wait', job.id, '--poll', '0.02', '--timeout', '5']);
    assert.equal(done.status, 1);
    assert.equal(JSON.parse(done.stdout).status, 'failed');
    assert.equal(f.call(['result', job.id]).status, 1);
  }
});

test('wait timeout does not cancel; directory locking and cancellation work', (t) => {
  const f = fixture(t, { MOCK_MODE: 'hang' });
  const job = f.start();
  assert.equal(f.call(['wait', job.id, '--timeout', '0']).status, 1);
  assert.equal(JSON.parse(f.call(['status', job.id]).stdout).status, 'running');
  assert.equal(f.call(['result', job.id]).status, 1);
  const blocked = f.call(['start', '--worker', 'kimi', '--prompt-file', f.prompt]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /busy/);
  const cancelled = f.call(['cancel', job.id]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, 'cancelled');
  assert.equal(fs.readdirSync(path.join(f.env.DISPATCH_HOME, 'locks')).length, 0);
});

test('distinct working directories run independently', (t) => {
  const f = fixture(t, { MOCK_MODE: 'hang' });
  const other = path.join(f.dir, 'other');
  fs.mkdirSync(other);
  const one = f.start();
  const two = f.start(['--cwd', other]);
  assert.notEqual(one.id, two.id);
  assert.equal(JSON.parse(f.call(['status', two.id]).stdout).status, 'running');
});

test('explicit worker timeout fails and releases directory lock', (t) => {
  const f = fixture(t, { MOCK_MODE: 'hang' });
  const job = f.start(['--timeout', '0.1']);
  const done = f.call(['wait', job.id, '--poll', '0.02', '--timeout', '5']);
  assert.equal(done.status, 1);
  assert.equal(JSON.parse(done.stdout).error, 'timeout');
  assert.equal(fs.readdirSync(path.join(f.env.DISPATCH_HOME, 'locks')).length, 0);
});

test('retry targets an exact job and carries original order and corrections', (t) => {
  const f = fixture(t);
  const first = f.start();
  assert.equal(f.call(['wait', first.id, '--poll', '0.02', '--timeout', '5']).status, 0);
  const corrections = path.join(f.dir, 'corrections.md');
  fs.writeFileSync(corrections, 'Include the missing command output.');
  const next = f.call(['retry', first.id, '--prompt-file', corrections]);
  assert.equal(next.status, 0, next.stderr);
  const job = JSON.parse(next.stdout);
  assert.equal(job.retryOf, first.id);
  assert.equal(f.call(['wait', job.id, '--poll', '0.02', '--timeout', '5']).status, 0);
  assert.match(JSON.parse(f.call(['result', job.id]).stdout).prompt, /Include the missing command output/);
});

test('unknown jobs and invalid inputs fail explicitly', (t) => {
  const f = fixture(t);
  assert.equal(f.call(['status', '00000000-0000-0000-0000-000000000000']).status, 1);
  assert.equal(f.call(['status', '../bad']).status, 1);
  assert.equal(f.call(['start', '--worker', 'kimi', '--sandbox', 'read-only', '--prompt-file', f.prompt]).status, 1);
  assert.equal(f.call(['start', '--worker', 'codex', '--timeout', 'NaN', '--prompt-file', f.prompt]).status, 1);
  assert.equal(f.call(['start', '--worker', 'codex', '--prompt-file', f.prompt, '--unknown', 'x']).status, 1);
});
