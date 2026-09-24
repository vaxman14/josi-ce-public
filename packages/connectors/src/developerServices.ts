// Developer services: GitHub, Netlify, Vercel, Supabase.
//
// Each is one person's own account, reached with a token that person creates
// and pastes. There is no installation-wide application to register and no
// shared credential, which is why the administrator surface for these governs
// PERMISSION rather than configuration — see migration 0033 for why those are
// two tables.
//
// The token check is a real call to the service's own identity endpoint. It is
// the cheapest request that proves the token is valid and tells the owner which
// account they just connected; nothing else about the account is read, and
// nothing is stored from the response but the account's own name.
export type DeveloperService =
  | 'github' | 'netlify' | 'vercel' | 'supabase'
  | 'gitlab' | 'cloudflare' | 'sentry' | 'railway' | 'render' | 'linear'
  | 'dockerhub' | 'ghcr' | 'jira' | 'npm' | 'neon' | 'notion';

export const DEVELOPER_SERVICES: readonly DeveloperService[] = [
  'github', 'netlify', 'vercel', 'supabase',
  'gitlab', 'cloudflare', 'sentry', 'railway', 'render', 'linear',
  'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
];

export function isDeveloperService(value: unknown): value is DeveloperService {
  return typeof value === 'string' && (DEVELOPER_SERVICES as readonly string[]).includes(value);
}

export type PermissionMode = 'not_allowed' | 'everyone' | 'specific_users';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'not_allowed' || value === 'everyone' || value === 'specific_users';
}

export interface DeveloperServiceDescriptor {
  service: DeveloperService;
  label: string;
  /** What the person is pasting, in that service's own words. */
  tokenLabel: string;
  /** Where they get it. A token field with no route to the token is a dead end. */
  tokenHelp: string;
  tokenUrl: string;
  /** What Josi will be able to do with it, so permitting is informed. */
  capability: string;
  usernameLabel?: string;
  emailLabel?: string;
  baseUrlLabel?: string;
}

export const DEVELOPER_SERVICE_CATALOG: readonly DeveloperServiceDescriptor[] = [
  {
    service: 'github',
    label: 'GitHub',
    tokenLabel: 'Personal access token',
    tokenHelp:
      'In GitHub open Settings → Developer settings → Personal access tokens and create one. '
      + 'Give it only the repositories and permissions you want Josi to see.',
    tokenUrl: 'https://github.com/settings/tokens',
    capability: 'Read the repositories your token permits, and act on them where you approve it.',
  },
  {
    service: 'netlify',
    label: 'Netlify',
    tokenLabel: 'Personal access token',
    tokenHelp:
      'In Netlify open User settings → Applications → Personal access tokens and create one.',
    tokenUrl: 'https://app.netlify.com/user/applications',
    capability: 'See your sites and their deploy status.',
  },
  {
    service: 'vercel',
    label: 'Vercel',
    tokenLabel: 'Access token',
    tokenHelp: 'In Vercel open Account Settings → Tokens and create one, scoped to the team you want.',
    tokenUrl: 'https://vercel.com/account/tokens',
    capability: 'See your projects and their deployments.',
  },
  {
    service: 'supabase',
    label: 'Supabase',
    tokenLabel: 'Personal access token',
    tokenHelp: 'In Supabase open Account → Access Tokens and generate one.',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    capability: 'See your projects. Josi does not read the contents of your database.',
  },
  {
    service: 'gitlab', label: 'GitLab', tokenLabel: 'Personal access token',
    tokenHelp: 'In GitLab open Preferences → Access Tokens. Grant only the API scopes you intend Josi to use.',
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    capability: 'Read the projects your token permits and prepare approved repository actions.',
  },
  {
    service: 'cloudflare', label: 'Cloudflare', tokenLabel: 'API token',
    tokenHelp: 'In Cloudflare open My Profile → API Tokens and create a narrowly scoped token.',
    tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    capability: 'Inspect the Cloudflare accounts and resources allowed by this token.',
  },
  {
    service: 'sentry', label: 'Sentry', tokenLabel: 'User authentication token',
    tokenHelp: 'In Sentry open User settings → Auth Tokens and create a token with the minimum organization/project scopes needed.',
    tokenUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    capability: 'Inspect authorized organizations, projects, issues, and events.',
  },
  {
    service: 'render', label: 'Render', tokenLabel: 'API key',
    tokenHelp: 'In Render open Account Settings → API Keys and create a key.',
    tokenUrl: 'https://dashboard.render.com/u/settings#api-keys',
    capability: 'Inspect authorized owners, services, and deploy state.',
  },
  {
    service: 'railway', label: 'Railway', tokenLabel: 'Account API token',
    tokenHelp: 'In Railway open Account Settings → Tokens and create an account token. Project tokens have a different permission model and are not accepted here.',
    tokenUrl: 'https://railway.app/account/tokens',
    capability: 'Inspect the Railway workspaces, projects, services, and deployments allowed by this account token.',
  },
  {
    service: 'linear', label: 'Linear', tokenLabel: 'Personal API key',
    tokenHelp: 'In Linear open Settings → Security & access → Personal API keys and create a key.',
    tokenUrl: 'https://linear.app/settings/api',
    capability: 'Read authorized Linear workspaces, teams, projects, and issues and prepare approved changes.',
  },
  {
    service: 'dockerhub', label: 'Docker Hub', tokenLabel: 'Personal access token',
    tokenHelp: 'In Docker Hub open Account settings → Personal access tokens. Use your Docker Hub username with a narrowly scoped token.',
    tokenUrl: 'https://app.docker.com/settings/personal-access-tokens', usernameLabel: 'Docker Hub username',
    capability: 'Inspect repositories, tags, and image metadata authorized for this Docker Hub account.',
  },
  {
    service: 'ghcr', label: 'GitHub Container Registry', tokenLabel: 'GitHub token with package access',
    tokenHelp: 'Create a GitHub token restricted to the organizations and container packages Josi needs. Package access is distinct from repository access.',
    tokenUrl: 'https://github.com/settings/tokens',
    capability: 'Inspect GHCR container packages and versions authorized by this package-scoped token.',
  },
  {
    service: 'jira', label: 'Jira Cloud', tokenLabel: 'Atlassian API token',
    tokenHelp: 'Create an Atlassian API token and enter the email address that owns it plus your Jira Cloud site URL.',
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    emailLabel: 'Atlassian account email', baseUrlLabel: 'Jira Cloud URL',
    capability: 'Read authorized Jira Cloud sites, projects, and issues and prepare approved changes.',
  },
  {
    service: 'npm', label: 'npm', tokenLabel: 'Granular access token',
    tokenHelp: 'In npm open Access Tokens and create a granular token restricted to the packages and organizations Josi needs.',
    tokenUrl: 'https://www.npmjs.com/settings/~/tokens/',
    capability: 'Inspect package and organization metadata allowed by this token.',
  },
  {
    service: 'neon', label: 'Neon', tokenLabel: 'API key',
    tokenHelp: 'In Neon open Account settings → API keys and create a key.',
    tokenUrl: 'https://console.neon.tech/app/settings/api-keys',
    capability: 'Inspect the Neon projects and branches allowed by this key.',
  },
  {
    service: 'notion', label: 'Notion', tokenLabel: 'Internal integration secret',
    tokenHelp: 'Create an internal integration in Notion, then explicitly share only the pages Josi may access with it.',
    tokenUrl: 'https://www.notion.so/profile/integrations',
    capability: 'Search and read only the Notion pages explicitly shared with this integration.',
  },
];

export function describeDeveloperService(
  service: string,
): DeveloperServiceDescriptor | null {
  return DEVELOPER_SERVICE_CATALOG.find((d) => d.service === service) ?? null;
}

/** Where each service answers "whose token is this?", and how to read the name
 * out of the reply. Kept in one table so adding a fifth service is an entry
 * rather than another branch in the check function. */
const IDENTITY: Record<Exclude<DeveloperService, 'dockerhub' | 'jira'>, {
  url: string;
  header: (token: string) => Record<string, string>;
  request?: RequestInit;
  label: (body: any) => string | null;
}> = {
  github: {
    url: 'https://api.github.com/user',
    header: (t) => ({ authorization: `Bearer ${t}`, accept: 'application/vnd.github+json' }),
    label: (b) => (typeof b?.login === 'string' ? b.login : null),
  },
  ghcr: {
    url: 'https://api.github.com/user',
    header: (t) => ({ authorization: `Bearer ${t}`, accept: 'application/vnd.github+json' }),
    label: (b) => (typeof b?.login === 'string' ? `${b.login} packages` : null),
  },
  netlify: {
    url: 'https://api.netlify.com/api/v1/user',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.email === 'string' ? b.email : typeof b?.slug === 'string' ? b.slug : null),
  },
  vercel: {
    url: 'https://api.vercel.com/v2/user',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.user?.username === 'string' ? b.user.username : null),
  },
  supabase: {
    url: 'https://api.supabase.com/v1/projects',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    // Supabase has no "me" endpoint; a successful project listing is the proof,
    // and the count is the only thing worth showing back.
    label: (b) => (Array.isArray(b) ? `${b.length} project${b.length === 1 ? '' : 's'}` : null),
  },
  gitlab: {
    url: 'https://gitlab.com/api/v4/user',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.username === 'string' ? b.username : null),
  },
  cloudflare: {
    url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.result?.id === 'string' ? `token ${b.result.id.slice(0, 8)}` : null),
  },
  sentry: {
    url: 'https://sentry.io/api/0/organizations/',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (Array.isArray(b) && typeof b[0]?.slug === 'string'
      ? `${b[0].slug}${b.length > 1 ? ` +${b.length - 1}` : ''}` : Array.isArray(b) ? 'No organizations' : null),
  },
  render: {
    url: 'https://api.render.com/v1/owners?limit=20',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (Array.isArray(b) && typeof b[0]?.owner?.name === 'string'
      ? b[0].owner.name : Array.isArray(b) && typeof b[0]?.name === 'string' ? b[0].name : null),
  },
  railway: {
    url: 'https://backboard.railway.app/graphql/v2',
    header: (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' }),
    request: { method: 'POST', body: JSON.stringify({ query: 'query JosiIdentity { me { id name email } }' }) },
    label: (b) => (typeof b?.data?.me?.name === 'string' ? b.data.me.name
      : typeof b?.data?.me?.email === 'string' ? b.data.me.email : null),
  },
  linear: {
    url: 'https://api.linear.app/graphql',
    header: (t) => ({ authorization: t, 'content-type': 'application/json' }),
    request: { method: 'POST', body: JSON.stringify({ query: 'query JosiIdentity { viewer { id name email } }' }) },
    label: (b) => (typeof b?.data?.viewer?.name === 'string' ? b.data.viewer.name
      : typeof b?.data?.viewer?.email === 'string' ? b.data.viewer.email : null),
  },
  npm: {
    url: 'https://registry.npmjs.org/-/whoami',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.username === 'string' ? b.username : null),
  },
  neon: {
    url: 'https://console.neon.tech/api/v2/users/me',
    header: (t) => ({ authorization: `Bearer ${t}` }),
    label: (b) => (typeof b?.user?.email === 'string' ? b.user.email
      : typeof b?.email === 'string' ? b.email : null),
  },
  notion: {
    url: 'https://api.notion.com/v1/users/me',
    header: (t) => ({ authorization: `Bearer ${t}`, 'notion-version': '2022-06-28' }),
    label: (b) => (typeof b?.name === 'string' ? b.name
      : typeof b?.bot?.owner?.workspace === 'boolean' ? 'Workspace integration' : null),
  },
};

export type DeveloperCheckFailure = 'authentication' | 'authorization' | 'network' | 'unknown';

export interface DeveloperCheck {
  ok: boolean;
  accountLabel?: string | null;
  category?: DeveloperCheckFailure;
  detail: string;
}

export interface DeveloperCheckOptions {
  service: DeveloperService;
  token: string;
  username?: string;
  email?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DeveloperResource { id:string; name:string; kind:string; url?:string }

/** Bounded provider-native discovery. Only fixed, read-only collection APIs
 * live here; providers without a safe collection contract are status-only. */
export async function listDeveloperResources(opts:DeveloperCheckOptions):Promise<DeveloperResource[]> {
  const doFetch:typeof fetch=(url,init)=> (opts.fetchImpl??fetch)(url,{...init,redirect:'error',signal:AbortSignal.timeout(opts.timeoutMs??15_000)});
  if(opts.service==='dockerhub'){
    if(!opts.username?.trim())throw new Error('A Docker Hub username is required.');
    const login=await doFetch('https://hub.docker.com/v2/users/login',{method:'POST',headers:{'content-type':'application/json','user-agent':'josi-ce'},body:JSON.stringify({username:opts.username.trim(),password:opts.token}),redirect:'error'});
    if(!login.ok)throw new Error(`Docker Hub refused resource discovery (${login.status}).`);
    const jwt=String((await login.json().catch(()=>null))?.token??'');
    if(!jwt)throw new Error('Docker Hub did not return a session token.');
    const response=await doFetch(`https://hub.docker.com/v2/repositories/${encodeURIComponent(opts.username.trim())}/?page_size=25`,{headers:{authorization:`JWT ${jwt}`,'user-agent':'josi-ce'},redirect:'error'});
    if(!response.ok)throw new Error(`Docker Hub refused resource discovery (${response.status}).`);
    const body=await response.json();
    return (Array.isArray(body?.results)?body.results:[]).slice(0,25).map((v:any)=>({id:String(v.namespace&&v.name?`${v.namespace}/${v.name}`:v.name),name:String(v.namespace&&v.name?`${v.namespace}/${v.name}`:v.name),kind:'repository'}));
  }
  if(opts.service==='jira'){
    let site:URL;try{site=new URL(opts.baseUrl??'');}catch{throw new Error('Enter a valid Jira Cloud URL.');}
    if(site.protocol!=='https:'||!/(^|\.)atlassian\.net$/i.test(site.hostname)||!opts.email?.trim())throw new Error('Jira Cloud discovery requires an atlassian.net site and account email.');
    const response=await doFetch(`${site.origin}/rest/api/3/project/search?maxResults=25`,{headers:{authorization:`Basic ${Buffer.from(`${opts.email.trim()}:${opts.token}`).toString('base64')}`,accept:'application/json','user-agent':'josi-ce'},redirect:'error'});
    if(!response.ok)throw new Error(`Jira refused resource discovery (${response.status}).`);
    const body=await response.json();
    return (Array.isArray(body?.values)?body.values:[]).slice(0,25).map((v:any)=>({id:String(v.id),name:String(v.name),kind:'project'}));
  }
  if(opts.service==='railway'||opts.service==='linear'){
    const railway=opts.service==='railway';
    const response=await doFetch(railway?'https://backboard.railway.app/graphql/v2':'https://api.linear.app/graphql',{method:'POST',headers:{authorization:railway?`Bearer ${opts.token}`:opts.token,'content-type':'application/json','user-agent':'josi-ce'},body:JSON.stringify({query:railway?'query JosiResources { me { projects { edges { node { id name } } } } }':'query JosiResources { teams { nodes { id name } } }'}),redirect:'error'});
    if(!response.ok)throw new Error(`The provider refused resource discovery (${response.status}).`);
    const body=await response.json();
    const values=railway?(body?.data?.me?.projects?.edges??[]).map((e:any)=>e?.node):body?.data?.teams?.nodes??[];
    return (Array.isArray(values)?values:[]).slice(0,25).filter((v:any)=>v?.id&&v?.name).map((v:any)=>({id:String(v.id),name:String(v.name),kind:railway?'project':'team'}));
  }
  if(opts.service==='npm'){
    const me=await doFetch('https://registry.npmjs.org/-/whoami',{headers:{authorization:`Bearer ${opts.token}`,'user-agent':'josi-ce'},redirect:'error'});
    if(!me.ok)throw new Error(`npm refused resource discovery (${me.status}).`);
    const username=String((await me.json().catch(()=>null))?.username??'');
    if(!username)throw new Error('npm did not return an account name.');
    const response=await doFetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`maintainer:${username}`)}&size=25`,{headers:{authorization:`Bearer ${opts.token}`,'user-agent':'josi-ce'},redirect:'error'});
    if(!response.ok)throw new Error(`npm refused package discovery (${response.status}).`);
    const body=await response.json();
    return (Array.isArray(body?.objects)?body.objects:[]).slice(0,25).map((v:any)=>v?.package).filter((v:any)=>v?.name).map((v:any)=>({id:String(v.name),name:String(v.name),kind:'package',url:v.links?.npm}));
  }
  const fixed:Partial<Record<DeveloperService,{url:string;headers:(t:string)=>Record<string,string>;method?:string;body?:string;items:(b:any)=>any[];map:(v:any)=>DeveloperResource|null}>>={
    github:{url:'https://api.github.com/user/repos?per_page=25&sort=updated',headers:(t)=>({authorization:`Bearer ${t}`,accept:'application/vnd.github+json'}),items:(b)=>Array.isArray(b)?b:[],map:(v)=>v?.id&&v?.full_name?{id:String(v.id),name:v.full_name,kind:'repository',url:v.html_url}:null},
    ghcr:{url:'https://api.github.com/user/packages?package_type=container&per_page=25',headers:(t)=>({authorization:`Bearer ${t}`,accept:'application/vnd.github+json'}),items:(b)=>Array.isArray(b)?b:[],map:(v)=>v?.id&&v?.name?{id:String(v.id),name:v.name,kind:'container_package',url:v.html_url}:null},
    gitlab:{url:'https://gitlab.com/api/v4/projects?membership=true&per_page=25&order_by=last_activity_at',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b)?b:[],map:(v)=>v?.id&&v?.path_with_namespace?{id:String(v.id),name:v.path_with_namespace,kind:'project',url:v.web_url}:null},
    cloudflare:{url:'https://api.cloudflare.com/client/v4/accounts?per_page=25',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b?.result)?b.result:[],map:(v)=>v?.id&&v?.name?{id:String(v.id),name:v.name,kind:'account'}:null},
    netlify:{url:'https://api.netlify.com/api/v1/sites?per_page=25',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b)?b:[],map:(v)=>v?.id&&v?.name?{id:String(v.id),name:v.name,kind:'site',url:v.admin_url}:null},
    vercel:{url:'https://api.vercel.com/v9/projects?limit=25',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b?.projects)?b.projects:[],map:(v)=>v?.id&&v?.name?{id:String(v.id),name:v.name,kind:'project'}:null},
    supabase:{url:'https://api.supabase.com/v1/projects',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b)?b.slice(0,25):[],map:(v)=>v?.id&&v?.name?{id:String(v.id),name:v.name,kind:'project'}:null},
    sentry:{url:'https://sentry.io/api/0/organizations/',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b)?b.slice(0,25):[],map:(v)=>v?.id&&v?.slug?{id:String(v.id),name:v.slug,kind:'organization'}:null},
    render:{url:'https://api.render.com/v1/services?limit=20',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b)?b:[],map:(v)=>{const x=v?.service??v;return x?.id&&x?.name?{id:String(x.id),name:x.name,kind:'service'}:null}},
    neon:{url:'https://console.neon.tech/api/v2/projects?limit=25',headers:(t)=>({authorization:`Bearer ${t}`}),items:(b)=>Array.isArray(b?.projects)?b.projects:[],map:(v)=>v?.id&&v?.name?{id:String(v.id),name:v.name,kind:'project'}:null},
    notion:{url:'https://api.notion.com/v1/search',headers:(t)=>({authorization:`Bearer ${t}`,'notion-version':'2022-06-28','content-type':'application/json'}),method:'POST',body:JSON.stringify({page_size:25,sort:{direction:'descending',timestamp:'last_edited_time'}}),items:(b)=>Array.isArray(b?.results)?b.results:[],map:(v)=>{const title=v?.properties?.title?.title?.[0]?.plain_text??v?.title?.[0]?.plain_text;return v?.id?{id:String(v.id),name:typeof title==='string'&&title?title:'Untitled',kind:v.object==='database'?'database':'page',url:v.url}:null}},
  };
  const spec=fixed[opts.service];
  if(!spec)throw new Error(`${describeDeveloperService(opts.service)?.label??opts.service} resource discovery is not available yet.`);
  const response=await doFetch(spec.url,{method:spec.method??'GET',headers:{...spec.headers(opts.token),'user-agent':'josi-ce'},body:spec.body,redirect:'error'});
  if(!response.ok)throw new Error(`The provider refused resource discovery (${response.status}).`);
  const body=await response.json();
  return spec.items(body).slice(0,25).map(spec.map).filter((v):v is DeveloperResource=>v!==null);
}

/** Ask the service whose token this is.
 *
 * A token that parses is not a token that works, and storing one without asking
 * would let a person leave this screen believing they had connected something.
 */
export async function checkDeveloperToken(
  opts: DeveloperCheckOptions,
): Promise<DeveloperCheck> {
  if (opts.service === 'dockerhub') {
    if (!opts.username?.trim()) return { ok:false, category:'authentication', detail:'A Docker Hub username is required.' };
    const doFetch:typeof fetch=(url,init)=> (opts.fetchImpl??fetch)(url,{...init,redirect:'error',signal:AbortSignal.timeout(opts.timeoutMs??15_000)});
    try {
      const login=await doFetch('https://hub.docker.com/v2/users/login',{method:'POST',headers:{'content-type':'application/json','user-agent':'josi-ce'},body:JSON.stringify({username:opts.username.trim(),password:opts.token})});
      if(login.status===401||login.status===403)return {ok:false,category:'authentication',detail:'Docker Hub rejected that username or token.'};
      if(!login.ok)return {ok:false,category:'unknown',detail:`Docker Hub answered ${login.status}.`};
      const jwt=String((await login.json().catch(()=>null))?.token??'');
      if(!jwt)return {ok:false,category:'unknown',detail:'Docker Hub did not return a session token.'};
      const me=await doFetch('https://hub.docker.com/v2/user/',{headers:{authorization:`JWT ${jwt}`,'user-agent':'josi-ce'}});
      if(!me.ok)return {ok:false,category:me.status===401?'authentication':'unknown',detail:`Docker Hub identity check failed (${me.status}).`};
      const body=await me.json().catch(()=>null);
      return {ok:true,accountLabel:typeof body?.username==='string'?body.username:opts.username.trim(),detail:'Connected.'};
    } catch { return {ok:false,category:'network',detail:'Docker Hub could not be reached from this server.'}; }
  }
  if (opts.service === 'jira') {
    let site:URL;
    try{site=new URL(opts.baseUrl??'');}catch{return {ok:false,category:'authentication',detail:'Enter a valid Jira Cloud URL.'};}
    if(site.protocol!=='https:'||!/(^|\.)atlassian\.net$/i.test(site.hostname)||site.username||site.password)return {ok:false,category:'authorization',detail:'Jira Cloud URLs must use HTTPS on an atlassian.net site.'};
    if(!opts.email?.trim())return {ok:false,category:'authentication',detail:'An Atlassian account email is required.'};
    try{const response=await (opts.fetchImpl??fetch)(`${site.origin}/rest/api/3/myself`,{redirect:'error',signal:AbortSignal.timeout(opts.timeoutMs??15_000),headers:{authorization:`Basic ${Buffer.from(`${opts.email.trim()}:${opts.token}`).toString('base64')}`,accept:'application/json','user-agent':'josi-ce'}});if(response.status===401||response.status===403)return {ok:false,category:'authentication',detail:'Jira rejected that email or API token.'};if(!response.ok)return {ok:false,category:'unknown',detail:`Jira answered ${response.status}.`};const body=await response.json().catch(()=>null);return {ok:true,accountLabel:typeof body?.displayName==='string'?`${body.displayName} · ${site.hostname}`:site.hostname,detail:'Connected.'};}catch{return {ok:false,category:'network',detail:'Jira could not be reached from this server.'};}
  }
  const spec = IDENTITY[opts.service];
  const doFetch:typeof fetch=(url,init)=>(opts.fetchImpl??fetch)(url,{...init,redirect:'error',signal:AbortSignal.timeout(opts.timeoutMs??15_000)});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(spec.url, {
      ...spec.request,
      method: spec.request?.method ?? 'GET',
      headers: { ...spec.header(opts.token), 'user-agent': 'josi-ce' },
      signal: controller.signal,
    });
    if (res.status === 401) {
      return {
        ok: false,
        category: 'authentication',
        detail: 'That token was rejected. Check it was pasted whole and has not expired.',
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        category: 'authorization',
        detail: 'That token is valid but not permitted to read your account. Check its scopes.',
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, category: 'unknown', detail: `The service answered ${res.status}.` };
    }
    const body = await res.json().catch(() => null);
    return {
      ok: spec.label(body)!==null && !body?.errors && body?.success!==false,
      accountLabel: spec.label(body),
      detail: spec.label(body)!==null && !body?.errors && body?.success!==false ? 'Connected.' : 'The provider did not confirm a valid identity.',
    };
  } catch {
    return {
      ok: false,
      category: 'network',
      detail: 'The service could not be reached from this server.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface EffectiveScope {
  mode: PermissionMode;
  /** Only meaningful for `specific_users`. */
  allowedUserIds: string[];
}

/** May this person connect this service?
 *
 * One function so the answer cannot differ between the screen that offers the
 * control and the route that accepts the token. The route is the one that
 * matters — a screen hiding a control is presentation, not authorization. */
export function mayConnect(scope: EffectiveScope, userId: string): boolean {
  if (scope.mode === 'everyone') return true;
  if (scope.mode === 'specific_users') return scope.allowedUserIds.includes(userId);
  return false;
}

/** The scope in a sentence, for the administrator who set it.
 *
 * "Allowed for specific users" tells them nothing about whether they finished
 * choosing; a count and the fact that an empty list permits nobody does. */
export function summarizeScope(scope: EffectiveScope, names: string[] = []): string {
  switch (scope.mode) {
    case 'everyone':
      return 'Anyone with an account here can connect their own.';
    case 'specific_users': {
      if (!scope.allowedUserIds.length) {
        return 'Nobody yet — "specific people" is selected but no one has been chosen.';
      }
      const shown = names.slice(0, 3).join(', ');
      const rest = scope.allowedUserIds.length - Math.min(3, names.length);
      return rest > 0
        ? `${shown} and ${rest} more can connect their own.`
        : `${shown} can connect their own.`;
    }
    default:
      return 'Nobody here can connect this service.';
  }
}
