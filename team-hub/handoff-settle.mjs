// team-hub/handoff-settle.mjs
// ============================================================================
// 从任意一环接手（handoff）—— **结算判据** 的纯函数层
//
// 背景（2026-10-30）：`w/T-224` 的实现在 `717607bf` 上早已交付并通过测试，但审查环
// 认领不了它：hub 的交接校验要求"实现环有一份 `state === 'passed'` 的独立测试回执
// + 与之一致的实现证据"。于是唯一能走通的路是整链重来（≈3 小时，代码一行不变），
// 或者派一个编码 agent 把已经写好的东西再"实现"一遍（实测就这么发生了，被叫停）。
//
// 这个模块只做一件事：**把"接手一环"的判定收敛成可单测的纯函数**——
//   · 什么样的回执才算这一环"可以交出去"；
//   · 结算记录该长什么样（attempt 行、实现证据、检查点）；
//   · 不通过时必须给出**可读的原因**，而不是静默停在 in_review。
//
// 为什么强调"纯函数"：结算这条路上一次踩过的坑全都在**判定**上（回执 unknown 被当成
// 通过、provider 字段对不上导致审查环 409、摘要行尾不一致），而这些都能在没有数据库、
// 没有 worktree 的情况下断言。真正跑命令那一层（runner）另有测试。
// ============================================================================

/** 接手结算的结果码：只有 `passed` 才允许把实现环置 done。 */
export const SETTLE_STATES = Object.freeze(['passed', 'failed', 'unknown'])

/**
 * 判定一次独立验证的结果是否能作为"实现环已交付"。
 *
 * @param {object|null} receipt runner 回执（`{state, exitCode, executable, args, timeoutMs}`）
 * @returns {{ok: boolean, state: string, reason: string}}
 */
export function decideSettlement(receipt) {
  if (receipt === null || typeof receipt !== 'object') {
    return { ok: false, state: 'unknown', reason: '没有拿到独立验证回执' }
  }
  const state = typeof receipt.state === 'string' ? receipt.state : 'unknown'
  if (!SETTLE_STATES.includes(state)) {
    return { ok: false, state: 'unknown', reason: `回执状态不可识别：${state}` }
  }
  if (state === 'passed') {
    // `passed` 必须真的带着 exitCode 0：只信状态字段是最容易被"空回执"骗过的地方。
    if (receipt.exitCode !== 0) {
      return { ok: false, state: 'failed', reason: `回执声称通过但退出码是 ${String(receipt.exitCode)}` }
    }
    return { ok: true, state: 'passed', reason: '独立验证通过' }
  }
  if (state === 'failed') {
    return { ok: false, state: 'failed', reason: `独立验证未通过（退出码 ${String(receipt.exitCode)}）` }
  }
  // unknown = 跑了但没跑出结论（超时/被中断）。**不能**当通过，也不能当失败：
  // 两者的下一步不同（前者要人看现场，后者要改代码）。
  return {
    ok: false,
    state: 'unknown',
    reason: `独立验证没有跑出结论（超时 ${Math.round((receipt.timeoutMs ?? 0) / 1000)} 秒或进程被中断），请人工核对现场后重试`,
  }
}

/** runner 的冻结配置必须与回执逐字一致 —— hub 的交接校验就是这么比的。 */
export function runnerMatchesReceipt(testRunner, receipt) {
  if (testRunner === null || testRunner === undefined || receipt === null || receipt === undefined) return false
  return testRunner.executable === receipt.executable
    && testRunner.timeoutMs === receipt.timeoutMs
    && JSON.stringify(testRunner.args) === JSON.stringify(receipt.args)
}

/**
 * 造一份"接手结算"的 stage attempt 记录。
 *
 * `providerName` 取**冻结工具的 providerName**（hub 的交接校验比对的就是它）；
 * `provider_run_id` 用 `verify-only:<sha>` 明确标注"没有 agent 参与"——
 * 这不是伪造：命令真跑了、回执是真结果，标注的是"谁没参与"。
 */
export function buildSettleAttempt({ attemptId, stageId, providerName, receipt, sourceCommit, summary, evidence, startedAtMs, finishedAtMs }) {
  const shortSha = String(sourceCommit ?? '').slice(0, 12)
  // idempotency_key 在 (scope, idempotency_key) 上唯一：同一提交重试时必须换 key，
  // 否则第二次结算会被 UNIQUE 约束挡在写回执之前（现场：同样的 717607bf 重试）。
  const discriminator = String(attemptId ?? '').slice(-8)
  return {
    id: attemptId,
    stageId,
    providerName,
    providerRunId: `verify-only:${shortSha}:${discriminator}`,
    state: 'completed',
    result: {
      summary,
      evidence,
      // 与正常派工同形状：结算代码读的就是这两个字段。
      testReport: {
        passed: receipt?.state === 'passed',
        command: [receipt?.executable, ...(receipt?.args ?? [])].filter(Boolean).join(' '),
        summary: summary ?? '',
        evidence: evidence ?? '',
        failures: receipt?.state === 'passed' ? [] : [receipt?.error ?? '未通过'],
      },
      testVerification: receipt,
    },
    startedAtMs,
    finishedAtMs,
  }
}

/**
 * 造实现环的证据文本（`agent-workflow-implementation:` 前缀是 hub 的识别依据）。
 * 正文里写清"未派 agent"，免得后来人把它读成一次正常编码交付。
 */
export function buildImplementationEvidence({ passed, sourceCommit, stageAttemptId, providerRunId, receipt, testCommand, testSummary, testEvidence }) {
  return `agent-workflow-implementation:${JSON.stringify({
    passed,
    sourceCommit,
    stageAttemptId,
    providerRunId,
    testVerification: receipt,
    testCommand: testCommand ?? '',
    testSummary: testSummary ?? '',
    testEvidence: testEvidence ?? '',
    settledBy: 'handoff-settle（未派 agent：接手既有提交，仅跑独立验证）',
  })}`
}

/** 接手实现的冻结检查点：审查环靠它拿到 `sourceCommit` 作为工作区基线。 */
export function buildSettleCheckpoint({ stageId, sourceCommit, artifactPaths = [], acceptedBy = 'handoff' }) {
  return `agent-workflow-stage-checkpoint:${JSON.stringify({ stageId, sourceCommit, artifactPaths, acceptedBy })}`
}
