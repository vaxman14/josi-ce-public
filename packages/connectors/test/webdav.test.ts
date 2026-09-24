// The Nextcloud WebDAV adapter, with the server played by a stub.
//
// What is real: the request method/headers PROPFIND and GET actually use, the
// XML this client parses, the server-URL normalisation, path containment, and
// the failure classification. No network, no real Nextcloud.
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../src/providers.js';
import {
  FileTooLarge, assertWebdavPath, downloadWebdavFile, listWebdavFolder, normalizeServerUrl,
  verifyWebdavCredentials, webdavPathFromFolderId, type WebdavCredentials,
} from '../src/providers/webdav.js';

function stub(
  handler: (url: string, init?: RequestInit) => { status?: number; xml?: string; bytes?: Buffer },
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const out = handler(href, init);
    if (out.bytes) return new Response(new Uint8Array(out.bytes), { status: out.status ?? 200 });
    return new Response(out.xml ?? '', {
      status: out.status ?? 207, headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const creds: WebdavCredentials = {
  serverUrl: 'https://cloud.example.com', username: 'roman', appPassword: 'app-pw-secret',
};

/** A minimal but real multistatus body, shaped like Nextcloud's own. First
 * response is the folder itself (WebDAV convention); the rest are children. */
function multistatus(children: Array<{ href: string; folder?: boolean; size?: number; modified?: string; name?: string }>) {
  const selfHref = '/remote.php/dav/files/roman/Documents/';
  const responseXml = (r: { href: string; folder?: boolean; size?: number; modified?: string; name?: string }) => `
    <d:response>
      <d:href>${r.href}</d:href>
      <d:propstat>
        <d:prop>
          ${r.folder ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>'}
          <d:getcontentlength>${r.size ?? 0}</d:getcontentlength>
          ${r.modified ? `<d:getlastmodified>${r.modified}</d:getlastmodified>` : ''}
          <d:displayname>${r.name ?? r.href.split('/').filter(Boolean).pop()}</d:displayname>
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:propstat>
    </d:response>`;
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    ${responseXml({ href: selfHref, folder: true, name: 'Documents' })}
    ${children.map(responseXml).join('\n')}
  </d:multistatus>`;
}

describe('normalizeServerUrl', () => {
  it('adds https when no scheme is given', () => {
    expect(normalizeServerUrl('cloud.example.com')).toBe('https://cloud.example.com');
  });

  it('accepts an explicit scheme and a sub-path install', () => {
    expect(normalizeServerUrl('https://cloud.example.com/nextcloud/')).toBe('https://cloud.example.com/nextcloud');
    expect(normalizeServerUrl('http://192.168.1.10:8080')).toBe('http://192.168.1.10:8080');
  });

  it('refuses a non-http(s) scheme', () => {
    expect(() => normalizeServerUrl('javascript:alert(1)')).toThrow(ConnectorError);
    expect(() => normalizeServerUrl('file:///etc/passwd')).toThrow(ConnectorError);
  });

  it('refuses credentials embedded in the URL itself', () => {
    expect(() => normalizeServerUrl('https://user:pass@cloud.example.com')).toThrow(ConnectorError);
  });

  it('refuses input that is not a parseable URL even with a scheme prefixed', () => {
    expect(() => normalizeServerUrl('   ')).toThrow(ConnectorError);
  });
});

describe('assertWebdavPath', () => {
  it('accepts a normal absolute path', () => {
    expect(assertWebdavPath('/Documents/Q3 report.docx')).toBe('/Documents/Q3 report.docx');
  });

  it('refuses a relative path, a NUL byte, and traversal segments', () => {
    expect(() => assertWebdavPath('Documents/notes.txt')).toThrow(ConnectorError);
    expect(() => assertWebdavPath('/a\0b')).toThrow(ConnectorError);
    expect(() => assertWebdavPath('/../etc/passwd')).toThrow(ConnectorError);
    expect(() => assertWebdavPath('/Documents/../../etc')).toThrow(ConnectorError);
  });
});

describe('webdavPathFromFolderId', () => {
  it("maps Josi's 'root' placeholder to the DAV root itself", () => {
    expect(webdavPathFromFolderId('root')).toBe('/');
  });

  it('otherwise validates the path exactly as assertWebdavPath does', () => {
    expect(webdavPathFromFolderId('/Documents')).toBe('/Documents');
    expect(() => webdavPathFromFolderId('../etc')).toThrow(ConnectorError);
  });
});

describe('listing a Nextcloud folder', () => {
  it('sends PROPFIND with Depth 1 and HTTP Basic auth, to the DAV-root path', async () => {
    const { fetchImpl, calls } = stub(() => ({ xml: multistatus([]) }));
    await listWebdavFolder(creds, { path: '/Documents' }, { fetchImpl });
    expect(calls[0].url).toBe('https://cloud.example.com/remote.php/dav/files/roman/Documents');
    expect(calls[0].init?.method).toBe('PROPFIND');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Depth).toBe('1');
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('roman:app-pw-secret').toString('base64')}`);
  });

  it('reduces the multistatus response to RemoteEntry, excluding the folder itself', async () => {
    const { fetchImpl } = stub(() => ({
      xml: multistatus([
        { href: '/remote.php/dav/files/roman/Documents/Reports/', folder: true, name: 'Reports' },
        {
          href: '/remote.php/dav/files/roman/Documents/notes.txt', size: 42,
          modified: 'Thu, 01 Jan 2026 00:00:00 GMT', name: 'notes.txt',
        },
      ]),
    }));
    const page = await listWebdavFolder(creds, { path: '/Documents' }, { fetchImpl });
    expect(page.entries).toHaveLength(2);
    const byName = Object.fromEntries(page.entries.map((e) => [e.name, e]));
    expect(byName.Reports.folder).toBe(true);
    expect(byName.Reports.sourceId).toBe('/Documents/Reports');
    expect(byName['notes.txt'].folder).toBe(false);
    expect(byName['notes.txt'].byteSize).toBe(42);
    expect(byName['notes.txt'].sourceId).toBe('/Documents/notes.txt');
    expect(byName['notes.txt'].modifiedAt).toBe(new Date('Thu, 01 Jan 2026 00:00:00 GMT').toISOString());
  });

  it('has no paging — WebDAV answers the whole folder in one response', async () => {
    const { fetchImpl } = stub(() => ({ xml: multistatus([]) }));
    const page = await listWebdavFolder(creds, { path: '/Documents' }, { fetchImpl });
    expect(page.nextPageCursor).toBeNull();
  });

  it('refuses a path with a traversal segment before it reaches a request', async () => {
    await expect(listWebdavFolder(creds, { path: '/../etc' }, {})).rejects.toBeInstanceOf(ConnectorError);
  });

  it('classifies a non-207 status as a failure with a category, not a thrown parse error', async () => {
    const { fetchImpl } = stub(() => ({ status: 401 }));
    const err = await listWebdavFolder(creds, { path: '/Documents' }, { fetchImpl })
      .then(() => null, (e) => e as ConnectorError);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err!.category).toBe('expired');
  });

  it('treats a network failure as the network category, not a crash', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const err = await listWebdavFolder(creds, { path: '/Documents' }, { fetchImpl })
      .then(() => null, (e) => e as ConnectorError);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err!.category).toBe('network');
  });
});

describe('downloading a Nextcloud file', () => {
  it('sends a plain GET with Basic auth to the DAV path', async () => {
    const { fetchImpl, calls } = stub(() => ({ bytes: Buffer.from('hello') }));
    await downloadWebdavFile(creds, {
      entry: { sourceId: '/Documents/notes.txt', name: 'notes.txt', folder: false, byteSize: 5, modifiedAt: null, exportMime: null, exportExtension: null, unreadable: false },
      maxBytes: 100,
    }, { fetchImpl });
    expect(calls[0].url).toBe('https://cloud.example.com/remote.php/dav/files/roman/Documents/notes.txt');
    expect(calls[0].init?.method).toBe('GET');
  });

  it('refuses bytes past the ceiling', async () => {
    const { fetchImpl } = stub(() => ({ bytes: Buffer.alloc(50) }));
    await expect(downloadWebdavFile(creds, {
      entry: { sourceId: '/big.bin', name: 'big.bin', folder: false, byteSize: 50, modifiedAt: null, exportMime: null, exportExtension: null, unreadable: false },
      maxBytes: 10,
    }, { fetchImpl })).rejects.toBeInstanceOf(FileTooLarge);
  });

  it('classifies a 403 as insufficient_scope', async () => {
    const { fetchImpl } = stub(() => ({ status: 403 }));
    const err = await downloadWebdavFile(creds, {
      entry: { sourceId: '/x.txt', name: 'x.txt', folder: false, byteSize: 1, modifiedAt: null, exportMime: null, exportExtension: null, unreadable: false },
      maxBytes: 10,
    }, { fetchImpl }).then(() => null, (e) => e as ConnectorError);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err!.category).toBe('insufficient_scope');
  });
});

describe('verifying credentials at connect time', () => {
  it('sends Depth 0 PROPFIND to the DAV root and reports ok on 207', async () => {
    const { fetchImpl, calls } = stub(() => ({ xml: multistatus([]) }));
    const result = await verifyWebdavCredentials(creds, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe('https://cloud.example.com/remote.php/dav/files/roman');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Depth).toBe('0');
  });

  it('reports the category rather than throwing when the server refuses', async () => {
    const { fetchImpl } = stub(() => ({ status: 401 }));
    const result = await verifyWebdavCredentials(creds, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('expired');
  });

  it('reports network when the server cannot be reached at all', async () => {
    const fetchImpl = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const result = await verifyWebdavCredentials(creds, { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe('network');
  });
});
