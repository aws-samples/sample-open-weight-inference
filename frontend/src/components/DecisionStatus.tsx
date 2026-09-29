import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Popover from '@cloudscape-design/components/popover';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { brandText } from './BrandName';
import type {
  Candidate,
  LatencyStatus,
  Qualification,
  UnsupportedInput,
} from '../api/types';

/**
 * The solver's own reason for not qualifying supplied evidence as a
 * measurement, e.g. "run run-abc covers p99_latency_ms but not ttft_ms".
 *
 * More useful than the generic status, so it is surfaced verbatim rather than
 * paraphrased. Taken from the latency gate of any ranked candidate.
 */
export function latencyGateReason(
  candidates: Candidate[] | null | undefined
): string | null {
  for (const candidate of candidates ?? []) {
    for (const gate of candidate.gates) {
      if (gate.name === 'latency' && gate.reason) return gate.reason;
    }
  }
  return null;
}

const LATENCY_COPY: Record<
  LatencyStatus,
  {
    label: string;
    indicator: 'success' | 'warning' | 'info' | 'pending';
    body: string;
  }
> = {
  MEASURED: {
    label: 'Latency measured',
    indicator: 'success',
    body: 'Latency was compared against benchmark evidence recorded for this exact candidate key.',
  },
  SUPPLIED: {
    label: 'Latency supplied, not measured',
    indicator: 'warning',
    body: 'Latency came from evidence supplied with the request. EDDIE did not observe it and cannot vouch for it.',
  },
  NOT_MEASURED: {
    label: 'Latency objective unresolved',
    indicator: 'warning',
    body: 'A latency objective was requested but no applicable benchmark evidence exists, so no candidate can qualify on latency.',
  },
  NOT_REQUESTED: {
    label: 'No latency objective requested',
    indicator: 'info',
    body: 'No latency objective was declared, so no latency gate was evaluated and nothing was measured. This is not a demonstrated SLO.',
  },
};

/**
 * Latency provenance as a status, not a boolean.
 *
 * "No SLO requested" and "SLO demonstrated" previously both rendered as
 * `Performance measured: Yes`, which claimed qualification nobody had earned.
 */
export function LatencyStatusBadge({
  qualification,
  /** Ranked candidates, so a SUPPLIED status can name why it fell short. */
  ranked,
}: {
  qualification: Qualification | null;
  ranked?: Candidate[] | null;
}) {
  if (!qualification) {
    return <StatusIndicator type="pending">Latency status UNKNOWN</StatusIndicator>;
  }
  const copy =
    LATENCY_COPY[qualification.latencyStatus] ?? {
      label: qualification.latencyStatus,
      indicator: 'pending' as const,
      body: 'The runtime reported a latency status this interface does not recognise.',
    };
  // MEASURED now requires a *validated* run — applicable to the exact candidate,
  // metric and workload. Anything short of that is SUPPLIED, and the gate says
  // precisely what was short.
  const gateReason =
    qualification.latencyStatus === 'SUPPLIED'
      ? latencyGateReason(ranked)
      : null;
  return (
    <Popover
      dismissButton={false}
      position="top"
      size="medium"
      triggerType="text"
      header={copy.label}
      content={
        <SpaceBetween size="xs">
          <Box variant="span">{brandText(copy.body)}</Box>
          {gateReason ? (
            <Box variant="span" data-testid="latency-gate-reason">
              {gateReason}
            </Box>
          ) : null}
          {qualification.note ? (
            <Box variant="small" color="text-body-secondary">
              {qualification.note}
            </Box>
          ) : null}
          {qualification.benchmarkRunIds.length > 0 ? (
            <Box variant="small">
              Benchmark runs: {qualification.benchmarkRunIds.join(', ')}
            </Box>
          ) : null}
        </SpaceBetween>
      }
    >
      <StatusIndicator type={copy.indicator}>
        <span data-testid="latency-status">{copy.label}</span>
      </StatusIndicator>
    </Popover>
  );
}

/**
 * A conditional result must read as conditional everywhere it appears,
 * including in anything exported from it.
 */
export function ConditionalResultNotice({
  qualification,
  ranked,
}: {
  qualification: Qualification | null;
  ranked?: Candidate[] | null;
}) {
  if (!qualification?.conditional) return null;
  const gateReason =
    qualification.latencyStatus === 'SUPPLIED'
      ? latencyGateReason(ranked)
      : null;
  return (
    <Alert
      type="warning"
      statusIconAriaLabel="Warning"
      header="This is a conditional result"
      data-testid="conditional-notice"
    >
      <SpaceBetween size="xs">
        <Box variant="span">
          Candidates were ranked without measured latency evidence, so the
          ranking holds only if the assumptions behind it are correct. It is not
          a demonstrated placement.
        </Box>
        {gateReason ? (
          <Box variant="span" data-testid="conditional-gate-reason">
            {gateReason}
          </Box>
        ) : null}
        {qualification.note ? (
          <Box variant="small" color="text-body-secondary">
            {qualification.note}
          </Box>
        ) : null}
      </SpaceBetween>
    </Alert>
  );
}

/** Short conditional marker for a compact summary or an export header. */
export function ConditionalBadge({
  qualification,
}: {
  qualification: Qualification | null;
}) {
  if (!qualification?.conditional) return null;
  return <Badge color="severity-medium">Conditional</Badge>;
}

/**
 * Inputs the solver could not act on.
 *
 * Rendered before any recommendation: a requirement that silently failed to
 * reach the solver is worse than one that was rejected, because the prose still
 * discusses it while the ranking ignores it.
 */
export function UnsupportedInputsAlert({
  unsupportedInputs,
}: {
  unsupportedInputs: UnsupportedInput[] | null | undefined;
}) {
  if (!unsupportedInputs || unsupportedInputs.length === 0) return null;
  return (
    <Alert
      type="warning"
      statusIconAriaLabel="Warning"
      header={`${unsupportedInputs.length} input${
        unsupportedInputs.length === 1 ? '' : 's'
      } could not be applied`}
      data-testid="unsupported-inputs"
    >
      <SpaceBetween size="xs">
        <Box variant="span">
          The solver could not act on the following, so they did not affect the
          result below. Correct them and evaluate again rather than reading the
          ranking as if they had applied.
        </Box>
        <Table<UnsupportedInput>
          variant="embedded"
          contentDensity="compact"
          items={unsupportedInputs}
          trackBy="field"
          ariaLabels={{ tableLabel: 'Inputs the solver could not apply' }}
          columnDefinitions={[
            {
              id: 'field',
              header: 'Field',
              cell: (item) => (
                <Box variant="code" fontSize="body-s">
                  {item.field}
                </Box>
              ),
            },
            { id: 'value', header: 'Value', cell: (item) => item.value },
            { id: 'reason', header: 'Why', cell: (item) => item.reason },
          ]}
          empty={<Box>None.</Box>}
        />
      </SpaceBetween>
    </Alert>
  );
}

/** Confirms the user's refusal of stipulated checks was honoured. */
export function StrictModeNotice({ strict }: { strict: boolean }) {
  if (!strict) return null;
  return (
    <Alert
      type="info"
      statusIconAriaLabel="Information"
      header="Stipulated checks were switched off at your request"
      data-testid="strict-mode-notice"
    >
      Licence, quota, recipe and capacity were evaluated as real gates. Without
      account evidence they resolve to UNKNOWN, so candidates are held out of
      the ranking rather than assumed to pass.
    </Alert>
  );
}

/**
 * The decision no longer describes the current inputs.
 *
 * Deliberately a full warning rather than a subtle tint: the previous build
 * showed a 72-hour result beside a 720-hour form with no notice at all.
 */
export function OutdatedDecisionWarning({
  outdatedFields,
  onReevaluate,
  compact = false,
}: {
  outdatedFields: string[];
  onReevaluate?: () => void;
  compact?: boolean;
}) {
  if (outdatedFields.length === 0) return null;

  if (compact) {
    return (
      <StatusIndicator type="warning">
        <span data-testid="outdated-indicator">
          Out of date — {outdatedFields.length} input
          {outdatedFields.length === 1 ? '' : 's'} changed
        </span>
      </StatusIndicator>
    );
  }

  return (
    <Alert
      type="warning"
      statusIconAriaLabel="Warning"
      header="This result is out of date"
      data-testid="outdated-warning"
      action={
        onReevaluate ? (
          <Button iconName="refresh" onClick={onReevaluate}>
            Evaluate again
          </Button>
        ) : undefined
      }
    >
      <SpaceBetween size="xs">
        <Box variant="span">
          It was computed for different inputs and is kept only as history. It is
          not a recommendation for the case as it stands now.
        </Box>
        <Box variant="small">
          Changed since: {outdatedFields.join(', ')}.
        </Box>
      </SpaceBetween>
    </Alert>
  );
}
