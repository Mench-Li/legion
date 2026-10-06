import { planTimeoutSettlement, planTimeoutTransitionFailure } from '../plugins/lib/timeoutSettlement.js'
const hold = planTimeoutSettlement({ taskId: 'T-178', stopped: false, graceMs: 20000, timeoutMinutes: 25 })
const fail = planTimeoutTransitionFailure({ taskId: 'T-178', scope: 'default', reason: '乐观锁冲突' })
console.log('--- HOLD comment ---')
console.log(hold.comment)
console.log('contains scope?', /scope/.test(hold.comment))
console.log('--- FAILURE comment ---')
console.log(fail.comment)
console.log('step2 missing scope?', /confirm-stopped \{"by":"general","confirm"/.test(fail.comment))
