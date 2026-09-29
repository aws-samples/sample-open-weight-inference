import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { EvaluateResponse } from '../api/types';
import {
  ConditionalBadge,
  LatencyStatusBadge,
  OutdatedDecisionWarning,
} from './DecisionStatus';
import { Money } from './Money';
import { UNKNOWN_LABEL, formatPercent, targetShortLabel } from './format';
import { BreakevenPanel, VERDICT_HEADLINE } from './BreakevenPanel';
import { ResultsPanel } from './ResultsPanel';

/**
 * The compact decision summary that lives in the conversation.
 *
 * The full report — gates, cost line items, ranked/excluded/unresolved,
 * provenance — moves to a details surface. Rendering all of it inline pushed a
 * two-turn conversation to 5,094 px and put the composer below the fold.
 */
export function DecisionSummaryCard({
  result,
  onOpenDetail,
  outdatedFields = [],
  onReevaluate,
  headerText = 'Placement decision',
  headerDescription = 'Produced by the deterministic solver, not written by the advisor.',
}: {
  result: EvaluateResponse;
  onOpenDetail?: () => void;
  outdatedFields?: string[];
  onReevaluate?: () => void;
  headerText?: string;
  headerDescription?: string;
}) {
  const winner = result.winner;
  const breakeven = result.breakeven;
  const qualification = result.qualification;
  const outdated = outdatedFields.length > 0;

  return (
    <Container
      header={
        <Header
          variant="h3"
          description={headerDescription}
          actions={
            onOpenDetail ? (
              <Button
                onClick={onOpenDetail}
                iconName="expand"
                data-testid="open-decision-detail"
              >
                See full decision
              </Button>
            ) : undefined
          }
        >
          {headerText}
        </Header>
      }
    >
      <SpaceBetween size="m">
        {outdated ? (
          <OutdatedDecisionWarning
            outdatedFields={outdatedFields}
            onReevaluate={onReevaluate}
          />
        ) : null}

        <SpaceBetween direction="horizontal" size="xs">
          {outdated ? (
            <Badge color="severity-high">Out of date</Badge>
          ) : winner ? (
            <Badge color="green">Recommended</Badge>
          ) : (
            <Badge color="grey">Nothing recommended</Badge>
          )}
          <ConditionalBadge qualification={qualification} />
          {result.checksStipulated ? (
            <Badge color="severity-medium">Checks stipulated</Badge>
          ) : null}
          <LatencyStatusBadge qualification={qualification} ranked={result.ranked} />
        </SpaceBetween>

        <ColumnLayout columns={4} variant="text-grid" minColumnWidth={150}>
          <div>
            <Box variant="awsui-key-label">Target</Box>
            <Box
              fontSize="heading-l"
              fontWeight="bold"
              color={outdated ? 'text-status-inactive' : 'text-status-info'}
            >
              {winner ? targetShortLabel(winner.target) : UNKNOWN_LABEL}
            </Box>
            <Box variant="small" color="text-body-secondary">
              {winner?.candidateId ?? 'No candidate passed every gate'}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">
              Total over {result.horizonHours} h
            </Box>
            <Box
              fontSize="heading-l"
              fontWeight="bold"
              color={outdated ? 'text-status-inactive' : 'text-status-info'}
            >
              <Money amount={winner?.cost?.total ?? null} />
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Break-even duty</Box>
            <Box fontSize="heading-l" fontWeight="bold">
              {formatPercent(breakeven?.breakevenDutyPercent ?? null)}
            </Box>
            <Box variant="small" color="text-body-secondary">
              Actual {formatPercent(breakeven?.actualDutyPercent ?? null)}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">Candidates</Box>
            <Box fontSize="heading-l" fontWeight="bold">
              {result.counts.ranked}
            </Box>
            <Box variant="small" color="text-body-secondary">
              {result.counts.unresolved} unresolved ·{' '}
              {result.counts.excluded} excluded
            </Box>
          </div>
        </ColumnLayout>

        {breakeven?.verdict ? (
          <StatusIndicator type="info">
            <span data-testid="summary-verdict">
              {VERDICT_HEADLINE[breakeven.verdict]}
            </span>
          </StatusIndicator>
        ) : null}

        {!winner ? (
          <Box variant="small" color="text-body-secondary">
            Nothing is recommended. Open the full decision for the gate that
            blocked each candidate.
          </Box>
        ) : null}
      </SpaceBetween>
    </Container>
  );
}

/**
 * The full decision report, for the shell's details surface.
 *
 * Everything that used to sit inline under a chat turn lives here: the
 * break-even chart, gates, cost line items, ranked/excluded/unresolved and
 * provenance.
 */
export function DecisionDetail({
  result,
  outdatedFields = [],
  onReevaluate,
}: {
  result: EvaluateResponse;
  outdatedFields?: string[];
  onReevaluate?: () => void;
}) {
  return (
    <SpaceBetween size="l">
      <BreakevenPanel breakeven={result.breakeven} />
      <ResultsPanel
        result={result}
        loading={false}
        error={null}
        neverRun={false}
        hideBreakeven
        outdatedFields={outdatedFields}
        onReevaluate={onReevaluate}
      />
    </SpaceBetween>
  );
}
