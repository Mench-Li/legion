// escape.mjs — 文本纯文本渲染 / XSS 门禁（S5 / FR-11 / TC-S5-02）

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 把文本转为不可执行的纯文本（任何可能落到 DOM 的路径都先经过此函数） */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
