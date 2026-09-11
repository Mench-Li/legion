<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档是 **PRT 阶段 0～1**（2026-09-11）的采集结果：其中的任务数、耗时、人工介入与可用性空窗只代表当时 `team-hub/team.db` 里的状态，之后每一次真实执行都会让它们漂移。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· [docs/CONFIG.md](../CONFIG.md)（统一配置）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-005 旧路径执行状态证据

**切片**：PRT-005（旧路径执行状态保存）/ PRT-004 / PRT-009
**日期**：2026-09-11
**分支**：`codex/prt-phase0-1`
**数据源**：`team-hub/team.db` 的 `audit` / `tasks` 表（**只读**打开，不写入、不复制）
**提取器**：`scripts/prt/old-path-evidence.mjs`（`--scope` 决定总体）
**验证**：`node scripts/ci/run-ci.mjs --only env,boundary,deps,build,test,smoke,stage,doc` **八阶段全 PASS**；
`test` **52 套件 / 1401 用例**（证据 `.ci/prt-phase0-1-final/`）

---

## 1. 这个切片要回答什么

阶段 3 要把执行编排从 `plugins/src/index.ts` 抽到 Orchestrator。新路径必须证明与旧路径
**行为等价**（spec §14.2），而「等价」不能靠人肉比较两次运行。所以 PRT-005 要把**旧路径
真实发生过的样子**固定下来，作为对拍基准。它要回答四件事：

1. 任务在旧路径上**实际**经历的状态序列是什么（而不是我们以为是什么）；
2. 端到端耗时分布；
3. 人工介入的频次与形态；
4. 旧路径的**可用性边界**——它在什么条件下根本不工作。

前三条在最初的 PRT 计划里就写着。第 4 条是本次采集时才浮现的：**只知道它跑起来时什么样
是不够的。**

---

## 2. 结论摘要

| # | 结论 | 实测值 |
| --- | --- | --- |
| 1 | 预期的状态序列**被实测推翻** | 76 个完成任务中只有 4 个（5.3%）走过字面预期序列 |
| 2 | 模态形态是「claim → advance」，`in_review` 多数不出现 | 42/76（55%）不经过 `in_review` |
| 3 | **声明的状态机不是被强制执行的状态机** | `advanceTask` 绕过 `TRANSITIONS` 且不需要将军，见 §3.1 |
| 4 | 端到端耗时高度长尾 | n=76，min 537s / p50 4184s / p90 68497s |
| 5 | 人工介入是稳定成本 | 95 次 / 46 任务 / 每完成任务 1.2 次 |
| 6 | 旧路径**没有独立守护**：调度完全依附宿主进程 | 2026-09-11 两个独立空间同时断流 1.98h |

---

## 3. 实测一：状态序列（§14.2 对拍基准被修正）

**预期**（人工写的）：`todo → in_progress → in_review → done`

**实测**（software 空间 76 个有轨迹的已完成任务）：

| 指标 | 值 |
| --- | --- |
| 与字面预期序列逐项相符 | **4**（5.3%） |
| **不经过 `in_review`** | **42**（55%） |
| 模态形态 | `in_progress → advanced` |

**受控空间独立复现**：GF-001 黄金流程的 3 个完成任务（T-144 / T-145 / T-146）**全部**
是 `in_progress → advanced`，0 次 `in_review`。这不是历史数据的统计巧合，
一次受控执行就重现了同一形态。

### 3.1 根因：声明的状态机**不是**被强制执行的状态机

`advance` 动作本身**不写 `to` 值**，所以「推进到 done」在审计里表现为 `advanced`
而不是 `done`。这只解释了**记录形态**。真正让 `in_review` 消失的是下面这件事：

`team-hub/server.mjs` 里有**两条**写 `status='done'` 的路径，只有一条查迁移表：

| 路径 | 位置 | 是否查 `TRANSITIONS` | 是否要求 `by === 'general'` |
| --- | --- | --- | --- |
| `transitionTask` | `:2682` | ✅ 是 | ✅ 是（`:2690-2693`） |
| `advanceTask` | `:2705` | ❌ **否** | ❌ **否** |

`advanceTask` 只要求操作者是该岗位本人（`expected !== null && expected !== by`），
然后把 `in_progress` / `in_review` 直接写成 `done`：

```js
// team-hub/server.mjs:2709-2712
if (t.status !== 'in_progress' && t.status !== 'in_review') throw new Error(...)
const expected = t.role ?? t.soldier
if (expected !== null && expected !== by) throw new Error(`只有 ${expected} 可推进任务 ${id}`)
db.prepare("UPDATE tasks SET status='done', version=version+1, updatedAt=? WHERE id=?").run(now(), id)
```

**后果有三层**：

1. `prt-007-baseline.json` 记录的 **20 条迁移边只覆盖 `transitionTask`**，
   `advanceTask` 的旁路不在基线里 → 基线不完备（多出一条真实存在的边 `in_progress → done`）。
2. 「只有将军（`by === 'general'`）能在用户接受后把任务移到 `done`」这条规则
   **可以被岗位自己绕过**——这正是 42/76 个任务不出现 `in_review` 的直接原因。
3. 新路径若只实现 `TRANSITIONS`，就会**少一条旧路径真实走过的边**，
   对拍时被判成不等价；但把它当「想要的语义」照抄也不对——它更像一处待裁决的旧债。

**处理方式**：不在本批次修改 `plugins/src/index.ts` / `team-hub/server.mjs`
（计划 Global Constraints 规定阶段 3 前不动这两个文件）。已把它显式登记为
`GOLDEN_TASK.transitionBypass`，并由用例守住：

- `golden-flow.test.mjs`「每条可接受序列要么走得通迁移表，要么是已记录的旁路」；
- `golden-flow.test.mjs`「`advanceTask` 确实绕过迁移表」——**如果哪天有人让
  `advanceTask` 也查迁移表，这条用例立刻变红**，提醒可接受序列集合必须重新对拍，
  而不是等着阶段 3 静默判错。

**待裁决项**（登记给 PRT-316 / 阶段 3）：`advanceTask` 的旁路应当
(a) 补进 `TRANSITIONS` 并保留，还是 (b) 收窄为必须经 `in_review` + 将军收尾。
两个方向对 §14.2 的对拍基准影响相反，必须先定。**

### 3.2 基准的修正落点

`scripts/prt/golden-flow.mjs`：对拍基准从「逐字相等」改为

- `modalTaskStateSequence = ['in_progress', 'advanced']`（多数路径）
- `acceptedTaskStateSequences`（旧路径实际出现过的形态集合）
- `transitionBypass`（旁路的显式登记）

**为什么这条最重要**：若继续拿那个字面序列当基准，阶段 3 会把一条**与旧路径等价**的新路径
判成「不等价」——因为旧路径自己都不走那条路。基准错了，对拍就成了反向门禁。

---

## 4. 实测二：端到端耗时

| 总体 | n | min | p50 | p90 | max | mean |
| --- | --- | --- | --- | --- | --- | --- |
| `software`（生产，全部已完成） | 76 | 537.4s | 4184.3s | 68497.3s | 83217.7s | 21324.0s |
| `gf001`（受控，GF-001） | 3 | 54.2s | 104.0s | 220.1s | 220.1s | 126.1s |

**口径（重要）**：用的是**审计写入时间**，即「动作被记录的时刻」，不等于「工作真正发生的
时刻」。守护是轮询的，因此每次交接天然带最多一个轮询周期的量化误差。它还包含等待人工与
等待下一轮的时间——这是**端到端**耗时，不是模型推理耗时（后者旧路径根本没有记录，
这正是 §6.11 的缺口）。

**两者差两个数量级，原因不是 gf001 更快，而是总体不同**：`software` 混入了大量等待人工
验收与等待下一轮的时段，而 gf001 全链 `gate=0`、目标链自动推进、无人工闸门。
**这两个数不能互相冒充**：做性能回退判断只能用同一总体与同一口径。

---

## 5. 实测三：人工介入

判据：`audit.member ∈ {general}`——Legion 里「将军」就是人类指挥官，其余 member 要么是
守护（`soldier-auto` / `mediator-auto`），要么是岗位角色（`planner`/`implementer`/…）。

| 总体 | 次数 | 涉及任务 | 每完成任务 | 有介入的任务占比 |
| --- | --- | --- | --- | --- |
| `software` | **95** | 46 | **1.2** | 46/79 = 58% |
| `gf001` | 1 | 1 | 0.33 | 1/3 = 33% |

`gf001` 的那 1 次是**目标取消**（中止那两轮执行时将军点的取消），不是验收动作——
说明受控路径确实做到了「一次执行全自动跑完」。

判据一旦写错（例如把守护也算成人工），这个比率会变成「所有动作数」或恒为 0。
用例 `countHumanInterventions` 已把它钉死。

---

## 6. 实测四：可用性 —— 旧路径没有独立守护

**心跳判据**：守护每轮扫描都会写一条 `release-stale`，**即使什么都没释放**
（实测 detail 恒为 `{"released":[]}`）。正因为它无条件写，才能当心跳用。

| 总体 | 心跳中位间隔 | ≥5min 空窗数 | 分桶（5-30m / 30-60m / 1-2h / ≥2h） | 最长 |
| --- | --- | --- | --- | --- |
| `software` | 30.0s | **87** | 53 / 14 / 6 / 14 | **17.34h** |
| `gf001` | 15.0s | 1 | 0 / 0 / 1 / 0 | 1.98h |

### 6.1 那一段 1.98h 的停机是**宿主级**的

| 空间 | 断流区间 | 时长 |
| --- | --- | --- |
| `software` | `10:32:09.919Z` → `12:30:54.819Z` | 1h58m45s |
| `gf001` | `10:32:18.260Z` → `12:30:48.768Z` | 1h58m31s |

**两个独立空间的心跳几乎同时停止、同时恢复**，间隔相差 9 秒。这排除了「某个空间的守护
自己有 bug」——是宿主进程不在。`.legion-services.log` 在 `12:30:18.582Z` 有一条重新挂载
记录，落在同一分钟，与恢复时刻吻合。

### 6.2 为什么空窗要分桶

最长的几段（14–17h）基本是**跨夜关机**（总共 14 段 ≥2h，几乎都在夜间），
而「白天掉线两小时」才是需要归因的故障信号。只报「最长空窗 17.34h」会把两者混为一谈，
读的人会以为系统天天崩 17 小时。所以输出同时给**分桶**与**最近 5 段**。

### 6.3 结论

旧路径的可用性**完全等于宿主进程的存活时间**：宿主不在时，调度与审计同时消失，
**且没有任何外部可见的告警**——没有任何东西会告诉将军「旧路径已经停了」。
这是 spec §12 恢复语义与 PRT-8xx 健康检查的真实输入。

> **一处被纠正的旧笔记**：代码里曾写着「software 空间守护死锁 3 小时」。
> 那是一个**没有量过的印象**：实测是 1.98 小时，且归因是宿主停机而非内部死锁。
> 记在这里是因为——「大概是……吧」的结论会一路传下去，直到有人真的去量。
> 完整历史注释见 `scripts/prt/old-path-evidence.mjs` 顶部。

---

## 7. 两个总体不能混用一个名字

`audit.scope` 记的是**动作发起者当时的空间视图**，不是任务所属空间。

| 总体 | 定义 | `software` | `gf001` |
| --- | --- | --- | --- |
| 空间视角 | `audit.scope = 本空间` | 7593 行 | 309 行 |
| 任务视角 | 能 JOIN 到本空间任务的行 | 1645 行 | 43 行 |

两者双向不同，差异都是真实存在的：

- 守护每轮的 `release-stale`（`taskId='*'`）→ 在空间视角里，不在任务视角里；
- 将军从 `default` 视图推进 `software` 任务 → 在任务视角里，不在空间视角里。

实测 `software` 有 **170 行** scope 不一致（`default` 77 / `slice-verify` 93）。
**若按 `audit.scope` 过滤审计行**，这些行会被丢掉：状态序列被截断、端到端耗时少算最后一段
（实证 T-049 会从「到 done」缩成「到 in_review」）。这类错误不抛异常、**只给出偏小的数**，
是最难发现的一种，已由用例守着。

---

## 8. 证据文件与复现

| 文件 | 内容 |
| --- | --- |
| `docs/superpowers/prt/prt-009-execution-evidence.json` | `software` 空间：状态序列、耗时、人工、产物、可用性 |
| `docs/superpowers/prt/prt-009-gf001-controlled-evidence.json` | 受控空间 `gf001` 的同一组指标（**旧路径**，含两次中止轮次） |
| `docs/superpowers/prt/prt-009-gf001-execution.json` | 跑通那一轮的验收重算 + token 用量 + 模型偏差 |

```bash
# 汇总（人读）
node scripts/prt/old-path-evidence.mjs --scope=software
node scripts/prt/old-path-evidence.mjs --scope=gf001 --tasks

# 重新生成证据文件（只读源库）
node scripts/prt/old-path-evidence.mjs --scope=software --write-baseline \
  --note="生产空间 software 的旧路径执行证据"
node scripts/prt/old-path-evidence.mjs --scope=gf001 \
  --out=docs/superpowers/prt/prt-009-gf001-controlled-evidence.json --write-baseline

# 库表里到底有没有 token / 费用 / 资源列（供复核「记不到」的结论）
node scripts/prt/schema-scan.mjs

# 单测
node --test scripts/prt/old-path-evidence.test.mjs
```

---

## 9. 已知未覆盖

- **旧路径不记录 token / 费用 / 资源**：全库 23 张表无任何 token/cost 列；唯一耗时列是
  `web_fetch_history.ms`（315 行，仅网页抓取）。这三项因此**只能来自新路径的真实执行**，
  已在 `prt-009-gf001-execution.json` 落地 token 与耗时两项；费用与资源仍未采集（见 PRT-009 证据）。
- **可用性空窗只覆盖「心跳在写」的时段**：心跳没在写时无法区分「进程死了」与「机器没开」。
  归因需要 `.legion-services.log` 佐证，本工具不自动读它（那会让提取器依赖一个滚动的日志文件）。
- **`gf001` 的耗时样本只有 3 个**：受控路径目前只跑通一次端到端。要谈分布至少需要重复执行；
  在拿到更多样本前，`gf001` 的 p90 等于 max，不代表分位数。
- **`slice-verify` 空间未采集**：它是第三类总体（切片验收），与生产/受控都不同，
  本次未纳入范围。
- **`advanceTask` 旁路未裁决**（§3.1）：本批次只把它登记为事实与待裁决项，
  未修改 `team-hub/server.mjs`。在裁决之前，§14.2 的对拍基准按
  「模态序列 + 可接受集合 + 已登记旁路」执行。
- **`prt-007-baseline.json` 的迁移表基线不完备**（§3.1 后果 1）：它提取的是
  `TRANSITIONS` 字面量，因此**看不到** `advanceTask` 的旁路边。该文件本次未改——
  补全它需要先决定「旁路是保留还是收窄」，否则会把一处待裁决的旧债固化成契约。
