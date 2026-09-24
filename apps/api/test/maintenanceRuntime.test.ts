import express from 'express';
import {describe,it,expect} from 'vitest';
import {hashPassword} from '@josi-ce/auth';
import {maintenanceRoutes} from '../src/http/maintenanceRoutes.js';
import type {Db} from '@josi-ce/core';
import type {AddressInfo} from 'node:net';

it('reauthenticates before launching, rejects empty/wrong passwords and sanitizes helper failures',async()=>{
 const password_hash=await hashPassword('test-only-password');let calls=0,fail=false;
 const db={query:async()=>[{password_hash}]} as unknown as Db;
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:'test',role:'super_admin'} as any;next();});
 app.use(maintenanceRoutes({db,launch:async()=>{calls++;if(fail)throw new Error('private credential');return{url:'https://192.168.1.20:8080',code:'test-once',expiresInSeconds:900};}}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const send=(password:string)=>fetch(base+'/network/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password,host:'example.test'})});
 try{expect((await send('')).status).toBe(400);expect((await send('wrong')).status).toBe(401);expect(calls).toBe(0);expect((await send('test-only-password')).status).toBe(201);expect(calls).toBe(1);fail=true;const response=await send('test-only-password');expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('private credential');}
 finally{await new Promise<void>(r=>server.close(()=>r()));}
});
