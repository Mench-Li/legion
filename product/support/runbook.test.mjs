// product/support/runbook.test.mjs
// ============================================================================
// PRT-907：支持诊断与故障处置手册。spec §10 line 990。
//
// 这一组盯的**不是**"有没有一份手册"，而是**支持人员照着它做的时候会不会撞墙**。
//
// 手写手册最常见的失效方式与隐私说明一样，只是更致命：它写在最需要它的
// 那一刻之前，而命令行、错误码、目录布局都会变。
//
//   > 一个「写着运行 `legion --doctor`」的手册，
//   > 与一个「支持人员在客户现场发现这个开关不存在」的手册，是同一个东西——
//   > 只不过前者在文档评审里看起来是完备的。
//
// 所以核心手段是：**手册挂在代码自己的开关表上，CLI 一改就红**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FAULT_CLASSES,
  FAULT_CLASS_IDS,
  RUNBOOK_CHECKED,
  RUNBOOK_CODES,
  RUNBOOK_ENTRIES,
  RUNBOOK_ENTRY_IDS,
  OBSERVABLE_KINDS,
  checkRunbook,
  compileFlagPatterns,
  matchFlag,
  referencedFlags,
  renderRunbook,
  uniqueUnknownFlag,
} from './runbook.mjs'
import { CLI_FLAGS, EXIT_CODES } from '../launcher/cli.mjs'
import { ERROR_CODES, isKnownErrorCode } from '../../runtime/contracts/errors.mjs'

const FLAGS = CLI_FLAGS.map((f) => f.name)
const mkEntry = (patch = {}) => ({
  observable: Object.freeze({ kind: 'exit-code', ref: '3 (layout)' }),
  diagnose: 'legion --check --json', action: '做点什么', ifNotHelped: '再做点别的',
  escalate: '找支持', worksWhenBroken: true, why: '因为要探', ...patch,
})

// ---------------------------------------------------------------- 自检

test('① ★★ 装载期自检：六条核心判据都真的跑过（留下的是值不是布尔）', () => {
  assert.equal(RUNBOOK_CHECKED.ok, true, JSON.stringify(RUNBOOK_CHECKED.problems))
  const s = RUNBOOK_CHECKED.samples
  // ① 引用不存在的开关被抓住。
  //
  // ★★ 这里**不写开关名的字面量**：那条自检原来钉的是 `['--doctor']`，
  //    而 PRT-257 后来真的把 `--doctor` 加进了 CLI —— 于是"这是个假开关"
  //    这个前提无声地失效了，检查器开始正确地认为它存在，用例报红。
  //    *一个"用真实名字当假数据"的夹具，与一个"永远为真"的夹具，
  //    在被观察到的那一天之前是同一个东西。*
  //    现在核对的是"被抓住的正是自检**按构造**造出来的那一个"。
  assert.deepEqual(s.ghostFlagCaught, [s.ghostFlag])
  assert.equal(FLAGS.includes(s.ghostFlag), false, '自检的假开关名竟然真的在 CLI 开关表里')
  // 反向控制：改对之后必须干净（否则是无差别报警）
  assert.equal(s.fixedFlagClean, true)
  // ② 不可观测的症状
  assert.ok(s.vagueCaught.includes(RUNBOOK_CODES.NO_OBSERVABLE))
  // ③ 死胡同
  assert.ok(s.deadEndCaught.includes(RUNBOOK_CODES.DEAD_END))
  // ④ 坏掉时不可用却没 caveat
  assert.ok(s.noCaveatCaught.includes(RUNBOOK_CODES.BROKEN_CAVEAT_MISSING))
  // ⑥ 分类不可区分
  assert.equal(s.duplicateClassCaught, FAULT_CLASS_IDS.length)
  // 与真实退出码表交叉核对的两条反向控制
  assert.deepEqual(s.badExitCaught, [99])
  // 错误码同样与真实表交叉核对
  assert.deepEqual(s.badErrorCodeCaught, ["NOT_A_REAL_CODE"])
  assert.equal(s.goodErrorCodeClean, true)
  assert.deepEqual(s.realErrorCodes, [...ERROR_CODES])
  for (const c of s.errorCodesReferenced) assert.ok(isKnownErrorCode(c), `${c} 不是真实错误码`)
  assert.ok(s.errorCodesReferenced.length >= 2)
  assert.equal(s.goodExitClean, true)
  assert.ok(s.wordyCaught.includes(RUNBOOK_CODES.OBSERVABLE_NOT_AN_IDENTIFIER))
  // 真实退出码集合来自代码，不是抄的
  assert.deepEqual(s.realExitCodes, [...new Set(Object.values(EXIT_CODES))].sort((a, b) => a - b))
  // 手册用到的可观测形态
  assert.ok(s.observableKindsUsed.length >= 4, JSON.stringify(s.observableKindsUsed))
  // ⑦ 真实手册必须过
  assert.equal(s.realOk, true)
})

test('① ★ 自检留下的开关表**真的来自 CLI**', () => {
  assert.deepEqual([...RUNBOOK_CHECKED.checkedFlags], FLAGS)
})

// ---------------------------------------------------------------- ★★ 开关

test('② ★★ 引用不存在的开关必须被抓住（本模块存在的理由）', () => {
  // ★★ 假开关**按构造**造：拿真实的开关表，造一个核对过不在里面的名字。
  //    原来这里硬编的是 `--doctor`，而它后来真的成了 CLI 开关（PRT-257）。
  const ghostFlag = uniqueUnknownFlag(FLAGS)
  assert.equal(FLAGS.includes(ghostFlag), false, '造出来的假开关竟然在表里')
  const r = checkRunbook({ entries: [mkEntry({ diagnose: `legion ${ghostFlag} --json` })], knownFlags: FLAGS })
  const f = r.findings.find((x) => x.code === RUNBOOK_CODES.UNKNOWN_FLAG)
  assert.ok(f, '不存在的开关没有被抓住')
  assert.equal(f.flag, ghostFlag)
  assert.equal(r.ok, false)
})

test('② ★★ **真实手册里每一个引用都真的存在**（CLI 一改这里就红）', () => {
  // 这一条是核心：它不注入任何假世界，直接拿真实手册去核对真实开关表。
  const r = checkRunbook()
  const ghosts = r.findings.filter((f) => f.code === RUNBOOK_CODES.UNKNOWN_FLAG)
  assert.deepEqual(ghosts.map((f) => `${f.entry}:${f.flag}`), [], '手册引用了不存在的开关')
})

test('② ★★ 占位符开关：**带具体值**的写法要命中（`--port.team-hub=9000`）', () => {
  // 第一版的正则只认 `--port.<进程>=<n>` 这种带尖括号的写法，于是把
  // `--port.team-hub=9000` 切成了 `--port` 并报"不存在"。
  assert.equal(matchFlag('--port.team-hub=9000', FLAGS), '--port.<进程>=<n>')
  assert.equal(matchFlag('--install-dir=D:\\legion', FLAGS), '--install-dir=<path>')
  assert.equal(matchFlag('--allow-port-in-use=team-hub', FLAGS), '--allow-port-in-use=<a,b>')
})

test('② ★★ 占位符开关：**只提名字**的写法也要命中（`--allow-port-in-use`）', () => {
  // 手册里会写「**不要**直接加 `--allow-port-in-use`」——那是提名字，
  // 不是在给一个可执行的命令行。
  //
  //   > 一个「对真实存在的开关喊狼来了」的检查，
  //   > 与一个「支持人员学会了忽略它的输出」的检查，是同一个东西。
  for (const name of FLAGS) {
    const base = name.split(/[<=]/)[0].replace(/[.-]+$/, '')
    assert.equal(matchFlag(base, FLAGS), name, `${base} 应该命中 ${name}`)
  }
})

test('② ★★ 逐字符近似不会误命中（`--checkx` / `--check-` 都不算）', () => {
  for (const bad of ['--checkx', '--check-', '--jsonx', '--init-', '--nodocs']) {
    assert.equal(matchFlag(bad, FLAGS), null, `${bad} 不该命中`)
  }
})

test('② ★ `referencedFlags` 抽出所有像开关的片段（**不判断真伪**）', () => {
  const got = referencedFlags('先跑 legion --check --json，再 --diagnostics=<dir>，最后 --port.team-hub=9000')
  assert.deepEqual([...got].sort(), ['--check', '--diagnostics=<dir>', '--json', '--port.team-hub=9000'])
  assert.deepEqual(referencedFlags(null), [])
  assert.deepEqual(referencedFlags('没有开关'), [])
})

test('② ★ `compileFlagPatterns` 保留原始名字（正则可读性）', () => {
  const pats = compileFlagPatterns(FLAGS)
  assert.equal(pats.length, FLAGS.length)
  for (const p of pats) {
    assert.ok(FLAGS.includes(p.name))
    assert.ok(p.re instanceof RegExp)
  }
})

// ---------------------------------------------------------------- ★★ 死胡同

test('③ ★★ 没有"这步没用怎么办"→ 死胡同', () => {
  const r = checkRunbook({ entries: [mkEntry({ ifNotHelped: '' })], knownFlags: FLAGS })
  const f = r.findings.find((x) => x.code === RUNBOOK_CODES.DEAD_END)
  assert.ok(f)
  assert.match(f.detail, /比没有手册时更困惑/)
})

test('③ ★★ 没说交给谁 → 报出来', () => {
  const r = checkRunbook({ entries: [mkEntry({ escalate: '  ' })], knownFlags: FLAGS })
  assert.ok(r.findings.some((x) => x.code === RUNBOOK_CODES.NO_ESCALATION))
})

test('③ ★★ **真实手册每一条都有 ifNotHelped 与 escalate**', () => {
  for (const e of RUNBOOK_ENTRIES) {
    assert.ok(e.ifNotHelped.trim().length > 0, `${e.id} 是死胡同`)
    assert.ok(e.escalate.trim().length > 0, `${e.id} 没说交给谁`)
  }
  const r = checkRunbook()
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.DEAD_END).length, 0)
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.NO_ESCALATION).length, 0)
})

// ---------------------------------------------------------------- ★★ 可观测

test('④ ★★ 症状必须**可观测**：「用户说不好用」不算症状', () => {
  const r = checkRunbook({ entries: [mkEntry({ observable: null })], knownFlags: FLAGS })
  assert.ok(r.findings.some((x) => x.code === RUNBOOK_CODES.NO_OBSERVABLE))
})

test('④ ★★ **真实手册每一条的可观测形态都在闭集里，且读数是一个真标识符**', () => {
  // ★ 这一条第一版是**用正则去猜**"这句话够不够具体"，结果在一堆真实但
  //   措辞不同的读数上误报（"lease 过期但 attempt 没有推进"被判成不可观测）。
  //
  //     > 一个「靠形容词判断够不够具体」的检查，
  //     > 与一个「取决于正则作者当时想到哪些词」的检查，是同一个东西——
  //     > 只不过前者在"我核对过了"这句话上看起来是有依据的。
  //
  //   现在判据是结构化的：kind 在闭集里 + 读数里必须有标识符。
  for (const e of RUNBOOK_ENTRIES) {
    assert.ok(OBSERVABLE_KINDS.includes(e.observable.kind), `${e.id} 的 kind 不在闭集里`)
    assert.ok(e.observable.ref.trim().length > 0, `${e.id} 的读数为空`)
    if (e.observable.kind === 'error-code' || e.observable.kind === 'metric') {
      assert.match(
        e.observable.ref,
        /([A-Z][A-Z0-9_]{3,})|([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)/,
        `${e.id} 的读数里没有一个标识符：${e.observable.ref}`,
      )
    }
  }
  const r = checkRunbook()
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.NO_OBSERVABLE).length, 0)
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.OBSERVABLE_KIND_UNKNOWN).length, 0)
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.OBSERVABLE_NOT_AN_IDENTIFIER).length, 0)
})

test('④ ★★ **真实手册引用的退出码全部来自 `EXIT_CODES`**', () => {
  // 手册里写一个代码里不存在的退出码，支持人员会照着它去对数。
  const real = new Set(Object.values(EXIT_CODES))
  let checked = 0
  for (const e of RUNBOOK_ENTRIES) {
    if (e.observable.kind !== 'exit-code') continue
    for (const m of e.observable.ref.matchAll(/\b(\d+)\b/g)) {
      assert.ok(real.has(Number(m[1])), `${e.id} 引用了不存在的退出码 ${m[1]}`)
      checked++
    }
  }
  assert.ok(checked >= 3, `只核对到 ${checked} 个退出码`)
  assert.equal(RUNBOOK_CHECKED.samples.goodExitClean, true)
})

test('④ ★★ 声明是码/读数却给一句形容词 → 报出来（`感觉有点慢` 不是读数）', () => {
  const r = checkRunbook({ entries: [mkEntry({ observable: Object.freeze({ kind: 'metric', ref: '感觉有点慢' }) })], knownFlags: FLAGS })
  assert.ok(r.findings.some((f) => f.code === RUNBOOK_CODES.OBSERVABLE_NOT_AN_IDENTIFIER))
})

test('④ ★★ 与真实退出码表交叉核对：不存在的退出码被抓、真实退出码放行', () => {
  const bad = checkRunbook({ entries: [mkEntry({ observable: Object.freeze({ kind: 'exit-code', ref: '99 (不存在)' }) })], knownFlags: FLAGS })
  assert.equal(bad.findings.filter((f) => f.code === RUNBOOK_CODES.EXIT_CODE_UNKNOWN).length, 1)
  const good = checkRunbook({ entries: [mkEntry({ observable: Object.freeze({ kind: 'exit-code', ref: '3 (layout) / 7 (init)' }) })], knownFlags: FLAGS })
  assert.equal(good.findings.filter((f) => f.code === RUNBOOK_CODES.EXIT_CODE_UNKNOWN).length, 0)
})

test('④ ★★ **真实手册引用的错误码全部来自产品的具名错误码表**', () => {
  // 手册里写一个产品根本不产生的码，支持人员会去找一个永远不会出现的错误。
  let checked = 0
  for (const e of RUNBOOK_ENTRIES) {
    if (e.observable.kind !== 'error-code') continue
    for (const m of e.observable.ref.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
      assert.ok(isKnownErrorCode(m[0]), `${e.id} 引用了产品不产生的错误码 ${m[0]}`)
      checked++
    }
  }
  assert.ok(checked >= 2, `只核对到 ${checked} 个错误码`)
  assert.equal(RUNBOOK_CHECKED.samples.goodErrorCodeClean, true)
})

test('④ ★★ 产品不产生的错误码被抓、真实错误码放行', () => {
  const bad = checkRunbook({ entries: [mkEntry({ observable: Object.freeze({ kind: 'error-code', ref: 'NOT_A_REAL_CODE' }) })], knownFlags: FLAGS })
  const f = bad.findings.find((x) => x.code === RUNBOOK_CODES.ERROR_CODE_UNKNOWN)
  assert.ok(f, "引用产品不产生的错误码没有被抓住")
  assert.equal(f.errorCode, "NOT_A_REAL_CODE")
  const good = checkRunbook({ entries: [mkEntry({ observable: Object.freeze({ kind: 'error-code', ref: 'SECRET_UNAVAILABLE' }) })], knownFlags: FLAGS })
  assert.equal(good.findings.filter((x) => x.code === RUNBOOK_CODES.ERROR_CODE_UNKNOWN).length, 0)
})

test('④ ★★ `error-code` 档里混进一个假码也会被逐个抓住（不是整体通过）', () => {
  // "AUTH_FAILED 或 MADE_UP" 这种写法里，真的那个不该让假的那个蒙混过关。
  const r = checkRunbook({ entries: [mkEntry({ observable: Object.freeze({ kind: 'error-code', ref: 'AUTH_FAILED / MADE_UP' }) })], knownFlags: FLAGS })
  const caught = r.findings.filter((x) => x.code === RUNBOOK_CODES.ERROR_CODE_UNKNOWN).map((x) => x.errorCode)
  assert.deepEqual(caught, ["MADE_UP"])
})

// ---------------------------------------------------------------- ★★ 坏掉时

test('⑤ ★★ 声明"坏掉时不可用"却没写先做什么 → 报出来', () => {
  const r = checkRunbook({ entries: [mkEntry({ worksWhenBroken: false })], knownFlags: FLAGS })
  const f = r.findings.find((x) => x.code === RUNBOOK_CODES.BROKEN_CAVEAT_MISSING)
  assert.ok(f)
  assert.match(f.detail, /最需要它的时候正是产品坏掉的时候/)
})

test('⑤ ★★ 声明了 caveat 就放行', () => {
  const r = checkRunbook({
    entries: [mkEntry({ worksWhenBroken: false, caveat: '先用 --diagnostics' })], knownFlags: FLAGS,
  })
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.BROKEN_CAVEAT_MISSING).length, 0)
})

test('⑤ ★★ **真实手册里"坏掉时不可用"的每一条都有 caveat**', () => {
  for (const e of RUNBOOK_ENTRIES) {
    if (e.worksWhenBroken !== true) {
      assert.ok(typeof e.caveat === 'string' && e.caveat.trim().length > 0, `${e.id} 缺 caveat`)
    }
  }
  const r = checkRunbook()
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.BROKEN_CAVEAT_MISSING).length, 0)
})

test('⑤ ★★ **至少有一半处置在产品坏掉时仍然可用**（否则手册在最需要时失效）', () => {
  const usable = RUNBOOK_ENTRIES.filter((e) => e.worksWhenBroken === true).length
  assert.ok(
    usable * 2 >= RUNBOOK_ENTRIES.length,
    `只有 ${usable}/${RUNBOOK_ENTRIES.length} 条在坏掉时可用`,
  )
  assert.equal(RUNBOOK_CHECKED.samples.worksWhenBrokenCount, usable)
})

// ---------------------------------------------------------------- ★★ 分类

test('⑥ ★★ 每一类故障都要有处置', () => {
  const r = checkRunbook()
  for (const id of FAULT_CLASS_IDS) {
    assert.ok(r.byClass[id] > 0, `${id} 没有处置`)
  }
  assert.deepEqual([...r.classesCovered].sort(), [...FAULT_CLASS_IDS].sort())
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.CLASS_UNCOVERED).length, 0)
})

test('⑥ ★★ 每一类都要有**自己特有**的处置（全都写"导包并联系支持"等于只有一条）', () => {
  // 构造十条完全重复的处置，每一类都必须被报出来。
  const dup = checkRunbook({
    entries: FAULT_CLASS_IDS.map((id, i) => mkEntry({ id: `d${i}`, faultClass: id, symptom: '都一样', action: '都一样' })),
    knownFlags: FLAGS,
  })
  assert.equal(
    dup.findings.filter((f) => f.code === RUNBOOK_CODES.CLASS_NOT_DISTINCTIVE).length,
    FAULT_CLASS_IDS.length,
  )
})

test('⑥ ★★ 真实手册的每一类都有特有处置', () => {
  const distinct = new Map()
  for (const e of RUNBOOK_ENTRIES) {
    const key = `${e.symptom}|${e.action}`
    if (!distinct.has(key)) distinct.set(key, new Set())
    distinct.get(key).add(e.faultClass)
  }
  for (const [key, classes] of distinct) {
    assert.equal(classes.size, 1, `同一个 (症状, 动作) 出现在多个分类里：${key}`)
  }
  const r = checkRunbook()
  assert.equal(r.findings.filter((f) => f.code === RUNBOOK_CODES.CLASS_NOT_DISTINCTIVE).length, 0)
})

test('⑥ ★ 认不出的分类被报出来', () => {
  const r = checkRunbook({ entries: [mkEntry({ faultClass: '谁知道呢' })], knownFlags: FLAGS })
  assert.ok(r.findings.some((f) => f.code === RUNBOOK_CODES.CLASS_UNKNOWN))
})

test('⑥ ★ 空手册被报出来', () => {
  const r = checkRunbook({ entries: [], knownFlags: [] })
  assert.ok(r.findings.some((f) => f.code === RUNBOOK_CODES.EMPTY))
  assert.equal(r.ok, false)
})

test('⑥ ★ 没写 why 的处置被报出来', () => {
  const r = checkRunbook({ entries: [mkEntry({ why: '' })], knownFlags: FLAGS })
  assert.ok(r.findings.some((f) => f.code === RUNBOOK_CODES.UNJUSTIFIED))
})

// ---------------------------------------------------------------- 渲染/边界

test('⑦ ★ 渲染出六段式：症状 / 怎么认 / 查一下 / 怎么做 / 没用的话 / 找支持', () => {
  const text = renderRunbook(checkRunbook())
  assert.match(text, /怎么认：exit-code — 3 \(layout\)/)
  assert.match(text, /查一下：/)
  assert.match(text, /怎么做：/)
  assert.match(text, /没用的话：/)
  assert.match(text, /找支持：/)
  for (const cls of FAULT_CLASSES) assert.match(text, new RegExp(`【${cls.label}】`))
  assert.match(text, /每条处置都引用了真实存在的开关/)
})

test('⑦ ★ 有未闭合项时渲染**明说**，不宣布健康', () => {
  // 同样用**按构造**的假开关（原来是硬编的 `--doctor`，PRT-257 之后它成了真开关）。
  const bad = checkRunbook({ entries: [mkEntry({ diagnose: `legion ${uniqueUnknownFlag(FLAGS)}` })], knownFlags: FLAGS })
  const text = renderRunbook(bad)
  assert.match(text, /自身有问题/)
  assert.match(text, /runbook-unknown-flag/)
  assert.doesNotMatch(text, /每条处置都引用了真实存在的开关/)
})

test('⑦ ★ 每条处置的 id 唯一、分类合法', () => {
  assert.equal(new Set(RUNBOOK_ENTRY_IDS).size, RUNBOOK_ENTRIES.length, 'id 有重复')
  for (const e of RUNBOOK_ENTRIES) {
    assert.ok(FAULT_CLASS_IDS.includes(e.faultClass), `${e.id} 的分类不合法`)
    assert.ok(e.symptom.trim().length > 0, `${e.id} 没有症状`)
    assert.ok(e.diagnose.trim().length > 0, `${e.id} 没有诊断步骤`)
    assert.ok(e.action.trim().length > 0, `${e.id} 没有处置动作`)
  }
})

test('⑦ ★ 返回对象被冻结', () => {
  const r = checkRunbook()
  assert.ok(Object.isFrozen(r))
  assert.ok(Object.isFrozen(r.findings))
  assert.throws(() => { 'use strict'; r.ok = false }, TypeError)
})

test('⑦ ★ 缺省参数不抛', () => {
  const r = checkRunbook()
  assert.equal(r.ok, true)
  assert.ok(r.entryCount > 0)
})
