#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node install.mjs [--target /absolute/skill/directory]\nDefault: ~/.agents/skills/dispatch. Existing installation is backed up, never merged.');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--target')) throw new Error('Expected --target DIR or no arguments.');
const target = path.resolve(args[1] || path.join(os.homedir(), '.agents', 'skills', 'dispatch'));
if (target === repo || repo.startsWith(target + path.sep) || target.startsWith(repo + path.sep)) throw new Error('Install outside the source repository.');
if (target === path.parse(target).root || target === os.homedir()) throw new Error('Choose a dedicated skill directory.');
fs.mkdirSync(path.dirname(target), { recursive: true });
const stage = fs.mkdtempSync(path.join(path.dirname(target), '.dispatch-install-'));
let backup;
try {
  fs.cpSync(path.join(repo, 'skills', 'dispatch'), stage, { recursive: true });
  fs.cpSync(path.join(repo, 'scripts'), path.join(stage, 'scripts'), { recursive: true });
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    const backupRoot = path.join(process.env.DISPATCH_HOME || path.join(os.homedir(), '.local', 'state', 'gpt-dispatch'), 'install-backups');
    fs.mkdirSync(backupRoot, { recursive: true });
    backup = path.join(backupRoot, `dispatch-${Date.now()}-${process.pid}`);
    fs.cpSync(target, backup, { recursive: true, dereference: true });
    fs.rmSync(target, { recursive: true });
  }
  fs.renameSync(stage, target);
} catch (error) {
  if (backup && !fs.existsSync(target)) fs.cpSync(backup, target, { recursive: true });
  throw error;
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
console.log(JSON.stringify({ installed: target, backup: backup || null, globalRulesChanged: false }, null, 2));
