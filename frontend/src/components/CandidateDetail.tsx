import { BrandName } from './BrandName';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import type { Candidate, CostItem, Gate } from '../api/types';
import { EvidenceBadge, GateStatusBadge } from './EvidenceBadge';
import { Money, RateSummary } from './Money';
import { UNKNOWN_LABEL, formatQuantity, targetLabel } from './format';

/** Configuration facts that make a candidate a distinct candidate. */
export function CandidateConfiguration({ candidate }: { candidate: Candidate }) {
  return (
    <KeyValuePairs
      columns={3}
      items={[
        { label: 'Candidate ID', value: candidate.candidateId },
        { label: 'Target', value: targetLabel(candidate.target) },
        { label: 'Region', value: candidate.region || UNKNOWN_LABEL },
        { label: 'Model reference', value: candidate.modelRef || UNKNOWN_LABEL },
        {
          label: 'Instance type',
          value: candidate.instanceType ?? 'Not applicable',
        },
        { label: 'Instance count', value: candidate.instanceCount },
        {
          label: 'CMUs per copy',
          value: candidate.cmusPerCopy ?? 'Not applicable',
        },
        { label: 'Scales to zero', value: candidate.scaleToZero ? 'Yes' : 'No' },
        { label: 'Prewarmed', value: candidate.prewarmed ? 'Yes' : 'No' },
        { label: 'Ops burden', value: candidate.opsBurden || UNKNOWN_LABEL },
        { label: 'Blast radius', value: candidate.blastRadius || UNKNOWN_LABEL },
        {
          label: 'Recipe',
          value: candidate.recipeId ?? 'No supported recipe',
        },
      ]}
    />
  );
}

/** Every gate with its status, reason and evidence reference. */
export function GateTable({ gates }: { gates: Gate[] }) {
  return (
    <Table
      variant="embedded"
      contentDensity="compact"
      ariaLabels={{ tableLabel: 'Feasibility gates' }}
      columnDefinitions={[
        {
          id: 'name',
          header: 'Gate',
          cell: (item: Gate) => item.name,
          sortingField: 'name',
        },
        {
          id: 'status',
          header: 'Status',
          cell: (item: Gate) => <GateStatusBadge status={item.status} />,
          sortingField: 'status',
        },
        {
          id: 'reason',
          header: 'Reason',
          cell: (item: Gate) => item.reason ?? '—',
        },
        {
          id: 'evidence',
          header: 'Evidence reference',
          cell: (item: Gate) => item.evidenceRef ?? 'None recorded',
        },
      ]}
      items={gates}
      sortingDisabled={false}
      empty={
        <Box textAlign="center" color="inherit" padding={{ vertical: 's' }}>
          <SpaceBetween size="xs">
            <b>No gates recorded</b>
            <Box variant="small">
              The solver returned no gate results for this candidate.
            </Box>
          </SpaceBetween>
        </Box>
      }
    />
  );
}

/** Itemised cost with SKU, rate, unit and evidence label per line. */
export function CostBreakdown({ candidate }: { candidate: Candidate }) {
  const cost = candidate.cost;

  if (!cost) {
    return (
      <Alert
        type="warning"
        statusIconAriaLabel="Warning"
        header={`Cost is ${UNKNOWN_LABEL}`}
      >
        <BrandName /> could not build a cost model for this candidate. The total is{' '}
        {UNKNOWN_LABEL} — it is not zero.
      </Alert>
    );
  }

  return (
    <SpaceBetween size="m">
      {!cost.isComplete ? (
        <Alert
          type="warning"
          statusIconAriaLabel="Warning"
          header="Cost is incomplete"
        >
          <SpaceBetween size="xs">
            <Box variant="span">
              At least one component could not be priced. The total remains unavailable;
              any priced line items form only a partial subtotal.
            </Box>
            {cost.unpriced.length > 0 ? (
              <Box variant="small">
                Unpriced: {cost.unpriced.join(', ')}
              </Box>
            ) : null}
          </SpaceBetween>
        </Alert>
      ) : null}

      <KeyValuePairs
        columns={3}
        items={[
          {
            label: 'Total over horizon',
            value: <Money amount={cost.total} />,
          },
          {
            label: 'Exact total',
            value: cost.totalExact ?? UNKNOWN_LABEL,
          },
          {
            label: 'Completeness',
            value: cost.isComplete ? 'Complete' : 'Incomplete',
          },
        ]}
      />

      <Table
        variant="embedded"
        contentDensity="compact"
        ariaLabels={{ tableLabel: 'Cost line items' }}
        columnDefinitions={[
          {
            id: 'label',
            header: 'Line item',
            cell: (item: CostItem) => (
              <SpaceBetween size="xxxs">
                <Box variant="span" fontWeight="bold">
                  {item.label}
                </Box>
                {item.note ? (
                  <Box variant="small" color="text-body-secondary">
                    {item.note}
                  </Box>
                ) : null}
              </SpaceBetween>
            ),
            sortingField: 'label',
          },
          {
            id: 'phase',
            header: 'Phase',
            cell: (item: CostItem) => item.phase || UNKNOWN_LABEL,
            sortingField: 'phase',
          },
          {
            id: 'quantity',
            header: 'Quantity',
            cell: (item: CostItem) =>
              formatQuantity(item.quantity, item.quantityUnit),
          },
          {
            id: 'rate',
            header: 'Rate and SKU',
            cell: (item: CostItem) => <RateSummary rate={item.rate} />,
          },
          {
            id: 'amount',
            header: 'Amount',
            cell: (item: CostItem) => (
              <Money amount={item.amount} currency={item.rate?.currency ?? 'USD'} />
            ),
          },
          {
            id: 'evidence',
            header: 'Evidence',
            cell: (item: CostItem) => <EvidenceBadge evidence={item.evidence} />,
            sortingField: 'evidence',
          },
        ]}
        items={cost.items}
        empty={
          <Box textAlign="center" color="inherit" padding={{ vertical: 's' }}>
            <SpaceBetween size="xs">
              <b>No cost line items</b>
              <Box variant="small">
                The solver produced a cost object with no itemisation.
              </Box>
            </SpaceBetween>
          </Box>
        }
      />
    </SpaceBetween>
  );
}

/** Full candidate detail: configuration, gates, itemised cost. */
export function CandidateDetail({ candidate }: { candidate: Candidate }) {
  return (
    <SpaceBetween size="l">
      <CandidateConfiguration candidate={candidate} />
      {candidate.notes ? (
        <Box variant="p" color="text-body-secondary">
          {candidate.notes}
        </Box>
      ) : null}
      <div>
        <Box variant="h4">Feasibility gates</Box>
        <GateTable gates={candidate.gates} />
      </div>
      <div>
        <Box variant="h4">Itemised cost</Box>
        <CostBreakdown candidate={candidate} />
      </div>
    </SpaceBetween>
  );
}
