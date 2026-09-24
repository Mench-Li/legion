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
//    ★★ 订正 2026-09-24（T10）：**本机现在跑得了**，而实测的套件数不是 38：
//       `cd plugins && npm test` ⇒ **409 例 / 10 套件 / 0 失败**（exit 0）。
//    而 build 需要 DSH 检出里有 `packages/preset/agent-presets` **且**本机有 typescript；
//    本机当前**两样都缺**（见台账 §10.7）。所以这一条是"可复跑但当前不可跑"的判据，
//    ★★ 订正 2026-09-24（T10）：**两样都不缺了**（typescript 在检出里，`plugins/lib` 也在），
//       真正挡住的是 `build-external-package.mjs` 里一条**过期路径**（DSH 把 `dsh-agent-presets`
//       拆成了 `dsh-agent-preset` + `dsh-agent-preset-registry`）⇒ 已按注册表包迁移，行为级可跑了。
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
    // ★★★ 基准**必须是不可变提交**，不许写 'HEAD'。
  //
  //   我第一版写的是 'HEAD'，漏看了一件事：**提交之后 HEAD 自己也搬走了** ——
  //   于是这条判据在**提交前绿、提交后必红**，而它红得完全正确（旧位置确实没有了），
  //   只是那句话对"这次搬家做没做对"不再有任何信息量。
  //
  //   > 一个把"现状"当"原先"用的判据，与一个把 diff 的两边写成同一个东西的判据，
  //   > 在"它到底在比什么"上是同一个东西 —— 只不过前者会在提交那一刻翻脸。
  //
  //   'a8b6fcf' = 片 1 落地**之前**的那个提交（PDAC 的"原先"）。
  from: 'a8b6fcf',
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
  {
    id: 'PRT-1007/2',
    title: '子实例/守护的文件命名族',
    // 'a2cfffb' = 片 2 落地**之前**的那个提交（同片 1：基准必须不可变，不许写 'HEAD'）。
    from: 'a2cfffb',
    fromFile: 'plugins/src/index.ts',
    toFile: 'plugins/src/spacePaths.ts',
    names: ['childLogFile', 'statusFileNames'],
  },
  {
    id: 'PRT-1007/3',
    title: '监督判定（顶层纯函数，第一片"单个符号"）',
    // 'c9fb95e' = 片 3 落地**之前**的那个提交（同片 1/2：基准必须不可变，不许写 'HEAD'）。
    //
    //   ★ 片 3 只搬一个符号，是因为第一次挑的 `runGit` **搬不动**：
    //     它的返回类型是 `Promise<{ code… }>`，而 `extractSymbol` 按"第一个 `{`"配对
    //     ⇒ 会把**对象类型**当函数体、只截出签名，写进新模块后两个文件都语法错
    //     （由 `tsc` 抓住，**不是**由这个量具 —— 它当时是绿的）。
    //
    //   > 一个量具"搬错了东西还报绿"这件事，比它搬不动更值得记下来：
    //   > 前者要等到编译才现形，而编译不在这个量具的输出里。
    from: 'c9fb95e',
    fromFile: 'plugins/src/index.ts',
    toFile: 'plugins/src/proc.ts',
    names: ['isSupervisor'],
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

/**
 * ★★ T2（2026-09-24）：这个符号在文件里**是不是顶层的**。
 *
 *   起因：T2 要"给 `spaceWorker` 立缝再搬一族"。实测 `plugins/src/index.ts` 里
 *   `spaceWorker` 那一族**全是缩进 2 格的闭包**（例：`recallCorpus`），它们捕获外层
 *   的 `expDraftDir` / `parseDraftState` / `pendingRecallRefs` / `config`…
 *
 *   ⇒ **四问①（逐字相同）与闭包是互斥的**：搬走一个闭包，就必须把它捕获的那些东西
 *     一并变成参数 —— 那一步**必然改文本**。逐字工具搬得动的，只有**顶层**符号。
 *
 *   > 一个量具"搬不动闭包"这件事，本该印在它自己的脸上。
 *   > 否则使用者拿到的是 ①/②/③ 三条**看起来像自己写错了**的报错，
 *   > 而真相是"这一族不在这个工具的适用范围里"。
 *
 *   返回 `{ top: boolean, indent?: number }`；找不到符号返回 `null`。
 *
 *   ★ 诚实边界：⑤ 是**保守**规则，不是定理。一个闭包在新模块里**恰好**有同名自由变量
 *     （例如新模块也 import 了 `expDraftDir`）时，逐字相同**理论上也能成立**。
 *     本仓的选择是"顶层优先 + 把理由说清楚"，代价是拒绝一种理论上的合法形状 ——
 *     宁可让使用者看到"这一族不在本工具适用范围里"，也不要他看到三条像自己写错的报错。
 */
export function symbolTopLevel(text, name) {
  const nl = String(text).replace(/\r\n/g, '\n')
  for (const head of [`export function ${name}(`, `export interface ${name} {`, `function ${name}(`]) {
    const at = nl.indexOf(head)
    if (at < 0) continue
    // 行首 = 前一个换行之后；缩进 = 行首到符号起点之间的空白数
    const lineStart = nl.lastIndexOf('\n', at) + 1
    const indentText = nl.slice(lineStart, at)
    const indent = indentText.length
    return { top: indent === 0 && /^[ \t]*$/.test(indentText), indent }
  }
  return null
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
      // ★★ ⑤ T2：先判"这一族在不在本工具的适用范围里" —— 闭包搬不动，且这不是使用者的错。
      const topOld = symbolTopLevel(old, name)
      if (topOld !== null && !topOld.top) {
        problems.push(`⑤ ${name} 在 ${s.fromFile} 里**不是顶层符号**（缩进 ${topOld.indent} 格）`
          + '⇒ 它是**闭包**，捕获了外层变量；四问①要求"逐字相同"，'
          + '而搬走闭包必须把捕获项改成参数 —— **那一步必然改文本**。'
          + '本量具只搬得动**顶层**符号；要动这一族，得先"立缝"（改行为边界），'
          + '并用行为级判据（`cd plugins && npm test`）兜底，不是用它。')
        continue
      }
      const a = extractSymbol(old, name)
      const b = extractSymbol(now, name)
      if (a === null) { problems.push(`① 旧位置（${s.from}:${s.fromFile}）里找不到 ${name}`); continue }
      if (b === null) { problems.push(`① 新模块（${s.toFile}）里找不到 ${name}`); continue }
      const topNow = symbolTopLevel(now, name)
      if (topNow !== null && !topNow.top) {
        problems.push(`⑤ ${name} 在新模块（${s.toFile}）里**不是顶层符号**（缩进 ${topNow.indent} 格）`
          + '⇒ 逐字相同也说明不了什么：一个嵌在别人身体里的副本，不是"搬走了"，是"粘过去了"。')
        continue
      }
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
    console.log('⚠️ 边界：本量具只证明**文本搬运保真**；"跑起来一样"要 `cd plugins && npm test`'
  + '（2026-09-24 T10 起本机可跑：409 例 / 10 套件 / 0 失败）')
  }
  process.exit(r.ok ? 0 : 1)
}
