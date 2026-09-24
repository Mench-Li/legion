/**
 * 台账里引用的**提交哈希**还在历史里吗？它是不是 HEAD 的祖先？
 *
 * ## 为什么这一类值得查
 *
 * 记账一条 ✅ 时，本仓的惯例是写出**闭包证据**（"已落地，见 `de89ff3`"）。
 * 一个哈希是做不了假的**坐标**——但它有两种坏法，而两种都不改变句子：
 *
 *   ① **哈希不存在**（打错一位、或那条提交被 rebase / 丢弃 / 只在别的分支上）；
 *   ② 哈希存在，但**不是 HEAD 的祖先**（东西在，可它不在我们这条线上）
 *      ——读的人会以为主线里有它。
 *
 *   > 一个"引用了某个提交"的论断，与一个"引用了某个**确实在线上的**提交"的论断，
 *   > 在读者眼里强度不同——而**一个打错的十六进制串看起来很专业**。
 *
 * ## 判据
 *
 * 对每个哈希：`git cat-file -e <sha>^{commit}` 判存在；
 * `git merge-base --is-ancestor <sha> HEAD` 判是否在线上。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(ROOT, 'docs/superpowers/prt/PRT-PROGRESS.md')
const text = readFileSync(LEDGER, 'utf8')

function git(args, ok = [0]) {
  try {
    return { out: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(), code: 0 }
  } catch (e) {
    return { out: String(e.stdout ?? '').trim(), code: e.status ?? 1 }
  }
}

/**
 * 抓 `反引号里的十六进制串`（7–40 位，**且至少含一个 a–f 字母**）。
 *
 * ★★ 第一版只写 `[0-9a-f]{7,40}`，于是抓出了两个**根本不是哈希**的东西：
 *
 *   · `1234567890` —— 一处 YAML 标量取值测试里用的**数字串**；
 *   · `1000000100` —— 一处用例里的**字节数**（100 字节 + 10 GB）。
 *
 *   > 一个"引用的提交不存在"与一个"我的正则把数字串当成了提交"，
 *   > 在第一版的输出里长得一模一样——**而且后者还带着两条看起来很具体的哈希。**
 *
 * 要求至少一个字母之后，两者都被排除（真实短哈希几乎总带字母；
 * 而纯数字 7 位以上在正文里基本都是数据）。这是**判据键太宽**这个老形状的又一例。
 */
const RE = /`([0-9a-f]{7,40})`/g
const shas = new Set()
for (const m of text.matchAll(RE)) {
  const s = m[1].toLowerCase()
  if (!/[a-f]/.test(s)) continue // ← 排除纯数字串（数据，不是坐标）
  shas.add(s)
}

const head = git(['rev-parse', '--short', 'HEAD']).out
console.log(`\n=== 台账里 ${shas.size} 个反引号哈希（HEAD = ${head}）===\n`)

const rows = []
for (const sha of shas) {
  const exists = git(['cat-file', '-e', `${sha}^{commit}`]).code === 0
  if (!exists) { rows.push({ sha, status: 'NOT-A-COMMIT' }); continue }
  const anc = git(['merge-base', '--is-ancestor', sha, 'HEAD'])
  // git merge-base --is-ancestor: 0=是祖先, 1=不是
  const subject = git(['log', '-1', '--format=%s', sha]).out.slice(0, 62)
  rows.push({ sha, status: anc.code === 0 ? 'ANCESTOR' : 'NOT-ANCESTOR', subject })
}

const byStatus = {}
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
console.log('按状态：')
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`)

const bad = rows.filter((r) => r.status !== 'ANCESTOR')
if (bad.length) {
  console.log('\n★ 需要人看：')
  for (const r of bad) {
    console.log(`  [${r.status}] ${r.sha}` + (r.subject ? `  — ${r.subject}` : ''))
  }
} else {
  console.log(`\n★ 全部 ${rows.length} 个哈希都**存在**且**是 HEAD 的祖先**。`)
}

// ★★ 反向：**造一个假的哈希**，确认这个判据真的会红。
//    少了这一步，"全绿"与"判据根本没在查"是同一个输出。
//    ——这是本会话学到的那条：一个恒绿的判据等于没有判据。
const fake = 'deadbee'
const fakeExists = git(['cat-file', '-e', `${fake}^{commit}`]).code === 0
console.log(`\n★ 反面自检：伪造的 \`${fake}\` ⇒ ${fakeExists ? '★ 竟然判定存在（判据坏了）' : '判定不存在 ✔（判据确实在查）'}`)
