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
 *
 * ★ **刻意不加长度上限**（与 `runtime/adapters/dsh/profile-name.mjs` 的那份逐例一致，
 *   由 `scripts/dsh-remedy.test.mjs` 的对照用例钉住）：DSH 没有这条规则，
 *   而这里问的是"它是不是 DSH 认的名字"。加一条 DSH 没有的约束只会**我们自己**退化。
 *
 * ★ 这条规则**不保证 shell 安全**（DSH 允许名字里有空格）—— 那是下一道闸的事。
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
        `先确认你的 profile 名：它就是启动 DSH 时 \`--profile\` 后面那个（Desktop 用的是保留的 \`desktop\`）。`,
        `· 若是普通 profile，把下面这行整行粘贴执行（把 \`<profile>\` 换成真名）：`,
        `dsh plugin --profile <profile> add ${wanted.join(' ')}`,
        // ★ 2026-10-13：**必须先排除 Desktop**，否则这段说明会把人送进一条必然失败的命令。
        //   `desktop` 是 DSH 保留给 Electron 应用的 profile，命令行**明确被拒**
        //   （apps/cli/src/args.ts 的 rejectElectronProfile）。一个 Desktop 用户照着上面那行填
        //   `desktop` 去跑，只会拿到一句错误 —— 而这段文字的本意是帮他。
        `· ⚠ **若你的 profile 是 \`desktop\`（Desktop 应用默认就是它），命令行装不了**：`
        + `DSH 明确拒绝（"managed exclusively by the Electron application"）。`
        + `这种情况请改用 Desktop 的「设置 → 插件 → 插件配置」来安装。`,
      ],
    }
  }

  // ★ 拼命令前的**最后一道闸**：DSH 认这个名字，不代表它能安全地放进一行 shell 命令。
  //   DSH 的规则不禁空格，而空格会让 `--profile 有 空格` 在 shell 里被切成两个词。
  //   与其引号转义（那又是另一套规则、又要在两处保持一致），不如**不给命令**并说清原因 ——
  //   与包名那道闸同一条思路。
  if (SHELL_METACHARACTERS.test(profile)) {
    return {
      kind: 'no-command',
      explanation: `这个 profile 名（${JSON.stringify(profile)}）含空格或 shell 特殊字符，`
        + '**没法安全地放进一行命令**（粘进终端会被切成别的意思），所以不给出命令。',
      steps: [
        `请自行执行（把名字用引号括起来）：dsh plugin --profile "${profile}" add ${wanted.join(' ')}`,
        '或改用 Desktop 的「设置 → 插件 → 插件配置」安装。',
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

// ⚠ 这里**刻意不再有** `resolveProfileName`（2026-10-13 删）。
//
// 它原本在这里，但**没有任何生产调用点** —— 只有它自己的用例在用它。
// 而"读这个守护的环境/argv"这件事只能发生在**插件进程里**，浏览器里的面板读不到 process.argv。
// 所以真实逻辑住在 `runtime/adapters/dsh/profile-name.mjs`（带单测），插件从那里取，
// 结果经心跳上报到 `/api/members` 的 `profile` 字段，面板只消费那个值。
//
//   > 一份"有人为它写了用例、却没有任何调用点"的实现，
//   > 与一份真的在跑的实现，在**它恰好与真实现一致**的时候是同一个东西 ——
//   > 区别只在它们分叉之后，而分叉是必然会发生的：这里删掉时它就已经**少了 argv 那一路**
//   > （那条正是实机为 Desktop 补的），而它的用例仍然全绿。
//
// 本模块保留的 `profileManagedByDesktop` 是**另一件事**：它是"拿到名字之后怎么决定给不给命令"，
// 那是面板的职责，本来就该在这里。两边的名字规则一致性由 `workbench/scripts/dsh-remedy.test.mjs`
// 的对照用例钉住（它直接 import 适配层那个模块比对）。
