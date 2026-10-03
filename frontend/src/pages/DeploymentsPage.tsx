import { modelLabel } from '../components/DeploymentDetails';
import { BrandName } from '../components/BrandName';
import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useApp } from '../state/AppContext';
import { useCase } from '../state/CaseContext';
import { targetLabel } from '../copy/lexicon';
import { NativeBedrockAccess, TestDeployment } from '../components/TestDeployment';
import { DeploymentDetails } from '../components/DeploymentDetails';
import type { DeploymentListResponse, DeploymentView } from '../api/types';

function stateIndicator(state: DeploymentView['state']) {
  switch (state) {
    case 'READY': return <StatusIndicator type="success">Running</StatusIndicator>;
    case 'EXPERIMENTAL': return <StatusIndicator type="success">Ready to try</StatusIndicator>;
    case 'RUNNING':
    case 'PENDING': return <StatusIndicator type="loading">Setting up</StatusIndicator>;
    case 'DELETING': return <StatusIndicator type="in-progress">Removing</StatusIndicator>;
    case 'DELETED': return <StatusIndicator type="stopped">Removed</StatusIndicator>;
    case 'FAILED': return <StatusIndicator type="error">Setup failed</StatusIndicator>;
    case 'CLEANUP_INCOMPLETE': return <StatusIndicator type="warning">Removal pending</StatusIndicator>;
    default: return <StatusIndicator type="info">Checking status</StatusIndicator>;
  }
}

/** Server-owned jobs survive tab changes and reloads. Polling never replaces the form
 * or steals focus, and an inventory error must not look like confirmed cleanup. */
export function DeploymentsPage({ embedded = false }: { embedded?: boolean }) {
  const { client } = useApp();
  const { form } = useCase();
  const nativeModel = form.sourceKind === 'bedrock' || (
    form.architecture === 'vendor-api' && form.modelName.includes('.') && form.modelName.includes(':')
  );
  const [data, setData] = useState<DeploymentListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const load = useCallback(async (background = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!background) setLoading(true);
    try {
      const result = await client.listDeployments();
      if (mounted.current) {
        setData(result);
        setError(null);
        // Follow a running test through cleanup, but let the user open older
        // receipts deliberately. An old failure must not dominate a new review.
        setSelectedId((current) => current ?? [...result.deployments]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .find((job) => job.state !== 'DELETED')?.jobId ?? null);
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 5000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [load]);

  const deployments = [...(data?.deployments ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = deployments.filter((job) => job.state !== 'DELETED');
  const selected = deployments.find((job) => job.jobId === selectedId) ?? active[0];
  const onStarted = (job: DeploymentView) => {
    setSelectedId(job.jobId);
    setData((old) => old ? { ...old, deployments: [job, ...old.deployments.filter((item) => item.jobId !== job.jobId)] } : old);
    void load();
  };
  const header = (
    <Header variant={embedded ? 'h2' : 'h1'}
      description="Try your model on AWS, see a real answer, and keep track of cost and cleanup."
      actions={<Button iconName="refresh" onClick={() => void load()} loading={loading}>Refresh</Button>}>
      Deploy &amp; monitor
    </Header>
  );
  const content = (
    <SpaceBetween size="l">
      {nativeModel ? <NativeBedrockAccess /> : null}
      {error ? <Alert type="error" header="Deployment status could not be refreshed"
        action={<Button onClick={() => void load()}>Try again</Button>} data-testid="deployments-error">
        {error} The last-known inventory is shown below. It does not confirm that resources have been removed.
      </Alert> : null}
      {loading && !data ? <StatusIndicator type="loading">Reading your deployments</StatusIndicator> : null}
      {!nativeModel && !error && data?.capability.canCreatePlans && active.length === 0 ? (
        <TestDeployment capability={data.capability} onStarted={onStarted} />
      ) : null}
      {!error && selected ? <DeploymentDetails key={selected.jobId} deployment={selected} onChange={() => void load()} /> : null}
      {!nativeModel && data && !data.capability.canCreatePlans && deployments.length === 0 ? (
        <Container header={<Header variant="h3">Nothing deployed yet</Header>} data-testid="deployments-empty">
          <SpaceBetween size="m">
            <Box><BrandName /> has not created any inference resources for this project.</Box>
            {(data.capability.targets ?? []).map((target) => (
              <SpaceBetween key={target.target} size="xxxs">
                <Box fontWeight="bold">{targetLabel(target.target)}</Box>
                <StatusIndicator type={target.available ? 'success' : 'pending'}>
                  {target.available ? 'Available' : 'Not available in this installation'}
                </StatusIndicator>
                <Box variant="small" color="text-body-secondary">{target.reason}</Box>
              </SpaceBetween>
            ))}
            <Box variant="small" color="text-body-secondary">{data.capability.note}</Box>
          </SpaceBetween>
        </Container>
      ) : null}
      {deployments.length > 0 ? (
        <Table<DeploymentView> items={deployments} trackBy="jobId" selectionType="single"
          selectedItems={selected ? [selected] : []}
          onSelectionChange={({ detail }) => setSelectedId(detail.selectedItems[0]?.jobId ?? null)}
          ariaLabels={{ tableLabel: 'Your test deployments', selectionGroupLabel: 'Select a deployment',
            itemSelectionLabel: (_, item) => `Open ${item.modelRef ? modelLabel(item.modelRef) : item.jobId}, started ${new Date(item.createdAt).toLocaleString()}` }}
          header={<Header variant={embedded ? 'h3' : 'h2'} counter={`(${deployments.length})`}>Your tests</Header>}
          columnDefinitions={[
            { id: 'model', header: 'Model', cell: (item) => item.modelRef ? modelLabel(item.modelRef) : targetLabel(item.target) },
            { id: 'state', header: 'Status', cell: (item) => stateIndicator(item.state) },
            { id: 'started', header: 'Started', cell: (item) => new Date(item.createdAt).toLocaleString() },
            { id: 'where', header: 'Where', cell: (item) => `${targetLabel(item.target)} · ${item.region ?? 'See details'}` },
            { id: 'ends', header: 'Removal starts', cell: (item) => item.state === 'DELETED' ? 'Removal confirmed' : new Date(item.resourceExpiresAt).toLocaleString() },
          ]}
        />
      ) : null}
      {data?.residual && data.residual.ownedBillableCount > 0 ? (
        <ExpandableSection headerText="Resources and remaining charges" variant="container">
          <SpaceBetween size="s">
            <Box variant="small">A recorded resource remains owned until removal is confirmed.</Box>
            <ul className="eddie-readable-list">{data.residual.entries.filter((entry) => entry.billable).map((entry) => (
              <li key={entry.entryId}>{entry.kind} · {entry.physicalId ?? entry.plannedName} · {entry.residualCostNote ?? 'Removal has not been confirmed'}</li>
            ))}</ul>
          </SpaceBetween>
        </ExpandableSection>
      ) : null}
    </SpaceBetween>
  );
  return embedded ? <SpaceBetween size="l">{header}{content}</SpaceBetween> : <ContentLayout header={header}>{content}</ContentLayout>;
}

export default DeploymentsPage;
