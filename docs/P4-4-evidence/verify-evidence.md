<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **P4-4 切片当时**的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）｜[README.md](../../README.md)（总览）｜[docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P4-4 静态托管：未知**资源**不再被 SPA 回退伪装成 200 HTML —— 验证证据

> 任务来源：`docs/REMAINING-TASKS.md` 候选 **#8**（= `docs/STATUS.md` 已知限制 **#12**）。
> 原话：「`serve.mjs` 对未知资源路径仍回退 SPA 200 HTML：既是 SPA 需要，也让缺失的 `/assets/*.js`
> 返回 HTML 而非 404，浏览器侧表现为 MIME 报错（如需按扩展名区分导航与资源请求需单独立项）」。

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `workbench/scripts/serve.mjs`（改） | 新增纯函数 `staticRequestKind(req, pathname)`（导航 / 静态资源）；静态分支只在**导航**请求上回退 SPA 入口，资源请求缺失即 **404** |
| `workbench/scripts/static-serve.test.mjs`（改，6 → **16 例**） | 新增 3 条真实服务契约用例（缺失资源 404 / 两条边界仍在 / 目录请求仍回退）+ 7 条判定规则纯函数用例（含**负向锚定**） |
| `scripts/ci/run-ci.mjs` | `static-serve` 套件标签补上「导航/资源区分」 |

## 2. 关键决策

### 2.1 规则：不是「看扩展名就 404」，而是「两条判据取并集为导航」

判定写在 `staticRequestKind(req, pathname)`，**导航**成立的条件是任一条：

1. **路径形态**：最后一个路径段没有扩展名（`/tasks/abc`），或扩展名是 `.html`/`.htm`；
2. **请求头**：`Accept` 显式包含 `text/html`（浏览器发起**导航**时必带）。

其余（`.js`/`.css`/`.json`/`.png`/`.map`/`.ico`/`.woff2`… 且未声明要 HTML）→ **静态资源**，缺失即 404。

为什么加第 2 条：只按扩展名会把「带点的深链路由」（如 `/report.v2`）误伤成 404——真实用户在地址栏
访问它是**导航**，理应拿到 SPA 入口。加这条出口后两者都成立，而且**不会把缺陷重新藏回去**：
浏览器取子资源时不声明 `text/html`（模块脚本只带通配、样式表带自己的类型），
所以缺失的 `.js` 依然是 404（用例 ④ 专门钉住这一点）。

### 2.2 为判定规则单独写纯函数测试

端到端用例只能覆盖跑得到的那几条路径；而这条判定的边界（尾斜杠、大小写、畸形 `Accept`、
带点深链的两副面孔）用纯函数测更快也更全。因此 `staticRequestKind` 直接从 `serve.mjs` 导出，
配 7 条纯函数用例，其中一条是**负向锚定**：把「缺失的 `.js` 必须判为资源」写成断言，
防止哪天有人把 resource 分支删掉而其他用例仍绿。

### 2.3 为什么 404 配 JSON 体而不是 HTML 错误页

`httpErr` 统一回 `{ error }` + `application/json`。对静态资源而言这比 HTML 错误页更有用：
前端 `fetch()` 缺失的 JSON 资源时能直接读到 `{ error: '未找到静态资源 …' }`（见 §3.1 的 A/B），
而不是去解析一页 HTML。**已知边界**：浏览器加载缺失的**模块脚本**时，控制台仍会报 MIME 类错误
（因为 404 的响应体是 JSON 而不是 JS）——但状态码是诚实的 404，网络面板与日志都能一眼定位，
这正是本切片要修的「把不存在伪装成存在」。

## 3. 验证证据

### 3.1 A/B 现场读数：**真实浏览器 + 真实 serve.mjs 路由**

探针：临时静态根（`index.html` 里引用**不存在**的 `/assets/index-missing.js`）+ 真实 Edge/Chrome，
同一份探针在「修复前 / 修复后」各跑一次：

| 读数 | 修复前（`main` 的 `serve.mjs`） | 修复后 |
| --- | --- | --- |
| `GET /assets/index-missing.js` 状态码 | **200** | **404** |
| 该响应 `content-type` | `text/html; charset=utf-8` | `application/json; charset=utf-8` |
| 响应体开头 | `<!doctype html><html><head><meta charset="utf-8">…`（**整页 index.html**） | `{"error":"未找到静态资源 /assets/index-missing.js（按扩展名判定为资源请求：不做 SPA 回退…）"}` |
| 前端 `fetch('/data/missing.json')` | `status=200`，`JSON 解析失败: Unexpected token '<', "<!doctype "… is not valid JSON` | `status=404`，普通对象 `{ error: '未找到静态资源 /data/missing.json…' }` |

**这就是缺陷的用户可见形态**：前端（和排障的人）看到的是「JSON 格式不对」/「MIME 类型不对」，
而事实是「这个文件根本不存在」。修复后 404 把事实直说。

### 3.2 真实场景（不是构造出来的）

`workbench` 前端由 vite 构建，产物是**内容哈希**命名：`dist/assets/index-CROno3F9.js`、
`index-BhR8Dbyk.css`（本机 `dist/` 实测）。于是**上线新版本后**，仍然持有旧 `index.html` 缓存的浏览器
会去请求**上一版的哈希文件名**：旧行为回 200 HTML（浏览器拒绝当模块执行 → 白屏 + 误导性错误），
新行为回 404（原因明确，标准处置「刷新/清缓存」也一目了然）。这条路径以前被
「SPA 回退」一并吞掉，正是候选 #8 记录的现象。

### 3.3 用例读数

| 运行 | 结果 |
| --- | --- |
| `node --test workbench/scripts/static-serve.test.mjs` | **16/16 PASS**（原 6 例） |
| **负向对照**：同一套用例打在**未修**的 `serve.mjs` 上 | **9 FAIL / 7 PASS**——其中两条真实服务用例失败信息即症状（`/assets/index-missing.js 应为 404（旧行为是 200 + text/html）`） |

### 3.4 覆盖的边界（都在用例里）

| 请求 | 判定 | 结果 |
| --- | --- | --- |
| `/assets/index-missing.js`、`/assets/app-missing.css`、`/data/missing.json`、`/favicon.ico`、`/assets/deep/nested/missing.map` | 资源 | **404**，且响应体不是 HTML |
| `/some/spa/route`、`/tasks/abc/def`、`/`、`/assets/`（目录） | 导航 | 200 + `index.html`（既有行为不回归） |
| `/assets/index-abc.js`（**存在**） | 资源 | 200 + `javascript`（MIME 不变） |
| `/report.v2` + `Accept: text/html` | 导航 | 200 + SPA 入口（带点深链在浏览器里不被误伤） |
| `/report.v2` + `Accept: */*` | 资源 | **404**（同一路径的另一副面孔：子资源不放过） |
| `/index.html`（`Accept` 大小写/缺失） | 导航 | 200（`.html/.htm` 大小写不敏感） |
| 畸形入参（`null` 请求对象、非字符串 `Accept`、`undefined` 路径） | — | 不抛错（判定是兜底之外的第二道保险） |
| 路径穿越（编码式 / 明文式 / 双重编码） | — | 既有防护不变（403 / 归一化，均不泄露根外文件） |

## 4. 未覆盖 / 已知边界（诚实登记）

1. **浏览器加载缺失模块脚本时控制台仍报 MIME 类错误**：404 的响应体是 JSON，不是 JS。
   状态码诚实，但控制台文案不会变成「404」字样——真正的可诊断性来自网络面板与状态码。
2. **未改动 API 路由的 404 语义**：`/api/*` 的未知路径本来就走各自分支，本次只动静态分支。
3. **未覆盖 `HEAD`/`Range`/条件请求**：静态分支仍不分方法（与改动前一致），继续沿用既有实现。
4. **扩展名清单是「白名单式导航」而非穷举资源类型**：任何**未见过**的新扩展名默认按资源处理
   （缺失即 404）——这是有意的保守取向（宁可 404 也不伪装成 HTML）；若将来出现「带新扩展名的深链路由」，
   真实浏览器导航仍会被 `Accept: text/html` 那条判据救回，但**非浏览器客户端**（不带该头）会拿到 404。
5. **未做真实生产 dist 的整站冒烟**：验证用的是临时静态根 + 本机 `dist/assets` 的命名事实，
   未对真实 `dist/` 起服做全站资源清点。
6. **`web-p28`/`smoke` 等既有路径未受影响**（已复跑，见 §3.3 的全量门禁），但**没有**专门的
   「编译产物与 index.html 引用一致性」检查——缺失哪个资源仍要等浏览器报错，只是现在报得准。

## 5. 复跑命令

```bash
# 静态托管契约（含判定规则纯函数用例）
node --test workbench/scripts/static-serve.test.mjs

# 全量门禁（env + test + doc）
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci/p4-4
```
