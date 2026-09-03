# T-041 代码审查报告（review）——「交付剩余 Legion 军团指挥团任务」三中心实现

> 审查对象：T-040 编码交付（分支 w/T-040，经 promote 合并进本线 a10f1f8）。审查范围 = 编码 diff 净增量：
> 16 文件 +2606/−27（merge-base 5677f5f → f9d6b46），覆盖：对话中心（S1/S2）、文件中心（S3/S4/S5）、浏览器助手（S6/S7）、集成接线与文档（S8）。
> 审查方式：逐文件真读代码 + 关键路径独立复跑验证；只给反馈，不改实现。
> 结论分级：**必须修改**（数据安全/契约失实/明显缺陷，建议修复后 promote）与**建议优化**（不影响主路径，可排期）。严重度用 🔴高 / 🟠中 / 🟡低 标注。

---

## 0. 验证证据（独立复跑，非引用提交自述）

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 对话中心契约 | `node team-hub/chat.test.mjs` | 13/13 绿 |
| 文件中心契约 | `node workbench/scripts/files-api.test.mjs` | 21/21 绿 |
| 浏览器契约 | `node workbench/scripts/web.test.mjs` | 10/10 绿（含 SSRF 矩阵、redirect 链、超时/限长注入） |
| 技能基线 | `node team-hub/skills.test.mjs` | 12/12 绿 |
| 存量契约 R-1 | `node --test tests/contract/contracts.test.mjs` | 56/56 绿 |
| 白板基线 R-1 | `node --test packages/shared/test/*.mjs apps/server/test/*.mjs`（whiteboard 目录） | 67/67 绿 |
| 前端类型 | `tsc -p workbench/tsconfig.json --noEmit`（typescript 取自主 checkout node_modules，经 junction，禁网） | 0 错误 |
| 前端构建 | `vite build`（同上） | 成功，615 modules；Scene3D chunk 923KB（既有，非本次引入） |

> 注：本 worktree 无 node_modules 且禁网，typecheck/build 借主 checkout（D:/project/DSH/legion/workbench/node_modules）junction 完成；其余测试零第三方依赖（node:test/node:sqlite/node:http）。T-040 声称的 6+56+67 条绿全部复核成立。

---

## 1. 验收口径逐条核对（依据 = docs/TEST_CASES.md §1.2 硬性不变量 I1–I8 + §3 量化判据）

| # | 口径 | 结论 | 依据 |
| --- | --- | --- | --- |
| I1 零新增运行时依赖 | ✅ 通过 | 三后端只用 node 内置（sqlite/http/dns/promises/fs/crypto）；team-hub、workbench、plugins 的 package.json diff 均未新增依赖；web.test/files-api.test 直跑通过 |
| I2 文件/网页接口仅回环 + 写需 token | ✅ 通过 | serve.mjs handleFsApi/handleFilesApi/handleWebApi 首行 isLoopback(req) 403；isWrite 四端点 requireWriteToken(req)；token 空=放行、非空=Bearer 校验（serve.mjs handleFilesApi） |
| I3 chat 写统一走 audit（by 必填 + SSE） | ✅ 通过 | createConversation/postMessage 均校验 by、author=by 服务端绑定（防冒名）、withTx 内 audit('chat:create'/'chat:message')；TC-S1-05/07/13 实测通过 |
| I4 三中心 scope 隔离 | ✅ 通过（含注记） | chat 表带 scope、消息 scope 恒等于会话 scope（跨 scope 写不串，TC-S1-03 过）；文件按 scope→local_dir 解析，未绑定拒绝落任意目录（TC-S3-03 过）。**注记见问题 P1-3**：GET /api/chat/conversations 不带 scope 时全分区返回 |
| I5 远端内容不得直插 DOM | ✅ 通过 | 全仓 grep 无 dangerouslySetInnerHTML（仅注释提及）；ChatPanel 正文纯文本 pre-wrap、FilesPanel 预览/文件名 React 文本节点、BrowserPanel 无 raw HTML 透传（TC-S6-10 断言过） |
| I6 覆盖需 overwrite=1、删除需 confirm、非空目录拒删 | ✅ 通过（含缺陷） | DAO 层三态全过（TC-S4-03/04/09..12）；**缺陷见 P0-1**：路由层流式上传在覆盖 + 中途超限/断连时会破坏原文件，绕过了「不落盘」语义 |
| I7 SSRF：协议白名单 + 私网/回环逐跳阻断 + 限长/超时 + 审计 | ✅ 通过（含注记） | TC-S6-04/05/06 全过：混淆 IP（127.1/0x7f000001/0177…/十进制单整）、IPv6、DNS 解析到私网逐条拦截、redirect 逐跳复检、file:// 重定向阻断；无“审计”条目落 audit（该域接口在 serve.mjs，无审计表——口径中“审计”项实现为客户端错误码/结构化返回，建议与将军确认口径可接受性） |
| I8 单一 /api/events 按 kind 过滤 | ✅ 通过 | ChatPanel 只开 EventSource(/hub/api/events) 且 filter action.startsWith('chat:')，未新增 hub 事件端点；§3 允许连接数 ≤+1 |
| MAX_BODY=8000 三值法 | ✅ 通过 | MAX_CHAT_BODY=8000 导出常量；TC-S1-12 8000 通过 / 8001 拒绝不落库 |
| 消息分页 limit 默认 50、游标翻页 | ✅ 通过（含注记） | DAO listMessages 默认 50、上限 200、before 游标升序无重无漏（TC-S1-08/09 过）；**注记见 P1-4**：前端只取最新 50 条、无「更早」入口 |
| MAX_READ=256KiB 截断标注 | ✅ 通过 | previewTextFile 读取 min(size, MAX_READ+1)、truncated=totalBytes 判定、lineCount 标注（TC-S3-05/06 过） |
| MAX_UPLOAD=64MiB | ✅ 通过（含缺陷） | Content-Length 预检 + 流式超限拦截（TC-S4-02 函数级过）；**缺陷见 P0-1** |
| web maxBytes≤2MiB / timeoutMs≤10s | ✅ 通过（含注记） | TC-S6-08/09 注入断言过；**注记见 P0-3**（timeout 实为“每跳”非“总”超时） |
| 服务端生成 id、单调排序 | ✅ 通过 | conversations/messages 均为 INTEGER PRIMARY KEY AUTOINCREMENT；TC-S1-01/08 断言升序 |

**结论：8 条硬性不变量全部成立；量化判据全部有测试锚定且复跑通过。问题集中在「路由层流式实现的健壮性」「文档/行为一致性」「前端历史可达性」三处。**

---

## 2. 问题清单

### 2.1 必须修改（建议修复后再 promote）

#### P0-1 🔴 覆盖上传流式中断/超限会破坏原文件（数据丢失）
- **位置**：`workbench/scripts/serve.mjs` PUT /api/files/upload 分支（route 内流式实现，约 770–790 行）与 `uploadBytes`（约 322 行，注释声称“+1 拒绝且不落盘”）。
- **问题**：路由层用 `createWriteStream(abs)`（默认 'w'，打开即截断）直写最终路径，且 **`uploadBytes` 只在函数级使用、路由并未复用**：
  1. 覆盖场景（overwrite=1）下请求流超过 MAX_UPLOAD（chunked/无 Content-Length 时预检失效）→ `ws.destroy()` 后 `unlinkSync(abs)` → **原文件被删除**（若流 <MAX 而中断则原文件被截断为半截）；
  2. 客户端中途断连（req 'error'）→ promise reject → 仅回 400，**目标路径残留半截文件**；
  3. 磁盘错误（ws 'error'）同理残留。
  函数级 TC-S4-02 只测 `uploadBytes`（整块 Buffer 先判后写），**测不到路由流式破坏路径**。
- **修改建议**：流式写入临时文件（如 `<最终名>.part-<pid>`）→ 成功后 `renameSync` 原子替换；任何错误/超限仅清理 .part，绝不动原文件；为路由路径补一条「覆盖 + 流超限 → 原文件完好」测试（L0 可用真实 socket 或抽取可测 handler）。

#### P0-2 🔴 下载接口全文件同步读入内存（与注释矛盾，大文件卡死服务）
- **位置**：`workbench/scripts/serve.mjs` `readFileBytes`（约 313 行注释自称“路由层用 createReadStream 流式返回”）+ GET /api/files/download 路由（约 749–757 行）。
- **问题**：路由实际调用 `readFileBytes` → `readFileSyncFull` 把**整个文件 Buffer 同步读入内存再 `res.end(buffer)`**，无大小上限。数百 MB～GB 级文件（zip/数据库/日志）会：单线程事件循环被同步读阻塞（期间所有并发请求排队）+ 内存暴涨。注释与实现相反，说明是遗留实现错误。
- **修改建议**：下载路由改 `createReadStream(abs).pipe(res)` + `Content-Length`（stream 的 error 处理 + 客户端断连 unpipe）；`readFileBytes` 保留仅作契约测试小文件载体；对超大文件补一条不炸内存的冒烟证据。

#### P0-3 🟠 webFetch 超时实为「每跳」而非注释/常量注释声称的「总超时」
- **位置**：`workbench/scripts/serve.mjs` `WEB_LIMITS.TIMEOUT_MS` 注释「总超时（可被请求覆盖）」（约 76 行）；`webFetch`（约 646 行起）每次重定向递归（约 662 行）都新建 AbortController + setTimeout。
- **问题**：5 跳 + 终页最坏总耗时 ≈ 6×timeoutMs（默认 60s），与「总超时 10s」承诺不符；且外层 hop 的 timer 在外层 fetch 返回后仍在计时（要等内层递归整链返回才 clearTimeout），期间无任何消费/取消动作，纯空转。
- **修改建议**：两选一（成本都低）：① 递归时向下传共享 deadline（如 `deadlineTs = Date.now()+tm`），每跳用 `Math.min(tm, deadlineTs-Date.now())`；② 至少把注释改为「每跳超时」并同步 TEST_CASES/README 措辞。建议做①。

### 2.2 建议优化

#### P1-1 🟠 前端文件写操作不带 Authorization：serve.mjs 配 --token 部署时 UI 全 401
- **位置**：`workbench/src/api.ts` filesWrite/filesUpload/filesMkdir/filesRename/filesDelete（约 518–569 行）——与 hubPost（366 行带 authHeaders）不一致。
- **问题**：`serve.mjs --token xxx` 部署（README §4.1 明示支持）时，工作台「上传/新建目录/重命名/删除」全部 401，UI 无入口提供该 token；读不受影响。默认不配 token 时无感，故非阻塞。
- **建议**：文件写请求带上 authHeaders()（与 hub 共用 token 或新增 serve.mjs 写 token 输入），并在 README 说明两 token 关系。

#### P1-2 🟠 handleWrite 对 chat 返回 `{ok:true, task:<会话/消息>}`，命名误导
- **位置**：`team-hub/server.mjs` handleWrite（约 864 行）+ api.ts 读取 `res.task`（452/471 行）。
- **问题**：task 字段语义是“写入结果”，对 chat 而言实为 conversation/message；接口自描述性差，第三方接入易踩。
- **建议**：handleWrite 响应加通用字段（如 `data`）或对 chat 路由单独序列化；最小改动是在 server.mjs 注释与 api.ts 里说明该兼容形状。

#### P1-3 🟠 GET /api/chat/conversations 缺省返回全部 scope（隔离“按需”而非“默认”）
- **位置**：`team-hub/server.mjs` 路由（约 1339–1346 行）→ `listConversations({scope})`（约 548 行）；配合 hub 默认 HOST 0.0.0.0 + 读接口不鉴权。
- **问题**：scope 缺省/空串 → 全分区会话标题/参与者列表可被任何能连到 :8787 的读方拿到（消息需 conv 后取，同路径）。UI 恒传具体 scope，故产品主路径不炸，但“隔离”语义依赖客户端自觉。
- **建议**：至少给缺省加保护（缺 scope 返回 400 并提示），或列表接口默认只返回显式 scope；若保持现状，在 team-hub/server.mjs 头注释与 README 明示该读面边界。另建议 hub 默认绑定改 127.0.0.1（生产不暴露局域网）——超出本次 diff，请将军裁决是否立新任务。

#### P1-4 🟠 对话历史前端只到最近 50 条，无“加载更早”
- **位置**：`workbench/src/components/ChatPanel.tsx`（fetchChatMessages limit: PAGE=50，约 7/55 行）。
- **问题**：后端分页游标齐全（TC-S1-08），前端从不传 before，也没有“加载更早”按钮/滚动加载；会话 >50 条后旧消息**不可达**（TC-S2-04“历史完整恢复”实际仅对 ≤50 条成立）。
- **建议**：消息区顶部加“加载更早消息”按钮（before=msgs[0].id 前缀插入），顺带修正自动滚底逻辑（用户上翻时勿强拉到底）。

#### P1-5 🟡 audit 内 SSE 扇出无异常隔离，且在 chat withTx 内广播
- **位置**：`team-hub/server.mjs` broadcastAudit（约 819 行）无 try/catch；chat DAO 在 withTx（537/569 行）内调用 audit。
- **问题**：任一 SSE 客户端 socket 写入抛错会把「会话创建/发消息」整个事务回滚（写失败但原因在推送侧）；广播也占用写锁时长。
- **建议**：broadcastAudit 逐客户端 try/catch + 给 res 挂 'error' 监听剔除死连接；chat 的 audit 可留在事务外（先 commit 再审计）或保持现状但在注释里说明取舍。

#### P1-6 🟡 路由上传逻辑与 uploadBytes 重复实现（漂移风险）
- **位置**：`serve.mjs` uploadBytes（322 行，Buffer 版）vs 路由流式版（758–794 行）各自实现存在性/覆盖/目录检查与上限。
- **问题**：两套语义已出现分叉（P0-1 即路由版缺陷、函数版没有）；后续维护易只改其一。
- **建议**：抽公共“目标预检 + 写临时文件 + 原子改名”原语，函数版与路由版共用；测试锚定路由版。

#### P1-7 🟡 路径逃逸矩阵未覆盖 URL 编码等价（%2e%2e / %2F）与 Windows 尾点/短名
- **位置**：files-api.test.mjs 逃逸样本（TC-S3-09/TC-S4-14）与 serve.mjs resolveInsideRoot。
- **问题**：实现层 `decodeURIComponent(url.pathname)` 在 createServer 顶层先解码（query 由 URL.searchParams 再解码），逃逸测试只测了原生 ../ 形态。Windows 上 URLSearchParams 对 `path=%2e%2e%2f` 解码后仍走词法拦截，理论上安全，但缺测试锚定。
- **建议**：把 TEST_CASES §8.3 的编码等价样本补进 files-api.test.mjs（低风险、高回归价值）。

#### P1-8 🟡 resolveScopeLocalDir 失败统一 400：hub 未启动 / 空间未注册语义不同
- **位置**：serve.mjs handleFilesApi catch → classifyFilesError（约 720 行）。
- **问题**：'无法从 team-hub 读取工作空间列表'（hub 没起）与 '工作空间未注册'、'目录不存在' 都回 400，前端 toast 可读但状态码不区分基础设施故障（应 503/404）。
- **建议**：classifyFilesError 增加 503 分支（含 '无法从 team-hub' / '未注册' 提示文案），或至少统一错误文案里的排查引导。

#### P1-9 🟡 normalizeUrl 前端放行 ftp:/file:/data:/javascript: 再交由后端拦截
- **位置**：BrowserPanel.tsx normalizeUrl。
- **问题**：这些输入会发到后端才得 protocol_blocked，浪费一次请求与误导性文案；纯前端即可拒绝（与占位符提示一致）。
- **建议**：前端只接受 http(s)（可自动补 https），其余直接 toast 提示协议不支持。

#### P1-10 🟡 FilesPanel 小项：mtime=null 渲染为 1970-01-01；删除/预览无 busy 保护（连点）；超大目录列表一次全量
- **位置**：FilesPanel.tsx mtimeText / doDelete / 列表渲染；serve.mjs listDirEntries 不分页。
- **问题**：`new Date(null)` 非 NaN → 显示 1970；目录条目超过千级时单次 JSON + 全量表格卡顿。
- **建议**：mtime 空串显示 '—'；操作按钮 busy 期间禁用；大目录分页或虚拟滚动留待 P2。

### 2.3 测试/验收注记（不阻塞，供 tester/devops 阶段勾稽）

- TC-S1-14/15/17（真服务 SSE 延迟、断连清理、token 矩阵）与 TC-S4-13 HTTP 401 矩阵当前只存在于 L1 冒烟证据，未固化进仓测试；本次无法在本环境起真服务复验——建议 tester 阶段在宿主环境补跑并把输出贴回任务证据。
- TC-S2/S5/S7 前端行为（双标签实时、错误态草稿保留、SSRF 文案等）属 L2 手工验收清单，评审已做代码级正读，未做浏览器级走查；请在 tester 验收时按 TEST_CASES §7 清单逐条勾。
- I7 口径含“审计”项：文件/网页域（serve.mjs）没有审计表，SSRF/写操作只回结构化错误，未落审计行；若“审计”是验收硬要求，请将军裁决是否在 serve.mjs 侧补一个本地 JSONL 审计文件任务。

### 2.4 继承性观察（非本次 diff 引入，promote 不阻塞；建议记入 backlog）
- serve.mjs createServer 顶层 `decodeURIComponent(url.pathname)`（基础版本即有，当前 888 行版本 828 行）无 try/catch：畸形编码请求（如 %zz 手动拼接）会抛 URIError 直达 createServer 回调 → 单请求崩溃/未捕获异常风险（Node 下可能整进程退出）。建议加 try/catch 回 400。
- /hub 反向代理在浏览器断开 SSE 时不主动销毁 upstream 连接（依赖上游 heartbeat 写失败才回收），高频刷新场景可能堆积连接；ChatPanel 依赖该代理（/hub/api/events），值得一并加固。
- vite 产物 Scene3D chunk 923KB 无 code-split（React.lazy 可选），与 TC-S2-01 “若用 React.lazy” 相容；属性能债非缺陷。

---

## 3. 总体判定

- 实现质量**整体良好且可验收推进**：三中心后端/前端结构清晰，I1–I8 不变量全部成立并有测试锚定；本次独立复跑 13+21+10+12+56+67 条全绿 + typecheck/build 通过，与 T-040 证据一致；XSS（I5）、SSRF（I7）、路径逃逸（I6/§8.3）三处安全面实现与测试均到位。
- **promote 前建议处理 P0-1 / P0-2**（文件中心路由层两处真实缺陷，涉及用户文件安全与服务稳定性），P0-3 至少改注释/文档或补共享 deadline。
- P1 组均为可排期优化，不改变验收结论；其中 P1-1（--token 部署下前端写不可用）与 P1-3（scope 缺省全量读 + hub 0.0.0.0 默认绑定）建议将军拍板是否本次补。

_审查人：reviewer（T-041）· 依据：代码真读 + 本报告 §0 复跑证据 · 未修改任何实现代码_
