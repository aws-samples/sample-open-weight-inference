import { useId, useMemo, useState } from 'react';
import Checkbox from '@cloudscape-design/components/checkbox';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { layoutBenchmarkChart, type ChartPoint } from './benchmarkChartLayout';
import type { ChartInsight } from './benchmarkChartInsights';
import '../styles/benchmarks.css';

export interface ChartSeries { id: string; label: string; color: 'orange' | 'blue' | 'purple' | 'gray'; diamond?: boolean }

function dollars(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2,
    maximumFractionDigits: value !== 0 && value < .01 ? 5 : value < .1 ? 3 : 2,
  }).format(value);
}

export function BenchmarkScatterPlot({ points, series, selected, choose, title, subtitle, xLabel, yLabel,
  ariaLabel, sourceNote, frontierLine = false, intervalOption = false, target, insights = [] }: {
  points: ChartPoint[]; series: ChartSeries[]; selected: string; choose: (id: string) => void;
  title: string; subtitle: string; xLabel: string; yLabel: string; ariaLabel: string; sourceNote: string;
  frontierLine?: boolean; intervalOption?: boolean; target?: number; insights?: ChartInsight[];
}) {
  const id = useId();
  const [intervals, setIntervals] = useState(false);
  const [zeroBaseline, setZeroBaseline] = useState(false);
  const valid = useMemo(() => points.filter((point) =>
    Number.isFinite(point.cost) && point.cost >= 0 && Number.isFinite(point.quality)
    && point.quality >= 0 && point.quality <= 100), [points]);
  const layout = useMemo(() => layoutBenchmarkChart(valid, zeroBaseline, intervals), [valid, zeroBaseline, intervals]);
  if (!valid.length) return null;
  const frontier = layout.points.filter((point) => point.frontier)
    .sort((a, b) => a.cost - b.cost || a.quality - b.quality);
  return <figure className="eddie-evidence-figure" data-testid="benchmark-graph">
    <div className="eddie-evidence-heading">
      <div><div className="eddie-evidence-eyebrow">BENCHMARK COMPARISON</div>
        <h3>{title}</h3><p>{subtitle}</p></div>
      <div className="eddie-evidence-controls">
        <SpaceBetween size="xs">
          <Checkbox checked={zeroBaseline} onChange={({ detail }) => setZeroBaseline(detail.checked)}>
            Start score axis at 0%
          </Checkbox>
          {intervalOption ? <Checkbox checked={intervals} onChange={({ detail }) => setIntervals(detail.checked)}>
            Show 95% intervals
          </Checkbox> : null}
        </SpaceBetween>
      </div>
    </div>
    <p className="eddie-evidence-pan-hint">↔ Swipe or scroll sideways to explore every model.</p>
    <div className="eddie-evidence-scroll" tabIndex={0} role="region" aria-label={`${ariaLabel}. Scroll horizontally on small screens.`}>
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={ariaLabel}
        aria-describedby={`${id}-description`}>
        <title>{title}</title>
        <desc id={`${id}-description`}>Each labeled point shows the configuration, score and cost.
          Select a point or its label to inspect the source evidence. The score axis spans {layout.floor}% to {layout.ceiling}%.
          Labels may move to remain readable; leader lines connect them to their exact plotted values.</desc>
        <text x={layout.plot.left} y="30" className="eddie-evidence-axis-title">{yLabel}</text>
        <text x={layout.plot.left} y="66" className="eddie-evidence-direction">↖ Higher score, lower cost</text>
        <text x={layout.plot.right} y="66" textAnchor="end" className="eddie-evidence-hint">Select any model to inspect its evidence</text>
        {layout.yTicks.map((tick) => <g key={tick}>
          <line x1={layout.plot.left} x2={layout.plot.right} y1={layout.y(tick)} y2={layout.y(tick)} className="eddie-evidence-grid" />
          <text x={layout.plot.left - 16} y={layout.y(tick) + 5} textAnchor="end" className="eddie-evidence-tick">{tick}%</text>
        </g>)}
        {layout.xTicks.map((tick) => <g key={tick}>
          <line x1={layout.x(tick)} x2={layout.x(tick)} y1={layout.plot.top} y2={layout.plot.bottom} className="eddie-evidence-grid eddie-evidence-grid-vertical" />
          <text x={layout.x(tick)} y={layout.plot.bottom + 30} textAnchor="middle" className="eddie-evidence-tick">{dollars(tick)}</text>
        </g>)}
        <line x1={layout.plot.left} x2={layout.plot.right} y1={layout.plot.bottom} y2={layout.plot.bottom} className="eddie-evidence-axis" />
        <text x={(layout.plot.left + layout.plot.right) / 2} y={layout.height - 31} textAnchor="middle" className="eddie-evidence-axis-title">{xLabel}</text>
        {target !== undefined && target >= layout.floor && target <= layout.ceiling ? <g>
          <line x1={layout.plot.left} x2={layout.plot.right} y1={layout.y(target)} y2={layout.y(target)} className="eddie-evidence-target" />
          <text x={layout.plot.right} y={layout.y(target) - 9} textAnchor="end" className="eddie-evidence-target-label">Acceptance target: {target}%</text>
        </g> : null}
        {frontierLine && frontier.length > 1 ? <polyline
          points={frontier.map((point) => `${point.x},${point.y}`).join(' ')} className="eddie-evidence-frontier-line" /> : null}
        {intervals ? layout.points.map((point) => point.interval ? <g key={point.id} className="eddie-evidence-interval">
          <line x1={point.x} x2={point.x} y1={layout.y(point.interval[0])} y2={layout.y(point.interval[1])} />
          {[point.interval[0], point.interval[1]].map((limit, index) => <line key={index}
            x1={point.x - 5} x2={point.x + 5} y1={layout.y(limit)} y2={layout.y(limit)} />)}
        </g> : null) : null}
        {layout.points.map((point) => {
          const connectorX = Math.max(point.labelX, Math.min(point.labelX + point.labelWidth, point.x));
          const connectorY = Math.max(point.labelY, Math.min(point.labelY + point.labelHeight, point.y));
          return <line key={point.id} x1={point.x} y1={point.y} x2={connectorX} y2={connectorY} className="eddie-evidence-leader" />;
        })}
        {layout.points.map((point) => {
          const category = series.find((item) => item.id === point.series);
          return <g key={point.id} className={`eddie-evidence-point eddie-evidence-${category?.color ?? 'gray'}${selected === point.id ? ' is-selected' : ''}`}
            role="button" tabIndex={0} aria-pressed={selected === point.id}
            aria-label={`${point.label}: ${point.detail}${point.secondary ? `, ${point.secondary}` : ''}${point.frontier ? ', on the observed frontier' : ''}`}
            onClick={() => choose(point.id)} onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(point.id); }
            }}>
            <title>{point.label}: {point.detail}{point.secondary ? `; ${point.secondary}` : ''}</title>
            {point.frontier ? <circle cx={point.x} cy={point.y} r="12.5" className="eddie-evidence-frontier-ring" /> : null}
            {category?.diamond ? <path d={`M ${point.x} ${point.y - 8} l 8 8 -8 8 -8 -8 Z`} className="eddie-evidence-dot" /> :
              <circle cx={point.x} cy={point.y} r="7" className="eddie-evidence-dot" />}
            <rect x={point.labelX} y={point.labelY} width={point.labelWidth} height={point.labelHeight} rx="7" className="eddie-evidence-label-bg" />
            {point.lines.map((line, index) => <text key={index} x={point.labelX + 10} y={point.labelY + 22 + index * 20} className="eddie-evidence-label">{line}</text>)}
            <text x={point.labelX + 10} y={point.labelY + 23 + point.lines.length * 20} className="eddie-evidence-metric">{point.detail}</text>
            {point.secondary ? <text x={point.labelX + 10} y={point.labelY + 43 + point.lines.length * 20} className="eddie-evidence-metric">{point.secondary}</text> : null}
          </g>;
        })}
      </svg>
    </div>
    {insights.length ? <div className="eddie-evidence-insights" aria-label="Calculated trade-offs">
      {insights.map((insight) => <button key={insight.id} type="button"
        className={`eddie-evidence-insight${selected === insight.pointId ? ' is-selected' : ''}`}
        aria-label={`Inspect ${insight.model}: ${insight.label}`}
        onClick={() => choose(insight.pointId)}>
        <span className="eddie-evidence-insight-label">{insight.label}</span>
        <strong>{insight.value}</strong>
        <span className="eddie-evidence-insight-model">{insight.model}</span>
        <span className="eddie-evidence-insight-detail">{insight.detail}</span>
      </button>)}
    </div> : null}
    <figcaption>
      <div className="eddie-evidence-legend">
        {series.filter((item) => valid.some((point) => point.series === item.id)).map((item) => <span key={item.id}>
          <i className={`eddie-evidence-swatch eddie-evidence-${item.color}${item.diamond ? ' is-diamond' : ''}`} />{item.label}
        </span>)}
        <span><i className={frontierLine ? 'eddie-evidence-frontier-swatch' : 'eddie-evidence-frontier-ring-swatch'} />
          {frontierLine ? 'Observed cost / score frontier' : 'On the eligible trade-off frontier'}</span>
      </div>
      <p>{sourceNote}</p>
      <p className="eddie-evidence-footnote">Score axis: {layout.floor}% to {layout.ceiling}%.
        {frontierLine ? ' The frontier connects observed configurations; it does not predict results between them.' : ''}
        {intervals ? ' Intervals assume independently sampled tasks and do not measure production uncertainty.' : ''}</p>
    </figcaption>
  </figure>;
}
