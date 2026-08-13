"use client";

import { useCallback, useEffect, useState } from "react";

const STATUS_PATH = "/realtime/telemetry";
const PREVIEW_PATH = "/realtime/telemetry/preview";
const MUTATION_PATH = "/realtime/telemetry";

export interface TelemetryStatus {
  readonly schema_version: 1;
  readonly mode: "off" | "anonymous";
  readonly offered_endpoint?: string;
  readonly endpoint?: string;
  readonly installation_id?: string;
  readonly enabled_at?: string;
  readonly last_success_at?: string;
}

export interface TelemetryPreview {
  readonly status: TelemetryStatus;
  readonly batch: unknown | null;
  readonly source_range: unknown | null;
}

export interface UseTelemetryResult {
  readonly status: TelemetryStatus | null;
  readonly preview: TelemetryPreview | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly reload: () => Promise<void>;
  readonly loadPreview: () => Promise<void>;
  readonly clearPreview: () => void;
  readonly enable: (endpoint?: string) => Promise<void>;
  readonly disable: () => Promise<void>;
  readonly resetId: () => Promise<void>;
  readonly flush: () => Promise<void>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Browser-side projection: only the local telemetry control fields are retained. */
export function parseTelemetryStatus(value: unknown): TelemetryStatus | null {
  const item = record(value);
  if (item?.schema_version !== 1 || (item.mode !== "off" && item.mode !== "anonymous")) return null;
  const endpoint = optionalString(item.endpoint);
  const offeredEndpoint = optionalString(item.offered_endpoint);
  const installationId = optionalString(item.installation_id);
  const enabledAt = optionalString(item.enabled_at);
  const lastSuccessAt = optionalString(item.last_success_at);
  if (item.mode === "anonymous" && (!endpoint || !installationId || !enabledAt)) return null;
  return {
    schema_version: 1,
    mode: item.mode,
    ...(offeredEndpoint ? { offered_endpoint: offeredEndpoint } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(installationId ? { installation_id: installationId } : {}),
    ...(enabledAt ? { enabled_at: enabledAt } : {}),
    ...(lastSuccessAt ? { last_success_at: lastSuccessAt } : {}),
  };
}

export function parseTelemetryPreview(value: unknown): TelemetryPreview | null {
  const item = record(value);
  if (!item || !("batch" in item) || !("source_range" in item)) return null;
  const status = parseTelemetryStatus(item.status);
  if (!status) return null;
  return {
    status,
    batch: item.batch ?? null,
    source_range: item.source_range ?? null,
  };
}

async function jsonRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw new Error(`telemetry request failed (${response.status})`);
  return (await response.json()) as unknown;
}

export function useTelemetry(active: boolean): UseTelemetryResult {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [preview, setPreview] = useState<TelemetryPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(false);
    try {
      const parsed = parseTelemetryStatus(await jsonRequest(STATUS_PATH));
      if (!parsed) throw new Error("invalid telemetry status");
      setStatus(parsed);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      setPreview(null);
      return;
    }
    void reload();
  }, [active, reload]);

  const loadPreview = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(false);
    try {
      const parsed = parseTelemetryPreview(await jsonRequest(PREVIEW_PATH));
      if (!parsed) throw new Error("invalid telemetry preview");
      setPreview(parsed);
      setStatus(parsed.status);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const mutate = useCallback(
    async (action: string, body: Readonly<Record<string, string>> = {}) => {
      setLoading(true);
      setError(false);
      try {
        const parsed = parseTelemetryStatus(
          await jsonRequest(`${MUTATION_PATH}/${action}`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
        );
        if (!parsed) throw new Error("invalid telemetry mutation response");
        setStatus(parsed);
        setPreview(null);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const flush = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(false);
    try {
      await jsonRequest(`${MUTATION_PATH}/flush`, { method: "POST", body: "{}" });
      await reload();
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [reload]);

  return {
    status,
    preview,
    loading,
    error,
    reload,
    loadPreview,
    clearPreview: () => setPreview(null),
    enable: async (endpoint) => {
      await mutate("enable", endpoint ? { endpoint } : {});
    },
    disable: async () => {
      await mutate("disable");
    },
    resetId: async () => {
      await mutate("reset-id");
    },
    flush,
  };
}
