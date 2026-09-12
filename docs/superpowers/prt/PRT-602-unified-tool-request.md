# PRT-602 统一 ToolRequest 投影与 Enforcement Bridge

> spec §6.5 line 470：「canonical operation 明确定义：Schema 版本、domain separator、
> 固定键集合与顺序、Unicode NFC、路径绝对化与分隔符、Windows 大小写规则、数字和空值
> 表达。授权主体包含 scope、actor、action、target、taskId、toolName、callId 和不可变
> 工具参数；attemptId、UI 文案、时间戳等观察 metadata **不参与**授权哈希。」
> spec §6.8 line 479：「任何已由 `tools/pre-execute` 放行且获得 `allowed-once` 的调用，
> 不得再被 `ctx.tools.guard()` 拒绝。guard 只有降级语义、没有 allow 语义，出现
> "人工已批准但仍被 guard 拒绝"即视为强制面配置错误，**必须能由审计定位到具体强制点**。」

状态：**已交付**（`runtime/dsh-composition/tool-request.mjs`；
判据 `runtime/dsh-composition/tool-request.test.mjs` 35 例）

---

## 1 为什么需要一个**统一**投影

强制面有四个观察同一件事实的地方：`guard`、`tools/pre-execute`、approval answerer，
以及写入 `tool_calls` 的审计。它们的原始输入各不相同。

最自然的写法是**每个点各自从原始输入里取它需要的字段**。它在每个点的用例里都是绿的，
因为每个点自己那一份推导是自洽的：

```js
guard  看 execution.arguments.path
审批   看 execution.arguments.file_path
审计   把 target 记成工具名
```

于是"审批绑定的目标"与"guard 检查的目标"是两个各自算出来的字符串。

> 一个「每个强制点各自把自己那份输入投影一遍」的桥，
> 与一个「审批绑定了 A、而 guard 检查的是 B」的桥，是同一个东西——
> 只不过前者在任何单个强制点的用例里都是绿的。

所以本模块只提供**一个**投影函数 `projectToolRequest`。四个"摄入适配器"
（`guardInputOf` / `preExecuteInputOf` / `approvalRequestOf` / `toolCallRowOf`）
只把同一份投影摆成各自的形状，**不得再做任何推导**。

`assertProjectionAgrees` 真的去调用这四个适配器、比对**产出的哈希**：

> 一个「比对四个强制点各自声明的键列表」的自检，
> 与一个「比对四个强制点实际产出的哈希」的自检，在「漂移能不能被拦下」上是
> 同一个东西——只不过前者在任何一次真正的字段改名面前都是绿的。

（这是 PRT-611 的教训的直接复用：比"名单"永远比得过，比"值"才拦得住。）

---

## 2 目标必须**推导一次**，推不出来就拒绝

`target` 决定"这次批准覆盖的是什么"。最安静的失效是**推不出来时用空串兜底**：

> 一个「有外部效果、但目标推导不出来时用空串兜底」的投影，
> 与一个「所有无法定位的写操作共用同一个身份」的投影，是同一个东西——
> 而它的方向是**放行**：一次批准覆盖了任意目标。

三条规则：

| 情形 | 处置 |
| --- | --- |
| 恰一个非空候选 | 用它，并记下它是从哪个参数来的（`targetFrom`） |
| 多个不同候选 | **抛**（"到底是文件还是 URL"不猜） |
| 一个候选都没有 | 只有"作用范围本来就只有 cwd"的能力可以继续；否则**抛** |

推导由**能力**驱动（`TARGET_ARGUMENTS` 是 capability → 参数名），不是工具名驱动：

> 一个「按工具名查表得出目标字段」的投影，
> 与一个「工具改名之后目标静默变成 undefined」的投影，是同一个东西——
> 只不过后者的走向取决于下一个人写的是抛错还是兜底。

未登记工具用 `GENERIC_TARGET_ARGUMENTS`（任何已知的目标类参数都算候选）：
"我不知道它会干什么"，所以任何看起来像目标的字段都算；恰好一个才放行。

`CONTEXT_SCOPED_CAPABILITIES`（无目标调用 → 目标就是 cwd）只有 `repo:read`。
这个名单装载时被 `assertTargetlessSafe` 真的拿去查 `CAPABILITY_KINDS`：

> 一个「有外部效果的能力被放进'无目标'名单」的表，
> 与一个「不带参数的网络调用被当成读本地文件」的表，是同一个东西——
> 而它的方向是放行。

---

## 3 观察 metadata 要**拒**，不是**滤**

spec line 470 说 attemptId / UI 文案 / 时间戳"不参与授权哈希"。只把它们从哈希里
去掉是不够的：

> 一个「把观察 metadata 从哈希里滤掉、但允许它留在主体对象里」的投影，
> 与一个「它随时会被下一次重构重新算进去」的投影，是同一个东西。

所以它们出现在**参数**里就直接抛（`tool-request-observation-key-in-subject`），
把"不参与"变成结构上不可能参与。挂在**请求**上（而不是参数里）则被忽略，
并由 `TOOL_REQUEST_CHECKED.sampleObservationInvariant` 留证——
那对哈希是在把请求挂满 `attemptId`/`atText`/`ts`/`retryCount`/`elapsedMs`/`uiText`
之后算出来的，与干净请求相同。

`assertObservationKeysRejected` 逐个键**实测**（11 个键全部被拒），
而不是声明"我们知道它会抛"。

---

## 4 桥：账本，以及两种"冲突"必须分得开

桥把三个强制点装在同一份投影上，并把每个决定记进一本**按哈希索引**的账。

spec §6.8 line 479 要求"人工已批准但仍被 guard 拒绝"能**由审计定位到具体强制点**：
guard 在拒绝之前查账，若同一哈希上已有放行/`allowed-once` 记录，仍然拒绝
（hard floor 的语义是"最终单调"），但记下一条 `guard-contrary`：
哈希、工具名、guard 的拒绝理由（点名了哪条 floor 规则）、以及是谁放行的。

审计里会出现两种**看起来一样**的现象，必须分开：

| 现象 | 码 | 该改哪里 |
| --- | --- | --- |
| **投影漂移**：两个强制点算出不同哈希 | `tool-request-projection-drift` | 实现 bug（改投影） |
| **强制点冲突**：同一哈希上放行与拒绝并存 | `tool-request-guard-contrary-to-pre-execute` | 配置错误（改 hard floor 或策略） |

> 一个「把'目标推导漂移'与'guard 与 pre-execute 冲突'报成同一条告警」的审计，
> 与一个「值班的人分不清该改哪一处配置」的审计，是同一个东西。

### 4.1 投影不了 → 一律拒绝

三条路径都一样（guard 拒绝、pre-execute 拒绝、answerer `unavailable`）：

> 一个「投影失败就跳过强制」的路径，
> 与一个「强制面可以被一次畸形请求关掉」的路径，是同一个东西。

### 4.2 answerer 的 `unavailable` 不是 `rejected`

`rejected` 是"人说不"，`unavailable` 是"问不到人"。把故障伪装成决策，
审计里会出现一次**从未发生过的拒绝**。

---

## 5 本批抓出来的两个真缺陷

### 5.1 ★ answerer 端口拿不到 `arguments` → 每一次审批都"问不到人"

第一版在 `createApprovalAnswerer` 的 `request` 端口里做投影。而那个端口收到的
**只有** `{toolName, callId, reason, signal}`——没有 `arguments`。于是目标推导失败、
返回 `unavailable`，**每一次审批都问不到人**。用例 ④ 抓到了它。

> 一个「在下游端口上重新投影」的桥，
> 与一个「上游已经算过、下游却因为拿不到输入而永远说不」的桥，是同一个东西。

修法：投影在**收到完整请求的那一层**（bridge 对外包的 `answerer` wrapper）做，
下游端口只按 `callId` 取。

### 5.2 ★ 失败时抛在读之外的地方：改写检查必须放在**返回之前**

`resolvePreExecuteResult` 的检查第一版放在 `createPreExecutePolicy` 的 `onDecision`
里。那一层是**事后通知**，决定已经作出去了，抛错只能把整条流水线炸掉、
而不能把它变成一次拒绝。

> 一个「在事后通知里检查改写」的桥，
> 与一个「改写已经被放行、只是顺手记了一条日志」的桥，是同一个东西。

修法：检查放在 `decide` 里、返回之前，命中时返回一次**拒绝**并说明原因。

---

## 6 与 patch 层的关系

`legion-host.patch.yml` 的三行（`legion-enforcement-hard-floor` /
`-pre-execute` / `-approval-answerer`）是**声明**，桥是**实现**。
两者之间今天只有散文在维持：

> 一个「在文档里写着'三个强制点共用一个桥'」的组合，
> 与一个「三行里有一行注册了桥根本没提供的方法」的组合，是同一个东西——
> 只不过后者的表现是"那一行挂上了，但什么都没发生"。

`assertBridgeProvidesPorts` 拿一个**真实装配出来的桥**去比那三行的 `registrations`，
并留下 `TOOL_REQUEST_CHECKED.bridgePorts`。它还查"一行强制面都没有"这种情形——
那时这一层的检查已经**落空**，必须报错而不是安静通过。

---

## 7 诚实边界

1. **本模块是策略侧的装配，还没有接到真实的 DSH 进程里**。`legion-host.patch.yml`
   是声明式的行，实际的 `ctx.tools.guard` / `ctx.on(...)` 注册仍由 DSH 侧的适配器
   完成（`install.mjs` 不存在）。本批证明的是**这四个观察面从同一份投影读取**，
   不是"它已经在生产里挂上了"。
2. **`callId` 是硬前提**。DSH 的 execution 必须提供（试 `callId` / `call_id` / `id`）。
   拿不到就投影失败 → 一律拒绝。这是有意的 fail closed，但它意味着**没有 callId 的
   集成会在第一次调用时全线拒绝**——这是部署时的第一个要验的东西，不是运行时惊喜。
3. **路径规范化只压在 `target` 上，不压在 `arguments` 上**。
   `C:\work\a.txt` 与 `c:/WORK/A.TXT` 的 `canonicalTarget` 相同（规范化生效），
   但授权哈希**不同**（`arguments` 里那两个字符串本身不同）。方向是**多问一次**：

   > 一个「为了让两种写法得到同一个审批而把 arguments 也规范化一遍」的投影，
   > 与一个「执行时看到的参数不是被哈希的那一份」的投影，是同一个东西——
   > 而 spec §6.5 line 468 恰恰禁止改写参数。

4. **`GENERIC_TARGET_ARGUMENTS` 是一份名单**。未登记工具的推导依赖它；
   一份名单总有边界。它的失效方向是**拒绝**（认不出目标 → 抛），不是放行。
5. **账本是进程内的 `Map`**，不持久化。跨进程的审计要靠 PRT-610 的 `tool_calls`
   把每次决定落库；`toolCallRowOf` 就是那份行的形状，但**接线尚未完成**。
6. **`preExecute` 在端口抛错时的行为沿用 `createPreExecutePolicy`**：catch → deny。
   这意味着一个总是抛的策略端口表现为"全部拒绝"而不是"全部放行"——方向对，
   但排查时要去日志里找 `unavailable` 那一条。

---

## 8 验证

- `runtime/dsh-composition/tool-request.test.mjs`：**35 例全绿**。
- 破坏性验证：**40/40 处补丁全部变红**（`break-602.mjs`，探针 ㊲①–㊲㊷）。
- 六道门禁全绿；契约无漂移（本批不新增表/路由）。

### 8.1 探针与用例的改瞄记录

六处首次不红。**四处是真覆盖缺口**，两处是探针自己的问题：

| 探针 | 首次结果 | 处置 |
| --- | --- | --- |
| ㊲① `SUBJECT_KEYS` 抄一份 | 不红 | **真缺口**：用例写的是 `deepEqual(SUBJECT_KEYS, CANONICAL_OP_KEYS)`，抄一份内容一样照样通过。*一个「断言两份列表内容相同」的用例，与一个「抄了一份、而且两份迟早不一样」的实现，是同一个东西——因为内容相同是**今天**的事实，不是"它们是同一份"这个**结构**事实。* 改成严格同一（`assert.equal`）后变红 |
| ㊲④ 观察键"滤掉后再冻结" | 不红 | **探针是空操作**：泄漏检查在 `freezeToolArguments` **之前**，带观察键的请求在到达那一行之前就抛了。删除；这件事已由 ㊲③ 覆盖 |
| ㊲⑥ `CALL_ID_FIELDS` 改短 | 不红 | **真缺口，而且形状眼熟**：用例写的是 `for (const f of CALL_ID_FIELDS) assert...`——它遍历的**正是被检查的那份名单**。名单改短，循环跟着变短，用例照样绿。*一个「遍历被检查对象自己声明的列表」的用例，与一个「什么都不检查」的用例，在「列表被改短了会怎样」上是同一个东西。* 改成把三个字段名写死在用例里后变红 |
| ㊲⑦ 工具名不做 NFC/trim | 不红 | **真缺口**：没有任何用例用两种写法写过同一个工具名。补上后变红 |
| ㊲㉗ guard 放行时不记账 | 不红 | **真缺口**：用例只查过"冲突那一条账"。*一个「只在拒绝时记账」的账本，与一个「事后分不清 guard 到底跑没跑」的账本，是同一个东西。* 补上"放行也要在账上、投影不了的拒绝也要留痕"的用例后变红 |
| ㊲㊵ 主体里的 `arguments` 用原始那份 | 不红 | **真缺口，后果最具体**：*一个「主体里那一条 arguments 是调用方对象的引用」的投影，与一个「审批之后调用方改一下手里的对象，审计里记的就是另一份参数」的投影，是同一个东西。* 补上"投影之后改调用方的对象，主体与哈希纹丝不动"的用例后变红 |
