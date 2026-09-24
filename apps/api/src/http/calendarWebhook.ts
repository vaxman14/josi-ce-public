import type { Express, Request, Response } from 'express';
import type { Db } from '@josi-ce/core';
import { enqueueCalendarWebhook } from '@josi-ce/connectors';

/** Google authenticates push notifications with the unguessable channel id
 * and resource id returned by events.watch. Unknown pairs get 404 so this
 * endpoint is not a public queue trigger. No event content arrives here. */
export function mountCalendarWebhook(app:Express,db:Db):void{
  app.post('/calendar/google/webhook',(req:Request,res:Response)=>{
    void (async()=>{
      const channel=String(req.header('x-goog-channel-id')??'');
      const resource=String(req.header('x-goog-resource-id')??'');
      if(!channel||!resource||!(await enqueueCalendarWebhook(db,{channelId:channel,resourceId:resource}))) return res.sendStatus(404);
      return res.sendStatus(204);
    })().catch(()=>res.sendStatus(503));
  });
}
