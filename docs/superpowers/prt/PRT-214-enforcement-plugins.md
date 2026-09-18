# PRT-214（续）：enforcement 插件模块——hard-floor 真的挂上了

> 上一批（`PRT-214-patch-layer-format.md`）修的是**格式**：一份以前根本读不了的文件，
> 现在能被 DSH 的真解析器读。
>
> 这一批把**第一行真的插进去**：`legion-enforcement-hard-floor` 有了模块本体，
> 并被真运行时验证了 10 条判据。

---

## 1. 三条实测契约（不是读代码猜的）

### ① `tools.guard` 真的是**单调**的

DSH `packages/core/tools/src/index.ts:1090` 的原文：

    Register a **monotonic** guard after the extensible `tools/pre-execute` waterfall.
    … Any matching guard may deny by returning a reason,
    while **no guard can force-allow a call another guard denied**.

这正好是 spec §6.8 对下限的要求，也是 `patch-layer.mjs` 早就写下的
"guard 只有降级语义、没有 allow 语义"的**实现依据**。

实测验证：注册一个返回 `{ kind: 'allow' }` 的 `tools/pre-execute`（它跑在 guard **之前**），
guard 照样拦下，工具一次都没执行。

### ② `patch-over` **不能**换模块

实现（`cordis-plugin-include/lib/index.js:69`）：

```js
const { id, insert, name, ...overrides } = patch   // ← name 被单独解构走
if (name && name !== target.name) { warn('name mismatch…'); continue }
for (const [key, value] of Object.entries(overrides)) target[key] = value
```

`name` **只在守卫那一行出现**，永远进不了 `target`。实测三种形状：

| 补丁 | 结果 |
| --- | --- |
| `{ id:'approval', name:'file:///legion/x.mjs' }` | warn `name mismatch`，名字**原封不动** |
| `{ id:'approval', name:'<原模块名>', config:{…} }` | config 被替换，名字不变（正常） |
| `{ id:'approval', config:{…} }` | 同上（正常） |

> 一个"以为 patch-over 能替换模块"的声明，
> 与一个"模块永远不会被加载、而文件里写着它"的补丁层，是同一个东西。

**要替换某行的实现，只能 `disabled: true` 关掉旧行 + 根级插入新行。**
（若两条都提供同名服务而不 disable，是**服务注册冲突**，会响亮地抛——
`service "approval" has been registered at <root>`。这次"响亮"是好事。）

### ③ Cordis 不允许不声明 `inject` 就按属性访问服务

我第一版**故意没写** `inject: ['tools']`，理由是"想自己在 `apply` 里检查端口，
免得因为等待而未激活"。理由本身是对的，**结论反了**：

```
cannot get property "tools" without inject
```

那一版在真运行时下**一行都挂不上**。正确做法是声明式地表达依赖：

> 一个"自己偷偷检查端口、于是永远不进 waiting"的插件，
> 与一个"正确声明了依赖、等待被如实记录"的插件，在坏接线时是同一个东西——
> 只不过前者的失败发生在运行时，而没有任何审计会报它。

而 waiting 恰恰是**要被报出来**的东西：DSH 的挂载审计会打
`N row(s) did not activate`，那正是 `reconcilePatchLayer()` 的
`ROW_NOT_ACTIVATED` 判据在读的读数。

---

## 2. 交付

### `plugins/hard-floor.mjs`（新增）

`legion-enforcement-hard-floor` 的插件本体。它做四件事：

1. `inject: ['tools']` —— 声明式依赖。
2. 检查 `ctx.tools.guard` **形状**对（服务存在 ≠ 长得像 ToolRuntime）。
3. 判定逻辑**不复制**：直接用 `enforcement.mjs` 的 `createHardFloorGuard`，
   与 `composePreExecuteFloor` 是**同一个调用结果**。
4. 把 `ctx.tools.guard()` 的 disposer **交给本行自己的 effect 作用域**。

第 3 点的理由：

> 两份"同一个下限"的实现，
> 与一个"下限会在 pre-execute 与 guard 之间漂移"的实现，是同一个东西——
> 而漂移的那一天只表现为"这次怎么被拒了"。

第 4 点的理由：`guard()` 内部是 `this.layers.effect(this.ctx, …)`——
它挂的是 **ToolRuntime 的** fiber，不是本插件的。不接管就变成"卸载了还在拦"。

### `enforcement-plugin.test.mjs`（新增，10 例）

**对着真 cordis Context + 真 ToolRuntime**，不用替身。10/10 绿。

> 一个用替身喂出来的"强制面已生效"，
> 与一个从没被真运行时拦下过的"强制面已生效"，是同一个东西——
> 只不过前者的用例数是完整的。

覆盖：guard 单调性、deny 真的短路执行（执行次数 = 0，而不只是 `isError`）、
未被禁的工具**照常执行**（下限不能变成全禁）、路径下限、
**卸载后 guard 真的消失**、服务形状不对时抛、缺少服务时**等待而非抛**、
观测点只观测不参与判定。

### `legion-host.patch.yml`

```yaml
- insert:
    - id: "legion-enforcement-hard-floor"
      name: "./plugins/hard-floor.mjs"
- id: "permission"
  config:
    presets: { … }
```

`./` 相对路径由 DSH 的 `anchorInsertedPluginNames` 按
`dirname(patchFile)` 解析成 file:// URL（`app-boot/src/index.ts:326`），
所以补丁层连同 `plugins/` 一起搬走仍然有效。

> 一个"写成机器绝对路径"的模块引用，
> 与一个"换台机器就加载不到"的补丁层，是同一个东西——
> 只不过前者在作者自己的机器上跑得通。

---

## 3. ★ 本批抓到的三个"我自己的错"

### 3.1 `renderedRowIds` 一直在读错东西

它原来是 `built.document.map((d) => d.id)`。但：

- insert 行嵌在 `insert: [...]` 里 → 顶层 `d.id` 是 `undefined`
- patch-over 项顶层的 `id` 是**被覆盖的目标**（`permission`），不是 Legion 行 id

于是清单里躺着 `[undefined, 'permission']`，而**计数恰好是 2**，与"真有两行"对得上。

> 一个"把顶层项的 id 当成行 id"的读数，
> 与一个"从来不报告哪些行进去了"的读数，在计数恰好相等时是同一个东西——
> 只不过前者会在行数对得上时假装自己是证据。

这条是我本批新写的断言（"有模块的行必须真的进文档"）抓出来的。
**它之所以能抓到，是因为它把 `renderedRowIds` 与 `PATCH_LAYER_ROWS` 对了一遍，
而不是只看计数。** 已改为由构造器给出 `built.rendered`。

### 3.2 把"缺 3 行"写死的断言会腐烂

两条断言把三行清单写死了。hard-floor 一拿到模块，它们就对着
"现在只缺 2 行"报红——**红的是一个已经变好的事实**。

写死清单的断言会随着进展变成噪声，而噪声会被改掉，
改掉的那一次很可能顺手把判据本身也改掉。已改成从 `PATCH_LAYER_ROWS` 推导。

### 3.3 "触发了但没记账" = "触发不了"

覆盖度检查报 `PATCH_OVER_WITH_MODULE` 是死代码——而它**刚刚才在同一个函数里
触发过**，只是触发了没写进 `checked`。

> 一个"触发了但没被记账"的判据，
> 与一个"根本触发不了"的判据，在覆盖度读数上是同一个东西。

---

## 4. ★ 过程修复：第 7 道门禁 `scripts/ci/ci-syntax.mjs`

"插入新块吃掉下一个块的 `{`"这个事故本轮**第四次**发生。每次的表现完全一样：
六道门禁全绿，只有 `node --check`（靠纪律手动跑）能抓到。

原因是**结构性**的：

> 一个"改坏了 CI 运行器、而门禁全绿"的提交，
> 与一个"改坏了 CI 运行器、并且被拦下"的提交，在门禁日志上长得一模一样。

`run-ci.mjs` 是**跑门禁的那个程序**。六道门禁都由它调用，所以它坏掉时，
没有任何一道会响——它们只会**不被执行**。而"没被执行"与"通过了"，
在外观上都是"没有 FAIL 行"。

新增 `ci-syntax.mjs`：对 `scripts/**/*.mjs`（**50 个**）逐个跑 `node --check`。
零第三方依赖，**不执行**被测对象（`node --check` 只解析）。

它作为 CI 的 **syntax 阶段排在最前**。

**它的局限写在它自己的注释里**，因为它是一道容易自我感觉良好的门禁：

> 一个"跑在它要守的那个程序里面"的门禁，
> 与一个"根本没在守那个程序"的门禁，在被守对象坏掉的那一天是同一个东西。

它守得住别的 49 个脚本，**守不住 `run-ci.mjs` 自己**——那个文件坏掉时
这个阶段根本不会被启动。所以它必须被**单独**跑一次。

**已断验证**：

```
埋 scripts/_syntax-probe.mjs（坏语法）
  → FAIL: scripts/_syntax-probe.mjs — …:2 — SyntaxError: Unexpected identifier 'b'
  → ci-syntax: FAIL（1/51 个脚本无法被 Node 解析）      exit 1
删掉
  → ci-syntax: PASS（50 个脚本全部可被 Node 解析）    exit 0
```

---

## 5. 验证

- `enforcement-plugin` **10/10**（真 DSH 运行时）
- `patch-loadable` **10/10**（真 js-yaml + 真 `applyEntryPatches`，base 84 行 → Legion 层 0 警告）
- `patch-format` **19/19**、`dsh-composition` **34/34**
- 七道门禁全 PASS（原六道 + 新增 `ci-syntax`）
- 全量 CI **9 个阶段全 PASS**，`test` **165 套件 / 4469 用例 / 0 fail**（`.ci/prt-214b/`）

---

## 6. ⚠️ 诚实边界：**PRT-214 仍是 🟡**

> ⚠️ **2026-09-18 注**：本任务**现已 ✅**（见 `docs/superpowers/prt/PRT-PROGRESS.md` 的状态列）。上面这段是该批次结束时的口径，**原文保留**——*一个"当时写对了"的边界说明，与一个"现在仍然成立"的边界说明，读起来是同一句话。*

强制面四行，现在**两行生效**：

| 行 | 状态 |
| --- | --- |
| `legion-enforcement-hard-floor` | ✅ 有模块、已进补丁层、真运行时 10 例全绿 |
| `legion-enforcement-permission-presets` | ✅ patch-over，已生效 |
| `legion-enforcement-pre-execute` | ⬜ `module: null` |
| `legion-enforcement-approval-answerer` | ⬜ `module: null` |

- `reconcilePatchLayer()` 仍报两条 `ROW_MISSING`，启动自检仍然**拒绝注册**（fail closed，有意为之）。
- 补丁层**仍未真的被注入过任何 profile**。本批验证的是"这一行能被真运行时加载并生效"，
  用的是用例里现搭的 Context，**不是**"某个 profile 已经加载了它"。
- **员工 agent preset 那一半尚未开始**（`EMPLOYEE_PRESET_CONTRACT` 还是纯声明）。

### 下一步的可行路径（已探明）

`pre-execute` 与 `approval-answerer` 两行所需的缝合点都已验证存在：

- `ctx.on('tools/pre-execute', …)` —— 瀑布，返回 `{kind:'allow'|'deny'|'ask'}`
- `ctx.get('approval').request({agent, toolName, callId, reason, signal})`
  → `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`

后者与 Legion `APPROVAL_OUTCOMES` 的四个值**逐字相同**，
且 DSH 自己的 `serviceAsk` 就把 `ask` 映射到这四个结局——所以
`approval-answerer` 不需要翻译层，只需要把 `createApprovalAnswerer`（PRT-212 已有）
接到 `ctx.provide('approval', …)` 上。

**而接管 `approval` 服务必须用 §1② 的形状**：DSH 的 base bundle 里已经有一行
提供 `approval`，所以 Legion 那一行必须**同时** `disabled: true` 掉 base 的那一行，
否则是服务注册冲突。

> ⚠️ **上面这段结论是错的，已在下一批更正。** 读了 DSH 源码才发现：
> `ApprovalService` 是**策略 + 审计层**，判定委托给 `approval/request` **answerer 链**。
> Legion 该做的是 `ctx.on('approval/request', …)` **加入那条链**，不是接管服务——
> 于是根本**没有**服务注册冲突，base 那一行完全不用动。
> 详见 `PRT-214-approval-answerer.md`。
>
> 这条错误值得留着而不是删掉：它当时**读起来完全合理**——
> "要换掉一个能力就得先关掉旧的"在有服务注册冲突时是对的，
> 而我是在**还没读那个服务的源码之前**就把它写成了结论。

