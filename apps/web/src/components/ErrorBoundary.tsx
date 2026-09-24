// A page that fails should say so.
//
// Without this, one component throwing during render unmounts the whole React
// tree and the browser shows a blank white area — which is indistinguishable
// from "still loading" and tells the person nothing. The Phase 6 browser suite
// found exactly that on the admin model page: `main` was empty, with no clue
// why.
//
// The message is deliberately plain and carries no stack trace: a stack in the
// UI is a leak, and it is useless to the person reading it. The detail goes to
// the console for whoever is debugging.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { failed: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('page failed to render', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto w-full min-w-0 max-w-3xl">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm font-semibold">This page could not be shown</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Something went wrong rendering it. Reloading may help; if it keeps happening, this is a bug in
            Josi rather than anything you did.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-secondary px-4 text-sm font-medium"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
