#!/usr/bin/env node
/**
 * 变异测试跑手。**唯一存在理由:强制「先提交再变异」。**
 *
 * 血泪史(2026-07-29 一天之内三次):变异用 `git checkout -- <file>` 还原,
 * 而目标文件的改动尚未提交 → 还原 = 把功能代码一起抹掉。
 * 三次的表现各不相同,但都极具迷惑性:
 *   ① 抹掉派生链监听器 → e2e 稳定失败 → 我诊断成 flaky,又编出一套竞态理论;
 *   ② 抹掉 at-most-once 函数 → 提交了一个 typecheck 都过不了的 commit;
 * **自毁的现场会伪装成 bug,而且比真 bug 更自洽。**
 *
 * 所以这个脚本在动手前硬性检查工作树,脏就拒跑。这不是提醒,是闸门。
 *
 * 用法:
 *   node mutate.mjs <file> <before> <after> [--cmd "pnpm test"]
 *   node mutate.mjs --spec mutations.json     # 批量,见文件末尾格式
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

function assertCleanTree(files) {
  const dirty = git(["status", "--porcelain", "--", ...files]).trim();
  if (dirty) {
    console.error("拒绝跑变异:目标文件有未提交改动\n" + dirty);
    console.error("\n先提交再变异——还原会把这些改动一起抹掉。");
    process.exit(2);
  }
}

/**
 * 行尾自适应。Windows 仓库常是 CRLF,而工单/规格里的片段几乎总是 LF——
 * 直接比对会静默不匹配,表现成「目标片段不存在」,浪费一轮排查。
 */
function matchWithEol(source, snippet) {
  if (source.includes(snippet)) return snippet;
  const crlf = snippet.replace(/\r?\n/g, "\r\n");
  if (source.includes(crlf)) return crlf;
  const lf = snippet.replace(/\r\n/g, "\n");
  return source.includes(lf) ? lf : null;
}

function runOne({ name, file, before, after, cmd }) {
  console.log(`\n########## ${name ?? file} ##########`);
  const original = readFileSync(file, "utf8");
  const matched = matchWithEol(original, before);
  if (matched === null) {
    console.error("MUTATION_NOT_APPLIED: 目标片段不存在(检查是否已被改动)");
    return { name, applied: false };
  }
  // after 的行尾跟随实际匹配到的形态,免得把 CRLF 文件写成混合行尾
  const replacement = matched.includes("\r\n")
    ? after.replace(/\r?\n/g, "\r\n")
    : after.replace(/\r\n/g, "\n");
  writeFileSync(file, original.replace(matched, replacement));
  console.log("mutation applied OK");

  let output = "";
  let failed = false;
  try {
    output = execFileSync(cmd, { shell: true, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  } finally {
    // 还原走 checkout 是安全的——上面已确认该文件没有未提交改动
    git(["checkout", "--", file]);
  }

  const summary = output
    .split(/\r?\n/)
    .filter((line) => /Test Files|Tests |failed|passed/.test(line))
    .slice(0, 4)
    .join("\n");
  console.log(summary || "(无测试摘要)");
  console.log(failed ? "结果: 变红 ✓(断言有牙)" : "结果: 全绿 ✗(断言没抓住,这条性质裸奔)");
  return { name, applied: true, red: failed };
}

const argv = process.argv.slice(2);
let specs;
if (argv[0] === "--spec") {
  specs = JSON.parse(readFileSync(argv[1], "utf8"));
} else {
  const cmdIndex = argv.indexOf("--cmd");
  specs = [
    {
      file: argv[0],
      before: argv[1],
      after: argv[2],
      cmd: cmdIndex > 0 ? argv[cmdIndex + 1] : "pnpm test",
    },
  ];
}
for (const spec of specs) spec.cmd ??= "pnpm test";

assertCleanTree([...new Set(specs.map((s) => s.file))]);

const results = specs.map(runOne);
console.log("\n########## 汇总 ##########");
for (const r of results) {
  console.log(`${r.applied ? (r.red ? "红 ✓" : "绿 ✗ 需补测试") : "未应用 ✗"}  ${r.name ?? ""}`);
}
console.log("还原确认:", git(["status", "--porcelain"]).trim() || "(工作树干净)");

/* mutations.json 格式:
[{ "name": "总闸失效", "file": "src/a.ts", "before": "x && y", "after": "x", "cmd": "pnpm test" }]
*/
