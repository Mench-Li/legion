// throttle.mjs — 光标 20Hz 节流（S4 / §6.2 光标节流 / TC-S4-03）

/**
 * 返回 shouldSend(nowMs)。首帧即时放行一次；此后相邻两次放行间隔 ≥ 1000/rateHz。
 */
export function createThrottle(rateHz) {
  if (!(rateHz > 0)) throw new Error('rateHz must be > 0');
  const interval = 1000 / rateHz;
  let last = -Infinity;
  let first = true;
  return function shouldSend(nowMs) {
    if (first) {
      first = false;
      last = nowMs;
      return true;
    }
    if (nowMs - last >= interval - 1e-9) {
      last = nowMs;
      return true;
    }
    return false;
  };
}
