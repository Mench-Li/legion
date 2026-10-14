<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本文反映 **2026-10-14**（w/T-210 开工基线 HEAD `f6f1f412`）的部署与 CI 读数；其中的命令、端口与数字只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../../STATUS.md)（状态与测试基线）· [README.md](../../../README.md)（总览）· [docs/FEATURES.md](../../FEATURES.md)（功能手册）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-210 部署与发布说明：为软件流水线空间的外部执行者（soldier-*/general）补齐人形头像

> 角色：devops（部署与 CI/CD · 启舟）｜任务：T-210（[auto-goal]｜所属目标 G-mv7kzgnu-1 · software · chain）
> 开工基线 HEAD：`f6f1f412`（= `promote T-209`；功能提交 = T-207 `b8f66e64`，T-208 审查 `7613e949`，T-209 测试 `24814fb8`）
> 上游链：REQUIREMENTS（T-203）→ RESEARCH（T-204）→ TASK_BREAKDOWN（T-205）→ TEST_CASES（T-206）→ **coder T-207** → review T-208 → [TEST_REPORT.md](./TEST_REPORT.md)（T-209）→ **T-210（本文）**
> 本任务边界：**只做构建与部署类操作，不改业务功能代码**；**未获批准不发布生产**。本阶段唯一写入 = 本文 + [`T210-evidence/`](./T210-evidence/README.md)（证据与探针），**零产品代码、零依赖、零网络**。

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 真实 CI（`scripts/ci/run-ci.mjs`） | `syntax / boundary / deps / doc` **4/5 PASS**；`env` **FAIL**（config scan 13 项，**在 main worktree 上同样为红，与本目标无关**，§7.1）。去掉既有红 `env` 后 `--only syntax,boundary,deps,doc` → **exit 0，4/4 PASS** |
| 构建门禁 | whiteboard `node scripts/build.mjs` **exit 0**；workbench `tsc --noEmit` **exit 0**；workbench `vite build` 在本会话沙箱被 esbuild `spawn EPERM` 挡住（**环境限制，非编译错误**，§3.2/§8） |
| 受影响/回归套件 | **9 支 / 83 例，pass 83 · fail 0**（全部 exit 0；`T210-evidence/target-suites.txt`） |
| 部署冒烟（真 hub + 真 HTTP） | **PASS**：`GET /api/roster?scope=software` HTTP 200、12 条、非法 0、4 条外部身份两两不同；`general=human:s11 / soldier-a=s12 / soldier-b=s13 / soldier-auto=s14`（`T210-evidence/deploy-smoke.json`） |
| 文档门禁 / docSync | `check-docs.mjs` **PASS（11 类全绿）**；三处 docSync 逐处命中（§1.2） |
| 用户可见行为 | **有**（4 个外部执行者 + general 从灰阶占位/字符头像换成 `human:<key>` 人形头像）→ 已同步功能手册 + 功能索引 + README（§1.2） |
| 数据影响 | **零写库、零迁移**：外部执行者是 `/api/roster` 的**投影**，不落 `roster` 行；`agentCount` / `tasks` / 任务归属改前改后逐条相同 |
| 生产发布 | **未执行、未放行**（未获将军批准；本阶段只产出放行材料） |

## 1. 变更范围与影响

### 1.1 本次发布范围（T-207 功能提交 `b8f66e64`，T-210 不改一行产品代码）

| 面 | 内容 | 文件 |
| --- | --- | --- |
| 服务端（读出口） | 新增冻结表 `EXTERNAL_AVATAR_TOKENS`（`general=human:s11`…`soldier-market=human:s15`）与纯函数 `externalAvatarFor`；`/api/roster` 合成外部执行者时不再硬编码 `'⚙️'` | `team-hub/agent-avatars.mjs`、`team-hub/routes/team-views.mjs` |
| 客户端（镜像 + 3 处展示面） | 新增 `EXTERNAL_AGENT_AVATARS` / `externalAvatarToken`；侧栏用户卡、左轨管理员徽标、技能授权标签改为图形头像 | `workbench/src/avatar/external-agents.ts`、`workbench/src/avatar/index.ts`、`Sidebar.tsx`、`WorkspaceNavigation.tsx`、`SkillsPanel.tsx` |
| 测试与 CI 登记 | 新增 `external-avatar-parity` 套件并登记进 `run-ci.mjs`；改写三支既有套件断言 | `workbench/scripts/external-avatar-parity.test.mjs`、`agent-avatar-surfaces.test.mjs`、`agent-avatar-settings.test.mjs`、`team-hub/team-views-routes.test.mjs`、`scripts/ci/run-ci.mjs` |
| 文档 | README / FEATURES / workbench README / REQUIREMENTS banner | 见 §1.2 |

### 1.2 用户可见行为变更 → docSync 三处逐处核验

用户可见面 = 软件流水线空间里 `soldier-a` / `soldier-b` / `soldier-auto` / `general` 这四个「· 执行中」条目的头像（以及 general 本人的侧栏用户卡 / 左轨徽标 / 技能授权标签）。按验收口径「用户可见行为变更须同步功能手册 + 功能索引 + README 引导段」，逐处复核（原始命中见 `T210-evidence/docsync-grep.txt`）：

| 需要的三处 | 位置 | 核验结果 |
| --- | --- | --- |
| 功能手册对应小节 | [docs/FEATURES.md](../../FEATURES.md) §3.2 `:78`（「外部执行者（未入编队）的头像（2026-10-14）」，并含 `:79` 期望结果） | ✅ 写明冻结表 `EXTERNAL_AVATAR_TOKENS`、确定性兜底、两端 parity 套件、池满回落空串 |
| 功能索引 | [docs/FEATURES.md](../../FEATURES.md) §4 `:310` | ✅ `F-02 ｜ 空间与专属编队（含外部执行者头像） ｜ 3.2 空间与专属编队 ｜ … ｜ 已上线`，无断链 |
| README 引导段 | [README.md](../../../README.md) `:147` | ✅ 「未入编队但认领了空间任务的执行者（`soldier-*`、`general`）也拿同一套 `human:<key>` 人形令牌，不再是齿轮占位」 |

`node scripts/ci/check-docs.mjs` → **PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，11 类校验项全绿）**；`T210-evidence/ci-check-docs.txt`。

### 1.3 不影响面（不变量，均已实测）

- **API 契约**：`/api/roster` 除 `avatar` 字段内容外，条目数、`role`/`name`/`external` 语义不变；`/api/agents`、`/api/spaces` 的 `agentCount` 不变。
- **数据**：不落 `roster` 行、不写库、无迁移脚本；改动是**读时投影**。
- **依赖/配置**：`workbench` 的 `dependencies` 仍恰好 5 个；无新增环境变量、无端口变更。
- **纯函数**：分配路径不含 `Math.random` / `Date.now` / 网络 ⇒ 同一身份跨请求、跨进程重启得到同一令牌。

## 2. 环境与拓扑

| 环境 | 形态 | 本次是否执行 | 说明 |
| --- | --- | --- | --- |
| dev（本机 worktree `w/T-210`） | `D:\project\DSH\legion\.legion-worktrees\T-210`；Node `v24.19.0` / win32 x64 | ✅ 已执行 | 构建 / CI / 套件 / 部署冒烟全在本目录 |
| acceptance（127.0.0.1 等价冒烟） | 进程内真 `team-hub`（临时端口）+ live 库只读快照 | ✅ 已执行（等价形态） | `T210-evidence/deploy-smoke.mjs` 起了真 hub（本次 `http://127.0.0.1:51263`）并走真 HTTP；**未启动 5173 前端三件套**（会话纪律：不启动替换服务） |
| production | 对外发布 | ⛔ **未授权、未发布** | 需将军批准 + §4 预检全绿 |

组件与端口（部署时）：team-hub `:8787`（中枢，必启）· workbench `scripts/serve.mjs`（默认 `:5173`，托管 `workbench/dist`，**非热更**）· scrum v1 `:4820`（可选）。
数据面：本阶段一切读数组件均用 live 库 `D:/project/DSH/legion/team-hub/team.db` 的**只读一致性快照**（`VACUUM INTO`）+ 真 HTTP，**全程不写 live 库**。

## 3. 构建与 CI（真实命令 × 读数）

### 3.1 真实 `run-ci.mjs` 静态阶段

```powershell
$env:NODE_OPTIONS='--require=<仓库根>/docs/G-mv7kzgnu-1/T210-evidence/ci-sandbox-patch.cjs'
node scripts/ci/run-ci.mjs --out docs/G-mv7kzgnu-1/T210-evidence/ci-run --only syntax,env,boundary,deps,doc
```

退出码 **1**（仅 `env` 红），4/5 PASS。原始输出 `T210-evidence/ci-run-static.txt` + `ci-run/summary.json`。要点：

| 阶段 | 读数 |
| --- | --- |
| syntax | PASS（`ci-syntax`：全部脚本可被 Node 解析，22.5s） |
| env | **FAIL**：`config scan: FAIL —— 13 项未在 schema 中处理`（见 §7.1；`config sync` / `config check` / `encoding-check` 均 PASS） |
| boundary | PASS（`dsh-boundary` 执行面棘轮 + `dsh-pin-drift` 出处锚点，1.1s） |
| deps | PASS（`workbench/node_modules` 就绪） |
| doc | PASS（`check-docs` 11 类全绿 + `spec-progress --check 141/146`；阶段 3 churn 闸门告警 `cooled=false` 为**程序级告警**，不改变本阶段 PASS） |

**去掉既有红 `env` 的绿基线**（本批交付面 = T-207 功能 + 本次文档/证据）：

```powershell
node scripts/ci/run-ci.mjs --out docs/G-mv7kzgnu-1/T210-evidence/ci-run-green --only syntax,boundary,deps,doc
```

退出码 **0**，`syntax / boundary / deps / doc` **4/4 PASS**；原始输出 `T210-evidence/ci-run-green.txt` + `ci-run-green/summary.json`。

> CI 如实打印：两次都跑在**脏树**上（已改 0 + 未跟踪 1~2），因此读数证明的是「**这棵树**是绿的」，不是「提交 `f6f1f412` 是绿的」。

### 3.2 构建门禁

| # | 命令 | cwd | 读数 | 证据 |
| --- | --- | --- | --- | --- |
| B1 | `node scripts/build.mjs` | `whiteboard` | **exit 0**（`copied 12 shared modules -> apps/web/public/shared/`） | `T210-evidence/build-whiteboard.txt` |
| B2 | `node node_modules/typescript/bin/tsc --noEmit` | `workbench` | **exit 0**，0 行输出（0 诊断） | `T210-evidence/build-tsc.txt` |
| B3 | `node node_modules/vite/bin/vite.js build` | `workbench` | **exit 1**：esbuild `spawn EPERM`（沙箱禁管道；**非编译错误**） | `T210-evidence/build-vite.txt` |
| B4 | `node scripts/ci/run-ci.mjs --only build` | 根 | **exit 1**，`build: workbench FAIL(exit=1)`（同 B3 的 EPERM） | `T210-evidence/ci-run-build.txt` |

`workbench` 的 build 脚本 = `tsc --noEmit && vite build`：**类型门禁（B2）已通过**，只有打包一步被沙箱挡住；普通终端执行同一命令即可产出 `workbench/dist`（T-093/T-202 同口径）。

### 3.3 目标 / 回归套件（逐支真命令，无补丁）

**9 支 / 83 例，pass 83 / fail 0，全部 exit 0**。原始输出 `T210-evidence/target-suites.txt`。

| 套件 | 用例 | 结果 |
| --- | --- | --- |
| `team-hub/team-views-routes.test.mjs` | 20 | ✅ pass 20 / fail 0 |
| `team-hub/scripts/migrate-avatars.test.mjs` | 7 | ✅ pass 7 / fail 0 |
| `team-hub/scripts/seed-roster.test.mjs` | 6 | ✅ pass 6 / fail 0 |
| `workbench/scripts/external-avatar-parity.test.mjs` | 5 | ✅ pass 5 / fail 0 |
| `workbench/scripts/agent-avatar.test.mjs` | 12 | ✅ pass 12 / fail 0 |
| `workbench/scripts/avatar-photo.test.mjs` | 10 | ✅ pass 10 / fail 0 |
| `workbench/mobile/avatar-parity.test.mjs` | 6 | ✅ pass 6 / fail 0 |
| `workbench/scripts/agent-avatar-surfaces.test.mjs` | 9 | ✅ pass 9 / fail 0 |
| `workbench/scripts/agent-avatar-settings.test.mjs` | 8 | ✅ pass 8 / fail 0 |
| **合计** | **83** | **pass 83 / fail 0** |

### 3.4 部署冒烟（live 库只读快照 + 真 hub + 真 HTTP）

```powershell
node docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.mjs --out=docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.json
```

退出码 **0**，`verdict=PASS`。原始结果 `T210-evidence/deploy-smoke.json`：

| 观测 | 实测 |
| --- | --- |
| HTTP | `GET /api/roster?scope=software` → **200**（`http://127.0.0.1:51263`，进程内真 hub） |
| software 条目 | **12**（8 内编 + 4 外部执行者） |
| 不满足 R-1（合法令牌 **且** 命中位面）的条数 | **0** |
| 4 条外部令牌 | `general=human:s11`、`soldier-a=human:s12`、`soldier-b=human:s13`、`soldier-auto=human:s14` |
| 12 条头像去重 | **12**（两两不同，未与内编 8 个撞位面） |

> 这是**部署形态的读出口验证**：服务真实启动 → 真实路由 → 真实 HTTP 响应，覆盖「部署后用户会看到什么」。

### 3.5 文档门禁

| 命令 | 结果 |
| --- | --- |
| `node scripts/ci/check-docs.mjs` | **exit 0**：`PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，11 类校验项全绿）`；历史 evidence banner 覆盖完整（含本目录 `T210-evidence`） |
| `node scripts/ci/evidence-banner.mjs --check` | 由 `doc` 阶段内置校验，**PASS** |

## 4. 部署 / 发布清单（环境 × 步骤 × 验证项 × 回滚）

> 通用三件套与升级/回滚模板见 [docs/DEPLOY.md](../../DEPLOY.md) §4–§6。本节为**本批可执行清单**。

### 步骤 0 · 预检（gate，不通过即终止，禁止跳过）

```powershell
git status --short                                                    # 期望：只有本次任务的改动
node scripts/ci/run-ci.mjs --only syntax,boundary,deps,doc            # 4 阶段必须 PASS（env 见 §7.1）
node scripts/ci/check-docs.mjs                                        # 文档门禁 + docSync
node team-hub/scripts/migrate-avatars.mjs --dry                       # 头像形态自检（期望：0 行需迁移）
```

### 步骤 1 · 构建

```powershell
# （步骤 0 的 migrate-avatars --dry 本次实测：扫描 0 行、迁移 0 行、exit 0 —— T210-evidence/migrate-avatars-dry.txt）
cd whiteboard ; node scripts/build.mjs                                  # B1，期望 exit 0
cd ..\workbench ; node node_modules/typescript/bin/tsc --noEmit        # B2，期望 exit 0
node node_modules/vite/bin/vite.js build                               # B3，普通终端期望 exit 0（产出 dist/）
```

### 步骤 2 · 发布物暂存（`stage`）

```powershell
node scripts/ci/run-ci.mjs --only build,stage   # 产出 releases/legion-<head>-<date>/{dist,MANIFEST.json,SHA256SUMS.txt}
```

> ⚠️ 本会话**未执行 `stage`**：它要求 `workbench/dist` 存在，而 `vite build` 在本沙箱被 EPERM 挡住（B3）。普通终端 `build` 通过后 `stage` 即可产出（`run-ci.mjs` 的 stage 段）。

### 步骤 3 · 部署（本机 acceptance / 生产同构）

```powershell
node team-hub/server.mjs                  # a) 中枢 :8787（必启，先起）
node workbench/scripts/serve.mjs --port 5173   # b) 指挥台托管 workbench/dist（改前端必须先重建）
```

- **无数据库迁移**：本次是读时投影，不新增表/列，**不要删库**；也无需跑 `seed-roster`。
- **无新增环境变量**：`TEAM_HUB_DB` / `TEAM_HUB_PORT` / `TEAM_HUB_TOKEN` 等沿用既有。
- **重启生效**：冻结表是进程内常量，改后需重启 hub 进程（或直接用新版本启动）才会生效。

### 步骤 4 · 验证（通过后按 [docs/DEPLOY.md](../../DEPLOY.md) §4.4 模板登记发布记录）

```powershell
node docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.mjs --out=<临时路径>.json   # 期望 verdict=PASS
# 浏览器：Ctrl+F5 强刷指挥台，核对
#   ① 侧栏目录里 soldier-a / soldier-b / soldier-auto / general 是人形头像（非灰剪影、非齿轮）
#   ② 侧栏底部用户卡 general 是图形头像（不是字符「⚙」）
#   ③ 左轨「空间管理员」徽标是图形头像（不是文字「管」）
#   ④ 技能授权标签里 general / soldier-* 也有头像
```

### 步骤 5 · 回滚 → 见 §6（触发条件不满足则不进入第 3 步）

**生产闸门**：本阶段**不含**生产发布动作；`scripts/update/publish.mjs` 签名发行、上传与通道指针替换**未执行**（未获批准，属边界「未获批准不发布生产」）。

## 5. 验证项清单（本次实测）

| # | 验证项 | 命令 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- | --- |
| V1 | whiteboard 构建 | `node scripts/build.mjs`（whiteboard） | exit 0 | exit 0 | ✅ |
| V2 | 前端类型门禁 | `tsc --noEmit`（workbench） | exit 0 | exit 0，0 诊断 | ✅ |
| V3 | CI 静态阶段 | `run-ci --only syntax,env,boundary,deps,doc` | 全 PASS | 4/5 PASS（`env` 红为既有，§7.1） | ⚠️（非本目标） |
| V4 | 受影响/回归套件 | §3.3 逐支 | 全绿 | 9 支 83/83，fail 0 | ✅ |
| V5 | 部署冒烟 | `deploy-smoke.mjs` | 非法 0 | HTTP 200、12 条、非法 0、verdict PASS | ✅ |
| V6 | 文档门禁 / docSync | `check-docs.mjs` | PASS | PASS（11 类） | ✅ |
| V7 | 前端打包 | `vite build`（workbench） | exit 0 | exit 1（esbuild EPERM，沙箱限制） | ⛔ 环境受限（§8） |
| V8 | 依赖 / 网络 | `workbench/package.json` dependencies | 零新增 | 恰好 5 个 | ✅ |
| V9 | 脏树诚实标注 | `run-ci` 脏树警告 | 如实打印 | 如实打印（已改 0 + 未跟踪 1~2） | ✅ |
| V10 | 头像形态预检 | `node team-hub/scripts/migrate-avatars.mjs --dry` | 0 行需迁移 | 扫描 0 行 / 迁移 0 行，exit 0 | ✅ |

## 6. 回滚方案

| 场景 | 操作 | 说明 |
| --- | --- | --- |
| 代码回滚 | `git revert <promote commit>` 或切回上一版发布物 | 桌面/移动端回到旧渲染（外部执行者回到灰阶占位/齿轮） |
| 数据回滚 | **不需要**：不落 `roster` 行、不写库，`tasks`/`agentCount`/`role` 契约均未变 | **不要删库、不要跑迁移** |
| 配置回滚 | 不需要：本次无新增环境变量、无端口变更 | — |
| 发布物回滚 | 本批未产出 `releases/` 产物（`stage` 需先有 `workbench/dist`）；回滚即切换回上一份 dist | — |
| 前端缓存 | 桌面：`Ctrl+F5` 强刷；移动端：SW 的**代码**走 `networkFirst`（`workbench/mobile/sw.js:121`），**非代码资源（图标/html）走 `cacheFirst`**——本次未改图片资产，若后续替换头像图片需更新 `CACHE` 版本或清缓存 | 见 `workbench/mobile/sw.js:31,121` |
| 回滚触发条件 | ① 4 条外部身份或 general 仍显示灰阶/齿轮；② 出现 emoji 头像；③ 同一空间内头像重复；④ `/api/roster` 500 / 条目数异常；⑤ `agentCount` 与实际花名册不一致 | 触发即回滚并保留现场 |
| 备份 | 升级前备份 `team-hub/team.db`（带时间戳副本） | 见 [docs/DEPLOY.md](../../DEPLOY.md) §6.1 |

## 7. 发布门禁与已知问题（放行前必须知情）

### 7.1 `env` 阶段红 = 既有问题，与本目标无关（已用对照证明）

真实 `run-ci` 的 `env` 阶段在本树报 `config scan: FAIL —— 13 项未在 schema 中处理`：

```text
✖ 未声明 env 键（6）：DSH_PROFILE, DSH_PROFILE_DIR, HOME, P, PATH, USERPROFILE
✖ 未处理字面量（4）：ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, OPENAI_API_KEY
✖ [runtime] 未声明动态读取（3）：runtime/adapters/dsh/provider-readiness.mjs → env[baseUrlKey] / env[k] / env[key]
```

对照证据：

- 在**集成分支 main worktree**（`D:\project\DSH\legion`，HEAD 同为 `f6f1f412`）上运行同一条 `node scripts/config/scan.mjs --check`，**同样 13 项、同样 FAIL**（`T210-evidence/env-scan-pre.txt`）；本 worktree 读数完全一致（`T210-evidence/env-scan-post.txt`）。
- T-207 的改动文件清单（`T210-evidence/t207-changed-files.txt`，16 个文件）与上述失败文件**零交集**；T-210 只新增 `docs/G-mv7kzgnu-1/DEPLOY.md` 与 `T210-evidence/`，也不在扫描面内。

⇒ 结论：`env` 红是**集成分支既有的 config-schema 登记缺口**，不是本次交付引入的回归；修复归属 config/runtime 模块而非本目标（本角色边界：不改业务功能代码）。**建议另立 bug/目标任务**把上述 13 项补进对应 `config-schema` 或 `FOREIGN_DYNAMIC_SUBSCRIPTS`。

### 7.2 未执行项（不虚报）

| 项 | 原因 |
| --- | --- |
| `stage` / `smoke` 阶段 | 需要 `workbench/dist`，而 `vite build` 被沙箱 EPERM 挡住（B3） |
| `test` 阶段经真实 `run-ci` 直跑 | `node --test` 内部 runner 经原语直接 `spawn` 子进程，绕过 public `child_process` 补丁 ⇒ 一律 EPERM（§8） |
| DSH 外部包回归（`plugins/`、`board-plugin/`） | 本机未配 `DSH_CHECKOUT`；真实 `run-ci` 与 CI 同纪律整组 SKIP，不伪造通过 |
| 浏览器 E2E / 人工目视 | 本环境无浏览器、无第三方独立评审人（与 T-209 §2.5、§7 同口径）；改用部署冒烟（真 hub + 真 HTTP）+ 套件断言 |
| 生产发布 | 未获将军批准（边界：未获批准不发布生产） |

### 7.3 容量与边界（沿用上游裁决，非本次回归）

- **未登记的新外部名字**按确定性规则在空闲备用位面 `s01..s10` 兜底，**池满回落空串**（占位人形，绝不产 emoji）。R-8 在 TASK_BREAKDOWN §6 已裁决为「非门槛 · 默认不满足」，T-209 按非必过口径记录，**本阶段同样不判为回归**。
- 3D 场景（`Employee3D` 的 external 灰人）与「· 执行中」文案**不在本目标**（D-4/D-2），本次未改。

## 8. 本会话沙箱限制（如实标注，不冒充通过）

- **现场**：`spawn EPERM`（`node:internal/child_process:458`）。受限沙箱禁止 Node 进程创建**管道** stdio：`spawn/spawnSync` 默认 pipe ⇒ EPERM；`inherit`/`ignore`/文件 fd ⇒ 正常（`T210-evidence/build-vite.txt`、`ci-run-build.txt`）。
- **为取证据所做的适配（不改变被测行为）**：`T210-evidence/ci-sandbox-patch.cjs`（复制自 T-202 同类补丁，附出处说明）把「一次性捕获输出」的子进程管道换成**临时文件 fd**，子进程仍真执行、真退出、输出逐字节回放；对**交互式**子进程（esbuild 常驻服务）**保持原样**，让沙箱限制如实暴露成 EPERM（因此 `vite build` 仍红）。
- 该补丁与 `deploy-smoke.mjs` / `run-deploy-verify.ps1` 均为**证据工具（非产品代码）**，不改变任何被测行为。

## 9. 证据清单

| 文件 | 内容 |
| --- | --- |
| [`T210-evidence/README.md`](./T210-evidence/README.md) | 证据目录说明与复跑命令 |
| [`T210-evidence/target-suites.txt`](./T210-evidence/target-suites.txt) | 9 支套件 `tests/pass/fail` 与退出码（83/83） |
| [`T210-evidence/build-tsc.txt`](./T210-evidence/build-tsc.txt) · [`build-whiteboard.txt`](./T210-evidence/build-whiteboard.txt) · [`build-vite.txt`](./T210-evidence/build-vite.txt) | B1/B2/B3 命令与退出码 |
| [`T210-evidence/ci-run-static.txt`](./T210-evidence/ci-run-static.txt) · [`ci-run/summary.json`](./T210-evidence/ci-run/summary.json) | 真实 `run-ci` 静态阶段完整输出与机读汇总 |
| [`T210-evidence/ci-run-green.txt`](./T210-evidence/ci-run-green.txt) · [`ci-run-green/summary.json`](./T210-evidence/ci-run-green/summary.json) | 去掉既有红 `env` 的真实 `run-ci` 绿基线（4/4 PASS，exit 0） |
| [`T210-evidence/ci-run-build.txt`](./T210-evidence/ci-run-build.txt) · [`ci-run-build/summary.json`](./T210-evidence/ci-run-build/summary.json) | 真实 `run-ci --only build` 输出与汇总 |
| [`T210-evidence/deploy-smoke.json`](./T210-evidence/deploy-smoke.json) · [`deploy-smoke.mjs`](./T210-evidence/deploy-smoke.mjs) | 部署冒烟结果与探针源码 |
| [`T210-evidence/env-scan-pre.txt`](./T210-evidence/env-scan-pre.txt) · [`env-scan-post.txt`](./T210-evidence/env-scan-post.txt) | `env` 阶段红的对照证据（main worktree vs 本 worktree） |
| [`T210-evidence/migrate-avatars-dry.txt`](./T210-evidence/migrate-avatars-dry.txt) | 头像形态预检（0 行需迁移） |
| [`T210-evidence/t207-changed-files.txt`](./T210-evidence/t207-changed-files.txt) | T-207 改动文件清单（对照 §7.1） |
| [`T210-evidence/docsync-grep.txt`](./T210-evidence/docsync-grep.txt) · [`ci-check-docs.txt`](./T210-evidence/ci-check-docs.txt) | docSync 三处命中与文档门禁原始输出 |
| [`T210-evidence/ci-sandbox-patch.cjs`](./T210-evidence/ci-sandbox-patch.cjs) · [`run-deploy-verify.ps1`](./T210-evidence/run-deploy-verify.ps1) | 沙箱 stdio 适配补丁与批量验证脚本（非产品代码） |
