const EXECUTABLES = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'pytest', 'go', 'cargo', 'dotnet'])
const SAFE_ARG = /^[A-Za-z0-9_./:@+=,-]+$/
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000

export function validateWorkflowTestRunner(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: '独立测试 runner 必须是对象' }
  }
  if (typeof value.executable !== 'string' || !EXECUTABLES.has(value.executable)) {
    return { ok: false, message: `独立测试 runner executable 必须是受支持的工具：${[...EXECUTABLES].join(', ')}` }
  }
  if (!Array.isArray(value.args) || value.args.length === 0 || value.args.length > 128
    || value.args.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.length > 512 || !SAFE_ARG.test(arg))) {
    return { ok: false, message: '独立测试 runner args 必须是最多 128 项的安全 argv 字符串数组（不支持 shell 语法或空白）' }
  }
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, message: `独立测试 runner timeoutMs 必须在 1000 到 ${MAX_TIMEOUT_MS} 毫秒之间` }
  }
  return {
    ok: true,
    value: Object.freeze({ executable: value.executable, args: Object.freeze([...value.args]), timeoutMs }),
  }
}
