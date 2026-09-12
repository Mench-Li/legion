// product/init.test.mjs
// ============================================================================
// PRT-706 首次运行初始化的判据。
//
// 这一组守的是**不可逆动作**：初始化会在磁盘上建目录、写文件。
// 三条边界各有对应的、真实会发生的失败：
//   ① 在安装目录里建东西 → 升级时消失或让升级失败；
//   ② 替用户创建工作区目录 → 「工作区选错了」在很晚才暴露，那时已经写过东西；
//   ③ 覆盖已有的产品配置 → 用户在向导里填的东西无声消失。
// 用例全部在临时目录里跑真实文件系统（这几条判据正是在真实 I/O 上才成立），
// 并在断言后再跑一次证明**幂等**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveLayout } from './paths.mjs'
import { configPaths, loadProductConfig, launcherInputFromConfig } from './config.mjs'
import {
  DATA_SUBDIRS,
  PRODUCT_META_FILENAME,
  directorySize,
  initializeProductDir,
  isInitialized,
  probeWritable,
  readProductMeta,
} from './init.mjs'

/** 造一个「工作区已存在」的合法布局（用户在向导里选过目录）。 */
function makeReadyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'legion-init-'))
  const install = join(root, 'install')
  mkdirSync(install, { recursive: true })
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const layout = resolveLayout({
    installDir: install,
    dataDir: join(root, 'data'),
    workspaceDir: ws,
    homeDir: join(root, 'home'),
    env: {},
  }).layout
  return { root, layout, ws, install }
}

test('初始化：建齐 DataDir/Cache/Log 与各进程写入子目录，并写下配置与元数据', () => {
  const { root, layout } = makeReadyFixture()
  try {
    const r = initializeProductDir(layout, { productVersion: '0.1.0' })
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics))
    assert.equal(r.phase, null)
    for (const dir of [layout.dataDir, layout.cacheDir, layout.logDir]) assert.equal(existsSync(dir), true, dir)
    for (const sub of DATA_SUBDIRS) assert.equal(existsSync(join(layout.dataDir, sub)), true, sub)
    assert.equal(existsSync(layout.productConfigPath), true)
    assert.equal(existsSync(join(layout.dataDir, PRODUCT_META_FILENAME)), true)

    const meta = readProductMeta(layout)
    assert.equal(meta.ok, true)
    assert.equal(meta.meta.productVersion, '0.1.0')
    assert.equal(meta.meta.installDirAtCreation, layout.installDir)
    assert.equal(typeof meta.meta.createdAt, 'string')
    assert.deepEqual(meta.meta.package === undefined, true, '不得把包信息塞进元数据')

    // 报告必须说明「做了什么」：静默成功会让「为什么我的配置不见了」无从回答
    assert.ok(r.created.length >= 8)
    assert.deepEqual(r.files.map((f) => f.role).sort(), ['product-config', 'product-meta'])
    assert.equal(isInitialized(layout), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('初始化：幂等 —— 第二次不重建、不覆盖，且把「跳过」如实报出', () => {
  const { root, layout } = makeReadyFixture()
  try {
    const first = initializeProductDir(layout)
    assert.equal(first.ok, true)
    // 模拟用户在向导里填了东西
    const custom = { runtime: { command: 'node runtime/index.mjs' }, ports: { 'team-hub': 9000 } }
    writeFileSync(layout.productConfigPath, JSON.stringify(custom))
    const metaPath = join(layout.dataDir, PRODUCT_META_FILENAME)
    const metaBefore = readFileSync(metaPath, 'utf8')

    const second = initializeProductDir(layout)
    assert.equal(second.ok, true)
    assert.deepEqual([...second.created], [], '第二次不得再创建目录')
    assert.deepEqual([...second.files], [], '第二次不得再写文件')
    assert.ok(second.skipped.length >= first.created.length)

    // 关键：用户写过的配置与元数据必须逐字节不变
    assert.deepEqual(JSON.parse(readFileSync(layout.productConfigPath, 'utf8')), custom, '已有配置不得被覆盖')
    assert.equal(readFileSync(metaPath, 'utf8'), metaBefore, '已创建的 createdAt 不得被改写')

    // 并且用户填的命令真的能被读出来（配置 → Launcher 输入的接线是通的）
    const cfg = loadProductConfig(layout)
    assert.equal(launcherInputFromConfig(cfg.merged).runtimeCommand, 'node runtime/index.mjs')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('初始化：布局有 error 时**一个目录都不建**（部分初始化会伪装成装好了）', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-init-'))
  try {
    const install = join(root, 'install')
    mkdirSync(install, { recursive: true })
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    // DataDir 落在安装目录内 → WRITABLE_DIR_INSIDE_INSTALL_DIR（error）
    const layout = resolveLayout({
      installDir: install,
      dataDir: join(install, 'data'),
      workspaceDir: ws,
      homeDir: join(root, 'home'),
      env: {},
    }).layout
    const r = initializeProductDir(layout)
    assert.equal(r.ok, false)
    assert.equal(r.phase, 'layout')
    assert.deepEqual([...r.created], [])
    assert.deepEqual([...r.files], [])
    assert.equal(existsSync(join(install, 'data')), false, '被拒绝时不得留下任何目录')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('初始化：工作区未配置/不存在时报错，且**不替用户创建**', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-init-'))
  try {
    const install = join(root, 'install')
    mkdirSync(install, { recursive: true })
    const missingWs = join(root, 'not-created-yet')
    const layout = resolveLayout({
      installDir: install,
      dataDir: join(root, 'data'),
      workspaceDir: missingWs,
      homeDir: join(root, 'home'),
      env: {},
    }).layout
    const r = initializeProductDir(layout)
    assert.equal(r.ok, false)
    const diag = r.diagnostics.find((d) => d.code === 'INIT_WORKSPACE_MISSING')
    assert.ok(diag !== undefined, JSON.stringify(r.diagnostics))
    assert.equal(diag.severity, 'error')
    assert.equal(existsSync(missingWs), false, '产品不得替用户创建项目目录')
    // 但 DataDir 那部分已经建好了：工作区问题是**用户要先解决的事**，不是拒绝初始化的理由
    assert.equal(existsSync(layout.dataDir), true)

    // 完全没给工作区：布局不变量自己就是 error（WORKSPACE_NOT_CONFIGURED），
    // 初始化在「一个目录都不建」这一步短路。**判定点只有一处**：
    // 同一件事判两次就会有两个口径，而口径不一致时两份都不可信。
    const noWs = resolveLayout({ installDir: install, dataDir: join(root, 'data2'), homeDir: join(root, 'home'), env: {} }).layout
    const r2 = initializeProductDir(noWs)
    assert.equal(r2.ok, false)
    assert.equal(r2.phase, 'layout')
    assert.ok(r2.diagnostics.some((d) => d.code === 'WORKSPACE_NOT_CONFIGURED'), JSON.stringify(r2.diagnostics))
    assert.deepEqual([...r2.created], [], '未指定工作区时不得先建一半目录')
    assert.equal(existsSync(join(root, 'data2')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('初始化：拒绝把安装目录本身当作可写角色目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-init-'))
  try {
    const install = join(root, 'install')
    mkdirSync(install, { recursive: true })
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    // cacheDir 指向安装目录自身：ROLE_DIRS_OVERLAP 之类可能不触发，靠 INIT_REFUSED_INSTALL_DIR 兜住
    const layout = resolveLayout({
      installDir: install,
      dataDir: join(root, 'data'),
      cacheDir: install,
      workspaceDir: ws,
      homeDir: join(root, 'home'),
      env: {},
    }).layout
    const r = initializeProductDir(layout)
    assert.equal(r.ok, false)
    assert.ok(
      r.diagnostics.some((d) => d.code === 'INIT_REFUSED_INSTALL_DIR' || d.code === 'WRITABLE_DIR_INSIDE_INSTALL_DIR'),
      JSON.stringify(r.diagnostics),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('初始化：dryRun 只报告不落盘（首次运行向导需要「先看看会发生什么」）', () => {
  const { root, layout } = makeReadyFixture()
  try {
    const r = initializeProductDir(layout, { dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(r.ok, true)
    assert.ok(r.created.length >= 8, 'dryRun 也要报出「将会创建什么」')
    assert.deepEqual([...r.files.map((f) => f.role)].sort(), ['product-config', 'product-meta'])
    assert.equal(existsSync(layout.dataDir), false, 'dryRun 不得真的建目录')
    assert.equal(isInitialized(layout), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('初始化：目录不可写时报 DIR_NOT_WRITABLE（而不是让启动在更晚的时候失败）', () => {
  const { root, layout } = makeReadyFixture()
  try {
    const r = initializeProductDir(layout, {
      writeFile: (path, ...rest) => {
        // 只让可写性探测（.legion-write-probe）失败，其余写入正常
        if (String(path).includes('.legion-write-probe')) {
          const e = new Error('EPERM: operation not permitted')
          e.code = 'EPERM'
          throw e
        }
        return writeFileSync(path, ...rest)
      },
    })
    assert.equal(r.ok, false)
    const diag = r.diagnostics.find((d) => d.code === 'DIR_NOT_WRITABLE')
    assert.ok(diag !== undefined, JSON.stringify(r.diagnostics))
    assert.match(diag.message, /EPERM/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('probeWritable：可写返回 true，不可写返回具体原因', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-init-'))
  try {
    assert.equal(probeWritable(root).writable, true)
    const denied = probeWritable(root, { writeFile: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e } })
    assert.equal(denied.writable, false)
    assert.equal(denied.code, 'DIR_NOT_WRITABLE')
    assert.match(denied.message, /EACCES/)
    assert.equal(existsSync(join(root, '.legion-write-probe')), false, '探测文件必须被清掉')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readProductMeta / isInitialized：未初始化时如实说「未初始化」，不猜', () => {
  const { root, layout } = makeReadyFixture()
  try {
    assert.equal(isInitialized(layout), false)
    const meta = readProductMeta(layout)
    assert.equal(meta.ok, false)
    assert.match(meta.reason, /未初始化/)

    // 元数据文件坏掉时也要如实报，而不是当成「没初始化」——两者的处置完全不同
    initializeProductDir(layout)
    writeFileSync(join(layout.dataDir, PRODUCT_META_FILENAME), '{ 坏掉的')
    const broken = readProductMeta(layout)
    assert.equal(broken.ok, false)
    assert.match(broken.reason, /不可解析/)
    assert.equal(isInitialized(layout), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('directorySize：统计真实文件字节数，目录不存在返回 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-init-'))
  try {
    assert.equal(directorySize(join(root, 'nope')), 0)
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'one.txt'), 'x'.repeat(10))
    writeFileSync(join(root, 'a', 'b', 'two.txt'), 'y'.repeat(32))
    assert.equal(directorySize(root), 42)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('初始化写入的产品配置不含密钥，且能被 validateConfigValues 接受', () => {
  const { root, layout } = makeReadyFixture()
  try {
    initializeProductDir(layout)
    const text = readFileSync(layout.productConfigPath, 'utf8')
    assert.equal(/sk-|ghp_|AKIA/.test(text), false)
    const cfg = loadProductConfig(layout)
    assert.equal(cfg.ok, true, JSON.stringify(cfg.diagnostics))
    assert.equal(cfg.diagnostics.filter((d) => d.code === 'CONFIG_PLAINTEXT_SECRET').length, 0)
    assert.equal(configPaths(layout)['product-config'], layout.productConfigPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
