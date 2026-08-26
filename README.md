# dispatch-skill

Claude Code 多模型派单工作流:**Claude 当架构师/监工/验收官 + 前端亲写,Codex 干后端/复杂逻辑,Kimi 干杂事/机械活**。自适应分级,强制力靠脚本闸门而非文字纪律。

## 三层架构

| 层 | 文件 | 职责 |
|----|------|------|
| 指针层 | `global/CLAUDE.md.section.md` → 全局 `~/.claude/CLAUDE.md` | 5 行常驻:默认模式声明 + 「派活先加载 dispatch skill」+ 两条对 Claude 自己也生效的纪律(mutate 闸门、提交前绿条) |
| 知识层 | `skills/dispatch/SKILL.md` → `~/.claude/skills/dispatch/` | 按需加载:自适应三档(L0 直做 / L1 轻派单 / L2 gates+lane)、路由表、工单模板(PHASE 0 强制异议 + 只准原始证据)、Codex/Kimi 派单机制、卡死判定、验收清单 |
| 强制力层 | `scripts/*.mjs` → `~/.claude/` | `lane.mjs`(worktree lane + 触碰集/禁 commit/gates 保护对账)、`codex-wait.mjs`(读 JSON 真源等终态)、`mutate.mjs`(先提交再变异的硬闸门) |

设计依据:纪律细节塞 CLAUDE.md 是每会话的常驻上下文税;skill 按需加载。而「worker 不越界/不 commit/不碰验收门」这类约束只能靠脚本对账兜底——自然语言规矩在实践中已三次证明无效,只有闸门有用。

## 安装

```powershell
git clone <this-repo> ; cd dispatch-skill ; .\install.ps1
```

- install.ps1 部署时把硬编码的 `C:\Users\nigo` 替换成当前机器 `$env:USERPROFILE`,换机器可直接用。
- 全局 CLAUDE.md **不自动合并**(内含其他手写内容):首次安装把 `global/CLAUDE.md.section.md` 的「## 开发模式」节手动粘入;之后 install 只做缺节提醒。
- 前置依赖:Node、git、codex-plugin-cc(codex-companion)、kimi CLI ≥0.38。`codex-wait.mjs` 里的插件路径含版本号(`1.0.6`),插件升级后需同步改。

**改工作流的正确姿势:改本仓库 → 重跑 install.ps1。** 直接改 `~/.claude` 下的部署副本会在下次 install 时被覆盖。

## 日常用法速记

```text
派活前:Claude 会话里先 Skill(dispatch)              # 或说「派单/派活」触发
L2 并行:先 commit docs/gates/<slice>.md
  node ~/.claude/lane.mjs new <slice> <触碰集...>     # 每 worker 一个 lane
  (lane 目录里)codex-companion task --background ... # 或 kimi -p "<工单>"
  node ~/.claude/lane.mjs audit <slice>               # 验收第一步,FAIL 即打回
  合并后:node ~/.claude/lane.mjs drop <slice>
打回:codex task --resume-last / (lane 目录里) kimi -c -p "<缺陷清单>"
```

各项目可在其 CLAUDE.md 加「## 派单路由」节覆盖默认路由(例:前端归 Claude、Java 归 Codex、契约与安全域强制 L2)。

## 调研来源(2026-08 社区实践)

纪律设计主要抄自:[architect-loop](https://github.com/DanMcInerney/architect-loop)(gates 前置冻结、worker 声明是传闻、PHASE 0 强制异议、lane 便宜弃了重派)、[alexzh3/codex-orchestrator](https://github.com/alexzh3/codex-orchestrator)(证据链留痕)、[frontier-orchestrator](https://github.com/luckeyfaraday/frontier-orchestrator)(领域路由 + 触碰集互斥)、[acsolomon](https://acsolomon.com/blog/claude-code-builds-codex-reviews/)(评审者落笔即污染)、[subcodex-mcp](https://github.com/G0d2i11a/subcodex-mcp)(卡死两级判定)。作弊向量依据 [ImpossibleBench](https://arxiv.org/abs/2510.20270)(可见测试迭代把作弊率 33%→38%)。
