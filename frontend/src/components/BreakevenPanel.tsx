import { BrandName } from './BrandName';
import Alert from '@cloudscape-design/components/alert';
import BarChart from '@cloudscape-design/components/bar-chart';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import type { Breakeven, BreakevenVerdict } from '../api/types';
import { UNKNOWN_LABEL, formatMoney, formatPercent, toNumber } from './format';

export const VERDICT_HEADLINE: Record<
  Exclude<BreakevenVerdict, null>,
  string
> = {
  BURST_FAVOURS_CMI:
    'Bursty traffic favours Bedrock Custom Model Import',
  STEADY_FAVOURS_DEDICATED:
    'Steady traffic favours a continuously allocated endpoint',
};

const VERDICT_EXPLANATION: Record<Exclude<BreakevenVerdict, null>, string> = {
  BURST_FAVOURS_CMI:
    'Actual duty cycle sits below the break-even point, so paying only for active minutes costs less than holding an instance for the whole horizon.',
  STEADY_FAVOURS_DEDICATED:
    'Actual duty cycle sits above the break-even point, so a continuously allocated instance costs less than paying burst rates for that much active time.',
};

const CHART_LABEL_BREAKEVEN = 'Break-even duty';
const CHART_LABEL_ACTUAL = 'Actual duty';

/**
 * The duty-cycle break-even view. This is the explanation of the decision:
 * traffic shape, not service preference, picks the winner.
 *
 * The chart is accompanied by an equivalent data table so the comparison is
 * never only available through a visual.
 */
export function BreakevenPanel({ breakeven }: { breakeven: Breakeven | null }) {
  if (!breakeven) {
    return (
      <Container
        header={
          <Header variant="h2" description="Traffic shape decides the winner.">
            Duty-cycle break-even
          </Header>
        }
      >
        <Alert
          type="info"
          statusIconAriaLabel="Information"
          header="No break-even comparison available"
        >
          <BrandName /> produces a break-even comparison only when it can price both a
          burst-billed Bedrock CMI candidate and a continuously allocated
          endpoint candidate over the same horizon. One or both were missing or
          unpriced for this evaluation.
        </Alert>
      </Container>
    );
  }

  const breakevenValue = toNumber(breakeven.breakevenDutyPercent);
  const actualValue = toNumber(breakeven.actualDutyPercent);
  const canChart = breakevenValue !== null && actualValue !== null;
  const verdict = breakeven.verdict;

  const maxValue = canChart
    ? Math.max(breakevenValue as number, actualValue as number)
    : 0;
  const yMax = Math.min(100, Math.max(10, Math.ceil((maxValue * 1.25) / 5) * 5));

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Below the break-even duty cycle, burst pricing wins. Above it, a continuously allocated endpoint wins."
        >
          Duty-cycle break-even
        </Header>
      }
    >
      <SpaceBetween size="l">
        {verdict ? (
          <Box>
            <SpaceBetween size="xs">
              <Box variant="h3" data-testid="breakeven-verdict-headline">
                {VERDICT_HEADLINE[verdict]}
              </Box>
              <StatusIndicator
                type={verdict === 'BURST_FAVOURS_CMI' ? 'info' : 'success'}
              >
                <span data-testid="breakeven-verdict-code">{verdict}</span>
              </StatusIndicator>
              <Box variant="p" color="text-body-secondary">
                {breakeven.explanation ?? VERDICT_EXPLANATION[verdict]}
              </Box>
            </SpaceBetween>
          </Box>
        ) : (
          <Alert
            type="info"
            statusIconAriaLabel="Information"
            header="No verdict"
          >
            <BrandName /> did not reach a break-even verdict for this evaluation.
            {breakeven.explanation ? ` ${breakeven.explanation}` : ''}
          </Alert>
        )}

        <KeyValuePairs
          columns={4}
          items={[
            {
              label: 'Break-even duty cycle',
              value: formatPercent(breakeven.breakevenDutyPercent),
            },
            {
              label: 'Actual duty cycle',
              value: formatPercent(breakeven.actualDutyPercent),
            },
            {
              label: 'CMI active hourly',
              value: formatMoney(breakeven.cmiActiveHourly),
            },
            {
              label: 'Dedicated hourly',
              value: formatMoney(breakeven.dedicatedHourly),
            },
          ]}
        />

        {canChart ? (
          <BarChart
            horizontalBars
            hideFilter
            hideLegend
            height={140}
            yDomain={[0, yMax]}
            xTitle="Comparison"
            yTitle="Duty cycle (% of horizon)"
            ariaLabel={`Duty cycle comparison. Break-even at ${formatPercent(
              breakeven.breakevenDutyPercent
            )}. Actual at ${formatPercent(breakeven.actualDutyPercent)}.`}
            xScaleType="categorical"
            series={[
              {
                title: 'Duty cycle (% of horizon)',
                type: 'bar',
                data: [
                  { x: CHART_LABEL_BREAKEVEN, y: breakevenValue as number },
                  { x: CHART_LABEL_ACTUAL, y: actualValue as number },
                ],
                valueFormatter: (value: number) => `${value.toFixed(2)}%`,
              },
            ]}
            i18nStrings={{
              yTickFormatter: (value: number) => `${value}%`,
            }}
            empty={
              <Box textAlign="center" color="inherit">
                No duty-cycle data.
              </Box>
            }
            noMatch={
              <Box textAlign="center" color="inherit">
                No matching data.
              </Box>
            }
          />
        ) : (
          <Alert
            type="warning"
            statusIconAriaLabel="Warning"
            header="Duty cycle cannot be charted"
          >
            The break-even or actual duty cycle was {UNKNOWN_LABEL}, so the
            comparison is shown as values only. A missing value is not treated
            as zero.
          </Alert>
        )}

        <ExpandableSection headerText="Break-even data table" variant="footer">
          <Table
            variant="embedded"
            contentDensity="compact"
            ariaLabels={{
              tableLabel: 'Duty-cycle break-even values',
            }}
            columnDefinitions={[
              {
                id: 'measure',
                header: 'Measure',
                cell: (item: BreakevenRow) => item.measure,
              },
              {
                id: 'value',
                header: 'Value',
                cell: (item: BreakevenRow) => item.value,
              },
              {
                id: 'basis',
                header: 'Basis',
                cell: (item: BreakevenRow) => item.basis,
              },
            ]}
            items={breakevenRows(breakeven)}
            empty={
              <Box textAlign="center" color="inherit" padding={{ vertical: 's' }}>
                No break-even values.
              </Box>
            }
          />
        </ExpandableSection>
      </SpaceBetween>
    </Container>
  );
}

interface BreakevenRow {
  measure: string;
  value: string;
  basis: string;
}

function breakevenRows(breakeven: Breakeven): BreakevenRow[] {
  return [
    {
      measure: 'Break-even duty cycle',
      value: formatPercent(breakeven.breakevenDutyPercent),
      basis: 'Dedicated hourly ÷ CMI active hourly',
    },
    {
      measure: 'Actual duty cycle',
      value: formatPercent(breakeven.actualDutyPercent),
      basis: 'Billable copy hours ÷ horizon hours',
    },
    {
      measure: 'CMI active hourly',
      value: formatMoney(breakeven.cmiActiveHourly),
      basis: breakeven.cmiComparedCandidate ?? UNKNOWN_LABEL,
    },
    {
      measure: 'Dedicated hourly',
      value: formatMoney(breakeven.dedicatedHourly),
      basis: breakeven.dedicatedComparedCandidate ?? UNKNOWN_LABEL,
    },
  ];
}
