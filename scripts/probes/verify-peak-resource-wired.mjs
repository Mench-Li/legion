/**
 * PRT-009 `peak-resource`：**那个读数有没有人在看**？
 *
 * ## 要证的是什么
 *
 * `product/launcher/peak-resource.mjs` 存在、有单测、并且**真的**接进了
 * `supervisor.mjs` 的 spawn / interval / exit 生命周期（默认 5s 一次，
 * win32 上每次 `execFileSync('powershell.exe', ...)`）。
 *
 * 但 `supervisor.peakResource()` 在**整个仓库里只出现一次**——它自己的定义。
 * 所以本脚本要回答的不是"采样器写得好不好"，而是一个更前面、也更致命的问题：
 *
 *   > **把那根线拔掉，有没有任何一条判据会红？**
 *
 * 如果答案是"没有"，那么"接好了"这个说法就没有证据支撑——
 * 它只是一个**读起来接好了**的接线。而这句话不是我的发明，
 * 是 `peak-resource.mjs` 自己的文件头（第 32～34 行）写下的：
 *
 *   > 所以"每个 Run 一个 DSH 子进程"是一个**读起来合理、实现里不存在**的对象——
 *   > 按它写采样器，会得到一个永远采不到东西、却看起来接好了的接线。
 *
 * ## 判据怎么定
 *
 * 一律用**变异**，不用阅读：
 *   ㊀ 让 `peakResource()` 恒返回 `null`（读数没了）
 *   ㊁ 让 `peakResource()` **整个方法消失**（连名字都没了）
 *   ㊂ 关掉采样定时器（`peakSampler.sample()` 不再被周期调用）
 *   ㊃ 返回值恒为"采样成功且为 0"（**0 是测量结论，不是"不知道"**）
 *
 * 对每个变异跑完整的 launcher 相关套件，要求它红。
 * 全绿 ⇒ 判据不覆盖这根线 ⇒ 这条接线**没有证据**。
 *
 * 跑完逐字节还原（用 Buffer 比对，不信任文本往返）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const SUP = 'product/launcher/supervisor.mjs'

const SUITES = [
  'product/launcher/supervisor.test.mjs',
  'product/launcher/launcher.test.mjs',
  'product/launcher/cli.test.mjs',
  'product/launcher/readiness.test.mjs',
]

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)

function runSuites() {
  try {
    const out = execFileSync(process.execPath, ['--test', ...SUITES], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    })
    return { failed: 0, out }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const m = /^ℹ fail (\d+)/m.exec(out)
    return { failed: m ? Number(m[1]) : -1, out }
  }
}

/** 从输出里挑出**红了的用例名**，用来判断"是这根线的判据红了"还是"别处崩了"。 */
function failingNames(out) {
  const names = []
  const re = /^✖ (.+?) \(\d/gm
  for (const m of out.matchAll(re)) names.push(m[1].trim())
  return [...new Set(names)]
}

const original = readFileSync(SUP)
const originalText = original.toString('utf8')

/**
 * ★ 行尾要归一，否则**每一条锚点都会落空**，而脚本只会说"源码变了？"——
 *   一个把"我的锚点写错了"报成"源码变了"的工具，会让人去查一个不存在的变更。
 *   （本仓工作树里 CRLF 与 LF 混着，git 每次都警告。）
 */
const EOL = originalText.includes('\r\n') ? '\r\n' : '\n'
const norm = (s) => s.split('\n').join(EOL)

console.log(`supervisor.mjs  sha=${sha(original)}  ${original.length} bytes  EOL=${EOL === '\r\n' ? 'CRLF' : 'LF'}`)
console.log('')

const base = runSuites()
console.log(`基线（未变异）：failed=${base.failed}`)
if (base.failed !== 0) {
  console.log('★ 基线就不是绿的——先修基线，本脚本证明不了任何事。')
  console.log(base.out.slice(-2500))
  process.exit(2)
}
console.log('')

const MUTATIONS = [
  {
    id: '㊀',
    what: '`peakResource()` **恒返回 `null`**（读数永远"不知道"）',
    why: '如果有人真在读它，这一定会红',
    find: `  function readPeakResource() {
    if (peakSampler !== null) return peakSampler.window()
    return lastPeakResource
  }`,
    replace: `  function readPeakResource() {
    return null
  }`,
  },
  {
    id: '㊁',
    what: '把 `peakResource` **从句柄上摘掉**（连名字都没了）',
    why: '`status().peakResource` 的判据会 TypeError',
    find: `    peakResource: readPeakResource,`,
    replace: '',
  },
  {
    id: '㊂',
    what: '**关掉周期采样**（`setInterval` 那一段不再 sample）',
    why: '采样器不再推进 ⇒ 窗口停在第 0 次；只有真读窗口的判据才会发现',
    find: `      if (peakSampler === null) return
      peakSampler.sample()
      lastPeakResource = peakSampler.window()`,
    replace: `      if (peakSampler === null) return
      // mutated: 不采样`,
  },
  {
    id: '㊃',
    what: '读数**恒为"采到了，是 0"**（把"不知道"写成测量结论）',
    why: '本模块文件头第 44～46 行明说这是禁止的形态：'
      + '「一个把"没采到"记成 0 的采样器，会让"这台机器很省内存"与"这台机器根本没采过"在基线上同形」',
    find: `  function readPeakResource() {
    if (peakSampler !== null) return peakSampler.window()
    return lastPeakResource
  }`,
    replace: `  function readPeakResource() {
    // mutated: 谎报一个成功的 0 读数
    return Object.freeze({ ok: true, pid: 1, samples: 1, lastCode: null,
      peakWorkingSetBytes: 0, peakRssBytes: 0, cpuMs: 0 })
  }`,
  },
  {
    id: '㊄',
    what: '**拔掉消费者**：退出时不再 `reportPeakResource()`',
    why: '★ 这正是本组要钉的那个洞：采样照采、读数照算，就是没人交出去',
    find: `    // PRT-009 \`peak-resource\`：这个时刻窗口才是终值，把它记下来。
    reportPeakResource()`,
    replace: `    // mutated: 不报`,
  },
  {
    id: '㊅',
    what: '把"采不到"渲染成 **0**（`describePeakResource` 失败分支照印读数）',
    why: '诚实边界必须长在渲染器里，否则消费者拿到的仍是一个看起来正常的 0',
    find: `  if (reading.ok !== true) {
    return \`\${head} 采不到（lastCode=\${reading.lastCode ?? '未知'}）：\`
      + '峰值内存与 CPU 都是 unknown——**不是 0**'
  }`,
    replace: `  if (reading.ok !== true) {
    // mutated: 把"不知道"渲染成测量结论
    return \`\${head} peakWorkingSet=0MiB peakRss=0MiB cpu=0ms\`
  }`,
  },
]

let bit = 0
const results = []
for (const m of MUTATIONS) {
  const find = norm(m.find)
  const replace = norm(m.replace)
  if (!originalText.includes(find)) {
    results.push({ ...m, verdict: '锚点没找到（源码变了？）' })
    continue
  }
  const mutated = originalText.replace(find, () => replace)
  writeFileSync(SUP, mutated)
  const r = runSuites()
  writeFileSync(SUP, original)
  const names = failingNames(r.out)
  if (r.failed > 0) bit++
  results.push({ ...m, verdict: r.failed > 0 ? `咬住（${r.failed} 条红）` : '**没咬住（全绿）**', names })
}

console.log('变异结果：')
for (const r of results) {
  console.log(`  ${r.id}  ${r.verdict.padEnd(20)} ${r.what}`)
  console.log(`       为什么该红：${r.why}`)
  for (const n of (r.names ?? []).slice(0, 4)) console.log(`         → ${n.slice(0, 100)}`)
  console.log('')
}

const restored = readFileSync(SUP)
console.log(`咬住 ${bit} / ${MUTATIONS.length}`)
console.log(`还原逐字节一致：${sha(restored) === sha(original) ? '是' : '否  ★★ 必须手工还原！'}`)
process.exit(bit === MUTATIONS.length ? 0 : 1)
