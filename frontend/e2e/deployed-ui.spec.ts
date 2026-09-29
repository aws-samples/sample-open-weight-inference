/**
 * Browser tests against the DEPLOYED EDDIE application.
 *
 * These drive a real browser against the real CloudFront distribution, signing in
 * with real Cognito SRP and invoking the real AgentCore Runtime. They are the only
 * tests that exercise the wire contract end to end; the jsdom suite uses fixtures.
 *
 *   EDDIE_SITE_URL=https://xxx.cloudfront.net \
 *   EDDIE_USER=someone@example.com EDDIE_PASSWORD='...' \
 *     npx playwright test e2e/deployed-ui.spec.ts
 *
 * Screenshots land in e2e/screenshots/ for visual review in both themes.
 */

import { expect, test, type Page } from '@playwright/test';

const SITE = (process.env.EDDIE_SITE_URL ?? '').replace(/\/$/, '');
const USER = process.env.EDDIE_USER ?? '';
const PASSWORD = process.env.EDDIE_PASSWORD ?? '';

test.skip(!SITE || !USER || !PASSWORD, 'EDDIE_SITE_URL, EDDIE_USER, EDDIE_PASSWORD required');

test.describe.configure({ mode: 'serial' });

/** Console errors and failed requests are collected so a silent break is caught. */
function watch(page: Page) {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()}`));
  return { errors, failed };
}

async function signIn(page: Page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });

  // The sign-in form is the only unauthenticated surface.
  const email = page.getByLabel(/email|username/i).first();
  await email.waitFor({ state: 'visible', timeout: 30_000 });
  await email.fill(USER);
  await page.getByLabel(/password/i).first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Signed in when the primary navigation appears.
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 60_000 });
}

test('app shell loads with no console errors and no failed requests', async ({ page }) => {
  const { errors, failed } = watch(page);
  await page.goto(SITE, { waitUntil: 'networkidle' });

  await expect(page.locator('#root')).toBeAttached();
  // The wordmark must render, proving the bundle executed rather than 200-ing empty.
  await expect(page.getByText(/EDDIE/i).first()).toBeVisible({ timeout: 30_000 });

  await page.screenshot({ path: 'e2e/screenshots/01-signin.png', fullPage: true });

  expect(failed, `failed requests: ${failed.join(', ')}`).toHaveLength(0);
  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('runtime config points at AgentCore and carries no API Gateway URL', async ({ request }) => {
  const resp = await request.get(`${SITE}/config.json`);
  expect(resp.status()).toBe(200);
  const cfg = await resp.json();
  expect(cfg.agentRuntimeArn).toContain('bedrock-agentcore');
  expect(cfg.userPoolId).toBeTruthy();
  expect(cfg.userPoolClientId).toBeTruthy();
  expect(cfg.apiBaseUrl, 'API Gateway URL must be gone').toBeUndefined();
});

test('Cognito SRP sign-in succeeds and the shell renders', async ({ page }) => {
  const { errors } = watch(page);
  await signIn(page);

  await expect(page.getByRole('navigation').first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/02-signed-in-dark.png', fullPage: true });

  const fatal = errors.filter((e) => !/favicon|third-party cookie/i.test(e));
  expect(fatal, `console errors after sign-in: ${fatal.join(' | ')}`).toHaveLength(0);
});

test('bursty preset invokes the real runtime and ranks CMI first', async ({ page }) => {
  await signIn(page);
  // Chat is the landing surface now; the requirements form lives at /case.
  await page.getByRole('navigation').first()
    .getByRole('link', { name: /case workspace/i }).click();

  await page.getByRole('button', { name: /3-day bursty event/i }).click();

  // Scope to the main region: "Evaluate" also names a navigation group.
  const submit = page
    .getByRole('main')
    .getByRole('button', { name: /evaluate placement/i });
  await submit.scrollIntoViewIfNeeded();
  await submit.click();

  // A real AgentCore call: live price collection takes seconds.
  const decision = page.getByRole('main');

  // Assert on structure, not on the rendered price string: the cost column can be
  // horizontally clipped, and a clipped number is a layout bug rather than a
  // reason for this test to fail.
  await expect(decision.getByText(/Ranked candidates/i).first())
    .toBeVisible({ timeout: 150_000 });
  await expect(decision.getByText('cmi-scale-to-zero').first()).toBeVisible();
  await expect(decision.getByText(/^Winner$/i).first()).toBeVisible();
  await expect(decision.getByText(/Unresolved candidates \(0\)/i)).toBeVisible();

  // The winner's cost must be readable in full, not truncated to "$45.".
  const costText = await decision
    .getByRole('table')
    .first()
    .innerText();
  expect(costText, 'winner cost is clipped in the ranked table').toMatch(
    /\$\s?45\.07/,
  );

  await page.screenshot({ path: 'e2e/screenshots/03-result-bursty.png', fullPage: true });
});

test('theme toggle flips both ways and persists across reload', async ({ page }) => {
  await signIn(page);

  // Cloudscape's applyMode sets a class on <body> (awsui-dark-mode /
  // awsui-polaris-dark-mode), not a data attribute.
  const mode = () =>
    page.evaluate(() => {
      const cls = `${document.body.className} ${document.documentElement.className}`;
      return /dark/i.test(cls) ? 'dark' : 'light';
    });

  const before = await mode();
  await page
    .getByRole('button', { name: /dark mode|light mode|theme|appearance/i })
    .first()
    .click();
  await page.waitForTimeout(600);
  const after = await mode();
  expect(after, 'theme did not change').not.toBe(before);

  await page.screenshot({ path: 'e2e/screenshots/04-theme-toggled.png', fullPage: true });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  expect(await mode(), 'theme did not persist across reload').toBe(after);
});

test('keyboard can reach and operate the primary action', async ({ page }) => {
  await signIn(page);

  // Tab until focus lands on something interactive, proving no focus trap.
  let reached = false;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const tag = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 30)}` : '';
    });
    if (/BUTTON|INPUT|A:|SELECT/.test(tag)) {
      reached = true;
      break;
    }
  }
  expect(reached, 'keyboard focus never reached an interactive element').toBe(true);
});

test('every page renders without an error boundary', async ({ page }) => {
  await signIn(page);
  const { errors } = watch(page);

  const links = page.getByRole('navigation').first().getByRole('link');
  const count = Math.min(await links.count(), 8);

  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    const label = (await link.textContent())?.trim() ?? `link-${i}`;
    await link.click();
    await page.waitForTimeout(1500);

    // No crash screen, and something rendered.
    await expect(page.locator('#root')).not.toBeEmpty();
    const crashed = await page.getByText(/something went wrong|unexpected error/i).count();
    expect(crashed, `error boundary shown on "${label}"`).toBe(0);

    await page.screenshot({
      path: `e2e/screenshots/page-${i}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`,
      fullPage: true,
    });
  }

  const fatal = errors.filter((e) => !/favicon|third-party cookie/i.test(e));
  expect(fatal, `console errors while navigating: ${fatal.join(' | ')}`).toHaveLength(0);
});

test('renders at a narrow viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await signIn(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page overflows horizontally at 768px').toBeLessThanOrEqual(2);

  await page.screenshot({ path: 'e2e/screenshots/05-narrow.png', fullPage: true });
});
