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

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

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
    lineCitations: () => scanLineCitations(doc(LEDGER_DOC)),
    commitCitations: () => scanCommitCitations(doc(LEDGER_DOC)),
    pinnedCitations: () => checkPinnedCitations(),
  }
}

// ── C. 台账里的**坐标**（`file:line` 与提交哈希）─────────────────────────────
//
// ★ 起因：`boundary-facts` 原来只钉"文档声称的**数字** ↔ 产物真实的值"，
//   也就是只管**计数**，不管**位置**。而本仓的论证大量依赖坐标：
//
//     `tool-request.mjs:639`（缺表 = 放行）、
//     `runtime-contract-server.mjs:599`（`wireChecked: true` 是写死的字面量）、
//     `credentials-local/src/index.ts:585` / `:611`（watcher 的创建点/关闭点）
//
//   坐标是最**脆**的证据形式：在它上面插一行注释，它就指到别处去了，
//   而**句子本身一个字都没变**。
//
//   > 一个"引用了某文件第 639 行"的论断，与一个"引用了那个文件里某处"的论断，
//   > 在读者眼里强度完全不同——而两者在文件被改动一行之后，**看起来仍然一样**。
//
// ⚠️ 边界（重要）：这里只判**坐标是否落在实处**——文件在不在、行号在不在范围内、
//   提交在不在线上。**不判**"那一行的内容支撑那句话"。后者要逐条读上下文，
//   机械判不了；把前者当成后者，正是本会话反复记的那个错。

const CITATION_SKIP = new Set([
  '.git', 'node_modules', '.ci', 'scratch', 'dist', 'build', '.dsh', 'coverage',
  '.worktrees', '.legion-worktrees', 'releases', '.skills-cache', '.turbo',
])

/** 把一棵树索引成 `相对路径(小写)` → 绝对路径，并建后缀表。 */
function indexTree(root, depthCap) {
  const byPath = new Map()
  const bySuffix = new Map()
  const walk = (dir, rel, depth) => {
    if (depth > depthCap) return
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (CITATION_SKIP.has(e.name)) continue
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) { walk(resolve(dir, e.name), r, depth + 1); continue }
      const key = r.toLowerCase()
      byPath.set(key, resolve(dir, e.name))
      const parts = key.split('/')
      for (let i = parts.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
        const suf = parts.slice(i).join('/')
        if (!bySuffix.has(suf)) bySuffix.set(suf, [])
        bySuffix.get(suf).push(resolve(dir, e.name))
      }
    }
  }
  walk(root, '', 0)
  return { byPath, bySuffix }
}

/**
 * DSH 检出：本仓的产物依赖它，而它**不在本仓里**（可能整个不存在）。
 * 用环境变量覆盖，默认取同级目录下的约定位置。
 */
export function dshCheckoutRoot() {
  const fromEnv = process.env.DSH_CHECKOUT
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return resolve(REPO, '..', 'dsh', 'deepseek-harness')
}

let TREE_CACHE = null
function trees() {
  if (TREE_CACHE === null) {
    TREE_CACHE = { legion: indexTree(REPO, 8), dsh: null }
    const dshRoot = dshCheckoutRoot()
    if (existsSync(dshRoot)) TREE_CACHE.dsh = indexTree(dshRoot, 12)
  }
  return TREE_CACHE
}

/** 测试用：丢掉索引缓存（换了替身目录之后必须调）。 */
export function resetTreeCache() { TREE_CACHE = null }

const LINE_CITATION_RE = /(?:^|[\s`（(【\[])((?:[\w.@-]+[\\/])*[\w.@-]+\.(?:mjs|cjs|js|ts|tsx|json|yml|yaml|md)):(\d+)(?:-(\d+))?/g

/**
 * 扫描台账里的 `file:line` 引用。返回
 * `{ checked, broken, ambiguous, unresolved, detail }`。
 *
 * ★★ 第一版（`scratch/scan-line-citations.mjs`）报出 7 条 `PATH-MISSING`
 *   + 2 条 `LINE-OUT-OF-RANGE`，逐条看过之后**9 条全是解析器的错**：
 *
 *     · 那 7 条是**后缀片段**（`plugins/root-row.mjs` 实为
 *       `runtime/dsh-composition/plugins/root-row.mjs`）；
 *     · 那 2 条按**裸文件名**撞上同名文件，于是"行号超范围"报的是**另一个文件**。
 *
 *   > 一个"引用坏了"与一个"我的解析器只认得三种写法"，
 *   > 在第一版的输出里长得一模一样——**而且后者还带着一个看起来很具体的数字。**
 *
 * ⇒ 所以这里：先索引、再**后缀**匹配；多个候选命中时如实记 `ambiguous`
 *   （不挑一个算数），且 `ambiguous` **不算 broken**（定夺不了就不下结论）。
 */
export function scanLineCitations(text, treeSet = null) {
  const t = treeSet ?? trees()
  const uniq = new Map()
  for (const m of text.matchAll(LINE_CITATION_RE)) {
    const key = `${m[1].replace(/\\/g, '/')}:${m[2]}${m[4] ? `-${m[4]}` : ''}`
    uniq.set(key, {
      path: m[1].replace(/\\/g, '/'),
      from: Number(m[2]),
      to: m[4] ? Number(m[4]) : Number(m[2]),
    })
  }
  const broken = []
  const ambiguous = []
  const external = []
  let checked = 0
  for (const c of uniq.values()) {
    const key = c.path.toLowerCase()
    const direct = []
    for (const tree of [t.legion, t.dsh]) {
      if (tree !== null && tree.byPath.has(key)) direct.push(tree.byPath.get(key))
    }
    let real = null
    if (direct.length === 1) real = direct[0]
    else if (direct.length > 1) { ambiguous.push(c.path); continue }
    if (real === null) {
      const cands = []
      for (const tree of [t.legion, t.dsh]) {
        if (tree === null) continue
        const hit = tree.bySuffix.get(key)
        if (hit) cands.push(...hit)
      }
      const u = [...new Set(cands)]
      if (u.length === 1) real = u[0]
      else if (u.length > 1) { ambiguous.push(c.path); continue }
    }
    if (real === null) {
      // ★★ 关键区分：**"找不到"有两种，而它们的处置必须相反。**
      //
      //   · DSH 检出**在**，还是找不到 ⇒ 那是真的引用坏了（改名/删了/写错了）；
      //   · DSH 检出**不在** ⇒ 这条可能本来就在那边，我们**无从判断**。
      //
      //   本脚本第一版把两者都算成 broken。实测：把 `DSH_CHECKOUT` 指到一个不存在的
      //   目录，它会报出 **18 条"找不到这个文件"** ——而那 18 条全是
      //   `packages/…` / `apps/…` 的 DSH 侧引用，**一条都没坏**。
      //
      //   > 一个"引用坏了"与一个"我没法查"，在只有同一条红的时候长得一模一样
      //   > ——而前者要求我改文档，后者要求我改**判据**。
      //
      //   ⇒ DSH 不在时记 `external`（如实列出、**不判定**），且它**不算 broken**。
      if (t.dsh === null) { external.push(`${c.path}:${c.from}`); continue }
      broken.push(`${c.path}:${c.from}（找不到这个文件）`)
      continue
    }
    let lines = 0
    try { lines = readFileSync(real, 'utf8').split('\n').length } catch {
      broken.push(`${c.path}:${c.from}（读不出来）`); continue
    }
    checked++
    if (c.from > lines || c.to > lines) {
      broken.push(`${c.path}:${c.from}${c.to !== c.from ? `-${c.to}` : ''}（文件共 ${lines} 行）`)
    }
  }
  // ★ "解析到 0 条"必须是**红**的：否则改了引用格式之后这条判据会静默变绿，
  //   而那与"所有引用都是好的"是同一个输出。
  if (uniq.size === 0) broken.push('（解析到 0 条 `file:line` 引用——锚点或格式变了？）')
  // ★ 同理："在 Legion 里一条都没解析到"也要红——否则 DSH 不在时这一面可能整个空掉，
  //   而"空面"与"全绿"在输出里长得一样。
  if (uniq.size > 0 && checked === 0) {
    broken.push(`（解析到 ${uniq.size} 条引用，但在 Legion 仓里**一条都没落到实处**——`
      + `索引坏了，或引用格式变了；另有 ${external.length} 条因 DSH 检出不在而无法判定）`)
  }
  return { checked, broken, ambiguous, external, total: uniq.size }
}

// ── C2. **手钉**的关键引用：那几行就必须是那句话 ────────────────────────────
//
// ★ 为什么需要这一层（上一批那两条判据**结构上够不着**这个形状）：
//
//   2026-09-18，另一会话自己订正了四处引用：
//   `plugins/root-row.mjs:485-509` → `:508-536`（"§9.5 接线前是 485-509"）。
//   我第一反应是"我的新判据抓到了"——**核过之后：没有。**
//   那个文件现在 **719 行**，`485-509` 稳稳在范围内。
//
//   > 我差一点把"别人用推理找到的"记成"我的判据找到的"。
//   > 一个判据抓到与一个人抓到，在**结果**上一样，在**它值多少**上完全不一样。
//
// ★ 然后我试了"内容锚"（`scratch/probe-content-anchor.mjs`）：
//   拿引用旁边的反引号标识符，看它是否出现在附近 ±20 行。**它不成立**，两个原因：
//
//   ① **覆盖率就不够**：103 条引用里只有 **38 条**（37%）旁边取得到一个标识符；
//   ② **更要命的是它会在真漂移上变绿**。上面那个真例子里，我本来打算拿
//      `installEnforcementRoot` 当锚——而它在旧区间 `485-509` **里面**也有：
//      `L488` 那句注释写着"在此之前 `installEnforcementRoot` 的入参里**没有** `pathScope`"。
//      也就是说，**修复者解释这次位移的那句注释，正好把锚词种在了旧坐标上**。
//
//   > 一个用标识符当"内容锚"的判据，会在**修复者解释了这次漂移**的地方变绿——
//   > 而"解释这次漂移"恰恰是修复时最自然会发生的事。
//
//   （这与本模块里那条"只认一种句式的判据会在有人**引用**它时失效"是同一个形状，
//   只是这次的"引用"发生在**代码注释**里、而它在旧坐标上。）
//
// ⇒ 所以这一层**不做启发式**，做**断言**：把本会话结论所依赖的那几行**逐字钉住**。
//   代价是行号一动就红——而那正是我们要的：**让位移可见**，然后人来更新这个钉。
//   ⚠️ 边界：这一层**只覆盖我逐字读过的那几行**，不是"整个台账的内容都是对的"。
//
// ★★★ 而且这一层**上线第一次就抓到了我自己**：DSH 那条我钉的是
//   `awaitWriteFinish: {`，而第 585 行其实是
//   `const watcher = chokidarWatch(…)`。**我记错了那一行的内容。**
//
//   ★ 更值得记的是：我此前是用 `Get-Content` 去读的，而**那个读数与 git/node 不一致**——
//   同一个文件，`Get-Content` 说 **932** 行，`git grep -n` 与 `readFileSync().split('\n')`
//   都说 **936** 行（实测：CRLF 0、孤立 CR 0、孤立 LF 935、纯 LF）。
//   于是"第 585 行"在两种读法下**不是同一行**。
//
//   > 我用一个**只对某些文件**会错的仪器，去核对那些**给别的仪器看**的行号。
//   > 而且它错的时候不报错——它给出一行**内容正常、行号正确、就是位置不对**的东西。
//
//   ⇒ 本仓的规矩因此是：**核 `file:line` 一律用 `git grep -n` 或 node**，
//   不要用 shell 的 `Get-Content` + 下标——它与判据、与仓、与编辑器都不是同一个口径。
//   （我这一整轮用 `Get-Content` 核过 5 条引用，其中 4 条恰好一致、1 条不一致。
//   **"4 次对"在这里建立不了任何东西**：我不知道哪一类文件会不一致。）
const PINNED_CITATIONS = Object.freeze([
  Object.freeze({
    path: 'runtime/dsh-composition/tool-request.mjs',
    line: 639,
    text: 'if (pathScope === null) return undefined',
    why: '本会话多次引为「缺表 = 放行」——这句话就是那条边界的**全部依据**',
  }),
  Object.freeze({
    path: 'runtime/dsh-composition/runtime-contract-server.mjs',
    line: 599,
    text: 'wireChecked: true,',
    why: '状态面七个字段里**唯一写死的字面量**，且全仓没有地方读它（§5 第 20 条）',
  }),
  Object.freeze({
    path: 'runtime/dsh-composition/external-api-scope.mjs',
    line: 1061,
    text: 'literalWouldMatchNothing: true,',
    why: '一处**无声声明**：规则只会匹配到与自己端点相同的东西（触发时不会报红）',
  }),
  Object.freeze({
    path: 'runtime/dsh-composition/enforcement-mapping.mjs',
    line: 266,
    text: 'whenUnattended: true,',
    why: '另一处**无声声明**：值守缺失时禁止询问（触发时不会报错）',
  }),
  Object.freeze({
    path: 'packages/credentials/credentials-local/src/index.ts',
    line: 585,
    text: 'const watcher = chokidarWatch(await canonicalizeWatchPath(this.spec.filename), {',
    why: 'PRT-509 关停缺陷的**根因位置之一**：chokidar watcher 的创建点',
    dsh: true,
  }),
])

/**
 * 逐条核对手钉引用。返回 `{ checked, broken, external }`。
 *
 * ★ `pinned` 可注入：测试要用**同一份**核法去钉"历史上那次真实位移的旧坐标"
 *   （见 `.test.mjs` ⑫b）。**测试绝不自己重抄一遍核对逻辑**——
 *   抄一遍就变成"测我的副本"，而副本与本体一起错的时候是全绿的。
 *
 * ★ DSH 侧文件在检出不在时记 `external`（与 `scanLineCitations` 同一口径）。
 */
export function checkPinnedCitations(pinned = PINNED_CITATIONS) {
  const broken = []
  const external = []
  let checked = 0
  const dshRoot = dshCheckoutRoot()
  const dshMissing = !existsSync(dshRoot)
  for (const p of pinned) {
    const base = p.dsh === true ? dshRoot : REPO
    const full = resolve(base, p.path)
    if (!existsSync(full)) {
      // ★ "文件不在"有两种：DSH 侧且检出不在 ⇒ 无法判定；否则 ⇒ 真的坏了
      if (p.dsh === true && dshMissing) { external.push(p.path); continue }
      broken.push(`${p.path}:${p.line}（文件不在）`); continue
    }
    let lines = []
    try { lines = readFileSync(full, 'utf8').split('\n') } catch {
      broken.push(`${p.path}:${p.line}（读不出来）`); continue
    }
    if (p.line > lines.length) {
      broken.push(`${p.path}:${p.line}（文件只有 ${lines.length} 行）`); continue
    }
    checked++
    // ★ 两侧都 `trim()`：**钉的文本自己的格式不该影响比对**。
    //
    //   第一版只 trim 了磁盘那一侧，于是"钉里带了个行尾空格"会假红——
    //   而那是**我写钉时的手滑**，不是被引用代码的问题。（⑫c 抓到的。）
    const actual = lines[p.line - 1].trim()
    if (actual !== p.text.trim()) {
      broken.push(`${p.path}:${p.line} 现在是 ${JSON.stringify(actual)}，`
        + `而钉的是 ${JSON.stringify(p.text.trim())}`)
    }
  }
  if (pinned.length === 0) broken.push('（手钉表是空的——这一层被清空了？）')
  if (checked === 0 && !dshMissing && pinned.length > 0) {
    broken.push('（一条都没核到——手钉表或路径解析坏了）')
  }
  return { checked, broken, external, total: pinned.length, dshMissing }
}

const COMMIT_CITATION_RE = /`([0-9a-f]{7,40})`/g
/**
 * 扫描台账里以**反引号**写出的提交哈希，判它①存在②是 HEAD 的祖先。
 *
 * ★★ 只收**至少含一个 a–f 字母**的十六进制串。第一版写 `[0-9a-f]{7,40}`，
 *   于是抓出两个根本不是哈希的东西：`1234567890`（一处 YAML 标量取值测试里的
 *   **数字串**）与 `1000000100`（一处用例里的**字节数**：100 字节 + 10 GB）。
 *
 *   > 一个"引用的提交不存在"与一个"我的正则把数字串当成了提交"，
 *   > 在第一版的输出里长得一模一样——而且后者带着两条看起来很具体的哈希。
 *
 * ⇒ 这是"判据键太宽"这个老形状的又一例。（真实短哈希几乎总带字母。）
 */
export function scanCommitCitations(text, head = null) {
  const uniq = new Set()
  for (const m of text.matchAll(COMMIT_CITATION_RE)) {
    const s = m[1].toLowerCase()
    if (!/[a-f]/.test(s)) continue
    uniq.add(s)
  }
  const broken = []
  let checked = 0
  const git = (args) => {
    try {
      return { out: execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), code: 0 }
    } catch (e) { return { out: '', code: e.status ?? 1 } }
  }
  const headSha = head ?? git(['rev-parse', 'HEAD']).out
  for (const sha of uniq) {
    checked++
    if (git(['cat-file', '-e', `${sha}^{commit}`]).code !== 0) {
      broken.push(`${sha}（不是本仓的一个提交）`); continue
    }
    // 0 = 是祖先；1 = 不是
    if (git(['merge-base', '--is-ancestor', sha, headSha]).code !== 0) {
      broken.push(`${sha}（存在，但**不是 HEAD 的祖先**——东西在别的线上）`)
    }
  }
  if (uniq.size === 0) broken.push('（解析到 0 个提交哈希——锚点或格式变了？）')
  return { checked, broken, total: uniq.size }
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

  // ── C. 台账里的**坐标**（见上面那一大段说明与边界）──────────────────────
  Object.freeze({
    id: 'ledger-line-citations-resolve',
    what: '台账里每条 `文件:行` 引用都指向一个**存在且在行数范围内**的位置',
    why: '坐标是最脆的证据形式：在它上面插一行注释，它就指到别处去了，'
      + '而**句子一个字都没变**。'
      + '★ 实测（2026-09-18）：101 条唯一引用，**0 条坏**；'
      + '那 5 条本会话的结论所依赖的引用（`tool-request.mjs:639`、'
      + '`runtime-contract-server.mjs:599`、`external-api-scope.mjs:1061`、'
      + '`enforcement-mapping.mjs:266`、`credentials-local/src/index.ts:585`）逐条读过，都在。'
      + '⚠️ 这条**只**判"落到实处"，**不**判"那一行支撑那句话"——'
      + '后者要读上下文，机械判不了。',
    source: LEDGER_DOC + ' 正文里的 `path:line`，按 Legion 仓 + DSH 检出的后缀表解析'
      + '（DSH 检出不在时，无法判定的引用记 `external`，**不**算坏）',
    derive: (ctx) => ctx.lineCitations().broken.slice().sort().join(' '),
    expect: '', // 空串 = 一条坏引用都没有
  }),
  Object.freeze({
    id: 'ledger-commit-citations-on-line',
    what: '台账里反引号写出的每个提交哈希都**存在**且**是 HEAD 的祖先**',
    why: '记账一条 ✅ 的惯例是写出闭包证据（"已落地，见 `de89ff3`"）。'
      + '哈希是做不了假的坐标，但它有两种坏法、而**两种都不改变句子**：'
      + '① 哈希不存在（打错一位／那条提交被丢弃或只在别的分支上）；'
      + '② 哈希存在但**不在我们这条线上**——读的人会以为主线里有它。'
      + '★ 实测（2026-09-18）：26 个哈希，26 个都在线上。',
    source: LEDGER_DOC + ' 正文里 `反引号包着的十六进制串`（要求至少含一个 a–f 字母）',
    derive: (ctx) => ctx.commitCitations().broken.slice().sort().join(' '),
    expect: '', // 空串 = 每个哈希都在线上
  }),
  Object.freeze({
    id: 'pinned-citations-verbatim',
    what: '★ **手钉**的那几行关键引用，逐字还是原来那句话（本会话结论的全部依据）',
    why: '上一批那两条坐标判据**结构上够不着**这个形状。实测（2026-09-18）：'
      + '另一会话把 `plugins/root-row.mjs:485-509` 订正成 `:508-536`——'
      + '而那个文件有 **719 行**，旧区间稳稳在范围内，判据看不见。'
      + '★ 我试过"内容锚"（`scratch/probe-content-anchor.mjs`）但它**不成立**：'
      + '① 103 条引用里只有 38 条（37%）取得到锚词；'
      + '② 更要命——真例子里我打算拿 `installEnforcementRoot` 当锚，'
      + '而它在**旧区间内**也有（`L488` 那句注释"在此之前 `installEnforcementRoot` '
      + '的入参里没有 `pathScope`"）。**修复者解释这次位移的注释，正好把锚词种在了旧坐标上。**'
      + '⇒ 所以这一层**不做启发式**，做**断言**：逐字钉住那几行。'
      + '代价是行号一动就红，而那正是要的——**让位移可见**。'
      + '⚠️ 边界：只覆盖我逐字读过的这几行，**不是**"整个台账的内容都是对的"。',
    source: '手钉表（模块内 `PINNED_CITATIONS`）：5 条，4 条在 Legion 仓、1 条在 DSH 检出',
    derive: (ctx) => ctx.pinnedCitations().broken.slice().sort().join(' '),
    expect: '', // 空串 = 每一行都还是原来那句话
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
  // ★★ 坐标判据的覆盖面必须**每轮都印出来**，因为"没能判定"与"判定通过"
  //   在只有一个 PASS 的时候长得一样。
  //
  //   实测过：把 `DSH_CHECKOUT` 指到一个不存在的目录时，第一版会报
  //   **18 条"找不到这个文件"**——而那 18 条全是 DSH 侧引用，一条都没坏。
  //   修好之后它们转成"无法判定"，而这一行就是让那个**无法判定**不再静默。
  const lc = defaultContext().lineCitations()
  const cc = defaultContext().commitCitations()
  const pc = defaultContext().pinnedCitations()
  console.log(`  坐标判据覆盖面：\`file:line\` 解析到 ${lc.total} 条`
    + `（落到实处 ${lc.checked} / 后缀多候选 ${lc.ambiguous.length} / `
    + `**因 DSH 检出不在而无法判定 ${lc.external.length}**）；`
    + `提交哈希 ${cc.total} 个（判定 ${cc.checked}）；`
    + `手钉引用 ${pc.total} 条（逐字核过 ${pc.checked} / 因 DSH 不在跳过 ${pc.external.length}）`)
  if (lc.external.length > 0) {
    console.log('  ⚠️ 有引用**没能判定**（DSH 检出不在 ⇒ 不判它坏）：'
      + `${lc.external.slice(0, 4).join(', ')}${lc.external.length > 4 ? ' …' : ''}`)
    console.log('     ⇒ 这一轮里"那些引用是对的"这句话**没有证据**；它只是没被证伪。')
  }
  process.exit(r.ok && r.checked === r.total ? 0 : 1)
}

if (isMain) main()
