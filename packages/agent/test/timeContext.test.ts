import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { effectiveTimeContext, shiftCivilDate } from '../src/timeContext.js';

let db:TestDb;let userId:string;
beforeEach(async()=>{
  db=await testDb();
  userId=(await createUser(db,{email:'time@ce.test',username:'time-owner',role:'super_admin'})).id;
  await db.query(`insert into workspace(id,name,timezone) values(true,'Test','America/New_York') on conflict(id) do update set timezone=excluded.timezone`);
});

describe('effective assistant time context',()=>{
  it('uses the profile timezone before the workspace and reproduces Sep 17/18 in Los Angeles',async()=>{
    await db.query(`insert into persona_profiles(owner_user_id,kind,content,parsed,ignored) values($1,'user','timezone: America/Los_Angeles',$2,'[]')`,[userId,JSON.stringify({timezone:'America/Los_Angeles'})]);
    const context=await effectiveTimeContext(db,userId,new Date('2026-09-18T04:05:00.000Z'));
    expect(context).toMatchObject({timeZone:'America/Los_Angeles',today:'2026-09-17',tomorrow:'2026-09-18',yesterday:'2026-09-16'});
    expect(context.currentLocal).toMatch(/Thursday, September 17, 2026/);
    expect(context.currentLocal).toMatch(/9:05:00 PM/);
    expect(context.currentLocal).toMatch(/GMT-07:00/);
    expect(context.prompt).toContain('not by adding 24 hours');
  });

  it('falls back to workspace timezone when the profile has none or is invalid',async()=>{
    expect((await effectiveTimeContext(db,userId,new Date('2026-09-18T04:05:00Z'))).timeZone).toBe('America/New_York');
    await db.query(`insert into persona_profiles(owner_user_id,kind,content,parsed,ignored) values($1,'user','timezone: Not/AZone',$2,'[]')`,[userId,JSON.stringify({timezone:'Not/AZone'})]);
    expect((await effectiveTimeContext(db,userId,new Date('2026-09-18T04:05:00Z'))).timeZone).toBe('America/New_York');
  });

  it('moves by civil dates across both DST boundaries',()=>{
    expect(shiftCivilDate('2026-03-08',1)).toBe('2026-03-09');
    expect(shiftCivilDate('2026-11-01',1)).toBe('2026-11-02');
    expect(shiftCivilDate('2026-03-08',-1)).toBe('2026-03-07');
  });
});
