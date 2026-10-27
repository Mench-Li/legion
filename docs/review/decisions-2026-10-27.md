# 七项未决项的决策记录

日期：2026-10-27
状态：**已决策并落地**（#1、#2、#6 已写代码；#3、#4、#5、#7 为决策定档）
来源：[实施计划](../superpowers/plans/2026-10-26-agent-orchestration-observability-implementation.md) §5 未决项
落盘：`docs/review/decisions-2026-10-27.md`

## 0. 一页总览

| # | 议题 | 决定 | 落地形态 |
|---|---|---|---|
| 1 | 返工不设上限后如何收敛 | **B：连续同因升级** | 纯函数 `rework-escalation.mjs` + Hub 分支；同一 finding 连续 3 轮仍在 ⇒ `in_review` + `hold` + 评论，**不建**返工任务 |
| 2 | 整目标同一 Agent 时的审查独立性 | **A：接受并显式标注** | `selfReview` 字段进预览与冻结回执；**不拦发布** |
| 3 | 是否需要真正的"合入后复验" | **不做** | 无代码变更；T3.1 的命名修正已与之一致 |
| 4 | 编排模式是否长期暴露 | **先暴露** | 无代码变更；已在 T1.3 暴露，按 `goal.orchestration` 统计占比后再定 |
| 5 | 目标级 Agent 的默认是否升为空间级 | **不加** | 无代码变更；理由见 §5 |
| 6 | 失败分类是否收敛成单一码表 | **B：保持分层 + 只读归一化** | 纯函数 `failure-kind.mjs` + 指标端点两个新字段 |
| 7 | 指标保留/脱敏/权限 | **按三条最小规则** | 无代码变更；规则见 §7 |

---

## 1 返工收敛：连续同因升级（B）

**为什么不是轮数上限**：2026-10 移除 `maxReworkRounds` 的理由仍成立——数值上限会把**没修完**的
必改项晾在 `in_review`。这次治的是"同一件事反复修不好"，不是"轮数多"。

**判据**（`orchestrator/state-machine/rework-escalation.mjs`）：

- 指纹 = `kind | file | 归一化 summary`。**`evidence` 刻意不进**——它每轮都变（不同行号、不同日志），
  一旦进指纹就永远不会连续，保护会静默失效。
- 归一化只做空白折叠 + 大小写 + 路径分隔符；**不做语义相似度**（那需要模型，猜错的判据比没有更糟）。
- 从最近一轮往回数**连续**出现轮数；中间被别的 finding 隔开仍算连续。
- **修好一次再复发（回归）不算**——那会从 streak=1 重新开始。

**动作**：达阈值（默认 3，`LEGION_REWORK_ESCALATE_AFTER` 可覆盖）⇒

- 审查任务置 `in_review` + `hold=1`（复用既有拦截列，**不新增状态**）；
- 追加一条写明"哪一条问题连续 N 轮仍在"的评论，并给三条处置路径；
- 台账 `agent_workflow_reviews.kind='escalated'`、`next_task_id=NULL`；
- 审计 `agent-workflow:review-escalated`；
- **不建**返工任务。

**反例守卫**：换一个 `summary` 就是另一件事，不许累积成升级（`pipeline.test.mjs` 决策 #1 用例末尾）。

---

## 2 自审标注（A）

**为什么不拦**：拦了就等于否掉"整条目标由一个 Agent 完成"这个能力本身（T1.5 的全部意义）。

**做法**：`resolveGoalPlan()` 产 `selfReview`——当**审查阶段与实现阶段**回查到同一个 `providerName` 时给出：

```jsonc
{
  "same": "spawn",
  "roles": { "designRole": "…", "implementationRole": "…", "reviewRole": "…" },
  "note": "审查阶段与实现阶段使用同一个 Agent（spawn），语义审查不具备交叉验证性质；Legion 的独立测试回执不受影响（仍由冻结 runner 独立执行）。"
}
```

**三处细节**：

- 只报"审查 vs 实现"同源；设计与审查同源**不算**自审（设计不审自己的实现）。
- `assignments[role].agentToolConfig` 存的是**引用** `{id, version}`，没有 `providerName`，
  所以回查注册表拿 provider；查不到退回用 id 比。
- `note` 必须同时说清"哪一半仍独立"——否则用户会以为整个验收都失效了。

`selfReview` 进两处：`POST /api/goal/plan` 的响应、`POST /api/goal` 回执的 `frozen`（事后要能回答"当时是不是自审"）。

---

## 3 合入后复验：不做

**理由**：合并前的候选提交与应用后的 ref 指向**同一个 SHA**，再验一遍在正常路径上是重复劳动。
它真正能兜住的是"fast-forward 期间 ref 被别人动了"，而那种情况已有 ancestor 校验与
同仓唯一活跃 job 约束挡着。为这个概率付每次集成多跑一遍全套验证的时延，不划算。

**若将来要做**：只在 `LEGION_INTEGRATION_MODE=integration` 且仓库 verify 列表非空时做，
结果记**独立字段**，不能覆盖合并前的判词。T3.1 已把指标与 UI 文案改成"合并前"，
所以将来加"合入后"时不会与旧名字打架。

---

## 4 编排模式：先暴露，用数据再定

**理由**：刚做完入口就撤回，会让人以为这个能力从来没打算给。

**判断依据**（可量化，不需要新埋点）：`goal` 表已有 `orchestration` 列，
统计 `custom-dag` 的发布占比即可。若长期接近 0，就按计划里写的退路办——
让 DAG 编辑器只产出"分配模板"，并在 UI 上说清它不改阶段集合，删掉第二套拓扑语义。

---

## 5 目标级 Agent 不升为空间级默认

**理由**：

1. "整空间默认一个 Agent"用现有配置已经能做到——在配置页把各阶段的工具都设成同一个即可，只是麻烦；
2. 为此新增第五层优先级，会让设计 §5.1.1 那张已经五层的表变成六层，`source` 的可解释性下降一档。

**替代做法**（更好）：在配置页加一个"全部阶段设为…"的批量按钮，用配置页解决体验问题，
**不动优先级表**。

---

## 6 失败分类：分层 + 只读归一化（B）

**做法**（`orchestrator/state-machine/failure-kind.mjs`）：纯函数 `failureKindOf({ errorCode, attemptState, stopReason, reservationState, blockedByDependency, reviewRework })`
→ `{ kind, label, isFailure, reason }`。**不查库、不写库**，调用方把手上已有的读数递进来。

**类别集合是封闭的**（`FAILURE_KINDS`）：`auth / permission / node / integration / agent / unknown / rework / waiting / none`。
新增一类必须显式加进来，否则落 `none`——**未登记的码不许被猜**。

**两条不许被做成失败的业务事实**：

| 事实 | kind | 为什么 |
|---|---|---|
| 依赖未完成 | `waiting` | 那不是失败，是"还没轮到它"。给失败码会让它进重试计数器 |
| 验收返工 | `rework` | 那是流程正常工作。做成失败会把"按设计返工"显示成"出错了" |

**指标口径**：`failureRate()` 的**分母包含** `waiting`/`rework`/`none`（它们是样本），
**分子只算 `isFailure=true`**。把非失败从分母删掉会让失败率虚高。
空样本返回 `available:false`，**不返回 0**。

**已接入**：`GET /api/metrics/repository` 新增 `failureKindRate` / `failureKindCounts`（只读）。

---

## 7 指标保留 / 脱敏 / 权限：三条最小规则

1. **保留**：编排指标按目标归档，随目标同生命周期（`done`/`canceled` 后保留 90 天）。
   **不单独建保留策略**——两套过期逻辑迟早不一致。
2. **脱敏**：指标只出聚合值与 `window`；不出 agent 原话、不出文件路径。
   模型/供应商 id 可以出（非秘密）。
3. **权限**：沿用现有只读面（`authorized` + scope），**不新增角色**。

**已知边界**：`by` 仍是自报的（共享 token + 请求体身份），所以指标的"谁产生的"
与审计的"谁批准的"一样，只在可信网络边界内成立。要改这一点需先做独立身份，
不在本轮范围。

---

## 8. 验证

```
orchestrator/state-machine/rework-escalation.test.mjs   8 pass
orchestrator/state-machine/failure-kind.test.mjs        8 pass
team-hub/pipeline.test.mjs                             25 pass（含决策 #1 e2e）
team-hub/goal-orchestration.test.mjs                   10 pass（含决策 #2 e2e）
team-hub/metrics.test.mjs                               3 pass
```

新增 `rework-escalation.mjs` / `failure-kind.mjs` 两个纯层模块，均不写库、无副作用。
