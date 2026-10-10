# 三端统一端到端测试（T-195）

> ★ **实施结果注记（T-198，2026-10-10）** —— 本文是**当时的意图与勘察记录**，保留原文。
> 落地到 main 时腿 3 被**重写**，与本文有两处出入，读的时候请注意：
>
> | 本文写的 | 实际落地的 |
> | --- | --- |
> | 新增 `product/upgrade/feed.mjs`（560 行）承载设计稿 §5 那一层 | **不新增**。它是 `product/update/envelope.mjs` + `feed.mjs` 的**并行实现**，且没有任何生产消费者；腿 3 改为直接用真模块 |
> | 客户端用自带的信封层 | 换成**真的** `createUpdateClient` + `transport` + `install`（托管仍是真的 Hub） |
>
> 重写的理由、由此抓出的**生产阻断缺陷**（Hub 缓存头与客户端要求不一致）与探针收获，
> 见 [`tests/e2e-unified/README.md`](../../../tests/e2e-unified/README.md)。
>
> 本文第 111 / 144 / 264 行提到的那份 `feed.mjs` 因此**不存在于 main**。

> 日期：2026-10-09　工作区：`.legion-worktrees/T-195`（分支 `w/T-195`）　基线：`508a5892`
> 范围：移动端 / 桌面端 / 桌面端自动更新
> 依据：[桌面端自动更新设计](../specs/2026-10-02-legion-desktop-auto-update-design.md)、
> [服务器·电脑·手机协同架构](../specs/2026-10-02-legion-server-pc-mobile-agent-architecture.md)、
> [浏览器 E2E 手册](../../E2E.md)、[当前状态入口](../../STATUS.md)

## 0. 这份文档要解决的问题

用户的要求是一句话：**「构建移动端 / 桌面端 / 桌面端自动更新的统一测试，验证闭环所有功能」**。

这句话里最容易做错的是「统一」与「闭环」两个词：

- 把三端各写一套互不相干的测试，加起来不是「统一」，只是**三堆测试**——它们无法回答
  *"同一个用户动作在三个端上是不是同一件事"*。所以本方案**只有一条时间线**：
  同一个 Hub、同一份任务、同一批断言口径，三端各自是这条时间线的一个入口。
- 「闭环」不是「每个模块都有单测」。本仓库已有 195 套件 / 5712 用例
  （`docs/STATUS.md` 顶部基线），模块级覆盖是**够的**；缺的是**跨端那条线**：
  一个动作发出去，另一端的真实读数真的变了。

> 一个「三端各自的模块单测全绿」的仓库，
> 与一个「手机点一下、电脑真的领走了那个任务」的仓库，是同一个东西——
> 只不过前者在一张张绿灯清单上看起来是完整的。

## 1. 勘察结论（全部为实测，非推断）

### 1.1 三端现状是不对称的

| 端 | 真实代码 | 已有的自动验证 | 缺口 |
| --- | --- | --- | --- |
| 移动端 | `workbench/mobile/`（PWA，零构建手写页：`app.mjs` 43KB、`board.mjs`、`timeline.mjs`、`sw.js`） | `team-hub/mobile-api-contract.test.mjs`（照 `app.mjs` 顺序打真实 HTTP）、`team-hub/mobile-routes.test.mjs`（路径安全）、`workbench/mobile/{board,timeline,refresh-loop}.test.mjs`（纯函数）、`workbench/scripts/mobile-board-parity.test.mjs`（源码扫描） | **没有真浏览器**。没有任何用例证明「手指点下去，页面真的发出了那个请求」 |
| 桌面端 | `desktop/`（Electron 壳） | `desktop/main.test.mjs` 用**假 bridge**（`fakeBridge()`，`main.test.mjs:11`）测 `desktop/runtime.mjs` | **真 bridge 进程从没被驱动过**；Electron 二进制本机未安装 |
| 桌面端自动更新 | `product/upgrade/` 9 个模块（签名/完整性/preflight/备份/迁移/切换/回滚/通道/审计）+ 云上已部署的空托管 | `product/upgrade/*.test.mjs` 若干 | **设计稿 §5 的签名通道清单与客户端校验器整个不存在** |

### 1.2 决定性的三条实测读数

**① 移动端由 Hub 自己托管，可隔离起服。**
`team-hub/server.mjs:7933` → `createMobileRoutes({ root: join(ROOT,'workbench','mobile') })`。
我实起了一个隔离 Hub（临时库、临时端口）并逐条取：

```
hub base = http://127.0.0.1:61199
  200  /mobile/                   ct=text/html; charset=utf-8                 cache=no-store  bytes=10332
  200  /mobile/index.html         ct=text/html; charset=utf-8                 cache=no-store  bytes=10332
  200  /mobile/app.mjs            ct=text/javascript; charset=utf-8           cache=no-store  bytes=33784
  200  /mobile/manifest.webmanifest ct=application/manifest+json             cache=no-store  bytes=513
  --- 鉴权面 ---
  200  /api/identity/status       （开放）
  401  /api/agents?scope=default  {"error":"缺少访问令牌","code":"REMOTE_AUTH_MISSING"}
  200  /api/agents?scope=default  （带机器令牌）
```

⇒ **harness 成立**：真实 Hub 可以在测试进程内起在端口 0 上，真实浏览器直接访问它。

**② `cdp.mjs` 明写不做移动端仿真。**
`scripts/e2e/cdp.mjs:13`：

> `**不做**：多标签页编排、网络拦截、文件下载、移动端仿真、隔离世界。`

而 `cdp.mjs:288` 把 `mobile` 硬编码为 `false`：

```js
await send('Emulation.setDeviceMetricsOverride', {
  width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false,
})
```

⇒ 「移动端」这条腿在现有基座上**根本走不了**，必须先补这块地基。

**③ 自动更新的网络层是空的。**
在 `product/upgrade/` 下搜 `fetch` / `node:http` / `node:https` / `update-feed` / `feedUrl`
——**零匹配**。`index.mjs:307` 的 `runUpgrade({ paths, current, target, ... })` 是纯进程内编排，
入参里没有 URL、没有下载步骤。全仓搜 `legion/update-feed@1` 只命中**两份文档**。

而实施计划自己写着（`docs/superpowers/plans/2026-10-04-legion-server-pc-mobile-agent-implementation.md:864`）：

> 对应的**客户端校验器尚未实现**（属自动更新那条线）。在这一步之前写一个发布脚本，
> 只会产出形状可能不被未来校验器接受的清单——所以这里**不写**

⇒ 自动更新这条闭环今天是**断的**：包可以造、可以签、可以校验，但**没有任何东西把它从网上取下来**。
「验证闭环」要求把这一环补上，否则只能验证一串互不相连的原语。

## 2. 设计原则

1. **一条时间线，三个入口。** 三端共用同一个 Hub 实例、同一份断言口径。移动端与桌面端
   不是两个被测系统，是同一系统的两个客户端。
2. **判据落在不可伪造处。** 优先断言**服务端状态**（Hub 数据库经真实 API 回读）、
   **真实进程退出码**、**磁盘上的活动版本指针**，而不是 DOM 文案。
   - 一个「DOM 上出现了任务卡片」的断言，与一个「Hub 库里真的多了一条任务」的断言，
     在手机上长得一样——只不过前者在一个只渲染本地状态的实现上照样是绿的。
3. **没跑 ≠ 跑过。** 沿用 `docs/E2E.md` §3 的纪律：无浏览器时整组显式 SKIP 并打印探测路径，
     绝不伪造通过、也不计失败。
4. **诚实登记做不到的部分。** 本机无 Electron 二进制且仓库禁止联网下载依赖
   （`LEGION.md`「禁止联网下载依赖」）——「真起 Electron」这一条**不做**，也不假装做了。
5. **破坏性验证是交付物的一部分。** 按仓库纪律（`docs/STATUS.md` 各轮的「破坏性验证 N/N 全红」），
   每条关键判据都要有探针证明它能变红，且探针要能区分
   *「判据没红」* 与 *「探针没打中」*（这是仓库反复踩过的坑：探针自身的错误伪装成判据的缺陷）。

## 3. 交付结构

```
scripts/e2e/cdp.mjs                        【改】补移动端仿真（本方案唯一改动的既有基座）
tests/e2e-unified/
  harness.mjs                              【新】共用夹具：隔离 Hub + 本地静态托管 + 浏览器
  mobile.e2e.test.mjs                      【新】腿 1：真浏览器移动仿真 → 真 Hub
  desktop.e2e.test.mjs                     【新】腿 2：真 bridge 进程 + 桌面壳真实页面
  update.e2e.test.mjs                      【新】腿 3：签名通道闭环（发布→托管→校验→切换→回滚）
  loop.e2e.test.mjs                        【新】闭环：手机派单 → Hub → 电脑领走 → 回传进展
  README.md                                【新】怎么跑、判据在哪、做不到什么
product/upgrade/feed.mjs                   【新】设计稿 §5 的签名通道与发行清单 + 客户端校验器
scripts/qa/unified-probes.mjs              【新】破坏性验证探针（证明判据能红）
```

## 4. 各腿判据

### 4.1 腿 1 · 移动端（`mobile.e2e.test.mjs`）

前置：隔离 Hub（端口 0、临时库）+ Chrome 移动仿真（390×844、`hasTouch`、`mobile: true`、触屏 UA）。

流程与判据（每条都要有**服务端回读**作对照）：

| # | 真实动作（浏览器） | 判据（不可伪造处） |
| --- | --- | --- |
| 1 | 打开 `/mobile/` | 页面 `#` 根节点渲染完成；`/mobile/app.mjs` 真的被加载（请求计数） |
| 2 | 引导 + 登录（真实触屏输入） | 登录响应返回 `accessToken`；`/api/identity/me` 回读用户存在 |
| 3 | 选空间 | `/api/agents?scope=` 回读含预期 Agent |
| 4 | 选 Agent、发一条任务 | **Hub 库里真的出现该消息**（`/api/agent-messages` 回读，按字段名比对 `app.mjs` 真读的字段） |
| 5 | 派单入口 | **Hub 库里真的出现一条任务**（任务回读按 id），而不是只有 DOM 变了 |

### 4.2 腿 2 · 桌面端（`desktop.e2e.test.mjs`）

本机无 Electron，故**不驱动 Electron 主进程**；改驱动它两侧边界上真实存在的东西：

| # | 对象 | 判据 |
| --- | --- | --- |
| 1 | 真 `product/launcher/desktop-bridge.mjs` 子进程（JSON-lines stdio） | 握手 → `status` → `stop` 全走真实进程；**进程真的退出**（`exitCode`），不是只收到回执 |
| 2 | `desktop/runtime.mjs` 导航策略 | `canNavigate` 只放行 `startup.html` 与**已验证的 workbench origin**；伪造 origin 被拒 |
| 3 | 真浏览器加载 `desktop/startup.html` | 启动页真的渲染出状态；无页面异常 |
| 4 | 真浏览器加载 workbench origin（真 `pnpm build` 产物 + 真 `serve.mjs`） | 与桌面壳指向的是**同一个 origin**；页面可达且无 console 错误 |

### 4.3 腿 3 · 桌面端自动更新（`update.e2e.test.mjs`）

先补缺失的一层（`product/upgrade/feed.mjs`），严格照设计稿 §5：

- 签名覆盖 `legion-update-envelope@1\n` + `canonicalJson(payload)` 的 UTF-8 字节
  （复用 `manifest.mjs` 的 `canonicalJson`，并按 §5 要求**先做跨发布端/客户端固定向量验证**）；
- `legion/update-feed@1`（通道清单）与 `legion/update-release@1`（发行清单）两种 payload；
- `sequence` 单调、`expiresAt` 过期、`keyId` 从内置信任表取公钥；
- 路径为固定 origin 下相对路径，拒绝绝对地址/父目录穿越/编码绕过。

然后本机起静态托管（`node:http`，目录形状照 §4），驱动完整闭环：

| # | 步骤 | 判据 |
| --- | --- | --- |
| 1 | 取通道清单 | 200 + `no-store`；签名验过 |
| 2 | 取发行清单 | `manifestSha256` 与实取字节一致 |
| 3 | 下载完整包 | 流式、大小受限、`sha256` 与清单逐字节一致 |
| 4 | `verifyPackage` | 签名 `verified` + 完整性 `ok` |
| 5 | `runPreflight` | 空间/兼容/在途任务三项各有明确 verdict |
| 6 | `runUpgrade` 切换 | **磁盘上 `active-version.json` 指向新版本**，且新版本目录完整 |
| 7 | 回滚路径 | 回滚后活动指针**真的回到旧版本** |

**负向用例**（每条都要真拒绝，且拒绝理由具名）：伪造签名、未知 `keyId`、`sequence` 回退、
清单过期、包被篡改、路径穿越。

### 4.4 闭环腿（`loop.e2e.test.mjs`）

一条时间线走到底，跨三端：

```
真浏览器（移动仿真）派单
   → 真 Hub 落库（任务 + 事件）
   → 真电脑 Node 进程（product/node/）认领
   → 进展事件写回 Hub
   → 真浏览器（同一个页面）看到该进展
```

判据：每一跳都断言**下一跳能成立**——不是「接口返回 200」，而是「下一跳真的看见了」。
（这条纪律来自 `docs/STATUS.md` 里 PRT-255 那一段：五步验证的判据都是「下一步骤能成立」。）

## 5. 诚实边界（**先写下来，事后再写就是掩饰**）

- **不做**真 Electron 二进制启动：`desktop/node_modules` 不存在，仓库禁止联网下载依赖。
  腿 2 验证的是桌面壳的**边界**（真 bridge 进程、真导航策略、真页面），**不是** Electron 主进程。
  *一个"用真浏览器验了桌面壳加载的页面"的结论，与一个"桌面应用真的启动了"的结论，
  不是同一个东西——本文件不把前者说成后者。*
- **不做**真机安装包 / Authenticode / 真机升级：需要签名证书，属运营者资产。
- **不做**公网 HTTPS 与真实 CDN：腿 3 用本机静态托管验证**协议与事务**，
  传输安全的验收仍以设计稿 §10 阶段 D 为准。
- **不做**真机（Android/iOS）：移动仿真用 Chrome 的设备仿真，**不是**真机浏览器。
- 无浏览器时整组 SKIP —— CI 机器上会不会红，取决于那台机器有没有 Chrome/Edge。

## 6. 怎么跑

```powershell
# 单跑一条腿
node --test tests/e2e-unified/mobile.e2e.test.mjs

# 三端 + 闭环
node --test tests/e2e-unified/

# 破坏性验证（证明判据能红）
node scripts/qa/unified-probes.mjs

# 走完整门禁的 test 阶段（含本套件）
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci\t195
```

## 7. 登记要求（不做就会被门禁判红）

`scripts/ci/run-ci.mjs` 的 **套件清单完备性**检查（`run-ci.mjs:4813` 起）遍历
`git ls-files '*.test.mjs'`：**每一个被跟踪的 `*.test.mjs` 必须被某个套件显式列出**，
否则 `test` 阶段 FAIL。因此新增的 4 个 `*.test.mjs` 必须在 `suites` 数组里具名登记
（逐文件列出，**不用通配符**——通配符会让"新增一个未登记的测试文件"继续混过去，
而那正是这道检查存在的唯一理由，见 `run-ci.mjs:2921`）。

---

## 8. 执行结果（实测，非计划）

日期 2026-10-09。提交 `e69ee9b4`（本批）、`1e066e8e`（顺带修掉的既有门禁缺口）。

### 8.1 四条腿

| 腿 | 用例 | 结果 |
| --- | --- | --- |
| 1 移动端 | 6 | **6 pass / 0 fail** |
| 2 桌面端 | 5 | **5 pass / 0 fail** |
| 3 自动更新 | 10 | **10 pass / 0 fail** |
| 4 三端闭环 | 7 | **7 pass / 0 fail** |
| **合计** | **28** | **28 pass / 0 fail，约 15.5 秒** |

单套件硬上限 300 秒（`run-ci.mjs:134`）——15.5 秒有充足余量。

### 8.2 破坏性验证

`node scripts/qa/unified-probes.mjs` → **11/11** 条探针同时满足
**改到 ∧ 变红 ∧ 逐字节还原 ∧ 非崩溃**（`applied ∧ red ∧ restored ∧ !crashed`）。
跑完后 `git status --short` 为空——这是"逐字节还原"的独立证据。

**两条探针改进了用例本身**（这两条是本次最值得记的收获）：

| 探针 | 它揭穿的事 |
| --- | --- |
| P1 | 腿 1 判据 ① 原本有五个读数（`innerWidth`/`dpr`/`maxTouchPoints`/UA/`pointer:coarse`），**没有一项**由 `mobile` 这个 CDP 开关控制——把 `mobile: true` 改成 `false`，用例照样全绿。实测补上唯一随该标志位变的读数 `screen.width/height`，并补 P1b/P1c 覆盖另外两个开关（触屏、DPR），使三个开关各有一条独立可红的判据 |
| P9 | 腿 4 判据 ⑥ **改到了却不红**：它的断言是 `includes('executor-proof.json')`，而 `result` 帧的 summary 里**也**含这个文件名——把两行 progress 全删掉，用例依然绿。收紧为只可能由 progress 帧产生的形状（`${taskId} 进展：…`，来自 `server.mjs:7758` 的投影） |

### 8.3 顺带修掉的一处**既有**门禁缺口

`desktop/scripts/payload-filter.test.mjs` 在基线 `508a5892` 上**被跟踪、却没有任何套件登记**
（`run-ci.mjs` 零命中、也不在条件目录/条件文件/`EXEMPT` 里、`desktop/package.json` 的
`test` 脚本也没列它）⇒ 完备性判据在基线上必然报 1 个未登记文件、`test` 阶段 FAIL。

这**不是本批引入的**。按判据自己的话「未登记 = 不存在的断言」，这 6 条断言
（含「换名字的备份也要挡住」与两条反例）此前从未执行过。

修法走既有模式（加进 `desktop/package.json` 的 `test` 脚本，由 CI 动态解析）。
实测：该文件 6/6 通过、`desktop` 套件 20/20 通过、忠实复刻判据后
**520 个被跟踪的 `*.test.mjs` 未登记数 = 0**。

### 8.4 评审时最该看的三处

1. `product/upgrade/feed.mjs` 的**装载期自检**（`FEED_CHECKED`）——
   它第一次跑就否掉了我凭估算写进固定向量的长度（估 372、实测 344）。
2. `tests/e2e-unified/mobile.e2e.test.mjs` 判据 ① 的注释表——
   三个 CDP 开关各自控制哪几个读数，是**量出来的**。
3. `scripts/qa/unified-probes.mjs` 的 `patchText()`——
   `scripts/e2e/cdp.mjs` 是全文 CRLF，而锚点写成 LF 多行字符串时**一条都命不中**，
   表现却像"这条判据测不出来"。锚点匹配现对行尾不敏感，同时仍逐字节还原。

