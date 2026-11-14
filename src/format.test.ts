import { describe, expect, it } from "vitest";
import { formatBytes, formatCountdown, formatDurationMs, formatPercent } from "./format";

describe("formatBytes", () => {
  it("handles zero, negative and non-finite", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("scales through units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  });
});

describe("formatPercent", () => {
  it("guards zero/negative totals and parts", () => {
    expect(formatPercent(0, 100)).toBe("0%");
    expect(formatPercent(5, 0)).toBe("0%");
  });
  it("rounds and caps", () => {
    expect(formatPercent(50, 200)).toBe("25%");
    expect(formatPercent(3000, 100)).toBe("999%");
  });
});

describe("formatDurationMs", () => {
  it("switches units at 1s and 1m", () => {
    expect(formatDurationMs(340)).toBe("340 ms");
    expect(formatDurationMs(1200)).toBe("1.2 s");
    expect(formatDurationMs(95_000)).toBe("1m 35s");
  });
});

describe("formatCountdown", () => {
  const now = 1_000_000_000_000;
  it("is null without a deadline", () => {
    expect(formatCountdown(null, now)).toBeNull();
  });
  it("renders m:ss while pending and a marker once due", () => {
    expect(formatCountdown(now / 1000 + 90, now)).toBe("1:30");
    expect(formatCountdown(now / 1000 - 1, now)).toBe("relocking…");
  });
});
