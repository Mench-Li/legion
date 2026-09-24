// plugins/src/spacePaths.ts
// ============================================================================
// PRT-1007「编排提取」**片 2**：多空间/子实例的**文件命名**族（逐字搬出 `index.ts`）
//
// 为什么先搬这一族：它们只吃字符串、只吐字符串（没有 Config / AppContext / 闭包状态），
// 所以搬走之后一个新 import 都不需要；本地没有 typescript，"要不要补类型 import"
// 没法用编译验证 —— 那就先搬不需要它的那一族。
// ★ 它们各自都有**留在原处的调用者**（statusFileNames 在单空间守护里、
//   childLogFile 在 planSpaceRunners 里），所以 index.ts 必须**引回来**：
//   `export … from` 在 ESM 里不引入本地绑定，只写那一行调用点会当场断。
//
// 判据：`node scripts/probes/probe-slice-verbatim.mjs`（逐字 / 不留实现 / 再导出 / 新模块存在）
// ============================================================================

/** 子实例日志文件：与父日志同目录、按 scope 命名（多空间共用一份日志会互相淹没）。 */
export function childLogFile(parentLogFile: string, scope: string): string {
  if (parentLogFile === '') return ''
  const safe = scope.replace(/[^A-Za-z0-9_-]/g, '_')
  return /\.log$/i.test(parentLogFile)
    ? parentLogFile.replace(/\.log$/i, `-${safe}.log`)
    : `${parentLogFile}-${safe}`
}

/**
 * 守护状态文件名（相对 scrumDir）。
 *
 * 兼容策略：看板与健康页只认 `daemon.json`，故**主 scope**（父配置声明的 scope）继续维护它，
 * 同时也写自己的 per-scope 文件；其余空间只写 per-scope 文件——避免多个实例抢写同一文件，
 * 这正是 P1 要修的多实例问题之一。
 */
export function statusFileNames(scope: string, primaryScope?: string): string[] {
  const safe = scope.replace(/[^A-Za-z0-9_-]/g, '_')
  const perScope = `daemon-${safe}.json`
  const primary = primaryScope === undefined || primaryScope === '' ? undefined : primaryScope
  return primary === undefined || primary === scope ? ['daemon.json', perScope] : [perScope]
}
