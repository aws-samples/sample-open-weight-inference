import type { Target } from '../api/types';

/** The single literal used everywhere a value is genuinely not known. */
export const UNKNOWN_LABEL = 'UNKNOWN';

/**
 * Format a decimal-string currency amount.
 *
 * A `null`/blank/non-numeric amount returns `UNKNOWN` — never `$0.00` and
 * never an empty string. This is a hard product requirement: an unpriced
 * line item must not read as free.
 */
export function formatMoney(
  amount: string | null | undefined,
  currency = 'USD'
): string {
  if (amount === null || amount === undefined) return UNKNOWN_LABEL;
  const trimmed = String(amount).trim();
  if (trimmed === '') return UNKNOWN_LABEL;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return UNKNOWN_LABEL;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 6 : 2,
    }).format(value);
  } catch {
    return `${currency} ${trimmed}`;
  }
}

/** Parse a decimal string to a number, or `null` when not a finite number. */
export function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Format a percentage held as a decimal string, e.g. `"17.02"` -> `17.02%`. */
export function formatPercent(
  value: string | null | undefined,
  fractionDigits = 2
): string {
  const parsed = toNumber(value);
  if (parsed === null) return UNKNOWN_LABEL;
  return `${parsed.toFixed(fractionDigits)}%`;
}

/** Format an arbitrary decimal-string quantity with its unit. */
export function formatQuantity(
  quantity: string | null | undefined,
  unit: string | null | undefined
): string {
  if (quantity === null || quantity === undefined || String(quantity).trim() === '') {
    return UNKNOWN_LABEL;
  }
  const unitLabel = unit && unit.trim() !== '' ? ` ${unit}` : '';
  return `${String(quantity).trim()}${unitLabel}`;
}

/** Render an ISO timestamp in a readable, unambiguous UTC form. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return UNKNOWN_LABEL;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`;
}

/** Short human label for a hosting target. */
export function targetLabel(target: Target | string): string {
  switch (target) {
    case 'BEDROCK_CMI':
      return 'Bedrock Custom Model Import';
    case 'SAGEMAKER_REALTIME':
      return 'SageMaker real-time endpoint';
    case 'EC2_CPU':
      return 'EC2 CPU worker';
    case 'AWS_BATCH_CPU':
      return 'AWS Batch on EC2 CPU';
    default:
      return target;
  }
}

/** Compact target label suitable for a table cell. */
export function targetShortLabel(target: Target | string): string {
  switch (target) {
    case 'BEDROCK_CMI':
      return 'Bedrock CMI';
    case 'SAGEMAKER_REALTIME':
      return 'SageMaker real-time';
    case 'EC2_CPU':
      return 'EC2 CPU';
    case 'AWS_BATCH_CPU':
      return 'Batch CPU';
    default:
      return target;
  }
}

/** Truncate a hash for display while keeping it copyable in full elsewhere. */
export function shortHash(value: string | null | undefined, length = 12): string {
  if (!value) return UNKNOWN_LABEL;
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
