import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installer bundles scripts with skill and preserves previous installation in backup', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-install-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'skills', 'dispatch');
  const env = { ...process.env, DISPATCH_HOME: path.join(temp, 'state') };
  const install = () => spawnSync(process.execPath, [path.join(root, 'install.mjs'), '--target', target], { env, encoding: 'utf8' });
  const one = install();
  assert.equal(one.status, 0, one.stderr);
  assert.ok(fs.existsSync(path.join(target, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(target, 'scripts', 'dispatch.mjs')));
  assert.ok(fs.existsSync(path.join(target, 'scripts', 'wait.mjs')));
  fs.writeFileSync(path.join(target, 'custom.txt'), 'preserve this');
  fs.writeFileSync(path.join(target, 'scripts', 'codex-wait.mjs'), '// legacy');
  const two = install();
  assert.equal(two.status, 0, two.stderr);
  const receipt = JSON.parse(two.stdout);
  assert.equal(fs.readFileSync(path.join(receipt.backup, 'custom.txt'), 'utf8'), 'preserve this');
  assert.equal(fs.existsSync(path.join(target, 'custom.txt')), false);
  assert.equal(fs.existsSync(path.join(target, 'scripts', 'codex-wait.mjs')), false);
  assert.ok(fs.existsSync(path.join(receipt.backup, 'scripts', 'codex-wait.mjs')));
  assert.equal(receipt.globalRulesChanged, false);
});

test('installer rejects replacing its own source', () => {
  const out = spawnSync(process.execPath, [path.join(root, 'install.mjs'), '--target', root], { encoding: 'utf8' });
  assert.notEqual(out.status, 0);
});
