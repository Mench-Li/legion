# PRT-315（切片 4）：拆分 `plugins/src/index.ts` —— workspace / worktree 隔离

> spec §阶段 3 的 PRT-315 要求「按仓储、状态机、workspace、验收和交接边界拆分
> `plugins/src/index.ts`，**每次只迁移一个切片**」。
>
> 本文件记录**第 4 个切片**：**workspace 边界** —— `spaceWorker()` 里一个任务的独立工作树
> 从建到提交的整条生命周期（`prepareWorktree` / `ensurePrePushGuard` / `commitWorktree`），
> 连它依赖的本 scope workspace 解析（`refreshSpaceBinding` + `repoRootFor` / `workspaceFor` /
> `worktreeRootFor`）。
>
> 第 1 个切片（交接边界：合入调解）见 `PRT-315-slice1-mediation.md` + `plugins/src/mediation.ts`；
> 第 2 个切片（仓储边界：租约回收）见 `PRT-315-reclamation-slice.md` + `plugins/src/reclamation.ts`；
> 第 3 个切片（状态机）见 `PRT-315-state-machine-slice.md` + `plugins/src/stateMachine.ts`。
> 本切片**照它们的形状写**：同样的模块形状、同样的接线风格、同样的用例风格、同一种注释口径。

---

## 1. 搬了什么、没搬什么

**搬走了**（`plugins/src/workspace.ts`，导出 `createWorkspace`）：

| 原位置（`index.ts` 的 `spaceWorker()` 内） | 新位置 |
| --- | --- |
| 「空间仓库绑定」注释块 + `refreshSpaceBinding()`（48 行） | 模块内（逐字，含原始注释） |
| `repoRootFor()` / `workspaceFor()` / `worktreeRootFor()`（3 行 + 3 行 JSDoc） | 模块内，作为模块方法导出 |
| `prepareWorktree()` 的 JSDoc + 函数体（42 行） | 模块内（逐字） |
| `ensurePrePushGuard()` 的 JSDoc + 函数体（29 行） | 模块内（**不导出**：只有 `prepareWorktree` 调它） |
| `commitWorktree()` 的 JSDoc + 函数体（8 行） | 模块内（逐字） |

`index.ts` 侧剩下的是**接线**（改动逐行列在 §2）：一行 `import`、一个仍由本实例闭包持有的
`let spaceBinding`、一个 `createWorkspace({…})` 调用，以及 45 处调用点改名
（`repoRootFor()` → `workspace.repoRootFor()` 等）。

**故意没搬**（每条都说清为什么）：

- **`runGit`（`index.ts` 顶层，约第 357 行）** —— 本切片读它，但不搬。理由两条，写在模块文件头：
  ① 它不专属于 workspace：规范 tombstone、`.git/info/exclude`、产物登记、验收闸门、自动 promote、
  重测换基线，以及切片 1 的 `mediation.ts`（经构造点注入）都走同一个 `runGit`；搬进来就要让这些
  **非 workspace 边界**的代码反向 import 本模块，依赖方向反了。② 它是本切片用例的**替身接缝**：
  `prepareWorktree` 的全部 git 交互都经它一层，于是测试能逐字断言 argv 与顺序而不必真建仓库。
  与切片 3 的 `stageOf` 同一形态：**单一定义留在原处**，由调用点注入。
- **`runWorker` 的派工循环与看门狗** —— 它只是**调用** `prepareWorktree`（4 行：
  `let cwd` / `if (config.isolate)` / `worktreeDir = await …` / `else log(…回退…)`）。
  循环体内还有 subagent 启动、`inflight` 登记、`room()` 并发闸门、提示词组装、看门狗超时与
  `report.summary` 分支——那是 worker 上下文，不是 workspace 边界。搬它会把整台派工机器拖进来。
- **`worktree remove` / `branch -D` 的全部调用点** —— 本切片覆盖的是工作树的**建 / 复用 /
  重新挂载 / 提交**，**不含销毁**。销毁散在三处且都与各自边界绑定：`autoPromote`（合并成功后
  清理，仓储/交接边界）、tester 重测换基线前的清理（验收边界）、以及越界/合并失败时写给将军的
  操作指令文案。它们读 `workspace.worktreeRootFor()` / `workspace.repoRootFor()` 取路径，
  但**不调用**本模块——`createWorkspace` 没有 `removeWorktree` 这个方法。
- **`writeGoalContextMirror` / `ignoreGoalMirrorDir`** —— 目标镜像目录的 `.git/info/exclude`
  写入，虽是 git 操作但不是「任务的工作树在哪」。留在原处。
- **`buildWorkerPrompt` 里的「空间仓库绑定」一行、`writeDaemonStatus` 的 `repo` 段、
  `sweep()` 里 chat 上下文的 `bindingDir` / `bindingMeta`** —— 这三处**非 workspace 边界**的
  读者直接读 `spaceBinding` 的值，所以**绑定值本身仍留在 `index.ts` 的闭包里**，
  本模块只拿到一对 `{ get, set }` 访问器（理由见 §3）。
- **`config` 的三个字段之外的一切** —— 本模块只声明 `repoRoot` / `workspace` / `worktreeRoot`
  的结构性类型，**不 import `Config`**（它是 `index.ts` 里由 zod schema 推出来的值，
  import 会形成真的运行时循环依赖，与切片 1~3 同源）。

---

## 2. 行数与用例

| | 之前 | 之后 |
| --- | --- | --- |
| `plugins/src/index.ts` | 3177 行 | **3069 行**（−108） |
| `spaceWorker()` | 2505 行 | **2396 行**（−109） |
| 新增 | — | `plugins/src/workspace.ts`（271 行）、`plugins/tests/workspace.test.mjs`（568 行） |
| workspace 相关用例 | **0** | **33**（`plugins` 套件 267 → **300**，10 suites） |

`plugins/src/index.ts` 的 diff（`git diff HEAD --numstat`）是 **52 insertions / 160 deletions**。
`_prt-handoff/prt315d-diffclass2.mjs` 把两侧按「新写 / 行内改写 / 随块搬走」重新归类（可复跑）：

- **52 新增** = **17 行新写的接线与注释**（`import` 1、绑定归属注释 4、接线注释 4、
  `const workspace = createWorkspace({…})` 6、`prepareWorktree` 指针注释 2）+ **35 行行内改写**
  （调用点改成 `workspace.x()`、内联绑定类型换成命名类型 `SpaceBinding`、调解接线改成传方法引用）；
- **160 删除** = **35 行与上面一一对应的旧行** + **125 行随四段搬走的旧代码**（121 行非空 + 4 行空行）。

> 一个"净减 108 行"的改动，
> 与一个"净减 108 行、但**这条生命周期第一次可以在不建 git 仓库的前提下被单测**"的改动，
> 在行数上是同一个东西——只不过收益本来就不在行数上（同切片 1~3 的结论）。

用例结构见 §6；**本切片之前 workspace 相关用例数为 0**：

- 根解析：无绑定 / 显式 `worktreeRoot` / 有绑定 / 换绑定即时生效 / **两个实例互不串台**；
- 绑定刷新：hub 未启用不发请求、命中 localDir、非仓库目录回退、未配置置 null、
  **值没变不写不记日志**、请求抛错保持原值、非 200 直接返回、**`useHub`/`hubUrl` 取值函数活性**；
- `prepareWorktree`：全新分支（argv 逐字）、**git 在绑定仓库里执行**、显式 worktreeRoot、
  **复用既有 worktree（argv 为空）**、两次派工复用、**目录被清但分支还在 → 不带 `-b` 重新挂载**、
  **残留空壳清理**（+ 空壳且分支仍在）、四种失败路径（新建失败 / 挂载失败 / git 抛异常 /
  回退契约）；
- pre-push 守卫：脚本内容逐字、**幂等不覆盖**、已有自定义钩子不动、安装失败不阻塞建树；
- `commitWorktree`：argv 逐字、`add` 失败短路、`(err || out)` 兜底。

---

## 3. ★ 每实例状态 + 访问器注入（本切片唯一的状态处理）

`spaceBinding` 是 `spaceWorker()` 闭包里的 `let`，`refreshSpaceBinding()` 每轮扫单会**重新赋值**它。
本切片与切片 2 / 3 的三处不同：

| 状态 | 原形态 | 现在 |
| --- | --- | --- |
| `spaceBinding` | 闭包 `let`（`spaceWorker` 体内，早已是每实例一份） | **注入访问器** `{ get, set }`，值仍由 `index.ts` 闭包持有 |
| `useHub` / `hubUrl` | 闭包 `let`，`detectHub()` 探测成功后**被改写** | 注入取值函数 `() => useHub` / `() => hubUrl` |
| `config` / `scope` / `runGit` / `log` / `activity` | 闭包 `const` / 顶层函数声明 | **传值**（身份稳定） |

三个"为什么"：

1. **为什么写者是本模块，注入的却是访问器而不是「返回新值由调用方回写」**：
   回写会把赋值推到 `refreshSpaceBinding()` 的 `return` 之后（也就是 `log(...)` 之后），
   而原实现的赋值在 `log` **之前**、且只在「值真的变了」时才发生（比较 `localDir` / `repoRoot`
   两项）。访问器让赋值留在**原来那一行**——与 `reclamation.ts` 把 `boot.done` 留在动手之前
   是同一条理由：赋值的**位置**本身是语义。这也让每个读点都**当场取值**，而不是构造时快照。
2. **为什么不能是模块级变量**：`superviseSpaces()` 在**同一进程**里按空间把 `spaceWorker` mount
   成多个子实例（`index.ts` 的 `mountRunner`），它们共用一个模块注册表。模块级绑定会让空间 A 的
   仓库根覆盖空间 B 的——worktree 建进别的仓库，日志里只多一行"绑定刷新"，一处都不报错。
3. **为什么绑定值本身仍留在 `index.ts`**：三处非 workspace 边界的读者直接读它
   （`writeDaemonStatus` 的 `repo` 段、worker 提示词的「空间仓库绑定」行、chat 上下文的
   `bindingDir` / `bindingMeta`）。把所有权搬进来就要连带改这三处——那是本切片之外的改动。

> 一个"每实例一份"的闭包绑定，
> 与一个"每进程一份"的模块级绑定，在只有一个守护实例的部署里是同一个东西——
> 只不过多空间部署下，后者会让第二个空间的 worktree 建进第一个空间的仓库。

这三条各有用例（"两个实例各自持有绑定"、"绑定走取值函数不是快照"、
"`hubUrl`/`useHub` 也是取值函数"）与变异（M8 把 `useHub` 退化成取值快照 → 红 2 条；
M9 见 §7 的**未红**记录）。

---

## 4. 验证一：搬迁**逐字对拍**（5 条改写规则）

脚本：`.worktrees/_prt-handoff/prt315d-compare.mjs`（before 取 `git show HEAD:plugins/src/index.ts`，
工作区那份已被改过）。做法与切片 3 同：按锚点抽段 → 归一化（去纯空行、去公共缩进、去行尾空白）
→ 逐行比较，只放行一份**穷尽的改写规则**（规则而不是"允许出现的字符串清单"）。

| # | 旧（`index.ts`） | 新（`workspace.ts`） | 覆盖的位置 |
| --- | --- | --- | --- |
| ① | `spaceBinding?.` | `binding.get()?.` | 3 个根解析函数 |
| ② | `spaceBinding = next` | `binding.set(next)` | 值变化时的唯一写点 |
| ③ | `if (!useHub) return` | `if (!useHub()) return` | `refreshSpaceBinding` 首行 |
| ④ | `` `${hubUrl}/api/spaces` `` | `` `${hubUrl()}/api/spaces` `` | hub 请求行 |
| ⑤ | `let next: { localDir: string; repoRoot: string; remoteUrl: string } \| null = null` | `let next: SpaceBinding \| null = null` | 命名的绑定类型 |

结果：

| 被搬走的块 | 结果 |
| --- | --- |
| A1 绑定解析（注释 + `refreshSpaceBinding` + 三个根解析函数） | ✅ **41 行**逐字一致 |
| A2 `prepareWorktree` | ✅ **42 行**逐字一致 |
| A3 `ensurePrePushGuard` | ✅ **29 行**逐字一致 |
| A4 `commitWorktree` | ✅ **8 行**逐字一致 |
| 形态自检（每段首行/末行必须落在函数首尾，防止"切歪了但恰好等长"） | ✅ 10/10 |

**对拍脚本自己的元检查**（`prt315d-compare-metacheck.mjs`）：把新模块里的一个日志串改一个字
（`worktree 创建失败` → `worktree 建立失败`）→ 对拍立刻红 1 行、exit 1、**差异行正指向变异处**；
按写前 Buffer 逐字节还原后 sha256 一致、复跑 PASS。

> 一个"永远绿"的对拍，与一个"真的在比对"的对拍，
> 在代码没被动过的时候是同一个东西。

---

## 5. 验证二：断验证 10 组，**9 组咬住、1 组没咬住**

脚本：`.worktrees/_prt-handoff/prt315d-breakverify.mjs`（原始输出留档
`prt315d-breakverify.out.txt`）。每组：改源码 → 重建 → 跑相关套件 → 记录红/绿与失败用例名 →
**按写前 Buffer 逐字节还原**（sha256 校验，`finally` 兜底）→ 重建。

| # | 弄坏什么 | 套件 | 红几条 | 红的是不是目标用例 |
| --- | --- | --- | --- | --- |
| M1 | 新建 worktree 丢掉 `-b` | workspace | 5 | ✔ argv 断言那几条 |
| M2 | 复用判定改成"有目录就复用"（残留空壳永不清） | workspace | 2 | ✔ 两条残留空壳用例 |
| M3 | 从分支重新挂载误加 `-b` | workspace | 2 | ✔ 挂载 argv 那两条 |
| M4 | 新建失败返回目录而不是 `null` | workspace | 2 | ✔ 失败契约 + 回退契约 |
| M5 | 不再装 pre-push 守卫 | workspace | 9 | ✔ 守卫四条 + 依赖首行日志的各条 |
| M6 | commit 失败日志丢掉 `\|\| out` 兜底 | workspace | 1 | ✔ `(err \|\| out)` 用例 |
| M7 | 绑定"值没变也写" | workspace | 1 | ✔ 不写不记日志用例 |
| M8 | `useHub` 从取值函数退化成取值快照 | workspace | 2 | ✔ 两条取值函数活性用例 |
| M9 | 根解析的 `\|\|` 换成 `??` | workspace | **0** | ✖ **未红（覆盖缺口，见下）** |
| M10 | `index.ts` 接线：`worktreeDir` 恒 `null`（已跟踪文件） | worker-regression | 2 | ✔ 端到端两条 `worktree never became ready` |

**M9 未红，如实报告**：`repoRootFor` / `workspaceFor` 现在是
`binding.get()?.repoRoot || config.repoRoot`。把 `||` 换成 `??` 只有在
"绑定存在但字段为空串"时才改变行为——那时 `||` 回退到配置、`??` 返回空串（worktree 会落到
进程 cwd 下的 `.legion-worktrees`）。**没有任何用例构造"绑定字段为空串"这个状态**：
`refreshSpaceBinding` 内部对 `localDir` 做了 `trim() !== ''` 过滤，所以空串绑定在正常路径上
产不出来；只有外部手工写入 `spaceBinding` 才可能出现。也就是说这条断言**只有 M9 这种变异才能
探到**，而它没被探到——这是本切片的一个真实覆盖缺口（不是"变异选得不好"：M9 是我特意选来
检验 `||`/`??` 口径的）。**没有为它补用例**，因为补法只有"给闭包手工塞一个空串绑定"，
那是在测一个正常路径产不出的状态；如实记在这里，而不是把它说成已覆盖。

还原：`sha256(workspace.ts) = 44357cef63af34ad4…`（变异前 = 每轮还原后），还原后复跑
`workspace` 33/33、`worker-regression` 10/10 全绿。

---

## 6. 验证三：逻辑只有一处（按构建产物查，不按源码查）

`prt315d-singleplace.mjs`：构建产物 `plugins/lib/workspace.js` **必须**含 22 条搬运记号
（四条日志/activity 文案、五条失败日志、守卫脚本文案与 marker、绑定刷新文案、
`refreshSpaceBinding` / `repoRootFor` / `workspaceFor` / `worktreeRootFor` / `prepareWorktree` /
`ensurePrePushGuard` / `commitWorktree` 的函数声明）；`plugins/lib/index.js` **必须不再**含其中
**任何一条**；同时**必须**含 11 条接线记号（`from './workspace.js'`、`createWorkspace`、
`binding: { get: () => spaceBinding`、`set: b => { spaceBinding = b`、
`repoRootFor: workspace.repoRootFor, worktreeRootFor: workspace.worktreeRootFor`、
`await workspace.refreshSpaceBinding()`、`await workspace.prepareWorktree(`、
`await workspace.commitWorktree(`、`workspace.workspaceFor()`、`workspace.repoRootFor()`、
`workspace.worktreeRootFor()`）。

结果：**PASS**，且**本切片没有"逻辑两处"的例外**（切片 3 有一个 `stageOf` 的说明，本切片没有——
`runGit` 是"单一定义留在原处由调用点注入"，不是两份实现）。

> 只 grep 源码是不够的：源码里删干净、编译产物里留着的可能性不该靠人去想。

---

## 7. 棘轮：`dsh-parity` 2115 → **2007**（对拍出来的，不是算出来的）

本切片搬走的四段全在锚点**上方**，顶部再多 1 行 `import` → 锚点整体**上移 108 行**。
重钉之前 `parity.test.mjs` 红 **5 条**（含端到端那条）。

按模块自己的方法重新对拍（`prt315d-rederive-parity.mjs`：`extractLegacyCallOptions` +
`LEGACY_CALL_OPTIONS` + `deepEqual`，经 `pathToFileURL` import）：

```
调用点总数 = 4 （上一批记录 4）
各行号 = 1124, 2007, 2220, 2615
  行  1124  选项 = [label, prompt, parent, signal, outputSchema]            ← 无 ...spread
  行  2007  选项 = [label, prompt, parent, signal, outputSchema, ...spread] ← ★ 与期望完全一致
  行  2220  选项 = [label, prompt, parent, signal, outputSchema]            ← 无 ...spread
  行  2615  选项 = [label, prompt, parent, signal, outputSchema, agentOptions]
与期望选项集完全一致的调用点 = 1 个： 2007
★ 新行号 2007（原 2115）——唯一，可安全改写
```

⚠️ **本批的算术（2115 − 108）恰好也等于 2007。**前两批都不是（切片 2 是 +3、"搬的东西在下面"，
切片 3 是 +1）。已把这一点写进 `parity.mjs` 的 `LEGACY_CALL_SITE` JSDoc **内部**
（插在 `*/` 之前——切片 3 踩过插在之后会让 JSDoc 提前闭合、`parity.test.mjs` 变成解析红而非断言红）：

> 锚点动不动，只由**它上面净改了几行**决定；
> "我搬的东西在它上面还是下面"只决定那个净行数是正是负。
> 本批算术恰好蒙对，与对拍出来的读数完全一样——区别只在下一次拆分时才显形。

重跑 `node --test runtime/adapters/dsh/parity.test.mjs`：**36 tests / 0 fail**。

## 8. 棘轮：`dsh-boundary` 未增长（3 个文件 / 26 处）

新模块 `workspace.ts` 只 import `node:fs` / `node:path`，不含任何执行面记号；新用例文件也不含。
`node scripts/ci/dsh-boundary.mjs --check` → `PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）`，
与上一批读数一致。

（执行面记号在本文件脉络里一律写成拆分/拼接形式——`parity.mjs` 已为此打过警告，写成一整串会被记为
「执行面依赖 +1」，那是往坏的方向错的假阳性。本文件因此不写出那串字面量。）

---

## 9. 验证读数（原始输出）

- `npm run typecheck` → exit 0（`tsc -p tsconfig.json --noEmit`，无输出）。
- `npm test`（`plugins`）→ **300 tests / 0 fail / 10 suites**（本批前 267，+33）。
- `git diff HEAD --stat -- plugins/src/index.ts` → `1 file changed, 52 insertions(+), 160 deletions(-)`。
- `node --test runtime/adapters/dsh/parity.test.mjs` → 36 / 0（重钉前 **5 条红**）。
- 门禁（`git add -A` 之后，`DSH_CHECKOUT` 已设）：

```
node scripts/config/scan.mjs --check
scan: PASS（全部 env 读取点与疑似字面量均已处理；共 558 个疑似字面量）
node scripts/ci/ci-syntax.mjs
ci-syntax: PASS（50 个脚本全部可被 Node 解析）
node scripts/ci/encoding-check.mjs --all --quiet
encoding-check: PASS（1932 个文本文件：无 U+FFFD；代码/配置无 NUL 字节；37 个历史采集物为 UTF-16，已列出）
node scripts/ci/check-docs.mjs
check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，10 类校验项全绿）
node scripts/ci/dsh-boundary.mjs --check
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
node scripts/prt/topology-inventory.mjs --diff
topology-inventory: 与清单一致（无漂移）
node scripts/prt/baseline-snapshot.mjs --check
baseline-snapshot: 平台契约与基线一致（无漂移）
```

七道全部 exit 0。上面是**写完本文件之后**复跑的读数（文本文件计数 1929 → **1932**：新增模块 /
测试 / 本文件三个，两次复跑可见 1931 → 1932）。`git add` 对新文件报了
`LF will be replaced by CRLF` —— 仓库 `core.autocrlf=true`，与既有的 `mediation.ts` /
`reclamation.ts` / `stateMachine.ts` 同形，仓库 blob 恒为 LF。

---

## 10. ⚠️ 诚实边界

1. **只完成第 4 个切片，而且"workspace"这一类只做了工作树的「建 / 复用 / 重新挂载 / 提交」。**
   **`worktree remove` / `branch -D` 一行没搬**（见 §1：散在 `autoPromote`、tester 重测、
   越界文案三处，各自属于别的边界）。所以本模块**不是**"worktree 生命周期"的完整归属，
   它只是**前半段**。下一批若要把销毁也收进来，得先把 `autoPromote` 的归属（仓储还是交接）定下来。
2. **`spaceWorker()` 仍是 2396 行**（本批 −109）。按 spec 还留在里面的边界至少还有：
   **验收**（`// 4.2` 经验沉淀、`// 4.3` 置信度晋升、`// 4.4` 规则资产 doctor、`// 4.5a` 技能桥、
   契约文档 / 产物登记、切片流水线编排 `orchestrateSlices`）、**worker 派工与看门狗**
   （`runWorker` 主循环、subagent 启动、`inflight` / `room`）、以及**状态机的其余部分**
   （`advancePipeline`、合入调解的内嵌驱动路径）。这是一次**按边界分批**的迁移，不是"拆完了"。
3. **逐字对拍证明的是"搬对了"，不是"这段代码是对的"。** 它只能证明新旧一致；原有问题会
   **一起**搬过来。本切片现成的例子（照原样保留、未修正）：`commitWorktree` 的 `add` 失败日志
   用 `add.err.trim()` 而**没有** `|| add.out` 兜底（相邻的 commit 与 prepareWorktree 都有兜底
   ——**原实现就这样**，本切片不"顺手统一"，因为那是行为改动）；用例里为此专门写了一条断言，
   目的正是把"现状"钉住而不是把它当成正确。
4. **`runGit` 是替身，真实 git 副作用**（`git worktree add` 真在磁盘上建树、
   `rev-parse --show-toplevel` 真解析仓库、`rmSync` 真的删掉一棵 worktree）**本切片没有直接验证**。
   33 条用例证明的是"我们发出了哪些 argv、在这个返回值下走哪条分支"，**不**证明真实 git 的行为。
   真实副作用的覆盖来自**继承来的**端到端用例（`worker-regression.test.mjs` 里 isolate 那几条会
   真的建 worktree，M10 证明它们确实咬住了这条路径）——那是本批之前就有的证据，不是我加的。
5. **pre-push 钩子的权限位没验。** `writeFileSync(hook, script, { mode: 0o755 })` 的 `mode`
   在 Windows 上不生效，用例只断言脚本**内容**（`#!/bin/sh`、marker、`refs/heads/w/*` 拦截分支
   与 `exit 1`、末尾 `exit 0`），不断言 `mode`；"钩子在真 Linux 上可执行"是**推断**而非测量。
6. **M9 未红（§5）**：`||` → `??` 这条变异没有任何用例咬住。缺口说清了，**没有补用例**，
   因为补法只能靠给闭包手工塞一个正常路径产不出的空串绑定。
7. **断验证只覆盖新用例断言到的东西。** 没断言到的分支本轮既没覆盖、也没被探针检验，例如：
   残留空壳 `rmSync` **失败**时（`catch { /* 清理失败继续 */ }`）是否仍继续走 `rev-parse`；
   `config.worktreeRoot` 为**空串**（zod default 就是 `''`）时 `worktreeRootFor` 的 `||` 回退；
   `refreshSpaceBinding` 里 `res.json()` 抛错与 `res.ok` 为假两条路径的区分；
   绑定变化时 `binding.set` 与 `log` 的先后（有用例钉住顺序吗——**没有**，只钉住了"都发生/都不发生"）。
8. **`prepareWorktree` 的调用点契约只在用例里"照抄"了一遍**（`runWorker` 那 4 行），
   `index.ts` 里真实的 `runWorker` 体并未被单测覆盖——它由 M10 经端到端用例间接覆盖。
9. **`docs/STATUS.md` / `docs/superpowers/prt/PRT-PROGRESS.md` /
   `PRT-IMPLEMENTATION-REPORT.md` 未动**（按任务要求，operator 自己维护），
   所以进度表仍写着"切片 3 已交付"。
10. **编码：** 新文件 `workspace.ts` / `workspace.test.mjs` / 本文件是 LF（与既有三个模块与
    测试文件一致）；`index.ts` 与 `parity.mjs` 保持工作区 CRLF（本批编辑全部用脚本按 `\r\n` 拼回，
    改完复核：`index.ts` 3069 个 CRLF / 0 个裸 LF，`parity.mjs` 593 个 CRLF / 0 个裸 LF）。
    仓库 blob 恒为 LF（git 归一化），`git diff` 里因此看不到行尾噪音。
11. **未运行**：`scripts/ci/run-ci.mjs`（全量 CI，任务明确禁止）、`topology-inventory --record`、
    以及任何 `git commit` / `git push`（工作区改动已 `git add -A`，但**未提交**）。
12. **本文件是新增文档**；`plugins/tests/workspace.test.mjs` 是本批**新增的测试文件**
    （CI 套件自动 glob `plugins/tests/*.test.mjs`，无需改 runner，但 operator 需要知道这个路径）。
13. **切片 3 文档里"承载函数容错：抽出物必须被某个导出函数携带"这条说法，本切片没有重复。**
    本切片的四条搬运段都是**具名函数声明**（不是 `sweep()` 里的裸语句块），
    `createWorkspace` 的返回对象逐字段列出六个方法，不存在"抽出来但没有调用者"的形态；
    用例里有一条断言 `Object.keys(workspace)` 恰好等于那六个名字（多一个少一个都红）。
