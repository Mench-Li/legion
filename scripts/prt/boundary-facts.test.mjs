// scripts/prt/boundary-facts.test.mjs
// ============================================================================
// 判据自己的判据：**每一条事实都必须在它该红的时候红。**
//
// ## 为什么这个套件的重点不是"现在全绿"
//
// "8/8 全绿"只说明**今天**文档与产物一致。它完全不能说明这份校验**有没有用**——
// 一个 `checkFacts()` 永远返回 `{ok:true}` 的实现，在真实仓库上也是 8/8 全绿。
//
//   > 一条只在"今天的巧合"上为真的判据，与一条永远为真的判据，
//   > 在绿色的摘要里是同一行。
//
// 所以本套件对**每一条**带文档锚点的事实做一次**反面控制**：
// 把文档里那个数字改掉，它必须红，而且必须是**它自己**红。
//
// ## 两条对称的载荷控制（第三条最容易被漏掉）
//
// `runtime-env-excludes-hub-token` 是 `derive(...) === false` 形状的断言。
// 而**一个永远返回 `false` 的坏推导会让它恒绿**。所以：
//   · 载荷一：给 `runtime` 的 envNames 塞进 token ⇒ 它必须红；
//   · 载荷二：把 `orchestrator` 的 token 拿掉 ⇒ 那一条必须红，
//     而 `runtime` 那一条**仍然绿**（证明两条不是同一条断言）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  FACTS, checkFacts, defaultContext, patchYmlRepresentedRows,
  scanCommitCitations, scanLineCitations, checkPinnedCitations,
  checkManifestImpersonation, tallyLedger, tallyUnreachable,
  STATUS_DOC, LEDGER_DOC, PATCH_YML, REPO, HUB_TOKEN_ENV, WORKBENCH_TOKEN_ENV,
  HANDOVER_DOC, INTERVENTION_DOC, FINAL_REPORT_DOC,
  reportSectionRounds, roundOrderViolations, sectionFourBareCurrentReadings,
  GENERATED_STATUS_VOCAB, GENERATED_STATUS_RE, canonicalJson,
  scanOriginalCitations, originalQuoteOnLine,
  // ★★★ 第 118 轮第十三轮（业主确认 c）：裸坐标 + 具名符号那一层。
  CITE_SYMBOL_ROOTS, CITE_SYMBOL_WINDOW,
  citeSymbolReferences, citeSymbolVerdict, scanBareCoordinateSymbols,
  clearBareCoordinateSymbolsMemo,
} from './boundary-facts.mjs'
import { checkRepo, clearCheckRepoMemo } from './design-boundaries.mjs'
import { LEDGER_STATUS_MARKS, STATUS_MARKS, ledgerTaskRow } from './progress-check.mjs'
import { matrixItems, MATRIX_PATH } from './reachability.mjs'

const REAL = checkFacts()

/** 把某份文档整体替换掉（不碰磁盘上的真文件）。 */
function withDoc(rel, transform) {
  const base = defaultContext()
  return { ...base, doc: (r) => (r === rel ? transform(base.doc(r)) : base.doc(r)) }
}

/** 替掉某个进程的 spec（`specFor` 是唯一的读取口）。 */
function withSpec(key, transform) {
  const base = defaultContext()
  return { ...base, spec: (k) => (k === key ? transform(base.spec(k)) : base.spec(k)) }
}

const idsOf = (r) => r.violations.map((v) => v.id)

/**
 * 把台账正文换成 `transform(真实正文)`，并让**坐标扫描器也跟着换**。
 *
 * ★ 第一版我**只**替了 `doc`，于是 ⑪b/⑪c/⑪d/⑪e 四条全红——而它们红得**对**：
 *   `lineCitations` / `commitCitations` 是在 `defaultContext()` 里闭包捕获的，
 *   它们读的仍是**磁盘上那份真台账**，于是喂进去的毒根本没到判据手里。
 *
 *   > 一个"替身没生效"与一个"判据没在查"，在测试输出里都是同一条红——
 *   > 而修法**完全相反**（一个改测试、一个改判据）。
 *
 *   ⇒ 这个替身必须同时换掉"输入"与"由输入派生的那两个口"。
 */
function withLedgerText(transform) {
  const base = defaultContext()
  const poisoned = transform(base.doc(LEDGER_DOC))
  return {
    ...base,
    doc: (r) => (r === LEDGER_DOC ? poisoned : base.doc(r)),
    lineCitations: () => scanLineCitations(poisoned),
    commitCitations: () => scanCommitCitations(poisoned),
    // ★★ 第 26 轮补上这一口。`ledgerTallies` 与上面两口**同一个形状**：
    //    它在 `defaultContext` 里闭包捕获了**真的** `doc`，所以只替 `doc`
    //    的替身根本到不了它手里——喂进去的毒会让"台账计数"那条事实
    //    **读真台账而绿**，于是这条控制是**假**的。
    //    （这正是本函数上面那段注释写的形状，我又踩了一次：
    //      *"一个替身没生效"与"判据没在查"，在输出里是同一条红，修法相反。*）
    ledgerTallies: () => tallyLedger(poisoned),
  }
}

// ── ① 正向：真实仓库上全部通过，且**一条都没被跳过** ──────────────────────
test('① 真实仓库：全部通过，且参与比对的条数等于事实总数（不许静默跳过）', () => {
  assert.equal(REAL.violations.length, 0, `有红：${JSON.stringify(REAL.violations)}`)
  assert.equal(REAL.checked, FACTS.length,
    `参与比对 ${REAL.checked} 条，而事实表有 ${FACTS.length} 条——`
    + '有判据被静默跳过了，而"跳过"与"通过"在只有一个 ✅ 的输出里长得一样')
  assert.equal(REAL.total, FACTS.length)
  assert.equal(REAL.ok, true)
})

// ── ② 事实表本身的形状 ────────────────────────────────────────────────────
test('② 每条事实都有 id / what / source，且 id 唯一、真值来源写得出处', () => {
  const ids = FACTS.map((f) => f.id)
  assert.equal(new Set(ids).size, ids.length, `id 有重复：${ids.join(',')}`)
  for (const f of FACTS) {
    assert.ok(typeof f.id === 'string' && f.id !== '', '有事实缺 id')
    assert.ok(typeof f.what === 'string' && f.what.length > 6, `${f.id} 的 what 太短`)
    assert.ok(typeof f.source === 'string' && f.source.length > 6,
      `${f.id} 没有写 source——一个说不出真值出处的判据，就是一条谁都改得动的判据`)
    assert.ok(f.claim !== undefined || f.expect !== undefined,
      `${f.id} 既没有文档锚点也没有期望值`)
    assert.equal(typeof f.derive, 'function', `${f.id} 没有 derive`)
  }
})

// ── ③ 反面控制：每一条文档锚点事实，改掉它声称的东西它必须红 ────────────────
test('③ 反面控制：改动文档里那个声称，**那一条**必须红（逐条做）', () => {
  const claimFacts = FACTS.filter((f) => f.claim !== undefined)
  assert.ok(claimFacts.length >= 4, `带文档锚点的事实只有 ${claimFacts.length} 条，覆盖面太小`)

  for (const f of claimFacts) {
    const before = defaultContext().doc(f.claim.doc)
    const m = f.claim.re.exec(before)
    assert.ok(m !== null, `${f.id}：真实文档里居然找不到锚点，这条判据已经失效`)

    // ★ 两种锚点要两种改法。
    //   第一版我对**所有**锚点都做"把第一个数字 +1"，而枚举那条锚点里
    //   **一个数字都没有**（数的是 `/` 分隔的项）⇒ 改写是空操作，
    //   于是断言报的是"改写没生效"——**那是我的控制写坏了，不是判据坏了**。
    //   ⇒ 一个只会做一种破坏的控制，对另一种形状的锚点是**假**控制。
    let corrupted
    if (/\d/.test(m[0])) {
      // ★★ 第 54 轮订正：原来一律写 `+1`。这对 `equal` 够用，
      //   但对 `atLeast`（下限）**不必然**构成违反 ——
      //   实测：`handover-tracked-suites` 的真实值为 381、文档写 `≥ 380`，
      //   而 `+1` 恰好把 380 改成 **381** ⇒ `381 < 381` 为假 ⇒ **控制不红**。
      //   ⇒ 报出来的是「文档声称被改掉了它却没红」，而坏的是**控制**，不是判据。
      //
      //   > 一个按"声称值 +1"来造假的对照，
      //   > 在**真实值已经比声称值高**的那些天里，造出来的恰好是**真话**。
      //
      //   ⇒ 改成"**按真实值 +1** 造假"：它对两种关系都必然违反，
      //     而且它更强 —— 造假的目标从"改一个数"变成"说出一个已知为假的值"。
      let realValue = null
      try {
        const got = f.derive(defaultContext())
        if (typeof got === 'number' && Number.isFinite(got)) realValue = got
      } catch { /* 取不到就退回 +1 */ }
      const bump = (d) => String(realValue === null ? Number(d) + 1 : realValue + 1)
      corrupted = before.slice(0, m.index)
        + m[0].replace(/\d+/, bump)
        + before.slice(m.index + m[0].length)
    } else {
      // 结构性锚点：删掉最后一个 `/` 分隔项
      const inner = m[1]
      const newInner = inner.split('/').slice(0, -1).join('/')
      assert.notEqual(newInner, inner, `${f.id}：这段文字里没有可删的项，控制写不出来`)
      corrupted = before.slice(0, m.index)
        + m[0].replace(inner, () => newInner)
        + before.slice(m.index + m[0].length)
    }
    assert.notEqual(corrupted, before, `${f.id}：改写没生效，这条控制是假的`)

    // ★★★★★ 第 111 轮：这里原来是 `checkFacts({ ctx: ... })` —— 即**为了判一条事实红了没有，
    //   把全部 ~30 条都跑了一遍**。实测 `checkFacts()` 一次 ~5.4s、本循环 ~30 次 ⇒ **约 160 秒**，
    //   占该套件总时长（281s）的一半以上 ⇒ 而 `run-ci.mjs:130` 的硬上限是 **300 秒**。
    //
    //   > ★★★ 这条断言说的是「**那一条**必须红」。为了知道**一条**的判决而跑**全部**，
    //   > 是把"那一条"写成了"每一条" —— 而它换来的不是更强的检查，**是更长的墙钟**。
    //
    //   ⇒ 只跑这一条。★ 判据本身一个字没改（同一个 derive、同一个 claim、同一套红码）。
    const r = checkFacts({ ctx: withDoc(f.claim.doc, () => corrupted), only: [f.id] })
    assert.ok(idsOf(r).includes(f.id),
      `${f.id}：文档声称被改掉了它却没红（红的是 ${JSON.stringify(idsOf(r))}）`)
    const v = r.violations.find((x) => x.id === f.id)
    assert.equal(v.code, 'MISMATCH', `${f.id} 的红不是 MISMATCH 而是 ${v.code}`)
    assert.notEqual(v.actual, v.claimed, `${f.id}：报红但两侧相等，是假红`)
  }
})

// ── ④ 锚点消失控制：句子被删掉 ⇒ 红，**不是**静默通过 ─────────────────────
test('④ 锚点消失：把文档那句话删掉 ⇒ ANCHOR_MISSING（不许静默变绿）', () => {
  const f = FACTS.find((x) => x.id === 'patch-rows-doc-count')
  const before = defaultContext().doc(STATUS_DOC)
  const stripped = before.replace(/`PATCH_LAYER_ROWS`\s*只声明\s*\*\*\d+\*\*\s*行/, '（这句话被删掉了）')
  assert.notEqual(stripped, before, '删除没生效，这条控制是假的')

  const r = checkFacts({ ctx: withDoc(STATUS_DOC, () => stripped) })
  const v = r.violations.find((x) => x.id === f.id)
  assert.ok(v !== undefined, '锚点没了却没报红——这正是"判据静默失去检查对象"的形状')
  assert.equal(v.code, 'ANCHOR_MISSING')
  // ★ 被跳过的那条**不计入** checked：否则"跑了几条"这个读数会说谎
  assert.equal(r.checked, FACTS.length - 1)
})

// ── ④b 锚点歧义控制：同一句话出现两次 ⇒ ANCHOR_AMBIGUOUS ───────────────────
test('④b 锚点歧义：把句子复制成两处 ⇒ ANCHOR_AMBIGUOUS（不许靠"我是第一个匹配"）', () => {
  const f = FACTS.find((x) => x.id === 'patch-rows-doc-count')
  const before = defaultContext().doc(STATUS_DOC)
  const m = f.claim.re.exec(before)
  assert.ok(m !== null)
  // 把锚点句再抄一遍（模拟"订正说明里引用了旧值"那种真实情形）
  const doubled = before + '\n\n（另处引用：' + m[0] + '）\n'
  const r = checkFacts({ ctx: withDoc(STATUS_DOC, () => doubled) })
  const v = r.violations.find((x) => x.id === f.id)
  assert.ok(v !== undefined, '同一句话出现两次却没报红——那说明这个锚点在靠行序选数字')
  assert.equal(v.code, 'ANCHOR_AMBIGUOUS')
  assert.match(v.detail, /命中了 2 处/)
})

// ── ⑤ 载荷控制一：给执行面塞进控制面凭证 ⇒ 边界那条必须红 ──────────────────
test('⑤ 载荷：给 `runtime` 塞进 TEAM_HUB_TOKEN ⇒ 边界判据必须红', () => {
  const r = checkFacts({
    ctx: withSpec('runtime', (s) => ({ ...s, envNames: [...s.envNames, HUB_TOKEN_ENV] })),
  })
  assert.ok(idsOf(r).includes('runtime-env-excludes-hub-token'),
    `塞进了 ${HUB_TOKEN_ENV} 却没红——这条边界判据是装饰`)
  // ★ 而 worker 那条**仍然绿**：两条不是同一条断言
  assert.ok(!idsOf(r).includes('worker-env-includes-hub-token'),
    'worker 那条也被带红了 ⇒ 两条其实在测同一个东西')
})

test('⑤b 载荷：给 `runtime` 塞进 DSH_WORKBENCH_TOKEN ⇒ 另一条边界判据必须红', () => {
  const r = checkFacts({
    ctx: withSpec('runtime', (s) => ({ ...s, envNames: [...s.envNames, WORKBENCH_TOKEN_ENV] })),
  })
  assert.ok(idsOf(r).includes('runtime-env-excludes-workbench-token'))
})

// ── ⑥ 载荷控制二（对称的那一半）：拿掉 worker 的 token ⇒ 只有它红 ──────────
test('⑥ 载荷（对称）：拿掉 `orchestrator` 的 TEAM_HUB_TOKEN ⇒ 只有正面对照那条红', () => {
  const r = checkFacts({
    ctx: withSpec('orchestrator', (s) => ({
      ...s, envNames: s.envNames.filter((e) => e !== HUB_TOKEN_ENV),
    })),
  })
  assert.ok(idsOf(r).includes('worker-env-includes-hub-token'),
    '拿掉了 worker 的 token 却没红')
  assert.ok(!idsOf(r).includes('runtime-env-excludes-hub-token'),
    'runtime 那条也被带红了 ⇒ 一个"永远返回 false"的坏推导就能让两条同时通过/失败')
})

// ── ⑦ 枚举判据的载荷：从枚举里删掉一行名 ⇒ 必须红 ─────────────────────────
test('⑦ 载荷：把枚举句里的 `permission-presets` 删掉 ⇒ 点名判据必须红', () => {
  const f = FACTS.find((x) => x.id === 'patch-rows-doc-mentions-every-row-key')
  const r = checkFacts({
    ctx: withDoc(STATUS_DOC, (t) => t.replace(/\/\s*\*\*permission-presets\*\*/, '')),
  })
  const v = r.violations.find((x) => x.id === f.id)
  assert.ok(v !== undefined, '枚举里少了一行名却没红——那正是本模块起因里发生的事')
  assert.match(String(v.actual), /permission-presets/)
})

// ── ⑧ yml 数行器自身的判据（它不该把注释当行）─────────────────────────────
test('⑧ `patchYmlRepresentedRows` 只数真行、不数注释里的行名', () => {
  const sample = [
    '#     · legion-enforcement-pre-execute —— 模块存在，但需要一个进程内装好的组合根',
    '- insert:',
    '    - id: "a"',
    '    - id: "b"',
    '- id: "permission"',
  ].join('\n')
  const r = patchYmlRepresentedRows(sample)
  assert.deepEqual(r, { insertRows: 2, patchOverRows: 1, total: 3 })
})

test('⑧b 真实 yml：insert + patch-over 的分解与文档那句对得上', () => {
  const real = defaultContext().patchYml()
  assert.equal(real.insertRows + real.patchOverRows, real.total)
  assert.ok(real.total > 0, '真实 yml 一行都没数出来 ⇒ 数行器坏了，而不是文件空了')
})

// ── ⑨ 生成物不许复述任务状态（2026-09-18 实测到的一处真矛盾）──────────────
test('⑨ 载荷：往生成物里塞一句状态判断 ⇒ 必须红（含"引用那个词"的情形）', () => {
  const f = FACTS.find((x) => x.id === 'patch-yml-asserts-no-task-status')
  assert.ok(f !== undefined)
  // 先确认**今天**是干净的（否则这条控制测的是别的东西）
  assert.equal(checkFacts().violations.filter((v) => v.id === f.id).length, 0,
    '今天的生成物里已经有状态词了——先修它，再看这条控制')

  // ★ 两种载荷都要红：① 直接断言 ② **引用**那个词（我第一版就栽在②上）
  const payloads = [
    '\n#   （fail closed）。**PRT-214 因此仍是未完成状态**，而不是"装好了但没生效"。\n',
    '\n#   这句话原来写的是「PRT-214 因此仍是未完成状态」——后来改判了。\n',
  ]
  for (const [i, payload] of payloads.entries()) {
    const r = checkFacts({ ctx: withDoc(PATCH_YML, (t) => t + payload) })
    const v = r.violations.find((x) => x.id === f.id)
    assert.ok(v !== undefined, `载荷 ${i + 1}：塞进了状态词却没红 ⇒ 这条判据是装饰`)
    assert.equal(v.code, 'MISMATCH')
    assert.match(String(v.actual), /未完成/)
  }
})

test('⑨b 生成器与生成物**同步**（改了 render.mjs 就必须重新生成）', async () => {
  const { execFileSync } = await import('node:child_process')
  // `--check` 的语义就是"文档与声明/生成器是否一致"：exit 0 ⇒ 同步
  let code = 0
  try {
    execFileSync(process.execPath, ['runtime/dsh-composition/render.mjs', '--check'],
      { cwd: REPO, stdio: 'ignore' })
  } catch (err) {
    code = err.status ?? 1
  }
  assert.equal(code, 0, '`render.mjs --check` 不是 0 ⇒ 生成物与生成器漂了（跑 `render.mjs --write`）')
})

// ── ⑩ 类级扫描：普查的可执行形态 ──────────────────────────────────────────
test('⑩ 类级扫描：正整数对照——扫描面不许是空的', () => {
  const arts = defaultContext().generatedArtifacts()
  assert.ok(arts.length > 0,
    '一个自称生成物的文件都没扫到 ⇒ 扫描器坏了（不是"仓库里没有生成物"）。'
    + '★ 一个"扫了 0 个文件"的普查与一个"一个违规都没有"的普查，输出长得一样')
  // 至少要有运行期真正会生成的那个进面子里，否则扫描面跑偏了
  assert.ok(arts.some((a) => a.rel === PATCH_YML),
    `${PATCH_YML} 不在扫描面里 ⇒ 扫描器没覆盖到它该覆盖的东西`)
})

test('⑩b 载荷：让一个生成物说"某任务未完成" ⇒ 类级判据必须红', () => {
  const base = defaultContext()
  const poisoned = [
    ...base.generatedArtifacts(),
    { rel: 'FAKE-generated.md', offences: [{ word: '未完成', around: 'PRT-999 因此仍是未完成状态' }] },
  ]
  const r = checkFacts({ ctx: { ...base, generatedArtifacts: () => poisoned } })
  const v = r.violations.find((x) => x.id === 'no-generated-artifact-asserts-task-status')
  assert.ok(v !== undefined, '往扫描面里放了一个违规生成物却没红 ⇒ 这条类级判据是装饰')
  assert.match(String(v.actual), /FAKE-generated\.md/)
})

test('⑩c 载荷：生成物里只提任务号、**不作**状态判断 ⇒ 不许红（避免狼来了）', () => {
  const base = defaultContext()
  const benign = base.generatedArtifacts().map((a) => ({ ...a, offences: [] }))
  const r = checkFacts({ ctx: { ...base, generatedArtifacts: () => benign } })
  assert.ok(!idsOf(r).includes('no-generated-artifact-asserts-task-status'),
    '没有违规却报红 ⇒ 判据会成为狼来了，然后被人关掉')
})

// ── ⑪ 台账坐标：`file:line` 与提交哈希 ──────────────────────────────────────
//
// ★ 这一组存在的理由：这两条事实判的是"台账里的坐标还在不在实处"。
//   没有下面这些控制，它们就是**没人验过的谓词**——
//   而"一个恒绿的谓词"与"一个真的在查的谓词"，在 CI 摘要里都是 `✔`。

test('⑪a 正整数对照：真实台账里解析到的引用条数 > 0（扫描面不许是空的）', () => {
  const lc = defaultContext().lineCitations()
  const cc = defaultContext().commitCitations()
  assert.ok(lc.total > 50, `只解析到 ${lc.total} 条 file:line 引用 ⇒ 解析器跑偏了`)
  assert.ok(cc.total > 10, `只解析到 ${cc.total} 个提交哈希 ⇒ 解析器跑偏了`)
  assert.equal(lc.broken.length, 0, `有坏引用：${JSON.stringify(lc.broken)}`)
  assert.equal(cc.broken.length, 0, `有坏哈希：${JSON.stringify(cc.broken)}`)
})

test('⑪b 载荷：把一条引用的行号推到文件之外 ⇒ 该条事实必须红', () => {
  const ctx = withLedgerText((doc) => {
    // 取一条真实存在的引用，把行号改成一个绝不存在的大数
    const m = /(`[^`]*?\.mjs):(\d+)/.exec(doc)
    assert.ok(m !== null, '台账里没找到任何 `.mjs:行号` 引用 ⇒ 这个载具失效了')
    return doc.replace(m[0], `${m[1]}:999999`)
  })
  const r = checkFacts({ ctx })
  const v = r.violations.find((x) => x.id === 'ledger-line-citations-resolve')
  assert.ok(v !== undefined, '行号已超出文件范围却没红 ⇒ 这条判据没在查')
  assert.match(String(v.actual), /文件共 \d+ 行/)
})

test('⑪c 载荷：引用一个不存在的文件 ⇒ 该条事实必须红', () => {
  const ctx = withLedgerText((doc) => `${doc}\n见 \`no/such/dir/ghost-file-xyz.mjs:12\`。\n`)
  const r = checkFacts({ ctx })
  const v = r.violations.find((x) => x.id === 'ledger-line-citations-resolve')
  assert.ok(v !== undefined, '引用了一个不存在的文件却没红')
  assert.match(String(v.actual), /ghost-file-xyz/)
})

// ── ⑪j / ⑪k：两条**一直存在**的漏洞（2026-09-18 第 23 轮补）──────────────────
//
// 两条都不是"新功能没写"，而是**既有判据少查了一样东西**，而且两次
// 都表现为"这条判据是绿的，所以那些引用没问题"：
//
//   ⑪j  `LINE_CITATION_RE` 有 3 个捕获组，而代码读的是 `m[4]`（恒 undefined）
//        ⇒ **范围终点永远等于起点** ⇒ `file:9999-99999` 这类越界范围静默放过。
//   ⑪k  只查"行在不在"，不查"那一行是不是空的" ⇒ `tool-request.mjs:731`
//        （**空行**，真话在 780 行）在台账与状态文档里共存了 5 处而全绿。

test('⑪j ★★ 范围引用的**终点**真的在查：越界范围必须红（`m[4]`/`m[3]` off-by-one 的回归）', () => {
  // 正向：起点合法、**终点越界**。若终点被读成 undefined（= 起点），
  // 这条会静默通过 —— 那正是修复前的行为。
  const r = scanLineCitations('见 `runtime/dsh-composition/tool-request.mjs:10-999999`。')
  assert.ok(r.broken.some((b) => /999999|共 \d+ 行/.test(b)),
    `★ 范围终点越界却没红 —— 范围被当成单行了：${JSON.stringify(r.broken)}`)

  // 反向控制：**起点与终点都合法**的范围不许红。
  // ★ 没有它，上面那条可以用"凡范围必红"满足 —— 那是另一种坏（狼来了）。
  const ok = scanLineCitations('见 `runtime/dsh-composition/tool-request.mjs:10-20`。')
  assert.deepEqual(ok.broken, [], `合法范围被误报：${JSON.stringify(ok.broken)}`)

  // ★ 计数也要对：范围是**一条**引用，不是两条、也不是零条。
  assert.equal(ok.total, 1, `范围引用被数成了 ${ok.total} 条`)
  assert.equal(ok.checked, 1, `范围引用没有落到实处（checked=${ok.checked}）`)
})

test('⑪k ★★ 引用指到**空行/纯收尾符**必须红；指到真内容必须绿', () => {
  // 正向：找一个真的空行，引它。
  const src = readFileSync(resolve(REPO, 'runtime/dsh-composition/tool-request.mjs'), 'utf8').split('\n')
  const blankAt = src.findIndex((l) => l.trim() === '') + 1
  assert.ok(blankAt > 0, '这个文件里居然没有空行 ⇒ 载具失效')
  const r = scanLineCitations(`见 \`runtime/dsh-composition/tool-request.mjs:${blankAt}\`。`)
  assert.ok(r.broken.some((b) => /空的|收尾符/.test(b)),
    `★ 引用指向第 ${blankAt} 行（空行）却没红：${JSON.stringify(r.broken)}`)

  // 反向控制 ①：指到一行**有内容**的必须绿。
  const contentAt = src.findIndex((l) => l.trim().startsWith('function scopeGuard')) + 1
  assert.ok(contentAt > 0, '找不到 scopeGuard ⇒ 载具失效')
  const okc = scanLineCitations(`见 \`runtime/dsh-composition/tool-request.mjs:${contentAt}\`。`)
  assert.deepEqual(okc.broken, [],
    `指到真内容却被误报：${JSON.stringify(okc.broken)}`)

  // 反向控制 ②：**纯收尾符**那一类也要咬住（它比空行更常见：
  // `})` / `}` / `);` 这三种在真实文件里到处都是）。
  const braceAt = src.findIndex((l) => /^[)}\];,]+$/.test(l.trim())) + 1
  if (braceAt > 0) {
    const rb = scanLineCitations(`见 \`runtime/dsh-composition/tool-request.mjs:${braceAt}\`。`)
    assert.ok(rb.broken.some((b) => /收尾符|空的/.test(b)),
      `引用指向第 ${braceAt} 行（纯收尾符）却没红：${JSON.stringify(rb.broken)}`)
  }

  // ★ 反向控制 ③（这一条是防"判据变成狼来了"的关键）：
  //   **范围跨越一个空行**不许红 —— 只有"整段都是空/收尾符"才算坏。
  //   台账里 `run-floor.mjs:544-559` / `executor-binding.mjs:254-261`
  //   正是这种"起点是收尾符、后面有真内容"的形状；把它们误报成坏引用
  //   会让这条判据在真实台账上直接红，从而被人整体关掉。
  const spanning = scanLineCitations('见 `runtime/dsh-composition/tool-request.mjs:730-740`。')
  assert.deepEqual(spanning.broken, [],
    `跨空行的合法范围被误报（判据变成狼来了）：${JSON.stringify(spanning.broken)}`)
})

test('⑪d 锚点消失：台账里一条引用都解析不出来 ⇒ 必须红（不许静默变绿）', () => {
  const ctx = withLedgerText(() => '# 空台账，没有任何引用\n')
  const r = checkFacts({ ctx })
  const lv = r.violations.find((x) => x.id === 'ledger-line-citations-resolve')
  const cv = r.violations.find((x) => x.id === 'ledger-commit-citations-on-line')
  assert.ok(lv !== undefined, '解析到 0 条引用却没红 ⇒ 改了引用格式这条判据会静默失效')
  assert.match(String(lv.actual), /解析到 0 条/)
  assert.ok(cv !== undefined, '解析到 0 个哈希却没红')
  assert.match(String(cv.actual), /解析到 0 个/)
})

test('⑪e 载荷：一个不存在的提交哈希 ⇒ 该条事实必须红', () => {
  const ctx = withLedgerText((doc) => `${doc}\n已落地，见 \`deadbee\`。\n`)
  const r = checkFacts({ ctx })
  const v = r.violations.find((x) => x.id === 'ledger-commit-citations-on-line')
  assert.ok(v !== undefined, '一个不存在的哈希却没红')
  assert.match(String(v.actual), /deadbee/)
})

test('⑪f ★ 提交存在但**不在 HEAD 线上** ⇒ 必须红（这是另一种坏法）', () => {
  // ★ 直接用导出的扫描器并把 `head` 换成**一个很老的提交**：
  //   那样近期的提交就都不是它的祖先了，于是"不是祖先"这一支被真正走到。
  //   ——不在负数上做手脚，而是造出一个真实的"另一条线"。
  const base = defaultContext()
  const doc = base.doc(LEDGER_DOC)
  const head = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n')[0]
  const r = scanCommitCitations(doc, head)
  assert.ok(r.broken.length > 0,
    '把 head 换成了根提交，却没有任何哈希被判"不是祖先" ⇒ "NOT-ANCESTOR" 这一支从未被走到，'
    + '而一条只覆盖两种坏法里一种的判据会在另一种上恒绿')
  assert.ok(r.broken.some((b) => /不是 HEAD 的祖先/.test(b)),
    `红的原因不是"不是祖先"：${JSON.stringify(r.broken.slice(0, 3))}`)
})

test('⑪g ★ 纯数字串**不许**被当成提交哈希（判据键太宽的回归）', () => {
  // 台账里真实存在两处纯数字反引号串：`1234567890`（YAML 标量取值测试）
  // 与 `1000000100`（字节数 100 + 10 GB）。第一版正则把它们都当成了哈希。
  const fake = '见 `1234567890` 与 `1000000100` 两处纯数字。\n'
  const r = scanCommitCitations(fake, 'HEAD')
  assert.equal(r.total, 0,
    `纯数字串被当成了提交哈希（解析到 ${r.total} 个）⇒ `
    + '一个"引用的提交不存在"与一个"我把数字串当成了提交"会变得无法区分')
  // ★ 而真哈希必须**仍然**被抓到（否则这个"收紧"就把判据关掉了）
  const real = '见 `de89ff3`。\n'
  assert.equal(scanCommitCitations(real, 'HEAD').total, 1, '收紧之后真哈希反而抓不到了')
})

/**
 * ⑪h ★★ **DSH 检出不在**时，DSH 侧引用必须记 `external`，**不许**报成坏引用。
 *
 * 这是实测出来的：把 `DSH_CHECKOUT` 指到一个不存在的目录，第一版报出
 * **18 条"找不到这个文件"**——而那 18 条全是 `packages/…` / `apps/…` 的
 * DSH 侧引用，**一条都没坏**。
 *
 *   > 一个"引用坏了"与一个"我没法查"，在只有同一条红的时候长得一模一样
 *   > ——而前者要求我改文档，后者要求我改**判据**。
 *
 * ⇒ 用一个**合成的小树**来测（不碰真磁盘），把两种情形都钉住。
 *
 * ⚠️ 合成树里的**值必须是真实可读的绝对路径**：第一版我写成了相对名
 * （`legion-only.mjs`），于是 `readFileSync` 读不出来、判据报"读不出来"——
 * **测试红得对，但红的是我的替身而不是判据**。这与 ⑪b–⑪e 那次是同一个教训的第二次。
 */
function syntheticTree(files) {
  const byPath = new Map()
  const bySuffix = new Map()
  // 一律指向一个真实存在、行数足够的文件（用台账自己）
  const real = resolve(REPO, LEDGER_DOC)
  for (const f of files) {
    const key = f.toLowerCase()
    byPath.set(key, real)
    const parts = key.split('/')
    for (let i = parts.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
      const suf = parts.slice(i).join('/')
      if (!bySuffix.has(suf)) bySuffix.set(suf, [])
      bySuffix.get(suf).push(real)
    }
  }
  return { byPath, bySuffix }
}

test('⑪h DSH 检出不在 ⇒ DSH 侧引用记 external，**不算坏**（实测 18 条假红的回归）', () => {
  const text = '见 `packages/credentials/credentials-local/src/index.ts:585` 与 `legion-only.mjs:1`。\n'
  // DSH 侧文件在 Legion 索引里找不到，而 DSH 树不在 ⇒ 应记 external
  const noDsh = { legion: syntheticTree(['legion-only.mjs']), dsh: null }
  const a = scanLineCitations(text, noDsh)
  assert.equal(a.broken.length, 0,
    `DSH 不在时报了坏引用：${JSON.stringify(a.broken)} ⇒ `
    + '这会把"我没法查"渲染成"引用坏了"，然后每个没有 DSH 检出的环境都会假红')
  assert.ok(a.external.some((x) => x.includes('credentials-local')),
    `DSH 侧那条没被记成 external（external=${JSON.stringify(a.external)}）`)
  assert.equal(a.checked, 1, 'Legion 侧那条应当被判定')

  // ★ 反向：DSH 树**在**（且里面有那个文件）时，同一条引用必须能落到实处
  const withDsh = {
    legion: syntheticTree(['legion-only.mjs']),
    dsh: syntheticTree(['packages/credentials/credentials-local/src/index.ts']),
  }
  const b = scanLineCitations(text, withDsh)
  assert.equal(b.broken.length, 0, `DSH 在时反而报坏：${JSON.stringify(b.broken)}`)
  assert.equal(b.external.length, 0, 'DSH 在时不该有 external（应当已经判定过了）')
  assert.equal(b.checked, 2, `应当两条都判定，实际 ${b.checked}`)

  // ★★ 而"DSH 在"时真的找不到 ⇒ **必须**是坏引用（收紧不能把这一支关掉）
  const withDshButMissing = {
    legion: syntheticTree(['legion-only.mjs']),
    dsh: syntheticTree(['packages/other/thing.ts']),
  }
  const c = scanLineCitations(text, withDshButMissing)
  assert.equal(c.broken.length, 1,
    'DSH 在、文件却真的不在 ⇒ 应当判坏引用（否则这条判据在 DSH 在时恒绿）')
  assert.match(c.broken[0], /找不到这个文件/)
})

test('⑪i 覆盖面不许静默空掉：Legion 里一条都没落到实处 ⇒ 必须红', () => {
  // 引用解析得出来，但 Legion 索引是空的（模拟"索引坏了"）
  const text = '见 `legion-only.mjs:1`。\n'
  const emptyLegion = { legion: syntheticTree([]), dsh: null }
  const r = scanLineCitations(text, emptyLegion)
  assert.ok(r.broken.length > 0,
    '解析到引用、却一条都没落到实处，居然没红 ⇒ 索引坏掉时这一面会整个空掉，'
    + '而"空面"与"全绿"在输出里长得一样')
})

// ── ⑫ 手钉判据：那几行**逐字**就必须是那句话 ────────────────────────────────
//
// ★ 这一组的存在理由：上一批那两条坐标判据**结构上够不着**"在范围内但内容已经不是
//   那个东西了"这个形状。**实测**：另一会话把 `plugins/root-row.mjs:485-509`
//   订正成 `:508-536`，而那个文件有 **719 行**，旧区间稳稳在范围内。
//
// ★★ 而"内容锚"（拿旁边的标识符去猜）**已被我自己否掉**：
//   ① 103 条引用里只有 38 条（37%）取得到锚词；
//   ② 真例子里我打算拿 `installEnforcementRoot` 当锚，**它在旧区间内也有**
//      （`L488` 那句注释"在此之前 `installEnforcementRoot` 的入参里没有 `pathScope`"）
//      ⇒ **修复者解释这次位移的注释，正好把锚词种在了旧坐标上**，判据会在真漂移上变绿。
//   ⇒ 所以这里做**断言**，不做启发式。

test('⑫a 真实仓库：5 条手钉引用逐字都对，且一条都没被跳过', () => {
  const pc = defaultContext().pinnedCitations()
  assert.equal(pc.broken.length, 0, `有钉不住的：${JSON.stringify(pc.broken)}`)
  assert.equal(pc.checked + pc.external.length, pc.total,
    `核过 ${pc.checked} + 跳过 ${pc.external.length} ≠ 手钉 ${pc.total} 条 ⇒ 有被静默漏掉的`)
  assert.ok(pc.total >= 5, `手钉表只剩 ${pc.total} 条 ⇒ 这一层被清空了`)
})

test('⑫b ★★ 控制：把**历史上那次真实位移的旧坐标**钉上去 ⇒ 必须红', () => {
  // 真实事件（**三次**）：
  //   ① `plugins/root-row.mjs:485-509` → `:508-536`（另一会话 §9.5 接线后订正）。
  //   ② `:508-536` → `:534-562`（本会话 2026-09-18，第 19 条 §9.2 第 5 步：
  //      在同一个调用点**前**插入"连接器声明"那一块 +25 行，另在文件头 +1 行 import）。
  //   ③ `:534-562` → `:564-592`（本会话 2026-09-18 **第 19 轮**：在同一个调用点**前**
  //      插入 PRT-605 的"执行面授权表"那一块 +30 行 —— 连"读表并拦装配"那一整段
  //      带注释都插在它上面）。
  //   而那个文件有 790+ 行 ⇒ 旧区间**在范围内**，上一批那两条坐标判据**看不见**。
  //   这里用**真实文件、真实行**，只把行号换成位移前的旧值。
  //
  // ★ 第二、三次位移都是**判据自己顶出来的**：改完 `root-row.mjs` 之后
  //   这一条立刻红在载具断言上（"第 N 行不再是那个调用点"）。
  //   一个"手钉行号"的判据，在文件只增不改的时候，与一个"每次都重新数一遍"
  //   的判据，读数只差一个常数——只不过前者在常数变了的那天**会红**，
  //   而红本身就是它的价值。
  //
  //   ★★ 而"旧坐标"这个东西**每次都要重新指认**：第二次的旧坐标是 508，
  //      第三次的旧坐标就是**第二次认为正确的那一个（534）**。
  //      这一条控制因此有一个漂亮的性质——它**从不腐坏**：
  //      每次位移之后，新的旧坐标就是上一轮的正确答案。
  //
  //   ④ `:564-592` → `:591-619`（2026-09-18 **第 20 轮**：在同一个调用点**前**
  //      插入 PRT-606 的"外部 API 授权表"那一块 +27 行）。
  //      ★ 而**这一次载具自己是绿的**——因为这一轮插入的位置在 `564` **之上**，
  //      所以 `lines[563]` 恰好还是那一行调用……直到我把它插在上面之后它才不是。
  //      实测：这一条是先红在"第 564 行不再是那个调用点"，那正是它该做的事。
  //   ★★★ ⑤ `:591`（第 20 轮的正确答案）→ `:626`（2026-09-21 **第 112 轮**：
  //      在同一个调用点**前**插入 PRT-603 岗位白名单那一块 +35 行）。
  //      而这一节描述的"**从不腐坏**"性质再次成立：上一轮的正确答案（**591**）
  //      这一次成了新的旧坐标——下面那个 `injected` 钉的就是它。
  //
  //   > 一条"每次位移之后、上一轮的正确答案就变成新的旧坐标"的控制，
  //   > 与一条"把旧坐标写死成一个再也不会变的数"的控制，
  //   > 在**第一次**位移时都是红的——只不过前者的红**每次都还能复现**。
  //   ★★★ ⑥ `:626`（第 112 轮的正确答案）→ `:724`（2026-09-23 **第 118 轮第十一轮**：
  //      改动有两处，都在同一个调用点**前**——① `external-api-scope.mjs` 的协议白名单
  //      要读 `SPOOL_ENV_KEYS`，于是在本文件里新增了一张导出的键名表（+21 行）；
  //      ② 车道写入器的 `dataDir` 从**字面量成员访问**改成**下标**（+4 行），
  //      为的是让 `scripts/config` 那条"runtime 的读取全在下标里"的判据能看见它。
  //      ⇒ 这一节那句"上一轮的正确答案就变成新的旧坐标"第六次成立：
  //        下面那个 `injected` 钉的就是 **626**。
  //
  //   > 而这一次的位移**与这个调用点毫无关系**——它不是接线改动，
  //   > 是"别的地方要多读一个环境变量"。一个手钉行号的成本，
  //   > 就是**这个文件被任何理由改动过**的次数。
  //
  //   ★★★ ⑦ `:724`（第 118 轮第十一轮的正确答案）→ **`:754`**（2026-09-23
  //      **第 118 轮第十七 / 十九轮**：给 PRT-610 的车道补上 `dispatched` 那一条记录
  //      —— 本文件里 +1 行 import、`onDecision` 那一段 +20 行注释，
  //      另外在 `onReading` 上方把"同一个回调**三处**发射方"那张表写清楚（再 +7 行））。
  //      ⇒ "上一轮的正确答案变成新的旧坐标"第七次成立：下面那个 `injected` 钉的就是 **724**。
  //
  //   ★★★ **而这一次位移是这一节最该记的一笔**：`checkPinnedCitations` 的窗口是
  //      `CITE_SYMBOL_WINDOW = 25`（`scripts/prt/boundary-facts.mjs:1039`）。
  //      本轮这个文件被**同一个理由**改了两次：
  //        · 第一次下移 **23 行 ≤ 25** ⇒ **那条判据对这个真位移完全没有反应**；
  //        · 合计下移 **30 行 > 25** ⇒ 如果某处引文还写着 724，它**会**说话。
  //      ⇒ 窗口**以内**那一段是真实存在的盲区，而它恰恰是**日常施工**的幅度
  //        （加一个 import、写一段注释）。
  //
  //      > 一条窗口 ±25 行的判据，与一条"只在位移超过 25 行时才说话"的判据，
  //      > 是同一个东西 —— 而小于 25 行的位移，正是**每一轮**都会发生的那一种。
  const real = resolve(REPO, 'runtime/dsh-composition/plugins/root-row.mjs')
  const lines = readFileSync(real, 'utf8').split('\n')
  // 先核载具本身（载具坏了，下面的结论就不成立）
  assert.match(lines[753], /installEnforcementRoot\(\{/,
    '第 754 行不再是那个调用点 ⇒ 载具失效，先重写这个控制')
  assert.ok(!/installEnforcementRoot\(\{/.test(lines[625]),
    '第 626 行**又**是那个调用点了 ⇒ 旧坐标这一层失去对象，先重写这个控制')
  assert.ok(725 <= lines.length,
    '旧行号居然超范围了 ⇒ 那上一批的判据本来就能抓到，这一节的立论要改')

  // ★ 用**同一份**核法（不重抄逻辑）去钉旧坐标（= 上一轮的正确答案）
  const injected = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/plugins/root-row.mjs',
    line: 724,
    text: 'const installed = installEnforcementRoot({',
  })])
  const r = checkPinnedCitations(injected)
  assert.equal(r.broken.length, 1,
    `旧坐标居然没红（broken=${JSON.stringify(r.broken)}）⇒ `
    + '这条判据抓不到那次真实位移，这一层就是装饰')

  // ★★ 正面对照：同一份核法钉**位移后**的坐标 ⇒ 必须绿。
  //    少了这一条，"永远报红"的实现也能通过上面那个断言。
  const good = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/plugins/root-row.mjs',
    line: 754,
    text: 'const installed = installEnforcementRoot({',
  })])
  const g = checkPinnedCitations(good)
  assert.equal(g.broken.length, 0,
    `位移后的正确坐标反而报红：${JSON.stringify(g.broken)} ⇒ 这个控制只会一种结果，是假的`)
  assert.equal(g.checked, 1, '正面对照应当真的核到 1 条')
})

test('⑫c 控制：钉的内容差一个字符 ⇒ 必须红（逐字比对真的在逐字比）', () => {
  const real = resolve(REPO, 'runtime/dsh-composition/tool-request.mjs')
  const lines = readFileSync(real, 'utf8').split('\n')
  // ★ 2026-09-18 位移（**三次**）：先加 42 行（`connectorFeedback`）⇒ 639 → 681；
  //   再加 F-21 判定面那一层（`connectorJudgment` + `effectiveDecide`）⇒ 681 → 731；
  //   第 19 轮再加 PRT-605 的强制点（`executionGuard` + 参数 + **两处**调用）⇒ 731 → 763。
  //   三次都在这一行之上，三次都是**判据自己报出来的**（每次都是 ①/⑫a/⑫c 三红——
  //   `--only boundary` 那一阶段不含本套件，是 `test` 阶段抓到的）。
  //   坐标手钉，所以位移必须在这里改一次；这正是它存在的意义。
  //
  //   ★★ 三次之后值得写下的一句：漂的三次来自**三个不同的功能**，
  //      而它们都往同一个文件里插代码。⇒ 手钉坐标的成本随"这个文件被改过几次"
  //      增长，而不是随它的规模增长——这条判据红得越多，越说明它**不是**碰巧对上的。
  //
  //   ★★★ 第四次（2026-09-18 第 20 轮）：再加 PRT-606 的强制点
  //      （`externalApiGuard` + 参数 + **两处**调用）⇒ 763 → 780。
  //      ⇒ 四次位移、四个功能、同一个文件。上面那句"成本随改动次数增长"
  //        至此不再是一个推测：**它已经被四次独立的事件各验证了一遍。**
  //   ★★★ 第五次（2026-09-23 第 118 轮**第十轮**）：再加桥的**调用身份**校验
  //      （`argsKeyOf` + 复用 callId 的核对）⇒ 780 → **848**。
  //      ★★ 而这一次与前面四次**不一样**：前四次都是"给这个文件加一个新强制点"，
  //        这一次是**修一个放行方向的缺陷**——同一个 `callId` 的第二份请求
  //        曾经直接复用第一份的判决（见 `PRT-PROGRESS.md` 的 PRT-602 补记）。
  //        它钉的那句话（`if (pathScope === null) return undefined`）**一次都没改过**。
  //
  //   > 一个"只有加功能才会位移"的手钉坐标，与一个"任何理由改这个文件都会位移"的
  //   > 手钉坐标，在四次事件之后看起来是同一个东西——第五次把它分开了。
  const lineNow = lines[847].trim()
  assert.equal(lineNow, 'if (pathScope === null) return undefined', '第 848 行变了，先核它')

  // 差一个字符
  const off = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/tool-request.mjs',
    line: 848,
    text: 'if (pathScope === null) return undefined;', // 多个分号
  })])
  assert.equal(checkPinnedCitations(off).broken.length, 1,
    '只差一个字符却没事 ⇒ 逐字比对没在逐字比')

  // ★ 而**行尾空白**差异被 `trim()` 吸收（有意：CRLF/尾空格不该假红）——
  //   这是一条**写下来的**边界，不是意外。
  const trailing = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/tool-request.mjs',
    line: 848,
    text: 'if (pathScope === null) return undefined   ',
  })])
  assert.equal(checkPinnedCitations(trailing).broken.length, 0,
    '行尾空白造成了假红 ⇒ 会在 CRLF 检出上乱叫')
  // ⚠️ 已知边界：`trim()` 也吸收了**缩进**，所以缩进变化不会红。
  const indent = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/tool-request.mjs',
    line: 848,
    text: '        if (pathScope === null) return undefined',
  })])
  assert.equal(checkPinnedCitations(indent).broken.length, 0,
    '缩进居然红了 —— 如果哪天这里变成红，说明口径改了，这条注释要同步改')
})

test('⑫d 控制：手钉表被清空 ⇒ 必须红（不许变成"零条都通过"）', () => {
  const r = checkPinnedCitations(Object.freeze([]))
  assert.ok(r.broken.length > 0,
    '手钉表清空了却没红 ⇒ "一层被删掉"与"一层全绿"在输出里长得一样')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑬ 我方判据文件**不得冒充清单**（2026-09-18 实测事故的守卫）
// ══════════════════════════════════════════════════════════════════════════
//
// 事故本身：`boundary-facts.mjs` 的手钉表用了 `MANIFEST_PATTERNS` 认得的那种键名，
// 于是**一张记账表被可达性探针读成了清单**，把 4 个模块（其中
// `external-api-scope.mjs` **零个**生产 importer）报成"生产入口"。
// 而那条假消息的形状是**好消息**：它教人去删 READINGS、更新裁决、清基线 ⇒
// **把一个没接线的模块记成已接线**。
//
// ★ 这几条控制的意义不在于"再跑一遍真文件"（⑬a 就干那个），
//   而在于**证明这条判据会咬**——因为它的正常输出是"零条"，
//   而"零条"与"根本没扫"在输出上长得一模一样。

const IMP_DIR = 'scratch/_impersonate_probe'

function withImpFixture(files, fn) {
  const dir = resolve(REPO, IMP_DIR)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(resolve(dir, name), text, 'utf8')
    return fn(checkManifestImpersonation({ dir: IMP_DIR }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('⑬a 真文件：`scripts/prt/` 今天没有一处"冒充清单"', () => {
  const r = checkManifestImpersonation()
  assert.ok(r.scanned > 0, `扫了 ${r.scanned} 个文件 ⇒ 这条其实什么也没检查`)
  assert.deepEqual(r.bad, [],
    '★ 下面这些写法会被可达性探针读成"这个模块会被加载"：\n  ' + r.bad.join('\n  ')
    + '\n⇒ 描述形状时用**占位路径**，不要照抄带真路径的例子。'
    + '\n   一次实测：这行注释让 `external-api-scope.mjs`（零生产 importer）'
    + '\n   看起来"已接线"，而探针的红会教人去清基线、更新裁决。')
})

test('⑬b ★ 控制：写了 `清单键 + 真模块路径` ⇒ 必须红', () => {
  // ★★ 这个 fixture 的**源码本身**也在判据的扫描面里（判据读的是**文本**，不是 AST）。
  //   我第一版直接把那个形状写进了字符串字面量里 ⇒ **这条控制把真判据弄红了**
  //   （`① 真实仓库：全部通过` 跟着一起红）。**同一形状，本会话第三次**：
  //   前两次是 `wireChecked`（手钉文本）、`external-api-scope`（reachability 的说明注释）。
  //
  //   > 一个"我写下这个坏形状"与一个"我这个文件里有这个坏形状"，
  //   > 在只读文本的判据里是同一个东西——**而写控制的时候这两者必然同时成立。**
  //
  //   ⇒ 用拼接把形状拆开：源码里就不出现它，而运行时落到 fixture 里的还是它。
  const KEY = 'path'
  const MOD = 'runtime/dsh-composition/path-scope.mjs'
  withImpFixture({
    'fake.mjs': [
      '// 下面这个形状会被探针读成清单声明',
      `const t = { ${KEY}: '${MOD}' }`,
      '',
    ].join('\n'),
  }, (r) => {
    assert.equal(r.bad.length, 1, `期望命中 1 处，实际 ${r.bad.length}：${r.bad.join(' | ')}`)
    assert.match(r.bad[0], /fake\.mjs:2/, `行号不对：${r.bad[0]}`)
    assert.match(r.bad[0], /path-scope\.mjs/)
  })
})

test('⑬c ★ 控制：占位路径（不是一个真模块）⇒ 不许红', () => {
  withImpFixture({
    // ★ 这正是"描述形状而不照抄"的写法：键名还在，但引号里不是仓库里的模块
    'ok.mjs': [
      '// 那种形状长这样（用占位，不照抄真路径）',
      "//   path: '<某个 .mjs 仓库路径>'",
      '',
    ].join('\n'),
  }, (r) => {
    assert.deepEqual(r.bad, [],
      '占位路径被误报了 ⇒ 这条判据会把"正确地描述形状"也判红，'
      + '而一条**红在正确地方**的判据比没有更坏：它会教人删掉那句说明。')
  })
})

test('⑬d ★ 控制：改成 `entry.path` 的说法（没有 冒号+引号 的形状）⇒ 不许红', () => {
  withImpFixture({
    'prose.mjs': [
      '// `process-manifest.mjs` 的 `entry.path` 是**仓库相对**的写法',
      '// 例：`product/orchestrator/worker.mjs` 就是这样被加载的',
      '',
    ].join('\n'),
  }, (r) => {
    assert.deepEqual(r.bad, [],
      '单纯提到路径、没有清单形状，也被误报了 ⇒ 判据的键太宽'
      + '（本会话已因此栽过五次，每一次都是"把自己的噪声报成别人的缺陷"）')
  })
})

test('⑬e 控制：扫描面为空 ⇒ `scanned` 必须是 0（不许假装"没问题"）', () => {
  const r = checkManifestImpersonation({ dir: 'scratch/_definitely_not_here' })
  assert.equal(r.scanned, 0, '目录不存在时 scanned 应该是 0，而不是悄悄报"全绿"')
  assert.deepEqual(r.bad, [])
})

// ── ⑭ E 组：交接报告 §二 那张自称"机器读数，可复跑"的表（第 26 轮）────────────
test('⑭a 五条新事实都真的参与了比对（不许有一条静默不查）', () => {
  const ids = ['handover-ledger-tallies', 'handover-tracked-suites',
    'handover-unreachable-total', 'handover-doc-ratchet', 'handover-ci-prose-matches-table']
  for (const id of ids) {
    const f = FACTS.find((x) => x.id === id)
    assert.ok(f !== undefined, `事实表里没有 ${id}`)
    assert.ok(!idsOf(REAL).includes(id), `真实仓库上 ${id} 红了：`
      + JSON.stringify(REAL.violations.find((v) => v.id === id)))
  }
})

test('⑭b ★★ 回归：台账状态**不许**按固定下标取（我第一版写死 `cells[2]`）', () => {
  // 真实台账：145 = 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜
  // ★ 2026-09-20：`PRT-316` 由 ⬜ 转 🟡（切片 1 落地）。
  //   ★★★ 第 44 轮更正：这里**曾经**断言 `{ total: 144, ... }` 并附一句
  //   "`total` **不含 🟡**，所以它减 1 而不是不变——而这正是本用例该钉住的东西"。
  //
  //   那句话把**解析器的缺陷**写成了**用例要钉住的规格**：
  //   `tallyLedger` 只认 `✅|⏸|⬜`，认不出 🟡 就 `continue` ⇒ 少算一条。
  //   而它少算出来的 144 **正好**是 `derive` 给出的值——
  //   报告里只要写「144 行」，`handover-ledger-tallies` 就**判绿**。
  //
  //   > 把"它今天算出什么"写进断言，与"它应该算出什么"写进断言，
  //   > 在一个**恒等**的实现下是同一个东西——
  //   > 只不过前者会把缺陷锁死，还会给它配一句听起来很懂行的解释。
  //
  //   ⇒ 现在 🟡 计入 `partial`，总数回到 145（与台账合计行
  //   「140 / **1** / 0 / 4 / **145**」逐字对齐）。
  //
  // ★★★ 2026-09-21 第 113 轮：`PRT-316` 由 🟡 转 **✅**（`2967119`，08:43:35）
  //   ⇒ 真值变成 `{ total:145, done:141, partial:0, paused:4, todo:0 }`。
  //   ★ 这一行与 `ledger-evidence.test.mjs` ⑩、以及交付物里那几处**现行分档抄写**
  //     是**同一根因的四个受害者**：台账动了，而**四处**期望都没跟着动。
  //
  //   > 一个数被抄在四处、而只有一处有判据，与"这个数只有一个所有者"，
  //   > 在台账不动的时候是同一个东西——
  //   > 只不过前者会在台账动的那一天**同时**红在四个看起来无关的地方。
  const real = tallyLedger(defaultContext().doc(LEDGER_DOC))
  assert.deepEqual(real, { total: 145, done: 141, partial: 0, paused: 4, todo: 0 },
    `真实台账实算 ${JSON.stringify(real)}，与 145/141/0/4/0 不符`)

  // ★ 反向控制：状态列**不在**第 3 格时也必须数得对。
  //   写死 `cells[2]` 的版本在这种表上会数出别的分布——
  //   而"下标差一位"与"台账真的有几条没做完"在报告里长得一模一样。
  const shifted = [
    '| 任务 | 状态 | 证据 |',
    '| --- | --- | --- |',
    '| PRT-001 甲 | ✅ | `a.md` |',
    '| PRT-002 乙 | ⏸ | `b.md` |',
    '| PRT-003 丙 | ⬜ | `c.md` |',
  ].join('\n')
  assert.deepEqual(tallyLedger(shifted),
    { total: 3, done: 1, partial: 0, paused: 1, todo: 1 },
    '状态不在固定下标上时数错了 ⇒ 解析器靠的是位置而不是标记')

  // ★ 四档**分开**数：把 ⏸ 折进 ✅（或反之）会让"4 条暂停"读成"都完成了"
  const allDone = shifted.replace('⏸', '✅').replace('⬜', '✅')
  assert.deepEqual(tallyLedger(allDone), { total: 3, done: 3, partial: 0, paused: 0, todo: 0 })
})

test('⑭b-2 ★★★ 认不出的状态标记必须**抛**，不许静默少算一条', () => {
  // ★★ 这一条钉的是第 44 轮那个真缺陷的**根**，不只是它的一个数值结果。
  //
  //   旧实现的最后一道防线是 `if (st === undefined) continue` ——
  //   一个"不认识就跳过"的默认动作。它让 `PRT-316` 那一条**从总数里消失**，
  //   而消失之后算出来的 144 看起来完全正常（✔ 与"台账刚好 144 条"同形）。
  //
  //   ⇒ 现在改成抛。断言分两半：**认不出的要抛**、**认得的一个都不许丢**。
  //
  //   ★★★ 第 46 轮：抛的**措辞**改了 —— 因为"认不出"这件事现在由**所有者**
  //   （`ledgerTaskRow`）判定并抛出，本函数只负责加上行号。
  //   ⇒ 正则跟着改成所有者那句话。这一步值得留一句：
  //
  //     > 一个钉住**错误措辞**的断言，会在"把判定权交给所有者"的那一刻变红——
  //     > 而它红的原因不是"行为坏了"，是"说话的人换了"。
  //     > 这类红必须**改断言**（而不是把措辞改回去），
  //     > 否则等于要求每个消费者都复述所有者的原话。
  const withUnknown = [
    '| 任务 | 状态 | 证据 |',
    '| --- | --- | --- |',
    '| PRT-001 甲 | ✅ | `a.md` |',
    '| PRT-002 乙 | 🚧 | `b.md` |',
  ].join('\n')
  assert.throws(() => tallyLedger(withUnknown), /状态格不是已知标记/,
    '一个不认识的状态标记被静默跳过了 ⇒ 那个数会随每个新状态安静地少一条')
  // ★ 而且报出来的必须是**台账里的行号**（否则在 1000+ 行的台账里等于没报）。
  assert.throws(() => tallyLedger(withUnknown), /台账第 4 行/,
    '抛了但没带行号 ⇒ 在真台账里定位不到是哪一行')

  // ★ 反向控制：**四档都认得**，而且四档**互不吞并**。
  const allFour = [
    '| 任务 | 状态 | 证据 |',
    '| --- | --- | --- |',
    '| PRT-001 甲 | ✅ | `a.md` |',
    '| PRT-002 乙 | 🟡 | `b.md` |',
    '| PRT-003 丙 | ⏸ | `c.md` |',
    '| PRT-004 丁 | ⬜ | `d.md` |',
  ].join('\n')
  assert.deepEqual(tallyLedger(allFour),
    { total: 4, done: 1, partial: 1, paused: 1, todo: 1 },
    '四档必须各自计一，且 total 等于行数')

  // ★ 真实台账：**行数**与 `total` 必须相等（不允许有任何一条被跳过）。
  const text = defaultContext().doc(LEDGER_DOC)
  const rows = text.split(/\r?\n/).filter((l) => /^\|\s*PRT-\d+/.test(l)).length
  assert.equal(tallyLedger(text).total, rows,
    `台账里 ${rows} 个 \`| PRT-\` 行，但只数出 ${tallyLedger(text).total} 条`)
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 46 轮：`tallyLedger` 是**第二个所有者**吗？
//
// 第 45 轮只收敛了"有哪些标记"；行怎么认、标记归哪一档仍是本地手写的。
// 实测出两处会走偏的地方（`scripts/probes/_probe-tally-owner.mjs`）：
//
//   ① **接受规则比所有者宽**：`✅🟡` / `✅（待复核）` / `⏸→🟡` 三种格子，
//      `ledgerTaskRow` **抛**，`tallyLedger` **照收**（判成 done/paused）
//      ⇒ 两个"台账解析器"对**同一行**给出不同读数。
//   ② **分档是四个手写 `if`**：词表加第 5 个标记 ⇒ `total` 照加、
//      四档谁都不动 ⇒ `total` 与「四档之和」**悄悄不再相等**。
//
// 修法不是"再加两条断言"，而是**把判定权交回所有者**、
// 并把 `tallyKey`（归哪一档）也放进所有者那张表。
// ══════════════════════════════════════════════════════════════════════════

test('⑯c ★★★ `tallyLedger` 与所有者**对同一行同判**（接受规则不许比所有者宽）', () => {
  // ★ 这四种格子，所有者今天全**抛**（状态格必须整格等于一个已知标记）。
  //   旧 `tallyLedger` 用 `startsWith` 扫，于是前三种它**照收**。
  const JUNK = [
    ['| PRT-006 己 | ✅🟡 | `f.md` |', '状态格是两个标记'],
    ['| PRT-008 辛 | ✅（待复核） | `h.md` |', '状态格带后缀'],
    ['| PRT-009 壬 | ⏸→🟡 | `i.md` |', '箭头写法'],
  ]
  for (const [row, label] of JUNK) {
    // 所有者抛 ⇒ 消费者也必须抛（不能自己判成某一档）
    assert.throws(() => ledgerTaskRow(row), /状态格不是已知标记/,
      `所有者竟认下了「${label}」——控制写错了`)
    assert.throws(() => tallyLedger(['| 任务 | 状态 |', '| --- | --- |', row, ''].join('\n')),
      /状态格不是已知标记/,
      `「${label}」：所有者抛而 \`tallyLedger\` 收下了 ⇒ 两个解析器对同一行读数不同`)
  }
  // ★ 反向控制：**合法**的行两边都必须收（否则上面那三条可能只是"它什么都抛"）。
  const ok = '| PRT-007 庚 |  ⏸  | `g.md` |'
  assert.equal(ledgerTaskRow(ok)?.status, '⏸', '控制失效：合法行没被认下')
  assert.equal(tallyLedger(['| 任务 | 状态 |', '| --- | --- |', ok, ''].join('\n')).paused, 1,
    '合法行带空格时没归到 ⏸ 档')
})

test('⑯d ★★★ 词表加第 5 个标记 ⇒ 各档**必须**跟着加（`tallyKey` 派生）', () => {
  // ★★ 为什么必须**注入**一张词表才验得出来：
  //   在**今天**这张四标记词表上，"分档派生"与"四个手写 if"的返回值**完全一样**，
  //   任何只比结果的断言都分不开它们。
  //   ⇒ 注入一张多一个标记的表 —— 这正是第 42/43/45 轮三次用过的同一条出路。
  const SYNTH = ['| 任务 | 状态 |', '| --- | --- |',
    '| PRT-001 甲 | ✅ | `a.md` |',
    '| PRT-002 乙 | 🟡 | `b.md` |',
    '| PRT-003 丙 | ⏸ | `c.md` |',
    '| PRT-004 丁 | ⬜ | `d.md` |',
    '| PRT-005 戊 | 🔵 | `e.md` |'].join('\n')

  // ① 今天这张词表**不认识** 🔵 ⇒ 必须抛（不是少算一条）。
  assert.throws(() => tallyLedger(SYNTH), /状态格不是已知标记/,
    '🔵 不在词表里却被收下了 ⇒ 又是"认不出就跳过"')

  // ② 把 🔵 **加进词表**（并给它一个档）⇒ 5 条行必须全部有归属。
  const withFifth = [...STATUS_MARKS, { mark: '🔵', label: '第五档', tallyKey: 'fifth' }]
  const r = tallyLedger(SYNTH, { marks: withFifth })
  assert.equal(r.total, 5, '加了第 5 档之后 total 不是 5')
  assert.equal(r.fifth, 1, '★ 第 5 档收到了 0 条 ⇒ 分档不是派生的（漏了一档也照样返回）')
  const sum = withFifth.reduce((a, m) => a + r[m.tallyKey], 0)
  assert.equal(sum, r.total, `total=${r.total} 而各档之和=${sum} ⇒ 有行落进了没人接住的档`)

  // ③ 反面控制：**档名撞车**必须被抓到（两条状态共用一个 tallyKey ⇒ 重复计数）。
  const collision = [...STATUS_MARKS, { mark: '🔵', label: '撞名', tallyKey: 'done' }]
  assert.throws(() => tallyLedger(SYNTH, { marks: collision }), /不平衡/,
    '两条状态共用一个档名 ⇒ 该档被重复计数，而 total 对不上时**必须**抛')
})

test('⑯e ★★ `canonicalJson`：键序无关（这条事实不许再依赖对象的插入顺序）', () => {
  // ★★★ 起因是一次**我自己制造**的报红：`tallyLedger` 改成按词表顺序建键之后，
  //   `handover-ledger-tallies` 报「文档说 {"total":145,...}，产物是
  //   {"total":145,"done":140,"partial":1,"todo":0,...}」—— 而**五个数一个都没变**。
  //
  //   > 一次"数字全对但键的次序不同"的报红，
  //   > 与一次"数字真的错了"的报红，在输出里只差几个字符的位置。
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }),
    '同一组值、不同插入顺序给出了不同的串 ⇒ 这条事实仍然依赖键序')
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  // ★ 反面控制：**值**不同必须仍能分开（否则规范化把内容也抹平了）。
  assert.notEqual(canonicalJson({ a: 1, b: 2 }), canonicalJson({ a: 1, b: 3 }))
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 1, b: 0 }),
    '多一个键却给出同一个串 ⇒ 规范化把结构性差异抹平了')
})

test('⑭c 载荷：台账里少一个 ✅ ⇒ 那条事实必须红（钳住"三个数都要核"）', () => {
  const r = checkFacts({
    ctx: withLedgerText((t) => {
      // 只在**第一处**把 ✅ 改成 ⏸（模拟"有一行状态被改错"）
      const i = t.indexOf('| ✅ |')
      assert.notEqual(i, -1, '台账里找不到 `| ✅ |`，控制写不出来')
      return t.slice(0, i) + '| ⏸ |' + t.slice(i + '| ✅ |'.length)
    }),
  })
  assert.ok(idsOf(r).includes('handover-ledger-tallies'),
    `把一条 ✅ 改成 ⏸ 之后没红（红的是 ${JSON.stringify(idsOf(r))}）⇒ 这条只核了总数`)
})

test('⑭d ★★ 双向控制：改**表里**那个毫秒数也必须红（不只查"散文被改"）', () => {
  // 测试 ③ 只改**声称**（散文那侧）。若这条事实的 derive 也来自同一句话，
  // 它就恒等地绿 —— 那是一个**看着像判据的同义反复**。
  // 所以这里改**表里**那一行，散文一个字不动。
  //
  // ★★ 第一版这条**写死了 825/826**，而第 26 轮收官时交付 HEAD 换成
  //    第 26 轮那次 CI（868769ms ⇒ 869s）——于是这条控制自己红了。
  //    那不是判据坏了，是**控制把当时的读数抄进了断言**：
  //    > 一条把当前读数写进断言的测试，会在读数**正常更新**时红，
  //    > 而那与"判据坏了"是同一条红。
  //    ⇒ 改成从真文档现算，读数怎么变这条都成立。
  const before = defaultContext().doc(HANDOVER_DOC)
  const m = /全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` (\d+)ms/.exec(before)
  assert.ok(m !== null, '真文档里找不到"交付 HEAD"那一行，控制写不出来')
  const realSec = Math.round(Number(m[1]) / 1000)

  const corrupted = before.replace(/(全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` )(\d+)(ms)/,
    (_, a, ms, c) => a + (Number(ms) + 1000) + c)
  assert.notEqual(corrupted, before, '改表那一行没生效，这条控制是假的')

  const r = checkFacts({ ctx: withDoc(HANDOVER_DOC, () => corrupted) })
  const v = r.violations.find((x) => x.id === 'handover-ci-prose-matches-table')
  assert.ok(v !== undefined,
    '改了表里的毫秒数却没红 ⇒ derive 与 claim 同源（同义反复），这条判据没有信息量')
  assert.equal(v.code, 'MISMATCH')
  assert.equal(v.claimed, realSec, `声称侧应当是散文里的 ${realSec}`)
  assert.equal(v.actual, realSec + 1, `实际侧应当是表里加 1000ms 后取整的 ${realSec + 1}`)
})

test('⑭e ★★ 反向控制：把两处**一起**改成同一个新值 ⇒ 必须绿（证明它在比对，不是在钉常量）', () => {
  // ★ 第一版这条是**退化**的：散文本来就已经是那个值，所以"改成那个值"是个空操作，
  //   测试通过得毫无信息量——它证明不了这条判据在比对两侧。
  //   ⇒ 正确做法是：把**表和散文一起**改成一个**新**值，仍然必须绿。
  //      如果判据是"钉住某个常量"，这里就会红。
  const before = defaultContext().doc(HANDOVER_DOC)
  const both = before
    .replace(/(全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` )(\d+)(ms)/, (_, a, _ms, c) => `${a}777000${c}`)
    .replace(/`test` 阶段那 \d+ 秒里/, '`test` 阶段那 777 秒里')
  assert.notEqual(both, before, '改写没生效，这条控制是假的')
  assert.match(both, /`test` 777000ms/, '表那一行没被改到 777000')

  const r = checkFacts({ ctx: withDoc(HANDOVER_DOC, () => both) })
  const v = r.violations.find((x) => x.id === 'handover-ci-prose-matches-table')
  assert.equal(v, undefined,
    '两侧一起改成一致的新值却红了 ⇒ 这条判据钉的是常量而不是"两侧相等"：'
    + JSON.stringify(v))
})

test('⑭e2 反向控制：只改**散文**（表不动）⇒ 必须红', () => {
  const before = defaultContext().doc(HANDOVER_DOC)
  const m = /全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` (\d+)ms/.exec(before)
  const realSec = Math.round(Number(m[1]) / 1000)
  // ★ 不许写死一个"看起来不一样"的数：用 realSec 现算，
  //   否则真读数哪天正好等于那个写死的数，这条控制会**静默退化**成空操作。
  const other = realSec + 1
  const proseOnly = before.replace(/`test` 阶段那 \d+ 秒里/, `\`test\` 阶段那 ${other} 秒里`)
  assert.notEqual(proseOnly, before, '改写没生效，这条控制是假的')
  const r = checkFacts({ ctx: withDoc(HANDOVER_DOC, () => proseOnly) })
  const v = r.violations.find((x) => x.id === 'handover-ci-prose-matches-table')
  assert.ok(v !== undefined, '只改散文那一侧却没红 ⇒ 这一侧没被查')
  assert.equal(v.actual, realSec)
  assert.equal(v.claimed, other)
})

test('⑭f 取整规则钉在 round 上：`realSec*1000 - 1` 必须仍算作 realSec（floor 会差 1 秒）', () => {
  // 这条钉住"怎么从毫秒得到秒"。秒 = round(毫秒/1000)。
  // 取一个 round 与 floor **不同**的毫秒数：realSec*1000 - 1。
  //   round((realSec*1000 - 1)/1000) = realSec   ← 实现是 round ⇒ 绿
  //   floor(同上)                    = realSec-1 ← 实现改成 floor ⇒ 红
  // ★ 这样"round vs floor"这个 1 秒的缝隙才真的被测到；
  //   否则它藏在读数里，谁也看不出来。
  const before = defaultContext().doc(HANDOVER_DOC)
  const m = /全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` (\d+)ms/.exec(before)
  const realSec = Math.round(Number(m[1]) / 1000)
  const edge = realSec * 1000 - 1
  const patched = before.replace(/(全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` )\d+(ms)/, `$1${edge}$2`)
  assert.notEqual(patched, before, '改写没生效，这条控制是假的')
  assert.ok(Math.round(edge / 1000) === realSec && Math.floor(edge / 1000) !== realSec,
    `取的 ${edge}ms 没能把 round 与 floor 分开，这条控制是无效的`)

  const r = checkFacts({ ctx: withDoc(HANDOVER_DOC, () => patched) })
  const v = r.violations.find((x) => x.id === 'handover-ci-prose-matches-table')
  assert.equal(v, undefined,
    `${edge}ms 应当取整成 ${realSec}（与散文一致）；红了说明实现用的是 floor：` + JSON.stringify(v))
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 45 轮：生成物那两条判据的词表**只有一份**，且它 **⊇** 台账词表
//
// 起因：同一个模块里两条判据各用一份**互不相等**的表，而给它们背书的普查
// 用的是**第三份**（并集）：
//
//   判据 A（文件级，只钉 patch.yml）  `未完成|已完成|✅|🟡|⏸|⬜`   6 项
//   判据 B（类级，全部自称生成物）    `STATUS_VOCAB`                5 项
//   普查（"只有 1 个实例"的来源）     并集                          9 项
//
//   ⇒ 判据 A 漏 3 个散文写法；判据 B 漏**四个标记全部**。
//   实测今天两边读数都是 0（`scripts/probes/_probe-generated-status-vocab.mjs`），
//   差异**只存在于理论上** —— 而这正是最该修的时候。
//
//     > 一次用**更大的网**做的普查，与一条用**更小的网**执行的判据，
//     > 在"结论是 0 违规"的时候是同一个读数——
//     > 只不过前者证明的是一件**更强**的事，而后者才是每天在跑的那一条。
// ══════════════════════════════════════════════════════════════════════════

test('⑯ ★★★ 生成物词表 **⊇** 台账词表：一份表，两条判据共用', () => {
  // ★ 核心（**包含**关系，而不是"结果相等"）：
  //   一个只认散文写法、不认标记的表，与一个**正确**的表，
  //   在"今天没有生成物写标记"的仓库上读数**完全一样**。
  for (const m of LEDGER_STATUS_MARKS) {
    assert.ok(GENERATED_STATUS_VOCAB.includes(m),
      `生成物词表漏了台账标记 ${m} —— 那么"生成物里出现 ${m}"这一条今天不会被任何判据看见`)
  }
  // ★ 散文写法也得在（它们是"同一个状态的另一种写法"）。
  for (const w of ['未完成', '已完成', '待完成', '未开始', '部分完成']) {
    assert.ok(GENERATED_STATUS_VOCAB.includes(w), `生成物词表漏了散文写法「${w}」`)
  }
  // ★ 派生量不许是空集/残缺（一条"什么都没查"的判据永远是绿的）。
  assert.ok(GENERATED_STATUS_VOCAB.length >= 9,
    `词表只有 ${GENERATED_STATUS_VOCAB.length} 项，比并集小 ⇒ 有人又抄了一份子集`)

  // ★ 正则与数组同源：词表里每一个，正则都必须认。
  for (const w of GENERATED_STATUS_VOCAB) {
    assert.equal(GENERATED_STATUS_RE.test(w), true, `正则认不出词表成员「${w}」`)
  }
  // ★ 反面控制：不在词表里的不许认（否则这条正则在验"它认得一切"）。
  assert.equal(GENERATED_STATUS_RE.test('进行中'), false)
  assert.equal(GENERATED_STATUS_RE.test('🔵'), false)
})

test('⑯b ★★ 真仓库：生成物里今天**没有任何**状态词（并集口径）', () => {
  // ★ 这条对着**真文件**跑一次并集口径。它红了有两种可能：
  //   ① 真的有一处生成物复述了状态（那正是这两条判据存在的理由）；
  //   ② 判据的词表比并集窄了（那就是本轮修掉的那个形状又回来了）。
  //   两种都必须有人看一眼，所以不给它留"静默变绿"的余地。
  const r = checkFacts({ ctx: defaultContext() })
  const cls = r.violations.find((x) => x.id === 'no-generated-artifact-asserts-task-status')
  assert.equal(cls, undefined, '生成物里出现了状态词：' + JSON.stringify(cls))
  const one = r.violations.find((x) => x.id === 'patch-yml-asserts-no-task-status')
  assert.equal(one, undefined, 'patch.yml 里出现了状态词：' + JSON.stringify(one))
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 51 轮：给**人工介入清单**加上它此前一条都没有的判据
//
// 量出来的事实：`git grep -l PRT-HUMAN-INTERVENTION -- '*.mjs'` **零命中** ——
// 而它是这批产物里**唯一一份写给人照做**的文档。
//
//   > 一份**要人照着做**的清单，如果它自己没有人核，
//   > 那它错的时候只有**读它的人**会发现 ——
//   > 而那个人正是**因为不知道答案才来读它**的。
//
// ★ 而它**已经错了**：那句"十一个套件合计 201 通过"是第 48 轮写的，
//   第 49 轮加了 `reachability`（+13 例）后没人改（真值 214）；
//   同一块的标题还写"第 45～47 轮结束时的读数"，而家族表已到第 50 轮。
// ══════════════════════════════════════════════════════════════════════════

test('⑰ ★★★ 真仓库：人工介入清单的读数块**新鲜**（标题轮次 = 家族表最大轮次）', () => {
  const r = checkFacts({ ctx: defaultContext() })
  const v = r.violations.find((x) => x.id === 'intervention-readings-round')
  assert.equal(v, undefined,
    '★ 人工介入清单的读数块与家族表脱节：' + JSON.stringify(v)
    + '\n  一块**自称某个轮次**的读数，与一块**真的**属于那个轮次的读数，'
    + '\n  在一页文档里长得一样；而它上面那张表每一轮都会长一行，'
    + '\n  读数块却没有任何东西催它跟上 —— 直到有人读它。')
  // ★ 反向控制：把标题的轮次改小 ⇒ 必须红（证明上面那条不是恒绿）
  //
  // ★★ 而第一版的标题写的是**区间**（`第 45～50 轮`），本套件的**通用反面控制**
  //    （把锚点里第一个数字 +1）只改到左端 ⇒ **判据不红**。
  //    ⇒ 标题改成只写一个数，锚点与派生量才对得上。
  //      这个"只钉住一端"的洞是**通用控制**翻出来的，不是我读出来的。
  const text = defaultContext().doc(INTERVENTION_DOC)
  // ★★ 锚点必须与判据**同一处**：这份文档有**两块**"第 N 轮结束时的读数"
  //    （第 43 轮那块是历史快照）。第一版这里只写 `第 (\d+) 轮结束时的读数`
  //    ⇒ `String.replace` 改的是**第一处**（第 43 轮那块），
  //    而判据看的是**带 `（全部可复跑）` 后缀**的那块 ⇒ 判据不红，
  //    报的是"把标题的轮次改小却没红"。
  //
  //    > 一条"改了一处、断言另一处"的控制，报出来的错是
  //    > 「判据测不出过期」——**而坏的是控制，不是判据**。
  const ANCHOR = /第 (\d+) 轮结束时的读数(\*\*（全部可复跑）)/
  const m = ANCHOR.exec(text)
  assert.notEqual(m, null, '找不到读数块的标题 —— 本用例的锚点没了')
  const lower = text.replace(ANCHOR, (all, a, tail) => `第 ${Number(a) - 1} 轮结束时的读数${tail}`)
  assert.notEqual(lower, text, '改写没生效，这条控制是假的')
  const r2 = checkFacts({ ctx: withDoc(INTERVENTION_DOC, () => lower) })
  assert.ok(r2.violations.some((x) => x.id === 'intervention-readings-round'),
    '把标题的轮次改小却没红 ⇒ 这条判据测不出"过期"')
})

test('⑰b ★★ 真仓库：读数块声明的总数 = 同一块里各套件之和', () => {
  const r = checkFacts({ ctx: defaultContext() })
  const v = r.violations.find((x) => x.id === 'intervention-suite-total')
  assert.equal(v, undefined, '★ 读数块的总数与它自己列出的各套件对不上：' + JSON.stringify(v))
  // ★ 反向控制：只改**总数**（列表不动）⇒ 必须红
  const text = defaultContext().doc(INTERVENTION_DOC)
  const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(text)
  assert.notEqual(m, null, '找不到总数那一句 —— 本用例的锚点没了')
  const other = Number(m[1]) + 1
  const patched = text.replace(/⇒ (\S*套件合计 \*\*)\d+( 通过 \/ 0 失败\*\*)/, `⇒ $1${other}$2`)
  assert.notEqual(patched, text, '改写没生效，这条控制是假的')
  const r2 = checkFacts({ ctx: withDoc(INTERVENTION_DOC, () => patched) })
  const v2 = r2.violations.find((x) => x.id === 'intervention-suite-total')
  assert.ok(v2 !== undefined, '只改总数却没红 ⇒ 这一侧没被查')
  assert.equal(v2.claimed, other)
  assert.equal(v2.actual, Number(m[1]))
})

// ★★★★★ 第 96 轮：⑰ 盯的是**读数块**的标题，而这份文档的**第一屏**还有一句活口径。
//   它已经错过两次（第 80 轮在交付物 §一、第 95 轮在本文件开头），两次都是用手找出来的。
test('⑰c ★★★★★ 真仓库：清单**开头那句口径**的"复核到第 N 轮" = 家族表最大轮次', () => {
  const r = checkFacts({ ctx: defaultContext() })
  const v = r.violations.find((x) => x.id === 'intervention-reviewed-round')
  assert.equal(v, undefined,
    '★ 清单开头那句口径与家族表脱节：' + JSON.stringify(v)
    + '\n  第一屏是读者判断"这东西新不新"的**唯一**依据，'
    + '\n  而它恰恰是**读的人唯一一定会看**的地方。'
    + '\n  ⑰ 红不了这一处 —— 因为那一句**不在**读数块里。')
  // ★ 反向控制：把那个数改小 ⇒ 必须红（证明上面那条不是恒绿）
  const text = defaultContext().doc(INTERVENTION_DOC)
  // ★★ 锚点必须与判据**同一处**：`复核到第 N 轮` 在本文件里有 3 处
  //    （那句更正引用了旧值、家族行也引用了旧值与新值）。
  //    只有那句**活口径**写成 `本文件已**复核到第 N 轮**`（整句加粗）。
  const ANCHOR = /本文件已\*\*复核到第 (\d+) 轮\*\*/
  const m = ANCHOR.exec(text)
  assert.notEqual(m, null, '找不到那句口径 —— 本用例的锚点没了')
  const lower = text.replace(ANCHOR, (all, a) => `本文件已**复核到第 ${Number(a) - 1} 轮**`)
  assert.notEqual(lower, text, '改写没生效，这条控制是假的')
  const r2 = checkFacts({ ctx: withDoc(INTERVENTION_DOC, () => lower) })
  assert.ok(r2.violations.some((x) => x.id === 'intervention-reviewed-round'),
    '把口径的轮次改小却没红 ⇒ 这条判据测不出"第一屏过期"')
})

// ★★★★★ 第 97 轮：交付物头部那句**指路坐标**「与它的家族表（**逐轮到第 N 行**）」
//   —— 它当时写着 77，而真实是 96（落后 19 轮）。而同一处声明**散在两处**，本轮先去重再钉住。
test('⑰d ★★★★★ 真仓库：交付物说"家族表逐轮到第 N 行" = 那份清单家族表的最大轮次', () => {
  const r = checkFacts({ ctx: defaultContext() })
  const v = r.violations.find((x) => x.id === 'report-family-rows-round')
  assert.equal(v, undefined,
    '★ 交付物那句指路坐标与清单家族表脱节：' + JSON.stringify(v)
    + '\n  那句的作用是"读数在那里，不在这里"；'
    + '\n  而一个过期的坐标会让读者以为**那份文档也只有那么长** —— 于是不去看它。')
  // ★ 反向控制：把那个数改小 ⇒ 必须红（证明上面那条不是恒绿）
  const text = defaultContext().doc(FINAL_REPORT_DOC)
  const ANCHOR = /逐轮到第 (\d+) 行/
  const m = ANCHOR.exec(text)
  assert.notEqual(m, null, '找不到那句坐标 —— 本用例的锚点没了')
  const lower = text.replace(ANCHOR, (all, a) => `逐轮到第 ${Number(a) - 1} 行`)
  assert.notEqual(lower, text, '改写没生效，这条控制是假的')
  const r2 = checkFacts({ ctx: withDoc(FINAL_REPORT_DOC, () => lower) })
  assert.ok(r2.violations.some((x) => x.id === 'report-family-rows-round'),
    '把坐标的行数改小却没红 ⇒ 这条判据测不出"指路坐标过期"')
  // ★★ 附带钉住"锚点唯一"：本套件对多处命中直接判红（`ANCHOR_AMBIGUOUS`），
  //    而本轮之所以能立这条，是因为先把**重复的那处声明去掉了数字**。
  //    ★ 这里**另用**一个带 `g` 的写法：`matchAll` 不接受非全局正则
  //      （第一版拿上面那个非全局的 `ANCHOR` 去 `matchAll`，当场 `TypeError`）。
  assert.equal([...text.matchAll(/逐轮到第 (\d+) 行/g)].length, 1,
    '那句坐标在交付物里出现了多处 ⇒ 本轮的去重被撤销了（判据会以 ANCHOR_AMBIGUOUS 红）')
})

// ★★★★★ 第 100 轮：家族表的派生量**必须能看见三位数的轮次**。
//   第 51 轮写的派生量是 `^\| (\d{2}) \|`（**恰好两位**）—— 在第 100 行出现之前它一直是对的，
//   而第 100 行一落地，⑰/⑰c/⑰e **同时判红**（派生量停在 99、声明已是 100）。
//   ★ 这个洞**只有三位数的轮次能翻出来** ⇒ 必须留一条会红的用例，否则下次有人"顺手简化"回 `\d{2}` 就没人知道。
test('⑰e ★★★★★ 家族表的派生量看得见三位数轮次（第 100 行的那个洞）', () => {
  const text = defaultContext().doc(INTERVENTION_DOC)
  // 真仓：派生量必须等于**家族表最后一行**那个数（今天 ≥ 100 ⇒ 天然覆盖三位数）
  const famRows = [...text.matchAll(/^\| (\d{2,3}) \|/gm)].map((m) => Number(m[1]))
  assert.ok(famRows.length > 0, '家族表一行都没解析出来 —— 本用例的输入空了')
  const realMax = Math.max(...famRows)
  assert.ok(realMax >= 100,
    `家族表最大轮次是 ${realMax} ⇒ 本用例已失去"三位数"这个条件（请把它当成提醒，而不是失败）`)
  // ★ 关键断言：**造一个三位数的新行**，派生量必须跟着动到它
  const bumped = realMax + 1
  assert.ok(bumped >= 100, '构造出来的轮次跌回两位数了 —— 本用例的意图没了')
  const patched = `${text}\n| ${bumped} | ★ 本用例造的一行（只为验证派生量看得见三位数） |\n`
  const r = checkFacts({ ctx: withDoc(INTERVENTION_DOC, () => patched) })
  const v = r.violations.find((x) => x.id === 'intervention-readings-round')
  // 派生量若看得见那一行，读数标题（写着真实最大轮次）就会与它对不上 ⇒ **必须红**
  assert.ok(v !== undefined,
    `往家族表加了一行 \`| ${bumped} |\` 之后读数块却没红 ⇒ `
    + '派生量看不见三位数轮次（很可能被改回了 /^\\| (\\d{2}) \\|/，那会在第 100 行上静默失明）')
  assert.equal(v.actual, bumped, `派生量算出来是 ${v.actual}，期望 ${bumped}`)
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 52 轮：**最终报告**（交付物本身）的 §三 此前零判据
//
// 实测：§三 是**逐轮留档**（第 16 轮起），34 个小节按轮次编号，
// 而其中的 **39～43 是倒着放的**（43、42、41、40、39），44/45 又跳到 39 前面。
//
//   > 一份"看起来按编号排好了"的文档，与一份真的排好了的文档，
//   > 在**只看前几节**的时候是同一个读数 ——
//   > 读者从 16 一路看到 38 都是升序，**合理地**假设后面也是。
//
// ★ 这一族的老形状又出现了一次：**清单的含义由位置决定**。
//   只是这次的清单是**交付物自己的目录**。
// ══════════════════════════════════════════════════════════════════════════

test('⑱ ★★★ 真仓库：最终报告 §三 的轮次**全序递增**（39～43 曾经是倒的）', () => {
  const rows = reportSectionRounds(defaultContext().doc(FINAL_REPORT_DOC))
  assert.ok(rows.length >= 20, `§三 里只认出 ${rows.length} 个带轮次的小节，覆盖面太小`)
  const bad = roundOrderViolations(rows)
  assert.deepEqual(bad, [],
    '§三 的小节轮次出现倒序：' + JSON.stringify(bad)
    + '\n  一份"看起来按编号排好了"的文档，与一份真的排好了的文档，'
    + '\n  在只看前几节的时候是同一个读数。')
  // ★ 起点与终点是有意义的：起点是"逐轮留档从第几轮开始"，终点是最新轮
  assert.equal(rows[0].round, 16, `§三 的第一个带轮次小节是第 ${rows[0].round} 轮`)
})

test('⑱b ★★ 反面控制：把真实小节**倒过来** ⇒ 必须报出倒序（否则这条判据是恒绿的）', () => {
  const rows = reportSectionRounds(defaultContext().doc(FINAL_REPORT_DOC))
  assert.ok(rows.length >= 4, '小节太少，控制写不出来')
  // ★ 取一段真实的连续小节，**整段反转**（正是本轮修掉的那个形状）
  const seg = rows.slice(10, 15).map((r) => ({ ...r }))
  const reversed = [...seg].reverse()
  assert.notDeepEqual(reversed.map((r) => r.round), seg.map((r) => r.round),
    '取到的这一段本身就是回文，控制无效')
  const bad = roundOrderViolations(reversed)
  assert.ok(bad.length > 0, '把真实小节反转了却没报倒序 ⇒ 这条判据测不出倒序')
  assert.equal(bad[0].to, seg[3].round)
})

test('⑱c ★★★ 区间写法**必须被认出来**：`第 24～29 轮` 不许被静默跳过', () => {
  // ★ 第一版用的是 `第 (\d+) 轮` ⇒ 区间那行一个都没匹配上、`3.0j` 被**静默跳过**，
  //   而输出里看起来"该查的都查了"。（同一个坑第 51 轮刚踩过。）
  const rows = reportSectionRounds(defaultContext().doc(FINAL_REPORT_DOC))
  const range = rows.find((r) => /第 \d+～\d+ 轮/.test(r.heading))
  assert.notEqual(range, undefined,
    '§三 里那个区间小节没被认出来 —— 认不出某种写法的模式，'
    + '报出来的是"这种写法不存在"，而它在输出里和"这种写法没问题"长得一样')
  assert.ok(range.round >= 24, `区间小节解析出的轮次是 ${range.round}`)
})

// ── 第 54 轮：交付物 §四「验证与门禁」不许**裸着**声明别处持有的当前读数 ──
//   实测：§四 有四行是别处已经有人盯着的数的**第二份声明**，而它飘了 30 轮
//   （套件数 350 vs 379、boundary-facts 34 vs 54、五个套件 331 vs 82、不可达 46 vs 44）。
//   ★ 判据只认**没有冻结标记**的行：§四 的立意是冻结读数表，
//     标了轮次 / HEAD / `.ci/` 的是合法历史证据。
test('⑲ ★★ 交付物 §四：不许裸着声明别处已经有人盯着的当前读数', () => {
  const text = defaultContext().doc(FINAL_REPORT_DOC)
  // ★ 先证明**扫到了**：没有这条，下面的 0 条与"压根没扫到 §四"是同一个读数。
  assert.ok(/^\| 可达性（第 \d+ 轮） \|/m.test(text),
    '§四 里那条带轮次的「可达性」行不见了 ⇒ 本用例的扫描面可能已经不是 §四')
  const bad = sectionFourBareCurrentReadings(text)
  assert.deepEqual(bad, [],
    `§四 有裸着声明的当前读数：${JSON.stringify(bad)}`
    + ' ⇒ 一个被两处声明的数，与一个被一处声明的数，'
    + '在**两处恰好还相等**的那些天里是同一个读数；而抄的那一份没人盯')
})

test('⑲b ★ 反面控制：把冻结标记拿掉 ⇒ 必须报出来', () => {
  const text = defaultContext().doc(FINAL_REPORT_DOC)
  const mutated = text.replace('| 可达性（第 22 轮） |', '| 可达性 |')
  assert.notEqual(mutated, text, '锚点没改到 —— 这个反面控制是假的')
  const bad = sectionFourBareCurrentReadings(mutated)
  assert.ok(bad.some((b) => b.cell === '可达性'),
    `判据测不出"裸声明"：${JSON.stringify(bad)}`)
})

test('⑲c ★★ 对称控制：标了冻结标记的同一行不许被报（判据不许惩罚合法的历史）', () => {
  const head = '## 四、验证与门禁'
  const mk = (row) => [head, '', '| 项 | 读数 |', '| --- | --- |', row, '', '## 五、x'].join('\n')
  for (const row of [
    '| 可达性（第 22 轮） | 不可达 **44** 条 |',
    '| 套件清单完备（第 18 轮） | **350 个 `*.test.mjs`** |',
    '| 可达性（`.ci/r51`） | 不可达 **44** 条 |',
  ]) {
    assert.deepEqual(sectionFourBareCurrentReadings(mk(row)), [],
      `带冻结标记的行被误报 ⇒ 判据把历史证据当成了重复声明：${row}`)
  }
  // ★ 而没有标记的那一行**必须**被报出来，否则上面三条全是假绿
  assert.equal(sectionFourBareCurrentReadings(mk('| 可达性 | 不可达 **44** 条 |')).length, 1,
    '没有冻结标记的行没被报出来 ⇒ ⑲c 的三条对称控制是假绿')
  // ★ 而且 §四 **之外**的同名行不许被扫（否则会红在 §一/§五 的散文上）
  const outside = ['## 一、结论', '', '| 可达性 | 不可达 **44** 条 |', '', '## 四、验证与门禁', '', '| 项 | 读数 |', '| --- | --- |', '| 可达性（第 22 轮） | 不可达 **44** 条 |'].join('\n')
  assert.equal(sectionFourBareCurrentReadings(outside).length, 0,
    '§四 之外的行被扫进来了 ⇒ 扫描面比声称的宽')
})
/** 第 58 轮：取某一行所属的最近一个 markdown 标题（用于"这行在哪个小节里"）。 */
function sectionHeading(lines, lineNo) {
  for (let i = lineNo - 1; i >= 0; i -= 1) {
    if (/^#{2,4} /.test(lines[i])) return lines[i]
  }
  return ''
}

// ── 第 58 轮：台账分档被抄了几处，就核几处 ──────────────────────────────
//
//   `140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜` 在仓库 5 份文档里被抄了 **10 处**，此前只有 2 处有判据。
//
//   ★ 而"哪处现行、哪处历史"**没有本地信号**：按 ±2 行找轮次/提交号，
//     会把交付物**第 5 行**（开头那句现行摘要）判成历史 —— "第 45 轮"恰好在它附近。
//
//   > 一个按"附近有没有轮次标记"分类的探针，会把文档**开头那句现行摘要**
//   > 判成历史留档 —— 而它离真正的历史段落还有 40 行。
//
//   ⇒ 用**文档自己声明的结构边界**：`## 三、逐轮留档` 之前 = 现行（必须等于台账），
//     之后 = 历史（免检）。并 **fail closed**：标题之后若有抄写不在 `### 3.0*` 小节里，也报红。
test('⑯ ★★ 交付物里每一处台账分档抄写都要等于台账（以它自己声明的「逐轮留档」为界）', () => {
  const doc = readFileSync(resolve(REPO, 'docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md'), 'utf8')
  const lines = doc.split('\n')
  const iArchive = lines.findIndex((l) => /^## 三、逐轮留档/.test(l))
  assert.ok(iArchive > 0, '找不到交付物 §三「逐轮留档」标题 ⇒ 判据的边界没了，不能静默免检')
  const ledger = readFileSync(resolve(REPO, 'docs/superpowers/prt/PRT-PROGRESS.md'), 'utf8')
  const real = tallyLedger(ledger)
  const want = [real.done, real.partial, real.paused, real.todo].join('/')
  const TALLY = /(\d+)\s*✅\s*[/／]\s*(\d+)\s*🟡\s*[/／]\s*(\d+)\s*⏸\s*[/／]\s*(\d+)\s*⬜/g
  const live = []
  const frozen = []
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(TALLY)) {
      const v = [m[1], m[2], m[3], m[4]].join('/')
      if (i < iArchive) { live.push({ line: i + 1, v }) } else { frozen.push({ line: i + 1, v, text: lines[i] }) }
    }
  }
  // ★ 期望值是 **1**，不是 2 —— 交付物把**同一个数**写了**两种形状**：
  //   开头那句是「四档连写」（`140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜`），
  //   而 §一 那张表是**每格一个数**（`| ✅ 已完成 | **140** |`）。
  //
  //   > 同一个数在同一份文档里用两种形状写着，
  //   > 而任何**一条**正则只认其中一种。
  //
  //   ⇒ §一 那种由 `report-section-one-ledger-tallies` 单独管；本条管「四档连写」那些。
  assert.ok(live.length >= 1, `§三 之前只找到 ${live.length} 处「四档连写」形式的台账分档（应 >= 1：开头那句现行摘要）`)
  const bad = live.filter((x) => x.v !== want)
  assert.deepEqual(bad, [], `现行读数里与台账不符：${JSON.stringify(bad)}（台账真值 ${want}）`)
  // ★ fail closed：留档区里的抄写必须落在 `### 3.0*` 小节内，否则报红
  const stray = frozen.filter((x) => !/^### 3\.0/.test(sectionHeading(lines, x.line)))
  assert.deepEqual(stray.map((x) => x.line), [], '留档区里有不在 `### 3.0*` 小节内的台账抄写 ⇒ 可能是被挪进去规避判据的')
})

// ── 第 59 轮：台账分档的 **10 处抄写**，逐个登记为「现行」或「历史」──────────
//
//   第 58 轮只覆盖了交付物自己的 2 处（靠 `## 三、逐轮留档` 这个由文档自己声明的边界）。
//   本轮把全部 10 处登记出来：
//
//     现行（必须等于台账）  交付物开头摘要 · 交接报告 §一 · 交接报告 §二 · 人工清单抬头
//     历史（只登记，不核值）交付物 §三 留档 · 交接报告 §12.3 · 状态文档 3 处
//
//   > "10 处里只有 2 处被盯"这件事，不能靠"多盯 2 处"来修 ——
//   > 只要还剩下一处没人登记，同一个缺陷下次就换个地方复现。
//
//   ⇒ 判据要求分类**完整**：每一处要么被核值，要么被显式登记为历史。
//     新增第 11 处 ⇒ 报红，并在消息里说明"去 TALLY_LIVE / TALLY_FROZEN 登记它"。
const TALLY_COPY = /(?:\d+)\s*✅\s*[/／]\s*(?:\d+)\s*🟡\s*[/／]\s*(?:\d+)\s*⏸\s*[/／]\s*(?:\d+)\s*⬜/
const TALLY_DOCS = [
  'docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md',
  'docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md',
  'docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md',
  'docs/MULTI-AGENT-FEATURE-STATUS.md',
]
const TALLY_LIVE = [
  { doc: TALLY_DOCS[0], starts: '- 权威台账：', what: '交付物开头那句现行摘要' },
  { doc: TALLY_DOCS[1], starts: '功能实现**已完成到', what: '交接报告 §一 一句话结论' },
  // ★★ 第 113 轮：交接报告 §一 里**第二处**现行抄写（"真值（第 111 轮实测）"那一行）。
  //   它是另一个会话为收口 PRT-316 加的，而**没有人登记它** ⇒ 本判据报"有 1 处没有登记"。
  //   按本判据自己的指示（"现行就核值"）登记在这里——它的内容确实是现行值。
  { doc: TALLY_DOCS[1], starts: '★ 真值（第 111 轮实测）：', what: '交接报告 §一 真值行（第 113 轮登记）' },
  { doc: TALLY_DOCS[1], starts: '| 台账 | **145 行 =', what: '交接报告 §二 最终读数' },
  { doc: TALLY_DOCS[2], starts: '> 台账 `docs/', what: '人工清单抬头' },
]
const TALLY_FROZEN = [
  { doc: TALLY_DOCS[0], starts: '| 「145 行 =', where: '交付物 §三 逐轮留档' },
  { doc: TALLY_DOCS[1], starts: '| `handover-ledger-tallies` |', where: '交接报告 §12.3（第 26 轮留档）' },
  { doc: TALLY_DOCS[3], starts: '| `handover-ledger-tallies` |', where: '状态文档（第 26 轮留档）' },
  { doc: TALLY_DOCS[3], starts: '| 「145 行 =', where: '状态文档 5.27.2（留档）' },
  { doc: TALLY_DOCS[3], starts: '| **真台账** |', where: '状态文档 5.28.7（第 46 轮留档）' },
]

test('⑰ ★★★ 台账分档的每一处抄写都被登记过：现行的必须等于台账，历史的必须显式列出', () => {
  const ledger = readFileSync(resolve(REPO, 'docs/superpowers/prt/PRT-PROGRESS.md'), 'utf8')
  const real = tallyLedger(ledger)
  const want = [real.done, real.partial, real.paused, real.todo].join('/')
  // 每份文档里「带台账分档的行」
  const copies = []
  for (const doc of TALLY_DOCS) {
    const lines = readFileSync(resolve(REPO, doc), 'utf8').split('\n')
    lines.forEach((l, i) => { if (TALLY_COPY.test(l)) copies.push({ doc, line: i + 1, text: l.trim() }) })
  }
  // ① 现行清单：锚点必须**恰好**命中一处，且那一处的值必须等于台账
  const liveHits = []
  for (const spec of TALLY_LIVE) {
    const hit = copies.filter((c) => c.doc === spec.doc && c.text.startsWith(spec.starts))
    assert.equal(hit.length, 1, `${spec.what}：锚点命中 ${hit.length} 处（应 1）—— ${spec.doc}`)
    const m = TALLY_COPY.exec(hit[0].text)
    const v = m[0].match(/\d+/g).join('/')
    assert.equal(v, want, `${spec.what} 写的是 ${v}，台账是 ${want}`)
    liveHits.push(hit[0])
  }
  // ② 历史清单：锚点也必须**恰好**命中一处
  const frozenHits = []
  for (const spec of TALLY_FROZEN) {
    const hit = copies.filter((c) => c.doc === spec.doc && c.text.startsWith(spec.starts))
    assert.equal(hit.length, 1, `${spec.where}：锚点命中 ${hit.length} 处（应 1）—— ${spec.doc}`)
    frozenHits.push(hit[0])
  }
  // ③ ★★ 分类必须**完整**：每一处抄写恰好落进一份清单
  const key = (c) => `${c.doc}#${c.line}`
  const declared = new Map()
  for (const c of [...liveHits, ...frozenHits]) declared.set(key(c), (declared.get(key(c)) ?? 0) + 1)
  // ★★★ 第 59 轮：人工清单 §四 那张**家族表**的编号行，按构造就是历史留档。
  //
  //   这一条是被判据自己逼出来的：我在第 58 轮往家族表写了第 58 行，
  //   而那一段正文**把台账分档又引了一遍**（`140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜`）——
  //   于是本判据第一次跑就报"有 1 处没有登记"，
  //   抓到的正是那条**刚刚记录"抄了 10 处"的家族行**。
  //
  //   > 记录"同一个数被抄了 10 遍"这件事，本身又抄了第 11 遍 ——
  //   > 而抓住它的，正是那条**刚刚为这件事写的判据**。
  //
  //   ★ 不逐条登记家族行（那会每轮都要补一次，且"补一下"正是这类缺陷的来源），
  //     而是给它一条**规则**：家族表的编号行 = 历史。
  //
  //   ★★★★★ 第 101 轮修：原来是 `\d{1,2}`（**一两位**），而家族表跨到第 100 行之后
  //     那一行是 `| 100 |`（**三位**）⇒ **不再被这条规则豁免**。
  //     ★ 今天它**侥幸不红**（第 100 行正文里没有台账分档串）；
  //       而**下一行**只要在正文里引一次 `140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜`，本判据就会报
  //       「有一处**没有登记**」—— **而真正的病根是"正则只认两位"**。
  //     ⇒ 一个会给出**误导性诊断**的洞，比一个直接红的洞更贵：它把人引去"补登记"。
  //     ★★ 用 `\d+`（**不设宽度**），而不是 `\d{2,3}`：
  //       第 101 轮我先写成 `\d{2,3}`，**而我自己刚加的回归用例当场把它打红**（`\d{2,3}` 认不出 `| 1000 |`）——
  //       那只是把墙从 100 挪到 1000，**同一个洞换个位置**。
  //       > 一个"把宽度从两位改到三位"的修法，与一个"不再假定宽度"的修法，
  //       > 在"下一次语料长过那个宽度"这件事上是同一个东西。
  //     ★ 已知边界（不假装覆盖）：这条规则**只看行首那个编号**，因此它也会豁免
  //       本文档里**别的** `| N |` 表（例如我第 100 轮那张"九个阶段"表）。
  //       那些行今天不含台账分档串、不进 `copies` ⇒ 无害；而**真要区分"哪张表是家族表"
  //       靠的不是行首编号**，本轮不假装解决它。
  const isFamilyHistoryRow = (c) => c.doc === TALLY_DOCS[2] && /^\|\s*\d+\s*\|/.test(c.text)
  for (const c of copies.filter(isFamilyHistoryRow)) declared.set(key(c), (declared.get(key(c)) ?? 0) + 1)
  const unregistered = copies.filter((c) => !declared.has(key(c)))
  assert.deepEqual(unregistered.map((c) => `${key(c)}  ${c.text.slice(0, 60)}`), [],
    `有 ${unregistered.length} 处台账分档抄写**没有登记** ⇒ 去 boundary-facts.test.mjs 的 `
    + `TALLY_LIVE / TALLY_FROZEN 里登记它（现行就核值，历史就写明出处）`)
  const dup = [...declared.entries()].filter(([, n]) => n > 1)
  assert.deepEqual(dup, [], `同一处被登记了两次：${JSON.stringify(dup)}`)
  // ④ 数量对得上（防止"清单少一条而恰好也没人发现"）
  //    ★ 用 `declared.size`（**已被分类的不同条目数**），不要用两个清单的长度相加 ——
  //      家族表那条走的是**规则**、不在任何一份清单里，相加就会少算它。
  assert.equal(declared.size, copies.length,
    `已分类 ${declared.size} 处 vs 实存 ${copies.length} 处（现行 ${liveHits.length} · 显式历史 ${frozenHits.length} · 家族行规则 ${copies.filter(isFamilyHistoryRow).length}）`)
  assert.equal(liveHits.length, TALLY_LIVE.length, '现行清单里出现了重复锚点')
  assert.equal(frozenHits.length, TALLY_FROZEN.length, '历史清单里出现了重复锚点')

  // ★★★★★ 第 101 轮回归用例：家族行的豁免规则**必须认三位数编号**。
  //
  //   第 100 轮那个洞（`\d{2}` 看不见 `| 100 |`）与这个是**同一类**：
  //   一条"宽度写死"的正则，在语料长过那个宽度之后**静默失明**。
  //   ★ 而这一处的失明更贵 —— 它不会直接红，而是把表头的**真正病根**（正则）
  //     报成「有一处**没有登记**」⇒ 把人引去"补登记"。**误导性诊断比直接红更贵。**
  //
  //   造一行：三位数编号 + 台账分档串（正是 `copies` 会收集的形状），断言它**必须**被豁免。
  const famShape = (n) => `| ${n} | ★ 探针：正文里引一次分档 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜ |`
  for (const n of [9, 99, 100, 101, 1000, 10000]) {
    assert.ok(isFamilyHistoryRow({ doc: TALLY_DOCS[2], text: famShape(n) }),
      `家族行的豁免规则认不出编号 ${n} 的行 ⇒ `
      + '某天一行更宽编号的家族行里引了一次台账分档，本判据会报"有一处没有登记"，'
      + '而病根是"豁免规则的正则假定了编号宽度"——一个会把人引去补登记的**误导性诊断**。'
      + '★ 修它的正确方向是**不再假定宽度**（`\\d+`），而不是把宽度从 2 改成 3 —— '
      + '后者只是把墙挪到 1000（第 101 轮实测：`\\d{2,3}` 认不出 1000）。')
  }
})

// ── 第 60 轮：**散文形状**的分档说法（`唯一的 ⬜`、`1 ⬜ + 4 ⏸`）────────────
//
//   前几轮的判据只认「四档连写」（`140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜`），于是 §2 里
//   「台账里唯一的 ⬜」与「（1 ⬜ + 4 ⏸）」这两处**一直没人管** ——
//   而它们与第 57 轮修掉的 §一 那个错，是**同一个错信念**：把 PRT-316（🟡）写成 ⬜。
//
//   > 同一个错信念写进两节，改了一节不等于改掉了它。
//
//   ⇒ 在**现行区**（`## 三、逐轮留档` 之前）里核两种散文形状：
//     ① `N <标记>` 的 N 必须等于台账那一档；
//     ② `唯一的 <标记>` 的标记必须是台账里**恰好为 1** 的那一档。
test('⑱ ★★ 交付物现行区里每一处分档说法都要等于台账（含散文形状）', () => {
  const lines = readFileSync(resolve(REPO, FINAL_REPORT_DOC), 'utf8').split('\n')
  const iArch = lines.findIndex((l) => /^## 三、逐轮留档/.test(l))
  assert.ok(iArch > 0, '找不到 §三 边界')
  const ledger = readFileSync(resolve(REPO, 'docs/superpowers/prt/PRT-PROGRESS.md'), 'utf8')
  const real = tallyLedger(ledger)
  const want = { '✅': real.done, '🟡': real.partial, '⏸': real.paused, '⬜': real.todo }
  const bad = []
  for (let i = 0; i < iArch; i += 1) {
    const l = lines[i]
    // ① `N <标记>`
    for (const m of l.matchAll(/(\d+)\s*(✅|🟡|⏸|⬜)/g)) {
      const got = Number(m[1])
      if (got !== want[m[2]]) bad.push(`L${i + 1} 写「${m[0]}」，而台账 ${m[2]} = ${want[m[2]]}`)
    }
    // ② `唯一的 <标记>`（标记必须恰好是台账里为 1 的那一档）
    for (const m of l.matchAll(/唯一的\s*\*{0,2}(✅|🟡|⏸|⬜)/g)) {
      if (want[m[1]] !== 1) bad.push(`L${i + 1} 说「唯一的 ${m[1]}」，而台账 ${m[1]} = ${want[m[1]]}`)
    }
  }
  assert.deepEqual(bad, [], `现行区里的分档说法与台账不符：\n${bad.join('\n')}`)
})

// ── 第 61 轮：`第 N 条` 在同一节里指过**两个东西** ────────────────────────
//
//   实测（交付物 §2，相邻两行）：
//
//     L131 「…而那正是**第 1 条**」                  ← §2.0 表里 `先看` 那一列的**排名 1**
//     L132 「解掉它同时关掉**第 15 条**（PRT-610）」   ← **§5 第 15 条**
//
//   > 同一节里"第 N 条"指两个东西时，读者分不出自己读到的是哪一个 ——
//   > 而分不出的地方，恰好是"先看哪一格"这句话最要紧的地方。
//
//   ★ 文档自己早写对了：L118「（**§5** 第 20 条 · 甲）」、L130「（★ **§5** 第 25 条）」；
//     而 L122 讲同一件事时用的是**「行」**。
//
//   ⇒ 现行区里 ① `第 N 条` 必须带 `§5` / `决策表` 限定词；② 那个 N 必须是 **§5 里真有的条号**。
test('⑲ ★★ 交付物现行区里的 `第 N 条` 必须带限定词，且指得到 §5 里真有的那一条', () => {
  const lines = readFileSync(resolve(REPO, FINAL_REPORT_DOC), 'utf8').split('\n')
  const iArch = lines.findIndex((l) => /^## 三、逐轮留档/.test(l))
  assert.ok(iArch > 0, '找不到 §三 边界')
  const valid = matrixItems(MATRIX_PATH)
  assert.ok(valid.size >= 29, `§5 决策表只取到 ${valid.size} 条 —— 边界没了，不能静默免检`)
  const bare = []
  const oob = []
  for (let i = 0; i < iArch; i += 1) {
    const l = lines[i]
    // ★★ 第 101 轮：`\d{1,2}` → `\d{1,3}`。§5 今天只有 29 条（`valid.size >= 29`），
    //    所以两者**今天读数一致**（实测都是 max=99）；而一旦有条号到三位，
    //    旧写法会**看不见**那处引用 ⇒ `oob`（越界）也就**不会报** ⇒ 一个静默的漏检。
    for (const m of l.matchAll(/第\s*(\d{1,3})\s*条/g)) {
      const pre = l.slice(Math.max(0, m.index - 10), m.index)
      if (!/§5\s*$|决策表\s*$|表\s*$/.test(pre)) {
        bare.push(`L${i + 1} …${l.slice(Math.max(0, m.index - 28), m.index + 14)}…`)
      }
      if (!valid.has(Number(m[1]))) oob.push(`L${i + 1} 第 ${m[1]} 条 不在 §5 里`)
    }
  }
  assert.deepEqual(bare, [], `现行区里有不带限定词的 \`第 N 条\`（同一节里 §5 项与"先看排名"会撞）：\n${bare.join('\n')}`)
  assert.deepEqual(oob, [], `现行区里引用了**不存在**的条号：\n${oob.join('\n')}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// ★★★★★ 第 105 轮：源码注释里"抄了原文"的引用（第 104 轮那个漂 414 行的洞的**机制修复**）
// ══════════════════════════════════════════════════════════════════════════════
//
// 第 104 轮实测到一条：`runtime/adapters/dsh/port.mjs` 引 `plugins/src/index.ts:2241`，
// 而那句原文在 **`:1827`** ⇒ 指针漂了 414 行，`HEAD` 上就是错的。
//
// ★ 而它活了那么久，是因为**没有任何判据读源码注释**：
//   · `ledger-line-citations-resolve` 只读**台账**（`PRT-PROGRESS.md`）；
//   · `dsh-pin-drift` 只读 DSH 检出的 **3 个文件 / 6 条结论**（全在 `packages/` 下）。
//
// ★ 所以本轮**不只修那一处实例**，还修**产生它的机制** —— 后者才是不再复发的那个。
test('㉓ ★★★★★ 源码注释里的「原文」引用：引文必须落在它写的那个行号上', () => {
  // ── ① 真仓：解析得到，且至少有一条对得上（防"扫描面变空却全绿"）
  const r = scanOriginalCitations()
  assert.ok(r.total >= 3,
    `只解析到 ${r.total} 条"路径:行 … 原文：「…」"引用 ⇒ 扫描面塌了或注释格式变了（这条判据会静默失去检查对象）`)
  assert.ok(r.ok >= 1, `解析到 ${r.total} 条却一条都没对上 ⇒ 判据本身坏了`)

  // ── ② 已知的两处坏引用：**必须还是那两处**（多一处少一处都要人来看）
  //    ★ 这两处登记在 FACTS 的 `expect` 里，此处再钉一遍，免得有人"顺手清空 expect 让它绿"。
  const known = [
    'product/launcher/legacy-data-adoption.mjs:130 → launcher.mjs:108',
    'product/launcher/legacy-data-adoption.test.mjs:77 → launcher.mjs:108',
  ]
  for (const k of known) {
    assert.ok(r.broken.some((b) => b.startsWith(k)),
      `登记在案的那处坏引用不见了：${k} ⇒ 要么它被修好了（**好事**，但要把 FACTS 的 expect 同步改掉，`
      + '否则那条记录会变成一句不再成立的旧话），要么扫描器漏掉了它')
  }
  assert.equal(r.broken.length, known.length,
    `坏引用数变了（${r.broken.length} vs 登记的 ${known.length}）⇒ 有新漂移，或有一处被修好了：\n`
    + r.broken.join('\n'))

  // ── ③ 纯判定函数：**正反两个方向都钉住**（这才是"判据咬不咬得住"的那一半）
  const lines = ['', '// 前言', '// plugins/src/index.ts:1827 现场注释原文：「subagent 可能挂死且 run.result 永不结算', '// 收尾']
  const quote = 'subagent 可能挂死且 run.result 永不结算'
  assert.equal(originalQuoteOnLine(lines, 3, quote), true, '引文就在第 3 行，却判成不在 ⇒ 判据**漏判**（最坏的一种：它永远绿）')
  assert.equal(originalQuoteOnLine(lines, 2, quote), false, '引文不在第 2 行，却判成在 ⇒ 判据**误判**（会逼人改一条对的引用）')
  assert.equal(originalQuoteOnLine(lines, 1827, quote), false, '越界的行号必须判 false，不许抛出或当成命中')
  assert.equal(originalQuoteOnLine(lines, 0, quote), false, '行号 0 必须判 false')
  assert.equal(originalQuoteOnLine(lines, 3, ''), false, '空引文必须判 false（否则空串会被任何行"包含"）')
})

// ══════════════════════════════════════════════════════════════════════════════
// ★★★★★ 第 107 轮：交付物 §四 那四个**扫描规模下限**（第 54 轮那个处置的沿用）
// ══════════════════════════════════════════════════════════════════════════════
//
// 那四个数原来写 `296/38/15/162`，第 107 轮实测 `381/88/15/164` ⇒ **四个里三个已过期**。
// ★ 而它们会涨**不是缺陷**：扫描是**全仓按 glob 数文件**的，而另一个会话在持续落新文件。
//
// ★★ 同一个形状本仓**已经栽过也定过处置**：交接报告那句"套件清单完备：N 个"，
//    实测**两轮内红了 7 次、真缺陷 0 次**（374→…→381，**红得比提交还快**），
//    第 54 轮把它从"等于"改成**下限**。本轮沿用，不另发明一套。
test('㉔ ★★★★★ §四那四条机械边界的扫描规模：必须是**下限**，且四条各判各的', () => {
  const scans = defaultContext().designBoundaryScans()
  const keys = ['no-second-agent-loop', 'single-control-plane-db', 'single-harness', 'no-dsh-installer']
  for (const k of keys) {
    assert.ok(Number.isInteger(scans[k]) && scans[k] > 0,
      `扫描量 ${k} = ${scans[k]} ⇒ 空转守卫（scanned > 0）或派生坏了`)
  }

  // ── ① 四条事实必须都在，且**方向必须是下限**（把"等于"重新装上是最容易犯的错）
  const ids = FACTS.map((f) => f.id)
  const want = [
    'design-boundary-scan-agent-loop',
    'design-boundary-scan-control-plane-db',
    'design-boundary-scan-single-harness',
    'design-boundary-scan-no-dsh-installer',
  ]
  for (const id of want) {
    const f = FACTS.find((x) => x.id === id)
    assert.ok(f, `缺了这条事实：${id}`)
    assert.equal(f.relation, 'atLeast',
      `${id} 的 relation 是 \`${f.relation ?? 'equal'}\` ⇒ 它又变回"等于当前值"了，`
      + '而那个形状**两轮内红过 7 次、真缺陷 0 次**（第 54 轮的实测）⇒ 它会被人习惯性忽略')
    // ★ 反向对照的**同一锚点**：同一条事实的 expect 必须是空（扫描量不在 expect 里，
    //   走的是 claim/derive 那条路）——两条路各判各的，别把扫描量也塞进 expect。
    assert.equal(f.expect, undefined, `${id} 同时用了 expect ⇒ 两条路会互相掩盖`)
  }
  assert.equal(new Set(ids).size, ids.length, '事实 id 有重复')

  // ── ② 下限的**语义**验证：改大必红、改小不该红（这才是"它是下限"的定义）
  const scan = scans['single-harness']
  const docOf = (n) => `不在契约稳定前同时支持多个 Harness | 机械 | ★ **≥ ${n}** 个文件`
  const re = FACTS.find((f) => f.id === 'design-boundary-scan-single-harness').claim.re
  const claimed = (n) => Number(re.exec(docOf(n))[1])
  assert.equal(claimed(scan), scan, `文档写 ≥ ${scan} 时必须解得开（锚点不能只认某一个数）`)
  // ★ 逐条核对"改大 ⇒ 违反下限"，不依赖 checkFacts 的实现细节
  assert.ok(scan < claimed(scan + 1),
    `把下限改成 ${scan + 1} 之后，实际值 ${scan} 必须**小于**它 ⇒ 这条判据会红`)
  assert.ok(scan >= claimed(scan - 1),
    `把下限改成 ${scan - 1} 之后，实际值 ${scan} 必须**不小于**它 ⇒ 这条判据**不该**红（下限语义）`)

  // ── ③ 真仓：四条今天都必须是绿的（并与 §四表里的数同源）
  const r = checkFacts()
  const redIds = (r.rows ?? r.facts ?? []).filter((x) => x.ok === false).map((x) => x.id)
  for (const id of want) {
    assert.ok(!redIds.includes(id), `${id} 在今天这棵树上红了 ⇒ 扫描规模掉到了下限以下（或文档被改大）`)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// ★★★★★ 第 109 轮：`checkRepo()` 的**按进程缓存** —— 起因是一次**我自己造成的超时**
// ══════════════════════════════════════════════════════════════════════════════
//
// 第 107 轮那四条事实每条都调一次 `checkRepo()`（单次 **372ms**）⇒ `checkFacts()` **+19%**。
// 而本套件的用例③（"逐条做反面控制"）会调 `checkFacts()` **每条事实一次（~30 次）**
// ⇒ 我那次改动给它加了 **约 45 秒**。
//
// ★★★ 后果不是"慢一点"：`run-ci.mjs:130` 的 `TEST_SUITE_TIMEOUT_MS = 300000`（5 分钟），
// 而实测 `.ci/r108-full/suites/` 里 `boundary-facts` 那份日志**只有 `[超时现场]`** ——
// **没有 `ℹ pass` 也没有 `ℹ fail`**。
//
// > ★★★★★ **一条超时的判据，与一条"没跑"的判据，输出完全一样** ——
// > 而这套判据存在的全部意义就是"别让一个数字静默失去检查对象"。
// > 我自己那条新判据，**把整套判据推进了这个状态**。
test('㉕ ★★★★★ `checkRepo()` 缓存：同一趟进程里不重复扫盘，且**清得掉**', () => {
  // ── ① 缓存**真的生效**（否则那 45 秒的解法是假的）
  const a = checkRepo()
  const b = checkRepo()
  assert.equal(a, b, '两次 `checkRepo()` 返回的**不是同一个对象** ⇒ 缓存没生效（那 45 秒还留着）')

  // ── ② 缓存**清得掉**，而清完拿到的是**新的**对象
  //    ★ 这一步是**反向控制**：只有"能清"才允许上游在改了文档之后重新取值。
  //      少了它，"缓存没清"与"判据咬不住"在输出里长得一样，而处置相反。
  clearCheckRepoMemo()
  const c = checkRepo()
  assert.notEqual(c, a, '`clearCheckRepoMemo()` 之后返回的**还是那个旧对象** ⇒ 清缓存是假的')
  assert.deepEqual(c.reading.scanned, a.reading.scanned,
    '清缓存后**扫描量变了** ⇒ 这一趟里仓库文件真的变了，或 `trackedFiles()` 不稳定')

  // ── ③ 三条事实**共用一个**缓存条目（不是各扫各的）
  //    ★ 这条防的是"有人把缓存键改成每条事实一个"——那等于没缓存。
  const ctx = defaultContext()
  const s1 = ctx.designBoundaryScans()
  const s2 = ctx.designBoundaryScans()
  assert.notEqual(s1, undefined)
  assert.equal(s1['no-second-agent-loop'], s2['no-second-agent-loop'],
    '两次派生的扫描量不一致 ⇒ 缓存键不对，或扫描不稳定')
})

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第 118 轮第十三轮（业主确认 c）：源码注释里的**裸坐标 + 具名符号**
//
// 这一层此前被明确记为"做不了"（`source-original-citations-on-line` 的 why 里那句
// "只给坐标、不抄原文……要判它们必须读语义"）。它确实需要语义**当且仅当**注释
// 没有点名符号；点了名的那些是机械可判的。实测全仓 9 处、当时 6 处是坏的。
// ══════════════════════════════════════════════════════════════════════════

test('⑳ ★★★ 形状抽取：只认注释行，且「的」两侧有没有空格都要认', () => {
  // ① 注释行里的正常写法
  assert.deepEqual(citeSymbolReferences('// 见 `a/b.mjs:12` 的 `foo`'),
    [{ line: 1, target: 'a/b.mjs', n: 12, sym: 'foo' }])
  // ② ★ 边界：**同一句话写在代码行的字符串里** ⇒ 不在判据面内。
  //    这不是理论边界：我自己的 FACTS 条目里就为了讲这次缺陷，在 `why`（字符串）
  //    里**逐字引用**了一处**写错的**坐标 —— 只扫注释行，这条判据才不会对自己开火。
  assert.deepEqual(citeSymbolReferences("const s = '见 `a/b.mjs:12` 的 `foo`'"), [])
  // ③ 「的」两侧没空格也要认。★ 实测这个写法真实存在，而一个**更严的前置过滤**
  //    会静默漏掉它（本轮真踩：读数从 9 变成 8）——见 `scanBareCoordinateSymbols`。
  assert.equal(citeSymbolReferences('// 见 `a/b.mjs:12`的`foo`').length, 1)
  // ④ 负面控制：只给坐标、不点名符号 ⇒ **不是**这条判据管的形状（那是剩下的盲区）
  assert.deepEqual(citeSymbolReferences('// 见 `a/b.mjs:12`'), [])
  assert.deepEqual(citeSymbolReferences('// 见 `a/b.mjs:12` 的那一段'), [])
})

test('⑳b ★★★ 判决的四种结局 + ±25 行的窗口边界（注入目标读取，不碰真文件）', () => {
  const at = (n) => Array.from({ length: 80 }, (_, i) => (i === n - 1 ? 'const foo = 1' : '// 空行'))
  const target = (lines) => ({ resolveTarget: () => 'target.mjs', readTarget: () => lines })
  const ref = { line: 1, target: 'target.mjs', n: 40, sym: 'foo' }

  // ① 就在那一行 ⇒ ok
  assert.equal(citeSymbolVerdict(ref, target(at(40))).kind, 'ok')
  // ② 窗口**边界上**（±25）⇒ ok —— 边界两侧各钉一次，窗口才是"量出来的"
  assert.equal(citeSymbolVerdict(ref, target(at(40 - CITE_SYMBOL_WINDOW))).kind, 'ok')
  assert.equal(citeSymbolVerdict(ref, target(at(40 + CITE_SYMBOL_WINDOW))).kind, 'ok')
  // ③ 越界 1 行 ⇒ broken（本轮真缺陷的形状：`resolveRunPermissions` 差 59 行）
  assert.equal(citeSymbolVerdict(ref, target(at(40 - CITE_SYMBOL_WINDOW - 1))).kind, 'broken')
  assert.equal(citeSymbolVerdict(ref, target(at(40 + CITE_SYMBOL_WINDOW + 1))).kind, 'broken')
  // ④ 文件在、但**没有这一行** ⇒ broken（与"文件不在"分开报，处置不同）
  assert.equal(citeSymbolVerdict({ ...ref, n: 999 }, target(at(40))).kind, 'broken')
  // ⑤ 目标解析不到 ⇒ unresolved，**不判坏**（目标可能在另一棵检出里）
  assert.equal(citeSymbolVerdict(ref, { resolveTarget: () => null, readTarget: () => [] }).kind, 'unresolved')
  // ⑥ 读不出来 ⇒ unresolved
  assert.equal(citeSymbolVerdict(ref, { resolveTarget: () => 'x', readTarget: () => null }).kind, 'unresolved')
})

test('⑳c ★★★ 真仓库：这条判据的面不许是空的，且两条守卫都真的会红', () => {
  // ① 面不是空的 —— 否则下面那句"0 处坏"是空的
  const s = scanBareCoordinateSymbols()
  assert.ok(s.total >= 7, `扫描面只有 ${s.total} 处 ⇒ "0 处坏"什么也证明不了`)
  assert.equal(s.broken.length, 0, `真仓库有漂了的裸坐标：\n${s.broken.join('\n')}`)
  // ② `security/` 必须在面内：它是**实测漏掉过一处**的那个根
  //    （直接抄邻居的根目录表会漏，见 `CITE_SYMBOL_ROOTS` 的注释）
  assert.ok(CITE_SYMBOL_ROOTS.includes('security'),
    '`security/` 不在扫描面里 ⇒ 本轮实测的那一处漏网会原样回来')
  // ③ 缓存真的在起作用：这一层要**走一遍全仓**，而两条事实都读它。
  //    没有缓存 ⇒ 每条事实各走一遍（本套件贴着 300 秒上限，见 `⑪` 的同一条理由）。
  assert.equal(scanBareCoordinateSymbols(), scanBareCoordinateSymbols(),
    '两次调用不是同一个对象 ⇒ 缓存没生效，全仓会被走两遍')
  clearBareCoordinateSymbolsMemo()
  assert.equal(scanBareCoordinateSymbols().total, s.total,
    '清缓存后读数变了 ⇒ 这一趟里仓库文件真的变了，或扫描不稳定')

  // ④ 载荷控制一：喂一处坏引用 ⇒ **只它自己**红
  const brokenPayload = checkFacts({
    ctx: {
      ...defaultContext(),
      bareCoordinateSymbols: () => ({ total: 9, ok: 8, broken: ['x.mjs:1 → y.mjs:2 的 `foo`：±25 行里找不到 `foo`'], unresolved: [] }),
    },
    only: ['source-comment-coordinate-names-its-symbol'],
  })
  assert.deepEqual(idsOf(brokenPayload), ['source-comment-coordinate-names-its-symbol'],
    '喂了一处坏引用而那条判据没红 ⇒ 它是装饰')

  // ⑤ 载荷控制二：**把面抽空** ⇒ 空转守卫必须红
  //    （"扫描面塌了"与"引用全对"，在只看结果串的时候是同一个东西）
  const emptyPayload = checkFacts({
    ctx: {
      ...defaultContext(),
      bareCoordinateSymbols: () => ({ total: 3, ok: 3, broken: [], unresolved: [] }),
    },
    only: ['source-comment-coordinate-symbol-surface-not-empty'],
  })
  assert.deepEqual(idsOf(emptyPayload), ['source-comment-coordinate-symbol-surface-not-empty'],
    '面被抽空到 3 处而守卫没红 ⇒ 那条守卫是装饰')
})
