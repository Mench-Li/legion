// runtime/connectors/target-binding.mjs
// ============================================================================
// 把「控制面的策略」与「部署配置的连接目标」组装成执行面认的声明。
//
// ## 为什么需要这一步（它不是一个转换函数那么简单）
//
// 执行面的 `declareConnector()` 要**两半**：
//   · 策略：`connectorId` / `transport` / `policy` / `tools`(含 capabilities、risk) / `secretRefs`
//   · 连接目标：stdio 要 `command`，http/sse 要 `url`
//
// 而控制面**只存策略那一半**（`team-hub/connector-store.mjs` 的 `normalizeDeclaration`），
// 并且**刻意**不存连接目标——那条性质有判据守着
// （`connector-store.test.mjs` ⑤：「导出…不含命令与 URL」）。
//
// 原因是两者**可移植性不同**：
//
//   > 策略是**可移植**的——同一岗位在哪儿都该有同样的边界；
//   > 连接目标是**每套部署各不相同**的——同一员工在笔记本与服务器上连的不是同一个端点。
//
// 业主 2026-09-18 据此裁决：策略留在控制面，连接目标由**运维在部署配置里给**。
// 本文件就是这两半的组装点。
//
// ## 三条拒绝，都是 fail closed，一条都不许"猜"
//
//   ① 有声明、没目标      → 拒绝。**不许**退化成"这次没有这个连接器"：
//                            那与"这个连接器没配"同形，于是一次**漏配**会静默地
//                            表现成"少了一个工具"。
//   ② transport 两侧不一致 → 拒绝。**不许**以某一侧为准：两侧不一致时任何一侧都可能是错的，
//                            而选错会让一个 `http` 声明拿着一条 `stdio` 命令
//                            **看起来配置完整**。
//   ③ 目标为空            → 拒绝。理由与执行面 `connector-transport-target-missing` 同源。
//
//   > 一个「装配期把缺目标补成空命令」的组装器，
//   > 与一个「让连接器注册成功但永远连不上」的组装器，是同一个东西——
//   > 只不过前者的失败点被推迟到了第一次真调用。
//
// ## 边界
//
// 本文件**不** import 控制面，也**不**读环境变量：它收的是**普通对象**。
// "目标从哪读"（部署配置 / 运维入口）是调用方的事，而那一层今天还在别人的在制品里
// ——分开之后，本文件的判据不受那边进度影响。
// @module runtime/connectors/target-binding
// ============================================================================

export const TARGET_BINDING_VERSION = 'legion/connector-target-binding@1'

export const TARGET_BINDING_CODES = Object.freeze({
  BAD_INPUT: 'connector-target-binding-bad-input',
  TARGET_MISSING: 'connector-target-missing',
  TRANSPORT_MISMATCH: 'connector-target-transport-mismatch',
  TARGET_EMPTY: 'connector-target-empty',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** stdio 要命令，别的要 URL——与执行面 `declareConnector` 同一条分工。 */
function targetFieldFor(transport) {
  return transport === 'stdio' ? 'command' : 'url'
}

/**
 * 组装：策略声明 + 部署给的目标 → 执行面可用的原始声明。
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} [input.declarations] 控制面规范化的声明（策略那一半）
 * @param {Record<string, object>} [input.targets] 部署配置给的连接目标，键是 `connectorId`
 * @returns {{version: string, declarations: ReadonlyArray<object>, refusals: ReadonlyArray<object>}}
 *
 * ★ **部分失败不静默**：某一条组装不出来时，它进 `refusals` 而**不是**被跳过。
 *   调用方拿到的是一个两边都看得见的结果——"组装出了哪几条"与"哪几条没组装出来、
 *   为什么"。少了这一条，"有一条没配上"与"本来就只有三条"在调用方眼里同形。
 */
export function bindConnectorTargets({ declarations = [], targets = {} } = {}) {
  if (!Array.isArray(declarations)) {
    throw fail(TARGET_BINDING_CODES.BAD_INPUT, 'declarations 必须是数组')
  }
  if (!isPlainObject(targets)) {
    throw fail(TARGET_BINDING_CODES.BAD_INPUT, 'targets 必须是对象（键是 connectorId）')
  }

  const bound = []
  const refusals = []

  for (const decl of declarations) {
    if (!isPlainObject(decl)) {
      throw fail(TARGET_BINDING_CODES.BAD_INPUT, 'declarations 里每一项都必须是对象')
    }
    const id = String(decl.connectorId ?? '').trim()
    if (id === '') {
      throw fail(TARGET_BINDING_CODES.BAD_INPUT, '声明缺 connectorId——没有 id 就无法与目标配对')
    }
    const transport = String(decl.transport ?? '').trim()

    const target = targets[id]
    // ① 有声明、没目标。
    if (target === undefined || target === null) {
      refusals.push(Object.freeze({
        connectorId: id,
        code: TARGET_BINDING_CODES.TARGET_MISSING,
        message: `连接器 ${id} 有策略声明，但部署配置里没有它的连接目标。`
          + '不按"这次没有这个连接器"处理——那与"这个连接器没配"同形，'
          + '会把一次漏配静默地变成"少了一个工具"',
      }))
      continue
    }
    if (!isPlainObject(target)) {
      throw fail(TARGET_BINDING_CODES.BAD_INPUT, `连接器 ${id} 的目标必须是对象`)
    }

    // ② transport 两侧不一致。★ 只在目标**明确给**了 transport 时才比较：
    //    没给不算不一致（那是"没声明"，不是"声明了另一个"）。
    const targetTransport = target.transport === undefined || target.transport === null
      ? null
      : String(target.transport).trim()
    if (targetTransport !== null && targetTransport !== '' && targetTransport !== transport) {
      refusals.push(Object.freeze({
        connectorId: id,
        code: TARGET_BINDING_CODES.TRANSPORT_MISMATCH,
        message: `连接器 ${id} 的 transport 两侧不一致：策略声明 ${JSON.stringify(transport)}，`
          + `部署目标给了 ${JSON.stringify(targetTransport)}。不按任何一侧为准——`
          + '两侧不一致时任何一侧都可能是错的，选错会让一个声明拿着另一条传输方式的'
          + '目标看起来"配置完整"',
      }))
      continue
    }

    // ③ 目标为空。
    const field = targetFieldFor(transport)
    const value = target[field]
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text === '') {
      refusals.push(Object.freeze({
        connectorId: id,
        code: TARGET_BINDING_CODES.TARGET_EMPTY,
        message: `连接器 ${id} 的 transport 是 ${JSON.stringify(transport)}，`
          + `部署目标必须给 ${field}（空值不算"给了"）`,
      }))
      continue
    }

    // ★ 显式构造**只含执行面会读的字段**，而不是把控制面那条记录 spread 进来。
    //
    //   控制面的记录带 `version: 'legion/connector-record@1'` 与 `version_label`，
    //   而执行面的 `createRegistry()` 用 `version === CONNECTOR_REGISTRY_VERSION`
    //   判断"这是不是一份已声明的"。spread 进去会让它走"当成原始输入再声明一次"
    //   那条分支——**碰巧能跑**，但那是靠"`declareConnector` 恰好忽略了不认识的字段"。
    //
    //   > 一个"靠对方忽略多余字段而碰巧能跑"的组装点，
    //   > 与一个"显式只给该给的字段"的组装点，在今天的读数上是同一个东西——
    //   > 只不过对方哪天开始拒绝多余字段时，只有后者还活着。
    bound.push(Object.freeze({
      connectorId: id,
      transport,
      command: transport === 'stdio' ? text : null,
      url: transport === 'stdio' ? null : text,
      policy: String(decl.policy ?? 'allow').trim(),
      tools: decl.tools,
      secretRefs: decl.secretRefs ?? Object.freeze([]),
    }))
  }

  return Object.freeze({
    version: TARGET_BINDING_VERSION,
    declarations: Object.freeze(bound),
    refusals: Object.freeze(refusals),
  })
}
