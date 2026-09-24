// scratch/_probe-boundaries.mjs —— 目标文档 §2 line 128 那 5 条「不可突破的边界」，逐条量（**不提交**）
//
// ★★ 这个探针第一版**整套都是假阴性**，两个错叠在一起：
//   ① 我拼了 `rg` 的参数，而 `rg` 在本机**根本不在 PATH 上**（`spawnSync rg ENOENT`）；
//   ② `catch { return [] }` 把 ENOENT 与"没有匹配"**吞成了同一个值**。
//   ⇒ 5 条边界**全部**报 0，而"5 条全清白"与"探针一次都没跑成"在输出上长得一模一样。
//
//   > 一个依赖缺失的检索器，与一个真的什么都没匹配到的仓库，
//   > 在"零命中"这个读数下是同一个东西——只不过前者的 0 来自**没跑**。
//
//   修法两条：**①** 用 `git grep`（必然存在）；**②** 跑之前先拿一个**必然命中**的
//   模式自检一次，命中 0 就直接抛。**没有自检的探针，报的 0 不可信。**
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project/DSH/legion'
const GLOBS = ['*.mjs', '*.ts', '*.js']

/** 用 `git grep`（ERE）。status 1 = 没有匹配；其它非 0 = 真错误，必须抛。 */
function rg(pattern, globs = GLOBS) {
  const args = ['grep', '-l', '-I', '-E', pattern, ...(globs.length ? ['--', ...globs] : [])]
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) {
    if (e.status === 1) return []
    throw new Error(`git grep 失败（status ${e.status}）：${e.stderr ?? e.message}`)
  }
}
const isProd = (f) => !f.includes('.test.') && !f.startsWith('docs/') && !f.startsWith('scratch/')
  && !f.startsWith('.skills-cache')

// ★★★ 自检：换一个必然命中的模式。命中 0 ⇒ 检索器坏了，本探针的 0 不可信。
const SENTINEL = rg('RuntimeAdapter')
if (SENTINEL.length === 0) {
  throw new Error('自检失败：`RuntimeAdapter` 零命中 ⇒ 检索器坏了，本探针的 0 不可信')
}
console.log(`自检通过：\`RuntimeAdapter\` 命中 ${SENTINEL.length} 个文件\n`)
console.log('目标文档 §2 line 128：「不可突破的边界」（5 条）\n')

console.log('【① 不自研第二套 Agent Loop】')
for (const p of ['agentLoop|agent_loop|AgentLoop', 'runAgentLoop', 'agent[ _]loop']) {
  const f = rg(p)
  console.log(`   ${p}  →  命中 ${f.length}：${f.filter(isProd).slice(0, 5).join('、') || '（产品代码无）'}`)
}
console.log(`   ★ 反向核对：\`DshRuntimeAdapter\` 命中 ${rg('DshRuntimeAdapter').length} 个文件（执行面在适配层）`)

console.log('\n【② 不复制任务/审批/审计数据库】')
const dbs = rg('new DatabaseSync').filter(isProd)
console.log(`   new DatabaseSync 的产品代码文件 ${dbs.length} 个：`)
for (const f of dbs) console.log(`      ${f}`)
console.log(`   team[.]db 命中 ${rg('team[.]db').length} 个文件`)
console.log(`   schema_migrations / audit 表名：${rg('CREATE TABLE[^)]{0,40}(audit|tasks|approvals)').length} 处`)

console.log('\n【③ 不把 worktree 当安全沙箱】')
for (const p of ['worktree.*(sandbox|沙箱|隔离)', '(sandbox|沙箱|隔离).*worktree']) {
  const f = rg(p)
  console.log(`   ${p}  →  ${f.length}：${f.slice(0, 8).join('、') || '（零命中）'}`)
}
console.log(`   worktree 命中总数：${rg('worktree').length} 个文件`)

console.log('\n【④ 不在契约稳定前同时支持多个 Harness】')
const adapters = execFileSync('git', ['ls-files', 'runtime/adapters/*'], { cwd: REPO, encoding: 'utf8' })
  .split('\n').filter(Boolean)
console.log(`   runtime/adapters/ 下的适配器目录：${[...new Set(adapters.map((f) => f.split('/').slice(0, 3).join('/')))].join('、')}`)
for (const p of ['harness.{0,3}(adapter|Adapter)', 'claude.{0,4}adapter', 'codex.{0,4}adapter']) {
  console.log(`   ${p}  →  ${rg(p).length}`)
}

console.log('\n【⑤ 客户不需要单独安装或升级 DSH】')
for (const p of ['installDsh|installDSH', 'dsh.{0,6}(zip|tar[.]gz|download)', 'DSH_CHECKOUT']) {
  const f = rg(p)
  console.log(`   ${p}  →  命中 ${f.length}：${f.filter(isProd).slice(0, 8).join('、') || '（产品代码无）'}`)
}

console.log('\n【这一句自身有没有被判据引用】')
console.log('   ' + (rg('不可突破的边界', []).join('、') || '（零命中）'))
