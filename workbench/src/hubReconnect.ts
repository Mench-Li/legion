const HUB_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

/** Retry briefly after a transient Hub outage, then avoid polling it too often. */
export function hubRetryDelay(attempt: number): number {
  const index = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  return HUB_RETRY_DELAYS_MS[Math.min(index, HUB_RETRY_DELAYS_MS.length - 1)]
}
