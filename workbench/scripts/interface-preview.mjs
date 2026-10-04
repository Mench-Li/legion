// 独立预览：只复制允许的界面数据，不复制运行实例、自动化、凭证或用户消息。
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const sourceIndex=process.argv.indexOf('--source-data')
const sourceFile=sourceIndex>=0?process.argv[sourceIndex+1]:null
const directory=join(root,'.interface-preview');mkdirSync(directory,{recursive:true})
const fixture=join(directory,'team.db')
process.env.TEAM_HUB_DB=fixture
process.env.TEAM_HUB_PORT='8791'
process.env.TEAM_HUB_HOST='127.0.0.1'
process.env.TEAM_HUB_TOKEN=''
const hub=await import('../../team-hub/server.mjs')
if(sourceFile){
 const source=new DatabaseSync(resolve(sourceFile),{readOnly:true})
 const tables={
  spaces:['id','name','private','scene_preset','createdAt','updatedAt'],
  roster:['scope','role','name','kind','avatar','sort'],
  tasks:['id','title','description','acceptance','priority','status','version','soldier','role','scope','parent','blocks','blockedBy','comments','evidence','patches','artifacts','createdAt','updatedAt','goalId','hold'],
  goal:['id','scope','objective','status','version','mode','createdAt','updatedAt','contextVersion'],
  space_stages:['scope','role','label','prompt','next','gate','artifact','docs','sort','enabled','updatedAt'],
 }
 // 仅首次生成，之后保留用户在独立预览中的会话与操作。
 const seeded=hub.db.prepare("SELECT 1 FROM conversations WHERE agent_role IS NOT NULL LIMIT 1").get()
 if(!seeded){
  hub.db.exec('BEGIN IMMEDIATE')
  try{
   for(const [table,columns] of Object.entries(tables)){
    const rows=source.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all()
    hub.db.prepare(`DELETE FROM ${table}`).run()
    const insert=hub.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`)
    for(const row of rows)insert.run(...columns.map(c=>row[c]))
   }
   // 文件操作仅指向此工作区；不沿用源数据库的外部仓库路径。
   hub.db.prepare("UPDATE spaces SET local_dir=?,remote_url='' WHERE id='software'").run(root)
   hub.db.exec('COMMIT')
  }catch(e){hub.db.exec('ROLLBACK');throw e}
 }
 source.close()
}
hub.db.close()
const children=[]
const start=(script,env)=>{const child=spawn(process.execPath,[join(root,script)],{cwd:root,env:{...process.env,...env},stdio:'inherit',windowsHide:true});children.push(child);child.on('exit',code=>{if(code){console.error(`${script} exited: ${code}`);for(const peer of children)peer.kill();process.exitCode=code}});return child}
// 预览实例同样要被告知宿主地址（Bug #1「供应商与模型无法读取」）：不注入的话桥接层会回落到
// 3080 —— 在 Desktop 部署上那是没人监听的端口，模型供应商页会整页读不出来。
// 宿主地址优先取显式配置，其次取 DSH 会话里的 DSH_WEB_URL。
const dshModelsBaseUrl=process.env.DSH_MODELS_BASE_URL??process.env.DSH_WEB_URL??''
start('team-hub/server.mjs',{})
start('workbench/scripts/serve.mjs',{DSH_WORKBENCH_PORT:'4821',DSH_WORKBENCH_HOST:'127.0.0.1',DSH_WORKBENCH_TOKEN:'',DSH_HUB_UPSTREAM:'http://127.0.0.1:8791',...(dshModelsBaseUrl?{DSH_MODELS_BASE_URL:dshModelsBaseUrl}:{})})
const stop=()=>{for(const child of children)child.kill()};process.on('SIGINT',stop);process.on('SIGTERM',stop)
console.log('Independent interface preview: http://127.0.0.1:4821/?api=http://127.0.0.1:4821')
console.log(`Isolated database: ${fixture}`)
