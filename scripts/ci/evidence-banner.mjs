#!/usr/bin/env node
/**
 * evidence-banner.mjs — P3-3 历史 evidence 治理：为证据快照目录写入统一元信息 banner。
 *
 * 背景：docs/ 下沉淀了数十个 T*-evidence / G-* 快照目录，其中不少仍写着旧测试数量、
 * 旧端口、旧构建命令。读者（含 AI worker）容易把历史快照当成当前状态依据。
 *
 * 本脚本为每个证据快照目录写入**幂等** banner（含生成日期 + 基线 commit + 当前状态入口），
 * 并支持 --check 供 CI 校验覆盖完整性。
 *
 * 认定规则：docs/ 下（递归）目录名匹配 /^G-/ 或 /-evidence$/ 即视为证据快照目录。
 * 落点规则：目录内**所有顶层 .md** 都加 banner（读者常从具体文档直接链入，只标 README
 *   不足以防误用）；目录内无 .md 时创建 README.md 作为入口（banner + 说明）。
 *
 * 基线信息取自该目录**首次被加入 git** 的提交（--diff-filter=A），即证据产生时的基线；
 * banner 自身提交是修改而非新增，重复运行不会改变已写入的基线。
 *
 * 用法：
 *   node scripts/ci/evidence-banner.mjs              # 写入/补齐 banner（幂等）
 *   node scripts/ci/evidence-banner.mjs --check      # 只校验，缺 banner 则 exit 1
 *   node scripts/ci/evidence-banner.mjs --dry-run    # 只打印将处理的目录
 *   node scripts/ci/evidence-banner.mjs --help
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS = join(ROOT, 'docs')

const START = '<!-- evidence-banner:start -->'
const END = '<!-- evidence-banner:end -->'
const SNAPSHOT_DIR_RE = /^(G-.+|-?.*evidence)$/

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const DRY = args.includes('--dry-run')
const FORCE = args.includes('--force')

if (args.includes('--help')) {
  console.log('evidence-banner.mjs — 为 docs/ 下证据快照目录写入/校验统一历史快照 banner')
  console.log('')
  console.log('认定：目录名匹配 /^G-/ 或 /-evidence$/（递归 docs/）')
  console.log('落点：README.md 优先；单文档目录用该文档；多文档/空目录建 README.md')
  console.log('')
  console.log('用法：')
  console.log('  node scripts/ci/evidence-banner.mjs            # 写入/补齐（幂等）')
  console.log('  node scripts/ci/evidence-banner.mjs --check    # 校验覆盖（缺失 exit 1）')
  console.log('  node scripts/ci/evidence-banner.mjs --dry-run  # 预览')
  console.log('  node scripts/ci/evidence-banner.mjs --force    # 重写已有 banner（模板变更后使用）')
  process.exit(0)
}

/** 递归收集证据快照目录（相对 ROOT 的 posix 路径）。 */
function collectDirs(abs, out = []) {
  let entries = []
  try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const child = join(abs, e.name)
    if (SNAPSHOT_DIR_RE.test(e.name)) out.push(child)
    collectDirs(child, out)
  }
  return out
}

/** 目录首次入库信息：最早的「新增该路径」提交。 */
function firstCommit(absDir) {
  try {
    const rel = absDir.slice(ROOT.length + 1).split('\\').join('/')
    const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%h|%ad', '--date=short', '--', rel], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!out) return null
    const last = out.split('\n').filter(Boolean).pop() // git log 倒序 → 末行是最早
    const [hash, date] = last.split('|')
    return { hash, date }
  } catch {
    return null
  }
}

function bannerFor(absDir) {
  const c = firstCommit(absDir)
  const baseline = c ? `**${c.date}**（commit \`${c.hash}\`）` : '**未入库**（目录尚未提交）'
  return [
    START,
    `> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 ${baseline} 的基线，其中的测试数量、端口、命令与结论只代表当时状态。`,
    '> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。',
    END,
    '',
    '',
  ].join('\n')
}

/** 用最新 banner 替换已有 banner 块（--force 重写用）。 */
function replaceBanner(body, banner) {
  return banner + body.replace(/<!-- evidence-banner:start -->[\s\S]*?<!-- evidence-banner:end -->\n*/, '')
}

function mdFiles(absDir) {
  try {
    return readdirSync(absDir).filter((f) => f.toLowerCase().endsWith('.md') && statSync(join(absDir, f)).isFile())
  } catch { return [] }
}

const results = { written: [], created: [], already: [], missing: [], skipped: [] }

for (const absDir of collectDirs(DOCS)) {
  const rel = absDir.slice(ROOT.length + 1).split('\\').join('/')
  const mds = mdFiles(absDir)

  // 目录内无 md → 建 README.md 作为入口（banner + 说明）；否则目录内所有顶层 md 都标注。
  const targets = mds.length > 0 ? mds.map((f) => ({ file: join(absDir, f), name: f, create: false }))
    : [{ file: join(absDir, 'README.md'), name: 'README.md', create: true }]

  const pending = []
  for (const t of targets) {
    const body = existsSync(t.file) ? readFileSync(t.file, 'utf8') : ''
    if (!body.includes(START) || FORCE) pending.push(t)
  }

  if (CHECK) {
    if (pending.length === 0) results.already.push(rel)
    else results.missing.push(rel + '（' + pending.length + '/' + targets.length + ' 缺 banner）')
    continue
  }
  if (pending.length === 0) { results.already.push(rel); continue }
  if (DRY) { results.written.push(rel + ' → ' + pending.length + ' 个文件' + (pending[0].create ? '（新建 README.md）' : '')); continue }

  const banner = bannerFor(absDir)
  for (const t of pending) {
    if (t.create) {
      writeFileSync(t.file, banner + '# ' + rel.split('/').pop() + ' 证据快照\n\n本目录为遗留证据目录，当前无文档。\n', 'utf8')
      results.created.push(rel)
    } else {
      const body = readFileSync(t.file, 'utf8')
      writeFileSync(t.file, body.includes(START) ? replaceBanner(body, banner) : banner + body, 'utf8')
      results.written.push(rel + '/' + t.name)
    }
  }
}

if (CHECK) {
  if (results.missing.length > 0) {
    for (const m of results.missing) console.error('FAIL: docs/' + m.slice(4) + ' — 缺少历史快照 banner（运行 node scripts/ci/evidence-banner.mjs）')
    console.log('evidence-banner: FAIL（' + results.missing.length + ' 个目录缺 banner / 已覆盖 ' + results.already.length + '）')
    process.exit(1)
  }
  console.log('evidence-banner: PASS（' + results.already.length + ' 个证据快照目录的文档均已标注历史 banner）')
  process.exit(0)
}

const verb = DRY ? '将处理' : '已处理'
console.log('evidence-banner: ' + verb + ' 新增标注=' + results.written.length + ' 新建 README=' + results.created.length + ' 已存在=' + results.already.length + (DRY ? '（dry-run）' : ''))
for (const r of results.created) console.log('  + README.md  ' + r)
for (const r of results.written) console.log('  ~ banner     ' + r)
