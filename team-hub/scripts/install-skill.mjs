#!/usr/bin/env node
// team-hub/scripts/install-skill.mjs
// ============================================================================
// ★ PRT-406：**运维安装**技能 / 文档的写入口（本机 CLI）
//
// ## 为什么这个脚本存在
//
// `PRT-406` 的进度行里写着一条未交付：
//
//   > 没有产品侧调用点去传 `skillTrust`/`documentTrust`，
//   > **运维安装的 skill 目前也被当外部内容**。这是保守的一侧，但是个真缺口。
//
// 保守的一侧不假——可它是靠**根本没有"运维安装"这条路**换来的：
// `origin` 这个字段此前不存在，于是"系统内容"与"外部内容"在数据上
// **本来就分不开**，谁也没法传一个区分的值上去。
//
//   > 一个"因为分不开所以一律按外部内容处理"的系统，
//   > 与一个"压根没打算区分"的系统，在每一条内容都来自成员时是同一个东西——
//   > 只不过前者会让那个缺口看起来像一次**安全取舍**。
//
// ---------------------------------------------------------------------------
// ## 为什么是 CLI 而不是一条路由
//
// "运维安装"这件事的真实边界是**文件系统**，不是 HTTP token。
// 做成路由的话，任何拿得到 token 的成员都能调用它：
//
//     成员 → POST /api/skills/install → origin: 'operator' → 系统内容
//
// 于是"运维安装"这个名字就成了一句谁都能说的话，而它正是"系统内容"的
// **唯一依据**。
//
//   > 一个"任何 token 持有者都能说自己是在安装系统内容"的入口，
//   > 与一个"系统内容由部署者写入"的入口，在没人滥用的时候是同一个东西——
//   > 只不过前者会让"系统内容"这个身份，变成一句**客户端自己填的声明**。
//
// 所以边界落在文件系统上：能跑这个脚本的人，本来就能直接改数据库。
//
// ## 用法
//
//   node team-hub/scripts/install-skill.mjs --skill <file.json>
//   node team-hub/scripts/install-skill.mjs --document <file.json>
//
// 文件形状（skill）：
//   { "id": "release-checklist", "name": "发布检查单", "scope": "software",
//     "description": "…", "main": "……正文……" }
//
// 文件形状（document）：
//   { "id": "coding-standards", "title": "编码规范", "scope": "software",
//     "path": "docs/CODING.md", "body": "……正文……" }
//
// **不读 stdin、不读环境变量传正文**：正文只能来自文件，因为要写进审计的
// 是"装了什么"，而一个从管道来的字符串没有可复核的来源。
// ============================================================================
import { readFileSync } from 'node:fs'
import { installSkill, installDocument } from '../server.mjs'

const USAGE = `用法：
  node team-hub/scripts/install-skill.mjs --skill <file.json>
  node team-hub/scripts/install-skill.mjs --document <file.json>

装进来的东西 origin='operator'（上下文侧按**系统内容**处理），
skill 直接 published、文档登记即生效。走 HTTP 的登记一律 origin='member'。`

function parseArgs(argv) {
  const out = { skill: null, document: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--skill') out.skill = argv[++i] ?? null
    else if (a === '--document') out.document = argv[++i] ?? null
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

/** 读一个 JSON 文件。错误里带上**文件路径**——否则排障只能靠猜是哪一个。 */
function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`读不到 ${file}：${e instanceof Error ? e.message : e}`)
  }
  // ★ BOM 要**显式报错**，不静默剥离：带 BOM 的文件多半是被人用
  //   "记事本/PS 5.1 Set-Content -Encoding UTF8" 存出来的，
  //   而那意味着**这个文件曾被别的工具改过**——静默吃掉 BOM 会把这个信号抹掉。
  if (text.charCodeAt(0) === 0xFEFF) {
    throw new Error(`${file} 带 UTF-8 BOM（多半是记事本或 PowerShell 存的）——`
      + '请去掉 BOM 再装：本脚本不静默剥离，因为 BOM 意味着这个文件被别的工具改过。')
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${e instanceof Error ? e.message : e}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(USAGE + '\n'); return 0 }
  if (args.skill === null && args.document === null) {
    process.stderr.write(USAGE + '\n')
    return 2
  }
  if (args.skill !== null && args.document !== null) {
    // 一次只装一件：两件一起装时，"第二件失败了"会让第一件的状态不明。
    process.stderr.write('一次只能装一件（--skill 或 --document），不要同时给。\n')
    return 2
  }

  if (args.skill !== null) {
    const input = readJson(args.skill)
    const s = installSkill(input)
    process.stdout.write(`✅ 已安装技能 ${s.id}（origin=${s.origin} status=${s.status} version=${s.version} scope=${s.scope}）\n`)
    return 0
  }

  const input = readJson(args.document)
  const d = installDocument(input)
  process.stdout.write(`✅ 已安装文档 ${d.id}（origin=${d.origin} version=${d.version} scope=${d.scope} sha256=${String(d.sha256).slice(0, 12)}）\n`)
  return 0
}

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    process.stderr.write(`✖ ${e instanceof Error ? e.message : e}\n`)
    process.exitCode = 1
  })
