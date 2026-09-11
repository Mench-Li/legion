# 架构重构未完成期间可并行开展的任务评估

> 评估对象：`docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`（Product Runtime 功能清单 F-01～F-25）
> 评估问题：**哪些任务可以在架构重构完成之前开展？**
> 评估日期：2026-09-11；评估基线：`main`（`f838b06`）+ 未合并分支 `codex/prt-phase0-1`、`codex/product-runtime-design`
> 性质：**决策输入，不是任务清单**。本文不改设计、不排期，只回答「现在能不能做、为什么」。

---

## 0. 一句话结论

**能立刻做的是「规格自己已经钦定的下一批」——阶段 2 收尾 + 阶段 2.5 薄垂直切片；而不是 F 清单里看起来最独立的那些 P1/P2 功能。**
F-15～F-25 虽然与执行契约正交，但它们在 145 任务规格里**没有任务号、没有验收口径**，而且多数会写进 `team-hub/server.mjs` / `plugins/src/index.ts` 这两个正等着被提取的热点文件——**现在做，等于把 PRT-315/316 已通过的低 churn 门禁重新打红**。

真正与重构正交、且不加热热点文件的，只有三类：**新目录/新包（Launcher、SecretStore、Doctor、Pack 协议）、脚本与测试、发布与版本治理**。

---

## 1. 判定口径（三道闸）

一个任务算「重构未完成期间可以做」，必须同时过三道闸：

| 闸 | 判据 | 反例 |
|---|---|---|
| **闸 1：不依赖新抽象** | 不需要 `RuntimeAdapter` / `Run` / `Attempt` / `ContextSnapshot` / `CompiledTeamPlan` / DSH 强制面任何一个先存在 | 「接入 pre-execute」必须先有补丁层与 Adapter 装配点 |
| **闸 2：不加热提取目标** | 不往 `plugins/src/index.ts`（22.5 万字节）或 `team-hub/server.mjs`（26 万字节）里加新逻辑；新表、新路由、新调度分支都算加热 | 在 `server.mjs` 里加 `usage_records` 表 + 三个路由 |
| **闸 3：有独立可验证面** | 能靠本仓 `run-ci` 单独回归，不需要真实宿主/真实模型才能给出结论 | 「审批闭环可用」需要真实宿主 + 真实工具调用 |

> 闸 2 的量化依据：`codex/prt-phase0-1` 附录 A.4 记录，PRT-315/316 的评审门禁是按「两个热点文件最近 40 个提交只被触及 1 / 2 次（历史峰值 9 / 7）」通过的，可用 `scripts/prt/hot-file-churn.mjs` 复算。
> **这条门禁是一次性快照：往这两个文件里加一波功能，它就不再成立。**

---

## 2. 四个必须先校正的事实

这四点决定了「哪些能做」的答案与直觉不同，先说清楚。

### 2.1 这份 F 文档指向的 145 任务规格，不在 `main` 上

- `docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md:3` 引用 `docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md`；
- `main` 的 `docs/superpowers/specs/` 只有 `2026-09-10-f01-*`、`2026-09-10-f02-*` 两份（`git ls-tree main docs/superpowers/specs/`）；
- 该规格实际只存在于 `codex/product-runtime-design` 与 `codex/prt-phase0-1` 分支（1265 行，§12 任务树 + 附录 A）。

**含义**：现在读这份 F 文档的人，看不到它自己的实施口径与进度。**「先让规格可见」本身就是一件可以立刻做的事**，且零架构风险。

### 2.2 重构不是「没开始」，而是「19% 已完成但未合入」

`codex/prt-phase0-1` 上已落地（附录 A.1）：

| 内容 | 落地物 | 测试 |
|---|---|---|
| 阶段 0 基线（拓扑/边界/配置/黄金流程/备份/组合基线/分发决策） | `docs/superpowers/prt/*`、`scripts/prt/*` | 20+14+14+16+22 例 |
| 阶段 1 Runtime Contract + Fake Adapter | `runtime/contracts/` | 62 例 |
| 阶段 2 Adapter 主体（PRT-201～209） | `runtime/adapters/dsh/` | 85 例 |
| 执行面依赖棘轮（PRT-002/108） | `scripts/ci/dsh-boundary.mjs` + `boundary` 阶段 | 22 例 |

而 `main` 上：**没有 `runtime/`、没有 `product/`、没有 `orchestrator/`，`run-ci` 仍只有 7 个阶段（env/deps/build/test/smoke/stage/doc），没有 `boundary` 阶段**。
（分支读数：附录 A 记 `test` 47 套件 / 1230 用例；`main` 基线是 39 套件 / 1049 用例，见 `docs/STATUS.md` §2。）

**含义**：最高价值、最低风险的一件事不是「新开并行功能」，而是**把这条分支收敛合入**——尤其是 `boundary` 棘轮，它是唯一能阻止后续所有并行开发继续增加 DSH 直连的守卫。

### 2.3 规格已经给了排序，而且带停止条件

- §13：「第一实施批次锁定在阶段 0～2，并立即接阶段 2.5 薄垂直切片」；
- 附录 A.5：「**§13 的 Program 级停止条件优先于排期**：M1.5 评审未达标则暂停阶段 3～4。因此下一批应是**阶段 2 + 2.5**，不是阶段 3」；
- §13 停止条件：若设计伙伴不能在无开发协助下完成「安装 → BYOK → 单员工任务 → 查看结果 → 重启恢复」，则暂停阶段 3～4，项目收缩为 Launcher / 模型配置 / 受限单员工 / 诊断 / 升级。

**含义**：阶段 2.5 被设计成「**就是要在阶段 3 大重构之前做的**」。所以严格回答用户的问题：**阶段 2.5 不是「重构期间可以做的事」，它就是重构的前一段。**

### 2.4 F-15～F-25 在权威规格里没有任务号

在 `docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md` 中，P1 的 F-15～F-20 与 P2 的 F-21～F-25 是段落式条目；
而 145 任务规格的阶段 10 只到「能力包协议」（PRT-1001～1006）。逐词检索该规格：`压缩` 1 次（且指事件体量压缩）、`摩擦` 0 次、`自动化计划` 0 次、`多 Harness` 0 次、`外部渠道` 0 次、`Docker` 0 次。

**含义**：F-15～F-25 **既不属于本轮重构，也没有被本轮重构阻塞**——但它们同样没有任务分解与验收标准。要做，得先补规格，否则会得到「做了但不算数」的产物。

---

## 3. 分类清单

### 3.1 A 类：立即可做（三闸全过）

| # | 任务 | 对应 | 为什么不被阻塞 | 落点（不加热热点文件） | 验收方式 |
|---|---|---|---|---|---|
| A1 | **收敛合入阶段 0～2 产物** | PRT-001～011、101～109、201～209 | 已完成、已有测试，只是不在 `main` | `runtime/contracts/`、`runtime/adapters/dsh/`、`scripts/prt/`、`scripts/ci/dsh-boundary.mjs` | 分支 `test` 47 套件 / 1230 用例复跑 + `boundary` 阶段 PASS |
| A2 | **跑一次真实黄金流程** | PRT-005、PRT-009 的 pending 段 | 夹具 GF-001 已冻结，缺的只是「真跑一次」 | `scripts/prt/gf001-run.mjs` + `docs/PRT-006-evidence/` 同规格证据 | 产出旧路径任务状态序列 / 执行事件 / 产物 / 审计 + token、耗时、费用估算、峰值资源读数 |
| A3 | **执行面依赖棘轮进 `main`** | PRT-002、PRT-108 | 纯静态扫描，与运行时不交互 | `scripts/ci/dsh-boundary.mjs` + baseline json + `boundary` 阶段 | 22 例 + 基线对拍；新增 DSH 直连即红 |
| A4 | **Product Launcher 最小版** | PRT-251、PRT-701/702/703/704/705 | 只管理进程生命周期，与编排语义无关 | 新目录 `product/launcher/`（规格 §11 已预留） | 端口冲突/依赖缺失/配置错误诊断、退避重启、优雅关闭、僵尸清理的独立测试 |
| A5 | **SecretStore 最小闭环 + per-user DataDir** | PRT-254、PRT-505、PRT-257 | 规格 A.2 已裁决：**复用 `$DSH_HOME/.credentials.yaml` 的 `{version, refs, records}`，不要另建密钥库**；且 A.2 已确认 4 个 path 字段默认值落在安装目录内需 DataDir 承接 | `security/secrets/` + `product/` 目录布局 | 密钥读取/轮换/删除/泄漏测试；提示词、日志、审计、导出均不含明文 |
| A6 | **产品配置 Doctor：版本化迁移 + 预览 + 自动修复** | F-13 剩余部分（统一配置引擎已存在：`packages/shared/src/config.mjs`、`scripts/config/check.mjs`，6 个配置面 / 64 字段） | 纯配置面，与执行面无关；规格 A.2 已确认「环境变量声明缺口为 0」，即该地基已就绪 | `packages/shared/src/`、`scripts/config/` | 迁移预览、幂等版本迁移、脱敏有效配置的用例 |
| A7 | **产品版本清单与版本绑定** | PRT-801、PRT-802、PRT-011 路线 C 收口 | 清单是数据，不是运行时 | `product/` + 版本清单文件 | 版本不一致时禁止自动执行（这一条本身也只是清单判定） |
| A8 | **备份与幂等迁移框架** | PRT-006 已做、PRT-806、PRT-807 | 数据库备份已在分支验证（14 例）；迁移框架与业务无关 | `docs/PRT-006-evidence/`、迁移模块 | 「恢复前后**缺口集合**一致」（A.2 修正口径：`audit.seq` 允许有缺口） |
| A9 | **文档合入与口径统一** | — | 零运行时风险 | `docs/superpowers/specs/`、`docs/STATUS.md` | `--only doc` PASS |

### 3.2 B 类：技术上可做，但会加热提取目标或与重构抢同一块地

**建议：要么等两个热点文件降温后再做，要么按「一个切片一次对拍」的方式做，并接受 PRT-315/316 提取时要重做一次。**

| # | 任务 | 加热点 | 说明 |
|---|---|---|---|
| B1 | F-05 可靠投递状态机（`pending/delivering/delivered/suppressed/failed/unknown`） | `team-hub/server.mjs`（新表 + 新状态机） | F-01 第一阶段（scope / `sinceSeq` / 持久游标 / `Last-Event-ID`）**已并入 `main`**；剩下的投递状态机设计上独立于 Adapter，但落地即在热点文件 |
| B2 | F-10 控制面部分：canonical operation 哈希（PRT-611）、审批 TTL（PRT-615）、`allow-once` 原子 CAS（PRT-616）、`tool_calls` 记录（PRT-601/610） | `team-hub/server.mjs` + `permission-engine.mjs` | 纯策略/纯函数部分可先做，且 PRT-611 明确要替换键序敏感的 `JSON.stringify` 判等——这是既有缺陷 |
| B3 | F-17 长会话压缩（版本化摘要、原始消息不可变） | `team-hub/server.mjs`（chat 域）+ `plugins/src/index.ts`（chat 守护段） | 现状只有**截断预算**（`plugins/src/chatResponder.ts` 的 `fitContextBudget`）与 `spaceDigest` 摘要，没有「压缩摘要版本化」 |
| B4 | F-18 经验图谱 / 摩擦学习 | `plugins/src/experience*.ts` + `team-hub` | 已有 `experience.ts` / `experienceRecall.ts` / `experienceVotes.ts`；「纠正、拒绝、回滚先形成审核草稿」的信号源（audit）已具备 |
| B5 | F-19/F-20 PackManifest 协议纯部分（PRT-1001、PRT-1002） | 新目录 `packs/`（不加热） | 但「能力包升级只影响之后创建的目标」依赖 `CompiledTeamPlan`（PRT-1004）→ 完整功能属重构 |
| B6 | F-15 的纯部分：价格表版本冻结（PRT-511）+ 用量采集纯模块（PRT-207 已在 Adapter 内） | 新模块（不加热） | 完整功能（预算预留/结算/硬阻止）依赖 `agent_runs`/`usage_records` 与 Run 归属 → 属重构 |
| B7 | F-16 的日历投影部分 | `team-hub/server.mjs` | 现状：`calendar_events` 表 + 重复展开 + 冲突检测已有；缺「计划 / 运行历史 / 时区 / skip-on-overlap / 补跑 / 审批暂停」——这些的执行语义依赖 Run |
| B8 | F-24 多用户 ACL | `team-hub/server.mjs`（约 30 个读端点 + SSE + 附件） | 现状是 token + 回环开放矩阵（已完成，14 例）；产品当前是 per-user 单机安装，优先级低 |

### 3.3 C 类：必须等重构（硬依赖）

| # | 任务 | 硬依赖 |
|---|---|---|
| C1 | F-01 Runtime Contract / F-02 DshRuntimeAdapter / F-03 Runtime Manager | 本体即重构；阶段 2 的 PRT-210～215（对拍、continuable session 边界、最小强制面、sandbox 探测、组合补丁层、启动自检）仍未启动 |
| C2 | F-04 Orchestrator Core（提取 task/attempt/lease/run） | 阶段 3；且 PRT-316 须排在 team-hub 启动期并发迁移加固（`0db37af`）沉淀一个完整发布周期之后 |
| C3 | F-06 的 `recover()` 与终态仲裁 | 依赖 Attempt/Run 实体与「team-hub 首个终态为准」的持久化状态机 |
| C4 | F-07 Context Snapshot 的持久化与来源清单 | 依赖 Run 上下文与 `contextVersion`；纯函数部分（canonical JSON / token 估算 / 预算裁剪）可提前为独立包，属 B 类 |
| C5 | F-10 / F-11 的**执行面接线** | 依赖 §6.9 的 host 组合补丁层（PRT-214/215）与 Adapter 装配点；规格明确：补丁层未生效按 `incompatible` 处理并禁止自动执行 |
| C6 | F-15 的预算硬阻止与 Run 归属 | 依赖 `agent_runs` + `usage_records` |
| C7 | F-16 的执行语义、F-21 连接器、F-22 执行后端、F-23 多 Harness、F-25 外部渠道 | 依赖 Run 抽象、权限档位、SecretStore 与投递状态机的组合 |
| C8 | PRT-315 / PRT-316（拆分两个热点文件） | 阶段 3，且有自己的前置门禁 |

---

## 4. 建议的并行批次

```text
批次 1（现在，同一批）—— 规格钦定的「阶段 2 + 2.5」，与阶段 3 无关
  A1 收敛合入阶段 0～2（含 boundary 棘轮 A3）
  → A2 跑一次真实黄金流程（补齐 PRT-005 / PRT-009 pending）
  → 收尾 PRT-210～215（对拍 / session 边界 / 最小强制面 / sandbox 探测 / 组合补丁层 / 启动自检）
  → A4 Launcher 最小版 + A5 SecretStore 最小闭环 + per-user DataDir + A7 版本清单
  → M1.5 评审：设计伙伴能否在无开发协助下走完 安装 → BYOK → 单员工任务 → 查看结果 → 重启恢复

批次 2（可与批次 1 并行，不同平面，不加热热点文件）
  A6 配置 Doctor（版本化迁移 / 预览 / 自动修复）
  A8 备份与幂等迁移框架
  A9 文档合入与口径统一（让规格在 main 上可见）

批次 3（两个热点文件降温后，或按「一个切片一次对拍」做）
  B2 → B1 → B3/B4 → B5/B6 → B7/B8
```

**批次 1 的停止条件优先于批次 3 的排期**（规格 §13）：M1.5 未达标，就不要启动阶段 3 的大规模编排提取。

---

## 5. 明确不要现在做

1. **不要为了「有产出」把 F-15～F-25 直接开工。** 它们在 145 任务规格里没有任务号与验收口径，先补规格（哪怕一页）再动手。
2. **不要往 `team-hub/server.mjs` / `plugins/src/index.ts` 批量加新表与新路由。** 这会一次性推翻 PRT-315/316 的低 churn 门禁，而这两个文件正是本轮重构的主要成本来源（§2.1）。
3. **不要在阶段 2 接线（PRT-210～215）之前宣称「多员工编排可恢复」。** 现状：`plugins/src/index.ts` 有 16 处直接 DSH 调用（`ctx.subagents` 6 / `ctx.agentDefaultModel` 4 / `ctx.plugin` 2 / `ctx.effect` 2 / `ctx.setInterval` 2），其中 `run.result` 可能永不结算、abort 不保证终止子代理（规格 A.2 第 4 条，现场注释在 `plugins/src/index.ts:2241`）。
4. **不要在新强制面完成前解除 legacy 的高风险工具限制。** 规格 §6.8 明确：在完成 DSH 强制面接线前，legacy 路径禁止高风险工具；「未批准高风险写操作为零」只有在该门禁满足后才成为发布指标。
5. **不要用新的权限预设表覆盖 DSH 默认表。** 默认表把 `workspace-write ↔ ask`、`danger-full-access ↔ never` 绑定；按默认表实现「无人值守 = `policy=never`」会同时把沙箱降级为 `danger-full-access`（规格 §6.9）。

---

## 6. 待用户裁决的问题

1. **批次 1 是否按规格启动**（即阶段 2 收尾 + 阶段 2.5），还是先做 F 清单里其它更「像功能」的条目？
2. `codex/prt-phase0-1` 是**直接合入 `main`**，还是先合 `codex/product-runtime-design`（规格与文档）再合实现？
3. F-15～F-25 是否需要先补一页规格（任务号 + 验收口径 + 依赖），才允许开工？
4. 是否把「新功能不得直接写入两个热点文件」升级为可执行门禁（并入 A3 的 `boundary` 阶段）？

---

## 附：本篇用到的复算命令

```powershell
cd D:\project\DSH\legion
git ls-tree --name-only main docs/superpowers/specs/            # 规格是否在 main 上
git ls-tree --name-only main | Select-String 'runtime|product|orchestrator'
git diff --stat main..codex/prt-phase0-1                        # 分支已落地内容
git show codex/prt-phase0-1:docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md   # 145 任务规格（含附录 A 进度）
node scripts/prt/hot-file-churn.mjs                             # PRT-315/316 门禁复算（在分支上）
node scripts/ci/run-ci.mjs --only test                          # main 基线：39 套件 / 1049 用例
```
