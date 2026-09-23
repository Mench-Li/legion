# 第 116 轮：`test` 阶段那批红套件 —— 逐条根因与处置

> 基线：`HEAD = 4dc200f`（2026-09-21 16:06），全量 CI 9 阶段实测
> **8 PASS / `test` FAIL**（`.ci-r115-baseline.log`、`.ci/2026-09-21T07-53-36-511Z/`）。
> CI 自己打了告警：它跑在**一棵脏树**上（21 改 + 741 未跟踪），
> 所以读数是"**这棵树**红"，不是"提交 `4dc200f` 红"。
>
> 期间 `HEAD` 前进到 `e5196f7`（16:50，另一个会话提交了能力面裁决「乙」的实施）。
> 本文件**两份读数都记**，并逐条标明它属于哪一次。

## 0. 一句话

**8 个红里 6 个是同一类：观测点没跟着代码搬家。**
PRT-316 把路由与产物逐片搬走之后，几条判据仍在往**旧位置**看——
而它们报的那句话（"接线被拔掉了"/"前端写了不存在的端点"/"生成物不新鲜"）
**读起来完全正确**，所以没有人会去怀疑它。

> 一个「搬家之后观测点塌了」的判据，
> 与一个「缺陷真的存在」的判据，报的是同一句话。

## 1. 逐条

| # | 套件 | 根因 | 处置 |
|---|---|---|---|
| A | `patch-loadable`（9/10） | 生成物 `legion-host.patch.yml` 第 1 行被**手工**多打一个空格，与 `renderPatchYaml()` 不再逐字节相等 | **重新生成**产物；10/10 ✅（判据一字未动） |
| B | `model-config`（17/18） | 断言扫 `team-hub/server.mjs` 找 `validateAgentModelSelection({...})`；PRT-316 把 `/api/models` 搬进 `team-hub/routes/models.mjs` ⇒ **接线没坏，观测点塌了** | 改走新导出的 `routeAssemblySource()`；18/18 ✅ |
| C | `model-api`（14/15） | 断言只从 `server.mjs` 抽路由表（**只剩 2 条**，真路由 186 条在族模块里）⇒ 把 **70 条真实存在**的端点报成"不存在" | 改走新导出的 `platformHttpRoutes()`；15/15 ✅ |
| D | `dsh-composition`（47/48） | **与 A 同一根因**：YAML 被手工改过 ⇒ `--check` 认为"漂移" | A 修好后随之转绿；48/48 ✅ |
| E | 套件清单不完备（34 个） | 34 个 `*.test.mjs` 不被任何套件执行 —— **等于不存在的断言**（实测 **527 例全绿**） | 全部**登记**进 `run-ci.mjs`；527 例现在真的跑 ✅ |
| F1 | `suite-counts`（11/13） | `e5196f7` 给 `contract.test.mjs` 加了 **3 条用例**，而主表那条计数声明没跟着走（45→48、64→67） | 用仓库自己的 `refresh-suite-counts.mjs --write` 跟上；13/13 ✅ |
| F2 | `…-runtime-host-row-dsh-process`（8/10） | 夹具**重复挂载**：C 场景 insert 了组件本体，而真补丁层的 registrar 行 default **就是**同一个对象 ⇒ 两 fiber 都 `provide` 同一服务名 ⇒ cordis 抛 | 加 `disable` 补丁；10/10 ✅ |
| F2 | `…-runtime-host-registrar-dsh-process`（4/6） | **同一个形状**，N 场景 | 同上；6/6 ✅ |
| F3 | `runtime-contract-cross-process`（13/19） | ⏸ **见 §4**：`legion-enforcement-runtime-contract-server` 被判「行已挂载但未激活」，而**同一次运行里 A0 通过**（那一行真的起了监听器） | **未修**，留作裁决 |

## 2. A 与 B/C 的形状差异（值得单独记）

A 与 B/C **看起来是同一种红**（都在 `test` 阶段、都是"产物与代码不一致"），
而**处置方向相反**：

- **A**：`legion-host.patch.yml` **是生成物**，而它被手工改了。
  判据是对的 ⇒ 修**产物**。**没有动判据一个字。**
- **B/C**：断言是对的，而它**看的位置**过期了。产出的代码没坏 ⇒ 修**观测点**。

把这两类搞混的代价是不对称的：

- 把 A 当 B 修（去放宽新鲜度判据）⇒ 一个能被手工编辑的补丁层，
  与一个"改坏了也不报"的补丁层，从此是同一个东西；
- 把 B 当 A 修（去"重新生成"一份源码）⇒ 做不到，因为源码不是生成的。

★ 所以处置前先问**"这两边哪一边是权威"**，而不是"哪一边好改"。

## 3. B/C 的修法为什么不是"把 server.mjs 加回去"

最省事的修法是让断言**同时**读两处（`server.mjs` + 族模块）。
没有那样做，因为那正是这条缺陷的成因：**同一个集合在多个地方各定义一次**。

改用 `scripts/prt/baseline-snapshot.mjs` 新导出的两个**唯一权威**：

| 导出 | 回答的问题 | 消费者 |
|---|---|---|
| `platformHttpRoutes()` | "**有哪些**端点"（`'GET /api/rules'`） | `model-api.test.mjs` ③ |
| `routeAssemblySource()` | "**装配代码在哪**"（源码文本） | `model-config.test.mjs` 接线断言 |

`buildSnapshot()` 也改成调用 `platformHttpRoutes()`（原先它自己拼了一份同样的并集）。
⇒ 从"两处各拼一遍"变成"一处定义、三处消费"。

## 4. 破验（`scripts/probes/_mutate-r116-route-obs.mjs`，可复跑）

修好的判据**必须仍然咬得住真缺陷**——否则这次修的就不是观测点，是把判据改弱了：

| 变异 | 期望 | 实际 |
|---|---|---|
| M1 把 `routes/models.mjs` 的 `throw modelConfigErrorFor(verdict)` 删掉 | `model-config` 红 | ✔ 红（exit 0 → 1） |
| M2 在 `api.ts` 加一个**真的不存在**的端点 | `model-api` ③ 红 | ✔ 红（exit 0 → 1） |

两条**逐字节还原**均成功。M2 尤其要紧：它证明新的取法**不是"永远返回空集合"**
（一个恒空的集合会让 ③ 永远绿，那比红更坏）。

## 5. F2 的形状：一个"模拟上一批"的夹具，与一个"叠加在当前之上"的夹具

F2 那两条红的根因**不是**产品缺陷，是夹具**把同一份插件对象挂了两遍**：

```
真补丁层：legion-enforcement-runtime-host-registrar
          → runtime-host-registrar-row.mjs
          → export default realRuntimeHostRow          ← 就是组件本体（===，业主裁决甲）
夹具：    - insert: { id: "legion-runtime-host", name: "./runtime-host-row.mjs" }  ← 同一份本体
```

两行都 `ctx.provide('legionRuntimeHostBinding')` ⇒ cordis 当场抛
`service "legionRuntimeHostBinding" has been registered`。

> 一个"模拟上一批补丁层"的场景，与一个"把上一批的行叠在当前补丁层之上"的场景，
> 在只写一个 `insert` 的时候是同一个东西——只不过后者的红
> 读起来像是"注册方没生效"。

修法是**加一条 `disabled: true`**（正是那两个场景声称要模拟的取值），
**不是**改期望。修完之后 N 与 R、C 与 A/B 的差别仍然只有**一个变量**。

★ 这一条与 §2 那条纪律是同一个：**先问哪一边是权威**。
夹具声称模拟"没人注册工厂"，而它自己把注册方挂上了 ⇒ 权威是那个声称，修夹具。

## 6. 诚实边界

- **A–F2 修的是判据的保质期，不是产品行为。** 没有一条改变了产品跑起来的样子；
  CI 的红少了 7 个，而"产品现在能不能自动执行"这个读数**一个都没变**。
- **E 是唯一一条"从无到有"的**：527 例断言此前**从未被执行**。
  它们全绿，所以它不改变产品行为，但它把一份**可执行的证据**从"声明"变回了"证据"。
- **A 的根因只量到"手工改过"**，没量到**是谁**改的（`git log -S` 无命中 ⇒
  它一直是脏树里的改动，从未提交）。所以这是一条**未提交在制品**被 CI 抓到。
- **F3 没修**，理由见 §7 —— 它可能是一个真缺陷，而修它要动 `root.mjs` 的观测时机。
- 本轮**没有**碰 `product/config-schema.mjs` 那一组在制品（见 §8）。

## 7. F3 为什么不修（`runtime-contract-cross-process` 13/19）

**读数本身是矛盾的**，而矛盾指向的不是产品：

| 同一次运行 | 结果 | 说明 |
|---|---|---|
| `A0. Runtime 进程里那一行**真的**起了监听器（端口从服务值读回）` | ✔ PASS | 契约服务端那一行**确实**跑起来了 |
| `A0b. 那一行把**实际绑定**的临时端口发布到了 DataDir 下（真进程、真文件）` | ✔ PASS | 它连文件都写出来了 |
| `A1. 强制面结论跨进程读回来` | ✖ FAIL | 自检说 `legion-enforcement-runtime-contract-server: 行已挂载但未激活（等待依赖服务）` |

⇒ **同一行，同一次运行**：它起了监听器、写了端口发布文件，而自检说它"未激活"。

这与 WIP 刚在 `runtime-host-row.mjs` 修掉的那条**是同一个形状**
（自指观测：执行 `apply` 的 fiber 在 `apply` 返回前不是 `state === 2`），
只是那一次修的是"读自己"，这一次是"读兄弟"——而 `settleEnforcementMount()`
等的是**组合根的挂载账**（`pre-execute` / `approval-answerer` 那两行），
**不覆盖** loader 条目那一族的 `apply` 是否 settle 完。

**不修的理由有两条，都不是"没时间"**：

1. **它要动的是观测时机**（`root.mjs` / `observeComposition` 的调用点），
   而那正是 WIP 正在改的那个文件。两个会话同时改同一条缝 ⇒ 谁的读数都不可信。
2. **我量不出"哪一边是权威"**。有三种可能，而它们要求**相反**的修法：
   - 竞速（观察早于兄弟行 settle）⇒ 修观测时机，**判据不动**；
   - 契约行真的没激活（例如它 `await` 了某件永不到来的事）⇒ **产品缺陷**，修产品；
   - 那一行**本来就不该进"强制面是否生效"的判定**（它是"出口"，文件里逐字写着
     「本行**不是**强制面」）⇒ 修的是**进入判定的行集合**，不是时机。

   §2 的纪律在这里正好用得上：**先问哪一边是权威**。而今天我读不出答案 ——
   第 3 种尤其要紧：一个被文档写明"不是强制面"的行，若在"强制面是否生效"里
   一票否决，那它每次抖动都会让 `autoExecutionForbidden` 变 true。

★ 按 PRT-253 §3，**不猜**。所以本条连同它的三种可能一起进最终报告，
不进"已修"清单。

## 8. CI 读数对比（同一个 `test` 阶段，两次全量）

| | 基线 `4dc200f` | 本轮（脏树，`head=e5196f7`） |
|---|---|---|
| 阶段 | **8/9 PASS** | **8/9 PASS** |
| `test` 阶段红套件 | **8** | **2** |
| 红套件 | patch-loadable · dsh-composition · runtime-host-row-dsh-process · runtime-host-registrar-dsh-process · runtime-contract-cross-process · model-config · model-api · **套件清单不完备(34)** | runtime-contract-cross-process · ~~dsh-checkout~~ |
| 被执行的断言数 | — | **+527**（此前 34 个文件从不执行） |

★ `dsh-checkout` 那一条**不是回归**：它⑮ 的判据**要求 `$DSH_CHECKOUT` 未设**
（它测的是"没设也能解析到检出"那条候选路径）。本轮 CI 是我自己在 shell 里
导出了 `DSH_CHECKOUT` 才让它红的 —— **我自己造的环境产物**，
未导出时 20/20。这也说明那条判据**问对了**：它把"靠环境变量救回来的"
与"靠候选路径算出来的"分开了。

