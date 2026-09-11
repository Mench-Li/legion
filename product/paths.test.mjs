// product/paths.test.mjs
// ============================================================================
// PRT-258 / PRT-254：产品目录布局与配置优先级的判据。
//
// 本套用例的重点不是「join 拼得对」，而是三条**只会静默出错**的判据：
//   ① 可写目录落在安装目录内（PRT-003 实测 4 处）——升级会吞掉业务数据；
//   ② 四类可写目录相互嵌套——备份/清理/升级会互相破坏；
//   ③ 配置优先级顺序被实现成「调用方传参顺序」——同一份配置在不同入口得到不同结果。
//
// win32 与 posix 两套路径语义都测：路径越界判定的假阴性只在**另一种**
// 大小写/分隔符语义下才暴露，而开发机只有一种。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_LAYERS,
  LEGION_ENV,
  assertConfigWritable,
  assertLayoutUsable,
  defaultProductHome,
  findPlaintextSecretsInConfig,
  hasBlockingDiagnostic,
  isPathInside,
  layoutDiagnostics,
  mergeConfigLayers,
  normalizePath,
  pathsOverlap,
  provenanceOf,
  resolveLayout,
  samePath,
} from './paths.mjs'

const WIN = 'win32'
const POSIX = 'posix'

// ---------------------------------------------------------------- 路径语义

test('isPathInside：前缀相同的并列目录不算包含（假阴性方向的反例）', () => {
  // C:\LegionData 与 C:\Legion 是**并列**目录。用 startsWith(parent) 判定会把它
  // 误判成子目录，于是「业务数据写进安装目录」这条门禁会漏报。
  assert.equal(isPathInside('C:\\Legion', 'C:\\LegionData', WIN), false)
  assert.equal(isPathInside('C:\\Legion', 'C:\\Legion\\Data', WIN), true)
  assert.equal(isPathInside('/opt/legion', '/opt/legiondata', POSIX), false)
  assert.equal(isPathInside('/opt/legion', '/opt/legion/data', POSIX), true)
})

test('isPathInside：自身不算「之内」，尾分隔符不影响判定', () => {
  assert.equal(isPathInside('C:\\Legion', 'C:\\Legion', WIN), false)
  assert.equal(isPathInside('C:\\Legion\\', 'C:\\Legion\\Data\\', WIN), true)
  assert.equal(isPathInside('D:\\', 'D:\\Legion', WIN), true, '驱动器根必须能被正确判定')
})

test('samePath / pathsOverlap：Windows 大小写不敏感，posix 敏感', () => {
  assert.equal(samePath('C:\\Legion\\Data', 'c:\\legion\\data', WIN), true)
  assert.equal(samePath('/opt/Legion', '/opt/legion', POSIX), false)
  assert.equal(pathsOverlap('C:\\Legion\\data', 'C:\\Legion\\data\\sub', WIN), true)
  assert.equal(pathsOverlap('C:\\Legion\\data', 'C:\\Legion\\cache', WIN), false)
})

test('normalizePath：去尾分隔符但保留根', () => {
  assert.equal(normalizePath('C:\\Legion\\Data\\', WIN), 'C:\\Legion\\Data')
  assert.equal(normalizePath('D:\\', WIN), 'D:\\', '驱动器根不能被削成 D:')
  assert.equal(normalizePath('/opt/legion/', POSIX), '/opt/legion')
})

// ---------------------------------------------------------------- 默认布局

test('defaultProductHome：Windows 默认落在 LOCALAPPDATA 而不是 Roaming', () => {
  const win = defaultProductHome({ platform: WIN, homeDir: 'C:\\Users\\me', appDataDir: 'C:\\Users\\me\\AppData\\Local' })
  assert.equal(win.root, 'C:\\Users\\me\\AppData\\Local\\Legion')
  assert.equal(win.source, 'appDataDir')

  const posix = defaultProductHome({ platform: POSIX, homeDir: '/home/me' })
  assert.equal(posix.root, '/home/me/.legion')

  const viaEnv = defaultProductHome({ platform: WIN, homeDir: 'C:\\Users\\me', env: { [LEGION_ENV.HOME]: 'E:\\LegionHome' } })
  assert.equal(viaEnv.root, 'E:\\LegionHome')
  assert.equal(viaEnv.source, LEGION_ENV.HOME)

  // 没有任何可推断来源时必须说「未解析」，不能编一个相对路径出来
  assert.equal(defaultProductHome({ platform: WIN }).root, null)
})

test('resolveLayout：默认把三份本机状态放在产品家目录下，工作区刻意不给默认值', () => {
  const { layout, diagnostics } = resolveLayout({
    platform: WIN,
    installDir: 'C:\\Program Files\\Legion',
    homeDir: 'C:\\Users\\me',
    appDataDir: 'C:\\Users\\me\\AppData\\Local',
    workspaceDir: 'D:\\Projects',
  })
  assert.equal(layout.dataDir, 'C:\\Users\\me\\AppData\\Local\\Legion\\data')
  assert.equal(layout.cacheDir, 'C:\\Users\\me\\AppData\\Local\\Legion\\cache')
  assert.equal(layout.logDir, 'C:\\Users\\me\\AppData\\Local\\Legion\\log')
  assert.equal(layout.productConfigPath, 'C:\\Users\\me\\AppData\\Local\\Legion\\data\\product.config.json')
  assert.equal(layout.workspaceDir, 'D:\\Projects')
  assert.deepEqual(diagnostics, [], '合法布局不得产生任何诊断')

  // 反例：不传 workspaceDir，也不设 env → 必须是 error 而不是「悄悄用某个默认目录」
  const noWs = resolveLayout({ platform: WIN, installDir: 'C:\\Legion', homeDir: 'C:\\Users\\me' })
  assert.equal(noWs.layout.workspaceDir, null)
  const codes = noWs.diagnostics.map((d) => d.code)
  assert.ok(codes.includes('WORKSPACE_NOT_CONFIGURED'))
  assert.equal(hasBlockingDiagnostic(noWs.diagnostics), true)
  assert.throws(() => assertLayoutUsable(noWs.layout), /WORKSPACE_NOT_CONFIGURED/)
})

test('resolveLayout：安装目录未确定时如实报错，不编造默认值', () => {
  const { layout, diagnostics } = resolveLayout({ platform: WIN, homeDir: 'C:\\Users\\me' })
  assert.equal(layout.installDir, null)
  assert.ok(diagnostics.some((d) => d.code === 'INSTALL_DIR_UNRESOLVED'))
})

test('layoutDiagnostics：可写目录落在安装目录内必须判 error（PRT-003 的 4 处越界正是这条反面）', () => {
  const { layout } = resolveLayout({
    platform: WIN,
    installDir: 'C:\\Legion',
    homeDir: 'C:\\Users\\me',
    workspaceDir: 'D:\\Projects',
    dataDir: 'C:\\Legion\\team-hub',
  })
  const codes = layoutDiagnostics(layout).map((d) => d.code)
  assert.ok(codes.includes('WRITABLE_DIR_INSIDE_INSTALL_DIR'), `实际诊断：${codes.join(',')}`)
})

test('layoutDiagnostics：四类可写目录不得相互嵌套', () => {
  const base = {
    platform: WIN,
    installDir: 'C:\\Legion',
    homeDir: 'C:\\Users\\me',
    workspaceDir: 'D:\\Projects',
  }
  const nested = resolveLayout({ ...base, cacheDir: 'C:\\Users\\me\\AppData\\Local\\Legion\\data\\cache' }).layout
  assert.ok(layoutDiagnostics(nested).some((d) => d.code === 'ROLE_DIRS_OVERLAP'))

  const sameDir = resolveLayout({ ...base, logDir: 'C:\\Users\\me\\AppData\\Local\\Legion\\data' }).layout
  assert.ok(layoutDiagnostics(sameDir).some((d) => d.code === 'ROLE_DIRS_OVERLAP'))

  const ok = resolveLayout(base).layout
  assert.equal(layoutDiagnostics(ok).length, 0)
})

test('layoutDiagnostics：产品配置文件在安装目录内单独报 CONFIG_FILE_INSIDE_INSTALL_DIR', () => {
  const { layout } = resolveLayout({
    platform: WIN,
    installDir: 'C:\\Legion',
    homeDir: 'C:\\Users\\me',
    workspaceDir: 'D:\\Projects',
    productConfigPath: 'C:\\Legion\\product.config.json',
  })
  assert.ok(layoutDiagnostics(layout).some((d) => d.code === 'CONFIG_FILE_INSIDE_INSTALL_DIR'))
})

test('env 覆盖优先于默认值：LEGION_DATA_DIR 等按 §6.11「受控环境变量」生效', () => {
  const { layout } = resolveLayout({
    platform: WIN,
    installDir: 'C:\\Legion',
    homeDir: 'C:\\Users\\me',
    workspaceDir: 'D:\\Projects',
    env: {
      [LEGION_ENV.HOME]: 'E:\\LegionHome',
      [LEGION_ENV.CACHE_DIR]: 'E:\\LegionCache',
      [LEGION_ENV.WORKSPACE_DIR]: 'E:\\LegionWorkspace',
    },
  })
  assert.equal(layout.productHome, 'E:\\LegionHome')
  assert.equal(layout.dataDir, 'E:\\LegionHome\\data')
  assert.equal(layout.cacheDir, 'E:\\LegionCache', 'env 覆盖优先于产品家目录推导')
  assert.equal(layout.workspaceDir, 'E:\\LegionWorkspace')
})

// ---------------------------------------------------------------- 配置优先级

test('mergeConfigLayers：顺序由 CONFIG_LAYERS 决定，与传入顺序无关', () => {
  const a = mergeConfigLayers([
    { source: 'env', values: { port: 9999 } },
    { source: 'builtin-defaults', values: { port: 8787, host: '127.0.0.1' } },
    { source: 'product-config', values: { port: 8788 } },
  ])
  assert.equal(a.value.port, 9999)
  assert.equal(a.value.host, '127.0.0.1')
  assert.deepEqual([...a.sources], [...CONFIG_LAYERS].filter((l) => a.sources.includes(l)))

  // 缺层也是合法的：不是每一层都必须存在
  const b = mergeConfigLayers([{ source: 'user-settings', values: { port: 1 } }])
  assert.equal(b.value.port, 1)
})

test('mergeConfigLayers：未知层与重复层必须抛错（否则优先级失去确定性）', () => {
  assert.throws(() => mergeConfigLayers([{ source: 'plugin-config', values: {} }]), /未知配置层/)
  assert.throws(
    () => mergeConfigLayers([{ source: 'env', values: { a: 1 } }, { source: 'env', values: { a: 2 } }]),
    /重复出现/,
  )
  assert.throws(() => mergeConfigLayers([{ source: 'env', values: [] }]), /values 必须是对象/)
})

test('mergeConfigLayers：对象递归合并、数组整体替换、null 参与覆盖、undefined 跳过', () => {
  const merged = mergeConfigLayers([
    {
      source: 'builtin-defaults',
      values: { runtime: { model: 'a', temperature: 0.2 }, tools: ['read'], keep: 'x' },
    },
    {
      source: 'user-settings',
      values: { runtime: { model: 'b' }, tools: ['read', 'write'], keep: undefined, cleared: null },
    },
  ])
  assert.deepEqual(merged.value.runtime, { model: 'b', temperature: 0.2 }, '对象必须递归合并且不丢未覆盖键')
  assert.deepEqual(merged.value.tools, ['read', 'write'], '数组必须整体替换：按下标合并会产出没人写过的配置')
  assert.equal(merged.value.keep, 'x', 'undefined 表示该层未表态')
  assert.equal(merged.value.cleared, null, 'null 是显式清空')
})

test('provenance：每个生效值都能回答「是谁给的」', () => {
  const merged = mergeConfigLayers([
    { source: 'builtin-defaults', values: { runtime: { model: 'a', temperature: 0.2 } } },
    { source: 'product-config', values: { runtime: { model: 'b' } } },
  ])
  assert.equal(provenanceOf(merged, 'runtime.model'), 'product-config')
  assert.equal(provenanceOf(merged, 'runtime.temperature'), 'builtin-defaults')
  assert.equal(provenanceOf(merged, 'runtime.missing'), null)
})

test('mergeConfigLayers：产物被深度冻结，调用方改不动已生效的配置', () => {
  const merged = mergeConfigLayers([{ source: 'builtin-defaults', values: { runtime: { model: 'a' }, tools: ['x'] } }])
  assert.equal(Object.isFrozen(merged.value), true)
  assert.equal(Object.isFrozen(merged.value.runtime), true)
  assert.equal(Object.isFrozen(merged.value.tools), true)
})

// ---------------------------------------------------------------- 密钥门禁

test('assertConfigWritable：普通配置文件不得含明文密钥，只允许 secretRef', () => {
  assert.throws(
    () => assertConfigWritable({ provider: 'openai', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' }),
    /明文密钥/,
  )
  // token 字段名本身就是密钥载体；ref 结尾的引用字段是允许的
  const hits = findPlaintextSecretsInConfig({ teamHubToken: 'abc', teamHubTokenRef: 'legion/hub' })
  assert.deepEqual(hits, ['$.teamHubToken'])
  assert.doesNotThrow(() => assertConfigWritable({ secretRef: 'legion/openai', model: 'x' }))
})

// ---------------------------------------------------------------- 公共出口

test('公共出口：product/index.mjs 的再导出全部可解析（写错导出名只在 import 时才暴露）', async () => {
  const mod = await import('./index.mjs')
  // 显式列出而不遍历 `export *` 的结果：遍历只能证明「有什么」，证不了「该有的都在」
  const expected = [
    'CONFIG_LAYER_LABELS', 'CONFIG_LAYERS', 'DIAGNOSTIC_SEVERITIES', 'DIR_ROLES', 'LEGION_ENV', 'WRITABLE_ROLES',
    'assertConfigWritable', 'assertLayoutUsable', 'defaultProductHome', 'findPlaintextSecretsInConfig',
    'hasBlockingDiagnostic', 'isPathInside', 'layoutDiagnostics', 'mergeConfigLayers', 'normalizePath',
    'pathApi', 'pathsOverlap', 'provenanceOf', 'resolveLayout', 'samePath',
    'DEFAULT_PORTS', 'LOOPBACK_HOSTS', 'MANIFEST_KNOWN_GAPS', 'PROCESS_KEYS', 'PROCESS_MANIFEST_VERSION',
    'PROCESS_SPECS', 'entryAbsolutePath', 'entryEscapesInstall', 'hasBlockingProcessDiagnostic',
    'materializeProcessPlan', 'specFor', 'splitCommandLine', 'startupWaves', 'validateProcessPlan',
  ]
  const missing = expected.filter((name) => mod[name] === undefined)
  assert.deepEqual(missing, [], `index.mjs 缺少导出：${missing.join(', ')}`)
})
