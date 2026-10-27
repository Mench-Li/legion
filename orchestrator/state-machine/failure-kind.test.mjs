// orchestrator/state-machine/failure-kind.test.mjs
// ---------------------------------------------------------------------------
// 失败分类归一化的判据（决策 #6 方案 B）。
//
// 这一组盯的是**两条不许被做成失败的业务事实**，以及一个会静默出错的统计口径：
//   ① 「等上游」不是失败——做成失败会让它进重试计数器并污染失败率；
//   ② 「验收返工」不是失败——做成失败会把流程正常工作显示成出错；
//   ③ 失败率的分母要排除它们，否则"流程很健康"会被算成"失败率很低"。
//
// 运行：node orchestrator/state-machine/failure-kind.test.mjs
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FAILURE_KINDS, FAILURE_KIND_LABELS, NON_FAILURE_KINDS, failureKindOf, failureRate,
} from './failure-kind.mjs'

test('① ★★★ 「等待前置任务」不是失败', () => {
  const verdict = failureKindOf({ blockedByDependency: true })
  assert.equal(verdict.kind, 'waiting')
  assert.equal(verdict.isFailure, false, '★★ 等上游不是失败：给它失败码会让它进重试计数器')
  assert.match(verdict.reason, /上游/)
})

test('② ★★★ 「验收返工」不是失败', () => {
  const verdict = failureKindOf({ reviewRework: true })
  assert.equal(verdict.kind, 'rework')
  assert.equal(verdict.isFailure, false, '★★ 返工是流程正常：做成失败会把正常工作显示成出错')
  // 升级（反复修不好）同样不是失败：审查结论仍然有效。
  assert.equal(failureKindOf({ errorCode: 'AGENT_WORKFLOW_REWORK_REPEATED' }).isFailure, false)
})

test('③ 四层各自的码都能归到正确类别', () => {
  const cases = [
    ['AUTH_FAILED', 'auth'],
    ['permission-denied', 'permission'],
    ['AGENT_NODE_NOT_READY', 'node'],
    ['AGENT_NODE_PROVIDER_INCOMPATIBLE', 'node'],
    ['GIT_CONFLICT', 'integration'],
    ['VALIDATION_FAILED', 'integration'],
    ['AGENT_WORKFLOW_HANDOFF_EVIDENCE_MISSING', 'agent'],
  ]
  for (const [code, kind] of cases) {
    assert.equal(failureKindOf({ errorCode: code }).kind, kind, `★ ${code} 应归入 ${kind}`)
    assert.equal(failureKindOf({ errorCode: code }).isFailure, true)
  }
})

test('④ Attempt 状态：failed → agent，unknown → unknown（都算失败），其余不算', () => {
  assert.equal(failureKindOf({ attemptState: 'failed' }).kind, 'agent')
  assert.equal(failureKindOf({ attemptState: 'unknown' }).kind, 'unknown')
  assert.equal(failureKindOf({ attemptState: 'unknown' }).isFailure, true, '★ unknown 是"待核对"，不是"没事"')
  assert.equal(failureKindOf({ attemptState: 'completed' }).kind, 'none')
  assert.equal(failureKindOf({ attemptState: 'canceled' }).kind, 'none', '用户取消不该算失败')
  assert.equal(failureKindOf({ attemptState: 'running' }).kind, 'none')
  // stop_reason 要进 reason，便于排查。
  assert.match(failureKindOf({ attemptState: 'unknown', stopReason: 'worker-restarted' }).reason, /worker-restarted/)
})

test('⑤ 优先级：具名码 > 预约态 > Attempt 状态 > 返工/等待', () => {
  // 同时有"返工"与"认证失败"：认证失败更需要人处理，应优先。
  assert.equal(failureKindOf({ errorCode: 'AUTH_FAILED', reviewRework: true }).kind, 'auth')
  // 同时有"等上游"与"unknown"：unknown 需要核对，优先。
  assert.equal(failureKindOf({ attemptState: 'unknown', blockedByDependency: true }).kind, 'unknown')
  // 取消未确认压过 Attempt 的 none。
  assert.equal(failureKindOf({ attemptState: 'completed', reservationState: 'reconciling' }).kind, 'unknown')
})

test('⑥ ★★★ 失败率的分母排除"不是失败"的类别', () => {
  const verdicts = [
    failureKindOf({ errorCode: 'AUTH_FAILED' }),      // 失败
    failureKindOf({ attemptState: 'failed' }),        // 失败
    failureKindOf({ blockedByDependency: true }),     // waiting，不是失败
    failureKindOf({ reviewRework: true }),            // rework，不是失败
    failureKindOf({ attemptState: 'completed' }),     // none
  ]
  const rate = failureRate(verdicts)
  assert.equal(rate.available, true)
  assert.equal(rate.failures, 2)
  // 分母 = 5（全部都是可判定样本），包含 waiting/rework/none —— 它们**是样本**，
  // 只是不进分子。把它们从分母里删掉会让失败率虚高。
  assert.equal(rate.total, 5)
  assert.equal(rate.value, 2 / 5)

  // 全是"不是失败"时：可用，但值为 0——这是真话，不是"没有样本"。
  assert.equal(failureRate([failureKindOf({ blockedByDependency: true })]).value, 0)
  // 空样本：不可用（与 0 必须分开）。
  const empty = failureRate([])
  assert.equal(empty.available, false)
  assert.equal(empty.value, null, '★★ 空样本不许显示 0：那会读成"一次都没失败"')
})

test('⑦ 类别集合是封闭的：每个 kind 都有文案，且 non-failure 是它的子集', () => {
  for (const kind of FAILURE_KINDS) {
    assert.equal(typeof FAILURE_KIND_LABELS[kind], 'string', `★ ${kind} 缺文案`)
  }
  for (const kind of NON_FAILURE_KINDS) {
    assert.ok(FAILURE_KINDS.includes(kind), `★★ ${kind} 不在类别集合里——新增类别必须显式加进 FAILURE_KINDS`)
  }
  // 反例守卫：未登记的码不许被猜成某类失败，只能落到 none。
  assert.equal(failureKindOf({ errorCode: 'SOMETHING_UNKNOWN' }).kind, 'none',
    '★★ 未登记的码不许猜：猜错会让一个新错误静默归进旧类别')
})

test('⑧ 空输入安全：不抛，返回 none', () => {
  assert.equal(failureKindOf().kind, 'none')
  assert.equal(failureKindOf({}).isFailure, false)
  assert.equal(failureKindOf(null ?? {}).kind, 'none')
})
