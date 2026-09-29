import { BrandName, brandText } from '../components/BrandName';
import { lazy, Suspense } from 'react';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import { HealthIndicator } from '../components/HealthIndicator';
import { UNKNOWN_LABEL } from '../components/format';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthContext';

/**
 * Settings: administration, status and the things that used to clutter every screen.
 *
 * UXR-01 and UXR-02. Region, solver version, release id, COA knowledge state and
 * EDDIE's own infrastructure sleep/wake were previously on a strip above every page,
 * including the empty first-use screen. None of them helps someone describe an
 * application, and they were most of what made the product read as an engineering
 * console. They are real and useful — to an operator, here.
 *
 * **EDDIE infrastructure** is labelled explicitly so it cannot be mistaken for
 * deploying a workload: it wakes and sleeps EDDIE's own knowledge stack to control cost.
 */

const KnowledgePage = lazy(() => import('./KnowledgePage'));
const DemoLifecyclePage = lazy(() => import('./DemoLifecyclePage'));

function Loading() {
  return (
    <Box textAlign="center" padding={{ vertical: 'l' }}>
      <Spinner />
    </Box>
  );
}

export function SettingsPage() {
  const { config, health } = useApp();
  const { session } = useAuth();

  const region = health.data?.region ?? config.region ?? UNKNOWN_LABEL;
  const solverVersion = health.data?.solverVersion ?? UNKNOWN_LABEL;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Account, service status and administration."
        >
          Settings
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">This installation</Header>}>
          <ColumnLayout columns={3} variant="text-grid">
            <SpaceBetween size="xxxs">
              <Box variant="awsui-key-label">Signed in as</Box>
              <Box variant="p">
                {session?.email ?? session?.username ?? UNKNOWN_LABEL}
              </Box>
            </SpaceBetween>
            <SpaceBetween size="xxxs">
              <Box variant="awsui-key-label">AWS Region</Box>
              {/*
                The Region EDDIE itself runs in. A workload's Region is a separate
                value set per case, and UXR-03 requires they never be presented as
                interchangeable.
              */}
              <Box variant="p">{region}</Box>
              <Box variant="small" color="text-body-secondary">
                Where <BrandName /> runs. The Region a workload must run in is part of each
                conversation's requirements.
              </Box>
            </SpaceBetween>
            <SpaceBetween size="xxxs">
              <Box variant="awsui-key-label">Service status</Box>
              <HealthIndicator health={health} />
            </SpaceBetween>
          </ColumnLayout>
        </Container>

        <ExpandableSection
          variant="container"
          headerText={brandText("EDDIE infrastructure")}
          headerDescription="Wake and sleep the knowledge stack to control cost. This does not deploy or affect any model you are hosting."
        >
          <Suspense fallback={<Loading />}>
            <DemoLifecyclePage />
          </Suspense>
        </ExpandableSection>

        <ExpandableSection
          variant="container"
          headerText="Knowledge"
          headerDescription="Approved reference material for the Advisor. It never changes a price, a requirement check or a recommendation."
        >
          <Suspense fallback={<Loading />}>
            <KnowledgePage />
          </Suspense>
        </ExpandableSection>

        <ExpandableSection
          variant="container"
          headerText="Technical details"
          headerDescription="Identifiers for support and diagnostics."
        >
          <ColumnLayout columns={2} variant="text-grid">
            <SpaceBetween size="xxxs">
              <Box variant="awsui-key-label">Solver version</Box>
              <Box variant="code" fontSize="body-s">
                {solverVersion}
              </Box>
            </SpaceBetween>
            <SpaceBetween size="xxxs">
              <Box variant="awsui-key-label">Release</Box>
              <Box variant="code" fontSize="body-s">
                {config.releaseId ?? UNKNOWN_LABEL}
              </Box>
            </SpaceBetween>
          </ColumnLayout>
        </ExpandableSection>
      </SpaceBetween>
    </ContentLayout>
  );
}

export default SettingsPage;
