# PRT-615 审批 TTL 与 `AwaitingApproval` 心跳

> spec §6.4：`AwaitingApproval` 期间 heartbeat 继续、lease 随 heartbeat 续期，
> 但受审批 TTL 约束；审批 TTL 到期自动 deny，Attempt 转为 `blocked`，写入 audit 并通知用户。

状态：**已交付**（`team-hub/approval-ttl.mjs`、`team-hub/approval-fixture.mjs`、
`team-hub/approval-binding.mjs`、`team-hub/server.mjs`、`team-hub/run-store.mjs`、
`team-hub/config-schema.mjs`；判据 `team-hub/approval-ttl.test.mjs` 40 例）

---

## 1 这一条要防的是什么

`AwaitingApproval` 是**唯一一个由人决定何时结束的等待**。系统里其它每一种等待都有
自己的计时器（租约、重试退避、worker 心跳），只有它没有——于是它的失效方式有两种，
方向相反、都很安静：

| 失效 | 表现 | 方向 |
| --- | --- | --- |
| 审批**永不失效** | 一条没人看的审批占着租约，任务永远停在那里 | 卡死 |
| 租约**先于**审批到期 | 另一个 worker 领走同一条任务，**重复执行**它正在等审批的那个外部写操作 | 危险 |

第二种是 §15 明令禁止的。它的成因很具体：租约与审批各走各的时钟。

> 一个「自动拒绝在 TTL 触发、而租约按另一个时间续」的系统，
> 与一个「两块表各走各的时钟」的系统，是同一个东西。

---

## 2 一个时刻，两处共用

```
approvalDeadlineMs(row)  ──┬──►  evaluateApprovalHeartbeat  →  续租到 min(now+ttl, deadline)
                            └──►  evaluateApprovalExpiry     →  now >= deadline 即过期
```

两条路径都由 `approvalDeadlineMs` 取截止时刻，**并且** `assertDeadlineShared` 在
装载时验它们确实在同一个瞬间转向。自检导出的是**算出来的那一对时刻**
（`leaseExpiresAtMs` / `turnAtMs` / `atTurn`），不是一个布尔 `ok`：

> 一个"生产算一次、自检再算一次"的校验，
> 与一个"只能对当前恰好正确的那份输入作答"的校验，是同一个东西。

### 2.1 越期后拒绝续期，而不是续一个短租约

`evaluateApprovalHeartbeat` 越过截止时刻返回 `action: 'expire'`，**不**返回一个很短的
`boundMs`。续短租约会制造一个窗口：租约到期 → 别的 worker 领走 → 重复执行。

> 一个「在审批到期的前一刻把任务让给别人重做」的暂停，
> 与一个「把同一件已经做过一半的外部写操作再交给第二个人做一遍」的暂停，
> 是同一个东西。

### 2.2 算不出截止时刻的开放审批：过期，理由单独记

`no-deadline` 与 `deadline-passed` 是**两个理由**。方向都是 fail-closed，
但排查方向相反：前者是数据问题（该去看那一行是怎么写进去的），
后者是"用户没回应"。混成一个理由，值班的人会去问用户一个他答不上来的问题。

### 2.3 自检**可注入**

`assertDeadlineShared({beat, expiry})` 收一对结论。理由是：正确的实现里
`beat.expiresAtMs > deadlineMs` **恒为假**，那段断言永远不触发——

> 一段永远不会触发的断言，与一段不存在的断言，
> 在「它到底拦不拦得住」上是同一个东西。

**实测撞到的第二层**：一开始自检的"同一时刻"比较用的是**从 `row` 重新算**的
deadline，于是注入一个伪造的 `beat.deadlineMs` 就能把它架空——
它自称在检查两份时钟，真正的比较却用第三方时钟。补了
`beat.deadlineMs !== derivedDeadline` 这一条（break 探针 ㉜㉘）。

---

## 3 到期扫描

`sweepExpiredApprovals({nowMs, actor, store})`：

1. 取所有**开放**状态的行；
2. `evaluateApprovalExpiry` 判定；
3. `markApprovalExpired` —— **带状态条件**的 CAS；
4. 写 `permission:ttl-expired` 审计；
5. `store.failAndRetry` 联动 Attempt。

### 3.1 为什么必须联动，不能只改审批行的状态

只把审批标成 `expired` 的话，Attempt 会**继续停在 `AwaitingApproval`**：
界面上它是一条"等待审批"的待办，而审批已经过期——既不会被批准，也不进等人工列表。

> 一个「审批已过期、而 Attempt 还在等这份审批」的状态，
> 与一个「任务永远停在那里、谁也不管」的状态，是同一个东西。

**实测撞到的生产缺陷**：`failAndRetry` 用空 context 调 `transitionPlan`，而
`AwaitingApproval → RetryableFailure` 用的是 `approvalOrigin` 守卫、**要求 `returnTo`
存在**。于是"审批被拒或被 TTL 自动 deny"这条边**从来走不通**——每次都在守卫处被拒，
扫描把失败吞进 `permission:ttl-release-failed` 审计，Attempt 原地不动。

> 一条在状态机里写着"被拒或被 TTL 自动 deny 时走这条边"、
> 而实现上每次都被守卫拒掉的边，
> 与一条"只存在于文档里"的边，是同一个东西。

修法是从**那一行**读 `return_to` 传进守卫。这正是状态机把 `__returnTo: true`
挂在 `AwaitingApproval` 上的用意。

### 3.2 为什么用 `failAndRetry` 而不是直接改状态

`AwaitingApproval → RetryableFailure` 只是**中间态**。停在那里的话，任务既没有新尝试
可领（队列里没有 Queued），也不在等人工列表里（它不是 DeadLetter）。
`failAndRetry` 是「失败了按策略处置」的**唯一**入口，它会把重试额度判定也走完：

- 有额度 → 新 Attempt，任务回 `todo`；
- 没额度 → `DeadLetter`，任务进 **`blocked`** —— 正是 §6.4 要的那个终局。

### 3.3 没有 `attemptId` 的老行

PRT-615 之前创建的审批行没有 `attemptId`。它们**照样**过期、照样写审计，
但**不动**任何 Attempt，并进 `orphaned` 桶 + `permission:ttl-expired-unlinked` 审计。

凭 `taskId` 猜一条是错的：同一个任务可能已经重试到第 5 条 Attempt，
把第 1 条判成 `blocked` 会改错历史。

> 一个「凭 taskId 猜一条 Attempt」的联动，
> 与一个「改错历史」的联动，是同一个东西。

---

## 4 懒扫描：正确性不依赖启动模式

team-hub 既作独立进程运行（`isMain === true`），也被宿主外壳
`team-hub/src/index.ts` **import**（那条路径下 `isMain === false`，定时器根本不装）。

> 一个「只在独立进程模式下才跑」的到期扫描，
> 与一个「在宿主外壳模式下永远不跑」的到期扫描，是同一个东西——
> 只不过它的表现是「有的人的审批会过期，有的人的不会」。

所以 `checkPermission` / `listPermissionInbox` / `decidePermission` 三个入口都调
`sweepApprovalsLazily()`（吞掉异常，不让一次清理把正常权限判定变成 500），
`isMain` 下的 `setInterval` 只是覆盖"没人来问"的那段时间。

### 4.1 重入保护

懒扫描会经由 `failAndRetry` 再触发权限判定 → 再触发扫描。`sweepApprovalsOnce`
用**布尔标记**短路：

```js
if (sweepInFlight) return lastSweepResult
sweepInFlight = true
```

**不能**写成 `sweepInFlight = sweepExpiredApprovals(...)` 配 `!== null` 判断——
赋值发生在函数**返回之后**，执行期间那个变量还是 `null`：

> 一个「看起来有重入保护、其实拦不住任何一次重入」的保护，
> 与一个没有重入保护的保护，是同一个东西。

短路返回的是**上一轮已完成的结果**（同一个对象），不是 `null`。用例用对象同一性判，
因为新对象可能与旧对象字段恰好相同。

### 4.2 与 PRT-608 收件箱循环的关系

`listPermissionInbox` 里原本另有一段"把过期的 pending 行标成 expired"的循环
（PRT-608 加的），它**只改状态、不释放 Attempt**。所以如果懒扫描被摘掉，
收件箱看上去一切正常（status 确实是 `expired`），而 Attempt 还停在 `AwaitingApproval`。
判据里专门有一条"只读一次收件箱就联动释放了 Attempt"来钉住这件事。

---

## 5 配置

`LEGION_APPROVAL_TTL_MS`，默认 15 分钟，区间 `[1000, 24h]`。

- Schema 的 `min`/`max`/`default` 与模块常量必须相等（有用例比对）——
  > 一个必须靠人记得同步的上下界，与一个迟早会不同步的上下界，
  > 在「配置校验到底拦不拦得住」上是同一个东西。
- 非法值**装载时抛错**，不静默回落：

> 一个「配置写错了就用默认值继续」的解析，
> 与一个「配置项根本没接线」的解析，在「改了到底有没有用」上是同一个东西。

---

## 6 表结构只有一份

`permission_requests` 的建表 DDL 从 `server.mjs` 搬进 `approval-binding.mjs`
（`ensureApprovalSchema`），测试夹具 `approval-fixture.mjs` **不再手抄列清单**，
而是调真实的 `ensureApprovalSchema` + `createBindingRecord`。

> 一个"生产建一份、夹具抄一份"的表结构，
> 与一个"迟早只有一份是对的"的表结构，在「新加的列到底有没有生效」上是同一个东西。

### 6.1 搬家顺带撞出的门禁缺陷

搬家用的是 `CREATE TABLE IF NOT EXISTS ${APPROVAL_TABLE}`，而
`baseline-snapshot.mjs` 的抽取规则只认字面量 → 表名抽取**静默返回空**：
`permission_requests` 从基线里消失（32 → 31），报出来的漂移是"表被移除了"。
如果同时新增一张表，它**根本不会出现在漂移里**。

> 一个"认不出来的建表语句就当它没建表"的抽取，
> 与一个"可以被无声地绕过的契约门禁"，是同一个东西。

修法是让抽取器解析同文件里的字符串常量，并且**认不出来就抛错**——
宁可它报"抽取规则已与源码脱节"，也不要它报"无漂移"。
另外收紧常量正则：宽松写法会把 `const T = 'a' + 'b'` 认成 `T = 'a'`，
于是拼出来的表名被"解析"成了一个恰好是前缀的、库里不存在的名字。

---

## 7 证据闸门（与 PRT-411 同一机制）

`AwaitingApproval` 的三条出边都声明 `requiresPersist: ['attempt','approval']`。
PRT-615 把这条声明变成**真的闸门**（`EVIDENCE_CHECKS.approval`）。

方向相关的细节：`Validating → AwaitingApproval` **也**声明了 `['attempt','approval']`，
但审批行正是那条迁移自己要创建的东西——要求它在 `UPDATE` 之前存在是循环的。
所以探针在 `edge.from !== 'AwaitingApproval'` 时返回 `EVIDENCE_NOT_APPLICABLE`，
并且**不计入 `checked`**（记 `true` 等于声称"我验过了"一件从未看过的东西）。

闸门是按 `attempt_id` 匹配的，不是 `task_id`：

> 一个按 `task_id` 匹配的审批闸门，
> 与一个"把上一条 Attempt 的审批算成本次依据"的闸门，是同一个东西。

---

## 8 诚实边界

1. **进入 `AwaitingApproval` 时创建审批行尚未交付**（属 PRT-607 审批箱）。
   今天的生产写入路径是 `checkPermission` 的 `permission_requests` INSERT；
   而 `Validating → AwaitingApproval` 的入边核验（"进入 AwaitingApproval 的同一次事务里
   必须已经写下审批行"）仍是缺的。`run-store.test.mjs` 第 ⑪ 条用例的
   `KNOWN_UNIMPLEMENTED` 里已把 `approval` 挪出，因为它作为**出边**闸门已落地；
   入边那一半在 PRT-607 交付时必须补上。
2. **"通知用户"只落了审计**。spec §6.4 要求"通知用户"，今天实现的是
   `permission:ttl-expired` 审计事件；面向用户的通知渠道属产品层（PRT-607/PRT-7xx）。
3. **到期扫描是进程内定时器 + 懒扫描**，不是持久化调度。多进程部署下每个进程都会扫，
   CAS 保证不会重复结清，但"扫描的节流"没有跨进程协调。

---

## 9 验证

- `team-hub/approval-ttl.test.mjs`：**40 例全绿**。
- 破坏性验证：**27/27 处补丁全部变红**（`break-615.mjs`，探针 ㉜①–㉜㉘）。
- 六道门禁全绿；平台契约不变：路由 136 / 数据表 32 / 任务状态 7（迁移边 20）/
  目标状态 4 / 权限模式 5。

### 9.1 探针改瞄记录（按纪律逐条说明）

| 探针 | 首次结果 | 处置 |
| --- | --- | --- |
| ㉜① 租约越期 | 不红 | 原补丁与 `derivedDeadline` 断言重叠，改瞄 `beat.expiresAtMs > beat.deadlineMs` 那一行 |
| ㉜⑲ 扫描候选查询去掉 WHERE | 不红 | **语义等价 no-op**：`evaluateApprovalExpiry` 自己会 `continue`，两道闸门各自足够。**删除该探针**并留说明，有效闸门由 ㉜⑧ 覆盖 |
| ㉜⑳ 过期 CAS 去掉状态条件 | 补丁没应用 | CAS 已搬进 `approval-ttl.mjs` 的 `markApprovalExpired`，改瞄该文件 |
| ㉜㉒ 摘掉懒扫描 | 不红 | 原来瞄的是入口调用行；实测收件箱内部另有一段循环会**掩盖**它。改瞄 `sweepApprovalsLazily` 的函数体，并新增"只读收件箱就释放 Attempt"用例 |
| ㉜㉕ 重入保护退回 `!== null` | 不红 | 原用例断言 `null`，而正确实现返回**上一轮结果**。改用哨兵对象同一性 |
| ㉜㉗ 审批行不写 `attemptId` | 不红 | 原补丁瞄准了模板字面量；改瞄 `.run(...)` 调用，并新增 `checkPermission` 写 `attemptId` 的用例 |
| ㉜㉘ 自检用从 row 重算的 deadline | 新增 | 上面 §2.3 的第二层缺陷 |
