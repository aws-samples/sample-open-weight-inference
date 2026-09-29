import { BrandName, brandText } from './BrandName';
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { ApiError } from '../api/agentcore';
import type { Candidate, EvaluateResponse, Outcome } from '../api/types';
import type { ProgressEntry } from '../state/CaseContext';
import { BreakevenPanel } from './BreakevenPanel';
import { CandidateDetail } from './CandidateDetail';
import { CandidateIssueList, RankedCandidatesTable } from './CandidateTable';
import {
  LatencyProvenanceNotice,
  PriceFreshnessNotice,
  StipulationWarning,
} from './EvidenceNotices';
import {
  ConditionalResultNotice,
  LatencyStatusBadge,
  OutdatedDecisionWarning,
} from './DecisionStatus';
import { WinnerCard } from './WinnerCard';
import { UNKNOWN_LABEL, formatTimestamp, shortHash } from './format';

const OUTCOME_COPY: Record<
  Outcome,
  { header: string; body: string; type: 'success' | 'warning' | 'error' }
> = {
  QUALIFIED_PLACEMENT: {
    header: 'Qualified placement found',
    body: 'At least one candidate passed every gate. The recommended placement is the cheapest of those over the evaluated horizon.',
    type: 'success',
  },
  NO_QUALIFIED_PLACEMENT: {
    header: 'No qualified placement',
    body: 'Candidates were enumerated, but none passed every gate. Nothing is recommended. Close the evidence gaps or relax a constraint listed below.',
    type: 'warning',
  },
  NO_CANDIDATES: {
    header: 'No candidates could be enumerated',
    body: 'The request did not produce any candidate configuration to evaluate. Check the model specification, permitted regions and constraints.',
    type: 'error',
  },
};

export interface ResultsPanelProps {
  result: EvaluateResponse | null;
  loading: boolean;
  error: Error | null;
  onRetry?: () => void;
  /** True before the user has run a first evaluation. */
  neverRun: boolean;
  /** Progress messages streamed by the runtime during evaluation. */
  progress?: ProgressEntry[];
  /** Server-reported elapsed time of the last successful invocation. */
  elapsedMs?: number | null;
  /** Set when the caller renders the break-even panel itself. */
  hideBreakeven?: boolean;
  onCancel?: () => void;
  /** Set when the caller renders the winner card itself. */
  hideWinner?: boolean;
  /** Non-empty when the decision no longer describes the current inputs. */
  outdatedFields?: string[];
  onReevaluate?: () => void;
}

/**
 * The full result surface: outcome, winner, break-even explanation, ranked
 * candidates, and separately the excluded and unresolved candidates.
 */
export function ResultsPanel({
  result,
  loading,
  error,
  onRetry,
  neverRun,
  progress = [],
  elapsedMs = null,
  hideBreakeven = false,
  hideWinner = false,
  outdatedFields = [],
  onReevaluate,
  onCancel,
}: ResultsPanelProps) {
  const [selected, setSelected] = useState<Candidate | null>(null);

  if (loading) {
    return (
      <Container
        header={
          <Header
            variant="h2"
            actions={
              onCancel ? (
                <Button onClick={onCancel}>Stop</Button>
              ) : undefined
            }
          >
            Evaluating placement
          </Header>
        }
      >
        <SpaceBetween size="l">
          <Box textAlign="center" padding={{ vertical: 'l' }}>
            <SpaceBetween size="s">
              <Spinner size="large" />
              <Box variant="p">
                Collecting price evidence and running the deterministic solver.
              </Box>
              <Box variant="small" color="text-body-secondary">
                No billable inference is started by an evaluation.
              </Box>
            </SpaceBetween>
          </Box>

          {progress.length > 0 ? (
            <div>
              <Box variant="h4">Runtime progress</Box>
              <SpaceBetween size="xxs">
                {progress.map((entry, index) => (
                  <StatusIndicator
                    key={`${entry.at}-${index}`}
                    type={index === progress.length - 1 ? 'loading' : 'success'}
                  >
                    {/* Reported verbatim; no percentage is synthesised. */}
                    {entry.message}
                  </StatusIndicator>
                ))}
              </SpaceBetween>
            </div>
          ) : null}
        </SpaceBetween>
      </Container>
    );
  }

  if (error) {
    const asApiError = error instanceof ApiError ? error : null;
    // A handled failure carries a user-facing detail naming the offending
    // field, so it is shown verbatim. A coordinator failure (HTTP 424) has no
    // detail available at all, so no cause is invented.
    const handled = asApiError?.handled === true;
    const coordinatorFailure = asApiError?.code === 'coordinator_failure';
    const header = handled
      ? asApiError?.code === 'invalid_request'
        ? 'The request was rejected as invalid'
        : 'The coordinator reported a failure'
      : coordinatorFailure
        ? 'The coordinator reported an error'
        : 'EDDIE could not complete the evaluation';

    return (
      <Container header={<Header variant="h2">Evaluation failed</Header>}>
        <Alert
          type="error"
          statusIconAriaLabel="Error"
          header={brandText(header)}
          action={
            onRetry ? (
              <Button onClick={onRetry} iconName="refresh">
                Retry evaluation
              </Button>
            ) : undefined
          }
        >
          <SpaceBetween size="xs">
            <Box variant="span" data-testid="evaluate-error-detail">
              {brandText(error.message)}
            </Box>
            {handled && asApiError ? (
              <Box variant="small" color="text-body-secondary">
                Reported by the coordinator as{' '}
                <Box variant="code">{asApiError.code}</Box>. Correct the named
                input and evaluate again.
              </Box>
            ) : null}
            <Box variant="small" color="text-body-secondary">
              Nothing was ranked and no result is shown, rather than showing a
              partial or invented decision.
            </Box>
          </SpaceBetween>
        </Alert>
      </Container>
    );
  }

  if (!result) {
    return (
      <Container header={<Header variant="h2">Placement decision</Header>}>
        <Box textAlign="center" padding={{ vertical: 'xxl' }} color="text-body-secondary">
          <SpaceBetween size="s">
            <Box variant="h3">
              {neverRun ? 'No evaluation yet' : 'No result available'}
            </Box>
            <Box variant="p">
              Set the model, workload and SLOs on the left, then choose{' '}
              <b>Evaluate placement</b>. Try a preset to see how traffic shape
              changes the winner: a 3-day bursty event against an always-on
              30-day service.
            </Box>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const outcome = OUTCOME_COPY[result.outcome] ?? {
    header: `Outcome: ${result.outcome}`,
    body: 'The backend returned an outcome this interface does not recognise. It is shown verbatim rather than reinterpreted.',
    type: 'warning' as const,
  };

  return (
    <SpaceBetween size="l">
      <Alert
        type={outcome.type}
        statusIconAriaLabel={outcome.type}
        header={outcome.header}
      >
        {outcome.body}
      </Alert>

      <OutdatedDecisionWarning
        outdatedFields={outdatedFields}
        onReevaluate={onReevaluate}
      />

      <ConditionalResultNotice
        qualification={result.qualification}
        ranked={result.ranked}
      />

      <StipulationWarning checksStipulated={result.checksStipulated} />

      <LatencyProvenanceNotice
        provenance={result.latencyEvidenceProvenance}
        qualification={result.qualification}
      />

      <PriceFreshnessNotice
        priceFreshness={result.priceFreshness}
        retrievedAt={result.retrievedAt}
      />

      {hideWinner ? null : result.winner ? (
        <WinnerCard winner={result.winner} horizonHours={result.horizonHours} />
      ) : (
        <Container header={<Header variant="h2">Recommended placement</Header>}>
          <Alert
            type="warning"
            statusIconAriaLabel="Warning"
            header="Nothing is recommended"
          >
            <BrandName /> returned no winner for this request. An attractive candidate
            cannot be promoted into the recommendation set while a gate fails or
            remains unresolved.
          </Alert>
        </Container>
      )}

      {hideBreakeven ? null : <BreakevenPanel breakeven={result.breakeven} />}

      <Container
        header={
          <Header
            variant="h2"
            description="Qualified options only. Excluded and unresolved candidates are listed separately below."
          >
            Option comparison
          </Header>
        }
      >
        <SpaceBetween size="m">
          <RankedCandidatesTable
            candidates={result.ranked}
            winnerId={result.winner?.candidateId ?? null}
            selectedId={selected?.candidateId ?? null}
            onSelect={setSelected}
            unresolved={result.unresolved}
            excluded={result.excluded}
          />
          {selected ? (
            <Container
              header={
                <Header
                  variant="h3"
                  actions={
                    <Button
                      onClick={() => setSelected(null)}
                      ariaLabel={`Close detail for ${selected.candidateId}`}
                    >
                      Close
                    </Button>
                  }
                >
                  Detail: {selected.candidateId}
                </Header>
              }
            >
              <CandidateDetail candidate={selected} />
            </Container>
          ) : null}
        </SpaceBetween>
      </Container>

      <CandidateIssueList candidates={result.unresolved} kind="unresolved" />
      <CandidateIssueList candidates={result.excluded} kind="excluded" />

      <Container
        header={
          <Header
            variant="h2"
            description="What the solver assumed, and the identifiers that make this decision reproducible."
          >
            Assumptions and provenance
          </Header>
        }
      >
        <SpaceBetween size="m">
          {result.assumptions.length === 0 ? (
            <Box variant="p" color="text-body-secondary">
              The solver recorded no assumptions for this evaluation.
            </Box>
          ) : (
            <ul>
              {result.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          )}

          <KeyValuePairs
            columns={3}
            items={[
              { label: 'Solver version', value: result.solverVersion || UNKNOWN_LABEL },
              { label: 'Horizon', value: `${result.horizonHours} hours` },
              { label: 'CMI family', value: result.cmiFamily ?? UNKNOWN_LABEL },
              { label: 'Request hash', value: shortHash(result.requestHash, 20) },
              { label: 'Snapshot hash', value: shortHash(result.snapshotHash, 20) },
              { label: 'Prices retrieved', value: formatTimestamp(result.retrievedAt) },
              {
                label: 'Candidate counts',
                value: `${result.counts.ranked} ranked · ${result.counts.unresolved} unresolved · ${result.counts.excluded} excluded`,
              },
              {
                // Rendered as a status, never as a boolean: "no SLO requested"
                // and "SLO demonstrated" must not look alike.
                label: 'Latency status',
                value: (
                  <LatencyStatusBadge
                    qualification={result.qualification}
                    ranked={result.ranked}
                  />
                ),
              },
              {
                label: 'Benchmark runs',
                value:
                  result.qualification?.benchmarkRunIds.length
                    ? result.qualification.benchmarkRunIds.join(', ')
                    : 'None — nothing was measured',
              },
              {
                label: 'Latency evidence',
                value:
                  result.latencyEvidenceProvenance === 'SUPPLIED'
                    ? 'Supplied with the request'
                    : 'None supplied',
              },
              {
                label: 'Runtime elapsed',
                value:
                  elapsedMs === null
                    ? UNKNOWN_LABEL
                    : `${(elapsedMs / 1000).toFixed(2)} s (server-reported)`,
              },
            ]}
          />

          <ExpandableSection headerText="Request echoed by the solver" variant="footer">
            <Box variant="code">
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {JSON.stringify(result.request, null, 2)}
              </pre>
            </Box>
          </ExpandableSection>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
