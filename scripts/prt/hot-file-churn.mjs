#!/usr/bin/env node
// scripts/prt/hot-file-churn.mjs
// ============================================================================
// 热点文件改动节奏探针（阶段 3 评审闸门用）
//
// 回答一个问题：`plugins/src/index.ts` 与 `team-hub/server.mjs` 的日更节奏
// **降温了吗**？阶段 3（PRT-315/316）要重写这两个文件，在途功能若还在改它们，
// 冲突不是「分支对不上」而是「持续追着 main 跑」。
//
// ## 为什么需要一个工具，而不是随手跑一句 git log
//
// 因为**随手跑的那句是错的**。这两种写法看着像，结论完全不同：
//
//   git log -n 40 -- <file>        ❌ 先按路径过滤，再取 40 条
//                                    → 只要该文件被改过 ≥40 次，永远返回 40，
//                                      「最近 40 个提交都在改它」这一假象
//   git rev-list -n 40 HEAD        ✅ 先取最近 40 个提交，再数其中几个碰了该文件
//   git log <oldest>^..HEAD -- <f>
//
// 本工具用后者。第一版我用了前者，得出「两个文件在最近 40 个提交里被改了 40 次」，
// 差点据此判定「不能开工」；修正后是 1/40 与 2/40——**结论正好相反**。
// 一个会把「该开工」读成「不能开工」的测量方法，比没有测量更糟。
//
// 另注：`git log -- <file> | wc -l` 给出的是**全history累计**次数（实测 52 / 39），
// 它常被误当成「近期频率」——原计划里的「近 60 个提交被改 51/35 次」就是这一类。
//
// 用法：
//   node scripts/prt/hot-file-churn.mjs
//   node scripts/prt/hot-file-churn.mjs --json
//   node scripts/prt/hot-file-churn.mjs --window=40 --windows=6
//   node scripts/prt/hot-file-churn.mjs --help
// ============================================================================
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 阶段 3 要动的两个大文件（也是历史上争用最激烈的两个）。 */
export const HOT_FILES = Object.freeze([
  'plugins/src/index.ts',
  'team-hub/server.mjs',
])

/**
 * 把「最近 total 个提交」切成 size 大小的连续窗口（从新到旧）。
 *
 * 抽成纯函数是因为这里的边界最容易被写错（off-by-one 会让窗口重叠或跳过），
 * 而它又是整个探针的结论来源。窗口用**提交下标**表示，闭开区间 `[from, to)`。
 */
export function windowRanges(total, size, maxWindows) {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`window 必须是正整数，收到 ${size}`)
  if (!Number.isInteger(maxWindows) || maxWindows <= 0) throw new Error(`windows 必须是正整数，收到 ${maxWindows}`)
  const out = []
  for (let i = 0; i < maxWindows; i++) {
    const from = i * size
    const to = Math.min(from + size, total)
    if (from >= total) break
    out.push({ from, to, rank: i + 1, complete: to - from === size })
  }
  return out
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/**
 * 与 `git` 相同，但**吞掉 stderr**。
 *
 * 「不是 git 仓库」这类探测失败是**预期分支**，git 会往 stderr 打一行 fatal；
 * 不吞掉它，调用方（含测试输出与 CI 日志）会看起来像出错了。
 */
function tryGit(args, cwd = ROOT) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * 采集改动节奏。
 *
 * 每个窗口内的计数用 `<oldest>^..<newest> -- <file>`：这是一个**提交区间**上的
 * 路径过滤，语义正是「这 40 个提交里有几个碰了该文件」。
 */
export function collectChurn({ files = HOT_FILES, size = 40, windows = 6, cwd = ROOT } = {}) {
  const head = tryGit(['rev-parse', 'HEAD'], cwd)
  if (!head) return { ok: false, reason: '不是 git 仓库，或 HEAD 无法解析' }

  const all = git(['rev-list', 'HEAD'], cwd).split('\n').filter(Boolean)
  const ranges = windowRanges(all.length, size, windows)

  const perFile = {}
  for (const f of files) {
    const lifetime = git(['log', '--format=%h', '--', f], cwd).split('\n').filter(Boolean).length
    const lastHash = tryGit(['log', '-1', '--format=%H', '--', f], cwd)
    const lastDistance = lastHash ? all.indexOf(lastHash) : null
    const lastMeta = lastHash
      ? git(['log', '-1', '--format=%ad|%h|%s', '--date=short', '--', f], cwd).split('|')
      : null

    const perWindow = ranges.map((r) => {
      const newest = all[r.from]
      const oldest = all[r.to - 1]
      const count = git(['log', '--format=%h', `${oldest}^..${newest}`, '--', f], cwd)
        .split('\n')
        .filter(Boolean).length
      return { rank: r.rank, from: r.from + 1, to: r.to, count, complete: r.complete }
    })

    perFile[f] = {
      path: f,
      lifetimeCommits: lifetime,
      lastChangeDistance: lastDistance,
      lastChangeDate: lastMeta?.[0] ?? null,
      lastChangeCommit: lastMeta?.[1] ?? null,
      lastChangeSubject: lastMeta?.[2] ?? null,
      windows: perWindow,
      recent: perWindow[0]?.count ?? null,
    }
  }

  // 判定：最近一个窗口里「任何热点文件」被触及的次数。
  //
  // 阈值取**绝对值 2**，而不是与历史峰值比比例：阶段 3 的风险来自
  // 「我改这个文件时别人也在改」，2/40 意味着大约每 20 个提交才撞一次，
  // 手工 rebase 完全可承受；比例判据在历史峰值本身很低时会误判「未降温」。
  // 同时要求 recentMax ≤ 历史峰值——否则说明这是史上最热的窗口，不该开工。
  // `historicalPeak` 取 rank>1 的窗口，避免拿自己跟自己比。
  const recentCounts = Object.values(perFile).map((v) => v.recent ?? 0)
  const busiestPast = Math.max(
    ...Object.values(perFile).flatMap((v) => v.windows.filter((w) => w.rank > 1).map((w) => w.count)),
    0,
  )
  const recentMax = Math.max(...recentCounts, 0)
  const COOLED_ABSOLUTE_BAR = 2
  const cooled = recentMax <= COOLED_ABSOLUTE_BAR && recentMax <= Math.max(busiestPast, 1)
  return {
    ok: true,
    head: head.slice(0, 7),
    totalCommits: all.length,
    windowSize: size,
    files: perFile,
    verdict: {
      recentMax,
      recentPerFile: Object.fromEntries(Object.entries(perFile).map(([k, v]) => [k, v.recent])),
      historicalPeak: busiestPast,
      absoluteBar: COOLED_ABSOLUTE_BAR,
      cooled,
      reason: cooled
        ? `最近 ${size} 个提交中任一热点文件最多被触及 ${recentMax} 次（阈值 ≤${COOLED_ABSOLUTE_BAR}），历史峰值 ${busiestPast}`
        : `最近 ${size} 个提交中热点文件被触及 ${recentMax} 次（阈值 ≤${COOLED_ABSOLUTE_BAR}），历史峰值 ${busiestPast}`,
    },
  }
}

function usage() {
  console.log('hot-file-churn.mjs — 热点文件改动节奏探针（阶段 3 评审闸门）')
  console.log('')
  console.log('  --window=<n>    窗口大小（默认 40）')
  console.log('  --windows=<n>   窗口个数（默认 6）')
  console.log('  --json          机器可读')
  console.log('  --help          本说明')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()
  const size = Number(argv.find((a) => a.startsWith('--window='))?.slice('--window='.length)) || 40
  const windows = Number(argv.find((a) => a.startsWith('--windows='))?.slice('--windows='.length)) || 6

  const res = collectChurn({ size, windows })
  if (!res.ok) {
    console.error(`FAIL ${res.reason}`)
    process.exit(2)
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2))
    return
  }

  console.log(`HEAD ${res.head}　共 ${res.totalCommits} 个提交　窗口 ${res.windowSize}`)
  console.log('')
  for (const v of Object.values(res.files)) {
    console.log(`${v.path}`)
    console.log(`  累计触及 ${v.lifetimeCommits} 次（**全history**，不是近期频率）`)
    console.log(`  最近一次：${v.lastChangeDate} ${v.lastChangeCommit}（${v.lastChangeDistance} 个提交之前）`)
    console.log(`            ${v.lastChangeSubject}`)
    for (const w of v.windows) {
      const bar = '█'.repeat(w.count)
      console.log(`  第 ${String(w.from).padStart(3)}–${String(w.to).padStart(3)} 个提交  ${String(w.count).padStart(3)}/${res.windowSize}  ${bar}`)
    }
    console.log('')
  }
  const v = res.verdict
  console.log(`判定：最近 ${res.windowSize} 个提交中任一热点文件最多被触及 ${v.recentMax}/${res.windowSize}，历史峰值 ${v.historicalPeak}/${res.windowSize}`)
  console.log(`      ${v.reason}`)
  console.log(v.cooled
    ? '  → **已降温**：阶段 3 的文件争用风险低，可安排开工'
    : '  → **未降温**：在途功能仍在改这两个文件，阶段 3 应推迟')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
