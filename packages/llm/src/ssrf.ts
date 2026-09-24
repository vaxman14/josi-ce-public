// Guarding the operator-supplied base URL.
//
// THE THREAT MODEL, because the usual SSRF rule would break the feature.
//
// A generic SSRF defence blocks loopback and private ranges. Here that would
// forbid exactly the thing the feature exists for: Ollama on 127.0.0.1:11434,
// vLLM on a LAN box, LM Studio on the operator's desktop, a `ollama` service
// name on the Docker network. Applying the textbook rule would leave
// `openai_compatible` supporting nothing at all.
//
// So look at who can actually set this value. Only the super admin, during
// setup or from the admin surface. That is a person who already administers the
// host — they do not need an SSRF bug to reach their own LAN. The classic
// threat (an untrusted user makes the server fetch internal resources) is not
// present.
//
// What IS still dangerous, even from an admin-supplied URL:
//
//   1. Cloud metadata. 169.254.169.254 and friends hand out IAM credentials.
//      An operator who fat-fingers a URL, or copies one from a forum post,
//      should not be able to exfiltrate their cloud account's role. Always
//      blocked, on every hop.
//   2. Redirects. A perfectly ordinary public URL that answers 302 to the
//      metadata endpoint defeats any validation done on the URL alone. Never
//      followed.
//   3. DNS rebinding. A hostname that resolves to something benign when
//      validated and something else when used. Addresses are therefore checked
//      at REQUEST time, not only at save time.
//
// This is a deliberate departure from the phase plan's wording ("block
// link-local/loopback"), recorded in PHASE_4_EVIDENCE.md rather than applied
// quietly.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeEndpointError extends Error {}

/** Address ranges refused wherever they appear, including after DNS
 * resolution. Cloud metadata first, because it is the one that turns a
 * misconfiguration into a compromised cloud account. */
const BLOCKED_V4 = [
  // Link-local, which is where every cloud metadata service lives:
  // AWS/GCP/Azure/DO/Oracle all use 169.254.169.254.
  { base: '169.254.0.0', bits: 16, why: 'link-local / cloud metadata' },
  // "This host on this network". 0.0.0.0 is routable to localhost on Linux.
  { base: '0.0.0.0', bits: 8, why: 'unspecified address' },
  // Multicast and reserved. Nothing serves an API here.
  { base: '224.0.0.0', bits: 4, why: 'multicast' },
  { base: '240.0.0.0', bits: 4, why: 'reserved' },
] as const;

const BLOCKED_V6_PREFIXES = [
  { prefix: 'fe80', why: 'link-local' },
  { prefix: 'ff', why: 'multicast' },
  // Alibaba/Oracle style metadata over v6.
  { prefix: 'fd00:ec2', why: 'cloud metadata' },
] as const;

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

/** The IPv4 address inside a v4-mapped or v4-compatible IPv6 literal, in either
 * spelling, or null.
 *
 * Both `::ffff:169.254.169.254` and `::ffff:a9fe:a9fe` denote the same address,
 * and a checker that understands only one of them understands neither.
 */
function embeddedV4(address: string): string | null {
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) return dotted[1];

  // `::ffff:a9fe:a9fe` and the v4-compatible `::a9fe:a9fe`.
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  // `::1` is loopback, not 0.0.0.1 — a single trailing group is not an
  // embedded address and must not be reinterpreted as one.
  if (address === '::1') return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** Why this address is refused, or null when it is acceptable. */

export function blockedReason(address: string): string | null {
  const family = isIP(address);

  if (family === 4) {
    const value = v4ToInt(address);
    if (value === null) return 'unparseable address';
    for (const { base, bits, why } of BLOCKED_V4) {
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      const baseValue = v4ToInt(base);
      if (baseValue !== null && (value & mask) === (baseValue & mask)) return why;
    }
    return null;
  }

  if (family === 6) {
    const normalised = address.toLowerCase().replace(/^\[|\]$/g, '');

    // An IPv4 address embedded in a v6 literal, in EITHER spelling.
    //
    // `::ffff:169.254.169.254` is the one people write, and the one an earlier
    // version of this checked for. But `new URL()` canonicalises it to
    // `::ffff:a9fe:a9fe` — the same address in hex — and that spelling sailed
    // straight past the dotted-form regex. A runtime check on a real server
    // found it: the metadata endpoint was reachable through the mapped literal
    // while every unit test passed.
    const embedded = embeddedV4(normalised);
    if (embedded) return blockedReason(embedded);

    for (const { prefix, why } of BLOCKED_V6_PREFIXES) {
      if (normalised.startsWith(prefix)) return why;
    }
    return null;
  }

  return 'not an IP address';
}

export interface ValidatedEndpoint {
  url: URL;
  /** Addresses the hostname resolved to at validation time. */
  addresses: string[];
  /** True when the endpoint is on this machine or this network. Not a refusal
   * — self-hosted inference is supposed to be here — but the caller records it
   * so Local-only mode can reason about it. */
  isLocal: boolean;
}

const PRIVATE_V4 = [
  { base: '127.0.0.0', bits: 8 },
  { base: '10.0.0.0', bits: 8 },
  { base: '172.16.0.0', bits: 12 },
  { base: '192.168.0.0', bits: 16 },
] as const;

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = v4ToInt(address);
    if (value === null) return false;
    return PRIVATE_V4.some(({ base, bits }) => {
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      const baseValue = v4ToInt(base)!;
      return (value & mask) === (baseValue & mask);
    });
  }
  const n = address.toLowerCase();
  // ::1 loopback, fc00::/7 unique-local.
  return n === '::1' || n.startsWith('fc') || n.startsWith('fd');
}

export interface ValidateOptions {
  /** Injected in tests so DNS is never touched. */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** Validates a base URL and resolves it. Throws UnsafeEndpointError with a
 * message an operator can act on. */
export async function validateEndpoint(
  raw: string,
  opts: ValidateOptions = {},
): Promise<ValidatedEndpoint> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeEndpointError('that is not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeEndpointError('the endpoint must be http or https');
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs and error messages.
    throw new UnsafeEndpointError('put credentials in the API key field, not in the URL');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];

  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (opts.resolve ?? defaultResolve)(hostname);
    } catch {
      throw new UnsafeEndpointError('that hostname could not be resolved from this server');
    }
    if (!addresses.length) throw new UnsafeEndpointError('that hostname resolved to no addresses');
  }

  // EVERY resolved address must be acceptable. A hostname with one good and one
  // metadata address is a rebinding attempt, not a lucky draw.
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason) {
      throw new UnsafeEndpointError(`that address is not allowed (${reason})`);
    }
  }

  return { url, addresses, isLocal: addresses.every(isPrivateAddress) };
}

export interface SafeFetchOptions extends ValidateOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A fetch that re-validates at request time and refuses redirects.
 *
 * `redirect: 'manual'` is the important half: validating a URL and then letting
 * the client follow a 302 wherever it likes checks the wrong thing. */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  // Re-resolved here rather than trusting a validation done when the row was
  // saved: DNS can change in between, deliberately or otherwise.
  await validateEndpoint(rawUrl, opts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(rawUrl, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      throw new UnsafeEndpointError(
        'that endpoint redirected, which is not followed — point the base URL directly at the API',
      );
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
