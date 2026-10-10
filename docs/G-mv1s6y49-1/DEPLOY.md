<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本文反映 **2026-10-10**（w/T-202 开工基线 HEAD `cd569616`）的部署与 CI 读数；其中的命令与数字只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/FEATURES.md](../FEATURES.md)（功能手册）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-202 部署与发布说明：Agent 人性化两段式名称 + 人性化头像

> 角色：devops（部署运维员）｜任务：T-202（[auto-goal]｜目标 G-mv1s6y49-1 · software · chain）
> 开工基线 HEAD：`cd569616`（含 T-199 `02da65f4` 功能、T-200 审查、T-201 promote `c52c775d`）
> 上游链：T-198 [TEST_CASES.md](./TEST_CASES.md) → T-199 [IMPLEMENTATION.md](./IMPLEMENTATION.md) → T-200 [../review/T-200-REVIEW.md](../review/T-200-REVIEW.md) → T-201 [TEST_REPORT.md](./TEST_REPORT.md) → **T-202（本文）**
> 本任务边界：**只做构建与部署类操作，不改业务功能代码**；**未获批准不发布生产**（全程只在本机 dev）。
> 目标上下文（将军裁决 v1）：创建时自动生成头像、暂不需要配置；头像必须拟人且非 emoji；范围含全部（含后续自建）；两段式命名；第 5 条被截断待补。

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 构建门禁 | whiteboard `node scripts/build.mjs` **exit 0**；workbench `tsc --noEmit` **exit 0**；workbench `vite build` 在本会话沙箱被 esbuild `spawn EPERM` 挡住（环境限制，普通终端可过，§8） |
| CI 静态阶段（真实 `scripts/ci/run-ci.mjs`） | `syntax / env / boundary / deps / doc` **5/5 PASS**，exit 0（§3.1，原始输出 `T202-evidence/run-ci-patched-stages.log`） |
| CI `test` 阶段 | 真实 `node --test` 聚合器在本会话沙箱**不可直跑**（§8.1，`spawn EPERM`）；改用**等价执行器**逐文件直跑（§3.3） |
| 本目标 6 支新套件 | **41/41 全绿**（9/6/9/5/6/6，全部 exit 0；`T202-evidence/target-suites.log`） |
| 本次 diff | **零产品代码**：仅 `docs/G-mv1s6y49-1/DEPLOY.md`（本文）、`T202-evidence/`（工具与日志）、`docs/DEPLOY.md` §12、`docs/STATUS.md` 一条 T-202 注记 |
| 用户可见行为 | **无新增变更**（功能由 T-199 交付）；手册 §3.2 / 功能索引 F-02 / README §5.1 **逐处复核通过**（§1.2） |
| 生产发布 | **未发布、不放行**：M1/M2（§7.1）未修，T-201 判定 FAIL；本阶段只产出放行材料 |
| 已知未通过项 | M1（备用位面池越界 `s16`）/ M2（重复 POST 头像漂移）在当前树**仍可复现**，归属 T-199 业务代码，本角色不改业务代码（§7.1） |

## 1. 变更范围与影响

### 1.1 本次发布范围

- **功能面（T-199 `02da65f4`，已在 `cd569616` 中，T-202 不改一行）**：
  - **两段式展示名**：每个编队成员 = 拟人称呼 + 既有职能副标题（如「析言 · 需求澄清与拆解」）；
  - **参数化人形内联 SVG 头像**：令牌 `human:<role>`，确定性渲染，非 emoji、非名称首字；
  - 桌面 12 个展示面与移动端统一取 roster 的 `name`/`avatar`（单一来源）；
  - 新建成员由服务端按 role 自动分配令牌（不落 emoji）；种子迁移只替换旧默认值，保留将军自定义值；测试令牌与 6 支新套件登记进 `run-ci.mjs`。
- **本任务（T-202）**：新增本文 + `T202-evidence/`（受限沙箱下的 CI 取数工具与原始日志）+ `docs/DEPLOY.md` §12 + `docs/STATUS.md` 一条注记。**零产品代码、零依赖、零网络。**

### 1.2 变更影响（用户可见行为）与 docSync 三处核验

用户可见面 = 编队成员的展示名与头像（由 T-199 交付）。按验收口径「用户可见行为变更须同步功能手册 + 功能索引 + README 引导段」，本轮**逐处真实复核**：

| 需要的三处 | 位置 | 核验结果 |
| --- | --- | --- |
| 功能手册对应小节 | [docs/FEATURES.md](../FEATURES.md) `§3.2 空间与专属编队`（:71-75） | ✅ 已写两段式展示名 + 人形令牌 + 「头像不需要配置」+ 单一来源与确定性回退 |
| 功能索引 | [docs/FEATURES.md](../FEATURES.md) §4（:268） | ✅ `F-02 空间与专属编队 → 3.2 空间与专属编队 → 已上线`，无断链 |
| README 引导段 | [README.md](../../README.md) §5.1（:147） | ✅ 已写「两段式展示名 + 确定性的人形内联 SVG 头像（非 emoji、离线自足、新建自动分配、暂不需要配置）」 |

`node scripts/ci/check-docs.mjs` **PASS**（11 类校验全绿，README + FEATURES 结构/链接/索引一致）——见 §3.1 `doc` 阶段。

## 2. 环境与拓扑

| 环境 | 用途 | 本次是否执行 | 说明 |
| --- | --- | --- | --- |
| dev（本机 worktree `w/T-202`） | 构建 / CI / 测试 | ✅ 已执行 | `D:\project\DSH\legion\.legion-worktrees\T-202`；Node `v24.19.0` / win32 x64 |
| acceptance（本机 127.0.0.1 三件套） | 冒烟 / 真实服务 | ⛔ 未执行 | 会话纪律：不启动替换服务；拓扑与命令见 [docs/DEPLOY.md](../DEPLOY.md) §2、§4 |
| production | 对外发布 | ⛔ **未授权、未发布** | 需将军批准 + §4 预检全绿；且 M1/M2 未修（§7.1） |

组件与端口（部署时）：team-hub `:8787`（中枢，必启）· workbench `:5173`（指挥台，托管构建产物，非热更）· scrum v1 `:4820`（可选）。
数据面：本任务所有读数组件（含 T-201 探针复跑）均用 `TEAM_HUB_DB=<mkdtemp>/team.db` **临时库 + 真端口**，**未触碰 live `team-hub/team.db`**。

## 3. 构建与 CI（真实命令 × 读数）

### 3.1 真实 `run-ci.mjs` 的静态阶段（挂 stdio 适配补丁后直跑）

```powershell
$env:NODE_OPTIONS='--require=<仓库根>/docs/G-mv1s6y49-1/T202-evidence/ci-sandbox-patch.cjs'
node scripts/ci/run-ci.mjs --out .ci/T-202-ci-stages --only syntax,env,boundary,deps,doc
```

退出码 **0**，5/5 PASS。原始输出：`T202-evidence/run-ci-patched-stages.log`。要点：

| 阶段 | 读数 |
| --- | --- |
| syntax | `ci-syntax: PASS（257 个脚本全部可被 Node 解析）`（18364ms） |
| env | `config scan/sync/check PASS`；`encoding-check: PASS（2849 个文本文件）`（3980ms） |
| boundary | `dsh-boundary: PASS（14 个文件 / 99 处，均在基线内）`；`dsh-pin-drift: PASS（6 条结论、15 个锚点逐字命中）`（1008ms） |
| deps | `workbench/node_modules 就绪（junction → 主 checkout）`（3ms） |
| doc | `check-docs: PASS（11 类校验全绿）` + `spec-progress --check PASS（141/146）` + 阶段 3 闸门 `hot-file-churn CHURN_VERDICT cooled=true`（2240ms） |

> CI 如实打印：本次跑在**脏树**上（已改 1 + 未跟踪 N），因此读数证明的是「**这棵树**是绿的」，不是「提交 `cd569616` 是绿的」。

### 3.2 构建门禁

| # | 命令 | cwd | 读数 | 证据 |
| --- | --- | --- | --- | --- |
| B1 | `node scripts/build.mjs` | `whiteboard` | **exit 0**（`copied 12 shared modules -> apps/web/public/shared/`） | `T202-evidence/build-whiteboard.log` |
| B2 | `node node_modules/typescript/bin/tsc --noEmit` | `workbench` | **exit 0**，无类型错误 | `T202-evidence/build-workbench-tsc.log` |
| B3 | `node node_modules/vite/bin/vite.js build` | `workbench` | **exit 1**：esbuild `spawn EPERM`（沙箱禁管道；**非编译错误**） | `T202-evidence/build-workbench-vite.log` |
| B4 | `node scripts/ci/ci-syntax.mjs` | 根 | **exit 0**（257 脚本） | `T202-evidence/ci-syntax-patched.log` |

### 3.3 `test` 阶段

**（a）本目标 6 支新套件（逐文件真命令，无补丁）**：**41/41 全绿，全部 exit 0**。原始输出 `T202-evidence/target-suites.log`。

| 套件 | 登记（run-ci.mjs） | 用例 | 结果 |
| --- | --- | --- | --- |
| `workbench/scripts/agent-avatar.test.mjs` | :1892 S1 | 9 | ✅ pass 9 / fail 0 |
| `team-hub/scripts/seed-roster.test.mjs` | :1893 S2 | 6 | ✅ pass 6 / fail 0 |
| `team-hub/agent-identity-tokens.test.mjs` | :1894 S3 | 9 | ✅ pass 9 / fail 0 |
| `workbench/scripts/agent-avatar-surfaces.test.mjs` | :1895 S4 | 5 | ✅ pass 5 / fail 0 |
| `workbench/scripts/agent-avatar-settings.test.mjs` | :1896 S5 | 6 | ✅ pass 6 / fail 0 |
| `workbench/mobile/avatar-parity.test.mjs` | :1897 S6 | 6 | ✅ pass 6 / fail 0 |
| **合计** | 6/6 登记 | **41** | **41 pass / 0 fail** |

复跑命令（仓库根）：
```powershell
node --experimental-strip-types workbench/scripts/agent-avatar.test.mjs   # 9/9
node --experimental-strip-types team-hub/scripts/seed-roster.test.mjs      # 6/6
node --experimental-strip-types team-hub/agent-identity-tokens.test.mjs    # 9/9
node --experimental-strip-types workbench/scripts/agent-avatar-surfaces.test.mjs  # 5/5
node --experimental-strip-types workbench/scripts/agent-avatar-settings.test.mjs  # 6/6
node --experimental-strip-types workbench/mobile/avatar-parity.test.mjs    # 6/6
```

**（b）全量 `test` 阶段（573 个 `*.test.mjs`）的尝试与边界**

- 真实 `run-ci --only test` 在本会话**不可直跑**：`node --test` 的**内部** runner 经 primordials 直接 `spawn` 每文件子进程（`node:internal/test_runner/runner:517`），**绕过** public `child_process` 补丁 ⇒ 一律 `spawn EPERM`（§8.1 已单独复现）。这是环境限制，不是门禁判据变化。
- 为给出全量读数，使用等价执行器 `T202-evidence/run-ci-sandboxed.mjs`（逐文件独立进程 + 文件 fd stdio + 同一计数解析器 `scripts/ci/parse-suite-output.mjs`）。**它与真实 `run-ci` 的差异**逐条见 `T202-evidence/README.md`。
- 等价执行器读数（集合 = 573 − EXEMPT 1 − 无 `DSH_CHECKOUT` 时按 `run-ci.mjs:5215-5219` 排除的 `plugins/`、`board-plugin/` 40 = **532** 个）：**530/532 完成，482 文件 PASS / 48 文件 FAIL（用例 9591：pass 9358 / fail 182）；2 个文件在沙箱内挂起未结束**（`team-hub/run-kill-drill.test.mjs`、`team-hub/run-plane-e2e.test.mjs`）。逐文件原始读数 `.ci/T-202-full3/ci.log`。
- **这不是「CI `test` 阶段全绿」，也不把 182 条红都算作本次改动的影响**：等价执行器是**逐文件裸跑**，缺少真实 `run-ci` 的套件上下文（外部包构建、`DSH_CHECKOUT` 派生的宿主夹具、守护/环境变量），因此对**整仓**不是忠实替代。失败按类分布：① 真进程 / 真 DSH / 浏览器类（沙箱禁管道、无浏览器、无 `DSH_CHECKOUT`）：`*-real-process`、`*-dsh-process`、`runtime-contract-cross-process`、`tests/e2e-unified/*`、`tests/browser/*`；② 环境/夹具类（端口、ACL、守护未运行）：`product/launcher/*`、`scripts/prt/{golden-flow,gf001-run,...}`；③ 既有红：`team-hub/run-routes.test.mjs` 8/30（T-193 §10.7 已登记）。**失败输出中没有任何一条指向本次新增文件**（`T202-evidence/`、`DEPLOY.md`）。
- **对本次目标而言，唯一忠实且可复跑的读数是 §3.3(a) 的 6 支新套件 41/41**；整仓测试的权威结论以 [TEST_REPORT.md](./TEST_REPORT.md)（T-201）为准：6 新套件 41/41 + 9 支基线 133 例全绿，但独立探针复现 M1/M2 两项真实失败，**判定 FAIL**（§7.1）。

## 4. 部署 / 发布清单（环境 × 步骤 × 验证项 × 回滚）

> 通用三件套与升级/回滚模板见 [docs/DEPLOY.md](../DEPLOY.md) §4–§6、附录 A。本节为**本批可执行清单**。

### 步骤 0 · 预检（gate，不通过即终止，禁止跳过）

```powershell
git status --short                                                   # 期望：只有本次任务的改动
node scripts/ci/run-ci.mjs --only syntax,env,boundary,deps           # 环境 + 依赖 + 边界
node scripts/ci/check-docs.mjs                                       # 文档门禁 + docSync
```

### 步骤 1 · 构建

```powershell
cd whiteboard ; node scripts/build.mjs                                  # B1，期望 exit 0
cd ..\workbench ; node node_modules/typescript/bin/tsc --noEmit        # B2，期望 exit 0
node node_modules/vite/bin/vite.js build                               # B3，普通终端期望 exit 0（产出 dist/）
```

### 步骤 2 · 发布物暂存（`stage`）

```powershell
node scripts/ci/run-ci.mjs --only build,stage   # 产出 releases/legion-<head>-<date>/{dist,MANIFEST.json,SHA256SUMS.txt}
```

> ⚠️ 本会话**未执行 `stage`**：它要求 `workbench/dist` 存在，而 `vite build` 在本沙箱被 EPERM 挡住（B3）。普通终端 `build` 通过后 `stage` 即可产出（`run-ci.mjs:5463-5498`）。

### 步骤 3 · 部署（本机 acceptance / 生产同构）

```powershell
node team-hub/server.mjs                  # a) 中枢 :8787（必启，先起）
node workbench/scripts/serve.mjs          # b) 指挥台 :5173 托管构建产物（改前端必须先重建）
node team-hub/scripts/seed-roster.mjs     # c) 幂等播种/迁移：只替换旧默认值，**不要删库**
```

### 步骤 4 · 验证 → 通过后按 [docs/DEPLOY.md](../DEPLOY.md) §4.4 模板登记发布记录

### 步骤 5 · 回滚 → 见 §6（触发条件不满足则不进入第 3 步）

**生产闸门**：本阶段**不含**生产发布动作；`scripts/update/publish.mjs` 签名发行、上传与通道指针替换**未执行**（未获批准，且 M1/M2 未清）。

## 5. 验证项清单（本次实测）

| # | 验证项 | 命令 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- | --- |
| V1 | whiteboard 构建 | `node scripts/build.mjs` | exit 0 | exit 0 | ✅ |
| V2 | 前端类型门禁 | `tsc --noEmit`（workbench） | exit 0 | exit 0 | ✅ |
| V3 | CI 静态阶段 | `run-ci --only syntax,env,boundary,deps,doc` | 5/5 PASS | **5/5 PASS，exit 0** | ✅ |
| V4 | 本目标 6 支新套件 | §3.3(a) | 全绿 | **41/41，exit 0** | ✅ |
| V5 | 全量 `test` 阶段 | 见 §3.3(b) | — | 530/532 完成：482 PASS / 48 FAIL（环境类，非目标面）+ 2 挂起 | ⚠️ 非忠实替代（§3.3b） |
| V6 | 文档门禁 / docSync | `check-docs.mjs` | PASS | **PASS（11 类）** | ✅ |
| V7 | 上游缺陷复核 | `T201-evidence/probe-avatar-boundary.mjs` 复跑 | 与 T-201 一致 | M1/M2 **仍复现** | ⚠️（§7.1） |
| V8 | 依赖 / 网络 | 全仓 `package.json` 变化 | 零新增 | 零新增 | ✅ |
| V9 | 脏树诚实标注 | `run-ci` 脏树警告 | 如实打印 | 如实打印（已改 1 + 未跟踪） | ✅ |

## 6. 回滚方案

| 场景 | 操作 | 说明 |
| --- | --- | --- |
| 代码回滚 | `git revert <promote commit>` 或 checkout 到上一版 | 桌面/移动端回到旧渲染；**数据不需要回滚** |
| 数据回滚 | **不需要**：`roster` 的 `name`/`avatar` 只是展示字段，`role` 契约键、`agent_id`、会话/任务归属均未变 | 迁移只替换旧默认值（旧职称名 / 旧 emoji），用户自定义值保留；**不要删库** |
| 配置回滚 | 不需要：本次无新增环境变量、无端口变更 | — |
| 发布物回滚 | 本批未产出 `releases/` 产物（`stage` 需先有 `workbench/dist`） | — |
| 回滚触发条件 | 展示名/头像在任一展示面出现破图、emoji、或同名不同像；或 `seed-roster` 误改用户自定义值 | 触发即回滚并保留现场 |
| 备份 | 升级前备份 `team-hub/team.db`（cp 一份带时间戳的副本） | 见 [docs/DEPLOY.md](../DEPLOY.md) §6.1 |

## 7. 发布门禁与已知缺陷（放行前必须处置）

### 7.1 M1 / M2 —— 归属 T-199 业务代码，本角色只复现、不代改

复跑 T-201 只读探针（临时库 + 真端口，原始输出 `T202-evidence/probe-t201-boundary-rerun.log`），与 T-201 §4 结论**逐字一致**：

- **M1（TC-S3-14 ❌）**：第 16 个自建 role 落库 `human:s16`，而两端位面表只有 `s01..s15`（`slotKeys().length=40`、`resolveSlot('human:s16')=null`）⇒ 第 16 个起退化为同一占位人形，破坏 AC-R3-3。
- **M2（S3 幂等/确定性契约 ❌）**：同一自建 role 连续 3 次 `POST /api/agents` 头像漂移 `s01 → s02 → s01`，与「role 单射/确定性」矛盾。

影响面：仅**同一空间 ≥16 个自建 role**、或**重复提交同一自建 role** 时触发；25 个内置岗位不受影响。**修复归属 T-199（业务代码）**——本任务边界「不改业务功能代码」，故**只复现、只登记**。
**放行结论：M1/M2 清除并由 tester 复测前，不建议验收放行**（与 T-201 §6 一致）。建议将军派 bug/目标任务：或把分配上限收到 15 并在契约写清池满语义，或把两端位面表扩到 `s01..s99`。

### 7.2 未执行项（不虚报）

| 项 | 原因 |
| --- | --- |
| `smoke` / `stage` 阶段 | 需要 `workbench/dist`；本会话 `vite build` 被沙箱 EPERM 挡住（B3） |
| `test` 阶段经真实 `run-ci` 直跑 | `node --test` 内部子进程 spawn 绕过补丁 ⇒ EPERM（§8.1） |
| 全量 `test` 阶段经等价执行器跑绿 | 等价执行器是逐文件裸跑、缺套件上下文，对整仓非忠实替代；48 文件红集中在真进程/环境类（§3.3b） |
| DSH 外部包回归（`plugins/`、`board-plugin/`） | 本机未配 `DSH_CHECKOUT`；真实 `run-ci` 与 CI 同纪律整组 SKIP（`run-ci.mjs:5215-5219`），不伪造通过；等价执行器同样排除这 40 个文件 |
| E2E 浏览器遍历 / 人工判据（E2E-2/5、TC-S4-08/10、TC-S6-07） | 本环境无浏览器、无独立评审人；与 T-201 §7 同口径 |
| 生产发布 | 未获将军批准（边界：未获批准不发布生产），且 M1/M2 未清 |

## 8. 本会话沙箱限制（如实标注，不冒充通过）

### 8.1 现场：piped stdio 一律 EPERM

```text
$ node scripts/ci/run-ci.mjs --out .ci/T-202-smoke --only syntax,env
[syntax] exception: spawn EPERM
[env]    exception: spawn EPERM
node:internal/child_process:458 ... Error: spawn EPERM
    at file:///D:/.../scripts/ci/run-ci.mjs:78:19        # exec() 的 spawn
```

全文 `T202-evidence/run-ci-attempt.log`。实测边界：`stdio:'inherit'|'ignore'|文件 fd` 正常，**默认管道 `stdio:'pipe'` 一律 EPERM**；`node --test` 聚合器即便挂补丁也 EPERM（内部 runner 不走 public API，实测栈 `node:internal/test_runner/runner:517`）。

### 8.2 为取得证据所做的适配（不改变被测行为）

- `ci-sandbox-patch.cjs`：把一次性捕获的管道换成临时文件 fd，子进程退出后经内存流回放；只覆盖 public 的 `spawn/spawnSync/execFileSync/execSync/execFile/exec`；**对 esbuild 这类交互式子进程保持原样**，让沙箱限制如实暴露（`vite build` 仍 EPERM）。
- `run-ci-sandboxed.mjs`：`test` 阶段的等价执行器；**与真实 `run-ci` 的差异**（集合构成、无 `node --test` 聚合器、`--experimental-strip-types` 统一开启、无套件分组）逐条见 `T202-evidence/README.md`；条件套件目录 `plugins/`、`board-plugin/` 按真实 `run-ci` 规则在无 `DSH_CHECKOUT` 时排除。

## 9. 证据清单

| 文件 | 内容 |
| --- | --- |
| `T202-evidence/README.md` | 证据目录说明与复跑命令（含等价执行器与真实 CI 的差异） |
| `T202-evidence/run-ci-patched-stages.log` | 挂补丁后真实 `run-ci` 静态阶段 5/5 PASS 完整输出 |
| `T202-evidence/run-ci-attempt.log` | 不挂补丁直跑 `run-ci` 的 EPERM 原始现场 |
| `T202-evidence/build-whiteboard.log` · `build-workbench-tsc.log` · `build-workbench-vite.log` | 构建门禁 B1/B2/B3 命令与退出码 |
| `T202-evidence/target-suites.log` | 6 支新套件逐条断言（41/41） |
| `T202-evidence/ci-syntax-patched.log` | `ci-syntax.mjs` 原始输出 |
| `T202-evidence/ci-sandbox-patch.cjs` | stdio 适配补丁（非产品代码） |
| `T202-evidence/run-ci-sandboxed.mjs` | `test` 阶段等价执行器（非产品代码） |
| `T202-evidence/probe-t201-boundary-rerun.log` | M1/M2 在当前树上的复核输出 |
| `.ci/T-202-ci-stages/ci.log` · `summary.json` | 本次静态阶段机读汇总（`.ci/` 已被 gitignore） |
| `.ci/T-202-full*/ci.log` · `summary.json` | 全量 `test` 阶段逐文件读数与汇总（`.ci/` 已被 gitignore） |
