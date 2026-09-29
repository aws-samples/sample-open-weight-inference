import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_LABEL,
  formatMoney,
  formatPercent,
  formatQuantity,
  targetShortLabel,
  toNumber,
} from '../format';

describe('formatMoney', () => {
  it('renders UNKNOWN, not $0, for a null amount', () => {
    expect(formatMoney(null)).toBe(UNKNOWN_LABEL);
    expect(formatMoney(null)).not.toContain('0');
  });

  it('renders UNKNOWN for undefined, blank and non-numeric amounts', () => {
    expect(formatMoney(undefined)).toBe(UNKNOWN_LABEL);
    expect(formatMoney('')).toBe(UNKNOWN_LABEL);
    expect(formatMoney('   ')).toBe(UNKNOWN_LABEL);
    expect(formatMoney('not-a-number')).toBe(UNKNOWN_LABEL);
  });

  it('renders a real zero as $0.00 — a priced zero is not UNKNOWN', () => {
    expect(formatMoney('0')).toBe('$0.00');
  });

  it('formats a decimal string without losing the value', () => {
    expect(formatMoney('41.16')).toBe('$41.16');
    expect(formatMoney('878.40')).toBe('$878.40');
  });
});

describe('formatPercent', () => {
  it('renders UNKNOWN for a missing percentage', () => {
    expect(formatPercent(null)).toBe(UNKNOWN_LABEL);
    expect(formatPercent('')).toBe(UNKNOWN_LABEL);
  });

  it('formats a decimal-string percentage', () => {
    expect(formatPercent('17.02')).toBe('17.02%');
    expect(formatPercent('8.33')).toBe('8.33%');
  });
});

describe('formatQuantity', () => {
  it('renders UNKNOWN for a missing quantity rather than 0', () => {
    expect(formatQuantity(null, 'CMU-minute')).toBe(UNKNOWN_LABEL);
  });

  it('appends the unit when present', () => {
    expect(formatQuantity('720', 'CMU-minute')).toBe('720 CMU-minute');
    expect(formatQuantity('720', null)).toBe('720');
  });
});

describe('toNumber', () => {
  it('returns null rather than 0 for unusable input', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
  });

  it('parses valid decimal strings', () => {
    expect(toNumber('8.33')).toBe(8.33);
  });
});

describe('targetShortLabel', () => {
  it('maps known targets and passes unknown ones through verbatim', () => {
    expect(targetShortLabel('BEDROCK_CMI')).toBe('Bedrock CMI');
    expect(targetShortLabel('SAGEMAKER_REALTIME')).toBe('SageMaker real-time');
    expect(targetShortLabel('SOME_FUTURE_TARGET')).toBe('SOME_FUTURE_TARGET');
  });
});
