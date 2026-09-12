# dispatch-skill

**GPT/Codex 主控，Codex + Kimi 施工。** 保留原派单工作流的分级、工单、worktree 和验收机制，移除 Claude Code 插件、硬编码用户目录、固定模型和插件补丁依赖。

GPT 指当前使用的主控模型，通常运行在 **Codex App / Codex CLI**。Codex worker 是单独启动的 `codex exec` 进程；普通 ChatGPT 网页没有本地 CLI 时，不能直接运行这些脚本。

## 快速开始

需要 **Node.js >= 20、Git**，以及已安装并登录的 **Codex CLI / Kimi CLI**（只用哪家就装哪家）。无需 npm 依赖，无需在本仓库填 API key。后台运行器支持 macOS、Linux、WSL；Windows 用户在 WSL 内安装和运行 CLI。

```bash
gh repo clone JonathanChan-geek/dispatch-skill
cd dispatch-skill
node install.mjs
```

安装到 `~/.agents/skills/dispatch/`，skill 与脚本一起部署。已有安装先备份到 `~/.local/state/gpt-dispatch/install-backups/`。安装器不修改全局 `AGENTS.md`、模型/认证配置或旧 `.claude` 文件。自定义位置使用 `node install.mjs --target /absolute/path/to/dispatch`。

在新的 Codex 会话中使用：

> 使用 $dispatch。先读项目 AGENTS.md 和代码，由当前 GPT 拆单：独立后端任务给 Codex，文档/机械任务给 Kimi，前端自己处理；最后核对 diff、运行必要验证并验收。

改工作流：**修改本仓库 → 验证 → 重新执行 `node install.mjs`**。不要只改安装副本。

## 谁负责什么

| 角色 | 职责 |
| --- | --- |
| GPT 主控 | 架构、拆单、接口冻结、监工、验收、提交合并；前端/UI 与连续决策 |
| Codex worker | 后端、复杂逻辑、长程排障、大重构 |
| Kimi worker | 测试补写、文档同步、机械修改、读码报告 |
| 独立复核 | 按需由未参与实现的 worker 只读检查高风险 diff |

L0：小修或紧密耦合工作直接做。L1：独立单域任务在干净主树派单。L2：并行或高风险派单先冻结 gates，再建互不重叠的 lane。项目 `AGENTS.md` 可覆盖默认路由。主控和 worker 均不强制具体模型，worker 默认读取自己的 CLI 配置。

## 手动派单

先把 [工单模板](skills/dispatch/references/work-order.md) 补全到**项目外**的 UTF-8 文件。下面设置三个绝对路径：

```bash
SCRIPTS="$HOME/.agents/skills/dispatch/scripts"
PROJECT="/absolute/path/to/your-project"
ORDER="/absolute/path/outside-project/order.md"

# Codex 写任务；只读任务省略 --sandbox 或指定 read-only
node "$SCRIPTS/dispatch.mjs" start --worker codex --cwd "$PROJECT" \
  --prompt-file "$ORDER" --sandbox workspace-write

# Kimi 任务；同一目录上一单结束后才能再派
node "$SCRIPTS/dispatch.mjs" start --worker kimi --cwd "$PROJECT" \
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
- `retry` 以**指定 job ID**为依据，新建会话并带入原工单、上次报告和缺陷清单；不是完整会话续接。保留工作目录已有改动，沿用 worker、模型和权限参数，不猜测“最近一次会话”。
- `succeeded` 仅代表 CLI 退出码为 0 且存在非空报告；**不代表主控验收通过**。`wait`/`result` 对失败作业返回非零。
- Codex 默认只读，写任务显式设置 `workspace-write`；Kimi 不支持这里的 `--sandbox`/`--effort`，也不会自动加 `--auto`/`-y`。

可选：Codex 设置 `--effort high` 或 `--effort xhigh`；两家均可按用户明确选择设置 `--model NAME`。不传模型就沿用各 CLI 配置。

## L2 并行与验收

在目标项目根目录操作，先写好并提交 `docs/gates/<slice>.md`，每条验收包含精确命令和预期结果：

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
skills/dispatch/SKILL.md                GPT 主控流程
skills/dispatch/references/work-order.md 自包含工单模板
scripts/dispatch.mjs                    CLI 后台派单、JSON 台账、等待、返工、取消
scripts/codex-wait.mjs                  等待并打印报告的兼容入口
scripts/lane.mjs                        worktree 创建、范围审计和清理
scripts/mutate.mjs                      基线检查、变异测试和恢复
global/AGENTS.md.section.md             可选的全局规则片段，不自动合并
install.mjs / install.ps1               安装、备份；PowerShell 是 Node 安装入口
tests/                                 临时 Git 仓库及 mock CLI 集成测试
```

任务台账默认在 `~/.local/state/gpt-dispatch/jobs/<id>/`，包含 `job.json`、`prompt.md`、`stdout.log`、`stderr.log`、`report.md` 和 `supervisor.log`。这些文件不进入项目 Git；可能包含工单和模型输出，发布仓库时无需打包它们。

`DISPATCH_HOME` 可覆盖状态根目录，派单与查状态必须使用相同值。`CODEX_BIN` / `KIMI_BIN` 可指定可执行文件绝对路径，不接受带参数的 shell 命令。状态中的 `idleSeconds` 仅用于观察，长时间没有输出不会自动触发取消。

## 从 Claude Code 版迁移

1. 主控由 Claude 改为当前 GPT/Codex，规则来源改为 canonical `AGENTS.md`。
2. `codex-companion task/status/result` 改为本仓库 `dispatch.mjs`，不再需要插件路径、`CLAUDE_PLUGIN_DATA` 或 sandbox 补丁。
3. `--resume-last` / Kimi `-c` 改为 `retry <明确的 job ID>`；老插件的 job ID 不导入新台账。
4. `codex-wait.mjs` 名称保留，但只接受新版 dispatch UUID，Codex/Kimi 都能等。
5. 重新安装即可更新 skill 和脚本，旧 `.claude` 文件保留不动；原版可从 Git 历史查看。

## 验证与依据

```bash
npm run check
npm test
```

测试使用临时 Git 仓库和 mock CLI，不消耗模型额度。覆盖后台状态、原始参数传递、失败/取消/超时、目录互斥、返工、lane 审计与清理、变异结果和安装备份。真实模型可用性仍取决于本机 CLI 登录与配置。

CLI 接口以本机 `codex exec --help`、`kimi --help` 为准，参考 [Codex 非交互模式](https://developers.openai.com/codex/noninteractive) 和 [Kimi Code 文档](https://moonshotai.github.io/kimi-code/)。原工作流的工单和 gates 思路来源记录保留在仓库初始提交中。
