// scripts/prt/stage-scope.test.mjs
// `--only <阶段>` 的**名字**与它**真的跑到**的套件，不是同一个东西（第 35 轮）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DISAMBIGUATION, stageNames, collisions, checkStageScope, checkRepo } from './stage-scope.mjs'

test('① ★★ 正对照：真仓库里每一处"名字像"都声明过', () => {
  const r = checkRepo()
  assert.equal(r.ok, true, JSON.stringify(r.violations, null, 1))
  assert.equal(r.stages.length, 9, `阶段读到 ${r.stages.length} 个：${r.stages.join('、')}`)
  assert.ok(r.suiteCount >= 200, `套件行只读到 ${r.suiteCount} 个`)
})

test('② ★★★ 正向控制：未声明的碰撞 ⇒ 必须红（这就是第 35 轮的形状）', () => {
  const r = checkStageScope({
    stages: ['boundary'],
    suites: ['boundary-facts'],
    table: {}, // 什么都没声明
  })
  assert.equal(r.ok, false, '`--only boundary` 不跑 `boundary-facts`，却没红')
  assert.equal(r.violations[0].id, 'collision-undeclared')
  assert.match(r.violations[0].message, /--only boundary/)
})

test('③ ★★ 反向控制：声明齐全时不许红', () => {
  const r = checkStageScope({
    stages: ['boundary'],
    suites: ['boundary-facts'],
    table: { boundary: { 'boundary-facts': '这个阶段跑的是棘轮，那个判据在 test 阶段里，别拿它当验证。' } },
  })
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations))
})

test('④ ★★★ 反向控制：**过期声明**必须红（阶段名或套件名改过之后）', () => {
  const r = checkStageScope({
    stages: ['boundary'],
    suites: ['boundary-facts'],
    table: {
      boundary: { 'boundary-facts': '这个阶段跑的是棘轮，那个判据在 test 阶段里，别拿它当验证。' },
      doc: { 'doc-table': '已经不存在的组合——阶段改名了，这条声明该删。' },
    },
  })
  assert.equal(r.ok, false, '过期声明没红 ⇒ 表会越长越假')
  assert.equal(r.violations[0].id, 'collision-stale')
})

test('⑤ ★★ "什么都没查"不许报绿：阶段名或套件名读到空', () => {
  const a = checkStageScope({ stages: [], suites: ['x-facts'], table: {} })
  assert.equal(a.ok, false, '阶段名一个都没读到却报绿')
  assert.equal(a.violations[0].id, 'no-stages')

  const b = checkStageScope({ stages: ['boundary'], suites: [], table: {} })
  assert.equal(b.ok, false, '套件名一个都没读到却报绿')
  assert.equal(b.violations[0].id, 'no-suites')
})

test('⑥ ★ 碰撞的判定是**前缀**，不是"包含"（否则表会长到没人读）', () => {
  const r = collisions({ stages: ['test'], suites: ['latest-report', 'test-floor'] })
  assert.deepEqual(r, [{ stage: 'test', suite: 'test-floor' }],
    '`包含` 把无关组合也抓进来了：' + JSON.stringify(r))
})

test('⑦ ★★ 真仓库的四处碰撞是**具体这四个**——变了就必须有人看一眼', () => {
  const r = checkRepo()
  const got = r.pairs.map((p) => `${p.stage}/${p.suite}`).sort()
  assert.deepEqual(got, ['boundary/boundary-facts', 'doc/doc-render', 'doc/doc-table', 'stage/stage-scope'],
    `碰撞集合变了：${JSON.stringify(got)}`)
})

test('⑧ ★ 阶段名解析：只认阶段登记表里 name/label 的那种形状', () => {
  const text = "stageBoundary() {}\n{ name: 'boundary', label: 'DSH 执行面边界' },\nconst name = 'notastage'\n"
  assert.deepEqual(stageNames(text), ['boundary'], JSON.stringify(stageNames(text)))
})

test('⑨ ★ 表里每一条都带**可读的理由**（不是"记了一笔"）', () => {
  for (const [stage, entries] of Object.entries(DISAMBIGUATION)) {
    for (const [suite, note] of Object.entries(entries)) {
      assert.ok(note.length >= 20, `${stage}/${suite} 的理由太短`)
      assert.match(note, /test|阶段/, `${stage}/${suite} 的理由没说要到哪里找它`)
    }
  }
})

test('⑩ ★★★ 正向控制：声明里只有"记了一笔"（太短）⇒ 必须红', () => {
  // ★ 这一条是**变异逼出来的**：S7（去掉长度下限）第一次是**漏网**的——
  //   而漏网的原因是我的套件里根本没有喂过"短理由"这个输入。
  //   一条没人喂过输入的规则，与一条不存在的规则，在套件里长得一模一样。
  const r = checkStageScope({
    stages: ['boundary'],
    suites: ['boundary-facts'],
    table: { boundary: { 'boundary-facts': '见别处' } },
  })
  assert.equal(r.ok, false, '短理由没红 ⇒ 声明可以只是一笔带过')
  assert.equal(r.violations[0].id, 'collision-note-too-short', JSON.stringify(r.violations))
  // 而够长的理由不许红（否则它就只是"永远红"）
  const ok = checkStageScope({
    stages: ['boundary'],
    suites: ['boundary-facts'],
    table: { boundary: { 'boundary-facts': '这个阶段跑的是棘轮，那个判据在 test 阶段里，别拿它当验证。' } },
  })
  assert.deepEqual(ok.violations, [], JSON.stringify(ok.violations))
})
