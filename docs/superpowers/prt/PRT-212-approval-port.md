# PRT-212：审批 answerer 接上 team-hub 审批箱

> spec §6.5 / §6.8：工具调用的授权走 F-02；`allow-once` 是按 **canonical operation 哈希**
> 的一次性决定；team-hub 不可达时**不得**「等它恢复后再询问」。

`runtime/dsh-composition/enforcement.mjs` 的 `createApprovalAnswerer` 早已写好。
本文记录的是它**缺少的那个生产者**。

---

## 1. 缺的是什么：三块都在，中间那条线不存在

| 半边 | 位置 | 状态 |
| --- | --- | --- |
| answerer（阶段期限、`unavailable` vs `rejected`、闭集外的值不当放行） | `enforcement.mjs` | ✅ 早已交付 |
| 端口（`requestApproval`，含投影按 callId 取回的那一层） | `tool-request.mjs` | ✅ 早已交付 |
| 主体构造（投影 → 完整 F-02 操作，含 `argsHash`） | `tool-request-bridge.mjs` | ✅ 早已交付 |
| **把主体真的送进审批箱、把人的决定带回来** | —— | ❌ **不存在** |

`requestApproval` 在全仓库只有两种取值：`null`（默认），或测试里的
`async () => 'rejected'`。

> 一个"answerer 写得对、端口处处留好、而从来没有人填过它"的审批，
> 与一个"根本没有审批"的审批，在运行时的表现是同一个东西——
> 只不过前者的用例是绿的。

本批交付 `team-hub/approval-port.mjs`：`createHubApprovalPort()` 返回的
`requestApproval` 就是那块缺口。

---

## 2. ★ 三条"读代码看不出来、只有发过请求才知道"的发现

**这套件起一个真的 hub，抓到的不是覆盖率，是三条事实。**
用一个我**以为**对的假响应去喂，这三条永远不会红。

### ① `POST /api/permissions/check` 必填 `by`

`handleWrite` 的第一件事是 `requireMember(body)`。缺了它整个请求 **400
「缺少操作者身份 by」**，而端口会把它记成 `CHECK_FAILED` → **"审批箱不可达"**。

> 一次**参数缺失**被报成了**基础设施故障**，排查方向完全相反：
> 一个人去查 hub 起没起，而真正的问题是少传了一个字段。

### ② 判定体在响应的 **`task`** 下面，不在顶层

`handleWrite` 的返回是 `{ok:true, task: result}`。从顶层读 `status`
永远读到 `undefined` → `UNKNOWN_STATUS` → "这端口现在不可信"。

> 一个"从错误的层级读判定"的端口，
> 与一个"审批箱每次都返回无法理解的东西"的端口，是同一个东西——
> 只不过前者其实拿到了完整的答案。

### ③ `approved` 有**两个**来源，不能长得一样

hub 在两种情况下都返回 `status: 'approved'`：

- **策略直接放行**（`allow-by-policy` / `allow-for-task`）—— **不落任何行**，没有人类参与；
- **人批了**（`decidePermission` 把待批准行改成 `approved`）—— 有 `decidedBy`/`decidedAt`。

第一版把两者一律映射成"策略直接放行、`human:false`"。探针立刻打出一张
**自相矛盾**的凭据：

```
outcome=allowed-once  human=false  reason="hub 策略直接放行"  decidedBy="general"
```

——它一边说"没有人类参与"，一边记着是谁批的。

> 一个"报告说没有人参与、却带着决定者"的凭据，
> 与一个"报告说某人批准了这次写入"的凭据，对审计是同一个东西——
> 只不过前者会让一次**人工批准的越权操作**看起来像一次策略放行，
> 于是没有人需要为它负责。

**修法**：判据是**行自己的凭据**，不是状态串。`outcomeOfRow` 分两路：
有 `decidedBy` → `human:true` / `已批准（by=…）`；没有 → `human:false` / `策略直接放行`。
`denied` 同理。空白串与 `null` 一样算"没有决定者"（`'  '` 不是一个人的名字）。

---

## 3. ★ 三个设计判断

### 3.1 `onConnected` 只能在 hub **真的答了**之后自报

审批箱是**两阶段**的（`ENFORCEMENT_PHASES = ['connect','response']`）。
连不上是故障，连上了而没人批是"还在等"，两者的排查方向完全相反。

一进门就自报，会把一次**连不上**记成"响应阶段超时"——值班的人会去翻
审批箱有没有积压，而真正的问题是 hub 根本没起来。

> 一个"一进门就自报已连接"的审批端口，
> 与一个"永远连不上、但每次都报告响应阶段超时"的端口，是同一个东西。

自报点只有一个：`check` 返回了合法响应之后。

### 3.2 查不到那一行 ≠ 还没人批

`checkPermission` 在 `withTx(...)` 里写那一行，**返回之前就已经提交**。
所以 `check` 一回来，那一行就必须在库里。查不到只有几种可能：
打到了**另一个 hub 实例**、行被删了、空间过滤把它排除了——**没有一种是"继续等人"**。

> 一个"查不到就安静地继续轮询到超时"的实现，
> 与一个"这份申请根本不存在"的实现，在屏幕上都是"等了一会儿然后超时"——
> 只不过前者的理由是"没人处理"，后者是"你查错了地方"。

所以查不到就**当场**报 `ROW_VANISHED`，并且**不继续等**（用例断言
在 60 秒预算下 `elapsedMs < 2000`）。

另外，查自己的行时**刻意不带 `scope` 过滤**：

> 带上过滤就把"空间参数传错了"变成了"这行不存在"，
> 两个完全不同的缺陷会长成同一条日志。

### 3.3 到期是"没人回答"，不是"人说不"

`expired` → **`unavailable`**，不是 `rejected`。这是 `enforcement.mjs`
文件头早已写死的纪律（`rejected` 是「人说不」，`unavailable` 是「问不到人」），
这里只是照着执行。把到期记成拒绝，会让人去**追问一个从未被问过的人**。

同理，未知状态**既不当作放行、也不当作拒绝**，而是 `unavailable`
（"这个端口现在不可信"）。

---

## 4. ★★ 凭据不是装饰

端口返回的是 `APPROVAL_OUTCOMES` 里的一个字符串，**但结局不是全部信息**。
批准之后还有一步**消费**：`POST /api/permissions/check` +
`permissionRequestId`，由 hub 校验「这次调用是不是当初批准的那一次」。

所以端口留下凭据：`requestId` + `bindingHash` + `human` + `decidedBy`。
用例做端到端验证：

1. 先拿**换过参数**的操作去消费 → **必须被拒**
   （`approval-operation-changed`）——证明绑定绑的是**内容**，不是一张可以随便挪用的票；
2. 再拿**原样**操作去消费 → 通过，`status: 'consumed'`。

> 一个"批准了、也返回 `allowed-once`、而拿回来的票据根本消费不了"的端口，
> 与一个"什么都没接"的端口，在用户那里都是"我批了，执行时说操作不匹配"。

**这条用例的断言顺序本身是一条知识**：必须在**第一次消费之前**试错的。
用掉的票再拿来用时走的是 `ALREADY_CONSUMED`，而 hub **有意**让它落回策略判定
（"用掉之后再发起"是一次正常的新申请），于是它会拿到 200 并产生一条新的待批准行——
看起来像"换个操作也能用"。第一版就是这么写错的，用例红了才改对。

---

## 5. 另一处修复：`onConnected` 从来没被透传

`runtime/dsh-composition/tool-request.mjs` 的 `request` 端口只把 `projection`
交给了 `requestApproval`：

```js
// 改前
request: async (short) => {
  const projection = byCallId.get(short?.callId)
  ...
  const outcome = await requestApproval(projection)   // ← onConnected 丢了
```

后果不是报错，而是**报错的东西**：`runWithPhaseDeadlines` 在连接窗口到期
而端口没自报时，会退化成 `PHASE_UNREPORTED`（"阶段未自报"）而不是
`RESPONSE_TIMEOUT`。

> 一个"从不自报已连接"的审批桥，
> 与一个"每次都连不上审批箱"的审批桥，在可用性报告上是同一个东西——
> 只不过前者其实已经把申请放进审批箱了，而且很可能只是没人批。

修法：把 `onConnected` / `signal` / `responseTimeoutMs` 一起透传。
`responseTimeoutMs` 也要传，因为端口的轮询预算必须**等于**调用方的窗口，否则
轮询会比 Run 的期限活得更久。

用例两条，各管一半：

- **`onConnected` 是函数**（回归测试，改前必红）——盯的是那个 drop；
- **自报与不自报的归因不同**（`RESPONSE_TIMEOUT` vs `PHASE_UNREPORTED`）——
  盯的是那条区分本身。⚠️ 第二条在 `createApprovalAnswerer` 那一层测，
  所以它**不管**那个 drop 的回归；它证明的是"这个区分是真的"。

---

## 6. 验证

- 新增套件 `approval-port`（**19 例**，**起真 hub**）。
- `tool-request` 套件 **35 → 37 例**（新增两条）。
- **变红验证 18/18 全红，0 处"期望绿"，源码按字节还原**（探针 `70①…70⑱`）。
  其中 `70⑱` 专盯 `onConnected` 的透传。
- 六道门禁全 PASS；全量 CI 见 `docs/STATUS.md`。

---

## 7. ⚠️ 诚实边界（重要）

**PRT-212 只完成了一半的接线，仍是 🟡。**

> ⚠️ **2026-09-18 注**：本任务**现已 ✅**（见 `docs/superpowers/prt/PRT-PROGRESS.md` 的状态列）。上面这段是该批次结束时的口径，**原文保留**——*一个"当时写对了"的边界说明，与一个"现在仍然成立"的边界说明，读起来是同一句话。*

本批交付的是**生产者**：答answerer 现在**有一个真的、接在 hub 审批箱上的端口可用**。
但**消费端仍然没有生产构造点**：

- `createEnforcementBridge` 在全仓库**只有测试调用它**（`runtime/dsh-composition/*.test.mjs`），
  没有任何生产代码构造它——所以即使端口齐了，真实运行里也没有人把
  `requestApproval` 递给它。
- 因此端到端「一次真实的工具调用被送进审批箱 → 用户批准 → 执行」**仍未跑通过**。
  本批的端到端用例是**端口级**的（端口 ↔ 真 hub），不是**产品级**的。
- 那一步取决于 PRT-214 的组合引导（补丁层落盘应用），而那件事本身
  卡在一个产品决策上。**在它解决之前，PRT-212 不该被读成"已完成"。**

其余边界：

- **轮询，不是推送**：默认 250ms 一次 `GET /api/permissions/inbox`。
  hub 没有长轮询/SSE 通道，所以等待期间是**轮询**。
- **轮询读整个箱子再在客户端筛**（刻意不带 `scope`，见 §3.2）。
  审批历史很大时这里会变慢——一个随审批历史增长而变慢的轮询，
  与一个最终会拖垮 worker 的轮询，是同一个东西。
- **`attemptId` 由调用方给**：本模块不猜。传 `null` 时 hub 的行也是无主的
  （`attempt_id IS NULL` 的 null 安全比较），这与"绑定到某个 Attempt"是两回事。
- **`action` 缺省是工具名**（来自 `legionOperationOf`），
  所以同一工具的不同意图如果要用不同的 `action`，得由调用方显式给。
- **不做审批 TTL 的本地判断**：到期由 hub 判定并落成 `expired`，
  端口只翻译。本地再判一次会造出第二个真相。
