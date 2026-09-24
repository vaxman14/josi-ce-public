import http from 'node:http';
import { Router } from 'express';
import { verifyPassword } from '@josi-ce/auth';
import type { Db } from '@josi-ce/core';
import { asyncRoute } from './async.js';
import { requireSuperAdmin } from './authz.js';

type Launch = { url:string; code:string; expiresInSeconds:number };
function supervisor(socketPath=process.env.JOSI_MAINTENANCE_HELPER_SOCKET){
  if(!socketPath)return null;
  return (host:string)=>new Promise<Launch>((resolve,reject)=>{
    const req=http.request({socketPath,path:'/launch',method:'POST',headers:{'content-type':'application/json'}},res=>{
      const chunks:Buffer[]=[];res.on('data',c=>chunks.push(Buffer.from(c)));res.on('end',()=>{try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if((res.statusCode??500)>=400)reject(new Error(body.error??'maintenance controller refused the request'));else resolve(body);}catch{reject(new Error('maintenance controller returned an invalid response'));}});
    });
    req.setTimeout(60_000,()=>req.destroy(new Error('maintenance controller timed out')));req.on('error',reject);req.end(JSON.stringify({host}));
  });
}

export function maintenanceRoutes(ctx:{db:Db;launch?:(host:string)=>Promise<Launch>}):Router{
  const r=Router();r.use(requireSuperAdmin);
  r.post('/network/launch',asyncRoute(async(req,res)=>{
    const password=typeof req.body?.password==='string'?req.body.password:'';
    const [user]=await ctx.db.query<{password_hash:string|null}>(`select password_hash from users where id=$1`,[req.user!.id]);
    if(!password)return res.status(400).json({error:'Enter your current administrator password.'});
    if(!user?.password_hash||!(await verifyPassword(user.password_hash,password)))return res.status(401).json({error:'The administrator password was incorrect. No maintenance controller was started.'});
    const launch=ctx.launch??supervisor();if(!launch)return res.status(503).json({error:'Maintenance controller is unavailable. Rerun the installer once to provision it.'});
    const host=String(req.body?.host??'').trim();if(!/^[A-Za-z0-9.-]{1,253}$/.test(host))return res.status(400).json({error:'Browser host is invalid.'});
    try{return res.status(201).json(await launch(host));}
    catch{return res.status(503).json({error:'The protected maintenance controller could not start or pass its readiness check. Check that port 8080 is available, then try again.'});}
  }));
  return r;
}
