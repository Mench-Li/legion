// team-hub/routes/preemption.mjs
// ============================================================================
// F7 · 抢占的写入口（设计稿 §8.2 / M9）
//
//   POST /api/tasks/:id/preempt { by, kind, strength, reason, now }
//
// 一次抢占在三处留下痕迹，缺一不可：
//   ① `preemptions` 台账（I-7.4 的防活锁要按它数次数）
//   ② `task_input` 一条说明（I-7.2：被谁 · 因何 · 之后会带你回来）
//   ③ 审计（谁在什么时候让了谁的槽）
//
// 真正的"让槽"动作（`agent_commands.stop` + 回到 todo）由守护执行：
// 这里只做**判定与留痕**，不越过 DEC-2 的边界去改执行面。
// ============================================================================
import { canPreempt, preemptionNote, recentPreemptionsFor, recordPreemption, normalizePreemption, applyPreemption } from '../preemption.mjs'

const PREFIX = '/api/tasks/'
const SUFFIX = '/preempt'

export function createPreemptionRoutes({
  json, db, handleWrite, audit, appendInput, now = () => new Date().toISOString(),
  transitionTask = null, commandFn = null,
  config = null,
}) {
  for (const [key, value] of Object.entries({ json, db, handleWrite })) {
    if (value === undefined || value === null) throw new TypeError(`createPreemptionRoutes 缺注入项：${key}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: PREFIX,
      suffix: SUFFIX,
      async run(req, res, ctx) {
        const raw = String(ctx.path).slice(PREFIX.length, -SUFFIX.length)
        if (!raw) return json(res, 400, { error: '缺少任务 id' })
        const taskId = decodeURIComponent(raw)

        await handleWrite(req, res, async (body, by) => {
          const task = db.prepare('SELECT id, scope, status, claimedAt, soldier FROM tasks WHERE id=?').get(taskId)
          if (!task) return { allowed: false, code: 'TASK_NOT_FOUND', userText: `未知任务 ${taskId}` }

          const cfg = normalizePreemption(config ?? undefined)
          const at = body?.now ?? now()
          const verdict = canPreempt({
            requester: { kind: body?.kind ?? 'general', strength: body?.strength ?? 'explicit' },
            task,
            recentPreemptions: recentPreemptionsFor(db, taskId, { windowSec: cfg.lockWindowSec, now: at }),
            now: at,
            config: cfg,
          })
          if (verdict.allowed !== true) {
            // 拒绝要能被调用方当错误处理（422），而不是「200 加一个 allowed:false」——
            // 后者在客户端很容易被当成成功，然后槽位就悄悄没让。
            throw Object.assign(new Error(verdict.userText || verdict.code), {
              code: verdict.code, statusCode: 422, alert: verdict.alert === true,
            })
          }

          const reason = String(body?.reason ?? '').trim() || '紧急任务'
          // 执行面：台账 + 时间线说明 + 回到 todo（可 resume）+ 尽力通知停手。
          // 通知失败不回滚——任务已释放是事实，通知没发出去是另一个问题。
          const applied = applyPreemption(db, { taskId, by, reason, at }, {
            transitionTask, appendInput, audit, commandFn,
          })
          return {
            allowed: true,
            note: applied.note,
            preemption: applied.preemption,
            transitioned: applied.transitioned,
            notified: applied.notified,
          }
        }, { envelope: null })
      },
    },
  ]

  const matches = (r, path) => {
    if (r.match === 'exact') return path === r.path
    if (r.match === 'prefix') return path.startsWith(r.path)
    if (r.match === 'prefix+suffix') return path.startsWith(r.path) && path.endsWith(r.suffix)
    return false
  }

  return {
    id: 'preemption',
    routes,
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}
