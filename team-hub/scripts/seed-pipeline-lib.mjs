// team-hub/scripts/seed-pipeline-lib.mjs
// ============================================================================
// `seed-pipeline.mjs` 的**纯**部分：命令行解析、令牌解析、鉴权头、失败措辞。
//
// ## 为什么要拆出来（BUG-049 的另一半）
//
// 2026-11-20：界面在"空间不会自动开工"时给出的修复命令就是
//
//     node team-hub/scripts/seed-pipeline.mjs --scope <id> --file <roles.json>
//
// 而**这台机器上它必然失败**：中枢开着 `LEGION_REMOTE_AUTH=1`（远程门禁要求
// 用户令牌/机器令牌），脚本却一个 Authorization 头都不带 —— 第一条
// `GET /api/pipeline` 就 401，输出只有一句「读取现值失败：HTTP 401」。
//
//   > 一条"修复命令"跑不通，与没有这条修复命令，区别只在于前者会让人
//   > 反复试它、从而以为"是我哪里抄错了"。
//
// 修法两条：① 脚本支持令牌（`--token` / 环境变量），② 401/403 时说清
// "这是鉴权没带/不对"以及**去哪儿拿**（而不是把 401 原样丢出去）。
//
// 这些是纯函数，所以可以真的被用例钉住（脚本本体有顶层 await，不好 import）。
// ============================================================================

/**
 * 取一个 `--name <value>` / `--name=<value>` 参数。
 *
 * 与旧实现（脚本里那份 `argOf`）基本同义：找不到 → `fallback`；
 * 下一个词以 `--` 开头 → 也当 `fallback`（那是下一个开关，不是这个的值）。
 *
 * 新增的两处：① `--name=value` 这一种写法（超集，不改变既有用法）；
 * ② `--name` 后面**没有值**时返回 `fallback`（旧实现会返回字符串 `'true'`，
 *    等于把一个开关当成了值送下去）。这两处都不改变本脚本的实际行为：
 *    缺值时就该说"缺少参数"，而不是拿 `'true'` 去当 scope。
 */
export function argOf(argv, name, fallback = '') {
  const flag = '--' + name
  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] ?? '')
    if (item === flag) {
      const next = argv[i + 1]
      return next !== undefined && !String(next).startsWith('--') ? String(next) : fallback
    }
    if (item.startsWith(flag + '=')) {
      const inline = item.slice(flag.length + 1)
      return inline.length > 0 ? inline : fallback
    }
  }
  return fallback
}

/** 有没有这个开关（`--apply` / `--dry-run` 这类无值开关）。 */
export function hasFlag(argv, name) {
  const flag = '--' + name
  return argv.some((it) => String(it ?? '') === flag)
}

/**
 * 令牌从哪来：`--token` > `LEGION_HUB_TOKEN` > `TEAM_HUB_TOKEN` > 没有。
 *
 * 三个来源是有意排序的：命令行最明确（一次性的、能写进 runbook），
 * 其次是**本仓自己的**变量名，最后才是中枢进程用的那个（有的部署只导出它）。
 * 空串/纯空白一律当"没有"，免得把 `Bearer ` 这种空令牌送上去——那会得到一个
 * 401，而"我明明给了令牌"会让排查往错的方向走一大步。
 */
export function resolveAuth({ argv = [], env = {} } = {}) {
  const fromFlag = String(argOf(argv, 'token', '') ?? '').trim()
  if (fromFlag.length > 0) return { token: fromFlag, source: 'flag' }
  for (const key of ['LEGION_HUB_TOKEN', 'TEAM_HUB_TOKEN']) {
    const value = String(env[key] ?? '').trim()
    if (value.length > 0) return { token: value, source: 'env:' + key }
  }
  return { token: '', source: 'none' }
}

/** 鉴权头：没有令牌时**空对象**（本机未开鉴权的中枢照旧能用）。 */
export function authHeaders(token) {
  const value = String(token ?? '').trim()
  return value.length > 0 ? { authorization: 'Bearer ' + value } : {}
}

/**
 * 非 200 时的可执行措辞（`null` = 200，调用方不用改口）。
 *
 * 401/403 单独说：这两个状态码在**开了远程门禁的中枢上**是"你没带令牌 / 令牌不对"，
 * 而在本机没开鉴权的部署上根本不会出现 —— 混在"读取失败：HTTP 401"里，
 * 人会去查中枢是否启动（那是错的答案）。
 */
export function explainFailure({ status, body = '', hub = 'http://127.0.0.1:8787', scope = '' } = {}) {
  if (status === 200) return null
  const snippet = String(body ?? '').replace(/\s+/g, ' ').slice(0, 200)
  if (status === 401 || status === 403) {
    return `鉴权没通过（HTTP ${status}）：这台中枢开了远程鉴权（LEGION_REMOTE_AUTH=1），`
      + '所以**每一次读写都要带令牌**。加上令牌重跑：\n'
      + `  node team-hub/scripts/seed-pipeline.mjs --scope ${scope || '<id>'} --file <roles.json> --token <中枢机器令牌>\n`
      + '  或先 export LEGION_HUB_TOKEN=<中枢机器令牌>（值见 DSH profile 里的 teamHubToken，属于机密，别贴进聊天/日志）\n'
      + `  服务端说：${snippet || '（无正文）'}`
  }
  if (status === 404) {
    return `HTTP 404：${hub} 上没有这个接口（中枢版本过旧？）——服务端说：${snippet || '（无正文）'}`
  }
  return `HTTP ${status}：${snippet || '（无正文）'}`
}
