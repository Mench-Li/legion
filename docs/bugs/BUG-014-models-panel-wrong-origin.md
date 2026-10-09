# BUG-014｜「供应商与模型」页把请求发到了**另一个数据源**，用户只看到浏览器的一句 `Failed to fetch`

> 发现于 2026-10-09，起点是将军的报告：**「供应商与模型还是 failed」**（截图里的原文就是 `Failed to fetch`）。
> 这是 BUG-001 的**下一层**：那一处修的是「桥接层 → 宿主」写死 3080；这一处是「页面 → 桥接层」
> 用错了 base。两处的形状完全相同 —— **一个指向没人监听的地址，被渲染成一句与地址无关的话**。

## 0. 现象与一句话根因

浏览器在 `http://127.0.0.1:5173/` 打开指挥台 → 「设置 → 模型与凭证 → 供应商与模型」→
整页只有一条红色提示，原文是 **`Failed to fetch`**。

根因一句话：

```ts
// workbench/src/api.ts（修前）
const response = await fetch(`${apiBase()}/api/dsh-models`, …)
//                          ^^^^^^^^^^ 没有 ?api= 时 = http://127.0.0.1:4820 —— 那是**另一个**数据源
```

`apiBase()` 默认指向 **4820**（v1 看板 `scrum/serve.mjs` 的默认端口，`App.tsx` 里连启动指引都写着它），
而 `/api/dsh-models` 这条路由住在 **5173**（发这个页面的那台 `serve.mjs`）。
4820 上没人监听 ⇒ 浏览器回 `TypeError: Failed to fetch` ⇒ 面板把 `e.message` 当错误原文渲染 ⇒ 用户看到 `Failed to fetch`。

## 1. 证据链（每一环都是实测，可复跑）

| # | 读数 | 命令 / 来源 |
| --- | --- | --- |
| ① | `apiBase()` 无覆盖时 = `http://127.0.0.1:4820` | `workbench/src/api.ts` 的 `DEFAULT_API` |
| ② | **4820 上没人监听** | `Get-NetTCPConnection -State Listen` 只有 `5173 / 8787 / 19387` |
| ③ | 打 4820 ⇒ `TypeError: fetch failed`，`cause: ECONNREFUSED`（浏览器把同一件事说成 `Failed to fetch`） | `fetch('http://127.0.0.1:4820/api/dsh-models', …)` |
| ④ | 打 **5173** ⇒ `401 {"error":"模型服务连接未授权，请重新连接服务后刷新配置。"}` —— 路由**在**这里 | `POST :5173/api/dsh-models {method,args}` |
| ⑤ | 服务端**强制同源** | `workbench/scripts/serve.mjs:2624` `Same-origin browser calls only.` + `Origin.host !== Host ⇒ 403` |
| ⑥ | 这条路由**只限本机** | 同文件 `2617` `if (!isLoopback(req)) 403 '模型配置仅限本机访问'` |
| ⑦ | `apiBase()` 的 4820 **不能**顺手改成同源：它服务的 v1 看板路由 `serve.mjs` **一条都不提供** | 对 `/api/config`、`/api/board`、`/api/activity`、`/api/missions` 在 `serve.mjs` 里 grep = 0 命中；`App.tsx:551` 的指引就是「运行 `node scrum/serve.mjs --port 4820`」 |

③ 与 ④ 合起来就是这次事故的全部：**同一台机器上有两条数据源，请求发给了不在服务的那一条。**

> ⑤ 是关键的一条：**服务端自己说这条路只接受同源**，而客户端把它发到了另一个源。
> 所以这不是"默认值不够聪明"，是**用错了地址** —— 修法必须是"选对 base"，不是"调默认值"。

## 2. 为什么失败信息是 `Failed to fetch`（这条也要修）

浏览器对"连接被拒 / 域名不存在 / 被拦"一律只说 `Failed to fetch`：**不说地址、不说原因**。
这与 BUG-001 里 Node 的 `fetch failed` 是同一个病 —— 那一处已经写了「连不上宿主时要说的话」，
但那只覆盖了**桥接层 → 宿主**这一段；**页面 → 桥接层**这一段没有任何同类处理，
于是浏览器那句笼统的话原样出现在面板上，把排查方向指向网络与供应商。

## 3. 修法（两处，都在 `workbench/src/api.ts`）

### 3.1 地址：改用**同源相对路径**

```ts
const DSH_MODELS_PATH = '/api/dsh-models'
…
response = await fetch(DSH_MODELS_PATH, { method: 'POST', credentials: 'include', … })
```

为什么是相对路径而不是拼 `location.origin`：相对路径由浏览器按**页面自己的源**解析，
在 `file://` / 自定义协议下也不会拼出一个假的绝对地址。

**为什么不改 `apiBase()` 的默认值**（这是最容易做错的一步）：`apiBase()` 服务的 v1 看板
（`/api/config`、`/api/board`、`/api/activity`、`/api/missions`…）是**另一台进程**
（`scrum/serve.mjs`，默认 4820），`serve.mjs` 一条都不提供。把默认改成同源，
等于把这几个页面从"连不上 v1 看板"改成"连不上任何东西"。**两条数据源各有各的地址，
混用哪一个方向都是错的** —— 所以修法是把这一条路由送回它自己的源，并给 `apiBase()` 加一条反向护栏（见 §4 ③）。

### 3.2 文案：连不上时说出**地址 + 原因 + 这是哪条链路**

```ts
function modelsUnreachableError(e: unknown): Error {
  const cause = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? '未知原因'
  return new Error(`连不上指挥台自身的数据面（${origin}${DSH_MODELS_PATH}）：${cause}。`
    + '这一页的「供应商与模型」由**发这个页面的那台 serve.mjs** 提供（同源、且仅限本机）；'
    + '它与 4820 那个 v1 看板数据源不是同一台服务。')
}
```

**保留 HTTP 层的既有文案**（401 的「模型服务连接未授权…」、桥接层给的「连不上模型配置宿主（…）」）——
这一修只动 base 与**网络层**文案，不许吃掉 BUG-001 那批具名错误。

## 4. 判据（`workbench/scripts/dsh-models-base.test.mjs`，5 例）

| 用例 | 断言 |
| --- | --- |
| ① | 请求 URL 恰好是 `/api/dsh-models`（相对路径），**不含** 4820、也不是绝对地址 |
| ② | 源码层：`dshModelsRpc` 里**不许出现** `apiBase()`（它属于 v1 看板那条源） |
| ③ | **反向护栏**：`apiBase()` 的默认值**必须仍是** 4820，且在本页 origin 为 5173 时仍回落到 4820 |
| ④ | 网络层失败时抛出的消息：不含 `Failed to fetch`，含**实际地址**、原因码 `ECONNREFUSED`、链路说明（`serve.mjs`/同源）、以及"与 4820 不是同一台服务" |
| ⑤ | 401 与桥接层给的具名错误**原样穿透**（这一修没吃掉 BUG-001 的产物） |

**反向验证（4/4 实测变红）**：

| 变异 | 结果 |
| --- | --- |
| M1 把 `dshModelsRpc` 打回 `${apiBase()}/api/dsh-models`（= 线上原样） | **红①②** |
| M2 把 `apiBase()` 的默认值改成同源（顺手改坏 v1 看板那条路） | 绿①②④⑤，**红③** |
| M3 `catch` 里直接把浏览器原话抛出去 | 绿①②③⑤，**红④** |
| M4 改掉 401 的文案 | 绿①②③④，**红⑤** |

> ★ 一处**自我订正**：M3 的第一版是一次**粗暴删行**的变异，改完文件语法就坏了 ⇒
> 测试进程直接崩，输出为空（不是"变红"，是"没跑"）。我把变异改成"`catch` 里 `throw e`"
> 这个**语法安全、语义等价**的写法之后才真正测到 ④。
> 教训与 BUG-012 §7.3 同族：**一次"没有输出"的变异既不是绿也不是红** ——
> 把它当成"没红"就会漏掉；必须先确认变异本身是合法程序。

## 5. 与 BUG-001 / BUG-004 的关系

| | 它修的是哪一段 | 失败时的原话 |
| --- | --- | --- |
| BUG-001 | **桥接层 → 宿主**（写死 3080 → 由启动方注入 `DSH_MODELS_BASE_URL`） | `fetch failed`（Node 的笼统说法） |
| BUG-004 | 绑定表指向一个**已不存在的供应商** `custom-ds` | 0 token 立即失败 |
| **BUG-014（本条）** | **页面 → 桥接层**（`apiBase()` 的 4820 → 同源） | `Failed to fetch`（浏览器的笼统说法） |

三段是**同一条链上的三跳**，每一跳都曾把"地址/身份错了"说成"网络不通"。
本条修完，这条链上每一跳的失败信息都能指出**它自己那一段**。

## 6. 生效条件与已知边界

- **要重新构建 `workbench/dist` 并刷新页面**：被托管的 workbench 服务的是 `workbench/dist`
  （命令行 `…\legion\workbench\scripts\serve.mjs --port 5173`），源码改动必须重新构建才会进浏览器。
  实测构建前的 `dist` 比 `src/api.ts` 旧约 15 小时 —— 也就是说**线上跑的是一份旧包**。
- **★ 下一层（凭证）已在 §7 修掉**：把地址修对之后，面板拿到的是
  `401 模型服务连接未授权，请重新连接服务后刷新配置。` —— 那是**凭证**缺，不是地址错。
  这个"从 `Failed to fetch` 变成 401"的推进是**实测的**（将军 2026-10-09 报告 "bug-014未修复，现在报错变为：模型服务连接未授权"），
  也是本条写下的判别法生效：**中文未授权文案 ⇒ 地址已对**。

## 7. 第二层：凭证（设计 A —— 让用户的浏览器登一次）

### 7.1 真因（读宿主源码，非推断）

宿主 `:19387` 的 `/api/*` 只认**它自己的浏览器会话**：

```ts
// packages/client/connection/src/browser-auth.ts
const COOKIE_PREFIX = 'dsh-auth-'
function cookieName(authority) { return COOKIE_PREFIX + base64url(sha256(authority)) }  // authority = 127.0.0.1:19387
// cookieMaxAgeDays 默认 30；值 = v1.<base64url(payload)>.<HMAC(secret)>，HttpOnly + SameSite=Strict
```

而桥接层转发的是**浏览器自己的** cookie（`forwardDshModels(body, { cookie: req.headers.cookie })`）。
在普通浏览器里打开 `:5173` 时那条 cookie **不存在**（它只存在于 DSH 桌面窗口自己的 cookie 库）
⇒ 无论地址多正确，三个读取永远是 401。

> ★ 订正：§7 之前的版本里我把这条 cookie 的名字写成 `dsh_session_…` —— **那是我从记忆里写的**，
> 代码里是 `dsh-auth-`。同一条纪律：**名字类结论要读那一行**。

### 7.2 解药：宿主铸一条登录 URL，指挥台把浏览器送过去

DSH 自己的桌面壳就是这么给窗口登录的（`apps/desktop-host/src/index.ts:103`
`ctx.connection.authenticatedUrl(\`http://127.0.0.1:${port}\`)`）。这条 URL 带 `?token=<launchToken>`，
浏览器**顶层导航**过去时 `authorizeIndex` 会 303 + `Set-Cookie`。

**cookie 按主机存放、不按端口隔离** ⇒ 同一个浏览器里的 `:5173` 与 `:19387` 共享这条会话
（`SameSite=Strict` 只在跨**站**时拦，`127.0.0.1` 的不同端口是同站）。

| 改动 | 内容 |
| --- | --- |
| `services-plugin/index.js` | 新增纯函数 `deriveDshModelsLoginUrl()`；`buildWorkbenchEnv` 增 `DSH_MODELS_LOGIN_URL`（空 ⇒ 不注入）；用 `ctx.get('connection')` **软取** |
| `workbench/scripts/config-schema.mjs` | 新增 `modelsLoginUrl`（`sensitive: true`） |
| `workbench/scripts/serve.mjs` | 新增 `GET /api/dsh-models/connect`：本机 + 同源 + `requireWriteToken` ⇒ **302** 到登录 URL，带 `no-store` / `no-referrer` |
| `workbench/src/components/DshProvidersPanel.tsx` | 401 时渲染「连接 DSH 服务（本机浏览器登录一次）」按钮 ⇒ `window.open('/api/dsh-models/connect')` |

**★ 我自己在这一版里犯的一个会停服的错（已改，并加了反向护栏）**：
第一版我把 `connection` 写进了 `export const inject = ['webServer', 'connection']`。那是错的 ——
Cordis 的 `inject` 是**硬依赖**，名字在而组合里没有这个服务，**整个插件会停在 pending**，
于是 `team-hub` 与**指挥台都不会启动**；而它换来的只是"登录 URL 能不能铸出来"。

> 一个"锦上添花"的能力，绝不能带"少一个服务就什么都不起"的失败模式。
> 它的失败方向必须是**少一个能力**，而不是**少两个服务**。

DSH 自己的 `web-app` 就是这么分的：`export const inject = ['webServer']`（硬）
+ `ctx.inject(['connection'], …)`（软）。本插件改为 `ctx.get('connection')` 软取，
并新增反向护栏用例钉住"connection 不许进 inject"（变异 M6 实测变红）。

**三条刻意的设计约束**（各有用例守着）：

1. **登录 URL 里必须真的带 token**，否则视为拿不到 —— 一个"看起来配了、其实没令牌"的地址，
   与没配的地址，在界面上是同一种失败（又一条 BUG-001 形状）。
2. **令牌绝不落盘、绝不进日志**：`.legion-services.log` 是明文长期留存的，
   所以那条日志只说"已注入"，不打印 URL 本身。**一条把令牌写进日志的"方便排查"，就是把一次登录换成一份永久凭证。**
3. **`connect` 必须过 `requireWriteToken`** —— 它发出去的是一个操作员凭证（见 §7.4）。

### 7.3 判据（新增 11 + 6 例，全部已登记进 `run-ci`）

| 套件 | 守什么 |
| --- | --- |
| `services-plugin/index.test.mjs`（11 例，新增 5） | 登录 URL 必须带 token；取不到/抛错 ⇒ 空；空 ⇒ **不注入**；与宿主地址注入互不挤占 |
| `workbench/scripts/dsh-models-connect.test.mjs`（6 例，新） | 302 原样带令牌 / `no-store`+`no-referrer` / 没注入 ⇒ **503 且明说"是凭证缺不是地址错"** / 配了 token 就必须 Bearer / 非 GET 405 / 跨源 403 |
| `workbench/scripts/dsh-models-base.test.mjs`（5 例，阶段一） | 地址必须同源 + 网络层文案 + `apiBase()` 默认值的**反向护栏** |

**反向验证 5/5 全部实测变红**：

| 变异 | 结果 |
| --- | --- |
| M1 `deriveDshModelsLoginUrl` 不再校验 token | services-plugin **有失败用例**（fail=1） |
| M2 登录 URL 恒注入（空值也注入） | 同上（fail=1） |
| M3 `connect` 拿不到地址时回 200 + 空 Location | **红③** |
| M4 `connect` 去掉 `requireWriteToken` | **红④** |
| M5 302 去掉 `no-store`/`no-referrer` | **红②** |

### 7.4 ★ 我上一版说错的一句话，以及这一版补的闸

我在给将军的选项表里写过 A 案"**无新增提权**" —— **那句话是错的**，必须订正：

> `connect` 这条路由**本身**要把一个操作员登录 URL 交出去。因此**谁能访问 `:5173`，谁就能拿到它**：
> 一个本机进程只要 `curl -i http://127.0.0.1:5173/api/dsh-models/connect` 就能拿到 302 的 Location，
> 自己走一遍交换、拿到 30 天的宿主操作员会话。这与 B 案（桥接层自持 cookie）**是同一个暴露面** ——
> A 案省掉的只是"指挥台进程里长期驻留一份凭证"，并没有省掉"本机可及就能取得凭证"这件事。

**所以两案真正的安全边界都是 `:5173` 自己**，而它当前**没有令牌**
（`.legion-services.log`：`[workbench] … token=(未设置)`）。已做的与建议做的：

- **已做**：`connect` 过 `requireWriteToken`，与「写供应商配置」同一道闸 —— 配了令牌就拦得住（用例 ④ 钉住）。
- **建议（未做，需你裁决）**：给托管路径的 workbench 配一个令牌。这已经不是 BUG-014 的范围
  （它影响的是 `/api/dsh-models` **全部**写路径，包括改供应商配置与写密钥），
  并且会牵动 Legion 自己的身份体系（指挥台要有办法把令牌交给浏览器）。
  **在这件事定下来之前，A 案把"宿主操作员身份"的取得条件降低到了"能访问本机 5173"。**

### 7.5 生效条件

- **要重启一次宿主**：`services-plugin` 是宿主插件，`inject` 与登录 URL 派生都在宿主进程里跑。
- 面板侧还要 **重建 `workbench/dist`**（已做；`serve.mjs` 每次请求读磁盘，不需要重启 workbench 进程）。
- 操作：刷新页面 → 面板显示未授权提示与「连接 DSH 服务」按钮 → 点一下（新标签会落到 DSH 界面）
  → 回到指挥台点「刷新配置」。会话约 30 天有效。

## 8. ★★ 第二版的整体方向被否掉并已拆除（2026-10-09，将军裁决）

> 「这样做肯定不行啊，我最终是反向包 DSH 的，也就是我在这个页面支持配置……**用户感知不到是 DSH才对**」

**§7 那一版（设计 A：让用户的浏览器去登 DSH）已按方向性错误拆除**，不是被改好。拆除清单：

| 拆掉的 | 位置 |
| --- | --- |
| `GET /api/dsh-models/connect`（302 到宿主登录 URL） | `workbench/scripts/serve.mjs` |
| 「连接 DSH 服务（本机浏览器登录一次）」按钮 | `workbench/src/components/DshProvidersPanel.tsx` |
| `deriveDshModelsLoginUrl()` + `DSH_MODELS_LOGIN_URL` 注入 | `services-plugin/index.js`、`workbench/scripts/config-schema.mjs` |
| `dsh-models-connect.test.mjs`（6 例）与它的 run-ci 登记 | 已删（登记处留了路标注释） |
| **保留** | `dsh-models-base`（同源相对路径 + 网络层具名文案，5 例）——它修的是**另一个**真缺陷（请求打到 4820） |

**为什么是方向错，而不是"层数不够"**：宿主 `/api/*` 只认它自己的浏览器会话 —— 这个事实是真的。
但"因此让用户去登 DSH"把**引擎的鉴权模型搬到了产品表面上**：用户会看到一个他不认识的登录页，
而 Legion 的配置面从此绑死在那条 30 天 cookie 上。产品要的是**用户只跟 Legion 打交道**。

**正确方向见 [docs/DECISION-legion-owns-model-config.md](../DECISION-legion-owns-model-config.md)**：
Legion 拥有配置（`team.db` + DPAPI 密钥库 = 唯一真相），DSH 的活配置由 Legion **派生**；
物化走宿主进程内的 `ctx.settings.mutate` / `ctx.credentials.set` / `ctx.llm` —— **无 HTTP、无 cookie、无登录**。
这四个服务一直是可用的（`legion-services` 就住在宿主进程里），只是前两版都没往那儿看。

**我在这条线上的两次同类错**（记在决定文档 §9，也记在这里）：第一次把桥接层的**地址**修对了却
没问"这条桥该不该存在"；第二次在错误的**传输方式**上又加了一层。
两次都是"在给定的那层里把活干好"，而不是"先问这一层对不对"。
**判据：动手之前先答一句「用户最终看到的是什么」。**

### 7.5 的生效条件随之作废

那一版的"重启宿主 + 点登录按钮"不再适用。当前状态：`/api/dsh-models` 仍是旧桥（转发到宿主已鉴权
`/api`），因此面板会如实显示未授权 —— **这是已知的、被接受的中间态**，直到
DECISION 文档的 P1/P3 落地（那时这一页读写的将是 **Legion 自己的库**）。
