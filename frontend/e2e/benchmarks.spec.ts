import { expect, test, type Page, type Response } from '@playwright/test';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BenchmarkComparison, BenchmarkRun } from '../src/api/benchmarks';
import type { PublicBenchmarks } from '../src/api/publishedBenchmarks';

// Real Cognito and AgentCore calls. Result files are supplied privately by the
// operator after running benchmark.sh; no downloaded benchmark dataset is used.
const SITE = (process.env.EDDIE_SITE_URL ?? '').replace(/\/$/, '');
const AUTH_STATE = process.env.EDDIE_AUTH_STATE;
const REPORTS: string[] = JSON.parse(process.env.EDDIE_BENCHMARK_REPORTS ?? '[]');
test.skip(!SITE || !AUTH_STATE, 'Requires a deployed application and a private Cognito browser session.');
test.use({ storageState: AUTH_STATE, trace: 'off', actionTimeout: 30_000 });

function actionIs(response: Response, action: string) {
  try {
    return response.url().includes('/invocations') && response.request().postDataJSON()?.action === action;
  } catch { return false; }
}

async function resultOf<T>(response: Response): Promise<T> {
  expect(response.status()).toBe(200);
  const text = await response.text();
  const envelope = response.headers()['content-type']?.includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5))).find((frame) => ['result', 'complete'].includes(frame.event))
    : JSON.parse(text);
  expect(envelope?.ok, envelope?.detail ?? 'Runtime action failed').toBe(true);
  return envelope.result as T;
}

async function openTests(page: Page, caseId: string) {
  await page.goto(`${SITE}/requirements?case=${caseId}&view=tests`);
  await expect(page.getByRole('heading', { name: 'Your AI project', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Tests', exact: true })).toHaveAttribute('aria-selected', 'true');
}

test('public evidence reconciles current source records and compares matched tasks', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openTests(page, `public-evidence-${randomUUID()}`);
  await page.getByRole('tab', { name: 'Public benchmarks', exact: true }).click();
  const pending = page.waitForResponse((response) => actionIs(response, 'benchmarks.public'));
  await page.getByRole('button', { name: 'Load published results', exact: true }).click();
  const source = await resultOf<PublicBenchmarks>(await pending);
  expect(source.state).toBe('READY');
  expect(source.provenance).toBe('PUBLISHED_RESULTS');
  expect(source.deploymentQualified).toBe(false);
  expect(source.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  const eligible = source.rows!.filter((row) => row.eligible);
  expect(eligible.length).toBeGreaterThanOrEqual(2);
  expect(new Set(eligible.map((row) => row.harnessVersion)).size).toBe(1);
  expect(new Set(eligible.map((row) => row.taskSetDigest)).size).toBe(1);
  expect(eligible.every((row) => row.tasks === 500 && row.outcomesConsistent && row.costsConsistent)).toBe(true);
  for (const row of source.rows!.filter((entry) => !entry.eligible)) {
    expect(row.frontier).toBe(false);
    expect(row.reasons.length).toBeGreaterThan(0);
  }
  await expect(page.getByRole('group', { name: 'Published coding correctness versus reported API cost' })).toBeVisible();
  const comparison = page.getByTestId('published-benchmark-comparison');
  await comparison.screenshot({ path: test.info().outputPath('public-benchmark-comparison.png'), animations: 'disabled' });

  const excluded = source.rows!.find((row) => !row.eligible);
  if (excluded) {
    await page.getByRole('button', {
      name: `Review excluded record: ${excluded.model}`, exact: true,
    }).click();
    await expect(page.getByText('Excluded from the frontier', { exact: true })).toBeVisible();
    await expect(page.getByText(excluded.reasons.join(' '), { exact: true })).toBeVisible();
  }

  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Published coding correctness versus reported API cost' })
    .getByRole('button')).toHaveCount(eligible.length);
  await page.getByRole('checkbox', { name: 'Show 95% intervals', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Start score axis at 0%', exact: true }).check();
  await expect(page.getByText(/Score axis: 0% to/)).toBeVisible();
  await page.getByRole('checkbox', { name: 'Show 95% intervals', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Start score axis at 0%', exact: true }).uncheck();

  await page.getByRole('button', { name: /Published baseline/ }).click();
  await page.getByRole('option', { name: eligible[0].model, exact: true }).click();
  await page.getByRole('button', { name: /Published contender/ }).click();
  await page.getByRole('option', { name: eligible[1].model, exact: true }).click();
  const pairedPending = page.waitForResponse((response) => actionIs(response, 'benchmarks.public'));
  await page.getByRole('button', { name: 'Compare paired outcomes', exact: true }).click();
  const paired = await resultOf<PublicBenchmarks>(await pairedPending);
  const outcomes = paired.paired!;
  expect(outcomes.baseline).toBe(eligible[0].id);
  expect(outcomes.contender).toBe(eligible[1].id);
  expect(outcomes.contenderOnly + outcomes.baselineOnly + outcomes.bothResolved + outcomes.neitherResolved).toBe(500);
  await expect(page.getByText(/Contender only:/)).toBeVisible();
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export evidence', exact: true }).click();
  const download = await downloadPending;
  const exportPath = test.info().outputPath('published-evidence.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(await fs.readFile(exportPath, 'utf8')) as PublicBenchmarks;
  expect(exported.sourceSha256).toBe(paired.sourceSha256);
  expect(exported.paired).toEqual(paired.paired);
  await fs.writeFile(test.info().outputPath('public-evidence-checks.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), sourceHash: source.sourceSha256,
    cohort: source.selectedCohort, comparableRecords: eligible.length,
    excludedRecords: source.rows!.length - eligible.length, paired: outcomes, errors,
  }, null, 2));
  expect(errors).toEqual([]);
});

test('real run reports survive save, reload, threshold changes and Advisor inspection', async ({ page }) => {
  test.skip(REPORTS.length < 2, 'Provide at least two private, measured reports from the same workload.');
  test.setTimeout(480_000);
  const runs = await Promise.all(REPORTS.map(async (path) =>
    JSON.parse(await fs.readFile(path, 'utf8')) as BenchmarkRun));
  expect(runs.every((run) => run.state === 'completed')).toBe(true);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Force restore from the account so a local draft cannot mask a save failure.
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith('eddie.case.')) throw new DOMException('QA draft cache disabled', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('eddie.case.')) throw new DOMException('QA draft cache disabled', 'SecurityError');
      return set.call(this, key, value);
    };
  });
  const caseId = `measured-evidence-${randomUUID()}`;
  await openTests(page, caseId);
  const importedPending = page.waitForResponse((response) => actionIs(response, 'evaluation.compare'));
  await page.getByLabel('Benchmark report files').setInputFiles(REPORTS);
  await resultOf<BenchmarkComparison>(await importedPending);
  await expect(page.getByText(`Imported ${runs.length} reports. Set your targets and compare.`, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save this project before leaving?' })).toBeVisible();
  await page.getByRole('button', { name: 'Stay here', exact: true }).click();

  const comparePending = page.waitForResponse((response) => actionIs(response, 'evaluation.compare'));
  await page.getByRole('button', { name: 'Compare benchmark runs', exact: true }).click();
  const result = await resultOf<BenchmarkComparison>(await comparePending);
  expect(result.rows).toHaveLength(runs.length);
  expect(result.deploymentQualified).toBe(false);
  expect(result.rows.every((row) => row.p95Ms !== null && row.costUsd !== null)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Observed quality, speed and cost', exact: true })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Maximum observed p95 (ms)', exact: true }).fill('1000');
  await expect(page.getByText('Comparison inputs changed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export comparison', exact: true })).toBeDisabled();
  const updatedPending = page.waitForResponse((response) => actionIs(response, 'evaluation.compare'));
  await page.getByRole('button', { name: 'Compare benchmark runs', exact: true }).click();
  const updated = await resultOf<BenchmarkComparison>(await updatedPending);
  expect(updated.settings.maximumP95Ms).toBe(1000);
  const savePending = page.waitForResponse((response) => actionIs(response, 'case.save'));
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const saved = await resultOf<{ project: { document: { evaluationDraft: { benchmarkRuns: BenchmarkRun[] } } } }>(await savePending);
  expect(saved.project.document.evaluationDraft.benchmarkRuns).toEqual(runs);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Observed quality, speed and cost', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Maximum observed p95 (ms)', exact: true })).toHaveValue('1000');
  await expect(page.getByRole('button', { name: 'Export comparison', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'EDDIE Advisor', exact: true }).click();
  const advisor = page.getByRole('region', { name: 'Advisor conversation and controls', exact: true });
  const pendingChat = page.waitForResponse((response) => actionIs(response, 'chat'));
  await advisor.getByRole('textbox', { name: 'Message EDDIE Advisor', exact: true }).fill(
    'Read my imported benchmark results. State how many requests were scheduled for each configuration, ' +
    'whether these examples establish production quality, and whether any run is missing usage or price evidence. ' +
    'Use the recorded evidence. Do not invoke a model endpoint or change the project.'
  );
  await advisor.getByRole('button', { name: 'Send to Advisor', exact: true }).click();
  const chat = await resultOf<Record<string, unknown>>(await pendingChat);
  expect(chat.status).toBe('COMPLETE');
  const request = (await pendingChat).request().postDataJSON().payload;
  expect(request.benchmarkRuns).toHaveLength(runs.length);
  await expect(advisor.getByTestId('answer-complete').last()).toBeVisible();
  await fs.writeFile(test.info().outputPath('workload-evidence-checks.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), caseId, importedRunIds: runs.map((run) => run.runId),
    comparison: updated, savedAndRestored: true, chat, errors,
  }, null, 2));
  expect(errors).toEqual([]);
});
