# Legion 目标级发布说明（DEPLOY / CI）— T-093 部署与 CI/CD

> 角色：devops（部署运维员）｜任务：T-093（目标级收尾 · 发布部署）｜分支：w/T-093（HEAD = **06480ba**，与 main 同步）
> 上游：本目标切片链全部 promote 合入 main —— T-077(S1)/T-079(S2)/T-081(S3)/T-083(S4)/T-085(S5)/T-087(S6)/T-089(S7)/T-091(S8)+T-094 及各自 tester 任务（依赖 T-078..T-092 均已完成）
> 本文档 = 部署/发布清单（环境 × 步骤 × 验证 × 回滚）+ 变更影响 + 验证结果；配套统一发布门禁脚本 `scripts/ci/run-ci.mjs`（本阶段新增，收口自 w/T-043、w/T-063、w/T-064 各切片 devops 草案——均未合入 main，故在本目标级整合）。
> 产物证据目录：`docs/T093-evidence/`（ci-run-06480ba/ 全量日志 + summary.json + 各套件输出）。

---

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 构建 / CI | ✅ **真实跑通全绿**：`node scripts/ci/run-ci.mjs` 六阶段全 PASS，exit 0（env/deps/build/test/smoke/stage；命令输出见 §3.2 与 docs/T093-evidence/ci-run-06480ba/ci-output.txt） |
| 构建产物 | ✅ workbench `tsc --noEmit` 0 诊断 + `vite build` 617 modules → dist/（index.html + 3 assets）；whiteboard build PASS（9 共享模块 → 静态前端） |
| L0 测试 | ✅ 七套件 225 用例 0 失败：chat 13 · skills 12 · calendar 13 · files-api 40 · web 24 · contracts 56 · whiteboard 67（含真实服务 e2e 6） |
| L1 冒烟 | ✅ 真实进程：chat-l1 22/22、chat-s2 9/9、files-s5 32/32、whiteboard /healthz+GET / 200、v1 看板 auth=true |
| 部署范围 | dev / acceptance（本机 · 127.0.0.1 三件套 + whiteboard 自托管）；production 未获授权 → **本阶段不发布生产**（§2.1/§9） |
| 放行门禁 | 🔴 无未修复 P0/P1 阻塞项：历史 P0-1/P0-2/P0-3 与三中心缺陷（F1/F2/R-A3/R-A4/R-A5/A6）已在本目标切片链修复并被套件锚定（§7.1） |
| 环境受限项 | L2 GUI 手工走查、board-plugin/plugins 宿主注入冒烟本沙箱不可达 → 如实记录复现步骤（§5.3/§7.3/R-18），不冒充通过 |

---

## 1. 发布范围与变更影响

### 1.1 本次发布范围（本目标自 T-073 起的全部交付，均已合入 main；发布基线 = 06480ba）

| 域 | 内容 | 合入提交（代表） |
| --- | --- | --- |
| 三中心收尾（P0/P1） | S1 文件面嵌套 .git 防护 + 畸形路径防崩溃；S2 浏览器抓取审计留痕 + body stall 归类 timeout + WEB_ERR 枚举收口；S3 ChatView 会话/空间身份守卫；S4 BrowserView 收口（w/T-051 合入）；S8 集成回归锚定 | T-077/T-079/T-081/T-083/T-091/T-094 |
| 平台剩余（P1） | S5 日程日历后端（calendar_events 表 + /api/calendar/events）；S6 CalendarView 前端；S7 通知中心 NotifyView + 侧栏 badge + 已读游标 | T-085/T-086/T-087/T-089 |
| 编排支撑 | V3 切片编排（P1）已在前期合入（/api/goal/slices、/api/test-report、机器闸门、fix 回炉等） | 早于本批 |

### 1.2 变更影响（部署视角，逐面）

- **API 面（只增不删）**：

| 域 | 端点 | 宿主 | 边界 |
| --- | --- | --- | --- |
| 对话中心 | POST/GET /api/chat/conversations、POST/GET /api/chat/messages | team-hub :8787（前端经 serve.mjs /hub/* 代理） | scope 分区；写 by 必填 + author=by 防冒名；正文 ≤8000；审计 chat:* + SSE |
| 文件中心 | GET /api/files/list|read|download、PUT /api/files/upload、POST /api/files/mkdir|rename|delete | workbench serve.mjs :5173 | 仅回环；写需 --token/DSH_WORKBENCH_TOKEN；越界/嵌套 .git 任意层段 + realpath 复检 → 403；覆盖 overwrite=1；删除 confirm=yes |
| 浏览器助手 | POST /api/web/fetch | workbench serve.mjs :5173 | 仅回环；SSRF 逐跳防护（私网/回环/混淆/重定向链）；共享 deadline 整链超时；限长 2MiB；审计 web-audit.jsonl（静态 ROOT 之外，容量轮转） |
| 日程日历 | GET/POST /api/calendar/events、POST /api/calendar/events/delete | team-hub :8787 | scope 过滤 + 日期窗闭区间；写 by 必填；audit calendar:* + SSE |
| 通知 | 前端 NotifyView（由 /api/activity 审计派生） | workbench :5173 | 已读游标 localStorage per scope（R-15） |

- **数据影响**：team-hub SQLite 启动幂等建表/补列（conversations/messages/calendar_events + tasks 切片列），存量库无损升级（chat/calendar/skills 测试均含旧库迁移用例）；文件/抓取均不留服务端业务库，浏览器审计为 JSONL 追加文件。
- **前端影响**：workbench 构建产物 dist/ 变化（5173 非热更，部署后需 Ctrl+F5）；侧栏模块 chat/files/browser/calendar/notify 全部真实面板（占位收口完成）。
- **服务影响**：三件套启动方式/端口不变（services-plugin 托管不受影响，端口占用探测跳过）；v1 看板仅启停回归。
- **依赖**：**零新增运行时依赖**（全部 Node 内置 / 自研 / 既有）；Node ≥ 22.5（node:sqlite）。
- **回归**：L0 七套件 + L1 冒烟全绿（§3/§4），未发现本批引入回归。

---

## 2. 环境与拓扑

### 2.1 环境分级

| 环境 | 形态 | 用途 | 发布前提 |
| --- | --- | --- | --- |
| dev（本机开发） | 三件套 127.0.0.1 + 源码 | 开发自验 | 无 |
| acceptance（本机/局域网验收） | 三件套 + 构建产物（当前部署形态：services-plugin 随 DSH Desktop 托管） | 将军/验收人走查 | CI 全绿（§3） |
| production | 未定义 / 未授权 | — | 将军立项批准后按 §6/§8 执行（本阶段不发布） |

### 2.2 组件与端口

| 组件 | 进程/入口 | 默认端口 | 数据 | 三中心/平台落点 |
| --- | --- | --- | --- | --- |
| team-hub v2 | `node team-hub/server.mjs` | 8787（TEAM_HUB_PORT） | team-hub/team.db（SQLite WAL） | 对话/日程数据与 API + 审计/SSE |
| 军团指挥台 | `node workbench/scripts/serve.mjs --port 5173`（前置 `pnpm build`） | 5173 | 托管 workbench/dist；/hub/* 代理 :8787 | 三中心 + 日程/通知前端入口；文件/浏览器 API 宿主 |
| v1 看板（遗留） | `node scrum/serve.mjs --port 4820 --host 0.0.0.0 --token …` | 4820 | scrum/tasks.json + board.json(运行时) | —（仅启停回归） |
| whiteboard | `node apps/server/src/index.js`（或 Docker） | 8080 | DB_PATH（默认 apps/server/data/whiteboard.db） | 白板协作（独立子项目，见 whiteboard/docs/DEPLOY.md） |

### 2.3 关键配置（环境变量 / 参数）

| 配置 | 载体 | 默认 | 说明 |
| --- | --- | --- | --- |
| TEAM_HUB_PORT / TEAM_HUB_HOST / TEAM_HUB_DB / TEAM_HUB_TOKEN | env | 8787 / 0.0.0.0 / team-hub/team.db / 空 | 中枢；生产建议 HOST=127.0.0.1 + 设 token |
| DSH_WORKBENCH_PORT/HOST、--token、DSH_HUB_UPSTREAM | args/env | 5173 / 127.0.0.1 / 无 token / http://127.0.0.1:8787 | 指挥台 |
| DSH_WEB_FETCH_ALLOW_PRIVATE | env | 关 | 仅测试/本地演示开；生产默认关闭（SSRF 防护） |
| DSH_WEB_AUDIT_FILE / DSH_WEB_AUDIT_MAX_BYTES | env | workbench/data/web-audit.jsonl | 浏览器抓取审计路径/轮转上限 |
| DSH_KANBAN_PORT/HOST/TOKEN、--token | args/env | 4820 / 127.0.0.1 / 空 | v1 遗留 |
| whiteboard | env | PORT 8080 / HOST 0.0.0.0 / DB_PATH | 见 whiteboard/docs/DEPLOY.md |
安全不变量（三中心与平台既有）：/api/files/*、/api/web/fetch、/api/fs/* 仅回环地址可访问；写操作 token 鉴权
（未配置放行=仅回环保护）；SSRF 协议白名单 + 私网/回环/混淆逐跳拦截；嵌套/内嵌 .git 任意层段 + realpath 复检拒绝；
前端全部 React 文本节点渲染（无 dangerouslySetInnerHTML）；畸形 percent-encoding/超长/NUL 请求 400/404 且进程存活。

---

## 3. 构建与 CI 门禁（本阶段新增 `scripts/ci/run-ci.mjs`）

零第三方依赖（Node ≥ 22.5）。在普通终端或 run_code 宿主进程执行：

```bash
node scripts/ci/run-ci.mjs                              # 全量（env→deps→build→test→smoke→stage）
node scripts/ci/run-ci.mjs --only build,test            # 局部
node scripts/ci/run-ci.mjs --skip smoke                 # 跳过冒烟
node scripts/ci/run-ci.mjs --out docs/T093-evidence/ci-run-06480ba   # 指定证据输出（ci.log + summary.json）
```

| 阶段 | 内容（等价命令） | 通过标准 |
| --- | --- | --- |
| env | node 版本 / git head / platform | node ≥ 22.5 |
| deps | workbench/node_modules 就绪（缺失自动 junction → 主 checkout） | 依赖可解析 |
| build | whiteboard `node scripts/build.mjs`；workbench `tsc --noEmit && vite build`（= pnpm build） | 0 错误；dist/index.html 存在且引用 assets |
| test | node --test：chat 13 / skills 12 / calendar 13 / files-api 40 / web 24 / contracts 56 / whiteboard 67 | 全绿 0 失败 |
| smoke | L1：chat-l1 22 项、chat-s2 9 项、files-s5 32 项、whiteboard 真实进程 /healthz+GET /、v1 看板 auth=true | 全 PASS |
| stage | 发布物暂存 releases/legion-<gitHead>-<date>/（dist 快照 + MANIFEST.json + SHA256SUMS.txt，gitignore） | 产物完整 |

### 3.1 沙箱执行形态（R-18 先例，如实说明）

本任务沙箱的 pwsh 拦截「子进程 pipe 捕获」（spawn EPERM，R-18/§7.3 记录），故 CI 经 **run_code 宿主进程**
直跑（T-043 先例：`CI 通过 run_code 宿主进程执行（无该限制），命令与产物与普通终端完全一致`）。已实测确认：
node --test（runner 逐文件子进程隔离）、vite/esbuild、e2e 起真实服务在本宿主下**全部正常**（无 EPERM），
与普通终端等价；`node scripts/ci/run-ci.mjs` 在受限 pwsh 内直跑仍会 EPERM（环境限制，非门禁失败）。

### 3.2 本次实测结果（真实命令输出为证，全量见 docs/T093-evidence/ci-run-06480ba/ci-output.txt）

```text
$ node scripts/ci/run-ci.mjs --out docs/T093-evidence/ci-run-06480ba
Legion CI run: root=D:\project\DSH\legion\.legion-worktrees\T-093 node=24.19.0
stages: env -> deps -> build -> test -> smoke -> stage
===== [build] =====  whiteboard PASS（node scripts/build.mjs）；workbench PASS（tsc --noEmit && vite build）
  vite: 617 modules transformed. ✓ built in 5.12s
  dist/index.html(0.44kB) + assets/index-*.css(36.82kB) + assets/index-*.js(340.24kB) + assets/Scene3D-*.js(923.50kB)
===== [test] =====  chat 13/13 · skills 12/12 · calendar 13/13 · files-api 40/40 · web 24/24 · contracts 56/56 · whiteboard 67/67（exit 全 0）
===== [smoke] ===== chat-l1 22/22 · chat-s2 9/9（S2-A GET / 200，dist 就位后 9/9）· files-s5 32/32 ·
  whiteboard 真实进程 /healthz {"ok":true,"storage":"MemoryProvider"} + GET / 200 html(1832B) · v1 /api/config auth=true
===== [stage] ===== releases/legion-06480ba-2026-09-05/（MANIFEST.json + SHA256SUMS.txt + dist/ 快照）
===== SUMMARY =====  env PASS · deps PASS · build PASS · test PASS · smoke PASS · stage PASS → exit 0
```

---

## 4. 部署步骤（环境 × 步骤，含预检与验证）

> 预检（gate）：以下任意不通过 → 终止发布（【边界：不跳过构建 / 预检直接发布】）。

### 4.1 全新部署（fresh start）

前置：Node ≥ 22.5；workbench 依赖（cd workbench && pnpm install，禁网环境可 junction 主 checkout node_modules）。

```powershell
# 1) 构建（发布门禁）
node scripts\ci\run-ci.mjs --only deps,build        # 或全量 run-ci.mjs（§3）

# 2) 起三件套（a/b/c 三个终端，或交给 services-plugin 托管 —— 见 2.1/§4.3）
#    a) 中枢（必启）
node team-hub\server.mjs                              # http://127.0.0.1:8787（team.db 自动建表/补列）
#    b) 指挥台（主体，含三中心入口；5173 非热更）
cd workbench; node scripts\serve.mjs --port 5173 --token <写令牌可选>
#    c) （可选遗留）v1 看板
node scrum\serve.mjs --port 4820 --host 0.0.0.0 --token legion-kanban-4820
#    d) （可选）whiteboard
cd whiteboard; node apps\server\src\index.js        # http://127.0.0.1:8080（或 docker compose up --build）
```

验证：见 §5（至少 §5.1 L0 + §5.2 L1 分层探活 + 三中心主路径数据面）。

### 4.2 升级发布（从上一版本代码更新）

```powershell
# 1) 代码更新：验收 promote 后合入 main；部署机拉取/checkout 到发布 commit（本次 = 06480ba 或其后 promote）
git fetch origin && git checkout <release-tag-or-commit>
# 2) 重构建 + 重启（team.db 保留 —— 升级自动补建新表/补列，无需手工迁移脚本）
node scripts\ci\run-ci.mjs --only build
#    重启 team-hub 与 serve.mjs（结束旧进程后按 §4.1 步骤 2 重新拉起）
# 3) 按 §5 验证清单逐项核对，通过后登记发布记录（§4.4 模板）
```

### 4.3 services-plugin 托管（DSH Desktop 伴随启停，当前 acceptance 形态）

- services-plugin（`services-plugin/index.js`）把三件套托管进 DSH Desktop web profile：启动自动拉起
  team-hub :8787 / v1 :4820 / 指挥台 :5173，闪退自愈（退避上限 30s），Desktop 退出随插件回收；端口被占则跳过。
- 状态日志：`<legion根>/.legion-services.log`。
- ⚠ 前端改码后必须重新 `pnpm build`（5173 托管构建产物，非热更）；plugin 依赖 junction 重建按根 README §2.1.1。

### 4.4 发布记录模板（每次发布填写）

| 项 | 值 |
| --- | --- |
| 发布版本 / commit | legion-06480ba（MANIFEST.json） |
| 部署环境 | dev / acceptance / production |
| CI 证据 | docs/T093-evidence/ci-run-06480ba/（summary.json + ci-output.txt） |
| 验证项 | §5 清单逐条（L0/L1/L2 + 健康检查） |
| 已知缺陷 | §7.1（当前无未修复 P0/P1） |
| 回滚预案 | §6（触发即执行） |

---

## 5. 验证项清单

### 5.1 L0 自动化（每次发布必跑）— CI test 阶段

node --test 七套件 225 用例：team-hub/chat.test.mjs 13、team-hub/skills.test.mjs 12、team-hub/calendar.test.mjs 13、
workbench/scripts/files-api.test.mjs 40、workbench/scripts/web.test.mjs 24、tests/contract/contracts.test.mjs 56、
whiteboard 7 测试文件 67（61 单测 + 6 e2e 真实服务）→ 全绿 0 失败。

### 5.2 L1 服务级（每次发布必跑）— CI smoke 阶段 + 手工探活

| 验证项 | 命令 / 期望 |
| --- | --- |
| 中枢探活 | curl http://127.0.0.1:8787/api/config → {auth,db,port:8787} |
| 指挥台探活 | curl http://127.0.0.1:5173/ → 200 text/html 含 id="root"；curl http://127.0.0.1:5173/hub/api/config → hub 可达 |
| 对话冒烟 | 建会话→发消息→列表/审计/SSE 收到 chat:message（chat-l1 22/22 + chat-s2 9/9 已断言） |
| 文件冒烟 | list/read/download/upload/mkdir/rename/delete + 越界/.git 403 + 未绑定引导（files-s5 32/32 已断言） |
| 浏览器冒烟 | 抓本地 mock 成功 + 私网 ssrf_blocked（web.test 24/24 已断言；严格实例冒烟） |
| 日程冒烟 | POST /api/calendar/events → GET 日期窗命中 → delete（calendar.test 13/13 已断言） |
| whiteboard | curl http://127.0.0.1:8080/healthz → {"ok":true,…}（真实进程冒烟已断言） |
| v1 看板 | curl http://127.0.0.1:4820/api/config → auth 按 --token |

### 5.3 L2 浏览器手工验收（验收人/将军走查，需 GUI 浏览器；本沙箱无浏览器 → 复现步骤清单）

对话中心（新建会话→发送→第二标签同空间 ≤15s 实时→断线自动重连→纯文本渲染）；文件中心（绑定目录→浏览→预览→
上传→下载→未绑定引导→覆盖/删除二次确认）；浏览器助手（地址栏→抓取成功→私网 SSRF 拦截文案「🛡 已拦截：禁止访问
内网地址」→5 类错误文案互不相同→重试）；日程日历（月视图切换/新建入格/删除确认/切空间隔离）；通知中心（audit 派生
面板 + badge + 已读游标）。GUI 数据面已由 L0/L1 锚定，浏览器点击走查见 docs/TEST_CASES.md §7 / TEST_REPORT.md §4.4。

### 5.4 发布后健康巡检

```powershell
curl http://127.0.0.1:8787/api/config     # 中枢
curl -I http://127.0.0.1:5173/            # 指挥台
curl http://127.0.0.1:4820/api/config     # v1（如启用）
Get-Content .legion-services.log -Tail 30  # services-plugin 托管时查看启停/自愈记录
```

---

## 6. 回滚方案

| 场景 | 操作 | 备注 |
| --- | --- | --- |
| 代码回滚（发布后功能异常） | git checkout <上一发布 commit> → node scripts\ci\run-ci.mjs --only build → 重启三件套（§4.2 步骤 2/3） | 上一发布 commit = 本次 promote 前的 main 头 |
| 前端产物回滚 | 保留上一版 workbench/dist 快照（或 releases/ 上一快照）直接换回 → 重启 serve.mjs | 5173 非热更；无需动 DB |
| 数据回滚（team.db） | 用备份还原：停 hub → 替换 team-hub/team.db（含 -wal/-shm 同批）→ 重启 | 表结构只增不改：新代码在老库自动建表/补列（幂等），回滚旧代码时新表闲置互不破坏 |
| 进程故障（services-plugin 托管） | 无需人工：托管自愈重启（闪退退避 ≤30s）；手动部署则重启对应进程 | .legion-services.log 记录退出码与重启 |
| 端口被占 | 结束占用进程或用独立端口（TEAM_HUB_PORT / --port）起服 | services-plugin 探测到占用即跳过该服务 |

备份建议：每次升级前 `Copy-Item team-hub\team.db* <备份目录>\`；发布物快照（releases/legion-<head>-<date>/）
含 dist 与 SHA256SUMS，可校验文件完整性（Get-FileHash 比对）。

---

## 7. 发布说明与已知缺陷（放行门禁）

### 7.1 本版本发布说明与历史门禁状态

- 版本基线：06480ba（本目标切片链 promote 后 main）。发布范围 §1.1。
- 历史门禁项（w/T-043 DEPLOY 曾列 P0-1/P0-2/P0-3 放行门禁）**均已在本目标切片链修复并被套件锚定**：
  - P0-1 覆盖上传中断/超限破坏原文件 → 临时文件 + 收体完整原子改名发布（files-api.test.mjs 覆盖/并发上传用例断言）；
  - P0-2 下载整文件同步读内存 → openDownloadStream 流式返回（路由层下载不再整读，files-api.test.mjs 断言）；
  - P0-3 webFetch 超时非整链 → 共享 deadline 整链超时统一 code=timeout（web.test.mjs 24 例含 headers 未回/body stall 两类）；
  - 三中心 P0/P1 缺陷（F1 嵌套 .git 外泄、F2 畸形 % 崩溃、R-A3 抓取审计、R-A4 body stall 归类、R-A5 会话守卫、A6 前端收口）全部修复并回归锚定（TEST_REPORT.md）。
- 验证结果：构建/CI 全绿 + L0 七套件 225/225 + L1 冒烟全过（§3.2、docs/T093-evidence/）；未发现回归。
- 发布姿态：acceptance（本机/局域网自托管）。**未发布生产；未对公网开放**（production 需将军批准，§2.1/§9）。

### 7.2 已知缺陷 / 说明（本阶段未改实现，如实登记）

| 项 | 位置/性质 | 影响 | 处置 |
| --- | --- | --- | --- |
| CalendarView 旧入口遗留 | CommandBar.tsx:120 旧「日程/会议不在 legion 引擎内」快捷按钮 | 引导文案陈旧（面板已是真实日程） | 前端演进超出本任务文件域，如实记录不代改（TEST_REPORT.md §2.6 同述） |
| chat 读接口缺省全 scope（P1-3 旧项） | team-hub /api/chat/conversations 读缺省未限定 scope | 读取面较宽（scope 显式传入时严格隔离） | 沿用 T-041/T-042 记录口径；未在本批改动（会话隔离用例已锚定显式 scope 路径） |
| whiteboard 部署 | 单实例自托管（ADR-0005） | 不承诺横向扩展 | 见 whiteboard/docs/DEPLOY.md |
| board-plugin 宿主注入 | DSH Desktop 宿主侧 | 需宿主环境执行注入冒烟 | 复现步骤见 TEST_REPORT.md §5/§7-⑥（本沙箱不可达，R-18） |

### 7.3 环境受限项汇总（本阶段真实复现，未冒充通过）

| # | 受限项 | 复现步骤 | 等价/缓解证据 |
| --- | --- | --- | --- |
| ① | 受限 pwsh 拦截子进程 pipe 捕获（node --test / vite spawn EPERM） | 受限 shell 内 `node --test team-hub/skills.test.mjs` / `pnpm build` → spawn EPERM | run_code 宿主进程直跑全量 CI 全绿（§3.1/§3.2，命令与产物与普通终端一致） |
| ② | L2 GUI 浏览器手工走查不可达（本沙箱无浏览器） | 需宿主/验收人浏览器在 :5173 走查 | 数据面 L0+L1 全绿；GUI 步骤清单 §5.3 |
| ③ | board-plugin/plugins 宿主注入冒烟不可达 | 宿主侧按 TEST_REPORT.md §5 复现步骤 | 客户端 bundle 注入形态静态核验（__ModuleLoader__.load + exports apply/inject） |

---

## 8. 运维要点

- 日志：services-plugin → <legion根>/.legion-services.log；手动起服看各自终端；浏览器抓取审计 → workbench/data/web-audit.jsonl（容量轮转）；CI 证据 → docs/T093-evidence/ci-run-*/ci-output.txt。
- 数据：team-hub/team.db（WAL）。改动/新增表自动迁移；升级前备份见 §6。
- 端口：8787 / 5173 / 4820 / 8080（whiteboard 可选）（占用探测见 §6）。
- 常见故障：页面旧数据 → Ctrl+F5 强刷（5173 托管构建产物）；「🧭 中枢不可达」→ hub 未起；写操作 401 → token；浏览器助手私网拦截 → 属预期（§2.3）；v1 401 → --token。

---

## 9. 边界与未做项（诚实声明）

- ✅ 只做构建与部署类操作：新增 `scripts/ci/run-ci.mjs`（统一发布门禁）、本 DEPLOY 文档、docs/T093-evidence/ 证据、
  .gitignore 追加运行时产物条目（.ci/、releases/）；**未改任何业务功能代码**（git status 全程核实：仅上述文件 + 证据目录）。
- 🚫 未发布生产（未获将军授权；边界「未获批准不发布生产」）；发布物仅为本地暂存快照（releases/，gitignore）。
- 🚫 未跳过构建/预检：发布路径全部以 `node scripts/ci/run-ci.mjs` 全绿为前提（§3/§5 门禁）。
- ⛔ 环境受限项（不静默判过）：L2 GUI 手工（§5.3）、board-plugin/plugins 宿主注入（§7.3-③）——复现步骤已文档化，
  留待宿主环境或验收人执行。
- 禁网纪律：零新增依赖、零联网下载；workbench 依赖复用主 checkout node_modules（junction）。

---

## 附录 A：发布检查单（每次发布逐项打勾）

- [ ] CI 全绿：`node scripts/ci/run-ci.mjs` exit 0（evidence 归档 docs/T093-evidence/）
- [ ] L1 三件套探活 + whiteboard /healthz（§5.2/§5.4）
- [ ] L2 浏览器主路径走查并回填（§5.3）
- [ ] team.db 备份完成（§6）
- [ ] 已知缺陷状态确认（§7.1：当前无未修复 P0/P1；§7.2 记录项知悉）
- [ ] 发布记录登记（§4.4 模板）+ 快照 MANIFEST 留档

## 附录 B：关联文档

- docs/TEST_REPORT.md（T-091 S8 集成回归锚定，七套件逐条结果）
- docs/REQUIREMENTS.md（T-073 需求与盘点）· docs/RESEARCH.md（方案）· docs/TASK_BREAKDOWN.md（拆解/切片）
- docs/TEST_CASES.md（用例/浏览器清单）· docs/P1-LIVE-ROLLOUT.md（P1 现场验收 runbook）
- whiteboard/docs/DEPLOY.md（whiteboard 独立部署）· 根 README.md（快速开始/功能指南）
- docs/T093-evidence/（本阶段构建/CI 证据）
