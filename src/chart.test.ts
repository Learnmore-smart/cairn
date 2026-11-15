import { describe, expect, it } from "vitest";
import { areaPath, linePath, sparkPoints } from "./chart";

describe("sparkPoints", () => {
  it("maps values to canvas coords with y inverted", () => {
    const pts = sparkPoints([0, 50, 100], 100, 40);
    expect(pts).toHaveLength(3);
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y); // 50 sits above 0
    expect(pts[2]!.y).toBeLessThan(pts[1]!.y); // 100 above 50
    expect(pts[2]!.y).toBeCloseTo(2, 1); // pad
    expect(pts[0]!.y).toBeCloseTo(38, 1); // h - pad
  });

  it("spreads x evenly and clamps out-of-range values", () => {
    const pts = sparkPoints([-10, 200], 102, 40);
    expect(pts[0]!.x).toBeCloseTo(2);
    expect(pts[1]!.x).toBeCloseTo(100);
    expect(pts[0]!.y).toBeCloseTo(38, 1);
    expect(pts[1]!.y).toBeCloseTo(2, 1);
  });

  it("handles degenerate input", () => {
    expect(sparkPoints([], 100, 40)).toEqual([]);
    expect(sparkPoints([50], 100, 40)).toHaveLength(1);
    expect(sparkPoints([50], 0, 40)).toEqual([]);
  });
});

describe("paths", () => {
  it("builds a polyline", () => {
    expect(
      linePath([
        { x: 0, y: 1 },
        { x: 2, y: 3 },
      ]),
    ).toBe("M0.0,1.0 L2.0,3.0");
  });

  it("closes the area path at the baseline", () => {
    const d = areaPath(
      [
        { x: 0, y: 1 },
        { x: 2, y: 3 },
      ],
      40,
    );
    expect(d).toBe("M0.0,1.0 L2.0,3.0 L2.0,40 L0.0,40 Z");
    expect(areaPath([], 40)).toBe("");
  });
});
