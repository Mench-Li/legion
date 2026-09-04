# T-057 代码审查报告（review）——S6 serve.mjs /api/web/fetch：SSRF 防护 fetch 代理 + 零依赖正文抽取

> 审查对象（本任务 = S6 浏览器后端的独立代码审查；审查基线 = 本 worktree 分支 w/T-057 @ main HEAD 6e01ef1）：
> - 功能实现提交 **aea0743**（serve.mjs +264、web.test.mjs +176：S6 全量功能——SSRF 防护 fetch 代理 + 零依赖正文抽取 + 契约测试）；
> - 超时修复提交 **c564237**（T-050 切片：P0-3「webFetch 超时实为每跳非总超时」→ 整条重定向链共享 deadline；serve.mjs +11/−5、web.test.mjs +21、README/证据文档）。
> 两者均已 promote 合入主线，当前文件 = 叠加后最终态。审查对当前 S6 代码整面正读 + 独立复跑，不引用提交自述。
> 审查方式：真读代码与关键逻辑、独立跑契约测试、以「进程内真实 HTTP 路由 + 函数级边界探针」复验语义；只给反馈，不改实现。
> 结论分级：**必须修改**（验收 AC 未达成 / 实测行为缺陷）与**建议优化**（可排期）。严重度 🔴高 / 🟠中 / 🟡低。
> 本报告覆盖替换先前 T-054 报告内容；T-054 历史报告见 git 历史（3bf60c1）。

---

## 0. 验证证据（独立复跑，非引用提交自述）

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 环境 | node v24.19.0（沙箱 workspace-write，禁网） | 与提交自述一致 |
| web fetch 契约 | `node workbench/scripts/web.test.mjs` | tests 12 / suites 8 / pass 12 / fail 0（SSRF 矩阵、限长、超时、TC-S6-09b 整链 deadline 回归全绿） |
| 存量回归（同文件域） | `node workbench/scripts/files-api.test.mjs` | tests 34 / suites 14 / pass 34 / fail 0 |
| HTTP 路由层探针 | 探针 import serve.mjs（?query 强制新实例）→ `server.listen` 真实端口 → fetch POST | 见 §0.1：参数/协议/SSRF 错误一律 HTTP 200 + `{ok:false,code}` envelope；GET → 405 正常 |
| 边界语义探针 | 函数级 webFetch（env 注入口开启）+ 本地 mock | 见 §0.2：headers 已回但 body 半途停住 → 超时被分类为 `web_error/'abort'` 而非 `timeout`（M2，实测复现） |
| 审计留痕 | 全仓 grep audit/审计/console.log（serve.mjs 全域） | 仅 999 行启动日志；webFetch/handleWebApi 无任何逐次 fetch 留痕 → AC5 未达成（M1） |
| 改动范围核对 | `git show aea0743 / c564237 --stat`；git status | 均限 serve.mjs / web.test.mjs / 文档；未触 package.json → 零新增依赖成立 |
| typecheck / build | `pnpm exec tsc --noEmit` / vite build | 本沙箱 worktree 无 node_modules junction 无法复跑；审查对象全为 .mjs（不在 vite 构建图 src/* 内），TS 面零改动；coder 侧已录 tsc exit 0 / vite build 绿（615 modules，T-046 同录）——如实声明未复跑 |

### 0.1 HTTP 路由层探针（真实路由，非函数直测）
POST /api/web/fetch（`content-type: application/json`）：

| 请求体 | HTTP 状态 | 响应 | 备注 |
| --- | --- | --- | --- |
| `{"url":"not a url"}` | **200** | `{ok:false, error:"URL 无法解析", code:"invalid_url"}` | TEST_CASES TC-S6-15 写「全部 400」→ 口径打架（O4） |
| `{}`（缺 url） | **200** | `{ok:false, error:"缺少参数 url", code:"invalid_url"}` | 同上 |
| `{"url":"file:///etc/passwd"}` | **200** | `{ok:false, error:"协议白名单…", code:"protocol_blocked"}` | 协议白名单在外呼前生效 ✓ |
| `{"url":"http://127.0.0.1:9/x"}` | **200** | `{ok:false, error:"SSRF 防护…", code:"ssrf_blocked"}` | 默认（无注入口）直接阻断 ✓ |
| GET /api/web/fetch | 405 | method not allowed | 路由层 method 门禁 ✓ |

### 0.2 边界语义探针（函数级；env 注入口开启，目标为本地 mock）
- headers 已回、body 停住（chunked 与声明 Content-Length 两种形态），timeoutMs=500 → 均抛原生 `Error('abort')`（无 code），elapsed≈500ms → 路由层将输出 `code:'web_error'、error:'abort'`，不是文档承诺的 `timeout`（= M2 实测复现）。
- 大响应 maxBytes=1000 → `code:'too_large'` ✓；读体取消后服务端连接正常关闭 ✓。

---

## 1. 验收口径逐条核对（依据 = docs/TASK_BREAKDOWN.md S6 AC1–AC6 + S6 契约 + docs/TEST_CASES.md TC-S6-01..16 + REVIEW 不变量 R2/R3）

| # | 口径 | 结论 | 依据 |
| --- | --- | --- | --- |
| S6 AC1 | web.test.mjs 全绿：抽取（HTML/UTF-8 中文）+ 空正文/JS 渲染页边界提示 | ✅ 通过 | 独立复跑 12/12；TC-S6-01/02 中文正文/title/链接绝对化正确、无原始 HTML 透传；TC-S6-03 SPA 空壳 → `empty_content` 可理解提示、不伪造正文 |
| S6 AC2 | SSRF 硬性门禁：协议白名单（仅 http/https）；目标与**重定向链每一跳**命中私网段即 `ssrf_blocked`；file/ftp 等拒绝；DNS 解析后指向私网也拒绝 | ✅ 通过（含 1 项加固注记） | TC-S6-04/05/06 独立全绿：14 目标矩阵（127.0.0.1/127.1/localhost/10.x/172.16–31/192.168/169.254/0.0.0.0/[::1]/[fc00::1]/十进制 2130706433/0x7f000001/017700000001）全阻断且 mock 零命中；域名经 DNS 解析校验（localhost→127.0.0.1）；重定向链逐跳复检、302→file:// 阻断、6 跳超限 `too_many_redirects`。IPv6 混淆（::ffff: 内嵌 v4）与 IP 字面量混淆（octal/hex/短点分/单整型）归一化均覆盖。**残余**：lookup 与后续 fetch 各自独立解析 → DNS 重绑时间窗（O1） |
| S6 AC3 | 限长与超时：响应超 maxBytes（默认 2MB 可注入）→ too_large；总超时（默认 10s 可注入）→ timeout | ✅ 通过（含 2 项边界注记） | TC-S6-08/09/09b 独立全绿：maxBytes 两态、单跳 timeout、整条重定向链共享 deadline 回归（修复前 ~2× 后 ok:true → 修复后 1011ms `timeout`；充足预算不误伤合法链）。**残余**：headers 已回但 body 停住 → 错误被分类为 `web_error/'abort'` 而非 `timeout`（M2 实测）；DNS 解析阶段不计入总超时预算（O2） |
| S6 AC4 | 内容安全：返回体只含白名单结构化字段，不透传原始 HTML | ✅ 通过 | TC-S6-01 断言 JSON 无 html 字段、无 `<script>` 透传；代码侧响应对象仅含 title/text/excerpt/links/error 等结构化字段 |
| S6 AC5 | 审计留痕：**每次 fetch 记 console/日志（url、finalUrl、status、耗时、by 默认 general）** | ❌ **未达成（M1）** | 代码零实现：webFetch/handleWebApi 无任何日志/审计写入（serve.mjs 全域仅 999 行启动日志）；TC-S6-13 无断言对象；R2「…限长/超时 + 审计」与 TEST_CASES §1 I7 亦要求审计 |
| S6 AC6 | 零新增依赖 | ✅ 通过 | 两提交均未触 package.json；仅新增 node 内置 `node:dns/promises` import；web.test.mjs 仅 node 内置模块 |
| 契约形状 | POST {url,maxBytes?,timeoutMs?} → {ok,finalUrl,status,contentType,title,text?,excerpt?,links?,error?}；error 枚举含 ssrf_blocked/timeout/too_large/unsupported/http_<status> | ✅ 通过（扩展枚举语义清晰） | 响应字段与枚举全部实现；另扩展 invalid_url/protocol_blocked/dns_error/empty_content/web_error（参数/协议/解析/空壳/未知类）语义自洽；**注记**：契约枚举缺 dns_error（域名解析失败必现路径），建议补进契约文档（O4 附注） |
| 错误码 HTTP 语义 | TEST_CASES TC-S6-15：参数类错误「全部 400（参数校验），非 500」 | ⚠️ 文档与实现漂移（O4） | 实测参数/协议/SSRF 错误全部 HTTP 200 envelope；前端 api.ts:579-581 与 BrowserPanel.tsx:78-100 按 200+code 消费（兼容），但 TC-S6-15 若按 HTTP 层断言将失败 |
| 文档同步 | 行为改动同步 README/JSDoc | ✅ 通过 | c564237 同步 README/workbench-README「整链总超时」语义 + serve.mjs WEB_LIMITS.TIMEOUT_MS 注释与 webFetch JSDoc；S6 头注释与文件头契约行 16-17 描述准确 |
| 代码规范 | 命名/注释/常量/测试注入口 | ✅ 通过 | 常量 Object.freeze、错误枚举分类、JSDoc 完整、env 注入口沿用既有先例（DSH_WORKBENCH_MAX_UPLOAD）；**1 项风格注记**：`import { lookup }` 位于文件中部 serve.mjs:560（O7） |

**结论：S6 抓取代理功能正确、P0-3 整链总超时修复真实成立（代码 + 契约 + 探针三层一致），SSRF 防护面扎实（协议/枚举段/混淆/DNS/重定向逐跳/跳数上限均覆盖，AC2 硬性门禁全绿），无 P0 级缺陷；存在 2 项必须修改（M1 审计 AC5 未达成、M2 超时错误分类实测缺陷，均小改）与多项建议优化。**

---

## 2. 问题清单

### 2.1 必须修改（建议收口前处理；均改动量小，不阻塞主路径运行）

#### M1 🟠 S6 AC5「审计留痕」零实现（验收 AC 未达成 + R2 不变量缺口）
- **位置**：workbench/scripts/serve.mjs handleWebApi（809–821 行）与 webFetch（751–807 行）——全程无日志/审计写入；TASK_BREAKDOWN.md S6 AC5（217 行）、TEST_CASES.md TC-S6-13（197 行）与 I7（46 行）均要求「每次 fetch 留痕：url、finalUrl、status、耗时、by（默认 general）」。
- **问题**：aea0743（S6 实现）与 c564237（P0-3 修复）都未实现任何逐次 fetch 留痕；serve.mjs 全域 grep 仅启动日志。独立审查无法对 AC5 给出任何正向证据 → **验收口径 AC5 不成立**。此前 T-041/T-042 未在 S6 面落地审计（T-042 只报 P0-3），缺口随 promote 带到主线。
- **修改建议**（约 5 行）：handleWebApi 在 webFetch 成功/失败两路径统一输出一条 `console.info('[web/fetch] by=general url=… finalUrl=… status=… ok=… code=… ms=…')`（耗时用 Date.now 差值；ssrf_blocked 等被拒场景同样留痕——拒绝即事件）。若军团审计中枢（team-hub audit 事件流）应收 /api/web/fetch 事件，则在此处同步上报并把口径写进契约文档；至少 console 留痕必须落地并补 TC-S6-13 断言（可注入 logger 直测）。
- **说明**：若将军裁定审计由中枢层统一承担（不在本切片范围），请在看板评论拍板并登记豁免——当前代码与验收文档之间没有中间态，缺拍板即按未达成处理。

#### M2 🟠 headers 已回但 body 半途停住 → 超时被分类为 `web_error/'abort'` 而非 `timeout`（实测缺陷 + 内部错误文本外泄）
- **位置**：serve.mjs readBodyLimited（730–743 行）——`await reader.read()`（736 行）未捕获中断异常；readBodyLimited 在 fetch 的 try/catch（768–773 行）**之外**被调用 → AbortError 裸抛至 handleWebApi（816–819 行）→ `err.code` undefined → 输出 `code:'web_error'、error:'abort'`。
- **问题**：§0.2 实测：mock 首包（headers）即回、body 停住（chunked 与声明 Content-Length 两种形态均复现），timeoutMs=500 → 500ms 后抛原生 `Error('abort')`（无 code）。即**超时确实生效**（连接被取消、耗时守预算），但错误码/文案错乱：客户端与 S7 UI 收到 `web_error/'abort'`，不是契约承诺的 `timeout`，且内部 abort 原因字符串进入用户可见 error 字段。慢/大页面「首包已回、体慢慢吐」是常见场景；现有 /slow 用例只覆盖 headers 未回的 stall，故 12/12 全绿掩盖此分支。连带：BrowserPanel.tsx:100 的 errFlag 清单未含 web_error，UI 会把该错误当正文渲染。
- **修改建议**：readBodyLimited 给 `reader.read()` 包 try/catch：`signal?.aborted`（或错误为 AbortError/名含 'Abort'）→ `throw webErr('timeout','抓取超时（已取消请求）')`；否则原样抛。补一条 mock（headers 立即回 + body 延迟 > timeoutMs）→ 断言 `code==='timeout'` 且 error 文案不含 'abort' 的回归用例。

### 2.2 建议优化（可排期；按影响降序）

#### O1 🟡 DNS 重绑定时间窗（SSRF 加固残余）：lookup 校验与 fetch 建连各自独立解析
- **位置**：serve.mjs assertPublicTarget（640–667，`lookup` at 657）→ webFetch `fetch(target.href)`（769）→ undici 二次解析 hostname。
- **问题**：校验用 OS 解析结果判定公网后，实际 fetch 由 undici 再解析一次。两者同为 OS resolver（同缓存），正常一致；但攻击者可控域名（TTL=0 / 按查询轮换应答）可在「校验通过 → 建连」毫秒级窗口内把第二次解析指向 127.0.0.1 / 169.254.169.254（云元数据）等私网 → 绕过逐跳校验。SSRF 为硬性不变量（R2），本项属时间窗竞态而非枚举缺口；本地单用户 + 禁网环境威胁低，若 workbench 部署到带云元数据/内网环境则升高。
- **建议**：v2 方向 = 校验与建连共用同一次解析（lookup 得 IP 后以 IP 直连 + Host/SNI 保留：http 用 node:http 显式 IP；https 用 `https.request {host: ip, servername: hostname}` 或 undici Agent connect 钩子），彻底消除双解析窗口；至少在当前注释与 README 显式声明该残余与适用边界。

#### O2 🟡 DNS 解析阶段不计入 timeoutMs 预算（P0-3 修复的剩余边界）
- **位置**：serve.mjs webFetch——deadline/remainMs（755–758 行）在 DNS 前计算；AbortController+定时器（764–765 行）在 assertPublicTarget（763 行，内含 dns.lookup）**之后**创建；`dns.promises.lookup` 不支持 signal、不可中止。
- **问题**：域名解析悬挂/慢解析时长不计入「整条链总超时」承诺——P0-3 修复覆盖 fetch+读体与重定向各跳，链的 DNS 前段逃逸预算；极端下总耗时 = DNS 时长 + timeoutMs。
- **建议**：把定时器创建提前到 URL 校验后（DNS 前），或对 lookup 做剩余预算的 Promise.race 兜底；并把「DNS 阶段计入总超时」写入 JSDoc 与回归说明。

#### O3 🟡 重定向响应体未消费/未取消 → 同源多跳链连接不回收
- **位置**：serve.mjs webFetch 3xx 分支（775–782 行）——拿到 res 后直接 clearTimeout + 递归，未读/cancel res.body。
- **问题**：undici 未消费的响应体使连接保持 busy（不可复用），同源重定向链每跳占一条连接直至超时/GC；MAX_REDIRECTS=5 + 单用户低频场景影响小，但 /loop 类自循环（TC-S6-06）与同源链会持续占用。
- **建议**：递归前 `await res.body?.cancel().catch(() => {})`（或 drain 排空）释放连接供复用；不影响返回语义。

#### O4 🟡 HTTP 状态码语义文档漂移：一律 200 envelope vs TEST_CASES TC-S6-15「参数类 400」
- **位置**：TEST_CASES.md TC-S6-15（199 行）；实现 = handleWebApi（809–821 行）对所有 webFetch 错误统一 `sendJson(res, 200, {ok:false, code, error})`；前端 api.ts:579-581 / BrowserPanel.tsx:78-100 按 200-envelope 消费。
- **问题**：实测参数类（not a url / 缺 url）、协议类、SSRF 类错误全部 HTTP 200（§0.1）；TC-S6-15 明确「全部 400（参数校验），非 500」——按 HTTP 层执行必失败。函数级 web.test 只测 throw（绕过路由层），故全绿未暴露。前端与 200-envelope 兼容，但文档/契约/测试三层口径不一致；且契约文档 error 枚举（TASK_BREAKDOWN S6 契约 209 行）缺 dns_error。
- **建议**：定口径二选一并同步三方：① 维持 200-envelope（推荐——前端已兼容、code 语义完整），把 TC-S6-15 改为「HTTP 200 + code=invalid_url，非 500」并补 HTTP 层断言；② 参数/协议类映射 400、SSRF/timeout 等业务类保持 200，前端相应调整。另把 dns_error 补入契约枚举文档。

#### O5 🟡 /api/web/fetch 请求体读取无大小上限、断连悬挂（继承性，新端点首个依赖）
- **位置**：serve.mjs readBodyJson（521–530 行，S3/S4 既有）+ handleWebApi（812 行）调用。
- **问题**：readBodyJson 对请求体无 Content-Length 预检/流式限长（`raw += d` 无限拼接）→ 本地进程可 POST 大 JSON 打内存；且未监听 req 'aborted'/'close' → 客户端半途断开时 promise 永不 settle，handleWebApi 悬挂（文件上传分支有 abort/close 兜底——见 515 行 receiveUploadBody 模式——此处没有）。仅回环 + 可信本机，威胁低。
- **建议**：为 /api/web/fetch 请求体加上限（如 64KB，超限快速拒绝）与 aborted/close reject（复用 receiveUploadBody 的兜底模式）；或让 readBodyJson 支持可选 maxBytes。

#### O6 🟡 DSH_WEB_FETCH_ALLOW_PRIVATE 全局旁路开关（安全默认值维持风险）
- **位置**：serve.mjs privateFetchAllowed（565 行附近）；web.test.mjs 与文档已声明「仅测试用」。
- **问题**：env=1 即全局（非 per-request）关闭 SSRF 门禁且每请求实时读取——若生产/部署环境误带该变量（例如从测试环境复制 env），防护整体静默失效、无任何警告。
- **建议**：启动时检测到该变量打印一次醒目 `console.warn`；更严格形态 = 仅模块以测试 query 导入时生效，避免 env 残留误伤生产。

#### O7 🟡 文件中部 import（ESM 合法但风格/工具链风险）
- **位置**：serve.mjs:560 `import { lookup } from 'node:dns/promises'`（S6 功能块开头，位于 handleFsApi 之后）。
- **问题**：ESM import 声明允许出现在模块顶层任意位置且会提升，合法可运行；但与文件头部 import 组（19–24 行）惯例不符——读者/工具链易误判作用域或误删，import/first 类 lint 会告警。
- **建议**：移到文件顶部 import 组，功能块注释保留即可。

#### O8 🟡 无并发上限/排队；TC-S6-14（P2 健壮性）无断言覆盖（注记）
- **位置**：webFetch/handleWebApi——每个请求独立 fetch，无并发闸门。
- **问题**：并发 N 个慢请求即 N 条并发外呼连接（与 O3 未消费连接叠加时资源占用放大）；TEST_CASES TC-S6-14（10 并发慢请求不崩/不泄漏）无实现或测试。本地单用户模型下可接受。
- **建议**：登记 P2 后续；若加，建议简单信号量（如并发 ≤ 8，超限明确失败）并在 web.test 补 TC-S6-14。

#### O9 🟡 测试覆盖注记（不阻塞）
- **位置**：web.test.mjs（头注释自称「对齐 TC-S6-01..16」）。
- **问题**：实际断言覆盖 TC-S6-01..06、08/09/09b、11/12；**TC-S6-07（DNS 层校验——由 TC-S6-05 localhost 用例间接覆盖）、TC-S6-10（形状白名单——并入 TC-S6-01 断言）、TC-S6-13（审计——M1 无断言对象）、TC-S6-14（并发——O8）、TC-S6-15（HTTP 层 400——O4）、TC-S6-16（零依赖核对——评审项）** 无独立用例/断言对象；头注释题名偏大。
- **建议**：头注释改为「对齐 TC-S6-01..16（缺项见注记）」并注明归属（M1/O4/O8）；随 M2 补一条「stall-after-headers → timeout」用例（当前覆盖盲区）。

### 2.3 正面确认（对照 REVIEW 不变量与 T-041 遗留）
- P0-3 已闭环：整链共享 deadline 实现正确（755–781 行），TC-S6-09b ×2 + 本评审探针（1011ms timeout / 充足预算 ok）三层一致；clearTimeout 防外层空转、deadline 递归传参向后兼容（导出签名 deadline=0 缺省，HTTP 层不可注入）✓。
- R3（JS 渲染/登录页显式边界）：SPA 空壳 → `empty_content` + 可理解 error，不伪造正文 ✓（TC-S6-03）。
- TC-S6-10 内容安全：响应形状白名单实测无 HTML 透传 ✓；R2 混淆矩阵归一化逻辑经 TC-S6-05 全绿 ✓。
- 405 / 仅回环 / 路由 method 门禁 + isLoopback 复用既有语义 ✓（探测 GET → 405）。

---

## 3. 总体判定

- S6 /api/web/fetch（SSRF 防护 fetch 代理 + 零依赖正文抽取）**质量良好**：AC1/AC2/AC3/AC4/AC6 全部真实成立（独立复跑 12/12 + 34/34 + HTTP 层/边界探针一致）；P0-3 整链总超时修复方向与实现正确；SSRF 防护在协议/枚举段/混淆/DNS/重定向逐跳/跳数上限维度覆盖扎实（AC2 硬性门禁全绿）；零新增依赖、JSDoc/文档同步到位。
- **无 P0 级缺陷**。收口前建议处理 2 项必须修改，均小改且有现成路径：
  - **M1（AC5 审计零实现，~5 行 + 断言）**——验收口径缺口，需将军就「console 留痕 vs 中枢审计」拍板或由后续任务补齐；
  - **M2（stall-after-headers 超时错误分类，catch+归一化 ~5 行 + 1 条回归用例）**——实测行为缺陷，影响用户可见错误码契约。
- O1（DNS 重绑窗口，安全加固）建议随 SSRF 面排期；O2–O9 为可排期优化与文档/测试注记，不改变验收结论。

_审查人：reviewer（T-057）· 依据：S6 代码整面正读 + 本报告 §0 独立复跑 / HTTP 层与边界探针证据 · 未修改任何实现代码（唯一改动 = 本报告 docs/REVIEW.md）_
