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
  DIR_ROLE_READERS,
  DIR_ROLES,
  LEGION_ENV,
  WRITABLE_ROLES,
  assertConfigWritable,
  assertLayoutUsable,
  defaultProductHome,
  dirRoleWiring,
  findPlaintextSecretsInConfig,
  hasBlockingDiagnostic,
  isPathInside,
  layoutDiagnostics,
  mergeConfigLayers,
  normalizePath,
  pathsOverlap,
  provenanceOf,
  writableDirsInsideInstall,
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

// ---------------------------------------------------------------- 目录角色接线
//
// 第 42 轮：这两张声明表原先**各有一份手写复述**，两条静默失效路径都实测到了
// （`scripts/probes/_probe-path-roles.mjs`）。这一组把"声明表 → 检查"这条通路钉住。
//
// ★ 为什么值得单独一组：这两条检查是**安全检查**（可写目录不得落在会被升级
//   原子替换的安装目录里），而它们的失效方式是"报一条看起来正确的诊断"。
//   > 一条报在正确名字下、引用着另一个值的诊断，与一条正确的诊断，
//   > 在"这一项检查过了"这个读数上是同一个东西。

const DIRS = ['data', 'workspace', 'cache', 'log']
const fieldOf = { data: 'dataDir', workspace: 'workspaceDir', cache: 'cacheDir', log: 'logDir' }

test('接线① ★★★ 绝对路径检查**覆盖到每一个** DIR_ROLES 成员（声明即被检查）', () => {
  // 全部置成相对路径 ⇒ 每个角色都该报一条 PATH_NOT_ABSOLUTE
  const layout = { platform: WIN, installDir: 'relative-install', homeDir: 'C:\\Users\\me' }
  for (const role of DIRS) layout[fieldOf[role]] = `relative-${role}`
  const roles = layoutDiagnostics(layout).filter((d) => d.code === 'PATH_NOT_ABSOLUTE').map((d) => d.role)
  assert.deepEqual([...roles].sort(), ['install', ...DIRS].sort(),
    `PATH_NOT_ABSOLUTE 只覆盖了 ${roles.join(',')}——声明了却没被检查的角色会静默漏检`)
})

test('接线② ★★★ 每条诊断引用的是**它自己那个角色**的值（不许张冠李戴）', () => {
  // 这是修之前那个真缺陷的形状：新角色被**当成 logDir** 检查 ⇒
  // 报在正确的角色名下、引用着别人的值。
  const layout = { platform: WIN, installDir: 'relative-install', homeDir: 'C:\\Users\\me' }
  for (const role of DIRS) layout[fieldOf[role]] = `relative-${role}`
  const diags = layoutDiagnostics(layout).filter((d) => d.code === 'PATH_NOT_ABSOLUTE')
  for (const role of ['install', ...DIRS]) {
    const d = diags.find((x) => x.role === role)
    assert.ok(d !== undefined, `${role} 没有被检查到`)
    const quoted = d.message.match(/「([^」]*)」/)?.[1]
    const expected = role === 'install' ? 'relative-install' : `relative-${role}`
    assert.equal(quoted, expected, `${role} 名下引用的是「${quoted}」，而它自己的值是「${expected}」`)
  }
})

test('接线③ ★★★ 安装目录包含检查**覆盖到每一个** WRITABLE_ROLES 成员', () => {
  // 全部放进安装目录 ⇒ 每个可写角色都该报一条
  const layout = { platform: WIN, installDir: 'C:\\Legion', homeDir: 'C:\\Users\\me' }
  for (const role of DIRS) layout[fieldOf[role]] = `C:\\Legion\\${role}`
  const roles = layoutDiagnostics(layout)
    .filter((d) => d.code === 'WRITABLE_DIR_INSIDE_INSTALL_DIR').map((d) => d.role)
  assert.deepEqual([...roles].sort(), [...DIRS].sort(),
    `这条安全检查只覆盖了 ${roles.join(',')}——往 WRITABLE_ROLES 加角色会静默漏检`)
})

test('接线④ ★★ 可写角色必须是目录角色的子集（两张表不许各说各话）', () => {
  for (const r of WRITABLE_ROLES) {
    assert.ok(DIR_ROLES.includes(r), `可写角色「${r}」不在 DIR_ROLES 里`)
  }
  // 反向控制：安装目录**不可写**，所以它不该出现在可写表里
  assert.equal(WRITABLE_ROLES.includes('install'), false,
    'install 被列成了可写角色——那"安装目录内不得有可写角色"会自相矛盾')
})

test('接线⑤ ★★ 反向控制：一个完全合法的布局**不许**报这两类错（别矫枉过正）', () => {
  const layout = {
    platform: WIN,
    installDir: 'C:\\Legion',
    homeDir: 'C:\\Users\\me',
    dataDir: 'C:\\Users\\me\\data',
    workspaceDir: 'D:\\Projects',
    cacheDir: 'C:\\Users\\me\\cache',
    logDir: 'C:\\Users\\me\\log',
  }
  const codes = layoutDiagnostics(layout).map((d) => d.code)
  assert.equal(codes.includes('PATH_NOT_ABSOLUTE'), false, `误报：${codes.join(',')}`)
  assert.equal(codes.includes('WRITABLE_DIR_INSIDE_INSTALL_DIR'), false, `误报：${codes.join(',')}`)
})

test('接线⑥ ★★★ 接线守卫**可注入**：造一个"加了角色却没补取法"的形状，必须被指名', () => {
  // ★ 为什么这一条必须是"注入"而不是"读模块加载时的行为"：
  //   那条守卫只在模块加载时跑一次，而**加载时一切正常**。想验证它拦不拦得住，
  //   唯一的办法是拿坏输入去试——否则只能靠改源码，而改源码的人正是它要防的人。
  //   （破验 M5/M6 一开始就是**漏网**的，本用例是补上来的。）
  const base = { dirRoles: DIR_ROLES, writableRoles: WRITABLE_ROLES }
  const readers = Object.fromEntries(DIR_ROLES.map((r) => [r, () => null]))

  // ① 全绿
  assert.equal(dirRoleWiring({ ...base, readers }).ok, true)

  // ② 声明了却没取法 ⇒ 指名报出（这正是"新角色冒充 logDir"的前置状态）
  const w1 = dirRoleWiring({ ...base, dirRoles: [...DIR_ROLES, 'backup'], readers })
  assert.equal(w1.ok, false)
  assert.deepEqual(w1.unwired, ['backup'], '新角色没有取法却没被指名——那它会被当成别的角色检查')

  // ③ 有取法却没声明 ⇒ 另一个方向的静默（一条永远不会被走到的取法）
  const w2 = dirRoleWiring({ ...base, readers: { ...readers, ghost: () => null } })
  assert.equal(w2.ok, false)
  assert.deepEqual(w2.orphanReader, ['ghost'])

  // ④ 可写角色不在目录角色里 ⇒ 那条安全检查会用一个查不到的取法
  const w3 = dirRoleWiring({ ...base, writableRoles: [...WRITABLE_ROLES, 'ghost'] })
  assert.equal(w3.ok, false)
  assert.deepEqual(w3.notADirRole, ['ghost'])

  // ★ ⑤ 真仓当下必须是绿的（否则上面三条只是在测一个坏表）
  assert.equal(dirRoleWiring({}).ok, true, '真仓的目录角色表当前就不对齐')
})

test('接线⑦ ★★★ 每一个角色都**真的**有自己的取法（两两不同，不许共用）', () => {
  // ★ 这一条抓的是"取法表里两个角色指向同一个字段"（破验 M2 的形状）：
  //   那样两个角色会读到同一个目录，而**两条检查都会报**、都看起来正常。
  const probe = {
    installDir: 'P-install', dataDir: 'P-data', workspaceDir: 'P-workspace',
    cacheDir: 'P-cache', logDir: 'P-log',
  }
  const seen = new Map()
  for (const [role, expected] of Object.entries({
    install: 'P-install', data: 'P-data', workspace: 'P-workspace', cache: 'P-cache', log: 'P-log',
  })) {
    const layout = { platform: WIN, ...probe }
    // 把**只有**该角色置成相对路径，其余置成绝对路径 ⇒ 只有它该报，
    // 且报出来的值必须是它自己那个字段。
    for (const k of Object.keys(probe)) layout[k] = `C:\\abs\\${k}`
    layout[{ install: 'installDir', data: 'dataDir', workspace: 'workspaceDir', cache: 'cacheDir', log: 'logDir' }[role]] = `rel-${role}`
    const d = layoutDiagnostics(layout).find((x) => x.code === 'PATH_NOT_ABSOLUTE')
    assert.ok(d !== undefined, `只把 ${role} 置成相对路径时没有人报——它的取法可能是空的`)
    assert.equal(d.role, role, `报的是 ${d.role}，而只有 ${role} 是相对路径 ⇒ 有角色共用了取法`)
    const quoted = d.message.match(/「([^」]*)」/)?.[1]
    assert.equal(quoted, `rel-${role}`, `${role} 引用的是「${quoted}」`)
    assert.equal(seen.has(quoted), false, `「${quoted}」被两个角色引用了`)
    seen.set(quoted, role)
    assert.equal(expected.length > 0, true)
  }
})

test('接线⑧ ★★★ 安装目录那条检查**跟随声明**——注入第五个角色，它必须被查', () => {
  // ★★★ 这一条是本轮**唯一**能分开"跟随声明"与"恰好查了那四个"的用例。
  //   二者在今天（声明正好是四个可写角色）行为**完全相同**——破验 M3/M4
  //   一开始就是漏网的，查下来正是这个原因，不是判据漏了。
  //   ⇒ 把角色清单做成可注入的，这件事才从"不可证伪"变成"可证伪"。
  const layout = { platform: WIN, installDir: 'C:\\Legion', backupDir: 'C:\\Legion\\backup' }
  // ★ 必须**在真表基础上**加，而不是拿一张只有 backup 的表去替换——
  //   第一版我就是那么写的，于是 `data` 等角色成了「没有取法」、守卫当场抛。
  //   （那条错误文案正是为此写的：它把我这个错误叫了出来，而不是静默少查。）
  const readers = { ...DIR_ROLE_READERS, backup: (l) => l?.backupDir ?? null }

  const base = writableDirsInsideInstall({ layout, installDir: 'C:\\Legion' })
  assert.deepEqual(base.map((x) => x.role), [], '没有角色落在安装目录里时不该报（本夹具的其余目录都为空）')

  const withBackup = writableDirsInsideInstall({
    layout, installDir: 'C:\\Legion',
    writableRoles: [...WRITABLE_ROLES, 'backup'], readers,
  })
  assert.deepEqual(withBackup.map((x) => x.role), ['backup'],
    '注入了第五个可写角色，这条检查却没查它——那它"查对四个"只是巧合，不是跟随声明')
  assert.equal(withBackup[0].value, 'C:\\Legion\\backup')

  // ★ 反向控制：新角色**不在**安装目录里时不许报（别把"注入"变成"凡注入必报"）
  const outside = writableDirsInsideInstall({
    layout: { ...layout, backupDir: 'D:\\Elsewhere' }, installDir: 'C:\\Legion',
    writableRoles: [...WRITABLE_ROLES, 'backup'], readers,
  })
  assert.deepEqual(outside, [], '新角色在安装目录之外，却被报了')

  // ★ 接线断了要**抛**，不是静默跳过（静默跳过 = 这个目录从没被查过）
  assert.throws(() => writableDirsInsideInstall({
    layout, installDir: 'C:\\Legion', writableRoles: [...WRITABLE_ROLES, 'ghost'],
  }), /没有取法/)
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
