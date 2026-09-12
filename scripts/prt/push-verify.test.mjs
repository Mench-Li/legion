// scripts/prt/push-verify.test.mjs
// ============================================================================
// 推送验证的判据（PRT-509 事故的回归锁定）
//
// 这一组的价值全在**一个具体的、已经发生过的错误**上：
//
//   我原来的判据是 `$r -match 'codex/prt-runtime ->'`，而 `git push` 的
//   **失败**输出里也含这一串（`! [remote rejected] codex/prt-runtime -> ...`）。
//   于是「被 GitHub 拒绝」= 「推送成功」，而我在**两次拒绝**之后都以为推上去了。
//
// 所以下面的用例里有两条是**负样本**：真实的拒绝输出、真实的成功输出，
// 它们必须被判成不同的结果。少了这两条，这个模块可以退回成一条永远为真的正则，
// 而用例全绿。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PUSH_VERDICTS,
  looksLikeSuccessText,
  parseRemoteTip,
  verdictFor,
} from './push-verify.mjs'

const SHA_LOCAL = '64605529ba650634b62f4032481f9f76e3f96dcf'
const SHA_OLD = '6070c483efe74fb22c056692c6b4349fd1d49eee'

/** 真实的 `git ls-remote` 输出。 */
const LS_REMOTE_OK = `${SHA_LOCAL}\trefs/heads/codex/prt-runtime\n`

/** 真实的**失败**推送输出（GitHub push protection 拒绝，本机实测原文节选）。 */
const PUSH_REJECTED = [
  'remote: error: GH013: Repository rule violations found for refs/heads/codex/prt-runtime.',
  'remote: - GITHUB PUSH PROTECTION',
  'remote:     - Push cannot contain secrets',
  'remote:       —— DeepSeek API Key ——————————————————————————————————',
  'remote:        locations:',
  'remote:          - commit: c30ac27f1da39a627bb432eb84a9671629528c31',
  'remote:            path: docs/superpowers/prt/PRT-509-file-acl-hardening.md:222',
  'remote: ',
  'To https://github.com/Mench-Li/legion.git',
  ' ! [remote rejected] codex/prt-runtime -> codex/prt-runtime (push declined due to repository rule violations)',
  "error: failed to push some refs to 'https://github.com/Mench-Li/legion.git'",
].join('\n')

/** 真实的**成功**推送输出。 */
const PUSH_ACCEPTED = [
  'To https://github.com/Mench-Li/legion.git',
  `   ${SHA_OLD.slice(0, 7)}..${SHA_LOCAL.slice(0, 7)}  codex/prt-runtime -> codex/prt-runtime`,
].join('\n')

// ------------------------------------------------------------------ 解析

test('解析真实 ls-remote 输出', () => {
  const r = parseRemoteTip(LS_REMOTE_OK)
  assert.deepEqual(r, { sha: SHA_LOCAL, ref: 'refs/heads/codex/prt-runtime' })
})

test('解析取不到时返回 null，**不抛也不编一个值**', () => {
  for (const bad of ['', '\n', '   \n', null, undefined, 42, {}, 'not a sha\trefs/heads/x']) {
    assert.equal(parseRemoteTip(bad), null)
  }
})

// ------------------------------------------------------------------ 判定

test('远端 tip 等于本地 HEAD → 唯一代表成功的那一个', () => {
  const r = verdictFor({ localSha: SHA_LOCAL, remoteSha: SHA_LOCAL })
  assert.equal(r.verdict, PUSH_VERDICTS.VERIFIED)
  assert.equal(r.ok, true)
})

test('远端 tip 落后于本地 → mismatch（**不是**成功）', () => {
  // 这正是被拒绝时的真实状态：本地有 2 个未推上去的提交，远端还是旧的。
  const r = verdictFor({ localSha: SHA_LOCAL, remoteSha: SHA_OLD })
  assert.equal(r.verdict, PUSH_VERDICTS.MISMATCH)
  assert.equal(r.ok, false)
})

test('网络不可达 → unreachable（**绝不**返回 verified）', () => {
  // 判据必须**能失败**。"问不到远端"不等于"推上去了"。
  const r = verdictFor({ localSha: SHA_LOCAL, remoteSha: null, reachable: false })
  assert.equal(r.verdict, PUSH_VERDICTS.UNREACHABLE)
  assert.equal(r.ok, false)
  // 可达但远端为空也是失败
  assert.equal(verdictFor({ localSha: SHA_LOCAL, remoteSha: null, reachable: true }).ok, false)
})

test('缺任一 SHA → invalid', () => {
  for (const args of [
    { localSha: null, remoteSha: SHA_LOCAL },
    { localSha: SHA_LOCAL, remoteSha: '' },
    { localSha: '', remoteSha: SHA_LOCAL },
  ]) {
    assert.equal(verdictFor(args).verdict, PUSH_VERDICTS.INVALID)
    assert.equal(verdictFor(args).ok, false)
  }
})

// ------------------------------------------------------------------ 负样本（核心）

test('**回归锁定**：被拒绝的推送输出含有 `->`，因此绝不能用它判成功', () => {
  // 这就是那个 bug 的完整形态。两个真实输出**都**含 `->`，
  // 所以 `-match '... ->'` 这个判据对二者给出同一个答案。
  assert.equal(looksLikeSuccessText(PUSH_REJECTED), true, '被拒绝的输出里也含 ->（这正是陷阱）')
  assert.equal(looksLikeSuccessText(PUSH_ACCEPTED), true)

  // 判据必须是远端状态，而两个场景的远端状态**不同**：
  const rejectedState = verdictFor({ localSha: SHA_LOCAL, remoteSha: SHA_OLD })
  const acceptedState = verdictFor({ localSha: SHA_LOCAL, remoteSha: SHA_LOCAL })
  assert.notEqual(rejectedState.verdict, acceptedState.verdict,
    '两个场景必须被判成不同结果——否则这个验证等于没有')
  assert.equal(rejectedState.ok, false)
  assert.equal(acceptedState.ok, true)
})

test('**回归锁定**：拒绝输出里点名了提交与文件，可据以定位', () => {
  // 事故报告需要的三个事实都在这段输出里，验证脚本只负责把它们**原样打印**，
  // 不做解析——解析失败输出正是上一个版本出错的地方。
  assert.match(PUSH_REJECTED, /push declined/)
  assert.match(PUSH_REJECTED, /c30ac27f1da39a627bb432eb84a9671629528c31/)
  assert.match(PUSH_REJECTED, /PRT-509-file-acl-hardening\.md:222/)
})

test('成功输出与失败输出在"是否被拒"上可区分', () => {
  assert.ok(!PUSH_ACCEPTED.includes('remote rejected'))
  assert.ok(PUSH_REJECTED.includes('remote rejected'))
})
