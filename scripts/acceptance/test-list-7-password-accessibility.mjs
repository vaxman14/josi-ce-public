// Rendered-engine and accessibility-tree proof. This does not claim a physical
// screen reader or a real password-manager extension accepted the flow.
import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
const results=[];
for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();
 try{
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();let launches=0;
   await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    assert(!url.search.includes('password'));
    if(url.pathname==='/api/setup/state')return route.fulfill({status:404,body:'{}'});
    if(url.pathname==='/api/auth/me')return route.fulfill({json:{user:{id:'a11y-proof',username:'owner',role:'super_admin'}}});
    if(url.pathname.endsWith('/network/launch')){launches++;return route.fulfill({status:401,json:{error:'The administrator password was incorrect. No controller was started.'}});}
    return route.fulfill({json:{}});
   });
   await page.goto((process.env.E2E_BASE??'http://127.0.0.1:18492')+'/admin/network');
   const field=page.getByLabel('Admin password',{exact:true});await field.waitFor();
   assert.equal(await field.getAttribute('type'),'password');assert.equal(await field.getAttribute('autocomplete'),'current-password');
   assert(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled());
   const help=await field.getAttribute('aria-describedby');assert(help);assert((await page.locator(`[id="${help}"]`).textContent()).includes('never saved'));
   // Capture only the empty input's accessibility tree; no secret is in this tree.
   if(name==='chromium'){
    const session=await context.newCDPSession(page);const {nodes}=await session.send('Accessibility.getFullAXTree');
    assert(nodes.some(n=>!n.ignored&&n.name?.value==='Admin password'&&n.role?.value==='textbox'));
    await session.detach();
   }else{
    assert((await page.locator('body').ariaSnapshot()).includes('Admin password'));
   }
   await field.focus();await field.pressSequentially('synthetic-rejected-fixture');await field.press('Enter');
   await page.getByRole('alert').waitFor();assert.equal(launches,1,`${name}/${width}: ${await page.getByRole('alert').textContent()}`);assert((await page.getByRole('alert').textContent()).includes('incorrect'));
   await field.fill('');await page.evaluate(()=>document.body.style.zoom='2');assert(await field.isVisible());
   const persisted=await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}));
   assert.deepEqual(persisted,{local:0,session:0});
   results.push({engine:name,width,masking:true,label:true,accessibilityTree:true,keyboard:true,zoom200:true,noWebStorage:true});
   await context.close();
  }
 }finally{await browser.close();}
}
console.log(JSON.stringify({results,externalNotProven:['password-manager extension autofill','physical screen-reader session']},null,2));
