// scripts/prt/design-boundaries.mjs
// ============================================================================
// 目标文档 **§2 line 128** 那 5 条「不可突破的边界」：每一条都必须**声明它怎么被守着**，
// 而声称有机械判据的那几条，判据必须**真的跑**、且**真的查了东西**。
//
// ---------------------------------------------------------------------------
// ## 为什么需要这一格（第 38 轮）
//
// §2 那一行逐字写着：
//
//   > 不可突破的边界：不自研第二套 Agent Loop；不复制任务/审批/审计数据库；
//   > 不把 worktree 当安全沙箱；不在契约稳定前同时支持多个 Harness；
//   > 客户不需要单独安装或升级 DSH。
//
// 第 38 轮实测：这一行在**整仓里只出现一次**（就是它自己）。
// `git grep '不可突破的边界'` 只命中目标文档与本仓状态文档——
// **没有任何判据、没有任何模块、也没有任何别处的文档引用过这 5 条。**
//
//   > 五条「不可突破的边界」与五句没人读过的愿望，
//   > 在"它们有没有被守住"这个读数下是同一个东西。
//
// ## 这一格真正防的形状
//
// ① **边界没有人认领**：5 条里哪几条有机械判据、哪几条只是设计决定，
//    此前无法回答。于是"守住了"与"从没人看过"长得一模一样。
//
// ② ★★ **机械判据的空转**：本轮的探针第一版就是**整套假阴性**——
//    它调的 `rg` 在本机**不在 PATH 上**（`spawnSync rg ENOENT`），
//    而 `catch { return [] }` 把 ENOENT 与"没有匹配"吞成了同一个值 ⇒
//    5 条边界**全部**报 0 命中。
//
//    > 一个依赖缺失的检索器，与一个真的什么都没匹配到的仓库，
//    > 在"零命中"这个读数下是同一个东西——只不过前者的 0 来自**没跑**。
//
//    ⇒ 每个机械判据都必须报出**它扫了几个文件**，且有一个下限；
//      扫到 0 个文件 ⇒ 红（"什么都没查"不许报绿）。
//
// ③ **声称有判据，而判据不存在**：`kind: 'mechanical'` 的每一条都必须解析到一个
//    **真的跑得起来的** check；`kind: 'design'` 的每一条必须写出**为什么它没有
//    机械形状**（≥20 字），而不是"记了一笔"。
//
// ★ 本模块**不用任何外部命令**去搜内容（只 `git ls-files` 取清单 + `readFileSync` 读）：
//   第 38 轮那次假阴性正是"依赖一个不在 PATH 上的可执行文件"造成的。
// ============================================================================
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { REPO } from './reachability.mjs'

export const SPEC_PATH = `${REPO}/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`

/** 那一段的起头，逐字。锚不在 ⇒ 红（不是静默 0 条）。 */
export const ANCHOR = '不可突破的边界：'

/**
 * 从 §2 里取出那 5 条边界（按 `；` 切，去掉句末的 `。`）。
 *
 * ★ 取不到锚时返回 **null**，而不是 `[]`：
 *   「这一节没有边界」与「我没找到那一节」是两件事，处置完全不同。
 */
export function designBoundaries(specPath = SPEC_PATH) {
  const text = readFileSync(specPath, 'utf8')
  const line = text.split('\n').find((l) => l.includes(ANCHOR))
  if (line === undefined) return null
  const body = line.slice(line.indexOf(ANCHOR) + ANCHOR.length)
  return body.split('；').map((s) => s.trim().replace(/。\s*$/, '')).filter(Boolean)
}

/** `git ls-files` 的跟踪清单（去重、转 `/`）。 */
export function trackedFiles(globs = []) {
  const out = execFileSync('git', ['ls-files', '-z', ...globs], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
  return out.split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))
}

const read = (f) => readFileSync(`${REPO}/${f}`, 'utf8')
const isTest = (f) => f.includes('.test.')

// ── 机械判据（每个都返回 { scanned, found }）────────────────────────────────

/**
 * C1 ④ 不在契约稳定前同时支持多个 Harness
 *   可机械化的形式：`runtime/adapters/` 下**只能有一个**适配器实现目录。
 *   出现第二个 ⇒ 有人在做多 Harness，而那条**明确不许**在契约稳定前做。
 */
function checkSingleHarness() {
  const files = trackedFiles(['runtime/adapters/*'])
  const dirs = [...new Set(files.map((f) => f.split('/').slice(0, 3).join('/')))].sort()
  return { scanned: files.length, found: dirs, expected: ['runtime/adapters/dsh'] }
}

/**
 * C2 ① 不自研第二套 Agent Loop
 *   可机械化的形式：会在**自己这边**长出第二套 loop 的三层（orchestrator / product /
 *   team-hub）里，`agentLoop` 这个名字一次都不许出现。
 *   它出现在 `runtime/adapters/dsh/`（适配层在**声明 DSH 自己的**服务面）与
 *   `runtime/dsh-composition/`（探针在**量 DSH 的**子代理面）里是正确的。
 */
function checkNoSecondAgentLoop() {
  const files = trackedFiles(['orchestrator/*', 'product/*', 'team-hub/*'])
    .filter((f) => /\.(mjs|ts)$/.test(f))
  const found = files.filter((f) => /agentLoop|agent_loop|AgentLoop/.test(read(f)))
  return { scanned: files.length, found, expected: [] }
}

/**
 * C3 ② 不复制任务/审批/审计数据库
 *   可机械化的形式：`team-hub/` 下打开控制面库的**生产**文件只有那一个。
 *   多一个 ⇒ 出现了第二本"任务/审批/审计"账。
 *   （`team-hub/scripts/` 是运维脚本，不算；用例各自开 `:memory:` 或隔离库，不算。）
 */
function checkSingleControlPlaneDb() {
  const files = trackedFiles(['team-hub/*'])
    .filter((f) => /\.(mjs|ts)$/.test(f) && !isTest(f) && !f.startsWith('team-hub/scripts/'))
  const found = files.filter((f) => /new DatabaseSync\(/.test(read(f)))
  return { scanned: files.length, found, expected: ['team-hub/server.mjs'] }
}

/**
 * C4 ⑤ 客户不需要单独安装或升级 DSH
 *   可机械化的形式：产品代码里不许有"下载/安装 DSH"这一步
 *   （PRT-011 路线 C：DSH 随交付物一起来，不是客户自己去装的东西）。
 */
function checkNoDshInstaller() {
  const files = trackedFiles(['product/*', 'runtime/*'])
    .filter((f) => /\.(mjs|ts)$/.test(f) && !isTest(f))
  const found = files.filter((f) => /installDsh|installDSH|dsh[-_.]{0,3}(zip|tar\.gz)/.test(read(f)))
  return { scanned: files.length, found, expected: [] }
}

/** 判据名 → 实现。`declaration.check` 必须解析到这里（否则红）。 */
export const CHECKS = Object.freeze({
  'single-harness': checkSingleHarness,
  'no-second-agent-loop': checkNoSecondAgentLoop,
  'single-control-plane-db': checkSingleControlPlaneDb,
  'no-dsh-installer': checkNoDshInstaller,
})

/**
 * 5 条边界 → 它**怎么被守着**。
 *
 * ★ `text` 必须与 §2 那一行里的那一段**逐字**相同——它是锚，正文改字而这里不改 ⇒ 红。
 * ★ `kind: 'mechanical'` ⇒ `check` 必须解析到 `CHECKS` 里一个真的跑得起来的判据。
 * ★ `kind: 'design'`     ⇒ `why` 必须写出**为什么它没有机械形状**（≥20 字）。
 */
export const BOUNDARY_DECLARATIONS = Object.freeze([
  Object.freeze({
    key: 'no-second-agent-loop',
    text: '不自研第二套 Agent Loop',
    kind: 'mechanical',
    check: 'no-second-agent-loop',
    how: 'orchestrator / product / team-hub 三层里 `agentLoop` 一次都不许出现——'
      + '它只允许出现在适配层（声明 DSH 自己的服务面）与 `runtime/dsh-composition/` 的探针里。',
  }),
  Object.freeze({
    key: 'single-control-plane-db',
    text: '不复制任务/审批/审计数据库',
    kind: 'mechanical',
    check: 'single-control-plane-db',
    how: '`team-hub/` 下打开控制面库的生产文件只有 `team-hub/server.mjs` 一个；'
      + '各 store 一律**收句柄**，不自己开库。',
  }),
  Object.freeze({
    key: 'worktree-not-sandbox',
    text: '不把 worktree 当安全沙箱',
    kind: 'design',
    why: '这一条**没有可机械解析的形状**：它约束的是"安全边界建在哪一层"这个设计判断，'
      + '而仓库里 `worktree` 有 125 个文件提到、绝大多数是说"这次 Attempt 的独立检出"——'
      + '把出现次数当违反会立刻得到一片假阳性。第 38 轮实测：'
      + '**没有任何一处代码把 worktree 与 sandbox/沙箱并列**（两种相邻写法各 0 命中），'
      + '安全边界确实建在强制面（PRT-603～606 与 `run-floor`）而不是 worktree 上；'
      + '但"没有一处这样写"是一个**读数**，不是一条能长期把守的判据。',
  }),
  Object.freeze({
    key: 'single-harness',
    text: '不在契约稳定前同时支持多个 Harness',
    kind: 'mechanical',
    check: 'single-harness',
    how: '`runtime/adapters/` 下只能有**一个**适配器实现目录（今天只有 `dsh`）；'
      + '出现第二个 ⇒ 有人在做多 Harness，而 F-23 明确记着这是**设计决定**不是缺口。',
  }),
  Object.freeze({
    key: 'no-dsh-installer',
    text: '客户不需要单独安装或升级 DSH',
    kind: 'mechanical',
    check: 'no-dsh-installer',
    how: '产品代码里不许出现"下载/安装 DSH"这一步（PRT-011 路线 C：DSH 随交付物一起来）。',
  }),
])

/**
 * 核对 5 条边界。
 *
 * @param {{boundaries: string[]|null, declarations: Array, checks?: object}} input
 */
export function checkDesignBoundaries({ boundaries, declarations, checks = CHECKS }) {
  const violations = []

  // ★★★ "什么都没查"不许报绿
  if (boundaries === null) {
    violations.push({
      id: 'anchor-missing',
      message: `目标文档里找不到 \`${ANCHOR}\` ⇒ 这一格什么都没查（那一行被改过？）。`,
    })
    return { ok: false, violations, reading: { boundaries: 0, declarations: declarations.length, mechanical: 0 } }
  }
  if (boundaries.length === 0) {
    violations.push({ id: 'no-boundaries', message: `\`${ANCHOR}\` 后面一条都没有。` })
    return { ok: false, violations, reading: { boundaries: 0, declarations: declarations.length, mechanical: 0 } }
  }

  const byText = new Map()
  for (const d of declarations) {
    if (byText.has(d.text)) {
      violations.push({ id: 'duplicate-declaration', message: `\`${d.text}\` 声明了两次` })
    }
    byText.set(d.text, d)
  }

  // R1：每一条边界**恰好**被一条声明认领
  for (const b of boundaries) {
    if (!byText.has(b)) {
      violations.push({
        id: 'boundary-unowned',
        message: `边界「${b}」**没有任何声明**说它怎么被守着 ⇒ `
          + '它与一句没人读过的愿望，在"守住了没有"这个读数下是同一个东西。',
      })
    }
  }
  // R2：声明不许指向一条已经不存在的边界（正文改了而这里没改）
  const bset = new Set(boundaries)
  for (const d of declarations) {
    if (!bset.has(d.text)) {
      violations.push({
        id: 'stale-declaration',
        message: `声明 \`${d.key}\` 的文本「${d.text}」在 §2 那一行里**找不到** ⇒ 正文改了而这里没改`,
      })
    }
  }

  const reading = { boundaries: boundaries.length, declarations: declarations.length, mechanical: 0, scanned: {} }
  for (const d of declarations) {
    if (d.kind === 'mechanical') {
      reading.mechanical += 1
      const fn = checks[d.check]
      if (typeof fn !== 'function') {
        violations.push({
          id: 'check-missing',
          message: `声明 \`${d.key}\` 声称有机械判据，而 \`${d.check}\` **解析不到**任何实现 ⇒ `
            + '一条声称有判据的边界，与一条真有判据的边界，在这里长得一样。',
        })
        continue
      }
      const r = fn()
      reading.scanned[d.key] = r.scanned
      // ★★★ 空转守卫：扫到 0 个文件 ⇒ 这个判据什么都没查
      if (!(r.scanned > 0)) {
        violations.push({
          id: 'check-scanned-nothing',
          message: `\`${d.key}\` 的判据扫了 **0** 个文件 ⇒ 它报的"通过"来自**没跑**。`
            + '（第 38 轮的真事：探针调的 `rg` 不在 PATH 上，`catch` 把 ENOENT 吞成"没有匹配"，'
            + '5 条边界全部报 0 命中。）',
        })
        continue
      }
      const got = [...r.found].sort()
      const want = [...r.expected].sort()
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        violations.push({
          id: 'boundary-breached',
          message: `**边界被破了**（${d.text}）：扫了 ${r.scanned} 个文件，`
            + `期望 ${JSON.stringify(want)}，实测 ${JSON.stringify(got)}`,
        })
      }
    } else if (d.kind === 'design') {
      const why = d.why ?? ''
      if (why.trim().length < 20) {
        violations.push({
          id: 'design-without-why',
          message: `\`${d.key}\` 声明成"设计决定"，却没写出**为什么它没有机械形状**`
            + `（${why.trim().length} 字，下限 20）——`
            + '那样它与一条"我们还没做"的边界就分不开了',
        })
      }
    } else {
      violations.push({ id: 'bad-kind', message: `\`${d.key}\` 的 kind 是 ${JSON.stringify(d.kind)}，不在 mechanical / design 里` })
    }
  }

  return { ok: violations.length === 0, violations, reading }
}

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ specPath = SPEC_PATH } = {}) {
  return checkDesignBoundaries({
    boundaries: designBoundaries(specPath),
    declarations: BOUNDARY_DECLARATIONS,
  })
}

// ── CLI：`node scripts/prt/design-boundaries.mjs`（只读）──────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

if (isMain) {
  const r = checkRepo()
  console.log(`§2「不可突破的边界」${r.reading.boundaries} 条 → 声明 ${r.reading.declarations} 条`
    + `（机械 ${r.reading.mechanical} / 设计 ${r.reading.declarations - r.reading.mechanical}）`)
  for (const [k, n] of Object.entries(r.reading.scanned)) console.log(`   ${k}: 扫了 ${n} 个文件`)
  if (r.ok) {
    console.log('\n✅ 每一条边界都有人认领，声称有判据的都会真的跑、且真的查了东西')
    process.exit(0)
  }
  console.log(`\n✖ ${r.violations.length} 处：`)
  for (const v of r.violations) console.log(`  [${v.id}] ${v.message}`)
  process.exit(1)
}
