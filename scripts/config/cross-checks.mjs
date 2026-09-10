// cross-checks.mjs — 跨进程配置一致性检查（P3-2）
//
// 单进程 schema 只能校验「自己这一份」；真正出事故的往往是**跨进程不一致**：
// 端口撞车、workbench 代理到错的 hub、hub 要 token 而 workbench 没配、非回环却没配 token、
// 静态产物缺失（P3-1 实测过：产物缺失时 GET / 会失败/404，但进程本身照常启动，问题被推迟到用户侧）。
//
// 规则是数据驱动的：每条给出 level / code / message / hint，便于 CI 与文档引用。
// 只读已解析并**已脱敏**的配置（不读取任何原始 secret）。

/** 从 URL 里安全取端口（解析失败返回 null，由调用方决定如何处理） */
export function urlPort(url, fallback = null) {
  try { return new URL(url).port ? Number(new URL(url).port) : fallback } catch { return null }
}

/** 是否「会对非本机暴露」的监听地址 */
export function isExposed(host) {
  if (!host) return false
  const h = String(host).trim().toLowerCase()
  return !(h === '127.0.0.1' || h === 'localhost' || h === '::1')
}

/**
 * 运行全部跨进程规则。
 * @param {Record<string, {schema, resolved}>} configs 三进程已解析的配置
 * @param {{existsFn?: (p: string) => boolean}} opts 可注入文件存在性判断（便于测试）
 * @returns {{level:'error'|'warning', code:string, message:string, hint?:string}[]}
 */
export function runCrossChecks(configs, opts = {}) {
  const existsFn = opts.existsFn ?? (() => true)
  const out = []
  const push = (level, code, message, hint) => out.push({ level, code, message, hint })
  const hub = configs['team-hub']
  const wb = configs.workbench
  const board = configs.whiteboard
  const boardPlugin = configs['board-plugin']
  const services = configs['services-plugin']

  // ① 监听端口冲突（同 host 同 port 不可能同时监听成功）
  const listeners = [
    ['team-hub', hub],
    ['workbench', wb],
    ['whiteboard', board],
  ].filter(([, c]) => c)
  for (let i = 0; i < listeners.length; i += 1) {
    for (let j = i + 1; j < listeners.length; j += 1) {
      const [na, ca] = listeners[i]
      const [nb, cb] = listeners[j]
      if (ca.resolved.values.port === cb.resolved.values.port) {
        push('error', 'port_conflict',
          `${na} 与 ${nb} 监听同一端口 ${ca.resolved.values.port}（环境变量 ${ca.schema.field('port').env} / ${cb.schema.field('port').env}）`,
          '两者无法同时启动；请用各自的环境变量或 CLI --port 分开')
      }
    }
  }

  // ② workbench → hub 上游必须指向 hub 实际端口
  if (wb && hub) {
    const up = wb.resolved.values.hubUpstream
    const p = urlPort(up)
    if (p === null) {
      push('warning', 'hub_upstream_unparsable', `workbench 的 hub 上游地址无法解析端口：${up}`, '形如 http://127.0.0.1:8787')
    } else if (p !== hub.resolved.values.port) {
      push('error', 'hub_upstream_port_mismatch',
        `workbench 的 hub 上游端口 ${p} 与 team-hub 监听端口 ${hub.resolved.values.port} 不一致（/hub/* 代理会连不上）`,
        `设置 DSH_HUB_UPSTREAM=http://127.0.0.1:${hub.resolved.values.port} 或调整 TEAM_HUB_PORT`)
    }
  }

  // ③ workbench 调 hub 用的 token 必须与 hub 的一致（hub 配了 token 而 workbench 没有 → 读接口 401）
  if (wb && hub) {
    const hubTok = hub.resolved.values.token
    const wbTok = wb.resolved.values.teamHubToken
    if (hubTok && !wbTok) {
      push('error', 'hub_token_missing_in_workbench',
        'team-hub 已配置 token，但 workbench 未配置 TEAM_HUB_TOKEN（workbench 调 hub 读接口会 401）',
        '给 workbench 进程设置同一个 TEAM_HUB_TOKEN（同一环境变量，一次配置两边生效）')
    } else if (hubTok && wbTok && hubTok !== wbTok) {
      push('error', 'hub_token_mismatch',
        'workbench 的 TEAM_HUB_TOKEN 与 team-hub 的 token 不一致（workbench 调 hub 会 401）',
        '两进程必须使用同一个 TEAM_HUB_TOKEN 值')
    } else if (!hubTok && wbTok) {
      push('warning', 'hub_token_unused', 'workbench 配了 TEAM_HUB_TOKEN 但 team-hub 未配 token（hub 当前不鉴权）', '若 hub 对外暴露，建议两处同时配置')
    }
  }

  // ④ 非回环监听必须配 token（两个服务各自会拒绝启动，这里提前在配置面报出来）
  for (const [name, c] of listeners) {
    const tok = c.resolved.values.token
    if (isExposed(c.resolved.values.host) && !tok) {
      push('error', 'exposed_without_token',
        `${name} 监听地址 ${c.resolved.values.host} 会对非本机暴露，但未配置 token`,
        `设置 ${c.schema.field('token').env}，或把 host 改回 127.0.0.1`)
    }
  }

  // ⑤ 静态产物缺失（P3-1 实测坑：进程照常启动，用户侧才 404/断流）
  //    未显式配置时按内置默认路径检查——「产物缺失」正是最常见于默认配置的情形。
  if (wb) {
    const root = wb.resolved.values.staticRoot || 'workbench/dist'
    if (!existsFn(root)) {
      push('warning', 'static_root_missing',
        `workbench 静态产物目录不存在：${root}（浏览器访问 / 会 404，API 仍可用）`,
        '先在 workbench 下执行 vite build，或设置 DSH_WORKBENCH_ROOT 指向已构建目录')
    }
  }

  // ⑥ 白板房间目录与默认库路径重叠（把 DB_PATH 指进 roomsDir 会让房间文件被当成默认库清理/混淆）
  if (board) {
    const dir = String(board.resolved.values.roomsDir ?? '').replace(/\\/g, '/')
    const db = String(board.resolved.values.dbPath ?? '').replace(/\\/g, '/')
    if (dir && db && db !== ':memory:' && db.startsWith(dir.endsWith('/') ? dir : dir + '/')) {
      push('warning', 'db_inside_rooms_dir',
        `白板 DB_PATH（${db}）位于房间目录 WB_ROOMS_DIR（${dir}）之内，房间文件与默认库会混在一起`,
        '把 DB_PATH 放到房间目录之外，或统一使用房间存储')
    }
  }

  // ⑦ workbench 写鉴权缺失提醒（只读部署可接受，故仅提示）
  if (wb && !wb.resolved.values.token) {
    push('warning', 'workbench_token_unset', 'workbench 未配置 DSH_WORKBENCH_TOKEN：文件写/删除等写操作将拒绝（预期用于只读部署）', '需要写操作时设置该变量')
  }

  // ⑧ services-plugin 托管启动会**覆盖**子进程的同名 env / CLI（P3-4）
  //    真实陷阱：托管启动的 team-hub 端口来自 composition 的 teamHubPort（缺省 8787），
  //    该进程根本不读 TEAM_HUB_PORT 环境变量——所以「环境里改成 9000」并不会改变托管实例，
  //    而单进程 schema 只会如实报告 9000。这里把两者摆在一起，结论才不会与现场相反。
  if (services) {
    for (const inj of services.schema.injects ?? []) {
      const targetCfg = configs[inj.target]
      if (!targetCfg || inj.value === undefined) continue
      const viaCli = inj.via === 'cli'
      const field = (targetCfg.schema.fields ?? []).find((f) => (viaCli ? f.cli === inj.cli : f.env === inj.env))
      if (!field) continue
      const envValue = String(targetCfg.resolved.values[field.key])
      const injected = String(inj.value)
      if (envValue === injected) continue
      push('warning', 'services_inject_overrides_env',
        `${inj.target} 由 services-plugin 托管启动时会注入 ${inj.env}=${injected}${viaCli ? '（命令行 --' + inj.cli + '，优先级高于环境变量）' : ''}，` +
          `与环境解析值 ${envValue} 不一致：托管实例实际生效的是注入值`,
        `改 ${inj.target} 侧的环境变量对托管实例无效；请改 legion-services 的 config.${inj.from ?? inj.env}（或手工启动该进程）`)
    }
  }

  // ⑨ 看板插件从环境回落的 hub token 为空，而团队中枢已要求 token → hub 模式下写操作会 401
  //    （composition 的 config.hubToken 可能已兜底，所以是 warning 而非 error）
  if (boardPlugin && hub && hub.resolved.values.token && !boardPlugin.resolved.values.hubToken) {
    push('warning', 'plugin_hub_token_unset',
      'team-hub 已配置 token，但 board-plugin 未从环境拿到 TEAM_HUB_TOKEN（若 composition 的 config.hubToken 也没配，hub 模式下写操作会 401）',
      '给宿主进程设置同一个 TEAM_HUB_TOKEN，或在 legion-scrum-board 的 config.hubToken 里配置')
  }

  // ⑩ 士兵守护的提示词预算之间的一致性**不在这里**：它是 plugins 自己的 schema 规则
  //    （plugins/config-schema.mjs 的 normsAndCtxRules），单进程 check 与插件启动摘要都会报，
  //    在这里再报一次只会得到同一条结论的副本。

  return out
}

export const CROSS_CHECK_CODES = Object.freeze([
  'port_conflict', 'hub_upstream_unparsable', 'hub_upstream_port_mismatch',
  'hub_token_missing_in_workbench', 'hub_token_mismatch', 'hub_token_unused',
  'exposed_without_token', 'static_root_missing', 'db_inside_rooms_dir', 'workbench_token_unset',
  // P3-4 插件族（plugins 自身的预算一致性由 plugins/config-schema.mjs 的 rules 覆盖，不在此重复）
  'services_inject_overrides_env', 'plugin_hub_token_unset',
])

export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1'])
