/**
 * 破坏性验证：`scripts/lib/dsh-checkout.mjs` 的每条不变式**真的会红**。
 *
 * ## 为什么必须做
 *
 * 这一轮新增/改写了 22 个套件、把 232 条跳过里的 210+ 条变成真跑。
 * 如果那条解析器的判据本身是"永远说没问题"的，那么**这次迁移读起来
 * 与它真的成立完全一样**——绿得更多、而没有任何东西被验过。
 *
 * > 一套"永远说锚点都在"的核对器，与没有核对器，读起来一模一样。
 *
 * ## 方法
 *
 * 逐条把 `scripts/lib/dsh-checkout.mjs` 改坏（**只改语义，不改成语法错误**
 * ——语法错误会被 `--check` 拦下，那样验的是 Node 不是判据），
 * 跑 `tests/dsh-checkout.test.mjs`，要求它**失败**，然后逐字节还原。
 *
 * ## 关键：每条变异都要说清"它模拟哪一种真实的写错方式"
 *
 * 一个"把函数名拼错"的变异会咬住任何判据，所以它**不构成证据**。
 * 下面每条都对应一种**下一个人真会犯的错**。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TARGET = 'scripts/lib/dsh-checkout.mjs'
const SUITE = 'tests/dsh-checkout.test.mjs'
const ORIGINAL = readFileSync(TARGET, 'utf8')

const MUTATIONS = [
  {
    id: '㊸',
    what: '把**结构性候选**（`<ROOT>/../dsh/deepseek-harness`）从列表里删掉',
    simulates: '下一个人重构候选列表时把它当成"作者那台机器的路径"顺手清掉',
    old: "    resolve(root, '..', 'dsh', 'deepseek-harness'),\n",
    new: '',
  },
  {
    id: '㊹',
    what: '**静默回退**：变量设了但底下不对时，继续去走候选',
    simulates: '有人觉得"找不到就再找找"是更友好的行为——那会把配置错误变成一次"通过"',
    old: "    return done(null, null, miss, {\n      envValue, envPresent, envUsable: false, missing: miss, path: envValue, kind: 'unbuilt',\n    })",
    new: '    // mutated: 不返回，继续往下走候选\n',
  },
  {
    id: '㊺',
    what: '**抹掉「找到了但没构建」这个区分**（把它并回"没找到"）',
    simulates: '两个分支合并成一句"没有检出"——那句最省事，也最没用',
    old: "    if (extra.kind === 'unbuilt' && extra.path != null) {",
    new: '    if (false) {',
  },
  {
    id: '㊾',
    what: '**把「变量指向的路径不存在」并进「找到了一棵树但没构建」**',
    simulates: '★ 这正是我第一版犯的错：提示会让人去跑 `pnpm build`，而真正该做的是改那个变量',
    old: "      envValue, envPresent, envUsable: false, missing: wants.slice(), path: envValue, kind: 'env-not-a-dir',",
    new: "      envValue, envPresent, envUsable: false, missing: wants.slice(), path: envValue, kind: 'unbuilt',",
  },
  {
    id: '㊻',
    what: '**`isDir` 说了不算**（只信 `exists`）',
    simulates: '正是这个模块第一版犯的错：注入了一半的缝',
    old: '    try { return exists(p) === true && isDir(p) === true } catch { return false }',
    new: '    try { return exists(p) === true } catch { return false }',
  },
  {
    id: '㊼',
    what: '**调换候选顺序**：家目录约定排到结构性候选之前',
    simulates: '有人觉得"用户家目录更该优先"——于是结果依赖了哪棵树先被扫到',
    old: "    resolve(root, '..', 'dsh', 'deepseek-harness'),\n    join(homedir(), 'dsh-harness'),",
    new: "    join(homedir(), 'dsh-harness'),\n    resolve(root, '..', 'dsh', 'deepseek-harness'),",
  },
  {
    id: '㊽',
    what: 'win32 字面量**不按平台收窄**（posix 上也给 `D:/project/...`）',
    simulates: '有人把 `if (platform === \'win32\')` 去掉，因为"多给几条候选又没坏处"',
    old: "  if (platform === 'win32') {",
    new: '  if (true) {',
  },
  {
    id: '㊿',
    what: '**`REPO_ROOT` 少数一级 `..`**（`<root>/scripts` 而不是 `<root>`）',
    simulates: '★ 正是我第一版犯的错：本文件在 `scripts/lib/` 下，两级 `..`。' +
      '一级会让结构性候选指向一个不存在的地方，而 win32 字面量把结果救回来——' +
      '于是**判据全绿、而模块只在作者机器上工作**',
    old: "export const REPO_ROOT = resolve(HERE, '..', '..')",
    new: "export const REPO_ROOT = resolve(HERE, '..')",
  },
]

const runSuite = () => {
  try {
    const out = execFileSync(process.execPath, ['--test', SUITE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

/** 从输出里取失败的用例名（用于核对"红的是不是该红的那条"）。 */
const failedNames = (out) => [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1])

console.log('基线（未变异）：')
const base = runSuite()
const baseNames = failedNames(base.out)
console.log(`  exit=${base.code}  失败用例=${baseNames.length}${baseNames.length ? ' → ' + baseNames.join(' / ') : ''}`)
if (base.code !== 0) {
  console.error('\n✖ 基线就是红的——先把它修绿，否则下面的"咬住"证明不了任何事')
  process.exit(2)
}

let bit = 0
const rows = []
for (const m of MUTATIONS) {
  const patch = { old: m.old, new: m.new }
  if (!ORIGINAL.includes(patch.old)) {
    rows.push([m.id, m.what, '跳过', '锚点没找到（源码变了？）'])
    continue
  }
  if (ORIGINAL.split(patch.old).length - 1 !== 1) {
    rows.push([m.id, m.what, '跳过', `锚点出现 ${ORIGINAL.split(patch.old).length - 1} 次，不唯一`])
    continue
  }
  const mutated = ORIGINAL.replace(patch.old, () => patch.new)
  if (mutated === ORIGINAL) {
    rows.push([m.id, m.what, '跳过', '替换后逐字节相同——这条变异什么也没改'])
    continue
  }
  // ★ 只改语义、不改成语法错误：语法错误会被 `node --check` 拦下，
  //   那样验的是 Node 的解析器，不是我们的判据。
  try {
    execFileSync(process.execPath, ['--check', TARGET], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    writeFileSync(TARGET, ORIGINAL)
    rows.push([m.id, m.what, '跳过', '变异把源码改成了语法错误——那不是一条有效的变异'])
    continue
  }
  writeFileSync(TARGET, mutated)
  const r = runSuite()
  writeFileSync(TARGET, ORIGINAL)
  const names = failedNames(r.out)
  const caught = r.code !== 0 && names.length > 0
  if (caught) bit++
  rows.push([m.id, m.what, caught ? `咬住（${names.length} 条红）` : '**没咬住**', names.slice(0, 2).join(' / ') || '无失败'])
}

// 逐字节还原自检
const restored = readFileSync(TARGET, 'utf8')
console.log('\n变异结果：')
for (const [id, what, verdict, detail] of rows) {
  console.log(`  ${id}  ${verdict.padEnd(14)} ${what}`)
  if (detail) console.log(`        ${detail}`)
}
console.log(`\n咬住 ${bit} / ${MUTATIONS.length}`)
console.log(`还原逐字节一致：${restored === ORIGINAL ? '是' : '**否**'}`)
process.exit(bit === MUTATIONS.length && restored === ORIGINAL ? 0 : 1)
