# docs/bugs/BUG-003-title-check.py — 检查「汇报流会话标题后缀」在生产库与其副本上的效果（只读）
import sqlite3, sys

for label, path, ro in [
    ('生产库', r'D:\project\DSH\legion\team-hub\team.db', True),
]:
    con = sqlite3.connect(('file:' + path.replace('\\', '/') + '?mode=ro') if ro else path, uri=ro)
    print('=== %s ===' % label)
    rows = con.execute("""SELECT c.id, c.title, COALESCE(c.agent_role,'-'),
                                 CASE WHEN b.conv_id IS NULL THEN '对话中心' ELSE '汇报流(绑定)' END
                          FROM conversations c LEFT JOIN agent_conversation_bindings b ON b.conv_id=c.id
                          WHERE c.scope='software' AND c.kind='direct'
                          ORDER BY c.id""").fetchall()
    for r in rows:
        print('  conv=%-3s %-16s agent_role=%-8s %s' % r)
    con.close()
