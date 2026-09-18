#!/usr/bin/env node
// scripts/prt/boundary-facts.mjs
// ============================================================================
// 把**文档里声称的数字**与**产物里真实的值**对起来——因为这一批我在这方面栽了三次。
//
// ---------------------------------------------------------------------------
// ★ 起因：一个"当时数对过"的数字
//
// 2026-09-18 我核一句承重的 fail-closed 说法时，顺手读到
// `runtime/dsh-composition/patch-layer.mjs` 的 `PATCH_LAYER_ROWS` 是 **5** 行，
// 而 `docs/MULTI-AGENT-FEATURE-STATUS.md` 里那句读数写的是 **4** 行，
// 枚举里也漏了第 5 行。`git log -S` 定位：第 5 行 2026-09-15 就加了，
// **而这句读数没人跟着改**。
//
//   > 一个"当时数对过"的数字，与一个"现在还是对的"数字，
//   > 在文档里长得一样——区别只在有没有人回去数第二遍。
//
// 更早一批我还栽过一个同形的：一个被声明了三处、被读了**零处**的布尔
// （`keepsSecrets`）。两次的形状是同一条：
//
//   > 两份权威清单之间**没有任何机制**保证它们同时正确。
//
// 所以这一份就是那个机制：**文档说 N，产物说 M，不一致就红。**
//
// ---------------------------------------------------------------------------
// ★ 为什么是"文档 ↔ 产物"，而不是"产物 ↔ 产物"
//
// 本仓自己记过一条纪律：**两份手抄件互相核对时，两边一起写错它全绿**。
// 所以这一份校验的**两侧必须是独立读出来的**：
//   · 一侧是**人写的中文句子**里的一个数字（正则从文档正文里取）；
//   · 另一侧是**从产物里推出来的值**（`import` 那个模块、数那份文件）。
// 两侧不同源，一致才有信息量。
//
// ---------------------------------------------------------------------------
// ★ 为什么锚点找不到也要红（`ANCHOR_MISSING`）
//
// 最容易写出的版本是：`const m = re.exec(doc); if (m && m[1] !== n) red`。
// 那种写法在**句子被改写或删掉**时会**静默变绿**——而"这条判据再也不检查
// 任何东西了"与"这条判据检查通过了"，在只有一个 ✅ 的输出里是同一个东西。
//
//   > 一条会静默失去检查对象的判据，比一条不存在的判据更糟：
//   > 后者会让人去写，前者会让人**以为已经有了**。
//
// 所以锚点取不到 ⇒ `ANCHOR_MISSING`，同样是红。
// ============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { specFor, PROCESS_KEYS } from '../../product/process-manifest.mjs'
import { PATCH_LAYER_ROWS } from '../../runtime/dsh-composition/patch-layer.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const STATUS_DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'
export const LEDGER_DOC = 'docs/superpowers/prt/PRT-PROGRESS.md'
export const PATCH_YML = 'runtime/dsh-composition/legion-host.patch.yml'

/** 控制面凭证：执行面**不许**拿到它（spec §2「Runtime 不看业务状态」）。 */
export const HUB_TOKEN_ENV = 'TEAM_HUB_TOKEN'
/** Workbench 的令牌：同上，运行时进程也不该有。 */
export const WORKBENCH_TOKEN_ENV = 'DSH_WORKBENCH_TOKEN'

/**
 * 数出 `legion-host.patch.yml` **代表了多少行声明**。
 *
 * 一个 `insert` 块里的每个 `- id:` 是一行；每个 `patch-over` 块（`- id: <靶子>`）
 * 也是一行。**不数注释**——注释里那些"刻意不进文档"的行正是这份文件存在的理由。
 */
export function patchYmlRepresentedRows(text) {
  const lines = String(text).split('\n')
  let insertRows = 0
  let patchOverRows = 0
  let inInsert = false
  for (const l of lines) {
    if (/^- /.test(l)) {
      inInsert = /^- insert:/.test(l)
      if (!inInsert) patchOverRows++
      continue
    }
    if (inInsert && /^\s{4}- id:/.test(l)) insertRows++
  }
  return { insertRows, patchOverRows, total: insertRows + patchOverRows }
}

/** 真实上下文：读磁盘、读产物。测试可以整份替掉（见 `.test.mjs` 的反面控制）。 */
export function defaultContext() {
  const cache = new Map()
  const doc = (rel) => {
    if (!cache.has(rel)) cache.set(rel, readFileSync(resolve(REPO, rel), 'utf8'))
    return cache.get(rel)
  }
  return {
    doc,
    spec: (key) => specFor(key),
    processKeys: () => PROCESS_KEYS,
    patchRows: () => PATCH_LAYER_ROWS,
    patchYml: () => patchYmlRepresentedRows(doc(PATCH_YML)),
    generatedArtifacts: () => scanSelfDeclaredGenerated(),
  }
}

// ── 类级扫描：自称"生成物"的文件里不许有"任务状态断言" ─────────────────────
//
// ★ 起因见 `patch-yml-asserts-no-task-status`：生成物去复述状态就一定会漂。
//   但那条判据只钉住**一个**文件。这一条把**整类**钉住。
//
// ★ 第一版普查我漏了 `.worktrees` / `.legion-worktrees`，于是扫了 30916 个文件、
//   报出 8 个"必红"——而**那 8 个全在别的工作树的旧副本里**，与这个仓库无关。
//   > 一个把"别人的旧 checkout"算进结论的普查，量的是**磁盘**而不是**仓库**。
//
// ⚠️ 边界：这只覆盖**自称**是生成物的文件（6 个）。不自称的生成物不在扫描面内。
const GENERATED_SELF = Object.freeze([
  /本文件由[^\n]{0,40}生成/,
  /\bGENERATED\b/,
  /不要手改|请勿手改|不要手工编辑|请勿手工编辑/,
  /\bDO NOT EDIT\b/i,
  /此文件(?:由|是)[^\n]{0,30}生成/,
])
const STATUS_VOCAB = Object.freeze(['未完成', '已完成', '待完成', '未开始', '部分完成'])
const SCAN_SKIP = new Set([
  '.git', 'node_modules', '.ci', 'scratch', 'dist', 'build', '.dsh', 'coverage',
  '.worktrees', '.legion-worktrees',
])
const SCAN_EXT = /\.(mjs|js|cjs|ts|json|md|yml|yaml|txt|patch|sql)$/i

function scanSelfDeclaredGenerated() {
  const out = []
  const walk = (dir) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (SCAN_SKIP.has(name)) continue
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p); continue }
      if (!SCAN_EXT.test(name) || st.size > 2_000_000) continue
      let text
      try { text = readFileSync(p, 'utf8') } catch { continue }
      const head = text.slice(0, 3000)
      if (!GENERATED_SELF.some((re) => re.test(head))) continue
      // 找"任务号附近 60 字符内有状态词"的位置
      const offences = []
      for (const w of STATUS_VOCAB) {
        let idx = text.indexOf(w)
        while (idx !== -1) {
          const around = text.slice(Math.max(0, idx - 60), idx + w.length + 60)
          if (/PRT-\d+/.test(around)) offences.push({ word: w, around: around.replace(/\s+/g, ' ').trim() })
          idx = text.indexOf(w, idx + 1)
        }
      }
      out.push({ rel: relative(REPO, p).replace(/\\/g, '/'), offences })
    }
  }
  walk(REPO)
  return out
}

/**
 * 校验表。每一项要么带 `claim`（文档里取一个数字），要么带 `expect`（一个不变量）。
 *
 * ★ 每一项都必须写明 `source`：**"这个真值是从哪个产物推出来的"**。
 *   一个说不出出处的判据，就是一条"谁都改得动"的判据。
 */
export const FACTS = Object.freeze([
  // ── A. 边界不变量（从产物 import 出来的真值）─────────────────────────────
  Object.freeze({
    id: 'runtime-env-excludes-hub-token',
    what: '执行面（`runtime` 进程）**不得**拿到控制面凭证 `TEAM_HUB_TOKEN`',
    why: 'spec §2「Runtime 不看业务状态」；2026-09-18 业主裁定守住这条边界（'
      + '`docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md`）。执行面一旦有 token，'
      + '"读声明"与"改状态"就只差一次调用。',
    source: 'product/process-manifest.mjs → specFor(\'runtime\').envNames',
    derive: (ctx) => ctx.spec('runtime').envNames.includes(HUB_TOKEN_ENV),
    expect: false,
  }),
  Object.freeze({
    id: 'worker-env-includes-hub-token',
    what: '★ **正面对照**：`orchestrator`（worker）**必须**有 `TEAM_HUB_TOKEN`',
    why: '没有这一条，一条"永远返回 false"的坏推导会让上面那条**恒绿**。'
      + '两条合起来才说明"这个推导分得清两种进程"。',
    source: 'product/process-manifest.mjs → specFor(\'orchestrator\').envNames',
    derive: (ctx) => ctx.spec('orchestrator').envNames.includes(HUB_TOKEN_ENV),
    expect: true,
  }),
  Object.freeze({
    id: 'runtime-env-excludes-workbench-token',
    what: '执行面**不得**拿到 Workbench 令牌 `DSH_WORKBENCH_TOKEN`',
    why: '同上一条边界，只是另一个凭证名。',
    source: 'product/process-manifest.mjs → specFor(\'runtime\').envNames',
    derive: (ctx) => ctx.spec('runtime').envNames.includes(WORKBENCH_TOKEN_ENV),
    expect: false,
  }),

  // ── B. 文档里声称的数字（文档 ↔ 产物）──────────────────────────────────
  Object.freeze({
    id: 'patch-rows-doc-count',
    what: '状态文档声称 `PATCH_LAYER_ROWS` 有几行',
    why: '★ 这一条就是本模块的起因：文档写 4、产物是 5，漂了三天没人发现。',
    source: 'runtime/dsh-composition/patch-layer.mjs → PATCH_LAYER_ROWS.length',
    derive: (ctx) => ctx.patchRows().length,
    claim: Object.freeze({
      doc: STATUS_DOC,
      // ★ 锚点里**必须**带上那个反引号常量名。
      //
      //   第一版我写的是 /只声明\s*\*\*(\d+)\*\*\s*行/，而它在**订正说明**那一句里
      //   也有一次命中（"'只声明 **4** 行'并把第 5 行漏在枚举外"——我在文档里
      //   **引用**了自己改掉的那个旧值）。于是这个锚点在一份文档里有**两处**，
      //   判据靠"先出现的那个"选中了正确的那个。
      //
      //   > 一个"碰巧选中了对的那一处"的锚点，与一个"锚点唯一"的锚点，
      //   > 在今天的读数里一模一样——区别只在文档行序变没变。
      //
      //   所以①锚点加上 `PATCH_LAYER_ROWS` 这个反引号名（订正说明那句前面是"原写"）
      //   ②本模块对"锚点命中多于一处"直接判红（`ANCHOR_AMBIGUOUS`），
      //   不靠"我是第一个匹配"这种位置性质。
      re: /`PATCH_LAYER_ROWS`\s*只声明\s*\*\*(\d+)\*\*\s*行/,
      note: '「`PATCH_LAYER_ROWS` 只声明 **5** 行」',
    }),
  }),
  Object.freeze({
    id: 'patch-rows-doc-enumeration-count',
    what: '状态文档那句括号里的**枚举**项数（用 `/` 分隔）',
    why: '数字改对了、枚举没改，是最容易留下的半截修复——'
      + '读的人会照着枚举去理解那个数字。',
    source: STATUS_DOC + ' 的「（硬下限 / … ）」那一句',
    derive: (ctx) => ctx.patchRows().length,
    claim: Object.freeze({
      doc: STATUS_DOC,
      re: /（(硬下限[^）]*)）/,
      parse: (m) => m[1].split('/').map((s) => s.trim()).filter((s) => s !== '').length,
      note: '「（硬下限 / 审批登记 / pre-execute / approval-answerer / **permission-presets**）」',
    }),
  }),
  Object.freeze({
    id: 'patch-rows-doc-mentions-every-row-key',
    what: '枚举里**逐项点到了**每一行（用行 id 的后缀核对）',
    why: '数对了但漏点了某一行的名字，等于把那一行从读者的视野里删掉——'
      + '这正是本模块起因里发生的事（`permission-presets` 既不在数字里、也不在枚举里）。',
    source: 'PATCH_LAYER_ROWS 每行 id 去掉 `legion-enforcement-` 前缀 + STATUS_DOC 的枚举句',
    derive: (ctx) => {
      const seg = /（(硬下限[^）]*)）/.exec(ctx.doc(STATUS_DOC))
      if (!seg) return null
      const listed = seg[1].toLowerCase()
      // 枚举里用的是人话标签，不是行 id——所以只核**能被字符串点到的**那几行，
      // 其余（"硬下限"=hard-floor）由 label 表映射。映射错会立即表现为"没点到"。
      const LABEL = Object.freeze({
        'hard-floor': '硬下限',
        'root': '审批登记',
        'pre-execute': 'pre-execute',
        'approval-answerer': 'approval-answerer',
        'permission-presets': 'permission-presets',
      })
      return ctx.patchRows()
        .map((r) => String(r.id).replace(/^legion-enforcement-/, ''))
        .filter((suffix) => {
          const label = LABEL[suffix]
          if (label === undefined) return true // 表里没有的新行：由上面那条计数判据负责
          return !listed.includes(label.toLowerCase())
        })
        .sort()
        .join(',')
    },
    expect: '', // 空串 = 每一行都被点到了
  }),
  Object.freeze({
    id: 'patch-yml-doc-count',
    what: '状态文档声称 `legion-host.patch.yml` 里有几行落点',
    why: '与上面同一条纪律，只是另一份产物。',
    source: PATCH_YML + ' → patchYmlRepresentedRows().total',
    derive: (ctx) => ctx.patchYml().total,
    claim: Object.freeze({
      doc: STATUS_DOC,
      re: /有\s*\*\*(\d+)\s*行\*\*的落点/,
      note: '「有 **3 行**的落点」',
    }),
  }),
  Object.freeze({
    id: 'patch-yml-asserts-no-task-status',
    what: '**生成物里不许出现任何"状态词"**（连"引用那个词"也不行）',
    why: '★ 这是 2026-09-18 实测到的一处真矛盾：`legion-host.patch.yml` 由 '
      + '`render.mjs` 生成，而它当时写着「**PRT-214 因此仍是未完成状态**」——'
      + '台账已把那一条改判，于是**生成物与权威台账互相矛盾**。'
      + '更尖锐的是：同一份文件下一段自己写着「手写清单会腐烂：……于是文件同时说了'
      + '两句互相矛盾的话，而读到哪一句取决于读的人」——**那句警告是它自己的判据，'
      + '而被违反的正是紧挨着它的上一段**。'
      + '⇒ 状态只有一份权威（PRT 台账）；生成物去复述它，就一定会漂。'
      + '★ 判据取"整类状态词"而不是"某个句式"：第一版我写的是 '
      + '`/PRT-\\d+…仍是未完成/`，而我**在修这句话的同时又把它引用了进去**，'
      + '于是判据当场把**我自己的说明**判成违规。'
      + '*一个只认一种句式的判据，会在"有人引用了那句话"时失效——'
      + '而引用恰恰是修复时最容易发生的事。*',
    source: PATCH_YML + '（生成物）正文里是否出现 未完成/已完成/✅/🟡/⏸/⬜',
    derive: (ctx) => {
      const m = /(未完成|已完成|✅|🟡|⏸|⬜)/.exec(ctx.doc(PATCH_YML))
      return m === null ? '' : m[1]
    },
    expect: '', // 空串 = 生成物正文里一个状态词都没有
  }),
  Object.freeze({
    id: 'no-generated-artifact-asserts-task-status',
    what: '**类级**：任何自称"生成物"的文件里都不许出现"任务号 + 状态词"',
    why: '上一条只钉住 `legion-host.patch.yml` **一个**文件。这一条钉住**整类**——'
      + '因为我这一批做了一次普查（=`scratch/census-generated-status.mjs`），'
      + '结论是**本仓（不含别的工作树）里这一类只有 1 个实例，且已修**。'
      + '普查是"顺路发现"的解毒剂：'
      + '「发现了一处」与「只有一处」在此之前一直是两件事。'
      + '★ 存这条判据的理由不是"今天有 1 个"，而是"**它还会再长出来**"——'
      + '生成器每跑一次就把手写状态重印一遍。'
      + '⚠️ 边界：只覆盖**自称**是生成物的文件；不自称的不在扫描面内。',
    source: '全仓（跳过 .worktrees / .legion-worktrees / node_modules 等）自称生成物的文件正文',
    derive: (ctx) => ctx.generatedArtifacts()
      .filter((g) => g.offences.length > 0)
      .map((g) => `${g.rel}[${g.offences.map((o) => o.word).join(',')}]`)
      .sort()
      .join(' '),
    expect: '', // 空串 = 一个违规的生成物都没有
  }),
  Object.freeze({
    id: 'ledger-total-doc-count',
    what: '台账标题声称"全 N 项"',
    why: '台账总数是它的读者最先看到的数字。',
    source: LEDGER_DOC + ' 里以 `| PRT-` 开头的表格行数',
    derive: (ctx) => ctx.doc(LEDGER_DOC).split('\n').filter((l) => /^\|\s*PRT-\d+\s/.test(l)).length,
    claim: Object.freeze({
      doc: LEDGER_DOC,
      re: /全\s*(\d+)\s*项/,
      note: '台账标题「# PRT 任务进度表（全 145 项）」',
    }),
  }),
])

/**
 * 跑一遍全部事实。返回 `{ ok, checked, violations }`。
 *
 * ★ `checked` 是**实际参与比对**的条数。调用方应当断言它等于 `FACTS.length`：
 *   一个"报 0 条红"的运行，如果它其实一条都没跑，与"全绿"长得一模一样。
 */
export function checkFacts({ ctx = defaultContext() } = {}) {
  const violations = []
  let checked = 0

  for (const fact of FACTS) {
    let actual
    try {
      actual = fact.derive(ctx)
    } catch (err) {
      violations.push({ id: fact.id, code: 'DERIVE_THREW', detail: String(err && err.message) })
      continue
    }

    let claimed
    let claimText = null
    if (fact.claim !== undefined) {
      const text = ctx.doc(fact.claim.doc)
      // ★ 用**全局**匹配数一遍命中次数，而不是只取第一个。
      //
      //   第一版我写的是 `const m = re.exec(text)`，于是"锚点在文档里有几处"
      //   从来没有被读过。而我在写这一批的订正说明时**引用**了自己改掉的那个旧值
      //   （"'只声明 **4** 行'……"），同一份文档里就有了**两处**命中——
      //   判据靠"先出现的那个"选中了对的那一处，纯属行序上的运气。
      //
      //   > 一个"碰巧选中了对的那一处"的锚点，与一个真正唯一的锚点，
      //   > 在今天的读数里一模一样——区别只在文档行序变没变。
      const all = [...text.matchAll(new RegExp(fact.claim.re.source, 'g'))]
      if (all.length === 0) {
        violations.push({
          id: fact.id,
          code: 'ANCHOR_MISSING',
          detail: `在 ${fact.claim.doc} 里找不到锚点 ${String(fact.claim.re)}`
            + `（文档里那句话是：${fact.claim.note}）。`
            + '句子被改写或删掉时**也是红**——否则这条判据会静默地不再检查任何东西',
        })
        continue
      }
      if (all.length > 1) {
        violations.push({
          id: fact.id,
          code: 'ANCHOR_AMBIGUOUS',
          detail: `锚点在 ${fact.claim.doc} 里命中了 ${all.length} 处，`
            + '所以"判据说的是哪一个数字"取决于文档行序。'
            + `命中处：${all.map((m) => JSON.stringify(m[0].replace(/\s+/g, ' ').slice(0, 60))).join(' / ')}。`
            + '修法是让锚点带上足够的上下文（例如前面那个反引号常量名），**不是**改成取第一个',
        })
        continue
      }
      const m = all[0]
      claimText = m[0].replace(/\s+/g, ' ').trim()
      claimed = fact.claim.parse ? fact.claim.parse(m) : Number(m[1])
    } else {
      claimed = fact.expect
    }

    checked++
    if (!Object.is(actual, claimed)) {
      violations.push({
        id: fact.id,
        code: 'MISMATCH',
        what: fact.what,
        source: fact.source,
        actual,
        claimed,
        claimText,
      })
    }
  }

  return { ok: violations.length === 0, checked, total: FACTS.length, violations }
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

function main() {
  const r = checkFacts()
  for (const f of FACTS) {
    const hit = r.violations.find((v) => v.id === f.id)
    const mark = hit ? '✖' : '✔'
    console.log(`${mark} ${f.id}`)
    console.log(`    ${f.what}`)
    if (hit) {
      if (hit.code === 'MISMATCH') {
        console.log(`    ✖ 文档说 ${JSON.stringify(hit.claimed)}，产物是 ${JSON.stringify(hit.actual)}`)
        console.log(`      产物出处：${hit.source}`)
        if (hit.claimText) console.log(`      文档原句：${hit.claimText}`)
      } else {
        console.log(`    ✖ [${hit.code}] ${hit.detail}`)
      }
    }
  }
  console.log('')
  console.log(`boundary-facts: ${r.ok ? 'PASS' : 'FAIL'}（参与比对 ${r.checked}/${r.total}，红 ${r.violations.length}）`)
  if (r.ok) {
    const n = defaultContext().generatedArtifacts().length
    console.log(`  其中类级扫描面：自称"生成物"的文件 ${n} 个（跳过 .worktrees / node_modules 等）`)
  }
  process.exit(r.ok && r.checked === r.total ? 0 : 1)
}

if (isMain) main()
