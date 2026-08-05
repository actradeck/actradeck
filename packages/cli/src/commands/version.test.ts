import { describe, it, expect } from "vitest";
import { cmdVersion } from "./version.js";
import { makeFakeDeps } from "../lib/fake.js";

const latestUrl = "https://api.github.com/repos/actradeck/actradeck/releases/latest";

describe("cmdVersion", () => {
  it("prints own version and 'up to date' when latest == self", async () => {
    const f = makeFakeDeps({ selfVersion: "0.4.0", json: { [latestUrl]: { tag_name: "v0.4.0" } } });
    expect(await cmdVersion(f.deps)).toBe(0);
    expect(f.out[0]).toBe("actradeck 0.4.0");
    expect(f.out.join("\n")).toMatch(/latest stable release \(v0\.4\.0\)/i);
  });

  it("flags an available update", async () => {
    const f = makeFakeDeps({ selfVersion: "0.4.0", json: { [latestUrl]: { tag_name: "v0.5.0" } } });
    await cmdVersion(f.deps);
    expect(f.out.join("\n")).toMatch(/newer stable release is available: v0\.5\.0/);
  });

  it("reports unknown when no stable release exists", async () => {
    const f = makeFakeDeps({ json: { [latestUrl]: { tag_name: "v1.0.0-rc.1" } } });
    await cmdVersion(f.deps);
    expect(f.out.join("\n")).toMatch(/Latest stable release: unknown/);
  });

  it("reports a bare latest tag when versions are unparseable to a comparison", async () => {
    const f = makeFakeDeps({ selfVersion: "weird", json: { [latestUrl]: { tag_name: "v0.4.0" } } });
    await cmdVersion(f.deps);
    expect(f.out.join("\n")).toMatch(/Latest stable release: v0\.4\.0\./);
  });

  it("degrades gracefully when offline (no crash, exit 0)", async () => {
    const f = makeFakeDeps({ json: { [latestUrl]: new Error("ENOTFOUND") } });
    expect(await cmdVersion(f.deps)).toBe(0);
    expect(f.out.join("\n")).toMatch(/Could not reach GitHub/);
  });

  // GFI #21: fetchOk bounds every request with AbortSignal.timeout(8000); when the timer fires,
  // fetch rejects with an AbortError-shaped error. Pin that this rejection takes the SAME
  // offline path as a DNS failure (local version printed, exit 0 — never a crash).
  it("an AbortError-shaped timeout rejection takes the offline path (local version, exit 0)", async () => {
    const abortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const f = makeFakeDeps({ selfVersion: "0.4.0", json: { [latestUrl]: abortErr } });
    expect(await cmdVersion(f.deps)).toBe(0);
    expect(f.out[0]).toBe("actradeck 0.4.0");
    expect(f.out.join("\n")).toMatch(/Could not reach GitHub/);
  });
});
