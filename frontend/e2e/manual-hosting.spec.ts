import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { EvaluateResponse } from '../src/api/types';

const SITE = (process.env.EDDIE_SITE_URL ?? '').replace(/\/$/, '');
const STATE = process.env.EDDIE_AUTH_STATE;
test.skip(!SITE || !STATE, 'A real Cognito browser session and site are required.');
test.use({ storageState: STATE, trace: 'off', actionTimeout: 30_000 });

function actionIs(response: Response, action: string) {
  try { return response.url().includes('/invocations') && response.request().postDataJSON()?.action === action; }
  catch { return false; }
}

async function resultOf<T = any>(response: Response): Promise<T> {
  expect(response.status()).toBe(200);
  const text = await response.text();
  if (response.headers()['content-type']?.includes('text/event-stream')) {
    const frames = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
    expect(frames.filter((frame) => frame.event === 'error')).toEqual([]);
    const complete = frames.find((frame) => frame.event === 'complete' || frame.event === 'result');
    expect(complete?.ok).toBe(true);
    return complete.result;
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
  const response = page.waitForResponse((r) => actionIs(r, 'case.save'));
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const saved = await resultOf(await response);
  await expect(page.getByText(/Saved to your account at/)).toBeVisible();
  return saved.project;
}

async function compare(page: Page, button = 'Update comparison') {
  const pending = page.waitForResponse((r) => actionIs(r, 'evaluate'));
  await page.getByRole('button', { name: button, exact: true }).click();
  return resultOf<EvaluateResponse>(await pending);
}

function all(result: EvaluateResponse) {
  return [...result.ranked, ...result.unresolved, ...result.excluded];
}

async function explorePath(map: Locator, name: string) {
  await map.getByRole('button', { name, exact: true }).click();
  // Wait for the real smooth scroll to reach its destination. Disabling CSS
  // animations in a screenshot does not finish a programmatic smooth scroll.
  await expect.poll(async () => {
    const [heading, details, footer] = await Promise.all([
      map.getByRole('heading', { name: 'How EDDIE reached this result', exact: true }).boundingBox(),
      map.getByRole('region', { name: 'Selected hosting path', exact: true }).boundingBox(),
      map.getByRole('button', { name: 'Back to comparison', exact: true }).boundingBox(),
    ]);
    if (!heading || !details || !footer) return false;
    const gap = details.y - heading.y - heading.height;
    return gap >= -8 && (gap <= 60 || details.y + details.height <= footer.y);
  }).toBe(true);
}

test('manual Bedrock and SageMaker paths retain inputs, price honestly and switch projects', async ({ page }) => {
  test.setTimeout(480_000);
  const stamp = randomUUID().slice(0, 8);
  const nativeCase = `manual-bedrock-${stamp}`;
  const nativeGoal = `QA ${stamp} Bedrock support desk: classify tickets and draft a reply for a person to review.`;
  const smGoal = `QA ${stamp} Qwen support desk: test our chosen open-weight model for ticket classification.`;
  const ids = [nativeCase];
  const actions: string[] = [];
  const errors: string[] = [];
  const evidence: Record<string, unknown> = {
    site: SITE, checkedAt: new Date().toISOString(), casesCreated: ids,
    inputs: 'User-entered planning estimates for a realistic support-desk scenario',
    authentication: 'Real Cognito; no authentication bypass or stubbed AWS responses',
    workloadResourcesCreated: false,
  };
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (request) => {
    if (request.url().includes('/invocations')) {
      try { actions.push(request.postDataJSON().action); } catch { /* Never capture tokens. */ }
    }
  });
  const capture = async (name: string) => {
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
    await fs.writeFile(test.info().outputPath(`${name}.txt`), await page.locator('body').innerText());
  };
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${SITE}/requirements?case=${nativeCase}&view=needs`);
    await expect(page.getByRole('heading', { name: 'Your AI project', exact: true })).toBeVisible();
    // Advisor remains available but closed. The entire task uses manual controls.
    await expect(page.getByRole('button', { name: 'EDDIE Advisor', exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('For example: Why SageMaker instead of Bedrock?')).not.toBeVisible();
    await page.getByRole('textbox', { name: 'Your goal', exact: true }).fill(nativeGoal);
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('2000');
    // Do not commit with Enter/blur first: this reproduced silent numeric-field loss.
    await page.getByRole('button', { name: /^When will people use it\?/ }).click();
    await page.getByRole('option', { name: 'Available all the time', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true })).toHaveValue('2000');
    await page.getByRole('spinbutton', { name: 'Comparison period in days', exact: true }).fill('30');

    await section(page, 'Models & sources');
    await page.getByRole('button', { name: 'Amazon Bedrock', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Filter models', exact: true }).fill('amazon.nova-2-lite-v1:0');
    await page.getByRole('row').filter({ has: page.getByText('amazon.nova-2-lite-v1:0', { exact: true }) })
      .getByRole('button', { name: 'Use Nova 2 Lite', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Compare hosting for this model', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: /Bedrock request route/ }).click();
    await page.getByRole('option', { name: /US Amazon Nova 2 Lite/ }).click();
    await capture('01-native-model-and-explicit-route');
    const empty = await compare(page, 'Compare hosting for this model');
    expect(all(empty)).toHaveLength(1);
    expect(all(empty)[0].target).toBe('BEDROCK_NATIVE');
    expect(all(empty)[0].cost).toBeNull();
    expect(empty.nativePricing?.[0].missingUsage).toHaveLength(3);
    await expect(page.getByText('Add usage for a total', { exact: true })).toBeVisible();

    const usage = page.getByTestId('native-usage');
    await usage.getByRole('spinbutton', { name: 'API requests during comparison period' }).fill('30000');
    await usage.getByRole('spinbutton', { name: 'API average input tokens' }).fill('1000');
    await usage.getByRole('spinbutton', { name: 'API average output tokens' }).fill('250');
    const priced = await compare(page);
    const quote = priced.nativePricing![0];
    expect(quote.inputRate?.sku).toBeTruthy();
    expect(quote.outputRate?.sku).toBeTruthy();
    const arithmetic = 30 * Number(quote.inputRate!.amount) + 7.5 * Number(quote.outputRate!.amount);
    expect(Number(all(priced)[0].cost?.totalExact)).toBeCloseTo(arithmetic, 7);
    expect(priced.winner).toBeNull();
    expect(priced.qualification?.performanceMeasured).toBe(false);
    expect(quote.processingRegions).toEqual(['us-east-1', 'us-east-2', 'us-west-2']);
    expect(all(priced).every((c) => c.target === 'BEDROCK_NATIVE')).toBe(true);
    await expect(page.getByText('How the Bedrock estimate was calculated', { exact: true })).toBeVisible();
    await expect(page.getByText('Dedicated GPU · billed while running')).toHaveCount(0);
    evidence.nativeQuote = priced;
    await capture('02-native-token-cost-and-evidence');

    const map = page.getByRole('dialog', { name: 'How EDDIE reached this result', exact: true });
    const comparedBeforeMap = actions.filter((a) => a === 'evaluate').length;
    await page.getByRole('button', { name: 'View decision map', exact: true }).click();
    await expect(map.getByTestId('decision-branch-native')).toContainText('Needs verification');
    await expect(map.getByTestId('decision-branch-import')).toContainText('Not evaluated');
    await expect(map.getByTestId('decision-branch-sagemaker')).toContainText('Not evaluated');
    await expect(map.getByText('Allowed processing locations: us-east-1, us-east-2, us-west-2', { exact: true })).toBeVisible();
    await map.screenshot({ path: test.info().outputPath('map-01-native-overview-light.png'), animations: 'disabled' });
    await explorePath(map, 'Explore Bedrock model API');
    const checks = map.getByRole('region', { name: 'Recorded requirement checks', exact: true });
    await checks.getByRole('button', { name: 'Account quota', exact: true }).click();
    const quotaReason = all(priced)[0].gates.find((gate) => gate.name === 'quota')!.reason!;
    await expect(checks.getByText(quotaReason, { exact: true })).toBeVisible();
    await expect(checks.getByText('Not requested', { exact: true }).first()).toBeVisible();
    await expect(map.getByRole('heading', { name: 'How EDDIE reached this result', exact: true })).toBeInViewport();
    await map.screenshot({ path: test.info().outputPath('map-02-native-recorded-checks.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(map).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'View decision map', exact: true })).toBeFocused();
    expect(actions.filter((a) => a === 'evaluate')).toHaveLength(comparedBeforeMap);
    evidence.nativeDecisionMap = { actualQuotaReasonShown: true, notEvaluatedIsNotFailure: true,
      absentObjectiveNotMeasured: true, escapeRestoresFocus: true, noExtraEvaluation: true };

    await usage.getByRole('spinbutton', { name: 'API requests during comparison period' }).fill('60000');
    const doubled = await compare(page);
    expect(Number(all(doubled)[0].cost?.totalExact)).toBeCloseTo(arithmetic * 2, 7);
    await usage.getByRole('spinbutton', { name: 'API requests during comparison period' }).fill('30000');
    await section(page, 'Your needs');
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('20');
    await section(page, 'Compare hosting');
    const budget = await compare(page);
    expect(all(budget)[0].cost?.totalExact).toBe(all(priced)[0].cost?.totalExact);
    expect(budget.excluded[0].gates.some((g) => g.name === 'budget' && g.status === 'FAIL')).toBe(true);
    evidence.lowerBudget = budget;
    await page.getByRole('button', { name: 'View decision map', exact: true }).click();
    await expect(map.getByTestId('decision-branch-native')).toContainText('Ruled out');
    await explorePath(map, 'Explore Bedrock model API');
    await checks.getByRole('button', { name: 'Budget', exact: true }).click();
    await expect(checks.getByText(budget.excluded[0].gates.find((g) => g.name === 'budget')!.reason!, { exact: true })).toBeVisible();
    await map.screenshot({ path: test.info().outputPath('map-03-budget-changes-the-path.png'), animations: 'disabled' });
    await map.getByRole('button', { name: 'Back to comparison', exact: true }).click();

    await section(page, 'Your needs');
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('2000');
    await page.getByRole('checkbox', { name: 'I have a response-time target', exact: true }).check();
    await page.getByRole('button', { name: /Response-time measure/ }).click();
    await page.getByRole('option', { name: 'The first words appear', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Response target in seconds', exact: true }).fill('1');
    await section(page, 'Compare hosting');
    const latency = await compare(page);
    expect((latency.evaluatedRequest?.slos as any[])[0]).toMatchObject({ metric: 'ttft_ms', thresholdMs: '1000', includeCold: true });
    expect(all(latency)[0].gates.find((g) => g.name === 'latency')?.status).toBe('UNKNOWN');
    expect(latency.qualification?.performanceMeasured).toBe(false);
    evidence.unmeasuredLatency = latency;
    const savedNative = await save(page);
    expect(savedNative.document.form.inferenceProfileId).toBe('us.amazon.nova-2-lite-v1:0');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your AI project', exact: true })).toBeVisible();
    await expect(page.getByText('How the Bedrock estimate was calculated', { exact: true })).toBeVisible();
    await expect(page.getByTestId('comparison-needs-update')).toHaveCount(0);

    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your goal', exact: true })).toHaveValue('');
    const smCase = new URL(page.url()).searchParams.get('case')!;
    ids.push(smCase);
    await page.getByRole('textbox', { name: 'Your goal', exact: true }).fill(smGoal);
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('2000');
    await page.getByRole('button', { name: /^When will people use it\?/ }).click();
    await page.getByRole('option', { name: 'Available all the time', exact: true }).click();
    await section(page, 'Models & sources');
    await page.getByRole('textbox', { name: 'Hugging Face model source', exact: true }).fill('Qwen/Qwen2.5-1.5B-Instruct');
    const inspected = page.waitForResponse((r) => actionIs(r, 'inspect_model'));
    await page.getByRole('button', { name: 'Read model details', exact: true }).click();
    const inspection = await resultOf(await inspected);
    expect(inspection.ok).toBe(true);
    expect(inspection.revision).toMatch(/^[a-f0-9]{40}$/);
    const sm = await compare(page, 'Compare hosting for this model');
    expect(all(sm).some((c) => c.target === 'SAGEMAKER_REALTIME' && c.cost?.total)).toBe(true);
    expect(all(sm).some((c) => c.target === 'BEDROCK_NATIVE')).toBe(false);
    expect((sm.evaluatedRequest?.model as any).hfRepo).toBe('Qwen/Qwen2.5-1.5B-Instruct');
    expect((sm.evaluatedRequest?.model as any).inferenceProfileId).toBeNull();
    evidence.sagemakerComparison = sm;
    await capture('03-sagemaker-manual-comparison');
    await page.getByRole('button', { name: 'Explain Amazon SageMaker · ml.g6.2xlarge', exact: true }).click();
    await expect(map.getByRole('button', { name: /Configuration to explain/ })).toContainText('ml.g6.2xlarge');
    await map.screenshot({ path: test.info().outputPath('map-04-sagemaker-overview-light.png'), animations: 'disabled' });
    await explorePath(map, 'Explore EC2 / EKS GPUs');
    await expect(map.getByRole('region', { name: 'Selected hosting path', exact: true })).toContainText('AWS availability has not been ruled out');
    await map.getByRole('button', { name: 'Back to comparison', exact: true }).click();
    const darkMode = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
    if (await darkMode.isVisible()) await darkMode.click();
    await page.getByRole('button', { name: 'View decision map', exact: true }).click();
    await map.screenshot({ path: test.info().outputPath('map-05-overview-dark.png'), animations: 'disabled' });
    await explorePath(map, 'Explore SageMaker');
    await checks.getByRole('button', { name: 'Account quota', exact: true }).click();
    await expect(map.getByRole('heading', { name: 'How EDDIE reached this result', exact: true })).toBeInViewport();
    await map.screenshot({ path: test.info().outputPath('map-06-sagemaker-checks-dark.png'), animations: 'disabled' });
    await map.getByRole('button', { name: 'Challenge this option', exact: true }).click();
    await expect(map).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Message EDDIE Advisor', exact: true });
    await expect(composer).toHaveValue(new RegExp(sm.requestHash));
    await expect(composer).toHaveValue(/Help me challenge the Amazon SageMaker/);
    expect(actions.filter((a) => a === 'chat')).toEqual([]);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    evidence.sagemakerDecisionMap = { exactConfigurationOpened: true, gpuGapExplained: true,
      lightAndDarkInspected: true, challengeDraftedWithoutSending: true };
    await save(page);

    // The older project is reachable directly, with no detour through chat.
    await page.getByRole('button', { name: /Switch project/ }).click();
    await page.getByRole('option', { name: new RegExp(`QA ${stamp} Bedrock`) }).click();
    await expect(page.getByRole('textbox', { name: 'Your goal', exact: true })).toHaveValue(nativeGoal);
    await expect(page).toHaveURL(new RegExp(`case=${nativeCase}`));
    await page.getByRole('link', { name: 'Project workspace', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`case=${nativeCase}`));
    await expect(page.getByRole('textbox', { name: 'Your goal', exact: true })).toHaveValue(nativeGoal);

    // A project change must not discard a field that has not been saved.
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('1999');
    await page.getByRole('button', { name: /Switch project/ }).click();
    await page.getByRole('option', { name: new RegExp(`QA ${stamp} Qwen`) }).click();
    await expect(page.getByRole('dialog', { name: 'Save this project before leaving?' })).toBeVisible();
    await page.getByRole('button', { name: 'Stay here', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true })).toHaveValue('1999');
    await page.getByRole('spinbutton', { name: 'Hosting budget in USD', exact: true }).fill('2000');
    await section(page, 'Models & sources');
    await expect(page.getByText('Selected Bedrock model', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Bedrock request route/ })).toContainText('US Amazon Nova 2 Lite');
    await capture('04-older-project-restored-with-route');
    await section(page, 'Deploy & monitor');
    await expect(page.getByRole('heading', { name: 'Use your selected Bedrock model', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review test deployment', exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Escape');
    await section(page, 'Compare hosting');
    await capture('05-mobile-native-comparison');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'View decision map', exact: true }).click();
    await map.screenshot({ path: test.info().outputPath('map-07-mobile-paths.png'), animations: 'disabled' });
    expect(await map.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await explorePath(map, 'Explore Bedrock model API');
    await expect(map.getByRole('region', { name: 'Selected hosting path', exact: true })).toBeInViewport();
    await expect(map.getByRole('heading', { name: 'How EDDIE reached this result', exact: true })).toBeInViewport();
    await map.screenshot({ path: test.info().outputPath('map-08-mobile-checks.png'), animations: 'disabled' });
    await map.getByRole('button', { name: 'Back to comparison', exact: true }).click();
    evidence.mobileDecisionMap = { width: 390, noHorizontalOverflow: true, selectedPathBroughtIntoView: true };
    expect(actions.filter((a) => a === 'chat')).toEqual([]);
    expect(actions.filter((a) => /^(plan.create|plan.approve|deployment.invoke|deployment.delete|demo.wake|demo.sleep)$/.test(a))).toEqual([]);
    expect(errors).toEqual([]);
    evidence.passed = true;
  } finally {
    await fs.writeFile(test.info().outputPath('evidence.json'), JSON.stringify({ ...evidence, actions, errors }, null, 2));
  }
});
