# docs/bugs/BUG-003-C-index-check.py — conversations 上的唯一索引实况（只读）
import sqlite3, sys

db = sys.argv[1] if len(sys.argv) > 1 else r'D:\project\DSH\legion\team-hub\team.db'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
print('=== conversations 上的索引 ===')
for r in con.execute("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='conversations'").fetchall():
    print('  ', r[0], '=>', r[1])
print()
print('=== 每个 (scope, agent_role) 的行数（应当恒为 1）===')
for r in con.execute("""SELECT scope, agent_role, COUNT(*) n FROM conversations
                        WHERE agent_role IS NOT NULL GROUP BY scope, agent_role ORDER BY scope""").fetchall():
    print('  ', r)
con.close()
