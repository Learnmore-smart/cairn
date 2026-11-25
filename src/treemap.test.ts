import { describe, expect, it } from "vitest";
import { layoutTreemap } from "./treemap";

const W = 1000;
const H = 500;

function items(sizes: number[]) {
  return sizes.map((size, i) => ({ id: `i${i}`, size }));
}

describe("layoutTreemap", () => {
  it("returns nothing for empty or zero-size input", () => {
    expect(layoutTreemap([], W, H)).toEqual([]);
    expect(layoutTreemap(items([0, 0]), W, H)).toEqual([]);
  });

  it("covers the frame with proportional areas", () => {
    const sizes = [500, 300, 150, 40, 10];
    const rects = layoutTreemap(items(sizes), W, H);
    expect(rects).toHaveLength(sizes.length);

    const total = sizes.reduce((a, b) => a + b, 0);
    for (const [i, r] of rects.entries()) {
      // rect size is scaled to pixel area — its share matches its size share
      const expected = (sizes[i]! / total) * (W * H);
      expect(r.size).toBeCloseTo(expected, 6);
      expect(r.w * r.h).toBeCloseTo(expected, 0);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-6);
      void i;
    }
    // full coverage — sum of rect areas equals frame area
    const covered = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(covered).toBeCloseTo(W * H, 4);
  });

  it("never overlaps rects", () => {
    const rects = layoutTreemap(items([9, 8, 7, 6, 5, 4, 3, 2, 1]), W, H);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap =
          a.x < b.x + b.w - 1e-9 &&
          b.x < a.x + a.w - 1e-9 &&
          a.y < b.y + b.h - 1e-9 &&
          b.y < a.y + a.h - 1e-9;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it("keeps input order and tolerates degenerate frames", () => {
    const rects = layoutTreemap(items([3, 2, 1]), 400, 300);
    expect(rects.map((r) => r.id)).toEqual(["i0", "i1", "i2"]);
    expect(layoutTreemap(items([1]), 0, 100)).toEqual([]);
    expect(layoutTreemap(items([1]), 100, 0)).toEqual([]);
  });
});
