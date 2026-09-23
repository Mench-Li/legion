/**
 * 把"手写 `process.env.DSH_CHECKOUT ?? null`"的套件机械地改成用共享解析器。
 *
 * ## 为什么要脚本而不是手改
 *
 * 11 个文件、每个两处替换、形状几乎一致。手改的问题是**漏一个看不出来**：
 * 漏掉的那个套件仍然会跳过，而"跳过"与"真的跑了但恰好没跳过"
 * 在 `skipped=` 这个读数上……其实能看出来；但在**改之前**看不出来。
 * 脚本能做的是：每个文件断言"恰好替换了 1 处"，替换不到就**报错停**，
 * 而不是静默跳过那个文件。
 *
 * ## 改哪两处
 *
 * ```js
 * const DSH = process.env.DSH_CHECKOUT ?? null          // ①
 *   ↓
 * const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
 * const DSH = DSH_FOUND.checkout
 * ```
 *
 * ```js
 * const UNAVAILABLE = DSH === null
 *   ? '未配置 DSH_CHECKOUT'                             // ②
 *   ↓
 *   ? DSH_FOUND.reason
 * ```
 *
 * 第 ② 处那**一句**是全部要点：改之前那个理由是**手写的常量**，
 * 它不知道检出其实在盘上；改之后它来自解析器，于是
 * 「没找到」「找到了但没构建」「变量指错了」是三句不同的话。
 *
 * ## 幂等
 *
 * 已经改过的文件里没有 `process.env.DSH_CHECKOUT ?? null`，脚本会把它报成
 * "已经是新形状"并跳过——**不是**报错，因为重跑这个脚本是合法操作。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const ROOT = resolve('.')
const TESTS = resolve(ROOT, 'tests', 'dsh-checkout.mjs')

const FILES = [
  'runtime/dsh-composition/plugins/root-row-dsh-process.test.mjs',
  'runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs',
  'runtime/dsh-composition/plugins/runtime-host-binding-unblocked-dsh-process.test.mjs',
  'runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs',
  'runtime/dsh-composition/plugins/root-row.test.mjs',
  'runtime/dsh-composition/plugins/runtime-host-row.test.mjs',
  'runtime/dsh-composition/approval-answerer.test.mjs',
  'runtime/dsh-composition/pre-execute.test.mjs',
  'runtime/dsh-composition/enforcement-plugin.test.mjs',
  'runtime/dsh-composition/run-floor.test.mjs',
  'runtime/dsh-composition/employee-preset.test.mjs',
]

const OLD_DSH = 'const DSH = process.env.DSH_CHECKOUT ?? null'
const NEW_DSH = [
  '// ★ 检出用**共享解析器**找（`tests/dsh-checkout.mjs`），不在这里手写',
  '//   `process.env.DSH_CHECKOUT ?? null`。手写的后果实测过：变量没导出时',
  '//   本套件整组跳过，而 CI 报的是 `PASS`——一个「跑了 0 条」的绿。',
  'const DSH_FOUND = resolveDshCheckout({ need: \'cli\' })',
  'const DSH = DSH_FOUND.checkout',
].join('\n')

const OLD_REASON = "  ? '未配置 DSH_CHECKOUT'"
const NEW_REASON = '  ? DSH_FOUND.reason'

const count = (s, needle) => s.split(needle).length - 1

let changed = 0
const report = []
for (const rel of FILES) {
  const abs = resolve(ROOT, rel)
  let src = readFileSync(abs, 'utf8')
  const before = src

  if (!src.includes(OLD_DSH)) {
    report.push([rel, '已经是新形状（没有手写的那一行）', src === before])
    continue
  }
  if (count(src, OLD_DSH) !== 1) throw new Error(`${rel}: 手写的那一行出现 ${count(src, OLD_DSH)} 次（应为 1）`)
  if (count(src, OLD_REASON) !== 1) {
    throw new Error(`${rel}: 手写理由那句出现 ${count(src, OLD_REASON)} 次（应为 1）——形状与预期不同，先看文件`)
  }

  src = src.replace(OLD_DSH, () => NEW_DSH)
  src = src.replace(OLD_REASON, () => NEW_REASON)

  // ── 插 import：放在**顶部那段连续 import 区的最后一条之后** ────────────
  //   ESM 的 import 会被提升，放中间也能跑；但"能跑"与"读起来对"是两件事，
  //   而这个仓库里所有文件的 import 都在顶部。
  //
  //   ★★ 这个检测器坏过**两次**，两次都是"按行看 import"的必然结果：
  //
  //   第一版：`/^import\s/` 找最后一行。被**多行 import**
  //     （`import {\n a, b,\n} from './x.mjs'`）骗到——只匹配第一行，
  //     新 import 被插进那个块**中间** ⇒ 语法错误。
  //
  //   第二版（上一版）：加了花括号配平，但仍按行扫**整个文件**。于是被
  //     **模板字符串里的生成代码**骗到——这些套件会拼出形如
  //     `import realRootRow from ${JSON.stringify(...)}` 的文本，它开头
  //     也长得像 import，于是新 import 被插进了那段**字符串**里
  //     （实测：`root-row-dsh-process.test.mjs` 第 345 行，在模板字面量内部）。
  //
  //   > 一个"按行判断这行是不是 import"的检测器，
  //   > 与一个"真的知道模块头在哪结束"的检测器，在单行 import +
  //   > 没有生成代码的文件上给出同一个答案——这就是它前两版都能通过自检的原因。
  //
  //   现在只认**顶部那段连续区**：从第 0 行起，跳过空行与注释，
  //   只要当前行是 import 就吃掉整条语句；一旦遇到别的东西就**停**。
  //   模板块在文件很下面，永远到不了。
  const lines = src.split('\n')
  let lastImportEnd = -1
  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line) || /^\s*(\/\/|\/\*|\*)/.test(line)) continue
    if (!/^import[\s{'"]/.test(line)) break
    // 吃掉整条 import 语句（含多行形式）
    let depth = 0
    let j = i
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      const chunk = lines.slice(i, j + 1).join('\n')
      if (depth === 0 && (/from\s+['"]/.test(chunk) || /^import\s+['"]/.test(lines[i]))) break
      if (j - i > 30) throw new Error(`${rel}: 第 ${i + 1} 行起的 import 语句没有结束（形状异常）`)
    }
    lastImportEnd = j
    i = j
  }
  if (lastImportEnd < 0) throw new Error(`${rel}: 顶部 import 区里一条静态 import 都没找到，先看文件`)
  const importPath = relative(dirname(abs), TESTS).replace(/\\/g, '/')
  const importLine = `import { resolveDshCheckout } from '${importPath.startsWith('.') ? importPath : './' + importPath}'`
  if (src.includes(importLine)) throw new Error(`${rel}: import 已经在了，但手写的那一行还在——半改状态`)
  lines.splice(lastImportEnd + 1, 0, '', importLine)
  src = lines.join('\n')

  writeFileSync(abs, src)
  changed++
  report.push([rel, `改了（import: ${importPath}）`, true])
}

console.log(`改了 ${changed} / ${FILES.length} 个文件\n`)
for (const [rel, note] of report) console.log('  ' + rel.padEnd(66) + note)

// ── 自检：每个改过的文件都语法正确 ──────────────────────────────────────
console.log('\n语法自检：')
let bad = 0
for (const rel of FILES) {
  try {
    execFileSync(process.execPath, ['--check', resolve(ROOT, rel)], { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log('  ok   ' + rel)
  } catch (e) {
    bad++
    console.log('  FAIL ' + rel + '\n' + String(e.stderr ?? '').split('\n').slice(0, 4).join('\n'))
  }
}
process.exit(bad === 0 ? 0 : 1)
