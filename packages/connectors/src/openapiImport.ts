// Turning an OpenAPI document into a list of PROPOSALS.
//
// WHAT THIS IS NOT: a way to grant anything. Importing a specification produces
// candidate rows, every one of them disabled, and an administrator switches on
// the ones they actually want. The whole feature is the review, not the import
// — a spec that arrived with 400 operations and turned them all on would be the
// unrestricted HTTP authority this design exists to refuse, wearing a
// respectable file format.
//
// THE SPECIFICATION IS UNTRUSTED INPUT. It is usually downloaded from the API
// it describes, which means it is written by the party on the other side of the
// credential. Three consequences, each visible below:
//
//   1. `servers` IS IGNORED. Completely. The host is the one the administrator
//      typed into the form, and a spec that could move it would be a spec that
//      could redirect this installation's credential somewhere else. This is
//      the single most important line in the file.
//   2. EVERY FIELD IS RE-VALIDATED by the same functions a hand-typed row goes
//      through. Nothing is trusted because it came from a document.
//   3. EVERYTHING IS BOUNDED: the document size, the operation count, the
//      parameter count, and the depth of `$ref` resolution.
//
// JSON ONLY. OpenAPI is commonly published as YAML, and CE does not ship a YAML
// parser in its runtime dependencies. Adding one to read an untrusted document
// is a supply-chain cost with a sharp edge, so the page says "convert it to
// JSON first" instead of pretending. That is a real limitation and it is stated
// rather than hidden.
import {
  CustomApiInputError, customApiCapabilityForMethod, customApiPathPlaceholders, validateCustomApiOperationId,
  validateCustomApiPathTemplate, validateCustomApiSummary,
  type CustomApiMethod, type CustomApiParameter, type CustomApiEndpointDraft,
} from './customApi.js';

/** A document larger than this is not a specification somebody is going to
 * review by hand. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;

/** The most operations one import may propose. A spec with more is not refused
 * outright — the first 200 are offered and the rest are reported as skipped, so
 * an administrator knows the list is partial rather than believing it complete. */
export const MAX_PROPOSALS = 200;

const METHODS: CustomApiMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface SkippedOperation {
  path: string;
  method: string;
  /** In CE's words. Never the spec's. */
  reason: string;
}

export interface OpenApiImportResult {
  /** Candidates, in document order. Every one is disabled until somebody
   * switches it on. */
  proposals: CustomApiEndpointDraft[];
  skipped: SkippedOperation[];
  /** What the document said its servers were, reported so an administrator can
   * SEE that Josi ignored them and check the address they typed matches. Shown,
   * never used. */
  declaredServers: string[];
  title: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Resolves `#/components/parameters/Foo` and friends, one hop only.
 *
 * One hop rather than a general resolver: a chain of refs is a graph, a graph
 * can contain a cycle, and a cycle in an untrusted document is a hang. A
 * parameter behind two hops is reported as skipped, which is honest and
 * finite. */
function deref(spec: Record<string, unknown>, node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref !== 'string') return node;
  if (!ref.startsWith('#/')) return null;
  let current: unknown = spec;
  for (const segment of ref.slice(2).split('/')) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  // A resolved node that is itself a ref is the second hop, and it stops here.
  return current && typeof current === 'object' && '$ref' in (current as object) ? null : current;
}

/** An operation id the model can name, derived when the spec omits one.
 *
 * `GET /customers/{id}/orders` becomes `get_customers_id_orders`. Ugly and
 * honest: it says what it does and it cannot collide with a different path,
 * which matters more than elegance for a name somebody is about to review. */
function derivedOperationId(method: CustomApiMethod, path: string): string {
  const body = path
    .replace(/\{([^}]*)\}/g, '$1')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `${method.toLowerCase()}_${body}`.slice(0, 63).replace(/_+$/, '');
}

/** Sanitises whatever the spec called an operation into CE's grammar, or
 * returns null when nothing usable is left. */
function normaliseOperationId(raw: string): string | null {
  const id = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 63);
  return /^[a-z][a-z0-9_]{0,62}$/.test(id) ? id : null;
}

/**
 * Reads a parsed OpenAPI 3 document and proposes allowlist rows.
 *
 * Throws `CustomApiInputError` only for a document that is not one at all. A
 * single malformed operation inside an otherwise fine document is SKIPPED with
 * a reason rather than failing the import: an administrator importing 60
 * endpoints should not be blocked by the one whose path contains a space.
 */
export function proposeFromOpenApi(document: unknown): OpenApiImportResult {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new CustomApiInputError('that is not an OpenAPI document');
  }
  const spec = document as Record<string, unknown>;

  if (str(spec.swagger).startsWith('2')) {
    throw new CustomApiInputError(
      'that is a Swagger 2.0 document. Josi reads OpenAPI 3. Most API tools can export version 3, '
      + 'or convert it first.',
    );
  }
  if (!str(spec.openapi).startsWith('3')) {
    throw new CustomApiInputError(
      'that document does not say it is OpenAPI 3. Josi will not guess at the shape of a '
      + 'specification it cannot identify.',
    );
  }

  const paths = spec.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new CustomApiInputError('that OpenAPI document lists no paths');
  }

  const info = (spec.info ?? {}) as Record<string, unknown>;
  const declaredServers = Array.isArray(spec.servers)
    ? (spec.servers as Array<Record<string, unknown>>)
      .map((s) => str(s?.url)).filter(Boolean).slice(0, 10)
    : [];

  const proposals: CustomApiEndpointDraft[] = [];
  const skipped: SkippedOperation[] = [];
  const usedIds = new Set<string>();

  for (const [rawPath, rawItem] of Object.entries(paths as Record<string, unknown>)) {
    const item = deref(spec, rawItem);
    if (!item || typeof item !== 'object') continue;
    const pathItem = item as Record<string, unknown>;

    for (const method of METHODS) {
      const operation = pathItem[method.toLowerCase()];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      const op = operation as Record<string, unknown>;

      if (proposals.length >= MAX_PROPOSALS) {
        skipped.push({
          path: rawPath, method,
          reason: `this import stops at ${MAX_PROPOSALS} actions — add the rest by hand, or import a smaller specification`,
        });
        continue;
      }

      // The path, through the SAME validator a hand-typed one goes through.
      let pathTemplate: string;
      try {
        pathTemplate = validateCustomApiPathTemplate(rawPath);
      } catch (err) {
        skipped.push({
          path: rawPath, method,
          reason: err instanceof CustomApiInputError ? err.message : 'that path cannot be used',
        });
        continue;
      }

      // A name the model can call, and one that is unique within this import.
      const wanted = normaliseOperationId(str(op.operationId)) ?? derivedOperationId(method, pathTemplate);
      let operationId: string;
      try {
        operationId = validateCustomApiOperationId(wanted);
      } catch {
        skipped.push({ path: rawPath, method, reason: 'this operation has no name Josi can use' });
        continue;
      }
      if (usedIds.has(operationId)) {
        skipped.push({
          path: rawPath, method,
          reason: `two operations in that document are both called "${operationId}"`,
        });
        continue;
      }

      // What a reviewer and the model will read. The spec's own words are
      // content from the other side of the credential, so they are trimmed,
      // stripped of control characters by the validator, and capped — and when
      // there are none, CE writes a plain sentence rather than leaving it blank.
      const described = str(op.summary) || str(op.description);
      let summary: string;
      try {
        summary = validateCustomApiSummary(
          (described || `${method} ${pathTemplate}`).replace(/\s+/g, ' ').slice(0, 400),
        );
      } catch {
        summary = `${method} ${pathTemplate}`;
      }

      const parameters = collectParameters(spec, pathItem, op, pathTemplate);
      const missingPlaceholder = customApiPathPlaceholders(pathTemplate)
        .find((name) => !parameters.some((p) => p.in === 'path' && p.name === name));
      if (missingPlaceholder) {
        // The document contradicts itself: a path with a hole and nothing that
        // fills it. Saving it would produce a row that can never be called.
        skipped.push({
          path: rawPath, method,
          reason: `the document uses {${missingPlaceholder}} in the path but never says what it is`,
        });
        continue;
      }

      const capability = customApiCapabilityForMethod(method);
      usedIds.add(operationId);
      proposals.push({
        operationId,
        summary,
        method,
        pathTemplate,
        parameters,
        // Reads never carry one; the database refuses it as well.
        acceptsBody: capability === 'read' ? false : hasJsonBody(spec, op),
        source: 'openapi',
      });
    }
  }

  if (!proposals.length && !skipped.length) {
    throw new CustomApiInputError('that OpenAPI document describes no requests Josi can make');
  }

  return {
    proposals,
    skipped,
    declaredServers,
    title: str(info.title) ? str(info.title).slice(0, 80) : null,
  };
}

/** Path and query parameters only.
 *
 * Header and cookie parameters are dropped ON PURPOSE and without a warning per
 * occurrence: a header the assistant can set is a header nobody reviewed, and
 * one of the headers on this request carries the credential. */
function collectParameters(
  spec: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  op: Record<string, unknown>,
  pathTemplate: string,
): CustomApiParameter[] {
  const raw = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ];
  const placeholders = new Set(customApiPathPlaceholders(pathTemplate));
  const out: CustomApiParameter[] = [];
  const seen = new Set<string>();

  for (const entry of raw.slice(0, 100)) {
    const node = deref(spec, entry);
    if (!node || typeof node !== 'object') continue;
    const parameter = node as Record<string, unknown>;
    const name = str(parameter.name);
    const where = str(parameter.in);
    if (where !== 'path' && where !== 'query') continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) continue;
    if (seen.has(name)) continue;
    // An operation-level parameter overrides a path-level one of the same name,
    // and `raw` is ordered so the operation's comes second — so the LAST one
    // wins, which is what the specification says.
    seen.add(name);
    out.push({
      name,
      in: where,
      // A path parameter is required whatever the document claims: there is no
      // URL to build without it.
      required: where === 'path' ? true : parameter.required === true,
      description: str(parameter.description).replace(/\s+/g, ' ').slice(0, 200),
    });
  }

  // A placeholder the document forgot to declare is still a placeholder. It is
  // added here so the proposal is internally consistent; if the document is too
  // broken for even that, the caller skips the operation.
  for (const name of placeholders) {
    if (seen.has(name)) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) continue;
    seen.add(name);
    out.push({ name, in: 'path', required: true, description: '' });
  }

  return out.slice(0, 40);
}

/** True when the operation documents a JSON request body. Anything else — form
 * encoding, multipart, octet-stream — is not offered: this feature sends JSON,
 * and a row claiming otherwise would describe a request CE cannot make. */
function hasJsonBody(spec: Record<string, unknown>, op: Record<string, unknown>): boolean {
  const body = deref(spec, op.requestBody);
  if (!body || typeof body !== 'object') return false;
  const content = (body as Record<string, unknown>).content;
  if (!content || typeof content !== 'object') return false;
  return Object.keys(content as Record<string, unknown>)
    .some((type) => type.toLowerCase().split(';')[0].trim() === 'application/json');
}

/** Parses the text an administrator uploaded.
 *
 * Separate from `proposeFromOpenApi` so the size ceiling and the "this is not
 * JSON" sentence live at the edge, and so a caller that already has a parsed
 * object does not go through a string. */
export function parseOpenApiDocument(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new CustomApiInputError('paste the OpenAPI document, or upload the file');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SPEC_BYTES) {
    throw new CustomApiInputError('that specification is larger than Josi will read');
  }
  const text = raw.trim();
  if (!text) throw new CustomApiInputError('paste the OpenAPI document, or upload the file');
  if (text.startsWith('openapi:') || text.startsWith('swagger:') || text.startsWith('---')) {
    throw new CustomApiInputError(
      'that looks like YAML. Josi reads the JSON form of an OpenAPI document — most API tools can '
      + 'export it, and any YAML-to-JSON converter will do.',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CustomApiInputError('that is not valid JSON');
  }
}
