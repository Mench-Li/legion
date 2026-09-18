/**
 * 找 DSH 检出——**一份**实现，而不是二十份。
 *
 * ## 为什么需要它
 *
 * 本仓有 21 个套件在跑真 DSH 进程，它们各自手写了这一段：
 *
 * ```js
 * const DSH = process.env.DSH_CHECKOUT ?? null
 * const DSH_SKIP = DSH === null ? '未配置 DSH_CHECKOUT' : …
 * ```
 *
 * 于是 **`DSH_CHECKOUT` 没导出的那台机器上，232 条断言全部跳过**——
 * 而那份检出就完整地在盘上。2026-09-18 的读数（`.ci/*​/ci.log`）：
 *
 * ```text
 * 套件数 215，skipped 合计 232，其中 6 个套件 pass=0
 *   dsh-composition-run-floor-dsh-process   tests= 6 skipped= 6
 *   runtime-contract-cross-process          tests=19 skipped=19
 *   headless-real-tool                      tests= 4 skipped= 4
 *   enforcement-real-process                tests= 5 skipped= 5
 *   session-boundary-real-process           tests= 9 skipped= 9
 *   subagents-surface-real-process          tests=12 skipped=12
 * ```
 *
 * ★ **那 6 个套件报的是 `PASS`。** 一个"跑了 0 条、报绿"的套件与一个
 * "跑完 19 条全过、报绿"的套件，在 CI 摘要上是同一个东西。
 *
 * ## 而候选列表在三处**已经不一致了**
 *
 * | 位置 | 候选 |
 * |---|---|
 * | `tests/p13-fixture/host-fixture.mjs` | `$DSH_CHECKOUT`、`D:/project/DSH/dsh/deepseek-harness` |
 * | `scripts/ci/build-external-package.mjs` | `$DSH_CHECKOUT`、`~/dsh-harness`、`~/dsh`、`~/.dsh/dsh-harness`、`D:/project/dsh/deepseek-harness` |
 * | `scripts/prt/dsh-pin-drift.mjs` | 同上一份（多一个 `isDirectory()` 与 try/catch） |
 *
 * 前两处的那个 Windows 字面量**大小写不同**（`DSH` vs `dsh`）。
 * 在 win32 上两者都能解析（路径不区分大小写），所以这个不一致**今天看不出来**——
 * 而它是"同一件事有三份实现"的典型指纹。
 *
 * ## 这一份的候选里，第一条不是硬编码
 *
 * 两个检出在本项目的布局里是**平级**的：
 *
 * ```text
 * D:\project\DSH\legion                  ← 本仓（ROOT）
 * D:\project\DSH\dsh\deepseek-harness    ← DSH 检出
 * ```
 *
 * 于是 `<ROOT>/../dsh/deepseek-harness` 是一条**结构性**候选，
 * 不是"作者那台机器上的绝对路径"。它在任何按这个布局摆放的机器上都成立。
 *
 * ## 为什么"回退"不是把绿变便宜
 *
 * 一个"找不到检出所以跳过"的套件，与一个"找到了另一份检出、在里面跑绿了"
 * 的套件，在摘要上都是 `PASS`。所以本模块**把来源也交出去**（`source` /
 * `path` / `envValue`），让调用方能说出"用的是哪一份"——
 * 回退让读数变**准**的前提，是它同时让"用了谁"变成可读的。
 *
 * 设计要点：`exists` 与 `isDir` 可注入，于是这个模块**不依赖盘上真有 DSH**
 * 就能被完整测到（`tests/dsh-checkout.test.mjs` 用人造文件系统钉住语义）。
 *
 * ★★ 而这里有一个我第一版踩进去的坑，写下来免得下一个人重踩：
 *   第一版只把 `exists` 做成可注入，而"是不是目录"那一步照旧调**真的**
 *   `statSync`。于是：
 *
 *   - 人造路径上 `statSync` 抛错 → 被 `catch` 吃掉 → 一律当成"不是目录"
 *     → 整个套件报"找不到检出"，看起来像**模块**坏了；
 *   - 而更要紧的是——**那个 `exists` 参数根本不是一条缝**。
 *     一条"注入了一半"的缝，与一条真的缝，在"签名上有个 `exists` 参数"
 *     这个读数上是同一个东西。
 *
 *   > 一个仍然会碰到真文件系统的"可注入"存在性判断，
 *   > 与一个不可注入的判断，区别只在于**测试会以哪一种方式骗过你**。
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 真实文件系统上"是不是目录"。测试会把它换掉（见文件头那段坑）。 */
function defaultIsDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

/**
 * 仓库根。
 *
 * ★★★ 本文件在 `scripts/lib/` 下，所以是**两级** `..`。
 *   第一版只写了一级（`resolve(HERE, '..')`），于是 `REPO_ROOT` 变成了
 *   `<root>/scripts`，结构性候选随之变成 `<root>/dsh/deepseek-harness`
 *   ——一个不存在的地方。
 *
 *   而**所有判据都通过**：因为 win32 上那条硬编码字面量
 *   （`D:/project/DSH/dsh/deepseek-harness`）把结果救了回来。
 *
 *   > 我写这个模块是为了让"结构性候选"取代"作者那台机器上的绝对路径"，
 *   > 而它第一版恰恰**只有那条绝对路径在工作**——
 *   > 一个只在作者机器上成立的模块，用"我把它改成结构性的了"这句话
 *   > 是验不出来的。
 *
 *   更糟的是**判据自己也复制了同一个错误**：`tests/dsh-checkout.test.mjs`
 *   当时用的是测试文件里自己写死的 `ROOT = 'D:/project/DSH/legion'`，
 *   于是"模块的 `REPO_ROOT` 对不对"这件事，两条读数**问都没问**。
 *
 *   ★ 这个坑是**在隔离 worktree 里复核 HEAD 时**才暴露的：
 *     主工作树上那条字面量永远命中，所以主工作树**永远看不到**它。
 *     判据见 `tests/dsh-checkout.test.mjs` ⑳。
 */
export const REPO_ROOT = resolve(HERE, '..', '..')

/**
 * 各种需求的相对路径。调用方用**名字**而不是自己去拼：
 * "我需要 DSH 的编译产物"这件事在两个套件里写两遍，就是两处会漂。
 */
export const DSH_NEEDS = Object.freeze({
  /** 只要有源码树（读源码做交叉核对时够用）。 */
  packages: Object.freeze(['packages']),
  /** 真进程套件要的：构建好的 CLI 入口。 */
  cli: Object.freeze(['packages', 'apps/cli/lib/bin.js']),
  /** 与 DSH 自己的凭据解析器交叉核对要的。 */
  credentials: Object.freeze(['packages', 'packages/credentials/credentials-local/lib/index.js']),
})

/**
 * 候选列表。
 *
 * ★ 顺序即优先级：`$DSH_CHECKOUT` 永远第一（显式指定压过一切推测）。
 * ★ 那个 win32 字面量按平台收窄：在 posix 上 `D:/project/...` 不是一个
 *   有意义的路径（它会被当成相对路径 `D:` 下的东西），留着它只会让
 *   "候选列表"这件事看起来比实际更可移植。
 */
export function dshCheckoutCandidates({ env = process.env, platform = process.platform, root = REPO_ROOT } = {}) {
  const list = [
    env.DSH_CHECKOUT,
    // 结构性候选：两个检出在本项目布局里平级（见文件头）。
    resolve(root, '..', 'dsh', 'deepseek-harness'),
    join(homedir(), 'dsh-harness'),
    join(homedir(), 'dsh'),
    join(homedir(), '.dsh', 'dsh-harness'),
  ]
  if (platform === 'win32') {
    list.push('D:/project/DSH/dsh/deepseek-harness', 'D:/project/dsh/deepseek-harness')
  }
  return list.filter((c) => typeof c === 'string' && c.trim() !== '')
}

/**
 * 找出一个可用的 DSH 检出。
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env] `$DSH_CHECKOUT` 从这里读
 * @param {readonly string[]|keyof typeof DSH_NEEDS} [opts.need] 必须存在的相对路径
 * @param {(p: string) => boolean} [opts.exists] 可注入（测试用）
 * @param {(p: string) => boolean} [opts.isDir] 可注入；**必须**与 `exists` 一起注入
 * @param {string} [opts.platform]
 * @param {string} [opts.root]
 * @returns {{
 *   checkout: string|null, source: 'env'|'candidate'|null, path: string|null,
 *   missing: string[], envValue: string, envPresent: boolean, envUsable: boolean,
 *   unbuilt: boolean, candidates: string[], reason: string,
 * }}
 */
export function resolveDshCheckout({
  env = process.env,
  need = DSH_NEEDS.packages,
  exists = existsSync,
  isDir = defaultIsDir,
  platform = process.platform,
  root = REPO_ROOT,
} = {}) {
  const wants = typeof need === 'string' ? (DSH_NEEDS[need] ?? [need]) : need
  const candidates = dshCheckoutCandidates({ env, platform, root })
  const envValue = typeof env.DSH_CHECKOUT === 'string' ? env.DSH_CHECKOUT.trim() : ''
  const envPresent = envValue !== ''

  // ★ 这里**只**用注入进来的那两个判断：碰一次真 `statSync`，
  //   这个参数就不是一条缝了（见文件头那段）。
  const safeDir = (p) => {
    try { return exists(p) === true && isDir(p) === true } catch { return false }
  }
  const missingIn = (dir) => wants.filter((rel) => !exists(join(dir, ...rel.split('/'))))

  // ── ① `$DSH_CHECKOUT` 优先 ──────────────────────────────────────────
  let envUsable = false
  if (envPresent && safeDir(envValue)) {
    const miss = missingIn(envValue)
    envUsable = miss.length === 0
    if (envUsable) {
      return done(envValue, 'env', [], { envValue, envPresent, envUsable: true, missing: miss, kind: null })
    }
    // 显式指定了却不可用：**不静默回退**。这是"有人把变量指错了地方"，
    // 而静默换一份检出跑绿，会把一个配置错误变成一次"通过"。
    return done(null, null, miss, {
      envValue, envPresent, envUsable: false, missing: miss, path: envValue, kind: 'unbuilt',
    })
  }

  // ── ② 变量设了，但那个路径**根本不是一个目录** ──────────────────────
  //
  // ★ 这一条与上面那条必须是**两句不同的话**。
  //   本模块第一版把它们并成了一支，于是 `$DSH_CHECKOUT=D:/typo/nope`
  //   会得到「找到一个 DSH 检出（D:/typo/nope），但它缺少 packages……
  //   那多半是『克隆了但没构建』」——**那句话是错的**：
  //   那里根本没有东西，谈不上"没构建"。
  //
  //   > 一个把"路径打错了"说成"克隆了没构建"的提示，
  //   > 会让下一个人去跑 `pnpm build`，而真正该做的是改那个变量。
  if (envPresent) {
    return done(null, null, wants.slice(), {
      envValue, envPresent, envUsable: false, missing: wants.slice(), path: envValue, kind: 'env-not-a-dir',
    })
  }

  let firstFound = null
  let firstFoundMissing = null
  for (const cand of candidates) {
    if (!safeDir(cand)) continue
    const miss = missingIn(cand)
    if (miss.length === 0) {
      return done(cand, 'candidate', [], { envValue, envPresent, envUsable: false, missing: [], kind: null })
    }
    if (firstFound === null) { firstFound = cand; firstFoundMissing = miss }
  }
  return done(null, null, firstFoundMissing ?? wants.slice(), {
    envValue, envPresent, envUsable, missing: firstFoundMissing ?? wants.slice(),
    path: firstFound, kind: firstFound !== null ? 'unbuilt' : 'not-found',
  })

  function done(checkout, source, missing, extra) {
    return Object.freeze({
      checkout,
      source,
      path: extra.path ?? checkout,
      missing: Object.freeze(missing),
      envValue: extra.envValue,
      envPresent: extra.envPresent,
      envUsable: extra.envUsable,
      // ★ `unbuilt` 只表示"找到了一棵树、但它缺构建产物"。
      //   "路径打错了"与"这台机器上没有"**都不是** unbuilt——
      //   第一版把前者也算成 unbuilt，于是提示让人去 `pnpm build`。
      unbuilt: checkout === null && extra.kind === 'unbuilt',
      kind: extra.kind ?? null,
      candidates: Object.freeze(candidates.slice()),
      reason: explain(checkout, source, missing, extra),
    })
  }

  function explain(checkout, source, missing, extra) {
    if (checkout !== null) {
      return source === 'env'
        ? `用 $DSH_CHECKOUT 指定的检出：${checkout}`
        : `$DSH_CHECKOUT 未设置；按候选顺序找到检出：${checkout}（本模块的候选列表）`
    }
    // ── 三种"不可用"必须是三句不同的话 ──────────────────────────────
    if (extra.kind === 'env-not-a-dir') {
      return `$DSH_CHECKOUT 指向的路径不是一个已存在的目录：${extra.path}。` +
        '这是**变量配错了**，不是"这台机器上没有 DSH"——请改那个变量，或者把它清掉让本模块按候选去找。' +
        `（候选：${candidates.join('、')}）`
    }
    if (extra.kind === 'unbuilt' && extra.path != null) {
      return `找到一个 DSH 检出（${extra.path}），但它缺少 ${missing.join('、')}` +
        '——那多半是"克隆了但没构建"（在检出里跑 pnpm install && pnpm build），' +
        '不是"这台机器上没有检出"。'
    }
    return `没找到 DSH 检出。候选（按顺序）：${candidates.join('、')}。` +
      '要真正核对这些断言，设 `DSH_CHECKOUT` 指向一个含 `packages/` 的检出。'
  }
}

/**
 * 套件专用的便捷形式：可用时返回 `false`（直接交给 `t.skip(false)` 之外的判断），
 * 不可用时返回**该跳过的理由**（已经是给人看的一句话）。
 *
 * ```js
 * const SKIP = dshSkipReason({ need: 'cli' })
 * const guarded = (name, fn) => test(name, (t) => SKIP !== false ? t.skip(SKIP) : fn(t))
 * ```
 */
export function dshSkipReason(opts = {}) {
  const r = resolveDshCheckout(opts)
  return r.checkout === null ? r.reason : false
}
