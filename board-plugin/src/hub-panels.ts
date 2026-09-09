/**
 * P1-1 第 2 步：hub 模式的看板 / 总指挥部动态页面模板。
 *
 * 本地模式继续由 render.mjs 生成静态 kanban.html / console.html（服务端渲染 v1）。
 * hub 模式（读 v2 /api/board 裸任务数组）无法复用静态产物，这里返回内联单文件
 * 模板：拉当前前缀 /api/board 自渲染状态列 + EventSource /api/board/events 实时
 * 刷新 + transition/comment 动作（v2 语义；无 reject/promote）。
 *
 * 注意：模板是纯字符串，前端代码内不使用 `${...}`（与外层模板字符串冲突），
 * 全部用字符串拼接。页面以 /scrum-board/ 为根，使用相对 api 前缀。
 */

function pageShell(title: string, bodyJs: string, bodyHtml: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;background:#0f1420;color:#dbe3f0}
header{padding:10px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #1c2740;background:#141b2c}
header h1{font-size:15px;margin:0;font-weight:600}
header .meta{font-size:12px;color:#7d8aa3}
#status{font-size:12px;color:#7d8aa3;margin-left:auto}
.board{display:flex;gap:12px;padding:14px;align-items:flex-start;overflow-x:auto}
.col{flex:1 1 240px;min-width:240px;background:#151d30;border:1px solid #1c2740;border-radius:10px;padding:8px}
.col h2{font-size:12px;margin:2px 6px 8px;color:#9fb0cc;display:flex;justify-content:space-between}
.col h2 .n{color:#5d6a85}
.card{background:#1a2338;border:1px solid #263353;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px}
.card .id{color:#6fb3ff;font-weight:600}
.card .ttl{margin:3px 0}
.card .tags{color:#7d8aa3;font-size:11px;display:flex;gap:8px;flex-wrap:wrap}
.card .act{margin-top:6px;display:flex;gap:6px;align-items:center}
select,input,button{background:#0f1626;color:#dbe3f0;border:1px solid #2a3a5c;border-radius:6px;padding:3px 6px;font-size:12px}
button{cursor:pointer}
button:hover{border-color:#4a6ca8}
.console{display:flex;gap:14px;padding:14px;flex-wrap:wrap}
.panel{flex:1 1 420px;background:#151d30;border:1px solid #1c2740;border-radius:10px;padding:12px;font-size:12px}
.panel h2{font-size:13px;margin:0 0 8px}
.kpi{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.kpi span{background:#1a2338;border:1px solid #263353;border-radius:8px;padding:6px 10px}
.kpi b{font-size:16px;color:#6fb3ff}
ul.log{list-style:none;margin:0;padding:0;max-height:320px;overflow-y:auto}
ul.log li{padding:4px 0;border-bottom:1px solid #161f33;color:#9fb0cc}
ul.log li b{color:#dbe3f0}
.daemon{margin-top:8px;font-size:12px;color:#7d8aa3;white-space:pre-wrap}
</style></head><body>
${bodyHtml}
<script>${bodyJs}</script></body></html>`
}

export const HUB_BOARD_HTML: string = pageShell('Scrum 看板（v2）', `
var api = location.pathname.replace(/\\/+$/, '');
var ORDER = ['backlog','todo','in_progress','in_review','blocked','done','canceled'];
var STATE_LABEL = { backlog:'待办池', todo:'待认领', in_progress:'进行中', in_review:'审查中', blocked:'受阻', done:'完成', canceled:'已取消' };
var byName = 'general';
function el(tag, cls, text){ var e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function renderBoard(tasks){
  var groups = {}; ORDER.forEach(function(s){ groups[s]=[]; });
  (tasks||[]).forEach(function(t){ (groups[t.status] || groups.backlog).push(t); });
  var board = document.getElementById('board');
  board.innerHTML='';
  ORDER.forEach(function(s){
    var list=groups[s]; if(!list.length) return;
    var col=el('div','col');
    var h=el('h2'); h.appendChild(el('span','', (STATE_LABEL[s]||s))); h.appendChild(el('span','n','('+list.length+')'));
    col.appendChild(h);
    list.forEach(function(t){ col.appendChild(card(t)); });
    board.appendChild(col);
  });
}
function card(t){
  var d=el('div','card');
  var id=el('div','id','#'+t.id+' · v'+t.version); d.appendChild(id);
  d.appendChild(el('div','ttl', t.title));
  var tg=el('div','tags');
  if(t.priority)tg.appendChild(el('span','','['+t.priority+']'));
  if(t.soldier)tg.appendChild(el('span','',t.soldier));
  if(t.scope)tg.appendChild(el('span','',t.scope));
  if(t.hold)tg.appendChild(el('span','','⏸ hold'));
  if(t.fixOf)tg.appendChild(el('span','','fix of '+t.fixOf));
  d.appendChild(tg);
  if(t.description){ var desc=el('div','ttl', String(t.description).slice(0,120)); desc.style.color='#7d8aa3'; d.appendChild(desc); }
  var act=el('div','act');
  var sel=document.createElement('select');
  ORDER.forEach(function(s2){ if(s2===t.status)return; var o=document.createElement('option'); o.value=s2; o.textContent=STATE_LABEL[s2]||s2; sel.appendChild(o); });
  var go=el('button','','迁移→'); go.onclick=function(){ moveTo(t.id, sel.value, t.version); };
  act.appendChild(sel); act.appendChild(go);
  var ci=document.createElement('input'); ci.placeholder='评论…'; ci.style.flex='1'; ci.minLength=0;
  var cbtn=el('button','','评'); cbtn.onclick=function(){ comment(t.id, ci.value); ci.value=''; };
  act.appendChild(ci); act.appendChild(cbtn);
  d.appendChild(act);
  return d;
}
function post(p, body, ok){
  fetch(api+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){ return r.json().catch(function(){return{};}).then(function(j){ return {status:r.status, j:j}; }); })
    .then(function(r){ if(r.status===200){ ok&&ok(); refresh(); } else { alert('('+r.status+') '+(r.j&&r.j.error||'失败')); } })
    .catch(function(e){ alert('请求失败: '+e); });
}
function moveTo(id,to,ver){ var b={id:id,to:to,by:byName,ifVersion:ver,scope:''}; post('/api/transition',b); }
function comment(id,text){ if(!text.trim())return; post('/api/comment',{id:id,by:byName,text:text.trim()}); }
var _rt=null;
function refresh(){ clearTimeout(_rt); _rt=setTimeout(function(){
  var st=document.getElementById('status'); if(st)st.textContent='载入中…';
  fetch(api+'/api/board',{headers:{accept:'application/json'}})
    .then(function(r){ if(!r.ok)throw new Error(r.status); return r.json(); })
    .then(function(tasks){ renderBoard(tasks); var st=document.getElementById('status'); if(st)st.textContent='实时 · '+new Date().toLocaleTimeString()+' · '+tasks.length+' 项'; })
    .catch(function(e){ var st=document.getElementById('status'); if(st)st.textContent='连接 hub 失败'; });
},150);}
document.addEventListener('DOMContentLoaded', function(){
  var es=new EventSource(api+'/api/board/events');
  es.onmessage=function(){ refresh(); };
  es.onerror=function(){ var st=document.getElementById('status'); if(st)st.textContent='事件流断开，重连中…'; };
  refresh();
});
`, `
<header><h1>🛰 Scrum 看板 <span style="font-size:11px;color:#6fb3ff">v2 hub</span></h1>
<span class="meta">操作身份 by=<input id="byName" value="general" style="width:90px" onchange="byName=this.value"></span>
<span id="status">连接中…</span></header>
<div class="board" id="board"><div style="color:#5d6a85;padding:12px">载入…</div></div>
`)

export const HUB_CONSOLE_HTML: string = pageShell('军团总指挥部（v2）', `
var api = location.pathname.replace(/\\/+$/, '');
var STATE_LABEL = { backlog:'待办池', todo:'待认领', in_progress:'进行中', in_review:'审查中', blocked:'受阻', done:'完成', canceled:'已取消' };
function refresh(){
  fetch(api+'/api/board',{headers:{accept:'application/json'}}).then(function(r){return r.json();}).then(function(tasks){
    var kpi=document.getElementById('kpi'); kpi.innerHTML='';
    var counts={}; var done=0;
    (tasks||[]).forEach(function(t){ counts[t.status]=(counts[t.status]||0)+1; if(t.status==='done')done++; });
    kpi.appendChild(kpiItem('总数', (tasks||[]).length));
    kpi.appendChild(kpiItem('完成', done));
    Object.keys(counts).forEach(function(s){ if(s!=='done') kpi.appendChild(kpiItem(STATE_LABEL[s]||s, counts[s])); });
    var list=document.getElementById('tasks'); list.innerHTML='';
    (tasks||[]).slice().reverse().slice(0,24).forEach(function(t){
      var li=document.createElement('li');
      li.innerHTML='<b>'+esc(t.id)+'</b> ['+esc(t.status)+'] '+esc(t.title)+(t.soldier?' · '+esc(t.soldier):'');
      list.appendChild(li);
    });
  }).catch(function(){});
  fetch(api+'/api/activity?limit=16',{headers:{accept:'application/json'}}).then(function(r){return r.json();}).then(function(acts){
    var list=document.getElementById('log'); list.innerHTML='';
    (acts||[]).forEach(function(a){
      var li=document.createElement('li');
      var who=a.member||a.by||''; var act=a.action||a.event||a.kind||'';
      li.innerHTML='<b>'+esc(act)+'</b> '+(a.taskId?'#'+esc(a.taskId)+' ':'')+(who?esc(who)+' ':'')+(a.detail?esc(JSON.stringify(a.detail)).slice(0,60):'');
      list.appendChild(li);
    });
  }).catch(function(){});
  fetch(api+'/api/daemon',{headers:{accept:'application/json'}}).then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('daemon');
    el.textContent='守护：'+(d&&d.role||'?')+' · scope='+(d&&d.scope||'?')+' · 上次sweep='+(d&&d.lastSweepAt?new Date(d.lastSweepAt).toLocaleString():'从未')+' · inbox='+(d&&d.inbox!=null?d.inbox:'?');
  }).catch(function(){});
}
function kpiItem(label,n){ var s=document.createElement('span'); s.innerHTML=label+' <b>'+n+'</b>'; return s; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
document.addEventListener('DOMContentLoaded', function(){
  refresh();
  var es=new EventSource(api+'/api/board/events');
  es.onmessage=function(){ refresh(); };
  setInterval(refresh, 30000);
});
`, `
<header><h1>🖥 军团总指挥部 <span style="font-size:11px;color:#6fb3ff">v2 hub</span></h1><span id="status" style="font-size:12px;color:#7d8aa3">实时总览</span></header>
<div class="console">
<div class="panel"><h2>任务池（software）</h2><div class="kpi" id="kpi"></div><ul class="log" id="tasks"></ul></div>
<div class="panel"><h2>守护状态</h2><div class="daemon" id="daemon">读取中…</div><h2 style="margin-top:10px">最近活动（v2 audit）</h2><ul class="log" id="log"></ul></div>
</div>
`)
