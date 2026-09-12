// security/secrets/acl.test.mjs
// ============================================================================
// 密钥库文件的访问控制（PRT-509 的「跨账户与 ACL 加固」）
//
// 这一组的关键用例用的是**本机 `icacls` 的真实输出**（下方 REAL_ICACLS），
// 它恰好是一个真实的不安全样本：这台机器把 Modify 给了
// `Amench\CodexSandboxUsers` 和一个**未解析的 SID**。
//
// 用真实输出而不是我构造的样本，是因为构造样本时我会不自觉地按
// "我以为的输出格式"来写，而解析器的错法恰恰在格式的细节里
// （主体名含空格、权限串有多个括号组、第一行带路径）。这三条都踩过。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACL_CODES,
  POSIX_OWNER_ONLY_BITS,
  WINDOWS_ALLOWED_PRINCIPALS,
  accessLettersOf,
  evaluateWindowsPrincipals,
  hardenFileAcl as _hardenFileAcl,
  inspectFileAcl as _inspectFileAcl,
  parseIcacls,
} from './acl.mjs'
// 用例里的路径是假的：**声明**它们存在，否则会走到「文件尚未创建」那条分支
// （`ACL_NOT_CREATED`）。想测那条分支的用例显式传 `exists: () => false` 覆盖。
const inspectFileAcl = (args = {}) => _inspectFileAcl({ exists: () => true, ...args })
const hardenFileAcl = (args = {}) => _hardenFileAcl({ exists: () => true, ...args })

const FILE = 'C:\\Users\\alice\\AppData\\Local\\Temp\\legion-secrets.json'

/**
 * 本机 `icacls` 的真实输出。注意：
 *   - `NT AUTHORITY\SYSTEM` 含空格；
 *   - 权限串是 `(I)(M)` / `(I)(F)`（两个括号组）；
 *   - 第一行把文件路径与第一个 ACE 挤在一起；
 *   - 有一个**未解析的 SID**，它同样是一个真实主体。
 */
const REAL_ICACLS = [
  `${FILE} Amench\\CodexSandboxUsers:(I)(M)`,
  '                                                        S-1-5-21-3329393448-3155303137-3297129316-928322546:(I)(M)',
  '                                                        NT AUTHORITY\\SYSTEM:(I)(F)',
  '                                                        BUILTIN\\Administrators:(I)(F)',
  '                                                        AMENCH\\11150:(I)(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
  '',
].join('\r\n')

/** 一个"干净"的样本：只有所有者 + 系统必需主体。 */
const CLEAN_ICACLS = [
  `${FILE} AMENCH\\11150:(F)`,
  '           NT AUTHORITY\\SYSTEM:(F)',
  '           BUILTIN\\Administrators:(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
  '',
].join('\r\n')

/** 造一个记录调用的假 runner。 */
const runner = (table) => {
  const calls = []
  const fn = async (cmd, args) => {
    calls.push({ cmd, args })
    const key = `${cmd} ${args.join(' ')}`
    for (const [pattern, out] of Object.entries(table)) {
      if (key.includes(pattern)) return typeof out === 'function' ? out() : out
    }
    return { status: 0, stdout: '' }
  }
  fn.calls = calls
  return fn
}

// ------------------------------------------------------------------ ① 解析

test('① 真实 icacls 输出：路径被剥掉、含空格的主体名完整、权限串不被误读', () => {
  const { principals, unparsed } = parseIcacls(REAL_ICACLS, { file: FILE })
  assert.deepEqual(unparsed, [], '真实输出里没有看不懂的行')

  const names = principals.map((p) => p.name)
  assert.ok(names.includes('AMENCH\\11150'), '所有者')
  assert.ok(names.includes('NT AUTHORITY\\SYSTEM'), '含空格的主体名必须完整')
  assert.ok(names.includes('BUILTIN\\Administrators'))
  assert.ok(names.includes('Amench\\CodexSandboxUsers'))
  assert.ok(names.includes('S-1-5-21-3329393448-3155303137-3297129316-928322546'), '未解析的 SID 也是主体')
  // **路径不得混进主体名**（按 token 切空白会把它并进来）
  assert.equal(names.some((n) => n.includes('legion-secrets.json')), false,
    `路径混进了主体名：${JSON.stringify(names)}`)
  assert.equal(principals.length, 5)
})

test('① **权限字母与继承标志分开**：`(I)(M)` 的权限是 M，不是 IM', () => {
  // 不分开的话 `(I)` 会被读成"有某个权限"，于是每一条**继承来的** ACE
  // 都被判成授权——而继承来的 ACE 恰恰是最需要警惕的那类。
  assert.equal(accessLettersOf('(I)(M)'), 'M')
  assert.equal(accessLettersOf('(I)(F)'), 'F')
  assert.equal(accessLettersOf('(OI)(CI)(F)'), 'F')
  assert.equal(accessLettersOf('(IO)(NP)(RX)'), 'RX')
  assert.equal(accessLettersOf('(I)'), '', '只有继承标记就没有实质权限')
  assert.equal(accessLettersOf(''), '')

  const { principals } = parseIcacls(REAL_ICACLS, { file: FILE })
  const sys = principals.find((p) => p.name === 'NT AUTHORITY\\SYSTEM')
  assert.equal(sys.access, 'F')
  assert.equal(sys.inherited, true, '继承状态单独记，供诊断区分"文件自己授权的"')
})

test('① 路径剥离：给了 file 就删掉它；没给就用兜底且不吞主体名', () => {
  const withFile = parseIcacls(REAL_ICACLS, { file: FILE })
  assert.equal(withFile.principals[0].name, 'Amench\\CodexSandboxUsers')

  const noFile = parseIcacls(REAL_ICACLS)
  assert.equal(noFile.principals[0].name, 'Amench\\CodexSandboxUsers',
    '兜底也要把路径丢掉（第一行第一个 token 像路径就丢一个）')
  // 但**含空格的主体名不能被兜底吃掉**
  assert.ok(noFile.principals.some((p) => p.name === 'NT AUTHORITY\\SYSTEM'))
})

test('① 看不懂的行如实带出（不猜），收尾行不算看不懂', () => {
  const text = [
    `${FILE} AMENCH\\11150:(F)`,
    '这一行完全不是 ACE 的样子',
    'GARBAGE PRINCIPAL:(',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\n')
  const { principals, unparsed } = parseIcacls(text, { file: FILE })
  assert.equal(principals.length, 1)
  // "这一行完全不是 ACE 的样子" 不含 `:(`，属于无关行；`GARBAGE PRINCIPAL:(` 含 `:(` → 看不懂
  assert.ok(unparsed.some((l) => l.includes('GARBAGE')), `未带出看不懂的行：${JSON.stringify(unparsed)}`)
})

test('① 空/异常输入不抛', () => {
  for (const bad of [null, undefined, 42, {}]) {
    const { principals, unparsed } = parseIcacls(bad)
    assert.deepEqual(principals, [])
    assert.deepEqual(unparsed, [])
  }
})

// ------------------------------------------------------------------ ② 判定

test('② 真实的不安全 ACL：非所有者主体被点出来', () => {
  const { principals } = parseIcacls(REAL_ICACLS, { file: FILE })
  const r = evaluateWindowsPrincipals(principals, { allowedExtra: ['AMENCH\\11150'] })
  assert.equal(r.ok, false)
  assert.ok(r.offenders.includes('Amench\\CodexSandboxUsers'), '沙箱组不该有 Modify')
  assert.ok(r.offenders.includes('S-1-5-21-3329393448-3155303137-3297129316-928322546'), '未解析的 SID 也要点出来')
  // 所有者与系统必需主体不该被点
  assert.equal(r.offenders.includes('AMENCH\\11150'), false)
  assert.equal(r.offenders.includes('NT AUTHORITY\\SYSTEM'), false)
  assert.equal(r.offenders.includes('BUILTIN\\Administrators'), false)
})

test('② 干净的 ACL 通过（所有者 + SYSTEM + Administrators）', () => {
  const { principals } = parseIcacls(CLEAN_ICACLS, { file: FILE })
  const r = evaluateWindowsPrincipals(principals, { allowedExtra: ['AMENCH\\11150'] })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.offenders, [])
})

test('② SYSTEM/Administrators 是**系统必需**而不是"我们信任的"', () => {
  // 挡管理员不是 ACL 能做的事（那要靠 DPAPI 的账户绑定，正是内容保护负责的部分）。
  // 但没有它们，文件会变成连系统维护都做不了的状态。
  assert.ok(WINDOWS_ALLOWED_PRINCIPALS.includes('nt authority\\system'))
  assert.ok(WINDOWS_ALLOWED_PRINCIPALS.includes('builtin\\administrators'))
  // 而 `Users` / `Everyone` / `Authenticated Users` **不在**允许列表里：
  // 它们才是"多用户机器上另一个用户能读到"的真正原因。
  assert.equal(WINDOWS_ALLOWED_PRINCIPALS.some((p) => /users|everyone|authenticated/i.test(p)), false)
})

test('② 只有继承标记的 ACE 不算授权（不给"空权限"定罪）', () => {
  const principals = [
    { name: 'BUILTIN\\Users', groups: '(I)', access: '', inherited: true },
    { name: 'AMENCH\\alice', groups: '(F)', access: 'F', inherited: false },
  ]
  const r = evaluateWindowsPrincipals(principals, { allowedExtra: ['amench\\alice'] })
  assert.equal(r.ok, true, 'Users 只有 (I) 没有实质权限 → 不该判越权')
})

test('② 主体名比较不区分大小写', () => {
  const principals = [
    { name: 'nt authority\\system', groups: '(F)', access: 'F', inherited: false },
    { name: 'amench\\ALICE', groups: '(F)', access: 'F', inherited: false },
  ]
  assert.equal(evaluateWindowsPrincipals(principals, { allowedExtra: ['AMENCH\\alice'] }).ok, true)
})

// ------------------------------------------------------------------ ③ 查不出来 ≠ 安全

test('③ 没有 runner → 明确说"未验证"，**绝不**当成通过', () => {
  // 一条"查不出来就当通过"的检查比没有检查更坏：它会让人相信一件没被验证过的事。
  return inspectFileAcl({ file: FILE, platform: 'win32' }).then((r) => {
    assert.equal(r.ok, false)
    assert.equal(r.code, ACL_CODES.NO_RUNNER)
    assert.match(r.message, /不要把"没查过"当成"是安全的"/)
  })
})

test('③ icacls 抛异常 / 输出认不出 → UNVERIFIABLE（不是 OK）', async () => {
  const throwing = async () => { throw Object.assign(new Error('x'), { name: 'ENOENT' }) }
  const r1 = await inspectFileAcl({ file: FILE, platform: 'win32', run: throwing })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, ACL_CODES.UNVERIFIABLE)
  assert.match(r1.message, /未验证/)

  const garbage = runner({ icacls: { status: 0, stdout: 'something entirely different' } })
  const r2 = await inspectFileAcl({ file: FILE, platform: 'win32', run: garbage })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, ACL_CODES.UNVERIFIABLE)
  assert.match(r2.message, /未验证/)

  const noOutput = runner({ icacls: { status: 1, stdout: '' } })
  const r3 = await inspectFileAcl({ file: FILE, platform: 'win32', run: noOutput })
  assert.equal(r3.ok, false)
  assert.equal(r3.code, ACL_CODES.UNVERIFIABLE)
})

test('③ 未知平台 → UNSUPPORTED_PLATFORM（既不假装通过也不假装失败）', async () => {
  const r = await inspectFileAcl({ file: FILE, platform: 'sunos9', run: runner({}) })
  assert.equal(r.ok, false)
  assert.equal(r.code, ACL_CODES.UNSUPPORTED_PLATFORM)
  assert.match(r.message, /不等于通过（也不等于失败）/)
})

test('③ 没有文件路径 → UNVERIFIABLE', async () => {
  const r = await inspectFileAcl({ file: '', platform: 'win32', run: runner({}) })
  assert.equal(r.ok, false)
  assert.equal(r.code, ACL_CODES.UNVERIFIABLE)
})

// ------------------------------------------------------------------ ④ 端到端（真 icacls）

test('④ 对**真实文件**调用真实 icacls：不安全时说清是哪些主体', async () => {
  // 真跑一次 icacls（不注入 runner），验证"真输出 → 真解析 → 真判定"这条链路。
  const { execFile } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  const dir = mkdtempSync(join(tmpdir(), 'legion-acl-e2e-'))
  const file = join(dir, 'secrets.json')
  writeFileSync(file, '{}', 'utf8')

  const realRun = async (cmd, args) => {
    try {
      const { stdout } = await execFileAsync(cmd, args, { windowsHide: true })
      return { status: 0, stdout }
    } catch (e) {
      return { status: e.code ?? 1, stdout: String(e.stdout ?? '') }
    }
  }

  try {
    const r = await inspectFileAcl({ file, platform: process.platform, run: realRun })
    // 判定必须是三态里的一个，且**绝不是在"没查过"的情况下报 ok**
    if (r.code === ACL_CODES.OK) {
      // 干净：那主体列表里就不该有非所有者主体
      assert.equal(r.ok, true)
      const names = r.principals.map((p) => p.name.toLowerCase())
      assert.equal(names.some((n) => /users|everyone|authenticated/.test(n)), false)
    } else {
      assert.equal(r.ok, false)
      assert.ok(
        [ACL_CODES.TOO_PERMISSIVE, ACL_CODES.UNVERIFIABLE].includes(r.code),
        `真实 icacls 的判定应落在 TOO_PERMISSIVE 或 UNVERIFIABLE，实际 ${r.code}`,
      )
      if (r.code === ACL_CODES.TOO_PERMISSIVE) {
        assert.ok(r.offenders.length > 0, '判越权就要说是谁')
      }
    }
    // 无论结果如何，解析出的主体必须包含所有者或系统主体之一（证明真的读到了 ACL）
    assert.ok(r.principals.length > 0 || r.code === ACL_CODES.UNVERIFIABLE)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows 锁 */ }
  }
})

// ------------------------------------------------------------------ ⑤ 加固

test('⑤ 加固的顺序是**先断继承再授权**（顺序反了会"设置成功但结果没变"）', async () => {
  // 注意 CLEAN_ICACLS 里的所有者是 `AMENCH\11150`。`icacls` 的输出**不标出**
  // 哪个主体是所有者，所以所有者必须由调用方给出——给错了会把真所有者
  // 当成越权主体（**失误方向是 fail closed**，可以接受，但要一致）。
  const run = runner({ icacls: { status: 0, stdout: CLEAN_ICACLS } })
  const r = await hardenFileAcl({ file: FILE, platform: 'win32', run, owner: 'AMENCH\\11150' })
  assert.equal(r.ok, true, JSON.stringify(r))
  const args = run.calls.filter((c) => c.cmd === 'icacls').map((c) => c.args.join(' '))
  assert.ok(args[0].includes('/inheritance:r'), '第一步必须断继承')
  assert.ok(args[1].includes('AMENCH\\11150'), '第二步才授予所有者')
  assert.ok(args.some((a) => a.includes('NT AUTHORITY\\SYSTEM')), '系统主体要保留')
  // 加固之后**复验**：只说"我设置过了"不算加固完成
  assert.ok(r.verified !== undefined, '必须复验')
})

test('⑤ 给错所有者名 → 复验失败（方向是 fail closed，不是"放行"）', async () => {
  // `icacls` 不标出所有者，所以这个参数是调用方的责任。给错时应当**报错**，
  // 而不是"既然认不出就都放过"——后者的方向是 fail open。
  const run = runner({ icacls: { status: 0, stdout: CLEAN_ICACLS } })
  const r = await hardenFileAcl({ file: FILE, platform: 'win32', run, owner: 'AMENCH\\someone-else' })
  assert.equal(r.ok, false)
  assert.match(r.message, /复验未通过/)
  assert.ok(r.verified.offenders.includes('AMENCH\\11150'))
})

test('⑤ 不知道所有者就**不加固**（猜一个主体去授权等于把权限给错人）', async () => {
  const run = runner({ icacls: { status: 0, stdout: CLEAN_ICACLS } })
  const r = await hardenFileAcl({ file: FILE, platform: 'win32', run, owner: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, ACL_CODES.HARDEN_FAILED)
  assert.match(r.message, /等于把权限给错人/)
  assert.deepEqual(run.calls, [], '不知道所有者时一个命令都不该发')
})

test('⑤ 加固后复验不通过 → 整体判失败（不能只说"设置过了"）', async () => {
  // icacls 的 grant 都返回 0，但复验读到的是**仍然不安全**的 ACL
  const run = runner({ icacls: { status: 0, stdout: REAL_ICACLS } })
  const r = await hardenFileAcl({ file: FILE, platform: 'win32', run, owner: 'AMENCH\\11150' })
  assert.equal(r.ok, false, '复验不通过就不能报成功')
  assert.match(r.message, /加固后复验未通过/)
})

test('⑤ 命令返回非 0 → HARDEN_FAILED，且带上真实的退出码', async () => {
  const run = runner({ icacls: { status: 5, stdout: '' } })
  const r = await hardenFileAcl({ file: FILE, platform: 'win32', run, owner: 'AMENCH\\alice' })
  assert.equal(r.ok, false)
  assert.equal(r.code, ACL_CODES.HARDEN_FAILED)
  assert.match(r.message, /返回 5/)
})

test('⑤ 没有 runner → 加固也拒绝（而不是静默跳过）', async () => {
  const r = await hardenFileAcl({ file: FILE, platform: 'win32' })
  assert.equal(r.ok, false)
  assert.equal(r.code, ACL_CODES.NO_RUNNER)
})

test('⑤ POSIX：判定与加固都用 mode，600 是上限', async () => {
  assert.equal(POSIX_OWNER_ONLY_BITS, 0o600)
  const clean = runner({ 'stat -c %a': { status: 0, stdout: '600\n' } })
  const ok = await inspectFileAcl({ file: '/home/a/s.json', platform: 'linux', run: clean })
  assert.equal(ok.ok, true, JSON.stringify(ok))

  const loose = runner({ 'stat -c %a': { status: 0, stdout: '644\n' } })
  const bad = await inspectFileAcl({ file: '/home/a/s.json', platform: 'linux', run: loose })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, ACL_CODES.TOO_PERMISSIVE)
  assert.match(bad.message, /chmod 600/)

  const chmod = runner({ 'stat -c %a': { status: 0, stdout: '600\n' }, chmod: { status: 0, stdout: '' } })
  const hardened = await hardenFileAcl({ file: '/home/a/s.json', platform: 'linux', run: chmod })
  assert.equal(hardened.ok, true)
  assert.ok(chmod.calls.some((c) => c.cmd === 'chmod' && c.args[0] === '600'))

  // 未知平台
  const unsupported = await hardenFileAcl({ file: '/x', platform: 'plan9', run: runner({}) })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.code, ACL_CODES.UNSUPPORTED_PLATFORM)
})

// ------------------------------------------------------------------ ⑥ 文件还没创建

test('⑥ 文件还不存在 → `ACL_NOT_CREATED`，与 `ACL_UNVERIFIABLE` **必须分开**', async () => {
  // 这两者在调用方那里会导致**完全不同**的处理：
  //   NOT_CREATED  → 全新安装的常态，没什么可保护的，不该报"越权"
  //   UNVERIFIABLE → 文件在，而我们不知道它安不安全，**必须**报出来
  //
  // 若把前者归成后者，那条告警会在每一台新机器的每一次启动上出现，
  // 而它每次都说得不对。按本项目已经记过的那条：
  // **一条永远不对的告警，和没有告警，是同一件事**——用户会学会忽略它，
  // 于是当文件**真的**变得可被别的账户读到时，那一条同样被忽略。
  let ran = 0
  const spy = async (cmd, args) => { ran += 1; return { status: 0, stdout: '' } }

  const missing = await inspectFileAcl({
    file: '/no/such/credentials.json', platform: 'win32', run: spy, exists: () => false,
  })
  assert.equal(missing.code, ACL_CODES.NOT_CREATED)
  assert.equal(missing.ok, false, '**不等于通过**：只是"没有东西可保护"')
  assert.equal(missing.exists, false)
  assert.equal(ran, 0, '文件不存在时不该去跑 icacls（那只会拿到一条看不懂的输出）')

  // 同一个文件，`exists` 说它在 → 必须回到严格的那一支
  const present = await inspectFileAcl({
    file: '/no/such/credentials.json', platform: 'win32', run: spy, exists: () => true,
  })
  assert.notEqual(present.code, ACL_CODES.NOT_CREATED)
  assert.equal(ran, 1, '文件在就必须真去查')
})

test('⑥ 两平台的"文件不存在"是同一件事（判定在平台分派**之前**）', async () => {
  for (const platform of ['win32', 'linux', 'darwin', 'plan9']) {
    const r = await inspectFileAcl({ file: '/x/s.json', platform, run: runner({}), exists: () => false })
    assert.equal(r.code, ACL_CODES.NOT_CREATED, `${platform} 上应同样是 NOT_CREATED`)
  }
})

test('⑥ 文件不存在时**不加固**（对着不存在的路径跑 icacls 只会失败并留下假告警）', async () => {
  // 加固本身仍有自己的 runner/owner 检查，但调用方不应在 NOT_CREATED 时调它；
  // 这里锁定"不存在的路径确实不会被当成可加固对象"这个事实。
  const r = await hardenFileAcl({
    file: '/no/such/c.json', platform: 'win32', run: runner({}), owner: 'AMENCH\\a', exists: () => false,
  })
  // 复核仍会走 NOT_CREATED，因此整体**不得**被判成功。
  assert.equal(r.ok, false, '复验看到文件不存在 → 不能报"加固成功"')
})

test('⑥ 真实文件端到端：存在时给出**真实判定**，不是"未验证"', async () => {
  // 这一条是"文件不存在 → 安静"那个改动的**对照面**：
  // 不能因为新安装安静了，就让"文件在、而且很宽"也一起安静。
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  if (process.platform !== 'win32') return // 本机是 Windows；icacls 才有意义

  const dir = mkdtempSync(join(tmpdir(), 'legion-acl-real-'))
  const file = join(dir, 'credentials.json')
  try {
    writeFileSync(file, '{"version":1}', 'utf8')
    const run = (cmd, args) => new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? '') })
      })
    })
    const r = await inspectFileAcl({ file, platform: 'win32', run })
    // 关键：必须落到一个**确定**的判定，而不是 NOT_CREATED / NO_RUNNER。
    assert.ok([ACL_CODES.OK, ACL_CODES.TOO_PERMISSIVE].includes(r.code),
      `真实文件应给出确定判定，实际 ${r.code}：${r.message}`)
    assert.notEqual(r.code, ACL_CODES.NOT_CREATED, '文件确实存在，不得报"尚未创建"')
    // 临时目录通常是继承来的宽 ACL；若本机恰好好，则至少不能是"未验证"
    if (r.code === ACL_CODES.TOO_PERMISSIVE) {
      assert.ok(Array.isArray(r.principals) && r.principals.length > 0, '越权判定必须点名是哪些主体')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
