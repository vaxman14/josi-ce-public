import {connectFromEnv} from '@josi-ce/core';
import {publicAddressFromEnvironment,reconcilePublicAddress,snapshotPublicAddress,restorePublicAddress} from '../../apps/api/dist/setup/publicAddress.js';
import assert from 'node:assert/strict';
const {db,close}=await connectFromEnv();
try {
 await db.query(`insert into workspace(id,name) values(true,'Verification') on conflict do nothing`);
 const before=await snapshotPublicAddress(db);
 for(const [origin,mode] of [['https://one.example.test','domain'],['https://two.example.test:8443','domain'],['https://proxy.example.test','proxy'],['http://192.168.1.20:8081','lan']]){
  await reconcilePublicAddress(db,publicAddressFromEnvironment(origin,mode));
  const snapshot=await snapshotPublicAddress(db);assert.equal(snapshot.workspace.origin,origin);assert.equal(snapshot.deployment.domain,new URL(origin).hostname);assert.equal(snapshot.deployment.tls_mode,mode==='proxy'?'external_proxy':'bundled_caddy');
  await restorePublicAddress(db,before);assert.deepEqual(await snapshotPublicAddress(db),before);
 }
 console.log('PASS PostgreSQL canonical address transitions and exact metadata rollback for domain, port, proxy and LAN');
}finally{await close();}
