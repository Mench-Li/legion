// product/diagnostics/redact-package.mjs
// ============================================================================
// PRT-710：脱敏诊断包导出
//
// spec §6.7 把「诊断包」与提示词、日志、异常、审计、能力包并列，作为
// **密钥不得出现的地方**。本模块就是那个导出点。
//
// ## 一、结构性排除优先于文本过滤（本模块最要紧的一条）
//
// 脱敏是**过滤器**：它只能拦下它认得出来的形态。而 `redact-patterns.mjs`
// 是一张**有限的**表——明天出现一种新的密钥前缀，今天的过滤器会静默放它过去。
//
// 所以敏感**文件**不是"被脱敏后收进包里"，而是**根本不进包**：
//
//   密钥库文件（`layout.secretsFile`）、任何 `.credentials.yaml`、
//   `*.key`、`auth.json`，以及**业务数据库正文**（`*.db`）
//
// 后一条值得单独说：业务库里存着提示词与业务数据。整包导出等于把数据平面
// 复制一份出去——而诊断包是要**发给别人**的东西。脱敏一张 SQLite 二进制
// 既不现实也不可靠，所以它按**文件类型**排除。
//
// 过滤器会漏，路径排除不会。两者都要，但顺序是：**先排除，再脱敏**。
//
// ## 二、「没包含」与「被排除」必须可区分
//
// 一份包里少了一个日志文件，与一份包**刻意**排除了密钥库，在收件人眼里
// 长得一样：都是"没这个东西"。所以清单里记的是**每一个候选**的去向：
//
//   included（收了，附脱敏命中数）/ excluded（没收，附**为什么**）/
//   skipped（想收但读不了，附原因）/ oversized（超限）
//
//   > 一份说不清自己排除了什么的诊断包，与一份漏收了文件的诊断包，
//   > 对排查者来说是同一个东西。
//
// ## 三、0 次脱敏命中 ≠ 「没有密钥」
//
// 计数器只说明**这张表认出了几个**。把 `redactionHits: 0` 读成"包是干净的"
// 正是第一条要防的那种误读，所以清单里同时写出这句话。
//
// ## 四、判定用的是**落盘之后重新读回来的字节**，不是内存里的副本
//
// 写完包会**重新读回每一个文件**再审一遍。内存里那份是"我们以为写下去的"，
// 磁盘上那份才是发出去的东西——而写错缓冲区这类 bug，恰好只有后者看得见。
//
// 审出任何残留 → 包**作废**（连同目录一起删掉并留下标记），而不是"发出去
// 但附一句警告"。一个**带着已知泄漏被发出去**的诊断包，比没有诊断包坏得多：
// 它已经离开了这台机器。
//
// ## 五、不覆盖已有的包
//
// 同名目录已存在 → 拒绝。诊断包的价值在于它是**当时**的证据，
// 悄悄覆盖掉上一次，等于把"出事前的样子"毁掉。
// ============================================================================

import { join } from 'node:path'

import { REDACTED, redactText } from '../../runtime/contracts/redact-patterns.mjs'
// 密钥库的**真实文件名**从产品自己的定义取，不在这里再写一遍。
//
// 第一版这里手写了 `'secrets.json'`，而产品实际用的是
// `secrets/credentials.json`。于是那条**以密钥库命名**的规则从来没匹配过密钥库，
// 它只是碰巧被后面那条更宽的 `credentials-*` 规则接住了——而"碰巧接住"
// 在别人把那条规定改窄的那一刻就会失效。
//
//   > 一条以某物命名、却匹配不到那个物的规则，与一条不存在的规则，
//   > 在「有没有保护到它」上是同一个答案。
import { SECRETS_DIRNAME, SECRETS_FILENAME } from '../paths.mjs'

/** 本模块的具名码。 */
export const DIAG_CODES = Object.freeze({
  /** 布局不合法或缺失：连锁定该收哪些目录都做不到。 */
  NO_LAYOUT: 'DIAG_NO_LAYOUT',
  /** 目标目录已存在：**不覆盖**。 */
  PACKAGE_EXISTS: 'DIAG_PACKAGE_EXISTS',
  /** 落盘后复检发现残留密钥：包已作废。 */
  LEAK_DETECTED: 'DIAG_LEAK_DETECTED',
  /** 写不进去（权限/磁盘）。 */
  WRITE_FAILED: 'DIAG_WRITE_FAILED',
  /** 一个候选都没收到——空包和"没什么好收的"必须分开。 */
  EMPTY_PACKAGE: 'DIAG_EMPTY_PACKAGE',
})

/** 逐候选的去向。**这张表是总的**：没有第五种。 */
export const DIAG_STATUSES = Object.freeze(['included', 'excluded', 'skipped', 'oversized'])

/**
 * 结构性排除：**按文件名/扩展名**判定，与脱敏表无关。
 *
 * 每一条都要有 `why`：一份说不出理由的排除，下一个人会以为是漏收而"顺手修好"，
 * 于是密钥库就被收进包里了。
 */
export const STRUCTURAL_EXCLUSIONS = Object.freeze([
  Object.freeze({
    id: 'secret-store',
    // 两条判据，各自都是**可观测**的：
    //   · 路径里出现了 `secrets` 这个**目录段** —— 产品定义的密钥库就住在
    //     `${SECRETS_DIRNAME}/${SECRETS_FILENAME}` 下。按位置判定比按名字强：
    //     换了文件名它照样拦得住；
    //   · 或者文件名是那两个**独立**的常见密钥库名（别的工具留下的）。
    //
    // 这里**刻意不再**单独判 `name === SECRETS_FILENAME`。第一版判了，而破验证 ⑰⑱㉖
    // 量到它不可观测：`credentials.json` 同时被上面那条目录规则和更宽的
    // `credentials-*` 规则接住，删掉它没有任何用例变红。
    //
    //   > 一个删掉也不会让任何用例变红的判断，与不存在同形。
    //
    // 留一个"看起来像防线、实际不改变任何输出"的分支，会让下一个人以为那里有保护。
    // 产品常量的**名字**仍然用在 `why` 里（说清"这是哪个文件"），判定只用位置。
    test: (name, fullPath) => {
      if (name === 'secrets.json' || name === 'secrets.db') return true
      const segs = String(fullPath ?? '').split(/[\\/]+/).map((x) => x.toLowerCase())
      return segs.includes(SECRETS_DIRNAME.toLowerCase())
    },
    why: `这是受保护的密钥库本体（产品定义为 ${SECRETS_DIRNAME}/${SECRETS_FILENAME}）：` +
      '它进包就等于把密钥一起发出去。判据是**位置**（`secrets` 目录段）加上两个独立的' +
      '常见库文件名——只按名字匹配的话，密钥库一改名这条规则就静默失效了',
  }),
  Object.freeze({
    id: 'credentials-yaml',
    // 匹配**以 `credentials.yaml/yml/json` 结尾**的任意名字，而不是只匹配
    // 正好叫这个名字的。第一版写的是 `/^\.?credentials\.(ya?ml|json)$/`，
    // 于是 `x.credentials.yaml` 从规则缝里漏了过去——一条只认"标准写法"的
    // 排除规则，防的是规范，不是事实。
    //
    // 代价是 `notcredentials.yaml` 这类名字会被误排。这个方向是对的：
    // 少收一个日志文件只是信息少一点，多收一个凭证文件是**泄漏**。
    test: (name) => /credentials\.(ya?ml|json)$/i.test(name),
    why: '按 spec 附录 A.2，这类文件是明文凭证载体；它的整个存在意义就是放密钥。' +
      '规则按**后缀**匹配（`*credentials.yaml/yml/json`）——只认标准写法的话，' +
      '`x.credentials.yaml` 就会从缝里漏过去；误排一个同后缀的普通文件的代价，' +
      '远小于漏收一个凭证文件',
  }),
  Object.freeze({
    id: 'raw-key',
    test: (name) => /\.(key|pem|p12|pfx)$/i.test(name),
    why: '私钥/证书材料：形态多变，脱敏表认不全，按扩展名整类排除',
  }),
  Object.freeze({
    id: 'auth-json',
    test: (name) => /^auth.*\.json$/i.test(name),
    why: '鉴权缓存（token/cookie 之类）通常整文件都是凭证',
  }),
  Object.freeze({
    id: 'business-db',
    test: (name) => /\.(db|sqlite|sqlite3)$/i.test(name),
    why: '业务数据库正文含提示词与业务数据：诊断包是要**发给别人**的东西，' +
      '整包导出等于复制一份数据平面出去；对二进制库做脱敏既不可行也不可验证',
  }),
  Object.freeze({
    id: 'env-file',
    test: (name) => name === '.env' || name.startsWith('.env.'),
    why: '.env 的惯例就是放密钥（`*_API_KEY`/`*_TOKEN`），形态任意，整类排除',
  }),
])

/** 判定一个文件名是否被结构性排除。`fullPath` 供按**目录段**判定的规则使用。 */
export function structuralExclusionFor(name, fullPath = name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  for (const rule of STRUCTURAL_EXCLUSIONS) {
    if (rule.test(base, fullPath)) return { id: rule.id, why: rule.why }
  }
  return null
}

/** 默认上限。它们不是"性能调优"，是**磁盘保护**：诊断包不该把盘写满。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 200,
})

/** 文本判定：前 8KB 里出现 NUL 就当二进制。**不当文本硬脱敏**。 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const shorten = (s, max = 300) => (s.length <= max ? s : `${s.slice(0, max)}…（已截断）`)

/**
 * 一次诊断包导出的**纯**逻辑部分：给定已读到的字节，算出包里该有什么。
 *
 * 拆分出来的理由与 `workbench/src/modelSettings.ts` 同一条：
 * **落盘那一步无法在用例里逐条验证，判定那一步可以**。所以判定必须离开 IO。
 *
 * @param {object} deps
 * @param {Array<{id: string, path: string, role: string}>} deps.candidates
 * @param {(path: string) => Buffer|null} deps.read  读不到返回 null（不抛）
 * @param {object} [deps.limits]
 * @returns {{entries: Array<object>, excluded: Array<object>, skipped: Array<object>, oversized: Array<object>, totals: object}}
 */
export function planPackage({ candidates = [], read, limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const entries = []
  const excluded = []
  const skipped = []
  const oversized = []
  let totalBytes = 0
  let redactionHits = 0
  let redactedFiles = 0

  for (const c of candidates) {
    const structural = structuralExclusionFor(c.path, c.path)
    if (structural !== null) {
      // **不读它**。排除的意义在于"这个字节从来没有被本模块碰过"——
      // 读了再丢，与不读，在"有没有可能被顺手写出去"上是两回事。
      excluded.push(Object.freeze({
        id: c.id, role: c.role ?? null, rule: structural.id, why: structural.why,
      }))
      continue
    }

    let buf
    try {
      buf = read(c.path)
    } catch (e) {
      buf = null
      skipped.push(Object.freeze({
        id: c.id, role: c.role ?? null, reason: `读取失败：${e?.name ?? 'Error'}`,
      }))
      continue
    }
    if (buf === null || buf === undefined) {
      skipped.push(Object.freeze({ id: c.id, role: c.role ?? null, reason: '读取不到（文件不存在或无权访问）' }))
      continue
    }
    const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
    if (bytes.length > lim.maxFileBytes) {
      oversized.push(Object.freeze({
        id: c.id, role: c.role ?? null, bytes: bytes.length, limit: lim.maxFileBytes,
        why: '单文件超过上限：整包体积必须可预期，否则一次导出可能把盘写满',
      }))
      continue
    }
    if (entries.length >= lim.maxFiles) {
      oversized.push(Object.freeze({
        id: c.id, role: c.role ?? null, why: `已达文件数上限 ${lim.maxFiles}`,
      }))
      continue
    }
    if (looksBinary(bytes)) {
      // 二进制**不做文本脱敏**：对二进制跑正则既可能漏（形态认不出），
      // 又会把文件改坏。如实记成 skipped，而不是"收了个可能带密钥的二进制"。
      skipped.push(Object.freeze({
        id: c.id, role: c.role ?? null,
        reason: '二进制内容：不做文本脱敏（对二进制跑正则会改坏文件，且认不全形态）',
      }))
      continue
    }
    if (totalBytes + bytes.length > lim.maxTotalBytes) {
      oversized.push(Object.freeze({
        id: c.id, role: c.role ?? null, bytes: bytes.length, limit: lim.maxTotalBytes,
        why: '整包超过总上限',
      }))
      continue
    }

    const { text, hits } = redactText(bytes.toString('utf8'))
    const out = Buffer.from(text, 'utf8')
    totalBytes += out.length
    redactionHits += hits.length
    if (hits.length > 0) redactedFiles += 1
    entries.push(Object.freeze({
      id: c.id, path: c.path, role: c.role ?? null,
      bytesIn: bytes.length, bytesOut: out.length,
      redactionHits: hits.length,
      hitKinds: Object.freeze([...new Set(hits)]),
      body: out,
    }))
  }

  return {
    entries,
    excluded,
    skipped,
    oversized,
    totals: Object.freeze({
      candidates: candidates.length,
      included: entries.length,
      excluded: excluded.length,
      skipped: skipped.length,
      oversized: oversized.length,
      bytes: totalBytes,
      redactionHits,
      redactedFiles,
    }),
  }
}

/**
 * 落盘后的**复检**：对磁盘上真实的字节再审一遍。
 *
 * `planPackage` 的脱敏已经跑过一次了；这里再跑不是重复劳动——
 * 它审的是**另一个东西**（磁盘上的字节），因此能抓住"写下去的和以为写下去的不一样"
 * 这一类 bug。
 *
 * @returns {{clean: boolean, offenders: Array<{name: string, hits: string[]}>}}
 */
export function verifyWrittenFiles(files = []) {
  const offenders = []
  for (const f of files) {
    const buf = Buffer.isBuffer(f.body) ? f.body : Buffer.from(String(f.body ?? ''), 'utf8')
    if (looksBinary(buf)) {
      // 二进制在 `planPackage` 阶段就被拦了。真到这里只可能是"写的时候写错了"，
      // 而那种情况**不能**静默放过。
      offenders.push({ name: f.name, hits: ['写出来的内容是二进制（本不该出现在包里）'] })
      continue
    }
    const { hits } = redactText(buf.toString('utf8'))
    if (hits.length > 0) offenders.push({ name: f.name, hits: [...new Set(hits)] })
  }
  return { clean: offenders.length === 0, offenders }
}

/** 清单里那句必须跟着计数一起出现的话。 */
export const HITS_CAVEAT =
  '`redactionHits` 只说明**这张表认出了几个**，不说明包里没有密钥：' +
  '脱敏是过滤器，只能拦下它认得出来的形态，而模式表是有限的。' +
  '真正的保证来自**结构性排除**（见 `excluded`：密钥库、凭证文件、业务库正文' +
  '从未被读入过）。0 次命中**不等于**「已验证干净」。'

/**
 * 组清单。
 *
 * 清单本身**不含任何被收文件的内容**，只有路径、体积与计数——
 * 清单进不进包都安全，因为它没有可泄漏的东西。
 */
export function buildManifest({
  planned, layout = null, now = () => new Date().toISOString(), platform = process.platform,
  packageId = null, verified = null,
}) {
  return Object.freeze({
    schema: 'legion.diagnostic-package/1',
    packageId,
    createdAt: now(),
    platform,
    // 布局里的**目录角色**要记（排查需要），密钥库路径**不记**：
    // 它是"密钥在哪"这条信息，而诊断包是要发出去的。
    roots: Object.freeze(layout === null ? null : {
      productHome: layout.productHome ?? null,
      installDir: layout.installDir ?? null,
      dataDir: layout.dataDir ?? null,
      logDir: layout.logDir ?? null,
      cacheDir: layout.cacheDir ?? null,
      workspaceDirConfigured: layout.workspaceDir !== null && layout.workspaceDir !== undefined,
      secretsStore: '（刻意不记录路径：只记「它没有被收进来」）',
    }),
    totals: planned.totals,
    included: Object.freeze(planned.entries.map((e) => Object.freeze({
      id: e.id, path: e.path, role: e.role,
      bytesIn: e.bytesIn, bytesOut: e.bytesOut, redactionHits: e.redactionHits,
      hitKinds: e.hitKinds,
    }))),
    excluded: Object.freeze([...planned.excluded]),
    skipped: Object.freeze([...planned.skipped]),
    oversized: Object.freeze([...planned.oversized]),
    exitCodesUnderstood: Object.freeze(DIAG_STATUSES),
    redactionCaveat: HITS_CAVEAT,
    redactedMarker: REDACTED,
    verified,
  })
}

/** 把候选列表的路径渲染成包内的相对文件名（**不让绝对路径进包**）。 */
export function flattenName(index, id, suffix = 'txt') {
  const safe = String(id ?? 'artifact').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
  return `${String(index).padStart(3, '0')}-${safe || 'artifact'}.${suffix}`
}

/**
 * 导出诊断包。
 *
 * 步骤刻意是**四段**且顺序不能换：
 *   ① 判定（纯）→ ② 写 → ③ **把写下去的字节读回来复检** → ④ 复检没过就作废
 *
 * ③ 在 ② 之后，而不是并进 ②：内存里那份是"我们以为写下去的"，
 * 磁盘上那份才是发出去的东西。
 *
 * @param {object} deps
 * @param {object} deps.layout
 * @param {string} deps.outDir        包目录（调用方给出，本模块不猜）
 * @param {Array}    [deps.candidates] 缺省用 `defaultCandidates(layout)`
 * @param {object}   [deps.fs]         `{ readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync }`
 * @param {object}   [deps.limits]
 * @param {Function} [deps.now]
 */
export async function exportDiagnosticPackage(deps = {}) {
  const {
    layout, outDir, candidates = null, limits = {}, now = () => new Date().toISOString(),
    platform = process.platform,
  } = deps
  const fs = deps.fs ?? (await import('node:fs'))
  const packageId = String(outDir ?? '').split(/[\\/]/).filter(Boolean).pop() ?? null

  if (layout === null || layout === undefined || typeof layout !== 'object' || outDir === undefined || outDir === null) {
    return Object.freeze({
      ok: false, code: DIAG_CODES.NO_LAYOUT,
      message: '无法导出诊断包：布局或目标目录未给出（**不猜默认位置**：' +
        '诊断包会离开这台机器，它写到哪里必须由调用方决定）',
    })
  }
  if (fs.existsSync(outDir)) {
    return Object.freeze({
      ok: false, code: DIAG_CODES.PACKAGE_EXISTS, path: outDir,
      message: `目标目录已存在：${outDir}。**不覆盖**——诊断包的价值在于它是当时的证据，` +
        '覆盖掉上一次等于把"出事前的样子"毁掉。请换一个目录名。',
    })
  }

  const list = candidates ?? defaultCandidates({ layout, fs, platform })
  const read = (p) => {
    try {
      return fs.readFileSync(p)
    } catch {
      return null
    }
  }

  const planned = planPackage({ candidates: list, read, limits })
  if (planned.totals.candidates === 0) {
    return Object.freeze({
      ok: false, code: DIAG_CODES.EMPTY_PACKAGE, path: outDir,
      message: '没有任何候选可收：一个空包与一个"没什么好收的"包长得一样，' +
        '所以这里不生成空包，而是如实报错',
    })
  }

  const manifest = buildManifest({ planned, layout, now, platform, packageId, verified: null })

  // ── ② 写 ──
  try {
    fs.mkdirSync(outDir, { recursive: true })
    const written = []
    planned.entries.forEach((e, i) => {
      const name = flattenName(i + 1, e.id)
      fs.writeFileSync(join(outDir, name), e.body)
      written.push({ name, path: join(outDir, name) })
    })
    fs.writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    written.push({ name: 'manifest.json', path: join(outDir, 'manifest.json') })
  } catch (e) {
    // 写了一半失败：把半成品清掉。留一个残缺的包比没有包更坏——
    // 它看起来像个完整的证据。
    try { fs.rmSync(outDir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    return Object.freeze({
      ok: false, code: DIAG_CODES.WRITE_FAILED, path: outDir,
      message: `写诊断包失败：${e?.name ?? 'Error'}（半成品已清除，不留残缺的包）`,
    })
  }

  // ── ③ 把写下去的字节**读回来**复检 ──
  let onDisk = []
  try {
    const names = fs.readdirSync(outDir)
    onDisk = names.map((name) => ({ name, body: fs.readFileSync(join(outDir, name)) }))
  } catch (e) {
    try { fs.rmSync(outDir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    return Object.freeze({
      ok: false, code: DIAG_CODES.WRITE_FAILED, path: outDir,
      message: `诊断包写完后无法读回复检：${e?.name ?? 'Error'}。` +
        '**无法复检的包不发出去**——"我们脱敏过了"与"落盘的字节是干净的"是两个不同的断言',
    })
  }

  // ── ④ 复检没过就作废 ──
  const verdict = verifyWrittenFiles(onDisk)
  if (!verdict.clean) {
    try { fs.rmSync(outDir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    return Object.freeze({
      ok: false, code: DIAG_CODES.LEAK_DETECTED, path: outDir,
      message: `复检在落盘后的字节里发现疑似密钥，诊断包已**作废并删除**：` +
        `${verdict.offenders.map((o) => o.name).join('、')}。` +
        '带着已知泄漏把包发出去，比没有诊断包坏得多——它已经离开了这台机器。',
      // 只报**文件名**与命中**种类**，不报内容：这条错误本身也会进日志。
      offenders: Object.freeze(verdict.offenders.map((o) => Object.freeze({ name: o.name, hitKinds: o.hits }))),
    })
  }

  // 复检结果写回清单：**声明"已验证"必须同时给出验证的是什么**。
  const finalManifest = buildManifest({
    planned, layout, now, platform, packageId,
    verified: Object.freeze({
      method: 'read-back-after-write',
      filesScanned: onDisk.length,
      clean: true,
      at: now(),
      note: '复检的对象是**磁盘上读回来的字节**，不是内存里的副本：' +
        '后者是"我们以为写下去的"，前者才是发出去的东西',
    }),
  })
  fs.writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(finalManifest, null, 2)}\n`, 'utf8')

  return Object.freeze({
    ok: true,
    code: null,
    path: outDir,
    manifest: finalManifest,
    message: `诊断包已生成并复检通过：${planned.totals.included} 个文件，` +
      `${planned.totals.excluded} 项结构性排除，${planned.totals.skipped + planned.totals.oversized} 项未收。` +
      (planned.totals.redactionHits > 0
        ? `脱敏命中 ${planned.totals.redactionHits} 处（${planned.totals.redactedFiles} 个文件）——请看一眼清单里命中的种类，` +
          '它们说明这台机器的日志里**曾经**出现过密钥形态的值。'
        : '脱敏命中 0 处，但**这不等于包是干净的**：见清单里的 `redactionCaveat`。'),
  })
}

/**
 * 产品的**默认**候选清单：日志目录下的文件 + 非敏感产品配置 + 状态文件。
 *
 * 刻意**不含**业务库、会话库、密钥库——它们由 `STRUCTURAL_EXCLUSIONS` 兜底排除，
 * 而这里连列都不列。两层都要：这一层决定"想收什么"，那一层保证"什么绝不会进"。
 */
export function defaultCandidates({ layout = {}, fs, platform = process.platform }) {
  const out = []
  const push = (id, path, role) => {
    if (typeof path === 'string' && path !== '') out.push({ id, path, role })
  }

  if (typeof layout.logDir === 'string') {
    let names = []
    try {
      names = fs.readdirSync(layout.logDir)
    } catch { names = [] }
    // 排序：诊断包的清单必须是**确定的**（同一台机器两次导出顺序一致），
    // 否则清单 diff 出来全是噪声。
    for (const name of [...names].sort()) {
      push(`log:${name}`, join(layout.logDir, name), 'log')
    }
  }
  push('product-config', layout.productConfigPath, 'config')
  // 密钥库**显式列出来并让它被排除**，而不是"忘了列"。
  // 差别在清单上：前者写着"排除了，因为它是密钥库本体"，
  // 后者只会显示一个不存在的条目 —— 而那看起来像漏收。
  push('secrets-store', layout.secretsFile, 'secret-store')
  return out
}
