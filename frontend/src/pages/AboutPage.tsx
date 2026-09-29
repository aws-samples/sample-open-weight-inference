import { BrandName, brandText } from '../components/BrandName';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { UNKNOWN_LABEL, formatTimestamp } from '../components/format';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthContext';
import { minutesRemaining } from '../auth/refresh';

/** Environment and identity facts, so "which account am I in?" is answerable. */
export function AboutPage() {
  const { config, health, client } = useApp();
  const { session } = useAuth();
  const limits = health.data?.limits ?? null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={brandText("What EDDIE is, and exactly which environment this browser is connected to.")}
        >
          About <BrandName />
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">What <BrandName /> does</Header>}>
          <SpaceBetween size="m">
            <Box variant="p">
              <BrandName /> helps qualify a workload, evaluate model evidence,
              compare inference hosting options and plan a supported deployment.
              The workspace includes Bedrock, SageMaker and CPU or GPU planning paths.
            </Box>
            <Box variant="p">
              The solver compares costs only after checking the requirements.
              Traffic shape, model compatibility, measurements and operational needs
              affect the result. Missing evidence stays unverified.
            </Box>
            <Box variant="p">
              The optional Advisor uses skill files for decision methods and AWS
              Knowledge MCP for current service documentation. Application tools
              provide model facts, prices and calculations. Source receipts show
              what was retrieved; documentation does not approve a deployment.
            </Box>
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              description={brandText("Read-only. EDDIE never changes region or account on your behalf.")}
            >
              Environment
            </Header>
          }
        >
          <KeyValuePairs
            columns={3}
            items={[
              { label: 'Region', value: config.region },
              { label: 'Release', value: config.releaseId ?? UNKNOWN_LABEL },
              {
                label: 'Solver version',
                value: health.data?.solverVersion ?? UNKNOWN_LABEL,
              },
              {
                label: 'Control plane',
                value: 'AgentCore Runtime (invoked directly from the browser)',
              },
              {
                label: 'Agent runtime ARN',
                value: (
                  <Box variant="code" fontSize="body-s">
                    {config.agentRuntimeArn}
                  </Box>
                ),
              },
              {
                label: 'Runtime session id',
                value: (
                  <Box variant="code" fontSize="body-s">
                    {client.sessionId}
                  </Box>
                ),
              },
              {
                label: 'Health reported at',
                value: formatTimestamp(health.data?.timestamp ?? null),
              },
              {
                label: 'Price list',
                value: health.data
                  ? `${health.data.priceList?.status ?? UNKNOWN_LABEL} · sample rate ${
                      health.data.priceList?.sampleRate ?? UNKNOWN_LABEL
                    }`
                  : UNKNOWN_LABEL,
              },
              {
                label: 'Optional COA knowledge base',
                value: health.data?.knowledge?.state ?? UNKNOWN_LABEL,
              },
              {
                label: 'AWS documentation',
                value: health.data?.awsDocumentation?.state === 'CONFIGURED'
                  ? 'Configured - retrieval status appears with each answer'
                  : health.data?.awsDocumentation?.state ?? UNKNOWN_LABEL,
              },
            ]}
          />
        </Container>

        <Container
          header={
            <Header
              variant="h2"
              description="Execution ceilings reported by the runtime. A request that would exceed them fails rather than silently truncating."
            >
              Runtime limits
            </Header>
          }
        >
          {limits ? (
            <KeyValuePairs
              columns={3}
              items={[
                {
                  label: 'Synchronous request',
                  value: `${limits.syncRequestMinutes} minutes`,
                },
                {
                  label: 'Streaming request',
                  value: `${limits.streamingMinutes} minutes`,
                },
                {
                  label: 'Asynchronous job',
                  value: `${limits.asyncJobHours} hours`,
                },
              ]}
            />
          ) : (
            <Box variant="p" color="text-body-secondary">
              The runtime did not report its limits, so they are {UNKNOWN_LABEL}{' '}
              rather than assumed.
            </Box>
          )}
        </Container>

        <Container header={<Header variant="h2">Your session</Header>}>
          <KeyValuePairs
            columns={3}
            items={[
              { label: 'Signed in as', value: session?.username ?? UNKNOWN_LABEL },
              { label: 'Email', value: session?.email ?? 'Not provided' },
              {
                label: 'Access token expires in',
                value:
                  minutesRemaining(session) === null
                    ? UNKNOWN_LABEL
                    : `${minutesRemaining(session)} minutes (refreshed silently)`,
              },
              { label: 'User pool', value: config.userPoolId },
            ]}
          />
        </Container>

        <Container header={<Header variant="h2">Reference documentation</Header>}>
          <SpaceBetween size="xs">
            <Link
              external
              externalIconAriaLabel="Opens in a new tab"
              href="https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html"
            >
              Bedrock Custom Model Import
            </Link>
            <Link
              external
              externalIconAriaLabel="Opens in a new tab"
              href="https://docs.aws.amazon.com/sagemaker/latest/dg/realtime-endpoints.html"
            >
              SageMaker real-time endpoints
            </Link>
            <Link
              external
              externalIconAriaLabel="Opens in a new tab"
              href="https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html"
            >
              Amazon Bedrock AgentCore
            </Link>
          </SpaceBetween>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}

export default AboutPage;
