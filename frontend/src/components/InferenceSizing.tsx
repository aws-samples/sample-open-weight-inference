import { useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Icon from '@cloudscape-design/components/icon';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Tabs from '@cloudscape-design/components/tabs';
import type { FactBasis, SpeechExample, SizingMetric, SizingReport, SizingSettings } from '../api/sizing';
import { useApp } from '../state/AppContext';
import { useCase } from '../state/CaseContext';
import { toEvaluateRequest } from '../state/caseForm';
import { DEFAULT_SIZING, EMPTY_SIZING, sizingKey } from '../state/sizingDraft';
import '../styles/inference-sizing.css';

const BASIS: Record<FactBasis, string> = {
  REGISTRY: 'Model metadata', PUBLISHED: 'Published specification', CALCULATED: 'Calculated',
  ASSUMED: 'Assumption', MODELED: 'Modeled · not measured', DECLARED: 'Your input',
  SUPPLIED: 'Supplied observation', NOT_AVAILABLE: 'Evidence needed',
};
const WORKLOADS = [
  ['general', 'Choose the workload'], ['chat', 'Interactive text'], ['rag', 'Questions over documents'],
  ['code', 'Code generation'], ['batch', 'Offline text processing'], ['tts', 'Batch speech'],
  ['voice', 'Live voice'], ['embeddings', 'Embeddings / reranking'], ['classification', 'Classification'],
  ['multimodal', 'Images, audio and text'],
];

function valueText(item?: SizingMetric): string {
  if (item?.value === null || item?.value === undefined) return 'Not established';
  const numeric = Number(item.value);
  return Number.isFinite(numeric) && item.value.trim() !== ''
    ? numeric.toLocaleString(undefined, { maximumFractionDigits: numeric < 1 ? 4 : 2 }) : item.value;
}

function SourceLink({ url }: { url?: string | null }) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  } catch { return null; }
  return <Link href={url} external>View source</Link>;
}

function Metric({ item }: { item: SizingMetric }) {
  return <div className="eddie-sizing-metric" data-basis={item.basis}>
    <div><span>{item.label}</span><strong>{valueText(item)} {item.value !== null ? <small>{item.unit}</small> : null}</strong></div>
    <ExpandableSection variant="footer" headerText={BASIS[item.basis]}>
      <SpaceBetween size="xs">
        <Box>{item.explanation}</Box>
        {item.formula ? <Box variant="small"><b>Calculation:</b> {item.formula}</Box> : null}
        <SourceLink url={item.sourceUrl} />
      </SpaceBetween>
    </ExpandableSection>
  </div>;
}

function MetricGroup({ metrics }: { metrics: SizingMetric[] }) {
  const known = metrics.filter((item) => item.value !== null);
  const missing = metrics.filter((item) => item.value === null);
  return <SpaceBetween size="m">
    {known.length ? <div className="eddie-sizing-metrics">{known.map((item) => <Metric key={item.id} item={item} />)}</div> : null}
    {missing.length ? <ExpandableSection headerText={`What still needs evidence (${missing.length})`}>
      <ul className="eddie-sizing-list">{missing.map((item) => <li key={item.id}>
        <b>{item.label}:</b> {item.explanation}
      </li>)}</ul>
    </ExpandableSection> : null}
  </SpaceBetween>;
}

function SpeechEvidence({ example }: { example: SpeechExample }) {
  // Saved projects can contain the earlier Qwen example. Do not reinterpret it
  // as a Magpie measurement or crash while restoring an otherwise valid project.
  if (!Number.isFinite(example.synthesisSeconds) || !Number.isFinite(example.requestSeconds)
    || !example.cleanup || !Array.isArray(example.limitations)) {
    return <Container header={<Header variant="h3">Saved recorded example</Header>}>
      <SpaceBetween size="s">
        <Box>{example.model ?? 'This saved example'}{example.instance ? ` · ${example.instance}` : ''}</Box>
        <StatusIndicator type="info">This example uses an earlier report format.</StatusIndicator>
        <Box>Rebuild the sizing sheet to view the current recorded example. Your saved project
          and supplied measurements have been kept. The new example does not replace evidence
          measured for your workload.</Box>
      </SpaceBetween>
    </Container>;
  }
  return <Container header={<Header variant="h3" description="One recorded run of the reviewed speech recipe. These results do not qualify the current project.">Recorded example: speech on CPU</Header>}>
    <SpaceBetween size="m">
      <div className="eddie-sizing-example-label"><Icon name="audio-full" /> Recorded example · {example.recordedAt.slice(0, 10)} · one request</div>
      <Box>{example.model} · {example.hosting} · {example.instance} · {example.threads} CPU threads</Box>
      <div className="eddie-sizing-highlights">
        {[
          [example.audioSeconds.toFixed(1), 'seconds of audio'],
          [example.synthesisSeconds.toFixed(1), 'seconds synthesizing'],
          [example.requestSeconds.toFixed(1), 'seconds for the request'],
          [(example.peakProcessMiB / 1024).toFixed(2), 'GiB peak process memory'],
        ].map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </div>
      <Box>Synthesis took {example.realTimeFactor} seconds per second of audio for {example.inputCharacters} characters of supplied text.
        {example.startupSeconds !== null ? ` The endpoint took ${Math.round(example.startupSeconds / 60)} minutes to become ready.` : ''}
        {example.trialCostUsd !== null ? ` The trial's hosting cost was about $${example.trialCostUsd} at $${example.hourlyUsd}/hour.` : ''}</Box>
      <ExpandableSection headerText="What this proves and what it does not">
        <ul className="eddie-sizing-list">{example.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
      </ExpandableSection>
      <ExpandableSection headerText="Reproduction details">
        <SpaceBetween size="s">
          <Box>{example.region} · {example.vcpus} virtual CPUs · {example.memoryGiB} GiB RAM · {example.cpuArchitecture} · {example.runtime}</Box>
          <Box>{Object.entries(example.versions).map(([name, version]) => `${name} ${version}`).join(' · ')}</Box>
          {Object.entries(example.artifactHashes).map(([name, hash]) => <Box key={name} variant="small"><b>{name} SHA-256:</b> <span className="eddie-sizing-hash">{hash}</span></Box>)}
          <Box variant="small">Cleanup: {example.cleanup.scope}</Box>
          <SourceLink url={example.modelSource} />
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  </Container>;
}

/** One manual sizing sheet, also used by the Advisor's estimate_inference tool. */
export function InferenceSizing({ onAsk }: { onAsk?: (prompt: string) => void }) {
  const { client } = useApp();
  const context = useCase();
  const { form, patchSizingDraft } = context;
  const draft = context.sizingDraft ?? EMPTY_SIZING;
  const settings = { ...DEFAULT_SIZING, ...draft.settings };
  const report = draft.report;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('plan');
  const abort = useRef<AbortController | null>(null);
  const request = toEvaluateRequest(form);
  const key = sizingKey(request, settings);
  const currentKey = useRef(key);
  currentKey.current = key;
  const stale = !!report && key !== sizingKey(report.request, report.settings);
  useEffect(() => () => abort.current?.abort(), []);
  const update = (field: keyof SizingSettings, value: string) => {
    const next = { ...settings, [field]: value };
    // A manually supplied hourly rate belongs to its compute profile.
    if (['hardwareId', 'cpuInstance', 'computePreference'].includes(field)) {
      next.hourlyRateUsd = ''; next.rateDescription = '';
    }
    patchSizingDraft?.({ settings: next });
  };
  const input = (field: keyof SizingSettings, label: string, description?: string) => (
    <FormField label={label} description={description}>
      <Input value={settings[field]} onChange={({ detail }) => update(field, detail.value)}
        ariaLabel={label} inputMode={['rateDescription', 'cpuRunReference'].includes(field) ? 'text' : 'decimal'} />
    </FormField>
  );
  const select = (field: keyof SizingSettings, label: string, choices: string[][], description?: string) => (
    <FormField label={label} description={description}>
      <Select selectedOption={{ value: settings[field], label: choices.find(([value]) => value === settings[field])?.[1] ?? settings[field] }}
        options={choices.map(([value, text]) => ({ value, label: text }))}
        onChange={({ detail }) => update(field, detail.selectedOption.value ?? '')} ariaLabel={label} />
    </FormField>
  );
  const calculate = async () => {
    if (running) return;
    const controller = new AbortController();
    abort.current = controller; setRunning(true); setError('');
    const submitted = key;
    try {
      const next = await client.invoke<SizingReport>('sizing.estimate', { request, settings }, controller.signal);
      if (controller.signal.aborted) return;
      if (currentKey.current !== submitted) {
        setError('Inputs changed while the sheet was updating. Update again to use your latest values.');
        return;
      }
      patchSizingDraft({ report: next, settings: next.settings });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abort.current === controller) { abort.current = null; setRunning(false); }
    }
  };
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'eddie-inference-planning.json'; anchor.click();
    URL.revokeObjectURL(url);
  };
  const find = (id: string) => report?.groups.flatMap((group) => group.metrics).find((item) => item.id === id);
  const cpu = settings.computePreference === 'cpu' || (settings.computePreference === 'auto' && report?.compute === 'cpu');
  const sections = <SpaceBetween size="l">
    <Container header={<Header variant="h3" description="These inputs plan an experiment. Performance remains unverified until the exact configuration is tested.">Start with the workload</Header>}>
      <SpaceBetween size="m">
        <ColumnLayout columns={3}>
          {select('workloadKind', 'What will the model do?', WORKLOADS)}
          {select('servingMode', 'How will results be delivered?', [['unsure', 'Use my project / not specified'], ['interactive', 'While someone waits'], ['batch', 'As a queued job'], ['both', 'Both']])}
          {select('computePreference', 'Compute to explore', [['auto', 'Guide me from the workload'], ['cpu', 'CPU'], ['gpu', 'GPU']])}
        </ColumnLayout>
        <ColumnLayout columns={3}>
          {input('jobConcurrency', 'Simultaneous jobs or requests', 'Leave blank to use the project’s concurrency, if known.')}
          {input('deadlineSeconds', 'Job completion budget (seconds)', 'For queued work, include waiting, loading and processing.')}
          {select('cpuRuntime', 'Does the runtime support CPU?', [['unknown', 'Not verified'], ['supported', 'I have confirmed CPU execution'], ['unsupported', 'This runtime requires an accelerator']])}
        </ColumnLayout>
        {!cpu ? <ExpandableSection headerText="Memory, traffic and hardware assumptions">
          <SpaceBetween size="m">
            <Box>Memory units are GiB (2³⁰ bytes). Storage precision can differ from the precision used in memory.</Box>
            <ColumnLayout columns={3}>
              {input('contextTokens', 'Cached tokens per sequence')}
              {input('batchSize', 'Sequences sharing a decode step')}
              {select('kvDtype', 'Attention-cache precision', [['BF16', 'BF16 · 2 bytes'], ['FP16', 'FP16 · 2 bytes'], ['FP8', 'FP8 · 1 byte, verify support']])}
              {input('overheadPercent', 'Runtime allowance (%)', 'An explicit planning allowance, not measured usage.')}
              {input('utilizationPercent', 'Usable share of modeled throughput (%)')}
              {input('minimumReplicas', 'Minimum independent replicas')}
            </ColumnLayout>
            {select('hardwareId', 'GPU profile', [['auto', 'First memory fit in the shortlist'],
              ...((report?.hardwareChoices ?? []).map((item) => [item.instance, `${item.instance} · ${item.gpus} × ${item.accelerator}`]))])}
            {select('trafficMode', 'Traffic unit', [['requests', 'Requests and token lengths from my project'], ['tokens', 'Total tokens in the comparison period']])}
            {settings.trafficMode === 'tokens' ? <ColumnLayout columns={2}>
              {input('totalTokens', 'Total input + output tokens')}
              {input('outputSharePercent', 'Output share of tokens (%)')}
            </ColumnLayout> : <Box variant="small">Using your project’s request count and input/output lengths. Missing values stay unestablished.</Box>}
            <ColumnLayout columns={2}>
              {input('peakFactor', 'Peak / average traffic multiplier')}
              {input('prefillSpeedup', 'Input / output processing speed ratio', 'Leave blank until measured or explicitly assumed. No default ratio is used.')}
            </ColumnLayout>
          </SpaceBetween>
        </ExpandableSection> : null}
        <ExpandableSection headerText="CPU profile and observations">
          <SpaceBetween size="m">
            {select('cpuInstance', 'CPU instance to test', (report?.cpuChoices ?? [
              { instance: 'c7i.8xlarge', architecture: 'x86_64' }, { instance: 'c7g.8xlarge', architecture: 'ARM64 / Graviton' },
              { instance: 'm6g.xlarge', architecture: 'ARM64 / Graviton2' },
              { instance: 'm7i.2xlarge', architecture: 'x86_64' }, { instance: 'm7g.2xlarge', architecture: 'ARM64 / Graviton' },
              { instance: 'r7i.2xlarge', architecture: 'x86_64' }, { instance: 'r7g.2xlarge', architecture: 'ARM64 / Graviton' },
            ]).map((item) => [item.instance, `${item.instance} · ${item.architecture}`]),
            'An experiment profile, not an automatically qualified instance.')}
            {input('cpuRunReference', 'CPU run reference', 'Identify your actual run, model revision, runtime and input set.')}
            <ColumnLayout columns={3}>
              {input('cpuPeakGiB', 'Reported peak process memory (GiB)')}
              {input('cpuJobSeconds', 'Reported job completion time (seconds)')}
              {input('cpuBillableSeconds', 'Reported allocated compute time (seconds)')}
            </ColumnLayout>
          </SpaceBetween>
        </ExpandableSection>
        <ExpandableSection headerText="Use a quoted hourly rate">
          <ColumnLayout columns={2}>
            {input('hourlyRateUsd', 'Supplied rate (USD/hour)', 'Blank uses the current EC2 On-Demand price, if available.')}
            {input('rateDescription', 'Rate source and commitment term', 'For example, a dated one-year quote. This is labeled as your input.')}
          </ColumnLayout>
        </ExpandableSection>
        {error ? <Alert type="error">{error}</Alert> : null}
        <div className="eddie-sizing-actions">
          <StatusIndicator type={stale ? 'warning' : report ? 'info' : 'not-started'}>
            {stale ? 'Inputs changed · update this sheet' : report ? 'Planning only · performance not measured' : 'Ready to explore'}
          </StatusIndicator>
          <Button variant="primary" loading={running} onClick={() => void calculate()} disabled={!form.architecture}>
            {report ? 'Update sizing sheet' : 'Build sizing sheet'}
          </Button>
        </div>
        {!form.architecture ? <Box variant="small">Choose a model and read its details in Models & sources first.</Box> : null}
      </SpaceBetween>
    </Container>
    {report ? <div data-testid="inference-sizing-report" data-stale={stale}>
      <SpaceBetween size="l">
        <div className="eddie-sizing-verdict" data-compute={report.compute}>
          <Icon name={report.compute === 'cpu' ? 'settings' : report.compute === 'api' ? 'gen-ai' : 'multiscreen'} size="large" />
          <div><span className="eddie-sizing-eyebrow">{stale ? 'Previous planning result' : 'Next experiment'}</span>
            <h3>{report.guidance.title}</h3><p>{report.guidance.reason}</p></div>
        </div>
        <div className="eddie-sizing-checks">{report.guidance.checks.map((check) => <div key={check.label}>
          <span>{check.label}</span><b>{check.value}</b><p>{check.detail}</p>
        </div>)}</div>
        <Box variant="small">Artifact: <b>{report.model.repo ?? report.model.name ?? 'Not established'}</b>
          {report.model.revision ? <> · revision <span className="eddie-sizing-hash">{report.model.revision}</span></> : null}
          {' · '}{report.region}</Box>
        <Tabs activeTabId={tab} onChange={({ detail }) => setTab(detail.activeTabId)} tabs={[
          { id: 'plan', label: cpu ? 'Memory & CPU' : 'Memory & capacity', content: <SpaceBetween size="l">
            {report.compute === 'gpu' && report.hardware ? <div className="eddie-sizing-topology">
              <div><Icon name="multiscreen" size="large" /><strong>{report.hardware.instance}</strong><span>{report.hardware.gpus} × {report.hardware.accelerator}</span></div>
              <div><strong>TP {valueText(find('tensorParallel'))}</strong><span>GPUs share one model copy</span></div>
              <div><strong>DP {valueText(find('copies'))}</strong><span>Independent model copies</span></div>
              <div><strong>{valueText(find('perGpuMemory'))} GiB</strong><span>Required on each GPU</span></div>
              <p>{report.selectionReason} {report.hardware.interconnect}.</p>
            </div> : null}
            {report.groups.map((group) => <Container key={group.id} header={<Header variant="h3">{group.title}</Header>}>
              {group.id === 'memory' && report.memorySegments.every((segment) => segment.gib !== null) ? <div className="eddie-sizing-memory" aria-label="Memory composition">
                <div className="eddie-sizing-memory-bar">{report.memorySegments.map((segment) => <span key={segment.id} data-part={segment.id}
                  style={{ flexGrow: Number(segment.gib) }} title={`${segment.label}: ${segment.gib} GiB`} />)}</div>
                <div>{report.memorySegments.map((segment) => <span key={segment.id} data-part={segment.id}>{segment.label} {Number(segment.gib).toFixed(2)} GiB</span>)}</div>
              </div> : null}
              <MetricGroup metrics={group.metrics} />
            </Container>)}
          </SpaceBetween> },
          { id: 'cpu', label: 'CPU hosting paths', content: <SpaceBetween size="l">
            <Box>Self-hosted models can run on CPU when their runtime and workload fit. Establish that with a benchmark.</Box>
            <div className="eddie-sizing-services">{report.guidance.cpuServices.map((service) => <Container key={service.id}
              header={<Header variant="h3" description={service.fit}>{service.name}</Header>}>
              <SpaceBetween size="s"><Box>{service.detail}</Box><SourceLink url={service.sourceUrl} /></SpaceBetween>
            </Container>)}</div>
            <Container header={<Header variant="h3">Where the boundary lies</Header>}>
              <ul className="eddie-sizing-list">{report.guidance.sizeGuidance.map((text) => <li key={text}>{text}</li>)}</ul>
              <Box>{report.guidance.graviton}</Box>
            </Container>
          </SpaceBetween> },
          { id: 'benchmark', label: 'What to measure', content: <SpaceBetween size="l">
            <Container header={<Header variant="h3" description={report.benchmark.note}>{report.benchmark.title}</Header>}>
              <ColumnLayout columns={2}>
                <div><h4>Measure success</h4><ul className="eddie-sizing-list">{report.benchmark.metrics.map((text) => <li key={text}>{text}</li>)}</ul></div>
                <div><h4>Experiments worth trying</h4><ul className="eddie-sizing-list">{report.benchmark.levers.map((text) => <li key={text}>{text}</li>)}</ul></div>
              </ColumnLayout>
            </Container>
            <ExpandableSection headerText="Keep the test reproducible" defaultExpanded>
              <ul className="eddie-sizing-list">{report.benchmark.record.map((text) => <li key={text}>{text}</li>)}</ul>
              <SourceLink url={report.benchmark.sourceUrl} />
            </ExpandableSection>
          </SpaceBetween> },
          ...(report.guidance.example ? [{ id: 'example', label: 'Recorded example', content: <SpeechEvidence example={report.guidance.example} /> }] : []),
        ]} />
        <ExpandableSection headerText="Assumptions and limits">
          <ul className="eddie-sizing-list">{report.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
          <Box variant="small">Recorded {report.retrievedAt}. Reference <span className="eddie-sizing-hash">{report.reportHash.slice(0, 16)}</span>.</Box>
          {report.pricing ? <Box variant="small">Price source: {report.pricing.source}. SKU {report.pricing.sku}; effective {report.pricing.effectiveDate}.</Box> : null}
        </ExpandableSection>
        <div className="eddie-sizing-actions">
          <Button iconName="download" onClick={download}>Download planning record</Button>
          {onAsk ? <Button iconName="gen-ai" onClick={() => onAsk(
            'Explain my current sizing sheet, including CPU versus GPU, the evidence behind each number and the next benchmark. Use estimate_inference with my current settings. Do not change my requirements.'
          )}>Discuss with Advisor</Button> : null}
        </div>
      </SpaceBetween>
    </div> : null}
  </SpaceBetween>;
  return <div className="eddie-sizing" data-testid="inference-sizing">{sections}</div>;
}
