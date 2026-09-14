// scan.mjs — 配置读取点扫描器（P3-2 统一配置系统）
//
// 目的：让「配置 schema」不只写在文档里，而是**可机器校验**。
//   ① `node scripts/config/scan.mjs`                → 列出各进程真实读取的 env 键（含动态访问）
//   ② `node scripts/config/scan.mjs --check`        → 任一读取点（**含动态下标访问**）未在该进程 schema
//                                                      中声明即失败；命中了动态规则但**不是** env 读取的
//                                                      位置要登记进 FOREIGN_DYNAMIC_SUBSCRIPTS（见其注释）
//   ③ `node scripts/config/scan.mjs --json`         → 机器可读输出（供 CI/文档）
//
// 判定口径：只把「进程启动/运行期直接读取环境变量」的点计入；测试文件默认排除
//（测试会人为构造 env 做断言，不代表生产配置面），需要时用 --include-tests 打开。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, extname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SCHEMA_FILES } from './check.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 各进程的扫描范围（与 PROCESSES 一致；工作树的 worktrees 目录一律跳过）
 *  P3-4 起把 DSH 插件族也纳入：插件的主配置面是宿主 composition，但它们**从进程环境读取**的
 *  少数项（提示词预算、hub token 回落）同样属于配置面，必须可扫描、可校验。 */
export const PROCESSES = Object.freeze({
  'team-hub': { label: 'team-hub v2（对话/日程数据面）', dirs: ['team-hub'] },
  workbench: { label: '军团指挥台（workbench 宿主与静态服务）', dirs: ['workbench/scripts', 'workbench/src'] },
  whiteboard: { label: '协作白板（独立子项目）', dirs: ['whiteboard/apps/server/src', 'whiteboard/scripts'] },
  plugins: { label: '士兵守护插件族（plugins/：scrum-worker / mediator）', dirs: ['plugins/src'] },
  'board-plugin': { label: 'Scrum 看板插件（宿主 iframe 面板）', dirs: ['board-plugin/src'] },
  'services-plugin': { label: '服务托管插件（随 Desktop 启停三进程）', dirs: ['services-plugin'] },
  // PRT-251 起纳入产品层：Launcher 是**唯一**决定「子进程拿到什么环境」的地方，
  // 因此它的读取点必须与其余进程一样可扫描。注意它的注入面是白名单（见 product/launcher/env.mjs），
  // 与 services-plugin 的「整份 env 打底 + 覆盖」相反。
  product: { label: '产品层（Legion Launcher：进程清单 / 白名单注入 / 就绪判据 / 监督退避）', dirs: ['product'] },
  // PRT-301 起：Orchestrator worker 是独立常驻进程（清单里 `dependsOn: [team-hub, runtime]`），
  // 它有自己的读取面（TEAM_HUB_URL / TEAM_HUB_TOKEN / LEGION_*），因此单独登记。
  // 入口在 `product/orchestrator/worker.mjs`（清单冻结的路径），实现住在这里——
  // 两侧都会读 env，因此**两边都必须被扫描到**，否则「入口读了什么」会漏登记。
  orchestrator: { label: 'Legion Orchestrator worker（扫单 / 认领 / 派工；PRT-301 起）', dirs: ['orchestrator'] },
  // PRT-254 缺口（本批填上）：`runtime/` 是 `product/process-manifest.mjs` 的 `PROCESS_SPECS`
  // **已经声明**的进程（清单里 orchestrator 的 `dependsOn: [team-hub, runtime]` 指的就是它），
  // 却从 PRT-301 起一直不在本清单里 ⇒ 这份门禁对它**从来没有读过一行**。
  // 一个被声明为进程、又没有任何配置面门禁的目录，与"它没有配置面"是同一个读数——
  // 只不过前者会让 285 个字面量（含三个**真实**的 LEGION_* 读取键，经 `env[k]` 下标读）
  // 悄悄留在所有 schema 之外。这正是本清单存在的理由：**没登记等于没检查**。
  runtime: { label: 'Runtime 执行引擎/DSH 组合层（`runtime/`；清单第 3 个进程，PRT-254 起纳入扫描）', dirs: ['runtime'] },
  // PRT-254 缺口（本批填上）：`security/` 不是一个独立进程，而是**被其它进程 import 的
  // 安全面库**（凭证引用语法、ACL、DPAPI、YAML 凭证文档解析）。它之所以必须可扫描，
  // 与 plugins 族同一条理由：库目录里同样会有"像 env 键的字面量"（错误码、路径、头名），
  // 而**库目录最容易成为无人检查的角落**——它没有入口、没有就绪判据，也就没有一个
  // 自然的"该由谁来登记它"的时刻。
  security: { label: '安全面库（`security/`：凭证引用/ACL/DPAPI/凭证文档解析；PRT-254 起纳入扫描）', dirs: ['security'] },
})

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.legion-worktrees', '.worktrees', 'releases', 'scratch', 'coverage', 'data', '.ci', 'vendor'])
const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts'])

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), out)
    } else if (entry.isFile() && CODE_EXT.has(extname(entry.name))) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/**
 * 去掉注释，保留字符串与换行结构 —— 只用于「找读取点」，不改动原始文本。
 *
 * 为什么必须做：散文注释里写 `process.env.X`（举例/说明历史写法）会被下面的正则当成真实读取点，
 * 于是 `scan --check` 报出一个根本不存在的 env 键（P3-4 实测：`plugins/src/config.ts` 的注释里
 * 那句 `Number(process.env.X || 默认值)` 让主检出多出未声明键 `X`）。
 *
 * 为什么必须按字符状态机而不是 `text.replace(/\/\/.*$/gm,'')`：仓库里到处是 `'http://127.0.0.1:8787'`
 * 这类字符串字面量，粗暴替换会把**同一行后面的真实读取一起吃掉**（假阴性比假阳性更危险）。
 * 字符串内的转义与模板字面量也一并按状态处理。
 */
export function stripComments(text) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const n = text[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 1; continue }
      if (c === '/' && n === '*') { state = 'block'; i += 1; continue }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'template'
      out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 1; continue }
      if (c === '\n') out += c
      continue
    }
    // 字符串字面量内部：原样保留（含 `//`），转义字符不参与收尾判断
    if (c === '\\') { out += c + (n ?? ''); i += 1; continue }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code'
    out += c
  }
  return out
}

/** 从源码文本里抽出 env 键读取点；动态访问（process.env[expr]）单列，必须显式登记。 */
export function extractEnvReads(source) {
  const text = stripComments(source)
  const literal = new Set()
  const suspicious = new Set()
  const dynamic = []
  // process.env.NAME / env.NAME（后者仅匹配形如 `env.NAME` 且同一行出现 process.env? 不臆测，只认 process.env）
  for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) literal.add(m[1])
  // process.env['NAME'] / process.env["NAME"]
  for (const m of text.matchAll(/process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) literal.add(m[1])
  // 解构：const { A, B: alias } = process.env
  for (const m of text.matchAll(/const\s*\{([^}]+)\}\s*=\s*process\.env/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) literal.add(name)
    }
  }
  // ② 形如 `env.NAME` / `env['NAME']`（env 为独立标识符或其结尾，如 options.env.NAME）
  //
  // ★ 为什么要求 `NAME` 是**大写形态**（`[A-Z][A-Z0-9_]*`），而不是任意标识符：
  //
  // 这一条针对的是**别名**（`options.env.X` / `req.env.X`），与 ① 的 `process.env.X` 不同——
  // `process.env` 是无歧义的，别名则要看**那个对象到底是不是进程环境**。
  // 原先它按 `[A-Za-z_][A-Za-z0-9_]*` 匹配，于是任何**局部变量**只要叫 `env`，
  // 它的**小写**属性都会被当成环境变量读取点。实测（把 `runtime/` 纳入扫描范围时撞到）：
  //
  //   · `req.env.some((k) => …)`（`req.env` 是**数组**）→ 报出一个环境变量 `some`；
  //   · `env.t !== 'map'`（`env` 是**YAML 映射节点**，`t` 是节点类型标签）→ 报出 `t`；
  //   · `env.v` → 报出 `v`。
  //
  // 三条都是**编出来的读取点**，而 `nonEnvLiterals` 机制对它们**不适用**
  // （那份名单管的是"像 env 键的字面量"，不管"读到的键名"），于是唯一能让门禁变绿的做法
  // 就是往 schema 的 `fields` 里写三个根本不存在的环境变量——
  // **那等于让配置面声明开始说谎**，而这份声明的全部价值就是它说的每一句都是真的。
  //
  //   > 一个"把局部变量 env 的属性当成环境变量"的扫描器，与一个"环境变量多了三个"的结论，
  //   > 在 `scan --check` 的输出里是同一个读数——只不过前者会让下一个人去给不存在的键配默认值。
  //
  // ②b（下方）**本来就是**要求大写形态的，所以这里是**对齐**两条同类规则的判定口径，
  // 不是收紧一条本来正确的规则。真实的读取点不受影响：`process.env.X` 仍由 ① 逐字匹配
  // （那一条不区分大小写），别名上的真实键按仓库惯例都是大写的。
  //
  // 末尾的 `(?!\s*\()` 再排掉**方法调用**：`env.some(` 是调用一个叫 `some` 的方法，
  // 不是在读一个叫 `some` 的键。属性读取后面跟的是 `)` `,` `;` `&&` 之类，不会是 `(`。
  for (const m of text.matchAll(/(?:^|[^\w.'"])(?:\w+\.)*env\.([A-Z][A-Z0-9_]*)(?!\s*\()/g)) literal.add(m[1])
  for (const m of text.matchAll(/(?:\w+\.)*env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) literal.add(m[1])
  // ②b 别名环境对象：`const baseEnv = { ...process.env, ... }` 之后写 `baseEnv.NAME`
  //     （P3-4 实测：services-plugin 正是这样读 TEAM_HUB_HOST/TOKEN 与 DSH_HUB_UPSTREAM——
  //     直接扫描完全看不到这些读取点，与 P3-2 那批 `envBytes(name, def)` 间接读取是同一类盲区。）
  for (const m of text.matchAll(/(?:^|[^\w.'"])(\w*[Ee]nv)\.([A-Z][A-Z0-9_]*)\b/g)) literal.add(m[2])
  // ③ 疑似 env 形态的大写字面量（'WB_MAX_CONNECTIONS' 这类被当 key 传进读取辅助函数的常量）
  //    启发式：可能含非 env 命中，故 --check 下要求「声明或显式列入 nonEnvLiterals」
  for (const m of text.matchAll(/['"]([A-Z][A-Z0-9_]{3,})['"]/g)) {
    const v = m[1]
    if (!v.includes('_') && v.length < 6) continue // 排除 'ERROR' 这类单词常量
    suspicious.add(v)
  }
  // 动态下标：process.env[expr]（expr 非字符串字面量）
  for (const m of text.matchAll(/process\.env\[([^\]]+)\]/g)) {
    const inner = m[1].trim()
    if (!/^['"][A-Za-z_][A-Za-z0-9_]*['"]$/.test(inner)) dynamic.push(inner)
  }
  for (const m of text.matchAll(/(?:\w+\.)*env\[\s*([^\]'"]+)\]/g)) {
    const inner = m[1].trim()
    if (!/^['"][A-Za-z_][A-Za-z0-9_]*['"]$/.test(inner)) dynamic.push(`env[${inner}]`)
  }
  for (const k of literal) suspicious.delete(k) // 已确认为直接读取
  return { literal, dynamic, suspicious }
}

/**
 * 把「动态下标」表达式归一到**被计算的键表达式**。
 *
 * 为什么必须归一（本批实测，Trap 4）：同一个读取点会出现三种渲染，逐字比对会把**正确**的声明
 * 判成没生效：
 *
 *   · 源码 `process.env[name]` → 规则①报 `name`、规则②又匹配到嵌套的 `env[name]`（同一处，两条）；
 *   · `workbench/config-schema.mjs` 登记的是源码写法 `process.env[name]`，两者字面不等；
 *   · `security/secrets/dsh-credentials.mjs` 的 `record.env[names[0]]` 被规则截成 `env[names[0]`
 *     （`]` 不在规则允许的字符集 `[^\]'"]` 里），与源码写法也不等。
 *
 * 归一规则：反复剥掉最外层的 `process.env[...]` / `env[...]` 外壳与尾部 `]`，只留下被计算的键。
 * 于是 `process.env[name]`、`env[name]`、`name` 都归一成 `name`——它们是**同一个读取点**的三种渲染。
 *
 * ★ 这个归一是**刻意选的宽松度**，它仍然存在的缺口写在 `dynamicCoverage` 的注释里：
 *   同一文件里两个「归一后相同」的下标无法区分（那本来也就是同一处读法，同一张键名表）。
 *   **真正的判据是「文件 + 归一后的键表达式」**，因此「同文件里随手指一个声明」覆盖不了任何读取点。
 */
export function normalizeDynamicExpr(expr) {
  let s = String(expr ?? '').trim()
  for (;;) {
    const m = /^(?:process\.)?env\[\s*([\s\S]*)$/.exec(s)
    if (m === null) break
    s = m[1].trim()
    if (s.endsWith(']')) s = s.slice(0, -1).trim()
    if (s === '') break
  }
  return s
}

/** 动态读取 / 动态声明的匹配键：`文件 + 归一化后的键表达式`（NUL 分隔，避免文件路径里的字符撞车）。 */
export function dynamicReadKey(file, expr) {
  return `${String(file ?? '').replace(/\\/g, '/')}\u0000${normalizeDynamicExpr(expr)}`
}

/**
 * 命中「动态下标」规则、但**不是本进程环境变量读取点**的位置。
 *
 * 为什么需要这份名单，而不是把它塞进某个 schema 的 `dynamicEnvReads`：
 * `dynamicEnvReads` 声明的是「我确实这样读进程环境」。这两处**不是**读取，写进去就是让声明说谎——
 * 而这份声明的全部价值就是它说的每一句都是真的。两种情形各自不同：
 *
 *   · `security`（kind: foreign-object）：`env` 是**凭证文档里的 YAML 映射节点**，不是 process.env。
 *     同文件 470–475 行是判据（`env.t !== 'map'` / `for (const [name, value] of env.v)`）。
 *     不登记就只能靠「这道门禁根本不检查动态读取」变绿——那正是本批要消掉的洞。
 *   · `product`（kind: write-target）：`env[key] = String(value)` 是**赋值左值**（正在构造的子进程环境），
 *     不是读取；该函数真正的读取面是 `baseEnv`，走 `Object.entries(baseEnv)` 整表遍历，没有下标读。
 *
 * ★ 与 `dynamicEnvReads` 的边界（读这条注释的人必须先看懂这一句）：
 *   这里登记的是「扫描器看错了」，不是「这里读了一个环境变量」。每一条都必须写明 `kind`、`reason`
 *   与 `occurrences`（它豁免**几处**）。处数不符或多出来的同类下标 ⇒ `--check` 判失败，
 *   所以它不会退化成一张可以随手加一行的永久免检表。
 *   非 env 的豁免**只按精确文件路径**匹配；它不参与 Trap 1 的自身排除逻辑（那一条只认 schema 的精确路径）。
 */
export const FOREIGN_DYNAMIC_SUBSCRIPTS = Object.freeze([
  Object.freeze({
    process: 'security',
    file: 'security/secrets/dsh-credentials.mjs',
    // expr 按扫描器的**原样**记（它把 `]` 截掉了）；真身在 source 里，供人和用例核对。
    expr: 'env[names[0]',
    source: 'record.env[names[0]]',
    occurrences: 1,
    kind: 'foreign-object',
    reason: '这里的 env 是凭证文档里的 YAML 映射节点（同文件 470–475：env.t !== "map" / env.v），'
      + 'names = Object.keys(record.env)，是往映射节点里取字段，不是读 process.env。'
      + 'security/ 的设计约束就是不读 process.env（fields 为空即其实测结论）——为一个扫描器假阳性'
      + '去改生产变量的名字，等于让误报决定代码怎么读。',
  }),
  Object.freeze({
    process: 'product',
    file: 'product/launcher/allowlist.mjs',
    expr: 'env[key]',
    source: 'env[key] = String(value)',
    // buildChildEnv 里两处：baseEnv 放行遍历 + values 显式写入遍历。
    occurrences: 2,
    kind: 'write-target',
    reason: '`env[key] = String(value)` 是**赋值左值**——env 是正在构造的子进程环境对象（const env = {}），'
      + '读的是 baseEnv / values（Object.entries 整表遍历，没有下标读）。把它当读取登记会让声明说谎；'
      + '它必须仍然被看见，因为"哪些键能进子进程"正是这个函数决定的（所以留在这里，不是删掉）。',
  }),
])

/** 校验「非 env 动态下标」登记本身是否完整：缺 reason / 缺处数都要报出来（豁免必须写明为什么）。 */
export function foreignDynamicProblems(entries = FOREIGN_DYNAMIC_SUBSCRIPTS) {
  const out = []
  for (const [i, f] of entries.entries()) {
    if (f === null || typeof f !== 'object') { out.push(`#${i} 不是对象`); continue }
    const where = `${f.process ?? '?'} ${f.file ?? '?'}`
    if (typeof f.process !== 'string' || f.process === '') out.push(`#${i} 缺少 process`)
    if (typeof f.file !== 'string' || f.file === '') out.push(`#${i} 缺少 file`)
    if (typeof f.expr !== 'string' || f.expr === '') out.push(`#${i} 缺少 expr`)
    if (typeof f.reason !== 'string' || f.reason.trim() === '') {
      out.push(`#${i}（${where}）缺少 reason——豁免必须写明「为什么它不是 env 读取」`)
    }
    if (!Number.isInteger(f.occurrences) || f.occurrences < 1) {
      out.push(`#${i}（${where}）必须写明 occurrences（≥1 的整数）——豁免必须说清它覆盖**几处**`)
    }
  }
  return out
}

/**
 * 判定一个进程的动态下标访问是否被该 schema（以及 FOREIGN_DYNAMIC_SUBSCRIPTS）覆盖。
 *
 * 判据（`--check` 的强制口径）：
 *   ① 排除 **schema 文件自身**——它就在被扫描的目录里，它写下的 `expr: 'env[k]'` 会被同一条规则
 *      再扫一遍。那是**登记文本**，不是读取点。这里只按**精确路径**排除（`file === schemaRel`），
 *      刻意**不做** basename / 后缀匹配：后者会把任意子目录里同名的真实源码一起吞掉，
 *      于是"排除自身"变成"藏掉未声明读取"——那正是 Trap 1 要防的第二次假绿。
 *      排除数会随 `self` 一起返回，输出里如实报出来（"5 处已排除"与"5 处缺失"不能同形）。
 *   ② 剩余每一处（按 `文件 + 归一化表达式` 分组）必须要么在 `schema.dynamicEnvReads` 里，
 *      要么由 FOREIGN_DYNAMIC_SUBSCRIPTS 精确豁免（文件、表达式、处数三者都对）。
 *   ③ 登记了却找不到对应站点的豁免条目同样报出来（登记失效 ⇒ 这条记录已经在说谎）。
 *
 * 仍然存在的缺口（不夸大，写清楚）：归一化把 `process.env[X]` / `env[X]` / `X` 视为同一处
 * （它们本来就是同一处的不同渲染）；因此**同一文件内**两个归一后相同的下标只需一条声明。
 * 反向的宽松度为零：文件不同、或归一后的键表达式不同，一律不互相覆盖。
 */
export function dynamicCoverage(scan, schema, { schemaFile = '', processName = scan?.name, foreign = FOREIGN_DYNAMIC_SUBSCRIPTS } = {}) {
  const schemaRel = String(schemaFile ?? '').replace(/\\/g, '/')
  const all = (scan?.dynamic ?? []).map((d) => ({ file: String(d.file).replace(/\\/g, '/'), expr: d.expr }))
  const self = all.filter((d) => d.file === schemaRel)
  const source = all.filter((d) => d.file !== schemaRel)

  const counts = new Map()
  for (const d of source) {
    const key = dynamicReadKey(d.file, d.expr)
    const cur = counts.get(key) ?? { file: d.file, expr: d.expr, normalized: normalizeDynamicExpr(d.expr), occurrences: 0 }
    cur.occurrences += 1
    counts.set(key, cur)
  }

  const declared = new Set()
  for (const x of schema?.dynamicEnvReads ?? []) {
    if (x !== null && typeof x === 'object' && typeof x.file === 'string' && typeof x.expr === 'string') {
      declared.add(dynamicReadKey(x.file, x.expr))
    }
  }
  const foreignEntries = (foreign ?? []).filter((f) => f?.process === processName)
  const foreignByKey = new Map(foreignEntries.map((f) => [dynamicReadKey(f.file, f.expr), f]))

  const entries = []
  const usedForeignKeys = new Set()
  for (const [key, info] of counts) {
    const f = foreignByKey.get(key)
    let via = null
    if (declared.has(key)) via = 'dynamicEnvReads'
    else if (f !== undefined && f.occurrences === info.occurrences) { via = 'foreign'; usedForeignKeys.add(key) }
    // via === null 时，若 f 存在则是"处数不符"（登记 N 处、实际 M 处）——输出据此给出可读原因
    entries.push({ ...info, via, foreign: f ?? null })
  }
  entries.sort((a, b) => (a.file === b.file ? a.normalized.localeCompare(b.normalized) : a.file.localeCompare(b.file)))

  const presentKeys = new Set(counts.keys())
  const staleForeign = foreignEntries.filter((f) => !presentKeys.has(dynamicReadKey(f.file, f.expr)))
  return {
    all,
    self,
    source,
    entries,
    uncovered: entries.filter((e) => e.via === null),
    staleForeign,
    declaredCount: declared.size,
    foreignCount: foreignEntries.length,
  }
}

/**
 * `--check` 的**违规计数口径**（唯一一处）。
 *
 * 为什么把它抽成函数：这行式子就是这道门禁的判据本身，而内联在 `main()` 里时用例够不到它。
 * 本批实测（Mutation D）：把 `dyn.uncovered` / `dyn.staleForeign` 两项从 main 的内联式里删掉，
 * **51 条用例全绿、`scan --check` 照旧 PASS**——因为当前仓库每一处动态读取都已登记，
 * 计数少算不会让"现状"变红；也就是说，那半句代码当时是**没有任何测试守着**的。
 * 抽出来之后，"哪些东西算违规"是一个可被用例钉住的单元，`main()` 里只剩一行调用。
 *
 * 注意 `foreignProblems` 不在这里：它是全局的（不属于某个进程），在 main 里加一次。
 */
export function countViolations({ undeclared = [], undeclaredLiterals = [], dyn = null } = {}) {
  return undeclared.length
    + undeclaredLiterals.length
    + (dyn?.uncovered?.length ?? 0)
    + (dyn?.staleForeign?.length ?? 0)
}

/** 取「git 跟踪文件」集合（仓库相对路径，正斜杠）。
 *  为什么必须限制在跟踪文件：主检出里常有本地工具与构建产物（实测 `team-hub/.watch.mjs`
 *  读 `process.env.DB`、`team-hub/lib/index.js` 是构建产物），把它们算进「配置面」会让
 *  `scan --check` 的结果**依赖本机状态**（工作树通过、主检出失败）。git 不可用时返回 null，
 *  调用方回退到目录遍历并在输出中标注，保证结论可解释。 */
export function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return new Set(out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))
  } catch {
    return null
  }
}

/** 取「已写好但尚未纳入版本控制、且**不被 .gitignore 忽略**」的文件集合。
 *
 *  这是 `git add -A` 会带走的那一批，因此也就是「这次提交的配置面」。
 *
 *  与 `trackedFiles` 的差别很重要：`trackedFiles` 只知道「在不在索引里」，
 *  因此 `team-hub/lib/index.js` 这类**被忽略的构建产物**也算「未跟踪」；
 *  而真正危险的是「新建的源文件还没 git add」——它在索引外、也不被忽略。
 *  `--others --exclude-standard` 恰好就给出这一批。 */
export function pendingFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return new Set(out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))
  } catch {
    return null
  }
}

/** 扫描单个进程；返回 { name, files, reads:Map<key, {count, files:string[]}>, dynamic:[] } */
export function scanProcess(name, { includeTests = false, onlyTracked = true } = {}) {
  const spec = PROCESSES[name]
  if (!spec) throw new Error(`未知进程：${name}（可选：${Object.keys(PROCESSES).join(', ')}）`)
  const tracked = onlyTracked ? trackedFiles(ROOT) : null
  const pendingSet = onlyTracked ? pendingFiles(ROOT) : null
  const useGit = tracked !== null
  const files = []
  for (const d of spec.dirs) walk(join(ROOT, d), files)
  const reads = new Map()
  const dynamic = []
  const suspicious = new Map()
  let scanned = 0
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join('/')
    if (useGit && !tracked.has(rel)) continue // 未跟踪的本地文件/产物不属于配置面
    if (!includeTests && /\.test\.|\.spec\.|smoke/.test(rel)) continue
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    scanned += 1
    const { literal, dynamic: dyn, suspicious: sus } = extractEnvReads(text)
    for (const key of literal) {
      const cur = reads.get(key) ?? { count: 0, files: [] }
      cur.count += 1
      if (cur.files.length < 4 && !cur.files.includes(rel)) cur.files.push(rel)
      reads.set(key, cur)
    }
    for (const key of sus) {
      const cur = suspicious.get(key) ?? { count: 0, files: [] }
      cur.count += 1
      if (cur.files.length < 3 && !cur.files.includes(rel)) cur.files.push(rel)
      suspicious.set(key, cur)
    }
    for (const d of dyn) dynamic.push({ file: rel, expr: d })
  }
  // 未跟踪的代码文件**不纳入配置面**（理由见 trackedFiles 的说明），但这会带来一个陷阱：
  // 在「文件已写好、尚未 git add」的工作树上，`scan --check` 会因为压根没扫到这些文件而**假绿**。
  // 实测：P3-4 的 plugins/src/config.ts 在提交前未被扫描，提交后同一份代码立刻多出一个未声明键。
  // 这里把「有几个文件没被扫」如实报出来，让日志读者看得见这个盲区（不判失败：未跟踪文件本就不算配置面）。
  const untracked = useGit
    ? files.map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((rel) => !tracked.has(rel) && (includeTests || !/\.test\.|\.spec\.|smoke/.test(rel)))
    : []

  // ── 「假绿」的真正修法：把**将要被提交**的那批文件单独拎出来 ──
  //
  // 上面那条注释把陷阱说清楚了，却选择「只警告、不判失败」。这个选择本身
  // 就是漏洞：`scan --check` 报 PASS 的含义是「配置面没问题」，
  // 而它实际的含义只是「**已经提交的那部分**没问题」。
  //
  // 实测后果（PRT-502）：`orchestrator/model-binding/index.mjs` 提交前未跟踪，
  // 门禁报 PASS（285 字面量）；提交后同一份文件立刻冒出 12 个未处理字面量。
  // 也就是说这条门禁在**最需要它的时刻**（提交前）覆盖不到**它该管的对象**。
  //
  // 因此：`pending`（untracked 且未被 .gitignore 忽略）= `git add -A` 会带走的
  // 那批文件。非空时 `--check` **判失败**，因为此时任何 PASS 都是对
  // "将要提交的东西"的谎报。
  const pending = useGit
    ? files.map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((rel) => !tracked.has(rel) && pendingSet !== null && pendingSet.has(rel) &&
        (includeTests || !/\.test\.|\.spec\.|smoke/.test(rel)))
    : []
  return { name, label: spec.label, filesScanned: scanned, untracked, pending, reads, dynamic, suspicious, mode: useGit ? 'git-tracked' : 'walk（git 不可用：结果已包含未跟踪文件，仅作调试参考）' }
}

/** 未声明读取点（对照 schema 的 env 名单） */
export function undeclaredReads(scan, declaredEnvNames) {
  const declared = new Set(declaredEnvNames)
  return [...scan.reads.keys()].filter((k) => !declared.has(k)).sort()
}

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const check = argv.includes('--check')
  const includeTests = argv.includes('--include-tests')
  const noGit = argv.includes('--no-git')
  const only = argv.find((a) => a.startsWith('--process='))?.slice('--process='.length)
  const names = only ? [only] : Object.keys(PROCESSES)

  const results = []
  let violations = 0
  let suspiciousCount = 0
  // 「非 env 动态下标」登记本身的完整性：缺 reason / 缺处数 ⇒ 与其它未处理项一样计入 violations。
  // 放在循环外：这份登记是全局的，不属于某个进程。
  const foreignProblems = foreignDynamicProblems()
  for (const name of names) {
    const scan = scanProcess(name, { includeTests, onlyTracked: !noGit })
    const schemaPath = schemaModuleFor(name)
    // Trap 1：schema 文件本身也在被扫描的目录里。自身排除只认**这个精确路径**。
    const schemaRel = relative(ROOT, schemaPath).split(sep).join('/')
    let declaredEnv = null
    let undeclared = []
    let undeclaredLiterals = []
    let schema = null
    if (existsSync(schemaPath)) {
      try {
        // 动态导入 schema：schema 是纯数据（+ 少量纯函数），无副作用
        schema = (await import(pathToFileURL(schemaPath).href)).SCHEMA
      } catch (err) {
        if (check) throw err // --check 下 schema 坏掉必须炸，不能被静默降级成"没声明"
        schema = null // 列表模式：schema 坏了不该让"有哪些读取点"也看不了
      }
    }
    if (check) {
      if (schema === null) {
        undeclared = [...scan.reads.keys()].sort()
        undeclaredLiterals = [...scan.suspicious.keys()].sort()
      } else {
        declaredEnv = schema.envNames()
        undeclared = undeclaredReads(scan, declaredEnv)
        // 疑似 env 字面量：必须「是一个已声明 env 键名」或「显式列入 nonEnvLiterals」或「属声明前缀」或「登记为 foreignEnv」
        const foreign = (schema.foreignEnv ?? []).map((x) => (typeof x === 'string' ? x : x.name))
        const known = new Set([...declaredEnv, ...(schema.nonEnvLiterals ?? []), ...(schema.prefixes ?? []), ...foreign])
        undeclaredLiterals = [...scan.suspicious.keys()].filter((k) => !known.has(k)).sort()
      }
    }
    // 动态下标：无论 --check 与否都算出覆盖情况（列表模式也让人看得见"这处登记了没有"）。
    const dyn = dynamicCoverage(scan, schema, { schemaFile: schemaRel, processName: name })
    if (check) {
      violations += countViolations({ undeclared, undeclaredLiterals, dyn })
    }
    suspiciousCount += scan.suspicious.size
    results.push({
      ...scan,
      reads: [...scan.reads.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key)),
      literals: [...scan.suspicious.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key)),
      declaredEnv,
      undeclared,
      undeclaredLiterals,
      schemaFile: schemaRel,
      dynamicSource: dyn.source,
      dynamicSelf: dyn.self,
      dynamicEntries: dyn.entries,
      dynamicUncovered: dyn.uncovered,
      dynamicStaleForeign: dyn.staleForeign,
    })
  }
  // 「非 env 动态下标」登记不完整是**全局**的违规（不属于某个进程），在这里加一次。
  if (check && foreignProblems.length > 0) violations += foreignProblems.length

  if (json) {
    console.log(JSON.stringify({ processes: results.map((r) => ({ ...r, reads: r.reads, literals: r.literals })) }, null, 2))
  } else {
    for (const r of results) {
      // Trap 1 的可读性：把"总共几处"拆成"真实源几处 / schema 自身登记文本几处"。
      // 没有这个拆分，"5 处已排除"与"5 处没登记"在输出里长得一模一样。
      const dynSummary = r.dynamic.length === 0
        ? ''
        : `；动态访问 ${r.dynamic.length} 处（真实源 ${r.dynamicSource.length}，schema 自身登记文本 ${r.dynamicSelf.length} 处已排除）`
      console.log(`\n=== ${r.name}：${r.label} ===`)
      console.log(`  扫描模式 ${r.mode}；扫描文件 ${r.filesScanned} 个；直接读取 env 键 ${r.reads.length} 个；疑似 env 字面量 ${r.literals.length} 个${dynSummary}`)
      if (r.untracked?.length) {
        console.log(`    ⚠ 另有 ${r.untracked.length} 个未跟踪文件未纳入扫描（本地状态，提交后即纳入）：${r.untracked.slice(0, 3).join(', ')}${r.untracked.length > 3 ? ' …' : ''}`)
      }
      if (r.pending?.length) {
        console.log(`  ✖ 有 ${r.pending.length} 个文件**已写好但尚未纳入版本控制**，因此本次扫描没有覆盖它们：${r.pending.join(', ')}`)
        console.log('     这条门禁的模式是 git-tracked。在它们被 git add 之前，任何 PASS 都只是「已提交的那部分没问题」，而不是「你要提交的东西没问题」')
      }
      for (const read of r.reads) console.log(`    ${read.key.padEnd(34)} ×${String(read.count).padEnd(3)} ${read.files[0]}`)
      if (r.literals.length) {
        console.log(`    —— 疑似 env 字面量（需声明或列入 nonEnvLiterals）——`)
        for (const lit of r.literals) console.log(`    ${lit.key.padEnd(34)} ×${String(lit.count).padEnd(3)} ${lit.files[0]}`)
      }
      for (const e of r.dynamicEntries) {
        const tag = e.via === 'dynamicEnvReads' ? 'dynamicEnvReads 已登记'
          : e.via === 'foreign' ? `非 env 读取：已单独登记（${e.foreign.kind}）`
            : e.foreign !== null ? `✖ 与「非 env」登记处数不符（登记 ${e.foreign.occurrences} 处、实际 ${e.occurrences} 处）`
              : '✖ 未登记'
        console.log(`    ${e.via === null ? '✖' : '✔'} [动态] ${e.file}  →  ${e.expr}  （×${e.occurrences}，${tag}）`)
      }
      if (r.dynamicSelf.length) {
        console.log(`    [动态·已排除] ${r.schemaFile} 命中 ${r.dynamicSelf.length} 处——那是本文件里的**登记文本**（字符串），不是读取点；只按精确路径排除，不计入判据`)
      }
      for (const f of r.dynamicStaleForeign) {
        console.log(`    ✖ [动态·登记失效] ${f.file}  →  ${f.expr}：源码里已找不到这处下标，请从 FOREIGN_DYNAMIC_SUBSCRIPTS 删掉它`)
      }
      if (r.undeclared.length || r.undeclaredLiterals.length || r.dynamicUncovered.length || r.dynamicStaleForeign.length) {
        if (r.undeclared.length) console.log(`  ✖ 未声明 env 键（${r.undeclared.length}）：${r.undeclared.join(', ')}`)
        if (r.undeclaredLiterals.length) console.log(`  ✖ 未处理字面量（${r.undeclaredLiterals.length}）：${r.undeclaredLiterals.join(', ')}`)
        if (r.dynamicUncovered.length) {
          console.log(`  ✖ [${r.name}] 未声明动态读取（${r.dynamicUncovered.length}）：`
            + r.dynamicUncovered.map((e) => `${e.file} → ${e.expr}`).join('；'))
        }
        if (r.dynamicStaleForeign.length) {
          console.log(`  ✖ [${r.name}] 「非 env 动态下标」登记已失效（${r.dynamicStaleForeign.length}）：`
            + r.dynamicStaleForeign.map((f) => `${f.file} → ${f.expr}`).join('；'))
        }
      } else if (r.declaredEnv) {
        console.log('  ✔ 全部读取点、字面量与动态读取已在 schema 中处理')
      }
    }
  }
  // 假绿治理：有"将要提交但没被扫到"的文件时，PASS 是对提交内容的谎报。
  const pendingAll = results.flatMap((r) => (r.pending ?? []).map((f) => `${r.name}:${f}`))
  if (check && pendingAll.length > 0) {
    console.error(`\nscan: FAIL —— ${pendingAll.length} 个文件已写好但未被扫描（未纳入版本控制且未被 .gitignore 忽略）：`)
    for (const p of pendingAll) console.error(`  - ${p}`)
    console.error('  git-tracked 模式下这些文件不在配置面里。请 `git add` 后重跑，')
    console.error('  否则这条门禁报的是「已提交的部分没问题」，而不是「你要提交的东西没问题」。')
    process.exitCode = 1
  }
  if (check && violations > 0) {
    if (foreignProblems.length > 0) {
      console.error(`\nscan: 「非 env 动态下标」登记本身不完整（${foreignProblems.length} 项）——豁免必须写明为什么：`)
      for (const p of foreignProblems) console.error(`  - ${p}`)
    }
    console.error(`\nscan: FAIL —— ${violations} 项未在 schema 中处理：`
      + '读取点补进对应进程的 config-schema（fields / nonEnvLiterals / dynamicEnvReads）并写明理由；'
      + '命中了动态规则但**不是** env 读取的位置，登记进 scan.mjs 的 FOREIGN_DYNAMIC_SUBSCRIPTS（要写 kind / reason / occurrences）')
    process.exit(1)
  }
  if (check && pendingAll.length === 0) {
    console.log(`\nscan: PASS（全部 env 读取点、疑似字面量与动态读取均已处理；共 ${suspiciousCount} 个疑似字面量）`)
  }
}

/** 进程 → schema 模块路径（相对 ROOT），供 --check 对照使用。
 *
 *  **委托给 `check.mjs` 的 `SCHEMA_FILES`**，不再自己维护第二份映射：
 *  这两份曾经各自手写，PRT-251 新增 `product` 进程时只更新了其中一份，
 *  结果是 `scan --check` 说「全部已处理」而 `topology-inventory --diff` 说
 *  「product 的 8 个键未声明」。两份映射必然漂移，因此只留一份。 */
export function schemaModuleFor(name) {
  const file = SCHEMA_FILES[name]
  return file === undefined ? join(ROOT, '') : join(ROOT, file)
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/config/scan.mjs')
if (isMain) await main()
