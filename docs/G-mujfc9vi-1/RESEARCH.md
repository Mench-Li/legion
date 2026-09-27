<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-27**（w/T-167 HEAD c4863ae）的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 .ci/<run>/summary.json。
<!-- evidence-banner:end -->

# T-167 方案研究：并行任务文件冲突治理（选型对比与推荐）

> 阶段：方案搜索（researcher）｜任务：T-167（[auto-goal]，所属目标 G-mujfc9vi-1 · software · chain）
> 上游需求：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-166 产出，w/T-166 HEAD a3abf4e）→ 本文件 → 下游 breaker [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md)
> 上游设计：[2026-09-27-parallel-task-conflict-control-design.md](../../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md)（设计自述状态：**待评审**）
> 评估基线：w/T-167 HEAD c4863ae；运行时 Node v24.19.0；Git 2.55.0.windows.5（均为本 worktree 实测，见 §9）
> **本阶段只做选型与方案对比**：不写实现、不改代码、不跑 taskctl/看板写接口、不 push、不联网下载依赖。所有实现落点建议均为**给 breaker/coder 的输入**，不是已落地的代码。

## 0. 结论速览（TL;DR）

**推荐：方案 A —— 零新增第三方依赖，用 Git 对象库级候选合并（merge-tree）＋ 绑定工作区快进应用；路径判定做成 packages/shared 下的纯函数模块。**

一句话依据：本仓库后端运行面**本就零第三方运行时依赖**（team-hub/plugins 的 package.json 只有 peer/dev 依赖），且已把 node:sqlite 用了 52 处、已把跨包共享纯函数放在 packages/shared/src/*.mjs；设计要的两件事（「不触碰用户工作区地生成候选合并」「按 expected_head 原子把关后仅快进」）都能用本机 Git 2.55.0 的原生命令实测完成，无需引入任何新库（§3、§4、§5）。

| 关键决策 | 推荐 | 主要备选 | 取舍理由（要点） |
| --- | --- | --- | --- |
| 总体技术路线 | **方案 A：零依赖 + merge-tree 候选 + 临时 worktree 验证 + 绑定工作区 merge --ff-only**（§3.1） | 方案 B 临时 worktree 真实 merge（§3.2）／方案 C 第三方库（§3.3） | A 无新供应链面、无新许可、与既有 git 子进程风格一致；B 可作 Git 版本不足时的降级；C 违反 A-6 且各有明确反证 |
| 路径判定纯函数落点 | **packages/shared/src/path-domain.mjs + path-domain.d.mts + packages/shared/test/**（§4 D-P1） | 放 team-hub 由 plugins 走 HTTP（否决）／两处各写一份（否决） | 已有 config.mjs 被 team-hub 与 plugins 同时 import 的先例；AC-R1-6 要求单一判定，两份必漂移 |
| 文件/目录匹配 | **段数组精确/前缀匹配，拒绝 glob**（§4 D-P2） | minimatch/picomatch（否决） | 设计 §4 明文「不接受任意 glob」；glob 的 * 跨段语义与段边界判定冲突 |
| 仓库身份 | **git rev-parse --git-common-dir ＋ 实路径规范化**（§4 D-P4） | --git-dir（否决）／--show-toplevel（否决） | 实测 worktree 的 --git-dir 是 .git/worktrees/<id>、--show-toplevel 是各 worktree 自身；只有 --git-common-dir 归一到同一仓库 |
| 验证命令登记面（D-4） | **仓库内声明文件（如 .legion/delivery.json）为权威，team-hub 读取并快照**（§4 D-P5） | team-hub DB 表／复用 CI suites（均列为备选） | 随仓库版本化、经 review 才生效，符合「不能让模型把任意 shell 串写进配置」；无登记则停 needs-review |
| 写入预约路径存储 | **paths_json 存 JSON 数组，事务内用纯函数内存两两判定**（§4 D-P6） | SQL 前缀匹配（否决） | SQL 前缀无法表达段边界/大小写，会重演既有 startsWith 缺陷 |
| 集成应用方式 | **绑定工作区 git merge --ff-only（先复核 ref==expected_head）**（§4 D-P7） | git update-ref 三参 CAS | 实测 update-ref 单独改 ref 会让 index 相对新 HEAD 出现差异（§9 实验 F），须再同步工作区；update-ref 仅用于恢复对账与无绑定工作区场景 |

## 1. 研究方法与证据分级

本阶段结论只用**可查证**来源，按证据强度分级（每条结论均标注级别）：

| 级别 | 含义 | 本文件用法 |
| --- | --- | --- |
| **A** | 本 worktree/临时环境**实测可复现**（命令＋输出要点在 §9） | 运行时版本、Git 能力、包结构、既有代码锚点 |
| **B** | 官方文档（Node.js / Git / SQLite 官方站） | node:sqlite 稳定性、merge-tree 语义、update-ref CAS 语义 |
| **C** | npm registry／GitHub API 元数据（许可、版本、末次提交时间） | 第三方库的成熟度、维护活跃度、许可 |
| **D** | 上游设计文档/厂商博客的**自述**，本阶段未独立复核 | 仅作背景，不作为选型依据；存疑处列入 §7 |

方法：
1. 先读上游 REQUIREMENTS.md 与设计文档，抽出「技术形态留给下游」的开放点（D-1~D-10 与研究相关者）。
2. 对每个开放点在本仓库做**结构实测**（grep/read/命令行），确认既有可复用基建与既有缺陷。
3. 对候选第三方库，查 npm registry 与 GitHub API 的真实元数据（不引用营销页）。
4. 对关键 Git 机制，在系统临时目录建**一次性仓库**实测语义（失败路径与成功路径都验），不触碰本仓。
5. 无法独立复核的外部引用，明确标注为**不确定项/风险**（§7），不写成结论。

## 2. 技术基座实测（本仓库现状，证据级别 A）

### 2.1 运行时与工具链

| 项 | 实测值 | 证据 |
| --- | --- | --- |
| Node | v24.19.0 | node --version |
| Git | 2.55.0.windows.5 | git --version |
| node:sqlite 使用面 | team-hub 下 **52** 处 import/使用 | grep node:sqlite team-hub/*.mjs 计数 |
| merge-tree --write-tree | **可用**（含 --stdin/--name-only/--messages/--merge-base） | git merge-tree -h |
| update-ref CAS | **可用**（三参形态 <ref> <new-oid> [<old-oid>]；另有 --stdin 原子批） | git update-ref -h；§9 实验 D/E |
| 根 package.json | **不存在**（各包独立 package.json，依赖经 build 脚本软链到 DSH checkout） | Test-Path package.json = False；scripts/ci/build-external-package.mjs |
| team-hub/plugins 运行时依赖 | 仅 peerDependencies + devDependencies，**无第三方 runtime dependencies 字段** | team-hub/package.json、plugins/package.json |

> 结论：后端运行面**当前零第三方运行时依赖**，这不是「还没加」，而是被 build 机制强约束（node_modules 由 build-external-package.mjs 从 DSH checkout 软链，新库不会自动出现）。这一条直接支撑 §5「净新增第三方依赖 = 0」。

### 2.2 既有可复用基建（选型必须复用，避免另造）

| 基建 | 位置（w/T-167 c4863ae） | 对本次选型的意义 |
| --- | --- | --- |
| 跨包共享纯函数先例 | packages/shared/src/config.mjs + config.d.mts；被 team-hub/server.mjs:229、team-hub/config-schema.mjs:5、plugins/src/config.ts:18 **同时 import** | R-1 路径纯函数的**现成落点范式**：.mjs + 手写 .d.mts，跨 team-hub/plugins 共用 |
| 共享路径策略纯函数先例 | packages/shared/src/artifact-policy.mjs:1-23 + packages/shared/test/artifact-policy.test.mjs + run-ci.mjs:1434 套件注册 | 已有「绝对路径/../.git 一律拒绝」的同类规则与测试骨架；新模块须与之划清边界、避免第二套规则 |
| 事务包装范式 | team-hub/run-store.mjs:1121-1141（BEGIN IMMEDIATE + 嵌套 SAVEPOINT + 回滚保留原始异常）；团队注释明言「读之前就拿到写锁」 | R-2 预约事务**直接沿用**该形态，不引入锁库 |
| 并发安全迁移原语 | team-hub/schema-util.mjs:36-89（columnExists/ensureColumn，BEGIN IMMEDIATE 内重读，处理双进程并发启动） | 新表/新列迁移沿用 ensureColumn，保证可重复、可从旧库启动（AC-R2-8） |
| 多进程并发用例范式 | team-hub/run-concurrency.test.mjs:1-80（真 spawn 子进程 + team-hub/scripts/claim-probe.mjs 探针 + 临时库 WAL/busy_timeout） | AC-R2-1（跨进程争用唯一赢家）用**同一范式**，不新造测试设施 |
| 路由族与注册 | team-hub/router.mjs:45-64（按 families 注册顺序匹配）、team-hub/routes/*.mjs（每族一个模块） | R-2/R-4 新 API 按现有「一族一模块」接入 |
| worktree 生命周期 | plugins/src/workspace.ts:191-228（prepareWorktree 复用优先/分支重挂载）、:262-268（commitWorktree） | R-3 等待后基于最新目标建工作区、R-4 临时集成工作区都复用同一 runGit 接缝 |
| 唯一现存集成入口 | plugins/src/index.ts:1470-1490（autoPromote 直合主工作区、失败 abort 保留分支） | R-6 收敛为 integration worker 的对象；其 runGit 注入接缝可直接复用 |
| 审计 SSE | 设计 §8 所述「现有审计 SSE」；activity 事件经 plugins/src/index.ts 的 activity(...) 写入 | R-5 交付面消费现有事件流，不新增实时通道 |

### 2.3 既有实现的缺陷（选型须修的对象）

| 缺陷 | 证据 | 选型含义 |
| --- | --- | --- |
| 越域判定是字符串前缀，src/a 会误覆盖 src/ab | plugins/src/index.ts:1295-1303（allowed 里加 `d` 与 `d/` 后 f.startsWith(a)） | R-1 必须提供段边界判定，且 team-hub 与 plugins **改用同一函数**（AC-R1-6） |
| 集成后不验证 | plugins/src/index.ts:1470-1490 只有 merge 与清理，无任何验证调用 | R-4 的增量核心；选型必须解决「在候选合并上跑验证」 |
| 进程内 Set 不是仓库锁 | plugins/src/index.ts:523（mediating Set）、:2538-2566（sweep）；设计 §2.2 已指出 | 集成互斥必须落在 team-hub 事务（epoch 租约），不能用进程内结构或文件锁库 |

## 3. 总体候选方案对比（≥2 候选）

本节给出三个**互斥的总体路线**。三者在「谁生成候选合并」「谁保证同一时刻只有一个集成」「验证在哪跑」上取不同做法。

### 3.1 方案 A（推荐）：零新增依赖 · 对象库级候选合并 ＋ 绑定工作区快进应用

**做法**
1. 冲突预判与候选树：在对象库内生成候选（**不触碰任何工作树与 index**）：`git merge-tree --write-tree --messages <target_ref> <source_ref>`；exit 0 = 干净合并，exit 1 = 存在内容冲突（§9 实验 A/I）。
2. 候选提交：`git commit-tree <tree> -p <target_sha> -p <source_sha> -m ...`，使 **第一父提交 = expected_head**（设计 §6.2 步骤 6；§9 实验 B）。
3. 集成后验证：`git worktree add --detach <candidate_commit> <临时目录>` 检出候选，在**临时隔离集成工作区**跑仓库登记的验证命令（§9 实验 G），跑完 worktree remove。
4. 应用：在仓库级互斥（team-hub 事务租约）内先复核目标 ref 仍 == expected_head，再在**绑定工作区**执行 `git merge --ff-only <candidate>`（§9 实验 H：应用后 index/worktree 干净）。
5. 崩溃恢复：journal（prepared→applying→ref-updated→finalized）与 Git 事实对账；用 `git merge-base --is-ancestor <candidate> <target>` 判「已应用未记账」（§9 实验 C）。

**优点**
- 无任何新增第三方依赖，无新许可/供应链面（满足 REQUIREMENTS A-6）。
- 候选生成**完全不碰用户工作区与 index**，天然满足「不在用户工作区重做冲突调解」「不覆盖用户工作区」（设计 §6.2 步骤 2/6、§9）。
- 与既有代码风格一致：全程 runGit 子进程 + node:sqlite 事务，团队已熟悉。
- `merge-tree --write-tree` 官方明言「使用与真实 git merge 相同的特性（三方内容合并、重命名检测、目录/文件冲突、递归祖先合并）」，语义与真实合并一致（证据级别 B）。
- 失败信息可解析：冲突时 exit 1 并列出 conflicted 文件（可用 --name-only 只取文件名），正好映射设计 §6.3「Git 内容冲突进入待裁决」。

**缺点 / 成本 / 风险**
- 学习成本集中在 git plumbing 的输出解析（tree oid、conflicted tuple、messages）。
- **仅对象库不能跑验证**：候选必须在临时 worktree 检出后才能跑测试 → 方案 A 必须包含步骤 3（这是方案 A 的必要部分，不是可选优化）。
- `commit-tree` 需要提交者身份：CI/容器若无 user.name/email 会失败，须在集成时注入 GIT_AUTHOR_*/GIT_COMMITTER_*（§9 实验 B 的做法；列入 §7 RK-F）。
- 依赖 Git ≥ 2.38（merge-tree --write-tree 自 2.38）；本机 2.55.0 满足，但需运行时探测并给降级（§5.4）。

### 3.2 方案 B：零新增依赖 · 临时 worktree ＋ 真实 git merge 生成候选

**做法**：`git worktree add --detach <expected_head> <临时目录>` → `git merge --no-commit <source>` → 冲突/干净 → 在该临时工作树跑验证 → 成功后 `git update-ref` 或 `merge --ff-only` 应用到目标 ref。

**优点**：语义最直观，与既有 autoPromote 的 merge 风格最接近；冲突现场就是普通工作树，人工排查零学习成本；对 Git 版本要求低（不需 merge-tree）。
**缺点 / 成本 / 风险**：
- 需要管理临时工作树生命周期（add/remove/崩溃遗留清理），而设计对「集成完成前不删源 worktree/分支」「清理可重试」已有更复杂的协议，叠加临时工作树会放大清理面。
- 临时工作树与现有 .legion-worktrees/ 命名空间同源，命名与清理冲突风险高（plugins/src/workspace.ts:184 worktreeRootFor）。
- 全仓库 checkout 的磁盘/时间开销明显高于对象库 merge（大仓库尤甚）。
- 冲突态工作树若崩溃遗留，会成为下一次集成的毒化源（既有 autoPromote 已因「上次遗留冲突态」专门做过 merge --abort 防御，plugins/src/index.ts:1472-1474）。
**定位**：作为方案 A 在 **Git < 2.38** 或 merge-tree 异常时的降级路径。

### 3.3 方案 C：引入第三方库

候选与真实元数据见 §5.2。总体判断：**全部不引入**。理由是可查证的反证，而非偏好：
- 设计明确「权威只在 team-hub SQLite 事务、不做跨进程文件锁」（REQUIREMENTS R-2 scope out），引入 proper-lockfile 会制造**第二权威**。
- 设计明确「不接受任意 glob」（设计 §4），引入 minimatch/picomatch 与规范相悖。
- 后端已用 node:sqlite（52 处），引入 better-sqlite3 即双引擎 + 原生构建工具链。
- simple-git 只替代 child_process 包装，却带来 5 个传递依赖；isomorphic-git 带来 11 个传递依赖，且与设计「外部 Git 进程不受 Legion 租约约束」的显式假设冲突（把 Git 变成进程内库并不能消除该假设，反而更难观测真实 ref 变化）。

### 3.4 三方案对比矩阵

| 维度 | 方案 A（推荐） | 方案 B | 方案 C |
| --- | --- | --- | --- |
| 新增第三方运行时依赖 | **0** | 0 | ≥1（含传递依赖） |
| 适配设计「不碰用户工作区」 | 强（对象库生成候选） | 中（临时工作树，仍不碰绑定工作区） | 取决于库 |
| 候选合并语义 = 真实 merge | 是（官方明言同特性，级别 B） | 是 | 是（若包装 git） |
| 集成后验证可跑 | 需临时 worktree 检出候选 | 原生（临时工作树即候选） | 取决于库 |
| Git 版本下限 | ≥ 2.38 | 低 | 视库 |
| 崩溃恢复对账素材 | tree/commit SHA + journal + is-ancestor | 工作树 + ref + journal（清理面更大） | 视库 |
| 学习成本 | 中（git plumbing 解析） | 低 | 低~中 |
| 供应链/许可面 | 无新增 | 无新增 | 新增多项，违反 A-6 |
| 主要风险 | merge-tree 输出解析、commit-tree 身份、Git 版本 | 临时工作树遗留与清理 | 双权威/依赖漂移/与规范冲突 |
| 结论 | **推荐主路径** | **降级备选** | **否决** |

## 4. 关键决策点逐项选型（每条含备选与取舍）

### D-P1 共享路径判定纯函数的落点

| 候选 | 内容 | 优点 | 缺点/成本 | 结论 |
| --- | --- | --- | --- | --- |
| **1（推荐）** | packages/shared/src/path-domain.mjs + path-domain.d.mts + packages/shared/test/path-domain.test.mjs；在 run-ci.mjs suites 注册 | 完全沿用 config.mjs/artifact-policy.mjs 先例；team-hub 与 plugins 同时 import 已有 3 处实例；.mjs + 手写 .d.mts 不需要额外构建 | packages/shared 无独立 package.json，跨包用相对路径 import（这是仓库既有约定，不是新债） | 采用 |
| 2 | 放 team-hub，plugins 经 HTTP 或读 DB 复用 | 权威单一 | pre-execute 在写工具热路径，网络/DB 往返不可靠且把判定异步化；hub 不可达时无法判定写入资格 | 否决 |
| 3 | team-hub 与 plugins 各写一份 | 无跨包耦合 | AC-R1-6 要求同一判定；两份规则必然漂移（本仓已有「一份并发原语存在两份实现时其中一份迟早腐烂」的教训，schema-util.mjs:1-28） | 否决 |

**必须显式处理的边界**：artifact-policy.mjs 已实现「拒绝绝对路径/../.git」，path-domain.mjs 会与之重叠。建议在 path-domain.mjs 里**复用或引用**该拒绝面（或写明分工：artifact-policy 管「文件服务读取」，path-domain 管「写入预约」），并由 AC-R1-6 的用例反证二者不产生两套结论。

### D-P2 文件 / 目录匹配算法（拒绝任意 glob）

| 候选 | 内容 | 取舍 |
| --- | --- | --- |
| **1（推荐）** | 规范化成仓库相对**段数组**；文件 = 段序列精确相等；目录 = 前缀段相等（src/a 不匹配 src/ab）；大小写按仓库配置归一 | 与设计 §4 完全一致；纯函数、零依赖、可单测（AC-R1-1/3/5） |
| 2 | minimatch / picomatch | 否决：设计明文「不接受任意 glob」；glob 的 * 可跨段，会破坏段边界语义；且新增依赖 |

重命名两端：由 `git diff --name-status -M` 解析 R 行同时取旧/新路径（AC-R1-4），不引入 diff 解析库——既有 plugins/src/index.ts:1286-1291/1307 已有 diff 解析先例可扩展。

### D-P3 候选合并与应用的实现路线

见 §3.1/§3.2。推荐方案 A；方案 B 作为 Git 版本降级。**这是本文件的核心推荐**。

### D-P4 仓库身份

| 候选 | 实测/依据 | 结论 |
| --- | --- | --- |
| **--git-common-dir（推荐）** | 在 worktree T-167 内实测：--git-dir = D:/project/DSH/legion/.git/worktrees/T-167，而 --git-common-dir = D:/project/DSH/legion/.git（与主仓库一致，§9） | 采用：多个 worktree/任务归一到同一仓库身份 |
| --git-dir | 每个 worktree 各不相同 | 否决 |
| --show-toplevel | 每个 worktree 返回自身路径 | 否决 |

规范化：对 common-dir 结果 realpath 后统一分隔符与（按仓库配置的）大小写。

### D-P5 仓库级验证命令登记面（对应 REQUIREMENTS D-4，需将军确认）

| 候选 | 内容 | 优点 | 缺点/成本 | 倾向 |
| --- | --- | --- | --- | --- |
| **1（推荐）** | 仓库内**声明文件**（建议仓库根 .legion/delivery.json），字段含 targetRef 与 verify[]（id、argv、timeoutMs、可选 cwd）；team-hub 集成时读取并快照进 integration_jobs/验证报告 | 随仓库版本化、经 review 才生效，天然满足「不能让模型把任意 shell 串写进配置」；跨 worktree/克隆一致 | 新增一处文件格式与解析、需门禁校验（argv 数组而非 shell 串） | 采用 |
| 2 | team-hub DB 表（repositories + verify_commands），经 UI/API 维护 | 服务端权威、无需仓库文件、便于集中运维 | 不随仓库走、跨克隆丢失、只能经 UI 维护；与「命令应可代码审查」相悖 | 备选 |
| 3 | 复用各包 package.json scripts 或 scripts/ci/run-ci.mjs suites | 已存在、零新增格式 | 面向 CI 全量而非「受影响回归」子集；run-ci.mjs 是源码，模型可改 | 备选（仅作默认种子） |

无论选哪个：**无登记 → 任务停在 needs-review，禁止「跳过验证并标记已交付」**（设计 §12、REQUIREMENTS A-5）。

### D-P6 写入预约的路径存储与相交判定

| 候选 | 内容 | 取舍 |
| --- | --- | --- |
| **1（推荐）** | write_reservations.paths_json 存 JSON 数组；事务内先拉同仓库活跃 reservation，再调 D-P1 纯函数内存两两判定 | SQL 表达不了段边界/大小写；同仓库活跃预约数量小，内存判定可接受 |
| 2 | 路径展开成行 + SQL 前缀匹配 | 否决：会重演 plugins/src/index.ts:1295-1303 的 startsWith 缺陷 |

配套：提供「全库活跃预约两两不相交」的断言查询（AC-R2-7）。

### D-P7 集成应用方式（本文件最微妙的一处）

设计要求：最终提交前「重新确认目标 ref 仍为 expected_head…再仅快进应用」。两条实现实测对比如下：

| 候选 | 实测 | 结论 |
| --- | --- | --- |
| **merge --ff-only（推荐主路径）** | 实验 H：在干净、已检出 main 的工作区 `git merge --ff-only <candidate>` → exit 0，index/worktree 自动同步为候选，`git status` 干净 | 采用：把 ref 更新与索引/工作区同步交给 git，一条命令语义完整 |
| update-ref 三参 CAS | 实验 D2：old-oid 不符 → exit 128，错误含「is at <实际值> but expected <期望值>」（正好可用于诊断）；实验 E：即使目标分支已检出也能成功改 ref；**实验 F：单独改 ref 后 index 相对新 HEAD 出现差异（status 显示 D feat.txt）** | 不作主路径（须再同步工作区）；用于**崩溃恢复对账**、以及无绑定工作区时的应用 |

落地建议：主路径 = 复核 ref==expected_head → 在仓库级互斥区内 `merge --ff-only`；并在 journal 记录 applying/ref-updated/finalized 三阶段 SHA，恢复时用 is-ancestor + ref SHA 对账（实验 C）。

### D-P8 Workbench 交付面（R-5）

| 候选 | 内容 | 取舍 |
| --- | --- | --- |
| **1（推荐）** | 扩展现有 workbench/src/api.ts（新增 contention/deliveries 取数，沿用 fetchHubOverlaps 的 fetch 风格）+ TaskDetailModal.tsx/TaskCenterView.tsx 增徽标与「为什么等待」+ 裁决面板；version CAS 由服务端 409，前端沿用 hub-errors.ts 处理 | 与设计 §7「任务详情新增当前占用」一致；复用现有 SSE 与错误语义 |
| 2 | 独立交付页 | 否决：与设计「任务中心/详情内呈现」不符，且多一个运维面 |

前端**不新增依赖**（workbench 已有 React/Vite；本设计所需均为既有能力）。

### D-P9 指标与可观测（R-8）

| 候选 | 内容 | 取舍 |
| --- | --- | --- |
| **1（推荐）** | team-hub SQL 聚合 + 只读端点，返回 {available:true,value} 或 {available:false,reason}；窗口口径在接口旁文档化 | 口径集中、可复算（AC-R8-3）；「不可读不显示 0」由 available 字段保证（AC-R8-2） |
| 2 | Workbench 端拼多个端点 | 否决：口径分散、样本窗口难统一 |

## 5. 新引入技术 / 依赖逐项影响（许可 · 维护 · 学习成本 · 生态）

### 5.1 结论

**净新增第三方依赖 = 0。** 只新增对「Node 内置模块」与「本机 Git 子命令」的使用；两者都不改变 package.json 依赖面，不需要联网下载，符合 LEGION.md「禁止联网下载依赖」与 REQUIREMENTS A-6「零新增外部依赖」。

### 5.2 被评估但**不引入**的库（元数据为 2026-09-27 实测，级别 B/C）

| 库 | 最新版 | 许可 | 维护活跃度（末次提交/推送） | 学习成本 | 生态/影响 | 结论与反证 |
| --- | --- | --- | --- | --- | --- | --- |
| proper-lockfile | 4.1.2 | MIT | **末次提交 2021-01-25，末次推送 2023-10-25**（近 5 年无提交） | 低 | +3 传递依赖（retry/graceful-fs/signal-exit） | 不引入：设计明确权威只在 SQLite 事务、不做跨进程文件锁；引入即制造第二权威，且维护停滞 |
| simple-git | 4.0.2 | MIT | 活跃（末次提交 2026-09-26） | 低 | +5 传递依赖 | 不引入：仅包装 child_process，仓库既有 runGit 模式已够用 |
| better-sqlite3 | 13.0.3 | MIT | 活跃（末次提交 2026-08-10） | 低 | 原生扩展 + node-addon-api，需要构建工具链 | 不引入：与 node:sqlite 双引擎；无预编译产物风险 |
| minimatch | 10.2.6 | **BlueOak-1.0.0** | 活跃（2026-07-27） | 低 | +1 传递依赖（brace-expansion） | 不引入：设计 §4「不接受任意 glob」 |
| picomatch | 4.0.7 | MIT | 活跃（2026-08-27） | 低 | 0 运行时依赖 | 不引入：glob 语义与段边界判定冲突；仅 workbench 传递层出现，非后端 |
| isomorphic-git | 1.42.2 | MIT | 活跃（2026-09-11） | 中 | **+11 传递依赖** | 不引入：纯 JS git 与「外部 Git 进程不受租约约束」的显式假设冲突；观测真实 ref 变化反而更难 |

补充说明：workbench/pnpm-lock.yaml 里已有 picomatch（Vite 依赖链的传递项，非后端直接依赖）；后端 team-hub/plugins 的运行时依赖面为 0。

### 5.3 实际新增的「技术面」

| 新增技术 | 类型 | 许可 | 维护 | 学习成本 | 生态/影响 |
| --- | --- | --- | --- | --- | --- |
| node:sqlite（DatabaseSync） | Node 内置模块 | 随 Node（MIT 风格） | 随 Node 发版；官方文档标 **Stability 1.2 - Release candidate**（v24.15.0 起；v23.4/v22.13 起去 flag） | 低——仓库已用 52 处 | 无新增 npm 依赖；无供应链面 |
| git merge-tree --write-tree | 本机 Git 子进程 | Git 为 GPL-2.0，仅**子进程调用**不链接，无许可传染 | 随 Git 发版；--write-tree 自 2.38（2022-10） | 中——需解析 tree oid/conflicted 输出 | 无新增 npm 依赖；语义与真实 merge 相同 |
| git update-ref 三参 CAS / git commit-tree / rev-parse --git-common-dir / merge-base --is-ancestor | 本机 Git 子进程 | 同上 | 长期稳定命令 | 低~中 | 同上 |

### 5.4 版本下限与降级

| 依赖 | 下限 | 依据 | 不满足时的降级 |
| --- | --- | --- | --- |
| Git | **≥ 2.38**（merge-tree --write-tree） | git-scm.com 文档：--write-tree 自 2.38（级别 B） | 降级到方案 B（临时 worktree + merge）；版本仍不可用或 Git 缺失 → 按设计 §9「非 Git/Git 不可用禁止并行写入，清晰提示降级原因」 |
| Node | 以现有部署基线为准；建议治理运行面登记 **≥ 24.15**（node:sqlite 进入 Release candidate） | Node 官方文档（级别 B）；本机 v24.19.0 | 若必须支持更低 Node，node:sqlite 仍可用（≥23.4 已去 flag），但稳定性等级更低，须在启动时探测 |

## 6. 推荐方案的落地骨架（供 breaker 切片 / coder 实现）

> 以下为**建议落点**，不是已定案的实现；breaker 按文件域划界、coder 实现、tester 验证时以此为准即可（满足「方案结论可直接支撑后续任务拆解」）。

### 6.1 需求 → 模块落点映射

| 需求 | 建议落点 | 测试落点 | 备注 |
| --- | --- | --- | --- |
| R-1 路径判定纯函数 | packages/shared/src/path-domain.mjs + path-domain.d.mts | packages/shared/test/path-domain.test.mjs（注册进 run-ci.mjs suites，参照 :1434） | 复用 artifact-policy.mjs 的拒绝面；AC-R1-6 反证单一判定 |
| R-2 intent/reservation 事务 | team-hub/write-intent-store.mjs + team-hub/routes/write-intent.mjs + server.mjs 建表/ensureColumn 迁移 | team-hub/write-intent-store.test.mjs + 多进程探针（参照 run-concurrency.test.mjs + scripts/claim-probe.mjs） | 事务沿用 run-store.mjs:1121 形态 |
| R-3 Orchestrator 资格/等待/扩域 | plugins/src/index.ts（claim/派工/pre-execute 段）＋按需新 plugins/src/writeEligibility.ts | plugins 侧测试（沿用既有替身接缝范式） | 授权快照写入 RunRequest，模型不可改 |
| R-4 delivery store + 集成 worker | team-hub/delivery-store.mjs + 集成 worker（建议独立模块，如 team-hub/integration-worker.mjs 或 runtime/ 下）；routes/delivery.mjs | team-hub/delivery-store.test.mjs + 临时仓库夹具测试（禁用本仓真实仓库） | 见 §6.3 时序；失败注入按 journal 四阶段 |
| R-5 Workbench | workbench/src/api.ts + components/TaskDetailModal.tsx + TaskCenterView.tsx | 前端纯函数测试（参照 workbench/scripts/*.test.mjs 范式） | 不改 workbench 依赖 |
| R-6 legacy 收敛/开关/迁移 | plugins/src/index.ts（autoPromote/mediation 收敛段）+ team-hub 迁移与开关列 | 对应负例测试 | 同仓库不得新旧并行 |
| R-7 非 Git 降级 | team-hub/plugins 的仓库能力探测段 | 降级判定测试 | 只读任务不受限 |
| R-8 指标 | team-hub 指标聚合 + 只读路由 | 抽样断言 | available=false 不显示 0 |
| R-9 文档同步 | README/docs/FEATURES.md/docs/STATUS.md 等 | node scripts/ci/check-docs.mjs | 保持门禁绿 |

### 6.2 数据与事务要点（供拆解）

- 迁移：`CREATE TABLE IF NOT EXISTS` + schema-util.ensureColumn（幂等 + 并发安全 + 可从旧库启动，AC-R2-8）。
- 事务：reservation 授予与 claim 在同一 BEGIN IMMEDIATE 内完成；路径相交判定用 D-P1 纯函数（内存），不写进 SQL。
- CAS：intent 用 revision CAS、delivery 用 version CAS、job 用 lease_epoch fencing；变更另记只追加事件（设计 §4 表定义）。
- 冲突响应结构化：FILE_CONTENTION + 冲突路径 + 持有任务；等待不消耗重试额度（AC-R2-1、AC-R3-1）。
- 两套状态独立：写入调度状态（unplanned/waiting-file/reserved/reconciling/released）与交付子状态（awaiting-acceptance/ready/preparing/validating/needs-review/integrated/abandoned）不得互相代替（设计 §3.2）。

### 6.3 集成 worker 时序（含本阶段实测锚点）

1. team-hub 事务认领该仓库 integration job，发放 epoch 租约（同仓库至多一个）。
2. 读目标 ref SHA（expected_head）＋校验绑定工作区干净（有未提交/未跟踪/处于其他 merge/rebase/身份不符 → 暂停并给可操作原因，不 stash）。
3. `git merge-tree --write-tree --messages <expected_head> <source>`：exit 0 干净继续；exit 1 内容冲突 → needs-review/待裁决（实验 A/I）。
4. `git commit-tree <tree> -p <expected_head> -p <source> -m ...` 生成候选（第一父 = expected_head；实验 B）。
5. `git worktree add --detach <candidate> <临时目录>` → 跑登记验证命令（含命令/退出码/耗时/候选 SHA/验收版本）→ `worktree remove --force`（实验 G）。验证失败 → 目标 ref 不动、保存候选与报告。
6. 复核目标 ref 仍 == expected_head；在仓库级互斥区内对干净绑定工作区执行 `git merge --ff-only <candidate>`（实验 H）。HEAD 前进则丢弃候选按新 HEAD 重算重验（限次数，超限待裁决）。
7. journal：prepared→applying→ref-updated→finalized；崩溃恢复用 ref SHA + source 可达性（`merge-base --is-ancestor`，实验 C）判「未应用/已应用未记账/结果不明」，已应用未记账只补记、不重跑 merge；结果不明暂停不自动删分支。
8. 清理：集成完成前不删源 worktree/分支；清理是可重试后续动作，失败不回滚已交付事实。

### 6.4 切片顺序与依赖（对齐设计 §12）

path-domain 纯函数（R-1）→ intent/reservation 事务（R-2）→ Orchestrator 接线（R-3）→ delivery + 集成 worker（R-4）→ Workbench（R-5）→ legacy 迁移收口（R-6）；R-7/R-8/R-9 贯穿。**R-1 是 R-2/R-3/R-4 的公共前置，必须先交付**；R-4 依赖 R-2 的 reservation 语义与 D-P5 的验证登记面。

## 7. 风险、不确定项与备选（不确定项一律列为风险，不写成结论）

| # | 风险/不确定项 | 性质 | 依据 | 缓解/备选 |
| --- | --- | --- | --- | --- |
| RK-A | Git 版本不足 2.38 时 merge-tree --write-tree 不可用 | 环境不确定 | git-scm.com 文档（B）；本机 2.55.0 满足 | 运行时探测版本；降级方案 B；均不可用则禁止并行写入并提示 |
| RK-B | node:sqlite 仍标注 Stability 1.2 - Release candidate | 上游成熟度 | Node 官方文档（B） | 保持 node:sqlite（仓库已在用）；必要时可评估 better-sqlite3，但违反零依赖且需原生构建 |
| RK-C | 设计引用的两处厂商链接与本环境可达地址不一致 | 来源可靠性 | 实测：cursor 文档由 docs.cursor.com 跨域重定向到 cursor.com；Codex 文档 learn.chatgpt.com 本环境 fetch 失败（搜索索引可确认页面存在） | 下游引用改用可验证地址（如 cursor.com/docs/background-agent）；未独立复核者标注为 D 级，不作为选型依据 |
| RK-D | 方案 A 的候选验证需临时 worktree，非纯对象库可完成 | 实现复杂度 | 本文件 §3.1、实验 G | 已纳入方案 A 步骤 5；临时工作区命名/清理须与现有 worktreeRootFor 隔离 |
| RK-E | commit-tree 需要提交者身份，CI/容器可能未配置 | 环境不确定 | 实验 B（须注入 GIT_AUTHOR_*/GIT_COMMITTER_*） | 集成时以 -c 或环境变量注入固定机器身份；失败则暂停并提示 |
| RK-F | D-4 验证命令登记面形态需将军确认 | 待裁决 | REQUIREMENTS D-4（本阶段给候选与倾向） | 默认按 D-P5 候选 1（仓库声明文件）；将军若选 DB 表则沿用同字段 |
| RK-G | 自举：本仓正是 Legion 自身，治理落地会阻塞正在实现它的任务 | 高爆炸半径 | REQUIREMENTS RK-9、设计 §10 | 默认观察模式 + 按仓库开关 + 不追溯历史 + 仅交付型任务改 done（D-2/D-3） |
| RK-H | 范围体量与单链容量（D-1） | 计划风险 | REQUIREMENTS RK-7 | 按 §6.4 P0 先行；容量不足时 R-5/R-6/R-8 拆后续目标 |
| RK-I | Windows 大小写/长路径、多空间同仓库 | 环境不确定 | 实测本机为 Windows；--git-common-dir 已归一仓库 | 大小写按仓库配置；路径段规范化；同仓库共用一个集成锁与占用池 |
| RK-J | 设计整体状态为「待评审」，其默认决策可能被将军修改 | 需求不确定 | 设计第 3 行、§12；REQUIREMENTS D-*/O-* | 本文件对受影响处均给备选（D-P5/D-P7）；将军裁决后由守护带回修订 |

## 8. 引用来源清单

| 来源 | 地址 | 用途 | 级别 |
| --- | --- | --- | --- |
| Node.js SQLite 文档 | https://nodejs.org/docs/latest-v24.x/api/sqlite.html | node:sqlite Stability 1.2 RC（v24.15.0 起） | B |
| git-merge-tree 文档 | https://git-scm.com/docs/git-merge-tree | --write-tree 语义、不触碰 index/工作树、--stdin/--name-only/--messages、与真实 merge 同特性、2.38 引入 | B |
| git-update-ref 文档 | https://git-scm.com/docs/git-update-ref | 三参 CAS 语义、--stdin 原子批 | B |
| SQLite 事务文档 | https://sqlite.org/lang_transaction.html | BEGIN IMMEDIATE/写锁语义 | B |
| npm registry（各库 /latest 与全量元数据） | https://registry.npmjs.org/proper-lockfile 等 | 版本、许可、依赖数、发布时间 | C |
| GitHub API（各库仓库与末次提交） | https://api.github.com/repos/moxystudio/node-proper-lockfile 等 | 末次提交时间、star、归档状态 | C |
| Cursor Cloud Agents 文档 | https://cursor.com/docs/background-agent | 厂商背景（隔离环境/独立分支） | B/D |
| Claude Code Desktop 文档 | https://code.claude.com/docs/en/desktop | 厂商背景（可选独立 worktree） | D |
| Claude Code Agent Teams 文档 | https://code.claude.com/docs/en/agent-teams | 厂商背景（不同文件交给不同成员、同文件顺序处理） | D |
| Codex worktrees 文档 | https://learn.chatgpt.com/docs/environments/git-worktrees | 厂商背景（各 worktree 执行 + Handoff） | D（本环境未能直接抓取，见 RK-C） |
| 本仓库既有代码 | 见 §2.1/§2.2 的 file:line | 复用基建与缺陷锚点 | A |

## 9. 本阶段验证命令与输出要点（可复现）

### 9.1 环境与既有代码（只读，级别 A）

| 命令 | 输出要点 |
| --- | --- |
| node --version | v24.19.0 |
| git --version | git version 2.55.0.windows.5 |
| git merge-tree -h | 列出 --write-tree / --stdin / --name-only / --messages / --merge-base |
| git update-ref -h | 三参形态 <ref> <new-oid> [<old-oid>]；--stdin 原子批 |
| git rev-parse --git-dir / --git-common-dir（worktree T-167 内） | .git/worktrees/T-167 与 D:/project/DSH/legion/.git（证明只有 common-dir 归一） |
| grep node:sqlite team-hub/*.mjs | 52 处 |
| read team-hub/run-store.mjs:1121-1141 | withTx = BEGIN IMMEDIATE + SAVEPOINT + 回滚保留原异常 |
| read team-hub/schema-util.mjs:36-89 | ensureColumn 幂等并发安全 |
| read plugins/src/index.ts:1295-1303 | outsideDomainFiles 用字符串前缀 |
| read packages/shared/src/artifact-policy.mjs:1-23 与 run-ci.mjs:1434 | 共享路径纯函数先例与 CI 注册先例 |

### 9.2 一次性临时仓库实验（不改本仓）

在系统临时目录建一次仓库，验证方案 A 的关键机制；输出要点：

| 实验 | 命令（要点） | 结果 |
| --- | --- | --- |
| A 干净合并 | git merge-tree --write-tree --messages main w/T-1 | exit 0，首行 = 候选树 oid |
| B 候选提交 | git commit-tree <tree> -p main -p feat | 生成候选提交，parents 顺序为 main feat（第一父 = expected_head） |
| C 祖先判定 | git merge-base --is-ancestor main candidate | exit 0 |
| D CAS 失败 | git update-ref refs/heads/main <cand> <错误 old-oid> | exit 128：cannot lock ref ... is at <实际值> but expected <期望值> |
| E CAS 成功（分支已检出） | git update-ref refs/heads/main <cand> <正确 old-oid> | exit 0，HEAD 跟随 |
| F 单独 update-ref 的副作用 | 改 ref 后 git status --porcelain | 出现 D feat.txt（index 相对新 HEAD 有差异），须再同步工作区 |
| G 候选检出验证 | git worktree add --detach <candidate> <tmp> | 成功检出候选内容，可跑验证 |
| H ff-only 应用 | 干净工作区 git merge --ff-only <candidate> | exit 0，文件同步，git status 干净 |
| I 冲突探测 | git merge-tree --write-tree --messages main w/T-2（同文件改动） | exit 1，输出 conflicted 文件三元组 + CONFLICT 消息 |

### 9.3 文档门禁

| 命令 | 输出要点 |
| --- | --- |
| node scripts/ci/check-docs.mjs | 见下方 §9.4 实测记录 |
| node scripts/ci/evidence-banner.mjs --check | 见下方 §9.4 实测记录 |
| node scripts/ci/encoding-check.mjs | 见下方 §9.4 实测记录 |

### 9.4 本阶段实测记录

- **执行时间**：2026-09-27；**基线**：w/T-167 HEAD c4863ae（实测）。本阶段仅新增 docs/G-mujfc9vi-1/RESEARCH.md，**无实现文件改动**。
- git status --short（本阶段结束时，原样）：
```
?? docs/G-mujfc9vi-1/
?? docs/goals/G-mujfc9vi-1.md
```
  说明：docs/goals/G-mujfc9vi-1.md 是守护派工时下发的目标上下文镜像（本任务只读、未修改）；docs/G-mujfc9vi-1/ 内仅有本阶段新增的 RESEARCH.md。
- node scripts/ci/check-docs.mjs → **exit 0（PASS）**。输出要点：「历史 evidence banner 覆盖完整（docs/ 下证据快照目录全部标注）」「表格行形状完整（docs/ + README 共 12581 个表行，收尾与孤儿行 0 处异常）」「check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，11 类校验项全绿）」。
- node scripts/ci/evidence-banner.mjs --check → **exit 0（PASS）**。输出要点：「72 个证据快照目录的文档均已标注历史 banner」。
- node scripts/ci/encoding-check.mjs → **exit 2**，失败原因为本会话沙箱禁止 Node 以管道捕获子进程输出（stderr：spawnSync git EPERM），**属执行环境限制、非文档内容问题**；按沙箱纪律不重试绕过。
- 等价替代校验（直接读文件、不经子进程）：RESEARCH.md（约 41 KB）；U+FFFD（替换字符）计数 **0**；NUL 字节 **无**；UTF-8 往返一致（Buffer.from(text, utf8).equals(buf) === true）；文件首行为 evidence-banner:start 标记。
- 命令与代码锚点核对（只读）：node --version = v24.19.0；git --version = 2.55.0.windows.5；git merge-tree -h 列出 --write-tree/--stdin/--name-only/--messages/--merge-base；grep node:sqlite team-hub/*.mjs = 52 处；git rev-parse --git-common-dir（worktree 内）= D:/project/DSH/legion/.git。
- 一次性临时仓库实验（§9.2 A~I）在系统临时目录完成，未触碰本仓；每个实验的成功与失败路径均已实测（如 update-ref 错误 old-oid → exit 128、单独 update-ref 后 status 出现 D feat.txt）。

---

## 附：与验收标准的对应

| 验收标准 | 落点 |
| --- | --- |
| 方案覆盖需求要点，给出 ≥2 个候选方案对比（优缺点/成本/风险） | §3.1/§3.2/§3.3 三方案 + §3.4 对比矩阵；§4 每条决策点含备选 |
| 有明确推荐与理由，依据为真实可查的来源并注明引用 | §0 结论速览 + §3.1 推荐 + §8 引用清单（A/B/C 级证据） |
| 新引入的技术/依赖逐项说明影响（许可/维护/学习成本/生态） | §5.2（拒绝的库逐项）+ §5.3（实际新增技术）+ §5.4（版本下限） |
| 方案结论可直接支撑后续任务拆解 | §6 模块落点映射 + 数据/事务要点 + 集成时序 + 切片顺序 |
