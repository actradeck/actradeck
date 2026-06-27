/**
 * INV-REDACTION (P0 必須リグレッション, testing.md)。
 *
 * 「秘匿情報が redaction 後に保存・送信路へ漏れない」を、
 * (a) redactor 単体の網羅性、(b) EventSink の redact→persist→send 順序、
 * の 2 層で検証する。raw が SQLite / 送信路に絶対残らないこと。
 */
import { describe, expect, it, vi } from "vitest";

import {
  newEventId,
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
  redactValue,
} from "../src/redactor.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import { WsClient } from "../src/ws-client.js";

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
 * 4#SEC-1 (INV-REDACTION 構造穴): redactValue/redactDeep は値だけでなく
 * **オブジェクトのキー名にも** redactString を適用する。secret をキーに持つ
 * object payload (例 token をキーにした JSON、env を key にした tool 出力) が
 * EventSink.emit → SQLite event_log → WS 送信 へ未マスクで残留しない。
 *
 * reachability: payload.ts の ToolStarted.input / ToolCompleted.output /
 * McpCallStarted.arguments / McpCallCompleted.result が z.unknown() で任意ネスト
 * object を許容するため、将来 emitter がこの経路を埋めるとキー軸 leak が顕在化する。
 */
describe("INV-REDACTION: secret-as-object-key (4#SEC-1)", () => {
  const GH_KEY = "ghp_1234567890abcdefABCDEF1234567890abcd";

  it("masks secret object KEYS (not just values)", () => {
    const out = redactDeep({
      [GH_KEY]: "v",
      headers: { Authorization: "Bearer abcdefghijklmnop" },
    });
    const flat = JSON.stringify(out);
    // 原文 secret キーが残らない。
    expect(flat, "secret object key leaked").not.toContain(GH_KEY);
    // 値側の Bearer もマスクされる (既存の値経路は不変)。
    expect(flat).not.toContain("abcdefghijklmnop");
    expect(flat).toContain("[REDACTED:");
  });

  it("preserves non-secret keys verbatim (no spurious mutation)", () => {
    const out = redactDeep({ headers: { foo: "bar" }, count: 3, nested: { ok: true } }) as Record<
      string,
      unknown
    >;
    // 通常キーは変化しない (構造の決定性保持)。
    expect(Object.keys(out)).toEqual(["headers", "count", "nested"]);
    expect((out.headers as Record<string, unknown>).foo).toBe("bar");
    expect(out.count).toBe(3);
  });

  it("does not lose values when two distinct secret keys collapse to the same mask (suffix uniquification)", () => {
    // 異なる 2 つの secret キーがマスク後に同一トークンへ潰れても、後勝ちで値が消えない。
    const k1 = "ghp_aaaaaaaaaaaaaaaaaaaaAAAAAAAAAAAAAAAAAAAA";
    const k2 = "ghp_bbbbbbbbbbbbbbbbbbbbBBBBBBBBBBBBBBBBBBBB";
    const out = redactDeep({ [k1]: "value-one", [k2]: "value-two" }) as Record<string, unknown>;
    const vals = Object.values(out);
    // どちらの値も保持される (2 エントリ)。
    expect(vals).toContain("value-one");
    expect(vals).toContain("value-two");
    expect(Object.keys(out)).toHaveLength(2);
    // 原文キーは残らない。
    const flat = JSON.stringify(out);
    expect(flat).not.toContain(k1);
    expect(flat).not.toContain(k2);
  });

  it("does not drop a secret value when a passthrough key collides with an earlier masked key (SEC-v1)", () => {
    // SEC-v1: secret キー (マスクで [REDACTED:…] になる) が先に出力された後、
    // たまたま `[REDACTED:jwt]` という文字列を素の通常キーに持つ entry が来ると、
    // `rk !== k` gate では衝突解決が skip され先行 secret の値が黙って破棄される退行。
    // 衝突キーは credential keyword (token/secret/key/auth/sig 等) を **含まない** mask token を
    //   使い、key→value マスク (SEC-FINAL-1) と分離して「衝突一意化のみ」を検証する。
    //   JWT (`eyJ….eyJ….sig`) → `[REDACTED:jwt]` は keyword 非該当 (値はマスクされない)。
    const secretKey = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwYWJjZCJ9.abcdEFGH1234wxyz5678"; // → [REDACTED:jwt]
    const collideKey = "[REDACTED:jwt]";
    const out = redactValue({
      [secretKey]: "SECRET_VALUE",
      [collideKey]: "benign",
    }) as Record<string, unknown>;
    // 2 entry を保持 (データ非損失)。
    expect(Object.keys(out)).toHaveLength(2);
    const vals = Object.values(out);
    // 両値が生存する (衝突解決でどちらも破棄されない)。
    expect(vals).toContain("SECRET_VALUE");
    expect(vals).toContain("benign");
    // 原文 secret キーは残らない。
    expect(JSON.stringify(out)).not.toContain(secretKey);
  });

  it("preserves cyclic guard + determinism with key redaction", () => {
    const a: Record<string, unknown> = { [GH_KEY]: "x" };
    a.self = a;
    expect(() => redactDeep(a)).not.toThrow();
  });

  // ── SEC-v2: 衝突一意化の性能 (INV-REDACTION-PERF) と旧実装との等価 ────────────
  //
  // 旧実装は衝突毎に suffix を 2 から再走査するため、N 個の masked-collide キーで
  // O(N^2) になり redaction choke point が adversarial payload で DoS 化した。
  // 修正は baseKey 毎に next suffix を記憶して再走査を排除 (O(N) 償却) しつつ、
  // 出力キー・値・順序を旧実装とバイト等価に保つ。

  // SEC-FINAL-1/3: production と同じ credential-key→value マスクを legacy 基準にも反映する
  //   (この equivalence テストは「suffix 衝突解決の O(N) 最適化が legacy とバイト等価」を
  //   検証するもの。key→value マスクは両実装で同一に適用されるべきで、基準側にも入れる)。
  //   SEC-FINAL-3 の `isCredentialKey` (compound contains-match + 短曖昧 keyword の word-segment
  //   末尾/単独判定) を忠実に再現する。literal `[REDACTED:github-token]#N` は `token]#N` が
  //   clean segment でないため **credential 扱いされない** (値は素通り)。
  const LEGACY_CRED_COMPOUND_RE =
    /secret|passw(?:or)?d|credentials?|api[_-]?key|apikey|access[_-]?key|account[_-]?key|accountkey|private[_-]?key|client[_-]?secret|connection[_-]?string|shared[_-]?access[_-]?signature/i;
  const LEGACY_CRED_SHORT = new Set(["auth", "token", "pwd", "sig", "sas", "key"]);
  const legacyIsCredKey = (k: string): boolean => {
    if (LEGACY_CRED_COMPOUND_RE.test(k)) return true;
    const segs = k.toLowerCase().split(/[_\-.]/);
    const last = segs[segs.length - 1] ?? "";
    if (LEGACY_CRED_SHORT.has(last)) return true;
    if (segs.length === 1 && LEGACY_CRED_SHORT.has(segs[0]!)) return true;
    return false;
  };

  /**
   * 旧 (修正前) アルゴリズムの忠実な再現 (+ SEC-FINAL-1 key→value マスク)。等価テストの基準。
   * 衝突時に毎回 2 から `out` を線形再走査して最小の空き `#suffix` を割り当てる。
   * 注: 本実装は性能テストには使わない (O(N^2) で遅い)。等価検証専用。
   */
  function redactValueLegacy(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === "string") return redactString(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redactValueLegacy(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const rk = redactString(k);
      let outKey = rk;
      if (Object.prototype.hasOwnProperty.call(out, outKey)) {
        let suffix = 2;
        while (Object.prototype.hasOwnProperty.call(out, `${rk}#${suffix}`)) suffix++;
        outKey = `${rk}#${suffix}`;
      }
      out[outKey] =
        typeof v === "string" && legacyIsCredKey(k)
          ? v.length === 0
            ? v
            : "[REDACTED:credential-assignment]"
          : redactValueLegacy(v, seen);
    }
    return out;
  }

  it("SEC-v2 equivalence: byte-equal output keys/values/order vs legacy (pathological literal #N input)", () => {
    // 病的入力: masked-collide な secret キー群 + literal `[REDACTED:…]#2` / `#3` を混在させ、
    // counter (next suffix 記憶) が literal 既存キーと衝突しないこと、かつ旧実装と
    // キー配列・各値・順序がバイト等価であることを固定する (carry-over の正しさ)。
    const base = "[REDACTED:github-token]";
    const gh = (c: string) => "ghp_" + c.repeat(36); // すべて base へ潰れる
    const input: Record<string, unknown> = {};
    input[gh("a")] = "v-a"; // → base
    input[gh("b")] = "v-b"; // base 衝突 → #2 (counter は next=3 を記憶)
    // literal passthrough キー #3 が先に居座る病的形 (counter が literal 既存 slot を跨ぐか検証)。
    input[base + "#3"] = "literal-3"; // passthrough、#3 を占有
    input[gh("c")] = "v-c"; // counter=3 候補 → 既存(literal #3)で skip → #4 (next=5)
    input[gh("d")] = "v-d"; // → #5 (next=6)
    // literal #2 が後から来る: base が衝突 (#2 は v-b が占有済み) → base#2 が衝突解決対象になり
    // redactString(base#2)=base#2 自体が out に既出 → そのサブベース base#2 で #2 を割当 = base#2#2。
    input[base + "#2"] = "literal-2";
    input["normal"] = "plain"; // 通常キー passthrough
    input[gh("e")] = "v-e"; // base 衝突 → counter=6 → #6

    const got = redactValue(input) as Record<string, unknown>;
    const expected = redactValueLegacy(input) as Record<string, unknown>;

    // キー配列 (順序含む) と各値がバイト等価 (carry-over の正しさを固定)。
    expect(Object.keys(got)).toEqual(Object.keys(expected));
    expect(JSON.stringify(got)).toEqual(JSON.stringify(expected));
    // データ非損失: 入力エントリ数 = 出力エントリ数。
    expect(Object.keys(got)).toHaveLength(Object.keys(input).length);
    // counter が literal 占有 slot (#3) を正しく跨いだ: gh(c) は #4 に着地する。
    // gh(*) キー (`ghp_…`) も literal `[REDACTED:github-token]#N` キーも、SEC-FINAL-3 の
    //   word-segment 判定では credential 扱いされない (`token]#N` が clean segment でない) ため
    //   値は素通りする。本テストの主眼は suffix 衝突解決の legacy 等価性。
    expect(got[base + "#4"]).toBe("v-c");
    expect(got[base + "#5"]).toBe("v-d");
    expect(got[base + "#6"]).toBe("v-e");
    // literal #3 は元値を保持 (衝突解決で破壊されない・credential 非該当で素通り)。
    expect(got[base + "#3"]).toBe("literal-3");
    // 後着の literal #2 は既存 #2(=v-b) と衝突するため再一意化され base#2#2 へ。値は保持。
    expect(got[base + "#2"]).toBe("v-b");
    expect(got[base + "#2#2"]).toBe("literal-2");
    // 通常キーはそのまま。
    expect(got.normal).toBe("plain");
  });

  it("SEC-v2 equivalence: randomized fuzz vs legacy stays byte-equal", () => {
    // ランダムに masked-collide キー / literal #N / 通常キーを混ぜ、複数試行で等価維持を確認。
    const gh = (n: number) => "ghp_" + String.fromCharCode(97 + (n % 26)).repeat(36);
    let rng = 0x9e3779b1;
    const rand = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 0x100000000;
    };
    for (let trial = 0; trial < 30; trial++) {
      const input: Record<string, unknown> = {};
      const count = 5 + Math.floor(rand() * 25);
      for (let i = 0; i < count; i++) {
        const r = rand();
        if (r < 0.5)
          input[gh(i)] = `m-${i}`; // masked collide
        else if (r < 0.75)
          input[`[REDACTED:github-token]#${2 + (i % 7)}`] = `lit-${i}`; // literal #N
        else input[`plain-${i}`] = `p-${i}`; // 通常キー
      }
      const got = JSON.stringify(redactValue(input));
      const expected = JSON.stringify(redactValueLegacy(input));
      expect(got).toEqual(expected);
    }
  });

  it(
    "INV-REDACTION-PERF: N=20000 masked-collide keys redact under threshold with zero data loss",
    () => {
      // 全キーが同一 [REDACTED:github-token] へ潰れる adversarial object。
      // 旧 O(N^2) 実装ならこの規模で ~数十秒掛かり閾値超過で赤。修正後は O(N) で緑。
      const N = 20000;
      // 各キーは Object 上は別エントリだが、redactString 後はすべて同一 [REDACTED:github-token]
      // へ潰れる (ghp_ + 36 文字英数字 = github-token 形)。値 i は全件一意 → 上書き消失を検出可能。
      const adversarial: Record<string, unknown> = {};
      for (let i = 0; i < N; i++) {
        // pad は base36 出力に現れない大文字 'A' を使う (小文字 [0-9a-z] と衝突しない →
        // 全 i で key 文字列が一意。'z' で pad すると 1260→"z0" が 0→"...z0" と衝突する)。
        const tail = i.toString(36).padStart(36, "A"); // 36 文字 [0-9a-zA]、全件マスク対象
        adversarial["ghp_" + tail] = i;
      }
      // (b) データ非損失は 1 回の結果で検証 (redactValue は非破壊・冪等ゆえ同一入力で再計測可)。
      const out = redactValue(adversarial) as Record<string, unknown>;
      expect(Object.keys(out)).toHaveLength(N);
      const vals = new Set(Object.values(out));
      expect(vals.size).toBe(N); // 値は 0..N-1 で全て一意 → 1 件も上書き消失していない。
      // 原文 secret キーは 1 つも残らない。
      const base = "[REDACTED:github-token]";
      for (const key of Object.keys(out)) {
        expect(key === base || key.startsWith(base + "#")).toBe(true);
      }
      // (a) 閾値 ms 未満。単発計測は加法ノイズ (GC/preemption/並列 contention) で benign O(N) も
      // 稀に予算超過し flaky 化するため、ReDoS budget と同 basis の best-of-N 最小値で判定する
      // (min は無競合の真の計算時間に最も近く、旧 O(N^2) は全 run で遅く min でも確実に超過し RED)。
      const elapsed = redosBestOfMs(() => redactValue(adversarial), REDOS_BUDGET_REPEAT);
      console.log(
        `[INV-REDACTION-PERF] redactValue N=${N} collide-keys best-of-${REDOS_BUDGET_REPEAT}: ${elapsed.toFixed(1)}ms`,
      );
      expect(elapsed).toBeLessThan(800);
    },
    REDOS_TEST_TIMEOUT_MS,
  );

  it(
    "INV-REDACTION-PERF: redactDeep linear scaling on nested adversarial payload",
    () => {
      // N スイープで線形性を確認 (N 倍 → 時間 ~倍)。O(N^2) なら 2 倍で ~4 倍に膨らみ閾値超過。
      const build = (n: number): Record<string, unknown> => {
        const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) o["ghp_" + i.toString(36).padStart(36, "A")] = i;
        return o;
      };
      const timeit = (n: number): number => {
        const payload = build(n);
        const out = redactDeep(payload) as Record<string, unknown>;
        expect(Object.keys(out)).toHaveLength(n);
        // best-of-N の最小値で計測 (redactDeep は非破壊・冪等ゆえ同一 payload で再計測可)。
        // 単発計測は加法ノイズで benign O(N) も稀に予算超過し flaky 化するため min basis に統一。
        return redosBestOfMs(() => redactDeep(payload), REDOS_BUDGET_REPEAT);
      };
      const t6k = timeit(6000);
      const t12k = timeit(12000);
      console.log(
        `[INV-REDACTION-PERF] redactDeep sweep best-of-${REDOS_BUDGET_REPEAT}: N=6000 ${t6k.toFixed(1)}ms, N=12000 ${t12k.toFixed(1)}ms`,
      );
      // N=12000 が予算内 (旧実装は ~7.5s)。min でも O(N^2) は確実に超過し RED。
      expect(t12k).toBeLessThan(1000);
    },
    REDOS_TEST_TIMEOUT_MS,
  );

  it("never persists/sends a secret used as an object KEY (McpCallStarted.arguments path, real SQLite)", () => {
    const store = new EventStore(":memory:");
    const seen: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) seen.push(row.event_json);
      },
    } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    // McpCallStarted.arguments に「token をキーに持つネスト object」を流す。
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "mcp.call.started",
      timestamp: new Date().toISOString(),
      summary: "mcp call",
      payload: {
        kind: "mcp.call.started",
        server: "srv",
        tool: "t",
        arguments: { env: { [GH_KEY]: "v" } },
      },
      metrics: {},
    });
    expect(ev).toBeDefined();

    // persist された行に原文キーが残らない。
    for (const row of store.allRows()) {
      expect(row.event_json, "raw secret KEY persisted to SQLite").not.toContain(GH_KEY);
      expect(row.event_json).toContain("[REDACTED:");
    }
    // 送信ペイロードにも残らない。
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join(""), "raw secret KEY sent over WS").not.toContain(GH_KEY);
    store.close();
  });
});

/**
 * SEC-FINAL-1 (H, leak): object の **credential キー名の値** が entropy/charset によらず
 * 確実にマスクされる (key→value 対称化)。
 *
 * 背景: redactObject は値に standalone string ルールのみ適用していたため、credential キーの
 *   下に entropy gate (classes>=3) を通らない 2-class base64 / `/`含み base64 値が入ると素通り
 *   していた。MCP tool result / hook payload (JSON object) に credential-key で base64 値が入る
 *   production 経路の leak。修正: キー名が CREDENTIAL_KEYWORDS を含めば string 値を無条件マスク。
 */
describe("INV-REDACTION-OBJVAL: object credential-key value masked unconditionally (SEC-FINAL-1)", () => {
  // 2-class (lower+upper) base64 — high-entropy gate (3 class) を通らない。
  const A2 = "viHBTzuWomMhbHhRiCTbAUdEloBlAHSJtAEpbgikcKxw";
  // `/`含み base64 (AWS secret 風)。
  const ASP = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYabc";

  const KEYS = [
    "api_key",
    "apikey",
    "password",
    "pwd",
    "token",
    "secret",
    "client_secret",
    "access_key",
    "private_key",
    "aws_secret_access_key",
    "accountkey",
    "auth",
  ];

  for (const key of KEYS) {
    it(`masks 2-class base64 value under credential key '${key}'`, () => {
      const out = redactDeep({ [key]: A2 }) as Record<string, unknown>;
      expect(JSON.stringify(out), `'${key}' 2-class value leaked`).not.toContain(A2);
      expect(JSON.stringify(out)).toContain("[REDACTED:");
    });

    it(`masks '/'-containing base64 value under credential key '${key}'`, () => {
      const out = redactDeep({ [key]: ASP }) as Record<string, unknown>;
      expect(JSON.stringify(out), `'${key}' '/'-value leaked`).not.toContain(ASP);
    });
  }

  it("masks credential-key value nested in result object (MCP tool result path)", () => {
    const out = redactDeep({ result: { api_key: A2, data: { access_key: ASP } } });
    const flat = JSON.stringify(out);
    expect(flat, "nested api_key leaked").not.toContain(A2);
    expect(flat, "nested access_key leaked").not.toContain(ASP);
  });

  it("does NOT mask non-credential key values (no spurious over-redaction)", () => {
    // credential keyword を含まないキーの 2-class 値は従来どおり温存 (構造の決定性)。
    const out = redactDeep({ name: A2, label: "hello-world", count: 3 }) as Record<string, unknown>;
    expect(out.name, "non-credential key value over-masked").toBe(A2);
    expect(out.label).toBe("hello-world");
    expect(out.count).toBe(3);
  });

  it("preserves empty-string credential value (nothing to mask)", () => {
    const out = redactDeep({ api_key: "" }) as Record<string, unknown>;
    expect(out.api_key).toBe("");
  });

  it("continues recursion for object/array values under credential keys, masking via CONTEXT (benign inner keys)", () => {
    // SEC-FINAL-2: credential キーの値が object/array なら構造を保持しつつ、配下の string を
    //   **文脈伝播で無条件マスク**する。inner key を benign (`raw`/`v`) にして、inner-key 救済では
    //   なく文脈伝播でマスクされることを固定する (旧テストの false-confidence を解消)。
    const out = redactDeep({
      token: { raw: A2, list: [ASP] },
    }) as Record<string, unknown>;
    const flat = JSON.stringify(out);
    // 内部の secret は benign inner key でも文脈伝播でマスクされる。
    expect(flat, "context-propagated nested secret leaked").not.toContain(A2);
    expect(flat).not.toContain(ASP);
    // object 構造は保持 (string 化されていない)。
    expect(typeof out.token).toBe("object");
    expect(Array.isArray((out.token as Record<string, unknown>).list)).toBe(true);
  });

  it("emit→SQLite/WS sees credential-key value masked only (real SQLite, SEC-FINAL-1)", () => {
    const store = new EventStore(":memory:");
    const seen: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) seen.push(row.event_json);
      },
    } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "mcp.call.completed",
      timestamp: new Date().toISOString(),
      summary: "mcp result",
      payload: {
        kind: "mcp.call.completed",
        server: "srv",
        tool: "t",
        ok: true,
        result: { api_key: A2, aws_secret_access_key: ASP },
      },
      metrics: {},
    });
    expect(ev).toBeDefined();
    for (const row of store.allRows()) {
      expect(row.event_json, "credential-key value persisted to SQLite").not.toContain(A2);
      expect(row.event_json).not.toContain(ASP);
      expect(row.event_json).toContain("[REDACTED:");
    }
    expect(seen.length).toBeGreaterThan(0);
    const blob = seen.join("");
    expect(blob, "credential-key value sent over WS").not.toContain(A2);
    expect(blob).not.toContain(ASP);
    store.close();
  });
});

/**
 * SEC-FINAL-2 (H, leak): credential キーの値が **array / nested object** のとき、配下の string が
 * standalone ルールのみ適用され (文脈喪失)、entropy/charset を通らない値 (2-class base64 /
 * 短い password) が素通りしていた。修正: credential 文脈を再帰へ伝播し、文脈下の全 string を
 * 無条件マスク。**inner key は benign** にして「inner-key 救済」ではなく「文脈伝播」で塞がる
 * ことを固定する (旧 OBJVAL テストの inner=credential-key による false-confidence を解消)。
 *
 * SEC-FINAL-3 (L, over-redaction): credential keyword の word-segment 化で benign キー
 * (`author`/`token_count`/`sigma_value`/`sasquatch_count`) を誤マスクしないことを固定。
 */
describe("INV-REDACTION-OBJVAL-NESTED: credential context propagation (SEC-FINAL-2)", () => {
  // standalone ルールで捕捉されない値: 2-class base64 / 短い password。
  const A2 = "viHBTzuWomMhbHhRiCTbAUdEloBlAHSJtAEpbgikcKxw";
  const SHORT = "hunter2pw";

  it("masks array value under credential key (string element, benign-less)", () => {
    const out = redactDeep({ api_keys: [A2, SHORT] });
    const flat = JSON.stringify(out);
    expect(flat, "array element under credential key leaked").not.toContain(A2);
    expect(flat).not.toContain(SHORT);
  });

  it("masks nested object value under credential key via CONTEXT (benign inner key)", () => {
    // inner key `raw` は benign → 文脈伝播でのみマスクされる (inner-key 救済ではない)。
    const out = redactDeep({ api_key: { raw: A2 } });
    expect(JSON.stringify(out), "nested benign-inner-key leaked").not.toContain(A2);
  });

  it("masks mixed map under 'credentials' (benign inner keys aws/pw)", () => {
    const out = redactDeep({ credentials: { aws: A2, pw: SHORT } });
    const flat = JSON.stringify(out);
    expect(flat, "credentials.aws leaked").not.toContain(A2);
    expect(flat, "credentials.pw (short) leaked").not.toContain(SHORT);
  });

  it("masks array under 'password' key (short password element)", () => {
    const out = redactDeep({ password: ["letmein123pw"] });
    expect(JSON.stringify(out), "password array element leaked").not.toContain("letmein123pw");
  });

  it("masks DEEP nested credential (credentials.aws.key) via context", () => {
    // 2 段ネスト: credentials (credential) → aws (benign) → key。文脈は最上位で確定し伝播。
    const out = redactDeep({ credentials: { aws: { key: A2 } } });
    expect(JSON.stringify(out), "deep nested credential leaked").not.toContain(A2);
  });

  it("masks array-of-objects under 'secret' key (benign inner key v)", () => {
    const out = redactDeep({ secret: [{ v: A2 }, { v: SHORT }] });
    const flat = JSON.stringify(out);
    expect(flat, "secret array-of-objects element leaked").not.toContain(A2);
    expect(flat).not.toContain(SHORT);
  });

  it("preserves structure (array stays array, object stays object) under context", () => {
    const out = redactDeep({ token: { list: [A2], meta: { v: SHORT } } }) as Record<
      string,
      unknown
    >;
    const tok = out.token as Record<string, unknown>;
    expect(Array.isArray(tok.list)).toBe(true);
    expect(typeof tok.meta).toBe("object");
  });

  it("emit→SQLite/WS sees context-propagated nested secret masked only (real SQLite)", () => {
    const store = new EventStore(":memory:");
    const seen: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) seen.push(row.event_json);
      },
    } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "mcp.call.completed",
      timestamp: new Date().toISOString(),
      summary: "mcp result",
      payload: {
        kind: "mcp.call.completed",
        server: "srv",
        tool: "t",
        ok: true,
        // credentials (credential) 配下に benign inner key の array/object。
        result: { credentials: { aws: { key: A2 }, list: [SHORT] } },
      },
      metrics: {},
    });
    expect(ev).toBeDefined();
    for (const row of store.allRows()) {
      expect(row.event_json, "context-propagated secret persisted to SQLite").not.toContain(A2);
      expect(row.event_json).not.toContain(SHORT);
      expect(row.event_json).toContain("[REDACTED:");
    }
    expect(seen.join(""), "context-propagated secret sent over WS").not.toContain(A2);
    store.close();
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
 * SEC-FINAL-4 (H, LEVEL 0): camelCase / PascalCase / 小文字 fused の `*Token` 系 credential キーが
 * `isCredentialKey` の `[_\-.]` word-segment split を素通りし、値が未マスクで SQLite/送信路へ漏れる。
 *
 * production の MCP tool result / hook payload JSON は camelCase キー (`accessToken`/`idToken`/
 * `csrfToken`/`sessionToken` 等) が常用される。高エントロピー gate を通らない 2-class base64 /
 * 短い値はこれらのキー下で INV-REDACTION を素通りしていた。
 *   修正: `isCredentialKey` の分割を camelCase 境界 (lower/digit → Upper) にも拡張し、末尾 segment が
 *   短曖昧 keyword か判定。さらに小文字 fused は `*token` 末尾連結のみ fail-safe で mask
 *   (`key`/`auth` 末尾 fused は monkey/oauth 誤爆ゆえ救済しない)。over-redaction は許容、leak は不可。
 */
describe("INV-REDACTION-OBJVAL: camelCase/fused credential key (SEC-FINAL-4)", () => {
  // 高エントロピー gate を通らない短め値 (= キー名判定だけが頼り)。
  const SECRET = "viHBTzuWomMhbHhRiCTbAUdEloBlAHSJtAEpbgikcKxw";
  const MASK_KEYS = [
    "authToken",
    "accessToken",
    "refreshToken",
    "sessionToken",
    "bearerToken",
    "AuthToken",
    "AccessToken",
    "xsrfToken",
    "csrfToken",
    "idToken",
    "jwtToken",
    "authtoken", // 小文字 fused
    "accesstoken", // 小文字 fused
    "apiKey", // camelCase Key 系 (compound 救済の回帰確認)
    "clientSecret",
    "accessKey",
    // QA-1: camelCase split 専属の head-noun (CREDENTIAL_COMPOUND_RE 非該当 = 新 split 経路のみ)。
    // これらが将来 refactor で silent leak しないよう契約固定する。
    "signingKey",
    "fernetKey",
    "userPwd",
    "dbPwd",
    "webhookSig",
    "blobSas",
    "myToken",
    // TDA-1: 小文字 fused の key/pwd/sig/sas 系 (token 限定では塞げず leak していた family)。
    "signingkey",
    "userpwd",
    "dbpwd",
    "requestsig",
    "blobsas",
    "storagesas",
    "hmacsig",
    // SEC-FINAL-5: head-keyword orientation (keyword が先頭 segment + 非 benign suffix)。
    // 末尾 suffix が metadata allowlist 外なら credential 扱い (fail-safe)。
    "tokenValue",
    "keyData",
    "keyMaterial",
    "authValue",
    "sigValue",
    "pwdHash",
    "sasUrl",
    "tokenBytes",
    "keySecret",
    // TDA-RE-1: 全小文字 fused-head (keyword 先頭 + secret-bearing suffix)。endsWith 限定では漏れた。
    "tokendata",
    "keydata",
    "sasurl",
    "pwdhash",
    "authblob",
    "keymaterial",
    "tokenbytes",
    // SEC-OBS-2: keyword 集合外の credential 語彙 (vocabulary gap)。
    "passphrase",
    "bearer",
    "hmacValue",
    "nonceValue",
    "saltValue",
    "otpCode",
    "mfaToken",
  ];
  for (const key of MASK_KEYS) {
    it(`masks camelCase/fused credential key '${key}' (string value)`, () => {
      const out = redactDeep({ [key]: SECRET }) as Record<string, unknown>;
      expect(out[key], `credential key '${key}' leaked plaintext`).not.toBe(SECRET);
      expect(String(out[key]), `credential key '${key}' not redacted`).toContain("[REDACTED:");
    });
    it(`masks camelCase credential key '${key}' through SQLite round-trip`, () => {
      const store = new EventStore(":memory:");
      const seen: string[] = [];
      const wsClient = {
        notifyAppended: () => {
          for (const row of store.pendingUnsent()) seen.push(row.event_json);
        },
      } as unknown as WsClient;
      const sink = new EventSink({ store, wsClient });
      const ev = sink.emit({
        event_id: newEventId(),
        provider: "claude_code",
        source: "hooks",
        session_id: "s1",
        event_type: "mcp.call.completed",
        timestamp: new Date().toISOString(),
        summary: "mcp result",
        payload: {
          kind: "mcp.call.completed",
          server: "srv",
          tool: "t",
          ok: true,
          result: { [key]: [SECRET] }, // array 値 = 文脈伝播経路も同時に確認
        },
        metrics: {},
      });
      expect(ev).toBeDefined();
      for (const row of store.allRows()) {
        expect(row.event_json, `'${key}' secret persisted to SQLite`).not.toContain(SECRET);
      }
      expect(seen.join(""), `'${key}' secret sent over WS`).not.toContain(SECRET);
      store.close();
    });
  }

  // over-redaction 回帰防止: token/key を含むが credential でない benign camelCase/fused キー。
  const KEEP_KEYS: Array<{ key: string; val: string }> = [
    { key: "tokenCount", val: "1500" }, // token は先頭 segment
    { key: "keyId", val: "abc-123" }, // key は先頭 segment
    { key: "keyboard", val: "mechanical" }, // key で始まる単語
    { key: "monkey", val: "george" }, // key で終わる benign 単語
    { key: "authorName", val: "Jane Doe" }, // auth ⊄ segment (author)
    { key: "sigmaValue", val: "42.5" }, // sig ⊄ segment (sigma)
    { key: "signaturePad", val: "canvas" }, // sig ⊄ segment (signature)
    // TDA-1 fused 一般化の誤爆控除: keyword 末尾で終わる一般英単語は benign allowlist で温存。
    { key: "donkey", val: "eeyore" }, // key 末尾だが一般語
    { key: "turkey", val: "thanksgiving" }, // key 末尾だが一般語
    { key: "whiskey", val: "single malt" }, // key 末尾だが一般語
    { key: "hotkey", val: "ctrl-s" }, // key 末尾だが UI 設定語
    { key: "oauth", val: "provider-google" }, // auth 末尾だが一般語 (OAuth)
    // SEC-FINAL-5 over-redaction 回帰: keyword 先頭でも suffix が benign-metadata なら温存。
    { key: "tokenType", val: "Bearer" }, // type ∈ keep-suffix
    { key: "keyName", val: "primary" }, // name ∈ keep-suffix
    { key: "tokenExpiry", val: "2030-01-01" }, // expiry ∈ keep-suffix
    { key: "keyVersion", val: "v3" }, // version ∈ keep-suffix
    { key: "authScheme", val: "Negotiate" }, // scheme ∈ keep-suffix
    { key: "sessionId", val: "sess-abc-123" }, // id ∈ keep-suffix (session ∉ keyword だが id 確認)
    // TDA-RE-1 fused-head over-redaction 回帰: keyword 先頭でも残りが secret-bearing でなければ温存。
    { key: "keyword", val: "search-term" }, // key 先頭 + word (非 secret-suffix)
    { key: "keyboard", val: "qwerty" }, // key 先頭 + board
    { key: "signal", val: "SIGTERM" }, // sig 先頭 + nal
    { key: "tokenize", val: "true" }, // token 先頭 + ize
  ];
  for (const { key, val } of KEEP_KEYS) {
    it(`keeps benign camelCase key '${key}' value verbatim`, () => {
      const out = redactDeep({ [key]: val }) as Record<string, unknown>;
      expect(out[key], `benign camelCase key '${key}' over-masked`).toBe(val);
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
 * 再#5c SEC-A (H, leak): urlsafe-base64 (`-`/`_`) secret + bare `*_KEY=` の捕捉。
 * 再#5c SEC-B (M, leak): 空ユーザ URL `scheme://:pass@host` の捕捉。
 *
 * high-entropy charset を urlsafe へ拡張し、credential keyword に `[_-]key` 境界を追加、
 * url-credential の user 部下限を 0 にした。secret 不在 (string + object + emit→SQLite)。
 */
describe("INV-REDACTION: urlsafe secret / bare *_KEY= / empty-user URL (再#5c SEC-A,B)", () => {
  const FERNET = "cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4="; // urlsafe (-_=) secret
  const GOOG_RT = "1//0eXampleRefreshToken-_abcDEF123ghIJKlmno-_pqrSTUvwx"; // Google refresh urlsafe

  it("SEC-A: masks standalone urlsafe (-/_) Fernet secret (high-entropy urlsafe charset)", () => {
    const out = redactString(`config loaded ${FERNET} done`);
    expect(out, "urlsafe Fernet leaked").not.toContain(FERNET);
    expect(out).toContain("[REDACTED:");
  });

  it("SEC-A: masks bare *_KEY= assignment (FERNET_KEY / SIGNING_KEY / ENCRYPTION_KEY)", () => {
    for (const key of ["FERNET_KEY", "SIGNING_KEY", "ENCRYPTION_KEY"]) {
      const out = redactString(`${key}=${FERNET}`);
      expect(out, `${key}= leaked`).not.toContain(FERNET);
      expect(out).toContain("[REDACTED:");
    }
  });

  it("SEC-A: masks Google refresh_token (urlsafe) via credential keyword", () => {
    const out = redactString(`refresh_token=${GOOG_RT}`);
    expect(out, "Google refresh_token leaked").not.toContain(GOOG_RT);
  });

  it("SEC-A: does NOT misfire on 'monkey='/'keyboard=' (bare [_-]key boundary, no false positive)", () => {
    // `[_-]key` 境界は `monkey`/`keyboard` (区切りなし) を credential 化しない。
    // 値が高エントロピーでなければ温存される (over-mask しない)。
    expect(redactString("monkey=banana")).toBe("monkey=banana");
    expect(redactString("keyboard=qwerty")).toBe("keyboard=qwerty");
  });

  it("SEC-A object path: masks urlsafe secret nested under FERNET_KEY (emit-reachable)", () => {
    const out = redactDeep({ env: { FERNET_KEY: FERNET } });
    expect(JSON.stringify(out), "object urlsafe key leaked").not.toContain(FERNET);
  });

  it("SEC-B: masks password-only URL scheme://:pass@host (redis / amqp)", () => {
    for (const [url, pw] of [
      ["redis://:RedisAuthPw123XYZ@h:6379", "RedisAuthPw123XYZ"],
      ["amqp://:RabbitPw456ABC@broker:5672/vhost", "RabbitPw456ABC"],
    ] as Array<[string, string]>) {
      const out = redactString(url);
      expect(out, `empty-user URL leaked: ${url}`).not.toContain(pw);
      expect(out).toContain("[REDACTED:");
    }
  });

  it("SEC-B object path: masks password-only URL value", () => {
    const out = redactDeep({ conn: "redis://:RedisAuthPw123XYZ@h:6379" });
    expect(JSON.stringify(out), "object empty-user URL leaked").not.toContain("RedisAuthPw123XYZ");
  });

  it("SEC-A reaches SQLite/WS masked only (emit→persist→send, urlsafe key)", () => {
    const store = new EventStore(":memory:");
    const seen: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) seen.push(row.event_json);
      },
    } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "command.output.delta",
      timestamp: new Date().toISOString(),
      summary: `loaded FERNET_KEY=${FERNET}`,
      payload: { kind: "command.output.delta", stream: "stdout", delta: `key ${FERNET}` },
      metrics: {},
    });
    expect(ev).toBeDefined();
    for (const row of store.allRows()) {
      expect(row.event_json, "urlsafe secret persisted to SQLite").not.toContain(FERNET);
      expect(row.event_json).toContain("[REDACTED:");
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join(""), "urlsafe secret sent over WS").not.toContain(FERNET);
    store.close();
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
 * 再#5d SEC-1 (H, leak) / SEC-2 (M, leak): two-stage gate の path 偽装漏れ。
 *
 * 確定原則: under-redaction(leak) の絶対回避 > over-redaction。判別不能は mask 側 (fail-safe)。
 * - SEC-1: 先頭 `/`・`./`・`../` 込みの 3-class secret run を path 誤判定し見送っていた
 *   (`/aB3xY9…`)。先頭区切りを剥がして本体を評価し、本体が非語的なら mask する。
 *   object value `/<secret>` (keyword 救済が効かない) を特に固定。
 * - SEC-2: slash 区切りの 3-class secret (各 segment 乱雑) を path 扱いしていた。
 *   全 segment が語的でなければ mask。
 */
describe("INV-REDACTION: path-disguised high-entropy secret (再#5d SEC-1,2 fail-safe)", () => {
  // 47 字 3-class secret (lower+upper+digit, 語でない)。
  const PSEC = "aB3xY9dEf2gH7iJ1kLmN5oP8qR0sT4uV6wX2yZ9aB3cD7eF";
  // slash 区切りでも全 segment 乱雑な 3-class secret。
  const SLSEC = "ab3Cd9ef2gh1ij7Kl1mn4op2qr5St8uv0wx6yz2ab9cdEF";

  it("SEC-1: masks secret with leading '/' prefix (strip separator then evaluate body)", () => {
    const out = redactString(`/${PSEC}`);
    expect(out, "'/'-prefixed secret leaked").not.toContain(PSEC);
    expect(out).toContain("[REDACTED:");
  });

  it("SEC-1: masks secret in HTTP request-line 'GET /<secret> HTTP/1.1'", () => {
    const out = redactString(`GET /${PSEC} HTTP/1.1`);
    expect(out, "request-line secret leaked").not.toContain(PSEC);
  });

  for (const prefix of ["./", "../"]) {
    it(`SEC-1: masks secret with '${prefix}' prefix`, () => {
      const out = redactString(`${prefix}${PSEC}`);
      expect(out, `'${prefix}'-prefixed secret leaked`).not.toContain(PSEC);
      expect(out).toContain("[REDACTED:");
    });
  }

  it("SEC-1 object path: masks '/<secret>' value (keyword rescue does NOT apply)", () => {
    for (const key of ["token_path", "api_key", "data"]) {
      const out = redactDeep({ [key]: `/${PSEC}` });
      expect(JSON.stringify(out), `object '${key}' '/'-secret leaked`).not.toContain(PSEC);
    }
  });

  it("SEC-2: masks slash-separated 3-class secret (segments not word-like)", () => {
    const payload = `blob ${SLSEC.slice(0, 11)}/${SLSEC.slice(11, 22)}/${SLSEC.slice(22)} x`;
    const out = redactString(payload);
    // どの segment 片も残らない。
    expect(out, "slash 3-class secret leaked").not.toContain(SLSEC.slice(22));
    expect(out).not.toContain(SLSEC.slice(0, 11));
    expect(out).toContain("[REDACTED:");
  });

  it("fail-safe: masks non-word kebab mixed-case token (resembles urlsafe secret)", () => {
    const kebab = "x7Q-z9b-K2v-R8m-N4t-L6w-J3p-H5d-F1s-G0y-C2e9";
    const out = redactString(`x ${kebab} y`);
    expect(out, "non-word kebab leaked").not.toContain(kebab);
  });

  it("SEC-1 reaches SQLite/WS masked only (emit→persist→send, '/'-prefixed secret)", () => {
    const store = new EventStore(":memory:");
    const seen: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) seen.push(row.event_json);
      },
    } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "mcp.call.started",
      timestamp: new Date().toISOString(),
      summary: "mcp call",
      payload: { kind: "mcp.call.started", server: "s", tool: "t", arguments: { p: `/${PSEC}` } },
      metrics: {},
    });
    expect(ev).toBeDefined();
    for (const row of store.allRows()) {
      expect(row.event_json, "'/'-secret persisted to SQLite").not.toContain(PSEC);
    }
    expect(seen.join(""), "'/'-secret sent over WS").not.toContain(PSEC);
    store.close();
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

/** v7 採番した secret 入り raw イベント候補 (sink が redact→parse する前提)。 */
function rawWithSecret(): Record<string, unknown> {
  return {
    event_id: newEventId(),
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.output.delta",
    timestamp: new Date().toISOString(),
    summary: "secret AKIAIOSFODNN7EXAMPLE here",
    payload: {
      kind: "command.output.delta",
      stream: "stdout",
      delta: "export GH=ghp_1234567890abcdefABCDEF1234567890abcd",
    },
    metrics: {},
  };
}

describe("INV-REDACTION: EventSink redact→persist→send 順序", () => {
  it("never persists raw secrets to SQLite", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    const ev = sink.emit(rawWithSecret());
    expect(ev).toBeDefined();

    for (const row of store.allRows()) {
      expect(row.event_json).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(row.event_json).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcd");
      expect(row.event_json).toContain("[REDACTED:");
    }
    store.close();
  });

  it("redaction happens BEFORE persist (append sees masked only)", () => {
    const store = new EventStore(":memory:");
    const appendSpy = vi.spyOn(store, "append");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    sink.emit(rawWithSecret());

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const persisted = JSON.stringify(appendSpy.mock.calls[0]?.[0]);
    expect(persisted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(persisted).toContain("[REDACTED:");
    store.close();
  });

  it("send path (notifyAppended) only sees masked rows", () => {
    const store = new EventStore(":memory:");
    const seen: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) seen.push(row.event_json);
      },
    } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    sink.emit(rawWithSecret());

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join("")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(seen.join("")).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcd");
    store.close();
  });

  it("WsClient has NO publish() bypass — store/WS reachable only via redacting EventSink (再#SEC-2)", () => {
    // publish() は store.append + WS 送信を redaction なしで行う迂回路だった (TDA-5: deadcode)。
    // 削除済みであることを構造で固定する。store.append への本番経路は EventSink.emit のみ。
    expect(
      (WsClient.prototype as unknown as Record<string, unknown>).publish,
      "WsClient.publish は redaction を迂回する choke-point の反例。削除を維持すること。",
    ).toBeUndefined();
    expect("publish" in WsClient.prototype).toBe(false);
  });

  it("store.append via sink only ever sees redacted events (no raw choke-point bypass)", () => {
    const store = new EventStore(":memory:");
    const appendSpy = vi.spyOn(store, "append");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    sink.emit(rawWithSecret());
    // append に渡る全イベントが redaction 済み (原文を含まない) である。
    for (const call of appendSpy.mock.calls) {
      const json = JSON.stringify(call[0]);
      expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(json).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcd");
    }
    store.close();
  });

  it("drops invalid events without leaking raw (parse failure → no persist)", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    // event_id が非 UUIDv7 → parse 失敗。raw は一切残らない。
    const ev = sink.emit({
      event_id: "not-a-uuid",
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "command.output.delta",
      timestamp: new Date().toISOString(),
      summary: "AKIAIOSFODNN7EXAMPLE",
      payload: { kind: "command.output.delta", stream: "stdout", delta: "x" },
      metrics: {},
    });
    expect(ev).toBeUndefined();
    expect(store.totalCount()).toBe(0);
    store.close();
  });

  // --- 再#QA-5: 検証失敗パスで raw を残さない契約 --------------------------------
  it("onValidationError is invoked WITHOUT raw payload, and nothing is persisted/sent", () => {
    const store = new EventStore(":memory:");
    const appendSpy = vi.spyOn(store, "append");
    const notified: string[] = [];
    const wsClient = {
      notifyAppended: () => notified.push("called"),
    } as unknown as WsClient;
    const errors: Array<{ eventType: string; message: string }> = [];
    const sink = new EventSink({
      store,
      wsClient,
      onValidationError: (eventType, message) => errors.push({ eventType, message }),
    });

    const ev = sink.emit({
      event_id: "not-a-uuid",
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "command.output.delta",
      timestamp: new Date().toISOString(),
      summary: "AKIAIOSFODNN7EXAMPLE secret here",
      payload: { kind: "command.output.delta", stream: "stdout", delta: "ghp_secretleak123" },
      metrics: {},
    });

    expect(ev).toBeUndefined();
    // (1) onValidationError は呼ばれるが raw (秘匿原文) を含まない。
    expect(errors).toHaveLength(1);
    expect(errors[0]?.eventType).toBe("command.output.delta"); // event_type のみ
    const errBlob = JSON.stringify(errors);
    expect(errBlob).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(errBlob).not.toContain("ghp_secretleak123");
    // (2) parse 失敗 → persist も send も起きない (raw が store/WS へ流れない)。
    expect(appendSpy).not.toHaveBeenCalled();
    expect(store.totalCount()).toBe(0);
    expect(notified).toHaveLength(0);
    store.close();
  });

  it("validation failure leaves the store completely empty (no raw row, no partial write)", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    // event_type 自体が不正 (enum 外) → parse 失敗。
    sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "totally.invalid.type",
      timestamp: new Date().toISOString(),
      summary: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      payload: {},
      metrics: {},
    });

    expect(store.totalCount()).toBe(0);
    for (const row of store.allRows()) {
      expect(row.event_json).not.toContain("wJalrXUtnFEMI");
    }
    store.close();
  });
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
 * INV-BYKIND-PROTO-SAFE (SEC-1, H / BLOCK 解消 decision 019ec6fd):
 *   prototype 継承プロパティ読み出しによる by-kind 型崩壊 → event drop を防ぐ。
 *
 * 旧バグ: 蓄積が素の `{}` で `out[kind] = (out[kind] ?? 0) + 1`。kind="constructor" のとき
 *   `out["constructor"]` が継承 `Object.prototype.constructor` (関数) に解決され `関数 + 1` →
 *   **文字列** → redaction_count_by_kind が文字列化 → parseEvent(z.number().int()) reject →
 *   sink が event 全体を drop。修正: Object.create(null) + 既知 kind allowlist の二重防御。
 *
 * mutation 反証: redactor.ts の Object.create(null) を `{}` に戻す → constructor ケースが
 *   文字列を返し型崩壊が再現 (本ブロック赤化)。allowlist も外せば phantom kind も載る。
 */
describe("INV-BYKIND-PROTO-SAFE (SEC-1): 継承プロパティ読み出しで by-kind が壊れない", () => {
  it("kind='constructor' は既知 kind でないため計上されず {} を返す (関数+1 文字列化なし)", () => {
    const out = countRedactionMarkersByKind("[REDACTED:constructor]");
    // 旧バグでは {constructor: "function Object() {...}1"} (文字列)。修正後は既知 kind 外で {}。
    expect(out).toEqual({});
    expect(out["constructor"]).toBeUndefined();
  });

  it("kind='hasownproperty' / 'tostring' 等の継承名も計上されない", () => {
    expect(countRedactionMarkersByKind("[REDACTED:hasownproperty]")).toEqual({});
    expect(countRedactionMarkersByKind("[REDACTED:tostring]")).toEqual({});
    // Deep 版も同様。
    expect(countRedactionMarkersByKindDeep({ a: "[REDACTED:constructor]" })).toEqual({});
  });

  it("継承名が紛れても既知 kind の件数は number のまま正しく数える", () => {
    const s = "[REDACTED:constructor] [REDACTED:github-token] [REDACTED:github-token]";
    const out = countRedactionMarkersByKind(s);
    expect(out).toEqual({ "github-token": 2 });
    expect(typeof out["github-token"]).toBe("number");
  });

  it("redactDeepWithCount の redactionCount は常に number (constructor マーカー混入でも崩れない)", () => {
    const r = redactDeepWithCount({ note: "[REDACTED:constructor] [REDACTED:github-token]" });
    expect(typeof r.redactionCount).toBe("number");
    // 方針 A: scalar は全マーカー数 (constructor 含む 2)。by_kind は既知 kind 部分集合 (github-token のみ 1)。
    expect(r.redactionCount).toBe(2);
    expect(r.redactionCountByKind).toEqual({ "github-token": 1 });
    // 正直な INV: sum(by_kind) <= redactionCount。
    const sum = Object.values(r.redactionCountByKind).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(r.redactionCount);
    expect(sum).toBe(1);
  });

  it("sink E2E: [REDACTED:constructor] を含む event は drop されず persist される (real SQLite)", () => {
    const store = new EventStore(":memory:");
    const seen: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) seen.push(row.event_json);
      },
    } as unknown as WsClient;
    let validationError: string | undefined;
    const sink = new EventSink({
      store,
      wsClient,
      onValidationError: (_et, msg) => {
        validationError = msg;
      },
    });

    // 良性 string がたまたま `[REDACTED:constructor]` を含む event。redaction_count_by_kind は
    //   sink が redacted から再算出するため、旧バグでは constructor 経由で文字列化 → parse reject。
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "agent.message.delta",
      timestamp: new Date().toISOString(),
      summary: "report mentioned [REDACTED:constructor] literally",
      payload: { kind: "agent.message.delta", delta: "[REDACTED:constructor]" },
      metrics: {},
    });

    // event は drop されず persist される (旧バグでは undefined + validationError)。
    expect(validationError).toBeUndefined();
    expect(ev).toBeDefined();
    expect(typeof ev!.redaction_count).toBe("number");
    expect(store.allRows().length).toBe(1);
    store.close();
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
