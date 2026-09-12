#!/usr/bin/env node
// Compatibility name; accepts new dispatch UUIDs for either worker.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [id, poll = '2', timeout = '300'] = process.argv.slice(2);
if (!id) {
  console.error('Usage: node codex-wait.mjs JOB [POLL_SECONDS] [TIMEOUT_SECONDS]');
  process.exit(2);
}
const runner = fileURLToPath(new URL('./dispatch.mjs', import.meta.url));
const waited = spawnSync(process.execPath, [runner, 'wait', id, '--poll', poll, '--timeout', timeout], { stdio: 'inherit' });
if (waited.status !== 0) process.exit(waited.status ?? 1);
const report = spawnSync(process.execPath, [runner, 'result', id], { stdio: 'inherit' });
process.exitCode = report.status ?? 1;
