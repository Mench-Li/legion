# T-118 部署与发布说明（DEPLOY.md）——「完整功能使用介绍文档 + 功能/迭代持续自动同步」收尾发布

> 阶段：部署与 CI/CD（devops）｜执行任务：T-118（[auto-goal]｜所属目标 G-mtpq729o-1 · software · chain）
> 上游依据（本目标文档目录，只认本目录版本）：T-111 REQUIREMENTS.md（R-1~R-5 + AC-R*）→ T-112 RESEARCH.md（决策 A~F）→ T-113 TASK_BREAKDOWN.md（S1~S5）→ T-114 TEST_CASES.md（66 条）→ T-115 coder 实现（f0261fc）→ T-116 REVIEW → T-117 TEST_REPORT.md（复测 **65P / 0F / 1 backlog 放行**）
> 被发布批次：f0261fc（T-115，S1~S5 实现）→ HEAD **6553d3e**（含 T-116/T-117 修复链 ca9b45c RC-1~3 / a39ba9f / 8f5591b / 022b559 V-1）；对照基线 cba1fb7（T-114）
> 本文件落点：docs/G-mtpq729o-1/DEPLOY.md（目标级分析文档目录；不写/不碰仓库根 docs/DEPLOY.md 槽位与其他目标目录）
> 证据目录：docs/G-mtpq729o-1/T118-evidence/（本文全部命令均为本轮在隔离 worktree 真实执行，命令输出为证）

---

## 0. 结论速览（TL;DR）

- **发布内容** = G-mtpq729o-1 交付批：① 产品功能手册首版 `docs/FEATURES.md`（含 18 功能域索引）＋ README 收敛互链去重；② 文档新鲜度机器校验 `scripts/ci/check-docs.mjs`；③ CI 门禁 `run-ci.mjs` 新增 doc 阶段；④ 持续自动同步机制（docSync 声明通道 + 契约追加 + 机器验收项 + 提示词注入）。零新增运行时依赖。
- **本轮（T-118 devops 收尾）实测结论**：构建 / CI **真实跑通**——`node scripts/ci/run-ci.mjs` 全量 **7/7 阶段 PASS、exit=0**（env/deps/build/test/smoke/stage/doc；test 7 套件 243 断言、smoke L1 真实服务 35/35+9/9+32/32）；机制面 plugins `tsc 0 诊断` + `node --test` **54/54**；门禁负例（坏互链注入）doc 阶段 FAIL exit=1 且报错含文件+行，字节级还原后全绿。
- 边界遵守：本轮**不改任何业务功能代码**（T-115 已合入，本轮仅部署收尾）；**未发布生产**（未 push、未 promote——promote 由将军执行）；发布前预检/构建全部完成，未跳过任何门禁直接发布。

---

## 1. 发布对象与变更影响说明

### 1.1 本批发布物清单

| 类别 | 文件 | 性质 | 影响面 |
| --- | --- | --- | --- |
| 产品文档 | `docs/FEATURES.md`（新建，282 行） | 完整功能使用手册：定位/面向读者/快速开始/18 模块章节/功能索引（F-xx ≥18 行、四列）/故障排查/术语附录 | 用户（将军/编队）与后续 AI 任务的功能使用入口；README 详情迁移目标 |
| 产品文档 | `README.md`（收敛互链） | 总览 + 快速开始 + 模块导航，操作细节迁移至手册并互链去重 | 仓库首页导航；消除两处全文复制漂移 |
| 机器校验 | `scripts/ci/check-docs.mjs`（新建，零依赖） | 8 类校验：README→手册锚点 / 索引提取列数 / 索引锚点 / 段落去重 / 关键项 / CRLF 归一等 | 任何改动 README/FEATURES 的提交均可被机器发现漏更/断链 |
| CI 门禁 | `scripts/ci/run-ci.mjs`（+doc 阶段） | 阶段清单 = 既有六阶段 + `doc`（可 `--skip doc` / `--only doc`） | 全量发布前门禁新增文档新鲜度检查 |
| 持续同步机制 | `team-hub/server.mjs` | `goal/tasks` 新增 `docSync` 列（`ensureColumn` 幂等 ALTER，启动自迁移）＋ 建链/切片/`/api/goal` `/api/create` 透传（`body.feature=true` 别名） | 目标链数据模型；既有读写路径行为不变（默认 false） |
| 持续同步机制 | `plugins/src/index.ts` | `resolveStageDocPathsWithDocSync` 纯函数：docSync=true 任务在契约路径追加 `docs/FEATURES.md` + `README.md`；buildWorkerPrompt 注入同步提示词 | docSync 任务 done 结算自动登记/判缺；非 docSync 原样返回（AC-R4-4） |
| 机器验收项 | `team-hub/stage-standards.mjs`（+2 行） | coder/devops 各追加 1 条「用户可见行为变更须同步功能手册 + README」验收项（纯重构可豁免） | 任务验收模板；岗位语义不变（只加项不改项） |
| 未改动 | `roles.json` 等 | 零改动（T-117 回归确认） | 角色/契约数据模型不变 |

> 发布批次 git 关系：`cba1fb7`（T-114 基线）→ `f0261fc`（T-115 coder 实现 S1~S5）→ `87ccc1e promote T-115 (mediator)` → `ce87364 promote T-116` → T-117 修复链（ca9b45c / a39ba9f / 8f5591b / 022b559）→ `53a5eca` / `6553d3e`（T-117 复测通过报告 + 证据，docs only）＝ **当前 HEAD 6553d3e**。

### 1.2 变更影响面（对外与对内）

1. **用户可见影响（正面）**：新增一份长期维护的完整功能手册 `docs/FEATURES.md`；README 变为更短的总览/导航并互链手册。界面/交互/接口语义零改变（本批无运行时 UI/接口行为变更）。
2. **对后续功能目标链的影响（R-4 落地）**：凡「用户可见行为变更」（feature/docSync）目标：拆解链上 coder 任务自动带 `docSync=true` → done 结算追加手册+README 契约（缺失即停 in_review 提示）→ 校验脚本与 CI doc 阶段兜底漏更。纯重构/测试目标默认不标 → 流程不被卡（AC-R4-4 已实测）。
3. **既有行为兼容**：T-117 回归结论（TEST_REPORT §5.1）——roles.json 0 改动；stage-standards 仅追加项；server.mjs 纯增量（docSync 默认 false，旧任务/目标读写路径不变）；plugins 消费改纯函数，非 docSync 原样返回；run-ci 仅新增 doc 阶段与失败明细增强。本文件 §6 以命令复验该基线未回归。
4. **风险与缓解**：新机制依赖「breaker/将军在 feature 目标上正确声明 docSync」——缓解：`body.feature=true` 别名 + 提示词注入 + 门禁兜底，三重防漏（RESEARCH D1~D4 组合）；行尾 CRLF 假红——缓解：check-docs 读入 `\r\n`→`\n` 归一化（RC-1，T-117 已修，本轮复验全绿）。

---

## 2. 部署环境与发布目标（环境清单）

| # | 环境 | 承载 | 发布动作 | 负责 | 状态 |
| --- | --- | --- | --- | --- | --- |
| E1 | **开发验证（本 worktree）** | `D:\project\DSH\legion\.legion-worktrees\T-118`（分支 w/T-118，HEAD 6553d3e） | 全量预检：run-ci 7 阶段 + plugins 回归 + 负例注入 | devops（本轮） | ✅ 已完成（§6） |
| E2 | **CI 门禁（仓库级）** | `scripts/ci/run-ci.mjs`（Node ≥22.5，零依赖；本地即仓库 CI） | 每次发布前全量跑通；doc 阶段可 `--skip` 逃生 | devops（每轮） | ✅ 本轮全量 PASS |
| E3 | **集成基线 main** | main 分支（promote 合并点） | 将军 `promote T-118` 合入 w/T-118 → main；合入后再跑一次 run-ci 核对 | 将军 | ⏸ 待将军 promote（本轮不 push） |
| E4 | **生产 Legion 运行时** | team-hub v2（`team-hub/server.mjs`，:8787，SQLite）+ 守护插件（plugins worker/mediator 由宿主 DSH profile 加载） | server.mjs/plugins 改动需**宿主重启生效**：重启 team-hub 进程（docSync 列由 `ensureColumn` 启动幂等 ALTER，无需手工迁移）；重载 worker/mediator 插件 | 将军/宿主 | ⏸ 未获批准不发布生产（边界） |

> 说明：本仓库「发布」的常态路径 = 任务链产物 promote 至 main（E3）即完成源码集成；E4 的进程重启仅当本轮 server.mjs/plugins 机制代码需在宿主运行实例中生效时才执行。T-118 自身只新增 docs/DEPLOY.md + T118-evidence/（纯文档），**合入本身不需要生产重启**；机制代码（已在 main 的 f0261fc..6553d3e）如宿主尚未 reload，见 E4 步骤。

---

## 3. 发布步骤清单（按序执行，逐条留痕）

### Phase 0 预检（环境与基线）
- [x] 确认工作区为隔离 worktree、分支 `w/T-118`、无业务代码 WIP（`git status` 仅 docs 改动）
- [x] 确认 Node 版本满足门禁：`node -v` → v24.19.0（≥22.5）
- [x] 确认零新增依赖、未联网：run-ci deps 阶段自动复用主 checkout 既有 `workbench/node_modules`（junction），无 `pnpm install`

### Phase 1 构建 / CI 验证（本轮已真实执行，§6 证据）
- [x] 全量门禁：`node scripts/ci/run-ci.mjs --out docs/G-mtpq729o-1/T118-evidence/ci-run-6553d3e` → exit=0，7/7 PASS
- [x] 机制面代码静态/回归：plugins `tsc --noEmit` exit=0（0 诊断）；`node --test plugins/tests/*.test.mjs` → 54/54
- [x] 门禁负例自检：坏互链注入 → `check-docs` 与 `run-ci --only doc` 均 FAIL exit=1 且明细含文件:行 → 字节级还原后全绿

### Phase 2 文档与产物就绪
- [x] 校验脚本与门禁对象（README + FEATURES）在 HEAD 上全绿：`node scripts/ci/check-docs.mjs` exit=0
- [x] 发布物暂存：run-ci stage 阶段生成 `releases/legion-6553d3e-2026-09-07/`（MANIFEST.json + SHA256SUMS.txt，gitignored 不入库）
- [x] 部署/发布说明落盘：本文档 `docs/G-mtpq729o-1/DEPLOY.md` ＋ 证据 `docs/G-mtpq729o-1/T118-evidence/`（本轮新增）

### Phase 3 合入 main（将军执行）
- [ ] 将军验收 T-118 diff（守护自动记录）→ `promote T-118` 将 w/T-118 合入 main（pre-push 已拦截 w/*，士兵不 push）
- [ ] promote 后在 main 复跑：`node scripts/ci/run-ci.mjs --only doc` → doc PASS（防合入漂移）

### Phase 4 生产生效（仅当机制代码需在宿主运行实例生效，将军/宿主执行）
- [ ] 重启 team-hub：启动时 `ensureColumn('goal'|'tasks','docSync',…)` 幂等 ALTER 建列（默认 0），无手工 DB 迁移
- [ ] 重载守护插件（worker/mediator）：`resolveStageDocPathsWithDocSync` 消费 docSync 契约逻辑生效
- [ ] 观察启动日志无异常、`/api/board` 任务返回含 `docSync` 布尔字段（E2E 抽样见 T-117 04a）

### Phase 5 发布后核对（Post-release check）
- [ ] main 上 `git log --oneline` 含 promote 提交、README/FEATURES/check-docs/run-ci 变更在位
- [ ] CI doc 阶段在 main 为 PASS（§6 门禁复跑）；功能手册可渲染、索引对账无缺失
- [ ] 抽测一条 docSync 目标链 E2E（可选，T-117 已实测 AC-R4-1/2/4）

---

## 4. 验证项清单（机器可执行 → 期望 → 本轮实测）

| ID | 验证项 | 命令 | 期望 | 本轮实测 |
| --- | --- | --- | --- | --- |
| V-1 | 环境自检 | `node -v` / `git rev-parse --short HEAD` | node ≥22.5；HEAD=6553d3e | ✅ v24.19.0 / 6553d3e |
| V-2 | 文档新鲜度正向 | `node scripts/ci/check-docs.mjs` | exit=0，8 类校验全绿 | ✅ exit=0 PASS |
| V-3 | 全量 CI 门禁 | `node scripts/ci/run-ci.mjs` | 7 阶段全 PASS、exit=0 | ✅ env/deps/build/test/smoke/stage/doc 全 PASS |
| V-4 | 构建产物 | build 阶段（whiteboard + workbench `tsc --noEmit && vite build`） | exit=0，dist/index.html 存在 | ✅ 13.2s PASS |
| V-5 | L0 测试 | run-ci test 阶段 7 套件 | 全部 pass=0 fail | ✅ 243/243（chat 23·skills 20·calendar 13·files-api 40·web 24·contracts 56·whiteboard 67） |
| V-6 | L1 真实服务冒烟 | run-ci smoke 阶段 | 断言全过、进程回收 | ✅ chat L1 35/35、S2 9/9、files S5 32/32、whiteboard/v1 真实进程探活 |
| V-7 | 发布物暂存 | run-ci stage 阶段 | releases/<head>/MANIFEST+SHA256 | ✅ legion-6553d3e-2026-09-07 |
| V-8 | doc 门禁接线 | run-ci 阶段清单 | = 六阶段 + doc（可 skip） | ✅ STAGES 7 项含 doc；`--skip doc`/`--only doc` 语义在（负例见 V-11） |
| V-9 | 机制面静态 | `tsc -p plugins/tsconfig.json --noEmit` | exit=0 0 诊断 | ✅ exit=0 |
| V-10 | 机制面回归 | `node --test plugins/tests/*.test.mjs` | 全过 | ✅ 54/54（含 doc-contract/artifact-register/worker-regression） |
| V-11 | 门禁负例（坏互链） | 注入坏锚点 → `check-docs` / `run-ci --only doc` | exit≠0，明细含 文件+行 | ✅ 两者均 exit=1，`FAIL: README.md:180 — 互链锚点失效：docs/FEATURES.md#t118-no-such-anchor` |
| V-12 | 还原 | 字节级还原 README 后 `check-docs` | exit=0、git diff 空 | ✅ exit=0，diff 空 |

---

## 5. 回滚方案（按层分级，含验证）

### 5.1 回滚触发条件
- P0：promote 后 main 上 CI 门禁（含 doc 阶段）FAIL，或功能手册/README 呈现断链或索引失配；
- P1：docSync 机制误卡正常任务（非 feature 任务被追加契约 / feature 任务漏更文档未被检出）；
- P2：内容性回退（手册描述与产品现状不符需整体下架）。

### 5.2 回滚动作

| 层级 | 时机 | 动作 | 验证 |
| --- | --- | --- | --- |
| **文档内容层** | promote 前 / 后 | promote 前：丢弃 w/T-118 分支（未 push 无副作用）；promote 后：`git revert <merge commit>` 或 `git checkout cba1fb7 -- README.md docs/FEATURES.md` 后再提交 | `node scripts/ci/check-docs.mjs` exit=0 且无失效互链；手册渲染正常 |
| **CI 门禁层** | 任意 | 逃生阀：`node scripts/ci/run-ci.mjs --skip doc`（既有参数）或临时移除 run-ci 中 doc 阶段注册 | 其余六阶段照跑不阻塞；问题修复后恢复 doc 阶段 |
| **校验脚本层** | 任意 | `scripts/ci/check-docs.mjs` 为零依赖单文件：回退至上一版本或按需修正断言（CRLF 归内已内置） | 重跑 exit=0；负例注入仍能 FAIL |
| **机制层（docSync）** | E4 生产 | 字段默认 false 前向兼容：**不重启即回退**（新代码未生效）；已生效则重启用旧版 server.mjs / plugins（或 revert f0261fc..HEAD 中机制提交） | `/api/board` 任务无 docSync 或 docSync=false；建链行为与 T-114 基线一致 |
| **DB 层** | E4 生产 | `docSync` 列为新增列（INTEGER DEFAULT 0），无需删表；必要时 `ALTER TABLE goal DROP COLUMN docSync`（SQLite 3.35+） | 既有查询/写入路径回归（run-ci test + plugins 54/54） |

### 5.3 回滚验证命令（统一）
```
node scripts/ci/run-ci.mjs --only doc      # 期望 PASS（文档对象一致）
node scripts/ci/check-docs.mjs             # 期望 exit=0
node --test plugins/tests/*.test.mjs       # 期望全过（机制回退后基线）
git log --oneline -5                       # 期望回退提交在位、无游离
```

---

## 6. 本轮验证结果与证据（命令输出为证）

| 证据文件（docs/G-mtpq729o-1/T118-evidence/） | 内容 | 结论 |
| --- | --- | --- |
| 00-env.txt | 环境基线：node v24.19.0 / HEAD 6553d3e / w/T-118 / CRLF 与 junction 事实 | ✅ |
| 01-ci-full-run.txt（+ ci-run-6553d3e/ci.log + summary.json） | `node scripts/ci/run-ci.mjs` 全量输出：**7/7 PASS、exit=0**；test 243/243；smoke 35/35+9/9+32/32；stage 产物暂存 | ✅ 构建 / CI 真实跑通 |
| 02-plugins-surface.txt | plugins `tsc` 0 诊断（exit=0）+ `node --test` **54/54** | ✅ 机制面回归 |
| 03-doc-gate-negative.txt（+ neg-doc-run/） | 坏互链注入：check-docs 与 run-ci doc 阶段均 FAIL exit=1 且报错含 `README.md:180`；字节级还原后 exit=0 | ✅ 门禁有效且可读、还原无损 |

> 命令执行环境说明：全部命令在隔离 worktree（w/T-118）真实执行（Node v24.19.0）；run-ci 由进程直跑（沙箱限制详见 run-ci.mjs 头注释）；未联网、零新增依赖、未 push、未发布生产。

---

## 7. 后续持续性工作（机制上线后的 devops 例行）

本目标 R-4/R-5 的「持续自动更新」在发布后形成如下例行闭环，本文档即该闭环的**持续模板**：

1. **每个 feature/docSync 目标发布轮**：devops 收尾时执行 §3 Phase 1~2（全量或 `--only doc` 门禁 + 证据落盘），并按本文档模板更新本目录 DEPLOY.md（发布物、影响、验证、回滚四要素随轮补充）。
2. **漏更防线**（三重）：① 任务链 coder `docSync=true` 契约强制（plugins 结算判缺）→ ② stage-standards 机器验收项（本文档角色自身亦适用）→ ③ `check-docs.mjs` + run-ci doc 门禁兜底。
3. **触发口径提醒**：仅「用户可见行为变化」（新功能/新入口/流程默认值变化/移除废弃）触发；纯重构/测试豁免——breaker 在拆解时按目标声明，devops 在发布核对时抽查索引对账（F-xx 行数与 FEATURES 章节是否随新功能增长）。
4. **已知 backlog（将军裁决放行项）**：TC-S2-13 FEATURES→README 反向锚点 ≥1 未补（T-117 RC-4，本期放行）——后续迭代可纳入。

---

*（文档结束：docs/G-mtpq729o-1/DEPLOY.md · T-118 devops · 变更仅部署与发布类操作并按清单留痕；未发布生产。）*
