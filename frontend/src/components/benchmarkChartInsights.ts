import type { ChartPoint } from './benchmarkChartLayout';

export interface ChartInsight {
  id: string;
  pointId: string;
  label: string;
  value: string;
  model: string;
  detail: string;
}

const money = (value: number) => `$${value.toFixed(value < .01 && value > 0 ? 5 : 3)}`;

/** Describes observed trade-offs, not model intelligence or statistical superiority. */
export function publishedTradeoffs(points: ChartPoint[]): ChartInsight[] {
  if (!points.length) return [];
  const byCost = [...points].sort((a, b) => a.cost - b.cost || b.quality - a.quality || a.id.localeCompare(b.id));
  const byScore = [...points].sort((a, b) => b.quality - a.quality || a.cost - b.cost || a.id.localeCompare(b.id));
  const cheapest = byCost[0], highest = byScore[0];
  const insights: ChartInsight[] = [{
    id: 'lowest-cost', pointId: cheapest.id, label: 'Lowest recorded cost',
    value: `${money(cheapest.cost)}/task`, model: cheapest.label,
    detail: `${cheapest.quality}% of benchmark issues resolved.`,
  }];
  // The one-percentage-point window is stated in the UI. It is a way to inspect
  // the trade-off, not a claim that scores are equivalent or statistically tied.
  const nearTop = byCost.find((point) => point.id !== highest.id && highest.quality - point.quality <= 1.00000001
    && point.cost < highest.cost);
  if (nearTop && highest.cost > 0) {
    const reduction = (1 - nearTop.cost / highest.cost) * 100;
    const difference = highest.quality - nearTop.quality;
    insights.push({
      id: 'near-top', pointId: nearTop.id, label: 'Within 1 point of the top',
      value: `${reduction.toFixed(1)}% lower cost`, model: nearTop.label,
      detail: `${money(nearTop.cost)} vs. ${money(highest.cost)}/task for ${highest.label}.
        Resolution is ${difference.toFixed(1)} percentage points lower (${nearTop.quality}% vs. ${highest.quality}%).`,
    });
  }
  if (highest.id !== cheapest.id) insights.push({
    id: 'highest-score', pointId: highest.id, label: 'Highest observed score',
    value: `${highest.quality}% resolved`, model: highest.label,
    detail: `${money(highest.cost)}/task. Compare paired outcomes before treating a score difference as an advantage.`,
  });
  return insights;
}
