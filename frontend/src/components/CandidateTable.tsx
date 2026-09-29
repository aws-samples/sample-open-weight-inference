import { BrandName, brandText } from './BrandName';
import { useMemo, useState } from 'react';
import Badge from '@cloudscape-design/components/badge';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import type { Candidate } from '../api/types';
import { summariseBlockingGates, type BlockingGate } from './blockingGates';
import { CandidateDetail } from './CandidateDetail';
import { GateSummary } from './EvidenceBadge';
import { Money } from './Money';
import { UNKNOWN_LABEL, targetShortLabel, toNumber } from './format';

type SortKey = 'candidateId' | 'target' | 'cost' | 'opsBurden';

interface SortState {
  key: SortKey;
  descending: boolean;
}

function costSortValue(candidate: Candidate): number {
  const value = toNumber(candidate.cost?.total ?? null);
  // Unpriced candidates sort last in ascending order rather than as zero.
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function sortCandidates(items: Candidate[], sort: SortState): Candidate[] {
  const sorted = [...items].sort((a, b) => {
    switch (sort.key) {
      case 'cost':
        return costSortValue(a) - costSortValue(b);
      case 'target':
        return a.target.localeCompare(b.target);
      case 'opsBurden':
        return (a.opsBurden ?? '').localeCompare(b.opsBurden ?? '');
      case 'candidateId':
      default:
        return a.candidateId.localeCompare(b.candidateId);
    }
  });
  return sort.descending ? sorted.reverse() : sorted;
}

export interface RankedCandidatesTableProps {
  candidates: Candidate[];
  winnerId: string | null;
  /** Solver rank order, so "reset to solver order" stays available. */
  onSelect?: (candidate: Candidate | null) => void;
  selectedId?: string | null;
  /** Passed so the empty state can name the gates that blocked every option. */
  unresolved?: Candidate[];
  excluded?: Candidate[];
}

/**
 * The empty state for the ranked table.
 *
 * "No qualified candidates" on its own is a dead end: the user cannot tell
 * which gate blocked what, nor which control would resolve it — least of all
 * when that control sits inside a collapsed section. So this names each
 * blocking gate, the candidates it affected, the solver's own reason, and the
 * specific control to change.
 */
export function NoQualifiedCandidates({
  unresolved,
  excluded,
}: {
  unresolved: Candidate[];
  excluded: Candidate[];
}) {
  const blocking = summariseBlockingGates(unresolved, excluded);
  const totalBlocked = unresolved.length + excluded.length;

  if (totalBlocked === 0) {
    return (
      <Box textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
        <SpaceBetween size="xs">
          <b>No candidates were enumerated</b>
          <Box variant="p" color="text-body-secondary">
            The solver produced no candidate configurations at all for this
            request. Check the model specification and the permitted regions.
          </Box>
        </SpaceBetween>
      </Box>
    );
  }

  return (
    <Box color="inherit" padding={{ vertical: 'm', horizontal: 's' }}>
      <SpaceBetween size="m">
        <div>
          <Box variant="h4">No qualified candidates</Box>
          <Box variant="p" color="text-body-secondary">
            {unresolved.length > 0 && excluded.length > 0
              ? `${unresolved.length} candidate${
                  unresolved.length === 1 ? '' : 's'
                } could not be resolved and ${excluded.length} ${
                  excluded.length === 1 ? 'was' : 'were'
                } excluded, so nothing can be ranked.`
              : unresolved.length > 0
                ? `${unresolved.length} candidate${
                    unresolved.length === 1 ? '' : 's'
                  } could not be resolved, so nothing can be ranked. An unresolved gate is never treated as a pass.`
                : `${excluded.length} candidate${
                    excluded.length === 1 ? ' was' : 's were'
                  } excluded on a hard gate, so nothing can be ranked.`}
          </Box>
        </div>

        <SpaceBetween size="s">
          {blocking.map((gate) => (
            <BlockingGateRow key={`${gate.status}:${gate.gateName}`} gate={gate} />
          ))}
        </SpaceBetween>
      </SpaceBetween>
    </Box>
  );
}

function BlockingGateRow({ gate }: { gate: BlockingGate }) {
  return (
    <Alert
      type={gate.status === 'UNKNOWN' ? 'info' : 'warning'}
      statusIconAriaLabel={gate.status === 'UNKNOWN' ? 'Information' : 'Warning'}
      header={`${gate.gateName} — ${gate.status}`}
    >
      <SpaceBetween size="xxs">
        {gate.reasons.length > 0 ? (
          <Box variant="span">{gate.reasons.join(' ')}</Box>
        ) : (
          <Box variant="span" color="text-body-secondary">
            The solver recorded no reason for this gate.
          </Box>
        )}
        <Box variant="small" color="text-body-secondary">
          {`Affects ${gate.affectedCandidates.join(', ')}.`}
        </Box>
        {gate.remedy ? (
          <Box variant="small" data-testid="gate-remedy">
            <b>To resolve:</b> {gate.remedy}
            {gate.section ? (
              <>
                {' '}
                <i>
                  (in the “{gate.section}” section of the requirements form on
                  the left)
                </i>
              </>
            ) : null}
          </Box>
        ) : (
          <Box variant="small" color="text-body-secondary">
            No form control resolves this gate — it depends on evidence <BrandName />{' '}
            does not yet have.
          </Box>
        )}
      </SpaceBetween>
    </Alert>
  );
}

/**
 * Ranked (qualified) candidates only. Excluded and unresolved candidates are
 * rendered by separate components and are never merged into this list.
 */
export function RankedCandidatesTable({
  candidates,
  winnerId,
  onSelect,
  selectedId,
  unresolved = [],
  excluded = [],
}: RankedCandidatesTableProps) {
  const [sort, setSort] = useState<SortState | null>(null);

  const items = useMemo(
    () => (sort ? sortCandidates(candidates, sort) : candidates),
    [candidates, sort]
  );

  const columnDefinitions: TableProps<Candidate>['columnDefinitions'] = [
    {
      id: 'candidateId',
      header: 'Candidate',
      sortingField: 'candidateId',
      cell: (item) => (
        <SpaceBetween direction="horizontal" size="xs">
          <Box variant="span" fontWeight="bold">
            {item.candidateId}
          </Box>
          {item.candidateId === winnerId ? (
            <Badge color="green">Winner</Badge>
          ) : null}
        </SpaceBetween>
      ),
    },
    {
      id: 'target',
      header: 'Target',
      sortingField: 'target',
      cell: (item) => targetShortLabel(item.target),
    },
    {
      id: 'shape',
      header: 'Allocation',
      cell: (item) => (
        <SpaceBetween size="xxxs">
          <Box variant="span">
            {item.scaleToZero ? 'Scales to zero' : 'Continuously allocated'}
          </Box>
          <Box variant="small" color="text-body-secondary">
            {item.prewarmed ? 'Prewarmed' : 'Not prewarmed'}
            {item.instanceType ? ` · ${item.instanceType}` : ''}
            {` · ×${item.instanceCount}`}
          </Box>
        </SpaceBetween>
      ),
    },
    {
      id: 'cost',
      header: 'Total cost over horizon',
      sortingField: 'cost',
      cell: (item) => (
        <SpaceBetween size="xxxs">
          <Money amount={item.cost?.total ?? null} />
          {item.cost && !item.cost.isComplete ? (
            <StatusIndicator type="warning">Incomplete</StatusIndicator>
          ) : null}
        </SpaceBetween>
      ),
    },
    {
      id: 'opsBurden',
      header: 'Ops burden',
      sortingField: 'opsBurden',
      cell: (item) => item.opsBurden || UNKNOWN_LABEL,
    },
    {
      id: 'gates',
      header: 'Gates',
      cell: (item) => (
        <GateSummary
          failureCount={item.failureCount}
          unknownCount={item.unknownCount}
        />
      ),
    },
    {
      id: 'actions',
      header: 'Detail',
      cell: (item) => (
        <Button
          variant="inline-link"
          ariaLabel={`Show detail for candidate ${item.candidateId}`}
          onClick={() =>
            onSelect?.(item.candidateId === selectedId ? null : item)
          }
        >
          {item.candidateId === selectedId ? 'Hide detail' : 'Show detail'}
        </Button>
      ),
    },
  ];

  return (
    <Table<Candidate>
      variant="embedded"
      items={items}
      trackBy="candidateId"
      columnDefinitions={columnDefinitions}
      sortingColumn={
        sort ? { sortingField: sort.key } : undefined
      }
      sortingDescending={sort?.descending ?? false}
      onSortingChange={(event) => {
        const field = event.detail.sortingColumn.sortingField as
          | SortKey
          | undefined;
        if (!field) return;
        setSort({ key: field, descending: event.detail.isDescending ?? false });
      }}
      ariaLabels={{
        tableLabel: 'Ranked qualified candidates',
      }}
      header={
        <Header
          variant="h3"
          counter={`(${candidates.length})`}
          description="Every candidate here passed all gates. Ordered by the solver: lowest comparable total cost over the same horizon, then the declared tie-break."
          actions={
            sort ? (
              <Button onClick={() => setSort(null)}>
                Reset to solver order
              </Button>
            ) : undefined
          }
        >
          Ranked candidates
        </Header>
      }
      empty={
        <NoQualifiedCandidates unresolved={unresolved} excluded={excluded} />
      }
    />
  );
}

export interface CandidateIssueListProps {
  candidates: Candidate[];
  /** `excluded` = at least one FAIL. `unresolved` = at least one UNKNOWN. */
  kind: 'excluded' | 'unresolved';
}

const ISSUE_COPY = {
  excluded: {
    title: 'Excluded candidates',
    description:
      'These candidates failed at least one hard gate. A failed gate cannot be traded away for a lower cost, so they are not ranked.',
    emptyTitle: 'No candidates were excluded',
    emptyBody: 'No candidate failed a hard gate in this evaluation.',
    gateStatus: 'FAIL' as const,
    heading: 'Failed gates',
  },
  unresolved: {
    title: 'Unresolved candidates',
    description:
      'These candidates have at least one gate EDDIE could not resolve. Missing evidence is not treated as a pass, so they are held out of the ranking until the evidence exists.',
    emptyTitle: 'No candidates are unresolved',
    emptyBody: 'Every candidate had enough evidence to resolve its gates.',
    gateStatus: 'UNKNOWN' as const,
    heading: 'Unresolved gates',
  },
};

/**
 * Excluded / unresolved candidates, rendered in their own clearly-labelled
 * section with the failing or unknown gate reasons made explicit.
 */
export function CandidateIssueList({ candidates, kind }: CandidateIssueListProps) {
  const copy = ISSUE_COPY[kind];

  return (
    <Container
      header={
        <Header
          variant="h3"
          counter={`(${candidates.length})`}
          description={brandText(copy.description)}
        >
          {copy.title}
        </Header>
      }
    >
      {candidates.length === 0 ? (
        <Box textAlign="center" color="text-body-secondary" padding={{ vertical: 'm' }}>
          <SpaceBetween size="xxs">
            <b>{copy.emptyTitle}</b>
            <Box variant="small">{copy.emptyBody}</Box>
          </SpaceBetween>
        </Box>
      ) : (
        <SpaceBetween size="xs">
          {candidates.map((candidate) => {
            const relevantGates = candidate.gates.filter(
              (gate) => gate.status === copy.gateStatus
            );
            return (
              <ExpandableSection
                key={candidate.candidateId}
                variant="container"
                headerText={candidate.candidateId}
                headerDescription={`${targetShortLabel(candidate.target)} · ${
                  relevantGates.length
                } ${
                  kind === 'excluded' ? 'failing' : 'unresolved'
                } gate${relevantGates.length === 1 ? '' : 's'}`}
                headerActions={
                  <GateSummary
                    failureCount={candidate.failureCount}
                    unknownCount={candidate.unknownCount}
                  />
                }
              >
                <SpaceBetween size="m">
                  <div>
                    <Box variant="h5">{copy.heading}</Box>
                    {relevantGates.length === 0 ? (
                      <Box variant="p" color="text-body-secondary">
                        The solver reported no gate at status {copy.gateStatus}{' '}
                        even though this candidate is listed as {kind}. Review
                        the full gate list below.
                      </Box>
                    ) : (
                      <ul>
                        {relevantGates.map((gate) => (
                          <li key={gate.name}>
                            <Box variant="span" fontWeight="bold">
                              {gate.name}
                            </Box>
                            {': '}
                            {gate.reason ?? 'No reason recorded.'}
                            {gate.evidenceRef ? (
                              <Box
                                variant="small"
                                color="text-body-secondary"
                                display="block"
                              >
                                Evidence: {gate.evidenceRef}
                              </Box>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <CandidateDetail candidate={candidate} />
                </SpaceBetween>
              </ExpandableSection>
            );
          })}
        </SpaceBetween>
      )}
    </Container>
  );
}
