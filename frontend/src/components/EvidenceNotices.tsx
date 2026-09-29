import { BrandName, brandText } from './BrandName';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type {
  Freshness,
  LatencyEvidenceProvenance,
  Qualification,
} from '../api/types';
import { FreshnessBadge } from './EvidenceBadge';
import { formatTimestamp } from './format';

/**
 * Persistent warning shown whenever the backend reports that licence, quota,
 * recipe and capacity checks were *stipulated* rather than verified. This
 * alert is not dismissible — the caveat applies for the whole result.
 */
export function StipulationWarning({
  checksStipulated,
}: {
  checksStipulated: boolean;
}) {
  if (!checksStipulated) return null;
  return (
    <Alert
      type="warning"
      statusIconAriaLabel="Warning"
      header="Licence, quota, recipe and capacity checks were stipulated, not verified"
    >
      This evaluation ran with <Box variant="code">assumeChecksCleared</Box>{' '}
      set. <BrandName /> did not confirm model licence terms, service quotas, recipe
      support or held capacity against your account. Treat the ranking as
      conditional on those checks passing, and verify them before committing
      spend or deploying.
    </Alert>
  );
}

/**
 * Labels the origin of the latency numbers. EDDIE must never imply it
 * measured latency it was merely handed.
 */
export function LatencyProvenanceNotice({
  provenance,
  qualification,
}: {
  provenance: LatencyEvidenceProvenance;
  qualification: Qualification | null;
}) {
  const measured = qualification?.performanceMeasured === true;

  if (provenance === 'SUPPLIED') {
    return (
      <Alert
        type="info"
        statusIconAriaLabel="Information"
        header={brandText("Latency evidence was supplied, not measured by EDDIE")}
      >
        <SpaceBetween size="xs">
          <Box variant="span">
            The latency figures used by the SLO gates came from the request
            payload. <BrandName /> did not run a benchmark, so these values are not an{' '}
            <BrandName /> measurement and carry the submitter's provenance.
          </Box>
          {qualification?.note ? (
            <Box variant="small">{qualification.note}</Box>
          ) : null}
        </SpaceBetween>
      </Alert>
    );
  }

  return (
    <Alert
      type="info"
      statusIconAriaLabel="Information"
      header="No latency evidence was supplied"
    >
      <SpaceBetween size="xs">
        <Box variant="span">
          No latency evidence accompanied this request, so latency gates cannot
          resolve to PASS. Candidates that depend on a latency gate are reported
          as unresolved rather than ranked.
          {measured
            ? ''
            : ' Performance has not been measured for any candidate.'}
        </Box>
        {qualification?.note ? (
          <Box variant="small">{qualification.note}</Box>
        ) : null}
      </SpaceBetween>
    </Alert>
  );
}

/**
 * Summarises price-list freshness. A PINNED rate anywhere in the snapshot
 * raises a warning, because the cost ranking then rests on a fallback price.
 */
export function PriceFreshnessNotice({
  priceFreshness,
  retrievedAt,
}: {
  priceFreshness: Record<string, Freshness>;
  retrievedAt: string | null;
}) {
  const entries = Object.entries(priceFreshness ?? {});
  if (entries.length === 0) {
    return (
      <Alert type="warning" statusIconAriaLabel="Warning" header="Price freshness unknown">
        The result carried no price-freshness information. The cost figures
        cannot be attributed to a live or pinned price list.
      </Alert>
    );
  }

  const hasNonLive = entries.some(([, value]) => value !== 'LIVE');

  return (
    <Alert
      type={hasNonLive ? 'warning' : 'success'}
      statusIconAriaLabel={hasNonLive ? 'Warning' : 'Success'}
      header={
        hasNonLive
          ? 'Some prices are pinned or unknown'
          : 'All prices retrieved live'
      }
    >
      <SpaceBetween size="xs">
        <SpaceBetween direction="horizontal" size="s">
          {entries.map(([family, value]) => (
            <FreshnessBadge key={family} freshness={value} label={family} />
          ))}
        </SpaceBetween>
        <Box variant="small" color="text-body-secondary">
          Prices retrieved at {formatTimestamp(retrievedAt)}.
        </Box>
      </SpaceBetween>
    </Alert>
  );
}
