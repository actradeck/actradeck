import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

/**
 * SEC-1 (ADR 019eb1bc / 019eb1b7) test-isolation:
 *   real-PG INV テスト群は単一の :55432/actradeck を **ライブ stack(backend :55410 / webui :55400)
 *   と共有**する。vitest 既定の fileParallelism 下では、これら real-PG ファイルが **互いに並行書込み**し、
 *   shared PG の snapshot-visibility / cold-start 競合で INV-WALL-AGGREGATE の intra-lane ASC が一度
 *   flake (DESC で観測) した。SQL 自体は order-correct (psql replica + index (session_id,timestamp,event_id)
 *   で確認済) ゆえコード欠陥ではなく、real-PG 群を**直列化**して cross-file 書込み競合を排除する
 *   (純ロジックテストは並行維持し suite 速度を保つ)。ライブ DB スキーマは非改変 (DDL/migrate なし)。
 *
 * 直列化対象 = `dbReachable` gate を持ち実 PG へ書込む INV ファイル群。新規 real-PG テストを足したら
 * ここへ追記する (純ロジックは unit project が拾う)。`inv-token-no-log-leak` は dummy pool で接続しない
 * ため real-PG ではなく unit 側。
 */
const REAL_PG_TESTS = [
  // ADR 0014 Phase 4: 受入#6/#7 (real-PG writer・requested/合成 cancel を実 ingest 書込)。
  "test/inv-approval-reconcile.test.ts",
  // ADR 0014 Phase 4 R2 (TDA-3): 本番配線 (hello → onApprovalReconcile → ingestOne) の e2e ゲート。
  "test/inv-approval-reconcile-wiring.test.ts",
  "test/inv-safety-demo-backend-e2e.test.ts",
  "test/inv-audit-coverage.test.ts",
  "test/inv-audit-packet-route.test.ts",
  "test/inv-audit-report-route.test.ts",
  "test/inv-demo-state-reap.test.ts",
  "test/inv-detail-pull.test.ts",
  "test/inv-gemini-observability-ingest.test.ts",
  "test/inv-inbox.test.ts",
  "test/inv-ingest-store.test.ts",
  "test/inv-ingestion-server.test.ts",
  "test/inv-ingress-redaction.test.ts",
  "test/inv-liveness-parity.test.ts",
  "test/inv-redaction-backfill.test.ts",
  "test/inv-redaction-occurrences.test.ts",
  "test/inv-redaction-readlayer-symmetry.test.ts",
  "test/inv-realtime-server.test.ts",
  "test/inv-replay-history.test.ts",
  "test/inv-row-to-event.test.ts",
  "test/inv-run-lineage-persist.test.ts",
  "test/inv-wall.test.ts",
  // QA-B3R2-3 (B3 sweep): real-PG writer (実 ingest 書込) だが未登録だった (pre-existing omission)。
  "test/inv-work-items-wiring.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@actradeck/event-model": fileURLToPath(
        new URL("../../packages/event-model/src/index.ts", import.meta.url),
      ),
      // projection も src へ alias し、テストが built dist でなく実ソースを検証する
      //   (event-model と同方針)。SEC-1r read/carry 対称化 (merge prev gate) を src で固定する。
      "@actradeck/projection": fileURLToPath(
        new URL("../../packages/projection/src/index.ts", import.meta.url),
      ),
      // redaction も src へ alias。ingress redaction 床 (ingestOne) を built dist でなく
      //   実ソースで検証する (event-model / projection と同方針・ADR 019f2d2c D3)。
      "@actradeck/redaction": fileURLToPath(
        new URL("../../packages/redaction/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./test/setup-env.ts"],
    // SEC-1: real-PG 群のみ直列・純ロジックは並行 (projects は root の alias/setupFiles/environment を継承)。
    //   collection は projects のみが行う (root に include を残すと implicit project が二重計上する)。
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
          // real-PG 群は real-pg project で直列実行するため unit からは除外する。
          exclude: [...defaultExclude, ...REAL_PG_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "real-pg",
          include: REAL_PG_TESTS,
          // shared :55432 への cross-file 並行書込みを排除 (snapshot-visibility 競合の根因)。
          //   ファイル内 test は元から逐次。ファイル間も逐次化し決定性を担保する。
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.{test,spec}.ts",
        // QA-2: network 例外パスを **明示的に** 除外する (blanket 除外しない)。
        //   - index.ts: startFromEnv の `app.listen()` は実プロセス起動 (network bind)。
        //     残りは pure re-export。e2e/起動経路で担保し、unit カバレッジ対象外にする。
        //   - db.ts: createPool/isReachable は実 PG への pool 接続 (network)。INV 統合
        //     テストは helpers の `new Pool()` を直接使うため createPool 自体は通らない。
        //     接続確立コードを unit カバレッジで強制しない (実 PG 統合/起動で担保)。
        "src/index.ts",
        "src/db.ts",
        // backfill CLI wrapper: コアロジック (backfillRedactionCounts) は src/audit-backfill.ts
        //   (coverage 対象) へ抽出済で real-PG テストが検証する。src/scripts/ に残る main()
        //   (argv 解析 / console / pool 起動) は IO/エントリ wrapper ゆえ index.ts と同様に除外する。
        "src/scripts/**",
      ],
      reporter: ["text", "json-summary"],
      // QA-2: testing.md 契約 (statements>80 / branches>70 / functions>85) を **下回らせない**。
      //   閾値は「実測を割らず、かつ意味のある」値に置く。緩めすぎ禁止 (QA-1 の sink
      //   50→70 撤回の教訓: 契約 70 を下限に固定し、実測直下にタイトに張る)。
      //   除外後の実測 (2026-08-05・A2 sweep 時点): 全体 94.48/86.96/97.84/95.68。
      thresholds: {
        statements: 90,
        branches: 78,
        functions: 92,
        lines: 92,
        // コア領域 (state reducer / liveness 合成 / 冪等 store) は sidecar の sink/store
        //   並みに高く張る。実測直下でタイト。branches は testing.md 契約 70 を必ず超える。
        // 実測: reducer 96.29/95.83/100/100。
        "src/reducer.ts": { statements: 95, branches: 90, functions: 100, lines: 100 },
        // 実測: liveness 98.48/87.75/100/100。
        "src/liveness.ts": { statements: 95, branches: 85, functions: 100, lines: 100 },
        // 実測 (2026-08-05・A2 sweep: QA-4 共有 helper 化 + BoundedLruMap 抽出 + wiring テスト増後):
        //   ingest-store 95.13/81.74/97.29/96.38。QA-7: lines floor 93 は実測の 3.38pt 下 =
        //   per-file-coverage-floor 規律 (worst-observed の 3-5pt 下) を満たすため据え置き。
        //   branches=72 は契約 70 超を維持。
        "src/ingest-store.ts": { statements: 88, branches: 72, functions: 90, lines: 93 },
        // Realtime ③ (QA-3): INV-bearing なので実測直下でタイトに張り劣化を CI で止める。
        //   実測 (2026-06-04): hub 100/81.25/100/100, server 100/93.33/92.3/100,
        //   store 89.13/75.75/100/100, sidecar-registry 91.07/75/100/97.82。
        //   branches は全て契約 70 を超える (hub は 68.75→81.25 へ引き上げ済)。
        "src/realtime-hub.ts": { statements: 98, branches: 78, functions: 100, lines: 98 },
        // server: redaction drill-down route (d46bd48) が空 sessionId ガード (fastify ルーティング上
        //   到達不可・他 route の :226/:294 と同型の防御コード) を 1 行追加し 98→96 台へ。500 catch は
        //   forced-error テストで実カバー済。残る未到達は全 route 共通の defensive guard ゆえ実測直下
        //   (97.04/96.79) に張り直す (緩めでなく現実トラッキング・契約 70/80 は大幅超)。
        //   ADR 6点強化 #2: レビュー・パケット route (packet GET + packet/verify) を追加。GET の
        //   json/400/404/500-catch/format/dedup/25超 は fake-store guards + real-pg で実カバー、
        //   packet/verify の catch は decode/verify が内部 catch ゆえ到達不能な defensive guard
        //   (単一 verify と同型)。実測 (単一 run) 95.88/lines 96.84 → floor 94/95 = 実 margin ≈1.85pt
        //   (TDA-L1: 「3-5pt」は誤記・訂正)。route handler の statement/line 被覆は awaited で run 間安定
        //   (funcs のような小-N callback flake なし) ゆえ ≈1.85pt でも erosion tripwire として実運用可。
        //   ただし real-PG skip regime では packet route 分岐が落ちて CI-worst が下振れしうる (未計測)。
        "src/realtime-server.ts": { statements: 94, branches: 88, functions: 90, lines: 95 },
        "src/realtime-store.ts": { statements: 87, branches: 72, functions: 95, lines: 95 },
        "src/sidecar-registry.ts": { statements: 88, branches: 72, functions: 95, lines: 95 },
        // TDA-2 (decision 019f4241 TDA-1 の抽出着地監査): relay 安全側 deny 意味論の単一出所
        //   (timeout/未知 id 黙殺/rejectAll) ゆえ erosion tripwire を張る。実測 100/100/100/100
        //   (unit + relay INV 経由) → floor は worst-observed の 5-10pt 下 (per-file-coverage-floor-
        //   below-worst-not-best・branches は unref?.() 型分岐の環境揺れを見込み広めに)。
        "src/pending-round-trips.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // TDA-10 (Phase 4 R2): INV-APPROVAL-RECONCILE を担う新規モジュールに erosion tripwire。
        //   実測 100/92.85/100/100 (branches は SEC-4 の producer 検証 fail 枝が構造的到達不能で
        //   恒久未被覆 — 意図した防御床)。floor は worst-observed の 4-5pt 下
        //   (per-file-coverage-floor-below-worst-not-best: 実測に floor を張ると flaky RED)。
        "src/approval-reconciler.ts": { statements: 96, branches: 88, functions: 95, lines: 96 },
        // QA-2 (ADR 019f280c 監査): INV-SAFETY-DEMO + INV-DEMO-SPAWN-PATH-INDEPENDENT を担う
        //   INV-bearing ファイルに erosion tripwire を張る (global 90/78/92/92 だけでは silent erode)。
        //   実測 98.36/87.09/100/100。floor は WORST-observed の下 (per-file-coverage-floor-below-worst-
        //   not-best): funcs は 100/N 感度で callback 未発火の run に脆いため 92 まで下げて非 flaky に。
        "src/safety-demo.ts": { statements: 94, branches: 80, functions: 92, lines: 96 },
        // decision 019f387f: native-free driver + 定数/シーケンス script。driver は real-PG e2e
        //   (inv-safety-demo-backend-e2e) + 純ヘルパ unit で被覆。CLI main()/allow 分岐/signal 経路は
        //   未被覆ゆえ 100 ではない。floor は WORST-observed の下 (per-file-coverage-floor-below-worst-
        //   not-best): driver 実測 79.06/74.19/76/81.51 (awaited で run 間安定) → 3-6pt 下。funcs は
        //   小-N (main/onSignal 未発火) 感度で 6pt 余裕。script は 100/100/100/100 安定 (小さく pure)。
        "src/safety-demo-driver.ts": { statements: 74, branches: 69, functions: 70, lines: 76 },
        "src/safety-demo-script.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // ADR 6点強化 #1: tamper-evident audit の crypto (canonicalize/chain/ed25519 sign/verify) は
        //   security-critical ゆえ INV-AUDIT-INTEGRITY の erosion tripwire を張る。SEC-1 v2 rework 後の
        //   実測 (INV + route suite) 94.73/94.36/100/95.45。floor は WORST の下 (fail-safe crypto catch と
        //   funcs≠100 感度で flake 耐性・per-file-coverage-floor-below-worst-not-best)。
        "src/audit-integrity.ts": { statements: 88, branches: 85, functions: 92, lines: 88 },
        // ADR 6点強化 #2: レビュー・パケットのガバナンス導出 (hard/soft/auto) + 集約 + 描画。
        //   security/監査-relevant ゆえ erosion tripwire を張る。実測 97.46/80.85/100/97.29。floor は
        //   WORST の下 (branches は flagged/diff 分岐で 80 台・funcs は 100/N 感度で 92 まで下げ非 flaky)。
        "src/audit-packet.ts": { statements: 92, branches: 74, functions: 92, lines: 92 },
      },
    },
  },
});
