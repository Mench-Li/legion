// scripts/prt/declaration-mirrors.mjs
// ============================================================================
// 判据：**导出的常量表，与它自己被手写复述的那份，是不是同一个东西**。
//
// ---------------------------------------------------------------------------
// ## 这条判据从哪来（第 40 轮那个真缺陷）
//
// `product/launcher/run-record.mjs` 里有一张 ★★★ 声明表：
//
//     export const RUN_RECORD_OPTIONAL_FIELDS = Object.freeze(['peakResource'])
//     // 注释：新读数一律加在**这里**，不要加进 RUN_RECORD_FIELDS
//
// 而 `buildRunRecord` 与 `validateRunRecord` **各自手写** `'peakResource'` 这个名字。
// 于是那张表**没有任何机械消费者**：照它的注释加一个字段，得到的是
// **写不出去 + 不被校验 + 记录看起来完全正常**（实测见 `scripts/probes/_probe-record-drop.mjs`）。
//
//   > 一张只写在注释里的扩展点，与一条真的能扩展的通路，
//   > 在"下一个人照做之后会不会发现问题"这个读数上是同一个东西：都不会发现。
//
// ## 判据的形状
//
// 对每一张**导出且冻结的字符串数组** `T`：
//
//   · `iterSites(T)`  —— 仓库里**遍历**它的位置数（`for…of` / `...T` / `T.map` / `T.includes` …）；
//   · `mirrors(T)`    —— **同一个文件里、声明块之外**，把 `T` 的成员**当字面量写出来**的次数。
//
//   `iterSites === 0 && mirrors > 0` ⇒ 这张表是**装饰**：它声明了一批东西，
//   而真正被读的是手写的那一份，两份已经开始漂。
//
// ★★ 为什么这个组合才是信号，而不是"没被遍历"就报（第 40 轮我第一版探针就是这么错的）：
//   仓库里大量 `*_CODES` / `*_ERRORS` **本来就该**按 `CODES.FOO` 取值、不该被遍历，
//   单看"没被遍历"会报出 **366/702** 个——那是**口径**错，不是仓库错。
//   加上"同文件里有人把成员手写了一遍"这个条件，才落在真正的形状上。
//
// ## 自证（本判据唯一的防瞎手段）
//
// `SELF_CHECK` 里放一份**第 40 轮修复前的真实代码形状**（逐字取自那个文件的旧版本），
// 判据必须**报出它**；再放一份修复后的形状，判据必须**放行**。
// 没有这一步，一个"什么都没查"的判据与一个"全都对"的判据在输出上是同一个东西。
// ============================================================================

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')

/** 声明表的形状：`export const NAME = Object.freeze([...])`，成员是字符串字面量。 */
export const DECL_RE = /^export const ([A-Z][A-Z0-9_]*)\s*=\s*Object\.freeze\(\[([^\]]*)\]/gm

/**
 * 已知的、**故意**保持"声明了但没人遍历"的表。
 *
 * ★ 每一条都要写 `why`（为什么它可以这样）与 `owner`（谁裁的）。
 *   R2 会把**已经不再装饰**的条目判红——所以这张表不会变成一句没人核的话。
 *
 * ★★ `WRITABLE_ROLES` **曾经**在这里。第 42 轮把它**修好了**，而不是继续豁免：
 *   读代码发现它不是"一处需要记得的耦合"，而是**两条静默失效路径** ——
 *   ① `DIR_ROLES` 的遍历兜底成 `layout?.logDir` ⇒ 新角色被**当成 logDir** 检查，
 *      **报在正确的角色名下、引用着另一个角色的值**；
 *   ② 安装目录那条安全检查自己手写了一个四元对象 ⇒ 往 `WRITABLE_ROLES` 加角色
 *      就**根本不被检查**。
 *   ⇒ 取法收敛到 `DIR_ROLE_READERS`，两侧都遍历声明，声明了没取法**一进模块就抛**。
 *
 *   > 豁免一条判据，与修掉它所指的那处缺陷，
 *   > 在"下一次有人加一个角色时会不会被拦下"这个读数上是同一个东西——
 *   > 只不过前者把这件事记在了我的账上，后者记在了代码里。
 *
 *   ★ 修好之后 R2 **立刻**把这条豁免判成过期（`stale-exemption`）——
 *   豁免机制自己要求把它删掉。这就是 R2 存在的意义。
 *
 * ★★ 第 43 轮：`BPE_ARTIFACT_FIELDS` 那一条也**收回**了。
 *   我当时写的理由是"清单被用来**校验/描述**产物"——而量下来它**没有任何读者**：
 *   `runtime/context/index.mjs` 只是再导出，`bpe.test.mjs` 只断言名字在不在。
 *   更糟的是清单**已经少了一个字段**（产物有 `ranks`、清单没有）——
 *   那句"用来校验"当时就是空话。修法同第 42 轮：清单升格成唯一的形状判据，
 *   在产物构造完那一刻校验它（少了/多了都抛）。
 *
 *   > 两次豁免，两次都是我**自己**写的"它被用了，只是用法特殊"。
 *   > 两次去量，两次都发现"被用了"这件事**从来没发生过**。
 *   > ⇒ 豁免里凡是写"它其实被用来做 X"的，都必须能指出**做 X 的那一行代码**；
 *   >   指不出来，就该修代码，而不是写理由。
 *
 * ★★ 最终只剩这一条，而它的形状与前两条**根本不同**：
 *   `PREFLIGHT_VERDICTS` 是**真被用了**（`preflightVerdictKind()` 遍历归类表），
 * ★★ 第 43 轮：**最后一条也收回了，豁免表空了。**
 *   `PREFLIGHT_VERDICTS` 原来被判为"命名巧合"（`ok`/`blocked`/`unknown` 恰好也是
 *   结果对象的字段名）。但这一轮我给预检加了 `preflightVerdictKind()` ——
 *   判定词表现在**真的**驱动分桶，于是它不再是装饰表，豁免自然到期。
 *
 *   ★ 三次豁免，三次都以"修好代码"收场：
 *     ① `WRITABLE_ROLES`（第 42 轮）——两条静默失效路径；
 *     ② `BPE_ARTIFACT_FIELDS`（第 43 轮）——清单少一个字段且没有任何读者；
 *     ③ `PREFLIGHT_VERDICTS`（第 43 轮）——补上真消费者之后自己过期。
 *
 *   > 豁免表空了，不是因为没有边界情况，而是因为**每一处边界情况
 *   > 最后都发现是代码的问题，不是判据的问题**。
 *
 *   ⚠ 这张表**保留**（不是删掉）：它是"人判断"的留痕位。
 *   将来真的遇到"重建"与"同名"分不开的那一天，理由写在这里，
 *   R2 会在它过期时提醒把它收回去。
 */
export const DECLARED_MIRRORS = Object.freeze([])

/** 从声明里取出成员名（只有纯字符串字面量才算；含变量/表达式的表跳过）。 */
export function membersOf(listText) {
  const out = []
  for (const raw of listText.split(',')) {
    const t = raw.trim()
    if (t === '') continue
    const m = /^'([^']*)'$/.exec(t) ?? /^"([^"]*)"$/.exec(t)
    if (m === null) return null // 有非字面量成员 ⇒ 这张表不适用本判据
    out.push(m[1])
  }
  return out.length > 0 ? out : null
}

/** 仓库里**被跟踪**的 `*.mjs`（不含用例）。 */
export function trackedModules(exec = execFileSync) {
  return exec('git', ['ls-files', '*.mjs'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => !f.endsWith('.test.mjs'))
}

/** `git grep`：**只有退出码 1 才是"没有匹配"**；其它非零必须上抛（不许吞成"没有匹配"）。 */
export function gitGrep(pattern, exec = execFileSync) {
  try {
    return exec('git', ['grep', '-n', '-E', pattern], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').filter(Boolean)
  } catch (e) {
    if (e.status === 1) return []
    throw e
  }
}

/** 遍历点：`for…of T` / `...T` / `T.map|filter|every|some|forEach|includes|reduce`。 */
export function iterPattern(name) {
  return `(for\\s*\\(\\s*const\\s+\\w+\\s+of\\s+${name}\\b`
    + `|\\[\\.\\.\\.${name}\\]|\\.\\.\\.${name}[,)]|\\.\\.\\.${name}\\.`
    + `|${name}\\.(map|filter|every|some|forEach|includes|reduce|join|indexOf|find|flatMap)\\b`
    + `|of\\s+${name}\\b)`
}

/**
 * ★★ 一次 `git grep` 取回**所有**候选名字的出现行。
 *
 *   第一版是"每个名字一次 `git grep`"——238 张表 = 238 次子进程，
 *   这一次扫描要 **236 秒**。判据本身跑得慢到没人愿意跑，与它不存在，
 *   在"下一次有人照注释加字段时会不会被拦下"这个读数上是同一个东西。
 *
 *   所以：**一次**调用取回全部命中行，再在本地对每一行套用遍历正则。
 */
export function readAllHits(names, exec = execFileSync) {
  if (names.length === 0) return []
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return gitGrep(`\\b(${alt})\\b`, exec)
}

/** 把 `file:line:text` 的命中行按"提到了哪个名字"分桶。 */
export function bucketHits(hits, names) {
  const buckets = new Map(names.map((n) => [n, []]))
  for (const h of hits) {
    const m = /^([^:]+):(\d+):([\s\S]*)$/.exec(h)
    if (m === null) continue
    const [, file, line, text] = m
    for (const n of names) {
      if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
        buckets.get(n).push(`${file}:${line}:${text}`)
      }
    }
  }
  return buckets
}

/**
 * 一张表的读数：遍历点数、**同文件按"键位"手写复述**的成员数。
 *
 * ---------------------------------------------------------------------------
 * ★★★ 为什么必须是"**键位**"而不是"这个字符串出现过"（本判据最关键的一处口径）
 *
 *   第一版我用"成员作为字符串字面量出现过"来判，结果报了 **17 张**装饰表——
 *   而它们**几乎全是误报**。形状是这样：
 *
 *       export const SNAPSHOT_STATUSES = Object.freeze(['failed', 'complete'])
 *       // 文件别处： status = 'failed'   ← 这是**值位**
 *
 *   一张枚举表声明了允许的取值，代码里当然会写下那些取值——那是**正常**的，
 *   不是"第二份实现"。
 *
 *   而第 40 轮那个真形状是**键位**：
 *
 *       export const RUN_RECORD_FIELDS = Object.freeze(['key', 'pid', 'image'])
 *       return processes.map((p) => ({
 *         key: String(p?.key ?? ''),       ← 键位：把声明里的名字当**键**重写了一遍
 *         pid: typeof p?.pid === 'number' ? p.pid : null,
 *         image: typeof p?.image === 'string' ? p.image : null,
 *       }))
 *
 *   > 一张枚举表的成员出现在**值位**，与它被**手写重建**了一遍，
 *   > 在"这个字符串出现过"这个读数上是同一个东西——
 *   > 只不过前者是它被正确使用，后者是它已经被绕开。
 *
 *   所以本判据只认**键位**：`member:`（对象字面量的键）与 `{ member }`（简写键）。
 *   并且要求**覆盖到多数成员**——只命中一个是巧合，命中一半以上才是"重建"。
 *
 * ★ 注释行不算：在注释里点名一个成员是**解释**，不是第二份实现。
 */
export function mirrorPattern(member) {
  const e = member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    // ★ 行首要允许缩进：第一版写的是 `(^|[{,]\\s*)`，于是真实代码里缩进 4 格的
    //   `key: String(...)` **认不出来** ⇒ 自证里的"修复前"形状被判成不装饰
    //   ⇒ `self-check-blind`。**判据认不出自己声称要抓的形状**，
    //   与"判据什么都没查"是同一个读数。
    `^\\s*${e}\\s*:`
    + `|[{,]\\s*${e}\\s*:`
    + `|[{,]\\s*${e}\\s*[,}]`
    + `|^\\s*${e}\\s*$`,
  )
}

/** 键位复述的**门槛**：命中成员数 ≥ 2，且 ≥ 成员总数的一半。 */
export function isMirroring({ hitCount, total }) {
  return hitCount >= 2 && hitCount * 2 >= total
}

/**
 * ★★ 把声明**自己的那个数组字面量**挖空（等长空格，保留换行）。
 *
 *   第一版我是"整行跳过"（`isDeclarationLine`）。那个写法有一个**假阴性**：
 *   当声明与真实代码**同一行**时——
 *
 *       export const F = Object.freeze(['key','pid']); const row = { key: 1 }
 *
 *   ——`{ key: 1 }` 是一处**真的**键位复述，却被整行跳过丢掉了。
 *   （实测见 `scripts/probes/_probe-decl-exclusion.mjs` 第三个声明：它命中了 `L1:key`，
 *   而那道守卫正好把这一行抹掉。）
 *
 *   > 一个"跳掉整行"的排除，与一个"跳掉该跳的那一段"的排除，
 *   > 在只看"这张表有没有被复述"时是同一个东西——
 *   > 只不过前者会把同一行上的**真凭据**一起丢掉。
 *
 *   所以：只挖掉声明的那一段。★ 值必须是**等长空格**——这样后面报的行号
 *   与真实文件一致。
 */
export function blankDeclarationSpan(text, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*Object\\.freeze\\(\\[[^\\]]*\\]\\)`)
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '))
}

export function measureDeclaration({ name, members, file, text, hits }) {
  // `hits` 是**已经取好的**本名字命中行（一次 `git grep` 取回全部名字的结果）。
  // 遍历点 = 命中行里符合"遍历形状"的那些，且排除声明自己那一行。
  const iterSites = hits
    .filter((h) => !(h.startsWith(`${file}:`) && h.includes(`export const ${name}`)))
    .filter((h) => {
      const m = /^[^:]+:\d+:([\s\S]*)$/.exec(h)
      return m !== null && new RegExp(iterPattern(name)).test(m[1])
    })
    .length

  // ★ 只挖掉声明那一段（不是整行）：同一行上的真实代码仍要参与判定。
  const lines = blankDeclarationSpan(text, name).split(/\r?\n/)

  const mirrored = new Set()
  const mirrorSites = []
  for (const [i, line] of lines.entries()) {
    // 注释行不算：那是解释，不是第二份实现
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (code.trim() === '') continue
    for (const m of members) {
      if (mirrored.has(m)) continue
      if (mirrorPattern(m).test(code)) {
        mirrored.add(m)
        mirrorSites.push(`${i + 1}:${m}`)
      }
    }
  }
  const hitCount = mirrored.size
  return {
    iterSites,
    mirrors: hitCount,
    mirrorSites,
    mirroring: isMirroring({ hitCount, total: members.length }),
  }
}

/**
 * 扫描整仓，返回每张表的读数与**被判为装饰**的那些。
 */
export function scanDeclarations({
  files = null, readFile = readFileSync, exec = execFileSync, hitsReader = null,
} = {}) {
  const list = files ?? trackedModules(exec)
  const parsed = []
  for (const file of list) {
    let text
    try { text = readFile(file.endsWith('.mjs') ? `${REPO}/${file}` : file, 'utf8') } catch { continue }
    for (const m of text.matchAll(DECL_RE)) {
      const members = membersOf(m[2])
      if (members === null) continue
      parsed.push({ file, name: m[1], members, text })
    }
  }
  // ★ 一次 git grep 取回全部候选名字的命中行（238 次子进程 → 1 次，236 秒 → 几秒）
  const hits = (hitsReader ?? ((names) => readAllHits(names, exec)))(parsed.map((p) => p.name))
  const buckets = bucketHits(hits, parsed.map((p) => p.name))
  const rows = []
  for (const p of parsed) {
    const { iterSites, mirrors, mirrorSites, mirroring } = measureDeclaration({
      name: p.name, members: p.members, file: p.file, text: p.text, hits: buckets.get(p.name) ?? [],
    })
    rows.push(Object.freeze({
      file: p.file, name: p.name, members: Object.freeze(p.members),
      iterSites, mirrors, mirrorSites: Object.freeze(mirrorSites), mirroring,
      decorative: iterSites === 0 && mirroring,
    }))
  }
  return Object.freeze(rows)
}

/**
 * ★★ 自证：一份**修复前的真实形状**必须被报出，一份**修复后的**必须被放行。
 *
 * 逐字取自 `product/launcher/run-record.mjs` 的两个版本（只保留判据要看的那几行）。
 */
export const SELF_CHECK = Object.freeze({
  before: [
    "export const RUN_RECORD_FIELDS = Object.freeze(['key', 'pid', 'image'])",
    'export function buildRunRecord({ processes } = {}) {',
    '  return processes.map((p) => ({',
    "    key: String(p?.key ?? ''),",
    "    pid: typeof p?.pid === 'number' ? p.pid : null,",
    "    image: typeof p?.image === 'string' ? p.image : null,",
    '  }))',
    '}',
  ].join('\n'),
  after: [
    "const REQUIRED_FIELD_READERS = Object.freeze({ key: (p) => p?.key, pid: (p) => p?.pid, image: (p) => p?.image })",
    "export const RUN_RECORD_FIELDS = Object.freeze(['key', 'pid', 'image'])",
    // ★ 修复后的形状必须**遍历那个声明的名字本身**——第一版我写的是
    //   `for (const f of requiredFields)`（一个参数），于是自证误判成
    //   `self-check-overreach`：判据说"这张表没被遍历"，而它其实被遍历了，
    //   只不过是在**另一个函数签名**里换了个名字。
    //   > 一个正对照里的"修好版本"如果没有真的走那条通路，
    //   > 它验证的是**正对照自己写错了**，不是判据太宽。
    'export function buildRunRecord({ processes } = {}) {',
    '  return processes.map((p) => {',
    '    const row = {}',
    '    for (const f of RUN_RECORD_FIELDS) row[f] = REQUIRED_FIELD_READERS[f](p)',
    '    return row',
    '  })',
    '}',
  ].join('\n'),
})

/**
 * 判据本体。
 *
 * R1 每张"装饰表"都要么被修好，要么在 `DECLARED_MIRRORS` 里**写明理由**；
 * R2 `DECLARED_MIRRORS` 里不许留**已经不再装饰**的条目（会变成一句没人核的话）；
 * R3 每条豁免都要有 `why`（≥20 字）与 `owner`（一个裁决处）；
 * R4 ★ 自证：`before` 必须被判为装饰、`after` 必须不被判为装饰。
 */
export function checkDeclarations({
  rows, allowlist = DECLARED_MIRRORS, selfCheck = SELF_CHECK,
  scan = scanDeclarations,
} = {}) {
  const all = rows ?? scan()
  const problems = []
  const allowed = new Set(allowlist.map((a) => a.name))

  // R1
  for (const r of all) {
    if (r.decorative && !allowed.has(r.name)) {
      problems.push({ rule: 'R1', code: 'decorative-declaration', file: r.file, name: r.name,
        message: `\`${r.name}\` 声明了却**没有任何遍历点**，而同文件里把它的成员手写复述了 `
          + `${r.mirrors} 次（${r.mirrorSites.slice(0, 4).join(' ')}）——这张表是装饰，`
          + `照它的注释加一项会被静默丢掉` })
    }
  }
  // R2
  const decorativeNow = new Set(all.filter((r) => r.decorative).map((r) => r.name))
  for (const a of allowlist) {
    if (!decorativeNow.has(a.name)) {
      problems.push({ rule: 'R2', code: 'stale-exemption', name: a.name,
        message: `豁免 \`${a.name}\` 已过期：它今天不再是一张装饰表（要么修好了，要么不存在了）` })
    }
  }
  // R3
  for (const a of allowlist) {
    if (typeof a.why !== 'string' || a.why.length < 20) {
      problems.push({ rule: 'R3', code: 'exemption-no-why', name: a.name, message: `豁免 \`${a.name}\` 没写清理由` })
    }
    if (typeof a.owner !== 'string' || a.owner === '') {
      problems.push({ rule: 'R3', code: 'exemption-no-owner', name: a.name, message: `豁免 \`${a.name}\` 没写裁决处` })
    }
  }
  // R4 ★ 自证：判据自己必须能分辨"修之前"与"修之后"
  const measure = (text) => {
    const rows = []
    for (const m of text.matchAll(DECL_RE)) {
      const members = membersOf(m[2])
      if (members === null) continue
      // 自证里的"命中行"就是文本自己的每一行（不带行首 `file:line:` 前缀，
      // 因为 `measureDeclaration` 对 hits 的解析会取 `:line:` 之后的部分）。
      const hits = text.split(/\r?\n/).map((l, i) => `self-check.mjs:${i + 1}:${l}`)
      const { iterSites, mirrors, mirroring } = measureDeclaration({
        name: m[1], members, file: 'self-check.mjs', text, hits,
      })
      rows.push({ name: m[1], mirrors, iterSites, decorative: iterSites === 0 && mirroring })
    }
    return rows
  }
  const before = measure(selfCheck.before)
  const after = measure(selfCheck.after)
  if (before.length === 0 || !before.every((r) => r.decorative === true)) {
    problems.push({ rule: 'R4', code: 'self-check-blind',
      message: '自证失败：判据**认不出**修复前的形状（那它与"什么都没查"是同一个东西）' })
  }
  if (after.length === 0 || after.some((r) => r.decorative === true)) {
    problems.push({ rule: 'R4', code: 'self-check-overreach',
      message: '自证失败：判据把**修复后**的形状也判成装饰（那是误报，会逼人把判据改松）' })
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    scanned: all.length,
    decorative: Object.freeze(all.filter((r) => r.decorative).map((r) => `${r.file}::${r.name}`)),
    selfCheck: Object.freeze({ before: before.length, after: after.length }),
  })
}

export function checkRepo() {
  return checkDeclarations({})
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href.replace('file:///', 'file:///')

if (isMain || process.argv[1]?.endsWith('declaration-mirrors.mjs')) {
  const r = checkRepo()
  console.log(`declaration-mirrors：扫 ${r.scanned} 张冻结的字符串表；`
    + `判为装饰 ${r.decorative.length} 张；自证 before=${r.selfCheck.before} after=${r.selfCheck.after}`)
  for (const p of r.problems) console.error(`  [${p.rule}/${p.code}] ${p.message}`)
  console.log(r.ok ? '✅ 每张声明表都真的有人遍历它（或者写了豁免理由）'
    : `❌ ${r.problems.length} 项`)
  process.exit(r.ok ? 0 : 1)
}
