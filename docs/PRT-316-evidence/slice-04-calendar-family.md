<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 4：第四族（calendar / 日程日历）—— 生成器通用化，并在生成期就核对注入面

> 业主 2026-09-20 裁决：「乙：按一片一次对拍开工」，照 `PRT-315` 先例逐片提取。
> 硬约束（`spec :1282`）：**每片能独立对拍与回滚**。
> 切片 1 = `db8e2cc`；切片 2 = `3aec3cd`；切片 3 = `993853a`。

## 0. 挑这一族的理由：既有判据**质量**最高

剩下各族里 `calendar` 不是最大的（6 条），但它是最**内聚**的（51 行连续跨度，整段就是
`/api/calendar/*`），而且它自带的 `calendar.test.mjs` 是**真 HTTP 面**（`listen(0)` + `fetch`）、
**29 例**、6 条路由**全覆盖**（含全部 400 路径）。

> 一片的"判据质量"决定了这一片能问出多少东西：
> 一个 29 例全覆盖的真 HTTP 套件，与一个只 import DAO 的套件，
> 在"搬家后全绿"这个读数上是同一个东西——只不过后者对路由接线**什么也没说**。

搬完这一片，`/api/calendar/*` 也只住一个地方（`handle` 里同前缀残留实测 **0**）。

## 1. 判据一：生成器**通用化**，并新增一道生成期自检

切片 3 的 `gen-chat-routes.mjs` 是为 chat 写死的。这一片改成
`.worktrees/_prt-handoff/gen-family.mjs`（用法 `node gen-family.mjs calendar`），
并按切片 3 的教训加了两道**生成期**自检：

| 自检 | 拦的是什么 |
| --- | --- |
| ① 按**路径前缀**取族（不按注释文本） | 切片 3 用注释文本定位，而 `// ── 对话中心（chat）` 在本文件出现 3 次，第一版取到建表段 ⇒ 生成 0 条路由的空模块而 `node --check` 照样通过 |
| ② **函数体里每个被调用的名字都必须登记**（注入项 ∪ JS 内建），否则生成器**直接失败** | 切片 2 我就漏过一次注入项（`checkPermission`），是运行时才炸出来的 |

> 一个"忘了一个注入项"的模块，与一个"注入项齐全"的模块，
> 在 `node --check` 通过时是同一个东西——直到那条路由第一次被调用。

外加一道反向核对：**登记了却没被用到的注入项**也报错（防配置过期）。

### 1.1 顺手破验了这两道自检本身

一个从没红过的检查，与一个装饰性的检查，在"每次都通过"这个读数上是同一个东西：

| 变异 | 结果 |
| --- | --- |
| G1 注入项少登记一个 | ✔ 咬住（`生成期核对失败：函数体里有未登记的调用`） |
| G2 前缀写错（取不到路由） | ✔ 咬住（`一条路由都没取到`） |
| G3 ref 指向已被搬走的版本 | ✖ **不是漏网，是真阴性**——当时 `HEAD` 尚未含本片，源头还没被搬空。已记下，**提交后重测** |

★★ 跑这个破验时踩到一个值得单记的坑：第一版把"还原受试文件"写在**变异之后**，
而那次进程被 `Select-Object -First` 提前关闭管道打断（EPIPE）⇒ **`gen-family.mjs`
留在被破坏的状态**（`ref: 'HEAD'`），而第二次运行时 `ORIG` 已经是坏的那份，"还原"成了空操作。

> 一个"先破坏、后还原"的破验，与一个"把受试文件改坏"的脚本，
> 在被中断的那一次是同一个东西。

修法：还原放进 `try/finally`（本片之后所有破验脚本一律如此）。

## 2. 判据二：破验第一轮 6/10 —— 而其中**一条是真的跨空间泄漏**

| # | 变异 | 第一轮 | 补判据后 |
| --- | --- | --- | --- |
| K1 | events 列表忽略 scope | ✔ | ✔ |
| K2 | events 列表忽略 from/to 窗口 | ✔ | ✔ |
| K3 | conflicts 去掉「缺少参数 scope」护栏 | ✖ | ✔ |
| K4 | conflicts 的 allDay 判定写反 | ✖ | ✔ |
| K5 | conflicts 丢掉 excludeId | ✔ | ✔ |
| K6 | by-link 丢掉 taskId | ✔ | ✔ |
| K7 | by-link 丢掉 from/to（锚点缩进写错，第一轮未跑） | — | ✔ |
| K8 | create 丢掉 by | ✔ | ✔ |
| K9 | update 挂到 create 上 | ✔ | ✔ |
| K10 | delete 挂到 update 上 | ✔ | ✔ |

### 2.1 K3 是真缺口，而且实验结论与"读代码的直觉"相反

既有用例只打 `?start=…`（**不带 scope**）。直觉是"不带 scope 时 `scopeParam` 为 `null`，
去掉护栏后 `null.trim()` 会抛错 ⇒ 仍然 400 ⇒ 观测等价"。

**实测推翻了它**（两个空间各造一条同窗事件，独立进程避免 ESM 缓存）：

| | 不带 scope | 空 scope（`?scope=`） |
| --- | --- | --- |
| 护栏在 | 400「缺少参数 scope」 | 400「缺少参数 scope」 |
| 护栏**去掉** | 400（**但换了个原因**：`Cannot read properties of null (reading 'trim')`） | **200，且同时返回 `leak-a` 与 `leak-b` 两个空间的事件** |

`listCalendarEvents({ scope: undefined })` **不加 scope 条件** ⇒ 返回**所有空间**的候选。

> 一个"护栏没了、但因为另一处 null 解引用恰好还是 400"的读数，
> 与一个"护栏还在"的读数，在 `assert.equal(status, 400)` 上是同一个东西——
> 只不过前者把跨空间查询放行了。

### 2.2 这个实验自己也差点给出错误结论

第一版把两次探测放在**同一个进程**里，而 ESM **有模块缓存**：第二次 `import` 是空操作，
于是"注入了 K3"那一轮跑的其实还是原样的模块。读数长得像"K3 观测等价"
（错误信息一模一样），而真相是**变异根本没生效**——同一件事还表现为事件被重复插入。

> 一个"变异没生效"的实验，与一个"变异观测等价"的结论，在日志上是同一个样子。

第二版改成子进程自我派生；子进程退出时会撞一个 libuv 断言
（`!(handle->flags & UV_HANDLE_CLOSING)`，关 server 后立刻 `process.exit` 的老问题），
那是**收尾产物**而非探测失败 ⇒ 判定改为"有没有打出 PROBE_JSON"，而不是退出码。

★ K4（allDay 判定写反）判为**观测等价**，但**方法是读代码**：`allDay` 只影响候选窗的**取宽**
（`winFrom = allDay ? dayStart : addDays(dayStart,-1)`），多取到的候选随后仍要过内存重叠判定。
**未做实验证明**，故标明为推断；本片只把"查询串→allDay 的忠实透传"钉住。

## 3. 补 6 条缝上契约 ⇒ 破验 10/10

`team-hub/calendar.test.mjs` 末尾追加（**不新建文件**，理由同切片 2/3）：

| # | 判据 |
| --- | --- |
| ① | 6 条路由逐条接线：正向 1 次 + **反向**其他 DAO 一个都不许碰 |
| ② | 方法/路径不匹配 ⇒ `false`；等值路由不吞前缀；`conflicts` 只读 |
| ③ ★★★ | **空 scope（`?scope=` / `?scope=%20` / 不带）必须 400，且不许发起查询**（K3 的正解） |
| ④ | `allDay` 从查询串忠实透传（`1`/`true` ⇒ true，其余 ⇒ false） |
| ⑤ | `events` 的 scope/from/to 透传、缺省为 `undefined`；`by-link` 的 taskId/goalId/from/to |
| ⑥ | 三条写路由各自落到**不同**的 DAO，且 `by` 由 `handleWrite` 注入 |

29 → **35/35**；破验 **10/10 咬住、0 漏网**；逐字节还原后复绿。

## 4. 判据三：全量回归

`team-hub/` 下所有 import 了 `server.mjs` 的套件：
**51 个 / 794 例 / 794 pass / 0 fail**（切片 3 时 788，+6 = 本片新增）。

## 5. 规模（同一套计数逻辑，前后都量）

| 量 | 切片 1 后 | 切片 2 后 | 切片 3 后 | 切片 4 后 | Δ（本片） |
| --- | --- | --- | --- | --- | --- |
| `server.mjs` 行数 | 9218 | 9201 | 9081 | **9033** | **−48** |
| `handle()` 行数 | 4210 | 4187 | 4059 | **4005** | **−54** |
| `handle` 里路由条件 | 186 | 181 | 168 | **162** | **−6**（正好一族） |
| `router.dispatch` 调用点 | 1 | 2 | 3 | **4** | +1 |

累计相对原始 `server.mjs`（9221 行）：**−188 行**。

## 6. 门禁

九道门禁 **9/9 `exit=0`**；`baseline-snapshot` **25/25**、`boundary-facts` **44/44**、
`intervention-coverage` **17/17**。

切片 1 的教训第三次生效：本片在 `--record` **之前**先登记第四族
⇒ `--check` 只报 `~ 源文件已变更`、**无任何 `- 路由:` 行**。
基线仍 **188** 条路由，6 条 calendar 路由齐全，四个族模块哈希齐全。

## 7. 这一片**没有**做

| 没做 | 为什么 |
| --- | --- |
| 域逻辑（`listCalendarEvents` / `findCalendarConflicts` / `listCalendarEventsByLink` / `createCalendarEvent` / `updateCalendarEvent` / `deleteCalendarEvent` / `parseCalendarTime` / `eventToObj` …）仍在 `server.mjs` | 本片只搬**路由** |
| 其余 **162** 条路由条件仍在 `handle()`；`handle` 仍 **4005 行** | 一片一族 |
| K4 的**实验**证明（本片只做了读代码推断） | 补它需要在 DB 里构造"多取候选会翻转结论"的样本；本片用"忠实透传"代替 |
| `parseCalendarTime` 的 `d<=31` 只校验上界（`2026-02-31` 会过）——它在**函数名下**记着"parseCalendarTime 只保证格式，日历有效性由建表约束兜底" | 那是既有语义，不是本片引入；本片不动它 |
| `handle` 里最大的一块 `runtime` 段（26 条、跨度 2498 行、**分散**） | 不内聚，不适合整段搬 |

## 8. 可复核判据

```bash
cd <repo>
node --test team-hub/calendar.test.mjs                # 35/35（29 既有 + 6 新）
node .worktrees/_prt-handoff/pair-routes.mjs          # 四族逐字对拍（按位置）
node .worktrees/_prt-handoff/mutate-slice4.mjs        # 破验 10/10
node .worktrees/_prt-handoff/mutate-generator.mjs     # 生成器自检的破验 G1/G2
node .worktrees/_prt-handoff/gen-family.mjs calendar  # 生成器可重跑（源头是 git ref）
node scripts/prt/baseline-snapshot.mjs --check        # 无漂移
```
