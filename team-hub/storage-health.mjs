// team-hub/storage-health.mjs
// ============================================================================
// 存储健康：**磁盘满的时候，用户看到什么**，以及**运维怎么提前知道**。
//
// ## 为什么这是一个必须单独处理的情形
//
// 实测（`PRAGMA max_page_count` 确定性复现 `SQLITE_FULL`，2026-10-12）：库写不进去时
// Hub 原本回的是
//
//     HTTP 400  { "error": "database or disk is full", "code": "ERR_SQLITE_ERROR" }
//
// 三个独立的错，每一个都会造成真实伤害：
//
//   ① **状态码 400** 是"**客户端**请求有错"。这是服务端存储问题 —— 客户端什么都没做错。
//      而 400 的含义是"别重试了，改你的请求"。
//
//   ② **消息是原始英文 SQLite 文本**。中文界面上弹一句 `database or disk is full`，
//      用户既看不懂，也不知道该做什么（而他确实什么都做不了 —— 那是服务器的事）。
//
//   ③ **`ERR_SQLITE_ERROR` 是实现细节**，不是可据以行动的码。
//
// ★ 而 ① 会造成一个**连锁伤害**，它落在别的模块里：手机端的离线待发队列按
//   `classifyFailure({status})` 分类，400 被判成**永久失败** ——
//   于是那条消息**停止自动重试**，被标成"发不出去"等用户处理。
//   而磁盘满**根本不是永久的**：运维清出空间之后，同一条重发完全能成功。
//
//   > 一条"磁盘满时被标成永久失败"的消息，
//   > 其实等一会儿就能发出去 —— 但队列再也不会自动试了。
//
//   也就是说：**状态码选错**这一个决定，会在另一个模块里变成"用户的字被卡住"。
//   所以修法不只是把 400 换成 503，还要保证那个分类**看得见**这是一个临时状况。
//
// ## ★ 为什么不"拿不准就当成存储问题"
//
// 这里有一个诱人的偷懒：既然"存储问题被误判成普通错误"后果严重，
// 那就反过来 —— **拿不准时一律当成存储问题**。
//
// 那个方向同样有害，而且更隐蔽：一个真实的输入错误（"消息正文不能为空"）
// 会被报成"服务器存储问题"，客户端于是**永远重试**、永不停止，
// 而用户永远看不到"你的消息有问题"这句话。
//
//   > 两个方向的误判各自造成一种**静默**伤害：
//   > 一边是用户的字被永久卡住，另一边是一个永远修不好的队列。
//   > 所以这里的答案是**精确识别**，不是偏向任何一侧。
//
// 认得出的信号就那几种（下面逐条列出），其余一律保持原有行为。
//
// ## 阈值为什么用**绝对字节**而不是百分比
//
// 因为"能不能继续工作"是一个**绝对**问题，不是一个比例问题：
//
//   · SQLite 需要一个 WAL 的空间；
//   · 而备份走的 `VACUUM INTO`（`product/server/backup.mjs`）需要一份**完整的副本**
//     —— 也就是说 **备份需要和库一样大的空闲空间**。
//
// 第二条是关键：**在写入失败之前，备份会先失败**。5% 的 59G 是 2.9G（够），
// 5% 的 1T 是 51G（远超必要），而 5% 的 100M 是 5M（不够一次备份）。
// 所以判据是 `free < 倍数 × dbBytes` —— 它自己随库大小缩放。
// ============================================================================

/** 需要一次完整副本才能备份的倍数（`VACUUM INTO` 写一份等大的新文件）。 */
export const BACKUP_HEADROOM_FACTOR = 2

/** `free < 这个倍数 × 库大小` → 警告：备份快做不成了。 */
export const WARN_HEADROOM_FACTOR = 10

/** 一个绝对下限：再小的库也得留出这些，否则 WAL 都可能写不下。 */
export const WARN_MIN_FREE_BYTES = 1024 * 1024 * 1024      // 1 GiB

/** `free < 这个倍数 × 库大小` → 危险：写入随时会开始失败。 */
export const CRITICAL_HEADROOM_FACTOR = BACKUP_HEADROOM_FACTOR

/** 危险档的绝对下限。 */
export const CRITICAL_MIN_FREE_BYTES = 256 * 1024 * 1024   // 256 MiB

/** 给客户端的状态码：**服务暂时不可用**，而不是"你的请求有错"。 */
export const STORAGE_STATUS = 503

/** 具名错误码：客户端按**类型**分支，不按文案匹配。 */
export const STORAGE_CODE = 'STORAGE_UNAVAILABLE'

/**
 * SQLite 的 `errcode`（扩展结果码的**低 8 位**就是主码，这里列主码）。
 *
 * 之所以按 `errcode` 而不是 `message` 判：消息文本是 SQLite 的实现细节，
 * 换个版本、换个编译选项就可能变；而 `errcode` 是**稳定的接口**。
 * 消息匹配只作为**兜底**（当错误被别的层重新包过、`errcode` 丢了的时候）。
 */
export const SQLITE_CODES = Object.freeze({
  /** `SQLITE_FULL`（13）：盘满 / 库到 `max_page_count`。 */
  13: 'full',
  /** `SQLITE_READONLY`（8）：库或它所在的目录不可写。 */
  8: 'readonly',
  /** `SQLITE_IOERR`（10）：磁盘 I/O 错（坏盘、被摘掉的挂载）。 */
  10: 'io',
  /** `SQLITE_CANTOPEN`（14）：打不开库文件（目录没了、权限不对）。 */
  14: 'io',
  /** `SQLITE_NOMEM`（7）：内存分配失败 —— 进程被内存上限卡住时也会这样。 */
  7: 'io',
})

/** Node 的 `fs` / 系统错误码 → 类别。 */
export const SYSTEM_CODES = Object.freeze({
  ENOSPC: 'full',
  EDQUOT: 'full',      // 磁盘配额用尽（与"盘满"对用户是同一件事）
  EROFS: 'readonly',
  EACCES: 'readonly',
  EPERM: 'readonly',
  EIO: 'io',
})

/**
 * 消息兜底匹配。**只列 SQLite 与系统自己的原文**，不做模糊猜测 ——
 * 见文件头那段"精确识别，不是偏向"。
 */
const MESSAGE_PATTERNS = Object.freeze([
  [/database or disk is full/i, 'full'],
  [/database disk image is malformed/i, 'io'],
  [/disk i\/o error/i, 'io'],
  [/attempt to write a readonly database/i, 'readonly'],
  [/unable to open database file/i, 'io'],
  [/\bno space left on device\b/i, 'full'],
  [/read-only file system/i, 'readonly'],
])

/**
 * 这个错误是不是**存储**问题？是的话属于哪一类？
 *
 * @param {{errcode?: number, errstr?: string, code?: string|number, message?: string}|null} err
 * @returns {{storage: boolean, kind: 'full'|'readonly'|'io'|null, via: 'errcode'|'code'|'message'|null}}
 */
export function classifyStorageError(err) {
  const miss = { storage: false, kind: null, via: null }
  if (err === null || err === undefined) return miss
  if (typeof err === 'string') {
    for (const [re, kind] of MESSAGE_PATTERNS) if (re.test(err)) return { storage: true, kind, via: 'message' }
    return miss
  }
  if (typeof err !== 'object') return miss

  // ① `errcode`（最可靠）。
  const errcode = Number(err.errcode)
  if (Number.isFinite(errcode) && SQLITE_CODES[errcode] !== undefined) {
    return { storage: true, kind: SQLITE_CODES[errcode], via: 'errcode' }
  }
  // ② `code`（Node 系统错误码）。
  const code = typeof err.code === 'string' ? err.code.toUpperCase() : null
  if (code !== null && SYSTEM_CODES[code] !== undefined) {
    return { storage: true, kind: SYSTEM_CODES[code], via: 'code' }
  }
  // ③ 消息兜底 —— 有些层（HTTP 适配、重抛）会把 `errcode` 丢掉，
  //    只剩一句原文。那时消息是唯一还剩的证据。
  const message = typeof err.message === 'string' ? err.message : ''
  for (const [re, kind] of MESSAGE_PATTERNS) if (re.test(message)) return { storage: true, kind, via: 'message' }
  return miss
}

/**
 * 给**用户**看的那句话。
 *
 * ★ 两条纪律：
 *   ① **不把原始 SQLite 英文透出去**。用户看不懂，而且那句话里
 *      `database` / `disk` 这些词会让人以为是自己这边的问题。
 *   ② **不叫用户做他做不到的事**。"请清理磁盘空间"是给运维的指令 ——
 *      对一个手机用户说这句，他只会去清自己手机的存储，而那毫无用处。
 *
 * 所以这句话只回答三件事：这是**服务器**的问题 · **不是**你的消息有问题 ·
 * **会**被自动重试。
 */
export function storageMessage({ kind = 'full' } = {}) {
  const what = kind === 'readonly'
    ? '服务器的存储当前不可写'
    : kind === 'io'
      ? '服务器的存储出了故障'
      : '服务器的存储空间已满'
  return `${what}，这条消息暂时无法保存。`
    + '（不是你的消息有问题；服务器恢复后会自动重试。请联系管理员。）'
}

/**
 * 磁盘余量档位。
 *
 * ★ 判据是"能不能再写一次"与"能不能再做一次备份"，两者都是**绝对**问题 ——
 *   见文件头那段为什么不用百分比。
 *
 * ★★ 这里**不许**用 `Number(x)` 做转换。`Number(null)` 是 **0**、
 *    `Number('')` 也是 0 —— 于是"读不到余量"会被静默当成"0 字节可用"，
 *    而那读起来是"盘已经满了"，与"我们不知道"是两件完全不同的事
 *    （一个会让运维去查一个不存在的故障，一个会让他去装监控）。
 *
 *    > 一个"读不到就当 0"的默认，与一个"真的读到了 0"的读数，
 *    > 在告警列表上长得一模一样 —— 而只有其中一个需要人去查。
 *
 * @param {{freeBytes: number, dbBytes: number}} input
 * @returns {'ok'|'warn'|'critical'|'unknown'}
 */
export function diskLevel(input) {
  const src = (input === null || typeof input !== 'object') ? {} : input
  const free = num(src.freeBytes)
  const db = num(src.dbBytes)
  // ★ 读不到读数时回 `unknown`，**不是** `ok`。
  //   把"不知道"报成"正常"，正是那种让运维在事故当天才发现没人监控的默认。
  if (free === null || free < 0) return 'unknown'
  const size = db !== null && db > 0 ? db : 0
  const criticalAt = Math.max(CRITICAL_MIN_FREE_BYTES, CRITICAL_HEADROOM_FACTOR * size)
  if (free < criticalAt) return 'critical'
  const warnAt = Math.max(WARN_MIN_FREE_BYTES, WARN_HEADROOM_FACTOR * size)
  if (free < warnAt) return 'warn'
  return 'ok'
}

/**
 * 只接受**真正的数字**。
 *
 * `Number(null)`/`Number('')`/`Number([])` 全是 0，所以用 `Number(x)` 做校验
 * 会让"没读到"与"读到 0"分不开 —— 上面 `diskLevel` 那段注释解释了为什么那很坏。
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 给**运维**的读数。
 *
 * ★ 为什么要含**备份的年龄**：盘满会先把备份打坏（`VACUUM INTO` 需要一份等大的
 *   自由空间），而"备份停止工作"这件事，**只有在需要恢复的那一天才会被发现**。
 *   把它摆在同一个读数里，是为了让"余量不足"与"备份已经不新鲜"同时可见 ——
 *   那两个事实合起来才是"你的数据现在有风险"。
 *
 * ★ 参数用**默认值**而不是解构：这个读数由文件系统调用拼出来，缺一项是常态，
 *   而解构 `null` 会抛（上一轮在 `read-cache.mjs` 上正是这么栽过一次）。
 *
 * @param {{dbBytes, walBytes, freeBytes, totalBytes, backupAgeMs, nowMs}} input
 */
export function storageReport(input) {
  const src = (input === null || typeof input !== 'object') ? {} : input
  // ★ 全部走 `num()`（只认真正的数字）：`Number(null)`/`Number('')` 都是 0，
  //   而"备份年龄读不到"必须算**陈旧**，不能算成"0 毫秒前刚备过"。
  const dbBytes = num(src.dbBytes) ?? 0
  const walBytes = num(src.walBytes) ?? 0
  const freeBytes = num(src.freeBytes)
  const totalBytes = num(src.totalBytes)
  const backupAgeMs = num(src.backupAgeMs)
  const level = diskLevel({ freeBytes: freeBytes ?? undefined, dbBytes })
  const size = dbBytes + walBytes
  return {
    level,
    // ★ 报 `dbBytes` 与 `walBytes` **分开**：实测这台服务器上 WAL 曾比主库还大
    //   （1.1MB vs 4.2MB）—— 只看主库会严重低估真实占用。
    dbBytes,
    walBytes,
    // 真实占用 = 主库 + WAL（`-shm` 只有几十 KB，忽略）。
    totalUsedBytes: size,
    freeBytes,
    totalBytes,
    // "还需要多少才算安全" —— 比一个百分比更能让运维判断要清出多少。
    neededBytes: Math.max(0, Math.max(CRITICAL_MIN_FREE_BYTES, CRITICAL_HEADROOM_FACTOR * dbBytes) - (freeBytes ?? 0)),
    backupAgeMs,
    // 备份新鲜度：超过 48 小时算陈旧（`legion-hub-backup.timer` 是每天一次，
    // 所以 48 小时意味着**至少漏了一次**）。
    backupStale: backupAgeMs === null ? true : backupAgeMs > 48 * 60 * 60 * 1000,
  }
}

/**
 * 一句话结论（给运维看的）。**键 + 变量**，不拼句子。
 */
export function levelSummary(level) {
  if (level === 'critical') return { key: '存储余量危险：写入随时会失败，备份也已经做不成。', vars: {} }
  if (level === 'warn') return { key: '存储余量偏低：备份需要的空间快不够了。', vars: {} }
  if (level === 'unknown') return { key: '读不到存储余量 —— 这台 Hub 目前**没有**在监控它。', vars: {} }
  return { key: '存储余量充足。', vars: {} }
}

/**
 * `503` 上给的 `Retry-After`（秒）。
 *
 * ★ 这是一个**下限，不是承诺**：存储满不是"过 N 秒就好了"的时间性状况，
 *   它要等**人**去清空间。给这个数的目的是让规矩的客户端别**打夯**，
 *   而不是告诉它"等 120 秒一定成功"。
 *
 *   之所以还是给：一个不带 `Retry-After` 的 503 会让守规矩的客户端
 *   立刻重试（很多库的默认行为），而那正好发生在服务端最承受不住的时候。
 */
export const STORAGE_RETRY_AFTER_SEC = 120

/**
 * 把一个**原始**错误整形成"客户端该看到的形状"。
 *
 * ★ 为什么整形放在**错误诞生的地方**（`withTx` 的事务 catch）而不是逐个路由：
 *   26 个路由族共用 `handleWrite`，而各族**自己**还有 catch ——
 *   逐个改是 26 处，而其中任何一处漏掉就是"同一件事两个答案"。
 *
 *   整形之后，现有那些 `e.status ?? e.statusCode ?? 400` 与 `extra.code = e.code`
 *   的 catch **不需要改一行**就给出正确的状态码与错误码。
 *
 *   > 一处漏改的"逐个修"，与一处没写的"逐个修"，在代码评审里长得一模一样 ——
 *   > 区别只在事故当天才出现。
 *
 * @param {any} err
 * @returns {{status: number, code: string, message: string, kind: string, retryAfterSec: number}|null}
 *          `null` = 这不是存储问题，调用方保持原有行为
 */
export function storageErrorShape(err) {
  // ★ 幂等：嵌套事务会把错误包**两次**。第二层看到的是已经整过形的错误
  //   （它的 code 是 `STORAGE_UNAVAILABLE`、消息是中文），分类器认不出来 ——
  //   于是会返回 `null` 让它原样穿过。这正是想要的，但这里显式挡一下，
  //   免得将来有人往分类器里加了 `STORAGE_UNAVAILABLE` 而把消息翻成双份。
  if (err !== null && typeof err === 'object' && err.code === STORAGE_CODE) return null
  const c = classifyStorageError(err)
  if (c.storage !== true) return null
  return {
    status: STORAGE_STATUS,
    code: STORAGE_CODE,
    message: storageMessage({ kind: c.kind }),
    kind: c.kind,
    retryAfterSec: STORAGE_RETRY_AFTER_SEC,
  }
}
