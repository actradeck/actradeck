/**
 * INV-REDACTION (P0 必須リグレッション, testing.md) — sink choke 統合層。
 *
 * 「秘匿情報が redaction 後に保存・送信路へ漏れない」を EventSink.emit の
 * redact→persist→send 順序 (実 SQLite / 実 WS 送信路) で検証する。redactor 単体の
 * ルール網羅性・マーカー計数・ReDoS 性能は @actradeck/redaction
 * (packages/redaction/test/redactor.test.ts) が担う (ADR 019f2d2c D3)。
 */
import { describe, expect, it, vi } from "vitest";

import { newEventId } from "@actradeck/event-model";

import {
  countRedactionMarkersByKind,
  countRedactionMarkersByKindDeep,
  redactDeep,
  redactDeepWithCount,
  redactString,
  redactValue,
} from "@actradeck/redaction";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import { WsClient } from "../src/ws-client.js";

// --- ReDoS scaling 共通基盤 (全ブロックをここに帰着させ basis ドリフトを防ぐ) ---
// NOTE (PR-1 TDA-2・意図的複製 = documented 受容): この redos 計測基盤 (redosMinOf/redosBestOfMs/
//   REDOS_TEST_TIMEOUT_MS/REDOS_BUDGET_REPEAT) は packages/redaction/test/redactor.test.ts の
//   同名ブロックと **verbatim 同期**している。共通化しない理由: (a) 純粋 ~11 行の timing helper で、
//   パッケージ境界を跨ぐ共有 test-utils 新設は過剰 (過剰工作禁止)、(b) 両パッケージとも test/** は
//   tsc 対象外 (tsconfig exclude) ゆえ型レベルの単一出所化利得が無い、(c) cross-package の相対 test
//   import はより脆く smell。redactor 移設時の意図的複製 (decision 019f2d4f)。**編集時は両コピーを同期**。
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
// (scaling ratio 閾値 REDOS_RATIO_MAX は redactor 単体の scaling テストと共に
//  packages/redaction/test/redactor.test.ts へ移設済。ここでは絶対 budget の best-of-N のみ使う。)
// 重い timing test の明示 timeout (best-of-N × 大入力で default 5s を踏むため・wall-clock 保護)。
const REDOS_TEST_TIMEOUT_MS = 20_000;
// 絶対 budget テスト用の best-of-N 反復数。スケーリング比 (ratio 精度が要る→default 15) と違い、
// 絶対 budget は「min < 予算」を広いマージン (実測 85ms vs 500ms / 345ms vs 1500ms) で見るだけ
// なので、加法スパイク除去に十分な少数で足りる (256KB×17 runs ≈ 6s の浪費・timeout 圧迫を避ける)。
const REDOS_BUDGET_REPEAT = 7;

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
