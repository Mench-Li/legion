# PRT-214（四）：pre-execute —— 强制面第一次**真的**连起来

> 前三批各自把半边做绿了，但那条链**从未接上过**。本批把它接通，
> 并在真 DSH `ToolRuntime` 里跑完了全链路。同时更正了上一批留下的
> 一句**错误的因果**。

---

## 1. 交付

| 文件 | 内容 |
| --- | --- |
| `runtime/dsh-composition/plugins/pre-execute.mjs` | 新增：`ctx.on('tools/pre-execute')` 的策略门本体 |
| `runtime/dsh-composition/assemble.mjs` | 新增：**装配路径**（此前"没定下来"的那一条） |
| `runtime/dsh-composition/pre-execute.test.mjs` | 新增：**17 例**，真 `ToolRuntime` + 全链路集成 |

### 1.1 `pre-execute` 插件

判定逻辑**一行都不在这里**——它就是 `tool-request.mjs` 的
`createEnforcementBridge({...}).preExecute`（投影、路径范围、岗位白名单、
策略端口、禁止改写参数全在那一处，且那条桥已有一整套用例）。
本文件只做三件事：绑定、**认领策略**、把投影放进在飞登记簿。

### 1.2 ★★ 认领策略：`allow` 必须**让路**

瀑布的语义是"谁先返回非 `next()`，谁就认领这次调用"。于是 `allow` 有两种写法：

```js
return { kind: 'allow' }   // 认领并放行 —— 后面的 listener 再也说不出话
return next()              // 不认领 —— 后面的 listener 照样可以拒绝
```

本行取**后者**：

> 一个"自己就把 allow 定案了"的强制面，
> 与一个"把后面的门全部关掉"的强制面，是同一个东西——
> 只不过前者把自己说成是"放行"，而它实际干的是"**闭嘴**"。

这与 hard floor 那条"guard 只有降级语义、没有 allow 语义"是同一条原则的另一面：
**强制面永远不该成为某个东西被允许的原因**。而 `deny` / `ask` 必须认领——
那是我们真的有话要说。

### 1.3 ★ 为什么 ask 时要把投影留下

DSH 把 `ask` 交给审批服务时只递五个字段（`tools/src/index.ts:1696`），
**没有 arguments**。而 team-hub 的权限检查要靠参数算绑定哈希。
所以本行（唯一拿得到完整 `exec` 的角色）必须把投影留下：

```
pre-execute 行 ──put(callId, 投影)──▶ 在飞登记簿 ◀──peek(callId)── answerer 行
```

### 1.4 装配路径（`assemble.mjs`）

`PatchOptions.config` 是**数据**，装不下函数；而 pre-execute 需要一条桥
（含 Legion 身份、策略端口、岗位白名单），answerer 需要一个接在 team-hub 上的端口。
所以两行都**刻意不导出 default**，由装配方造**一次**桥、备**一份**登记簿，
再把两行挂上去：

```js
const asm = assembleEnforcement({ context, decide, requestApproval })
await asm.mount(ctx)     // → 两行都挂上，且共享同一份投影与同一本账
await asm.dispose()      // → 两行都拆掉
```

**一份桥**是"三个强制点共用同一份投影"这句承诺能够成立的前提：

> 一个"三个强制点各自造一次桥"的装配，
> 与一个"三个强制点看到三个不同目标"的装配，是同一个东西——
> 只不过前者在只有一个强制点被触发时看起来是对的。

端口**一律不给默认值**：默认放行是静默降级，默认拒绝是静默停摆，两者都不报错。
hub 地址 / scope / actor 的权威来源也还没定（见 PRT-505 那条未决问题），
所以装配方**不替部署猜**。

---

## 2. ★ 全链路第一次跑通

```
tools/pre-execute 行 ──put──▶ 在飞登记簿 ──peek──▶ answerer 行
                                                        │
                       真 DSH ask → ApprovalService → 瀑布 ◀┘
```

`★★★★★★` 用例在**真 `ToolRuntime`** 里跑完整条链：

| 审批箱说 | 工具执行 | 断言 |
| --- | --- | --- |
| `allowed-once` | ✅ 执行了 | `st.ran === 1`，且审批箱**被问过 1 次** |
| `rejected` | ❌ 一次都没执行 | `st.ran === 0`，`isError === true` |
| 抛错（hub 连不上） | ❌ 不执行 | 结局是 `unavailable`（**故障**）而非 `rejected`（**决定**） |

> 一个"两个半边各自全绿"的实现，
> 与一个"两个半边能接上"的实现，在各自的用例里是同一个东西——
> 只不过前者的失败发生在**生产**里。

---

## 3. ★ 三条实测抓出来的真问题

本套件不是一次写绿的。四次失败里有三条是**真发现**，值得逐条记下。

### 3.1 `ask` 需要 `exec.agent`，否则 DSH 直接拒绝

`ToolRuntime.serviceAsk`（`tools/src/index.ts:1690`）：

```js
if (exec.agent === undefined) {
  return { decision: { kind: 'deny',
    reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` } }
}
```

没有 agent 就没有 session 记审计、没有 UI 可路由，所以 DSH fail closed。
**这是 DSH 的行为，不是 Legion 的**——但它意味着 Legion 的 `ask` 只在
有 agent 的调用上成立（生产里就是 agent 循环发起的那些）。

第一版用例没带 `agent`，于是**每一个全链路用例都没通过审批**，
而失败理由看起来像"两个半边没接上"——一个会把人引向错误方向的读数。

### 3.2 ★ 我写的审批替身把 answerer 链**整条短路**了

第一版替身**直接返回结局**：

```js
ctx.provide('approval', { async request() { return 'allowed-once' } })   // ❌
```

于是 `answerer` 那一行**一次都没被调用过**，而全链路用例"通过"了
（替身说放行，工具就跑了）。直到有一条用例断言"审批箱被问过几次"，
那个 **0** 才把它暴露出来。

> 一个"直接回答"的审批替身，
> 与一个"把 answerer 链整条短路掉"的替身，是同一个东西——
> 只不过前者让全链路用例**看起来**是绿的。

修法：替身必须复刻 `ApprovalService.decide()` 的两步
（`user-approval/src/index.ts:260-285`）——`'never'` 在**派发之前**短路，
否则 `ctx.waterfall('approval/request', req, () => 'unavailable')`。

**顺带钉住一件产品事实**：`policy === 'never'`（无人值守 preset）时，
**Legion 的审批箱永远不会被咨询**。新增一条 `★★★★` 用例断言
`portCalls === 0`——而补丁层的 `legion-unattended` 用的正是 `approval: never`。

### 3.3 ★ 我那句"装载顺序有讲究"是**错误的因果**

`assembleEnforcement().mount()` 第一版注释写着：反序装载会在两次 `await`
之间漏掉询问。断验证把顺序倒过来——**全部 16 条用例照样绿**。

因为两次 `ctx.plugin` 都 `await` 到底，**根本没有窗口**。

> 一个"顺序无关、却被写成顺序有关"的注释，
> 与一个"顺序真的有关"的实现，在断验证面前是同一个东西——
> 只不过前者会让下一个人去守一条**不存在的约束**。

已把那句因果删掉，换成一条**可测**的性质（新增 `★★★★★` 用例）：

> 一个"没人能批准就不执行"的强制面，
> 与一个"没人能批准就默默放行"的强制面，在审批箱空着的部署里是同一个东西——
> 只不过后者在**审批箱坏掉那天**才开始放行。

用例：**故意不挂 answerer**，只挂 producer；策略说 `ask`，审批端口甚至
"愿意"说 `allowed-once` —— 但没人接链。断言工具**不执行**（fail closed）。

### 3.4 第四处：那段"ask 却投影不出来"的守卫在真桥下够不着

`createEnforcementBridge` 的 `decide` 包装在 `projectionFor` 失败时**已经返回 `deny`**，
所以走到插件里的 `ask` 必然带着一条投影成功的调用。这与上一批那层"闭集兜底"
是同一个毛病。**没有删掉**它，而是把它当**契约守卫**对待，并用一条
**故意违约的假桥**去测——那样它才是活代码：

> 一个"ask 却没留下投影"的 pre-execute 行，
> 与一个"审批永远问不到人、于是永远不生效"的强制面，是同一个东西——
> 只不过前者不会报错，它只会**静默地不再拦任何东西**。

配套用例断言**真桥**下拒绝理由来自桥（不含本行那句补充），
这样"守卫够不着"这个前提本身也被钉住了。

---

## 4. 断验证（6/6，逐字节还原）

| 探针 | 弄坏什么 | 结果 |
| --- | --- | --- |
| ① | `allow` 改成**认领**（`next()` → `{kind:'allow'}`） | ✅ 红 |
| ② | `ask` 时不写登记簿（两个半边断链） | ✅ 红（4 条） |
| ③ | `deny` 改成 `allow`（策略门失去拒绝能力） | ✅ 红（10 条） |
| ④ | 装配 `dispose` 只弹出、不卸载 | ✅ 红 |
| ⑤ | 装配时缺 `decide` 不抛（默认永远放行） | ✅ 红 |
| ⑥ | 忠实替身退回"直接回答"（短路 answerer 链） | ✅ 红（4 条） |

探针④原本是"把装载顺序倒过来"——**它没红**，而那是本批最值钱的发现之一
（见 §3.3）。探针随实现一起换掉了。

---

## 5. 验证

`pre-execute` **17/17**；七道门禁全 PASS；全量 CI **9 阶段全 PASS**，
`test` **167 套件 / 4503 用例 / 0 fail**（`.ci/prt-214d/`）。

---

## 6. 行的状态

| 行 | 状态 |
| --- | --- |
| `legion-enforcement-hard-floor` | ✅ 有模块、已进补丁层、真运行时 10 例全绿 |
| `legion-enforcement-permission-presets` | ✅ patch-over，已生效 |
| `legion-enforcement-pre-execute` | ✅ **实现完成、全链路已通**（17 例）；刻意无 default，由 `assemble.mjs` 挂载 |
| `legion-enforcement-approval-answerer` | ✅ **实现完成、全链路已通**（17 例）；刻意无 default，由 `assemble.mjs` 挂载 |

**四行实现全部完成。** 但 PRT-214 仍是 🟡，原因**不在实现**：

> ⚠️ **2026-09-18 注**：本任务**现已 ✅**（见 `docs/superpowers/prt/PRT-PROGRESS.md` 的状态列）。上面这段是该批次结束时的口径，**原文保留**——*一个"当时写对了"的边界说明，与一个"现在仍然成立"的边界说明，读起来是同一句话。*

1. `PATCH_LAYER_ROWS` 里那两行仍是 `module: null`，`reconcilePatchLayer()`
   仍报两条 `ROW_MISSING`，启动自检仍拒绝注册（fail closed）。
   这是**刻意**的——那两行需要函数，YAML 装不下。
2. 补丁层**仍未真的被注入过任何 profile**；`patchReload: 'live'` 意味着
   一次写入会立刻改变运行中的强制面，所以写入仍然留在 CLI 的显式 `--write` 后面。
3. 装配好的强制面**还没有任何生产调用方**——`assembleEnforcement()` 目前只有
   用例在调。真正把它接进 agent 循环是 PRT-4xx 那一批的事。
4. 员工 agent preset 那一半尚未开始。

> **实现完成**与**已经生效**，在"没有任何生产调用方"的时候是同一个东西——
> 只不过前者会让 STATUS 上那一行看起来该变绿了。
