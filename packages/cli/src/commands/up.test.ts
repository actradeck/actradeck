import { describe, it, expect } from "vitest";
import { cmdUp } from "./up.js";
import { makeFakeDeps } from "../lib/fake.js";

describe("cmdUp", () => {
  it("prints the canonical docker run command and never executes anything", async () => {
    const f = makeFakeDeps();
    expect(await cmdUp(f.deps)).toBe(0);
    const text = f.out.join("\n");
    expect(text).toContain("docker run --rm");
    expect(text).toContain("-p 127.0.0.1:55400:55400");
    expect(text).toContain("-v actradeck_pgdata:/data");
    expect(text).toContain("ghcr.io/actradeck/actradeck:latest");
    expect(f.execCalls).toHaveLength(0); // prints only
  });

  it("derives the image from ACTRADECK_REPO (name-agnostic, lowercased)", async () => {
    const f = makeFakeDeps({ env: { ACTRADECK_REPO: "Acme/Tool" } });
    await cmdUp(f.deps);
    expect(f.out.join("\n")).toContain("ghcr.io/acme/tool:latest");
  });
});
