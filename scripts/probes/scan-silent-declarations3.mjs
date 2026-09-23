/**
 * v3：真正的"哑声明" = 在**整个仓库**里出现次数 == 它的声明次数。
 *
 * ## 为什么 v2 不够
 *
 * v2 只看声明所在的那一个文件，于是把 `containsSecrets` / `redacted` / `ok`
 * 这一大批**返回值字段**全列了进来——它们的读者在**调用方**那里
 * （`result.ok`、`plan.containsSecrets`）。那不是缺陷，那是函数的输出。
 *
 * 把两个条件**同时**要求上，剩下的才是 `keepsSecrets` 那一种：
 *   · 本文件里没读（出现次数 == 声明次数）
 *   · 别的文件里也没读（**全仓**出现次数 == 声明次数）
 *
 *   > 一个"返回值字段"与一个"哑声明"，在只看**它自己那个文件**时
 *   > 是同一个东西——区别只在别处有没有人接住它。
 *
 * ★ 仍然自带正对照：造一个真哑的、一个本文件读的、一个别处读的，
 *   扫描器必须只命中第一个。跑不出正对照的扫描器，报"零个"不算数。
 *
 * ## ★★★ v4（2026-09-18）：v3 被**文档本身**弄瞎了 —— 而正对照看不见这件事
 *
 * 另一会话在 `scripts/prt/boundary-facts.mjs` 里给那三个字段各加了一条**手钉**：
 *
 *     text: 'wireChecked: true,',   // 还有 literalWouldMatchNothing / whenUnattended
 *
 * `scripts/` **在 v3 的扫描面里**，而"出现次数"用的是纯词频 ⇒
 * 那三句话里的**字符串字面量**被当成了"别处有人读它"。
 * 于是 v3 报 **0 个哑声明**，而**那三个一个都没改**。
 * 因果已实测（`scripts/probes/probe-pin-blinds-scanner.mjs`）：
 * 只把那**一个文件**排除出累加，三个**全部**回来了。
 *
 *   > 一个"有人真的读了它"与一个"有人**在文档里提到了它**"，
 *   > 在纯词频的判据里是同一个东西——
 *   > 而**前者是修好了，后者只是被人记下来了**。
 *
 * ⇒ 更要命的是**正对照抓不到这个**：它造的三种字段分别"真哑/本文件读/别处读"，
 *   三种都是**代码**读法。**对照组与被测方法共享同一个盲点**，
 *   所以方法瞎掉的时候对照照样 ✓。
 *
 *   > 一个只能造出"一种伤害"的对照，对另一种伤害是**假的**。
 *
 * ⇒ v4 的两处改动：
 *   ① `countIn` 只数**代码**（先去掉注释与字符串字面量）；
 *   ② 正对照**补一种字段**：只在注释/字符串里被提到 ⇒ 必须**仍然**被报出来。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'

/**
 * 去掉注释与字符串字面量，只留**可执行代码**（保留换行以维持行结构）。
 *
 * ★★ 第一版**吞掉了成段代码**，而我的自检看不见：它专门保留字符串里的换行，
 *   于是"行数保留率"恒为 1.000（实测 584 个文件全是 1.000），
 *   **代码没了、行数没变**。症状是它报出一个假哑声明 `unregistered`
 *   （`orchestrator/state-machine/failure.mjs`），而那个词在
 *   `scripts/prt/baseline-snapshot.mjs` 里**代码**出现 3 次、被它吃成 0 次。
 *
 *   > 一个"这个词没有读者"与一个"我的去字符串函数把有读者的那一段吞了"，
 *   > 在只数词频的输出里长得一模一样——**而后者会让扫描器报出更多"哑声明"，
 *   > 也就是看起来更勤快。**
 *
 *   ★ 更该记的是：**我给它配的那条自检（行数保留率）结构上抓不到这个**
 *   ——因为删除时故意保留了换行。*判据与被判的东西共享同一个盲点。*
 *
 * ★ 根因：**正则字面量**。`/.../ ` 里的引号（例如 `/['"]/`）会把词法器带进
 *   "字符串模式"，从那里一路吞到下一个引号——可能几百行。
 *   ⇒ 修法：用"上一个有意义字符"判断 `/` 是**除号**还是**正则开头**
 *   （括号/逗号/等号/return 之后是正则；标识符、数字、`)`、`]` 之后是除号）。
 *   ★ 判错时的兜底：正则**不跨行**，所以在换行前没闭合就**回退**，按除号处理。
 */
function codeOnly(src) {
  let out = ''
  let i = 0
  const n = src.length
  let prev = '' // 上一个"有意义"的字符（空白不算）
  const regexAllowedAfter = (ch) => ch === '' || !/[A-Za-z0-9_$)\]}]/.test(ch)
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++ }
      i += 2
      continue
    }
    if (c === '/' && regexAllowedAfter(prev)) {
      const start = i
      i++
      let inClass = false
      let closed = false
      while (i < n) {
        const ch = src[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '\n') break
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) { i++; closed = true; break }
        i++
      }
      if (closed) {
        while (i < n && /[a-z]/i.test(src[i])) i++ // flags
        // 正则本身不输出（它里面可能含标识符字样，但那是模式不是读）
        out += ' ' // 占位，避免把两侧的 token 粘起来
        prev = '/'
        continue
      }
      // 没闭合 ⇒ 判错了，它不是正则，回退按普通字符输出
      i = start
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '\n') out += '\n'
        i++
      }
      i++
      prev = q
      out += ' ' // 占位，避免把两侧的 token 粘起来
      continue
    }
    if (!/\s/.test(c)) prev = c
    out += c
    i++
  }
  return out
}

const ROOTS = ['product', 'runtime', 'team-hub', 'orchestrator', 'security', 'scrum', 'plugins', 'scripts', 'tests']

const allTracked = () => {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.mjs'))
}

function boolFields(src) {
  const m = new Map()
  const re = /^\s{2,}([a-zA-Z_][\w]*)\s*:\s*(true|false)\s*,\s*$/gm
  for (const x of src.matchAll(re)) m.set(x[1], (m.get(x[1]) ?? 0) + 1)
  return m
}

const word = (key) => new RegExp(`(?<![A-Za-z0-9_$])${key.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`, 'g')
const countIn = (src, key) => (src.match(word(key)) ?? []).length

const files = allTracked().filter((f) => ROOTS.some((r) => f.startsWith(`${r}/`)))
// ★ v4：**所有读取都走 `codeOnly`** —— 注释与字符串里的提及不算"有人读它"。
const source = new Map(files.map((f) => [f, codeOnly(readFileSync(f, 'utf8'))]))

// 全仓每个词的"按文件出现次数"，用于快速累加
const rows = []
const seen = new Set()
for (const [f, src] of source) {
  for (const [key, decls] of boolFields(src)) {
    if (seen.has(key)) continue
    seen.add(key)
    // 只算**生产**文件里的声明（用例里造字段很正常）
    const isProd = !f.includes('.test.mjs') && !f.includes('/tests/')
    if (!isProd) continue
    let total = 0
    for (const s of source.values()) total += countIn(s, key)
    if (total <= decls) rows.push({ key, file: f, decls, total })
  }
}

rows.sort((a, b) => b.decls - a.decls || a.key.localeCompare(b.key))

console.log('=== 真·哑声明：全仓出现次数 ≤ 声明次数 ===\n')
if (rows.length === 0) console.log('  （一个都没有）')
for (const r of rows) {
  console.log(`  ★ ${r.key.padEnd(20)} 声明 ${r.decls} 次，全仓出现 ${r.total} 次   ${r.file}`)
}

/**
 * ★★★ v4：把读数**断言**下来，不让它只被打印。
 *
 * 起因是这一轮实测到的那件事：台账（PRT-611）**引用**这个脚本的读数是
 * "还剩 **3 个**"，而脚本后来报 **0 个**——不是有人修了，
 * 是**文档把它们写下来了**（见文件头 v4）。
 *
 *   > 一份被打印出来、但没有任何判据的读数，与一份**没人跑**的读数，
 *   > 在"它变了没有"这个问题上是同一个东西。
 *
 * ⇒ 已知集合写在这里：**新出现一个 ⇒ 红**（那才是这个脚本存在的理由）；
 *   **少一个 ⇒ 也红**（逼人来更新这份名单，而不是让读数悄悄漂走）。
 *   ——与 `scripts/prt/boundary-facts.mjs` 里"手钉关键引用"同一套纪律。
 *
 * ⚠️ 名单只有 3 项，且台账明确记着这三项**故意不修**
 *   （含义不明，改字段就是 PRT-253 §3 禁的"发明默认值"）。
 *   所以这里的红**不是**"去把它们改掉"，而是"去看一眼发生了什么"。
 */
const KNOWN_SILENT = Object.freeze([
  'literalWouldMatchNothing', // runtime/dsh-composition/external-api-scope.mjs:1061
  'whenUnattended', // runtime/dsh-composition/enforcement-mapping.mjs:266
  'wireChecked', // runtime/dsh-composition/runtime-contract-server.mjs:599
])
const found = rows.map((r) => r.key).sort()
const known = [...KNOWN_SILENT].sort()
const added = found.filter((k) => !known.includes(k))
const removed = known.filter((k) => !found.includes(k))
const same = added.length === 0 && removed.length === 0

console.log('')
if (same) {
  console.log(`✔ 已知集合一致（${known.length} 项）：${known.join(', ')}`)
} else {
  if (added.length) {
    console.log(`✖ **新出现**的哑声明：${added.join(', ')}`)
    console.log('  ⇒ 这是这个脚本存在的理由。先确认它是不是真的没有读者，再决定处置。')
  }
  if (removed.length) {
    console.log(`✖ 已知的这几项**不再出现**了：${removed.join(', ')}`)
    console.log('  ⇒ 要么有人真的修了（好），要么**判据被弄瞎了**（这一轮刚发生过一次：')
    console.log('     有人把它们的名字写进了文档，纯词频就把"提及"当成了"读者"）。')
    console.log('     两种情形必须分清楚再去改这份名单。')
  }
}

// ── 正对照 ───────────────────────────────────────────────────────────
const TMP = 'scratch/_scan3'
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
writeFileSync(`${TMP}/probeA.mjs`, [
  'export const T = Object.freeze({',
  '  x: Object.freeze({', '    trulySilent: true,', '  }),',
  '  y: Object.freeze({', '    trulySilent: false,', '  }),',
  '  z: Object.freeze({', '    readHere: true,', '  }),',
  '  w: Object.freeze({', '    readElsewhere: true,', '  }),',
  '  v: Object.freeze({', '    onlyMentionedInProse: true,', '  }),',
  '  u: Object.freeze({', '    readAfterRegex: true,', '  }),',
  '})',
  'export const f = () => T.z.readHere',
  '',
].join('\n'))
// ★★ v4 补的第四种字段：**只在注释与字符串里被提到**。
//   它**没有**任何代码读者 ⇒ **必须仍然被报出来**。
//   少了这一种，"方法把文档提及当成读者"这个盲点就没有对照能看见。
//
// ★★★ v4.1 补的第五种字段：**在读它之前有一个含引号的正则字面量**。
//   它是**真的被读了** ⇒ **必须不被报出来**。
//   这一种钉的是 v4 第一版的真实事故：正则里的引号把词法器带进字符串模式，
//   于是"读"被吞掉、那个字段被**误报**成哑声明
//   （实测：`unregistered` 就是这样被误报的）。
//   *一种"多报了"的伤害，与一种"漏报了"的伤害，需要两种对照。*
writeFileSync(`${TMP}/probeB.mjs`, [
  "import { T } from './probeA.mjs'",
  'export const g = () => T.w.readElsewhere',
  '// 下面这句注释提到了 onlyMentionedInProse，但它不是读者',
  "export const NOTE = 'onlyMentionedInProse 只是个说明用的字符串'",
  "export const RE = /['\"]/",
  'export const h = () => T.u.readAfterRegex',
  '',
].join('\n'))

const srcA = readFileSync(`${TMP}/probeA.mjs`, 'utf8')
const srcB = readFileSync(`${TMP}/probeB.mjs`, 'utf8')
// ★ 与主扫描器**同一口径**：走 `codeOnly`
const codeA = codeOnly(srcA)
const codeB = codeOnly(srcB)
const hits = []
for (const [key, decls] of boolFields(codeA)) {
  const total = countIn(codeA, key) + countIn(codeB, key)
  if (total <= decls) hits.push(key)
}
rmSync(TMP, { recursive: true, force: true })

const posOk = hits.includes('trulySilent')
  && hits.includes('onlyMentionedInProse')
  && !hits.includes('readHere')
  && !hits.includes('readElsewhere')
  && !hits.includes('readAfterRegex') // ★ v4.1
console.log('')
console.log(`${posOk ? '✓' : '✗'} 正对照（**五种**字段各一个）：`)
console.log(`      命中=${JSON.stringify(hits)}`)
console.log('      期望：含 trulySilent（真哑）与 onlyMentionedInProse（只在注释/字符串里被提到）')
console.log('            不含 readHere（本文件代码里读）、readElsewhere（别处代码里读）、')
console.log('                 readAfterRegex（**含引号的正则之后**被读 ⇒ 不许被吞掉）')
if (!hits.includes('onlyMentionedInProse')) {
  console.log('      ⇒ 第四种没命中：**"文档提及"仍被当成了读者**（v3 被弄瞎的那条路）。')
}
if (hits.includes('readAfterRegex')) {
  console.log('      ⇒ ★ 第五种被误报：**正则里的引号把词法器带进了字符串模式**，')
  console.log('        把后面的真读者吞掉了（v4 第一版的真实事故）。')
}
process.exit(posOk && same ? 0 : 1)
