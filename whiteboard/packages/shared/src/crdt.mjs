// crdt.mjs — 文档同步内核（S3 / ADR-0001）。
// 一个「LWW 元素集 + 每字段 LWW 寄存器」的操作式 CRDT：
//   - 元素级独立（v1 无编组/关联），add/del 用 addStamp/delStamp 做 LWW 墓碑。
//   - 字段级局部更新（stroke/fill/strokeWidth/geom/type），patch 只改一个字段（利于合并）。
//   - 合并 = 逐寄存器取 (v,c) 更大的值 → 交换/幂等/结合，收敛不依赖服务端顺序。
//   - 墓碑：del 永不物理删除，undo(del) = 以更高时钟重新 add。

/** 比较两个 (v,c) 时间戳：a>b 返回 1，a<b 返回 -1，相等返回 0 */
export function cmpStamp(a, b) {
  if (a.v !== b.v) return a.v > b.v ? 1 : -1;
  if (a.c !== b.c) return a.c > b.c ? 1 : -1;
  return 0;
}

/** 新建空文档（clock = Lamport 时钟） */
export function createDoc() {
  return { clock: 0, elements: new Map() };
}

function getRecord(doc, id) {
  let rec = doc.elements.get(id);
  if (!rec) {
    rec = { addStamp: null, delStamp: null, fields: new Map() };
    doc.elements.set(id, rec);
  }
  return rec;
}

function lwwSetField(rec, path, val, stamp) {
  const cur = rec.fields.get(path);
  if (!cur || cmpStamp(stamp, cur) > 0) {
    rec.fields.set(path, { val, ...stamp });
  }
}

/** 应用单个 op（幂等：重复注入同一 op 因时间戳相等而无副作用） */
export function applyOp(doc, op) {
  if (!op || typeof op !== 'object') return;
  if (typeof op.v === 'number' && Number.isFinite(op.v) && op.v > doc.clock) doc.clock = op.v;
  const stamp = { v: op.v, c: op.c };
  const rec = getRecord(doc, op.id);

  switch (op.t) {
    case 'add': {
      if (rec.addStamp && cmpStamp(stamp, rec.addStamp) <= 0) return;
      rec.addStamp = { ...stamp };
      const el = op.el || {};
      const fields = {
        type: el.type,
        geom: el.geom,
        stroke: el.stroke,
        strokeWidth: el.strokeWidth,
      };
      if (el.fill !== undefined) fields.fill = el.fill;
      for (const [k, val] of Object.entries(fields)) {
        if (val !== undefined) lwwSetField(rec, k, val, stamp);
      }
      return;
    }
    case 'patch': {
      lwwSetField(rec, op.path, op.value, stamp);
      return;
    }
    case 'del': {
      if (rec.delStamp && cmpStamp(stamp, rec.delStamp) <= 0) return;
      rec.delStamp = { ...stamp };
      return;
    }
    default:
      return; // 未知 op 类型忽略（健壮性）
  }
}

/** 应用一批 op */
export function applyOps(doc, ops) {
  for (const op of ops) applyOp(doc, op);
  return doc;
}

/** 元素是否存活（非墓碑） */
export function isAlive(rec) {
  return !!rec.addStamp && (!rec.delStamp || cmpStamp(rec.addStamp, rec.delStamp) > 0);
}

/** 从字段寄存器重建元素对象 */
export function getElement(doc, id) {
  const rec = doc.elements.get(id);
  if (!rec || !isAlive(rec)) return null;
  const f = (path, dflt) => {
    const e = rec.fields.get(path);
    return e ? e.val : dflt;
  };
  const el = {
    id,
    type: f('type'),
    geom: f('geom'),
    stroke: f('stroke', '#000000'),
    strokeWidth: f('strokeWidth', 1),
  };
  const fill = f('fill', undefined);
  if (fill !== undefined && fill !== '' && fill !== null) el.fill = fill;
  return el;
}

/** 文档当前状态：按 add 时间戳升序（旧→新，数组末尾 = 最上层 / Z 序） */
export function docState(doc) {
  const out = [];
  for (const [id, rec] of doc.elements) {
    if (isAlive(rec)) out.push(getElement(doc, id));
  }
  out.sort((a, b) => {
    const ra = doc.elements.get(a.id);
    const rb = doc.elements.get(b.id);
    return cmpStamp(ra.addStamp, rb.addStamp);
  });
  return out;
}

/** 生成带本地 Lamport 时间戳的 op（本地手势用） */
export function makeAdd(doc, el, clientId) {
  doc.clock += 1;
  return { t: 'add', id: el.id, el, c: clientId, v: doc.clock };
}

export function makePatch(doc, id, path, value, prev, clientId) {
  doc.clock += 1;
  return { t: 'patch', id, path, value, prev, c: clientId, v: doc.clock };
}

export function makeDel(doc, id, prev, clientId) {
  doc.clock += 1;
  return { t: 'del', id, prev, c: clientId, v: doc.clock };
}

/** 序列化 doc（供持久化快照） */
export function serializeDoc(doc) {
  const elements = [];
  for (const [id, rec] of doc.elements) {
    const fields = {};
    for (const [k, e] of rec.fields) fields[k] = { val: e.val, v: e.v, c: e.c };
    elements.push({
      id,
      addStamp: rec.addStamp ? { ...rec.addStamp } : null,
      delStamp: rec.delStamp ? { ...rec.delStamp } : null,
      fields,
    });
  }
  return { clock: doc.clock, elements };
}

/** 反序列化 doc（从持久化快照恢复） */
export function deserializeDoc(data) {
  const doc = createDoc();
  if (!data || typeof data !== 'object') return doc;
  doc.clock = data.clock || 0;
  for (const e of data.elements || []) {
    const fields = new Map();
    for (const [k, f] of Object.entries(e.fields || {})) {
      fields.set(k, { val: f.val, v: f.v, c: f.c });
    }
    doc.elements.set(e.id, {
      addStamp: e.addStamp ? { ...e.addStamp } : null,
      delStamp: e.delStamp ? { ...e.delStamp } : null,
      fields,
    });
  }
  return doc;
}
