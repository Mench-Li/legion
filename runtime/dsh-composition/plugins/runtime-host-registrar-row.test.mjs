// runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs
// ============================================================================
// PRT-253（续批二）：生产注册方的**单元**读数。
//
// 这一套**不启动 DSH**（真进程那部分在 `runtime-host-registrar-row-dsh-process.test.mjs`）。
// 它逐条钉住四件事：
//
//   A. **版本**只来自"正在跑的那份安装"，读不到就报 null（fail closed）——
//      而且**不会**把路上遇到的别的 `package.json`（比如 Legion 自己的）当成引擎版本；
//   B. 四项能力**逐项**的判据：一项读现场 provider 注册表，三项按**未确认**报，
//      每项一个**互不相同**的码；
//   C. 工厂的**具名拒绝**：没有 ctx / 没有 `subagents` 各自一个码；
//      `canRead` **缺席是合法的**（如实记成 `null`），只有"挂一个不是函数的"
//      才拒（`NO_CAN_READ_SOURCE`）；
//   C2. `currentModelSelection` 的来源：`agentDefaultModel` 服务在 → 原样带出；
//      不在 / 形状不对 / 返回值不是对象 → `null`，三个码分得开，**绝不编模型名**；
//   D. 注册形状：默认导出与 `runtime-host-row.mjs` 的 default 是**同一个对象**（`===`），
//      且注册发生在**模块求值期**（import 完就已经在缝上了）。
//
// 测试形状纪律：只断言**具名码 / 具体值**，不写"它抛了"；两个必须区分开的读数
// 就断言它们**不同**；每条断言在把对应实现删掉时会红。
// ============================================================================

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, describe, test } from 'node:test'

import { REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import realRuntimeHostRow, {
  CAPABILITY_EVIDENCE_CODES,
  CAPABILITY_TABLE_CHECKED,
  DSH_PACKAGE_NAMES,
  DSH_VERSION_CODES,
  MODEL_SELECTION_CODES,
  RUNTIME_HOST_REGISTRAR_CODES,
  RUNTIME_HOST_REGISTRAR_VERSION,
  createRuntimeHostInputsFactory,
  dshInstallCandidates,
  probeDshRuntime,
  readDshVersionOfInstall,
  readModelSelection,
  registeredRuntimeHostInputsFactory,
  runtimeCapabilityEvidence,
} from './runtime-host-registrar-row.mjs'
import {
  RUNTIME_HOST_ROW_PLUGIN_NAME,
  dshRuntimeInputsFactory,
  setDshRuntimeInputsFactory,
} from './runtime-host-row.mjs'
import rowModuleDefault from './runtime-host-row.mjs'

const SCRATCH = mkdtempSync(join(resolve(tmpdir()), 'legion-host-registrar-'))
after(() => rmSync(SCRATCH, { recursive: true, force: true }))

/**
 * 向上找的层数在用例里收紧到 3。
 *
 * 默认值是 8，而 `tmpdir()` 上面还有好几层真实目录——某台机器的 `%TEMP%` 之上
 * 恰好有一份 DSH 检出时，"读不到"这类反向断言就会偶发地红。
 * 收紧层数让"只在这份假安装内部找"成为用例的**断言前提**，而不是环境巧合。
 */
const DEPTH = 3

/** 造一个临时"安装"：`<root>/<segments...>/package.json`，返回可当候选入口的路径。 */
function fakeInstall(segments, pkg) {
  const dir = join(SCRATCH, ...segments)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg, null, 2) + '\n')
  return join(dir, 'lib', 'bin.js')
}

// ─────────────────────────────────────────────── A. 版本来源

describe('PRT-253 续批二 · 版本只来自现场那份安装', () => {
  test('从候选入口向上找到 `@deepseek-ai/dsh` 的 version（读到的是文件里的值）', () => {
    const entry = fakeInstall(['inst-a', 'apps', 'cli'], { name: '@deepseek-ai/dsh', version: '9.9.9-probe' })
    const r = readDshVersionOfInstall({ candidates: [entry], maxDepth: DEPTH })
    assert.equal(r.ok, true)
    assert.equal(r.code, DSH_VERSION_CODES.READ)
    assert.equal(r.version, '9.9.9-probe')
    assert.equal(r.packageName, '@deepseek-ai/dsh')
    assert.match(r.source, /package\.json$/)
  })

  test('根工作区那份（`@deepseek-ai/dsh-root`）也认', () => {
    const entry = fakeInstall(['inst-b', 'apps', 'cli'], { name: '@deepseek-ai/dsh-root', version: '3.2.1' })
    const r = readDshVersionOfInstall({ candidates: [entry], maxDepth: DEPTH })
    assert.equal(r.ok, true)
    assert.equal(r.version, '3.2.1')
    assert.equal(r.packageName, '@deepseek-ai/dsh-root')
  })

  test('★ 路上遇到**别的** package.json 不当代替：那个版本不会被读出来', () => {
    // 只有一份 Legion 自己的 package.json，向上再没有别的东西。
    const entry = fakeInstall(['foreign', 'apps', 'cli'], { name: 'legion-product', version: '0.0.1' })
    const r = readDshVersionOfInstall({ candidates: [entry], maxDepth: DEPTH })
    assert.equal(r.ok, false)
    assert.equal(r.code, DSH_VERSION_CODES.NOT_FOUND)
    assert.equal(r.version, null, '读不到版本必须报 null，不能报一个"就近的"版本号')
    assert.ok(r.searched > 0, '要真的去读过（否则这条断言对"没实现"也成立）')
  })

  test('版本字段缺失 / 空串 → MALFORMED + version null（**不编一个版本**）', () => {
    let n = 0
    for (const pkg of [{ name: '@deepseek-ai/dsh' }, { name: '@deepseek-ai/dsh', version: '' }]) {
      n += 1
      const entry = fakeInstall([`mal-${n}`, 'apps', 'cli'], pkg)
      const r = readDshVersionOfInstall({ candidates: [entry], maxDepth: DEPTH })
      assert.equal(r.ok, false)
      assert.equal(r.code, DSH_VERSION_CODES.MALFORMED)
      assert.equal(r.version, null)
    }
  })

  test('package.json 内容坏了 → 跳过它继续向上，而不是当成"没有版本"却报错退出', () => {
    const entry = fakeInstall(['broken', 'apps', 'cli'], '{ 这不是 JSON')
    const r = readDshVersionOfInstall({ candidates: [entry], maxDepth: DEPTH })
    assert.equal(r.ok, false)
    assert.equal(r.code, DSH_VERSION_CODES.NOT_FOUND)
  })

  test('`probeDshRuntime` 在版本读不到时报 `version: null`（fail closed 交给 probe.mjs 判不兼容）', () => {
    const entry = fakeInstall(['absent', 'apps', 'cli'], { name: 'other', version: '1.0.0' })
    const probe = probeDshRuntime(null, {
      readVersion: (o) => readDshVersionOfInstall({ ...o, candidates: [entry], maxDepth: DEPTH }),
    })
    assert.equal(probe.version, null)
    assert.equal(probe.versionEvidence.code, DSH_VERSION_CODES.NOT_FOUND)
  })

  test('候选来自进程入口与加载器树（两处都进列表，去重）', () => {
    // 加载器树里的名字在真进程里是**绝对** file URL；这里也造一个绝对路径的
    // file URL（Windows 上 `file:///y/...` 不是绝对路径，会被如实拒收——那是对的）。
    const loaderPath = join(SCRATCH, 'loader-row.mjs')
    const names = dshInstallCandidates({
      argvEntry: '/x/apps/cli/lib/bin.js',
      ctx: {
        get: (n) => (n === 'loader'
          ? {
            entries: () => [
              { options: { name: '/x/apps/cli/lib/bin.js' } },
              { options: { name: pathToFileURL(loaderPath).href } },
            ],
          }
          : undefined),
      },
    })
    assert.equal(names[0], '/x/apps/cli/lib/bin.js', '进程入口是第一候选（原样，解析留给读版本那一步）')
    assert.ok(names.some((p) => p === loaderPath), '加载器树里的 file:// 名字要转回路径并进候选')
    assert.equal(new Set(names).size, names.length, '候选要去重')
  })

  test('不是绝对的 file URL（Windows 上 `file:///y/x` 这种）**不**进候选', () => {
    const names = dshInstallCandidates({
      argvEntry: '/x/apps/cli/lib/bin.js',
      ctx: { get: (n) => (n === 'loader' ? { entries: () => [{ options: { name: 'file:///y/other.mjs' } }] } : undefined) },
    })
    // Windows 上 fileURLToPath 会拒收；POSIX 上它会转成 /y/other.mjs。
    // 两种平台的结论都是"不是这份安装的候选"——关键是读版本那一步**不会**炸。
    const r = readDshVersionOfInstall({ candidates: names, maxDepth: 1 })
    assert.equal(r.ok, false)
    assert.equal(r.version, null)
  })
})

// ─────────────────────────────────────────────── B. 四项能力的判据

/** 一个只有 `list` / `getProvider` 的注册表替身——**它替的是现场服务，不替判据**。 */
function registry(providers) {
  return {
    list: () => providers.map((p) => p.name),
    getProvider: (n) => providers.find((p) => p.name === n),
  }
}

const ctxWith = (services) => ({ get: (n) => services[n] })

describe('PRT-253 续批二 · 四项能力逐项有据', () => {
  test('现场唯一 provider 自报 outputSchema:true → structured-result 具备（判据码是"注册表确认"）', () => {
    const { capabilities, evidence } = runtimeCapabilityEvidence(
      ctxWith({ subagents: registry([{ name: 'spawn', capabilities: { outputSchema: true } }]) }))
    assert.equal(capabilities['structured-result'], true)
    assert.equal(evidence['structured-result'].code, CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_CONFIRMS)
  })

  test('★ 同一个 provider 自报 outputSchema:false → 那一项**不**具备（两个读数必须不同）', () => {
    const off = runtimeCapabilityEvidence(
      ctxWith({ subagents: registry([{ name: 'spawn', capabilities: { outputSchema: false } }]) }))
    assert.equal(off.capabilities['structured-result'], false)
    assert.equal(off.evidence['structured-result'].code, CAPABILITY_EVIDENCE_CODES.PROVIDER_LACKS_OUTPUT_SCHEMA)
    const on = runtimeCapabilityEvidence(
      ctxWith({ subagents: registry([{ name: 'spawn', capabilities: { outputSchema: true } }]) }))
    assert.notEqual(off.evidence['structured-result'].code, on.evidence['structured-result'].code,
      '两个方向必须报不同的码，否则"读注册表"与"写死一个值"分不开')
  })

  test('注册表不在 / 空 / 多于一个 provider → 一律未确认，且码互不相同', () => {
    const absent = runtimeCapabilityEvidence(ctxWith({}))
    const empty = runtimeCapabilityEvidence(ctxWith({ subagents: registry([]) }))
    const many = runtimeCapabilityEvidence(ctxWith({
      subagents: registry([{ name: 'spawn', capabilities: { outputSchema: true } },
        { name: 'acp', capabilities: { outputSchema: true } }]),
    }))
    assert.equal(absent.evidence['structured-result'].code, CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_ABSENT)
    assert.equal(empty.evidence['structured-result'].code, CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_ABSENT)
    assert.equal(many.evidence['structured-result'].code, CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_AMBIGUOUS)
    assert.equal(absent.capabilities['structured-result'], false)
    assert.equal(many.capabilities['structured-result'], false, '说不清用哪个 provider 时不挑一个')
  })

  test('另外三项：未确认，各自一个说得清"为什么"的码', () => {
    const { capabilities, evidence } = runtimeCapabilityEvidence(ctxWith({}))
    assert.equal(capabilities['tool-permission-enforcement'], false)
    assert.equal(evidence['tool-permission-enforcement'].code, CAPABILITY_EVIDENCE_CODES.ENFORCEMENT_PLANE_MEASURED_ELSEWHERE)
    assert.equal(capabilities['cancel-and-timeout'], false)
    assert.equal(evidence['cancel-and-timeout'].code, CAPABILITY_EVIDENCE_CODES.CANCEL_NOT_GUARANTEED_BY_ENGINE)
    assert.equal(capabilities['usage-reporting'], false)
    assert.equal(evidence['usage-reporting'].code, CAPABILITY_EVIDENCE_CODES.RESULT_CONTRACT_HAS_NO_USAGE)
  })

  test('能力表**恰好**是产品的必需清单（多一项 / 少一项都会让探针读错）', () => {
    const { capabilities, evidence } = runtimeCapabilityEvidence(null)
    assert.deepEqual(Object.keys(capabilities).sort(), [...REQUIRED_CAPABILITIES].sort())
    assert.deepEqual(Object.keys(evidence).sort(), [...REQUIRED_CAPABILITIES].sort())
    assert.equal(CAPABILITY_TABLE_CHECKED, true)
    // 2 = `canRead` 改为可选（缺席如实记成 null）+ 接上 `currentModelSelection`。
    assert.equal(RUNTIME_HOST_REGISTRAR_VERSION, 2)
  })

  test('布尔表里只有布尔值：判据码不会被混进 capabilities（probe.mjs 会把非 true 当 false）', () => {
    const { capabilities } = runtimeCapabilityEvidence(
      ctxWith({ subagents: registry([{ name: 'spawn', capabilities: { outputSchema: true } }]) }))
    for (const [k, v] of Object.entries(capabilities)) {
      assert.equal(typeof v, 'boolean', `${k} 必须是布尔（真值是 ${JSON.stringify(v)}）`)
    }
  })

  test('`probeDshRuntime` 的 payload 同时带能力布尔表与判据（判据不参与 probe.mjs 的判定）', () => {
    const entry = fakeInstall(['probe-shape', 'apps', 'cli'], { name: '@deepseek-ai/dsh', version: '1.4.0' })
    const probe = probeDshRuntime(ctxWith({ subagents: registry([{ name: 'spawn', capabilities: { outputSchema: true } }]) }), {
      readVersion: (o) => readDshVersionOfInstall({ ...o, candidates: [entry], maxDepth: DEPTH }),
    })
    assert.equal(probe.version, '1.4.0')
    assert.equal(probe.capabilities['structured-result'], true)
    assert.equal(probe.capabilities['usage-reporting'], false)
    assert.equal(probe.capabilityEvidence['usage-reporting'].code, CAPABILITY_EVIDENCE_CODES.RESULT_CONTRACT_HAS_NO_USAGE)
  })
})

// ─────────────────────────────────────────────── C. 工厂的具名拒绝

const SUBAGENTS = { start: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }) }

describe('PRT-253 续批二 · 工厂：缺哪一样报哪一样', () => {
  const factory = createRuntimeHostInputsFactory()

  test('没有 ctx → NO_CONTEXT', () => {
    assert.throws(() => factory(null), (e) => e.code === RUNTIME_HOST_REGISTRAR_CODES.NO_CONTEXT)
  })

  test('ctx 在、没有 `subagents` 服务 → NO_SUBAGENTS_PORT', () => {
    assert.throws(() => factory({ get: () => undefined }),
      (e) => e.code === RUNTIME_HOST_REGISTRAR_CODES.NO_SUBAGENTS_PORT)
  })

  test('★ `subagents` 在、**没有** canRead 来源 → 工厂成功，缺席被如实记成 `null`', () => {
    // ★ 这条是本批改掉的那条要求：缺席**不再**是一条例外。
    //   断言的不是"它不抛"（那太弱），而是那个缺席的**读数值**：
    //   `null` 与 `undefined`（= 忘了写这个键）、与 `() => true`（= 默认放行）、
    //   与 `() => false`（= 默认拒绝）都必须分得开。
    const built = factory({ get: (n) => (n === 'subagents' ? SUBAGENTS : undefined) })
    assert.equal(built.canRead, null, `缺席必须原样交成 null，实际 ${JSON.stringify(built.canRead)}`)
    assert.equal('canRead' in built, true, '这个键必须在场（undefined 与"忘了写"同形）')
    assert.notEqual(typeof built.canRead, 'function', 'canRead 不许是一个替身函数')
    assert.equal(typeof built.runtimeHost.startRun, 'function')
    assert.equal(typeof built.runtimeHost.probeRuntime, 'function')
  })

  test('三个码互不相同（"没装服务"与"挂了个坏的 canRead"的修法不是一件事）', () => {
    const codes = new Set([
      RUNTIME_HOST_REGISTRAR_CODES.NO_CONTEXT,
      RUNTIME_HOST_REGISTRAR_CODES.NO_SUBAGENTS_PORT,
      RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE,
    ])
    assert.equal(codes.size, 3)
    assert.notEqual(RUNTIME_HOST_REGISTRAR_CODES.NO_SUBAGENTS_PORT, RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE)
  })

  test('`canRead` 给的不是函数也不是 null/undefined → 当场拒绝（"挂了个坏的"与"明确没有来源"要分得开）', () => {
    for (const bad of ['yes', 42, {}, []]) {
      assert.throws(() => createRuntimeHostInputsFactory({ canRead: bad }),
        (e) => e.code === RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE,
        `canRead=${JSON.stringify(bad)} 必须被拒（静默丢掉它会让"有人试图挂它"消失）`)
    }
  })

  test('给全了 → 端口**按引用**转发真实服务，canRead 原样带出', () => {
    const handle = { result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} }
    const calls = []
    const subagents = { async start(provider, options) { calls.push({ provider, options }); return handle } }
    const canRead = () => ({ all: true })
    const built = createRuntimeHostInputsFactory({ canRead })({ get: (n) => (n === 'subagents' ? subagents : undefined) })
    assert.equal(built.canRead, canRead, 'canRead 必须按引用带出，不能包一层')
    const sent = { label: 'x', prompt: [{ type: 'text', text: 'y' }] }
    return built.runtimeHost.startRun('spawn', sent).then((got) => {
      assert.equal(got, handle, 'startRun 必须把服务返回的句柄按引用交出去')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].provider, 'spawn')
      assert.equal(calls[0].options, sent)
    })
  })

  test('`probeRuntime` 用注入的版本读法（于是"版本从哪来"可以在不碰盘的情况下驱动）', () => {
    const built = createRuntimeHostInputsFactory({
      canRead: () => ({ all: true }),
      readVersion: () => ({ ok: true, code: DSH_VERSION_CODES.READ, version: '7.7.7' }),
    })({ get: (n) => (n === 'subagents' ? SUBAGENTS : undefined) })
    const probe = built.runtimeHost.probeRuntime()
    assert.equal(probe.version, '7.7.7')
    assert.equal(probe.capabilities['structured-result'], false, '没有注册表时这一项仍然是未确认')
  })
})

// ─────────────────────────────────────────────── C2. `currentModelSelection` 的来源

/**
 * 一个 `agentDefaultModel` 的一等服务**替身**。
 *
 * 它替的是**现场服务**，不是被测的那条读法：形状照 DSH 的
 * `packages/core/agent-default-model/src/index.ts` 的 `currentSelection()`
 * （`{provider, model, reasoningEffort?}`）。
 */
function modelService(selection) {
  const calls = []
  return {
    calls,
    service: {
      currentSelection() { calls.push(1); return selection },
    },
  }
}

describe('PRT-253 续批二 · `currentModelSelection` 从 `agentDefaultModel` 读', () => {
  test('★ 服务在 → 端口把它的选择**原样**（按引用）交出来，一个字段都不搬', () => {
    const { service } = modelService({ provider: 'stub-provider', model: 'stub-model', reasoningEffort: 'high' })
    const raw = service.currentSelection()
    const built = createRuntimeHostInputsFactory()({
      get: (n) => (n === 'subagents' ? SUBAGENTS : n === 'agentDefaultModel' ? service : undefined),
    })
    const got = built.runtimeHost.currentModelSelection()
    // 判据是**按引用同一个对象**：搬一遍字段就说明这里有一份会漂移的副本，
    // 而"两个形状对不上"会在某一天变成一次静默的字段丢失。
    assert.equal(got, raw, '端口没有原样交出服务给的那个对象（搬了字段或包了一层）')
    assert.deepEqual(got, { provider: 'stub-provider', model: 'stub-model', reasoningEffort: 'high' })
  })

  test('★ 服务不在 → `null`，判据码是"服务缺席"，**绝不编一个模型名**', () => {
    const ctx = { get: (n) => (n === 'subagents' ? SUBAGENTS : undefined) }
    const reading = readModelSelection(ctx)
    assert.equal(reading.selection, null)
    assert.equal(reading.code, MODEL_SELECTION_CODES.SERVICE_ABSENT)
    const built = createRuntimeHostInputsFactory()(ctx)
    assert.equal(built.runtimeHost.currentModelSelection(), null)
    // `undefined` 与"服务在但没给东西"同形；这里必须是 `null`。
    assert.equal(built.runtimeHost.currentModelSelection() === null, true)
  })

  test('★ 三个"没有"必须分得开：服务不在 / 服务形状不对 / 返回值不是对象', () => {
    const absent = readModelSelection({ get: () => undefined })
    const malformedService = readModelSelection({ get: (n) => (n === 'agentDefaultModel' ? {} : undefined) })
    const malformedResult = readModelSelection({ get: (n) => (n === 'agentDefaultModel' ? { currentSelection: () => 'deepseek-flash' } : undefined) })
    assert.equal(absent.code, MODEL_SELECTION_CODES.SERVICE_ABSENT)
    assert.equal(malformedService.code, MODEL_SELECTION_CODES.SERVICE_MALFORMED)
    assert.equal(malformedResult.code, MODEL_SELECTION_CODES.RESULT_MALFORMED)
    assert.equal(new Set([absent.code, malformedService.code, malformedResult.code]).size, 3,
      '三个成因报同一个码——"去装基础组合层"与"去看引擎版本"就分不开了')
    for (const r of [absent, malformedService, malformedResult]) {
      assert.equal(r.selection, null, '三种"没有"都不许编一个模型选择')
      assert.equal(r.ok, false)
    }
  })

  test('服务给的选择原样带出（`ok: true` + 那个码），与"没有"是两个读数', () => {
    const { service } = modelService({ provider: 'deepseek-official', model: 'deepseek-flash' })
    const reading = readModelSelection({ get: (n) => (n === 'agentDefaultModel' ? service : undefined) })
    assert.equal(reading.ok, true)
    assert.equal(reading.code, MODEL_SELECTION_CODES.SERVICE_READ)
    assert.deepEqual(reading.selection, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.notEqual(reading.code, MODEL_SELECTION_CODES.SERVICE_ABSENT)
  })

  test('服务自己抛错 → **让它抛**（吞掉会把"坏了"读成"没有"）', () => {
    const broken = { currentSelection() { throw new Error('settings 服务挂了') } }
    assert.throws(
      () => readModelSelection({ get: (n) => (n === 'agentDefaultModel' ? broken : undefined) }),
      /settings 服务挂了/,
      '服务抛错被吞掉了——适配器那条 MODEL_UNAVAILABLE 的真因就没了')
  })
})

// ─────────────────────────────────────────────── D. 注册形状（与审批注册方同形）

describe('PRT-253 续批二 · 注册在模块求值期，交出去的是真对象', () => {
  test('默认导出与 `runtime-host-row.mjs` 的 default 是**同一个对象**', () => {
    assert.equal(realRuntimeHostRow, rowModuleDefault)
    assert.equal(typeof realRuntimeHostRow.apply, 'function')
    assert.equal(realRuntimeHostRow.name, RUNTIME_HOST_ROW_PLUGIN_NAME)
  })

  test('import 完就已经注册好了：缝上那个工厂就是本模块注册的那一个', () => {
    assert.notEqual(dshRuntimeInputsFactory(), null, '注册必须发生在模块求值期（不然"靠行序"）')
    assert.equal(dshRuntimeInputsFactory(), registeredRuntimeHostInputsFactory)
  })
})

// ─────────────────────────────────────────────── E. 工厂收到的是**这一行**的 ctx

describe('PRT-253 续批二 · 工厂拿得到本行 `apply` 的现场', () => {
  test('本行把自己的 Context 交给工厂（按引用），不是 `undefined`、也不是新的假 Context', async () => {
    // 最小 ctx：只实现本行用到的那几面（与 runtime-host-row.test.mjs 的假件同形）。
    const services = new Map([
      ['loader', { entries: () => [{ options: { id: 'legion-runtime-host', name: 'file:///x.mjs' } }] }],
      ['sandbox', { confine: async () => ({ level: 'full' }) }],
      ['legionEnforcementRoot', {
        ok: true,
        code: null,
        message: null,
        root: {
          async bootstrap() {
            return { ok: true, state: 'enforcement-effective', patchVersion: 1, checks: [], unbind: () => true }
          },
        },
      }],
    ])
    const ctx = {
      get: (n) => (services.has(n) ? services.get(n) : undefined),
      provide() {},
      effect() { return () => {} },
    }
    let seen = null
    const undo = setDshRuntimeInputsFactory((c) => {
      seen = c
      throw Object.assign(new Error('捕获到 ctx 就停'), { code: 'TEST_CAPTURE' })
    })
    try {
      await assert.rejects(() => realRuntimeHostRow.apply(ctx),
        (e) => e.code === 'RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW')
    } finally {
      undo()
    }
    assert.equal(seen, ctx, '工厂必须收到本行这一侧的**同一个** Context（===），而不是 undefined 或替身')
  })
})

// 让"到底有几个包名算引擎安装"这条口径可被读出来（避免它悄悄退化成一个包名）。
test('DSH_PACKAGE_NAMES 仍然认 CLI 包与根工作区两个名字', () => {
  assert.deepEqual([...DSH_PACKAGE_NAMES], ['@deepseek-ai/dsh', '@deepseek-ai/dsh-root'])
})
