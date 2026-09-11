<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **PRT 阶段 0～1 基线冻结时**（2026-09-11）的采集结果，其中的文件规模、路由数、就绪耗时与结论只代表当时状态；`pending` 段当时的空白已在同日由 GF-001 真实执行部分结清（见 §3）。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· [docs/CONFIG.md](../CONFIG.md)（统一配置）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-009 成本 / 延迟 / 资源基线证据

**切片**：PRT-004 / PRT-007 / PRT-009（黄金流程定义 + 旧系统平台契约基线 + 成本延迟基线）
**日期**：2026-09-11
**分支**：`codex/prt-phase0-1`
**采集机器**：`win32/x64`，Node `v24.19.0`
**验证**：`run-ci --only env,boundary,deps,build,test,smoke,stage,doc` **八阶段全 PASS**；
`test` **52 套件 / 1401 用例**（证据 `.ci/prt-phase0-1-final/`）

> **本次新增（承接 GF-001 真实执行）**：§3 把原先「待采集」的六项结清了四项。
> 结清靠的不是再跑一次，而是**把已经发生的那次真实执行读出来**——
> 数值来自 provider 上报的 usage 与审计写入时间，不是估算。

---

## 1. 本次交付

| 产物 | 说明 |
| --- | --- |
| `scripts/prt/golden-flow.mjs` | 黄金流程与固定夹具定义（纯模块，无 I/O） |
| `scripts/prt/baseline-snapshot.mjs` | 旧系统平台契约基线提取器（HTTP / 表 / 状态机） |
| `scripts/prt/baseline-measure.mjs` | 成本 / 延迟 / 资源基线采集器（含「待采集清单」结清状态解析） |
| `scripts/prt/dsh-session-usage.mjs` | **新**：从 DSH 会话转录提取真实 token 用量与耗时 |
| `scripts/prt/gf001-run.mjs` | **新**：黄金流程执行台与证据组装（`report --out=`） |
| `docs/superpowers/prt/prt-007-baseline.json` | 平台契约基线（85 路由 / 22 表 / 7 状态 / 20 迁移边） |
| `docs/superpowers/prt/PRT-004-golden-flow.md` | 黄金流程定义（GF-001） |
| `docs/superpowers/prt/PRT-009-baseline.md` | 自动生成的基线报告（结清状态随之更新） |
| `docs/superpowers/prt/prt-009-gf001-execution.json` | **新**：跑通那一轮的验收重算 + token + 耗时 + 模型偏差 |
| `docs/superpowers/prt/prt-009-execution-evidence.json` | **新**：`software` 空间旧路径的状态序列 / 耗时 / 人工 / 可用性 |
| `docs/superpowers/prt/prt-009-gf001-controlled-evidence.json` | **新**：受控空间 `gf001` 的同一组指标（含两次中止轮次） |
| `docs/PRT-005-evidence/verify-evidence.md` | **新**：PRT-005 旧路径执行状态证据（逐条口径与复现命令） |

> ⚠️ `prt-009-execution-evidence.json`（`software`，生产）与
> `prt-009-gf001-controlled-evidence.json`（`gf001`，受控）是**两个不同总体**，
> 数值不可互相冒充：前者的耗时混入了等待人工与等待下一轮的时段，
> 后者全链 `gate=0` 自动推进。做回退判断只能用同一总体 + 同一口径。

---

## 2. 已测量（可重复采集，不需要模型凭证）

### 2.1 平台契约基线（PRT-007）

| 项 | 值 |
| --- | --- |
| HTTP 路由（`/api/*`） | **85** |
| SQLite 表 | **22** |
| 任务状态 | **7** |
| 任务迁移边 | **20** |
| 目标状态 | **4** |
| 权限模式 | **5** |

源文件哈希随基线一同记录，漂移可归因到 `team-hub/server.mjs` 或
`team-hub/permission-engine.mjs`。

**口径说明**：只收 `/api/*`。静态资源与内部路径不属于平台契约——把
`/index.html` 算进去会让「契约漂移」被前端调整淹没。

### 2.2 源码规模

| 文件 | 规模 |
| --- | --- |
| `plugins/src/index.ts` | 221,631 字节 / 3,718 行 |
| `team-hub/server.mjs` | 259,698 字节 / 4,488 行 |
| `team-hub/permission-engine.mjs` | 3,561 字节 / 57 行 |
| `runtime/contracts/` | 9 文件 / 104,056 字节 |
| `scripts/ci/dsh-boundary.mjs` | 18,199 字节 / 461 行 |

这两个大文件的规模正是 spec §2.1 判定的**真实迁移成本所在**：DSH 的 API 级耦合很薄
（`dsh-boundary` 实测全仓库仅 26 处执行面记号、3 个文件），成本集中在这两个单文件模块。

### 2.3 进程就绪基线

| 项 | 值 |
| --- | --- |
| team-hub 首次就绪 | 单次值（同日多次采集落在 **229 / 240 / 361 ms**） |

**就绪判据是端口可连接**，不是「进程未退出」。进程活着但 HTTP 未监听是最常见的
假就绪，用它当判据会得到一个漂亮但无意义的数字。

采集在临时数据目录中进行，不触碰真实库；失败时返回 `{ok:false, reason}` 而不抛错——
基线采集不应因本机环境差异让整个工具失败。

⚠️ **这是一个单样本，且已经观察到约 1.6 倍的抖动**（229 → 361 ms）。
不应把其中任何一个数当成「就绪基线」去判断阶段 3 是否回退；
按 §7 的未覆盖项，阶段 3 前应取 3 次中位数并记录离散度。

---

## 3. 已由 GF-001 真实执行采集

2026-09-11 在受控隔离空间 `gf001` 跑通黄金流程 GF-001（planner → implementer → reviewer，
三岗位真实模型调用）。以下数值由 `dsh-session-usage.mjs` 与 `gf001-run.mjs report` 从
**DSH 会话转录**与 team-hub 看板读出，机器可复算。

### 3.1 `token-usage`（曾有：无数据）

| 岗位 | 任务 | input | output | cacheRead | 合计 |
| --- | --- | --- | --- | --- | --- |
| planner | T-144 | 29,907 | 30,765 | 1,004,416 | 1,065,088 |
| implementer | T-145 | 15,943 | 7,510 | 236,672 | 260,125 |
| reviewer | T-146 | 22,972 | 11,847 | 322,176 | 356,995 |
| **合计** | | **68,822** | **50,122** | **1,563,264** | **1,682,208** |

**口径**：`totalTokens = inputTokens + outputTokens + cacheReadTokens`，即 `inputTokens`
**不含**缓存命中的输入。把 total 当作 input+output 会低估约一个量级。实测的 8 条会话转录
全部满足该恒等式，0 条不符（不符会计入 `mismatchRecords` 而不是静默相加）。

### 3.1.1 每个岗位任务下有**两条**会话，只有一条该算

采集时发现：每个岗位任务的 worktree 下同时存在两条会话转录。

| 会话 | 存活 | token |
| --- | --- | --- |
| `scrum-worker-foreman-<n>`（派工**工头**） | 约 0.17s | **0** |
| 一条 UUID 会话（真正干活的 worker） | 数十秒到数分钟 | 全部用量 |

证据 JSON 里 `attachedToRole: 3` 而 `inGoal: 6`，差额 `superseded: 3` 就是被合并的工头会话
（逐条列在 `runs[].supersededSessions` 里，**不是静默丢弃**）。

**为什么要在证据里保留这三个 0**：如果工具直接过滤掉零用量会话，这个事实就消失了，
下一个人看到「6 条会话 / 3 个岗位」只会一头雾水，或者更糟——把 6 当成分母。
反过来，如果不去重，`runs` 会翻倍、`attachedToRole` 会虚高成 6，读的人会以为跑了六轮。
保留 + 合并 + 显式列出差额，是唯一能同时避免这两种误读的做法。

### 3.2 `end-to-end-latency`（曾有：仅预期）

| 层级 | 值 |
| --- | --- |
| 目标级（`G-mtwxx7an-2`，createdAt → endedAt） | **402.0s** |
| planner（T-144） | 219.6s |
| implementer（T-145） | 53.6s |
| reviewer（T-146） | 103.4s |
| 三岗位会话墙钟合计 | 373.3s |

目标级与三岗位之和的差（约 28.6s）是阶段之间的派工轮询间隔，**不是**某一步变慢了。
两个数都给出来，就是为了让这 28.6s 有地方落，而不是被当成噪声。

### 3.3 一个必须记下来的实测偏差：模型分工**没有生效**

| 岗位 | 声明模型 | **实际执行模型** |
| --- | --- | --- |
| planner | `deepseek-v4-pro-openai` | `deepseek-v4-flash-openai` |
| implementer | `deepseek-v4-flash-openai` | `deepseek-v4-flash-openai` ✅ |
| reviewer | `deepseek-v4-pro-openai` | `deepseek-v4-flash-openai` |

根因（代码位置已定位，本批次**不修**——计划 Global Constraints 规定阶段 3 前不动
`plugins/src/index.ts`）：守护派工取的是**全局默认模型**（`agentDefaultModel` 的当前选择），
`agent_models` 表里的按岗位模型只在聊天回帖路径上被读。

**为什么这条要单独写**：它不会报错、不会让任何用例变红，只会让「按岗位分配模型」
看起来已经做好了。`gf001-run.mjs` 已把它做成机器可判定的对拍（`modelDrift`），
本次实测输出 2 条偏差。这正是「配置写着 pro、实际跑着 flash」与「真的跑了 pro」
之间的区别——没有这项对拍，报告只会显示我们**希望**发生的事。

### 3.4 `human-intervention-rate`（受控路径）

受控路径每完成任务的将军介入为 **0.33 次**（3 个完成任务、1 次人工动作，且那 1 次是
中止轮次的取消，不是验收）。与生产空间 `software` 的 **1.2 次/完成任务** 相比，
说明 GF-001 确实做到了全链 `gate=0` 自动跑完（见 PRT-005 证据 §5）。

### 3.5 验收的机器重算

`gf001-run.mjs verify` 在结果仓库上**重新计算**验收项，不采信 agent 自述：

| 项 | 结果 |
| --- | --- |
| `filesChanged` | 8 个文件（5 新增 / 3 修改） |
| `testCommand` | `npm test`（真跑） |
| `testPassed` | `true` |
| `readmeUpdated` | `true` |
| `cli`（第五项，本次执行后补） | 4/4 通过 |
| **`accepted`** | **`true`** |

---

## 4. 仍待采集

以下两项**没有数值**，且本工具拒绝为它们编造数值。理由：阶段 3 会拿这些数字判断
新路径是否性能回退；一个编造的基线会让回退看起来正常，比没有基线更糟。

| 项 | 内容 | 阻塞原因 |
| --- | --- | --- |
| `estimated-cost` | 黄金任务费用估算 | token **已采集**；仍缺**有来源的单价**——自建网关 `custom-ds` 无公开报价，`PRICING.asOf` 仍是 `UNSET`。`estimateCost()` 在单价缺失时返回 `null` 而不是 `0` |
| `peak-resource` | 峰值内存与 CPU | DSH 会话转录**不记录**进程资源；需在执行期外部采样，且目标平台取决于 **PRT-011 分发形态裁决**（Task 4 待业主裁决） |

> 这两项的阻塞原因都已**不再是**「需要一次真实执行」——那个理由已经被用掉了。
> 清单长期挂着同一个理由，读的人会默认它没变，清单就成了噪音；
> 因此 `baseline-measure.test.mjs` 有一条用例专门断言这两条的原因里不再出现
> 「需要一次真实执行」。

采集命令：`node scripts/prt/baseline-measure.mjs --pending`（逐项列出结清状态、
实测值、证据文件或阻塞原因）。

### 4.1 一个必须成对满足的要求

`old-path-task-state-sequence` 是 §14.2 对拍的基准。它**已由实测修正**：
旧路径 76 个有轨迹的完成任务里，与最初人工写的字面序列相符的只有 4 个（5.3%），
42 个（55%）根本不经过 `in_review`。基准因此改为「模态序列 + 可接受集合」。
阶段 3 对拍时，**新旧两条路径都必须产出实测序列**；用预期序列冒充实测序列，
等于什么都没比。详见 [PRT-005 证据](../PRT-005-evidence/verify-evidence.md) §3。

---

## 5. 费用模型

单价表在 `baseline-measure.mjs` 的 `PRICING` 中，**是数据而不是代码**：单价随供应商
调整，必须独立于 Runtime Contract（spec §6.1 的 `usage.estimatedCostUsd` 由产品侧按
该表计算）。

`estimateCost()` 在单价缺失时返回 **`null` 而不是 `0`**：`0` 会让「未配置单价」
看起来像「免费」，进而让预算检查静默失效。该行为已由用例钉死。

当前 `asOf: UNSET`——**尚未填入任何真实报价**。GF-001 实测用到的两个模型
（`deepseek-v4-pro-openai` / `deepseek-v4-flash-openai`）已登记在表中、单价留空，
这样「缺哪个模型的价」本身可查，而不是连模型都找不到。填入时必须同时在本文档
注明来源与日期。

---

## 6. 验证

```bash
node --test scripts/prt/golden-flow.test.mjs
node --test scripts/prt/baseline-snapshot.test.mjs
node --test scripts/prt/baseline-measure.test.mjs      # 费用口径 + 待采集清单结清状态
node --test scripts/prt/dsh-session-usage.test.mjs     # 多帧 zstd 解码 + token 口径
node --test scripts/prt/gf001-run.test.mjs             # 独立验收 + 模型偏差对拍
node --test scripts/prt/old-path-evidence.test.mjs     # 状态序列 + 可用性空窗
node scripts/prt/baseline-snapshot.mjs --diff          # 应与基线一致
node scripts/ci/dsh-boundary.mjs --check               # 执行面记号未增长
node scripts/prt/baseline-measure.mjs --pending        # 结清状态一览

# 从零复现 §3 的实测数值（需要 DSH_HOME 下留有那次执行的会话转录）
node scripts/prt/gf001-run.mjs report \
  --out=docs/superpowers/prt/prt-009-gf001-execution.json
```

⚠️ **上面最后一条只在产出机上有意义**：它要读那次执行留下的会话转录
（`$DSH_HOME/sessions/…/session.v3.jsonl.zstd`）。换一台机器重跑，工具会如实报
0 个匹配会话，**不会**回落到旧数字——「读不到」与「读到了 0」是两回事。
已提交的证据 JSON 是当时的快照，因此 `--pending` 在任何机器上都能工作；
只有**重新生成**它才需要转录。

---

## 7. 已知未覆盖

- **费用与峰值资源仍未采集**（§4）——两者的阻塞原因不同，不要合并成一句「还缺数据」。
- **token 用量只有一个样本**（一次真实执行、三个岗位）。它足以证明「能采到、
  口径是什么」，不足以谈论分布；阶段 3 前应至少重复 2～3 次。
- **用量来自 DSH 会话转录，不是 team-hub 的数据**：旧路径的库里没有 token 列
  （§7），因此这份证据的采集链路是「DSH 转录 → 逐帧 zstd 解码 → 按 cwd 归属岗位」。
  它依赖 `$DSH_HOME/sessions/` 的磁盘留存策略——若转录被清理，历史就无法重算，
  只剩已提交的快照。**会话转录的保留期本身没有基线**，属于 PRT-011 的输入。
- **未采集磁盘占用**：数据库在多大规模下占用多少尚未测量，PRT-812 定期恢复演练
  时一并补。
- **未做多次采样**：就绪耗时是单次值，且同日多次采集已落在 229 / 240 / 361 ms
  （约 1.6 倍抖动）。不应拿其中任何一个数判断阶段 3 是否回退；
  应取 3 次中位数并记录离散度。
- **黄金流程只有一条**。第二条流程留到有真实需求时再加——黄金流程的价值在固定，
  不在数量。
- **旧路径的 token / 费用 / 资源永不补采**：全库 23 张表无任何 token/cost 列
  （`scripts/prt/schema-scan.mjs` 可复核）。§3 的数值全部来自**新路径**（DSH 会话转录），
  因此阶段 3 的「新旧对比」在成本维度上只能对比「新路径有数据、旧路径无数据」，
  不存在可比的旧路径基线。
