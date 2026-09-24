// Loading something from the API, with every outcome named.
//
// This exists because of a specific bug. The Workspace page did:
//
//     api.get('/admin/workspace').then(setWorkspace).catch(() => undefined)
//
// and rendered "Loading…" whenever `workspace` was null. So every failure — a
// 500, a dropped connection, an expired session, a server that never answered —
// rendered as a page that was loading forever. The `.catch` that made it
// "handle" the error is what removed the last chance to say anything.
//
// A screen that cannot fail is a screen that cannot tell you it failed. The
// states below are the ones a person can act on, so each one is reachable and
// each one is rendered.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

export type ResourceState =
  | 'loading'
  | 'ready'          // loaded, and there is something to show
  | 'empty'          // loaded, and there is legitimately nothing
  | 'error'          // the server said no, or could not be reached
  | 'unauthorized'   // 401/403 — signing in again is the fix, not retrying
  | 'timeout';       // no answer within the budget

export interface Resource<T> {
  state: ResourceState;
  data: T | null;
  /** Safe to show a person. Never a stack trace. */
  message: string;
  /** Whether trying again could plausibly help. */
  retryable: boolean;
  reload: () => void;
}

export interface ResourceOptions<T> {
  /** Milliseconds before the attempt is abandoned. */
  timeoutMs?: number;
  /** Decides whether a successful response is `ready` or `empty`. */
  isEmpty?: (data: T) => boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** What happened when we asked. */
export type ResourceOutcome<T> =
  | { kind: 'loaded'; data: T; empty: boolean }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timedOut'; afterMs: number };

export interface ResourceVerdict {
  state: ResourceState;
  message: string;
  retryable: boolean;
}

/** The whole decision, as a pure function.
 *
 * Pulled out of the hook so it can be tested without a DOM, and so the set of
 * outcomes is somewhere a person can read in one go. The bug this file exists
 * for was a missing branch, and a missing branch is much easier to see here
 * than spread across a `.then` and a `.catch`. */
export function classifyResource<T>(outcome: ResourceOutcome<T>): ResourceVerdict {
  if (outcome.kind === 'timedOut') {
    return {
      state: 'timeout',
      message: `The server did not answer within ${Math.round(outcome.afterMs / 1000)} seconds.`,
      retryable: true,
    };
  }
  if (outcome.kind === 'loaded') {
    return { state: outcome.empty ? 'empty' : 'ready', message: '', retryable: false };
  }

  const err = outcome.error;
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return {
      state: 'unauthorized',
      // Retrying a 401 or a 403 fails again in exactly the same way. Offering
      // a "try again" button for them trains people to press it twice.
      retryable: false,
      message: err.status === 401
        ? 'Your session has ended. Sign in again to continue.'
        : 'Your account does not have access to this.',
    };
  }
  return {
    state: 'error',
    // The server writes its errors for people; pass one through rather than
    // inventing a friendlier sentence that says less.
    message: err instanceof Error ? err.message : 'Something went wrong loading this.',
    retryable: true,
  };
}

export function useResource<T>(path: string, options: ResourceOptions<T> = {}): Resource<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, isEmpty } = options;
  const [state, setState] = useState<ResourceState>('loading');
  const [data, setData] = useState<T | null>(null);
  const [message, setMessage] = useState('');
  const [retryable, setRetryable] = useState(false);

  // A reload that started before an earlier one finished must not have its
  // result overwritten by the slower attempt.
  const attempt = useRef(0);
  const emptyRef = useRef(isEmpty);
  emptyRef.current = isEmpty;

  const load = useCallback(() => {
    const mine = ++attempt.current;
    setState('loading');
    setMessage('');

    let settled = false;

    // One place decides, for every outcome. The hook's only job is to notice
    // which outcome happened and to ignore results from a superseded attempt.
    const apply = (outcome: ResourceOutcome<T>) => {
      if (settled || mine !== attempt.current) return;
      settled = true;
      clearTimeout(timer);
      const verdict = classifyResource(outcome);
      if (outcome.kind === 'loaded') setData(outcome.data);
      setState(verdict.state);
      setMessage(verdict.message);
      setRetryable(verdict.retryable);
    };

    const timer = setTimeout(() => apply({ kind: 'timedOut', afterMs: timeoutMs }), timeoutMs);

    void api
      .get<T>(path)
      .then((result) => apply({
        kind: 'loaded', data: result, empty: emptyRef.current?.(result) ?? false,
      }))
      .catch((error: unknown) => apply({ kind: 'failed', error }));
  }, [path, timeoutMs]);

  useEffect(() => {
    load();
    return () => { attempt.current++; };   // ignore anything still in flight
  }, [load]);

  return { state, data, message, retryable, reload: load };
}
