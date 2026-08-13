import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  ACTRADECK_APP_VERSION,
  ACTRADECK_PUBLIC_TELEMETRY_ENDPOINT,
  AnonymousTelemetry,
  TelemetryError,
  defaultTelemetryStatePath,
  normalizeTelemetryEndpoint,
  telemetryErrorCode,
  type TelemetryUsageSource,
} from "./telemetry.js";
import type { UsageReport, UsageRange } from "./usage-store.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

// QA-11 (2026-08-13 監査): fixture の mkdtemp を残留させない (テスト実行ごとの tmp ごみ堆積防止)。
const FIXTURE_DIRS: string[] = [];
afterAll(async () => {
  await Promise.all(FIXTURE_DIRS.map((dir) => rm(dir, { recursive: true, force: true })));
});

function usage(days: UsageReport["days"] = []): TelemetryUsageSource {
  return {
    report: vi.fn(async (range: UsageRange) => ({
      schema_version: 1,
      timezone: "UTC",
      semantics: "local_aggregate_not_users",
      from: range.from,
      to: range.to,
      totals: {
        cockpit_demo_started: 0,
        cockpit_demo_completed: 0,
        real_sessions: 0,
        protected_sessions: 0,
        approval_requests: 0,
        operator_decisions: 0,
      },
      days,
    })),
  };
}

async function fixture(source = usage()) {
  const directory = await mkdtemp(join(tmpdir(), "actradeck-telemetry-"));
  FIXTURE_DIRS.push(directory);
  const statePath = join(directory, "telemetry.json");
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));
  const telemetry = new AnonymousTelemetry({
    env: {}, // SEC-R3-2: kill-switch を明示解除 (setup-env が全テストプロセスへ注入するため)
    usage: source,
    statePath,
    defaultEndpoint: "https://telemetry.example.test/v1/events",
    now: () => new Date(NOW),
    fetchImpl,
  });
  return { telemetry, statePath, fetchImpl };
}

describe("anonymous telemetry", () => {
  it("QA-R2-3: the test-process kill-switch injection is live (setup-env pins ACTRADECK_TELEMETRY_DISABLED)", () => {
    // setup-env.ts が全テストプロセスへ構造注入する。この pin が落ちたら、kill-switch を
    // 設定しない新テストが startFromEnv() 経由で実 consent state・実 collector に触れうる。
    expect(process.env.ACTRADECK_TELEMETRY_DISABLED).toBe("1");
  });

  it("SEC-R3-2: the env kill-switch disables the instance itself (defense in depth)", async () => {
    // composition root (index.ts) の非生成に加え、直接 construct された instance も kill-switch を
    // 尊重する: statePath 省略 + 本番 endpoint の将来テストが実 consent state を書いたり実送信
    // する事故を単一 egress 点で止める。enable は closed code で拒否・state file は生成されない。
    const directory = await mkdtemp(join(tmpdir(), "actradeck-telemetry-"));
    FIXTURE_DIRS.push(directory);
    const statePath = join(directory, "state.json");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));
    const telemetry = new AnonymousTelemetry({
      env: { ACTRADECK_TELEMETRY_DISABLED: "1" },
      usage: usage(),
      statePath,
      defaultEndpoint: "https://telemetry.example.test/v1/events",
      now: () => new Date(NOW),
      fetchImpl,
    });
    await expect(telemetry.enable()).rejects.toMatchObject({ code: "not_configured" });
    await expect(telemetry.flush()).resolves.toEqual({
      sent: false,
      event_count: 0,
      reason: "disabled",
    });
    await telemetry.start();
    telemetry.dispose();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is default-off and performs no network request", async () => {
    const { telemetry, fetchImpl } = await fixture();
    expect(await telemetry.status()).toMatchObject({
      mode: "off",
      offered_endpoint: "https://telemetry.example.test/v1/events",
    });
    expect(await telemetry.flush()).toEqual({ sent: false, event_count: 0, reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an explicit collector and rejects unsafe endpoints", async () => {
    expect(normalizeTelemetryEndpoint(ACTRADECK_PUBLIC_TELEMETRY_ENDPOINT)).toBe(
      ACTRADECK_PUBLIC_TELEMETRY_ENDPOINT,
    );
    expect(() => normalizeTelemetryEndpoint("http://telemetry.example.test/events")).toThrow(
      /HTTPS/,
    );
    expect(() => normalizeTelemetryEndpoint("https://user:pw@example.test/events")).toThrow();
    expect(normalizeTelemetryEndpoint("http://127.0.0.1:8789/v1/events")).toBe(
      "http://127.0.0.1:8789/v1/events",
    );
    const directory = await mkdtemp(join(tmpdir(), "actradeck-telemetry-"));
    FIXTURE_DIRS.push(directory);
    const telemetry = new AnonymousTelemetry({
      env: {}, // SEC-R3-2: kill-switch を明示解除 (setup-env が全テストプロセスへ注入するため)
      usage: usage(),
      statePath: join(directory, "state.json"),
      now: () => new Date(NOW),
    });
    await expect(telemetry.enable()).rejects.toThrow(/collector is not configured/);
  });

  it("previews and sends only the closed daily aggregate contract", async () => {
    const source = usage([
      {
        day: "2026-08-11",
        cockpit_demo_started: 2,
        cockpit_demo_completed: 1,
        real_sessions: 4,
        protected_sessions: 3,
        approval_requests: 2,
        operator_decisions: 1,
      },
    ]);
    const { telemetry, fetchImpl, statePath } = await fixture(source);
    await telemetry.enable();
    const preview = await telemetry.preview();
    expect(preview.batch?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_name: "install_verified", count: 1 }),
        expect.objectContaining({ event_name: "cockpit_started", count: 1 }),
        expect.objectContaining({ event_name: "governed_session_started", count: 3 }),
        expect.objectContaining({ event_name: "active_day", count: 1 }),
      ]),
    );
    expect(JSON.stringify(preview.batch)).not.toMatch(
      /command|prompt|cwd|repo|session_id|event_id|audit payload/i,
    );
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    await expect(telemetry.flush()).resolves.toMatchObject({ sent: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1].body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual(preview.batch);
    expect(await readFile(statePath, "utf8")).toContain("last_success_at");
  });

  it("disable deletes the local identifier and reset-id rotates it", async () => {
    const { telemetry, statePath } = await fixture();
    const enabled = await telemetry.enable();
    const reset = await telemetry.resetId();
    expect(reset.installation_id).not.toBe(enabled.installation_id);
    await telemetry.disable();
    expect(await telemetry.status()).toMatchObject({ mode: "off" });
    expect(await readFile(statePath, "utf8")).not.toContain("installation_id");
  });

  it("derives state beside embedded data and honors an explicit path", () => {
    expect(defaultTelemetryStatePath({ ACTRADECK_PGDATA: "/data/pgdata" })).toBe(
      "/data/telemetry.json",
    );
    expect(defaultTelemetryStatePath({ ACTRADECK_TELEMETRY_STATE: "/tmp/custom.json" })).toBe(
      "/tmp/custom.json",
    );
  });

  it("stamps app_version from the backend package manifest, never a source literal (TDA-1)", async () => {
    // version.sh は package.json のみ stamp する。ソース直書きはリリース毎に旧版を名乗る
    // silent 汚染源なので、実行時導出が manifest と一致することを pin する。
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(ACTRADECK_APP_VERSION).toBe(manifest.version);
    expect(ACTRADECK_APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const { telemetry } = await fixture();
    await telemetry.enable();
    const preview = await telemetry.preview();
    for (const event of preview.batch?.events ?? []) {
      expect(event.app_version).toBe(manifest.version);
    }
  });

  it("INV-TELEMETRY-BOOT-FAILSAFE: unreadable/corrupt state degrades to off with zero egress (SEC-2)", async () => {
    for (const corrupt of [
      "{ not json",
      "",
      JSON.stringify({ schema_version: 2, mode: "anonymous" }),
      JSON.stringify({ schema_version: 1, mode: "anonymous", installation_id: "not-a-uuid" }),
    ]) {
      const { telemetry, statePath, fetchImpl } = await fixture();
      await writeFile(statePath, corrupt, "utf8");
      await expect(telemetry.status()).resolves.toMatchObject({ mode: "off" });
      await expect(telemetry.flush()).resolves.toMatchObject({ sent: false, reason: "disabled" });
      // start() (boot 経路) も throw せず、egress ゼロのまま。
      await telemetry.start();
      telemetry.dispose();
      expect(fetchImpl).not.toHaveBeenCalled();
      // 壊れたファイルは上書きされない (調査可能性を残す)。
      expect(await readFile(statePath, "utf8")).toBe(corrupt);
    }
  });

  it("INV-TELEMETRY-BOOT-FAILSAFE: an invalid offered endpoint degrades to none instead of throwing (SEC-2)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "actradeck-telemetry-"));
    FIXTURE_DIRS.push(directory);
    const telemetry = new AnonymousTelemetry({
      env: {}, // SEC-R3-2: kill-switch を明示解除 (setup-env が全テストプロセスへ注入するため)
      usage: usage(),
      statePath: join(directory, "state.json"),
      defaultEndpoint: "http://collector.internal/v1/events", // 非 loopback HTTP = invalid
      now: () => new Date(NOW),
    });
    const status = await telemetry.status();
    expect(status.mode).toBe("off");
    expect(status.offered_endpoint).toBeUndefined();
    // 提示 endpoint 無し ⇒ enable は明示 endpoint を要求する (closed code)。
    await expect(telemetry.enable()).rejects.toMatchObject({ code: "not_configured" });
  });

  it("records cockpit_started as at-most-once-per-UTC-day presence, not a process-start counter (QA-2)", async () => {
    const { telemetry, statePath, fetchImpl } = await fixture();
    await telemetry.enable(); // records the day
    await telemetry.start(); // same day: must stay 1
    telemetry.dispose();
    await telemetry.start();
    telemetry.dispose();
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      cockpit_started: Record<string, number>;
    };
    expect(state.cockpit_started).toEqual({ "2026-08-11": 1 });
    const preview = await telemetry.preview();
    const started = preview.batch?.events.filter((e) => e.event_name === "cockpit_started");
    expect(started).toEqual([expect.objectContaining({ occurred_on: "2026-08-11", count: 1 })]);
    expect(fetchImpl).toHaveBeenCalled(); // start() は flush を試みる (enable 済みなので送信可)。
  });

  it("clamps install_verified into the reported source_range (TDA-17)", async () => {
    const { telemetry, statePath } = await fixture();
    await telemetry.enable();
    // enabled_at をレポート窓 (30 日) より古い日へ書き換える。
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(
      statePath,
      JSON.stringify({ ...state, enabled_at: "2026-05-01T00:00:00.000Z" }),
      "utf8",
    );
    const preview = await telemetry.preview();
    expect(preview.source_range).not.toBeNull();
    const install = preview.batch?.events.find((e) => e.event_name === "install_verified");
    expect(install?.occurred_on).toBe(preview.source_range?.from);
    for (const event of preview.batch?.events ?? []) {
      expect(event.occurred_on >= preview.source_range!.from).toBe(true);
      expect(event.occurred_on <= preview.source_range!.to).toBe(true);
    }
  });

  it("maps telemetry failures to the closed error vocabulary only (SEC-4)", async () => {
    try {
      normalizeTelemetryEndpoint("https://user:pw@example.test/events");
      expect.unreachable("normalize must reject credentials");
    } catch (error) {
      expect(error).toBeInstanceOf(TelemetryError);
      expect((error as TelemetryError).code).toBe("invalid_endpoint");
    }
    const { telemetry } = await fixture();
    await expect(telemetry.resetId()).rejects.toMatchObject({ code: "not_enabled" });
    // 未知エラーは fallback へ畳む (raw message を外へ出す経路を作らない)。
    expect(
      telemetryErrorCode(new Error("EACCES: /home/user/.actradeck"), "state_write_failed"),
    ).toBe("state_write_failed");
    expect(telemetryErrorCode(new TelemetryError("send_failed", "x"), "state_write_failed")).toBe(
      "send_failed",
    );
  });

  it("SEC-R2-1: flush does not follow redirects — a 3xx from the approved endpoint fails closed", async () => {
    // normalizeTelemetryEndpoint は初回ホップしか検証しない。redirect を follow すると、ゲート通過済み
    // endpoint が 307 で「直接指定なら invalid_endpoint で拒否される宛先」へ batch を横流しできる
    // (R2 監査で 127.0.0.2 への leak を実証)。実 fetch + 実 loopback サーバで非追従を固定する。
    const { createServer } = await import("node:http");
    let downstreamHits = 0;
    const downstream = createServer((_request, response) => {
      downstreamHits += 1;
      response.writeHead(202, { "content-type": "application/json" }).end("{}");
    });
    const redirector = createServer((_request, response) => {
      const { port } = downstream.address() as { port: number };
      response.writeHead(307, { location: `http://127.0.0.1:${port}/exfil` }).end();
    });
    await new Promise<void>((r) => downstream.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    try {
      const directory = await mkdtemp(join(tmpdir(), "actradeck-telemetry-"));
      FIXTURE_DIRS.push(directory);
      const { port } = redirector.address() as { port: number };
      const telemetry = new AnonymousTelemetry({
        env: {}, // SEC-R3-2: kill-switch を明示解除 (setup-env が全テストプロセスへ注入するため)
        usage: usage(),
        statePath: join(directory, "state.json"),
        defaultEndpoint: `http://127.0.0.1:${port}/v1/events`,
        now: () => new Date(NOW),
        // fetchImpl 非注入 = 実 fetch。redirect: "error" の実挙動そのものを検証する。
      });
      await telemetry.enable();
      await expect(telemetry.flush()).rejects.toMatchObject({ code: "send_failed" });
      expect(downstreamHits).toBe(0);
    } finally {
      await new Promise<void>((r) => redirector.close(() => r()));
      await new Promise<void>((r) => downstream.close(() => r()));
    }
  });

  it("SEC-R2-1: the flush fetch init pins redirect:'error' (DI contract)", async () => {
    const { telemetry, fetchImpl } = await fixture(
      usage([
        {
          day: "2026-08-11",
          cockpit_demo_started: 1,
          cockpit_demo_completed: 0,
          real_sessions: 0,
          protected_sessions: 0,
          approval_requests: 0,
          operator_decisions: 0,
        },
      ]),
    );
    await telemetry.enable();
    await telemetry.flush();
    expect(fetchImpl.mock.calls.at(-1)?.[1]).toMatchObject({ redirect: "error" });
  });

  it("flush failure surfaces a closed code without upstream status echo (SEC-1/SEC-4)", async () => {
    const { telemetry, fetchImpl } = await fixture(
      usage([
        {
          day: "2026-08-11",
          cockpit_demo_started: 1,
          cockpit_demo_completed: 0,
          real_sessions: 0,
          protected_sessions: 0,
          approval_requests: 0,
          operator_decisions: 0,
        },
      ]),
    );
    await telemetry.enable();
    fetchImpl.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    try {
      await telemetry.flush();
      expect.unreachable("flush must reject on upstream failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TelemetryError);
      expect((error as TelemetryError).code).toBe("send_failed");
      expect((error as TelemetryError).message).not.toContain("503");
    }
  });
});
