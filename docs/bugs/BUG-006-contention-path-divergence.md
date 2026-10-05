# BUG-006｜`contention` 诊断端点与认领路径**文件域口径分叉**（读数与事实不一致）

> 对应任务 **T-183**（`general` 于 2026-10-05 11:56 建）。**已修复**：四处（认领/预约/过渡/诊断）
> 现在共用同一个取法 `writeIntentStore.resolvePlannedPaths()`。
>
> ⚠️ **生产中枢（8787）仍跑着旧代码**：修复在 `team-hub/`，需要一次中枢重启才生效。
> 我没有重启 —— 当时 T-178 / T-179 正在跑且各占一个写入槽，为一条 curl 打断两个在跑的任务
> 不值得（详见 §6）。修复本身已在隔离实例上验证到 HTTP 层。

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

## 6. 边界与遗留

- **生产中枢未重启**：修复在 `team-hub/`（诊断端点与 store），8787 上仍是旧代码。
  当时 T-178 / T-179 正在跑且各占一个写入槽 —— 重启会让它们中途看到连接错误，
  而收益只是一条 curl 的现场对照，**不划算**。验证改用隔离实例（临时库 + 真实端点），
  这反而比现场 curl 更能**隔离变量**。重启由将军决定时机。
- **没有顺手改别的**：不动认领/预约语义，不动 `requireTaskDomain`（intent ⊆ fileDomain 那条约束），
  不动 `platformHttpRoutes()` 的路由抽取面。
- **T-183 本身仍被卡住，且与本次修复无关**：它的 `contention` 报的是
  `holder=T-178 (reconciling/task-cancelled)` 那类**残留写入资格**（见 T-183 记录），
  属于"取消没有把预约推到终态"的另一件事。本次修复**不会**解除它的等待。
- 我另外确认：`contention` 只看 `write_reservations` 的活跃行（`activeRows`），不看 intent ——
  所以上面 ③ 的"intent 优先"说的是**取哪些路径**，不是"intent 本身构成占用"。
