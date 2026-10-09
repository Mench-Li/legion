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
//   ③ 密钥走 `/api/secrets`，而且**先写密钥再写供应商**（顺序是语义，见下）
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

test('③ ★ 先写密钥、再写供应商 —— 顺序不能反', () => {
  const keyAt = SRC.indexOf("hubRequest('POST', '/api/secrets'")
  const createAt = SRC.indexOf("hubRequest('POST', '/api/model-providers', { actor: 'general', provider })")
  assert.ok(keyAt > 0, '密钥要走 Legion 的 /api/secrets')
  assert.ok(createAt > 0, '要能建供应商')
  assert.ok(keyAt < createAt,
    '反过来（先写供应商）会留下一条**声称有密钥、其实没有**的配置 —— 旧实现只能在界面上补一句"凭证写入失败"')
  // 而且失败时不许留下"部分成功"：catch 里只报错，不该有"已保存但…"这种话术
  assert.equal(SRC.includes('但凭证写入失败'), false, '不许再有"部分成功"的状态：先写密钥就不会有')
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
