// product/server/read-credentials.test.mjs
// 凭据取值。守的是"取到的值不是我以为的那个"这一类错误——
// 它不报错，只在十分钟后表现为"口令不正确"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CRED_ERRORS, CredentialsError, readCredentials } from './read-credentials.mjs'

function withFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-cred-'))
  try { return fn((name, content, encoding = 'utf8') => {
    const p = join(dir, name)
    writeFileSync(p, content, encoding)
    return p
  }, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const codeOf = (fn) => { try { fn(); return null } catch (e) { return e instanceof CredentialsError ? e.code : `UNEXPECTED:${e.message}` } }

// ── JSON 源（推荐）────────────────────────────────────────────────────────────

test('JSON 源：取出精确的 user_name 与 password', () => withFiles((mk) => {
  const f = mk('credentials.json', JSON.stringify({ user_name: 'legion', password: 'Abc123xyz' }, null, 2))
  assert.deepEqual(readCredentials(f), { userName: 'legion', password: 'Abc123xyz' })
}))

test('JSON 源：值是引号之间的**全部**字节，空白不会被吃掉也不会被加进来', () => withFiles((mk) => {
  // 一个有前后空白的值：必须被**拒绝**，而不是被静默 trim 掉。
  // trim 会让"取值错了"看起来像"口令就是这个"，而两者在登录时的表现相同。
  const padded = mk('padded.json', JSON.stringify({ user_name: 'legion', password: '  Abc123  ' }))
  assert.equal(codeOf(() => readCredentials(padded)), CRED_ERRORS.SURROUNDING_WHITESPACE)

  // 正常值不带空白 → 通过，且**逐字**等于原文。
  const exact = mk('exact.json', JSON.stringify({ user_name: 'legion', password: 'p@ssw0rd!' }))
  assert.equal(readCredentials(exact).password, 'p@ssw0rd!')
}))

test('JSON 源：含注释的文件被具名拒绝，并说清原因', () => withFiles((mk) => {
  // ★ 这是实测踩过的形状：用户把口令写进了一个带 `#` 注释的文件，
  //   而 JSON **不允许注释**。报错必须说清这一点，否则人会去改口令。
  const f = mk('commented.json', '# Legion 凭据\n{"user_name":"legion","password":"Abc123xyz"}\n')
  const e = (() => { try { readCredentials(f) } catch (err) { return err } })()
  assert.equal(e.code, CRED_ERRORS.BAD_JSON)
  assert.match(e.message, /JSON 不允许注释|注释/)
}))

test('JSON 源：缺 password 或类型不对被拒', () => withFiles((mk) => {
  assert.equal(codeOf(() => readCredentials(mk('a.json', '{"user_name":"legion"}'))), CRED_ERRORS.MISSING_PASSWORD)
  assert.equal(codeOf(() => readCredentials(mk('b.json', '{"password":123}'))), CRED_ERRORS.MISSING_PASSWORD)
  assert.equal(codeOf(() => readCredentials(mk('c.json', '{"password":""}'))), CRED_ERRORS.MISSING_PASSWORD)
}))

test('JSON 源：user_name 缺省时为 null（调用方用自己的默认）', () => withFiles((mk) => {
  const f = mk('noname.json', '{"password":"Abc123xyz"}')
  assert.deepEqual(readCredentials(f), { userName: null, password: 'Abc123xyz' })
}))

// ── 纯文本源（服务器自己写的）────────────────────────────────────────────────

test('纯文本源：只去掉结尾换行，内容逐字保留', () => withFiles((mk) => {
  assert.equal(readCredentials(mk('pw.txt', 'Abc123xyz\n')).password, 'Abc123xyz')
  assert.equal(readCredentials(mk('pw2.txt', 'Abc123xyz')).password, 'Abc123xyz')
  assert.equal(readCredentials(mk('pw3.txt', 'Abc123xyz\r\n')).password, 'Abc123xyz')
  // 中间的空格是**内容**，不是噪音。
  assert.equal(readCredentials(mk('pw4.txt', 'Abc 123 xyz\n')).password, 'Abc 123 xyz')
}))

test('★ 人写文件里混进不可见字符时被具名拒绝（这正是踩过的那个坑）', () => withFiles((mk) => {
  // 复现：`新口令：<两个不可见字符><真口令>`——按行解析会把前两个当成口令的一部分。
  // 用真正的控制字符（0x01/0x02），因为"框框"就是它们的显示形态。
  assert.equal(codeOf(() => readCredentials(mk('pw.txt', '\u0001\u0002Abc123xyz\n'))), CRED_ERRORS.UNPRINTABLE)
  // 非 ASCII 同样被拒（全角字符也常从输入法带进来）。
  assert.equal(codeOf(() => readCredentials(mk('pw2.txt', 'Ａbc123xyz\n'))), CRED_ERRORS.UNPRINTABLE)
}))

test('纯文本源：首尾空白被拒，而不是被静默抹掉', () => withFiles((mk) => {
  // 首尾空白与不可打印字符是**两类不同的读数**：前者常是"值旁边多了东西"，
  // 后者是"值本身带了东西"。分开报才能给出对的方向。
  assert.equal(codeOf(() => readCredentials(mk('pw.txt', '  Abc123xyz\n'))), CRED_ERRORS.SURROUNDING_WHITESPACE)
  assert.equal(codeOf(() => readCredentials(mk('pw2.txt', 'Abc123xyz \n'))), CRED_ERRORS.SURROUNDING_WHITESPACE)
  assert.equal(codeOf(() => readCredentials(mk('pw3.txt', '\tAbc123xyz\n'))), CRED_ERRORS.SURROUNDING_WHITESPACE)
}))

test('文件不存在时具名报错', () => {
  assert.equal(codeOf(() => readCredentials('/definitely/not/here/pw.txt')), CRED_ERRORS.NOT_FOUND)
})
