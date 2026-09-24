import { beforeAll, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { deleteEmailTemplate, freezeEmailTemplate, listEmailTemplates, renderEmailTemplate, resolveEmailTemplate, saveEmailTemplate, validateEmailTemplate, verifyFrozenEmail } from '../src/templates.js';
import { renderedEmailMime } from '../src/mime.js';

export const template = {name:'Welcome',subject:'Hello {{name}}',heading:'Hello {{recipient}}',body:'First paragraph\nnext line\n\nOn {{date}} at {{time}}.',accentColor:'#2563eb',ctaLabel:'Visit',ctaUrl:'https://example.test/?a=1&b=2',footer:'Regards,\nTeam'};
const values = {name:'<img src=x onerror=alert(1)>',recipient:'alex@example.test',date:'Sep 18',time:'10 AM PDT'};

describe('constrained email rendering',()=>{
  it('escapes every text context and preserves useful plain text',()=>{
    const result = renderEmailTemplate({...template,heading:'<script>alert(1)</script>',body:'{{name}}\n\n{{date}} & {{time}}',footer:'<iframe src=x>',ctaLabel:'<b>Go</b>'},values);
    expect(result.subject).toBe('Hello '+values.name);
    expect(result.html).not.toMatch(/<script|<img|<iframe|<b>/);
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('&lt;img');
    expect(result.html).toContain('a=1&amp;b=2');
    expect(result.text).toContain('<b>Go</b>: https://example.test/?a=1&b=2');
    expect(result.text).toContain('Sep 18 & 10 AM PDT');
    expect(result.text).toContain('<iframe src=x>');
  });
  it.each(['javascript:alert(1)','data:text/html,test','//example.test','https://user:pass@example.test','https://example.test/" onclick="bad','https://example.test/{{name}}'])('rejects unsafe CTA %s',ctaUrl=>{
    expect(()=>validateEmailTemplate({...template,ctaUrl})).toThrow();
  });
  it('rejects style injection, unknown fields, oversized input, missing values and headers',()=>{
    for (const patch of [{html:'<b>bad</b>'},{accentColor:'red;bad'},{body:'x'.repeat(30001)},{subject:'x\r\nBcc:bad'},{body:'{{unknown}}'},{ctaLabel:''}]) expect(()=>validateEmailTemplate({...template,...patch})).toThrow();
    expect(()=>renderEmailTemplate(template,{...values,date:''})).toThrow(/date/);
    expect(()=>renderEmailTemplate(template,{...values,name:'x\r\nBcc:bad'})).toThrow();
  });
  it('does not recursively interpolate merge values and encodes both MIME alternatives exactly',()=>{
    const rendered = renderEmailTemplate(template,{...values,name:'{{date}}'});
    expect(rendered.subject).toBe('Hello {{date}}');
    const raw = renderedEmailMime(rendered,'alex@example.test',[]);
    const parts = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map(m=>Buffer.from(m[1],'base64').toString());
    expect(parts).toEqual([rendered.text,rendered.html]);
  });
});

describe('private template persistence',()=>{
  let db:TestDb,alice:string,bob:string;
  beforeAll(async()=>{db=await testDb();alice=(await createUser(db,{email:'a@template.test',username:'alice',role:'member'})).id;bob=(await createUser(db,{email:'b@template.test',username:'bob',role:'super_admin'})).id;});
  it('scopes list/read/update/delete and exact names to the owner, including admins',async()=>{
    const saved=await saveEmailTemplate(db,alice,template);
    expect(await listEmailTemplates(db,bob)).toEqual([]);
    for(const selector of [{id:saved.id},{name:saved.name}])await expect(resolveEmailTemplate(db,bob,selector)).rejects.toThrow('not found');
    await expect(saveEmailTemplate(db,bob,template,saved.id)).rejects.toThrow('not found');
    await expect(deleteEmailTemplate(db,bob,saved.id)).rejects.toThrow('not found');
    expect((await resolveEmailTemplate(db,alice,{id:saved.id})).name).toBe('Welcome');
    await saveEmailTemplate(db,alice,{...template,name:'Updated'},saved.id);
    expect((await resolveEmailTemplate(db,alice,{name:'Updated'})).id).toBe(saved.id);
    await deleteEmailTemplate(db,alice,saved.id);
    await expect(resolveEmailTemplate(db,alice,{id:saved.id})).rejects.toThrow('not found');
  });
  it('refuses duplicate exact names and never falls back from ID to name',async()=>{
    const saved=await saveEmailTemplate(db,alice,template);
    await saveEmailTemplate(db,alice,template);
    await expect(resolveEmailTemplate(db,alice,{name:'Welcome'})).rejects.toThrow('ambiguous');
    await expect(resolveEmailTemplate(db,alice,{name:'welcome'})).rejects.toThrow('not found');
    await expect(resolveEmailTemplate(db,alice,{id:'Welcome'})).rejects.toThrow('not found');
    await expect(resolveEmailTemplate(db,alice,{id:saved.id,name:'Welcome'})).rejects.toThrow('exactly one');
    expect((await resolveEmailTemplate(db,alice,{id:saved.id})).id).toBe(saved.id);
  });
  it('freezes output across edits and deletion and detects tampering',async()=>{
    const saved=await saveEmailTemplate(db,alice,{...template,name:'Frozen'});
    const {recipient,...merge}=values;
    const frozen=await freezeEmailTemplate(db,alice,{id:saved.id},recipient,merge);
    await saveEmailTemplate(db,alice,{...template,name:'Changed',body:'different'},saved.id);
    await deleteEmailTemplate(db,alice,saved.id);
    expect(verifyFrozenEmail(frozen)).toEqual(frozen);
    expect(()=>verifyFrozenEmail({...frozen,html:'<script>bad</script>'})).toThrow();
  });
});
