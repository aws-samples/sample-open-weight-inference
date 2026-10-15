import { useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import type { PublicBenchmarks } from '../api/publishedBenchmarks';
import { useApp } from '../state/AppContext';
import { BenchmarkScatterPlot } from './BenchmarkScatterPlot';
import { publishedTradeoffs } from './benchmarkChartInsights';
import '../styles/benchmarks.css';

const cost = (value: string | null) => value === null ? 'Not available' : `$${Number(value).toFixed(3)}`;

export function PublishedChart({ result, selected, choose }: {
  result: PublicBenchmarks; selected: string; choose: (id: string) => void;
}) {
  const rows = result.rows ?? [];
  const valid = rows.filter((row) => row.eligible && row.costPerTaskUsd !== null && row.resolvedPercent !== null);
  if (!valid.length) return null;
  const dates = [...new Set(valid.map((row) => row.date))].sort();
  const dateRange = dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0];
  const points = valid.map((row) => ({
    id: row.id, label: row.model, cost: Number(row.costPerTaskUsd), quality: row.resolvedPercent!,
    detail: `${row.resolvedPercent}% · ${cost(row.costPerTaskUsd)}/task`,
    frontier: row.frontier, series: row.openWeights === true ? 'open' : 'other', interval: row.resolutionInterval95,
  }));
  return <BenchmarkScatterPlot
    points={points} insights={publishedTradeoffs(points)}
    series={[{ id: 'open', label: 'Open weights (source classification)', color: 'orange', diamond: true },
      { id: 'other', label: 'Other / unspecified weights', color: 'blue' }]}
    selected={selected} choose={choose} frontierLine intervalOption
    title="Cost and coding performance"
    subtitle={`SWE-bench Verified · ${valid.length} configurations · 500 shared tasks · mini-SWE-agent ${result.selectedCohort}`}
    yLabel="Repository issues resolved by benchmark tests"
    xLabel="Historical API cost per attempted task (USD)"
    ariaLabel="Published coding correctness versus reported API cost"
    sourceNote={`Source: swebench.com · Submitted: ${dateRange} · Retrieved: ${result.retrievedAt?.slice(0, 10)}.
      Costs include all attempted tasks, including unresolved issues. These are published API costs, not current AWS hosting prices.`}
  />;
}

export function PublishedBenchmarks() {
  const { client } = useApp();
  const [result, setResult] = useState<PublicBenchmarks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [baseline, setBaseline] = useState('');
  const [contender, setContender] = useState('');
  const [recordsExpanded, setRecordsExpanded] = useState(false);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  async function load(payload: { cohort?: string; baseline?: string; contender?: string } = {}) {
    const request = ++sequence.current;
    setBusy(true); setError(''); setResult(null);
    try {
      const next = await client.invoke<PublicBenchmarks>('benchmarks.public', payload);
      if (request !== sequence.current) return;
      if (next.selectedCohort !== result?.selectedCohort) {
        setBaseline(''); setContender(''); setSelected('');
      }
      setResult(next);
    } catch (cause) {
      if (request === sequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request === sequence.current) setBusy(false); }
  }
  const rows = result?.rows ?? [];
  const current = rows.find((row) => row.id === selected) ?? rows.find((row) => row.eligible) ?? rows[0];
  const pairs = rows.filter((row) => row.eligible).map((row) => ({ value: row.id, label: row.model }));
  const cohort = result?.cohorts?.find((item) => item.id === result.selectedCohort);
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'eddie-published-benchmark-evidence.json'; anchor.click();
    URL.revokeObjectURL(url);
  }
  return <SpaceBetween size="l">
    <Header variant="h2" description="Use published coding results to identify candidates for your own evaluation.">
      Public benchmark evidence
    </Header>
    <Container>
      <SpaceBetween size="m">
        <Box>SWE-bench Verified tests whether an agent resolves real repository issues.
          This view recomputes resolution and cost from its published task records, grouped by mini-SWE-agent version.</Box>
        <SpaceBetween direction="horizontal" size="s">
          <Button variant="primary" loading={busy} onClick={() => void load(result?.selectedCohort ? { cohort: result.selectedCohort } : {})}>
            {result ? 'Refresh published results' : 'Load published results'}
          </Button>
          <Link external href="https://www.swebench.com/">Original leaderboard</Link>
          {result?.state === 'READY' ? <Button iconName="download" onClick={download}>Export evidence</Button> : null}
        </SpaceBetween>
        <Box variant="small">Fetches public result metadata only. No benchmark tasks or model weights are downloaded.
          Results are cached for up to 15 minutes; submission dates remain visible.</Box>
        {error ? <Alert type="error" header="Public results could not be loaded">{error}</Alert> : null}
        {result?.state === 'UNAVAILABLE' ? <Alert type="warning" header="No validated source results">{result.detail}</Alert> : null}
      </SpaceBetween>
    </Container>
    {result?.state === 'READY' ? <>
      <Container data-testid="published-benchmark-comparison" header={<Header variant="h3">Compare within one harness version</Header>}>
        <SpaceBetween size="m">
          <div className="eddie-benchmark-cohort"><FormField label="Harness cohort">
            <Select ariaLabel="Published benchmark harness cohort" disabled={busy}
              selectedOption={cohort ? { value: cohort.id, label: cohort.label } : null}
              options={result.cohorts?.map((item) => ({ value: item.id, label: item.label,
                description: `${item.comparable} comparable of ${item.records} source records` }))}
              onChange={({ detail }) => void load({ cohort: detail.selectedOption.value })} />
          </FormField></div>
          <Alert type="info">Published API costs are historical. They are not AWS hosting quotes.
            Use the project’s Tokenomics comparison for current AWS capacity prices and commitments.</Alert>
          <ColumnLayout columns={3}>
            <Box><Box variant="awsui-key-label">Benchmark</Box>{result.benchmark}</Box>
            <Box><Box variant="awsui-key-label">Coverage</Box>{rows.filter((row) => row.eligible).length} of {rows.length} records pass comparison checks</Box>
            <Box><Box variant="awsui-key-label">Source retrieved</Box>{new Date(result.retrievedAt!).toLocaleString()}</Box>
          </ColumnLayout>
          <PublishedChart result={result} selected={current?.id ?? ''} choose={setSelected} />
          {rows.some((row) => !row.eligible) ? <Alert type="warning" header={`${rows.filter((row) => !row.eligible).length} records excluded from the plot`}>
            <SpaceBetween size="xs">{rows.filter((row) => !row.eligible).map((row) => <Box key={row.id}>
              <Button variant="inline-link" ariaLabel={`Review excluded record: ${row.model}`} onClick={() => setSelected(row.id)}>{row.model}</Button>
              {': '}{row.reasons.join(' ')}
            </Box>)}</SpaceBetween>
          </Alert> : null}
          <ExpandableSection headerText={`All records and calculations (${rows.length})`}
            expanded={recordsExpanded} onChange={({ detail }) => setRecordsExpanded(detail.expanded)}>
            {recordsExpanded ? <Table variant="embedded" items={rows} trackBy="id" wrapLines columnDefinitions={[
            { id: 'model', header: 'Model / configuration', cell: (row) => <Button variant="inline-link" onClick={() => setSelected(row.id)}>
              {row.model}
            </Button> },
            { id: 'quality', header: 'Resolved / 500 tasks', cell: (row) => row.resolved === null ? 'Incomplete outcomes' :
              !row.outcomesConsistent ? 'Inconsistent outcomes' : `${row.resolved} (${row.resolvedPercent}%)` },
            { id: 'cost', header: 'API cost / task', cell: (row) => row.costsConsistent ? cost(row.costPerTaskUsd) : 'Not available' },
            { id: 'useful', header: 'API cost / resolved issue', cell: (row) =>
              row.costsConsistent && row.outcomesConsistent ? cost(row.costPerResolvedUsd) : 'Not available' },
            { id: 'date', header: 'Submitted', cell: (row) => row.date },
            { id: 'status', header: 'Comparison checks', cell: (row) => <StatusIndicator type={row.eligible ? 'info' : 'warning'}>
              {row.frontier ? 'On frontier' : row.eligible ? 'Comparable' : 'Excluded'}
            </StatusIndicator> },
            ]} /> : null}
          </ExpandableSection>
        </SpaceBetween>
      </Container>
      {current ? <Container header={<Header variant="h3">Evidence: {current.model}</Header>}>
        <SpaceBetween size="s">
          {current.reasons.length ? <Alert type="warning" header="Excluded from the frontier">{current.reasons.join(' ')}</Alert> : null}
          <Box>Published model ID: {current.modelId}. Harness: {current.harness} {current.harnessVersion}.
            Reasoning: {current.reasoningEffort}. Complete task outcomes: {current.tasks}/500.</Box>
          <Box>Publisher’s headline: {current.publishedResolvedPercent ?? 'Not supplied'}% resolved.
            Source review flag: {current.sourceReviewFlag === null ? 'Not supplied' : current.sourceReviewFlag ? 'Marked checked by source' : 'Not marked checked'}.</Box>
          {!current.outcomesConsistent && current.resolved !== null ? <Box>Published task records sum to {current.resolved} resolved issues ({current.resolvedPercent}%).
            That disagrees with the headline; neither value is used to rank this entry.</Box> : null}
          {current.resolutionInterval95 && current.outcomesConsistent ? <Box>Descriptive 95% interval: {current.resolutionInterval95.join(' to ')}%.
            Assumes independent sampled tasks; it does not establish production quality.</Box> : null}
          <ExpandableSection headerText="Source identity and reproducibility">
            <Box>Source snapshot SHA-256: {result.sourceSha256}</Box>
            <Box>Submission: {current.id}</Box>
            <Box>Task-set SHA-256: {current.taskSetDigest ?? 'Incomplete'}</Box>
            <Link external href="https://www.swebench.com/SWE-bench/guides/datasets/">Benchmark methodology</Link>
          </ExpandableSection>
        </SpaceBetween>
      </Container> : null}
      {pairs.length >= 2 ? <Container header={<Header variant="h3" description="See which exact benchmark tasks each configuration resolved. A higher total can still hide regressions.">Compare task outcomes</Header>}>
        <SpaceBetween size="m">
          <ColumnLayout columns={2}>
            <FormField label="Baseline"><Select ariaLabel="Published baseline" disabled={busy}
              selectedOption={pairs.find((item) => item.value === baseline) ?? null} options={pairs}
              onChange={({ detail }) => setBaseline(detail.selectedOption.value ?? '')} /></FormField>
            <FormField label="Contender"><Select ariaLabel="Published contender" disabled={busy}
              selectedOption={pairs.find((item) => item.value === contender) ?? null} options={pairs.filter((item) => item.value !== baseline)}
              onChange={({ detail }) => setContender(detail.selectedOption.value ?? '')} /></FormField>
          </ColumnLayout>
          <Button disabled={!baseline || !contender || baseline === contender || busy}
            onClick={() => void load({ cohort: result.selectedCohort, baseline, contender })}>Compare paired outcomes</Button>
          {result.paired && result.paired.baseline === baseline && result.paired.contender === contender ? <Box>
            Contender only: {result.paired.contenderOnly}. Baseline only: {result.paired.baselineOnly}.
            Both resolved: {result.paired.bothResolved}. Neither: {result.paired.neitherResolved}.
            Net difference: {result.paired.differencePercentagePoints} percentage points across {result.paired.tasks} tasks.
          </Box> : null}
        </SpaceBetween>
      </Container> : null}
      <ExpandableSection headerText="Method, assumptions and evidence limits">
        <SpaceBetween size="s">
          {result.notes?.map((note) => <Box key={note}>{note}</Box>)}
          {!!result.malformedRecords && <Box>{result.malformedRecords} source records had unreadable metadata and could not be displayed.</Box>}
        </SpaceBetween>
      </ExpandableSection>
    </> : null}
  </SpaceBetween>;
}
