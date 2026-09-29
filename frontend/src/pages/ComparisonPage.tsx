import { BrandName } from '../components/BrandName';
import { Link as RouterLink } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { BreakevenPanel } from '../components/BreakevenPanel';
import { ResultKpiRow } from '../components/KpiCards';
import { ResultsPanel } from '../components/ResultsPanel';
import { useCase } from '../state/CaseContext';

/**
 * The comparison expanded into the full content width, for reading the option
 * table and the break-even explanation without the requirements form beside
 * it. It shows the same result object as the case workspace — never a
 * separately fetched or differently ordered one.
 */
export function ComparisonPage() {
  const {
    result,
    submitting,
    error,
    evaluate,
    neverRun,
    outdatedFields,
    decisionRecord,
  } = useCase();

  if (!result && !submitting && !error) {
    return (
      <ContentLayout header={<Header variant="h1">Comparison</Header>}>
        <Container>
          <Box
            textAlign="center"
            color="text-body-secondary"
            padding={{ vertical: 'xxl' }}
          >
            <SpaceBetween size="s">
              <Box variant="h3">
                {neverRun ? 'No evaluation yet' : 'No result to compare'}
              </Box>
              <Box variant="p">
                Run an evaluation in Chat or on the case workspace first. This
                view shows that same decision, expanded for reading.
              </Box>
              <div>
                {/* `/` is Chat; the requirements form lives at `/case`. */}
                <RouterLink to="/case">
                  <Button variant="primary">Go to the case workspace</Button>
                </RouterLink>
              </div>
            </SpaceBetween>
          </Box>
        </Container>
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="The full option comparison for the current case, at content width."
          actions={
            <Button
              iconName="refresh"
              onClick={() => void evaluate()}
              loading={submitting}
              loadingText="Re-evaluating"
            >
              Re-evaluate
            </Button>
          }
        >
          Comparison
        </Header>
      }
    >
      <SpaceBetween size="l">
        {result ? (
          <>
            {decisionRecord?.source === 'chat' ? (
              <Alert type="info" statusIconAriaLabel="Information">
                This decision came from the conversation. Chat, the case
                workspace and this view all show the same one.
              </Alert>
            ) : null}
            <ResultKpiRow result={result} outdatedFields={outdatedFields} />
            <BreakevenPanel breakeven={result.breakeven} />
            <Alert type="info" statusIconAriaLabel="Information">
              Selecting an option here records nothing and provisions nothing.{' '}
              <BrandName />'s evaluation is a decision aid; deployment is a separate,
              explicitly approved step.
            </Alert>
          </>
        ) : null}
        <ResultsPanel
          result={result}
          loading={submitting}
          error={error}
          onRetry={() => void evaluate()}
          neverRun={neverRun}
          hideBreakeven
          outdatedFields={outdatedFields}
          onReevaluate={() => void evaluate()}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}

export default ComparisonPage;
