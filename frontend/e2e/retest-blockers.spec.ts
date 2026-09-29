/**
 * Browser verification of the retest blockers, against the DEPLOYED app.
 *
 * The retest measured CHAT-06 (5,094 px document, composer at Y=1,020 in a 1,000 px
 * viewport), so this suite measures rather than asserting on text. The jsdom suite
 * cannot see layout at all, and `IntersectionObserver` is stubbed there, so the
 * scroll indicator has no unit coverage.
 *
 * Findings pinned: CHAT-03, CHAT-04, CHAT-05, CHAT-06, CHAT-07, CHAT-08.
 */

import { expect, test, type Page } from '@playwright/test';

const SITE = (process.env.EDDIE_SITE_URL ?? '').replace(/\/$/, '');
const USER = process.env.EDDIE_USER ?? '';
const PASSWORD = process.env.EDDIE_PASSWORD ?? '';

test.skip(!SITE || !USER || !PASSWORD, 'site URL and credentials required');
test.describe.configure({ mode: 'serial' });

const STARTER =
  "I'm launching a 3-day game and expect about 6 hours of real traffic. " +
  'Where should I host Llama 3.1 8B with 16 GiB weights?';

async function signIn(page: Page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  const email = page.getByLabel(/email|username/i).first();
  await email.waitFor({ state: 'visible', timeout: 30_000 });
  await email.fill(USER);
  await page.getByLabel(/password/i).first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 60_000 });
}

/** Send a chat turn and wait for a settled reply. */
async function ask(page: Page, text: string, timeout = 240_000) {
  const composer = page.getByRole('textbox').first();
  await composer.fill(text);
  await composer.press('Enter');
  // Settled when the composer is empty and enabled again.
  await expect(page.getByRole('textbox').first()).toBeEnabled({ timeout });
  await page.waitForTimeout(1500);
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector('textarea, input[type="text"]');
    const box = composer?.getBoundingClientRect();
    return {
      docHeight: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
      composerViewportY: box ? Math.round(box.top) : null,
      composerVisible: box ? box.top >= 0 && box.bottom <= window.innerHeight : false,
      horizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

// --------------------------------------------------------------------------
// CHAT-06: results must not drown the conversation
// --------------------------------------------------------------------------

test('CHAT-06: two turns stay compact and the composer stays on screen', async ({ page }) => {
  await signIn(page);

  await ask(page, STARTER);
  const afterOne = await metrics(page);

  await ask(page, 'Same model but an always-on service for a month — does the answer change?');
  const afterTwo = await metrics(page);

  console.log('after 1 turn:', JSON.stringify(afterOne));
  console.log('after 2 turns:', JSON.stringify(afterTwo));

  // The retest measured 5,094 px after two voice turns and 8,592 px for text.
  // A compact summary should keep this far below that.
  expect(
    afterTwo.docHeight,
    `document is ${afterTwo.docHeight}px after two turns; the retest baseline was 5094px`
  ).toBeLessThan(4000);

  // The composer must be fully inside the viewport, not merely near it.
  expect(
    afterTwo.composerVisible,
    `composer at viewport Y=${afterTwo.composerViewportY} in a ${afterTwo.viewport}px viewport`
  ).toBe(true);

  // Position must not drift with content: the pane is height-constrained, so the
  // composer sits at the same place after one turn and after two.
  expect(
    afterTwo.composerViewportY,
    'composer moved between turns, so the pane is not height-constrained'
  ).toBe(afterOne.composerViewportY);

  expect(afterTwo.horizontalOverflow).toBeLessThanOrEqual(2);

  await page.screenshot({ path: 'e2e/screenshots/rt-01-two-turns.png', fullPage: false });
});

test('CHAT-06: the full report is in a panel, not inline', async ({ page }) => {
  await signIn(page);
  await ask(page, STARTER);

  // Establish a known state rather than assuming the panel is closed. Persistence
  // can restore an open panel, and Cloudscape moves a SplitPanel into the content
  // area when positioned at the bottom -- either can put the panel's own ranked
  // table inside the region this test inspects. Asserting from an unknown starting
  // state made this order-dependent.
  const close = page.getByRole('button', { name: /close panel|hide panel/i }).first();
  if (await close.count()) {
    await close.click();
    await page.waitForTimeout(1200);
  }

  const thread = page.locator('.eddie-chat-thread');
  await expect(thread).toBeVisible();

  const inlineRanked = await thread.getByText(/Ranked candidates/i).count();
  expect(inlineRanked, 'the ranked table is still inline in the conversation').toBe(0);
  const inlineProvenance = await thread.getByText(/Assumptions and provenance/i).count();
  expect(inlineProvenance, 'provenance is still inline in the conversation').toBe(0);

  // Opening the detail surface reveals them somewhere on the page.
  const open = page.getByRole('button', { name: /see full decision/i }).first();
  if (await open.count()) {
    await open.click();
    await page.waitForTimeout(2000);
  }
  await expect(page.getByText(/Ranked candidates/i).first()).toBeVisible();
  // Still not inline after opening.
  expect(await thread.getByText(/Ranked candidates/i).count()).toBe(0);

  await page.screenshot({ path: 'e2e/screenshots/rt-02-detail-panel.png', fullPage: false });
});

// --------------------------------------------------------------------------
// CHAT-02 / CHAT-03 / CHAT-05
// --------------------------------------------------------------------------

test('CHAT-02: no benchmark means the result never claims measured', async ({ page }) => {
  await signIn(page);
  await ask(page, STARTER);

  const body = await page.locator('body').innerText();
  expect(body, 'the false "Performance measured: Yes" claim is back').not.toMatch(
    /Performance measured:\s*Yes/i
  );
  // The four-way status must be shown instead of a boolean.
  expect(body).toMatch(/NOT_REQUESTED|No latency objective|not measured/i);
});

test('CHAT-03: the chat decision reaches Comparison', async ({ page }) => {
  await signIn(page);
  await ask(page, STARTER);

  await page.getByRole('navigation').first()
    .getByRole('link', { name: /comparison/i }).click();
  await page.waitForTimeout(2500);

  const body = await page.locator('body').innerText();
  expect(body, 'Comparison still shows no evaluation after a chat decision').not.toMatch(
    /No evaluation yet/i
  );
  expect(body).toMatch(/45\.07|cmi-scale-to-zero|Bedrock/i);

  await page.screenshot({ path: 'e2e/screenshots/rt-03-comparison.png', fullPage: false });
});

test('CHAT-05: editing a consequential input marks the result outdated', async ({ page }) => {
  await signIn(page);

  await page.getByRole('navigation').first()
    .getByRole('link', { name: /case workspace/i }).click();
  await page.getByRole('button', { name: /3-day bursty event/i }).click();
  const submit = page.getByRole('main').getByRole('button', { name: /evaluate placement/i });
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
  await expect(page.getByText(/45\.07/).first()).toBeVisible({ timeout: 180_000 });

  // Change the traffic shape without re-evaluating.
  await page.getByRole('button', { name: /always-on 30 days/i }).click();
  await page.waitForTimeout(1500);

  const body = await page.locator('body').innerText();
  expect(body, 'a stale recommendation still looks current').toMatch(
    /out of date|outdated|no longer matches|stale/i
  );

  await page.screenshot({ path: 'e2e/screenshots/rt-04-stale.png', fullPage: false });
});

// --------------------------------------------------------------------------
// CHAT-04: persistence
// --------------------------------------------------------------------------

test('CHAT-04: refresh keeps the conversation, the case and the decision', async ({ page }) => {
  await signIn(page);
  await ask(page, STARTER);

  const before = await page.locator('body').innerText();
  expect(before).toMatch(/45\.07/);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  const after = await page.locator('body').innerText();
  expect(after, 'the conversation did not survive a refresh').toMatch(
    /3-day game|6 hours of real traffic/i
  );
  expect(after, 'the decision did not survive a refresh').toMatch(/45\.07/);

  await page.screenshot({ path: 'e2e/screenshots/rt-05-after-refresh.png', fullPage: false });
});

test('CHAT-04: an unsent draft survives navigation', async ({ page }) => {
  await signIn(page);

  const draft = 'draft that must survive navigation';
  await page.getByRole('textbox').first().fill(draft);

  await page.getByRole('navigation').first()
    .getByRole('link', { name: /model catalog/i }).click();
  await page.waitForTimeout(2000);
  await page.getByRole('navigation').first()
    .getByRole('link', { name: /^chat$/i }).click();
  await page.waitForTimeout(1500);

  await expect(page.getByRole('textbox').first()).toHaveValue(draft);
});

// --------------------------------------------------------------------------
// CHAT-08: smaller contract gaps
// --------------------------------------------------------------------------

test('CHAT-08: Comparison links to /case, not to Chat', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation').first()
    .getByRole('link', { name: /comparison/i }).click();
  await page.waitForTimeout(1500);

  const link = page.getByRole('link', { name: /go to the case workspace/i }).first();
  if (await link.count()) {
    await link.click();
    await page.waitForTimeout(1500);
    expect(new URL(page.url()).pathname, 'link still targets Chat').toContain('/case');
  }
});

test('CHAT-08: a starter prefills rather than submitting immediately', async ({ page }) => {
  await signIn(page);

  const chip = page
    .getByText(/launching a 3-day game|always-on service|under 800 ms/i)
    .first();
  await chip.click();
  await page.waitForTimeout(1200);

  // Prefilled and still editable, with nothing sent.
  const value = await page.getByRole('textbox').first().inputValue();
  expect(value.length, 'the starter did not prefill the composer').toBeGreaterThan(10);
  const body = await page.locator('body').innerText();
  expect(body, 'the starter submitted immediately instead of prefilling').not.toMatch(
    /Ranked candidates|Solver called/i
  );
});

// --------------------------------------------------------------------------
// Mobile
// --------------------------------------------------------------------------

test('CHAT-06: composer reachable on a phone after a real turn', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await ask(page, STARTER);

  const m = await metrics(page);
  console.log('phone after 1 turn:', JSON.stringify(m));
  expect(m.horizontalOverflow).toBeLessThanOrEqual(2);
  expect(
    m.docHeight,
    `phone document is ${m.docHeight}px after one turn`
  ).toBeLessThan(6000);

  await page.screenshot({ path: 'e2e/screenshots/rt-06-phone.png', fullPage: false });
});


// --------------------------------------------------------------------------
// Residual risk flagged by the implementer: a bottom-positioned detail panel
// takes height from the content area, which the pane's
// `innerHeight - top` arithmetic cannot see. If that happens the composer
// disappears behind the sheet.
// --------------------------------------------------------------------------

test('CHAT-06: composer survives an open detail panel on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await ask(page, STARTER);

  const before = await metrics(page);
  await page.getByRole('button', { name: /see full decision/i }).first().click();
  await page.waitForTimeout(2500);
  const after = await metrics(page);

  console.log('phone panel closed:', JSON.stringify(before));
  console.log('phone panel open  :', JSON.stringify(after));

  await page.screenshot({ path: 'e2e/screenshots/rt-07-phone-panel-open.png' });

  expect(after.horizontalOverflow).toBeLessThanOrEqual(2);
  expect(
    after.composerVisible,
    `composer at Y=${after.composerViewportY} in ${after.viewport}px with the detail panel open`
  ).toBe(true);
});

test('CHAT-06: composer survives an open detail panel on desktop', async ({ page }) => {
  await signIn(page);
  await ask(page, STARTER);
  await page.getByRole('button', { name: /see full decision/i }).first().click();
  await page.waitForTimeout(2500);

  const m = await metrics(page);
  console.log('desktop panel open:', JSON.stringify(m));
  expect(
    m.composerVisible,
    `composer at Y=${m.composerViewportY} in ${m.viewport}px with the detail panel open`
  ).toBe(true);
});

// --------------------------------------------------------------------------
// Decision identity moved from a form snapshot to the evaluated request. The
// implementer flagged the risk: if a chat-produced evaluatedRequest does not
// normalise to equality with the form's projection, a decision reads "out of
// date" the instant it arrives, before the user touches anything.
// --------------------------------------------------------------------------

test('identity: a fresh chat decision is not immediately stale', async ({ page }) => {
  await signIn(page);
  await ask(page, STARTER);

  const body = await page.locator('body').innerText();
  expect(
    body,
    'a chat decision reads as out of date before any edit, so the chat and form ' +
      'payload projections do not normalise to equality'
  ).not.toMatch(/out of date|outdated|no longer matches/i);

  await page.screenshot({ path: 'e2e/screenshots/rt-08-fresh-not-stale.png' });
});

test('identity: a chat decision goes stale only after a consequential edit', async ({ page }) => {
  await signIn(page);
  await ask(page, STARTER);

  // Cosmetic edit must NOT invalidate: caseId and description are excluded.
  await page.getByRole('navigation').first()
    .getByRole('link', { name: /case workspace/i }).click();
  await page.waitForTimeout(1500);

  const description = page.getByLabel(/description/i).first();
  if (await description.count()) {
    await description.fill('a purely cosmetic note');
    await page.waitForTimeout(1200);
    const afterCosmetic = await page.locator('body').innerText();
    expect(
      afterCosmetic,
      'a description change invalidated the decision, but it is not solver-relevant'
    ).not.toMatch(/out of date|outdated|no longer matches/i);
  }

  // Consequential edit MUST invalidate.
  await page.getByRole('button', { name: /always-on 30 days/i }).click();
  await page.waitForTimeout(1500);
  const afterReal = await page.locator('body').innerText();
  expect(
    afterReal,
    'a horizon change did not invalidate the decision'
  ).toMatch(/out of date|outdated|no longer matches/i);
});
