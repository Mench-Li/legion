// product/lifecycle/data-export.mjs
// ============================================================================
// PRT-905：备份、恢复与**数据导出**入口。
//
// spec §10 line 988。
//
// 备份与恢复已经由 `product/upgrade/backup.mjs`（PRT-806/812）实现。
// 本模块补的是**第三件事：数据导出**——而它与前两件**不是同一个东西**。
//
// ## 备份 / 恢复 / 导出是三个不同的目标
//
//   · **备份**要能**原样恢复**：字节保真、含 WAL 与索引、只有本产品打得开。
//   · **恢复**要能**回到某一时刻**：它是一个内部机制。
//   · **导出**要能**被别人读**：稳定 schema、通用格式、自描述。
//
// 把三者当成一件事情的实现，会产出这种东西：一个 `.db` 文件被叫做"导出"。
//
//   > 一个「把数据库文件复制一份」的导出，
//   > 与一个「用户拿到一个打不开的 .db」的导出，是同一个东西——
//   > 只不过前者在"导出成功"这个返回值上是完全正确的。
//
// 所以本模块的核心判据是：**导出条目必须是可移植格式**，
// 而 `sqlite` / `db` / 二进制是**备份**格式、不是导出格式。
//
// ## ★ 四个会安静出错的坑
//
// ### ① 「导出成功」= 文件写出来了
//
// 写出了文件、但里面有密钥、或者有别人的数据、或者格式只有本产品能读——
// 这三种"成功"对用户是三种不同的伤害，而返回码是一样的。
//
// ### ② 导出会顺手改一下源
//
// 最常见的一次是"为了导出一致快照，先 checkpoint 一下 WAL"——
// 那是**对运行中的产品做了一次写操作**，而用户以为导出是只读的。
//
//   > 一个「为了导出得干净而先动一下源」的导出，
//   > 与一个「导出动作本身破坏了正在运行的实例」的实现，是同一个东西——
//   > 只不过前者的动机是好的。
//
// ### ③ 部分导出不报
//
// 某一类因为权限/格式导不出来，静默少给一个类——用户以为拿到的是全部。
//
// ### ④ 没有清单的导出包
//
// 接收方不知道里面是什么、哪一版格式、有几条。没有清单的包，
// 与一个"能打开但读不出意思"的包，是同一个东西。
//
//   > 一个「把一堆 JSON 打个 zip」的导出，
//   > 与一个「接收方需要猜每一份文件是什么」的导出，是同一个东西——
//   > 只不过前者在文件数量上是完整的。
// ============================================================================

import { DATA_CLASSES, DATA_CLASS_IDS } from './data-classes.mjs'

/** 导出包格式版本。 */
export const EXPORT_FORMAT = 'legion/data-export@1'

/**
 * 可移植格式：**接收方不需要本产品就能读**。
 *
 * 这正是"导出"与"备份"的分界。
 */
export const PORTABLE_FORMATS = Object.freeze(['json', 'ndjson', 'csv', 'text'])

/**
 * 不可移植格式：**只有本产品/本引擎能读**。
 *
 * ★ 它们属于**备份**，不属于导出。把它们放进导出包，用户拿到的是一份
 *   他打不开的文件——而导出这个动作的全部意义就是"让他带走"。
 */
export const NON_PORTABLE_FORMATS = Object.freeze(['sqlite', 'db', 'binary', 'wal', 'shm'])

export const EXPORT_CODES = Object.freeze({
  /** 条目用了不可移植的格式（那是备份，不是导出）。 */
  FORMAT_UNPORTABLE: 'export-format-unportable',
  /** 条目属于"永不导出"的类（密钥库）。 */
  SECRET_IN_EXPORT: 'export-secret-in-export',
  /** 条目内容里扫到了疑似密钥值。 */
  SECRET_VALUE_FOUND: 'export-secret-value-found',
  /** 导出动作会改动源（写模式打开、checkpoint、加锁）。 */
  DESTRUCTIVE: 'export-destructive',
  /** 某一类导不出来，但没被告知。 */
  SILENT_OMISSION: 'export-silent-omission',
  /** 没有清单，或清单不自描述。 */
  MANIFEST_INCOMPLETE: 'export-manifest-incomplete',
  /** 清单声明的条目数与实际不符。 */
  MANIFEST_COUNT_MISMATCH: 'export-manifest-count-mismatch',
  /** 一个落点都没有——空导出与"没什么好导的"必须分开。 */
  EMPTY_EXPORT: 'export-empty',
  /** 落点的类别认不出来。 */
  CLASS_UNKNOWN: 'export-class-unknown',
  /** 工作区没有被导出，但也没告诉用户。 */
  WORKSPACE_OMITTED: 'export-workspace-omitted',
  /** 条目缺哈希——没有哈希的导出无法证明它没被改过。 */
  ENTRY_UNHASHED: 'export-entry-unhashed',
})

/**
 * 每一类数据在**导出**里的处置。与卸载台账是**两张不同的表**，
 * 因为它们回答的是两个不同的问题：
 *   · 卸载问"要不要删掉"；
 *   · 导出问"要不要、以及以什么形式交给他"。
 *
 * ★ 但两张表都必须覆盖**同一批类**——`EXPORT_CHECKED` 会核对这一点。
 *   漏掉一个类，那个类的数据就会在某一天**无声地不出现在导出包里**。
 */
export const EXPORT_CLASS_POLICY = Object.freeze({
  program: Object.freeze({
    handling: 'exclude',
    why: '程序文件不是用户数据；导出它只是把安装包又给了一遍',
  }),
  config: Object.freeze({
    handling: 'portable',
    format: 'json',
    why: '产品配置是用户数据（他调过的每一项），且天然是 JSON',
  }),
  database: Object.freeze({
    handling: 'portable',
    format: 'json',
    why: '业务数据是导出的主要对象；必须以**通用格式**给出，不能给 .db',
  }),
  log: Object.freeze({
    handling: 'portable',
    format: 'text',
    why: '日志是纯文本，本来就可移植',
  }),
  event: Object.freeze({
    handling: 'portable',
    format: 'ndjson',
    why: '事件是追加流，NDJSON 是它的自然形态，也便于逐条读',
  }),
  artifact: Object.freeze({
    handling: 'reference-only',
    why: '产物可能极大；导出**清单与哈希**而不是复制字节——' +
      '复制字节会让一次导出吃掉用户几十 GB 的磁盘，而他只是想把数据带走',
  }),
  cache: Object.freeze({
    handling: 'exclude',
    why: '缓存可以从头重建；导出它只是把垃圾交给他',
  }),
  secret: Object.freeze({
    handling: 'never',
    why: '★ 密钥库**永远不进导出包**。导出包会被复制、上传、发给支持人员——' +
      '一个"顺手带上凭据"的导出，会把用户的所有下游账号一起交出去',
  }),
  workspace: Object.freeze({
    handling: 'confirm',
    why: '工作区里是用户自己的项目文件，可能有几百 MB 也可能有他不该交出去的东西；' +
      '默认不导出，**但必须明确告诉他**——静默漏掉一个类与故意排除一个类，对他是不一样的',
  }),
})

export const EXPORT_HANDLINGS = Object.freeze(['portable', 'reference-only', 'exclude', 'never', 'confirm'])

/**
 * 规划一次导出。
 *
 * @param {object} [args]
 * @param {ReadonlyArray<{classId: string, path: string, name?: string, format?: string,
 *                        bytes?: number, hash?: string, content?: string, openedForWrite?: boolean}>} [args.stores]
 * @param {Record<string, boolean>} [args.include] 对 `confirm` 类的显式选择，如 `{ workspace: true }`
 * @param {ReadonlyArray<string>} [args.scannedSecrets] 在导出内容里扫到的疑似密钥（调用方给）
 * @returns {object}
 */
export function planExport({ stores = [], include = {}, scannedSecrets = [] } = {}) {
  const findings = []
  const entries = []
  const excluded = []
  const omitted = []

  if (!Array.isArray(stores) || stores.length === 0) {
    findings.push(Object.freeze({
      code: EXPORT_CODES.EMPTY_EXPORT,
      detail: '一个落点都没有收到——空导出与"没什么好导的"必须分开，否则用户会拿到一个空包而以为导完了',
    }))
  }

  for (const store of stores) {
    const policy = EXPORT_CLASS_POLICY[store.classId]
    if (policy === undefined) {
      findings.push(Object.freeze({
        code: EXPORT_CODES.CLASS_UNKNOWN,
        classId: store.classId,
        path: store.path,
        detail: `落点 ${store.path} 的类别 ${JSON.stringify(store.classId)} 不在台账里——` +
          '认不出类别的落点既不敢导出也不敢丢下，必须由人决定',
      }))
      omitted.push(Object.freeze({ path: store.path, classId: store.classId, reason: 'class-unknown' }))
      continue
    }

    // ★ ① 密钥库：永远不进导出包。这一条**先于**其它所有判断。
    if (policy.handling === 'never') {
      excluded.push(Object.freeze({
        path: store.path, classId: store.classId, handling: 'never', why: policy.why,
      }))
      findings.push(Object.freeze({
        code: EXPORT_CODES.SECRET_IN_EXPORT,
        classId: store.classId,
        path: store.path,
        detail: `${store.path} 属于密钥库——导出包会被复制、上传、发给支持人员，` +
          '它永远不进导出包（这不是"默认不勾"，是"不可能勾"）',
      }))
      continue
    }

    if (policy.handling === 'exclude') {
      excluded.push(Object.freeze({
        path: store.path, classId: store.classId, handling: 'exclude', why: policy.why,
      }))
      continue
    }

    // ★ ② `confirm` 类默认不导出，但必须**明确报出来**。
    if (policy.handling === 'confirm' && include[store.classId] !== true) {
      omitted.push(Object.freeze({
        path: store.path, classId: store.classId, reason: 'not-confirmed',
      }))
      findings.push(Object.freeze({
        code: EXPORT_CODES.WORKSPACE_OMITTED,
        classId: store.classId,
        path: store.path,
        detail: `${store.path} 属于 ${store.classId}，默认不导出——` +
          `这是一次**选择**，必须告诉用户（他说要"全部数据"时，少了这一块他会以为导完了）`,
      }))
      continue
    }

    // ★ ③ 导出**不得改动源**。
    if (store.openedForWrite === true) {
      findings.push(Object.freeze({
        code: EXPORT_CODES.DESTRUCTIVE,
        classId: store.classId,
        path: store.path,
        detail: `${store.path} 是以**写模式**打开的——` +
          '为了导出一致快照而 checkpoint / 加写锁，是对运行中的产品做了一次写操作，而用户以为导出是只读的',
      }))
      continue
    }

    // ★ ④ 格式必须可移植（`reference-only` 不带格式）。
    if (policy.handling !== 'reference-only') {
      const format = store.format ?? policy.format
      if (!PORTABLE_FORMATS.includes(format)) {
        findings.push(Object.freeze({
          code: EXPORT_CODES.FORMAT_UNPORTABLE,
          classId: store.classId,
          path: store.path,
          format: format ?? null,
          detail: `${store.path} 的导出格式是 ${JSON.stringify(format ?? null)}，` +
            `不是可移植格式（${PORTABLE_FORMATS.join(' / ')}）——` +
            '把一个 .db 交给用户不是导出，是把一个只有本产品打得开的东西交给他',
        }))
        continue
      }
      // 没有哈希的条目无法证明它没被改过。
      if (typeof store.hash !== 'string' || store.hash === '') {
        findings.push(Object.freeze({
          code: EXPORT_CODES.ENTRY_UNHASHED,
          classId: store.classId,
          path: store.path,
          detail: `${store.path} 没有哈希——没有哈希的导出无法证明它没被改过，` +
            '接收方也无法核对清单与内容是否对得上',
        }))
      }
      entries.push(Object.freeze({
        classId: store.classId, path: store.path, name: store.name ?? null,
        handling: 'portable', format,
        bytes: Number.isFinite(store.bytes) ? store.bytes : null,
        hash: store.hash ?? null,
      }))
      continue
    }

    // `reference-only`：只给清单与哈希，不复制字节。
    entries.push(Object.freeze({
      classId: store.classId, path: store.path, name: store.name ?? null,
      handling: 'reference-only', format: null,
      bytes: Number.isFinite(store.bytes) ? store.bytes : null,
      hash: store.hash ?? null,
    }))
  }

  // ★ ⑤ 内容里扫到疑似密钥值 —— 比"这一类是密钥库"更宽的一层。
  for (const s of scannedSecrets) {
    findings.push(Object.freeze({
      code: EXPORT_CODES.SECRET_VALUE_FOUND,
      path: s.path ?? null,
      key: s.key ?? null,
      detail: `${s.path ?? '（未指明路径）'} 的导出内容里扫到疑似密钥值` +
        `${s.key ? `（键 ${s.key}）` : ''}——密钥库被排除了，但凭据可能抄在别的地方`,
    }))
  }

  return Object.freeze({
    format: EXPORT_FORMAT,
    entries: Object.freeze(entries),
    excluded: Object.freeze(excluded),
    omitted: Object.freeze(omitted),
    findings: Object.freeze(findings),
    counts: Object.freeze({
      entries: entries.length,
      excluded: excluded.length,
      omitted: omitted.length,
      // ★ 只有**会被真的写出去**的字节算进 `bytes`。
      //
      //   `reference-only`（产物）不复制字节——把它的 10 GB 算进"导出体积"，
      //   会让用户以为这次导出要吃 10 GB 磁盘，而实际只写了几百字节的清单。
      //
      //   > 一个「把不复制的东西也算进体积」的读数，
      //   > 与一个「告诉用户这次导出有 10 GB」的读数，是同一个东西——
      //   > 只不过前者在加法上是完全正确的。
      //
      //   所以两个数分开报，两个都由用例钉住。
      bytes: entries.reduce((n, e) => n + (e.handling === 'portable' ? (e.bytes ?? 0) : 0), 0),
      referencedBytes: entries.reduce((n, e) => n + (e.handling === 'reference-only' ? (e.bytes ?? 0) : 0), 0),
    }),
    ok: findings.length === 0,
  })
}

/**
 * 构造**自描述**的导出清单。
 *
 * 没有清单的导出包，接收方需要猜每一份文件是什么。
 *
 * @param {object} args
 * @param {ReadonlyArray<object>} args.entries `planExport().entries`
 * @param {string} args.productVersion
 * @param {string} args.schemaVersion 导出内容的 schema 版本（接收方据此解析）
 * @param {number} [args.nowMs]
 * @param {ReadonlyArray<string>} [args.classes] 导出覆盖到的类（用于核对"类是否漏掉"）
 */
export function buildExportManifest({ entries = [], productVersion, schemaVersion, nowMs = 0, classes = null } = {}) {
  const findings = []
  if (typeof productVersion !== 'string' || productVersion === '') {
    findings.push(Object.freeze({
      code: EXPORT_CODES.MANIFEST_INCOMPLETE, field: 'productVersion',
      detail: '清单没有产品版本——接收方无法知道这是哪个版本导出的',
    }))
  }
  if (typeof schemaVersion !== 'string' || schemaVersion === '') {
    findings.push(Object.freeze({
      code: EXPORT_CODES.MANIFEST_INCOMPLETE, field: 'schemaVersion',
      detail: '清单没有 schema 版本——接收方无法知道该按哪一版解析，' +
        '而没有 schema 版本的导出等于把解析问题推给了他',
    }))
  }
  // 每一条都要说得出类别、形式与哈希。
  for (const e of entries) {
    for (const field of ['classId', 'path']) {
      if (typeof e[field] !== 'string' || e[field] === '') {
        findings.push(Object.freeze({
          code: EXPORT_CODES.MANIFEST_INCOMPLETE, field, entry: e.path ?? null,
          detail: `条目缺 ${field}——清单里的条目必须自描述`,
        }))
      }
    }
    if (e.handling === 'portable' && !PORTABLE_FORMATS.includes(e.format)) {
      findings.push(Object.freeze({
        code: EXPORT_CODES.MANIFEST_INCOMPLETE, field: 'format', entry: e.path,
        detail: `条目 ${e.path} 声明为 portable 却没有可移植格式`,
      }))
    }
    if (e.handling === 'portable' && (typeof e.hash !== 'string' || e.hash === '')) {
      findings.push(Object.freeze({
        code: EXPORT_CODES.ENTRY_UNHASHED, entry: e.path,
        detail: `条目 ${e.path} 没有哈希`,
      }))
    }
  }
  // ★ 覆盖到的类必须**全部**来自台账，且不能少报。
  if (classes !== null) {
    for (const c of classes) {
      if (!DATA_CLASS_IDS.includes(c)) {
        findings.push(Object.freeze({
          code: EXPORT_CODES.CLASS_UNKNOWN, classId: c,
          detail: `清单声明覆盖了类别 ${JSON.stringify(c)}，它不在台账里`,
        }))
      }
    }
  }

  return Object.freeze({
    format: EXPORT_FORMAT,
    productVersion: productVersion ?? null,
    schemaVersion: schemaVersion ?? null,
    exportedAtMs: nowMs,
    // ★ 逐类分组：接收方一眼看得出"这次导出里有哪几类"。
    classes: Object.freeze(Object.fromEntries(
      DATA_CLASS_IDS.map((id) => [id, entries.filter((e) => e.classId === id).length]),
    )),
    entryCount: entries.length,
    entries: Object.freeze([...entries]),
    findings: Object.freeze(findings),
    ok: findings.length === 0,
  })
}

/**
 * **接收方**能不能读这个导出包。
 *
 * ★ 这一段的视角是"我不是 Legion，我拿到一个 zip"——
 *   这正是"导出"这个动作的全部意义所在。
 *
 * @param {object} manifest
 * @returns {{readable: boolean, problems: ReadonlyArray<string>, classesPresent: ReadonlyArray<string>,
 *            portableCount: number, referenceOnlyCount: number}}
 */
export function assertExportReadable(manifest = {}) {
  const problems = []
  if (manifest.format !== EXPORT_FORMAT) {
    problems.push(`未知的导出格式 ${JSON.stringify(manifest.format ?? null)}（本工具认 ${EXPORT_FORMAT}）`)
  }
  if (typeof manifest.schemaVersion !== 'string' || manifest.schemaVersion === '') {
    problems.push('没有 schema 版本——无法知道该按哪一版解析')
  }
  if (typeof manifest.productVersion !== 'string' || manifest.productVersion === '') {
    problems.push('没有产品版本——无法回溯这是哪个版本导出的')
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : []
  if (!Number.isInteger(manifest.entryCount)) {
    problems.push('没有条目数——接收方无法判断包是不是被截断了')
  } else if (manifest.entryCount !== entries.length) {
    problems.push(`清单声明 ${manifest.entryCount} 条，实际 ${entries.length} 条——包被改过或截断了`)
  }

  let portable = 0
  let referenceOnly = 0
  for (const e of entries) {
    if (e.classId === 'secret' || e.handling === 'never') {
      problems.push(`条目 ${e.path} 是密钥库——它不该出现在任何导出包里`)
      continue
    }
    if (e.handling === 'reference-only') { referenceOnly++; continue }
    if (!PORTABLE_FORMATS.includes(e.format)) {
      problems.push(`条目 ${e.path} 的格式 ${JSON.stringify(e.format ?? null)} 不可移植，接收方读不了`)
      continue
    }
    if (typeof e.hash !== 'string' || e.hash === '') {
      problems.push(`条目 ${e.path} 没有哈希——接收方无法核对内容与清单是否一致`)
    }
    portable++
  }
  const classesPresent = DATA_CLASS_IDS.filter((id) => (manifest.classes?.[id] ?? 0) > 0)
  return Object.freeze({
    readable: problems.length === 0,
    problems: Object.freeze(problems),
    classesPresent: Object.freeze(classesPresent),
    portableCount: portable,
    referenceOnlyCount: referenceOnly,
  })
}

/**
 * 装载期自检：把四条核心判据各真的跑一遍，留下算出来的值。
 */
function auditDataExport() {
  const problems = []
  const mk = (patch) => ({
    classId: 'database', path: 'data/team.db', format: 'json', bytes: 10, hash: 'h1', ...patch,
  })

  // ① ★ 密钥库**永远**不进导出包——而且这一条要先于其它判断。
  const secret = planExport({ stores: [mk({ classId: 'secret', path: 'data/.secrets/credentials.yaml', format: 'json' })] })
  if (!secret.findings.some((f) => f.code === EXPORT_CODES.SECRET_IN_EXPORT)) {
    problems.push('密钥库没有被排除——那导出包会把用户的所有下游账号一起交出去')
  }
  if (secret.entries.length !== 0) problems.push('密钥库进了导出条目')

  // ② ★ 不可移植格式被拒（那是备份，不是导出）。
  const dbFile = planExport({ stores: [mk({ format: 'sqlite' })] })
  if (!dbFile.findings.some((f) => f.code === EXPORT_CODES.FORMAT_UNPORTABLE)) {
    problems.push('把 .db 当导出没有被拒——用户会拿到一个他打不开的文件')
  }

  // ③ ★ 导出不得改动源。
  const destructive = planExport({ stores: [mk({ openedForWrite: true })] })
  if (!destructive.findings.some((f) => f.code === EXPORT_CODES.DESTRUCTIVE)) {
    problems.push('以写模式打开的落点没有被拒——导出会破坏正在运行的实例')
  }

  // ④ ★ 工作区默认不导出**但要报出来**。
  const ws = planExport({ stores: [mk({ classId: 'workspace', path: 'data/ws' })] })
  if (!ws.findings.some((f) => f.code === EXPORT_CODES.WORKSPACE_OMITTED)) {
    problems.push('工作区被静默漏掉了——用户以为拿到了全部数据')
  }
  const wsIncluded = planExport({ stores: [mk({ classId: 'workspace', path: 'data/ws' })], include: { workspace: true } })
  if (wsIncluded.entries.length !== 1) problems.push('显式要求导出工作区却没有导出')

  // ⑤ 正常输入必须干净。
  const clean = planExport({ stores: [mk({})] })
  if (!clean.ok) problems.push(`正常输入下导出有未闭合项：${clean.findings.map((f) => f.code).join('/')}`)

  // ⑥ 清单自描述：往返一遍必须"接收方能读"。
  const manifest = buildExportManifest({
    entries: clean.entries, productVersion: '1.0.0', schemaVersion: 'ledger@1', nowMs: 1000,
  })
  if (!manifest.ok) problems.push(`清单自身有问题：${manifest.findings.map((f) => f.code).join('/')}`)
  const readable = assertExportReadable(manifest)
  if (!readable.readable) problems.push(`自己造的清单接收方读不了：${readable.problems.join('; ')}`)

  // ⑦ 反向控制：把 schemaVersion 去掉，接收方必须读不了。
  const noSchema = assertExportReadable(buildExportManifest({
    entries: clean.entries, productVersion: '1.0.0', schemaVersion: '', nowMs: 1000,
  }))
  if (noSchema.readable) problems.push('没有 schema 版本的包被判为可读——接收方得靠猜')

  // ⑧ ★ 两张表必须覆盖**同一批类**：漏一个类，那个类的数据会无声地不出现在导出包里。
  const covered = new Set(Object.keys(EXPORT_CLASS_POLICY))
  const missing = DATA_CLASS_IDS.filter((id) => !covered.has(id))
  if (missing.length > 0) problems.push(`导出台账漏了类别：${missing.join(', ')}`)
  const extra = [...covered].filter((id) => !DATA_CLASS_IDS.includes(id))
  if (extra.length > 0) problems.push(`导出台账里有台账外的类别：${extra.join(', ')}`)
  // 每一类的 handling 都必须合法
  for (const [id, p] of Object.entries(EXPORT_CLASS_POLICY)) {
    if (!EXPORT_HANDLINGS.includes(p.handling)) problems.push(`类别 ${id} 的处置 ${p.handling} 不合法`)
    if (typeof p.why !== 'string' || p.why === '') problems.push(`类别 ${id} 没有说明理由`)
    if (p.handling === 'portable' && !PORTABLE_FORMATS.includes(p.format)) {
      problems.push(`类别 ${id} 声明 portable 但格式 ${p.format} 不可移植`)
    }
  }
  // ★ 密钥库必须是 `never`——它可以被改成别的，但那样上面第 ① 条会红。
  if (EXPORT_CLASS_POLICY.secret.handling !== 'never') problems.push('密钥库的处置不是 never')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    format: EXPORT_FORMAT,
    portableFormats: PORTABLE_FORMATS,
    nonPortableFormats: NON_PORTABLE_FORMATS,
    handlings: EXPORT_HANDLINGS,
    classIds: DATA_CLASS_IDS,
    samples: Object.freeze({
      secretExcluded: secret.entries.length === 0,
      secretFinding: secret.findings.map((f) => f.code),
      unportableFinding: dbFile.findings.map((f) => f.code),
      destructiveFinding: destructive.findings.map((f) => f.code),
      workspaceOmittedFinding: ws.findings.map((f) => f.code),
      cleanOk: clean.ok,
      roundTripReadable: readable.readable,
      roundTripClasses: readable.classesPresent,
      noSchemaReadable: noSchema.readable,
      policyHandlings: Object.fromEntries(Object.entries(EXPORT_CLASS_POLICY).map(([k, v]) => [k, v.handling])),
    }),
  })
}

export const DATA_EXPORT_CHECKED = auditDataExport()
