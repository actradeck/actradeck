"use client";

import { useCallback, useEffect, useState } from "react";

import { TelemetryBatch } from "@actradeck/telemetry-contract";
import type { TelemetryStatus as BackendTelemetryStatus } from "@actradeck/backend";

const STATUS_PATH = "/realtime/telemetry";
const PREVIEW_PATH = "/realtime/telemetry/preview";
const MUTATION_PATH = "/realtime/telemetry";

/**
 * Browser-side **projection** of the backend TelemetryStatus (collects/excludes の開示文言は
 * UI 側 i18n が持つため落とす)。TDA-6 (2026-08-13 監査): 手書きミラーの drift を compile-time で
 * pin する — 下の `TelemetryStatusMirrorPinned` が backend 契約の同名フィールド Pick と相互
 * assignable であることを要求し、backend 側の型変更で webui の型検査が赤くなる。
 */
export interface TelemetryStatus {
  readonly schema_version: 1;
  readonly mode: "off" | "anonymous";
  readonly offered_endpoint?: string;
  readonly endpoint?: string;
  readonly installation_id?: string;
  readonly enabled_at?: string;
  readonly last_success_at?: string;
}

type BackendProjection = Pick<
  BackendTelemetryStatus,
  | "schema_version"
  | "mode"
  | "offered_endpoint"
  | "endpoint"
  | "installation_id"
  | "enabled_at"
  | "last_success_at"
>;
type TelemetryStatusMirrorPinned = [TelemetryStatus] extends [BackendProjection]
  ? [BackendProjection] extends [TelemetryStatus]
    ? true
    : never
  : never;
// 型レベル tripwire の実体化 (未使用警告を出さずに評価を強制する)。
const _telemetryStatusMirrorPinned: TelemetryStatusMirrorPinned = true;
void _telemetryStatusMirrorPinned;

export interface TelemetryPreview {
  readonly status: TelemetryStatus;
  /**
   * QA-8 (2026-08-13 監査): batch は verbatim 透過せず、送信側と同じ closed contract
   * (@actradeck/telemetry-contract TelemetryBatch) で **read 境界再射影**してから DOM へ渡す
   * (NO-RAW by construction — 将来 wire に余剰 field が載っても構造的に落ちる)。
   */
  readonly batch: TelemetryBatch | null;
  readonly source_range: { readonly from: string; readonly to: string } | null;
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
  // closed-contract 再射影: batch は TelemetryBatch でなければ preview ごと不正扱い (null)。
  let batch: TelemetryBatch | null = null;
  if (item.batch !== null && item.batch !== undefined) {
    const parsed = TelemetryBatch.safeParse(item.batch);
    if (!parsed.success) return null;
    batch = parsed.data;
  }
  let sourceRange: TelemetryPreview["source_range"] = null;
  if (item.source_range !== null && item.source_range !== undefined) {
    const range = record(item.source_range);
    const from = optionalString(range?.from);
    const to = optionalString(range?.to);
    if (!from || !to) return null;
    sourceRange = { from, to };
  }
  return { status, batch, source_range: sourceRange };
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
