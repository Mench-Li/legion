// runtime/dsh-composition/composition.test.mjs
// ============================================================================
// PRT-213 / PRT-214 / PRT-215 的测试：补丁层声明与对账、沙箱实际管制探测、启动自检。
//
// 重点覆盖「看起来没问题但其实没生效」的那一类失效：
//   · 行挂上了但**没激活**（等待依赖服务）
//   · preset 行存在但表**没被覆盖**（还在用 DSH 默认表）
//   · 沙箱返回 `partial`（存在未被管制的路径）
//   · 沙箱**原样返回**输入 argv（没做任何包装）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DSH_COMPOSITION_PATCH_VERSION,
  DSH_DEFAULT_PRESETS,
  EMPLOYEE_PRESET_CONTRACT,
  LEGION_PERMISSION_PRESETS,
  LEGION_ROW_PREFIX,
  PATCH_LAYER_ROWS,
  reconcilePatchLayer,
} from './patch-layer.mjs'
import { PATCH_YAML_PATH, renderPatchYaml } from './render.mjs'
import { PROBE_ARGV, SELFCHECK_STATES, probeSandbox, startupSelfCheck } from './selfcheck.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 一份「一切正常」的组合树观察。 */
const GOOD_COMPOSITION = Object.freeze({
  rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true })),
  permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
})

/** 一个「完全生效」的沙箱端口。 */
function goodSandbox() {
  return {
    confine: (argv) => ({
      argv: ['sandbox-exec', '--profile', 'p', ...argv],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [],
    }),
  }
}

const GOOD_RUNTIME = Object.freeze({ ok: true, version: '0.1.5-rc.2', reason: '版本在支持窗口内' })

// ----------------------------------------------------------------- PRT-214 声明

test('补丁层：每行都是 Legion 注入的 host 平面行', () => {
  assert.ok(PATCH_LAYER_ROWS.length >= 4, 'hard floor / pre-execute / answerer / preset 表 四行缺一不可')
  for (const row of PATCH_LAYER_ROWS) {
    assert.ok(row.id.startsWith(LEGION_ROW_PREFIX), `${row.id} 必须带 Legion 前缀，否则无法在组合树里认出是产品注入的`)
    assert.equal(row.plane, 'host', `${row.id} 必须在 host 平面；放进 agent preset 会让安全下限取决于当前 session 挂了哪个 preset`)
    assert.ok(Array.isArray(row.registrations) && row.registrations.length > 0)
  }
})

test('补丁层：四类强制点各有归属，且注册点与 §6.8 映射一致', () => {
  const kinds = Object.fromEntries(PATCH_LAYER_ROWS.map((r) => [r.kind, r]))
  assert.ok(kinds.guard.registrations.includes('ctx.tools.guard'))
  assert.ok(kinds.listener.registrations.some((s) => s.includes('tools/pre-execute')))
  assert.ok(kinds.answerer.registrations.some((s) => s.includes('approval/request')))
  assert.deepEqual(kinds['config-override'].mount, { anchor: 'patch-over', target: 'permission' })
})

test('补丁层：员工 preset 不提供任何服务、不承载强制面', () => {
  assert.equal(EMPLOYEE_PRESET_CONTRACT.plane, 'agent')
  assert.equal(EMPLOYEE_PRESET_CONTRACT.mayProvideServices, false)
  assert.equal(EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement, false)
})

test('补丁层：无人值守 preset 保持 workspace-write，**不得**降级为 danger-full-access', () => {
  const unattended = LEGION_PERMISSION_PRESETS['legion-unattended']
  assert.equal(unattended.approval, 'never')
  assert.equal(
    unattended.sandbox,
    'workspace-write',
    '这正是不能复用 DSH 默认表的理由：默认表里 never 与 danger-full-access 绑定，'
    + '按默认表实现「无人值守」会顺手把沙箱也放开。',
  )
})

test('补丁层：确实与 DSH 默认表不同（否则这层没有存在意义）', () => {
  assert.notDeepEqual(
    { sandbox: LEGION_PERMISSION_PRESETS['legion-unattended'].sandbox, approval: LEGION_PERMISSION_PRESETS['legion-unattended'].approval },
    { sandbox: DSH_DEFAULT_PRESETS['danger-full-access'].sandbox, approval: DSH_DEFAULT_PRESETS['danger-full-access'].approval },
  )
})

test('patchVersion 是正整数（0 或缺失会让「成对验证」失去比较基准）', () => {
  assert.ok(Number.isInteger(DSH_COMPOSITION_PATCH_VERSION) && DSH_COMPOSITION_PATCH_VERSION > 0)
})

// ----------------------------------------------------------------- PRT-214 对账

test('对账：全部行存在且激活、preset 表已覆盖 → 生效', () => {
  const r = reconcilePatchLayer(GOOD_COMPOSITION)
  assert.equal(r.effective, true)
  assert.deepEqual(r.reasons, [])
  assert.equal(r.patchVersion, DSH_COMPOSITION_PATCH_VERSION)
})

test('对账：行缺失 → 不生效并点名是哪一行', () => {
  const r = reconcilePatchLayer({ ...GOOD_COMPOSITION, rows: GOOD_COMPOSITION.rows.slice(1) })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), new RegExp(PATCH_LAYER_ROWS[0].id))
  assert.equal(r.findings.find((f) => f.row === PATCH_LAYER_ROWS[0].id).code, 'ROW_MISSING')
})

test('对账：行**挂上了但未激活** → 不生效（这一类在组合树里看起来和成功一样）', () => {
  const rows = GOOD_COMPOSITION.rows.map((r, i) => (i === 0 ? { ...r, activated: false } : r))
  const r = reconcilePatchLayer({ ...GOOD_COMPOSITION, rows })
  assert.equal(r.effective, false)
  assert.equal(r.findings.find((f) => f.row === PATCH_LAYER_ROWS[0].id).code, 'ROW_NOT_ACTIVATED')
})

test('对账：读不到 preset 表 → 不生效（「没观察到」不等于「已替换」）', () => {
  const r = reconcilePatchLayer({ rows: GOOD_COMPOSITION.rows })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /PRESETS_UNOBSERVED|没观察到/)
})

test('对账：preset 行在、但生效表里**没有** Legion 项 → 不生效（patch-over 未生效）', () => {
  // 这是最隐蔽的一种：行存在、激活，看起来一切正常，但实际还在用 DSH 默认表。
  const r = reconcilePatchLayer({ rows: GOOD_COMPOSITION.rows, permissionPresets: Object.keys(DSH_DEFAULT_PRESETS) })
  assert.equal(r.effective, false)
  const f = r.findings.find((x) => x.code === 'PRESETS_NOT_OVERRIDDEN')
  assert.ok(f, '必须报 PRESETS_NOT_OVERRIDDEN')
  assert.match(f.detail, /legion-unattended/)
})

test('对账：空观察不抛错，逐项报未生效', () => {
  const r = reconcilePatchLayer()
  assert.equal(r.effective, false)
  assert.equal(r.findings.length, PATCH_LAYER_ROWS.length + 1)
})

// ----------------------------------------------------------------- 渲染新鲜度

test('渲染：YAML 与声明一致（声明改了而 YAML 未重新生成 → 变红）', () => {
  const target = join(HERE, 'legion-host.patch.yml')
  assert.ok(existsSync(target), `${PATCH_YAML_PATH} 不存在`)
  const onDisk = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(onDisk, renderPatchYaml(), 'YAML 是生成物；手工编辑或忘记重新生成都会在这里被抓住')
})

test('渲染：YAML 含 Legion 两个 preset，且**没有任何** sandbox 取值是 danger-full-access', () => {
  const text = renderPatchYaml()
  for (const name of Object.keys(LEGION_PERMISSION_PRESETS)) assert.match(text, new RegExp(name))
  for (const row of PATCH_LAYER_ROWS) assert.match(text, new RegExp(row.id))

  // 只检查**生效的配置值**，不检查散文。
  // 注释里出现 `danger-full-access` 是刻意的（说明为什么不用 DSH 默认表）；
  // 整段正则匹配会把这条解释判成违规，于是要么删掉解释、要么放松断言 —— 两者都是倒退。
  const sandboxValues = [...text.matchAll(/^\s*sandbox:\s*(\S+)\s*$/gm)].map((m) => m[1])
  assert.ok(sandboxValues.length > 0, '至少要有一个 sandbox 取值，否则这个断言什么都没检查')
  assert.ok(
    sandboxValues.every((v) => v !== 'danger-full-access'),
    `补丁层不得引入全盘访问档位，实际取值：${sandboxValues.join(', ')}`,
  )
})

test('渲染：YAML 的注释提到 danger-full-access 是为了解释**为什么不采用它**', () => {
  // 这条用例锁住上一条的边界：注释必须保留这段解释。
  // 否则下一个人会把「提到危险档位」的注释删掉来让正则变绿 —— 而那正好删掉了理由。
  const text = renderPatchYaml()
  assert.match(text, /#.*danger-full-access/, '注释里应保留「默认表把 never 与 danger-full-access 绑定」这条理由')
})

// ----------------------------------------------------------------- PRT-213 沙箱

test('沙箱探测：未挂载 confine → 不生效（仅有配置名不算生效）', async () => {
  for (const port of [undefined, null, {}, { confine: 'not-a-function' }]) {
    const r = await probeSandbox(port)
    assert.equal(r.effective, false)
    assert.equal(r.enforcement, null)
  }
})

test('沙箱探测：confine 拒绝（fail closed）→ 不生效，但理由说明是合规拒绝', async () => {
  const r = await probeSandbox({ confine: () => { throw new Error('后端不支持该 argv') } })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /fail closed/)
})

test('沙箱探测：`partial` 级管制 → **不生效**（存在未被管制的路径）', async () => {
  const r = await probeSandbox({
    confine: (argv) => ({ argv: ['wrap', ...argv], enforcement: 'partial', denialSignatures: ['denied'], runnerFailureRules: [] }),
  })
  assert.equal(r.effective, false)
  assert.equal(r.enforcement, 'partial')
  assert.match(r.reasons.join('\n'), /partial/)
})

test('沙箱探测：**原样返回**输入 argv → 不生效（没做任何包装）', async () => {
  const r = await probeSandbox({
    confine: (argv) => ({ argv: [...argv], enforcement: 'full', denialSignatures: ['denied'], runnerFailureRules: [] }),
  })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /原样返回/)
})

test('沙箱探测：未报告 enforcement → 不生效', async () => {
  const r = await probeSandbox({ confine: (argv) => ({ argv: ['wrap', ...argv], denialSignatures: ['d'], runnerFailureRules: [] }) })
  assert.equal(r.effective, false)
  assert.match(r.reasons.join('\n'), /未报告 enforcement/)
})

test('沙箱探测：denialSignatures 为空 → 不生效（沙箱拒绝会退化成普通失败）', async () => {
  for (const sigs of [undefined, null, []]) {
    const r = await probeSandbox({ confine: (argv) => ({ argv: ['wrap', ...argv], enforcement: 'full', denialSignatures: sigs, runnerFailureRules: [] }) })
    assert.equal(r.effective, false)
    assert.match(r.reasons.join('\n'), /denialSignatures/)
  }
})

test('沙箱探测：full + 真包装 + 非空拒绝签名 → 生效，并回报后端与探针 argv', async () => {
  const r = await probeSandbox(goodSandbox())
  assert.equal(r.effective, true)
  assert.equal(r.enforcement, 'full')
  assert.deepEqual(r.probeArgv, [...PROBE_ARGV])
  assert.deepEqual(r.reasons, [])
})

test('沙箱探测：探针 argv 跨平台存在（避免把「平台没有该命令」误判成「沙箱不生效」）', () => {
  assert.equal(PROBE_ARGV[0], 'node')
  assert.ok(PROBE_ARGV.length >= 2)
})

// ----------------------------------------------------------------- PRT-215 自检

test('自检：三项全过 → enforcement-effective，且不禁用自动执行', async () => {
  const r = await startupSelfCheck({ composition: GOOD_COMPOSITION, sandbox: goodSandbox(), runtime: GOOD_RUNTIME })
  assert.equal(r.state, SELFCHECK_STATES.effective)
  assert.equal(r.autoExecutionForbidden, false)
  assert.deepEqual(r.reasons, [])
  assert.deepEqual(r.checks.map((c) => c.name), ['composition-patch-layer', 'runtime-probe', 'sandbox-enforcement'])
})

test('自检：任一不过 → incompatible 且**禁止自动执行**', async () => {
  const r = await startupSelfCheck({
    composition: GOOD_COMPOSITION,
    sandbox: { confine: () => ({ argv: ['w'], enforcement: 'partial', denialSignatures: ['d'], runnerFailureRules: [] }) },
    runtime: GOOD_RUNTIME,
  })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  assert.equal(r.autoExecutionForbidden, true)
})

test('自检：**未探测**运行时 → 不通过（「没探测」不等于「没问题」）', async () => {
  const r = await startupSelfCheck({ composition: GOOD_COMPOSITION, sandbox: goodSandbox() })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  assert.match(r.reasons.join('\n'), /未提供运行时探测结果/)
})

test('自检：理由逐项可归因（修版本 / 修补丁层 / 修沙箱是三个不同的动作）', async () => {
  const r = await startupSelfCheck({
    composition: { rows: [], permissionPresets: [] },
    sandbox: {},
    runtime: { ok: false, reason: '主版本不符' },
  })
  assert.equal(r.state, SELFCHECK_STATES.incompatible)
  // 每条理由都带检查项名前缀
  for (const reason of r.reasons) assert.match(reason, /^(composition-patch-layer|runtime-probe|sandbox-enforcement): /)
  assert.match(r.reasons.join('\n'), /主版本不符/)
  assert.equal(r.checks.length, 3)
})

test('自检：回报补丁层版本与沙箱结论（便于与 dshVersion 成对记录）', async () => {
  const r = await startupSelfCheck({ composition: GOOD_COMPOSITION, sandbox: goodSandbox(), runtime: GOOD_RUNTIME })
  assert.equal(r.patchVersion, DSH_COMPOSITION_PATCH_VERSION)
  assert.equal(r.sandbox.enforcement, 'full')
})
