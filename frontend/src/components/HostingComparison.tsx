import { BrandName, brandText } from './BrandName';
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import type { Candidate, EvaluateResponse, Gate } from '../api/types';
import { CandidateDetail } from './CandidateDetail';
import { ResultsPanel, type ResultsPanelProps } from './ResultsPanel';
import { formatMoney, formatTimestamp, toNumber } from './format';
import { NativePriceEvidence } from './NativePriceEvidence';
import { comparisonPeriod, hostingOptionName } from './hostingLabels';
import { DecisionMap, type DecisionMapActions } from './DecisionMap';

export { comparisonPeriod, hostingOptionName } from './hostingLabels';

export function comparisonHeadline(result: EvaluateResponse): string {
  if (result.winner) {
    return result.checksStipulated || result.qualification?.conditional
      ? 'Cost comparison ready'
      : 'A hosting option meets your requirements';
  }
  if ((result.unresolved ?? []).length > 0) {
    return (result.unresolved ?? []).some((candidate) => toNumber(candidate.cost?.total) !== null)
      ? 'Costs are ready. Verification is next.'
      : 'More information is needed';
  }
  return (result.excluded ?? []).length > 0
    ? 'No option meets these requirements'
    : 'No supported option found';
}

const CHECK_NAMES: Record<string, string> = {
  architecture: 'Model compatibility',
  modality: 'Input and output support',
  weights_exportable: 'Model files',
  license: 'Usage terms',
  licence: 'Usage terms',
  recipe: 'Serving configuration',
  quota: 'Account quota',
  capacity: 'Available capacity',
  latency: 'Response time',
  quality: 'Answer quality',
  budget: 'Budget',
  region: 'AWS Region',
  operations: 'Operational requirements',
  cpu_runtime: 'CPU runtime',
  cpu_memory: 'CPU memory',
  cpu_delivery: 'Delivery and workload',
};

function checkName(gate: Gate): string {
  return CHECK_NAMES[gate.name] ?? gate.name.replaceAll('_', ' ');
}

function optionStatus(candidate: Candidate): string {
  const failed = candidate.gates.filter((gate) => gate.status === 'FAIL');
  // A path that cannot run the model is not merely over budget: show the more basic
  // failure first, and the budget only when it is the sole reason.
  const blocking = failed.filter((gate) => gate.name !== 'budget');
  if (blocking.length > 0) return `${checkName(blocking[0])} not met`;
  if (failed.length > 0) return 'Over budget';
  if (candidate.gates.some((gate) => gate.status === 'UNKNOWN')) return 'Needs verification';
  return 'Passed declared checks';
}

function NextChecks({ candidates }: { candidates: Candidate[] }) {
  const nativeOnly = candidates.length > 0 && candidates.every((candidate) => candidate.target === 'BEDROCK_NATIVE');
  const unknown = new Set(
    candidates.flatMap((candidate) =>
      candidate.gates.filter((gate) => gate.status === 'UNKNOWN').map((gate) => gate.name)
    )
  );
  if (unknown.size === 0) return null;
  const checks: { title: string; detail: string }[] = [];
  if (unknown.has('quality')) {
    checks.push({ title: 'Test the model’s output', detail: 'Use representative inputs and an agreed acceptance rule for your task.' });
  }
  if (unknown.has('latency')) {
    checks.push({
      title: 'Test response time',
      detail: 'A benchmark of this model and workload is needed to confirm your speed target.',
    });
  }
  if (unknown.has('cpu_delivery')) {
    checks.push({ title: 'Confirm the CPU workload',
      detail: 'Specify live output versus queued jobs, completion deadline, concurrency and volume. Missing targets do not exclude CPU.' });
  }
  if (unknown.has('quota') || unknown.has('capacity')) {
    checks.push({
      title: nativeOnly ? 'Check your account quota' : 'Check account availability',
      detail: nativeOnly
        ? 'Confirm request and token headroom for this model and request route.'
        : 'Confirm quota headroom and obtainable capacity in your chosen AWS Region.',
    });
  }
  if (unknown.has('license') || unknown.has('licence') || unknown.has('recipe')) {
    checks.push({
      title: nativeOnly ? 'Confirm model access' : 'Confirm the model can be deployed',
      detail: nativeOnly
        ? 'Verify your account can invoke this model and meets its usage terms. No GPU deployment is needed.'
        : 'Review its usage terms and validate the serving configuration.',
    });
  }
  const covered = new Set(['quality', 'latency', 'quota', 'capacity', 'license', 'licence', 'recipe', 'cpu_delivery']);
  if ([...unknown].some((name) => !covered.has(name))) {
    checks.push({
      title: 'Review the remaining requirements',
      detail: 'Open an option for the specific checks EDDIE could not complete.',
    });
  }
  return (
    <div data-testid="next-verification-checks">
      <Box variant="h3">Before choosing an option</Box>
      <ul className="eddie-next-checks">
        {checks.map(({ title, detail }) => (
          <li key={title}>
            <b>{title}.</b> {brandText(detail)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The primary comparison surface. Missing qualification does not erase a real
 * price quote, and a price quote does not qualify a hosting option. Only the
 * backend's ranked set is ranked; options awaiting checks keep backend order.
 */
function CurrentComparison({ result, historical = false, ...mapActions }: {
  result: EvaluateResponse; historical?: boolean;
} & DecisionMapActions) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // undefined = closed; null = overview; an ID opens that exact configuration.
  const [mapSelection, setMapSelection] = useState<string | null | undefined>(undefined);
  const ranked = result.ranked ?? [];
  const unresolved = result.unresolved ?? [];
  const excluded = result.excluded ?? [];
  const all = [...ranked, ...unresolved, ...excluded];
  const selected = all.find((candidate) => candidate.candidateId === selectedId);
  const period = comparisonPeriod(result.horizonHours);
  const freshness = Object.values(result.priceFreshness ?? {});
  const livePrices = freshness.length > 0 && freshness.every((value) => value === 'LIVE');
  const anyPrices = all.some((candidate) => toNumber(candidate.cost?.total) !== null);
  const conditional = result.checksStipulated || result.qualification?.conditional;
  const columns = [
    {
      id: 'option',
      header: 'Hosting option',
      cell: (candidate: Candidate) => (
        <SpaceBetween size="xxs">
          <Button
            variant="inline-link"
            onClick={() => setSelectedId(candidate.candidateId)}
            ariaLabel={`View details for ${hostingOptionName(candidate)}`}
          >
            {hostingOptionName(candidate)}
          </Button>
          <Box variant="small" color="text-body-secondary">
            {candidate.target === 'BEDROCK_CMI'
              ? 'Custom Model Import · billed for active copies'
              : candidate.target === 'BEDROCK_NATIVE' ? 'Native model · pay per token'
              : candidate.target === 'EC2_CPU' ? 'CPU only · billed while allocated'
              : candidate.target === 'AWS_BATCH_CPU' ? 'Queued CPU jobs · EC2 allocation billing'
              // SageMaker hosts both: ml.g*/ml.p* sizes carry GPUs; the speech recipe is CPU.
              : /^ml\.(g|p)\d/.test(candidate.instanceType ?? '') ? 'Dedicated GPU · billed while running'
              : 'Dedicated CPU · billed while running'}
          </Box>
          {candidate.target === 'BEDROCK_CMI' && candidate.cmusPerCopy ? (
            <Box variant="small" color="text-body-secondary">
              {candidate.notes?.includes('Assumed') ? 'Estimated sizing: ' : 'Sizing: '}
              {candidate.cmusPerCopy} model units per copy
            </Box>
          ) : null}
        </SpaceBetween>
      ),
    },
    {
      id: 'cost',
      header: `Estimated cost · ${period}`,
      cell: (candidate: Candidate) => (
        <SpaceBetween size="xxs">
          <Box fontWeight="bold">
            {toNumber(candidate.cost?.total) === null
              ? result.nativePricing?.some((q) => q.candidateId === candidate.candidateId && q.missingUsage.length)
                ? 'Add usage for a total'
                : candidate.target === 'EC2_CPU' || candidate.target === 'AWS_BATCH_CPU'
                  ? 'Complete the cost inputs' : 'Price unavailable'
              : formatMoney(candidate.cost?.total)}
          </Box>
          {candidate.cost && !candidate.cost.isComplete ? (
            <Box variant="small">
              {(candidate.target === 'EC2_CPU' || candidate.target === 'AWS_BATCH_CPU')
                && candidate.cost.items.some((item) => item.amount !== null)
                ? `Known subtotal: ${formatMoney(candidate.cost.knownSubtotal)}. Supporting charges or allocation inputs are missing.`
                : 'Some costs are missing'}
            </Box>
          ) : null}
        </SpaceBetween>
      ),
    },
    {
      id: 'status',
      header: 'Can I use it?',
      minWidth: 160,
      cell: (candidate: Candidate) => (
        <SpaceBetween size="xs">
          <StatusIndicator
          type={
            candidate.gates.some((gate) => gate.status === 'FAIL')
              ? 'warning'
              : candidate.isFeasible && !conditional
                ? 'success'
                : 'info'
          }
        >
          <span className="eddie-status-text">{optionStatus(candidate)}</span>
          </StatusIndicator>
          {!historical ? (
            <Button variant="inline-link" onClick={() => setMapSelection(candidate.candidateId)}
              ariaLabel={`Explain ${hostingOptionName(candidate)}`}>
              Why this option?
            </Button>
          ) : null}
        </SpaceBetween>
      ),
    },
  ];

  return (
    <Container header={<Header variant="h2" actions={!historical ? (
      <Button iconName="map" onClick={() => setMapSelection(null)}>View decision map</Button>
    ) : undefined}>Your hosting options</Header>}>
      <SpaceBetween size="l">
        <div aria-live="polite" data-testid="comparison-summary">
          <Box variant="h3">{comparisonHeadline(result)}</Box>
          <Box variant="p">
            {brandText(result.winner
              ? `${hostingOptionName(result.winner)} has the lowest estimated cost among options that passed the declared checks: ${formatMoney(result.winner.cost?.total)} over ${period}.`
              : unresolved.length > 0
                ? `${unresolved.length} ${unresolved.length === 1 ? 'option needs' : 'options need'} verification before EDDIE can recommend one. ${anyPrices ? 'You can compare the estimated costs below.' : 'The missing checks are listed below.'}`
                : excluded.length > 0
                  ? 'Each option failed at least one requirement. The table shows which one; your requirements have been kept.'
                  : 'EDDIE does not yet have a supported configuration for this model and Region. Review the model details or consider another model.')}
          </Box>
        </div>

        {result.checksStipulated ? (
          <Alert type="warning" header="Account checks were assumed">
            Usage terms, quota, serving configuration and capacity have not been
            verified. These estimates do not establish that you can deploy.
          </Alert>
        ) : null}

        {result.qualification?.latencyStatus === 'SUPPLIED' ? (
          <StatusIndicator type="warning">
            Response-time figures were supplied. <BrandName /> did not measure them.
          </StatusIndicator>
        ) : result.qualification?.latencyStatus === 'NOT_REQUESTED' ? (
          <Box variant="small" color="text-body-secondary">
            No response-time target was set. Performance has not been measured.
          </Box>
        ) : null}

        {all.length > 0 ? (
          <Table
            variant="embedded"
            wrapLines
            items={all}
            trackBy="candidateId"
            columnDefinitions={columns}
            ariaLabels={{ tableLabel: 'Hosting cost estimates and verification status' }}
            empty="No hosting options to compare."
          />
        ) : null}

        {result.nativePricing?.length ? <NativePriceEvidence result={result} /> : null}
        <NextChecks candidates={unresolved} />

        {anyPrices ? (
          <SpaceBetween size="xs">
            <StatusIndicator type={livePrices ? 'info' : 'warning'}>
              {livePrices ? 'AWS prices retrieved live' : 'Some prices need checking'}
            </StatusIndicator>
            <Box variant="small" color="text-body-secondary">
              {result.nativePricing?.length
                ? 'Estimates use the request volume and token counts recorded for this comparison. '
                : 'Estimates use the hours and model sizing recorded for this comparison. '}
              A lower price does not establish performance or capacity. Open an
              option to see what is included.
            </Box>
          </SpaceBetween>
        ) : null}

        {selected ? (
          <Container
            header={
              <Header
                variant="h3"
                actions={<Button onClick={() => setSelectedId(null)}>Close details</Button>}
              >
                {hostingOptionName(selected)}
              </Header>
            }
          >
            <CandidateDetail candidate={selected} />
          </Container>
        ) : null}

        <ExpandableSection headerText="Sources, assumptions and evaluated inputs">
          <SpaceBetween size="s">
            <Box variant="small">
              Prices retrieved: {result.retrievedAt ? formatTimestamp(result.retrievedAt) : 'Not recorded'}.
              {' '}Response-time measurements: {result.qualification?.benchmarkRunIds.length
                ? result.qualification.benchmarkRunIds.join(', ')
                : 'No benchmark run recorded'}.
            </Box>
            {(result.assumptions ?? []).length > 0 ? (
              <ul>{result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
            ) : null}
            <Box variant="small">Comparison reference: {result.requestHash ?? 'Not recorded'}</Box>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>
              {JSON.stringify(result.evaluatedRequest ?? result.request, null, 2)}
            </pre>
          </SpaceBetween>
        </ExpandableSection>
        {mapSelection !== undefined && !historical ? (
          <DecisionMap result={result} initialCandidateId={mapSelection}
            onDismiss={() => setMapSelection(undefined)} {...mapActions} />
        ) : null}
      </SpaceBetween>
    </Container>
  );
}

export function HostingComparison(props: ResultsPanelProps & DecisionMapActions) {
  const { result, loading, error, outdatedFields = [], onReevaluate } = props;
  if (loading || error) return <ResultsPanel {...props} />;
  if (!result) {
    return (
      <Container header={<Header variant="h2">Your hosting options</Header>}>
        <SpaceBetween size="m">
          <Box variant="h3">Ready when you are</Box>
          <Box variant="p">
            Choose a model, describe its usage, and select <b>Compare options</b>.{' '}
            <BrandName /> will show estimated costs and the checks needed before deployment.
          </Box>
          <Box variant="small" color="text-body-secondary">
            Comparing options does not deploy a model or start GPU instances.
          </Box>
        </SpaceBetween>
      </Container>
    );
  }
  if (outdatedFields.length > 0) {
    return <PreviousComparison result={result} onReevaluate={onReevaluate} />;
  }
  const candidates = [...(result.ranked ?? []), ...(result.unresolved ?? []), ...(result.excluded ?? [])];
  const missingCpu = candidates.some((candidate) => candidate.target === 'SAGEMAKER_REALTIME' || candidate.target === 'BEDROCK_CMI')
    && !candidates.some((candidate) => candidate.target === 'EC2_CPU' || candidate.target === 'AWS_BATCH_CPU');
  return <SpaceBetween size="m">
    {missingCpu && onReevaluate ? <Box>
      This saved comparison does not include CPU.{' '}
      <Button variant="inline-link" onClick={onReevaluate}>Include CPU options</Button>
      {' '}to check EC2 CPU and AWS Batch CPU with your current requirements.
    </Box> : null}
    <CurrentComparison key={`${result.requestHash}:${result.snapshotHash}`} result={result}
      onAsk={props.onAsk} onEditNeeds={props.onEditNeeds} onTests={props.onTests} onModels={props.onModels}
      renderSizing={props.renderSizing} />
  </SpaceBetween>;
}

function PreviousComparison({ result, onReevaluate }: {
  result: EvaluateResponse;
  onReevaluate?: () => void;
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
    return (
      <Container header={<Header variant="h2">Your hosting options</Header>}>
        <SpaceBetween size="m">
          <Alert
            type="info"
            header="Your requirements changed"
            data-testid="comparison-needs-update"
            action={onReevaluate ? <Button onClick={onReevaluate}>Update comparison</Button> : undefined}
          >
            Compare again to see costs and checks for your updated workload.
          </Alert>
          <ExpandableSection
            headerText="Previous comparison"
            expanded={historyExpanded}
            onChange={({ detail }) => setHistoryExpanded(detail.expanded)}
          >
            {historyExpanded ? (
              <SpaceBetween size="m">
                <Box variant="p">
                  Saved for reference only. This comparison uses your earlier requirements.
                </Box>
                <CurrentComparison key={result.requestHash} result={result} historical />
              </SpaceBetween>
            ) : null}
          </ExpandableSection>
        </SpaceBetween>
      </Container>
    );
}
