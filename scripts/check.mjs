#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const dir of ['scripts', 'tests']) {
  if (fs.existsSync(path.join(root, dir))) for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.mjs')) files.push(path.join(root, dir, f));
}
files.push(path.join(root, 'install.mjs'));
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (check.status !== 0) process.exit(check.status || 1);
}
console.log(`Syntax OK: ${files.length} modules`);
