import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspacePath, withWorkspaceDirectory, workspaceGrant } from '../src/localWorkspace.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'josi-workspace-'));roots.push(root);await mkdir(join(root,'docs'));await writeFile(join(root,'docs','hello.txt'),'hello');return root;}
describe('Local Workspace containment',()=>{
 it.each(['../etc/passwd','/etc/passwd','a/../../etc','a\\b','C:/data','.env','.ssh/id_rsa','a/.git/config','x\0.txt','a\n.txt'])('refuses protected or malformed path %j',p=>expect(()=>workspacePath(p)).toThrow());
 it('accepts Unicode names without changing identity',()=>expect(workspacePath('Résumé/你好.txt')).toBe('Résumé/你好.txt'));
 it('opens nested directories via pinned descriptors',async()=>{const root=await fixture();expect(await withWorkspaceDirectory(root,'docs',p=>readFile(`${p}/hello.txt`,'utf8'))).toBe('hello');});
 it('rejects symlink ancestors even when they point inside',async()=>{const root=await fixture();await symlink(join(root,'docs'),join(root,'alias'));await expect(withWorkspaceDirectory(root,'alias',async()=>true)).rejects.toThrow();});
 it('rejects symlinked configured roots',async()=>{const root=await fixture();await symlink(join(root,'docs'),join(root,'alias'));await expect(withWorkspaceDirectory(join(root,'alias'),'',async()=>true)).rejects.toThrow();});
 it('cannot follow an escaping directory link',async()=>{const root=await fixture();await symlink('/etc',join(root,'escape'));await expect(withWorkspaceDirectory(root,'escape',async()=>true)).rejects.toThrow();});
 it('keeps the opened directory pinned when its lexical name is replaced',async()=>{const root=await fixture();const {rename}=await import('node:fs/promises');await withWorkspaceDirectory(root,'docs',async p=>{await rename(join(root,'docs'),join(root,'old'));await symlink('/etc',join(root,'docs'));expect(await readFile(`${p}/hello.txt`,'utf8')).toBe('hello');});});
 it('refuses absent grants and binds owner in authoritative query',async()=>{let params:unknown[]=[];await expect(workspaceGrant({query:async(_sql,p)=>{params=p!;return[];}},'alice','mapping')).rejects.toThrow('unavailable');expect(params).toEqual(['mapping','alice']);});
});
