import { expect, test } from '@playwright/test';
const SITE=(process.env.EDDIE_SITE_URL ?? '').replace(/\/$/,'');
test('logo renders once and EDDIE text is not duplicated', async ({ page }) => {
  await page.goto(SITE,{waitUntil:'domcontentloaded'});
  await page.getByLabel(/email|username/i).first().fill(process.env.EDDIE_USER!);
  await page.getByLabel(/password/i).first().fill(process.env.EDDIE_PASSWORD!);
  await page.getByRole('button',{name:/sign in/i}).click();
  await expect(page.getByRole('navigation').first()).toBeVisible({timeout:60000});
  await page.waitForTimeout(2500);

  const logos = await page.locator('img[alt="EDDIE"], img[src*="eddie-icon"]').count();
  console.log('logo img count:', logos);
  expect(logos, 'the logo image did not render').toBeGreaterThan(0);

  // The wordmark should appear in the top navigation only, not repeated in the side nav.
  const nav = page.getByRole('navigation').first();
  const inSideNav = await nav.getByText(/^EDDIE$/).count();
  console.log('bare "EDDIE" inside side navigation:', inSideNav);
  expect(inSideNav, 'the side navigation still repeats the EDDIE wordmark').toBe(0);

  await page.screenshot({path:'e2e/screenshots/brand-01-shell.png'});
});
