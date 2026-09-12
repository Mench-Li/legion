# PRT-407 / PRT-409 / PRT-413：上下文装配、快照持久化、token 计量

对应 spec §6.5「Context Assembler」与 §6.11（配置分层，间接相关）。

本文件记录这一批的三个任务与**过程中被实现本身撞出来的四个缺陷**——
它们的共同形状是「**对一个没在看的人来说，出错与正常长得一样**」。

---

## 1. 任务范围

| 任务 | 交付 | 状态 |
| --- | --- | --- |
| PRT-407 | `runtime/context/assembler.mjs` + `runtime/context/index.mjs` + 32 用例 | ✅ |
| PRT-409 | `team-hub/context-store.mjs` + 18 用例 + 3 条 HTTP 路由 | ✅ |
| PRT-413 | `runtime/context/tokenizer.mjs` + 19 用例 | ✅ |

PRT-401 只**定义**了 `RunContextSnapshot` 的形状；本批是第一个真正**产出**它的地方，
也是第一个把它**存下来并能读回来**的地方。在此之前，快照只存在于一次函数调用的栈上。

---

## 2. 第三种状态：「部分包含」

这是本批唯一的核心设计决定。

`RunContextSnapshot` 原本只有两个账本：`sources[]` 与 `excluded[]`。它们能表达
「整个进了」与「整个没进」。而**截断**产出的是第三种：一份文档只进去了一半。

如果这第三种不被记录，一份**截断过的**快照会声称模型看过了全文。用户看到
「文档 A 已包含」，于是以为模型读完了整份规范，而它只看到前 2000 字。
spec §6.5 要的是「还原其**实际**输入」——**实际**这个词就是这条设计要求的来源。

所以装配器有三个账本加一张段落表：

- `sources[]` —— 进去了的来源，`content` 是**实际发出去的那一版**；
- `excluded[]` —— 没进去的，附 `reason`（6 种之一）与人类可读的 `detail`；
- `truncations[]` —— **只进去了一部分**的，记 `originalChars` / `keptChars`；
- `segments[]` —— 把 `finalText` 切回去，回答「模型看到的第 N 个字符来自哪里」。

守恒断言：`sources.length + excluded.length === candidateCount`，且同一个来源
不会同时出现在两个清单里。被截断的来源**算在 `sources` 里**（它确实进去了），
同时**也**出现在 `truncations` 里。

### 2.1 主账本曾经说谎（实测撞到的第一个缺陷）

第一版把 `sources[]` 直接填成**原始**来源对象：

```
truncations[0].keptChars = 30      ← 副账本说了实话
sources[0].content.length = 200    ← 主账本说模型看到了 200 字
```

`truncations[]` 是对的，而任何人去看 `sources`（最自然的那一步）都会得出
「模型读完了整份文档」。**一个说了实话的副账本救不了一个说假话的主账本。**

现在是 `withEffectiveContent(source, effective, truncated)`：

- `content` **就是**发出去的那部分；
- `contentHash` 是**这个** `content` 的哈希（同名字段必须自洽，
  否则读者拿它去校验 `content` 会得到一个说不清的失败）；
- `truncated: true`、`fullChars`、`fullContentHash` 让「它原本是什么」仍然可查。

用例 ②（`assembler.test.mjs`）专门断言两个账本互相对得上。变红验证确认：
把这一处改回原始来源，那条用例立刻红。

### 2.2 `segments` / `truncations` 必须进哈希（第二个缺陷）第一版把它们当成「附加信息」，在 `freezeContextSnapshot` **之后**才拼上去。
后果：`verifySnapshotHash` 对**每一份**装配出来的快照都返回 `false`。

**一个总是失败的校验函数比没有更坏**——所有人都会学会忽略它。
更本质的是：截断改变了「模型实际看到了什么」，那正是这份哈希要封住的东西。

现在它们是 snapshot body 的正式字段，进哈希、进域分隔。

### 2.3 「来源不存在」此前**无法表达**（第五个缺陷）

spec §6.5 点名的三种情况是：「这个来源**不存在**」/「有但无权读」/「有但被裁掉了」。
而装配器最初只能表达后两种。

后果不是"少一个枚举值"，而是：一个**试着去取、但产物不在**的调用方
（PRT-402~406 的失败路径恰好是这个形状）**唯一能做的事就是什么都不说**——
不把这个候选放进 `candidates`。守恒断言仍然成立，快照仍然"完整"，
而少掉的那个来源**不留痕迹**。这正是本模块存在的理由，只不过发生在自己身上。

现在候选可以带 `missing: true`（可选 `missingReason`），记 `reason: 'missing'`。
顺序是有意的——它是**最后一道**：

| 先判 | 为什么 |
| --- | --- |
| 无权 | 系统不该向读不到它的人**确认它是否存在** |
| 过期 | "v1 已被 v2 取代"比"v1 没了"更有用——我们本来就要用 v2 |
| 跨空间 | 根本不该提 |
| **不存在** | 兜底，含义明确：**该在的，不在了** |

`content === null` **不是** `missing`：那是"只有出处、没有正文"的引用型来源，
合法且常见；自动当成缺失会把它误报。

`REDACTED` 仍然**没有产出路径**——它是留给脱敏（PRT-408）的预留值。
脱敏改变内容是因为**策略**，截断是因为**预算**，两者不能合并成同一个理由。
为了让"定义了却没人能产出"这件事**可见**，有一条用例把
「可达集合 ∪ 预留集合 = 全部枚举值」钉住：新增理由却忘了写产出路径时会红。

---

## 3. 权限判定只拿元数据

`policy.canRead(meta)` 收到的 `meta` 有 `{id, type, version, trust, scope}`，
**没有 `content`**。

理由不是性能：「先把正文读进来再过滤」意味着越权文本**短暂地存在于内存与日志里**。
过滤后的结果是对的，而发生过的事没有消失。用例 ② 直接断言 `meta` 上没有
`content` 键——把这条纪律变成可测的东西，而不是一句注释。

另外两条：

- **`canRead` 抛错 = 不可读**（fail closed）。无法判断不等于可以。
- **不给 `canRead` 直接拒绝**。默认放行是最不该有的默认值：一次漏传会让
  越权来源静默进入上下文，而快照上看不出任何异常。

失败码 `CONTEXT_PERMISSION_REQUIRED` 是这条纪律在 HTTP 层的形状：
装配路由**不替调用方决定权限**，必须显式给 `canReadIds` 或 `canReadAll: true`。

---

## 4. 必需的来源放不下 → 失败，不是静默省略

`required: true` 的来源若在裁剪后仍放不下，装配抛 `CONTEXT_TOO_LARGE`
且**不产出任何快照**。

理由是后果的形状：一次缺了任务定义的运行不会停下来——它会**继续跑**，
并基于错误的上下文产出结论。一份「少了一个必需来源但看起来正常」的快照，
比一次明确失败坏得多。

`allowTruncate` 未声明时**整个丢掉**而非悄悄截断：悄悄截断一份规范，
会让模型基于半份规范下结论，而没人知道。默认行为是「要么整份，要么不进」，
并写明为什么没进（`reason: over-budget`）。

---

## 5. 快照不可变 + 两处验哈希（PRT-409）

表 `run_context_snapshots`（`attempt_id` 主键）。**没有 update / delete 入口**：
spec §6.5 要求快照在 `BuildingContext` 完成、Attempt 进入 `Running` **之前**冻结，
之后不可修改。`Object.keys(store)` 被用例钉死，防止以后有人加一个「反正没人用」的修改口。

重复 `record` 同一 `attemptId`：

- 内容哈希相同 → **幂等成功**（重试是合法的）；
- 内容哈希不同 → **409 冲突**，且**不覆盖**原有的那一份。

同一次运行的上下文不可能有两个版本；出现两个说明有一次写入是错的，
而「后写的赢」会让**那一次错的**成为事实。

哈希验两次：**落库前**（被改过的快照不许进库）与**读回时**
（库里可能被外部直接改过，`?verify=1` 会重算）。

存的是**全文**，不只是哈希：只存哈希的「审计」无法回答「模型当时到底看到了什么」，
而那正是这张表的目的。体积问题应当在**保留策略**上做（按时间/按任务清理），
不是在**记录内容**上省——省掉的是这个功能唯一的产出。

### 5.1 一次成功的写入被报成失败（第三个缺陷）

审计适配器写错了：

```js
writeAudit: typeof audit === 'function' ? audit : null,   // ❌ 位置参数 vs 对象载荷
```

`audit` 是 `audit(member, scope, action, taskId, detail, goalId)`（位置参数），
而 store 按 `writeAudit({action, attemptId, runId, detail, actor})` 调用
（与 `modelStore` / `bindingStore` 同一约定）。于是 `member` 收到一个对象、
`scope` 收到 `undefined` → SQLite 绑定错误。

它不是「审计没写成」那么轻：异常发生在**快照已经落库之后**，所以客户端拿到
`400` 而库里已经有那一行。**一次成功的写入被报成失败**——调用方会重试，
而重试命中幂等分支，于是它最终以为成功。

### 5.2 幂等分支不写审计（第四个缺陷，由 5.1 暴露）

修好适配器之后才发现：幂等分支**直接 return**，而审计写在后面。于是
「第一次写成功但审计抛错 → 400 → 重试命中幂等分支 → 200」的结果是
**快照在库里、审计永远缺失、客户端以为成功**。

每一次「我们记下了这次运行」都该留下痕迹，包括重试带来的那一次。
冲突路径则**不写审计**（它没有改变任何状态，被拒绝的写入不该留下「记录成功」的痕迹）。
两条都有用例。

---

## 6. token 计量：保守是一个**方向性**性质（PRT-413）

spec §6.5：「无法获得精确 tokenizer 时使用**明确标记的**保守估算器。」

两个方向的代价完全不对称：

| 错法 | 后果 |
| --- | --- |
| **低估**（说 8000，实际 12000） | 以为放得下，把超限内容发出去 → 在**供应商那一侧**失败或被截断，而**钱已经花了**；更坏的是「预算」这道防线其实是假的 |
| **高估**（说 12000，实际 8000） | 提前裁掉一点，模型少看一些上下文。**没有金钱代价，也不会失败** |

所以估算器**必须是保证的上界**。这不是「尽量准一点」的工程偏好，
而是这条防线唯一能成立的形态：**一个可能低估的估算器提供的是虚假的预算保证。**

推导：任何 BPE / WordPiece / sentencepiece 类 tokenizer 的 token 都是输入的**切分**
（按序拼接即原文，且每个 token 非空），于是

```
词元数 ≤ 码点数 ≤ UTF-8 字节数
```

取**码点数**为上界（比字节数紧：中文只差 3 倍而非 4 倍）。代价是对英文高估约 3~4 倍。
这是有意的选择：**宁可早裁，不可低估。**

估算的 `kind` 与 `note` 都进快照、进哈希——同一 token 数、不同可信度，
哈希必须不同。否则一个估算值在界面上与精确值**长得一模一样**。

`defineExactTokenizer` 要求 `evidence`（凭什么算精确）。没有依据就声明 `exact`，
会让一份估算出来的预算看起来有权威——而 `tokens.kind` 存在的唯一理由就是区分这两者。

`TOKENIZER_REGISTRY` 在 `team-hub/server.mjs` 里**存在但默认为空**：
本项目零依赖、拿不到任何供应商词表。空表不是缺陷，而是如实。

---

## 7. 路由（PRT-409，+3 条）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/context-snapshots` | 列表（摘要，**不含正文**），可按 `runId`/`scope` 过滤 |
| POST | `/api/context-snapshots/assemble` | 装配 + 落库；必须显式给权限 |
| GET | `/api/context-snapshots/:attemptId` | 取全文 + 两账本 + 段落表，`?verify=1` 重算哈希 |

装配路由的存在有两层意义：装配器有了**真实调用方**（此前只有用例），
以及装配与持久化在同一个请求里完成，于是「冻结在 Running 之前」
不是一条靠人记住的约定。

端到端实测（真起 hub、真装配、真落库、真读回）：

```
① 不给权限: 400 | code= CONTEXT_PERMISSION_REQUIRED
② 装配: 200 | summary: 包含 1 个来源（约 9 token，保守估算）；排除 1 个（超预算 1）。
③ 列表: 200 | count= 1
④ 读回: 200 | verify.ok= true | 账本 candidate=2 included=1 excluded=1
⑤ 不同内容重写同一 attemptId: 409 | code= CONTEXT_SNAPSHOT_CONFLICT
⑥ 不存在: 404 | code= CONTEXT_NOT_FOUND
⑦ 截断装配: 200 | 包含 2 个来源（约 60 token，保守估算），其中 1 个被截断。
   主账本 content.length = 51 | truncated = true | fullChars = 100
   副账本 keptChars = 51 | 两者一致 = true | verify.ok = true
```

---

## 8. 构建红出来的第六个缺陷：`refused` 被读了却从不使用

`build` 阶段报了两条 `TS6133`（声明但未使用）。第二条指向
`workbench/src/modelSettings.ts` 的 `importPlanView`：

```ts
const refused = Array.isArray(plan.refused) ? plan.refused : []   // ❌ 读了，从不使用
```

查下去发现三层问题：

1. **类型说谎。** `ImportPlanLike.refused?: readonly string[]`，
   而后端 `model-migration.mjs` 推入的是**对象** `{index, code, reason}`。
2. **`ok: true` 与 `refused` 非空可以同时成立。** `finish(base, MIGRATION_CODES.OK)`
   在只有 `BAD_SOURCE` / `MIGRATION_INVALID_PROFILE` 这类**行级**拒绝时照样返回 OK
   ——只有"源里出现密钥"才会因为 `refused` 拒绝整个计划。
3. 于是界面会说"可以导入 · 新建 7 个模型档案"，而另外 3 行**无声消失**。
   **一次静默的部分导入，比一次明确失败坏得多**：它留下一个"看起来配好了"的系统，
   而缺的那几个岗位要到运行时才发现。

现在：

- 类型改成 `readonly ImportRefusal[]`（`{index?, code?, reason?}`），
  同时接受字符串以便读旧数据；
- 每一条拒绝各说一句「有 1 行被拒绝，不会导入：<理由>」；
- `needsConfirm` 计入 `refused.length`——确认框是用户看到这些硬话的最后机会；
- 标题分三种：`可以导入` / **`没有可导入的内容，但有被拒绝的行`** /
  `这个包里没有需要变更的内容`。第二种**不能**说成第三种：那会让用户以为包是空的，
  而真实情况是**他给的每一行都没能进来**。

最后一条是变红验证逼出来的：我先把 `refused.length` 加进 `needsConfirm` 并写了断言，
但探针 ⑮ **没有变红**——因为那条用例里 `toCreate` 有 7 项，
`toCreate.length + toUpdate.length > 0` 已经为真，`refused.length` 那一项**不可观测**。
真正让它起作用的场景是「没有任何可导入项、但每一行都被拒绝」，于是补了那一条用例
和一个诚实的标题（探针 ⑯ 确认它会红）。

> **顺带记下**：`importPlanView` 目前**没有任何产品调用方**——只有用例和导出。
> 这与 PRT-504 的形态一样（实现、套件、文档俱全，零调用点）。
> 界面接线仍属 PRT-507 的未完成部分，见第 11 节。

---

## 9. 推送验证脚本自己的错判（假红与假绿）

推送这一步本该由 `scripts/prt/push-verify.mjs` 用「远端 tip 等于本地 HEAD」判定。
本批提交后它报：

```
local  = 177dd6d…
remote = 5d49fe0…
PUSH NOT VERIFIED ✖（mismatch）
```

而 `git ls-remote origin refs/heads/codex/prt-runtime` 明明返回 `177dd6d`——
**推送是成功的**。

原因：脚本把命令行给的 ref 原样交给 `ls-remote`。传 `HEAD` 时，

| 命令 | 实际问的是 |
| --- | --- |
| `git push origin HEAD` | **当前分支** `codex/prt-runtime` |
| `git ls-remote origin HEAD` | 远端的 **`HEAD`** = **默认分支** `main` |

两个不同的 ref，于是永远不相等。这次的表现是**假红**；同一个缺陷在另一种
布局下会是**假绿**：在默认分支上工作时，`push origin HEAD` 推 `main`、
`ls-remote origin HEAD` 也读 `main`，只要远端 `main` 仍等于本地 `HEAD`——
**即使这次推送被服务端拒绝**（分支保护、push protection 拦下）——脚本照样报
`verified`。而 `push-verify.mjs` 整个存在的理由，正是 PRT-509 那次
「被 push protection 拒绝却以为推上去了」。

**一个会给出错误结论的检查，比没有检查更坏。**

修法是把 ref **归一**成远端真实存在的分支名再问：

- `HEAD` → `git rev-parse --abbrev-ref HEAD` 得到当前分支名；
- 分离头指针 → **拒绝**（没有分支可推，也没有可比较的远端 ref；猜一个名字
  等于对着一个不存在的 ref 比较）；
- 裸 SHA → **拒绝**（它没有对应的远端 ref 名，无从比较）；
- 分支名 / `refs/heads/x` → 归一。

`gitRun` 可注入，于是这条路径**可测**——原来它不可测，正是缺陷存活的原因：
套件里 16 条用例全部只覆盖 `verdictFor` / `parseRemoteTip` 这两个纯函数，
而 CLI 的 ref 解析一行都没有。现在补了 8 条，含一条端到端假绿回归
（推送被拒 + 远端默认分支恰好等于本地 HEAD → 必须报 mismatch，
且**不许**出现 `ls-remote origin HEAD` 这个调用）。

> 值得记一笔：这个套件**早就在 CI 里**，而且一直是绿的。
> 「套件注册了、跑过了、通过了」和「这条路径被测试了」不是一回事。

---

## 10. 顺带修好的门禁缺陷：一条只在测试里、不在门禁里的检查

`team-hub/context-store.mjs` 建了新表 `run_context_snapshots`，
而 `scripts/prt/baseline-snapshot.mjs --check` 报 **「无漂移」**——
因为 `SCHEMA_SOURCES` 里没有它，那张表对基线**不可见**。

`baseline-snapshot.test.mjs` 的用例⑤红得完全正确。两者都对，
但**人跑门禁时拿到的是绿灯**。

本项目纪律是「**一道没人必须记得的闸门才是能守住的闸门**」。把检查留在测试里，
等于要求每个人在跑 `--check` 之前先想起「还要跑测试」。所以把这条检查搬进
`assertSchemaCoverage()` 并由 `buildSnapshot()` 调用——`--check` 与 `--record`
都会先撞上它。表数从 **31 → 32**，那张表终于可见。

搬过去之后立刻又撞出两个自己的缺陷：

1. **`readdirSync` 忘了 import**，而 `walk()` 里写的是裸 `catch { return }`。
   `ReferenceError` 被吞成「没找到任何建表文件」，`found` 变成空数组，
   覆盖率检查**静默地什么都没查**。逮住它的是**反向检查**（「登记了却不再建表」）
   报了 6 个假阳性——如果只有正向检查，`assertSchemaCoverage()` 会返回
   `{found: 0}` 并**通过**。
   **一个把编程错误吞成「没有发现」的 catch，比没有 catch 更坏。**
   现在只容忍 `ENOENT` / `ENOTDIR`，其余原样抛出。

2. **反向验证没生效**。第一版用 `SCHEMA_SOURCES.length = 0` 来「拿掉一项」——
   而那**什么都没改**：`SCHEMA_SOURCE_PATHS` 是模块加载时算好的快照。
   `assert.throws` 拿到「没抛」，用例红了——**是这条断言抓住了「我的变红手法没生效」**。
   现在改成注入削减后的登记表，走同一条实现。

---

## 11. 变红验证：19 处，19 处红

每一步都确认「补丁**真的应用了**」再看用例红不红，
因为**没生效的变红验证和通过的验证在输出上完全一样**。

第一轮 12 处里有 **6 处没生效**，全部被这一步抓出来：

| 探针 | 没生效的原因 |
| --- | --- |
| ② canRead 拿正文 | 锚点漏了行尾的 `scope: c.scope ?? null` |
| ③ canRead 抛错放行 | **瞄准了一句死代码**：`readable = false` 后面紧跟 `continue`，改它不影响任何行为 |
| ④ required 悄悄丢掉 | 锚点写成了单行，源码里 `throw new AssemblyError(` 与 `ASSEMBLY_CODES.CONTEXT_TOO_LARGE` 分居两行 |
| ⑧ 幂等不写审计 | 探针只改了载荷内容、没改「是否调用」，**结构上不可能红** |
| ⑪ 覆盖率不再被调用 | 多行锚点撞上 **CRLF**（用 `\n` 写的锚点在 CRLF 文件里永远匹配不上） |
| ⑫ catch 吞错误 | 同上，CRLF |

⑪⑫ 的教训是通用的：**「匹配不上」的表现与「验证通过」完全一样**。
现在 break 脚本先按文件自身行尾归一化再匹配。

③ 的教训更值得记：**一句紧跟 `continue` 的赋值是死代码**。
它无害，但它让读者以为那里有决策。这说明「改坏它」这个手法本身能发现
「这段代码其实没在决策」——而单看代码不容易看出来。

---

## 12. 用例与验收

| 套件 | 用例 | 内容 |
| --- | --- | --- |
| `runtime/context/assembler.test.mjs` | 36 | 权限只拿元数据 / fail closed / 三账本守恒 / 第三种状态 / **来源不存在可达** / 必需来源失败 / 顺序确定性 / 段落可追溯 / 理由可达性自检 / 接线 |
| `runtime/context/tokenizer.test.mjs` | 19 | 估算器是上界（中英 emoji 混合）/ 码点 vs UTF-16 / kind 可区分 / evidence 强制 / 拿到装配器上 |
| `team-hub/context-store.test.mjs` | 18 | 全文可读回 / 不可变 / 幂等 vs 冲突 / 两处验哈希 / 审计只记规模 / 两处缺陷回归 |
| `workbench/scripts/model-settings.test.mjs` | 37 | 含 `refused` 必须说出来、每条各说一次、全被拒绝时标题不许说"没有变更" |
| `scripts/prt/push-verify.test.mjs` | 16 | ref 归一（`HEAD` → 当前分支）/ 分离头指针与裸 SHA 拒绝 / **端到端假绿回归** |
| `scripts/prt/baseline-snapshot.test.mjs` | 19 | 覆盖率检查（含两条反向验证） |

装配器的 `index.mjs` 是对外出口，且有用例真的 `import` 它并**调用**函数——
PRT-401 上曾出现「字符串出现过就算接线」的假绿，这里不重复。

---

## 13. 遗留

- **PRT-402–406、408、410–412 未做**：来源装配的具体实现（TeamPlan / EmployeeManifest /
  目标上下文 / 任务与评论 / 上游交付）、脱敏、未授权与超限用例、冻结接线、
  「不可信来源不能扩大权限」的端到端用例。
  `EXCLUSION_REASONS.REDACTED` 仍**没有产出路径**，是 PRT-408 的预留值
  （由一条"可达 ∪ 预留 = 全部"的用例钉着，新增理由忘了写产出路径时会红）。
  `MISSING` 已可达（见 §2.3），但**还没有任何调用方真的传 `missing: true`**——
  PRT-402–406 才会产出它。
- **装配器还没有接进 worker 的 `buildContext` 阶段**。`orchestrator/worker/main.mjs`
  是一个可注入的 stub（`buildContext: async () => ({ kind: 'minimal', note })`），
  而状态机已经要求 `BuildingContext → Running` 必须持久化 `contextSnapshot`。
  目前装配由 HTTP 路由驱动，**不是**由 worker 驱动。
  这是 PRT-411「冻结接线」的实质内容。
- **`importPlanView` 仍无产品调用方**（只有用例）。§8 修好了它会静默丢 `refused`
  的行为，但界面接线仍属 PRT-507 的未完成部分。
- `describeAssembly` 的摘要文本覆盖「包含 / 排除 / 截断」与五种排除理由，
  未覆盖脱敏。
- 快照的**保留策略与导出**未做（PRT-409 的右半部分）。
