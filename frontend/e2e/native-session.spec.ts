import { expect, test, type Page, type Response } from '@playwright/test';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SITE = (process.env.EDDIE_SITE_URL ?? '').replace(/\/$/, '');
const AUTH_STATE = process.env.EDDIE_AUTH_STATE;
const LOCAL_CONFIG = process.env.EDDIE_LOCAL_QA_CONFIG;
test.skip(!SITE || !AUTH_STATE, 'Provide a site and private browser authentication state.');
test.use({ storageState: AUTH_STATE, trace: 'off', actionTimeout: 30_000 });

function actionIs(response: Response, action: string) {
  try { return response.url().includes('/invocations') && response.request().postDataJSON()?.action === action; }
  catch { return false; }
}

async function resultOf(response: Response) {
  const text = await response.text();
  expect(response.status()).toBe(200);
  if (response.headers()['content-type']?.includes('text/event-stream')) {
    const frames = text.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)));
    expect(frames.filter((frame) => frame.event === 'error')).toEqual([]);
    const result = frames.find((frame) => frame.event === 'complete' || frame.event === 'result');
    expect(result?.ok).toBe(true);
    return result.result;
  }
  const envelope = JSON.parse(text);
  expect(envelope.ok, envelope.detail).toBe(true);
  return envelope.result;
}

async function section(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
}

async function save(page: Page) {
  const pending = page.waitForResponse((response) => actionIs(response, 'case.save'));
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const saved = await resultOf(await pending);
  expect(saved.project?.revision).toBeTruthy();
  await expect(page.getByText(/Saved to your account at/)).toBeVisible();
  return saved.project;
}

test('a novice can save, see real streaming, recover the session and compare honestly', async ({ page }) => {
  test.setTimeout(480_000);
  const caseId = `native-ux-${randomUUID()}`;
  const actions: string[] = [];
  const errors: string[] = [];
  const evidence: Record<string, unknown> = {
    caseId, site: SITE, checkedAt: new Date().toISOString(),
    authentication: LOCAL_CONFIG ? 'isolated local QA identity; not Cognito verification' : 'existing Cognito session',
    modelAndDynamoDB: 'real AWS calls', workloadResourcesCreated: false,
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().includes('/invocations')) return;
    try { actions.push(request.postDataJSON().action); } catch { /* No headers or tokens in evidence. */ }
  });
  if (LOCAL_CONFIG) {
    expect(new URL(SITE).hostname).toBe('127.0.0.1');
    const config = JSON.parse(await fs.readFile(LOCAL_CONFIG, 'utf8'));
    await page.route('**/config.json', (route) => route.fulfill({ json: config }));
    // The temporary QA credential must never be presented to the AWS runtime.
    await page.route(/https:\/\/bedrock-agentcore\.[^/]+\/.*/, (route) => route.abort());
  }
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) {
      if (key.startsWith('eddie.case.')) throw new DOMException('QA: browser draft cache unavailable', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('eddie.case.')) throw new DOMException('QA: browser draft cache unavailable', 'SecurityError');
      return set.call(this, key, value);
    };
  });

  async function capture(name: string) {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
    await fs.writeFile(test.info().outputPath(`${name}.txt`), await page.locator('body').innerText());
  }
  async function record() {
    await fs.writeFile(test.info().outputPath('evidence.json'), JSON.stringify({ ...evidence, actions, errors }, null, 2));
  }

  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${SITE}/requirements?case=${caseId}`);
    await expect(page.getByRole('heading', { name: 'Your AI project', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Your goal', exact: true }).fill(
      'Classify support tickets as billing, technical or account; draft replies for a person to review.'
    );
    // Reproduce the reported lost-budget interaction: no blur/Enter before opening
    // another input. The budget must survive the dropdown and tab changes.
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('2000');
    await page.getByRole('button', { name: /^When will people use it\?/ }).click();
    await page.getByRole('option', { name: 'Available all the time', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true })).toHaveValue('2000');
    await expect(page.getByText('What we still need to learn', { exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'I have a response-time target', exact: true })).not.toBeChecked();
    const firstSaved = await save(page);
    expect(firstSaved.document.form.budgetUsd).toBe('2000');
    expect(firstSaved.document.form.concurrency).toBe('');
    evidence.firstSavedRevision = firstSaved.revision;
    await capture('01-optional-needs-and-advisor');

    await section(page, 'Tests');
    await page.getByRole('group', { name: 'Example 1', exact: true })
      .getByRole('textbox', { name: 'Question or task', exact: true }).fill('Why was I charged twice?');
    await page.getByRole('textbox', { name: 'Example 1 expected answer', exact: true }).fill('billing');
    await section(page, 'Models & sources');
    await page.getByRole('textbox', { name: 'Hugging Face model source', exact: true }).fill('Qwen/Qwen2.5-1.5B-Instruct');
    const inspected = page.waitForResponse((response) => actionIs(response, 'inspect_model'));
    await page.getByRole('button', { name: 'Read model details', exact: true }).click();
    const model = await resultOf(await inspected);
    expect(model.ok).toBe(true);
    expect(model.revision).toMatch(/^[a-f0-9]{40}$/);
    evidence.model = { repo: model.repo, revision: model.revision, fields: model.fields };
    expect(actions.filter((action) => action === 'evaluate')).toHaveLength(0);
    await save(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your AI project', exact: true })).toBeVisible();
    await section(page, 'Tests');
    await expect(page.getByRole('group', { name: 'Example 1', exact: true })
      .getByRole('textbox', { name: 'Question or task', exact: true })).toHaveValue('Why was I charged twice?');
    await section(page, 'Your needs');
    await expect(page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true })).toHaveValue('2000');
    evidence.accountRestoreWithoutBrowserCache = true;

    const advisor = page.getByRole('region', { name: 'Advisor conversation and controls', exact: true });
    const composer = advisor.getByRole('textbox', { name: 'Message EDDIE Advisor', exact: true });
    await page.getByRole('button', { name: 'EDDIE Advisor', exact: true }).click();
    await expect(composer).toBeVisible();
    await page.evaluate(() => {
      const root = document.querySelector('[aria-label="Advisor conversation and controls"]');
      const samples: { ms: number; length: number }[] = [];
      const started = performance.now();
      (window as any).__eddieStreamProof = { samples, started };
      new MutationObserver(() => {
        const answer = root?.querySelector('[data-testid="answer-stream"][aria-busy="true"]');
        const length = answer?.textContent?.length ?? 0;
        if (length && samples.at(-1)?.length !== length) samples.push({ ms: performance.now() - started, length });
      }).observe(root!, { childList: true, subtree: true, characterData: true });
    });
    const responsePending = page.waitForResponse((response) => actionIs(response, 'chat'));
    await composer.fill(
      'Our pilot is called Cedar and has 23 support agents. Remember those details. ' +
      'I am new to model hosting. Explain the difference between using a native Bedrock model and hosting my Qwen model, ' +
      'in six short paragraphs. No deployment or evaluation calls yet. Do not invent prices, latency or capacity.'
    );
    await advisor.getByRole('button', { name: 'Send to Advisor', exact: true }).click();
    await expect(advisor.getByTestId('answer-stream')).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__eddieStreamProof.samples.length),
      { timeout: 90_000 }).toBeGreaterThan(2);
    const firstAnswer = await resultOf(await responsePending);
    expect(firstAnswer.status).toBe('COMPLETE');
    await expect(advisor.getByTestId('answer-complete').last()).toBeVisible();
    evidence.streaming = await page.evaluate(() => {
      const proof = (window as any).__eddieStreamProof;
      return { timeToFirstVisibleTextMs: proof.samples[0]?.ms,
        completionMs: performance.now() - proof.started, visibleGrowthSamples: proof.samples };
    });
    evidence.advisorModelId = firstAnswer.advisorModelId;
    await capture('02-real-answer-streamed');
    await save(page);

    await page.reload();
    await page.getByRole('button', { name: 'EDDIE Advisor', exact: true }).click();
    await expect(advisor.getByTestId('answer-complete').first()).toBeVisible({ timeout: 30_000 });
    await composer.fill('What is our pilot called, and how many support agents did I say we have? Reply in one sentence.');
    const followupPending = page.waitForResponse((response) => actionIs(response, 'chat'));
    await advisor.getByRole('button', { name: 'Send to Advisor', exact: true }).click();
    const followup = await resultOf(await followupPending);
    expect(followup.status).toBe('COMPLETE');
    expect(followup.reply).toMatch(/Cedar/i);
    expect(followup.reply).toMatch(/23|twenty-three/i);
    const sent = (await followupPending).request().postDataJSON().payload;
    expect(sent.messages).toBeUndefined();
    expect(sent.turnId).not.toBe(firstAnswer.turnId);
    evidence.followupRecovered = { turnId: followup.turnId, correctPilot: true, correctAgentCount: true };

    await composer.fill('Write a detailed beginner guide of about 1500 words on how to measure answer quality for support classification. Do not call any tools.');
    const stopTurnPending = page.waitForResponse((response) => actionIs(response, 'chat'));
    await advisor.getByRole('button', { name: 'Send to Advisor', exact: true }).click();
    await expect(advisor.getByTestId('answer-stream').last()).toBeVisible({ timeout: 90_000 });
    // A first delta can be only "#": it becomes heading syntax when more text
    // arrives. Check a meaningful, already-rendered prefix instead of requiring
    // transient Markdown punctuation to remain visible after cancellation.
    await expect.poll(async () =>
      (await advisor.getByTestId('answer-stream').last().innerText()).length,
    { timeout: 90_000 }).toBeGreaterThan(100);
    const partial = await advisor.getByTestId('answer-stream').last().innerText();
    const visiblePrefix = partial.replace(/\s+/g, ' ').trim().slice(0, 60);
    const cancellation = page.waitForResponse((response) => actionIs(response, 'chat.cancel'));
    const stopHistoryPending = page.waitForResponse(async (response) => {
      if (!actionIs(response, 'chat.history')) return false;
      try {
        const envelope = await response.json();
        return envelope.result?.activeTurnId === null &&
          envelope.result.turns.at(-1)?.status === 'CANCELLED';
      } catch { return false; }
    });
    await advisor.getByRole('button', { name: 'Stop', exact: true }).click();
    const cancel = await resultOf(await cancellation);
    await expect(advisor.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0, { timeout: 30_000 });
    const stoppedHistory = await resultOf(await stopHistoryPending);
    expect(stoppedHistory.activeTurnId).toBeNull();
    expect(stoppedHistory.turns.at(-1).status).toBe('CANCELLED');
    await expect(advisor.getByTestId('answer-complete').last()).toContainText(visiblePrefix);
    await page.reload();
    await page.getByRole('button', { name: 'EDDIE Advisor', exact: true }).click();
    await expect(advisor.getByTestId('answer-complete').last()).toContainText(visiblePrefix);
    evidence.stop = { cancelRequestAccepted: cancel.requested, finalStatus: stoppedHistory.turns.at(-1).status,
      visiblePrefixCharactersChecked: visiblePrefix.length, partialRestoredAfterReload: true };
    // The interrupted response is intentionally not retried or parsed to completion.
    await stopTurnPending;
    expect(actions.filter((action) => action === 'chat')).toHaveLength(3);
    await capture('03-stopped-and-recovered');
    await save(page);

    await section(page, 'Compare hosting');
    const compared = page.waitForResponse((response) => actionIs(response, 'evaluate'));
    await page.getByRole('button', { name: 'Compare hosting costs', exact: true }).click();
    const comparison = await resultOf(await compared);
    expect(comparison.evaluatedRequest.constraints.budgetUsd).toBe('2000');
    expect(comparison.checksStipulated).toBe(false);
    expect(comparison.qualification.performanceMeasured).toBe(false);
    expect(comparison.winner).toBeNull();
    await expect(page.getByText('UNKNOWN', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'View decision map', exact: true }).click();
    const map = page.getByRole('dialog', { name: 'How EDDIE reached this result', exact: true });
    await expect(map.getByTestId('decision-branch-import')).toBeVisible();
    await map.getByRole('button', { name: 'Back to comparison', exact: true }).click();
    evidence.comparison = comparison;
    await capture('04-visible-hosting-reasons');
    await section(page, 'Your needs');
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('100');
    await section(page, 'Compare hosting');
    await expect(page.getByTestId('comparison-needs-update')).toBeVisible();
    const updated = page.waitForResponse((response) => actionIs(response, 'evaluate'));
    await page.getByRole('button', { name: 'Update comparison', exact: true }).click();
    const lowerBudget = await resultOf(await updated);
    expect(lowerBudget.evaluatedRequest.constraints.budgetUsd).toBe('100');
    expect(lowerBudget.winner).toBeNull();
    evidence.lowerBudget = lowerBudget;
    await save(page);
    await capture('05-budget-recomputed');

    // Leaving a project is different from visiting another section. Preserve
    // edits through both and require an explicit choice before discarding them.
    await section(page, 'Your needs');
    const editedGoal = 'Cedar support triage with human review — unsaved navigation check';
    await page.getByRole('textbox', { name: 'Your goal', exact: true }).fill(editedGoal);
    await page.getByRole('link', { name: 'New project', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save this project before leaving?', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stay here', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your goal', exact: true })).toHaveValue(editedGoal);
    await save(page);
    await page.getByRole('link', { name: 'New project', exact: true }).click();
    await expect(page).toHaveURL(/\/requirements\?case=project-[A-Za-z0-9-]+&view=needs$/);
    await expect(page.getByRole('dialog', { name: 'Save this project before leaving?', exact: true })).toHaveCount(0);
    evidence.navigationGuard = { unsavedDraftPreserved: true, savedProjectOpensFreshProject: true };

    await page.goto(`${SITE}/requirements?case=${caseId}`);
    await expect(page.getByRole('textbox', { name: 'Your goal', exact: true })).toHaveValue(editedGoal);
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: test.info().outputPath('06-dark-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const closePanel = page.getByRole('button', { name: 'Close panel', exact: true });
    if (await closePanel.isVisible()) await closePanel.click();
    await page.getByRole('textbox', { name: 'Your goal', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('07-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    evidence.layouts = ['1600px desktop, light and dark', '390px mobile without page overflow'];
    expect(errors).toEqual([]);
    expect(actions.some((action) => ['plan.approve', 'deployment.invoke', 'demo.wake'].includes(action))).toBe(false);
  } finally {
    await record();
  }
});
