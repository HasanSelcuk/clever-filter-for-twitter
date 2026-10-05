// End-to-end check: loads dist/chrome into Chromium, serves a fake X timeline and a mock Ollaya
// server, adds two quick starts through the settings page, and checks what happens on the feed.
//   npm run test:e2e
// Set CHROMIUM_PATH to use a different browser binary. Screenshots go to test-results/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startMockOllaya } from './mock-ollaya.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extDir = join(root, 'dist', 'chrome');
const shots = join(root, 'test-results');
mkdirSync(shots, { recursive: true });

const candidates = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
assert.ok(executablePath, 'No Chromium found. Set CHROMIUM_PATH.');

const mock = await startMockOllaya(11435);
const secured = await startMockOllaya(11436, { token: 'test-token' });
const timeline = readFileSync(join(root, 'test', 'e2e', 'fake-x.html'), 'utf8');

const context = await chromium.launchPersistentContext('', {
  executablePath,
  headless: true,
  viewport: { width: 1300, height: 1000 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

let failed = false;
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  try {
    await fn();
    console.log('ok');
  } catch (err) {
    failed = true;
    console.log('FAILED');
    console.error(err);
  }
};

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extId = new URL(worker.url()).host;

  await context.route('https://x.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: timeline }),
  );

  // The extension opens its settings tab on install; use that tab once it has loaded.
  const optionsUrl = `chrome-extension://${extId}/options.html`;
  const findOptions = () => context.pages().find((p) => p.url().startsWith(optionsUrl));
  const options =
    findOptions() ??
    (await context.waitForEvent('page', { predicate: (p) => p.url().startsWith(optionsUrl), timeout: 5_000 }).catch(() => null)) ??
    (await context.newPage());
  if (!options.url().startsWith(optionsUrl)) await options.goto(optionsUrl);
  await options.waitForLoadState('load');
  await options.getByRole('button', { name: 'Test connection' }).waitFor();

  await step('settings page tests the connection to Ollaya', async () => {
    await options.getByRole('button', { name: 'Test connection' }).click();
    await options.getByText(/Connected\. laya:en answered in \d+ ms\./).waitFor({ timeout: 10_000 });
    assert.equal(mock.sawOrigin(), false, 'the Origin header should be removed from extension requests');
  });

  await step('your own server: a wrong token is reported, the right one connects', async () => {
    await options.getByLabel('Your own server').check();
    await options.getByRole('textbox', { name: 'Address', exact: true }).fill('http://localhost:11436');
    await options.getByLabel('API key (optional)').fill('wrong');
    await options.getByRole('button', { name: 'Test connection' }).click();

    await options.getByText('The server did not accept the API key.').waitFor({ timeout: 10_000 });
    await options.getByLabel('API key (optional)').fill('test-token');
    await options.getByRole('button', { name: 'Test connection' }).click();
    await options.getByText(/Connected\. laya:en answered in \d+ ms\./).waitFor({ timeout: 10_000 });
    await options.getByLabel('Ollaya on this computer').check();
    await options.getByText('Saved').waitFor();
  });

  await step('quick starts add rules', async () => {
    const card = (name) =>
      options.locator('.card').filter({ has: options.locator('.card-head strong').getByText(name, { exact: true }) });
    await card('AI slop').getByRole('button', { name: 'Add' }).click();
    await card('Like thoughtful posts').getByRole('button', { name: 'Add' }).click();
    await options.getByText('Like rules stay off until you accept').waitFor();
    await options.getByLabel('I understand. Turn on rules that like posts.').check();
    await options.getByText('Saved').waitFor();
    assert.equal(await options.locator('.rule').count(), 2);
    await options.screenshot({ path: join(shots, 'settings.png'), fullPage: true });
  });

  const page = await context.newPage();
  await page.goto('https://x.com/home');

  await step('AI slop gets hidden with a scan animation and a label', async () => {
    const slop = page.locator('[data-cf-id="1001"]');
    await slop.and(page.locator('[data-cf-view="hiding"]')).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, 'feed-hiding.png') });
    await slop.and(page.locator('[data-cf-view="hidden"]')).waitFor({ timeout: 5_000 });
    assert.equal(await slop.locator('.cf-label-text').textContent(), 'Hidden: AI slop');
    assert.equal(await slop.locator('article').isVisible(), false);
  });

  await step('normal and promoted posts stay', async () => {
    await page.locator('[data-cf-id="1002"][data-cf-state="done"]').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-cf-id="1002"]').getAttribute('data-cf-view'), null);
    const ad = page.locator('[data-testid="cellInnerDiv"]', { hasText: 'Sponsored' });
    assert.equal(await ad.getAttribute('data-cf-view'), null);
    assert.equal(await ad.locator('article').isVisible(), true);
    assert.equal(mock.askedAbout('Sponsored'), false, 'promoted posts are not sent');
  });

  await step('a thoughtful post on screen gets liked once', async () => {
    const liked = page.locator('[data-cf-id="1003"] [data-testid="unlike"]');
    await liked.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'feed-liked.png') });
    assert.equal(await page.evaluate(() => window.likeClicks['1003']), 1);
  });

  await step('a post far below the screen is not liked', async () => {
    await page.waitForTimeout(2_000);
    assert.equal(await page.evaluate(() => window.likeClicks['1099'] ?? 0), 0);
  });

  await step('only the post\'s own text is checked: quoted posts and video-only posts are skipped', async () => {
    await page.locator('[data-cf-id="1007"][data-cf-state="done"]').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-cf-id="1007"]').getAttribute('data-cf-view'), null, 'quoting slop is not slop');
    assert.equal(mock.askedAbout('Unlock your potential with these game-changing hacks'), false, 'the quoted text is never sent');
    assert.equal(await page.locator('[data-cf-id="1005"]').getAttribute('data-cf-state'), 'skipped');
    await page.locator('[data-cf-id="1006"][data-cf-state="done"]').waitFor({ timeout: 10_000 });
    assert.equal(mock.askedAbout('A fox walked past'), true, 'a video post with text is checked');
  });

  await step('test mode shows a panel beside each post', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByLabel(/Test mode/).check();
    await popup.close();
    await page.bringToFront();
    const panel = (status) => page.locator('.cf-panel', { has: page.locator('.cf-panel-status', { hasText: status }) });
    await panel('Checked: passed').first().waitFor({ timeout: 5_000 });
    await page.locator('[data-cf-id="1005"]').scrollIntoViewIfNeeded();

    await panel('Skipped: no text, video only').waitFor();
    await page.evaluate(() => scrollTo(0, 0));
    const compact = await panel('Checked: passed').first().innerText();
    assert.match(compact, /AI slop \d+\.\d% · Thoughtful post \d+\.\d%/);
    assert.match(compact, /found \d\d:\d\d:\d\d\.\d{3} · answer in \d+ ms · server \d/);
    await panel('Checked: passed').first().click();
    const passed = await panel('Checked: passed').first().innerText();
    for (const word of ['found', 'asked', 'sent', 'answered', 'shown', 'laya:en', 'AI slop', '(yes at 80%)']) {
      assert.ok(passed.includes(word), `panel shows "${word}":\n${passed}`);
    }
    assert.match(passed, /answered\s+\d\d:\d\d:\d\d\.\d{3} \+\d+ ms \(server \d/);
    await page.screenshot({ path: join(shots, 'test-mode.png') });
  });

  await step('Show reveals a hidden post and Hide folds it again', async () => {
    const slop = page.locator('[data-cf-id="1001"]');
    await slop.getByRole('button', { name: 'Show' }).click();
    await slop.and(page.locator('[data-cf-view="revealed"]')).waitFor();
    assert.equal(await slop.locator('article').isVisible(), true);
    await slop.getByRole('button', { name: 'Hide' }).click();
    await slop.and(page.locator('[data-cf-view="hidden"]')).waitFor();
  });

  await step('popup shows today\'s counts', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.locator('.stat', { hasText: 'hidden' }).locator('strong', { hasText: '1' }).waitFor({ timeout: 5_000 });
    await popup.locator('.stat', { hasText: 'liked' }).locator('strong', { hasText: '1' }).waitFor();
    await popup.screenshot({ path: join(shots, 'popup.png') });
    await popup.close();
  });

  await step('turning the extension off restores the feed', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByLabel('On or off').uncheck();
    await page.locator('[data-cf-id]').first().waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(await page.locator('.cf-label').count(), 0);
    await popup.close();
  });
} finally {
  await context.close();
  await mock.close();
  await secured.close();
}

console.log(failed ? '\nSome checks failed.' : '\nAll end-to-end checks passed.');
process.exit(failed ? 1 : 0);
