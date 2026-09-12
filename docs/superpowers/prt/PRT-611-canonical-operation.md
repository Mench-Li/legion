# PRT-611 扩展 F-02 canonical operation

> spec 阶段 6：「`PRT-611`：扩展 F-02 canonical operation，替换键序敏感的 `JSON.stringify` 判等。」
> 阶段 6 完成标准：「改变已批准操作的任一关键字段后无法继续执行。」
>
> `team-hub/permission-engine.mjs`（扩展）+ `team-hub/server.mjs`（两处生产判等点），
> 套件 `canonical-operation`（30 例）+ `permissions` 新增 3 例。

## 1. 缺陷原形

F-02 判「这次调用是不是我批准的那一次」用的是：

```js
JSON.stringify(a) === JSON.stringify(b)
```

它坏在两个**方向不同**的地方，而只有一个方向会有人来报 bug。

### ① 键的书写顺序被当成了操作身份的一部分

`JSON.stringify` 按**插入顺序**输出；`{a,b}` 与 `{b,a}` 是同一个对象却得到不同
字符串。顶层因为 `normalizeOperation` 固定了字段顺序而侥幸没事——但 `metadata`
是 `{ ...input.metadata }`，它的键序**由调用方决定**。

于是：一次 `metadata: {path, mode}` 的批准，遇到 `metadata: {mode, path}` 的
再次调用就会被拒。

> 一个把「键的书写顺序」当成「操作的身份」的一部分的审批绑定，
> 与一个「每次执行都要重新问一遍」的审批绑定，
> 在「用户会不会觉得这个审批按钮没用」上是同一个东西。

这个方向是**拒绝**，也就是 fail-closed。它不造成任何危险，所以没人为它报 bug
——这才是它值得写下来的原因。

### ② 规范化**丢掉**的字段，等于审批没有绑定到它

这个方向是**放行**，才是真正危险的那一个。`normalizeOperation` 收的是一组写死的
字段，任何新加的、没被列进去的字段都会被静默丢掉：审批绑定的于是成了「前若干个
字段恰好相同」，而不是「这次操作相同」。

> 一个「忘了把新字段放进规范化集合」的哈希，
> 与一个「只绑定到前六个字段」的哈希，是同一个东西——
> 而它的方向是**放行**。

## 2. 做了什么

### 指纹取代文本比较

```
operationFingerprint(op) = sha256(domain \u0000 schemaVersion \u0000 canonicalJson(op))
```

规范化 JSON 来自**共享基础库** `runtime/contracts/canonical.mjs`（PRT-401/413，
不是本批新写的）：键排序、NFC、`-0`→`0`、`undefined` 键省略。因此同一个操作在
任何书写方式下都得到同一个指纹。

### domain separator

F-02 用 `legion.permission.operation.v1`，DSH 侧 `canonicalOperationHash` 用
`CANONICAL_OP_DOMAIN`。§6.5 要求两者「使用不同的 Schema 和 domain separator，
防止跨对象复用哈希」——一条用例构造出一个**字段恰好相同**的 DSH 侧操作，
断言两个哈希不同。

### 闭合的字段集合 + 加载时自检

`OPERATION_KEYS = [scope, actor, action, target, taskId, unattended, metadata]`。

`assertOperationKeysAligned()` 比对 `OPERATION_KEYS` 与 `normalizeOperation`
**真正产出的字段**，在模块加载时执行。它同时查两个方向：

| 方向 | 含义 |
| --- | --- |
| `missing`（产出了却没进名单） | 这个字段改了**不会**让审批失效 —— **危险方向** |
| `extra`（名单里有但产出里没有） | 指纹里恒为 `undefined`，规范化在这里静默丢字段 |

> 一个必须靠人记得去同步的名单，与一个迟早会不同步的名单，
> 在「新加的字段能不能改变审批」上是同一个东西。

### 两处生产判等点

| 位置 | 改法 |
| --- | --- |
| `permission-engine.mjs` `consumeDecision` | `JSON.stringify` 比较 → `sameOperation` |
| `server.mjs` `checkPermission` 消费分支 | 同上 |

### 第三处：去重粒度与绑定粒度不一致（顺带发现）

`checkPermission` 里找「已存在的待批准请求」时按 **scope/actor/action/target
四个字段**去重，而消费时按规范化后的**全部**字段比对。两条不同粒度的判断放在
一起，表现是：一次 `taskId` 不同的调用会复用上一条待批准请求，用户批准之后消费方
却因为指纹不同而拒绝——用户看到的是「我批了，它说操作不匹配」。

> 一个用四个字段去重的待批准表，与一个用全部字段去绑定的消费检查，
> 是同一个东西——只不过它表现出来是「我明明批了，它说操作不匹配」。

改成按指纹查：取回同四字段的 pending 行，再挑指纹一致的那一条。存的
`operation` 解析不出/规范化不了时**不算同一个**（认下它会让一次新的调用继承一条
来路不明的待批准请求）。

## 3. 一个**不可观测的分支**，以及一处 harness bug

### `Object.is(value, -0)` 那个分支

最初为它写了一条探针（把 `-0` 归一删掉），结果**咬不动**——而且原因不在用例：
`JSON.stringify(-0)` 本来就返回 `"0"`，所以那个分支对**输出**而言是恒等的。
它是防御性代码，但语义上冗余。这是一个**不可观测的分支**，不是用例太宽。

处置：改瞄同一个函数里**确实可观测**的那条——`undefined` 键的省略；并补一条
用例断言 `{a: undefined}` 与 `{}` 是同一个操作（不省略会让「我把那个字段删了」
被当成「参数变了」）。

### 探针 harness 自己有一个会掩盖红的 bug

18 处探针跑到一半出现 4 处「补丁应用了但用例没红」，而手工复现**明明是红的**。

原因在 harness：多套件时它把「**最长的那个套件的输出**」留下来算失败数。一个变红的
**短**套件会被一个没变红的**长**套件盖掉，于是 `failCount` 算成 0，探针被误判成
「没咬」。

> 一个把「测试失败了」说成「测试没红」的探针，
> 与一个永远不会变红的探针，在「我到底测没测到」上是同一个东西。

处置：对**每个**套件的输出**分别**计数再取最大。修好之后同样 18 处探针全部变红。

## 4. 变红验证：18 处，18 处红

重点是：★★ `sameOperation` 退回文本比较 / ★★ 共享 `canonicalJson` 不再排序键 /
★ 不做 NFC / ★ 不省略 `undefined` 键 / ★★ `canonicalOperation` 丢掉
`taskId`、`unattended`、`metadata` / ★★ `OPERATION_KEYS` 漏字段 /
★★ 加载时自检恒判 ok / ★ 自检只查 `missing` 不查 `extra` /
★ 兜底判**相同** / ★ 两边共用同一个 domain / ★★ `consumeDecision` 退回
`JSON.stringify` / ★ 不再比对 operation / ★★ `checkPermission` 两个方向 /
★★ 去重退回四字段。

## 5. ⚠️ 本批**没有**解决的事

- **没有做审批 TTL 与过期自动拒绝**（PRT-615）。待批准请求仍写
  `expiresAt = now + 15min`，但**没有任何东西在读它**——过期的待批准请求
  仍然可以被批准。这是 PRT-615 的范围，不要读成「过期已经生效」。
- **没有做 `allow-once` 的原子 CAS 消费**（PRT-616）。`checkPermission` 里那条
  `UPDATE ... WHERE status='approved'` 是原子的（`changes === 1` 才算消费成功），
  但**同一 Attempt 内并发重复调用**的防护没有做。
- **`operationFingerprint` 目前没有任何生产调用方**。生产点用的是
  `sameOperation`（它内部用指纹）。指纹作为一个**可以存起来的**标识还没有被存进
  数据库——`permission_requests.operation` 仍然存整份 JSON。
- **没有路径规范化**。F-02 的 canonical operation **有意不做**路径归并：
  `canonicalizePath` 在 `runtime/dsh-composition/enforcement.mjs` 里，
  在 team-hub 再实现一份**行为略有差别**的路径归并，比不做更糟。所以
  `/a/b` 与 `/a/./b` 在 F-02 侧仍然是两个操作（在 DSH 侧才是同一个）。
- **`metadata` 的类型不做约束**：它是任意 JSON 包。`canonicalJson` 会对不能
  无损表达的值（函数、`BigInt`、非有限数）抛错，此时 `sameOperation` 判**不同**。
- **`OPERATION_KEYS` 仍然是手写名单**。自检只能发现「名单与 `normalizeOperation`
  产出不一致」，发现不了「`normalizeOperation` 和校验逻辑一起忘了一个字段」
  （那需要从 spec 反向生成名单，本批没做）。
- 平台契约不变：**路由 136 / 数据表 32 / 任务状态 7（20 条迁移）/ 目标状态 4 /
  权限模式 5**。基线快照里只有 `team-hub/server.mjs` 与
  `team-hub/permission-engine.mjs` 的**源文件哈希**变化，数字一个未动。
  **没有新增任何 HTTP 面。**
