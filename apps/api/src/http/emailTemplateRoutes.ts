import { Router } from 'express';
import { approvalHash, createThread, type Db } from '@josi-ce/core';
import { executeAssistantTool } from '@josi-ce/agent';
import {
  deleteEmailTemplate, emailMergeValues, EmailTemplateError, listEmailTemplates,
  renderEmailTemplate, resolveEmailTemplate, saveEmailTemplate, validateEmailTemplate, verifyFrozenEmail,
} from '@josi-ce/mail';
import { requireAuth } from './authz.js';
import { asyncRoute, param } from './async.js';

export function emailTemplateRoutes(db: Db): Router {
  const r = Router();
  r.use(requireAuth);
  const handle = (fn: Parameters<typeof asyncRoute>[0]) => asyncRoute(async (req, res) => {
    try { return await fn(req, res); }
    catch (error) {
      if (error instanceof EmailTemplateError) return res.status(error.status).json({error:error.message});
      throw error;
    }
  });
  r.get('/', handle(async (req,res) => res.json({templates:await listEmailTemplates(db,req.user!.id)})));
  r.post('/', handle(async (req,res) => res.status(201).json({template:await saveEmailTemplate(db,req.user!.id,req.body)})));
  r.post('/preview', handle(async (req,res) => {
    const template = validateEmailTemplate(req.body?.template);
    const recipient = typeof req.body?.recipient === 'string' ? req.body.recipient : '';
    return res.json(renderEmailTemplate(template,emailMergeValues(req.body?.merge_values,recipient)));
  }));
  // Reuses the assistant's approval path, with a new private conversation for this draft.
  r.post('/draft', handle(async (req,res) => {
    const input = req.body ?? {};
    const allowed = ['recipient','subject','body','cc','template_id','template_name','merge_values'];
    if (Object.keys(input).some(k => !allowed.includes(k))) throw new EmailTemplateError('Unsupported draft field.');
    if (typeof input.recipient !== 'string' || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.recipient)) throw new EmailTemplateError('Enter one valid recipient address.');
    if (input.template_id !== undefined || input.template_name !== undefined) await resolveEmailTemplate(db,req.user!.id,{id:input.template_id,name:input.template_name});
    const thread = await createThread(db,{ownerUserId:req.user!.id,title:'Email draft'});
    const result = await executeAssistantTool(db,{userId:req.user!.id,threadId:thread.id},'draft_email',input) as {ok:boolean;message?:string};
    return res.status(result.ok ? 201 : 400).json(result);
  }));
  r.get('/approvals/:id/preview', handle(async (req,res) => {
    const [row] = await db.query<{slots:Record<string,unknown>;payload_hash:string}>(
      `select t.slots,a.payload_hash from approvals a join tasks t on a.subject_type='task' and a.subject_id=t.id
       where a.id::text=$1 and a.owner_user_id=$2 and t.owner_user_id=$2 and a.status='pending'`, [param(req,'id'),req.user!.id]);
    if (!row || !row.slots.rendered_email) throw new EmailTemplateError('Template preview not found.',404);
    if (approvalHash(row.slots) !== row.payload_hash) throw new EmailTemplateError('The draft changed. Prepare it again.',409);
    const frozen = verifyFrozenEmail(row.slots.rendered_email);
    return res.json({subject:frozen.subject,text:frozen.text,html:frozen.html});
  }));
  r.get('/:id', handle(async (req,res) => res.json({template:await resolveEmailTemplate(db,req.user!.id,{id:param(req,'id')})})));
  r.put('/:id', handle(async (req,res) => res.json({template:await saveEmailTemplate(db,req.user!.id,req.body,param(req,'id'))})));
  r.delete('/:id', handle(async (req,res) => {await deleteEmailTemplate(db,req.user!.id,param(req,'id'));return res.status(204).end();}));
  return r;
}
