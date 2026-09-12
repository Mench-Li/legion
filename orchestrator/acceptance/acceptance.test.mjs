// orchestrator/acceptance/acceptance.test.mjs
// ============================================================================
// 机器验收（PRT-307）的用例
//
// 这一组问的是**唯一**一个问题：这条任务算不算做完了。
// 判错的两种代价是不对称的：
//   - 把没做成的判成做成 → 交付里出现坏东西，而且没人知道（伪装成功）；
//   - 把做成的判成没做成 → 白做一遍（如果外部写已经发生，就是重复副作用）。
// 因此这里逐条覆盖"机器判不了"的每一种成因，并确保它们**都**不会被当成通过。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCEPTANCE_DECISIONS,
  ACCEPTANCE_ERRORS,
  CRITERION_KINDS,
  AcceptanceError,
  acceptanceTarget,
  evaluateAcceptance,
} from './index.mjs'

const ok = (extra = {}) => ({ outcome: 'completed', detail: null, result: null, artifacts: [], ...extra })
const paths = (r) => r.results.map((x) => x.reason)

test('① 判据全过 → accepted（并且没有任何"判不了"的条目）', () => {
  const r = evaluateAcceptance({
    runResult: ok({ result: { summary: 'done', files: 3 }, artifacts: [{ path: 'out/a.txt' }] }),
    criteria: [
      { kind: 'run-completed' },
      { kind: 'structured-result', required: ['summary', 'files'] },
      { kind: 'artifact', path: 'out/a.txt' },
    ],
  })
  assert.equal(r.decision, 'accepted')
  assert.deepEqual({ ...r.gate }, { total: 3, passed: 3, failed: 0, unverifiable: 0 })
  assert.match(r.reason, /全部 3 条判据均已由机器核验通过/)
  // 判定依据只挑叶子字段，且长期可保存（不 dump 整个 runResult）
  assert.deepEqual(r.run.artifactPaths, ['out/a.txt'])
})

test('① 运行结果不是 completed → rejected，且**不必再看判据**', () => {
  const r = evaluateAcceptance({
    runResult: { outcome: 'failed', detail: '上游 502' },
    criteria: [{ kind: 'run-completed' }],
  })
  assert.equal(r.decision, 'rejected')
  assert.match(r.reason, /不是 completed/)
  assert.match(r.reason, /上游 502/)
})

test('① 运行结果是 outcome_unknown → rejected（它该走人工对账，不该走验收）', () => {
  const r = evaluateAcceptance({ runResult: { outcome: 'outcome_unknown' }, criteria: [{ kind: 'run-completed' }] })
  assert.equal(r.decision, 'rejected')
  assert.match(r.reason, /outcome_unknown/)
})

test('① 机器确认判据不满足 → rejected，并逐条说明**哪一条**没过', () => {
  const r = evaluateAcceptance({
    runResult: ok({ result: { summary: 'done' }, artifacts: [] }),
    criteria: [
      { kind: 'structured-result', required: ['summary', 'testsPassed'] },
      { kind: 'artifact', path: 'out/report.md' },
    ],
  })
  assert.equal(r.decision, 'rejected')
  assert.equal(r.gate.failed, 2)
  assert.match(r.reason, /testsPassed/)
  assert.match(r.reason, /out\/report\.md/)
  // 产物清单为空时也要把"清单里有什么"说清楚，否则排查只能靠猜
  assert.match(r.reason, /清单里是：空/)
})

test('② 任务没声明判据 → needs-human，**不是** accepted', () => {
  // 「没人说过什么叫做完」不等于「做完了」。默认通过会把这批任务整体标成
  // 已完成，而验收判据从头到尾没有被读过——这正是"伪装成功"最常见的样子。
  const r = evaluateAcceptance({ runResult: ok(), criteria: [] })
  assert.equal(r.decision, 'needs-human')
  assert.match(r.reason, /没有声明任何验收判据/)
  assert.equal(r.gate.total, 0)
})

test('② 声明了「只能由人核验」→ needs-human（而不是失败）', () => {
  const r = evaluateAcceptance({
    runResult: ok({ result: { summary: 'x' } }),
    criteria: [{ kind: 'structured-result', required: ['summary'] }, { kind: 'manual', note: '需要产品负责人确认文案' }],
  })
  assert.equal(r.decision, 'needs-human')
  assert.equal(r.gate.passed, 1, '机器能核的那条仍然被核过了')
  assert.equal(r.gate.failed, 0, '它不是失败——机器没有确认它不满足')
  assert.equal(r.gate.unverifiable, 1)
  assert.match(r.reason, /需要产品负责人确认文案/)
})

test('② 未知判据种类 → needs-human，**绝不**当成通过', () => {
  const r = evaluateAcceptance({ runResult: ok(), criteria: [{ kind: '看起来很重要' }] })
  assert.equal(r.decision, 'needs-human')
  assert.match(r.reason, /不是机器可核验的/)
  // 错误信息里要能看出已知哪些种类，否则调用方只能去翻源码
  assert.match(r.reason, /run-completed/)
})

test('② 判据缺 kind / 不是对象 → needs-human，不得当成"没有要求"', () => {
  for (const bad of [{ required: ['a'] }, null, 'run-completed', 42, ['nested']]) {
    const r = evaluateAcceptance({ runResult: ok(), criteria: [bad] })
    assert.equal(r.decision, 'needs-human', `判据 ${JSON.stringify(bad)} 必须走人工，实际 ${r.decision}`)
    assert.equal(r.gate.passed, 0)
  }
})

test('② 判据参数本身写错（缺 required / 缺 path）→ needs-human，不是 rejected', () => {
  // 这两种成因完全不同：判据写错了是**契约问题**，不该让任务被反复重做。
  const r1 = evaluateAcceptance({ runResult: ok({ result: {} }), criteria: [{ kind: 'structured-result' }] })
  assert.equal(r1.decision, 'needs-human')
  assert.match(r1.reason, /缺少 required/)
  const r2 = evaluateAcceptance({ runResult: ok(), criteria: [{ kind: 'artifact' }] })
  assert.equal(r2.decision, 'needs-human')
  assert.match(r2.reason, /缺少 path/)
  const r3 = evaluateAcceptance({ runResult: ok({ result: { a: 1 } }), criteria: [{ kind: 'structured-result', required: ['a', 7] }] })
  assert.equal(r3.decision, 'needs-human')
  assert.match(r3.reason, /非字符串字段名/)
})

test('② 确认失败优先于"判不了"：两者并存时结论是 rejected', () => {
  // 反过来的话，一条确认缺失的产物会被"还有一条判不了"掩盖过去，
  // 于是任务进人工审批，而审批人看到的是"机器判不了"而不是"产物没生成"。
  const r = evaluateAcceptance({
    runResult: ok({ artifacts: [] }),
    criteria: [{ kind: 'artifact', path: 'missing.txt' }, { kind: 'manual' }],
  })
  assert.equal(r.decision, 'rejected')
  assert.equal(r.gate.failed, 1)
  assert.equal(r.gate.unverifiable, 1)
})

test('③ 结构化结果缺失但判据要求核验字段 → rejected（不是 needs-human）', () => {
  const r = evaluateAcceptance({
    runResult: ok({ result: null }),
    criteria: [{ kind: 'structured-result', required: ['summary'] }],
  })
  assert.equal(r.decision, 'rejected')
  assert.match(r.reason, /没有产出结构化结果/)
})

test('③ 字段存在即为满足（值为 null/0/false 也算存在）', () => {
  // 用 `in` 而不是真值判断：`{ testsPassed: 0 }` 是"核验了、结果是 0"，
  // 而 `{}` 是"根本没这个字段"。用真值判断会把前者判成缺失。
  const r = evaluateAcceptance({
    runResult: ok({ result: { testsPassed: 0, clean: false, note: null } }),
    criteria: [{ kind: 'structured-result', required: ['testsPassed', 'clean', 'note'] }],
  })
  assert.equal(r.decision, 'accepted', paths(r).join(' / '))
})

test('④ runResult 不是对象时抛契约错误，而不是"没有运行结果 → 通过"', () => {
  for (const bad of [null, undefined, 'completed', 42, []]) {
    assert.throws(() => evaluateAcceptance({ runResult: bad, criteria: [] }),
      (e) => e instanceof AcceptanceError && e.code === ACCEPTANCE_ERRORS.RUN_RESULT_INVALID,
      `runResult=${JSON.stringify(bad)} 必须拒绝`)
  }
})

test('④ criteria 不是数组时抛契约错误，而不是当成空判据', () => {
  // 当成 `[]` 会走 needs-human（还算安全）；但当成 `[{...}]` 之外的东西
  // 一旦被某处 `for...of` 展开就会静默通过，因此这里直接拒绝。
  for (const bad of [null, undefined, 'run-completed', 42, {}]) {
    assert.throws(() => evaluateAcceptance({ runResult: ok(), criteria: bad }),
      (e) => e instanceof AcceptanceError && e.code === ACCEPTANCE_ERRORS.CRITERIA_NOT_ARRAY,
      `criteria=${JSON.stringify(bad)} 必须拒绝`)
  }
})

test('⑤ acceptanceTarget：验收通过后往哪走取决于 hasNextPost，缺它必须拒绝', () => {
  const next = acceptanceTarget('accepted', { hasNextPost: true })
  assert.equal(next.ok, true)
  assert.equal(next.to, 'HandingOff')
  const last = acceptanceTarget('accepted', { hasNextPost: false })
  assert.equal(last.to, 'Completed')
  // 缺这个输入时不得默认：默认完成会静默掐断任务链，默认交接会创建没有承接方的任务
  for (const bad of [undefined, null, 'true', 1, 0]) {
    const r = acceptanceTarget('accepted', { hasNextPost: bad })
    assert.equal(r.ok, false, `hasNextPost=${JSON.stringify(bad)} 必须拒绝`)
    assert.equal(r.code, 'MISSING_GUARD_INPUT')
  }
})

test('⑤ acceptanceTarget：打回走可重试失败，交人工走交付级审批', () => {
  const rejected = acceptanceTarget('rejected', {})
  assert.equal(rejected.to, 'RetryableFailure', '打回的下一步由重试额度的唯一决策点决定')
  const human = acceptanceTarget('needs-human', {})
  assert.equal(human.to, 'AwaitingApproval')
  assert.equal(human.context.returnTo, 'Validating',
    'returnTo 必须是 Validating：人工批准后不必重跑执行，回到验收继续')
})

test('⑤ acceptanceTarget：未知结论不给去向', () => {
  for (const bad of ['accepted!', 'ok', '', undefined, null]) {
    const r = acceptanceTarget(bad, { hasNextPost: false })
    assert.equal(r.ok, false, `结论 ${JSON.stringify(bad)} 不得有默认去向`)
    assert.equal(r.code, 'UNKNOWN_DECISION')
  }
})

test('⑥ 三种结论都在 ACCEPTANCE_DECISIONS 里，且 acceptanceTarget 覆盖全部三种', () => {
  assert.deepEqual([...ACCEPTANCE_DECISIONS], ['accepted', 'rejected', 'needs-human'])
  for (const d of ACCEPTANCE_DECISIONS) {
    const r = acceptanceTarget(d, { hasNextPost: false })
    assert.equal(r.ok, true, `结论 ${d} 必须有去向`)
  }
  // 判据种类的封闭性：上面每条都必须真的被实现（default 分支不是用来的）
  assert.ok(CRITERION_KINDS.includes('manual'))
})

test('⑦ 散文判据（stage-standards 的真实形态）= 人工判据，不是"形状不对"', () => {
  // team-hub 的 tasks.acceptance 由 stage-standards.mjs 生成，内容是散文。
  // 这是**真实数据**的形态，因此必须被当成一类正当的判据，
  // 而不是"调用方传错了"。结论同样是 needs-human，但排查方向完全相反。
  const prose = [
    '产出与本阶段职责一致，能回答「为谁、解决什么、怎么验收」',
    '每条关键结论可验证：有真实依据（引用 / 命令输出 / 样例），不得虚构',
  ]
  const r = evaluateAcceptance({ runResult: ok(), criteria: prose })
  assert.equal(r.decision, 'needs-human')
  assert.equal(r.gate.unverifiable, 2, '散文判据全部计入"无法核验"')
  assert.equal(r.gate.failed, 0, '它不是失败——机器没有确认它不满足')
  assert.match(r.reason, /由人核验的验收标准/)
  // 错误信息里要带上原文：人工审批的人得看见要核什么
  assert.match(r.reason, /每条关键结论可验证/)
})

test('⑦ 散文判据 + 机器判据并存（真实任务的常见形态）→ 机器判据照核，人工收口', () => {
  const r = evaluateAcceptance({
    runResult: ok({ result: { summary: 'x' }, artifacts: [{ path: 'out/a.txt' }] }),
    criteria: [
      '产出与本阶段职责一致',
      { kind: 'run-completed' },
      { kind: 'structured-result', required: ['summary'] },
      { kind: 'artifact', path: 'out/a.txt' },
    ],
  })
  assert.equal(r.decision, 'needs-human', '散文判据把结论抬到人工审批')
  assert.equal(r.gate.passed, 3, '三条机器判据**照常**被核过')
  assert.equal(r.gate.unverifiable, 1)
  assert.equal(r.gate.failed, 0)
  // 而机器判据确认不满足时，仍然是 rejected（打回），人工不接手
  const bad = evaluateAcceptance({
    runResult: ok({ result: { summary: 'x' }, artifacts: [] }),
    criteria: ['产出与本阶段职责一致', { kind: 'artifact', path: 'out/a.txt' }],
  })
  assert.equal(bad.decision, 'rejected')
})

test('⑦ 空字符串判据 = 这一行没写完，不是"没有要求"', () => {
  for (const empty of ['', '   ', '\t\n']) {
    const r = evaluateAcceptance({ runResult: ok(), criteria: [empty] })
    assert.equal(r.decision, 'needs-human')
    assert.match(r.reason, /空字符串/)
  }
})

test('⑦ stage-standards 的默认模板确实全部是散文（口径对得上真实数据）', async () => {
  // 这条断言把「本模块对字符串判据的处理」与「真实数据的形态」钉在一起。
  // 若哪天 stage-standards 改成生成 {kind} 对象，这条会红——那时应当
  // 重新想一遍机器验收该怎么接，而不是让两条口径悄悄分叉。
  const { DEFAULT_STANDARD } = await import('../../team-hub/stage-standards.mjs')
  assert.ok(Array.isArray(DEFAULT_STANDARD.acceptance))
  assert.ok(DEFAULT_STANDARD.acceptance.length > 0)
  for (const c of DEFAULT_STANDARD.acceptance) {
    assert.equal(typeof c, 'string', `默认验收标准应当是人类散文，实际是 ${typeof c}：${JSON.stringify(c)}`)
  }
  // 因此默认模板生成的任务，其验收结论必然是 needs-human——人工审批是正常路径
  const r = evaluateAcceptance({ runResult: ok(), criteria: DEFAULT_STANDARD.acceptance })
  assert.equal(r.decision, 'needs-human')
})

test('⑥ 判据顺序不影响结论，且结果与判据一一对应', () => {
  const criteria = [
    { kind: 'artifact', path: 'b.txt' },
    { kind: 'run-completed' },
    { kind: 'structured-result', required: ['x'] },
  ]
  const runResult = ok({ result: { x: 1 }, artifacts: [{ path: 'b.txt' }] })
  const r = evaluateAcceptance({ runResult, criteria })
  assert.equal(r.decision, 'accepted')
  assert.equal(r.results.length, 3)
  assert.deepEqual(r.results.map((x) => x.criterion.kind), ['artifact', 'run-completed', 'structured-result'])
})

test('⑥ 产物清单里有非对象条目时不崩，且该条判据仍然是不满足', () => {
  const r = evaluateAcceptance({
    runResult: ok({ artifacts: [null, 'out/a.txt', { path: 'out/a.txt' }] }),
    criteria: [{ kind: 'artifact', path: 'out/a.txt' }],
  })
  assert.equal(r.decision, 'accepted')
  assert.deepEqual(r.run.artifactPaths, [null, null, 'out/a.txt'])
  const miss = evaluateAcceptance({
    runResult: ok({ artifacts: [null, 'out/a.txt'] }),
    criteria: [{ kind: 'artifact', path: 'out/a.txt' }],
  })
  assert.equal(miss.decision, 'rejected', '字符串形式的产物条目不算命中：形状不对时不得当成满足')
})
