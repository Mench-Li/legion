// scratch/_probe-decl-exclusion.mjs —— 那个"排除声明块自己"的守卫，到底能不能被走到？
import { mirrorPattern, membersOf, DECL_RE, measureDeclaration } from '../scripts/prt/declaration-mirrors.mjs'

const decls = [
  "export const FIELDS = Object.freeze(['key', 'pid', 'image'])",
  "export const M = Object.freeze([\n  'key',\n  'pid',\n])",
  "export const F = Object.freeze(['key','pid']); const row = { key: 1 }",
]
for (const d of decls) {
  const m = [...d.matchAll(DECL_RE)][0]
  const members = membersOf(m[2])
  const lines = d.split('\n')
  const start = lines.findIndex((l) => l.includes(`export const ${m[1]}`))
  let end = start
  while (end < lines.length && !/\]\)/.test(lines[end])) end += 1
  const selfMatches = []
  for (let i = 0; i < lines.length; i++) {
    for (const mem of members) {
      if (mirrorPattern(mem).test(lines[i])) selfMatches.push(`L${i + 1}(${i >= start && i <= end ? '声明块内' : '声明块外'}):${mem}`)
    }
  }
  console.log(`声明: ${JSON.stringify(d.slice(0, 60))}`)
  console.log(`  声明块 = L${start + 1}..L${end + 1}；声明成员【引号内】被键位规则命中的位置：${selfMatches.length === 0 ? '★ 一个都没有' : selfMatches.join(' ')}`)
  // 同一个串，但成员**不带引号**（如果声明写成这样就会自命中——但它不会被 DECL_RE 收）
  const unq = `export const ${m[1]} = Object.freeze([key, pid])`
  console.log(`  若成员不带引号，键位规则命中吗：${members.map((x) => mirrorPattern(x).test(unq)).join(',')}（而那种声明 membersOf 返回 null ⇒ 整张表被跳过）`)
  console.log('')
}
console.log('结论：数组声明里的成员**永远带引号**，所以键位规则（要求 `member:` 或 `, member,`）')
console.log('      在声明块内**没有任何可命中的形状** ⇒ `isDeclarationLine` 那道守卫走不到。')
