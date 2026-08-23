// hash.mjs — 确定性状态哈希（REQUIREMENTS §6.2 收敛口径 / S2 / TC-S2-08/09）
// 三性质：顺序无关（元素集）、键序无关（字段）、freehand.points 顺序有意义。
import { createHash } from 'node:crypto';

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

/**
 * 对「元素集合」求确定性 SHA-256。支持 Map<id,el> / 数组 / 普通对象。
 * 长度前缀消除 id 与 JSON 边界歧义。
 */
export function stateHash(elements) {
  let entries;
  if (elements instanceof Map) entries = [...elements.entries()];
  else if (Array.isArray(elements)) entries = elements.map((e) => [e.id, e]);
  else entries = Object.entries(elements);

  const rows = entries.map(([, el]) => {
    const id = el.id;
    const canon = JSON.stringify(canonicalize(el));
    return `${id.length}:${id}${canon.length}:${canon}`;
  }).sort();

  const h = createHash('sha256');
  for (const r of rows) h.update(r);
  return h.digest('hex');
}
