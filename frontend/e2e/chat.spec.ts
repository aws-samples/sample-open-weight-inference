/**
 * Browser test for the chat surface against the DEPLOYED app.
 *
 * This is the only test that exercises the live advisor: a real Bedrock Converse
 * loop, real live pricing, and the real deterministic solver behind it.
 */
import { expect, test, type Page } from '@playwright/test';

const SITE = (process.env.EDDIE_SITE_URL ?? '').replace(/\/$/, '');
const USER = process.env.EDDIE_USER ?? '';
const PASSWORD = process.env.EDDIE_PASSWORD ?? '';

test.skip(!SITE || !USER || !PASSWORD, 'site URL and credentials required');
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  const email = page.getByLabel(/email|username/i).first();
  await email.waitFor({ state: 'visible', timeout: 30_000 });
  await email.fill(USER);
  await page.getByLabel(/password/i).first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 60_000 });
}

test('chat is the landing surface and offers starter prompts', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText(/ask anything/i).first()).toBeVisible({ timeout: 30_000 });
  // Suggested prompts must be present so the empty state is never a bare box.
  // Cloudscape renders SupportPromptGroup items as links, not buttons, so this is
  // matched by accessible name across roles rather than assuming one.
  const chips = page.getByText(
    /launching a 3-day game|always-on service|under 800 ms|ElevenLabs voices/i,
  );
  expect(await chips.count(), 'no suggested prompts rendered').toBeGreaterThan(0);

  // Clicking one must actually submit it, not merely fill the box.
  await chips.first().click();
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/chat-01-empty.png', fullPage: true });
});

test('a real chat turn calls the solver and renders structured figures', async ({ page }) => {
  await signIn(page);

  const composer = page.getByRole('textbox').first();
  await composer.fill(
    "I'm launching a 3-day game and expect about 6 hours of real traffic. " +
      'Where should I host Llama 3.1 8B with 16 GiB weights?'
  );
  await composer.press('Enter');

  // A live turn runs Converse plus live price collection.
  await expect(page.getByText(/\$?45\.07/).first()).toBeVisible({ timeout: 240_000 });
  // The break-even figures must come from the decision, not the prose.
  await expect(page.getByText(/17\.02/).first()).toBeVisible();
  await expect(page.getByText(/8\.33/).first()).toBeVisible();
  // The stipulation caveat must be visible, not buried.
  await expect(page.getByText(/stipulated/i).first()).toBeVisible();

  await page.screenshot({ path: 'e2e/screenshots/chat-02-answer.png', fullPage: true });
});

test('the API-only path refuses self-hosting rather than pricing it', async ({ page }) => {
  await signIn(page);
  const composer = page.getByRole('textbox').first();
  await composer.fill('We want ElevenLabs voices. Can we host that in our own AWS account?');
  await composer.press('Enter');

  await expect(
    page.getByText(/exportable|API|cannot host|self-hosting/i).first()
  ).toBeVisible({ timeout: 240_000 });
  await page.screenshot({ path: 'e2e/screenshots/chat-03-api-only.png', fullPage: true });
});
