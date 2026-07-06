"use client";

/**
 * ADR 019f22a7 P1: first-run セーフティデモの起動フック。
 *
 * cockpit の空状態 CTA から same-origin `/realtime/demo/safety` へ **POST** し、返った使い捨て
 * `demo-safety-<short>` セッション id を掴む。**token はブラウザに載せない** — BFF (custom server) が
 * server-side で Bearer を付与し、backend の mutating-class ゲート (POST-only + same-origin CSRF) を通す
 * (use-daemons / use-policy-admin と同方針)。fetch の same-origin リクエストにはブラウザが自動で
 * `Sec-Fetch-Site: same-origin` を付けるため、追加の CSRF ヘッダは不要。
 *
 * 二度押し / 実行中は再 spawn しない (phase gate)。backend は多重起動を 1 本へ抑止し `already_running`
 * のとき現行 session_id を返す (idempotent) ため、いずれにせよ掴む id は 1 つに収束する。
 *
 * NO-RAW: 応答から取り出すのは `demo-safety-` prefix の session_id のみ (それ以外は破棄)。失敗理由の
 * 生値は保持せず phase="error" のみを立て、UI は固定リテラル文言を描画する (生値エコーしない)。
 *
 * TDA-2 出現 watchdog: POST は session_id を先に返すが、子プロセスが ENOENT / 誤ポートで ingestion へ
 * 接続失敗すると session は live 一覧へ**永遠に出ない**。この負経路で UI が phase="running"（「実行中…」）の
 * まま固着し reload を強いられるのを防ぐため、running 遷移後に出現 watchdog を張る。一定時間内に対象 demo
 * session が live 一覧へ出現しなければ phase="error" へ縮退し CTA を再活性化する (再試行可能にする)。
 */
import { useCallback, useEffect, useRef, useState } from "react";

const DEMO_PATH = "/realtime/demo/safety";
/**
 * 使い捨てデモ session_id の prefix (backend safety-demo-script.ts の正典と一致)。
 * browser bundle を汚さないため値はローカル定数だが、backend 正典との**等価性は契約テスト**
 * (safety-demo-prefix-contract.test.ts) が両方 import して pin する (TDA-4・drift ガード)。
 */
export const SAFETY_DEMO_SESSION_PREFIX = "demo-safety-";

/**
 * 出現 watchdog のタイムアウト (ms)。POST 応答 (session_id 返却) から live 一覧出現までは、ingestion への
 * 子接続 + hello ハンドシェイク + delta.list 伝播を要する。健全系はふつう数秒で出るため、その実測余裕を見つつ
 * 30 秒デモの半分・体感待ちの上限として 15s に張る。これを超えて出現しなければ子起動失敗 (ENOENT / 誤ポート等)
 * と判断し error へ縮退する (session_id は既に返っているが live には出ないケース)。
 */
export const SAFETY_DEMO_APPEARANCE_WATCHDOG_MS = 15_000;

/** 起動フェーズ: 未起動 / 起動要求送信中 / 起動済み (session 掴んだ) / 失敗。 */
export type SafetyDemoPhase = "idle" | "launching" | "running" | "error";

export interface UseSafetyDemoOptions {
  /**
   * 現在 live 一覧に出ている session_id 群 (CockpitBoard が useRealtime から渡す)。launch した demo session
   * がこの中に現れたら出現 watchdog を解除する (nav 自体は CockpitBoard の別 effect が担う)。既定は空配列
   * (= 出現しない → running 後 watchdog がタイムアウトして error)。
   */
  readonly liveSessionIds?: readonly string[];
}

export interface SafetyDemoState {
  readonly phase: SafetyDemoPhase;
  /** 起動したデモ session_id (未起動は null)。CockpitBoard が一覧出現で focus する材料。 */
  readonly sessionId: string | null;
  /** デモを起動する (二度押し / 実行中は no-op)。 */
  readonly launch: () => void;
}

/** 応答 `{ session_id, already_running? }` から `demo-safety-` 形の id のみ抽出する (NO-RAW)。 */
export function parseDemoLaunch(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as { session_id?: unknown }).session_id;
  if (typeof id !== "string") return null;
  return id.startsWith(SAFETY_DEMO_SESSION_PREFIX) ? id : null;
}

export function useSafetyDemo(options?: UseSafetyDemoOptions): SafetyDemoState {
  const liveSessionIds = options?.liveSessionIds ?? [];
  const [phase, setPhase] = useState<SafetyDemoPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  // 一度でも live 一覧に出たら watchdog を恒久解除する。出現後に session が完了して live から
  // 落ちても (showHistory 切替等) error へ誤遷移させないための latch。
  const appearedRef = useRef(false);

  const launch = useCallback(() => {
    // 二度押し / 実行中は再 spawn しない (phase を dep に取り最新値で判定)。
    if (phase === "launching" || phase === "running") return;
    appearedRef.current = false; // 再試行のたびに watchdog を張り直す。
    setPhase("launching");
    void fetch(DEMO_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`safety demo ${res.status}`);
        return (await res.json()) as unknown;
      })
      .then((data) => {
        const id = parseDemoLaunch(data);
        if (id === null) throw new Error("safety demo: no session id");
        setSessionId(id);
        setPhase("running");
      })
      .catch(() => {
        // 失敗理由の生値は保持しない (固定リテラルを UI が描画)。再起動を許すため idle でなく error 表示。
        setPhase("error");
      });
  }, [phase]);

  // TDA-2 出現 watchdog: running (POST 成功) 後、対象 demo session が live 一覧に出現するのを待つ。
  //  - 出現した (appeared): latch を立てて watchdog を解除 (nav は CockpitBoard 側)。
  //  - 一度出現済み (appearedRef): 完了で live から落ちても再監視しない。
  //  - 未出現のまま: SAFETY_DEMO_APPEARANCE_WATCHDOG_MS で error へ縮退し CTA を再活性化。
  // phase 離脱 / 出現 / unmount で必ず clearTimeout (リーク無し・二重発火無し)。
  const appeared = sessionId !== null && liveSessionIds.includes(sessionId);
  useEffect(() => {
    if (phase !== "running") return;
    if (appeared) {
      appearedRef.current = true;
      return;
    }
    if (appearedRef.current) return;
    const timer = setTimeout(() => setPhase("error"), SAFETY_DEMO_APPEARANCE_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [phase, appeared]);

  return { phase, sessionId, launch };
}
