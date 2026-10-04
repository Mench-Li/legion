# docs/bugs/BUG-003-inspect.py — 「Agent 定时汇报任务」是否生效：一次把读数取全（只读）
#
# 用法：python BUG-003-inspect.py [team.db]
#   · 默认读生产库 D:\project\DSH\legion\team-hub\team.db（mode=ro，绝不写）
#   · 四个问题：① 汇报管道产出过什么 ② 落进了哪条会话 ③ 界面的那条会话里有什么
#              ④ 还欠哪些（以及为什么那些不欠）
import sqlite3, json, collections, sys

db = sys.argv[1] if len(sys.argv) > 1 else r'D:\project\DSH\legion\team-hub\team.db'
con = sqlite3.connect('file:' + db.replace('\\', '/') + '?mode=ro', uri=True)
q = con.execute
REPORTABLE = ('done', 'in_review', 'blocked', 'canceled')


def scalar(sql, *a):
    return q(sql, *a).fetchone()[0]


print('① 汇报管道产出')
for t in ('agent_reports', 'messages', 'agent_conversation_bindings', 'agent_registry'):
    print('   %-28s %s' % (t, scalar('SELECT COUNT(*) FROM ' + t)))
print('   %-28s %s' % ('最新汇报消息', scalar("SELECT MAX(createdAt) FROM messages WHERE meta LIKE '%\"source\":\"progress\"%'")))
print('   %-28s %s' % ('最新任务变更', scalar('SELECT MAX(updatedAt) FROM tasks')))
fam = collections.Counter()
for (sk,) in q('SELECT source_key FROM agent_reports').fetchall():
    try:
        k = json.loads(sk)
    except Exception:
        k = ['(bad)']
    fam[k[0] if isinstance(k, list) and k else '(bad)'] += 1
print('   汇报家族:', dict(fam))
print('   事件类输入表:', {t: scalar('SELECT COUNT(*) FROM ' + t) for t in ('run_events', 'run_attempts')})

print()
print('② 汇报落进了哪条会话（同名的双胞胎）')
rows = q('''SELECT c.id, c.scope, c.title, COALESCE(c.agent_role,'-') role, COALESCE(b.agent_id,'-') agent_id,
                   (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id) msgs,
                   (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id AND m.meta LIKE '%"source":"progress"%') reports
            FROM conversations c LEFT JOIN agent_conversation_bindings b ON b.conv_id=c.id
            WHERE c.scope='software' ORDER BY c.id''').fetchall()
print('   conv  scope      title        agent_role  消息  其中汇报')
for r in rows:
    print('   %-5s %-10s %-12s %-11s %-5s %s' % (r[0], r[1], r[2], r[3], r[5], r[6]))

print()
print('③ 界面那条会话（conversations.agent_role 非空）里有什么')
for r in q('''SELECT c.id, c.title, c.agent_role,
                     (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id) msgs,
                     (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id AND m.meta LIKE '%"source":"progress"%') reports,
                     (SELECT COALESCE(MAX(m.createdAt),'') FROM messages m WHERE m.conv_id=c.id) last
              FROM conversations c WHERE c.agent_role IS NOT NULL ORDER BY c.id''').fetchall():
    print('   conv=%-3s %-10s role=%-8s 消息=%-4s 其中汇报=%-4s 最后活动=%s' % (r[0], r[1], r[2], r[3], r[4], r[5]))

print()
print('④ 还欠哪些（逐条给原因）')
keys = set()
for (sk,) in q('SELECT source_key FROM agent_reports').fetchall():
    try:
        k = json.loads(sk)
    except Exception:
        continue
    if isinstance(k, list) and len(k) >= 4 and k[0] == 'task':
        keys.add((k[1], k[2], k[3]))
missing = []
for tid, scope, role, status, version, updated in q(
        'SELECT id, scope, COALESCE(role,soldier), status, version, updatedAt FROM tasks').fetchall():
    if status in REPORTABLE and (tid, version, status) not in keys:
        reg = scalar('SELECT COUNT(*) FROM agent_registry WHERE role=? AND archived=0', (role or '',))
        missing.append((tid, scope, role, status, version, reg))
print('   应报未报 %d 条；其中「本空间没有在职岗位」（= 无汇报主体，不是漏报）%d 条'
      % (len(missing), len([m for m in missing if m[5] == 0])))
for m in missing:
    print('     %-8s %-9s role=%-16s %-9s v%-3s 在职岗位=%s%s'
          % (m[0], m[1], m[2], m[3], m[4], m[5], '' if m[5] else '  ← 无汇报主体'))
con.close()
