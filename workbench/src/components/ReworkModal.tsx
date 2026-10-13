import { useState } from 'react'
import { hubRework, rejectTask } from '../api'
import { isUsableReason, returnToast, reworkToast } from '../reworkPlan.ts'
import { toast } from './Toast'

/**
 * 「往回拖」的改动点对话框 —— 重做（验收不满意）与打回（同一目标内退回）共用。
 *
 * ## 为什么不是 `window.prompt`
 *
 * 这两条路原先都只问一句原因，而 `prompt` 有三个不可接受的后果：
 *   · **单行**：改动点天生是多条的（"头像裁切有黑边；名字不要用编号"），单行框会逼人写成一坨；
 *   · **不能校验**：空理由照样提交，于是打回记录里出现"无理由"——而它是重做那一轮**唯一**的输入；
 *   · **可被浏览器静默屏蔽**：被屏蔽时 `prompt()` 回 `null`，界面表现与"用户点了取消"完全一样，
 *     于是"点了确认但什么都没发生"没有任何线索可查。
 *
 * ## 它自己发请求，父组件只负责刷新
 *
 * 与 `NewTaskModal` 同一分工：对话框持有草稿与忙碌态，调用成功后回调 `onDone()` 让看板重载。
 * 把请求留在父组件里会让这个组件退化成"一个受控输入框"，而它对成功/失败的判断也就没了地方放。
 *
 * ★ 打回那一半**不再自己拼"评论 + 迁移"**，而是调 `rejectTask()`：那是同一件事的
 *   唯一实现（`../api.ts`），三个调用点（看板拖拽 / 调度弹窗 / 这里）共用一份。
 *   两份实现的下场是某一天给出两句不一样的话——而"打回到底有没有把理由送达"
 *   恰好是最不能有两种说法的事。
 */
interface ReworkModalProps {
  task: { id: string; title: string; role?: string }
  /** rework = 验收不满意（作废旧链 + 发新目标 + 重建下游）；return = 同一目标内打回。 */
  intent: 'rework' | 'return'
  scope?: string | null
  ifVersion?: number
  /** 打回时迁移的操作者（`by`）。缺省由 hubPost 注入 general。 */
  by?: string
  onClose: () => void
  /** 成功后回调（父组件据此重载看板与任务集）。 */
  onDone: () => void
}

export function ReworkModal({ task, intent, scope, ifVersion, by, onClose, onDone }: ReworkModalProps): React.JSX.Element {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const usable = isUsableReason(reason)
  const isRework = intent === 'rework'

  const submit = async (): Promise<void> => {
    if (!usable) {
      toast('err', isRework ? '请先写清改动点——它是执行者重做的唯一依据' : '请先写清打回原因')
      return
    }
    setBusy(true)
    try {
      if (isRework) {
        const receipt = await hubRework({
          id: task.id,
          reason: reason.trim(),
          ...(ifVersion === undefined ? {} : { ifVersion }),
          ...(scope ? { scope } : {}),
        })
        toast('ok', reworkToast(receipt))
      } else {
        // 打回 = 写评论 + 归还待办，两件事在 rejectTask 里一起做（顺序不能反：
        // 退回后守护可能立刻认领，先落评论才能保证它一定带得上改动点）。
        await rejectTask({
          id: task.id,
          by: by ?? 'general',
          reason: reason.trim(),
          ...(ifVersion === undefined ? {} : { ifVersion }),
        })
        toast('ok', returnToast(task.id))
      }
      onDone()
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', `${isRework ? '重做' : '打回'}失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw' }}>
        <div className="modal-head">
          {isRework ? '↩ 重做（验收不满意）' : '↩ 打回重做'}
          <span className="x" onClick={busy ? undefined : onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12, color: 'var(--muted-2)', marginBottom: 10, lineHeight: 1.8 }}>
            <div style={{ color: 'var(--text)', marginBottom: 4 }}>
              {task.id} · {task.title}
            </div>
            {isRework ? (
              <>
                旧链上<b>这一环及其下游</b>会作废（留痕不删），并另发一个<b>新目标</b>承接重做链：
                本岗位 → 审查 → 测试 → 部署（按本空间流水线推导，blockedBy 一环扣一环）。
                <br />
                改动点会写进新任务正文与评论，成为重做那一轮的输入。
              </>
            ) : (
              <>任务退回「待认领」，保持在同一目标内；改动点写进评论，守护下一轮带着它重做。</>
            )}
          </div>
          <div className="field">
            <label>{isRework ? '改动点 *' : '打回原因 *'}</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              autoFocus
              rows={6}
              placeholder={isRework
                ? '哪里不合格、期望改成什么。例如：\n· 头像裁切出现黑边，方形与圆形都要正常\n· 名字要体现职能（如「排版助手」），不要用编号'
                : '这一轮哪里不对、下一轮要改成什么样'}
            />
          </div>
          {!usable && (
            <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: -4 }}>
              改动点必填：空着等于让执行者按原样再交一次
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !usable}>
            {busy ? '提交中…' : isRework ? '确认重做' : '确认打回'}
          </button>
        </div>
      </div>
    </div>
  )
}
