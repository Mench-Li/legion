// product/dsh-location.mjs
// ============================================================================
// **DSH 自己的东西在哪里** —— 只有两个答案：它的家目录、它的凭证文件。
//
// ## 为什么单独一个模块（而不是留在 `product/launcher/cli.mjs` 里）
//
// 因为从 2026-10-12 起，**读它的不止 Launcher 一个进程了**：
//
//   · `product/launcher/cli.mjs` —— 把 DSH 的凭证文件当作**只读回退来源**交给
//     密钥解析器（PRT-509 路线 A′）；
//   · `team-hub/runtime-credential.mjs` —— 回答面板那个问题
//     **"运行侧（DSH）到底有没有这把钥匙"**。
//
// 第二个消费者出现之前，这两个函数住在 `cli.mjs` 里是对的（那时只有一个调用方，
// 而且把"要不要读别人家的明文文件"这个**决策**收在 Launcher 一处是这个仓的纪律）。
// 但 `cli.mjs` 是**进程入口**：让中枢去 `import` 一个入口模块，只为拿一个 `join`，
// 是把"谁依赖谁"这件事搞反了。
//
//   > 两个调用方分别 import 一个入口模块里的同一个函数，
//   > 与它们各自抄一份 `join(home, '.credentials.yaml')`，
//   > 在**今天**是同一个读数 —— 差别在有人搬动入口模块的那一天。
//
// ## 三条边界（原样保留，它们是这个决策的全部内容）
//
//   ① **只认 `DSH_HOME`**，不猜路径。用户为 DSH 设了哪个目录，就读那个目录
//      ——不去翻 `%USERPROFILE%\.dsh` 之类的候选位置。猜路径会读到
//      "另一个账户留下的、当前用户并不知道存在的"凭证文件。
//   ② **`DSH_HOME` 没设就没有这个来源**（返回 `null`）。这与"设了但文件不在"
//      是两个不同的读数，由读取器自己的 `inspect()` 分开报。
//   ③ **它只给出路径**，读取与拒绝全在 `security/secrets/dsh-credentials.mjs`。
//      这一层不解析、不校验、不碰文件内容。
//
// ## 口径：不读 `process.env`，env 由调用方传入
//
// 与 `product/paths.mjs` 同一条纪律（那边是"纯函数、不读 env"）。这一层只做
// 一次 `env[DSH_HOME_ENV]` 的取值，于是配置面扫描器只需要在一个文件里对账它。
// ============================================================================

import { join } from 'node:path'

import { DSH_CREDENTIALS_FILENAME } from '../security/secrets/index.mjs'

/**
 * DSH 的家目录变量名。**DSH 自己**用它定位 `.credentials.yaml`。
 *
 * 它登记在 `product/config-schema.mjs` 的 `CHILD_ENV_NAMES` 里——原本只是
 * 「注入给 Runtime 子进程的变量名」。PRT-509 路线 A′ 之后它**也**是本进程的
 * 读取点，所以那份登记的理由跟着改了一句（`scan --check` 只看字面量是否
 * 登记过，有没有被读它管不着——登记理由漂了它不会报，只能靠这句话守着）。
 */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * DSH 的家目录**本身**（不是它下面某个文件的路径）。
 *
 * 与 `dshCredentialsFileFrom` 同一个来源、同一个键、同一个"没设就是 `null`"。
 * 运行时安装器需要它，但理由**不是**"要去读它的东西"——恰恰相反：
 * 它是被拒绝写入的那棵树。`$DSH_HOME` 是**另一个程序**的地盘，
 * 它的 clean / 升级会把整棵树换掉，把 Legion 的运行时装进去等于把
 * 一个版本的字节放在别人随时会删的位置上（见 `runtime-install.mjs` 的
 * `TARGET_INSIDE_DSH_HOME`）。
 *
 * ★ 它**不猜路径**：没设 `DSH_HOME` 就是 `null`，不会去回落
 * `%USERPROFILE%\.dsh`。猜出来的家目录会把"守卫一个不存在的禁区"
 * 伪装成"守卫过了"。
 *
 * ★ 它也是**这一条唯一的读取点**：`dshCredentialsFileFrom` 反过来调它。
 *
 *   两个函数各自读一次 `env[DSH_HOME_ENV]` 也能跑，而且行为一模一样——
 *   差别在 `scan --check` 那边：动态下标是**按出现次数**逐处对账的
 *   （`scripts/config/config.test.mjs` 里"product 有几处动态下标"那条），
 *   于是同一次读取写成两处，会让那份对账必须跟着动一次。
 *   为了一次读取去改那份"重数一遍再改 schema"的对账，等于把守卫
 *   从一个稳定的数字变成了每次加一个调用方就要动的东西。
 */
export function dshHomeFrom(env = {}) {
  const home = env[DSH_HOME_ENV]
  return typeof home === 'string' && home.trim() !== '' ? home : null
}

/**
 * 从进程环境推出**DSH 凭证文件的路径**（PRT-509 路线 A′）。
 *
 * ## 为什么只有一句 `join`，却值得单独一个函数
 *
 * 因为"要不要读一个**别人**拥有的、里面全是明文的文件"是一个**决策**，
 * 而决策必须有唯一一个能被引用、被测试、被讨论的位置。散落在两个
 * `openProductSecrets` 调用点里的路径拼接，事后没人说得清"产品到底会不会
 * 去读 DSH 的文件"。
 *
 * @param {object} env 进程环境。
 * @returns {string|null} `.credentials.yaml` 的绝对路径；`DSH_HOME` 未设时为 `null`。
 */
export function dshCredentialsFileFrom(env = {}) {
  const home = dshHomeFrom(env)
  if (home === null) return null
  return join(home, DSH_CREDENTIALS_FILENAME)
}

/** DSH 家目录的默认名字（`~/.dsh`）。**DSH 自己的** `defaultDshHome()` 就是这个。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/**
 * ★★ 2026-10-12：DSH **实际会用的**家目录 —— 与 `dshHomeFrom` 的差别是**它允许回落**。
 *
 * ## 为什么需要第二个函数（而不是把 `dshHomeFrom` 改宽）
 *
 * `dshHomeFrom` 的口径是"**只认 `DSH_HOME`，不猜路径**"，而那条口径服务的是
 * **读值**：一个猜出来的家目录会把"另一个账户留下的、当前用户并不知道存在的"
 * 凭证文件当成自己的，于是 Legion 可能拿着一把别人的钥匙去调供应商。
 * 所以那条口径不放宽。
 *
 * 但这里要回答的是**另一个问题**："运行侧（DSH）到底有没有这把钥匙"。
 * 而 DSH 自己的解析优先级是**写在它源码里的三级**
 * （`packages/util/home-paths/src/index.ts` 的 `resolveDshHome`）：
 *
 *     显式配置 > `$DSH_HOME` > `~/.dsh`
 *
 * ⇒ 在**这个部署**里（用户直接开 `DeepSeek Harness.exe`、宿主环境里没有 `DSH_HOME`），
 * DSH 落地在 `~/.dsh`。只认 `DSH_HOME` 就等于在这种部署上永远回"不知道" ——
 * 那不是保守，那是**没答**。
 *
 *   > 一条为了"别拿错钥匙"而定的规矩，
 *   > 与一条为了"回答状态"而定的规矩，在"要不要允许回落"上必须分开 ——
 *   > 否则你会用前者的理由，去接受后者的沉默。
 *
 * ## 两条边界
 *
 *   ① **只用于"回答状态"**（读的也只是**引用名**，不是值）。读值那条路继续走
 *      `dshCredentialsFileFrom`（不许回落）。
 *   ② **回落必须说出来**：调用方拿到的 `source` 会进界面文案
 *      （"按默认位置推出来的" vs "环境变量给的"），否则用户不知道我们假设了什么。
 *
 * @param {object} env 进程环境
 * @param {string|null} osHome 操作系统家目录（由调用方从 `osHomeFacts(env).homeDir` 给）
 * @returns {{home: string|null, source: 'env'|'default'|null}}
 */
export function dshHomeForStatus(env = {}, osHome = null) {
  const explicit = dshHomeFrom(env)
  if (explicit !== null) return { home: explicit, source: 'env' }
  if (typeof osHome === 'string' && osHome.trim() !== '') {
    return { home: join(osHome.trim(), DSH_HOME_DIR_NAME), source: 'default' }
  }
  return { home: null, source: null }
}

/** `dshHomeForStatus` 对应的凭证文件路径（同样**只用于回答状态**）。 */
export function dshCredentialsFileForStatus(env = {}, osHome = null) {
  const { home, source } = dshHomeForStatus(env, osHome)
  return { file: home === null ? null : join(home, DSH_CREDENTIALS_FILENAME), source }
}
