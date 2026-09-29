import { expect, test, type Page } from '@playwright/test';

const SITE = process.env.EDDIE_SITE_URL ?? '';
const USER = process.env.EDDIE_USER ?? '';
const PASSWORD = process.env.EDDIE_PASSWORD ?? '';
test.skip(!SITE || !USER || !PASSWORD, 'site credentials required');

async function signIn(page: Page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/username/i).first().fill(USER);
  await page.getByLabel(/password/i).first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('What are you building?').first()).toBeVisible({
    timeout: 30_000,
  });
}

test('manual entry is a full page, not a side panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByTestId('enter-manually').click();

  await expect(page.getByText('Your requirements').first()).toBeVisible({
    timeout: 30_000,
  });
  expect(new URL(page.url()).pathname).toBe('/requirements');

  // The form gets real width rather than a third of the window.
  const width = await page
    .getByText('Which model do you want to use?')
    .first()
    .evaluate((node) => {
      const form = node.closest('form') ?? node.closest('div');
      return form ? form.getBoundingClientRect().width : 0;
    });
  expect(width).toBeGreaterThan(380);

  /*
   * No competing split panel *open*. Cloudscape's AppLayout renders split-panel wrapper
   * elements whether or not one is shown, so presence of the class proves nothing; what
   * matters is that the form is not also rendered inside a panel, so it appears once.
   */
  await expect(page.getByText('Which model do you want to use?')).toHaveCount(1);
});

test('the requirements page shows the form and the result together', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`${SITE}/requirements`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Your requirements').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Compare options' })).toBeVisible();
  // Both columns present.
  await expect(page.getByText('Which model do you want to use?')).toBeVisible();
  await expect(page.getByText(/No evaluation yet|Recommended|Ranked/).first()).toBeVisible();
});

test('it is reachable from the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByRole('navigation').getByText('Your requirements').first().click();
  await expect(page.getByRole('button', { name: 'Compare options' })).toBeVisible({
    timeout: 30_000,
  });
});

test('Case ID is no longer near the top of intake', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`${SITE}/requirements`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Your requirements').first()).toBeVisible({
    timeout: 30_000,
  });
  // Present but collapsed under technical identifiers, not the second field asked for.
  await expect(page.getByText('Identifies this case in the backend')).toHaveCount(0);
  await expect(page.getByText('Technical identifiers')).toBeVisible();
});

test('/case still resolves to it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`${SITE}/case`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Compare options' })).toBeVisible({
    timeout: 30_000,
  });
});
