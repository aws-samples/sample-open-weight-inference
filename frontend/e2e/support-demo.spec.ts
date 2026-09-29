import { expect, test, type Page, type Response } from '@playwright/test';
import fs from 'node:fs/promises';
import type { EvaluateResponse } from '../src/api/types';

/**
 * Real UI -> Cognito -> AgentCore -> model metadata / AWS prices.
 * No intercepted responses, supplied benchmarks, or assumed account checks.
 * EDDIE_AUTH_STATE is an ephemeral Playwright state from a real sign-in.
 * Keep it outside the repo. Do not record traces containing bearer tokens.
 */
const SITE = process.env.EDDIE_SITE_URL ?? '';
const AUTH_STATE = process.env.EDDIE_AUTH_STATE;
const USER = process.env.EDDIE_USER ?? '';
const PASSWORD = process.env.EDDIE_PASSWORD ?? '';
test.skip(!SITE || (!AUTH_STATE && (!USER || !PASSWORD)), 'A site and real sign-in are required.');
test.use({ storageState: AUTH_STATE, trace: 'off', actionTimeout: 20_000, navigationTimeout: 30_000 });

function isAction(response: Response, action: string): boolean {
  if (!response.url().includes('/invocations')) return false;
  try {
    return response.request().postDataJSON()?.action === action;
  } catch {
    return false;
  }
}

async function responseResult(response: Response): Promise<unknown> {
  expect(response.status()).toBe(200);
  const text = await response.text();
  if (response.headers()['content-type']?.includes('text/event-stream')) {
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()));
    expect(events.filter((event) => event.event === 'error')).toEqual([]);
    const complete = events.find((event) => event.event === 'result');
    expect(complete?.ok).toBe(true);
    return complete.result;
  }
  const body = JSON.parse(text);
  expect(body.ok).toBe(true);
  return body.result;
}

async function openSection(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
}

test('rehearse a support-ticket assistant with live prices and honest qualification', async ({ page }) => {
  test.setTimeout(240_000);
  const evidence: Record<string, unknown> = {
    checkedAt: new Date().toISOString(),
    site: SITE,
    scenario: 'Qwen2.5-7B support-ticket classification and draft replies for human review',
    requirementsArePlanningInputs: true,
  };
  const errors: string[] = [];
  const evaluationRequests: unknown[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().includes('/invocations')) return;
    try {
      const body = request.postDataJSON();
      if (body?.action === 'evaluate') evaluationRequests.push(body.payload);
    } catch { /* Only record the application payload, never auth headers. */ }
  });

  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto(`${SITE}/requirements`, { waitUntil: 'domcontentloaded' });
  if (!AUTH_STATE) {
    await page.getByLabel('Username', { exact: true }).fill(USER);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('What are you building?', { exact: true }).waitFor();
    await page.goto(`${SITE}/requirements`);
  }
  await expect(page.getByRole('heading', { name: 'Your requirements', exact: true })).toBeVisible();
  console.info('Rehearsal: authenticated requirements page loaded.');
  const darkMode = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await darkMode.count()) await darkMode.click();
  // Reset is a user-visible way to remove an earlier hypothetical scenario.
  await page.getByRole('button', { name: 'Reset to defaults' }).click();

  await page.getByRole('combobox', { name: 'Which model do you want to use?' }).fill('Qwen2.5 7B');
  await page.getByRole('option').filter({ hasText: 'Qwen2.5 7B Instruct' }).first().click();
  await expect(page.getByLabel('Model source', { exact: true })).toHaveValue('Qwen/Qwen2.5-7B-Instruct');
  console.info('Rehearsal: Qwen selected; inspecting its published metadata.');
  const inspectionResponse = page.waitForResponse((response) => isAction(response, 'inspect_model'));
  await page.getByRole('button', { name: 'Inspect model', exact: true }).click();
  const inspection = await responseResult(await inspectionResponse);
  evidence.inspection = inspection;
  console.info('Rehearsal: live model inspection returned.');
  await expect(page.getByTestId('inspect-detected-count')).toBeVisible();
  expect(evaluationRequests).toHaveLength(0); // Inspect must not submit the form.

  await page.getByRole('button', { name: 'Always-on 30 days', exact: true }).click();
  await page.getByLabel('Concurrency', { exact: true }).fill('4');
  await page.getByRole('textbox', { name: 'What are you building?', exact: true }).fill(
    'Support-ticket assistant: classify incoming tickets and draft a concise reply for a human to review.'
  );
  await page.getByLabel('Set a response-time target', { exact: true }).check();
  await page.getByRole('combobox', { name: 'Target (milliseconds)', exact: true }).fill('5000');
  await expect(page.getByLabel('Count the first request after idle', { exact: true })).toBeChecked();
  await openSection(page, 'Region and budget');
  await page.getByRole('spinbutton', { name: /Budget in US dollars|Most you can spend over that period/ }).fill('2000');

  async function compare(label: string) {
    console.info(`Rehearsal: comparing ${label}.`);
    const before = evaluationRequests.length;
    const pending = page.waitForResponse((response) => isAction(response, 'evaluate'));
    await page.getByRole('button', { name: 'Compare options', exact: true }).click();
    const result = (await responseResult(await pending)) as EvaluateResponse;
    await expect(page.getByTestId('comparison-summary')).toBeVisible();
    expect(evaluationRequests).toHaveLength(before + 1);
    expect(result.checksStipulated).toBe(false);
    expect(result.qualification?.performanceMeasured).toBe(false);
    expect(result.qualification?.benchmarkRunIds).toEqual([]);
    expect(result.qualification?.latencyStatus).toBe('NOT_MEASURED');
    expect(result.evaluatedRequest).toMatchObject({
      model: { hfRepo: 'Qwen/Qwen2.5-7B-Instruct', architecture: 'Qwen2ForCausalLM' },
      constraints: { permittedRegions: ['us-east-1'] },
      slos: [{ metric: 'p99_latency_ms', thresholdMs: '5000', includeCold: true }],
      assumeChecksCleared: false,
    });
    expect(result.evaluatedRequest?.latencyEvidence).toBeNull();
    expect(Object.values(result.priceFreshness)).not.toContain('UNKNOWN');
    expect(Object.values(result.priceFreshness)).not.toContain('PINNED');
    await expect(page.getByText('UNKNOWN', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Latency gate', exact: true })).toHaveCount(0);
    evidence[label] = result;
    await fs.writeFile(test.info().outputPath('live-evidence.json'), JSON.stringify(evidence, null, 2));
    console.info(`Rehearsal: ${label}: ${result.counts.unresolved} awaiting verification, ${result.counts.excluded} ruled out.`);
    return result;
  }

  const alwaysOn = await compare('alwaysOn30Days');
  expect(alwaysOn.outcome).toBe('NO_QUALIFIED_PLACEMENT');
  expect(alwaysOn.winner).toBeNull();
  expect(alwaysOn.unresolved.length).toBeGreaterThan(0);
  expect(alwaysOn.evaluatedRequest).toMatchObject({
    workload: { horizonHours: '720', billableCopyHours: '720', concurrency: 4 },
    constraints: { budgetUsd: '2000' },
  });
  await expect(page.getByText('Costs are ready. Verification is next.')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-always-on.png'), fullPage: true });
  await page.getByRole('heading', { name: 'Your hosting options', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('02-comparison-desktop.png') });

  await page.getByRole('spinbutton', { name: /Budget in US dollars|Most you can spend over that period/ }).fill('500');
  await expect(page.getByText('Your requirements changed', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Hosting cost estimates and verification status' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('03-requirements-changed.png') });
  const tightBudget = await compare('budget500');
  expect(tightBudget.winner).toBeNull();
  expect(tightBudget.unresolved).toHaveLength(0);
  expect(tightBudget.excluded.every((candidate) =>
    candidate.gates.some((gate) => gate.name === 'budget' && gate.status === 'FAIL')
  )).toBe(true);
  expect(tightBudget.evaluatedRequest).toMatchObject({ constraints: { budgetUsd: '500' } });
  await expect(page.getByText('No option meets these requirements', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '3-day bursty event', exact: true }).click();
  await expect(page.getByText('Your requirements changed', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Hosting cost estimates and verification status' })).toHaveCount(0);
  const event = await compare('threeDayEvent');
  expect(event.evaluatedRequest).toMatchObject({
    workload: { horizonHours: '72', billableCopyHours: '6', concurrency: 4 },
    constraints: { budgetUsd: '500' },
  });
  expect(event.winner).toBeNull(); // A cheap quote is still not a measured SLO.
  expect(event.unresolved.length).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('04-event.png'), fullPage: true });

  // The decision survives a reload, without changing input identity.
  await page.reload();
  await expect(page.getByTestId('comparison-summary')).toBeVisible();
  await expect(page.getByText('Your requirements changed', { exact: true })).toHaveCount(0);
  await openSection(page, 'Region and budget');
  await expect(page.getByRole('spinbutton', { name: /Budget in US dollars|Most you can spend over that period/ })).toHaveValue('500');
  expect(evaluationRequests).toHaveLength(3);

  const lightMode = page.getByRole('button', { name: 'Switch to light mode', exact: true });
  if (await lightMode.count()) await lightMode.click();
  await page.screenshot({ path: test.info().outputPath('05-light-mode.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Your hosting options', exact: true }).scrollIntoViewIfNeeded();
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport + 1);
  await page.screenshot({ path: test.info().outputPath('06-mobile.png') });
  expect(errors).toEqual([]);
  evidence.browserErrors = errors;
  evidence.evaluationRequests = evaluationRequests;
  evidence.mobileGeometry = geometry;
  evidence.rehearsalComplete = true;
  await fs.writeFile(test.info().outputPath('live-evidence.json'), JSON.stringify(evidence, null, 2));
});
