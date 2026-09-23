import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

// ★ 手钉坐标是承重的：`tool-request.mjs` 的那句
//   `if (pathScope === null) return undefined` 从 **639** 一路挪到 **731**
//   （第一次 +42 行 = `connectorFeedback`，第二次 +50 行 = F-21 判定面）。
//
//   机检的那一条（`PINNED_CITATIONS`）已经改过了。这一遍处理的是**叙述性**引用
//   ——它们不会让 CI 变红，但会让下一个照着坐标去读的人落在 `}` 上。
//
//   > 一个"机检的那一条是对的、其余都是旧的"的仓库，
//   > 与一个"每一条都对"的仓库，在 CI 的读数上是同一个全绿——
//   > 只不过前者的判据只覆盖了它自己那一行。

const FROM = 'tool-request.mjs:639'
const TO = 'tool-request.mjs:731'

const files = execFileSync('git', ['ls-files', '*.mjs', '*.md', '*.json'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => !f.startsWith('scratch/') && !f.startsWith('.worktrees/'))

// ★ 另一会话的在制品一律不碰（它不是我的树）。
const dirty = new Set(
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    .split('\n').map((l) => l.slice(3).trim()).filter(Boolean),
)
const MY_WIP = new Set([
  'scripts/ci/run-ci.mjs', 'scripts/prt/boundary-facts.mjs',
  'runtime/dsh-composition/production-scope-wiring.test.mjs',
])

let total = 0
const touched = []
for (const f of files) {
  let t
  try { t = readFileSync(f, 'utf8') } catch { continue }
  if (!t.includes(FROM)) continue
  if (dirty.has(f) && !MY_WIP.has(f)) { console.log(`  ⏭ 跳过（另一会话的在制品）：${f}`); continue }
  const lines = t.split('\n')
  let n = 0
  const out = lines.map((l) => {
    if (!l.includes(FROM)) return l
    // ★ 守卫：只改**确实**在说这个文件那一句的行。
    if (!/tool-request\.mjs:639/.test(l)) return l
    n += 1
    return l.split(FROM).join(TO)
  })
  if (n === 0) continue
  writeFileSync(f, out.join('\n'), 'utf8')
  total += n
  touched.push({ f, n })
}
console.log(`改了 ${touched.length} 个文件、共 ${total} 处：`)
for (const t of touched) console.log(`  ${String(t.n).padStart(2)}  ${t.f}`)
if (total === 0) { console.log('★ 一处都没改到 ⇒ 拒绝报告成功'); process.exit(1) }
