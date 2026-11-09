# F1 · 真实守护四态演练（live drill evidence）

- 时间：2026-11-09 14:57–15:07（Asia/Shanghai）
- 环境：**隔离**（临时库 + 临时 git 仓库 + 临时 hub）；守护通过 profile 的**热加载 bundle** 接入，
  只服务隔离空间 `drill`，未触碰生产空间与真实仓库。
- 任务：`T-001`（`role=coder`），正文要求 worker **不要改代码**、直接上报 `status=dropped`。

## 判定结果

| 断言 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| 落定状态 | `canceled`（无需处理） | `canceled` | ✅ |
| 报告评论 | 0 条（不打扰人） | 0 条（另有 1 条 🟢 派工播报，不算报告） | ✅ |
| 活动痕迹 | 有 `drop` | `{"kind":"drop","text":"无需处理（dropped）：演练：超出范围"}` | ✅ |

## 时间线（同一秒内落定）

```
06:57:26.148  audit claim         {"soldier":"coder"}
06:57:26.156  activity claim      编码（coder）认领开工
07:07:00.040  activity drop       无需处理（dropped）：演练：超出范围     ← 真 dropped 路径
07:07:00.047  audit transition    {"to":"canceled"}（actor=bot，7ms 后）
```

关键点：`drop` 文案里带着 agent 自己写的 summary（"演练：超出范围"），
所以这**不是**超时结算——超时不会知道 summary，且 `claim + workerTimeout = 07:07:26` 比落定晚 26 秒。

## 两处判据口径修正（演练自己抓出来的）

1. `activity()` 写的是**本地 JSONL**（`scrumDir/activity.jsonl`），**不是** hub 的 `audit` 表
   ⇒ 断言 `audit.action === 'drop'` 永远为假。
   证据：本次 `releaseStaleRows=149` 而 `dropRowsInHub=0`。
2. "评论条数"必须排除**派工播报**（🟢 已派 AI worker…）：那是开工通知，不是打扰。
   已改为只统计含"无需处理/canceled"的报告评论。

## 顺带发现（待判断是否开单）

- **`release-stale` 审计刷屏**：10 分钟内写入 **149 行** `release-stale` 审计，
  内容几乎全是 `{"released":[],"quarantined":[]}`（什么都没释放）。
  守护每跳一次就写一行，纯噪音；真实部署里会持续膨胀 `audit` 表。
  建议：`releaseStaleTasks` 在 `released` 与 `quarantined` 都为空时**不写审计**。
- **岗位无模型绑定**：活动流记 `岗位 drill/coder 没有模型绑定 → 这次用了平台默认模型`。
  隔离演练下无妨（正好验证回落可用），但说明"按岗位选模型"未覆盖该岗位。
