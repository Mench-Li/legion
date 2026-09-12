// team-hub/model-migration.test.mjs
// ============================================================================
// PRT-506：迁移现有非敏感模型配置
//
// 这一组守的核心是**一次迁移最危险的产物：一份看起来可用的配置。**
//
// 老数据每条只有 `(scope, role, provider, model)`。要真正跑起来还需要
// runtimeType、endpoint、凭证——**三样都不许猜**：
//   * 猜 runtimeType → 以错误的协议发请求，报一个与配置无关的错；
//   * 猜 endpoint   → 档案看起来"配好了"，直到第一次运行才炸；
//   * 猜"凭证大概有" → 界面显示一切就绪，而运行会失败。
//
// 而这次迁移的**正确产物**恰恰是「确定的部分 + 待补清单」，
// 不是"迁移完成"。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  MIGRATION_CODES,
  applyModelMigration,
  describeMigration,
  planModelMigration,
  profileIdFor,
} from './model-migration.mjs'

const RT = 'openai-compatible'
const row = (over = {}) => ({ scope: 'default', role: 'assistant', provider: 'custom-ds', model: 'deepseek-v4-pro', ...over })
const plan = (rows, over = {}) => planModelMigration({ legacyRows: rows, runtimeType: RT, ...over })

describe('① runtimeType 必填：猜它会以错误的协议发请求', () => {
  test('不给 runtimeType → 拒绝整个计划，且**不产出任何档案**', () => {
    const p = planModelMigration({ legacyRows: [row()] })
    assert.equal(p.ok, false)
    assert.equal(p.code, MIGRATION_CODES.RUNTIME_TYPE_REQUIRED)
    assert.deepEqual([...p.toCreate], [], '拒绝时不该产出半成品')
  })

  test('空串/空白同样算没给（不因为"存在"就通过）', () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
      const p = planModelMigration({ legacyRows: [row()], runtimeType: bad })
      assert.equal(p.code, MIGRATION_CODES.RUNTIME_TYPE_REQUIRED, `runtimeType=${JSON.stringify(bad)}`)
    }
  })

  test('明确给了就用它（不悄悄改成别的）', () => {
    const p = plan([row()], { runtimeType: 'anthropic' })
    assert.equal(p.ok, true)
    assert.equal(p.toCreate[0].runtimeType, 'anthropic')
  })
})

describe('② 不猜 endpoint 与凭证：产出「待补清单」而不是"迁移完成"', () => {
  test('新建的档案**没有** endpoint（迁移不编造地址）', () => {
    const p = plan([row()])
    assert.equal(p.ok, true)
    assert.equal(p.toCreate[0].endpoint ?? null, null, '不许凭空造一个 endpoint')
  })

  test('每个新档案都进 needsAttention，且说清缺什么', () => {
    const p = plan([row()])
    assert.equal(p.needsAttention.length, 1)
    assert.deepEqual([...p.needsAttention[0].missing], ['endpoint', 'credential'])
    assert.equal(p.hasAttention, true)
  })

  test('总述**不得**出现"迁移完成"这类会掩盖待补项的措辞', () => {
    const text = describeMigration(plan([row()]))
    assert.ok(!/迁移完成|全部完成|已就绪/.test(text), text)
    assert.match(text, /需要补 endpoint 与凭证/)
    // 下面这句是重点：它明确说"才能运行"
    assert.match(text, /才能运行/)
  })

  test('没有待补项时也不谎称完成（只是不再提这件事）', () => {
    const p = plan([])
    assert.equal(p.ok, true)
    assert.equal(p.empty, true)
    assert.equal(p.hasAttention, false)
    assert.match(describeMigration(p), /没有需要迁移/)
  })
})

describe('③ id 归一化撞车必须**拒绝整个计划**（静默合并比少建一个坏得多）', () => {
  test('两个不同的模型压成同一个 id → ID_COLLISION', () => {
    // `p.m/n` 与 `p.m-n` 折叠后都是 `p.m-n`——**两个不同的模型名变成同一个 id**。
    // 夹具必须是**真的会撞**的那一对：第一版我写的 `a/b` 对 `a-b` 其实
    // 折成 `a.b-c` 与 `a-b.c`，根本不撞，于是那条用例测的是一件没发生的事。
    const p = plan([
      row({ provider: 'p', model: 'm/n' }),
      row({ provider: 'p', model: 'm-n' }),
    ])
    assert.equal(p.ok, false)
    assert.equal(p.code, MIGRATION_CODES.ID_COLLISION)
    assert.equal(p.conflicts.length, 1)
    assert.deepEqual(p.conflicts[0].a, { provider: 'p', model: 'm/n' })
    assert.deepEqual(p.conflicts[0].b, { provider: 'p', model: 'm-n' })
    // 前提自检：这一对**确实**折成同一个 id，否则上面测的是别的东西
    assert.equal(profileIdFor('p', 'm/n'), profileIdFor('p', 'm-n'))
  })

  test('同一对 (provider, model) 出现两次**不是**撞车（那是重复行）', () => {
    const p = plan([row({ role: 'assistant' }), row({ role: 'reviewer' })])
    assert.equal(p.ok, true)
    assert.equal(p.toCreate.length, 1, '同一对只建一个档案')
    assert.equal(p.toBind.length, 2, '但两个岗位各自绑定')
  })

  test('长名字截断时靠短哈希消歧（截断必然让前缀相同）', () => {
    const long = 'x'.repeat(80)
    const a = profileIdFor('p', `${long}a`)
    const b = profileIdFor('p', `${long}b`)
    assert.notEqual(a, b, '截断后仍然必须不同')
    assert.ok(a.length <= 64 && b.length <= 64)
    assert.match(a, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  })

  test('id 确定性：同样的输入给同样的 id（否则重复跑会建出两份）', () => {
    assert.equal(profileIdFor('custom-ds', 'm1'), profileIdFor('custom-ds', 'm1'))
    assert.equal(profileIdFor('custom-ds', 'm1'), 'custom-ds.m1')
  })
})

describe('④ 非敏感迁移**不得**看到密钥', () => {
  test('源行里有密钥字段 → 拒绝整个计划，并点名是哪个字段', () => {
    const p = plan([{ ...row(), apiKey: 'sk-abcdefghijklmnop' }])
    assert.equal(p.ok, false)
    assert.equal(p.code, MIGRATION_CODES.SECRET_IN_SOURCE)
    assert.match(p.refused[0].reason, /apiKey/)
  })

  test('值看起来像密钥（哪怕字段名无害）也要拒绝', () => {
    const p = plan([{ ...row(), note: 'sk-abcdefghijklmnopqrst' }])
    assert.equal(p.ok, false)
    assert.equal(p.code, MIGRATION_CODES.SECRET_IN_SOURCE)
    assert.match(p.refused[0].reason, /note/)
  })

  test('**拒绝整个计划**而不是"跳过那一行继续"（一次泄漏不该看起来像一次成功迁移）', () => {
    const p = plan([row(), { ...row({ role: 'reviewer' }), token: 'sk-zzzzzzzzzzzzzzzz' }])
    assert.equal(p.ok, false, '有一行带密钥时整个计划不可执行')
    assert.equal(p.code, MIGRATION_CODES.SECRET_IN_SOURCE)
  })

  test('普通短字符串不被误判成密钥（否则这条闸门会因为正常数据而红）', () => {
    const p = plan([{ ...row(), note: 'hello' }, { ...row({ role: 'r2' }), label: 'custom-ds' }])
    assert.equal(p.ok, true)
  })
})

describe('⑤ 幂等：重复运行不重复建，也不覆盖既有配置', () => {
  test('档案已存在 → 跳过而不是冲突', () => {
    const p = plan([row()], { existingProfiles: ['custom-ds.deepseek-v4-pro'] })
    assert.equal(p.ok, true)
    assert.deepEqual([...p.toCreate], [])
    assert.equal(p.skipped.length, 1)
    assert.match(p.skipped[0].reason, /不覆盖/)
  })

  test('绑定已存在 → 跳过', () => {
    const p = plan([row()], { existingBindings: [{ scope: 'default', employeeRole: 'assistant' }] })
    assert.deepEqual([...p.toBind], [])
    assert.ok(p.skipped.some((s) => /已有绑定/.test(s.reason)))
  })

  test('第二次跑同一个计划 → empty（不会重复建）', () => {
    const first = plan([row()])
    const second = plan([row()], {
      existingProfiles: first.toCreate.map((c) => c.id),
      existingBindings: first.toBind,
    })
    assert.equal(second.empty, true)
    assert.deepEqual([...second.toCreate], [])
  })
})

describe('⑥ 老数据的"空"是"没配过"，不是"配错了"', () => {
  test('provider/model 为空 → skipped，不计入 refused', () => {
    const p = plan([row({ provider: null, model: null }), row({ provider: '', model: 'x' })])
    assert.equal(p.ok, true)
    assert.equal(p.skipped.length, 2)
    assert.equal(p.refused.length, 0, '没配过不是错误')
    assert.match(p.skipped[0].reason, /未配置/)
  })

  test('缺 scope 或岗位时仍建档案，只是没有绑定（并说明）', () => {
    const p = plan([row({ scope: null })])
    assert.equal(p.toCreate.length, 1, '档案本身仍然有价值')
    assert.deepEqual([...p.toBind], [])
    assert.ok(p.skipped.some((s) => /无法形成岗位绑定/.test(s.reason)))
  })

  test('源不是数组 → 明确报错（而不是当成空数组静默成功）', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      const p = planModelMigration({ legacyRows: bad, runtimeType: RT })
      assert.equal(p.code, MIGRATION_CODES.BAD_SOURCE, `legacyRows=${JSON.stringify(bad)}`)
    }
  })

  test('行不是对象 → refused 并带下标（能定位到具体哪一行）', () => {
    const p = plan([row(), 'nope'])
    assert.equal(p.refused.length, 1)
    assert.equal(p.refused[0].index, 1)
  })
})

describe('⑦ 执行：只增不改、不删源、半途失败如实上报', () => {
  const fakeStores = () => {
    const createdProfiles = []
    const upserted = []
    return {
      createdProfiles, upserted,
      modelStore: { create: (p, o) => { createdProfiles.push({ id: p.id, actor: o?.actor }) } },
      bindingStore: { upsert: (b, o) => { upserted.push({ ...b, actor: o?.actor }) } },
    }
  }

  test('正常执行：档案与绑定都写进去，且带 actor 留痕', async () => {
    const s = fakeStores()
    const p = plan([row()])
    const r = await applyModelMigration(p, { ...s, actor: 'migrator' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['custom-ds.deepseek-v4-pro'])
    assert.deepEqual(r.bound, ['default/assistant'])
    assert.equal(s.createdProfiles[0].actor, 'migrator', '谁迁移的必须留痕')
    assert.equal(s.upserted[0].primaryProfile, 'custom-ds.deepseek-v4-pro')
  })

  test('计划不可执行时**一个字节都不写**', async () => {
    const s = fakeStores()
    const bad = planModelMigration({ legacyRows: [row()] })  // 缺 runtimeType
    const r = await applyModelMigration(bad, { ...s, actor: 'x' })
    assert.equal(r.ok, false)
    assert.deepEqual(s.createdProfiles, [])
    assert.deepEqual(s.upserted, [])
  })

  test('**半途失败如实报告已写入的部分**（报成"整体失败"会让人重跑而永远不知道做成了什么）', async () => {
    const created = []
    let n = 0
    const stores = {
      modelStore: {
        create: (p) => {
          n += 1
          if (n === 2) throw Object.assign(new Error('磁盘满了'), { code: 'DISK_FULL' })
          created.push(p.id)
        },
      },
      bindingStore: { upsert: () => {} },
    }
    const p = plan([row({ role: 'a' }), row({ role: 'b' }), row({ role: 'c' })])
    // 三行、同一个 (provider, model) → 只建 1 个档案；造两对不同模型才有多条
    const p2 = plan([
      row({ provider: 'p1', model: 'm1', role: 'a' }),
      row({ provider: 'p2', model: 'm2', role: 'b' }),
    ])
    assert.equal(p2.toCreate.length, 2, '夹具前提：要有两个档案才能测"第二个失败"')
    const r = await applyModelMigration(p2, { ...stores, actor: 'x' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'DISK_FULL')
    assert.deepEqual(r.created, ['p1.m1'], '第一份**确实写进去了**，必须如实说')
    assert.equal(r.failed.created, 1)
    assert.equal(p.ok, true)
  })

  test('执行结果里没有"删除源"这个动作（迁移不删，等用户确认）', async () => {
    const s = fakeStores()
    const r = await applyModelMigration(plan([row()]), { ...s, actor: 'x' })
    assert.equal('deleted' in r, false, '迁移不该有删除动作')
    assert.equal('purged' in r, false)
  })

  test('**指纹不符时拒绝执行**（按哪一份都是错的：客户端那份可能过期，服务端那份用户没看过）', async () => {
    const s = fakeStores()
    const p = plan([row()])
    const r = await applyModelMigration(p, { ...s, actor: 'x', expectedDigest: 'stale.digest.00000000' })
    assert.equal(r.ok, false)
    assert.equal(r.code, MIGRATION_CODES.PLAN_STALE)
    assert.deepEqual(s.createdProfiles, [], '拒绝时一个字节都不该写')
    assert.match(r.message, /重新看一眼/)
  })

  test('指纹相符时正常执行', async () => {
    const s = fakeStores()
    const p = plan([row()])
    const r = await applyModelMigration(p, { ...s, actor: 'x', expectedDigest: p.digest })
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, ['custom-ds.deepseek-v4-pro'])
  })

  test('指纹只覆盖**会造成写入的内容**（跳过项变动不该让指纹失效）', () => {
    const a = plan([row()])
    // 多一条"没配过"的老数据：只影响 skipped，不影响要写什么
    const b = plan([row(), row({ role: 'ghost', provider: null, model: null })])
    assert.equal(a.digest, b.digest, '不产生写入的差异不该让用户重新确认')
    // 但真的多一个档案时必须变
    const c = plan([row(), row({ role: 'r2', provider: 'other', model: 'm2' })])
    assert.notEqual(a.digest, c.digest, '写入内容变了，指纹必须变')
  })

  test('同一份输入重复算指纹结果相同（否则用户永远确认不过）', () => {
    assert.equal(plan([row()]).digest, plan([row()]).digest)
  })
})
