// Isolated browser regression: Vite + intercepted API. No live services or sends.
// Run after npm run build: node scripts/test-email-templates-ui.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { renderEmailTemplate, validateEmailTemplate } from '../packages/mail/dist/templates.js';

process.chdir(fileURLToPath(new URL('../apps/web', import.meta.url)));
const server = await createServer({configFile:'vite.config.ts',server:{host:'127.0.0.1',port:0}});
await server.listen();
const port=server.httpServer.address().port;
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let saved=[],drafts=[];
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const method=route.request().method();
    const data=route.request().postDataJSON();
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/setup/state')return json({},404);
    if(path==='/api/auth/me')return json({user:{id:'owner',username:'owner',role:'member'}});
    if(path==='/api/mail/templates/preview'){
      try{return json(renderEmailTemplate(data.template,{recipient:data.recipient,...data.merge_values}));}catch(e){return json({error:e.message},400);}
    }
    if(path==='/api/mail/templates/draft'){
      drafts.push(data);
      const rendered=data.template_id?renderEmailTemplate(Object.fromEntries(Object.entries(saved.find(t=>t.id===data.template_id)).filter(([key])=>key!=='id')),{recipient:data.recipient,...data.merge_values}):null;
      return json({state:'prepared',approval_id:'approval',summary:`Send email\nTo: ${data.recipient}\nSubject: ${rendered?.subject??data.subject}\nBody: ${rendered?.text??data.body}`},201);
    }
    if(path==='/api/mail/templates'){
      if(method==='GET')return json({templates:saved});
      const template={...validateEmailTemplate(data),id:'11111111-1111-4111-8111-111111111111'};saved.push(template);return json({template},201);
    }
    if(path.startsWith('/api/mail/templates/')){
      if(method==='DELETE'){saved=[];return route.fulfill({status:204});}
      if(method==='PUT'){saved=[{...validateEmailTemplate(data),id:saved[0].id}];return json({template:saved[0]});}
    }
    return json({ready:true,templates:[],approvals:[],pending:[],threads:[],tasks:[]});
  });
  await page.goto(`http://127.0.0.1:${port}/app/email/templates`);
  await page.getByRole('heading',{name:'Templates',exact:true}).waitFor();
  await page.getByLabel('Template name', {exact:true}).fill('Browser welcome');
  await page.getByLabel('Body',{exact:true}).first().fill('Hello {{name}}\n\n<script>window.bad=true</script>');
  await page.getByRole('button',{name:'Save template',exact:true}).click();
  await page.getByText('Template saved.',{exact:true}).waitFor();
  assert.equal(saved[0].name,'Browser welcome');
  await page.getByLabel('Heading',{exact:true}).fill('Updated heading');
  await page.getByRole('button',{name:'Save template',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('iframe')?.srcdoc.includes('Updated heading'));
  assert.equal(saved[0].heading,'Updated heading');
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),'');
  const frame=page.frameLocator('iframe');
  await frame.getByRole('heading',{name:'Updated heading'}).waitFor();
  assert.equal(await frame.locator('script').count(),0);
  await page.getByRole('button',{name:'Mobile',exact:true}).click();
  assert.equal(Math.round((await page.locator('iframe').boundingBox()).width),375);
  await page.getByRole('button',{name:'Desktop',exact:true}).click();
  assert.ok((await page.locator('iframe').boundingBox()).width>375);
  await page.getByRole('combobox',{name:'Template',exact:true}).selectOption(saved[0].id);
  await page.getByLabel('To',{exact:true}).fill('alex@example.test');
  await page.getByLabel('Recipient name',{exact:true}).fill('Alex');
  await page.getByRole('button',{name:'Prepare for approval'}).click();
  await page.getByText('Prepared. No email has been sent.').waitFor();
  assert.equal(drafts[0].template_id,saved[0].id);
  assert.equal(drafts[0].merge_values.name,'Alex');
  await page.getByRole('combobox',{name:'Template',exact:true}).selectOption('');
  await page.getByLabel('Subject',{exact:true}).last().fill('Plain draft');
  await page.locator('form').last().locator('textarea').fill('Plain body');
  await page.getByRole('button',{name:'Prepare for approval'}).click();
  await page.getByText('Prepared. No email has been sent.').waitFor();
  assert.equal(drafts[1].body,'Plain body');assert.equal(drafts[1].template_id,undefined);
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await page.getByRole('button',{name:'Confirm delete',exact:true}).click();
  await page.getByText('Template deleted. Approved drafts keep their original content.').waitFor();
  assert.equal(saved.length,0);
  await page.setViewportSize({width:375,height:812});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS: template create/read/update/delete, safe preview, desktop/mobile, exact template draft, plain draft, mobile overflow.');
} finally {await browser.close();await server.close();}
