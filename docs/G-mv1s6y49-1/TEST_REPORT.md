<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本文反映 **2026-10-10**（w/T-201 HEAD `c1ec9496`，含 T-199 `02da65f4` / 合并 `05e1bd41`） 的测试执行基线，其中的 file:line、命令与读数只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-201 测试执行报告：Agent 人性化名称 + 人性化头像

> 角色：tester（测试执行）｜阶段：测试执行｜执行任务：T-201（[auto-goal]｜所属目标 G-mv1s6y49-1 · software · chain）
> 上游：T-198 [TEST_CASES.md](./TEST_CASES.md)（101 条用例）← T-199 [IMPLEMENTATION.md](./IMPLEMENTATION.md)（编码）← T-200 [../review/T-200-REVIEW.md](../review/T-200-REVIEW.md)（代码审查，2 项必须修改 M1/M2）
> 目标上下文（将军裁决 v1）：创建时自动生成头像、暂不需要配置；头像必须拟人且非 emoji；范围含全部（含后续自建）；两段式命名；第 5 条被截断待补。
> 执行人：T-201 tester（本任务单人执行）。边界：**只执行、只报告；不改产品代码、不修 bug**（负例注入类用例因此不执行，见 §7）。

## 0. 结论（TL;DR）

- **判定：❌ FAIL（未全绿）。** 六支新套件 **41/41 全绿**、九支关键基线 **133 例全绿**、`tsc --noEmit` exit 0、`check-docs` PASS、CI 登记 6/6 —— 主路径与 25 个内置岗位全部通过。
- **但独立探针复现了 2 项真实失败（均为 T-200 已列"必须修改"）**：
  1. **M1（TC-S3-14 失败）**：服务端备用位面池越界（分配 `s01`..`s99`，两端位面表只有 `s01`..`s15`）→ 第 16 个自建成员起渲染为**同一占位人形**，破坏 AC-R3-3「可区分」。
  2. **M2（S3 幂等/确定性契约失败，无独立 TC 条目）**：同一自建 role 重复 `POST /api/agents` 头像漂移 `s01 → s02 → s01`，与 IMPLEMENTATION.md「role 单射/确定性」矛盾。
- 归属：两项均在 **T-199 编码实现**；修复动作不在 tester 职责内（本报告只给复现步骤与定位）。回归范围内无其它失败。
- 参考团队经验 **exp-t092「回归复跑先查上游验证防空转」**：先核对上游交付状态（T-199 `02da65f4` 已合入、T-200 已独立复跑 41/41），据此**不铺全量 573 文件 CI**（T-202 devops 职责），只对本次新增 6 条登记做逐条核对并以真命令复跑本目标相关套件与基线。

## 1. 执行环境

| 项 | 值 |
| --- | --- |
| 工作目录 | `D:\project\DSH\legion\.legion-worktrees\T-201`（分支 `w/T-201`） |
| HEAD | `c1ec9496ea4d971cc257b4e4a608ed8f8e0ce36f`（promote T-200；含 T-199 `02da65f4` 与合并 `05e1bd41`） |
| Node | `v24.19.0`（Windows） |
| 工作树状态 | 执行前 `git status --short` 干净；本报告与证据文件为 T-201 自身产物 |
| 数据隔离 | 所有套件/探针使用 `TEAM_HUB_DB=mkdtemp()/team.db` 临时库 + `server.listen(0)` 空闲端口；**未触碰 live `team-hub/team.db`**，未改任何产品源码 |
| 证据目录 | `docs/G-mv1s6y49-1/T201-evidence/`（本报告附件，见 §8） |

## 2. 执行结果总表

### 2.1 六支新增套件（S1~S6）——T-198 用例的 L0/L1 载体

| 套件 | 命令 | 用例读数 | 退出码 |
| --- | --- | --- | --- |
| S1 头像基座 | `node workbench/scripts/agent-avatar.test.mjs` | **9 pass / 0 fail** | 0 |
| S2 数据面 | `node team-hub/scripts/seed-roster.test.mjs` | **6 pass / 0 fail** | 0 |
| S3 接口面 | `node team-hub/agent-identity-tokens.test.mjs` | **9 pass / 0 fail** | 0 |
| S4 展示面（一） | `node workbench/scripts/agent-avatar-surfaces.test.mjs` | **5 pass / 0 fail** | 0 |
| S5 展示面（二） | `node workbench/scripts/agent-avatar-settings.test.mjs` | **6 pass / 0 fail** | 0 |
| S6 移动端 | `node workbench/mobile/avatar-parity.test.mjs` | **6 pass / 0 fail** | 0 |
| **合计** | | **41 pass / 0 fail** | — |

### 2.2 回归基线（9 支，133 例全绿）

| 套件 | 读数 | 退出码 |
| --- | --- | --- |
| `team-hub/agent-intake-routes.test.mjs` | 21 pass / 0 fail | 0 |
| `team-hub/team-views-routes.test.mjs` | 17 pass / 0 fail | 0 |
| `team-hub/read-models-routes.test.mjs` | 25 pass / 0 fail | 0 |
| `workbench/scripts/doc-render.test.mjs` | 11 pass / 0 fail | 0 |
| `workbench/scripts/identity-gate.test.mjs` | 19 pass / 0 fail | 0 |
| `workbench/scripts/sw-shell.test.mjs` | **7** pass / 0 fail | 0 |
| `workbench/mobile/board.test.mjs` | 21 pass / 0 fail | 0 |
| `workbench/mobile/timeline.test.mjs` | 16 pass / 0 fail | 0 |
| `workbench/mobile/refresh-loop.test.mjs` | 6 pass / 0 fail | 0 |

### 2.3 门禁

| 门禁 | 命令 | 读数 |
| --- | --- | --- |
| 前端类型检查 | `node node_modules/typescript/bin/tsc --noEmit`（cwd=`workbench`） | **exit 0**，无类型错误 |
| 文档门禁 | `node scripts/ci/check-docs.mjs` | **PASS**（11 类校验全绿；含本报告与证据 README 后复跑，16195 个表行，收尾/孤儿行 0） |
| CI 登记（S7） | 逐条核对 `scripts/ci/run-ci.mjs` 与文件存在性 | 6/6 均**已登记且实际存在**（无缺、无多） |

## 3. 逐用例执行记录（对 T-198 的 101 条用例）

> 状态图例：✅ PASS（已执行且绿）｜❌ FAIL（已执行且红）｜⏸ NOT EXECUTED（未执行，原因见 §7）。
> 每条的证据列指向 §2 的套件读数或 §4/§5 的探针读数。

### 3.1 S1 头像基座（17 条：✅14 / ⏸3）

| ID | 状态 | 环境 / 步骤 | 实际结果与证据 |
| --- | --- | --- | --- |
| TC-S1-01 | ✅ | `agent-avatar.test.mjs`：renderToString(token=human:requirement) | `<svg` 存在、去标签后文本为空（无 emoji/首字文本节点） |
| TC-S1-02 | ✅ | 25 个 `human:<role>` 各渲染一次 | 标记串 Set 大小 = 25 |
| TC-S1-03 | ✅ | 读 `slotKeys()` | 25 岗位 ∪ s01..s15 = 40，两两不同、单射 |
| TC-S1-04 | ✅ | 同 token 两次渲染 + 源码静态扫描 | 逐字节相同；无 `Math.random`/`Date.now`/`performance.now`/`fetch`/http(s) |
| TC-S1-05 | ✅ | token = undefined/null/''/'   ' | 均渲染确定性占位人形，不抛错、无 emoji |
| TC-S1-06 | ✅ | token = 🤖/🧭/⚙️ | 均回退占位人形，输出无 emoji 码点 |
| TC-S1-07 | ✅ | 非法令牌 human:/human:UNKNOWN/human:a/../b | 均确定性回退，无未捕获异常 |
| TC-S1-08 | ✅ | props/size/className 渲染 | 默认导出、size 生效、className 透传 |
| TC-S1-09 | ✅ | 扫描 `workbench/src/avatar/` | 无 `<img`、无 `url(` 外链、无网络调用 |
| TC-S1-10 | ✅ | 比对 `workbench/package.json` | dependencies 仍为原 5 项，零新增 |
| TC-S1-11 | ✅ | `tsc --noEmit`（cwd=workbench） | exit 0（§2.3） |
| TC-S1-12 | ✅ | 扫描身份键用法 | `avatar/name` 不进 key/UNIQUE/PRIMARY KEY |
| TC-S1-13 | ✅ | 探针 PROBE-F：size 0/-1/1024/64/缺省 | width = 32/32/32/64/32（非法值归一到 32，可重复） |
| TC-S1-14 | ⏸ | 需注入重复位面（改代码） | 见 §7（不执行） |
| TC-S1-15 | ⏸ | 需注入 Math.random（改代码） | 见 §7 |
| TC-S1-16 | ⏸ | 需注入外链/依赖（改代码） | 见 §7 |
| TC-S1-17 | ✅ | token=🤖 且 name='析言' | 输出不含「析」文本节点 |

### 3.2 S2 数据面（16 条：✅14 / ⏸2）

| ID | 状态 | 实际结果与证据 |
| --- | --- | --- |
| TC-S2-01/02/03/04 | ✅ | 空库播种 25 行：name 全匹配 `^[\u4e00-\u9fa5]{2,6}$` 且无机器键字符；同空间重名 0；avatar 全为 `human:<key>`；`🤖`=0；跨空间同 role name/avatar 各单值 |
| TC-S2-05 / 08 | ✅ | 连播两次逐行相同；行数与 (scope,role) 主键集合前后相等 |
| TC-S2-06/07/14 | ✅ | 自定义 `name='我起的名字'/avatar='human:zz9'` 重跑保留；旧职称名+emoji 行被替换；反向（无条件覆盖）能被区分 |
| TC-S2-09/11/12 | ✅ | kind 均非空、role 契约键 25 个不变、schema 无 name/avatar 唯一约束 |
| TC-S2-13 | ✅ | `buildRosterSeed()` 纯函数与 CLI 读数一致 |
| TC-S2-16 | ✅ | 自建 role 行保留、缺失 space 行补齐、行数符合预期 |
| TC-S2-10 | ⏸ | 注入 4 类坏名（改数据门禁）见 §7 |
| TC-S2-15 | ⏸ | 注入归一化重名（改代码/门禁）见 §7 |

### 3.3 S3 接口面（17 条：✅15 / ❌1 / ⏸1）

| ID | 状态 | 实际结果与证据 |
| --- | --- | --- |
| TC-S3-01/02 | ✅ | 不带/空/🤖 avatar → 落库 `human:requirement`；`🤖` 计数 0 |
| TC-S3-03 | ✅ | 两个自建 role 取最小未占用 `s01`/`s02` 且互不相同（**单次创建**路径） |
| TC-S3-04 | ✅ | 5 个 scope 同 role 恒同令牌 |
| TC-S3-05/06 | ✅ | 空名/非法 role（大写/空格/中文/65 字符/空串）均 400 且库零写入 |
| TC-S3-07 | ✅ | `/api/roster` 对缺 avatar / 旧 emoji 收敛为 `''`（占位语义），合法令牌原样；无 emoji |
| TC-S3-08 | ✅ | `/api/agents` 同 role name/avatar 首见合并为单值 |
| TC-S3-09/10 | ✅ | 选人入编原样复制令牌；读端点零写入（`/api/roster`、`/api/agents` 纯读，audit 无新增） |
| TC-S3-11/12 | ✅ | 三支基线 21/17/25 全绿（§2.2）；新增套件 exit 0 |
| TC-S3-13 | ✅ | `not-a-token`/`<img ...>`/`🤖🦊` 均不原样落库（分别归一为 `human:coder`） |
| **TC-S3-14** | **❌ FAIL** | **探针 PROBE-2：第 16 个自建 role 落库 `human:s16`，但两端位面表无 `s16`（`slotKeys().length=40`、`resolveSlot('human:s16')=null`）→ 渲染同一占位人形。详见 §4.1（M1）。** |
| TC-S3-15 | ✅ | 探针 PROBE-C：无 `by` 的 POST → HTTP 400 且库行数 0（未新增绕过路径） |
| TC-S3-16 | ⏸ | 跨空间分叉注入（改库）见 §7 |
| TC-S3-17 | ✅ | 探针 PROBE-B：kind 缺省落 `''`；sort 0/1/2 严格递增 |

### 3.4 S4 展示面（一）（13 条：✅10 / ⏸3）

| ID | 状态 | 实际结果与证据 |
| --- | --- | --- |
| TC-S4-01/02/04 | ✅ | 四个组件均含 `<AgentAvatar`；`name.slice(0, 1)` 已清除 |
| TC-S4-03/05 | ✅ | `CenterPanel.tsx` 动物表 `AVATARS`、`i % 8` 轮换已删除；第二套来源 0 |
| TC-S4-06 | ✅ | 头像取值只来自 roster 令牌或统一空值回退 |
| TC-S4-07 | ✅ | `tsc --noEmit` exit 0 |
| TC-S4-09 | ✅ | 四个面均无 `<img`/外链 → 无破图来源 |
| TC-S4-11 | ✅ | `identity-gate.test.mjs` 19 例不回归 |
| TC-S4-12 | ✅ | 源码核对：`sceneState.ts:75` `appearanceSeed = identitySeed(scope\0role)`，`Employee3D` 消费 appearanceSeed；`AgentAvatar` 不消费它（O-3 不联动、标签 name 同源 roster） |
| TC-S4-08 | ⏸ | 四组件跨面渲染比对未自动化（需 renderToString 四组件/浏览器）见 §7 |
| TC-S4-10 | ⏸ | 逐面 `''/🤖/human:UNKNOWN` 边界渲染未自动化 |
| TC-S4-13 | ⏸ | 反向注入（改代码）见 §7 |

### 3.5 S5 展示面（二）（11 条：✅11）

| ID | 状态 | 实际结果与证据 |
| --- | --- | --- |
| TC-S5-01/02 | ✅ | `NewSpaceModal.tsx` 无 `AVATAR_CHOICES`、无缺省 `avatar: '🤖'`；请求体不提交 avatar |
| TC-S5-03/04/05 | ✅ | 三处改用 `<AgentAvatar`；SkillsPanel 不再拼 `${a.avatar} ${a.name}` |
| TC-S5-06 | ✅ | 四个文件无第二套硬编码头像表 |
| TC-S5-07 | ✅ | `tsc --noEmit` exit 0 |
| TC-S5-08 | ✅ | 未新增「编辑资料/成员编辑/头像上传」入口（将军裁决 #1 反向锚定） |
| TC-S5-09 | ✅ | 旧 emoji/空令牌统一走组件回退 |
| TC-S5-10 | ✅ | `createAgent` 签名兼容（可选 avatar 保留） |
| TC-S5-11 | ✅ | `identity-gate.test.mjs` 19 例不回归 |

### 3.6 S6 移动端（9 条：✅7 / ⏸2）

| ID | 状态 | 实际结果与证据 |
| --- | --- | --- |
| TC-S6-01 / 01b | ✅ | 桌面 `slots.ts` 与 `mobile/avatar.mjs` 的 key 集合与**每个 key 的位面字段**逐项相同 |
| TC-S6-02/03 | ✅ | 25 岗位渲染 `<svg`、无文本节点、两两不同；成员选择不再只有 `<option>` 纯文本 |
| TC-S6-04 | ✅ | 非法/缺失令牌降级为纯名称、不抛错、无 emoji |
| TC-S6-05 | ✅ | 三支移动端基线 21/16/6 全绿 |
| TC-S6-06 / 06b | ✅ | 不 import 桌面 TS 源、无网络调用；成员选择结构已改 |
| TC-S6-09 | ✅ | 移动端无 fetch/http(s)；T-199 diff 未改任何 `package.json`（零新增依赖） |
| TC-S6-07 | ⏸ | 空列表/单成员/30+ 成员列表渲染需 app 运行环境，见 §7 |
| TC-S6-08 | ⏸ | 反向注入 key 漂移（改代码）见 §7 |

### 3.7 S7 收口（10 条：✅8 / ⏸2）

| ID | 状态 | 实际结果与证据 |
| --- | --- | --- |
| TC-S7-02 | ✅ | 6 条登记路径全部存在、无「登记了但不存在」与「存在但未登记」 |
| TC-S7-03 | ✅ | `check-docs.mjs` PASS（11 类校验全绿） |
| TC-S7-04 | ✅ | `workbench/README.md:82-83,93` 已改为两段式展示名 + `human:<role>` 人形头像口径，无过程叙事 |
| TC-S7-05 | ✅ | `docs/FEATURES.md:71-75` §3.2 已更新；功能索引结构未破 |
| TC-S7-06 | ✅ | `docs/STATUS.md:24-28` 已登记 6 个新套件与本地读数；数字 headline（195/5712）显式声明由 T-202 全量复跑后更新——与 T-198 §2「L4 CI 由 T-202 执行」一致 |
| TC-S7-08 | ✅ | README/FEATURES/workbench README 未把职称名/emoji 头像作为**现状**描述（仅迁移语境提及旧值） |
| TC-S7-09 | ✅ | `docs/G-mv1s6y49-1/*.md` 均带 `evidence-banner`（本报告亦带） |
| TC-S7-10 | ✅ | 本批新增恰好 6 个 `*.test.mjs`；`run-ci.mjs` 的 EXEMPT 表未被用于本批 |
| TC-S7-01 | ⏸ | 全量 `run-ci --only test`（573 个 `*.test.mjs`）未执行，T-202 职责；新增 6 条的清单完备性已单独核对 ✅ |
| TC-S7-07 | ⏸ | 从 CI 删登记的反向注入（改代码）见 §7 |

### 3.8 E2E（8 条：✅2 / ⏸6）

| ID | 状态 | 说明 |
| --- | --- | --- |
| E2E-1 | ✅ | 探针 PROBE-3：临时库播种 25 行，5 空间合规 name + `human` 令牌、`🤖`=0、空名 0、跨空间分叉 0 |
| E2E-8 | ✅ | 全仓扫描：`key={...avatar}` 命中 **0**；3 处 `key={...name}` 均为**其它实体**（`Sidebar` 工作空间名、`FolderPickerModal` 目录名、`FilesView` 文件名），非 roster 成员，且 T-199 `02da65f4` 未改这三个文件（基线既有） |
| E2E-2 | ⏸ | 13 展示面 × 5 空间 × 25 成员的浏览器遍历：本环境无浏览器/无 Workbench 启动（见 §7） |
| E2E-3 | ⏸ | 断网端到端构建+启动：未执行；静态面（无网络调用、零新增依赖）已由 TC-S1-09/10、TC-S6-09 覆盖 |
| E2E-4 | ⏸ | 改名后 `agent_id`/会话/任务归属不变：schema 层由 TC-S2-12 覆盖，完整端到端未执行 |
| E2E-5 | ⏸ | `AC-R3-2` 人形可辨 / `AC-R1-2` 名称人性化的人工评审：**无独立评审人**，未执行（见 §7） |
| E2E-6 | ⏸ | 旧值注入后的逐展示面遍历未执行；渲染回退与「不写回」已由 TC-S1-05/06/07/17、TC-S3-10 覆盖 |
| E2E-7 | ⏸ | 新建自建成员的跨展示面端到端未执行；令牌分配由 TC-S3-03 覆盖、单一来源由 S4/S5 源码扫描覆盖 |

## 4. 失败项详述（复现步骤 + 归属）

> 两项均由独立探针 `docs/G-mv1s6y49-1/T201-evidence/probe-avatar-boundary.mjs` 在**临时库 + 真端口**复现（原始输出 `probe-output.txt`）。**tester 只报告，不修复。**

### 4.1 M1 —— 备用位面池越界，第 16 个自建成员起退化为同一占位人形（TC-S3-14 ❌）

- **归属**：T-199 编码实现。定位：
  - `team-hub/agent-avatars.mjs:35` `for (let i = 1; i <= 99; i += 1)` —— 服务端分配 `s01`..`s99`
  - `workbench/src/avatar/slots.ts:22` `SPARE_KEYS = 15 个（s01..s15）`
  - `workbench/mobile/avatar.mjs:19` 镜像同样 15 个
  - 冻结契约：`docs/G-mv1s6y49-1/TASK_BREAKDOWN.md` §7「备用 key s01..s15」
- **前置条件**：临时空库（`TEAM_HUB_DB=mkdtemp/team.db`）+ 真监听端口。
- **复现步骤**：
  1. `node docs/G-mv1s6y49-1/T201-evidence/probe-avatar-boundary.mjs`
  2. 探针在 `software` 空间连续 `POST /api/agents { by:'general', role:'custom-01'..'custom-16', name:'自建N' }`（均不传 avatar）。
- **实际结果**（探针原文）：
  ```
  PROBE-2 连续 16 个自建 role 落库 avatar: human:s01, human:s02, ..., human:s15, human:s16
  PROBE-2 第 16 个令牌=human:s16
  PROBE-2 移动端位面表 slotKeys 长度=40 含s15=true 含s16=false
  PROBE-2 移动端 resolveSlot("human:s16")=null
  PROBE-2 移动端 renderAvatar("human:s16") === renderAvatar(null)（是否退化为占位）: true
  PROBE-2 桌面真源 slots.ts slotKeys 长度=40 含s15=true 含s16=false
  PROBE-2 桌面真源 resolveSlot("human:s16")=null
  ```
- **影响**：第 16 个及以后的自建成员虽落库了 `human:s16` 等令牌，但两端都解析不到位面 → 全部渲染**同一个**灰阶占位人形，**违反 AC-R3-3「同空间任意两人不同」**；且与冻结契约（`s01`..`s15`）冲突。触发条件为同一 scope ≥16 个自建 role。
- **修复建议（供归属方参考，不由 tester 执行）**：二选一并使三处口径一致——(a) 分配上限改 15 并在契约中写清「池满后的确定语义」且被测试钉住；或 (b) 位面表扩到 `s01`..`s99`（`slots.ts` + `mobile/avatar.mjs` + parity 测试同步）并更新 TASK_BREAKDOWN §7 / IMPLEMENTATION.md。

### 4.2 M2 —— 同一自建 role 重复 POST 头像漂移（S3 幂等/确定性契约 ❌）

- **归属**：T-199 编码实现。定位：
  - `team-hub/routes/agent-intake.mjs:86-89`：未传合法令牌时**无条件**调用 `allocateAvatarToken`，且 upsert 的 `DO UPDATE SET avatar=excluded.avatar` 覆盖旧值
  - `team-hub/agent-avatars.mjs:31-38`：`used` 集合把「当前这一行自己的令牌」也算作已占用 → 每次重算都跳到下一个空位
- **前置条件**：临时库 + 真端口。
- **复现步骤**：对同一 `(software, hr-analyst)` 连续 3 次 `POST /api/agents { by:'general', role:'hr-analyst', name:'甄才' }`（不传 avatar），每次读回该行 avatar。
- **实际结果**（探针原文）：
  ```
  PROBE-1 重复 POST (software,hr-analyst) x3  HTTP=200/200/200  落库 avatar: human:s01 -> human:s02 -> human:s01  => DRIFT
  ```
- **影响**：与 `IMPLEMENTATION.md` §1「头像由 role 单射决定、确定性」及 S3 幂等承诺矛盾；每次重复提交都会占用并释放备用令牌，进一步放大 M1 的池耗尽风险。
- **修复建议（供参考）**：分配前先查当前行头像，仅「新建」或「现值非法」时分配；现值已是合法令牌则原样复用；并补「同一自建 role 重复 POST 头像不变」用例。

## 5. 已复现的建议优化项（非阻塞，供归属方参考）

| 编号 | 复现读数 | 归属/位置 |
| --- | --- | --- |
| T-200 S1（令牌不在位面表） | 探针 PROBE-D：显式传 `human:zzz` → **原样落库 `human:zzz`**；两端 `resolveSlot` 均无 `zzz` → 渲染占位人形 | `agent-intake.mjs:87` 仅做正则校验 |
| T-200 S2（移动端死代码） | `mobile/avatar.mjs:61-63` `avatarLabel(token, name)` 的 `token` 形参未使用；`app.mjs` 未调用（仅测试调用） | `workbench/mobile/avatar.mjs` |
| T-200 S8（`/api/agents` 未收敛旧值） | `read-models.mjs:256-263` 原样投影 `r.avatar`；而 `team-views.mjs:116` 已用 `isAvatarToken(...) ? ... : ''` 收敛。旧 emoji 行经 `/api/agents` 仍会吐出 emoji 字符串（前端 `AgentAvatar` 会渲染为占位，产品面无害，接口层口径不一致） | `team-hub/routes/read-models.mjs` |
| 文档读数误差 | `IMPLEMENTATION.md` §4 记 `sw-shell.test.mjs` = **6 pass**，本次实测 **7 pass**（§2.2） | `docs/G-mv1s6y49-1/IMPLEMENTATION.md` |

## 6. 回归范围与结论

- **回归范围**：
  1. 本目标六支新增套件（S1~S6）**41/41 全绿**；
  2. 受本批影响的既有基线：`agent-intake-routes`(21)、`team-views-routes`(17)、`read-models-routes`(25)、`doc-render`(11)、`identity-gate`(19)、`sw-shell`(7)、`board`(21)、`timeline`(16)、`refresh-loop`(6) 共 **133 例 0 fail**；
  3. 前端 `tsc --noEmit` exit 0；文档门禁 `check-docs` PASS；CI 新增登记 6/6 完整。
- **结论**：**回归范围内无失败**；主路径（25 内置岗位的命名、令牌、渲染、展示面、移动端、迁移、回归）全部通过。**唯一失败集中在「自建 role 的备用令牌分配」这一非主路径**：M1（池越界）与 M2（重复 POST 漂移）两项均破坏契约且已有独立探针复现。按验收标准「**全绿才判定通过**」，本阶段判定 **FAIL**，失败归属 **T-199 编码实现**；在 M1/M2 修复并补测前不建议验收放行。E2E-2/E2E-5 等浏览器/人工判据仍未执行，属**未验证**而非通过（见 §7）。

## 7. 未执行项与原因（不虚报）

| 类别 | 用例 | 原因 |
| --- | --- | --- |
| 负例注入（需临时改产品/测试代码） | TC-S1-14/15/16、TC-S2-10/15、TC-S3-16、TC-S4-13、TC-S6-08、TC-S7-07 | 本角色边界「不修 bug、不写代码、只报告」；注入会改动产品/门禁源码。建议归 T-200 reviewer / T-199 coder 的变异测试执行 |
| 全量 CI | TC-S7-01 | `run-ci.mjs --only test` 覆盖 **573 个 `*.test.mjs`**，T-198 §2 已明确 L4 全量 CI 由 **T-202 devops** 在有完整沙箱权限的环境执行；本次只对新增 6 条做登记与存在性逐条核对 |
| 浏览器/人工判据 | E2E-2、E2E-5、TC-S4-08、TC-S4-10、TC-S6-07 | 本环境无浏览器、无 Workbench 启动，且 E2E-5 需 ≥1 名独立评审人在 32px 下判定人形可辨/名称人性化并留痕——本任务无法组织 |
| 完整端到端 | E2E-3、E2E-4、E2E-6、E2E-7 | 需断网构建+启动或跨展示面遍历；其静态/局部面已由对应 TC 覆盖（见 §3.8） |

## 8. 证据清单（附件）

| 文件 | 内容 |
| --- | --- |
| `docs/G-mv1s6y49-1/T201-evidence/run-suite-log.txt` | 15 支套件（6 新 + 9 基线）逐支读数与退出码 |
| `docs/G-mv1s6y49-1/T201-evidence/probe-avatar-boundary.mjs` | M1/M2 与数据面复现探针（只读，临时库） |
| `docs/G-mv1s6y49-1/T201-evidence/probe-output.txt` | 上述探针原始输出（PROBE-1/2/3） |
| `docs/G-mv1s6y49-1/T201-evidence/probe-interface-and-boundary.mjs` | 接口/边界探针（role 长度、kind/sort、无身份被拒、令牌合法性、size 三值） |
| `docs/G-mv1s6y49-1/T201-evidence/probe-interface-output.txt` | 上述探针原始输出（PROBE-A~F） |
| `scripts/ci/run-ci.mjs`（只读引用） | 新增 6 条套件登记位置（1892–1897 行） |
