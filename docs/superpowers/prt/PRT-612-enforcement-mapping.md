# PRT-612：Legion 权限语义到强制面的固定映射

**spec**：line 934；§6.6 line 445–454（映射表）、line 470（授权主体）
**状态**：✅ 已交付
**证据**：`.ci/prt-612/`（全量 CI）

---

## 1 一句话

把 spec §6.6 那张六行的表变成**数据 + 判据**，并给出唯一一个把模式落到强制点的函数；
同时让 PRT-607 那个判定函数**第一次有了生产调用方**。

---

## 2 为什么"映射"需要一份代码，而不是一段文档

这张表里每一行都对应**另一个模块里已有的一个原语**（`createPreExecutePolicy`、
`createHardFloorGuard`、`createApprovalAnswerer`、`probeSandbox`、`reconcilePatchLayer`）。
文档里的表与代码里的原语之间没有任何机制保证它们**同时**是对的：

> 一份写着"ask → ctx.approval"的映射文档，
> 与一个"ask 其实在 pre-execute 就被放行了"的实现，是同一个东西——
> 只不过前者在评审时看起来是有约束的。

所以 `runtime/dsh-composition/enforcement-mapping.mjs` 做三件事：
**声明**（`ENFORCEMENT_MAPPING` / `MODE_ROUTING`）、**查**（`assertMappingConsistent`）、
**用**（`mapPermissionMode`）。

---

## 3 ★★ "无人值守"只有一处实现

`mapPermissionMode` 对 `ask` / `allow-once` 的结局**整体委托**给 PRT-607 的
`decideApproval`，自己不写一行"没人怎么办"。

> 一个「在映射层自己再写一遍'无人值守怎么办'」的实现，
> 与一个「两处对无人值守的判断迟早不一样」的实现，是同一个东西——
> 只不过前者在只有映射层单测的时候看起来是对的。

有一条不变量逐组比对两者（3 需求 × 2 值守 × 2 策略 × 2 模式 = 24 组）：
映射给出的 `decision` / `code` / `reason` 必须**就是** `decideApproval` 的那一份。
探针 ㊹⑨ 把这个委托换成 `input.attended === true`，用例立刻变红。

这也正是 PRT-612 要解决的"无生产调用方"：`decideApproval` 现在有了真实调用路径，
而它自己**一行没改**。

---

## 4 ★★ spec line 452 那个"**前**"字

原文是"DSH 在 answerer waterfall **前**拒绝"。重点在 **"前"**。

把"policy-gate"（waterfall 之前的确定性判定）与"answerer"（waterfall 本身）
混成"approval 这一个点"，就会得到一个最坏的实现：

> 一个「无人值守时仍然把请求送进 answerer waterfall」的映射，
> 与一个「去问一个不在场的人、然后一直等下去」的映射，是同一个东西。

落法：`mapPermissionMode` 的返回值里有一个**显式**字段 `answererInvoked`，
它是一条不变量而不是巧合——

```
answererInvoked  ⟺  decision === 'ask'
```

`deny`（无人值守）与 `hold` 都不进 waterfall。探针 ㊹④（恒 true）与 ㊹⑤（恒 false）
两侧各打一次，都变红。`enforcementPathOf('ask')` 把 `approval` 点展开成
`['policy-gate', 'answerer']` 两个阶段，让这件事在证据里是可见的。

---

## 5 ★ 决定来源 ≠ 配置绑定点

spec 的表有 **6 行**，而 `ENFORCEMENT_SOURCES`（`tool_calls` 审计的 `source` 口径）
只有 **4 个**。这个差不是漏了，是两类东西：

| kind | 点 | 含义 |
| --- | --- | --- |
| `decision` | pre-execute / guard / approval / sandbox | 针对**某一次调用**给出判定 |
| `config` | permissionPresets / canonical-operation | 只**绑定配置**，不判定任何一次调用 |

如果把 `permissionPresets` 也算成决定来源，审计里就会出现一个"决定了某次调用"的来源，
而**它从来没有决定过任何一次调用**：

> 一个「把配置绑定点也算进决定来源」的审计，
> 与一个「`source` 列上出现一个从不做判定的来源」的审计，是同一个东西。

自检强制 `decisionPoints() === ENFORCEMENT_SOURCES.sort()`（两个方向都查）。
探针 ㊹⑥ 把 `permissionPresets` 改成 `decision`，7 个用例变红。

---

## 6 ★ 两条只有在"反方向"才看得见的检查

### 6.1 `allow-once` 必须经过审批箱

名字里带 "allow"，所以最自然的写法是把它映射成 "pre-execute 放行"。那是错的：
spec line 451 把 `ask` 与 `allow-once` **并列**在审批箱下，并补了"只有 `allowed-once` 执行"
——`allow-once` 描述的不是"这次调用已经安全"，而是"持有一张必须被消费的票据"。

> 一个「把 `allow-once` 映射成 pre-execute 直接放行」的表，
> 与一个「`allow-once` 的票据从来没被消费过、于是同一张票能放行任意多次」的表，
> 是同一个东西——而它的方向是放行。

探针 ㊹② 变红（9 个用例）。

### 6.2 声明了某个决定来源，却没有任何一行映射到它

第一版的检查只问"引用的点都存在"。反方向没人问：表里声明 `guard` 是一个决定来源，
而**没有任何一行要求它做任何事**——`ENFORCEMENT_SOURCES` 里仍然有 `guard`，
启动自检照样全绿，而 hard floor 的"终审"实际上没人负责。

> 一个「声明了某个强制点、却没有任何一行映射到它」的表，
> 与一个「这个点从来没被要求做过任何事」的表，是同一个东西——
> 只不过前者在"点是否存在"的检查里是合格的。

**这条缺口是被一个失败的探针找出来的，不是被一次代码审查找出来的。**
探针 ㊹① 原本想删掉 `deny` 路由里的 `guard`，但它用的锚点
`['pre-execute', 'guard']` 在文件里有两个（`ENFORCEMENT_MAPPING` line 449 与
`MODE_ROUTING.deny`），`String.replace` 只改第一处——改错了地方，而**没有任何用例变红**。

处置不是"换个锚点混过去"。当时有两个真问题：

1. **没有用例要求 line 449 必须同时含两个点**——那一条是 spec 的原文，应该有断言；
2. 补上断言之后，它仍然是**恒为真**的（真实表里 guard 总被引用），
   于是那是一条**从不执行**的检查。

所以照 PRT-607 的老办法把两张表改成**可注入**（`mappingRows` / `routing`），
用例传一张被掏空的表证明它真的会拦：

> 一个「检查一个不可能出现的值」的检查，
> 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。

新增 `POINT_UNREFERENCED` 码与两条用例（正/反各一条）。探针 ㊹① 与 ㊹⑬
（删掉这条检查本身）现在都按预期变红。

---

## 7 ★ 一个无效探针：改测试的探针

探针 ㊹⑪ 的第一版是**改测试文件里的断言**（把跨层比对弱化成 `LEGION_MODES.length vs MODES.size`），
结果没有变红——于是它被记为"未通过"。

这不是"覆盖不足"，而是**探针本身无效**：削弱一条断言，永远不可能被另一条断言抓到
（除非有人专门去数断言行，而那不是在验证行为）。把它指向**生产模块**
——让 `runtime` 侧那份声明真的少一个模式——立刻变红（7 个用例）。

> 一个「改测试的探针」，
> 与一个「它红了也说明不了代码对不对」的探针，是同一个东西。

同类的处置在 PRT-606 也做过一次（㊶㊼ 从"两个分支共用一个码"改为"注入一个从未发出的码"）。

---

## 8 缺 `probeSandbox` 时**不跳过**，而是记下来

`probeSandbox` 住在 `selfcheck.mjs`，而 `selfcheck.mjs` **import 本模块**
（启动自检要跑第 ④ 项）。所以本模块装载期解析不到它。第一版的想法是"跳过它"——

> 一个「自检说'所有原语都在'」的自检，
> 与一个「其中一条原语从来没被查过」的自检，是同一个东西。

所以不跳过：解析不了的原语进入返回值的 `unresolvedPrimitives`，
`startupSelfCheck` 把 `probeSandbox` 注进来再跑一次。
"全查过"这句话是**两个调用点合起来**才成立的，而只跑得动静态那一半时，
返回值会**明说还剩哪一条没查**。探针 ㊹⑫（去掉注入）变红。

---

## 9 接进启动自检：第 ④ 项

`startupSelfCheck` 从 3 项变成 **4 项**，新增 `enforcement-mapping`。

它与前 3 项**正交**：前 3 项问"强制面挂上并生效了吗"，第 ④ 项问
"挂上的那几个点，与 spec 那张表还是同一回事吗"。两者可以同时为真而仍然出问题：

> 一个「检查强制面挂上了没有」的启动自检，
> 与一个「检查挂上的强制面是不是声明的那几个」的启动自检，不是同一个东西。

补丁层完整生效、沙箱真的在管制，而映射里 `ask` 那一行被改成"pre-execute 直接放行"
——三个点都绿，没有人会来报 bug。

接进去之后，既有用例
`③ REPAIR_ACTIONS 覆盖自检的**全部**检查项（新增一项时这条会红）`
**立刻按设计变红**，逼出两件必须配套的事：

1. `bootstrap.mjs` 的 `REPAIR_ACTIONS` 新增 `enforcement-mapping` 一项
   （含 `action` / `label` / `why`，并说明它为什么与另外三项正交）；
2. `composition.test.mjs` 里三处写死"三项"的断言更新为四项。

**这条既有断言是这一批里唯一"帮到忙"的既有测试**：它按设计拦住了
"加了自检项却忘了给修法"。一个用户看到"没过"却拿不到下一步该做什么，与没有这项检查相比，
用户得到的是同一件事。

---

## 10 跨层那份声明

映射模块**不能** import `team-hub/permission-engine.mjs`。理由是方向而不是禁令：
`team-hub/` → `runtime/` 是本仓库既有的分层方向（`tool-call-log.mjs`、
`permission-engine.canonical.test.mjs` 都 import `runtime/dsh-composition/enforcement.mjs`），
而 `runtime/` → `team-hub/` 实测 **0 处**。为一个常量反转一条已经一致的方向没有收益。

所以它**声明**一份 `LEGION_MODES`，由 `team-hub/enforcement-mapping-binding.test.mjs`
（该文件在跨这两层）断言与 `MODES` 相等——**集合与顺序都比**：

> 一个「本模块自己声明一份模式表」的实现，
> 与一个「两份表迟早不一样」的实现，是同一个东西——
> 只不过前者在任何**单侧**的用例里都是绿的。

顺序不比行为，但它决定排障时两个人读的是不是同一张表。
断言旁边还钉了一句 `MODES` **不是"什么都接受"**：八个近邻拼写（`denyy` / `Allow` /
`allow_once` / `allow` / `reject` / `permit` / `prompt` / 空串）必须都被拒——
没有这一句时，上面那条断言可以在 `MODES` 被写成全集时依然通过。

---

## 11 顺带补上的一处遗漏：`index.mjs` 少了一个模块

`runtime/dsh-composition/index.mjs` 自称"下游一律从这里取符号，不直接深入子模块"，
而 PRT-607 交付 `approval-policy.mjs` 时**没有把它加进出口**。

> 一个「声称是唯一出口、但少了一个模块」的出口，
> 与一条写着"请勿直接 import 子模块"的注释，是同一个东西——
> 只不过后者看起来像一条已经生效的约定。

本次把 `approval-policy.mjs` 与 `enforcement-mapping.mjs` 一并加进出口。

---

## 12 ⚠️ 已登记的缺口：F-02 授权主体缺 `toolName` / `callId`

**本批发现，未在本批修**（单独一批）。

spec line 470 要求授权主体包含
`scope、actor、action、target、taskId、toolName、callId 和不可变工具参数`。
而 `team-hub/permission-engine.mjs` 的 `OPERATION_KEYS` 是：

```
["scope","actor","action","target","taskId","unattended","metadata"]
```

**`toolName` 与 `callId` 都没有**，且 `normalizeOperation` 把它们整个丢掉
（`metadata` 是调用方自由填的，不是同一件事）。实测：

```
operationFingerprint({...同一份 scope/actor/action/target/taskId, toolName:'file_write'})
=== operationFingerprint({...同一份,                                  toolName:'file_delete'})
→ sha256:69969e4709253a5a06cb2de33f2e5e15895e756da187ed6b02333a42974bf2da（两边相同）
```

`approval-binding.mjs` 的 `bindingHash` 就是这个指纹，也就是说
**一次"写文件"的批准可以被一次"删文件"消费**（当两者的其余字段与 metadata 相同时）。

这与 PRT-613 在工具参数那一侧修掉的是同一个形状——那次的名言是
"只哈希了 args，于是 `file_write` 与 `file_delete` 得到同一个身份"。
PRT-613 的文档里写过一句"F-02 侧主体里本来就有 `toolName`（`CANONICAL_OP_KEYS`）"，
**那句话只对 DSH 侧的常量成立，对 Legion 侧的 `OPERATION_KEYS` 不成立**。

当前已把事实钉进 `team-hub/enforcement-mapping-binding.test.mjs` §④：

```js
assert.ok(!produced.includes('toolName'), '缺口已修复？请把这条断言换成"必须含 toolName"')
```

也就是说那一批把两个键补进去时，**这条断言会变红并提示怎么改**——
而不是让缺口安静地留在"✅"的任务里。

---

## 13 验证

| 项 | 结果 |
| --- | --- |
| `runtime/dsh-composition/enforcement-mapping.test.mjs` | **23 例全绿** |
| `team-hub/enforcement-mapping-binding.test.mjs` | **5 例全绿** |
| 受影响的既有套件（`composition` / `bootstrap` / `e2e-assembly`） | 合跑 **95 例全绿** |
| 破坏性验证 | **13/13 处补丁全部变红**（㊹①–㊹⑬），且 `importErr=false`（红是断言失败不是 import 失败） |
| 六道门禁 | 全绿 |
| 平台契约 | 不变：路由 136 / 数据表 34 / 状态 7-20 / 目标 4 / 权限模式 5 |

### 13.1 探针修正记录

| 探针 | 第一版结果 | 处置 |
| --- | --- | --- |
| ㊹① | ❌ 不变红 | 锚点在文件里有 2 处，只改了第一处。**根因是"反向检查不存在"**，不是探针写错了——补上 `POINT_UNREFERENCED` 后重瞄，变红（3 例） |
| ㊹⑪ | ❌ 不变红 | **探针无效**：它改的是测试里的断言。削弱断言不可能被另一条断言抓到。改指向生产模块（少一个模式），变红（7 例） |
| ㊹⑬ | 新增 | 删掉 `POINT_UNREFERENCED` 这条检查本身——证明"新增的反向检查真的在跑" |

### 13.2 本批改动的既有文件

- `runtime/dsh-composition/selfcheck.mjs`：+第 ④ 项、返回值 +`mapping`
- `runtime/dsh-composition/bootstrap.mjs`：`REPAIR_ACTIONS` +`enforcement-mapping`
- `runtime/dsh-composition/index.mjs`：+`approval-policy`（补 PRT-607 遗漏）、+本模块
- `runtime/dsh-composition/composition.test.mjs`：三处"三项"→四项，+2 条新用例
- `scripts/ci/run-ci.mjs`：+`enforcement-mapping` 套件

**没有削弱或删除任何既有断言。**

---

## 14 诚实边界

1. **`check-composition-observer`（`composition-observation` 那一项）仍然是已登记缺口**，
   与本批无关，见 `REPAIR_ACTIONS` 里的说明。
2. **`mapPermissionMode` 目前仍无生产调用方**——本批给它接上的是**启动自检**这一层
   （`startupSelfCheck` 会跑 `assertMappingConsistent`），而"每一次工具调用都经过它"
   要等 DSH 侧那个策略插件真正落地（`legion-host.patch.yml` 的
   `legion-enforcement-pre-execute` 行）。也就是说：**表被检查了，但还没被用来决定调用**。
   这是本批**最重要的诚实边界**。
3. **`probeSandbox` 的原语检查只在 `startupSelfCheck` 里成立**。直接调
   `assertMappingConsistent()`（不注入）时，那条原语是"没查到"而不是"查过了"——
   返回值会明说，但这依赖调用方去看 `unresolvedPrimitives`。
4. **`ENFORCEMENT_MAPPING` 的 `line` 字段是手工维护的 spec 行号**。
   spec 一旦插入行，它会静默指错。没有机制保证它。
5. **`sandbox` 点没有补丁行**（`patchRow: null`）。它的"生效"由沙箱探测负责，
   而"它的模式由谁绑定"这个问题在本表里是 `permissionPresets` 那一行——
   两张表的对应关系只由 `presetBinding()` 一处体现。
6. **§12 的缺口**：F-02 授权主体缺 `toolName` / `callId`，后果是一次批准能被另一个工具消费。
   本批只登记 + 钉住，未修。
7. **未做**：把 `authorizationKeys()` 与 DSH 侧 `CANONICAL_OP_KEYS` 的差异做成一份
   可审阅的对照表（目前只有一条用例断言"两者不相等"，没有解释**为什么**每个键不同）。
