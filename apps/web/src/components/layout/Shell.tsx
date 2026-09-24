// The app shell: brand, navigation, and the frame every page renders inside.
//
// Mobile-first for real, not as a slogan. The layout starts at 320px — an
// iPhone SE — and grows; the sidebar appears at `lg` and below that navigation
// is a bottom bar, because a hamburger that covers the content is worse than a
// row of targets a thumb can actually reach.
//
// Nothing here is a permission check. The admin links are hidden from members
// because showing them would be noise, and every one of those routes is refused
// server-side regardless.
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { api, type LlmStatus } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PwaPrompts } from '@/lib/pwa';
import { Button } from '@/components/ui';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HELP_URL, LIVE_HELP_URL, LegalLinks } from '@/components/LegalLinks';
import { PHONE_MORE_LABELS, PHONE_PRIMARY_LABELS, routeMatches } from './mobileNavigation';

const MEMBER_NAV = [
  { to: '/app', label: 'Home', end: true },
  { to: '/app/talk', label: 'Talk' },
  { to: '/app/tasks', label: 'Tasks' },
  { to: '/app/approvals', label: 'Approvals' },
  { to: '/app/conversations', label: 'Conversations' },
  { to: '/app/calendar', label: 'Calendar' },
  { to: '/app/email/templates', label: 'Email / Templates' },
  { to: '/app/contacts', label: 'Contacts' },
  { to: '/app/connections', label: 'Connections' },
  { to: '/app/workspace', label: 'Local Workspace' },
  { to: '/app/workflows', label: 'Workflows' },
  { to: '/app/vault', label: 'Vault' },
  { to: '/app/usage', label: 'Usage' },
  { to: '/app/personalization', label: 'Personalization' },
  { to: '/app/channels', label: 'Channels' },
  { to: '/app/settings', label: 'Settings' },
  { to: '/app/apps', label: 'Apps' },
];

const FAMILY_NAV: { to: string; label: string; end?: boolean } = {
  to: '/app/family', label: 'Family (Coming Soon)',
};

const ADMIN_NAV = [
  { to: '/admin', label: 'Overview', end: true },
  // First for as long as it matters. An administrator who dismissed the
  // first-run redirect still has to be able to find the thing they dismissed.
  { to: '/admin/launch', label: 'Getting started' },
  { to: '/admin/people', label: 'People' },
  { to: '/admin/model', label: 'Model' },
  { to: '/admin/voice-box', label: 'Voice Box' },
  { to: '/admin/policy', label: 'Policy' },
  { to: '/admin/storage', label: 'Storage' },
  { to: '/admin/connectors', label: 'Connectors' },
  { to: '/admin/workflows', label: 'Workflows' },
  { to: '/admin/channels', label: 'Channels' },
  { to: '/admin/backups', label: 'Backups' },
  { to: '/admin/vault', label: 'Master Vault' },
  { to: '/admin/integrations', label: 'Integrations' },
  { to: '/admin/network', label: 'Network & address' },
  { to: '/admin/parental-controls', label: 'Parental controls (Coming Soon)' },
  { to: '/admin/workspace', label: 'Workspace' },
];

/** The four destinations a member reaches directly from the phone bar. */
const PHONE_NAV = MEMBER_NAV.filter((i) => PHONE_PRIMARY_LABELS.includes(i.label as (typeof PHONE_PRIMARY_LABELS)[number]));

/** Member destinations that remain available from the phone's More sheet. */
const PHONE_MORE_NAV = [
  ...PHONE_MORE_LABELS.slice(0, -1).map((label) => MEMBER_NAV.find((item) => item.label === label)),
  { ...FAMILY_NAV, label: 'Family' },
].filter((item): item is { to: string; label: string; end?: boolean } => item !== undefined);

function PhoneNavIcon({ label }: { label: string }) {
  const common = 'h-6 w-6';
  if (label === 'Home') return <svg aria-hidden viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></svg>;
  if (label === 'Talk') return <svg aria-hidden viewBox="0 0 24 24" className={common} fill="currentColor"><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2h9A3.5 3.5 0 0 1 20 5.5v7a3.5 3.5 0 0 1-3.5 3.5H10l-4.8 4a.75.75 0 0 1-1.2-.58V16.5A3.5 3.5 0 0 1 2 13.34V5.5Z" /></svg>;
  if (label === 'Calendar') return <svg aria-hidden viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>;
  if (label === 'Contacts') return <svg aria-hidden viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M17 8h4M17 12h4M17 16h3"/></svg>;
  return <svg aria-hidden viewBox="0 0 24 24" className={common} fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>;
}

export function Shell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [talkMenuOpen, setTalkMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const talkMenu = useRef<HTMLDivElement>(null);
  const moreDialog = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void api.get<LlmStatus>('/llm/status').then(setStatus).catch(() => setStatus(null));
  }, [location.pathname]);

  useEffect(() => setMoreOpen(false), [location.pathname]);

  useEffect(() => {
    if (!moreOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      const current = moreDialog.current?.querySelector<HTMLElement>('[aria-current="page"]');
      const first = moreDialog.current?.querySelector<HTMLElement>('a, button');
      (current ?? first)?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMoreOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(moreDialog.current?.querySelectorAll<HTMLElement>('a, button') ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      moreTrigger.current?.focus();
    };
  }, [moreOpen]);

  const isAdminArea = location.pathname.startsWith('/admin');
  const isTalk = location.pathname === '/app/talk';
  const memberNav = [...MEMBER_NAV, FAMILY_NAV];
  const nav = isAdminArea ? ADMIN_NAV : memberNav;

  return (
    <div className={`flex h-dvh w-full max-w-full flex-col overflow-hidden ${isTalk ? 'overflow-y-hidden' : ''}`}>
      <header className={`z-30 flex min-w-0 shrink-0 items-center gap-3 border-b border-border bg-card px-3 pt-[max(0.5rem,env(safe-area-inset-top))] ${isTalk ? 'h-[4.75rem] pb-2' : 'sticky top-0 py-2'}`}>
        <Link to="/app" className="flex min-h-11 min-w-0 shrink items-center gap-2" aria-label="Josi home">
          <img src="/brand/josi-mark.png" alt="" width={40} height={40} className={`${isTalk ? 'h-10 w-10 rounded-full' : 'h-8 w-8 rounded-lg'} shrink-0`} />
          <span className={`truncate font-semibold tracking-tight ${isTalk ? 'text-xl' : 'text-base'}`}>Josi</span>
        </Link>

        {/* M90: the Local-only badge is persistent and visible whenever the
            mode is on. It is read from the server on every navigation, never
            cached into something that could go stale and lie. */}
        {status?.localOnly ? (
          <span
            className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300"
            title="Only self-hosted models are permitted on this installation."
          >
            Local-only
          </span>
        ) : null}

        <div className="relative ml-auto flex shrink-0 items-center gap-1" ref={talkMenu}>
          <a
            href={HELP_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={`inline-flex min-h-11 items-center rounded-md px-3 font-medium hover:bg-secondary ${isTalk ? 'text-base' : 'text-sm'}`}
          >
            Help
          </a>
          <a href={LIVE_HELP_URL} target="_blank" rel="noreferrer noopener" className="hidden min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-secondary sm:inline-flex">Live Help chat</a>
          {user?.role === 'super_admin' ? (
            <Link
              to={isAdminArea ? '/app' : '/admin'}
              className={`inline-flex min-h-11 items-center rounded-md px-3 font-medium hover:bg-secondary ${isTalk ? 'text-base' : 'text-sm'}`}
            >
              {isAdminArea ? 'Workspace' : 'Admin'}
            </Link>
          ) : null}
          {isTalk ? (
            <>
              <Button variant="ghost" className="h-11 w-11 rounded-full px-0 text-2xl leading-none" aria-label="Conversation menu" onClick={() => setTalkMenuOpen((open) => !open)}>•••</Button>
              {talkMenuOpen ? <div className="absolute right-0 top-full z-50 w-40 rounded-xl border border-border bg-card p-1 shadow-xl"><button type="button" className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-secondary" onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}>Sign out</button></div> : null}
            </>
          ) : <Button variant="ghost" onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}>Sign out</Button>}
        </div>
      </header>

      <div className="flex min-h-0 w-full max-w-full flex-1 overflow-hidden">
        <nav
          aria-label="Main"
          className="hidden h-full w-56 shrink-0 overflow-y-auto overscroll-contain border-r border-border p-3 lg:block"
        >
          <ul className="space-y-1">
            {nav.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-11 items-center rounded-md px-3 text-sm font-medium',
                      isActive ? 'bg-primary/15 text-primary' : 'hover:bg-secondary',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* min-w-0 is what stops a long word or a wide table from pushing the
            whole page sideways. Without it flex children refuse to shrink. */}
        <main className={`min-h-0 w-full min-w-0 flex-1 overflow-y-auto overscroll-contain ${isTalk ? 'p-0 pb-[5.25rem] lg:p-5' : 'p-3 pb-24 sm:p-5 lg:pb-5'}`}>
          {/* Keyed on the path so a failure on one page does not wedge every
              page behind it. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex overflow-x-auto border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {(isAdminArea ? ADMIN_NAV : PHONE_NAV).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                // min-h-14 keeps the target well over 44px even with the label.
                'relative flex min-h-[4.75rem] flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium',
                isAdminArea && 'min-w-24 flex-none',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )
            }
          >
            {!isAdminArea ? <PhoneNavIcon label={item.label} /> : null}
            {item.label}
            {!isAdminArea ? <span className={`absolute bottom-1.5 h-1 w-8 rounded-full ${location.pathname === item.to ? 'bg-primary' : 'bg-transparent'}`} /> : null}
          </NavLink>
        ))}
        {!isAdminArea ? (
          <button
            ref={moreTrigger}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-controls="phone-more-navigation"
            aria-current={PHONE_MORE_NAV.some((item) => routeMatches(location.pathname, item.to)) ? 'page' : undefined}
            className={cn(
              'relative flex min-h-[4.75rem] flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium',
              PHONE_MORE_NAV.some((item) => routeMatches(location.pathname, item.to)) ? 'text-primary' : 'text-muted-foreground',
            )}
            onClick={() => setMoreOpen(true)}
          >
            <PhoneNavIcon label="More" />
            More
            <span className={`absolute bottom-1.5 h-1 w-8 rounded-full ${PHONE_MORE_NAV.some((item) => routeMatches(location.pathname, item.to)) ? 'bg-primary' : 'bg-transparent'}`} />
          </button>
        ) : null}
      </nav>

      {moreOpen && !isAdminArea ? (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/60 lg:hidden"
          onClick={(event) => {
            if (event.target === event.currentTarget) setMoreOpen(false);
          }}
        >
          <div
            id="phone-more-navigation"
            ref={moreDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-more-title"
            className="max-h-[min(80dvh,44rem)] w-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-card px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl"
          >
            <div className="mb-2 flex min-h-11 items-center justify-between gap-3 px-1">
              <h2 id="phone-more-title" className="text-lg font-semibold">More</h2>
              <button type="button" className="flex h-11 w-11 items-center justify-center rounded-full text-2xl hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary" aria-label="Close more navigation" onClick={() => setMoreOpen(false)}>×</button>
            </div>
            <nav aria-label="More destinations">
              <ul className="grid grid-cols-1 gap-1 min-[360px]:grid-cols-2">
                {PHONE_MORE_NAV.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) => cn('flex min-h-11 items-center rounded-lg px-3 text-sm font-medium', isActive ? 'bg-primary/15 text-primary' : 'hover:bg-secondary')}
                      onClick={() => setMoreOpen(false)}
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>
      ) : null}

      {/* Install and update prompts. Inside the signed-in shell on purpose:
          nothing offers to install an app to somebody looking at a login form,
          and an update prompt is only meaningful to somebody using the app. */}
      <PwaPrompts />
      <LegalLinks className="fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-2 z-20 hidden gap-3 rounded-md border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground shadow-sm lg:flex lg:bottom-2 [&_a]:underline" />
    </div>
  );
}
