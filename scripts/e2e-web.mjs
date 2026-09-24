#!/usr/bin/env node
// Browser checks against a running CE stack.
//
// WebKit with touch emulation is the closest thing to Safari on an iPhone that
// runs unattended, which is the point: the engine's Talk composer was rewritten
// three times for a phone nobody could test against, and the fix that finally
// worked is a plain form submit. This suite exists so nobody "simplifies" it
// back into pointer handlers.
//
//   E2E_BASE=http://127.0.0.1:8396 node scripts/e2e-web.mjs
import { chromium, webkit } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8080';
const ADMIN = { id: process.env.E2E_ADMIN ?? 'owner', pw: process.env.E2E_ADMIN_PW ?? '' };
const MEMBER = { id: process.env.E2E_MEMBER ?? 'alice', pw: process.env.E2E_MEMBER_PW ?? '' };

// iPhone SE, iPhone 13 mini, iPhone 14/15, Pro Max.
const WIDTHS = [320, 375, 390, 430];
const MEMBER_PAGES = [
  '/app', '/app/talk', '/app/tasks', '/app/approvals', '/app/conversations',
  '/app/contacts', '/app/connections', '/app/usage', '/app/settings',
  '/app/channels', '/app/channels/telegram',
  '/app/apps',
];
const ADMIN_PAGES = [
  '/admin', '/admin/people', '/admin/model', '/admin/policy', '/admin/connectors',
  '/admin/telegram', '/admin/backups', '/admin/developer-services', '/admin/parental-controls', '/admin/workspace',
];

let pass = 0;
let fail = 0;
const record = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const step = (s) => console.log(`\n== ${s}`);

async function signIn(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#identifier', who.id);
  await page.fill('#password', who.pw);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname.startsWith('/app'), { timeout: 20000 });
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Collects what the page complained about.
 *
 * `pageerror` fires only for UNCAUGHT exceptions — once an ErrorBoundary
 * catches one, the only record is what it logged. So both are watched, or a
 * caught crash looks like a page that simply rendered nothing. */
function watch(page) {
  const problems = [];
  page.on('pageerror', (err) => {
    const text = String(err).split('\n')[0];
    // WebKit words a request cancelled by navigation as "cannot load … due to
    // access control checks", which reads like a policy refusal and is not one.
    // This suite walks ten pages back to back, so in-flight fetches are
    // cancelled constantly. Ignoring it would be hand-waving on its own, so
    // `testFetchesWork` below proves positively that same-origin fetches
    // succeed and that the data they return is rendered.
    if (/Fetch API cannot load .* due to access control checks/i.test(text)) return;
    problems.push(`uncaught: ${text.slice(0, 200)}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/favicon/i.test(text)) return;
    // A status the app asks for and handles is not a fault: /api/setup/state
    // answers 404 once setup is done, and /api/auth/me answers 401 before
    // sign-in. Both are the app negotiating, and filtering them keeps this
    // check about real exceptions rather than teaching everyone to ignore it.
    if (/Failed to load resource/i.test(text)) return;
    problems.push(`console: ${text.slice(0, 200)}`);
  });
  return problems;
}

// --------------------------------------------------------------- the send path
async function testTouchSend(browser) {
  step('Talk: a real tap on a touch-capable WebKit');
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);
    await page.goto(`${BASE}/app/talk`, { waitUntil: 'networkidle' });

    const composer = page.getByLabel('Message Josi');
    await composer.waitFor({ state: 'visible', timeout: 15000 });

    const send = page.getByRole('button', { name: 'Send message' });
    const box = await send.boundingBox();
    record(
      'the send button is at least 44x44',
      !!box && box.width >= 44 && box.height >= 44,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box',
    );

    // NOTE: no page.waitForFunction anywhere in this file. It evaluates a
    // string in the page, which needs 'unsafe-eval' — and this app's CSP
    // refuses it. That refusal is the policy working, so the suite works within
    // it using locator waits, which go through Playwright's own protocol.
    const mine = `tap test ${Date.now()}`;
    await composer.fill(mine);
    // A TAP, not a click. This is the whole reason WebKit + hasTouch is here.
    await send.tap();
    await page.getByText(mine, { exact: false }).first().waitFor({ timeout: 30000 });
    record('a TAP delivers the message', true);

    // And a reply came back, so the tap reached the network rather than only
    // painting the optimistic bubble. The stub model always answers "Noted."
    const reply = page.locator('section div.rounded-bl-md');
    await reply.first().waitFor({ timeout: 30000 })
      .then(() => record('Josi answered the tapped message', true))
      .catch(() => record('Josi answered the tapped message', false, 'no reply bubble'));

    // Enter must still send, for anyone on a keyboard.
    const second = `enter test ${Date.now()}`;
    await composer.fill(second);
    await composer.press('Enter');
    await page.getByText(second, { exact: false }).first().waitFor({ timeout: 30000 });
    record('Enter still sends', true);

    // The composer is above the fold, not under the home indicator.
    const footerBox = await page.locator('footer').boundingBox();
    const viewportHeight = page.viewportSize().height;
    record(
      'the composer sits inside the visible viewport',
      !!footerBox && footerBox.y + footerBox.height <= viewportHeight + 1,
      footerBox ? `bottom ${Math.round(footerBox.y + footerBox.height)} of ${viewportHeight}` : 'no box',
    );

    record('no horizontal scroll on Talk at 390px', (await overflow(page)) <= 0);

    // The engine shipped a temporary "Send probe" while chasing this bug.
    // Nothing like it may survive into CE.
    const probe = await page.getByText(/probe/i).count();
    record('no leftover debugging surface', probe === 0);
  } catch (err) {
    record('Talk touch send', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------- mobile layout
async function testWidths(browser) {
  step('Layout: nothing scrolls sideways on a phone');
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    try {
      await signIn(page, MEMBER);
      const bad = [];
      const blank = [];
      for (const path of MEMBER_PAGES) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
        const px = await overflow(page);
        if (px > 0) bad.push(`${path} +${px}px`);
        // A blank page has no overflow either.
        if ((await page.locator('main h1').count()) === 0) blank.push(path);
      }
      record(`no horizontal scroll on any page at ${width}px`, bad.length === 0, bad.join(', '));
      if (width === WIDTHS[0]) {
        record('every member page rendered its heading', blank.length === 0, blank.join(', '));
        record('no member page reported an error', problems.length === 0, problems.slice(0, 2).join(' | '));
      }
    } catch (err) {
      record(`layout at ${width}px`, false, String(err).split('\n')[0]);
    } finally {
      await ctx.close();
    }
  }
}

// --------------------------------------------------- the app's own fetches
/** Proves the page can call its own API and render what comes back.
 *
 * This exists because the only evidence otherwise was the ABSENCE of an error,
 * and WebKit's cancellation message made that evidence ambiguous. A created
 * task appearing on the home page is unambiguous: the fetch was allowed by the
 * CSP, it was authenticated by the cookie, and the result reached the DOM. */
async function testFetchesWork(browser) {
  step('The app can call its own API and show the result');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);

    // Created through the page's own origin, with its own cookie and CSRF
    // pair — the same path the UI uses.
    const created = await page.evaluate(async () => {
      const csrf = /(?:^|;\s*)josi_csrf=([^;]+)/.exec(document.cookie);
      const res = await fetch('/api/assistant/tasks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-josi-csrf': decodeURIComponent(csrf[1]) } : {}),
        },
        body: JSON.stringify({
          templateKey: 'follow_up',
          slots: { what: 'e2e-fetch-proof', when: 'today' },
        }),
      });
      return res.status;
    });
    record('a same-origin API call from the page succeeds', created === 201, `status ${created}`);

    await page.goto(`${BASE}/app/tasks`, { waitUntil: 'networkidle' });
    const shown = await page.getByText('e2e-fetch-proof').first().waitFor({ timeout: 15000 })
      .then(() => true).catch(() => false);
    record('what it created is fetched back and rendered', shown);

    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    const onHome = await page.getByText(/follow up/i).first().waitFor({ timeout: 15000 })
      .then(() => true).catch(() => false);
    record('the home page renders data it fetched', onHome);
  } catch (err) {
    record('app fetches', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------- tap targets
async function testTapTargets(browser) {
  step('Every control a thumb can reach is at least 44px tall');
  const ctx = await browser.newContext({ viewport: { width: 320, height: 780 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);
    const small = [];
    for (const path of MEMBER_PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      const offenders = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // not rendered
          if (r.height < 44) {
            out.push(`${el.tagName.toLowerCase()}"${(el.textContent ?? '').trim().slice(0, 24)}" ${Math.round(r.height)}px`);
          }
        }
        return out;
      });
      if (offenders.length) small.push(`${path}: ${offenders.join(', ')}`);
    }
    record('no control shorter than 44px at 320px', small.length === 0, small.slice(0, 3).join(' | '));
  } catch (err) {
    record('tap targets', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// -------------------------------------------------------------- keyboard
async function testKeyboard(browser) {
  step('The app is navigable from a keyboard');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);
    await page.goto(`${BASE}/app/tasks`, { waitUntil: 'networkidle' });

    // Tab reaches something focusable, and focus is visible rather than
    // suppressed by a blanket outline:none.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), outline: style.outlineStyle, shadow: style.boxShadow };
    });
    record('Tab moves focus to a control', !!focused, focused ? focused.tag : 'nothing focused');

    // Every form control has a label a screen reader can use.
    const unlabelled = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
        const id = el.getAttribute('id');
        const labelled = (id && document.querySelector(`label[for="${id}"]`))
          || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!labelled) out.push(el.getAttribute('name') ?? el.tagName.toLowerCase());
      }
      return out;
    });
    record('every field has a label', unlabelled.length === 0, unlabelled.join(', '));

    // Landmarks exist, so a screen reader has something to jump between.
    const landmarks = await page.evaluate(() => ({
      main: document.querySelectorAll('main').length,
      nav: document.querySelectorAll('nav[aria-label]').length,
      h1: document.querySelectorAll('h1').length,
    }));
    record(
      'the page has main, labelled nav and one h1',
      landmarks.main === 1 && landmarks.nav >= 1 && landmarks.h1 === 1,
      JSON.stringify(landmarks),
    );
  } catch (err) {
    record('keyboard', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------- nothing external, nothing fake
async function testNoExternalAndNoPlaceholders(browser) {
  step('Nothing is fetched from a third party, and nothing pretends to work');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const external = new Set();
  const cspViolations = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.origin !== new URL(BASE).origin && url.protocol !== 'data:') external.add(url.origin);
  });
  page.on('console', (msg) => {
    if (/content security policy/i.test(msg.text())) cspViolations.push(msg.text().slice(0, 120));
  });
  try {
    await signIn(page, MEMBER);
    for (const path of MEMBER_PAGES) await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });

    record('no request left this origin', external.size === 0, [...external].join(', '));
    record('no CSP violation was reported', cspViolations.length === 0, cspViolations[0] ?? '');

    const csp = await page.evaluate(async () => (await fetch('/app')).headers.get('content-security-policy'));
    record('the CSP header is served', !!csp && csp.includes("default-src 'self'"), csp ?? 'absent');

    // Companion apps: labelled, with nothing pressable that would lie.
    await page.goto(`${BASE}/app/apps`, { waitUntil: 'networkidle' });
    const comingSoon = await page.getByText(/coming soon/i).count();
    const actions = await page.locator('main button, main a[href]:not([href^="/app"]):not([href^="/admin"])').count();
    record('the companion apps page says Coming soon', comingSoon > 0);
    record('and offers no download or install action', actions === 0, `${actions} action(s)`);

    // Connections is real as of Phase 7, so the check changes shape: with no
    // OAuth application registered there must still be nothing to press, and
    // the page must say why rather than offering a button that fails at the
    // provider.
    await page.goto(`${BASE}/app/connections`, { waitUntil: 'networkidle' });
    const notBuilt = await page.locator('[data-not-built="true"]').count();
    const connectButton = await page.getByRole('button', { name: /^Connect / }).count();
    record('connections says the installation is not set up', notBuilt > 0);
    record('and offers no Connect button while that is true', connectButton === 0);

    // Nothing anywhere is a disabled control standing in for a feature.
    const disabledDecoys = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('main button[disabled], main [aria-disabled="true"]')) {
        out.push((el.textContent ?? '').trim().slice(0, 30));
      }
      return out;
    });
    record('no disabled control stands in for a feature', disabledDecoys.length === 0, disabledDecoys.join(', '));
  } catch (err) {
    record('external/placeholders', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------ role separation
async function testRoles(browser) {
  step('A member cannot reach the admin section');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);

    // The nav does not offer it...
    const adminLink = await page.locator('header a[href="/admin"]').count();
    record('the member header offers no admin link', adminLink === 0);

    // ...and asking for it directly lands back in the workspace.
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForURL((u) => u.pathname.startsWith('/app'), { timeout: 10000 }).catch(() => {});
    record('a member asking for /admin ends up in /app', new URL(page.url()).pathname.startsWith('/app'), page.url());

    // The redirect is convenience; this is the control.
    const status = await page.evaluate(async () => (await fetch('/api/admin/assistant')).status);
    record('the admin API refuses a member session', status === 403, `status ${status}`);
    await ctx.close();

    step('An administrator has both, and the admin pages behave');
    const adminCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const adminPage = await adminCtx.newPage();
    // A blank page is indistinguishable from a loading one unless the
    // exception is captured. Found the hard way: `main` was empty and the
    // suite could only report the emptiness, not the cause.
    const pageErrors = watch(adminPage);
    await signIn(adminPage, ADMIN);
    record('the admin header offers the admin section',
      (await adminPage.locator('header a[href="/admin"]').count()) > 0);

    const bad = [];
    const blank = [];
    for (const path of ADMIN_PAGES) {
      await adminPage.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      const px = await overflow(adminPage);
      if (px > 0) bad.push(`${path} +${px}px`);
      // A blank page has no overflow either, so the layout check above passes
      // vacuously unless something asserts the page rendered at all.
      const heading = await adminPage.locator('main h1').count();
      if (heading === 0) blank.push(path);
    }
    record('no horizontal scroll on any admin page at 390px', bad.length === 0, bad.join(', '));
    record('every admin page rendered its heading', blank.length === 0, blank.join(', '));

    // The model page must not offer a subscription option as available. The
    // page fetches before it can render them, so wait for the card rather than
    // counting whatever happened to be painted.
    await adminPage.goto(`${BASE}/admin/model`, { waitUntil: 'networkidle' });
    const card = adminPage.getByText(/Using a Claude or ChatGPT subscription/i);
    const appeared = await card.first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    if (!appeared) {
      const shown = (await adminPage.locator('main').innerText().catch(() => '')).slice(0, 160);
      record(
        'the model page rendered', false,
        `url=${adminPage.url()} main="${shown.replace(/\n+/g, ' / ')}" errors=[${pageErrors.join(' | ')}]`,
      );
    } else {
      record('the model page rendered', true);
    }
    record('nothing on an admin page reported an error', pageErrors.length === 0, pageErrors.join(' | '));
    // Phase 13.3: this is no longer "all three are unavailable". On a CE build
    // exactly one has a supported path and gets a real control; the other two
    // have none and get NO control at all — not a disabled button that looks
    // pressable. Both halves are asserted, because either one alone would pass
    // while the other was wrong.
    const unavailable = await adminPage.getByText(/unavailable/i).count();
    record('the options with no supported path are marked unavailable', unavailable >= 2,
      `${unavailable} marked`);
    record('the Anthropic entry cites the policy rather than promising a date',
      (await adminPage.getByText(/Claude Code and Claude\.ai/i).count()) > 0
      && (await adminPage.getByText(/coming soon/i).count()) === 0);
    const available = await adminPage.getByText(/\bavailable\b/).count();
    record('the ChatGPT/Codex entry is offered on a CE build', available > 0);
    record('and it says what it costs, in the product',
      (await adminPage.getByText(/per installation rather than per person/i).count()) > 0);
    record('and it says Josi never sees the login',
      (await adminPage.getByText(/never sees, stores or forwards your login/i).count()) > 0);
    const deadButtons = await adminPage.locator('button:disabled', { hasText: /subscription|claude|copilot/i }).count();
    record('an unavailable option has no control at all', deadButtons === 0);
    await adminCtx.close();
  } catch (err) {
    record('roles', false, String(err).split('\n')[0]);
  }
}


// ---------------------------------------------------------------------- PWA
//
// Split across two engines on purpose. The responsive and layout checks stay in
// WebKit, because Safari on an iPhone is where a self-hosted assistant actually
// gets installed. Service-worker REGISTRATION is checked in Chromium: WebKit's
// headless worker support in Playwright is unreliable enough that a failure
// there would say more about the harness than about the product, and a check
// that cannot distinguish those is worse than no check.
async function testPwaAssets(browser) {
  step('The PWA is installable');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });

    const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href');
    record('the shell links a manifest', manifestHref === '/manifest.webmanifest', String(manifestHref));
    record('and declares a theme colour',
      (await page.locator('meta[name=theme-color]').getAttribute('content')) === '#0b111e');
    record('and an apple-touch-icon, which is the only icon iOS reads',
      (await page.locator('link[rel=apple-touch-icon]').getAttribute('content').catch(() => null)) === null
        && (await page.locator('link[rel=apple-touch-icon]').getAttribute('href')) === '/icons/icon-192.png');

    const manifestRes = await page.request.get(`${BASE}/manifest.webmanifest`);
    record('the manifest is served', manifestRes.status() === 200, String(manifestRes.status()));
    record('with the manifest content type',
      (manifestRes.headers()['content-type'] ?? '').includes('application/manifest+json'),
      manifestRes.headers()['content-type'] ?? '');
    const manifest = await manifestRes.json().catch(() => null);
    record('and it parses as JSON with a start_url inside its scope',
      !!manifest && manifest.start_url === '/app' && manifest.scope === '/');

    let iconsOk = true;
    for (const icon of manifest?.icons ?? []) {
      const res = await page.request.get(`${BASE}${icon.src}`);
      if (res.status() !== 200) iconsOk = false;
    }
    record('every declared icon is served', iconsOk);
    record('one of them is maskable, or Android crops the mark',
      (manifest?.icons ?? []).some((i) => String(i.purpose).includes('maskable')));

    const sw = await page.request.get(`${BASE}/sw.js`);
    record('the service worker is served', sw.status() === 200);
    // A cached sw.js is a PINNED sw.js, and a pinned worker keeps its caching
    // rules forever — including a rule that turned out to be wrong.
    record('with no-store, so its rules can never be pinned',
      sw.headers()['cache-control'] === 'no-store', sw.headers()['cache-control'] ?? '');
    record('and Service-Worker-Allowed for the root scope',
      sw.headers()['service-worker-allowed'] === '/');

    const offline = await page.request.get(`${BASE}/offline.html`);
    const offlineText = await offline.text();
    record('the offline shell is served', offline.status() === 200);
    record('and it runs no script', !/<script/i.test(offlineText));
  } catch (err) {
    record('pwa assets', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

async function testServiceWorker() {
  step('The service worker caches assets and never the API');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);

    const controlled = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      return reg ? 'ready' : 'failed';
    });
    record('it registers and becomes ready', controlled === 'ready', controlled);

    // Give the worker a navigation to actually control, then confirm it does.
    await page.reload({ waitUntil: 'networkidle' });
    const hasController = await page.evaluate(() => !!navigator.serviceWorker.controller);
    record('and takes control of the page', hasController === true);

    const cachedBefore = await page.evaluate(async () => {
      const names = await caches.keys();
      const out = [];
      for (const name of names) {
        const keys = await (await caches.open(name)).keys();
        out.push(...keys.map((r) => new URL(r.url).pathname));
      }
      return out;
    });
    record('the offline shell is precached', cachedBefore.includes('/offline.html'), cachedBefore.join(' '));

    // THE ASSERTION THIS WHOLE FEATURE RESTS ON.
    await page.goto(`${BASE}/app/conversations`, { waitUntil: 'networkidle' });
    const cachedAfter = await page.evaluate(async () => {
      const names = await caches.keys();
      const out = [];
      for (const name of names) {
        const keys = await (await caches.open(name)).keys();
        out.push(...keys.map((r) => new URL(r.url).pathname));
      }
      return out;
    });
    const apiCached = cachedAfter.filter((p) => p.startsWith('/api'));
    record('NOTHING under /api was cached, after real signed-in navigation',
      apiCached.length === 0, apiCached.join(' '));
    record('the hashed bundle was cached', cachedAfter.some((p) => p.startsWith('/assets/')));

    // Offline: the shell, and no private data from a cache.
    await ctx.setOffline(true);
    await page.goto(`${BASE}/app/conversations`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    const text = await page.locator('body').innerText().catch(() => '');
    record('offline shows the offline shell', /Josi is offline/i.test(text), text.slice(0, 120));
    record('and it shows nothing about the signed-in person',
      !/alice/i.test(text) && !/conversation/i.test(text.replace(/Josi is offline/i, '')),
      text.slice(0, 120));

    const apiOffline = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/me');
        return `answered ${res.status}`;
      } catch {
        return 'failed';
      }
    });
    // If this ever says "answered 200" while offline, the worker is serving a
    // cached copy of somebody's account.
    record('an API call while offline FAILS rather than being answered from a cache',
      apiOffline === 'failed', apiOffline);

    await ctx.setOffline(false);
  } catch (err) {
    record('service worker', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

// --------------------------------------------------------- migration completion
async function testMigrationDone(browser) {
  step('Assistant migration: Done exits without touching the committed batch');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);
    await page.goto(`${BASE}/app/settings`, { waitUntil: 'networkidle' });
    const data = page.locator('details').filter({ hasText: 'Data & Backup' }).first();
    await data.locator('summary').click();
    await page.getByRole('button', { name: 'Migrate from another assistant' }).click();

    record('Done is absent before an import succeeds', await page.getByRole('button', { name: 'Done', exact: true }).count() === 0);
    const sentinel = 'Enjoys sailing';
    await page.getByLabel('Source assistant').selectOption('openclaw');
    await page.locator('#migration-files').setInputFiles({
      name: 'MEMORY.md', mimeType: 'text/markdown', buffer: Buffer.from(`- ${sentinel}`),
    });
    await page.getByRole('button', { name: 'Scan and preview' }).click();
    const candidate = page.getByRole('checkbox', { name: /Select MEMORY\.md/ }).first();
    await candidate.waitFor({ state: 'visible', timeout: 20000 });
    await candidate.check();
    await page.getByRole('button', { name: /Review 1 selected item/ }).click();
    await page.getByRole('button', { name: /Import 1 reviewed item/ }).waitFor({ state: 'visible' });
    record('Done remains absent on the final dry run', await page.getByRole('button', { name: 'Done', exact: true }).count() === 0);
    await page.getByRole('button', { name: /Import 1 reviewed item/ }).click();
    await page.getByText(/Import completed\. 1 new rows? saved\./).waitFor({ state: 'visible', timeout: 20000 });

    const done = page.getByRole('button', { name: 'Done', exact: true });
    const download = page.getByRole('button', { name: 'Download receipt', exact: true });
    const another = page.getByRole('button', { name: 'Start another migration', exact: true });
    record('Done appears after a successful import', await done.isVisible());
    record('Done is the primary receipt action', (await done.getAttribute('class') ?? '').includes('bg-primary'));
    record('receipt download remains a secondary action', await download.isVisible() && (await download.getAttribute('class') ?? '').includes('bg-secondary'));
    record('Start another migration remains a secondary action', await another.isVisible() && (await another.getAttribute('class') ?? '').includes('bg-secondary'));

    const batchText = await page.getByText(/^Batch:/).innerText();
    const batchId = batchText.replace(/^Batch:\s*/, '');
    const before = await page.evaluate(async (id) => {
      const response = await fetch(`/api/migrations/batches/${id}`, { credentials: 'same-origin', cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    }, batchId);
    await done.click();
    record('Done collapses the Data & Backup disclosure', await data.evaluate((node) => !node.open));
    await data.locator('summary').click();
    await page.getByRole('button', { name: 'Migrate from another assistant' }).waitFor({ state: 'visible' });
    record('Done exits and resets the completed receipt screen', await page.getByText(/Import completed\./).count() === 0 && await done.count() === 0);
    const after = await page.evaluate(async (id) => {
      const response = await fetch(`/api/migrations/batches/${id}`, { credentials: 'same-origin', cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    }, batchId);
    record('Done does not alter or delete the committed batch', before.status === 200 && JSON.stringify(after) === JSON.stringify(before));
  } catch (err) {
    const screen = await page.locator('body').innerText().catch(() => 'screen unavailable');
    record('migration Done flow', false, `${String(err).split('\n')[0]} | ${screen.replace(/\s+/g, ' ').slice(-1200)}`);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------------ branding
async function testBranding(browser) {
  step('The Josi identity is present');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    const wordmark = page.locator('img[src="/brand/josi-wordmark.png"]');
    record('the wordmark is on the sign-in screen', (await wordmark.count()) > 0);
    const loaded = await wordmark.first().evaluate((img) => img.naturalWidth > 0).catch(() => false);
    record('and it actually loaded', loaded === true);
    record('the product line is shown', (await page.getByText(/on your own server/i).count()) > 0);
    record('the publisher is named', (await page.getByText(/SOCAL RECEPTIONIST LLC/i).count()) > 0);

    await signIn(page, MEMBER);
    const mark = page.locator('header img[src="/brand/josi-mark.png"]');
    record('the J mark is in the header', (await mark.count()) > 0);
  } catch (err) {
    record('branding', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// E2E_ONLY lets one group be run on its own.
//
// Added because WebKit's Playwright build would not finish installing in one
// environment while Chromium's was already present, and the service-worker
// checks — the most important thing Phase 13.2 has to prove — run in Chromium
// by design. Half a browser suite that actually ran beats a whole one that did
// not, PROVIDED the half that did not run is reported as not run rather than
// omitted. `ONLY` is echoed in the summary for exactly that reason.
const ONLY = process.env.E2E_ONLY ?? '';
const wants = (name) => !ONLY || ONLY.split(',').includes(name);

if (wants('webkit')) {
const browser = await webkit.launch();
try {
  await testTouchSend(browser);
  await testWidths(browser);
  await testFetchesWork(browser);
  await testTapTargets(browser);
  await testKeyboard(browser);
  await testNoExternalAndNoPlaceholders(browser);
  await testRoles(browser);
  await testBranding(browser);
  await testPwaAssets(browser);
} finally {
  await browser.close();
}
} else {
  console.log('\n(skipping the WebKit group: E2E_ONLY=' + ONLY + ')');
}

if (wants('migration')) {
  const migrationBrowser = await chromium.launch();
  try {
    await testMigrationDone(migrationBrowser);
  } finally {
    await migrationBrowser.close();
  }
} else {
  console.log('\n(skipping the migration group: E2E_ONLY=' + ONLY + ')');
}

// Chromium, in its own browser, for the one thing WebKit headless cannot be
// trusted to report.
if (wants('serviceworker')) {
  await testServiceWorker();
} else {
  console.log('\n(skipping the service-worker group: E2E_ONLY=' + ONLY + ')');
}

if (ONLY) console.log(`\nRAN ONLY: ${ONLY} — the other groups did NOT run.`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
