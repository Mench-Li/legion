<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）｜[README.md](../../README.md)（总览）｜[docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P4-3 白板「连接未就绪窗口」内的操作不再静默丢失 —— 验证证据

> 任务来源：`docs/REMAINING-TASKS.md` 候选 **#10**（P4-1 浏览器 E2E 发现的**真实产品缺陷**，当时未修）。
> 症状原话：「切换房间/断线重连时，`main.mjs` 的 `send()` 只在 `ws.readyState === OPEN` 时发送，
> 其余情况**静默 return** —— 连接尚未建立的这段时间里用户画的东西会无声消失（既无提示也不入队列）。」

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `whiteboard/packages/shared/src/pendingOps.mjs`（新） | 待发队列**纯逻辑**：有界 FIFO（超限丢最旧并报数）+ `chunkOps` 按服务端单条消息上限分块 |
| `whiteboard/packages/shared/test/pendingOps.test.mjs`（新，**11 例**） | 锁定队列语义（顺序/有界/丢弃计数/`drain` 与 `clear` 的区别/分块与非法参数退化） |
| `whiteboard/apps/web/public/js/main.mjs`（改） | 未就绪时 **op 入队 + 可见提示**；`welcome` 后 `flushPendingOps()` 补发（分块 + 本地重放 + 只读改写提示）；切房间时丢弃旧房间暂存并**如实告知**；presence 仍不入队（瞬时状态） |
| `tests/browser/whiteboard-ui.e2e.test.mjs`（改，7 → **9 例**） | 新增 ⑧「连接未就绪窗口内的绘制」与 ⑨「切房间后立刻绘制（原始复现路径）」，用真实浏览器+真实鼠标事件断言**服务端最终状态** |
| `whiteboard/package.json` / `scripts/ci/run-ci.mjs` | 新单测纳入 `whiteboard` 套件；套件标签的文件数改为**从 test 脚本算出**（写死的 12 与实际的 15 已漂移过） |

## 2. 关键决策（含被实测推翻的假设）

### 2.1 「窗口」必须用真实断线制造，不能靠网络仿真

第一版方案想用 CDP 的 `Network.emulateNetworkConditions({offline:true})` 制造离线窗口。
**实测否掉了**：断网后白板连接仍是 `dot on`，窗口内画的矩形**照样送达服务端**（`elements:1`）——
Chrome 的网络仿真不影响**已建立**的 WebSocket。于是改为：页面加载前注入一个**透明**的 WebSocket
捕获器（记下 `__lastWs`），在窗口内 `close()` 真实连接 → 命中 `onclose` 的重连路径
（`setTimeout(connect, retryDelay)`，首次 1s）→ 得到**确定性 ≥1s** 的「未就绪窗口」。
这也正是真实用户遇到的「网络抖一下」，不是人造状态。

### 2.2 补发必须分块，否则会把连接踢掉

服务端 `MAX_OPS_PER_MESSAGE`（默认 200）是**硬门槛**：超过不是「拒一条消息」，而是
`policyClose(1008)` **关连接**（`limits.mjs:157`）。而队列上限 500 > 200，所以补发一定要按
`welcome.limits.maxOpsPerMessage` 分块——否则一次补发反而把刚恢复的连接弄断。已写成单测。

### 2.3 补发时本地必须**重放**一次

服务端广播 op 时带 `except`（`index.js:372 broadcastToRoom(roomId, out, conn)`）——**不回显给发送者**。
而 `welcome` 恰好刚把 `doc` 换成服务端文档，所以只发不重放的结果是「服务端有、屏上没有」。

### 2.4 切房间的暂存必须丢，但必须说出来

队列里的 op 属于**上一个房间**，在新房间补发会把内容写错房间。所以 `switchRoom` 清空队列，
但**给出可见提示**（「上一个房间有 N 个操作未能发送」）。「切房间后东西没了」正是候选 #10 的报告症状，
静默清空等于把缺陷换个地方复现。

### 2.5 只读与 presence 的边界

- 只读角色（服务端 `role === 'ro'`）：补发会被服务端拒（`op_denied`），所以前端**不发**，
  但把「未发送」如实提示出来（不静默丢）。
- presence 是瞬时状态（光标），断线期间**不入队**：重连后下一次移动自然补上，入队只会堆垃圾。

### 2.6 一处顺手修掉的测试基座缺陷

`tests/browser/whiteboard-ui.e2e.test.mjs` 的 `ensureWhiteboardAssets()` 原先只检查
`public/shared/room.mjs` 是否存在——**新增**共享模块后目录仍在、`room.mjs` 也在，
但新模块缺失 → 页面 import 404，报错表现是「连不上/welcome 没来」，定位成本极高（本轮真实踩到）。
现在按「main.mjs 实际 import 了哪些 shared 模块」逐个检查，缺哪个就重建。

## 3. 验证证据

### 3.1 A/B 现场读数（同一探针，只换 `main.mjs`）

探针：打开房间 → **真实关闭连接** → 窗口内用真实鼠标拖出一个矩形 → 等自动重连 → 读**服务端**元素数与**本地画布墨迹像素**。

| 读数 | 修复前（`main@7af9eba` 的 `main.mjs`） | 修复后 |
| --- | --- | --- |
| 窗口内绘制后的提示 | `""`（**静默**） | `"连接未就绪：已暂存 1 个操作，连上后自动补发"` |
| 窗口内绘制后服务端元素数 | 0 | 0（确实还没发出去，说明测到的就是这个窗口） |
| 重连后提示 | `""` | `"已补发连接中断期间的 1 个操作"` |
| **重连后服务端元素数** | **0（永久丢失）** | **1** |
| **重连后本地画布墨迹像素** | **0（`welcome` 换 doc 后屏上也消失）** | **1516** |

即：修复前是**双重丢失**（服务端没收到 + 屏幕上也没了），修复后服务端与屏幕都保留。

### 3.2 用例读数

| 运行 | 命令 | 结果 |
| --- | --- | --- |
| 队列纯函数单测 | `node --test packages/shared/test/pendingOps.test.mjs` | **11/11 PASS** |
| 单测 + 前端静态契约 | 同上 + `apps/web/test/ui-contract.test.mjs` + `contract.test.mjs` | **43/43 PASS** |
| 浏览器端到端（全组） | `node --test tests/browser/whiteboard-ui.e2e.test.mjs` | **9/9 PASS**（41.0s；原 7 例） |
| 新增用例单独跑（独立性） | `--test-name-pattern='⑧'` / `='⑨'` | 各自 **1/1 PASS**（⑨ 不依赖 ⑧ 先跑） |
| **负向对照**：新用例打在**未修**代码上 | `git checkout main -- whiteboard/apps/web/public/js/main.mjs` 后跑 ⑧ | **FAIL**，且失败文本正是要消灭的症状：`连接未就绪时的绘制必须给出可读提示，而不是静默丢弃：""` |

### 3.3 ⑧/⑨ 两条用例断言了什么

⑧（连接抖动）：窗口内绘制 → ①**有可见提示**；②此刻服务端**还没有**该元素（证明窗口真实存在）；
③本地画布**已画出**（用户操作有反馈）；④重连后服务端**恰好 1 个**元素；
⑤补发后本地画布**仍有**该元素（`welcome` 没把它抹掉）；⑥提示变为「已补发…」；⑦无页面异常。

⑨（原始复现路径：「切房间 → 新连接就绪前立刻拖拽」）：窗口内绘制 → 重连后元素落在**新房间**，
旧房间**仍为 0**（旧行为：两个房间都没有这个元素）。

### 3.4 与基线的差异（诚实登记）

- `e2e-browser`：**7 → 9 例**（+2 竞态用例），单组耗时约 33s → 41s；
- `whiteboard`：**158 → 169 例**（+11 队列单测）；套件标签的文件数改为动态计算（原来是写死的 12，实际 15）；
- 生产代码改动仅 `main.mjs`（前端）与新增一个共享纯函数模块，**服务端零改动**。

## 4. 未覆盖 / 已知边界（诚实登记）

1. **入队的 op 沿用原 stamp**：重连前的 op 携带本地旧时钟，若期间有其它客户端的并发修改，
   LWW 规则可能保留对端值。这是 CRDT 的正确语义（操作**送达**了，只是冲突时按规则取舍），
   不是本缺陷的残留——但用户看到的可能仍是「我的这次移动没生效」，故如实登记。
2. **队列有界（500 op）**：超过则丢**最旧**并在提示里报出丢弃条数。极端离线时长下仍会丢东西，
   但不再静默，且丢的是最旧操作。
3. **已在途但未落库的 op 仍可能丢**：`ws.send()` 成功 ≠ 服务端已处理；连接在「已写 socket、
   未到服务端」之间断开时，该 op 既不在队列也不会重发（需要 ack/重传协议才能解决，本切片不做）。
4. **补发不覆盖「切换后旧连接仍有未确认 op」**：旧连接的在途 op 与「丢旧房间队列」同源，同样是 ack 问题。
5. **`pendingOps` 上限是前端常量**：不随服务端 `WB_MAX_OPS_PER_MESSAGE` 自适应（分块已自适应，
   上限没有）——两者语义不同，未合并。
6. **浏览器 E2E 依赖本机 Edge/Chrome**：无浏览器时整组 SKIP（不伪绿）；因此本轮结论在
   **无浏览器的机器上不会被复核**——这条限制沿用 P4-1。
7. **⑧⑨ 的窗口由「测试主动关闭真实连接」制造**：真实网络故障（丢包/半开连接/NAT 超时）
   的表现可能不同（例如 TCP 半开时 `readyState` 仍是 OPEN，前端拿不到 `onclose`），未覆盖。

## 5. 复跑命令

```bash
# 单元（纯函数，任何机器）
node --test whiteboard/packages/shared/test/pendingOps.test.mjs

# 浏览器端到端（需要本机 Edge/Chrome；无浏览器则整组 SKIP）
node --test tests/browser/whiteboard-ui.e2e.test.mjs

# 全量门禁（env + test + doc）
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci/p4-3
```
