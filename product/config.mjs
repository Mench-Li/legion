// product/config.mjs
// ============================================================================
// 产品配置文件的读取、校验与分层合并（spec §6.11）
//
// 优先级是固定的：内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量。
// 本文件负责把**磁盘上的三层文件**读进来，交给 `paths.mjs` 的 `mergeConfigLayers`
// 做合并——合并语义只有一份实现（数组整体替换、null 显式清空、provenance 可追溯）。
//
// ## 为什么「读配置」值得单独一个文件并配一组用例
//
// 配置系统的失败几乎全是**静默**的：
//   - 文件里写错了一个键名 → 没有人报错，配置就是不生效；
//   - JSON 里多了一个逗号 → 整份配置被当成「不存在」，于是所有值回到默认值；
//   - 某层文件不可读（权限、被占用）→ 同上；
//   - 把 `{ "port": "8787" }`（字符串）当成 `8787` 用 → 端口比较永远不等，
//     症状是「服务起不来」或「就绪超时」，而真正原因是类型。
//
// 因此这里的规则是：**能确定的问题一律报成诊断，绝不静默退回默认值**。
// 一份坏掉的配置文件比没有配置文件更危险：没有配置文件时用户知道自己在用默认值，
// 有一份坏配置文件时用户以为自己的设置生效了。
//
// ## 与密钥的关系
//
// 普通配置文件**不得**含明文密钥（§6.11）。写入侧已有 `assertConfigWritable`；
// 读取侧这里也做一次检查并报 error：写入侧拦不住手工编辑，而手工编辑是最常见的路径。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'

import {
  CONFIG_LAYERS,
  assertConfigWritable,
  findPlaintextSecretsInConfig,
  mergeConfigLayers,
  provenanceOf,
} from './paths.mjs'

/** 产品配置文件名（DataDir 内）。 */
export const PRODUCT_CONFIG_FILENAME = 'product.config.json'
/** 工作空间配置的相对路径（相对 Workspace 根）。 */
export const WORKSPACE_CONFIG_RELPATH = '.legion/product.config.json'
/** 用户设置文件名（产品家目录内）。 */
export const USER_SETTINGS_FILENAME = 'settings.json'

/**
 * 已登记的配置键及其类型。
 *
 * **登记表是刻意的**：让「配置里写了一个没人读的键」可以被发现。
 * 一个从不生效的配置项在排障时会消耗大量时间——用户改了它、重启、什么都没变，
 * 于是问题被归到「产品坏了」；真实原因是键名写错或功能未实现。
 */
export const KNOWN_CONFIG_KEYS = Object.freeze({
  'runtime.command': Object.freeze({
    type: 'string',
    doc: 'DSH Runtime 的启动命令行（PRT-011 路线 C：Launcher 把 npm 包装进 DataDir 后由这里指定）',
  }),
  'runtime.env': Object.freeze({ type: 'object', doc: '注入 Runtime 子进程的额外环境变量（不含密钥）' }),
  'ports.team-hub': Object.freeze({ type: 'number', doc: 'team-hub 端口' }),
  'ports.workbench': Object.freeze({ type: 'number', doc: 'Workbench 端口' }),
  'ports.runtime': Object.freeze({ type: 'number', doc: 'DSH Runtime 端口' }),
  'ports.whiteboard': Object.freeze({ type: 'number', doc: '白板端口' }),
  'launcher.readinessTimeoutMs': Object.freeze({ type: 'number', doc: '单进程就绪判据超时（ms）' }),
  'launcher.backoffBaseMs': Object.freeze({ type: 'number', doc: '退避基数（ms）' }),
  'launcher.backoffMaxMs': Object.freeze({ type: 'number', doc: '退避上限（ms）' }),
  'components.whiteboard.enabled': Object.freeze({ type: 'boolean', doc: '是否启用可选白板组件' }),
  'runtime.secretRefs': Object.freeze({ type: 'object', doc: '模型密钥的**引用**（值只能是 secretRef 形态，不得是明文）' }),
  // ── PRT-709 日志轮转与磁盘保护 ──
  //
  // 这四个键是**必须**能被用户改的，不是"以后再说"：`DEFAULT_LOG_POLICY` 里的
  // 8 MiB / 128 MiB / 5 代是合理起点，但"单文件上限"必须能调小——
  // `STILL_OVER_BUDGET` 那条诊断给出的唯一建议就是"调小 maxFileBytes，
  // 让它在写满之前就被轮转"。如果这个键改不了，那条建议等于没有出口。
  'log.maxFileBytes': Object.freeze({ type: 'number', doc: '单个日志文件超过它就轮转（字节）' }),
  'log.maxTotalBytes': Object.freeze({ type: 'number', doc: '日志目录的总字节预算' }),
  'log.keepFiles': Object.freeze({ type: 'number', doc: '每个日志 base 最多保留几代已轮转文件（不含活动文件）' }),
  'log.minFreeBytes': Object.freeze({ type: 'number', doc: '可用磁盘空间低于它就算磁盘紧张（字节）' }),
})

/**
 * 去掉 UTF-8 BOM。
 *
 * **这不是洁癖，是 Windows 上的常态**：记事本、部分 PowerShell 写法与不少编辑器
 * 保存 UTF-8 时会带上 `U+FEFF`，而 `JSON.parse` 会**拒绝**它。
 * 不处理的表现是：用户在记事本里改了一个端口、保存、启动——
 * 得到「配置文件不是合法 JSON」，而文件在用户眼里完全正常。
 * 这条是实测出来的（`Set-Content -Encoding utf8` 写出的文件即可复现）。
 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/** 读取一个 JSON 文件；失败时返回诊断而不是抛错（调用方要能把所有问题一起展示）。 */
export function readJsonFile(path, { readFile = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  if (!exists(path)) return Object.freeze({ ok: true, exists: false, values: null, diagnostics: Object.freeze([]) })
  let text
  try {
    text = stripBom(readFile(path))
  } catch (e) {
    return Object.freeze({
      ok: false,
      exists: true,
      values: null,
      diagnostics: Object.freeze([Object.freeze({
        severity: 'error',
        code: 'CONFIG_UNREADABLE',
        message: `配置文件 ${path} 存在但读不出来：${e?.message ?? e}。` +
          '不得把它当成「没有配置」继续启动——那样用户会以为自己的设置生效了。',
      })]),
    })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return Object.freeze({
      ok: false,
      exists: true,
      values: null,
      diagnostics: Object.freeze([Object.freeze({
        severity: 'error',
        code: 'CONFIG_INVALID_JSON',
        message: `配置文件 ${path} 不是合法 JSON：${e?.message ?? e}。` +
          '格式错误会让整份配置被忽略，因此必须报错而不是退回默认值。',
      })]),
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.freeze({
      ok: false,
      exists: true,
      values: null,
      diagnostics: Object.freeze([Object.freeze({
        severity: 'error',
        code: 'CONFIG_NOT_OBJECT',
        message: `配置文件 ${path} 的顶层必须是对象（当前是 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`,
      })]),
    })
  }
  return Object.freeze({ ok: true, exists: true, values: Object.freeze(parsed), diagnostics: Object.freeze([]) })
}

/** 三个配置文件的路径（缺角色目录时对应项为 null）。 */
export function configPaths(layout, { platform = layout?.platform } = {}) {
  const sep = platform === 'win32' ? '\\' : '/'
  const data = layout?.dataDir ?? null
  const ws = layout?.workspaceDir ?? null
  const home = layout?.productHome ?? null
  return Object.freeze({
    'product-config': layout?.productConfigPath
      ?? (data === null ? null : `${data}${sep}${PRODUCT_CONFIG_FILENAME}`),
    'workspace-config': ws === null ? null : `${ws}${sep}${WORKSPACE_CONFIG_RELPATH.split('/').join(sep)}`,
    'user-settings': home === null ? null : `${home}${sep}${USER_SETTINGS_FILENAME}`,
  })
}

/**
 * 校验一份配置值（只检查**已登记的**键、类型、以及密钥禁令）。
 *
 * 未知键报 warn 而不是 error：向前兼容（更高版本写的配置被更低版本读到）是真实场景，
 * 而拒绝启动会让降级变得不可能。但它必须被**看见**，否则「改了配置没反应」无从解释。
 */
export function validateConfigValues(values, { layer = 'product-config' } = {}) {
  const diagnostics = []
  if (values === null || values === undefined) return Object.freeze(diagnostics)

  const walk = (obj, prefix) => {
    for (const [key, raw] of Object.entries(obj)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      const spec = KNOWN_CONFIG_KEYS[path]
      if (spec === undefined) {
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          walk(raw, path)
          continue
        }
        diagnostics.push(Object.freeze({
          severity: 'warn',
          code: 'CONFIG_UNKNOWN_KEY',
          layer,
          path,
          message: `${layer} 里的配置项「${path}」没有任何读取方：它不会生效。` +
            '若这是更高版本写的配置，可忽略；否则请检查键名拼写。',
        }))
        continue
      }
      if (spec.type === 'number' && (typeof raw !== 'number' || Number.isNaN(raw))) {
        diagnostics.push(Object.freeze({
          severity: 'error',
          code: 'CONFIG_TYPE_MISMATCH',
          layer,
          path,
          message: `${layer} 的「${path}」应当是数字，实际是 ${JSON.stringify(raw)}。` +
            '字符串形式的数字会静默破坏比较（例如端口比对永远不相等），因此必须报错。',
        }))
      } else if (spec.type === 'boolean' && typeof raw !== 'boolean') {
        diagnostics.push(Object.freeze({
          severity: 'error',
          code: 'CONFIG_TYPE_MISMATCH',
          layer,
          path,
          message: `${layer} 的「${path}」应当是布尔值，实际是 ${JSON.stringify(raw)}`,
        }))
      } else if (spec.type === 'string' && typeof raw !== 'string') {
        diagnostics.push(Object.freeze({
          severity: 'error',
          code: 'CONFIG_TYPE_MISMATCH',
          layer,
          path,
          message: `${layer} 的「${path}」应当是字符串，实际是 ${JSON.stringify(raw)}`,
        }))
      } else if (spec.type === 'object' && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
        diagnostics.push(Object.freeze({
          severity: 'error',
          code: 'CONFIG_TYPE_MISMATCH',
          layer,
          path,
          message: `${layer} 的「${path}」应当是对象，实际是 ${JSON.stringify(raw)}`,
        }))
      }
    }
  }
  walk(values, '')

  // 密钥禁令：写入侧拦不住手工编辑，而手工编辑是最常见的路径。
  const hits = findPlaintextSecretsInConfig(values)
  if (hits.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'error',
      code: 'CONFIG_PLAINTEXT_SECRET',
      layer,
      message: `${layer} 含疑似明文密钥（${hits.join(', ')}）：普通配置文件不得保存密钥（spec §6.7 / §6.11），` +
        '请改用 secretRef（security/secrets/）。',
    }))
  }
  return Object.freeze(diagnostics)
}

/**
 * 读三层配置文件并合并（不含 env 层；env 由调用方按 §6.11 作为最高优先层追加）。
 *
 * 返回 `{ ok, merged, layers, diagnostics, paths }`。`ok === false` 表示**不得继续**——
 * 要么某层文件坏了，要么有 error 级诊断。
 */
export function loadProductConfig(layout, {
  platform = layout?.platform,
  envValues = {},
  readFile = undefined,
  exists = existsSync,
  defaults = {},
  extraLayers = [],
} = {}) {
  const paths = configPaths(layout, { platform })
  const diagnostics = []
  const layers = [{ source: 'builtin-defaults', values: defaults }]

  for (const source of ['product-config', 'workspace-config', 'user-settings']) {
    const path = paths[source]
    if (path === null) {
      diagnostics.push(Object.freeze({
        severity: 'warn',
        code: 'CONFIG_LAYER_PATH_UNRESOLVED',
        layer: source,
        message: `配置层「${source}」对应的路径未确定（缺目录角色），本层被跳过`,
      }))
      continue
    }
    const read = readJsonFile(path, { readFile, exists })
    diagnostics.push(...read.diagnostics)
    if (read.values !== null) {
      diagnostics.push(...validateConfigValues(read.values, { layer: source }))
      layers.push({ source, values: read.values })
    }
  }

  for (const extra of extraLayers) layers.push(extra)

  if (Object.keys(envValues).length > 0) layers.push({ source: 'env', values: envValues })

  let merged
  try {
    merged = mergeConfigLayers(layers.filter((l) => CONFIG_LAYERS.includes(l.source)))
  } catch (e) {
    diagnostics.push(Object.freeze({ severity: 'error', code: 'CONFIG_MERGE_FAILED', message: e?.message ?? String(e) }))
    return Object.freeze({ ok: false, merged: null, layers: Object.freeze(layers), diagnostics: Object.freeze(diagnostics), paths })
  }

  const blocking = diagnostics.filter((d) => d.severity === 'error')
  return Object.freeze({
    ok: blocking.length === 0,
    merged,
    layers: Object.freeze(layers.map((l) => Object.freeze({ source: l.source, path: paths[l.source] ?? null }))),
    diagnostics: Object.freeze(diagnostics),
    paths,
  })
}

/** 取点号路径的值（不存在返回 undefined，与「值为 null」区分开）。 */
export function configValueAt(merged, dottedPath) {
  if (merged === null || typeof merged !== 'object') return undefined
  let cur = merged.value
  for (const part of String(dottedPath).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/** 某个键的生效层（未设置返回 null）。「这个值是谁给的」应当随时可回答。 */
export function configLayerOf(merged, dottedPath) {
  return provenanceOf(merged, dottedPath)
}

/**
 * 从合并后的配置派生 Launcher 输入。
 *
 * 只派生**已知**的映射，且把「谁给了这个值」一并返回：排障时最有用的一句话是
 * 「端口 9000 来自工作空间配置」，而不是「端口是 9000」。
 */
export function launcherInputFromConfig(merged, { base = {} } = {}) {
  const out = { ports: { ...(base.ports ?? {}) }, runtimeCommand: base.runtimeCommand ?? null, provenance: {} }
  for (const key of ['team-hub', 'workbench', 'runtime', 'whiteboard']) {
    const path = `ports.${key}`
    const v = configValueAt(merged, path)
    if (typeof v === 'number') {
      out.ports[key] = v
      out.provenance[path] = configLayerOf(merged, path)
    }
  }
  const command = configValueAt(merged, 'runtime.command')
  if (typeof command === 'string' && command.trim() !== '') {
    out.runtimeCommand = command.trim()
    out.provenance['runtime.command'] = configLayerOf(merged, 'runtime.command')
  }
  // 日志策略（PRT-709）。只接受**正的有限数**，且 `keepFiles` 必须是整数——
  // 与 `validateLogPolicy` 同一套判据。这里不合法的值**不进** logPolicy，
  // 由 `validateLogPolicy` 在 sink 那一层报 `LOG_BAD_POLICY`——
  // 两处各报一次比"这里静默纠正、那里看到的是纠正后的值"要好：
  // **一个被静默纠正的配置，用户会以为它生效了。**
  const logPolicy = {}
  for (const [path, key] of [
    ['log.maxFileBytes', 'maxFileBytes'],
    ['log.maxTotalBytes', 'maxTotalBytes'],
    ['log.keepFiles', 'keepFiles'],
    ['log.minFreeBytes', 'minFreeBytes'],
  ]) {
    const v = configValueAt(merged, path)
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue
    if (key === 'keepFiles' && !Number.isInteger(v)) continue
    logPolicy[key] = v
    out.provenance[path] = configLayerOf(merged, path)
  }
  if (Object.keys(logPolicy).length > 0) out.logPolicy = logPolicy

  const timeout = configValueAt(merged, 'launcher.readinessTimeoutMs')
  if (typeof timeout === 'number' && timeout > 0) {
    out.readinessTimeoutMs = timeout
    out.provenance['launcher.readinessTimeoutMs'] = configLayerOf(merged, 'launcher.readinessTimeoutMs')
  }
  return out
}

/** 默认的产品配置内容（首次运行时写入；**不含任何密钥**）。 */
export function defaultProductConfig({ version = '1' } = {}) {
  return {
    $schema: 'legion/product-config@1',
    configVersion: version,
    runtime: { command: '' },
    components: { whiteboard: { enabled: true } },
    launcher: { readinessTimeoutMs: 30000 },
  }
}

/** 写入前的统一门禁（复用 paths.mjs 的判据，不重写一份）。 */
export function assertWritableConfig(values) {
  return assertConfigWritable(values)
}
