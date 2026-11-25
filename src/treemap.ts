// Squarified treemap layout (Bruls–Huizing–van Wijk) — pure layout math, no
// DOM. `layout` returns rects in the same coordinates as the input frame so
// callers can project straight onto an SVG viewBox.

export interface TreemapItem {
  id: string;
  size: number;
}

export interface TreemapRect {
  id: string;
  size: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worst(row: number[], side: number): number {
  // Highest aspect ratio (worst) of `row` laid along a strip of length `side`.
  const sum = row.reduce((a, b) => a + b, 0);
  if (sum <= 0 || side <= 0) return Infinity;
  let max = 0;
  let min = Infinity;
  for (const v of row) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

function layoutRow(row: TreemapItem[], frame: Frame, out: TreemapRect[]): Frame {
  // Lay `row` as a strip spanning the frame's SHORT side; each item's extent
  // along that side is its area / strip thickness. Returns the leftover frame.
  const sum = row.reduce((a, b) => a + b.size, 0);
  const { x, y, w, h } = frame;
  if (w <= 0 || h <= 0 || sum <= 0) return { x, y, w: 0, h: 0 };

  if (w >= h) {
    const thickness = sum / h; // column on the left, full height
    let cy = y;
    for (const item of row) {
      const ih = item.size / thickness;
      out.push({ id: item.id, size: item.size, x, y: cy, w: thickness, h: ih });
      cy += ih;
    }
    return { x: x + thickness, y, w: w - thickness, h };
  }
  const thickness = sum / w; // row across the top, full width
  let cx = x;
  for (const item of row) {
    const iw = item.size / thickness;
    out.push({ id: item.id, size: item.size, x: cx, y, w: iw, h: thickness });
    cx += iw;
  }
  return { x, y: y + thickness, w, h: h - thickness };
}

/**
 * Lays `items` (sizes in any unit) inside `w`×`h`. Order is preserved; the
 * caller should sort descending beforehand for a tidy layout.
 */
export function layoutTreemap(items: TreemapItem[], w: number, h: number): TreemapRect[] {
  const out: TreemapRect[] = [];
  const positive = items.filter((i) => i.size > 0);
  if (positive.length === 0 || w <= 0 || h <= 0) return out;

  // Normalize to the frame's area so `worst` sees absolute aspect ratios.
  const total = positive.reduce((a, b) => a + b.size, 0);
  const scale = (w * h) / total;
  const scaled = positive.map((i) => ({ ...i, size: i.size * scale }));

  let frame: Frame = { x: 0, y: 0, w, h };
  let row: TreemapItem[] = [];
  let rowSizes: number[] = [];

  for (const item of scaled) {
    const side = Math.min(frame.w, frame.h);
    if (row.length > 0 && worst([...rowSizes, item.size], side) > worst(rowSizes, side)) {
      frame = layoutRow(
        row.map((r, i) => ({ ...r, size: rowSizes[i]! })),
        frame,
        out,
      );
      row = [];
      rowSizes = [];
    }
    row.push(item);
    rowSizes.push(item.size);
  }
  if (row.length > 0) {
    layoutRow(
      row.map((r, i) => ({ ...r, size: rowSizes[i]! })),
      frame,
      out,
    );
  }

  // Snap to the frame edges — float residue leaves hairline gaps otherwise.
  for (const r of out) {
    if (Math.abs(r.x + r.w - w) < 1e-6) r.w = w - r.x;
    if (Math.abs(r.y + r.h - h) < 1e-6) r.h = h - r.y;
  }
  return out;
}
