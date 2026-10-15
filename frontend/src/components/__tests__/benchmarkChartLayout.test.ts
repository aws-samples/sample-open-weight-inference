import { describe, expect, it } from 'vitest';
import { layoutBenchmarkChart, type ChartPoint } from '../benchmarkChartLayout';

function point(id: string, cost: number, quality: number): ChartPoint {
  return { id, label: `Synthetic configuration ${id}`, cost, quality,
    detail: `${quality}% resolved · $${cost}/task`, series: 'test', frontier: false };
}

describe('benchmark graph layout', () => {
  it('keeps every observation at its scaled value while separating clustered labels', () => {
    const inputs = [
      point('one', .08, 76), point('two', .36, 76), point('three', .56, 76), point('four', .77, 77),
      point('five', .54, 73), point('six', .48, 73), point('seven', .67, 72), point('eight', .15, 71),
      point('nine', .45, 70), point('ten', .34, 67), point('eleven', .05, 56),
    ];
    const chart = layoutBenchmarkChart(inputs);
    expect(chart.points).toHaveLength(inputs.length);
    for (const p of chart.points) {
      expect(p.x).toBe(chart.x(p.cost));
      expect(p.y).toBe(chart.y(p.quality));
      expect(p.labelX).toBeGreaterThanOrEqual(chart.plot.left);
      expect(p.labelX + p.labelWidth).toBeLessThanOrEqual(chart.plot.right);
      expect(p.labelY).toBeGreaterThanOrEqual(chart.plot.top);
      expect(p.labelY + p.labelHeight).toBeLessThanOrEqual(chart.plot.bottom);
      for (const q of chart.points.filter((other) => p.id !== other.id)) {
        const separated = p.labelX + p.labelWidth <= q.labelX || q.labelX + q.labelWidth <= p.labelX
          || p.labelY + p.labelHeight <= q.labelY || q.labelY + q.labelHeight <= p.labelY;
        expect(separated, `${p.id} overlaps ${q.id}`).toBe(true);
      }
    }
    // Never mutate reported scores/costs or depend on a hardcoded model order.
    expect(inputs.every((p) => !('x' in p))).toBe(true);
    const reverse = layoutBenchmarkChart([...inputs].reverse());
    for (const p of chart.points) {
      const q = reverse.points.find((other) => other.id === p.id)!;
      expect([q.labelX, q.labelY]).toEqual([p.labelX, p.labelY]);
    }
  });

  it('handles zero cost, tied observations, empty data and extreme score boundaries', () => {
    const tied = layoutBenchmarkChart([point('a', 0, 100), point('b', 0, 100)], true);
    expect(tied.floor).toBe(0);
    expect(tied.ceiling).toBe(100);
    expect(tied.points[0].x).toBe(tied.points[1].x);
    expect(tied.points[0].y).toBe(tied.points[1].y);
    expect(tied.points[0].labelY).not.toBe(tied.points[1].labelY);
    expect(layoutBenchmarkChart([]).points).toEqual([]);
    const low = layoutBenchmarkChart([point('low', .000003, 0)]);
    expect(low.floor).toBe(0);
    expect(low.xTicks.every(Number.isFinite)).toBe(true);
  });

  it('includes confidence bounds only when requested and preserves a truthful zero scale', () => {
    const input = { ...point('sample', 2, 60), interval: [30, 90] as [number, number] };
    const basic = layoutBenchmarkChart([input]);
    const intervals = layoutBenchmarkChart([input], false, true);
    expect(basic.floor).toBeGreaterThan(30);
    expect(intervals.floor).toBeLessThanOrEqual(30);
    expect(intervals.ceiling).toBeGreaterThanOrEqual(90);
    expect(layoutBenchmarkChart([input], true).floor).toBe(0);
  });
});
