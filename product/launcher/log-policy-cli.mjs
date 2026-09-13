// product/launcher/log-policy-cli.mjs
// ============================================================================
// PRT-709 收尾：**改日志策略的入口**
//
// ## 为什么这一条是本任务真正的缺口
//
// PRT-709 的正文里有一句自我更正：「`logPolicy` **已**接在产品配置文件的键上……
// 真正还缺的是**改它们的界面**（用户得手编配置文件）」。
//
// 而"手编配置文件"这件事有一个不显眼的后果：**用户改完不知道有没有生效。**
// 配置有四层（builtin-defaults / product-config / workspace-config / user-settings），
// 后一层覆盖前一层；而 `log.*` 键**只从 product-config 读**
// （见 `config.mjs` 那段映射）。于是最常见的一幕是：
//
//   用户在工作空间配置里写了 `log.keepFiles: 20`，什么都没发生，
//   而产品**不会**告诉他"这个键只从产品配置读"。
//
//   > 一个"改了但没有任何反应"的配置界面，
//   > 与一个"这个键根本不生效"的配置界面，在用户看来是同一个东西——
//   > 只不过前者会让他反复改同一个地方。
//
// 所以这一层有**两**件事要做，而第二件比第一件重要：
//
//   ① 能改（`--set-log-policy`）；
//   ② 能看懂**现在到底是什么值、它是谁给的**（`--log-policy`，带 provenance）。
//
// ## 写这一层要守住的四件事
//
// ① **先校验再写。** 复用 `validateLogPolicy`，不在这一层另写一套判据——
//    两套判据就意味着"哪一套生效"会成为下一个必须回答的排查问题。
// ② **配置坏掉时拒绝写。** 读不出来的配置（坏 JSON）如果被"顺手重写一遍"，
//    用户的原始内容就**永久没了**——而它可能只是少了一个逗号。
// ③ **原子写**（临时文件 + rename）：写到一半断电会留下半截 JSON，
//    而半截 JSON 在配置层里等于**整份配置回到默认值**。
// ④ **不认识的键原样保留。** 这一层只认识 `log.*` 四个键，
//    把它读进来的东西重写出去时，别的键（包括这一层不认识的）必须一个不少。
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { DEFAULT_LOG_POLICY, validateLogPolicy } from '../logging/rotation.mjs'

/** 这一层认识的键 → 配置文件里的点号路径。 */
export const LOG_POLICY_KEYS = Object.freeze({
  maxFileBytes: 'log.maxFileBytes',
  maxTotalBytes: 'log.maxTotalBytes',
  keepFiles: 'log.keepFiles',
  minFreeBytes: 'log.minFreeBytes',
})

/** 结果码。 */
export const LOG_CLI_CODES = Object.freeze({
  /** 没有可解析的产品配置文件路径。 */
  NO_CONFIG_PATH: 'LOGCLI_NO_CONFIG_PATH',
  /** 现有配置文件读不出来 / 不是 JSON 对象：**拒绝写**。 */
  CONFIG_UNREADABLE: 'LOGCLI_CONFIG_UNREADABLE',
  /** 用户给的值不合法。 */
  BAD_VALUE: 'LOGCLI_BAD_VALUE',
  /** 不认识的键名。 */
  UNKNOWN_KEY: 'LOGCLI_UNKNOWN_KEY',
  /** 写失败（权限/磁盘）。 */
  WRITE_FAILED: 'LOGCLI_WRITE_FAILED',
  /** 没有任何要改的键。 */
  NOTHING_TO_SET: 'LOGCLI_NOTHING_TO_SET',
})

/** 值 → 人类可读的字节数（`--log-policy` 的输出用）。 */
export function humanBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n)
  for (const [unit, scale] of [['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024]]) {
    if (n >= scale) {
      const v = n / scale
      return `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit}`
    }
  }
  return `${n} B`
}

/**
 * 解析 `k=v,k=v` 形式。
 *
 * 值一律**当数字解析**：日志策略四项全是数。把它们当字符串收下会让
 * `validateLogPolicy` 报一句"必须是 ≥0 的有限数，实际 \"5\""——
 * 一句关于类型的话，而用户明明写的就是个数字的样子。
 *
 * @returns {{ok: true, values: object} | {ok: false, code: string, message: string}}
 */
export function parsePolicyAssignments(spec) {
  const values = {}
  const parts = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) {
    return Object.freeze({
      ok: false, code: LOG_CLI_CODES.NOTHING_TO_SET,
      message: '没有给出任何要改的键：用法 --set-log-policy=keepFiles=10,maxFileBytes=4194304',
    })
  }
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      return Object.freeze({
        ok: false, code: LOG_CLI_CODES.BAD_VALUE,
        message: `「${part}」不是 k=v 形式（例：keepFiles=10）`,
      })
    }
    const key = part.slice(0, eq).trim()
    const raw = part.slice(eq + 1).trim()
    if (!(key in LOG_POLICY_KEYS)) {
      return Object.freeze({
        ok: false, code: LOG_CLI_CODES.UNKNOWN_KEY,
        message: `不认识的日志策略键「${key}」：只认识 ${Object.keys(LOG_POLICY_KEYS).join(' / ')}`,
      })
    }
    if (raw === '' || !/^\d+$/.test(raw)) {
      return Object.freeze({
        ok: false, code: LOG_CLI_CODES.BAD_VALUE,
        message: `「${key}」的值必须是**非负整数**（收到 ${JSON.stringify(raw)}）：`
          + '日志策略四项都是字节数或份数，写小数或负数只会让它在后面被拒掉，'
          + '而那时错误信息离你输的那一行已经很远了',
      })
    }
    values[key] = Number(raw)
  }
  return Object.freeze({ ok: true, values })
}

/** 从合并后的配置里读出**实际生效**的日志策略（缺省项补 `DEFAULT_LOG_POLICY`）。 */
export function effectiveLogPolicy(merged) {
  const out = {}
  const cur = merged?.value ?? merged
  const layer = cur?.log
  const raw = layer !== null && typeof layer === 'object' ? layer : {}
  for (const key of Object.keys(DEFAULT_LOG_POLICY)) {
    const v = raw[key]
    // 与 `config.mjs` 同一套判据：不合法的值**不进**策略，
    // 于是这里显示的是"默认值 + 来源：默认"，而不是把坏值展示成生效值。
    const usable = typeof v === 'number' && Number.isFinite(v) && v >= 0
      && (key !== 'keepFiles' || Number.isInteger(v))
    out[key] = usable ? v : DEFAULT_LOG_POLICY[key]
  }
  return Object.freeze(out)
}

/**
 * 把当前生效的日志策略渲染成可读文本。
 *
 * ★ 每一项都带**来源**。这是这一层存在的理由：
 *   "值是多少"与"这个值是谁给的"必须一起说，否则
 *   「我改了但没生效」是一个无法回答的问题。
 *
 * ★ `diagnostics` 里的 **error** 必须排在最前面，而且要排得很响。
 *
 *   这是本层第一版漏掉的一幕（真实 CLI 冒烟量出来的）：配置文件是坏 JSON 时，
 *   `loadProductConfig` 会报 `CONFIG_INVALID_JSON` 并让**整份配置被忽略**，
 *   而这一层当时只把 `merged` 拿来渲染——于是四项全都写着"（默认值）"。
 *
 *   那份输出看起来**完全正常**。用户会得到"一切正常、都是默认值"这个结论，
 *   而真相是"你的配置文件根本没被读进去"。本任务要消灭的
 *   「改了但没反应」，恰恰就是在这条路径上被**制造**出来的。
 *
 *     > 一个把"你的配置被整份忽略了"渲染成"一切正常"的查看器，
 *     > 与一个"配置确实没问题"的查看器，在屏幕上是同一份输出——
 *     > 只不过前者会让用户放心地走开。
 */
export function describeLogPolicy({ merged = null, provenance = {}, filePath = null, diagnostics = [] } = {}) {
  const eff = effectiveLogPolicy(merged)
  const lines = []
  const errors = diagnostics.filter((d) => d?.severity === 'error')
  if (errors.length > 0) {
    // ★ 先说不好的消息，再说值。顺序反过来（先列默认值）的话，
    //   用户很可能只看前几行就走了。
    lines.push('✖ 产品配置有问题：下面这些值**不是你的配置**，而是默认值。')
    // 兜底标签（诊断通常自带 code）：用一个不含糊的名字，而不是 `CONFIG`——
    // 后者会让 `scan` 把它当成一个疑似环境变量，也让读日志的人以为有个叫 CONFIG 的东西。
    for (const d of errors) lines.push(`  ✖ ${d.code ?? 'CONFIG_DIAGNOSTIC'}：${d.message ?? ''}`)
    lines.push('  （配置文件必须能被完整读懂；否则所有值都会悄悄退回默认值）')
    lines.push('')
  }
  lines.push('当前生效的日志策略：')
  for (const key of Object.keys(DEFAULT_LOG_POLICY)) {
    const src = provenance[LOG_POLICY_KEYS[key]] ?? null
    const shown = key.toLowerCase().includes('bytes') ? `${eff[key]}（${humanBytes(eff[key])}）` : String(eff[key])
    // 有错时把"（默认值）"换成更明确的一句：它此刻的含义是
    // "配置没读进来所以用了默认值"，而不是"你没配过"。
    const origin = src !== null
      ? `← ${src}`
      : (errors.length > 0 ? '← 默认值（配置未生效）' : '（默认值）')
    lines.push(`  ${key.padEnd(14)} ${shown.padEnd(28)} ${origin}`)
  }
  if (filePath !== null) lines.push(`  配置文件：${filePath}`)
  // ★ 这句话必须出现：`log.*` 只从 product-config 读。
  //   不说的话，用户在工作空间配置里写 `log.keepFiles` 之后
  //   会得到一个"什么都不发生"的结果，而产品不会解释。
  lines.push('  （`log.*` 只从**产品配置**读：写在别层的同名键不生效，也不会报错）')
  return lines.join('\n')
}

/**
 * 读出配置文件里的原始对象。
 *
 * 文件不存在 → `{ok: true, values: {}, missing: true}`（第一次写会创建它）。
 * 文件存在但读不出来/不是对象 → `{ok: false}`：调用方**必须拒绝写**。
 */
function readConfigObject(filePath, io) {
  if (io.existsSync(filePath) !== true) return { ok: true, values: {}, missing: true }
  let text = null
  try {
    text = io.readFileSync(filePath, 'utf8')
  } catch (e) {
    return {
      ok: false,
      message: `读不到配置文件：${e instanceof Error ? e.message : e}`,
    }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return {
      ok: false,
      message: `配置文件不是合法 JSON：${e instanceof Error ? e.message : e}。`
        + '**拒绝改写**：这一层只想改四个键，而重写一份坏掉的配置'
        + '会把用户原来的内容（可能只是少了一个逗号）永久弄没',
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: `配置文件的顶层必须是一个对象（收到 ${Array.isArray(parsed) ? '数组' : typeof parsed}）` }
  }
  return { ok: true, values: parsed, missing: false }
}

/**
 * 写日志策略。
 *
 * @param {object} deps
 * @param {string|null} deps.configPath 产品配置文件路径
 * @param {object} deps.values          要写的键（只接受 `LOG_POLICY_KEYS` 里的）
 * @param {object} [deps.fs]
 * @returns {{ok: boolean, code?: string, message: string, path: string|null,
 *            applied?: object, policy?: object, kept?: string[]}}
 */
export function applyLogPolicy({ configPath = null, values = {}, fs = null } = {}) {
  const io = fs ?? { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync }

  if (typeof configPath !== 'string' || configPath === '') {
    return Object.freeze({
      ok: false, code: LOG_CLI_CODES.NO_CONFIG_PATH, path: null,
      message: '布局里没有产品配置文件路径，无法写日志策略（**不猜位置**）',
    })
  }

  const unknown = Object.keys(values).filter((k) => !(k in LOG_POLICY_KEYS))
  if (unknown.length > 0) {
    return Object.freeze({
      ok: false, code: LOG_CLI_CODES.UNKNOWN_KEY, path: configPath,
      message: `不认识的日志策略键：${unknown.join(' / ')}`,
    })
  }
  if (Object.keys(values).length === 0) {
    return Object.freeze({
      ok: false, code: LOG_CLI_CODES.NOTHING_TO_SET, path: configPath,
      message: '没有要改的键',
    })
  }

  const read = readConfigObject(configPath, io)
  if (read.ok !== true) {
    return Object.freeze({
      ok: false, code: LOG_CLI_CODES.CONFIG_UNREADABLE, path: configPath,
      message: read.message,
    })
  }

  // ① 先把**写完之后**的策略完整校验一遍，再动文件。
  //
  //   只校验"要改的那几个键"是不够的：`keepFiles: 2.5` 单独看是坏的，
  //   而 `maxFileBytes` 与 `maxTotalBytes` 的关系（单文件上限大于总量预算）
  //   是**两份值放在一起**才看得出来的。先把合并后的结果验一遍，
  //   不合格就一个字节都不写。
  const before = effectiveLogPolicy(read.values)
  const next = { ...before, ...values }
  const check = validateLogPolicy(next)
  if (check.ok !== true) {
    return Object.freeze({
      ok: false, code: LOG_CLI_CODES.BAD_VALUE, path: configPath,
      message: `日志策略不合法：${check.problems.join('；')}（**一个字节都没写**）`,
    })
  }

  // ② 合并：只动 `log.*` 里的那四个键，其余原样保留。
  const originalLog = read.values.log
  const nextLog = { ...(originalLog !== null && typeof originalLog === 'object' && !Array.isArray(originalLog) ? originalLog : {}) }
  const applied = {}
  for (const [key, v] of Object.entries(values)) {
    nextLog[key] = v
    applied[LOG_POLICY_KEYS[key]] = v
  }
  const nextRoot = { ...read.values, log: nextLog }
  const kept = Object.keys(read.values).filter((k) => k !== 'log')

  try {
    io.mkdirSync(dirname(configPath), { recursive: true })
    const tmp = `${configPath}.tmp-${process.pid}`
    // ② 原子写：直接写目标的话，写到一半断电留下半截 JSON，
    //    而半截 JSON 在配置层里等于**整份配置回到默认值**。
    io.writeFileSync(tmp, `${JSON.stringify(nextRoot, null, 2)}\n`, 'utf8')
    io.renameSync(tmp, configPath)
  } catch (e) {
    return Object.freeze({
      ok: false, code: LOG_CLI_CODES.WRITE_FAILED, path: configPath,
      message: `写配置文件失败：${e instanceof Error ? e.message : e}`,
    })
  }

  return Object.freeze({
    ok: true, path: configPath, applied, kept,
    policy: Object.freeze({ ...check.policy }),
    message: `已写入 ${Object.keys(applied).length} 个键：${Object.keys(applied).join(' / ')}`,
  })
}
