// scratch/_check-facts-once.mjs —— 在**新进程**里跑一次 checkFacts，把某条 id 的结论打出来（**不提交**）
//
// 为什么要单开一个进程：变异脚本如果在**同一个进程**里改源文件再 `checkFacts()`，
// ESM 的模块缓存会让它仍然用**改之前**的那份 —— 于是 5 个变异全部"漏网"，
// 而真相是**变异根本没执行**。
//
//   > "变异没执行"与"守卫没咬住"在输出里长得一模一样，处置却完全相反。
//   > （这正是第 24 轮我记下的那两个坑之一；第 26 轮我又踩了一次。）
const id = process.argv[2]
const { checkFacts } = await import('../scripts/prt/boundary-facts.mjs')
try {
  const r = checkFacts()
  const v = r.violations.find((x) => x.id === id)
  console.log(JSON.stringify({
    checked: r.checked, total: r.total,
    hit: v !== undefined,
    code: v?.code ?? null, claimed: v?.claimed ?? null, actual: v?.actual ?? null,
    ids: r.violations.map((x) => x.id),
  }))
} catch (e) {
  console.log(JSON.stringify({ hit: true, code: 'THREW', detail: String(e.message).slice(0, 120) }))
}
