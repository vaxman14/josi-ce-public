import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
try {
 const page=await browser.newPage();let writes=0,failReadback=false;
 const clients=['google','microsoft'].map(provider=>({provider,configured:false,clientId:null,redirectUri:`https://josi.example.test/api/connections/${provider}/callback`}));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
  if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'proof',username:'owner',role:'super_admin'}}});
  if(path==='/api/admin/connectors/clients/google'){
   writes++;await new Promise(r=>setTimeout(r,250));
   failReadback=writes===1;
   const body=route.request().postDataJSON();clients[0]={...clients[0],configured:true,clientId:body.clientId,redirectUri:body.redirectUri};
   return route.fulfill({json:{ok:true}});
  }
  if(path==='/api/admin/connectors'){
   if(failReadback)return route.fulfill({status:503,json:{error:'Saved-state readback unavailable. Retry.'}});
   return route.fulfill({json:{clients,registration:{available:true,publicHttpsBase:'https://josi.example.test',detectedOrigin:'https://josi.example.test'},policy:[],suggestedRedirectUris:[]}});
  }
  if(path==='/api/admin/connectors/connections')return route.fulfill({json:{connections:[]}});
  return route.fulfill({json:{}});
 });
 await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18490')+'/admin/connectors');
 await page.locator('summary').filter({hasText:'Google application'}).click();
 await page.locator('summary').filter({hasText:'Microsoft 365 application'}).click();
 const google=page.locator('form').filter({has:page.locator('#cid-google')});
 const save=google.getByRole('button',{name:'Save',exact:true});assert(await save.isDisabled());
 await page.locator('#cid-microsoft').fill('keep-other-open-edit');
 await page.locator('#cid-google').fill('reviewed-client');await page.locator('#csec-google').fill('synthetic-secret');
 await save.click();assert(await google.getByRole('button',{name:'Saving…'}).isDisabled());
 await page.getByRole('alert').waitFor();assert.equal(writes,1);assert.equal(await page.locator('#csec-google').inputValue(),'synthetic-secret');
 assert.equal(await google.getByRole('status').count(),0);assert(!(await save.isDisabled()));
 await save.click();await google.getByRole('status').waitFor();assert.equal(writes,2);assert(await save.isDisabled());
 assert.equal(await page.locator('#csec-google').inputValue(),'');assert.equal(await page.locator('#cid-microsoft').inputValue(),'keep-other-open-edit');
 console.log('PASS OAuth pristine/pending/readback-failure/retry/success; failed secret retained; other open section edits preserved');
} finally {await browser.close();}
