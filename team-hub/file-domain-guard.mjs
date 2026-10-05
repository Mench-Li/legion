/**
 * team-hub/file-domain-guard.mjs — 建任务时的**文件域可交付性**护栏（BUG-009-a）。
 *
 * 现场（T-179）：一条切片的 `fileDomain` 声明成 `["scratch/"]`，而 `scratch/` 在 `.gitignore` 里。
 * worker 老老实实干完了（23KB 的逐套件判定报告），却**永远交付不了**：分支提交数 0、
 * `git status` 干净、闸门那边还会因为"越域文件"报一堆主分支新增的文件。
 * 一条 5 小时的活，产出烂在一个被忽略的目录里。报告作者自己也发现了，在正文里写：
 * "允许写入只有 scratch/，本文件即交付物"。
 *
 * 这类配置**在派工那一刻就能判定**，所以护栏放在这里而不是事后。
 *
 * 两条设计约束：
 *   ① **不猜 gitignore 语义**：判断"这个路径是否被忽略"必须问 git（`git check-ignore`）——
 *      嵌套 .gitignore、取反规则（`!`）、目录通配都不是自己重写一遍能对的东西。所以本模块
 *      只做**纯决策**，"哪些条目被忽略"由调用方用真实 git 探出来传进来（见 ignoredFileDomainEntries）。
 *   ② **基础设施失败一律放行**：仓库没绑定、git 不可用、命令超时 —— 这些时候我们**不知道**域是否可交付，
 *      而"不知道"不该拦住建任务（一个因为探不到 git 就建不了任务的闸门，比它要防的问题更坏）。
 *      所以探测失败返回 `null`，调用方据此跳过校验。
 */

/**
 * 纯决策：给定声明的域与"其中被 git 忽略的条目"，判断它是否可交付。
 *
 * @param {string[]|null|undefined} domain 声明的文件域（原样，字符串数组）
 * @param {string[]|null} ignoredEntries 被 git 忽略的条目（`null` = 探测失败/不可知）
 * @returns {{ ok: boolean, code: string, ignored: string[], message: string }}
 *   code ∈ NO_DOMAIN | UNKNOWN | DOMAIN_OK | DOMAIN_PARTLY_IGNORED | DOMAIN_ALL_IGNORED
 */
export function judgeFileDomain(domain, ignoredEntries) {
  const entries = (Array.isArray(domain) ? domain : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0)
  if (entries.length === 0) return { ok: true, code: 'NO_DOMAIN', ignored: [], message: '' }
  // 探测失败 ⇒ 不可知 ⇒ 放行（理由见文件头约束②）。
  if (!Array.isArray(ignoredEntries)) return { ok: true, code: 'UNKNOWN', ignored: [], message: '' }
  const ignored = entries.filter((e) => ignoredEntries.includes(e))
  if (ignored.length === entries.length) {
    return {
      ok: false,
      code: 'DOMAIN_ALL_IGNORED',
      ignored,
      message: `声明的文件域全部被 .gitignore 忽略（${ignored.join(', ')}）—— 这样的切片**交付不了**：`
        + `它的产出不会进版本库，分支永远 0 提交（实测 T-179：干完 5 小时、报告烂在 scratch/ 里）。`
        + `请把域改到被跟踪的路径（如 docs/、或对应代码目录）。`,
    }
  }
  if (ignored.length > 0) {
    return {
      ok: true,
      code: 'DOMAIN_PARTLY_IGNORED',
      ignored,
      message: `文件域里有被 .gitignore 忽略的条目（${ignored.join(', ')}）——`
        + `这部分产出不会进版本库；若那是刻意的（临时工作区），请确保交付物写在其它的域条目里。`,
    }
  }
  return { ok: true, code: 'DOMAIN_OK', ignored: [], message: '' }
}

/**
 * 用真实 git 探出「域条目里哪些被忽略」。
 *
 * @param {(args: string[], cwd: string) => { status: number|null, error: string|null }} runGit
 *   注入式 git 调用器 —— **形状对齐 `team-hub/git-plumbing.mjs` 的 `runGit`**
 *   （`{ status, error, stdout, stderr, ok }`；本模块只用 status/error）。
 * @param {string} repoDir 该空间绑定的本地仓库目录
 * @param {string[]} entries 域名目
 * @returns {string[]|null} 被忽略的条目；**探测失败返回 null**（调用方据此跳过校验，不拦人）
 */
export function ignoredFileDomainEntries(runGit, repoDir, entries) {
  if (typeof repoDir !== 'string' || repoDir.length === 0) return null
  if (!Array.isArray(entries) || entries.length === 0) return []
  try {
    // `git check-ignore -q <path>` 的退出码：0 = 被忽略，1 = 未被忽略，其它 = 出错。
    // 逐个问而不是一次问多个：一次传多个路径时，只要有一个没被忽略退出码就不同，
    // 解析 stdout 比逐个问更容易出错；域条目通常只有个位数。
    const ignored = []
    let sawError = false
    for (const entry of entries) {
      const r = runGit(['check-ignore', '--quiet', '--', entry], repoDir)
      if (r?.error) { sawError = true; continue }
      if (r?.status === 0) ignored.push(entry)
      else if (r?.status !== 1) sawError = true
    }
    // 有任何一个条目**问不出结果**（不是"未忽略"，是命令本身出错）⇒ 整体视为不可知。
    if (sawError) return null
    return ignored
  } catch {
    return null
  }
}
