// SVG path helpers for the live metric charts — pure math, unit-tested.

export interface Pt {
  x: number;
  y: number;
}

/**
 * Maps `values` (0–max) onto a `w`×`h` canvas with a small pad. X spreads
 * evenly across the width; higher values draw higher (y is inverted).
 */
export function sparkPoints(values: number[], w: number, h: number, max = 100, pad = 2): Pt[] {
  if (values.length === 0 || w <= pad * 2 || h <= pad * 2) return [];
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  const step = values.length > 1 ? iw / (values.length - 1) : 0;
  return values.map((v, i) => {
    const t = Math.max(0, Math.min(1, v / Math.max(1e-9, max)));
    return { x: pad + i * step, y: pad + (1 - t) * ih };
  });
}

/** Polyline path `M x,y L x,y …`. */
export function linePath(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/** `linePath` closed down to the baseline — for gradient-filled areas. */
export function areaPath(pts: Pt[], h: number): string {
  if (pts.length === 0) return "";
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return `${linePath(pts)} L${last.x.toFixed(1)},${h} L${first.x.toFixed(1)},${h} Z`;
}
