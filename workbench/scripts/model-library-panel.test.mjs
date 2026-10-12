// ============================================================================
// 「模型」面板：**读写 Legion 自己的库**，不经过 DSH
//   （docs/DECISION-legion-owns-model-config.md 的最后一里）
//
// 这一页曾经是"DSH 配置页的代理"：它调 `llm/listConfigurableProviders` / `settings/describe` /
// `settings/mutate` / `credentials/set` / `llm/discoverModels` / `session/modelCatalog`，
// 全部经 `/api/dsh-models` 转发到宿主**已鉴权**的 `/api`。
// 后果不只是"要登一次 DSH"：**产品的配置面被绑在引擎的鉴权模型上**，
// 而用户会看到一个他不认识的登录页 —— 与本条的产品目标正好相反。
//
// 本文件是**源码级**断言（前端组件的判据在本仓一直是这个形状，见 dsh-models-base.test.mjs）：
//
//   ① 不再出现任何 DSH RPC 方法名与那条桥
//   ② 四条读写都落在 Legion 自己的端点上
//   ③ 密钥**随供应商那次写一起**交给服务端（2026-10-12 起：客户端不再知道槽位名）
//   ④ 删除带 `version`（并发保护）；文档串里没有把用户推向引擎的字样
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const RAW = readFileSync(new URL('../src/components/DshProvidersPanel.tsx', import.meta.url), 'utf8')

/**
 * 去掉**整行注释**之后再断言。
 *
 * ★ 这一条是 BUG-012 §7.3 的同一个教训：注释里**引用**旧代码（"这一页曾经调 `settings/mutate`…"）
 *   会让"源码里还有这个字符串"的判据永远为真 —— 于是判据要么被写成只能匹配注释外的写法，
 *   要么就只能删掉那句有用的说明。两者都不好；把注释剥掉再断言才是对的做法。
 *
 *   注意只剥**整行**注释：行尾注释里也可能有真代码（`void x() // 说明`），
 *   而把行尾截断会误伤 —— 宁可少剥，不要剥错。
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}
const SRC = codeOnly(RAW)

test('① ★ 面板里不再有 DSH 的 RPC 方法名与那条桥', () => {
  for (const banned of [
    'dshModelsRpc', 'llm/listConfigurableProviders', 'settings/describe', 'settings/mutate',
    'credentials/set', 'llm/discoverModels', 'session/modelCatalog',
  ]) {
    assert.equal(SRC.includes(banned), false,
      `面板里还有 \`${banned}\` ⇒ 它还在走"转发到宿主已鉴权 /api"那条路（正是 BUG-014 两版修错的地方）`)
  }
  // 反向锚：这些名字**确实**在注释里出现过（说明上面那条不是因为"文件里根本没有这些词"而通过）
  assert.match(RAW, /settings\/mutate/, '文件头应当还在解释"它曾经是 DSH 配置页的代理"')
})

test('② 四条读写都落在 Legion 自己的端点上', () => {
  assert.match(SRC, /hubRequest\('GET',\s*'\/api\/model-providers'\)/, '列表要读 Legion 的目录')
  assert.match(SRC, /hubRequest\('POST',\s*'\/api\/model-providers'/, '建一条要写 Legion')
  assert.match(SRC, /hubRequest\('POST',\s*`\/api\/model-providers\/\$\{encodeURIComponent\(id\)\}`/, '改一条要写 Legion')
  assert.match(SRC, /hubRequest\('DELETE',\s*`\/api\/model-providers\/\$\{encodeURIComponent\(removing\.id\)\}`/, '删一条要写 Legion')
  assert.match(SRC, /'\/api\/model-providers\/discover'/, '读模型目录也由 Legion 自己问（不绕道引擎）')
})

test('③ ★ 密钥**随供应商那次写一起交给服务端**（不再由客户端分两步）', () => {
  // ★★ 2026-10-12（BUG-028）：这一条原本断言"面板先调 `/api/secrets`、再调供应商"，
  //   而那个顺序**现在不存在了，也不该存在**。
  //
  //   原因：读侧不再把引用名发给客户端（引用名是可枚举的攻击面）。面板因此**没有名字**
  //   可用来调 `/api/secrets` —— 而它也不该有：槽位名可能是从 DSH 导进来的 `apiKeyEnv`，
  //   客户端**算不出**它（自己算派生名的话，新钥匙会写进另一个槽位、这一行仍指旧槽位，
  //   表现成"保存成功但认证失败"）。
  //
  //   所以现在把**值**（`credentialValue`）随供应商那次写一起发给服务端，
  //   由它决定槽位并落库。这一步比原来更强：整个动作在**一个请求**里完成，
  //   "密钥写成功、供应商写失败"这个中间态在结构上不可能出现（不是靠顺序避免）。
  const code = codeOnly(SRC)
  assert.equal(code.includes("hubRequest('POST', '/api/secrets'"), false,
    '面板不该再自己调 /api/secrets：它拿不到槽位名（那正是被藏起来的东西）')
  assert.match(code, /credentialValue/,
    '新密钥要以 `credentialValue` 交给服务端（由它落槽位）')
  // 新密钥与供应商那次写在**同一个请求**里：两者必须在同一个 hubRequest 的 body 里
  assert.match(code, /hubRequest\('POST',\s*`\/api\/model-providers\/\$\{encodeURIComponent\(id\)\}`[\s\S]{0,240}?credentialValue/,
    '改一条时：值要与 provider 一起进同一个请求')
  assert.match(code, /hubRequest\('POST',\s*'\/api\/model-providers'[\s\S]{0,240}?credentialValue/,
    '建一条时：同上')
  // ⚠ 没填密钥时**不带**这个字段（"没给" = 保留原值，不是"清掉"）
  assert.match(code, /credentialValue === null \? \{\} : \{ credentialValue \}/,
    '没填密钥就不该带这个字段 —— 服务端把"没给"当成保留，而带上一个空值会变成"清掉凭证"')
  // 而且失败时不许留下"部分成功"：catch 里只报错，不该有"已保存但…"这种话术
  assert.equal(SRC.includes('但凭证写入失败'), false, '不许再有"部分成功"的状态：现在是一整个请求')
})

test('④ 删除带 version（并发保护），且不给用户任何"去登引擎"的出路', () => {
  assert.match(SRC, /hubRequest\('DELETE'[\s\S]{0,120}?version: removing\.version/, '删除必须带 version')
  assert.match(SRC, /version: editing\.version/, '修改必须带 version')
  for (const banned of ['连接 DSH', '登录', 'DSH 服务', 'authenticatedUrl']) {
    assert.equal(SRC.includes(banned), false, `面板里还有"${banned}"⇒ 又把用户推向引擎了`)
  }
})

test('⑥ ★ 密钥库不可用时**提前**说清（而不是等保存时吐 503）', () => {
  // 实测（2026-10-09 真实部署）：GET /api/secrets → 503 SECRETS_LAYOUT_BLOCKED
  //   （产品目录布局未确定 ⇒ 不知道密钥库在哪）。只在保存时失败会让人以为是自己输入的问题。
  assert.match(SRC, /hubRequest\('GET', '\/api\/secrets\/status'\)/, '加载时应当问一次密钥库状态')
  assert.match(SRC, /keyStore\?\.ok === false/, '不可用时要显示提示')
  assert.match(SRC, /密钥暂时存不进来/, '提示要说人话，不是错误码')
  // 而且要说清"其余部分不受影响" —— 否则用户以为整页都坏了
  assert.match(SRC, /不受影响/, '要说明名称/地址/模型列表仍可保存')
})

test('⑤ 摘要从 Legion 自己的数据算，不再依赖 DSH 的目录对象', () => {
  // ★ 断言要打在"依赖"上，不是"这个词出现过"：`model-catalog-summary` 是**样式类名**
  //   （CSS 钩子，留着无害），而 `catalog?.groups` / `DshModelCatalog` 才是真的在读 DSH 的目录对象。
  for (const banned of ['catalog?.', 'catalog.groups', 'DshModelCatalog', 'catalog.failures', 'catalog.default']) {
    assert.equal(SRC.includes(banned), false, `面板还在读 DSH 的目录对象：\`${banned}\``)
  }
  assert.match(SRC, /const modelCount = providers\.reduce/, '模型总数要从 Legion 的 providers 算')
  assert.match(SRC, /已配置 \{providers\.length\} 个供应商/, '摘要文案用 Legion 自己的读数')
})

test('⑦ ★ 同名墓碑复活时要说"已恢复"，而不是"已保存"', () => {
  // 业主实测（2026-10-09）：删掉一个从 DSH 导入的供应商，想加回来被 409 拒
  // ⇒ 只好建成 `xxx-1`。服务端现在**复活**它并回 `revived: true`；
  //   面板必须把这件事说出来 —— 用户刚做过一次删除，他需要知道"那条又回来了"。
  assert.match(SRC, /revived/, '面板要读服务端回的 revived')
  assert.match(SRC, /已\*\*恢复\*\*同名供应商/, '要有一句"已恢复"的提示')
  assert.equal(SRC.includes('不能重用同名'), false, '面板里不该再留"重名不许"那套说法')
})
