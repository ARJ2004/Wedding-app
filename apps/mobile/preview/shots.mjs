/**
 * Phone-size screenshots of the app (React Native Web preview) against the local API with seed
 * data. Usage: pnpm --filter @mehfil/mobile preview:shots   (API on :4000 and preview on :5173;
 * start them with `pnpm dev` in apps/api and `pnpm preview` here, or let this script start them).
 * Output: docs/screenshots/*.png
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../../docs/screenshots');
mkdirSync(out, { recursive: true });

const BASE = 'http://localhost:5173';
const up = async (url) => fetch(url).then((r) => r.ok).catch(() => false);
const children = [];
async function ensure(url, cmd, args, cwd) {
  if (await up(url)) return;
  children.push(spawn(cmd, args, { cwd, stdio: 'ignore', detached: false }));
  for (let i = 0; i < 60 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await up(url))) throw new Error(`${url} did not start`);
}
await ensure('http://localhost:4000/v1/health', 'pnpm', ['dev'], path.resolve(here, '../../api'));
await ensure(BASE, 'npx', ['vite', '--config', 'preview/vite.config.ts'], path.resolve(here, '..'));

const device = devices['iPhone 13'];
const browser = await chromium.launch();
const only = process.argv.slice(2);
const want = (name) => only.length === 0 || only.some((o) => name.startsWith(o));

async function session({ scheme = 'light', appearance = {}, email = 'owner@mehfil.local' } = {}) {
  const ctx = await browser.newContext({ ...device, colorScheme: scheme });
  await ctx.addInitScript((a) => window.localStorage.setItem('mehfil.appearance.v1', JSON.stringify(a)), {
    scheme: 'system',
    largeText: false,
    highContrast: false,
    palette: null,
    ...appearance,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (email) {
    await page.getByTestId('dev-email').fill(email);
    await page.getByTestId('dev-sign-in').click();
    await page.getByTestId('screen-host-home').or(page.getByTestId('screen-wedding-picker')).first().waitFor();
    await page.waitForTimeout(800);
  }
  return { ctx, page };
}

async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name);
}

async function tab(page, id, screen) {
  await page.getByTestId(id).click();
  await page.getByTestId(screen).waitFor();
  await page.waitForTimeout(600);
}

for (const scheme of ['light', 'dark']) {
  if (!want(`${scheme}-`)) continue;
  {
    const { ctx, page } = await session({ scheme, email: null });
    await page.getByTestId('screen-welcome').waitFor();
    await shot(page, `${scheme}-01-welcome`);
    await ctx.close();
  }
  const { ctx, page } = await session({ scheme });
  await shot(page, `${scheme}-02-host-home`);
  await tab(page, 'tab-events', 'screen-events');
  await shot(page, `${scheme}-03-events`);
  await tab(page, 'tab-guests', 'screen-guests');
  await shot(page, `${scheme}-04-guests`);
  await tab(page, 'tab-more', 'screen-more');
  await shot(page, `${scheme}-05-more-appearance`);
  await page.getByText('Switch wedding').click();
  await page.getByTestId('screen-wedding-picker').waitFor();
  await shot(page, `${scheme}-06-wedding-picker`);
  await page.getByTestId('create-wedding').click();
  await page.getByTestId('screen-create-wedding').waitFor();
  await shot(page, `${scheme}-07-create-wedding`);
  await ctx.close();
}

if (want('desk-')) {
  const { ctx, page } = await session({ email: 'desk@mehfil.local' });
  await tab(page, 'tab-guests', 'screen-guests');
  await shot(page, 'desk-01-guests-no-phones');
  await ctx.close();
}

if (want('large-')) {
  const { ctx, page } = await session({ appearance: { largeText: true } });
  await shot(page, 'large-01-host-home');
  await ctx.close();
}

if (want('palette-')) {
  for (const palette of ['maroonMarigold', 'mehendiGold', 'royalIndigoRose', 'peacockSaffron']) {
    for (const scheme of ['light', 'dark']) {
      const { ctx, page } = await session({ scheme, appearance: { palette } });
      await shot(page, `palette-${palette}-${scheme}`);
      await ctx.close();
    }
  }
}

if (want('groups-')) {
  const { ctx, page } = await session();
  await tab(page, 'tab-guests', 'screen-guests');
  await page.getByTestId('new-group').click();
  await page.getByTestId('group-name').fill('College friends');
  await shot(page, 'groups-01-new-group');
  await page.getByTestId('create-group').click();
  await page.getByText('College friends · 0').waitFor();
  await page.getByTestId('toggle-select').click();
  const rows = page.locator('[data-testid^="select-"]');
  await rows.nth(0).click();
  await rows.nth(2).click();
  await shot(page, 'groups-02-select');
  await page.getByTestId('assign-College friends').click();
  await page.getByText('College friends · 2').waitFor();
  await shot(page, 'groups-03-assigned');
  await ctx.close();
}

if (want('settings-')) {
  const cover = path.resolve(here, '../../../docs/samples/cover-sample.jpg');
  const { ctx, page } = await session();
  await tab(page, 'tab-more', 'screen-more');
  await page.getByTestId('open-wedding-settings').click();
  await page.getByTestId('screen-wedding-settings').waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('pick-cover').click();
  await (await chooser).setFiles(cover);
  await page.getByTestId('cover-image').waitFor({ timeout: 20000 });
  await page.getByTestId('shots-36').click();
  await page.waitForTimeout(800);
  await shot(page, 'settings-01-cover-camera');
  await page.getByTestId('wedding-palette-mehendiGold').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('contact-label').fill('Travel help');
  await page.getByTestId('contact-name').fill('Vikram (bride\'s brother)');
  await page.getByTestId('contact-phone').fill('98450 12345');
  await page.getByTestId('add-contact').click();
  await page.getByText('Vikram (bride\'s brother) · Travel help').first().waitFor();
  await page.getByTestId('contact-label').scrollIntoViewIfNeeded();
  await shot(page, 'settings-02-palette-contacts');
  await page.getByTestId('settings-done').click();
  await tab(page, 'tab-home', 'screen-host-home');
  await shot(page, 'settings-03-home-with-cover');
  // back to the default palette so later shots are unaffected
  await tab(page, 'tab-more', 'screen-more');
  await page.getByTestId('open-wedding-settings').click();
  await page.getByTestId('wedding-palette-maroonMarigold').click();
  await page.waitForTimeout(800);
  await ctx.close();
}

if (want('guest-')) {
  // A guest's journey from a WhatsApp link: pick yourself, code, notice, schedule, RSVP.
  const api = 'http://localhost:4000';
  const host = await (await fetch(`${api}/v1/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: 'dev:owner@mehfil.local', deviceId: 'shots-device-0000000001' }) })).json();
  const auth = { Authorization: `Bearer ${host.accessToken}` };
  const wid = host.user.weddings[0].id;
  const parties = (await (await fetch(`${api}/v1/weddings/${wid}/parties?limit=200`, { headers: auth })).json()).items;
  const fam = parties.filter((p) => p.members.length >= 3 && p.members[0].phoneStatus === 'valid');
  const party = fam[Math.floor(Date.now() / 60000) % fam.length]; // a different family each run (OTP hourly cap)
  const { url } = await (await fetch(`${api}/v1/weddings/${wid}/parties/${party.id}/link`, { headers: auth })).json();
  const token = url.split('/').pop();
  for (const scheme of ['light']) {
    const ctx = await browser.newContext({ ...device, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto(`${BASE}/g/${token}`, { waitUntil: 'networkidle' });
    await page.getByTestId('screen-guest-pick').waitFor();
    await shot(page, 'guest-01-who-are-you');
    await page.getByTestId(`pick-${party.members[0].fullName.split(' ')[0]}`).click();
    await page.getByTestId('screen-guest-otp').waitFor();
    await page.getByTestId('otp-code').fill('000000');
    await shot(page, 'guest-02-code');
    await page.getByTestId('otp-verify').click();
    await page.getByTestId('screen-consent').waitFor();
    await page.waitForTimeout(600);
    await shot(page, 'guest-03-privacy');
    await page.getByTestId('consent-accept').click();
    await page.getByTestId('screen-guest-home').waitFor();
    await page.waitForTimeout(1200);
    await shot(page, 'guest-04-home');
    await page.getByTestId('rsvp-cta').click();
    await page.getByTestId('screen-rsvp').waitFor();
    await page.waitForTimeout(600);
    await shot(page, 'guest-05a-rsvp-start');
    await page.getByTestId('rsvp-all-yes').click();
    await page.locator('[data-testid$="-maybe"]').nth(1).click();
    await shot(page, 'guest-05-rsvp');
    await page.getByTestId('rsvp-save').click();
    await page.getByText('Saved. Thank you!').waitFor();
    await page.getByTestId('gtab-home').click();
    await page.waitForTimeout(1200);
    await shot(page, 'guest-06-home-after-rsvp');

    // Venue with no signal: the home still shows, and an RSVP change is kept on the phone.
    await ctx.setOffline(true);
    await page.getByTestId('gtab-rsvp').click();
    await page.locator('[data-testid$="-declined"]').first().click();
    await page.getByTestId('rsvp-save').click();
    await page.getByTestId('rsvp-queued').waitFor();
    await shot(page, 'guest-07-offline-rsvp-queued');
    await page.getByTestId('gtab-home').click();
    await page.waitForTimeout(800);
    await shot(page, 'guest-08-offline-home');
    await ctx.setOffline(false);
    await page.waitForFunction(() => !document.querySelector('[data-testid="rsvp-queued"]') || true);
    await page.getByTestId('gtab-rsvp').click();
    await page.getByTestId('rsvp-queued').waitFor({ state: 'detached', timeout: 40_000 }); // outbox retries every 30 s
    await shot(page, 'guest-09-back-online-sent');
    await ctx.close();
  }
}

// Import flow last: it adds guests to the demo wedding.
if (want('import-')) {
  const sample = path.resolve(here, '../../../docs/samples/guest-list-sample.xlsx');
  const { ctx, page } = await session();
  await tab(page, 'tab-guests', 'screen-guests');
  await page.getByTestId('open-import').click();
  await page.getByTestId('screen-import').waitFor();
  await shot(page, 'import-01-start');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-pick').click();
  await (await chooser).setFiles(sample);
  await page.getByTestId('import-continue').waitFor({ timeout: 30000 });
  await shot(page, 'import-02-mapping');
  await page.getByTestId('import-continue').click();
  await page.getByTestId('import-commit').waitFor({ timeout: 30000 });
  await shot(page, 'import-03-preview');
  await page.getByTestId('import-commit').click();
  await page.getByTestId('import-done').waitFor({ timeout: 30000 });
  await shot(page, 'import-04-done');
  await page.getByTestId('import-back').click();
  await page.getByTestId('guest-search').fill('Suresh');
  await page.waitForTimeout(1200);
  await shot(page, 'import-05-guest-list');
  await ctx.close();
}

if (want('live-')) {
  // FND-14: host home follows the headcount channel over SSE; the badge shows once the stream is open.
  for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await session({ scheme });
    await page.getByTestId('tag-live').waitFor({ timeout: 15000 });
    await shot(page, `live-01-host-home-${scheme}`);
    await ctx.close();
  }
}

await browser.close();
for (const c of children) c.kill();
