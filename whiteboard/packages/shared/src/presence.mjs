// presence.mjs — presence 聚合模型（S4/S11 / §6.2 TTL / TC-S4-02/04/05）
// 门禁不变量（NFR-6）：presence 只在本模型/awareness 通道流转，绝不写入文档。

/**
 * presence 聚合模型。
 *  - leave(id)：正常断开 → 立即移除（与 TTL 无关）。
 *  - sweep(now)：非正常断开 → 超过 ttlMs 未心跳才移除。
 */
export function createPresence(ttlMs = 10000) {
  const peers = new Map();
  return {
    ttlMs,
    touch(id, now) { peers.set(id, { lastSeen: now }); },
    leave(id) { peers.delete(id); },
    sweep(now) {
      for (const [id, e] of peers) {
        if (now - e.lastSeen > ttlMs) peers.delete(id);
      }
    },
    has(id) { return peers.has(id); },
    size() { return peers.size; },
    list() { return [...peers.keys()]; },
  };
}
