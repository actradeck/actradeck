/**
 * 受信 WS フレーム (string) を型安全に `ServerFrame` へパースする境界バリデータ.
 *
 * ワイヤから来る JSON は信頼しない (壊れた/敵対的フレームで UI を壊さない)。
 * discriminated union の `type` と必須フィールドの存在のみを検証し、未知/不正は `null` を返す。
 * ここでは payload の中身 (redaction 済みか等) は backend が保証する契約に委ね、
 * UI は **構造の妥当性だけ**を確認する (過剰検証で T1 とドリフトさせない)。
 */
import type { ServerFrame, SessionListItem, SessionDetail } from "./contract";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * SessionListItem の最小構造検証 (必須キーの型のみ; 詳細は T1 が保証)。
 *
 * ⚠️ LIVE-FOUND-3 (ADR 019e98fc) の教訓: ここに **新フィールドを必須化しない**。
 * `connected`(presence, ADR 019ea2bf) は backend が充填する必須型だが、rollout 差や被せ漏れで
 * 欠落しても snapshot.list 全黙殺を起こさないよう、validator は connected を **検証しない**
 * (欠落許容)。値の正規化 (欠落→表示寄り true) は normalizeConnected で行う。
 */
function isListItem(v: unknown): v is SessionListItem {
  if (!isRecord(v)) return false;
  return (
    typeof v["session_id"] === "string" &&
    typeof v["provider"] === "string" &&
    typeof v["source"] === "string" &&
    typeof v["needs_attention"] === "boolean" &&
    typeof v["liveness_state"] === "string" &&
    typeof v["stalled_suspected"] === "boolean"
  );
}

/**
 * `connected`(接続在席, ADR 019ea2bf)を正規化する。boolean ならその値、欠落/非 boolean は
 * **true(表示寄り)** に倒す: 証拠なしに「起動中の CC を消す」副作用を避ける(purgeStale と同方針)。
 * 返り値は connected が必ず boolean な型整合オブジェクト(T1 の必須性を境界で担保)。
 */
function normalizeConnected<T extends SessionListItem>(v: T): T {
  const raw = (v as unknown as Record<string, unknown>)["connected"];
  return { ...v, connected: typeof raw === "boolean" ? raw : true };
}

/**
 * pending_approvals の最小構造検証 (ADR 019e9999 段階②)。
 * UI が承認カードを描き request_id を approve frame の突合キーにするため、
 * **配列であること + 各要素が request_id:string を持つこと** だけを確認する。
 * tool_name/command/path/risk_level は backend が redaction 済みで載せる optional であり
 * (reducer.ts 正典)、過剰検証で T1 とドリフトさせない (既存 isListItem/isDetail と同方針)。
 */
function isPendingApprovals(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.every((e) => isRecord(e) && typeof e["request_id"] === "string");
}

/** SessionDetail は ListItem を拡張する。追加必須キーの存在を確認。 */
function isDetail(v: unknown): v is SessionDetail {
  if (!isListItem(v)) return false;
  const r = v as unknown as Record<string, unknown>;
  return (
    isRecord(r["liveness_evidence"]) &&
    typeof r["liveness_reason"] === "string" &&
    typeof r["liveness_evaluated_at_ms"] === "number" &&
    typeof r["invalid_transition_count"] === "number" &&
    isPendingApprovals(r["pending_approvals"])
  );
}

/**
 * 1 つの受信文字列を `ServerFrame` へ。壊れた JSON / 未知 type / 構造不正は `null`。
 * 呼び元 (RealtimeClient) は null を黙って捨て、接続は維持する。
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json) || typeof json["type"] !== "string") return null;

  switch (json["type"]) {
    case "snapshot.list": {
      const sessions = json["sessions"];
      if (!Array.isArray(sessions) || !sessions.every(isListItem)) return null;
      return { type: "snapshot.list", sessions: sessions.map(normalizeConnected) };
    }
    case "delta.list": {
      if (!isListItem(json["session"])) return null;
      return { type: "delta.list", session: normalizeConnected(json["session"]) };
    }
    case "snapshot.detail": {
      if (typeof json["session_id"] !== "string" || !isDetail(json["detail"])) return null;
      return {
        type: "snapshot.detail",
        session_id: json["session_id"],
        detail: normalizeConnected(json["detail"]),
      };
    }
    case "delta.detail": {
      if (typeof json["session_id"] !== "string" || !isDetail(json["detail"])) return null;
      return {
        type: "delta.detail",
        session_id: json["session_id"],
        detail: normalizeConnected(json["detail"]),
      };
    }
    case "ack": {
      const action = json["action"];
      if (
        action !== "subscribe" &&
        action !== "unsubscribe" &&
        action !== "approve" &&
        action !== "interrupt"
      ) {
        return null;
      }
      if (typeof json["ok"] !== "boolean") return null;
      const ack: Extract<ServerFrame, { type: "ack" }> = {
        type: "ack",
        action,
        ok: json["ok"],
        ...(typeof json["session_id"] === "string" ? { session_id: json["session_id"] } : {}),
        ...(typeof json["request_id"] === "string" ? { request_id: json["request_id"] } : {}),
        ...(typeof json["error"] === "string" ? { error: json["error"] } : {}),
      };
      return ack;
    }
    default:
      return null;
  }
}
