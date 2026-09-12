# PRT-306：workspace / worktree 管理

**对应 spec**：§6.4（`PreparingWorkspace`）、§6.10（流水线的第一步是「准备 workspace/worktree」）、§6.11（运行目录按职责隔离）、第 873 行
**交付物**：
- `orchestrator/workspace/index.mjs` —— 规划、建、查、回收（真 `git worktree`）
- `orchestrator/worker/main.mjs` —— `workspaceIsolation` 声明、`workspaceMode` 四态、阶段拿到 lease
- `orchestrator/worker/run.mjs` —— `LEGION_WORKSPACE_DIR`、`resolveWorkspaceStages`
- 套件 `workspace`（24 例，跑真 git）、`workspace-wiring`（9 例）

---

## 1. 在它之前，"准备 workspace" 是一个空函数

状态机要求一次 Attempt 必须走过 `PreparingWorkspace`，而这个阶段一直是
`inPlaceStages()` 的空实现：

```js
prepareWorkspace: async () => ({ kind: 'in-place', note }),
```

当时那样写是**对的**——它明确记下"这一步什么都没做"，而不是假装有隔离。
但它留下的是这个局面：**两个 worker 认领同一个仓库的两条任务时，
它们在同一个目录里改文件**。

由此产生的失败没有一个是报错：

| 现象 | 实际发生了什么 |
| --- | --- |
| "我改的东西莫名不见了" | 另一个 worker 的 `git add -A` 或 `git checkout` 覆盖了它 |
| "这条任务明明上次改坏了，这次却通过了" | 重试继承了上一次留在目录里的半成品改动 |
| "崩了之后不知道它干过什么" | 没人知道上一次尝试在哪个目录里干过活 |

三条纪律各对付一种：

1. **工作区按 Attempt 分配，不按 Task。**
   按 Task 时，重试会拿到同一个目录，于是上一次的半成品改动**看起来像已经改好了**——
   任务在错误的基础上"通过"。
2. **先写意图文件，再做副作用。**
   崩在中间时留下的是"我要在这个槽位建工作区"这条记录，而不是一片空白。
3. **删除是拒绝边界。**
   有未提交改动就拒绝回收；陌生目录一律拒绝覆盖。

---

## 2. 目录布局：worktree 不进仓库

```text
DataDir/worktrees/<scope>/<taskId>/<attemptId>/            ← 槽位（git 创建）
DataDir/worktrees/<scope>/<taskId>/<attemptId>.intent.json ← 意图（我们写）
```

选 `DataDir/` 而不是 `Workspace/`：spec §6.11 把 `Workspace/` 定义为
「用户授权的项目目录」，而 worktree 是运行面派生的中间产物。

顺带解决一个真实缺陷：**worktree 若落在仓库内部，它会出现在主仓库的
`git status` 里**，于是另一个 worker 的 `git add -A` 会把它整棵树提交走。
`planWorkspace` 直接拒绝这种嵌套布局，两个方向都拒：

```js
if (contains(repoDir, worktreeBaseDir) || contains(worktreeBaseDir, repoDir)) {
  throw new WorkspaceError(REF_OVERLAP, '…本模块不靠"记得加 .gitignore"来防这件事')
}
```

也拒相对路径：相对路径按 worker 的 **cwd** 解析，而 worker 可以从任何目录启动
——于是两个 worker 悄悄用了两个不同的仓库，而它们都"看起来正常"。

---

## 3. id 含冒号：`att:<taskId>:<n>`

这是实现中最容易被想当然的一处。

运行面生成的 Attempt id 是（`run-store.mjs`）：

```js
const id = `att:${taskId}:${attemptNo}`
```

**冒号在 Windows 上是非法文件名字符。** 所以"把 id 直接当目录名"这条路
根本走不通——不是"偶尔会遇到脏数据"，而是**每一真实 Attempt 都会**。

必须有一步显式编码，而且必须是**单射**的：

```js
encodeId('att:T-1:2') === 'att%3AT-1%3A2'
encodeId('att-T-1-2') === 'att-T-1-2'      // 与上面不同
encodeId('a%3A')      === 'a%253A'          // `%` 自身也转义
encodeId('a.')        === 'a._'            // Windows 尾部点会被静默截断
```

把冒号替换成连字符那种做法会让前两个撞进同一个目录，而它们可能是两条不同的尝试
——一次重试会覆盖另一次的工作区，且不报错。

同时**拒绝**两类 id，不编码：

- **路径分隔符**（`/`、`\`）：出现在 id 里说明调用方传的是**路径**而不是 id，
  编码只会把这个错误变成一个"看起来正常但指向别处"的目录；
- **`.` / `..`**：会把工作区指到父目录，而那不是报错，是**写到了别的仓库里**。

---

## 4. 意图文件为什么在槽位**外面**

最初的写法是把意图文件放在槽位里（`<slot>/.legion-workspace-intent.json`），
"先写意图"因此需要先 `mkdir` 槽位。实测直接撞墙：

```
git worktree add -b legion/… <slot> HEAD
fatal: '<slot>' already exists
```

`git worktree add` 拒绝往一个已存在的目录里建工作区。于是"先持久化意图"
这条纪律**把要做的副作用本身弄坏了**——一条正确的原则以错误的方式落地。

改成同级：

```text
<taskDir>/<attemptId>.intent.json     ← 意图
<taskDir>/<attemptId>/                ← 槽位，由 git 自己创建
```

两不相扰，且意图文件仍然记着"谁认领了这个槽位"（三个 id + 分支 + baseRef）。
只记路径是不够的：崩后重扫看到一个槽位却答不上"它是哪条尝试的"，
于是只能猜——而猜"没主的，删掉吧"就会删掉别人的成果。

---

## 5. 「git 说成功」≠「工作区可用」

`createWorkspace` 的顺序是刻意的：

1. 读登记表 → 已经是本槽位的 worktree？**复用**（崩后重跑是正常路径）；
2. 有内容但不是已登记的 worktree？**拒绝**（`REF_FOREIGN_SLOT`）；
3. 写意图文件；
4. `git worktree add`；
5. **重读登记表核验**——没有登记就报 `REF_WORKTREE_FAILED`。

第 5 步是「起了但干不了活不能看起来像成功」那条纪律的落地：
没有登记，回收与恢复都找不到这个目录——而 `git` 的退出码是 0。

建失败时收拾**自己刚造出来的**残壳，并 `git worktree prune`：

```js
try { rmSync(plan.slotDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
try { runGit({ cwd: plan.repoDir, args: ['worktree', 'prune'] }) } catch { /* 尽力 */ }
```

这不是"尽力清理"——它清理的是**本次调用自己**刚造出来的东西（上一次 `inspectSlot`
已经确认槽位不存在或是空的），里面不可能有别人尚未提交的成果。
不收的话，下次 `git worktree add` 会报 `already exists`，
这个槽位就**永久性地坏掉**，而它看起来只是"又失败了一次"。有用例专门验这一点。

---

## 6. 回收：删除是不可逆的，因此全是拒绝

| 情形 | 动作 |
| --- | --- |
| 槽位不存在 | `nothing-to-do` |
| 空壳（无内容） | 删掉，`removed-empty-slot` |
| 有内容但不是已登记的 worktree | **拒绝** `REF_UNKNOWN_SLOT` |
| 已登记、有未提交改动 | **拒绝** `REF_DIRTY`，列出文件 |
| 已登记、干净 | `git worktree remove` + 清残留 |
| 读不出改动状态 | **拒绝** `REF_UNKNOWN_SLOT` |

两个细节：

**脏检查覆盖未跟踪文件。** `git status --porcelain` 同时给已跟踪改动与 `??`
未跟踪项，两者都算脏。只看已跟踪改动会漏掉"新建了一堆文件但还没 `add`"
这种最常见的情形。

**`force` 不越过脏检查。** 它只透传给 `git worktree remove`（另有用途：被 lock
的工作区、含子模块的工作区）。一个布尔开关不该成为丢掉别人唯一一份成果的入口。
要丢弃，先显式提交，或由人在文件系统上处理——本模块不提供这条捷径。
用例断言 `force: true` **照样**被拒。

---

## 7. 隔离模式必须可见：`workspaceMode` 四态

"没有隔离"本身不报错。它只在两条任务撞上同一个文件时才显形，而那时已经晚了。
因此 worker 的状态文件里必须写着隔离模式：

```js
workspaceMode: 'enabled' | 'disabled' | 'unknown' | ...
```

判据是**提供者的显式声明** `workspaceIsolation`，不是去猜"有没有
`prepareWorkspace`"：

```js
inPlaceStages()  → { workspaceIsolation: 'none',     prepareWorkspace, buildContext }
worktreeStages() → { workspaceIsolation: 'worktree', prepareWorkspace, buildContext }
```

靠推断会得到一个具体的错：`inPlaceStages()` **同样提供** `prepareWorkspace`，
于是原地执行会被写成 `enabled`——状态文件说"有隔离"，而实际上两个 worker
在同一个目录里改同一份文件。这是这类代码里最坏的一种错。

提供了阶段但**没声明**隔离模式时是 `unknown` 而不是 `enabled`：
`unknown` 会让人去查，默认成 `enabled` 会让没人去查。

`workspaceNote` 一并写进状态文件，承载"为什么没有隔离"：
`disabled` 是结论，理由才是能据以行动的东西。

---

## 8. 抓到的第二个真实缺陷：阶段拿不到 lease

接线的第一次端到端跑出来的是：

```
{"stage":"prepareWorkspace","message":"taskId 不能用作路径片段：undefined"}
```

根因在 worker 的阶段调用点：

```js
// 旧（错）
const step = async (to, run, stageName) => {
  const t = await hub.transition({ … to })
  const detail = await run()          // ← 不传参数
  …
}
```

`execute` 是单独调的（`tagImpl.execute(claimed)`），拿到了 lease；
而 `prepareWorkspace` / `buildContext` 一直是**无参调用**。

这件事之所以一直没被发现：做空的 `inPlaceStages()` **不需要**租约。
它的返回值是常量 `{ kind: 'in-place', note }`，跟是哪条任务毫无关系。
于是"阶段拿不到自己在给哪条任务干活"这个事实被一个恰好不需要它的实现掩盖了。

而真正的工作区阶段**必须**知道 `taskId` / `attemptId`——它就是靠这两个
决定在哪个槽位检出。修法是让 `step` 把 `claimed` 传下去：

```js
const detail = await run(claimed)
```

这条缺陷的表现形式值得记住：它看起来像"参数没传"的调用方错误，
而真实原因是**框架的调用点漏了参数**。一个恰好为空的实现会把这类框架缺陷
藏到下一个真正需要该能力的实现出现为止。

---

## 9. 接线：三种情形，没有一种静默降级

```js
resolveWorkspaceStages({ workspaceDir, dataDir, scope, platform })
```

| 配置 | 结果 |
| --- | --- |
| 没有 `LEGION_WORKSPACE_DIR` | `{ stages: null, reason: '…**不自动退回原地执行**…' }` |
| 配了 | 真的 `worktreeStages`（`repoDir` / `worktreeBaseDir` 一并返回） |
| 布局不合法（嵌套、相对路径） | **在解析时就抛**具名错误 |

最后一行是刻意的：`planWorkspace` 在 `worktreeStages` 里是**惰性**的
（只在 `prepareWorkspace` 被调用时跑）。不等一下的话，布局错误会等到某个 worker
认领了任务、状态已经推进到 `PreparingWorkspace` 时才抛——那时租约在跑，
只能等它过期，而日志里看起来像"这次执行失败了"。因此 `resolveWorkspaceStages`
用探针 id 先走一次规划，让**配置**错误在**接线**时刻暴露。

没有配置时的处理尤其重要：**不自动退回原地执行**。
静默降级会让 Attempt 的证据写着有隔离而实际没有。要原地执行，
调用方必须显式铺 `inPlaceStages()`——那是一个具名的调用点，读代码时找得到。

---

## 10. 测试策略：大部分跑真 git

`git worktree` 的语义太容易记错（"already exists"那条就是），用假 git 测
等于在测自己对它的想象。因此 24 例里绝大多数在临时目录里 `git init` 一个真仓库。

只有三类情形用注入的假 git，因为它们很难用真 git 摆出来：

- git 报告成功但登记表里没有（"起了但干不了活"）；
- git 退出码非 0 / 起不来（没有 git 可执行文件）；
- 登记表里有它但 `git status` 失败（"以为干净"的那条路径）。

按纪律验过会变红：把 `REF_OVERLAP` 检查与脏检查分别换成 `if (false)`，
对应用例立刻红（3 处失败），恢复后 24/24。

---

## 11. 未交付

- **上下文快照（`buildContext`）**：仍是 `{ kind: 'minimal' }`。它是 PRT-401
  （Context Assembler）的范围，不在本批。
- **执行引擎仍未被接上**：`product/orchestrator/worker.mjs` 入口调
  `runWorkerProcess()` 时不传 `executor`，因此进程实际状态是 `no-executor`
  （**不认领**，符合设计）。PRT-306 交付的是"当执行引擎接上时，
  工作区这一步是真的"——它有自己的端到端用例（假 hub + 真 git + 真 worktree）。
- **崩后回收工作区的自动对账**：意图文件 + `git worktree list` 已经够
  回答"这个槽位是谁的"，但**没有人**在恢复扫描里遍历它们并清理过期槽位。
  目前只有显式 `reclaimWorkspace`。这属于 PRT-310（恢复扫描）的扩展，
  而 PRT-310 已交付的部分只覆盖 Attempt 级恢复。
- **`scope` 的来源**：接线上 `scope` 由调用方传入（默认 `'default'`），
  而不是从 claim 里取任务自己的 scope。任务跨空间时槽位会落在 `default/` 下。
  接上执行引擎（PRT-253）时应改成从 claim 取。
- **磁盘占用**：没有任何上限或配额。一个长期运行的目标会留下每个
  Attempt 一个 worktree，直到有人回收。

---

## 12. 复跑方式

```bash
node --test orchestrator/workspace/workspace.test.mjs        # 24 例，真 git
node --test orchestrator/worker/workspace-wiring.test.mjs    # 9 例，接线
node --test orchestrator/worker/worker.test.mjs              # 27 例，循环语义（回归）
node scripts/ci/run-ci.mjs --only test                       # 全套
```
