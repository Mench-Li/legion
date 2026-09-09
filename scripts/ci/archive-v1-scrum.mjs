// scripts/ci/archive-v1-scrum.mjs — P1-1 第 2 步：v1 文件库退役归档（只读备份，绝不丢数据）。
//
// 背景：生产任务执行已在 team-hub v2（team-hub/team.db SQLite）；scrum/tasks.json 是
// v1 陈年历史文件库（T-001..008，多为 done/canceled），serve.mjs :4820 已停止托管。
// 归档动作 = 把 v1 数据文件移到 scrum/archive/（时间戳后缀），原地留 .archived 说明。
//
// 运行：node scripts/ci/archive-v1-scrum.mjs [--scrum <dir>] [--force]
//   --force  跳过「4820 端口已关闭 + tasks.json 无近期写入」前置检查（非交互/演练用）。
//   前置检查失败会打印原因并 exit 2（不归档）。
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRUM = process.argv.includes('--scrum') ? process.argv[process.argv.indexOf('--scrum') + 1] : join(REPO, 'scrum')
const FORCE = process.argv.includes('--force')

const V1_FILES = ['tasks.json', 'activity.jsonl', 'board.json', 'kanban.html', 'KANBAN.md']
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

function tcpOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    const done = (ok) => { try { sock.destroy() } catch { /* ignore */ } resolve(ok) }
    sock.setTimeout(500)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

async function preflight() {
  const problems = []
  // 1) 4820 不得仍在监听（v1 serve.mjs 会写 tasks.json）
  if (await tcpOpen(4820)) problems.push('4820 仍在监听（v1 serve.mjs 未停）——先重启宿主使 services-plugin 退役行生效')
  // 2) tasks.json 若存在，最近修改不得晚于启动检查（避免归档进行中仍被写）
  const tasksFile = join(SCRUM, 'tasks.json')
  if (existsSync(tasksFile)) {
    const ageMs = Date.now() - statSync(tasksFile).mtimeMs
    if (ageMs < 60 * 1000) problems.push('tasks.json 近 60s 内被修改过——可能有活跃写者，先停写源')
  }
  return problems
}

async function main() {
  console.log(`v1 文件库归档：scrum=${SCRUM}`)
  if (!FORCE) {
    const problems = await preflight()
    if (problems.length > 0) {
      console.error('✗ 前置检查未通过：\n  - ' + problems.join('\n  - '))
      console.error('（确认无误后可加 --force 跳过；不会删除任何数据，仅移动 + 留备份说明）')
      process.exit(2)
    }
  }
  const archiveDir = join(SCRUM, 'archive', 'v1-' + stamp)
  mkdirSync(archiveDir, { recursive: true })
  let moved = 0
  for (const f of V1_FILES) {
    const src = join(SCRUM, f)
    if (existsSync(src)) {
      renameSync(src, join(archiveDir, f))
      moved += 1
    }
  }
  // 原地说明（占位，避免后续逻辑误以为库空需要重建）
  writeFileSync(
    join(SCRUM, 'tasks.json.archived'),
    `v1 文件库已于 ${new Date().toISOString()} 退役归档 → archive/v1-${stamp}/\n` +
    '权威任务池 = team-hub v2（team-hub/team.db）。本说明文件可安全删除。\n',
    'utf8',
  )
  console.log(`✓ 已归档 ${moved} 个 v1 数据文件 → ${archiveDir}`)
  console.log('（scrum/tasks.json.archived 占位已写；serve.mjs/taskctl.mjs/render.mjs 源码保留供测试与本地使用）')
}

main().catch((e) => { console.error('归档失败：' + (e instanceof Error ? e.message : String(e))); process.exit(1) })
