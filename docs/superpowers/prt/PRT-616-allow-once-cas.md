# PRT-616 `allow-once` 的原子占位

> spec §6.5：「消费必须由 team-hub 执行原子 CAS（`approved → consumed`），
> 同一哈希只能成功一次，CAS 失败即 deny。**同一 Attempt 内**模型对同一目标发出
> **参数完全相同**的并发重复调用不得放行两次。」

状态：**已交付**（`team-hub/allow-once.mjs`、`team-hub/server.mjs`；
判据 `team-hub/allow-once.test.mjs` 24 例）

---

## 1 PRT-608 的行级 CAS 看不见什么

PRT-608 的 CAS 是：

```sql
UPDATE permission_requests SET status='consumed'
 WHERE requestId=? AND status='approved' AND bindingHash=?
```

它保证的是「**这一行**只被消费一次」。而危险场景里根本不存在"这一行"：

1. 模型在同一个 Attempt 内，对同一目标**并发**发出两次参数完全相同的调用；
2. 两次都走 `checkPermission`，两次都命中 `ask`，两次都没在去重查询里看到
   对方（查与写之间有窗口）→ **写下两条独立的待批准行**（两条哈希相同）；
3. 用户看到两个一模一样的弹窗，各点一次「批准」→ 两条都是 `approved`；
4. 调用 A 消费第一条（成功），调用 B 消费第二条（**也成功**）。

行级 CAS 全程尽职，一次都没失败——因为**两条行各自都只被消费了一次**。
而同一个规范化操作执行了两次。

> 一个「每一行都只被消费一次」的 CAS，
> 与一个「同一个操作被放行两次」的 CAS，在「它到底防住了什么」上是同一个东西。

---

## 2 第二把锁：键不是行，是"这一次授权的内容"

新增 `approval_consumptions` 表，主键 `consumptionKey = attemptId ⊕ bindingHash`：

```sql
INSERT OR IGNORE INTO approval_consumptions (consumptionKey, …) VALUES (?,…)
-- changes === 1 → CLAIMED；changes === 0 → LOST_RACE
```

唯一约束把"两个人同时想占同一个键"变成一个**原子**问题，交给 SQLite 裁决。

> 一个"先 SELECT 看看有没有、没有就 INSERT"的占位，
> 与一个"在并发下会双双成功"的占位，是同一个东西——
> 只不过它出错需要一点运气。

**不先查后写**：查与写之间的窗口正是这个模块要消灭的东西。

### 2.1 为什么必须是独立一张表

把它做成 `permission_requests` 的一列会**看起来**更省事。但审批行是"有人申请过"，
会被 TTL 过期、会被清理；而占位是"这一次放行被用掉了"——一个**不可回收的安全事实**。

> 一个把不可回收的安全事实放进一张会被清理的表里的设计，
> 与一个「清理跑完之后同一操作又能被放行一次」的设计，是同一个东西。

有用例专门钉住这一点：删掉审批行之后，占位**仍在**。

### 2.2 键必须带无歧义的分隔符

键是拼出来的。去掉分隔符：

```
attemptId='att-1',  hash='ab'   →  'att-1ab'
attemptId='att-1a', hash='b'    →  'att-1ab'   ← 撞车
```

两条**不同**的授权共用一个键，第二条被当成"已经用掉了"而拒绝。方向是 fail-closed，
但它把一个正确的调用判成重复调用。

> 一个「键会撞车」的占位表，与一个「随机拒绝合法调用」的占位表，
> 是同一个东西——只不过前者的表现取决于两个字段各有多长。

用 `\u0000` 分隔。**注意**：两个字段各自定长时这个缺陷不会显形
（总数相等 ⇒ 前 L 个字符相等 ⇒ 两个 attemptId 相等）。所以它只在**字段长度会变**时
出现，而 `attemptId` 恰恰会变（UUID / `att-…` / 夹具），`bindingHash` 的长度在本模块里
也没有被强制。

### 2.3 缺 Attempt 时**不能**退化成全局哈希锁

最省事的降级是"没有 Attempt 就只按哈希"。那会变成一把**跨 Attempt 的全局锁**：
同一操作在**不同** Attempt 里再次被批准（完全合法，例如一次重试）会被拒——
而且是**永久**拒。

> 一个「没有 Attempt 就按哈希全局锁死」的降级，
> 与一个「这张票以后再也不能用」的降级，是同一个东西——
> 而它的表现是「过了一阵子，这个操作就再也做不了了」。

所以换一个**独立命名空间**（按 `requestId`）：不产生假拒绝，这次放行在账本里
**仍然留有痕迹**，且 `attemptScoped: false` 明确标出"本次没有 Attempt 级去重"。
边界是可见的，不是猜的。

---

## 3 占位与消费在同一个事务里

```js
const claim = withTx(() => {
  const claimed = claimOnce({…})
  if (claimed.outcome !== CLAIMED) return { stage: 'claim-lost', claimed }
  const taken = consume({…})
  if (taken.outcome !== CONSUMED) {
    releaseClaim({ db, key: claimed.key })   // ← 退回占位
    return { stage: 'row-lost', claimed }
  }
  return { stage: 'consumed', claimed }
})
```

**退回占位那一步是必须的**。占位成功、行级 CAS 输了，说明这一次**没有**放行
（那张票被别的调用用掉了，或它根本不是 approved）。不退的话：

> 一个「占位成功但放行失败、占位却留着」的账本，
> 与一个「用户批准之后什么都做不了」的账本，是同一个东西。

用户批准了、没人执行，而且之后无论怎么重试都是"这个操作已经用过了"。

三种结果分别处置：

| stage | 处置 |
| --- | --- |
| `claim-lost` | **deny** + `permission:allow-once-duplicate` 审计（spec：不得放行两次） |
| `row-lost` | 抛 `ALREADY_CONSUMED`（§6.5：CAS 失败即 deny） |
| `consumed` | 放行 + `permission:consume` 审计 |

---

## 4 顺带修掉的去重粒度缺陷

代码里本来就写着一条原则：

> 一个用四个字段去重的待批准表，与一个用全部字段去绑定的消费检查，
> 是同一个东西——只不过它表现出来是"我明明批了，它说操作不匹配"。

PRT-608 按这条原则把去重换成比哈希。但**消费**侧的粒度在 PRT-616 之后变成了
`(attemptId, bindingHash)`，而去重侧仍然只有哈希——原则**没贯彻完**：

- Attempt #2 的模型发起同一操作时，复用 Attempt #1 的待批准行；
- 用户看到的是 Attempt #1 的申请；
- 批准之后审计挂在 Attempt #1 上，而执行发生在 Attempt #2。

补上 `AND attempt_id IS ?`（SQLite 的 null 安全比较：没有 Attempt 的调用只与同样
没有 Attempt 的行配对）。

---

## 5 装载时自检：键的无歧义性

`assertKeyUnambiguous` 在装载时验三件事，导出的是**算出来的键与判定**
（不是布尔 `ok`——那是随手就能写出来的字面量）：

1. 两个不同的 `(attemptId, bindingHash)` 不拼出同一个键；
2. 无 Attempt 的键与有 Attempt 的键不重合；
3. 无 Attempt 的键不自称具备 Attempt 级去重。

### 5.1 三道闸门都必须**可达**

正确的实现里这三条的否定式恒为假，所以它们**永远不触发**：

> 一段永远不会触发的断言，与一段不存在的断言，
> 在「它到底拦不拦得住」上是同一个东西。

所以 `keyOf` / `keyIsAttemptScoped` 可注入（与 `assertDeadlineShared` 注入 `beat`
同一套）。**实测的两次教训**：

- **第一版用例注入的是一对*字段***（`('att-1','ab')` 与 `('att-1ab','ab')`）——
  实测**没红**。分隔符在，任何一对字段都撞不上。那种写法看起来像"构造了一次撞车"，
  实际永远测不到东西。改成注入 `keyOf`（探针 ㉝⑧）。
- **第二版用例漏掉了第三道闸门**：那条用例让 `keyOf` 返回重合的串，于是第二道先拦
  了下来，第三道**一次都没跑过**——而一段没跑过的断言，与一段不存在的断言，同形。
  补一条注入 `keyIsAttemptScoped: () => true` 的用例（探针 ㉝⑩）。

---

## 6 平台契约变更（有意）

`approval_consumptions` 是**新表**：数据表 **32 → 33**。其余不变
（路由 136 / 任务状态 7（迁移边 20）/ 目标状态 4 / 权限模式 5）。

这是有意的，理由见 §2.1。`prt-007-baseline.json` 已 `--record` 刷新，
`baseline-snapshot.mjs --check` 报"无漂移"。

---

## 7 诚实边界

1. **并发本身没有被真的跑过**。判据是**确定性**地构造并发的结果（手工写下第二条
   同 `(attemptId, hash)` 的已批准行），而不是真的开两个连接同时调用。
   这与 PRT-608 的处理一致（那条用例用 `consume` 注入强制 `LOST_RACE`）。
   SQLite 的主键约束是这条保证的基础，而单条 `INSERT` 的原子性有 SQLite 自己的
   测试覆盖——本仓库不重复证明它。
2. **`allow-once` 的授权本身还没接 DSH answerer**（属 PRT-602/617）：今天
   `checkPermission` 由 team-hub 侧调用与用例驱动；"命中 Legion 已批准决定时
   由 answerer 触发消费"这条接线还没做。
3. **占位账本没有清理策略**。它是有意不可回收的；长期运行的磁盘增长需要
   一个按 Run 结束归档的策略（属运维面，未交付）。
4. **创建侧的并发去重仍未做**。`checkPermission` 的查-写之间依然有窗口，
   并发下仍可能产生两条待批准行——占位保证的是"两条中也只有一条能放行"，
   而不是"只会产生一条"。用户可能被问两遍（烦，但不危险）。

---

## 8 验证

- `team-hub/allow-once.test.mjs`：**24 例全绿**。
- 破坏性验证：**17/17 处补丁全部变红**（`break-616.mjs`，探针 ㉝①–㉝⑰）。
- 六道门禁全绿；契约：路由 136 / 数据表 **33** / 任务状态 7（迁移边 20）/
  目标状态 4 / 权限模式 5。

### 8.1 探针改瞄记录

| 探针 | 首次结果 | 处置 |
| --- | --- | --- |
| ㉝⑩ 自检的"无 Attempt 不该被判为 attempt-scoped" | 不红 | **真覆盖缺口**：原用例走到第二道闸门就抛了，第三道从未执行。补一条注入 `keyIsAttemptScoped` 的用例后变红 |
| （用例侧）自检撞车测试注入字段对 | 用例本身没红 | 改为注入 `keyOf`：分隔符在，任何字段对都撞不上 |
