// 括号配平定位（只读）：找出第一个让深度失衡的位置。
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const from = Number(process.argv[3] ?? 1)
const to = Number(process.argv[4] ?? 0)
const lines = readFileSync(file, 'utf8').split(/\r?\n/)

let depth = 0
let blockComment = false
let quote = null
const stack = []

for (let i = 0; i < lines.length; i += 1) {
  const L = lines[i]
  let j = 0
  if (blockComment) {
    const e = L.indexOf('*/')
    if (e < 0) continue
    j = e + 2
    blockComment = false
  }
  for (; j < L.length; j += 1) {
    const c = L[j]
    if (quote !== null) {
      if (c === '\\') { j += 1; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '/' && L[j + 1] === '/') break
    if (c === '/' && L[j + 1] === '*') { blockComment = true; break }
    if (c === '{') { depth += 1; stack.push(i + 1) }
    if (c === '}') {
      depth -= 1
      stack.pop()
      if (depth < 0) {
        console.log(`深度在 ${i + 1} 行变成 -1（多余的 }）：${L.slice(0, 100)}`)
        process.exit(0)
      }
    }
  }
  if (to > 0 && i + 1 >= from && i + 1 <= to) {
    console.log(`${String(i + 1).padStart(4)} depth=${depth} ${L.slice(0, 88)}`)
  }
}
console.log(`末行 depth（应为 0）= ${depth}`)
if (depth !== 0) console.log('未闭合的 { 起始行（栈顶几个）:', JSON.stringify(stack.slice(-5)))
