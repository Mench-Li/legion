# BUG-006｜`contention` 诊断端点与认领路径**文件域口径分叉**（读数与事实不一致）

> 对应任务 **T-183**（`general` 于 2026-10-05 11:56 建；同日 12:43 将军判定它与本工作区的在制品
> **重复**而取消 —— 取消的评论指向的就是本修复，见 §3.2）。**已修复并已在生产上生效**：
> 四处（认领/预约/过渡/诊断）现在共用同一个取法 `writeIntentStore.resolvePlannedPaths()`，
> 中枢已于 13:27 重启，活体判据见 §3.1。

## 1. 缺陷

两条路径对「这个任务打算写哪些路径」取法不同：

| 路径 | 位置 | 取法 |
| --- | --- | --- |
| 认领 / 预约 / 过渡 | `team-hub/server.mjs`（reserveWrite / claim / transition 三处） | `intent?.paths ?? fileDomain → [{path,type:'dir'}]` |
| **诊断端点** | `team-hub/routes/write-intent.mjs` 的 `GET /api/tasks/:id/contention` | **`intent?.paths ?? []`** ← 不看 `fileDomain` |

于是 `exclusive: paths.length === 0` 在诊断里对「未申报 write-intent」的任务恒为真 ⇒
**整仓独占**；而同一个任务在认领路径上用自己的 `fileDomain` 正常认领。

## 2. 后果（T-183 记录的实测原始输出）

T-178 声明了 `fileDomain=["workbench/","security/","orchestrator/","team-hub/","runtime/"]`
且**确实在跑**（能认领），但诊断给出：

```json
{"ok":false,"code":"FILE_CONTENTION","reason":"文件被任务 T-177 占用：(whole repository)",
 "paths":["(whole repository)"],"holderTaskId":"T-177", ... ,"schedulingState":"waiting-file"}
```

将军据此判断「T-178 被整仓独占挡住」，而真相是它**只是排在一个正在跑的 worker 后面**（并发槽位），
文件域层面并无冲突。

> ★ **这类"读数与事实不一致"比缺一个功能更贵**：它会让排障的人去修一个不存在的问题。
> 这正是该端点自己的注释里写的 "no duplicate UI path algorithm" 要防的事 ——
> 同一件事两处各解释一次，迟早漂移；而漂移出来的是**读数**。

## 3. 复现（可复跑，不碰生产库）

```bash
node docs/bugs/BUG-006-verify.mjs
```

它在临时库上把**两条取法并排**算出来，让分叉可见（实测输出）：

```
持有者：T-hold 占住 ["feature/a"]（state=reserved）

任务 T-dom（有 fileDomain=["feature/b","feature/c"]，无 intent）
  旧取法 intent?.paths ?? []        paths=[]  ⇒  ok:false FILE_CONTENTION → ["(whole repository)"]
  新取法 resolvePlannedPaths()      paths=[{"path":"feature/b","type":"dir"},{"path":"feature/c","type":"dir"}]
                                              (from=file-domain-fallback)  ⇒  ok:true  无冲突
  ★ 两条取法结论不同 —— 这就是"读数与事实不一致"

任务 T-none（无 fileDomain、无 intent）
  旧取法 paths=[]  ⇒  ok:false FILE_CONTENTION → ["(whole repository)"]
  新取法 paths=[]  (from=unplanned-exclusive)  ⇒  ok:false FILE_CONTENTION → ["(whole repository)"]
  （两条取法一致：整仓独占是正确判定）
```

判据：① 有 fileDomain 无 intent ⇒ 分叉消除 ✅；② 无 fileDomain ⇒ 仍整仓独占（未放宽）✅。

### 3.1 ★ 活体验证（2026-10-05 13:27 重启后，**生产库当前状态**）

重启后 8787 已跑新代码，判据是**只有新代码才有的 `pathsFrom` 字段**：

```bash
curl -s "http://127.0.0.1:8787/api/tasks/T-183/contention"
```

```json
{"ok":false,"code":"FILE_CONTENTION","reason":"文件被任务 T-178 占用：team-hub",
 "paths":["team-hub"],"holderTaskId":"T-178","holderState":"reserved",
 "pathsFrom":"file-domain-fallback","schedulingState":"waiting-file"}
```

对照**重启前**（同一端点、旧代码）：`"reason":"文件被任务 T-178 占用：(whole repository)"`、
`"paths":["(whole repository)"]`、且**没有** `pathsFrom` 字段。

★ 但这一对读数**不能单独证明是代码修好的**：这段时间里 T-183 的 `fileDomain` 也从 `null`
被改成了 `["team-hub/","docs/bugs/"]` —— **两个变量同时变了**。所以补一条把变量隔离的判据：

```bash
node docs/bugs/BUG-006-live-ab.mjs     # 在生产库**副本**上，同一份状态并排算新旧两种取法
```

实测（6 个任务里 **2 个**读数不同）：

```
任务 T-183（fileDomain=["team-hub/","docs/bugs/"] intent=0）
   旧 intent?.paths ?? []      ⇒ ok:false FILE_CONTENTION → ["(whole repository)"]
   新 resolvePlannedPaths()   ⇒ ok:false FILE_CONTENTION → ["team-hub"]   (from=file-domain-fallback)
   ★ 读数不同 —— 旧写法报的不是实际冲突范围

任务 T-184（fileDomain=["plugins/src/","team-hub/","docs/bugs/"] intent=0）
   旧 ⇒ ok:false → ["(whole repository)"]
   新 ⇒ ok:false → ["team-hub"]   (from=file-domain-fallback)
```

其余 4 个（无 fileDomain 的 T-133/T-134，有 intent 的 T-178/T-179）两种取法**本来就该一致**，
实测一致 —— 这也说明本次修改没有顺手改掉别的方向。

> ★★ **这里我自己错过一次，值得留痕**：`live-ab` 第一版把"分叉"判成 `oldV.ok !== newV.ok`，
> 于是 T-183/T-184 因为**两边都是 `ok:false`** 被算成"一致"，小结得出错误的"0 个不同"。
> 而缺陷的本质恰恰不是 ok 翻转，是**读数与事实不一致**：同样一句"有冲突"，旧写法把人指向
> 「整个仓库被占了」，新写法指向「`team-hub` 被占了」—— 前者会让人去查一个范围大得多的东西。
> 判据随即改成同时比 `ok` 与 `paths` 集合。**一个只比布尔值的断言，会把这类缺陷全放过**。

### 3.2 T-183 已被将军取消（判定与本次工作重复）

`audit seq=55767`：2026-10-05 12:43 `general` → `transition to=canceled`，评论写明：

> 【将军决定 · 取消】本任务与 `.legion-worktrees/bugs`（fix/bugs 工作区）**正在做的同一件事重复**。
> 实测（12:5x）：bugs 工作区有 BUG-006 的未提交在制品 —— `M team-hub/routes/write-intent.mjs` …
> 按 LEGION.md「修复分派」：bug 类统一在 bugs 工作区完成。本任务取消，不再重派。

也就是说：**本修复就是 T-183 想要的答案**，任务因"同一件事已经在做"而取消，缺陷本身不取消。

## 4. 修法

在 `team-hub/write-intent-store.mjs` 新增**唯一**取法，四处调用：

```js
resolvePlannedPaths(taskId, pre = {}) {
  const intent = pre.intent === undefined ? toIntent(intentRow(taskId)) : pre.intent
  const fallback = asDirEntries(parsePaths(db.prepare('SELECT fileDomain FROM tasks WHERE id=?').get(taskId)?.fileDomain))
  const paths = intent?.paths ?? fallback          // 与原来逐字一致的优先级
  return { paths, from: intent ? 'intent' : paths.length > 0 ? 'file-domain-fallback' : 'unplanned-exclusive' }
}
```

| 调用点 | 变化 |
| --- | --- |
| `routes/write-intent.mjs` 诊断端点 | **`intent?.paths ?? []` → `resolvePlannedPaths(...)`**（缺陷点） |
| `server.mjs` reserveWrite | 删掉本地 `fallback` 拼装，改用共用函数 |
| `server.mjs` claimTask | 同上 |
| `server.mjs` transition 分支 | 同上 |

三点设计说明：

- **优先级一字未改**：仍是 `intent?.paths ?? fileDomain`（intent 优先是既有语义，boundary 明确不许改）。
- **`from` 一并返回**：原先每个调用点各写一遍 `intent ? 'runtime-claim' : paths.length ? 'file-domain-fallback' : …`
  —— 那是同一类分叉的温床。现在"路径是哪来的"也只有一份判断，调用点只把 `'intent'` 映射成自己的 source 文案。
- **`pre.intent` 可传入**：调用点本来就已经读过 intent（要用它做 `REPO_BINDING_CHANGED` 检查）。
  共用函数再读一次会出现"两次读库、两次判断"的窗口，与本次修复的动机相反。
- **`from==='intent'` 时 `paths` 不做二次规范化**（保持各调用点原有行为；`reserve()`/`inspectContention()`
  自己会用 `toEntryList` 归一）。本次只统一**取法**，不顺手改形状。
- 诊断响应**新增 `pathsFrom` 字段**（读数的来源），便于以后一眼看出"这个判定是基于什么算的"。

## 5. 判据

```bash
node --test team-hub/contention-paths.test.mjs      # 新增：HTTP 层四方向对照（1 例）
node --test team-hub/write-intent-store.test.mjs    # 19 例（新增 1 例：取法本身）
node --test team-hub/write-intent-routes.test.mjs team-hub/claim-reservation.e2e.test.mjs team-hub/claim-policy.test.mjs
```

**HTTP 层四方向对照**（真 hub + 真端点 + 临时库）：

| # | 形态 | 期望 | 为什么必须有这一条 |
| --- | --- | --- | --- |
| ① | 声明 fileDomain、无 intent | `ok:true`，**且同一任务能被 `/api/claim` 认领成功** | 这是缺陷本体；两半都要测（诊断说没事 + 认领真能做） |
| ② | 声明 fileDomain 且**与持有者真重叠** | 仍 `FILE_CONTENTION` | 防止"把真冲突也说成没事" |
| ③ | 有 active intent | 以 **intent** 为准 | intent 优先的既有语义不许被改掉 |
| ④ | 未声明 fileDomain、无 intent | 仍**整仓独占** | 这个方向不许被顺手放宽 |

★ ③ 的构造方式值得记下来：`POST /api/tasks/:id/write-intent` 会强制 **intent ⊆ fileDomain**
（越界 422 `OUT_OF_FILE_DOMAIN`），所以"intent 指向域外目录"这种形态在 API 上**根本不存在**。
能区分两种取法的形态是**收窄**：`fileDomain=["feature/a","feature/c"]` + `intent=["feature/c"]`
—— 按 fileDomain 取会撞上持有者的 `feature/a`，按 intent 取则无冲突。所以 `ok:true` 就是"intent 赢了"的证据。
（我第一版按"intent 指向域外"写，拿到 422 才发现这条约束。）

**反向验证**（逐条改坏 → 必须红 → 还原即绿，全部实测）：

| 改坏什么 | 结果 |
| --- | --- |
| 诊断端点退回 `intent?.paths ?? []`（原缺陷写法） | ✅ 红 |
| 取法忽略 fileDomain（无 intent 一律整仓独占） | ✅ 红 |
| 取法永远用 fileDomain（intent 形同不存在） | ✅ 红 |
| 脏 fileDomain 不再兜底（`JSON.parse` 直接抛） | ✅ 红 |
| fileDomain 回落不再规范成 `{path,type:'dir'}` | ✅ 红 |

连带不回归：`write-intent-store` / `write-intent-routes` / `claim-reservation` /
`claim-policy` / `contention-paths` 共 **67 例**全绿。

### 5.1 一句如实的自我订正

我最初把"`??` 写成 `||`"列为一条反向用例，**它其实不可区分**：空数组在 JS 里是 truthy，
`[] || fallback` 仍是 `[]`。真正要防的不是 `||`，而是把判断写成**长度**形态
（`paths.length ? paths : fallback` / `if (!paths.length)`）—— 那才会把
「没有 intent」与「intent 申报了零个路径」混成一件事。测试里的注释已改成这个说法，
反向用例也换成了真正可区分的"永远用 fileDomain"。（另有一条反向用例失败也是**我的变异写错了**：
`{"not":"an array"}` 是合法 JSON，`JSON.parse` 不会抛；我据此给测试补了"根本不是 JSON"的脏数据。）

### 5.2 第二个自我订正：`live-ab` 自己造过一次**假绿**

`BUG-006-live-ab.mjs` 第一版按"脚本所在目录往上两级"找 `team-hub/team.db`。在 `fix/bugs`
工作树里跑时，那算到的是**工作树自己的**目录 —— 而 `team-hub/team.db` 是 **gitignored 的本地状态，
git worktree 之间不共享它**（工作树里那份是 10-04 的旧副本，933KB）。结果：

```
=== 小结：0 个任务里 0 个的读数在新旧取法下不同     ← 假绿：看着像"没有分叉"
```

**这与我正在修的缺陷是同一个形状**：一个读数在骗人。修正两处：

- 用 `git rev-parse --git-common-dir` 解析主检出（worktree 安全的通用做法），
  并允许 `BUG006_ROOT` 覆盖；`repoId` 改为**从库里取**（原先硬编码机器路径，换个机器
  会算出一堆"无冲突"，是同一个假绿来源）。
- 加护栏：读不到任何任务 / 库里没有任何预约记录 ⇒ **报错退出**，不打印结论。
  反向验证：`BUG006_ROOT=<worktree>` ⇒ **exit 1**，不再输出"0 个不同"。

### 5.3 第三个自我订正（也是最该记的一条）：我用自己否掉过的读数去下了结论

重启后将军问「178/179 有没有真实在运行」。我查库后回答**"没有在运行"**，依据是：

```
run_attempts 全表 0 条
run_events   全表 0 条
```

**这个依据是错的，而且我早就知道它是错的** —— 我在本项目 BUG-003 的记录里写过：

> `run_events` / `run_attempts` 为 0 是**部署事实**（这套部署没在跑 Runtime 执行面），
> 不是本 Bug 的结论。

也就是说，我拿一个**自己已经写进文档否掉过**的指标，当成了"没在干活"的证据。
真实情况恰恰相反（两次采样，间隔 45 秒）：

| | 第一次 | 第二次 |
| --- | --- | --- |
| T-178 工作树最新改动 | 13:42:31 `team-hub/routes/agents.mjs` | 13:43:35 `team-hub/can-read-authorization-source.test.mjs` |
| T-179 工作树最新改动 | 13:42:18 `scratch/t179/FINDINGS.md` | 13:43:49 `scratch/t179/logs/S05-cross-process.txt` |
| T-178 worker 会话 | steps=96 llmMs=418856 | **steps=104 llmMs=443460** |
| T-179 worker 会话 | steps=71 llmMs=453295 | **steps=78 llmMs=497562** |

**两个都在真实运行**：工作树文件在动、子代理的步数与 LLM 时长在涨。

> 这一条比前两条更值得记，因为前两条是"工具写错了"，而这一条是**判断写错了**：
> 我手上有一个可用的判据（工作树 mtime + 子代理会话计数），却先用了那个**已知无效**的。
> 一个已知无效的读数，比没有读数更坏 —— 没有读数时人会去找证据，
> 有一个"看起来是 0"的读数时，人会直接下结论。
> 这也正是本 Bug 自己的形状（诊断端点给出一个**看着像结论**的数），只是这次它在我的流程里复现了。

**为什么这套部署的这两张表恒为 0**（写下来免得下次再踩）：认领走的是 **legacy 路径** ——
attempt 身份是 `write_reservations.attempt_id` 里的 `legacy:T-178:71`，不落 `run_attempts`；
`run_events` 只在 Runtime 执行面（`run_attempts` 驱动的适配层）里产生。
所以在这个部署上，"在不在跑"要问**工作树与子代理会话**，不能问这两张表。

顺带纠正第二处误读：我在同一轮里把日志中反复出现的
`worker 未完成（aborted）` + `comment 失败：TypeError: fetch failed`（13:18–13:28，253 次历史里的这一段）
读成了常驻故障。它们集中在**宿主/中枢重启窗口**（宿主 13:26:31、中枢 13:27:49，那段时间 hub 是断的，
`fetch failed` 完全符合预期），**13:28:21 之后没有再出现**，两名 worker 此后连续运行至今。
不是 BUG-007 那个"每 40 分钟卡死"的形态。

## 6. 边界与遗留

- **生产中枢已重启（2026-10-05 13:27），修复已在生产上生效**（§3.1 的 `pathsFrom` 判据）。
  提交时它还没重启 —— 当时 T-178 / T-179 正在跑且各占一个写入槽，为一条 curl 打断两个在跑的任务
  不划算，所以验证先走隔离实例（临时库 + 真实端点），重启后补了活体对照。
- **T-184 不是"没人认领"，是在排队**：守护每 30 秒重试一次，日志明写
  `T-184 认领失败（文件被任务 T-178 占用：team-hub）`、`inbox=1（T-184）`。
  它与 T-178 的文件域**真的重叠**（T-184：`plugins/src/ team-hub/ docs/bugs/`；
  T-178：`workbench/ security/ orchestrator/ team-hub/ runtime/`），而 T-178 此刻正在改
  `team-hub/routes/agents.mjs` 与 `team-hub/*.test.mjs`。**这正是本次修复后应有的行为** ——
  旧代码会把 T-184 的读数说成"整个仓库被占"，把一次正常的排队说成一个范围大得多的故障。
- **没有顺手改别的**：不动认领/预约语义，不动 `requireTaskDomain`（intent ⊆ fileDomain 那条约束），
  不动 `platformHttpRoutes()` 的路由抽取面。
- **T-183 自身的"卡住"是另一件事，本次修复不解除它**：它原先报的是
  `holder=T-178 (reconciling/task-cancelled)` 那类**残留写入资格**（"取消没有把预约推到终态"）。
  重启后 T-178 已重新认领（`attempt=legacy:T-178:66`、`state=reserved`），那条残留自然消失了 ——
  **是重启与重认领解决的，不是本次修复**，两者不要混为一谈。现在 T-183 报的是
  `holder=T-178 state=reserved`：那是**真实的**文件域冲突（两者都要 `team-hub`），读数正确。
- 我另外确认：`contention` 只看 `write_reservations` 的活跃行（`activeRows`），不看 intent ——
  所以上面 ③ 的"intent 优先"说的是**取哪些路径**，不是"intent 本身构成占用"。
