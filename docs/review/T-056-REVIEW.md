# T-056 代码审查报告（review）——S4 文件写面（PUT upload + mkdir/rename/delete + token 鉴权 + confirm，含 P0-1 原子上传修复）

> 审查对象：本任务编码交付 = 提交 a050854（w/T-048 切片，S4 文件后端·写面，slice 名与 evidence.json 完全一致；经 70c5aa7 promote 合入）。此后 serve.mjs 仅有 c564237（T-050/S6 webFetch 区改动：@@ -81 / -745 / -771 三处，与本面不相交），files-api.test.mjs 无后续改动 → 审查基线 = 当前 HEAD（f442f1c）文件与 a050854 一致。
> 审查范围：diff 净增量 = 5 文件 +430/−31 —— serve.mjs（+142/−28）、files-api.test.mjs（+261/−3，34 用例）、README.md、workbench/README.md、docs/T048-evidence/evidence.json；并按切片职责对 S4 写面四写操作 + 鉴权 + confirm + P0-1 回归做整面正读 + 真服务复验。
> 审查方式：真读代码与关键逻辑；独立复跑契约测试（files-api 34/34、web 12/12）；起真实 serve.mjs 进程跑 DoD 冒烟（mkdir→upload→rename→read→download→delete confirm）；对可疑语义做最小复现探针（嵌套 .git 写、非法 % 路径崩溃）；只给反馈，不改实现。
> 结论分级：**必须修改**（安全承诺失实 / 服务可被一击崩溃 / 新增逻辑实为缺陷）与**建议优化**。严重度 🔴高 / 🟠中 / 🟡低。

---

## 0. 验证证据（独立复跑，非引用提交自述）

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 文件中心契约 | `node workbench/scripts/files-api.test.mjs`（node v24.19.0，本 worktree） | tests 34 / suites 14 / pass 34 / fail 0（基线函数级全保留 + 12 条 HTTP 路由层用例，含 token 矩阵、P0-1 回归、并发） |
| 存量回归 | `node workbench/scripts/web.test.mjs` | tests 12 / pass 12 / fail 0 |
| 真服务 DoD 冒烟 | spawn 真实 serve.mjs（127.0.0.1:5197，DSH_WORKBENCH_SPACES_JSON 注入 scope）→ node fetch 逐条 | mkdir l1 200 → upload 200（size/名正确）→ rename 200 → read 200（内容一致）→ download 200（字节原样）→ delete 无 confirm 400（提示 confirm=yes）→ delete confirm=yes 200 → 服务健康 |
| Probe A（嵌套 .git 写面） | fixture 根含 `nest/.git/config`（敏感串）+ 根级 .git；函数级 + HTTP | 见 §2.1-R1：4/4 写操作 ALLOWED、HTTP 200 篡改成功；根级 .git 三种写 BLOCKED（对照成立） |
| Probe B（非法 % 路径） | 模块 listen 127.0.0.1 后 GET /`%zz` | 见 §2.1-R2：未捕获 URIError，进程整体退出（rc=1，栈指 serve.mjs:944） |
| 范围核对 | `git show a050854 --stat`；`git log a050854..HEAD -- serve.mjs files-api.test.mjs` | 5 文件；仅 c564237 再动 serve.mjs 且局限 S6 区 → 审查对象与当前文件一致 |
| 零依赖 | diff 未触碰 package.json；新代码只用 node:fs/path/http 既有导入 | ✅ |

未复跑项（如实声明）：tsc --noEmit / vite build —— 本 diff 只改 .mjs/.test.mjs/README/JSON，不涉 TS/前端产物；契约测试 import 已覆盖全部新代码语法与运行面。不影响本次 JS 面结论。

---

## 1. 验收口径逐条核对（依据 = docs/TASK_BREAKDOWN.md S4 166–181 行 + TEST_CASES TC-S4-01..17 + T-041/T-042 对 P0-1 的判定）

| # | 口径 | 结论 | 依据 |
| --- | --- | --- | --- |
| S4 AC1 | 写契约测试全绿：upload（中文名/超上限/overwrite 两态）、mkdir、rename、delete（confirm 缺失 400、非空目录拒删、成功后不可见） | ✅ 通过 | files-api 34/34（函数级 + HTTP 路由层双覆盖）；DoD 冒烟逐条 200/400 与契约一致 |
| S4 AC2 | 鉴权矩阵（TC-S4-13 / I2）：无/错 token 写 401、对 token 200、无 token 读放行；未配置 token 行为同现状 | ✅ 通过（注记测试缺口 P2-A） | HTTP 路由层：无 token upload 401、错 token 401、Bearer tk 200、读（read/list）无 token 200、mkdir 无 token 401；requireWriteToken 单门覆盖四写端点（serve.mjs:856–857）——rename/delete 未单独断言，代码同门（见 P2-A） |
| S4 AC3 | 写路径防护（TC-S4-08②/14）：与 S3 同强度规范化，全拒且根外零副作用 | ⚠️ 部分通过（R1） | 词法 ../、NUL、盘符、绝对路径、%2E 编码、..\\、根外 symlink 矩阵在四写操作全 400/403 + 根外目录零副作用 ✅；**但嵌套仓库 .git 未拦截（R1）**——与 S3 读面同根缺口在写面同样成立且破坏性升级 |
| S4 AC4 | 大文件流式/限长（TC-S4-02/15）：Content-Length 预检 + 流式限长、不整读内存 | ✅ 通过 | 预检 413 快速拒绝零落盘；cap 实例（DSH_WORKBENCH_MAX_UPLOAD=16384 三值法注入口）流式超限 413、目标零残留；背压代码（req.pause/ws drain）在案 |
| P0-1 | 覆盖上传流式超限/中断**不再破坏原文件**（T-041 判据：旧实现超限 unlink(abs)=覆盖场景删原文件、中断留半写） | ✅ 修复成立 | receiveUploadBody（serve.mjs:465–519）：同目录临时文件 + ws close（fd 释放）后同步「竞态二次校验 + renameSync 原子发布」；abort/error/close 兜底删 tmp 并 reject。cap 实例回归绿：覆盖超限 413/中断断连后原文件字节原样、无 .upload-*.tmp 残留、服务健康；uploadBytes 函数级同款原子语义 |
| I6 | 覆盖需 overwrite=1；删除需 confirm 二次确认；非空目录拒删 | ✅ 通过 | TC-S4-03/04、09..12 函数级 + 路由层绿；DoD 冒烟 delete 无 confirm 400 / confirm=yes 200 |
| AC5/文档 | 零新增依赖；改行为同步更新文档 | ✅ 通过 | 5 文件 diff 无 package.json；serve.mjs 头注释（14 行）+ README.md + workbench/README.md 均补「预检 + 流式限长 + 临时文件原子发布——中断/超限不破坏原文件（P0-1）」 |

**结论：S4 写面四写操作 + 鉴权 + confirm 功能正确，P0-1 数据丢失修复真实成立（代码 + 契约 + 真进程冒烟三层证据一致），无 P0 级缺陷；安全面有一处写面承诺失实（R1 嵌套 .git，与 T-054 读面 R1 同根同函数）与一处认证前可触发的进程崩溃面（R2，继承性）。**

---

## 2. 问题清单

### 2.1 必须修改（建议随本切片收口前修复）

#### R1 🔴 assertNotGitInternal 只拦首段 → S4 写操作可对嵌套仓库 .git 上传/mkdir/rename/delete（安全承诺失实，破坏性高于读面）
- **位置**：`workbench/scripts/serve.mjs` assertNotGitInternal（209–212 行，仅 `parts[0] === '.git'`）；被写面四处首行调用：uploadBytes（351）/ createDir（380）/ renamePath（389）/ removePath（406），经路由 /api/files/upload|mkdir|rename|delete（856 行 isWrite 门后）可达；测试 files-api.test.mjs TC-S3-12（201–206 行）只覆盖根级 .git（`.git/config`、`.git/hooks/x`、`.git/config` 删除）。
- **问题**：JSDoc（208 行）「.git 内部（含 .git 下任意层级）一律拒绝访问（防凭证/元数据外泄）」与 TC-S3-12 声称写操作同强度受保护，实现只查第一段。绑定目录含嵌套 git 仓库（monorepo 子仓库 / vendor / 本仓的 .legion-worktrees 等）时：**实测（Probe A，fixture 含 `nest/.git/config` 敏感串）**——函数级 upload 覆盖 `nest/.git/config`、mkdir `nest/.git/modules/x`、delete `nest/.git/config`（confirm=yes）、rename 进 `nest/.git/packed-refs` 全部 **ALLOWED**；HTTP（带正确 token）PUT 到 `nest/.git/config` 返回 **200** 并把内容篡改为 'x'。对照：根级 .git 同三种写全部 BLOCKED（403 语义），证明缺口只在「非首段」。写面比 T-054 读面 R1 更严重：不止泄露，还能**篡改/植入/删除**嵌套仓库的 .git/config（凭证、core.hooksPath 等）与 refs/objects。
- **修改建议**：断言改为**任意段**命中即拒（`parts.some(p => p === '.git')`，不误伤 .gitignore/.github 等非精确段）；**同一处函数改动同时闭合 T-054 R1（读面）与本项（写面）**；补嵌套用例到 TC-S3-12/TC-S4-14（upload/mkdir/rename/delete × `sub/.git/config`、`a/b/.git/HEAD`、同名 `.gitignore` 不误伤）。改动 < 5 行。

#### R2 🟠 createServer 入口 decodeURIComponent(url.pathname) 无 try/catch → 单个非法 % 转义请求即崩溃整个 serve.mjs（认证前可达；继承性，非本切片新增）
- **位置**：`workbench/scripts/serve.mjs` 944 行（`const pathname = decodeURIComponent(url.pathname)`，位于请求监听器最前，早于 isLoopback / token / 任何路由判断）；引入自 d6c5488（本切片未触碰此行）。
- **问题**：**实测（Probe B，模块 listen 127.0.0.1）**：单次 `GET /%zz`（任意畸形 % 序列均可）→ `URIError: URI malformed` 未捕获 → 进程整体退出（rc=1，无任何请求到达路由/鉴权）。本切片新增的断连容错（sendJson/httpErr 吞 res 错误）覆盖不到该入口。影响：默认 127.0.0.1 绑定下本地进程可一击打崩文件中心 + SPA；若按 --token 部署场景把 host 放开（--host 0.0.0.0，写令牌正是为此存在），任意远程客户端**无令牌**一击 DoS，token 保护形同虚设。
- **修改建议**：944 行套 try/catch（解码失败按 400 响应或仅静态文件分支做容错解码），一行级修复；补一条「非法 % 路径请求不崩服务、后续请求正常」HTTP 回归用例。

### 2.2 建议优化（可排期，不改变验收结论）

#### P2-A 🟡 路由层用例小缺口：rename/delete 的 401 未断言；新路径上传中断未覆盖；嵌套 .git 无用例
- **位置**：files-api.test.mjs 429–450（token 矩阵只断言 upload + mkdir）、491–501（P0-1 中断回归只覆盖 overwrite 原文件目标）、201–206（TC-S3-12 无嵌套样本）。
- **建议**：rename/delete 无 token 补 401 断言（同门 isWrite，补上直接证据）；新路径上传中途 abort 补一条（路径与 overwrite 分支相同代码，但覆盖更全）；若采纳 R1 修复应一并补嵌套 .git 写用例。

#### P2-B 🟡 POST mkdir/rename/delete 的 readBodyJson 无大小上限（回环 DoS 内存面）
- **位置**：serve.mjs 521–530（readBodyJson 无界 `raw += d`），被 914/922/930 三个 POST 分支使用。
- **问题**：回环内进程可发任意大 JSON body 打爆内存（POST 面本身仅回环，威胁低于 S6 面，但一处 readBodyLimited（730 行）即可复用）。
- **建议**：POST 分支复用限长读体（如 ≤64KB，错误仍映射 400）。

#### P2-C 🟡 上传无显式超时：trickle/慢速 body 最长挂到 Node 默认 requestTimeout（300s）才断并清临时文件
- **位置**：serve.mjs receiveUploadBody（465–519）+ upload 路由（890–911）。
- **建议**：路由层或 receiveUploadBody 设显式 deadline（如 60s，超时走既有失败路径：删 tmp + reject + 400/408 文案），避免慢速上传长期占用连接与临时文件。

#### P2-D 🟡 receiveUploadBody 中 ws 'error' 无条件覆盖 wsFailed → 理论上有 413 降级 400 的窗口
- **位置**：serve.mjs 499 行（`ws.on('error', e => { wsFailed = new Error('写入失败：…') … })`）。
- **问题**：若超限已置 413 后、ws destroy 过程中仍有延迟写错误回调，会把 wsFailed 覆盖为「写入失败…」→ classifyFilesError 落 400 而非 413，与 abort()（501 行「仅在尚无失败原因时记为 abort」）的精确错误保留策略不一致。低概率、未实测触发。
- **建议**：error 分支同样加 `if (!wsFailed)` 守卫，保证 413/中断原因不被后到错误覆盖。

#### P2-E 🟡 语义/文案小项
- mkdir 目标为已存在**文件**时报「目录已存在」（createDir 383 行；状态 400 正确，文案误导，可区分「已存在目录/同名文件」）；delete 无 confirm 回 400 而 overwrite 缺省回 409，两套码各有契约依据，建议在 serve.mjs 注释中写清口径防后续混淆（同 T-054 P2-D 的 400/404 口径注记族）。

#### P2-F 🟡 进程被强杀（非优雅退出）会遗留 .upload-*.tmp（无启动清扫）
- **位置**：tmpSibling/tryUnlink（449–456）。
- **建议**：可接受（服务正常路径零残留，测试已证），如需加固可在启动时清扫目标目录下 .upload-*.tmp 前缀残留（可选）。

### 2.3 测试/证据注记（不阻塞）
- coder 把 TC-S4-15（登记为「评审 + L1」）提升为 HTTP 路由层自动化用例并内置 P0-1 回归（cap 实例 16KB + DSH_WORKBENCH_MAX_UPLOAD 三值法注入口），属正面超额；断言对断连态留了 `413 || 0` 容差，合理。
- L1 冒烟仍未固化为进仓脚本（evidence.json 只存结论）——同 T-054/T-041 注记，建议 tester 阶段固化（前例 team-hub/chat-l1-smoke.mjs）；本评审的 DoD 冒烟与探针为一次性脚本，过程与结果见 §0/§2.1。
- 继承性提醒（均仍开放，建议将军排期）：T-054 R1（读面嵌套 .git）与本次 R1 同根同函数，建议**合并为同一个 serve.mjs 修复切片**一次闭合；T-054 R2（download stream-error 死分支）仍在；P0-2/P0-3 已分别由 S3（d90c91d）/S6（c564237）切片修复并经各自复审，本次 files-api/web 全绿反证无回归。

---

## 3. 总体判定

- S4 写面交付**质量良好**：P0-1 修复方向与实现正确（同目录临时文件 + ws close 发布 + 同步竞态复检 + abort/error/close 兜底 + 背压 + 失败删 tmp），34 契约（函数级 + 真路由 listen）+ 真实进程 DoD 冒烟三层独立验证一致；鉴权/confirm/逃逸矩阵覆盖到位；零新增依赖、diff 边界干净、文档同步。
- **无 P0 级缺陷**；promote 判定：功能正确可推进，但建议收口前处理 **R1（写面嵌套 .git 缺口——与 T-054 R1 同一处函数，一次改动闭合读+写两面，<5 行 + 补用例）** 与 **R2（decodeURIComponent 崩溃面，一行 try/catch，认证前可达）**——两者都是小改、都带现成修复路径，不处理不会造成数据丢失，但会留下安全承诺缺口与「一击崩溃」可用性漏洞。
- P2 组可排期，不改变验收结论。

_审查人：reviewer（T-056）· 依据：代码真读 + 本报告 §0 独立复跑/冒烟/探针证据 · 未修改任何实现代码_
