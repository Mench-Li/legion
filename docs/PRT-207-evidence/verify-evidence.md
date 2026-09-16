<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-207 证据：采集模型 / token / 费用估算 / 耗时

任务：`PRT-207`——采集模型、token、费用估算和耗时。

本文件只记**本批（2026-09-15）**动过的那一截：费用估算从「没有价」迁到
「有来源的价目表」。采集本身（模型/token/耗时）的证据在 PRT-009 侧与
`docs/superpowers/prt/prt-009-gf001-execution.json`，不在这里重复。

## 1. 迁移前的状态（原文照录）

`runtime/adapters/dsh/usage.mjs` 的默认价目表是：

```js
export const PRICING = Object.freeze({
  asOf: 'UNSET',
  currency: 'USD',
  models: Object.freeze({}),
})
```

`estimateCostUsd()` 在 `pricing.asOf === 'UNSET'` 时返回 `null`。这不是占位符，
是当时的正确行为：没有任何可核对的单价时，`null`（不知道）必须与 `0`（这次免费）
分开——`0` 会让预算闸门（`checkBudget` 的 `maxCostUsd` 分支）静默失效。

所以 PRT-207 此前是 🟡：**采集已实现，费用估算因单价缺失返回 `null`**。

## 2. 迁移后

| 项 | 之前 | 之后 |
| --- | --- | --- |
| `PRICING` | `{ asOf: 'UNSET', currency: 'USD', models: {} }` | `DEEPSEEK_PRICE_TABLE`（`runtime/contracts/price-table.mjs`） |
| 价源 | 无 | 来源 URL / 检索日期 / 模型版本 / peak 规则（页面上手工录入的常量） |
| `estimateCostUsd({model:'deepseek-flash', tokensIn:1e6, tokensOut:0})` | `null` | `0.3`（peak + cache miss，默认上界） |
| 表里没有的模型（`v4`、`m`、`glm-*`） | `null` | **仍是 `null`**（`MODEL_NOT_PRICED`），绝不 `0` |
| 老形状 `{asOf, models:{m:{inPerMTok,outPerMTok}}}` | 唯一形状 | 兼容入口，折进契约价目表；折不动即 `null` |
| 算术实现 | 本模块自己乘一遍 | **只有一处**：契约的 `estimateCost` |

`collectUsage()` 签名不变；`checkBudget()` 的判据不变（`estimatedCostUsd === null`
→ `cost-unknown`，不得视为未超）。

## 3. 为什么默认取上界（peak + cache miss）

真实价格按 UTC 墙钟分 peak / off-peak（**2 倍**），输入侧分 cache hit / miss
（最高 **50 倍**）。运行时估算拿不到这两个读数，所以：

- 取**更贵**的那一支 = 上界。预算闸门**少算** → 用户静默超支（不可见）；
  **多算** → 提前拒绝（可见）。
- 便宜的取值必须由调用方**显式**给出：`atMs`（知道时段）、
  `tokensInCacheHit`（知道缓存命中数）。
- `collectUsage()` 目前**不**抽取缓存字段，所以运行时估算一律按 cache miss
  ——这正是"看不见缓存时取更贵那一支"的落地，不是遗漏。

该默认由 `price-table.test.mjs` 的「★ 保守默认」一组用例钉死：谁把它换成便宜
那一支，用例立刻红。

## 4. 验证

```bash
node --test runtime/contracts/price-table.test.mjs runtime/adapters/dsh/adapter.test.mjs
```

`runtime/adapters/dsh/adapter.test.mjs`：

- 「③ 模型不在记录价目表内时 `estimatedCostUsd` 为 `null`，不是 0」——
  断言默认表是 `deepseek-2026-09-15`、`retrievedAt === '2026-09-15'`，
  且 `deepseek-flash` 在同一条路径上**真的算出数**（`1e6` 输入 → `0.3`）。
- 「⑩ 价格表未生效或模型无价 → 费用为 `null`」——保留，并继续覆盖老形状兼容入口。

## 5. 残留（未证明 / 已知缺口）

1. **页面会变**。表是 2026-09-15 手工录入的常量；`version` / `retrievedAt`
   冻结进估算结果，但没有"过期自动告警"——过期只能靠人看 `retrievedAt`。
2. **peak 规则只在 UTC**。没有任何本地时间转换；声明非 UTC 的规则会被
   `createPriceTable` 拒绝（而不是静默按本地时间判错）。
3. **网关 id 是推导别名**。GF-001 实际用的 `deepseek-v4-flash-openai` /
   `deepseek-v4-pro-openai` 页面没有命名，表里标着 `sourceKind: 'derived'`。
   这是唯一的推断，见 `docs/PRT-009-evidence/verify-evidence.md` §5.3。
4. **没有一笔真实账单核对过估算**。"上界"是一个方向性论证，
   不是一个已对账的事实。
5. **价目表登记处（team-hub）只存 `models`**：整表发布再取回会丢
   `timeOfDay` / `sourceUrl` / `retrievedAt` 这些**表级**字段。
   估算默认仍取 peak（保守），但"按时间戳派生时段"这条路在取回的表上不可用。
   修它要动 `team-hub/budget-ledger.mjs`，不在本批范围内。
