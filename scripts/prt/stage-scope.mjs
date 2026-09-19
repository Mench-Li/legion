// scripts/prt/stage-scope.mjs
// ============================================================================
// 「**名字像**」与「**真的跑到**」不是同一个东西：`--only <阶段>` 的范围。
//
// ---------------------------------------------------------------------------
// ## 它补的是哪一格（第 35 轮，被我自己踩出来的）
//
// 本轮的收尾复核里，我用
//
//     node scripts/ci/run-ci.mjs --only boundary
//
// 当作"边界类判据都验过了"，并在报告里写了"10 条判据全绿"。
// 而 **`boundary-facts` 根本不在 `boundary` 阶段里**——它在 **`test`** 阶段：
//
//     { label: 'boundary-facts（PRT-611 续：…）', files: ['scripts/prt/boundary-facts.test.mjs'] }
//
// `boundary` 阶段是**另一件事**：
//
//     { name: 'boundary', label: 'DSH 执行面边界（PRT-108 棘轮）+ DSH 出处锚点漂移（PRT-211）' }
//
// 于是那次"验证"**一个字节都没跑到**要验的那个判据；而它的输出写着 `boundary PASS`。
// 结果：那一轮的收尾提交把一个**红的**判据发了出去（`handover-ci-prose-matches-table`，
// 散文写 873、表里 873594ms 四舍五入是 874——**我把四舍五入写成了截断**）。
//
//   > 一个叫 `boundary` 的阶段，与一个叫 `boundary-facts` 的判据，
//   > 在 `--only boundary` 的输出里是同一个东西——
//   > 只不过前者真的跑过，而后者一次都没跑。
//
// ★ 这正是本仓那一族的**第 13 个形态**：一个**断言**，没有任何东西交叉核对它。
//   这一条的断言是"边界类判据验过了"，而没有任何东西核对"它到底跑了哪些判据"。
//
// ---------------------------------------------------------------------------
// ## 判据：每一个"名字上的相似"都必须是**声明过的**
//
// 不判"这个相似该不该存在"（阶段名与套件名各自都合理，改名会伤到别处）。
// 判的是**它有没有被写下来**：
//
//   R1  每一个碰撞（阶段名是套件名的前缀、或反过来）都必须在 `DISAMBIGUATION` 里
//   R2  表里每一条都必须**仍然是**一个真碰撞（否则是过期声明 ⇒ 与
//       `NOT_FORWARDED_YET` 的 stale 同形）
//   R3  两侧都要非空（阶段名与套件名都读得到）——否则判据在空集上通过
//
// ⇒ 下一个把 `--only <阶段>` 当成"那一类都验过了"的人，会在表里读到一句
//   "这个阶段**不跑**那个套件"。
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO } from './reachability.mjs'
import { suiteFilesFromCi } from './suite-counts.mjs'

export const CI_PATH = join(REPO, 'scripts', 'ci', 'run-ci.mjs')

/**
 * 已声明的"名字像但不覆盖"清单：阶段名 → 该阶段**不跑**的套件名 → 一句话说明。
 *
 * ★ 这张表是**人写的、可审计的**。`stage` 那一项尤其值得看：
 *   阶段名叫 `stage`，而 `stage-scope`（本判据）在 `test` 阶段里。
 */
export const DISAMBIGUATION = Object.freeze({
  boundary: Object.freeze({
    'boundary-facts': '`boundary` 阶段 = DSH 执行面边界棘轮 + DSH 出处锚点漂移（PRT-108/211）；'
      + '`boundary-facts` 判据在 **`test`** 阶段。★ 第 35 轮我正是拿 `--only boundary` '
      + '当成了它的验证，结果把一个红的判据发了出去。',
  }),
  doc: Object.freeze({
    'doc-table': '`doc` 阶段 = 文档表格渲染/结构检查；`doc-table` 判据（表格完整性）在 `test` 阶段。',
    'doc-render': '`doc` 阶段 = 文档表格渲染/结构检查；`doc-render` 判据在 `test` 阶段。',
  }),
  stage: Object.freeze({
    'stage-scope': '★ **这一条是判据自己抓出来的**：本判据的文件名就叫 `stage-scope`，'
      + '而 CI 里有一个阶段叫 `stage`——所以 `--only stage` **不跑**本判据，它在 `test` 阶段。'
      + '加这条判据的那一次改动立刻制造了这处碰撞，而它当场变红（见 §5.18）。',
  }),
})

/** 从 `run-ci.mjs` 读出**阶段名**（阶段登记表里 `name: 'x', label:` 的那些）。 */
export function stageNames(ciText) {
  return [...new Set([...String(ciText).matchAll(/name:\s*'([a-z][a-z0-9-]*)',\s*label:/g)].map((m) => m[1]))]
}

/**
 * 找出所有"名字上相似"的（阶段名, 套件名）对。
 *
 * 相似 = 一方是另一方的前缀（`boundary` / `boundary-facts`、`doc` / `doc-table`）。
 * ★ 用前缀而不是"包含"：`包含` 会把 `test` 与 `latest-report` 这类无关的组合也抓进来，
 *   于是这张表会长到没人读——而没人读的表与没有表是同一个东西。
 */
export function collisions({ stages, suites }) {
  const out = []
  for (const s of stages) {
    for (const t of suites) {
      if (t === s) continue
      if (t.startsWith(s) || s.startsWith(t)) out.push({ stage: s, suite: t })
    }
  }
  return out
}

/**
 * 核对：每个碰撞都声明过，且没有过期声明。
 *
 * @param {{stages: string[], suites: string[], table?: object}} input
 */
export function checkStageScope({ stages, suites, table = DISAMBIGUATION }) {
  const violations = []
  // R3：两侧非空（否则判据在空集上通过）
  if (stages.length === 0) {
    violations.push({ id: 'no-stages', message: '一个 CI 阶段名都没读到 ⇒ 这条判据**什么都没查**。' })
  }
  if (suites.length === 0) {
    violations.push({ id: 'no-suites', message: '一个 CI 套件名都没读到 ⇒ 这条判据**什么都没查**。' })
  }
  if (violations.length > 0) return { ok: false, violations, pairs: [] }

  const pairs = collisions({ stages, suites })
  const seen = new Set()
  for (const p of pairs) {
    seen.add(`${p.stage}\u0000${p.suite}`)
    const declared = table[p.stage]?.[p.suite]
    if (declared === undefined) {
      violations.push({
        id: 'collision-undeclared',
        message: `阶段 \`${p.stage}\` 与套件 \`${p.suite}\` 名字上相似，而这张表里没声明 ⇒ `
          + `下一个用 \`--only ${p.stage}\` 当验证的人会以为 \`${p.suite}\` 跑过了。`
          + '（第 35 轮真发生过：`--only boundary` 没跑 `boundary-facts`。）',
      })
    } else if (typeof declared !== 'string' || declared.length < 20) {
      violations.push({
        id: 'collision-note-too-short',
        message: `\`${p.stage}\` ↔ \`${p.suite}\` 的说明太短——`
          + '没有理由的声明，与"我随手记了一笔"是同一个东西。',
      })
    }
  }
  // R2：过期声明
  for (const [stage, entries] of Object.entries(table)) {
    for (const suite of Object.keys(entries)) {
      if (!seen.has(`${stage}\u0000${suite}`)) {
        violations.push({
          id: 'collision-stale',
          message: `表里写着 \`${stage}\` ↔ \`${suite}\`，而它们**今天不再是**一个碰撞 `
            + '（阶段名或套件名改过？）⇒ 这一条该删。',
        })
      }
    }
  }
  return { ok: violations.length === 0, violations, pairs }
}

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ ciPath = CI_PATH } = {}) {
  const ciText = readFileSync(ciPath, 'utf8')
  return {
    ...checkStageScope({
      stages: stageNames(ciText),
      suites: [...suiteFilesFromCi(ciText).keys()],
    }),
    stages: stageNames(ciText),
    suiteCount: suiteFilesFromCi(ciText).size,
  }
}

// ── CLI：`node scripts/prt/stage-scope.mjs`（只读）───────────────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

if (isMain) {
  const r = checkRepo()
  console.log(`CI 阶段 ${r.stages.length} 个：${r.stages.join('、')}`)
  console.log(`套件行 ${r.suiteCount} 个`)
  console.log(`名字上相似的组合 ${r.pairs.length} 处（全部已声明）：`)
  for (const p of r.pairs) console.log(`  \`--only ${p.stage}\` **不跑** 套件 \`${p.suite}\``)
  if (r.ok) {
    console.log('\n✅ 每一处"名字像"都写下来了')
    process.exit(0)
  }
  console.log('')
  for (const v of r.violations) console.log(`  ✖ [${v.id}] ${v.message}`)
  process.exit(1)
}
