import { expect, test, type Page } from '@playwright/test';

/**
 * The non-expert flow, against the deployed application.
 *
 * What this proves that a component test cannot: the coordinator really reaches
 * Hugging Face from inside the AgentCore container, and the values the user sees
 * are the ones the model's own metadata publishes.
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
  await expect(page.getByRole('button', { name: /Sign out|Signed in as/ }).first())
    .toBeVisible({ timeout: 30_000 });
}

async function openCase(page: Page) {
  await page.getByRole('link', { name: 'Case workspace' }).first().click();
  await expect(page.getByTestId('model-source')).toBeVisible({ timeout: 20_000 });
}

test('the tab title carries the inverted D', async ({ page }) => {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  // U+A4F7, chosen because it is the only mirrored-D character whose fallback
  // metrics match a Latin capital D.
  await expect(page).toHaveTitle(/^ED\u{A4F7}IE/u);
});

test('a first-time user is not asked for an architecture class', async ({ page }) => {
  await signIn(page);
  await openCase(page);

  await expect(page.getByLabel('Which model do you want to use?')).toBeVisible();
  await expect(page.getByText('Determines the CMI family')).toHaveCount(0);
  // The technical properties exist but are collapsed.
  const details = page.getByRole('button', { name: /Model details/ });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
});

test('inspecting a real repository fills the properties from its metadata', async ({
  page,
}) => {
  await signIn(page);
  await openCase(page);

  await page.getByTestId('model-source').locator('input').fill(
    'mistralai/Mistral-7B-Instruct-v0.3'
  );
  await page.getByTestId('inspect-model').click();

  await expect(page.getByTestId('inspect-detected-count')).toContainText(
    'Read 6 of 6 properties',
    { timeout: 60_000 }
  );

  await page.getByRole('button', { name: /Model details/ }).click();
  const architecture = page.getByTestId('detail-architecture').locator('input');
  await expect(architecture).toHaveValue('MistralForCausalLM');
  // The real parameter count from the safetensors headers, not the "7" a preset
  // carried, and one copy of the weights rather than the doubled listing total.
  await expect(page.getByTestId('detail-totalParamsB').locator('input')).toHaveValue(
    '7.248'
  );
  await expect(page.getByTestId('detail-weightsGb').locator('input')).toHaveValue(
    '13.50'
  );
  await expect(page.getByText('Detected from model').first()).toBeVisible();
});

test('a gated repository reports the acceptance requirement, not a failure', async ({
  page,
}) => {
  await signIn(page);
  await openCase(page);

  await page.getByTestId('model-source').locator('input').fill(
    'meta-llama/Llama-3.1-8B-Instruct'
  );
  await page.getByTestId('inspect-model').click();

  await expect(page.getByTestId('inspect-access')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('inspect-access')).toContainText(
    /terms to be accepted/
  );

  await page.getByRole('button', { name: /Model details/ }).click();
  // Readable despite the gate.
  await expect(page.getByTestId('detail-totalParamsB').locator('input')).toHaveValue(
    '8.030'
  );
  // Behind the gate, and left empty rather than filled with a plausible 128000.
  await expect(page.getByTestId('detail-contextTokens').locator('input')).toHaveValue(
    ''
  );
});

test('a mistyped repository suggests checking the spelling', async ({ page }) => {
  await signIn(page);
  await openCase(page);

  await page.getByTestId('model-source').locator('input').fill('acme/not-a-real-model-xyzzy');
  await page.getByTestId('inspect-model').click();

  const alert = page.getByTestId('inspect-not-ok');
  await expect(alert).toBeVisible({ timeout: 60_000 });
  await expect(alert).toContainText(/spelling/);
  await expect(page.getByText('Detected from model')).toHaveCount(0);
});

test('inspecting does not silently run an evaluation', async ({ page }) => {
  await signIn(page);
  await openCase(page);

  await page.getByTestId('model-source').locator('input').fill(
    'mistralai/Mistral-7B-Instruct-v0.3'
  );
  await page.getByTestId('inspect-model').click();
  await expect(page.getByTestId('inspect-detected-count')).toBeVisible({
    timeout: 60_000,
  });

  // The Inspect button sits inside a Cloudscape Form, where a button defaults to
  // submitting. It used to evaluate against the properties as they were *before*
  // the inspection returned.
  await expect(page.getByText('No evaluation yet')).toBeVisible();
});
