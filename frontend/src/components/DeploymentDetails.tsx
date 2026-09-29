import { BrandName } from './BrandName';
import { useState } from 'react';
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
const EXAMPLE = 'Classify this support request as billing, account, or technical. Reply with only the category: I was charged twice this month.';

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
  async function tryModel() {
    setError(null);
    setInvoking(true);
    setAnswer(null);
    try {
      setAnswer(await client.invokeTestDeployment(deployment.jobId, prompt));
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
        <Header variant="h2" description={deployment.modelRef}
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
                    {STEP_LABELS[step.name] ?? step.name}
                  </StatusIndicator>
                  {step.detail ? <Box variant="small" color="text-body-secondary">{step.detail}</Box> : null}
                </SpaceBetween>
              </li>
            ))}
            {!deployment.steps.length ? <li><StatusIndicator type="loading">Waiting for the deployment worker</StatusIndicator></li> : null}
          </ol>
          {live ? (
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
          {answer ? (
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
            <StatusIndicator type="success">A real authenticated invocation is recorded. Prompts and answers were not stored.</StatusIndicator>
          ) : null}
          <ExpandableSection headerText={gone ? 'Cleanup receipt' : 'Resource and invocation details'}>
            <SpaceBetween size="s">
              <Box variant="small">Deployment: {deployment.jobId}</Box>
              <Box variant="small">Model revision: {deployment.modelRevision ?? 'Not recorded'}</Box>
              <ul className="eddie-readable-list">{deployment.resources.map((entry) =>
                <li key={entry.entryId}>{entry.kind} · {entry.physicalId ?? entry.plannedName} · {entry.state === 'DELETED' ? 'Removal confirmed' : entry.state.toLowerCase().replaceAll('_', ' ')}</li>
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
        <BrandName /> will stop the endpoint for {deployment.modelRef} and remove its staged model files and logs.
        The job remains visible until AWS confirms cleanup. This cannot be undone.
      </Modal>
    </>
  );
}
