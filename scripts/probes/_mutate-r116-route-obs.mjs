// scripts/probes/_mutate-r116-route-obs.mjs — 破验：这两条修好的判据**仍然咬得住真缺陷**吗
//
// M1: 把 team-hub/routes/models.mjs 的 `throw modelConfigErrorFor(verdict)` 删掉
//     ⇒ model-config 的"路由真的接上了校验"必须红
// M2: 在 api.ts 里加一个**真的不存在**的端点
//     ⇒ model-api ③ 必须红（证明新取法不是"永远返回空集合"）
//
// 每次改完逐字节还原。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const run = (file) => {
  try {
    execFileSync(process.execPath, ['--test', file], { cwd: ROOT, stdio: 'pipe' })
    return { code: 0, out: '' }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() }
  }
}

const cases = [
  {
    name: 'M1 routes/models.mjs 删掉 throw modelConfigErrorFor(verdict)',
    file: 'team-hub/routes/models.mjs',
    test: 'runtime/contracts/model-config.test.mjs',
    from: '          if (verdict.ok !== true) throw modelConfigErrorFor(verdict)',
    to: '          // MUTATED: 校验结论被丢掉（这正是那条断言存在的理由）',
  },
  {
    name: 'M2 api.ts 加一个真的不存在的端点',
    file: 'workbench/src/api.ts',
    test: 'workbench/scripts/model-api.test.mjs',
    from: "function hubGet(path: string): Promise<Response> {",
    to: "export async function __mutantGhost() { return hubGet(`/api/__no_such_endpoint__`) }\n\nfunction hubGet(path: string): Promise<Response> {",
  },
]

let caught = 0
for (const c of cases) {
  const p = `${ROOT}/${c.file}`
  const original = readFileSync(p, 'utf8')
  if (!original.includes(c.from)) {
    console.log(`✖ ${c.name} —— 夹具锚点没找到，这条破验什么都没验到`)
    continue
  }
  const before = run(c.test)
  writeFileSync(p, original.replace(c.from, c.to))
  const after = run(c.test)
  writeFileSync(p, original)
  const restored = readFileSync(p, 'utf8') === original
  const bit = before.code === 0 && after.code !== 0
  if (bit) caught++
  console.log(`${bit ? '✔' : '✖'} ${c.name}`)
  console.log(`    改前 exit=${before.code} → 改后 exit=${after.code}；逐字节还原=${restored}`)
}
console.log(`\n咬住 ${caught}/${cases.length}`)
