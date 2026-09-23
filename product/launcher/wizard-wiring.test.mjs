// product/launcher/wizard-wiring.test.mjs
// ============================================================================
// PRT-707 首次运行向导：**只剩一份实现**，以及那条仍然活着的**文档 vs 代码**漂移。
//
// ## 这一版为什么重写（第 118 轮第九轮）
//
// 业主在第 1 轮确认了 §5 第 17 条的裁决：**删掉死的那份**
// （`product/launcher/first-run.mjs`，636 行、零生产导入者），**保留活的那份**
// （`cli.mjs` 的 `--wizard` 分支，写 `model/api-key`）。
//
// 上一版这 5 例的存在理由，是把**两份实现的分歧**钉住：
//   ① 两份算出来的引用名不同；② 三段那个在两个键空间都不可寻址；
//   ③ 死的那份零导入者；④ 死的那份把不可寻址的名字写进 hub 档案；
//   ⑤ 两个套件各自绿着而说的不是同一件事。
//
// ★ 那份实现被删掉之后，①③④ 的**主语**不存在了 —— 但**漂移本身还在**：
//   `security/secrets/credential-materializer.mjs` 的文件头**今天仍然**写着
//   「Legion 的模型引用是 `legion/model/<profileId>`——**三段**」，而唯一活着的那份
//   实现写的是 `model/api-key`（两段，端到端通）。
//
//   > 一份"删掉了重复实现"的处置，
//   > 与一份"删掉了重复实现、于是把那条**文档说 A、代码做 B**的读数也一起删掉"的处置，
//   > 在"用户第一次点运行会不会成功"上**是同一个东西**——只不过后者把
//   > 唯一还看得见那处漂移的地方也拿走了。
//
// ⇒ 所以本套件改为钉住**剩下的**那三件事：只剩一份实现（①）、
//   文档声称的那个名字**不可寻址**而代码用的那个**可寻址**（②③）、
//   以及那四个随实现一起删掉的诊断码**没有留在 schema 登记项里**（④）。
//
// ## 正对照（本仓库被这个坑咬过两次，所以必须有）
//
//   > 一个「因为判据恒假所以什么都没发现」的检查，
//   > 与一个「真的发现了东西」的检查，在输出上是同一个东西。
//
// 所以 ② 里每一条"不可寻址"都配了**可寻址**的正对照（`records` 一个、`refs` 一个），
// ① 里"没有导入者"的正对照是**活的那份确实被装上**。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RUNTIME_MODEL_KEY_REF } from './run-credential-materialization.mjs'
import { planDshLookup } from '../../security/secrets/dsh-credentials.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
const here = (name) => join(HERE, name)

/** 全仓生产文件扫描器（①用）。三种装法都收——理由见下面 ① 的注释。 */
function productionFiles() {
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
  return files
}

const SPEC = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g

function importersOf(base, files) {
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

// ══════════════════════════════════════════════════════════════════════════
// ① 只剩一份实现：死的那份不在仓库里了，而活的那份确实被装上（正对照）
// ══════════════════════════════════════════════════════════════════════════

test('① ★★ 第 17 条裁决已执行：`first-run.mjs` 不在仓库里，也没有人再装它', () => {
  assert.equal(existsSync(here('first-run.mjs')), false,
    '★ 死的那份又回来了 —— 第 17 条的裁决是**删掉它**（业主第 1 轮确认）。' +
    '若确实要把它加回来，请先读 §5.3.1：它写的引用名在 DSH 的两个键空间里都没有位置')
  assert.equal(existsSync(here('first-run.test.mjs')), false,
    '它那一整套用例也应当一起删掉（否则就是"文件没了、用例还替它说话"）')

  const files = productionFiles()
  const stragglers = importersOf('first-run.mjs', files)
  assert.deepEqual(stragglers, [],
    `★ 还有生产文件在 import 那个已删除的模块：${JSON.stringify(stragglers)}`)

  // ── 正对照：扫描器必须能把**活的**那份扫出来，否则上面那个"空数组"什么也没证明。
  const cliImporters = importersOf('wizard-cli.mjs', files)
  assert.ok(cliImporters.includes('product/launcher/cli.mjs'),
    `★ 正对照失败：扫不到 cli.mjs 装上的 wizard-cli.mjs（扫出来的是 ${JSON.stringify(cliImporters)}）。` +
    '这说明扫描坏了，上面"没有残留导入者"的结论不可信')
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★★ 仍然活着的那处漂移：**文档说三段，代码写两段**，而三段那个不可寻址
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ `credential-materializer` 文件头声称的三段引用**不可寻址**，而代码用的是两段', () => {
  // ── 先把"文档确实还这么写着"钉住：删掉死的那份实现，**没有**改掉这句注释。
  const headerOwner = read('security/secrets/credential-materializer.mjs')
  assert.equal(headerOwner.includes('legion/model/<profileId>'), true,
    '★ `credential-materializer.mjs` 的文件头不再声称三段引用了 —— ' +
    '那说明有人把文档和代码对齐了（好事），请连同本条与 §5 第 17 条一起更新')

  // ── 正对照先跑。它们必须**可寻址**，否则下面那条"不可寻址"什么也证明不了：
  //    整个函数恒返回 false 时，断言照样是绿的。
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

  // ── 被检查的那一条：文档声称的那个形状
  const documented = planDshLookup('legion/model/default')
  assert.equal(documented.addressable, false,
    '★ 三段的 `legion/model/<id>` 竟然可寻址了 —— 那这处漂移就消失了，' +
    '请更新本条与 §5 第 17 条（文档与代码可以对齐成一个名字了）')
  assert.equal(documented.space, null, '没有位置时 space 必须是 null，不能是某个空间名')

  // 换一个 profileId 结论一样：这不是"某个 id 拼错了"，是**形状**不可寻址。
  assert.equal(planDshLookup('legion/model/deepseek-chat').addressable, false)

  // 而**两段**的 Legion 前缀是可寻址的 —— 这把原因钉死在"段数"上，
  // 而不是"legion/ 开头就不行"。少了这一条，读者会去改错的地方。
  assert.equal(planDshLookup('legion/openai').addressable, true,
    '两段的 legion/<name> 本该可寻址（records 空间）；' +
    '若它也不可寻址，那说明原因不是段数，本条的诊断词就写错了')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 活的那条链自己一致：cli.mjs 写的 == 运行时物化的，而且**可寻址**
// ══════════════════════════════════════════════════════════════════════════

test('③ ★ 唯一那份实现自身一致，且它写的名字端到端可寻址', () => {
  const cliSrc = read('product/launcher/cli.mjs')
  const cliRef = /const MODEL_KEY_REF = '([^']+)'/.exec(cliSrc)
  assert.ok(cliRef !== null, 'cli.mjs 里找不到 MODEL_KEY_REF 的声明')
  assert.equal(cliRef[1], RUNTIME_MODEL_KEY_REF,
    '活的这条链自己漂了：cli.mjs 写的与运行时物化的不是同一个名字')

  // 上一版 ⑤ 的另一半：活的那份的用例必须去 cli.mjs 里对账（drift 用例）。
  const liveTests = read('product/launcher/run-credential-materialization.test.mjs')
  assert.equal(liveTests.includes('RUNTIME_MODEL_KEY_REF'), true)
  assert.equal(/MODEL_KEY_REF/.test(liveTests), true,
    'run-credential-materialization.test.mjs 本该有一条 drift 用例' +
    '（去 cli.mjs 里正则抽出 MODEL_KEY_REF 逐字比对）；没有它，' +
    '活的这条链就没有任何东西钉着')

  // 而它写的名字**真的能用**——这是"配好了"与"运行时拿得到"之间的那一格。
  assert.equal(planDshLookup(RUNTIME_MODEL_KEY_REF).addressable, true,
    '★ 唯一那份实现写的名字竟然不可寻址 —— 那就是"向导报已配置、运行时拿不到钥匙"')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 随实现一起删掉的四个诊断码：**不能留在 schema 登记项里**
// ══════════════════════════════════════════════════════════════════════════

test('④ ★ 那四个 `FIRST_RUN_*` 码随实现消失，schema 里也不该再有它们的登记项', () => {
  const CODES = [
    'FIRST_RUN_SECRETS_UNAVAILABLE',
    'FIRST_RUN_SECRET_WRITE_FAILED',
    'FIRST_RUN_PROFILE_WRITE_FAILED',
    'FIRST_RUN_BINDING_WRITE_FAILED',
  ]
  const schema = read('product/config-schema.mjs')
  for (const code of CODES) {
    // 登记项留着 = 一条"这批码有人管"的读数，而它们已经没有产地了
    // （`scan.mjs` 的判据是"源码里出现的字面量属于哪个进程"）。
    const registered = new RegExp(`'${code}'`).test(schema)
    assert.equal(registered, false,
      `★ product/config-schema.mjs 里还登记着 ${code}，而它的产地（first-run.mjs）已经删了。` +
      '留着一个已无产地的登记项，与登记一个没有产地的码，是同一个东西')
    // 全仓也不该有人再**产生**它（注释里提一句历史是可以的，字符串字面量不行）。
    // ★ 排除 `.test.mjs`：**本文件自己**就在断言这四个名字，而"用例里写下这个名字"
    //   与"生产代码产生它"是两回事——不排除的话，这条判据会永远红在自己身上。
    const files = productionFiles()
      .filter((f) => !f.endsWith('config-schema.mjs') && !f.endsWith('.test.mjs'))
    const holders = files.filter((f) => readFileSync(join(REPO, f), 'utf8').includes(`'${code}'`))
    assert.deepEqual(holders, [], `★ ${code} 还出现在：${JSON.stringify(holders)}`)
  }
})
