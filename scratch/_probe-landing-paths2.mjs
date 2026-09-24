// scratch/_probe-landing-paths2.mjs —— 「代码落点」列的路径按**该格自身的写法惯例**解析（**不提交**）
//
// 惯例（从真表格读出来的）：一格里的**第一个带目录的路径**确立目录，
// 其后**裸文件名**继承那个目录。所以判"解得开"必须按顺序扫，不能每个名字独立拼。
//
// 分三类报：
//   (a) 原样解得开
//   (b) 沿本格**继承目录**解得开        —— 合法简写
//   (c) 两种都解不开                    —— 真缺陷
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = 'D:/project/DSH/legion'
const t = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8').split(/\r?\n/)
const LOOKS_LIKE_PATH = /^[\w./-]+\.(mjs|ts|js|json|yml|yaml|md|sql)$/
const hasGlob = (s) => /[*?]/.test(s)

/** `orchestrator/worker/{executor,main}.mjs` → ['orchestrator/worker/executor.mjs', '.../main.mjs'] */
function expandBraces(p) {
  const m = /\{([^}]+)\}/.exec(p)
  if (m === null) return [p]
  const out = []
  for (const alt of m[1].split(',')) {
    out.push(...expandBraces(p.slice(0, m.index) + alt.trim() + p.slice(m.index + m[0].length)))
  }
  return out
}

const uniq = (a) => [...new Set(a)]
let asIs = 0
const inherited = []
const broken = []

for (let i = 0; i < t.length; i++) {
  const l = t[i]
  if (!/^\|\s*F-\d+/.test(l)) continue
  const cells = l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
  if (cells.length !== 5 && cells.length !== 6) continue

  let dir = null // 本格已确立的目录
  for (const m of cells[3].matchAll(/`([^`]+)`/g)) {
    for (const raw0 of expandBraces(m[1].trim())) {
      const raw = raw0.trim()
      if (!LOOKS_LIKE_PATH.test(raw) || hasGlob(raw)) continue
      const ex = (p) => existsSync(join(ROOT, p))

      if (ex(raw)) {
        asIs += 1
        if (raw.includes('/')) dir = dirname(raw)
        continue
      }
      // 原样解不开 ⇒ 试继承
      if (dir !== null && !raw.includes('/') && ex(`${dir}/${raw}`)) {
        inherited.push({ line: i + 1, id: cells[0], raw, via: dir })
        continue
      }
      if (dir !== null && ex(`${dir}/${raw}`)) {
        inherited.push({ line: i + 1, id: cells[0], raw, via: dir })
        continue
      }
      broken.push({ line: i + 1, id: cells[0], raw, dir })
    }
  }
}

console.log(`原样解得开：${asIs}`)
console.log(`沿本格继承目录解得开（合法简写）：${inherited.length}`)
for (const x of uniq(inherited.map((x) => `${x.id}|${x.raw}|${x.via}`)).map((s) => {
  const [id, raw, via] = s.split('|'); return { id, raw, via }
})) console.log(`   · ${x.id.padEnd(20)} \`${x.raw}\`  ← ${x.via}/`)
console.log(`\n★ 两种都解不开（真缺陷）：${broken.length}`)
for (const b of broken) console.log(`   L${b.line}  ${b.id.padEnd(20)} \`${b.raw}\`（本格目录=${b.dir ?? '未确立'}）`)
