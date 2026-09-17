// 临时探针（未跟踪）：用 team-hub 认领响应的**真实字段集**喂生产路径的 defaultRequestFor。
// 目的只有一个：把"生产里 workspaceId / modelProfileRef / workdir 有没有来源"这件事量出来，
// 而不是靠读代码断言。
import { defaultRequestFor } from '../orchestrator/worker/executor.mjs'

// 字段集逐字来自 team-hub/run-store.mjs 的 shapeAttempt()（认领响应的唯一形状）。
const claimFromHub = {
  attemptId: 'att:T-1:1',
  taskId: 'T-1',
  scope: 'software',
  attemptNo: 1,
  state: 'Leased',
  workerId: 'w1',
  leaseEpoch: 1,
  leaseExpiresAtMs: Date.now() + 60_000,
  idempotencyKey: 'idem:T-1',
  nextAttemptAtMs: null,
  externalEffect: null,
  returnTo: null,
  outcome: null,
  failureCode: null,
  detail: null,
  resolvedBy: null,
  resolvedNote: null,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  finishedAtMs: null,
}

const snapshot = { finalText: '（冻结正文）', associations: {} }

// 生产里 `context-stage.mjs:376` 会把这四个关联连同冻结快照一起发出去，
// 所以 goalId / taskId / employeeId / teamPlanId 走的是 associations 回落。
const snapshotFromStage = {
  finalText: '（冻结正文）',
  associations: { goalId: 'G-1', taskId: 'T-1', employeeId: 'emp:T-1/coder', teamPlanId: 'tp:1' },
}

for (const [label, lease, snap] of [
  ['hub claim 原样 + 空 associations', claimFromHub, snapshot],
  ['hub claim 原样 + 生产快照 associations', claimFromHub, snapshotFromStage],
]) {
  try {
    const req = defaultRequestFor(lease, snap)
    console.log(`[${label}] 通过  keys=${Object.keys(req).join(',')}`)
  } catch (e) {
    console.log(`[${label}] 拒绝  code=${e.code ?? e.name}  missing=${JSON.stringify(e.missing ?? null)}`)
    console.log(`           message=${e.message}`)
  }
}
