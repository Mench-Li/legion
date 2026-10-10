// desktop/scripts/payload-filter.test.mjs
// ============================================================================
// 判据：**数据库与备份永远不进安装包**。
//
// 这条用例守的是一个实测踩到的事故（见 `payload-filter.mjs` 文件头）：
// 三个 33.9 MB 的 `team-hub/team.db.bak-*` 差点被打进给所有人下载的安装包。
//
// ★ 用例里刻意包含**反例**（该放行的源码文件），否则一个"什么都不发"的
//   过滤器也能全绿 —— 那种绿是"包是空的"，与"包是干净的"不是一回事。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isShippablePayloadFile } from './payload-filter.mjs'

test('★ 实测踩到的那三个备份必须被挡下', () => {
  for (const p of [
    'team-hub/team.db.bak-t177-file-domain',
    'team-hub/team.db.bak-t177-narrow-1791171302597',
    'team-hub/team.db.bak-t179-domain-1791171483310',
  ]) {
    assert.equal(isShippablePayloadFile(p), false, `${p} 不该进包`)
  }
})

test('数据库本体与它的 -wal / -shm 附属文件同等处理', () => {
  for (const p of [
    'team-hub/team.db',
    'team-hub/team.db-wal',
    'team-hub/team.db-shm',
    'data/x.sqlite',
    'data/y.sqlite3',
  ]) {
    assert.equal(isShippablePayloadFile(p), false, `${p} 不该进包`)
  }
  // 只挡 .db 而放过 -wal 等于没挡：wal 里可能还有没落盘的记录。
  assert.equal(isShippablePayloadFile('team-hub/team.db-wal'), false)
})

test('换名字的备份也要挡住（补 .gitignore 只挡得住一个名字）', () => {
  for (const p of [
    'team-hub/team.db.backup',
    'team-hub/team.db-2026-10-07',
    'team-hub/team.db.copy',
    'team-hub/backup.db',
    'a/panel.mjs.old',
    'b/config.json.orig',
    'c/thing.bak',
  ]) {
    assert.equal(isShippablePayloadFile(p), false, `${p} 不该进包`)
  }
})

test('★ 反例：真正该发的源码与数据**必须放行**', () => {
  // 没有这一组，一个恒返回 false 的过滤器也能让上面三条全绿。
  for (const p of [
    'team-hub/server.mjs',
    'team-hub/config-schema.mjs',
    'plugins/src/index.ts',
    'product/launcher/launcher.mjs',
    'workbench/scripts/serve.mjs',
    'roles.json',
    'workbench/dist/assets/index-abc123.js',
    // 名字里带 "db" 但**不是**数据库：`dbName` 是标识符不是文件
    'product/config-schema.mjs',
    'runtime/db-config.mjs',
    // `.bak` 必须作为**段的一部分**才算：`bakery.mjs` 里的 "bak" 不算
    'product/bakery.mjs',
    'skills/feedback.mjs',
  ]) {
    assert.equal(isShippablePayloadFile(p), true, `${p} 应该进包`)
  }
})

test('空路径不放行（空串在 join 之后会变成目录本身）', () => {
  assert.equal(isShippablePayloadFile(''), false)
})

test('反斜杠分隔的 Windows 路径与正斜杠等价', () => {
  assert.equal(isShippablePayloadFile('team-hub\\team.db.bak-x'), false)
  assert.equal(isShippablePayloadFile('team-hub\\server.mjs'), true)
})

// ════════════════════════════════════════════════════════════════════════════
// ★★★ 「两条构建路径对同一个文件给出同一个答案」
//
// 守的是 2026-10-10 实测发现的分歧：安装包（`stage.mjs`）的
// `/^roles[^/]*\.json$/` **放行** `roles-ozon.json`，而升级包
// （`update-payload.mjs` 的 `FORBIDDEN_PAYLOAD_ENTRIES`）**禁止**它 ——
// 而两边的注释都写着它属于用户数据、永不进安装。
//
// ## 这条判据的第一版**是错的**，记在这里
//
// 第一版把两条过滤逻辑在用例里**逐字复刻**了一遍，再比对两个集合。实测：
// 把 `stage.mjs` 改回宽松正则，判据**照样全绿**（`fail=0`）。
//
//   > 一条"复刻两条实现再比对"的判据，
//   > 在它复刻的是**我自己写的那份**时，
//   > 与被测的两条真实代码路径是同一个东西——
//   > 只不过前者不会随任一侧漂移而变红。
//
// 所以现在它**不复刻**：两侧都调真实导出（`isShippableRootRoleFile()`，
// 以及升级包侧真实的 `isForbiddenPayloadEntry()`），并额外断言
// "共享判据确实被两侧的实现引用"。
// ════════════════════════════════════════════════════════════════════════════
test('★★★ roles 判据是单一真源：两侧对同一批文件名给出同一个答案', async () => {
  const { isShippableRootRoleFile } = await import('./payload-filter.mjs')
  const { isForbiddenPayloadEntry } = await import('./update-payload.mjs')

  const realNames = ['roles.json', 'roles-ozon.json']
  for (const name of realNames) {
    // 安装包侧：能发出 ⇔ 升级包侧不该禁止。两者必须互为反命题。
    const shippable = isShippableRootRoleFile(name)
    const forbidden = isForbiddenPayloadEntry(name)
    assert.equal(forbidden, !shippable,
      `两侧对 ${name} 的判断相反：安装包侧 shippable=${shippable}，`
      + `升级包侧 forbidden=${forbidden} —— 那意味着"装完机"与"升完级"的产品树不同`)
  }

  // 钉住这两个真实名字各自的结论（上面那条在两边**同时**反了时也会绿）。
  assert.equal(isShippableRootRoleFile('roles.json'), true, 'roles.json 是产品文件，必须发')
  assert.equal(isShippableRootRoleFile('roles-ozon.json'), false, 'roles-ozon.json 是本地数据，不发')

  // 不是 `roles*.json` 的形状一律交给其它判据，这里不表态。
  assert.equal(isShippableRootRoleFile('product/roles.json'), false, '只认仓库根下的名字')
  assert.equal(isShippableRootRoleFile('roles-other.json'), false, '白名单之外一律不发')
})

test('★★★ 两条构建路径都引用共享判据（防止将来又各写一份）', async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname, join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const HERE = dirname(fileURLToPath(import.meta.url))

  // 源码级断言：只认"从 payload-filter 导入并在生产判据里用它"。
  const stage = readFileSync(join(HERE, 'stage.mjs'), 'utf8')
  assert.match(stage, /isShippableRootRoleFile/,
    'stage.mjs 没有引用共享的 roles 判据 —— 它多半又变成自己写一个正则了')

  // ★ 只扫**代码行**，不扫注释。第一版直接对全文 `doesNotMatch`，于是它命中了
  //   我自己在注释里引用的那条旧正则（"这里原本写的是 `/^roles[^/]*\.json$/`"），
  //   一写完就是红的。
  //
  //   > 一条"源码里不该再出现这个写法"的判据，
  //   > 在它把**解释这段历史的注释**也算成代码之后，
  //   > 抓到的就不再是回归，而是"有人写了注释说明为什么不能那样写"。
  const codeLines = stage.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.doesNotMatch(codeLines, /roles\[\^\/\]\*\\?\.json/,
    'stage.mjs 的**代码**里又出现了本地写的 roles 正则 —— 那正是与升级包漂开的那个写法')

  const payload = readFileSync(join(HERE, 'update-payload.mjs'), 'utf8')
  assert.match(payload, /isShippableRootRoleFile/,
    'update-payload.mjs 没有引用共享的 roles 判据')
})

test('★★ roles 判据对真实仓库给出预期结论（不是只对夹具）', async () => {
  const { execFileSync } = await import('node:child_process')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { isShippableRootRoleFile } = await import('./payload-filter.mjs')

  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  const rootRoles = tracked.filter((p) => !p.includes('/') && /^roles.*\.json$/.test(p))

  assert.ok(rootRoles.includes('roles.json'), '真实仓库里应当有 roles.json')
  assert.ok(rootRoles.includes('roles-ozon.json'), '真实仓库里应当有 roles-ozon.json（它是那条分歧的当事文件）')
  assert.deepEqual(rootRoles.filter((p) => isShippableRootRoleFile(p)), ['roles.json'],
    '真实仓库根下的 roles*.json 里，只有 roles.json 该发出去')
})
