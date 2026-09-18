// scratch/prt509-force-hang.cjs
// ============================================================================
// 一个**故意不让宿主退出**的 shim，用来给 `runHost` 新加的那条分支做正面对照。
//
// ## 为什么需要它
//
// 本批给 `run-credential-dsh-process.test.mjs` 的 `runHost` 加了"证据到手就不再干等"
// 的逻辑，收场分三种：`natural` / `killed-after-evidence` / `timeout`。
//
// 而我今天观测到的**每一次**都是 `natural`。
//
//   > 一条只在"另一种情形"下才走的分支，在全是同一种情形的日志里，
//   > 与"根本没接上"长得一模一样。
//
// 于是那条分支**等于没被验证过**。这个 shim 把"另一种情形"造出来：
// 让宿主**写完成证据之后继续活着**（开一个不 unref 的定时器），从而必然走到
// `killed-after-evidence`。
//
// ## 纪律
//
// · **只钉住宿主**（`argv[1]` 含 `bin.js`）。若把 `node --test` worker 也钉住，
//   整个套件自己就不会结束——那会得到一个"测试挂死"的假象，而不是被测分支的读数。
// · 只在 `PRT509_FORCE_HANG=1` 时生效。
// ============================================================================
const isHost = String(process.argv[1] ?? '').includes('bin.js')

if (process.env.PRT509_FORCE_HANG === '1' && isHost) {
  // ★ 故意**不** unref：这正是一个"事件循环永远非空"的进程，
  //   与根因（残留的 chokidar FSWatcher）造成的效果一致。
  setInterval(() => { /* 钉住事件循环 */ }, 60000)
  process.stderr.write('[FORCE-HANG] 宿主被故意钉住：证据写完之后也不会自然退出\n')
}
