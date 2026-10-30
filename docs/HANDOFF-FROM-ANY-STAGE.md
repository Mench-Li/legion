# 从任意一环接手继续（handoff-from-any-stage）

> 状态：设计稿（分支 `feat/handoff-from-any-stage`）。2026-10-30。

## 问题

目标链上**任意一环**都可能出现"活其实已经干完了，但流程接不上"：

- 编码早就交付并验收了（`w/T-224` @ `717607bf`，19 文件、测试全绿），可审查环认领不了；
- 某一环中断（超时/取消/重启），已经产出的东西没法作为下一环的起点；
- 唯一能走通的路是**整链重来**：需求 → 选型 → 拆解 → 用例 → 编码，≈3 小时，而代码一行都不会变。

> 一个"只能从头再来"的流水线，
> 与一个"每完成一环就作废"的流水线，在**第一次中断**之后是同一个东西。

## 现有基础（今天已落地的部分）

`adopt`（提交 `fb1485e3` / `11aaeb67` / `a2c55961` / `9337bf42` 系列）解决了前一半：

- 发布目标时 `adoptFrom=<已验收任务>` → hub 解析该任务的冻结提交（`agent-workflow-stage-checkpoint` 里的 `sourceCommit`），把 `{commit, 分支, 文档目录}` 钉进新链**每个任务**的冻结快照；
- 守护建工作区时以该提交为基线（`prepareWorktree({ baseRef })`），提示词里明说"接手，别从 main 重写"；
- `startAt: "implement"` → 接手设计环（继承 `path+digest` 引用并收口为 done）、跳过中间流水线环节，只从实现环往后跑。

但它**还差最后一环**：实现环节仍然按正常编码派工，会启动一个 agent 干一遍活——这等于换个说法重做。实测 `G-mvuepn3e-1` 的 T-240 正是这样（已被叫停）。

## 缺口（本分支要补的）

1. **结算不派 agent**：接手的实现环应当只做"独立验证 + 写回执"，不启动任何编码 agent。
2. **任意环可作为入口**：`startAt` 目前只支持 `implement`；review / tester / devops 作为入口时，需要各自的"上游证据继承"规则。
3. **中断后续跑**：任一环中断后，用已落盘的工作区/提交重新结算，而不是重新派工。

## 方案

### ① `snapshot.adopt.settle = "verify-only"`

发布时（`publishGoalRecord` 的 adopt 分支）给实现任务打上 `settle: "verify-only"`。

### ② 守护的 settle-only 分支

`runWorker` 认领时，若 `isWorkflowStage(t, stage, 'implementation') && adopt.settle === 'verify-only'`：

```
准备 worktree（baseRef = adopt.commit，已有）
  → POST stage-attempts/start           （attempt 事实先落库，与正常派工同一条规矩）
  → runWorkflowTestCommand(stage.testRunner, cwd = worktree)
  → POST stage-attempts/<id>/report     （testReport + testVerification = 真跑出来的回执）
  → POST comment  evidence=agent-workflow-implementation:{passed, sourceCommit, stageAttemptId, providerRunId, testVerification, …}
  → transition → done                   （交给 advancePipeline 建/认领审查环）
```

失败路径：runner `state !== 'passed'` → **不**置 done，写清失败原因（`failed` / `unknown` 分开）并停在 `in_review` 或 `blocked`，绝不静默。

### ③ 诚实边界（必须写进证据）

- `provider_run_id` 记为 `verify-only:<sha前12>`，并在证据正文里标注「**未派 agent**，回执由独立 runner 产出」；
- `provider_name` 仍取冻结工具的 providerName——hub 的交接校验比对的是它（`server.mjs` 的 `frozenImplementationTool.providerName`），改不了也不该改；
- 这不是伪造：跑的是**真命令**、产出的是**真回执**，只是没有 agent 参与。伪造的判定标准是"没跑却声称跑过"，这里不存在。

## 验收

1. 用 `T-224 @ 717607bf` 实测：链上实现环 **< 2 分钟** done、**无 agent run**、审查环可正常认领；
2. 单测覆盖 settle-only 分支：通过 → done；runner 失败 → in_review 且评论含退出码；runner 超时 → unknown 且不置 done；
3. 回归：普通（非 adopt）任务的派工路径逐字不变。

## 风险

- hub 对 `provider_name` / `provider_run_id` 的校验假设较硬，需按实际字段对齐；
- 摘要与行尾：继承的 `digest` 必须与检出后的文件一致（否则审查环 `fileDigest` 比对失败）；
- 失败路径若不写证据，会变成"静默停在 in_review"——本轮已踩过两次同类坑。
