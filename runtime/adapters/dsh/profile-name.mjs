// runtime/adapters/dsh/profile-name.mjs
// ============================================================================
// 「这个守护跑在哪个 DSH profile 上」的读取面 —— 纯函数，可单测。
//
// ## 为什么需要一个 profile 名
//
// 面板给出的"装上缺的子 Agent bundle"是一条 **shell 命令**，而 `dsh plugin` 的
// `--profile` 是 `requiredOption`（`apps/cli/src/args.ts:190`）。原来那句话写的是
// **字面占位符** `<profile-name>` —— 粘进终端根本跑不了。要给出真名，就得先知道它。
//
// 而且不只要知道名字，还要知道它**是不是 Desktop 独占的那个**：`desktop` 是 DSH
// 保留给 Electron 应用的 profile，命令行**明确被拒**
// （`apps/cli/src/args.ts:83-87`，原文 "managed exclusively by the Electron application"；
// DSH 自己的用例 `apps/cli/tests/args.spec.ts:226` 把它钉成 exit 1）。
// 那种情况下**给命令比不给更糟** —— 用户会以为自己照做了。
//
// ## 三路取值的顺序与理由（第三路是 2026-10-13 实机补的）
//
//   ① `DSH_PROFILE`            —— `dsh --profile <名>` 启动时最直接的那个。
//   ② `DSH_PROFILE_DIR` 的目录名 —— DSH 自己也是这么算的：
//      `packages/boot/app-boot/src/profile.ts` 里 `basename(profileDir)`。
//   ③ **宿主进程 argv 里带 `dsh-desktop-host` ⇒ `desktop`** —— 实机补的。
//
// 为什么需要 ③：实测那台机器上 `DSH_PROFILE=desktop` **只出现在 DSH 派给工具/会话的子进程里**，
// 宿主进程自己的环境里**没有**（症状：心跳发出去后服务端读到的 `profile` 一直是 null，
// 而同一台机器的 pwsh 里 `DSH_PROFILE` 明明有值 —— 说明那是**为工具进程注入**的，不是继承的）。
//
//   > 一个"我明明设了"的环境变量，
//   > 与一个"确实设了、但没设给你这个进程"的环境变量，
//   > 在**读它的那个进程**里是同一个东西：读不到。
//
// 判错了也不会给出一条跑不了的命令：这一路**只会把 Desktop 认出来**，而认出 Desktop 的
// 后果是"不给命令、指向界面" —— 那正是 Desktop 用户本来就该看到的答案。
// ============================================================================

/**
 * profile 名的合法性 —— **照抄** DSH 自己的规则
 * （`packages/boot/app-boot/src/profile.ts` 的 `resolveProfileDir`）：
 * 非空、不含 `/` 与 `\`、不是 `.` / `..` / `node_modules`。
 *
 * ★ **刻意不加长度上限**：DSH 没有这条规则，而这里问的是"**它是不是一个 DSH 认的 profile 名**"。
 *   加一条 DSH 没有的约束，会让一个合法的（哪怕很长的）名字被我们判成"不知道"，
 *   于是面板从"能给出命令"退化成"给不出" —— 那是**我们**的偏差，不是用户的。
 *   （入站边界那边的长度上限是另一件事：见 `team-hub/provider-readiness.mjs`，那里约束的是
 *     **来自网络的不可信输入**，与"DSH 认不认这个名字"无关。）
 *
 * ★ 这条规则**不保证 shell 安全**：DSH 允许名字里有空格，而空格会让
 *   `dsh plugin --profile 有 空格 add x` 在 shell 里被切成两个词。
 *   所以拼命令之前还要过一道 shell 安全闸 —— 见 `bundleInstallRemedy`。
 */
export function isAcceptableProfileName(value) {
  if (typeof value !== 'string') return false
  if (value === '' || value === '.' || value === '..' || value === 'node_modules') return false
  if (value.includes('/') || value.includes('\\')) return false
  return true
}

/** 从 `DSH_PROFILE_DIR` 这类路径里取最后一段目录名。 */
function basename(value) {
  if (typeof value !== 'string' || value === '') return null
  const parts = value.split(/[\\/]/).filter((p) => p !== '')
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? null : last
}

/**
 * 取这个守护所属的 profile 名；取不到返回 `null`（调用方据此**不给命令**）。
 *
 * @param {{ env?: Record<string, string|undefined>, argv?: readonly string[] }|null|undefined} input
 */
export function resolveProfileName(input) {
  // ⚠ 显式判空：默认参数只对 `undefined` 生效，`null` 会一路穿到 `input.env` 上抛 TypeError。
  //   （第一版就是这么写的，被"脏数据不该炸"那条用例当场抓住。）
  const source = input ?? {}
  const env = source.env ?? {}
  const argv = Array.isArray(source.argv) ? source.argv : []

  const direct = (env.DSH_PROFILE ?? '').trim()
  if (isAcceptableProfileName(direct)) return direct

  const fromDir = basename((env.DSH_PROFILE_DIR ?? '').trim())
  if (isAcceptableProfileName(fromDir)) return fromDir

  // ③ Desktop 宿主：profile 是保留且独占的 `desktop`（见文件头）。
  if (argv.some((a) => typeof a === 'string' && a.includes('dsh-desktop-host'))) return 'desktop'

  return null
}
