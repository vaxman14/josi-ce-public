// One thin database seam so CE runs identically on pglite (tests) and
// postgres.js (production). PostgreSQL only — there is no second dialect to
// keep happy, which is why this file is small.
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Pins all work to one connection and rolls it back on any failure. */
  transaction?<T>(work: (tx: Db) => Promise<T>): Promise<T>;
}

/** A value bound to a jsonb column.
 *
 * The two drivers want opposite things and neither complains when you get it
 * wrong. pglite wants a JSON *string* and parses it; postgres.js types a JS
 * string as text, so a pre-stringified payload reaches jsonb as a scalar string
 * — `'"{\"a\":1}"'` — not an object. That failure is silent in tests and
 * permanent in production.
 *
 * So call sites never serialize. They mark the value and each adapter does what
 * its own driver needs. */
export class JsonParam {
  constructor(readonly value: unknown) {}
}

/** Mark a value as destined for a jsonb column. Null/undefined become `{}`,
 * because every jsonb column in the schema is `not null default '{}'`. */
export function json(value: unknown): JsonParam {
  return new JsonParam(value ?? {});
}

/** Adapter for @electric-sql/pglite (tests). */
export function pgliteDb(pglite: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: <T>(work: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>) => Promise<T>;
}): Db {
  return {
    ...(pglite.transaction ? {
      transaction: <T>(work: (tx: Db) => Promise<T>) => pglite.transaction!(tx => work(pgliteDb(tx))),
    } : {}),
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await pglite.query(
        sql,
        params.map((p) => (p instanceof JsonParam ? JSON.stringify(p.value) : p)),
      );
      return res.rows as T[];
    },
  };
}

/** Adapter for porsager/postgres (production). Loosely typed on purpose:
 * postgres.js's generic rejects `unknown[]`, but every value bound here is a
 * JSON-serializable primitive. */
export function postgresDb(sql: unknown): Db {
  const client = sql as {
    unsafe: (q: string, params?: unknown[]) => Promise<unknown[]>;
    begin?: <T>(work: (tx: unknown) => Promise<T>) => Promise<T>;
  };
  return {
    ...(client.begin ? {
      transaction: <T>(work: (tx: Db) => Promise<T>) => client.begin!(tx => work(postgresDb(tx))),
    } : {}),
    async query<T>(q: string, params: unknown[] = []): Promise<T[]> {
      const bound = params.map((p) => {
        if (!(p instanceof JsonParam)) return p;
        // `unsafe(query, params)` serializes plain objects as JSON correctly.
        // `sql.json(value)` is a tagged-template helper; passing that wrapper
        // through `unsafe` stores its `{ value: ... }` internals instead.
        return p.value;
      });
      return (await client.unsafe(q, bound)) as T[];
    },
  };
}
