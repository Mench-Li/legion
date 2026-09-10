<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `0a58ecb`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-126 部署与发布说明（DEPLOY.md）—— 对话中心「可回答闭环 + 上下文输入（关联工作空间 / 上传文件）」

> 阶段：部署与 CI/CD（devops）｜执行任务：T-126（[auto-goal]｜所属目标 G-mtr3su6f-1 · software · chain）
> 上游依据（本目标文档目录 docs/G-mtr3su6f-1/，只认本目录版本）：T-119 REQUIREMENTS.md → T-120 RESEARCH.md → T-121 TASK_BREAKDOWN.md（S1~S9）→ T-122 TEST_CASES.md → T-123 coder 实现（77ce2c2）→ T-124 REVIEW（docs/review/T-124-REVIEW.md）→ T-125 TEST_REPORT.md（≈356 项自动化回归 + M1/M2 缺陷复现）
> 被部署批次：T-123 coder 提交 **77ce2c2**（基线 3757151，18 文件 +2049/-53，S1~S9）→ promote T-123/T-124/T-125 到达部署 HEAD **dabf18f**；与 T-125 实测 HEAD d9adffb 之间仅 docs 差异（git diff --name-only d9adffb dabf18f 无 src 变更），故 T-125 全套件结果对部署 HEAD 有效。
> 本文档落点：docs/G-mtr3su6f-1/DEPLOY.md（目标级部署/发布清单；不写、不碰仓库根 docs/DEPLOY.md 槽位与其他目标目录）
> 证据目录：docs/G-mtr3su6f-1/T126-evidence/（ci-run-dabf18f/ci-output.txt + summary.json + verify-evidence.md）

---

## 0. 结论速览（TL;DR）

| 项 | 结论 |
| --- | --- |
| 构建 / CI | ✅ **真实跑通全绿**：`node scripts/ci/run-ci.mjs --out docs/G-mtr3su6f-1/T126-evidence/ci-run-dabf18f` → 7 阶段全 PASS、**exit 0**（env/deps/build/test/smoke/stage/doc；命令输出见 §3 与证据 ci-output.txt） |
| 构建产物 | ✅ whiteboard build PASS；workbench `tsc --noEmit` 0 诊断 + `vite build` **621 modules** ✓ built in 10.37s → dist/index.html + 3 assets（index-*.css 64.46kB / index-*.js 419.51kB / Scene3D-*.js 923.50kB） |
| L0 测试 | ✅ 七套件 **261 用例 0 失败**：chat 41 · skills 20 · calendar 13 · files-api 40 · web 24 · contracts 56 · whiteboard 67 |
| L1 冒烟 | ✅ 真实进程：chat-l1 **35/35**、chat-s2 **9/9**、files-s5 **32/32**、whiteboard /healthz + GET / 200、v1 看板 auth=true（子进程已回收） |
| 文档门禁 | ✅ check-docs.mjs **8 类全绿 exit 0**（README + docs/FEATURES.md 结构/链接/索引一致；docSync 同步面在 T-123 S9 已合入本 HEAD，本阶段复核通过） |
| 发布物暂存 | ✅ releases/legion-dabf18f-2026-09-08/（MANIFEST.json + SHA256SUMS.txt + dist 快照；gitignored 不入库） |
| 部署范围 | dev / acceptance（本机三件套 + DSH 宿主守护）；**production 未获授权 → 本阶段不发布生产**（§9 边界） |
| 放行门禁 | 🔴 **有 2 项未修复中危缺陷 M1/M2（健康端点行为，归属 T-123 coder 修复轮）**：自动化回归全绿但 T-125 隔离 hub 行为级复现 M1（跨 scope 心跳假绿/模型泄漏）、M2（lastFail 恒红）。修复前不建议生产放行；acceptance 走查按 §5.2 口径进行（详见 §7.2） |
| 受限项 | 真实 LLM 出站闭环（守护 answerChatMessage 依赖 DSH 宿主运行时）与浏览器级 GUI 渲染本沙箱不可达 → 按 §5.3 宿主部署后冒烟清单承接 |

---

## 1. 发布范围与变更影响

### 1.1 本次发布范围（本目标交付批 = T-123 77ce2c2，S1~S9 全部文件域）

| 切片 | 内容 | 主要文件（部署关注） |
| --- | --- | --- |
| S1 | 执行层失败可行动化（五类错误分类器 + 可行动文案回写） | plugins/src/chatErrorClassifier.ts（新）、plugins/src/index.ts、plugins/tests/chat-error-classifier.test.mjs |
| S2 | 对话健康端点 GET /api/chat/health + 守护心跳上报 + 最近失败透出 | team-hub/server.mjs、plugins/src/index.ts、team-hub/chat.test.mjs |
| S3 | 附件数据面（chat_attachments 表 + 上传/取回/清理端点 + 服务端护栏） | team-hub/server.mjs、team-hub/chat.test.mjs |
| S4 | 空间摘要纯模块 buildSpaceDigest（绑定仓库只读摘要） | plugins/src/spaceDigest.ts（新）、plugins/tests/space-digest.test.mjs |
| S5 | 提示词构建器扩展（摘要/附件上下文块 + 预算截断 + 降级占位） | plugins/src/chatResponder.ts、plugins/tests/chat-responder.test.mjs |
| S6 | 守护上下文接线（answerChatMessage 注入摘要/附件） | plugins/src/index.ts |
| S7 | UI 前置：全部空间选空间入口 + 健康状态条 + 回复设置弹窗 | workbench/src/components/ChatView.tsx、App.tsx、api.ts |
| S8 | UI 附件行：📎 选择/预检/移除 + 消息附件标识 | workbench/src/components/ChatView.tsx、api.ts、types.ts |
| S9 | 文档收口（FEATURES §3.9 / README / workbench README） | docs/FEATURES.md、README.md、workbench/README.md |

代表提交链：3757151（基线）→ 77ce2c2（T-123 实现）→ 13b87c1 promote → 2a90d90（保全）→ ae53bef（T-124 审查）→ d9adffb promote → eb57b58/550069e（T-125 报告+证据）→ **dabf18f promote T-125 = 本部署 HEAD**。

### 1.2 变更影响（部署视角，逐面）

- **API 面（只增不删）**：

| 端点 | 宿主 | 说明 / 边界 |
| --- | --- | --- |
| GET /api/chat/health?scope= | team-hub :8787 | 只读聚合：守护在线（60s 心跳窗）/回复开关/模型解析链/最近失败 aiError；缺 scope 或非法 → 400 |
| PUT /api/chat/attachments?scope=&by=&fileName= | team-hub :8787 | 附件上传（raw UTF-8 文本 → staged；护栏：单附件 ≤10MB、每消息 ≤3、黑名单扩展名、非法 UTF-8 拒绝） |
| GET /api/chat/attachments/content?id=&conv=&scope= | team-hub :8787 | 附件内容取回（按会话归属校验，跨会话/跨 scope 403） |
| GET/POST /api/chat/reply-settings | team-hub :8787 | 每空间 AI 回复开关（默认开）/模型/身份/systemHint，写走统一纪律（by 必填 + audit + SSE） |
| GET /api/chat/replies?scope=&sinceMsgId= ｜ POST /api/chat/replies/answer|retry|fail | team-hub :8787 | 回复队列/回写（CAS awaiting→replied/failed，幂等；超龄自动 failed 带超时文案） |
| POST /api/heartbeat | team-hub :8787 | 守护心跳上报（kind=worker，携带当前选用模型，供 health 聚合；既有接口扩展） |

- **数据影响**：team-hub SQLite 启动幂等建表/补列——新增 `chat_reply_settings`、`chat_attachments` 两张表（CREATE TABLE IF NOT EXISTS + 索引），`members` 表补 `model` 列（ensureColumn 幂等 ALTER）；存量 team.db 无损升级，无需手工迁移脚本（chat.test 41 含旧库路径用例）。
- **落盘新增**：附件内容存 `<TEAM_HUB_DB 同基目录>/uploads/<scope>/<sha1>`（sha1 去重；messages.meta.attachments 只存引用）；staged 孤儿 24h / sent 过期 7 天周期清理（env 可覆写）。→ **备份面新增 uploads/ 目录**（§6）。
- **前端影响**：workbench 构建产物 dist/ 变化（5173 非热更，部署后需 Ctrl+F5 强刷）；ChatView 新增「全部空间选空间入口 / 健康状态点 / ⚙ 回复设置弹窗 / 📎 附件行与消息附件标识」。
- **服务/守护影响**：三件套启动方式/端口不变；守护（plugins dsh-scrum-worker）新增 ①心跳上报（周期 POST /api/heartbeat kind=worker）②回复上下文接线（取空间摘要 + 附件内容注入提示词）——**需在 DSH 宿主重载/重启插件使其生效**（见 §4 Phase 4-E4）；摘要/附件读取失败走降级占位，不把源消息误标 failed。
- **依赖**：**零新增运行时/开发依赖**（18 文件 diff 中 package.json/pnpm-lock 零改动）；Node ≥ 22.5（node:sqlite）。
- **配置面（env 可覆写护栏）**：CHAT_REPLY_TIMEOUT_MS（默认 120000）、CHAT_ATTACH_MAX_BYTES（默认 10MB）、CHAT_ATTACH_MAX_PER_MSG（默认 3）、CHAT_ATTACH_BLACKLIST_EXT（exe/dll/bin/zip/rar/7z/tar/gz/png/jpg/jpeg/gif/webp/svg/ico/pdf/doc/docx/xls/xlsx）、CHAT_ATTACH_STAGED_TTL_MS（默认 24h）、CHAT_ATTACH_TTL_MS（默认 7d）、CHAT_CTX_BUDGET_CHARS（摘要+附件上下文预算，默认 8000）、CHAT_DAEMON_ONLINE_MS（心跳在线窗，默认 60000）。
- **docSync 同步面（验收标准对应）**：用户可见行为变更（对话中心选择工作空间入口/健康状态点/回复设置/附件）已在 T-123 S9 同步 **docs/FEATURES.md §3.9 + 功能索引 F-09 + README §3.9/§6**，本阶段复核：doc 门禁 PASS + T-125 关键句 6/6 证据（T125-evidence/11-s9-key-sentences.txt）；**无需再改手册**（§7.3 复核结论）。

---

## 2. 部署环境与发布目标（环境清单）

| # | 环境 | 承载 | 发布动作 | 负责 | 状态 |
| --- | --- | --- | --- | --- | --- |
| E1 | **dev/验证（本 worktree）** | `.legion-worktrees/T-126`（分支 w/T-126，HEAD dabf18f） | 全量发布门禁 run-ci 7 阶段 + 文档门禁 | devops（本轮） | ✅ 已完成（§3 证据） |
| E2 | **CI 门禁（仓库级）** | `scripts/ci/run-ci.mjs`（Node ≥ 22.5，零依赖） | 每次发布前全量跑通；doc 阶段可 --skip 逃生 | devops（每轮） | ✅ 本轮全 PASS |
| E3 | **集成基线 main** | main 分支（promote 合并点） | 将军验收后 `promote T-126` 合入 w/T-126 → main；合入后可按 §3 复跑 run-ci 核对 | 将军 | ⏳ 待将军 promote（本 worktree 不 push） |
| E4 | **运行实例（acceptance，本机/局域网）** | team-hub v2（server.mjs :8787）+ 指挥台（serve.mjs :5173 托管 dist）+ 守护插件（plugins，随 DSH 宿主加载）；v1 看板/whiteboard 可选 | 见 §4 Phase 2-4：重构建产物、重启 team-hub、重载守护插件、前端强刷 | 将军/宿主 | ⏳ 部署后按 §5 清单执行（本沙箱不可达项见 §5.3） |
| E5 | **production** | 未定义 / 未授权 | — | 将军立项批准后执行 | 🔴 本阶段**不发布生产**（边界 §9） |

> 组件与端口沿用仓库既有三件套：team-hub :8787（team.db SQLite WAL）、指挥台 :5173（构建产物 + /hub/* 代理）、v1 看板 :4820（遗留）、whiteboard :8080（独立子项目）。守护（scrum-worker responder）由 DSH Desktop host 加载 plugins，回复功能运行前提 = 守护在线 + 已配置可用 assistant 模型 + 每空间 AI 回复开关开。

---

## 3. 构建与 CI 门禁实测（真实命令输出为证）

```bash
# 全量发布门禁（env→deps→build→test→smoke→stage→doc）—— 本轮已执行
node scripts/ci/run-ci.mjs --out docs/G-mtr3su6f-1/T126-evidence/ci-run-dabf18f
```

执行载体说明：与仓库先例（T-093/T-118/T-125）一致，经 run_code 宿主进程直跑（pwsh 沙箱拦截子进程 pipe 捕获 EPERM，属环境边界非门禁失败；宿主直跑命令与产物与普通终端一致）。输出要点（全文见 evidence/ci-run-dabf18f/ci-output.txt + summary.json）：

```text
Legion CI run: root=D:\project\DSH\legion\.legion-worktrees\T-126 node=24.19.0  git head=dabf18f
[env]   PASS  node=24.19.0（要求 >= 22.5，node:sqlite）
[deps]  PASS  已建 junction workbench/node_modules -> D:\project\DSH\legion\workbench\node_modules
[build] PASS  whiteboard PASS（node scripts/build.mjs）
               workbench PASS（tsc --noEmit && vite build）→ 621 modules transformed. built in 10.37s
               dist/index.html 0.44kB + assets/index-*.css 64.46kB + index-*.js 419.51kB + Scene3D-*.js 923.50kB
[test]  PASS  chat 41/41 · skills 20/20 · calendar 13/13 · files-api 40/40 · web 24/24 · contracts 56/56 · whiteboard 67/67（exit 全 0，合计 261 用例 0 失败）
[smoke] PASS  chat-l1-smoke 35/35（S9-13 回复设置/awaiting 队列/answer→replied/live SSE/超龄 failed 兜底；进程级异常 0）
               chat-s2-smoke 9/9（产物 GET / 200 + /hub 代理 + 分页 50+10 + scope 隔离 + 双订阅 ≤5s）
               files-s5-smoke 32/32（下载字节一致/写操作/删除二次确认/未绑定 400/.git 403）
               whiteboard 真实进程 /healthz {"ok":true,"storage":"MemoryProvider"} + GET / 200 html(1832B)
               v1 看板 /api/config auth=true（--token 生效）→ 子进程已回收
[stage] PASS  发布物暂存 releases/legion-dabf18f-2026-09-08/（MANIFEST.json + SHA256SUMS.txt + dist 快照）
[doc]   PASS  check-docs.mjs exit=0（README + docs/FEATURES.md 结构/链接/索引 8 类校验项全绿）
===== SUMMARY =====  env PASS · deps PASS · build PASS · test PASS · smoke PASS · stage PASS · doc PASS  → exit 0
```

配套同代码验证（T-125 在 d9adffb 实测，deploy HEAD 与之代码一致）：team-hub 全量 116/116（含 chat 41、suites 59）、plugins 15 文件 **115/115**（含 chat 分类器/摘要/回复器，lib 重建 exit 0）、workbench tsc 0 诊断、chat-l1 35/35、chat-s2 9/9、L2 上下文注入 10/10、check-docs PASS —— 证据：docs/G-mtr3su6f-1/T125-evidence/。

---

## 4. 部署步骤清单（按序执行，逐条留痕）

### Phase 0 预检（环境与基线；任一不通过 → 终止发布，边界：不跳过构建/预检直接发布）
- [x] 确认隔离 worktree、分支 w/T-126、无业务代码 WIP（git status 仅本批文档 + 目标镜像）
- [x] 确认 Node 版本满足门禁：node -v → v24.19.0（>= 22.5，node:sqlite）
- [x] 确认零新增依赖、未联网：run-ci deps 阶段自动 junction 复用主 checkout workbench/node_modules
- [x] 确认 T-125 报告在册（docs/G-mtr3su6f-1/TEST_REPORT.md）：缺陷 M1/M2 已复现并归属 coder（§7.2）

### Phase 1 构建 / CI 验证（本轮已真实执行，✅ 见 §3）
- [x] 全量门禁：node scripts/ci/run-ci.mjs --out docs/G-mtr3su6f-1/T126-evidence/ci-run-dabf18f → **exit 0，7/7 PASS**
- [x] 发布物暂存：releases/legion-dabf18f-2026-09-08/（MANIFEST.json + SHA256SUMS.txt，gitignored 不入库）

### Phase 2 部署动作（acceptance / dev；命令与 T-093 runbook §4.1 同款）
```powershell
# ① 团队中枢（必启 :8787）—— 首启幂等建表 chat_reply_settings/chat_attachments + members.model 补列，无手工迁移
node team-hub\server.mjs                                  # 或 TEAM_HUB_PORT=8787 node team-hub\server.mjs
# ② 军团指挥台（:5173，托管 Phase 1 构建产物；5173 非热更）
cd workbench; node scripts\serve.mjs --port 5173          # 写令牌可选：--token <写令牌>
# ③（可选）v1 看板遗留 / whiteboard 独立子项目
node scrum\serve.mjs --port 4820 --host 0.0.0.0 --token legion-kanban-4820
# ④ 守护插件（AI 回复/上下文接线/心跳的运行时）—— 在 DSH Desktop 宿主重载 dsh-scrum-worker（plugins）
#    plugins/lib 为 gitignored 构建产物：cd plugins && bash scripts\build.sh（需 DSH_CHECKOUT typescript，仓库既有约定）
#    宿主 profile 重启或 reload 插件后：插件周期 POST /api/heartbeat(kind=worker)，responder 从 /api/chat/replies 拉取并直答
```

### Phase 3 发布后冒烟（部署机执行；L0/L1 已由门禁覆盖，此处进程级探活）
```powershell
# 探活
curl http://127.0.0.1:8787/api/config                        # 中枢 {db,port:8787}
curl -I http://127.0.0.1:5173/                               # 指挥台产物 200
curl "http://127.0.0.1:8787/api/chat/health?scope=<space>"    # 健康聚合（enabled/modelResolved/online）
curl http://127.0.0.1:8787/api/members                        # 守护心跳成员 online=true（60s 窗）
# 对话主路径（数据面等价已由 chat-l1 35/35 + chat-s2 9/9 锚定，此处真实实例抽验 1 条）
#   POST /api/chat/conversations -> POST /api/chat/messages -> GET /api/chat/messages -> POST /api/chat/replies/answer
```

### Phase 4 宿主/生产生效与发布后核对
- [ ] 重启/重载 DSH 宿主守护插件（E4）：观察启动日志无异常；/api/members 该守护成员 online=true；chat 消息 → replies 队列出现 awaiting → 守护 answer 回写 replied（真实 LLM 出站，见 §5.3 冒烟脚本）
- [ ] main 合入后复跑：node scripts/ci/run-ci.mjs --only doc → doc PASS（防合入漂移）；功能手册可渲染、索引对账无缺
- [ ] 抽样一条 E2E：绑定仓库事实题回答引用真实内容；带/不带附件对照（§5.3 A/B/C）

### Phase 5 发布记录登记（每次发布填写）
| 项 | 值 |
| --- | --- |
| 发布版本 / commit | legion-dabf18f（MANIFEST.json；批提交 77ce2c2 S1~S9） |
| 部署环境 | E1 dev/CI（本轮已执行）/ E4 acceptance（部署后执行）/ E5 production（未授权） |
| CI 证据 | docs/G-mtr3su6f-1/T126-evidence/ci-run-dabf18f/（ci-output.txt + summary.json） |
| 验证项 | §5 清单逐条（L0 261 / L1 冒烟 / L2 宿主走查 / 健康巡检） |
| 已知缺陷 | §7.2：M1/M2（归属 coder 修复轮，生产放行前置） |
| 回滚预案 | §6（触发即执行；升级前先备份 team.db* + uploads/） |

---

## 5. 验证项清单

### 5.1 L0 自动化（每次发布必跑）— CI test 阶段（本轮实测全绿）
node --test 七套件 **261 用例 0 失败**：team-hub/chat.test.mjs 41（含 S2 健康 6 + S3 附件 12）、skills 20、calendar 13、files-api 40、web 24、contracts 56、whiteboard 67（61 单测 + 6 e2e 真实服务）→ exit 全 0（ci-output.txt）。

### 5.2 L1 服务级（每次发布必跑）— CI smoke 阶段（本轮实测全 PASS）+ 手工探活
| 验证项 | 命令 / 期望 | 本轮实测 |
| --- | --- | --- |
| 对话 L1（真实进程 + SSE + 鉴权 + 回复生命周期） | node team-hub/chat-l1-smoke.mjs | ✅ 35/35 exit 0 |
| 对话 S2 数据面（产物 + /hub 代理 + 分页 + 隔离 + 双订阅） | node workbench/scripts/chat-s2-smoke.mjs | ✅ 9/9 exit 0 |
| 健康端点 | GET /api/chat/health?scope=（隔离库用例） | ✅ chat.test S2 6 例绿（M1/M2 局限见 §7.2） |
| 中枢探活 | curl http://127.0.0.1:8787/api/config | ✅（env/smoke 阶段已探活真实进程） |
| 指挥台探活 | curl http://127.0.0.1:5173/ → 200 text/html | ✅ chat-s2 S2-A |
| 守护心跳 | GET /api/members → kind=worker 成员 online=true | ⏳ E4 宿主部署后抽验 |
| 附件数据面 | 上传→staged→绑定→取回→跨会话 403→TTL 清理（隔离库） | ✅ chat.test S3 12 例 + T-125 证据 |

### 5.3 L2 宿主/浏览器手工验收（部署后执行；本沙箱无 DSH 宿主运行实例与浏览器 → 复现清单，不冒充通过）
1. **真实 LLM 出站闭环**（对应 TEST_CASES E2E-1/2/3）：隔离 hub + 守护宿主按步骤验证——A) 绑定仓库事实题（如「legion 仓库顶层有哪些目录」）→ 回复引用真实内容；B) 上传含独有事实文件提问 → 回复引用该事实；C) 连续两问、第二问不含第一问附件内容（附件仅当次）。
2. **GUI 走查（:5173 浏览器）**：对话中心「全部空间」视图显示「选择工作空间开始对话」入口 → 点选进入空间会话态；发消息 → 气泡三态（⏳/✅/❌+重试）；对话头部健康状态点四态（绿/黄/红/灰）；「⚙ 回复设置」弹窗（AI 开关默认开，关闭后新消息零出站）；编辑区「📎 附件」选择文本文件 → 发送前可移除 → 消息旁「📎 文件名（大小）」标识；附件内容仅作当次回复上下文。
3. **M1/M2 复核点（修复轮后执行）**：仅 beta 空间心跳时问 alpha 空间 health → online=false（M1）；failed 后 replied 成功 → lastFail=null 健康点可达绿（M2）。

### 5.4 发布后健康巡检
```powershell
curl http://127.0.0.1:8787/api/config          # 中枢
curl -I http://127.0.0.1:5173/                 # 指挥台产物
curl "http://127.0.0.1:8787/api/chat/health?scope=software"
Get-Content .legion-services.log -Tail 30      # services-plugin 托管时查看启停/自愈
```

---

## 6. 回滚方案

| 场景 | 操作 | 备注 |
| --- | --- | --- |
| 代码回滚（发布后功能异常） | git checkout <上一发布 commit>（= 本次 promote 前 main 头）→ node scripts/ci/run-ci.mjs --only build → 重启三件套（§4 Phase 2） | 批提交 77ce2c2 为可回滚单元；回滚后 chat 上下文/健康新端点随之消失（API 只增不改，旧代码不依赖新表） |
| 前端产物回滚 | 换回上一版 workbench/dist 快照（releases/ 上一快照或备份）→ 重启 serve.mjs | 5173 非热更；无需动 DB |
| 数据回滚（team.db） | 停 hub → 还原备份 team-hub/team.db（-wal/-shm 同批）→ 重启 | 表结构只增不改：新表（chat_reply_settings/chat_attachments）/新列（members.model）幂等创建；回滚旧代码时新表闲置互不破坏 |
| 附件落盘回滚 | 还原 uploads/ 目录备份（与 team.db 同基目录：<TEAM_HUB_DB 目录>/uploads） | 附件引用指向 sha1 文件，删库行或删文件须同批；staged 孤儿 24h / sent 7 天自动清理为预期 |
| 进程故障（services-plugin 托管） | 无需人工：托管自愈重启（闪退退避 ≤30s）；手动部署则重启对应进程 | .legion-services.log 记录退出码与重启 |
| 端口被占 | 结束占用进程或用独立端口（TEAM_HUB_PORT / --port）起服 | services-plugin 探测到占用即跳过 |

**备份建议（升级前必做）**：Copy-Item team-hub/team.db* <备份目录>/ + Copy-Item team-hub/uploads <备份目录>/uploads -Recurse（新数据面）；发布物快照 releases/legion-dabf18f-2026-09-08/ 含 dist 与 SHA256SUMS.txt，可 Get-FileHash 校验完整性。

---

## 7. 发布说明与已知缺陷（放行门禁）

### 7.1 本批发布说明
- 版本基线：dabf18f（T-123 S1~S9 实现批 promote 后）；功能：对话中心「可回答闭环 + 失败可行动化 + 健康可见化 + 上下文输入（关联工作空间摘要 / 上传文件）+ 回复设置 + UI 入口/健康条/附件行」，零新增依赖。
- 验证结果：构建/CI **7 阶段全 PASS exit 0**（§3）+ L0 七套件 261/261 + L1 冒烟 35+9+32 全过 + check-docs PASS；配套 T-125 同代码 356 项断言全绿（116/116 + 115/115 + 35/35 + 9/9 + 14/14 + 10/10）。
- 发布姿态：**acceptance（本机/局域网自托管）**。未发布生产、未对公网开放（production 需将军批准，§9 边界）。
- **生产放行前置（go/no-go）**：M1/M2 两项中危缺陷修复并经 tester 负例复测通过（详见 TEST_REPORT.md §5 建议）后方可执行 E5 生产发布。

### 7.2 已知缺陷（本阶段不改实现代码，如实登记；归属 coder 修复轮）

| ID | 严重度 | 现象（T-125 隔离 hub 实测复现） | 位置/归属 | 影响与处置 |
| --- | --- | --- | --- | --- |
| M1 | 中 | 别空间守护心跳令本空间 health online=true + 模型兜底泄漏别空间模型（跨 scope 假绿） | team-hub/server.mjs chatHealth :1415-1416/:1430（成员查询缺 scope 过滤）；归属 T-123 coder（T-124 标「必须修改」） | 健康端点跨空间语义错误；生产放行前置修复；修复建议 = 三条成员查询加 scope 过滤 + 补跨 scope 负例 |
| M2 | 中 | lastFail 不随后续 replied 消除 → 健康点恒红 + 存量旧笼统文案透出 | team-hub/server.mjs :1431-1439（只取最新 failed）；ChatView healthView 红态优先；归属 T-123 coder | 健康点「绿」不可达、旧文案透出；修复建议 = 按最近终态事件（replied vs failed）比较取 lastFail + 展示层文案归一 |

> 复现步骤详见 docs/G-mtr3su6f-1/TEST_REPORT.md §3（证据 12-repro-health-m1m2.txt，repro-health-m1m2.mjs 可复跑）；两缺陷不影响本批构建/自动化回归绿面，但按「验收未全绿」口径如实上报——**部署与 CI 门禁（本任务职责）已完成并可放行 acceptance；修复动作属 coder 任务域，不在本阶段代改**。

### 7.3 docSync 复核结论（验收标准逐条对应）
- **docs/FEATURES.md §3.9 对话中心**：✅ 已含本批三要素（「全部空间」选空间入口 + 上下文输入「关联工作空间/上传文件」操作步骤与边界 + 回复设置入口 + 「AI 不回或回复失败怎么办」可行动指引 + 健康点四态说明）——T-123 S9 合入，T-125 关键句 6/6 断言通过（T125-evidence/11）。
- **功能索引**：✅ F-09 对话中心行锚点「3.9 对话中心」在册、状态「已上线」（索引行数 ≥18、5 列、锚点真实——check-docs 第 1/2/3 类校验 PASS）。
- **README 引导段**：✅ §3.9 对话中心互链行 + §6 故障排查 AI 不回行已同步本批行为（T-123 77ce2c2 中 README.md 改动）。
- 本阶段复核载体：run-ci **doc 阶段 PASS**（exit 0，8 类全绿）+ §1.2 变更影响与 §5 验证清单即部署视角的同步核对；**无新增用户可见行为变更超出 T-123 S9 已收口范围，故手册无需再改**。

---

## 8. 运维要点

- 日志：services-plugin → <legion根>/.legion-services.log；手动起服看各自终端；CI 证据 → docs/G-mtr3su6f-1/T126-evidence/ci-run-dabf18f/（ci-output.txt + summary.json）。
- 数据：team-hub/team.db（SQLite WAL）+ 同基 uploads/（附件落盘，sha1 去重）。改动/新增表自动迁移；升级前备份见 §6。
- 健康/自愈：守护心跳经 POST /api/heartbeat(kind=worker) 上报（60s 在线窗）；对话回复超龄（默认 120s）自动 failed；附件 staged 24h / sent 7 天周期清理（可 env 覆写）。
- 前端改码后必须重新构建（5173 非热更），发布后 Ctrl+F5 强刷；plugins 改码后需重建 plugins/lib 并在宿主重载（junction/DSH_CHECKOUT 构建约定，见 plugins/README 与根 README §2.1.1）。
- 看板数据模型不变（v2 SQLite 为准）；v1 仅遗留/迁移用途。

---

## 9. 边界遵守与后续动作

- ✅ 只做构建与部署类操作并按清单留痕（§3-§6）；✅ 未跳过构建/预检（Phase 0-1 全过才到部署步骤）；✅ **未发布生产**（E5 未授权，go/no-go 未达：M1/M2 待 coder 修复）；✅ 未 push（pre-push 拦截 w/*，promote 由将军执行）。
- 后续动作（供将军/守护排程）：① 发起 coder 修复轮处理 M1/M2（挂回 T-123 或新建 fix 任务）→ tester 复测负例 → 本文件 §7.2 缺陷行更新为已修复后可放行生产；② acceptance 部署（E4）按 §5.3 宿主冒烟清单执行；③ 将军验收本 worktree diff 后 promote T-126 合入 main，合入后复跑 node scripts/ci/run-ci.mjs --only doc 核对无漂移。

*（本文件由 T-126 devops 产出：真实命令/日志为证（docs/G-mtr3su6f-1/T126-evidence/），未修改任何业务功能代码、未调用 taskctl/看板写接口、未 push。）*
