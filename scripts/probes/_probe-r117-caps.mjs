// scripts/probes/_probe-r117-caps.mjs — 量：补丁层**完全生效**时，那三项能力报什么？
//
// 这个读数决定"改引用"是不是一个真缺陷修法，还是只是换个说法。
//
//   · 若"补丁层生效 ⇒ tool-permission-enforcement 仍报 false"
//     ⇒ 那是**假阴性**（产品确实有这项能力，被自己的能力表报成没有）
//        ⇒ "改引用同一份判定"是**修 bug**，不是放宽。
//   · 若它其实会跟着变 ⇒ 我上一轮的读法就是错的，得撤。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { runtimeCapabilityEvidence } = await import('../runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs?p=' + Date.now())
const { reconcilePatchLayer } = await import('../runtime/dsh-composition/patch-layer.mjs?p=' + Date.now())
const { startupSelfCheck } = await import('../runtime/dsh-composition/selfcheck.mjs?p=' + Date.now())

// ① 先造一个"补丁层完全生效"的组合。
//    用真 `reconcilePatchLayer` 找一份会让它 effective=true 的组合：
//    直接拿仓里那份真 patch.yml 读出来的行表最省事。
const { readFileSync } = await import('node:fs')
const { parse } = await import('node:path')

// 真组合：用 bootstrap 同款的读法太绕；这里直接给 reconcilePatchLayer
// 喂一组"声明了什么、树里就有什么"的行 —— 这正是"生效"的定义。
const ROW_IDS = ['permission']
const composition = {
  rows: ROW_IDS.map((id) => ({ id, module: '/tmp/x.mjs', runtimeModule: null })),
  patchVersion: 99,
}

const rec = reconcilePatchLayer(composition)
console.log('=== ① 构造的组合上，补丁层生效吗 ===')
console.log('  effective =', rec.effective, ' patchVersion =', rec.patchVersion)
console.log('  findings  =', JSON.stringify(rec.findings?.slice?.(0, 3) ?? rec.findings))
console.log('  reasons   =', JSON.stringify(rec.reasons))

// ② 同一个 ctx 下，能力表报什么
const ctx = {
  get: (n) => (n === 'subagents' ? { list: () => ['p1'], getProvider: () => ({ capabilities: { outputSchema: true } }) } : undefined),
}
const { capabilities, evidence } = runtimeCapabilityEvidence(ctx)
console.log('\n=== ② 能力表（structured-result 已满足的前提下）===')
for (const k of Object.keys(capabilities)) console.log(`  ${k} = ${capabilities[k]}   code=${evidence[k].code ?? '(无)'}`)

console.log('\n=== ③ 判读 ===')
console.log('  补丁层 effective =', rec.effective)
console.log('  tool-permission-enforcement =', capabilities['tool-permission-enforcement'])
if (rec.effective === true && capabilities['tool-permission-enforcement'] === false) {
  console.log('  ⇒ **假阴性**：强制面已被自检判为生效，而能力表仍报"未确认"。')
  console.log('     "改引用同一份判定"是修这个假阴性，不是放宽 fail-closed。')
} else if (rec.effective !== true) {
  console.log('  ⇒ ⚠ 我这个夹具没能造出"生效"的组合，本读数**不足以**判读（要先修夹具）。')
}
