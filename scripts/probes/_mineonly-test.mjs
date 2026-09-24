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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLayout } from '../../product/paths.mjs'
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
} from '../../product/process-manifest.mjs'

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

  // ★ PRT-251 续：`runtime.command` 里**不再**自带 `--port`——端口归 `ports.runtime` 管，
  //   由计划在末尾补上（理由见下一条用例）。
  const resolved = planFor({}, { runtimeCommand: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Legion\\dsh\\bin.mjs" --profile web' })
  const runtime = resolved.processes.find((p) => p.key === 'runtime')
  assert.equal(runtime.command.file, 'C:\\Program Files\\nodejs\\node.exe')
  assert.deepEqual([...runtime.command.args],
    ['C:\\Legion\\dsh\\bin.mjs', '--profile', 'web', '--port', '3080'])
  assert.equal(resolved.diagnostics.length, 0)
})

test('★★★ PRT-251 续：端口进 argv，且**在所有 launcher 旗标之后**', () => {
  // 这一条盯的是本缺口真正的坑（文档 §3），**不是**「argv 里有没有 --port」：
  // DSH 的命令行是「launcher 段 + app 段」，它的解析器遇到第一个不认识的 token
  // 就停止解析自己的旗标。所以一旦 `--port` 跑到 `--patch` 前面，
  // `--patch <覆盖层>` 就落进了 app 段——**强制面补丁层静默消失**，而启动照样成功。
  const plan = planFor({}, {
    runtimeCommand: 'node bin.js --profile web',
    ports: { runtime: 3081 },
    extraArgs: { runtime: ['--patch', 'legion-host.patch.yml'] },   // 真实形状：extraArgs 就是覆盖层
  })
  const args = [...plan.processes.find((p) => p.key === 'runtime').command.args]

  assert.deepEqual(args, ['bin.js', '--profile', 'web', '--patch', 'legion-host.patch.yml', '--port', '3081'])

  // ★ 顺序断言（不是 includes）：`--patch` 必须**早于** `--port`。
  //   一个只断言两个都在的用例对这个坑完全不敏感——它们的 argv 里两个都在，
  //   只不过那时 `--patch` 已经不在 launcher 段里了。
  assert.ok(args.indexOf('--patch') < args.indexOf('--port'),
    `--patch 跑到了 --port 后面，于是它变成 app 参数、覆盖层静默失效：${JSON.stringify(args)}`)
  // 端口的值就是 ports.runtime（不是 DEFAULT_PORTS.runtime）
  assert.equal(args[args.indexOf('--port') + 1], '3081', '端口不是 ports.runtime 那个值')
  // 对面的控制：`--profile` 仍在最前（它也是 launcher 旗标）
  assert.ok(args.indexOf('--profile') < args.indexOf('--patch'))
})

test('★★★ `node-file` 分支的段顺序：`extras` 必须在 `appArgs` 之前（**今天行为上验不出来**）', () => {
  // ## 为什么这条只能写成源码级断言
  //
  // `materializeProcessPlan()` 有**两个**拼 argv 的地方：
  //
  //   · `spec.entry.kind === 'node-file'`  → `[entryAbs, ...args, ...extras, ...appArgs]`
  //   · 配了 `runtime.command`             → `[...configured.args, ...args, ...extras, ...valueArgs, ...boolArgs]`
  //
  // 上面那条用例走的是**后者**（它传了 `runtimeCommand`）。实测：把**前者**的
  // `extras` 与 `appArgs` 对调，`process-manifest.test.mjs` 与
  // `dsh-overlay.test.mjs` **全部全绿**。
  //
  // 原因是清单里的读数：
  //
  // ```text
  // team-hub      entry=node-file   portArgv=null hostArgv=null boolArgv=null
  // workbench     entry=node-file   同上
  // orchestrator  entry=node-file   同上
  // whiteboard    entry=node-file   同上
  // runtime       entry=configured  portArgv=["--port"] hostArgv=["--host"] boolArgv=["--no-open"]
  // ```
  //
  // **只有 `runtime` 声明了 app 族旗标，而它走的是另一条分支。**
  // 于是 `node-file` 分支上 `appArgs` **恒为空数组**，对调两个段得到同一条 argv——
  // 那条规矩在那条分支上**今天没有可观察的对象**。
  //
  //   > 一个"只在今天恰好被走到的分支上成立"的不变式，
  //   > 与一个全局成立的不变式，在用例上是同一个东西——
  //   > 只不过前者的保护范围会随着**某天有人给 team-hub 加一个 `--port`**
  //   > 而悄悄缩到零。
  //
  // 所以这里退一步，把规矩**按源码**钉住：顺序写死成 `extras` 在前。
  // 这条断言在"有人以为两段可以随便排"时会红——而那正是它要防的事。
  const SRC = readFileSync(new URL('./process-manifest.mjs', import.meta.url), 'utf8')
  const m = /Object\.freeze\(\[entryAbs,([^\]]*)\]\)/.exec(SRC)
  assert.ok(m !== null, '`node-file` 分支的 argv 拼装那一行找不到了——先更新这一条')
  const order = m[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
  // ★ 这里**不写死变量名**：`portArgs`（PRT-251 续批当时的形状）与
  //   `appArgs`（后来把 host / port / 开关三族合成一段之后的形状）都出现过。
  //   钉的是**不变式**——`extras`（launcher 放进来的旗标，含 `--patch`）
  //   必须排在**任何** app 段 spread 之前。
  const extrasAt = order.indexOf('...extras')
  assert.ok(extrasAt >= 0, `argv 拼装里没有 \`...extras\`：${JSON.stringify(order)}`)
  const APP_SEG = /^\.\.\.(appArgs|portArgs|hostArgs|boolArgs|effectiveValueArgs|effectiveBoolArgs)$/
  let appSegs = 0
  for (const seg of order) {
    if (!APP_SEG.test(seg)) continue
    appSegs++
    assert.ok(extrasAt < order.indexOf(seg),
      `\`${seg}\` 排到了 \`...extras\` 前面（顺序 ${JSON.stringify(order)}）。`
      + 'launcher 放进去的旗标（含 `--patch`）必须排在 app 段之前——'
      + 'DSH 的解析器一旦进 app 段，后面的 `--patch` 就会被当成 app 参数，'
      + '覆盖层**静默失效**而启动成功。')
  }
  // 反向控制：这条分支上**必须**至少有一个 app 段，否则上面那个循环是空转，
  // 而"空转的循环"与"检查通过了"在读数上是同一个东西。
  assert.ok(appSegs > 0,
    `\`node-file\` 分支的拼装里一个 app 段 spread 都没有（${JSON.stringify(order)}）——`
    + '这条不变式今天没有对象，请说明为什么。')

  // 顺带把"今天为什么验不出来"也变成读数：只要没有一个 node-file 进程声明 app 族旗标，
  // 上面那条不变式就只能靠源码钉。
  const withAppFlags = PROCESS_SPECS.filter((s) => s.entry.kind === 'node-file'
    && (s.portArgv !== undefined || s.hostArgv !== undefined || s.boolArgv !== undefined))
  assert.equal(withAppFlags.length, 0,
    `有 node-file 进程声明了 app 族旗标（${withAppFlags.map((s) => s.key).join('、')}）——`
    + '那就说明这条不变式**已经可以行为上验了**，请把这条源码断言换成真跑一遍 argv 的断言。')
})

test('★★ 端口在每个进程的 argv 里**恰好出现一次**（不许有第二个来源）', () => {
  // `portArgv` 是**逐进程**声明：team-hub 从 `TEAM_HUB_PORT` 读、whiteboard 从
  // `PORT` 读、workbench 走自己的 `argsTemplate`（`['--port','{port}']`，本来就有）。
  //
  // 判据因此**不是**「有没有 `--port`」（workbench 本来就有，那不是缺陷），
  // 而是「**有没有两次**」：一个进程的 argv 里出现两个 `--port`，
  // 「实际生效的是哪一个」就取决于解析器的取值顺序。
  const plan = planFor({}, {
    runtimeCommand: 'node bin.js --profile web',
    ports: { teamHub: 9001, workbench: 6001, runtime: 3081 },
  })
  const countPort = (key) => {
    const p = plan.processes.find((x) => x.key === key)
    return p?.command === null || p === undefined
      ? 0
      : [...p.command.args].filter((a) => a === '--port').length
  }
  assert.equal(countPort('runtime'), 1, 'runtime 的端口没有进 argv（本缺口）')
  assert.equal(countPort('workbench'), 1, 'workbench 的端口应当恰好一次（它本来就走 argsTemplate）')
  assert.equal(countPort('team-hub'), 0, 'team-hub 的端口走环境变量，不该出现在 argv 里')
  assert.equal(countPort('whiteboard'), 0, 'whiteboard 的端口走 PORT 环境变量，不该出现在 argv 里')
  assert.equal(countPort('orchestrator'), 0, 'orchestrator 是无端口 worker')
})

test('★★★ 两处都给了端口 → 具名阻塞，不许靠 argv 顺序决出胜负', () => {
  // `runtime.command` 自带 `--port` 时，经验上计划那个赢（commander 取最后一次），
  // 但「实际生效的是哪一个」就变成了每次排障都要重新确认的问题——
  // 与 `launcher.mjs` 拒绝「端口既走 env 又走 argv」是同一条理由。
  const plan = planFor({}, { runtimeCommand: 'node bin.js --profile web --port 3080' })
  const conflict = plan.diagnostics.find((d) => d.code === 'PORT_AUTHORITY_CONFLICT')
  assert.ok(conflict, '`runtime.command` 与 ports.runtime 都给了端口，却没有报冲突')
  assert.equal(conflict.process, 'runtime')
  assert.equal(conflict.severity, 'error', '冲突必须是阻塞的，不能只是警告')
  assert.match(conflict.message, /ports\.runtime/, '拒绝理由必须说清端口归谁管')
  assert.equal(hasBlockingProcessDiagnostic(plan.diagnostics), true)
  // ★ 冲突时**不追加**重复的 `--port`：计划里显示的就该是用户那条命令本身。
  const args = [...plan.processes.find((p) => p.key === 'runtime').command.args]
  assert.deepEqual(args, ['bin.js', '--profile', 'web', '--port', '3080'])
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
