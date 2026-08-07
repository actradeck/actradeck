/**
 * INV-APPROVAL-RECONCILE-WIRE (TDA-2/SEC-6/TDA-9・Phase 4 監査 R2):
 * hello 宣言 (runtime_epoch / active_pending_request_ids) の wire 構築 + 受信検証の正準実装。
 * 送信 (sidecar ws-client) と受信 (backend SidecarRegistry) がこのモジュールを共有し、
 * field 名・cap の手書きミラー drift (silent-off) を構造遮断する。
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVE_PENDING_FIELD,
  buildApprovalReconcileHelloFields,
  MAX_ACTIVE_PENDING_IDS,
  MAX_REQUEST_ID_LEN,
  mintApprovalRequestId,
  parseActivePendingRequestIds,
  parseRuntimeEpoch,
  RUNTIME_EPOCH_FIELD,
} from "../src/index.js";

const EPOCH = "0199f0a1-2b3c-7d4e-8f01-23456789abcd";

/** 正準 RE 準拠のテスト id (SEC-R4-8: parser は APPROVAL_REQUEST_ID_RE を要求する)。 */
const tid = (n: number): string => `s${"0".repeat(12)}:apr-${n.toString(16).padStart(32, "0")}`;

describe("parseActivePendingRequestIds (受信検証・fail-safe)", () => {
  it("有効な宣言は Set へ (空配列は空 Set = 正当な pending ゼロ宣言・undefined と区別)", () => {
    expect([...parseActivePendingRequestIds([tid(1), tid(2)])!].sort()).toEqual(
      [tid(1), tid(2)].sort(),
    );
    const empty = parseActivePendingRequestIds([]);
    expect(empty).toBeInstanceOf(Set);
    expect(empty!.size).toBe(0);
  });

  it("欠落 / 非配列 / 非 string 要素 / 空文字 / 長さ超過 / 件数超過 → undefined (reconcile しない)", () => {
    expect(parseActivePendingRequestIds(undefined)).toBeUndefined();
    expect(parseActivePendingRequestIds("not-array")).toBeUndefined();
    expect(parseActivePendingRequestIds([42])).toBeUndefined();
    expect(parseActivePendingRequestIds([""])).toBeUndefined();
    expect(parseActivePendingRequestIds(["x".repeat(MAX_REQUEST_ID_LEN + 1)])).toBeUndefined();
    expect(
      parseActivePendingRequestIds(Array.from({ length: MAX_ACTIVE_PENDING_IDS + 1 }, () => "r")),
    ).toBeUndefined();
    // 境界: 上限ちょうど (正準形 id) は有効。
    expect(
      parseActivePendingRequestIds(
        Array.from({ length: MAX_ACTIVE_PENDING_IDS }, (_, i) => tid(i)),
      ),
    ).toBeInstanceOf(Set);
  });

  it("SEC-R4-8: 正準 APPROVAL_REQUEST_ID_RE 非適合が 1 件でもあれば宣言ごと undefined", () => {
    // 旧 R2 形 (base64url token)・raw session prefix 形・任意文字列 — いずれも宣言単位で拒否
    // (id 単位で落とすと当該 pending が「宣言に無い」扱いで合成 cancel される fail-unsafe)。
    expect(parseActivePendingRequestIds(["s1:apr-F9aSKs-LnHcbygXAZ16NLQ"])).toBeUndefined();
    expect(parseActivePendingRequestIds(["sess_0199-x:apr-1"])).toBeUndefined();
    expect(parseActivePendingRequestIds([tid(1), "not-canonical"])).toBeUndefined();
    // 実 mint 産は当然通る (送受対称性)。
    const minted = mintApprovalRequestId("sess_wire_re_gate");
    expect([...parseActivePendingRequestIds([minted])!]).toEqual([minted]);
  });
});

describe("parseRuntimeEpoch (SEC-6: uuid shape gate)", () => {
  it("uuid shape のみ受理・それ以外は undefined (任意文字列を conn メタに持ち込まない)", () => {
    expect(parseRuntimeEpoch(EPOCH)).toBe(EPOCH);
    expect(parseRuntimeEpoch(EPOCH.toUpperCase())).toBe(EPOCH.toUpperCase());
    expect(parseRuntimeEpoch("epoch-1")).toBeUndefined();
    expect(parseRuntimeEpoch("x".repeat(64))).toBeUndefined();
    expect(parseRuntimeEpoch(42)).toBeUndefined();
    expect(parseRuntimeEpoch(undefined)).toBeUndefined();
  });
});

describe("buildApprovalReconcileHelloFields (送信・受信と対称の fail-safe)", () => {
  it("ids undefined (provider 未配線 / bridge 未生成) → field 省略 (TDA-8)", () => {
    expect(buildApprovalReconcileHelloFields(undefined, undefined)).toEqual({});
    expect(ACTIVE_PENDING_FIELD in buildApprovalReconcileHelloFields(EPOCH, undefined)).toBe(false);
  });

  it("空配列は載せる (pending ゼロ宣言)・cap 超過は切り詰めでなく省略 (TDA-9)", () => {
    expect(buildApprovalReconcileHelloFields(undefined, [])).toEqual({
      [ACTIVE_PENDING_FIELD]: [],
    });
    const over = Array.from({ length: MAX_ACTIVE_PENDING_IDS + 1 }, (_, i) => `r${i}`);
    expect(ACTIVE_PENDING_FIELD in buildApprovalReconcileHelloFields(undefined, over)).toBe(false);
  });

  it("epoch は uuid のときのみ載せる (受信 gate と対称)", () => {
    expect(buildApprovalReconcileHelloFields(EPOCH, undefined)).toEqual({
      [RUNTIME_EPOCH_FIELD]: EPOCH,
    });
    expect(buildApprovalReconcileHelloFields("epoch-1", undefined)).toEqual({});
  });

  it("round-trip: build した field を parse すると同一集合へ戻る (送受対称性)", () => {
    const ids = [mintApprovalRequestId("s1"), mintApprovalRequestId("s2")];
    const fields = buildApprovalReconcileHelloFields(EPOCH, ids);
    const parsed = parseActivePendingRequestIds(fields[ACTIVE_PENDING_FIELD]);
    expect([...parsed!].sort()).toEqual([...ids].sort());
    expect(parseRuntimeEpoch(fields[RUNTIME_EPOCH_FIELD])).toBe(EPOCH);
  });
});
