// desktop/scripts/payload-filter.mjs
// ============================================================================
// 「这个文件能不能进安装包」——把 `stage.mjs` 里那段内联判据抽出来，让它**可判**。
//
// ## 为什么要有这个文件
//
// `stage.mjs` 的清单来自 `git ls-files` **加上未跟踪文件**（`--others
// --exclude-standard`）。"未跟踪"的意思是"`.gitignore` 没盖住它"——而那不是
// "它该被发给用户"。这两件事之间的缝，就是下面这个差点出的事：
//
//   2026-10-07 实测：工作区里躺着三个 `team-hub/team.db.bak-*`（各 33.9 MB，
//   各 82 张表的完整库副本）。`team-hub/.gitignore` 写的是 `*.db`——
//   它盖住了 `team.db`，**盖不住** `team.db.bak-t177-file-domain`
//   （那个名字末尾不是 `.db`）。于是它们以"未跟踪文件"的身份通过了
//   `--exclude-standard`，而 `stage.mjs` 当时对生产根下的未跟踪文件**没有任何
//   数据库或备份排除** —— 会把它们原样拷进 `resources/legion/team-hub/`，
//   再打进那个**给所有人下载**的安装包。
//
//   > 一份"没被 `.gitignore` 盖住"的文件，
//   > 与一份"该发给用户"的文件，在构建脚本眼里原本长得一模一样 ——
//   > 而 `.gitignore` 管的是"要不要进版本库"，从来不是"要不要给外人"。
//
// ## 为什么是白名单式的"绝不发出"，而不是补一条 `.gitignore`
//
// 补 `.gitignore` 只挡住**这一个名字**：换一次备份工具的命名（`team.db-2026-10-07`、
// `team.db.copy`、`backup.db`）就再漏一次。而构建脚本是最后一道闸，
// 它该守的是**类别**：数据库文件与备份**永远不属于安装包**，与它们叫什么无关。
//
// ## 边界（诚实说明）
//
// 这是一张**形状**清单，不是内容扫描：它认扩展名与文件名，不打开文件看。
// 一个被改名成 `notes.txt` 的数据库仍然会漏过去。它挡的是"顺手的产物"，
// 不是"有人刻意把凭据塞进包里"——后者需要的是发布前的审计，不是过滤器。
// ============================================================================

/** 数据库本体与它们的运行期附属文件（SQLite 的 `-wal` / `-shm` 与库同等敏感）。 */
const DATABASE_EXTENSIONS = Object.freeze([
  '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3',
])

/**
 * 备份的命名形状。
 *
 * `team.db.bak-t177-file-domain` 末尾不是 `.db`，所以上面那条按扩展名的判据
 * 抓不住它 —— 这条按**段**匹配（`.bak` 出现在路径任一层次里即算）。
 */
const BACKUP_SEGMENT = Object.freeze([
  '.bak', '.bak-', '.backup', '.old', '.orig', '.save', '.copy',
])

/** 会被当作"人写的源码/文档"的扩展名。段里出现 `.db` 但它落在这些扩展名上时**放行**。 */
const SOURCE_EXTENSIONS = Object.freeze([
  '.mjs', '.js', '.cjs', '.ts', '.tsx', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml',
])

/**
 * 判断一个仓库相对路径能不能进安装包。
 *
 * @param {string} path 仓库相对路径，正斜杠分隔
 * @returns {boolean} true = 可以发出去
 */
export function isShippablePayloadFile(path) {
  const p = String(path).split('\\').join('/')
  if (p.length === 0) return false
  const lower = p.toLowerCase()
  const segments = lower.split('/')

  // ① 按扩展名：数据库本体与附属文件。SQLite 的 `-wal` 里可能还有未落盘的记录，
  //    只挡 `.db` 而放过 `-wal` 等于没挡。
  for (const ext of DATABASE_EXTENSIONS) {
    if (lower.endsWith(ext)) return false
  }

  // ② 按段：备份的命名形状。`.bak` 出现在任一层次即算 ——
  //    `team.db.bak-t177-file-domain` 末尾不是 `.db`，上面那条抓不住它。
  for (const s of segments) {
    for (const mark of BACKUP_SEGMENT) {
      if (s.includes(mark)) return false
    }
  }

  // ③ 兜底：段里出现 `.db`（或 `.sqlite`），且它后面**不是源码扩展名** —— 按数据库处理。
  //    这一条捞的是"数据库名在中间"的形状：`team.db-2026-10-07`（日期后缀）、
  //    `team.db.bak-*`、`backup.db.copy`。
  //
  //    ★ 为什么要用"不是源码扩展名"来**放行**而不是一律挡下：
  //      一个 `x.db-helper.mjs` 是源码，不是数据库。把判据做成"见到 .db 就挡"，
  //      会让某个无辜的源码文件从包里消失 —— 而那种失败在安装包上表现为
  //      "启动时某个 import 找不到"，排查成本远高于在这里多写一行。
  //
  //   > 一张"宁可错杀"的清单，与一张"漏掉真东西"的清单，
  //   > 在构建产物上不是同一种坏法：后者泄露数据，前者制造故障。
  //   > 所以这里两个方向都收紧，代价是多一个 SOURCE_EXTENSIONS 常量。
  const isSourceName = SOURCE_EXTENSIONS.some((e) => lower.endsWith(e))
  if (!isSourceName) {
    for (const s of segments) {
      for (const marker of ['.db', '.sqlite', '.sqlite3']) {
        const i = s.indexOf(marker)
        if (i < 0) continue
        const next = s[i + marker.length]
        if (next === undefined || next === '.' || next === '-') return false
      }
    }
  }
  return true
}
