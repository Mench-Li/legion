# T-054 代码审查报告（review）——S3 serve.mjs 扩 /api/files list/read/download（仅回环 + 路径防护）

> 审查对象：本任务编码交付 = 提交 d90c91d（w/T-046 切片，经 267a145 promote 合入本线 2bd55a1；此后无提交再触碰 serve.mjs / files-api.test.mjs，审查基线 = 当前 HEAD 文件）。
> 审查范围：diff 净增量 = 3 文件 +99/−4 —— workbench/scripts/serve.mjs（+30/−4）、workbench/scripts/files-api.test.mjs（+20）、docs/T046-evidence/evidence.json（+53）；并按切片职责对 S3 只读面三端点（list/read/download）做整面正读 + 真服务复验。
> 审查方式：真读代码与关键逻辑、独立跑契约测试、起真实 serve.mjs 做 HTTP 断言、对可疑的 Node 流式/错误处理语义做最小复现探针；只给反馈，不改实现。
> 结论分级：**必须修改**（安全承诺失实 / 新增逻辑实为缺陷，建议收口前修复）与**建议优化**（不影响主路径，可排期）。严重度 🔴高 / 🟠中 / 🟡低。

---

## 0. 验证证据（独立复跑，非引用提交自述）

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 文件中心契约 | `node workbench/scripts/files-api.test.mjs`（node v24.19.0） | tests 22 / suites 9 / pass 22 / fail 0（含新增 TC-S3-08b） |
| 存量回归 | `node workbench/scripts/web.test.mjs` | tests 10 / pass 10 / fail 0（serve.mjs 相关回归） |
| 真服务 HTTP 冒烟 | spawn 真实 serve.mjs（127.0.0.1:5187）+ DSH_WORKBENCH_SPACES_JSON 注入 fixture scope | 见下逐条 |
| 范围核对 | `git show d90c91d --stat`；`git log d90c91d..HEAD -- serve.mjs files-api.test.mjs` | diff 仅 3 文件；其后无改动 → 审查对象与当前文件一致 |
| 路由不再整读 | 全仓 grep readFileBytes 调用点 | 仅 files-api.test.mjs 测试用 + serve.mjs 定义/注释；**路由已无引用** → P0-2 闭环 |

真服务 HTTP 断言（fixture：scope=fx → 临时 repo 根，含 .git/config、link-out junction、16MB big.bin、中文名文件）：

| 请求 | 结果 |
| --- | --- |
| GET /api/files/list?scope=fx&path= | 200，entries 形状正确（目录在前/隐藏项过滤/isRepo 标记） |
| GET /api/files/read?scope=fx&path=ok.txt | 200 ok:true 内容原样 |
| GET /api/files/download?scope=fx&path=ok.txt | 200，正文 18B 与磁盘逐字节一致（中文名） |
| download 目录 / 不存在文件 | 400（"路径不是文件"/"路径不存在"） |
| download .git/config（根级）/ ../ / a/../../ / %2e%2e%2f 编码 / ..\\ / link-out symlink | 403（越界/.git/符号链接文案），与 list/read 同强度 |
| download %252e%252e…（双编码） | 400 路径不存在（仅单次解码 → 字面量未落根外，无二次解码逃逸） |
| download 缺 scope | 400 "缺少参数 scope" |
| download big.bin 16MB | 200，content-length=16777216 精确、字节一致、TTFB 72ms（头部先于整读返回 → 流式成立） |
| 下载中途客户端 abort（256KB 后断连） | 服务器存活；400ms 后再次下载 → 200（res close→stream.destroy 生效，无崩溃/无泄漏症状） |

Node 语义探针（最小复现，判断下载流错误处理分支的真实行为，见 §2.1-R2）：
- v24.19.0：`res.writeHead(200)` 后 `res.headersSent` **立即为 true**；对同一 res 二次 writeHead 抛 `ERR_HTTP_HEADERS_SENT`。
- 流在 writeHead 之后、首字节之前 error（如 ENOENT 竞态）→ 代码走 `res.destroy(e)` 分支，客户端收 ECONNRESET；**服务进程无崩溃**（0 uncaught）。
- 客户端中途断连（大文件流式传输中 destroy socket）→ res 'close' → 源 stream destroy → 进程存活、连接数不涨、后续请求正常。
- Content-Length 与实际流出不一致：文件传输中被并发追加（流出 > 声明长度）→ 客户端报 `HPE_INVALID_CONSTANT`/ERR_CONTENT_LENGTH_MISMATCH，服务端不崩（详见 §2.2-P2-B）。

未复跑项（如实声明）：tsc --noEmit / vite build —— 本 diff 仅改 .mjs/.test.mjs/证据 JSON，不涉 TS/前端产物；且证据文件与上一评审记录均已在宿主侧跑通（615 modules）。不影响本次 JS 面结论。

---

## 1. 验收口径逐条核对（依据 = docs/TASK_BREAKDOWN.md S3 AC1–AC5 + TEST_CASES TC-S3-08..12 + T-042 判定 P0-2）

| # | 口径 | 结论 | 依据 |
| --- | --- | --- | --- |
| S3 AC1 | list/read/download 契约测试全绿（list 形状、read 截断+行数、download 字节一致） | ✅ 通过 | files-api 22/22（§0）；真 HTTP read/list/download 200 与形状/字节断言成立 |
| S3 AC2 | 越界防护用例全绿：../、绝对路径、NUL、符号链接指根外 → 400/403，normalize 后仍在根内 | ✅ 通过（含 R1 注记） | 契约矩阵 + 真 HTTP：../、a/../../、%2e%2e 编码、..\\、盘符、link-out 全部 403/400；**注记 R1**：仅首段判 .git，嵌套仓库 .git 未拦截（见 §2.1） |
| S3 AC3 | 仅回环：非回环请求 403（复用 isLoopback） | ✅ 通过 | isLoopback 函数级两态用例绿（TC-S3-11）；handleFilesApi 首行 403（serve.mjs:739）；本机直连恒回环，按 TEST_CASES 约定以函数级+评审证据为准 |
| S3 AC4 | 二进制与超大文件 read：扩展名/内容拒绝预览或截断，响应体受控 | ✅ 通过 | TC-S3-06/07 绿（MAX_READ 截断、BINARY_EXT+NUL 检测） |
| S3 AC5 | 零新增依赖（node:fs/path/http） | ✅ 通过 | diff 未改 package.json；新增 createReadStream 为 node:fs 既有导入 |
| P0-2 | 下载不再整文件同步读内存；Content-Length 精确；客户端断连清理 | ✅ 通过（代码级+实测） | 路由仅剩 openDownloadStream→pipe（serve.mjs:761-778），readFileBytes 路由零引用；16MB TTFB 72ms、256MB 证据 21ms；abort 后服务存活（§0）。**注记 R2**：错误处理分支语义失效（§2.1） |
| 仅回环 + .git 保护（I2/TC-S3-12，防凭证外泄） | ⚠️ 部分通过（R1） | 根级 .git/config 403；**嵌套 .git 可达**：`vendor/sub-repo/.git/config` read 与 download 均 200（实测泄露内容）——与 assertNotGitInternal JSDoc「含 .git 下任意层级一律拒绝」不符 |
| 文档同步（改行为同步更新文档） | ⚠️ 部分通过 | readFileBytes/openDownloadStream JSDoc 已改为真实语义 ✅；**TC-S3-08b 未登记 docs/TEST_CASES.md**（见 §2.2-P2-A） |

**结论：本切片三端点功能正确、P0-2 修复真实成立（代码 + 契约 + 真 HTTP 三层证据一致），无 P0 级缺陷；安全面有一处承诺失实（R1 嵌套 .git）与一处新增错误处理死代码（R2）。**

---

## 2. 问题清单

### 2.1 必须修改（建议随本切片收口前修复；均不阻塞服务运行，但属安全承诺失实 / 新增逻辑缺陷）

#### R1 🟠 assertNotGitInternal 只拦首段 → 嵌套仓库 .git 可 read/download（安全承诺失实）
- **位置**：`workbench/scripts/serve.mjs` assertNotGitInternal（196–199 行，仅 `parts[0] === '.git'`）；被本切片三端点（listDirEntries 262 / previewTextFile 288 / readFileBytes 314 / openDownloadStream 326）首行调用；测试 files-api.test.mjs TC-S3-12（175–180 行）只覆盖根级 .git。
- **问题**：JSDoc（196 行）与 TC-S3-12 声称「.git 内部（含 .git 下任意层级）一律拒绝访问（防凭证/元数据外泄）」，但实现只查第一段。workspace local_dir 为多仓库目录（monorepo 子包、vendor、legion 的 .legion-worktrees 等嵌套 git）时，`vendor/sub-repo/.git/config`、`.git/credentials`、packed-refs 等可被直接取到。**实测**：真实 serve.mjs 上 `GET /api/files/download?scope=fx&path=vendor/sub-repo/.git/config` 与 read 均返回 **200** 并输出内容（fixture 含敏感字符串）；根级 .git/config 返回 403。该缺口继承自 T-040 读面，但本切片新增的 download 端点同样暴露，且切片验收口径（AC2/「路径防护同强度」）覆盖此面。
- **修改建议**：把断言改为对**任意段**命中即拒（`parts.some(p => p === '.git')`，注意不影响 .gitignore/.github 等非精确匹配项），一处改动同时覆盖 list/read/download；补 TC-S3-12 嵌套用例（`sub/.git/config`、深层 `a/b/.git/HEAD`、同名 `.gitignore` 不误伤）到逃逸矩阵。改动 < 5 行。

#### R2 🟠 download 路由 stream 'error' 的 `!res.headersSent → httpErr` 分支是死代码，且注释承诺的 404/500 语义永不生效
- **位置**：`workbench/scripts/serve.mjs` GET download 分支（772–775 行）+ openDownloadStream 注释（322 行「Content-Length 由调用方回填」无误，问题在 772 行分支本身）。
- **问题**：writeHead(200)（767 行）在 pipe 之前同步执行，Node v24 实测 writeHead 后 `res.headersSent` **立即为 true**（§0 探针）→ 此后到达的 stream 'error'（statSync 成功与 createReadStream 异步 open 之间文件被删/换/权限变的竞态，或磁盘错误）**必然**走 `res.destroy(e)` 分支；`!res.headersSent` 分支及其 404/500 干净 JSON 错误体**不可达**（死代码）。竞态发生时客户端只会得到 ECONNRESET（连接被重置），与注释/开发者意图（返回可读错误）相反；若未来运行在 headersSent 滞后为 false 的 Node 版本/路径，该分支会二次 writeHead → `ERR_HTTP_HEADERS_SENT` 在事件处理器内抛出（未捕获崩溃面）。本评审未复现崩溃（v24 下该分支不可达），但死代码 + 误导注释是本次新增代码的真实缺陷。
- **修改建议**：二选一：①（推荐）在路由内改为「先同步确认可开」——openDownloadStream 内用 `openSync(abs,'r')` 成功后再 `createReadStream('', { fd })`（打开失败同步抛出 → 外层 catch → classifyFilesError 干净映射），彻底消除竞态窗口与死分支；② 至少删除 `!res.headersSent` 分支、错误一律 `res.destroy()` 并 console.warn，注释改为「打开后错误直接断开连接」，不再承诺 404/500。

### 2.2 建议优化（可排期，不改变验收结论）

#### P2-A 🟡 TC-S3-08b 未登记 docs/TEST_CASES.md；用例标题「路由层」实为函数级直测
- **位置**：files-api.test.mjs 114–132 行（describe/it 均自称「下载路由层」）；docs/TEST_CASES.md TC-S3-08 行（133 行）之后无 08b 行。
- **问题**：新用例只直测导出函数 openDownloadStream（不起 HTTP），未断言路由层真实产物（content-length 头、content-disposition、错误映射、abort 清理），「路由层」题名夸大；且 TEST_CASES.md 是 TC 唯一登记册，08b 缺席 → AC→TC 追溯断链（本次审查靠 evidence.json + 代码推断出 08b 归属）。
- **建议**：TEST_CASES.md 补 TC-S3-08b 行（注明函数级，HTTP 层由 L1 冒烟覆盖并贴 l1Smoke 证据路径）；题名改为「openDownloadStream 函数级」避免误导。

#### P2-B 🟡 Content-Length 与实际流出竞态：下载中文件被并发追加/截短 → 客户端下载失败
- **位置**：serve.mjs download 分支 764–777 行（length 取自 openDownloadStream 内 statSync，流式读出长度不封顶）。
- **问题**：文件在 statSync 后被并发写入（日志/数据库常见）时，createReadStream 会读到超过声明 Content-Length 的字节 → Node 侧连接异常，**实测客户端报 HPE_INVALID_CONSTANT / ERR_CONTENT_LENGTH_MISMATCH**（§0 探针，服务端不崩）；被截短则体短于声明 → 客户端按截断错误处理。属边角竞态，但日志类文件的「下载中增长」并非罕见。
- **建议**：createReadStream 传 `{ start: 0, end: length - 1 }` 硬性封顶到声明长度（防溢出；文件缩短时以 EOF 自然提前结束，行为与现在一致）；或对该类场景不声明 content-length（chunked）。

#### P2-C 🟡 下载路径 TOCTOU：路径校验（realpath）与按路径 open 之间存在符号链接替换竞态（继承性）
- **位置**：serve.mjs resolveInsideRoot（205–221）+ openDownloadStream 326–330（createReadStream(abs) 按校验后的**路径**再开一次）。
- **问题**：校验通过后、open 前若目录内符号链接被同权限进程替换指向根外，可读到根外内容。与既有 read/readFileBytes 同型（非本 diff 引入）；仅回环 + 同用户目录威胁低。
- **建议**：若采纳 R2 建议①（openSync 后基于 fd 流式读），本项一并消除——列为 R2 方案的附加收益；不单独立项。

#### P2-D 🟡 错误码语义小项：不存在文件 download/read 回 400 而非 404；与 R2 注释里想映射的 404 不一致
- **位置**：serve.mjs classifyFilesError（729–736）+ download 分支 773 行（e.code==='ENOENT'→404 的映射只存在于不可达分支）。
- **问题**：对外「路径不存在」统一 400（与既有 read/list 一致，契约如此），但 R2 死分支注释暗示 404；代码内两处口径打架，纯语义噪音。
- **建议**：随 R2 一起定口径（建议维持 400 语义错误，删除 404 措辞），避免后续维护困惑。

### 2.3 测试/证据注记（不阻塞）
- 本切片契约与 L1 证据分离合理（L0 函数级 + L1 真服务冒烟在 evidence.json l1Smoke，含 256MB 21ms 头延迟 / abort 后 7ms list 反证），与本评审独立复跑互相印证 ✅。
- 未固化进仓的仍是 L1 冒烟脚本本身（evidence.json 只存结论）——与 T-041 注记同款，建议 tester 阶段把 l1Smoke 固化为可重复脚本（前例 team-hub/chat-l1-smoke.mjs）。
- 继承性提醒：P0-1（S4 上传覆盖+流中断破坏原文件）与 P0-3（S6 webFetch 每跳超时）仍开放，不在本切片文件域，evidence.json scopeNotes 已如实声明——请将军排期对应切片修复，勿随本任务关闭。

---

## 3. 总体判定

- S3 只读面（list/read/download）本切片交付**质量良好**：P0-2 修复方向与实现正确（路由零整读、Content-Length 精确、abort 清理经实测有效）；路径防护在词法/绝对/NUL/编码/symlink 矩阵上与既有读面同强度；22+10 契约全绿 + 真 HTTP 断言与证据文件互相印证；零新增依赖、diff 范围干净。
- **无 P0 级缺陷**；promote 判定：功能正确可推进，但建议在收口前处理 **R1（嵌套 .git 防护失实，改动 <5 行 + 补用例）** 与 **R2（新增错误处理死分支，随 R1 一并小改即可）**——两者都小、都带现成修复路径，不处理也不会造成服务崩溃，但会留下安全承诺缺口与误导性代码。
- P2 组可排期，不改变验收结论。

_审查人：reviewer（T-054）· 依据：代码真读 + 本报告 §0 独立复跑/探针证据 · 未修改任何实现代码_
