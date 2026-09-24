// scripts/probes/branch-disposition.mjs
// ============================================================================
// **T8**（2026-09-24）：`w/*` 存档分支的**处置账**。
//
// 业主在清除工作树前把两个 worktree 各存了一个提交：
//
//   · `w/T-065`          `5c0ce26`  T-065 证据目录 + TEST_REPORT 改动
//   · `w/dual-write-race` `3c78cce` proc-utils.mjs + 用例 + 双写竞态证据 + run-ci 改动
//
// 它们当时**都不在 main 里**，而"不在 main 里"这件事本身**不会出现在任何读数上**：
// 没有判据、没有清单、没有谁会在下一次读状态时想起它们。
//
//   > 一个"还在某个分支上、谁也没提"的提交，
//   > 与一个"已经被丢掉的"提交，在只看 main 的世界里是同一个东西。
//
// 所以本脚本要求：**每一个 `w/*` 分支要么已被并入 main，要么被显式登记为
// "不并入 + 理由"**。新出现一个没登记的 `w/*` 分支 ⇒ 退出码非零。
//
// ★ 两条自检（防"登记了但登记错了"）：
//   · 记 `merged` 的：`git merge-base --is-ancestor <commit> HEAD` 必须为真；
//   · 记 `discarded` 的：它必须**不是** HEAD 的祖先，且理由非空。
//
// 用法：node scripts/probes/branch-disposition.mjs
// ============================================================================
import { spawnSync } from 'node:child_process'

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' })

/**
 * 处置账。★ 改这张表就是改处置：新增一条要写清"为什么"。
 */
const DISPOSITIONS = [
  {
    branch: 'w/T-065',
    commit: '5c0ce26',
    fate: 'merged',
    note: 'T-065 证据目录 10 份全并（`docs/T065-evidence/*`）。★ 同一提交里对 `docs/TEST_REPORT.md` 的改动'
      + '**没有采纳**：该文件是滚动覆盖的单槽报告（文件自己写着"本报告取代上版"），'
      + '而 main 上已是**更晚**的 T-109 报告 ⇒ 采纳即回退。合并时按"保留 main 的更新版"解冲突。',
  },
  {
    branch: 'w/dual-write-race',
    commit: '3c78cce',
    fate: 'discarded',
    note: '**明确不并入**（分支保留作存档，提交不丢）。三条理由，各自可复跑：'
      + '① 它改的 `docs/DUAL-WRITE-RACE-evidence/verify-evidence.md` 相对 main **删掉了 §10**'
      + '（2026-09-12 追加的"同一竞态第二处实例 / PRT-607"整节，含 8.6 验证读数与 §10.8 扫描方法）——'
      + '`git diff main 3c78cce -- <该文件>` 里那 130 余行是 `-` 侧；'
      + '② 它改的 `scripts/ci/run-ci.mjs` 是把超时换成 `startStallWatch` 的**旧文件改写**——'
      + '分支基于 main **抽出 `parseSuiteCounts`（第 35 轮）之前**的版本，试合时在同一区域冲突，'
      + '采纳即回退 main 的解析抽取与机读读数行机制；'
      + '③ 它新增的 `scripts/ci/proc-utils.test.mjs` **在本机 3 例里 1 例红**'
      + '（"后代进程（含孙进程）必须一起收掉"：`queryProcessTree` 采集到 `[]`），'
      + '而 main 里没有 `proc-utils` 的消费方 ⇒ 并入等于把一个孤儿模块与一条红用例带进 main。'
      + '★ 复活条件：先让第 ③ 条用例在 win32 上稳定过，再把 main 现版 `run-ci.mjs` 的超时判定'
      + '**按现结构**改成"有效运行时间"（保留 `parseSuiteCounts` 与机读读数行），'
      + '最后把 §6 定案以**追加**方式并入证据文档（保留 §10）。',
  },
]

const head = (git('rev-parse', '--abbrev-ref', 'HEAD').stdout ?? '').trim()
const branches = (git('branch', '--format=%(refname:short)').stdout ?? '')
  .split('\n').map((s) => s.trim()).filter((s) => /^w\//.test(s))

console.log(`  当前分支 ${head} · 本地 w/* 分支 ${branches.length} 个：${branches.join(', ') || '（无）'}`)

let bad = 0
const known = new Set(DISPOSITIONS.map((d) => d.branch))
for (const b of branches) {
  if (!known.has(b)) {
    console.log(`  ✖ 分支 ${b} **没有处置登记** —— 去 DISPOSITIONS 里写清"并入还是丢弃 + 为什么"`)
    bad += 1
  }
}

for (const d of DISPOSITIONS) {
  const exists = git('rev-parse', '--verify', `${d.commit}^{commit}`).status === 0
  if (!exists) { console.log(`  ✖ ${d.branch}：提交 ${d.commit} 在仓库里找不到了`); bad += 1; continue }
  if (typeof d.note !== 'string' || d.note.trim().length < 20) {
    console.log(`  ✖ ${d.branch}：处置理由太短（要能让人判断，不是打个勾）`); bad += 1; continue
  }
  const isAncestor = git('merge-base', '--is-ancestor', d.commit, 'HEAD').status === 0
  if (d.fate === 'merged' && !isAncestor) {
    console.log(`  ✖ ${d.branch}：登记为"已并入"，但 ${d.commit} **不是** HEAD 的祖先`); bad += 1
  } else if (d.fate === 'discarded' && isAncestor) {
    console.log(`  ✖ ${d.branch}：登记为"不并入"，但它**已经是** HEAD 的祖先（账目过期了）`); bad += 1
  } else {
    console.log(`  ✔ ${d.branch} ${d.commit} ⇒ ${d.fate === 'merged' ? '已并入 main' : '明确不并入（存档在分支上）'}`)
  }
}

if (bad > 0) { console.log(`\n  ⇒ ${bad} 处不符合预期。`); process.exit(1) }
console.log(`\n  ⇒ ${DISPOSITIONS.length} 条存档提交全部有处置、且登记与事实一致。`)
