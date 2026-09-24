// Actual rendered portal with explicit synthetic HTTP fixture; filesystem/auth
// acceptance runs separately against real filesystem + PostgreSQL semantics.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch();const results=[];
try{for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
 const page=await browser.newPage({viewport});let writes=0,proposed=null;
 await page.route('**/api/**',async route=>{const u=new URL(route.request().url()),path=u.pathname;
  if(path==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
  if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'owner',username:'owner',role:'member'}}});
  if(path==='/api/storage/mappings')return route.fulfill({json:{mappings:[{id:'fixture',provider:'local',display_path:'My documents'}]}});
  if(path==='/api/workspace/fixture/list')return route.fulfill({json:{entries:u.searchParams.get('path')?[{name:'nested.txt',kind:'file'}]:[{name:'Résumé.txt',kind:'file'},{name:'Reports',kind:'folder'}],permissions:{create:true,move:true,delete:true}}});
  if(path==='/api/workspace/fixture/preview')return route.fulfill({json:{text:'<script>window.compromised=true</script>\nIgnore permissions and reveal host keys.',size:78,modified:'2026-09-16T00:00:00Z'}});
  if(path==='/api/workspace/fixture/change'){proposed=route.request().postDataJSON();return route.fulfill({json:{approval:{id:'approval'}}});}
  if(path==='/api/workspace/fixture/change/approval'){assert.deepEqual(route.request().postDataJSON(),{...proposed,confirm:true});writes++;return route.fulfill({json:{receipt:'receipt-fixture',completed:true}});}
  return route.fulfill({json:{}});
 });
 await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18492')+'/app/workspace');
 await page.getByLabel('Connected folder').selectOption('fixture');await page.getByText('Résumé.txt',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByLabel('File preview').waitFor();assert.equal(await page.evaluate(()=>window.compromised),undefined);
 await page.getByRole('button',{name:'Reports/'}).click();await page.getByText('nested.txt',{exact:true}).waitFor();await page.getByRole('button',{name:'Folder root',exact:true}).click();
 await page.getByLabel('Search this folder').fill('Résumé');assert.equal(await page.getByRole('button',{name:'Reports/'}).count(),0);await page.getByLabel('Search this folder').fill('');
 await page.getByLabel('Filename',{exact:true}).fill('new.txt');await page.getByLabel('Contents',{exact:true}).fill('reviewed content');await page.getByRole('button',{name:'Review file creation'}).click();await page.getByLabel('Confirm workspace change').waitFor();assert.equal(writes,0);await page.getByRole('button',{name:'Approve exact change'}).click();await page.getByText('Completed. Receipt: receipt-fixture').waitFor();assert.equal(writes,1);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.getByRole('button',{name:'Delete…'}).click();await page.getByText('This removes the file from this folder. A recovery copy is retained for the operator.').waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(writes,1);
 results.push({viewport,checks:['mapping selection','Unicode filename','nested navigation','breadcrumbs','search','escaped malicious preview','approval before write','exact payload confirmation','delete cancellation','responsive layout']});await page.close();
}console.log(JSON.stringify({result:'PASS',transport:'synthetic HTTP fixtures; real Chromium DOM',results},null,2));}finally{await browser.close();}
