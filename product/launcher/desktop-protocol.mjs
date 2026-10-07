export const DESKTOP_PROTOCOL_VERSION = 1
export const MAX_LINE_BYTES = 64 * 1024
// `tasks` 是一个**读**命令（在途任务读数，设计 §7 line 150）。
// 与 `status` 并列放在前面：它们都不改变产品状态。
const TYPES = new Set(['start', 'status', 'tasks', 'stop', 'detach', 'restart', 'prepare-runtime', 'configure-workspace', 'configure-identity', 'configure-model',
  // ★ 升级事务的第 3 步（设计 §8）：「Launcher 停止认领，等待在途任务结束」。
  //
  //   这两个类型此前**不在表里**，而 `desktop/update-wiring.mjs` 一直在发
  //   `stop-claiming` ⇒ Launcher 以 `UNKNOWN_TYPE` 拒绝 ⇒ 桌面抛错 ⇒
  //   安装事务判 `install-services-refused` 并进维护态。
  //   **每一次真实安装都停在第三步。**
  //
  //   两条一起加是刻意的：`resume-claiming` 是 `stop-claiming` 的配对。
  //   只加停的那一条，会让"升级中止"留下一个"服务都在跑、但再也领不到活"
  //   的 Legion（设计 §7 line 150「超时回到可选择界面」要求它可恢复）。
  'stop-claiming', 'resume-claiming'])

export function protocolError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function parseRequest(line) {
  let value
  try { value = JSON.parse(line) } catch { throw protocolError('BAD_JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocolError('BAD_REQUEST')
  if (value.version !== DESKTOP_PROTOCOL_VERSION) throw protocolError('BAD_VERSION')
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) throw protocolError('BAD_ID')
  if (!TYPES.has(value.type)) throw protocolError('UNKNOWN_TYPE')
  if (value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw protocolError('BAD_PAYLOAD')
  return value
}

export function createLineDecoder(onLine, { maxBytes = MAX_LINE_BYTES } = {}) {
  let pending = Buffer.alloc(0)
  let dropping = false
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let from = 0
      while (from < bytes.length) {
        const newline = bytes.indexOf(10, from)
        const end = newline < 0 ? bytes.length : newline
        const piece = bytes.subarray(from, end)
        if (!dropping) {
          if (pending.length + piece.length > maxBytes) {
            pending = Buffer.alloc(0)
            dropping = true
            onLine({ code: 'LINE_TOO_LARGE' })
          } else {
            pending = Buffer.concat([pending, piece])
          }
        }
        if (newline >= 0) {
          if (!dropping) onLine(pending.toString('utf8').replace(/\r$/, ''))
          pending = Buffer.alloc(0)
          dropping = false
        }
        from = end + (newline >= 0 ? 1 : 0)
      }
    },
  }
}
