// scripts/probes/_probe-path-roles.mjs —— 往声明表里加一个角色，看会发生什么
//
// ★ 做法：把真实的 `product/paths.mjs` 复制一份（放在同目录，好让它那些相对 import
//   仍然有效），只改声明，然后叫真实的 `layoutDiagnostics`。
//   —— 比"读代码推断"强：它给出的是**实测行为**。
//
// 第 42 轮修之前的两条静默失效路径（本探针当时量出来的）：
//   ① `DIR_ROLES` 加角色 ⇒ 被**当成 logDir** 检查，报在正确角色名下、引用别人的值；
//   ② `WRITABLE_ROLES` 加角色 ⇒ 安装目录包含检查**根本不查它**。
// 修之后：声明了却没取法 ⇒ **一进模块就抛**；取法补齐 ⇒ 两条检查都**命中正确的值**。
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

const SRC = 'D:/project/DSH/legion/product/paths.mjs'
const TMP = 'D:/project/DSH/legion/product/_paths-extrarole.mjs'
const src = readFileSync(SRC, 'utf8')

const layout = {
  platform: 'win32',
  installDir: 'C:\\app',
  dataDir: 'C:\\app\\data',
  workspaceDir: 'C:\\app\\ws',
  cacheDir: 'C:\\app\\cache',
  logDir: 'C:\\app\\log',
  backupDir: 'relative-backup', // 相对路径，且名义上在安装目录里
  productHome: 'C:\\app',
  productConfigPath: 'C:\\app\\cfg.json',
  secretsFile: 'C:\\app\\secrets.json',
}

const addDecls = (s, extraReader) => s
  .replace(
    "export const DIR_ROLES = Object.freeze(['install', 'data', 'workspace', 'cache', 'log'])",
    "export const DIR_ROLES = Object.freeze(['install', 'data', 'workspace', 'cache', 'log', 'backup'])",
  )
  .replace(
    "export const WRITABLE_ROLES = Object.freeze(['data', 'workspace', 'cache', 'log'])",
    "export const WRITABLE_ROLES = Object.freeze(['data', 'workspace', 'cache', 'log', 'backup'])",
  )
  .replace(
    "  log: (l) => l?.logDir ?? null,",
    "  log: (l) => l?.logDir ?? null,\n" + (extraReader ? "  backup: (l) => l?.backupDir ?? null," : ''),
  )

const load = (text) => {
  if (text === src) throw new Error('补丁没打上——声明行变了？')
  writeFileSync(TMP, text)
  return import(`file:///${TMP.replace(/\\/g, '/')}?t=${Date.now()}`)
}
const cleanup = () => { try { rmSync(TMP) } catch { /* 已删 */ } }

// ───────────────────────── ① 只改声明，不补取法 ─────────────────────────
console.log('=== ① 往 DIR_ROLES / WRITABLE_ROLES 加 `backup`，但**不补取法** ===')
try {
  const mod = await load(addDecls(src, false))
  cleanup()
  const out = mod.layoutDiagnostics(layout)
  console.log('★ 没有抛错 —— 那说明"声明了没取法"仍然能被静默接受：')
  for (const d of out.filter((x) => x.role === 'backup')) console.log(`    ${d.code} [${d.role}]`)
} catch (e) {
  cleanup()
  console.log('✔ 一进模块就抛（正是想要的）：')
  console.log(`    ${String(e.message).split('\n')[0]}`)
}

// ───────────────────────── ② 声明 + 补上取法 ─────────────────────────
console.log('\n=== ② 加 `backup` 到两张声明表**并补上取法** ===')
const mod2 = await load(addDecls(src, true))
cleanup()
console.log('DIR_ROLES     =', mod2.DIR_ROLES.join(', '))
console.log('WRITABLE_ROLES=', mod2.WRITABLE_ROLES.join(', '))

const out2 = mod2.layoutDiagnostics(layout)
const byRole = (code, role) => out2.filter((d) => d.code === code && d.role === role)
const abs = byRole('PATH_NOT_ABSOLUTE', 'backup')
console.log(`\n  ① 绝对路径检查命中 backup：${abs.length > 0 ? '✔ 是' : '★ 没有'}`)
if (abs.length > 0) console.log(`     引用值 = ${abs[0].message.match(/「([^」]*)」/)?.[1]}（真正的是 relative-backup）`)
const logDup = byRole('PATH_NOT_ABSOLUTE', 'log')
console.log(`  ② logDir 名下的绝对路径诊断条数：${logDup.length}`
  + `（logDir 是绝对的，所以本就该是 0 —— 修之前新角色会**冒充**它报一条）`)

// ★ 第二个布局：backupDir **真的**在安装目录里。
//   第一版我拿 `relative-backup` 去测"安装目录包含检查"，得出的"没报"是**对的**
//   ——相对路径本来就不在 `C:\app` 里。那不是判据漏了，是**夹具没构造出那个形状**：
//   > 一个"检查没报"的读数，与一个"夹具没把值放进被测范围"的读数，
//   > 在只看有没有那条诊断时是同一个东西。
const insideLayout = { ...layout, backupDir: 'C:\\app\\backup' }
const out3 = mod2.layoutDiagnostics(insideLayout)
const inside = out3.filter((d) => d.code === 'WRITABLE_DIR_INSIDE_INSTALL_DIR' && d.role === 'backup')
console.log(`  ③ 安装目录包含检查命中 backup（backupDir = C:\\app\\backup）：`
  + `${inside.length > 0 ? '✔ 是' : '★ 没有'}`)
if (inside.length > 0) console.log(`     ${inside[0].message.slice(0, 60)}…`)
const otherRolesInside = out3.filter((d) => d.code === 'WRITABLE_DIR_INSIDE_INSTALL_DIR').map((d) => d.role)
console.log(`     同一条检查下的角色集合 = [${otherRolesInside.join(', ')}]`
  + `（含 backup ⇒ 它是遍历 WRITABLE_ROLES 得来的，不是手写的四个）`)
console.log('\n★ 结论：同一处"加一个角色"的操作，'
  + '修之前是**静默错检**，现在是"要么一进模块就抛、要么两条检查都命中正确的值"。')

