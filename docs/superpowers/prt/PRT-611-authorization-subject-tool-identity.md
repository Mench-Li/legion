# PRT-611 补记：F-02 授权主体缺 `toolName` / `callId`（含接线半边）

**spec**：line 470（「授权主体包含 `scope`、`actor`、`action`、`target`、`taskId`、
`toolName`、`callId` 和不可变工具参数」）
**状态**：✅ 引擎半边与接线半边都已交付
**起因**：PRT-612 期间被一条**写错的探针**顺带量出来的（见 §1）
**证据**：`.ci/prt-611gap/`

---

## 1 这个洞是怎么被发现的

不是被代码审查发现的，也不是被某条断言发现的。是在 PRT-612 里写一条跨层用例时，
顺手把 `normalizeOperation` 的产出打出来，发现 `toolName` 不在里面。

当时的实测（可复现）：

```
operationFingerprint({scope:'legion',actor:'general',action:'file:write',
                      target:'repo/notes.md',taskId:'task-1', toolName:'file_write'})
=== operationFingerprint({...同一份,                                 toolName:'file_delete'})
→ sha256:69969e4709253a5a06cb2de33f2e5e15895e756da187ed6b02333a42974bf2da   （两边相同）
```

而 `team-hub/approval-binding.mjs` 的 `bindingHash` **就是这个指纹**。所以：

> **一次"写文件"的批准，可以被一次"删文件"消费。**

这与 PRT-613 在工具参数那一侧修掉的是**同一个形状**——那一批的名言是
"只哈希了 args，于是 `file_write` 与 `file_delete` 得到同一个身份"。
PRT-613 的文档里写过一句"F-02 侧主体里本来就有 `toolName`（`CANONICAL_OP_KEYS`）"，
**那句话只对 DSH 侧的常量成立，对 Legion 侧的 `OPERATION_KEYS` 不成立**。

> 一个「在 A 侧修好了工具身份、并在文档里说'B 侧本来就有'」的修复，
> 与一个「B 侧从来没有过那个字段」的修复，是同一个东西——
> 只不过前者读起来像已经覆盖过了。

---

## 2 引擎半边：三个字段进授权主体

`team-hub/permission-engine.mjs`：

| 改动 | 说明 |
| --- | --- |
| `OPERATION_KEYS` | 追加 `'toolName'`、`'callId'`、`'argsHash'`（既有 7 键顺序不变） |
| `normalizeOperation` | 三个字段按 `taskId` 同一套纪律（缺席/空白 → `null`，否则 trim）；**不**进 `REQUIRED` |
| `canonicalOperation` | 三处 `nfc`，与其它字符串字段一致 |
| `argsHashOf({toolName,args})` | 「不可变工具参数」的载体。**只搬运**，不重算 |
| `TOOL_SUBJECT_KEYS` | 三个键的**唯一**名单，导出给桥与测试共用 |
| `MUTATION_BASE` / `FIELD_MUTATIONS` | 各补三个非默认值，让 PRT-609 的逐字段自检覆盖它们 |

**参数身份不在这里算**：它归 PRT-613 的 `hashToolArguments` 所有。本模块只 import
并搬运它的结果。理由与 PRT-613 那次相同——两处各算一遍参数身份，迟早不一样。

> 一个「在授权主体里自己再算一遍参数哈希」的实现，
> 与一个「两处对'同一个参数'的判断迟早不一样」的实现，是同一个东西。

`normalizeOperation` **必须**保留"只给一个工具字段"的能力：PRT-609 的逐字段变异自检
就是靠"从一枚全 `null` 的基准只改一个字段"来工作的。

> ⚠️ 我在这里**先写了一个错的东西**：加了一条"工具主体要么整套齐、要么整套不填"
> 的守卫。它当场打红了 6 个既有用例（`field-invalidation` 的变异基准、
> `enforcement-mapping-binding` §④）。
>
> 那次红是**对的**：那个守卫把一条**生产者**才该承担的义务塞进了一个纯规范化函数，
> 并且直接与仓库既有的逐字段变异方法论冲突。
>
>   > 一个「在纯函数里拒绝半成品」的守卫，
>   > 与一个「把调用方唯一一种正确的用法打红」的守卫，是同一个东西——
>   > 只不过它在代码审查里看起来更严格。
>
> 正解是**把义务放回生产者**：桥（§3）那里有真实的、非测试的输入形状，
> 可以合理地要求"齐或不填"。守卫已撤，引擎侧恢复"三个都是可选字段"。

### 2.1 ★ `OPERATION_SCHEMA_VERSION` 1 → 2

子代理交付时**特意没动**版本号并把它列为待复核项。复核结论是**必须递增**：
`runtime/dsh-composition/enforcement.mjs:39` 写着一句明确的既有纪律——
「改变 canonical 形式**必须**递增它」，而加三个键就是改变 canonical 形式。

递增的代价是**零**，这一点值得写下来，因为"要不要动版本号"通常会被当成一个有风险
的取舍然后拖着不动：

- 加字段本身就已经改变了哈希（新键进了 canonical JSON），所以在途审批
  **无论递不递增都会失效**，方向是 fail-closed（重新批准），不是放行；
- 这个常量**没有被持久化、也没有被跨版本比较过**（全仓只有 `operationFingerprint`
  一处消费它），所以递增不会让任何历史行变得无法解释。

反过来说，不递增会让两个**不同的** canonical 形式共用同一个版本号：

> 一个「改了 canonical 形式却不动版本号」的实现，
> 与一个「版本号已经回答不了'这行哈希是按哪种形式算的'」的实现，
> 是同一个东西——只不过前者在代码审查里看起来是"改动最小"的那一个。

---

## 3 接线半边：`team-hub/tool-request-bridge.mjs`

引擎变严了，而**送进来的东西仍然不含工具主体**。所以这一半比引擎那一半更要紧：

> 一个「引擎已经把工具名算进授权主体」的修复，
> 与一个「送进来的主体里从来没有工具名」的修复，是同一个东西——
> 只不过前者的用例是绿的：引擎确实绑了，只是从来没人给它绑的东西。

`runtime/dsh-composition/tool-request.mjs` 的投影里**本来就有**
`toolName`(344)、`callId`(345)、`frozenBody.canonicalHash`(348)。缺的就是那个
把它们搬进 F-02 主体的函数。桥只能建在 `team-hub/` 这一侧：`team-hub/` →
`runtime/dsh-composition/` 是既有分层方向（`tool-call-log.mjs`、
`permission-engine.mjs` 都已这样 import），反向实测 **0 处**。

`legionOperationOf(projection, caller)` 造出完整的 F-02 操作，并留下
**逐字段的来源**（`evidence.keysFrom`）而不是一个 `ok` 布尔。

### 3.1 ★ `FROZEN_HASH_DRIFT`：本批最值钱的一条检查

投影**自带**一个哈希、同时自带一份参数。两者对不上时**抛**。

没有这条检查时，一张"参数被换过、哈希还是老的"的投影会安静地通过，
而**每一个单独的哈希比对都是绿的**——因为绑的是一份没人执行过的参数。
这正是 PRT-613 记下的最坏形状。

> 一个「携带的哈希与它携带的参数对不上、却照样被绑定」的授权主体，
> 与一个「绑定的是一份没人执行过的参数」的授权主体，是同一个东西——
> 只不过前者在每一个单独的哈希比对里都是通过的。

**这条检查在写用例时当场拦住了我自己的夹具。** 我写
`build({ arguments: {path:'repo/other.txt'} })` 想把参数换掉，忘了同步
`frozenHash`，于是用例红了。那次红是对的：一张自相矛盾的投影本来就不该被搬运。
处置是给测试加一个 `coherent()` 助手（改参数时同步重算哈希）——而不是把检查关掉：

> 一个「用一张现实里不存在的输入去问一个问题」的用例，
> 与一个「问到了别的问题」的用例，是同一个东西——
> 只不过前者红的时候，看起来像是被测代码错了。

### 3.2 缺字段是**拒绝**，不是降级

`callId` 缺失、`toolName` 为空、投影不是对象、参数哈希漂移 → 一律按码抛出。

`callId` 那一条尤其要说：DSH 的 `allowed-once` 是按 `callId` 的一次性授权（spec §6.8），
缺了它就只能退化成"这个工具以后都能用"——那是一次**放行**方向的退化。

### 3.3 `SUBJECT_INCOMPLETE` 一开始是"从不执行的检查"

桥自己造的主体**不可能**缺字段（三个都从投影算出来），所以那条完整性检查
内联时一次都不会触发。

> 一个永远不会触发的复核，与没有复核，
> 在「它到底拦不拦得住」上是同一个东西。

处置：把它**导出**为 `assertToolSubjectComplete`（与 PRT-609 导出
`assertMutationNotNoop` 是同一次处置），并让装载期自检**真的喂一个缺字段的主体**
把它打出来。于是 `checkedRefusals` 里是**四条**被真的触发过的码，而不是三条 + 一句注释。

它真正的价值在**未来**：往 `TOOL_SUBJECT_KEYS` 加第四个字段而忘了在桥里填，
装载期自检会当场崩，而不是让那个维度安静地不参与绑定。

---

## 4 验证

| 项 | 结果 |
| --- | --- |
| `team-hub/tool-request-bridge.test.mjs` | **22 例全绿** |
| 引擎侧 7 个套件（含 `canonical` / `field-invalidation` / `approval-binding`） | **151 例全绿**（改动前基线 146，+5） |
| 全部 `team-hub/*.test.mjs` | **813 例 / 86 套件全绿** |
| 合跑（新桥 + 引擎 + 跨层 + 映射） | **196 例全绿** |
| 破坏性验证（桥） | **8/8 处补丁全部变红**（㊻①–㊻⑧），且 `importErr=false` |
| 破坏性验证（引擎） | **6/6 处补丁全部变红**（㊺①–㊺⑥） |
| 六道门禁 | 全绿 |
| 平台契约 | **不变**：路由 136 / 数据表 34 / 任务状态 7（迁移边 20）/ 目标状态 4 / 权限模式 5 |

### 4.1 探针修正记录

| 探针 | 第一版结果 | 处置 |
| --- | --- | --- |
| ㊻⑦ | ❌ `importErr=true` | 我写的那串替换造出了一个**语法错误**——全套用例都"红"了，但那不是断言失败。*一个「把源码改成编译不过」的探针，与一个什么都没证明的探针，是同一个东西——只不过前者会给出一个看起来很像成功的"全红"。* 改成把守卫条件置为恒假 |
| ㊻⑧ | ⚠️ 锚点未找到 | 锚点把上一行也拼了进去、中间隔着一整段注释，匹配不上。`applied > 0` 这条断言把它拦下来了，否则它会**静默地什么都不做** |

### 4.2 指纹 before / after

同一份 `{scope:'legion',actor:'general',action:'file:write',target:'repo/notes.md',taskId:'task-1'}`：

| | `file_write` | `file_delete` |
| --- | --- | --- |
| 修前 | `sha256:69969e47…` | `sha256:69969e47…`（**相同**） |
| 修后 | `sha256:6ece0891…` | `sha256:3fb94b5a…`（不同） |

（连版本号一起算，所以数值与 §1 那次实测不同——这正是 §2.1 说的"加字段本身就已经
改变哈希"。）

---

## 5 ⚠️ 仍然敞开的部分（诚实边界）

1. **没有任何真实 HTTP 调用方会填这三个字段。** 桥是一个**被交付的生产函数**，
   它的单元测试用真实形状的投影喂它，但 `server.mjs:1735` 的 `checkPermission`
   仍然把 HTTP body 原样透传。**要真正闭合端到端，需要在宿主侧把
   `tool-request.mjs` 的投影接进 `/api/permissions/check`**——那是 DSH 外壳的接线，
   不在本仓库的可改范围内（本仓库里 `requestApproval` 端口只有测试实现）。

   所以准确的说法是：**引擎闭合了、生产者函数交付了、宿主接线仍然敞开。**

2. **`allow-once` 的票据消费端未复核。** `approval-binding.mjs` 的
   `consumeBinding` 与 CAS 那一侧本轮没有重新验证"新字段是否也参与去重键"。
   §4 的 196 例覆盖了 `approval-binding` / `allow-once` 套件且全绿，
   但没有专门为"三个新字段进 CAS 键"写新用例。

3. **`argsHash` 与 `tool-request.mjs` 的 `frozenHash` 是同一套算法的两个名字。**
   桥断言了两者相等（`FROZEN_HASH_DRIFT`），但没有任何机制**强制**
   `tool-args.mjs` 的算法与 `tool-request.mjs` 冻结时用的算法保持同构——
   它们今天一致是因为 `tool-request.mjs` 也调 `hashToolArguments`。
   一条"两者必须来自同一个函数"的自检尚未写。

4. **`metadata` 不参与工具主体，且是调用方自由填的。** 这正是它在
   `OPERATION_KEYS` 里显得可疑的原因（它不参与 §1 那次碰撞，因为两次调用的
   `metadata` 都是 `{}`）。本批**没有**动 `metadata` 的语义。

5. **未做**：`TOOL_SUBJECT_KEYS` 与 DSH 侧 `CANONICAL_OP_KEYS` 的对照表
   （PRT-612 §14.7 也记着同一条缺口）。
