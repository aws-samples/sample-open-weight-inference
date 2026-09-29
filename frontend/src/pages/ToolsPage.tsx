import { BrandName, brandText } from '../components/BrandName';
import { lazy, Suspense } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';

/**
 * Tools: direct entry to one operation, backed by the same services the conversation
 * calls.
 *
 * UXR-01. A user who only wants to know which Region has cheaper H100s should not have
 * to fill in a model intake form first. Each tool is the same typed backend service the
 * advisor would call, reached directly.
 *
 * Tools that are not implemented say so, with what they will do and the one that does
 * work instead. An empty page or a disabled control with no explanation is worse than an
 * honest absence.
 */

const CatalogPage = lazy(() => import('./CatalogPage'));
const RatesPage = lazy(() => import('./RatesPage'));

function Loading() {
  return (
    <Box textAlign="center" padding={{ vertical: 'xl' }}>
      <Spinner size="large" />
    </Box>
  );
}

const TOOLS: Record<
  string,
  { title: string; description: string; implemented: boolean; missing?: string }
> = {
  'find-model': {
    title: 'Find a model',
    description:
      'Models Amazon Bedrock already serves in this account, and what they support.',
    implemented: true,
  },
  'compare-prices': {
    title: 'Compare prices',
    description:
      'Current AWS prices for the instances and import options EDDIE evaluates, with the exact SKU each figure came from.',
    implemented: true,
  },
  'find-gpu': {
    title: 'Find GPU capacity',
    description:
      'Which Regions offer a GPU instance type, what your account limits allow, and what capacity evidence exists.',
    implemented: false,
    missing:
      'The GPU discovery collectors are not implemented yet. Offering, account quota and capacity evidence are three different things and this tool must keep them apart rather than implying availability, so it is not shipped until it can.',
  },
  'test-endpoint': {
    title: 'Test an endpoint',
    description:
      'Measure response time and quality against your requirements, on a bounded, approved test.',
    implemented: false,
    missing:
      'The benchmark harness is not implemented yet. Until it is, response-time requirements stay unmeasured rather than being estimated — a smoke test cannot establish a tail latency.',
  },
  reports: {
    title: 'Reports',
    description:
      'A shareable summary of a comparison, with the same figures and evidence labels shown here.',
    implemented: false,
    missing: 'Report export is not implemented yet.',
  },
};

export function ToolsPage() {
  const { toolId } = useParams<{ toolId: string }>();
  const navigate = useNavigate();
  const tool = toolId ? TOOLS[toolId] : undefined;

  if (!tool) {
    return (
      <ContentLayout header={<Header variant="h1">Tool not found</Header>}>
        <Alert
          type="warning"
          statusIconAriaLabel="Warning"
          action={<Button onClick={() => navigate('/')}>Go to Workspace</Button>}
        >
          {`There is no tool called "${toolId ?? ''}". Available tools are listed under
          Tools in the top bar.`}
        </Alert>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={brandText(tool.description)}
          actions={
            <Button onClick={() => navigate('/')}>Back to Workspace</Button>
          }
        >
          {tool.title}
        </Header>
      }
    >
      {tool.implemented ? (
        <Suspense fallback={<Loading />}>
          {toolId === 'find-model' ? <CatalogPage /> : null}
          {toolId === 'compare-prices' ? <RatesPage /> : null}
        </Suspense>
      ) : (
        <Alert
          type="info"
          statusIconAriaLabel="Information"
          header="Not available yet"
          data-testid="tool-unavailable"
          action={<Button onClick={() => navigate('/')}>Ask in the conversation</Button>}
        >
          <SpaceBetween size="xs">
            <Box variant="span">{tool.missing}</Box>
            <Box variant="small" color="text-body-secondary">
              You can still describe what you need in the conversation. <BrandName /> will
              say what it can establish and what would have to be measured.
            </Box>
          </SpaceBetween>
        </Alert>
      )}
    </ContentLayout>
  );
}

export default ToolsPage;
