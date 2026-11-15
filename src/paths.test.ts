import { describe, expect, it } from "vitest";
import { ancestorChain, baseName, sepOf } from "./paths";

describe("sepOf", () => {
  it("detects windows and posix separators", () => {
    expect(sepOf("D:\\code\\proj")).toBe("\\");
    expect(sepOf("/Users/x/proj")).toBe("/");
  });
});

describe("baseName", () => {
  it("returns the last segment on both separators", () => {
    expect(baseName("D:\\code\\proj")).toBe("proj");
    expect(baseName("/Users/x/proj")).toBe("proj");
    expect(baseName("D:\\")).toBe("D:");
    expect(baseName("/")).toBe("/");
  });
});

describe("ancestorChain", () => {
  it("builds the full crumb trail on windows paths", () => {
    expect(ancestorChain("D:\\code\\proj\\src")).toEqual([
      "D:\\code",
      "D:\\code\\proj",
      "D:\\code\\proj\\src",
    ]);
    expect(ancestorChain("D:\\code")).toEqual(["D:\\code"]);
    expect(ancestorChain("D:")).toEqual([]);
  });

  it("keeps the leading slash on posix paths", () => {
    expect(ancestorChain("/Users/x/proj")).toEqual(["/Users", "/Users/x", "/Users/x/proj"]);
    expect(ancestorChain("/Users")).toEqual(["/Users"]);
  });
});
