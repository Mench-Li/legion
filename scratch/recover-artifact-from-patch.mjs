/**
 * recover-artifact-from-patch.mjs — 从 team-hub 任务的 patch 记录里恢复产出文件全文。
 *
 * 场景：任务停在软门禁（in_review）未合入主分支，其后 worktree/分支被清理或仓库被重置，
 * 磁盘上已无该文件，但 hub 的 patch.diff 仍保存全文（新增文件的整段 diff）→ 可逐字恢复。
 *
 * 用法：
 *   node scratch/recover-artifact-from-patch.mjs <taskId> <仓库相对路径> [--out <文件>] [--write <目标根>] [--commit <信息>]
 * 例（干跑到 stdout）：
 *   node scratch/recover-artifact-from-patch.mjs T-141 docs/G-mtwxs5no-1/PLAN.md --out scratch/t141-PLAN.md
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HUB = process.env.HUB_URL || 'http://127.0.0.1:8787'
const [taskId, relPath, ...rest] = process.argv.slice(2)
if (!taskId || !relPath) {
  console.error('用法: node scratch/recover-artifact-from-patch.mjs <taskId> <仓库相对路径> [--out <文件>]')
  process.exit(2)
}
const argOf = (name) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}

const task = await (await fetch(`${HUB}/api/task?id=${encodeURIComponent(taskId)}`)).json()
const want = relPath.replace(/\\/g, '/')

/** 在一个 patch.diff 里取目标文件的全文（新增/修改文件均按 hunk 逐行重建）。 */
function extractFromDiff(diff, target) {
  const sections = diff.split(/^diff --git /m).slice(1)
  for (const sec of sections) {
    const header = sec.split('\n')[0]
    if (!header.includes(` b/${target}`)) continue
    const lines = sec.split('\n')
    const out = []
    let inHunk = false
    for (const line of lines) {
      if (line.startsWith('@@')) { inHunk = true; continue }
      if (!inHunk) continue
      if (line.startsWith('\\ No newline')) continue
      if (line.startsWith('+')) out.push(line.slice(1))
      // 本工具只面向「新增文件」恢复：删除/上下文行不参与（缺失会体现在行数校验上）
    }
    return { content: out.join('\n') + '\n', lines: out.length, header }
  }
  return null
}

let found = null
for (const p of task.patches ?? []) {
  const file = (p.files ?? []).find(f => String(f.path).replace(/\\/g, '/') === want)
  if (!file) continue
  const got = extractFromDiff(String(p.diff ?? ''), want)
  if (got) { found = { ...got, file, at: p.at, by: p.by }; break }
}
if (!found) {
  console.error(`未在该任务的 patch 记录中找到 ${want} 的全文 diff`)
  process.exit(1)
}

// 校验：diff 声明的新增行数必须与实际重建行数一致（防止截断/解析偏差）
const ok = found.file.add === found.lines
console.log(JSON.stringify({
  task: taskId, path: want, declaredAdd: found.file.add, recoveredLines: found.lines,
  byteLength: Buffer.byteLength(found.content, 'utf8'), consistent: ok,
  firstLine: found.content.split('\n')[0], lastLine: found.content.trimEnd().split('\n').slice(-1)[0],
}, null, 2))
if (!ok) { console.error('行数不一致——拒绝写出（避免恢复出被截断的文件）'); process.exit(1) }

const out = argOf('--out')
if (out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, found.content, 'utf8')
  console.log(`已写出：${out}`)
}
const writeRoot = argOf('--write')
if (writeRoot) {
  const dest = join(writeRoot, want)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, found.content, 'utf8')
  console.log(`已恢复到仓库：${dest}`)
}
if (!out && !writeRoot) console.log('（未指定 --out/--write：仅校验，未写文件）')
