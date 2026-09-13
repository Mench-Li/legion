# PRT-211：continuable session 边界 —— 从「读到签名」到「读到实现」

> **任务**（spec 第 843 行）：验证 DSH continuable session 的**身份、权限继承、
> 事件续接、取消和恢复边界**。
>
> 本文件记录把证据从**接口面**推进到**源码级**的那一批工作，
> 以及一处**推翻了本模块自己原先措辞**的更正。

---

## 1. 这一批补的是哪一档

上一批交付的是 `runtime/adapters/dsh/session-boundary.mjs`：15 条签名逐字读自
运行中的 Inspect 注册表，加 20 例套件。它的诚实边界写得很好——
`EVIDENCE_LEVEL` 只有两档（`api-surface-verified` / `behavior-unverified`），
并且五个关注面**一律**标成前者：

> 全部只到接口面。写成逐面不同的分级会暗示「某些面验证得更深」——
> 而实际上五个面**都没有**做过运行时行为验证。要一致地诚实。

那条理由在当时是对的，但它把**两件不同的事**混成了一件：

* 「没做过端到端实验」
* 「不知道答案」

后来去读 DSH 的实现，发现其中两个面的答案**在源码里是确定的**，
而且**结论与适配器原先的假设相反**。一律标成同一档，于是这两种
「其实已经查清、而且结论会改变实现」的事实，与「完全没查」长得一模一样：

> 一个「一律标成未验证」的诚实，
> 与一个「全都标成已核实」的不诚实，
> 在**读过它的人会不会去查**这件事上是同一个结果——
> 只不过前者看起来更谦虚。

所以本批做三件事：

1. 加一档 `implementation-verified`（**读实现**，不是跑出来的）；
2. 逐面如实，并且**仍然没有任何一面**是 `behavior-verified`——一个端到端实验都没跑；
3. 把结论变成**可执行的判据**，而不只是表格里的一行字。

---

## 2. 结论一：子会话的策略**不**从父会话继承

**出处**：`packages/interaction/user-approval/src/index.ts`
（`effectivePolicy` / `overrideOf` / `setPolicy`，约 177–252 行）

```ts
overrideOf(session: Session): ApprovalPolicy | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type === 'approval/policy') return event.data.policy
  }
  return undefined
}
private effectivePolicy(session: Session): ApprovalPolicy {
  return this.overrideOf(session) ?? this.config.policy ?? 'ask'
}
```

`overrideOf` 只扫**这个 session 自己的**事件日志。子会话日志里没有
`approval/policy` ⇒ `undefined` ⇒ 生效策略落到 **`config.policy`（全局默认）**。

**危险的推论**：父会话策略为 `never`（确定性拒绝）时，一个没被显式设过策略的
子会话会落到全局默认（可能是 `ask`）——**子会话比父会话更宽松**。

> 一个「父会话拒绝了，所以子会话也会拒绝」的假设，
> 与一个「子会话回落到全局默认」的实现，在只读到签名的报告里是同一个东西——
> 只不过前者会让一次**放宽**看起来像一次继承。

### 2.1 附带发现：`setPolicy` 在「设成当前生效值」时**一个事件都不写**

```ts
setPolicy(agent: Agent, policy: ApprovalPolicy): void {
  const previous = this.effectivePolicy(agent.session)
  if (previous === policy) return          // ← 提前返回
  setApprovalPolicy(agent.session, policy)
  ...
}
```

`previous` 是**生效值**（含全局默认回落），不是「上次显式设过的值」。
于是对子会话调用 `setPolicy(child, 'ask')` 而全局默认本来就是 `ask` 时，
子会话日志里**不会**出现任何 `approval/policy` 事件。

后果：事后审计**无法**区分「有人显式设过」与「从没设过、只是回落」。

> 一次「设过了」的调用，与一次「根本没调用」的部署，
> 在**子会话自己的日志**上是同一个读数——只不过前者让调用方以为留了痕。

**对 Legion 的含义**：不能把 `setPolicy` 的调用当作「这条子会话被显式定过策略」
的证据。要留痕必须由 Legion 自己写一条事件。

### 2.2 一处改不掉的措辞

`setPolicy` 注入子会话的那句话永远写着 **"changed by the user"**，
而 `source` 标的是 `{ kind: 'plugin', plugin: 'user-approval' }`。
Legion 改策略走的是同一条路径，所以子会话里的模型会被告知「这是用户改的」。

这是 DSH 的措辞，本仓库改不了，但它必须留在诚实边界里——
**一次由插件发起的策略变更，与一次由用户发起的策略变更，在子会话的上下文里是同一句话。**

---

## 3. 结论二：`isOwnedBy` 是**活体注册表**判定

**出处**：`packages/core/agent/src/index.ts`，`isOwnedBy`，约 571–581 行

```ts
/**
 * ... Runtime ownership is independent of durable session
 * lineage and remains unambiguous when unrelated providers reuse an id.
 * @returns true only while the exact child entry is live under that owner.
 */
isOwnedBy(id: SessionId, owner: Agent): boolean {
  return this.store.get(id)?.owner === owner
}
```

DSH 自己在注释里把这件事写死了：**运行期归属独立于持久会话谱系**，
且返回值只在「那个子条目**活着**」时为真。`store` 是活体注册表。

**推论**：同一个 child、同一对 id，**跨进程重启会翻转答案**
（重启后它不在活体注册表里 ⇒ `undefined` ⇒ `false`）。

> 一个「重启前是 true、重启后是 false」的归属判定，
> 与一个「用持久谱系算出来、两边都 true」的判定，
> 在**重启前那一刻**是同一个读数——只不过前者会在重启后把一次本该允许的操作拒掉。

**对 Legion 的含义**：`isOwnedBy` **只能**用于进程内判断
（「这个活着的 child 是不是我刚造的那个」），**不能**当作持久授权判据。

第二条：按 owner **引用**比而不是按 id 查谱系是刻意的取舍（为了让
"unrelated providers reuse an id" 时仍然明确）。**不要**自己另发明一个按谱系查的
归属判定——那个方向会把一个复用了同一个 id 的陌生会话认成自己的子会话。

---

## 4. ★ 结论三：一处**推翻了本模块原先措辞**的更正

原文（`OWNERSHIP['event-resumption']`）写的是：

> sendMessage 是往一个**活着的** continuable child 追加轮次，不是「重放事件流」。

**这句是错的**，而且错的方向会让人做出错误的运维判断。

**出处**：`packages/subagent/subagent/src/continuation.ts`，`sendMessage`（约 192–232）

```ts
async sendMessage(sender, targetId, content, options): Promise<MessageId> {
  if (this.ctx.agents.get(sender.id) !== sender) {
    throw new SubagentError('message delivery requires the exact live sender agent', 'UNAUTHORIZED')
  }
  ...
}
// 同文件 deliverToChild 的注释：
//   "A missing direct child cold-resumes through the ordinary continuation lifecycle."
```

正确的划分是：

| | 必须活 | 可以不在 |
| --- | --- | --- |
| **发送方** | ✅ 且是**对象引用**相等，不只是 id 相同 | |
| **目标** | | ✅ 会**从持久化冷恢复**，不是失败 |

也就是：把「**发送方**要活」错记成了「**目标**要活」。

**为什么这个错误值得单独写一节**：按原措辞，一次子进程崩溃会让编排器以为
「送不进去了」——于是可能去走一条更重、或者干脆放弃的路径。而实际上**目标不在也能送**。

> 一个「目标必须活着才能投递」的信念，
> 与一个「目标不在就冷恢复」的实现，
> 在**没有崩溃过**的那段时间里是同一个东西——只不过前者会在真的崩一次之后，
> 让编排器以为自己做不到一件其实做得到的事。

**但仍然不是「恢复」**：冷恢复是重建会话再开一个轮次，**不是**把中断的执行接着跑完。
所以「编排器必须自己持久化进度」这条结论**不变**，变的是理由。

顺带核实到的相邻规则：相邻性被强制——`sender.session.header.parentSession === targetId`
的分支要求发送方是**常驻**的 continuable child，否则 `UNAUTHORIZED`。
（也就是说，一个非常驻的子会话**不能**给自己的父会话发消息。）

---

## 5. 把结论变成**可执行的判据**

一条只写在表里的结论，与一条只写在文档里的结论，
在**代码有没有照着它写**这件事上是同一个东西：

> 一条被记录下来的结论，与一条被遵守的结论，
> 在没有判据的时候是同一个东西——只不过前者让读的人以为已经处理过了。

所以本批加了两个**调用方真的会用**的函数（都在 `session-boundary.mjs`）：

* `childPolicyPlan({ childHasOwnPolicy, configPolicy, parentPolicy })`
  —— 返回未显式设置时的实际落点（**永远是全局默认，永远不是父策略**）、
  是否需要显式设置、以及「传进来的父策略没被用上」这件事本身。
  签名里保留 `parentPolicy` 是为了让**「传了但没用」看得见**。
* `ownershipCheckScope({ live })`
  —— 回答 `isOwnedBy` 的答案在什么范围内可信（`usable`），
  以及**能不能写进持久授权记录**（`durable`，永远是 `false`）。

两条各自钉住一条「不这么写就会出错」的规则，而不是把文档抄进代码。

---

## 6. 验证

```
node --test runtime/adapters/dsh/session-boundary.test.mjs
    ℹ tests 28   ℹ pass 28   ℹ fail 0          （20 → 28）
```

新增的 8 例：

| 用例 | 钉住的错法 |
| --- | --- |
| 未显式设置时落到**全局默认**，而**不是**父策略 | 把一次放宽读成一次继承 |
| `configPolicy` 缺省时落到 `ask`（三个入口同答案） | 「没配」有两种后果 |
| 设过与没设过是**不同的**读数 | 生效值恰好相同时被塌成一件事 |
| 传了父策略也**不参与**判定 | 调用方以为传进去的生效了 |
| 活体 → 可用但**永不持久** | 把进程内判定写进持久授权 |
| 不在活体注册表里时 `false` **不等于**「不是你的子会话」 | 把一次**重启**读成一次**越权** |
| 三个入参只认 `live === true` | 把「有值」当成「活着」 |
| `implementation` 是**挣来的**——没有出处不许标这一级 | 强声明不可核 |

### 6.1 变红验证（复核者自己的探针，**9/9 咬住**）

| 探针 | 改什么 | 期望红的用例 |
| --- | --- | --- |
| ⑨① | 未设策略回落到**父策略** | 落到全局默认那条 |
| ⑨② | `durable: false` → `durable: ok` | 永不持久那条 |
| ⑨③ | `live === true` → `Boolean(live)` | 只认 `true` 那条 |
| ⑨④ | 两种情形塌成同一个码 | 「不等于不是你的子会话」那条 |
| ⑨⑤ | `needsExplicitSet` 恒 false | 落到全局默认那条 |
| ⑨⑥ | 摘掉一条结论的出处文件 | 「挣来的」那条 |
| ⑨⑦ | 某一面自称 `behavior` | 不许只报前者那条 |
| ⑨⑧ | caveat 不再说「一个都没验证过」 | 不许只报前者那条 |
| ⑨⑨ | `behaviorVerified: false` → `true` | 不许只报前者那条 |

逐字节还原、工作区无污染。

### 6.2 一处**被自己的用例抓住**的弱点

第一次跑「`implementation` 是挣来的」那条用例时它**红了**，红的不是我写的代码，
而是我刚写下的**结论表**：`event-resumption` 那条的 `source` 写的是
`'packages/core/agent/src/index.ts + runtime/…（阶段 4 归属）'`——一个**不以 `.ts` 结尾**的
复合出处，因为当时**我并没有真的去定位 `sendMessage` 的实现**。

也就是说：我差一点就把一条**没核过**的结论标成了 `implementation-verified`。
是那条「必须写出来源文件」的断言把它拦下来的；去定位实现之后，才发现原来的措辞是错的（§4）。

> 一条「先写结论、再想出处」的复核，
> 与一条「先找出处、再写结论」的复核，
> 在结论**恰好正确**的时候是同一个东西——只不过前者会在结论错的那一次，
> 把错误一起盖章成"已核实"。

---

## 6.3 ★ 顺手撞出来的一个**门禁假阳性**（值得单独记）

加完上面那几条结论之后，`dsh-boundary` 套件红了。红的不是代码，是**我在注释里
引用的一句 DSH 源码**：

```js
evidence: '实现第一句是 `if (this.ctx.agents.get(sender.id) !== sender) throw … UNAUTHORIZED`'
```

`scripts/ci/dsh-boundary.mjs` 的执行面记号按**源码文本**匹配（`\bctx\s*\??\.\s*agents\b`），
**不看上下文**——注释、字符串字面量里的一律算。于是「在文档里引用一句 DSH 源码」
被记成「这个文件依赖 DSH 执行面」，而这个文件**一个执行面 API 都没调**。

修法是把引文里的宿主容器写成 `<宿主>.agents`，并在代码里写清楚**为什么**要这么绕
（不是为了掩盖一个真实依赖，而是为了不触发一个已知会误报的扫描器）。

> 一个"按文本匹配、不看上下文"的扫描器，
> 与一个"扫得对"的扫描器，在**没有人在注释里引用源码**的时候是同一个东西——
> 只不过前者会把一份**说明文档**记成一份**依赖清单**。

顺带发现一处**潜在的矛盾**（本批没有触发，但迟早会）：

* `diffAgainstBaseline()` 对 `runtime/adapters/dsh/` 与 `runtime/dsh-composition/`
  **豁免**（"适配层是唯一允许调用 DSH 执行面的地方"）；
* 但套件 ④「扫描结果与基线完全一致（不多不少）」用的是**未经豁免**的 `scanRepo()`，
  且同一套件的另一条断言**禁止**适配层文件出现在基线里。

两条合起来意味着：**适配层一旦真的写下第一个执行面调用，这条用例就会红，
而它没有合法的修法**——既不能把适配层文件写进基线（另一条断言禁止），
也不能让豁免生效（`scanRepo()` 不看豁免）。
本批之所以没触发，只是因为**既有适配层代码恰好一个字面记号都没有**
（或者说：它的记号为 0）。这是一个"还没被踩到的坑"，不是"没有坑"。

**没有修它**（改门禁超出本批范围，而且改法有取舍：是豁免该进 `scanRepo()`，
还是给适配层留一条"允许出现在基线里"的例外通道，需要单独判断）。

---

## 7. 诚实边界

以下每一条都是**没做完 / 靠推 / 没验过**的。

1. **没有任何一面是 `behavior-verified`**，`behaviorVerified` 一律仍为 `false`。
   本批做的是**读实现**，不是端到端实验。源码级结论很强，但它不能顶替
   「这一次运行时确实如此」——它对**同一份 DSH 代码**成立。
2. **DSH 不是一个冻结的依赖**。上面每条结论都钉着**文件 + 行号**，
   而 DSH 升级会让行号漂、也可能让结论本身失效。本仓库**没有**任何机制
   在 DSH 升级时重新核对这五条——它们是手写的常量，不会自己变红。
3. **结论三的更正来自一次失败**（§6.2）。这提示一件事：那张表里
   **其余四条也应当被同样地质疑一次**。本批只对 `event-resumption` 做了
   「去定位实现」这一步；另外四条的出处都是我主动去找的，
   但**没有人独立复核过它们是否读对了**。
4. **`ASPECT_EVIDENCE` 是手写的**，没有判据保证它与 `IMPLEMENTATION_FINDINGS`
   真的对应——除了「标了 `implementation` 的面至少要有一条带出处的结论」
   这一条。多标一面、少写一条结论，用例会红；但**读错一条结论**，用例不会。
5. **`cancel` / `recovery` 两面仍是 `api-surface-verified`**。
   它们的行为其实已有套件覆盖（PRT-208/209），但那是**适配器自己的**
   行为，不是 DSH 侧 continuable 语义的验证，所以没有升档。
6. **没有跑真实的多轮 continuable child**。「策略在一次真实轮次里何时生效」
   「冷恢复后上下文到底剩多少」都只有源码级结论。
   §4 的冷恢复结论尤其如此：注释说了会冷恢复，**我没有跑过一次**。
7. **没有验证 DSH 升级后的行为**（见第 2 条）。这是本批最容易被忘记的一条边界。
