// scratch/_probe-s7-faults.mjs —— spec §7 那 7 类故障注入，逐类找真证据（**不提交**）
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project/DSH/legion'
const grep = (pattern, extra = []) => {
  try {
    return execFileSync('git', ['grep', '-l', '-I', '-E', pattern, '--', '*.mjs', ...extra],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}
const grepCount = (pattern) => {
  try {
    return execFileSync('git', ['grep', '-c', '-I', '-E', pattern, '--', '*.mjs'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean).length
  } catch { return 0 }
}

// spec §7 第 3 条逐字列出的 7 类
const FAULTS = [
  ['Runtime 崩溃', 'CRASH|crash|崩溃'],
  ['网络中断', 'ECONNREFUSED|ECONNRESET|网络中断|network.*(?:fail|interrupt)|NETWORK_'],
  ['重复事件', 'duplicate|重复事件|DUP_|dedup'],
  ['审批超时', 'APPROVAL_TIMEOUT|approval.*timeout|审批超时|TTL|ttl'],
  ['凭证缺失', 'CREDENTIAL_MISSING|凭证缺失|MISSING_CREDENTIAL|no.*credential'],
  ['预算耗尽', 'BUDGET_EXCEEDED|预算耗尽|budgetExhausted|budget.*exceed'],
  ['升级失败', 'UPGRADE_FAILED|升级失败|upgrade.*fail|rollback.*fail'],
]

for (const [name, pat] of FAULTS) {
  const files = grep(pat)
  const tests = files.filter((f) => f.endsWith('.test.mjs'))
  const prod = files.filter((f) => !f.endsWith('.test.mjs'))
  console.log(`\n${'='.repeat(74)}`)
  console.log(`【${name}】  命中文件 ${files.length}（用例 ${tests.length} / 非用例 ${prod.length}）`)
  console.log(`  用例：${tests.slice(0, 6).join('、') || '（无）'}`)
  console.log(`  非用例：${prod.slice(0, 5).join('、') || '（无）'}`)
  console.log(`  全仓 .mjs 命中行数档：${grepCount(pat)} 个文件有命中`)
}
