// history.mjs — redo 并发语义状态机（S9 / ADR-0006 / TC-S9-04..06）
// 这是「可执行行为边界声明」，不替代真实撤销管理器（见 undo.mjs），而是固化并发下可断言的语义。

/**
 * 极简本地历史模型，固化 redo 并发语义。variant:
 *   'clear-on-remote'（默认，6/8）：撤销后一旦有远端 op 落进本人历史作用域 → redo 栈清空。
 *   'keep-replay'（少数方）：保留 redo，redo 仅重放本人 op。
 */
export function createHistory(variant = 'clear-on-remote') {
  if (variant !== 'clear-on-remote' && variant !== 'keep-replay') {
    throw new Error(`unknown variant: ${variant}`);
  }
  const undo = [];
  const redo = [];
  return {
    variant,
    get undoStack() { return undo; },
    get redoStack() { return redo; },
    record(op) { undo.push(op); },
    undo() {
      const op = undo.pop();
      if (op !== undefined) redo.push(op);
      return op ?? null;
    },
    redo() {
      const op = redo.pop();
      if (op !== undefined) undo.push(op);
      return op ?? null;
    },
    onRemoteOp() {
      if (variant === 'clear-on-remote') redo.length = 0;
    },
    canRedo() { return redo.length > 0; },
    canUndo() { return undo.length > 0; },
  };
}
