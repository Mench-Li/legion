// workbench/src/dshRemedy.ts
// ============================================================================
// 「装上缺的子 Agent bundle」这条修法的**可粘贴性**判定。
//
// ## 原来的那句话
//
// 面板在缺 provider 时会打印一行：
//
//     dsh plugin --profile <profile-name> add @deepseek-ai/dsh-subagent-codex
//
// 它**看起来是命令**，但有两处问题，两处都已在 DSH 源码里核对过：
//
// ① `<profile-name>` 是个**字面占位符**。粘进终端要么报错，要么真的建出一个叫
//    `<profile-name>` 的 profile 目录 —— 而 `--profile` 是 `requiredOption`
//    （`apps/cli/src/args.ts:190`），所以不给名字直接 exit 1。
//
// ② 就算把名字填对，**这台机器的 profile 是 `desktop`**，而 Desktop 的 profile
//    被 Electron 独占：
//
//        // apps/cli/src/args.ts:83-87
//        function rejectElectronProfile(program, profile) {
//          if (profile.toLowerCase() === 'desktop') {
//            program.error('error: profile "desktop" is managed exclusively by the Electron application')
//          }
//        }
//
//    且 DSH 自己的用例把它钉死了（`apps/cli/tests/args.spec.ts:226`）：
//
//        expect(exitCode(['plugin', '--profile', 'desktop', 'add', 'x'])).toBe(1)
//
//   > 一条**看起来能跑**的修法命令，比"没有命令、只说清该做什么"更糟：
//   > 前者会让人以为自己照做了（粘贴 → 报错 → 回头怀疑是别的地方坏了），
//   > 而后者至少把"这一步需要你去界面上做"说清楚了。
//   > （同形状的教训在参考项目里写成了：分成两格而不是拼成一句，是因为拼起来之后
//   >   没有一条能通过 `bash -n`——"一条看起来是命令的说明，比没有命令更糟"。）
//
// 所以本模块的规则是：
//
//   · profile 已知且**不是** desktop ⇒ 给一条**已填好真名**的、可整行粘贴的命令；
//   · profile 是 desktop         ⇒ **不给命令**，说明它由 Desktop 独占并指向界面；
//   · profile 未知               ⇒ **不给命令**（宁可不给，也不给带占位符的假命令）。
// ============================================================================

/** 与 `apps/cli/src/args.ts:83-87` 的 `rejectElectronProfile` 同一条规则（含大小写不敏感）。 */
export function profileManagedByDesktop(profile: string | null | undefined): boolean {
  return typeof profile === 'string' && profile.toLowerCase() === 'desktop'
}

/**
 * 与 `apps/cli/src/args.ts:169-176` 的 `resolveProfileDir` 同一条名字规则。
 *
 * 拿它来**前置校验**：一个连 DSH 都不接受的名字，不该被我们拼进命令里
 * （那会造出一条必然报错的命令 —— 正是本模块要消灭的东西）。
 */
export function isAcceptableProfileName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name === '' || name === '.' || name === '..' || name === 'node_modules') return false
  if (name.includes('/') || name.includes('\\')) return false
  return true
}

/** 合法的 npm 包名（这个子集足够覆盖 `@scope/name` 与 `name`，且排除 shell 元字符）。 */
const PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/** 会改变 shell 语义的字符 —— 任何一处出现就拒绝拼命令。 */
const SHELL_METACHARACTERS = /[\s;|&$`<>(){}[\]*?!#~'"\\]/

export type Remedy =
  /** 可以整行粘贴。 */
  | { readonly kind: 'pasteable'; readonly command: string; readonly explanation: string }
  /** 不能给命令（Desktop 独占 / profile 未知 / 输入不合法），只能说明该做什么。 */
  | { readonly kind: 'no-command'; readonly explanation: string; readonly steps: readonly string[] }

/**
 * 造"装上缺的 bundle"这条修法。
 *
 * @param profile  跑着这个守护的 DSH profile 名（来自守护心跳；未知传 `null`）
 * @param packages 要装的具体包名
 */
export function bundleInstallRemedy(
  profile: string | null | undefined,
  packages: readonly string[],
): Remedy {
  const wanted = (packages ?? []).filter(p => typeof p === 'string' && p.trim() !== '')

  // 一个包名都拼不出来时，别给命令 —— 空 `add` 只会得到一条用法错误。
  if (wanted.length === 0) {
    return {
      kind: 'no-command',
      explanation: '还不知道需要装哪个子 Agent bundle（要等 provider 读数或节点心跳上报之后才能判断）。',
      steps: [],
    }
  }

  const badPackage = wanted.find(p => !PACKAGE_RE.test(p) || SHELL_METACHARACTERS.test(p))
  if (badPackage !== undefined) {
    return {
      kind: 'no-command',
      explanation: `包名 ${JSON.stringify(badPackage)} 不合法，拒绝拼出一条可能被 shell 解析出别的意思的命令。`,
      steps: [],
    }
  }

  if (profileManagedByDesktop(profile)) {
    return {
      kind: 'no-command',
      // 不给出命令本身就是这条修法的重点：DSH 明确拒绝它。
      explanation: '这个守护跑在 Desktop 独占的 profile 上，**命令行装不了它的插件**：'
        + '`dsh plugin --profile desktop add …` 会被直接拒绝'
        + '（DSH 原文：profile "desktop" is managed exclusively by the Electron application）。',
      steps: [
        '在 Desktop 里打开「设置 → 插件 → 插件配置」，用它来安装下面这些 bundle。',
        `需要安装：${wanted.join('、')}`,
        '装完重启执行服务，等这一页的 provider 读数变绿（自检约 10 分钟一轮）。',
      ],
    }
  }

  if (!isAcceptableProfileName(profile)) {
    return {
      kind: 'no-command',
      // 宁可不给命令，也不给一条带占位符的假命令 —— 那正是这次要修的东西。
      explanation: '还不知道这个守护跑在哪个 DSH profile 上（旧版守护不上报，或本轮心跳还没到），'
        + '所以给不出一条能直接粘贴的命令。',
      steps: [
        `在你启动 Legion 的那个终端里，把下面这行的 \`<profile>\` 换成你的 profile 名后执行：`,
        `dsh plugin --profile <profile> add ${wanted.join(' ')}`,
        '（`--profile` 是必填项；profile 名就是你 `dsh --profile <名>` 启动时用的那个。）',
      ],
    }
  }

  const command = `dsh plugin --profile ${profile} add ${wanted.join(' ')}`
  return {
    kind: 'pasteable',
    command,
    explanation: `在跑这个守护的机器上整行粘贴执行。装进的是 ${profile} profile —— 也就是当前这个守护所属的那个。`,
  }
}

/**
 * 从心跳上报的字段里取 profile 名。
 *
 * 优先 `DSH_PROFILE`（DSH 启动器导出的名字），退回 `DSH_PROFILE_DIR` 的**目录名**
 * （DSH 自己也是这么算的：`apps/cli/src/app-boot/src/profile.ts:715` 用的是 `basename(profileDir)`）。
 */
export function resolveProfileName(
  env: { readonly DSH_PROFILE?: string; readonly DSH_PROFILE_DIR?: string } | null | undefined,
): string | null {
  const direct = env?.DSH_PROFILE
  if (isAcceptableProfileName(direct)) return direct
  const dir = env?.DSH_PROFILE_DIR
  if (typeof dir === 'string' && dir !== '') {
    const base = dir.split(/[\\/]/).filter(Boolean).pop()
    if (isAcceptableProfileName(base)) return base
  }
  return null
}
