// AWS Signature Version 4, for Bedrock.
//
// Written here rather than pulled in as a dependency. The AWS SDK would bring a
// large transitive tree into an image that is meant to be auditable, and CE
// needs exactly one thing from it: sign a request with a static credential. The
// algorithm is a published specification and it is about ninety lines, so the
// tree is not worth it.
//
// The subtle part, and the reason this is its own file with its own tests: the
// canonical request encodes the path DIFFERENTLY from the request that is
// actually sent. Every service except S3 requires each path segment to be
// URI-encoded twice in the canonical form while the wire request carries it
// encoded once. Bedrock model ids contain a colon (`...-v2:0`), so the
// difference is not theoretical — get it wrong and every request to every
// Anthropic or Meta model on Bedrock fails with an opaque signature mismatch
// while the Amazon-hosted models, whose ids have no colon, keep working.
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Only for temporary credentials. Signed as `x-amz-security-token`. */
  sessionToken?: string | null;
}

export interface SignArgs {
  method: string;
  host: string;
  /** The path with each segment encoded ONCE, exactly as it will be sent. */
  path: string;
  /** Already-encoded query pairs, or empty. */
  query?: Record<string, string>;
  headers: Record<string, string>;
  body: string | Uint8Array;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Injected by the tests so a signature is reproducible. */
  now?: Date;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** RFC 3986 encoding, which is not what `encodeURIComponent` does.
 *
 * `encodeURIComponent` leaves `!`, `'`, `(`, `)` and `*` alone; AWS expects
 * them percent-encoded. Unreserved characters are `A-Z a-z 0-9 - _ . ~` and
 * nothing else. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The canonical form of a path: every segment encoded a SECOND time.
 *
 * The segments arrive already encoded once (that is what goes on the wire), so
 * this encodes the literal text of each segment again — `%3A` becomes `%253A`.
 * S3 is the documented exception to this rule and Bedrock is not S3. */
export function canonicalPath(path: string): string {
  return path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(query[key])}`)
    .join('&');
}

/** `20260908T120000Z` and `20260908`. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Signs a request and returns the headers to send with it. */
export function signRequest(args: SignArgs): SignedRequest {
  const now = args.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const query = args.query ?? {};

  // The signed set. `host` and `x-amz-date` are mandatory; the session token is
  // signed rather than merely sent, or a temporary credential is rejected.
  const headers: Record<string, string> = {
    ...args.headers,
    host: args.host,
    'x-amz-date': amzDate,
  };
  if (args.credentials.sessionToken) {
    headers['x-amz-security-token'] = args.credentials.sessionToken;
  }

  // Canonical headers: lowercase names, collapsed values, sorted by name.
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lookup = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names
    .map((n) => `${n}:${String(lookup.get(n) ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');

  const payloadHash = sha256Hex(args.body);
  const canonicalRequest = [
    args.method.toUpperCase(),
    canonicalPath(args.path),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${args.credentials.secretAccessKey}`, dateStamp), args.region), args.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const queryString = canonicalQuery(query);
  return {
    url: `https://${args.host}${args.path}${queryString ? `?${queryString}` : ''}`,
    headers: {
      ...headers,
      // `x-amz-content-sha256` is not required by Bedrock but is accepted, and
      // sending it makes a mismatch diagnosable from a request log.
      'x-amz-content-sha256': payloadHash,
      Authorization:
        `${ALGORITHM} Credential=${args.credentials.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
