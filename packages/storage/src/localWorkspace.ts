// Linux descriptor-relative access: no check-then-open of a user-controlled path.
import { constants } from 'node:fs';
import { open, readdir, mkdir, rename, link, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, approvalHash, requestApproval, type Db } from '@josi-ce/core';
import { safeRelativePath, PathEscape } from './paths.js';
import { looksLikeCredentialFile } from './extract.js';
import { ROOT_BASE } from './mappings.js';

export function workspacePath(value: string): string {
  const clean = safeRelativePath(value);
  if (clean.length > 1000 || clean.split('/').some(p => p.startsWith('.') || p.length > 255 || /[\x00-\x1f\x7f]/.test(p) || looksLikeCredentialFile(p))) throw new PathEscape('Protected or invalid workspace filename');
  return clean;
}
/** Every ancestor is opened with O_NOFOLLOW and pinned until the operation ends. */
export async function withWorkspaceDirectory<T>(root: string, relative: string, fn: (fdPath: string) => Promise<T>): Promise<T> {
  const handles: FileHandle[] = [];
  try {
    let current = '/';
    for (const part of [...safeRelativePath(root.replace(/^\//, '')).split('/'), ...workspacePath(relative).split('/')].filter(Boolean)) {
      const h = await open(`${current}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(h); current = `/proc/self/fd/${h.fd}`;
    }
    return await fn(current);
  } finally { await Promise.all(handles.map(h => h.close())); }
}
interface Grant { id: string; relative_path: string; container_path: string; recursive: boolean; writable: boolean; may_create: boolean; may_edit: boolean; may_move: boolean; may_delete: boolean }
export async function workspaceGrant(db: Db, userId: string, id: string): Promise<Grant> {
  const [g] = await db.query<Grant>(`select m.id,m.relative_path,m.recursive,m.may_create,m.may_edit,m.may_move,m.may_delete,r.container_path,r.writable
    from folder_mappings m join storage_roots r on r.id=m.root_id join storage_capabilities c on c.user_id=m.owner_user_id
    where m.id=$1 and m.owner_user_id=$2 and m.provider='local' and m.status='active' and r.enabled=true and c.may_map_local=true`, [id,userId]);
  const configuredWorkspace = process.env.JOSI_WORKSPACE_ENABLED === '1'
    && g?.container_path === '/workspace';
  if (!g || !(g.container_path.startsWith(`${ROOT_BASE}/`) || configuredWorkspace)) {
    throw new PathEscape('Workspace unavailable or permission revoked');
  }
  return g;
}
function inGrant(g: Grant, path: string) { const p = workspacePath(path); if (!g.recursive && p.includes('/')) throw new PathEscape('Subfolders are outside this grant'); return p; }
function rootPath(g: Grant) { return `${g.container_path}/${workspacePath(g.relative_path)}`; }
export async function workspaceList(db: Db, userId: string, id: string, path = '') {
  const g = await workspaceGrant(db,userId,id); const p = inGrant(g,path);
  if (p && !g.recursive) throw new PathEscape('Subfolders are outside this grant');
  return withWorkspaceDirectory(rootPath(g),p,async dir => {
    const entries = await readdir(dir,{withFileTypes:true});
    if (entries.length > 2000) throw new PathEscape('Folder exceeds 2000 entries; choose a smaller mapped folder');
    const visible: Array<{name:string;kind:string;size:number;modified:string}> = [];
    for(const e of entries){
      try {workspacePath(e.name);if(e.isSymbolicLink() || !(e.isFile() || g.recursive&&e.isDirectory()))continue;
        const h=await open(`${dir}/${e.name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(e.isDirectory()?constants.O_DIRECTORY:0));
        try{const st=await h.stat();if(st.isFile()&&st.nlink!==1)continue;visible.push({name:e.name,kind:e.isDirectory()?'folder':'file',size:st.size,modified:st.mtime.toISOString()});}finally{await h.close();}
      }catch{/* Concurrent removal or protected entry: never widen the grant. */}
    }
    const receipt=randomUUID();await appendEvent(db,{actor:'user',actorUserId:userId,kind:'workspace.listed',subjectType:'folder_mapping',subjectId:id,payload:{receipt,count:visible.length}});
    return {entries:visible,receipt,permissions:{create:g.writable&&g.may_create,edit:g.writable&&g.may_edit,move:g.writable&&g.may_move,delete:g.writable&&g.may_delete}};
  });
}
export async function workspaceRead(db: Db, userId: string, id: string, path: string) {
  const g = await workspaceGrant(db,userId,id); const p = inGrant(g,path); if (!p) throw new PathEscape('Choose a file');
  return withWorkspaceDirectory(rootPath(g),dirname(p)==='.'?'':dirname(p),async dir => {
    const h = await open(`${dir}/${basename(p)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await h.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4*1024*1024) throw new PathEscape('Only regular files up to 4 MiB can be downloaded');
      const bytes = Buffer.alloc(4*1024*1024+1); const {bytesRead} = await h.read(bytes,0,bytes.length,0);
      if (bytesRead > 4*1024*1024 || looksLikeCredentialFile(p,bytes.subarray(0,bytesRead).toString('utf8'))) throw new PathEscape('Protected file or file too large');
      const receipt=randomUUID();await appendEvent(db,{actor:'user',actorUserId:userId,kind:'workspace.file_read',subjectType:'folder_mapping',subjectId:id,payload:{receipt,bytes:bytesRead}});
      return {receipt,data:bytes.subarray(0,bytesRead),size:bytesRead,modified:stat.mtime.toISOString(),name:basename(p)};
    } finally { await h.close(); }
  });
}
export interface WorkspaceChange { operation:'create'|'edit'|'mkdir'|'move'|'delete'; path:string; destination?:string; content?:string }
async function performWorkspaceChange(db: Db,userId: string,id: string,input: WorkspaceChange,approvalId?:string) {
  const g = await workspaceGrant(db,userId,id); const path = inGrant(g,input.path); const destination = input.destination ? inGrant(g,input.destination):undefined;
  const operation=input.operation;
  if (!path || !['create','edit','mkdir','move','delete'].includes(operation)) throw new PathEscape('Choose a supported file operation');
  if (!g.writable || !(operation==='create'||operation==='mkdir'?g.may_create:operation==='edit'?g.may_edit:operation==='move'?g.may_move:g.may_delete)) throw new PathEscape('This operation is not authorized for this folder');
  if (operation==='move' && !destination) throw new PathEscape('Choose a destination');
  const content=operation==='create'||operation==='edit' ? input.content ?? '' : undefined;
  if (content!==undefined && (Buffer.byteLength(content)>256*1024 || content.includes('\0') || looksLikeCredentialFile(path,content))) throw new PathEscape('Only non-secret text up to 256 KiB can be created');
  const existing = operation==='move'||operation==='delete'||operation==='edit' ? await workspaceRead(db,userId,id,path) : null;
  const precondition=existing ? createHash('sha256').update(existing.data).digest('hex') : null;
  const payload={userId,mappingId:id,operation,path,destination,content,precondition};
  if (!approvalId) return {approval:await requestApproval(db,{ownerUserId:userId,mappingId:id,actionClass:'change_access',action:`workspace_${operation}`,summary:`${operation}: ${path}${destination ? ` → ${destination}`:''}`,payload,ttlSeconds:600})};
  // Atomic one-shot claim. Replay, wrong-owner, altered payload and expired grants all fail.
  const claimed=await db.query(`update approvals set status='expired' where id=$1 and owner_user_id=$2 and subject_id=$3 and action=$4 and payload_hash=$5 and status='approved' and expires_at>now() returning id`,[approvalId,userId,id,`workspace_${operation}`,approvalHash(payload)]);
  if (!claimed.length) throw new PathEscape('An unexpired approval for this exact operation is required');
  if(operation==='create'||operation==='edit'||operation==='mkdir') await enforceWorkspaceQuota(db,userId,operation==='mkdir'?0:Buffer.byteLength(content!));
  const receipt=randomUUID();
  await appendEvent(db,{actorUserId:userId,actor:'user',kind:'workspace.write_started',subjectType:'folder_mapping',subjectId:id,payload:{receipt,operation,approvalId}});
  try {
    await withWorkspaceDirectory(rootPath(g),dirname(path)==='.'?'':dirname(path),async dir=> {
      const target=`${dir}/${basename(path)}`;
      if (operation==='mkdir') await mkdir(target,{mode:0o700});
      if (operation==='edit') {
        await mkdir(`${dir}/.josi-recovery`,{mode:0o700}).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='EEXIST')throw e;});
        const recovery=await open(`${dir}/.josi-recovery`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        const backup=`/proc/self/fd/${recovery.fd}/${receipt}`;
        try {
          await rename(target,backup);
          const old=await open(backup,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
          try {const st=await old.stat();if(!st.isFile()||st.nlink!==1||st.size>4*1024*1024||createHash('sha256').update(await old.readFile()).digest('hex')!==precondition)throw new PathEscape('File changed after approval; recovery copy preserved');}finally{await old.close();}
          const h=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
          try{await h.writeFile(content!);await h.sync();}catch(error){await unlink(target).catch(()=>undefined);throw error;}finally{await h.close();}
        } catch(error) {
          // Restore only if the original name is still free; never overwrite a concurrent writer.
          await link(backup,target).then(()=>unlink(backup)).catch(()=>undefined);
          throw error;
        } finally {await recovery.close();}
      }
      if (operation==='create') {
        // Hard ceiling independent of indexing; serialize writes per mapping in the route.
        const entries=await readdir(dir); if(entries.length>=1000) throw new PathEscape('Workspace folder file limit reached');
        const h=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try { await h.writeFile(content!); await h.sync(); } catch(err) { await unlink(target).catch(()=>undefined); throw err; } finally {await h.close();}
      }
      if (operation==='move') {
        const h=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
          const stat=await h.stat(); if(!stat.isFile() || stat.nlink!==1) throw new PathEscape('Only ordinary files can be moved');
          await withWorkspaceDirectory(rootPath(g),dirname(destination!)==='.'?'':dirname(destination!),async dest=> {
            // link refuses an existing destination; a crash before unlink preserves both copies.
            await link(target,`${dest}/${basename(destination!)}`);
            await unlink(target);
          });
        } finally {await h.close();}
      }
      if (operation==='delete') {
        // Recovery copy before removal, on the same filesystem, outside the visible namespace.
        const h=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try { if (!(await h.stat()).isFile()) throw new PathEscape('Only regular files can be deleted'); } finally {await h.close();}
        await mkdir(`${dir}/.josi-recovery`,{mode:0o700}).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='EEXIST')throw e;});
        const recovery=await open(`${dir}/.josi-recovery`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        try { await rename(target,`/proc/self/fd/${recovery.fd}/${receipt}`); } finally {await recovery.close();}
      }
    });
    await appendEvent(db,{actorUserId:userId,actor:'user',kind:'workspace.write_completed',subjectType:'folder_mapping',subjectId:id,payload:{receipt,operation}});
    return {receipt,completed:true};
  } catch(error) { await appendEvent(db,{actorUserId:userId,actor:'user',kind:'workspace.write_failed',subjectType:'folder_mapping',subjectId:id,payload:{receipt,operation}}); throw error; }
}

/** DB-backed lease serializes quota reservations across API/worker processes. */
export async function workspaceChange(db:Db,userId:string,id:string,input:WorkspaceChange,approvalId?:string){
 if(!approvalId)return performWorkspaceChange(db,userId,id,input);
 const token=randomUUID();
 const lease=await db.query(`insert into workspace_write_leases(owner_user_id,token,expires_at) values($1,$2,now()+interval '5 minutes') on conflict(owner_user_id) do update set token=excluded.token,expires_at=excluded.expires_at where workspace_write_leases.expires_at<now() returning token`,[userId,token]);
 if(!lease.length)throw new PathEscape('Another workspace operation is running. Retry when it finishes.');
 try{return await performWorkspaceChange(db,userId,id,input,approvalId);}finally{await db.query('delete from workspace_write_leases where owner_user_id=$1 and token=$2',[userId,token]);}
}
async function enforceWorkspaceQuota(db:Db,userId:string,additionalBytes:number){
 const [policy]=await db.query<{max_total_bytes_per_user:string;max_files_per_user:number;max_bytes:string|null;max_files:number|null}>(`select p.max_total_bytes_per_user,p.max_files_per_user,c.max_bytes,c.max_files from storage_policy p join storage_capabilities c on c.user_id=$1 where p.id=true`,[userId]);
 if(!policy)throw new PathEscape('Storage policy is unavailable');
 const maxBytes=Math.min(Number(policy.max_total_bytes_per_user),Number(policy.max_bytes??policy.max_total_bytes_per_user));
 const maxFiles=Math.min(policy.max_files_per_user,policy.max_files??policy.max_files_per_user,10000);
 let bytes=additionalBytes,files=1,visited=0;
 const roots=await db.query<{container_path:string;relative_path:string;recursive:boolean}>(`select r.container_path,m.relative_path,m.recursive from folder_mappings m join storage_roots r on r.id=m.root_id where m.owner_user_id=$1 and m.provider='local' and m.status='active' and r.enabled=true`,[userId]);
 const inspect=async(dir:string,recursive:boolean):Promise<void>=>{
  if(++visited>1000)throw new PathEscape('Workspace quota scan exceeds 1000 folders; choose smaller mappings');
  const entries=await readdir(dir,{withFileTypes:true});
  if(entries.length>10000)throw new PathEscape('Workspace file quota exceeded');
  for(const e of entries){
   if(e.isSymbolicLink())continue;
   if(e.isDirectory()&&!recursive)continue;
   const h=await open(`${dir}/${e.name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(e.isDirectory()?constants.O_DIRECTORY:0));
   try{const st=await h.stat();if(st.isFile()){files++;bytes+=st.size;}else if(st.isDirectory())await inspect(`/proc/self/fd/${h.fd}`,true);
    if(files>maxFiles||bytes>maxBytes)throw new PathEscape('Workspace quota exceeded. Remove files or ask an administrator to increase your storage limit');
   }finally{await h.close();}
  }
 };
 for(const root of roots)await withWorkspaceDirectory(`${root.container_path}/${workspacePath(root.relative_path)}`,'',dir=>inspect(dir,root.recursive));
 if(files>maxFiles||bytes>maxBytes)throw new PathEscape('Workspace quota exceeded');
}
