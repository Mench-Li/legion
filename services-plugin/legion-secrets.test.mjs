// ============================================================================
// P3 的**值**那一半：从 Legion 自己的受保护库按引用名取钥匙。
//
// 这一组守的是"取不到就什么都不写"那条规则 —— 它在生产里很难制造，
// 而一旦失效后果最重：把空串当成"有一把空钥匙"写进 DSH，会**毁掉一把正在用的真钥匙**。
//
//   ① 取得到 ⇒ 返回那个值（走的是产品自己的受保护打开路径，`requireProtected: true`）
//   ② ★ 取不到（库打不开 / 没这个引用 / 值是空串）⇒ **一律返回 null**，绝不返回 ''
//   ③ 抛错也被兜住（库文件被删、DPAPI 换账户…）⇒ null + 一行日志（且同一失败只报一次）
//   ④ 引用名形状不对 ⇒ 连库都不去碰
//   ⑤ `requireProtected: true` 必须**真的传下去**：忘了它就可能开出一个明文后端，
//      而那时写进 DSH 的是真密钥、留在 Legion 的是明文 —— 这个错没有任何界面会提示
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { createLegionSecretReader } from './legion-secrets.mjs'

/** 一个记账用的假打开器：记录每次打开的入参，按 ref 给值。 */
function fakeOpen(values = {}, { ok = true, code = null, withGet = true } = {}) {
  const opened = []
  const open = async (args) => {
    opened.push(args)
    return {
      ok, code,
      store: withGet ? { get: async (ref) => (ref in values ? values[ref] : null) } : null,
    }
  }
  return { open, opened }
}
const layout = async () => ({ layout: { secretsFile: 'C:\\x\\secrets.json' } })

test('① 取得到 ⇒ 返回那个值，并走产品的受保护打开路径', async () => {
  const { open, opened } = fakeOpen({ MY_API_KEY: 'sk-live-value' })
  const read = createLegionSecretReader({ openSecrets: open, resolveLayout: layout, log: () => {} })
  assert.equal(await read('MY_API_KEY'), 'sk-live-value')
  assert.equal(opened.length, 1)
  assert.equal(opened[0].requireProtected, true, 'requireProtected 必须传下去（否则可能开出明文后端）')
  assert.equal(opened[0].layout.secretsFile, 'C:\\x\\secrets.json', '要把解析出来的布局交给打开器')
})

test('② ★ 取不到 ⇒ null，绝不返回空串（空串会毁掉一把正在用的真钥匙）', async () => {
  // 库里没有这个引用
  const miss = createLegionSecretReader({ openSecrets: fakeOpen({}).open, resolveLayout: layout, log: () => {} })
  assert.equal(await miss('NOPE'), null)
  // 值是空串
  const empty = createLegionSecretReader({ openSecrets: fakeOpen({ E: '' }).open, resolveLayout: layout, log: () => {} })
  assert.equal(await empty('E'), null)
  // 库打不开
  const closed = createLegionSecretReader({ openSecrets: fakeOpen({}, { ok: false, code: 'SECRETS_STORE_UNOPENED' }).open, resolveLayout: layout, log: () => {} })
  assert.equal(await closed('ANY'), null)
  // store 没有 get（形状变了）
  const noGet = createLegionSecretReader({ openSecrets: fakeOpen({ A: 'v' }, { withGet: false }).open, resolveLayout: layout, log: () => {} })
  assert.equal(await noGet('A'), null)
  // 全部都必须**严格**是 null —— '' 与 null 在调用方的判断里是两种完全不同的东西
  for (const v of [await miss('NOPE'), await empty('E'), await closed('ANY'), await noGet('A')]) assert.equal(v, null)
})

test('③ 抛错被兜住 ⇒ null + 一行日志（同一个失败只报一次）', async () => {
  const logs = []
  const boom = async () => { throw new Error('DPAPI 换账户了') }
  const read = createLegionSecretReader({ openSecrets: boom, resolveLayout: layout, log: (m) => logs.push(m) })
  assert.equal(await read('A'), null)
  assert.equal(await read('B'), null)
  assert.equal(await read('C'), null)
  assert.equal(logs.length, 1, '同一个失败只该报一次（否则每把钥匙刷一行）')
  assert.match(logs[0], /DPAPI 换账户了/)
  assert.match(logs[0], /不写凭证/)
})

test('④ 引用名形状不对 ⇒ 连库都不去碰', async () => {
  let touched = 0
  const open = async () => { touched += 1; return { ok: true, store: { get: async () => 'x' } } }
  const read = createLegionSecretReader({ openSecrets: open, resolveLayout: layout, log: () => {} })
  assert.equal(await read(''), null)
  assert.equal(await read(null), null)
  assert.equal(await read(undefined), null)
  assert.equal(await read(123), null)
  assert.equal(touched, 0, '形状不对时不该打开密钥库')
})

test('⑤ 布局解析抛错也被兜住（启动早期 paths 可能还不可用）', async () => {
  const logs = []
  const read = createLegionSecretReader({
    openSecrets: fakeOpen({ A: 'v' }).open,
    resolveLayout: async () => { throw new Error('paths 还没就绪') },
    log: (m) => logs.push(m),
  })
  assert.equal(await read('A'), null)
  assert.match(logs.join('\n'), /paths 还没就绪/)
})

test('⑥ 每次取都重新打开（轮换过的库不许拿旧快照）', async () => {
  const { open, opened } = fakeOpen({ A: 'v1' })
  const read = createLegionSecretReader({ openSecrets: open, resolveLayout: layout, log: () => {} })
  await read('A')
  await read('A')
  assert.equal(opened.length, 2, '每取一次都要重新打开：密钥可能刚被轮换过')
})
