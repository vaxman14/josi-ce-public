import { request } from 'node:http';
import { appendEvent, approvalHash, json, requestApproval, type Db } from '@josi-ce/core';
import { workspaceGrant } from './localWorkspace.js';
import { PathEscape } from './paths.js';
import { looksLikeCredentialFile } from './extract.js';
export async function codingHelper(path: string, body: unknown): Promise<Record<string,unknown>> {
 const socketPath=process.env.JOSI_CODING_HELPER_SOCKET;
 if(!socketPath)throw new PathEscape('Coding sandbox is disabled. An administrator must install and enable the isolated helper.');
 return new Promise((resolve,reject)=>{const data=JSON.stringify(body);const req=request({socketPath,path,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{
  const chunks:Buffer[]=[];let size=0;res.on('data',(b:Buffer)=>{size+=b.length;if(size>100000)res.destroy(new Error('Sandbox response too large'));else chunks.push(b);});res.on('error',reject);res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)reject(new PathEscape('Sandbox request refused. Check image, helper and concurrency limits.'));else resolve(result);}catch{reject(new PathEscape('Invalid sandbox response'));}});
 });req.setTimeout(10000,()=>req.destroy(new Error('Sandbox helper timeout')));req.on('error',reject);req.end(data);});
}
async function grant(db:Db,userId:string,mappingId:string){await workspaceGrant(db,userId,mappingId);const [c]=await db.query<{coding_enabled:boolean}>('select coding_enabled from storage_capabilities where user_id=$1',[userId]);if(!c?.coding_enabled)throw new PathEscape('An administrator has not enabled coding access for you');if(!process.env.JOSI_CODING_HELPER_SOCKET)throw new PathEscape('Coding sandbox helper is not configured');}
export async function proposeCodingRun(db:Db,userId:string,mappingId:string,mode:string,source:string){
 await grant(db,userId,mappingId);
 if(!['check','run'].includes(mode)||typeof source!=='string'||Buffer.byteLength(source)>262144||looksLikeCredentialFile('code.js',source))throw new PathEscape('Choose check or run with non-secret JavaScript up to 256 KiB');
 const [run]=await db.query<{id:string}>('insert into workspace_coding_runs(owner_user_id,mapping_id,mode,source) values($1,$2,$3,$4) returning id',[userId,mappingId,mode,source]);
 const payload={userId,mappingId,runId:run.id,mode,source};
 const approval=await requestApproval(db,{ownerUserId:userId,mappingId,actionClass:'change_access',action:'workspace_code',summary:`${mode==='check'?'Check JavaScript syntax':'Run JavaScript'} in an isolated sandbox (30 seconds, no network, no host files). Review source in Local Workspace.`,payload,ttlSeconds:600});
 await db.query('update workspace_coding_runs set approval_id=$2 where id=$1',[run.id,approval.id]);return {id:run.id,approvalId:approval.id,status:'pending'};
}
interface Run {id:string;owner_user_id:string;mapping_id:string;approval_id:string;mode:string;source:string;status:string;result:Record<string,unknown>}
export async function getCodingRun(db:Db,userId:string,id:string){const [run]=await db.query<Run>('select * from workspace_coding_runs where id=$1 and owner_user_id=$2',[id,userId]);if(!run)throw new PathEscape('Coding run unavailable');return run;}
export async function startCodingRun(db:Db,userId:string,id:string){
 const run=await getCodingRun(db,userId,id);await grant(db,userId,run.mapping_id);
 const payload={userId,mappingId:run.mapping_id,runId:run.id,mode:run.mode,source:run.source};
 const rows=await db.query(`update approvals set status='expired' where id=$1 and owner_user_id=$2 and payload_hash=$3 and status='approved' and expires_at>now() returning id`,[run.approval_id,userId,approvalHash(payload)]);
 if(!rows.length)throw new PathEscape('Approve this exact source before execution');
 const claimed=await db.query(`update workspace_coding_runs set status='running' where id=$1 and status='pending' returning id`,[id]);if(!claimed.length)throw new PathEscape('Run already started or cancelled');
 await appendEvent(db,{actor:'user',actorUserId:userId,kind:'workspace.coding_started',subjectType:'folder_mapping',subjectId:run.mapping_id,payload:{runId:id,mode:run.mode,approvalId:run.approval_id}});
 try{return await codingHelper('/run',{id,mode:run.mode,source:run.source});}catch(e){await db.query(`update workspace_coding_runs set status='failed',finished_at=now() where id=$1`,[id]);throw e;}
}
export async function codingRunStatus(db:Db,userId:string,id:string,cancel=false){
 const run=await getCodingRun(db,userId,id);
 if(run.status==='pending'&&cancel){await db.query(`update workspace_coding_runs set status='cancelled',source='',finished_at=now() where id=$1 and status='pending'`,[id]);await db.query(`update approvals set status='denied' where id=$1 and status='pending'`,[run.approval_id]);return {status:'cancelled'};}
 if(run.status!=='running')return {status:run.status,...run.result};
 const result=await codingHelper(cancel?'/cancel':'/status',{id});
 if(['completed','failed','cancelled'].includes(String(result.status))){await db.query(`update workspace_coding_runs set status=$2,result=$3,source='',finished_at=now() where id=$1 and status='running'`,[id,result.status,json(result)]);await appendEvent(db,{actor:'user',actorUserId:userId,kind:'workspace.coding_finished',subjectType:'folder_mapping',subjectId:run.mapping_id,payload:{runId:id,status:result.status}});}
 return result;
}
