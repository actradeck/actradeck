/**
 * Explicitly opted-in, anonymous product telemetry.
 *
 * The wire shape is deliberately closed by @actradeck/telemetry-contract. This module only
 * converts the local aggregate usage view into absolute UTC-day counters. Commands, prompts,
 * paths, repository names and ActraDeck session/event identifiers never enter this code path.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";

import {
  TELEMETRY_SCHEMA_VERSION,
  TelemetryBatch,
  telemetryPlatform,
  type TelemetryDailyEvent,
  type TelemetryEventName,
} from "@actradeck/telemetry-contract";

import type { UsageReport, UsageRange } from "./usage-store.js";

export const ACTRADECK_APP_VERSION = "0.7.0" as const;
export const ACTRADECK_PUBLIC_TELEMETRY_ENDPOINT =
  "https://actradeck-telemetry.actradeck-telemetry-collector.workers.dev/v1/events" as const;
export const TELEMETRY_SEND_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const TELEMETRY_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;
const MAX_LOCAL_COUNTER = 1_000_000_000;
const STATUS_COLLECTS = [
  "installation verification",
  "cockpit starts and demo completion",
  "agent/governed session daily counts",
  "approval request/decision daily counts",
  "active UTC days",
] as const;
const STATUS_EXCLUDES = [
  "prompts and commands",
  "paths and repository names",
  "ActraDeck session and event identifiers",
  "secrets and audit event payloads",
] as const;

interface AnonymousTelemetryState {
  readonly schema_version: 1;
  readonly mode: "anonymous";
  readonly installation_id: string;
  readonly endpoint: string;
  readonly enabled_at: string;
  readonly last_success_at?: string;
  readonly cockpit_started: Readonly<Record<string, number>>;
}

interface DisabledTelemetryState {
  readonly schema_version: 1;
  readonly mode: "off";
}

type PersistedTelemetryState = AnonymousTelemetryState | DisabledTelemetryState;

export interface TelemetryStatus {
  readonly schema_version: 1;
  readonly mode: "off" | "anonymous";
  readonly offered_endpoint?: string;
  readonly endpoint?: string;
  readonly installation_id?: string;
  readonly enabled_at?: string;
  readonly last_success_at?: string;
  readonly collects: readonly string[];
  readonly excludes: readonly string[];
}

export interface TelemetryPreview {
  readonly status: TelemetryStatus;
  readonly batch: TelemetryBatch | null;
  readonly source_range: UsageRange | null;
}

export interface TelemetryFlushResult {
  readonly sent: boolean;
  readonly event_count: number;
  readonly reason?: "disabled" | "empty";
}

export interface TelemetryUsageSource {
  report(range: UsageRange): Promise<UsageReport>;
}

export type TelemetryFetch = (
  input: string | URL,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export interface AnonymousTelemetryOptions {
  readonly usage: TelemetryUsageSource;
  readonly statePath?: string;
  readonly defaultEndpoint?: string;
  readonly appVersion?: string;
  readonly fetchImpl?: TelemetryFetch;
  readonly now?: () => Date;
  readonly sendIntervalMs?: number;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function isCounterMap(value: unknown): value is Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([day, count]) =>
      isUtcDay(day) &&
      typeof count === "number" &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= MAX_LOCAL_COUNTER,
  );
}

function parseState(value: unknown): PersistedTelemetryState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid telemetry state");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) throw new Error("unsupported telemetry state schema");
  if (record.mode === "off") return { schema_version: 1, mode: "off" };
  if (
    record.mode !== "anonymous" ||
    typeof record.installation_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.installation_id,
    ) ||
    typeof record.endpoint !== "string" ||
    !isIsoInstant(record.enabled_at) ||
    (record.last_success_at !== undefined && !isIsoInstant(record.last_success_at)) ||
    !isCounterMap(record.cockpit_started)
  ) {
    throw new Error("invalid anonymous telemetry state");
  }
  return {
    schema_version: 1,
    mode: "anonymous",
    installation_id: record.installation_id,
    endpoint: normalizeTelemetryEndpoint(record.endpoint),
    enabled_at: record.enabled_at,
    ...(record.last_success_at !== undefined
      ? { last_success_at: record.last_success_at as string }
      : {}),
    cockpit_started: record.cockpit_started,
  };
}

/** Only HTTPS collectors are accepted, except explicit loopback HTTP for local development. */
export function normalizeTelemetryEndpoint(raw: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("telemetry endpoint must be an absolute URL");
  }
  const loopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]" ||
    endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("telemetry endpoint must use HTTPS (loopback HTTP is allowed for development)");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(
      "telemetry endpoint must not contain credentials, query parameters, or fragments",
    );
  }
  return endpoint.toString();
}

export function defaultTelemetryStatePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env.ACTRADECK_TELEMETRY_STATE) return resolve(env.ACTRADECK_TELEMETRY_STATE);
  if (env.ACTRADECK_PGDATA)
    return resolve(dirname(resolve(env.ACTRADECK_PGDATA)), "telemetry.json");
  return resolve(homedir(), ".actradeck", "telemetry.json");
}

class TelemetryStateStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => Date,
  ) {}

  private async readDirect(): Promise<PersistedTelemetryState> {
    try {
      return parseState(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema_version: 1, mode: "off" };
      }
      throw error;
    }
  }

  private async writeDirect(state: PersistedTelemetryState): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: (() => void) | undefined;
    this.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async read(): Promise<PersistedTelemetryState> {
    return this.exclusive(() => this.readDirect());
  }

  async enable(endpoint: string): Promise<AnonymousTelemetryState> {
    const normalized = normalizeTelemetryEndpoint(endpoint);
    return this.exclusive(async () => {
      const current = await this.readDirect();
      const enabled: AnonymousTelemetryState =
        current.mode === "anonymous"
          ? { ...current, endpoint: normalized }
          : {
              schema_version: 1,
              mode: "anonymous",
              installation_id: randomUUID(),
              endpoint: normalized,
              enabled_at: this.now().toISOString(),
              cockpit_started: {},
            };
      await this.writeDirect(enabled);
      return enabled;
    });
  }

  async disable(): Promise<void> {
    await this.exclusive(() => this.writeDirect({ schema_version: 1, mode: "off" }));
  }

  async resetId(): Promise<AnonymousTelemetryState> {
    return this.exclusive(async () => {
      const current = await this.readDirect();
      if (current.mode !== "anonymous") throw new Error("anonymous telemetry is disabled");
      const reset: AnonymousTelemetryState = {
        schema_version: 1,
        mode: "anonymous",
        installation_id: randomUUID(),
        endpoint: current.endpoint,
        enabled_at: this.now().toISOString(),
        cockpit_started: {},
      };
      await this.writeDirect(reset);
      return reset;
    });
  }

  async recordCockpitStarted(): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.readDirect();
      if (current.mode !== "anonymous") return;
      const now = this.now();
      const today = utcDay(now);
      const cutoff = utcDay(new Date(now.getTime() - 89 * DAY_MS));
      const counters = Object.fromEntries(
        Object.entries(current.cockpit_started).filter(([day]) => day >= cutoff),
      );
      counters[today] = Math.min(MAX_LOCAL_COUNTER, (counters[today] ?? 0) + 1);
      await this.writeDirect({ ...current, cockpit_started: counters });
    });
  }

  async recordSuccess(at: Date): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.readDirect();
      if (current.mode !== "anonymous") return;
      await this.writeDirect({ ...current, last_success_at: at.toISOString() });
    });
  }
}

function publicStatus(state: PersistedTelemetryState, defaultEndpoint?: string): TelemetryStatus {
  return {
    schema_version: 1,
    mode: state.mode,
    ...(state.mode === "off" && defaultEndpoint !== undefined
      ? { offered_endpoint: defaultEndpoint }
      : {}),
    ...(state.mode === "anonymous"
      ? {
          endpoint: state.endpoint,
          installation_id: state.installation_id,
          enabled_at: state.enabled_at,
          ...(state.last_success_at !== undefined
            ? { last_success_at: state.last_success_at }
            : {}),
        }
      : {}),
    collects: STATUS_COLLECTS,
    excludes: STATUS_EXCLUDES,
  };
}

function pushEvent(
  events: TelemetryDailyEvent[],
  appVersion: string,
  eventName: TelemetryEventName,
  day: string,
  count: number,
): void {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  events.push({
    event_name: eventName,
    occurred_on: day,
    app_version: appVersion,
    platform: telemetryPlatform(platform()),
    count,
  });
}

export class AnonymousTelemetry {
  private readonly state: TelemetryStateStore;
  private readonly defaultEndpoint: string | undefined;
  private readonly appVersion: string;
  private readonly fetchImpl: TelemetryFetch;
  private readonly now: () => Date;
  private readonly sendIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AnonymousTelemetryOptions) {
    this.now = options.now ?? (() => new Date());
    this.state = new TelemetryStateStore(
      options.statePath ?? defaultTelemetryStatePath(),
      this.now,
    );
    this.defaultEndpoint = options.defaultEndpoint
      ? normalizeTelemetryEndpoint(options.defaultEndpoint)
      : undefined;
    this.appVersion = options.appVersion ?? ACTRADECK_APP_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sendIntervalMs = options.sendIntervalMs ?? TELEMETRY_SEND_INTERVAL_MS;
  }

  async status(): Promise<TelemetryStatus> {
    return publicStatus(await this.state.read(), this.defaultEndpoint);
  }

  async preview(): Promise<TelemetryPreview> {
    const state = await this.state.read();
    const status = publicStatus(state, this.defaultEndpoint);
    if (state.mode !== "anonymous") return { status, batch: null, source_range: null };

    const now = this.now();
    const earliest = new Date(now.getTime() - (TELEMETRY_LOOKBACK_DAYS - 1) * DAY_MS);
    const enabledAt = new Date(state.enabled_at);
    const from = utcDay(enabledAt > earliest ? enabledAt : earliest);
    const range = { from, to: utcDay(now) };
    const report = await this.options.usage.report(range);
    const events: TelemetryDailyEvent[] = [];

    pushEvent(events, this.appVersion, "install_verified", utcDay(enabledAt), 1);
    for (const [day, count] of Object.entries(state.cockpit_started)) {
      if (day >= range.from && day <= range.to) {
        pushEvent(events, this.appVersion, "cockpit_started", day, count);
      }
    }

    let sawAgent = false;
    let sawGoverned = false;
    for (const day of report.days) {
      pushEvent(events, this.appVersion, "cockpit_demo_started", day.day, day.cockpit_demo_started);
      pushEvent(
        events,
        this.appVersion,
        "cockpit_demo_completed",
        day.day,
        day.cockpit_demo_completed,
      );
      pushEvent(
        events,
        this.appVersion,
        "governed_session_started",
        day.day,
        day.protected_sessions,
      );
      pushEvent(events, this.appVersion, "approval_requested", day.day, day.approval_requests);
      pushEvent(events, this.appVersion, "approval_decided", day.day, day.operator_decisions);
      if (day.real_sessions > 0) {
        pushEvent(events, this.appVersion, "active_day", day.day, 1);
        if (!sawAgent) {
          pushEvent(events, this.appVersion, "first_agent_observed", day.day, 1);
          sawAgent = true;
        }
      }
      if (day.protected_sessions > 0 && !sawGoverned) {
        pushEvent(events, this.appVersion, "first_governed_session", day.day, 1);
        sawGoverned = true;
      }
    }
    events.sort(
      (left, right) =>
        left.occurred_on.localeCompare(right.occurred_on) ||
        left.event_name.localeCompare(right.event_name),
    );
    const batch = TelemetryBatch.parse({
      schema_version: TELEMETRY_SCHEMA_VERSION,
      installation_id: state.installation_id,
      events,
    });
    return { status, batch, source_range: range };
  }

  async enable(endpoint?: string): Promise<TelemetryStatus> {
    const selected = endpoint ?? this.defaultEndpoint;
    if (!selected) {
      throw new Error(
        "telemetry collector is not configured; set ACTRADECK_TELEMETRY_ENDPOINT or pass endpoint",
      );
    }
    await this.state.enable(selected);
    await this.state.recordCockpitStarted();
    return this.status();
  }

  async disable(): Promise<TelemetryStatus> {
    await this.state.disable();
    return this.status();
  }

  async resetId(): Promise<TelemetryStatus> {
    await this.state.resetId();
    await this.state.recordCockpitStarted();
    return this.status();
  }

  async flush(): Promise<TelemetryFlushResult> {
    const preview = await this.preview();
    if (preview.status.mode !== "anonymous" || preview.batch === null) {
      return { sent: false, event_count: 0, reason: "disabled" };
    }
    if (preview.batch.events.length === 0) {
      return { sent: false, event_count: 0, reason: "empty" };
    }
    const endpoint = preview.status.endpoint;
    if (!endpoint) throw new Error("anonymous telemetry endpoint missing");
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(preview.batch),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`telemetry collector returned HTTP ${response.status}`);
    await this.state.recordSuccess(this.now());
    return { sent: true, event_count: preview.batch.events.length };
  }

  async start(): Promise<void> {
    await this.state.recordCockpitStarted();
    void this.flush().catch(() => {});
    this.timer = setInterval(() => void this.flush().catch(() => {}), this.sendIntervalMs);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
