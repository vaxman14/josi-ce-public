import { Router, type Request, type Response } from 'express';
import { verifyPassword } from '@josi-ce/auth';
import {
  VaultError, VaultLockedError, appendEvent, asSecret, checkVaultItem, consumeAuthorityGrant,
  deleteVaultItem, grantVaultUiUnlock, initializeVault, listVaultItems, loadMasterKey,
  putVaultItem, recoverVault, rotateVaultBox, setVaultLock, vaultStatus, vaultUiUnlocked, type Db, type LoadOptions, type VaultKind,
} from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

interface Ctx { db:Db; masterKey?:LoadOptions|false }
class RouteError extends Error { constructor(readonly status:number,message:string){super(message);} }
const handle=(fn:(req:Request,res:Response)=>Promise<unknown>)=>asyncRoute(async(req,res)=>{try{return await fn(req,res);}catch(e){if(e instanceof RouteError)return res.status(e.status).json({error:e.message});if(e instanceof VaultLockedError)return res.status(423).json({error:e.message});if(e instanceof VaultError)return res.status(409).json({error:e.message});throw e;}});
const clean=(v:unknown,max:number)=>typeof v==='string'?v.trim().slice(0,max):'';
function master(ctx:Ctx){if(ctx.masterKey===false)throw new RouteError(503,'the installation key is unavailable');try{return loadMasterKey(ctx.masterKey??{});}catch{throw new RouteError(503,'the installation key is unavailable');}}
async function passwordMatches(db:Db,userId:string,plain:string){const [u]=await db.query<{password_hash:string|null}>(`select password_hash from users where id=$1`,[userId]);return verifyPassword(u?.password_hash??null,plain);}
async function targetFor(req:Request,db:Db):Promise<{id:string;authority:'owner'|'guardian'}>{const target=clean(req.query.owner??req.body?.ownerUserId,80)||req.user!.id;if(target===req.user!.id)return{id:target,authority:'owner'};const [link]=await db.query(`select 1 from parental_links where parent_user_id=$1 and child_user_id=$2 and ended_at is null`,[req.user!.id,target]);if(!link)throw new RouteError(404,'Vault box not found');return{id:target,authority:'guardian'};}
async function requireUnlock(req:Request,db:Db,target:{id:string;authority:string}){if(!(await vaultUiUnlocked(db,{userId:req.user!.id,targetUserId:target.id,sessionId:req.user!.session_id})))throw new RouteError(401,'Unlock this Vault box again to continue.');}

export function vaultRoutes(ctx:Ctx):Router{
  const r=Router();r.use(requireAuth);
  r.get('/',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);const unlocked=await vaultUiUnlocked(ctx.db,{userId:req.user!.id,targetUserId:target.id,sessionId:req.user!.session_id});return res.json({status:await vaultStatus(ctx.db),box:{ownerUserId:target.id,authority:target.authority,unlocked,items:unlocked?await listVaultItems(ctx.db,target.id,master(ctx)):[]}});}));
  r.post('/unlock',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);if(target.authority==='owner'){if(!(await passwordMatches(ctx.db,req.user!.id,typeof req.body?.password==='string'?req.body.password:'')))throw new RouteError(401,'That password did not match.');}else{if(!(await consumeAuthorityGrant(ctx.db,{userId:req.user!.id,sessionKey:req.user!.session_id,purpose:'vault_guardian_access'})))throw new RouteError(401,'Confirm your password and authenticator code in Family first.');await appendEvent(ctx.db,{actorUserId:req.user!.id,actor:'guardian',kind:'vault.guardian_accessed',subjectType:'user',subjectId:target.id,payload:{targetUserId:target.id}});}await grantVaultUiUnlock(ctx.db,{userId:req.user!.id,targetUserId:target.id,sessionId:req.user!.session_id,authority:target.authority});return res.json({ok:true,expiresInSeconds:300});}));
  r.post('/items',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);await requireUnlock(req,ctx.db,target);const kind=clean(req.body?.kind,40) as VaultKind;const allowed:VaultKind[]=['api_key','oauth_token','password','secure_note','recovery_code','certificate','private_key','other'];if(!allowed.includes(kind))throw new RouteError(400,'choose a credential type');const item=await putVaultItem(ctx.db,master(ctx),{ownerUserId:target.id,kind,service:clean(req.body?.service,80),slot:clean(req.body?.slot,120),label:clean(req.body?.label,160),value:asSecret(req.body?.value),actorUserId:req.user!.id});return res.status(201).json({item});}));
  r.put('/items/:id',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);await requireUnlock(req,ctx.db,target);const [old]=await ctx.db.query<{kind:VaultKind;service:string;slot:string;label:string}>(`select kind,service,slot,label from vault_items where id=$1 and owner_user_id=$2`,[param(req,'id'),target.id]);if(!old)throw new RouteError(404,'credential not found');const item=await putVaultItem(ctx.db,master(ctx),{ownerUserId:target.id,kind:old.kind,service:old.service,slot:old.slot,label:clean(req.body?.label,160)||old.label,value:asSecret(req.body?.value),actorUserId:req.user!.id});return res.json({item});}));
  r.post('/items/:id/test',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);await requireUnlock(req,ctx.db,target);if(!(await checkVaultItem(ctx.db,master(ctx),{ownerUserId:target.id,itemId:param(req,'id')})))throw new RouteError(404,'credential not found');return res.json({ok:true,note:'Encrypted value integrity verified. Provider acceptance was not tested.'});}));
  r.delete('/items/:id',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);await requireUnlock(req,ctx.db,target);if(!(await deleteVaultItem(ctx.db,{ownerUserId:target.id,itemId:param(req,'id'),actorUserId:req.user!.id})))throw new RouteError(404,'credential not found');return res.status(204).end();}));
  r.post('/box/rotate',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);await requireUnlock(req,ctx.db,target);await rotateVaultBox(ctx.db,master(ctx),{ownerUserId:target.id,actorUserId:req.user!.id});return res.json({ok:true});}));
  r.put('/box/lock',handle(async(req,res)=>{const target=await targetFor(req,ctx.db);if(target.authority!=='owner')throw new RouteError(403,'only the box owner can lock it');await setVaultLock(ctx.db,{ownerUserId:target.id,locked:req.body?.locked!==false,actorUserId:req.user!.id});return res.json({ok:true});}));
  return r;
}

export function adminVaultRoutes(ctx:Ctx):Router{
  const r=Router();r.use(requireSuperAdmin);r.get('/',handle(async(_req,res)=>res.json({status:await vaultStatus(ctx.db)})));
  r.post('/initialize',handle(async(req,res)=>{if(!(await passwordMatches(ctx.db,req.user!.id,typeof req.body?.password==='string'?req.body.password:'')))throw new RouteError(401,'That password did not match.');const initialized=await initializeVault(ctx.db,master(ctx),req.user!.id);return res.status(201).json({recoveryKey:initialized.recoveryKey.reveal(),fingerprint:initialized.fingerprint,note:'Save this recovery key offline now. It will never be shown again.'});}));
  r.put('/lock',handle(async(req,res)=>{if(!(await passwordMatches(ctx.db,req.user!.id,typeof req.body?.password==='string'?req.body.password:'')))throw new RouteError(401,'That password did not match.');await setVaultLock(ctx.db,{master:true,locked:req.body?.locked!==false,actorUserId:req.user!.id});return res.json({ok:true,status:await vaultStatus(ctx.db)});}));
  r.post('/recover',handle(async(req,res)=>{if(!(await passwordMatches(ctx.db,req.user!.id,typeof req.body?.password==='string'?req.body.password:'')))throw new RouteError(401,'That password did not match.');await recoverVault(ctx.db,master(ctx),clean(req.body?.recoveryKey,200),req.user!.id);return res.json({ok:true,status:await vaultStatus(ctx.db)});}));
  return r;
}
