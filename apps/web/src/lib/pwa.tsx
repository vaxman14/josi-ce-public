// Installing Josi to a home screen, and updating it afterwards.
//
// Two pieces of UX, and both are shaped by refusing to lie:
//
//   * The install prompt appears ONLY when the browser has actually offered
//     one. `beforeinstallprompt` does not fire on iOS Safari, on an already
//     installed app, or on a browser that has decided the site is not eligible
//     — and a button that says "Install" and does nothing is exactly the
//     placeholder-presented-as-working that M101 forbids.
//
//   * The update prompt never reloads on its own. A service worker that calls
//     skipWaiting() on install swaps the bundle under somebody mid-sentence in
//     Talk. The new worker waits; the person decides.
import { useCallback, useEffect, useState } from 'react';

/** The event Chromium fires when the app is installable. Not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'josi.install.dismissed';

/**
 * Registers the service worker and reports when a new one is waiting.
 *
 * Registration is deliberately not fatal: a browser with service workers
 * disabled, or an installation served over plain HTTP for local evaluation,
 * gets an app that works exactly as before with no offline shell. That is a
 * degraded PWA, not a broken product.
 */
export function useServiceWorker(): { updateReady: boolean; applyUpdate: () => void } {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let cancelled = false;
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((registration) => {
        if (cancelled) return;

        // Already waiting when the page loaded — the person updated in another
        // tab, or closed the app before deciding last time.
        if (registration.waiting) setWaiting(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // `controller` is null on the very first install. Prompting then
            // would say "a new version is ready" to somebody who just opened
            // the app for the first time.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setWaiting(installing);
            }
          });
        });
      })
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, []);

  const applyUpdate = useCallback(() => {
    if (!waiting) return;
    // One reload, driven by controllerchange rather than a timer, so the page
    // does not reload before the new worker has taken over.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    }, { once: true });
    waiting.postMessage('SKIP_WAITING');
  }, [waiting]);

  return { updateReady: waiting !== null, applyUpdate };
}

/** True only once the browser has offered an install. */
export function useInstallPrompt(): {
  available: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
} {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Suppressing the browser's own banner is the price of showing it inside
      // the app at a moment that makes sense.
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!event) return;
    await event.prompt();
    await event.userChoice;
    setEvent(null);
  }, [event]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    // Remembered, because asking again on every page load is nagging.
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* private mode */ }
  }, []);

  return { available: event !== null && !dismissed, install, dismiss };
}

/** The two prompts. Rendered inside the signed-in shell, so nothing offers to
 * install an app to somebody looking at a login form. */
export function PwaPrompts() {
  const { updateReady, applyUpdate } = useServiceWorker();
  const { available, install, dismiss } = useInstallPrompt();

  if (!updateReady && !available) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3
                 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-lg border border-border bg-secondary p-3 shadow-lg">
        {updateReady ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">A new version of Josi is ready.</p>
            <button
              type="button"
              onClick={applyUpdate}
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm
                         font-medium text-primary-foreground"
            >
              Reload
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">Add Josi to your home screen?</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={dismiss}
                className="inline-flex min-h-11 items-center rounded-md px-3 text-sm text-muted-foreground"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={() => void install()}
                className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm
                           font-medium text-primary-foreground"
              >
                Install
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
