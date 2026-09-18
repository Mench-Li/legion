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
  checkManifestImpersonation,
  STATUS_DOC, LEDGER_DOC, PATCH_YML, REPO, HUB_TOKEN_ENV, WORKBENCH_TOKEN_ENV,
} from './boundary-facts.mjs'

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
      corrupted = before.slice(0, m.index)
        + m[0].replace(/\d+/, (d) => String(Number(d) + 1))
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

    const r = checkFacts({ ctx: withDoc(f.claim.doc, () => corrupted) })
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
  const real = resolve(REPO, 'runtime/dsh-composition/plugins/root-row.mjs')
  const lines = readFileSync(real, 'utf8').split('\n')
  // 先核载具本身（载具坏了，下面的结论就不成立）
  assert.match(lines[563], /installEnforcementRoot\(\{/,
    '第 564 行不再是那个调用点 ⇒ 载具失效，先重写这个控制')
  assert.ok(!/installEnforcementRoot\(\{/.test(lines[533]),
    '第 534 行**又**是那个调用点了 ⇒ 旧坐标这一层失去对象，先重写这个控制')
  assert.ok(565 <= lines.length,
    '旧行号居然超范围了 ⇒ 那上一批的判据本来就能抓到，这一节的立论要改')

  // ★ 用**同一份**核法（不重抄逻辑）去钉旧坐标（= 上一轮的正确答案）
  const injected = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/plugins/root-row.mjs',
    line: 534,
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
    line: 564,
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
  const lineNow = lines[762].trim()
  assert.equal(lineNow, 'if (pathScope === null) return undefined', '第 763 行变了，先核它')

  // 差一个字符
  const off = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/tool-request.mjs',
    line: 763,
    text: 'if (pathScope === null) return undefined;', // 多个分号
  })])
  assert.equal(checkPinnedCitations(off).broken.length, 1,
    '只差一个字符却没事 ⇒ 逐字比对没在逐字比')

  // ★ 而**行尾空白**差异被 `trim()` 吸收（有意：CRLF/尾空格不该假红）——
  //   这是一条**写下来的**边界，不是意外。
  const trailing = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/tool-request.mjs',
    line: 763,
    text: 'if (pathScope === null) return undefined   ',
  })])
  assert.equal(checkPinnedCitations(trailing).broken.length, 0,
    '行尾空白造成了假红 ⇒ 会在 CRLF 检出上乱叫')
  // ⚠️ 已知边界：`trim()` 也吸收了**缩进**，所以缩进变化不会红。
  const indent = Object.freeze([Object.freeze({
    file: 'runtime/dsh-composition/tool-request.mjs',
    line: 763,
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
