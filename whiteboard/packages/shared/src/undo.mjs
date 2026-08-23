// undo.mjs — 每用户局部撤销/重做（S9 / FR-7 / ADR-0006 / TC-S9-01..07）。
// 只撤本人（clientId）手势；undo/redo 以更高 Lamport 时钟重放逆/正 op，天然隔离他人 op。

import { applyOp } from './crdt.mjs';

/** 生成一个 op 的逆 op（不改变其 prev/value 语义，用于恢复 op 前状态） */
export function inverseOf(op) {
  if (op.t === 'add') return { t: 'del', id: op.id, prev: op.el };
  if (op.t === 'del') return { t: 'add', id: op.id, el: op.prev };
  if (op.t === 'patch') return { t: 'patch', id: op.id, path: op.path, value: op.prev, prev: op.value };
  throw new Error(`unknown op type: ${op.t}`);
}

/** 生成 op 的正向重放 op（redo 用） */
export function forwardOf(op) {
  if (op.t === 'add') return { t: 'add', id: op.id, el: op.el };
  if (op.t === 'del') return { t: 'del', id: op.id, prev: op.prev };
  if (op.t === 'patch') return { t: 'patch', id: op.id, path: op.path, value: op.value, prev: op.prev };
  throw new Error(`unknown op type: ${op.t}`);
}

function restamp(op, doc, clientId) {
  doc.clock += 1;
  return { ...op, c: clientId, v: doc.clock };
}

/**
 * 每用户撤销管理器。
 * variant: 'clear-on-remote'（默认）| 'keep-replay'。depth 上限（默认 1000，满足 ≥100）。
 * 用法：begin() → add(op)（记录本次手势产生的 op）→ commit()；undo()/redo() 返回需广播的新 op。
 */
export function createUndoManager(doc, clientId, opts = {}) {
  const variant = opts.variant ?? 'clear-on-remote';
  const depth = opts.depth ?? 1000;
  const undo = [];
  const redo = [];
  let open = null;
  return {
    variant,
    begin() { open = { ops: [] }; },
    add(op) { if (open) open.ops.push(op); },
    commit() {
      if (open && open.ops.length) {
        undo.push(open);
        if (undo.length > depth) undo.shift();
        redo.length = 0;
      }
      open = null;
    },
    onRemote() { if (variant === 'clear-on-remote') redo.length = 0; },
    canUndo() { return undo.length > 0; },
    canRedo() { return redo.length > 0; },
    undoDepth() { return undo.length; },
    undo() {
      const tx = undo.pop();
      if (!tx) return [];
      const newOps = [];
      for (let i = tx.ops.length - 1; i >= 0; i--) {
        const op = restamp(inverseOf(tx.ops[i]), doc, clientId);
        applyOp(doc, op);
        newOps.push(op);
      }
      redo.push(tx);
      return newOps;
    },
    redo() {
      const tx = redo.pop();
      if (!tx) return [];
      const newOps = [];
      for (const op of tx.ops) {
        const op2 = restamp(forwardOf(op), doc, clientId);
        applyOp(doc, op2);
        newOps.push(op2);
      }
      undo.push(tx);
      return newOps;
    },
  };
}
