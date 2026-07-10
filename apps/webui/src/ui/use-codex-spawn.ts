"use client";

/**
 * ADR 019f4206 A段: cockpit からの Codex Managed spawn フック。
 *
 * spawn 可能な attach デーモン (`/realtime/daemons` の spawn_capable) 宛に、same-origin
 * `/realtime/daemons/:daemonId/codex/spawn` へ **POST** し in-process の managed codex を起動する。
 * **token はブラウザに載せない** — BFF (custom server) が server-side で Bearer を付与し、backend の
 * mutating-class ゲート (POST-only + same-origin CSRF・isCodexSpawnPath) を通す (use-safety-demo と同方針)。
 * fetch の same-origin リクエストはブラウザが `Sec-Fetch-Site: same-origin` を自動付与するため追加ヘッダ不要。
 *
 * NO-RAW: prompt / cwd は POST body の transient — 応答 (ok / closed enum error code / optional session_id)
 * のみを保持し、失敗理由の生値は持たない。UI は closed enum code に 1:1 の固定リテラル文言を描画する
 * (backend/daemon が prompt/cwd を echo しない契約と対称)。
 *
 * 二度押し / 送信中は再送しない (phase gate)。
 */
import { useCallback, useState } from "react";

import type { CodexSpawnErrorCode } from "@actradeck/event-model";

/** spawn フェーズ: 未起動 / 送信中 / 起動済み / 失敗。 */
export type CodexSpawnPhase = "idle" | "spawning" | "ok" | "error";

/** 既知の closed enum error code 集合 (未知は generic へ縮退・NO-RAW: 生 error 文字列を UI に出さない)。 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<CodexSpawnErrorCode>([
  "invalid_request",
  "cwd_out_of_scope",
  "spawn_disabled",
  "spawn_cap_reached",
  "spawn_failed",
]);

/** 応答/HTTP 状態から UI の error code を導く (未知/欠落は "generic")。 */
export function toSpawnErrorKey(raw: unknown): CodexSpawnErrorCode | "generic" {
  if (typeof raw !== "object" || raw === null) return "generic";
  const err = (raw as { error?: unknown }).error;
  return typeof err === "string" && KNOWN_ERROR_CODES.has(err)
    ? (err as CodexSpawnErrorCode)
    : "generic";
}

export interface CodexSpawnState {
  readonly phase: CodexSpawnPhase;
  /** 失敗時の closed enum key ("generic" 含む)。UI が固定リテラル文言へ 1:1 で写像する (生値非保持)。 */
  readonly errorKey: CodexSpawnErrorCode | "generic" | null;
  /** spawn を送信する (二度押し / 送信中は no-op)。prompt/cwd/daemonId は呼び元が渡す。 */
  readonly spawn: (args: { daemonId: string; prompt: string; cwd: string }) => void;
  /** フォーム編集時に error/ok 表示をクリアする。 */
  readonly reset: () => void;
}

export function useCodexSpawn(): CodexSpawnState {
  const [phase, setPhase] = useState<CodexSpawnPhase>("idle");
  const [errorKey, setErrorKey] = useState<CodexSpawnErrorCode | "generic" | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setErrorKey(null);
  }, []);

  const spawn = useCallback(
    (args: { daemonId: string; prompt: string; cwd: string }) => {
      // 二度押し / 送信中は再送しない (最新 phase を setter 関数内で判定できないため state を dep に取る)。
      if (phase === "spawning") return;
      setPhase("spawning");
      setErrorKey(null);
      const path = `/realtime/daemons/${encodeURIComponent(args.daemonId)}/codex/spawn`;
      void fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        // prompt/cwd は transient (BFF が Bearer 付与・cross-site は CSRF ゲートで拒否)。
        body: JSON.stringify({ prompt: args.prompt, cwd: args.cwd }),
      })
        .then(async (res) => {
          if (res.ok) {
            setPhase("ok");
            return;
          }
          // 失敗: 応答 body の closed enum error を UI key へ (生値は保持しない・NO-RAW)。
          let body: unknown = null;
          try {
            body = await res.json();
          } catch {
            /* 非 JSON は generic 扱い。 */
          }
          setErrorKey(toSpawnErrorKey(body));
          setPhase("error");
        })
        .catch(() => {
          // ネットワーク断等 → generic (原文非依存)。
          setErrorKey("generic");
          setPhase("error");
        });
    },
    [phase],
  );

  return { phase, errorKey, spawn, reset };
}
