/**
 * 挂死的那一刻，**进程树里有什么**？
 *
 * ## 为什么问这个
 *
 * 上一批我把"偶发"量成了分布（双峰、约 50%），但**没找根因**。已知的读数：
 *   · 探针读数 8/8 轮都写出 ⇒ 活干完了；
 *   · 挂死那几轮宿主 stdout/stderr **全空** ⇒ 不是报错路径；
 *   · 不累积孤儿 ⇒ 不是"上一轮的残留拖住这一轮"。
 *
 * Node 进程"干完了却不退出"最常见的原因是**事件循环里还有活句柄**，
 * 而 `child_process` 是最常见的那一个：**带管道 stdio 的子进程会把父进程钉住**
 * （父进程要等那个管道关掉），除非 `unref()`。
 *
 * ⇒ 所以第一个要问的是：**宿主挂死时，它自己还有后代进程活着吗？**
 *   若有 ⇒ "父等在子进程上"这条解释立刻可测；
 *   若无 ⇒ 那条解释被否掉，得去看句柄/定时器。
 *
 * ## 方法
 *
 * 起一次真实的宿主（用本套件自己的夹具做法），在它**存活的每一秒**快照进程表，
 * 记录以宿主为根的整棵子树。挂死时最后一张快照就是答案。
 */
import { spawn, execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'

/** 快照：pid → {name, ppid, cmd} */
function snapshot() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    const arr = JSON.parse(out.trim() === '' ? '[]' : out)
    const list = Array.isArray(arr) ? arr : [arr]
    const map = new Map()
    for (const p of list) map.set(p.ProcessId, p)
    return map
  } catch (e) {
    return new Map()
  }
}

/** 以 root 为根，向下收集整棵子树（pid 集合）。 */
function subtree(map, root) {
  const kids = new Map()
  for (const [pid, p] of map) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, [])
    kids.get(p.ParentProcessId).push(pid)
  }
  const out = new Set([root])
  const queue = [root]
  while (queue.length) {
    const cur = queue.shift()
    for (const k of (kids.get(cur) ?? [])) { if (!out.has(k)) { out.add(k); queue.push(k) } }
  }
  return out
}

const budgetMs = Number(process.argv[2] ?? 20000)
const maxRounds = Number(process.argv[3] ?? 8)

/**
 * 跑一轮，返回 { hung, measure, lastTree, peak }。
 *
 * 之所以要**循环直到抓到挂死**：约 50% 的概率，单轮很可能撞上正常的那一半
 * ——而"正常那一半的进程树"对根因没有任何信息量。
 */
function oneRound() {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--test', FILE], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, CI: 'true', PRT509_HOST_TIMEOUT_MS: String(budgetMs) },
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d.toString() })
    child.stderr.on('data', (d) => { all += d.toString() })
    const testPid = child.pid
    const history = []
    const sampler = setInterval(() => {
      const map = snapshot()
      const tree = subtree(map, testPid)
      const rows = [...tree].map((pid) => {
        const p = map.get(pid)
        if (p === undefined) return null
        return {
          pid, ppid: p.ParentProcessId, name: p.Name,
          cmd: String(p.CommandLine ?? '').slice(0, 140),
        }
      }).filter(Boolean)
      history.push(rows)
    }, 700)
    child.on('exit', () => {
      clearInterval(sampler)
      const m = /MEASURE[^\n]*/.exec(all)
      res({
        hung: !/exit_code=0/.test(all),
        measure: m ? m[0].trim() : '(无 MEASURE 行)',
        history,
      })
    })
  })
}

function dumpTree(rows, label) {
  console.log(`\n${label}（子树 ${rows.length} 个进程）`)
  for (const r of rows) {
    console.log(`   pid ${String(r.pid).padStart(6)} ← ${String(r.ppid).padStart(6)}  ${r.name.padEnd(13)} ${r.cmd.slice(0, 96)}`)
  }
}

for (let round = 1; round <= maxRounds; round++) {
  console.log(`\n──────── 第 ${round} 轮 ────────`)
  const r = await oneRound()
  console.log(`结果：${r.hung ? '★ 挂死' : '正常退出'}   ${r.measure}`)
  if (!r.hung) { console.log('（正常轮，进程树无信息量，继续）'); continue }

  // ★ 抓到了。把最后三张快照都印出来，看挂死前那几秒在发生什么。
  const n = r.history.length
  for (const [i, rows] of r.history.slice(Math.max(0, n - 3)).entries()) {
    dumpTree(rows, `挂死前第 ${n - Math.min(3, n) + i + 1}/${n} 秒`)
  }
  const last = r.history[n - 1] ?? []
  const hosts = last.filter((x) => x.cmd.includes('bin.js'))
  const otherNodes = last.filter((x) => x.name === 'node.exe' && !x.cmd.includes('bin.js') && !x.cmd.includes('--test') && !x.cmd.includes('--use-largepages'))
  console.log('\n' + '='.repeat(78))
  console.log(`挂死时：宿主进程 ${hosts.length} 个；**额外的 node 进程** ${otherNodes.length} 个`)
  for (const o of otherNodes) console.log(`   ★ ${o.cmd.slice(0, 130)}`)
  console.log(`\n⇒ ${otherNodes.length > 0
    ? '挂死时**有额外的 node 后代**活着 ⇒ 「宿主等在后代上」这条解释成立（见下）'
    : '挂死时**没有**额外的 node 后代 ⇒ 「父等在后代上」**不成立**，要去看句柄/定时器'}`)
  break
}

