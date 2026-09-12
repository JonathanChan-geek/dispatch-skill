---
name: dispatch
description: GPT/Codex 主控的多模型派单工作流。用于把边界明确的独立任务交给 Codex 或 Kimi CLI、管理并行 worktree、收取执行证据和验收 worker 产出。共享状态、连续决策及小改动由主控直接完成。
---

# Dispatch: GPT 主控，Codex / Kimi 施工

你是当前 GPT 主控，通常运行在 Codex App 或 Codex CLI 中；Codex worker 是另一段独立 CLI 进程，不是当前会话的别名。不依赖 Claude Code、其插件或常驻 broker。

用户当前指令和项目 canonical `AGENTS.md` 优先。只在存在独立工作流且委派能节省时间或提高质量时派单。先读代码，自己处理当前关键路径；不要把下一步立即依赖的工作派出去后空等。worker 的完成报告只是待验收材料。

## 分级和路由

| 档位 | 场景 | 做法 |
| --- | --- | --- |
| L0 直做 | 小修、共享状态、连续决策、紧急修复、前端/UI | 主控直接完成，做与风险相称的验证 |
| L1 轻派单 | 单域、边界明确的独立任务 | 干净主树 + 自包含工单 + 单 worker + 主控验收 |
| L2 隔离派单 | 多 worker 并行，或派出的任务涉及 schema/API/持久化/安全 | 先冻结验收 gates，再分配互不重叠的 worktree lane |

默认路由：后端/复杂逻辑/长程排障给 Codex；测试补写/文档同步/机械修改/读码报告给 Kimi；前端/UI 与浏览器验收由主控处理。跨端任务先冻结接口再拆单。项目 `AGENTS.md` 的“派单路由”可以覆盖这些默认值。

不强制具体 GPT 型号。主控沿用当前会话模型；worker 默认沿用各自 CLI 配置，仅按用户明确要求传 `--model`。Codex 的 `--effort high|xhigh` 仅在任务确需时设置。

## 工单

每单使用 [工单模板](references/work-order.md)，补全目标及原因、钉死项、允许修改路径、文件级改动、验收命令、PHASE 0 现实核对、原始证据交付格式。worker 不能假定看得到主会话。

工单和日志放在目标仓库外，避免污染 L1 的干净基线或触碰集。worker 禁止自行 stage/commit/merge/push、切换分支、越界重构及递归派单。遇到工单与代码冲突，先报告具体文件与影响，不自行扩大范围。

## 脚本位置

安装后的本 `SKILL.md` 同级有 `scripts/`。用本次实际加载的 skill 目录确定 `SKILL_DIR`，不要假定用户家目录或插件版本。默认安装位置是 `$HOME/.agents/skills/dispatch`；自定义安装位置以安装输出为准。仓库源码中的脚本位于仓库根 `scripts/`。

下列命令中的 `SCRIPTS` 表示脚本目录；`PROJECT` 和 `ORDER` 表示项目与工单的绝对路径。

```bash
node "$SCRIPTS/dispatch.mjs" start --worker codex --cwd "$PROJECT" \
  --prompt-file "$ORDER" --sandbox workspace-write
node "$SCRIPTS/dispatch.mjs" start --worker kimi --cwd "$PROJECT" \
  --prompt-file "$ORDER"
node "$SCRIPTS/dispatch.mjs" status "$JOB_ID"
node "$SCRIPTS/dispatch.mjs" wait "$JOB_ID" --poll 2 --timeout 300
node "$SCRIPTS/dispatch.mjs" result "$JOB_ID"
node "$SCRIPTS/dispatch.mjs" retry "$JOB_ID" --prompt-file "$CORRECTIONS"
node "$SCRIPTS/dispatch.mjs" cancel "$JOB_ID"
```

`start` 自动后台运行并返回 JSON job ID。同一实际工作目录只允许一个活动作业；并行使用不同 lane。`wait --timeout` 只结束等待，不取消作业；`start --timeout` 才是可选的执行总时限。无输出不等于卡死，结合 `status.idleSeconds`、原始日志与进程状态判断，再按需取消。

`retry` 为指定 job 创建新会话，带入原工单、先前报告与缺陷清单，沿用 worker、目录及模型配置。它不使用含混的 `--resume-last` 或 Kimi `-c`，也不恢复隐藏的完整会话。先前代码改动仍留在工作目录。返工超过两轮，重新核对拆单边界。

Codex 默认 `read-only`，写代码明确指定 `workspace-write`。Kimi 的 prompt 模式没有本脚本可提供的等效沙箱；工单范围与事后审计不能称作系统级权限隔离。`succeeded` 只代表 CLI 正常退出且有报告，不代表项目验收通过。

## L2 Worktree 与 Gates

1. 把精确验收命令及预期结果写进 `docs/gates/<slice>.md`，由主控提交。主树必须干净。
2. 在主仓库运行 `node "$SCRIPTS/lane.mjs" new <slice> <允许路径>...`。仅接受精确文件/目录，不支持 glob。脚本建立 `.lanes/<slice>` 和 `lane/<slice>` 分支，拒绝重叠范围。主控串行建好所有 lane，再并行启动 worker；不要并发调用 `new`。
3. 用 lane 的绝对路径作为 `--cwd` 派单。不同 worker 不得共享写入范围。
4. 完工后运行 `node "$SCRIPTS/lane.mjs" audit <slice>`：核对 HEAD 未移动、改动都在范围内、`docs/gates/` 未碰。
5. 主控读 diff、按 gates 验收；通过后在 lane 内提交，回主树合并并运行必要的集成验证。没有新改动/新失败/遗留疑点，不反复扩大测试。
6. `node "$SCRIPTS/lane.mjs" drop <slice>` 清理已合并 lane。弃单用 `drop <slice> --force` 会丢弃该 lane 的改动和未合并分支，执行前确认不再需要这些产出。

lane 是工作目录隔离和 Git 状态审计，不是权限沙箱，也不是不可篡改的审计系统。跨 lane 冲突首先检查拆单是否错误，不让 worker 自行改其他 lane 来解决。

## 验收

- L1 用 `git status` 对账，L2 用 `lane audit`。主控对着 spec 和实际 diff 判断意图是否实现。
- 验收证据保留命令、原始输出、改动路径；不要只引用 worker 的“测试通过”。
- 高风险 diff 如需独立复核，交给未参与实现的 worker，只读；不同会话不自动等于不同模型。
- 有必要检查关键断言时使用 `mutate.mjs`：目标文件先保持已提交且干净，脚本先运行绿色基线，再施加变异并恢复原始内容。未匹配或测试仍绿返回非零。基线失败不能被当成“成功杀死变异”。
- 所提交的代码应是已经验证的那份。主控拥有提交、合并和最终验收权；此 skill 不自行授权推送或发布。
