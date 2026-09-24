// scripts/probes/_probe-t2-top-level.mjs
// T2 变异验证：`probe-slice-verbatim.mjs` 新增的 **⑤ 顶层性** 那一条，
// 在"把闭包登记成一片"时必须红，且必须**报 ⑤**（不是含糊的 ①/②/③）。
//
// ★ 全部在内存里造 fixture，不写磁盘。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkSlices, symbolTopLevel, SLICES } from './probe-slice-verbatim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

let failures = 0
const has5 = (r) => r.slices[0].problems.some((p) => p.startsWith('⑤'))

// ⓪ 工具自己：`recallCorpus`（spaceWorker 里的闭包）不是顶层；`hashStr` 是。
{
  const text = (await import('node:fs')).readFileSync(resolve(REPO, 'plugins/src/index.ts'), 'utf8')
  const a = symbolTopLevel(text, 'recallCorpus')
  const b = symbolTopLevel(text, 'hashStr')
  const ok = a !== null && a.top === false && a.indent > 0 && b !== null && b.top === true
  console.log(`  ${ok ? '✔' : '✖'} ⓪ 工具本身的读数：recallCorpus top=${a?.top} indent=${a?.indent}；hashStr top=${b?.top}`)
  if (!ok) failures += 1
}

// ① 把闭包登记成一片 ⇒ 必须报 ⑤
{
  const r = checkSlices({
    slices: [{
      id: 'fixture/nested-closure', title: '把 spaceWorker 里的闭包当片搬',
      from: 'HEAD', fromFile: 'plugins/src/index.ts',
      toFile: 'plugins/src/spacePaths.ts', names: ['recallCorpus'],
    }],
  })
  const p = r.slices[0].problems
  const ok = r.ok === false && has5(r) && p.some((x) => x.includes('闭包')) && p.some((x) => x.includes('立缝'))
  console.log(`  ${ok ? '✔' : '✖'} ① 闭包当片 ⇒ 报 ⑤ 且说明"闭包/立缝"（实为：${p.map((x) => x.slice(0, 18)).join(' | ') || '绿'}）`)
  if (!ok) failures += 1
}

// ② 对称控制：顶层符号**不许**被 ⑤ 误报（别的规则可以报，⑤ 不许）
{
  const r = checkSlices({
    slices: [{
      id: 'fixture/top-level-control', title: '顶层符号：⑤ 不许误报',
      from: 'HEAD', fromFile: 'plugins/src/index.ts',
      toFile: 'plugins/src/index.ts', names: ['hashStr'],
    }],
  })
  const ok = has5(r) === false
  console.log(`  ${ok ? '✔' : '✖'} ② 顶层符号不被 ⑤ 误报（其余问题：${r.slices[0].problems.map((x) => x.slice(0, 12)).join(' | ') || '无'}）`)
  if (!ok) failures += 1
}

// ③ 真登记表：两片都不许出现 ⑤
{
  const r = checkSlices()
  const ok = r.ok && r.slices.every((s) => !s.problems.some((p) => p.startsWith('⑤')))
  console.log(`  ${ok ? '✔' : '✖'} ③ 真登记表 ${SLICES.length} 片全绿且无 ⑤`)
  if (!ok) failures += 1
}

console.log(failures === 0 ? '\n  ⇒ T2 的 ⑤ 判据变异验证全过（1 反向 + 1 对称 + 工具自身 + 真表）' : `\n  ⇒ 有 ${failures} 处不达预期`)
process.exit(failures === 0 ? 0 : 1)
