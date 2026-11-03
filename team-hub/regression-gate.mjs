// team-hub/regression-gate.mjs
// ============================================================================
// F11 · 不退化门（设计稿 §8.6 / M12，E3）
//
// 目标：任何规则/提示词/岗位包改动，都要证明"没变差"。
//
// 三条不变量决定了这里的形状：
//   I-11.1 **基线只能由人写**——让 agent 改自己的及格线，等于让它自己判卷。
//   I-11.2 退化必须说清"哪个指标、从多少到多少、阈值几何"，不能只说"变差了"。
//   I-11.3 门是**硬的**：没有 `--force`。传了也如实回报"被忽略"。
//          （紧急放行要单独走审批并留痕——那是另一个流程，不是这里的一个参数。）
// ============================================================================

/**
 * 指标策略：方向 + 容忍度。
 * 容忍度按指标性质取绝对值或相对比例，口径写在这里，避免"阈值几何"靠记忆。
 */
export const METRIC_POLICY = Object.freeze({
  // 越低越好：没授权就开工的任务比例，理想是 0
  mandateMissingRatio: Object.freeze({ direction: 'lower-better', tolerance: 0.02, mode: 'absolute' }),
  // 越低越好：本来能做却没排上的数量
  wouldAccept: Object.freeze({ direction: 'lower-better', tolerance: 0.2, mode: 'relative' }),
  // 越低越好：被闸门挡下的次数（挡太多说明规则过紧或任务不合规）
  stopped: Object.freeze({ direction: 'lower-better', tolerance: 0.2, mode: 'relative' }),
  ignored: Object.freeze({ direction: 'lower-better', tolerance: 0.2, mode: 'relative' }),
  unavailable: Object.freeze({ direction: 'lower-better', tolerance: 0.2, mode: 'relative' }),
  // 越高越好：受理吞吐
  accepted: Object.freeze({ direction: 'higher-better', tolerance: 0.2, mode: 'relative' }),
})

export const BASELINE_ERRORS = Object.freeze({
  HUMAN_REQUIRED: 'BASELINE_HUMAN_REQUIRED',
  UNKNOWN_METRIC: 'BASELINE_UNKNOWN_METRIC',
  BAD_VALUE: 'BASELINE_BAD_VALUE',
})

export class BaselineError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'BaselineError'
    this.code = code
    this.statusCode = 422
  }
}

/** 建表（幂等）。主键 (metric, scope)：同一指标同一空间只有一条现役基线。 */
export function ensureBaselineSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_baseline (
      metric TEXT NOT NULL,
      scope TEXT NOT NULL,
      value REAL NOT NULL,
      at TEXT NOT NULL,
      set_by TEXT NOT NULL,
      PRIMARY KEY (metric, scope)
    );
  `)
}

const text = (v) => (typeof v === 'string' ? v.trim() : '')

/** 是不是"人"：agent / system / daemon / bot 都不算（I-11.1）。 */
function looksHuman(by) {
  const who = text(by).toLowerCase()
  if (who === '') return false
  if (who.startsWith('agent:')) return false
  return !['system', 'daemon', 'bot', 'worker', 'ci'].includes(who)
}

/**
 * 设基线。**只有人能写**（I-11.1）。
 * @throws BaselineError HUMAN_REQUIRED / UNKNOWN_METRIC / BAD_VALUE
 */
export function setBaseline(db, { metric, scope = 'default', value, by, at = null } = {}) {
  const name = text(metric)
  if (METRIC_POLICY[name] === undefined) {
    throw new BaselineError(BASELINE_ERRORS.UNKNOWN_METRIC, `未知指标 ${JSON.stringify(metric)}；允许：${Object.keys(METRIC_POLICY).join('、')}`)
  }
  if (!looksHuman(by)) {
    throw new BaselineError(BASELINE_ERRORS.HUMAN_REQUIRED, `基线只能由人更新（收到 ${JSON.stringify(by)}）`)
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new BaselineError(BASELINE_ERRORS.BAD_VALUE, `基线值必须是数（收到 ${JSON.stringify(value)}）`)
  }
  const when = at ?? new Date().toISOString()
  db.prepare(`INSERT INTO metric_baseline (metric, scope, value, at, set_by) VALUES (?,?,?,?,?)
    ON CONFLICT(metric, scope) DO UPDATE SET value=excluded.value, at=excluded.at, set_by=excluded.set_by`)
    .run(name, String(scope), numeric, when, String(by))
  return { metric: name, scope: String(scope), value: numeric, at: when, set_by: String(by) }
}

export function getBaseline(db, metric, scope = 'default') {
  return db.prepare('SELECT * FROM metric_baseline WHERE metric=? AND scope=?').get(String(metric), String(scope)) ?? null
}

export function listBaselines(db, { scope = null } = {}) {
  return scope === null
    ? db.prepare('SELECT * FROM metric_baseline ORDER BY metric ASC').all()
    : db.prepare('SELECT * FROM metric_baseline WHERE scope=? ORDER BY metric ASC').all(String(scope))
}

/**
 * 跑门：当前指标 vs 基线，退化超容忍度即不通过。
 *
 * @param db
 * @param opts.metrics  当前指标 { metric: value }
 * @param opts.scope
 * @param opts.force    **会被忽略**（I-11.3），但会在回报里如实说明
 * @returns {{ ok: boolean, reason: string|null, violations: Array<{metric, baseline, current, threshold, direction, delta, text}>, forcedIgnored: boolean }}
 */
export function checkGate(db, { metrics = {}, scope = 'default', force = false } = {}) {
  const baselines = listBaselines(db, { scope: String(scope) })
  if (baselines.length === 0) {
    return {
      ok: false, reason: 'NO_BASELINE', violations: [], forcedIgnored: force === true,
      text: '没有任何基线：先由人设定基线，门才有意义',
    }
  }

  const violations = []
  for (const base of baselines) {
    if (!(base.metric in metrics)) continue
    const policy = METRIC_POLICY[base.metric]
    if (policy === undefined) continue
    const current = Number(metrics[base.metric])
    const baseline = Number(base.value)
    if (!Number.isFinite(current)) continue

    // 容忍度：绝对值口径直接用；相对口径按基线算（基线为 0 时退化为 0 容忍）
    const allowed = policy.mode === 'absolute'
      ? policy.tolerance
      : Math.abs(baseline) * policy.tolerance

    const worse = policy.direction === 'lower-better'
      ? current - baseline > allowed
      : baseline - current > allowed
    if (!worse) continue

    violations.push({
      metric: base.metric,
      baseline,
      current,
      threshold: Number(allowed.toFixed(4)),
      direction: policy.direction,
      delta: Number((current - baseline).toFixed(4)),
      // I-11.2：一句话说清"哪个指标、从多少到多少、阈值几何"
      text: `${base.metric}：基线 ${baseline} → 当前 ${current}（${policy.direction}，允许恶化 ${Number(allowed.toFixed(4))}）`,
    })
  }

  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? null : 'DEGRADED',
    violations,
    // 传了 force 也照样拦，但要让人知道"你的 force 没生效"（I-11.3）
    forcedIgnored: force === true,
    text: violations.length === 0 ? '未发现退化' : violations.map((v) => v.text).join('；'),
  }
}
