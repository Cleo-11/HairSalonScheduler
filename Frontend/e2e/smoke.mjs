// End-to-end smoke test: drives the real frontend against the real backend.
// Needs both running (backend on :3000 with the demo seed, frontend on :3001)
// and the backend log file to read the dev OTP from.
//   node e2e/smoke.mjs <path-to-backend-log>
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const LOG = process.argv[2];
const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const phone = '98' + String(Date.now()).slice(-8);
const errors = [];
const step = (m) => console.log('•', m);

function otpFor(p) {
  const matches = [...readFileSync(LOG, 'utf8').matchAll(new RegExp(`\\+91${p}: your code is (\\d{6})`, 'g'))];
  return matches.at(-1)?.[1];
}
async function waitForOtp(p) {
  for (let i = 0; i < 50; i++) {
    const c = otpFor(p);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('OTP not found in backend log');
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const watch = (page, who) => {
  page.on('console', (m) => m.type() === 'error' && !/tile\.openstreetmap|ERR_|Failed to load resource/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
};

// ---------------------------------------------------------------- customer
const phoneCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  geolocation: { latitude: 19.055, longitude: 72.8345 },
  permissions: ['geolocation'],
});
const c = await phoneCtx.newPage();
watch(c, 'customer');

step('customer: sign in');
await c.goto(WEB + '/');
await c.waitForURL('**/login**', { waitUntil: 'commit' });
await c.screenshot({ path: SHOTS + '01-login.png' });
await c.getByLabel('Mobile number').fill(phone);
await c.getByRole('button', { name: /send code/i }).click();
await c.getByLabel('6-digit code').waitFor();
await c.screenshot({ path: SHOTS + '02-code.png' });
await c.getByLabel('6-digit code').fill(await waitForOtp(phone));

step('customer: name');
await c.waitForURL('**/name**', { waitUntil: 'commit' });
await c.getByLabel('Your name').fill('Cleon');
await c.screenshot({ path: SHOTS + '03-name.png' });
await c.getByRole('button', { name: 'Continue' }).click();

step('customer: salon');
await c.waitForURL('**/salons', { waitUntil: 'commit' });
await c.getByText('Demo Salon, Bandra').first().waitFor();
await c.waitForTimeout(500);
await c.screenshot({ path: SHOTS + '04-salons.png' });
await c.getByRole('button', { name: /continue with/i }).click();

step('customer: services');
await c.waitForURL('**/s/demo-salon-bandra', { waitUntil: 'commit' });
await c.getByRole('button', { name: /Men's haircut/ }).click();
await c.getByRole('button', { name: /Beard trim/ }).click();
await c.screenshot({ path: SHOTS + '05-services.png' });
await c.getByRole('button', { name: 'Continue' }).click();

step('customer: stylist');
await c.waitForURL('**/stylist**', { waitUntil: 'commit' });
await c.getByText('Assign me a stylist').waitFor();
const rahulCard = c.getByRole('button', { name: /Rahul/ });
await rahulCard.waitFor();
await rahulCard.click();
await c.screenshot({ path: SHOTS + '06-stylist.png' });
await c.getByRole('button', { name: 'Join E Walk-In' }).click();

step('customer: queue status');
await c.waitForURL('**/queue/**', { waitUntil: 'commit' });
await c.getByText(/ahead of you|You're next/).waitFor();
await c.getByText('Live').waitFor({ timeout: 10000 });
await c.screenshot({ path: SHOTS + '07-queue-waiting.png' });
const entryUrl = c.url();

// ---------------------------------------------------------------- desk
const tabletCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const d = await tabletCtx.newPage();
watch(d, 'desk');

step('desk: sign in');
await d.goto(WEB + '/staff/login');
await d.getByLabel('Email').fill('desk@demo-salon.test');
await d.getByLabel('Password').fill('salon-demo-1234');
await d.getByRole('button', { name: 'Sign in' }).click();
await d.waitForURL('**/dashboard/demo-salon-bandra', { waitUntil: 'commit' });
await d.getByText('Cleon').waitFor();
await d.getByText('Live').waitFor({ timeout: 10000 });
await d.screenshot({ path: SHOTS + '10-dashboard.png' });

step('desk: E Walk-In shows on the board, with a switch for the salon and for each stylist');
await d.getByText(/E Walk-In on · \d+ in line/).waitFor();
const cleonCard = d.locator('div.rounded-2xl', { hasText: 'Cleon' }).filter({ has: d.getByRole('button', { name: 'Call' }) }).last();
await cleonCard.getByText('E Walk-In', { exact: true }).waitFor();
await d.getByRole('button', { name: /^E Walk-In \(\d+\)$/ }).click();
await d.getByText('Cleon').first().waitFor();
await d.screenshot({ path: SHOTS + '10b-dashboard-e-walk-in-filter.png' });
await d.getByRole('button', { name: /^All \(\d+\)$/ }).click();

const c2 = await phoneCtx.newPage();
watch(c2, 'customer-2');
const WOMENS = '00000000-0000-4000-8000-000000000102';

await d.getByLabel('E Walk-In', { exact: true }).click();
await d.getByText('E Walk-In is off. Customers already in line keep their place').waitFor();
await d.getByText('E Walk-In off', { exact: true }).waitFor();
await d.screenshot({ path: SHOTS + '10c-dashboard-e-walk-in-off.png' });
await c2.goto(WEB + '/s/demo-salon-bandra');
await c2.getByText('E Walk-In is switched off right now').waitFor();
await c2.screenshot({ path: SHOTS + '06b-customer-e-walk-in-off.png' });
await d.getByLabel('E Walk-In', { exact: true }).click();
await d.getByText('E Walk-In is on', { exact: true }).waitFor();

const farahBoard = d.locator('div.rounded-2xl', { hasText: 'Farah' }).filter({ has: d.getByLabel(/Takes E Walk-In/) }).first();
await farahBoard.getByLabel(/Takes E Walk-In/).click();
await d.getByText('Farah: out of E Walk-In').waitFor();
await d.getByText('Not taking E Walk-In').waitFor();
await c2.goto(WEB + '/s/demo-salon-bandra/stylist?services=' + WOMENS);
await c2.getByText('Not taking E Walk-In clients right now').waitFor();
await c2.screenshot({ path: SHOTS + '06c-customer-stylist-out-of-pool.png', fullPage: true });
await farahBoard.getByLabel(/Takes E Walk-In/).click();
await d.getByText('Farah: taking E Walk-In clients').waitFor();
await c2.close();

step('desk: add a walk-in');
await d.getByRole('button', { name: '+ Add walk-in' }).click();
await d.getByLabel('Name').fill('Sameer');
await d.getByRole('button', { name: /Head massage/ }).click();
await d.getByText('Any available').waitFor();
await d.screenshot({ path: SHOTS + '11-walk-in.png' });
await d.getByRole('button', { name: 'Add to queue' }).click();
await d.getByText('Sameer added to the queue').waitFor();

// Rahul is busy with Arjun (demo seed). Finish Arjun so Rahul can call Cleon.
step('desk: finish Arjun, call Cleon');
const arjun = d.locator('div.rounded-2xl', { hasText: 'Arjun' }).filter({ has: d.getByRole('button', { name: 'Finish' }) }).last();
await arjun.getByRole('button', { name: 'Finish' }).click();
await d.getByText('Arjun done').waitFor();
const cleonRow = d.locator('div.rounded-2xl', { hasText: 'Cleon' }).filter({ has: d.getByRole('button', { name: 'Call' }) }).last();
await cleonRow.getByRole('button', { name: 'Call' }).click();
await d.getByText('Called Cleon').waitFor();
await d.waitForTimeout(300);
await d.screenshot({ path: SHOTS + '12-dashboard-called.png' });

step('customer sees "called" live (no reload)');
await c.getByText('Rahul is ready for you').waitFor({ timeout: 8000 });
await c.screenshot({ path: SHOTS + '08-queue-called.png' });

step('desk: start and extend');
await d.locator('div.rounded-2xl', { hasText: 'Cleon' }).getByRole('button', { name: 'Start' }).last().click();
await d.getByText('Cleon in the chair').waitFor();
await d.locator('div.rounded-2xl', { hasText: 'Cleon' }).getByRole('button', { name: '+5' }).last().click();
await c.getByText("You're in the chair").waitFor({ timeout: 8000 });
await c.screenshot({ path: SHOTS + '09-queue-in-service.png' });

step('desk: stylist break');
const farah = d.locator('div.rounded-2xl', { hasText: 'Farah' }).filter({ has: d.getByRole('button', { name: 'Break 15' }) }).first();
await farah.getByRole('button', { name: 'Break 15' }).click();
await d.getByText('Farah: break 15 min').waitFor();
await d.screenshot({ path: SHOTS + '13-dashboard-break.png' });

step('desk: finish Cleon');
await d.locator('div.rounded-2xl', { hasText: 'Cleon' }).getByRole('button', { name: 'Finish' }).last().click();
await c.getByText('All done, thank you!').waitFor({ timeout: 8000 });
await c.screenshot({ path: SHOTS + '09b-queue-done.png' });

step('desk: report and settings (receptionist, read-only)');
await d.getByRole('link', { name: 'Report' }).click();
await d.getByRole('heading', { name: 'How accurate were our waits?' }).waitFor();
await d.getByText('By stylist').waitFor();
await d.screenshot({ path: SHOTS + '14-report.png' });

// ---------------------------------------------------------------- owner settings
const o = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
watch(o, 'owner');
step('owner: settings');
await o.goto(WEB + '/staff/login');
await o.getByLabel('Email').fill('owner@demo-salon.test');
await o.getByLabel('Password').fill('salon-demo-1234');
await o.getByRole('button', { name: 'Sign in' }).click();
await o.waitForURL('**/dashboard/demo-salon-bandra', { waitUntil: 'commit' });
await o.getByRole('link', { name: 'Settings' }).click();
await o.getByText('Global hair colour').waitFor();
await o.screenshot({ path: SHOTS + '15-settings-services.png' });
await o.getByRole('tab', { name: 'Stylists' }).click();
await o.getByText('★ = this stylist').waitFor();
await o.screenshot({ path: SHOTS + '16-settings-stylists.png' });
await o.getByRole('button', { name: 'Edit' }).nth(1).click();
await o.getByText(/Services and their time/).waitFor();
await o.screenshot({ path: SHOTS + '17-settings-stylist-edit.png' });
await o.getByRole('button', { name: 'Save' }).click();
await o.getByText('Stylist saved').waitFor();
await o.getByRole('tab', { name: 'Opening hours' }).click();
await o.getByRole('heading', { name: 'Holidays' }).waitFor();
await o.screenshot({ path: SHOTS + '18-settings-hours.png' });
await o.getByRole('tab', { name: 'Queue settings' }).click();
await o.getByLabel('No-show grace period (min)').waitFor();
await o.getByRole('button', { name: 'Save settings' }).click();
await o.getByText('Settings saved').waitFor();
await o.screenshot({ path: SHOTS + '19-settings-queue.png' });

// ---------------------------------------------------------------- stylist view
const s = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
watch(s, 'stylist');
step('stylist: own view');
await s.goto(WEB + '/staff/login');
await s.getByLabel('Email').fill('anjali@demo-salon.test');
await s.getByLabel('Password').fill('salon-demo-1234');
await s.getByRole('button', { name: 'Sign in' }).click();
await s.waitForURL('**/dashboard/demo-salon-bandra', { waitUntil: 'commit' });
await s.getByText('My customers').waitFor();
await s.screenshot({ path: SHOTS + '20-stylist-view.png', fullPage: true });

step('customer: leave flow on a fresh join');
await c.goto(WEB + '/s/demo-salon-bandra');
await c.getByRole('button', { name: /Women's haircut/ }).click();
await c.getByRole('button', { name: 'Continue' }).click();
await c.getByRole('button', { name: 'Join E Walk-In' }).click();
await c.waitForURL((u) => u.href !== entryUrl && u.pathname.startsWith('/queue/'), { waitUntil: 'commit' });
await c.getByRole('button', { name: 'Leave the queue' }).click();
await c.screenshot({ path: SHOTS + '21-leave-confirm.png' });
await c.getByRole('button', { name: 'Leave', exact: true }).click();
await c.getByText('You left the queue').waitFor();

step('dark mode: queue status');
const dark = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' })).newPage();
await dark.addInitScript((v) => localStorage.setItem('kataar.customer', v), await c.evaluate(() => localStorage.getItem('kataar.customer')));
await dark.goto(entryUrl.replace(/\/queue\/.*/, '') + '/s/demo-salon-bandra');
await dark.getByRole('button', { name: /Kids haircut/ }).click();
await dark.getByRole('button', { name: 'Continue' }).click();
await dark.getByRole('button', { name: 'Join E Walk-In' }).click();
await dark.waitForURL('**/queue/**', { waitUntil: 'commit' });
await dark.getByText(/ahead of you|You're next/).waitFor().catch(async (e) => { await dark.screenshot({ path: SHOTS + 'fail-dark.png' }); throw e; });
await dark.screenshot({ path: SHOTS + '22-queue-dark.png' });

await browser.close();
if (errors.length) {
  console.error('\nBrowser errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nAll steps passed. Screenshots in e2e/screenshots/');
