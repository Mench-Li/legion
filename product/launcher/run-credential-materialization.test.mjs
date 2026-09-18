// product/launcher/run-credential-materialization.test.mjs
// ============================================================================
// PRT-509 缺口 ①：写侧能力**接进生产启动路径**的判据（纯注入，毫秒级）。
//
// 这一组要守的三件事，各自都有一个"看起来一样"的假绿：
//
//   ① **接线在**——把 `launcher.mjs` 里那次调用删掉时，这一组必须红。
//      一个"模块写得对、但没人调"的实现与一个"根本没接"的实现，
//      在模块自己的单测里是同一片绿（这正是缺口 ① 的成因）。
//   ② **覆盖层真的被接上**——DSH 对匹配不到任何行的补丁是 warn-and-skip，
//      那时文件看起来装好了、而 DSH 读的还是原来那份。所以判据是"那一行的
//      id 与 path 都在文档里"，不是"文件写出来了"。
//   ③ **没东西可写时行为不变**——空补丁表 `[]` 是合法的空操作；
//      一个"没配密钥就把 DSH 的凭证来源改指到不存在的文件"的接线，
//      会让本来能用的部署在接完线之后用不上 DSH 里已有的钥匙，而且不报错。
//
// 值一律不入断言：本层只谈引用名、DSH 名字、路径与计数。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { probeDpapi } from '../../security/secrets/dpapi.mjs'
import { createProductSecretStore } from '../../security/secrets/store.mjs'
import { resolveLayout } from '../paths.mjs'
import {
  DEFAULT_RUNTIME_CREDENTIAL_REFS,
  RUN_CREDENTIAL_OVERLAY_NOOP,
  RUN_CREDENTIAL_OVERLAY_ROW_ID,
  RUN_CREDENTIAL_WIRING_CODES,
  RUNTIME_MODEL_KEY_REF,
  dshCredentialNamesFromPatchText,
  prepareRuntimeCredentials,
  productRunCredentialOpener,
  resolveDshBaseBundlePatchPath,
  runCredentialOverlayArgs,
  runCredentialOverlayDocument,
  runCredentialPaths,
} from './run-credential-materialization.mjs'

const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const WIRING_SOURCE = new URL('./run-credential-materialization.mjs', import.meta.url)

function tempRoot(tag) {
  return mkdtempSync(join(tmpdir(), `legion-prt509-${tag}-`))
}

/**
 * 真实受保护库那条用例用的假密钥。**它绝不允许出现在断言或日志里**（本文件纪律：
 * 值不入断言）——只用来验"写进去的那一把"与"读回来的那一把"是同一把。
 */
const REAL_PATH_SECRET = 'sk-DO-NOT-LEAK-real-default-path-0123456789'

// 真实 DPAPI 在非 Windows 或受限环境下不可用；不可用时**显式跳过**，
// 而不是让"默认分支没走到"这件事被一次绿盖住。
const dpapiProbe = probeDpapi()
const dpapiSkip = dpapiProbe.available
  ? false
  : `本机不可用真实 DPAPI：${dpapiProbe.reason}（${dpapiProbe.hint}）`

function layoutIn(root) {
  const { layout } = resolveLayout({
    installDir: REPO_ROOT,
    dataDir: join(root, 'data'),
    workspaceDir: join(root, 'ws'),
    homeDir: root,
    env: {},
  })
  return layout
}

/** 一个手写的冻结句柄：形状与 `openRunCredentials()` 的产物一致。 */
function fakeHandle(refs = [RUNTIME_MODEL_KEY_REF]) {
  const held = new Map(refs.map((r, i) => [r, `probe-value-${i}`]))
  return {
    version: 1,
    runId: 'run-test',
    resolvedAt: '2026-09-15T00:00:00.000Z',
    refs: Object.freeze([...refs]),
    held: (ref) => held.has(ref),
    get: (ref) => { if (!held.has(ref)) throw new Error('not-held'); return held.get(ref) },
  }
}

/** 一个假的 DSH base bundle 补丁文本（只含声明，不含任何 key 值）。 */
const BASE_PATCH_WITH_ONE_DECLARATION = [
  '# 假的 DSH base bundle 补丁（用例造的）',
  '    - id: llm-deepseek',
  "      name: '@deepseek-ai/dsh-llm-deepseek'",
  '      config:',
  '        apiKeyEnv: PROBE_API_KEY',
  '',
].join('\n')

// ---------------------------------------------------------------- ① 路径

test('路径：落在产品家目录下的 runtime-credentials/，**不在数据目录内**（数据目录是导出对象）', () => {
  const root = tempRoot('paths')
  try {
    const layout = layoutIn(root)
    const paths = runCredentialPaths(layout)
    assert.equal(paths.ok, true, paths.message ?? '')
    assert.equal(paths.allowedRoot, paths.root)
    assert.ok(paths.root.startsWith(layout.productHome), `${paths.root} 不在产品家目录下`)
    assert.equal(paths.targetFile, join(paths.root, '.credentials.yaml'),
      '文件名必须是 DSH 只读的那个名字——换成别的名字，写出去也没人读')
    assert.equal(paths.overlayFile, join(paths.root, 'credentials-path.patch.yml'))
    assert.equal(paths.root.startsWith(join(root, 'data')), false, '明文凭证不得落在数据目录内')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('路径：产品家目录解析不出来时**具名拒绝**，不返回一个"随便挑一个目录"的根', () => {
  const paths = runCredentialPaths({ productHome: null, dataDir: null, platform: 'win32' })
  assert.equal(paths.ok, false)
  assert.equal(paths.code, RUN_CREDENTIAL_WIRING_CODES.NO_ALLOWED_ROOT)
})

test('路径：产品家目录落在数据目录内时被拒（数据目录会被备份/诊断包带走）', () => {
  const productHome = join('C:', 'tmp', 'legion', 'data', 'inside')
  const paths = runCredentialPaths({
    productHome, dataDir: join('C:', 'tmp', 'legion', 'data'), platform: 'win32',
  })
  assert.equal(paths.ok, false)
  assert.equal(paths.code, RUN_CREDENTIAL_WIRING_CODES.TARGET_INSIDE_DATA_DIR)
})

// ---------------------------------------------------------------- 覆盖层

test('覆盖层：非空时那一行的 id 与 path 都在文档里（DSH 对匹配不到的行是 warn-and-skip）', () => {
  const target = join('C:', 'tmp', 'legion', '.legion', 'runtime-credentials', '.credentials.yaml')
  const doc = runCredentialOverlayDocument({ targetFile: target })
  assert.match(doc, new RegExp(`^- id: ${RUN_CREDENTIAL_OVERLAY_ROW_ID}$`, 'm'))
  assert.match(doc, /^ {2}config:$/m)
  // 路径用 JSON 双引号标量：裸标量会把 Windows 的反斜杠吃掉。
  assert.ok(doc.includes(JSON.stringify(target)), doc)
  assert.match(doc, /^ {4}path: "/m)
})

test('覆盖层：没有目标时是**空补丁表**（合法的空操作），不是"写一句假话"', () => {
  assert.equal(runCredentialOverlayDocument({ targetFile: null }), RUN_CREDENTIAL_OVERLAY_NOOP)
  assert.equal(runCredentialOverlayDocument({}), RUN_CREDENTIAL_OVERLAY_NOOP)
  assert.deepEqual([...runCredentialOverlayArgs({ ok: false, overlayFile: 'x' })], [],
    '路径没算出来时不得追加 --patch：指向不存在文件的 --patch 会让 Runtime 起不来')
  assert.deepEqual([...runCredentialOverlayArgs({ ok: true, overlayFile: 'D:\\x\\o.yml' })],
    ['--patch', 'D:\\x\\o.yml'])
})

// ---------------------------------------------------------------- 映射来源

test('映射来源：从 DSH 自己的 apiKeyEnv 声明里读，**恰好一个**才接受', () => {
  const one = dshCredentialNamesFromPatchText({ text: BASE_PATCH_WITH_ONE_DECLARATION })
  assert.equal(one.ok, true, one.message ?? '')
  assert.deepEqual([...one.names], ['PROBE_API_KEY'])
})

test('映射来源：0 个声明 ⇒ 具名拒绝（不内置 provider → 环境变量名的表）', () => {
  const none = dshCredentialNamesFromPatchText({ text: '# 没有任何声明\n- id: x\n' })
  assert.equal(none.ok, false)
  assert.equal(none.code, RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_MISSING)
  assert.equal(dshCredentialNamesFromPatchText({ text: '' }).code, RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_MISSING)
})

test('映射来源：2 个及以上声明 ⇒ 具名拒绝，**不取第一个**', () => {
  const two = dshCredentialNamesFromPatchText({
    text: '        apiKeyEnv: ONE_KEY\n        apiKeyEnv: TWO_KEY\n',
  })
  assert.equal(two.ok, false)
  assert.equal(two.code, RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_AMBIGUOUS)
  assert.deepEqual([...two.names], ['ONE_KEY', 'TWO_KEY'],
    '"取第一个"会把一个决定藏进数组顺序里，而顺序不是任何人做过的决定')
})

test('定位：`createRequire(入口)` 的替代可注入；认不出入口时返回 null 而不是拼一个路径', () => {
  const fake = { resolve: () => '/tmp/fake/cordis.patch.yml' }
  assert.equal(resolveDshBaseBundlePatchPath({
    runtimeCommand: { file: 'node', args: ['/tmp/dsh/lib/bin.js', '--profile', 'web'] },
    requireFn: fake,
  }), '/tmp/fake/cordis.patch.yml')
  assert.equal(resolveDshBaseBundlePatchPath({
    runtimeCommand: { file: 'node', args: ['--profile', 'web'] },
    requireFn: fake,
  }), null)
  assert.equal(resolveDshBaseBundlePatchPath({
    runtimeCommand: { file: 'node', args: ['/tmp/dsh/lib/bin.js'] },
    requireFn: { resolve: () => { throw new Error('unresolvable') } },
  }), null)
})

// ══════════════════════════════════════════════════════════════════════════
// 定位 · 续：**生产真的会传进来的那个形状**
// ══════════════════════════════════════════════════════════════════════════

test('定位 · 续 ★★★ 生产的形状是**函数**（`createRequire()` 的产物），不是对象', () => {
  // 这一条是从下面那个真实缺陷里长出来的，所以它必须写清**为什么原来没被发现**：
  //
  //   上面那条用例注入的是 `{ resolve }`——一个**对象**。而生产走到
  //   "不注入"那条路时拿到的是 `createRequire(entry)`，它的产物**是一个函数**，
  //   只不过带着 `.resolve` 方法。第一版的判据写着 `typeof r === 'object'`，
  //   于是：
  //
  //     | 形状 | 来源 | 旧判据 |
  //     |---|---|---|
  //     | `{ resolve }` | **只有用例** | ✅ |
  //     | 函数带 `.resolve` | **只有生产** | ❌ 被当成"没注入" ⇒ `return null` |
  //
  //   后果不是报错，是 `DSH_DECLARATION_UNLOCATABLE` ⇒ 覆盖层退回空操作：
  //   **自动映射这条路在生产里一次都没有成功过**，而它的读数是一条
  //   看起来完全正常的具名降级。
  //
  //  > 一个"只在用例注入的那个形状下能跑"的解析器，
  //  > 与一个"在生产里恒不工作"的解析器，是同一个东西——
  //  > 只不过前者的用例是绿的，而绿的理由恰恰是
  //  > **用例注入的形状与生产拿到的形状不是同一个**。
  //
  // 所以这一条**必须**用一个函数（而不是对象）来钉。用对象再测一遍是重复，
  // 而重复正是原来那处缺陷藏身的方式。
  const seen = []
  function fakeRequire() { /* createRequire() 的产物是函数 */ }
  fakeRequire.resolve = (spec) => { seen.push(spec); return '/tmp/prod-shaped/cordis.patch.yml' }
  assert.equal(typeof fakeRequire, 'function', '前提：这个替身必须**是函数**，否则本用例证明不了那一处')

  const got = resolveDshBaseBundlePatchPath({
    runtimeCommand: { file: 'node', args: ['/tmp/dsh/lib/bin.js'] },
    requireFn: fakeRequire,
  })
  assert.equal(got, '/tmp/prod-shaped/cordis.patch.yml',
    '★ 函数形状的 `requireFn` 被拒了——生产的 `createRequire(entry)` 正是这个形状，' +
    '于是自动映射在生产里恒返回 null（表现是一条看起来正常的 DSH_DECLARATION_UNLOCATABLE）')
  assert.deepEqual(seen, ['@deepseek-ai/dsh-base/cordis.patch.yml'],
    '要解析的说明符必须**逐字**是 DSH 那个包的导出子路径——写成别的名字会让"读不到声明"看起来像"DSH 没声明"')

  // 反向：函数形状但**没有** `.resolve` ⇒ 仍然不可用（不是"凡函数皆可"）。
  const naked = () => {}
  assert.equal(resolveDshBaseBundlePatchPath({
    runtimeCommand: { file: 'node', args: ['/tmp/dsh/lib/bin.js'] },
    requireFn: naked,
  }), null, '一个没有 `.resolve` 的函数不该被当成可用——那会让下一步抛在 resolve 上，而不是这里')
  assert.equal(resolveDshBaseBundlePatchPath({
    runtimeCommand: { file: 'node', args: ['/tmp/dsh/lib/bin.js'] },
    requireFn: 'not-a-require',
  }), null, '字符串同样不可用（判据是"有没有 .resolve"，不是"是不是真值"）')
})

// ---------------------------------------------------------------- 完整一步

/** 造一份"像真的"的 base bundle 补丁文件，供 `requireFn` 指过去。 */
function fakeDshDeclaration(root, text = BASE_PATCH_WITH_ONE_DECLARATION) {
  const dir = join(root, 'fake-dsh-base')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, text, 'utf8')
  return { file, requireFn: { resolve: () => file } }
}

test('材料化那一步：句柄 + 映射 + 落盘 + 覆盖层，四件事一次做完', async () => {
  const root = tempRoot('apply')
  try {
    const layout = layoutIn(root)
    const dsh = fakeDshDeclaration(root)
    const reading = await prepareRuntimeCredentials({
      layout,
      // operator 的真实 home：`$DSH_HOME` 从凭证文件路径反推，`~/.dsh` 由调用方注入
      dshCredentialsFile: join(root, 'operator-dsh', '.credentials.yaml'),
      operatorHome: join(root, 'operator-home'),
      runId: 'launch-test',
      refs: [RUNTIME_MODEL_KEY_REF],
      runtimeCommand: { file: 'node', args: [join(root, 'dsh', 'lib', 'bin.js')] },
      requireFn: dsh.requireFn,
      openHandle: async ({ refs }) => fakeHandle(refs),
    })
    assert.equal(reading.ok, true, reading.message ?? '')
    assert.equal(reading.applied, true)
    assert.equal(reading.blocking, false)

    const paths = runCredentialPaths(layout)
    // ① 凭证文件真的写出来了，而且是**真实读者读得回来**的那份（判据在材料化器自己）
    const written = readFileSync(paths.targetFile, 'utf8')
    assert.match(written, /^version: 1$/m)
    assert.ok(written.includes(RUNTIME_MODEL_KEY_REF) === false,
      '写进去的是 **DSH 可寻址的名字**，不是 Legion 的引用名——写成后者，键空间里没有这一条')
    assert.ok(written.includes('PROBE_API_KEY'), 'DSH 声明的名字必须出现在文档里')
    // ② 覆盖层真的把那一行接上了
    const overlay = readFileSync(paths.overlayFile, 'utf8')
    assert.match(overlay, new RegExp(`^- id: ${RUN_CREDENTIAL_OVERLAY_ROW_ID}$`, 'm'))
    assert.ok(overlay.includes(JSON.stringify(paths.targetFile)))
    // ③ 读数里**没有值**
    const serialized = JSON.stringify(reading.toJSON === undefined ? reading : reading.toJSON())
    assert.equal(serialized.includes('probe-value'), false, '读数里出现了值')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('材料化那一步：没有东西可写时写**空补丁表**，行为与接线之前逐字相同', async () => {
  const root = tempRoot('noop')
  try {
    const layout = layoutIn(root)
    const paths = runCredentialPaths(layout)
    let opened = 0
    const reading = await prepareRuntimeCredentials({
      layout,
      dshCredentialsFile: join(root, 'operator-dsh', '.credentials.yaml'),
      operatorHome: join(root, 'operator-home'),
      refs: [],
      openHandle: async () => { opened += 1; return fakeHandle() },
    })
    assert.equal(reading.applied, false)
    assert.equal(reading.code, RUN_CREDENTIAL_WIRING_CODES.NO_REFS_DECLARED)
    assert.equal(reading.blocking, false)
    assert.equal(opened, 0, '空声明时不得去开句柄（开了就会去碰密钥库）')
    assert.equal(readFileSync(paths.overlayFile, 'utf8'), RUN_CREDENTIAL_OVERLAY_NOOP)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('材料化那一步：句柄开不出来 ⇒ **不写半份凭证**，且覆盖层退回空操作', async () => {
  const root = tempRoot('nohandle')
  try {
    const layout = layoutIn(root)
    const paths = runCredentialPaths(layout)
    const dsh = fakeDshDeclaration(root)
    const reading = await prepareRuntimeCredentials({
      layout,
      dshCredentialsFile: join(root, 'operator-dsh', '.credentials.yaml'),
      operatorHome: join(root, 'operator-home'),
      refs: [RUNTIME_MODEL_KEY_REF],
      runtimeCommand: { file: 'node', args: [join(root, 'dsh', 'lib', 'bin.js')] },
      requireFn: dsh.requireFn,
      openHandle: async () => { const e = new Error('nope'); e.code = 'SECRET_STORE_UNREADABLE'; throw e },
    })
    assert.equal(reading.ok, false)
    assert.equal(reading.code, RUN_CREDENTIAL_WIRING_CODES.HANDLE_FAILED)
    assert.equal(reading.blocking, false, '密钥库打不开是"现在不工作"，不是"启动会制造新危险"')
    assert.equal(readFileSync(paths.overlayFile, 'utf8'), RUN_CREDENTIAL_OVERLAY_NOOP,
      '开了半份又写出去，与"少一份凭证也能跑"是同一个东西')
    assert.equal(readFileSync(paths.overlayFile, 'utf8').includes('.credentials.yaml'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('材料化那一步：operator 的真实 home 一个都没有 ⇒ 具名拒绝、**不写**', async () => {
  const root = tempRoot('nohome')
  try {
    const layout = layoutIn(root)
    const paths = runCredentialPaths(layout)
    const reading = await prepareRuntimeCredentials({
      layout,
      dshCredentialsFile: null,
      operatorHome: null,
      refs: [RUNTIME_MODEL_KEY_REF],
      openHandle: async () => fakeHandle(),
    })
    assert.equal(reading.ok, false)
    assert.equal(reading.code, RUN_CREDENTIAL_WIRING_CODES.OPERATOR_HOME_REQUIRED)
    assert.equal(readFileSync(paths.overlayFile, 'utf8'), RUN_CREDENTIAL_OVERLAY_NOOP)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('材料化那一步：覆盖层写不出来是**阻止启动**（`--patch` 会指向不存在的文件）', async () => {
  const root = tempRoot('overlayfail')
  try {
    const layout = layoutIn(root)
    const dsh = fakeDshDeclaration(root)
    // ★ 这一份 io **委托给真实 fs**，只让覆盖层那一次写入失败。
    //
    //   "只实现本模块用到的那三个方法"是错的：同一个 io 也会被交给材料化器，
    //   而它要用 `realpathSync` / `open` / `fsync` / `chmod` / `rename`。
    //   一个方法不全的 io 会让材料化器先抛 `TypeError`，于是这一条测到的是
    //   "材料化被拒绝"，而**测不到**它本来要测的那条覆盖层失败路径——
    //   一个把假对象当门面的用例，测的是那个假对象。
    const io = {
      ...realFs,
      mkdirSync: (p, o) => mkdirSync(p, o),
      writeFileSync: (p, text, enc) => {
        if (String(p).endsWith('credentials-path.patch.yml')) throw new Error('EACCES')
        return writeFileSync(p, text, enc)
      },
    }
    const reading = await prepareRuntimeCredentials({
      layout,
      dshCredentialsFile: join(root, 'operator-dsh', '.credentials.yaml'),
      operatorHome: join(root, 'operator-home'),
      refs: [RUNTIME_MODEL_KEY_REF],
      runtimeCommand: { file: 'node', args: [join(root, 'dsh', 'lib', 'bin.js')] },
      requireFn: dsh.requireFn,
      openHandle: async ({ refs }) => fakeHandle(refs),
      io,
    })
    assert.equal(reading.blocking, true)
    assert.equal(reading.code, RUN_CREDENTIAL_WIRING_CODES.OVERLAY_WRITE_FAILED)
    assert.equal(reading.diagnostics.length, 1)
    assert.equal(reading.diagnostics[0].severity, 'error')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- 生产默认

test('生产默认的句柄工厂：走**解析器**（库里没有才去读 DSH 的回退来源）', async () => {
  // 这一条守的是"哪条来源先答"。直接 `store.get` 也能开出句柄，差别是
  // "DSH 里有、Legion 库里没有"的那把钥匙会**消失**——静默、只表现为连不上模型。
  const seen = []
  const opener = productRunCredentialOpener({
    layout: { productHome: 'C:\\tmp\\.legion' },
    dshCredentialsFile: 'C:\\tmp\\operator\\.credentials.yaml',
    openSecrets: async (args) => {
      seen.push(args)
      return { ok: true, resolver: { resolveCredential: async (ref) => ({ ref, value: 'probe-value', source: 'store' }) } }
    },
  })
  const handle = await opener({ refs: [RUNTIME_MODEL_KEY_REF], runId: 'launch-probe' })
  assert.equal(handle.held(RUNTIME_MODEL_KEY_REF), true)
  assert.deepEqual([...handle.refs], [RUNTIME_MODEL_KEY_REF])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].requireProtected, true, '默认必须要求受保护后端')
  assert.equal(seen[0].dshCredentialsFile, 'C:\\tmp\\operator\\.credentials.yaml',
    '只读回退来源必须被传下去（否则路线 A′ 在运行时不存在）')
})

test('生产默认的句柄工厂：库里没有这条 ⇒ 具名拒绝（不是"空句柄"）', async () => {
  const opener = productRunCredentialOpener({
    layout: { productHome: 'C:\\tmp\\.legion' },
    openSecrets: async () => ({ ok: true, resolver: { resolveCredential: async () => null } }),
  })
  await assert.rejects(
    () => opener({ refs: [RUNTIME_MODEL_KEY_REF], runId: 'launch-probe' }),
    (e) => {
      // ★ 这个码来自**句柄模块**（`RUN_CREDENTIAL_*`，单数），
      //   与本文件那套 `RUN_CREDENTIALS_*`（复数）刻意不是一个前缀：
      //   前者说"这次运行的凭证集合解析失败"，后者说"接线这一步失败了"。
      //   两套码混用会让"接线没跑到"与"密钥解析不了"在日志里长得一样。
      assert.equal(e.code, 'RUN_CREDENTIAL_RESOLVE_FAILED',
        '解析器说"没有"必须是一条具名拒绝：空句柄会被下游当成"这次不需要凭证"')
      return true
    })
})

test('生产默认的句柄工厂：密钥库打不开 ⇒ 抛**具名码**（不原样带出库的 message）', async () => {
  const opener = productRunCredentialOpener({
    layout: { productHome: 'C:\\tmp\\.legion' },
    openSecrets: async () => ({ ok: false, code: 'SECRETS_STORE_UNPROTECTED', message: 'C:\\Users\\x\\.legion\\secrets' }),
  })
  await assert.rejects(
    () => opener({ refs: [RUNTIME_MODEL_KEY_REF], runId: 'launch-probe' }),
    (e) => {
      assert.equal(e.code, 'SECRETS_STORE_UNPROTECTED')
      assert.equal(e.message.includes('Users'), false, '不得把库路径原样带进错误消息')
      return true
    })
})


test('★★★ 生产默认的句柄工厂：**不注入任何东西**，真的走一遍 `openProductSecrets`', { skip: dpapiSkip }, async () => {
  // 上面那三条把 `openSecrets` 注入掉了。它们守的是**接线**（哪条来源先答、
  // 库里没有时具名拒绝、库打不开时只带码），但注入本身让另一件事**从来没有被执行**：
  // `productRunCredentialOpener` 自己的默认分支——
  //
  //     const mod = await import('../secrets.mjs')
  //     return mod.openProductSecrets({ layout, requireProtected, dshCredentialsFile })
  //
  //   > 一个"默认实现写在模块里"的分支，与一个"真的有人走过"的分支，
  //   > 在注入式用例上是同一个读数——只不过前者的用例是绿的，
  //   > 而那条 `await import` 从来没有被任何一次运行求值过。
  //
  // 本文件头的第 ① 条纪律（"接线在"要能被证明）在这个分支上原本是**空缺**的：
  // 注入式的三条全绿，而删掉那个默认分支、让它直接抛错，它们也全绿。
  //
  // 所以这一条**不传** `openSecrets`、也不传 `openRunCredentialsImpl`：真动态 import、
  // 真 `openProductSecrets`、真 `createProductSecretStore`（真 DPAPI）、真 `openRunCredentials`。
  // 值先按**真实写入路径**写进 Legion 自己的受保护库，再从默认分支读回来。
  const root = tempRoot('default-real')
  try {
    const layout = layoutIn(root)
    // 受保护库的父目录要存在（真实实现不会替调用方建目录）。
    mkdirSync(dirname(layout.secretsFile), { recursive: true })
    const store = createProductSecretStore({ file: layout.secretsFile })
    await store.put(RUNTIME_MODEL_KEY_REF, REAL_PATH_SECRET, { purpose: 'model-credential' })

    const opener = productRunCredentialOpener({ layout })
    const handle = await opener({ refs: [RUNTIME_MODEL_KEY_REF], runId: 'launch-real-default' })

    assert.equal(handle.held(RUNTIME_MODEL_KEY_REF), true,
      '默认分支没能把库里那条引用开出来——这条路径此前没有任何用例走过')
    // 反向对照：默认分支**不是**"对任何名字都开出一把钥匙"。
    assert.equal(handle.held('model/not-in-the-store'), false,
      '默认分支对库里没有的引用也说 held —— 那它没在读那个库')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('漂移：`RUNTIME_MODEL_KEY_REF` 必须与向导写进密钥库的那个引用名**逐字相等**', () => {
  // 两份手写的常量会漂移，而漂移的表现是"向导存了、运行时拿不到"——
  // 只在用户真的跑起来时才暴露。与材料化器那条读 `apiKeyEnv` 的用例同源。
  const cli = readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8')
  const m = cli.match(/const MODEL_KEY_REF = '([^']+)'/)
  assert.ok(m !== null, '在 cli.mjs 里找不到 MODEL_KEY_REF —— 那条声明被改名了？')
  assert.equal(RUNTIME_MODEL_KEY_REF, m[1],
    `本模块声明的引用名（${RUNTIME_MODEL_KEY_REF}）与向导写的（${m[1]}）不是同一个`)
  assert.deepEqual([...DEFAULT_RUNTIME_CREDENTIAL_REFS], [m[1]])
  assert.equal(WIRING_SOURCE.pathname.length > 0, true)
})

test('★★★★★ 缺口 ③：**DSH 自己的凭据提供方**真的从 Legion 材料化的那份文件里读到了值', async (t) => {
  // 这是本组此前唯一一条没关的缺口，也是整条线**唯一**一个不撒谎的判据。
  //
  // 前面所有用例证明的都是 Legion 这一侧：文件写出来了、覆盖层里有那一行 id 与
  // path、空补丁表是合法空操作。而这些在"DSH 根本读不到"时**全部成立**——
  //
  //   > 一条"我们把 DSH 指过去了"的断言，与一条"DSH 真的把钥匙拿到了"的断言，
  //   > 在 DSH 没读懂那份文档的那些部署里给出同一片绿——只不过前者的绿
  //   > 只说明了我们这一半，而钥匙没拿到的那一半没有任何读数。
  //
  // 判据因此必须落在 **DSH 的类**上，而不是我们自己再解析一遍那份 YAML
  // （那是"我们读自己的文件"，与"DSH 读得到"是两件事）。
  //
  // 需要 DSH 检出：没有 `DSH_CHECKOUT` 时**逐条 skip**，不伪造通过。
  // 一条"因为环境不在所以绿了"的用例，与一条"真的验过了"的用例，
  // 在摘要里都是 pass——所以这里显式 skip，让"这次到底跑了什么"看得见。
  const checkout = (process.env.DSH_CHECKOUT ?? '').trim()
  if (checkout === '') {
    t.skip('未配置 DSH_CHECKOUT：这一条要 DSH 自己的 dsh-credentials-local 才能验')
    return
  }
  // 从检出里解析 DSH 自己的凭据提供方（**不是**我们的复刻）。
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const baseBundle = join(checkout, 'packages', 'bundle', 'base')
  let credModule = null
  try {
    const req = createRequire(pathToFileURL(join(baseBundle, 'package.json')).href)
    credModule = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-credentials-local')).href)
  } catch (e) {
    t.skip(`检出不完整，解析不到 @deepseek-ai/dsh-credentials-local（${e?.code ?? e?.name}）`)
    return
  }
  const { LocalCredentialProvider } = credModule
  const ctxModule = await import(pathToFileURL(
    createRequire(pathToFileURL(join(baseBundle, 'package.json')).href).resolve('@deepseek-ai/cordis')).href)

  const root = tempRoot('dshreads')
  try {
    const layout = layoutIn(root)
    const dsh = fakeDshDeclaration(root)
    const reading = await prepareRuntimeCredentials({
      layout,
      dshCredentialsFile: join(root, 'operator-dsh', '.credentials.yaml'),
      operatorHome: join(root, 'operator-home'),
      runId: 'launch-dshreads',
      refs: [RUNTIME_MODEL_KEY_REF],
      runtimeCommand: { file: 'node', args: [join(root, 'dsh', 'lib', 'bin.js')] },
      requireFn: dsh.requireFn,
      openHandle: async ({ refs }) => fakeHandle(refs),
    })
    assert.equal(reading.applied, true, reading.message ?? '')

    // ① 覆盖层里**声明的那个路径**（从文档里读回来，不是从我们的记忆里）
    const paths = runCredentialPaths(layout)
    const overlayText = readFileSync(paths.overlayFile, 'utf8')
    const line = overlayText.match(/path:\s*(.+)$/m)
    assert.ok(line !== null, `覆盖层里没有 path：${overlayText}`)
    // 覆盖层写的是 YAML 双引号标量（值是 JSON.stringify 的路径）⇒ `\\` 是一个反斜杠
    let declared
    try { declared = JSON.parse(line[1].trim()) } catch { declared = line[1].trim().replace(/^["']|["']$/g, '') }
    assert.equal(declared, paths.targetFile,
      '覆盖层指的不是本次材料化的那一份文件——那 DSH 读到的会是别的（或不存在的）东西')

    // ② 用 **DSH 的** 提供方去读。真 cordis Context，不是手搓替身。
    const provider = new LocalCredentialProvider(new ctxModule.Context(), {
      path: declared,
      dshHome: join(root, 'operator-home', '.dsh'),
    })
    for (const fn of ['loadInitial', 'refresh']) {
      if (typeof provider[fn] === 'function') await provider[fn]()
    }
    // ③ 判据：DSH 按**它自己声明的那个名字**（假 DSH 声明里写的 PROBE_API_KEY）
    //    取到的值，必须是材料化时那一把。
    const got = await provider.resolve('PROBE_API_KEY')
    assert.notEqual(got, undefined,
      'DSH 的提供方从 Legion 那份文件里**一条都取不到**——覆盖层指过去了，但读不出来')
    assert.equal(got.source, 'file', `值不是从文件来的（source=${got.source}）`)
    assert.equal(got.value, 'probe-value-0', '取到的值不是材料化时写进去的那一把')

    // ④ 反向对照：**Legion 的引用名不是 DSH 的寻址名**。
    //    少了这条，上面那条可能只是"提供方对任何名字都返回同一把钥匙"。
    const byRef = await provider.resolve(RUNTIME_MODEL_KEY_REF)
    assert.equal(byRef, undefined,
      `DSH 竟然能用 Legion 的引用名（${RUNTIME_MODEL_KEY_REF}）取到值——`
      + '那说明写进文档的键不是 DSH 的可寻址名，而是我们的内部引用名')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
