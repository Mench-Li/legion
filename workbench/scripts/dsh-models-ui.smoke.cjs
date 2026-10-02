const path=require('node:path');const fs=require('node:fs');const assert=require('node:assert/strict');
const {chromium}=require(path.join(process.argv[2],'playwright'));
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:4821/?api=http://127.0.0.1:4821';await page.goto(url);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'模型与凭证',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'请先登录本机 DSH'}).waitFor();
 const writes=[];let revision=3;
 const profile={displayName:'实际供应商',api:'openai-responses',baseURL:'https://models.example/v1',apiKeyEnv:'EXISTING_KEY',models:[{id:'model/real',name:'真实模型',contextWindow:12345,input:['text','image']}]};
 const namespace={ns:'llm-pi-ai',revision,value:{providers:{actual:profile}}};
 await page.route('**/api/dsh-models',async route=>{
  const {method,args}=route.request().postDataJSON();let value;
  if(method==='session/modelCatalog')value={default:{provider:'actual',model:'model/real'},groups:[{id:'actual',name:'实际供应商',models:[{id:'model/real',name:'真实模型'}]}],failures:[]};
  else if(method==='llm/listConfigurableProviders')value=[{provider:'actual',displayName:'实际供应商',settingsNs:'llm-pi-ai',settingsPath:['providers','actual'],declared:true}];
  else if(method==='settings/describe')value={writable:true,namespaces:[{...namespace,revision}]};
  else if(method==='llm/discoverModels'){assert.equal(args.settingsNs,'llm-pi-ai');value=[{id:'discovered-model'}];}
  else {writes.push({method,args});if(method==='settings/mutate'){assert.equal(args.expectedRevision,revision);revision++;}value=null;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,value})});
 });
 await page.getByRole('button',{name:'刷新配置',exact:true}).click();await page.getByText('已配置 1 个供应商',{exact:false}).waitFor();
 await page.getByRole('button',{name:'编辑供应商',exact:true}).click();
 const form=page.locator('.model-provider-form');await form.getByLabel('API 地址',{exact:true}).fill('https://new.example/v1');
 await form.getByLabel('API 密钥（留空保留原凭证）',{exact:true}).fill('fixture-secret-not-a-real-key');
 await form.getByRole('button',{name:'保存供应商',exact:true}).click();await page.getByRole('status').filter({hasText:'已保存'}).waitFor();
 assert.equal(writes.length,2);assert.equal(writes[0].method,'settings/mutate');assert.equal(writes[1].method,'credentials/set');assert.equal(writes[1].args.ref,'EXISTING_KEY');
 assert.equal(JSON.stringify(writes[0]).includes('fixture-secret'),false);
 const modelsOp=writes[0].args.ops.find(op=>op.path.at(-1)==='models');assert.equal(modelsOp.value[0].contextWindow,12345);assert.deepEqual(modelsOp.value[0].input,['text','image']);
 await page.getByLabel('选择工作空间',{exact:true}).selectOption('software');
 await page.getByRole('button',{name:'⚡ 快速分配',exact:true}).click();
 const select=page.getByLabel('编码工程师的模型',{exact:true});await select.waitFor();await page.waitForTimeout(300);
 assert.equal(await select.locator('optgroup').count(),1);assert.equal(await select.locator('option').filter({hasText:'真实模型'}).count(),1);
 const colors=await select.evaluate(el=>({background:getComputedStyle(el).backgroundColor,text:getComputedStyle(el).color,row:getComputedStyle(el.closest('.mc-row')).backgroundColor}));
 assert.equal(colors.background,'rgb(255, 255, 255)');assert.equal(colors.text,'rgb(32, 43, 56)');assert.equal(colors.row,'rgb(255, 255, 255)');
 const fixtureKeyInStorage=await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('fixture-secret')));assert.equal(fixtureKeyInStorage,false);
 await page.screenshot({path:path.join(process.cwd(),'.interface-preview','model-quick.png')});
 await page.getByRole('button',{name:'供应商与模型',exact:true}).click();await page.getByRole('button',{name:'添加供应商',exact:true}).click();await page.locator('.model-provider-form').waitFor();
 await page.getByRole('button',{name:'获取可用模型',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.model-provider-form textarea')?.value==='discovered-model');assert.equal(await page.getByLabel('模型 ID（每行一个）',{exact:true}).inputValue(),'discovered-model');
 await page.screenshot({path:path.join(process.cwd(),'.interface-preview','model-providers.png')});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(process.cwd(),'.interface-preview','model-settings-check.json'),JSON.stringify({passed:true,realHostUnauthorizedVerified:true,configurationWriteFixtureVerified:true,checks:['light contrast','DSH login error','live catalog','provider editor','version fencing','write-only credential','model metadata preserved','mobile'],pageErrors:errors},null,2));
 await browser.close();console.log('PASS: readable controls, actual-host authentication failure, DSH configuration contracts with fixture, model metadata and narrow screen');
})().catch(e=>{console.error(e);process.exit(1)});
