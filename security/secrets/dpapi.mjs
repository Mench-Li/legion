// security/secrets/dpapi.mjs
// ============================================================================
// 当前用户作用域 DPAPI 后端（PRT-505）
//
// spec §6.7：商业 Alpha 固定 per-user 安装，密钥用 **Windows Credential Manager
// 或当前用户作用域 DPAPI** 保护。本模块实现后者，理由是它可被真实往返验证：
// 与 Credential Manager 相比，DPAPI 的加解密是纯函数式的，用例可以在真实
// 进程上做一次 protect → unprotect → 比对，而不是只能断言「API 被调用了」。
//
// ## 为什么走 PowerShell 而不是 Node 原生
//
// Node 没有内置 DPAPI 绑定。`ConvertTo-SecureString` / `ConvertFrom-SecureString`
// 在不带 `-Key` 时**就是**当前用户作用域的 DPAPI，且在 Windows PowerShell 5.1
// 与 PowerShell 7 上都可用，无需安装 NuGet 包。用 `-Key` 的形式是 AES + 自管密钥，
// 那不是 DPAPI，也不解决密钥存放问题——这里刻意不用。
//
// ## 明文只经 stdin
//
// 明文**不**作为命令行参数、**不**作为环境变量：命令行会被同机进程看到
// （Windows 上尤其容易），环境变量会出现在子进程的继承环境与崩溃转储里。
// 因此一律用 stdin 传入、stdout 取回，且 `Unprotect` 的输出在 Node 侧立即
// 被消费，不落任何中间文件。
//
// ## 失败一律 fail closed
//
// 找不到 PowerShell、平台不是 Windows、脚本退出非 0 —— 全部抛
// `SECRET_STORE_UNSUPPORTED_PLATFORM` / `SECRET_DECRYPT_FAILED`，
// **不退化**为明文存储。退化会让「密钥受保护」这句话在部分机器上悄悄失效，
// 而失效的那台机器恰恰是配置最特殊的那个。
// ============================================================================

import { spawnSync } from 'node:child_process'

import { SecretStoreError } from './errors.mjs'

export const DPAPI_SCHEME = 'dpapi-user'

/** 保护：stdin 收明文，stdout 出「当前用户可解」的密文串。 */
const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$s = [Console]::In.ReadToEnd()',
  'if ($s.Length -eq 0) { throw "empty input" }',
  '$sec = ConvertTo-SecureString -String $s -AsPlainText -Force',
  'ConvertFrom-SecureString -SecureString $sec',
].join('\n')

/** 解密：stdin 收密文串，stdout 出明文。 */
const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$blob = [Console]::In.ReadToEnd().Trim()',
  'if ($blob.Length -eq 0) { throw "empty input" }',
  '$sec = ConvertTo-SecureString -String $blob',
  "[System.Net.NetworkCredential]::new('', $sec).Password",
].join('\n')

/** PowerShell 候选：先 pwsh（7+），再 powershell（5.1）。 */
export const POWERSHELL_CANDIDATES = Object.freeze(['pwsh', 'powershell'])

/**
 * 探测本机可用的 PowerShell。返回命令名或 null。
 * 探测本身也是 fail closed 的一部分：拿不到解释器就不能假装能保护密钥。
 */
export function resolvePowershell({ platform = process.platform, candidates = POWERSHELL_CANDIDATES } = {}) {
  if (platform !== 'win32') return null
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    })
    if (probe.error === undefined && probe.status === 0 && String(probe.stdout ?? '').trim() !== '') return candidate
  }
  return null
}

function runPowershell(exe, platform, script, input) {
  if (platform !== 'win32') {
    throw new SecretStoreError('SECRET_STORE_UNSUPPORTED_PLATFORM', { platform })
  }
  if (typeof exe !== 'string' || exe === '') {
    throw new SecretStoreError('SECRET_STORE_UNSUPPORTED_PLATFORM', { platform })
  }
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: String(input),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60000,
  })
  return res
}

/**
 * 用当前用户作用域 DPAPI 保护一个值。
 * @returns {string} 密文串（十六进制，只对当前 Windows 用户可解）
 */
export function protectValue(plaintext, { exe, platform = process.platform } = {}) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new SecretStoreError('SECRET_VALUE_EMPTY')
  }
  const res = runPowershell(exe, platform, PROTECT_SCRIPT, plaintext)
  if (res.error !== undefined || res.status !== 0) {
    // 只报结构信息：脚本 stderr 里可能出现输入片段，不能进错误对象
    throw new SecretStoreError('SECRET_STORE_WRITE_FAILED', {
      cause: `${res.error?.code ?? 'exit'}${res.status === null || res.status === undefined ? '' : ` status=${res.status}`}`,
    })
  }
  const blob = String(res.stdout ?? '').trim()
  if (blob === '' || !/^[0-9a-fA-F]+$/.test(blob)) {
    throw new SecretStoreError('SECRET_STORE_WRITE_FAILED', { cause: 'unexpected-output' })
  }
  return blob
}

/**
 * 解密一个由 `protectValue` 产生的密文串。
 *
 * 换账户/换机器复制过来的密文会在这里失败——这正是 DPAPI 的作用，
 * 因此报 `SECRET_DECRYPT_FAILED` 并给出「用当前账户重新录入」的指引，
 * 而不是把它伪装成「密钥不存在」。
 */
export function unprotectValue(blob, { exe, platform = process.platform } = {}) {
  if (typeof blob !== 'string' || blob.trim() === '') {
    throw new SecretStoreError('SECRET_DECRYPT_FAILED', { cause: 'empty-blob' })
  }
  const res = runPowershell(exe, platform, UNPROTECT_SCRIPT, blob.trim())
  if (res.error !== undefined || res.status !== 0) {
    throw new SecretStoreError('SECRET_DECRYPT_FAILED', {
      cause: `${res.error?.code ?? 'exit'}${res.status === null || res.status === undefined ? '' : ` status=${res.status}`}`,
    })
  }
  // PowerShell 的输出会把多行明文原样带回；只去掉脚本尾部添加的那一个换行
  return String(res.stdout ?? '').replace(/\r?\n$/, '')
}

/** 本机 DPAPI 可用性（平台 + 解释器），供 PRT-215 式启动自检使用。 */
export function probeDpapi({ platform = process.platform, candidates = POWERSHELL_CANDIDATES } = {}) {
  if (platform !== 'win32') {
    return Object.freeze({ available: false, scheme: null, reason: 'platform', hint: 'DPAPI 只在 Windows 上可用。' })
  }
  const exe = resolvePowershell({ platform, candidates })
  if (exe === null) {
    return Object.freeze({ available: false, scheme: null, reason: 'no-powershell', hint: '未找到 pwsh 或 powershell：无法调用当前用户作用域 DPAPI。' })
  }
  return Object.freeze({ available: true, scheme: DPAPI_SCHEME, exe, reason: null, hint: null })
}
