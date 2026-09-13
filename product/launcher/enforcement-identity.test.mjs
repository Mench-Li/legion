// product/launcher/enforcement-identity.test.mjs
// ============================================================================
// PRT-214 续：Legion 身份注入 Runtime 子进程。
//
// ## 这一组守的是什么
//
// 组合根要求六项输入，而它只从进程环境读。于是"谁把这几项放进去"是一个
// 必须有人回答的问题——在此之前没有人回答，所以即使 root-row 挂进了补丁层，
// 它也会在 DSH 进程里以 `CONFIG_MISSING` 拒绝。
//
//   · **注入真的发生了**：Runtime 子进程的环境里有那几项，别的进程没有；
//   · **没编造任何值**：actor / scope / action 一个默认值都没有，
//     且"缺身份"与"故意关掉"是**两个不同的码**（不是同一个读数）；
//   · **两个副本没有漂移**：`product/` 侧注入的键名与 `runtime/` 侧读取的键名
//     逐项相同——这条是整套里最要紧的一条，因为两边**不能互相 import**，
//     只能靠一条用例把"同一份事实的两个副本"钉在一起；
//   · **每种失败都拦得下**：`preflight()` 报 plan 阶段失败，不是启动之后才发现。
//
// 测试形状纪律：断言**具名码**本身；每条"没注入"的断言都有反向对照；
// 三态（覆盖层开+身份全 / 开+身份缺 / 关）必须**互相可分**。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  ENFORCEMENT_DECIDE_ENV_KEYS,
  ENFORCEMENT_IDENTITY_CODES,
  ENFORCEMENT_IDENTITY_ENV,
  ENFORCEMENT_IDENTITY_PASSTHROUGH,
  ENFORCEMENT_IDENTITY_PROCESS_KEY,
  ENFORCEMENT_IDENTITY_REQUIRED,
  ENFORCEMENT_IDENTITY_VERSION,
  resolveEnforcementIdentity,
} from './enforcement-identity.mjs'
import { DSH_OVERLAY_CODES, DSH_OVERLAY_RELPATH } from './dsh-overlay.mjs'
import { createLauncher } from './launcher.mjs'
import { resolveLayout } from '../paths.mjs'
import { ENFORCEMENT_CONFIG_FIELDS, REQUIRED_ENFORCEMENT_CONFIG } from '../../runtime/dsh-composition/root.mjs'
import { specFor } from '../process-manifest.mjs'

/**
 * 真仓库根 = "有补丁文件的那个安装目录"。
 *
 * ★ 刻意**不** import `dsh-overlay.test.mjs` 里的同名夹具：import 一个 `.test.mjs`
 *   会把那一套的用例在本进程里再跑一遍（`node:test` 的顶层 `test()` 是注册，
 *   不是纯函数），于是两套的计数互相污染，而失败会指向错误的文件。
 *   夹具复制一份的代价是"可能漂移"——所以下面有一条用例钉住补丁文件真的在。
 */
const REPO_ROOT = resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/** 合法但独立的布局。`installDir` 默认指真仓库（那里有补丁文件）。 */
function layoutIn(root, overrides = {}) {
  const { layout } = resolveLayout({
    installDir: REPO_ROOT,
    dataDir: join(root, 'data'),
    workspaceDir: join(root, 'ws'),
    homeDir: root,
    env: {},
    ...overrides,
  })
  return layout
}

const CWD = process.platform === 'win32' ? 'C:\\Legion' : '/legion'
const HUB_PORT = 51814

/** 一份**完整**的 `runtime.env`。字段不多不少，就是只能从配置来的那几个。 */
const CONFIGURED_OK = Object.freeze({
  LEGION_ACTOR: 'alice',
  LEGION_SCOPE: 'space-1',
  LEGION_ENFORCEMENT_ACTION: 'write',
})

const codesOf = (ds) => ds.map((d) => d.code)
const byCode = (ds, code) => ds.filter((d) => d.code === code)

// ═══════════════════════════════════════════════ 解析（纯函数）

describe('PRT-214 续 Legion 身份：解析', () => {
  test('★★★ 夹具前提：安装目录里真的有补丁文件（否则下面几条测的是别的东西）', () => {
    assert.ok(existsSync(join(REPO_ROOT, ...DSH_OVERLAY_RELPATH.split('/'))),
      `夹具的 installDir 指向 ${REPO_ROOT}，那里没有 ${DSH_OVERLAY_RELPATH}`)
  })

  test('★★★ 派生值：hub 地址来自本次启动的端口，cwd 来自 Runtime 进程的 cwd', () => {
    const r = resolveEnforcementIdentity({
      teamHubPort: HUB_PORT, cwd: CWD, configured: CONFIGURED_OK,
    })
    assert.equal(r.ok, true)
    assert.equal(r.version, ENFORCEMENT_IDENTITY_VERSION)
    assert.equal(r.values.TEAM_HUB_URL, `http://127.0.0.1:${HUB_PORT}`)
    assert.equal(r.values.LEGION_CWD, CWD)
    assert.equal(r.sources.hubUrl, 'derived')
    assert.equal(r.sources.cwd, 'derived')
    for (const f of ['actor', 'scope', 'action']) assert.equal(r.sources[f], 'config', f)
    // taskId 可选：没配就**不注入**（不是注入空串）
    assert.equal('LEGION_TASK_ID' in r.values, false, 'taskId 没配却被注入了')
    assert.deepEqual([...r.diagnostics], [])
  })

  test('★★★ 派生值**优先于**配置：hub 端口改了，配置里的旧地址不该压过它', () => {
    // 与 workbench 的 `DSH_HUB_UPSTREAM` 同一条理由（launcher.mjs 那段是实测出来的）：
    // 让进程按配置里的旧地址去连，会静默指向**另一个** hub。
    const r = resolveEnforcementIdentity({
      teamHubPort: HUB_PORT,
      cwd: CWD,
      configured: { ...CONFIGURED_OK, TEAM_HUB_URL: 'http://127.0.0.1:8787', LEGION_CWD: 'C:\\somewhere-else' },
    })
    assert.equal(r.values.TEAM_HUB_URL, `http://127.0.0.1:${HUB_PORT}`, '配置压过了派生值')
    assert.equal(r.values.LEGION_CWD, CWD, '配置压过了派生值')
    assert.equal(r.sources.hubUrl, 'derived')
    assert.equal(r.sources.cwd, 'derived')
  })

  test('★★★ 缺 actor → **一个具名码**，且逐字段说清"缺什么 / 去哪写"', () => {
    const r = resolveEnforcementIdentity({
      teamHubPort: HUB_PORT, cwd: CWD, configured: { LEGION_SCOPE: 's' },
    })
    assert.equal(r.ok, false)
    assert.deepEqual([...r.missing].map((m) => m.field).sort(), ['action', 'actor'])
    assert.deepEqual([...r.missing].map((m) => m.env).sort(), ['LEGION_ACTOR', 'LEGION_ENFORCEMENT_ACTION'])
    const errs = byCode(r.diagnostics, ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING)
    assert.equal(errs.length, 1)
    assert.equal(errs[0].severity, 'error')
    // process 必须是 runtime，否则 `--include team-hub` 的受限启动降不了级
    assert.equal(errs[0].process, ENFORCEMENT_IDENTITY_PROCESS_KEY)
    assert.deepEqual([...errs[0].missing], ['actor', 'action'])
    assert.deepEqual([...errs[0].envKeys], ['LEGION_ACTOR', 'LEGION_ENFORCEMENT_ACTION'])
    // 文案必须同时给出「哪个键」与「去哪写」——只说"缺 actor"等于把排查丢给用户
    assert.match(errs[0].message, /LEGION_ACTOR/)
    assert.match(errs[0].message, /runtime\.env/)
    // 已配的字段**不得**被报成缺（否则"缺哪个报哪个"是空的）
    assert.doesNotMatch(errs[0].message, /LEGION_SCOPE/)
  })

  test('★★★ 端口或 cwd 派不出来 → 缺的是**那两项**，且理由指得出是"没定端口"', () => {
    const r = resolveEnforcementIdentity({ teamHubPort: null, cwd: null, configured: CONFIGURED_OK })
    assert.equal(r.ok, false)
    assert.deepEqual([...r.missing].map((m) => m.field).sort(), ['cwd', 'hubUrl'])
    const why = Object.fromEntries(r.missing.map((m) => [m.field, m.why]))
    assert.match(why.hubUrl, /team-hub 端口/)
    assert.match(why.cwd, /进程计划里没有 cwd/)
    // 反向对照：端口与 cwd 都给了、但配置全空 → 缺的**只有**那三项。
    // 两个方向的缺项集合不同，说明判据不是"永远报同样一堆"。
    const other = resolveEnforcementIdentity({ teamHubPort: HUB_PORT, cwd: CWD, configured: {} })
    assert.deepEqual([...other.missing].map((m) => m.field).sort(), ['action', 'actor', 'scope'])
  })

  test('★★★ 没配任何东西时，消息里**不得**出现编造的 hub 地址 / actor', () => {
    const r = resolveEnforcementIdentity({ teamHubPort: null, cwd: null, configured: {} })
    const text = r.diagnostics.map((d) => d.message).join('\n')
    // ★ 可执行形式的"不编造"：默认 hub 端口 / 回环地址一个字都不该出现。
    assert.doesNotMatch(text, /8787|127\.0\.0\.1|localhost/, '拒绝消息里出现了编造的 hub 地址')
    // `http://` 不该出现——一个被贴出来的示例地址会被当成"默认值就是它"
    assert.doesNotMatch(text, /https?:\/\//)
    // 而且**注入结果**里一个键都没有（不是注入了空串）
    assert.deepEqual(Object.keys(r.values), [])
  })

  test('★★★ 关掉覆盖层 → 解析器**刻意沉默**（不产出任何诊断）', () => {
    // 理由在模块文件头：关掉这件事已经由 `resolveDshOverlay` 的
    // `DSH_OVERLAY_DISABLED_BY_CONFIG` 说过一次；再说一次就是两个口径。
    const off = resolveEnforcementIdentity({ enabled: false, teamHubPort: null, cwd: null, configured: {} })
    assert.equal(off.ok, true)
    assert.deepEqual([...off.diagnostics], [], '关掉之后身份模块还在报错——那会让正常部署收到假警报')
    assert.deepEqual(Object.keys(off.values), [], '关掉了还注入身份')
    assert.equal(off.enabled, false)
  })

  test('★★★ 「故意关掉」与「身份缺失」必须是**两个不同的码**', () => {
    // 合成一个的话，一个关掉了覆盖层、因而本来就不需要身份的正常部署，
    // 会被报成"身份缺失"——而这两者的修法完全相反（一个什么都别做，一个去补配置）。
    const off = resolveEnforcementIdentity({ enabled: false, teamHubPort: null, cwd: null, configured: {} })
    const missing = resolveEnforcementIdentity({ teamHubPort: null, cwd: null, configured: {} })
    assert.notEqual(ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING, DSH_OVERLAY_CODES.DISABLED_BY_CONFIG)
    assert.deepEqual(codesOf(off.diagnostics), [])
    assert.deepEqual(codesOf(missing.diagnostics), [ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING])
    assert.equal(off.ok, true)
    assert.equal(missing.ok, false)
  })

  test('★★ 全空白的值算缺失，不是"配了"', () => {
    const r = resolveEnforcementIdentity({
      teamHubPort: HUB_PORT, cwd: CWD,
      configured: { LEGION_ACTOR: '   ', LEGION_SCOPE: 's', LEGION_ENFORCEMENT_ACTION: 'write' },
    })
    assert.equal(r.ok, false)
    assert.deepEqual([...r.missing].map((m) => m.field), ['actor'])
    assert.equal('LEGION_ACTOR' in r.values, false)
  })

  test('★ 取值前后去空白；非字符串的配置值不参与（不猜类型）', () => {
    const r = resolveEnforcementIdentity({
      teamHubPort: HUB_PORT, cwd: CWD,
      configured: {
        LEGION_ACTOR: '  alice  ', LEGION_SCOPE: 'space-1', LEGION_ENFORCEMENT_ACTION: 'write',
        LEGION_TASK_ID: 12345,
      },
    })
    assert.equal(r.values.LEGION_ACTOR, 'alice')
    assert.equal(r.values.LEGION_TASK_ID, '12345', '数字可以被忠实转成字符串')
    // `configured` 不是对象时按"什么都没配"处理，而不是崩掉
    const bad = resolveEnforcementIdentity({ teamHubPort: HUB_PORT, cwd: CWD, configured: [] })
    assert.equal(bad.ok, false)
    assert.deepEqual([...bad.missing].map((m) => m.field).sort(), ['action', 'actor', 'scope'])
  })

  test('★★ 审批口径三项经 `runtime.env` 透传（**可选**，缺了不算缺失）', () => {
    const r = resolveEnforcementIdentity({
      teamHubPort: HUB_PORT, cwd: CWD,
      configured: {
        ...CONFIGURED_OK,
        LEGION_APPROVAL_POLICY: 'never',
        LEGION_ATTENDED: 'false',
        LEGION_PERMISSION_PRESET: 'legion-unattended',
      },
    })
    assert.equal(r.ok, true, '审批口径不该被当成必填')
    assert.equal(r.values.LEGION_APPROVAL_POLICY, 'never')
    assert.equal(r.values.LEGION_ATTENDED, 'false')
    assert.equal(r.values.LEGION_PERMISSION_PRESET, 'legion-unattended')
    // 反向：一个都不给时 ok 仍然是 true（它们**不是**必填）
    const none = resolveEnforcementIdentity({ teamHubPort: HUB_PORT, cwd: CWD, configured: CONFIGURED_OK })
    assert.equal(none.ok, true)
    for (const k of ENFORCEMENT_DECIDE_ENV_KEYS) assert.equal(k in none.values, false, k)
  })

  test('★ 闭集：透传名单就是那 9 个键，多一个就会红', () => {
    assert.deepEqual([...ENFORCEMENT_IDENTITY_PASSTHROUGH].sort(), [
      ...Object.values(ENFORCEMENT_IDENTITY_ENV),
      ...ENFORCEMENT_DECIDE_ENV_KEYS,
    ].sort())
    assert.equal(ENFORCEMENT_IDENTITY_PASSTHROUGH.length, 9)
  })
})

// ═══════════════════════════════════════════════ 两个副本不许漂移

describe('PRT-214 续 Legion 身份：与组合根的键名逐项一致', () => {
  test('★★★★★ `product/` 注入的键名 == `runtime/` 读取的键名（逐字段）', () => {
    // 这两个模块**不能互相 import**（依赖方向：`runtime/dsh-composition/` 才 import
    // `product/`，反之会把生成器与 Launcher 缠在一起），所以键名是**同一份事实的
    // 两个副本**。没有这一条，"注入了一个没人读的变量"与"接好了"在运行时完全一样。
    const runtimeEnvOf = {}
    for (const [field, spec] of Object.entries(ENFORCEMENT_CONFIG_FIELDS)) {
      runtimeEnvOf[field] = [...spec.envKeys]
    }
    for (const [field, env] of Object.entries(ENFORCEMENT_IDENTITY_ENV)) {
      const theirs = runtimeEnvOf[field]
      assert.ok(Array.isArray(theirs), `组合根不认识字段 ${field}——注入它没有任何意义`)
      assert.ok(theirs.includes(env),
        `字段 ${field}：Launcher 注入 ${env}，而组合根只读 ${JSON.stringify(theirs)}`)
    }
    // 必填清单也必须一致：一边说必填、另一边说可选，会让"缺了"在两侧口径不同。
    assert.deepEqual([...ENFORCEMENT_IDENTITY_REQUIRED].sort(), [...REQUIRED_ENFORCEMENT_CONFIG].sort())
    // 反向：组合根要求的字段，本模块也该知道它的注入键名
    for (const field of REQUIRED_ENFORCEMENT_CONFIG) {
      assert.ok(field in ENFORCEMENT_IDENTITY_ENV, `组合根要求 ${field}，而本模块没有它的注入键名`)
    }
  })

  test('★★★★ `decide` 的键名与 root-row 侧逐项一致（同样不能 import）', async () => {
    // 同上：`runtime/dsh-composition/plugins/root-row.mjs` 的 `DECIDE_ENV_KEYS`。
    // 这里先用手写字面量钉住，再与那一侧真正导出的那份对比——
    // 两边都对上，才说明"注入端"与"读取端"是同一份事实。
    assert.deepEqual([...ENFORCEMENT_DECIDE_ENV_KEYS].sort(), [
      'LEGION_APPROVAL_POLICY', 'LEGION_ATTENDED', 'LEGION_PERMISSION_PRESET',
    ].sort())
    const m = await import('../../runtime/dsh-composition/plugins/root-row.mjs')
    assert.deepEqual(
      [...ENFORCEMENT_DECIDE_ENV_KEYS].sort(),
      Object.values(m.DECIDE_ENV_KEYS).sort(),
    )
  })

  test('★★★★ 每一个要注入的键都在 runtime 的 `envNames` 里声明过', () => {
    // `buildChildEnv()` 对未声明的键**直接抛**。这条用例把那个抛变成一条提前的、
    // 说得出是哪个键的红——否则它会在第一次真的 spawn 时才暴露。
    const spec = specFor(ENFORCEMENT_IDENTITY_PROCESS_KEY)
    assert.ok(spec !== null)
    for (const env of ENFORCEMENT_IDENTITY_PASSTHROUGH) {
      assert.ok(spec.envNames.includes(env), `${env} 没在 runtime 的 envNames 里声明`)
    }
    // 反向：不许把非 DSH_HOME/LEGION_/TEAM_HUB_ 的东西混进来（闭集的意义）
    for (const env of spec.envNames) {
      assert.match(env, /^(DSH_HOME|LEGION_[A-Z_]+|TEAM_HUB_[A-Z_]+)$/, `runtime 声明了一个意外的键 ${env}`)
    }
  })
})

// ═══════════════════════════════════════════════ 接进 Launcher（三态）

/** 一个能定位到补丁文件的 Launcher：`include` 只拉 runtime。 */
const makeLauncher = (root, over = {}) => createLauncher({
  layout: layoutIn(root, over.layout ?? {}),
  include: ['runtime'],
  runtimeCommand: 'dsh --profile web',
  ports: { runtime: 51999, 'team-hub': HUB_PORT },
  ...over,
})

describe('PRT-214 续 Legion 身份：接进 Launcher 的三态', () => {
  test('★★★ 覆盖层开 + 身份全 → 预检通过，且 Runtime 子进程环境里真的有那几项', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-id-'))
    try {
      const L = makeLauncher(root, { runtimeEnv: CONFIGURED_OK })
      assert.equal(L.enforcementIdentity.ok, true)
      assert.deepEqual([...L.enforcementIdentity.diagnostics], [])
      const pre = await L.preflight()
      assert.equal(pre.ok, true, `身份齐了却没通过预检：${JSON.stringify(codesOf(pre.diagnostics))}`)

      // ★ 关键：注入**真的落在子进程的环境里**。断言 `L.enforcementIdentity.values`
      //   只证明解析器算对了，不证明它被交给了谁。
      const surface = L.envSurface()
      const rt = surface.find((s) => s.process === 'runtime')
      assert.ok(rt !== undefined, 'envSurface 里没有 runtime')
      assert.ok(rt.allowed.includes('LEGION_ACTOR'), 'LEGION_ACTOR 不在 runtime 的白名单里')
      assert.equal(rt.values.LEGION_ACTOR, 'alice')
      assert.equal(rt.values.LEGION_SCOPE, 'space-1')
      assert.equal(rt.values.LEGION_ENFORCEMENT_ACTION, 'write')
      assert.equal(rt.values.TEAM_HUB_URL, `http://127.0.0.1:${HUB_PORT}`)
      assert.equal(typeof rt.values.LEGION_CWD, 'string')
      assert.notEqual(rt.values.LEGION_CWD, '', 'cwd 是个空串——那与没注入在审计上是同一件事')

      // 别的进程**不该**拿到身份：它们是"这个运行时以谁的名义"的声明，不是通用配置
      for (const s of surface) {
        if (s.process === 'runtime') continue
        for (const k of Object.values(ENFORCEMENT_IDENTITY_ENV)) {
          assert.equal(k in s.values, false, `进程 ${s.process} 也拿到了 ${k}`)
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 覆盖层开 + 身份缺 → 预检在 **plan 阶段**拦下，且码是身份那个', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-id-'))
    try {
      const L = makeLauncher(root, { runtimeEnv: {} })
      assert.equal(L.enforcementIdentity.ok, false)
      const pre = await L.preflight()
      assert.equal(pre.ok, false, '缺身份却通过了预检——那正是"看起来装了强制面"的部署')
      assert.equal(pre.phase, 'plan', '身份判定该在 spawn 之前一次性做完')
      assert.equal(byCode(pre.diagnostics, ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING).length, 1)
      assert.equal(byCode(pre.diagnostics, DSH_OVERLAY_CODES.PATCH_FILE_MISSING).length, 0,
        '报成了"补丁文件不在"——但补丁文件在，缺的是身份。这是错的诊断')
      // 缺的是三项只能从配置来的，hub 与 cwd 是派生出来的
      assert.deepEqual([...L.enforcementIdentity.missing].map((m) => m.field).sort(),
        ['action', 'actor', 'scope'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 覆盖层关 → 预检通过，只留下"关掉了"一条 warn（没有身份诊断）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-id-'))
    try {
      const L = makeLauncher(root, { enforcementOverlay: false, runtimeEnv: {} })
      const pre = await L.preflight()
      assert.equal(pre.ok, true, `关掉是一个被允许的决定：${JSON.stringify(codesOf(pre.diagnostics))}`)
      assert.equal(byCode(pre.diagnostics, DSH_OVERLAY_CODES.DISABLED_BY_CONFIG).length, 1)
      assert.equal(byCode(pre.diagnostics, ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING).length, 0,
        '关掉之后还在报"身份缺失"——那会让一个正常的部署收到假警报')
      // 关掉时也不该注入身份（没有强制面要它的身份）
      const rt = L.envSurface().find((s) => s.process === 'runtime')
      assert.equal('LEGION_ACTOR' in rt.values, false)
      assert.equal('TEAM_HUB_URL' in rt.values, false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 三态互不相同：各自的 `enforcementIdentity` 读数都能区分', async () => {
    // 这一条是上面三条的**元判据**：三种处境必须不能被同一个读数满足。
    const root = mkdtempSync(join(tmpdir(), 'legion-id-'))
    try {
      const onOk = makeLauncher(root, { runtimeEnv: CONFIGURED_OK })
      const onMissing = makeLauncher(root, { runtimeEnv: {} })
      const off = makeLauncher(root, { enforcementOverlay: false, runtimeEnv: {} })

      const sig = (L) => JSON.stringify({
        ok: L.enforcementIdentity.ok,
        codes: codesOf(L.enforcementIdentity.diagnostics),
        enabled: L.enforcementIdentity.enabled,
      })
      const sigs = [sig(onOk), sig(onMissing), sig(off)]
      assert.equal(new Set(sigs).size, 3, `三种处境里有两种读数相同：${sigs.join(' | ')}`)
      assert.equal(onOk.enforcementIdentity.ok, true)
      assert.equal(onMissing.enforcementIdentity.ok, false)
      assert.equal(off.enforcementIdentity.ok, true)
      // 预检结论也不能被混起来：只有"开+缺"这一种不通过
      assert.equal((await onOk.preflight()).ok, true)
      assert.equal((await onMissing.preflight()).ok, false)
      assert.equal((await off.preflight()).ok, true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 范围不含 runtime → 身份缺失降级为 warn，受限启动照常通过', async () => {
    // 与覆盖层同一条判据：一次本来就不拉 runtime 的启动，
    // 不该因为"强制面没装上"而起不来。这一条验的是诊断的 `process` 接对了。
    const root = mkdtempSync(join(tmpdir(), 'legion-id-'))
    try {
      const L = createLauncher({
        layout: layoutIn(root),
        include: ['team-hub'],
        ports: { 'team-hub': HUB_PORT },
        runtimeEnv: {},
      })
      assert.equal(byCode(L.enforcementIdentity.diagnostics, ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING).length, 1)
      assert.equal(byCode(L.diagnostics, ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING).length, 0,
        'include 不含 runtime 时原始码不该还留在面向用户的诊断里')
      const pre = await L.preflight()
      assert.equal(pre.ok, true, `不拉 runtime 的启动被身份诊断挡住了：${JSON.stringify(codesOf(pre.diagnostics))}`)
      const downgraded = byCode(pre.diagnostics, 'PROCESS_EXCLUDED_BY_SCOPE')
      assert.ok(downgraded.some((d) => d.excludedCode === ENFORCEMENT_IDENTITY_CODES.IDENTITY_MISSING),
        '降级发生了，但换码后的诊断没说它替换掉了哪一条')
      for (const d of downgraded) assert.equal(d.severity, 'warn')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★ 产品配置 `runtime.env` → launcherInputFromConfig → 真的影响预检', async () => {
    const { launcherInputFromConfig } = await import('../config.mjs')
    const out = launcherInputFromConfig({
      value: { runtime: { enforcementOverlay: true, env: CONFIGURED_OK } },
      layers: [],
    })
    assert.deepEqual(out.runtimeEnv, CONFIGURED_OK)
    // ★ 反向：配置里**没写** `runtime.env` 时，`out` 里不该凭空多出一个空对象。
    //   补一个 `{}` 会让"没配身份"与"配了个空"在读数上同形，而这两者的
    //   修法不同（一个是去写配置，一个是去看配置为什么是空的）。
    const none = launcherInputFromConfig({ value: { runtime: {} }, layers: [] })
    assert.equal('runtimeEnv' in none, false)
    // 而且 `runtime.env` 必须仍是**已知键**——否则整份配置会被 `CONFIG_UNKNOWN_KEY` 拒掉，
    // 而那发生在读取层，与本模块无关：这条断言把"两层键名漂移"提前抓出来。
    const { KNOWN_CONFIG_KEYS } = await import('../config.mjs')
    assert.ok('runtime.env' in KNOWN_CONFIG_KEYS)

    // 非字符串的值被丢掉（不猜类型）：`LEGION_ATTENDED` 的读取端只认字面 true/false
    const messy = launcherInputFromConfig({
      value: { runtime: { env: { LEGION_ACTOR: 'alice', LEGION_ATTENDED: 1, LEGION_SCOPE: true } } },
      layers: [],
    })
    assert.deepEqual(messy.runtimeEnv, { LEGION_ACTOR: 'alice' })

    const root = mkdtempSync(join(tmpdir(), 'legion-id-'))
    try {
      const L = makeLauncher(root, { runtimeEnv: out.runtimeEnv })
      const pre = await L.preflight()
      assert.equal(pre.ok, true, `配置里写全了却没通过：${JSON.stringify(codesOf(pre.diagnostics))}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★ `runtime.env` 不做 shell 展开，也不是凭证的后门', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-id-'))
    try {
      const L = makeLauncher(root, {
        runtimeEnv: { ...CONFIGURED_OK, LEGION_SCOPE: '$HOME/space', TEAM_HUB_TOKEN: 'must-not-arrive' },
      })
      const rt = L.envSurface().find((s) => s.process === 'runtime')
      // 值原样传下去（不做展开）——"展开了一次"与"传了个别的值"一样危险
      assert.equal(rt.values.LEGION_SCOPE, '$HOME/space')
      // ★ 凭证键**不在** runtime 的声明名单里。`buildChildEnv` 对未声明的键直接抛，
      //   所以这里能走到 envSurface 本身就说明它没被写进去——但抛不抛是一回事，
      //   "它有没有到达子进程"是另一回事，所以仍然逐条断言。
      assert.equal('TEAM_HUB_TOKEN' in rt.values, false, 'runtime.env 成了凭证的后门')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
