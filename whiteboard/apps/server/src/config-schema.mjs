// config-schema.mjs — whiteboard 的配置声明（P3-2 统一配置系统）
//
// 依据：scripts/config/scan.mjs 扫出的**真实读取点**（apps/server/src 与 scripts/），
// 不是照文档抄的。新增 env 读取必须同时补进本文件，否则 `scan --check` 会失败。
//
// 引擎位置说明：白板是**独立可部署子项目**（Dockerfile 构建上下文 = whiteboard/，只 COPY
// packages/apps/scripts），因此不能 import 仓库根的 packages/shared，只能使用本地副本
// packages/shared/src/config.mjs（由 scripts/config/sync.mjs 与根引擎保持字节一致，CI 校验）。
import { defineSchema } from '../../../packages/shared/src/config.mjs'

/** WHITEBOARD_ROOMS 形如 `roomId:token:role,...`：摘要里保留房间与角色，隐去每房间 token。
 *  否则启动摘要会把房间密钥写进日志（P3-2 单测抓到过这个泄漏）。 */
function maskRoomTokens(value) {
  if (!value) return ''
  return String(value).split(',').map((entry) => {
    const parts = entry.split(':')
    if (parts.length >= 2 && parts[1]) parts[1] = '***'
    return parts.join(':')
  }).join(',')
}

export const SCHEMA = defineSchema({
  process: 'whiteboard',
  title: '协作白板（独立子项目，单实例多房间）',
  prefixes: ['WB_', 'WHITEBOARD_', 'BENCH_'],
  fields: [
    // ── 监听与鉴权（P3-2 统一项：token / host / port / DB 路径）──
    // 0 合法：Node listen(0) = OS 分配空闲端口（bench/冒烟起临时服务时可用）
    { key: 'port', env: 'PORT', cli: 'port', type: 'int', default: 8080, min: 0, max: 65535, doc: '监听端口（0 = 由 OS 分配）' },
    { key: 'host', env: 'HOST', cli: 'host', type: 'string', default: '127.0.0.1', doc: '监听地址；非回环必须配 token' },
    { key: 'token', env: 'WHITEBOARD_TOKEN', cli: 'token', type: 'string', default: '', sensitive: true, doc: '全局 token（未单独声明 token 的房间都用它）' },
    { key: 'ttlMs', env: 'TTL_MS', type: 'int', default: 10000, min: 1, doc: 'presence 陈旧判定（ms）' },
    // ── 存储 ──
    { key: 'dbPath', env: 'DB_PATH', type: 'path', default: 'apps/server/data/whiteboard.db', doc: '默认/兼容数据库路径；:memory: 时房间也走内存' },
    { key: 'roomsDir', env: 'WB_ROOMS_DIR', type: 'path', default: 'apps/server/data/rooms', doc: '每房间一个 <roomId>.db 的目录' },
    { key: 'auditDir', env: 'WB_AUDIT_DIR', type: 'path', default: 'apps/server/data', doc: '审计 JSONL 目录' },
    { key: 'inMemory', env: 'WB_IN_MEMORY', type: 'bool', default: false, doc: '强制房间走内存存储（不落盘；bench/CI 用）' },
    // ── 房间与权限 ──
    { key: 'rooms', env: 'WHITEBOARD_ROOMS', type: 'string', default: '', redact: maskRoomTokens, doc: '房间声明 roomId:token:role,...（摘要中 token 已隐去）' },
    { key: 'controlOpen', env: 'WB_CONTROL_OPEN', type: 'bool', default: false, doc: '控制面对非回环开放（默认仅回环或 Bearer）' },
    { key: 'roomIdleMs', env: 'WB_ROOM_IDLE_MS', type: 'int', default: 300000, min: 1, doc: '房间空闲关闭阈值（ms）' },
    { key: 'maxRooms', env: 'WB_MAX_ROOMS', type: 'int', default: 50, min: 1, doc: '同时打开的房间数上限' },
    // ── 连接与消息限流（P3-1）──
    { key: 'maxConnections', env: 'WB_MAX_CONNECTIONS', type: 'int', default: 200, min: 1, doc: '全服连接数上限' },
    { key: 'maxConnectionsPerRoom', env: 'WB_MAX_CONNECTIONS_PER_ROOM', type: 'int', default: 50, min: 1, doc: '单房间连接数上限' },
    { key: 'maxConnectionsPerIp', env: 'WB_MAX_CONNECTIONS_PER_IP', type: 'int', default: 50, min: 1, doc: '单 IP 连接数上限（不得小于单房间上限，否则同 NAT 合法用户被误拒）' },
    { key: 'maxMessageBytes', env: 'WB_MAX_MESSAGE_BYTES', type: 'int', default: 262144, min: 1, doc: '单条消息字节上限（超限 1009）' },
    { key: 'maxOpsPerMessage', env: 'WB_MAX_OPS_PER_MESSAGE', type: 'int', default: 200, min: 1, doc: '单条消息内 op 条数上限（超限 1008）' },
    { key: 'messageRatePerSec', env: 'WB_MESSAGE_RATE_PER_SEC', type: 'int', default: 120, min: 1, doc: '每连接令牌补充速率（每秒消息数）' },
    { key: 'messageBurst', env: 'WB_MESSAGE_BURST', type: 'int', default: 240, min: 1, doc: '令牌桶容量（瞬时突发）' },
    { key: 'rateStrikes', env: 'WB_RATE_STRIKES', type: 'int', default: 20, min: 1, doc: '窗口内累计丢弃达此值才断开' },
    // ── 压测工具（scripts/bench）──
    { key: 'benchClients', env: 'BENCH_CLIENTS', type: 'int', default: 20, min: 1, doc: 'bench 并发客户端数' },
    { key: 'benchOps', env: 'BENCH_OPS', type: 'int', default: 20, min: 1, doc: 'bench 每客户端 op 数' },
  ],
  // 白板内部用「键名表 + env[key]」的间接读取（limits.mjs / rooms.mjs 的 resolve*Config），
  // 上面各 WB_* 字段已覆盖其全部键；此处登记动态读取位置，便于审计「哪些地方绕过了直接读取」。
  dynamicEnvReads: [
    { file: 'whiteboard/apps/server/src/limits.mjs', expr: 'env[key]', reason: 'resolveLimitConfig 以表驱动的 num(key) 读取 WB_* 限流键；键名已逐一在上方声明' },
    { file: 'whiteboard/apps/server/src/rooms.mjs', expr: 'env[key]', reason: 'resolveRoomConfig 同上读取 WB_ROOM_IDLE_MS / WB_MAX_ROOMS' },
  ],
  nonEnvLiterals: [
    // 扫描器的启发式会把 SQL 语句关键字与信号名当候选，明确排除并说明
    'COMMIT', 'ROLLBACK', 'DELETE', 'SIGINT', 'SIGTERM', 'SIGKILL', 'ENOENT', 'ENOTDIR',
    // P4-6：目录锁把 fs 的 errno 与 `e.code` 比较（`'wx'` 独占创建冲突 → EEXIST；
    // `kill(pid, 0)` 无权限但进程存在 → EPERM）。这些是 fs 的错误码常量，不是 env 键。
    'EEXIST', 'EPERM',
  ],
  notes: [
    '白板是独立子项目：其 packages/shared/src/config.mjs 是根 packages/shared/src/config.mjs 的同步副本（Docker 构建上下文隔离）。',
    '单实例多房间（ADR-0008）：多实例共享存储未实现；P4-6 起该约束由房间目录独占锁强制（第二个实例启动即失败）。',
  ],
})

export default SCHEMA
