import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { Candidate } from '../api/types';
import { CandidateDetail } from './CandidateDetail';
import { Money } from './Money';
import { UNKNOWN_LABEL, targetLabel } from './format';

/** The recommended placement, given the most visual weight on the page. */
export function WinnerCard({
  winner,
  horizonHours,
}: {
  winner: Candidate;
  horizonHours: string;
}) {
  const incomplete = winner.cost ? !winner.cost.isComplete : true;

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={`Lowest comparable total cost among candidates that passed every gate, over ${horizonHours} hours.`}
          actions={<Badge color="green">Recommended</Badge>}
        >
          Recommended placement
        </Header>
      }
    >
      <SpaceBetween size="l">
        <SpaceBetween size="xxs">
          <Box variant="h1" data-testid="winner-cost">
            <Money amount={winner.cost?.total ?? null} emphasis />
          </Box>
          <Box variant="span" color="text-body-secondary">
            total over {horizonHours} hours
            {incomplete
              ? ` — incomplete, at least one component is ${UNKNOWN_LABEL}`
              : ''}
          </Box>
        </SpaceBetween>

        <KeyValuePairs
          columns={3}
          items={[
            {
              label: 'Target',
              value: (
                <Box variant="span" fontWeight="bold">
                  {targetLabel(winner.target)}
                </Box>
              ),
            },
            { label: 'Candidate', value: winner.candidateId },
            { label: 'Region', value: winner.region || UNKNOWN_LABEL },
            {
              label: 'Allocation',
              value: winner.scaleToZero
                ? 'Scales to zero between requests'
                : 'Continuously allocated',
            },
            { label: 'Ops burden', value: winner.opsBurden || UNKNOWN_LABEL },
            {
              label: 'Gates',
              value: (
                <StatusIndicator type="success">
                  All {winner.gates.length} gates pass
                </StatusIndicator>
              ),
            },
          ]}
        />

        <ExpandableSection
          headerText="Gates and itemised cost for the recommended placement"
          variant="footer"
        >
          <CandidateDetail candidate={winner} />
        </ExpandableSection>
      </SpaceBetween>
    </Container>
  );
}
