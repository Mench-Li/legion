// product/launcher/allowlist.mjs
// ============================================================================
// 子进程环境变量白名单（spec §10「环境变量……遵循最小权限」）
//
// 现有 `services-plugin/index.js` 的做法是 `{ ...process.env, ...覆盖项 }`：
// 把宿主进程的**全部**环境变量传给每个子服务。后果不是理论问题：
//
//   - Launcher 进程里出现过的任何凭证（别的工具的 token、CI 变量、
//     临时导出的密钥）都会进入 team-hub、workbench、白板三个进程；
//   - 白板与 workbench **不需要**模型密钥，却拿到了它，于是「密钥只注入
//     需要它的执行进程和工具」（spec §6.7）这句话在实现里不成立；
//   - 子进程崩溃时可能把环境变量打进转储，而转储会被附到诊断包里。
//
// 因此改为**显式白名单**：进程只拿到
//   ① 进程清单里 `envNames` 声明过的键
//   ② 操作系统自身运行所必需的键（没有它们连 Node 都起不来）
//   ③ Launcher 显式给定的值
//
// ## 为什么 OS 必需键要写死在代码里而不是配置里
//
// 它们不是「配置」，是运行平台的一部分：Windows 上缺 `SystemRoot` 会让
// 部分 API 直接失败，缺 `PATH` 会让子进程找不到 `node`。把它们做成配置项
// 只会多一个「被谁改坏了」的可能。它们也**不含**任何凭证。
// ============================================================================

/**
 * 操作系统自身必需的键。**刻意不含**任何可能是凭证的键
 * （不加 `*_TOKEN`、`*_KEY`、`*_SECRET`）。
 */
export const OS_ESSENTIAL_ENV = Object.freeze([
  // Windows
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'OS', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'CommonProgramFiles', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH',
  // 通用
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TERM',
  // Node 自身行为（显式允许，因为它们会改变运行时语义，应当被审阅而不是被继承）
  'NODE_OPTIONS', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS',
])

/**
 * 构造子进程环境。
 *
 * @param {object} options
 * @param {object} options.spec 进程计划条目（读 `envNames`）
 * @param {Record<string,string|undefined>} options.baseEnv Launcher 进程自己的环境（读取来源）
 * @param {Record<string,string|undefined>} [options.values] Launcher 决定写入的值（优先级最高）
 * @param {string[]} [options.extraAllowed] 额外允许的键（使用方必须写明理由）
 * @returns {{env: Record<string,string>, allowed: string[], dropped: string[]}}
 *   `dropped` 是「baseEnv 里有、但没有进入子进程」的键名——**只给键名，不给值**。
 *   它存在的意义是让「为什么这个变量没传下去」可被回答，而不是靠读代码猜。
 */
export function buildChildEnv({ spec, baseEnv = {}, values = {}, extraAllowed = [] } = {}) {
  if (spec === null || typeof spec !== 'object') throw new Error('buildChildEnv 需要进程计划条目（spec）')
  const declared = Array.isArray(spec.envNames) ? spec.envNames : []
  const allow = new Set([...declared, ...extraAllowed, ...OS_ESSENTIAL_ENV])

  // 不变量：白名单本身不得含疑似凭证键。它们必须由 spec 显式声明
  // （也就是必须有人写过「这个进程需要它」），不能靠 OS 必需键偷渡进来。
  for (const key of OS_ESSENTIAL_ENV) {
    if (isSecretLikeKey(key)) {
      throw new Error(`OS_ESSENTIAL_ENV 含疑似凭证键「${key}」：平台必需键不得成为凭证的传递通道`)
    }
  }

  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue
    if (!allow.has(key)) continue
    env[key] = String(value)
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    if (!declared.includes(key) && !extraAllowed.includes(key)) {
      // 显式写入一个未声明的键：这通常意味着进程清单漏了声明，
      // 而漏声明会让「进程实际需要的配置」与「清单说它需要的配置」不一致。
      throw new Error(`键「${key}」未在进程 ${spec.key} 的 envNames 中声明：先补清单，再写入`)
    }
    env[key] = String(value)
  }
  const dropped = Object.keys(baseEnv).filter((k) => baseEnv[k] !== undefined && !(k in env))
  return Object.freeze({ env: Object.freeze(env), allowed: Object.freeze([...allow].sort()), dropped: Object.freeze(dropped) })
}

/** 键名是否像凭证载体（与 `runtime/contracts/model.mjs` 同一口径）。 */
export function isSecretLikeKey(key) {
  return /(api[-_]?key|apikey|secret|password|passwd|token|credential|bearer|private[-_]?key|access[-_]?key)/i.test(key)
}

/**
 * 检查一批进程的白名单并集。用途：回答「哪几个进程拿得到模型密钥」。
 *
 * spec §6.7 要求密钥只注入需要它的执行进程；把这个问题做成可回答的函数，
 * 比在评审时对着五行配置互相确认可靠。
 */
export function secretSurfaceOf(processes) {
  const rows = []
  for (const proc of processes) {
    const keys = (proc.envNames ?? []).filter(isSecretLikeKey)
    if (keys.length > 0) rows.push(Object.freeze({ process: proc.key, keys: Object.freeze(keys) }))
  }
  return Object.freeze(rows)
}
