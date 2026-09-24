// scripts/probes/build-targets-exist.mjs
// ============================================================================
// **T10**（2026-09-24）：外部包构建用的 DSH 侧依赖路径，**今天还在不在**。
//
// ## 它补的是什么
//
// `scripts/ci/build-external-package.mjs` 把每个外部包的 DSH 依赖按**字面路径**
// 软链进 `<包>/node_modules/`。而 DSH 不是冻结依赖：它一拆包/改名，这些字面路径
// 就**静默过期** —— 构建会以
//
//     build: dependency target missing: …\packages\preset\agent-presets
//
// 报错，而这句话读起来是"**缺这个包**"，不是"**路径过期了**"。
//
//   > 一次"上游把路径挪了"的升级，与一次"这个能力从来没接上"，
//   > 在只读构建报错的眼里是同一件事 —— 而两句诊断引向完全不同的修法。
//
// 这件事在 2026-09-24 真的发生了（DSH 把 `dsh-agent-presets` 拆成
// `dsh-agent-preset` + `dsh-agent-preset-registry`），而**没有任何判据在核这些路径**。
// 本脚本就是那条判据：逐个核，且核的是**构建自己用的那份名单**（`configs`）。
//
// ## 两个方向
//
//   ① 每个 `[名, 路径]` 的路径必须在检出里存在；
//   ② 每个外部包在 `package.json` 里声明的 `@deepseek-ai/*` peer 依赖，
//      必须在构建配置里有对应条目（否则构建出来的 `node_modules` 里没有它，
//      `tsc` 会在更晚、更难懂的地方报错）。
//
// ## 未观察 vs 通过
//
// 找不到 DSH 检出 ⇒ 退出 3（**未观察**），不打"通过"。与 `dsh-pin-drift.mjs` 同一立场。
//
// 用法：node scripts/probes/build-targets-exist.mjs
// ============================================================================
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configs, dependencyTargets } from '../ci/build-external-package.mjs'
import { resolveDshCheckout } from '../lib/dsh-checkout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

const found = resolveDshCheckout({ env: process.env, need: 'packages' })
const checkout = found.checkout
if (checkout === null) {
  console.log(`build-targets-exist: **未观察**（不是通过）—— ${found.reason}`)
  process.exit(3)
}
console.log(`  检出：${checkout}`)

let bad = 0
for (const packageName of Object.keys(configs)) {
  const targets = dependencyTargets(packageName, checkout)
  const missing = targets.filter((t) => !t.exists)
  console.log(`  ${packageName}：${targets.length} 个依赖目标，缺 ${missing.length} 个`)
  for (const t of missing) {
    console.log(`    ✖ ${t.name} → ${t.rel}（期望在 ${t.target}）`)
    bad += 1
  }

  // ② 声明的 peer 依赖必须在配置里有条目（否则软链不出来）
  const pj = JSON.parse(readFileSync(join(REPO, packageName, 'package.json'), 'utf8'))
  const peers = Object.keys(pj.peerDependencies ?? {}).filter((n) => n.startsWith('@deepseek-ai/') || n === 'cordis' || n === 'schemastery')
  const wired = new Set(targets.map((t) => t.name))
  for (const n of peers) {
    if (!wired.has(n)) {
      console.log(`    ✖ ${packageName} 声明了 peer 依赖 ${n}，而构建配置里没有它的条目 ⇒ 软链不出来`)
      bad += 1
    }
  }
}

if (bad > 0) {
  console.log(`\n  ⇒ ${bad} 处对不上。`
    + '\n  ★ 修法分两种，先分清是哪种：**上游把路径挪了**（去 DSH 检出里核包名与目录）'
    + '还是**本仓少写了一条**（补 `configs`）。')
  process.exit(1)
}
console.log(`\n  ⇒ ${Object.keys(configs).length} 个外部包的目标路径全部存在，且 peer 依赖全部有对应条目。`)
