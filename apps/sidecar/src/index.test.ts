import { describe, expect, it } from "vitest";
import { SIDECAR_NAME, describeSidecar } from "./index.js";

describe("sidecar skeleton", () => {
  it("exposes its name", () => {
    expect(SIDECAR_NAME).toBe("@actradeck/sidecar");
  });

  it("can reference the event-model package", () => {
    expect(describeSidecar()).toContain("@actradeck/event-model");
  });
});
