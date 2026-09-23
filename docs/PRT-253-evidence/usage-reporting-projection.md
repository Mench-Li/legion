<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# usage-reporting：一次 Run 的 token 用量从**会话投影**读回来（PRT-253 续批三）

日期：2026-09-21　分支：`main`　上游裁决：业主选「走 subscribeRun 事件通道（推荐）」，
实施时按实测把通道换成 `ctx.sessionProjections`（理由见 §2）。

---

## 1. 一句话

`usage-reporting` 长期是 `false`，**根因不是"没人接线"，而是引擎的一次性结果契约里
根本没有用量字段**。用量确实存在——在 DSH 的会话日志里，由 `ctx.sessionProjections`
一等读面暴露。本批把这条读出路径接上，**并且**把"读不到时不许编一个 0"钉成判据。

---

## 2. 我上一轮的建议错了一半（先纠正）

| 我上一轮说的 | 实测 | 结论 |
| --- | --- | --- |
| ① "PRT-253 看起来最接近可收口" | 它台账行末尾**明写**「★★★ 状态 🟡 → ⏸ 需外部输入（2026-09-18，业主裁定）」，并且「本行是否还有本机可做的动作：**没有**」 | ✖ **我错了**。我只读了那一行 24093 字符里的**前 400 字符**就下了建议。**不收口** |
| ② "usage-reporting 接线（可选）" | 归因键存在、时序稳定、通道是一等 API | ✔ 可做，已做 |

> 一条 24093 字符的台账行，与一条 400 字符的台账行，在"我读过它"这个说法里
> 是同一个东西——只不过前者的末尾**推翻**了开头。

---

## 3. 根因（逐字读过的契约）

`packages/subagent/subagent/src/types.ts` 的 `SubagentResult` 只有四个字段：

```ts
readonly output: ContentBlock[]
readonly structured?: unknown
readonly diagnostic?: string
readonly stopReason: SubagentStopReason
```

**没有 `usage`。** 而 `runtime/adapters/dsh/usage.mjs` 的 `collectUsage()` 读的是
`result.usage ?? result.tokenUsage ?? result.tokens ?? result` —— 在真结果上三者皆无，
于是恒返回 `null`。预算闸门（PRT-510）因此在生产路径上永远拿不到 token 数。

---

## 4. 归因：怎么知道这段用量属于**哪一次 Run**

三条实测读数（`scratch/_probe-r121-*` / `_r122-*` / `_r123-*`）：

| # | 读数 | 出处 |
| --- | --- | --- |
| ① | `SubagentRun.id` 是 `SessionId` | `packages/subagent/subagent/src/types.ts` |
| ② | 该 id 与会话目录名**逐字相等**，151/151 | `_probe-r122-sessionid.mjs` |
| ③ | 子代理会话尾部**一定有 `turn/end`**，且在最后一条 usage 之后，95/95 | `_probe-r123-race.mjs` |

于是归因链是：

```
run.id (SessionId) → ctx.sessions.get(id) → Session → sessionProjections.stateOf(session, key)
```

**全程进程内、无文件 I/O。** 不需要适配器去读 `DSH_HOME` 下的 `.jsonl.zstd`，
也不需要 `scripts/prt/dsh-session-usage.mjs` 那份离线工具的解析逻辑。

> 一个"按时间窗口对齐"的用量归因，与一个"按 SessionId 直取"的归因，
> 在只看总数的时候是同一个东西——只不过前者会在并发 Run 时把两次的用量
> 混在一起，而那个和看起来完全正常。

### 4.1 为什么**不是** `subscribeRun`

业主选的是"走 subscribeRun 事件通道"。实测后改用投影，理由是**那个通道是空的**：

- `subscribeRun` 在 Legion 契约里声明为可选端口（`port.mjs:56`），但**全仓没有生产者**；
- DSH 的 `SubagentProvider` 接口**没有事件面**（逐字读过 `types.ts`），
  `createLifecycleEmitter` 只对 `subagent/start|end|provider-removed` 派发；
- 而 `ctx.sessionProjections` 是 DSH 的**一等**读面，由框架在 `session/event` 上
  **急切驱动**纯折叠——它才是那个"事件通道"。

⇒ 接一个没有生产者的端口只会得到一个永远为空的读数。**方向对，落点改了一格。**

---

## 5. 改了哪 6 个文件

| 文件 | 改动 |
| --- | --- |
| `runtime/dsh-composition/usage-projection.mjs` | **新**。纯折叠（`usageOf` / `applyUsageEvent` / `usageFromState`）、投影定义、按 `SessionId` 读 + 五个具名码 |
| `runtime/dsh-composition/usage-projection.test.mjs` | **新**。22 例 |
| `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` | 注册仅主机投影（**不抛**，四种结果各自有码）；端口多一个 `runUsage(sessionId)` |
| `runtime/adapters/dsh/port.mjs` | `.id` → `sessionId` 如实带出（此前**丢掉了**） |
| `runtime/adapters/dsh/usage.mjs` | `collectUsageFromProjection()` + `collectRunUsage()`（先结果、后投影） |
| `runtime/adapters/dsh/index.mjs` | 两处结算路径都改用 `collectRunUsage()` |
| `runtime/adapters/dsh/adapter.test.mjs` | +5 例（含三条 `⑯`）+ **两条 `⑮`** |
| `docs/superpowers/prt/PRT-PROGRESS.md` | 一处 `file:line` 引用随位移更新（见 §8） |

---

## 6. ★ 顺带发现并修掉一处**真缺陷**（序号空洞）

改 `port.mjs` 时我多了一条告警，于是 `adapter.test.mjs` 的一条既有用例红了：

```
③ 事件全部通过契约自身校验，seq 从 1 严格递增
  actual:   [1, 2, 4]
  expected: [1, 2, 3]
```

**根因**（`runtime/adapters/dsh/index.mjs:616`，修复前）：

```js
for (const w of handle.warnings) emitter.emit('run.progress', { warning: w })
//                                        ^^^^^^ 少了 yield
```

`emitter.emit()` 会**分配序号**并把事件交给调用方——不 `yield` 就只做了前半步：
**序号被消耗、事件被丢掉**，于是审计序号出现空洞。而 `events.mjs` 的
"序号唯一权威"一节明确写着「不该让我们的审计序号出现空洞或重号」。

**为什么它此前从没被踩响**：唯一会走到那里的是"句柄缺 dispose"这条告警，
而所有现存替身的句柄都带 `dispose`。**我加的告警第一次把它踩响了。**

> 一个"分配了序号"的动作，与一个"发出去了一条事件"的动作，
> 在只看事件内容的用例里是同一个读数——空洞只在那条比较**整个 seq 数组**的
> 用例里才现形，而它此前恰好没有被触发。

**修法与判据**：补 `yield`；新增用例 `⑮ 有告警时审计序号不许出现空洞`
（**故意**造一个缺 `dispose` 的句柄来踩响它）。破验：把那行 `yield` 再去掉 ⇒ **咬住（红）**。

---

## 7. 破验

### 7.1 投影模块（`scratch/_mutate-r124-usage.mjs`）6/6 + 反向

```
✔ M1 ★「读不到」返回全 0 对象            → 咬住（红）
✔ M2 五种"读不到"合成一个码              → 咬住（红）
✔ M3 不相干事件返回新对象                → 咬住（红）
✔ M4 messages 不参与判定                 → 咬住（红）
✔ M5 把 cacheRead 当成没花               → 咬住（红）
✔ M6 负数被当作合法计数                  → 咬住（红）
✔ M7 ★ 反向：好状态被判成 null           → 咬住（红）
还原逐字节相同：✔
```

### 7.2 接线（`scratch/_mutate-r125-wiring.mjs`）6/6 + 反向

```
✔ M1 端口不再带出 id（归因键丢了）       → 咬住（红）
✔ M2 ★ 两个来源都读不到时合成全 0        → 咬住（红）
✔ M3 第一手读数被降级（投影优先）        → 咬住（红）
✔ M4 端口抛错时上抛                      → 咬住（红）
✔ M5 投影自己乘一遍费用（第二份算术）    → 咬住（红）
✔ M6 ★ 反向：有用量时也返回 null         → 咬住（红）
还原逐字节相同：✔
```

### 7.3 那处真缺陷

去掉修复的 `yield` ⇒ `⑮` **咬住（红）**；还原 ⇒ 100/100 绿。

---

## 8. 门禁读数

```
runtime/dsh-composition/usage-projection.test.mjs          22/22
runtime/adapters/dsh/adapter.test.mjs                     103/103
runtime/adapters/dsh/parity.test.mjs                       37/37
runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs  51/51
runtime/contracts/contract.test.mjs                        48/48
runtime/contracts/wire.test.mjs                            30/30
runtime/dsh-composition/bootstrap.test.mjs                 23/23
runtime/dsh-composition/e2e-assembly.test.mjs              19/19
runtime/adapters/dsh/session-boundary.test.mjs             33/33
orchestrator/worker/runtime-contract-client.test.mjs       38/38
check-docs / encoding-check（2485 文件）/ spec-progress / progress-check  全 PASS
boundary-facts: PASS（30/30，红 0）
套件清单完备性：未被任何套件执行 = 0（新套件已登记进 run-ci 的 test 阶段）
```

### 8.1 ★ `boundary-facts` 报的那一红，与它暴露的**既有**问题

我第一次跑门禁时 `boundary-facts` 红 1：

```
✖ ledger-line-citations-resolve
  文档说 ""，产物是 "plugins/runtime-host-registrar-row.mjs:834
  （这一行是空的，或只有收尾符——引用指的地方没有内容："}"）"
```

**判据是对的**：我在那个文件里加了 101 行，把台账 `PRT-PROGRESS.md:68` 引用的
`:834` 从有内容推成了一行裸 `}`。已改成真消费者的位置 `:961`。

**但它顺带暴露一件更值钱的事**：`:834` 在**改动前就已经是错的了**——
`e5196f7` 的 `:834` 是 `const pendingIdentities = new Set()`，而那句话说的
"是消费者"（`runFloorOptionOf(options)`）在 HEAD 上位于 **`:891`**。
⇒ 这条引用**早就指错了**，只是那条判据只查"那一行存在且有内容"，
而 `const pendingIdentities = new Set()` 显然"有内容"，于是一直是绿的。

> 一条"那一行有没有内容"的判据，与一条"那一行说的是不是那件事"的判据，
> 在引用**指错了但没指空**的时候是同一个读数——只不过前者是绿的。

**本批没有去加强那条判据**（那要动 `boundary-facts.mjs` 的语义，属另一件事），
只把这一处改对了。**记为遗留项。**

---

## 9. 诚实边界（不许被读成"能自动执行了"）

1. **这不让产品能自动执行。** `adapter.mjs:108` 是"任一必需能力缺失即
   `UNSUPPORTED_CAPABILITY`"，另外两项（`cancel-and-timeout` 的引擎保证、
   `structured-result` 的现场 provider）在真部署里仍是未确认 ⇒ 仍不兼容。
2. **`usage-reporting` 这一格本身也没有变绿。** 变的只是"读得到用量"这件事
   在**代码上**成立了。`probe.mjs` 认的是**实测到的能力**，而现场
   `sessionProjections` 是否存在、投影是否收到事件，要在真 DSH 进程里量一次
   才算数——**本批没有做那次端到端测量**（它需要一个真 Run，而 Windows 上
   不会有自动执行，见 `docs/STATUS.md` §4 第 15 条）。
3. **本批新增的 `runUsage` 是宿主端口的可选方法**，不是契约里的必需项；
   适配器在它缺席时如实退回 `null`。
4. **没有跑真 DSH 进程的端到端用例**：`usage-projection.test.mjs` 验的是
   折叠语义与读取判据，`adapter.test.mjs` 验的是接线，两者**都不**证明
   "真 DSH 的 `sessionProjections` 会在子会话上收到 `assistant/message` 事件"。
   ★ 这是本批最大的一条未验证前提，**明写在此，不假装已验**。
