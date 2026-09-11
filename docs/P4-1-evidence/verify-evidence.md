<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P4-1 浏览器端到端基座 —— 验证证据

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `scripts/e2e/cdp.mjs`（新，~420 行） | 零依赖 CDP 基座：浏览器探测（`DSH_E2E_BROWSER` → Edge/Chrome 常见路径）、启动（`--headless=new` + `--remote-debugging-port=0` + **临时 user-data-dir**）、一条 WebSocket 驱动浏览器/页面两个域（`Target.attachToTarget({flatten:true})` + 按 `sessionId` 路由事件）、`goto/evaluate/waitFor/centerOf/click/drag/fill/press/screenshot`、console.error 与未捕获异常收集、浏览器版本读取（`Browser.getVersion`） |
| `tests/browser/whiteboard-ui.e2e.test.mjs`（新，7 例） | 白板前端**真实浏览器 DOM 端到端**：进入房间的标签/标题/角色同步、真实鼠标绘制 → 服务端落库 + canvas 像素、只读房间 UI 降级与零写入、切换房间与 URL/token 语义、非法房间号提示、主路径无页面异常、限流提示与部分丢弃 |
| `docs/E2E.md`（新） | 浏览器 E2E 手册：为什么不用 Playwright、怎么跑、基座 API、写用例纪律、覆盖范围与未覆盖项 |
| `docs/P4-1-evidence/e2e-evidence.mjs`（新） | 可复跑的证据生成器（本文件 §3.3 的读数由它产出） |
| `scripts/ci/run-ci.mjs` | `test` 阶段新增套件 `e2e-browser` |
| `docs/STATUS.md` / `README.md` / `docs/FEATURES.md` / `docs/REMAINING-TASKS.md` | 基线数字、限制 #11、文档地图、命令清单与候选 #6 关闭 |

## 2. 决策与取舍

### 2.1 零依赖直连 CDP，而不是 Playwright/Puppeteer

要验证的是「真实浏览器里真实事件 → 真实 DOM/canvas/服务端状态」，直连 CDP 就是最短路径；本机已有
Edge/Chrome（`workbench/scripts/serve.mjs` 的截图能力已在用同一二进制），Node 24 自带 `WebSocket`，
因此**新增 0 个依赖**、不引入「下载浏览器二进制」这类 CI 失败面。代价诚实登记：没有 Playwright 的
自动等待/选择器重试/多浏览器矩阵/追踪报告，用例必须自己写清判据。

### 2.2 找不到浏览器 → 整组 SKIP，而不是失败或假绿

`browserProbe()` 只做探测、不抛；`describeBrowser` 在缺浏览器时是 `describe.skip`，并打印探测过的全部
路径与设置方法。这样在有浏览器的机器上真的跑、在没有的机器上明确「没跑」，且**不会让无浏览器的机器红掉**。
本机实测 SKIP 路径见 §3.4。

### 2.3 判据落在不可伪造的地方

- **服务端状态**：`/api/rooms/<id>` 的 `elements`（前端伪造不了）；
- **像素**：`getImageData` 统计非透明像素数与包围盒（证明真的渲染，而不是只有 DOM 变化）；
- **真实输入**：`Input.dispatchMouseEvent`/`insertText` 由浏览器生成事件，而不是页内
  `dispatchEvent(new MouseEvent(...))` 合成对象。

### 2.4 就绪判据要用「硬信号」，页内切换房间要等**服务端**确认

页面导航后的就绪 = `#conn` 变绿 且 `#online` 为「在线: 1」——这两者都由 `welcome` 驱动，
可排除「DOM 已加载但 ws 未就绪」。但**页内切换房间不重新导航**，此时 `#online` 会保留上一个房间的读数，
只等页面状态会与「新连接尚未建立」竞态（写用例时实测到一次：绘制被静默丢弃 → 轮询 5s 才通过）。
因此切换房间后额外等 `waitRoomOpen()`：`/api/rooms/:id` 从 404(`room_not_open`) 变 200，
才是「新房间的 ws 已建立」的硬证据。加上这一步后用例稳定在 ~4.3s（此前偶发 9.3s）。

### 2.5 用例之间解耦（这条是被失败逼出来的）

初版用例 ② 往 `main` 房间画、用例 ④ 断言 `main` 剩余 1 个元素——**顺序耦合**：单跑 ④ 必失败
（实测 `✖ ④`），全跑通过。现已改为每个用例用自己的房间（`draw-a` / `switch-a` / `view` / `slow`），
单跑与全跑结论一致（§3.5）。

### 2.6 覆盖范围克制：先做白板，不做「通用框架」

`REMAINING-TASKS` 候选 #6 的具体缺口是 P3-1 登记的白板前端 DOM 行为。本轮只补这条，并把
workbench / board-plugin 前端、视觉回归、多浏览器矩阵、网络故障注入**明确登记为未覆盖**（`docs/E2E.md` §6），
不假装已经「前端全自动」。

### 2.7 `--only test` 会跳过 `build`：用例自己补建页面产物

浏览器要加载的共享模块是**未跟踪的构建产物**（`whiteboard/apps/web/public/shared/`）。CI 的 `build`
阶段会生成它，但 `--only test` 跳过该阶段——此时页面模块 404，断言只会以「连接不上」的形式炸掉，
定位成本很高。用例因此在启动前补跑一次 `whiteboard/scripts/build.mjs`（零依赖、幂等）并打印一行说明。
本轮真的走过这条路径：跑 `--only env,test` 前手工删除了 `public/shared`，运行后目录被用例补建（§3.2）。

## 3. 复跑证据

### 3.1 单跑套件

```powershell
node --test tests/browser/whiteboard-ui.e2e.test.mjs
```

实测：**7/7 PASS、0 fail、0 skipped**，单次 ~28–31s（两条 describe 各自起真实白板服务进程 +
一个真实浏览器）。连续两次运行结论一致。

### 3.2 全量门禁（env + test）

```powershell
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node scripts/ci/run-ci.mjs --only env,test --out .ci\browser-e2e-2
```

实测（`.ci/browser-e2e-2/summary.json`）：`env` PASS（2055ms）、`test` **PASS 39 套件 / 950 用例**
（267959ms；其中新增行 `PASS e2e-browser（P4-1 真实浏览器：白板房间/角色/只读/限流 DOM 端到端）:
exit=0 tests=7 pass=7 fail=0`）。其余 38 个套件数字与 P3-4 基线完全一致（无既有用例被删改）。
本次运行前 `public/shared` 被手工删除，运行后该目录存在（用例自动补建，见 §2.7）。
耗时较 P3-4 基线的 165s 长，主因是机器上同时跑着生产服务（3080/8787/5173）与本轮其他命令，
不是套件变慢——同一阶段在本轮另一次运行（`.ci/browser-e2e-1`）也偏慢。

### 3.3 现场读数（`node docs/P4-1-evidence/e2e-evidence.mjs`）

```
- 探测到的浏览器：C:\Program Files\Google\Chrome\Application\chrome.exe
- Browser.getVersion：product=Chrome/152.0.7977.83 protocol=1.3
- 可编辑房间：就绪 4210ms；绘制前 canvas 非透明像素 0 → 绘制后 2236
  （包围盒 [328,211,511,314] ≈ 183×103，与 180×100 的拖拽范围相称；画布 900×547）
- 服务端 /api/rooms/main 落库元素数：1
- 只读房间：#role = 「只读」/ class `role ro`；body.readonly=true；6 个工具按钮全部 disabled
  提示条文案：「当前为只读角色，无法绘制（可查看与移动光标）」
  服务端 /api/rooms/view 元素数：0
- 截图：.ci/e2e-shots/evidence-drawn-rect.png 900×640 / 21729 字节（PNG 魔数校验通过）
        .ci/e2e-shots/evidence-readonly.png 900×640 / 27052 字节
- 页面健康：Runtime.exceptionThrown 0、console.error 0；总计 5172ms
```

**这些数字才是本切片真正的产物**：像素数从 0 到 2236 证明「画出来了」，服务端 1 证明「发出去了」，
只读房间 0 证明「拦住了」，三者都不是 DOM 文案能造假的。

### 3.4 无浏览器时的 SKIP 路径

```powershell
$env:DSH_E2E_BROWSER='C:\nonexistent\chrome.exe'; node --test tests/browser/whiteboard-ui.e2e.test.mjs
```

实测：打印 `[skip] 未找到可用浏览器（Edge/Chrome）…` + 探测路径清单，两条 describe 标 `# SKIP`，
`exit=0`（不失败、也不伪绿）。

### 3.5 顺序无关性

```powershell
node --test --test-name-pattern='④' tests/browser/whiteboard-ui.e2e.test.mjs
```

实测：单跑 ④ **PASS**（4358ms）——与全量运行结论一致（修复前该命令必失败，见 §2.5）。

## 4. 诚实边界

1. **覆盖面**：只有白板前端 7 例。workbench（对话/日历/文件/通知/浏览器助手）与 board-plugin 前端的
   DOM 行为**仍是判定层 + 静态契约**，没有浏览器断言；视觉回归（像素基线）、多浏览器矩阵（实测只有
   Chrome，Edge 只做探测）、移动端仿真、可访问性断言、网络故障注入（离线/超时/重连）**都没有**。
2. **headless 与有头不同**：用例跑的是 `--headless=new`；有头模式下的字体/合成差异未覆盖。
3. **只跑本机浏览器**：CI 不下载浏览器，因此在没有 Edge/Chrome 的机器上该套件恒为 SKIP（这是设计，
   但也意味着「本套件在那些环境里不构成防线」）。
4. **`#limit` 是单条提示槽位**：`setNotice()` 用同一个元素展示只读/限流/房间非法/剪贴板结果，
   后到的提示会覆盖先到的（无队列）。本轮用例在限流场景独占该房间与页面，所以结论不受影响；
   但**这条产品行为本身未被断言**，如需「提示不互相吞掉」需另立项。
5. **写用例时发现一条真实缺陷，本轮未修**：`main.mjs` 的 `send()` 只在 `ws.readyState === OPEN` 时发送、
   否则**静默丢弃**——切房间/重连窗口内用户画的东西会无声消失。已登记为
   `docs/REMAINING-TASKS.md` 候选 #10（含复现步骤与两个修法方向）。现有 E2E 通过 `waitRoomOpen()`
   规避这条竞态，所以不会把产品缺陷误报成测试失败。
6. **截图未入库**：`.ci/e2e-shots/` 是本地产物（`.ci/` 不入版本库）。证据文件 `e2e-evidence.mjs`
   可随时重新生成同样的读数与截图。
7. **不是「零成本」**：该套件给 `test` 阶段增加约 30s 与一个真实浏览器进程（每次运行都会启动/关闭）。
   需要更快反馈时可单跑该文件，或按 §3.4 用环境变量跳过。

## 5. 证据清单

| 命令 | 结论 |
| --- | --- |
| `node --test tests/browser/whiteboard-ui.e2e.test.mjs` | 7/7 PASS（单跑两次一致） |
| `node scripts/ci/run-ci.mjs --only env,test --out .ci\browser-e2e-2` | env PASS + test PASS（39 套件 / 950 用例） |
| `node docs/P4-1-evidence/e2e-evidence.mjs` | 现场读数（§3.3），浏览器 Chrome/152.0.7977.83 |
| `$env:DSH_E2E_BROWSER='C:\nonexistent\chrome.exe'; node --test tests/browser/whiteboard-ui.e2e.test.mjs` | 整组 SKIP，exit=0 |
| `node --test --test-name-pattern='④' tests/browser/whiteboard-ui.e2e.test.mjs` | 单跑 PASS（顺序无关） |
