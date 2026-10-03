import { BrandName } from './BrandName';
import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import { useApp } from '../state/AppContext';
import type { DeploymentView, TestInvocationResponse } from '../api/types';

const STEP_LABELS: Record<string, string> = {
  'prepare-model': 'Prepare the model files',
  'create-endpoint': 'Start the endpoint on AWS',
  'test-invocation': 'Verify a real answer',
  cleanup: 'Remove resources and confirm cleanup',
};
const SPEECH_STEP_LABELS: Record<string, string> = {
  ...STEP_LABELS, 'test-invocation': 'Verify complete audio',
};
const EXAMPLE = 'Classify this support request as billing, account, or technical. Reply with only the category: I was charged twice this month.';
const SPEECH_RECIPE = 'sagemaker-magpie-cpu';
const SPEECH_EXAMPLE = "Welcome to Acme's bring your own model workshop. This audio was generated from our supplied text using Magpie. We will record the time and cost, save the result, and stop the worker.";
const SPEECH_LIMIT = 200;

/**
 * A private library manifest is an S3 location that names the installation's bucket and
 * account. Show the library entry instead; the full reference stays in the API record.
 */
export function modelLabel(modelRef?: string) {
  const match = /^s3:\/\/[^/]+\/checkpoints\/[^/]+\/[^/]+\/([^/]+)\/[0-9a-f]{64}\/manifest\.json$/.exec(modelRef ?? '');
  return match ? `${match[1]} · from your model library` : modelRef ?? '';
}

/** Staged files are listed by their path inside the installation's bucket. */
function resourceLabel(id?: string | null) {
  return id?.startsWith('s3://') ? id.replace(/^s3:\/\/[^/]+\//, 'artifact bucket / ') : id;
}

/** Audio returned by the trial lives only in this browser tab, as a Blob URL. */
function useAudioUrl(audio?: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!audio) { setUrl(null); return; }
    const bytes = Uint8Array.from(atob(audio), (char) => char.charCodeAt(0));
    const next = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [audio]);
  return url;
}

export function DeploymentDetails({ deployment, onChange }: {
  deployment: DeploymentView; onChange: () => void;
}) {
  const { client } = useApp();
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<TestInvocationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const live = ['EXPERIMENTAL', 'READY'].includes(deployment.state) && !deployment.resourcesExpired;
  const gone = deployment.state === 'DELETED' && deployment.resources.every((entry) => entry.state === 'DELETED');
  const deleting = ['DELETING', 'CLEANUP_INCOMPLETE', 'FAILED'].includes(deployment.state);
  const speech = deployment.recipeId === SPEECH_RECIPE;
  const audioUrl = useAudioUrl(answer?.audio);
  const labels = speech ? SPEECH_STEP_LABELS : STEP_LABELS;
  async function tryModel() {
    setError(null);
    setInvoking(true);
    setAnswer(null);
    try {
      setAnswer(speech
        ? await client.synthesizeTestSpeech(deployment.jobId, prompt, 'jason')
        : await client.invokeTestDeployment(deployment.jobId, prompt));
      onChange();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setInvoking(false); }
  }
  async function remove() {
    setError(null);
    setRemoving(true);
    try {
      await client.removeTestDeployment(deployment.jobId);
      setConfirmDelete(false);
      onChange();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setRemoving(false); }
  }
  return (
    <>
      <Container data-testid="deployment-details" header={
        <Header variant="h2" description={modelLabel(deployment.modelRef)}
          actions={!gone && deployment.state !== 'DELETING' ? <Button iconName="remove" onClick={() => setConfirmDelete(true)} disabled={removing}>
            {deleting ? 'Retry removal' : 'Remove test'}
          </Button> : undefined}>
          {gone ? 'Test removed' : live ? 'Your test is ready' : deleting ? 'Removing this test' : 'Setting up your test'}
        </Header>
      }>
        <SpaceBetween size="m">
          {error ? <Alert type="error" header="The action did not complete">{error}</Alert> : null}
          {gone ? (
            <Alert type="success" header="Cleanup confirmed">
              The resources recorded for this test have been removed. The deployment receipt is retained.
            </Alert>
          ) : (
            <Box variant="small" color="text-body-secondary">
              {deployment.region} · {deployment.hourlyUsd ? `$${Number(deployment.hourlyUsd).toLocaleString('en-US', { maximumFractionDigits: 6 })}/hour while the endpoint is allocated` : 'See the reviewed plan for cost'}.
              {' '}Removal starts by {new Date(deployment.resourceExpiresAt).toLocaleString()}.
              {' '}You can close this page; progress and cleanup continue.
            </Box>
          )}
          {deployment.failureReason && !gone ? <Alert type="warning" header="This deployment needs attention">{deployment.failureReason}</Alert> : null}
          <ol className="eddie-deployment-steps" aria-label="Deployment progress">
            {deployment.steps.map((step) => (
              <li key={step.name}>
                <SpaceBetween size="xxxs">
                  <StatusIndicator type={step.state === 'DONE' ? 'success' : step.state === 'FAILED' ? 'error' : step.state === 'RUNNING' ? 'loading' : 'pending'}>
                    {labels[step.name] ?? step.name}
                  </StatusIndicator>
                  {step.detail ? <Box variant="small" color="text-body-secondary">{step.detail}</Box> : null}
                </SpaceBetween>
              </li>
            ))}
            {!deployment.steps.length ? <li><StatusIndicator type="loading">Waiting for the deployment worker</StatusIndicator></li> : null}
          </ol>
          {live && speech ? (
            <SpaceBetween size="s">
              <FormField label="Text to speak"
                description={`Sent once to your private endpoint with the preset voice Jason. Up to ${SPEECH_LIMIT} characters; one request runs at a time.`}
                constraintText={`${prompt.length}/${SPEECH_LIMIT} characters`}>
                <Textarea ariaLabel="Text to speak" value={prompt} rows={3}
                  onChange={({ detail }) => setPrompt(detail.value.slice(0, SPEECH_LIMIT))} disabled={invoking} />
              </FormField>
              <SpaceBetween direction="horizontal" size="s">
                <Button variant="primary" onClick={() => void tryModel()} loading={invoking} disabled={!prompt.trim()}>
                  Generate audio
                </Button>
                <Button onClick={() => setPrompt(SPEECH_EXAMPLE)} disabled={invoking}>Use the workshop sentence</Button>
              </SpaceBetween>
              {invoking ? <StatusIndicator type="loading">Generating on CPU. The endpoint stops a request that has not finished after 55 seconds.</StatusIndicator> : null}
            </SpaceBetween>
          ) : null}
          {live && !speech ? (
            <SpaceBetween size="s">
              <FormField label="Try a question" description="This calls your deployed model. Trial endpoints allow up to 100 requests, with a small output limit.">
                <Textarea ariaLabel="Message for your deployed model" value={prompt} rows={3}
                  onChange={({ detail }) => setPrompt(detail.value)} disabled={invoking} />
              </FormField>
              <SpaceBetween direction="horizontal" size="s">
                <Button variant="primary" onClick={() => void tryModel()} loading={invoking} disabled={!prompt.trim()}>
                  Send to model
                </Button>
                <Button onClick={() => setPrompt(EXAMPLE)} disabled={invoking}>Use a support-ticket example</Button>
              </SpaceBetween>
            </SpaceBetween>
          ) : null}
          {answer && speech ? (
            <Container variant="stacked" header={<Header variant="h3">Generated audio</Header>}>
              <SpaceBetween size="s">
                {audioUrl ? <audio controls src={audioUrl} aria-label="Generated audio" /> : null}
                <StatusIndicator type={answer.receipt.decoded ? 'success' : 'error'}>
                  {answer.receipt.decoded
                    ? `Complete audio decoded: ${answer.receipt.audioSeconds} seconds, ${answer.receipt.sampleRateHz} Hz mono`
                    : 'The audio did not decode'}
                </StatusIndicator>
                <Box variant="small" color="text-body-secondary">
                  Synthesis took {answer.receipt.synthesisSeconds} seconds; the whole request took {(Number(answer.receipt.elapsedMs) / 1000).toFixed(1)} seconds
                  on {answer.receipt.instanceType}. Peak process memory: {answer.receipt.peakRssMiB} MiB. One request is a functional check,
                  not a throughput or speech-quality measurement.
                </Box>
                {audioUrl ? <Box><a href={audioUrl} download={`eddie-speech-${answer.receipt.runId}.wav`}>Download the WAV</a></Box> : null}
                <ExpandableSection headerText="Hashes for your record">
                  <SpaceBetween size="xxs">
                    <Box variant="small">Input text SHA-256: <span style={{ overflowWrap: 'anywhere' }}>{answer.receipt.inputSha256}</span></Box>
                    <Box variant="small">Audio SHA-256: <span style={{ overflowWrap: 'anywhere' }}>{answer.receipt.outputSha256}</span></Box>
                    <Box variant="small">The text and audio were not stored by <BrandName />.</Box>
                  </SpaceBetween>
                </ExpandableSection>
              </SpaceBetween>
            </Container>
          ) : null}
          {answer && !speech ? (
            <Container variant="stacked" header={<Header variant="h3">Model answer</Header>}>
              <SpaceBetween size="s">
                <div className="eddie-model-answer" role="status">{answer.output}</div>
                <Box variant="small" color="text-body-secondary">
                  One authenticated request took {Number(answer.receipt.elapsedMs).toLocaleString()} ms.
                  This single result does not establish p99 latency or answer quality.
                </Box>
              </SpaceBetween>
            </Container>
          ) : null}
          {deployment.invocationReceipt && !answer ? (
            <StatusIndicator type="success">{speech
              ? `Complete audio was returned and decoded (${deployment.invocationReceipt.audioSeconds} seconds). Text and audio were not stored.`
              : 'A real authenticated invocation is recorded. Prompts and answers were not stored.'}</StatusIndicator>
          ) : null}
          <ExpandableSection headerText={gone ? 'Cleanup receipt' : 'Resource and invocation details'}>
            <SpaceBetween size="s">
              <Box variant="small">Deployment: {deployment.jobId}</Box>
              <Box variant="small">Model revision: {deployment.modelRevision ?? 'Not recorded'}</Box>
              <ul className="eddie-readable-list">{deployment.resources.map((entry) =>
                <li key={entry.entryId}>{entry.kind} · {resourceLabel(entry.physicalId ?? entry.plannedName)} · {entry.state === 'DELETED' ? 'Removal confirmed' : entry.state.toLowerCase().replaceAll('_', ' ')}</li>
              )}</ul>
              {gone && deployment.failureReason ? <Box variant="small">Earlier issue: {deployment.failureReason}</Box> : null}
              {deployment.invocationReceipt ? <Box variant="small">
                Invocation receipt: {deployment.invocationReceipt.runId} · {deployment.invocationReceipt.at}
              </Box> : null}
            </SpaceBetween>
          </ExpandableSection>
        </SpaceBetween>
      </Container>
      <Modal visible={confirmDelete} onDismiss={() => !removing && setConfirmDelete(false)}
        header="Remove this test?" closeAriaLabel="Close remove test dialog"
        footer={<SpaceBetween direction="horizontal" size="s">
          <Button onClick={() => setConfirmDelete(false)} disabled={removing}>Keep test</Button>
          <Button variant="primary" onClick={() => void remove()} loading={removing}>Confirm removal</Button>
        </SpaceBetween>}>
        <BrandName /> will stop the endpoint for {modelLabel(deployment.modelRef)} and remove its staged model files and logs.
        The job remains visible until AWS confirms cleanup. This cannot be undone.
      </Modal>
    </>
  );
}
