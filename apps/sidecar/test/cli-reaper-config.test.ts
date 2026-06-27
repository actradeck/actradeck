import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAttachReaperConfig } from "../src/cli.js";

/**
 * resolveAttachReaperConfig — idle reaper の env 上書き解決 (QA-2 / ADR 019eb448)。
 *
 * idle-TTL は SessionEnd abrupt-exit backstop であり liveness 非依存。正常 long-idle の誤 reap 窓を
 * 運用調整できるよう env で上書き可能にする。不正値は無視して registry 既定へフォールバックする
 * (= 返り値にキーを載せない)。reaperIntervalMs=0 は「自動 sweep 無効」の正当値として採用する。
 */
describe("resolveAttachReaperConfig — idle reaper env override", () => {
  const saved = {
    ttl: process.env.ACTRADECK_ATTACH_IDLE_TTL_MS,
    interval: process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS,
  };

  beforeEach(() => {
    delete process.env.ACTRADECK_ATTACH_IDLE_TTL_MS;
    delete process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS;
  });
  afterEach(() => {
    if (saved.ttl === undefined) delete process.env.ACTRADECK_ATTACH_IDLE_TTL_MS;
    else process.env.ACTRADECK_ATTACH_IDLE_TTL_MS = saved.ttl;
    if (saved.interval === undefined) delete process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS;
    else process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS = saved.interval;
  });

  it("no env → empty config (registry defaults apply)", () => {
    expect(resolveAttachReaperConfig()).toEqual({});
  });

  it("valid idle-TTL and interval are parsed as integers", () => {
    process.env.ACTRADECK_ATTACH_IDLE_TTL_MS = "120000";
    process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS = "30000";
    expect(resolveAttachReaperConfig()).toEqual({ idleTtlMs: 120000, reaperIntervalMs: 30000 });
  });

  it("reaperIntervalMs=0 is accepted (disables auto-sweep)", () => {
    process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS = "0";
    expect(resolveAttachReaperConfig()).toEqual({ reaperIntervalMs: 0 });
  });

  it("idle-TTL must be positive: 0 and negative are ignored (fallback to default)", () => {
    process.env.ACTRADECK_ATTACH_IDLE_TTL_MS = "0";
    expect(resolveAttachReaperConfig()).toEqual({});
    process.env.ACTRADECK_ATTACH_IDLE_TTL_MS = "-5";
    expect(resolveAttachReaperConfig()).toEqual({});
  });

  it("non-numeric values are ignored (no NaN leaks into config)", () => {
    process.env.ACTRADECK_ATTACH_IDLE_TTL_MS = "soon";
    process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS = "later";
    expect(resolveAttachReaperConfig()).toEqual({});
  });

  it("negative interval is ignored but a valid idle-TTL still applies (independent parse)", () => {
    process.env.ACTRADECK_ATTACH_IDLE_TTL_MS = "600000";
    process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS = "-1";
    expect(resolveAttachReaperConfig()).toEqual({ idleTtlMs: 600000 });
  });
});
