import { expect, test } from '@playwright/test';
const SITE=(process.env.EDDIE_SITE_URL ?? '').replace(/\/$/,'');
test('logo and heading sizes', async ({ page }) => {
  await page.goto(SITE,{waitUntil:'domcontentloaded'});
  await page.getByLabel(/email|username/i).first().fill(process.env.EDDIE_USER!);
  await page.getByLabel(/password/i).first().fill(process.env.EDDIE_PASSWORD!);
  await page.getByRole('button',{name:/sign in/i}).click();
  await expect(page.getByText(/ask anything/i).first()).toBeVisible({timeout:60000});
  const m = await page.evaluate(() => {
    const logo = document.querySelector("#eddie-top-navigation img[alt='EDDIE']") as HTMLElement|null;
    const h = Array.from(document.querySelectorAll('*')).find(
      e => e.textContent?.trim() === 'Ask anything') as HTMLElement|null;
    return {
      logoH: logo ? Math.round(logo.getBoundingClientRect().height) : null,
      headingPx: h ? getComputedStyle(h).fontSize : null,
    };
  });
  console.log('logo height:', m.logoH, 'px | heading font-size:', m.headingPx);
  expect(m.logoH, 'logo is not ~15px tall').toBeLessThanOrEqual(17);
  await page.screenshot({path:'e2e/screenshots/sizes.png'});
});
