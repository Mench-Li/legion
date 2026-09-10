// config-schema.mjs — 服务托管插件（services-plugin/）的配置声明（P3-4 插件配置面统一）
//
// 它与其他进程的关系是**反向**的：它不监听端口、不读业务配置，而是替三个进程决定「启动时拿到什么环境」。
// 因此本 schema 除了声明它**读取**的 env，还声明它**注入**的 env/CLI（`injects`）——
// 否则 check.mjs 会给出与现场相反的结论：环境里 `TEAM_HUB_PORT=9000` 时，托管启动的 team-hub
// 实际仍被注入插件配置项 teamHubPort（缺省 8787），因为该进程**不读** TEAM_HUB_PORT 这个环境变量。
//
// 读取点依据 scripts/config/scan.mjs（services-plugin/index.js 的 `baseEnv.*` 间接读取）。
import { defineSchema } from '../packages/shared/src/config.mjs'

export const DEFAULT_TEAM_HUB_PORT = 8787
export const DEFAULT_TEAM_HUB_HOST = '127.0.0.1'
export const DEFAULT_HUB_UPSTREAM = 'http://127.0.0.1:8787'
export const DEFAULT_WORKBENCH_PORT = 5173

export const SCHEMA = defineSchema({
  process: 'services-plugin',
  title: '军团服务托管插件（services-plugin/：随 Desktop 启停 team-hub / workbench）',
  // 不声明前缀：TEAM_HUB_* / DSH_* 下的大量变量属于被托管进程，与本插件无关。
  prefixes: [],
  fields: [
    {
      key: 'teamHubHost', env: 'TEAM_HUB_HOST', type: 'string', default: DEFAULT_TEAM_HUB_HOST,
      doc: '注入给 team-hub 子进程的监听地址；优先级：composition 的 config.teamHubHost > 本环境变量 > 127.0.0.1',
    },
    {
      key: 'teamHubToken', env: 'TEAM_HUB_TOKEN', type: 'string', default: '', sensitive: true,
      doc: '注入给 team-hub / workbench 子进程的 token；优先级：composition 的 config.teamHubToken > 本环境变量 > 空',
    },
    {
      key: 'hubUpstream', env: 'DSH_HUB_UPSTREAM', type: 'string', default: DEFAULT_HUB_UPSTREAM,
      doc: '注入给 workbench 子进程的 hub 上游地址；优先级：composition 的 config.hubUpstream > 本环境变量 > 默认',
    },
  ],
  injects: [
    {
      target: 'team-hub', env: 'TEAM_HUB_PORT', via: 'env', value: String(DEFAULT_TEAM_HUB_PORT), from: 'teamHubPort',
      note: '取值来自 composition 的 config.teamHubPort（**不读** TEAM_HUB_PORT 环境变量），缺省 8787',
    },
    { target: 'team-hub', env: 'TEAM_HUB_HOST', via: 'env', from: 'teamHubHost', note: '回落到同环境变量' },
    { target: 'team-hub', env: 'TEAM_HUB_TOKEN', via: 'env', from: 'teamHubToken', note: '回落到同环境变量（为空也会显式注入空值）' },
    { target: 'workbench', env: 'DSH_HUB_UPSTREAM', via: 'env', from: 'hubUpstream', note: '回落到同环境变量' },
    { target: 'workbench', env: 'TEAM_HUB_TOKEN', via: 'env', from: 'teamHubToken', note: '回落到同环境变量' },
    {
      target: 'workbench', env: 'DSH_WORKBENCH_PORT', via: 'cli', cli: 'port', value: String(DEFAULT_WORKBENCH_PORT), from: 'workbenchPort',
      note: '以 workbench 的 `--port` 参数注入（CLI 优先级高于环境变量），取值来自 composition 的 config.workbenchPort，缺省 5173',
    },
  ],
  notes: [
    '每个子进程都带着 `{ ...process.env }` 启动，因此未被本插件显式覆盖的环境变量照常透传。',
    '端口已有服务在监听时会跳过启动（不自愈到别的端口）：托管实例与手工实例可以共存，但不会被“接管”。',
  ],
})

export default SCHEMA
