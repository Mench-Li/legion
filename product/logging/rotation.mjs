// product/logging/rotation.mjs
// ============================================================================
// PRT-709：日志轮转与磁盘保护（判定与执行）
//
// ## 这个文件为什么存在
//
// 在它之前，整个 `product/launcher/` **没有任何地方读 `child.stdout` /
// `child.stderr`**（`git grep` 无命中），而子进程是按
// `stdio: ['ignore', 'pipe', 'pipe']` 起的。两件后果，第二件更重：
//
//   ① 子进程的全部输出**没有人看**——运行时诊断（那正是排查最需要的东西）
//      直接消失在管道里；
//   ② **管道被写满之后，子进程会阻塞在 write 上**。Windows 上的管道缓冲区
//      是几十 KB 量级，一个话多的进程会在启动几秒后**永久卡住**，
//      而它既不退出也不报错——熔断器看不到任何失败，就永远不会介入。
//
//   > 一个把子进程的输出丢掉、并且在它写满缓冲区时让它卡住的启动器，
//   > 与一个"进程跑着但什么也不干"的启动器，在用户眼里是同一个东西。
//
// 所以这一批交付三件：**排空管道**（`sink.mjs`）、**轮转与保留**（本文件）、
// **磁盘保护**（本文件）。
//
// ## 磁盘保护的顺序不能反
//
//   · 先**轮转**（把写满的活动文件挪走）；
//   · 再**修剪**（按保留数量与总量预算删最旧的**已轮转**文件）；
//   · 最后**如实报告**还差多少。
//
// 反过来（先删再轮转）会在一瞬间出现"当前日志没了、新日志还没建好"的窗口，
// 而那正是故障时刻。
//
// ## 三条绝不做的事
//
//   ① **绝不删活动文件**（没有代数后缀的那个）。它是正在写的那一份；
//   ② **绝不删刚轮转出来的那一代**（代数 1）。否则 `keepFiles=0` 或预算极小
//      时会出现"转了一圈等于什么都没留下"的churn——轮转本身成了消耗；
//   ③ **绝不把"没做成"报成成功**。Windows 上另一个进程持有文件句柄时
//      `rename` 会失败（EPERM/EBUSY），这时**不能**假装已经轮转，
//      也**不能**转而删掉活动文件来"腾地方"。
//
//      > 一个在磁盘写满时删掉当前日志的"保护"，把证据和空间一起弄没了。
//
// 判定是**纯函数**（`planRotation`），执行单独一层（`rotateLogs`）。
// 理由与本仓库其他几处相同：**落盘那一步无法在用例里逐条验证，判定那一步可以**。
// ============================================================================

/** 本模块的具名码。 */
export const LOG_CODES = Object.freeze({
  /** 策略本身不合法（负值、keepFiles 不是整数……）。 */
  BAD_POLICY: 'LOG_BAD_POLICY',
  /** 目标文件被别的进程占着，轮转没做成。 */
  FILE_IN_USE: 'LOG_ROTATE_FILE_IN_USE',
  /** 轮转本身失败（非占用类）。 */
  ROTATE_FAILED: 'LOG_ROTATE_FAILED',
  /** 某个待删文件删不掉。 */
  PRUNE_FAILED: 'LOG_PRUNE_FAILED',
  /** 修剪之后**仍然**超预算——必须被看见，不能静默。 */
  STILL_OVER_BUDGET: 'LOG_STILL_OVER_BUDGET',
  /** 可用磁盘空间低于下限。 */
  DISK_PRESSURE: 'LOG_DISK_PRESSURE',
  /** 连目录有多少文件都读不出来。 */
  UNREADABLE: 'LOG_UNREADABLE',
})

/**
 * 默认策略。**任何一个值都不是"拍脑袋"**，但也都必须可被配置覆盖：
 * 诊断包（PRT-710）按 8 MiB/文件、64 MiB/包里导出日志，这里的单文件上限
 * 刻意与之同量级——否则"日志太大所以诊断包里没有它"会成为一个常见抱怨。
 */
export const DEFAULT_LOG_POLICY = Object.freeze({
  /** 单个文件超过它就轮转。 */
  maxFileBytes: 8 * 1024 * 1024,
  /** 整个日志目录的总预算。 */
  maxTotalBytes: 128 * 1024 * 1024,
  /** 每个 base 最多保留几代**已轮转**文件（不含活动文件）。 */
  keepFiles: 5,
  /** 可用空间低于它就算"磁盘紧张"。 */
  minFreeBytes: 512 * 1024 * 1024,
})

/** 校验策略。**宁可拒绝也不猜**：一个被静默纠正的负值会让用户以为配置生效了。 */
export function validateLogPolicy(policy = {}) {
  const merged = { ...DEFAULT_LOG_POLICY, ...(policy ?? {}) }
  const problems = []
  for (const key of Object.keys(DEFAULT_LOG_POLICY)) {
    const v = merged[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      problems.push(`策略项 \`${key}\` 必须是 ≥0 的有限数，实际 ${JSON.stringify(v)}`)
    }
  }
  if (problems.length === 0 && !Number.isInteger(merged.keepFiles)) {
    problems.push(`策略项 \`keepFiles\` 必须是整数，实际 ${JSON.stringify(merged.keepFiles)}`)
  }
  return { ok: problems.length === 0, policy: merged, problems }
}

/**
 * 解析一个日志文件名。
 *
 * 约定：`app.log` 是**活动文件**（`generation: null`），
 * `app.log.1` 是最近一次轮转出来的，数字越大越旧。
 *
 * 认不出的名字返回 `{ base: null }`——调用方必须**原样留着**它们，
 * 而不是当作可删的日志。日志目录里出现一个不认识的文件，
 * 与它是"最旧的那一代"完全是两回事。
 */
export function parseLogName(name) {
  const m = /^(.*)\.(\d+)$/.exec(String(name ?? ''))
  if (m === null) return { base: String(name ?? ''), generation: null }
  const generation = Number(m[2])
  if (!Number.isSafeInteger(generation) || generation < 1) {
    // `.0` 或超大数字：不当作代数，避免把它算进"最旧的可删那一批"
    return { base: String(name ?? ''), generation: null }
  }
  return { base: m[1], generation }
}

/**
 * 轮转计划（**纯函数**：给定目录快照与可用空间，算出该做什么）。
 *
 * @param {object} deps
 * @param {Array<{name: string, size: number, mtimeMs?: number}>} deps.entries
 * @param {object} [deps.policy]
 * @param {number|null} [deps.freeBytes] `null` 表示**没查**（不是"空间充足"）
 */
export function planRotation({ entries = [], policy = {}, freeBytes = null } = {}) {
  const check = validateLogPolicy(policy)
  if (!check.ok) {
    return {
      ok: false,
      code: LOG_CODES.BAD_POLICY,
      message: `日志策略不合法：${check.problems.join('；')}`,
      problems: check.problems,
      rotate: [],
      prune: [],
      notes: [],
    }
  }
  const pol = check.policy
  const notes = []

  const active = []
  const rotated = []
  const foreign = []
  for (const e of entries) {
    const p = parseLogName(e.name)
    const row = { name: e.name, size: Number(e.size) || 0, mtimeMs: Number(e.mtimeMs) || 0 }
    if (p.generation === null) {
      // 活动文件 vs 完全不认识的文件：靠"像不像日志"分。
      // 认不出的**一个都不动**，并记一条 note，让用户知道目录里有别的东西。
      if (/\.log$/.test(row.name)) active.push(row)
      else foreign.push(row)
    } else {
      rotated.push({ ...row, base: p.base, generation: p.generation })
    }
  }

  if (foreign.length > 0) {
    notes.push(Object.freeze({
      code: 'FOREIGN_FILES',
      message: `日志目录里有 ${foreign.length} 个不按日志命名约定的文件，**一个都没动**：` +
        `${foreign.map((f) => f.name).slice(0, 5).join('、')}${foreign.length > 5 ? ' 等' : ''}。` +
        '它们既不会被轮转也不会被删——不认识的文件的"最旧"没有定义',
    }))
  }

  // ── ① 该轮转哪些活动文件 ──
  const rotate = active.filter((a) => a.size >= pol.maxFileBytes).map((a) => a.name)

  // ── ② 保留数量：每个 base 只留最新的 keepFiles 代 ──
  const byBase = new Map()
  for (const r of rotated) {
    if (!byBase.has(r.base)) byBase.set(r.base, [])
    byBase.get(r.base).push(r)
  }
  const prune = []
  const prunedNames = new Set()
  const addPrune = (row, why) => {
    if (prunedNames.has(row.name)) return
    // **绝不删代数 1**：那是最近一次轮转的产物。删了它，轮转就等于 churn。
    if (row.generation <= 1) {
      if (!notes.some((n) => n.code === 'PROTECTED_GEN1')) {
        notes.push(Object.freeze({
          code: 'PROTECTED_GEN1',
          message: '代数 1 的文件不参与修剪：它是最近一次轮转的产物。' +
            '把它删掉的话，"轮转"就只剩下把日志扔掉这一个效果了',
        }))
      }
      return
    }
    prunedNames.add(row.name)
    prune.push({ name: row.name, size: row.size, why })
  }

  for (const [base, list] of byBase) {
    const sorted = [...list].sort((a, b) => b.generation - a.generation) // 最旧在前
    for (const row of sorted) {
      if (row.generation > pol.keepFiles) addPrune(row, `超过每个 base 的保留代数 ${pol.keepFiles}`)
    }
    void base
  }

  // ── ③ 总量预算 ──
  const totalNow = () => {
    let n = 0
    for (const a of active) n += a.size
    for (const r of rotated) if (!prunedNames.has(r.name)) n += r.size
    return n
  }
  let total = totalNow()
  if (total > pol.maxTotalBytes) {
    // 从最旧的开始删。**活动文件永远不进这个候选列表。**
    const candidates = rotated
      .filter((r) => !prunedNames.has(r.name) && r.generation > 1)
      .sort((a, b) => (b.generation - a.generation) || (a.mtimeMs - b.mtimeMs))
    for (const row of candidates) {
      if (total <= pol.maxTotalBytes) break
      addPrune(row, '超过日志目录总预算')
      total -= row.size
    }
  }
  total = totalNow()

  // ── ④ 磁盘压力：更激进地删，但**仍然不碰活动文件与代数 1** ──
  let pressure = null
  if (freeBytes !== null && Number.isFinite(freeBytes) && freeBytes < pol.minFreeBytes) {
    pressure = { freeBytes, minFreeBytes: pol.minFreeBytes, reclaimed: 0 }
    const extra = rotated
      .filter((r) => !prunedNames.has(r.name) && r.generation > 1)
      .sort((a, b) => b.generation - a.generation)
    for (const row of extra) {
      addPrune(row, `可用磁盘空间不足（${freeBytes} < ${pol.minFreeBytes}）`)
      pressure.reclaimed += row.size
    }
    total = totalNow()
    // **不管腾没腾出空间，磁盘紧张这件事本身都必须报出去。**
    //
    // 第一版只在"仍然超预算或一点也没腾出来"时才报，于是"磁盘快满了但我们
    // 顺手删了几百 KB"这种情况**完全没有提示**——而它正是最需要提示的一种：
    // 风险还在（盘快满了），用户却因为看到一次成功的轮转而以为没事。
    //
    //   > 一次成功的清理，不是"磁盘没问题"的证据。
    notes.push(Object.freeze({
      code: LOG_CODES.DISK_PRESSURE,
      severity: 'error',
      message: `可用磁盘空间 ${freeBytes} 字节，低于下限 ${pol.minFreeBytes}。` +
        (pressure.reclaimed === 0
          ? '**已经没有任何可以删的已轮转文件**——空间得从别处腾。'
          : `已额外腾出 ${pressure.reclaimed} 字节，但这**不代表磁盘就够用了**：` +
            '下限没有被满足，风险仍然在。') +
        '注意：**活动日志不会被删**——在磁盘写满的时刻删掉当前日志，' +
        '等于把证据和空间一起弄没了',
    }))
    if (total > pol.maxTotalBytes) {
      notes.push(Object.freeze({
        code: LOG_CODES.STILL_OVER_BUDGET,
        severity: 'error',
        message: `磁盘紧张之下修剪后仍是 ${total} 字节，超过总预算 ${pol.maxTotalBytes}：` +
          '能删的已轮转文件都删了，剩下的只能在预算之外',
      }))
    }
  }

  // ── ⑤ 修剪之后仍然超预算：**必须可见** ──
  const overBudget = total > pol.maxTotalBytes
  if (overBudget) {
    notes.push(Object.freeze({
      code: LOG_CODES.STILL_OVER_BUDGET,
      message: `修剪之后日志目录仍是 ${total} 字节，超过总预算 ${pol.maxTotalBytes}。` +
        '能删的已轮转文件已经删完了。**剩下的只能靠轮转**——' +
        (rotate.length > 0
          ? '而有文件需要轮转，请检查轮转是否失败（多半是文件被别的进程占着）。'
          : '而没有文件达到轮转阈值，说明是**单个活动文件本身就超预算**：' +
            '这时唯一的办法是调小 `maxFileBytes`，让它在写满之前就被轮转。'),
    }))
  }

  return {
    ok: true,
    code: null,
    policy: pol,
    rotate,
    prune,
    notes,
    before: {
      totalBytes: (() => {
        let n = 0
        for (const e of entries) n += Number(e.size) || 0
        return n
      })(),
      freeBytes,
      activeCount: active.length,
      rotatedCount: rotated.length,
      foreignCount: foreign.length,
    },
    after: { totalBytes: total },
    overBudget,
    pressure,
  }
}

/** 从 `statfs` 的结果算可用字节。**读不出来时返回 `null`（没查），不是 0。** */
export function freeBytesFromStatfs(st) {
  if (st === null || st === undefined) return null
  const { bsize, bavail } = st
  if (typeof bsize !== 'number' || typeof bavail !== 'number') return null
  const v = bsize * bavail
  return Number.isFinite(v) && v >= 0 ? v : null
}

/** 判断一个 rename 失败是不是"文件被占着"。**Windows 与 POSIX 的码不一样。** */
export function isInUseError(e) {
  const code = e?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ETXTBSY'
}

/**
 * 执行轮转。
 *
 * @param {object} deps
 * @param {string} deps.logDir
 * @param {object} [deps.policy]
 * @param {object} deps.fs           `{ readdirSync, statSync, renameSync, rmSync, statfsSync }`
 * @returns {Promise<object>} 实际做成了什么（**不是**"打算做什么"）
 */
export async function rotateLogs({ logDir, policy = {}, fs } = {}) {
  if (typeof logDir !== 'string' || logDir === '') {
    return Object.freeze({
      ok: false, code: LOG_CODES.UNREADABLE, message: '未给出日志目录：不猜默认位置',
      rotated: [], pruned: [], failures: [], notes: [],
    })
  }
  const check = validateLogPolicy(policy)
  if (!check.ok) {
    return Object.freeze({
      ok: false, code: LOG_CODES.BAD_POLICY,
      message: `日志策略不合法：${check.problems.join('；')}`,
      rotated: [], pruned: [], failures: [], notes: [],
    })
  }
  const pol = check.policy

  // ── 读目录快照 ──
  let entries = []
  try {
    const names = fs.readdirSync(logDir)
    entries = names.map((name) => {
      let size = 0
      let mtimeMs = 0
      try {
        const st = fs.statSync(`${logDir}/${name}`)
        size = st.size
        mtimeMs = st.mtimeMs ?? 0
      } catch { /* 读不到就按 0 算，后面按大小判定时它不会被轮转 */ }
      return { name, size, mtimeMs }
    })
  } catch (e) {
    return Object.freeze({
      ok: false, code: LOG_CODES.UNREADABLE,
      message: `读不出日志目录 ${logDir}：${e?.code ?? e?.name ?? 'Error'}。` +
        '**读不出来不等于没有日志要轮转**——这里如实报错，不当作"目录是空的"',
      rotated: [], pruned: [], failures: [], notes: [],
    })
  }

  // ── 可用空间。查不到就是 `null`（没查），**不是**"空间充足" ──
  let freeBytes = null
  let freeChecked = false
  try {
    if (typeof fs.statfsSync === 'function') {
      freeBytes = freeBytesFromStatfs(fs.statfsSync(logDir))
      freeChecked = freeBytes !== null
    }
  } catch { freeBytes = null; freeChecked = false }

  const plan = planRotation({ entries, policy: pol, freeBytes })
  if (plan.ok !== true) {
    return Object.freeze({ ...plan, rotated: [], pruned: [], failures: [] })
  }

  const byName = new Map(entries.map((e) => [e.name, e]))
  const notes = [...plan.notes]
  if (!freeChecked) {
    notes.push(Object.freeze({
      code: 'FREE_SPACE_UNKNOWN',
      message: '**没有查**可用磁盘空间（`statfs` 不可用或读失败）：本次只按字节预算做保护，' +
        '磁盘写满这一类风险没有被覆盖。不要把这条读成"空间充足"',
    }))
  }

  // ── 先删超保留的代，给移位腾位置 ──
  const pruned = []
  const failures = []
  for (const p of plan.prune) {
    try {
      fs.rmSync(`${logDir}/${p.name}`, { force: true })
      pruned.push(p.name)
    } catch (e) {
      failures.push(Object.freeze({
        name: p.name, code: LOG_CODES.PRUNE_FAILED,
        message: `删不掉 ${p.name}（${e?.code ?? e?.name ?? 'Error'}）：${p.why}`,
      }))
    }
  }

  // ── 再移位。**必须从最大代数往下**：`n → n+1` 时 `n+1` 必须已被腾空。
  //    反过来的话，第一次 rename 就会把还需要的旧日志覆盖掉。
  const rotated = []
  for (const activeName of plan.rotate) {
    const gens = buildGenIndex(entries, activeName)
    const maxGen = gens.length === 0 ? 0 : Math.max(...gens.map((g) => g.generation))
    // 移位的上限：保留代数。超出保留的代数在删完之后本来就不该存在。
    const ceiling = Math.max(0, Math.min(maxGen, pol.keepFiles - 1))
    let shifted = true
    for (let g = ceiling; g >= 1; g--) {
      const from = `${logDir}/${activeName}.${g}`
      const to = `${logDir}/${activeName}.${g + 1}`
      const exists = gens.some((x) => x.generation === g)
      if (!exists) continue
      try {
        try { fs.rmSync(to, { force: true }) } catch { /* 目标不存在是常态 */ }
        fs.renameSync(from, to)
      } catch (e) {
        shifted = false
        failures.push(Object.freeze({
          name: `${activeName}.${g}`, code: LOG_CODES.ROTATE_FAILED,
          message: `移位失败（${activeName}.${g} → .${g + 1}）：${e?.code ?? e?.name ?? 'Error'}`,
        }))
        break
      }
    }
    if (!shifted) continue
    try {
      try { fs.rmSync(`${logDir}/${activeName}.1`, { force: true }) } catch { /* 同上 */ }
      fs.renameSync(`${logDir}/${activeName}`, `${logDir}/${activeName}.1`)
      rotated.push(activeName)
    } catch (e) {
      // 这是**最要紧的一条**：Windows 上另一个进程持有句柄时 rename 会失败。
      // 绝不因此转而删掉活动文件来"腾地方"。
      const inUse = isInUseError(e)
      failures.push(Object.freeze({
        name: activeName,
        code: inUse ? LOG_CODES.FILE_IN_USE : LOG_CODES.ROTATE_FAILED,
        message: inUse
          ? `${activeName} 被别的进程占着，轮转没做成（${e?.code}）。` +
            '**没有删它**：在磁盘写满的时刻删掉当前日志，等于把证据和空间一起弄没了。' +
            '请让持有它的进程先退出，或改用按进程分文件的日志命名'
          : `${activeName} 轮转失败：${e?.code ?? e?.name ?? 'Error'}`,
      }))
    }
  }

  return Object.freeze({
    ok: failures.length === 0,
    code: failures.length === 0 ? null : failures[0].code,
    policy: pol,
    rotated: Object.freeze(rotated),
    pruned: Object.freeze(pruned),
    failures: Object.freeze(failures),
    notes: Object.freeze(notes),
    before: plan.before,
    after: plan.after,
    plannedRotate: Object.freeze(plan.rotate),
    plannedPrune: Object.freeze(plan.prune.map((p) => p.name)),
    overBudget: plan.overBudget,
    freeChecked,
    message: failures.length === 0
      ? `轮转完成：轮转 ${rotated.length} 个、删除 ${pruned.length} 个（计划轮转 ${plan.rotate.length} 个）`
      : `轮转未能全部完成：${failures.length} 项失败（轮转成功 ${rotated.length} 个、删除 ${pruned.length} 个）`,
  })
}

/** 某个 base 已存在的代数列表。 */
function buildGenIndex(entries, activeName) {
  const out = []
  for (const e of entries) {
    const p = parseLogName(e.name)
    if (p.generation !== null && p.base === activeName) out.push({ name: e.name, generation: p.generation })
  }
  return out
}
