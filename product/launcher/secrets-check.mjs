// product/launcher/secrets-check.mjs
// ============================================================================
// 密钥库自检接进启动流程（PRT-257 的「自检」一半 + PRT-505/254 的生产调用方）
//
// PRT-254 的文档把「Launcher 还没有调用 `openProductSecrets`」记成未交付——
// **线的一端还没插上**。本模块是那一端。
//
// ---------------------------------------------------------------------------
// 核心判断：什么该**阻止启动**，什么只该**提醒**
//
// 这条分界很容易搞错，而两种错法的代价不对称：
//
//   - 该阻止却只提醒 → 启动成功，然后"静默地不安全"（明文写密钥、密钥进备份）
//   - 该提醒却阻止   → **用户被锁在门外**：他正是要打开界面去修这个问题，
//                       而界面起不来了
//
// 所以判据是：
//
//   **阻止启动的，是"启动本身会制造新的危险"；
//     只提醒的，是"现在就不工作"——那不该阻止启动，
//     因为修它的地方（Workbench）也在被启动的东西里。**
//
// 按这条分界：
//
//   | 情况 | 等级 | 为什么 |
//   | --- | --- | --- |
//   | 明文后端 | **error** | 启动后任何一次录入都会把密钥**明文写盘**——危险是启动制造的 |
//   | 密钥库落在 DataDir/InstallDir/CacheDir | **error** | 结构性：备份会带走它、升级会替换它、缓存清理会删掉它 |
//   | 打不开（损坏/读不到） | warn | 现在不工作，但**不制造新危险**；用户需要界面去修 |
//   | ACL 过宽 / 查不出来 | warn | 危险是**已经存在**的，不是启动制造的；且修它需要先能起来 |
//   | 平台不支持受保护存储 | warn | 同上：这台机器上云模型用不了，但产品本身该能起 |
//
// 「查不出来（UNVERIFIABLE）」被判成 warn 而不是"跳过"，同样是为了不让它沉默：
// 它会出现在 `--check` 的输出里，只是不阻塞。
// ============================================================================

import { openProductSecrets } from '../secrets.mjs'

/** 自检阶段的诊断码前缀，供调用方与用例识别。 */
export const SECRETS_DIAGNOSTIC_CODES = Object.freeze({
  UNPROTECTED: 'SECRETS_STORE_UNPROTECTED',
  PLACEMENT: 'SECRETS_PLACEMENT_INVALID',
  OPEN_FAILED: 'SECRETS_STORE_OPEN_FAILED',
  UNSUPPORTED_PLATFORM: 'SECRETS_STORE_UNSUPPORTED_PLATFORM',
  ACL_TOO_PERMISSIVE: 'SECRETS_ACL_TOO_PERMISSIVE',
  ACL_UNVERIFIABLE: 'SECRETS_ACL_UNVERIFIABLE',
})

/**
 * 把 ACL 的判定翻成**一条**诊断。
 *
 * 关键是 `ACL_TOO_PERMISSIVE`（查了，太宽）与 `ACL_UNVERIFIABLE`（没查出来）
 * **必须保持不同的码**。把前者塌成后者，等于让"已经确认的危险"看起来像
 * "这次没查到"——那是"查不出来 ≠ 是安全的"这条纪律的**反向**错法，
 * 而它同样会让一次真实的越权从诊断里消失。
 *
 * 返回 `null` 表示**不产生 ACL 诊断**。有两种情况会返回 `null`：
 *   ① ACL 已验证通过；
 *   ② **根本没有 ACL 信息**（自检在到达 ACL 那一步之前就短路了）。
 *
 * ② 与 ① 是不同的事实，但两者都**不该**产生一条关于 ACL 的诊断——
 * 在"自检整个崩了"的上面再叠一条"ACL 未验证"只是噪音，
 * 而噪音会把真正的那条信息稀释掉。
 * 反过来，只要 ACL 判定**确实拿到了**（`check.acl` 是个对象），
 * 无论整体成功与否都必须报出来。
 */
function aclDiagnostic(check) {
  if (check.aclVerified === true) return null
  // 没有 ACL 信息 → 不说 ACL 的话。**"没有这项信息"不等于"这项没通过"。**
  if (check.acl === null || check.acl === undefined || typeof check.acl !== 'object') return null
  const code = check.acl.code ?? null
  // 文件还没创建 → **没什么可保护的**，因此不产生告警。
  //
  // 这不是"放过"：全新安装上密钥库文件要到第一次写入密钥时才存在，
  // 若把它归成"未验证"，这条告警会在**每一台新机器、每一次启动**上出现，
  // 而它每次都说得不对（没有文件，就没有暴露面）。
  // 按本项目已经记过的那条：**一条永远不对的告警，和没有告警，是同一件事。**
  // 用户会学会忽略它，于是当文件**真的**变得可被别的账户读到时，那一条同样被忽略。
  if (code === 'ACL_NOT_CREATED') return null
  const detail = check.acl.message ?? '未取到 ACL 判定'
  if (code === 'ACL_TOO_PERMISSIVE') {
    return {
      severity: 'warn',
      code: SECRETS_DIAGNOSTIC_CODES.ACL_TOO_PERMISSIVE,
      message: `密钥库文件对所有者之外可读：${detail} ` +
        '**这是已经确认的问题**（不是"没查到"）：DPAPI 保护的是内容、不是文件，' +
        '别的账户仍可复制它、看到里面有哪些引用名。',
    }
  }
  return {
    severity: 'warn',
    code: SECRETS_DIAGNOSTIC_CODES.ACL_UNVERIFIABLE,
    message: `密钥库文件访问控制未验证：${detail}。` +
      '这不影响本次启动，但**"没查过"不等于"是安全的"**——DPAPI 保护的是内容、不是文件。',
  }
}

/**
 * 把一次自检结果翻成诊断。
 *
 * **纯函数**：输入是 `openProductSecrets` 的产物，输出是诊断数组。
 * 于是"什么该阻止启动"这条分界可以被逐条用用例钉住，而不需要真的去开一次密钥库。
 */
export function secretsDiagnostics(check) {
  if (check === null || typeof check !== 'object') {
    return Object.freeze([{ severity: 'warn', code: SECRETS_DIAGNOSTIC_CODES.OPEN_FAILED, message: '密钥库自检没有返回结果：这一项**未验证**' }])
  }
  const out = []
  const acl = aclDiagnostic(check)

  if (check.ok === true) {
    // 自检通过也必须把 ACL 的状态说出来（不阻塞，但绝不沉默）。
    if (acl !== null) out.push(acl)
    return Object.freeze(out)
  }

  switch (check.code) {
    case 'SECRETS_LAYOUT_BLOCKED':
      out.push({
        severity: 'error',
        code: SECRETS_DIAGNOSTIC_CODES.PLACEMENT,
        message: `密钥库位置不合法：${check.message} ` +
          '这是**结构性问题**：启动之后每次写入都会落在会被备份、会被升级替换或被当作缓存清掉的位置。',
      })
      break
    case 'SECRETS_STORE_UNPROTECTED':
      out.push({
        severity: 'error',
        code: SECRETS_DIAGNOSTIC_CODES.UNPROTECTED,
        message: `密钥库后端未提供受保护存储：${check.message} ` +
          '**启动会制造新的危险**——任何一次录入都会把密钥明文写盘，而这不会报错。',
      })
      break
    case 'SECRETS_STORE_UNSUPPORTED_PLATFORM':
      out.push({
        severity: 'warn',
        code: SECRETS_DIAGNOSTIC_CODES.UNSUPPORTED_PLATFORM,
        message: `本平台无法使用受保护密钥库：${check.message} ` +
          '云模型在本机无法配置凭证；这不阻止启动（**先能起来，才有地方修**）。',
      })
      break
    default:
      out.push({
        severity: 'warn',
        code: SECRETS_DIAGNOSTIC_CODES.OPEN_FAILED,
        message: `密钥库打不开：${check.message} ` +
          '这不阻止启动——**修它的地方（Workbench）也在被启动的东西里**，' +
          '把它挡在门外会让用户连修的机会都没有。',
      })
      break
  }

  // 整体失败时，ACL 的问题只要拿到了就一并报出来（失败原因可能不止一个）。
  if (acl !== null) out.push(acl)

  return Object.freeze(out)
}

/**
 * 跑一次自检并返回 `{ diagnostics, check }`。
 *
 * 自检本身**不得抛**：它在这里的作用是"把状态说出来"，
 * 而"自检代码自己崩了"会变成一条最难懂的启动失败。
 * 所以这里兜住一切异常，把它转成一条 warn。
 */
export async function runSecretsCheck({
  layout,
  openSecrets = openProductSecrets,
  platform = layout?.platform ?? process.platform,
  run = null,
  owner = null,
  requireProtected = true,
} = {}) {
  let check
  try {
    check = await openSecrets({ layout, platform, run, owner, requireProtected })
  } catch (err) {
    // 自检自己崩了也必须变成一条可读的状态，而不是一个未捕获的拒绝。
    check = Object.freeze({
      ok: false,
      code: SECRETS_DIAGNOSTIC_CODES.OPEN_FAILED,
      message: `自检过程本身出错：${err?.name ?? 'Error'}（密钥库未验证）`,
      acl: null,
    })
  }
  return Object.freeze({ diagnostics: secretsDiagnostics(check), check })
}
