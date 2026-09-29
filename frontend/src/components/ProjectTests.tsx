import { BrandName } from './BrandName';
import { useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import { useApp } from '../state/AppContext';
import { useCase } from '../state/CaseContext';
import type { EvaluationExample as Example, ScoreReport } from '../state/evaluationDraft';
const blankExample = (): Example => ({ input: '', expected: '', actual: '' });

/** A real deterministic quality check. It never presents supplied output as inference. */
export function ProjectTests({ onHosting }: { onHosting: () => void }) {
  const { client } = useApp();
  const { form, evaluationDraft, patchEvaluationDraft } = useCase();
  const { rows, target, caseSensitive, report, reportKey } = evaluationDraft;
  const setRows = (next: Example[] | ((current: Example[]) => Example[])) =>
    patchEvaluationDraft({ rows: typeof next === 'function' ? next(rows) : next });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const modelSource = form.sourceKind === 'checkpoint' ? form.sourceLocation : form.hfRepo;
  const modelRevision = form.sourceKind === 'checkpoint' ? form.artifactDigest : form.hfCommit;
  const key = JSON.stringify({ rows, target, caseSensitive, model: modelSource || form.modelName, revision: modelRevision });
  const stale = report !== null && key !== reportKey;
  const updateRow = (index: number, patch: Partial<Example>) =>
    setRows((current) => current.map((row, position) => index === position ? { ...row, ...patch } : row));
  const score = async () => {
    if (running) return;
    setRunning(true);
    setError('');
    const submittedKey = key;
    try {
      const result = await client.invoke<ScoreReport>('evaluation.score', {
        examples: rows, passPercent: target, caseSensitive,
        model: { name: form.modelName || null, source: modelSource || null, revision: modelRevision || null },
      });
      patchEvaluationDraft({ report: result, reportKey: submittedKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setRunning(false); }
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    setError('');
    try {
      if (file.size > 1_000_000) throw new Error('Choose a JSON file smaller than 1 MB.');
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 1000) throw new Error('Use a JSON array with between 1 and 1,000 examples.');
      if (!parsed.every((row) => row && typeof row === 'object' && typeof row.input === 'string' && typeof row.expected === 'string' && (row.actual === null || typeof row.actual === 'string'))) {
        throw new Error('Each example needs input, expected and actual fields. Use null for a missing response.');
      }
      setRows(parsed as Example[]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    if (fileInput.current) fileInput.current.value = '';
  };
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'eddie-answer-evaluation.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <SpaceBetween size="l">
      <Header variant="h2" description="Evaluation means testing how well a model handles your task. Answer quality and response speed need different tests.">
        Test what matters to your application
      </Header>
      {form.successCriteria ? <Box><b>Your quality goal:</b> {form.successCriteria}</Box> : null}
      <Container header={<Header variant="h3" description="Useful for categories, short factual answers and other tasks with a known expected result. Bring responses you have already collected.">Check answer accuracy</Header>}>
        <SpaceBetween size="m">
          <Box>
            <BrandName /> compares each supplied answer with the expected answer, ignoring surrounding spaces.
            This does not call a model. Free-form writing needs a separate review rubric.
          </Box>
          <div className="eddie-inline-summary">
            <Box variant="small" color="text-body-secondary">Examples are sent to your <BrandName /> backend for scoring. Save project keeps your examples and report in your account.</Box>
            <Button iconName="upload" onClick={() => fileInput.current?.click()}>Import JSON</Button>
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(event) => void readFile(event.target.files?.[0])} />
          </div>
          {rows.slice(0, 10).map((row, index) => (
            <div key={index} className="eddie-example-row" role="group" aria-label={`Example ${index + 1}`}>
              <Box variant="h4">Example {index + 1}</Box>
              <ColumnLayout columns={3}>
                <FormField label="Question or task">
                  <Textarea rows={2} value={row.input} onChange={({ detail }) => updateRow(index, { input: detail.value })} ariaLabel={`Example ${index + 1} question`} placeholder="Please help me understand this charge." />
                </FormField>
                <FormField label="Expected answer">
                  <Input value={row.expected} onChange={({ detail }) => updateRow(index, { expected: detail.value })} ariaLabel={`Example ${index + 1} expected answer`} placeholder="billing" />
                </FormField>
                <FormField label="Model’s actual answer">
                  <Input value={row.actual ?? ''} onChange={({ detail }) => updateRow(index, { actual: detail.value })} ariaLabel={`Example ${index + 1} actual answer`} placeholder="Paste the response you collected" />
                </FormField>
              </ColumnLayout>
              {rows.length > 1 ? <Button variant="inline-link" onClick={() => setRows((current) => current.filter((_, position) => position !== index))} ariaLabel={`Remove example ${index + 1}`}>Remove</Button> : null}
            </div>
          ))}
          {rows.length > 10 ? <Box>Showing the first 10 of {rows.length} imported examples. All examples will be scored.</Box> : null}
          <SpaceBetween direction="horizontal" size="s">
            <Button onClick={() => setRows((current) => [...current, blankExample()])} disabled={rows.length >= 10}>Add example</Button>
            <Button variant="primary" onClick={() => void score()} loading={running} disabled={rows.some((row) => !row.expected.trim())}>
              Score supplied answers
            </Button>
          </SpaceBetween>
          <ExpandableSection headerText="Scoring settings and import format">
            <SpaceBetween size="s">
              <FormField label="Target match rate (%)">
                <Input type="number" value={target} onChange={({ detail }) => patchEvaluationDraft({ target: detail.value })} ariaLabel="Target match rate" />
              </FormField>
              <Toggle checked={caseSensitive} onChange={({ detail }) => patchEvaluationDraft({ caseSensitive: detail.checked })}>Capitalization must match</Toggle>
              <Box variant="code">[{'{'}"input": "Your task", "expected": "billing", "actual": null{'}'}]</Box>
              <Box variant="small">A null or empty response counts as a failed example. Add an error field for failed requests; they stay in the denominator.</Box>
            </SpaceBetween>
          </ExpandableSection>
          {error ? <Alert type="error" header="The answers could not be scored">{error}</Alert> : null}
        </SpaceBetween>
      </Container>

      {report ? (
        <Container header={<Header variant="h3" actions={<Button onClick={download} iconName="download">Export report</Button>}>Answer check results</Header>}>
          <SpaceBetween size="m">
            {stale ? <Alert type="warning" header="These results are for earlier inputs">The model, examples or scoring settings changed. Score again to update the result.</Alert> : null}
            <StatusIndicator type={stale ? 'warning' : report.sampleTargetMet ? 'success' : 'warning'}>
              {report.passed} of {report.total} answers matched · {report.matchPercent}%
            </StatusIndicator>
            <Box>{report.note}</Box>
            <Table
              items={report.results}
              trackBy="example"
              variant="embedded"
              wrapLines
              columnDefinitions={[
                { id: 'example', header: 'Example', cell: (row) => row.example },
                { id: 'expected', header: 'Expected', cell: (row) => row.expected },
                { id: 'actual', header: 'Actual', cell: (row) => row.actual ?? 'No response' },
                { id: 'result', header: 'Result', cell: (row) => row.reason },
              ]}
            />
            <ExpandableSection headerText="Confidence and reproducibility">
              <Box>95% statistical interval: {report.confidence95Percent[0]}–{report.confidence95Percent[1]}%. This does not establish that the examples represent production traffic.</Box>
              <Box variant="small">Scorer: {report.scorerVersion}. The export includes all failures and the report identity.</Box>
            </ExpandableSection>
          </SpaceBetween>
        </Container>
      ) : null}

      <Container header={<Header variant="h3">Check response speed under load</Header>}>
        <SpaceBetween size="s">
          <Box>A performance benchmark sends real requests to a specific hosting configuration and measures response time, concurrency, errors and cost.</Box>
          <StatusIndicator type="pending">The deployment-backed load runner is not connected in this installation</StatusIndicator>
          <Box variant="small" color="text-body-secondary">No speed measurements have been produced here. Supplied answer scores cannot clear a speed requirement.</Box>
          <Button onClick={onHosting}>Review hosting and required checks</Button>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
