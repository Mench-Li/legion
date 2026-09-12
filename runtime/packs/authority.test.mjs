// runtime/packs/authority.test.mjs
// ============================================================================
// PRT-1005 的判据：能力包**不能携带密钥、不能扩大权限、不能绕过 DSH 强制面**。
//
// spec §6.13 line 570：
//   「能力包不得携带密钥，不得绕过 ToolGuard、权限预设和审批，
//     也不得把 Git 文件变成运行状态事实源。」
// spec 阶段 10 完成标准 line 1006：
//   「不兼容、缺依赖、哈希错误或**越权**包在**创建目标前**失败。」
//
// 这个文件里每一组的核心都不是"某条检查返回了 false"，而是：
// **它拦住的是什么，以及一个"看起来实现了"的写法会怎样让它失效。**
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LEGION_PERMISSION_PRESETS } from '../dsh-composition/patch-layer.mjs'
import { AUTHORITY_BEARING_KEYS } from '../contracts/context.mjs'
import {
  AUTHORITY_RULE_PROBES,
  HOST_SURFACE_ORIGIN,
  PACK_AUTHORITY_CHECKED,
  PACK_AUTHORITY_CODES,
  PACK_FORBIDDEN_CONTENT_KEYS,
  PACK_FORBIDDEN_CONTENT_TOKENS,
  SECRET_DEPENDENCY_KINDS,
  SECRET_PLACEHOLDER_VALUES,
  SECRET_REFERENCE_PREFIXES,
  assertHostSurfaceUsable,
  assertPackAuthority,
  compareBaselines,
  hostEnforcementSurface,
  looksLikeSecretReference,
  preflightPack,
  proveEveryAuthorityRuleFires,
  provePreflightOrdering,
  runPreflightThenCreateTarget,
  sampleHostSurface,
  scanForEnforcementBypass,
  scanForSecrets,
} from './authority.mjs'
import {
  PACK_PROTOCOL_VERSION,
  normalizePackManifest,
  readPackTeam,
} from './manifest.mjs'
import { SAMPLE_TEAM, sampleTeamPack, sampleTeamPackWith } from './compiled-plan.mjs'

const HOST = Object.freeze({
  productVersion: '1.0.0',
  packProtocolVersion: PACK_PROTOCOL_VERSION,
  dshCompositionPatchVersion: 1,
})

const codeOf = (fn) => {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

const employeesOf = (pack) => readPackTeam({ manifest: normalizePackManifest(pack.manifest), files: pack.files }).employees

/** 一份"本来会通过"的包 + 宿主基线 + 员工清单。 */
function good() {
  const pack = sampleTeamPack()
  return { manifest: pack.manifest, files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack) }
}

/** 只改一处：在包里多塞一个文件（内容表与哈希跟着重算，所以被拒的原因只可能是那一处）。 */
function withExtraFile(path, text) {
  const pack = sampleTeamPack()
  const files = [...pack.files, { path, text }]
  const src = sampleTeamPackWith({ pipeline: SAMPLE_TEAM.pipeline })
  const rebuilt = { ...src, files }
  return { ...rebuilt, manifest: { ...rebuilt.manifest, contents: undefined } }
}

// --------------------------------------------------------------- 装载自检

test('⑩ ★ 装载自检没有未解决的问题；每条判据都有一个**能触发它**的输入', () => {
  assert.deepEqual(PACK_AUTHORITY_CHECKED.problems, [])
  const s = PACK_AUTHORITY_CHECKED.samples
  assert.deepEqual(s.uncoveredCodes, [], `有判据没有任何输入能触发：${JSON.stringify(s.uncoveredCodes)}`)
  assert.deepEqual(s.rulesNotFired, [])
  assert.ok(s.rulesFired >= 25, `判据探针只有 ${s.rulesFired} 条`)
  assert.equal(HOST_SURFACE_ORIGIN, PACK_AUTHORITY_CHECKED.hostSurfaceOrigin)
})

test('⑩ ★ 每一条判据的探针都打中了它要证明的那**一条**', () => {
  //   > 一条被别的原因顺带拦下的检查，与一条不存在的检查，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  //
  // 所以探针不止要求"它被拒了"，还要求命中的码是**它自己那一个**。
  const fired = proveEveryAuthorityRuleFires()
  const wrong = fired.results.filter((r) => !r.fired)
  assert.deepEqual(wrong.map((r) => `${r.id}:${r.codes.join('+')}`), [])
  // 探针 id 与期望码是**一对**，不能两条探针共用一个码
  const expects = AUTHORITY_RULE_PROBES.map((p) => p.expect)
  assert.equal(new Set(expects).size, expects.length, '有两条探针在证明同一个码')
})

// --------------------------------------------------------------- ① 方向

test('① ★★ 越权判定必须对着**宿主强制面**，不能对着包自己的声明', () => {
  //   > 一个「拿包声明的权限去和包声明的另一部分比」的越权检查，
  //   > 与一个「让包自己说'我没有越权'」的越权检查，是同一个东西——
  //   > 只不过前者有一个看起来像校验的循环。
  const b = compareBaselines()
  assert.equal(b.againstPackSelf, null, `以包自己的声明为基线时竟然拦下了越权：${b.againstPackSelf}`)
  assert.equal(b.againstHost, PACK_AUTHORITY_CODES.CAPABILITY_WIDENS_HOST)
  // 并排留证：两份基线的能力表**确实不同**，否则这个对比什么也证明不了
  assert.deepEqual(b.naiveSurfaceCapabilities, [...b.hostSurfaceCapabilities, 'network:write'])
  assert.equal(b.hostSurfaceOrigin, HOST_SURFACE_ORIGIN)
})

test('① 基线来自 host 组合里**真正生效**的那张 preset 表', () => {
  const surface = sampleHostSurface()
  const preset = LEGION_PERMISSION_PRESETS[surface.preset]
  assert.equal(surface.sandbox, preset.sandbox, '基线声称的沙箱档与 host 组合里的 preset 不一致')
  assert.equal(surface.approval, preset.approval, '基线声称的审批档与 host 组合里的 preset 不一致')
  assert.equal(surface.sandbox, 'workspace-write')
  assert.equal(surface.approval, 'ask')
})

test('① ★ 基线自己不成形状时，报的是"基线不可用"而不是"包越权"', () => {
  // 越权判定的方向是"包 ⊆ 宿主"，所以基线的任何缺陷都会**直接变成放过**。
  // 这一层不成立时下面每一条判据都会各自给出一个"看起来像结论"的东西——
  // 所以它必须**短路**，并且码要说清问题出在宿主那一侧。
  for (const [name, surface] of [
    ['没有基线', null],
    ['没有来源标记', Object.freeze({ ...sampleHostSurface(), origin: '' })],
    ['能力名认不出', Object.freeze({ ...sampleHostSurface(), allowedCapabilities: Object.freeze(['file:reed']) })],
    ['沙箱档与 preset 不符', Object.freeze({ ...sampleHostSurface(), sandbox: 'read-only' })],
    ['风险上限认不出', Object.freeze({ ...sampleHostSurface(), riskCeiling: 'extreme' })],
  ]) {
    const r = assertHostSurfaceUsable(surface)
    assert.equal(r.ok, false, `${name} 的基线被认为可用`)
    assert.ok(r.problems.length > 0)
    const verdict = assertPackAuthority({ ...good(), hostSurface: surface })
    assert.equal(verdict.ok, false)
    assert.ok(
      [PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED, PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE].includes(verdict.code),
      `${name} 给出的是 ${verdict.code}`,
    )
    // 关键：不能顺带报一堆"包越权"——那些结论在基线不可用时没有意义
    assert.equal(
      verdict.problems.some((p) => p.code === PACK_AUTHORITY_CODES.CAPABILITY_WIDENS_HOST), false,
      `${name} 顺带给出了越权结论`,
    )
  }
})

test('① ★ 基线落到 DSH 默认表的 `danger-full-access` → 拒绝', () => {
  // `patch-layer.mjs` 的注释写明了 Legion 为什么必须替换它：
  // 按默认表实现"无人值守 = never"会**同时**把沙箱降级。
  const bad = Object.freeze({ ...sampleHostSurface(), sandbox: 'danger-full-access', approval: 'never' })
  const r = assertHostSurfaceUsable(bad)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.code === PACK_AUTHORITY_CODES.HOST_SURFACE_DANGER))
  // `danger-full-access` 也必须出现在"包内容里不许出现"的记号表里
  assert.ok(PACK_FORBIDDEN_CONTENT_TOKENS.includes('danger-full-access'))
})

test('① 宿主没给授予时不能"就当没有限制"', () => {
  assert.equal(
    codeOf(() => hostEnforcementSurface({ preset: 'legion-attended', grant: null })),
    PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED,
  )
  assert.equal(
    codeOf(() => hostEnforcementSurface({ preset: 'legion.nope', grant: {} })),
    PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED,
  )
})

// --------------------------------------------------------------- ② 权限

test('② ★ 缺 `requestedPermissions` 是**拒绝**，不是"不申请权限"', () => {
  //   > 一个「没声明权限就当成没申请权限」的预检，
  //   > 与一个「没声明权限就当成没有限制」的预检，是同一个东西——
  //   > 只不过前者在预检这一层通过、后者在派活那一层生效。
  const pack = sampleTeamPack()
  const { requestedPermissions, ...without } = pack.manifest
  const verdict = assertPackAuthority({
    manifest: without, files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.PERMISSION_UNDECLARED)
})

test('② 权限声明缺 maxRisk 也拒绝（"没有上限"与"上限写错就用最宽松的"是同一个东西）', () => {
  const pack = sampleTeamPack()
  const verdict = assertPackAuthority({
    manifest: { ...pack.manifest, requestedPermissions: { capabilities: ['file:read'], tools: ['read-file'], workspaceRoot: null } },
    files: pack.files,
    hostSurface: sampleHostSurface(),
    employees: employeesOf(pack),
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.PERMISSION_MALFORMED)
})

test('② 权限声明里出现强制面字段 / 不认识的字段，各自有自己的码', () => {
  const pack = sampleTeamPack()
  const base = pack.manifest.requestedPermissions
  const enforcement = assertPackAuthority({
    manifest: { ...pack.manifest, requestedPermissions: { ...base, approvalPolicy: 'never' } },
    files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(enforcement.code, PACK_AUTHORITY_CODES.ENFORCEMENT_FIELD)

  const unknown = assertPackAuthority({
    manifest: { ...pack.manifest, requestedPermissions: { ...base, allowTools: [] } },
    files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(unknown.code, PACK_AUTHORITY_CODES.PERMISSION_MALFORMED)
})

test('② ★ 能力 / 工具 / 风险 / 工作目录，四个方向都只能**收窄**', () => {
  const pack = sampleTeamPack()
  const base = pack.manifest.requestedPermissions
  const cases = [
    ['能力超出宿主', { capabilities: [...base.capabilities, 'network:write'] }, PACK_AUTHORITY_CODES.CAPABILITY_WIDENS_HOST],
    ['能力名拼错', { capabilities: ['file:reed'] }, PACK_AUTHORITY_CODES.CAPABILITY_UNKNOWN],
    ['工具超出宿主', { tools: [...base.tools, 'delete-file'] }, PACK_AUTHORITY_CODES.TOOL_WIDENS_HOST],
    ['工具不在登记表', { tools: [...base.tools, 'delete-everything'] }, PACK_AUTHORITY_CODES.TOOL_UNKNOWN],
    ['工具带通配符', { tools: ['*'] }, PACK_AUTHORITY_CODES.TOOL_WILDCARD],
    ['风险上限更高', { maxRisk: 'critical' }, PACK_AUTHORITY_CODES.RISK_ABOVE_HOST_CEILING],
    ['工作目录越界', { workspaceRoot: 'C:/elsewhere' }, PACK_AUTHORITY_CODES.OUT_OF_WORKSPACE],
  ]
  for (const [name, patch, code] of cases) {
    const verdict = assertPackAuthority({
      manifest: { ...pack.manifest, requestedPermissions: { ...base, ...patch } },
      files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
    })
    assert.equal(verdict.ok, false, `${name} 通过了越权检查`)
    assert.ok(verdict.problems.some((p) => p.code === code), `${name} 给出 ${JSON.stringify(verdict.problems.map((p) => p.code))}，期望含 ${code}`)
  }
})

test('② 收窄是允许的：包申请得比宿主少必须通过', () => {
  // 收窄必须**同时**收窄员工清单——包声明写窄了而员工还写着宽的那一份，
  // 正是 `EMPLOYEE_WIDENS_PACK` 那条检查要拦的东西。
  const narrowed = { capabilities: ['file:read'], tools: ['read-file'], maxRisk: 'low', workspaceRoot: 'C:/work/sample/sub' }
  const pack = sampleTeamPackWith({
    employees: [
      { ...SAMPLE_TEAM.employees[0], allowedTools: ['read-file'], allowedCapabilities: ['file:read'], maxRisk: 'low' },
      { ...SAMPLE_TEAM.employees[1], allowedTools: ['read-file'], allowedCapabilities: ['file:read'], maxRisk: 'low' },
    ],
  })
  const verdict = assertPackAuthority({
    manifest: { ...pack.manifest, requestedPermissions: narrowed },
    files: pack.files,
    hostSurface: sampleHostSurface(),
    employees: employeesOf(pack),
  })
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems.map((p) => `${p.code}@${p.field}`)))
  assert.deepEqual(verdict.computed.permits.map((p) => p.allowedCapabilities), [['file:read'], ['file:read']])
})

test('② 同一个岗位重复申请不算错，但**大小写**不同的能力名不算同一个', () => {
  const pack = sampleTeamPack()
  const base = pack.manifest.requestedPermissions
  const verdict = assertPackAuthority({
    manifest: { ...pack.manifest, requestedPermissions: { ...base, capabilities: ['File:Read'] } },
    files: pack.files, hostSurface: sampleHostSurface(), employees: null,
  })
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.CAPABILITY_UNKNOWN)
})

// --------------------------------------------------------------- ③ 员工清单

test('③ ★ 只查 manifest 里那份权限声明是不够的：包内容里的员工也在申请权限', () => {
  //   > 一个「只检查包清单里那份权限声明」的预检，
  //   > 与一个「包里某个员工申请得比包声明得多、而没人发现」的预检，是同一个东西。
  const pack = sampleTeamPackWith({
    employees: [
      { ...SAMPLE_TEAM.employees[0], allowedCapabilities: [...SAMPLE_TEAM.employees[0].allowedCapabilities, 'file:delete'] },
      SAMPLE_TEAM.employees[1],
    ],
  })
  // 宿主**更宽**（含 file:delete），所以越权点只可能是"员工 > 包声明"
  const hostSurface = hostEnforcementSurface({
    preset: 'legion-attended',
    patchVersion: 1,
    grant: {
      allowedCapabilities: [...pack.manifest.requestedPermissions.capabilities, 'file:delete'],
      allowedTools: pack.manifest.requestedPermissions.tools,
      maxRisk: pack.manifest.requestedPermissions.maxRisk,
      workspaceRoot: pack.manifest.requestedPermissions.workspaceRoot,
    },
  })
  const verdict = assertPackAuthority({
    manifest: pack.manifest, files: pack.files, hostSurface, employees: employeesOf(pack),
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.EMPLOYEE_WIDENS_PACK)
})

test('③ 员工超出**宿主授予**与超出**包声明**是两个码（该去改哪一边不一样）', () => {
  const pack = sampleTeamPackWith({
    employees: [
      { ...SAMPLE_TEAM.employees[0], allowedCapabilities: [...SAMPLE_TEAM.employees[0].allowedCapabilities, 'credential:read'] },
      SAMPLE_TEAM.employees[1],
    ],
  })
  const verdict = assertPackAuthority({
    manifest: pack.manifest, files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.EMPLOYEE_WIDENS_HOST)
})

test('③ 团队包拿不到员工清单时**不能当成"没有员工"**', () => {
  const pack = sampleTeamPack()
  const verdict = assertPackAuthority({
    manifest: pack.manifest, files: pack.files, hostSurface: sampleHostSurface(), employees: null,
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.EMPLOYEES_UNDECLARED)
})

test('③ 员工清单本身不合法 → EMPLOYEE_MALFORMED（不是"越权"）', () => {
  const pack = sampleTeamPack()
  const verdict = assertPackAuthority({
    manifest: pack.manifest,
    files: pack.files,
    hostSurface: sampleHostSurface(),
    employees: [{ ...SAMPLE_TEAM.employees[0], maxRisk: 'catastrophic' }, SAMPLE_TEAM.employees[1]],
  })
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.EMPLOYEE_MALFORMED)
})

test('③ 通过的员工拿到的是**按岗位收窄后**的有效许可，逐条可查', () => {
  const g = good()
  const verdict = assertPackAuthority(g)
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems.map((p) => p.code)))
  assert.deepEqual(verdict.computed.permits.map((p) => p.employeeId), ['sample-planner', 'sample-verifier'])
  const planner = verdict.computed.permits.find((p) => p.role === 'planner')
  const verifier = verdict.computed.permits.find((p) => p.role === 'verifier')
  assert.deepEqual(planner.allowedCapabilities, ['file:read', 'repo:read'])
  assert.deepEqual(verifier.allowedCapabilities, ['file:read', 'repo:read', 'command:exec'])
})

// --------------------------------------------------------------- ④ 密钥

test('④ ★★ 声明 `containsSecrets: false` 却夹带凭据——查的是**内容**，不是那个字段', () => {
  //   > 一个「信 `containsSecrets: false`」的密钥检查，
  //   > 与一个「包里真的躺着一个 `sk-...` 而检查通过了」的密钥检查，是同一个东西。
  const pack = sampleTeamPack()
  const files = [...pack.files, { path: 'rules/credentials.json', text: '{"apiKey": "hunter2swordfish"}\n' }]
  const verdict = assertPackAuthority({
    manifest: pack.manifest, files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, PACK_AUTHORITY_CODES.SECRET_IN_CONTENT)
  // 命中的说明里**不含原值**（报表会被人看到）
  assert.equal(JSON.stringify(verdict.problems).includes('hunter2swordfish'), false, '拒绝理由里把密钥原文抄出来了')
  assert.equal(verdict.computed.secretHits.length, 1)
})

test('④ ★ 两条判据缺一不可：供应商前缀 + 敏感键名下的字面量值', () => {
  //   > 一个「只认供应商前缀」的密钥扫描，
  //   > 与一个「`apiKey: "hunter2swordfish"` 照样通过」的密钥扫描，是同一个东西。
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"apiKey": "hunter2swordfish"}' }] }).length, 1, '敏感键名没被发现')
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: 'key = "sk-abcdefghijklmnop"' }] }).length, 1, '供应商前缀没被发现')
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----' }] }).length >= 1, true, '私钥块没被发现')
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '# 普通文档，没有任何键值对' }] }).length, 0)
})

test('④ 敏感的键名写法要认驼峰（`openaiApiKey`），不是只认下划线', () => {
  // 共享的 `SENSITIVE_KEY_RE` 认的是 `_`/`-` 分隔的键名，而 JSON 里更常见的
  // 驼峰在它那里不命中——少这一条就是"敏感键名扫描漏掉最常见的那种写法"。
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"openaiApiKey": "hunter2swordfish"}' }] }).length, 1)
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"db_password": "hunter2swordfish"}' }] }).length, 1)
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"client-secret": "hunter2swordfish"}' }] }).length, 1)
})

test('④ ★ **引用**是允许的：`env:` / `secret:` 必须在包里，否则没人知道去哪取', () => {
  // spec §7 有 `secret_refs` 表：存引用不存密文。
  // 一条会把引用也拒掉的检查，最终的下场是作者把引用删掉。
  for (const ref of SECRET_REFERENCE_PREFIXES) {
    assert.equal(looksLikeSecretReference(`${ref}SOME_NAME`), true, `${ref} 被判成了密文`)
  }
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"apiKey": "env:OPENAI_API_KEY"}' }] }).length, 0)
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"apiKey": "secret:vault/openai"}' }] }).length, 0)
})

test('④ ★ 误报的代价与漏报一样高：占位值不算密钥', () => {
  // 一个真实包因为文档里写了 `token: "none"` 而装不上，
  // 下一个人就会把整条检查关掉——那时真的密钥也跟着一起放过去了。
  for (const v of SECRET_PLACEHOLDER_VALUES) {
    assert.equal(looksLikeSecretReference(v), true, `占位值 ${v} 被判成了密文`)
  }
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"token": "none"}' }] }).length, 0)
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"apiKey": "CHANGE-ME"}' }] }).length, 0)
})

test('④ ★ 短值的方向选择被钉住：能力名不能被误读成键值对', () => {
  // `"credential:read"` 不加下限时会被读成"键 `credential`，值 `read`"，
  // 于是**每个声明了密钥类能力的包**都被误报。
  assert.equal(scanForSecrets({ files: [{ path: 'a', text: '{"capabilities": ["credential:read"]}' }] }).length, 0)
  assert.equal(PACK_AUTHORITY_CHECKED.samples.secretScan.literal, 1)
  assert.equal(PACK_AUTHORITY_CHECKED.samples.secretScan.reference, 0)
  assert.equal(PACK_AUTHORITY_CHECKED.samples.secretScan.vendorPrefix, 1)
})

test('④ ★ `containsSecrets` 必须由作者**声明**；声明 true 也拒', () => {
  const pack = sampleTeamPack()
  // (a) 没写这一项 —— "没声明"不是"没有"
  const { containsSecrets, ...without } = pack.manifest
  const missing = assertPackAuthority({
    manifest: without, files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(missing.code, PACK_AUTHORITY_CODES.SECRET_DECLARATION_MISSING)

  // (b) 写了 true —— 一个承认带密钥的包同样要被拒
  const declared = assertPackAuthority({
    manifest: { ...pack.manifest, containsSecrets: true },
    files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(declared.code, PACK_AUTHORITY_CODES.SECRET_DECLARED)
})

test('④ ★ 数据依赖不得要密钥，且种类必须认识', () => {
  const pack = sampleTeamPack()
  assert.ok(SECRET_DEPENDENCY_KINDS.includes('secret'))
  const secret = assertPackAuthority({
    manifest: { ...pack.manifest, dataDependencies: [{ id: 'k', kind: 'secret' }] },
    files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(secret.code, PACK_AUTHORITY_CODES.SECRET_DEPENDENCY)

  const unknown = assertPackAuthority({
    manifest: { ...pack.manifest, dataDependencies: [{ id: 'x', kind: 'quantum-telemetry' }] },
    files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(unknown.code, PACK_AUTHORITY_CODES.DATA_DEPENDENCY_UNKNOWN_KIND)

  const undeclared = assertPackAuthority({
    manifest: (() => { const { dataDependencies, ...rest } = pack.manifest; return rest })(),
    files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  assert.equal(undeclared.code, PACK_AUTHORITY_CODES.DATA_DEPENDENCY_UNDECLARED)
})

// --------------------------------------------------------------- ⑤ 强制面绕越

test('⑤ ★ 载荷里的强制面记号（端口 / 补丁行 / 危险沙箱档）必须被拒', () => {
  // spec §6.13 line 570：「不得绕过 ToolGuard、权限预设和审批」。
  // 一个包在内容里写着 `ctx.tools.guard`，就是它在试图自己挂一个强制点。
  const cases = [
    ['端口名', '{"hook": "ctx.tools.guard"}'],
    ['approval/request 端口', '{"on": "ctx.on(\'approval/request\')"}'],
    ['补丁层行 id', '{"row": "legion-enforcement-hard-floor"}'],
    ['危险沙箱档', '{"sandbox": "danger-full-access"}'],
    ['策略字段', '{"approvalPolicy": "never"}'],
  ]
  for (const [name, text] of cases) {
    const hits = scanForEnforcementBypass({ files: [{ path: 'x.json', text }] })
    assert.ok(hits.length > 0, `${name} 没有被扫出来`)
    // 命中说明里要给出**在哪一行附近**，否则值班的人得全文搜
    assert.equal(typeof hits[0].around, 'string')
  }
})

test('⑤ 强制面记号表是从 host 组合里**复用**来的，不是重抄的名单', () => {
  assert.ok(PACK_FORBIDDEN_CONTENT_TOKENS.includes('ctx.tools.guard'))
  assert.ok(PACK_FORBIDDEN_CONTENT_TOKENS.includes('legion-enforcement-hard-floor'))
  // 键名表 = PRT-603 的强制面字段 ∪ PRT-404 的权限字段，减去一个刻意排除的
  for (const k of AUTHORITY_BEARING_KEYS) {
    if (k === 'allowedTools') continue
    assert.ok(PACK_FORBIDDEN_CONTENT_KEYS.includes(k), `${k} 不在禁用的内容键名里`)
  }
  // `allowedTools` 被排除，因为它正是员工清单的合法字段；
  // 它真正的风险由 `EMPLOYEE_WIDENS_PACK` 那条**精确**检查覆盖。
  assert.equal(PACK_FORBIDDEN_CONTENT_KEYS.includes('allowedTools'), false)
  assert.equal(PACK_FORBIDDEN_CONTENT_KEYS.includes('approvalPolicy'), true)
  assert.equal(PACK_FORBIDDEN_CONTENT_KEYS.includes('permissionPreset'), true)
})

test('⑤ ★ 散文里提到强制面**不算**绕越：只在它被当成键或整串记号时才算', () => {
  // 一条会误报的检查，最终的归宿是被整条关掉。
  // 一句"审批由 host 负责"不该让包装不上。
  const prose = scanForEnforcementBypass({
    files: [{ path: 'docs/README.md', text: '# 说明\n\n审批由 host 负责，本项目不接触 approval 策略。\n' }],
  })
  assert.deepEqual(prose, [])

  const asKey = scanForEnforcementBypass({ files: [{ path: 'x.json', text: '{"approvalPolicy": "never"}' }] })
  // ★ 恰好**一条**。同一处越权报两条（`approvalPolicy` 同时在 PRT-603 与 PRT-404
  //   的名单里）会让"命中数"这个数字变成没人能解释的东西。
  assert.equal(asKey.length, 1)
  assert.equal(asKey[0].kind, 'key')
  assert.deepEqual(PACK_AUTHORITY_CHECKED.samples.forbiddenKeyDuplicates, [])
  assert.deepEqual(PACK_AUTHORITY_CHECKED.samples.forbiddenTokenDuplicates, [])

  const asToken = scanForEnforcementBypass({ files: [{ path: 'x.mjs', text: 'ctx.tools.guard(fn)' }] })
  assert.equal(asToken.length, 1)
  assert.equal(asToken[0].kind, 'token')
})

test('⑤ ★ 合法的内置包里**没有**强制面记号（读数，不是作者说没有）', () => {
  const g = good()
  const verdict = assertPackAuthority(g)
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems.map((p) => `${p.code}@${p.field}`)))
  assert.deepEqual(verdict.computed.bypassHits, [])
  assert.deepEqual(verdict.computed.secretHits, [])
})

// --------------------------------------------------------------- ⑥ 顺序

test('⑥ ★★ 「在创建目标前失败」断言的是**顺序**，不是一个判决布尔', () => {
  // `runPreflightThenCreateTarget` 报的 `sequence` 是**自报**的，
  // 所以这里另外用一个计数器钉住 `createTarget` 真的被调了几次——
  // 一个"报着 preflight、其实已经建了目标"的实现必须能被抓住。
  const o = provePreflightOrdering()
  assert.equal(o.badCreated, false)
  assert.equal(o.badTarget, null)
  assert.deepEqual(o.badSequence, ['preflight'])
  assert.equal(o.badCreateTargetCalls, 0, '不通过的包仍然调用了 createTarget')
  assert.deepEqual(o.badOnStepSequence, ['preflight'])
  assert.equal(o.goodCreated, true)
  assert.deepEqual(o.goodSequence, ['preflight', 'create-target'])
  assert.equal(o.totalCreateTargetCalls, 1, '好包与坏包加起来只该调一次 createTarget')
})

test('⑥ 坏包的失败原因要**先**落在预检码上，而不是"目标建不出来"', () => {
  const o = provePreflightOrdering()
  assert.equal(o.badVerdictCode, 'pack-manifest-content-hash-mismatch')
})

test('⑥ 预检通过但没有建目标的回调 → 拒绝，且步骤停在 preflight', () => {
  const pack = sampleTeamPack()
  const r = runPreflightThenCreateTarget({
    pack,
    host: HOST,
    hostSurface: sampleHostSurface(),
    builtinPackIds: [pack.manifest.packId],
    createTarget: null,
  })
  assert.equal(r.created, false)
  assert.equal(r.code, PACK_AUTHORITY_CODES.TARGET_CREATE_MISSING)
  assert.deepEqual(r.sequence, ['preflight'])
})

test('⑥ ★ 越权包也走同一条闸门：`createTarget` 一次都不许被调', () => {
  const pack = sampleTeamPack()
  const base = pack.manifest.requestedPermissions
  // 宿主基线**收窄**（不含 command:exec），包却申请了它
  const narrow = hostEnforcementSurface({
    preset: 'legion-attended',
    patchVersion: 1,
    grant: {
      allowedCapabilities: base.capabilities.filter((c) => c !== 'command:exec'),
      allowedTools: base.tools,
      maxRisk: base.maxRisk,
      workspaceRoot: base.workspaceRoot,
    },
  })
  // 内容表与哈希都跟着重算，所以唯一的问题就是越权
  const files = pack.files
  const rebuilt = sampleTeamPack()
  let calls = 0
  const r = runPreflightThenCreateTarget({
    pack: { manifest: rebuilt.manifest, files },
    host: HOST,
    hostSurface: narrow,
    builtinPackIds: [rebuilt.manifest.packId],
    createTarget: () => { calls += 1; return { targetId: 'x' } },
  })
  assert.equal(r.created, false)
  assert.equal(calls, 0, '越权包仍然建出了目标')
  assert.deepEqual(r.sequence, ['preflight'])
  assert.equal(r.code, PACK_AUTHORITY_CODES.CAPABILITY_WIDENS_HOST)
})

// --------------------------------------------------------------- ⑦ 总检

test('⑦ ★ 预检把清单层与越权层串起来，两层的问题都在同一份列表里', () => {
  // 顺序固定：清单层先跑（越权层需要一份归一化过的 manifest，
  // 而内容哈希必须先算出来，签名才有东西可验）。
  const pack = sampleTeamPack()
  const verdict = preflightPack({
    manifest: { ...pack.manifest, containsSecrets: true },
    files: pack.files,
    host: HOST,
    hostSurface: sampleHostSurface(),
    builtinPackIds: [pack.manifest.packId],
  })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.problems.some((p) => p.code === PACK_AUTHORITY_CODES.SECRET_DECLARED), JSON.stringify(verdict.problems.map((p) => p.code)))
  assert.equal(typeof verdict.computed.fileCount, 'number', '清单层的读数丢了')
  assert.equal(typeof verdict.computed.employees, 'number', '越权层的读数丢了')
})

test('⑦ 阳性对照：合法的包在完整的预检里必须通过', () => {
  const pack = sampleTeamPack()
  const verdict = preflightPack({
    manifest: pack.manifest,
    files: pack.files,
    host: HOST,
    hostSurface: sampleHostSurface(),
    builtinPackIds: [pack.manifest.packId],
  })
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems.map((p) => `${p.code}@${p.field}`)))
  assert.equal(verdict.code, null)
  assert.equal(verdict.computed.trust, 'builtin')
})

test('⑦ 员工清单解析不出来时，越权层给出**自己的**码（不是静默跳过）', () => {
  const pack = sampleTeamPack()
  // 团队包入口换成不是 JSON 的内容 → 清单层报入口错，越权层报"员工清单拿不到"
  const files = pack.files.map((f) => (f.path === 'team/team-plan.json' ? { path: f.path, text: 'not json' } : f))
  const verdict = preflightPack({
    manifest: pack.manifest, files, host: HOST, hostSurface: sampleHostSurface(), builtinPackIds: [pack.manifest.packId],
  })
  assert.equal(verdict.ok, false)
  const codes = verdict.problems.map((p) => p.code)
  assert.ok(codes.includes(PACK_AUTHORITY_CODES.EMPLOYEES_UNDECLARED), JSON.stringify(codes))
})

test('⑦ 同一条判据不会被报两遍（"问题数量"这个数字要能看）', () => {
  const pack = sampleTeamPack()
  const { requestedPermissions, ...without } = pack.manifest
  const verdict = assertPackAuthority({
    manifest: without, files: pack.files, hostSurface: sampleHostSurface(), employees: employeesOf(pack),
  })
  const perms = verdict.problems.filter((p) => p.code === PACK_AUTHORITY_CODES.PERMISSION_UNDECLARED)
  assert.equal(perms.length, 1, `PERMISSION_UNDECLARED 被报了 ${perms.length} 遍`)
})
