// product/launcher/doctor.test.mjs
// ============================================================================
// PRT-257 修复入口（`line 275`：`incompatible` → 「禁止自动执行，**提示修复或回滚**」）。
//
// 本套件分三块：
//   ① 纯函数的判据（零 IO，逐条给）；
//   ② **与生产对齐**：把 `repairPlanFor()` 的真产物（`runtime/dsh-composition/
//      bootstrap.mjs`，那边有 33 例）喂进本模块——两处对"计划形状"的理解
//      必须一致，而这件事只有**跨模块**跑一次才算证明；
//   ③ 退出码：`0 / 1 / 3` 三个读数，尤其 **"没诊断"不能是 0**。
//
// 第 ② 块是本套件的理由：*一个"自己造一份计划喂给自己"的用例，
// 与一个"根本没接上生产"的模块，在测试报告上是同一个东西。*
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DOCTOR_CODES,
  DOCTOR_EXIT,
  DOCTOR_VERSION,
  RUNTIME_INSTALL_CHECK,
  doctorReport,
  planFrom,
  renderDoctor,
} from './doctor.mjs'
import { REPAIR_ACTIONS, repairPlanFor } from '../../runtime/dsh-composition/bootstrap.mjs'
import { readActiveRuntime } from './runtime-install.mjs'

/** **自检**的一项：`name` / `ok` / `reasons`（`startupSelfCheck` 的形状）。 */
const check = (name, ok, reasons = []) => ({ name, ok, reasons })

/**
 * **修复计划**的一项：`check` / `action` / `label` / `why` / `reasons`。
 *
 * 与 `check()` 是**两个**形状，不能混用——自检项用 `name`，计划项用 `check`。
 * 本套件第一版把两者混了，于是三条断言对着 `undefined` 比较，
 * *一个"字段名抄错"的夹具，与一个"读不出字段"的实现，在断言信息上是同一个东西。*
 */
const planItem = (name, extra = {}) => ({
  check: name, action: `${name}-action`, label: `${name} 要修`, why: `${name} 为什么`, reasons: [], ...extra,
})

test('① 全过 → CLEAN / 退出 0 / ok=true', () => {
  const r = doctorReport({ source: 'self-check', plan: repairPlanFor({ checks: [check('runtime-probe', true)] }) })
  assert.equal(r.code, DOCTOR_CODES.CLEAN)
  assert.equal(r.exitCode, 0)
  assert.equal(r.ok, true)
  assert.deepEqual(r.items, [])
})

test('① 一项没过 → ACTIONABLE / 退出 1 / 带出**那一条**修法', () => {
  const plan = repairPlanFor({ checks: [check('runtime-probe', true), check('sandbox-enforcement', false, ['sandbox-partial'])] })
  const r = doctorReport({ source: 'self-check', plan })
  assert.equal(r.code, DOCTOR_CODES.ACTIONABLE)
  assert.equal(r.exitCode, DOCTOR_EXIT.ACTIONABLE)
  assert.equal(r.ok, false)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].check, 'sandbox-enforcement')
  // 修法来自**生产**那张表，不是本模块编的。
  assert.equal(r.items[0].action, REPAIR_ACTIONS['sandbox-enforcement'].action)
  assert.deepEqual(r.items[0].reasons, ['sandbox-partial'])
})

test('① ★★★ 三块读数的退出码两两不同形：0 / 1 / 3', () => {
  const clean = doctorReport({ plan: repairPlanFor({ checks: [check('a', true)] }) })
  const actionable = doctorReport({ plan: repairPlanFor({ checks: [check('a', false)] }) })
  const none = doctorReport({})
  assert.deepEqual([clean.exitCode, actionable.exitCode, none.exitCode], [0, 1, 3])
  assert.equal(new Set([clean.code, actionable.code, none.code]).size, 3)
})

// ═══════════════════════════════════════════ ② "没诊断"绝不是"没事"

test('② ★★★ 拿不到诊断 → 退出 **3**，而不是 0（本模块最要紧的一条）', () => {
  // 三个"没有诊断"的入口，都必须落到同一档。
  for (const input of [{}, { source: 'run-record' }, { refusal: null, plan: null }]) {
    const r = doctorReport(input)
    assert.equal(r.code, DOCTOR_CODES.NO_DIAGNOSIS, `${JSON.stringify(input)} 被当成了别的结论`)
    assert.notEqual(r.exitCode, 0,
      '读不到诊断却退 0 —— 每一次接线遗漏都会看起来像一次体检通过')
    assert.equal(r.ok, false)
  }
})

test('② ★★ "没诊断"的报告要说清**它证明不了什么**，并把来源的原因带出来', () => {
  const r = doctorReport({ source: 'run-record', note: '运行记录里没有自检结论（RUN_RECORD_NO_SELF_CHECK）' })
  const text = renderDoctor(r)
  assert.match(text, /这不等于"一切正常"/)
  assert.match(text, /RUN_RECORD_NO_SELF_CHECK/, '来源给的具名原因必须读得到')
  assert.match(text, /RUN_RECORD_NO_SELF_CHECK/.test(text) ? /来源说/ : /x/)
})

test('② ★★★ 知道它坏了却没给修法 → NO_PLAN（也是 3），**比"有待修项"更坏**', () => {
  const r = doctorReport({
    source: 'run-record',
    refusal: {
      code: 'RUNTIME_HOST_ROW_SELF_CHECK_INCOMPATIBLE',
      state: 'incompatible',
      autoExecutionForbidden: true,
      patchVersion: 'prt-x',
      reasons: ['缺必需能力：tool-permission-enforcement'],
      repair: null, // ← 拒绝说了"不行"，却没给修法
    },
  })
  assert.equal(r.code, DOCTOR_CODES.NO_PLAN)
  assert.equal(r.exitCode, DOCTOR_EXIT.UNDIAGNOSED)
  assert.notEqual(r.exitCode, DOCTOR_EXIT.CLEAN)
  // 它得说清"这是产品侧的缺口，不是你操作错了"——否则用户会去查自己的配置。
  assert.match(renderDoctor(r), /产品侧的缺口/)
  assert.match(renderDoctor(r), /tool-permission-enforcement/, '拒绝给的原因要带出来')
})

// ═══════════════════════════════════════════ ③ 与生产对齐

test('③ ★★★ 喂 `repairPlanFor()` 的**真产物**：形状对得上，六项修法都出得来', () => {
  // 六项全没过 —— 这正是生产里最坏的那一次自检。
  const names = Object.keys(REPAIR_ACTIONS)
  const plan = repairPlanFor({ checks: names.map((n) => check(n, false, [`${n}-reason`])) })
  assert.equal(plan.ok, false)
  const r = doctorReport({ source: 'self-check', plan })
  assert.equal(r.code, DOCTOR_CODES.ACTIONABLE)
  assert.equal(r.items.length, names.length, '生产计划的项数与本模块读出来的项数不一致')
  const text = renderDoctor(r)
  for (const n of names) {
    assert.ok(text.includes(n), `修法表里的 ${n} 没有出现在渲染结果里`)
    assert.ok(text.includes(`${n}-reason`), `${n} 的现场读数没印出来`)
  }
})

test('③ ★★★ 认不出的检查项**留在正文里**，不被丢掉、也不被静音', () => {
  const plan = repairPlanFor({ checks: [check('sandbox-enforcement', false), check('a-brand-new-check', false)] })
  const r = doctorReport({ source: 'self-check', plan })
  assert.equal(r.items.length, 2, '未知项被丢掉了 —— 那会把"两项没过"说成"一项"')
  const text = renderDoctor(r)
  assert.match(text, /a-brand-new-check/)
  assert.match(text, /没有预置修法/, '未知项要单独成段，不能混在已知项里')
  // 未知项排在同一段里，且明说它**同样在阻止执行**——否则用户会以为它不重要。
  assert.match(text, /同样在阻止执行/)
})

test('③ ★★ 计划里的 `ok:true` 项**不算待修**（有人把整份 checks 当计划传时）', () => {
  const r = doctorReport({ plan: { ok: true, items: [{ check: 'a', ok: true }, { check: 'b', ok: false, action: 'x', label: 'B', why: 'w', reasons: [] }] } })
  assert.equal(r.code, DOCTOR_CODES.ACTIONABLE)
  assert.deepEqual(r.items.map((i) => i.check), ['b'])
})

// ═══════════════════════════════════════════ ④ 三态与回滚

test('④ ★★ `autoExecutionForbidden` 是**三态**：true / false / 没说（null）', () => {
  const said = (v) => doctorReport({
    source: 's',
    refusal: { autoExecutionForbidden: v, state: 'incompatible', repair: { ok: false, items: [planItem('sandbox-enforcement')] } },
  })
  assert.equal(said(true).forbidden, true)
  assert.equal(said(false).forbidden, false)
  // 缺字段 → `null`，**不是** false：把"没说"读成"允许"正是要避免的那条路。
  const absent = doctorReport({ source: 's', plan: { ok: false, items: [planItem('sandbox-enforcement')] } })
  assert.equal(absent.forbidden, null)
})

test('④ ★★★ 回滚这条路**总是**给出来（只给修复 = 告诉修不好的人"你没出路"）', () => {
  const cases = [
    doctorReport({ source: 's', plan: repairPlanFor({ checks: [check('sandbox-enforcement', false)] }) }),
    doctorReport({ source: 's' }),
    doctorReport({ source: 's', plan: repairPlanFor({ checks: [check('a', true)] }) }),
  ]
  for (const r of cases) {
    const text = renderDoctor(r)
    // ★★★ 断言的是**那条可执行的出路本身**，不是"回滚"这两个字。
    //   本套件第一版写的是 `assert.match(text, /回滚/)`，而它在破验 D5 里
    //   **没咬住**：那个变异把 `或者回滚：` 改成 `（不回滚）`，正则照样匹配。
    //     > 一个"只匹配那两个汉字"的断言，
    //     > 与一个"那一段在不在都无所谓"的断言，在结果上是同一个东西——
    //     > 只不过前者看起来是在检查回滚。
    assert.match(text, /换回上一个可用的安装/,
      `${r.code} 的报告里没有**可执行的**回滚出路`)
    assert.equal(/不回滚/.test(text), false, '报告里出现了相反的说法')
  }
  // 带上补丁层版本时，回滚提示要对照它。
  const withVer = doctorReport({
    source: 's',
    refusal: { patchVersion: 'prt-9.9', autoExecutionForbidden: true, repair: { ok: false, items: [planItem('runtime-probe')] } },
  })
  assert.match(renderDoctor(withVer), /prt-9\.9/)
})

test('④ ★★ 「只提示、不自动改」这件事要**写在输出里**，并说清为什么', () => {
  const text = renderDoctor(doctorReport({ source: 's', plan: repairPlanFor({ checks: [check('runtime-probe', false)] }) }))
  assert.match(text, /只提示、不自动改/)
  assert.match(text, /live reload/, '"为什么不能自动改"要给出理由，否则下一个人会顺手把它自动化')
  // 但全过的时候不必说这段（没有要改的东西）。
  const clean = renderDoctor(doctorReport({ source: 's', plan: repairPlanFor({ checks: [check('a', true)] }) }))
  assert.equal(/只提示、不自动改/.test(clean), false)
})

test('④ ★★ 拒绝值上的 `state` / `patchVersion` / `source` 都落进报告', () => {
  const r = doctorReport({
    source: 'run-record',
    refusal: {
      state: 'incompatible', patchVersion: 'prt-1.2', autoExecutionForbidden: true,
      repair: { ok: false, items: [check('runtime-probe', false)] },
    },
  })
  assert.equal(r.state, 'incompatible')
  assert.equal(r.patchVersion, 'prt-1.2')
  assert.equal(r.source, 'run-record')
  const text = renderDoctor(r)
  assert.match(text, /run-record/, '来源要印出来：不说来源的报告，在两次诊断之间分不开')
})

test('④ ★ `planFrom()` 只认一个来源，不把两个来源缝起来', () => {
  // 同时给了 plan 与 refusal：`plan` 优先，且**不合并**。
  const both = planFrom({
    plan: { ok: false, items: [planItem('from-plan')] },
    refusal: { repair: { ok: false, items: [planItem('from-refusal')] } },
  })
  assert.deepEqual(both.items.map((i) => i.check), ['from-plan'])
  // 一个"有 items 就算计划"的对象；没有 items 的不算。
  assert.equal(planFrom({ plan: { ok: false } }), null)
  assert.equal(planFrom({ refusal: { repair: null } }), null)
})

test('④ ★ 版本常量存在且稳定（报告里要能对上实现）', () => {
  assert.equal(DOCTOR_VERSION, 1)
  assert.match(renderDoctor(doctorReport({ source: 's' })), /doctor v1/)
})

test('④ ★ 渲染器对畸形输入不抛（它可能被喂进任何东西）', () => {
  for (const v of [null, undefined, 0, '', 'x', []]) {
    assert.equal(typeof renderDoctor(v), 'string')
  }
})

// ═══════════════════════════════════════════ ⑤ PRT-257 运行时**安装**这一项
//
// 在此之前，doctor 的词汇表里"DSH 装没装"出现次数是 **0**：它能报出
// "强制面没生效"，却报不出"执行引擎根本没装"。这一组用例守两件事：
//   ① 那一项**确实**会出现在报告里，且带得出可执行的下一步；
//   ② 它**永远不能**把 `NO_DIAGNOSIS` 说成 `CLEAN` ——
//      "字节装对了"推不出"强制面生效了"，而把两者合成一个绿，
//      正是本任务书点名的那类"两个各自绿了的半边"。

/** `readActiveRuntime()` 的形状（四态），逐项可覆写。 */
const reading = (state, extra = {}) => ({
  state,
  pointerPath: 'C:/data/runtime/dsh/current.json',
  dir: state === 'active' ? 'C:/data/runtime/dsh/versions/0.1.5-rc.2' : null,
  version: state === 'active' ? '0.1.5-rc.2' : null,
  patchVersion: state === 'active' ? 1 : null,
  entryPath: 'C:/data/runtime/dsh/versions/0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js',
  entryExists: state === 'active',
  complete: state === 'active',
  message: state === 'active' ? 'ok' : `${state}-读数`,
  ...extra,
})

test('⑤ ★★★★ 装了、而且装完了 → 这一项**不算待修**，但那行读数仍然印得出来', () => {
  const clean = doctorReport({ source: 'self-check', plan: repairPlanFor({ checks: [check('runtime-probe', true)] }) })
  const r = doctorReport({
    source: 'self-check',
    plan: repairPlanFor({ checks: [check('runtime-probe', true)] }),
    runtimeInstall: reading('active'),
  })
  assert.equal(r.code, DOCTOR_CODES.CLEAN, '一个装好的运行时不该把全过的自检变红')
  assert.equal(r.exitCode, DOCTOR_EXIT.CLEAN)
  assert.equal(clean.items.length, r.items.length)
  // 但它不能被**静音**：绿的那一份读数也要印出来（否则"读了没读"分不出来）。
  const text = renderDoctor(r)
  assert.match(text, /0\.1\.5-rc\.2/)
  assert.match(text, /字节装没装对/)
})

test('⑤ ★★★★★ 自检全过 + 运行时**没装** ⇒ ACTIONABLE（不能读成 CLEAN）', () => {
  const r = doctorReport({
    source: 'self-check',
    plan: repairPlanFor({ checks: [check('runtime-probe', true)] }),
    runtimeInstall: reading('absent'),
  })
  assert.equal(r.code, DOCTOR_CODES.ACTIONABLE)
  assert.equal(r.exitCode, DOCTOR_EXIT.ACTIONABLE)
  assert.equal(r.ok, false)
  const item = r.items.find((i) => i.check === RUNTIME_INSTALL_CHECK)
  assert.ok(item !== undefined, `报告里没有这一项：${JSON.stringify(r.items.map((i) => i.check))}`)
  const text = renderDoctor(r)
  // 下一步必须**可执行**：说得出跑哪条命令，而不是"请安装运行时"。
  assert.match(text, /--runtime-install-plan/)
  assert.match(text, /runtime-manifest/)
  // 而且要说清组合层这一次是**全过**的——不说的话用户会去修一份本来就好的组合层。
  assert.match(text, /组合层自检这一次是\*\*全过\*\*的/)
})

test('⑤ ★★★★★ 运行时读数**永远**不能把"没诊断"变成 CLEAN（退出码仍是 3）', () => {
  for (const state of ['active', 'absent', 'broken', 'unreadable']) {
    const r = doctorReport({ source: 'run-record', runtimeInstall: reading(state) })
    assert.equal(r.code, DOCTOR_CODES.NO_DIAGNOSIS, `${state} 把没诊断变成了别的结论`)
    assert.equal(r.exitCode, DOCTOR_EXIT.UNDIAGNOSED)
    assert.equal(r.exitCode === 0, false)
    // 但那份读数要印出来：它可能正是"为什么起不来"的答案。
    assert.match(renderDoctor(r), /字节装没装对/)
  }
})

test('⑤ ★★★★ 指针坏了 / 读不懂 ⇒ 这一项红，且带出**下一步**与现场读数', () => {
  for (const state of ['broken', 'unreadable']) {
    const r = doctorReport({
      source: 'self-check',
      plan: repairPlanFor({ checks: [check('runtime-probe', true)] }),
      runtimeInstall: reading(state, { entryExists: false, complete: false }),
    })
    assert.equal(r.code, DOCTOR_CODES.ACTIONABLE)
    const item = r.items.find((i) => i.check === RUNTIME_INSTALL_CHECK)
    assert.ok(item !== undefined)
    assert.equal(item.ok, false)
    const blob = JSON.stringify(item)
    // 现场读数：指针路径、入口路径、读数自己说的话——三条都必须在。
    assert.match(blob, /current\.json/)
    assert.match(blob, /bin\.js/)
    assert.match(blob, new RegExp(`${state}-读数`))
    // 下一步：没有预置修法的项走 `inspect-manually`，但**不能**因此没有内容。
    assert.equal(item.action, 'inspect-manually')
    assert.match(renderDoctor(r), /没有预置修法/)
  }
})

test('⑤ ★★★★ 状态对、磁盘不对 ⇒ **不算过**（三项一起成立才算）', () => {
  // 三种"字段对了一个"的假绿，每一种都必须红。
  const fake = [
    reading('active', { complete: false }),        // 目录没有完成标记
    reading('active', { entryExists: false }),     // 入口文件不在
    reading('active', { complete: null }),         // 完成标记**没说**
  ]
  for (const r0 of fake) {
    const r = doctorReport({ source: 's', plan: repairPlanFor({ checks: [check('a', true)] }), runtimeInstall: r0 })
    assert.equal(r.code, DOCTOR_CODES.ACTIONABLE,
      `一个 ${JSON.stringify({ complete: r0.complete, entryExists: r0.entryExists })} 的读数被读成了通过`)
  }
})

test('⑤ ★★★ 读数畸形（没有可识别的 state）⇒ **不许绿**', () => {
  for (const bad of [{}, { state: 'ok' }, { state: null }, { state: 7 }]) {
    const r = doctorReport({ source: 's', plan: repairPlanFor({ checks: [check('a', true)] }), runtimeInstall: bad })
    assert.equal(r.code, DOCTOR_CODES.ACTIONABLE, `${JSON.stringify(bad)} 被当成了通过`)
  }
  // "没给这份读数"与"给了个坏的"是两回事：前者不影响结论。
  const notGiven = doctorReport({ source: 's', plan: repairPlanFor({ checks: [check('a', true)] }) })
  assert.equal(notGiven.code, DOCTOR_CODES.CLEAN)
  assert.equal(notGiven.items.length, 0)
})

test('⑤ ★★★ 与生产对齐：喂 `readActiveRuntime()` 的**真产物**（不是手写的读数）', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-doctor-rt-'))
  try {
    // ① 干净机器：真的读一次，得到一个真的 `absent`。
    const empty = readActiveRuntime({ dataDir: join(root, 'empty') })
    assert.equal(empty.state, 'absent')
    const rAbsent = doctorReport({
      source: 'self-check', plan: repairPlanFor({ checks: [check('runtime-probe', true)] }), runtimeInstall: empty,
    })
    assert.equal(rAbsent.code, DOCTOR_CODES.ACTIONABLE)
    assert.ok(rAbsent.items.some((i) => i.check === RUNTIME_INSTALL_CHECK),
      '真的 `absent` 读数没有让这一项红 —— 夹具与生产对不上')
    // ② 指针坏了：真的写一份读不懂的指针，再读一次。
    const dataDir = join(root, 'broken')
    const runtimeRoot = join(dataDir, 'runtime', 'dsh')
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(runtimeRoot, 'current.json'), '{ 不是 JSON\n', 'utf8')
    const unreadable = readActiveRuntime({ dataDir })
    assert.equal(unreadable.state, 'unreadable')
    const rUnreadable = doctorReport({
      source: 'self-check', plan: repairPlanFor({ checks: [check('runtime-probe', true)] }), runtimeInstall: unreadable,
    })
    assert.equal(rUnreadable.code, DOCTOR_CODES.ACTIONABLE)
    assert.match(JSON.stringify(rUnreadable.items), /current\.json/)
    // ③ 这个模块**不许**自己碰磁盘：把 fs 换成只会抛的桩，读数照样出得来。
    const exploding = { existsSync: () => { throw new Error('doctor 不该做 IO') } }
    const rNoIo = doctorReport({
      source: 's', plan: repairPlanFor({ checks: [check('a', true)] }), runtimeInstall: { ...empty, state: 'active', complete: true, entryExists: true },
      fs: exploding,
    })
    assert.equal(rNoIo.code, DOCTOR_CODES.CLEAN)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑤ ★★ 检查项名是稳定字面量（报告里要能对上实现）', () => {
  assert.equal(RUNTIME_INSTALL_CHECK, 'runtime-install')
  const r = doctorReport({ source: 's', plan: { ok: true, items: [] }, runtimeInstall: reading('absent') })
  assert.equal(r.items[0].check, RUNTIME_INSTALL_CHECK)
})
