import type { ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Icon from '@cloudscape-design/components/icon';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { EvaluateResponse, Evidence } from '../api/types';
import { EvidenceBadge } from './EvidenceBadge';
import {
  ConditionalBadge,
  LatencyStatusBadge,
  OutdatedDecisionWarning,
} from './DecisionStatus';
import {
  UNKNOWN_LABEL,
  formatMoney,
  formatPercent,
  targetShortLabel,
} from './format';

export interface KpiCardProps {
  label: string;
  /** Already-formatted headline value. `UNKNOWN` is a legitimate value. */
  value: string;
  evidence: Evidence;
  /** Small line beneath the headline. */
  secondary?: string | null;
  /** Right-aligned supporting metric, mirroring the reference dashboards. */
  aside?: ReactNode;
  iconName?: 'status-positive' | 'status-warning' | 'status-info' | 'status-negative';
}

/**
 * One KPI tile: big number, evidence label, and a supporting metric.
 *
 * Colour comes only from Cloudscape `Box` colour tokens and `Icon`, so both
 * themes are correct by construction — there are no literal colour values.
 */
export function KpiCard({
  label,
  value,
  evidence,
  secondary,
  aside,
  iconName,
}: KpiCardProps) {
  const isUnknown = value === UNKNOWN_LABEL;
  return (
    <div>
      <SpaceBetween size="xxs">
        <Box variant="awsui-key-label">
          {iconName ? (
            <>
              <Icon name={iconName} size="small" />{' '}
            </>
          ) : null}
          {label}
        </Box>
        <Box
          fontSize="display-l"
          fontWeight="bold"
          color={isUnknown ? 'text-status-inactive' : 'text-status-info'}
        >
          {value}
        </Box>
        <SpaceBetween direction="horizontal" size="xs">
          <EvidenceBadge evidence={evidence} />
          {aside ? (
            <Box variant="small" color="text-body-secondary">
              {aside}
            </Box>
          ) : null}
        </SpaceBetween>
        {secondary ? (
          <Box variant="small" color="text-body-secondary">
            {secondary}
          </Box>
        ) : null}
      </SpaceBetween>
    </div>
  );
}

/**
 * The KPI row shown across the top of the case workspace after a result.
 *
 * Every tile is derived from the solver's own output. A value the solver did
 * not produce reads as UNKNOWN, never as zero and never as a blank tile.
 */
export function ResultKpiRow({
  result,
  outdatedFields = [],
}: {
  result: EvaluateResponse;
  /** Non-empty when a consequential input changed after this was computed. */
  outdatedFields?: string[];
}) {
  const winner = result.winner;
  const breakeven = result.breakeven;

  // Cost is PROJECTED at best: it is computed from declared inputs and live
  // prices, never observed. It is UNKNOWN when the solver could not price it.
  const costEvidence: Evidence = !winner?.cost
    ? 'UNKNOWN'
    : winner.cost.total === null
      ? 'UNKNOWN'
      : 'PROJECTED';

  const dutyEvidence: Evidence = breakeven?.actualDutyPercent
    ? 'PROJECTED'
    : 'UNKNOWN';
  const breakevenEvidence: Evidence = breakeven?.breakevenDutyPercent
    ? 'PROJECTED'
    : 'UNKNOWN';

  const outdated = outdatedFields.length > 0;

  return (
    <Container disableContentPaddings={false}>
      <SpaceBetween size="m">
        {/* A visible warning, not a tint: a 72-hour result sat beside a
            720-hour form with no notice at all in the previous build. */}
        <OutdatedDecisionWarning outdatedFields={outdatedFields} />
        <ColumnLayout columns={4} variant="text-grid" minColumnWidth={180}>
        <KpiCard
          label={outdated ? 'Recommended target (out of date)' : 'Recommended target'}
          value={winner ? targetShortLabel(winner.target) : UNKNOWN_LABEL}
          evidence={outdated ? 'UNKNOWN' : winner ? 'PROJECTED' : 'UNKNOWN'}
          iconName={winner ? 'status-positive' : 'status-warning'}
          secondary={
            winner
              ? winner.candidateId
              : 'No candidate passed every gate, so nothing is recommended.'
          }
        />
        <KpiCard
          label={`Total cost over ${result.horizonHours} h`}
          value={formatMoney(winner?.cost?.total ?? null)}
          evidence={costEvidence}
          iconName="status-info"
          secondary={
            winner?.cost && !winner.cost.isComplete
              ? 'Incomplete — at least one component is UNKNOWN.'
              : winner?.cost
                ? 'Priced over the same horizon as every other candidate.'
                : 'The solver produced no cost model.'
          }
        />
        <KpiCard
          label="Break-even duty cycle"
          value={formatPercent(breakeven?.breakevenDutyPercent ?? null)}
          evidence={breakevenEvidence}
          iconName="status-info"
          secondary="Below this, burst pricing wins. Above it, a continuously allocated endpoint wins."
        />
        <KpiCard
          label="Actual duty cycle"
          value={formatPercent(breakeven?.actualDutyPercent ?? null)}
          evidence={dutyEvidence}
          iconName={
            breakeven?.verdict === 'BURST_FAVOURS_CMI'
              ? 'status-positive'
              : breakeven?.verdict === 'STEADY_FAVOURS_DEDICATED'
                ? 'status-positive'
                : 'status-warning'
          }
          secondary={
            breakeven?.verdict
              ? `Verdict: ${breakeven.verdict}`
              : 'No break-even verdict was reached.'
          }
        />
        </ColumnLayout>
        <SpaceBetween direction="horizontal" size="xs">
          <LatencyStatusBadge
            qualification={result.qualification}
            ranked={result.ranked}
          />
          <ConditionalBadge qualification={result.qualification} />
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}
