// Runs the built extension in Chromium against a real decision server and prints what it decided
// for each post of the fake timeline, with probabilities and timings.
//   SERVER_URL=https://example.org SERVER_KEY=secret npm run test:server
// Optional: SERVER_MODEL (default laya), SERVER_API (ollaya or typesafe, default ollaya).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extDir = join(root, 'dist', 'chrome');
const shots = join(root, 'test-results');
mkdirSync(shots, { recursive: true });

const baseUrl = process.env.SERVER_URL;
assert.ok(baseUrl, 'Set SERVER_URL, and SERVER_KEY if the server needs one.');
const config = {
  baseUrl,
  apiKey: process.env.SERVER_KEY ?? '',
  model: process.env.SERVER_MODEL ?? 'laya',
  api: process.env.SERVER_API ?? 'ollaya',
};

const executablePath = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .filter(Boolean)
  .find((p) => existsSync(p));
assert.ok(executablePath, 'No Chromium found. Set CHROMIUM_PATH.');

const context = await chromium.launchPersistentContext('', {
  executablePath,
  headless: true,
  viewport: { width: 1300, height: 1400 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');

  console.log(`Server: ${config.baseUrl} (${config.api}, model ${config.model})`);
  await worker.evaluate(async (cfg) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, backend: { ...(settings.backend ?? {}), provider: 'custom', custom: cfg } },
    });
    // Wait for the background to pick up the new server and its Origin rule.
    await new Promise((r) => setTimeout(r, 500));
  }, config);

  // Settings page: quick starts, likes accepted, test mode on, then Test connection.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const result = options.locator('.status');
  await options.getByRole('button', { name: 'Test connection' }).click();
  await result.filter({ hasNotText: 'Testing' }).first().waitFor({ timeout: 60_000 });
  console.log(`Test connection: ${await result.first().textContent()}`);

  for (const name of ['AI slop', 'Engagement bait', 'Like thoughtful posts']) {
    const card = options.locator('.card').filter({ has: options.locator('.card-head strong').getByText(name, { exact: true }) });
    const add = card.getByRole('button', { name: 'Add' });
    if (await add.isEnabled()) await add.click();
  }
  await options.getByLabel('I understand. Turn on rules that like posts.').check();
  await options.getByLabel(/Test mode/).check();
  await options.getByText('Saved').waitFor();

  await context.route('https://x.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: readFileSync(join(root, 'test', 'e2e', 'fake-x.html'), 'utf8') }),
  );
  const page = await context.newPage();
  await page.goto('https://x.com/home');
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: join(shots, 'real-server.png') });

  // The page keeps a trace per post in its content script; read the panels instead.
  const rows = await page.$$eval('[data-cf-id]', (cells) =>
    cells.map((c) => ({ id: c.getAttribute('data-cf-id'), state: c.getAttribute('data-cf-state'), view: c.getAttribute('data-cf-view') })),
  );
  const panels = await page.locator('.cf-panel').allInnerTexts();
  console.log(`\n${rows.length} posts in the page, ${panels.length} panels on screen:\n`);
  for (const text of panels) console.log(`${text}\n${'-'.repeat(60)}`);
  const done = rows.filter((r) => r.state === 'done').length;
  console.log(`\nDecided: ${done}, skipped: ${rows.filter((r) => r.state === 'skipped').length}, failed: ${rows.filter((r) => r.state === 'failed').length}`);
  console.log(`Screenshot: ${join(shots, 'real-server.png')}`);
  process.exitCode = done > 0 ? 0 : 1;
} finally {
  await context.close();
}
