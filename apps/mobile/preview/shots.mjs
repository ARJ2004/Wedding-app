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

await browser.close();
for (const c of children) c.kill();
