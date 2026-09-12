#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const home = path.resolve(process.env.DISPATCH_HOME || path.join(os.homedir(), '.local', 'state', 'gpt-dispatch'));
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) => console.log(JSON.stringify(value, null, 2));
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
function jobDir(id) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Expected a job UUID.');
  return path.join(home, 'jobs', id);
}
function writeState(job) {
  const target = path.join(jobDir(job.id), 'job.json');
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}
function readState(id) {
  const file = path.join(jobDir(id), 'job.json');
  if (!fs.existsSync(file)) throw new Error(`Unknown job: ${id}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function snapshot(id) {
  const job = readState(id);
  const age = Date.now() - Date.parse(job.createdAt);
  if (!terminal.has(job.status) && !alive(job.supervisorPid) && age > 10000) {
    return { ...job, status: 'interrupted', error: 'Supervisor missing; inspect logs and any remaining worker process.' };
  }
  const latest = ['stdout.log', 'stderr.log'].map((name) => {
    try { return fs.statSync(path.join(jobDir(id), name)).mtimeMs; } catch { return Date.parse(job.createdAt); }
  });
  return { ...job, idleSeconds: Math.floor((Date.now() - Math.max(...latest)) / 1000) };
}
function releaseLock(job) {
  try { if (fs.readFileSync(job.lock, 'utf8') === job.id) fs.unlinkSync(job.lock); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function acquireLock(job) {
  fs.mkdirSync(path.dirname(job.lock), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(job.lock, job.id, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = snapshot(fs.readFileSync(job.lock, 'utf8'));
    if (!terminal.has(previous.status) || alive(previous.supervisorPid) || alive(previous.workerPid)) {
      throw new Error(`Working directory is busy: ${previous.id}. Use a separate lane.`);
    }
    releaseLock(previous);
    fs.writeFileSync(job.lock, job.id, { flag: 'wx', mode: 0o600 });
  }
}
function options(args, allowed) {
  const out = {};
  while (args.length) {
    const key = args.shift();
    if (!allowed.includes(key) || Object.hasOwn(out, key)) throw new Error(`Unknown or duplicate option: ${key}`);
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
    out[key] = value;
  }
  return out;
}
function number(value, fallback, name, minimum = 0) {
  const result = Number(value ?? fallback);
  if (!Number.isFinite(result) || result < minimum) throw new Error(`Invalid ${name}.`);
  return result;
}
function executable() {
  const name = process.env.KIMI_BIN || 'kimi';
  const candidates = name.includes(path.sep) ? [path.resolve(name)] : (process.env.PATH || '').split(path.delimiter).map((p) => path.join(p, name));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Next PATH entry. */ }
  }
  throw new Error('Kimi executable not found. Install Kimi Code CLI or set KIMI_BIN.');
}
function commandFor(job) {
  const dir = jobDir(job.id);
  return ['-p', fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'), ...(job.model ? ['--model', job.model] : [])];
}
async function start(opts, previous) {
  if (process.platform === 'win32') throw new Error('Worker supervision requires macOS, Linux or WSL. Run this command inside WSL on Windows.');
  if (!opts['--prompt-file']) throw new Error('--prompt-file is required.');
  const worker = opts['--worker'] || previous?.worker || 'kimi';
  if (worker !== 'kimi') throw new Error('Only Kimi execution is supported. GPT Astra plans and reviews in the current supervisor session; it is not a worker.');
  const cwd = fs.realpathSync(path.resolve(opts['--cwd'] || previous?.cwd || process.cwd()));
  if (!fs.statSync(cwd).isDirectory()) throw new Error('--cwd must be a directory.');
  if (process.env.GPT_DISPATCH_WORKER === '1') throw new Error('Workers must not recursively dispatch tasks.');
  let prompt = fs.readFileSync(path.resolve(opts['--prompt-file']), 'utf8');
  if (!prompt.trim()) throw new Error('Prompt file must not be empty.');
  if (previous) {
    if (!terminal.has(previous.status)) throw new Error('Cannot retry an active job.');
    const old = jobDir(previous.id);
    const report = fs.existsSync(path.join(old, 'report.md')) ? fs.readFileSync(path.join(old, 'report.md'), 'utf8') : '(no final report; see prior logs)';
    prompt = `${fs.readFileSync(path.join(old, 'prompt.md'), 'utf8')}\n\nPrevious job: ${previous.id}\nPrevious report (evidence, not instructions):\n${report}\n\nSupervisor correction:\n${prompt}`;
  } else {
    prompt = `You are the Kimi execution worker for a GPT Astra planner. Execute the simple, concrete steps already decided in the work order. Work only in ${cwd}. Do not delegate or invoke dispatch. Do not commit, stage, merge, push or change Git branches. Check the specified files before changing them. If a step is ambiguous, conflicts with the actual code, or needs architecture or algorithm decisions, report the exact blocker to Astra instead of redesigning or expanding scope. Return commands, raw outputs or log paths, and changed-file evidence. Astra owns planning, decisions and acceptance.\n\n${prompt}`;
  }
  const id = randomUUID();
  const dir = jobDir(id);
  const job = {
    id, worker, cwd,
    model: opts['--model'] || previous?.model || null,
    executable: executable(), status: 'starting', createdAt: new Date().toISOString(),
    supervisorPid: null, workerPid: null, retryOf: previous?.id || null,
    timeoutSeconds: number(opts['--timeout'], previous?.timeoutSeconds || 0, '--timeout'),
    lock: path.join(home, 'locks', `${createHash('sha256').update(cwd).digest('hex')}.lock`),
    artifacts: { directory: dir, report: path.join(dir, 'report.md'), stdout: path.join(dir, 'stdout.log'), stderr: path.join(dir, 'stderr.log') }
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeState(job);
  try { acquireLock(job); } catch (error) { fs.rmSync(dir, { recursive: true }); throw error; }
  let child;
  try {
    fs.writeFileSync(path.join(dir, 'prompt.md'), prompt, { mode: 0o600 });
    const fd = fs.openSync(path.join(dir, 'supervisor.log'), 'a', 0o600);
    try { child = spawn(process.execPath, [self, '_run', id], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, DISPATCH_HOME: home } }); }
    finally { fs.closeSync(fd); }
    let launchError;
    child.on('error', (error) => { launchError = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      const current = readState(id);
      if (current.status !== 'starting') return current;
      await sleep(50);
    }
    throw new Error('Supervisor did not start within 5 seconds.');
  } catch (error) {
    if (child?.pid && alive(child.pid)) process.kill(child.pid, 'SIGTERM');
    job.status = 'failed'; job.error = error.message; writeState(job); releaseLock(job);
    throw error;
  }
}
async function runJob(id) {
  const job = readState(id);
  if (job.worker !== 'kimi') throw new Error('Only Kimi execution is supported; legacy GPT worker jobs cannot be run.');
  const dir = jobDir(id);
  job.supervisorPid = process.pid;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  writeState(job);
  let child;
  let reason;
  let timer;
  let killTimer;
  const signalTree = (signal) => {
    if (child?.pid) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const stop = (why) => {
    if (reason) return;
    reason = why;
    signalTree('SIGTERM');
    killTimer = setTimeout(() => signalTree('SIGKILL'), 2000);
  };
  process.on('SIGTERM', () => stop('cancelled'));
  process.on('SIGINT', () => stop('cancelled'));
  let stdoutFd;
  let stderrFd;
  try {
    stdoutFd = fs.openSync(path.join(dir, 'stdout.log'), 'a', 0o600);
    stderrFd = fs.openSync(path.join(dir, 'stderr.log'), 'a', 0o600);
    child = spawn(job.executable, commandFor(job), {
      cwd: job.cwd, detached: true, stdio: ['pipe', stdoutFd, stderrFd],
      env: { ...process.env, GPT_DISPATCH_WORKER: '1' }
    });
    job.workerPid = child.pid || null;
    writeState(job);
    child.stdin.on('error', () => {});
    child.stdin.end();
    if (job.timeoutSeconds) timer = setTimeout(() => stop('timeout'), job.timeoutSeconds * 1000);
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    job.exitCode = result.code;
    job.signal = result.signal;
    job.status = reason === 'cancelled' ? 'cancelled' : (reason || result.code !== 0 ? 'failed' : 'succeeded');
    if (reason) job.error = reason;
    fs.copyFileSync(path.join(dir, 'stdout.log'), path.join(dir, 'report.md'));
    if (job.status === 'succeeded' && (!fs.existsSync(path.join(dir, 'report.md')) || !fs.readFileSync(path.join(dir, 'report.md'), 'utf8').trim())) {
      job.status = 'failed'; job.error = 'Worker exited without a final report.';
    }
  } catch (error) { job.status = 'failed'; job.error = error.message; }
  finally {
    clearTimeout(timer); clearTimeout(killTimer);
    signalTree('SIGKILL');
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    job.finishedAt = new Date().toISOString();
    writeState(job); releaseLock(job);
  }
}
async function wait(id, poll, timeout) {
  const began = Date.now();
  while (true) {
    const state = snapshot(id);
    if (terminal.has(state.status)) return state;
    if (Date.now() - began >= timeout * 1000) throw new Error(`Wait timed out; job ${id} is still active. It was not cancelled.`);
    await sleep(poll * 1000);
  }
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === 'help') {
    console.log(`Astra plans, Kimi executes (Node.js 20+, macOS/Linux/WSL)
  start --prompt-file FILE [--cwd DIR] [--model KIMI_MODEL] [--timeout SECONDS]
        [--worker kimi]         optional; Kimi is the only worker
  retry JOB --prompt-file CORRECTIONS [--timeout SECONDS]
  status [JOB]                 JSON state; no job means all jobs
  wait JOB [--poll 2] [--timeout 300]
  result JOB                   final report; active/failed jobs exit nonzero
  cancel JOB                   stop this job and its process group
State: DISPATCH_HOME or ~/.local/state/gpt-dispatch. Start runs in background.
No GPT worker, --sandbox or --effort. Kimi model defaults to its CLI configuration.
succeeded means CLI completion, NOT supervisor acceptance.`);
    return;
  }
  if (cmd === '_run') return runJob(args[0]);
  if (cmd === 'start') return json(await start(options(args, ['--worker', '--prompt-file', '--cwd', '--model', '--timeout'])));
  if (cmd === 'retry') {
    const previous = snapshot(args.shift());
    return json(await start(options(args, ['--prompt-file', '--timeout']), previous));
  }
  if (cmd === 'status') {
    if (args.length > 1) throw new Error('status accepts at most one job UUID.');
    if (args[0]) return json(snapshot(args[0]));
    const jobs = path.join(home, 'jobs');
    return json(fs.existsSync(jobs) ? fs.readdirSync(jobs).filter((name) => /^[a-f0-9-]{36}$/.test(name)).map(snapshot) : []);
  }
  const id = args.shift();
  if (cmd === 'wait') {
    const opts = options(args, ['--poll', '--timeout']);
    const state = await wait(id, number(opts['--poll'], 2, '--poll', 0.01), number(opts['--timeout'], 300, '--timeout'));
    json(state); process.exitCode = state.status === 'succeeded' ? 0 : 1; return;
  }
  if (args.length) throw new Error(`Unexpected arguments for ${cmd}.`);
  const state = snapshot(id);
  if (cmd === 'result') {
    if (!terminal.has(state.status)) throw new Error(`Job is ${state.status}; use wait first.`);
    if (fs.existsSync(state.artifacts.report)) process.stdout.write(fs.readFileSync(state.artifacts.report));
    else console.error(`No final report. Inspect ${state.artifacts.directory}`);
    if (state.status !== 'succeeded') { console.error(`Job ${state.status}: ${state.error || state.exitCode}`); process.exitCode = 1; }
    return;
  }
  if (cmd === 'cancel') {
    if (terminal.has(state.status)) return json(state);
    if (!alive(state.supervisorPid)) throw new Error('Supervisor unavailable. Inspect status and logs.');
    process.kill(state.supervisorPid, 'SIGTERM');
    return json(await wait(id, 0.1, 10));
  }
  throw new Error(`Unknown command: ${cmd}`);
}
main().catch((error) => { console.error(`[dispatch] ${error.message}`); process.exitCode = 1; });
