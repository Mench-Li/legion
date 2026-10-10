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
    {
      key: 'dshWebUrl', env: 'DSH_WEB_URL', type: 'string', default: '',
      doc: '宿主自身的 GUI 地址（只读兜底）：拿不到 ctx.webServer.port 时用它派生给 workbench 的 DSH_MODELS_BASE_URL',
    },
    // ── P3/P4：模型配置的派生物化（DECISION-legion-owns-model-config） ──
    // 这三个都是**本插件自己读**、控制"要不要把 Legion 的目录写进 DSH 的活配置"的开关。
    {
      key: 'applyModelConfig', env: 'LEGION_APPLY_MODEL_CONFIG', type: 'bool', default: false,
      doc: 'P3 接管门：为真才把 Legion 的供应商目录写进 DSH 的 llm-pi-ai（**默认关**）。'
        + '这条链上唯一不可逆的一段，所以"能写"与"在写"之间隔着一个显式开关 —— 也接受 composition 的 config.applyModelConfig',
    },
    {
      key: 'applyModelConfigDeletes', env: 'LEGION_APPLY_MODEL_CONFIG_DELETES', type: 'bool', default: false,
      doc: 'P3 的**第二道门**：为真才 unset 掉"Legion 里没有、DSH 里活着"的供应商（默认只报告不执行）。'
        + '单独一道门是因为整块 unset 的逆操作只能还原读者看得见的叶子',
    },
    {
      key: 'reconcileIntervalMs', env: 'LEGION_RECONCILE_INTERVAL_MS', type: 'int', default: 300000,
      doc: 'P4 周期收敛的间隔（毫秒）；**显式给 0 表示只要启动时收敛一次**，不排周期。'
        + '注意这里 0 是有效值（与 num() 的"0 视为没给"不同）：把 0 当成"没给"会让"我想关掉周期"静默变成"用默认周期"',
    },
    {
      key: 'workspaceDir', env: 'LEGION_WORKSPACE_DIR', type: 'path', default: '',
      doc: '工作区（用户授权的项目目录）：**只透传**给 team-hub，不编默认值（规范 §6.11 明确工作区不提供默认值）。'
        + '它是 team-hub 解析产品目录布局的一部分；安装目录（LEGION_INSTALL_DIR）则由本插件按 legionDir 直接注入',
    },
    // ── 手机/远程访问：让"人不在电脑前也能操控任务"有产品配置入口 ──
    //
    // ★ 在此之前，这两个开关**只能靠宿主进程的环境变量**才能生效：本插件只给 team-hub 注入
    //    PORT / HOST / TOKEN 三个键，而手机面与远程门禁读的是 `identityKey` / `remoteAuth`。
    //    后果与 BUG-016 是同一类 —— **功能存在、但没有入口**：用户只能去改系统环境变量，
    //    而那条路既不在产品里、也不在配置门禁的视野里（改错了没有任何东西会响）。
    //
    //    语义（正本在 team-hub/config-schema.mjs）：
    //      · `identityKey` 留空 ⇒ **关闭**远程 Agent 通道：手机面静态资源与身份系统全都注册不上，
    //        `/mobile` 得到 404；>=16 字符 ⇒ 开启。
    //      · `remoteAuth='1'` ⇒ 除公开白名单外全部 `/api/*` 要求**用户访问令牌**；
    //        上游文档原话是"Hub 绑回环 + 反代时必须开" —— 这正是手机场景的推荐形态。
    //
    //    ★ 安全提醒写在这里，因为这是配置的人唯一会看的地方：`teamHubToken` 留空时
    //      team-hub 的 `authorized()` 对**任何**写请求都放行（`TOKEN === '' → return true`）。
    //      所以任何形式的对外暴露（隧道/反代）都必须同时给 `teamHubToken` 一个值。
    {
      key: 'teamHubIdentityKey', env: 'LEGION_IDENTITY_KEY', type: 'string', default: '', sensitive: true,
      doc: '注入给 team-hub 的身份签名密钥（>=16 字符）—— **手机面与身份系统的总开关**，留空即关闭。'
        + '优先级：composition 的 config.teamHubIdentityKey > 本环境变量 > 空。'
        + '换掉它会作废已签发的访问令牌（手机需重新登录）',
    },
    {
      key: 'teamHubRemoteAuth', env: 'LEGION_REMOTE_AUTH', type: 'string', default: '',
      doc: "注入给 team-hub 的远程门禁开关：设为 '1' 时除公开白名单外全部 /api/* 要求用户访问令牌。"
        + '**对外暴露（隧道/反代）时必须为 1**；纯本地单机可以留空',
    },
  ],
  // 本文件自己会被扫描（dirs 含整个 services-plugin/）：injects 里的 `TEAM_HUB_PORT` /
  // `DSH_WORKBENCH_PORT` / `DSH_MODELS_BASE_URL` / `LEGION_INSTALL_DIR` 是**注入目标的变量名**
  // （给 team-hub 用的），不是本进程的读取点，故显式排除，否则 `scan --check` 会要求把它们
  // 当成读取点登记（P3-4 实测：这正是「未处理字面量」的两项）。
  nonEnvLiterals: ['TEAM_HUB_PORT', 'DSH_WORKBENCH_PORT', 'DSH_MODELS_BASE_URL', 'LEGION_INSTALL_DIR'],
  injects: [
    {
      target: 'team-hub', env: 'TEAM_HUB_PORT', via: 'env', value: String(DEFAULT_TEAM_HUB_PORT), from: 'teamHubPort',
      note: '取值来自 composition 的 config.teamHubPort（**不读** TEAM_HUB_PORT 环境变量），缺省 8787',
    },
    { target: 'team-hub', env: 'TEAM_HUB_HOST', via: 'env', from: 'teamHubHost', note: '回落到同环境变量' },
    { target: 'team-hub', env: 'TEAM_HUB_TOKEN', via: 'env', from: 'teamHubToken', note: '回落到同环境变量（为空也会显式注入空值）' },
    {
      target: 'team-hub', env: 'LEGION_IDENTITY_KEY', via: 'env', from: 'teamHubIdentityKey',
      note: '手机面/身份系统总开关（>=16 字符才开启）。**只在有值时才注入** —— 注入空串会把宿主环境里的值盖掉',
    },
    {
      target: 'team-hub', env: 'LEGION_REMOTE_AUTH', via: 'env', from: 'teamHubRemoteAuth',
      note: "远程门禁（'1' 才开）。同样只在有值时才注入",
    },
    { target: 'workbench', env: 'DSH_HUB_UPSTREAM', via: 'env', from: 'hubUpstream', note: '回落到同环境变量' },
    { target: 'workbench', env: 'TEAM_HUB_TOKEN', via: 'env', from: 'teamHubToken', note: '回落到同环境变量' },
    {
      target: 'workbench', env: 'DSH_MODELS_BASE_URL', via: 'env', from: 'ctx.webServer.port',
      note: '**派生值**：模型配置 Remote 必须指向本次启动的宿主（Desktop 实测 19387），而不是默认 3080 —— 写死时「供应商与模型」整页读不出来（Bug #1）',
    },
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
