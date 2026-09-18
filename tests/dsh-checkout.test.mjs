/**
 * `scripts/lib/dsh-checkout.mjs` 的判据。
 *
 * ## 为什么这一套**不碰真检出**
 *
 * 这个模块的整个价值是"在没有 DSH 的机器上也能说清发生了什么"。如果它的用例
 * 需要盘上真有 DSH，那么它在**最需要它的那台机器上会整组跳过**——
 * 而它测的正是"找不到时怎么办"。所以这里全部用**人造文件系统**（注入 `exists`）。
 *
 * ## 这一套钉的是什么
 *
 * 不是一个函数的返回值，而是**四种情况的区分**：
 *
 * | 情况 | 该给出的读数 |
 * |---|---|
 * | 变量没设、盘上也没有 | 「没找到」+ 候选列表（合法跳过） |
 * | 变量没设、盘上有（本项目布局/家目录约定） | **用上它**，并说出"是候选找到的" |
 * | 变量**设了**、但那底下不对 | 「有人指错了地方」——**不回退** |
 * | 找到树了、但没有构建产物 | 「克隆了但没构建」≠「没有检出」 |
 *
 * 第 3 条是最容易做错的一条：静默回退会把一个**配置错误**变成一次"通过"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'

import { DSH_NEEDS, dshCheckoutCandidates, dshSkipReason, resolveDshCheckout } from '../scripts/lib/dsh-checkout.mjs'

/**
 * 人造文件系统。
 *
 * ★ 要**两条**缝：`exists` 与 `isDir`。
 *   模块第一版只把 `exists` 做成可注入，而"是不是目录"照旧调真的 `statSync`
 *   ——于是人造路径一律被判成"不是目录"，整个套件报"找不到检出"，
 *   看起来像**模块**坏了。
 *
 *   > 一个仍然会碰到真文件系统的"可注入"存在性判断，
 *   > 与一个不可注入的判断，区别只在于**测试会以哪一种方式骗过你**。
 */
const normalize = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const fakeFs = (bases) => {
  const dirs = new Set()
  const files = new Set()
  for (const base of bases) {
    const b = normalize(base)
    // 每一级目录都要在 `dirs` 里——不是只列叶子
    const parts = b.split('/')
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    // 一棵"完整"的检出
    dirs.add(`${b}/packages`)
    dirs.add(`${b}/packages/credentials`)
    dirs.add(`${b}/packages/credentials/credentials-local`)
    dirs.add(`${b}/packages/credentials/credentials-local/lib`)
    dirs.add(`${b}/apps`)
    dirs.add(`${b}/apps/cli`)
    dirs.add(`${b}/apps/cli/lib`)
    files.add(`${b}/packages/credentials/credentials-local/lib/index.js`)
    files.add(`${b}/apps/cli/lib/bin.js`)
  }
  return {
    exists: (p) => dirs.has(normalize(p)) || files.has(normalize(p)),
    isDir: (p) => dirs.has(normalize(p)),
  }
}
/** 一棵只有源码树、**没有构建产物**的检出。 */
const fakeBareTree = (base) => {
  const b = normalize(base)
  const dirs = new Set()
  const parts = b.split('/')
  for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  dirs.add(`${b}/packages`)
  return { exists: (p) => dirs.has(normalize(p)), isDir: (p) => dirs.has(normalize(p)) }
}

const noEnv = {}
const ROOT = 'D:/project/DSH/legion'
const STRUCTURAL = 'D:/project/DSH/dsh/deepseek-harness'
const HOME = `${homedir().replace(/\\/g, '/')}/dsh-harness`
const NOTHING = { exists: () => false, isDir: () => false }

// ─────────────────────────────────────────────────────────── 候选列表

test('① 候选列表里 `$DSH_CHECKOUT` 永远第一（显式指定压过一切推测）', () => {
  const c = dshCheckoutCandidates({ env: { DSH_CHECKOUT: '/explicit/dsh' }, platform: 'linux', root: ROOT })
  assert.equal(c[0], '/explicit/dsh')
})

test('② ★★ 第二条是**结构性**候选，不是硬编码的绝对路径', () => {
  // 两个检出在本项目布局里平级：<ROOT>/../dsh/deepseek-harness。
  // 这条候选在任何按这个布局摆放的机器上都成立——
  // 一个"只在作者那台机器上存在"的候选，与一条真正的规则，
  // 在"它今天能解析"这个读数上是同一个东西。
  //
  // ★ 索引要看 `env`：显式给了 `DSH_CHECKOUT` 时它在 0 位，
  //   结构性候选才在 1 位。第一版无脑断言 `c[1]`，而 `env: {}` 下
  //   结构性候选在 **0** 位——于是那条断言测的是"家目录候选"。
  const withEnv = dshCheckoutCandidates({ env: { DSH_CHECKOUT: '/explicit/dsh' }, platform: 'linux', root: ROOT })
  assert.equal(withEnv[0], '/explicit/dsh')
  // ★ 期望值要用 `resolve` 算，不能手写 `${ROOT}/../...`：
  //   `resolve` 会把 `legion/..` 收掉，而手写的那串不会——
  //   于是断言在比"字符串形态"而不是比"路径"。
  assert.equal(normalize(withEnv[1]), normalize(resolve(ROOT, '..', 'dsh', 'deepseek-harness')))
  assert.equal(normalize(withEnv[1]), normalize(STRUCTURAL))

  // 没给变量时，它就顶上 0 位
  const noEnvList = dshCheckoutCandidates({ env: noEnv, platform: 'linux', root: ROOT })
  assert.equal(normalize(noEnvList[0]), normalize(STRUCTURAL))
})

test('③ win32 字面量按平台收窄（posix 上没有 "D:/project/..." 这种有意义路径）', () => {
  const win = dshCheckoutCandidates({ env: noEnv, platform: 'win32', root: ROOT })
  const posix = dshCheckoutCandidates({ env: noEnv, platform: 'linux', root: ROOT })
  assert.ok(win.some((p) => /^D:\/project\//i.test(p)), 'win32 上应当有盘符字面量')
  assert.equal(posix.some((p) => /^D:\/project\//i.test(p)), false,
    'posix 上不该出现 `D:/project/...`——它会被当成相对路径 `D:` 下的东西')
  // 两边都保留家目录约定
  for (const list of [win, posix]) {
    assert.ok(list.some((p) => /dsh-harness$/.test(normalize(p))), '候选里应当有 ~/dsh-harness')
  }
})

test('④ 空 / 空白 / 非字符串的 `$DSH_CHECKOUT` 不占一个候选位', () => {
  for (const v of ['', '   ', undefined, null, 42]) {
    const c = dshCheckoutCandidates({ env: { DSH_CHECKOUT: v }, platform: 'linux', root: ROOT })
    assert.equal(c.includes(v), false, `\`${String(v)}\` 不该出现在候选里`)
    assert.ok(c.length >= 4, `候选不该被削到 ${c.length} 条`)
    assert.equal(normalize(c[0]), normalize(STRUCTURAL), '空变量时结构性候选应当顶上第一位')
  }
})

// ─────────────────────────────────────────── 情况一：哪儿都没有

test('⑤ 变量没设、盘上也没有 ⇒ 「没找到」+ 候选列表（这是**合法**跳过）', () => {
  const r = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'linux', root: ROOT, ...NOTHING })
  assert.equal(r.checkout, null)
  assert.equal(r.source, null)
  assert.equal(r.envPresent, false)
  assert.equal(r.unbuilt, false, '什么都没找到时不该说"找到了但没构建"')
  assert.match(r.reason, /没找到/)
  assert.match(r.reason, /DSH_CHECKOUT/, '理由里必须说出怎么才能真正核对')
  // ★ 理由里要带上候选，否则读的人不知道"找过哪里"
  assert.ok(r.candidates.length >= 4)
  assert.match(r.reason, /dsh-harness/)
})

// ───────────────────────────────── 情况二：变量没设、但候选里有

test('⑥ ★★★ 变量没设、但**结构性候选**里有一份完整检出 ⇒ 用上它', () => {
  const r = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'win32', root: ROOT, ...fakeFs([STRUCTURAL]) })
  assert.ok(r.checkout !== null, `应当解析到 ${STRUCTURAL}（理由：${r.reason}）`)
  assert.equal(normalize(r.checkout), normalize(STRUCTURAL))
  assert.equal(r.source, 'candidate')
  assert.equal(r.envPresent, false)
  assert.equal(r.missing.length, 0)
  // ★ 理由里必须说清"是候选找到的"，而不是含糊地说"有检出"——
  //   否则"用了显式指定的那一份"与"用了推测出来的那一份"不可区分。
  assert.match(r.reason, /候选/)
  assert.match(r.reason, /DSH_CHECKOUT 未设置/)
})

test('⑦ ★★ 变量没设、结构性候选**不在**、而家目录约定在 ⇒ 仍然用上它', () => {
  const r = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'linux', root: ROOT, ...fakeFs([HOME]) })
  assert.equal(r.source, 'candidate')
  assert.equal(normalize(r.checkout), normalize(HOME))
})

test('⑧ 候选按**顺序**取：结构性候选排在 `~/dsh-harness` 之前', () => {
  const r = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'win32', root: ROOT, ...fakeFs([STRUCTURAL, HOME]) })
  assert.equal(normalize(r.checkout), normalize(STRUCTURAL),
    '同时存在时应当取更靠前的那条候选（可复现，而不是看哪棵树先被扫到）')
})

// ─────────────────────────── 情况三：变量设了但底下不对（最要紧）

test('⑨ ★★★ 变量**设了**却指错了地方 ⇒ 报"指错了"，**不回退**到候选', () => {
  // 盘上另有一份**好的**检出（结构性候选），而用户显式指的那份是坏的。
  const bogus = 'D:/typo/not-a-checkout'
  const r = resolveDshCheckout({
    env: { DSH_CHECKOUT: bogus }, need: 'cli', platform: 'win32', root: ROOT, ...fakeFs([STRUCTURAL]),
  })

  assert.equal(r.checkout, null, '显式指定不可用时**不许**回退到别的检出')
  assert.equal(r.envPresent, true)
  assert.equal(r.envUsable, false)
  assert.equal(normalize(r.path), normalize(bogus), '理由要指向**用户给的那个**路径，不是候选里的')
  assert.match(r.reason, /not-a-checkout/)

  // ★ 反向控制：把变量去掉，同一棵树就该解析成功。
  //   没有这一条的话，"不回退"与"这个模块根本找不到那份好检出"不可区分。
  const ok = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'win32', root: ROOT, ...fakeFs([STRUCTURAL]) })
  assert.equal(ok.source, 'candidate', '去掉变量后应当能找到那份好检出——否则上一条证明不了什么')
})

test('⑩ 变量设了、底下**有树但没构建** ⇒ 与"指错了"同样是显式配置问题', () => {
  const r = resolveDshCheckout({
    env: { DSH_CHECKOUT: STRUCTURAL }, need: 'cli', platform: 'win32', root: ROOT, ...fakeBareTree(STRUCTURAL),
  })
  assert.equal(r.checkout, null)
  assert.equal(r.unbuilt, true)
  assert.ok(r.missing.includes('apps/cli/lib/bin.js'), `缺的应当是 CLI 入口：${JSON.stringify(r.missing)}`)
})

// ─────────────────────── 情况四：找到树了但没构建 ≠ 没找到

test('⑪ ★★★ 「克隆了但没构建」与「这台机器上没有检出」是两句不同的话', () => {
  const rBare = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'win32', root: ROOT, ...NOTHING })
  const rUnbuilt = resolveDshCheckout({
    env: noEnv, need: 'cli', platform: 'win32', root: ROOT, ...fakeBareTree(STRUCTURAL),
  })

  assert.equal(rUnbuilt.checkout, null)
  assert.equal(rUnbuilt.unbuilt, true)
  assert.equal(rBare.unbuilt, false)
  assert.notEqual(rUnbuilt.reason, rBare.reason)
  assert.match(rUnbuilt.reason, /没有构建|pnpm build/, '要说清"该怎么办"')
  assert.match(rUnbuilt.reason, /deepseek-harness/, '要指向找到的那棵树')
  assert.equal(/pnpm build/.test(rBare.reason), false, '没找到树时不该提"去构建"')
})

test('⑫ `need` 用名字：`packages` 够用的场景不该被 CLI 产物拖累', () => {
  // 只有源码树、没有构建产物：读源码做交叉核对的那类套件**应当能跑**。
  const fsBare = fakeBareTree(STRUCTURAL)
  const srcOnly = resolveDshCheckout({ env: noEnv, need: 'packages', platform: 'win32', root: ROOT, ...fsBare })
  assert.equal(srcOnly.checkout !== null, true, '只要 packages/ 时应当可用')
  const cli = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'win32', root: ROOT, ...fsBare })
  assert.equal(cli.checkout, null, '要 CLI 时同一棵树应当不可用')
  // 三档需求是**包含**关系
  assert.deepEqual([...DSH_NEEDS.packages], ['packages'])
  assert.ok(DSH_NEEDS.cli.includes('packages'))
  assert.ok(DSH_NEEDS.credentials.includes('packages'))
})

// ──────────────────────────────────────────────── 便捷形式

test('⑬ `dshSkipReason`：可用时 `false`，不可用时是**一句能直接给人看的话**', () => {
  const ok = dshSkipReason({ need: 'packages' })
  assert.equal(ok, false, `本机应当能解析（实际：${ok}）`)

  const no = dshSkipReason({ need: 'cli', env: noEnv, platform: 'linux', root: ROOT, ...NOTHING })
  assert.equal(typeof no, 'string')
  assert.ok(no.length > 40, '理由要够读（不能是 "skip" 这种词）')
  assert.match(no, /DSH_CHECKOUT/)
})

// ──────────────────────────────────────────────── 返回值形状

test('⑭ ★ 返回值是**冻结**的，且 `candidates` 是副本（调用方改不动它）', () => {
  const r = resolveDshCheckout({ env: noEnv, platform: 'linux', root: ROOT, ...NOTHING })
  assert.equal(Object.isFrozen(r), true)
  assert.equal(Object.isFrozen(r.candidates), true)
  assert.equal(Object.isFrozen(r.missing), true)
  assert.throws(() => { r.checkout = 'x' }, TypeError)
  // 再调一次拿到的候选不受影响
  const again = dshCheckoutCandidates({ env: noEnv, platform: 'linux', root: ROOT })
  assert.deepEqual([...r.candidates], again)
})

test('⑮ ★★ 真机上：`$DSH_CHECKOUT` 未设也能解析到那份检出（这一条读的是**当前**机器）', () => {
  // 这条是"把 232 条跳过变成能跑"这句话的**唯一**直接判据：
  // 在没有 `DSH_CHECKOUT` 的环境里，解析器要自己找到它。
  //
  // ⚠️ 它不是"必须成立"的：一台真的没有 DSH 的机器上，这条会走下面那个分支。
  //    所以它明确分支，而不是"跳过了事"。
  const r = resolveDshCheckout({ need: 'cli' })
  if (r.checkout === null) {
    // 没有检出：那也不该"无话可说"，理由必须可读
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.reason.length > 40, `理由太短：${r.reason}`)
    return
  }
  assert.equal(r.envPresent, false, '本机 `$DSH_CHECKOUT` 应当是未设的（否则这条测的不是候选路径）')
  assert.equal(r.source, 'candidate')
  assert.equal(r.missing.length, 0)
})

test('⑲ ★★★ 「变量指向的路径不存在」与「找到了一棵树但没构建」必须是两句不同的话', () => {
  // ★ 这一条是**我自己第一版写错的地方**，而它错得很有代表性：
  //   第一版把这两种情况并成了一支，于是
  //
  //     $DSH_CHECKOUT=D:/typo/nope
  //     → 「找到一个 DSH 检出（D:/typo/nope），但它缺少 packages……
  //        那多半是『克隆了但没构建』」
  //
  //   **那句话是错的**：那里根本没有东西，谈不上"没构建"。
  //
  //   > 一个把"路径打错了"说成"克隆了没构建"的提示，
  //   > 会让下一个人去跑 `pnpm build`，而真正该做的是改那个变量。
  //
  //   而这正是本模块存在的理由（"三种情况说三句话"）。
  //   一个自己都会把三种并成两种的模块，比没有它更糟——
  //   因为它的**名字**承诺了它分得清。
  const bogus = 'D:/typo/nope'
  const rNotDir = resolveDshCheckout({
    env: { DSH_CHECKOUT: bogus }, need: 'cli', platform: 'win32', root: ROOT, ...NOTHING,
  })

  // ① 路径不存在
  assert.equal(rNotDir.kind, 'env-not-a-dir')
  assert.equal(rNotDir.unbuilt, false, '路径根本不存在时**不许**说"找到了但没构建"')
  assert.match(rNotDir.reason, /不是一个已存在的目录/)
  assert.match(rNotDir.reason, /变量配错了/)
  assert.equal(/pnpm build/.test(rNotDir.reason), false,
    '这句话**不该**提"去构建"——那里没有东西可构建')
  assert.ok(rNotDir.reason.includes(bogus), '理由要指向用户给的那个路径')

  // ② 目录在、产物不在
  const rUnbuilt = resolveDshCheckout({
    env: { DSH_CHECKOUT: STRUCTURAL }, need: 'cli', platform: 'win32', root: ROOT, ...fakeBareTree(STRUCTURAL),
  })
  assert.equal(rUnbuilt.kind, 'unbuilt')
  assert.equal(rUnbuilt.unbuilt, true)
  assert.match(rUnbuilt.reason, /pnpm build/)

  // ③ 哪儿都没有
  const rNone = resolveDshCheckout({ env: noEnv, need: 'cli', platform: 'linux', root: ROOT, ...NOTHING })
  assert.equal(rNone.kind, 'not-found')
  assert.equal(rNone.unbuilt, false)

  // ★ 三句话必须**两两不同**——这是这条判据的全部要点
  const three = [rNotDir.reason, rUnbuilt.reason, rNone.reason]
  assert.equal(new Set(three).size, 3, `三种情况必须给三句不同的话，实际：\n${three.join('\n---\n')}`)
})

test('⑰ ★★★ 三处曾经各自独立的候选列表，现在同意同一个答案', async () => {
  // 这一轮开始时，本仓有**三份**候选列表：
  //
  //   · `tests/p13-fixture/host-fixture.mjs`      `D:/project/DSH/dsh/deepseek-harness`
  //   · `scripts/ci/build-external-package.mjs`   `D:/project/dsh/deepseek-harness`
  //   · `scripts/prt/dsh-pin-drift.mjs`           同上一份
  //
  // 前两处的 Windows 字面量**大小写不同**。在 win32 上两者都能解析
  // （路径不区分大小写），所以这个不一致**今天看不出来**——
  // 而它是"同一件事有三份实现"的典型指纹：
  //
  //   > 一个只在大小写不敏感的文件系统上成立的巧合，
  //   > 与一条真正的规则，在"它今天能解析"这个读数上是同一个东西。
  //
  // ★ 这条判据**不是**"比对源码里那串字面量"（那是在比字符串），
  //   而是让两份实现**各自跑一遍**、看它们是不是指向同一个目录。
  //   源码级比对会在重构后误报，而行为级比对不会。
  const { resolveCheckout: pinDriftResolve } = await import('../scripts/prt/dsh-pin-drift.mjs')

  const mine = resolveDshCheckout({ need: 'packages' })
  const theirs = pinDriftResolve()

  if (mine.checkout === null) {
    assert.equal(theirs, null, '我们找不到时，那一份也不该"找到了"——否则两份实现已经不一致')
    return
  }
  assert.ok(theirs !== null, `我们找到了 ${mine.checkout}，而 dsh-pin-drift 找不到——候选列表已漂`)
  assert.equal(normalize(theirs), normalize(mine.checkout),
    `两份实现指向了不同的检出：我们 ${mine.checkout} vs 它 ${theirs}`)
})

test('⑱ ★★ 共享解析器住在 `scripts/lib/`，且**没有** `scripts/` 反向 import `tests/`', () => {
  // 本仓已有的依赖方向是 tests → scripts（`credential-materializer.test.mjs`
  // import `scripts/config/scan.mjs` 等），而 **scripts → tests 一处都没有**。
  //
  // 解析器第一版住在 `tests/` 下，于是 `scripts/` 那两份列表要么反向 import
  // （破坏方向）、要么**继续独立漂着**——实际发生的是后者。
  // 这条判据把"住的楼层对不对"变成读数。
  const files = globSync('scripts/**/*.mjs')
  const offenders = []
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      const target = resolve(dirname(resolve(f)), spec)
      if (target.split(sep).join('/').includes('/tests/')) offenders.push(`${f} → ${spec}`)
    }
  }
  assert.deepEqual(offenders, [], '`scripts/` 里出现了指回 `tests/` 的 import')

  // ★ 反向控制：这条判据**能红**——拿一个真的指回 tests 的 spec 喂进**同一段判断**。
  const probe = ['scripts/x.mjs', "import { y } from '../../tests/dsh-checkout.mjs'"]
  const hit = [...probe[1].matchAll(/from\s+'([^']+)'/g)]
    .map((m) => resolve(dirname(resolve(probe[0])), m[1]))
    .filter((t) => t.split(sep).join('/').includes('/tests/'))
  assert.equal(hit.length, 1, '形状检验：这段判断得真的能识出一个指回 tests 的 import')

  // 而共享解析器确实在 scripts/lib 下
  assert.equal(existsSync(resolve('scripts/lib/dsh-checkout.mjs')), true)
})

test('⑯ ★★ 注入的 `exists` 必须真的说了算（这条钉住"缝不能漏到真文件系统"）', () => {
  // 反向判据：拿一个**真实存在**的路径（REPO_ROOT 自身），
  // 但喂一个说"什么都不存在"的 `exists`——解析器必须**不**认它。
  //
  // 没有这一条的话：`exists` 参数可能只是签名上的装饰
  // （第一版就是——`isDir` 那一步仍在调真的 `statSync`），
  // 而"测试全绿"与"这条缝是真的"在读数上完全一样。
  const realRoot = ROOT // 这个路径在真机上确实存在
  const r = resolveDshCheckout({
    env: noEnv, need: 'packages', platform: 'win32',
    root: realRoot,
    exists: () => true,
    isDir: () => false, // 说"存在，但不是目录"
  })
  assert.equal(r.checkout, null, '`isDir` 说了不是目录，就不许认它')

  // 再用"存在的真目录 + 真判断"确认同一批路径在真机上确实能被认出来
  const real = resolveDshCheckout({ env: noEnv, need: 'packages', platform: 'win32', root: realRoot })
  assert.ok(real.checkout !== null, '不注入时应当按真文件系统正常解析')
  assert.equal(normalize(real.checkout), normalize(STRUCTURAL))
})
