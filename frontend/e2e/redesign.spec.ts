import { expect, test, type Page } from '@playwright/test';

/**
 * The redesigned workspace, against the deployed site.
 *
 * UXR-14's first-use and simplicity gates, checked in a real browser at the two widths
 * the contract names. A jsdom test cannot establish that the purpose and a useful next
 * action are visible without scrolling.
 */

const SITE = process.env.EDDIE_SITE_URL ?? '';
const USER = process.env.EDDIE_USER ?? '';
const PASSWORD = process.env.EDDIE_PASSWORD ?? '';

test.skip(!SITE || !USER || !PASSWORD, 'EDDIE_SITE_URL, EDDIE_USER, EDDIE_PASSWORD required');

async function signIn(page: Page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/username/i).first().fill(USER);
  await page.getByLabel(/password/i).first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('What are you building?').first()).toBeVisible({
    timeout: 30_000,
  });
}

test('first use: purpose, composer and a next action without scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);

  const heading = page.getByText('What are you building?').first();
  const composer = page.getByLabel('Message EDDIE').first();
  await expect(heading).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(page.getByText('Help me choose a model').first()).toBeVisible();

  // Everything above the fold, and no page-wide scrollbar.
  const metrics = await page.evaluate(() => ({
    docHeight: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    horizontalOverflow:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(metrics.docHeight).toBeLessThanOrEqual(metrics.viewport + 8);
});

test('first use on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page.getByText('What are you building?').first()).toBeVisible();
  await expect(page.getByLabel('Message EDDIE').first()).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('simplicity: no technical fields or diagnostics on first use', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);

  // UXR-14: no technical model fields, no evidence console, no infrastructure status.
  for (const forbidden of [
    'Architecture',
    'Total parameters',
    'Weights size',
    'Case ID',
    'case-001',
    'Solver 1.1.0',
    'Knowledge NOT_INSTALLED',
    'Demo SLEEPING',
  ]) {
    await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
  }
});

test('navigation offers two destinations, not eight', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);

  const nav = page.getByRole('navigation');
  await expect(nav.getByText('New conversation').first()).toBeVisible();
  await expect(nav.getByText('Deployments').first()).toBeVisible();
  for (const removed of [
    'Case workspace',
    'Comparison',
    'Price evidence',
    'Model catalog',
    'Demo lifecycle',
  ]) {
    await expect(nav.getByText(removed, { exact: false })).toHaveCount(0);
  }
});

test('a starter fills the composer and sends nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);

  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/invocations')) requests.push(request.url());
  });

  await page.getByText('Help me choose a model').first().click();
  // `.first()` on the label match is the wrapper, not the control, so the textarea is
  // targeted directly.
  await expect(page.locator('textarea[aria-label="Message EDDIE"]')).toHaveValue(
    /I need help choosing a model/
  );
  // A starter must not spend a model call.
  expect(requests).toHaveLength(0);
});

test('Deployments reads real state and is honest about what it cannot do', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);
  await page.getByRole('navigation').getByText('Deployments').first().click();

  await expect(page.getByText('Nothing deployed yet').first()).toBeVisible({
    timeout: 30_000,
  });
  // The capability report comes from the backend, so an unavailable target says why.
  await expect(page.getByText(/not implemented yet/).first()).toBeVisible();
  await expect(page.getByText('Managed endpoint — Amazon SageMaker').first()).toBeVisible();
});

test('legacy links still resolve', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);

  for (const [path, expected] of [
    // /case was the old dedicated requirements page, and that is a page again, so the
    // link resolves to what it used to mean rather than to the conversation.
    ['/case', 'Your requirements'],
    ['/rates', 'Compare prices'],
    ['/knowledge', 'This installation'],
  ] as const) {
    await page.goto(`${SITE}${path}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(expected).first()).toBeVisible({ timeout: 30_000 });
  }
});

test('operator detail is in Settings, where it belongs', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);
  await page.goto(`${SITE}/settings`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByText('This installation').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('EDDIE infrastructure').first()).toBeVisible();
  await expect(
    page.getByText(/does not deploy or affect any model you are hosting/).first()
  ).toBeVisible();
});

test('dark and light both render the workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signIn(page);
  const initial = await page.evaluate(() =>
    document.body.classList.contains('awsui-dark-mode')
  );
  await page.getByRole('button', { name: /mode/i }).first().click();
  await expect(page.getByText('What are you building?').first()).toBeVisible();
  const flipped = await page.evaluate(() =>
    document.body.classList.contains('awsui-dark-mode')
  );
  expect(flipped).toBe(!initial);
});
