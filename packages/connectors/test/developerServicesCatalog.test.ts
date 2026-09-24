import { describe, expect, it, vi } from 'vitest';
import {
  DEVELOPER_SERVICES, DEVELOPER_SERVICE_CATALOG, checkDeveloperToken,
  listDeveloperResources,
  type DeveloperService,
} from '../src/developerServices.js';

const CASES: Array<readonly [DeveloperService, string, unknown, string]> = [
  ['gitlab', 'gitlab.com/api/v4/user', { username: 'gitlab-user' }, 'gitlab-user'],
  ['cloudflare', 'api.cloudflare.com/client/v4/user/tokens/verify', { result: { id: '1234567890abcdef' } }, 'token 12345678'],
  ['sentry', 'sentry.io/api/0/organizations/', [{ slug: 'acme' }, { slug: 'other' }], 'acme +1'],
  ['railway', 'backboard.railway.app/graphql/v2', { data: { me: { name: 'Rail Owner' } } }, 'Rail Owner'],
  ['render', 'api.render.com/v1/owners', [{ owner: { name: 'Acme' } }], 'Acme'],
  ['linear', 'api.linear.app/graphql', { data: { viewer: { name: 'Lin Owner' } } }, 'Lin Owner'],
  ['ghcr', 'api.github.com/user', { login: 'package-owner' }, 'package-owner packages'],
  ['npm', 'registry.npmjs.org/-/whoami', { username: 'npm-user' }, 'npm-user'],
  ['neon', 'console.neon.tech/api/v2/users/me', { user: { email: 'owner@example.test' } }, 'owner@example.test'],
  ['notion', 'api.notion.com/v1/users/me', { name: 'Josi integration' }, 'Josi integration'],
];

describe('native developer-service catalog', () => {
  it('has one provider-specific descriptor for every accepted service', () => {
    expect(new Set(DEVELOPER_SERVICE_CATALOG.map((item) => item.service))).toEqual(new Set(DEVELOPER_SERVICES));
    for (const item of DEVELOPER_SERVICE_CATALOG) {
      expect(item.tokenUrl, item.service).toMatch(/^https:\/\//);
      expect(item.capability.length, item.service).toBeGreaterThan(20);
    }
  });

  it.each(CASES)('authenticates %s against its fixed identity protocol', async (service, expectedUrl, body, label) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(checkDeveloperToken({ service, token: 'fixture-token', fetchImpl: fetchImpl as typeof fetch }))
      .resolves.toMatchObject({ ok: true, accountLabel: label });
    expect(String(fetchImpl.mock.calls[0][0])).toContain(expectedUrl);
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe(service === 'linear' ? 'fixture-token' : 'Bearer fixture-token');
    if (service === 'railway' || service === 'linear') {
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
      expect(String(fetchImpl.mock.calls[0][1]?.body)).toMatch(/JosiIdentity/);
    }
    if (service === 'notion') expect(headers['notion-version']).toBe('2022-06-28');
  });

  it('uses Docker Hub credential exchange before reading identity', async () => {
    const fetchImpl=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({token:'short-lived-jwt'}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({username:'dock-user'}),{status:200}));
    await expect(checkDeveloperToken({service:'dockerhub',token:'fixture-token',username:'dock-user',fetchImpl:fetchImpl as typeof fetch}))
      .resolves.toMatchObject({ok:true,accountLabel:'dock-user'});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/v2/users/login');
    expect((fetchImpl.mock.calls[1][1]?.headers as Record<string,string>).authorization).toBe('JWT short-lived-jwt');
  });

  it('pins Jira identity checks to the entered atlassian.net origin and Basic auth', async () => {
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({displayName:'Jira Owner'}),{status:200}));
    await expect(checkDeveloperToken({service:'jira',token:'fixture-token',email:'owner@example.test',baseUrl:'https://acme.atlassian.net',fetchImpl:fetchImpl as typeof fetch}))
      .resolves.toMatchObject({ok:true,accountLabel:'Jira Owner · acme.atlassian.net'});
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://acme.atlassian.net/rest/api/3/myself');
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string,string>).authorization).toMatch(/^Basic /);
    await expect(checkDeveloperToken({service:'jira',token:'x',email:'a@b.test',baseUrl:'https://metadata.example.test',fetchImpl:fetchImpl as typeof fetch}))
      .resolves.toMatchObject({ok:false,category:'authorization'});
  });

  it.each([
    ['github',{id:1,full_name:'acme/repo'},'repository'],
    ['gitlab',{id:2,path_with_namespace:'acme/project'},'project'],
    ['netlify',{id:'s1',name:'site'},'site'],
  ] as const)('discovers bounded %s resources through its native collection API',async(service,item,kind)=>{
    const body=service==='netlify'?[item]:[item];
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify(body),{status:200}));
    const resources=await listDeveloperResources({service,token:'fixture-token',fetchImpl:fetchImpl as typeof fetch});
    expect(resources).toHaveLength(1);
    expect(resources[0].kind).toBe(kind);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  });

  it('discovers Docker Hub repositories after its provider-specific exchange',async()=>{
    const fetchImpl=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({token:'jwt'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({results:[{namespace:'acme',name:'api'}]}),{status:200}));
    await expect(listDeveloperResources({service:'dockerhub',token:'pat',username:'acme',fetchImpl:fetchImpl as typeof fetch})).resolves.toEqual([{id:'acme/api',name:'acme/api',kind:'repository'}]);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/v2/repositories/acme/');
  });

  it.each([
    ['railway',{data:{me:{projects:{edges:[{node:{id:'r1',name:'Rail project'}}]}}}},'project'],
    ['linear',{data:{teams:{nodes:[{id:'l1',name:'Linear team'}]}}},'team'],
  ] as const)('discovers %s GraphQL resources',async(service,body,kind)=>{
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify(body),{status:200}));
    const result=await listDeveloperResources({service,token:'token',fetchImpl:fetchImpl as typeof fetch});
    expect(result[0].kind).toBe(kind);
    expect(String(fetchImpl.mock.calls[0][1]?.body)).toContain('JosiResources');
  });

  it('discovers Jira projects only on the pinned Cloud site',async()=>{
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({values:[{id:'j1',name:'Support'}]}),{status:200}));
    await expect(listDeveloperResources({service:'jira',token:'token',email:'owner@example.test',baseUrl:'https://acme.atlassian.net',fetchImpl:fetchImpl as typeof fetch})).resolves.toEqual([{id:'j1',name:'Support',kind:'project'}]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/rest/api/3/project/search');
  });

  it('discovers GHCR packages separately from GitHub repositories',async()=>{
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify([{id:4,name:'image'}]),{status:200}));
    const result=await listDeveloperResources({service:'ghcr',token:'token',fetchImpl:fetchImpl as typeof fetch});
    expect(result[0].kind).toBe('container_package');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('package_type=container');
  });

  it('resolves npm identity before bounded maintainer package search',async()=>{
    const fetchImpl=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({username:'owner'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({objects:[{package:{name:'pkg',links:{npm:'https://npmjs.com/pkg'}}}]}),{status:200}));
    await expect(listDeveloperResources({service:'npm',token:'token',fetchImpl:fetchImpl as typeof fetch})).resolves.toMatchObject([{name:'pkg',kind:'package'}]);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('maintainer%3Aowner');
  });
});
