import { expect, test, type Page, type Response } from '@playwright/test';
import fs from 'node:fs/promises';
import type { DeploymentListResponse, DeploymentPlanReview, DeploymentView, TestInvocationResponse } from '../src/api/types';

// Opt-in, real AWS test. It approves one <= $5 admission estimate and requests
// removal in finally. The independent expiry worker remains the fallback if this
// browser or machine stops. Authentication stays outside artifacts and traces.
const SITE = process.env.EDDIE_SITE_URL ?? '';
const AUTH_STATE = process.env.EDDIE_AUTH_STATE;
const MODEL_SOURCE = process.env.EDDIE_TRIAL_MODEL ?? 'Qwen/Qwen2.5-0.5B-Instruct';
if (!['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen2.5-1.5B-Instruct'].includes(MODEL_SOURCE)) {
  throw new Error('This bounded trial only accepts the two reviewed small Qwen models.');
}
test.skip(!SITE || !AUTH_STATE || process.env.EDDIE_LIVE_TRIAL !== '1',
  'Requires an explicitly enabled real trial and an ephemeral authenticated session.');
test.use({ storageState: AUTH_STATE, trace: 'off', actionTimeout: 25_000 });

function actionIs(response: Response, action: string) {
  if (!response.url().includes('/invocations')) return false;
  try { return response.request().postDataJSON()?.action === action; }
  catch { return false; }
}

async function resultOf<T>(response: Response): Promise<T> {
  expect(response.status()).toBe(200);
  const raw = await response.text();
  const envelope = response.headers()['content-type']?.includes('text/event-stream')
    ? raw.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim())).find((frame) => frame.event === 'result')
    : JSON.parse(raw);
  expect(envelope?.ok, envelope?.detail ?? 'Runtime action must succeed').toBe(true);
  return envelope.result as T;
}

async function section(page: Page, label: string) {
  const tab = page.getByRole('tab', { name: label, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

test('a novice can review, approve, try and remove a real private Qwen endpoint', async ({ page }) => {
  test.setTimeout(2_400_000);
  const evidence: Record<string, unknown> = {
    checkedAt: new Date().toISOString(), site: SITE,
    scenario: 'Classify a synthetic support ticket using a deployed small Qwen model',
    modelSource: MODEL_SOURCE,
    maximumAdmissionEstimateUsd: 5, maximumLifetimeMinutes: 45,
    qualityBenchmarkClaimed: false, percentileLatencyClaimed: false,
  };
  const pageErrors: string[] = [];
  const stateChanges: { at: string; state: string }[] = [];
  let jobId: string | undefined;
  let lastJob: DeploymentView | undefined;
  let lastState = '';
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', async (response) => {
    if (!actionIs(response, 'deployment.list') || response.status() !== 200) return;
    try {
      const data = await resultOf<DeploymentListResponse>(response);
      lastJob = data.deployments.find((job) => job.jobId === jobId);
      if (lastJob && lastJob.state !== lastState) {
        lastState = lastJob.state;
        stateChanges.push({ at: new Date().toISOString(), state: lastState });
      }
    } catch { /* The main flow reports failed actions without logging credentials. */ }
  });
  async function capture(name: string) {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
    await fs.writeFile(test.info().outputPath(`${name}.txt`), await page.locator('body').innerText());
  }
  async function save() {
    await fs.writeFile(test.info().outputPath('evidence.json'),
      JSON.stringify({ ...evidence, jobId, lastJob, stateChanges, pageErrors }, null, 2));
  }
  async function prepare() {
    const response = page.waitForResponse((r) => actionIs(r, 'plan.create'));
    await page.getByRole('button', { name: /^(Review test deployment|Prepare updated plan)$/ }).click();
    const result = await resultOf<DeploymentPlanReview>(await response);
    await expect(page.getByTestId('test-deployment-review')).toBeVisible();
    return result;
  }
  async function awaitState(states: string[], timeoutMs: number) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (lastJob && states.includes(lastJob.state)) return;
      if (states.includes('EXPERIMENTAL') && lastJob && ['FAILED', 'CLEANUP_INCOMPLETE', 'DELETED'].includes(lastJob.state)) {
        throw new Error(`Trial did not become ready: ${lastJob.state}; ${lastJob.failureReason ?? ''}`);
      }
      await page.waitForTimeout(5_000);
    }
    throw new Error(`Timed out waiting for ${states.join(', ')}; last state ${lastState}`);
  }
  try {
    const config = await (await page.request.get(`${SITE}/config.json`)).json();
    evidence.releaseId = config.releaseId;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${SITE}/requirements`);
    await expect(page.getByRole('heading', { name: 'Your AI project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All settings', exact: true }).click();
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click();
    await page.getByRole('button', { name: 'Back to overview', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your goal', exact: true }).fill(
      'Help a support team classify incoming tickets as billing, account, or technical.'
    );
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('200');
    await section(page, 'Models & sources');
    await page.getByRole('textbox', { name: 'Hugging Face model source', exact: true }).fill(
      `https://huggingface.co/${MODEL_SOURCE}`
    );
    const inspected = page.waitForResponse((r) => actionIs(r, 'inspect_model'));
    await page.getByRole('button', { name: 'Read model details', exact: true }).click();
    evidence.inspection = await resultOf(await inspected);
    await capture('01-model-inspected');

    await section(page, 'Deploy & monitor');
    await expect(page.getByRole('heading', { name: 'Try your model on AWS', exact: true })).toBeVisible();
    await page.getByRole('spinbutton', { name: 'Test budget in USD', exact: true }).fill('0.50');
    const blocked = await prepare();
    expect(blocked.plan.approvable).toBe(false);
    expect(blocked.plan.blockers.some((check) => check.checkId === 'budget.guard')).toBe(true);
    await expect(page.getByRole('button', { name: 'Approve and start test', exact: true })).toBeDisabled();
    evidence.lowBudgetRefused = true;
    await capture('02-cost-guard');

    await page.getByRole('spinbutton', { name: 'Test budget in USD', exact: true }).fill('5');
    await prepare();
    await section(page, 'Your needs');
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('100');
    await section(page, 'Deploy & monitor');
    await expect(page.getByText('Your settings changed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve and start test', exact: true })).toBeDisabled();
    evidence.changedProjectInvalidatesApproval = true;
    const plan = await prepare();
    expect(plan.plan.approvable, JSON.stringify(plan.plan.blockers)).toBe(true);
    expect(Number(plan.cost.admissionEstimateUsd)).toBeLessThanOrEqual(5);
    expect(plan.plan.envelope.maxLifetimeMinutes).toBe(45);
    evidence.review = plan;
    await page.reload();
    await expect(page.getByTestId('test-deployment-review')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('checkbox', { name: /I have reviewed/ })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: /I approve this test/ })).not.toBeChecked();
    evidence.planRestoredWithoutConsent = true;
    await capture('03-review-desktop');

    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await capture('04-review-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const terms = page.getByRole('checkbox', { name: /I have reviewed/ });
    await terms.focus();
    await page.keyboard.press('Space');
    await page.getByRole('checkbox', { name: /I approve this test/ }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Approve and start test', exact: true })).toBeEnabled();
    const approved = page.waitForResponse((r) => actionIs(r, 'plan.approve'));
    await page.getByRole('button', { name: 'Approve and start test', exact: true }).click();
    const started = await resultOf<{ deployment: DeploymentView; created: boolean }>(await approved);
    jobId = started.deployment.jobId;
    lastJob = started.deployment;
    evidence.startedAt = new Date().toISOString();
    await save();
    await expect(page.getByRole('heading', { name: 'Setting up your test', exact: true })).toBeVisible();
    await capture('05-setup-started');

    await section(page, 'Models & sources');
    await page.goto(`${SITE}/deployments`);
    await expect(page.getByTestId('deployment-details')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('deployment-details')).toBeVisible();
    evidence.jobSurvivedNavigationAndReload = true;
    await awaitState(['EXPERIMENTAL', 'READY'], 1_500_000);
    await expect(page.getByRole('heading', { name: 'Your test is ready', exact: true })).toBeVisible();
    await capture('06-ready');
    await page.getByRole('button', { name: 'Use a support-ticket example', exact: true }).click();
    const invocation = page.waitForResponse((r) => actionIs(r, 'deployment.invoke'));
    await page.getByRole('button', { name: 'Send to model', exact: true }).click();
    const answer = await resultOf<TestInvocationResponse>(await invocation);
    expect(answer.output.trim().length).toBeGreaterThan(0);
    expect(answer.receipt.sampleCount).toBe(1);
    expect(answer.receipt.percentileQualified).toBe(false);
    expect(answer.receipt.qualityQualified).toBe(false);
    evidence.actualAnswer = answer;
    evidence.exampleCheck = {
      expected: 'billing', actual: answer.output,
      rule: 'case_insensitive_exact_match',
      matched: answer.output.trim().toLowerCase() === 'billing',
      sampleCount: 1, qualityQualified: false,
    };
    await expect(page.getByRole('heading', { name: 'Model answer', exact: true })).toBeVisible();
    await capture('07-real-model-answer');
  } finally {
    if (jobId) {
      try {
        await page.goto(`${SITE}/deployments`);
        await expect(page.getByTestId('deployment-details')).toBeVisible();
        const remove = page.getByRole('button', { name: /^(Remove test|Retry removal)$/ });
        if (await remove.isVisible()) {
          // Never remove a different test if another user opened/started one while
          // this browser was running. Stop before mutation if selection changed.
          await page.getByRole('button', { name: 'Resource and invocation details', exact: true }).click();
          await expect(page.getByText(`Deployment: ${jobId}`, { exact: true })).toBeVisible();
          await remove.click();
          await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
        }
        await awaitState(['DELETED'], 600_000);
        await expect(page.getByText('Cleanup confirmed', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Cleanup receipt', exact: true }).click();
        evidence.cleanupConfirmedAt = new Date().toISOString();
        evidence.recordedResourcesAllRemoved = lastJob?.resources.every((entry) => entry.state === 'DELETED');
        await capture('08-cleanup-confirmed');
      } catch (error) {
        evidence.cleanupVerificationError = error instanceof Error ? error.message : String(error);
        // Remains a failing verification. The independent lifetime still applies.
        await save();
        throw error;
      }
    }
    await save();
  }
  expect(pageErrors).toEqual([]);
  expect(evidence.recordedResourcesAllRemoved).toBe(true);
});
