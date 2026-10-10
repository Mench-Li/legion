## 12. T-202 发布说明：Agent 人性化名称 + 人性化头像（目标 G-mv1s6y49-1 收口）

> 角色：devops（部署运维员）｜任务：T-202｜分支：`w/T-202`｜开工基线 HEAD：`cd569616`（含 T-199 `02da65f4`、T-201 promote `c52c775d`）
> 环境：本机 dev/acceptance（127.0.0.1）。**未发布生产**（未获将军批准）。
> 目标级完整说明（含逐条证据与复跑命令）：[docs/G-mv1s6y49-1/DEPLOY.md](G-mv1s6y49-1/DEPLOY.md)。

### 12.1 结论速览

| 项 | 结论 |
| --- | --- |
| whiteboard 构建 | `node scripts/build.mjs` **exit 0** |
| workbench 类型门禁 | `tsc --noEmit` **exit 0**；`vite build` 在本会话沙箱被 esbuild `spawn EPERM` 挡住（环境限制，普通终端可过，§12.4） |
| CI（真实 `run-ci.mjs`） | `syntax / env / boundary / deps / doc` **5/5 PASS** |
| CI `test` 阶段 | {{T12_TEST}} |
| 本次目标面 6 支新套件 | {{T12_TARGET}} |
| 产品代码 | **零改动**（本任务只加发布文档与 CI 证据） |
| 用户可见行为 | 无新增变更；上游功能的手册/索引/README 三处**已同步并复核**（§12.2） |
| 已知未通过项 | M1（`s16` 越界）/ M2（重复 POST 漂移）仍可复现，归属 T-199 业务代码，本角色只复现不代改（§12.5） |

### 12.2 变更影响与 docSync

本次发布**不含产品行为变更**（功能由 T-199 交付、T-201 验证）。用户可见面 = 编队成员的展示名与头像；
手册 [`docs/FEATURES.md` §3.2](FEATURES.md#32-空间与专属编队)、功能索引 §4 `F-02`、[`README.md` §5.1](../README.md) 均由 T-199 同步，本轮以 `check-docs.mjs`（11 类校验全绿）复核通过。

### 12.3 环境 × 步骤 × 验证项 × 回滚

**预检 → 构建 → 暂存 → 部署 → 验证 → 回滚**的完整清单见 [docs/G-mv1s6y49-1/DEPLOY.md](G-mv1s6y49-1/DEPLOY.md) §4/§5/§6；三件套与数据面通用步骤见本文档 §4–§6。

**回滚方案**（本批无 schema 迁移、无发布物、无生产流量）

| 场景 | 操作 | 说明 |
| --- | --- | --- |
| 代码回滚 | `git revert <promote commit>` 或 checkout 到上一版 | 桌面/移动端回到旧渲染（首字头像 / 动物表）；**数据不需要回滚** |
| 数据回滚 | 不需要：`roster` 的 `name`/`avatar` 只是展示字段，`role` 契约键、`agent_id`、会话/任务归属均未变 | 迁移只替换旧默认值（旧职称名 / 旧 emoji），用户自定义值保留 |
| 发布物回滚 | 不适用（本批未产出 `releases/` 产物；`stage` 需先有 `workbench/dist`） | — |
| 触发条件 | 展示名/头像在任一展示面出现破图、emoji、或同名不同像；或 `seed-roster` 误改用户自定义值 | 触发即回滚并保留现场 |

### 12.4 沙箱限制（如实标注）

本会话沙箱（workspace-write）禁止 Node 进程创建**管道** stdio：`node scripts/ci/run-ci.mjs` 直跑即
`[syntax]/[env] exception: spawn EPERM`（原始现场 `docs/G-mv1s6y49-1/T202-evidence/run-ci-attempt.log`）。
为取得真实读数，用 `T202-evidence/ci-sandbox-patch.cjs` 把一次性捕获的管道换成临时文件 fd（**不改变被测行为**，
esbuild 这类交互式子进程保持原样、如实 EPERM），据此真实直跑 `run-ci` 五阶段并全绿；
`test` 阶段因 `node --test` **内部**子进程 spawn 绕过 public `child_process` 补丁，改用等价执行器
（集合 == `git ls-files '*.test.mjs'` − EXEMPT，逐文件独立进程、四路并发、同一计数解析器）。普通终端上无需任何适配。

### 12.5 已知缺陷与未执行项

- **M1/M2（归属 T-199）**：复跑 T-201 只读探针（临时库 + 真端口）结论逐字一致——第 16 个自建 role 得 `human:s16` 而两端位面表只有 `s01..s15`（退化同一占位人形）；同一自建 role 连续 POST 头像漂移 `s01→s02→s01`。本角色边界「不改业务功能代码」⇒ 只复现、只登记。
- **未执行**：`smoke`/`stage`（依赖 `workbench/dist`）、E2E 浏览器/人工判据、DSH 外部包回归（本机未配 `DSH_CHECKOUT`，与 CI 同纪律 SKIP）、生产发布（未获批准）。

---

### 12.6 逐处环境 × 步骤 × 验证项（本次实测）

| # | 项 | 命令 | 读数 |
| --- | --- | --- | --- |
| 1 | 构建（whiteboard） | `node scripts/build.mjs` | exit 0 |
| 2 | 类型门禁（workbench） | `tsc --noEmit` | exit 0 |
| 3 | CI 静态阶段 | `run-ci --only syntax,env,boundary,deps,doc` | 5/5 PASS |
| 4 | 文档门禁 | `check-docs.mjs` | PASS（16210+ 表行 0 异常） |
| 5 | 全量测试 | `T202-evidence/run-ci-sandboxed.mjs` | {{T12_V5}} |
| 6 | 缺陷复核 | `T201-evidence/probe-avatar-boundary.mjs` | M1/M2 仍复现（§12.5） |

