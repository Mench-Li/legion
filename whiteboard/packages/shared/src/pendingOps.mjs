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
