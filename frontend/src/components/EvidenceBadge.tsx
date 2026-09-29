import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Popover from '@cloudscape-design/components/popover';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { Evidence, Freshness, GateStatus } from '../api/types';
import { brandText } from './BrandName';

const EVIDENCE_EXPLANATION: Record<Evidence, string> = {
  MEASURED: 'Derived from an observed measurement recorded against this exact candidate.',
  PROJECTED: 'Calculated from declared workload inputs and current prices. Not an observation.',
  UNKNOWN: 'EDDIE has no evidence for this value. It is not zero and not assumed.',
};

const EVIDENCE_COLOR: Record<Evidence, 'green' | 'blue' | 'grey'> = {
  MEASURED: 'green',
  PROJECTED: 'blue',
  UNKNOWN: 'grey',
};

/**
 * Evidence provenance label. Every number in EDDIE carries one of these so a
 * projection is never mistaken for a measurement.
 */
export function EvidenceBadge({ evidence }: { evidence: Evidence }) {
  return (
    <Popover
      dismissButton={false}
      position="top"
      size="small"
      triggerType="text"
      header={`Evidence: ${evidence}`}
      content={<Box variant="span">{brandText(EVIDENCE_EXPLANATION[evidence])}</Box>}
    >
      <Badge color={EVIDENCE_COLOR[evidence]}>{evidence}</Badge>
    </Popover>
  );
}

const FRESHNESS_EXPLANATION: Record<Freshness, string> = {
  LIVE: 'Retrieved from the AWS Price List API for this evaluation.',
  PINNED: 'A pinned fallback rate was used because the live price could not be retrieved. Verify before committing spend.',
  UNKNOWN: 'Price freshness could not be established for this rate family.',
};

const FRESHNESS_TYPE: Record<
  Freshness,
  'success' | 'warning' | 'info'
> = {
  LIVE: 'success',
  PINNED: 'warning',
  UNKNOWN: 'info',
};

/** Price-list freshness indicator: LIVE vs PINNED vs UNKNOWN. */
export function FreshnessBadge({
  freshness,
  label,
}: {
  freshness: Freshness;
  label?: string;
}) {
  return (
    <Popover
      dismissButton={false}
      position="top"
      size="small"
      triggerType="text"
      header={`Price freshness: ${freshness}`}
      content={<Box variant="span">{FRESHNESS_EXPLANATION[freshness]}</Box>}
    >
      <StatusIndicator type={FRESHNESS_TYPE[freshness]}>
        {label ? `${label}: ${freshness}` : freshness}
      </StatusIndicator>
    </Popover>
  );
}

const GATE_TYPE: Record<GateStatus, 'success' | 'error' | 'pending'> = {
  PASS: 'success',
  FAIL: 'error',
  UNKNOWN: 'pending',
};

/**
 * Gate outcome. Uses a text label alongside the colour so status is never
 * conveyed by colour alone.
 */
export function GateStatusBadge({ status }: { status: GateStatus }) {
  return <StatusIndicator type={GATE_TYPE[status]}>{status}</StatusIndicator>;
}

/** Counts of failing / unknown gates, for a compact summary cell. */
export function GateSummary({
  failureCount,
  unknownCount,
}: {
  failureCount: number;
  unknownCount: number;
}) {
  if (failureCount === 0 && unknownCount === 0) {
    return <StatusIndicator type="success">All gates pass</StatusIndicator>;
  }
  return (
    <SpaceBetween direction="horizontal" size="xs">
      {failureCount > 0 ? (
        <StatusIndicator type="error">
          {failureCount} failed
        </StatusIndicator>
      ) : null}
      {unknownCount > 0 ? (
        <StatusIndicator type="pending">
          {unknownCount} unknown
        </StatusIndicator>
      ) : null}
    </SpaceBetween>
  );
}
