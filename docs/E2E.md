# 浏览器端到端（E2E）手册（P4-1）

> 本文件是**当前**能力说明（非历史快照）：讲清楚仓库里的浏览器自动化基座怎么用、边界在哪、
> 以及为什么不是 Playwright。当前基线数字见 `docs/STATUS.md` §2。

## 1. 为什么需要它

前端此前只有两类自动验证（`docs/STATUS.md` §4 限制 #6/#11 登记过这个盲区）：

| 层次 | 例子 | 能证明什么 | 证明不了什么 |
| --- | --- | --- | --- |
| 判定层纯函数 | `whiteboard/packages/shared/test/room.test.mjs`、`workbench/scripts/*-ui.test.mjs` | 文案/状态机的**输入输出**正确 | 页面是否真的接线、按钮是否真的响应 |
| 静态契约 | `whiteboard/apps/web/test/ui-contract.test.mjs` | id 在 HTML 里、CSS 类有样式、模块文件存在 | 「点了真的会切房间」「只读真的禁用」 |
| **浏览器 E2E（本文件）** | `tests/browser/*.e2e.test.mjs` | 真实浏览器里真实事件 → 真实 DOM/canvas/服务端状态 | 不做视觉回归、不做多浏览器矩阵 |

P4-1 的定位是：**把「已实现但只有人工走查能确认」的那部分行为，变成一条可复跑的命令**。

## 2. 为什么是零依赖 CDP，而不是 Playwright/Puppeteer

- **要的是真实，不是抽象**：目标是「真实浏览器 + 真实事件」，直连 CDP（Chrome DevTools Protocol）就是最短路径；
- **本机/本仓库已有浏览器**：`workbench/scripts/serve.mjs` 的截图能力已在用同一个 Edge/Chrome 二进制；
- **Node 24 自带 `WebSocket` 与 `fetch`**：CDP 是 WebSocket 上的 JSON-RPC，不需要额外运行时依赖；
- **少一层依赖 = 少一类 CI 失败面**：本仓库 CI 是单命令、无网络假设；不引入「下载浏览器二进制」这一步。

代价（诚实登记）：没有 Playwright 的自动等待/选择器重试/多浏览器矩阵/追踪报告。
本基座只提供 `waitFor` 显式轮询与少量便利方法——**用它的用例要自己写清判据**，这是有意为之。

## 3. 怎么跑

```powershell
# 单跑（最快反馈，约 5s）
node --test tests/browser/whiteboard-ui.e2e.test.mjs

# 走完整门禁（env + test + doc；test 阶段会包含 e2e-browser 套件）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci\<run>
```

| 环境变量 | 作用 |
| --- | --- |
| `DSH_E2E_BROWSER` | 指定浏览器可执行文件（优先于自动探测；`DSH_WEB_SHOT_BROWSER` 也认） |
| `DSH_E2E_SHOT_DIR` | 截图落盘目录（默认 `.ci/e2e-shots/`；截图失败不影响结论） |

**没有浏览器时的行为**：整组 **SKIP**，并打印探测过的路径与设置方法（`[skip] 未找到可用浏览器…`）。
不伪造通过、也不计失败——「没跑」和「跑过且通过」必须可区分。

## 4. 基座能力（`scripts/e2e/cdp.mjs`）

```js
import { launchBrowser, browserProbe } from '../../scripts/e2e/cdp.mjs'

const { available, exe, tried } = browserProbe()      // 探测；不抛
const browser = await launchBrowser({ width: 1000, height: 700 })
const page = await browser.newPage()                  // 自动收集 console.error 与未捕获异常
await page.goto(url)                                  // 等 load 事件
await page.waitFor(() => document.querySelector('#x')?.textContent === '就绪')  // 页面内谓词轮询
await page.click('[data-tool="rect"]')                // 真实鼠标（Input 域），不是页内合成事件
await page.drag({ x: 100, y: 100 }, { x: 200, y: 160 }, { steps: 8 })
await page.fill('#room-input', 'room-a'); await page.press('Enter')
await page.evaluate((sel) => document.querySelector(sel).disabled, '#undo')     // 返回值 + 参数
await page.screenshot('shot.png')
page.consoleErrors; page.pageErrors                   // 主路径健康判据
await page.close(); await browser.close()             // 幂等；删除临时 profile
```

实现要点（排障时会用到）：

- **一条 WebSocket 驱动两个域**：`Target.attachToTarget({flatten:true})` + 命令带 `sessionId`、
  事件按 `sessionId` 路由（页面事件与浏览器事件必须分开，否则事件会串）。
- **端口自选**：`--remote-debugging-port=0`，从 stderr 的 `DevTools listening on ws://…` 行读出真实端口，
  避免固定端口冲突（本仓库同时跑多个测试服务）。
- **临时 profile**：每次 `mkdtemp` 一个 `--user-data-dir`，关闭时删除——**绝不碰用户真实浏览器配置**；
- **`--headless=new`**：走真实渲染管线（画布/字体行为更接近有头模式）。

## 5. 写一个用例的纪律

1. **判据要落在不可伪造的地方**：优先断言**服务端状态**（如 `/api/rooms/<id>` 的 `elements`）
   或**像素**（canvas `getImageData`），而不是只断言 DOM 文案；
2. **就绪要有硬信号**：页面导航后用「连接点变绿 + 在线数含自己」这类由 `welcome` 驱动的读数；
   **页内操作不重新导航**（如切房间）时，`#online` 会保留旧房间的读数——此时要等**服务端**
   报该房间已打开（见 `waitRoomOpen`），否则会与「新连接尚未建立」竞态；
3. **用例之间解耦**：每个用例用自己的房间/自己的服务进程随机端口，不依赖执行顺序（曾出现
   「单跑通过、全跑失败」的顺序耦合，已修）；
4. **不跳过真实路径**：用真实鼠标事件与真实拖拽，而不是 `dispatchEvent(new MouseEvent(...))`；
5. **失败也要留证据**：截图落 `.ci/e2e-shots/`，便于把结论贴进证据文档。

## 6. 覆盖范围与未覆盖

**当前覆盖**（`tests/browser/whiteboard-ui.e2e.test.mjs`，9 例）：白板房间进入/标题与标签同步、
真实鼠标绘制 → 服务端落库 + canvas 像素、只读房间的 UI 降级与「无写入」、切换房间与 URL/token 语义、
非法房间号的提示、主路径无页面异常、限流下的可读提示与部分丢弃、
**连接未就绪窗口内的绘制不丢**（入队 + 可见提示 + 重连后补发，含「切房间后立刻绘制」的原始复现路径，P4-3）。

**未覆盖**（诚实登记，仍在 `docs/REMAINING-TASKS.md`）：

- workbench（指挥台）与 board-plugin 前端：仍为判定层 + 静态契约，**未接浏览器 E2E**；
- 视觉回归（像素比对基线）、多浏览器矩阵（只有 Chrome/Edge）、移动端仿真、可访问性断言；
- 真实网络故障注入（丢包/TCP 半开/NAT 超时）：P4-3 只覆盖「`onclose` 已触发」的断线重连窗口，
  半开连接下前端拿不到 `onclose`，行为未验证；
- 现场部署路径（真实宿主 + 真实 team-hub 数据面）——那里仍以 `scripts/live/*` 与人工走查为准。

### 6.1 制造「断线窗口」的手法是确定的，别用网络仿真

要测「连接未就绪时用户还能操作」这类行为，需要**确定性地**进入那个窗口。实测结论：
CDP 的 `Network.emulateNetworkConditions({ offline: true })` **不影响已建立的 WebSocket**——
断网后页面连接点仍是「已连接」，窗口内发的 op 照样送达服务端，用它做负向验证会得到假绿。
可行手法（P4-3 ⑧⑨ 用的）：`Page.addScriptToEvaluateOnNewDocument` 注入一个**透明**的
WebSocket 捕获器（记下最后实例），然后在需要的位置 `close()` 真实连接——之后客户端走真实重连路径
（`retryDelay` 1s 起），得到一个 ≥1s 的确定性窗口。注入脚本必须保留
`OPEN/CLOSED/CONNECTING/CLOSING` 静态量（前端会用 `ws.readyState === WebSocket.OPEN` 判断）。

## 7. CI 集成

- 套件名 `e2e-browser`，在 `scripts/ci/run-ci.mjs` 的 `test` 阶段注册（`--only test` 即包含）；
- 缺 `whiteboard/apps/web/public/shared/`（构建产物、未跟踪）时，用例会在启动前**自动补跑一次**
  `whiteboard/scripts/build.mjs` 并打印一行说明——因为 `--only test` 会跳过 `build` 阶段，
  而页面缺共享模块的表现只是「连不上」，定位成本很高；
- 无浏览器环境下整组 SKIP（见 §3），因此该套件**不会**让无浏览器的机器红掉。
