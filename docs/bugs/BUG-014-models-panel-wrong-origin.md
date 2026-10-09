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
- **★ 本条的下一层（不在本条范围内，需要裁决）**：把地址修对之后，面板会得到
  `401 模型服务连接未授权，请重新连接服务后刷新配置。` —— 因为桥接层转发的是**浏览器自己的
  cookie**，而宿主 DSH 的会话 cookie 是按 authority（`127.0.0.1:19387`）签发的、只存在于
  **DSH 桌面窗口**自己的 cookie 库里。在普通浏览器里打开指挥台时，那个 cookie 不存在。
  这是 BUG-001 §6 就已经登记过的那条边界（"只注入地址而不解决'拿什么凭证跟宿主说话'，
  会把失败从 `fetch failed` 挪成 `401`"）—— 本条把失败从 `Failed to fetch`（**地址错**）
  推进到 `401`（**身份缺**），这一步是确定的；**再往前一步要单独设计并裁决**。
  留一个可观测的判别法：修好之后，如果面板显示的是**中文的未授权文案**，说明地址已经对了、
  只差凭证；如果仍是 `Failed to fetch`，说明还有第三个地址在错。
