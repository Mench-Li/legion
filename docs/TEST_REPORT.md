# T-092 切片 S8 测试报告 —— 三中心集成回归锚定（R-A7 / R-B3 仓库内可跑部分）

> 角色：测试执行（tester）｜任务：T-092｜分支：w/T-092（独立 worktree；HEAD=06480ba "公共调解员（mode:mediator）：跨空间合入调解独立实例" = 当前合并 HEAD）
> 日期：2026-09-05｜运行时：node v24.19.0、pnpm 11.7.0（沙箱 workspace-write、禁网、无审批通道）
> 取代声明：本报告取代 docs/TEST_REPORT.md 上版（T-091 S8 报告，coder 角色；git 历史可回溯）。
> 文件域遵守：仅改 docs/TEST_REPORT.md 一个文件（git status 全程核实为零源码改动）；无 push（w/* 已被守卫拦截）；未修改任何源码/测试用例（只测不修）。
> 任务边界：依赖 T-091（已完成并 promote）。将军批注标记 [probe3-b]/[append-fix-a]/[append-fix-b] 在仓库内无对应文本定义，本报告按「全量真实证据 + 复现步骤 + 归属」口径覆盖其可核验意图。

---

## 0. 结论速览

| 验收条目 | 判定 | 要点 |
| --- | --- | --- |
| ① 逐套件运行全绿（files-api / web / chat / skills / calendar / contracts / whiteboard，失败=0，记录用例数） | ✅ 全绿（7 套件全部真实运行；沙箱命令形态受限按 R-18 记录等价直跑，见 §1） | files-api **40/40**（suites 16）、web **24/24**（suites 13，含 T-094 回归用例）、chat **13/13**（5）、skills **12/12**（5）、calendar **13/13**（10）、contracts **56/56**（8）；whiteboard **67 项 0 失败**（shared+server 6 文件 61 + e2e 等价副本 6/6），见 §2 |
| ② pnpm build（workbench） | ⚠️ 受限如实记录（R-18） | `tsc --noEmit` 0 诊断 exit 0；vite 段 esbuild spawn EPERM 复现（与 T-047/T-083/T-091 同因），见 §3 |
| ③ 三中心主路径清单走通并写入本报告 | ✅（数据面/契约 L0+L1 全部实测；GUI 渲染项静态+契约锚定，逐项标注） | 对话 ≤15s 实时（数据面 ≤5s 双订阅）、断线自动重连、纯文本渲染；文件 7 操作 + 未绑定引导 + 越界/.git 403 + overwrite/confirm；浏览器 SSRF 文案 + 5 类错误可区分 + 文本渲染不插 HTML，见 §4 |
| ④ board-plugin 按 README 验证 | ⚠️ typecheck/build ✅ 全绿；宿主注入冒烟＝宿主不可达，记录「环境受限 + 复现步骤」（R-B3/R-6/R-18） | typecheck 0 诊断；服务端编译 → lib/；客户端 tsdown → lib/client.js（`__ModuleLoader__.load` 注入形态正确）；见 §5 |
| ⑤ 宿主不可达如实记录，不冒充通过 | ✅ | DSH Desktop/profile 注入器本沙箱不可达（文件域之外），已按「环境受限+复现步骤」记录，见 §5/§7 |
| ⑥ R-B3 delta 专项：plugins/src 含 06480ba 调解合并变更（+194/-48），重跑 typecheck+编译 | ✅ 全绿 | `tsc -p tsconfig.json --noEmit` exit 0 零诊断；全量编译 exit 0 产出 lib/。详见 §6（plugins 单元测试按 R-18/宿主侧口径单独说明） |

---

## 1. 执行环境与命令形态说明（R-18 环境事实）

- 沙箱：workspace-write、禁网、无审批通道；文件沙箱边界 =「子进程经 **pipe** stdio 捕获输出 → spawn EPERM」。
  因此：
  1. `node --test <file>`（test runner 默认按文件 **spawn 子进程隔离**执行）在本沙箱必然 EPERM —— 已实际复现（见 §2.1 复现记录）。仓库 L0 既定口径（docs/TEST_CASES.md §0「命令以 `node <file>` 直跑等效为准（node:test 进程内执行、不 spawn 子进程 → 沙箱可跑）」）即以 **`node <file>` 直跑**为沙箱内等价形态；本报告全套件均以该形态逐套执行并记录输出要点。
  2. `pnpm build`（vite→esbuild 原生服务 spawn EPERM）、e2e 起服务子进程（pipe stdio EPERM）、plugins 单元测试（spawnSync git EPERM）、bash（WSL E_ACCESSDENIED）同属该边界，按 R-18 记录「环境受限 + 复现步骤」，不冒充通过。
- 三中心/存量模块数据面验证依赖的 serve.mjs、team-hub server.mjs 等子进程起服脚本均以 `stdio:'ignore'` 形态执行 → 沙箱允许，结果为**真实进程级**（L1）。

### 1.1 本轮运行基线（当前 HEAD=06480ba = 合并 HEAD，含 06480ba 调解合并）

- 当前 worktree HEAD = **06480ba**（公共调解员 mode:mediator 跨空间合入调解独立实例，2026-09-05 16:22 +0800）。该提交相对其父 7737161（promote T-091）**仅改 plugins/src/index.ts（+194/-48）**——即相对 T-091 复验基线（5813ae5）的唯一源码增量落在 **plugins（dsh-scrum-worker dev 副本）**，正是本片 R-B3 需要锚定的 delta（§6 专项重跑）。
- 其余被测模块（workbench/scripts、team-hub、tests/contract、whiteboard、board-plugin）在合并 HEAD 上与 T-091 第 3 轮复验基线内容一致（calendar 等已合入），本轮全部**重新实测**而非仅核对报告。
- 关键命令与输出：
  - `node --test team-hub/skills.test.mjs` → `Error: spawn EPERM` exit 1（复现 §2.1 边界，R-18 属实）；
  - **七个** L0 套件均以 `node <file>` 直跑（仓库既定等价形态）：files-api **40/40**、web **24/24**、chat **13/13**、skills **12/12**、calendar **13/13**、contracts **56/56**；whiteboard 6 单测文件 **61/61** + e2e 等价副本 **6/6**（%TEMP% 重建 `wb-e2e-sandbox-copy-T092.test.mjs`，stdio 改全 ignore + 路径改绝对 file URL，断言零改动）；
  - `pnpm exec tsc --noEmit`（workbench）exit 0 零诊断；`pnpm build` → tsc 段过后 vite 段 esbuild `spawn EPERM` exit 1（§3 复现）；
  - L1 冒烟：chat-l1 **22/22**（TC-S1-14 真进程 SSE ≤5s 收 live 帧、TC-S1-15 断开不崩）、chat-s2 **8/9**（S2-A 依赖 dist 缺 → 见 §7-②；S2-H 双订阅 ≤5s msg=61）、files-s5 **32/32**、whiteboard 真进程起服 `/healthz` 200 {"ok":true,"storage":"MemoryProvider"} + `GET /` 200 html（1832 B）+ `/js/main.mjs` 200（15160 B）；
  - board-plugin：typecheck 0 诊断 exit 0、服务端编译 → lib/index.js + lib/types/index.d.ts、tsdown → lib/client.js 3.74 kB（注入形态核验）；plugins（含 06480ba delta）：typecheck 0 诊断 exit 0、全量编译 exit 0 → lib/index.js（118780 B）。

---

## 2. 验收①：逐套件运行记录（失败=0，用例数见各小节）

### 2.1 命令形态受限复现（R-18，先于各套件记录）

```
$ node --test team-hub/skills.test.mjs
✖ team-hub\skills.test.mjs (2.8229ms)
  Error: spawn EPERM
      at ChildProcess.spawn (node:internal/child_process:458:11)   （test_runner 每文件子进程隔离）
exit code 1
```
根因：node:test runner 将每个测试文件放入独立子进程并 pipe 捕获输出 → 沙箱禁 pipe spawn。非代码问题；仓库既定等效形态为 `node <file>` 直跑（§1），各套件如下。

### 2.2 `node workbench/scripts/files-api.test.mjs` —— ✅ 40/40（suites 16）exit 0

```
ℹ tests 40  ℹ suites 16  ℹ pass 40  ℹ fail 0  ℹ duration_ms 1543
```
输出要点（套件覆盖锚定）：
- S3 只读面：list 形状/根语义/scope 未绑定 400 引导；read 文本预览/截断（MAX_READ）/二进制不可预览；download 字节一致 + 流式。
- S4 写面：upload 上限 MAX/MAX+1 413 零落盘；overwrite 两态（无 flag→409、=1→覆盖）；mkdir 多层/重复/文件同名冲突；rename 迁移/目标已存在 409/越界拒；delete confirm 语义（缺/错 400、=yes 删、非空目录拒、空目录可删、不存在 400）；token 矩阵 401/200；写路径逃逸样本全拒；并发上传同路径至多一个 200（原子）。
- S1 加固回归：**R-A1** 嵌套/内嵌 .git 任意层段 + realpath 复检（读/写七操作全 403，含符号链接指向 .git）；**R-A2** 畸形 percent-encoding 注入矩阵（%zz/悬空/重复/超长 1 万字符 + ≥10 并发）→ 400/404 且进程存活。
- 该文件即验收列出的 `workbench/scripts/files-api.test.mjs`（T-076 基线 34 → T-077 +6 → 40）。

### 2.3 `node workbench/scripts/web.test.mjs` —— ✅ 24/24（suites 13）exit 0

```
ℹ tests 24  ℹ suites 13  ℹ pass 24  ℹ fail 0  ℹ duration_ms 8459
```
输出要点：S6 抓取契约（正文抽取/中文解码/SPA 空壳 empty_content/协议白名单 file:&ftp: 拒/私网-回环-混淆 SSRF 矩阵全 ssrf_blocked/重定向逐跳+上限 too_many_redirects/共享 deadline 整链超时 timeout）；限长 too_large / body stall 归类 timeout（R-A4）/ 非文本 unsupported（pdf 不读体）/ 上游 4xx-5xx → http_404/http_500；S2-R-A3 审计留痕（真实 HTTP 集成：成功/失败/拦截均一行 JSONL，含 ssrf_blocked 行）；G-11 WEB_ERR 枚举表收口。

### 2.4 `node team-hub/chat.test.mjs` —— ✅ 13/13（suites 5）exit 0；`node team-hub/skills.test.mjs` —— ✅ 12/12（suites 5）exit 0

```
chat：  ℹ tests 13  ℹ pass 13  ℹ fail 0（会话创建/scope 隔离与反查/author 防冒名/分页 10/10/5/边界/审计/旧库自动建表迁移）
skills：ℹ tests 12  ℹ pass 12  ℹ fail 0（schema/校验/发布与授权门禁/授权过滤/旧库迁移缺列补齐）
```

### 2.5 `node tests/contract/contracts.test.mjs` —— ✅ 56/56（suites 8）exit 0

```
ℹ tests 56  ℹ suites 8  ℹ pass 56  ℹ fail 0  ℹ duration_ms 22
```
输出要点：既有契约基线（56 用例，T-076 基线一致），本轮回归无破坏。

### 2.6 `node team-hub/calendar.test.mjs` —— ✅ 13/13（suites 10）exit 0

```
ℹ tests 13  ℹ suites 10  ℹ pass 13  ℹ fail 0  ℹ duration_ms 889
```
输出要点：非法入参（缺 by/scope/title/非法时间/超长 → 400 零落库；窗参数 from 晚于 to → 400）；合法边界（title=100 恰好/end 省略/allDay 往返/end=start/meta 往返）；路由层真实 HTTP（POST → GET 窗闭区间 → delete → 审计 calendar:* 留痕 + SSE 广播）；DAO 级直测（create/list 校验直接可用）。

### 2.7 whiteboard 套件 —— ✅ 67 项断言 0 失败（等价形态直跑；默认 `node --test` 命令形态受限已记录）

- 默认命令形态受限（`node --test` → 每文件子进程 spawn EPERM；同 §2.1）。等价直跑（仓库既定口径 `node <file>`，沙箱允许），逐文件：

| 文件 | 用例 | 结果 |
| --- | --- | --- |
| packages/shared/test/contract.test.mjs | 26 | ✅ 26/26 |
| packages/shared/test/crdt.test.mjs | 8 | ✅ 8/8 |
| packages/shared/test/undo.test.mjs | 7 | ✅ 7/7 |
| apps/server/test/ws-codec.test.mjs | 7 | ✅ 7/7 |
| apps/server/test/storage.test.mjs | 6 | ✅ 6/6 |
| apps/server/test/room.test.mjs | 7 | ✅ 7/7 |
| apps/server/test/e2e.test.mjs | 6 | ✅ 6/6（等价形态，见下） |

  e2e 等价形态说明：原始 e2e 以 `stdio:['ignore','pipe','pipe']` 起真实服务子进程（沙箱禁 pipe spawn）。按既定做法在 %TEMP% 生成等价副本 `wb-e2e-sandbox-copy-T092.test.mjs`（stdio 改全 ignore + import/服务路径改绝对 file URL，**断言与用例零改动**）：**真实服务进程 + 真实 WebSocket 客户端 6/6 全过**（healthz 200、A 画 B 同步收敛 stateHash 一致、新客户端 welcome.doc 完整、presence 互见与 leave、畸形消息后 healthz 仍 200）。副本在 %TEMP%（非仓库文件域），可复跑。
- 合计：**61 + 6 = 67 项，0 失败**（命令形态受限已按 R-18 记录，非产品失败）。
- 另按 DEPLOY.md 起真实服务冒烟（stdio-ignore 起 `apps/server/src/index.js`，PORT=随机、DB_PATH=:memory:）：`GET /healthz` 200 `{"ok":true,"storage":"MemoryProvider","ts":…}`；`GET /` 200 html（1832 B）；`GET /js/main.mjs` 200（15160 B）；随后 Stop-Process 回收。

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
      at ensureServiceIsRunning (…\esbuild@0.28.2\…\lib\main.js:2272:29)
  [ELIFECYCLE] Command failed with exit code 1.
```
复现步骤（与 T-047/T-083/T-091 build.txt 同因）：沙箱内任意目录执行 `cd workbench && pnpm build` → tsc 段 0 诊断通过，vite 加载配置即 spawn esbuild 原生服务失败 exit 1。根因 = 沙箱 pipe-spawn 边界（§1），非代码问题；tsc 0 诊断为沙箱内最严类型证据，vite 打包交由宿主/CI（TC-S8-02 / R-C3 口径）。

---

## 4. 验收③：三中心主路径清单（R-A7 AC1..3；逐条真实锚定 + GUI 项标注）

> 标注说明：L0=契约套件（进程内直跑）；L1=真实子进程 + HTTP/SSE（stdio-ignore 形态，沙箱允许）；静态=源码/渲染评审；GUI=需浏览器点击（本沙箱无浏览器 + dist 缺失不可点击 → 数据面已锚定，渲染项给代码行级证据，手工清单见 §4.4 供宿主 L2 走查）。

### 4.1 对话中心（R-A7 AC1）

| 承诺 | 判定 | 证据（命令/文件:行 + 输出要点） |
| --- | --- | --- |
| 第二标签页同空间 ≤15s 实时 | ✅ L1 | `node workbench/scripts/chat-s2-smoke.mjs` S2-H：**双订阅 ≤5s 收到同一 live chat:message**（msg=61；≤15s 的数据面等价；两订阅均经 serve.mjs /hub 同源代理 = 浏览器 ChatView hubBase() 默认路径）。另 `node team-hub/chat-l1-smoke.mjs` TC-S1-14 真实服务 ≤5s 收 live 帧（seq/ts/member/scope/detail 完整）PASS。9 项断言中 8 项 PASS（S2-A 见 §7-②） |
| 断线自动重连 | ✅ 代码/数据面锚定 | ChatView 实时 = 单一 /api/events EventSource（api.ts:491-492 `subscribeHubAudit`，注释「断线自动重连」）；服务端 SSE（team-hub/server.mjs:1983-1992，当前 HEAD 行号）：首帧 `retry: 2000`（:1985）+ 15s `:hb` heartbeat（:1991）与 req close 清理（:1992）；ChatView 另有 **15s 轮询兜底断线窗口**（ChatView.tsx:157 注释 + :168-172 `setInterval(…, 15000)`）；服务端断连韧性：chat-l1 TC-S1-15「断开不崩服务、其余订阅端仍收到事件」PASS |
| 消息纯文本渲染（无直插 HTML） | ✅ 静态 | ChatView.tsx:359 消息体渲染为 React 文本节点 `{m.body}`（white-space:pre-wrap）；`dangerouslySetInnerHTML` 在 workbench/src 仅出现在**注释声明**（ChatView.tsx:49 等），代码零使用（grep 全量核实） |

### 4.2 文件中心（R-A7 AC2）

| 承诺 | 判定 | 证据（命令/输出要点） |
| --- | --- | --- |
| list/read/download/upload/mkdir/rename/delete 主路径 | ✅ L0+L1 | files-api.test.mjs 40/40（§2.2）；`node workbench/scripts/files-s5-smoke.mjs` **32/32** exit 0（真实 serve.mjs 路由层：list 形状/.git 不进列表/预览截断/二进制提示/上传即刷新/下载字节一致/mkdir 嵌套/rename/delete confirm 等） |
| 未绑定空间引导 | ✅ L1+静态 | 服务端：files-s5「未绑定 scope → 400「尚未绑定本地文件夹」」「未注册 scope → 400「未注册」」；FilesView.tsx:121「空间「xx」尚未绑定本地文件夹」引导 + :108-110 空空间引导 |
| 越界 / .git 403 | ✅ L0+L1 | `..`/绝对路径/NUL/盘符/symlink 越界矩阵全 400/403；`.git/config` 403（files-s5）；嵌套/内嵌 .git 任意层段 + realpath 复检 403 七操作（S1 R-A1 套件） |
| overwrite / delete confirm 语义 | ✅ L0+L1 | 覆盖：无 overwrite → 409、=1 → 覆盖；删除：缺 confirm/非 yes → 400、非空目录拒、空目录 =yes 可删（files-api 路由层 + files-s5 全过） |
| 预览受控文本渲染 | ✅ L1+静态 | XSS 夹具经 read 原样 JSON 返回（数据面不篡改）；FilesView 预览以 React 文本节点渲染（无 dangerouslySetInnerHTML） |

### 4.3 浏览器助手（R-A7 AC3）

| 承诺 | 判定 | 证据 |
| --- | --- | --- |
| SSRF 拦截文案「已拦截：禁止访问内网地址」 | ✅ 静态（UI 文案）+L0（服务端码） | BrowserView.tsx:39 `if (code === 'ssrf_blocked') return '🛡 已拦截：禁止访问内网地址（SSRF 防护）'`；web.test 私网/回环/IP 混淆/重定向至 file:// 全 ssrf_blocked |
| 错误可区分（限长/超时/非文本/4xx-5xx） | ✅ L0+静态 | web.test 24/24：too_large / timeout / unsupported / http_404/http_500 / too_many_redirects / empty_content；BrowserView `errorText`（:37-52）全错误码→独立文案 + `isErrorResult`（:56-63）错误态不落正文分支；重试按钮 :175 可用 |
| 结果文本渲染不直插远端 HTML | ✅ 静态 | BrowserView.tsx:157 正文渲染为 `<pre className="browser-text">{result.text}</pre>`（React 文本节点）；全组件无 dangerouslySetInnerHTML |
| 主路径（地址栏→抓取→正文/错误） | ✅ 数据面 | web.test 服务端契约全错误码真实返回并被断言 + BrowserView 映射逐一对应；GUI 点击走查见 §4.4 |

### 4.4 GUI 手工清单（宿主 L2，本沙箱无浏览器 + dist 缺失不可点击；数据面已锚定）

- 对话：新建会话→发消息→第二标签同空间 ≤15s 收到（数据面 S2-H ≤5s）；停中枢→EventSource 自动重连 + ≤15s 轮询兜底恢复；消息正文纯文本。
- 文件：切空间→绑定目录→list/read/upload/rename/delete 全流程；未绑定空间看到「尚未绑定本地文件夹」引导；路径越界/.git 403 toast；覆盖与删除二次确认。
- 浏览器：输入私网地址 → 错误视图「🛡 已拦截：禁止访问内网地址（SSRF 防护）」且重试可用；限长/超时/非文本/404 各触发一次且文案互不相同；抓取成功正文纯文本。

---

## 5. 验收④：board-plugin 按 README 验证（typecheck/build + 宿主注入冒烟）

> board-plugin 目录内无独立 README；其使用/验证语义见根 README §2 与 scrum/README（/scrum-board 路由）。dev 构建形态与 plugins/README（`DSH_CHECKOUT=<checkout> bash scripts/build.sh`）同构。

- **typecheck**：`pnpm typecheck`（= tsc -p tsconfig.json --noEmit）→ **exit 0，零诊断**。
- **build（服务端）**：`tsc -p tsconfig.json` 全量编译 → **exit 0**，产出 lib/index.js(+map)、lib/types/index.d.ts（= build.sh 编译段；build.sh 本体需 bash → WSL E_ACCESSDENIED，按 R-18 记录，等价步骤已全绿）。
- **build:client（宿主注入 bundle）**：`pnpm build:client`（tsdown）→ **exit 0**，lib/client.js 3.74 kB（tsdown v0.22.2 / rolldown v1.1.1）；产物为宿主模块加载器形态 `window.__ModuleLoader__.load({…})`，尾部导出 apply/inject（conversation.view + sidebar.footer.action 槽位）——**注入形态静态核验正确**。
- **宿主注入冒烟**：❌ 不可达 → **「环境受限 + 复现步骤」**（不冒充通过）：复现步骤 = DSH 宿主注入流程（junction → profile node_modules → dev_inject_plugin → 重启 Desktop 看板面板 + /scrum-board/api/daemon 心跳）；不可达原因 = 宿主注入器/Desktop 与本沙箱隔离（文件域之外，无审批通道）。

---

## 6. R-B3 存量回归（whiteboard / contracts / board-plugin / plugins）

| 存量模块 | 判定 | 证据 |
| --- | --- | --- |
| whiteboard 全绿（等价形态） | ✅ | 6 单测文件 61/61 + e2e 等价副本 6/6 = 67 项 0 失败（§2.7）；真进程起服 /healthz 200 + GET / 200 html + /js/main.mjs 200 |
| `node tests/contract/contracts.test.mjs` | ✅ | 56/56 exit 0（§2.5） |
| board-plugin typecheck/build | ✅ | §5（typecheck 0 诊断；服务端 lib/ + 客户端 lib/client.js 注入形态均绿） |
| plugins（dsh-scrum-worker dev 副本）typecheck/build | ✅ | §6.1 专项（**含 06480ba 调解合并 delta 重跑**，typecheck 0 诊断 exit 0；全量编译 exit 0 → lib/index.js 118780 B） |
| plugins 单元测试（`node --test tests/*.test.mjs` 等价直跑） | ⚠️ 见 §6.2/§6.3 | worker-regression 4/7、slice-orchestration 5/6：失败 = spawnSync(git) EPERM（R-18，宿主可跑）+ 1 项测试预期与 HEAD 行为漂移（§6.3 详析归属，非本片源码回归） |
| board-plugin/plugins 宿主注入冒烟 | ❌ 不可达（如实记录） | §5 复现步骤；宿主侧执行（R-B3/R-6 口径） |

### 6.1 plugins 含 HEAD delta（06480ba）—— typecheck + 编译专项 ✅

06480ba 相对 promote T-091（7737161）**唯一源码变更 = plugins/src/index.ts（+194/-48，公共调解员 mode:mediator 机制）**。作为本片 R-B3 的真实 delta，专项重跑：
```
$ pnpm typecheck            （plugins/）→ exit 0，零诊断
$ tsc -p tsconfig.json      （全量编译）→ exit 0，lib/index.js 118780 B + lib/types/index.d.ts
```
结论：调解合并引入的 194 行新增在 typecheck/编译层全绿，无类型/构建回归。

### 6.2 plugins 单元测试（等价直跑形态；宿主可用 `pnpm test`=node --test tests/*.test.mjs）

- `node plugins/tests/worker-regression.test.mjs` → 4/7 通过；3 项失败中 2 项为 `spawnSync('git', ['init']) → EPERM`（测试内 initGitRepo 需真实 git 子进程，沙箱禁 pipe-spawn；宿主可跑），1 项见 §6.3。
- `node plugins/tests/slice-orchestration.test.mjs` → 5/6 通过；1 项失败同为 `initGitRepo → spawnSync git EPERM`（宿主可跑）。
- 归属：上述 3 项 git 相关失败 = 沙箱环境边界（R-18），非代码回归；已给复现命令（宿主侧 `pnpm test`）。plugins 测试不在本片验收必跑列（T-091 报告同口径：「需 spawnSync(git) 属沙箱 pipe 边界 + 宿主 daemon 上下文 → 宿主侧执行项」），此处为完整披露。

### 6.3 发现项（非本片回归，归属 plugins 测试预期滞后）：worker-regression 第 1 项断言漂移

- 现象：`a dependency-cleared blocked task is claimed before its worker can block again` FAIL —— 期望请求序列 `['claim:blocked','comment','transition:in_progress->blocked']`，实际多一次 `'comment'`（`['claim:blocked','comment','comment','transition:…']`）。
- 归属链（git blame + 对照实证）：
  1. 测试期望最后一次更新于 4921181（2026-09-01，「守护健壮性 D1-D7 + 测试防 flake」），当时 src 无派工即时评论；
  2. 6e01ef1（2026-09-04，feat「AI 派工即时可见」）在 plugins/src/index.ts:1251 新增 `🟢 已派 AI worker 开始执行…` 派工评论（claim 后、worker 返回前必然发一次）→ 请求序列变为两处 comment；
  3. **测试文件未随 6e01ef1 同步更新期望** → 断言漂移。
- 实证：以父提交 7737161（promote T-091，早于 06480ba）源码编译的 lib 运行同一测试 → **同样 FAIL**（与 HEAD 表现一致）；以主仓库（D:/project/DSH/legion/plugins，宿主侧编译产物）lib 运行 → **同样 FAIL**。即该漂移**先于 06480ba 存在，与本片合并 delta、三中心源码均无关**；HEAD 06480ba 的调解合并未引入此漂移。
- 复现：`cd plugins && tsc -p tsconfig.json && node plugins/tests/worker-regression.test.mjs`（宿主 `pnpm test` 同）。
- 修复建议（不在本任务文件域，只报不改）：worker-regression.test.mjs 第 1 项期望序列补入派工评论的 'comment'（或断言放宽为 claim:blocked → ≥1 comment → transition），由 plugins 测试维护方处理。

---

## 7. 环境受限项汇总（R-18 口径，均含复现步骤，无一冒充通过）

| # | 受限项 | 复现步骤 | 等价/缓解证据 |
| --- | --- | --- | --- |
| ① | node:test runner 子进程隔离 spawn EPERM（`node --test` 全形态） | `node --test team-hub/skills.test.mjs` → `Error: spawn EPERM` exit 1 | 仓库既定 `node <file>` 直跑等价（TEST_CASES.md §0），各套件全绿（§2） |
| ② | workbench `dist/` 缺失 → chat-s2 S2-A「GET / → 200 html」fetch failed（serve.mjs ROOT=workbench/dist） | 起 serve.mjs 后 GET /（无 dist 即无托管产物）；`node workbench/scripts/chat-s2-smoke.mjs` → S2-A 仅此 1 项 FAIL，其余 8 项 PASS | dist 需宿主 `pnpm build` 产物（§3 vite EPERM）；T-047 同探测在有 dist 的 worktree 为 9/9 |
| ③ | vite/esbuild spawn EPERM（pnpm build） | `cd workbench && pnpm build` → esbuild ensureServiceRunning EPERM exit 1 | tsc --noEmit 0 诊断 exit 0；T-047/T-083/T-091 同因记录 |
| ④ | e2e / plugins 子进程 pipe stdio 与 spawnSync EPERM | 原样 `node whiteboard/apps/server/test/e2e.test.mjs`（spawn pipe）→ EPERM；plugins 测试 spawnSync git → EPERM | e2e：stdio 改 ignore 的等价副本 6/6 全过（断言零改动）；plugins 测试宿主侧可跑（pnpm test） |
| ⑤ | WSL bash E_ACCESSDENIED（build.sh 直跑） | `bash scripts/build.sh` → CreateInstance E_ACCESSDENIED exit 1 | 以 build.sh 等价的 tsc/tsdown 步骤全绿（§5/§6.1） |
| ⑥ | DSH 宿主注入不可达（board-plugin/plugins 注入冒烟） | 见 §5 复现步骤（宿主侧） | 客户端 bundle 注入形态静态核验（`__ModuleLoader__.load` + exports apply/inject） |

---

## 8. 可复跑命令清单（均在 worktree 根或标注目录执行）

```bash
# L0 套件（node:test 进程内直跑 = 沙箱等价形态；宿主可改用 node --test <file>）
node workbench/scripts/files-api.test.mjs      # 40/40
node workbench/scripts/web.test.mjs            # 24/24
node team-hub/chat.test.mjs                    # 13/13
node team-hub/skills.test.mjs                  # 12/12
node team-hub/calendar.test.mjs                # 13/13
node tests/contract/contracts.test.mjs         # 56/56
node whiteboard/packages/shared/test/contract.test.mjs   # 26/26（whiteboard 其余 5 文件同理直跑；e2e 见 §2.7 等价形态）

# L1 真实进程冒烟（stdio-ignore 形态，沙箱允许）
node team-hub/chat-l1-smoke.mjs                # 22/22
node workbench/scripts/chat-s2-smoke.mjs       # 8/9（S2-A 依赖 dist，见 §7-②）
node workbench/scripts/files-s5-smoke.mjs      # 32/32

# 前端类型/构建
cd workbench && pnpm exec tsc --noEmit         # exit 0 零诊断
cd workbench && pnpm build                     # vite 段 EPERM（§3 记录）

# 白板起服冒烟（DEPLOY.md；DB_PATH=:memory: 免落库文件）
cd whiteboard && node apps/server/src/index.js # → /healthz {"ok":true,…}；GET / 200 html；/js/main.mjs 200

# board-plugin / plugins（build.sh 等价）
cd board-plugin && pnpm typecheck && pnpm exec tsc -p tsconfig.json && pnpm build:client   # 全绿
cd plugins && pnpm typecheck && pnpm exec tsc -p tsconfig.json                             # 全绿（含 06480ba delta）
```

---

## 9. 结论

- 验收①逐套件真实运行（HEAD=06480ba）：files-api 40/40、web 24/24、chat 13/13、skills 12/12、calendar 13/13、contracts 56/56、whiteboard 67 项 0 失败（等价形态），**七套件失败=0**，用例数逐套记录见 §2。
- 验收② pnpm build：tsc 0 诊断 + vite EPERM 受限复现（R-18），与仓库历史记录同因，未冒充通过。
- 验收③三中心主路径：数据面（L0+L1）与渲染安全（静态行级证据）全绿并写入本报告 §4；GUI 点击项在 §4.4 给出供宿主 L2 走查。
- 验收④⑤ board-plugin：typecheck/build（服务端 lib/ + 客户端注入形态 bundle）全绿；宿主注入冒烟不可达 → 按 R-18 记录「环境受限 + 复现步骤」，不冒充通过。
- R-B3 delta 专项：06480ba 调解合并（plugins/src/index.ts +194/-48）typecheck/编译全绿；plugins 单元测试在沙箱的 git-spawn 类失败为 R-18 边界（宿主可跑），另披露 1 项**先于 06480ba 存在**的测试期望漂移（§6.3，归属 6e01ef1 派工评论特性未同步更新测试，非本片源码回归）。
- 回归范围与结论：S8 三中心收口（R-A7：对话/文件/浏览器主路径、实时/断线/纯文本/403/confirm/SSRF 文案）与存量回归（R-B3：whiteboard/contracts/board-plugin/plugins）在本合并 HEAD 上锚定完成；**被测模块未发现本片新增回归**。唯一非环境失败项（plugins worker-regression 第 1 项）为存量测试期望滞后，已给归属与复现，建议由 plugins 测试维护方修复（本任务只测不修，未代改）。本任务仅改动 docs/TEST_REPORT.md 一个文件（git status 核实，无 push）。
