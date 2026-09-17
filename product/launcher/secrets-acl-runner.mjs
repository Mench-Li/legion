// product/launcher/secrets-acl-runner.mjs
// ============================================================================
// PRT-509 缺口 B1：把密钥库 ACL 的**生产 runner 与 owner**接上去。
//
// ## 这一段补的是哪一截
//
// `security/secrets/acl.mjs` 写得很完整：`inspectFileAcl` 能判出
// `ACL_TOO_PERMISSIVE`、`hardenFileAcl` 会先断继承再授权再**复验**，
// 而且它把 `ACL_NO_RUNNER` / `ACL_UNVERIFIABLE` / `ACL_NOT_CREATED` 三种
// "没查成"分得清清楚楚。它自己的用例也是绿的。
//
// 而 `product/launcher/launcher.mjs` 里那两个入参长这样：
//
//     secretsRun = null,          // 永远没有值
//     secretsOwner = null,        // 永远没有值
//
// 全仓 `grep secretsRun` 只有这两处（声明 + 传参），**没有任何生产调用方
// 给过它们**。于是生产上的实际读数恒为：
//
//     inspectFileAcl → ACL_NO_RUNNER（win32）/ 无 runner 分支
//     hardenFileAcl  → HARDEN_FAILED「不知道文件所有者，无法收紧」
//
// 两条都不会让启动失败（那是刻意的：密钥库自检不该拦住产品启动），
// 于是它们变成启动诊断里两句**永远出现、永远说同一句**的告警。
//
//   > 一份"判据齐全、28 条用例全绿、而生产里每次都说'没有 runner'"
//   > 的访问控制检查，与一份不存在的访问控制检查，在被保护的东西上
//   > 是同一个东西——只不过前者的测试报告是绿的。
//
// 而且它比"不存在"更坏一点点：**它看起来像查过了**。一句
// "没有 icacls runner，无法确认访问控制" 在诊断包里，与一句
// "ACL 检查通过" 一样占一行，而读的人很难分清哪一行是结论、哪一行是"没查"。
//
// ## 为什么 owner 用 `whoami` 而不是环境变量
//
// `product/secrets.mjs` 那条注释是对的：
//
//   > 具体到 ACL 的 `owner`：它在 Windows 上是 `DOMAIN\user`，而这个值**不能猜**。
//   > 猜错主体去授权等于把权限给错人，而猜错的失败方向是"给了别人权限"。
//
// 所以这里**不读 `USERNAME` / `USERDOMAIN`**（那才是"猜"：环境变量可以被继承、
// 被覆盖、被一个包装脚本设成别的东西）。这里问**操作系统本人**：
//
//     whoami  →  AMENCH\x
//
// 这是权威答案，不是推断。而且它恰好就是我们要授权的主体——Legion 自己
// 创建那个文件，所以"该能读它的主体"就是"当前进程的身份"。
//
// 拿不到（`whoami` 不存在、非零退出、输出为空）时**返回 `null`**，
// 让上游落回"不加固 + 具名告警"那条既有路径。**不回落、不猜、不用默认值**：
// 一个猜出来的 principal 去 `icacls /grant:r` 是"把权限给错人"，
// 而那个动作**没有返回值能告诉你给错了**。
//
// ## 为什么 runner 用 `spawnSync` 而不是异步 `spawn`
//
// ACL 自检发生在启动序列的**同步决策段**（要不要拦住启动、诊断里写什么），
// 而它跑的每条命令都是毫秒级的本地 exe。用异步会把 `collectSecretsDiagnostics`
// 整条链子变成"顺序不确定"，而那条链子的输出是要给用户看的一份**报告**。
// 超时上界必须有（`icacls` 在一个网络路径上可以挂很久），否则一次启动
// 会被一个不响应的路径卡住。
// ============================================================================

import { spawnSync } from 'node:child_process'

/** 本地 ACL 命令的超时上界。超时按"没查成"处理，不按"通过"。 */
export const ACL_COMMAND_TIMEOUT_MS = 10_000

/**
 * 生产 runner：`(cmd, args) => Promise<{status, stdout, stderr, error}>`。
 *
 * 与 `security/secrets/acl.mjs` 期望的形状一致（它读 `res.status` 与
 * `res.stdout`）。**永不抛**：命令不存在、超时、被杀，都折成一个
 * `status: null` + `error` 读数——因为抛出去会被 `collectSecretsDiagnostics`
 * 的 catch 折成一条笼统的 `SECRETS_CHECK_FAILED`，而那条消息说不出
 * 是 `icacls` 不在还是权限不够。
 *
 * @param {object} p
 * @param {Function} [p.spawn] 注入 `spawnSync`（用例用它验"超时会怎样"）。
 * @param {number} [p.timeoutMs]
 */
export function createAclRunner({ spawn = spawnSync, timeoutMs = ACL_COMMAND_TIMEOUT_MS } = {}) {
  return async function run(cmd, args) {
    const res = spawn(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      // `stdio` 必须是 pipe：`stdout` 是这条 runner 的**返回值本身**。
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      status: typeof res?.status === 'number' ? res.status : null,
      stdout: typeof res?.stdout === 'string' ? res.stdout : '',
      stderr: typeof res?.stderr === 'string' ? res.stderr : '',
      error: res?.error ? String(res.error.code ?? res.error.name ?? 'spawn-error') : null,
    }
  }
}

/**
 * 问操作系统"当前用户是谁"，作为 ACL 授权的 principal。
 *
 * Windows：`whoami` → `DOMAIN\user`，**原样**返回（不做大小写规范化——
 * `icacls` 接受这个大小写，而改动它只会让"我们授权的主体"与
 * "用户以为被授权的主体"有分叉的机会）。
 *
 * POSIX：返回 `null`。那里 `hardenFileAcl` 走的是 `chmod 600`，
 * **根本不用 owner**；给一个值只会让"owner 参与了判定"这句错觉多一处来源。
 * （`inspectFileAcl` 的 POSIX 分支同样不读 owner：它读的是权限位。）
 *
 * @returns {Promise<{owner: string|null, source: string, reason: string|null}>}
 */
export async function resolveSecretsOwner({ platform = process.platform, run } = {}) {
  if (platform !== 'win32') {
    return { owner: null, source: 'not-applicable', reason: `${platform} 上用 chmod 600，不需要 owner` }
  }
  if (typeof run !== 'function') {
    // 没有 runner 就问不出身份。**不回落成环境变量**：见文件头。
    return { owner: null, source: 'no-runner', reason: '没有 runner，无法向操作系统询问当前用户' }
  }
  let res
  try {
    res = await run('whoami', [])
  } catch (e) {
    return { owner: null, source: 'whoami-failed', reason: `whoami 执行失败：${e?.name ?? 'Error'}` }
  }
  const out = typeof res?.stdout === 'string' ? res.stdout.trim() : ''
  if (res?.status !== 0 || out === '') {
    // 非零退出或空输出：**问不出来就是问不出来**。返回 null 让上游落回
    // "不加固 + 具名告警"，而不是给一个可能是别人的名字。
    return {
      owner: null, source: 'whoami-failed',
      reason: `whoami 返回 ${res?.status ?? 'null'} 且输出为空${res?.error ? `（${res.error}）` : ''}`,
    }
  }
  // 多行输出的第一行是身份（`whoami /user` 才会多行；这里只调裸 `whoami`，
  // 但上游若换实现，取第一行比整段 trim 更稳）。
  const first = out.split(/\r?\n/)[0].trim()
  if (first === '') return { owner: null, source: 'whoami-failed', reason: 'whoami 输出为空行' }
  return { owner: first, source: 'whoami', reason: null }
}

/**
 * 一次把 runner 与 owner 都算出来，供 `launcherOptionsFrom` 直接铺进选项。
 *
 * **两者共用同一个 runner**：owner 是问 `whoami` 得到的，而 `whoami` 与
 * `icacls` 必须来自同一台机器的同一个 PATH。分成两个 runner 时，
 * 一个注入假 runner 的用例会看到"owner 来自真 whoami、ACL 来自假 icacls"
 * ——那种组合在物理上不存在，而它会安静地通过。
 */
export async function resolveSecretsAcl({ platform = process.platform, spawn = spawnSync, timeoutMs = ACL_COMMAND_TIMEOUT_MS } = {}) {
  const run = createAclRunner({ spawn, timeoutMs })
  const { owner, source, reason } = await resolveSecretsOwner({ platform, run })
  return Object.freeze({ run, owner, ownerSource: source, ownerReason: reason, platform })
}
