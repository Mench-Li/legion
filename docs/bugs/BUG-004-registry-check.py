# docs/bugs/BUG-004-registry-check.py — 中枢自己的供应商档案表 vs DSH 档案（只读）
import sqlite3, sys, json

db = sys.argv[1] if len(sys.argv) > 1 else r'D:\project\DSH\legion\team-hub\team.db'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
q = con.execute

print('=== model_profiles（中枢写入 /api/models 时校验用的清单）===')
cols = [r[1] for r in q('PRAGMA table_info(model_profiles)').fetchall()]
print('  列:', cols)
for r in q('SELECT * FROM model_profiles').fetchall():
    print('  ', r)

print()
print('=== 中枢里各 provider 的出现次数（档案 vs 绑定）===')
print('  model_profiles :', q('SELECT COUNT(*) FROM model_profiles').fetchone()[0])
try:
    for r in q("SELECT provider, COUNT(*) FROM agent_models GROUP BY provider").fetchall():
        print('  agent_models   :', r)
except Exception as e:
    print('  agent_models ERR', e)
con.close()
