# BUG-001｜「供应商与模型」整页读不出来

> 现象、根因、修法、判据四段。判据都是**可复跑的命令**，不是"我看过了"。

## 1. 现象

「模型与凭证设置 → 供应商与模型」标签页读不出任何东西：

- 页面上只有一句 `连不上模型配置宿主…`（修前是 Node 的笼统说法 `fetch failed`）；
- `session/modelCatalog` / `llm/listConfigurableProviders` / `settings/describe`
  三个读取方法**全部**失败，所以既看不到供应商列表，也看不到模型目录、也进不了编辑表单。

关键点：**故障与用户填的 API 密钥、地址、模型名全都无关**——供应商那边一次请求都没发出去。

## 2. 根因

`workbench/scripts/dsh-models-bridge.mjs` 把 DSH 宿主的地址**写死**了：

```js
const response = await fetchImpl(`http://127.0.0.1:3080/api/${body.method}`)
```

3080 是 `dsh web`（web profile）的默认端口，在那种部署里恰好对；而本机的实际部署是
**Desktop**（`C:\Users\11150\.dsh\profiles\desktop`），宿主监听 **19387**。

实测（本机 2026-10-04）：

```text
GET  http://127.0.0.1:5173/            → 200   （指挥台在跑）
POST http://127.0.0.1:5173/api/dsh-models  {session/modelCatalog}
     → 400 {"error":"fetch failed"}           ← 修前：不说地址、不说原因
POST http://127.0.0.1:19387/api/session/modelCatalog  → 401 unauthorized  ← 宿主活着，只是要鉴权
```

于是一个**指向了没人监听的端口**的地址，被渲染成了一句和"网络不通"长得一样的
`fetch failed`，把排查方向指向了供应商与网络。

这与配置面里已经写明的一条教训是同一件事（`product/config-schema.mjs` 的 `injects` 表）：

> `DSH_HUB_UPSTREAM`：**派生值** —— workbench 必须指到本次启动的 hub，而不是默认 8787。

**模型配置的宿主地址同样是派生值**：只有启动方知道这一轮宿主绑在哪个端口。

## 3. 修法

三处，都是"把默认值换成派生值"：

| 位置 | 改动 |
| --- | --- |
| `workbench/scripts/dsh-models-bridge.mjs` | 新增 `baseUrl` 选项与 `normalizeDshBaseUrl()`；`DEFAULT_DSH_BASE_URL`（3080）只作独立跑 web profile 的兜底。连不上时抛**具名**错误：地址 + 原因码（`ECONNREFUSED`…）+ "这是宿主地址问题、不是供应商问题"；超时（`TimeoutError`）单独一条（504）——**等待超时不等于地址写错**，两者给的下一步不同 |
| `workbench/scripts/serve.mjs` | `DSH_MODELS_BASE_URL`（统一配置引擎读取，见 `workbench/scripts/config-schema.mjs`）透传给桥接层 |
| `services-plugin/index.js` | 按 `ctx.webServer.port` **派生**宿主地址，spawn workbench 时注入 `DSH_MODELS_BASE_URL`；取不到就**不注入**并写一行日志说明 |

为什么"取不到就不注入"而不是回落 3080：回落到一个没人监听的端口，得到的正是本次事故的
形状（看起来配了、其实连不上）。**空**是一个能被日志和页面说清楚的答案。

派生逻辑抽成纯函数 `deriveDshModelsBaseUrl()` / `buildWorkbenchEnv()`，优先级：
composition 的 `config.dshModelsBaseUrl` > `ctx.webServer.port` > 宿主的 `DSH_WEB_URL`。

## 4. 判据（可复跑）

```bash
# ① 桥接层：地址随部署走 / 连不上时说得清 / 宿主鉴权与写入边界
node --test workbench/scripts/dsh-models-bridge.test.mjs          # 10 例

# ② 注入侧：宿主端口派生、取不到就不注入
node --test services-plugin/index.test.mjs                        # 6 例

# ③ 配置面：新键已声明、扫描无盲区
node scripts/config/scan.mjs --check --process=workbench
node scripts/config/scan.mjs --check --process=services-plugin
node scripts/config/check.mjs --process=workbench --show-source | findstr DSH_MODELS_BASE_URL

# ④ 端到端：起三个 workbench 实例（三种部署形状），打真实的 /api/dsh-models
node docs/bugs/BUG-001-verify.mjs
```

④ 的读数（本机实测，桩宿主监听临时端口，真实宿主只收到一个必然被拒的请求）：

| 场景 | 注入 | 结果 |
| --- | --- | --- |
| 修前的形状 | 无（回落 3080） | `502 连不上模型配置宿主（http://127.0.0.1:3080/api/llm/listConfigurableProviders）：ECONNREFUSED…不是供应商的问题` |
| 修复后（桩宿主同信封） | 桩宿主端口 | 三个读取全部 `200`，`session/modelCatalog` 返回真目录；桩侧收到 `client-request` 信封，方法名与 `payload.args` 均正确 |
| 修复后（真实 Desktop 宿主） | `http://127.0.0.1:19387` | `401 模型服务连接未授权，请重新连接服务后刷新配置。` —— 请求**真的到达了宿主**，不再是"连不上" |

> 第三种是本条最要紧的读数：**401 是成功**。它证明地址对了、宿主活着、链路通了，
> 剩下的只是宿主会话鉴权（由 DSH 自己的登录态决定，不属于本 Bug 的范围）。

## 5. 为什么以前没被拦住

`workbench/scripts/dsh-models-bridge.test.mjs` 从写下那天起就**没有被任何 CI 套件登记**——
它的断言（未授权要说得清、写路径只许改供应商配置、模型元数据不许被覆盖）一次都没执行过。
而"宿主地址写死"这件事，没有任何一条断言在管。

处置：登记进 `scripts/ci/run-ci.mjs` 的 `suites`（`dsh-models` 与 `legion-services` 两套），
选择**登记**而不是 `EXEMPT` —— 豁免一份可执行且能过的证据，等于把它降级成一句声明。

## 6. 影响面与已知边界

- 只影响 Legion 指挥台的「供应商与模型」页**读取**；DSH 宿主自身、供应商配置数据、
  已保存的密钥都没有被改动（本 Bug 的修法不写任何配置）。
- 首次在 Desktop 部署里跑，页面上仍可能出现 **401**：那是宿主会话鉴权，
  与地址无关；修前那种"整页读不出来且说不清为什么"的形状不会再出现。
  （浏览器对 `127.0.0.1` 的 cookie **不按端口隔离**，所以 DSH GUI 那一侧登录后，
  指挥台转发过去的同一份 cookie 宿主是认的——这正是桥接层转发 cookie 的设计前提。）
- **生效需要重启 DSH 宿主**：`legion-services` 是宿主插件，注入代码在 `apply` 时挂载、
  在 spawn 子进程那一刻取值。在重启之前，已托管的 workbench 若没拿到
  `DSH_MODELS_BASE_URL`，仍会回落到 3080（修前的形状，但错误信息已经是可诊断的）。
- ★ **本机当前托管的 workbench 跑的是主检出**（`.legion-services.log`：
  `node D:\project\DSH\legion\workbench\scripts\serve.mjs`）。所以本修复要在主检出上生效，
  得把 `fix/bugs` 合进 `main`（或让托管指向本工作区），再重启宿主。
- **Launcher 路径（`product/launcher/`）未一并修**，这是**刻意的**：那条路同样缺
  `DSH_MODELS_BASE_URL`（workbench 的 `envNames` 里没有这个键），但它在桌面模式下走的是
  **Legion 自己的**会话鉴权（`product/local-auth.mjs` 的 `legion_session_<port>` + Bearer），
  与 DSH 宿主的会话不是一回事。只注入地址而不解决"拿什么凭证跟宿主说话"，会把失败从
  `fetch failed` 挪成 `401` ——**看起来像修好了**，而实际没有。这一条需要单独设计，
  已登记在案，不在本 Bug 的范围内。

