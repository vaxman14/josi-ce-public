import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();let launches=0;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
  if(path==='/api/auth/me')return route.fulfill({json:{user:{id:'browser-proof',username:'owner',role:'super_admin'}}});
  if(path.endsWith('/network/launch')){launches++;return route.fulfill({status:401,json:{error:'The administrator password was incorrect. No maintenance controller was started.'}});}
  return route.fulfill({json:{}});
 });
 for(const width of [375,1280]){
  await page.setViewportSize({width,height:900});
  await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18480')+'/admin/network');
  const field=page.getByLabel('Admin password',{exact:true});await field.waitFor();
  assert.equal(await field.getAttribute('type'),'password');assert.equal(await field.getAttribute('autocomplete'),'current-password');
  assert(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled());
  await field.fill('fixture-wrong-password');await field.press('Enter');await page.getByRole('alert').waitFor();
  assert((await page.getByRole('alert').innerText()).includes('incorrect'));
  await page.evaluate(()=>document.body.style.zoom='2');
  assert(await field.isVisible());await field.fill('');
 }
 assert.equal(launches,2);assert.equal(await page.evaluate(()=>localStorage.length),0);
 console.log('PASS Chromium desktop/mobile, accessible password label, masking, current-password autofill semantics, disabled empty action, keyboard submit, error announcement, 200% zoom, no localStorage password');
}finally{await browser.close();}
