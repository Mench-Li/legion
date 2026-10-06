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
| 文件中心 | GET /api/files/{list,read,download}、PUT /api/files/upload、POST /api/files/{mkdir,rename,delete} | workbench serve.mjs :5173 | 仅回环；写需 --token/DSH_WORKBENCH_TOKEN；越界/嵌套 .git 任意层段 + realpath 复检 → 403；覆盖 overwrite=1；删除 confirm=yes |
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
| whiteboard | `node apps/server/src/index.js`（或 Docker） | 8080 | DB_PATH + WB_ROOMS_DIR（每房间一个 `<id>.db`） | 白板协作（独立子项目，多房间与治理见 whiteboard/docs/DEPLOY.md、ADR-0008） |

### 2.3 关键配置（环境变量 / 参数）

> **P3-2 起，配置面已统一并有权威参考：`docs/CONFIG.md`**（三进程全部字段、优先级 **CLI > env > 默认值**、
> 启动脱敏摘要、校验命令与跨进程一致性规则）。下表只列部署时最关键的几项，字段全集请看 CONFIG.md。
>
> 部署前后建议各跑一次配置自检（不依赖服务已启动）：
>
> ```bash
> node scripts/config/check.mjs                 # 按当前环境校验三进程 + 跨进程一致性
> node scripts/config/check.mjs --show-source   # 每个值标明来自 cli / env / default
> ```

| 配置 | 载体 | 默认 | 说明 |
| --- | --- | --- | --- |
| TEAM_HUB_PORT / TEAM_HUB_HOST / TEAM_HUB_DB / TEAM_HUB_TOKEN | env（也可 `--port/--host/--token`） | 8787 / 127.0.0.1 / team-hub/team.db / 空 | 中枢；非回环监听必须设置 token |
| DSH_WORKBENCH_PORT/HOST、--token、DSH_HUB_UPSTREAM | args/env | 5173 / 127.0.0.1 / 无 token / http://127.0.0.1:8787 | 指挥台；**DSH_HUB_UPSTREAM 端口必须等于 TEAM_HUB_PORT**，否则 `/hub/*` 代理连不上（`check.mjs` 会拦） |
| DSH_WEB_FETCH_ALLOW_PRIVATE | env | 关 | 仅测试/本地演示开；生产默认关闭（SSRF 防护） |
| DSH_WEB_AUDIT_FILE / DSH_WEB_AUDIT_MAX_BYTES | env | workbench/data/web-audit.jsonl | 浏览器抓取审计路径/轮转上限 |
| DSH_KANBAN_PORT/HOST/TOKEN、--token | args/env | 4820 / 127.0.0.1 / 空 | v1 遗留 |
| whiteboard | env（也可 `--port/--host/--token`） | PORT 8080 / HOST 127.0.0.1 / DB_PATH / WHITEBOARD_TOKEN | 非回环监听必须设置 WHITEBOARD_TOKEN；见 whiteboard/docs/DEPLOY.md |
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
| 数据回滚（team.db） | 用备份还原：停 hub → **删除目标目录的 team.db-wal / team.db-shm** → 替换 team-hub/team.db → 重启 | 表结构只增不改：新代码在老库自动建表/补列（幂等），回滚旧代码时新表闲置互不破坏。**必须先删 -wal/-shm**，原因见 §6.1。★ 这句话 2026-09-21 起有实验支撑：`scripts/prt/backup-restore-cross-version.test.mjs`（CI 套件 `prt-xver`）逐向验过——但"老代码读新库"那一向是**结构性 + 执行老 SQL**，不是真的跑了那一版进程，别读成端到端 |
| 进程故障（services-plugin 托管） | 无需人工：托管自愈重启（闪退退避 ≤30s）；手动部署则重启对应进程 | .legion-services.log 记录退出码与重启 |
| 端口被占 | 结束占用进程或用独立端口（TEAM_HUB_PORT / --port）起服 | services-plugin 探测到占用即跳过该服务 |

备份建议：每次升级前 `Copy-Item team-hub\team.db* <备份目录>\`；发布物快照（releases/legion-<head>-<date>/）
含 dist 与 SHA256SUMS，可校验文件完整性（Get-FileHash 比对）。

> `team.db*` 通配**包含** `-wal` 与 `-shm`，这是必须的——见 §6.1。

### 6.1 备份与恢复的三个实测要点（PRT-006）

**① 只复制 `team.db` 会静默丢数据。** WAL 模式下已提交的数据可能仍只在 `-wal` 里。
实测现场库：只复制 `.db` 的副本比真实状态**少了 253 条 audit 记录**
（9984 → 9731），而副本自身 `integrity_check` 报 **ok**——
**没有任何报错**，备份看起来完全正常。所以 `team.db*` 的通配不能省。

**② 恢复时必须先删掉目标目录的 `-wal` / `-shm`。** 实测：把 A 时点的 `.db`
与 B 时点的 `-wal` 放在一起，SQLite **会重放 B 的页到 A 的库上**，
而结果库的 `integrity_check` 依然报 **ok**。也就是说这个错误
**无法靠完整性校验发现**，只能在操作上避免：

```
停 hub
Remove-Item team-hub\team.db-wal, team-hub\team.db-shm -ErrorAction SilentlyContinue
Copy-Item <备份>\team.db team-hub\team.db
重启 hub
```

**③ 备份推荐用 `VACUUM INTO` 而不是文件复制**（无需停服、只需读权限）：

```powershell
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('team-hub/team.db',{readOnly:true});d.exec(`VACUUM INTO '<备份目录>/team.db'`);d.close()"
```

它由 SQLite 自身产出**一致快照**，单文件即可恢复，不依赖 `-wal`。
逐文件复制天然跨越多个时点（连做两次三件套复制在源库写入时会得到不同状态），
因此文件复制**只应在停 hub 后**进行。

验证（只读源库，全部在临时副本上做，不触碰现场文件）：

```powershell
node scripts\prt\backup-restore-verify.mjs                        # 用现场库
node scripts\prt\backup-restore-verify.mjs --source=<路径>        # 指定库
```

它逐条核对上面三点，并对照逐表行数与 `audit.seq` 上界。
**注意 `audit.seq` 允许有缺口**：分配器是 `MAX(seq)+1`（回滚后作废号不回填），
现场库实测就有 1 个缺口，这**不是**缺陷。验收口径是「恢复前后缺口集合一致」。

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

## 10. T-193 发布说明：`test` 阶段契约/端到端 9 套件归零（含 CI 契约登记面修复）

> 角色：devops（部署运维员）｜任务：T-193｜分支：`w/T-193`
> 开工基线（实测）：`git log --oneline -1` = **`6d9c9a9c  promote T-192`**；`w/T-193` 与 `main` 同点（`git diff main...w/T-193` 为空）。
> 环境：本机 dev / acceptance（127.0.0.1）。**未发布生产**（未获将军批准）。

### 10.1 结论速览

| 项 | 结论 |
| --- | --- |
| 9 套件（w/T-193 @ `6d9c9a9c`，逐文件 `node <file>`） | 8 组 exit 0 全绿；`secret-store` 组 52 例中 48 pass / **2 fail（沙箱 named-pipe EPERM）** / 2 skip —— 2 条失败为真·跨进程用例，已用 pwsh 真跨进程手工复现其断言全过（§10.5） |
| 产品/业务代码 | **未改一行**。本次 diff 仅：CI 契约登记面（`scripts/prt/baseline-snapshot.mjs`）+ 生成的契约基线（`docs/superpowers/prt/prt-007-baseline.json`）+ 本文档 |
| 用户可见行为 | 无（纯 CI/契约面）⇒ 功能手册 FEATURES.md / 功能索引 / README 引导段**豁免**（§10.8） |
| 构建 | `run-ci --only test` 在本会话沙箱内被 `spawn EPERM` 挡住（§10.5），非门禁失败；普通终端命令见 §10.3 |
| 相邻红（不在本任务 9 条内） | `team-hub/run-routes.test.mjs` 8/30，如实登记未代改（§10.7） |

### 10.2 变更内容、根因与「改产品还是改判据」

本次唯一实质性修复 = **`model-api` ③**（9 条里唯一真红的产品/契约读数）。

- 原始读数（w/T-193 @ `6d9c9a9c`，修前）：`model-api` **14 pass / 1 fail**，红在
  `✖ api.ts 里用到的每个 /api/ 路径都能在源码抽出的路由表里找到`
  ⇒ `actual: ['POST /api/events/ticket']`、`expected: []`。
- 该路径**真实存在且已挂载**：`team-hub/routes/identity.mjs:219`（`{ method:'POST', path:'/api/events/ticket' }`），
  并由 `team-hub/server.mjs:7828` 的 `router.families.unshift(createIdentityRoutes({...}))` 挂上。
- 根因：平台契约的**唯一权威** `platformHttpRoutes()`（`scripts/prt/baseline-snapshot.mjs:659`）
  只从 `createRouter([...])` 与 `ROUTE_FAMILY_SOURCES` 取路由；identity 族走的是**延迟装配**
  （`router.families.unshift`），既不在 `ROUTE_FAMILY_SOURCES` 里，也没被 `assertRouteFamilyCoverage()`
  扫到 ⇒ 该族 27 条 `/api/` 路由对平台契约**不可见**。这与 `docs/superpowers/prt/PRT-116-test-stage-red-suites.md` §3
  记的是同一形状：**判据没坏，它量的那个集合塌了**。
  该族由远程 Agent 合并 `6d7c28ea`（`88e0b124 feat(remote)`）引入，**晚于** T-191 的验证树 `88c7c21c`。
- 处置（**改观测点，不改断言**）：`scripts/prt/baseline-snapshot.mjs`
  1. `SOURCES.routesIdentity` + `ROUTE_FAMILY_SOURCES` 登记 identity 族；
  2. `assertRouteFamilyCoverage()` 现在**两种装配写法都认**（`createRouter([...])` 与
     `router.families.unshift(createXxxRoutes(`），并对无 `/api/` 路由的静态族
     （`createMobileRoutes`/`createPortalRoutes`/`createReleaseRoutes`）**显式豁免**；
  3. **顺带修好同一次合并留下的另一半**：`team-hub/user-store.mjs` / `team-hub/device-store.mjs`
     建了 11 张 `hub_*` 表却没登记 schema 采集面，`buildSnapshot()` 会直接抛「未登记」⇒ `prt-baseline` ④ 红。
     补登记后 `--diff` 无漂移。
- 基线刷新：`node scripts/prt/baseline-snapshot.mjs --record`（**271 路由 / 94 表**；原 244 / 83，+27 路由 +11 表）。
  这是**生成的契约产物**刷新（PRT-116 §2 的 A 类：判据对、产物旧），不是把断言改成 actual。
- 断言未放宽：`model-api` 仍 15 例（含 ③ 那条 `deepEqual(..., [])`），`prt-baseline` 仍 26 例；
  没有新增 skip/only、没有删除断言、`expected` 未改。

### 10.3 环境 × 步骤 × 验证项 × 回滚

环境：dev / acceptance（本机 127.0.0.1 三件套）。**production 未授权，未发布**。

**发布/验证步骤（普通终端）**

```powershell
# 0) 预检（gate）：不通过则终止，禁止跳过
node scripts/ci/run-ci.mjs --only env,deps,build     # 环境 + 依赖 + 构建
# 1) 本次范围门禁：test 阶段（含 9 套件与 prt-baseline）
node scripts/ci/run-ci.mjs --only test
# 2) 单独复跑本任务 9 套件（逐文件；与 CI 的 per-file 进程隔离等价）
node --test workbench/scripts/model-api.test.mjs
node --test orchestrator/worker/can-read-authorization-source.test.mjs
node --test runtime/dsh-composition/e2e-assembly.test.mjs
node --test runtime/dsh-composition/employee-preset.test.mjs runtime/dsh-composition/employee-preset-mount-dsh-process.test.mjs
node --test security/secrets/secrets.test.mjs security/secrets/run-credentials.test.mjs security/secrets/credential-materializer.test.mjs
node --test team-hub/acceptance-routes.test.mjs
node --test team-hub/handoff-routes.test.mjs
node --test team-hub/run-events.test.mjs
# 3) 契约基线（本次改动面）
node scripts/prt/baseline-snapshot.mjs --diff          # 期望：无漂移，exit 0
```

**验证项（本次实测，w/T-193 @ `6d9c9a9c`）**

| # | 套件 | 修前（任务原始读数 / 实测） | 修后（本次实测） |
| --- | --- | --- | --- |
| 1 | model-api | 14 pass / 1 fail | **15/15, exit 0** |
| 2 | can-read | 5/3（历史） | **8/8, exit 0** |
| 3 | e2e-assembly | 17/2（历史） | **19/19, exit 0** |
| 4 | employee-preset | 34/1（历史，另有 6 skip） | **42 例 36 pass / 0 fail / 6 skip, exit 0**（6 skip = 本机检出未构建 `packages/preset/agent-presets/lib`，逐条具名跳过） |
| 5 | secret-store | 50/1（历史） | **52 例 48 pass / 2 fail（沙箱 EPERM）/ 2 skip**；2 条断言已 pwsh 手工复现通过（§10.5） |
| 6 | route-family（32 文件） | 507/2 | **510/510, exit 0** |
| 7 | acceptance-routes | 3/7 | **10/10, exit 0** |
| 8 | handoff-routes | 3/5 | **8/8, exit 0** |
| 9 | run-events | 14/4 | **18/18, exit 0** |
| + | prt-baseline（受本次改动直接影响） | 修前因未登记而抛错 | **26/26, exit 0** |
| + | 契约面相邻：probe-service 13/13 · model-config 18/18 · secret-routes 26/26 | — | 全 exit 0 |

**回滚方案**（本次改动**不触库、不触进程、不需重启**）

| 场景 | 操作 |
| --- | --- |
| 契约面回滚 | `git revert <本次 commit>`（或 checkout 上一版 `scripts/prt/baseline-snapshot.mjs` + `docs/superpowers/prt/prt-007-baseline.json`），随后 `node scripts/prt/baseline-snapshot.mjs --diff` 应回到旧值（244 路由 / 83 表），且 `prt-baseline` ④ 会**重新变红**——这是有意的信号：identity 族又对契约不可见 |
| 数据/服务回滚 | **不需要**：无 schema/迁移、无前端产物、无服务行为变更（§6 的数据回滚模板不适用） |
| 触发条件 | `model-api` ③ 或 `prt-baseline` ④ 出现意外新漂移；或 identity 族被回退而登记面未同步 |

### 10.4 影响面

- 产品行为：**无变化**。`platformHttpRoutes()` 是 CI/契约工具，不在任何运行时路径上。
- 契约基线：`httpRoutes` 244→271、`dbTables` 83→94 —— 把「远程 Agent 通道真实存在的端点与表」**补进**契约，覆盖面变大而非放宽。
- 依赖：零新增依赖；零联网。
- 对其它套件：`prt-baseline` / `probe-service` / `model-config` / `secret-routes` / `model-api` 已复跑通过。

### 10.5 沙箱限制（如实标注，不冒充通过）

本会话沙箱拦截 Node 的**子进程 pipe 捕获**：`node scripts/ci/run-ci.mjs --only test` 实测报
`[test] exception: spawn EPERM`、`test FAIL`、exit 1（栈在 `scripts/ci/run-ci.mjs:73` 的 `spawn`）——
**环境限制，不是门禁失败**。等价证据：

- 9 套件改用**逐文件 `node <file>`**（等价于 CI 的 per-file 进程隔离）取得 §10.3 读数；
  3 个顺序敏感套件**单跑 ×3 + 串行同 shell** 全绿（§10.6）。
- `secret-store` 的 2 条真·跨进程用例（`security/secrets/secrets.test.mjs:371/400`）在测试进程内
  `execFileSync`/`spawnSync` 被 EPERM；用 pwsh 起**两个真 node 进程**手工复现：
  持锁进程下写入 `OUTCOME=SECRET_STORE_LOCK_TIMEOUT` 且库/锁文件均未变；
  无争用时两次写入均 `OUTCOME=wrote`、两条记录都在、无锁残留 —— 断言全过。
- 普通终端复跑：`node scripts/ci/run-ci.mjs --only test`（本机 DSH 检出已构建，候选路径可解析）应 9 条全 exit 0。

- 同一沙箱也拦截 `git add`/`git commit`：`Unable to create ...\.git\worktrees\T-193\index.lock: Permission denied`（`.git` 在工作区之外）⇒ 本任务改动**留在 `w/T-193` 工作树**（3 个 M 文件），由将军验收时 promote；普通终端提交：`git add docs/DEPLOY.md docs/superpowers/prt/prt-007-baseline.json scripts/prt/baseline-snapshot.mjs` → `git commit`。
### 10.6 顺序敏感 3 套件：为什么单跑绿、串行也绿

`acceptance-routes` / `handoff-routes` / `run-events` 各自 `mkdtemp` 独立库 + `listen(0)` 临时端口。
CI 的 `node --test` 默认按**文件**隔离进程（`run-ci` 也是逐套件起进程），所以三者互不可见。

- 单跑 ×3：acceptance 10/10、handoff 8/8、run-events 18/18，三轮完全一致。
- 串行（同一 shell 依次）：3/3 exit 0、fail=0。
- **为什么两棵树曾计数不同**：把三者塞进**同一进程**（`--test-isolation=none`）时，
  `team-hub/server.mjs` 的模块级单例被复用、`listen` 落到已监听的 server、且三者共用同一份
  `TEAM_HUB_DB`/预约状态 ⇒ 实测 36 例 31 pass / 5 fail（红在 run-events ⑬⑭⑮⑯⑱）。
  这是**量具/进程模型的产物**，不是产品行为：生产里 hub 是**一个长期进程**，不存在
  「三个测试文件各自 import 同一个 hub」。

### 10.7 相邻红（不在本任务 9 条内，如实登记、未代改）

`team-hub/run-routes.test.mjs`（登记在 `scripts/ci/run-ci.mjs:2383` 的运行面套件里）实测 **8 pass / 22 fail**。
首条红 `TypeError: Cannot read properties of null (reading 'attemptId')`（:113）——
夹具 `insertTask()`（:55-59）用**裸 SQL** 插入任务且未申报 `fileDomain`，而上一条用例认领后
写入预约跨 `in_review` 活跃 ⇒ 下一次 `claim` 以 `FILE_CONTENTION` 返回 `claimed:null`。
与 T-178 已修的 acceptance/handoff/run-events **同一形状**（见 §10.2 引的 PRT-116 与 BUG-007/认领预约）。
它**不在本任务 9 条目标内**，且修它属夹具/认领预约线（coder/tester），本角色**未代改**，仅登记。

### 10.8 文档同步判定

本次 diff = CI 契约登记面 + 生成的契约基线 + 本发布说明，**无用户可见行为变更** ⇒
按验收口径「纯重构可豁免」，**不**改 `docs/FEATURES.md` 对应小节 / 功能索引 / README 引导段。
（`check-docs.mjs` 的结构/链接/索引一致性可由 `run-ci --only doc` 复跑。）

---

## 附录 A：发布检查单（每次发布逐项打勾）

- [ ] CI 全绿：`node scripts/ci/run-ci.mjs` exit 0（evidence 归档 docs/T093-evidence/）
- [ ] L1 三件套探活 + whiteboard /healthz（§5.2/§5.4）
- [ ] L2 浏览器主路径走查并回填（§5.3）
- [ ] team.db 备份完成（§6；推荐 `VACUUM INTO`，见 §6.1）
- [ ] 备份可恢复性核对完成：`node scripts\prt\backup-restore-verify.mjs --source=<备份或现场库>`（§6.1）
- [ ] 已知缺陷状态确认（§7.1：当前无未修复 P0/P1；§7.2 记录项知悉）
- [ ] 发布记录登记（§4.4 模板）+ 快照 MANIFEST 留档

## 附录 B：关联文档

- docs/TEST_REPORT.md（T-091 S8 集成回归锚定，七套件逐条结果）
- docs/REQUIREMENTS.md（T-073 需求与盘点）· docs/RESEARCH.md（方案）· docs/TASK_BREAKDOWN.md（拆解/切片）
- docs/TEST_CASES.md（用例/浏览器清单）· docs/P1-LIVE-ROLLOUT.md（P1 现场验收 runbook）
- whiteboard/docs/DEPLOY.md（whiteboard 独立部署）· 根 README.md（快速开始/功能指南）
- docs/T093-evidence/（本阶段构建/CI 证据）
