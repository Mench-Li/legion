/**
 * plugins/src/configSanity.ts — 守护启动时的**配置自洽校正**（BUG-009-b）。
 *
 * 这里只放"两个字段之间存在硬关系、而 schema 只写了注释、没有强制"的那一类。
 * 它们的共同症状：**配置看起来合法、守护照常启动，但行为是坏的**，而坏的地方离配置很远。
 *
 * 已知一条（BUG-009-b）：
 *   `staleMinutes`（租约回收：认领超过该分钟数无进展就释放回 todo）
 *   必须 **>** `workerTimeoutMs/60000`（单个 worker 的超时）。
 *
 *   为什么：worker 在 `workerTimeoutMs` 到点后会被中止并强制结算；如果回收器比它更早动手
 *   （staleMinutes 更小），就会在**worker 还活着**的时候把任务释放回 todo 并被另一个 worker 认领
 *   —— 两个写者同时改同一片文件。这条关系在 `Config` 的字段注释里写着"（须 > workerTimeoutMs/60000）"，
 *   但 schema 是 `z.number().min(5).default(30)`，**没有任何强制**：把 workerTimeoutMs 调到 45 分钟
 *   而 staleMinutes 留 40，配置依然通过。
 *
 *   之所以选"校正 + 打印"而不是"拒绝加载"：配置写错的时候，一个起不来的守护与一个
 *   把问题写在日志里的守护，后者才能让人自己发现原因（前者只会让人以为插件坏了）。
 */

/** 校正结果的形状（`adjusted` 为 true 时调用方**必须**打印一行，否则校正就成了静默改配置）。 */
export interface StaleMinutesVerdict {
  /** 最终生效值。 */
  staleMinutes: number
  /** 满足 `>` 关系所需的最小整数值（供文案引用）。 */
  needed: number
  /** 是否发生了校正（原值不满足关系）。 */
  adjusted: boolean
}

/**
 * 把 `staleMinutes` 校正到满足 `staleMinutes > workerTimeoutMs/60000`。
 *
 * @param workerTimeoutMs 单个 worker 的超时（毫秒）
 * @param staleMinutes    配置里的租约回收分钟数
 * @returns 校正结果；原值已满足关系时 `adjusted === false` 且原值原样返回
 */
export function resolveStaleMinutes({ workerTimeoutMs, staleMinutes }: {
  workerTimeoutMs: number
  staleMinutes: number
}): StaleMinutesVerdict {
  // 关系是**严格大于**：相等时回收器与 worker 超时同时触发，竞态由谁先拿到写锁决定 ——
  // 那正是我们要排除的情形，所以取 +1。
  const minutes = Math.ceil((Number.isFinite(workerTimeoutMs) ? workerTimeoutMs : 0) / 60_000)
  const needed = minutes + 1
  const current = Number.isFinite(staleMinutes) ? staleMinutes : 0
  if (current > minutes) return { staleMinutes: current, needed, adjusted: false }
  return { staleMinutes: needed, needed, adjusted: true }
}
