/**
 * @actradeck/redaction 単体テスト (INV-REDACTION の redactor 内部網羅性)。
 *
 * redactString / redactDeep のルール網羅・マーカー計数 (countRedactionMarkers*) ・
 * ReDoS 性能 (best-of-N scaling) を検証する。sink choke (emit→persist→send) レベルの
 * INV-REDACTION 統合テストは apps/sidecar/test/inv-redaction.test.ts に残す
 * (sink の契約であって redactor 内部でないため・ADR 019f2d2c D3)。
 */
import { describe, expect, it } from "vitest";

import {
  REDACTION_KINDS,
  REDACTION_KINDS_SET,
  REDACTION_MARKER_PATTERN,
  REDACTION_MARKER_KIND_PATTERN,
} from "@actradeck/event-model";

import {
  countRedactionMarkers,
  countRedactionMarkersByKind,
  countRedactionMarkersByKindDeep,
  countRedactionMarkersDeep,
  KNOWN_REDACTION_KINDS,
  redactDeep,
  redactDeepWithCount,
  REDACTION_MARKER_KIND_RE,
  REDACTION_MARKER_RE,
  REDACTION_RULES,
  redactString,
} from "@actradeck/redaction";

/** 各種 secret の代表サンプル (擬似値・実鍵ではない)。 */
const SECRETS: Array<{ kind: string; sample: string; leak: string }> = [
  {
    kind: "private-key",
    sample:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc123def456\n-----END RSA PRIVATE KEY-----",
    leak: "MIIEowIBAAKCAQEAabc123def456",
  },
  { kind: "aws", sample: "AKIAIOSFODNN7EXAMPLE", leak: "AKIAIOSFODNN7EXAMPLE" },
  {
    kind: "github",
    sample: "ghp_1234567890abcdefABCDEF1234567890abcd",
    leak: "ghp_1234567890abcdefABCDEF1234567890abcd",
  },
  {
    kind: "anthropic",
    sample: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
    leak: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
  },
  {
    kind: "google",
    // 実 Google API key は AIza + 35 文字 = 39 文字。
    sample: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    leak: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  },
  {
    kind: "slack",
    sample: "xoxb-12345678901-abcdefghijklmno",
    leak: "xoxb-12345678901-abcdefghijklmno",
  },
  {
    kind: "stripe",
    sample: "sk_live_1234567890abcdefABCDEFgh",
    leak: "sk_live_1234567890abcdefABCDEFgh",
  },
  {
    kind: "jwt",
    sample:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    leak: "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  },
  {
    kind: "bearer",
    sample: "Authorization: Bearer abcdef1234567890XYZ",
    leak: "abcdef1234567890XYZ",
  },
  {
    kind: "url-credential",
    sample: "postgres://app:s3cretP4ss@db.internal:5432/x",
    leak: "s3cretP4ss",
  },
  {
    kind: "env-assignment",
    sample: "API_KEY=supersecretvalue123",
    leak: "supersecretvalue123",
  },
  {
    kind: "json-secret",
    sample: '{"client_secret": "abcdef987654321zzz"}',
    leak: "abcdef987654321zzz",
  },
  // --- SEC-1 監査所見: 修正前は redactor が素通ししていた 10 ケース --------------
  {
    // standalone AWS secret access key (40 字 base64, ラベルなし高エントロピー)。
    kind: "aws-secret-standalone",
    sample: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    leak: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  {
    // DB_PASSWORD=... — 旧 \b + _ 境界で固定 alternation 外だった。
    kind: "db-password-env",
    sample: "DB_PASSWORD=Sup3rSecretDbPass",
    leak: "Sup3rSecretDbPass",
  },
  {
    // AWS_SECRET_ACCESS_KEY=... — secret_access_key が固定 alternation 外だった。
    kind: "aws-secret-access-key-env",
    sample: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    leak: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  {
    // npm _authToken (.npmrc) — 旧ルールでは未捕捉。
    kind: "npm-auth-token",
    sample: "//registry.npmjs.org/:_authToken=npm_abcdef0123456789ABCDEF0123456789abcd",
    leak: "npm_abcdef0123456789ABCDEF0123456789abcd",
  },
  {
    // Cookie: ヘッダ。
    kind: "cookie-header",
    sample: "Cookie: session=abc123def456ghi789xyz",
    leak: "abc123def456ghi789xyz",
  },
  {
    // Set-Cookie: ヘッダ (属性 Path=/ は温存、値のみマスク)。
    kind: "set-cookie-header",
    sample: "Set-Cookie: auth=tok_9f8e7d6c5b4a3210zzzz; Path=/",
    leak: "tok_9f8e7d6c5b4a3210zzzz",
  },
  {
    // Authorization: Basic <base64>。
    kind: "basic-auth",
    sample: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    leak: "dXNlcjpwYXNzd29yZA==",
  },
  {
    // 引用符付き + スペースを含む値 (閉じ引用符までマスク)。
    kind: "quoted-value-with-space",
    sample: '{"api_key":"key with space inside"}',
    leak: "key with space inside",
  },
  {
    // 再#SEC-1: シングルクォート値 (double/single でルールを分割した両系統を網羅)。
    kind: "single-quoted-value",
    sample: "token: 'sq with space inside'",
    leak: "sq with space inside",
  },
  {
    // 6 字未満の値 ({6,} 下限撤廃)。
    kind: "short-value",
    sample: "password=abc12",
    leak: "abc12",
  },
  {
    // scheme なし bare user:pass@host。
    kind: "bare-user-pass",
    sample: "user:s3cretpass@host.internal",
    leak: "s3cretpass",
  },
  // --- 再#SEC-4: URL 埋込 webhook secret -----------------------------------
  {
    kind: "slack-webhook",
    sample: "https://hooks.slack.com/services/T01ABCD2EFG/B09HIJK3LMN/aBcDeFgHiJkLmNoPqRsTuVwX",
    leak: "aBcDeFgHiJkLmNoPqRsTuVwX",
  },
  {
    kind: "discord-webhook",
    sample:
      "https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-AbCd",
    leak: "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-AbCd",
  },
  // --- 3#SEC-3: 追加 vendor token (glpat- / SG. / Sentry DSN) ----------------
  {
    kind: "gitlab-token",
    sample: "GITLAB_TOKEN=glpat-ABCDEF1234567890wxyz",
    leak: "glpat-ABCDEF1234567890wxyz",
  },
  {
    kind: "sendgrid-key",
    sample: "SG.aBcDeFgHiJkLmNoPqRsTuv.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab",
    leak: "SG.aBcDeFgHiJkLmNoPqRsTuv.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab",
  },
  {
    kind: "sentry-dsn",
    sample: "SENTRY_DSN=https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/4567",
    leak: "0123456789abcdef0123456789abcdef",
  },
  // --- 再#5 SEC-1: 非 Bearer Authorization scheme (任意 scheme の値が残留していた) -----
  {
    // Authorization: ApiKey <secret> — scheme 語のみマスクされ secret が残留していた。
    kind: "auth-apikey-header",
    sample: "Authorization: ApiKey live_9f8e7d6c5b4a32100011223344556677",
    leak: "live_9f8e7d6c5b4a32100011223344556677",
  },
  {
    // WWW-Authenticate: Negotiate <token>。
    kind: "www-authenticate-negotiate",
    sample: "WWW-Authenticate: Negotiate YIIZ1234567890abcdefNEGOTIATETOKEN",
    leak: "YIIZ1234567890abcdefNEGOTIATETOKEN",
  },
  {
    // Proxy-Authorization: NTLM <token>。
    kind: "proxy-authorization-ntlm",
    sample: "Proxy-Authorization: NTLM TlRMTVNTUAABNTLMplaintexttoken",
    leak: "TlRMTVNTUAABNTLMplaintexttoken",
  },
  // --- 再#5 SEC-2: cloud 接続文字列 (AccountKey / Azure 接続文字列) -----------------
  {
    // AccountKey=<44 字 base64> (旧: keyword 外 + {40} 限定で残留)。
    kind: "azure-accountkey-44",
    sample: "AccountKey=DKRYfmt07CJQXelsz6BIPWdkry5AHOVcjqx4/GNUbipw",
    leak: "DKRYfmt07CJQXelsz6BIPWdkry5AHOVcjqx4/GNUbipw",
  },
  {
    // AccountKey=<72 字 base64>。
    kind: "azure-accountkey-72",
    sample: "AccountKey=DKRYfmt07CJQXelsz6BIPWdkry5AHOVcjqx4/GNUbipw3+FMTahov29ELSZgnu18DKRYfmt0",
    leak: "DKRYfmt07CJQXelsz6BIPWdkry5AHOVcjqx4/GNUbipw3+FMTahov29ELSZgnu18DKRYfmt0",
  },
];

describe("INV-REDACTION: redactString 網羅性", () => {
  for (const { kind, sample, leak } of SECRETS) {
    it(`masks ${kind}`, () => {
      const out = redactString(sample);
      expect(out, `${kind} leaked secret value`).not.toContain(leak);
      expect(out).toContain("[REDACTED:");
    });
  }

  it("preserves non-secret text", () => {
    const out = redactString("running npm test in /repo, 3 files changed");
    expect(out).toBe("running npm test in /repo, 3 files changed");
  });

  it("handles empty input", () => {
    expect(redactString("")).toBe("");
  });

  it("all rules use global flag (no partial-match state bug)", () => {
    for (const r of REDACTION_RULES) {
      expect(r.pattern.flags).toContain("g");
    }
  });

  it("masks multiple secrets in one string", () => {
    const s = "AKIAIOSFODNN7EXAMPLE and ghp_1234567890abcdefABCDEF1234567890abcd";
    const out = redactString(s);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcd");
  });

  it("is idempotent on repeated application", () => {
    const once = redactString("API_KEY=supersecretvalue123");
    const twice = redactString(once);
    expect(twice).toBe(once);
  });
});

/**
 * INV-REDACTION-MARKER-ROUNDTRIP (TDA-3r): マーカー regex の文字クラスが正典語彙 (`[a-z0-9-]+`) と
 * 層をまたいで一致することを pin する。
 *
 * 正典側 (inv-redaction-kinds) は「全 kind ⊆ `[a-z0-9-]+`」を、本テストは「`[REDACTED:<kind>]` を
 * 計数する redactor 側 regex が同じ `[a-z0-9-]+` を**完全に捕捉**する」ことを pin し、両者の round-trip を
 * 閉じる。redactor の REDACTION_MARKER_RE が正典より狭い (`[a-z-]+`) と、digit を含む将来 kind が
 * 追加された瞬間にマーカー計数が静かに崩れる (marker は残り redaction 自体は成立 = raw leak ではないが
 * count 過少 + by-kind 欠落)。正典 test は緑のままなので、この cross-layer pin が無いとドリフトが不可視。
 *
 * falsifiable: REDACTION_MARKER_RE / _KIND_RE を `[a-z-]+` に戻すと **digit-kind 合成ケース**が赤化する
 * (現 vocabulary に digit kind が無いため、正典ループだけでは regression を検出できない)。
 */
describe("INV-REDACTION-MARKER-ROUNDTRIP: marker regex charset == canonical [a-z0-9-]+ (TDA-3r)", () => {
  it("REDACTION_MARKER_RE / _KIND_RE は event-model の正典 source から派生する (charset 単一化 pin・TDA-2)", () => {
    // 各層が独自に charset を再ハードコードせず event-model の REDACTION_MARKER_PATTERN /
    // _KIND_PATTERN を共有することを pin。sidecar 側で別文字クラスを literal で書き直すと赤化し、
    // backend ALL_MARKERS_REGEX (= REDACTION_MARKER_PATTERN) との forward-drift を構造的に塞ぐ。
    expect(REDACTION_MARKER_RE.source).toBe(REDACTION_MARKER_PATTERN);
    expect(REDACTION_MARKER_RE.flags).toContain("g");
    expect(REDACTION_MARKER_KIND_RE.source).toBe(REDACTION_MARKER_KIND_PATTERN);
    expect(REDACTION_MARKER_KIND_RE.flags).toContain("g");
  });

  it("matches and captures every canonical kind via the public counters", () => {
    for (const kind of REDACTION_KINDS) {
      const marker = `[REDACTED:${kind}]`; // token(kind) と同一フォーマット

      // (1) スカラー regex がマーカー全体を完全一致で捕える (部分一致でない)。
      expect(marker.match(REDACTION_MARKER_RE), `${kind}: MARKER_RE no full match`).toEqual([
        marker,
      ]);

      // (2) kind 捕捉版が kind を**完全に**取り出す (charset が狭いと途中で切れる)。
      REDACTION_MARKER_KIND_RE.lastIndex = 0;
      const m = REDACTION_MARKER_KIND_RE.exec(marker);
      REDACTION_MARKER_KIND_RE.lastIndex = 0;
      expect(m?.[1], `${kind}: KIND_RE capture mismatch`).toBe(kind);

      // (3) 本番計数パスの round-trip (既知 kind なので by-kind も 1 件)。
      expect(countRedactionMarkers(marker)).toBe(1);
      expect(countRedactionMarkersByKind(marker)).toEqual({ [kind]: 1 });
    }
  });

  it("captures a digit-bearing kind (charset must include 0-9 — falsifiable regression pin)", () => {
    // 現 vocabulary に digit kind は無いため、charset に 0-9 が含まれることを合成マーカーで直接 pin する。
    // これが無いと regex を `[a-z-]+` に戻しても上のループ (digit 無し kind 群) は緑のまま素通りする。
    const marker = "[REDACTED:oauth2-token]";

    expect(marker.match(REDACTION_MARKER_RE)).toEqual([marker]);

    REDACTION_MARKER_KIND_RE.lastIndex = 0;
    const m = REDACTION_MARKER_KIND_RE.exec(marker);
    REDACTION_MARKER_KIND_RE.lastIndex = 0;
    expect(m?.[1]).toBe("oauth2-token"); // `[a-z-]+` だと "oauth" で切れて全体不一致 → null

    // スカラー計数も digit-kind マーカーを 1 件として数える。
    expect(countRedactionMarkers(marker)).toBe(1);
    // by-kind は allowlist (KNOWN_REDACTION_KINDS) gate ゆえ未知 "oauth2-token" を捨てる (SEC-2 不変)。
    expect(countRedactionMarkersByKind(marker)).toEqual({});
  });

  it("does not over-capture marker-shaped raw text with non-charset chars (boundary)", () => {
    // charset 外文字 (大文字 / 空白 / `:` 等) を含む偽マーカーは捕捉しない (raw 混入の温存)。
    REDACTION_MARKER_KIND_RE.lastIndex = 0;
    expect("[REDACTED:Github_Token]".match(REDACTION_MARKER_RE)).toBeNull(); // `_` と大文字
    expect("[REDACTED:has space]".match(REDACTION_MARKER_RE)).toBeNull();
    REDACTION_MARKER_KIND_RE.lastIndex = 0;
  });
});

// --- ReDoS scaling 共通基盤 (全ブロックをここに帰着させ basis ドリフトを防ぐ) ---
// NOTE (PR-1 TDA-2・意図的複製 = documented 受容): この redos 計測基盤 (redosMinOf/redosBestOfMs/
//   REDOS_TEST_TIMEOUT_MS/REDOS_BUDGET_REPEAT) は apps/sidecar/test/inv-redaction.test.ts の
//   同名ブロックと **verbatim 同期**している (REDOS_RATIO_MAX は scaling テストを持つ本ファイル固有)。
//   共通化しない理由: (a) 純粋 ~11 行の timing helper で、パッケージ境界を跨ぐ共有 test-utils 新設は
//   過剰 (過剰工作禁止)、(b) 両パッケージとも test/** は tsc 対象外 (tsconfig exclude) ゆえ型レベルの
//   単一出所化利得が無い、(c) cross-package の相対 test import はより脆く smell。redactor 移設時の
//   意図的複製 (decision 019f2d4f)。**編集時は両コピーを同期**。
// median は contention でスパイクするため使わず、best-of-N の **最小値 (min)** を取る:
// 計測ノイズは加法的ゆえ min が無競合の真の計算時間に最も近い (QA-10 / 再#5d flake の教訓)。
const redosMinOf = (xs: number[]): number => xs.reduce((a, b) => (b < a ? b : a), Infinity);
const redosBestOfMs = (run: () => void, repeat = 15): number => {
  run();
  run(); // warm-up ×2 (JIT/最適化のばらつきを除く)
  const samples: number[] = [];
  for (let i = 0; i < repeat; i++) {
    const t = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return redosMinOf(samples);
};
// 比率閾値: 線形≈2 / 二次≈4 の中間を二次側へ寄せた 3.5。再導入した O(n^2)(~4)は確実に赤、
// cross-file 並列 contention の benign スパイク(実測 3.1 台)は緑、を両立 (falsifiability 実証済)。
const REDOS_RATIO_MAX = 3.5;
// 重い timing test の明示 timeout (best-of-N × 大入力で default 5s を踏むため・wall-clock 保護)。
const REDOS_TEST_TIMEOUT_MS = 20_000;
// 絶対 budget テスト用の best-of-N 反復数。スケーリング比 (ratio 精度が要る→default 15) と違い、
// 絶対 budget は「min < 予算」を広いマージン (実測 85ms vs 500ms / 345ms vs 1500ms) で見るだけ
// なので、加法スパイク除去に十分な少数で足りる (256KB×17 runs ≈ 6s の浪費・timeout 圧迫を避ける)。
const REDOS_BUDGET_REPEAT = 7;

/**
 * 再#SEC-1: redaction の ReDoS 性能不変条件。
 *
 * 量指定子の入れ子 (否定先読み×反復 / 無界 prefix×alternation) があると入力長 n に対し
 * O(n^2) 以上の catastrophic backtracking を起こす。線形化されていれば 64KB/256KB の
 * adversarial / benign 入力でも数百 ms 以内で完了する。
 *
 * 修正前: benign 50KB base64 ≈ 8.3s / adversarial 64KB ≈ 12.7s (event loop 凍結)。
 * 修正後: いずれも閾値未満 (線形)。MAX_REDACT_INPUT は補助 (n を縛るだけで n^2 を防がない)。
 *
 * 閾値は CI の遅さを考慮し安全側に広く取るが、n^2 (秒オーダー) は確実に超過させて赤にする。
 */
describe("INV-REDACTION: redactString ReDoS performance (再#SEC-1)", () => {
  const randBase64 = (n: number): string => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < n; i++) out += alphabet[(i * 2654435761) % alphabet.length];
    return out;
  };

  // 計測は ReDoS 共通基盤 redosBestOfMs (best-of-N の最小値) に帰着させる (両ブロック単一 basis)。
  // 単発計測は GC / スケジューラ preemption / cross-file 並列 contention の加法ノイズで benign な
  // 線形コードも稀に予算超過し flaky 化する (再#5d / QA-10: 予算 500ms を benign 64KB が踏む事例)。
  // min は加法ノイズの下限 = 無競合の真の計算時間に最も近く、真の O(n^2)/ReDoS は全 run で遅いため
  // hard teeth (budgetMs) は保たれる。repeat 省略時は default 15 (scaling 用・ratio 精度)。
  const bestMeasure = (input: string, repeat?: number): number =>
    redosBestOfMs(() => redactString(input), repeat);

  const cases: Array<{ name: string; input: string; budgetMs: number }> = [
    // 量指定子の入れ子があれば quoted-value rule が爆発する。
    {
      name: 'adversarial 64KB unterminated password="...',
      input: `password="${"A".repeat(64 * 1024)}`,
      budgetMs: 500,
    },
    {
      name: 'adversarial 256KB unterminated password="...',
      input: `password="${"A".repeat(256 * 1024)}`,
      budgetMs: 1500,
    },
    // bare url-credential near-miss (...@nohost にマッチしない host)。
    {
      name: "adversarial 64KB user:...@nohost near-miss",
      input: `user:${"a".repeat(64 * 1024)}@nohost`,
      budgetMs: 500,
    },
    {
      name: "adversarial 256KB user:...@nohost near-miss",
      input: `user:${"a".repeat(256 * 1024)}@nohost`,
      budgetMs: 1500,
    },
    // benign base64 (credential key-prefix の無界スキャンが爆発していた経路)。
    { name: "benign 50KB base64", input: randBase64(50 * 1024), budgetMs: 500 },
    { name: "benign 256KB base64", input: randBase64(256 * 1024), budgetMs: 1500 },
    // 反復する未終端トークン (backtracking の積み重ね)。
    {
      name: 'repeated unterminated password=" x300',
      input: `${'password="' + "x".repeat(200) + " "}`.repeat(300),
      budgetMs: 500,
    },
    {
      name: "repeated user:...@nohost near-miss x300",
      input: `${"user:" + "a".repeat(200) + "@nohost "}`.repeat(300),
      budgetMs: 500,
    },
  ];

  for (const { name, input, budgetMs } of cases) {
    it(
      `stays linear (< ${budgetMs}ms) on: ${name}`,
      () => {
        // best-of-N の最小値で計測 (warm-up は redosBestOfMs 内蔵)。加法ノイズスパイクを除去し、
        // 真の計算量だけを budgetMs と比較する (再#5d flake 解消・hard teeth は min でも保持)。
        const ms = bestMeasure(input, REDOS_BUDGET_REPEAT);
        expect(
          ms,
          `${name} took ${ms.toFixed(1)}ms (>= ${budgetMs}ms ⇒ ReDoS / n^2 の疑い)`,
        ).toBeLessThan(budgetMs);
      },
      // best-of-N × 大入力 (256KB) は default 5s を踏むため明示 timeout (scaling と同基盤・wall-clock 保護)。
      REDOS_TEST_TIMEOUT_MS,
    );
  }

  /**
   * QA-3 (再#2): 相対スケーリング判定。
   *
   * 上の絶対時間予算 (budgetMs) は **上限ガード**として残すが、共有 CI runner では絶対
   * wall-clock のみだと flaky 化しうる (runner の負荷で benign な線形コードも予算超過しうる)。
   * そこで `redactDeep` 側 (inv-redaction.test.ts の linear-scaling テスト) と同方式の
   * **相対スケーリング**を redactString の ReDoS ケースにも展開する:
   *   入力長 n を 2 倍したときの所要時間比 t(2n)/t(n) が概ね線形 (< 3.5) であること。
   * O(n^2) なら n 2 倍で時間 ~4 倍となり 3.5 を確実に超過して赤になる (量指定子の入れ子を
   * 再導入すると検出される)。絶対予算と違い runner 速度に対しスケール不変。閾値は
   * 線形≈2 / 二次≈4 の中間を二次側へ寄せた 3.5: cross-file 並列の contention で benign が
   * 3.1 台へ跳ねても緑、再導入した O(n^2) (compute 支配で min 計測は tight・~4) は確実に赤、を
   * 両立する (絶対 budgetMs ガードが ReDoS の hard teeth として併存)。
   *
   * ノイズ対策 (QA-10): 各 n を複数回計測して **最小値 (best-of-N)** を取る。計測ノイズ
   * (GC / スケジューラ preemption / 共有 runner 負荷) は実行時間に**加法的**にしか効かない
   * (真の計算時間より速くは決してならない) ため、min が最も「無競合の真の計算量」に近い。
   * O(n^2)/ReDoS は計算そのものが遅くなり min でも比率に現れるため、感度を落とさず flaky
   * (中央値が runner 負荷でスパイクする 3.12 vs <3 事例) を解消する。下限 n は GC/JIT
   * ノイズに埋もれない程度に大きく取り、tN が極小なら floor を当てる。
   */
  type ScalingBuilder = (n: number) => string;
  const scalingCases: Array<{ name: string; build: ScalingBuilder; n: number }> = [
    {
      name: 'adversarial unterminated password="A*n (quoted-value rule)',
      build: (n) => `password="${"A".repeat(n)}`,
      n: 64 * 1024,
    },
    {
      name: "adversarial user:a*n@nohost near-miss (url-credential rule)",
      build: (n) => `user:${"a".repeat(n)}@nohost`,
      n: 64 * 1024,
    },
    {
      name: "benign base64 n (credential key-prefix scan path)",
      build: (n) => randBase64(n),
      n: 64 * 1024,
    },
  ];

  // bestMeasure は describe 冒頭で定義済 (両ブロック単一 basis)。scaling は ratio 精度のため
  // default 反復 (15)、絶対 budget は REDOS_BUDGET_REPEAT (7) と使い分ける。
  for (const { name, build, n } of scalingCases) {
    it(
      `scales sub-quadratically (t(2n)/t(n) < ${REDOS_RATIO_MAX}) on: ${name}`,
      () => {
        const inN = build(n);
        const in2N = build(2 * n);
        const tN = bestMeasure(inN);
        const t2N = bestMeasure(in2N);
        // 計測下限: 量子化ノイズで比率が無意味化しないよう、tN が極小なら floor を当てる。
        const floored = Math.max(tN, 0.05);
        const ratio = t2N / floored;
        // 実測を残す (独立再検証用)。
        console.log(
          `[INV-REDACTION-REDOS-SCALING] ${name}: t(n)=${tN.toFixed(3)}ms t(2n)=${t2N.toFixed(3)}ms ratio=${ratio.toFixed(2)}`,
        );
        expect(
          ratio,
          `${name} ratio t(2n)/t(n)=${ratio.toFixed(2)} (>= ${REDOS_RATIO_MAX} ⇒ super-linear / ReDoS の疑い)`,
        ).toBeLessThan(REDOS_RATIO_MAX);
        // 重い timing test (best-of-N × 64K/128K redactString)。単一ケースで数秒かかり、
        // フル並列の contention で default 5s を踏みうるため明示 timeout で完走を保証する
        // (ratio の安定は best-of-N + REDOS_RATIO_MAX が担保・timeout は別軸の wall-clock 保護)。
      },
      REDOS_TEST_TIMEOUT_MS,
    );
  }
});

describe("INV-REDACTION: redactDeep (再帰)", () => {
  it("masks secrets nested in objects/arrays", () => {
    const input = {
      summary: "set API_KEY=topsecret123456",
      payload: {
        kind: "command.output.delta",
        delta: "export TOKEN=ghp_1234567890abcdefABCDEF1234567890abcd",
        nested: ["AKIAIOSFODNN7EXAMPLE", { deep: "Bearer abcdef1234567890XYZ" }],
      },
    };
    const flat = JSON.stringify(redactDeep(input));
    expect(flat).not.toContain("topsecret123456");
    expect(flat).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcd");
    expect(flat).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(flat).not.toContain("abcdef1234567890XYZ");
  });

  it("does not throw on cyclic structures", () => {
    const a: Record<string, unknown> = { x: "AKIAIOSFODNN7EXAMPLE" };
    a.self = a;
    expect(() => redactDeep(a)).not.toThrow();
  });
});

/**
 * SEC-FINAL-3 (L, over-redaction): credential keyword の word-segment 化。短曖昧 keyword
 * (`auth`/`token`/`sig`/`sas`/`key`) が **substring** で benign キーを誤マスクしないこと。
 */
describe("INV-REDACTION-OBJVAL: word-boundary keyword (SEC-FINAL-3 keep benign keys)", () => {
  const KEEP: Array<{ key: string; val: string }> = [
    { key: "author", val: "Jane Doe" }, // auth ⊄ word
    { key: "token_count", val: "1500" }, // token は最後の segment でない
    { key: "sigma_value", val: "42.5" }, // sig ⊄ word
    { key: "sasquatch_count", val: "7" }, // sas ⊄ word
    { key: "key_id", val: "abc-123" }, // key は最後の segment でない
    { key: "authoring_tool", val: "vim" }, // auth ⊄ word
  ];
  for (const { key, val } of KEEP) {
    it(`keeps benign key '${key}' value verbatim (no spurious mask)`, () => {
      const out = redactDeep({ [key]: val }) as Record<string, unknown>;
      expect(out[key], `benign key '${key}' over-masked`).toBe(val);
    });
  }

  // 対照: word-segment 末尾/単独の credential keyword は確実にマスク (leak を生まない)。
  const MASK = ["auth", "auth_token", "access_token", "refresh_token", "api_key", "signing_key"];
  for (const key of MASK) {
    it(`still masks credential key '${key}' (word-segment head noun)`, () => {
      const out = redactDeep({ [key]: "viHBTzuWomMhbHhRiCTbAUdEloBlAHSJtAEpbgikcKxw" }) as Record<
        string,
        unknown
      >;
      expect(out[key], `credential key '${key}' leaked`).toBe("[REDACTED:credential-assignment]");
    });
  }
});

/**
 * 再#5 SEC-1: 非 Bearer Authorization scheme の secret 平文残留。
 *
 * 旧実装は Bearer/Basic/Token のみ scheme を網羅し、ApiKey/Negotiate/NTLM/ベンダ独自
 * scheme は credential-assignment が scheme 語だけマスクして後続 secret を温存していた。
 * **string 経路** (ヘッダ文字列全体) と **object 経路** (値だけが `<scheme> <secret>`) の
 * 双方で secret が残らないことを固定する。over-redaction (scheme 語消失) は許容、
 * leak (secret 残留) は不可。
 */
describe("INV-REDACTION: non-Bearer auth scheme (再#5 SEC-1)", () => {
  const cases: Array<{ name: string; header: string; scheme: string; secret: string }> = [
    {
      name: "Authorization: ApiKey",
      header: "Authorization",
      scheme: "ApiKey",
      secret: "live_9f8e7d6c5b4a32100011223344556677",
    },
    {
      name: "WWW-Authenticate: Negotiate",
      header: "WWW-Authenticate",
      scheme: "Negotiate",
      secret: "YIIZ1234567890abcdefNEGOTIATETOKEN",
    },
    {
      name: "Proxy-Authorization: NTLM",
      header: "Proxy-Authorization",
      scheme: "NTLM",
      secret: "TlRMTVNTUAABNTLMplaintexttoken",
    },
  ];

  for (const { name, header, scheme, secret } of cases) {
    it(`string path: ${name} — secret never survives`, () => {
      const out = redactString(`${header}: ${scheme} ${secret}`);
      expect(out, `${name} secret leaked (string path)`).not.toContain(secret);
      expect(out).toContain("[REDACTED:");
    });

    it(`object path: ${name} — secret never survives redactDeep({headers:{...}})`, () => {
      // 値だけが `<scheme> <secret>` (ヘッダ名は object のキー側) — credential-assignment
      // が key<sep>value を見つけられず素通りしていた経路。
      const out = redactDeep({ headers: { [header]: `${scheme} ${secret}` } });
      const flat = JSON.stringify(out);
      expect(flat, `${name} secret leaked (object path)`).not.toContain(secret);
      expect(flat).toContain("[REDACTED:");
    });
  }

  it("object path preserves the scheme word (over-redaction OK, but scheme kept)", () => {
    const out = redactDeep({ headers: { Authorization: "ApiKey live_secrettoken12345" } }) as {
      headers: { Authorization: string };
    };
    // scheme 語 ApiKey は温存され、値だけがマスクされる。
    expect(out.headers.Authorization.startsWith("ApiKey ")).toBe(true);
    expect(out.headers.Authorization).not.toContain("live_secrettoken12345");
  });
});

/**
 * 再#5 SEC-2: cloud 接続文字列の secret 平文残留。
 *
 * 旧 credential keyword に AccountKey/SAS 系が無く、high-entropy も {40} ちょうど限定で
 * 44/72/88 字 base64 鍵を取りこぼした。完全 Azure 接続文字列 + 各長の高エントロピー鍵で
 * secret が残らないことを固定する。
 */
describe("INV-REDACTION: cloud connection-string secrets (再#5 SEC-2)", () => {
  // 一意な base64 風文字列を任意長で生成 (実鍵ではない)。
  const b64 = (n: number): string => {
    const al = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let s = "";
    for (let i = 0; i < n; i++) s += al[(i * 7 + 3) % al.length];
    return s;
  };

  it("masks full Azure storage connection string (AccountKey value never survives)", () => {
    const key = b64(72);
    const conn = `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${key};EndpointSuffix=core.windows.net`;
    const out = redactString(conn);
    expect(out, "Azure AccountKey leaked").not.toContain(key);
    expect(out).toContain("[REDACTED:");
    // 非秘匿の構造 (host/protocol) は温存されてよい (over-redaction 不問だが leak 不可)。
  });

  for (const len of [44, 72, 88]) {
    it(`masks AccountKey=<${len}-char base64> high-entropy cloud key`, () => {
      const key = b64(len);
      const out = redactString(`AccountKey=${key}`);
      expect(out, `${len}-char AccountKey leaked`).not.toContain(key);
      expect(out).toContain("[REDACTED:");
    });

    it(`masks standalone <${len}-char base64> high-entropy key (label-less)`, () => {
      // ラベルなしの裸高エントロピー鍵 (high-entropy-secret 経路) も残らない。
      const key = b64(len);
      const out = redactString(`prefix ${key} suffix`);
      expect(out, `${len}-char standalone key leaked`).not.toContain(key);
    });
  }

  // 再#5b (main probe LEAK 1-3): base64 末尾 `=`/`==` パディング付き鍵が standalone で漏れた。
  //   旧 high-entropy 否定先読みが `=` で失敗しマッチ消失。`={0,2}` consume + lookbehind/
  //   lookahead から `=` 除外で塞ぐ。`==` (2 padding) / `=` (1 padding) 双方を固定。
  for (const pad of ["=", "=="] as const) {
    // base64 本体は b64(len) で生成し末尾に pad を付す (実鍵ではない高エントロピー文字列)。
    const body = b64(44);
    const key = body + pad;
    it(`masks standalone base64 with '${pad}' padding (label-less, surrounded by spaces)`, () => {
      const out = redactString(`token blob ${key} end`);
      expect(out, `padded('${pad}') standalone key leaked`).not.toContain(key);
      expect(out).toContain("[REDACTED:");
    });

    it(`masks base64 with '${pad}' padding after bare 'key=' assignment (no credential keyword)`, () => {
      // `key=` は credential keyword 外 (bare `key`)。high-entropy 経路で拾う必要がある。
      // 旧 lookbehind `(?<![A-Za-z0-9+/=])` は直前 `=` (代入演算子) で start 拒否し漏らした。
      const out = redactString(`key=${key}`);
      expect(out, `'key=' + padded('${pad}') leaked`).not.toContain(key);
      expect(out).toContain("[REDACTED:");
    });

    it(`masks base64 with '${pad}' padding in SAS sig= query param`, () => {
      const out = redactString(`https://x.blob.core.windows.net/c?sig=${key}&se=2030`);
      expect(out, `sig= padded('${pad}') leaked`).not.toContain(key);
    });
  }

  it("does NOT over-redact 64-char hex (1 文字クラス) — entropy gate 不変", () => {
    // パディング対応で lookbehind を緩めても、純 hex (小文字+数字 = 1 クラス) は
    // high-entropy gate (3 クラス以上) 未満なので温存される (誤検出プロファイル不変)。
    const hex64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const out = redactString(`sha ${hex64} ok`);
    expect(out, "benign 64-char hex over-redacted").toContain(hex64);
  });
});

/**
 * 再#5b LEAK 4: object 経路で auth ヘッダの **キー名** が確定する場合、値が未知 scheme
 * (`Scheme <secret>` / `MysteryScheme <secret>` 等、string 経路 auth-scheme-value の既知
 * scheme 集合外) でも値全体をマスクする。キー名 (Authorization / Proxy-Authorization /
 * WWW-Authenticate) で auth と確定するため誤爆しない。string 経路 (キー名なし) は誤爆回避で
 * 既知 scheme 限定のまま (変更しない)。
 */
describe("INV-REDACTION: object-path auth-header key, unknown scheme (再#5b LEAK 4)", () => {
  const SECRET = "TlRMTXNlY3JldEdTU0FQSXRva2VuMTIzNDU2Nzg5MA==";

  const keyCases = ["Authorization", "Proxy-Authorization", "WWW-Authenticate"];
  for (const key of keyCases) {
    it(`masks unknown-scheme value under key '${key}' (object path)`, () => {
      const out = redactDeep({ [key]: `MysteryScheme ${SECRET}` });
      const flat = JSON.stringify(out);
      expect(flat, `unknown scheme under '${key}' leaked`).not.toContain(SECRET);
      expect(flat).toContain("[REDACTED:");
    });

    it(`masks unknown-scheme value nested under headers.${key}`, () => {
      const out = redactDeep({ headers: { [key]: `Scheme ${SECRET}` } });
      const flat = JSON.stringify(out);
      expect(flat, `nested unknown scheme under '${key}' leaked`).not.toContain(SECRET);
    });

    it(`preserves the scheme word under key '${key}' (over-redaction OK, scheme kept)`, () => {
      const out = redactDeep({ [key]: `MysteryScheme ${SECRET}` }) as Record<string, string>;
      // 値の先頭 scheme 語 (MysteryScheme) は温存され、secret 部分のみマスク。
      expect(out[key]?.startsWith("MysteryScheme ")).toBe(true);
      expect(out[key]).not.toContain(SECRET);
    });
  }

  it("string path (key 名なし) は未知 scheme を既知集合限定のまま — 誤爆回避 (変更なし)", () => {
    // string 経路では auth-header キー名コンテキストが無いため、未知 scheme 単独行は
    // auth-scheme-value (既知 scheme 限定) では拾わない。これは誤爆回避の意図的設計。
    // ただし base64 secret 自体は high-entropy 経路で拾われるので leak しない。
    const out = redactString(`MysteryScheme ${SECRET}`);
    // secret 本体 (高エントロピー base64) は high-entropy で必ずマスクされる。
    expect(out, "string-path secret leaked").not.toContain(SECRET);
  });

  it("non-auth key with '<word> <value>' is NOT force-masked by auth rule (no spurious over-mask)", () => {
    // auth ヘッダでない通常キーは scheme-不問マスクの対象外 (誤爆しない)。
    const out = redactDeep({ message: "hello world ok" }) as Record<string, string>;
    expect(out.message).toBe("hello world ok");
  });
});

/**
 * 再#5c SEC-C (H, REGRESSION): high-entropy `{40,N}` 拡張が深い file path / URL path を
 * 誤マスクしない (two-stage gate の stage-1 path 除外)。ActraDeck の存在意義は file diff /
 * command / path の可視化 (security.md「見せてよい」) であり、path 破壊は監督シグナル喪失。
 * INV-REDACTION-OVERREDACT: これらは原文どおり温存される (1 文字も欠けない)。
 */
describe("INV-REDACTION-OVERREDACT: deep path / URL preserved (再#5c SEC-C)", () => {
  const KEEP_CASES: Array<{ name: string; input: string }> = [
    {
      name: "deep absolute file path",
      input: "/home/user/Files/ActraDeck/apps/sidecar/src/redactor.ts",
    },
    {
      name: "deep URL path",
      input: "https://example.com/api/v2/users/profile/settings/advanced/options",
    },
    {
      name: "relative import path",
      input: "../../packages/event-model/src/index/normalize/payload",
    },
    {
      name: "mixed-case path with -/_ separators",
      input: "/home/user/Files/Actra-Deck/apps_v2/my_module-name/src/Deep_Nested/file_handler",
    },
    {
      name: "git diff a/ b/ path",
      input: "a/apps/sidecar/src/redactor.ts",
    },
    {
      name: "pnpm deep node_modules path",
      input: "node_modules/.pnpm/typescript/node_modules/typescript/lib/typescriptServices",
    },
    // 再#5d SEC-3: 連結 / 単一 UUID (trace/correlation id) を keep。
    {
      name: "concatenated UUID (trace id)",
      input: "550e8400-e29b-41d4-a716-446655440000-6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    },
  ];

  for (const { name, input } of KEEP_CASES) {
    it(`keeps ${name} verbatim (no over-redaction)`, () => {
      const out = redactString(input);
      expect(out, `${name} over-redacted`).toBe(input);
      expect(out).not.toContain("[REDACTED:");
    });
  }

  it("keeps concatenated UUID embedded in a sentence (correlation id visible)", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000-6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const out = redactString(`trace ${uuid} end`);
    expect(out, "concatenated UUID over-redacted").toContain(uuid);
  });

  it("still masks a real urlsafe secret that contains a single '/' (not a path)", () => {
    // base64 `/` 1 個を含むが path ではない高エントロピー secret は依然マスクされる
    // (stage-1 は word-segment path のみ除外、stage-2 で 3+ class を捕捉)。
    const secret = "abcDEF1234567890ghijKLMN+/abcDEF1234567890ghPQrs";
    const out = redactString(`blob ${secret} end`);
    expect(out, "real secret with single / leaked").not.toContain(secret);
  });
});

/**
 * 再#5: 新規正規表現 (auth-header-scheme / auth-scheme-value / 拡張 high-entropy) の ReDoS。
 *
 * 量指定子はすべて有界。病的入力長 n を倍にしたとき所要時間比 t(2n)/t(n) < 3.5 (線形)。
 * O(n^2) なら 2 倍で ~4 倍となり 3.5 を超過して赤になる。計測は block 1 と同一の共通基盤
 * redosBestOfMs (best-of-N の最小値・median 不使用) + REDOS_RATIO_MAX + 明示 timeout に帰着。
 */
describe(`INV-REDACTION: 再#5 new-rule ReDoS scaling (t(2n)/t(n) < ${REDOS_RATIO_MAX})`, () => {
  // 計測は共通基盤 redosBestOfMs (best-of-N の最小値) に帰着 (median/<3 の basis ドリフトを解消)。

  const cases: Array<{ name: string; build: (n: number) => string; n: number }> = [
    {
      // auth-header-scheme: 未終端の長大値 (否定文字クラス有界反復が爆発しないこと)。
      name: "Authorization: ApiKey <A*n> (auth-header-scheme rule)",
      build: (n) => `Authorization: ApiKey ${"A".repeat(n)}`,
      n: 64 * 1024,
    },
    {
      // auth-scheme-value (object 値経路): 行頭 scheme + 長大値。
      name: "ApiKey <A*n> standalone value (auth-scheme-value rule)",
      build: (n) => `ApiKey ${"A".repeat(n)}`,
      n: 64 * 1024,
    },
    {
      // 拡張 high-entropy {40,N}: 長大 base64 run (lookahead backtrack 有界性)。
      name: "AccountKey=<base64 run *n> (high-entropy {40,N} rule)",
      build: (n) => {
        const al = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let s = "";
        for (let i = 0; i < n; i++) s += al[(i * 7 + 3) % al.length];
        return `AccountKey=${s}`;
      },
      n: 64 * 1024,
    },
    {
      // 再#5b: 末尾 `==` パディング + `key=` 代入 (緩めた lookbehind/lookahead/`={0,2}` 経路)。
      name: "key=<base64 run *n>== (padded high-entropy, key= prefix)",
      build: (n) => {
        const al = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let s = "";
        for (let i = 0; i < n; i++) s += al[(i * 7 + 3) % al.length];
        return `key=${s}==`;
      },
      n: 64 * 1024,
    },
    {
      // 再#5c SEC-A: urlsafe charset 拡張 `[A-Za-z0-9+/_-]` の長大 run (charset 変更が
      //   superlinear を引き起こさないこと)。`-`/`_` 多数混在で path 判定/entropy 判定も走る。
      name: "urlsafe run *n with -/_ (high-entropy urlsafe charset)",
      build: (n) => {
        const al = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
        let s = "";
        for (let i = 0; i < n; i++) s += al[(i * 7 + 3) % al.length];
        return `secret ${s} end`;
      },
      n: 64 * 1024,
    },
    {
      // 再#5c SEC-B: 空ユーザ URL near-miss (`{0,N}` user 部が空マッチ暴走しないこと)。
      //   `scheme://:<pw*n>@nohost` は host が `@` 直後にないと url-credential 非マッチ。
      name: "redis://:<pw*n>@nohost near-miss (empty-user url-credential {0,N})",
      build: (n) => `redis://:${"a".repeat(n)}@nohost`,
      n: 64 * 1024,
    },
    {
      // 再#5c SEC-C: 深い path 風長大入力 (stage-1 path 判定 split('/') が線形であること)。
      name: "deep '/'-segmented path *n (looksLikePath split path)",
      build: (n) => {
        // n/8 個の短 segment を `/` で連結した path。split('/').every(...) が線形。
        let s = "";
        const seg = "abcDEFg/";
        for (let i = 0; i < Math.floor(n / seg.length); i++) s += seg;
        return `/${s}file`;
      },
      n: 64 * 1024,
    },
    {
      // 再#5d: word 的 sub-word path (split(/[._-]/).every + 母音/子音 run 判定が線形)。
      name: "word-segment path *n with _/-/. sub-words (isWordlikeSubword path)",
      build: (n) => {
        let s = "";
        const seg = "my_module-name.ext/"; // sub-word 分割 + 母音判定を毎 segment 走らせる
        for (let i = 0; i < Math.floor(n / seg.length); i++) s += seg;
        return `/${s}file`;
      },
      n: 64 * 1024,
    },
    {
      // 再#5d SEC-3: 連結 UUID 長大入力 (UUID_CONCAT_RE アンカー regex が線形であること)。
      name: "concatenated UUID *n (UUID_CONCAT_RE)",
      build: (n) => {
        const uuid = "550e8400-e29b-41d4-a716-446655440000";
        const reps = Math.max(1, Math.min(64, Math.floor(n / 37)));
        let s = uuid;
        for (let i = 1; i < reps; i++) s += "-" + "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
        return s;
      },
      n: 1024,
    },
    {
      // 再#5d SEC-1: 先頭 `/` 剥がし後 body 評価が長大乱雑 secret で線形 (near-miss)。
      name: "/-prefixed long random run *n (strip + isPathBody near-miss)",
      build: (n) => {
        const al = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
        let s = "";
        for (let i = 0; i < n; i++) s += al[(i * 7 + 3) % al.length];
        return `/${s}`;
      },
      n: 64 * 1024,
    },
    {
      // Phase 4 (019e9255): azure-ad-client-secret。`\dQ~` marker 無しの長大 valid-char run が
      //   各 start で {3}→`\d`/`Q~` リテラル不一致で即失敗 (lookbehind/lookahead 有界・backtrack なし)。
      name: "azure near-miss <validchars*n> no \\dQ~ marker (azure-ad rule)",
      build: (n) => {
        const al = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_~.";
        let s = "";
        for (let i = 0; i < n; i++) s += al[(i * 7 + 3) % al.length];
        return s;
      },
      n: 64 * 1024,
    },
    {
      // Phase 4: planetscale-token。prefix 後の長大 body は {32,64} 上限 backtrack を定数で打ち切り、
      //   lookahead 失敗後は次 prefix 無しで線形走査 (super-linear にならない)。
      name: "pscale_tkn_<run*n> (planetscale {32,64} + lookahead)",
      build: (n) => `pscale_tkn_${"a".repeat(n)}`,
      n: 64 * 1024,
    },
    {
      // Phase 4: flyio-token。fm2_ 後の長大 base64 run は {40,200} 上限 backtrack を定数で打ち切る。
      name: "fm2_<base64 run*n>=== (flyio {40,200} + padding + lookahead)",
      build: (n) => `fm2_${"a".repeat(n)}===`,
      n: 64 * 1024,
    },
  ];

  for (const { name, build, n } of cases) {
    it(
      `scales sub-quadratically on: ${name}`,
      () => {
        const tN = redosBestOfMs(() => redactString(build(n)));
        const t2N = redosBestOfMs(() => redactString(build(2 * n)));
        const floored = Math.max(tN, 0.05);
        const ratio = t2N / floored;
        console.log(
          `[INV-REDACTION-REDOS-SCALING 再#5] ${name}: t(n)=${tN.toFixed(3)}ms t(2n)=${t2N.toFixed(3)}ms ratio=${ratio.toFixed(2)}`,
        );
        expect(
          ratio,
          `${name} ratio=${ratio.toFixed(2)} (>= ${REDOS_RATIO_MAX} ⇒ super-linear / ReDoS の疑い)`,
        ).toBeLessThan(REDOS_RATIO_MAX);
      },
      REDOS_TEST_TIMEOUT_MS,
    );
  }

  it(
    "scales sub-quadratically on: object auth-header value <word> <A*n> (redactDeep AUTH_HEADER_VALUE_RE)",
    () => {
      // 再#5b LEAK 4 経路: object 値の auth-header 専用正規表現 (有界量指定子) が線形であること。
      const build = (n: number) => ({ Authorization: `MysteryScheme ${"A".repeat(n)}` });
      const n = 64 * 1024;
      const tN = redosBestOfMs(() => redactDeep(build(n)));
      const t2N = redosBestOfMs(() => redactDeep(build(2 * n)));
      const ratio = t2N / Math.max(tN, 0.05);
      console.log(
        `[INV-REDACTION-REDOS-SCALING 再#5b] object auth-header value: t(n)=${tN.toFixed(3)}ms t(2n)=${t2N.toFixed(3)}ms ratio=${ratio.toFixed(2)}`,
      );
      expect(
        ratio,
        `object auth-header ratio=${ratio.toFixed(2)} (>= ${REDOS_RATIO_MAX} ⇒ ReDoS の疑い)`,
      ).toBeLessThan(REDOS_RATIO_MAX);
    },
    REDOS_TEST_TIMEOUT_MS,
  );
});

describe("INV-REDACTION: Phase 4 bare vendor token (SEC 019e9255)", () => {
  // 正例: 各 vendor token が固定 prefix ルールでマスクされ、正しい kind が付く
  //   (high-entropy gate の 3-class/40字 を満たさない短い/低エントロピー token も確実に捕捉)。
  const VENDOR: Array<{ kind: string; sample: string }> = [
    { kind: "huggingface-token", sample: `hf_${"a".repeat(36)}` }, // hf_ + 36 base62
    { kind: "azure-ad-client-secret", sample: `abc1Q~${"d".repeat(33)}` }, // {3}\dQ~{33}
    { kind: "databricks-token", sample: `dapi${"0123456789abcdef".repeat(2)}` }, // dapi + 32 hex
    { kind: "databricks-token", sample: `dapi${"0123456789abcdef".repeat(2)}-2` }, // + -<digit>
    { kind: "doppler-token", sample: `dp.pt.${"a".repeat(43)}` }, // dp.pt. + 43
    { kind: "planetscale-token", sample: `pscale_tkn_${"a".repeat(38)}` }, // pscale_tkn_ + 38
    { kind: "planetscale-token", sample: `pscale_oauth_${"b".repeat(38)}` },
    { kind: "flyio-token", sample: `fo1_${"a".repeat(43)}` }, // fo1_ + 43
    { kind: "flyio-token", sample: `fm2_${"a".repeat(48)}` }, // fm2_ + base64{48}
  ];
  for (const { kind, sample } of VENDOR) {
    it(`masks ${kind}: ${sample.slice(0, 12)}…`, () => {
      // 中立な前後文脈で wrap し、vendor ルール自体の発火を分離する (assignment/keyword 経路に依存しない)。
      const out = redactString(`pre ${sample} post`);
      expect(out, `raw token が残留`).not.toContain(sample);
      const byKind = countRedactionMarkersByKind(out);
      expect(byKind[kind], `${kind} の kind マーカーが付かない`).toBeGreaterThanOrEqual(1);
    });
  }

  it("全 vendor kind が event-model REDACTION_KINDS に属する (subset pin の二重確認)", () => {
    for (const { kind } of VENDOR) expect(REDACTION_KINDS_SET.has(kind)).toBe(true);
  });

  it("prefix 類似の benign は温存される (over-redaction 回避)", () => {
    const benign = [
      "hffile_report.txt", // hf_ ではない
      "hf_short", // 長さ不足 (<34)
      "dapifoo", // dapi + 非 hex
      "dp.point.config", // dp.pt. ではない
      "pscale_config", // pscale_tkn_/oauth_ ではない
      "foo1_bar", // fo1_ ではない
    ];
    for (const b of benign) {
      const out = redactString(`val ${b} end`);
      expect(out, `${b} を誤マスク`).toContain(b);
    }
  });
});

describe("INV-REDACTION: Phase 4 wallet/PCI vocabulary (mnemonic/cvv/cvc・SEC 019e9255 + 裁定 2026-06-16)", () => {
  // 正例 (object-key 経路): word-segment 完全一致で **値**を無条件マスク (値が低エントロピーでも)。
  //   採用は曖昧性の低い cvv/cvc/mnemonic のみ。seed/pin は dev 過剰マスク回避のため不採用 (下記 KEPT で固定)。
  const SECRET = "ZZ abandon ability about above ZZ"; // standalone ルールに掛からない低エントロピー値
  const MASKED_KEYS = ["cvv", "cvc", "mnemonic", "card_cvv", "recoveryMnemonic", "walletMnemonic"];
  for (const key of MASKED_KEYS) {
    it(`object key "${key}" の値をマスク`, () => {
      const out = redactDeep({ [key]: SECRET } as Record<string, unknown>);
      expect(JSON.stringify(out), `${key} の値が漏れた`).not.toContain(SECRET);
    });
  }

  // 負例 (over-redaction 回避): fused/部分文字列の benign 一般語、KEEP_SUFFIX 識別子、
  //   そして **不採用となった seed/pin** を含む dev/ハードウェア識別子の温存を回帰固定する。
  //   seed/pin を SEGMENT_ONLY へ戻すと dev-domain 群が赤化し、可視性退行を検出する真ゲート。
  const KEPT: Array<{ key: string; val: string }> = [
    { key: "linseed", val: "flax-oil-batch-keepme" }, // endsWith seed だが fused 不発火 (segment-only)
    { key: "flaxseed", val: "harvest-2026-keepme" },
    { key: "pinpoint", val: "location-keepme" }, // startsWith pin だが segment ≠ pin
    { key: "endpoint", val: "service-host-keepme" },
    { key: "spinner", val: "loading-keepme" },
    // seed/pin 不採用 (裁定 2026-06-16): word-segment 完全一致でも mask しない (dev 可視性優先)。
    { key: "seed", val: "rng-seed-keepme" },
    { key: "pin", val: "1234-keepme" },
    { key: "walletSeed", val: "phrase-words-keepme" },
    { key: "userPin", val: "0000-keepme" },
    { key: "gpio_pin", val: "17-keepme" }, // ハードウェア GPIO ピン
    { key: "led_pin", val: "13-keepme" },
    { key: "reset_pin", val: "4-keepme" },
    { key: "randomSeed", val: "42-keepme" }, // RNG seed
    { key: "seedData", val: "users-table-rows-keepme" }, // DB seed
    { key: "dbSeed", val: "fixture-001-keepme" },
    { key: "seedScript", val: "run-me-keepme" },
    { key: "seedId", val: "id-0001-keepme" }, // KEEP_SUFFIX (識別子)
  ];
  for (const { key, val } of KEPT) {
    it(`benign key "${key}" の値は温存`, () => {
      const out = redactDeep({ [key]: val } as Record<string, unknown>);
      expect(JSON.stringify(out), `${key} を誤マスク`).toContain(val);
    });
  }
});

/**
 * INV-REDACTDEEP-COUNT-PARITY (TDA-1, hot-path): `redactDeepWithCount` は
 *  (a) `redactDeep` と **バイト等価の redacted 値** を返す (redaction 挙動を一切変えない)、
 *  (b) その redactionCount が `countRedactionMarkers(JSON.stringify(redactDeep(x)))` と一致する
 *      (= 旧 sink 実装の二重 stringify と同じ件数を 1 走査で得る)。
 * mutation (走査集計を 0 固定 / count を外す) で本パリティが赤化する。
 */
describe("INV-REDACTDEEP-COUNT-PARITY: redactDeepWithCount は redactDeep と同値 + 件数一致", () => {
  const GH = "ghp_1234567890abcdefABCDEF1234567890abcd";
  const cases: { name: string; input: unknown }[] = [
    { name: "primitive string with secret", input: `tok=${GH}` },
    { name: "plain no-secret object", input: { event_type: "heartbeat", n: 1, ok: true } },
    {
      name: "nested object/array with secrets in values",
      input: {
        event_type: "agent.message.delta",
        payload: { kind: "agent.message.delta", delta: `a ${GH} b ${GH}` },
        arr: [`x ${GH}`, "clean", { deep: `y ${GH}` }],
      },
    },
    {
      name: "secret used as object KEY",
      input: { payload: { env: { [GH]: "v" } } },
    },
    { name: "null and number and boolean", input: { a: null, b: 0, c: false } },
  ];

  for (const c of cases) {
    it(`${c.name}: redacted 値が redactDeep と一致し件数が stringify 走査と一致`, () => {
      const reference = redactDeep(c.input);
      const { value, redactionCount, redactionCountByKind } = redactDeepWithCount(c.input);
      // (a) redacted 値はバイト等価 (JSON 比較で順序・内容一致)。
      expect(JSON.stringify(value)).toBe(JSON.stringify(reference));
      // (b) 方針 A: scalar は全マーカー数 (countRedactionMarkersDeep) と一致する (by-kind 総和には
      //   依存しない)。旧 sink 実装 (JSON 全体走査) と件数は一致する。
      expect(redactionCount).toBe(countRedactionMarkers(JSON.stringify(reference)));
      // (c) 強み(a)③: kind 別件数は JSON 全体走査の (allowlist 済み) kind 別集計と一致。
      expect(redactionCountByKind).toEqual(countRedactionMarkersByKind(JSON.stringify(reference)));
      // (d) 正直な INV: sum(by_kind) <= redactionCount (by_kind は既知 kind の部分集合)。
      //   これらのケースは全て既知 kind の secret ゆえ等号も成立する。
      const sum = Object.values(redactionCountByKind).reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(redactionCount);
      expect(sum).toBe(redactionCount);
    });
  }

  it("redactDeepWithCount は元入力を変更しない (純関数・redactDeep と同じ)", () => {
    const input = { payload: { delta: `secret ${GH}` } };
    const snapshot = JSON.stringify(input);
    redactDeepWithCount(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

/**
 * 強み(a)③ (redaction 可視化): countRedactionMarkersByKind の純関数契約。
 * **redaction 後**の文字列を kind 別に集計し、原文を一切返さない (kind 名 = 公開 enum + 件数のみ)。
 * SEC-1/SEC-2 (BLOCK 解消): 蓄積は Object.create(null) + 既知 kind allowlist。よって
 * sum(by_kind) <= countRedactionMarkers (全マーカーが既知 kind のときのみ等号)。
 */
describe("countRedactionMarkersByKind: kind 別件数集計 (純関数)", () => {
  it("複数 kind を kind 別に数える", () => {
    const s = "a [REDACTED:github-token] b [REDACTED:github-token] c [REDACTED:aws-access-key-id]";
    expect(countRedactionMarkersByKind(s)).toEqual({
      "github-token": 2,
      "aws-access-key-id": 1,
    });
  });

  it("単一 kind", () => {
    expect(countRedactionMarkersByKind("x [REDACTED:high-entropy-secret] y")).toEqual({
      "high-entropy-secret": 1,
    });
  });

  it("空入力 / マーカーなしは {}", () => {
    expect(countRedactionMarkersByKind("")).toEqual({});
    expect(countRedactionMarkersByKind("no markers here at all")).toEqual({});
  });

  it("sum(by_kind) === countRedactionMarkers (全マーカーが既知 kind のとき等号)", () => {
    const s =
      "[REDACTED:github-token] [REDACTED:credential-assignment] [REDACTED:github-token] plain";
    const byKind = countRedactionMarkersByKind(s);
    const sum = Object.values(byKind).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(countRedactionMarkers(s));
    expect(sum).toBe(countRedactionMarkers(s));
    expect(sum).toBe(3);
  });

  it("実 redactString 出力に対して kind 別集計が成立する (擬似 secret)", () => {
    const gh = "ghp_1234567890abcdefABCDEF1234567890abcd";
    // bare な github-token 2 つ (credential-assignment 経路に飲まれない形)。
    const redacted = redactString(`first ${gh} and another ${gh}`);
    const byKind = countRedactionMarkersByKind(redacted);
    // github-token が 2 件 (値そのものは出力に残らない)。
    expect(byKind["github-token"]).toBe(2);
    expect(redacted).not.toContain(gh);
    // 集計結果に原文は一切含まれない (キーは kind 名のみ)。
    expect(JSON.stringify(byKind)).not.toContain(gh);
  });
});

/**
 * INV-BYKIND-ALLOWLIST (SEC-2, M / BLOCK 解消 decision 019ec6fd):
 *   良性入力に含まれる `[REDACTED:foo-bar]` を phantom kind として by_kind に計上しない。
 *
 * 背景: REDACTION_MARKER_KIND_RE は redactor の token() 由来か raw 由来かを区別しないため、
 *   ユーザー文書が文字列 `[REDACTED:foo-bar]` を含むと「嘘の秘匿の種類」が by_kind→jsonb→DTO→WS
 *   に計上される。raw-secret 漏洩は無 (charset `[a-z-]+` は大文字/数字/_ を捕捉せず secret 不可)
 *   だが、可視化の信頼性を損なう。修正: KNOWN_REDACTION_KINDS allowlist で未知 kind を捨てる。
 *
 * mutation 反証: redactor.ts の `if (!KNOWN_REDACTION_KINDS.has(kind)) continue;` を外す →
 *   foo-bar / totally-fake が by_kind に載り本ブロック赤化。
 */
describe("INV-BYKIND-ALLOWLIST (SEC-2): phantom kind を by-kind に計上しない", () => {
  it("良性 raw 入力 [REDACTED:foo-bar] は既知 kind でないため by_kind に現れない", () => {
    const s = "[REDACTED:foo-bar] [REDACTED:totally-fake]";
    expect(countRedactionMarkersByKind(s)).toEqual({});
    expect(countRedactionMarkersByKindDeep({ a: s })).toEqual({});
  });

  it("既知 kind と phantom kind が混在すると既知 kind のみ載る", () => {
    const s = "[REDACTED:foo-bar] [REDACTED:github-token] [REDACTED:slack-token]";
    expect(countRedactionMarkersByKind(s)).toEqual({
      "github-token": 1,
      "slack-token": 1,
    });
  });

  it("KNOWN_REDACTION_KINDS は event-model の REDACTION_KINDS_SET を単一出所とする (T1 昇格)", () => {
    // SEC-3: kind 語彙の権威は event-model (T1)。redactor allowlist はこれを再エクスポートし、
    //   projection の closed-enum gate と必ず同一集合を参照する (層をまたぐドリフト防止)。
    expect(KNOWN_REDACTION_KINDS).toBe(REDACTION_KINDS_SET);
    // 代表的な既知 kind が含まれる。
    expect(KNOWN_REDACTION_KINDS.has("github-token")).toBe(true);
    expect(KNOWN_REDACTION_KINDS.has("high-entropy-secret")).toBe(true);
    // phantom は含まれない。
    expect(KNOWN_REDACTION_KINDS.has("foo-bar")).toBe(false);
  });

  it("REDACTION_RULES.kind ⊆ REDACTION_KINDS (rule が語彙外 kind を出さない・単一出所 pin)", () => {
    // 各 redaction rule の kind は必ず正典語彙に属する。新ルールを足して語彙へ追加し忘れると
    //   この pin が赤化し検出する (mutation 反証: REDACTION_KINDS から任意 1 kind を削ると赤)。
    for (const r of REDACTION_RULES) {
      expect(REDACTION_KINDS_SET.has(r.kind)).toBe(true);
    }
    // 逆向きの sanity: 語彙は rule の kind 集合をすべて含む (現状は一致だが契約は ⊆)。
    const ruleKinds = new Set(REDACTION_RULES.map((r) => r.kind));
    for (const k of ruleKinds) {
      expect(REDACTION_KINDS).toContain(k);
    }
  });

  it("実 redactString で出た既知 kind は by_kind に載る (phantom 排除が実値を巻き込まない)", () => {
    const gh = "ghp_1234567890abcdefABCDEF1234567890abcd";
    const redacted = redactString(`tok ${gh}`);
    const byKind = countRedactionMarkersByKind(redacted);
    expect(byKind["github-token"]).toBe(1);
  });
});

/**
 * INV-BYKIND-SUM-LE-COUNT (QA-1 = TDA-2, M / BLOCK 解消 decision 019ec6fd):
 *   `sum(by_kind) <= redaction_count` を正直な不変条件として pin する。等号は全マーカーが
 *   既知 kind かつ全 event が by_kind を持つときのみ。phantom kind を含む event では
 *   sum(by_kind) < redaction_count になる (方針 A: scalar は全マーカー数)。
 *
 * 旧主張 (全層で `===` を構造保証) は誇張だった。phantom/legacy で乖離するのを仕様として明示する。
 */
describe("INV-BYKIND-SUM-LE-COUNT (QA-1/TDA-2): sum(by_kind) <= redaction_count", () => {
  it("phantom kind を含む event は sum(by_kind) < redactionCount (乖離を pin)", () => {
    // 既知 github-token 1 + phantom foo-bar 1 = 全マーカー 2、既知 by_kind は 1。
    const r = redactDeepWithCount({ note: "[REDACTED:github-token] [REDACTED:foo-bar]" });
    expect(r.redactionCount).toBe(2);
    expect(r.redactionCountByKind).toEqual({ "github-token": 1 });
    const sum = Object.values(r.redactionCountByKind).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThan(r.redactionCount);
  });

  it("全マーカーが既知 kind なら sum(by_kind) === redactionCount (等号成立)", () => {
    const r = redactDeepWithCount({ note: "[REDACTED:github-token] [REDACTED:slack-token]" });
    const sum = Object.values(r.redactionCountByKind).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.redactionCount);
    expect(sum).toBe(2);
  });

  it("scalar は countRedactionMarkersDeep に等しい (方針 A: by-kind 総和に依存しない)", () => {
    const input = { note: "[REDACTED:constructor] [REDACTED:foo-bar] [REDACTED:github-token]" };
    const r = redactDeepWithCount(input);
    expect(r.redactionCount).toBe(countRedactionMarkersDeep(redactDeep(input)));
    expect(r.redactionCount).toBe(3);
  });
});
