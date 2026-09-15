// scripts/prt/dsh-pin-drift.mjs
// ============================================================================
// 门禁：`IMPLEMENTATION_FINDINGS` 里每条结论的**出处锚点**今天还成立吗？
//
// 补的是 PRT-211 记下的那条缺口：DSH **不是冻结依赖**，而六条"改变了适配器该怎么写"
// 的结论各自钉着文件 + 行号，**没有任何东西在核对**。升级一次 DSH，行号会漂、
// 措辞可能改，而结论会继续以原来的语气留在代码里。
//
//   > 一条"写着出处、但没人再核对过"的结论，
//   > 与一条"当初就是编的"结论，在下一个读者眼里是同一个东西——
//   > 只不过前者在库里看起来更像有依据。
//
// ## 三个读数，不是一个
//
//   0  全部锚点都还在
//   1  **漂移**：有锚点找不到了（要么 DSH 变了，要么锚点抄错了——两种都要人去核）
//   3  **未观察**：DSH 检出不在 ⇒ 我**没有**核对，所以**不说"通过"**
//
// 把 3 与 0 分开是本仓库付过学费的一条（PRT-214 的 `..._UNOBSERVED`）：
// "没人给观察结果"静默变成"观察结果是空"，会报出一个**错的诊断**。
//
//   > "没接"和"没做"是两个不同的问题，修法也不同。
//
// ## 它不判断结论对不对
//
// 只判断"当初引用的那句话还在不在"。锚点还在、结论却已经错了，是另一类问题
// （要人读实现），本模块不假装能发现——与 `EVIDENCE_LEVEL` 同一个立场。
//
// 用法：
//   node scripts/prt/dsh-pin-drift.mjs            # 核对（CI 用）
//   node scripts/prt/dsh-pin-drift.mjs --json     # 机器可读
// ============================================================================
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PIN_STATUS, checkDshPins, pinnedSources } from '../../runtime/adapters/dsh/pin-drift.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/**
 * 找 DSH 检出。
 *
 * 与 `scripts/ci/build-external-package.mjs` 同一套候选：这个脚本不该是
 * "只有作者那台机器能跑"的东西。找不到就是**未观察**，不是失败。
 */
export function resolveCheckout(env = process.env) {
  const candidates = [
    env.DSH_CHECKOUT,
    join(homedir(), 'dsh-harness'),
    join(homedir(), 'dsh'),
    join(homedir(), '.dsh', 'dsh-harness'),
    'D:/project/dsh/deepseek-harness',
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory() && existsSync(join(c, 'packages'))) return c
    } catch { /* 下一个候选 */ }
  }
  return null
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const argv = process.argv.slice(2)
  const checkout = resolveCheckout()
  const result = checkDshPins({ checkoutRoot: checkout })

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({
      checkout,
      observed: result.observed,
      ok: result.ok,
      checkedAnchors: result.checkedAnchors,
      driftCount: result.driftCount,
      sources: pinnedSources(),
      rows: result.rows,
      problems: result.problems,
    }, null, 2) + '\n')
    process.exit(!result.observed ? 3 : (result.ok ? 0 : 1))
  }

  // ★ 未观察：说清楚"我没核"，并且**不**打印任何像"通过"的字样。
  if (!result.observed) {
    process.stdout.write('dsh-pin-drift: **未观察**（不是通过）\n')
    process.stdout.write('  找不到 DSH 检出（候选：$DSH_CHECKOUT、~/dsh-harness、~/dsh、~/.dsh/dsh-harness、' +
      'D:/project/dsh/deepseek-harness），所以这一批的出处锚点**一条都没有核过**。\n')
    process.stdout.write(`  受影响：${pinnedSources().length} 个被引文件、` +
      '六条结论的出处全部未核。设 `DSH_CHECKOUT` 指向一个含 `packages/` 的检出即可真正核对。\n')
    process.exit(3)
  }

  if (result.problems.length > 0) {
    process.stdout.write('dsh-pin-drift: FAIL（结论自身的锚点声明有问题）\n')
    for (const p of result.problems) {
      process.stdout.write(`  ✖ [${p.status}] ${p.code}：${p.detail}\n`)
    }
    process.stdout.write('（"记下来但从不检查"的要求与"没有这个要求"，在库里的表现是同一个东西）\n')
    process.exit(1)
  }

  if (result.ok) {
    process.stdout.write(`dsh-pin-drift: PASS（${result.rows.length} 条结论、` +
      `${result.checkedAnchors} 个锚点，在被引文件里逐字命中）\n`)
    for (const row of result.rows) {
      const lines = row.anchors.map((a) => a.line).filter((n) => n !== null)
      const span = lines.length === 0 ? '' : `  行 ${Math.min(...lines)}-${Math.max(...lines)}`
      process.stdout.write(`  ✓ ${row.code}${span}  （${row.source}）\n`)
    }
    process.stdout.write(`  被引文件：${pinnedSources().join('、')}\n`)
    process.exit(0)
  }

  process.stdout.write(`dsh-pin-drift: FAIL（${result.driftCount} / ${result.rows.length} 条结论的出处对不上了）\n`)
  for (const row of result.drift) {
    const head = row.status === PIN_STATUS.FILE_MISSING
      ? `文件不存在：${row.source}`
      : `找不到锚点：${(row.missing ?? []).map((m) => JSON.stringify(m)).join('、')}`
    process.stdout.write(`  ✖ ${row.code}（${row.source}）\n      ${head}\n`)
  }
  process.stdout.write('  这**不代表**结论错了，也不代表结论对：它是"当初引用的那句话不在了"，\n')
  process.stdout.write('  两种情况都要人去读一遍实现：DSH 真的改了，或者锚点当初就抄错了。\n')
  process.stdout.write(`  DSH 检出：${checkout}\n`)
  process.exit(1)
}
