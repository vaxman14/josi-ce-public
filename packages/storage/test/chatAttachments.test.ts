import { beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, symlink, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { ATTACHMENT_CAPABILITIES, attachmentFailure, validateAttachment, readAttachment, writeAttachment, writeAttachmentFromFile, removeAttachment, probeAttachmentStorage } from '../src/index.js';
let root:string;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'ce-attachment-test-'));});
const box=(type:string,data=Buffer.alloc(0))=>{const b=Buffer.alloc(8+data.length);b.writeUInt32BE(b.length);b.write(type,4,'ascii');data.copy(b,8);return b;};
const bmff=(brand:string)=>Buffer.concat([box('ftyp',Buffer.from(brand+'\0\0\0\0'+brand,'ascii')),box('moov')]);
const riff=(kind:string,body:Buffer)=>{const b=Buffer.alloc(12+body.length);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write(kind,8);body.copy(b,12);return b;};
const png=()=>Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('0000000d49484452','hex'),Buffer.alloc(17),Buffer.from('0000000049454e44','hex'),Buffer.alloc(4)]);
const ole=(name:string)=>{const b=Buffer.alloc(512);Buffer.from('d0cf11e0a1b11ae1','hex').copy(b);b.writeUInt16LE(0xfffe,28);b.writeUInt16LE(9,30);b.write(name,128,'utf16le');return b;};
const zip=(name='safe.txt')=>Buffer.from(zipSync({[name]:strToU8('x')}));
const office=(name:string)=>Buffer.from(zipSync({[name]:strToU8('<x/>')}));
const valid:Record<string,Buffer>={
 jpg:Buffer.from('ffd8ffe000ffd9','hex'),jpeg:Buffer.from('ffd8ffe000ffd9','hex'),png:png(),gif:Buffer.from('GIF89a;'),webp:riff('WEBP',Buffer.alloc(4)),
 pdf:Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n'),txt:Buffer.from('hello'),md:Buffer.from('# hello'),csv:Buffer.from('a,b\n1,2'),json:Buffer.from('{"ok":true}'),rtf:Buffer.from('{\\rtf1 hello}'),
 doc:ole('WordDocument'),xls:ole('Workbook'),ppt:ole('PowerPoint Document'),docx:office('word/document.xml'),xlsx:office('xl/workbook.xml'),pptx:office('ppt/presentation.xml'),odt:office('content.xml'),ods:office('content.xml'),odp:office('content.xml'),
 mp3:Buffer.from('fffb906400000000','hex'),m4a:bmff('M4A '),aac:Buffer.from('fff15080000000','hex'),wav:riff('WAVE',Buffer.from('fmt 0000data0000')),ogg:Buffer.concat([Buffer.from('4f676753','hex'),Buffer.alloc(24),Buffer.from('vorbis'),Buffer.alloc(4)]),opus:Buffer.concat([Buffer.from('4f676753','hex'),Buffer.alloc(24),Buffer.from('OpusHead')]),flac:Buffer.from('664c614300000000','hex'),
 mp4:bmff('isom'),m4v:bmff('M4V '),mov:bmff('qt  '),webm:Buffer.concat([Buffer.from('1a45dfa3','hex'),Buffer.from('webm'),Buffer.from('18538067','hex')]),mpeg:Buffer.from('000001ba0000000000000000','hex'),zip:zip(),
};
describe('strict common attachment contract',()=>{
  it('has exactly the requested formats and an explicit conservative AVI rejection',()=>{
    expect(Object.keys(ATTACHMENT_CAPABILITIES).sort()).toEqual('jpg jpeg png gif webp heic heif pdf txt md csv json rtf doc xls ppt docx xlsx pptx odt ods odp mp3 m4a aac wav ogg opus flac mp4 m4v mov webm mpeg zip'.split(' ').sort());
    expect(()=>validateAttachment('clip.avi','video/x-msvideo',Buffer.from('RIFF----AVI '))).toThrowError(expect.objectContaining({code:'avi_validation_unavailable'}));
  });
  it.each(Object.keys(valid))('accepts a strictly identified %s family fixture',ext=>{
    const c=ATTACHMENT_CAPABILITIES[ext];expect(validateAttachment(`sample.${ext}`,c.contentType,valid[ext]).extension).toBe(ext);
  });
  it('normalizes Unicode and strips traversal/control characters',()=>expect(validateAttachment('../caf\u0065\u0301.txt','text/plain',Buffer.from('hello')).filename).toBe('_café.txt'));
  it.each(['run.exe','x.svg','x.js','x.sh','report.pdf.exe','macro.docm','old.xml','page.html'])('rejects unlisted or active %s with a code',name=>{try{validateAttachment(name,'application/octet-stream',Buffer.from('data'));throw new Error('accepted');}catch(e){expect((e as any).code).toMatch(/file_type|mime|content/);}});
  it('uses configurable category limits without large fixtures',()=>{const old=process.env.JOSI_ATTACHMENT_VIDEO_MAX_BYTES;process.env.JOSI_ATTACHMENT_VIDEO_MAX_BYTES='8';try{expect(()=>validateAttachment('a.mp4','video/mp4',bmff('isom'))).toThrowError(expect.objectContaining({code:'file_size_limit'}));}finally{if(old===undefined)delete process.env.JOSI_ATTACHMENT_VIDEO_MAX_BYTES;else process.env.JOSI_ATTACHMENT_VIDEO_MAX_BYTES=old;}});
  it('rejects MIME mismatch, truncation, polyglot executables, active PDF and malformed JSON',()=>{
    expect(()=>validateAttachment('a.txt','image/png',Buffer.from('hello'))).toThrowError(expect.objectContaining({code:'mime_mismatch'}));
    expect(()=>validateAttachment('a.png','image/png',png().subarray(0,20))).toThrowError(expect.objectContaining({code:'file_content_mismatch'}));
    expect(()=>validateAttachment('a.pdf','application/pdf',Buffer.from('%PDF-1.7 /JavaScript\n%%EOF'))).toThrowError(expect.objectContaining({code:'active_content'}));
    expect(()=>validateAttachment('a.json','application/json',Buffer.from('{'))).toThrowError(expect.objectContaining({code:'invalid_json'}));
    expect(()=>validateAttachment('a.txt','text/plain',Buffer.from('MZ executable'))).toThrowError(expect.objectContaining({code:'executable_content'}));
  });
  it('inspects ZIP central directories without extraction and rejects active, expanded and truncated packages',()=>{
    expect(validateAttachment('a.zip','application/zip',zip()).analysis).toMatchObject({status:'unavailable',code:'analysis_unavailable'});
    expect(()=>validateAttachment('a.zip','application/zip',zip('bin/run.exe'))).toThrowError(expect.objectContaining({code:'archive_active_content'}));
    expect(()=>validateAttachment('a.zip','application/zip',zip().subarray(0,-2))).toThrowError(expect.objectContaining({code:'archive_malformed'}));
    expect(()=>validateAttachment('a.docx',ATTACHMENT_CAPABILITIES.docx.contentType,Buffer.from(zipSync({'word/document.xml':strToU8('x'),'word/vbaProject.bin':strToU8('x')})))).toThrowError(expect.objectContaining({code:'active_content'}));
  });
  it('separates storable media from analysis and never overclaims duration probing',()=>{
    expect(validateAttachment('a.mp4','video/mp4',valid.mp4).analysis).toMatchObject({status:'unavailable',code:'analysis_unavailable'});
    expect(validateAttachment('a.txt','text/plain',valid.txt).analysis).toMatchObject({status:'available',kind:'text'});
  });
  it('rejects credentials before persistence',()=>expect(()=>validateAttachment('a.txt','text/plain',Buffer.from('password=abcabcabcabc'))).toThrowError(expect.objectContaining({code:'sensitive_file'})));
});
describe('real persistent filesystem operations',()=>{
  it('probes storage and reports missing provisioning',async()=>{expect(await probeAttachmentStorage(root)).toEqual({ok:true});expect(await probeAttachmentStorage(join(root,'missing'))).toMatchObject({ok:false,code:'storage_missing'});});
  it('uses server IDs and preserves bytes across buffered and streamed writes',async()=>{const id=randomUUID();await writeAttachment(id,Buffer.from('persistent'),root);expect((await readAttachment(id,root)).toString()).toBe('persistent');await expect(writeAttachment(id,Buffer.from('overwrite'),root)).rejects.toThrow();expect((await readAttachment(id,root)).toString()).toBe('persistent');await removeAttachment(id,root);const source=join(root,'stage');await writeFile(source,'streamed');const streamed=randomUUID();await writeAttachmentFromFile(streamed,source,root);expect((await readAttachment(streamed,root)).toString()).toBe('streamed');await removeAttachment(streamed,root);});
  it('refuses root and leaf symlinks and arbitrary paths',async()=>{const outside=join(root,'outside');await writeFile(outside,'private');const id=randomUUID();await symlink(outside,join(root,id));await expect(readAttachment(id,root)).rejects.toThrow();await expect(writeAttachment(id,Buffer.from('replace'),root)).rejects.toThrow();await expect(readAttachment('../outside',root)).rejects.toThrow();const linked=join(root,'linked');await symlink(root,linked);expect(await probeAttachmentStorage(linked)).toMatchObject({ok:false,code:'storage_unsafe'});expect(await readFile(outside,'utf8')).toBe('private');});
  it.each([['ENOSPC','storage_full'],['EDQUOT','storage_full'],['EROFS','storage_read_only'],['EACCES','storage_permission'],['EPERM','storage_permission']])('classifies %s without paths or raw diagnostics',(code,expected)=>{const error=attachmentFailure(Object.assign(new Error('/private/secret'),{code}));expect(error.code).toBe(expected);expect(error.message).not.toContain('/private');});
});
