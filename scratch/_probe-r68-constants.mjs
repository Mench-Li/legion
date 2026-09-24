// scratch/_probe-r68-constants.mjs —— 第 68 轮：那三项能力是**常量**，没有任何输入能改它们
//
// 第 67 轮我说"自检永远不兼容"。本轮把它证成**结构性的**而不是"难"：
// 如果那三项 `satisfied` 是**字面量**、不看 ctx、不看配置、不看环境，
// 那就**不存在**任何一个 fixture 能让自检通过 —— 改 fixture 是白改。
import { runtimeCapabilityEvidence } from '../runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs'
import { readFileSync } from 'node:fs'

console.log('  ① 用完全不同的"现场"各调一次，看读数变不变')
const contexts = [
  ['null', null],
  ['空对象', {}],
  ['带 subagents（形状完整）', {
    get: (n) => (n === 'subagents'
      ? { list: () => ['p1'], getProvider: () => ({ capabilities: { outputSchema: true } }), start: () => {} }
      : undefined),
  }],
  ['ctx 自己就抛', { get() { throw new Error('boom') } }],
]
const rows = []
for (const [name, ctx] of contexts) {
  let r
  try {
    r = runtimeCapabilityEvidence(ctx)
  } catch (e) {
    console.log(`     ${name.padEnd(26)} **抛了**：${e?.message ?? e}（serviceOf 不吞 ctx.get 的异常）`)
    continue
  }
  rows.push([name, r.capabilities])
  console.log(`     ${name.padEnd(26)} ${JSON.stringify(r.capabilities)}`)
}

const keys = Object.keys(rows[0][1])
let allSame = true
for (const k of keys) {
  const vals = new Set(rows.map(([, c]) => c[k]))
  if (vals.size !== 1) allSame = false
  console.log(`     · ${k.padEnd(30)} 四种现场下的取值集合 = {${[...vals].join(', ')}}${vals.size === 1 ? '  ← 常量' : '  ← 真的取决于输入'}`)
}
console.log(`\n  ⇒ ${allSame ? '★ 四项里没有任何一项取决于输入 —— 它们全是常量' : '至少一项取决于输入'}`)

console.log('\n  ② 源码里那三项是不是字面量 `satisfied: false`')
const src = readFileSync('D:/project/DSH/legion/runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs', 'utf8')
const fnBody = src.slice(src.indexOf('export function runtimeCapabilityEvidence'))
let lit = 0
for (const m of fnBody.slice(0, fnBody.indexOf('\n}')).matchAll(/'([a-z-]+)':\s*\{[\s\S]{0,120}?satisfied:\s*(true|false)/g)) {
  lit += 1
  console.log(`     ${m[1].padEnd(30)} satisfied: ${m[2]}`)
}
console.log(`     ⇒ 在函数体里**写死**的 satisfied 共 ${lit} 处`)

console.log('\n  ③ 结论')
console.log('     任取一个 fixture，四项能力里恒有三项为 false；而 probe 要求"显式为 true"')
console.log('     ⇒ **不存在任何一个 fixture 能让自检通过。改 fixture 是白改。**')
