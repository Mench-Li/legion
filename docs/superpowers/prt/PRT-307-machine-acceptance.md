# PRT-307：结构化结果与机器验收

**对应 spec**：§6.10 流水线（「机器验收」是执行成功之后、人工审批与角色交接之前的独立一步）、§12 的 PRT-307
**交付物**：
- `orchestrator/acceptance/index.mjs` —— 判据核验（纯函数）
- `team-hub/run-store.mjs` —— `run_validations` 只追加表、`recordValidation`/`validationsOf`/`criteriaOf`、证据闸门
- `team-hub/server.mjs` —— `POST /api/runtime/validate`、`GET /api/runtime/validations`
- 套件 `acceptance`（24 例）、`acceptance-store`（16 例）、`acceptance-routes`（10 例）

---

## 1. 为什么"执行成功"不等于"交付完成"

PRT-312 的强杀演练留下一个当时只能如实记录的现象：

```
ROWS: [{ id: 'att:d1:1', state: 'Validating', detail: 'drill-ok:att:d1:1' }]
```

执行成功后任务落在 `Validating`，**没有任何东西能把它推到 `Completed`**。
我当时的断言写的是 `Completed`，它超时失败了。修的时候有个真实的诱惑——
为了让用例变绿，把"执行完"直接写成"已完成"。那正是阶段 3 完成标准里
「不伪装成功」要禁的事，所以当时选择了如实断言 `Validating` 并写明理由。

本批把这个落点补上：`Validating` 现在真的能被验收，并按验收结论收口。

「执行成功了」与「做出来的东西满足验收判据」是**两件事**：

| | 谁知道 | 依据 |
| --- | --- | --- |
| 执行成功 | 运行面 | `outcome: completed` |
| 交付被接受 | 机器验收 + 人工审批 | 任务自己声明的判据 |

把两者合并的后果很具体：一个执行得很干净、但产物不对的任务会被标成已完成，
而验收判据**从头到尾没有被任何人读过**。

---

## 2. 三种结论，而不是布尔

```js
ACCEPTANCE_DECISIONS = ['accepted', 'rejected', 'needs-human']
```

「没通过」有两种完全不同的成因：

- **`rejected`**：机器**确认**它不满足判据（产物不存在、必需字段缺失）→ 该打回重试；
- **`needs-human`**：机器**判不了**（判据声明要人核验、判据种类不认识、任务没声明判据）
  → 该进人工审批。

合成一个 `false` 时两类只能走同一条路，而**两条路选哪条都是错的**：

- 把"判不了"当失败 → 一个本来正确的交付被反复重做（若外部写已发生，就是重复副作用）；
- 把"判不了"当通过 → 伪装成功。

去向上也各有一条专属边：`accepted` 要看 `hasNextPost` 才知道是 `Completed`
还是 `HandingOff`；`rejected` 走 `RetryableFailure`（之后由重试额度的唯一决策点
决定重试还是 Dead Letter）；`needs-human` 走 `AwaitingApproval` 且
`returnTo: 'Validating'`——**人工批准后回到验收收口，不必重跑执行**。

---

## 3. 判据清单是封闭的

```js
CRITERION_KINDS = ['run-completed', 'structured-result', 'artifact', 'manual']
```

不在其中的 `kind` 一律算「无法机器核验」，而**不是**「未知即通过」。
新增一种判据必须显式加到这里并实现它的核验——那正是我们希望的摩擦：
一个"总是通过"的核验比没有核验更糟，因为它让验收看起来是被保证的。

判据参数本身写错（`structured-result` 缺 `required`、`artifact` 缺 `path`）
同样是 `needs-human` 而不是 `rejected`：判据写错了是**契约问题**，
不该让任务被反复重做。

`structured-result` 用 `in` 而不是真值判断：`{ testsPassed: 0 }` 是
"核验了、结果是 0"，而 `{}` 是"根本没这个字段"。用真值判断会把前者判成缺失。

---

## 4. 散文判据 = 人工判据

接入运行面时才发现的**真实数据形态**：`tasks.acceptance` 由
`team-hub/stage-standards.mjs` 按岗位/阶段生成，内容是散文：

```js
'每条关键结论可验证：有真实依据（引用 / 命令输出 / 样例），不得虚构'
```

机器**无法**核验它，而它又必须被核验过才能算完成。因此字符串判据被当成
一类**正当的**判据（人工判据），而不是"形状不对的判据"：

- 任务只带散文判据时结论必然是 `needs-human`。这是**对的**——
  `stage-standards.mjs` 生成的任务没有任何机器可核的闸门，从没人说过"什么叫做完了"。
- 散文判据与机器判据**并存**时（真实任务的常见形态）：机器判据被逐条核过，
  散文判据把结论抬到人工审批。两者都不被跳过。

有一种做法也能得到 `needs-human`：把字符串判据当成"形状不对"直接判不了。
结论一样，但错误信息会指向"调用方传错了"，而真实情况是"这条判据天生需要人"——
**排查方向完全相反**。

有一条用例把两处口径钉在一起：读 `DEFAULT_STANDARD.acceptance` 并断言它全是字符串。
若哪天 `stage-standards` 改成生成 `{kind}` 对象，那条用例会红——那时应当重新
想一遍机器验收怎么接，而不是让两条口径悄悄分叉。

空字符串判据（`''`）不算人工判据，而是 `needs-human` 加一条明确的理由：
空判据不是"没有要求"，是这一行没写完。

---

## 5. `requiresPersist` 从"一段 JSON"变成真的闸门

状态机为每条迁移边声明了 `requiresPersist`。例如：

```js
Validating: {
  Completed: { requiresPersist: ['attempt', 'validation'], guard: 'noNextPost' },
  HandingOff: { requiresPersist: ['attempt', 'validation'], guard: 'hasNextPost' },
}
```

在此之前，这个声明只被**记录**进 `run_attempt_events.requires_persist`，从不被核验。
后果是一条任务可以带着"从未被验收过"的事实进入 `Completed`，
而事件流里那句 `requires_persist: ["attempt","validation"]` 看起来像是在保证它。

现在 `transition` 在 UPDATE **之前**核验：

```
POST /api/runtime/transition  {to: 'Completed'}
→ 409 EVIDENCE_MISSING
  「迁移 Validating → Completed 声明要先落库的证据不存在：validation」
```

放在 UPDATE 之前而不是之后：之后发现就只能回滚，而"已经写进去过"这件事
本身会留下痕迹——回滚不掉的告警与外部副作用同理。

`EVIDENCE_CHECKS` 只登记**已经能查**的两项（`attempt`、`validation`）。
未登记的（`runResult` / `context` / `handoff` / `approval` / `reconciliation`）
既不阻塞也不假装核验过——它们各自属于尚未交付的任务。这里刻意**不**给
未登记项一个宽松的默认实现：一个"总是通过"的核验比没有核验更糟。

---

## 6. 验收记录：只追加，且连判据一起存

```sql
CREATE TABLE run_validations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id, task_id, decision, reason,
  gate_json, results_json, run_json, criteria_json,
  actor, lease_epoch, at_ms
)
```

三点设计：

**① 主键是自增 `seq` 而不是 `attempt_id`。** 一次尝试可以被验收多次
（人工复审、驳回后重验），第一份结论必须还在——"当时为什么说它不通过"
是复查时唯一能看的东西。与 `run_attempt_events` 同样的纪律：不提供任何
UPDATE/DELETE 路径。

**② `criteria_json` 存的是「当时实际用的判据」。** 判据可以被人工复审覆盖，
因此只看结论无法回答"这个 `accepted` 是按契约判的还是按复审判的"。

**③ `run_json` 只存判定所需的叶子字段**（`outcome` / `detail` / `artifactPaths`），
不把整个 `runResult` 原样落库——它可能含产物内容或漏脱敏的东西，而验收记录
要长期保存。有一条用例专门断言一个刻意加进 `runResult` 的
`secret: '不该进库的东西'` 不出现在记录里。

---

## 7. 一个事务里做三件事

`recordValidation` 一次做完：核判据 → 落库 → 按结论推进状态。

分成三次调用（记结论 / 改状态 / 决定去向）会让"结论与状态不一致"成为可能：
崩在中间时，一条被判为 `rejected` 的尝试会留在 `Validating`，而重扫会再跑一次
验收——同一次运行被验收两次。

**去向定不下来时整笔回滚。** 例如验收通过但没给 `hasNextPost`：抛
`MISSING_GUARD_INPUT`，事务回滚，验收记录**也一起消失**。留一条没有对应状态
迁移的记录，会让下一次调用看到"已经验收过了"而不知道它有没有生效。

**打回路径刻意不走 `transition`。** `scheduleRetry` 自己会把尝试终结为
`RetryableFailure`（再按额度决定新建尝试还是进 DeadLetter）。若先 transition
到 `RetryableFailure`，它会拿着已经是该状态的行再走一遍
`RetryableFailure → RetryableFailure`——那条边在状态机里不存在。
更重要的是：「还有没有额度」只有 `scheduleRetry` **一处**判断，在验收里
自己也判一次，迟早会出现一处漏掉额度检查，而漏掉的后果是**无限重试且不报错**。

`runResult` 形状不对（`null` / 字符串 / 数组）时抛契约错误且**不落库**：
调用方给错了东西不是一次验收结论，落一条 `rejected` 会让一条本来能通过的
任务被打回。

---

## 8. 这条路抓到的真实缺陷：交付审批显示为"进行中"

用例⑤断言"判不了 → `AwaitingApproval`，任务显示 `in_review`"，实际拿到
`in_progress`。

根因在 `run-store.mjs` 的投影：

```js
// 旧（错）
projectToTask(..., { approvalFrom: plan.taskStatusHint === 'in_review' ? 'Validating' : undefined })
```

`AwaitingApproval` 有**两个入口**：运行中的工具请求（任务仍由该 Attempt 持有 →
`in_progress`）与验收后的交付审批（→ `in_review`）。两者走的是**不同的边**
（`Running → AwaitingApproval` 与 `Validating → AwaitingApproval`），
而 `plan.taskStatusHint` 描述的是边；读它就只能读到其中一个入口的信息。

正确的事实来源是**刚写进那一行的 `returnTo`**：

```js
// 新（对）
const approvalFrom = target === 'AwaitingApproval' ? returnTo : undefined
```

这个缺陷的后果不是报错，而是**一条等着交付审批的任务在看板上显示为"进行中"**：
审批人以为活还在干，于是它既不在待办里、也没人在跑。而这一行上明明白白写着
`return_to='Validating'`，状态机也早就把
`AWAITING_APPROVAL_TASK_STATUS.Validating` 映射成 `in_review`——
两处口径不一致时，以**已落库的事实**为准。

修完之后把旧写法临时改回去验证过：那条用例立刻红，`actual: 'in_progress'`,
`expected: 'in_review'`，然后复原（`TEMP-REGRESSION-CHECK` 标记 0 残留）。
**一个不会因为实现错误而变红的用例没有价值。**

---

## 9. 错误码：4xx 与 5xx 必须能区分

| 码 | 状态码 | 含义 |
| --- | --- | --- |
| `RUN_RESULT_INVALID` | 400 | 调用方给的 `runResult` 形状不对 |
| `MISSING_GUARD_INPUT` | 400 | 没说 `hasNextPost`，去向定不下来 |
| `WORKER_REQUIRED` | 400 | 缺 `actor`——谁做的验收决定必须留痕 |
| `NOT_VALIDATING` | 409 | 请求合法，但这条尝试当前不该被验收 |
| `LEASE_EPOCH_STALE` | 409 | 过期 worker 的结论不得写入（带真实 epoch） |
| `EVIDENCE_MISSING` | 409 | 迁移声明要先落库的证据不存在 |
| `BAD_ACCEPTANCE_CRITERIA` | 500 | `tasks.acceptance` 那一行坏了（**数据问题**） |

最后一行是 500 而不是 400 很关键：请求完全合法，坏的是库里那一行。
混成 400 会让运维去查调用方，而真正要修的是数据。

---

## 10. 未交付

- **交接（`HandingOff` → 下一岗位的任务链）**：`accepted` + `hasNextPost=true`
  能走到 `HandingOff`，但创建下游任务、解析承接方、链式推进没做。
  PRT-308 因此记为 🟡（打回与完成已是 ✅）。
- **人工审批的界面与回执**：`AwaitingApproval` 能被进入，`returnTo: 'Validating'`
  也记下了，但"谁批的、批的什么"这条回执链路（PRT-308/§6.4 的 `approval` 证据）
  未交付，因此 `EVIDENCE_CHECKS` 里没有 `approval`。
- **结构化结果的产物清单来源**：判据 `artifact` 核的是 `runResult.artifacts`，
  而那个字段目前由 worker 自报。真实产物应该来自运行面持久化的 `Artifact`
  记录（PRT-306/§6.10 的「持久化 RunEvent / ToolCall / Usage / Artifact」）。
  现在这条链是"自报 + 核验"，还不是"从事实源核验"。
- **重做的机器验收**：`reason` 允许调用方覆盖结论文案（人工批注用），
  但覆盖后的文案与他人的判据原文一起落库，没有"批注 vs 机器理由"的区分字段。

---

## 11. 复跑方式

```bash
node --test orchestrator/acceptance/acceptance.test.mjs   # 24 例，纯函数，无 IO
node --test team-hub/acceptance-store.test.mjs            # 16 例
node --test team-hub/acceptance-routes.test.mjs           # 10 例，起真 HTTP 服务
node scripts/ci/run-ci.mjs --only test                    # 全套
```
