# 三端统一端到端测试（T-195 提出，T-198 重写腿 3 并落地到 main）

> 移动端 / 桌面端 / 桌面端自动更新。设计依据与勘察读数：
> [`docs/superpowers/plans/2026-10-09-unified-e2e-harness.md`](../../docs/superpowers/plans/2026-10-09-unified-e2e-harness.md)
>
> **T-198 的收敛**：腿 3 第一版自带一个 `product/upgrade/feed.mjs`（560 行），
> 那是 `product/update/envelope.mjs` + `feed.mjs` 的**并行实现**（它的基线早于
> `product/update/` 落地），且**没有任何生产消费者**。现改为直接用真模块，
> 那份实现已删除。理由与代价见下面「腿 3 的重写」。

## 这是什么

一句话：**一条时间线，四个入口。**

用户要的是"三端**统一**测试"。三端各写一套夹具加起来不是统一，只是三堆测试——
它们各自都能绿，却回答不了*"同一个用户动作在三个端上是不是同一件事"*。
所以这里四条腿共用同一个真 Hub、同一份种子、同一套判据纪律。

| 腿 | 文件 | 验什么 | 用例 |
| --- | --- | --- | --- |
| 1 移动端 | [`mobile.e2e.test.mjs`](mobile.e2e.test.mjs) | 真 Chrome **移动仿真**驱动真 `workbench/mobile/app.mjs` → 真 Hub | 6 |
| 2 桌面端 | [`desktop.e2e.test.mjs`](desktop.e2e.test.mjs) | 真 `desktop-bridge.mjs` **子进程** + 真协议校验 + 真壳启动页 | 5 |
| 3 自动更新 | [`update.e2e.test.mjs`](update.e2e.test.mjs) | **真发布**（`buildPublish`）→ 真 Hub `/legion/*` 托管 → **真客户端**（`createUpdateClient`）→ 真安装事务 | 10 |
| 4 三端闭环 | [`loop.e2e.test.mjs`](loop.e2e.test.mjs) | 手机派单 → Hub → 真 `product/node` 进程领取执行 → 进展回到手机 | 7 |

合计 **28 例**，本机实测 **28 pass / 0 fail，约 15.9 秒**（CI 单套件上限 300 秒）。

## 怎么跑

```powershell
# 四条腿一起（与 CI 的跑法一致）
node --test tests/e2e-unified/mobile.e2e.test.mjs tests/e2e-unified/desktop.e2e.test.mjs tests/e2e-unified/update.e2e.test.mjs tests/e2e-unified/loop.e2e.test.mjs

# 单跑一条腿（最快的反馈）
node --test tests/e2e-unified/update.e2e.test.mjs

# 破坏性验证：证明每条判据真的能红（必跑，见下）
node scripts/qa/unified-probes.mjs
```

找不到 Edge/Chrome 时，腿 1 与腿 2 的浏览器部分**整组 SKIP**——
不伪造通过、也不计失败，并由 CI 的 `skippedSuites` 汇总**显式报出跳过数**。
用 `DSH_E2E_BROWSER=<可执行文件>` 可指定浏览器。

## 判据纪律（三条，都是这个仓库反复付过代价的）

**① 判据落在不可伪造处。** 优先断言服务端状态、磁盘、真实进程退出码，
而不是 DOM 文案或接口返回码。

> 一个「DOM 上出现了任务卡片」的断言，
> 与一个「Hub 库里真的多了一条任务」的断言，在手机上长得一样——
> 只不过前者在一个只渲染本地状态的实现上照样是绿的。

**② 等真实后果，不要睡够时间。**

> 一个「睡够 1 秒就假定会话建好了」的用例，
> 与一个「真的等到了那条会话」的用例，在快机器上是同一个东西——
> 只不过前者在慢机器上会变成一个看起来像产品缺陷的红。

（腿 1 的做法：轮询 `agent_conversation_bindings`，因为 `state.convId` 是页面内部状态。
第一版等的是"状态点离开 muted"——那是我臆想的信号，实测它根本不成立。）

**③ 断言必须精确到被测的那条通道。**

> 一个只断言「某个字符串出现过」的用例，
> 与一个「那条通道根本没接线」的产品，是同一个东西——只不过前者的用例是绿的。

（腿 4 的判据 ⑥ 第一版就犯了这个错：`result` 帧的 summary 里也含那个文件名，
于是把两行 progress 全删掉用例照样绿。**这是探针 P9 抓出来的**。）

## 破坏性验证（`node scripts/qa/unified-probes.mjs`）

**12 条**探针，覆盖四条腿的每个关键判据。脚本对每条探针**分开报四件事**：

- `applied`——补丁真的改到了字节；
- `red`——**断言级**失败（崩溃式变红**不算**证据）；
- `restored`——逐字节还原；
- 锚点命中数（`find` 必须恰好命中一次）。

后两项专门治这个仓库记过的三种形状（`docs/STATUS.md` 多处）：
**锚点没命中**（表现像"判据无效"）、**跑错测试文件**、**崩溃式变红**。
锚点匹配**对行尾不敏感**（`scripts/e2e/cdp.mjs` 是全文 CRLF，第一版 LF 锚点两条探针全落空）。

实测：**12/12 全部满足「改到 ∧ 变红 ∧ 逐字节还原 ∧ 非崩溃」**。

其中五条探针**改进了用例或修掉了真缺陷**，值得单独记：

| 探针 | 它揭穿的事 |
| --- | --- |
| P1（关掉 `mobile` 标志位） | 腿 1 的判据 ① 原本有五个读数，**没有一项**由 `mobile` 这个 CDP 开关控制。补上 `screen.width/height`（实测只有它随该标志位变），并补 P1b/P1c 覆盖另外两个开关 |
| P9（删掉 progress 帧） | 腿 4 的判据 ⑥ **改到了却不红**——断言太弱。收紧为只可能由 progress 帧产生的形状 |
| **P6**（停掉路径段白名单） | P6 第一版打的是 `value.includes('%')` 那条检查，实测 **fail=0**：它是**冗余的**，`%2e%2e` 会被后面的段白名单拒掉（`segment === '..'` 那条同理）。三条检查叠着是纵深防御，但探针必须打**起决定作用**的那一条 |
| **P7**（停掉 transport 的摘要校验） | 腿 3 的判据 ⑩ 第一版**名不副实**：它传了个错的 `manifestDigest`，客户端在 `sameIdentity()` 就以 `IDENTITY_MISMATCH` 拒了，**根本没走到**摘要校验。改成"清单不变、托管上的字节变了"（且**保持长度**，否则先被大小检查拦下）才真的守住它 |
| **P10**（Hub 缓存头退回自己写的字面量） | ★ 它守的是腿 3 在真 Hub 上**真的抓出来**的那个生产缺陷——见下节 |

> 这三条都指向同一件事：**一条判据可能被"另一个正确的理由"满足**。
> 那样的绿在"判据被删掉"之后依然是绿的，而它与"判据在工作"在报告上长得一样。

## 本批补的缺口（此前**整个不存在**）

1. **`cdp.mjs` 的移动端仿真**。基座此前明写「**不做**：…移动端仿真」，
   且把 `mobile` 硬编码为 `false`。现补 `mobile` 档、`setTouchEmulationEnabled`、
   移动 UA、`page.tap()`/`tapAt()`/`tapFill()`（走 `Input.dispatchTouchEvent`）。
   **默认仍是 `mobile:false`**——既有桌面套件的挂载参数与行为不变。
2. ~~`product/upgrade/feed.mjs`：设计稿 §5 的签名通道信封与客户端校验器。~~
    **T-198 已删除这份实现**——见下面「腿 3 的重写」。它所覆盖的那一层在 main 上
    由 `product/update/` 承担，而腿 3 现在直接用那些模块。
3. **`fixtures/executor-worker.mjs`**：可复用的 `--agent` 执行器。
   此前仓库里只有内联 `node -e`，**没有任何 committed 的 worker**，
   于是"进展真的会出境"这条路径从来没被端到端跑过。
4. **没有测试驱动过的东西**：`workbench/mobile/app.mjs`（此前 CI 里没有任何一步真的执行它）、
   `product/launcher/desktop-bridge.mjs` 真进程（此前只有 `fakeBridge()`）、
   `product/node/entry.mjs`（此前**全仓没有任何测试 spawn 过它**）。

## 腿 3 的重写（T-198）：为什么删掉那 560 行

第一版（T-195）为了驱动"自动更新"这条腿，自己写了一个 `product/upgrade/feed.mjs`：
设计稿 §5 的签名通道信封、严格 JSON、路径安全、`sequence` 栅栏、流式下载、固定向量。
它的**基线早于 `product/update/` 落地**，所以那是一份**并行实现**。

而 `main` 上 feeds 住在 `product/update/`，`product/upgrade/` 至今没有 feed。
更要紧的是：那份实现**没有任何生产消费者**——只有本套件的用例与探针 import 它
（`git grep -l "upgrade/feed.mjs"` 只有两处命中，都是测试）。

> 把一份"只有测试用"的协议实现合进主干，
> 等于给仓库再加一套会与真实现漂移的东西——而它的绿全部来自它自己。

现在腿 3 的构造是：

```
buildPublish / writePublish   ← 真发布器（产出 immutable/ + channel/）
materializeUpload             ← 「上传」那一步：两棵子树合并进同一前缀
startHub(releasesDir)         ← 真 team-hub 的 /legion/* 生产路由
createUpdateClient            ← 真客户端：check（真 HTTP）→ download（真 HTTP）
runInstallTransaction+runHelper ← 真安装事务
```

**它与 `product/update/integration.test.mjs` 的分工**：那条把托管换成**内存替身**
（换来完整链路能离网跑，且覆盖事务内部逐步读数）；本腿换了**唯一一样东西**——
托管是真服务器，换来的是缓存头、扩展名白名单、穿越防护、Range 续传这些
**只有真 HTTP 才有**的行为被真的走一遍。

### ★ 这次重写当场抓出一个**生产阻断**缺陷

第一次跑腿 3 的 ⑨ 就红了：

```
net-http-status   releases/rel-1.1.0/manifest.json 的 Cache-Control 是
                  "public, max-age=86400"，发行文件应包含 immutable
```

- 客户端（`product/update/transport.mjs`）对**每一次取件**都跑 `evaluateResponse()`，
  它对发行文件的判据是 `RELEASE_CACHE_CONTROL = 'public, max-age=31536000, immutable'`；
- 而 Hub 的 `team-hub/routes/releases.mjs` 自己写了一份字面量 `'public, max-age=86400'`。

两者各写一份 ⇒ **经 Hub 托管的发布目录，客户端一份都不会接受**（检查阶段即失败）。
`integration.test.mjs` 看不见它：它的替身返回的正是客户端想要的那个值。

> 一个"对着自己写的静态替身验证通过的更新链路"，
> 与一个"真的能从生产托管取到更新"的链路，在测试报告上是同一个东西——
> 只不过前者在缓存头写错时照样是绿的。

**已修**：Hub 改用单一真源 `expectedCacheControl()`（并归一化前导分隔符——
`found.rel` 是 `abs.slice(absRootLength)` 的形状，带前导 `/`，不归一化会**静默走错分支**：
通道清单被当成发行文件）。探针 **P10** 守这件事，见上表。

> ⚠️ 顺带量到的生产事实（2026-10-10）：`https://legion-si.online/legion/releases/…`
> 真实返回 `Cache-Control: public, max-age=86400`（即上述缺陷的现场），
> 而两个托管面上的 `feeds/stable/win-x64.json` **都是 404**——从未发布过任何通道清单。
> 修这个缺陷是让"发布 feed 之后客户端能接受"成为可能；**不等于**通道已经能用了。

## 诚实边界（**先写在这里**）

- **没有启动 Electron。** `desktop/node_modules` 不存在（electron 44.4.5 未装），
  而 `LEGION.md` 明令禁止联网下载依赖。腿 2 验的是桌面壳的**边界**
  （真 bridge 进程、真协议、真启动页），**不是** Electron 主进程。
  `desktop/main.mjs` 的窗口/托盘/`ipcMain` 真路径/单实例锁/退出事务**仍未被覆盖**。
- **没有真机、没有真安装包、没有 Authenticode。** 腿 3 的 `installer` 是**占位文件**，
  只为满足发行清单的形状，**不可安装**。
- **本地 Hub 是 `http://127.0.0.1:<port>`。** 正式更新**必须** HTTPS，所以腿 3 显式传
  `allowInsecureHttp: true`——那是 `host.mjs` 为测试留的唯一开关（`createHostConfig`
  对明文 origin 默认拒绝）。把它写在代码里，是为了让"本地 HTTP"这件事**看得见**，
  而不是让某处悄悄降级。
- **包是真的 ZIP**（main 的 `product/update/zip.mjs` 打真包、含包内 `closure.json`），
  且 helper 会**真的**验闭包（事务文件里的 `closureEntry` 摘要在签过名的发行清单里）。
  T-195 时代"没有 ZIP 写入/解包代码"的边界**已经不再成立**，本条随之更正。
- **没有 HTTPS、没有 CDN、没有公网。** 传输安全与公网回读属设计稿 §10 阶段 D。
- **执行器是夹具，不是 DSH。** `product/node/executor.mjs` 自己写明 DSH adapter 是
  "这个接缝的下一个实现"——本套件证明的是**接缝与整条链路**，不是"DSH 能跑任务"。
- **健康探针由测试注入**（`probeHealth` 的真实默认实现今天不存在，见
  `docs/superpowers/prt/PRT-801-813-install-upgrade-rollback.md` §315-369）。
- **移动端不是真机**：桌面 Chrome 的设备仿真，触摸/UA/视口/DPR **相似而非相同**。
