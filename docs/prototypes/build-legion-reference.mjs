import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// 只读选取界面字段，不导出密钥、消息正文、模型凭证或运行上下文。
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const db=new DatabaseSync(path.join(root,'team-hub/team.db'),{readOnly:true});
const parse=(value,fallback=[])=>{try{return JSON.parse(value??'null')??fallback}catch{return fallback}};
const snapshot={
 capturedAt:new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),
 spaces:db.prepare('SELECT id,name,private,scene_preset FROM spaces ORDER BY createdAt').all(),
 roster:db.prepare('SELECT scope,role,name,kind,sort FROM roster ORDER BY scope,sort').all(),
 tasks:db.prepare('SELECT id,title,description,acceptance,priority,status,version,soldier,role,scope,blockedBy,goalId,hold FROM tasks ORDER BY updatedAt DESC').all().map(t=>({...t,description:t.description?.slice(0,1800),acceptance:parse(t.acceptance),blockedBy:parse(t.blockedBy)})),
 goals:db.prepare('SELECT id,scope,objective,status,version,contextVersion FROM goal ORDER BY updatedAt DESC').all(),
 stages:db.prepare('SELECT scope,role,label,enabled,sort FROM space_stages ORDER BY scope,sort').all(),
 skills:db.prepare('SELECT id,name,scope,status,version FROM skills ORDER BY updatedAt DESC').all(),
 conversations:db.prepare('SELECT id,scope,kind,title FROM conversations ORDER BY updatedAt DESC LIMIT 30').all(),
 files:fs.readdirSync(root,{withFileTypes:true}).filter(f=>!f.name.startsWith('.')).slice(0,14).map(f=>({name:f.name,type:f.isDirectory()?'dir':'file'}))
};db.close();
const htmlFile=path.join(here,'legion-workbench.html');
let html=fs.readFileSync(htmlFile,'utf8');
const oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const iconSource=oldScript.slice(0,oldScript.indexOf("document.querySelectorAll('[data-icon]')")).split('\nconst repoSnapshot = ')[0];
const source=fs.readFileSync(path.join(here,'legion-workbench-content.js'),'utf8');
const script=iconSource+'\nconst repoSnapshot = '+JSON.stringify(snapshot).replace(/</g,'\\u003c')+';\n'+source;
html=html.replace(/<script>[\s\S]*?<\/script>/,'<script>\n'+script+'\n</script>');
html=html.replace('<span class="rail-dot"></span>','');
const css=`
.repo-note{font-size:10px;color:#9aa5b1;margin-top:25px}.repo-columns{grid-template-columns:repeat(6,250px);align-items:start;overflow-x:auto;padding-bottom:16px}.repo-columns .column{min-height:430px}.view-pills{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.filter.on{background:#e5f1f2;color:#008594;border-color:#cbdfe1}.agent-tabs{display:flex;align-items:center;gap:24px;padding:0 32px;background:white;border-bottom:1px solid #e6e9ee;height:44px;flex-shrink:0}.agent-tabs button{height:100%;padding:0 5px;font-size:12px;color:#8794a1}.agent-tabs button.selected{color:#008594;border-bottom:2px solid #008594}.agent-tabs>span{margin-left:auto;font-size:10px;color:#a3adb7}.task-link{display:flex;width:100%;justify-content:space-between;gap:12px;text-align:left;font-size:12px;padding:10px 0;border-top:1px solid #edf0f3;line-height:1.65}.task-link span{overflow-wrap:anywhere}.task-link small{font-size:10px;color:#8b98a5;white-space:nowrap}.drawer .task-link{font-size:11px}.drawer .generic-item{align-items:start}.drawer{top:124px}.detail-mask{position:fixed;inset:0;background:#20334055;display:flex;align-items:center;justify-content:center;z-index:20;padding:24px}.detail-dialog{width:900px;max-width:100%;max-height:90vh;background:white;border-radius:15px;box-shadow:0 15px 60px #20334033;display:flex;flex-direction:column}.detail-head{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #e6e9ee}.detail-body{padding:24px;overflow:auto}.detail-body h2{font-size:19px;line-height:1.7;overflow-wrap:anywhere}.detail-section{border-top:1px solid #e6e9ee;margin-top:22px;padding-top:16px;font-size:12px;overflow-wrap:anywhere}.detail-section h3{font-size:13px}.detail-section p{line-height:1.9}.detail-foot{display:flex;gap:8px;flex-wrap:wrap;padding:18px 24px;border-top:1px solid #e6e9ee}.repo-form{display:grid;grid-template-columns:1fr 1fr;gap:18px}.repo-form label{font-size:12px;color:#7d8795;display:grid;gap:7px}.repo-form input,.repo-form select,.repo-textarea{border:1px solid #e6e9ee;border-radius:7px;padding:10px;width:100%;background:#fff;color:#202b38;font:inherit}.repo-textarea{height:150px;resize:vertical;margin-bottom:12px}.pipeline{display:flex;gap:10px;overflow-x:auto;padding:10px 0}.pipeline>div{min-width:135px;border:1px solid #e6e9ee;padding:14px;border-radius:8px}.pipeline strong{font-size:12px;font-weight:500}.pipeline small{display:block;color:#97a2af;font-size:10px;margin-top:5px}.model-tabs{margin-bottom:20px}.repo-table-head{display:flex;justify-content:space-between;font-size:11px;background:#f5f6f8;padding:10px}.calendar-grid{display:grid;grid-template-columns:repeat(7,1fr);border:1px solid #e6e9ee;border-radius:9px;overflow:hidden;background:#fff}.calendar-week{text-align:center;font-size:11px;color:#9aa5b1;padding:12px;background:#f9fafb}.calendar-day{height:85px;border-top:1px solid #e6e9ee;border-right:1px solid #e6e9ee;padding:9px;font-size:12px;color:#7d8795}.calendar-day.today{color:#008594;background:#e5f1f2}.repo-switch{font-size:13px;color:#4a6575}.repo-switch input{accent-color:#008594}@media(max-width:650px){.repo-form{grid-template-columns:1fr}.agent-tabs{padding:0 15px}.agent-tabs>span{font-size:9px}.calendar-day{height:55px}.detail-mask{padding:10px}.header-actions{flex-wrap:wrap;justify-content:flex-end}.header-actions .filter,.header-actions .primary{font-size:10px;padding:5px}.detail-foot{padding:12px}.drawer{top:114px}}`;
html=html.replace(/<style id="repo-content-style">[\s\S]*?<\/style>/,'');
html=html.replace('</head>','<style id="repo-content-style">'+css+'</style>\n</head>');
fs.writeFileSync(htmlFile,html);
console.log(`Updated ${htmlFile}: ${snapshot.spaces.length} spaces, ${snapshot.roster.length} agents, ${snapshot.tasks.length} tasks`);
