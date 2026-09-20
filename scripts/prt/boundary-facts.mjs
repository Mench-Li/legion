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
// ★ 借用**同一份**「清单形状」正则（见下面 D2 一节）：两份会漂的键表就是本仓的旧账。
import { MANIFEST_PATTERNS } from './reachability.mjs'
import { REPO_WIDE_BASELINE } from './doc-table-integrity.mjs'
// ★ 台账状态词表的**唯一所有者**是 `progress-check.mjs`。
//   本模块第 44 轮自己手抄过一份"三个标记"的表（`✅|⏸|⬜`），
//   于是认不出 🟡、报 144 而台账有 145——而那个错数正好能过门禁。
//   ⇒ 现在**取**它，不再抄它（见 `LEDGER_STATUS_MARKERS` 那一段）。
//
// ★★★ 第 46 轮：连**行怎么认**与**标记归哪一档**也一起取回来。
//   第 45 轮只收敛了"有哪些标记"，`tallyLedger` 仍然自己判行（`/^\|\s*PRT-\d+/`）、
//   自己分格、**自己写四个 `if` 分档**。实测出两处会走偏的地方（见 `tallyLedger`）。
import { LEDGER_STATUS_MARKS, STATUS_MARKS, ledgerTaskRow } from './progress-check.mjs'

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
    manifestImpersonation: () => checkManifestImpersonation(),
    // ── E. 交接报告 §二 自称"机器读数，可复跑"的那张表（第 26 轮）────────────
    ledgerTallies: () => tallyLedger(doc(LEDGER_DOC)),
    trackedTestCount: () => trackedTestFiles().length,
    unreachableTallies: () => tallyUnreachable(),
    docRatchet: () => REPO_WIDE_BASELINE,
  }
}

// ── E. ★★★ 交接报告 §二 那张表自称「都是机器读数，可复跑」（2026-09-18 第 26 轮）──
//
// ★ 起因：那句话本身就是**一句没有任何东西核对的断言** —— 而且它出现在
//   **一份专门用来汇总"哪些读数可信"的报告**里，位置比前面那三种都更靠前：
//   读者正是**因为**它写着"可复跑"才不去跑。
//
//   我把它逐行重算了一遍（`scratch/_verify-readings.mjs`）：**大部分对**，
//   但抓到一处真漂移 —— 正文写着
//
//       "`test` 阶段那 808 秒里，工作树的代码与文档一个字节都没动过"
//
//   而 808s 是**第 23 轮**那次 CI 的读数。这番话是第 22 轮写的，
//   第 23 轮改表时**没跟着改句子**。
//
//   > 一张表里已经写了三轮新的读数，而紧挨着它的那句话还记着第一轮的那个数。
//   > 两者在报告里长得都像"机器读数"。
//
// ★ 这几条只需要读文件与读 git，**不开子进程**（CI 那几行由
//   `suite-counts` 真跑去核，见 `scripts/prt/suite-counts.mjs`）。

/** 交接报告里那张「最终读数」表的文件路径。 */
export const HANDOVER_DOC = 'docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md'

/**
 * ★★★ 第 51 轮：**人工介入清单**（`PRT-HUMAN-INTERVENTION-*.md`）此前**零判据**。
 *
 * 量出来的事实（第 51 轮）：`git grep -l PRT-HUMAN-INTERVENTION -- '*.mjs'` **零命中** ——
 * 而它是这批产物里**唯一一份写给人照做**的文档：
 *
 *     PRT-PROGRESS.md          ← spec-progress --check / ledger-evidence / intervention-coverage
 *     PRT-HANDOVER-*.md        ← boundary-facts（5 条）
 *     MULTI-AGENT-FEATURE-*.md ← feature-table / feature-evidence / feature-landing-paths / …
 *     prt-reachability-*.json  ← reachability / alpha-chain-trace
 *     **PRT-HUMAN-INTERVENTION-*.md ← （无）**
 *
 *   > 一份**要人照着做**的清单，如果它自己没有人核，
 *   > 那它错的时候只有**读它的人**会发现 ——
 *   > 而那个人正是**因为不知道答案才来读它**的。
 *
 * ★ 而它**已经错了**：清单里那句"十一个套件合计 **201 通过**"是第 48 轮写的，
 *   第 49 轮加了 `reachability`（+13 例）之后**没有人改** —— 真值是 **214**。
 *   同一块的标题还写着"第 45～47 轮结束时的读数"，而家族表已经到第 50 轮。
 */
export const INTERVENTION_DOC = 'docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'

/**
 * ★★★ 第 52 轮：**最终报告**（`PRT-FINAL-REPORT-*.md`）—— 交付物本身 —— 零判据。
 *
 * 实测：它的 §三 是**逐轮留档**（第 16 轮起），34 个小节按轮次编号，
 * 而其中的 **39～43 是倒着放的**（43、42、41、40、39），
 * 44/45 又跳到了 39 前面；顶层标题还写着「第 15 轮做了什么」。
 *
 *   > 一份"看起来按编号排好了"的文档，与一份真的排好了的文档，
 *   > 在**只看前几节**的时候是同一个读数 ——
 *   > 读者从 16 一路看到 38 都是升序，**合理地**假设后面也是。
 *
 * ★ 这一族的老形状又出现了一次：**清单的含义由位置决定**。
 *   只是这次的清单是**交付物自己的目录**。
 */
export const FINAL_REPORT_DOC = 'docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md'

/**
 * §三 里带轮次的小节，按文件次序返回 `[{ round, heading }]`。
 *
 * ★ 必须认**区间**写法（`### 3.0j 第 24～29 轮`）：
 *   第一版用 `第 (\d+) 轮` ⇒ 区间那行**一个都没匹配上**、`3.0j` **被静默跳过**，
 *   而输出里看起来"该查的都查了"。
 *   （同一个坑第 51 轮刚踩过：区间标题 `第 45～50 轮`。）
 */
export function reportSectionRounds(text) {
  const lines = String(text).split('\n')
  const start = lines.findIndex((l) => /^## 三、/.test(l))
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (start < 0 || end < 0) return []
  const rows = []
  for (let i = start + 1; i < end; i += 1) {
    const l = lines[i]
    if (!/^#{3,4} 3\.0/.test(l)) continue
    const rounds = [...l.matchAll(/第 (\d+)(?:[～~\-–](\d+))? 轮/g)]
      .map((m) => (m[2] === undefined ? Number(m[1]) : Number(m[2])))
    if (rounds.length === 0) continue
    rows.push({ round: Math.max(...rounds), heading: l.trim().slice(0, 60) })
  }
  return rows
}

/**
 * 轮次**非递减**的违反点。返回 `[{ at, from, to }]`，空数组 = 全序递增。
 *
 * ★ 这是**纯不变式**，不依赖任何文档里的数：一个"看起来有序"的清单，
 *   要么全序递增，要么有违反点 —— 中间没有第三种状态。
 */
export function roundOrderViolations(rows) {
  const bad = []
  let prev = null
  rows.forEach((r, i) => {
    if (prev !== null && r.round < prev.round) bad.push({ at: i, from: prev.round, to: r.round })
    prev = r
  })
  return bad
}
/** 可达性基线的文件路径。 */
export const REACHABILITY_BASELINE = 'docs/superpowers/prt/prt-reachability-baseline.json'

/**
 * 对象 → 字符串，**键的次序由排序决定**，不由插入顺序决定。
 *
 * ★★★ 第 46 轮：`handover-ledger-tallies` 两侧原来都是 `JSON.stringify(对象)`，
 *   于是**对象的键插入顺序**变成了一条没人打算立的规矩（见那条事实的注释）。
 *   凡是"比较两个对象"的地方都该用这个，而不是 `JSON.stringify`。
 */
export function canonicalJson(obj) {
  const sorted = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return JSON.stringify(sorted)
}

/**
 * 台账里出现的**全部**状态标记。★ 少写一个，那一条就会被安静地丢掉。
 *
 * 各档都要数——只数 ✅ 会把"4 条暂停"读成"都完了"。
 * ★★★ 第 44 轮：这里原来是 `✅|⏸|⬜` **三个**（写在 `tallyLedger` 里），
 * 而台账现在还有 **🟡**（"部分"）⇒ 少一个标记 = 少算一条，
 * 而少算出来的那个数**正好**能过 `handover-ledger-tallies`（见该事实的 `why`）。
 *
 * ★★ 第 45 轮：**不再在这里列**，改为取 `progress-check.mjs` 的那张表——
 * 它是台账格式（含状态词表）的唯一所有者。★ 这一行原本是该模块第 **5** 处
 * 手抄的词表，而"手抄一份"正是第 44 轮那个缺陷的**形状**本身。
 *
 * ★ 第 46 轮起 `tallyLedger` 走 `ledgerTaskRow`，不再自己认行，
 * 所以这个别名现在只是"本模块对那张词表的叫法"（保留以兼容既有引用）。
 */
export const LEDGER_STATUS_MARKERS = LEDGER_STATUS_MARKS

/**
 * 台账各档计数（`✅ / 🟡 / ⏸ / ⬜` + 总数）。
 *
 * ★★★ 第 46 轮：**行怎么认**与**标记归哪一档**都取回所有者，
 *   本函数不再自己判行、不再自己写分档的 `if`。
 *
 *   第 45 轮只收敛了"有哪些标记"（`LEDGER_STATUS_MARKERS`），
 *   而行规则与分档仍是本地手写的。实测出两处会走偏的地方
 *   （`scratch/_probe-tally-owner.mjs`）：
 *
 *   | 症状 | 实测 |
 *   | --- | --- |
 *   | **接受规则比所有者宽** | `✅🟡` / `✅（待复核）` / `⏸→🟡` 三种格子：`ledgerTaskRow` **抛**，本函数**照收**（判成 done/paused）⇒ 两个"台账解析器"对**同一行**给出不同读数 |
 *   | **分档是四个手写 `if`** | 词表加第 5 个标记 ⇒ `total` 照加、四档谁都不动 ⇒ `total` 与「四档之和」**悄悄不再相等**（影子验证：`total=5`，四档之和 `4`）。而返回值里**没有任何字段**说"有一条没归到档里" |
 *
 *   > 一个"总数 = 5、四档之和 = 4"的返回值，与一个"台账真的只有 4 条"，
 *   > 在下游（它只是拿去和报告里那行数字比）是同一个读数。
 *
 *   ★ `marks` **可注入**（第 46 轮）：用例能拿一张**多一个标记**的词表来试，
 *     从而验证"它真的在读那张表"，而不是"它今天恰好认得这四个字"。
 *     —— 这与第 42/43/45 轮三次遇到"两版实现行为等价 ⇒ 破验分不开"时的
 *     出路是同一条：**把被跟随的那张声明做成可注入的参数**。
 *
 * @param {string} text 台账全文
 * @param {{marks?: readonly {mark: string, tallyKey: string}[]}} [opts]
 */
export function tallyLedger(text, { marks = STATUS_MARKS } = {}) {
  const counts = new Map(marks.map((m) => [m.mark, 0]))
  let total = 0
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // ★ 行怎么认、状态格长什么样 —— 全部转手给所有者。
    let row = null
    try {
      row = ledgerTaskRow(line, { marks: marks.map((m) => m.mark) })
    } catch (e) {
      throw new Error(`台账第 ${i + 1} 行：${e.message}`)
    }
    if (row === null) continue
    total += 1
    counts.set(row.status, counts.get(row.status) + 1)
  }
  // ★ 分档**派生**：`tallyKey` 也写在所有者那张表里（第 46 轮）。
  const out = { total }
  for (const { tallyKey } of marks) out[tallyKey] = 0
  for (const { mark, tallyKey } of marks) out[tallyKey] += counts.get(mark)
  // ★ 平衡自检：本函数**不返回**一个"总数与四档之和不等"的结果。
  //   加了这一条之后，"漏了一档"不再是一个能悄悄往下游走的数。
  const sum = marks.reduce((a, m) => a + out[m.tallyKey], 0)
  if (sum !== total) {
    throw new Error(`台账分档不平衡：total=${total}，而各档之和=${sum}。`
      + `⇒ 有 ${total - sum} 条行落进了没有任何一档接住的状态。`
      + `★ 这通常意味着"词表加了一个标记、而分档没跟着加"——`
      + `第 46 轮实测过这个形状（tallyKey 未派生时 total=5、四档之和=4）。`)
  }
  return out
}

// ── 沿革：这个函数是怎么被找到的（两句话留着，它们比代码活得更久）────────────
//
// ★ 第 44 轮：它曾经只认 `✅|⏸|⬜`，认不出就 `continue`。
//   `PRT-316` 转成 **🟡** 之后，那一条就既不计入 `total`、也不计入任何一档
//   ⇒ 它对真实台账报 **144**，而台账有 **145** 条。
//   最坏的地方不是"少算一条"，而是**它少算出来的那个数正好能过门禁**：
//   `derive` 给出 144，报告里若写「144 行 = 140 ✅ / 4 ⏸ / 0 ⬜」，这条事实就**判绿**。
//
//   > 一个"不认识的标记就跳过"的解析器，与一个"台账真的只有 144 行"的台账，
//   > 在报告里长得一模一样——
//   > 只不过前者会随着**每一个新状态**安静地少算一条，
//   > 而它的少算**恰好**是门禁会接受的那个值。
//
// ★ 再早：它曾经写死 `cells[2]`，于是报出 `0 ✅ / 3 ⏸ / 2 ⬜`——
//   而去掉首尾竖线之后状态落在 `cells[1]`。写死下标的版本会安静地多数一个、
//   少算一个，而输出仍然是一个**看起来完全合理**的分布。
//
//   > 一个"下标差了一位"的解析器，与一个"台账真的有几条没做完"，
//   > 在报告里长得一模一样——而后者看起来更像个发现。
//
// ★ 第 46 轮（本轮）：上面两次都是"某一处写错了"，而**这一次是"谁说了算"**——
//   同一个问题在本仓被回答了**两遍**（行怎么认、标记归哪一档），
//   于是两个答案可以各自正确而**互相不一致**。⇒ 收敛到一个所有者。

/** 已跟踪的 `*.test.mjs`。★ 用 `-z`：非 ASCII 路径会被 C-quote 成打不开的名字。 */
export function trackedTestFiles({ cwd = REPO } = {}) {
  return execFileSync('git', ['ls-files', '-z', '*.test.mjs'], { cwd, encoding: 'utf8' })
    .split('\0').filter(Boolean)
}

/** 可达性基线的读数：不可达总数与各分类条数。 */
export function tallyUnreachable({ cwd = REPO } = {}) {
  const base = JSON.parse(readFileSync(resolve(cwd, REACHABILITY_BASELINE), 'utf8'))
  const list = base.unreachable ?? []
  const byClass = {}
  for (const e of list) byClass[e.class] = (byClass[e.class] ?? 0) + 1
  return { total: list.length, byClass }
}

// ── D2. ★★★ 我方判据文件**不得冒充清单**（2026-09-18 实测事故）─────────────
//
// ★ 起因是一个**好消息形状**的假信号，比"漏报"贵得多：
//
//   CI 里 `reachability` 探针报"两族 gap 已经变成可达"（好消息），
//   而它下面写着四条指示：确认接线 → **从 READINGS 删掉本条** →
//   **更新状态文档 §5 的裁决** → **跑 `--record` 清基线**。
//   照做就是**把一个没接线的模块记成已接线**。
//
//   追下去：`external-api-scope.mjs` 有**零个**生产 importer，
//   它成为"入口"的理由是 —— **`清单声明（scripts/prt/boundary-facts.mjs）`**。
//   也就是**我上一轮加的那张手钉坐标表**：它的键名正好是
//   `reachability.mjs` 的 `MANIFEST_PATTERNS` 认得的那一种。
//
//   > 一个"某处声明了这个模块会被加载"与一个"某处**提到了**这个模块的坐标"，
//   > 在只看那个键名 + `.mjs` 字面量的判据里是同一个东西——
//   > 而前者是**接线**，后者是**记账**；两者的处置**相反**。
//
//   ★★ 而且它**遮掩了一个已知缺口**：同一张表还让
//   `runtime-contract-server.mjs` 看起来可达，而 §5 第 20 条说的正是
//   「Runtime 契约服务端**没有生产挂点**」。一张记账表同时干了两件事：
//   报了一个假的"接上了"，捂了一个真的"没接上"。
//
// ★★ 修的时候我又踩了一次（本会话同一形状第五次）：在 `reachability.mjs` 的
//   说明里**照样写出**了那个键名 + 一个真路径当例子 ⇒ 探针把
//   **`reachability.mjs` 自己**记成了该模块的入口。**解释这个 bug 的注释复现了这个 bug。**
//
// ⇒ 这条判据借用 `reachability.mjs` **导出的同一份** `MANIFEST_PATTERNS`：
//   两份会漂的键表就是本仓的旧账，所以**只留一份**。
//
// ⚠️ 边界：只扫 `scripts/prt/`（判据与记账所在的地方）。
//   **不能**扫全仓——`patch-layer.mjs` / `process-manifest.mjs` 是**真清单**，
//   它们那样写是**对的**。*一条"所有 .mjs 都不许写清单形状"的判据会红在正确的地方。*
const CRITERIA_DIR = 'scripts/prt'

/** 我方判据文件里有没有"看起来像清单声明、而且指着一个真实模块"的写法。 */
export function checkManifestImpersonation({ dir = CRITERIA_DIR } = {}) {
  const bad = []
  let scanned = 0
  const dshRoot = dshCheckoutRoot()
  const bases = [REPO]
  if (existsSync(dshRoot)) bases.push(dshRoot)
  let names = []
  try { names = readdirSync(resolve(REPO, dir)) } catch { return { scanned: 0, bad: [] } }
  for (const n of names.sort()) {
    if (!n.endsWith('.mjs')) continue
    const rel = `${dir}/${n}`
    let text = ''
    try { text = readFileSync(resolve(REPO, dir, n), 'utf8') } catch { continue }
    scanned++
    for (const re of MANIFEST_PATTERNS) {
      for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
        const captured = m[1]
        // ★ 只有"抓到的路径**真的是一个模块**"才会被探针当成入口。
        //   占位写法（`'<某个 .mjs 路径>'`）抓不到，也不算问题。
        const hit = bases.some((b) => existsSync(resolve(b, captured)))
        if (!hit) continue
        const line = text.slice(0, m.index).split('\n').length
        bad.push(`${rel}:${line} 的 ${JSON.stringify(captured)} 会被可达性探针读成"清单声明"`
          + `（它会把这个模块当成**生产入口**）`)
      }
    }
  }
  return { scanned, bad: bad.sort() }
}

// ── C. 台账里的**坐标**（`file:line` 与提交哈希）─────────────────────────────
//
// ★ 起因：`boundary-facts` 原来只钉"文档声称的**数字** ↔ 产物真实的值"，
//   也就是只管**计数**，不管**位置**。而本仓的论证大量依赖坐标：
//
//     `tool-request.mjs` 的 `scopeGuard`（缺表 = 放行）、
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
    // ★★★ 2026-09-18 第 23 轮修一处**一直存在**的 off-by-one：
    //   这个正则只有 **3** 个捕获组（1=path / 2=from / 3=to），
    //   而这里原来读的是 **`m[4]`** ⇒ `m[4]` 恒为 `undefined` ⇒
    //   **范围终点永远等于起点**（`to: Number(m[2])`）。
    //
    //   实测后果（`scratch/_prove-range-bug.mjs`）：
    //   `run-floor.mjs:600-9999`（那个文件 614 行）**不报 broken**——
    //   它被判成"只引了第 600 行"。而单行 `:9999` 是报的。
    //
    //   ⇒ 台账里 `run-floor.mjs:544-559` 与 `executor-binding.mjs:254-261`
    //     两个范围引用**从来没有被当成范围查过**；`total` 也把范围当单行数。
    //
    //   > 一个"范围引用检查器"与一个"单行引用检查器"，
    //   > 在**所有范围引用都恰好从合法行开始时**是同一个东西——
    //   > 而这条判据的全部价值就在那个区间的**末端**。
    const key = `${m[1].replace(/\\/g, '/')}:${m[2]}${m[3] ? `-${m[3]}` : ''}`
    uniq.set(key, {
      path: m[1].replace(/\\/g, '/'),
      from: Number(m[2]),
      to: m[3] ? Number(m[3]) : Number(m[2]),
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
    // ★ 这里必须留下**内容**，不能只留行数：下面那条"这一段是不是空的"判据
    //   要逐行读。第一版我就是在这里踩的——原来只有
    //   `lines = readFileSync(...).split('\n').length`（一个**数字**），
    //   我照样写 `lines[i - 1]` ⇒ `undefined ?? ''` ⇒ 空串 ⇒
    //   **132 条引用全部被报成"指到空行"**，其中包含
    //   `runtime-contract-server.mjs:599` 这种我刚亲手核过、明明有内容的引用。
    //
    //   > 一个"判据写错了"与一个"文档里有 132 处坏引用"，
    //   > 在输出里长得一模一样——而且后者看起来**更像个发现**。
    //   > 处置却完全相反：前者要改判据，后者要改文档。
    let content = null
    try { content = readFileSync(real, 'utf8') } catch {
      broken.push(`${c.path}:${c.from}（读不出来）`); continue
    }
    const lines = content.split('\n')
    checked++
    if (c.from > lines.length || c.to > lines.length) {
      broken.push(`${c.path}:${c.from}${c.to !== c.from ? `-${c.to}` : ''}（文件共 ${lines.length} 行）`)
      continue
    }
    // ★★★ 2026-09-18 第 23 轮加：**范围判据只查了"行在不在"，没查"那行是不是空的"**。
    //
    //   实测（同一轮）：`tool-request.mjs:731` 在台账与状态文档里共出现 5 次，
    //   没有一次越界，而第 731 行是一个**空行**；真正那句话
    //   （`if (pathScope === null) return undefined`）在 **780** 行（`scopeGuard` 内）。
    //   另一处 `orchestrator/worker/executor.mjs:439` 也是空行。
    //
    //   为什么空行是**确定性**的坏引用，而不是"我猜它在胡扯"：
    //   一条 `file:line` 引用存在的唯一理由是"**这一行**承载了我要的那句话"。
    //   空行、以及 `}` / `})` / `);` 这类**纯收尾符**，不可能承载任何主张。
    //   ⇒ 在这里报"空"**不会**误伤正文：它只否证"这一行有内容"。
    //
    //   ★ 边界（写下来免得下一轮有人把它当成更强的判据）：
    //     它**不**检查"那一行的内容与文档里说的对不对"——那个要读懂语义，
    //     做不了。所以绿不等于引用正确，只等于"它指向的地方**不是空的**"。
    //
    //   > 一个"引用指到空行"与一个"引用指到一张真实的表"，
    //   > 在只查行号范围的判据里长得一样——而前者会让下一个人
    //   > **打开文件、滚到那一行、看见空白、然后开始怀疑自己**。
    const seg = []
    for (let i = c.from; i <= c.to; i += 1) seg.push((lines[i - 1] ?? '').trim())
    if (seg.every((s) => s === '' || /^[)}\];,]+$/.test(s))) {
      broken.push(`${c.path}:${c.from}${c.to !== c.from ? `-${c.to}` : ''}`
        + `（这一${c.to !== c.from ? '段' : '行'}是空的，或只有收尾符——`
        + `引用指的地方没有内容：${JSON.stringify(seg[0] ?? '')}）`)
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
//   那个文件当时 **719 行**，`485-509` 稳稳在范围内。
//
//   ★ ★★ 同日稍晚（本会话，第 19 条 §9.2 第 5 步）：那个调用点**又动了一次**，
//   `:508-536` → `:534-562`（在它前面插入"连接器声明"那块 +25 行 + 文件头 +1 行 import）。
//   而**这一次抓住它的是判据自己**：`boundary-facts.test.mjs` 的 ⑫b
//   当场红在载具断言上（"第 508 行不再是那个调用点"）。
//
//   > 同一个形状、同一个文件、同一天的两次位移：
//   > 第一次是**人**推理出来的，第二次是**判据**顶出来的。
//   > 判据的价值不在第一次——那一次它没抓到。
//   > 它的价值在于：**接线点第二次动的时候，不需要有人恰好读到那份文档。**
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
    file: 'runtime/dsh-composition/tool-request.mjs',
    // ★ 2026-09-18 位移（第一次）：本批往这个文件里加了 42 行（`connectorFeedback` 端口
    //   的签名注释、构造期守卫、返回项与 `enforcementSurfaces()` 那一格），
    //   全都在这一行之上 ⇒ 它从 **639 挪到 681**。
    //
    //   坐标是**手钉**的，所以位移必须在这里改**一次**——而这次是判据自己在
    //   CI 里报了三红（①/⑫a/⑫c）把它顶出来的：那条"引用会随插入位移"的
    //   立论（见本节开头那段）**又成立了一次**，这次是我自己触发的。
    //
    // ★★ 2026-09-18 位移（第二次，同一批内）：加了 F-21 **判定面**那一层
    //   （`connectorJudgment` 的签名注释 + 构造期守卫 + `effectiveDecide`
    //   + 返回项 + `enforcementSurfaces()` 里第 7 格），又都在这一行之上
    //   ⇒ 它从 **681 挪到 731**。
    //
    //   > 一个"手钉行号"的判据，在文件**只增不改**的时候，
    //   > 与一个"每次都重新数一遍"的判据，读数只差一个常数——
    //   > 只不过前者在常数变了的那天会红，而红本身就是它的价值。
    //
    //   ★ 这次它又是**判据自己报出来的**（`--only boundary` 那一阶段不含本套件，
    //     是 `test` 阶段抓到的）——所以第二次位移同样是"判据在工作"，不是"判据坏了"。
    //
    // ★★★ 2026-09-18 位移（第三次，第 19 轮）：加了 PRT-605 的强制点
    //   （`createEnforcementBridge` 的参数 `executionScope` + 构造期 guard 的注释
    //   + `executionGuard()` 函数本体 + pre-execute 与 guard **两处**调用），
    //   又都在这一行之上 ⇒ 它从 **731 挪到 763**。
    //
    //   > 三次位移走的是同一条路：坐标是手钉的，而**判据会在它错的那天红**。
    //   > 这条注释之所以每次都留，是因为"红过三次"与"红过一次"要说明的事不同——
    //   > 前者说明这条判据**不是**碰巧对上的。
    //
    //   ★ 而这一次它顶出了一个更值钱的读数：**同一个文件里的"锚点会漂"这件事
    //     已经漂了三次**，而三个不同的功能（反馈面、判定面、执行面端口）各漂一次。
    //     ⇒ 手钉坐标的成本随"这个文件被改过几次"增长，而不是随它的规模增长。
    //
    // ★★★ 2026-09-18 位移（第四次，第 20 轮）：加了 PRT-606 的强制点
    //   （参数 `externalApiScope` + `externalApiGuard()` 函数本体 + pre-execute
    //   与 guard **两处**调用），同样全在这一行之上 ⇒ 它从 **763 挪到 780**。
    //
    //   ★★ 第四次位移让上面那句话从"读起来有道理"变成**实测的**：
    //     四轮里改的是**四个不同的功能**，而这一行每次都被推下去十几行。
    //     ⇒ 它钉的那句话（"缺表 = 放行"）一次都没改过，改的全是它周围的东西。
    //
    //   > 一条钉在"行号 + 逐字文本"上的判据，锚的其实是**文本**；
    //   > 行号只是"去哪里找"的提示——而提示会随着它周围的长大而失效。
    //   > 每次失效都要人来核一遍，这正是它比"一个字都不钉"更值钱的地方。
    line: 780,
    text: 'if (pathScope === null) return undefined',
    why: '本会话多次引为「缺表 = 放行」——这句话就是那条边界的**全部依据**',
  }),
  Object.freeze({
    file: 'runtime/dsh-composition/runtime-contract-server.mjs',
    line: 599,
    text: 'wireChecked: true,',
    why: '状态面七个字段里**唯一写死的字面量**，且全仓没有地方读它（§5 第 20 条）',
  }),
  Object.freeze({
    file: 'runtime/dsh-composition/external-api-scope.mjs',
    line: 1061,
    text: 'literalWouldMatchNothing: true,',
    why: '一处**无声声明**：规则只会匹配到与自己端点相同的东西（触发时不会报红）',
  }),
  Object.freeze({
    file: 'runtime/dsh-composition/enforcement-mapping.mjs',
    line: 266,
    text: 'whenUnattended: true,',
    why: '另一处**无声声明**：值守缺失时禁止询问（触发时不会报错）',
  }),
  Object.freeze({
    file: 'packages/credentials/credentials-local/src/index.ts',
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
    const full = resolve(base, p.file)
    if (!existsSync(full)) {
      // ★ "文件不在"有两种：DSH 侧且检出不在 ⇒ 无法判定；否则 ⇒ 真的坏了
      if (p.dsh === true && dshMissing) { external.push(p.file); continue }
      broken.push(`${p.file}:${p.line}（文件不在）`); continue
    }
    let lines = []
    try { lines = readFileSync(full, 'utf8').split('\n') } catch {
      broken.push(`${p.file}:${p.line}（读不出来）`); continue
    }
    if (p.line > lines.length) {
      broken.push(`${p.file}:${p.line}（文件只有 ${lines.length} 行）`); continue
    }
    checked++
    // ★ 两侧都 `trim()`：**钉的文本自己的格式不该影响比对**。
    //
    //   第一版只 trim 了磁盘那一侧，于是"钉里带了个行尾空格"会假红——
    //   而那是**我写钉时的手滑**，不是被引用代码的问题。（⑫c 抓到的。）
    const actual = lines[p.line - 1].trim()
    if (actual !== p.text.trim()) {
      broken.push(`${p.file}:${p.line} 现在是 ${JSON.stringify(actual)}，`
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
// ★★★ 第 45 轮：状态词表**只有一份**——由台账词表（`progress-check.mjs` 的
//   `LEDGER_STATUS_MARKS`）**派生**，加上"同一批状态的散文写法"。
//
//   此前这里有**三份**各不相同的表，而且它们互不相等：
//
//     | 处 | 内容 | 项数 |
//     | --- | --- | --- |
//     | 判据 A（文件级，只钉 `legion-host.patch.yml`）| `未完成\|已完成\|✅\|🟡\|⏸\|⬜` | 6 |
//     | 判据 B（类级，全部自称生成物的文件）| `STATUS_VOCAB` | 5 |
//     | 普查（`scratch/census-generated-status.mjs`，"只有 1 个实例"那句话的来源）| 9（**并集**）| 9 |
//
//   ⇒ 判据 A 漏 `待完成/未开始/部分完成`；判据 B 漏**四个标记全部**。
//
//   实测（`scratch/_probe-generated-status-vocab.mjs`）：今天两边读数**都是 0**，
//   差异**只存在于理论上**。但——
//
//     > 一次用**更大的网**做的普查，与一条用**更小的网**执行的判据，
//     > 在"结论是 0 违规"的时候是同一个读数——
//     > 只不过前者证明的是一件**更强**的事，而后者才是每天在跑的那一条。
//
//   ⇒ 一处所有：`GENERATED_STATUS_VOCAB` = 词表标记 + 散文写法。两条判据都用它，
//     普查也 import 它（不然"普查说只有 1 处"与"判据守住 1 处"仍然是两件事）。
const STATUS_WORD_FORMS = Object.freeze(['未完成', '已完成', '待完成', '未开始', '部分完成'])
export const GENERATED_STATUS_VOCAB = Object.freeze([
  ...LEDGER_STATUS_MARKS,
  ...STATUS_WORD_FORMS,
])
/** 转义正则元字符（词表将来若含 `(` 之类也不会静默失配）。 */
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 词表 → 一条"任取其一"的正则（**次序无关**，但案底里按词表原序）。 */
export const GENERATED_STATUS_RE = new RegExp(`(${GENERATED_STATUS_VOCAB.map(reEsc).join('|')})`)
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
      for (const w of GENERATED_STATUS_VOCAB) {
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
        'runtime-host-registrar': 'runtime-host-registrar',
        'runtime-contract-server': 'runtime-contract-server',
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
    source: PATCH_YML + '（生成物）正文里是否出现状态词（词表见 GENERATED_STATUS_VOCAB，由台账词表派生）',
    derive: (ctx) => {
      const m = GENERATED_STATUS_RE.exec(ctx.doc(PATCH_YML))
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
      + '★★★ 第 45 轮：这条判据的词表原来**比它引用的那次普查窄**——'
      + '普查用 9 项（并集），这里只有 5 项、**漏掉四个标记全部**。'
      + '今天两边读数都是 0（`scratch/_probe-generated-status-vocab.mjs`），'
      + '差异只存在于理论上；但"用更大的网普查、用更小的网执法"这件事本身'
      + '必须消失 ⇒ 两条判据与普查现在共用一份 `GENERATED_STATUS_VOCAB`。'
      + '⚠️ 边界：只覆盖**自称**是生成物的文件；不自称的不在扫描面内。'
      + '⚠️ 且要求任务号在状态词**附近 60 字符内**——'
      + '状态词离任务号更远时这条不报（那是宽恕，不是漏，但它有明确边界）。',
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

  // ── E. ★★★ 交接报告 §二 那张自称「机器读数，可复跑」的表（第 26 轮）────────
  //
  //   这几条的**两侧独立**是天然的：一侧是报告正文里人写的中文句子里的数字，
  //   另一侧是从产物里推出来的（读台账 / `git ls-files` / 基线 JSON / 常量）。
  Object.freeze({
    id: 'handover-ledger-tallies',
    what: '交接报告 §二 说台账"145 行 = 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜"',
    why: '★ **四个**数都必须核：只核 ✅ 的话，把 4 条暂停误写成完成、'
      + '或反过来把完成误写成暂停，都读不出来。'
      + '（我自己写这条的**探针**时就把台账解析写错过一次：按第 3 列取状态，'
      + '而真实格式下它报出 `0 ✅ / 3 ⏸ / 2 ⬜` —— 一个**看起来像发现**的错。）'
      + '★★ 第 44 轮又添一例，而且更值得记：`tallyLedger` 认不出 **🟡**，'
      + '于是它报 144 而不是 145。**那次错没有报出来**——因为报告里若写「144 行」，'
      + '它正好等于 `derive` 的值，这条事实会**判绿**。'
      + '⇒ 少算一个数与台账真的少一条，在报告里长得一样；'
      + '而只要**少算出来的那个数**被写进报告，门禁就替它背书。',
    source: LEDGER_DOC + ' 每行第 3 格的状态列',
    // ★★★ 第 46 轮：比较改用**键序无关**的规范化序列化。
    //
    //   原来两侧都是 `JSON.stringify(对象)`，于是**对象的键插入顺序**成了
    //   一条没人打算立的规矩：`tallyLedger` 的返回对象一旦按词表顺序建键
    //   （`✅ 🟡 ⬜ ⏸` ⇒ `done partial todo paused`），这条事实当场报
    //   「文档说 {"total":145,...}，产物是 {"total":145,"done":140,"partial":1,"todo":0,...}」
    //   —— 而**五个数一个都没变**。
    //
    //   > 一次"数字全对但键的次序不同"的报红，
    //   > 与一次"数字真的错了"的报红，在输出里只差几个字符的位置。
    //
    //   ★ 而键序本来就不该是这条事实的内容：它要核的是**五个数**。
    //     文档侧那行 `total / ✅ / 🟡 / ⏸ / ⬜` 的**书写次序**由下面的正则
    //     逐字钉住（那是给人读的），与被核的值分开。
    derive: (ctx) => canonicalJson(ctx.ledgerTallies()),
    claim: Object.freeze({
      doc: HANDOVER_DOC,
      // ★ 正则按文档的**书写次序**捕获（total / ✅ / 🟡 / ⏸ / ⬜）——那部分保持逐字。
      re: /台账 \| \*\*(\d+) 行 = (\d+) ✅ \/ (\d+) 🟡 \/ (\d+) ⏸ \/ (\d+) ⬜\*\*/,
      parse: (m) => canonicalJson({
        total: Number(m[1]), done: Number(m[2]), partial: Number(m[3]),
        paused: Number(m[4]), todo: Number(m[5]),
      }),
      note: '「台账 | **145 行 = 140 ✅ / 1 🟡 / 4 ⏸ / 0 ⬜**」',
    }),
  }),
  Object.freeze({
    id: 'handover-tracked-suites',
    what: '交接报告 §二 说"套件清单完备：N 个 `*.test.mjs` 全部有归属"',
    why: '★ 这是**产物侧**的数（`git ls-files`），报告里的 N 是人在第 25 轮写下的。'
      + '每一轮新增套件都会让它过期 —— 而它旁边那句"全部有归属"是'
      + '`stage` 阶段**当场**判的，两者挨在一起，看起来一样权威。',
    source: '`git ls-files -z "*.test.mjs"` 的条数',
    derive: (ctx) => ctx.trackedTestCount(),
    claim: Object.freeze({
      doc: HANDOVER_DOC,
      re: /套件清单完备 \| \*\*(\d+) 个/,
      note: '「套件清单完备 | **360 个 `*.test.mjs` 全部有归属**」',
    }),
  }),
  Object.freeze({
    id: 'handover-unreachable-total',
    what: '交接报告 §二 说可达性"不可达 **N** 条"',
    why: '★ 与 `reachability.mjs --diff` 同源，但**不同侧**：'
      + '一侧是报告正文里的数，另一侧是基线 JSON 里数组的长度。',
    source: REACHABILITY_BASELINE + ' → `unreachable.length`',
    derive: (ctx) => ctx.unreachableTallies().total,
    claim: Object.freeze({
      doc: HANDOVER_DOC,
      re: /不可达 \*\*(\d+)\*\* 条/,
      note: '「不可达 **46** 条，全部已定性」',
    }),
  }),
  Object.freeze({
    id: 'handover-doc-ratchet',
    what: '交接报告 §二 说全仓表格棘轮 **N**（只许降）',
    why: '★ 棘轮的语义是"只许减少"。常量与报告里的数**都**可能不跟着走：'
      + '常量留在旧值（棘轮失效），报告留在旧值（读数过期）。'
      + '这条把两侧绑在一起，任一侧不动都会红。',
    source: '`scripts/prt/doc-table-integrity.mjs` → `REPO_WIDE_BASELINE`',
    derive: (ctx) => ctx.docRatchet(),
    claim: Object.freeze({
      doc: HANDOVER_DOC,
      re: /全仓棘轮 \*\*(\d+)\*\*/,
      note: '「全仓棘轮 **87**（只许降）」',
    }),
  }),
  Object.freeze({
    id: 'handover-ci-prose-matches-table',
    what: '交接报告里正文那句"`test` 阶段那 N 秒"**必须等于**同一份报告表里最新一次 CI 的毫秒数',
    why: '★★ 这是本轮抓到的**真漂移**：表里写着四轮 CI 的读数，'
      + '而紧挨着表的正文说"`test` 阶段那 **808** 秒里，工作树的代码与文档'
      + '一个字节都没动过"——**808s 是第 23 轮**那次 CI 的数。'
      + '那句话是第 22 轮写的，第 23 轮加了一行表却**没改句子**。'
      + '⇒ 表说 825s、正文说 808s，两者都自称机器读数。'
      + '★ 判据的**两侧**：一侧是正文散文里的秒数，另一侧是表里最新那行的毫秒数。'
      + '两侧都在这份文档里，但这**不是**"手抄件互核"——'
      + '表里的毫秒数是每轮从 `summary.json` 抄进来的实测，'
      + '而散文那句是**对表的概括**；概括与表不一致本身就是缺陷。'
      + '★ 秒 = round(毫秒/1000)：报告里写的是取整后的秒。',
    source: HANDOVER_DOC + ' §二 表里最新一行 CI 的 `test` 毫秒数 ÷ 1000（四舍五入）',
    derive: (ctx) => {
      const text = ctx.doc(HANDOVER_DOC)
      const m = /全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` (\d+)ms/.exec(text)
      if (m === null) throw new Error('在交接报告里找不到"交付 HEAD"那一行 CI 读数')
      return Math.round(Number(m[1]) / 1000)
    },
    claim: Object.freeze({
      doc: HANDOVER_DOC,
      re: /`test` 阶段那 (\d+) 秒里/,
      note: '「`test` 阶段那 808 秒里…」',
    }),
  }),
  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ 第 51 轮：给**人工介入清单**加上它此前一条都没有的判据
  //
  // 为什么是这两条：它们是**便宜**（都只读那份文档本身）而**真的会红**的。
  //   · 新鲜度：那块读数标题写"第 A～B 轮"，B 必须等于家族表的最大轮次
  //     ⇒ 每轮往家族表加一行却不更新读数块 ⇒ 红。**今天就是红的。**
  //   · 自洽：声明的总数必须等于同一块里列出的各套件之和
  //     ⇒ 改了列表没改总数（或反过来）⇒ 红。
  //
  // ★ 而"某个套件**被漏掉**"这一种，这两条都抓不到（列表本身是手写的子集，
  //   没有便宜的权威来源）—— 诚实地记在 `why` 里，不假装覆盖。
  //   实践中漏掉发生在"某一轮加了套件"，而那正是新鲜度那条要人回来改块的时刻。
  // ══════════════════════════════════════════════════════════════════════════
  Object.freeze({
    id: 'intervention-readings-round',
    what: '人工介入清单里那块读数的标题说"第 N 轮结束时的读数"，N 必须等于**家族表的最大轮次**',
    why: '★★ 这条抓的是一个**已经发生**的缺陷：家族表已经排到第 50 轮，'
      + '而读数的标题还写着"第 45～47 轮结束时的读数"。'
      + '⇒ 一块**自称某个轮次**的读数，与一块**真的**属于那个轮次的读数，'
      + '在一页文档里长得一样；而它上面那张表**每一轮都会长一行**，'
      + '读数块却没有任何东西催它跟上。'
      + '★★ 标题**刻意只写一个数**（"第 N 轮"，不写"第 A～N 轮"）：'
      + '第一版写的是区间，而本套件的**通用反面控制**（把锚点里第一个数字 +1）'
      + '把 `第 45～50` 改成了 `第 46～50` —— **判据没红**，'
      + '因为 claim 只钉住了右端那个数，左端纯粹是装饰。'
      + '⇒ 一头说法只留一个数，锚点与派生量才对得上。'
      + '★ 留的残留（不假装覆盖）：某个套件**被漏在列表外**这一种抓不到 —— '
      + '列表是手写的子集，没有便宜的权威来源。实践中漏掉发生在"某一轮加了套件"，'
      + '而那正是这条要人回来改块的时刻。',
    source: INTERVENTION_DOC + ' 家族表里最大的 `| NN |` 轮次',
    derive: (ctx) => {
      const text = ctx.doc(INTERVENTION_DOC)
      // 家族表的行形如 `| 50 | ★★★ …`（§四）
      const rounds = [...text.matchAll(/^\| (\d{2}) \|/gm)].map((m) => Number(m[1]))
      if (rounds.length === 0) throw new Error('在人工介入清单里找不到家族表（`| NN |` 行）')
      return Math.max(...rounds)
    },
    claim: Object.freeze({
      doc: INTERVENTION_DOC,
      // ★ 必须**唯一**：这份文档里有**两块**"第 N 轮结束时的读数"
      //   （第 43 轮那块是**历史快照**，第 50 轮那块是**当前**的）。
      //   ★★ 只写 `第 (\d+) 轮结束时的读数` 时，框架的 `ANCHOR_AMBIGUOUS`
      //   当场报了"命中了 2 处 ⇒ 判据说的是哪一个数字取决于文档行序"——
      //   那正是本批一直在处理的那种"含义由位置决定"。
      //   ⇒ 用那块独有后缀 `（全部可复跑）` 把它钉死。
      re: /第 (\d+) 轮结束时的读数\*\*（全部可复跑）/,
      note: '「**第 50 轮结束时的读数**（全部可复跑）：」—— 那个数必须等于家族表的最大轮次',
    }),
  }),
  Object.freeze({
    id: 'report-section-three-max-round',
    what: '最终报告 §三 的标题说"截至第 N 轮"，N 必须等于 §三 里**带轮次小节的轮次最大值**',
    why: '★★ 这条抓的是一个**已经发生**的缺陷：§三 的小节已经到第 51 轮，'
      + '而标题还写着"第 15 轮做了什么"。'
      + '⇒ 一份**逐轮留档**的目录，标题是读者判断"这东西新不新"的**唯一**依据；'
      + '而每一轮都会往 §三 里加一节，标题却没有任何东西催它跟上。'
      + '★★ 锚点**刻意只圈一个数**：`截至第 N 轮`。'
      + '第一版想把"第 16 轮起，截至第 51 轮"整句都钉住，'
      + '而本套件的**通用反面控制**（把 `m[0]` 里第一个数字 +1）会去改**起点**那个数，'
      + '判据却不看它 ⇒ **控制不红**（第 51 轮在同一形状上踩过一次）。'
      + '★ 顺序不变式（轮次必须非递减）由 `roundOrderViolations` 承担、'
      + '在 `boundary-facts.test.mjs` 里逐条验，见 ⑱。',
    source: FINAL_REPORT_DOC + ' §三 里 `### 3.0*` 小节的轮次最大值',
    derive: (ctx) => {
      const rows = reportSectionRounds(ctx.doc(FINAL_REPORT_DOC))
      if (rows.length === 0) throw new Error('在最终报告 §三 里一个小节都没认出来 —— 本判据的输入空了')
      return Math.max(...rows.map((r) => r.round))
    },
    claim: Object.freeze({
      doc: FINAL_REPORT_DOC,
      re: /截至第 (\d+) 轮/,
      note: '「## 三、逐轮留档：第 16 轮起，截至第 51 轮」—— 只圈"截至"这个数',
    }),
  }),
  Object.freeze({
    id: 'intervention-suite-total',
    what: '人工介入清单里"⇒ N 个套件合计 **M 通过 / 0 失败**"的 M，必须等于同一块里列出的各套件之和',
    why: '★ 这一块是**手写的读数**：每个套件写一个 `x/y`，末行写一个总数。'
      + '总数是**对上面那几行的概括**，而概括与它概括的东西不一致，本身就是缺陷'
      + '（与 `handover-ci-prose-matches-table` 同一类）。'
      + '★ 两侧都在这份文档里，所以这**不是**"手抄件互核"：'
      + '左侧是逐个套件的读数，右侧是对它们的求和 —— 而求和是**算出来的**。',
    source: INTERVENTION_DOC + ' 读数块里每个 `N/N` 的分母之和',
    derive: (ctx) => {
      const text = ctx.doc(INTERVENTION_DOC)
      const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(text)
      if (m === null) throw new Error('在人工介入清单里找不到"⇒ …套件合计 **N 通过 / 0 失败**"那一句')
      // ★ 该句**上方**那几行里逐个套件的读数：`名字  → **29/29**` 或 `名字 **14/14**`
      const head = text.slice(0, m.index)
      const blockStart = head.lastIndexOf('结束时的读数')
      const block = blockStart < 0 ? head : head.slice(blockStart)
      let sum = 0
      for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
      if (sum === 0) throw new Error('读数块里一行 `**N/N**` 都没找到 —— 本判据的输入空了')
      return sum
    },
    claim: Object.freeze({
      doc: INTERVENTION_DOC,
      re: /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/,
      note: '「⇒ 十一个套件合计 **201 通过 / 0 失败**」',
    }),
  }),

  // ── C. 台账里的**坐标**（见上面那一大段说明与边界）──────────────────────
  Object.freeze({
    id: 'ledger-line-citations-resolve',
    what: '台账里每条 `文件:行` 引用都指向一个**存在且在行数范围内**的位置',
    why: '坐标是最脆的证据形式：在它上面插一行注释，它就指到别处去了，'
      + '而**句子一个字都没变**。'
      + '★ 实测（2026-09-18）：101 条唯一引用，**0 条坏**；'
      + '那 5 条本会话的结论所依赖的引用（`tool-request.mjs:731`、'
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
      + '而那个文件当时有 **719 行**，旧区间稳稳在范围内，判据看不见。'
      + '★★ 同日稍晚同一个调用点**又位移一次**（`:508-536` → `:534-562`，'
      + '第 19 条 §9.2 第 5 步在前面插入了连接器声明那块）——'
      + '**这一次是判据自己红的**（`boundary-facts.test.mjs` ⑫b 的载具断言），'
      + '不需要有人恰好读到这份文档。两次位移的分工就是这一层的价值所在。'
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

  // ── D2. ★★★ 我方判据文件不得**冒充清单** ────────────────────────────────
  Object.freeze({
    id: 'criteria-files-do-not-impersonate-manifests',
    what: '`scripts/prt/` 里的判据文件**没有**被可达性探针读成"清单声明"的写法',
    why: '★ 这是一次**好消息形状**的假信号，比"漏报"贵得多：'
      + 'CI 报"两族 gap 已经变成可达"，而它下面的指示是'
      + '**删 READINGS 条目、更新状态文档裁决、清基线**——照做就是'
      + '**把一个没接线的模块记成已接线**。'
      + '追下去：`external-api-scope.mjs` 有**零个**生产 importer，'
      + '它成为"入口"的理由是`清单声明（scripts/prt/boundary-facts.mjs）`——'
      + '**正是我上一轮加的那张手钉坐标表**（键名落在 `MANIFEST_PATTERNS` 里）。'
      + '★ 同一张表还**遮掩了一个已知缺口**：它让 `runtime-contract-server.mjs` 看起来可达，'
      + '而 §5 第 20 条说的正是"Runtime 契约服务端**没有生产挂点**"。'
      + '⇒ 一张记账表同时报了一个假的"接上了"、捂了一个真的"没接上"。'
      + '⚠️ 修的时候我又踩了一次（同一形状第五次）：在 `reachability.mjs` 的说明里'
      + '照样写出了那个键名 + 一个真路径当例子，于是探针把 `reachability.mjs` **自己**'
      + '记成了入口——**解释这个 bug 的注释复现了这个 bug**。'
      + '⚠️ 边界：只扫 `scripts/prt/`。**不能**扫全仓——'
      + '`patch-layer.mjs` / `process-manifest.mjs` 是**真清单**，那样写是**对的**；'
      + '一条"所有 .mjs 都不许写清单形状"的判据会**红在正确的地方**。',
    source: '`scripts/prt/*.mjs` 的源码文本 × 借用 `reachability.mjs` **导出的同一份**'
      + ' `MANIFEST_PATTERNS`（两份会漂的键表就是本仓的旧账，所以只留一份）；'
      + '只有"抓到的路径**真的是一个模块**"才算问题',
    derive: (ctx) => ctx.manifestImpersonation().bad.join(' | '),
    expect: '', // 空串 = 没有一处冒充
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
