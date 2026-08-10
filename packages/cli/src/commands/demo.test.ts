import { describe, expect, it } from "vitest";

import { cmdDemo } from "./demo.js";
import { makeFakeDeps } from "../lib/fake.js";

describe("cmdDemo", () => {
  it("shows the safety story without executing or writing anything", async () => {
    const f = makeFakeDeps();

    expect(await cmdDemo(f.deps)).toBe(0);

    const output = f.out.join("\n");
    expect(output).toContain("SAFE SIMULATION");
    expect(output).toContain("rm -rf ./important-directory");
    expect(output).toContain("[HELD]");
    expect(output).toContain("[DENIED]");
    expect(output).toContain("[REDACTED:github-token]");
    expect(output).toContain("[RECORDED]");
    expect(output).toContain("Run the 30-second safety demo");
    expect(output).toContain("Detection is best-effort, not a sandbox");

    expect(f.execCalls).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    expect(f.extracted).toHaveLength(0);
    expect(f.handoffs).toHaveLength(0);
    expect(f.removed).toHaveLength(0);
  });
});
