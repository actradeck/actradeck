import { describe, expect, it } from "vitest";
import { formatSkippedRowLog, sanitizeLogField } from "../src/ingest-store.js";

// CodeQL js/log-injection (alert #29): the skipped-row warning embeds session_id, event_type
// and the validation reason from a contract-invalid row, so none of them may break the line.
describe("sanitizeLogField", () => {
  it("replaces line breaks so a value cannot forge a second log line", () => {
    const forged = "x\n[ingest-store] fake entry\r\nmore";
    const out = sanitizeLogField(forged);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe("x?[ingest-store] fake entry??more");
  });

  it("replaces other control characters and the Unicode line separators", () => {
    expect(sanitizeLogField("a\x00b\x1bc\x7fd\u2028e\u2029f")).toBe("a?b?c?d?e?f");
  });

  it("keeps ordinary values unchanged", () => {
    expect(sanitizeLogField("session.started")).toBe("session.started");
    expect(sanitizeLogField("T1 validation failed (payload.x:invalid_type)")).toBe(
      "T1 validation failed (payload.x:invalid_type)",
    );
  });

  it("caps long values at 200 characters plus an ellipsis", () => {
    const out = sanitizeLogField("a".repeat(500));
    expect(out).toBe(`${"a".repeat(200)}…`);
    expect(sanitizeLogField("a".repeat(200))).toBe("a".repeat(200));
  });
});

describe("formatSkippedRowLog", () => {
  it("sanitizes session_id, event_type and reason before embedding them", () => {
    const line = formatSkippedRowLog("s\nX", "bad\ntype", "r\rY");
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toBe(
      "[ingest-store] skipped contract-invalid event row for liveness synthesis: " +
        "session_id=s?X event_type=bad?type reason=r?Y",
    );
  });
});
