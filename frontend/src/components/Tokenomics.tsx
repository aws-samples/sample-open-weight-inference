import { useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Autosuggest from '@cloudscape-design/components/autosuggest';
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
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import type { CommitmentRow, PoolCost, TokenomicsReport } from '../api/tokenomics';
import { planName, tokenomicsCsv } from '../api/tokenomics';
import { useApp } from '../state/AppContext';
import '../styles/tokenomics.css';

const INSTANCE_EXAMPLES = ['g6.2xlarge', 'g6e.2xlarge', 'g5.2xlarge', 'g5.12xlarge',
  'p5.48xlarge', 'p5e.48xlarge', 'p6-b200.48xlarge'].map((value) => ({ value }));
const DEFAULT_ROWS = new Set([
  'on-demand', 'Compute-1-no-upfront', 'EC2Instance-1-no-upfront',
  'Compute-3-no-upfront', 'EC2Instance-3-no-upfront', 'EC2Instance-3-all-upfront',
]);
const dollars = (value: string | null, digits = 0) => value === null ? 'Not available' :
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
    minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value));

function CostCell({ row, cost }: { row: CommitmentRow; cost: PoolCost }) {
  if (row.status !== 'AVAILABLE') {
    return <Box color="text-body-secondary">
      <StatusIndicator type="not-started">{row.status === 'NOT_LISTED' ? 'Not listed' : 'Pricing unavailable'}</StatusIndicator>
      <Box variant="small">{row.reason}</Box>
    </Box>;
  }
  return <div className="eddie-tokenomics-cost">
    <strong>{dollars(cost.annualCostUsd)}<small> / year</small></strong>
    <span>{dollars(cost.monthlyEquivalentUsd)} / month equivalent</span>
    {row.termYears > 0 ? <span>{dollars(cost.termCommitmentUsd)} committed over {row.termYears} year{row.termYears > 1 ? 's' : ''}</span>
      : <span>No term commitment</span>}
    {row.paymentOption === 'All Upfront' ? <b>{dollars(cost.upfrontUsd)} paid at the start</b> : null}
    {row.paymentOption === 'Partial Upfront' ? <span>Upfront amount selected at purchase</span> : null}
    {cost.costPerMillionOutputTokensUsd !== null ?
      <span>{dollars(cost.costPerMillionOutputTokensUsd, 4)} / million supplied output tokens</span> : null}
  </div>;
}

export function Tokenomics({ initialRegion = 'us-east-1', initialInstance = '' }: {
  initialRegion?: string; initialInstance?: string;
}) {
  const { client } = useApp();
  const [instance, setInstance] = useState(initialInstance);
  const [region, setRegion] = useState(initialRegion);
  const [counts, setCounts] = useState('1, 2');
  const [hours, setHours] = useState('24');
  const [tokens, setTokens] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [report, setReport] = useState<TokenomicsReport | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const version = useRef(0);
  const previousInitialInstance = useRef(initialInstance);

  function change(update: () => void) {
    version.current += 1;
    abort.current?.abort();
    update();
    setReport(null);
    setError('');
    setRunning(false);
  }
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => {
    change(() => setRegion(initialRegion));
  }, [initialRegion]);
  useEffect(() => {
    const previous = previousInitialInstance.current;
    previousInitialInstance.current = initialInstance;
    if (initialInstance !== previous && (!instance || instance === previous)) {
      change(() => setInstance(initialInstance));
    }
  }, [initialInstance]);

  async function compare() {
    const parts = counts.split(',').map((value) => value.trim());
    if (!parts.length || parts.length > 4 || parts.some((value) => !/^\d+$/.test(value))) {
      setError('Enter one to four whole pool sizes, separated by commas. For example: 1, 2.');
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const submitted = ++version.current;
    setRunning(true); setError(''); setReport(null);
    try {
      const result = await client.invoke<TokenomicsReport>('tokenomics.compare', {
        instanceType: instance.trim(), region: region.trim(), poolSizes: parts.map(Number),
        hoursPerDay: hours, monthlyOutputTokens: tokens || null,
      }, controller.signal);
      if (!controller.signal.aborted && version.current === submitted) setReport(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The comparison could not be retrieved.');
    } finally {
      if (version.current === submitted) setRunning(false);
    }
  }

  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([tokenomicsCsv(report)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'gpu-tokenomics.csv'; link.click();
    URL.revokeObjectURL(url);
  }

  const rows = report?.rows.filter((row) => showAll || DEFAULT_ROWS.has(row.id)) ?? [];
  const incomplete = report?.rows.some((row) => row.status === 'UNAVAILABLE');
  return <div className="eddie-tokenomics" data-testid="tokenomics">
    <SpaceBetween size="l">
      <Container header={<Header variant="h2" description="Inference economics: compare the compute bill and commitment for the same GPU pool.">
        Tokenomics
      </Header>}>
        <SpaceBetween size="m">
          <ColumnLayout columns={3}>
            <FormField label="EC2 instance type">
              <Autosuggest ariaLabel="Tokenomics EC2 instance type" value={instance}
                clearAriaLabel="Clear EC2 instance type"
                options={INSTANCE_EXAMPLES} placeholder="Choose or enter an instance type"
                enteredTextLabel={(value) => `Use ${value}`}
                onChange={({ detail }) => change(() => setInstance(detail.value))} />
            </FormField>
            <FormField label="AWS Region">
              <Input ariaLabel="Tokenomics AWS Region" value={region}
                onChange={({ detail }) => change(() => setRegion(detail.value))} />
            </FormField>
            <FormField label="Pool sizes to compare" description="Number of instances, not GPUs.">
              <Input ariaLabel="GPU pool sizes" value={counts} placeholder="1, 2"
                onChange={({ detail }) => change(() => setCounts(detail.value))} />
            </FormField>
          </ColumnLayout>
          <ColumnLayout columns={2}>
            <FormField label="Allocated hours per day" description="24 means continuously allocated. Savings Plans remain payable during idle hours.">
              <Input ariaLabel="Tokenomics allocated hours per day" type="number" value={hours}
                onChange={({ detail }) => change(() => setHours(detail.value))} />
            </FormField>
            <FormField label="Monthly output tokens - optional" description="Your workload's useful output, held constant across pools. This does not establish throughput.">
              <Input ariaLabel="Tokenomics monthly output tokens" type="number" value={tokens} placeholder="Leave blank if not measured"
                onChange={({ detail }) => change(() => setTokens(detail.value))} />
            </FormField>
          </ColumnLayout>
          <SpaceBetween direction="horizontal" size="s">
            <Button variant="primary" loading={running} disabled={!instance.trim() || !region.trim()}
              onClick={() => void compare()}>Compare public prices</Button>
            <Button onClick={() => change(() => {
              setInstance('p6-b200.48xlarge'); setRegion('us-east-1'); setCounts('1, 2'); setHours('24'); setTokens('');
            })}>Use B200 pool example</Button>
          </SpaceBetween>
          {error ? <Alert type="error">{error}</Alert> : null}
        </SpaceBetween>
      </Container>
      {report ? <>
        <div className="eddie-tokenomics-summary">
          <div><span>Compute pool</span><strong>{report.instanceType}</strong>
            <small>{report.hardware ? `${report.hardware.gpus} ${report.hardware.accelerator} GPUs per instance` : 'GPU count not verified'} · {report.region}</small></div>
          <div><span>Allocation assumption</span><strong>{report.hoursPerDay} hours / day</strong>
            <small>{Number(report.hoursPerYear).toLocaleString('en-US')} hours / year · Linux, shared tenancy</small></div>
          <div><span>Price basis</span><strong>Public USD rates</strong>
            <small>Retrieved {new Date(report.retrievedAt).toLocaleString()} · no private discounts</small></div>
        </div>
        {incomplete ? <Alert type="info" header="Some public prices could not be retrieved">
          Missing prices are left blank. Refresh the comparison after pricing access or connectivity is restored.
        </Alert> : null}
        <Table<CommitmentRow>
          header={<Header variant="h2" description="Annual costs and monthly equivalents. Expand the details below for exact rates and cash flow."
            actions={<SpaceBetween direction="horizontal" size="s">
              <Button iconName="download" onClick={download}>Download table</Button>
              <Button href="https://calculator.aws/" target="_blank" iconName="external">AWS Pricing Calculator</Button>
            </SpaceBetween>}>Compare commitments</Header>}
          items={rows} trackBy="id" variant="container" wrapLines
          columnDefinitions={[
            { id: 'plan', header: 'Plan', minWidth: 225, cell: (row) => <SpaceBetween size="xxs">
              <Box fontWeight="bold">{planName(row)}</Box><Box variant="small">{row.paymentOption}</Box>
            </SpaceBetween> },
            ...report.poolSizes.map((count, index) => ({
              id: `pool-${count}`, minWidth: 235,
              header: `${count} instance${count === 1 ? '' : 's'}${report.hardware ? ` (${count * report.hardware.gpus} GPUs)` : ''}`,
              cell: (row: CommitmentRow) => <CostCell row={row} cost={row.pools[index]} />,
            })),
            { id: 'savings', header: 'Versus On-Demand', minWidth: 170, cell: (row) => {
              const value = row.pools[0].savingsPercent;
              if (row.planType === 'OnDemand') return <Box color="text-body-secondary">Reference</Box>;
              if (value === null) return <Box color="text-body-secondary">Not available</Box>;
              const less = Number(value) >= 0;
              return <SpaceBetween size="xxs">
                <StatusIndicator type={less ? 'success' : 'warning'}>
                  {Math.abs(Number(value)).toFixed(1)}% {less ? 'lower cost' : 'higher cost'}
                </StatusIndicator>
                <Box variant="small">Same allocated schedule</Box>
              </SpaceBetween>;
            } },
          ]}
          footer={<Checkbox checked={showAll} onChange={({ detail }) => setShowAll(detail.checked)}>
            Show all 1-year and 3-year terms and payment options
          </Checkbox>}
        />
        <ExpandableSection headerText="Rates, payment timing and source evidence">
          <SpaceBetween size="m">
            <Box>Monthly equivalent spreads the cost across the term; it is not the monthly invoice.
              Partial upfront cash is chosen at purchase and is not assumed here.</Box>
            <Table<CommitmentRow> items={rows} trackBy="id" variant="embedded" wrapLines
              columnDefinitions={[
                { id: 'plan', header: 'Plan', cell: (row) => `${planName(row)} · ${row.paymentOption}` },
                { id: 'rate', header: 'Effective USD / instance-hour', cell: (row) => row.effectiveHourlyRateUsd ?? 'Not available' },
                { id: 'cash', header: 'Cash flow by pool', cell: (row) => <SpaceBetween size="s">
                  {row.pools.map((pool) => <Box key={pool.instances} variant="small">
                    <b>{pool.instances} instance{pool.instances > 1 ? 's' : ''}:</b> {dollars(pool.upfrontUsd, 2)} upfront;
                    {' '}{dollars(pool.recurringMonthlyUsd, 2)} recurring monthly equivalent
                  </Box>)}
                </SpaceBetween> },
                { id: 'util', header: 'Allocation break-even', cell: (row) => row.breakEvenAllocatedPercent === null
                  ? 'Not applicable' : `${row.breakEvenAllocatedPercent}% of year against On-Demand` },
                { id: 'source', header: 'Source identity', cell: (row) => <Box variant="small">
                  {row.evidence.sourceUrl ? <Link external href={row.evidence.sourceUrl}>AWS public pricing API</Link> : 'No quote'}
                  <div className="eddie-tokenomics-source-id">{row.evidence.offeringId ?? row.evidence.sku}</div>
                  {row.evidence.effectiveDate ? <div>Effective {row.evidence.effectiveDate}</div> : null}
                </Box> },
              ]} />
          </SpaceBetween>
        </ExpandableSection>
        <ExpandableSection headerText="What is included and how the plans differ">
          <SpaceBetween size="s">
            <Box>Compute Savings Plans can follow eligible usage across instance families and Regions.
              EC2 Instance Savings Plans commit to one family in one Region. Neither reserves capacity.</Box>
            <ul>{report.assumptions.map((text) => <li key={text}>{text}</li>)}</ul>
            {report.sources.map((source) => <Link key={source.url} external href={source.url}>{source.label}</Link>)}
          </SpaceBetween>
        </ExpandableSection>
        <Box variant="small" color="text-body-secondary">
          Compute estimate only. EKS fees and other supporting services are additional.
          These prices do not establish that the model fits or meets its response-time target.
        </Box>
      </> : null}
    </SpaceBetween>
  </div>;
}
