import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ★★★ 函数层的"活的 / 死的" —— 第二版（第一版有一处**系统性**错误，见下）
//
// ── 要回答的问题 ──
//
//   > "140 个 ✅"里的每一个，**判据交付了**与**能力在生产里真的跑着**，
//   > 是同一件事吗？
//
// 报告 §9.1 已经说了它们是两件事，并按**模块**量了（25 个模块不可达）。
// 但那是**模块**那一层：`scripts/prt/reachability.mjs` 只要模块被 import 就算可达。
// 于是这一类它**结构上看不见**：
//
//   > 一个"模块可达、但它的能力入口从来没人调"的模块，
//   > 与一个"这个能力真的在生产里跑着"的模块，
//   > 在按模块统计的可达性读数里是**同一个东西**。
//
// 本会话手工撞到两次：`registry.mjs` 的 `createRegistry()`、
// `employee-manifest.mjs` 的 `permitsTool()`。所以要机械地量一遍。
//
// ── 判据：从生产顶层出发的**不动点剥离**，不是数引用 ──
//
//   数引用会同时漏掉与多算（下面"五处遮蔽"逐条记着）。
//   正确的问题是：从文件顶层代码出发，**沿调用链**能走到哪些函数。
//
// ── 第一版的**系统性**错误（这一条让整个读数都不可信）──
//
//   第一版的 span（"这个函数是从哪一行到哪一行"）只按 **`export`** 声明切分。
//   而本仓库的文件里有**大量不导出的顶层函数**。于是 `team-hub/server.mjs` 里
//   一个 `export function artifactContent` 一口气吞掉了 **4000+ 行**
//   （L4882..L9039），把中间几十个函数全算成它的函数体 ⇒
//   那 4000 行里的一切都随它一起判死。
//
//     > 一个"按 `export` 切分函数体"的判据，与一个"按**顶层声明**切分函数体"的判据，
//     > 在文件里**只有导出函数**时读数完全一样——
//     > 只不过前者在有大段不导出函数时，会把一个函数体读成**几千行**，
//     > 而那个读数看起来仍然像一张正常的清单。
//
//   第二版按 `^[^\s]`（列 0 的代码行）切分顶层语句，并把列 0 的**注释块**
//   附到**后面**那一块（否则 `@param {…} resolveTool` 这种注释会造出假根）。
//
// ── 残余边界（诚实写在这里，不藏在代码里）──
//
//   · 仍是**文本**分析，不是绑定分析：`deps['createFoo']()`、`const a = obj.createFoo`、
//     以及"把这个函数名当字符串传给别的模块"都会漏 ⇒ dead 是**下界**。
//   · 只在文件**自己导出的**或**import 进来的**名字上建边（作用域近似）。
//   · 沿**调用**链走；把函数当数据传来传去（回调注册表）只在"名字出现在活的行上"时才算。

const gitFiles = (pat) =>
  execFileSync('git', ['ls-files', pat], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)

const isTest = (f) => /\.test\.mjs$/.test(f)
const files = gitFiles('*.mjs').filter((f) => !f.startsWith('.worktrees/'))
const prod = files.filter((f) => f.endsWith('.mjs') && !isTest(f))
const tests = files.filter(isTest)

const textOf = new Map()
for (const f of [...prod, ...tests]) textOf.set(f, readFileSync(f, 'utf8'))
const linesOf = new Map()
for (const [f, t] of textOf) linesOf.set(f, t.split('\n'))

// ── 1. 把每个生产文件切成"顶层块"
//
//    规则：**列 0 的代码行**开一个新块。列 0 的注释行**不**开新块
//    （它跟着后面那一块，否则文档注释里的 `@param {…} resolveTool` 会造出假根）。
const DECL_RES = [
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
]

/** @returns {{name:string|null, start:number, end:number, exported:boolean, kind:string}[]} */
function blocksOf(f) {
  const lines = linesOf.get(f)
  const starts = []
  let inComment = false
  let pendingCommentStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (inComment) {
      if (/\*\//.test(l)) inComment = false
      continue
    }
    // 打开一个块注释
    if (/^\s*\/\*/.test(l)) {
      if (!/\*\//.test(l)) inComment = true
      if (/^\/\*/.test(l) && pendingCommentStart === -1) pendingCommentStart = i
      continue
    }
    if (/^\s*\/\//.test(l)) continue
    if (/^\s*$/.test(l)) continue
    if (/^\s/.test(l)) continue // 缩进 ⇒ 不是顶层
    // ★ 列 0 的代码行 ⇒ 新块的开始（把前面挂着的列 0 注释并进来）
    const start = pendingCommentStart === -1 ? i : pendingCommentStart
    starts.push(start)
    pendingCommentStart = -1
  }
  // 去重并排序
  const uniq = [...new Set(starts)].sort((a, b) => a - b)
  const blocks = []
  for (let k = 0; k < uniq.length; k += 1) {
    const start = uniq[k]
    const end = k + 1 < uniq.length ? uniq[k + 1] - 1 : lines.length - 1
    // 从块内第一行**代码**找声明名。★ 不能只看 start..start+3——
    // 本仓库的文档注释动辄 10～40 行（那正是它的风格），
    // 限长会把声明行整个跳过，于是"顶层导出"一个都认不出来。
    //
    //   > 一个"在前几行里找声明"的判据，与一个"跳过注释之后找声明"的判据，
    //   > 在注释很短的时候读数完全一样——只不过前者在本仓库这种
    //   > **长文档注释**的风格下，会把几乎所有导出读成"不是导出"。
    let name = null
    let exported = false
    let kind = 'statement'
    for (let i = start; i <= end; i += 1) {
      const l = lines[i]
      if (/^\s*(\/\/|\*|\/\*|\*\/)/.test(l) || /^\s*$/.test(l)) continue
      for (const re of DECL_RES) {
        const m = re.exec(l)
        if (m) { name = m[1]; kind = 'decl'; break }
      }
      if (name !== null) {
        exported = /^export\s/.test(l)
        break
      }
      if (/^import\b/.test(l)) { kind = 'import'; break }
      if (/^export\s*\{/.test(l)) { kind = 'reexport'; break }
      break
    }
    blocks.push({ name, start, end, exported, kind })
  }
  return blocks
}

const blocksCache = new Map()
for (const f of prod) blocksCache.set(f, blocksOf(f))

// ── 2. 全局符号表：名字 ⇒ 定义它的块
const defining = new Map() // name ⇒ Set(`${file}@${start}`)
for (const [f, blocks] of blocksCache) {
  for (const b of blocks) {
    if (b.name === null) continue
    const key = `${f}@${b.start}`
    if (!defining.has(b.name)) defining.set(b.name, new Set())
    defining.get(b.name).add(key)
  }
}
const allNames = new Set(defining.keys())

// ── 3. 每个文件"可见的"名字：自己定义的 + import 进来的
const importedCache = new Map()
for (const f of prod) {
  const src = textOf.get(f)
  const set = new Set()
  for (const m of src.matchAll(/^\s*import\s*\{([\s\S]*?)\}\s*from/gm)) {
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(local)) set.add(local)
    }
  }
  for (const m of src.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/gm)) set.add(m[1])
  for (const m of src.matchAll(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/gm)) set.add(m[1])
  importedCache.set(f, set)
}
const ownNames = new Map()
for (const [f, blocks] of blocksCache) {
  ownNames.set(f, new Set(blocks.filter((b) => b.name !== null).map((b) => b.name)))
}

// ── 4. 建边：块 ⇒ 它引用的名字
const edgeOf = new Map() // `${file}@${start}` ⇒ Set(name)
const roots = new Set() // 顶层语句块里引用的名字
let inComment = false

for (const f of prod) {
  const lines = linesOf.get(f)
  const blocks = blocksCache.get(f)
  const visible = new Set([...(importedCache.get(f) ?? []), ...(ownNames.get(f) ?? [])])
  const ownerOf = new Map()
  for (const b of blocks) for (let i = b.start; i <= b.end; i += 1) ownerOf.set(i, b)

  inComment = false
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (inComment) { if (/\*\//.test(l)) inComment = false; continue }
    if (/^\s*\/\*/.test(l)) { if (!/\*\//.test(l)) inComment = true; continue }
    if (/^\s*\/\//.test(l)) continue
    const b = ownerOf.get(i)
    if (b === undefined) continue
    if (b.kind === 'import' || b.kind === 'reexport') continue

    for (const name of allNames) {
      if (name.length <= 3) continue
      if (!visible.has(name)) continue
      if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(l)) continue
      // 跳过它自己的声明行
      if (b.name === name && i === b.start) continue
      if (b.kind === 'decl' || b.kind === 'statement') {
        if (b.name === null) roots.add(name)
        else {
          const key = `${f}@${b.start}`
          if (!edgeOf.has(key)) edgeOf.set(key, new Set())
          edgeOf.get(key).add(name)
        }
      }
    }
  }
}

// ── 5. 不动点：从 roots 出发，沿"定义 → 函数体引用的名字"传播
const liveNames = new Set()
const liveBlocks = new Set()
const q = [...roots]
while (q.length > 0) {
  const n = q.pop()
  if (liveNames.has(n)) continue
  liveNames.add(n)
  for (const key of defining.get(n) ?? []) {
    if (liveBlocks.has(key)) continue
    liveBlocks.add(key)
    for (const m of edgeOf.get(key) ?? []) q.push(m)
  }
}

// ── 6. 报告
const ENTRY_SHAPE = /^(create|install|read|resolve|bind|open|permits?|allow|apply|load|ensure|wire|mount|record|enable|start|register|provision|plan|adopt|export|uninstall|publish|run|build|make|send|write|delete|update|list|find|get|set|has|is|to|from)[A-Z]/
const SELFCHECK = /^(assert|prove|verify|describe|sample|check)[A-Z]/

const exportedDecls = []
for (const [f, blocks] of blocksCache) {
  for (const b of blocks) if (b.kind === 'decl' && b.exported && b.name) exportedDecls.push({ file: f, name: b.name })
}

console.log(`生产文件 ${prod.length} / 测试 ${tests.length}；顶层导出声明 ${exportedDecls.length} 条`)
console.log(`顶层块合计 ${[...blocksCache.values()].reduce((a, b) => a + b.length, 0)}；其中具名 ${allNames.size} 个名字`)
console.log(`live 名字 ${liveNames.size}；live 块 ${liveBlocks.size}`)

// 自检：判据不许悄悄变空 / 变全
if (allNames.size < 500 || liveBlocks.size < 200) {
  console.log('★★ 判据坏了（名字或块太少）⇒ 拒绝给出读数'); process.exit(1)
}

const deadEntries = exportedDecls
  .filter((e) => !liveNames.has(e.name) && ENTRY_SHAPE.test(e.name) && !SELFCHECK.test(e.name))
  .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))

console.log('')
console.log(`=== dead 的**能力入口**：${deadEntries.length} 条 ===`)
for (const e of deadEntries) console.log(`  ${e.name.padEnd(38)} ${e.file}`)

console.log('')
console.log('=== 对照（答案必须与人工核过的一致）===')
for (const [n, want] of [
  ['permitsTool', 'dead（人工：0 个生产调用方）'],
  ['createRegistry', 'live（本批接进 assemble.mjs）'],
  ['scopePortFromEnv', 'live（早先接进 root-row.mjs）'],
  ['readExecutionPlaneConfig', 'dead（人工：零生产导入方）'],
  ['readAuthRequired', 'live（被 team-hub/server.mjs 的路由层调）'],
  ['createCalendarEvent', 'live（同上一行）'],
  ['resolveModelChain', 'live（被 team-hub/binding-store.mjs 调）'],
  ['createContextStage', 'dead（人工：只被测试调）'],
]) {
  const ex = exportedDecls.find((e) => e.name === n)
  const got = ex === undefined ? '**不是顶层导出**' : (liveNames.has(n) ? 'live' : 'dead')
  const ok = got === want.slice(0, 4) ? '✔' : '✖'
  console.log(`  ${ok} ${n.padEnd(26)} 脚本=${got.padEnd(22)} 人工=${want}`)
}
