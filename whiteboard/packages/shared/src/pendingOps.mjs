// pendingOps.mjs — 断线/切房间窗口内**待发送**的 op 队列（候选 #10）。
//
// 为什么需要它：前端 `send()` 只在 `ws.readyState === OPEN` 时发送，其余情况**静默 return**。
// 于是「连接尚未建立的这段时间里画的东西」既没提示也没入队：本地画布上出现过，但
// ① 服务端从未收到；② welcome 到达时 `doc` 被服务端文档整体替换 → 屏上也一起消失。
// 这是**真实的静默数据丢失**（P4-1 的 E2E 用「等服务端报房间已打开」绕开了它，所以没有误报为缺陷）。
//
// 本模块只做纯逻辑（无 DOM / 无 socket），便于单测锁定语义：
//   - 有界：超过 `max` 时丢**最旧**的 op（用户最近的意图更值钱），并把丢弃条数如实报给调用方；
//   - 分块：服务端 `MAX_OPS_PER_MESSAGE`（默认 200）是**硬门槛**，超限会以 1008 关连接，
//     所以补发必须按 `maxOpsPerMessage` 分块，否则一次补发反而把连接踢掉。

/** 待发队列的默认上限（op 条数）。取值远大于服务端单条消息上限，补发时按服务端上限分块。 */
export const MAX_PENDING_OPS = 500;

/**
 * 创建待发队列。
 * @param {{ max?: number }} [opts]
 */
export function createPendingOps({ max = MAX_PENDING_OPS } = {}) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_PENDING_OPS;
  let items = [];
  return {
    /** 当前积压条数 */
    get size() { return items.length; },
    /** 上限（供提示文案与断言使用） */
    get max() { return limit; },
    /**
     * 入队。返回 { size, dropped }：dropped > 0 表示因超限丢弃了最旧的操作。
     * @param {unknown[]} ops
     */
    push(ops) {
      let dropped = 0;
      for (const op of ops ?? []) {
        items.push(op);
        if (items.length > limit) { items.shift(); dropped += 1; }
      }
      return { size: items.length, dropped };
    },
    /** 取出全部并清空（补发用） */
    drain() {
      const out = items;
      items = [];
      return out;
    },
    /** 把**没发出去**的部分放回队列前端（保持相对顺序，下一轮再补发） */
    unshift(ops) {
      const list = Array.isArray(ops) ? ops : [];
      if (list.length === 0) return { size: items.length, dropped: 0 };
      items = [...list, ...items];
      // 只在「drain 之后立刻 unshift」时调用，此刻队列为空，因此下面这段是**不变量保护**（不会真的丢东西）；
      // 若将来在别处调用，这里有界截断比无界增长安全。
      let dropped = 0;
      while (items.length > limit && items.length > list.length) { items.pop(); dropped += 1; }
      return { size: items.length, dropped };
    },
    /** 丢弃全部（切房间：这些操作属于上一个房间，不可能补发），返回被丢弃的条数 */
    clear() {
      const n = items.length;
      items = [];
      return n;
    },
  };
}

/**
 * 按服务端单条消息上限分块。`maxPerMessage` 非法时整块返回（调用方仍会发一次）。
 * @param {unknown[]} ops
 * @param {number} maxPerMessage
 * @returns {unknown[][]}
 */
export function chunkOps(ops, maxPerMessage) {
  const list = Array.isArray(ops) ? ops : [];
  const size = Number.isFinite(maxPerMessage) && maxPerMessage > 0 ? Math.floor(maxPerMessage) : list.length;
  if (list.length === 0) return [];
  if (size <= 0 || size >= list.length) return [list.slice()];
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 分块补发，并如实报告**哪些真的发出去了**。
 *
 * 为什么要有这个函数（真实竞态，不是假想）：最初的补发实现是「`drain()` 全部取出 → 逐块 `send()`，
 * 不看返回值」。但 `welcome` 可能来自一个**已被取代**的连接（例如切房间时旧 socket 的 `onclose`
 * 又调度了一次 `connect()`，于是同时存在两个 socket），此刻 `ws` 可能还在 `CONNECTING`：
 * `send()` 写不进去 → 那一批 op **既不在队列也没发出去**，等于在修复里重演了本切片要消灭的静默丢失。
 *
 * 因此约定：**只有发送成功的部分才算发出去**，剩下的原样交回调用方重新入队。
 *
 * @param {unknown[]} ops
 * @param {number} maxPerMessage
 * @param {(part: unknown[]) => boolean} send 返回 true 表示**确实写进了 socket**
 * @returns {{ sent: unknown[], remaining: unknown[], failedChunkSize: number }}
 */
export function sendInChunks(ops, maxPerMessage, send) {
  const list = Array.isArray(ops) ? ops : [];
  const parts = chunkOps(list, maxPerMessage);
  let sentCount = 0;
  for (const part of parts) {
    let ok = false;
    try { ok = send(part) === true; } catch { ok = false; } // 写入抛错按「没发出去」处理，绝不当成功
    if (!ok) {
      return { sent: list.slice(0, sentCount), remaining: list.slice(sentCount), failedChunkSize: part.length };
    }
    sentCount += part.length;
  }
  return { sent: list.slice(0, sentCount), remaining: [], failedChunkSize: 0 };
}
