// product/process-manifest.test.mjs
// ============================================================================
// PRT-258 / PRT-701 输入：进程清单、启动波次与启动前校验。
//
// 本套用例的重点是**启动之前**就能判定的两类错误：
//   ① 清单本身不自洽（端口撞车、依赖成环、绑非回环地址、服务进程没有就绪判据）；
//   ② 声明的入口根本不存在——这类错误如果只在真机启动时才暴露，
//      表现会是「任务一直没人做」，而不是一条明确的错误。
//
// 另有一条用例把**已知缺口**钉死：`MANIFEST_KNOWN_GAPS` 必须与对真实仓库跑出来的
// 结果一致。缺口被补上时用例会红，逼着把清单和文档一起更新——
// 反向漂移（文档说没有、代码里其实有了）比漏做更难发现。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLayout } from './paths.mjs'
import {
  DEFAULT_PORTS,
  MANIFEST_KNOWN_GAPS,
  PROCESS_KEYS,
  PROCESS_SPECS,
  entryAbsolutePath,
  entryEscapesInstall,
  hasBlockingProcessDiagnostic,
  materializeProcessPlan,
  specFor,
  splitCommandLine,
  startupWaves,
  validateProcessPlan,
} from './process-manifest.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function baseLayout(overrides = {}) {
  const { layout } = resolveLayout({
    platform: 'win32',
    installDir: 'C:\\Legion',
    homeDir: 'C:\\Users\\me',
    workspaceDir: 'D:\\Projects',
    ...overrides,
  })
  return layout
}

function planFor(overrides = {}, opts = {}) {
  return materializeProcessPlan({ layout: baseLayout(overrides), nodePath: 'C:\\node\\node.exe', ...opts })
}

// ---------------------------------------------------------------- 声明面

test('清单声明：五个进程、键唯一、默认端口不与任何进程的类型矛盾', () => {
  assert.equal(PROCESS_KEYS.length, 5)
  assert.equal(new Set(PROCESS_KEYS).size, 5)
  for (const spec of PROCESS_SPECS) {
    assert.ok(spec.milestone, `${spec.key} 必须标注实现它的任务号`)
    assert.ok(spec.writesRoles.length > 0)
    assert.equal(spec.writesRoles.includes('install'), false, `${spec.key} 不得声明写入安装目录`)
    if (spec.kind === 'server') {
      assert.equal(typeof spec.defaultPort, 'number', `服务型进程 ${spec.key} 必须有默认端口`)
      assert.notEqual(spec.readiness.kind, 'none', `服务型进程 ${spec.key} 必须有就绪判据`)
    } else {
      assert.equal(spec.defaultPort, null)
      assert.equal(spec.readiness.kind, 'none')
    }
    assert.equal(specFor(spec.key).key, spec.key)
  }
})

test('materializeProcessPlan：命令、cwd、端口与就绪判据都被解析出来', () => {
  const plan = planFor()
  const hub = plan.processes.find((p) => p.key === 'team-hub')
  assert.equal(hub.command.file, 'C:\\node\\node.exe')
  assert.deepEqual([...hub.command.args], ['C:\\Legion\\team-hub\\server.mjs'])
  assert.equal(hub.cwd, 'C:\\Legion')
  assert.equal(hub.port, DEFAULT_PORTS['team-hub'])
  assert.equal(hub.url, `http://127.0.0.1:${DEFAULT_PORTS['team-hub']}`)
  assert.equal(hub.readiness.path, '/api/config')

  const wb = plan.processes.find((p) => p.key === 'workbench')
  assert.deepEqual([...wb.command.args], ['C:\\Legion\\workbench\\scripts\\serve.mjs', '--port', '5173'])

  // 端口可被产品配置覆盖；覆盖后 url 与参数一起跟着变
  const custom = planFor({}, { ports: { workbench: 6001 } })
  const wb2 = custom.processes.find((p) => p.key === 'workbench')
  assert.equal(wb2.port, 6001)
  assert.ok(wb2.command.args.includes('6001'))
  assert.equal(wb2.url, 'http://127.0.0.1:6001')
})

test('runtime 入口由配置提供：未配置必须报错，而不是「跳过该进程」', () => {
  const unresolved = planFor()
  assert.ok(unresolved.diagnostics.some((d) => d.code === 'ENTRY_UNRESOLVED' && d.process === 'runtime'))
  assert.equal(hasBlockingProcessDiagnostic(unresolved.diagnostics), true)

  const resolved = planFor({}, { runtimeCommand: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Legion\\dsh\\bin.mjs" web --port 3080' })
  const runtime = resolved.processes.find((p) => p.key === 'runtime')
  assert.equal(runtime.command.file, 'C:\\Program Files\\nodejs\\node.exe')
  assert.deepEqual([...runtime.command.args], ['C:\\Legion\\dsh\\bin.mjs', 'web', '--port', '3080'])
  assert.equal(resolved.diagnostics.length, 0)
})

test('splitCommandLine：支持引号，但不做任何 shell 展开', () => {
  assert.deepEqual(splitCommandLine('node "a b.mjs" --x'), ['node', 'a b.mjs', '--x'])
  assert.deepEqual(splitCommandLine("node 'a.mjs'"), ['node', 'a.mjs'])
  // `$VAR` / `%VAR%` 保持原样：展开会让「配置里写的」与「实际启动的」不再一一对应
  assert.deepEqual(splitCommandLine('node %LEGION_HOME%\\x.mjs'), ['node', '%LEGION_HOME%\\x.mjs'])
  assert.deepEqual(splitCommandLine('   '), [])
})

// ---------------------------------------------------------------- 启动波次

test('startupWaves：依赖在前、同波确定有序、结果可重复', () => {
  const plan = planFor({}, { runtimeCommand: 'node runtime.mjs' })
  const waves = plan.waves.map((w) => [...w])
  assert.deepEqual(waves, [['team-hub', 'runtime', 'whiteboard'], ['workbench', 'orchestrator']])
  // 同一输入两次运行必须给出完全相同的顺序
  assert.deepEqual(planFor({}, { runtimeCommand: 'node runtime.mjs' }).waves.map((w) => [...w]), waves)

  // 依赖确实排在前面
  const flat = waves.flat()
  for (const proc of plan.processes) {
    for (const dep of proc.dependsOn) {
      assert.ok(flat.indexOf(dep) < flat.indexOf(proc.key), `${dep} 必须在 ${proc.key} 之前`)
    }
  }
})

test('startupWaves：依赖成环时不死循环，并在校验阶段报 DEPENDENCY_CYCLE', () => {
  const scripts = [
    { key: 'a', dependsOn: ['b'] },
    { key: 'b', dependsOn: ['a'] },
  ]
  const waves = startupWaves(scripts)
  assert.ok(waves.flat().length <= 2, '成环不得导致无限循环')

  const plan = planFor()
  const broken = {
    processes: plan.processes.map((p) => (p.key === 'team-hub' ? { ...p, dependsOn: ['orchestrator'] } : p)),
    diagnostics: [],
  }
  // orchestrator 依赖 team-hub，team-hub 又依赖 orchestrator → 后者无法进入任何一波
  const diagnostics = validateProcessPlan(broken, { installRoot: null })
  assert.ok(diagnostics.some((d) => d.code === 'DEPENDENCY_CYCLE'), `实际：${diagnostics.map((d) => d.code).join(',')}`)
})

// ---------------------------------------------------------------- 启动前校验

test('validateProcessPlan：端口撞车、未知依赖、非回环绑定必须在启动前拦下', () => {
  const plan = planFor({}, { runtimeCommand: 'node runtime.mjs' })
  const broken = {
    processes: plan.processes.map((p) => {
      if (p.key === 'workbench') return { ...p, port: DEFAULT_PORTS['team-hub'], host: '0.0.0.0', dependsOn: ['ghost'] }
      return p
    }),
    diagnostics: [],
  }
  const diagnostics = validateProcessPlan(broken, { installRoot: null })
  const codes = diagnostics.map((d) => d.code)
  assert.ok(codes.includes('PORT_CONFLICT'), `实际：${codes.join(',')}`)
  assert.ok(codes.includes('UNKNOWN_DEPENDENCY'))
  assert.ok(codes.includes('NON_LOOPBACK_BIND'))
  assert.equal(hasBlockingProcessDiagnostic(diagnostics), true)
})

test('validateProcessPlan：installRoot 为 null 时报 ENTRY_NOT_VERIFIED，不假装通过', () => {
  const plan = planFor({}, { runtimeCommand: 'node runtime.mjs' })
  const diagnostics = validateProcessPlan(plan, { installRoot: null })
  assert.ok(diagnostics.some((d) => d.code === 'ENTRY_NOT_VERIFIED'))
})

test('validateProcessPlan：服务进程缺就绪判据 / 未声明 env / 声明写安装目录都是 error', () => {
  const plan = planFor({}, { runtimeCommand: 'node runtime.mjs' })
  const broken = {
    processes: plan.processes.map((p) => {
      if (p.key === 'team-hub') return { ...p, readiness: { kind: 'none' }, envNames: [], writesRoles: ['install'] }
      return p
    }),
    diagnostics: [],
  }
  const codes = validateProcessPlan(broken, { installRoot: null }).map((d) => d.code)
  assert.ok(codes.includes('READINESS_MISSING'))
  assert.ok(codes.includes('ENV_UNDECLARED'))
  assert.ok(codes.includes('WRITES_INSTALL_DIR'))
})

// ---------------------------------------------------------------- 真实仓库对账

test('已知缺口被钉死：对真实仓库跑校验，error 集合必须等于 MANIFEST_KNOWN_GAPS', () => {
  const { layout } = resolveLayout({
    platform: process.platform,
    installDir: REPO_ROOT,
    homeDir: REPO_ROOT,
    workspaceDir: REPO_ROOT,
  })
  const plan = materializeProcessPlan({ layout, nodePath: process.execPath })
  const diagnostics = validateProcessPlan(plan, { installRoot: REPO_ROOT, exists: (p) => existsSync(p) })
  const actual = diagnostics
    .filter((d) => d.severity === 'error' && (d.code === 'ENTRY_MISSING' || d.code === 'ENTRY_UNRESOLVED'))
    .map((d) => `${d.code}:${d.process}`)
    .sort()
  const expected = MANIFEST_KNOWN_GAPS.map((g) => `${g.code}:${g.process}`).sort()
  assert.deepEqual(actual, expected,
    '缺口集合变了：要么补上真实入口并同步 MANIFEST_KNOWN_GAPS 与文档，要么解释为什么多出来一个错误')
})

test('entryAbsolutePath / entryEscapesInstall：`../` 逃出安装目录要能被发现', () => {
  const plan = planFor({}, { runtimeCommand: 'node runtime.mjs' })
  const hub = plan.processes.find((p) => p.key === 'team-hub')
  assert.equal(entryAbsolutePath(hub, 'C:\\Legion', 'win32'), 'C:\\Legion\\team-hub\\server.mjs')
  assert.equal(entryEscapesInstall(hub, 'C:\\Legion', 'win32'), false)

  const escaped = { ...hub, entryPath: '..\\..\\evil.mjs' }
  assert.equal(entryEscapesInstall(escaped, 'C:\\Legion\\tools', 'win32'), true)
  assert.equal(entryAbsolutePath(plan.processes.find((p) => p.key === 'runtime'), 'C:\\Legion', 'win32'), null)
})
