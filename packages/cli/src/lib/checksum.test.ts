import { describe, it, expect } from "vitest";
import { sha256Hex, expectedDigestFor, verifySha256 } from "./checksum.js";

const bytes = new TextEncoder().encode("hello actradeck");
const digest = sha256Hex(bytes);

describe("sha256Hex", () => {
  it("is 64 lowercase hex chars and stable", () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(bytes)).toBe(digest);
  });
});

describe("expectedDigestFor", () => {
  it("resolves the digest for a named asset (two-space and *-prefixed forms)", () => {
    const cs = `${digest}  actradeck-0.4.0.tar.gz\ndeadbeef  other`;
    expect(expectedDigestFor(cs, "actradeck-0.4.0.tar.gz")).toBe(digest);
    const star = `${digest} *actradeck-0.4.0.tar.gz`;
    expect(expectedDigestFor(star, "actradeck-0.4.0.tar.gz")).toBe(digest);
  });
  it("returns null when the asset is absent (fail-closed upstream)", () => {
    expect(expectedDigestFor(`${digest}  something-else`, "actradeck-0.4.0.tar.gz")).toBeNull();
    expect(expectedDigestFor("", "x")).toBeNull();
    expect(expectedDigestFor("garbage line without digest", "x")).toBeNull();
  });
  it("lowercases an uppercase digest entry", () => {
    const cs = `${digest.toUpperCase()}  a.tar.gz`;
    expect(expectedDigestFor(cs, "a.tar.gz")).toBe(digest);
  });
});

describe("verifySha256", () => {
  it("accepts a matching digest (case-insensitive)", () => {
    expect(verifySha256(bytes, digest)).toBe(true);
    expect(verifySha256(bytes, digest.toUpperCase())).toBe(true);
  });
  it("fails closed on mismatch, null, or empty", () => {
    expect(verifySha256(bytes, "0".repeat(64))).toBe(false);
    expect(verifySha256(bytes, null)).toBe(false);
    expect(verifySha256(bytes, "")).toBe(false);
  });
});
