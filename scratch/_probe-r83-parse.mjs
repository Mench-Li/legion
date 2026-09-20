// scratch/_probe-r83-parse.mjs —— 第 83 轮：我提交的那些 scratch 脚本，有几个**根本不能解析**？
//
// ★ 起因：第 82 轮编码检查抓到 `_mutate-r55-s5index.mjs` 的 `import` 被并进了注释里
//   ⇒ 它 27 轮都跑不起来，而**语法阶段与我的十三个套件都没抓到**。
//   ⇒ 那就要问：**还有几个是坏的？**
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const R = 'D:/project/DSH/legion'
const files = execFileSync('git', ['ls-files', 'scratch/*.mjs', '*.mjs'], { cwd: R, encoding: 'utf8' })
  .split('\n').map((s) => s.trim())
  .filter((f) => f && /^(_|scratch\/_)/.test(f.split('/').pop() ?? f))
const mine = [...new Set(files)]
console.log(`  受版本控制的、以 _ 开头的脚本：**${mine.length}** 个\n`)

const broken = []
for (const f of mine) {
  try {
    execFileSync(process.execPath, ['--check', f], { cwd: R, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const msg = `${e.stderr ?? ''}`.split('\n').find((l) => /Error|error/.test(l)) ?? ''
    broken.push([f, msg.trim().slice(0, 100)])
  }
}

if (broken.length === 0) {
  console.log('  ★ 全部能解析（0 个坏的）')
} else {
  console.log(`  ✖ 不能解析的：**${broken.length}** 个`)
  for (const [f, m] of broken) console.log(`     · ${f}\n       ${m}`)
}

// 顺带：这些脚本里有多少**引用了一个已不存在的文件**
console.log('\n  ── 顺带核一件事：有多少脚本读的路径今天已经不在？ ──')
let dangling = 0
for (const f of mine) {
  let src = ''
  try { src = readFileSync(`${R}/${f}`, 'utf8') } catch { continue }
  const refs = [...src.matchAll(/['"`]((?:D:\/project\/DSH\/legion\/)?[\w./-]+\.(?:mjs|json|md))['"`]/g)]
    .map((m) => m[1].replace('D:/project/DSH/legion/', ''))
    .filter((p) => p.startsWith('docs/') || p.startsWith('scripts/') || p.startsWith('runtime/') || p.startsWith('product/'))
  for (const p of [...new Set(refs)]) {
    try { readFileSync(`${R}/${p}`, 'utf8') } catch { dangling += 1; console.log(`     ✖ ${f} → ${p}（不存在）`); break }
  }
}
if (dangling === 0) console.log('     ★ 没有引用已不存在的受管文件')
