<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本文件记录 T-199（编码实现）交付时的实现口径与自测读数，只代表当时基线。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/FEATURES.md](../FEATURES.md)（功能手册）。
<!-- evidence-banner:end -->

# T-199 编码实现：Agent 人性化名称 + 人性化头像

> 阶段：编码实现（coder）｜任务：T-199（[auto-goal]，所属目标 G-mv1s6y49-1 · software · chain）
> 上游：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-195）→ [RESEARCH.md](./RESEARCH.md)（T-196）→ [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md)（T-197 七切片）→ [TEST_CASES.md](./TEST_CASES.md)（T-198 六套件骨架）
> 目标上下文（将军裁决 v1）：创建时自动生成头像、暂不需要配置；头像必须拟人且非 emoji；范围含全部（含后续自建）；两段式命名。
> 下游：T-200 reviewer → T-201 tester（TEST_REPORT.md）→ T-202 devops（DEPLOY.md）

## 1. 实现口径速览

- **展示名（两段式）**：第一段是拟人称呼（2~6 汉字），第二段是既有 kind 职能副标题。展示名是 role 的单射函数 → 同空间唯一、跨空间同 role 同名自动成立。
- **头像**：令牌 `human:<key>`；内置 25 岗位 `key = role`，自建 role 由服务端按该空间最小未占用备用位面 `s01`..`s15` 分配。渲染 = 参数化人形**内联 SVG**（零第三方依赖、零图片资源、零网络，确定性无随机）。
- **单一来源**：桌面 12 个展示面 + 移动端统一取 roster 的 `name`/`avatar`；移除中心面板动物表、名称首字头像、新建弹窗 emoji 下拉三套旧来源。
- **回退**：缺失/非法/旧 emoji 令牌 → 确定性灰阶占位人形；回退只是渲染态，**不写回 roster**。
- **不做**（依将军裁决与拆解边界）：成员编辑入口（暂不需要配置）、3D 人物外观联动（O-3 不联动，只保证 3D 标签名称同源）、头像上传/在线图床、改 `role` 契约键。

## 2. 25 名成员最终名单（❓O-1 / AC-R1-4 待将军确认的草案）

| 空间 | role（契约键，未改） | 展示名 | 职能副标题（kind） | 头像令牌 |
| --- | --- | --- | --- | --- |
| software（软件流水线） | `requirement` | 析言 | 需求澄清与拆解 | `human:requirement` |
| software（软件流水线） | `researcher` | 探微 | 技术选型与搜索 | `human:researcher` |
| software（软件流水线） | `breaker` | 分略 | 任务拆分与依赖规划 | `human:breaker` |
| software（软件流水线） | `test-designer` | 构验 | 用例设计与验收标准 | `human:test-designer` |
| software（软件流水线） | `coder` | 衡码 | 实现与自测 | `human:coder` |
| software（软件流水线） | `reviewer` | 鉴微 | 质量审查与反馈 | `human:reviewer` |
| software（软件流水线） | `tester` | 寻瑕 | 执行用例与回归 | `human:tester` |
| software（软件流水线） | `devops` | 启舟 | CI/CD 与发布 | `human:devops` |
| marketing（市场部） | `market-analyst` | 观市 | 市场洞察与竞品分析 | `human:market-analyst` |
| marketing（市场部） | `content-planner` | 谋篇 | 选题与内容产出 | `human:content-planner` |
| marketing（市场部） | `ad-optimizer` | 定投 | 广告投放与 ROI 优化 | `human:ad-optimizer` |
| marketing（市场部） | `growth-hacker` | 拓流 | 增长实验与渠道 | `human:growth-hacker` |
| marketing（市场部） | `brand-copy` | 润声 | 品牌表达与文案 | `human:brand-copy` |
| product（产品部） | `product-manager` | 谋远 | 需求定义与路线图 | `human:product-manager` |
| product（产品部） | `ux-designer` | 疏径 | 交互流程与原型 | `human:ux-designer` |
| product（产品部） | `ui-designer` | 绘色 | 界面视觉与设计规范 | `human:ui-designer` |
| product（产品部） | `user-researcher` | 问真 | 用户洞察与调研 | `human:user-researcher` |
| product（产品部） | `data-analyst` | 明数 | 数据指标与洞察 | `human:data-analyst` |
| ops（运营部） | `ops-specialist` | 理常 | 日常运营执行 | `human:ops-specialist` |
| ops（运营部） | `campaign-planner` | 造势 | 活动方案与执行 | `human:campaign-planner` |
| ops（运营部） | `support-lead` | 解忧 | 客户反馈与 SLA | `human:support-lead` |
| ops（运营部） | `data-ops` | 呈数 | 运营数据与报表 | `human:data-ops` |
| default（我的空间） | `assistant` | 小通 | 日常事务与杂务 | `human:assistant` |
| default（我的空间） | `research-assistant` | 小辑 | 信息检索与整理 | `human:research-assistant` |
| default（我的空间） | `writer` | 执笔 | 文档与文案 | `human:writer` |

## 3. 切片落地

| 切片 | 落地文件 | 说明 |
| --- | --- | --- |
| S1 头像基座 | `workbench/src/avatar/{types.ts,slots.ts,AgentAvatar.tsx,index.ts,avatar.css}`、`workbench/scripts/agent-avatar.test.mjs` | 位面表（25 + s01..s15 = 40，构造性两两不同）、`resolveSlot` / `slotKeys` / `assertSlotTable`、组件 props 冻结契约 |
| S2 数据面 | `team-hub/scripts/seed-roster.mjs`（+ 测试）、`team-hub/agent-avatars.mjs` | 两段式种子、导出 `buildRosterSeed` / `applyRosterSeed`、迁移只替换旧默认值白名单 |
| S3 接口面 | `team-hub/routes/agent-intake.mjs`、`team-hub/routes/team-views.mjs`、`team-hub/agent-intake-routes.test.mjs`、`team-hub/agent-identity-tokens.test.mjs` | 新建自动分配令牌（不落 emoji/非法串）、读出口成员头像收敛为令牌或占位语义（外部执行者 `⚙️` 不变） |
| S4 展示面（一） | `WorkspaceNavigation.tsx`、`AgentWorkspace.tsx`、`CenterPanel.tsx`、`SceneAgentList.tsx`（+ 扫描测试） | 删除首字头像与动物表，四处改用 `<AgentAvatar>` |
| S5 展示面（二） | `NewSpaceModal.tsx`、`ModelConfigModal.tsx`、`SkillsPanel.tsx`、`AgentTasksModal.tsx`（+ 扫描测试） | 删除 emoji 下拉与缺省 `🤖`、请求体不提交 avatar；三处成员头像分层渲染 |
| S6 移动端 | `workbench/mobile/avatar.mjs`、`app.mjs`、`index.html`、`sw.js`、`avatar-parity.test.mjs` | 位面表镜像 + parity 测试；成员选择新增头像药丸条（`option` 装不下图形）；SW 预缓存补 `avatar.mjs` |
| S7 收口 | `scripts/ci/run-ci.mjs`、`README.md`、`workbench/README.md`、`docs/FEATURES.md`、`docs/STATUS.md` | 六个新测试登记进 CI 套件清单；功能手册/索引/引导段同步 |

## 4. 自测命令与读数（本 worktree 实测）

| 命令 | 读数 |
| --- | --- |
| `node workbench/scripts/agent-avatar.test.mjs` | 9 pass / 0 fail |
| `node workbench/scripts/agent-avatar-surfaces.test.mjs` | 5 pass / 0 fail |
| `node workbench/scripts/agent-avatar-settings.test.mjs` | 6 pass / 0 fail |
| `node team-hub/scripts/seed-roster.test.mjs` | 6 pass / 0 fail |
| `node team-hub/agent-identity-tokens.test.mjs` | 9 pass / 0 fail |
| `node workbench/mobile/avatar-parity.test.mjs` | 6 pass / 0 fail |
| `node team-hub/agent-intake-routes.test.mjs` | 21 pass / 0 fail（基线不回归） |
| `node team-hub/team-views-routes.test.mjs` | 17 pass / 0 fail（基线不回归） |
| `node team-hub/read-models-routes.test.mjs` | 25 pass / 0 fail（基线不回归） |
| `node workbench/mobile/board.test.mjs` / `timeline.test.mjs` / `refresh-loop.test.mjs` | 21 / 16 / 6 pass / 0 fail |
| `node workbench/scripts/sw-shell.test.mjs` | 6 pass / 0 fail（预缓存清单覆盖 `avatar.mjs`） |
| `node workbench/scripts/identity-gate.test.mjs` | 19 pass / 0 fail（身份红线不回归） |
| `node node_modules/typescript/bin/tsc --noEmit`（cwd=`workbench`） | exit 0 |
| `node scripts/ci/check-docs.mjs` | PASS（11 类校验项全绿） |

> 沙箱限制：`node node_modules/vite/bin/vite.js build` 因 esbuild 需要 spawn 子进程而 `spawn EPERM`；
> 本条为环境限制（与 TASK_BREAKDOWN §8.1 一致），前端门禁以 `tsc --noEmit` 为等价口径，全量 `run-ci` 由 T-202 在有完整权限环境执行。

## 5. 假设与已知取舍

- 令牌与备用池为 TASK_BREAKDOWN §7 冻结契约；`s01`..`s15` 用尽后确定性地回退 `human:<role>`（不随机、不复用他人令牌）。
- 迁移保护按「旧职称名白名单 + 旧 emoji/非令牌」判定：白名单内或非法头像被替换，其余用户自定义值保留；自建 role 行不动。
- 成员编辑入口（R-6）与头像上传按将军裁决与拆解边界**不做**；`POST /api/agents` 的 upsert 能力保留（兼容）。
