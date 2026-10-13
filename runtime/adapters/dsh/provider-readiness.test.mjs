// runtime/adapters/dsh/provider-readiness.test.mjs
// ============================================================================
// provider 就绪度探测的判据。
//
// 这份用例守的是那次「相当茫然」的病根：**已注册 ≠ 可用**。
// 面板原来让用户手填 provider 名（而界面里查不到），而心跳上报的能力位是**声明**、
// 不是**读数** —— 一台没装 `codex` 的机器，界面上照样显示"就绪"。
//
// 所以下面每一条都在钉同一件事：**结论必须来自本机读数，且不同的"不可用"必须分得开**。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, delimiter } from 'node:path'

import {
  PROVIDER_SPECS,
  READINESS_STATE,
  createReadinessCache,
  extractVersion,
  hasReadinessSpec,
  probeProvider,
  probeProviders,
  resolveOnPath,
} from './provider-readiness.mjs'

const HOME = '/home/testuser'

/** 造一份**全绿**的假依赖，逐项可覆写。 */
function deps(over = {}) {
  return {
    platform: 'linux',
    home: HOME,
    fileExists: () => false,
    envHas: () => false,
    pathValue: '/usr/local/bin',
    resolveOnPath: () => '/usr/local/bin/tool',
    execVersion: async () => ({ ok: true, stdout: 'tool 1.2.3\n' }),
    httpHead: async () => 'reachable',
    now: () => 1_000_000,
    ...over,
  }
}

describe('provider 就绪度', () => {
  test('★ 内置 provider（spawn）是 ready，不是 unprobed', () => {
    // 两者都会让"能不能用"的答案看起来像"是"，但含义完全不同：
    // ready = 我确认过它随进程内跑；unprobed = 我不知道。判据不许把它们混起来。
    return probeProvider('spawn', deps()).then((r) => {
      assert.equal(r.state, READINESS_STATE.READY)
      assert.equal(r.auth, 'not_required')
      assert.match(r.reason, /进程内运行/)
    })
  })

  test('★ 不认识的 provider 报 unprobed，**绝不默认判 ready**', async () => {
    // 这是本次事故的核心：DSH 把一个 provider 注册上了，不代表这台机器上它真能跑。
    // 没有探测规格时，唯一诚实的回答是"我没探过"。
    const r = await probeProvider('some-registered-thing', deps())
    assert.equal(r.state, READINESS_STATE.UNPROBED)
    assert.notEqual(r.state, READINESS_STATE.READY)
    assert.match(r.reason, /已注册不等于可用/)
  })

  test('① 找不到 CLI ⇒ missing_cli，且给出可执行的安装提示', async () => {
    const r = await probeProvider('codex', deps({ resolveOnPath: () => null }))
    assert.equal(r.state, READINESS_STATE.MISSING_CLI)
    assert.equal(r.cli, 'missing')
    assert.match(r.reason, /@openai\/codex/, 'reason 必须带上该装什么')
  })

  test('★ CLI 在但没登录 ⇒ not_logged_in，且与 missing_cli 分开报', async () => {
    const r = await probeProvider('codex', deps({ fileExists: () => false, envHas: () => false }))
    assert.equal(r.state, READINESS_STATE.NOT_LOGGED_IN)
    assert.equal(r.cli, 'found')
    assert.equal(r.auth, 'absent')
    assert.match(r.reason, /codex login/, 'reason 必须带上该怎么登录')
    assert.notEqual(r.state, READINESS_STATE.MISSING_CLI, '两者的修法完全不同，不许合并')
  })

  test('★ 登录态靠 env 变量**名**也算数（不读值）', async () => {
    const r = await probeProvider('codex', deps({ fileExists: () => false, envHas: (k) => k === 'OPENAI_API_KEY' }))
    assert.equal(r.state, READINESS_STATE.READY)
    assert.equal(r.auth, 'present')
  })

  test('登录态靠登录文件也算数', async () => {
    const r = await probeProvider('codex', deps({ fileExists: (p) => p === join(HOME, '.codex/auth.json') }))
    assert.equal(r.state, READINESS_STATE.READY)
  })

  test('② 都齐了但端点连不上 ⇒ no_network（与"没装/没登录"分开）', async () => {
    const r = await probeProvider('codex', deps({
      fileExists: () => true,
      httpHead: async () => 'unreachable',
    }))
    assert.equal(r.state, READINESS_STATE.NO_NETWORK)
    assert.equal(r.cli, 'found')
    assert.equal(r.auth, 'present')
    assert.equal(r.network, 'unreachable')
    assert.match(r.reason, /chatgpt\.com/, 'reason 要说是哪个端点连不上')
  })

  test('全绿 ⇒ ready，并且把 CLI 版本带出来', async () => {
    const r = await probeProvider('claude-code', deps({ fileExists: () => true }))
    assert.equal(r.state, READINESS_STATE.READY)
    assert.equal(r.cli, 'found')
    assert.equal(r.auth, 'present')
    assert.equal(r.network, 'reachable')
    assert.equal(r.version, '1.2.3')
  })

  test('★★ 纪律 ④：结论里**不出现机器路径**（只写 ~/… 那种通用写法）', async () => {
    // "哪台机器的哪个路径缺什么"本身就是一张地图 —— 跨机器读到的只能是通用修法。
    for (const [name, over] of [
      ['codex', { resolveOnPath: () => null }],
      ['codex', { fileExists: () => false }],
      ['claude-code', { httpHead: async () => 'unreachable' }],
    ]) {
      const r = await probeProvider(name, deps(over))
      assert.ok(!String(r.reason).includes(HOME), `reason 泄漏了本机路径：${r.reason}`)
      assert.ok(!JSON.stringify(r).includes(HOME), '整个结论对象里都不许有本机路径')
    }
  })

  test('★★ 纪律 ①：只判存在性，**凭据的值绝不进结论**', async () => {
    const SECRET = 'sk-super-secret-value-do-not-leak'
    const r = await probeProvider('codex', deps({ envHas: (k) => k === 'OPENAI_API_KEY' }))
    // 用一个"会炸"的 env 访问器：模块只许问名字，不许读值
    const spyDeps = deps({ envHas: () => true })
    const r2 = await probeProvider('codex', spyDeps)
    const dumped = JSON.stringify(r) + JSON.stringify(r2)
    assert.ok(!dumped.includes(SECRET), '结论里出现了凭据值')
    assert.ok(!/\bsk-/.test(dumped), '结论里出现了看起来像 key 的串')
  })

  test('★ 探测超时/抛错 ⇒ unknown，**不猜**', async () => {
    const r1 = await probeProvider('codex', deps({ resolveOnPath: () => { throw new Error('boom') } }))
    assert.equal(r1.state, READINESS_STATE.MISSING_CLI, '解析抛错按"找不到"处理，比误判成可用安全')

    // execVersion 抛错：不影响"CLI 在"这个结论，只是没有版本号
    const r2 = await probeProvider('codex', deps({
      fileExists: () => true,
      execVersion: async () => { throw new Error('boom') },
    }))
    assert.equal(r2.state, READINESS_STATE.READY)
    assert.equal(r2.version, undefined, '拿不到版本就不写版本，不编一个')
  })
})

describe('批量探测与截止时间', () => {
  test('★ 超过总截止时间的那几个报 unknown，不是"不可用"', async () => {
    // 让**第一个** provider 耗掉超过 deadline 的时间（模拟一个慢探测），
    // 于是排在后面的那个连试都不试 —— 而它必须报 unknown 而不是 missing_cli。
    let t = 0
    const r = await probeProviders(['codex', 'claude-code'], {
      platform: 'linux',
      home: HOME,
      fileExists: () => false,
      envHas: () => false,
      pathValue: '/usr/local/bin',
      resolveOnPath: () => { t += 20_000; return null }, // 这一步很慢
      execVersion: async () => ({ ok: true, stdout: 'x 1.0.0' }),
      httpHead: async () => 'reachable',
      now: () => t,
    }, { deadlineMs: 12_000 })

    assert.equal(r.codex.state, READINESS_STATE.MISSING_CLI, '第一个该被真正探到')
    assert.equal(r['claude-code'].state, READINESS_STATE.UNKNOWN, '排在后面的必须报 unknown')
    assert.match(r['claude-code'].reason, /没有探测过/, 'unknown 必须说清"这次没探过"，避免被读成"不可用"')
  })

  test('同一个名字重复出现只探一次；空/缺省输入不炸', async () => {
    let calls = 0
    const r = await probeProviders(['codex', 'codex'], deps({
      resolveOnPath: () => { calls += 1; return null },
    }))
    assert.equal(calls, 1)
    assert.equal(Object.keys(r).length, 1)
    assert.deepEqual(await probeProviders([], deps()), {})
    assert.deepEqual(await probeProviders(undefined, deps()), {})
  })
})

describe('缓存壳子（纪律 ②：绝不阻塞心跳）', () => {
  test('★ 第一次 snapshot 立刻返回 null（不等人），后台刷新完成后才有值', async () => {
    let resolveProbe
    const gate = new Promise((r) => { resolveProbe = r })
    const cache = createReadinessCache({ probe: () => gate, ttlMs: 1000, now: () => 0 })
    const first = cache.snapshot(['codex'])
    assert.equal(first, null, '第一次必须是"还没有读数"，而不是阻塞等待')
    resolveProbe({ codex: { state: READINESS_STATE.READY } })
    await cache.settled()
    assert.deepEqual(cache.snapshot(['codex']), { codex: { state: READINESS_STATE.READY } })
  })

  test('★ TTL 内不重复探测；过期后才再探一次', async () => {
    let nowMs = 0
    let calls = 0
    const cache = createReadinessCache({
      probe: async () => { calls += 1; return { n: calls } },
      ttlMs: 1000,
      now: () => nowMs,
    })
    cache.snapshot(['a']); await cache.settled()
    cache.snapshot(['a']); await cache.settled()
    assert.equal(calls, 1, 'TTL 内不该再探')

    nowMs = 5000
    cache.snapshot(['a']); await cache.settled()
    assert.equal(calls, 2, '过期后应当重新探测')
  })

  test('探测抛错不把心跳带崩：缓存保持原值，错误交给 onError', async () => {
    const seen = []
    const cache = createReadinessCache({
      probe: async () => { throw new Error('probe failed') },
      now: () => 0,
      onError: (e) => seen.push(String(e)),
    })
    assert.doesNotThrow(() => cache.snapshot(['a']))
    await cache.settled()
    assert.equal(seen.length, 1)
    assert.equal(cache.snapshot(['a']), null, '从未成功过就仍然是"没有读数"')
  })
})

describe('PATH 解析与版本号', () => {
  test('★ 用的是**子进程真正拿到的** PATH（空 PATH 就是找不到）', () => {
    // "我 shell 里明明能跑" 与 "守护看不到" 是两件事 —— 这条钉住后者。
    // ⚠ 路径拼接与 PATH 分隔符都随平台变（Windows 用 `;` 与 `\`），所以夹具也按平台构造，
    //    不写死 POSIX 形状 —— 否则这条用例只在 Linux 上成立、在开发机上恒红。
    assert.equal(resolveOnPath('codex', '', { platform: 'linux' }), null)
    assert.equal(resolveOnPath('', '/a', { platform: 'linux' }), null, '空 bin 名不解析')

    const hit = join('/b', 'codex')
    const pathValue = ['/a', '/b'].join(delimiter)
    assert.equal(resolveOnPath('codex', pathValue, { platform: process.platform, exists: (p) => p === hit }), hit)

    // 找不到时返回 null（不是抛错）
    assert.equal(resolveOnPath('codex', pathValue, { platform: process.platform, exists: () => false }), null)
  })

  test('Windows 下试 .exe/.cmd 等扩展名', () => {
    const seen = []
    const got = resolveOnPath('codex', 'C:\\bin', {
      platform: 'win32',
      exists: (p) => { seen.push(p); return p === join('C:\\bin', 'codex.cmd') },
    })
    assert.equal(got, join('C:\\bin', 'codex.cmd'))
    assert.ok(seen.length > 1, '应当试过多个扩展名')
  })

  test('版本号只保留 x.y.z，其余输出（可能含路径）一律丢弃', () => {
    assert.equal(extractVersion('codex-cli 1.2.3'), '1.2.3')
    assert.equal(extractVersion('/usr/local/bin/tool v0.9.0-beta.1 (build abc)'), '0.9.0-beta.1')
    assert.equal(extractVersion('no version here'), undefined)
    assert.equal(extractVersion(undefined), undefined)
    // 关键：带路径的输出里，路径部分不许跟出来
    assert.ok(!String(extractVersion('/Users/someone/secret/path 2.0.0')).includes('secret'))
  })
})

describe('规格表本身', () => {
  test('内置 provider 的 spec 必须标成 native，外部 provider 必须给 CLI 与登录提示', () => {
    assert.equal(PROVIDER_SPECS.spawn.kind, 'native')
    for (const name of ['claude-code', 'codex']) {
      const spec = PROVIDER_SPECS[name]
      assert.equal(spec.kind, 'external', name)
      assert.ok(spec.cli, name + ' 必须声明要解析哪个可执行文件')
      assert.ok(spec.installHint, name + ' 必须给安装提示（否则用户不知道装什么）')
      assert.ok(spec.loginHint, name + ' 必须给登录提示')
      assert.ok((spec.authFiles ?? []).length + (spec.authEnvKeys ?? []).length > 0, name + ' 必须有至少一种登录态来源')
      assert.ok(spec.endpoint, name + ' 必须声明要探的端点')
      assert.ok(hasReadinessSpec(name))
    }
    assert.equal(hasReadinessSpec('not-a-provider'), false)
  })

  test('登录提示里写的是通用写法（~ 开头），不是本机路径', () => {
    for (const spec of Object.values(PROVIDER_SPECS)) {
      if (spec.kind !== 'external') continue
      for (const f of spec.authFiles ?? []) {
        assert.ok(!f.startsWith('/') && !/^[A-Za-z]:/.test(f), '登录文件必须是相对 HOME 的写法：' + f)
      }
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 类型面 `.d.mts` 与运行期导出的**一致性**（2026-10-13）
//
// 为什么单独一组：`.d.mts` 是**手写**的类型面，它自己不会过期 ——
// 过期了也没人报。仓库里已有同一形状的判据（`scripts/config/config.test.mjs` 的
// 「类型面 config.d.mts 与引擎导出集合一致（防类型文件悄悄过期）」）。
//
// ★ 两个方向的风险**不对称**，所以两个方向都要钉：
//   · **声明了但运行期没有**（phantom）：插件照样过类型检查，**运行期才炸**
//     —— `undefined is not a function`。这是危险的那一侧。
//   · **运行期有但没声明**：插件用不了它，但类型检查会拦下来，安全。
//
// ★ 而且本组**读插件真实的 import 语句**，不抄一份名单：
//   抄一份名单的话，插件明天多 import 一个名字，这组判据不会响 ——
//   那正是"跳过的不是通过"。
// ════════════════════════════════════════════════════════════════════════════

describe('类型面与运行期导出一致', () => {
  const ROOT = join(import.meta.dirname, '..', '..', '..')
  const MJS = join(ROOT, 'runtime', 'adapters', 'dsh', 'provider-readiness.mjs')
  const DTS = join(ROOT, 'runtime', 'adapters', 'dsh', 'provider-readiness.d.mts')
  const PLUGIN = join(ROOT, 'plugins', 'src', 'index.ts')

  const readText = (p) => readFileSync(p, 'utf8')

  /** 运行期导出名（`export function/const/class`；类型别名不算运行期导出）。 */
  function runtimeExports(src) {
    const out = new Set()
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1])
    return out
  }

  /** `.d.mts` 里 `export declare function/const` 声明的名字。 */
  function declaredRuntimeNames(src) {
    const out = new Set()
    for (const m of src.matchAll(/^export\s+declare\s+(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1])
    return out
  }

  /** 插件真实 import 的名单（从 `provider-readiness.mjs` 那一句里取）。 */
  function pluginImports(src) {
    const m = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*provider-readiness\.mjs['"]/.exec(src)
    assert.ok(m, 'plugins/src/index.ts 里应当有一句 import provider-readiness.mjs')
    return m[1].split(',').map(s => s.trim()).filter(Boolean)
  }

  test('★ 插件 import 的每个名字都**真实导出**（防 typo / 防被删掉）', () => {
    const exports_ = runtimeExports(readText(MJS))
    const imported = pluginImports(readText(PLUGIN))
    assert.ok(imported.length > 0)
    for (const name of imported) {
      assert.ok(exports_.has(name), `插件 import 了 ${name}，但 provider-readiness.mjs 没有导出它（运行期会是 undefined）`)
    }
  })

  test('★ 插件 import 的每个名字都在 `.d.mts` 里声明（否则插件悄悄失去类型）', () => {
    const declared = declaredRuntimeNames(readText(DTS))
    const declaredTypes = new Set(
      [...readText(DTS).matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]),
    )
    for (const name of pluginImports(readText(PLUGIN))) {
      assert.ok(declared.has(name) || declaredTypes.has(name),
        `.d.mts 没有声明 ${name}：插件会拿到隐式 any（或直接类型报错），而 .d.mts 自己不会喊`)
    }
  })

  test('★ 声明了但运行期没有 = 危险方向，必须为空', () => {
    const exports_ = runtimeExports(readText(MJS))
    for (const name of declaredRuntimeNames(readText(DTS))) {
      assert.ok(exports_.has(name),
        `.d.mts 声明了 ${name}，但 provider-readiness.mjs 没有这个运行期导出 —— ` +
        '插件会过类型检查、运行时才炸')
    }
  })

  test('★ `.d.mts` 不 import 任何 DSH 类型（适配器界线），且不出现本机路径', () => {
    // 🔴 必须先剥掉注释再判。第一版直接在原文上正则，于是这条**被它自己的文档注释判红**：
    //    `.d.mts` 的头注释里正好写着"本文件不得 import 任何 `@deepseek-ai/*` 类型"。
    //    同一个形状的假绿在本仓已有先例（`TC-S1-09b`：`JSON.stringify` 把 `"` 转义成 `\"`，
    //    于是 `src="http` 永远匹配不上、那条判据**恒绿**）。这里反过来是恒红，但病根一样：
    //
    //      一条在**自己的说明文字**上生效的判据，与一条在代码上生效的判据，
    //      在这段说明文字不存在的时候是同一个东西。
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const src = strip(readText(DTS))
    assert.ok(!/@deepseek-ai\//.test(src), '.d.mts 不得 import @deepseek-ai/* —— 那条界线只在 .mjs 的运行期')
    assert.ok(!/^\s*import\s/m.test(src), '.d.mts 应当零 import（用结构化声明）')
    assert.ok(!/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(src), '.d.mts 里不该出现具体机器路径')
    // 反向自检：确认这段注释**确实存在**（否则下一个人删掉它，上面三条就悄悄少了一层意思）
    assert.match(readText(DTS), /不得\*\*?\s*import/, '头注释里应当保留"不得 import"那句自我约束')
  })
})
