# PRT-315（切片 2）：拆分 `plugins/src/index.ts` —— 租约回收（仓储边界）

> spec §阶段 3 的 PRT-315 要求「按仓储、状态机、workspace、验收和交接边界拆分
> `plugins/src/index.ts`，**每次只迁移一个切片**」。
>
> 本文件记录**第 2 个切片**：**仓储边界** —— `spaceWorker()` 每轮扫单开头对在办租约做的
> 两件事：`// 0. 认领租约回收`（stale/TTL 释放）与 `// 0.5 守护重启孤儿回收`（仅第一轮）。
>
> 第 1 个切片（交接边界：合入调解）见 `PRT-315-slice1-mediation.md`；
> 代码在 `plugins/src/mediation.ts` + `plugins/tests/mediation.test.mjs`。本切片**照它的形状写**。

---

## 1. 搬了什么、没搬什么

**搬走了**（`plugins/src/reclamation.ts`，导出 `createReclamation`）：

| 原位置（`index.ts` 的 `sweep()` 内） | 新位置 |
| --- | --- |
| `// 0. 认领租约回收` 整段（含注释） | `reclaimStaleLeases(byId)` |
| `// 0.5 守护重启孤儿回收` 整段（含注释） | `reclaimBootOrphans(tasks, byId)` |
| `if (!bootReconciled) { bootReconciled = true` 闸门 | `if (boot.done) return` / `boot.done = true`（见 §3） |

**故意没搬**（仍在 `spaceWorker()` 里，由构造点注入）：

- `hubPost` / `runTaskctl` / `log` / `activity` —— 它们要写 hub、要 fork 子进程、要写
  `activity.jsonl`，属于 worker 的上下文。回收模块只声明「我需要一个能发任务池写请求的东西」。
- `scope` / `config` —— `scope` 在 `spaceWorker()` 里是 `const`（第 795 行），`config` 是
  构造期固定的 `Config`，**传值**。这与 `mediation.ts` 对它们的处理一致。
- `mediating` —— 与调解模块**共用同一份** `Set`，搬进去会变成两份（同 `mediation.ts` 的理由）。
- `claimedByUs` 筛选函数 —— 只服务 `// 0.5` 这一段，随它一起搬。
- `byId` / `tasks` —— 它们是**本轮扫单的数据**，不是模块状态，因此作为**每次调用的参数**传入，
  而不是构造时注入。这样"模块有没有跨轮残留状态"这件事一眼可答：只有一个 `boot` 对象。
- `isPipeline` / `useHub` —— **传取值函数，不传值**（见 §4）。

`index.ts` 的调用点变成两行，顺序即原来的 `// 0.` → `// 0.5`：

```ts
await reclamation.reclaimStaleLeases(byId)
await reclamation.reclaimBootOrphans(tasks, byId)
```

---

## 2. 行数与用例

| | 之前 | 之后 |
| --- | --- | --- |
| `plugins/src/index.ts` | 3318 行 | **3292 行**（−26） |
| 新增 | — | `plugins/src/reclamation.ts`（182 行）、`plugins/tests/reclamation.test.mjs`（372 行） |
| 回收相关用例 | **0** | **19**（`plugins` 套件 209 → **228**） |
| `spaceWorker()` | 约 2752 行（485–3236） | 约 2725 行（486–3210） |

对被搬走的那 44 行而言，`index.ts` 净减 26 行：**删 44、加回 18**——
`import` 1 行、状态对象声明净 +1 行、接线 12 行、调用点 4 行。

> 一个"净减 44 行"的改动，
> 与一个"净减 26 行、但依赖关系第一次被写在接口上"的改动，在行数上不是同一个东西——
> 只不过后者的收益本来就不在行数上（同切片 1 的结论）。

真正的收益仍然在用例数那一列：这两段此前住在约 2750 行的闭包里，从闭包隐式捕获
`config` / `log` / `useHub` / `isPipeline` / `hubPost` / `runTaskctl` / `activity` /
`mediating` / `scope` / `byId` / `bootReconciled`，单测的唯一办法是**把整个守护跑起来**。
而它们做的是**任务池的写操作**：把别的 worker 正在办的任务放回 `todo`。

---

## 3. ★ `bootReconciled`：为什么是显式状态对象

原代码是闭包里的 `let`：

```ts
let bootReconciled = false
...
if (!bootReconciled) {
  bootReconciled = true
  ...筛选 + 释放 + 同步快照...
}
```

它必须**跨模块边界**保持三个语义，缺一不可：

1. 初值 `false`；
2. 第一次进入时**先置 `true`**——原代码的赋值在 `try` **之前**，异常被内层 `catch` 吞掉，
   标志不会回退（"这一轮做过了"= 尝试过，不是"成功过"）；
3. 只对**本实例**生效。

实现：把状态提升为显式对象 `BootReconcileState = { done: boolean }`，由 `spaceWorker()` 创建
（`const bootReconcile: BootReconcileState = { done: false }`）、构造时注入，模块只读改它的字段；
函数内部是 `if (boot.done) return` / `boot.done = true`。

**为什么不是模块级变量**（这是本切片最要紧的一条）：

`superviseSpaces()` 会按空间把 `spaceWorker` mount 成**同一进程内的多个子实例**
（`index.ts` 的 `mountRunner`）。一个模块级 `let bootReconciled` 会被第一个扫单的空间守护置位，
**其余空间的守护从此再也不会做开机孤儿回收**——它们的重启孤儿只能干等满 `staleMinutes`
（默认量级是分钟到小时），而日志里一行都不会有。

> 一个"每实例一份"的闭包变量，
> 与一个"每进程一份"的模块级变量，在只有一个守护实例的部署里是同一个东西——
> 只不过多空间部署下，后者会让第二个空间的开机回收**静默地不发生**。

这条有专门的用例（"两个实例各自持有闸门"）与专门的变异（M4：把闸门改成模块级变量 → 红 11 条）。

**为什么不是"返回新值由调用方回写"**：那会把置位推到 `await` **之后**——调用方拿到返回值才能写回，
于是"动手之前就算做过了"这条语义消失，窗口期内一旦被重入就会重复回收。
`sweep()` 的 `sweeping` 闸门只保护**同一实例**，挡不住这类"顺序被改"的问题。
状态对象让置位留在**原来的那一刻**，只是所有权变显式了。

---

## 4. ★ 两个取值函数：`useHub` / `isPipeline`

`mediation.ts` 已经踩过这个坑，这里是同一类东西的另外两个实例：

- `useHub` 是 `let`，`detectHub()` 探测成功后改写它；
- `isPipeline` 是 `let`，`applyPipeline()` 换流水线来源时**重新赋值**。

传值 = 模块从构造那一刻起看着一份冻结的旧快照，**不报错**：

- `useHub` 快照 → hub 部署下守护一直去 fork `taskctl release-stale`（守护直连本地库，
  多存储部署下会碰别的任务池）；
- `isPipeline` 快照 → 开机孤儿回收的"本守护认领"判定一直按单角色来，
  `soldier === 任务阶段角色` 的孤儿**全被漏掉**，干等 `staleMinutes`。

`scope` / `config` / `mediating` 则传值（前两个是 `const`，第三个对象身份稳定、内容会变）——
与 `mediation.ts` 对 `mediating` 的处理一致。

---

## 5. 验证一：编译产物**逐字对拍**

脚本：`.worktrees/_prt-handoff/prt315b-compare.mjs`（本切片不复用切片 1 的脚本：
切片 1 搬的是**具名声明**，可以按名字抽；本切片搬的是 `sweep()` 里两段**无名语句块**，
只能按原始注释锚点抽）。

做法：拿本批**之前**构建的 `lib/index.js`（已留存快照），按注释锚点 + 大括号配平抽出那两段；
再构建新版，抽出 `lib/reclamation.js` 里对应函数的函数体；归一化缩进后逐字比较。
只放行一份穷尽的改写白名单：

```
useHub        →  useHub()
isPipeline    →  isPipeline()
（// 0.5 的闸门两行）if (!bootReconciled) { bootReconciled = true  →  if (boot.done) return; boot.done = true
```

白名单写成**改写规则**而不是"允许出现的字符串清单"——理由同切片 1。

结果：

| 被搬走的块 | 结果 |
| --- | --- |
| `// 0. 认领租约回收`（17 行编译产物） | ✅ 差异**仅在已声明的注入改写内** |
| `// 0.5 守护重启孤儿回收`（27 行编译产物） | ✅ 差异**仅在已声明的注入改写内** |
| 新 `index.js` 不再含 `/api/release-stale`、`release-stale`、`orphans`、`claimedByUs`、两条日志串 | ✅ 全部不在 |
| 新 `index.js` 按 `0.` → `0.5` 顺序调用 | ✅ |

**对拍脚本自己的元检查**（`prt315b-compare-meta.mjs`）：把模块里一条日志串
`守护重启孤儿回收 → todo（下轮重新认领续做）` 改成 `守护重启孤儿回收 -> todo`，
对拍立刻红 1 行、exit=1，打印出旧/新两行原文。

> 一个"永远绿"的对拍，与一个"真的在比对"的对拍，
> 在代码没被动过的时候是同一个东西。

---

## 6. 验证二：断验证 5/5（每个变异都咬住"那条"用例）

脚本：`.worktrees/_prt-handoff/prt315b-breakverify.mjs`。判据不是"红了就行"，
而是**红的是哪条用例**；每个变异后源码**逐字节还原**（sha256 校验，`finally` 兜底）。

| # | 弄坏什么 | 红的用例 | 红几条 |
| --- | --- | --- | --- |
| M1 | `if (boot.done) return` 失效（第二次调用照样回收） | `★★ 重启孤儿回收只在第一轮跑`；`★ 闸门在动手之前置位` | 2 |
| M2 | 释放后不再同步快照（`// 0.` 那处 `status/soldier/claimedAt`） | `★ 释放后同步本轮快照` | 1 |
| M3 | 闸门置位挪到释放**成功之后**（抛错那轮被当成没做过） | `★ 孤儿回收自己的失败不吞整个 sweep`、`★ 闸门在动手之前置位`、`孤儿为空` | 3 |
| M4 | 闸门改成**模块级**变量 | `★ 两个实例各自持有闸门` 等 | 11 |
| M5 | `isPipeline` 退回构造时快照 | `★ isPipeline 也走取值函数` | 1 |

M4 红了 11 条是本批最值得记的一条读数：模块级闸门不只让"多空间"用例红，
它让**整个测试进程里后续的每个 harness** 都被串台（同一个测试文件里 12 个用例共享一个进程）。
这正是多空间部署里会发生的事，只是那里换成了空间的守护实例。

还原：`sha256(reclamation.ts) = 8f4a8302253f1f6dd087f0793db5574569f0b6897d54ffc516f3c866eac8c701`
（变异前 = 变异后 = 还原后），构建产物随之重建。

---

## 7. 写用例时撞到的两件事

### 7.1 闸门会挡住"第二次观测"

写 `isPipeline` 活性用例时，第一版第二段调用**永远进不去**——被 `boot.done` 挡住了。
这不是实现的问题，是用例的问题：**闸门与筛选是两件正交的事**，
不显式放开闸门，那条用例实际上在测闸门（而且会绿）。

修法是测试里显式 `h.boot.done = false`（状态对象归调用方持有，测试也是调用方），
并在用例里写清为什么。

> 一个"忘了放开闸门"的活性用例，
> 与一个"真的验证了口径会变"的用例，在活性实现正确时读数相同——
> 只不过前者在活性实现错误时也是绿的（因为它根本没走到第二次判定）。

### 7.2 夹具改 `deps.hubPost` 是**无效**的

模块在构造时就把 `hubPost` / `useHub` 这些**值**取走了（`const { hubPost } = deps`）。
所以 `h.deps.hubPost = 别的函数` 对被测模块毫无影响——用例"看起来改了行为"，实际什么都没改。

改成：替身挂在**调用时才读**的 `opts` 对象上，用例改 `opts` 的字段。
这与切片 1 那条教训同族（"在同一个 Map 上增删" vs "换掉整个 Map"）：

> 一个"改的是 deps 上的字段"的夹具，
> 与一个"改的是取值函数背后的那个值"的夹具，在被测模块构造时就快照了 dep 的情况下
> 是同一个东西——只不过前者会让"改了行为"的用例根本没改行为。

---

## 8. 新增用例清单（19 条）

静态契约 1 · 分派与参数 3（hub / 本地 / `useHub` 取值函数活性）·
快照同步与释放列表边界 3（含 activity 文本与顺序、空 `released`）·
失败路径 3（`// 0.` 抛错不打断 `// 0.5`、本地模式各自日志串、孤儿回收失败不抛）·
`boot` 闸门 3（第二次不再发请求、抛错也算做过、两实例各自持有）·
孤儿筛选 4（五类过滤、空孤儿不发请求、流水线多认角色、`isPipeline` 取值函数活性）·
本地模式孤儿回收参数 1 · 日志/事件 1。合计 **19**。

---

## 9. 验证读数

- `npm run typecheck`：exit 0（无输出）。
- `npm test`（`plugins`）：**228 tests / 0 fail**（本批前 209，+19）。
- `index.ts` diff：`1 file changed, 20 insertions(+), 46 deletions(-)`。
- 门禁（`git add -A` 之后，`DSH_CHECKOUT` 已设，原始输出）：

```
node scripts/config/scan.mjs --check
scan: PASS（全部 env 读取点与疑似字面量均已处理；共 558 个疑似字面量）
node scripts/ci/ci-syntax.mjs
ci-syntax: PASS（50 个脚本全部可被 Node 解析）
node scripts/ci/encoding-check.mjs --all --quiet
encoding-check: PASS（1926 个文本文件：无 U+FFFD；代码/配置无 NUL 字节；37 个历史采集物为 UTF-16，已列出）
node scripts/ci/check-docs.mjs
check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，10 类校验项全绿）
node scripts/ci/dsh-boundary.mjs --check
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
node scripts/prt/topology-inventory.mjs --diff
topology-inventory: 与清单一致（无漂移）
node scripts/prt/baseline-snapshot.mjs --check
baseline-snapshot: 平台契约与基线一致（无漂移）
```

七道全部 exit 0。（另：`git add` 对三个新文件报了 `LF will be replaced by CRLF`
——仓库 `core.autocrlf=true`，与既有的 `mediation.ts` / `mediation.test.mjs` 同形，
仓库 blob 恒为 LF。）

---

## 10. ⚠️ 诚实边界

1. **只完成第 2 个切片，而且"仓储"这一类也只做了租约回收一块。**
   任务池的读路径（`listTasks` / `getTask` / `refreshSpaceBinding`）、`byId` 的构建、
   空间仓库绑定缓存等仍在 `spaceWorker()` 里。状态机 / workspace / 验收三类边界**一行都没动**。
2. **逐字对拍证明的是"搬对了"，不是"这段代码是对的"。** 它只能证明新旧一致；
   代码里原有的问题会**一起**搬过来。本切片里就有一个现成的例子（照原样保留、未修正）：
   本地模式的孤儿回收只传 `--older-than 0`，**不传 `ids`**；而 hub 模式传了 `ids`。
   也就是说两种模式下"这一轮到底释放了哪批任务"并不相同。这是**原实现的行为**，
   本次改动的全部意义是行为零变化——"顺手修好它"是另一个改动。
3. **`spaceWorker()` 仍是约 2725 行。** 顺带更正切片 1 文档里的一个数字：
   `PRT-315-slice1-mediation.md` §9 写"`spaceWorker()` 仍是约 2600 行"，
   按 `git show HEAD:plugins/src/index.ts` 实测，切片 1 之后它是第 485–3236 行、约 **2752** 行。
   （本文件没有改那份文档——它不属于本切片。）
4. **断验证的 5 个变异只覆盖新用例断言到的东西。** 没有断言到的分支本轮既没覆盖、也没被探针检验，
   例如：hub 返回的 `released` 不是数组、`res` 不是对象、`byId` 里存在同 id 的重复项、
   `config.staleMinutes` 为 `0`/`NaN` 时的文案。
5. **多空间那条不变量只有替身证据，没有真实部署证据。** "两个空间的守护各自做开机回收"由
   替身用例（每实例一个 `boot` 对象）+ 代码形态（对象在 `spaceWorker()` 闭包里创建）证明；
   我没有在真实多空间 hub 部署里观察过它。
6. **`reclaimBootOrphans(tasks, byId)` 的两个参数理论上可以不一致**（原实现里它们来自同一份
   `tasks`）。模块不做一致性检查——**原样保留**，调用点目前传的是同一份。
7. **端到端覆盖是"继承"来的，不是本批加的。** `worker-regression.test.mjs` 等真实守护用例
   每轮扫单都会走这两段，所以这次重构有端到端证据；但那些用例是本批之前就有的，
   覆盖的是主路径，不覆盖 §8 的边界分支。
8. **没有更新 operator 所有的进度文件。** `docs/STATUS.md` / `docs/superpowers/prt/PRT-PROGRESS.md` /
   `PRT-IMPLEMENTATION-REPORT.md` 按任务要求未动，所以 PRT-315 的进度表仍写着"切片 1 已交付"。
9. **编码：** 新文件是 LF（与 `mediation.ts` / `mediation.test.mjs` 一致），
   `index.ts` 保持工作区 CRLF（本批所有编辑都逐行验证了 CR/LF 计数不变）；
   仓库 blob 恒为 LF（git 归一化），`git diff` 里因此看不到行尾噪音。
10. **未运行**：`scripts/ci/run-ci.mjs`（全量 CI）、`scripts/prt/*` 的 break-verification 脚本、
    `topology-inventory --record`（均按任务要求）。
11. **`docs/superpowers/prt/PRT-315-reclamation-slice.md` 是本批新增的文档**；
    `plugins/tests/reclamation.test.mjs` 是本批**新增的测试文件**（CI 套件自动 glob
    `plugins/tests/*.test.mjs`，无需改 runner，但 operator 需要知道这个路径）。
