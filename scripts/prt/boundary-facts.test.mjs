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

import {
  FACTS, checkFacts, defaultContext, patchYmlRepresentedRows,
  scanCommitCitations, scanLineCitations,
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
