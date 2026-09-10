<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-10**（commit `2dd6091`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P2-8 浏览器助手增强 · 验证证据

**切片**：P2-8 浏览器助手增强（空间级抓取历史与缓存 / 更好的正文提取 / 可选截图能力 / 更细的限流与配额）
**日期**：2026-09-10
**代码位置**：`workbench/scripts/serve.mjs`（`/api/web/*`）、`team-hub/server.mjs`（`web_fetch_history` 表 + 历史路由）、
`workbench/src/browserUi.ts`（前端纯判定层）、`workbench/src/components/BrowserView.tsx`（界面）、
`workbench/src/api.ts`（客户端）、`workbench/src/types.ts`（类型）、`workbench/src/index.css`（样式）
**测试**：`workbench/scripts/web-p28.test.mjs`（21 例）、`workbench/scripts/browser-ui.test.mjs`（21 例）、
`team-hub/web-history.test.mjs`（1 例 / 20+ 断言）、`docs/P2-8-evidence/e2e-history.mjs`（跨进程端到端 17 项检查）

---

## 1. 交付内容与验证方式

| 子项 | 实现 | 验证 |
| --- | --- | --- |
| ① 空间级抓取历史 | `web_fetch_history` 表 + `POST /api/web/history`（写/累加）、`GET /api/web/history`（读/过滤/stats）、`POST /api/web/history/clear`（单条/整空间）；serve 侧 `recordWebHistory` fire-and-forget 回写 + `GET /api/web/history` 代理 | hub 侧 20+ 断言（累加/隔离/过滤/上限清理/清空/参数校验）；端到端 5 项（回写落库、标题与 host、stats、hits 累加、空间隔离） |
| ① 抓取缓存 | `webCacheGet/webCacheGetStale/webCachePut`（TTL + 空间隔离键）、`webFetch({conditional})` 条件请求 | 8 例（新鲜命中不发网络请求 / 304 复用且**不传 body** / 键含空间 / 键含 maxBytes / 截断不入缓存 / 过期读返回 null） |
| ② 正文提取 | `extractReadable`：样板剔除 + 候选打分 + 结构化渲染 + `quality` 元数据；`extractHtml` 保持原契约 | 6 例（导航/页脚/表单不入正文、标题/列表/代码/引用结构保留、无 HTML 透传、超长截断标记、短页优先语义容器） |
| ③ 可选截图 | `findShotBrowser` / `webScreenshot` / `readShot` / `listShots` + `POST /api/web/shot`、`GET /api/web/shot`、`GET /api/web/shots` | 3 例（默认关闭 → 409 `shot_disabled`、无浏览器 → 409 `shot_unavailable`、假浏览器打通成功路径含读回/防穿越/计数入配额/SSRF 仍拦截） |
| ④ 限流与配额 | `webQuotaBegin/webQuotaEnd/webQuotaRecordBytes/webQuotaSnapshot` + `GET /api/web/meta`；429 + `Retry-After` | 5 例（空间 RPM、站点 RPM、并发上限与回收、每日字节记账与超限、真路由 429 且带 `Retry-After` 头） |
| 前端 | 配额读数行、缓存/质量徽标、截图按钮与缩略图、本空间历史面板（点条回填重抓 / 单条删除 / 整空间清空） | `browser-ui.test.mjs` 21 例（判定层）；`tsc --noEmit` 零错误；`vite build` 通过；生产 :5173 已重建并核验 bundle |

## 2. 关键设计决策（与证据）

1. **历史「一行一地址 + hits 累加」而非逐次流水**：逐次流水已由 serve 侧 web 审计 JSONL 承担（R-A3 不变量），
   历史面板要回答的是「这个空间抓过哪些地址、结果如何、抓过几次」。同 `(scope,url)` upsert 并累加，
   才有唯一的 `scope,url` 唯一索引（`idx_web_history_scope_url`）。
2. **缓存键必须含空间**：初版键为 `url+maxBytes`，测试立刻暴露「A 空间抓过的页面，B 空间直接命中缓存」——
   既跨空间串内容，又**完全绕过 B 空间的配额**。现键为 `scope+url+maxBytes`，并保留 maxBytes 维度
   （上限不同 → 内容可能被截断得不同）。
3. **截断结果不入缓存**：`quality.truncated === true` 时 `webCachePut` 直接返回。否则用户调大 `maxBytes`
   后会一直拿到旧的截断内容，且没有任何提示——这是「缓存正确性」而非性能问题。
4. **限流只作用于标注了空间的调用**：配额是界面治理手段，脚本/自测/运维调用不带 scope 时只落审计。
   这条规则同时让既有 `web.test.mjs`（24 例，含一次性发多请求的审计轮转用例）语义不受影响——
   初版一律限流导致该用例第 3 次抓取就 429，暴露了「默认值不该惩罚非界面调用」。
5. **截图能力默认关闭且不打包浏览器**：引入 Playwright 会带来数百 MB 依赖与浏览器下载，与「零第三方依赖」
   的既有取捨冲突。改为探测本机 Edge/Chrome + `--headless=new --screenshot`，由 `DSH_WEB_SHOT_ENABLE=1`
   显式开启；`DSH_WEB_SHOT_BROWSER` 显式指定时互斥（否则「验证未找到浏览器分支」会意外拉起真 Edge）。
6. **截图目录不在静态根内**：`ROOT` 是 `workbench/dist`（静态根）。截图默认曾落 `dist/.dsh-shots`——
   会被当静态资源直接暴露，且 `vite build` 会清掉整个 dist。现落 `workbench/data/shots/`（`data/` 已在
   `workbench/.gitignore`，与 web 审计同一约定）。
7. **`extractHtml` 契约不变**：新增 `extractReadable` 返回 `quality`，`extractHtml` 只取原四个字段，
   旧实现保留为 `extractHtmlLegacy` 供对照——避免「增强抽取」顺手改坏既有 24 例契约。

## 3. 反向断言（证明「没做」的事）

- 抽取结果**不含原始 HTML**：断言 `JSON.stringify(result)` 中不出现 `<script`/`<nav`/`<footer`/`</p>`/`<article`。
- 缓存命中**不再请求上游**：mock 站点计数在第二次抓取后不增长；304 路径**不传 body**（`bodyTransfers` 不变）。
- 截图**默认不可用**：未设 `DSH_WEB_SHOT_ENABLE` 时 `shotStatus().enabled === false`，且 `webScreenshot` 抛
  `shot_disabled` 并带 `paramLevel`（未发起进程，故不落审计）。
- 截图**不绕过 SSRF**：`file:///etc/passwd` → `protocol_blocked`（截图与抓取共用同一套协议/私网判据）。
- 截图读取**防目录穿越**：`name=../../../team-hub/team.db` 与非法名一律 404；不存在的 png 也 404。
- 限流**不是永久封锁**：并发占满 → 429，释放后同一空间再次抓取 200 成功。
- 未知 `/api/web/*` 路径在**新路由口径**下 404（`/api/web/nope`），不吞不猜。

## 4. 本轮修掉的真实缺陷

| # | 缺陷 | 发现方式 | 修法 |
| --- | --- | --- | --- |
| ① | 缓存键不含空间 → 跨空间串内容且绕过配额 | `web-p28` 新增用例（B 空间命中 A 空间缓存） | 键改为 `scope+url+maxBytes` |
| ② | `DSH_WEB_SHOT_BROWSER` 只是候选首项 → 验证「无浏览器」分支会拉起真 Edge | `web-p28` 截图用例（期望 `shot_unavailable` 却拿到可用） | 显式指定即互斥 |
| ③ | 短页面（正文 < 阈值）误回退整页，把导航/页脚带进正文 | 端到端脚本（`strategy=body-fallback`，正文含「导航」） | 显式语义容器（`article`/`main`）优先于整页回退 + `shortContent` 标记 |
| ④ | 截图默认目录在静态根 `dist/` 内 | 端到端输出的 `shot.dir` | 改为 `workbench/data/shots` |
| ⑤ | 后端未加载 P2-8 路由时，前端把「能力未就绪」误报成「本空间还没有记录」 | 对运行中的 :5173 实测（未知 `/api/web/*` 回落 SPA 壳 → HTTP 200 + text/html） | 区分请求失败与空历史，文案指明缺失接口 |
| ⑥ | 测试夹具对未知路径一律返回 200，**掩盖失败留痕语义**（非产品缺陷） | 端到端 404 用例失败 | 夹具改为 404，并补 `short-article`/`bad-json` |

## 5. 复现命令

```powershell
# 后端契约（21 例）：进程内 serve.mjs 真路由 + mock 站点（含 ETag/304、404）
node --test workbench/scripts/web-p28.test.mjs

# 前端纯判定层（21 例）
node --test --experimental-strip-types workbench/scripts/browser-ui.test.mjs

# team-hub 抓取历史（1 例 / 20+ 断言）：独立端口 + 临时 DB
node --test team-hub/web-history.test.mjs

# 既有抓取契约不回归（24 例）
node --test workbench/scripts/web.test.mjs

# 跨进程端到端（17 项检查）：真拉起 team-hub 临时实例 + 进程内 serve 路由
node docs/P2-8-evidence/e2e-history.mjs

# 类型与构建
cd workbench; npx tsc --noEmit; npx vite build

# 全量门禁（注意：test 阶段当前会因 notify-hub-smoke 永久等待，见 §7）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'; node scripts\ci\run-ci.mjs --only build --out .ci\p28-build
```

本切片实测输出（摘录）：

```
web-p28    : tests 21 / pass 21 / fail 0
browser-ui : tests 21 / pass 21 / fail 0
web-history: tests 1  / pass 1  / fail 0
web(回归)  : tests 24 / pass 24 / fail 0
e2e        : 端到端结果：17/17 通过
tsc        : 0 错误
vite build : dist/assets/index-IsXYBz15.js  474.87 kB  ✓ built in 7.18s
```

端到端关键断言（真实 HTTP + 真实 hub 进程）：

```
PASS  team-hub 已启动（独立端口，临时 DB）且 P2-8 历史路由可读 — :54877
PASS  抓取成功且带抽取质量元数据 — strategy=article chars=44
PASS  历史里出现刚抓的地址 — "http://127.0.0.1:54880/page"
PASS  历史保存标题与主机 — title=E2E 目标页 host=127.0.0.1:54880
PASS  历史统计正确（1 条、0 失败） — {"total":1,"failed":0,"bytes":225,"shown":1}
PASS  第二次抓取命中缓存（cached=true） — {"cached":true,"cacheAgeMs":842}
PASS  同地址仍只有 1 行且 hits 累加为 2 — rows=1 hits=2
PASS  空间隔离：另一空间历史为空
PASS  失败抓取留下错误码记录 — errorCode=http_404 status=404
PASS  失败计入 stats.failed — {"total":2,"failed":1,"bytes":225,"shown":2}
PASS  元信息含截图状态（默认关闭） — {"enabled":false,"available":true,"browser":"msedge.exe",...}
```

## 6. 生产环境验证（落地后实测，非推断）

| 检查 | 结果 |
| --- | --- |
| 合并与推送 | `445e4f2..4fe1c6f main -> main`；`git rev-list --left-right --count main...origin/main` = `0 0` |
| 构建 | `workbench/dist/assets/index-IsXYBz15.js`（474.87 kB / gzip 146.00 kB）、`index-CIRROR5w.css` |
| 部署 | 复制到生产静态根 `D:\project\DSH\legion\workbench\dist`；live `index.html` 引用由 `index-D_CEZG0I.js` 变为 `index-IsXYBz15.js` |
| :5173 首页 | 返回 HTML 引用的即 `index-IsXYBz15.js`（与构建产物一致） |
| :5173 bundle 内容 | 实际下载 bundle 命中新文案：`抓取历史不可用`、`缓存已确认未变`、`正文较短`、`会真实启动浏览器进程`、`抓取过于频繁`、`本空间还没有抓取记录` 全部 FOUND |
| :5173 后端 | **仍是旧代码**：`GET /api/web/meta` 与未知 `/api/web/*` 都回落 SPA 壳（HTTP 200 + `text/html`）→ P2-8 后端路由**需重启 workbench serve.mjs 后生效**（未擅自重启正在运行的实例） |

> 为什么这一步重要：正是这次实测暴露了缺陷 ⑤——前端在「后端未加载路由」时会把能力缺失显示成
> 「本空间还没有抓取记录」。若只跑单测（进程内直接 import `serve.mjs`，路由一定存在）永远发现不了。

## 7. 已知边界（诚实登记）

1. **缓存与配额都在进程内**：重启 `serve.mjs` 即清空；配额不是持久账目（当日字节按日期键内存累计，
   跨重启归零）。要持久化需引入 DB 表，本切片按要求不做。
2. **截图是尽力而为**：不自带浏览器；本机无 Edge/Chrome 时该能力不可用（界面明说）。
   无 JS 交互脚本、无「等待某个元素」策略，仅 `--virtual-time-budget=8000` 等待渲染；
   真实截图路径在自动化测试中未跑（测试用假浏览器脚本验证「服务端路径正确」，
   真机截图仅通过 `shotStatus()` 探测到 `msedge.exe` 可用，**未在 CI 中产出真实 PNG**）。
3. **正文抽取是启发式**：无 DOM 语义理解，靠样板词表 + 打分；对强 JS 渲染页面仍只能报
   `empty_content`（沿用 v1 的服务端抓取边界）。
4. **历史有容量上限**：默认 200 条/空间，超出按 `updatedAt` 最旧清理并回报 `trimmed`；
   不提供分页游标（只按 `limit` 截断）。
5. **限流默认值是经验值**：空间 30/min、并发 3、站点 30/min、每日 200MB，均可用
   `DSH_WEB_QUOTA_*` 环境变量调整；**未做**分布式限流（单进程语义）。
6. **`test` 阶段全量基线仍不可得**：main 上 `notify-hub-smoke` 会让 `node --test` 永久等待
   （根因：`workbench/src/api.ts` L2 `from './hubEventStream'` 缺 `.ts` 扩展名 → Node ESM 解析失败，
   且 `setup()` 先起 hub 子进程、后动态导入，失败路径不 kill 子进程使测试文件进程不退出）。
   本切片按套件逐个验证，**未对未运行的套件声称基线**。该问题属他人切片，按约定只做只读诊断。
7. **本轮未重启生产 :5173 后端**（遵守「不擅自重启正在运行的生产实例」），因此 P2-8 新路由在生产上
   尚未生效；界面会如实显示「后端未提供该接口」。

## 8. 环境陷阱（供后续参考）

- `team-hub` 的端口/DB 环境变量是 **`TEAM_HUB_PORT` / `TEAM_HUB_DB`**（不是 `PORT`/`TEAM_DB`）。
  端到端脚本初版写错变量名，hub 回落到默认端口 **3080** 与生产实例冲突（`EADDRINUSE` 失败，未造成影响）。
- 生产 `node workbench/scripts/serve.mjs` 只提供 `workbench/dist` 静态文件与 `/api/*`；
  **前端改动需 `vite build` + 把 dist 复制到生产静态根**，只改源码不会生效。
- 该后端对**未知 `/api/*` 路径回落 SPA 壳并返回 HTTP 200**，因此「接口是否存在」不能用状态码判断，
  必须检查 `content-type` 或响应体（本切片的前端降级逻辑即据此实现）。
