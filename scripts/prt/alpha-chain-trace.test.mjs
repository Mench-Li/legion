// scripts/prt/alpha-chain-trace.test.mjs
// ============================================================================
// §9 链投影的判据。
//
// 这一套要钉住的核心是**两个区分**，它们各有一个具体的失效形状：
//
//   ① 「硬断」与「软缺口」不许同形。
//      第一版把"这一节有活实现"定义成"至少一个模块可达"⇒ 九节全绿，
//      而它对"这条链断在哪一节"一个字都没说。
//
//        > 一个"九节全绿"的读数，与一个"每一节都有一半接好了"的读数，
//        > 在只看那九行 ✔ 的时候是同一个东西。
//
//   ② 「不可达」与「不可达且没人打算接」不许同形。
//      `product/upgrade/switchover.mjs` 不可达（属 `deliberate`——CLI 按路径调它），
//      而 `runtime/toolcall/spool.mjs` 不可达（属 `gap`——确实缺一个挂点）。
//      只看"可达/不可达"这个二值时，两者一模一样。
//
// ★ 另外钉住我自己犯过的那个错：**模块路径必须是真路径**。
//   第一版我手写了两条猜的路径（`orchestrator/acceptance/acceptance.mjs`、
//   `orchestrator/state-machine/state-machine.mjs`），它们**不存在**——
//   而那次输出把"文件不存在"和"没人挂"报成了同一列。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { ALPHA_CHAIN, REPO, loadClassMap, traceChain, checkOwners, checkChainOwners } from './alpha-chain-trace.mjs'

/** 造一个假的 classMap。 */
const classOf = (obj) => new Map(Object.entries(obj))

const ONE = (over = {}) => ({
  classMap: classOf(over.classMap ?? {}),
  exists: (p) => (over.missing ?? []).includes(p) === false,
})

test('① ★★ 真仓库：九节、模块文件全在、首个硬断是 L5、链不全绿', () => {
  const t = traceChain()
  assert.equal(t.sections.length, 9, `§9 应当是九节，实际 ${t.sections.length}`)
  assert.equal(t.allGreen, false, '整条链被报成全绿——第 32/33 轮的读数说 L5 是断的')

  // ★ 每个模块路径都必须是**真文件**（`file不存在`与"没人挂"不许混作一谈）
  const missing = t.sections.flatMap((s) => s.modules.filter((m) => !m.present).map((m) => m.module))
  assert.deepEqual(missing, [], `链定义里写了不存在的路径：${JSON.stringify(missing)}`)

  assert.equal(t.firstHardBreak?.id, 'L5',
    `最先硬断的应当是 L5（执行 Run），实际 ${t.firstHardBreak?.id ?? '（没有）'}`)
  assert.deepEqual(t.softGaps.map((s) => s.id), ['L7', 'L9'],
    '软缺口的集合变了——要么真变了（请复核 §9 投影），要么判定逻辑跑偏')
})

test('② ★★★ 正向控制：核心模块文件不存在 ⇒ 必须判硬断', () => {
  const t = traceChain(ONE({ missing: ['runtime/dsh-composition/plugins/runtime-contract-server-row.mjs'] }))
  const l5 = t.sections.find((s) => s.id === 'L5')
  assert.equal(l5.hardBroken, true, '核心模块文件没了却没判硬断')
  assert.equal(t.firstHardBreak.id, 'L5')
})

test('③ ★★★ 正向控制：核心模块分类为 gap ⇒ 必须判硬断', () => {
  const t = traceChain(ONE({
    classMap: { 'runtime/dsh-composition/plugins/runtime-contract-server-row.mjs': { cls: 'gap', reason: 'x' } },
  }))
  assert.equal(t.sections.find((s) => s.id === 'L5').hardBroken, true)
})

test('④ ★★★ 反向控制：核心不可达但属 by-design/deliberate ⇒ **不许**判硬断', () => {
  // 这是 ② 的反面，也是本判据最容易写错的地方：
  // `product/upgrade/*` 本来就不可达（CLI 按路径调用），那是**正常**的。
  const t = traceChain(ONE({
    classMap: {
      'product/upgrade/switchover.mjs': { cls: 'deliberate', reason: 'CLI 按路径调' },
      'product/upgrade/migration.mjs': { cls: 'deliberate', reason: 'CLI 按路径调' },
      'product/launcher/cli.mjs': { cls: 'by-design', reason: '进程入口' },
    },
  }))
  assert.equal(t.sections.find((s) => s.id === 'L9').hardBroken, false,
    'deliberate 不可达被判成了硬断 ⇒ 正常状态会被报成缺陷，判据会被关掉')
  assert.equal(t.sections.find((s) => s.id === 'L1').hardBroken, false)
  assert.equal(t.allGreen, true, '这一组输入下九节应当全绿')
})

test('⑤ ★★★ 支撑模块 gap ⇒ 只能判软缺口，**不许**升级成硬断（两者不许同形）', () => {
  const t = traceChain(ONE({
    classMap: {
      'runtime/toolcall/spool.mjs': { cls: 'gap', reason: 'x' },
      'orchestrator/worker/toolcall-drain.mjs': { cls: 'gap', reason: 'x' },
      'runtime/dsh-composition/plugins/runtime-contract-server-row.mjs': { cls: 'gap', reason: 'x' },
      'product/lifecycle/retention.mjs': { cls: 'gap', reason: 'x' },
    },
  }))
  const l7 = t.sections.find((s) => s.id === 'L7')
  const l9 = t.sections.find((s) => s.id === 'L9')
  assert.equal(l7.hardBroken, false, 'L7 的核心（acceptance）是好的，不该判硬断')
  assert.equal(l7.softGap, true, 'L7 有支撑模块 gap，应当判软缺口')
  assert.equal(l9.hardBroken, false)
  assert.equal(l9.softGap, true)
  // L5 的**核心**坏了 ⇒ 硬断，且**不算**软缺口（两种状态互斥）
  const l5 = t.sections.find((s) => s.id === 'L5')
  assert.equal(l5.hardBroken, true)
  assert.equal(l5.softGap, false, '硬断的那一节同时被算进软缺口 ⇒ 两个计数会互相污染')
})

test('⑥ ★★ 全绿必须是**算出来**的，不是"没有硬断就算全绿"', () => {
  // 只有软缺口、没有硬断 ⇒ 不许报全绿
  const t = traceChain(ONE({
    classMap: { 'runtime/toolcall/spool.mjs': { cls: 'gap', reason: 'x' } },
  }))
  assert.equal(t.firstHardBreak, null, '这一组输入没有硬断')
  assert.equal(t.allGreen, false, '只有软缺口时被报成全绿 ⇒ 软缺口等于没被报')
})

test('⑦ ★★ 链定义的自洽：`core` 必须是 `modules` 的子集，且每节都要有核心', () => {
  // ★ 这条防的是"`core` 里写了个不在 `modules` 里的路径"——
  //   那样它**永远匹配不上**，那一节就永远判不出硬断（一个恒绿的分支）。
  for (const s of ALPHA_CHAIN) {
    assert.ok(s.core.length > 0, `${s.id} 一个核心模块都没写 ⇒ 它永远不会硬断`)
    const set = new Set(s.modules)
    for (const c of s.core) {
      assert.ok(set.has(c), `${s.id} 的 core 里有 \`${c}\`，但它不在 modules 里 ⇒ 那一条永远匹配不上`)
    }
    assert.ok(typeof s.coreWhy === 'string' && s.coreWhy.length >= 20,
      `${s.id} 没写清"为什么这几个是核心"——` +
      '没有理由的核心标记，与"我随手标了两个"是同一个东西')
    assert.ok(s.modules.length > 0, `${s.id} 一个模块都没写`)
  }
})

test('⑧ ★ 基线读取：classMap 认得出被跟踪的不可达文件，且 gap 与非 gap 都在', () => {
  const map = loadClassMap()
  assert.ok(map.size >= 40, `基线里只读出 ${map.size} 条不可达（期望 ≥40）`)
  const classes = new Set([...map.values()].map((v) => v.cls))
  for (const want of ['gap', 'by-design', 'deliberate']) {
    assert.ok(classes.has(want), `基线里一类 ${want} 都没有——分类词表变了？`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ⑨–⑭ 第二格：**链上每一个断点都必须有人认领**（第 34 轮加）
//
// ★ 加它的起因是一次**误报**：第一版探针去 §5 的每一格里搜**文件名**，
//   于是报出 `product/lifecycle/retention.mjs` "没有归属"——而第 16 条管着它，
//   只是 §5 用的是**中文名**「保留策略」。
//
//   > 一个靠"文件名在不在散文里"判定的归属，
//   > 与一个靠"§5 里那个词恰好是中文还是英文"判定的归属，是同一个东西——
//   > 只不过前者会输出一个数字。
//
// ⇒ 归属必须是**声明的 §5 条目编号**（唯一、机器可核的最小单位），
//   与 `NOT_FORWARDED_YET` ↔ `ASSEMBLY_ANCHORS` 是同一种记账法。
// ══════════════════════════════════════════════════════════════════════════

/** 造一节。`breaks` 是坏掉的模块名数组。 */
const sec = (id, { breaks = [], core = [], owner, ownerWhy } = {}) => ({
  id,
  title: `节 ${id}`,
  hardBroken: breaks.some((b) => core.includes(b)),
  softGap: breaks.length > 0 && breaks.every((b) => !core.includes(b)),
  brokenCore: breaks.filter((b) => core.includes(b)).map((m) => ({ module: m })),
  brokenSupport: breaks.filter((b) => !core.includes(b)).map((m) => ({ module: m })),
  ...(owner === undefined ? {} : { owner }),
  ...(ownerWhy === undefined ? {} : { ownerWhy }),
})

const WHY = '这一条逐字点名了这个文件，并给了两个可选的处置动作。'

test('⑨ ★★ 正对照：真仓库里**全部断点都有归属**，且恰有三节声明了归属', () => {
  const r = checkChainOwners()
  assert.equal(r.ok, true, '真仓库的断点归属有问题：' + JSON.stringify(r.violations))
  // 链上今天有三处断点（L5 硬断 + L7/L9 软缺口），它们都必须带归属
  const t = traceChain()
  const withOwner = t.sections.filter((s) => s.owner !== undefined).map((s) => s.id)
  assert.deepEqual(withOwner, ['L5', 'L7', 'L9'],
    `声明了归属的节变了：${JSON.stringify(withOwner)}`)
  // ★ 反向：每一节**有断点**的都必须在那三个里面（否则 ⑩ 那条规则漏了）
  const broken = t.sections.filter((s) => s.hardBroken || s.softGap).map((s) => s.id)
  assert.deepEqual(broken, withOwner, '有断点的节与声明了归属的节对不上——判据有缝')
})

test('⑩ ★★★ 正向控制：有断点却没声明归属 ⇒ 必须红（"谁也没在看"的那个断链）', () => {
  const sections = [sec('L5', { breaks: ['a/x.mjs'], core: ['a/x.mjs'] })]
  const r = checkOwners({ sections, itemNumbers: new Set([20]) })
  assert.equal(r.ok, false, '有断点、没归属，却报绿 ⇒ 断链可以没有任何人在等')
  assert.ok(r.violations.some((v) => v.id === 'break-without-owner'), JSON.stringify(r.violations))
  // 只报"缺归属"，不该顺手报别的
  assert.equal(r.violations.length, 1, JSON.stringify(r.violations))
})

test('⑪ ★★★ 正向控制：归属指到一条不存在的 §5 条目 ⇒ 必须红（指针指到空处）', () => {
  const sections = [sec('L7', { breaks: ['a/y.mjs'], owner: 99, ownerWhy: WHY })]
  const r = checkOwners({ sections, itemNumbers: new Set([16, 28]) })
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.id === 'owner-item-missing'), JSON.stringify(r.violations))
})

test('⑫ ★★★ 反向控制：归属**已过期**（没有断点却还写着归属）⇒ 必须红', () => {
  // 与 `NOT_FORWARDED_YET` 的 stale 那条同形：那一节已经通了，指针该删。
  const sections = [sec('L7', { owner: 28, ownerWhy: WHY })] // 无断点
  const r = checkOwners({ sections, itemNumbers: new Set([28]) })
  assert.equal(r.ok, false, '已经通了的节还挂着归属指针，却没红')
  assert.ok(r.violations.some((v) => v.id === 'owner-stale'), JSON.stringify(r.violations))
})

test('⑬ ★★ "什么都没查"不许报绿：§5 表解析不出来 / 归属不是编号 / 没写理由', () => {
  const noTable = checkOwners({ sections: [], itemNumbers: null })
  assert.equal(noTable.ok, false, '§5 表解析不出来却报绿 ⇒ 归属判据可以靠"没数据"通过')
  assert.ok(noTable.violations.some((v) => v.id === 'decision-table-missing'))

  const notInt = checkOwners({
    sections: [sec('L7', { breaks: ['a/y.mjs'], owner: 'runtime/toolcall/spool.mjs', ownerWhy: WHY })],
    itemNumbers: new Set([28]),
  })
  assert.equal(notInt.ok, false, '归属写成文件路径却通过了')
  assert.ok(notInt.violations.some((v) => v.id === 'owner-not-an-item-number'), JSON.stringify(notInt.violations))

  const noWhy = checkOwners({
    sections: [sec('L7', { breaks: ['a/y.mjs'], owner: 28, ownerWhy: '短' })],
    itemNumbers: new Set([28]),
  })
  assert.equal(noWhy.ok, false, '归属没写理由却通过了——"我随手指了一条"与"它真的归那一条"同形')
  assert.ok(noWhy.violations.some((v) => v.id === 'owner-why-missing'))
})

test('⑭ ★★ 反向控制：归属正确时**不许**红；且逐节分辨（不是"要么全红要么全绿"）', () => {
  const good = [
    sec('L5', { breaks: ['a/x.mjs'], core: ['a/x.mjs'], owner: 20, ownerWhy: WHY }),
    sec('L7', { breaks: ['a/y.mjs'], owner: 28, ownerWhy: WHY }),
    sec('L1', {}), // 通了、没归属 ⇒ 正常
  ]
  const r = checkOwners({ sections: good, itemNumbers: new Set([16, 20, 28]) })
  assert.deepEqual(r.violations, [], '正确时被判红：' + JSON.stringify(r.violations))

  // 只把第三节弄坏 ⇒ 应当**只**报它那一节
  const mixed = [good[0], good[1], sec('L9', { breaks: ['a/z.mjs'] })]
  const r2 = checkOwners({ sections: mixed, itemNumbers: new Set([16, 20, 28]) })
  assert.equal(r2.violations.length, 1, JSON.stringify(r2.violations))
  assert.match(r2.violations[0].message, /L9/, '报错了节')
})
