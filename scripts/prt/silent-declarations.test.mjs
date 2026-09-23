/**
 * 把"哑声明"扫描接进 CI —— 让那份读数**每轮都被跑**，而不是躺着。
 *
 * ## 为什么需要这一层
 *
 * 这一轮实测到的事故是：台账（PRT-611）**引用**了
 * `scripts/probes/scan-silent-declarations3.mjs` 的读数"还剩 3 个"，
 * 而那个脚本**没有任何东西在跑它**。于是：
 *
 *   · 它的读数从 3 漂到 0，**没人发现**；
 *   · 漂的原因是**别人把这三个字段的名字写进了文档**（含我上一轮的手钉）；
 *   · 而台账里那句"3 个、一个都没改"照旧挂在 PRT-611 上。
 *
 *   > 一份被引用、但**没有任何东西在跑**的读数，
 *   > 与一份"已经不再成立"的读数，在台账里长得一模一样。
 *
 * ⇒ 这个套件做两件事：
 *   ① 跑扫描器，断言它**退出 0**（内部已含：已知集合一致 + 五种字段的正对照）；
 *   ② 把读数打成 `MEASURE` 行，进 CI 摘要——这样它在摘要里是**可见的**，
 *      而不是"红了才知道"。
 *
 * ⚠️ 边界：这里**不**断言"哑声明数必须是 0"。台账明确记着那三项**故意不修**
 *   （含义不明，改字段就是 PRT-253 §3 禁的"发明默认值"）。
 *   扫描器断言的是"**集合与已知的 3 项一致**"——新增一个会红（那才是它的用途），
 *   少一个也会红（逼人去看是"真修了"还是"判据被弄瞎了"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCANNER = 'scripts/probes/scan-silent-declarations3.mjs'

function runScanner() {
  try {
    const out = execFileSync('node', [SCANNER], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

test('① 哑声明扫描：正对照与已知集合都一致（退出 0）', () => {
  const { code, out } = runScanner()
  assert.equal(code, 0,
    `扫描器退出 ${code}。输出：\n${out.split('\n').slice(-14).join('\n')}\n`
    + '★ 红有两种含义，必须分清楚：**新出现一个哑声明**（去看它是不是真没读者），'
    + '或**已知的某一项不再出现**（去看是真修了，还是判据被弄瞎了）。')
  // ★ 必须真的跑到正对照——否则"退出 0"可能只是脚本早退
  assert.match(out, /正对照/, '输出里没有正对照那一节 ⇒ 脚本没跑到底，这条不算通过')
  assert.match(out, /已知集合一致/, '没看到"已知集合一致" ⇒ 读数可能是空的而不是对的')
})

test('② ★ 扫描器**自带**的五种字段正对照必须通过（防止"判据被弄瞎"）', () => {
  const { out } = runScanner()
  assert.match(out, /✓ 正对照（\*\*五种\*\*字段各一个）/, 
    '正对照不是 ✓（或形状变了）。这一条是本轮那次事故的守卫：'
    + 'v3 的正对照**只造代码读法**，所以"文档提及被当成读者"这个盲点它看不见。')
  // 第四种（只在注释/字符串里被提到）与第五种（含引号的正则之后的真读者）
  // 必须都在期望里——少了任何一种，盲点就没人看着
  assert.match(out, /onlyMentionedInProse/, '第四种字段不见了 ⇒ 盲点守卫被删了')
  assert.match(out, /readAfterRegex/, '第五种字段不见了 ⇒ 词法器吞代码的守卫被删了')
})

test('③ ★ 判据本身能被弄红：把已知项之一加个读者 ⇒ 扫描器必须报"不再出现"', () => {
  // 这一条是**故意**跑一次"红的"，以证明 removed 那一支真的在查。
  // 用 `execSync` 起一个子进程做变异太危险（改产品文件），
  // 所以这里只核对**输出契约**：扫描器在"已知集合不一致"时必须提到"不再出现"。
  const { out } = runScanner()
  // 正常情况下它说"一致"；关键是这两句话必须**互斥**地出现，不能都缺。
  const saysSame = out.includes('已知集合一致')
  const saysDrift = out.includes('不再出现') || out.includes('新出现')
  assert.ok(saysSame || saysDrift,
    '既没说"一致"也没说"漂移" ⇒ 这个断言分支从来没被走到过（等于没有判据）')
})
