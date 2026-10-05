# docs/bugs/BUG-003-C-author-check.py — 检查主对话里汇报的作者身份（只读）
import sqlite3, sys, json

db = sys.argv[1] if len(sys.argv) > 1 else r'D:\project\DSH\legion\team-hub\team.db'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)

print('=== conv 25（software/编码工程师 主对话）按作者与来源统计 ===')
q = """SELECT author,
              COALESCE(json_extract(meta,'$.source'),'-') AS src,
              COUNT(*) n
       FROM messages WHERE conv_id=25 GROUP BY author, src ORDER BY n DESC"""
for r in con.execute(q).fetchall():
    print('  author=%-44s source=%-10s %s' % r)

print()
print('=== 作者是 uuid 的汇报（应当改成 agent:<scope>:<role>）===')
rows = con.execute("""SELECT m.id, m.author, json_extract(m.meta,'$.source') src,
                             json_extract(m.meta,'$.agentId') agent_id, m.body
                      FROM messages m WHERE m.conv_id=25 AND m.author LIKE 'agent-%'
                      ORDER BY m.id LIMIT 6""").fetchall()
for r in rows:
    print('  msg=%-4s author=%s src=%s' % (r[0], r[1], r[2]))
    print('        %s' % r[4][:70])

print()
print('=== agent_registry 里这个身份的对应关系 ===')
for r in con.execute("SELECT agent_id, scope, role, name FROM agent_registry WHERE scope='software' AND role='coder'").fetchall():
    print('  ', r)
con.close()
