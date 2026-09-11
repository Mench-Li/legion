// runtime/adapters/dsh/probe.mjs
// ============================================================================
// DSH 版本与能力探测（PRT-209）
//
// ## 探测失败一律 fail closed
//
// 「探不到」不等于「没有问题」。三种退化都必须判 `incompatible`：
//   · `probeRuntime()` 抛错 / 返回非对象
//   · 版本号缺失或无法解析
//   · 必需能力字段缺失（不是 false，而是**没有这个字段**）
//
// 第三种最容易被写错：`capabilities.structuredOutput !== true` 会把
// 「引擎没说」和「引擎说不行」都判为不可用（正确），
// 但若写成 `capabilities.structuredOutput === false`，就会把「没说」当成可用——
// 于是我们在一个从未承诺结构化输出的引擎上依赖结构化输出。
// 本文件统一用「必须显式为 true」的判据。
// ============================================================================
import { REQUIRED_CAPABILITIES, OPTIONAL_CAPABILITIES } from '../../contracts/index.mjs'

/**
 * 受支持的 DSH 版本窗口（占位，待 PRT-802/809 用真实兼容矩阵替换）。
 *
 * 现在只表达一条规则：**主版本必须一致**。次版本差异允许，
 * 因为补丁层（PRT-214）按主版本固定，次版本升级由启动自检（PRT-215）把关。
 */
export const SUPPORTED_RUNTIME = Object.freeze({
  supportedMajor: 0,
  minVersion: '0.1.0',
  note: '占位窗口：待 PRT-802/809 以真实兼容矩阵替换；当前只校验主版本一致',
})

/** 解析 `0.1.5-rc.2` / `v1.2.3` → `{ major, minor, patch, prerelease }`；无法解析返回 null。 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null }
}

/** 比较两个已解析版本；a<b → -1，a>b → 1，相等 → 0。 */
export function compareVersion(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  return 0
}

/**
 * 版本兼容判定。
 *
 * 预发布版本（`-rc.2`）**单独标注**而不是直接拒绝：当前现场跑的正是
 * `0.1.5-rc.2`，直接拒绝会让探测在本机恒失败。但要把它作为
 * `prerelease: true` 上报，让 PRT-011 那个「RC 是否可作对外依赖」的
 * 未决问题在任何地方都看得见——**不因为它在跑就假装它已稳定**。
 */
export function checkRuntimeVersion(version, policy = SUPPORTED_RUNTIME) {
  const parsed = parseVersion(version)
  if (parsed === null) {
    return { compatible: false, parsed: null, reason: `版本号缺失或无法解析：${JSON.stringify(version)}`, prerelease: false }
  }
  if (parsed.major !== policy.supportedMajor) {
    return {
      compatible: false,
      parsed,
      reason: `主版本不符：运行时 ${parsed.major}.x，产品锁定 ${policy.supportedMajor}.x（补丁层按主版本固定）`,
      prerelease: parsed.prerelease !== null,
    }
  }
  const min = parseVersion(policy.minVersion)
  if (min && compareVersion(parsed, min) < 0) {
    return { compatible: false, parsed, reason: `低于最低支持版本 ${policy.minVersion}`, prerelease: parsed.prerelease !== null }
  }
  return {
    compatible: true,
    parsed,
    reason: parsed.prerelease === null
      ? `版本 ${version} 在支持窗口内`
      : `版本 ${version} 可运行，但为**预发布版本**（PRT-011 关于 RC 可否作对外依赖的未决问题仍开放）`,
    prerelease: parsed.prerelease !== null,
  }
}

/**
 * 探测运行时并归一化。
 *
 * 返回 `{ ok, version, capabilities, requiredMissing, reason }`。
 * `ok:false` 时调用方必须按 `incompatible` 处理并**禁止自动执行**
 * （spec §6.2 / PRT-215 的语义）。
 */
export async function probeRuntime(host, policy = SUPPORTED_RUNTIME) {
  let raw
  try {
    raw = await host.probeRuntime()
  } catch (err) {
    return {
      ok: false,
      version: null,
      capabilities: {},
      requiredMissing: [...REQUIRED_CAPABILITIES],
      reason: `probeRuntime() 失败：${err?.message ?? String(err)}`,
    }
  }
  if (raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      version: null,
      capabilities: {},
      requiredMissing: [...REQUIRED_CAPABILITIES],
      reason: `probeRuntime() 未返回对象（收到 ${raw === null ? 'null' : typeof raw}）`,
    }
  }

  const capsRaw = raw.capabilities
  const capabilities = {}
  if (capsRaw !== null && typeof capsRaw === 'object') {
    // 只收布尔值：非布尔的能力声明是「没说」，不是「可以」
    for (const [k, v] of Object.entries(capsRaw)) capabilities[k] = v === true
  }

  // 必需能力：必须**显式为 true**（缺失 ≠ 可用）
  const requiredMissing = REQUIRED_CAPABILITIES.filter((c) => capabilities[c] !== true)

  const versionCheck = checkRuntimeVersion(raw.version, policy)
  const ok = requiredMissing.length === 0 && versionCheck.compatible

  let reason
  if (requiredMissing.length > 0 && !versionCheck.compatible) {
    reason = `缺必需能力 [${requiredMissing.join(', ')}]；且${versionCheck.reason}`
  } else if (requiredMissing.length > 0) {
    reason = `缺必需能力 [${requiredMissing.join(', ')}]（能力必须显式为 true，缺失不算具备）`
  } else if (!versionCheck.compatible) {
    reason = versionCheck.reason
  } else {
    reason = versionCheck.reason
  }

  return {
    ok,
    version: typeof raw.version === 'string' ? raw.version : null,
    capabilities,
    requiredMissing,
    optionalPresent: OPTIONAL_CAPABILITIES.filter((c) => capabilities[c] === true),
    prerelease: versionCheck.prerelease,
    reason,
  }
}
