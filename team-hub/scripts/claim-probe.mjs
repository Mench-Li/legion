// team-hub/scripts/claim-probe.mjs
// ============================================================================
// 并发探针：一个**真实子进程**，在指定时刻尝试领取同一条任务（PRT-314 的夹具）。
//
// 为什么必须是真的子进程，而不是同一个进程里的两条连接：
// 「同一条任务被两个 worker 各执行一遍」这件事只在**两个写入者**存在时才可能发生，
// 而同一进程内的两条连接共享的比不同进程多得多——同一份 `node:sqlite` 模块实例、
// 同一次 `PRAGMA` 设置、同一个事件循环（因此两条 `BEGIN IMMEDIATE` 不会真的同时发出）。
// 多进程这一层要验的是：WAL 的跨进程可见性、`busy_timeout` 的等待、
// 以及「条件更新 + 看 changes」在真并发下的胜负判定。
//
// 用法：node team-hub/scripts/claim-probe.mjs <dbFile> <workerId> <startAtMs>
// 输出：一行 JSON（stdout）。任何失败都以非零退出并把原因写到 stderr。
//
// 这个文件是**测试夹具**，不是产品代码：它以独立进程运行、自建连接、
// 并把结果打成 JSON 供父进程断言。产品里的 worker 走 HTTP（数据面单源）。
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { createRunStore } from '../run-store.mjs'

const [dbFile, workerId, startAtRaw] = process.argv.slice(2)
if (dbFile === undefined || workerId === undefined || startAtRaw === undefined) {
  process.stderr.write('用法：claim-probe.mjs <dbFile> <workerId> <startAtMs>\n')
  process.exit(2)
}
const startAtMs = Number(startAtRaw)
if (!Number.isFinite(startAtMs)) {
  process.stderr.write(`startAtMs 不是数字：${startAtRaw}\n`)
  process.exit(2)
}

// 与 server.mjs 相同的连接设置：busy_timeout 先设，再确保 WAL。
// 少了 busy_timeout，多进程争用会直接抛 SQLITE_BUSY 而不是按预算等待——
// 那是"偶发失败"而不是"明确拒绝"，会把并发问题伪装成随机故障。
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA journal_mode = WAL')

const store = createRunStore({ db })

/**
 * 忙等到指定时刻。
 *
 * 为什么不用 `setTimeout`：定时器的唤醒精度受事件循环影响，N 个进程会各自
 * 在几十毫秒的窗口里散开，于是「真的同时争用」变成了「先后到达」——
 * 用例照样通过，但它验证的东西已经不是并发。
 * `Atomics.wait` 在共享内存上自旋，误差在毫秒级，且它**让出** CPU 而不是忙转。
 */
function waitUntil(targetMs) {
  for (;;) {
    const remaining = targetMs - Date.now()
    if (remaining <= 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(remaining, 50))
  }
}

try {
  waitUntil(startAtMs)
  const startedAtMs = Date.now()
  const r = store.claim({ workerId })
  const claimed = r.claimed
  // 只挑 JSON 能安全承载的叶子字段（不 dump 活的 Cordis/DSH 对象——
  // 这里虽然都是纯数据，但保持"只取需要的那几个字段"是同一套纪律）
  const out = {
    workerId,
    startedAtMs,
    finishedAtMs: Date.now(),
    reason: r.reason ?? null,
    claimed: claimed === null ? null : {
      attemptId: claimed.attemptId,
      taskId: claimed.taskId,
      attemptNo: claimed.attemptNo,
      leaseEpoch: claimed.leaseEpoch,
      state: claimed.state,
    },
  }
  process.stdout.write(JSON.stringify(out) + '\n')
  db.close()
  process.exit(0)
} catch (e) {
  process.stderr.write(`claim-probe 失败：${e?.stack ?? e}\n`)
  try { db.close() } catch { /* 已关 */ }
  process.exit(1)
}
