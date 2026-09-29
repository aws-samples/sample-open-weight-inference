import { BrandName, brandText } from './BrandName';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useApp } from '../state/AppContext';
import { useCase } from '../state/CaseContext';
import type { DeploymentCapability, DeploymentPlanReview, DeploymentView } from '../api/types';

const PERIODS = [
  { label: '30 minutes', value: '30' },
  { label: '45 minutes', value: '45' },
  { label: '1 hour', value: '60' },
];

function canonical(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export async function caseFingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Native APIs do not depend on whether this installation can create GPU endpoints. */
export function NativeBedrockAccess() {
  const { form } = useCase();
  const navigate = useNavigate();
  return <Container header={<Header variant="h2">Use your selected Bedrock model</Header>}>
    <SpaceBetween size="m">
      <Box fontWeight="bold">{form.modelName}</Box>
      <Box>
        This model is already hosted by AWS. You do not need to create a SageMaker endpoint or import model files.
        Your application calls Bedrock with AWS authentication and the required model-access permissions.
      </Box>
      {form.inferenceProfileId ? <Box>Request route: {form.inferenceProfileId}. Allowed processing Regions: {form.permittedProcessingRegions || 'Not specified'}.</Box> : null}
      <StatusIndicator type="info">
        This installation can discover the model and estimate text costs. It does not yet set up native-model access
        or run an authenticated native-model test. No endpoint has been created.
      </StatusIndicator>
      <SpaceBetween direction="horizontal" size="s">
        <Button onClick={() => navigate(`/requirements?case=${encodeURIComponent(form.caseId)}&view=hosting`)}>Return to comparison</Button>
        <Link external href="https://docs.aws.amazon.com/bedrock/latest/userguide/inference.html">Using Bedrock inference</Link>
      </SpaceBetween>
    </SpaceBetween>
  </Container>;
}

/** Review is an optional destination, never a wizard or a hidden approval in chat. */
export function TestDeployment({ capability, onStarted }: {
  capability: DeploymentCapability;
  onStarted: (job: DeploymentView) => void;
}) {
  const { client } = useApp();
  const { form, changeModel, inspectModel, inspecting } = useCase();
  const navigate = useNavigate();
  const [minutes, setMinutes] = useState('45');
  const [ceiling, setCeiling] = useState('5');
  const [review, setReview] = useState<DeploymentPlanReview | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [busy, setBusy] = useState<'prepare' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [costAccepted, setCostAccepted] = useState(false);
  const recipe = capability.recipes?.[0];
  const isCheckpoint = form.sourceKind === 'checkpoint';
  const source = isCheckpoint ? (form.sourceLocation ?? '').trim() :
    form.hfRepo.trim().replace(/^https:\/\/huggingface.co\//, '').replace(/\/$/, '');
  const regions = form.permittedRegions.split(',').map((r) => r.trim()).filter(Boolean);
  const region = regions.length === 1 ? regions[0] : recipe?.region ?? '';
  const supported = isCheckpoint
    ? !!form.artifactDigest && !!capability.checkpointRecipe?.available
    : recipe?.models.includes(source) ?? false;
  const regionAllowed = !!recipe && regions.includes(recipe.region) && region === recipe.region;
  const formKey = canonical(form as unknown as Record<string, unknown>);
  const keyRef = useRef(formKey);
  keyRef.current = formKey;
  const restoredFor = useRef('');
  const interactionVersion = useRef(0);

  useEffect(() => {
    let current = true;
    setFingerprint('');
    void caseFingerprint(formKey).then((value) => { if (current) setFingerprint(value); });
    return () => { current = false; };
  }, [formKey]);

  // Restore a server-owned plan, not a browser-authored price/approval. An expired
  // plan remains visible as a review that needs to be refreshed.
  useEffect(() => {
    if (!fingerprint || restoredFor.current === fingerprint) return;
    restoredFor.current = fingerprint;
    const startedBeforeEdit = interactionVersion.current;
    let current = true;
    void client.listDeploymentPlans().then(async ({ plans }) => {
      const matching = plans.filter((p) => !p.startedJobId && p.evaluatedRequestHash === fingerprint)
        .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
      if (!matching || !current || interactionVersion.current !== startedBeforeEdit) return;
      const saved = await client.getDeploymentPlan(matching.planId);
      if (!current || interactionVersion.current !== startedBeforeEdit || !saved.model || !saved.cost) return;
      setReview(saved);
      setMinutes(String(saved.plan.envelope.maxLifetimeMinutes));
      setCeiling(saved.plan.envelope.maxSpendUsd);
    }).catch(() => {
      // A failed restore does not imply that a prepared plan or running job vanished.
      if (current) setError('Saved plans could not be loaded. Refresh before preparing another test.');
    });
    return () => { current = false; };
  }, [client, fingerprint]);

  const plan = review?.plan;
  const expired = !!plan && (plan.expired || Date.parse(plan.expiresAt) <= Date.now());
  const stale = !!plan && (
    plan.evaluatedRequestHash !== fingerprint || !fingerprint ||
    plan.envelope.maxLifetimeMinutes !== Number(minutes) ||
    Number(plan.envelope.maxSpendUsd) !== Number(ceiling)
  );
  useEffect(() => {
    setTerms(false);
    setCostAccepted(false);
  }, [formKey, minutes, ceiling, plan?.planHash]);

  async function prepare() {
    interactionVersion.current += 1;
    setError(null);
    setBusy('prepare');
    const before = keyRef.current;
    try {
      const identity = await caseFingerprint(before);
      const result = await client.prepareTestDeployment({
        source, revision: (isCheckpoint ? form.artifactDigest : form.hfCommit) || undefined, region,
        lifetimeMinutes: Number(minutes), maxSpendUsd: ceiling, caseFingerprint: identity,
      });
      setReview(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(null); }
  }

  async function start() {
    if (!plan || stale || expired || !terms || !costAccepted || !plan.approvable) return;
    setError(null);
    setBusy('start');
    try {
      const result = await client.approveTestDeployment(plan);
      onStarted(result.deployment);
      setReview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(null); }
  }

  const selectSmallModel = () => {
    const model = recipe?.models[0];
    if (!model) return;
    changeModel({ modelName: model.split('/')[1], hfRepo: model, modelIntent: 'specific',
                  sourceKind: 'huggingface', weightsExportable: true });
    void inspectModel(model);
  };

  return (
    <SpaceBetween size="l">
      <Container header={
        <Header variant="h2" description="Check the cost, then start a temporary model test. You can send questions once it’s ready.">
          Try your model on AWS
        </Header>
      }>
        <SpaceBetween size="m">
          {error ? <Alert type="error" header="This test needs attention">{error}</Alert> : null}
          {!supported ? (
            <SpaceBetween size="s">
              <Box>
                {source ? `The model you selected (${source}) is not available for deployment in this installation yet.` : 'Choose a model to try.'}
              </Box>
              <Box variant="small" color="text-body-secondary">
                This installation can run short tests of Qwen2.5 0.5B and 1.5B Instruct.
                {capability.checkpointRecipe?.available ? ' It also accepts inspected, complete Qwen2.5 fine-tuned checkpoints from your private library.' : ''}
                {' '}Answer quality still needs evaluation.
              </Box>
              <SpaceBetween direction="horizontal" size="xs">
                {form.modelStage !== 'fine-tuned' ? <Button onClick={selectSmallModel} loading={inspecting}>Choose Qwen2.5 0.5B for this project</Button> : null}
                <Button onClick={() => navigate(`/requirements?case=${encodeURIComponent(form.caseId)}&view=models${form.modelStage === 'fine-tuned' ? '&source=company' : ''}`)}>
                  {form.modelStage === 'fine-tuned' ? 'Choose your fine-tuned checkpoint' : 'Explore models'}
                </Button>
              </SpaceBetween>
            </SpaceBetween>
          ) : (
            <>
              <Box fontWeight="bold">{isCheckpoint ? form.modelName : source}</Box>
              {isCheckpoint ? <Box variant="small">This test uses the inspected fine-tuned checkpoint. Its base model will not be substituted.</Box> : null}
              {!regionAllowed ? (
                <Alert type="info" header="This Region is not available for deployment here"
                  action={<Button onClick={() => navigate('/requirements?view=needs')}>Review your Region</Button>}>
                  Your project permits {regions.join(', ') || 'no Region yet'}. This installation deploys in {recipe?.region}.{' '}
                  <BrandName /> will not change your Region automatically.
                </Alert>
              ) : <Box variant="small" color="text-body-secondary">Amazon SageMaker · {region} · one GPU instance</Box>}
              <ColumnLayout columns={2}>
                <FormField label="How long should the test last?" description="Includes preparation time. Removal starts at the end of this period.">
                  <Select ariaLabel="Test duration" selectedOption={PERIODS.find((p) => p.value === minutes) ?? null}
                    options={PERIODS} onChange={({ detail }) => { interactionVersion.current += 1; setMinutes(detail.selectedOption.value ?? '45'); }}
                    disabled={busy === 'start'} />
                </FormField>
                <FormField label="Test budget (USD)" description={brandText("EDDIE checks the estimate against this amount before it starts.")}>
                  <Input ariaLabel="Test budget in USD" type="number" value={ceiling}
                    onChange={({ detail }) => { interactionVersion.current += 1; setCeiling(detail.value); }} disabled={busy === 'start'} />
                </FormField>
              </ColumnLayout>
              <Button variant={!review || stale || expired ? 'primary' : 'normal'}
                onClick={() => void prepare()} loading={busy === 'prepare'}
                disabled={!regionAllowed || inspecting || busy === 'start' || !ceiling || !fingerprint}>
                {review ? 'Prepare updated plan' : 'Review test deployment'}
              </Button>
              {busy === 'prepare' ? <StatusIndicator type="loading">Checking the model, live hosting price and deployment guardrails</StatusIndicator> : null}
            </>
          )}
        </SpaceBetween>
      </Container>

      {review ? (
        <Container header={<Header variant="h2">Review this test</Header>} data-testid="test-deployment-review">
          <SpaceBetween size="m">
            {stale || expired ? (
              <Alert type="warning" header={expired ? 'This plan has expired' : 'Your settings changed'}>
                Prepare an updated plan before approving. Nothing has been deployed from this review.
              </Alert>
            ) : null}
            <ColumnLayout columns={3} variant="text-grid">
              <div><Box variant="small" color="text-label">Hosting estimate</Box>
                <Box variant="h2">${review.cost.hostingEstimateUsd}</Box>
                <Box variant="small">${Number(review.cost.hourlyUsd).toLocaleString('en-US', { maximumFractionDigits: 6 })}/hour · up to {plan!.envelope.maxLifetimeMinutes} minutes</Box></div>
              <div><Box variant="small" color="text-label">Estimate including cleanup</Box>
                <Box variant="h2">${review.cost.admissionEstimateUsd}</Box>
                <Box variant="small">Includes a {review.cost.cleanupBufferMinutes}-minute cleanup buffer and ${review.cost.additionalAllowanceUsd} allowance for other usage.</Box></div>
              <div><Box variant="small" color="text-label">Where it runs</Box>
                <Box fontWeight="bold">Amazon SageMaker</Box>
                <Box>{plan!.region}</Box>
                <Box variant="small">Private model network · sign-in required to invoke</Box></div>
            </ColumnLayout>
            <Box>
              Model: <strong>{review.model.source}</strong>. This creates a trial; it does not certify answer quality or response-time targets.
            </Box>
            {plan!.blockers.length ? (
              <Alert type="warning" header="Resolve these checks before starting">
                <ul className="eddie-readable-list">{plan!.blockers.map((c) => <li key={c.checkId}>{c.observedResult}</li>)}</ul>
              </Alert>
            ) : (
              <StatusIndicator type="success">Pre-deployment checks passed</StatusIndicator>
            )}
            <ExpandableSection headerText="Price evidence and technical details">
              <SpaceBetween size="s">
                <Box variant="small">Model revision: {review.model.revision}</Box>
                <Box variant="small">AWS account: {plan!.accountId} · {plan!.envelope.instanceType}</Box>
                <Box variant="small">Price List SKU: {review.cost.priceEvidence.sku} · retrieved {review.cost.priceEvidence.retrievedAt}</Box>
                <ul className="eddie-readable-list">{plan!.checks.map((c) => <li key={c.checkId}>{c.observedResult}</li>)}</ul>
                <Box variant="small">Plan fingerprint: {plan!.planHash}</Box>
              </SpaceBetween>
            </ExpandableSection>
            <Checkbox checked={terms} onChange={({ detail }) => setTerms(detail.checked)} disabled={stale || expired}>
              I have reviewed the <Link external href={review.model.licenseUrl}>model’s usage terms</Link> ({review.model.license}).
            </Checkbox>
            <Checkbox checked={costAccepted} onChange={({ detail }) => setCostAccepted(detail.checked)} disabled={stale || expired}>
              I approve this test’s cost and {plan!.envelope.maxLifetimeMinutes}-minute lifetime.
            </Checkbox>
            <Box variant="small" color="text-body-secondary">
              AWS charges until removal is confirmed. A delayed removal can exceed the estimate; this budget check cannot guarantee a final bill.
            </Box>
            <SpaceBetween direction="horizontal" size="s">
              <Button variant="primary" onClick={() => void start()} loading={busy === 'start'}
                disabled={stale || expired || !plan!.approvable || !terms || !costAccepted || busy === 'prepare'}>
                Approve and start test
              </Button>
              <Button disabled={busy === 'start'} onClick={() => setReview(null)}>Close review</Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>
      ) : null}
    </SpaceBetween>
  );
}
