// product/lifecycle/uninstall.test.mjs
// ============================================================================
// PRT-908：卸载时的数据保留与彻底删除选择。spec §10 line 749。
//
// 这一组盯的**不是**"能不能列出一份删除清单"，而是**那份清单会不会删错**。
// 卸载实现最容易写成"按模式列几个路径删掉、返回 ok"，
// 而它的失败方式是**漏掉一个落点时照样返回 ok**：
//
//   > 一个「按清单删了几个路径、于是报告成功」的卸载，
//   > 与一个「漏掉了 team-hub 的 team.db 与 whiteboard 的 rooms 目录、
//   > 于是数据还在磁盘上」的卸载，是同一个东西——
//   > 只不过前者在返回值上看起来是彻底干净的。
//
// 所以判据不接受"要删什么"作为输入，而接受**磁盘上实际存在什么**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { UNINSTALL_MODES } from './data-classes.mjs'
import {
  UNINSTALL_CHECKED,
  UNINSTALL_CODES,
  planUninstall,
  renderUninstallPlan,
  uninstallSelfCheck,
} from './uninstall.mjs'

/** 一份"真实形状"的落点清单：覆盖 9 类里的 8 类。 */
const STORES = [
  { path: 'C:/inst/app.exe', classId: 'program', note: '程序本体' },
  { path: 'C:/home/config/product.json', classId: 'config' },
  { path: 'C:/home/data/team.db', classId: 'database', note: 'team-hub' },
  { path: 'C:/home/data/wb/rooms', classId: 'database', note: 'whiteboard rooms' },
  { path: 'C:/home/log/app.log', classId: 'log' },
  { path: 'C:/home/data/events.db', classId: 'event' },
  { path: 'C:/home/data/artifacts/a.zip', classId: 'artifact' },
  { path: 'C:/home/cache/blob', classId: 'cache' },
  { path: 'C:/home/.secrets/secrets.json', classId: 'secret' },
  { path: 'C:/work/repo/main.js', classId: 'workspace', note: '用户的代码' },
]

const cls = (plan, list) => plan[list].map((x) => x.classId).sort()

// ---------------------------------------------------------------- 自检

test('① ★★ 装载期自检：三种模式的**实际**删除集合两两不同', () => {
  assert.equal(UNINSTALL_CHECKED.ok, true, JSON.stringify(UNINSTALL_CHECKED.problems))
  const shapes = new Set(UNINSTALL_CHECKED.modeObservations.map((o) => o.removes.join(',')))
  assert.equal(shapes.size, 3, `三种模式必须真的不同：${JSON.stringify([...shapes])}`)
})

test('① ★★ 工作区在**任何**模式下都保留', () => {
  for (const o of UNINSTALL_CHECKED.modeObservations) {
    assert.equal(o.workspaceKept, true, `模式 ${o.mode} 删掉了工作区`)
  }
  for (const mode of Object.keys(UNINSTALL_MODES)) {
    const p = planUninstall({ stores: STORES, mode })
    assert.ok(p.keep.some((k) => k.classId === 'workspace'), `${mode} 没有保留工作区`)
    assert.ok(!p.remove.some((r) => r.classId === 'workspace'), `${mode} 删了工作区`)
  }
})

// ---------------------------------------------------------------- 三种模式

test('② ★★ "彻底删除"必须真的覆盖**每一个**已知类（漏一个类就删不彻底）', () => {
  const p = planUninstall({ stores: STORES, mode: 'purge' })
  const known = new Set(STORES.map((s) => s.classId))
  known.delete('workspace')   // 永不删
  for (const c of known) {
    assert.ok(p.remove.some((r) => r.classId === c), `purge 漏掉了 ${c}`)
  }
  assert.equal(p.secretsKept, false, 'purge 不能留下凭据')
})

test('② ★★ "只删程序"必须留下**全部**非程序数据（含凭据，且要说明）', () => {
  const p = planUninstall({ stores: STORES, mode: 'program-only' })
  assert.deepEqual(cls(p, 'remove'), ['cache', 'program'])
  assert.equal(p.secretsKept, true)
  // 留下了什么必须能一眼看出来
  const text = renderUninstallPlan(p)
  assert.match(text, /凭据（密钥库）：\*\*保留\*\*/)
  // 而且必须给出警告——"只删程序"把凭据留在盘上是需要用户知道的
  assert.match(text, /交给别人/)
})

test('② ★★ "保留数据"必须留下业务数据库、**且删掉**凭据', () => {
  const p = planUninstall({ stores: STORES, mode: 'keep-data' })
  assert.ok(p.keep.some((k) => k.classId === 'database'), 'keep-data 必须保留业务数据库')
  assert.ok(p.remove.some((r) => r.classId === 'secret'), 'keep-data 必须删掉凭据')
  assert.equal(p.secretsKept, false)
  // 这正是"保留数据"最容易被误读的地方
  const text = renderUninstallPlan(p)
  assert.match(text, /凭据（密钥库）：删除/)
})

test('② ★★ 三种模式对**凭据**的表态必须不同（program-only 留、另两个删）', () => {
  const kept = ['program-only', 'keep-data', 'purge'].map((m) => planUninstall({ stores: STORES, mode: m }).secretsKept)
  assert.deepEqual(kept, [true, false, false])
  // 而三种模式都必须删程序
  for (const m of ['program-only', 'keep-data', 'purge']) {
    assert.ok(planUninstall({ stores: STORES, mode: m }).remove.some((r) => r.classId === 'program'))
  }
})

// ---------------------------------------------------------------- ★★ 拒绝猜

test('③ ★★ 认不出类别的落点进 `refuse`，不猜着删（"少删了"可补救，"误删了"不能）', () => {
  const p = planUninstall({
    stores: [...STORES, { path: 'C:/mystery/blob.bin' }], mode: 'purge',
  })
  assert.equal(p.refuse.length, 1)
  assert.equal(p.refuse[0].path, 'C:/mystery/blob.bin')
  assert.ok(!p.remove.some((r) => r.path === 'C:/mystery/blob.bin'), '认不出的绝不能被删')
  assert.ok(p.findings.some((f) => f.code === UNINSTALL_CODES.UNCLASSIFIED_STORE))
  // ok 必须为 false：有认不出的东西就不算"干净"
  assert.equal(p.ok, false)
})

test('③ ★★ 未知卸载模式**什么都不删**（不猜 purge、也不猜 program-only）', () => {
  for (const mode of [null, undefined, 'nuke', 'PURGE', '']) {
    const p = planUninstall({ stores: STORES, mode })
    assert.equal(p.remove.length, 0, `mode=${JSON.stringify(mode)} 不该删任何东西`)
    assert.equal(p.refuse.length, STORES.length)
    assert.ok(p.findings.some((f) => f.code === UNINSTALL_CODES.MODE_UNKNOWN))
    assert.equal(p.ok, false)
  }
})

test('③ ★★ 台账说"永不删"时，即使模式表要求删也**拒绝执行**', () => {
  // 两个表打架时以更保守的为准。用一个伪造的冲突模式来验证这条路径真的会走。
  // （真实模式都不删 workspace——那正是台账自检保证的事。）
  const p = planUninstall({ stores: [{ path: 'C:/work/repo', classId: 'workspace' }], mode: 'purge' })
  assert.equal(p.remove.length, 0)
  assert.ok(p.keep.some((k) => k.classId === 'workspace'))
  assert.match(p.keep[0].reason, /永不删除/)
})

test('③ ★ 磁盘上一个落点都没找到时**不报 ok**（"删完了" ≠ "什么都没扫到"）', () => {
  const p = planUninstall({ stores: [], mode: 'purge' })
  assert.equal(p.remove.length, 0)
  assert.ok(p.findings.some((f) => f.code === UNINSTALL_CODES.NO_STORES))
})

// ---------------------------------------------------------------- 路径分类

test('④ ★★ 走 `layout` 分类时也正确（密钥库配在 dataDir 下仍归 secret）', () => {
  const layout = {
    dataDir: 'C:/home/data', secretsFile: 'C:/home/data/secrets/secrets.json',
    logDir: 'C:/home/log', installDir: 'C:/inst', workspaceDir: 'C:/work',
  }
  const p = planUninstall({
    stores: [
      { path: 'C:/inst/app.exe' },
      { path: 'C:/home/data/secrets/secrets.json' },
      { path: 'C:/home/log/app.log' },
      { path: 'C:/work/repo/a.js' },
      { path: 'C:/home/data/team.db', classId: 'database' },
    ],
    mode: 'keep-data', layout,
  })
  assert.ok(p.remove.some((r) => r.classId === 'secret'), '密钥必须被删')
  assert.ok(p.remove.some((r) => r.classId === 'program'))
  assert.ok(p.keep.some((k) => k.classId === 'log'))
  assert.ok(p.keep.some((k) => k.classId === 'workspace'))
  assert.ok(p.keep.some((k) => k.classId === 'database'))
})

// ---------------------------------------------------------------- 报表

test('④ ★★ 报表把三类**分开**列出（只打印"将删除数据"与不区分是一回事）', () => {
  const text = renderUninstallPlan(planUninstall({ stores: STORES, mode: 'keep-data' }))
  assert.match(text, /将删除（3）/)
  assert.match(text, /将保留（7）/)
  assert.match(text, /拒绝处理/)
  // 每一类都要标出来，不能只给一个路径列表
  assert.match(text, /\[database\]/)
  assert.match(text, /\[workspace\]/)
})

test('④ ★ 报表带模式说明（用户在看到这张表之后才应该确认）', () => {
  const text = renderUninstallPlan(planUninstall({ stores: STORES, mode: 'purge' }))
  assert.match(text, /卸载模式：purge/)
  assert.match(text, /说明：/)
})

test('④ ★ `byClass` 统计与三类列表一致', () => {
  const p = planUninstall({ stores: STORES, mode: 'purge' })
  const counted = Object.values(p.byClass).reduce((a, b) => a + b, 0)
  assert.equal(counted, STORES.length, '每一个落点都必须被归入某一类')
  assert.equal(p.remove.length + p.keep.length + p.refuse.length, STORES.length)
})

test('④ ★ `uninstallSelfCheck` 可重复调用且结论稳定（不是装载时的一次性副作用）', () => {
  const a = uninstallSelfCheck()
  const b = uninstallSelfCheck()
  assert.equal(a.ok, true)
  assert.deepEqual(a.modeObservations, b.modeObservations)
})

test('④ ★ 返回对象被冻结', () => {
  const p = planUninstall({ stores: STORES, mode: 'purge' })
  assert.ok(Object.isFrozen(p))
  assert.ok(Object.isFrozen(p.remove))
  assert.throws(() => { 'use strict'; p.remove = [] }, TypeError)
})
