"use client";

/**
 * 段階2 (ADR 019ea4ba D2): diff 本文 / stdout 本文を **オンデマンドで pull** するフック.
 *
 * 設計 (秘匿センシティブ・帯域非依存):
 *  - 本文は常時 push せず、UI の **明示操作時のみ** fetch する (タイムライン行展開 / 右ペイン
 *    「diff 表示」/ 中央ペイン「出力表示」)。push 抑止 + pull-on-demand は ADR の保守的選択。
 *  - fetch 先は same-origin の BFF proxy 経由 (REALTIME_TOKEN は server-side でのみ付与・
 *    browser へは渡さない: BFF token-no-leak)。本フックは token を一切扱わない。
 *  - 応答 body はすべて backend/sidecar で redaction 済み。再取得・再構成しない (生本文経路を作らない)。
 *  - session/対象が変わるたび世代ゲートで stale 応答を捨てる。
 */
import { useCallback, useRef, useState } from "react";

import {
  parseDiffBody,
  parseOutputBody,
  type DiffBody,
  type OutputBody,
} from "../replay/parse-body";

export interface UseSessionBodyResult {
  readonly diff: DiffBody | undefined;
  readonly diffLoading: boolean;
  readonly diffError: string | undefined;
  /** git 全体 diff 本文を pull する (明示操作)。 */
  readonly loadDiff: () => void;

  readonly output: OutputBody | undefined;
  readonly outputLoading: boolean;
  readonly outputError: string | undefined;
  /** 指定 command イベントの stdout tail を pull する (行展開等の明示操作)。 */
  readonly loadOutput: (eventId: string) => void;

  /** 取得済み本文を破棄する (session 切替時に呼ぶ・秘匿本文をメモリに残さない)。 */
  readonly clear: () => void;
}

export function useSessionBody(sessionId: string | null): UseSessionBodyResult {
  const [diff, setDiff] = useState<DiffBody | undefined>(undefined);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | undefined>(undefined);
  const [output, setOutput] = useState<OutputBody | undefined>(undefined);
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputError, setOutputError] = useState<string | undefined>(undefined);
  // 世代ゲート: session/対象が変わったら旧 fetch の応答を捨てる。
  const diffGen = useRef(0);
  const outputGen = useRef(0);

  const loadDiff = useCallback(() => {
    if (!sessionId) return;
    const gen = ++diffGen.current;
    setDiffLoading(true);
    setDiffError(undefined);
    void (async () => {
      try {
        const res = await fetch(`/realtime/sessions/${encodeURIComponent(sessionId)}/diff`);
        if (gen !== diffGen.current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseDiffBody(await res.json());
        if (gen !== diffGen.current) return;
        if (!parsed) throw new Error("invalid diff response");
        setDiff(parsed);
      } catch (err) {
        if (gen === diffGen.current) {
          setDiffError((err as Error).message);
          setDiff(undefined);
        }
      } finally {
        if (gen === diffGen.current) setDiffLoading(false);
      }
    })();
  }, [sessionId]);

  const loadOutput = useCallback(
    (eventId: string) => {
      if (!sessionId) return;
      const gen = ++outputGen.current;
      setOutputLoading(true);
      setOutputError(undefined);
      void (async () => {
        try {
          const res = await fetch(
            `/realtime/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(
              eventId,
            )}/output`,
          );
          if (gen !== outputGen.current) return;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const parsed = parseOutputBody(await res.json());
          if (gen !== outputGen.current) return;
          if (!parsed) throw new Error("invalid output response");
          setOutput(parsed);
        } catch (err) {
          if (gen === outputGen.current) {
            setOutputError((err as Error).message);
            setOutput(undefined);
          }
        } finally {
          if (gen === outputGen.current) setOutputLoading(false);
        }
      })();
    },
    [sessionId],
  );

  const clear = useCallback(() => {
    // 世代を進めて in-flight 応答を無効化し、保持本文を破棄する。
    diffGen.current++;
    outputGen.current++;
    setDiff(undefined);
    setDiffError(undefined);
    setDiffLoading(false);
    setOutput(undefined);
    setOutputError(undefined);
    setOutputLoading(false);
  }, []);

  return {
    diff,
    diffLoading,
    diffError,
    loadDiff,
    output,
    outputLoading,
    outputError,
    loadOutput,
    clear,
  };
}
