import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import { json } from './db.js';
import { appendEvent } from './events.js';
import { MasterKey } from './masterKey.js';
import { Secret, openSealed, seal, unwrapSecrets } from './sealing.js';

export class VaultError extends Error {}
export class VaultLockedError extends VaultError {}
export const VAULT_UNLOCK_SECONDS = 5 * 60;

export type VaultKind = 'api_key'|'oauth_token'|'password'|'secure_note'|'recovery_code'|'certificate'|'private_key'|'other';
export interface VaultItemView { id:string; ownerUserId:string; kind:VaultKind; service:string; slot:string; label:string; lastFour:string|null; status:'active'|'revoked'; createdAt:string; updatedAt:string; rotatedAt:string|null; metadata:Record<string,unknown> }

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
/** Credentials imported from subsystems are stored as JSON payloads.  A raw
 * `slice(-4)` therefore previews JSON punctuation (usually `"}`) rather than
 * the credential. Prefer explicitly sensitive fields, then the final scalar
 * string in the payload. The value never leaves this module. */
export function vaultSecretSuffix(raw:string):string|null{
  const suffix=(value:unknown)=>typeof value==='string'&&value.length>=4?value.slice(-4):null;
  try{
    const parsed=JSON.parse(raw) as unknown;
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){
      const record=parsed as Record<string,unknown>;
      const preferred=['password','secretAccessKey','apiKey','accessToken','refreshToken','clientSecret','token','privateKey','key'];
      for(const name of preferred){const found=suffix(record[name]);if(found)return found;}
      for(const value of Object.values(record).reverse()){const found=suffix(value);if(found)return found;}
    }
  }catch{/* ordinary non-JSON secret */}
  return suffix(raw);
}
function keyFromBase64url(value:string):MasterKey { const bytes=Buffer.from(value,'base64url'); return new MasterKey(bytes); }

export async function initializeVault(db:Db, masterKey:MasterKey, actorUserId:string):Promise<{recoveryKey:Secret;fingerprint:string}> {
  const [state]=await db.query<{initialized_at:string|null}>(`select initialized_at from vault_state where id=true`);
  if(state?.initialized_at) throw new VaultError('the Master Vault is already initialized');
  const vaultRaw=randomBytes(32);const vaultKey=new MasterKey(vaultRaw);
  const recoveryRaw=randomBytes(32); const recoveryText=recoveryRaw.toString('base64url');
  const recoveryKey=new MasterKey(recoveryRaw); const fingerprint=digest(recoveryRaw).slice(0,12).toUpperCase();
  const rows=await db.query<{id:boolean}>(
    `update vault_state set initialized_at=now(),initialized_by=$1,locked=false,master_key_enc=$2,
      recovery_master_enc=$3,recovery_key_hash=$4,recovery_key_fingerprint=$5,updated_at=now()
     where id=true and initialized_at is null returning id`,
    [actorUserId,seal(masterKey,{key:vaultRaw.toString('base64')}),seal(recoveryKey,{key:vaultRaw.toString('base64')}),digest(recoveryRaw),fingerprint]);
  if(!rows.length) throw new VaultError('the Master Vault was initialized by another request');
  await appendEvent(db,{actorUserId,actor:'super_admin',kind:'vault.initialized',subjectType:'vault',payload:{fingerprint}});
  return {recoveryKey:new Secret(recoveryText),fingerprint};
}

export async function verifyRecoveryKey(db:Db,recoveryText:string):Promise<MasterKey> {
  const [state]=await db.query<{recovery_key_hash:string|null;recovery_master_enc:string|null}>(`select recovery_key_hash,recovery_master_enc from vault_state where id=true`);
  if(!state?.recovery_key_hash||!state.recovery_master_enc) throw new VaultError('Vault recovery is not initialized');
  let supplied:Buffer; try{supplied=Buffer.from(recoveryText,'base64url');}catch{throw new VaultError('recovery key did not match');}
  const a=Buffer.from(digest(supplied)); const b=Buffer.from(state.recovery_key_hash);
  if(a.length!==b.length||!timingSafeEqual(a,b)) throw new VaultError('recovery key did not match');
  const opened=openSealed<{key:string}>(new MasterKey(supplied),state.recovery_master_enc);
  return new MasterKey(Buffer.from(opened.key,'base64'));
}

export async function recoverVault(db:Db,installKey:MasterKey,recoveryText:string,actorUserId:string):Promise<void>{const vaultKey=await verifyRecoveryKey(db,recoveryText);await db.query(`update vault_state set master_key_enc=$1,locked=false,key_version=key_version+1,updated_at=now() where id=true`,[seal(installKey,{key:vaultKey.reveal().toString('base64')})]);await appendEvent(db,{actorUserId,actor:'super_admin',kind:'vault.recovered',subjectType:'vault'});}

export async function vaultStatus(db:Db){
  const [state]=await db.query<{initialized_at:string|null;locked:boolean;key_version:number;recovery_key_fingerprint:string|null;updated_at:string}>(`select initialized_at,locked,key_version,recovery_key_fingerprint,updated_at from vault_state where id=true`);
  const [counts]=await db.query<{boxes:number;items:number;locked_boxes:number}>(`select (select count(*)::int from vault_boxes) boxes,(select count(*)::int from vault_items) items,(select count(*)::int from vault_boxes where locked) locked_boxes`);
  const [failures]=await db.query<{recent_failures:number;last_failure_at:string|null}>(`select count(*) filter(where created_at>now()-interval '24 hours')::int recent_failures,max(created_at) last_failure_at from vault_job_failures`);
  return {initialized:!!state?.initialized_at,locked:state?.locked??true,keyVersion:state?.key_version??1,recoveryFingerprint:state?.recovery_key_fingerprint??null,updatedAt:state?.updated_at??null,boxes:counts?.boxes??0,items:counts?.items??0,lockedBoxes:counts?.locked_boxes??0,recentFailures:failures?.recent_failures??0,lastFailureAt:failures?.last_failure_at??null};
}

async function blocked(db:Db,reason:'master_locked'|'key_unavailable'){await db.query(`insert into vault_job_failures(job_kind,reason) values('credential_resolution',$1)`,[reason]);await appendEvent(db,{actor:'system',kind:'vault.credential_job_blocked',subjectType:'vault',payload:{reason}});}
async function assertMasterOpen(db:Db):Promise<void>{const [s]=await db.query<{initialized_at:string|null;locked:boolean}>(`select initialized_at,locked from vault_state where id=true`);if(!s?.initialized_at){await blocked(db,'key_unavailable');throw new VaultLockedError('the Master Vault is not initialized');}if(s.locked){await blocked(db,'master_locked');throw new VaultLockedError('the Master Vault is locked');}}

async function vaultMasterKey(db:Db,installKey:MasterKey):Promise<MasterKey>{await assertMasterOpen(db);const [state]=await db.query<{master_key_enc:string|null}>(`select master_key_enc from vault_state where id=true`);if(!state?.master_key_enc)throw new VaultLockedError('the Master Vault key is unavailable');const opened=openSealed<{key:string}>(installKey,state.master_key_enc);return keyFromBase64url(Buffer.from(opened.key,'base64').toString('base64url'));}

async function boxKey(db:Db,masterKey:MasterKey,ownerUserId:string,create=false):Promise<MasterKey>{
  const vaultKey=await vaultMasterKey(db,masterKey); let [box]=await db.query<{wrapped_key_enc:string;locked:boolean}>(`select wrapped_key_enc,locked from vault_boxes where owner_user_id=$1`,[ownerUserId]);
  if(!box&&create){const raw=randomBytes(32);const rows=await db.query<{wrapped_key_enc:string;locked:boolean}>(`insert into vault_boxes(owner_user_id,wrapped_key_enc) values($1,$2) on conflict(owner_user_id) do nothing returning wrapped_key_enc,locked`,[ownerUserId,seal(vaultKey,{key:raw.toString('base64')})]);box=rows[0]??(await db.query<{wrapped_key_enc:string;locked:boolean}>(`select wrapped_key_enc,locked from vault_boxes where owner_user_id=$1`,[ownerUserId]))[0];}
  if(!box)throw new VaultError('this user does not have a Vault box');if(box.locked)throw new VaultLockedError('this Vault box is locked');
  return new MasterKey(Buffer.from(openSealed<{key:string}>(vaultKey,box.wrapped_key_enc).key,'base64'));
}

export async function putVaultItem(db:Db,masterKey:MasterKey,args:{ownerUserId:string;kind:VaultKind;service:string;slot:string;label:string;value:Secret;metadata?:Record<string,unknown>;actorUserId?:string}):Promise<VaultItemView>{
  if(args.value.isEmpty)throw new VaultError('a credential value is required');
  if(!args.service.trim()||!args.slot.trim()||!args.label.trim())throw new VaultError('service, slot, and label are required');
  const key=await boxKey(db,masterKey,args.ownerUserId,true);
  const [existing]=await db.query<{id:string}>(`select id from vault_items where owner_user_id=$1 and service=$2 and slot=$3`,[args.ownerUserId,args.service,args.slot]);
  const id=existing?.id??randomBytes(16).toString('hex').replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');const raw=args.value.reveal();const lastFour=vaultSecretSuffix(raw);
  const [row]=await db.query<any>(`insert into vault_items(id,owner_user_id,kind,service,slot,label,value_enc,last_four,metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(owner_user_id,service,slot) do update set kind=excluded.kind,label=excluded.label,value_enc=excluded.value_enc,last_four=excluded.last_four,metadata=excluded.metadata,status='active',updated_at=now(),rotated_at=now() returning *`,[id,args.ownerUserId,args.kind,args.service,args.slot,args.label,seal(key,{value:raw,ownerUserId:args.ownerUserId,service:args.service,slot:args.slot}),lastFour,json(args.metadata)]);
  await appendEvent(db,{actorUserId:args.actorUserId??args.ownerUserId,actor:args.actorUserId&&args.actorUserId!==args.ownerUserId?'guardian':'user',kind:'vault.item_stored',subjectType:'vault_item',subjectId:row.id,payload:{ownerUserId:args.ownerUserId,kind:args.kind,service:args.service}});return view(row);
}

export async function getVaultSecret(db:Db,masterKey:MasterKey,args:{ownerUserId:string;service:string;slot:string}):Promise<Secret>{const key=await boxKey(db,masterKey,args.ownerUserId);const [row]=await db.query<{value_enc:string}>(`select value_enc from vault_items where owner_user_id=$1 and service=$2 and slot=$3 and status='active'`,[args.ownerUserId,args.service,args.slot]);if(!row)throw new VaultError('credential not found');const opened=openSealed<{value:string;ownerUserId:string;service:string;slot:string}>(key,row.value_enc);if(opened.ownerUserId!==args.ownerUserId||opened.service!==args.service||opened.slot!==args.slot)throw new VaultError('credential context did not match');return new Secret(opened.value);}
/** Store new subsystem credentials in the Vault while leaving only an opaque
 * reference in the legacy column. Before an upgraded installation has been
 * explicitly initialized, the old ciphertext remains readable; it is never
 * silently imported. */
export async function storeCredentialPayload(db:Db,installKey:MasterKey,args:{ownerUserId:string;kind:VaultKind;service:string;slot:string;label:string;payload:Record<string,unknown>;actorUserId?:string}):Promise<string>{const status=await vaultStatus(db);if(!status.initialized)return seal(installKey,args.payload);const item=await putVaultItem(db,installKey,{ownerUserId:args.ownerUserId,kind:args.kind,service:args.service,slot:args.slot,label:args.label,value:new Secret(JSON.stringify(unwrapSecrets(args.payload))),actorUserId:args.actorUserId});return seal(installKey,{vaultItemId:item.id});}
export async function openCredentialPayload<T extends object>(db:Db,installKey:MasterKey,args:{ownerUserId:string;service:string;slot:string;stored:string}):Promise<T>{const pointer=openSealed<T&{vaultItemId?:string}>(installKey,args.stored);if(!pointer.vaultItemId)return pointer;const raw=await getVaultSecret(db,installKey,{ownerUserId:args.ownerUserId,service:args.service,slot:args.slot});let parsed:unknown;try{parsed=JSON.parse(raw.reveal());}catch{throw new VaultError('stored credential payload is invalid');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new VaultError('stored credential payload is invalid');return parsed as T;}
export async function listVaultItems(db:Db,ownerUserId:string,masterKey?:MasterKey):Promise<VaultItemView[]>{
  const rows=await db.query<any>(`select id,owner_user_id,kind,service,slot,label,value_enc,last_four,metadata,status,created_at,updated_at,rotated_at from vault_items where owner_user_id=$1 order by service,label`,[ownerUserId]);
  if(masterKey&&rows.length){
    const key=await boxKey(db,masterKey,ownerUserId);
    for(const row of rows){
      const opened=openSealed<{value:string;ownerUserId:string;service:string;slot:string}>(key,row.value_enc);
      const corrected=vaultSecretSuffix(opened.value);
      if(corrected!==row.last_four){await db.query(`update vault_items set last_four=$2 where id=$1`,[row.id,corrected]);row.last_four=corrected;}
    }
  }
  return rows.map(view);
}
export async function deleteVaultItem(db:Db,args:{ownerUserId:string;itemId:string;actorUserId:string}):Promise<boolean>{const rows=await db.query<{id:string}>(`delete from vault_items where id=$1 and owner_user_id=$2 returning id`,[args.itemId,args.ownerUserId]);if(rows.length)await appendEvent(db,{actorUserId:args.actorUserId,actor:args.actorUserId===args.ownerUserId?'user':'guardian',kind:'vault.item_deleted',subjectType:'vault_item',subjectId:args.itemId,payload:{ownerUserId:args.ownerUserId}});return rows.length>0;}
export async function deleteVaultSlot(db:Db,args:{ownerUserId:string;service:string;slot:string;actorUserId:string}):Promise<boolean>{const rows=await db.query<{id:string}>(`delete from vault_items where owner_user_id=$1 and service=$2 and slot=$3 returning id`,[args.ownerUserId,args.service,args.slot]);if(rows[0])await appendEvent(db,{actorUserId:args.actorUserId,actor:args.actorUserId===args.ownerUserId?'user':'guardian',kind:'vault.item_deleted',subjectType:'vault_item',subjectId:rows[0].id,payload:{ownerUserId:args.ownerUserId}});return !!rows[0];}
export async function checkVaultItem(db:Db,masterKey:MasterKey,args:{ownerUserId:string;itemId:string}):Promise<boolean>{const key=await boxKey(db,masterKey,args.ownerUserId);const [row]=await db.query<{value_enc:string;service:string;slot:string}>(`select value_enc,service,slot from vault_items where id=$1 and owner_user_id=$2`,[args.itemId,args.ownerUserId]);if(!row)return false;const opened=openSealed<{ownerUserId:string;service:string;slot:string}>(key,row.value_enc);return opened.ownerUserId===args.ownerUserId&&opened.service===row.service&&opened.slot===row.slot;}
export async function rotateVaultBox(db:Db,masterKey:MasterKey,args:{ownerUserId:string;actorUserId:string}):Promise<void>{
  const vaultKey=await vaultMasterKey(db,masterKey);const current=await boxKey(db,masterKey,args.ownerUserId);
  // Re-wrap atomically with a fresh AEAD nonce. Individual secret rotation is
  // the item update path; rewriting every item and then its box key without a
  // database transaction would make a crash halfway through unrecoverable.
  await db.query(`update vault_boxes set wrapped_key_enc=$2,key_version=key_version+1,rotated_at=now() where owner_user_id=$1`,[args.ownerUserId,seal(vaultKey,{key:current.reveal().toString('base64')})]);
  await appendEvent(db,{actorUserId:args.actorUserId,actor:args.actorUserId===args.ownerUserId?'user':'guardian',kind:'vault.box_rotated',subjectType:'vault_box',subjectId:args.ownerUserId});
}
export async function setVaultLock(db:Db,args:{master?:boolean;ownerUserId?:string;locked:boolean;actorUserId:string}){if(args.master){await db.query(`update vault_state set locked=$1,updated_at=now() where id=true`,[args.locked]);if(args.locked)await db.query(`delete from vault_unlocks`);}else if(args.ownerUserId){await db.query(`update vault_boxes set locked=$2 where owner_user_id=$1`,[args.ownerUserId,args.locked]);if(args.locked)await db.query(`delete from vault_unlocks where target_user_id=$1`,[args.ownerUserId]);}await appendEvent(db,{actorUserId:args.actorUserId,actor:'user',kind:args.locked?'vault.locked':'vault.unlocked_for_engine',subjectType:args.master?'vault':'vault_box',subjectId:args.ownerUserId});}
export async function grantVaultUiUnlock(db:Db,args:{userId:string;targetUserId:string;sessionId:string;authority:'owner'|'guardian'}){await db.query(`insert into vault_unlocks(user_id,target_user_id,session_id,authority,expires_at) values($1,$2,$3,$4,now()+make_interval(secs=>$5)) on conflict(user_id,target_user_id,session_id) do update set authority=excluded.authority,expires_at=excluded.expires_at,created_at=now()`,[args.userId,args.targetUserId,args.sessionId,args.authority,VAULT_UNLOCK_SECONDS]);}
export async function vaultUiUnlocked(db:Db,args:{userId:string;targetUserId:string;sessionId:string}){const rows=await db.query(`select 1 from vault_unlocks where user_id=$1 and target_user_id=$2 and session_id=$3 and expires_at>now()`,[args.userId,args.targetUserId,args.sessionId]);return rows.length>0;}

function view(row:any):VaultItemView{return{id:row.id,ownerUserId:row.owner_user_id,kind:row.kind,service:row.service,slot:row.slot,label:row.label,lastFour:row.last_four,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,rotatedAt:row.rotated_at,metadata:row.metadata??{}};}
