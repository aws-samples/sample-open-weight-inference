import { useEffect, useRef, useState } from 'react';
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
import Table from '@cloudscape-design/components/table';
import {
  DEFAULT_BENCHMARK_SETTINGS, comparisonSettings,
  type BenchmarkComparison, type BenchmarkCost, type BenchmarkRun,
} from '../api/benchmarks';
import type { DeploymentView } from '../api/types';
import { useApp } from '../state/AppContext';
import { useCase } from '../state/CaseContext';
import { projectFingerprint } from '../state/persistence';
import { runTrialBenchmark } from '../state/trialBenchmark';
import { BenchmarkScatterPlot } from './BenchmarkScatterPlot';
import '../styles/benchmarks.css';

function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}
const usd = (value: string | null) => value === null ? 'Unknown' : `$${Number(value).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumSignificantDigits: 6,
})}`;
const milliseconds = (value: number | null) => value === null ? 'Not measured' : `${Math.round(value).toLocaleString()} ms`;

function restoredComparisonKey(value: string | null | undefined): string {
  // DynamoDB serialization sorts object keys. Normalize both new and previously
  // saved JSON keys so a reload cannot make an unchanged comparison look stale.
  try { return projectFingerprint(JSON.parse(value ?? 'null')); }
  catch { return ''; }
}

function Frontier({ report, selected, onSelect }: {
  report: BenchmarkComparison; selected: string; onSelect: (id: string) => void;
}) {
  const points = report.rows.filter((row) => row.costPerUsefulUsd !== null && !row.comparisonDifferences.length);
  if (!points.length) return null;
  return <BenchmarkScatterPlot
    points={points.map((row) => ({
      id: row.runId, label: row.configuration.label, cost: Number(row.costPerUsefulUsd), quality: row.acceptancePercent,
      detail: `${row.acceptancePercent}% accepted · ${usd(row.costPerUsefulUsd)}/useful`,
      secondary: `p95: ${milliseconds(row.p95Ms)} · ${row.usefulRequestsPerMinute.toLocaleString(undefined, { maximumFractionDigits: 2 })} useful/min`,
      series: row.configuration.provider, frontier: row.frontier,
    }))}
    series={[{ id: 'bedrock', label: 'Bedrock', color: 'blue' },
      { id: 'sagemaker', label: 'SageMaker', color: 'purple' },
      { id: 'self_hosted', label: 'Self-hosted', color: 'orange', diamond: true },
      { id: 'external', label: 'External evaluator', color: 'gray' }]}
    selected={selected} choose={onSelect} target={report.settings.minimumAcceptancePercent}
    title="Cost vs. accepted responses" subtitle={`${report.workload.name} · ${points.length} configurations · Matched workload and protocol`}
    xLabel="Estimated cost per useful response (USD)" yLabel="Responses accepted by your evaluation rule"
    ariaLabel="Acceptance versus cost per useful response"
    sourceNote="Supplied measurements. Useful responses pass the acceptance rule and the response-time target, when set.
      The frontier also considers observed p95. Missing prices and unmatched protocols stay in the records below."
  />;
}

export function BenchmarkWorkspace({ onHosting }: { onHosting: () => void }) {
  const { client } = useApp();
  const { caseId, hydrationVersion, evaluationDraft, patchEvaluationDraft } = useCase();
  const runs = evaluationDraft.benchmarkRuns ?? [];
  const settings = evaluationDraft.benchmarkSettings ?? DEFAULT_BENCHMARK_SETTINGS;
  const report = evaluationDraft.benchmarkComparison;
  const key = projectFingerprint({ runs, settings });
  const scope = `${caseId}:${hydrationVersion}`;
  const latest = useRef({ key, scope, runs });
  latest.current = { key, scope, runs };
  const mounted = useRef(true);
  const stopped = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'run' | 'compare' | 'import' | 'load' | null>(null);
  const [progress, setProgress] = useState('');
  const [deployments, setDeployments] = useState<DeploymentView[]>([]);
  const [jobId, setJobId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [repetitions, setRepetitions] = useState('1');
  const [concurrency, setConcurrency] = useState('1');
  const [tokens, setTokens] = useState('128');
  const [deadline, setDeadline] = useState('300');
  const [selectedRun, setSelectedRun] = useState('');
  useEffect(() => {
    mounted.current = true;
    setDeployments([]); setJobId(''); setLoaded(false); setAccepted(false); setBusy(null); setProgress('');
    return () => { mounted.current = false; stopped.current = true; };
  }, [scope]);
  const active = (captured: string) => mounted.current && latest.current.scope === captured;
  const currentJob = deployments.find((job) => job.jobId === jobId);
  const stale = !!report && key !== restoredComparisonKey(evaluationDraft.benchmarkKey);
  const selected = report?.rows.find((row) => row.runId === selectedRun) ?? report?.rows[0];
  const ready = deployments.filter((job) => ['EXPERIMENTAL', 'READY'].includes(job.state) &&
    !job.resourcesExpired && !job.recipeId?.includes('magpie') && !job.recipeId?.includes('speech'));

  async function loadTrials() {
    const captured = scope;
    setBusy('load'); setError('');
    try {
      const result = await client.listDeployments();
      if (active(captured)) { setDeployments(result.deployments); setLoaded(true); }
    } catch (cause) { if (active(captured)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active(captured)) setBusy(null); }
  }

  async function compare(nextRuns = runs) {
    const captured = scope;
    const requestKey = projectFingerprint({ runs: nextRuns, settings });
    setBusy('compare'); setError('');
    try {
      const result = await client.invoke<BenchmarkComparison>('evaluation.compare', {
        runs: nextRuns, settings: comparisonSettings(settings),
      });
      if (!active(captured)) return;
      if (latest.current.key !== requestKey) {
        setError('Inputs changed while comparing. Compare again to use your latest inputs.');
        return;
      }
      patchEvaluationDraft({ benchmarkComparison: result, benchmarkKey: requestKey });
    } catch (cause) { if (active(captured)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active(captured)) setBusy(null); }
  }

  async function importRuns(files: FileList | null) {
    if (!files?.length) return;
    const captured = scope, before = latest.current.key;
    setBusy('import'); setError('');
    try {
      if (files.length + runs.length > 8) throw new Error('Compare up to eight runs. Remove an older report first.');
      const incoming: BenchmarkRun[] = [];
      for (const file of Array.from(files)) {
        if (file.size > 1_000_000) throw new Error('Each report must be smaller than 1 MB.');
        incoming.push(JSON.parse(await file.text()) as BenchmarkRun);
      }
      const all = [...runs, ...incoming];
      // The server validates raw observations; an uploaded "winner" is not trusted.
      await client.invoke('evaluation.compare', { runs: all });
      if (active(captured) && latest.current.key === before) {
        patchEvaluationDraft({ benchmarkRuns: all, benchmarkComparison: null, benchmarkKey: null });
        setProgress(`Imported ${incoming.length} report${incoming.length === 1 ? '' : 's'}. Set your targets and compare.`);
      }
    } catch (cause) { if (active(captured)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      if (fileInput.current) fileInput.current.value = '';
      if (active(captured)) setBusy(null);
    }
  }

  async function runTrial() {
    if (!currentJob || !accepted || busy || runs.length >= 8) return;
    const captured = scope, previousRuns = [...runs];
    stopped.current = false; setBusy('run'); setError(''); setProgress('Checking the trial’s recorded configuration');
    try {
      const review = await client.getDeploymentPlan(currentJob.planId);
      if (!active(captured) || stopped.current) return;
      const evidence = review.cost?.priceEvidence;
      const cost: BenchmarkCost = evidence ? {
        basis: 'capacity', scope: 'benchmark_window', currency: 'USD', hourlyUsd: evidence.amount,
        retrievedAt: evidence.retrievedAt, rateId: evidence.sku, source: evidence.source,
      } : { basis: 'unknown', scope: 'benchmark_window' };
      const storeProgress = (partial: BenchmarkRun) => {
        if (!active(captured)) return;
        patchEvaluationDraft({ benchmarkRuns: [...previousRuns, partial], benchmarkComparison: null, benchmarkKey: null });
        setProgress(`${partial.samples.filter((row) => row.status !== 'not_run').length} of ${partial.samples.length} requests recorded`);
      };
      const result = await runTrialBenchmark({
        deployment: currentJob, examples: [...evaluationDraft.rows], caseSensitive: evaluationDraft.caseSensitive,
        repetitions: Number(repetitions), concurrency: Number(concurrency),
        maxOutputTokens: Number(tokens), maximumSeconds: Number(deadline), cost,
        invoke: (text, maxTokens) => client.invokeTestDeployment(currentJob.jobId, text, maxTokens),
        grade: async (examples, caseSensitive) => {
          const result = await client.invoke<{ results: { passed: boolean }[] }>('evaluation.score', {
            examples, caseSensitive,
          });
          return result.results.map((row) => row.passed);
        },
        stopped: () => stopped.current || !active(captured), progress: storeProgress,
      });
      storeProgress(result);
      if (active(captured)) setProgress(result.state === 'completed'
        ? 'Run complete. Compare the observations, then save your project.'
        : 'Run stopped. Completed, failed and unstarted requests remain in the report.');
    } catch (cause) { if (active(captured)) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active(captured)) { setBusy(null); setAccepted(false); } }
  }

  return <SpaceBetween size="l">
    <Container header={<Header variant="h3" description="Run the examples above against an existing text trial, or import measurements from the companion runner.">Measure and compare configurations</Header>}>
      <SpaceBetween size="m">
        {error ? <Alert type="error" header="The benchmark needs attention">{error}</Alert> : null}
        <SpaceBetween direction="horizontal" size="s">
          <Button iconName="upload" disabled={!!busy || runs.length >= 8} onClick={() => fileInput.current?.click()}>Import benchmark reports</Button>
          <Button loading={busy === 'load'} disabled={!!busy} onClick={() => void loadTrials()}>Find ready text trials</Button>
          <input type="file" accept=".json,application/json" multiple hidden ref={fileInput} aria-label="Benchmark report files"
            onChange={(event) => void importRuns(event.target.files)} />
        </SpaceBetween>
        <Box variant="small">Reports contain configuration, observations and output hashes. Imported measurements remain supplied evidence. Save project keeps them with this project.</Box>
        {loaded && !ready.length ? <Alert type="info" header="No ready text trial is available">
          Prepare a supported trial in Deploy &amp; monitor, or use benchmark.sh with your existing Bedrock, SageMaker or self-hosted service.
          <Box margin={{ top: 's' }}><Button onClick={onHosting}>Review hosting and trial options</Button></Box>
        </Alert> : null}
        {ready.length ? <SpaceBetween size="s">
          <FormField label="Existing text trial">
            <Select selectedOption={currentJob ? { value: currentJob.jobId, label: `${currentJob.modelRef} / ${currentJob.instanceType}` } : null}
              options={ready.map((job) => ({ value: job.jobId, label: `${job.modelRef} / ${job.instanceType}` }))}
              onChange={({ detail }) => { setJobId(detail.selectedOption.value ?? ''); setAccepted(false); }}
              disabled={!!busy} placeholder="Select a ready trial" />
          </FormField>
          <ColumnLayout columns={4}>
            <FormField label="Repeats per example"><Input type="number" ariaLabel="Benchmark repetitions" value={repetitions} disabled={!!busy} onChange={({ detail }) => setRepetitions(detail.value)} /></FormField>
            <FormField label="Concurrent requests"><Input type="number" ariaLabel="Benchmark concurrency" value={concurrency} disabled={!!busy} onChange={({ detail }) => setConcurrency(detail.value)} /></FormField>
            <FormField label="Maximum output tokens"><Input type="number" ariaLabel="Benchmark output limit" value={tokens} disabled={!!busy} onChange={({ detail }) => setTokens(detail.value)} /></FormField>
            <FormField label="Stop new requests after (seconds)"><Input type="number" ariaLabel="Benchmark deadline" value={deadline} disabled={!!busy} onChange={({ detail }) => setDeadline(detail.value)} /></FormField>
          </ColumnLayout>
          <Checkbox checked={accepted} disabled={!!busy} onChange={({ detail }) => setAccepted(detail.checked)}>
            Send up to {evaluationDraft.rows.length * (Number(repetitions) || 0)} requests to this existing trial. Its request limit and expiry remain enforced; charges continue until cleanup.
          </Checkbox>
          <SpaceBetween direction="horizontal" size="s">
            <Button variant="primary" disabled={!accepted || !currentJob || !!busy || runs.length >= 8} onClick={() => void runTrial()}>Run workload test</Button>
            {busy === 'run' ? <Button onClick={() => { stopped.current = true; setProgress('Stopping new requests; waiting for in-flight responses'); }}>Stop after in-flight requests</Button> : null}
          </SpaceBetween>
          <Box variant="small">At most 40 requests per run. Keep this page open. Response time includes the browser, application and model call. This does not measure time to first token.</Box>
        </SpaceBetween> : null}
        {progress ? <StatusIndicator type={busy === 'run' ? 'in-progress' : 'info'}>{progress}</StatusIndicator> : null}
        <ExpandableSection headerText="Use Bedrock, your own endpoint, or external evaluation results">
          <SpaceBetween size="s">
            <Box>Use the repository’s benchmark.sh to validate a plan and run bounded text tests. It uses AWS credentials for Bedrock and SageMaker; self-hosted endpoints use an existing loopback tunnel. It creates no resources.</Box>
            <Box variant="code">./benchmark.sh --plan my-benchmark.json</Box>
            <Box>For coding, RAG or other free-form work, run the appropriate task evaluator and export its acceptance decisions with the exact workload, rubric and harness identities. The comparison never executes submitted code or treats an LLM judge score as independent proof.</Box>
            <Link external href="https://github.com/aws-samples/sample-open-weight-inference/blob/main/docs/workload-benchmarks.md">Report format and benchmark guide</Link>
          </SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </Container>

    {runs.length ? <Container header={<Header variant="h3" counter={`(${runs.length}/8)`}>Compare the same workload</Header>}>
      <SpaceBetween size="m">
        <ColumnLayout columns={4}>
          {([
            ['minimumAcceptancePercent', 'Minimum accepted (%)'],
            ['maximumP95Ms', 'Maximum observed p95 (ms)'],
            ['maximumErrorPercent', 'Maximum request failures (%)'],
            ['minimumTasks', 'Minimum distinct tasks'],
          ] as const).map(([field, label]) => <FormField key={field} label={label}>
            <Input type="number" value={settings[field]} ariaLabel={label} disabled={busy === 'run' || busy === 'import'}
              onChange={({ detail }) => patchEvaluationDraft({ benchmarkSettings: { ...settings, [field]: detail.value } })} />
          </FormField>)}
        </ColumnLayout>
        <Box variant="small">Leave response time empty to compare without a speed target. Useful responses must pass the acceptance rule and, when set, the response-time target.</Box>
        <SpaceBetween direction="horizontal" size="s">
          <Button variant="primary" loading={busy === 'compare'} disabled={!!busy} onClick={() => void compare()}>Compare benchmark runs</Button>
          <Button iconName="download" disabled={!!busy} onClick={() => runs.forEach((run) => download(run, `${run.runId}.json`))}>Export run reports</Button>
        </SpaceBetween>
        <Table items={runs} trackBy="runId" variant="embedded" wrapLines columnDefinitions={[
          { id: 'configuration', header: 'Configuration', cell: (run) => run.configuration.label },
          { id: 'date', header: 'Recorded', cell: (run) => new Date(run.createdAt).toLocaleString() },
          { id: 'requests', header: 'Scheduled requests', cell: (run) => run.samples.length },
          { id: 'remove', header: 'Remove', cell: (run) => <Button iconName="remove" variant="icon" disabled={!!busy}
            ariaLabel={`Remove ${run.configuration.label} report`} onClick={() => patchEvaluationDraft({
              benchmarkRuns: runs.filter((item) => item.runId !== run.runId), benchmarkComparison: null, benchmarkKey: null,
            })} /> },
        ]} />
      </SpaceBetween>
    </Container> : null}

    {report ? <Container header={<Header variant="h3" actions={<Button iconName="download" disabled={stale}
      onClick={() => download(report, 'eddie-benchmark-comparison.json')}>Export comparison</Button>}>Observed quality, speed and cost</Header>}>
      <SpaceBetween size="m">
        {stale ? <Alert type="warning" header="Comparison inputs changed">Compare again before using these results.</Alert> : null}
        <StatusIndicator type={report.lowestCostEligibleRunIds.length ? 'info' : 'warning'}>
          {report.lowestCostEligibleRunIds.length
            ? `Lowest observed cost per useful response among eligible runs: ${report.rows.filter((row) => report.lowestCostEligibleRunIds.includes(row.runId)).map((row) => row.configuration.label).join(', ')}`
            : 'No run meets all comparison targets with complete, comparable evidence.'}
        </StatusIndicator>
        <Frontier report={report} selected={selected?.runId ?? ''} onSelect={setSelectedRun} />
        <ExpandableSection headerText="All run metrics and exclusions">
          <Table items={report.rows} trackBy="runId" variant="embedded" wrapLines
          columnDefinitions={[
            { id: 'configuration', header: 'Configuration', cell: (row) => <Button variant="inline-link" onClick={() => setSelectedRun(row.runId)}>{row.configuration.label}</Button> },
            { id: 'accepted', header: 'Accepted / scheduled', cell: (row) => `${row.accepted}/${row.planned} (${row.acceptancePercent}%)` },
            { id: 'p95', header: 'Observed p95', cell: (row) => milliseconds(row.p95Ms) },
            { id: 'useful', header: 'Useful / minute', cell: (row) => row.usefulRequestsPerMinute },
            { id: 'cost', header: 'Cost / useful response', cell: (row) => usd(row.costPerUsefulUsd) },
            { id: 'status', header: 'Comparison status', cell: (row) => <StatusIndicator type={row.eligible ? 'info' : 'warning'}>
              {row.frontier ? 'Trade-off frontier' : row.eligible ? 'Dominated in this sample' : 'Needs attention'}
            </StatusIndicator> },
          ]} />
        </ExpandableSection>
        {selected ? <ExpandableSection defaultExpanded headerText={`Evidence: ${selected.configuration.label}`}>
          <SpaceBetween size="s">
            {selected.reasons.length ? <Alert type="warning" header="Why this run is excluded">{selected.reasons.join(' ')}</Alert> : <Box>This run meets the selected sample targets. Production readiness still needs its own checks.</Box>}
            <Box>Model: {selected.configuration.model}. Revision: {selected.configuration.revision}. Runtime: {selected.configuration.runtime}. Harness: {selected.configuration.harness}.</Box>
            <Box>Failed requests: {selected.errors}. Unstarted: {selected.notRun}. Awaiting grading: {selected.ungraded}. Time to first token: {milliseconds(selected.p95TtftMs)}.</Box>
            <Box>Window cost: {usd(selected.costUsd)} for {selected.durationSeconds.toFixed(2)} seconds. Source: {selected.costEvidence.source ?? 'Unavailable'}. Retrieved: {selected.costEvidence.retrievedAt ?? 'Unknown'}.</Box>
            <Box variant="small">Run identity: {selected.runDigest}</Box>
          </SpaceBetween>
        </ExpandableSection> : null}
        <ExpandableSection headerText="What these results establish">
          <SpaceBetween size="s">{report.notes.map((note) => <Box key={note}>{note}</Box>)}</SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </Container> : null}
  </SpaceBetween>;
}
