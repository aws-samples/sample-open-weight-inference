import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { Candidate, EvaluateResponse } from '../api/types';
import { hostingOptionName } from './HostingComparison';

const CHECK_LABELS: Record<string, string> = {
  region: 'Allowed location', architecture: 'Model compatibility',
  modality: 'Text, image or audio support', quality: 'Answer quality',
  latency: 'Response speed', budget: 'Budget', quota: 'Account quota',
  capacity: 'Obtainable capacity', recipe: 'Serving software', license: 'Usage terms',
  weights_exportable: 'Access to model files', ops: 'Operational effort',
  declared_requirements: 'Other declared requirements',
};

function ActualChecks({ candidates }: { candidates: Candidate[] }) {
  return <SpaceBetween size="m">{candidates.map((candidate) => (
    <ExpandableSection key={candidate.candidateId} headerText={hostingOptionName(candidate)}>
      <SpaceBetween size="s">
        {candidate.gates.map((gate) => (
          <div key={gate.name} className="eddie-decision-check">
            <StatusIndicator type={gate.status === 'PASS' ? 'success' : gate.status === 'FAIL' ? 'error' : 'pending'}>
              {CHECK_LABELS[gate.name] ?? gate.name.replaceAll('_', ' ')} · {gate.status === 'PASS' ? 'Check passed' : gate.status === 'FAIL' ? 'Not met' : 'Needs verification'}
            </StatusIndicator>
            <Box variant="small" color="text-body-secondary">{gate.reason ?? 'No reason was supplied for this check.'}</Box>
            {gate.evidenceRef ? <Box variant="small">Evidence reference: {gate.evidenceRef}</Box> : null}
          </div>
        ))}
      </SpaceBetween>
    </ExpandableSection>
  ))}</SpaceBetween>;
}

/** A readable decision trail from actual gates, not a model's hidden reasoning. */
export function HostingDecisionPath({ result, outdated, cpuFirst, onAsk, onBedrock, onDeploy, onCompute }: {
  result: EvaluateResponse | null;
  outdated: boolean;
  cpuFirst: boolean;
  onAsk: (prompt: string) => void;
  onBedrock: () => void;
  onDeploy: () => void;
  onCompute: (compute: 'cpu' | 'gpu') => void;
}) {
  const candidates = result && !outdated ? [...result.ranked, ...result.unresolved, ...result.excluded] : [];
  const nativeOnly = candidates.length > 0 && candidates.every((candidate) => candidate.target === 'BEDROCK_NATIVE');
  const groups = [
    {
      id: 'native', title: 'Use an existing Amazon Bedrock model',
      description: 'Choose a model already hosted by AWS and access it through an authenticated API.',
      candidates: candidates.filter((candidate) => candidate.target === 'BEDROCK_NATIVE'),
      note: 'Standard text token pricing uses live AWS rates and your usage estimates. Account access, quota headroom and task quality are separate checks.',
      action: 'Browse Bedrock models', click: onBedrock,
    },
    {
      id: 'import', title: 'Import your model into Amazon Bedrock',
      description: 'For supported model architectures. Imported models are billed for active model copies and storage.',
      candidates: candidates.filter((candidate) => candidate.target === 'BEDROCK_CMI'),
      note: 'Import options can be compared here. Automated import deployment is not connected in this installation.',
      action: 'Ask about importing', click: () => onAsk('Could this exact model use Amazon Bedrock Custom Model Import? Explain the compatibility checks, active-copy billing, missing evidence and what deployment support this installation actually has.'),
    },
    {
      id: 'sagemaker', title: 'Use an Amazon SageMaker managed endpoint',
      description: 'Run a reviewed serving container on dedicated compute. You pay while the endpoint exists.',
      candidates: candidates.filter((candidate) => candidate.target === 'SAGEMAKER_REALTIME'),
      note: 'Bounded SageMaker trials are implemented for the reviewed recipes shown at deployment review.',
      action: 'Review a SageMaker trial', click: onDeploy,
    },
    {
      id: 'cpu', title: 'Run a CPU job or endpoint',
      description: 'For compatible workloads, ordinary processors can serve open-weight models. Start here for queued work with low concurrency.',
      candidates: [],
      note: 'Compare AWS Batch, Fargate, EC2, SageMaker CPU and Lambda against runtime, memory and deadline needs. Plan a benchmark before choosing.',
      action: 'Explore CPU compute', click: () => onCompute('cpu'),
    },
    {
      id: 'gpu', title: 'Operate GPUs with EC2 or EKS',
      description: 'More control over serving software, with more responsibility for scaling, updates and recovery.',
      candidates: [],
      note: 'The sizing sheet estimates memory, parallelism and EC2 allocation costs. A compatible runtime and workload benchmark are still required; custom GPU deployment is not automated here.',
      action: 'Explore GPU compute', click: () => onCompute('gpu'),
    },
  ];
  if (cpuFirst) groups.unshift(...groups.splice(groups.findIndex((group) => group.id === 'cpu'), 1));
  return (
    <Container header={<Header variant="h2" description="Start with the workload and compare compatible ways to run it.">Hosting paths at a glance</Header>}>
      <SpaceBetween size="l">
        <ColumnLayout columns={3}>
          <div><Box fontWeight="bold">1. Check the requirements</Box><Box variant="small">Compatibility, access, capacity and declared objectives must pass.</Box></div>
          <div><Box fontWeight="bold">2. Compare total costs</Box><Box variant="small">Only qualifying configurations can win. Speed is a requirement, not a price score.</Box></div>
          <div><Box fontWeight="bold">3. Resolve a tie</Box><Box variant="small">Prefer less operational effort, a smaller failure impact, then location preference.</Box></div>
        </ColumnLayout>
        {groups.filter((group) => !nativeOnly || group.id === 'native').map((group) => (
          <div key={group.id} className="eddie-hosting-path">
            <div className="eddie-inline-summary">
              <Box variant="h3">{group.title}</Box>
              <StatusIndicator type={group.candidates.some((candidate) => candidate.isFeasible) ? 'success' : 'info'}>
                {group.candidates.length ? `${group.candidates.length} configurations evaluated` : 'Not evaluated in this run'}
              </StatusIndicator>
            </div>
            <Box>{group.description}</Box>
            <Box variant="small" color="text-body-secondary">{group.note}</Box>
            {group.candidates.length ? <ActualChecks candidates={group.candidates} /> : null}
            <SpaceBetween direction="horizontal" size="s">
              <Button onClick={group.click}>{group.action}</Button>
              {group.candidates.length ? <Button iconName="gen-ai" onClick={() => onAsk(
                `Help me challenge the ${group.title} option for this project. Explain its actual checks and the specific evidence or requirement change that would alter the decision. Ask before changing an objective, then re-evaluate the agreed change.`,
              )}>Challenge this option</Button> : null}
            </SpaceBetween>
          </div>
        ))}
        {nativeOnly ? (
          <ExpandableSection headerText="Why are import, SageMaker and GPU hosting not listed for this model?">
            <Box>
              You selected a model already hosted by Amazon Bedrock. Its API does not provide model files
              to import or run on your own compute. To compare self-hosting, choose a downloadable model in
              Models &amp; sources. A different model also needs its own answer-quality evaluation.
            </Box>
          </ExpandableSection>
        ) : null}
        {outdated ? <StatusIndicator type="warning">Your inputs changed. Update the comparison to see the current checks.</StatusIndicator> : null}
      </SpaceBetween>
    </Container>
  );
}
