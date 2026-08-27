/**
 * INV-APPROVAL-TIMEOUT-ORDERING — 承認待ちは agent 側フック timeout より**厳密に先に**切れる。
 *
 * ## なぜ P0 か
 * ActraDeck の承認ゲートは CC の PreToolUse / PermissionRequest フック応答を握り続けることで
 * 成立する。CC の契約 (公式 docs `hooks`) はこうである:
 *
 * > A timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call.
 * > The call continues through the normal permission flow, so don't count on a stalled hook
 * > to act as a gate.
 *
 * したがって **フック timeout が先に切れると、承認は「安全側 deny」ではなく「素通り」になる**。
 * 承認待ちとフック timeout はかつて別ファイルの別リテラル (30s と 35s) で、片方だけ編集すれば
 * 無言で fail-open へ反転した。ここではその順序と、導出が単一出所から来ていることを固定する。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APPROVAL_HOOK_MARGIN_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  MIN_APPROVAL_TIMEOUT_MS,
  clampApprovalTimeoutMs,
  effectiveApprovalTimeoutMs,
  hookTimeoutSecondsFor,
} from "../src/index.js";
// 走査正規化の単一出所 (sidecar の exclusivity / source-coupling metatest と共有・TDA-V9-2)。
import { stripComments } from "../../../apps/sidecar/test/util/strip-comments.js";

/** CC の `http` フック既定 timeout (秒)。docs に上限記載は無く、既定は安全に使えると分かっている値。 */
const CC_HTTP_HOOK_DEFAULT_TIMEOUT_SECONDS = 600;

describe("INV-APPROVAL-TIMEOUT-ORDERING", () => {
  it("導出フック timeout は承認待ちより厳密に長い (これが逆転すると deny でなく素通りになる)", () => {
    // 既定・境界・不正値・上限超過を含めて全数で順序を確認する。
    const candidates = [
      MIN_APPROVAL_TIMEOUT_MS,
      1_000,
      30_000,
      DEFAULT_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS + 60_000, // 上限超過 → clamp されるはず
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    for (const raw of candidates) {
      const effective = clampApprovalTimeoutMs(raw);
      const hookMs = hookTimeoutSecondsFor(raw) * 1000;
      expect(
        hookMs,
        `hook timeout must exceed approval wait for input ${String(raw)}`,
      ).toBeGreaterThan(effective);
      // 余裕が margin 未満へ痩せていないこと (切り上げは常に安全方向)。
      expect(hookMs - effective, `margin for input ${String(raw)}`).toBeGreaterThanOrEqual(
        APPROVAL_HOOK_MARGIN_MS,
      );
    }
  });

  /**
   * SEC-V9-1 ≡ TDA-V9-1 ≡ QA-V9-2: フック timeout は **既定から静的に**導出されて settings に書かれる
   * (bridge の実効値を知らない)。よって順序は「bridge が実際に待つ値 ≤ 既定」でしか保てない。
   * 要求値が何であれ (省略 / 短縮 / 既定超過 / 上限超過 / 不正値) 実効値がフック timeout より
   * 厳密に短いことを固定する。以前は clamp 上限 570s > 導出フック 330s で、既定超過の要求値が
   * そのまま bridge に入り順序が反転した (base では ≥35s で反転・A の方が厳格だが閉じ切る)。
   */
  it("bridge の実効承認待ちは、要求値によらず静的導出フック timeout より厳密に短い (SEC-V9-1)", () => {
    const staticHookMs = hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS) * 1000;
    const requested = [
      undefined,
      MIN_APPROVAL_TIMEOUT_MS,
      50,
      30_000,
      DEFAULT_APPROVAL_TIMEOUT_MS,
      DEFAULT_APPROVAL_TIMEOUT_MS + 1,
      330_000, // = 静的フック timeout そのもの (base で反転していた最小域)
      MAX_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS + 60_000,
      10 * DEFAULT_APPROVAL_TIMEOUT_MS,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    for (const raw of requested) {
      const effective = effectiveApprovalTimeoutMs(raw);
      expect(effective, `effective for ${String(raw)}`).toBeLessThanOrEqual(
        DEFAULT_APPROVAL_TIMEOUT_MS,
      );
      expect(staticHookMs - effective, `margin for ${String(raw)}`).toBeGreaterThanOrEqual(
        APPROVAL_HOOK_MARGIN_MS,
      );
    }
    // 短縮方向はそのまま通る (テストが短い値を渡す経路)。省略は既定。
    expect(effectiveApprovalTimeoutMs(50)).toBe(50);
    expect(effectiveApprovalTimeoutMs(undefined)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(effectiveApprovalTimeoutMs(10 * DEFAULT_APPROVAL_TIMEOUT_MS)).toBe(
      DEFAULT_APPROVAL_TIMEOUT_MS,
    );
  });

  it("導出フック timeout は CC の http フック既定 600s を超えない (未検証域へ出さない)", () => {
    expect(hookTimeoutSecondsFor(MAX_APPROVAL_TIMEOUT_MS)).toBeLessThanOrEqual(
      CC_HTTP_HOOK_DEFAULT_TIMEOUT_SECONDS,
    );
    // 上限超過入力も clamp されるので同じ天井に収まる。
    expect(hookTimeoutSecondsFor(MAX_APPROVAL_TIMEOUT_MS * 10)).toBeLessThanOrEqual(
      CC_HTTP_HOOK_DEFAULT_TIMEOUT_SECONDS,
    );
  });

  it("clamp は安全側へ倒す (不正値は既定へ・上限超過は上限へ・無界化しない)", () => {
    expect(clampApprovalTimeoutMs(Number.NaN)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(0)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(-5)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    // Infinity は「無界待ち」の要求であり有限値の切詰めではない → 上限でなく**既定**へ倒す
    // (garbage 入力から上限近くの待ちを黙って与えない)。
    expect(clampApprovalTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(MAX_APPROVAL_TIMEOUT_MS + 1)).toBe(MAX_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(120_000)).toBe(120_000);
  });

  it("既定値の厳密 pin (変更は意図的にこのテストを更新することを強制する)", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(300_000);
    expect(APPROVAL_HOOK_MARGIN_MS).toBe(30_000);
    expect(hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS)).toBe(330);
  });

  /**
   * source-coupling: 消費側が正準出所を**実際に**引いていることを固定する。
   * 値の pin だけでは、消費側がリテラルへ戻る drift を検出できない (両方が偶然一致しうる)。
   */
  it("消費側は正準出所を import しており、手書きリテラルへ戻っていない", () => {
    // TDA-V9-2: コメントを落としてから照合する (正準呼び出し文字列をコメントに残した inline 化で
    // 偽 green にならない)。加えて import 行の存在を要求する (import を消しつつコメントに文字列を
    // 残す変種を閉じる)。出力値そのものの pin は sidecar 側 inv-approval-timeout-emit が担う。
    const read = (rel: string): string =>
      stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

    // attach (永続 settings.json merge) と managed (temp settings 注入) の **両方**を走査する。
    //   片方だけ導出に直すと、そのモードだけ順序が逆転して fail-open になる
    //   (実際 R1 の初回実装では managed 側の 2 本目リテラルが取り残されていた)。
    for (const rel of [
      "../../../apps/sidecar/src/settings-merge.ts",
      "../../../apps/sidecar/src/settings-injection.ts",
    ]) {
      const src = read(rel);
      // POSITIVE: 導出関数を通している (コメント除去後・import も実在)。
      expect(src, rel).toContain("hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS)");
      expect(src, rel).toMatch(
        /import \{[^}]*hookTimeoutSecondsFor[^}]*\} from "@actradeck\/event-model"/,
      );
      // NEGATIVE: 旧リテラル (35 秒) の三項へ戻っていない・導出値を数値リテラルで上書きしていない。
      expect(src, rel).not.toMatch(/\?\s*35\s*:/);
      expect(src, rel).not.toMatch(/\?\s*330\s*:/);
    }

    const bridge = read("../../../apps/sidecar/src/approval-bridge.ts");
    expect(bridge).toContain("effectiveApprovalTimeoutMs(opts.timeoutMs)");
    expect(bridge).toMatch(
      /import \{[^}]*effectiveApprovalTimeoutMs[^}]*\} from "@actradeck\/event-model"/,
    );
    expect(bridge).not.toContain("opts.timeoutMs ?? 30_000");
    expect(bridge).not.toContain("opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS"); // 既定超過を素通しした旧形

    const display = read("../../../apps/webui/src/ui/approval-display.ts");
    expect(display).toContain("timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS");
    expect(display).not.toContain("timeoutMs = 30_000");
  });
});
