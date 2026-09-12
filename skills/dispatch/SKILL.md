---
name: dispatch
description: GPT Astra 规划与验收，Kimi Code 快速执行简单明确的任务。用于先把复杂目标拆成具体步骤，再交给 Kimi 执行、收取证据并由 Astra 纠偏；不派单给另一个 GPT/Codex。
---

# Dispatch: Astra 规划，Kimi 执行

主控是当前会话中的 GPT Astra，负责理解目标、分析、方案设计、拆解步骤、关键决策与验收。Codex App/CLI 是主控所在的工具环境，不是第二个施工角色。Kimi Code 是唯一执行者，定位是快，执行已经想清楚的简单具体任务。

用户当前指令和项目 canonical `AGENTS.md` 优先。不要新建 GPT/Codex worker，不以“交给更强的 GPT”替代主控规划，也不默认安排跨模型评审。Kimi 的完成报告只是待验收材料。

## 决策与执行

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| GPT Astra | 定方案、定接口、拆步骤、判断阻塞原因、审查 diff、验收与纠偏 | 再启动一份 GPT 来规划或施工 |
| Kimi Code | 按明确步骤修改指定文件、搬运数据、同步文档、实现已定小逻辑、执行指定验证 | 自行决定架构、发明接口、接下未拆解的复杂问题 |

不按前端/后端给不同模型分地盘，按“需要判断”还是“已明确的执行”分工。简单任务直接给 Kimi；复杂任务由 Astra 先想清楚，再拆成 Kimi 能执行的小步骤。工单仍需要 Kimi 做复杂设计，说明拆单尚未完成。缺少信息时，先给 Kimi 一个小范围只读取证任务，Astra 根据返回证据继续决策。

单任务优先轻量执行：明确步骤 + 文件边界 + 验收标准，不为简单改动额外开 lane。只有多个任务真正独立、并行有收益时才给多个 Kimi 进程分配互不重叠的 lane；共享状态和连续决策由 Astra 串行推进。需要隔离或冻结契约时再使用下面的 gates 流程。

在主控会话中选择 Astra；skill/脚本不会自动切换当前模型或修改全局模型配置。Kimi 默认沿用自己的 CLI 配置，仅按用户明确要求传 `--model`；不把 Astra 的模型名传给执行器。

## 工单

每单使用 [工单模板](references/work-order.md)，给出 Astra 已确定的方案、按顺序的具体步骤、明确文件边界和完成标准。Kimi 不依赖主会话上下文。只读取证单也必须限定要查的文件、问题和返回格式。

工单和日志放在目标仓库外，避免污染干净基线或触碰集。Kimi 禁止自行 stage/commit/merge/push、切换分支、越界重构及递归派单。遇到歧义、工单与代码冲突或需要新设计，报告具体文件与阻塞原因，交回 Astra 判断，不自行扩大范围。

## 脚本位置

安装后的本 `SKILL.md` 同级有 `scripts/`。用本次实际加载的 skill 目录确定 `SKILL_DIR`，不要假定用户家目录或插件版本。默认安装位置是 `$HOME/.agents/skills/dispatch`；自定义安装位置以安装输出为准。仓库源码中的脚本位于仓库根 `scripts/`。

下列命令中的 `SCRIPTS` 表示脚本目录；`PROJECT` 和 `ORDER` 表示项目与工单的绝对路径。

```bash
node "$SCRIPTS/dispatch.mjs" start --cwd "$PROJECT" \
  --prompt-file "$ORDER"
node "$SCRIPTS/dispatch.mjs" status "$JOB_ID"
node "$SCRIPTS/dispatch.mjs" wait "$JOB_ID" --poll 2 --timeout 300
node "$SCRIPTS/dispatch.mjs" result "$JOB_ID"
node "$SCRIPTS/dispatch.mjs" retry "$JOB_ID" --prompt-file "$CORRECTIONS"
node "$SCRIPTS/dispatch.mjs" cancel "$JOB_ID"
```

`start` 自动后台运行并返回 JSON job ID。同一实际工作目录只允许一个活动作业；并行使用不同 lane。`wait --timeout` 只结束等待，不取消作业；`start --timeout` 才是可选的执行总时限。无输出不等于卡死，结合 `status.idleSeconds`、原始日志与进程状态判断，再按需取消。

`start` 默认且只能启动 Kimi。保留显式 `--worker kimi` 写法，传 `--worker codex` 会直接拒绝。`retry` 为指定 Kimi job 创建新会话，带入原工单、先前报告与 Astra 的具体修正步骤，沿用目录及 Kimi 模型配置。它不使用含混的“最近会话”，也不恢复隐藏的完整会话。先前代码改动仍留在工作目录。返工超过两轮，Astra 重新分析并拆单，不盲目追加“再试试”。

脚本不提供 `--sandbox`/`--effort`。Kimi 的工单范围与事后审计不是系统级权限隔离。`succeeded` 只代表 CLI 正常退出且有报告，不代表 Astra 验收通过。

## 按需隔离与 Gates

1. 把精确验收命令及预期结果写进 `docs/gates/<slice>.md`，由主控提交。主树必须干净。
2. 在主仓库运行 `node "$SCRIPTS/lane.mjs" new <slice> <允许路径>...`。仅接受精确文件/目录，不支持 glob。脚本建立 `.lanes/<slice>` 和 `lane/<slice>` 分支，拒绝重叠范围。主控串行建好所有 lane，再并行启动 worker；不要并发调用 `new`。
3. 用 lane 的绝对路径作为 `--cwd` 派单。不同 worker 不得共享写入范围。
4. 完工后运行 `node "$SCRIPTS/lane.mjs" audit <slice>`：核对 HEAD 未移动、改动都在范围内、`docs/gates/` 未碰。
5. 主控读 diff、按 gates 验收；通过后在 lane 内提交，回主树合并并运行必要的集成验证。没有新改动/新失败/遗留疑点，不反复扩大测试。
6. `node "$SCRIPTS/lane.mjs" drop <slice>` 清理已合并 lane。弃单用 `drop <slice> --force` 会丢弃该 lane 的改动和未合并分支，执行前确认不再需要这些产出。

lane 是工作目录隔离和 Git 状态审计，不是权限沙箱，也不是不可篡改的审计系统。跨 lane 冲突首先检查拆单是否错误，不让 worker 自行改其他 lane 来解决。

## 验收

- 直接执行用 `git status` 对账，隔离执行用 `lane audit`。Astra 对着已定方案和实际 diff 判断意图是否实现。
- 验收证据保留命令、原始输出、改动路径；不要只引用 worker 的“测试通过”。
- 关键逻辑、跨端契约及高风险 diff 由 Astra 亲自复核；需要补证据时给 Kimi 发具体的只读检查单，不再额外启动 GPT 评审者。
- 有必要检查关键断言时使用 `mutate.mjs`：目标文件先保持已提交且干净，脚本先运行绿色基线，再施加变异并恢复原始内容。未匹配或测试仍绿返回非零。基线失败不能被当成“成功杀死变异”。
- 所提交的代码应是已经验证的那份。主控拥有提交、合并和最终验收权；此 skill 不自行授权推送或发布。
