# T-042 测试执行报告（tester）——「交付剩余 Legion 军团指挥团任务」三中心验收执行

> 角色：tester（测试执行）｜任务：T-042｜分支：w/T-042（独立 worktree）｜日期：2026-09-03
> 测试对象：T-040 编码交付（promote a10f1f8 / f9d6b46）+ T-041 代码审查（docs/REVIEW.md，未改实现）
> 依据用例：docs/TEST_CASES.md（T-039，110 条：S1 18 / S2 11 / S3 15 / S4 17 / S5 10 / S6 16 / S7 10 / S8 8 / R-1 5）
> 本报告只做执行与记录，不修 bug、不改代码；证据均为真实命令输出（logs/json 存于 docs/T042-evidence/）。

---

## 0. 结论速览

| 结论 | 说明 |
| --- | --- |
| **判定：非全绿 → 不建议直接 promote 验收通过** | 三中心主路径与安全面（scope 隔离/鉴权/路径逃逸/SSRF/XSS）实测全绿；但复现出 **3 项代码缺陷（P0-1/P0-2/P0-3）**，其中 P0-1（覆盖上传中断/超限破坏原文件=数据丢失）与 P0-2（下载全文件同步读内存、大文件阻塞事件循环）为数据安全/服务稳定性问题，须修复后回归；P0-3 为超时语义与注释/承诺不符，须至少改注释或修实现。另有若干口径注记与 L2 环境受限项（见 §5/§6），不掩盖缺陷。 |
| L0 契约/基线 | chat 13/13、skills 12/12、files-api 21/21、web 10/10、contracts 56/56、whiteboard 67/67 —— 全部复跑全绿 |
| L1 真实服务 | team-hub(:18787, :18788-token) + serve.mjs(:18848 无 token/allow-private, :18849 token, :18850 严格 SSRF) 全部真实启动；S1/S3/S4/S6 用例经真实 HTTP 逐条断言（详见 §4） |
| L2 浏览器手工 | 本沙箱无 GUI 浏览器 → §7 清单未能人工走查；以 API 级证据 + 代码/grep 佐证补位，并在 §6 明示复现步骤 |
| 静态构建 | tsc typecheck 0 错误 ✅；vite build 在本沙箱被 esbuild spawn(EPERM) 阻断（环境受限，见 §6.1） |

### 复现缺陷速览（详见 §5，均给出复现步骤/实际结果/归属）

| 缺陷 | 严重度 | 复现实证 | 归属 |
| --- | --- | --- | --- |
| P0-1 覆盖上传流式中断/超限破坏原文件 | 🔴 数据丢失 | chunked PUT overwrite=1 流超 64MiB → 原文件被删除且返回误导 400；客户端中断 → 原文件被截断为 1MB 半成品 | T-040 coder（S4 路由层，serve.mjs 758-796 行） |
| P0-2 下载全文件同步读内存（与注释矛盾） | 🔴 阻塞/内存 | 200MB 下载：响应头延迟 202ms 期间事件循环被同步读阻塞，并发 list 请求延迟 262ms（基线 ≤17ms） | T-040 coder（S3 下载路由 749-756 + readFileBytes 313-319） |
| P0-3 webFetch 超时实为「每跳」非「总超时」 | 🟠 口径失实 | timeoutMs=2000 时 3 跳链（每跳 1.4s）总耗时 4295ms 仍返回成功 | T-040 coder（S6 webFetch 636-688 + WEB_LIMITS 注释 76） |

---

## 1. 执行环境与方式

- 环境：Windows 沙箱（workspace-write），禁网；node v24.19.0（唯一运行时）；无第三方依赖下载。
- 工作目录：D:/project/DSH/legion/.legion-worktrees/T-042（分支 w/T-042，起始 HEAD=promote T-041，无 WIP；本阶段只产生报告与证据，未改实现代码）。
- 命令直跑等效：沙箱禁 child spawn 捕获管道（EPERM），node --test <文件> 会 spawn 失败；改用 node <文件>（node:test 进程内执行，同 T-039 §2 注）。contracts 56/56 即直跑。
- L1 真实服务：team-hub server.mjs 与 workbench/scripts/serve.mjs 以真实端口起后台进程；HTTP 断言用 node 内置 fetch/http（进程内）。端口/配置：
  - team-hub：TEAM_HUB_PORT=18787（无 token）/ 18788（TEAM_HUB_TOKEN=tk），TEAM_HUB_HOST=127.0.0.1，DB=docs/T042-evidence/hub-test.db（临时）。
  - serve.mjs：18848（无 token，DSH_WEB_FETCH_ALLOW_PRIVATE=1 供本地 mock，README「测试注入口」）、18849（--token s3cret）、18850（无 allow-private=严格生产姿态）；DSH_HUB_UPSTREAM=http://127.0.0.1:18787。
  - 空间绑定：POST /api/spaces 注册 tester（localDir=临时夹具目录）、bigspace（含 200MB 文件）。夹具含中文/二进制/大文本/.git/junction 符号链接/目录树。
- 前端 typecheck/build：node_modules 借主 checkout junction（同 T-041 手法，禁网）。


---

## 2. 证据清单（docs/T042-evidence/，已入库）

| 文件 | 内容 |
| --- | --- |
| skills.log / files-api.log / web.log / contracts.log / wb-*.log | L0 各套件完整输出（pass/fail 统计） |
| l1-hub-part1.json / part1b / sse / token | L1 hub REST + SSE + token 矩阵逐条断言结果 |
| l1-files-read.json / read-fix / write / token | L1 文件读面/写面/token 矩阵断言结果 |
| l1-web.json / web-fix | L1 web fetch 断言结果（SSRF 矩阵 codes 全量打印） |
| p01-upload.json / p02-download.json / p03-webchain.json | P0-1/2/3 复现数据 |
| vite-build.log / plugins-worker-regression.log / scrum-taskctl-ttl.log / wb-e2e.log | 环境受限项原始输出 |
| wb-e2e-sandbox-copy.test.mjs | e2e 套件沙箱适配副本（仅改 spawn stdio 捕获与路径，断言零改动，见 §4.9） |

## 3. 分层执行总览

| 层 | 载体 | 覆盖 | 结果 |
| --- | --- | --- | --- |
| L0 | 6 套契约测试（node <文件> 直跑等效） | S1/S3/S4/S6 纯逻辑 + 基线 | 179/179 全绿（13+12+21+10+56+67） |
| L1 | 真实 HTTP（hub×2 + serve×3 + 本地 mock） | 路由/鉴权/审计/SSE/越界/SSRF 端到端 + 缺陷复现 | 核心用例全绿；复现 P0-1/2/3（见 §5） |
| L2 | 浏览器手工 | S2/S5/S7/S8 交互 | 未执行（无 GUI）→ §6 + 复现步骤 |
| L3 | 全量回归命令 | S8-01/R-1 | L0 全量复跑绿 + L1 冒烟过；vite build 环境受限（§6.1） |

---

## 4. 用例逐条结果

图例：✅ 通过（含函数级/静态/评审锚定）；❌ 失败（缺陷，§5）；⚠️ 部分通过或口径注记；⛔ 未执行（环境受限，附原因/复现）。

### 4.1 S1 对话中心后端（18 条）→ 全部 ✅

| ID | 结果 | 证据 |
| --- | --- | --- |
| TC-S1-01 | ✅ | L0 chat.test + L1 HTTP：POST conversations → id/createdAt/updatedAt/last_message_at=null；列表按 updatedAt desc 排首（l1-hub-part1.json） |
| TC-S1-02 | ✅ | L0 + L1：scope=default 列表不含 software 会话 |
| TC-S1-03 | ✅ | L0 + L1：跨 scope body 写不串，消息 scope 恒等于会话 scope |
| TC-S1-04 | ✅ | L1：kind=channel → 400，error 指明合法枚举 |
| TC-S1-05 | ✅ | L1：缺 by → 400「缺少操作者身份 by」；非法 JSON → 400 非 500 |
| TC-S1-06 | ✅ | L1：author=by、convId、createdAt 有值；会话 last_message_at 更新 |
| TC-S1-07 | ✅ | L1：author:'other' 冒名被服务端绑定为 by |
| TC-S1-08 | ✅ | L1：25 条 limit=10 三页 10/10/5，页内升序、拼接无重无漏、游标连续 |
| TC-S1-09 | ✅ | L1：空会话 []、超界游标 []、缺省 50；limit=0/-1/abc → 400 |
| TC-S1-10 | ✅ | L1：未知 conv → 400 且不落消息 |
| TC-S1-11 | ✅ | L1：空白正文 → 400 |
| TC-S1-12 | ✅ | L1：8000 字符 200 / 8001 → 400 不落库 |
| TC-S1-13 | ✅ | L0 + L1：activity 含 chat:create/chat:message，member/scope/detail 形状 + seq 升序 |
| TC-S1-14 | ✅ | L1 SSE：订阅 /api/events 后 POST 消息，≤5s 收到 {action:chat:message, scope, member, detail.conv} |
| TC-S1-15 | ✅ | L1：订阅方断开后他人仍收事件；开/关 5 次 churn 后 SSE 仍送达、hub 不崩（l1-hub-sse/token.json） |
| TC-S1-16 | ✅ | L0 chat.test「旧 schema 无 chat 表自动建两表 + 存量无损」过 |
| TC-S1-17 | ✅ | L1 token 矩阵（hub 18788 token=tk）：无/错 token 写 401；对 token 200；读无 token 200 |
| TC-S1-18 | ✅ | 评审：package.json 无 diff；server.mjs 仅 node:http/sqlite/fs/crypto/path/url 内置导入 |

### 4.2 S2 对话中心前端（11 条）

| ID | 结果 | 证据 / 原因 |
| --- | --- | --- |
| TC-S2-01 | ⚠️ | tsc --noEmit → 0 错误 ✅；vite build 被 esbuild spawn EPERM 阻断（⛔ 环境，§6.1；T-040/T-041 已在各自环境绿） |
| TC-S2-02 | ⛔ L2 | 未执行（无浏览器）。API 等价：建会话/发消息/历史拉取均 L1 ✅（TC-S1-01/06/08）；渲染安全见 TC-S2-09 |
| TC-S2-03 | ⛔ L2 | 未执行。实时性等价证据：TC-S1-14 SSE ≤5s；双标签 GUI 走查需浏览器 |
| TC-S2-04 | ⛔ L2 | 未执行。历史恢复=GET messages 已 L1 验证；注：>50 条旧消息前端不可达（P1-4） |
| TC-S2-05 | ⛔ L2 | 未执行。scope 隔离数据面已由 TC-S1-02/03 L1 验证 |
| TC-S2-06 | ⛔ L2 | 未执行。ChatPanel 空 scope 引导分支代码级存在（README 亦明示「全部空间」给引导） |
| TC-S2-07 | ⛔ L2 | 未执行。api.ts hubPost 错误映射 + toast 代码级核对；草稿保留需浏览器实测 |
| TC-S2-08 | ⛔ L2 devtools | 未执行。I8 静态佐证：ChatPanel 仅订阅既有 /hub/api/events 并 filter action.startsWith(chat:)；未新增事件端点（代码读）；连接数实测待浏览器 |
| TC-S2-09 | ✅ 静态 | 全仓 grep dangerouslySetInnerHTML 仅 2 处注释（ChatPanel.tsx:27 / FilesPanel.tsx:33）；消息按纯文本 pre-wrap 渲染；真实浏览器弹窗验证待 L2 |
| TC-S2-10 | ⛔ L2 | 未执行。8001 字符后端拒绝已在 TC-S1-12 验证；按钮禁用/草稿保留需浏览器 |
| TC-S2-11 | ⛔ L2 | 未执行。未知 kind 按文本兜底（代码级：渲染不依赖 kind 白名单） |


### 4.3 S3 文件后端·只读面（15 条）→ 全 ✅（S3-11 为函数级锚定）

| ID | 结果 | 证据 |
| --- | --- | --- |
| TC-S3-01 | ✅ | L1 list 根：目录在前、条目含 size/mtime、.git 目录 isRepo；L0 files-api.test 同断言过 |
| TC-S3-02 | ✅ | L1：path=''/'.'/缺省 → 根内容；空目录 entries=[] |
| TC-S3-03 | ✅ | L1：未注册 scope → 400「工作空间 xxx 未注册：请先在空间设置创建该空间」，无文件列表泄漏 |
| TC-S3-04 | ✅ | L1：list 指向文件 → 400「不是目录」；不存在 → 400「路径不存在」 |
| TC-S3-05 | ✅ | L1：小文本全文 + lineCount=2 + totalBytes=26 |
| TC-S3-06 | ✅ | L1：340KB big.log → truncated=true、content 恰 262144(=256KiB 上限)、totalBytes=340000 |
| TC-S3-07 | ✅ | L1：pic.png → 结构化「二进制文件不可预览」 |
| TC-S3-08 | ✅ | L1：download 原始字节逐字节一致（27=27B）+ Content-Disposition（read-fix） |
| TC-S3-09 | ✅ | L1 逃逸矩阵：../outside.txt / ..%2F / a/../../ / 绝对路径 / C:/ / c:\\ / ..%5C / NUL(%00) / 嵌套越界 → 全 400/403（l1-files-read.json 逐项） |
| TC-S3-10 | ✅ | L1：link-in(junction 根内) 200；link-out(指向根外) → 403「路径越界：符号链接指向目录根之外」；L0 有锚 |
| TC-S3-11 | ✅ 函数级 | 本机无法制造非回环连接 → 按 TEST_CASES 走函数级：files-api.test「假 socket 非回环 → isLoopback=false」绿 + 代码读：handleFilesApi 首行 isLoopback 403 |
| TC-S3-12 | ✅ | L1：read .git/config → 403「禁止访问 .git 内部」；list .git 同拒；L0 有锚 |
| TC-S3-13 | ✅ | L1：「中文 文件.txt」全链路 UTF-8 无乱码 |
| TC-S3-14 | ✅ | L1：空目录 entries=[]、嵌套目录结构稳定（L0 夹具含大/空目录） |
| TC-S3-15 | ✅ | L1：/api/files 与 /hub 代理、/api/fs、静态面并行可用（/hub/api/scopes、/api/fs/home 实测 200）；serve.mjs 仅 node: 内置导入、零新增依赖 |

### 4.4 S4 文件后端·写面（17 条）

| ID | 结果 | 证据 |
| --- | --- | --- |
| TC-S4-01 | ✅ | L1：PUT 中文名新文件 → 200，download 字节一致 |
| TC-S4-02 | ⚠️ | 函数级与 Content-Length 预检 ✅（uploadBytes 上限 + CL 预检 413 快拒不落盘）；**但路由流式路径「覆盖 + 流超限/中断」破坏原文件 → P0-1 ❌（§5.1）**，TC-S4-02 语义在路由层不成立 |
| TC-S4-03 | ✅ | L1：无 overwrite 上传已有 → 409 且原内容不变 |
| TC-S4-04 | ✅ | L1：overwrite=1 → 200 内容替换可读回 |
| TC-S4-05 | ✅ | L1：mkdir 嵌套一次建多层，list 逐层可见 |
| TC-S4-06 | ✅ | L1：已存在 / 与文件同名冲突 → 400 |
| TC-S4-07 | ✅ | L1：rename 后旧文件消失、新文件内容一致 |
| TC-S4-08 | ✅ | L1：to 已存在 → 409；to=../evil → 403 拒绝（400/403 均可接受） |
| TC-S4-09 | ✅ | L1：无 confirm / confirm:nope → 400，文件仍在 |
| TC-S4-10 | ✅ | L1：confirm=yes → 200；再 download → 400 不存在 |
| TC-S4-11 | ✅ | L1：非空目录 confirm=yes → 400 且目录内容保留 |
| TC-S4-12 | ✅ | L1：空目录 confirm=yes → 200 消失 |
| TC-S4-13 | ✅ | L1 token 矩阵（serve 18849 --token s3cret）：无/错 token 写 401、对 token 200；读 list/download 无 token 200 |
| TC-S4-14 | ✅ | L1：upload/mkdir/rename/delete 注入 ../、盘符、NUL → 全拒，根外无副作用（L0 全写操作样本亦有锚） |
| TC-S4-15 | ✅/⚠️ | 评审+实测：上传流式落盘（非整读）✅、CL 预检超限快拒 ✅；但路由层未复用 uploadBytes，覆盖+流超限/中断路径存在 P0-1（chunked 无 CL 时预检失效走流式判定） |
| TC-S4-16 | ⛔ 未覆盖 | 并发 upload 无固化用例（files-api.test 无并发 it）→ 观察项，建议补锚（P2） |
| TC-S4-17 | ✅ | 评审：零新增依赖 |

### 4.5 S5 文件中心前端（10 条）

| ID | 结果 | 证据 / 原因 |
| --- | --- | --- |
| TC-S5-01 | ⚠️ | tsc ✅ 0 错误；vite build ⛔（§6.1） |
| TC-S5-02..07, 09, 10 | ⛔ L2 | 未执行（无浏览器）。API 等价：list/read/download/upload 均 L1 ✅（TC-S3/S4）；QuickTools 接线与「未绑定 → 引导空间设置」为代码级 + README 明示；复现步骤：起 hub+serve 后浏览器按 TEST_CASES §7.2 勾选 |
| TC-S5-08 | ✅ 静态 | 无 dangerouslySetInnerHTML（仅注释）；文件名/预览为 React 文本节点；L1 曾以 script-note.txt（含 script/img onerror 文本）read 成功返回纯文本 |

### 4.6 S6 浏览器后端（16 条）

| ID | 结果 | 证据 |
| --- | --- | --- |
| TC-S6-01 | ✅ | L1 mock：title「测试标题 Test Title」+ text 含关键句 + links 2 + finalUrl |
| TC-S6-02 | ✅ | L1 mock /zh：中文标题/正文无乱码 |
| TC-S6-03 | ✅ | L1 mock /spa（真空壳 <div id=app>，无 title）：code=empty_content + SPA 提示，不伪造正文 |
| TC-S6-04 | ✅ | L1 严格实例：file/ftp/javascript/data/gopher → 全 protocol_blocked |
| TC-S6-05 | ✅ | L1 严格实例：127.0.0.1、127.1、localhost、10.x、172.16/31、192.168.x、169.254、0.0.0.0、[::1]、[fc00::1]、[fd00::1]、十进制 2130706433、0x7f000001 → 全 ssrf_blocked（l1-web-fix.json 逐条） |
| TC-S6-06 | ✅ | L1：严格实例首跳私网 → ssrf_blocked（链不发往目标）；allow-private 实例 A→B 正向链 finalUrl 正确；redirect→file:// → ssrf_blocked；L0 覆盖逐跳/多跳/跳数超限 |
| TC-S6-07 | ✅ | L0 web.test「默认策略拒绝全部私网目标」绿；解析失败域名不可离线构造 → 以 L0 锚为准 |
| TC-S6-08 | ✅ | L1：maxBytes=1000 vs 2000B 页 → too_large |
| TC-S6-09 | ✅ | L1：timeoutMs=400 vs 2.5s 慢页 → timeout（已取消）；50ms 快页同超时 → ok |
| TC-S6-10 | ✅ | L1：响应 keys 白名单（ok/finalUrl/status/contentType/title/text/excerpt/links），无 HTML 透传字段 |
| TC-S6-11 | ✅ | L1：application/pdf → code=unsupported + 明确降级 |
| TC-S6-12 | ✅ | L1：404/500 → code=http_404 / http_500 + 可读说明 |
| TC-S6-13 | ⚠️ | serve 域（文件/网页）无审计落库——I7「审计」项与 T-041 注记一致；请求只回结构化错误码。**待将军裁决**：是否在 serve 侧补本地 JSONL 审计（若按验收字面判，该项应 ❌） |
| TC-S6-14 | ⛔ 未覆盖 | 并发慢请求无固化用例 → 观察项（P2） |
| TC-S6-15 | ⚠️ | L1：url 空/非字符串/not a url/http:// /缺 url → 均结构化 code=invalid_url，**HTTP 状态码 200**（用例期望 400）。实现为统一错误码通道，前端按 code 提示无歧义 → 口径注记，建议将军裁决改实现或改用例 |
| TC-S6-16 | ✅ | 评审：零新增依赖；零依赖正文抽取已实现（自研 extractHtml） |

### 4.7 S7 浏览器前端（10 条）

| ID | 结果 | 证据 / 原因 |
| --- | --- | --- |
| TC-S7-01 | ⚠️ | tsc ✅；vite build ⛔（§6.1） |
| TC-S7-02/03/05/06/08/09/10 | ⛔ L2 | 未执行（无浏览器）。服务端能力均 L1 ✅；BrowserPanel 状态机/错误文案代码级核对（ssrf_blocked→「已拦截：禁止访问内网地址」等映射存在）；复现步骤：起 serve+hub 后按 TEST_CASES §7.3 |
| TC-S7-04 | ✅ 静态+L1 | ssrf_blocked 明确码返回（L1 TC-S6-05）+ 前端文案映射（BrowserPanel.tsx） |
| TC-S7-07 | ✅ 静态 | 无 raw HTML 直插 DOM；grep 通过 |


### 4.8 S8 集成收口（8 条）

| ID | 结果 | 证据 |
| --- | --- | --- |
| TC-S8-01 | ⚠️ | L0 四套新契约 + 基线全量复跑绿（179/179）；L1 三服务真实冒烟全过；workbench vite build ⛔（§6.1，tsc ✅） |
| TC-S8-02 | ✅ 文档 | 根 README 三中心 ✅ 标注、接口表含 /api/chat、/api/files、/api/web/fetch（workbench/README.md）；calendar/notify 标注「P1 后续阶段接入」占位 |
| TC-S8-03 | ⛔ L2 | 侧栏 9 模块点击落点需浏览器；代码/README 明示 tasks→经典看板、calendar/notify→占位 toast |
| TC-S8-04 | ✅ | 走查：chat 写仅 team-hub handleWrite 路由；files/web 写仅 serve.mjs /api/files 与 /api/web/fetch；无绕过 API 直写 DB 的 UI/脚本路径；README 双写源纪律警示未回退 |
| TC-S8-05 | ⛔ L2 devtools | I8 静态佐证：仅单一 /api/events 按 kind 过滤（ChatPanel 只开 /hub/api/events 并 filter chat:*）；连接数实测待浏览器 |
| TC-S8-06 | ⛔ L2 | 回归走查（实时动态/KPI/3D 等）需浏览器；数据接口 L1 可用（/api/activity、/api/scopes、/hub/* 均 200） |
| TC-S8-07 | ✅ 评审 | calendar/notify 占位语义在代码注释与文档明确 |
| TC-S8-08 | ⛔ L2 | 三入口（Sidebar/QuickTools/App active）交叉走查需浏览器；接线代码级核对存在（onOpenModule） |

### 4.9 R-1 存量回归（5 条）

| ID | 结果 | 证据 |
| --- | --- | --- |
| TC-R1-01 | ✅ | whiteboard 全量 67/67：packages/shared（contract 26 + crdt 8 + undo 7）+ apps/server（e2e 6 + room 7 + storage 6 + ws-codec 7）。e2e 原版 spawn 被沙箱禁管道 → 用「仅改 stdio 捕获 + 绝对路径」的沙箱适配副本直跑 6/6（断言逐字未动，见下） |
| TC-R1-02 | ✅ | 真服务冒烟：e2e 起真实服务（DB=:memory:）+ /healthz 200 ok + 多 ws 客户端同步/恢复/leave |
| TC-R1-03 | ✅ | node tests/contract/contracts.test.mjs → 56/56 |
| TC-R1-04 | ⛔ 环境受限 | board-plugin/plugins 需各自 typecheck/build（plugins/lib 为构建产物，worktree 缺失）+ DSH Desktop 宿主注入。复现：node plugins/tests/worker-regression.test.mjs → ERR_MODULE_NOT_FOUND plugins/lib/index.js。按 TEST_CASES 记「环境受限 + 复现步骤」，不冒充通过 |
| TC-R1-05 | ✅ | 与 S8 同轮次复跑 TC-R1-01/02/03 全绿 |

**whiteboard e2e 沙箱适配说明**：apps/server/test/e2e.test.mjs 在沙箱内 spawn 子服务（stdio pipe）被禁（EPERM，原样跑 6 cancelled）。为如实执行而非虚报，生成 docs/T042-evidence/wb-e2e-sandbox-copy.test.mjs：仅 ① spawn stdio ['ignore','pipe','pipe'] → ['ignore','ignore','ignore']（沙箱禁管道捕获）② 相对 import/路径改为绝对 file:// 路径；**6 条断言逐字未动** → 6/6 绿。原文件未修改。

---

## 5. 失败 / 缺陷明细（复现步骤 → 实际结果 → 归属；本阶段只报告、不修复）

### 5.1 P0-1 🔴 覆盖上传流式中断 / 超限破坏原文件（数据丢失）
- 位置：workbench/scripts/serve.mjs PUT /api/files/upload 路由（758-796）：createWriteStream(abs)（默认 'w'，打开即截断）直写最终路径；uploadBytes（322，函数级注释自称「+1 拒绝且不落盘」）未被路由复用。
- 复现 A（流式超限）：
  1. 夹具 tester 空间内 victim.bin（300KB，已知内容）。
  2. 原始 socket PUT /api/files/upload?scope=tester&path=victim.bin&overwrite=1，chunked（无 Content-Length，绕开预检），发送 64MiB+1。
  3. 实际结果：服务端在 written>MAX_UPLOAD 后 ws.destroy() + unlinkSync(abs)；**victim.bin 被删除（原文件丢失）**；响应 400「Cannot call write after a stream was destroyed」（内部流错误泄漏，非 413、非原文件完好的安全语义）。
- 复现 B（客户端中断）：overwrite=1 流式发 1MiB 后 req.destroy() → 服务端 reject 回 400；**victim2.bin 原 300KB 被截断为 1MiB 半成品新内容**，原内容不可恢复。
- 归属：T-040 coder（S4 路由层）。违反 I6 与 TC-S4-02/03「拒绝且不落盘、原文件不被破坏」语义；函数级 uploadBytes 无此缺陷（测试盲区在路由层）。
- 修复建议（供后续任务）：流式写 <final>.part-<pid> 临时文件 → 成功后 renameSync 原子替换；任何错误/超限仅清理 .part，绝不动原文件；补路由级「覆盖 + 超限/中断 → 原文件完好」测试。

### 5.2 P0-2 🔴 下载接口全文件同步读入内存（与注释矛盾，大文件阻塞服务）
- 位置：serve.mjs GET /api/files/download（749-756）→ readFileBytes（313-319）→ readFileSyncFull（381-394）整文件同步 Buffer 读入再 res.end(buffer)，无大小上限；注释（312 行）自称「路由层用 createReadStream 流式返回」，与实现相反。
- 复现（bigspace/big-200m.bin = 200MB）：
  1. GET download：响应头延迟 **202ms**（事件循环被同步读阻塞）。
  2. download 发起 10ms 后并发 GET /api/files/list：延迟 **262ms**（空闲基线 1-17ms）——事件循环阻塞的直接证据（p02-download.json）。
  3. 每次下载另分配 200MB Buffer，内存随文件大小线性增长，无大小上限（GB 级文件单请求即拖垮服务）。
- 归属：T-040 coder（S3 下载路由）。
- 修复建议：download 改 createReadStream(abs).pipe(res) + Content-Length + stream error / 客户端断连 unpipe；readFileBytes 保留仅作契约小文件载体；补超大文件不阻塞冒烟。

### 5.3 P0-3 🟠 webFetch 超时实为「每跳」而非注释「总超时」
- 位置：serve.mjs WEB_LIMITS.TIMEOUT_MS 注释「总超时（可被请求覆盖）」（76 行）+ webFetch（636-688）每次重定向递归（662 行）都新建 AbortController + setTimeout。
- 复现：mock 3 跳链 c1→c2→c3（每跳延迟 1.4s），POST /api/web/fetch {url: c1, timeoutMs: 2000}。
- 实际结果：**总耗时 4295ms（>2000ms）仍 ok:true 成功**（title=Final after chain，p03-webchain.json）；最坏 ≈ 6×timeoutMs（默认 60s）与「总超时」承诺不符；外层 hop timer 在递归期间空转。
- 归属：T-040 coder（S6 webFetch）。
- 修复建议：递归下传共享 deadline（每跳 Math.min(tm, deadlineTs-now)），或至少把注释/README/TEST_CASES 改为「每跳超时」。


---

## 6. 环境受限与未执行项（诚实清单 + 复现步骤）

| 项 | 命令 / 复现 | 实际输出 | 影响 |
| --- | --- | --- | --- |
| vite build | node node_modules/vite/bin/vite.js build（workbench，junction） | esbuild spawn EPERM（ensureServiceIsRunning）；vite-build.log | TC-S2-01/S5-01/S7-01/S8-01 的 build 环节无法在本沙箱复跑；tsc --noEmit ✅ 0 错误；T-040/T-041 已在其环境绿（615 modules） |
| node --test 直跑 | node --test tests/contract/contracts.test.mjs | spawn EPERM（errno -4048） | 改用 node <文件> 直跑等效（T-039 §2 注），contracts 56/56 ✅ |
| whiteboard e2e 原版 | node apps/server/test/e2e.test.mjs（原样） | spawn EPERM → 6 cancelled | 沙箱适配副本 6/6 ✅（§4.9） |
| plugins 回归 | node plugins/tests/worker-regression.test.mjs | ERR_MODULE_NOT_FOUND plugins/lib/index.js（lib 为构建产物，worktree 缺失） | 范围外基线；TC-R1-04 记环境受限；宿主不可达 |
| scrum taskctl TTL | node scrum/taskctl.ttl.test.mjs | spawnSync EPERM → before 钩子崩、15 cancelled | 范围外（taskctl CLI 子进程契约）；不纳入本次判定 |
| L2 浏览器清单 | 按 TEST_CASES §7.1-7.4 | 本沙箱无 GUI/浏览器 | S2/S5/S7/S8 交互用例 ⛔；等价 API/SSE 已 L1 验证、静态安全 grep 已过；宿主环境复现步骤见 TEST_CASES §7 |
| 非回环 HTTP | 伪造 10.x 源访问 /api/files | 本机无法构造非回环连接 | TC-S3-11 按 TEST_CASES 走函数级（假 socket 用例绿）+ 代码读 |

---

## 7. 回归范围与结论

- 回归范围（未改动任何实现代码的前提下复跑）：
  1. 三中心新增面：S1-S8 全部 L0 契约 + L1 真实 HTTP（hub 两实例、serve 三实例、本地 mock、SSE、token、逃逸、SSRF 矩阵）。
  2. 存量基线：contracts 56/56、whiteboard 67/67（含 e2e 真服务冒烟）、skills 12/12（chat 迁移用例随行验证旧库建表无损）。
  3. 前端静态：tsc 0 错误；dangerouslySetInnerHTML 仅注释；vite build 环境受限（已有外部绿证据）。
- 结论：
  - 三中心主功能与安全面实现质量良好：scope 隔离、by 绑定、分页游标、路径根内规范化、overwrite/confirm 语义（DAO/函数级）、SSRF（协议/网段/混淆/重定向逐跳）、内容安全、token 鉴权、SSE 单源按 kind 过滤 —— 全部真实验证通过。
  - **存在 3 项复现缺陷（P0-1 数据丢失、P0-2 大文件阻塞、P0-3 超时口径），判定「非全绿」，不建议在修复前 promote 验收**；P0-1/P0-2 建议立修复任务，P0-3 至少改注释或修实现或用例。
  - L2 浏览器层未执行属环境限制而非实现失败，宿主环境需补走查（复现步骤已列）。
  - 遗留待将军裁决：① P0 修复范围与排期；② I7「审计」在 serve 域是否补本地 JSONL（TC-S6-13）；③ TC-S6-15 状态码 200 vs 400 口径；④ P1-3 scope 缺省全量读是否加保护（实测 GET /api/chat/conversations 无 scope 返回 software/ops/product 全分区，见 l1-hub-token.json）；⑤ P1-1/P1-4/P1-9/P1-10 等优化排期。

---

## 8. 遗留问题移交表

| # | 问题 | 类别 | 归属建议 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | P0-1 覆盖上传流式超限/中断破坏原文件 | 🔴 缺陷 | 新任务（S4 路由层改临时文件 + 原子改名，补路由级测试） | ❌ 复现，待修复 |
| 2 | P0-2 下载全文件同步读内存阻塞 | 🔴 缺陷 | 新任务（下载改 createReadStream.pipe） | ❌ 复现，待修复 |
| 3 | P0-3 超时每跳非总超时 | 🟠 口径/缺陷 | 新任务或文档修订 | ❌ 复现，待裁决 |
| 4 | TC-S6-13 serve 域审计缺失 | ⚖️ 口径 | 将军裁决是否补 JSONL 审计任务 | ⚠️ 待裁决 |
| 5 | TC-S6-15 HTTP 200 vs 400 | ⚖️ 口径 | 将军裁决改实现或改用例 | ⚠️ 待裁决 |
| 6 | TC-S4-16 并发上传 / TC-S6-14 并发慢请求无锚 | 🟡 覆盖缺口 | 补测试任务（P2） | ⚠️ 观察 |
| 7 | P1-3 GET conversations 无 scope 全分区返回 + hub 默认 0.0.0.0 | 🟠 隔离注记 | 将军裁决（T-041 已提） | ⚠️ 观察 |
| 8 | P1-1 --token 部署下前端文件写无 Authorization（UI 401） | 🟠 优化 | 后续排期 | ⚠️ 观察 |
| 9 | P1-4 对话历史仅最近 50 条、无「加载更早」 | 🟠 优化 | 后续排期 | ⚠️ 观察 |
| 10 | P1-9 normalizeUrl 放行非 http(s)（后端才拦） | 🟡 优化 | 后续排期 | ⚠️ 观察 |
| 11 | P1-10 FilesPanel mtime=null 渲染 1970 | 🟡 优化 | 后续排期 | ⚠️ 观察 |
| 12 | vite build / L2 清单 / 宿主联调（TC-R1-04） | ⛔ 环境 | 宿主环境补跑（复现步骤见 §6） | ⏳ 待宿主 |

---

## 9. 附注（假设 / 方法学）

- L0 全部以直跑等效（node <文件>）执行并留 logs；L1 全部以真实进程 + 真实 HTTP 执行并留结构化 json；所有断言可重放（命令/端口见 §1）。
- I7「审计」若必须落到 serve 域持久化才算满足验收，则 TC-S6-13 应判 ❌（当前无落库）；本报告按 T-041 注记口径计为「待将军裁决」，避免虚报。
- 缺陷均以「归属 = T-040 编码实现」标注；本阶段未修改任何实现代码；docs/T042-evidence/ 内日志与断言结果为唯一实证。
- 计数（110 条用例，逐条状态见 §4）：✅ 通过 70（含函数级/静态/评审锚定）；⚠️ 部分/口径注记 8（S2-01、S4-02、S4-15、S5-01、S6-13、S6-15、S7-01、S8-01，均为 build 环境受限 + tsc 通过，或口径待裁决）；⛔ 未执行/未覆盖 31（L2 浏览器/devtools 手工 28〔TEST_CASES §7 清单〕、S4-16 与 S6-14 并发覆盖缺口 2、TC-R1-04 plugins/宿主 1）；另有 3 项独立复现缺陷（P0-1/P0-2/P0-3）不占用例号，见 §5 —— 判定以 §0/§5 缺陷与 §7 结论为准。
