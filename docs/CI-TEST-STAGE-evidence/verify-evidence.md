<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **CI test 阶段恢复时**（2026-09-10）的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· [docs/CONFIG.md](../CONFIG.md)（统一配置）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# CI `test` 阶段永久挂起 · 修复与证据

**切片**：修掉 `run-ci --only test` 的永久挂起，让全量测试基线恢复为「单命令可复现」
**日期**：2026-09-10
**起因**：`docs/REMAINING-TASKS.md` 待办候选 #1（P2-7 证据 §7 早有根因记录与「最小修法建议」，但一直未实施）
**改动**：`workbench/src/api.ts`、`workbench/scripts/notify-hub-smoke.test.mjs`、`scripts/ci/run-ci.mjs`、
`team-hub/server.mjs`、`team-hub/config-schema.mjs`、`workbench/scripts/serve.mjs`、`workbench/scripts/config-schema.mjs`、
`whiteboard/apps/server/src/index.js`、`whiteboard/apps/server/src/config-schema.mjs`
**证据**：`.ci/hang-full/`（**七个阶段全 PASS** 的完整运行）、`.ci/hang-test3/`（`--only test` 全绿）

---

## 1. 结果先说

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| `run-ci --only test` | **永不结束**（零输出、永久等待；无法产出全量基线） | **PASS，160s 跑完** |
| 套件/用例 | 只能用「逐套件单跑」拼凑，长期滞后 | **38 套件 / 924 用例全 PASS**（同一次运行） |
| 完整门禁 | — | `env / deps / build / test / smoke / stage / doc` **七阶段全 PASS** |
| 失败可观测性 | 失败套件只留 6 行摘要，偶发失败无法定性 | 原始输出落盘 `.ci/<run>/suites/<套件>.log`；套件级 300s 超时 |

## 2. 根因（与 P2-7 记录一致，本次以插桩复现并确认）

**症状**：`notify-hub-smoke.test.mjs` 零输出挂住，同时有一个 hub 子进程存活。

**机制链**（每一步都有实测证据）：

1. `setup()` **先** `boot(port, db)` 起真实 hub 子进程，**再** `await import('../src/api.ts')`；
   该 import **抛错**：`workbench/src/api.ts` 第 2 行 `from './hubEventStream'` **缺少 `.ts` 扩展名**
   （vite/tsc 走 bundler 解析能过，Node ESM 要求相对说明符带扩展名——同文件里走 Node 解析的
   `'./notify.ts'` 就带了，只有这一行漏了）。
2. 两个用例的写法是 `const ctx = await setup()` **在 `try` 之外**：`setup()` reject → 拿不到 `ctx` →
   `finally { cleanup(ctx) }` 里的 `cleanup` 根本无法回收那个子进程（即便进了 finally，`ctx` 也是 undefined）。
3. 泄漏的 hub 子进程让测试进程无法退出；而 `node --test` **只在文件进程退出后才输出该文件的结果**
   → CI 表现为**零输出 + 永久等待**（比失败更糟：没有任何判据）。

**插桩证据**（同步写文件，避免 stdio 缓冲歧义）：

```
07:48:35.786 module loaded pid=16412
07:48:35.796 test1: start
07:48:35.812 boot pid=10316          ← 服务已起
07:48:36.139 setup: hub ready        ← 服务已就绪
07:48:36.212 test2: start            ← 73ms 后直接进入第二个用例：test1 从未 cleanup
07:48:36.495 setup: hub ready
（此后无任何 exit / cleanup 记录；两个 hub 进程一直存活）
```

**一个值得记录的自我纠错**：Windows 控制台把 `✖` 显示成乱码，我最初把那两行**失败**结果误读成 `✓` 通过，
据此以为「用例都过了、只是进程不退出」。改用 TAP 报告器后是权威结论：

```
not ok 1 - 数据面 + 分类/优先级/跳转…
not ok 2 - 实时 + 断线恢复…
```

即**两个用例都是失败的**。教训：乱码输出不可作为判据，要看 TAP/JSON 之类结构化报告，或用同步文件追踪。

## 3. 修复（三层，各司其职）

### 3.1 真正的缺陷：修好导入（一个 token）

```ts
// workbench/src/api.ts L2
-import { subscribeHubEventStream } from './hubEventStream'
+import { subscribeHubEventStream } from './hubEventStream.ts'
```

`workbench/tsconfig.json` 的 `allowImportingTsExtensions: true` 允许该写法，同文件既有 `'./notify.ts'` 先例；
`--only build`（tsc + vite）PASS 证明构建面无影响。
**同类排查**：`workbench/src` 下 68 处相对导入中，其余 67 处要么是 `import type`（strip-types 下被擦除、不会加载），
要么只出现在浏览器侧 `.tsx` 组件里（Node 测试不加载）——真正运行时会被 Node 加载的只有这一处。

### 3.2 让「泄漏」在结构上不可能（测试卫生）

- **先加载被测模块、再起服务**：模块加载失败（如上面的缺扩展名）必须在起进程之前暴露，
  否则 `setup()` 会在「服务已启动」之后 reject，调用方拿不到 ctx、无从回收。
- `boot()` 失败/超时路径也要 `killChild()`，不能把子进程留给调用方。
- `const ctx = await setup()` 移入 `try`，使 `finally { await cleanup(ctx) }` **必然执行**；
  `cleanup` 容忍 `ctx === undefined`。
- `killChild()`：`kill()` 只保证「信号已发出」，因此**等待真正 exit**，宽限期后升级 `SIGKILL`。
- 子进程登记表 + 文件级 `after` 兜底自检：结束时若仍有存活子进程，**显式断言失败**（而不是等它把进程拖住）。

### 3.3 CI 兜底：把「卡死」变成「明确的失败」

- **套件级 300s 硬超时**：超时即杀并报 `FAIL`，detail 里注明「可能存在泄漏句柄或死锁」。
- **失败套件原始输出落盘**：`.ci/<run>/suites/<套件>.log`，并在摘要里给出路径。
  （补这个是因为本次有一次 `dual-write` 偶发失败，事后只剩 6 行摘要，无法定性——见 §5。）

### 3.4 明确**否决**的修法：`--test-force-exit`

P2-7 证据 §7 建议「CI 统一加 `--test-force-exit`」。**实测该建议在 Windows 上有害**：

| 套件 | 不带 force-exit | 带 force-exit |
| --- | --- | --- |
| `workbench/scripts/static-serve.test.mjs` | exit=0，6/6 PASS | **exit=1，tests=7 / pass=6 / fail=1** |
| `team-hub/read-open-loopback.test.mjs` | exit=0，6/6 PASS | exit=0（本例无影响，但不代表安全） |

失败原因不是断言，而是 **libuv 断言崩溃**：

```
# Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

即该开关会把**本来全绿的套件**变成假失败——用假失败换掉假挂起，不可接受。已在
`scripts/ci/run-ci.mjs` 的注释里写明理由，防止后来者照旧建议再犯。

## 4. 恢复基线过程中暴露并修掉的三处**连带回归**

这三个问题**在逐套件单跑时都看不出来**（它们是「跨套件/环境」效应），只有把全量阶段跑起来才暴露：

### 4.1 P3-2 的端口校验误拒 `0`（本仓真实契约）

`TEAM_HUB_PORT=0` 是**合法契约**：`tests/contract/team-hub-parity.test.mjs` 以 env=0 加载模块，
再自行 `listen(0)` 由 OS 分配端口，并要求 `/api/config` **原样透出 0**（该文件 L91 有断言）。
P3-2 首版把端口声明为 `min: 1` → 该文件在模块加载阶段即被判定非法配置 → **整个文件失败**。

修法：三份 schema 的 port 均改为 `min: 0` 并写明语义（`0 = 由调用方/OS 分配`）。
验证：`team-hub-parity` 由 0/1 → **1/1 PASS**。

### 4.2 配置非法时 `process.exit(1)` 会**杀掉导入方进程**

`team-hub/server.mjs` 既作 CLI 入口，也被**宿主外壳** `team-hub/src/index.ts`（L70 `import('../server.mjs')`）
与大量契约测试 import；`workbench/scripts/serve.mjs` 被 `static-serve` / `web-p28` 测试 import；
白板 `apps/server/src/index.js` 同理。P3-2 首版在模块加载期直接 `process.exit(1)`，
**一处配置错误会杀掉宿主进程或测试进程**，调用方连报告与降级的机会都没有。

修法（三处一致）：仅当本模块是**入口**时 `exit(1)`（CLI 语义、启动脚本能拿到非零码）；
被 import 时**抛错**（调用方有栈可查、可决定降级/跳过）。判定沿用仓库既有的 `isMain` 约定。

### 4.3 CI 从未构建 `team-hub/lib`，p13 只能靠残留产物通过

`p13-host-injection` 需要 `@dsh-external/dsh-team-hub`，而 `team-hub/package.json` 的 `main` 指向
**未跟踪产物** `./lib/index.js`。CI 的 test 阶段只构建了 `plugins` 与 `board-plugin`，
**没有任何阶段构建 `team-hub`** → 只有本机恰好残留 `lib/` 时该套件才能通过，干净检出必失败。
宿主侧的直接证据（隔离 fixture 的宿主子进程 stderr）：

```
Error: failed to import loader entry p13-team-hub (@dsh-external/dsh-team-hub):
  Cannot find module '<隔离 home>/profiles/p13fixture/node_modules/@dsh-external/dsh-team-hub/lib/index.js'
```

表现形态随模式而异（已观察两种，**未逐一彻底根因**，如实登记）：非 CI 下宿主曾「起来了但插件路由 404」，
CI 下则为「60s 内未就绪」（`host not ready within 60000ms: fetch failed`）。

修法：test 阶段显式构建 `team-hub`（与 plugins / board-plugin 同款，且无可用 DSH_CHECKOUT 时仍按纪律 SKIP）。
验证：在 **CI=true 下**（与 run-ci 相同）该套件由 0/7 → **7/7 PASS**。

## 5. 未彻底定性的一项（诚实登记）

`.ci/hang-test` 那次全量运行中 `dual-write` 出现 **1 次失败**（2 个用例失败 1 个）。此后：

| 复现尝试 | 结果 |
| --- | --- |
| 单跑连跑 5 次 | 全部 2/2 PASS |
| 8 个 CPU 占用进程 + 连跑（负载下） | 2 次均 PASS（工具 120s 上限截断，未跑满） |
| 后续 `--only test` 全量运行 2 次 | 均 2/2 PASS |

**无法定性**，因为失败原文丢失（当时 run-ci 只保留 6 行摘要）——这正是本次补「失败套件原始输出落盘」的直接动机。
可查的事实：该库使用 `WAL + busy_timeout=5000 + BEGIN IMMEDIATE` 串行化写，理论上并发写不会撞号；
若真撞号，`audit.seq` 唯一性断言会失败，而该断言是 P1-1 的回归锚点，不能含糊。
因此把它列为**待观察项**（写入 `docs/REMAINING-TASKS.md`），下次复现时用新落盘的原始输出定性。

## 6. 复跑方式与实测输出

```powershell
cd D:\project\DSH\legion
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node scripts/ci/run-ci.mjs --only test --out .ci\test-run      # 全量测试（约 160s）
node scripts/ci/run-ci.mjs --out .ci\full-run                   # 七个阶段全跑（约 190s）
```

修复后的 `--only test` 实测（摘要逐行照抄）：

```
PASS team-hub build（DSH_CHECKOUT=…）        PASS plugins build（DSH_CHECKOUT=…）      PASS board-plugin build（DSH_CHECKOUT=…）
PASS chat 42        PASS skills 20        PASS permissions 7      PASS calendar 29     PASS calendar-ui 12
PASS chat-ui 8      PASS spaces 5         PASS pipeline 19        PASS goal 14         PASS rules 7
PASS artifact 16    PASS security 6       PASS read-auth 14       PASS files-api 41    PASS files-p27 36
PASS files-ui 19    PASS web 24           PASS static-serve 6     PASS web-p28 21      PASS web-history 1
PASS browser-ui 21  PASS doc-render 11    PASS skill-importer 4   PASS hub-board 1     PASS artifact-policy 3
PASS config 28      PASS scrum 25         PASS contracts 56       PASS v1v2-contract 17
PASS team-hub-parity 1                    PASS dedupe 9           PASS notify 15       PASS hub-event-stream 5
PASS dual-write 2                         PASS p13-host-injection 7
PASS whiteboard 158                       PASS plugins 177        PASS board-plugin 37
[test] -> PASS (160396ms)
```

完整门禁实测：

```
env PASS (674ms) | deps PASS (5ms) | build PASS (13960ms) | test PASS (164209ms)
smoke PASS (8473ms) | stage PASS (105ms) | doc PASS (612ms)     ← 七阶段全 PASS
```

## 7. 已知边界

1. **套件级超时是「兜底」，不是「修复」**：超时只把不朽的挂起变成 FAIL，泄漏本身仍需测试侧回收
   （本切片已把 `notify-hub-smoke` 修成结构上不可能泄漏，并加了显式自检）。
2. **超时杀进程在 Windows 上不递归**：`child.kill()` 只杀直接子进程，理论上其后代可能残留；
   本次未触发该路径（没有套件超时），故未加固到 `taskkill /T`——真出现时再按需处理。
3. **`--test-force-exit` 被明确否决**（见 §3.4），但它**在非 Windows 平台是否安全未验证**；
   当前 CI 不使用它，因此不构成阻塞。
4. **p13 的两种失败形态只解释了「缺产物」这一共同根因**，模式差异（未就绪 vs 路由 404）未逐一追到源码级。
5. **`dual-write` 的偶发失败未定性**（§5），已列待观察项。
6. **基线数字会随套件增删变化**：`docs/STATUS.md` 是权威入口，本文数字仅代表本次运行
   （38 套件 / 924 用例，`.ci/hang-test3`）。

## 8. 给后续维护者的两条经验

1. **「比对/扫描/测试」类校验先消除环境差异**：本仓库在 Windows 上会遇到 `core.autocrlf` 换行、未跟踪的
   本地构建产物（`team-hub/lib`、`team-hub/.watch.mjs`）、需要显式构建才能通过的套件。
   P3-2 与本次都在这上面栽过跟头（详见 `docs/P3-2-evidence/verify-evidence.md` §3.4）。
2. **不要用「单跑通过」代替「全量跑通」**：本次三处问题（端口 0、import 期 exit、缺 team-hub 构建）
   在逐套件单跑时全都看不出来，全量基线的价值恰恰在于暴露它们。
