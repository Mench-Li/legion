// config-schema.mjs — 看板插件（board-plugin/）的配置声明（P3-4 插件配置面统一）
//
// 边界：board-plugin 的**主配置面是宿主 composition**（hubUrl / routePrefix / scrumDir / hubToken …，
// 见 `~/.dsh/profiles/web/cordis.patch.yml`），本 schema 不接管。这里只声明它**从进程环境读取**的项。
// board-plugin 是纯 .ts（无运行时配置解析代码），因此本文件是**声明 + 校验**用途：
//   · `scan --check` 保证「新增 env 读取点必须登记」，不会悄悄长出配置面；
//   · `check.mjs` 与跨进程规则据此核对 board-plugin 与 team-hub 的 token 是否一致。
import { defineSchema } from '../packages/shared/src/config.mjs'

export const SCHEMA = defineSchema({
  process: 'board-plugin',
  title: 'Scrum 看板插件（board-plugin/：宿主 iframe 面板 + 写接口）',
  // 不声明 env 前缀：本插件只从环境取 TEAM_HUB_TOKEN，而 TEAM_HUB_* 下的其余变量属于 team-hub 自己
  //（由 services-plugin 注入给 team-hub 子进程）。声明前缀会把别的进程的变量误报成「拼写错误」。
  prefixes: [],
  fields: [
    {
      key: 'hubToken', env: 'TEAM_HUB_TOKEN', type: 'string', default: '', sensitive: true,
      doc: 'hub 鉴权 token；优先级：composition 的 config.hubToken > 本环境变量 > 空',
    },
  ],
  foreignEnv: [
    { name: 'TEAM_HUB_HOST', owner: 'team-hub / services-plugin', reason: '监听地址，看板插件不读（走 composition 的 hubUrl）' },
    { name: 'TEAM_HUB_PORT', owner: 'team-hub / services-plugin', reason: '监听端口，看板插件不读（走 composition 的 hubUrl）' },
    { name: 'TEAM_HUB_DB', owner: 'team-hub', reason: '数据库路径，看板插件不读' },
  ],
  // scan --check 会把源码里的全大写字符串字面量当「疑似 env」，这两个是纯错误码/方法名
  nonEnvLiterals: ['ENOENT', 'OPTIONS'],
  notes: [
    'hub 模式下的实际上游由 composition 的 hubUrl 决定；未配时探测同宿主 /team-hub（P1-3 现场修复）。',
    '本 schema 只覆盖环境变量面：composition 里的 hubToken 是插件主配置面，check.mjs 看不到它。',
  ],
})

export default SCHEMA
