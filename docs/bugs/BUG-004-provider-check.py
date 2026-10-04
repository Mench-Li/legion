# docs/bugs/BUG-004-provider-check.py — 岗位模型绑定里有多少指向了**已不存在的供应商**（只读）
#
# 背景：对话回复的守护按 `GET /api/models?scope=<scope>` 解析模型：先找 role='assistant'，
# 再找 role=''，都没有就取**第一行**。software 空间没有 assistant 行 ⇒ 取到的是编码工程师
# 那一行 `custom-ds/deepseek-v4-flash-openai`，而 DSH 档案（cordis.patch.yml）里只声明了 `fjd-ds`。
# 结果是子代理 0 token 立即失败，旧守护的分类器只能说「原因暂不可识别」。
import sqlite3, collections, sys

db = sys.argv[1] if len(sys.argv) > 1 else r'D:\project\DSH\legion\team-hub\team.db'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
q = con.execute

print('=== agent_models 按 provider 统计 ===')
for r in q('SELECT provider, COUNT(*) n FROM agent_models GROUP BY provider ORDER BY n DESC').fetchall():
    print('  %-14s %s' % r)

print()
print('=== 指向 custom-ds 的绑定（全空间）===')
rows = q("SELECT scope, role, provider, model FROM agent_models WHERE provider='custom-ds' ORDER BY scope, role").fetchall()
print('  共 %d 条' % len(rows))
for r in rows:
    print('    %-10s %-12s %s / %s' % r)

print()
print('=== 每个空间有没有 assistant 行（决定守护解析到谁）===')
for scope, total, has_assistant, first_row in q('''
    SELECT scope, COUNT(*) n,
           SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END),
           (SELECT role || ' → ' || provider || '/' || model FROM agent_models m2
             WHERE m2.scope = m1.scope ORDER BY rowid LIMIT 1)
    FROM agent_models m1 GROUP BY scope ORDER BY scope''').fetchall():
    print('  %-10s 绑定=%-3s assistant行=%-3s  守护兜底会取第一行：%s' % (scope, total, has_assistant, first_row))

print()
print('=== 供应商目录（models 表）里还有 custom-ds 吗 ===')
c = q("SELECT COUNT(*) FROM models WHERE provider='custom-ds'").fetchone()[0]
print('  models 表 custom-ds 行数 =', c)
for r in q('SELECT id, provider, model FROM models LIMIT 12').fetchall():
    print('    ', r)
con.close()
