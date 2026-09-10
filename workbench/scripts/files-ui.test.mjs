// P2-7 文件中心前端纯判定层测试（DOM 无关；node --test --experimental-strip-types，无新依赖、无 jsdom）。
//
// 覆盖四组：① 冲突策略与结果文案（含持久化降级）② 分片切分/续传/进度 ③ 搜索高亮与批量汇总/校验
// ④ git 标记映射（含「空间根是仓库子目录」的前缀换算）与 diff 分类。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHUNK_THRESHOLD_BYTES, DEFAULT_CHUNK_SIZE, STRATEGY_STORAGE_KEY,
  allSelected, batchConfirmText, batchResultText, chunkCount, conflictPrompt, diffHeadText, diffLines, diffStat,
  gitHeadText, gitMarkerFor, gitMarkerView, nextChunk, normalizeMoveTarget, normalizeStrategy, readStoredStrategy,
  repoPrefixOf, searchSummary, shouldUseChunked, sizeText, splitHighlight, strategyLabel, toggleInSet,
  uploadPercent, uploadProgressText, uploadResultText, writeStoredStrategy,
} from '../src/filesUi.ts'

const gitFile = (over) => ({ path: 'a.txt', index: ' ', worktree: 'M', code: 'M', staged: false, untracked: false, conflicted: false, ...over })
const memStore = (init) => {
  const m = new Map(Object.entries(init ?? {}))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, dump: () => Object.fromEntries(m) }
}

// ── ① 冲突策略 ──
test('策略归一：非法/缺失/被改坏的持久化值一律回落 ask（不崩界面）', () => {
  assert.equal(normalizeStrategy('overwrite'), 'overwrite')
  assert.equal(normalizeStrategy('skip'), 'skip')
  assert.equal(normalizeStrategy('rename'), 'rename')
  assert.equal(normalizeStrategy('ASK'), 'ask', '大小写不匹配 → 回落')
  assert.equal(normalizeStrategy('nope'), 'ask')
  assert.equal(normalizeStrategy(null), 'ask')
  assert.equal(normalizeStrategy(7), 'ask')
  assert.equal(strategyLabel('rename'), '自动改名（-1/-2）')
})

test('策略记忆：写入后可读回；storage 抛错（隐私模式/配额）时读写都不炸', () => {
  const store = memStore()
  writeStoredStrategy(store, 'skip')
  assert.equal(store.dump()[STRATEGY_STORAGE_KEY], 'skip')
  assert.equal(readStoredStrategy(store), 'skip')
  const boom = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(readStoredStrategy(boom), 'ask', '读失败降级 ask')
  writeStoredStrategy(boom, 'rename') // 不得抛出
  assert.equal(readStoredStrategy(null), 'ask')
})

test('上传结果文案：区分跳过 / 改名 / 覆盖 / 普通上传（用服务端回传的实际落盘名）', () => {
  assert.equal(uploadResultText('a.txt', { skipped: true }), '已跳过（同名已存在）：a.txt')
  assert.equal(uploadResultText('a.txt', { file: { name: 'a-1.txt' }, strategy: 'rename' }), '已改名上传：a.txt → a-1.txt')
  assert.equal(uploadResultText('a.txt', { file: { name: 'a.txt' }, strategy: 'overwrite' }), '已覆盖：a.txt')
  assert.equal(uploadResultText('a.txt', { file: { name: 'a.txt' }, strategy: 'ask' }), '已上传：a.txt')
  assert.match(conflictPrompt('a.txt'), /覆盖/, '默认询问文案说明「确定=覆盖」')
  assert.match(conflictPrompt('a.txt'), /跳过/)
})

// ── ② 分片与续传 ──
test('分片决策：超过阈值才分片；阈值边界不误判', () => {
  assert.equal(shouldUseChunked(CHUNK_THRESHOLD_BYTES), false, '等于阈值仍走单次 PUT')
  assert.equal(shouldUseChunked(CHUNK_THRESHOLD_BYTES + 1), true)
  assert.equal(shouldUseChunked(0), false)
  assert.equal(shouldUseChunked(Number.NaN), false)
})

test('nextChunk：从已收字节切下一片，末片取余；传完返回 null；不可用 chunkSize 才回落默认值', () => {
  assert.deepEqual(nextChunk(0, 10, 4), { offset: 0, length: 4 })
  assert.deepEqual(nextChunk(4, 10, 4), { offset: 4, length: 4 })
  assert.deepEqual(nextChunk(8, 10, 4), { offset: 8, length: 2 }, '末片取剩余长度')
  assert.equal(nextChunk(10, 10, 4), null, '已传完')
  assert.equal(nextChunk(11, 10, 4), null, '超出也视为完成（防御）')
  assert.deepEqual(nextChunk(0, 10, 10), { offset: 0, length: 10 })
  assert.equal(nextChunk(0, 10, 1).length, 1, '合法的小 chunkSize 必须被尊重（不静默忽略）')
  assert.equal(nextChunk(0, 10 * 1024 * 1024, 0).length, DEFAULT_CHUNK_SIZE, 'chunkSize=0 不可用 → 回落默认')
  assert.equal(nextChunk(0, 10 * 1024 * 1024, Number.NaN).length, DEFAULT_CHUNK_SIZE)
  assert.equal(nextChunk(Number.NaN, 10), null)
})

test('续传链路自洽：反复用 nextChunk 推进到完成，片数 = chunkCount，进度单调到 100', () => {
  const total = 10 * 1024 * 1024
  const size = DEFAULT_CHUNK_SIZE
  let received = 0
  let n = 0
  const pcts = []
  for (;;) {
    const c = nextChunk(received, total, size)
    if (c === null) break
    assert.equal(c.offset, received, '每片的 offset 必须等于当前已收（服务端顺序语义）')
    received += c.length
    n += 1
    pcts.push(uploadPercent(received, total))
  }
  assert.equal(received, total, '最终恰好等于总大小（不多不少）')
  assert.equal(n, chunkCount(total, size))
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), '进度单调不减')
  assert.equal(pcts[pcts.length - 1], 100)
})

test('续传中途重试：从中断处的 received 继续，片序列与一次跑完完全一致', () => {
  const total = 10 * 1024 * 1024 // 10MB / 默认 4MB → 3 片（4+4+2）
  const size = DEFAULT_CHUNK_SIZE
  // 第一次跑到第 2 片后中断
  let received = 0
  for (let i = 0; i < 2; i += 1) received += nextChunk(received, total, size).length
  const mid = received
  assert.equal(mid, 8 * 1024 * 1024, '中断点为前两片之和')
  assert.ok(mid < total, '确实还没传完')
  // 断线重连后从 mid 续传
  const rest = []
  let r = mid
  for (;;) {
    const c = nextChunk(r, total, size)
    if (!c) break
    assert.equal(c.offset, r)
    rest.push(c.offset)
    r += c.length
  }
  assert.deepEqual(rest, [mid], '续传只补最后一片，不重发前面的片')
  assert.equal(r, total, '续传后总长度恰好等于原文件')
})

test('进度与字节文案：0/半/满、非法输入不为 NaN，续传文案显式写「续传中」', () => {
  assert.equal(uploadPercent(0, 100), 0)
  assert.equal(uploadPercent(50, 100), 50)
  assert.equal(uploadPercent(100, 100), 100)
  assert.equal(uploadPercent(200, 100), 100, '上限夹紧')
  assert.equal(uploadPercent(10, 0), 0, '分母 0 不产生 NaN/Infinity')
  assert.equal(uploadPercent(Number.NaN, 10), 0)
  assert.equal(sizeText(512), '512 B')
  assert.equal(sizeText(2048), '2.0 KB')
  assert.equal(sizeText(5 * 1024 * 1024), '5.0 MB')
  assert.equal(sizeText(3 * 1024 * 1024 * 1024), '3.00 GB')
  assert.equal(sizeText(-1), '—')
  assert.match(uploadProgressText(0, 1024), /^上传中 0%/)
  assert.match(uploadProgressText(512, 1024), /^续传中 50%/, 'received>0 必写续传中（避免用户误以为要重传）')
})

// ── ③ 搜索与批量 ──
test('搜索高亮：多次命中全部切出、大小写不敏感、空查询与无命中不丢原文', () => {
  assert.deepEqual(splitHighlight('Guide-2.md', 'guide'), [{ text: 'Guide', hit: true }, { text: '-2.md', hit: false }])
  const multi = splitHighlight('aXbXc', 'x')
  assert.deepEqual(multi.map(s => s.text).join(''), 'aXbXc', '拼回原文（不丢字符）')
  assert.deepEqual(multi.filter(s => s.hit).length, 2, '两处命中都被切出')
  assert.deepEqual(splitHighlight('abc', ''), [{ text: 'abc', hit: false }])
  assert.deepEqual(splitHighlight('abc', 'zzz'), [{ text: 'abc', hit: false }])
  assert.deepEqual(splitHighlight('', 'a'), [{ text: '', hit: false }])
})

test('搜索摘要：说明是否递归、命中数与截断提示', () => {
  assert.match(searchSummary(0, false, false), /无匹配（仅当前目录）/)
  assert.equal(searchSummary(3, false, true), '命中 3 项（含子目录）')
  assert.match(searchSummary(500, true, true), /已达上限/)
})

test('批量结果：成功/失败计数与首条失败原因；全成功不带尾巴', () => {
  assert.equal(batchResultText({ okCount: 3, failed: 0, items: [] }), '成功 3 项，失败 0 项')
  const txt = batchResultText({
    okCount: 1, failed: 2,
    items: [{ path: 'a.txt', ok: true }, { path: 'b.txt', ok: false, error: '目标已存在' }, { path: 'c.txt', ok: false, error: 'x' }],
  })
  assert.match(txt, /失败 2 项/)
  assert.match(txt, /b\.txt（目标已存在）/, '给出首条失败项与原因')
  assert.match(batchConfirmText('delete', 3), /永久删除 3 项/)
  assert.match(batchConfirmText('delete', 3), /不可撤销/)
  assert.match(batchConfirmText('move', 2, 'archive'), /archive/)
})

test('移动目标校验：相对路径规范化为正斜杠去首尾斜杠，拒绝盘符与 ..', () => {
  assert.deepEqual(normalizeMoveTarget(' archive/2026 '), { ok: true, value: 'archive/2026' })
  assert.deepEqual(normalizeMoveTarget('a\\b'), { ok: true, value: 'a/b' })
  assert.deepEqual(normalizeMoveTarget('/x/y/'), { ok: true, value: 'x/y' })
  assert.equal(normalizeMoveTarget('   ').ok, false)
  assert.match(normalizeMoveTarget('C:/tmp').error, /盘符/)
  assert.match(normalizeMoveTarget('../out').error, /\.\./)
})

test('勾选集合辅助：不可变更新（不就地改原集合）且全选判定为空集为假', () => {
  const s1 = new Set(['a'])
  const s2 = toggleInSet(s1, 'b', true)
  assert.deepEqual([...s2].sort(), ['a', 'b'])
  assert.deepEqual([...s1], ['a'], '原集合未被就地修改')
  assert.deepEqual([...toggleInSet(s2, 'a', false)], ['b'])
  assert.equal(allSelected([]), false, '空集不算全选')
  assert.equal(allSelected(['a', 'b']), true)
})

// ── ④ git 展示 ──
test('repoPrefixOf：空间根 = 仓库根 → 空前缀；空间根是仓库子目录 → 子路径前缀（大小写/分隔符不敏感）', () => {
  assert.equal(repoPrefixOf('D:\\proj\\repo', 'D:/proj/repo'), '')
  assert.equal(repoPrefixOf('D:\\proj\\repo\\workbench', 'D:/proj/repo'), 'workbench')
  assert.equal(repoPrefixOf('D:/proj/repo/a/b', 'd:/proj/repo'), 'a/b')
  assert.equal(repoPrefixOf('D:/other', 'D:/proj/repo'), '', '无关路径不误映射')
  assert.equal(repoPrefixOf('D:/proj/repo/sub', 'D:/proj/repo'), 'sub')
  assert.equal(repoPrefixOf('', 'D:/proj/repo'), '')
})

test('gitMarkerFor：按「仓库根相对」路径加上前缀后匹配；无标记/大小写差异正确处理', () => {
  const files = [gitFile({ path: 'workbench/src/a.ts' }), gitFile({ path: 'root.txt' })]
  const hit = gitMarkerFor('src/a.ts', 'workbench', files)
  assert.equal(hit?.path, 'workbench/src/a.ts', '空间根是 workbench 子目录时正确对上')
  assert.equal(gitMarkerFor('root.txt', '', files).path, 'root.txt')
  assert.equal(gitMarkerFor('missing.txt', '', files), null)
  assert.equal(gitMarkerFor('src/a.ts', '', files), null, '前缀不对则不误标')
  assert.equal(gitMarkerFor('ROOT.TXT', '', files).path, 'root.txt', '路径比较不区分大小写')
  assert.equal(gitMarkerFor('a', '', undefined), null)
})

test('gitMarkerView：M/??/R/A/D/U 的标签与色调正确，title 给出 git 原始两位状态', () => {
  assert.equal(gitMarkerView(gitFile({ code: 'M' })).code, 'M')
  assert.match(gitMarkerView(gitFile({ code: 'M' })).title, /" M"|"M "/)
  assert.equal(gitMarkerView(gitFile({ code: '??', untracked: true, index: '?', worktree: '?' })).tone, 'new')
  const renamed = gitMarkerView(gitFile({ code: 'R', staged: true, index: 'R', worktree: ' ', from: 'old.txt', path: 'new.txt' }))
  assert.equal(renamed.label, '改名')
  assert.match(renamed.title, /old\.txt → new\.txt/)
  assert.equal(gitMarkerView(gitFile({ code: 'A', staged: true, index: 'A', worktree: ' ' })).label, '新增')
  assert.equal(gitMarkerView(gitFile({ code: 'D', staged: false, index: ' ', worktree: 'D' })).tone, 'del')
  const conflict = gitMarkerView(gitFile({ code: 'U', conflicted: true, index: 'U', worktree: 'U' }))
  assert.equal(conflict.tone, 'conflict')
  assert.match(conflict.title, /冲突/)
  // 暂存与工作区都改动 → title 必须点明（否则用户以为只是未暂存）
  assert.match(gitMarkerView(gitFile({ code: 'M', staged: true, index: 'M', worktree: 'M' })).title, /暂存区与工作区都有改动/)
  assert.match(gitMarkerView(gitFile({ code: 'M', staged: true, index: 'M', worktree: ' ' })).title, /已暂存，未提交/)
  assert.match(gitMarkerView(gitFile({ code: 'M' })).title, /未暂存/)
})

test('gitHeadText：分支 + 领先落后 + 改动汇总；领先/落后为 0 不显示箭头', () => {
  const t = gitHeadText({
    branch: 'main', ahead: 2, behind: 1, total: 3,
    summary: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0, both: 0 },
  })
  assert.match(t, /分支 main/)
  assert.match(t, /↑2/)
  assert.match(t, /↓1/)
  assert.match(t, /暂存 1/)
  assert.match(t, /未跟踪 1/)
  assert.match(gitHeadText({ branch: 'main', ahead: 0, behind: 0, summary: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, both: 0 } }), /工作区干净/)
  assert.match(gitHeadText({ branch: null, ahead: null, behind: null }), /detached/)
  assert.match(gitHeadText({ branch: 'x', ahead: null, behind: null, summary: { staged: 0, unstaged: 1, untracked: 0, conflicted: 1, both: 0 } }), /冲突 1/)
})

test('diffLines：按行分类 add/del/hunk/meta/ctx（含 +++/--- 不是 add/del）', () => {
  const lines = diffLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new')
  assert.deepEqual(lines.map(l => l.kind), ['meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add'])
  assert.deepEqual(diffLines(''), [])
  assert.equal(diffLines('Binary files a/x and b/x differ')[0].kind, 'meta')
})

test('diffStat 与 diffHeadText：统计只算内容行；无差异/二进制/截断都如实说明', () => {
  const d = '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n+c'
  assert.deepEqual(diffStat(d), { added: 2, removed: 1 })
  assert.deepEqual(diffStat(''), { added: 0, removed: 0 })
  assert.match(diffHeadText({ diff: d }), /工作区 vs 索引 · \+2 \/ −1/)
  assert.match(diffHeadText({ diff: d, staged: true }), /已暂存 vs HEAD/)
  assert.match(diffHeadText({ diff: d, truncated: true }), /内容已截断/)
  assert.match(diffHeadText({ diff: '', note: '无差异（文件与索引一致或未跟踪）' }), /无差异/)
  assert.match(diffHeadText({ diff: '', note: null }), /无差异/, 'note 缺失也要有兜底说明')
  assert.match(diffHeadText({ diff: 'Binary files differ', binary: true }), /二进制文件/)
})
