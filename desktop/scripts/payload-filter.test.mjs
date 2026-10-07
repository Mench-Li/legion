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
