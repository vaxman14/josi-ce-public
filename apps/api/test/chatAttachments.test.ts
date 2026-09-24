import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createThread, json } from '@josi-ce/core';
import { cleanupAttachments } from '@josi-ce/storage';
import { createApp } from '../src/app.js';
let db:TestDb,server:Server,base:string,root:string,owner:string,thread:string,otherThread:string;
const jars:Record<string,string>={};
async function call(path:string, method='GET', body?:unknown, user='alice') {
  const jar=jars[user]||'';const csrf=/josi_csrf=([^;]+)/.exec(jar)?.[1];
  const res=await fetch(base+path,{method,headers:{cookie:jar,...(csrf?{'x-josi-csrf':decodeURIComponent(csrf)}:{}),...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});
  return res;
}
async function upload(name='note.txt',data:BlobPart='hello',type='text/plain',user='alice',threadId=thread) {
  const form=new FormData();form.append('file',new Blob([data],{type}),name);
  return call(`/api/assistant/threads/${threadId}/attachments`,'POST',form,user);
}
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'ce-upload-api-'));process.env.JOSI_UPLOAD_DIR=root;
  db=await testDb();await ensureWorkspace(db);
  for(const name of ['alice','bob','admin']) {
    const u=await createUser(db,{email:`${name}@test.invalid`,username:name,role:name==='admin'?'super_admin':'member',password:'fixture-password-123'});
    if(name==='alice')owner=u.id;
    if(name==='bob')otherThread=(await createThread(db,{ownerUserId:u.id})).id;
  }
  thread=(await createThread(db,{ownerUserId:owner})).id;
  const app=createApp(db,{cookieSecure:false,appUrl:'http://localhost',masterKeyCheck:false,attachmentStorageRoot:root});
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for(const name of ['alice','bob','admin']) {
    const csrf=await fetch(base+'/api/auth/csrf');jars[name]=csrf.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    const login=await call('/api/auth/login','POST',{identifier:name,password:'fixture-password-123'},name);
    expect(login.status).toBe(200);jars[name]+='; '+login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  }
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));delete process.env.JOSI_UPLOAD_DIR;});
it('publishes readable persisted content with safe headers and unique IDs',async()=>{
  const first=await upload();expect(first.status,await first.clone().text()).toBe(201);const a=(await first.json()).attachment;
  expect(a.analysis).toMatchObject({status:'available',kind:'text'});
  expect((await db.query<{storage_path:string}>(`select storage_path from chat_attachments where id=$1`,[a.id]))[0].storage_path).toBe(a.id);
  const second=await upload();expect(second.status).toBe(201);expect((await second.json()).attachment.id).not.toBe(a.id);
  const get=await call('/api/assistant/attachments/'+a.id);expect(get.status).toBe(200);expect(await get.text()).toBe('hello');
  expect(get.headers.get('content-disposition')).toMatch(/^attachment/);expect(get.headers.get('x-content-type-options')).toBe('nosniff');
  for(const who of ['bob','admin']) expect((await call('/api/assistant/attachments/'+a.id,'GET',undefined,who)).status).toBe(404);
  expect((await call('/api/assistant/attachments/'+a.id,'DELETE')).status).toBe(200);
  expect((await call('/api/assistant/attachments/'+a.id)).status).toBe(404);
});
it('refuses foreign threads and forged MIME before writing',async()=>{
  const before=await readdir(root);
  expect((await upload('x.txt','hello','text/plain','alice',otherThread)).status).toBe(404);
  expect((await upload('x.png','not png','image/png')).status).toBe(415);
  expect((await upload('x.txt','','text/plain')).status).toBe(400);
  expect(await readdir(root)).toEqual(before);
});
it('streams a valid ~20 MB video to staging and reports analysis unavailable without parser routing',async()=>{
  const size=20*1024*1024, bytes=new Uint8Array(size);const view=new DataView(bytes.buffer);
  view.setUint32(0,20);bytes.set(Buffer.from('ftyp'),4);bytes.set(Buffer.from('isom'),8);bytes.set(Buffer.from('isom'),16);
  view.setUint32(20,size-28);bytes.set(Buffer.from('mdat'),24);view.setUint32(size-8,8);bytes.set(Buffer.from('moov'),size-4);
  const res=await upload('clip.mp4',bytes,'video/mp4');expect(res.status).toBe(201);const attachment=(await res.json()).attachment;
  expect(attachment.byteSize).toBe(size);expect(attachment.analysis).toMatchObject({status:'unavailable',code:'analysis_unavailable'});
  expect((await call('/api/assistant/attachments/'+attachment.id)).status).toBe(200);
  expect((await call('/api/assistant/attachments/'+attachment.id,'DELETE')).status).toBe(200);
});
it('preserves analysis metadata in durable receipts and history',async()=>{
  const uploaded=(await (await upload()).json()).attachment;
  const accepted=await call(`/api/assistant/threads/${thread}/turns`,'POST',{client_message_id:`attachment-${randomUUID()}`,message:'',attachment_receipts:[uploaded.id]});
  expect(accepted.status).toBe(202);const acceptedBody=await accepted.json();
  expect(acceptedBody.turn.attachment_receipts[0].analysis).toMatchObject({status:'available'});
  const reconciled=await call(`/api/assistant/threads/${thread}/turns?turn_id=${acceptedBody.turn.id}`);expect(reconciled.status).toBe(200);
  expect((await reconciled.json()).turns[0].attachment_receipts[0].analysis).toMatchObject({status:'available'});
  const history=await call(`/api/assistant/threads/${thread}`);expect(history.status).toBe(200);
  const messages=(await history.json()).messages;const inbound=messages.find((m:any)=>m.meta?.attachments?.some((a:any)=>a.id===uploaded.id));
  expect(inbound.meta.attachments[0].analysis).toMatchObject({status:'available'});
});
it('returns actionable missing-volume error and releases the reservation',async()=>{
  const missing=join(root,'missing');process.env.JOSI_UPLOAD_DIR=missing;
  // Existing router pins its configured root; make a second router for the failed installation.
  const app=createApp(db,{cookieSecure:false,appUrl:'http://localhost',masterKeyCheck:false,attachmentStorageRoot:missing});
  let local:Server;await new Promise<void>(r=>{local=app.listen(0,'127.0.0.1',r)});
  const saved=base;base=`http://127.0.0.1:${(local!.address() as AddressInfo).port}`;
  try {
    const res=await upload();expect(res.status).toBe(503);expect((await res.json()).code).toBe('storage_missing');
    const ready=await call('/ready');expect(ready.status).toBe(503);expect((await ready.json()).blockers).toContain('attachment_storage');
  } finally {base=saved;process.env.JOSI_UPLOAD_DIR=root;await new Promise<void>(r=>local!.close(()=>r()));}
  expect(await db.query(`select id from chat_attachments where storage_state='pending'`)).toEqual([]);
});
it('serializes quota reservations and restores counts on deletion',async()=>{
  const [before]=await db.query<{bytes:number;files:number}>(`select bytes,files from chat_attachment_usage where scope=$1`,['user:'+owner]);
  await db.query(`update chat_attachment_usage set bytes=209715198 where scope=$1`,['user:'+owner]);
  const results=await Promise.all([upload('one.txt','xx'),upload('two.txt','xx')]);
  expect(results.map(r=>r.status).sort()).toEqual([201,413]);
  const success=results.find(r=>r.status===201)!;const id=(await success.json()).attachment.id;
  await call('/api/assistant/attachments/'+id,'DELETE');
  await db.query(`update chat_attachment_usage set bytes=$2,files=$3 where scope=$1`,['user:'+owner,before.bytes,before.files]);
});
it('preserves referenced legacy attachments while expiring abandoned uploads',async()=>{
  const kept=(await (await upload()).json()).attachment.id;
  const expired=(await (await upload()).json()).attachment.id;
  await db.query(`update chat_attachments set created_at=now()-interval '2 days' where id=any($1::uuid[])`,[[kept,expired]]);
  await db.query(`insert into messages(thread_id,direction,body,meta) values($1,'in','attachment',$2)`,[thread,json({attachments:[{id:kept}]})]);
  expect((await call('/api/assistant/attachments/'+kept,'DELETE')).status).toBe(409);
  expect(await cleanupAttachments(db,root)).toBe(1);
  expect((await call('/api/assistant/attachments/'+kept)).status).toBe(200);
  expect((await call('/api/assistant/attachments/'+expired)).status).toBe(404);
});
it('does not expose pending files or permit model selection across threads',async()=>{
  const a=(await (await upload()).json()).attachment.id;
  await db.query(`update chat_attachments set storage_state='pending' where id=$1`,[a]);
  expect((await call('/api/assistant/attachments/'+a)).status).toBe(404);
  const foreign=await call(`/api/assistant/threads/${otherThread}/talk`,'POST',{message:'look',attachmentIds:[a]},'bob');
  expect(foreign.status).toBe(404);
});
