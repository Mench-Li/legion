# T-091 切片 S8 测试报告 —— 三中心集成回归锚定（R-A7 / R-B3 仓库内可跑部分）

> 角色：编码实现（coder）｜任务：T-091｜分支：w/T-091（独立 worktree，HEAD=c9a8282 "promote T-083"，工作树干净，除本报告外零改动）
> 日期：2026-09-05｜运行时：node v24.19.0（唯一运行时）、pnpm 11.7.0
> 取代声明：本报告取代 docs/TEST_REPORT.md 上版（T-062 S4 报告；git 历史可回溯）。
> 文件域遵守：仅改 docs/TEST_REPORT.md 一个文件（git status 全程核实）；无 push（w/* 已被守卫拦截）。

---

## 0. 结论速览

| 验收条目 | 判定 | 要点 |
| --- | --- | --- |
| ① 逐套件运行全绿（files-api / web / chat / skills / contracts / whiteboard，失败=0，记录用例数） | ✅ 全绿（含 1 项「用例文件不存在」如实说明 + 1 项沙箱命令形态受限按 R-18 记录） | files-api 40/40（suites 16）、web 21/21（12）、chat 13/13（5）、skills 12/12（5）、contracts 56/56（8）；whiteboard 67 项 0 失败（shared+server 61 + e2e 6，e2e 以 stdio-ignore 等价形态直跑，见 §2.7）；`team-hub/calendar.test.mjs` 在仓库中不存在（日程日历为占位模块，R-B1 未纳入）见 §2.6 |
| ② pnpm build（workbench） | ⚠️ 受限如实记录（R-18） | `tsc --noEmit` 0 诊断 exit 0；vite 段 esbuild spawn EPERM 复现（与 T-047/T-083 同因），见 §3 |
| ③ 三中心主路径清单走通并写入本报告 | ✅（数据面/契约 L0+L1 全部实测；GUI 渲染项静态+契约锚定，逐项标注） | 对话 ≤15s 实时（数据面 ≤5s 双订阅）、断线自动重连、纯文本渲染；文件 7 操作 + 未绑定引导 + 越界/.git 403 + overwrite/confirm；浏览器 SSRF 文案 + 5 类错误可区分 + 文本渲染不插 HTML，见 §4 |
| ④ board-plugin 按 README 验证 | ⚠️ typecheck/build ✅ 全绿；宿主注入冒烟＝宿主不可达，记录「环境受限 + 复现步骤」（R-B3/R-6/R-18） | typecheck 0 诊断；服务端编译 → lib/；客户端 tsdown → lib/client.js（`__ModuleLoader__.load` 注入形态正确）；见 §5 |
| ⑤ 宿主不可达如实记录，不冒充通过 | ✅ | DSH Desktop/profile 注入器本沙箱不可达（文件域之外），已按「环境受限+复现步骤」记录，见 §5/§7 |

---

## 1. 执行环境与命令形态说明（R-18 环境事实）

- 沙箱：workspace-write、禁网、无审批通道；文件沙箱边界 =「子进程经 **pipe** stdio 捕获输出 → spawn EPERM」。
  因此：
  1. `node --test <file>`（test runner 默认按文件 **spawn 子进程隔离**执行）在本沙箱必然 EPERM —— 已实际复现（见 §2.1 复现记录）。仓库 L0 既定口径（docs/TEST_CASES.md §0「命令以 `node <file>` 直跑等效为准（node:test 进程内执行、不 spawn 子进程 → 沙箱可跑）」）即以 **`node <file>` 直跑**为沙箱内等价形态；本报告全套件均以该形态逐套执行并记录输出要点。
  2. `pnpm build`（vite→esbuild 原生服务 spawn EPERM）、e2e 起服务子进程（pipe stdio EPERM）、plugins 测试（spawnSync git EPERM）、bash（WSL E_ACCESSDENIED）同属该边界，按 R-18 记录「环境受限 + 复现步骤」，不冒充通过。
- 三中心/存量模块数据面验证依赖的 serve.mjs、team-hub server.mjs 等子进程起服脚本均以 `stdio:'ignore'` 形态执行 → 沙箱允许，结果为**真实进程级**（L1）。

---

## 2. 验收①：逐套件运行记录（失败=0，用例数见各小节）

### 2.1 命令形态受限复现（R-18，先于各套件记录）

```
$ node --test team-hub/skills.test.mjs
✖ team-hub\skills.test.mjs (6.6362ms)
  Error: spawn EPERM
      at ChildProcess.spawn (node:internal/child_process:458:11)   （test_runner/runner:517 每文件子进程隔离）
exit code 1
```
根因：node:test runner 将每个测试文件放入独立子进程并 pipe 捕获输出 → 沙箱禁 pipe spawn。非代码问题；仓库既定等效形态为 `node <file>` 直跑（§1），各套件如下。

### 2.2 `node workbench/scripts/files-api.test.mjs` —— ✅ 40/40（suites 16）exit 0

```
ℹ tests 40  ℹ suites 16  ℹ pass 40  ℹ fail 0  ℹ duration_ms 1503
```
输出要点（套件覆盖锚定）：
- S3 只读面：list 形状/根语义/scope 未绑定 400 引导；read 文本预览/截断（MAX_READ）/二进制不可预览；download 字节一致 + 流式（P0-2 openDownloadStream 不整读内存）。
- S4 写面：upload 上限 MAX/MAX+1 413 零落盘；overwrite 两态（无 flag→409、=1→覆盖）；mkdir 多层/重复/文件同名冲突；rename 迁移/目标已存在 409/越界拒；delete confirm 语义（缺/错 400、=yes 删、非空目录拒、空目录可删、不存在 400）；token 矩阵 401/200；写路径逃逸样本全拒；并发上传同路径至多一个 200（原子）。
- S1 加固回归：**R-A1** 嵌套/内嵌 .git 任意层段 + realpath 复检（读/写七操作全 403，含符号链接指向 .git）；**R-A2** 畸形 percent-encoding 注入矩阵（%zz/悬空/重复/超长 1 万字符 + ≥10 并发）→ 400/404 且进程存活（F1/F2 均已在 T-077 修复并被本套件锚定）。
- 该文件即验收列出的 `workbench/scripts/files-api.test.mjs`（T-076 基线 34 → T-077 +6 → 40）。

### 2.3 `node workbench/scripts/web.test.mjs` —— ✅ 21/21（suites 12）exit 0

```
ℹ tests 21  ℹ suites 12  ℹ pass 21  ℹ fail 0  ℹ duration_ms 7910
```
输出要点：S6 抓取契约（正文抽取/中文解码/SPA 空壳 empty_content/协议白名单 file:&ftp: 拒/私网-回环-混淆 SSRF 矩阵全 ssrf_blocked/重定向逐跳+上限 too_many_redirects/共享 deadline 整链超时 timeout（P0-3））；限长 too_large / body stall 归类 timeout（R-A4）/ 非文本 unsupported（pdf 不读体）/ 上游 4xx-5xx → http_404/http_500；S2-R-A3 审计留痕（真实 HTTP 集成：成功/失败/拦截均一行 JSONL，含 `ssrf_blocked` 行）；A3b 默认位置（dist 之外）+ 容量轮转；G-11 WEB_ERR 枚举表（timeout/ssrf_blocked/too_large…）。

### 2.4 `node team-hub/chat.test.mjs` —— ✅ 13/13（suites 5）exit 0；`node team-hub/skills.test.mjs` —— ✅ 12/12（suites 5）exit 0

```
chat：  ℹ tests 13  ℹ pass 13  ℹ fail 0（会话创建/scope 隔离与反查/author 防冒名/分页 10/10/5/边界/审计/旧库自动建表迁移）
skills：ℹ tests 12  ℹ pass 12  ℹ fail 0（schema/校验/发布与授权门禁/授权过滤/旧库迁移缺列补齐）
```

### 2.5 `node tests/contract/contracts.test.mjs` —— ✅ 56/56（suites 8）exit 0

```
ℹ tests 56  ℹ suites 8  ℹ pass 56  ℹ fail 0  ℹ duration_ms 24
```
输出要点：既有契约基线（56 用例，T-076 基线一致），本轮回归无破坏。

### 2.6 `node team-hub/calendar.test.mjs` —— ⚠️ 用例文件不存在（如实说明，不冒充）

- 全仓库 glob `**/calendar*` + team-hub 递归扫描：**无任何 calendar 测试/实现文件**。
- 现状核实：日程日历为**占位模块**——`workbench/src/components/Sidebar.tsx:21` 菜单项 + `:78` 注释「calendar/notify：占位（G-6/TC-S8-03：给提示、非静默无响应）」；`CommandBar.tsx:120` 点击 toast「日程/会议不在 legion 引擎内，随第 2 步接入 team-hub 日程表」。对应需求 R-B1「日程日历模块（当前占位）・⚠️ 待将军确认是否纳入」未实现/无数据层。
- 结论：该验收子项指向的文件不存在；在既有仓库域内无可跑套件。归属：R-B1（未纳入，占位语义 TC-S8-03 已由 Sidebar/CommandBar 实现）。不视为本切片锚定模块的失败项，也不伪造“通过”。

### 2.7 whiteboard 套件 —— ✅ 67 项断言 0 失败（等价形态直跑；默认 `node --test` 命令形态受限已记录）

- 默认命令形态复现（`node --test packages/shared/test/*.test.mjs apps/server/test/*.test.mjs`，即 whiteboard `npm test`）：
  所有文件报 `Error: spawn EPERM`（runner 每文件子进程隔离，见 §1/§2.1）；追加 `--test-isolation=none` 后 shared/server 六文件同进程全过（61 pass）但 `e2e.test.mjs` 的 before 钩子仍 EPERM（其 `spawn(..., stdio:['ignore','pipe','pipe'])` 起真实服务子进程被沙箱 pipe 边界拦截）→ exit 1。**非代码问题**。
- 等价直跑（仓库既定口径 `node <file>`，沙箱允许），逐文件：

| 文件 | 用例 | 结果 |
| --- | --- | --- |
| packages/shared/test/contract.test.mjs | 26（schema/stateHash/hitTest/viewport/throttle/history/escapeHtml/presence） | ✅ 26/26 |
| packages/shared/test/crdt.test.mjs | 8（CRDT 收敛） | ✅ 8/8 |
| packages/shared/test/undo.test.mjs | 7（局部撤销） | ✅ 7/7 |
| apps/server/test/ws-codec.test.mjs | 7（帧编解码） | ✅ 7/7 |
| apps/server/test/storage.test.mjs | 6（StorageProvider） | ✅ 6/6 |
| apps/server/test/room.test.mjs | 7（房间/sanitizeOps） | ✅ 7/7 |
| apps/server/test/e2e.test.mjs | 6（healthz + 双端同步收敛 + 加入态恢复 + presence 互见/leave + 畸形消息不崩） | ✅ 6/6（等价形态，见下） |

  e2e 等价形态说明：原始 e2e 以 `stdio:['ignore','pipe','pipe']` 起真实 `apps/server/src/index.js` 子进程；沙箱禁 pipe spawn。按沙箱边界既定做法（stdio 改 `'ignore'` + import 路径改绝对 file URL，断言与用例零改动，沿用 docs/T042-evidence/wb-e2e-sandbox-copy.test.mjs 先例）在 %TEMP% 生成等价副本执行：**真实服务进程 + 真实 WebSocket 客户端全过 6/6**（healthz 200、A 画 B 同步收敛 stateHash 一致、新客户端 welcome.doc 完整、presence 互见与断开 leave、畸形消息后 healthz 仍 200）。副本在 %TEMP%（非仓库文件域），可复跑。
- 合计：**61 + 6 = 67 项，0 失败**（命令形态受限已按 R-18 记录，非产品失败）。

---

## 3. 验收②：pnpm build（workbench）—— tsc 全绿 + vite 段 EPERM 受限复现（R-18）

```
$ pnpm exec tsc --noEmit            （workbench/）→ exit 0，零诊断输出
$ pnpm build                        （= tsc --noEmit && vite build）
  $ tsc --noEmit && vite build
  failed to load config from …\workbench\vite.config.ts
  error during build:
  Error: spawn EPERM
      at ChildProcess.spawn …
      at ensureServiceIsRunning (…\node_modules\.pnpm\esbuild@0.28.2\…\esbuild\lib\main.js:2272:29)
  [ELIFECYCLE] Command failed with exit code 1.
```
复现步骤（与 T-047/T-083 build.txt 同因）：沙箱内任意目录执行 `cd workbench && pnpm build` → tsc 段 0 诊断通过，vite 加载配置即 spawn esbuild 原生服务失败 exit 1。根因 = 沙箱 pipe-spawn 边界（§1），非代码问题；tsc 0 诊断为沙箱内最严类型证据，vite 打包交由宿主/CI（TC-S8-02 / R-C3 口径）。

---

## 4. 验收③：三中心主路径清单（R-A7 AC1..3；逐条真实锚定 + GUI 项标注）

> 标注说明：L0=契约套件（进程内直跑）；L1=真实子进程 + HTTP/SSE（stdio-ignore 形态，沙箱允许）；静态=源码/渲染评审；GUI=需浏览器点击（本沙箱无浏览器 + dist 缺失 → 数据面已锚定，渲染项给代码行级证据，手工清单见 §4.4 供宿主 L2 走查）。

### 4.1 对话中心（R-A7 AC1）

| 承诺 | 判定 | 证据（命令/文件:行 + 输出要点） |
| --- | --- | --- |
| 第二标签页同空间 ≤15s 实时 | ✅ L1 | `node workbench/scripts/chat-s2-smoke.mjs` S2-H：**双订阅 ≤5s 收到同一 live chat:message**（≤15s 的数据面等价；两订阅均经 serve.mjs /hub 同源代理 = 浏览器 ChatView hubBase() 默认路径）。另 `node team-hub/chat-l1-smoke.mjs` TC-S1-14 真实服务 ≤5s 收 live 帧（seq/ts/member/scope/detail 完整）。9 项断言中 8 项 PASS（S2-A 见 §7-②） |
| 断线自动重连 | ✅ 代码/数据面锚定 | ChatView 实时 = 单一 `/api/events` EventSource（`api.ts:491 subscribeHubAudit`，注释「断线自动重连」）；服务端 SSE 首帧 `retry: 2000`（`team-hub/server.mjs:1809`）+ keep-alive（:1808）；ChatView 另有 **15s 轮询兜底断线窗口**（ChatView.tsx:168-172 注释「EventSource 原生自动重连 + 15s 轮询兜底」）；服务端断连韧性：chat-l1 TC-S1-15「断开不崩服务、其余订阅端仍收到事件」PASS（浏览器侧原生重连由 EventSource 规范行为承担，GUI 项见 §4.4） |
| 消息纯文本渲染（无直插 HTML） | ✅ 静态 | ChatView.tsx:359 消息体渲染为 React 文本节点 `<div className="chat-bubble …">{m.body}</div>`（white-space:pre-wrap）；`dangerouslySetInnerHTML` 在 workbench/src 仅出现在 ChatView.tsx:49 / FilesView.tsx:34 的**注释声明「全程无 dangerouslySetInnerHTML」**，代码零使用（grep 全量核实） |

### 4.2 文件中心（R-A7 AC2）

| 承诺 | 判定 | 证据（命令/输出要点） |
| --- | --- | --- |
| list/read/download/upload/mkdir/rename/delete 主路径 | ✅ L0+L1 | files-api.test.mjs 40/40（§2.2 全操作契约 + 路由层 HTTP e2e）；`node workbench/scripts/files-s5-smoke.mjs` **32/32** exit 0（真实 serve.mjs 路由层：list 形状/.git 不进列表/预览截断/二进制提示/上传即刷新/下载字节一致/mkdir 嵌套/rename/delete confirm/读回 400 等） |
| 未绑定空间引导 | ✅ L1+静态 | 服务端：files-s5 `未绑定 scope → 400「尚未绑定本地文件夹」`、`未注册 scope → 400「未注册」`（UI 原样展示）；FilesView.tsx:108-110（scope=null「📁 请先选择具体工作空间」引导）、:121-123（「空间「xx」尚未绑定本地文件夹，请先到空间设置里为它绑定一个本地目录…」+ .git 保护说明） |
| 越界 / .git 403 | ✅ L0+L1 | `..`/绝对路径/NUL/盘符/symlink 越界矩阵全 400/403（files-api §2.2）；`.git/config` 403（files-s5）；嵌套/内嵌 `.git` 任意层段 + realpath 复检 403 七操作（S1 R-A1 套件，F1 修复锚定） |
| overwrite / delete confirm 语义 | ✅ L0+L1 | 覆盖：无 overwrite → 409「目标已存在：如需覆盖请带 overwrite=1」、=1 → 覆盖成功字节更新；删除：缺 confirm/非 yes → 400「删除需要二次确认」、非空目录 400 拒删、空目录 =yes 可删（files-api 路由层 + files-s5 全过） |
| 预览受控文本渲染 | ✅ L1+静态 | XSS 夹具 `<script>…<img onerror=…>` 经 read 原样 JSON 返回（数据面不篡改），FilesView 预览以 React 文本节点渲染（无 dangerouslySetInnerHTML，同上 grep） |

### 4.3 浏览器助手（R-A7 AC3）

| 承诺 | 判定 | 证据 |
| --- | --- | --- |
| SSRF 拦截文案「已拦截：禁止访问内网地址」 | ✅ 静态（UI 文案）+L0（服务端码） | BrowserView.tsx:39 `if (code === 'ssrf_blocked') return '🛡 已拦截：禁止访问内网地址（SSRF 防护）'`，错误 toast 同文案（:93-95）；服务端 ssrf_blocked 码 + 自身文案（serve.mjs:743/748/760/761「SSRF 防护：禁止访问私网/回环地址（含 IPv6/混淆/域名解析指向）」）；web.test 私网/回环/IP 混淆/重定向至 file:// 全 `ssrf_blocked` |
| 错误可区分（限长/超时/非文本/4xx-5xx） | ✅ L0+静态 | web.test 21/21：too_large / timeout（headers 未回、body stall、整链共享 deadline 三类）/ unsupported（pdf 不读体不抽取）/ http_404/http_500 / too_many_redirects / empty_content；BrowserView `errorText`（:37-52）全错误码→独立文案 + `isErrorResult`（:56-63）错误态绝不落入正文分支（含 too_many_redirects/web_error 收口） |
| 结果文本渲染不直插远端 HTML | ✅ 静态 | BrowserView.tsx:157 正文渲染为 `<pre className="browser-text">{result.text}</pre>`（React 文本节点，远端返回的结构化文本；标题/链接为受控元素）；全组件无 dangerouslySetInnerHTML |
| 主路径（地址栏→抓取→正文/错误） | ✅ 数据面 | web.test（服务端契约全错误码均有真实返回并被断言）+ BrowserView 映射逐一对应（T-083 哈希核对 w/T-051 逐字节）；GUI 点击走查见 §4.4 |

### 4.4 GUI 手工清单（宿主 L2，本沙箱无浏览器 + dist 缺失不可点击；数据面已锚定）

- 对话：新建会话→发消息→第二标签同空间 ≤15s 收到（数据面 S2-H ≤5s）；断网/停中枢→EventSource 自动重连 + ≤15s 轮询兜底恢复；消息正文纯文本（预置 `<script>` 消息原样显示不执行）。
- 文件：切空间→绑定目录→list/read/upload/rename/delete 全流程；未绑定空间看到「尚未绑定本地文件夹」引导；路径越界/.git 403 toast；覆盖与删除二次确认弹窗。
- 浏览器：输入 `http://127.0.0.1:<port>/api/config`（私网）→ 错误视图显示「🛡 已拦截：禁止访问内网地址（SSRF 防护）」且重试可用；限长/超时/非文本/404 各触发一次且错误文案互不相同；抓取成功正文为纯文本。

---

## 5. 验收④：board-plugin 按 README 验证（typecheck/build + 宿主注入冒烟）

> board-plugin 目录内无独立 README；其使用/验证语义见根 README §2（junction/profile 注入说明）与 scrum/README（/scrum-board 路由、console 入口、artifact 白名单）。dev 构建形态与 plugins/README（`DSH_CHECKOUT=<checkout> bash scripts/build.sh`）同构。

- **typecheck**：`<DSH checkout>/node_modules/.bin/tsc -p tsconfig.json --noEmit`（deps 已在 node_modules 就位）→ **exit 0，零诊断**。
- **build（服务端）**：同一 tsc `-p tsconfig.json` 全量编译 → **exit 0**，产出 `lib/index.js(+map)`、`lib/types/index.d.ts`（= build.sh 的编译段；build.sh 本体需 bash，本沙箱 WSL bash E_ACCESSDENIED，按 R-18 记录，等价步骤已全绿）。
- **build:client（宿主注入 bundle）**：`node node_modules/tsdown/dist/run.mjs` → **exit 0**，`lib/client.js` 3.74 kB（tsdown v0.22.2 / rolldown v1.1.1）；产物为宿主模块加载器形态：`window.__ModuleLoader__.load({ id: "@dsh-external/dsh-scrum-board", factory: (require) => {...} })`，尾部导出 `apply`/`inject`（conversation.view + sidebar.footer.action 槽位）——**注入形态静态核验正确**。
- **宿主注入冒烟**：❌ 不可达 → **「环境受限 + 复现步骤」**（不冒充通过）：
  - 复现步骤（宿主/CI 侧）：① 设置 `DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness` 后按 README 注入流程把本目录挂为宿主 profile 插件（如 `@dsh-external/dsh-scrum-board` junction → profile `node_modules/@dsh-external/`）；② `dev_inject_plugin <本目录>`（super-injector 环境）；③ 重启 DSH Desktop / profile 热重载 → GUI 会话视图出现「Scrum 看板」面板 + 侧栏底部常驻块，`/scrum-board/api/daemon` 心跳可达。
  - 不可达原因：宿主注入器/Desktop 运行环境与本沙箱隔离，宿主插件目录在文件域之外（本任务仅允许改 docs/TEST_REPORT.md），无审批通道可越权。

---

## 6. R-B3 存量回归（whiteboard / contracts / board-plugin / plugins）

| 存量模块 | 判定 | 证据 |
| --- | --- | --- |
| whiteboard `node --test` 全绿 | ✅（等价形态；命令形态受限见 §2.7） | 6 单测文件 61/61 + e2e 6/6 = 67 项 0 失败；另按 DEPLOY.md 起服冒烟：`node apps/server/src/index.js`（PORT=18473, DB_PATH=:memory:）→ `/healthz` `{"ok":true,"storage":"MemoryProvider"}`、`GET /` 200 text/html（2000 B）、`/js/main.mjs` 200（真实进程，随后 Stop-Process 回收） |
| `node tests/contract/contracts.test.mjs` 全绿（56 用例基线） | ✅ | 56/56 exit 0（§2.5） |
| board-plugin typecheck/build | ✅ | §5（typecheck 0 诊断；服务端 lib/ + 客户端 lib/client.js 注入形态均绿） |
| plugins（dsh-scrum-worker dev 副本）typecheck/build | ✅（等价步骤） | 目录无 node_modules + bash 不可用（R-18）→ 按 plugins/scripts/build.sh 的 link 清单自 DSH checkout junction 链接 14 项（cordis/cosmokit/schemastery/@deepseek-ai/*/@types/node/@standard-schema）后：typecheck `tsc -p tsconfig.json --noEmit` exit 0 零诊断；全量编译 exit 0 产出 lib/（index.js+types）。plugins/tests 需 spawnSync(git) 属沙箱 pipe 边界 + 宿主 daemon 上下文 → 宿主侧执行项（不在验收必跑列） |
| board-plugin/plugins 宿主注入冒烟 | ❌ 不可达（如实记录） | §5 复现步骤；宿主侧执行（R-B3/R-6 口径） |

---

## 7. 环境受限项汇总（R-18 口径，均含复现步骤，无一冒充通过）

| # | 受限项 | 复现步骤 | 等价/缓解证据 |
| --- | --- | --- | --- |
| ① | node:test runner 子进程隔离 spawn EPERM（`node --test` 全形态，含单文件） | `node --test team-hub/skills.test.mjs` → `Error: spawn EPERM`（runner:517）exit 1 | 仓库既定 `node <file>` 直跑等价（TEST_CASES.md §0），各套件全绿（§2） |
| ② | workbench `dist/` 缺失 → chat-s2 S2-A「GET / → 200 html」fetch failed（serve.mjs ROOT=workbench/dist，:34） | 起 serve.mjs 后 `GET /`（无 dist 即无托管产物）；复现命令 `node workbench/scripts/chat-s2-smoke.mjs` → S2-A 仅此 1 项 FAIL，其余 8 项 PASS | dist 需宿主 `pnpm build` 产物（§3 vite EPERM）；T-047 同探测在有 dist 的 worktree 为 9/9（04-s2-smoke.txt S2-A status=200） |
| ③ | vite/esbuild spawn EPERM（pnpm build） | `cd workbench && pnpm build` → vite config 加载阶段 esbuild ensureServiceRunning EPERM exit 1 | tsc --noEmit 0 诊断 exit 0；T-047/T-083 同因记录 |
| ④ | e2e / plugins 子进程 pipe stdio 与 spawnSync EPERM | 原样 `node whiteboard/apps/server/test/e2e.test.mjs`（spawn pipe）→ EPERM；plugins 测试 spawnSync git → EPERM | e2e：stdio 改 ignore 的等价副本 6/6 全过（断言零改动）；plugins 测试为宿主侧项 |
| ⑤ | WSL bash E_ACCESSDENIED（build.sh 直跑） | `bash scripts/build.sh` → CreateInstance E_ACCESSDENIED exit 1 | 以 build.sh 等价的 link+tsc/tsdown 步骤全绿（§5/§6） |
| ⑥ | DSH 宿主注入不可达（board-plugin/plugins 注入冒烟） | 见 §5 复现步骤（宿主侧） | 客户端 bundle 注入形态静态核验（`__ModuleLoader__.load` + exports apply/inject） |
| ⑦ | `team-hub/calendar.test.mjs` 不存在 | `node team-hub/calendar.test.mjs` → ENOENT | 日程日历为占位模块（Sidebar.tsx:21/78、CommandBar.tsx:120 toast），R-B1 未纳入；§2.6 |

---

## 8. 可复跑命令清单（均在 worktree 根或标注目录执行）

```bash
# L0 套件（node:test 进程内直跑 = 沙箱等价形态；宿主可改用 node --test <file>）
node workbench/scripts/files-api.test.mjs      # 40/40
node workbench/scripts/web.test.mjs            # 21/21
node team-hub/chat.test.mjs                    # 13/13
node team-hub/skills.test.mjs                  # 12/12
node tests/contract/contracts.test.mjs         # 56/56
node whiteboard/packages/shared/test/contract.test.mjs   # 26/26（whiteboard 其余 5 文件同理直跑；e2e 见 §2.7 等价形态）

# L1 真实进程冒烟（stdio-ignore 形态，沙箱允许）
node team-hub/chat-l1-smoke.mjs                # 22/22
node workbench/scripts/chat-s2-smoke.mjs       # 8/9（S2-A 依赖 dist，见 §7-②）
node workbench/scripts/files-s5-smoke.mjs      # 32/32

# 前端类型/构建
cd workbench && pnpm exec tsc --noEmit         # exit 0 零诊断
cd workbench && pnpm build                     # vite 段 EPERM（§3 记录）

# 白板起服冒烟（DEPLOY.md）
cd whiteboard && node apps/server/src/index.js # /healthz {"ok":true,…}；GET / 200 html

# board-plugin / plugins（build.sh 等价；DSH_CHECKOUT 已指认）
<checkout>/node_modules/.bin/tsc -p board-plugin/tsconfig.json [--noEmit]   # exit 0
cd board-plugin && node node_modules/tsdown/dist/run.mjs                    # lib/client.js 注入形态
```

---

## 9. 结论

- 验收①逐套件真实运行：files-api 40/40、web 21/21、chat 13/13、skills 12/12、contracts 56/56、whiteboard 67 项 0 失败（等价形态），失败=0；`calendar.test.mjs` 不存在已如实说明（占位模块归属 R-B1）。
- 验收② pnpm build：tsc 0 诊断 + vite EPERM 受限复现（R-18），与仓库历史记录同因，未冒充通过。
- 验收③三中心主路径：数据面（L0+L1）与渲染安全（静态行级证据）全绿并写入本报告 §4；GUI 点击项在 §4.4 给出供宿主 L2 走查。
- 验收④⑤ board-plugin：typecheck/build（服务端 lib/ + 客户端注入形态 bundle）全绿；宿主注入冒烟不可达 → 按 R-18 记录「环境受限 + 复现步骤」，不冒充通过。
- 三中心收口（R-A7）与存量回归（R-B3）锚定完成，未发现本批回归；本任务仅改动 docs/TEST_REPORT.md 一个文件（git status 核实，无 push）。
