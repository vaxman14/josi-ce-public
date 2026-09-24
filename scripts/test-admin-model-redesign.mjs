#!/usr/bin/env node
// Focused browser regression for the approved admin Model redesign.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const portServer=createServer();
await new Promise(done=>portServer.listen(0,'127.0.0.1',done));
const port=portServer.address().port;
await new Promise(done=>portServer.close(done));
const url=`http://127.0.0.1:${port}/test/adminModel-redesign-fixture.html`;
const server=spawn('npm',['run','dev','--workspace','@josi-ce/web','--','--host','127.0.0.1','--port',String(port),'--strictPort'],{
  cwd:root,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',
  env:{...process.env,...(process.platform==='darwin'?{TMPDIR:'/Volumes/JosiOS/JosiDrive/Projects/.tmp'}:{})},
});
let log='';for(const stream of [server.stdout,server.stderr]) stream.on('data',d=>{log=(log+d.toString()).slice(-3000)});
let browser;
try{
  let ready=false;
  for(let n=0;n<50;n++){
    try{ready=(await fetch(url)).ok}catch{}
    if(ready)break;
    await pause(200);
  }
  if(!ready)throw Error('Vite fixture did not start: '+log);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  await page.getByRole('heading',{name:'Model',exact:true}).waitFor();
  await page.waitForFunction(()=>window.calls.some(x=>x.path==='/api/admin/llm'&&x.method==='GET') && !document.body.innerText.includes('Loading…'));
  if((await page.evaluate(()=>window.calls.some(x=>x.method==='PUT'||x.path.endsWith('/probe')))))throw Error('Opening page changed provider');
  const change=page.getByRole('button',{name:'Change model',exact:true});
  if(await change.count()!==1)throw Error('Missing one clear Change model action');
  await change.click();
  await page.waitForFunction(()=>window.calls.some(x=>x.path==='/api/admin/llm/models'));
  const radios=page.getByRole('radio');
  if(await radios.count()!==3)throw Error(`Expected Automatic + two CLI candidates, got ${await radios.count()} choices`);
  if(!await radios.first().isChecked())throw Error('Automatic did not remain selected');
  const saveBox=await page.getByRole('button',{name:'Save & test',exact:true}).boundingBox();
  const cancelBox=await page.getByRole('button',{name:'Cancel',exact:true}).boundingBox();
  if(!saveBox||!cancelBox||Math.abs(saveBox.y-cancelBox.y)>8)throw Error('Cancel and Save & test are not on the same row');
  await page.screenshot({path:'/Volumes/JosiOS/JosiDrive/Projects/release-20260923/mockups/josi-ce-model-implemented-desktop.png',fullPage:true});
  await page.getByRole('radio',{name:/CLI Two/}).click();
  const ack=page.locator('input[name="ack"]');
  if(await ack.count())await ack.check();
  await page.getByRole('button',{name:'Save & test',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(x=>x.path==='/api/admin/llm/providers/primary/probe'));
  const result=await page.evaluate(()=>window.calls.filter(x=>x.path==='/api/admin/llm/providers/primary'||x.path.endsWith('/probe')));
  if(result.length!==2||result[0].method!=='PUT'||result[0].body.model!=='test-cli-two'||result[1].method!=='POST')throw Error('Save and test did not persist the exact model then probe');
  await page.getByText('Working',{exact:true}).waitFor();
  await page.locator('p.text-xl').filter({hasText:'test-cli-two'}).waitFor();

  const mobile=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  await mobile.goto(url);
  await mobile.getByRole('button',{name:'Change model',exact:true}).click();
  await mobile.getByRole('radio',{name:/CLI Two/}).waitFor();
  await mobile.screenshot({path:'/Volumes/JosiOS/JosiDrive/Projects/release-20260923/mockups/josi-ce-model-implemented-mobile.png'});
  await mobile.getByRole('button',{name:'Save & test',exact:true}).scrollIntoViewIfNeeded();
  await mobile.screenshot({path:'/Volumes/JosiOS/JosiDrive/Projects/release-20260923/mockups/josi-ce-model-implemented-mobile-bottom.png'});
  const overflow=await mobile.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  if(overflow)throw Error('Mobile viewport has horizontal overflow');

  const failed=await browser.newPage({viewport:{width:1280,height:900}});
  await failed.goto(url+'?probeFail');
  await failed.getByRole('button',{name:'Change model',exact:true}).click();
  await failed.getByRole('radio',{name:/CLI One/}).check();
  await failed.locator('input[name="ack"]').check();
  await failed.getByRole('button',{name:'Save & test',exact:true}).click();
  await failed.getByText(/Saved, but the test did not pass/).waitFor();
  await failed.getByText('Not tested',{exact:true}).waitFor();
  if(!await failed.getByRole('heading',{name:'Change model'}).isVisible())throw Error('Failed probe hid the editor');
  const claude=await browser.newPage();
  await claude.goto(url+'?claude');
  await claude.getByText('Working',{exact:true}).waitFor();
  if(!await claude.getByText('Automatic (Claude chooses)',{exact:true}).count())throw Error('Claude default is incorrectly attributed to Codex');
  const stale=await browser.newPage();
  await stale.goto(url+'?slowModels');
  await stale.getByRole('button',{name:'Change model',exact:true}).click();
  await stale.waitForFunction(()=>typeof window.releaseModels==='function');
  await stale.locator('#provider').selectOption('openai_compatible');
  await stale.evaluate(()=>window.releaseModels());
  await stale.waitForFunction(()=>!document.body.innerText.includes('Asking…'));
  if(await stale.locator('#model option').count())throw Error('Old ChatGPT discovery leaked into the local provider picker');
  const race=await browser.newPage();
  await race.goto(url+'?slowProbe');
  await race.getByRole('button',{name:'Change model',exact:true}).click();
  await race.getByRole('radio',{name:/CLI One/}).waitFor();
  await race.getByText('Connection & advanced').click();
  await race.getByRole('button',{name:'Test again'}).click();
  await race.waitForFunction(()=>typeof window.releaseProbe==='function');
  if(!await race.getByRole('button',{name:'Save & test'}).isDisabled())throw Error('Save & test is enabled during another probe');
  await race.evaluate(()=>window.releaseProbe());
  if(errors.length)throw Error('Browser error: '+errors.join(' / '));
  console.log('admin_model_redesign=pass choices=3 explicit_model_saved=true probe_called=true failure_reported=true mobile_overflow=false errors=0');
}finally{
  if(browser)await browser.close();
  if(server.pid){try{if(process.platform==='win32')server.kill('SIGTERM');else process.kill(-server.pid,'SIGTERM')}catch{}}
}
