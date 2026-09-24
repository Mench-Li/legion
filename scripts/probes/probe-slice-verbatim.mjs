#!/usr/bin/env node
// scripts/probes/probe-slice-verbatim.mjs
// ============================================================================
// 量具：PRT-1007「编排提取」每一片的**逐字对拍**
//
// 用法：
//   node scripts/probes/probe-slice-verbatim.mjs            # 全部片，人读
//   node scripts/probes/probe-slice-verbatim.mjs --json     # 机器读
//   退出码：0 = 四问全过；1 = 有片不合格（并逐条打印为什么）
//
// ## 为什么需要它（这是本仓"逐片迁移"那一族的**判据**）
//
// `docs/review/PRT-PRE-REFACTOR-CANDIDATES.md:140` 给的入口是
// 「**一个切片一次对拍**」。而"对拍"这个词在本仓此前**没有量具**——
// 代码搬过家之后，"新位置那份与旧位置那份逐字相同"只能靠人眼看 diff。
//
// > 一次搬家最危险的失效不是"编译不过"（那会红），而是
// > **搬完之后两边都留着一份**、或**新那份被顺手改了两个字**——
// > 两者都能通过测试，而"行为零变化"这句话从此没有依据。
//
// ## 四问（每一片都要全过）
//
//   ① **逐字**：搬走的每个符号，在目标模块里的文本与**旧位置**逐字相同；
//   ② **不留实现**：旧位置只剩路标注释，不许同时留着实现（否则两份实现会各自漂移）；
//   ③ **公开面**：搬走的每个符号都由 `index.ts` 从目标模块**再导出**
//      （消费者从 `lib/index.js` import，一条都不用改）；
//   ④ **登记**：片登记表里的每一片，新模块文件必须存在。
//
// ⚠️ 诚实边界：本量具证明的是**文本搬运的保真**，它**不**证明"跑起来一样"——
//    后者要 `cd plugins && npm test`（先 build 再跑 38 个套件），
//    而 build 需要 DSH 检出里有 `packages/preset/agent-presets` **且**本机有 typescript；
//    本机当前**两样都缺**（见台账 §10.7）。所以这一条是"可复跑但当前不可跑"的判据，
//    量具把这件事**印出来**而不是假装它跑过了。
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

/**
 * 片登记表。加一片 = 加一行（`from` 是搬走那一刻的提交或 `HEAD`，
 * `fromFile` 是旧位置，`toFile` 是新模块，`names` 是搬走的符号）。
 */
export const SLICES = [
  {
    id: 'PRT-1007/1',
    title: '岗位文档契约纯函数',
    from: 'HEAD',
    fromFile: 'plugins/src/index.ts',
    toFile: 'plugins/src/docContract.ts',
    names: [
      'stageContractDocs',
      'resolveStageDocPaths',
      'resolveStageDocPathsWithDocSync',
      'fileDigest',
      'resolveDiscussion',
      'stagesFromHubPayload',
    ],
  },
]

/** 从源码文本里取一个函数/接口的**完整文本**（`export function NAME(` 或 `export interface NAME {` 到配对的收尾花括号）。 */
export function extractSymbol(text, name) {
  const nl = text.replace(/\r\n/g, '\n')
  for (const head of [`export function ${name}(`, `export interface ${name} {`, `function ${name}(`]) {
    const at = nl.indexOf(head)
    if (at < 0) continue
    // 从 head 里第一个 `{` 开始按花括号配对找收尾。
    const open = nl.indexOf('{', at)
    if (open < 0) continue
    let depth = 0
    for (let i = open; i < nl.length; i += 1) {
      const c = nl[i]
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) return nl.slice(at, i + 1)
      }
    }
  }
  return null
}

/** 旧版本的源码文本（`from` 可以是 `HEAD` 或任意提交）。 */
export function oldSource(from, file) {
  return execFileSync('git', ['show', `${from}:${file}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** 逐片对拍。返回 { slices: [{ id, ok, problems: [] }], ok } */
export function checkSlices({ slices = SLICES, repo = REPO } = {}) {
  const out = []
  for (const s of slices) {
    const problems = []
    const toPath = resolve(repo, s.toFile)
    if (!existsSync(toPath)) {
      problems.push(`④ 新模块不存在：${s.toFile}`)
      out.push({ id: s.id, title: s.title, ok: false, problems })
      continue
    }
    const now = readFileSync(toPath, 'utf8').replace(/\r\n/g, '\n')
    const old = oldSource(s.from, s.fromFile).replace(/\r\n/g, '\n')
    const nowIndex = readFileSync(resolve(repo, s.fromFile), 'utf8').replace(/\r\n/g, '\n')

    for (const name of s.names) {
      const a = extractSymbol(old, name)
      const b = extractSymbol(now, name)
      if (a === null) { problems.push(`① 旧位置（${s.from}:${s.fromFile}）里找不到 ${name}`); continue }
      if (b === null) { problems.push(`① 新模块（${s.toFile}）里找不到 ${name}`); continue }
      if (a !== b) {
        // 指出第一处不同，方便直接看
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i += 1
        const line = a.slice(0, i).split('\n').length
        problems.push(`① ${name} 与旧位置**不逐字相同**（旧 ${a.length} 字 / 新 ${b.length} 字，第一处不同在函数内第 ${line} 行）`)
      }
      // ② 旧位置不许同时留着实现
      if (new RegExp(`(^|\\n)\\s*(export )?function ${name}\\(`).test(nowIndex)) {
        problems.push(`② 旧位置（${s.fromFile}）里**还留着** ${name} 的实现`)
      }
      // ③ 公开面：必须被再导出，且再导出来自目标模块
      const re = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'\\./${s.toFile.split('/').pop().replace(/\.ts$/, '')}\\.js'`, 's')
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'\\./${s.toFile.split('/').pop().replace(/\.ts$/, '')}\\.js'`, 's')
      if (!re.test(nowIndex)) problems.push(`③ ${name} 没有被 ${s.fromFile} 从 ${s.toFile} **再导出**`)
      if (!imported.test(nowIndex)) problems.push(`③ ${name} 没有被 ${s.fromFile} 从 ${s.toFile} **导入**（再导出不会把它带进模块作用域，内部调用会断）`)
    }
    out.push({ id: s.id, title: s.title, ok: problems.length === 0, problems })
  }
  return { slices: out, ok: out.every((x) => x.ok) }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const r = checkSlices()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log(`PRT-1007 逐字对拍：${r.slices.length} 片`)
    for (const s of r.slices) {
      console.log(`  ${s.ok ? '✔' : '✖'} ${s.id}（${s.title}）`)
      for (const p of s.problems) console.log(`      ${p}`)
    }
    console.log(r.ok ? '\n⇒ 四问全过' : '\n⇒ 有不合格的片')
    console.log('⚠️ 边界：本量具只证明**文本搬运保真**；"跑起来一样"要 `cd plugins && npm test`（需 DSH 检出 + typescript，本机当前缺）')
  }
  process.exit(r.ok ? 0 : 1)
}
