<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **PRT 阶段 0～1 基线冻结时**（2026-09-11）的采集结果，其中的文件规模、路由数、就绪耗时与结论只代表当时状态；且 `pending` 段的数值当时**尚未采集**（需一次真实模型执行）。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· [docs/CONFIG.md](../CONFIG.md)（统一配置）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-009 成本 / 延迟 / 资源基线证据

**切片**：PRT-004 / PRT-007 / PRT-009（黄金流程定义 + 旧系统平台契约基线 + 成本延迟基线）
**日期**：2026-09-11
**分支**：`codex/prt-phase0-1`
**采集机器**：`win32/x64`，Node `v24.19.0`
**验证**：`run-ci --only env,boundary,deps,build,test,doc` **六阶段全 PASS**（`test` 43 套件 / 1161 用例）

---

## 1. 本次交付

| 产物 | 说明 |
| --- | --- |
| `scripts/prt/golden-flow.mjs` | 黄金流程与固定夹具定义（纯模块，无 I/O） |
| `scripts/prt/baseline-snapshot.mjs` | 旧系统平台契约基线提取器（HTTP / 表 / 状态机） |
| `scripts/prt/baseline-measure.mjs` | 成本 / 延迟 / 资源基线采集器 |
| `docs/superpowers/prt/prt-007-baseline.json` | 平台契约基线（85 路由 / 22 表 / 7 状态 / 20 迁移边） |
| `docs/superpowers/prt/PRT-004-golden-flow.md` | 黄金流程定义（GF-001） |
| `docs/superpowers/prt/PRT-009-baseline.md` | 自动生成的基线报告 |

---

## 2. 已测量（可重复采集）

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
| `runtime/contracts/` | 9 文件 / 103,541 字节 |
| `scripts/ci/dsh-boundary.mjs` | 17,258 字节 / 446 行 |

这两个大文件的规模正是 spec §2.1 判定的**真实迁移成本所在**：DSH 的 API 级耦合很薄
（`dsh-boundary` 实测全仓库仅 26 处执行面记号），成本集中在这两个单文件模块。

### 2.3 进程就绪基线

| 项 | 值 |
| --- | --- |
| team-hub 首次就绪 | **240 ms** |

**就绪判据是端口可连接**，不是「进程未退出」。进程活着但 HTTP 未监听是最常见的
假就绪，用它当判据会得到一个漂亮但无意义的数字。

采集在临时数据目录中进行，不触碰真实库；失败时返回 `{ok:false, reason}` 而不抛错——
基线采集不应因本机环境差异让整个工具失败。

---

## 3. 待采集（需一次真实模型执行）

以下各项**没有数值**，且本工具拒绝为它们编造数值。理由：阶段 3 会拿这些数字判断
新路径是否性能回退；一个编造的基线会让回退看起来正常，比没有基线更糟。

| 项 | 内容 | 阻塞原因 |
| --- | --- | --- |
| `token-usage` | 黄金任务 token 用量（input / output） | 需要模型凭证 |
| `estimated-cost` | 黄金任务费用估算 | 依赖 `token-usage`；且单价表 `asOf` 仍为 `UNSET` |
| `end-to-end-latency` | 计划→实现→评审全流程墙钟耗时 | 需要一次真实多岗位执行 |
| `peak-resource` | 峰值内存与 CPU | 跨平台子进程采样不可靠，需按 PRT-011 选定的分发形态在目标平台采集 |
| `old-path-task-state-sequence` | 旧路径**实测**任务状态序列 | 需要一次真实执行（当前只有预期序列） |
| `human-intervention-rate` | 人工介入次数与原因分布 | 单次运行不足以给出比率，需要执行样本 |

采集命令：`node scripts/prt/baseline-measure.mjs --pending`（逐项列出内容、采集方式与阻塞原因）。

### 3.1 一个必须成对满足的要求

`old-path-task-state-sequence` 是 §14.2 对拍的基准。阶段 3 对拍时，**新旧两条路径
都必须产出实测序列**；用预期序列冒充实测序列，等于什么都没比。

---

## 4. 费用模型

单价表在 `baseline-measure.mjs` 的 `PRICING` 中，**是数据而不是代码**：单价随供应商
调整，必须独立于 Runtime Contract（spec §6.1 的 `usage.estimatedCostUsd` 由产品侧按
该表计算）。

`estimateCost()` 在单价缺失时返回 **`null` 而不是 `0`**：`0` 会让「未配置单价」
看起来像「免费」，进而让预算检查静默失效。

当前 `asOf: UNSET`——**尚未填入任何真实报价**。填入时必须同时在本文档注明来源与日期。

---

## 5. 验证

```bash
node --test scripts/prt/golden-flow.test.mjs
node --test scripts/prt/baseline-snapshot.test.mjs
node scripts/prt/baseline-snapshot.mjs --diff     # 应与基线一致
node scripts/ci/dsh-boundary.mjs --check          # runtime/contracts/ 对 DSH 依赖为零
```

---

## 6. 已知未覆盖

- **未采集任何真实模型执行数据**（§3 全部条目）。
- **未采集磁盘占用**：数据库在多大规模下占用多少尚未测量，PRT-812 定期恢复演练
  时一并补。
- **未做多次采样**：就绪耗时是单次值。冷启动方差可能很大，阶段 3 前应取 3 次中位数。
- **黄金流程只有一条**。第二条流程留到有真实需求时再加——黄金流程的价值在固定，
  不在数量。
