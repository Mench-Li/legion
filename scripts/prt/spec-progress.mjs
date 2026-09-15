// scripts/prt/spec-progress.mjs
// ============================================================================
// 把「完成了多少 / 还剩多少」写进**需求文档自己**（spec 里的两处进度区）。
//
// 为什么需要它：台账 `docs/superpowers/prt/PRT-PROGRESS.md` 是按任务逐行写的，
// 有 276 行、几万字。想知道"整体到哪了"要自己数——**而这正是人不会去做的事**。
// 于是 spec（那份被当成基准的文档）里没有一个地方能回答这个问题，
// 每个问"进度到哪了"的人都要重新问一遍。
//
//   > 一份"信息都在里面"的台账，与一份"能回答『还剩多少』"的台账，
//   > 在有人真的去数之前，是同一个东西——只不过前者会让每个人都问同一个问题。
//
// ## 两个区，都归本脚本维护
//
//   ① **头部指针**（`LEGION-PROGRESS-HEAD`）：文件开头一行，给"从头读起"的人。
//      没有它，进度只存在于 1300 行之后——而没人会翻到最后才发现它。
//   ② **附录 A.7 总览**（`LEGION-PROGRESS`）：分期表 + 尚未完成任务逐条列出。
//
//   ★ 头部那行**也**由本脚本生成，而不是手写。第一版是手写的，里面写着
//   "132 / 145"——一个派生数字，也就是说它从写下的那一刻就开始过期。
//
//     > 一个"指向权威数字"的指针，如果自己抄了一份数字，
//     > 与一个"抄了一份数字并打算记得同步"的副本，是同一个东西——
//     > 只不过前者看起来像是在指路。
//
// ## 这些区是**生成**的，不是手写的
//
// 进度数字是派生量：它由台账的 145 个状态标记算出来。手写派生数字一定会错
// ——`progress-check.mjs` 的文件头已经记了两次作者把阶段计数写错的先例，
// 而那个脚本存在的理由就是"手写的派生数字就是会错"。
// 同一个理由在这里更严重：spec 是**被当成基准**的那份文档，
// 它上面一个过期的百分比，比台账里一个错数字更容易被当真。
//
// 所以两处都放在 `BEGIN` / `END` 标记之间，由本脚本整体重写；
// `--check` 验证它们与台账一致，手改即变红（`run-ci` 的 `doc` 阶段默认跑它）。
//
//   > 一个"每次都要记得同步"的进度表，与一个"从来没有同步过"的进度表，
//   > 在读者眼里是同一个东西——只不过前者在第一次忘记之后开始说谎。
//
// ## 解析复用 `progress-check.mjs` 的导出，不重写一遍
//
// 台账的行形状、阶段标题、状态标记都在那边解析（含"表格行必须闭合"那条判据）。
// 本脚本 import 它的 `parseProgress`/`tally`/`STATUS_MARKS`：
// 两处各写一份解析器，迟早会对同一份台账给出两个答案。
//
// 用法：
//   node scripts/prt/spec-progress.mjs            # 用台账重算并写入 spec（两个区）
//   node scripts/prt/spec-progress.mjs --check    # 只验证一致（CI 用），不一致则非零退出
//   node scripts/prt/spec-progress.mjs --print    # 只打印附录区，不写文件
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STATUS_MARKS, parseProgress, tally } from './progress-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PROGRESS = join(ROOT, 'docs', 'superpowers', 'prt', 'PRT-PROGRESS.md')
const SPEC = join(ROOT, 'docs', 'superpowers', 'specs', '2026-09-11-legion-product-runtime-design.md')

/** 保留一位小数的百分比。除数为 0 时返回 `—`：0/0 说成 0% 是在编一个读数。 */
function pct(done, total) {
  if (total === 0) return '—'
  return `${((done / total) * 100).toFixed(1)}%`
}

/** 台账 → 统计。所有渲染都从这里取数，避免两处各算一遍。 */
export function summarize(progressText) {
  const { phases } = parseProgress(progressText)
  if (phases.length === 0) {
    throw new Error('台账里没有解析到任何阶段：文件结构变了，生成的进度会是一份空表而不是一份错的表')
  }
  const rows = phases.map((p) => ({ phase: p, t: tally(p) }))
  const grand = [0, 0, 0, 0]
  let total = 0
  for (const r of rows) {
    for (let c = 0; c < 4; c++) grand[c] += r.t.counts[c]
    total += r.t.total
  }
  const [done, part, unstarted, external] = grand
  const todo = []
  for (const r of rows) {
    for (const t of r.phase.tasks) {
      if (t.status !== '✅') todo.push({ phase: r.phase.key, id: t.id, title: t.title, status: t.status })
    }
  }
  todo.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)))
  return { rows, total, done, part, unstarted, external, remaining: part + unstarted + external, todo }
}

/** 头部指针（一行）。数字必须来自 `summarize`，不得手写。 */
export function renderHeadBlock(s) {
  return [
    '',
    `> **实施进度：${s.done} / ${s.total} 已完成（${pct(s.done, s.total)}），尚未完成 ${s.remaining} 个。**` +
    '见文末 **附录 A.7 任务进度总览**；逐条现状见 `docs/superpowers/prt/PRT-PROGRESS.md`。',
    '> 该区由 `node scripts/prt/spec-progress.mjs` 从台账生成，`run-ci` 的 `doc` 阶段会验证它与台账一致——手改即变红。',
    '',
  ]
}

/** 附录 A.7：分期表 + 尚未完成任务 + 口径说明。 */
export function renderAppendixBlock(s) {
  const out = []
  out.push('')
  out.push('### A.7 任务进度总览（**由台账生成，勿手改**）')
  out.push('')
  out.push(`**已完成 ${s.done} / ${s.total} = ${pct(s.done, s.total)}**　·　`
    + `尚未完成 **${s.remaining}** 个；还有 ${s.unstarted} 个从未开始。`)
  out.push('')
  out.push('| 阶段 | ✅ 已完成 | 🟡 部分 | ⏸ 需外部输入 | ⬜ 未开始 | 合计 | 完成率 |')
  out.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const r of s.rows) {
    const c = r.t.counts
    out.push(`| 阶段 ${r.phase.key} ${r.phase.title} | ${c[0]} | ${c[1]} | ${c[3]} | ${c[2]} | ${r.t.total} | ${pct(c[0], r.t.total)} |`)
  }
  out.push(`| **合计** | **${s.done}** | **${s.part}** | **${s.external}** | **${s.unstarted}** | **${s.total}** | **${pct(s.done, s.total)}** |`)
  out.push('')

  // 尚未完成的任务逐条列出：问"还剩多少"的人，真正想知道的是"还剩哪些"。
  out.push(`**尚未完成的 ${s.todo.length} 个任务**（逐条现状见 \`docs/superpowers/prt/PRT-PROGRESS.md\` 对应行）：`)
  out.push('')
  out.push('| 任务 | 名称 | 状态 | 阶段 |')
  out.push('| --- | --- | --- | --- |')
  const labelOf = (mark) => (STATUS_MARKS.find((x) => x.mark === mark)?.label ?? '读数失败')
  for (const t of s.todo) {
    out.push(`| ${t.id} | ${t.title} | ${t.status} ${labelOf(t.status)} | ${t.phase} |`)
  }
  out.push('')

  // 口径说明与数字**放在同一个区块里**：分开写的话，读者可能只看到百分比。
  // 这段话是手写的，但它跟着数字一起被重写，所以不会与数字脱节。
  out.push('> **这个百分比的口径（不要读成「产品已完成 91%」）**：')
  out.push('> ')
  out.push('> 本表的 ✅ 判的是**该任务自己的交付物与用例是否已交付**，')
  out.push('> 不是"该阶段的完成标准（exit criteria）已满足"。两者不是一回事：')
  out.push('> 阶段 2.5 及其后各阶段的完成标准涉及**真实端到端跑通**（真引擎、真任务、')
  out.push('> 真审批往返），那些标准目前**尚未达标**，而其中很多任务自己的交付物是齐的。')
  out.push('> ')
  out.push(`> 因此：**${s.done} / ${s.total} 是"任务交付率"，不是"产品完成度"。**`)
  out.push('> ')
  out.push(`> 另有 ${s.part} 个 🟡 是"已有交付物但完成标准未全部满足"。`)
  out.push(`> 把 🟡 也计入"已开工"，则已开工 ${s.done + s.part} / ${s.total} = ${pct(s.done + s.part, s.total)}。`)
  out.push('> 真实完成度按**完成标准**判定；里程碑方面 **M0、M1 已达成**，M1.5 未达标。')
  out.push('')
  return out
}

/** 两个受管区。`render` 一律只依赖 `summarize` 的结果。 */
export const REGIONS = Object.freeze([
  {
    name: '头部指针',
    begin: '<!-- LEGION-PROGRESS-HEAD:BEGIN',
    end: '<!-- LEGION-PROGRESS-HEAD:END -->',
    render: renderHeadBlock,
  },
  {
    name: '附录 A.7',
    begin: '<!-- LEGION-PROGRESS:BEGIN',
    end: '<!-- LEGION-PROGRESS:END -->',
    render: renderAppendixBlock,
  },
])

const linesOf = (text) => text.split(/\r?\n/)
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n')

export function findRegion(text, begin, end) {
  const lines = linesOf(text)
  const start = lines.findIndex((l) => l.startsWith(begin))
  const stop = lines.findIndex((l) => l.trim() === end)
  if (start === -1 || stop === -1 || stop < start) return null
  return { lines, start, stop }
}

/** 用一个区的新内容替换它（保留 BEGIN/END 标记行本身）。 */
export function spliceRegion(text, region, blockLines) {
  const found = findRegion(text, region.begin, region.end)
  if (found === null) {
    throw new Error(`spec 里找不到「${region.name}」的标记（需要成对的 \`${region.begin} ... -->\` 与 \`${region.end}\`）。` +
      '标记缺失时**不自动追加**：那会让脚本去猜"插在哪里"，而插错位置的进度区比没有更坏')
  }
  const { lines, start, stop } = found
  return [...lines.slice(0, start + 1), ...blockLines, ...lines.slice(stop)].join(eolOf(text))
}

/** 依次重写两个区。 */
export function rewriteAll(specText, s) {
  let text = specText
  for (const region of REGIONS) text = spliceRegion(text, region, region.render(s))
  return text
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const argv = process.argv.slice(2)
  const progressText = readFileSync(PROGRESS, 'utf8')
  const specText = readFileSync(SPEC, 'utf8')

  let s
  let next
  try {
    s = summarize(progressText)
    next = rewriteAll(specText, s)
  } catch (e) {
    process.stderr.write(`spec-progress: ${e.message}\n`)
    process.exit(2)
  }

  if (argv.includes('--print')) {
    process.stdout.write(renderAppendixBlock(s).join('\n') + '\n')
    process.exit(0)
  }

  const normalize = (t) => t.split(/\r?\n/).join('\n')
  const same = normalize(next) === normalize(specText)

  if (argv.includes('--check')) {
    if (same) {
      process.stdout.write(`spec-progress: PASS（spec 两处进度区与台账一致：${s.done}/${s.total}，未完成 ${s.remaining}）\n`)
      process.exit(0)
    }
    const a = normalize(specText).split('\n')
    const b = normalize(next).split('\n')
    process.stdout.write('spec-progress: FAIL（spec 的进度区与台账不一致）\n')
    // 只报前几处不同，不打印整块：整块 diff 有上百行，看的人只会跳过它。
    let shown = 0
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 6; i++) {
      if (a[i] !== b[i]) {
        process.stdout.write(`  ✖ 第 ${i + 1} 行\n    文件里：${a[i] ?? '（无此行）'}\n    台账应是：${b[i] ?? '（无此行）'}\n`)
        shown++
      }
    }
    process.stdout.write('  （跑 `node scripts/prt/spec-progress.mjs` 用台账重算）\n')
    process.exit(1)
  }

  if (same) {
    process.stdout.write('spec-progress: 已一致，无需改写\n')
    process.exit(0)
  }
  writeFileSync(SPEC, next, 'utf8')
  process.stdout.write(`spec-progress: 已用台账重算并写入 spec 两处进度区（${s.done}/${s.total}，未完成 ${s.remaining}）\n`)
}
