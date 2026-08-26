---
name: dispatch
description: 多模型派单工作流:Claude 当架构师/监工/验收官,把施工派给 Codex(后端/复杂逻辑)与 Kimi(杂事/机械活)。凡是要派活、派单、分工、并行开发、多 agent 协作、让 Codex/Kimi 干活、开 lane、验收 worker 产出时,必须先加载本 skill。
---

# dispatch — 架构归 Claude,施工归 worker

角色铁律:**你(Claude)只做架构、拆单、派活、监工、验收;前端/UI 亲自写;其余施工派出去。**
worker 的「完成」只是「待验收」;worker 的一切声明是传闻证据,结论只能由你跑命令得出。

## 1. 自适应分级(先定档,再动手)

| 档 | 触发条件 | 流程 |
|----|---------|------|
| **L0 直做** | ≤~30 行 / 单文件修补 / 紧急修复 / 前端(路由表归 Claude 的域) | 自己写,不派单。仍守「提交前绿条跑在即将提交的代码上」 |
| **L1 轻派单** | 单域、边界明确、无并行需求 | 工单(含 PHASE 0 + 原始证据)→ 单 worker 在主树干活 → 验收。不冻 gates 不开 lane,但派前主树必须干净 |
| **L2 重派单** | 需并行 / 或触及 schema、API 契约、持久化、安全 | gates 前置冻结 → worktree lane(每 worker 一个)→ 触碰集对账 → 高风险加跨模型评审 |

拿不准时:并行=L2;单干但改动大=L1 并口头声明验收命令;犹豫要不要 gates 的,就是要。

## 2. 路由(默认表 + 项目覆盖)

**先查项目 CLAUDE.md 是否有「## 派单路由」节;有则以项目为准。** 默认:

| 任务域 | 谁干 | 备注 |
|--------|------|------|
| 后端 / 复杂逻辑 / 长程 debug / 大重构 | **Codex**(xhigh) | 「计划明确只差执行」是其强项 |
| 测试补写 / 文档同步 / 机械批量改 / 全仓摸底读码 | **Kimi** | 便宜、验收成本低;大规模读码出报告尤其合算 |
| 前端 / UI / 小程序 / 一切需浏览器或截图验收的 | **Claude 亲自** | 派出去的往返成本高于自己写 |
| 跨端契约(DTO / 接口变更) | Claude **先冻结契约**再分头派 | 前端绝不能凭空发明后端 API |
| 独立第三方复核(高风险 diff) | 交给**没写这份代码**的那个模型 | 评审者一旦落笔即被污染,评审单必须只读 |

## 3. 工单模板(两家通用,自包含——worker 看不到你的对话)

```
【目标】做什么 + 为什么(给理由,不只给指令)
【钉死项】数据结构 / 接口签名 / 禁改清单
【文件触碰集】只许改这些(与 lane manifest 一致)
【改动清单】文件级的预期改动 + 已知陷阱
【验收命令】逐条列出(L2 时指向已冻结的 docs/gates/<slice>.md)
【PHASE 0 异议】动工前必须先核对本工单与代码现实的冲突,引用具体文件;
  没有冲突也要列出查证了什么。沉默服从记为缺陷。
【交付格式】只准原始证据:命令+完整输出(或输出文件路径)、diffstat、改动文件清单。
  禁止「已完成 / 测试通过」类结论句。
【边界】自检 typecheck+test;禁一切 git 写操作;禁碰触碰集外文件;不许扩大范围重构。
```

## 4. 派单机制

### Codex lane(codex-companion 插件)

```
node "C:\Users\nigo\.claude\plugins\cache\openai-codex\codex\1.0.6\scripts\codex-companion.mjs" \
  task --background --write --effort xhigh --fresh "<工单>"   # 派(一律 --background,禁前台等待)
  status --all                                                # 盯
  result <job-id>                                             # 收
  task --resume-last "<缺陷清单>"                             # 打回重做
  adversarial-review --background [focus]                     # 对抗式审查
```

- 等终态一律 `node "C:\Users\nigo\.claude\codex-wait.mjs" <job-id> [轮询秒]`(Bash + run_in_background)。
  **绝不 grep/awk 解析 status 文本**——完成任务会换表格挪位置,过滤器静默失灵,表现和「卡住」一模一样。
- 在 lane 里跑:工单开头注明工作目录为该 lane 的 worktree 绝对路径。
- Windows 已知事实:Codex 沙箱 helper 起不来(openai/codex #28248),两处规避缺一不可——
  ① 全局 config `sandbox_mode = "danger-full-access"`;② 插件补丁(codex-companion.mjs 两处 +
  lib/codex.mjs 一处写死 sandbox 值改 "danger-full-access";**插件升级会覆盖,升级后 grep sandbox 三处重打**)。
  改完插件必须杀 `app-server-broker.mjs` 常驻进程,否则内存旧代码,任务卡死在 Starting thread。
- quirk:任务未完时 `result` 报「No job found」= 还没完,不是丢了;同仓多任务排队串行。
- Codex 实际无沙箱 → 工单里的禁令全靠事后对账(lane audit / git status),**派前工作树必须干净**。

### Kimi lane(kimi CLI,≥0.38)

```
kimi -p "<工单>"            # 非交互派单;-p 会自动执行工具调用,禁配 --auto/-y
kimi -c -p "<缺陷清单>"     # 打回重做:-c 按工作目录续会话 → 每个 lane 目录天然独立会话
```

- 后台跑:Bash 工具 `run_in_background` + 输出重定向到 lane 内 `_report.md`,完成自动收到通知。
- 在 lane 的 worktree 目录里启动(cwd 即隔离边界 + 会话键)。

### 卡死判定(两家通用)

输出文件 **5 分钟**不增长 → 疑似卡死;**15 分钟** → 杀该子进程(不是杀整个任务),打回或弃 lane。
lane 坏了优先 `drop` + 重派,别救援式追加 prompt——lane 按构造是便宜的。

## 5. worktree lane(L2 强制力层)

```
node "C:\Users\nigo\.claude\lane.mjs" new <slice> <文件/目录>... [--base <ref>] [--protect <path>]
node "C:\Users\nigo\.claude\lane.mjs" audit <slice>    # HEAD 未动 + 全在声明集 + gates 未碰;FAIL 即 exit 1
node "C:\Users\nigo\.claude\lane.mjs" list
node "C:\Users\nigo\.claude\lane.mjs" drop <slice>
```

- worktree 在 `<repo>/.lanes/<slice>`,分支 `lane/<slice>`,自动进 .git/info/exclude。
- **并行前提:各 lane 触碰集互不相交。** 合并冲突 = 拆单缺陷 → 杀冲突 lane 重拆,不现场调解。
- 合并流程(audit PASS 后,全归你):lane 目录里逐行读 diff → 你 commit 到 lane 分支 →
  回主树 merge → 合并后在主树再跑一遍 gates(集成冒烟)→ `drop`。
- worker 永不 commit(audit 的 HEAD 检查兜底)。

## 6. gates 前置冻结(L2)

派单**前**把验收写成 `docs/gates/<slice>.md` 并 commit:每条 = 精确命令 + 预期输出/阈值。
- 判分权不给 worker:工单只说「跑这些命令并贴原始输出」。
- worker 改 `docs/gates/` = 该 lane 自动 FAIL(lane.mjs 默认保护)。
- 验收时照 gates 逐条自跑打钩,**引用原文判,不凭记忆复述**。
- gate 全过是必要条件不是充分条件:仍要对着 spec 意图读 diff——迭代对抗可见测试是已知作弊向量。

## 7. 验收清单(每单必走)

1. lane audit PASS(L2)/ git status 对账(L1)。
2. gates / 验收命令逐条自跑,读原始输出。
3. diff 逐行读;关键断言用 `node "C:\Users\nigo\.claude\mutate.mjs"` 变异看红(禁手写 sed + git checkout 还原)。
4. 高风险 diff(schema/API/持久化/安全):派**另一家**模型做只读对抗评审再判。
5. 判定:PASS 合并 / 打回(resume + 缺陷清单)/ 弃 lane 重拆。打回超过 2 轮 = 拆单缺陷,回炉重写工单。
6. 提交前在**即将提交的那份代码**上重跑绿条,再 commit。
