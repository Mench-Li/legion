// scripts/ci/dsh-api-surface.test.mjs —— DSH 代际一致性门禁的判据
//
// 这套测试的核心不是"脚本能跑"，而是**它能抓住那次真实故障**：
// 2026-10-20 的"运行期缺方法"（`TypeError: <服务>.start is not a function`），
// 成因是编译期类型（只有 start）与运行期实现（只有 startActivation）不是一代，
// 而 `tsc` 永远看不出来 —— 它信任 `.d.ts`，那份 `.d.ts` 描述的是另一代。
//
// 运行：node --test scripts/ci/dsh-api-surface.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTRACTS, compareSurface, methodPresent, scan, stripComments,
} from './dsh-api-surface.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const CONTRACT = { package: 'dsh-subagent', required: ['list', 'getProvider'], alternatives: [['startActivation', 'start']] }

/** 造一段"某代"的类型/实现正文。 */
const alphaTypes = `
export declare class SubagentRuntime {
  list(): string[];
  getProvider(name: string): unknown;
  start(name: string, request: unknown): Promise<unknown>;
}
`
const rcTypes = `
export declare class SubagentRuntime {
  list(): string[];
  getProvider(name: string): unknown;
  startActivation(spec: unknown): Promise<unknown>;
}
`

test('① 复刻历史故障：compile 只有 start、runtime 只有 startActivation ⇒ 必须判为不一致', () => {
  const result = compareSurface(CONTRACT, alphaTypes, rcTypes)
  assert.equal(result.ok, false, '这正是那次崩掉的组合，必须红')
  const alt = result.findings.find((finding) => finding.id.startsWith('alternatives:'))
  assert.equal(alt.ok, false)
  assert.match(alt.text, /= ∅/, '文案要写出"交集为空"这件事，而不是只说不一致')
  assert.match(alt.text, /start is not a function/, '要指回那次故障，让人知道这条判据为什么存在')
  // required 两侧都在 ⇒ 只有 alternatives 红，错误定位准确
  assert.deepEqual(result.findings.filter((finding) => finding.ok === false).map((finding) => finding.id), ['alternatives:startActivation|start'])
})

test('② 同代（都是新名 / 都是旧名）⇒ 一致', () => {
  assert.equal(compareSurface(CONTRACT, rcTypes, rcTypes).ok, true)
  assert.equal(compareSurface(CONTRACT, alphaTypes, alphaTypes).ok, true)
})

test('③ required 成员缺一侧 ⇒ 不一致（Legion 无条件调用它）', () => {
  const compileMissing = rcTypes.replace('  getProvider(name: string): unknown;\n', '')
  const result = compareSurface(CONTRACT, compileMissing, rcTypes)
  assert.equal(result.ok, false)
  const finding = result.findings.find((entry) => entry.id === 'required:getProvider')
  assert.equal(finding.ok, false)
  assert.match(finding.text, /编译期 无 \/ 运行期 有/)
})

test('④ 注释里提到名字不算实现；`x.start(` 这种属性访问也不算方法声明', () => {
  const onlyComments = `
  // start(name, request) 是旧接口
  /* startActivation(spec) 是新接口 */
  export declare class Empty { list(): void }
  `
  assert.equal(methodPresent(onlyComments, 'start'), false, '注释不是实现')
  assert.equal(methodPresent(onlyComments, 'startActivation'), false, '注释不是实现')
  // 属性访问 `other.start(` 不是"服务自己声明了 start"
  assert.equal(methodPresent('  other.start(1)\n', 'start'), false)
  assert.equal(methodPresent('  start(name: string): Promise<void>;\n', 'start'), true)
  assert.match(stripComments('a /* x() */ b'), /a\s+b/)
})

test('⑤ 本机真实扫描：编译期与已装 DSH 必须是同一代（本次修复的回归防线）', () => {
  const result = scan(CONTRACTS[0])
  if (result.observed === false) {
    // 没装 DSH 的机器上无法比对：显式跳过而不是假装通过。
    assert.match(String(result.reason), /DSH|类型/, '未观察时要给出原因')
    return
  }
  assert.equal(result.ok, true, '本机编译期与运行期分叉了：' + JSON.stringify(result.findings, null, 2))
  const fileEdge = result.compilePath
  const runtimeEdge = result.runtimeFrom
  assert.match(fileEdge, /dsh-subagent/)
  assert.match(runtimeEdge, /app\.asar|node_modules/)
})

test('⑥ 合约表必须与代码一致：表比代码窄，新调用就没人守', () => {
  const clientSource = readFileSync(join(ROOT, 'runtime', 'adapters', 'dsh', 'subagent-client.mjs'), 'utf8')
  // 适配层里 `subagentsOf(ctx).X(` / `.Y(` 形式的成员 = Legion 真的在调的那些
  const used = [...clientSource.matchAll(/subagentsOf\(ctx\)\.(\w+)\(/g)].map((match) => match[1])
  assert.ok(used.length > 0, '适配层至少要有一个读取点，否则这条判据失效')
  const declared = new Set([
    ...(CONTRACTS[0].required ?? []),
    ...(CONTRACTS[0].alternatives ?? []).flat(),
  ])
  for (const name of used) {
    assert.ok(declared.has(name), `subagent-client.mjs 调用了 ${name}()，但合约表里没有它 —— 请补进 CONTRACTS 的 required`)
  }

  // 兼容层里"两代方法名"必须是合约里的那一组（改了一处忘了另一处，等于门禁在守旧名字）
  const adapterSource = readFileSync(join(ROOT, 'runtime', 'adapters', 'dsh', 'subagent-start.mjs'), 'utf8')
  for (const name of (CONTRACTS[0].alternatives ?? []).flat()) {
    assert.ok(adapterSource.includes(`'${name}'`), `适配层里应出现 '${name}'（两代差异只在这一处吸收）`)
  }
})
