// ============================================================================
// PRT-316 收尾守卫：`server.mjs` 里最后那两条路由（那对 SSE）。
//
// ★★★★★ 为什么需要这道守卫
//
//   49 片以来，每一族都靠同一条不变量保证"搬得对"：
//     **`if` 条件换成一次 `dispatch`，body 逐字节不动。**
//   它让"重构"可证、让回滚平凡。
//
//   而最后这两条路由**做不到**，原因是同一个模块级可变绑定：
//
//     L4544  let deliveryBookkeepingFailures = 0          声明（**可变**）
//     L4575  deliveryBookkeepingFailures += 1             audit() 那条路
//     L4732  deliveryBookkeepingFailures += 1             广播那条路
//     L5082  live: () => ({ deliveryBookkeepingFailures })★ 切片 19 用 **thunk** 读
//     L5492  deliveryBookkeepingFailures += 1             **events 路由内（写）**
//     L5530  bookkeepingFailures: deliveryBookkeepingFailures   **event-delivery 内（读）**
//     L5539  bookkeepingFailures: deliveryBookkeepingFailures   **event-delivery 内（读）**
//
//   ★ 装配（`createRouter([...])`）在**模块加载时只发生一次**。于是：
//
//     形态 A：**按值**注入 ⇒ body 逐字节相同 ✔，但路由**永久报装配那一刻的值**。
//               实测：真实值 3，路由读到 0。**不报错、不变红。**
//     形态 B：按**访问器**注入 ⇒ 行为正确 ✔，但 body 里那个名字要写成 `bookkeepingFailures()`
//               ⇒ **body 不再逐字节相同**。
//
//   ★★★ `events` 还多一样：L5492 是**写**，只读访问器不够，要多一个 `bump…()`。
//
//   ⇒ 唯一忠实的搬法都要求 body 改动，而 spec :1282 写的是
//     「阶段 3 的切片每个都要能独立对拍与回滚」。**这是要业主裁决的事。**
//
// ★ 本守卫的作用：**把"按值搬"这个静默错误变成一次报错。**
//   无论最后决定搬还是留，它都该在。
// ============================================================================
import { readFileSync } from 'node:fs'

const SERVER = 'team-hub/server.mjs'

/** 这对 SSE 依赖的那个模块级可变绑定。 */
export const MUTABLE_BINDING = 'deliveryBookkeepingFailures'
/** 期望留在 `server.mjs` 里的那两条（顺序即出现顺序）。 */
export const SSE_PAIR = ['GET /api/events', 'GET /api/event-delivery']

/** `handle()` 里剩下的 (方法,路径) 条件。 */
export function remainingRouteConditions(src) {
  const re = /if \(req\.method === '([A-Z]+)' && (?:path === '([^']+)'|path\.startsWith\('([^']+)'\))/g
  return [...src.matchAll(re)].map((m) => `${m[1]} ${m[2] ?? m[3]}`)
}

/** 模块级**可变**绑定（`let`）的名字。 */
export function mutableModuleBindings(src) {
  return new Set([...src.matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))
}

/**
 * 一个标识符被**写**过几次（`+=` / `-=` / `*=` / `/=` / `++` / `--` / 纯 `=`）。
 * ★ 粗筛：`==` / `===` / `=>` 不算写。够用即可，不追求完备。
 *
 * ★★★★★ **它把「声明」也算成一次写** —— `let x = 0` 里那个 `=` 也是一个 `=`。
 *   ⇒ 对"这个绑定真的被写过吗"这个问题，`writeCount < 1` **永远不会成立**。
 *     我第一版就是这么写的，于是那道守卫**一次都不会响**。
 *
 *   > 一个「我查了『这个绑定真的被写过吗』，用 `writeCount < 1` 兜底」的印象，
 *   > 与一个「`let x = 0` 的**声明本身**就带一个 `=`，所以这个计数**永远至少是 1**」的事实，
 *   > 在我把测试里那次"本该响却没响"读出来之前是同一个东西。
 *
 *   ⇒ 用 `mutationCount` 问"除声明外写过几次"。
 */
export function writeCount(src, name) {
  const esc = name.replace(/\$/g, '\\$')
  const re = new RegExp(`(?<![.\\w$])${esc}\\s*(\\+\\+|--|[+\\-*/]?=(?!=))`, 'g')
  return [...src.matchAll(re)].length
}

/** ★ 把 `let`/`var`/`const` **声明**那一处排除掉**之后的写次数。 */
export function mutationCount(src, name) {
  const esc = name.replace(/\$/g, '\\$')
  // 声明：`let <name> = …`（`=` 紧跟名字，中间只有空白）
  const declRe = new RegExp(`(?:^|[;{}\\s])(?:let|var|const)\\s+${esc}\\s*=`, 'g')
  const decls = [...src.matchAll(declRe)].length
  return writeCount(src, name) - decls
}

/**
 * ★ 注入面里有没有**按值**给出那个可变绑定。返回命中的键名，没有则 null。
 *
 * ★★★ 判据是「**简写属性**」`{ …, name, … }` —— 也就是这个名字被 `{` 或 `,`
 *   直接领着、又被 `,` 或 `}` 收尾。
 *
 * ★ 我第一版写成「名字后面跟着 `,` 或 `}`」，那是**错的**，而且错在**危险的方向**：
 *   `bookkeepingFailures: () => deliveryBookkeepingFailures,` 里那个名字**也**跟着 `,`
 *   ⇒ 它会**把正确的访问器写法报成错误**。
 *
 *   > 一个「按值注入的样子是『名字后面跟着逗号』」的印象，
 *   > 与一个「`key: () => 名字,` 里的名字**也**跟着逗号，于是这条判据会把**对的**写法判成错的」的事实，
 *   > 在我把那个访问器例子真的跑一遍之前是同一个东西。
 */
export function byValueInjection(depsSource, name) {
  const esc = name.replace(/\$/g, '\\$')
  const re = new RegExp(`[{,]\\s*${esc}\\s*(?=[,}])`)
  return re.test(depsSource) ? name : null
}

/** 默认要看的那两个（提取之后才会存在的）模块。 */
export const EXTRACTED_MODULES = [
  ['events', 'team-hub/routes/events.mjs'],
  ['event-delivery', 'team-hub/routes/event-delivery.mjs'],
]

/**
 * 守卫：返回诊断数组（空 = 通过）。
 *
 * ★ 第二参数可覆盖"提取之后要看哪些模块" —— 这是**为了让它自己的 ③ 那条可测**。
 *   ③ 只在 `server.mjs` 里那对**已被搬走**时才生效，而真实仓库里它们还在
 *   ⇒ 若不注入，③ **一条判据都碰不到**（我第一版的破验当场量出 M5 没咬住）。
 */
export function checkSseTail(src, opts = {}) {
  const files = opts.files ?? EXTRACTED_MODULES
  const problems = []
  const rest = remainingRouteConditions(src)
  const stillThere = rest.length > 0

  // ① 剩下的要么**恰好**是那一对，要么是 0 条（那对已被有意提取）。
  if (stillThere && JSON.stringify(rest) !== JSON.stringify(SSE_PAIR)) {
    problems.push('剩下的路由条件不是那对 SSE：' + rest.join(' , ')
      + ' —— 若是有意提取/新增了路由，请同步更新本守卫与它的测试。')
  }

  // ② 那一对**还在**时，它依赖的那个绑定的前提必须仍成立。
  if (stillThere) {
    if (!mutableModuleBindings(src).has(MUTABLE_BINDING)) {
      problems.push(`\`${MUTABLE_BINDING}\` 不再是模块级 \`let\` —— 那对 SSE 的写法前提变了`)
    } else if (mutationCount(src, MUTABLE_BINDING) < 1) {
      problems.push(`\`${MUTABLE_BINDING}\` 除了声明之外一次都没被写过 —— 那对 SSE 的写法前提变了`
        + `（writeCount=${writeCount(src, MUTABLE_BINDING)}、mutationCount=${mutationCount(src, MUTABLE_BINDING)}）`)
    }
  }

  // ③ ★★★★★ 若那一对**已被搬走**，新模块**必须按访问器**注入，不许按值。
  if (!stillThere) {
    for (const [fam, file] of files) {
      let mod
      try { mod = readFileSync(file, 'utf8') } catch { continue }
      const deps = /export function create\w+Routes\(\{([\s\S]*?)\}\) \{/.exec(mod)?.[1] ?? ''
      if (byValueInjection(deps, MUTABLE_BINDING) !== null) {
        problems.push(
          `★★★ ${fam}: 注入面里出现了**按值**的 \`${MUTABLE_BINDING}\` —— `
          + '装配只在模块加载时发生一次，按值会**永久冻结**在那一刻的值（实测：真实 3、路由读到 0），'
          + '而且**不报错**。必须按访问器注入（`() => …`），并为此接受 body 不再逐字节相同。')
      }
    }
  }
  return problems
}

// ── CLI ──
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (invokedDirectly) {
  const src = readFileSync(SERVER, 'utf8')
  const rest = remainingRouteConditions(src)
  console.log(`  server.mjs 里剩下 ${rest.length} 条路由条件：${rest.join(' , ') || '(无)'}`)
  console.log(`  「${MUTABLE_BINDING}」声明 ${writeCount(src, MUTABLE_BINDING) - mutationCount(src, MUTABLE_BINDING)} 次、真写 ${mutationCount(src, MUTABLE_BINDING)} 次（模块级 let = ${mutableModuleBindings(src).has(MUTABLE_BINDING)}）`)
  const problems = checkSseTail(src)
  if (problems.length === 0) console.log('  ✅ 收尾守卫通过')
  else { console.log('  ✖ 收尾守卫未通过：'); for (const p of problems) console.log(`    · ${p}`) }
  process.exitCode = problems.length ? 1 : 0
}
