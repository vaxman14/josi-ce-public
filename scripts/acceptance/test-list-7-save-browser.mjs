import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
try{
 const page=await browser.newPage();let writes=0;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
  if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'proof',username:'owner',role:'super_admin'}}});
  if(path==='/api/admin/workflows'&&route.request().method()==='POST'){
   writes++;await new Promise(r=>setTimeout(r,250));
   return writes===1?route.fulfill({status:503,json:{error:'Provider temporarily unavailable. Retry.'}}):route.fulfill({status:201,json:{callbackSecret:'synthetic-test-only'}});
  }
  if(path==='/api/admin/workflows')return route.fulfill({json:{integrations:[],workflows:[]}});
  return route.fulfill({json:{}});
 });
 await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18490')+'/admin/workflows');
 const save=page.getByRole('button',{name:'Test and save provider'});await save.waitFor();assert(await save.isDisabled());
 await page.getByLabel('Name',{exact:true}).fill('Reviewed connection');await page.getByLabel('MCP connection token',{exact:true}).fill('synthetic-test-token');
 await save.click();assert(await page.getByRole('button',{name:'Testing credential…'}).isDisabled());
 await page.getByRole('alert').waitFor();assert.equal(writes,1);assert.equal(await page.getByLabel('Name',{exact:true}).inputValue(),'Reviewed connection');assert(!(await save.isDisabled()));
 await save.click();await page.getByText('Provider verified and saved.',{exact:true}).waitFor();assert.equal(writes,2);assert(await save.isDisabled());assert.equal(await page.getByLabel('MCP connection token',{exact:true}).inputValue(),'');
 console.log('PASS workflow save pristine/invalid/dirty/saving/failure/retry/confirmed success states; pending action disabled; failed edit retained; secret cleared after readback');
}finally{await browser.close();}
