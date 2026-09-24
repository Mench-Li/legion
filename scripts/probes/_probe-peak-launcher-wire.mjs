// scratch/_probe-r118r5-peakmut.mjs —— 变异验证：把 launcher 那根线删掉，判据必须红（用完**具名**删）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const F = 'product/launcher/launcher.mjs'
const orig = readFileSync(F)
const text = orig.toString('utf8')
const EOL = text.includes('\r\n') ? '\r\n' : '\n'
const LINE = '      peakResource: x.peakResource ?? null,'
if (!text.includes(LINE)) { console.log('  ✖ 变异点没找到（行尾或缩进变了）'); process.exit(1) }

const run = () => {
  try {
    const out = execFileSync('node', ['--test', 'product/launcher/launcher.test.mjs'], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') } }
}
const summarize = (out) => {
  const t = (out.match(/^ℹ tests (\d+)/m) ?? [])[1]
  const p = (out.match(/^ℹ pass (\d+)/m) ?? [])[1]
  const f = (out.match(/^ℹ fail (\d+)/m) ?? [])[1]
  const bad = [...out.matchAll(/^✖ (.+)$/gm)].map((m) => m[1].trim()).slice(0, 2)
  return `tests=${t} pass=${p} fail=${f}${bad.length ? `  红的：${bad.join(' / ')}` : ''}`
}

console.log(`  EOL=${EOL === '\r\n' ? 'CRLF' : 'LF'}`)
const base = run()
console.log(`  基线（未变异）：退出 ${base.code}；${summarize(base.out)}`)

// 变异：把那一行从闭合映射里删掉（正是注释里说的"少了这一行，落盘的永远是 null"）
writeFileSync(F, text.split(LINE + EOL).join(''))
const mut = run()
console.log(`  变异（删掉 peakResource 那一行）：退出 ${mut.code}；${summarize(mut.out)}`)
console.log(mut.code === 0
  ? '  ✖ 没咬住 —— 那根线**没有**判据钉着'
  : '  ✔ 咬住 —— 那根线有判据钉着')

writeFileSync(F, orig)
const back = run()
console.log(`  还原后：退出 ${back.code}；${summarize(back.out)}`)
