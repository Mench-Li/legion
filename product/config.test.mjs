// product/config.test.mjs
// ============================================================================
// PRT-258 / §6.11 配置分层**读取侧**的判据。
//
// 这一组针对的是配置系统特有的**静默失败**：坏掉的配置文件被当成「没有配置文件」，
// 于是所有值悄悄回到默认值，而用户以为自己的设置生效了。
// 因此每条断言问的都是同一件事：**这件事有没有被报出来**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveLayout } from './paths.mjs'
import {
  KNOWN_CONFIG_KEYS,
  configLayerOf,
  configPaths,
  configValueAt,
  defaultProductConfig,
  launcherInputFromConfig,
  loadProductConfig,
  readJsonFile,
  stripBom,
  validateConfigValues,
} from './config.mjs'

function makeLayout(root) {
  return resolveLayout({
    installDir: join(root, 'install'),
    dataDir: join(root, 'data'),
    workspaceDir: join(root, 'ws'),
    homeDir: join(root, 'home'),
    env: {},
  }).layout
}

test('readJsonFile：UTF-8 BOM 必须被容忍（Windows 记事本保存的配置就是这样）', () => {
  // 这不是洁癖：`JSON.parse` **拒绝** BOM。实测中 `Set-Content -Encoding utf8`
  // 写出的产品配置立刻触发「不是合法 JSON」，而文件在用户眼里完全正常——
  // 用户只是改了一个端口。不处理的话，Windows 上的手工编辑几乎必然踩到。
  const withBom = '\uFEFF{ "ports": { "team-hub": 8000 } }'
  const r = readJsonFile('p.json', { exists: () => true, readFile: () => withBom })
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics))
  assert.equal(r.values.ports['team-hub'], 8000)
  assert.equal(stripBom('no-bom'), 'no-bom')
  assert.equal(stripBom(''), '')
})

test('readJsonFile：坏 JSON 报 CONFIG_INVALID_JSON，**不**退回「没有配置」', () => {
  const r = readJsonFile('C:\\x\\p.json', { exists: () => true, readFile: () => '{ "runtime": { "command": "a", } }' })
  assert.equal(r.ok, false)
  assert.equal(r.values, null)
  assert.equal(r.diagnostics[0].code, 'CONFIG_INVALID_JSON')
  assert.match(r.diagnostics[0].message, /必须报错而不是退回默认值/)
})

test('readJsonFile：读不出来（权限/占用）报 CONFIG_UNREADABLE', () => {
  const err = new Error('EPERM: operation not permitted')
  const r = readJsonFile('C:\\x\\p.json', { exists: () => true, readFile: () => { throw err } })
  assert.equal(r.ok, false)
  assert.equal(r.diagnostics[0].code, 'CONFIG_UNREADABLE')
  assert.match(r.diagnostics[0].message, /EPERM/)
})

test('readJsonFile：顶层不是对象要报错（数组/标量都不是配置）', () => {
  for (const [text, kind] of [['[1,2]', 'array'], ['42', 'number'], ['null', 'object']]) {
    const r = readJsonFile('p.json', { exists: () => true, readFile: () => text })
    assert.equal(r.ok, false, `${kind} 应当被拒绝`)
    assert.ok(['CONFIG_NOT_OBJECT', 'CONFIG_INVALID_JSON'].includes(r.diagnostics[0].code))
  }
})

test('readJsonFile：文件不存在不是错误（缺省层是正常状态）', () => {
  const r = readJsonFile('p.json', { exists: () => false })
  assert.equal(r.ok, true)
  assert.equal(r.exists, false)
  assert.equal(r.values, null)
})

test('validateConfigValues：字符串形式的端口报 CONFIG_TYPE_MISMATCH（类型问题会让比较永远不成立）', () => {
  const diags = validateConfigValues({ ports: { 'team-hub': '8787' } })
  assert.equal(diags.length, 1)
  assert.equal(diags[0].code, 'CONFIG_TYPE_MISMATCH')
  assert.equal(diags[0].path, 'ports.team-hub')
  assert.match(diags[0].message, /字符串形式的数字会静默破坏比较/)
  // 正确的类型不报
  assert.deepEqual([...validateConfigValues({ ports: { 'team-hub': 8787 } })], [])
})

test('validateConfigValues：未知键报 warn（降级兼容）但必须被看见', () => {
  const diags = validateConfigValues({ runtime: { command: 'x', futureKnob: 1 } })
  assert.equal(diags.length, 1)
  assert.equal(diags[0].severity, 'warn')
  assert.equal(diags[0].code, 'CONFIG_UNKNOWN_KEY')
  assert.equal(diags[0].path, 'runtime.futureKnob')
  assert.match(diags[0].message, /没有任何读取方/)
})

test('validateConfigValues：明文密钥一律 error（写入侧拦不住手工编辑）', () => {
  const diags = validateConfigValues({ runtime: { secretRefs: { openai: 'sk-abcdefghijklmnopqrstuvwxyz012345' } } })
  assert.equal(diags.length, 1)
  assert.equal(diags[0].code, 'CONFIG_PLAINTEXT_SECRET')
  assert.equal(diags[0].severity, 'error')
})

test('KNOWN_CONFIG_KEYS：runtime.command 是已登记键（否则 ENTRY_UNRESOLVED 无处可解）', () => {
  assert.equal(KNOWN_CONFIG_KEYS['runtime.command'].type, 'string')
  assert.ok(Object.keys(KNOWN_CONFIG_KEYS).length >= 8)
})

test('configPaths：三层路径分别落在 DataDir / Workspace / 产品家目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cfg-'))
  try {
    const layout = makeLayout(root)
    const paths = configPaths(layout)
    assert.equal(paths['product-config'], layout.productConfigPath)
    assert.match(paths['workspace-config'], /ws[\\/]\.legion[\\/]product\.config\.json$/)
    // 用户设置落在**产品家目录**里（Windows 上是 per-user 的 AppData/Local/Legion），
    // 不是裸的 homeDir：两者混在一起会让「重置用户设置」变成一件危险的事。
    assert.equal(paths['user-settings'], join(layout.productHome, 'settings.json'))
    assert.match(paths['user-settings'], /settings\.json$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadProductConfig：三层优先级 内置默认 < 产品配置 < 工作空间配置 < 用户设置', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cfg-'))
  try {
    const layout = makeLayout(root)
    const paths = configPaths(layout)
    mkdirSync(join(root, 'data'), { recursive: true })
    mkdirSync(join(root, 'ws', '.legion'), { recursive: true })
    mkdirSync(layout.productHome, { recursive: true })
    writeFileSync(paths['product-config'], JSON.stringify({ ports: { 'team-hub': 8000, workbench: 5000 }, launcher: { readinessTimeoutMs: 1000 } }))
    writeFileSync(paths['workspace-config'], JSON.stringify({ ports: { 'team-hub': 8100 } }))
    writeFileSync(paths['user-settings'], JSON.stringify({ ports: { 'team-hub': 8200 } }))

    const r = loadProductConfig(layout, {
      defaults: {
        ports: { 'team-hub': 8787, workbench: 5173 },
        launcher: { readinessTimeoutMs: 30000 },
        components: { whiteboard: { enabled: true } },
      },
    })
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics))
    assert.equal(configValueAt(r.merged, 'ports.team-hub'), 8200)
    assert.equal(configValueAt(r.merged, 'ports.workbench'), 5000, '未被上层覆盖的键保留产品配置的值')
    assert.equal(configLayerOf(r.merged, 'ports.team-hub'), 'user-settings')
    assert.equal(configLayerOf(r.merged, 'ports.workbench'), 'product-config')
    assert.equal(configValueAt(r.merged, 'launcher.readinessTimeoutMs'), 1000)
    assert.equal(configLayerOf(r.merged, 'launcher.readinessTimeoutMs'), 'product-config')
    // 没有任何文件写过的键：值来自内置默认值，且来源如实报成 builtin-defaults
    assert.equal(configValueAt(r.merged, 'components.whiteboard.enabled'), true)
    assert.equal(configLayerOf(r.merged, 'components.whiteboard.enabled'), 'builtin-defaults')
    // 记录每层来自哪个文件（排障要能立刻回答「我改的是这份文件吗」）
    const layerPaths = Object.fromEntries(r.layers.map((l) => [l.source, l.path]))
    assert.equal(layerPaths['product-config'], paths['product-config'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadProductConfig：env 层优先级最高（§6.11 的受控环境变量）', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cfg-'))
  try {
    const layout = makeLayout(root)
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(configPaths(layout)['product-config'], JSON.stringify({ ports: { 'team-hub': 8000 } }))
    const r = loadProductConfig(layout, { envValues: { ports: { 'team-hub': 9999 } } })
    assert.equal(configValueAt(r.merged, 'ports.team-hub'), 9999)
    assert.equal(configLayerOf(r.merged, 'ports.team-hub'), 'env')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadProductConfig：某层是坏 JSON 时 ok=false（不得带着半份配置启动）', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cfg-'))
  try {
    const layout = makeLayout(root)
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(configPaths(layout)['product-config'], '{ "ports": { "team-hub": 8000, } }')
    const r = loadProductConfig(layout)
    assert.equal(r.ok, false)
    assert.ok(r.diagnostics.some((d) => d.code === 'CONFIG_INVALID_JSON'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadProductConfig：工作区未配置时该层被跳过并**说明原因**（不是静默跳过）', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cfg-'))
  try {
    const layout = resolveLayout({ installDir: join(root, 'install'), dataDir: join(root, 'data'), homeDir: join(root, 'home'), env: {} }).layout
    const r = loadProductConfig(layout)
    const skipped = r.diagnostics.filter((d) => d.code === 'CONFIG_LAYER_PATH_UNRESOLVED')
    assert.ok(skipped.some((d) => d.layer === 'workspace-config'))
    assert.equal(skipped[0].severity, 'warn')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('launcherInputFromConfig：端口/超时/命令都带来源；空命令行不当作已配置', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cfg-'))
  try {
    const layout = makeLayout(root)
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(configPaths(layout)['product-config'], JSON.stringify({
      ports: { 'team-hub': 8123, runtime: 'nope' },
      // 空字符串是首次运行写下的默认值：它**不是**一个可用的命令行，
      // 必须仍然报 ENTRY_UNRESOLVED，而不是启动一个空命令。
      runtime: { command: '' },
      launcher: { readinessTimeoutMs: 4000 },
    }))
    const r = loadProductConfig(layout)
    const input = launcherInputFromConfig(r.merged)
    assert.equal(input.ports['team-hub'], 8123)
    assert.equal(input.runtimeCommand, null)
    assert.equal(input.readinessTimeoutMs, 4000)
    assert.equal(input.provenance['ports.team-hub'], 'product-config')
    assert.equal(input.provenance['runtime.command'], undefined)
    // 类型错的端口不得进入 launcher 输入（它已经被 validateConfigValues 报成 error；
    // 这里再确认一次它没有被「顺手转成数字」）
    assert.equal(input.ports.runtime, undefined)

    writeFileSync(configPaths(layout)['product-config'], JSON.stringify({ runtime: { command: 'node runtime/index.mjs' } }))
    const r2 = loadProductConfig(layout)
    const input2 = launcherInputFromConfig(r2.merged)
    assert.equal(input2.runtimeCommand, 'node runtime/index.mjs')
    assert.equal(input2.provenance['runtime.command'], 'product-config')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('defaultProductConfig：写下的默认配置本身必须通过校验且不含密钥', () => {
  const values = defaultProductConfig()
  const diags = validateConfigValues(values)
  // runtime.command 是空串 → 类型仍是 string，应当只有未知键（$schema/configVersion）的 warn
  assert.equal(diags.filter((d) => d.severity === 'error').length, 0, JSON.stringify(diags))
  assert.equal(JSON.stringify(values).includes('sk-'), false)
})
