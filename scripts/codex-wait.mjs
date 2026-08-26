#!/usr/bin/env node
/**
 * 等 codex 任务到终态,然后打印交付报告。
 *
 * 为什么不用 grep 解析 `status --all` 的文本:那是给人看的排版——完成的任务会从
 * 「Active jobs」表格挪到「Latest finished」列表,行首从 | 变成 -,列序也不一样。
 * 按排版写的过滤器必然在某次格式变动时静默失灵(而失灵的表现是"永远等不到",
 * 看起来跟"任务卡住"一模一样)。真源是 --json 的 running[] 数组。
 *
 * 用法: node codex-wait.mjs <job-id> [pollSeconds]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const run = promisify(execFile);
const COMPANION =
  "C:\\Users\\nigo\\.claude\\plugins\\cache\\openai-codex\\codex\\1.0.6\\scripts\\codex-companion.mjs";

/**
 * 2026-08-15 根因修复：任务台账目录由 CLAUDE_PLUGIN_DATA 决定
 * （state.mjs: stateRoot = $CLAUDE_PLUGIN_DATA/state，缺失时落 os.tmpdir()/codex-companion）。
 * Claude Code 只给部分工具 shell 注入该变量（实测 Bash 有、PowerShell 无），
 * 于是"派单的 shell"与"查状态的 shell"各看一套台账——status 空、result 报
 * No job found，表现酷似"任务丢了"，实际任务好好在跑。这里兜底补齐，
 * 让本脚本在任何 shell 里都读同一套真台账。
 */
const PLUGIN_DATA_DEFAULT = "C:\\Users\\nigo\\.claude\\plugins\\data\\codex-inline";
if (!process.env.CLAUDE_PLUGIN_DATA && existsSync(PLUGIN_DATA_DEFAULT)) {
  process.env.CLAUDE_PLUGIN_DATA = PLUGIN_DATA_DEFAULT;
}

const jobId = process.argv[2];
const pollMs = Number(process.argv[3] ?? 20) * 1000;
if (!jobId) {
  console.error("用法: node codex-wait.mjs <job-id> [pollSeconds]");
  process.exit(2);
}

const call = async (args) => {
  const { stdout } = await run(process.execPath, [COMPANION, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastPhase = "";
while (true) {
  let state;
  try {
    state = JSON.parse(await call(["status", "--all", "--json"]));
  } catch (error) {
    // 单次查询失败不该杀掉整个等待
    console.error(`status 查询失败,继续等: ${error.message}`);
    await sleep(pollMs);
    continue;
  }

  const job = (state.running ?? []).find((row) => row.id === jobId);
  if (!job) break;
  if (job.phase && job.phase !== lastPhase) {
    lastPhase = job.phase;
    console.error(`[phase] ${job.phase}`);
  }
  await sleep(pollMs);
}

console.log(`JOB_TERMINAL ${jobId}`);
try {
  console.log(await call(["result", jobId]));
} catch (error) {
  // 失败/取消的任务没有交付报告,打状态兜底
  console.log(`result 取不到(任务可能失败/被取消): ${error.message}`);
  console.log(await call(["status", jobId]));
}
