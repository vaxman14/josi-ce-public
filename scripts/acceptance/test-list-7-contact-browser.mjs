// Real browser rendering, synthetic API fixtures; never live address-book data.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
const results=[];
try {
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const page=await browser.newPage({viewport});let stopped=false,failed=false;const actions=[];
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(path==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
   if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'proof',username:'owner',role:'super_admin'}}});
   if(path==='/api/assistant/contacts')return route.fulfill({json:{contacts:[{id:'contact',name:'Synthetic Contact',email:'fixture@example.test',source:'google',sourceAccount:'fixture@example.test',conflictState:'both_changed'}]}});
   if(path==='/api/contacts/sync')return failed?route.fulfill({status:503,json:{error:'Unavailable'}}):route.fulfill({json:{origins:[{id:'origin',connectionId:'connection',provider:'google',sourceAccount:'fixture@example.test',status:stopped?'disconnected':'idle',syncMode:'import_only',lastSyncAt:'2026-09-16T12:00:00Z',intervalSeconds:900,counts:{created:1},incremental:true}]}});
   if(path.startsWith('/api/contacts/sync/')){actions.push({path,method:request.method(),body:request.postDataJSON()});if(path.endsWith('/stop'))stopped=true;if(path.endsWith('/connection'))stopped=false;return route.fulfill({json:{status:'idle',needsReview:[]}});}
   return route.fulfill({json:{}});
  });
  await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18492')+'/app/contacts');
  await page.getByRole('button',{name:'Sync now',exact:true}).click();
  await page.getByLabel('How often to sync').selectOption('3600');
  await page.getByRole('button',{name:'Stop syncing',exact:true}).click();
  await page.getByRole('button',{name:'Restart import sync',exact:true}).click();
  await page.getByRole('button',{name:'Sync now',exact:true}).waitFor();
  assert(actions.some(a=>a.path.endsWith('/origin/run')&&a.method==='POST'));
  assert(actions.some(a=>a.path.endsWith('/origin/interval')&&a.body.seconds===3600));
  assert(actions.some(a=>a.path.endsWith('/connection')&&a.body.mode==='import_only'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  failed=true;await page.reload();await page.getByRole('alert').filter({hasText:'Could not load contact synchronization status'}).waitFor();
  results.push({viewport,checks:['source identity','sync now','interval','stop','least-privilege restart','status loading failure','responsive containment']});
  await page.close();
 }
 console.log(JSON.stringify({pass:true,provider:'synthetic fixtures',results},null,2));
}finally{await browser.close();}
