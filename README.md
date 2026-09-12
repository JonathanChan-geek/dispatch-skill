# dispatch-skill

**GPT Astra 负责规划与验收，Kimi Code 负责快速执行简单、明确的任务。** 没有 GPT 派单给 GPT，也没有按前端/后端划分模型的路由。

Astra 在当前主控会话中思考和决策，通常使用 **Codex App / Codex CLI** 作为工具环境。脚本只启动 Kimi，不启动额外的 GPT/Codex 进程，也不自动切换主控模型或修改其配置。

```text
用户目标 → Astra 分析、定方案、拆步骤 → Kimi 执行 → Astra 验收
                    ↑                               ↓
                    └────────── 决策与纠偏 ──────────┘
```

## 快速开始

需要 **Node.js >= 20、Git**，以及已安装并登录的 **Kimi Code CLI**。主控使用 Astra 会话并具备本地命令执行能力。无需 npm 依赖，无需在本仓库填 API key。后台运行器支持 macOS、Linux、WSL；Windows 用户在 WSL 内安装和运行 CLI。

```bash
git clone https://github.com/JonathanChan-geek/dispatch-skill.git
cd dispatch-skill
node install.mjs
```

安装到 `~/.agents/skills/dispatch/`，skill 与脚本一起部署。已有安装先备份到 `~/.local/state/gpt-dispatch/install-backups/`。安装器不修改全局 `AGENTS.md`、模型/认证配置或旧 `.claude` 文件。自定义位置使用 `node install.mjs --target /absolute/path/to/dispatch`。

在主控环境选择 Astra，并在新会话中使用：

> 使用 $dispatch。你负责规划和验收，把任务拆成 Kimi 能直接执行的小步骤。Kimi 遇到不确定性先反馈给你决策，不要再派单给另一个 GPT。

改工作流：**修改本仓库 → 验证 → 重新执行 `node install.mjs`**。不要只改安装副本。

## 谁负责什么

| 角色 | 职责 |
| --- | --- |
| GPT Astra | 理解目标、分析问题、确定架构/接口、拆步骤、判断阻塞原因、验收与纠偏 |
| Kimi Code | 按已经定好的具体步骤改文件、同步文档、实现小逻辑、搬运数据、运行验证 |

这里对 Kimi 的定位是**快、做简单明确的具体执行**，不是复杂方案设计者。简单任务直接给 Kimi；复杂任务由 Astra 先想清楚，再拆成小步骤。如果还需要执行者选择架构或发明接口，说明 Astra 还没有拆完。

默认一个简单工单即可，不为了派单增加流程。只有真正独立且并行有收益的任务，才启动多个 Kimi 进程并使用互不重叠的 worktree；共享状态与连续决策由 Astra 串行推进。需要冻结契约或隔离修改时才启用 gates。遇到歧义，Kimi 把具体阻塞点交回 Astra。

## 手动派单

先把 [工单模板](skills/dispatch/references/work-order.md) 补全到**项目外**的 UTF-8 文件。下面设置三个绝对路径：

```bash
SCRIPTS="$HOME/.agents/skills/dispatch/scripts"
PROJECT="/absolute/path/to/your-project"
ORDER="/absolute/path/outside-project/order.md"

# 默认且只能启动 Kimi；同一目录上一单结束后才能再派
node "$SCRIPTS/dispatch.mjs" start --cwd "$PROJECT" \
  --prompt-file "$ORDER"
```

`start` 立即转后台，输出 JSON，其中 `id` 是后续命令使用的 job UUID：

```bash
JOB_ID="上一步返回的 UUID"
node "$SCRIPTS/dispatch.mjs" status "$JOB_ID"
node "$SCRIPTS/dispatch.mjs" wait "$JOB_ID" --poll 2 --timeout 300
node "$SCRIPTS/dispatch.mjs" result "$JOB_ID"
node "$SCRIPTS/dispatch.mjs" retry "$JOB_ID" --prompt-file /absolute/path/corrections.md
node "$SCRIPTS/dispatch.mjs" cancel "$JOB_ID"
```

- `status` 不带 ID 时列出所有作业。成功、失败、取消、监工进程中断分别报告；未知 ID 报错，不冒充已完成。
- `wait --timeout 300` 只等 300 秒，不会取消后台作业。需要执行总时限，在 `start` 指定 `--timeout 900`；默认不强制终止。
- `cancel` 停止该任务的 worker 进程组；CLI 正常结束后也清理其遗留子进程，不操作其他作业。
- `retry` 以**指定 Kimi job ID**为依据，新建会话并带入原工单、上次报告和 Astra 的具体修正步骤；不是完整会话续接。保留工作目录已有改动，沿用 Kimi 模型配置，不猜测“最近一次会话”。
- `succeeded` 仅代表 CLI 退出码为 0 且存在非空报告；**不代表主控验收通过**。`wait`/`result` 对失败作业返回非零。
- 执行器只有 Kimi，显式 `--worker kimi` 仍可用，`--worker codex` 会拒绝。没有 `--sandbox`/`--effort` 参数，也不会自动加 `--auto`/`-y`；工单约束不能当作系统级权限隔离。

Kimi 默认沿用其 CLI 中配置的模型。只有用户明确指定执行模型时才传 `--model NAME`，它不选择或切换主控 Astra。

## 按需隔离与验收

只有确需隔离或并行的任务才走此流程。由 Astra 先定好每单的具体步骤，在目标项目根目录写好并提交 `docs/gates/<slice>.md`，每条验收包含精确命令和预期结果：

```bash
cd "$PROJECT"
node "$SCRIPTS/lane.mjs" new backend src/server tests/server
node "$SCRIPTS/lane.mjs" new docs docs/guide

# 两单的 cwd 分别为 "$PROJECT/.lanes/backend" 和 "$PROJECT/.lanes/docs"
# 使用上面的 start 命令，传入各自完整工单

node "$SCRIPTS/lane.mjs" audit backend
node "$SCRIPTS/lane.mjs" audit docs
node "$SCRIPTS/lane.mjs" list
```

脚本要求主树干净，写入 manifest，拒绝触碰集重叠与保护路径，审计 HEAD/越界修改/gates。路径只支持精确文件或目录，不支持 glob。重命名前后路径都纳入审计。主控先串行创建所有 lane，再并行启动 worker；`lane new` 没有跨进程创建锁。

验收通过后，由主控在各 lane 中提交，回主树合并，并运行必要的集成验证，再执行 `lane.mjs drop <slice>`。默认拒绝丢弃脏改动（包括 ignored 文件）或未合并提交；已合并按主工作树当前 HEAD 的祖先关系判断。明确弃单才用 `drop <slice> --force`。

lane 是工作目录隔离与事后审计，**不是权限沙箱或不可篡改的审计系统**。多个 lane 可以并行，同一实际目录的 runner 作业互斥，不会自动排队。

## 关键断言变异检查

仅在关键性质需要额外验证时使用，不为小型可逆修改强制添加测试：

```bash
node "$SCRIPTS/mutate.mjs" src/check.js 'a && b' 'a' --cmd 'npm test'
node "$SCRIPTS/mutate.mjs" --spec /absolute/path/mutations.json
```

目标文件必须已跟踪且没有未提交改动。脚本先运行基线，绿色后才施加变异，结束时恢复原始内容。未匹配、变异存活或基线失败都会返回非零，不使用 `git checkout --` 恢复文件。仅凭测试命令非零不能解释具体失败原因，主控仍需读输出。

## 文件地图

```text
skills/dispatch/SKILL.md                Astra 规划、Kimi 执行的工作流
skills/dispatch/references/work-order.md Astra 给 Kimi 的具体执行单
scripts/dispatch.mjs                    Kimi 后台执行、JSON 台账、等待、返工、取消
scripts/wait.mjs                        等待任务并打印报告供 Astra 验收
scripts/lane.mjs                        worktree 创建、范围审计和清理
scripts/mutate.mjs                      基线检查、变异测试和恢复
global/AGENTS.md.section.md             可选的全局规则片段，不自动合并
install.mjs / install.ps1               安装、备份；PowerShell 是 Node 安装入口
tests/                                 临时 Git 仓库及 mock CLI 集成测试
```

任务台账默认在 `~/.local/state/gpt-dispatch/jobs/<id>/`，包含 `job.json`、`prompt.md`、`stdout.log`、`stderr.log`、`report.md` 和 `supervisor.log`。这些文件不进入项目 Git；可能包含工单和模型输出，发布仓库时无需打包它们。

`DISPATCH_HOME` 可覆盖状态根目录，派单与查状态必须使用相同值。`KIMI_BIN` 可指定 Kimi 可执行文件绝对路径，不接受带参数的 shell 命令。状态中的 `idleSeconds` 仅用于观察，长时间没有输出不会自动触发取消。

## 从旧版迁移

1. v3 只保留两个角色：当前 GPT Astra 规划与验收，Kimi 执行具体步骤。删除原来的 Codex worker 路由和默认跨模型评审。
2. `start --worker kimi` 可简写成 `start`；Codex worker 参数、`CODEX_BIN`、`--sandbox` 和 `--effort` 已移除，不会静默改派。
3. 等待脚本从 `codex-wait.mjs` 改名为 `wait.mjs`。重新执行安装器会更新整个安装目录并备份旧版。
4. 旧台账仍可查询与读取报告，历史 Codex job 不允许重新执行或 `retry`；Kimi 的返工必须指定 job ID。
5. 不需要 Claude Code 插件或相关环境变量，不自动修改旧 `.claude` 文件和任何模型/认证配置。原版本保留在 Git 历史中。

## 验证与依据

```bash
npm run check
npm test
```

测试使用临时 Git 仓库和 mock CLI，不消耗模型额度。覆盖 Kimi 默认执行、拒绝 GPT 派单、旧任务迁移、原始参数传递、失败/取消/超时、目录互斥、返工、lane 审计与清理、变异结果和安装备份。真实模型可用性仍取决于本机 Kimi CLI 登录与配置。

Kimi CLI 接口以本机 `kimi --help` 为准，参考 [Kimi Code 文档](https://moonshotai.github.io/kimi-code/)。原工作流的工单和 gates 思路来源记录保留在仓库初始提交中。
