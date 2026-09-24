// Mobile keyboard handling, the boring way.
//
// Round-2 item 25 taught the expensive lesson: a VisualViewport JS positioning
// layer (CSS variables, keyboard-open classes, window.scrollTo, per-keystroke
// re-layout) is itself the source of exactly the bugs it tries to fix — the
// login field twitching on focus, the Talk composer flying to the top of the
// screen, and re-render churn that read as the history reloading. All of that
// is gone. What remains:
//
//   * index.html declares `interactive-widget=resizes-content`, so browsers
//     that support it (Chrome/Android) resize the layout viewport themselves.
//   * Layouts use 100dvh / normal flex flow; iOS Safari pans the visual
//     viewport to keep a focused field visible, which is native and smooth.
//   * The ONE thing iOS occasionally gets wrong — a focused field left sitting
//     under the keyboard on a page with no scroll room — is corrected here:
//     a single debounced check after the keyboard animation settles, which
//     scrolls the field into view ONLY if it is actually hidden. No resize
//     listeners, no CSS variables, no repeated fights with Safari's own pan.
//
// Containers that manage their own scrolling (Talk) opt out with
// data-viewport-managed.

let initialised = false;

function isTextField(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** True when the element is fully inside the area the user can actually see
 * (the visual viewport — the part not covered by the iOS keyboard). */
function fullyVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const height = viewport?.height ?? window.innerHeight;
  return rect.top >= top && rect.bottom <= top + height;
}

export function initViewportTracking(): void {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;

  let pending = 0;
  window.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!isTextField(target)) return;
    if (target.closest('[data-viewport-managed]')) return;
    // One check per focus, after the keyboard animation settles. Re-focusing
    // (or iOS re-dispatching focus during its own pan) resets the timer rather
    // than stacking corrections — the double-fire was the ~3mm login jitter.
    window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      if (document.activeElement !== target) return;
      if (fullyVisible(target)) return; // Safari already handled it. Do nothing.
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 400);
  });
}
