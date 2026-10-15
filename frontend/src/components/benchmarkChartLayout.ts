export interface ChartPoint {
  id: string;
  label: string;
  cost: number;
  quality: number;
  detail: string;
  secondary?: string;
  series: string;
  frontier: boolean;
  interval?: [number, number] | null;
}

export interface PlottedPoint extends ChartPoint {
  x: number; y: number;
  labelX: number; labelY: number; labelWidth: number; labelHeight: number;
  lines: string[];
}

interface Rect { x: number; y: number; width: number; height: number }

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

function crossesBox(x1: number, y1: number, x2: number, y2: number, box: Rect) {
  let start = 0, end = 1;
  for (const [origin, delta, low, high] of [
    [x1, x2 - x1, box.x, box.x + box.width],
    [y1, y2 - y1, box.y, box.y + box.height],
  ]) {
    if (Math.abs(delta) < .0001) { if (origin < low || origin > high) return false; }
    else {
      const a = (low - origin) / delta, b = (high - origin) / delta;
      start = Math.max(start, Math.min(a, b)); end = Math.min(end, Math.max(a, b));
      if (start > end) return false;
    }
  }
  return true;
}

function wrapLabel(label: string) {
  const lines: string[] = [];
  let remaining = label.trim();
  while (remaining.length > 30 && lines.length < 2) {
    const space = remaining.lastIndexOf(' ', 30);
    const split = space > 10 ? space : 30;
    lines.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) lines.push(remaining.length > 33 ? `${remaining.slice(0, 30)}...` : remaining);
  return lines.length ? lines : ['Unnamed configuration'];
}

function moneyStep(value: number) {
  const base = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].find((factor) => factor * base >= value)! * base;
}

/**
 * Positions are calculated from the observations, never a list of model names.
 * Labels can move to avoid one another; data points always retain their exact
 * scaled coordinates. A leader line makes every displaced label unambiguous.
 */
export function layoutBenchmarkChart(points: ChartPoint[], zeroBaseline = false, showIntervals = false) {
  const width = 1200;
  const height = points.length > 18 ? 850 : 740;
  const plot = { left: 86, right: 1136, top: 100, bottom: height - 106 };
  const maxValue = Math.max(...points.map((point) => point.cost), 0.000001);
  const step = moneyStep(maxValue / 6);
  const maxCost = Math.ceil(maxValue * 1.16 / step) * step;
  const lowest = points.length ? Math.min(...points.map((point) => showIntervals ? point.interval?.[0] ?? point.quality : point.quality)) : 0;
  const highest = points.length ? Math.max(...points.map((point) => showIntervals ? point.interval?.[1] ?? point.quality : point.quality)) : 100;
  const floor = zeroBaseline ? 0 : Math.max(0, Math.floor((lowest - 5) / 5) * 5);
  const ceiling = Math.min(100, Math.max(floor + 10, Math.ceil((highest + 5) / 5) * 5));
  const x = (cost: number) => plot.left + cost / maxCost * (plot.right - plot.left);
  const y = (quality: number) => plot.bottom - (quality - floor) / (ceiling - floor) * (plot.bottom - plot.top);
  const yStep = ceiling - floor > 55 ? 20 : ceiling - floor > 40 ? 10 : 5;
  const yTicks = Array.from({ length: Math.floor((ceiling - floor) / yStep) + 1 }, (_, i) => floor + i * yStep);
  if (yTicks.at(-1) !== ceiling) yTicks.push(ceiling);
  const xTicks = Array.from({ length: Math.round(maxCost / step) + 1 }, (_, i) => i * step);
  const placed: PlottedPoint[] = points.map((point) => {
    const lines = wrapLabel(point.label);
    // Conservative system-font width, including the secondary metric lines.
    const labelWidth = Math.min(292, Math.max(162, ...lines.map((line) => line.length * 8.2 + 20),
      point.detail.length * 7.3 + 20, (point.secondary?.length ?? 0) * 7.3 + 20));
    const labelHeight = lines.length * 20 + (point.secondary ? 42 : 23) + 12;
    return { ...point, x: x(point.cost), y: y(point.quality), lines,
      labelX: 0, labelY: 0, labelWidth, labelHeight };
  });
  const pointBoxes = placed.map((point) => ({ x: point.x - 12, y: point.y - 12, width: 24, height: 24 }));
  const labelBox = (point: PlottedPoint): Rect => ({
    x: point.labelX - 5, y: point.labelY - 5, width: point.labelWidth + 10, height: point.labelHeight + 10,
  });
  // Place crowded high-score records before isolated lower-score records. Repeat
  // with all labels present so an early choice cannot trap a later one.
  const order = [...placed].sort((a, b) => b.quality - a.quality || a.cost - b.cost || a.id.localeCompare(b.id));
  const active = new Set<string>();
  for (let pass = 0; pass < 4; pass++) {
    for (const point of order) {
      let best = { x: 0, y: 0, score: Infinity };
      for (const gap of [17, 38, 65, 100, 145, 195, 255]) {
        const w = point.labelWidth, h = point.labelHeight;
        const candidates = [
          [point.x + gap, point.y - h / 2],
          [point.x + gap, point.y - h - gap / 2],
          [point.x - w - gap, point.y - h / 2],
          [point.x - w / 2, point.y - h - gap],
          [point.x + gap, point.y + gap / 2],
          [point.x - w - gap, point.y - h - gap / 2],
          [point.x - w - gap, point.y + gap / 2],
          [point.x - w / 2, point.y + gap],
        ];
        for (const [cx, cy] of candidates) {
          // Reserve space for axes, legend and the chart's reading direction.
          const lx = Math.max(plot.left + 3, Math.min(plot.right - w - 3, cx));
          const ly = Math.max(plot.top + 8, Math.min(plot.bottom - h - 8, cy));
          const box = { x: lx - 5, y: ly - 5, width: w + 10, height: h + 10 };
          const endX = Math.max(lx, Math.min(lx + w, point.x));
          const endY = Math.max(ly, Math.min(ly + h, point.y));
          let score = Math.hypot(point.x - endX, point.y - endY) + Math.abs(point.y - (ly + h / 2)) * .15;
          for (const other of placed) {
            if (other.id !== point.id && active.has(other.id)) {
              const otherBox = labelBox(other);
              score += overlap(box, otherBox) * 1000;
              if (crossesBox(point.x, point.y, endX, endY, otherBox)) score += 500;
              const ox = Math.max(other.labelX, Math.min(other.labelX + other.labelWidth, other.x));
              const oy = Math.max(other.labelY, Math.min(other.labelY + other.labelHeight, other.y));
              if (crossesBox(other.x, other.y, ox, oy, box)) score += 500;
            }
          }
          for (const dot of pointBoxes) score += overlap(box, dot) * 2000;
          if (score < best.score) best = { x: lx, y: ly, score };
        }
      }
      point.labelX = best.x; point.labelY = best.y;
      active.add(point.id);
    }
  }
  return { width, height, plot, floor, ceiling, maxCost, xTicks, yTicks, x, y, points: placed };
}
