import Box from '@cloudscape-design/components/box';
import Popover from '@cloudscape-design/components/popover';
import SpaceBetween from '@cloudscape-design/components/space-between';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import type { Rate } from '../api/types';
import { UNKNOWN_LABEL, formatMoney } from './format';

export interface MoneyProps {
  amount: string | null | undefined;
  currency?: string;
  /** Render larger, for a headline figure. */
  emphasis?: boolean;
}

/**
 * A currency amount that renders the literal word UNKNOWN when the backend
 * could not price it. Never falls back to $0.00 or an empty cell.
 */
export function Money({ amount, currency = 'USD', emphasis = false }: MoneyProps) {
  const formatted = formatMoney(amount, currency);
  const isUnknown = formatted === UNKNOWN_LABEL;

  if (isUnknown) {
    return (
      <Box
        variant={emphasis ? 'h1' : 'span'}
        color="text-status-inactive"
        fontWeight={emphasis ? 'bold' : 'normal'}
      >
        <span data-testid="money-unknown">{UNKNOWN_LABEL}</span>
      </Box>
    );
  }

  return (
    <Box
      variant={emphasis ? 'h1' : 'span'}
      fontWeight={emphasis ? 'bold' : 'normal'}
    >
      <span data-testid="money-amount">{formatted}</span>
    </Box>
  );
}

/**
 * The price evidence behind a rate: SKU, unit, effective date, source. Shown
 * inline so a cost figure is never presented without its basis.
 */
export function RateEvidence({ rate }: { rate: Rate | null }) {
  if (!rate) {
    return (
      <Box variant="span" color="text-status-inactive">
        No rate — {UNKNOWN_LABEL}
      </Box>
    );
  }

  return (
    <Popover
      dismissButton={false}
      position="top"
      size="medium"
      triggerType="text"
      header="Price evidence"
      content={
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: 'Rate',
              value: `${rate.amount} ${rate.currency} per ${rate.unit}`,
            },
            { label: 'SKU', value: rate.sku ?? UNKNOWN_LABEL },
            { label: 'Region', value: rate.region || UNKNOWN_LABEL },
            {
              label: 'Effective date',
              value: rate.effectiveDate ?? UNKNOWN_LABEL,
            },
            { label: 'Source', value: rate.source ?? UNKNOWN_LABEL },
          ]}
        />
      }
    >
      <Box variant="span">
        {rate.amount} {rate.currency}/{rate.unit}
      </Box>
    </Popover>
  );
}

/** Compact inline rate summary used in cost line-item tables. */
export function RateSummary({ rate }: { rate: Rate | null }) {
  if (!rate) {
    return (
      <Box variant="span" color="text-status-inactive">
        {UNKNOWN_LABEL}
      </Box>
    );
  }
  return (
    <SpaceBetween size="xxxs">
      <RateEvidence rate={rate} />
      <Box variant="small" color="text-body-secondary">
        SKU {rate.sku ?? UNKNOWN_LABEL}
        {rate.effectiveDate ? ` · effective ${rate.effectiveDate}` : ''}
      </Box>
    </SpaceBetween>
  );
}
