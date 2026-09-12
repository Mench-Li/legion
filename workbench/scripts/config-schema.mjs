// config-schema.mjs — workbench（军团指挥台宿主）的配置声明（P3-2 统一配置系统）
//
// 依据：scripts/config/scan.mjs 扫出的真实读取点（workbench/scripts/*、workbench/src/*）。
// 注意其中一批键是经 `envBytes(name, def)` / `process.env[name]` **间接**读取的
//（P2-7 上传分片、P2-8 抓取缓存与配额），扫描器把它们识别为「疑似 env 字面量」后逐一声明在此。
import { defineSchema } from '../../packages/shared/src/config.mjs'

export const SCHEMA = defineSchema({
  process: 'workbench',
  title: '军团指挥台（workbench 宿主：静态托管 + /hub 代理 + 文件/浏览器 API）',
  prefixes: ['DSH_WORKBENCH_', 'DSH_WEB_', 'DSH_HUB_'],
  fields: [
    // ── 监听与鉴权（P3-2 统一项）──
    // 0 合法（Node listen(0) = OS 分配空闲端口）；契约测试有用 `?root=` + 导入式用法，勿收紧为 >= 1
    { key: 'port', env: 'DSH_WORKBENCH_PORT', cli: 'port', type: 'int', default: 5173, min: 0, max: 65535, doc: '监听端口（生产实例默认 5173；0 = 由 OS 分配）' },
    { key: 'host', env: 'DSH_WORKBENCH_HOST', cli: 'host', type: 'string', default: '127.0.0.1', doc: '监听地址' },
    { key: 'token', env: 'DSH_WORKBENCH_TOKEN', cli: 'token', type: 'string', default: '', sensitive: true, doc: '写操作鉴权 token（文件写/删除等）' },
    { key: 'teamHubToken', env: 'TEAM_HUB_TOKEN', type: 'string', default: '', sensitive: true, doc: '调用 team-hub 读接口用的 token（须与 hub 的 TEAM_HUB_TOKEN 一致）' },
    // ── 上游与静态产物（P3-2 统一项：附件/产物目录）──
    { key: 'hubUpstream', env: 'DSH_HUB_UPSTREAM', type: 'string', default: 'http://127.0.0.1:8787', doc: 'team-hub 上游地址（/hub/* 反向代理目标）' },
    { key: 'staticRoot', env: 'DSH_WORKBENCH_ROOT', type: 'path', default: '', doc: '静态产物根（空=workbench/dist 内置默认；P3-1 修补引入，供产物缺失场景测试）' },
    { key: 'spacesJson', env: 'DSH_WORKBENCH_SPACES_JSON', type: 'path', default: '', doc: '空间定义 JSON 路径（默认内置）' },
    // ── 文件中心（P2-7）──
    { key: 'maxUpload', env: 'DSH_WORKBENCH_MAX_UPLOAD', type: 'int', default: 64 * 1024 * 1024, min: 1, doc: '单文件上传上限（字节）' },
    { key: 'maxUploadTotal', env: 'DSH_WORKBENCH_MAX_UPLOAD_TOTAL', type: 'int', default: 1024 * 1024 * 1024, min: 1, doc: '分片上传总上限（字节）' },
    { key: 'chunkSize', env: 'DSH_WORKBENCH_CHUNK_SIZE', type: 'int', default: 4 * 1024 * 1024, min: 1, doc: '建议分片大小（前端据此切片）' },
    { key: 'revealDry', env: 'DSH_WORKBENCH_REVEAL_DRY', type: 'bool', default: false, doc: '「打开所在位置」演练模式：只回传将执行的打开器与落点、不真的拉起文件管理器（契约测试用）' },
    // ── 浏览器助手（P2-8）──
    { key: 'fetchAllowPrivate', env: 'DSH_WEB_FETCH_ALLOW_PRIVATE', type: 'bool', default: false, doc: '允许抓取私网地址（默认关闭；仅测试用）' },
    { key: 'cacheTtlMs', env: 'DSH_WEB_CACHE_TTL_MS', type: 'int', default: 5 * 60 * 1000, min: 1, doc: '抓取缓存 TTL（ms，进程内）' },
    { key: 'cacheMax', env: 'DSH_WEB_CACHE_MAX', type: 'int', default: 200, min: 1, doc: '抓取缓存条目上限（进程内）' },
    { key: 'quotaSpaceRpm', env: 'DSH_WEB_QUOTA_SPACE_RPM', type: 'int', default: 30, min: 1, doc: '单空间每分钟抓取次数上限' },
    { key: 'quotaConcurrency', env: 'DSH_WEB_QUOTA_CONCURRENCY', type: 'int', default: 3, min: 1, doc: '单空间并发抓取上限' },
    { key: 'quotaHostRpm', env: 'DSH_WEB_QUOTA_HOST_RPM', type: 'int', default: 30, min: 1, doc: '单 host 每分钟抓取次数上限' },
    { key: 'quotaDailyBytes', env: 'DSH_WEB_QUOTA_DAILY_BYTES', type: 'int', default: 200 * 1024 * 1024, min: 1, doc: '单空间每日抓取字节上限' },
    { key: 'auditFile', env: 'DSH_WEB_AUDIT_FILE', type: 'path', default: '', doc: '抓取审计文件路径（空=默认 data/web-audit.jsonl）' },
    { key: 'auditMaxBytes', env: 'DSH_WEB_AUDIT_MAX_BYTES', type: 'int', default: 5 * 1024 * 1024, min: 1, doc: '抓取审计文件轮转阈值（字节）' },
    { key: 'shotEnable', env: 'DSH_WEB_SHOT_ENABLE', type: 'bool', default: false, doc: '启用截图能力（默认关闭；需本机浏览器）' },
    { key: 'shotBrowser', env: 'DSH_WEB_SHOT_BROWSER', type: 'path', default: '', doc: '截图用的浏览器可执行文件路径（空=自动探测）' },
    { key: 'shotDir', env: 'DSH_WEB_SHOT_DIR', type: 'path', default: '', doc: '截图输出目录（空=data/web-shots）' },
  ],
  // `envBytes(name, def)` 与配置读取辅助里的 `process.env[name]`（键名来自上面的字面量）
  dynamicEnvReads: [
    { file: 'workbench/scripts/serve.mjs', expr: 'process.env[name]', reason: 'envBytes(name, def) 通用读取器；name 均为上方已声明的 DSH_* 字面量' },
    { file: 'workbench/scripts/serve.mjs', expr: 'process.env[env[name]]', reason: '配置读取辅助按映射表取 env；键名集合已在上方声明' },
  ],
  nonEnvLiterals: [
    'DELETE', 'OPTIONS', 'PATCH', 'ENOENT', 'ENOTDIR', 'INCOMPLETE', 'OFFSET_MISMATCH', 'SIGINT', 'SIGTERM',
  ],
  // 前缀撞名的外部变量：DSH 宿主自己用 DSH_WEB_URL 表示「Web GUI 地址」，
  // 与 workbench 的 DSH_WEB_*（P2-8 浏览器助手配置）同名空间重叠。它不属于 workbench 的配置面，
  // 显式登记以免 config check 误报「拼写错误」。
  foreignEnv: [
    { name: 'DSH_WEB_URL', owner: 'DSH 宿主', reason: 'DSH Web GUI 地址；与 workbench 的 DSH_WEB_* 前缀撞名但语义无关' },
  ],
  notes: [
    'workbench 的 TEAM_HUB_TOKEN 与 team-hub 的 TEAM_HUB_TOKEN 是同一个环境变量：一次配置、两边生效。',
    '静态根 DSH_WORKBENCH_ROOT 仅在产物不按默认路径放置时需要设置。',
    'DSH_WEB_* 前缀与 DSH 宿主存在重叠（宿主用 DSH_WEB_URL 表示 GUI 地址）；workbench 自己的浏览器助手变量见上表。',
  ],
})

export default SCHEMA
