// team-hub/enforcement-mapping-binding.test.mjs
// ============================================================================
// PRT-612 的**跨层**判据：`runtime/dsh-composition/enforcement-mapping.mjs`
// 里那份"Legion 模式"声明，与 `team-hub/permission-engine.mjs` 里真正在用的
// 那五个模式，是不是同一张表。
//
// ## 为什么这条断言必须住在 team-hub 这一侧
//
// 映射模块**不能** import `permission-engine.mjs`（`team-hub/` → `runtime/` 是
// 本仓库既有的分层方向，反向只有 0 处；为一个常量反转一条已经一致的方向没有收益）。
// 于是它**声明**了一份模式表。声明的东西不会自己保持一致：
//
//   > 一个「本模块自己声明一份模式表」的实现，
//   > 与一个「两份表迟早不一样」的实现，是同一个东西——
//   > 只不过前者在任何**单侧**的用例里都是绿的。
//
// 只有同时看得见两边的文件能问这个问题，而这样的文件只能在 `team-hub/` 这一侧
// （`runtime/` 侧看不到 `team-hub/`）。这与 `permission-engine.canonical.test.mjs`
// 检查"Legion 的域分隔符 ≠ DSH 的域分隔符"是同一个模式。
//
// ## 这里查什么
//
//   ① 集合相同（少一个/多一个都要报）；
//   ② **顺序也相同**——顺序决定不了行为，但它决定了排障时两个人读的是不是同一张表；
//   ③ 映射的落点函数对**每一个真模式**都不抛（表里写了、函数却不认，是一种最隐蔽的
//      不一致：两边各自全绿）；
//   ④ `deny` 真的会走到 `guard`（hard floor 的终审语义不在 pre-execute 上）；
//   ⑤ 授权键：映射层报出来的那组键，就是 `OPERATION_KEYS` 真正参与指纹的那组。
//      `enforcement.mjs` 的 `CANONICAL_OP_KEYS` 与 `permission-engine.mjs` 的
//      `OPERATION_KEYS` 是**两份**（前者是 DSH 侧主体、后者是 Legion 侧），
//      它们服务于不同的哈希域，**不该相等**——但 Legion 侧那份必须与指纹自检
//      对得上（`assertOperationKeysAligned` 已经在查，这里只钉住映射层读的是
//      Legion 侧那份，不是 DSH 侧那份）。
//
//      spec line 470 的 `toolName` / `callId` / 「不可变工具参数」此前**不在**
//      Legion 侧那份里（本文件原先把这条缺口钉成"当前事实"）。本批补上：
//      前两者直接进名单，第三者用载体字段 `argsHash`（值来自 PRT-613 的
//      `hashToolArguments`）。所以 ④ 里的断言从"确认缺口还在"翻成了"必须含"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODES,
  OPERATION_KEYS,
  assertOperationKeysAligned,
  normalizeOperation,
} from './permission-engine.mjs'
import {
  LEGION_MODES,
  MODE_ROUTING,
  authorizationKeys,
  enforcementPathOf,
  mapPermissionMode,
  routeForMode,
} from '../runtime/dsh-composition/enforcement-mapping.mjs'
import { CANONICAL_OP_KEYS } from '../runtime/dsh-composition/enforcement.mjs'

test('① ★ 映射层声明的模式集合 = permission-engine 真正接受的那五个', () => {
  // `MODES` 是本模块的权威声明（它导出了，所以不需要靠行为反推）。
  assert.deepEqual(
    [...LEGION_MODES].sort(), [...MODES].sort(),
    '映射层声明的模式与引擎接受的模式不一致——两边各自都会是绿的',
  )
  // 引擎那份不是"什么都接受"：五个近邻拼写必须都被拒。
  // 没有这一句时，上面那条断言可以在 `MODES` 被写成全集时依然通过。
  for (const bad of ['denyy', 'Allow', 'allow_once', 'allow', 'reject', 'permit', 'prompt', '']) {
    assert.ok(!MODES.has(bad), `MODES 不该接受 "${bad}"`)
  }
  assert.equal(MODES.size, 5)
})

test('① ★ 顺序也相同（排障时两个人读的是同一张表）', () => {
  // 集合相等但顺序不同时，`LEGION_MODES.join()` 这种诊断输出会骗人。
  assert.deepEqual([...LEGION_MODES], ['deny', 'ask', 'allow-once', 'allow-for-task', 'allow-by-policy'])
  assert.deepEqual(Object.keys(MODE_ROUTING), [...LEGION_MODES])
})

test('② ★ 落点函数对**每一个**真模式都不抛（表里有、函数不认 = 最隐蔽的不一致）', () => {
  for (const mode of LEGION_MODES) {
    assert.doesNotThrow(() => routeForMode(mode), mode)
    // 不经过审批箱的三条不需要审批现场；经过的两条给一份"有人值守"的现场
    const input = MODE_ROUTING[mode].viaApprovalBox
      ? { mode, policy: 'ask', requirement: mode === 'allow-once' ? 'allow-once' : 'ask', attended: true }
      : { mode }
    const r = mapPermissionMode(input)
    assert.ok(r.points.length > 0, mode)
    assert.ok(r.decision !== null || r.approval !== null, mode)
  }
})

test('③ ★ deny 的终审在 guard 上，且 guard 在路径里', () => {
  // hard floor 的"终审"语义只能由 guard 承担（它只有降级语义、没有 allow 语义）。
  // 如果 deny 只落到 pre-execute，那么任何绕过 pre-execute 的路径都没有第二次机会。
  const path = enforcementPathOf('deny').map((x) => x.point)
  assert.ok(path.includes('guard'), `deny 的路径必须含 guard，实际 ${JSON.stringify(path)}`)
  assert.deepEqual(path, ['pre-execute', 'guard'])
})

test('④ ★ 映射层的授权键是 Legion 侧那组，不是 DSH 侧那组', () => {
  // `CANONICAL_OP_KEYS`（DSH 侧主体）与 `OPERATION_KEYS`（Legion 侧）服务于
  // **不同的哈希域**（PRT-611 用一条"字段恰好相同但哈希必须不同"的用例钉过）。
  // 所以这里**不**断言两者相等——那会是错的。断言的是：映射层读的是 Legion 侧那份。
  assert.notDeepEqual([...OPERATION_KEYS], [...CANONICAL_OP_KEYS])
  assert.deepEqual([...authorizationKeys()], [...CANONICAL_OP_KEYS])
  // 并且 Legion 侧那份自己与指纹实现是对齐的（既有自检，这里只是让它在本文件也被跑过）
  assert.doesNotThrow(() => assertOperationKeysAligned())
  const produced = Object.keys(normalizeOperation({
    scope: 'legion', actor: 'general', action: 'file:write', target: 'repo/notes.md',
    taskId: 'task-1', toolName: 'file_write', callId: 'call-1', arguments: {},
  }))
  assert.deepEqual(produced, [...OPERATION_KEYS], 'normalizeOperation 的产出必须与 OPERATION_KEYS 一一对应')

  // spec line 470 要求授权主体含 `toolName` 与 `callId`（以及"不可变工具参数"）。
  // 它们此前**不在** `OPERATION_KEYS` 里，于是 `normalizeOperation` 把它们整个丢掉——
  // 一次写文件的批准可以被一次删文件消费。那批已经补上，所以这里钉的从
  // "确认缺口还在"翻成了"必须含"：
  //
  //   > 一条钉住「当前事实」的断言，与一条钉住「应该是什么」的断言，
  //   > 在缺口被补上时是同一条会红的断言——只不过前者红得需要有人来改它。
  assert.ok(produced.includes('toolName'), '授权主体少了 toolName：一次写文件的批准可以被一次删文件消费（spec line 470）')
  assert.ok(produced.includes('callId'), '授权主体少了 callId：两个不同的 Tool Call 会共用一次批准（spec line 470）')
  assert.ok(produced.includes('argsHash'), '授权主体少了"不可变工具参数"的载体 argsHash（spec line 470）')
})
