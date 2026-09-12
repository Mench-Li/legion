// product/release/checklist.test.mjs
// ============================================================================
// PRT-909：产品发布检查清单。spec §10 line 992；完成标准 line 995。
//
// 这一组盯的**不是**"有没有一份清单"，而是**清单上那一列打勾能代表什么**。
// 一份清单最容易写成的样子是一列布尔，而"我们从来没跑过这条流程"与
// "我们跑过、它通过了"在那一列里是**同一个值**：
//
//   > 一个「证据缺失时默认算过」的发布清单，
//   > 与一个「所有项都过」的清单，在报表上是同一个东西。
//
// 所以下面每一条都用一个**注入的假世界**去问，而不是断言仓库当前状态。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALPHA_FLOWS,
  ALPHA_FLOW_IDS,
  CHECKLIST_CHECKED,
  CHECKLIST_CODES,
  CHECKLIST_ITEMS,
  CHECKLIST_ITEM_IDS,
  EVIDENCE_VERDICTS,
  PASSING_VERDICTS,
  evaluateChecklist,
  renderChecklist,
} from './checklist.mjs'

const NOW = 1_700_000_000_000
const DAY = 86400000
const exists = () => true
const mkItems = (patch = {}) => [{
  id: 'probe', flow: 'install', label: '探针项',
  evidenceFrom: 'product/release/privacy.mjs', why: '因为要探',
  ...patch,
}]
const withAll = (verdict, ageMs) => Object.fromEntries(
  ALPHA_FLOW_IDS.flatMap((flow) => CHECKLIST_ITEMS.filter((i) => i.flow === flow).map((i) => i.id))
    .map((id) => [id, { verdict, atMs: NOW - ageMs }]),
)

// ---------------------------------------------------------------- 自检

test('① ★★ 装载期自检：四条核心判据都真的被跑过（留下的是值不是布尔）', () => {
  assert.equal(CHECKLIST_CHECKED.ok, true, JSON.stringify(CHECKLIST_CHECKED.problems))
  const s = CHECKLIST_CHECKED.samples
  // 缺失 → 不就绪；过期 → 不就绪；本次通过 → 就绪
  assert.equal(s.missingReady, false)
  assert.deepEqual(s.missingVerdicts, ['no-evidence'])
  assert.equal(s.staleReady, false)
  assert.equal(s.freshReady, true)
  // 没有时间戳的证据按"没跑过"处理
  assert.ok(s.undatedCaught.includes(CHECKLIST_CODES.EVIDENCE_UNDATED))
  // 指向不存在来源的检查项被抓住
  assert.ok(s.ghostCaught.includes(CHECKLIST_CODES.EVIDENCE_SOURCE_MISSING))
})

// ---------------------------------------------------------------- 四值

test('② ★★ 判定是**四值**的，且只有 `pass` 算通过', () => {
  assert.deepEqual([...EVIDENCE_VERDICTS], ['pass', 'fail', 'no-evidence', 'stale'])
  assert.deepEqual([...PASSING_VERDICTS], ['pass'])
})

test('② ★★ 证据缺失 → `no-evidence`，`ready` 为假（**不是通过**）', () => {
  const r = evaluateChecklist({ nowMs: NOW, items: mkItems(), evidence: {}, sourceExists: exists })
  assert.equal(r.items[0].verdict, 'no-evidence')
  assert.equal(r.ready, false)
  assert.equal(r.counts['no-evidence'], 1)
  assert.ok(r.findings.some((f) => f.code === CHECKLIST_CODES.ITEM_NO_EVIDENCE))
})

test('② ★★ 有证据但明确失败 → `fail`（与"没跑过"分开）', () => {
  const r = evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'fail', atMs: NOW - DAY, detail: '装不上' } },
  })
  assert.equal(r.items[0].verdict, 'fail')
  assert.equal(r.ready, false)
  assert.match(r.items[0].reason, /装不上/)
})

test('② ★★ 本次通过的证据 → 就绪（否则这套判定不可满足）', () => {
  const r = evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'pass', atMs: NOW - DAY } },
  })
  assert.equal(r.ready, true)
  assert.equal(r.counts.pass, 1)
})

// ---------------------------------------------------------------- ★★ 过期

test('③ ★★ 过期的证据 → `stale`，且与"没跑过"是**两个不同的判定**', () => {
  // "三个月前那次发布会话里递过来的证据"与"这次什么都没跑"，
  // 在"这次发布验证了什么"上完全等价——但下一步不同：一个要**重跑**，一个要**去跑**。
  const r = evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'pass', atMs: NOW - 30 * DAY } },
  })
  assert.equal(r.items[0].verdict, 'stale')
  assert.equal(r.ready, false)
  assert.equal(r.counts.stale, 1)
  assert.equal(r.counts['no-evidence'], 0, '过期不能被折叠成"没跑过"')
  assert.match(r.items[0].reason, /30 天/)
})

test('③ ★★ 渲染时"没跑过"与"过期"分成两段（两种不同的下一步）', () => {
  const text = renderChecklist(evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'pass', atMs: NOW - 30 * DAY } },
  }))
  assert.match(text, /证据过期/)
  assert.match(text, /重跑/)
  assert.doesNotMatch(text, /从没跑过/)
})

test('③ ★★ 有效期边界：刚好到期的算过期，差一天的算通过', () => {
  const at = (ageMs) => evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists, maxAgeMs: 10 * DAY,
    evidence: { probe: { verdict: 'pass', atMs: NOW - ageMs } },
  })
  assert.equal(at(10 * DAY + 1).items[0].verdict, 'stale')
  assert.equal(at(10 * DAY - 1).items[0].verdict, 'pass')
})

// ---------------------------------------------------------------- ★★ 时间戳

test('④ ★★ 没有时间戳的证据按"没跑过"处理，**不按通过**', () => {
  // 没有时间戳的证据无法判断它是哪一次的。
  const r = evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'pass' } },
  })
  assert.equal(r.ready, false)
  assert.ok(r.findings.some((f) => f.code === CHECKLIST_CODES.EVIDENCE_UNDATED))
})

test('④ ★★ 判定值不在四值之内 → 按"没跑过"处理（未知不等于通过）', () => {
  for (const bogus of ['ok', 'passed', true, 1, '']) {
    const r = evaluateChecklist({
      nowMs: NOW, items: mkItems(), sourceExists: exists,
      evidence: { probe: { verdict: bogus, atMs: NOW - DAY } },
    })
    assert.equal(r.ready, false, `${JSON.stringify(bogus)} 不该算通过`)
  }
})

test('④ ★ 证据自称 `no-evidence`/`stale` 时原样传递，**不升级成 pass**', () => {
  for (const v of ['no-evidence', 'stale']) {
    const r = evaluateChecklist({
      nowMs: NOW, items: mkItems(), sourceExists: exists,
      evidence: { probe: { verdict: v, atMs: NOW - DAY } },
    })
    assert.equal(r.items[0].verdict, v)
    assert.equal(r.ready, false)
  }
})

// ---------------------------------------------------------------- ★★ 证据来源

test('⑤ ★★ 检查项指向不存在的证据来源 → 报出来（否则这一项永远拿不到证据）', () => {
  const r = evaluateChecklist({ nowMs: NOW, items: mkItems(), evidence: {}, sourceExists: () => false })
  const f = r.findings.find((x) => x.code === CHECKLIST_CODES.EVIDENCE_SOURCE_MISSING)
  assert.ok(f)
  assert.equal(f.source, 'product/release/privacy.mjs')
})

test('⑤ ★★ 检查项没写理由 → 报出来（说不出理由的检查会被下一个人删掉）', () => {
  const r = evaluateChecklist({
    nowMs: NOW, items: mkItems({ why: '' }), evidence: {}, sourceExists: exists,
  })
  assert.ok(r.findings.some((f) => f.code === CHECKLIST_CODES.ITEM_UNJUSTIFIED))
})

test('⑤ ★★ **真实清单的每一项**都指向一份真实存在的文件', () => {
  // 这一条用的是默认的 sourceExists（真的去查磁盘）——它是本模块唯一能挡住
  // "证据来源被删/改名而检查项还在"的判据。
  const r = evaluateChecklist({ nowMs: NOW, evidence: {} })
  const ghosts = r.findings.filter((f) => f.code === CHECKLIST_CODES.EVIDENCE_SOURCE_MISSING)
  assert.deepEqual(ghosts.map((f) => f.item), [], `指向不存在的来源：${JSON.stringify(ghosts.map((f) => f.source))}`)
})

test('⑤ ★★ **真实清单**覆盖 spec line 995 的六条流程，且每条至少一项', () => {
  const r = evaluateChecklist({ nowMs: NOW, evidence: {} })
  assert.deepEqual([...ALPHA_FLOW_IDS].sort(), ['diagnose', 'install', 'restore', 'uninstall', 'upgrade', 'use'])
  assert.deepEqual([...r.flowsCovered].sort(), [...ALPHA_FLOW_IDS].sort())
  for (const flow of ALPHA_FLOW_IDS) {
    assert.ok(r.byFlow[flow].length > 0, `流程 ${flow} 没有检查项`)
  }
})

test('⑤ ★★ 空流程被逐条报出来（空集合会让"这条流程已验证"变成一句空话）', () => {
  const r = evaluateChecklist({ nowMs: NOW, items: [], evidence: {}, sourceExists: exists })
  assert.equal(
    r.findings.filter((f) => f.code === CHECKLIST_CODES.FLOW_UNCOVERED).length,
    ALPHA_FLOW_IDS.length,
  )
})

// ---------------------------------------------------------------- 真实读数

test('⑥ ★★ 仓库**当前**状态：不给证据 → 一定不就绪，且 12 项全是 `no-evidence`', () => {
  // 这是刻意的一条：清单现在**没有**接任何证据生产者，所以真实读数必然
  // 是"每一项都没跑过"。把它钉住，是为了让"这份清单绿了"这件事
  // 不可能在没有人真的跑过流程的情况下发生。
  const r = evaluateChecklist({ nowMs: NOW, evidence: {} })
  assert.equal(r.ready, false)
  assert.equal(r.counts['no-evidence'], CHECKLIST_ITEMS.length)
  assert.equal(r.counts.pass, 0)
  assert.equal(CHECKLIST_CHECKED.samples.realReadyWithoutEvidence, false)
})

test('⑥ ★★ 全部项都给本次证据时才会就绪（唯一一条能变绿的路）', () => {
  const r = evaluateChecklist({ nowMs: NOW, evidence: withAll('pass', DAY) })
  assert.equal(r.ready, true, JSON.stringify(r.notReady))
  assert.equal(r.counts.pass, CHECKLIST_ITEMS.length)
  assert.deepEqual([...r.notReady], [])
})

test('⑥ ★★ 十二条检查项里**任意一条**缺失都会让它不就绪（没有"重要项"例外）', () => {
  for (const id of CHECKLIST_ITEM_IDS) {
    const evidence = { ...withAll('pass', DAY) }
    delete evidence[id]
    const r = evaluateChecklist({ nowMs: NOW, evidence })
    assert.equal(r.ready, false, `缺 ${id} 却报就绪`)
    assert.deepEqual(r.notReady.map((x) => x.id), [id])
  }
})

test('⑥ ★★ 十二条检查项里**任意一条**过期都会让它不就绪', () => {
  for (const id of CHECKLIST_ITEM_IDS) {
    const evidence = { ...withAll('pass', DAY), [id]: { verdict: 'pass', atMs: NOW - 30 * DAY } }
    const r = evaluateChecklist({ nowMs: NOW, evidence })
    assert.equal(r.ready, false, `${id} 过期却报就绪`)
  }
})

// ---------------------------------------------------------------- 渲染

test('⑦ ★ 渲染分三段：跑没跑过 / 过没过期 / 跑了没过（三种不同的下一步）', () => {
  const evidence = { ...withAll('pass', DAY) }
  const items = CHECKLIST_ITEMS
  evidence[items[0].id] = { verdict: 'pass', atMs: NOW - 30 * DAY }   // stale
  delete evidence[items[1].id]                                        // no-evidence
  evidence[items[2].id] = { verdict: 'fail', atMs: NOW - DAY, detail: '接口 500' } // fail
  const text = renderChecklist(evaluateChecklist({ nowMs: NOW, evidence }))
  assert.match(text, /从没跑过/)
  assert.match(text, /证据过期/)
  assert.match(text, /跑了没过/)
  assert.match(text, /接口 500/)
  assert.match(text, /不可发布/)
})

test('⑦ ★ 就绪时渲染出"可以发布"，且列出六条流程', () => {
  const text = renderChecklist(evaluateChecklist({ nowMs: NOW, evidence: withAll('pass', DAY) }))
  assert.match(text, /可以发布/)
  for (const f of ALPHA_FLOWS) assert.match(text, new RegExp(`【${f.label}】`))
})

test('⑦ ★ 返回对象被冻结', () => {
  const r = evaluateChecklist({ nowMs: NOW, evidence: {} })
  assert.ok(Object.isFrozen(r))
  assert.ok(Object.isFrozen(r.items))
  assert.ok(Object.isFrozen(r.findings))
  assert.throws(() => { 'use strict'; r.ready = true }, TypeError)
})

test('⑦ ★ 每条检查项都有 label 与唯一 id', () => {
  assert.equal(new Set(CHECKLIST_ITEM_IDS).size, CHECKLIST_ITEMS.length, 'id 有重复')
  for (const i of CHECKLIST_ITEMS) {
    assert.ok(i.label.length > 0, `${i.id} 没有 label`)
    assert.ok(i.why.length > 0, `${i.id} 没有 why`)
    assert.ok(ALPHA_FLOW_IDS.includes(i.flow), `${i.id} 的流程 ${i.flow} 不合法`)
  }
})
