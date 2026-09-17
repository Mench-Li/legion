// product/launcher/wizard-wiring.test.mjs
// ============================================================================
// 把「PRT-707 有两份实现，而它们对模型密钥的引用名说法不一致」变成一条读数。
//
// ## 这一套盯的是什么
//
// PRT-707（首次运行向导）在仓库里**有两份实现**，都挂着 ✅、都有自己的用例：
//
//   · **活的那份**：`product/launcher/cli.mjs` 的 `--wizard` 分支（L1331 起）。
//     它**内联**了六个动作的真实实现，把模型密钥写进密钥库的 `model/api-key`。
//   · **死的那份**：`product/launcher/first-run.mjs`（636 行 + 一整套用例）。
//     它按 `legion/model/<profileId>` 算引用名，并把那个名字写进 hub 的模型档案。
//
// 两份的引用名**不是同一个**。而更要紧的是下面这一条，它把一个"命名不一致"
// 抬成了"静默失效"：
//
//   > `security/secrets/credential-materializer.mjs` 的 `planDshLookup()`
//   > 对 `legion/model/<profileId>`（**三段**）返回 `{addressable:false}`——
//   > 这条引用在 DSH 的两个键空间（`refs` 是 POSIX 标识符、`records` 是**恰好两段**）
//   > 里**都没有位置**。
//
// 那份模块的文件头把后果写得很清楚（第 38-39 行）：
//
//   > 一个"文件看起来完整、就是少了最要紧那一把钥匙"的读数，
//   > 与一个"文件本来就只该有这么多"的读数，在 `cat` 的输出里长得一模一样。
//
// 所以：**把 `first-run.mjs` 接上去**（一个很自然的动作——它有 636 行、
// 有一整套用例、而"零生产入口"看起来总是个缺陷），会得到一个
// "向导报『模型已配置』、而运行时拿不到钥匙"的产品。
//
// ## 为什么本套件**不**断言"哪一份是对的"
//
// 因为那是一个产品决定，不是我能替项目方裁的。两种说法都站得住：
//
//   · `first-run.mjs` 用的是 **Legion 自己的**引用名（三段），与
//     `credential-materializer.mjs` 文件头那句"Legion 的模型引用是
//     `legion/model/<profileId>`"一致；
//   · 而**活的**那条链用的是 `model/api-key`，它与运行时物化的名字
//     （`run-credential-materialization.mjs` 的 `RUNTIME_MODEL_KEY_REF`）
//     被一条 drift 用例钉着逐字相等。
//
// 也就是说：**两份各自都自洽，而它们说的不是同一件事。** 本套件只做三件事——
// 把分歧钉住、把"不可寻址"用**真实读者**证出来、把"两份都是绿的"钉住。
//
// ★ 这套用例今天**全绿**。它是一份**读数**，不是待办：
//   它红的那一天，正是有人把死的那份接上去（或把两边改成一致）的那一天。
//
// ## 正对照（本仓库被这个坑咬过两次，所以必须有）
//
//   > 一个「因为判据恒假所以什么都没发现」的检查，
//   > 与一个「真的发现了东西」的检查，在输出上是同一个东西。
//
// 所以 ② 里 `addressable:false` 的每一条都配了**可寻址**的正对照
// （`records` 空间一个、`refs` 空间一个），③ 里"零导入者"的正对照是
// **活的那份确实被 import**。少了正对照，②③ 在任何时候都是绿的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { modelSecretRefFor, MODEL_SECRET_PREFIX } from './first-run.mjs'
import { RUNTIME_MODEL_KEY_REF } from './run-credential-materialization.mjs'
import { planDshLookup } from '../../security/secrets/dsh-credentials.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
const readHere = (name) => readFileSync(join(HERE, name), 'utf8')

// ══════════════════════════════════════════════════════════════════════════
// ① 两份实现算出来的引用名不是同一个
// ══════════════════════════════════════════════════════════════════════════

test('① ★★ 死的那份（first-run.mjs）与运行时物化的引用名**不是同一个**', () => {
  const deadRef = modelSecretRefFor('default')

  assert.equal(deadRef, 'legion/model/default')
  assert.equal(RUNTIME_MODEL_KEY_REF, 'model/api-key')

  // ★ 这条断言今天为真，而它**正是那个缺口**。写在这里是为了让"两份都绿"
  //   这件事在任何人试图接线上死的那份时，先在这里红一次。
  assert.notEqual(deadRef, RUNTIME_MODEL_KEY_REF,
    '两份算出来的引用名竟然一样了——那说明有人已经把它们对齐了，' +
    '请连同本节的文件头一起更新（这套用例的用途就是把分歧钉住）')

  // 前缀是模块自己声明的，不是一个散在各处的字面量。
  assert.equal(MODEL_SECRET_PREFIX, 'legion/model/')
  assert.equal(deadRef, `${MODEL_SECRET_PREFIX}default`)
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★★ 用**真实读者**证明：死的那份写的引用名，在 DSH 的两个键空间里都没有位置
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 三段引用在两个键空间都**不可寻址**（配两个可寻址正对照）', () => {
  // ── 正对照先跑。它们必须**可寻址**，否则本条的"不可寻址"什么也证明不了：
  //    整个函数恒返回 false 时，下面那条断言照样是绿的。
  const liveOk = planDshLookup(RUNTIME_MODEL_KEY_REF)
  assert.equal(liveOk.addressable, true,
    `★ 正对照失败：运行时物化的那个名字（${RUNTIME_MODEL_KEY_REF}）本该可寻址。` +
    '这说明键空间判据本身变了/坏了，本条的结论不可信')
  assert.equal(liveOk.space, 'records')

  // 第二个正对照必须落在**另一个**键空间上：只验 `records` 的话，
  // "`refs` 空间整个坏掉"这种失效是看不见的。
  const refsOk = planDshLookup('DEEPSEEK_API_KEY')
  assert.equal(refsOk.addressable, true, '★ 正对照失败：refs 空间里的名字本该可寻址')
  assert.equal(refsOk.space, 'refs')

  // ── 被检查的那一条
  const dead = planDshLookup(modelSecretRefFor('default'))
  assert.equal(dead.addressable, false,
    '★ 三段的 legion/model/<id> 竟然可寻址了——那这条缺口就消失了，' +
    '请重新评估 first-run.mjs 能不能直接接线')
  assert.equal(dead.space, null, '没有位置时 space 必须是 null，不能是某个空间名')

  // 换一个 profileId 结论一样：这不是"某个 id 拼错了"，是**形状**不可寻址。
  assert.equal(planDshLookup(modelSecretRefFor('deepseek-chat')).addressable, false)

  // 而**两段**的 Legion 前缀是可寻址的 —— 这把原因钉死在"段数"上，
  // 而不是"legion/ 开头就不行"。少了这一条，读者会去改错的地方。
  assert.equal(planDshLookup('legion/openai').addressable, true,
    '两段的 legion/<name> 本该可寻址（records 空间），' +
    '若它也不可寻址，那说明原因不是段数，本条的诊断词就写错了')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 活的是哪一份：静态 + 动态 import 全仓扫一遍（配正对照）
// ══════════════════════════════════════════════════════════════════════════

test('③ ★ `first-run.mjs` 零生产导入者，而 `wizard-cli.mjs` 被 cli.mjs 动态装上', () => {
  const DIRS = ['runtime', 'team-hub', 'orchestrator', 'product', 'security', 'scripts']
  const SKIP = new Set(['node_modules', '.git', 'releases', '.worktrees', 'scratch'])
  const files = []
  const walk = (d) => {
    for (const n of readdirSync(join(REPO, d))) {
      if (SKIP.has(n)) continue
      const rel = `${d}/${n}`
      if (statSync(join(REPO, rel)).isDirectory()) walk(rel)
      else if (n.endsWith('.mjs')) files.push(rel)
    }
  }
  for (const d of DIRS) walk(d)

  // ★ 三种装法都要收，少一种就等于把那种装法下的模块误判成"死的"：
  //     `from '…'`（静态）、`import('…')`（动态）、`import '…'`（**只为副作用**）。
  //
  //   这一条不是预防性的：本套件的第一版只收前两种，而变异验证里
  //   "给一个生产文件加一行 `import './first-run.mjs'`"**没有咬住**——
  //   也就是说那一版会把一个纯副作用导入的模块报成"零导入者"。
  //
  //   > 一个「漏了一种装法」的扫描，
  //   > 与一个「那个模块真的没人装」的扫描，在输出上是同一个东西。
  const SPEC = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g
  const importersOf = (base) => {
    const out = []
    for (const f of files) {
      if (f.endsWith('.test.mjs')) continue
      for (const m of readFileSync(join(REPO, f), 'utf8').matchAll(SPEC)) {
        const spec = m[1] ?? m[2] ?? m[3]
        if (spec && spec.endsWith(base)) out.push(f)
      }
    }
    return out
  }

  // ── 正对照：活的装法必须被扫出来。它红了就说明上面的扫描没在干活。
  const cliImporters = importersOf('wizard-cli.mjs')
  assert.ok(cliImporters.includes('product/launcher/cli.mjs'),
    `★ 正对照失败：扫不到 cli.mjs 动态 import 的 wizard-cli.mjs（扫出来的是 ${JSON.stringify(cliImporters)}）。` +
    '这说明扫描坏了，下面"零导入者"的结论不可信')

  // ── 被检查的那一条
  const deadImporters = importersOf('first-run.mjs')
  assert.deepEqual(deadImporters, [],
    `★ first-run.mjs 竟然有生产导入者了：${JSON.stringify(deadImporters)}。` +
    '那是本条缺口被关掉的好消息——但请**先**确认它的引用名已经与运行时对齐（见① ②），' +
    '否则接上它会得到一个"向导说配好了、运行时拿不到钥匙"的产品')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 死的那份把不可寻址的名字写进了 hub 的模型档案
// ══════════════════════════════════════════════════════════════════════════

test('④ ★ 死的那份把 `legion/model/<id>` 作为 `secretRef` 写进 hub 档案', () => {
  const src = readHere('first-run.mjs')

  // 档案里的 `secretRef` 是"档案指向的那把钥匙"。它若指向一个运行时既不读、
  // 也**读不到**的名字，那么"档案配好了"与"钥匙到不了"会同时为真。
  assert.equal(/secretRef/.test(src), true, 'first-run.mjs 里应当有 secretRef')
  assert.equal(/modelSecretRefFor\(/.test(src), true,
    '它应当是用 modelSecretRefFor() 算出引用名的（而不是从别处读回来的）——' +
    '这条断言把①的"名字从哪来"钉在源码上')

  // ★ 关键的一步：它**没有**任何地方引用运行时物化的那个名字。
  //   于是"写进去的"与"读出来的"之间没有任何东西把它们绑在一起。
  assert.equal(src.includes(RUNTIME_MODEL_KEY_REF), false,
    `first-run.mjs 里出现了运行时的引用名（${RUNTIME_MODEL_KEY_REF}）——` +
    '那说明两份实现已经被对齐了；这条用例连同本节标题都该更新')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★★ 两份各自被**自己的**用例钉着 —— 两个套件各自绿着，而它们说的不是同一件事
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★ 两个套件各自钉住一个约定：这份"绿"本身就是要记的读数', () => {
  const deadTests = readHere('first-run.test.mjs')
  const liveTests = readHere('run-credential-materialization.test.mjs')

  // 死的那份的用例断言 `legion/model/<id>`
  assert.equal(deadTests.includes("'legion/model/"), true,
    'first-run.test.mjs 本该把 legion/model/ 这个约定钉住；' +
    '若它不再钉了，说明那份实现已经改了，请重读本节')

  // 活的那份的用例断言 `model/api-key` **并且**去 cli.mjs 里对账
  assert.equal(liveTests.includes('RUNTIME_MODEL_KEY_REF'), true)
  assert.equal(/MODEL_KEY_REF/.test(liveTests), true,
    'run-credential-materialization.test.mjs 本该有一条 drift 用例' +
    '（去 cli.mjs 里正则抽出 MODEL_KEY_REF 逐字比对）；没有它，' +
    '活的这条链就没有任何东西钉着')

  // ★ 这就是本节最要紧的一句：**两个套件都在跑、都绿**，而没有任何一条用例
  //   把"这两份说的是同一件事"当作要证的东西。
  //
  //   > 两处各自绿着的用例，
  //   > 与"两处一致"，在总体的绿/红读数上是同一个东西。
  //
  //   本套件（① ② ④）就是补上那一格：它不替谁说话，只把两者摆在一起。
  const cliSrc = read('product/launcher/cli.mjs')
  const cliRef = /const MODEL_KEY_REF = '([^']+)'/.exec(cliSrc)
  assert.ok(cliRef !== null, 'cli.mjs 里找不到 MODEL_KEY_REF 的声明')
  assert.equal(cliRef[1], RUNTIME_MODEL_KEY_REF,
    '活的这条链自己漂了：cli.mjs 写的与运行时物化的不是同一个名字')
})
