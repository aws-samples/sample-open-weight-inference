import { describe, expect, it } from 'vitest';
import { publishedTradeoffs } from '../benchmarkChartInsights';
import type { ChartPoint } from '../benchmarkChartLayout';

const point = (id: string, cost: number, quality: number): ChartPoint => ({
  id, cost, quality, label: `Authored ${id}`, detail: '', series: 'test', frontier: true,
});

describe('calculated benchmark callouts', () => {
  it('compares equal units and states the actual score gap, without claiming equivalence', () => {
    const items = publishedTradeoffs([point('cheap', .02, 50), point('near', .1, 79), point('top', 1, 80)]);
    expect(items.map((item) => item.pointId)).toEqual(['cheap', 'near', 'top']);
    expect(items[1].value).toBe('90.0% lower cost');
    expect(items[1].label).toBe('Within 1 point of the top');
    expect(items[1].detail).toContain('1.0 percentage points lower');
    expect(items[2].detail).toContain('Compare paired outcomes');
  });

  it('does not force a near-top claim when no cheaper observation meets the stated window', () => {
    const items = publishedTradeoffs([point('cheap', .01, 20), point('top', 1, 80)]);
    expect(items.map((item) => item.id)).toEqual(['lowest-cost', 'highest-score']);
  });

  it('handles tied maxima and zero-cost results without a spurious savings ratio', () => {
    const items = publishedTradeoffs([point('a', 0, 80), point('b', 1, 80), point('c', 0, 60)]);
    expect(items).toHaveLength(1);
    expect(items[0].pointId).toBe('a');
    expect(items[0].value).toBe('$0.000/task');
    expect(publishedTradeoffs([])).toEqual([]);
  });
});
