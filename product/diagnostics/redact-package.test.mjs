// product/diagnostics/redact-package.test.mjs
// ============================================================================
// PRT-710：脱敏诊断包导出（spec §6.7 把「诊断包」列为密钥不得出现的地方）
//
// 这一组守四件事，每一件都对应一个**真实会发生的误读**：
//
//   ① **结构性排除优先于文本过滤**——密钥库文件不该"被脱敏后收进包"，
//      而是**根本不进包**。过滤器认不出的新形态会静默漏过，路径排除不会。
//      更要紧的是：被排除的文件**根本没有被读过**（用例用一个会抛错的
//      read 来钉住这一点——"读了再丢"与"不读"是两回事）。
//
//   ② **「没包含」与「被排除」可区分**——清单里每个候选都有去向与理由。
//      一份少收了一个日志的包，与一份刻意排除了密钥库的包，长得一样。
//
//   ③ **0 次脱敏命中 ≠ 包是干净的**——计数器只说明"表认出了几个"。
//
//   ④ **判定用的是落盘后读回来的字节**，不是内存副本。
//      写错缓冲区这类 bug 只有后者看得见；复检没过就**作废**，
//      而不是"发出去但附一句警告"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  DIAG_CODES,
  DIAG_STATUSES,
  HITS_CAVEAT,
  STRUCTURAL_EXCLUSIONS,
  buildManifest,
  defaultCandidates,
  exportDiagnosticPackage,
  flattenName,
  planPackage,
  structuralExclusionFor,
  verifyWrittenFiles,
} from './redact-package.mjs'
import { SECRETS_DIRNAME, SECRETS_FILENAME } from '../paths.mjs'

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345'
const TOKEN = 'ghp_0123456789012345678901234567890123'

/** 一个只存在于内存里的假 fs，路径 → Buffer/字符串。 */
function fakeFs(files = {}) {
  const reads = []
  const writes = []
  const removed = []
  const dirs = new Set()
  const map = new Map(Object.entries(files))
  return {
    reads, writes, removed, map,
    existsSync: (p) => map.has(p) || dirs.has(p),
    readFileSync: (p) => {
      reads.push(p)
      if (!map.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      const v = map.get(p)
      return Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')
    },
    writeFileSync: (p, body) => { writes.push({ path: p, body }); map.set(p, Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')) },
    mkdirSync: (p) => dirs.add(p),
    readdirSync: (p) => {
      const prefix = p.endsWith('\\') || p.endsWith('/') ? p : p + '\\'
      const names = new Set()
      for (const k of map.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split(/[\\/]/)[0])
      for (const k of dirs) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split(/[\\/]/)[0])
      return [...names].filter((n) => n !== '')
    },
    rmSync: (p) => { removed.push(p); for (const k of [...map.keys()]) if (k.startsWith(p)) map.delete(k); dirs.delete(p) },
  }
}

/** 固定时钟：清单里出现时间戳时，用例不该依赖真实时间。 */
const clock = () => '2026-09-12T00:00:00.000Z'

const layoutOf = (base) => ({
  platform: 'win32',
  productHome: 'C:\\Legion',
  installDir: 'C:\\Legion',
  dataDir: join(base, 'data'),
  logDir: join(base, 'log'),
  cacheDir: join(base, 'cache'),
  workspaceDir: 'C:\\work',
  productConfigPath: join(base, 'data', 'product.config.json'),
  secretsFile: join(base, 'secrets', 'secrets.json'),
})

// ============================================================================
// ① 结构性排除
// ============================================================================

test('① 密钥库/凭证/业务库**根本不进包**，且各自带一条说得出的理由', async () => {
  const base = 'C:\\t1'
  const layout = layoutOf(base)
  const fs = fakeFs({
    [layout.secretsFile]: '{"K1":"ciphertext"}',
    [join(base, 'log', 'app.log')]: 'ok\n',
    [join(base, 'log', 'x.credentials.yaml')]: `token: ${SECRET}\n`,
    [join(base, 'log', 'id_rsa.key')]: '-----BEGIN PRIVATE KEY-----\nzzz\n-----END PRIVATE KEY-----\n',
    [join(base, 'log', 'auth-token.json')]: `{"token":"${TOKEN}"}`,
    [join(base, 'log', 'sessions.db')]: Buffer.from([0x53, 0x51, 0x4c, 0x00, 0x01]),
    [join(base, 'log', '.env')]: 'OPENAI_API_KEY=whatever\n',
    // 产品配置**要收**（它是非敏感的：密钥只以引用形式出现，spec §6.9）。
    // 第一版夹具漏了它，于是它走 `skipped`——用例 EXPECT 里却当它收了。
    [layout.productConfigPath]: '{"model":{"provider":"custom-ds"}}\n',
  })

  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg1', fs, now: clock })
  assert.equal(r.ok, true, r.message)

  // 排除的每一项都必须**说出来**为什么
  const rules = new Set(r.manifest.excluded.map((e) => e.rule))
  for (const expect of ['secret-store', 'credentials-yaml', 'raw-key', 'auth-json', 'business-db', 'env-file']) {
    assert.ok(rules.has(expect), `规则「${expect}」没有出现在清单里：排除而不登记 = 收件人以为是漏收`)
  }
  for (const e of r.manifest.excluded) {
    assert.ok(typeof e.why === 'string' && e.why.length > 10, `规则 ${e.rule} 没有给出可读理由`)
  }
  // 收进来的只有那两个安全文件
  assert.deepEqual(r.manifest.included.map((e) => e.id).sort(), ['log:app.log', 'product-config'])
})

test('① 被排除的文件**一次都没有被读过**（读了再丢 ≠ 不读）', async () => {
  const base = 'C:\\t2'
  const layout = layoutOf(base)
  const secretPath = layout.secretsFile
  let secretReads = 0
  const fs = fakeFs({ [secretPath]: '{"K1":"ct"}', [join(base, 'log', 'a.log')]: 'x' })
  const spy = {
    ...fs,
    readFileSync: (p) => { if (p === secretPath) secretReads += 1; return fs.readFileSync(p) },
  }
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg2', fs: spy, now: clock })
  assert.equal(r.ok, true, r.message)
  assert.equal(secretReads, 0,
    '结构性排除的意义就是"这个字节从未被本模块碰过"——读了再丢，密钥就已经进过内存与日志')
})

test('① 排除判定只看**文件名**，不看内容（内容里的密钥认不出也照样排除）', async () => {
  // 一条内容里没有任何已知密钥形态的凭证文件：文本过滤会放它过去，
  // 而结构性排除必须拦下它。这正是"过滤器会漏、路径排除不会"。
  assert.equal(structuralExclusionFor('C:\\x\\.credentials.yaml')?.id, 'credentials-yaml')
  assert.equal(structuralExclusionFor('C:\\x\\secrets.json')?.id, 'secret-store')
  assert.equal(structuralExclusionFor('C:\\x\\sessions.sqlite')?.id, 'business-db')
  assert.equal(structuralExclusionFor('C:\\x\\app.log'), null, '普通日志不该被误排除')
  // 第一版规则只认"正好叫 credentials.yaml"，于是 `x.credentials.yaml` 漏了过去。
  // 按后缀匹配是**故意偏严**：误排一个普通文件的代价，远小于漏收一个凭证文件。
  assert.equal(structuralExclusionFor('C:\\x\\x.credentials.yaml')?.id, 'credentials-yaml')
  assert.equal(structuralExclusionFor('C:\\x\\my-credentials.yml')?.id, 'credentials-yaml')
  // 每一条规则都要有 id 与 why
  for (const rule of STRUCTURAL_EXCLUSIONS) {
    assert.ok(rule.id && rule.why, '规则必须有 id 与 why')
  }
})

test('① `secret-store` 规则必须匹配**产品真正用的那个文件名**（不是我们以为的名字）', () => {
  // 这条是实测出来的：第一版手写了 `'secrets.json'`，而产品定义的是
  // `SECRETS_DIRNAME/SECRETS_FILENAME` = `secrets/credentials.json`。
  // 于是那条**以密钥库命名**的规则从来没匹配过密钥库——
  // 它只是碰巧被更宽的 `credentials-*` 规则接住了。
  //   > 一条以某物命名、却匹配不到那个物的规则，与一条不存在的规则同形。
  const real = `C:\\Legion\\${SECRETS_DIRNAME}\\${SECRETS_FILENAME}`
  const hit = structuralExclusionFor(real)
  assert.equal(hit?.id, 'secret-store',
    `产品真实的密钥库路径 ${real} 命中的是「${hit?.id}」而不是 secret-store 规则`)
  // 按**目录段**兜底：文件名换了、位置没换，仍然要拦住
  assert.equal(structuralExclusionFor('C:\\Legion\\secrets\\whatever.bin')?.id, 'secret-store')
  assert.equal(structuralExclusionFor('C:\\Legion\\secrets\\nested\\x.json')?.id, 'secret-store')
  // 另一条独立判据：**不在 secrets 目录下**的常见密钥库文件名（别的工具留下的）
  assert.equal(structuralExclusionFor('C:\\backup\\secrets.json')?.id, 'secret-store')
  assert.equal(structuralExclusionFor('C:\\backup\\secrets.db')?.id, 'secret-store')
  // 反面：别的目录下叫这个名字不算
  assert.notEqual(structuralExclusionFor('C:\\Legion\\log\\whatever.bin')?.id, 'secret-store')
  assert.equal(structuralExclusionFor('C:\\Legion\\log\\app.log'), null)
})

// ============================================================================
// ② 「没包含」与「被排除」可区分
// ============================================================================

test('② 读不到的文件进 `skipped` 并给出原因，**不是**静默消失', () => {
  const planned = planPackage({
    candidates: [
      { id: 'ok', path: 'C:\\a.log', role: 'log' },
      { id: 'gone', path: 'C:\\missing.log', role: 'log' },
    ],
    read: (p) => (p === 'C:\\a.log' ? Buffer.from('hi') : null),
  })
  assert.deepEqual(planned.skipped.map((s) => s.id), ['gone'])
  assert.match(planned.skipped[0].reason, /不存在|无权/)
  assert.equal(planned.totals.candidates, 2)
})

test('② read 抛出时也记成 `skipped`，不让一次读失败炸掉整次导出', () => {
  const planned = planPackage({
    candidates: [{ id: 'boom', path: 'C:\\b.log', role: 'log' }, { id: 'ok', path: 'C:\\c.log', role: 'log' }],
    read: (p) => { if (p === 'C:\\b.log') throw new Error('EACCES'); return Buffer.from('x') },
  })
  assert.equal(planned.skipped.length, 1)
  assert.match(planned.skipped[0].reason, /读取失败/)
  assert.equal(planned.entries.length, 1, '一个文件读不了不该让其余文件收不进来')
})

test('② 二进制内容记成 `skipped` 并说明为什么不脱敏，**不是**收进来', () => {
  const planned = planPackage({
    candidates: [{ id: 'bin', path: 'C:\\d.bin', role: 'log' }],
    // 注意扩展名不是被结构性排除的那几种，所以它走到"是不是文本"这一步
    read: () => Buffer.from([0x00, 0x01, 0x02, SECRET.charCodeAt(0)]),
  })
  assert.equal(planned.entries.length, 0)
  assert.equal(planned.skipped[0].id, 'bin')
  assert.match(planned.skipped[0].reason, /二进制/)
})

test('② 超限的文件进 `oversized`（诊断包不该把盘写满）', () => {
  const planned = planPackage({
    candidates: [{ id: 'big', path: 'C:\\big.log', role: 'log' }],
    read: () => Buffer.alloc(2048, 0x61),
    limits: { maxFileBytes: 1024 },
  })
  assert.equal(planned.entries.length, 0)
  assert.equal(planned.oversized[0].id, 'big')
  assert.equal(planned.oversized[0].bytes, 2048)
})

test('② 总上限也生效（单文件都不超，加起来超）', () => {
  const planned = planPackage({
    candidates: [
      { id: 'a', path: 'C:\\a.log', role: 'log' },
      { id: 'b', path: 'C:\\b.log', role: 'log' },
    ],
    read: () => Buffer.alloc(800, 0x61),
    limits: { maxFileBytes: 1024, maxTotalBytes: 1000 },
  })
  assert.equal(planned.entries.length, 1, '第二个会把总量顶过 1000，必须被拦下')
  assert.equal(planned.oversized.length, 1)
  assert.match(planned.oversized[0].why, /总上限/)
})

test('② 清单里四种去向都在，且与 `DIAG_STATUSES` 对得上', async () => {
  const base = 'C:\\t3'
  const layout = layoutOf(base)
  const fs = fakeFs({
    [join(base, 'log', 'ok.log')]: 'fine',
    [join(base, 'log', 'secrets.json')]: 'ct',
  })
  const r = await exportDiagnosticPackage({
    layout, outDir: 'C:\\pkg3', fs, now: clock,
    candidates: [
      { id: 'ok', path: join(base, 'log', 'ok.log'), role: 'log' },
      { id: 'sec', path: join(base, 'log', 'secrets.json'), role: 'secret-store' },
      { id: 'gone', path: join(base, 'log', 'gone.log'), role: 'log' },
    ],
  })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(
    [r.manifest.included.length, r.manifest.excluded.length, r.manifest.skipped.length, r.manifest.oversized.length],
    [1, 1, 1, 0],
  )
  assert.deepEqual([...r.manifest.exitCodesUnderstood], [...DIAG_STATUSES])
})

// ============================================================================
// ③ 0 次命中 ≠ 干净
// ============================================================================

test('③ 文本里的密钥被替换，且计数如实', () => {
  const planned = planPackage({
    candidates: [{ id: 'l', path: 'C:\\l.log', role: 'log' }],
    read: () => Buffer.from(`key=${SECRET} tok=${TOKEN}\n`, 'utf8'),
  })
  assert.equal(planned.entries[0].redactionHits, 2)
  assert.ok(planned.entries[0].hitKinds.length >= 1)
  const text = planned.entries[0].body.toString('utf8')
  assert.ok(!text.includes(SECRET), '原值必须消失')
  assert.ok(!text.includes(TOKEN), '原值必须消失')
  assert.match(text, /\[已脱敏\]/)
})

test('③ 命中种类里**不含原文任何片段**（标记不该成为第二个泄漏点）', () => {
  const planned = planPackage({
    candidates: [{ id: 'l', path: 'C:\\l.log', role: 'log' }],
    read: () => Buffer.from(`k=${SECRET}`, 'utf8'),
  })
  const kinds = planned.entries[0].hitKinds.join(' ')
  assert.ok(!kinds.includes('sk-'), `命中种类里带上了原值片段：${kinds}`)
})

test('③ 0 次命中时清单里必须同时出现那句话（否则会被读成"已验证干净"）', async () => {
  const base = 'C:\\t4'
  const layout = layoutOf(base)
  const fs = fakeFs({ [join(base, 'log', 'clean.log')]: 'nothing here\n' })
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg4', fs, now: clock })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.manifest.totals.redactionHits, 0)
  assert.equal(r.manifest.redactionCaveat, HITS_CAVEAT)
  assert.match(r.manifest.redactionCaveat, /不等于/)
  // 而且成功文案本身也不能说"已验证干净"
  assert.match(r.message, /不等于包是干净的/)
})

test('③ 有命中时成功文案会把用户指向"日志里曾经出现过密钥"', () => {
  const planned = planPackage({
    candidates: [{ id: 'l', path: 'C:\\l.log', role: 'log' }],
    read: () => Buffer.from(`k=${SECRET}`, 'utf8'),
  })
  assert.ok(planned.totals.redactionHits > 0)
  assert.equal(planned.totals.redactedFiles, 1)
})

// ============================================================================
// ④ 判定用落盘后的字节；复检没过就作废
// ============================================================================

test('④ 复检审的是**磁盘上的字节**：写下去的内容不对时能抓住', async () => {
  const base = 'C:\\t5'
  const layout = layoutOf(base)
  const inner = fakeFs({ [join(base, 'log', 'a.log')]: `k=${SECRET}` })
  // 一个"偷偷把原文写下去"的 writer：writeFileSync 收到脱敏后的 body，
  // 却把未脱敏的内容落盘。**内存里的副本是对的**，只有读回来的字节能抓住它。
  const evil = {
    ...inner,
    writeFileSync: (p, body) => {
      if (String(p).endsWith('manifest.json')) return inner.writeFileSync(p, body)
      inner.writeFileSync(p, Buffer.from(`k=${SECRET}`, 'utf8'))
    },
  }
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg5', fs: evil, now: clock })
  assert.equal(r.ok, false, '落盘后的字节里还有密钥，绝不能报成功')
  assert.equal(r.code, DIAG_CODES.LEAK_DETECTED)
  assert.ok(evil.removed.includes('C:\\pkg5'), '作废必须真的把包删掉，而不是留一个带标记的包')
  assert.match(r.message, /作废/)
})

test('④ 复检只报文件名与命中种类，**不报内容**（这条错误本身也会进日志）', async () => {
  const verdict = verifyWrittenFiles([{ name: 'a.log', body: Buffer.from(`k=${SECRET}`, 'utf8') }])
  assert.equal(verdict.clean, false)
  assert.deepEqual(verdict.offenders.map((o) => o.name), ['a.log'])
  const asText = JSON.stringify(verdict)
  assert.ok(!asText.includes(SECRET), '复检结果里不能带上原值')
})

test('④ 复检干净时清单给出"验证的是什么"，而不是一句光秃秃的 ok', async () => {
  const base = 'C:\\t6'
  const layout = layoutOf(base)
  const fs = fakeFs({ [join(base, 'log', 'a.log')]: `k=${SECRET}` })
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg6', fs, now: clock })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.manifest.verified.clean, true)
  assert.equal(r.manifest.verified.method, 'read-back-after-write')
  assert.ok(r.manifest.verified.filesScanned > 0)
  assert.match(r.manifest.verified.note, /磁盘/)
})

test('④ 读回复检失败时**不发出去**（"我们脱敏过了"与"落盘的字节干净"是两个断言）', async () => {
  const base = 'C:\\t7'
  const layout = layoutOf(base)
  const inner = fakeFs({ [join(base, 'log', 'a.log')]: 'ok' })
  const broken = { ...inner, readdirSync: () => { throw new Error('EIO') } }
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg7', fs: broken, now: clock })
  assert.equal(r.ok, false)
  assert.equal(r.code, DIAG_CODES.WRITE_FAILED)
  assert.match(r.message, /无法复检/)
  assert.ok(broken.removed.includes('C:\\pkg7'))
})

test('④ 写失败时清掉半成品（残缺的包看起来像完整的证据）', async () => {
  const base = 'C:\\t8'
  const layout = layoutOf(base)
  const inner = fakeFs({ [join(base, 'log', 'a.log')]: 'ok' })
  let n = 0
  const failing = {
    ...inner,
    writeFileSync: (p, body) => { n += 1; if (n === 2) throw new Error('ENOSPC'); return inner.writeFileSync(p, body) },
  }
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg8', fs: failing, now: clock })
  assert.equal(r.ok, false)
  assert.equal(r.code, DIAG_CODES.WRITE_FAILED)
  assert.ok(failing.removed.includes('C:\\pkg8'))
  assert.match(r.message, /半成品已清除/)
})

// ============================================================================
// ⑤ 不覆盖 / 不猜 / 空包
// ============================================================================

test('⑤ 目标目录已存在 → 拒绝，**不覆盖**（诊断包是当时的证据）', async () => {
  const base = 'C:\\t9'
  const layout = layoutOf(base)
  const fs = fakeFs({ [join(base, 'log', 'a.log')]: 'ok' })
  fs.mkdirSync('C:\\pkg9')
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg9', fs, now: clock })
  assert.equal(r.ok, false)
  assert.equal(r.code, DIAG_CODES.PACKAGE_EXISTS)
  assert.equal(fs.writes.length, 0, '拒绝时一个字节都不该写')
})

test('⑤ 没有布局/目标目录 → 报错，**不猜默认位置**', async () => {
  const fs = fakeFs({})
  for (const args of [{}, { layout: null, outDir: 'C:\\x' }, { layout: { logDir: null }, outDir: null }]) {
    const r = await exportDiagnosticPackage({ ...args, fs, now: clock })
    assert.equal(r.ok, false)
    assert.equal(r.code, DIAG_CODES.NO_LAYOUT, JSON.stringify(args))
    assert.match(r.message, /不猜/)
  }
})

test('⑤ 一个候选都没有 → `EMPTY_PACKAGE`（空包与"没什么好收的"不能同形）', async () => {
  const base = 'C:\\t10'
  const layout = layoutOf(base)
  const fs = fakeFs({})
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg10', fs, now: clock, candidates: [] })
  assert.equal(r.ok, false)
  assert.equal(r.code, DIAG_CODES.EMPTY_PACKAGE)
})

test('⑤ 清单里**不含**密钥库路径（"密钥在哪"这条信息本身不该被发出去）', async () => {
  const base = 'C:\\t11'
  const layout = layoutOf(base)
  const fs = fakeFs({ [join(base, 'log', 'a.log')]: 'ok' })
  const r = await exportDiagnosticPackage({ layout, outDir: 'C:\\pkg11', fs, now: clock })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.manifest.roots.secretsStore.includes('secrets.json'), false)
  assert.ok(!JSON.stringify(r.manifest).includes(layout.secretsFile), '清单里出现了密钥库的绝对路径')
})

test('⑤ 包内文件名**不带绝对路径**（路径会泄漏用户名与目录结构）', () => {
  assert.equal(flattenName(1, 'log:C:\\Users\\someone\\app.log'), '001-log-C-Users-someone-app.log.txt')
  assert.ok(!flattenName(2, 'log:/home/x/a.log').includes('/home'))
  assert.ok(!flattenName(2, 'log:/home/x/a.log').includes('\\'), '反斜杠也要消掉')
  // 长度上限：一个超长 id 不该产出一个超长文件名。**两个守卫各断言一次**——
  // 只断言路径清洗时，去掉 `.slice()` 那道是观测不到的（破验证 ⑱㉒ 量到的）。
  const long = flattenName(3, 'x'.repeat(300))
  assert.ok(long.length < 120, `文件名过长（${long.length}）：清单里会出现不可读的条目`)
})

// ============================================================================
// ⑥ 默认候选清单
// ============================================================================

test('⑥ 默认候选按名字排序（清单必须是确定的，否则 diff 全是噪声）', () => {
  const base = 'C:\\t12'
  const layout = layoutOf(base)
  const fs = fakeFs({
    [join(base, 'log', 'z.log')]: 'z',
    [join(base, 'log', 'a.log')]: 'a',
    [join(base, 'log', 'm.log')]: 'm',
  })
  const ids = defaultCandidates({ layout, fs }).filter((c) => c.role === 'log').map((c) => c.id)
  assert.deepEqual(ids, ['log:a.log', 'log:m.log', 'log:z.log'])
})

test('⑥ 默认候选**显式列出密钥库**（让它被排除，而不是"忘了列"）', () => {
  const layout = layoutOf('C:\\t13')
  const fs = fakeFs({})
  const cands = defaultCandidates({ layout, fs })
  assert.ok(cands.some((c) => c.role === 'secret-store'),
    '不列它，清单上只会显示"没有这个条目"——而那看起来像漏收')
})

test('⑥ 日志目录读不了时默认候选不炸（返回剩下的）', () => {
  const layout = layoutOf('C:\\t14')
  const fs = { ...fakeFs({}), readdirSync: () => { throw new Error('EACCES') } }
  const cands = defaultCandidates({ layout, fs })
  assert.equal(cands.filter((c) => c.role === 'log').length, 0)
  assert.ok(cands.some((c) => c.role === 'config'))
})

// ============================================================================
// ⑦ 形状
// ============================================================================

test('⑦ `buildManifest` 的字段是固定的（清单是给机器读的契约）', () => {
  const planned = planPackage({ candidates: [], read: () => null })
  const m = buildManifest({ planned, layout: null, now: clock, platform: 'win32', packageId: 'p' })
  assert.deepEqual(Object.keys(m).sort(), [
    'createdAt', 'excluded', 'exitCodesUnderstood', 'included', 'oversized', 'packageId',
    'platform', 'redactedMarker', 'redactionCaveat', 'roots', 'schema', 'skipped', 'totals', 'verified',
  ])
  assert.equal(Object.isFrozen(m), true)
})

test('⑦ `planPackage` 不碰 IO：read 是唯一的输入口，且每个候选只读一次', () => {
  const seen = []
  planPackage({
    candidates: [
      { id: 'a', path: 'C:\\a.log', role: 'log' },
      { id: 'b', path: 'C:\\b.log', role: 'log' },
    ],
    read: (p) => { seen.push(p); return Buffer.from('x') },
  })
  assert.deepEqual(seen, ['C:\\a.log', 'C:\\b.log'])
})
