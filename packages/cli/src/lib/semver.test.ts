import { describe, it, expect } from "vitest";
import { parseSemver, isStable, compareSemver } from "./semver.js";

describe("parseSemver", () => {
  it("parses X.Y.Z with and without a leading v", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseSemver("0.4.0")).toEqual({ major: 0, minor: 4, patch: 0, prerelease: null });
  });
  it("parses prerelease + build metadata", () => {
    expect(parseSemver("1.0.0-rc.1+build.9")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ["rc", "1"],
    });
  });
  it("rejects garbage", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("v1.2.3.4")).toBeNull();
  });
});

describe("isStable", () => {
  it("is false for prereleases", () => {
    expect(isStable(parseSemver("1.0.0")!)).toBe(true);
    expect(isStable(parseSemver("1.0.0-rc.1")!)).toBe(false);
  });
});

describe("compareSemver", () => {
  const c = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
  it("orders by major/minor/patch", () => {
    expect(c("1.0.0", "2.0.0")).toBe(-1);
    expect(c("1.2.0", "1.1.9")).toBe(1);
    expect(c("1.1.1", "1.1.2")).toBe(-1);
    expect(c("1.1.1", "1.1.1")).toBe(0);
  });
  it("treats a release as higher precedence than its prerelease", () => {
    expect(c("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(c("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });
  it("orders prerelease identifiers per SemVer §11.4", () => {
    expect(c("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1); // fewer fields = lower
    expect(c("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1); // numeric < alphanumeric
    expect(c("1.0.0-beta", "1.0.0-alpha")).toBe(1);
    expect(c("1.0.0-1", "1.0.0-2")).toBe(-1); // numeric compare
    expect(c("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });
  it("ignores build metadata", () => {
    expect(c("1.0.0+a", "1.0.0+b")).toBe(0);
  });
});
