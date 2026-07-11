/**
 * ActraDeck 外部アダプタ第1号 — opencode plugin adapter (Triangle ADR 019f3c3b)。
 *
 * opencode (https://opencode.ai) の plugin フック (event bus + tool.execute.before/after) を
 * ActraDeck の NormalizedEvent へ写像し、backend の `POST /ingest` へ直接送る、
 * **依存ゼロ** (Node / Bun 組込みのみ) の単一ファイル plugin です。
 *
 *   provider = "opencode"   (WHO・公開契約の slug 開放・docs/ingestion-contract.md §4.1)
 *   source   = "external"   (HOW・第三者直取込の closed enum 値・§4.2)
 *   capture_mode 省略        (観測モード enum に external 値を足さない・ADR D2)
 *   request_id = "tu:<callID>" (コマンド/ツールの相関キー・INV-REQUEST-ID-NAMESPACE)
 *
 * 設置 (詳細は README.md):
 *   ~/.config/opencode/plugins/  または  <project>/.opencode/plugins/  に本ファイルを置く。
 *   export INGEST_TOKEN=...                       # backend の Bearer と一致させる
 *   export ACTRADECK_INGEST_URL=http://127.0.0.1:55410
 *   INGEST_TOKEN 未設定なら plugin は **静かに無効** (opencode を一切壊さない fail-open)。
 *
 * ── 姿勢の正直な開示 (ADR D4) ────────────────────────────────────────────────
 * この adapter は **client 側 redaction を持ちません** (依存ゼロのため)。secret に対する
 * 唯一の防御は ActraDeck backend の **ingress redaction 床** (契約 §5・保存前に無条件適用) です。
 * 「マシンを出る前に漏れない」とは **謳いません**。源流での最小化 (session.error 封筒の破棄・
 * diff の counts のみ送信) は「最小化」であって「redaction」ではありません。信頼境界は
 * single-operator / loopback / INGEST_TOKEN の内側です。
 *
 * ── observe-only ────────────────────────────────────────────────────────────
 * 本 adapter は **観測専用** です。承認 relay (allow/deny) は行いません。停止を断定しません
 * (opencode に session 終端イベントは存在しないため session.ended を捏造しない・ADR D2/D8)。
 */

/* global process, setTimeout, clearTimeout, setInterval, clearInterval, AbortController */
// ↑ Node / Bun のランタイム global (依存ゼロ・import しない)。`.js` 化で eslint 対象に入るため
//   ファイルローカルに宣言する (globalThis.crypto / globalThis.fetch は globalThis 経由で参照)。

// ── 配送パラメータ (fail-open・有界) ────────────────────────────────────────
const RING_CAP = 1000; // 有界リングバッファ (最古 drop)
const MAX_RETRY = 3; // POST 失敗時の再送上限 (同一 event_id で at-least-once)
const FETCH_TIMEOUT_MS = 5000; // fetch のハングを防ぐ上限
const FLUSH_MAX_BATCH = 200; // 1 POST あたりの最大イベント数

// ── turn 稼働中 heartbeat 間隔 (issue #8 / ADR 019f4cdb slice③) ───────────────
// turn 実行中のみ周期発行する heartbeat(process_alive:true) の間隔 (ms)。
// **20s** に固定する根拠: cockpit の liveness 監査は稼働 provider が `GAP_WARN_MS=60_000` (60s)
// 受信ゼロを「監査が blind ＝注意喚起 (amber)」の閾値とする
// (apps/webui/src/ui/audit-coverage-display.ts:26)。20s は 60s を **確実に下回る 3 倍マージン**で、
// 単発の drop / retry 遅延 (fail-open) や tick の位相ズレがあっても 60s 窓内に最低 1 発が着地する。
// この 20s⊂60s の結合は webui `GAP_WARN_MS` の **意図的 mirror** — import で機械強制せず (dep 逆流回避)、
// 変更時は audit-coverage-display.ts:26 の back-reference と同期すること (双方向 docs/コメント mirror)。
const HEARTBEAT_INTERVAL_MS = 20_000;

// ── UUIDv7 自前実装 (event_id 必須・依存ゼロ) ────────────────────────────────
// ActraDeck の event_id は UUIDv7 のみ受理 (crypto.randomUUID は v4 で reject される)。
// globalThis.crypto (Web Crypto) は Node 22+ / Bun 双方で global に存在するため import 不要。
//
// TDA-5 (相互参照): UUIDv7 の hand-rolled 実装はリポジトリ内に 4 箇所ある —
//   (1) 本ファイル (外部 adapter #1・依存ゼロ制約ゆえ独立実装)、
//   (2) docs/examples/gemini-adapter/adapter.mjs (外部 adapter #2・同・依存ゼロ)、
//   (3) docs/examples/ingest-adapter/adapter.mjs (最小取込 adapter 例・同)、
//   (4) packages/event-model/src/id.ts (T1 正典・uuid@11 の v7 を使用)。
//   (1)(2)(3) は「読者がコピペして動く単一ファイル」制約のため意図的に自前化しており、正典 (4) へ
//   依存しない (共通化しない設計判断)。ビット配置 (version 7 / variant 10xx) は 4 者で一致させる。
function randomBytes16() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function uuidv7() {
  const ms = Date.now();
  const b = randomBytes16();
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── アダプタ状態 (session 毎の floor / dedup) ────────────────────────────────
// pure 写像関数はこの state を受け取り、副作用を state (Map/Set) の更新に閉じる。
// now はテスト注入用の時刻源 (既定 Date.now)。
function createAdapterState(opts = {}) {
  return {
    now: typeof opts.now === "function" ? opts.now : Date.now,
    floorMs: new Map(), // session_id -> 直近に発行した timestamp(ms) の floor
    seenTurns: new Set(), // "<session>:<messageID>" turn.started 二重採番の抑止
    startedCalls: new Set(), // "<session>:<callID>" command/tool.started の dedup
    completedCalls: new Set(), // "<session>:<callID>" command/tool.completed の dedup
    seqCounters: new Map(), // session_id -> 次に採番する seq (0 起点・1 増分・全 emit 連番)
  };
}

/**
 * per-session の連続 seq を採番する (ADR 019f4cdb Phase2・silent-drop 下限検知)。
 * 同一 session_id 内で **0 起点・1 ずつ増分**する連番を返し、backend がこの連番の穴から
 * 「adapter は送ったが store に無い」中間イベントを下限で検知できるようにする。全 emit
 * (session.started / turn.* / delta / command / tool / diff / error / heartbeat) が makeEvent 経由で
 * この 1 本を通るため、seq は **発行順に連続**する (heartbeat も欠番を作らない)。
 */
function nextSeq(state, sessionId) {
  const cur = state.seqCounters.get(sessionId) ?? 0;
  state.seqCounters.set(sessionId, cur + 1);
  return cur;
}

/**
 * session 毎 monotonic timestamp floor (ADR D3・INV-OPENCODE-ADAPTER-MONOTONIC)。
 * 再送・並び替え・時刻源の巻き戻りがあっても、同一 session の発行 timestamp を
 * **非減少**に保つ。source ms が無いイベントは now() を基準にし、いずれも floor で持ち上げる。
 */
function stampTs(state, sessionId, sourceMs) {
  const base = Number.isFinite(sourceMs) ? sourceMs : state.now();
  const prev = state.floorMs.get(sessionId) ?? 0;
  const ms = Math.max(base, prev);
  state.floorMs.set(sessionId, ms);
  return new Date(ms).toISOString();
}

/** 共通フィールドを持つ NormalizedEvent を組み立てる (provider=opencode / source=external)。 */
function makeEvent(state, { sessionId, eventType, sourceMs, extra }) {
  return {
    event_id: uuidv7(),
    provider: "opencode",
    source: "external",
    session_id: sessionId,
    provider_session_id: sessionId,
    // per-session 連続 seq (silent-drop 下限検知・ADR 019f4cdb Phase2)。全 emit がこの 1 本を通るため
    // 発行順に連番となり、backend が区間内の穴から欠落を下限で数える。timestamp より先に採番する
    // 必要はないが、makeEvent 単一出所ゆえ heartbeat 含む全イベントで欠番が出ない。
    seq: nextSeq(state, sessionId),
    event_type: eventType,
    timestamp: stampTs(state, sessionId, sourceMs),
    ...extra,
  };
}

/**
 * turn 稼働中 heartbeat の NormalizedEvent を組み立てる (issue #8 / ADR 019f4cdb slice③)。
 * `event_type:"heartbeat"` / `payload:{kind:"heartbeat", process_alive:true}` の単一出所。
 * state を **省略**する (契約: heartbeat 等の状態を持たないイベントは state 省略可・event.ts:109)。
 * factory の onTick と heartbeat テストが同じこの関数を通す (event 形状の drift 防止)。
 */
function makeHeartbeatEvent(state, sessionId) {
  return makeEvent(state, {
    sessionId,
    eventType: "heartbeat",
    sourceMs: undefined, // now() 基準・session floor で monotonic に持ち上げる。
    extra: { payload: { kind: "heartbeat", process_alive: true } },
  });
}

// ── session.error の源流最小化 (ADR D2/D4・INV-OPENCODE-ADAPTER-ERROR-MINIMIZED) ──
// error 封筒から **安全な最小フィールドのみ** を構造的に抽出する。読むのは
// {error.name, error.data.message, error.data.isRetryable} だけで、responseHeaders /
// responseBody / metadata.url / statusCode は **一切 payload へ載せない** (by construction で破棄)。
// payload キー集合は {kind, message, retryable} に閉じる (QA-1: positive key-allowlist・
// 余剰キー混入で INV-ERROR-MINIMIZED が RED)。name は summary(表示専用) に畳み payload には残さない。
function mapSessionError(properties, sessionId, state) {
  const err = properties.error ?? {};
  const data = err.data ?? {};
  const name = typeof err.name === "string" ? err.name : undefined;
  const message =
    typeof data.message === "string"
      ? data.message
      : typeof err.message === "string"
        ? err.message
        : "error";
  const isRetryable = typeof data.isRetryable === "boolean" ? data.isRetryable : undefined;

  // payload は closed allowlist {kind, message, retryable} のみ。
  const payload = { kind: "error", message };
  if (isRetryable !== undefined) payload.retryable = isRetryable;

  return makeEvent(state, {
    sessionId,
    eventType: "error",
    sourceMs: undefined,
    // summary は表示専用の一行要約 (name を前置して人間可読にする・payload の最小性は不変)。
    extra: { summary: name ? `${name}: ${message}` : message, payload },
  });
}

/**
 * opencode の event bus イベント (`{ id, type, properties }`) を NormalizedEvent[] へ写像する。
 * 写像対象外 (session.status / session.updated / catalog.* / plugin.added / step-* 等) は
 * **意図的に drop** (空配列)。写像表は README.md / ADR 019f3c3b D2 参照。
 */
function mapEvent(event, state) {
  if (!event || typeof event !== "object") return [];
  const type = event.type;
  const p = event.properties ?? {};
  const info = p.info ?? {};
  const sessionId = p.sessionID ?? info.sessionID ?? info.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return [];

  switch (type) {
    case "session.created":
      return [
        makeEvent(state, {
          sessionId,
          eventType: "session.started",
          sourceMs: info.time?.created,
          extra: {
            state: "starting",
            cwd: typeof info.directory === "string" ? info.directory : undefined,
            summary: typeof info.title === "string" ? info.title : undefined,
            payload: { kind: "session.started" },
          },
        }),
      ];

    case "message.updated": {
      // user の初回 = turn 開始。assistant の再発火は metrics harvest ゆえ drop。
      // 同一 user message は複数回 message.updated が飛ぶため messageID で一度だけ採番。
      if (info.role !== "user") return [];
      const turnKey = `${sessionId}:${info.id}`;
      if (state.seenTurns.has(turnKey)) return [];
      state.seenTurns.add(turnKey);
      return [
        makeEvent(state, {
          sessionId,
          eventType: "turn.started",
          sourceMs: info.time?.created,
          extra: {
            state: "running.model_wait",
            turn_id: typeof info.id === "string" ? info.id : undefined,
            payload: { kind: "turn.started" },
          },
        }),
      ];
    }

    case "message.part.delta": {
      // text の streaming のみ model 出力として流す (field!=text は drop)。
      // QA-8=TDA-2: 配送は **投入順に batch 配列化**するのみで per-messageID 統合 (テキスト連結や
      //   messageID 単位の畳み込み) は **しない**。各 delta は独立イベントとして送られ、backend が
      //   event_id (UUIDv7) 冪等で吸収する。「messageID コアレス」の旧表現は虚偽ゆえ撤回 (R1 裁定)。
      if (p.field !== "text") return [];
      const delta = typeof p.delta === "string" ? p.delta : "";
      return [
        makeEvent(state, {
          sessionId,
          eventType: "agent.message.delta",
          sourceMs: undefined,
          extra: {
            state: "running.model_streaming",
            turn_id: typeof p.messageID === "string" ? p.messageID : undefined,
            payload: { kind: "agent.message.delta", delta },
          },
        }),
      ];
    }

    case "session.diff": {
      // 生 diff は送らず **counts のみ** (ADR D2)。
      const files = Array.isArray(p.diff) ? p.diff : [];
      return [
        makeEvent(state, {
          sessionId,
          eventType: "diff.updated",
          sourceMs: undefined,
          extra: { payload: { kind: "diff.updated", changed_files: files.length } },
        }),
      ];
    }

    case "session.error":
      return [mapSessionError(p, sessionId, state)];

    case "session.idle":
      // NO TERMINAL FABRICATION: idle は session 終端ではない。
      //   → turn.completed(state:idle)。session.ended は **産まない** (ADR D8)。
      return [
        makeEvent(state, {
          sessionId,
          eventType: "turn.completed",
          sourceMs: undefined,
          extra: { state: "idle", payload: { kind: "turn.completed" } },
        }),
      ];

    // 意図的 drop: message.part.updated(tool 部分は hook authoritative / text・step-* は構造メタ)、
    //   session.status / session.updated / catalog.updated / integration.updated / plugin.added /
    //   reference.updated 等 (写像表の drop 群・ADR D2)。
    default:
      return [];
  }
}

/**
 * tool.execute.before → command.started (bash) / tool.started (bash 以外)。
 * callID 単位で dedup (at-least-once 再送・message.part.updated(tool) との二重入力に耐える)。
 */
function mapToolBefore(input, output, state) {
  if (!input || typeof input !== "object") return [];
  const sessionId = input.sessionID;
  const callID = input.callID;
  if (typeof sessionId !== "string" || typeof callID !== "string") return [];
  const key = `${sessionId}:${callID}`;
  if (state.startedCalls.has(key)) return [];
  state.startedCalls.add(key);

  const args = output?.args ?? {};
  if (input.tool === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return [
      makeEvent(state, {
        sessionId,
        eventType: "command.started",
        sourceMs: undefined,
        extra: {
          state: "running.command_executing",
          summary: command,
          payload: { kind: "command.started", command, request_id: `tu:${callID}` },
        },
      }),
    ];
  }
  // bash 以外の tool (read/edit/write/grep/glob/webfetch 等) は tool.started へ。
  return [
    makeEvent(state, {
      sessionId,
      eventType: "tool.started",
      sourceMs: undefined,
      extra: {
        state: "running.tool_preparing",
        payload: { kind: "tool.started", tool_name: String(input.tool ?? "tool"), input: args },
      },
    }),
  ];
}

/**
 * tool.execute.after → command.completed (bash) / tool.completed (bash 以外)。
 * 非 0 exit も **command.completed** (command.failed は正規化 enum に無い・ADR D2)。
 */
function mapToolAfter(input, output, state) {
  if (!input || typeof input !== "object") return [];
  const sessionId = input.sessionID;
  const callID = input.callID;
  if (typeof sessionId !== "string" || typeof callID !== "string") return [];
  const key = `${sessionId}:${callID}`;
  if (state.completedCalls.has(key)) return [];
  state.completedCalls.add(key);

  if (input.tool === "bash") {
    const meta = output?.metadata ?? {};
    const exit = typeof meta.exit === "number" ? meta.exit : undefined;
    const command = typeof input.args?.command === "string" ? input.args.command : undefined;
    const payload = { kind: "command.completed", request_id: `tu:${callID}` };
    if (command !== undefined) payload.command = command;
    if (exit !== undefined) payload.exit_code = exit;
    return [
      makeEvent(state, {
        sessionId,
        eventType: "command.completed",
        sourceMs: undefined,
        extra: {
          state: "running.model_wait",
          summary: typeof output?.title === "string" ? output.title : undefined,
          payload,
        },
      }),
    ];
  }
  return [
    makeEvent(state, {
      sessionId,
      eventType: "tool.completed",
      sourceMs: undefined,
      extra: {
        state: "running.model_wait",
        payload: { kind: "tool.completed", tool_name: String(input.tool ?? "tool") },
      },
    }),
  ];
}

/**
 * 診断 probe が capture した `{ kind, data }` エンベロープ 1 行を写像する (fixture 駆動テスト共有)。
 * 実 plugin のフック引数を再構成して同じ写像関数へ委譲する (写像ロジックの単一出所)。
 */
function mapCaptureLine(line, state) {
  if (!line || typeof line !== "object") return [];
  switch (line.kind) {
    case "event":
      return mapEvent(line.data, state);
    case "tool.before":
      return mapToolBefore(line.data?.input, line.data?.output, state);
    case "tool.after":
      return mapToolAfter(line.data?.input, line.data?.output, state);
    default:
      return []; // plugin.init 等
  }
}

// ── 環境設定 (factory 内で遅延評価・top-level 副作用ゼロ) ─────────────────────
function resolveConfig(env) {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  const url = (e.ACTRADECK_INGEST_URL ?? "http://127.0.0.1:55410").replace(/\/$/, "");
  const token = e.INGEST_TOKEN ?? "";
  return { url, token, enabled: token.length > 0 };
}

// ── 配送 (fail-open・enqueue のみ・POST は非同期 drain) ───────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(attempt) {
  return Math.min(2000, 200 * 2 ** attempt);
}

// ── fail-open 可観測性 (TDA-4b) ──────────────────────────────────────────────
// fail-open は「opencode を壊さない」ために drop / mapping-error を **握り潰す** が、
// 握り潰しが完全に silent だと運用時に「なぜ cockpit に出ないか」を診断できない。
// そこで **原文非依存の件数** (drop 累計 / mapping-error 累計) を計上し、
// env `ACTRADECK_ADAPTER_DEBUG` (非空) のときのみ **enum + 件数のみ** の診断を stderr へ出す。
// NO-RAW: raw な event 内容・path・command・secret は一切書かない (kind/hook enum と非負整数のみ)。
// production (flag 無し) では stderr へ何も書かず挙動は不変。
// **module export しない** (loader-safe) — default factory のプロパティとして公開する。
function isDebugEnabled(env) {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  const v = e.ACTRADECK_ADAPTER_DEBUG;
  return typeof v === "string" && v.length > 0;
}

// 診断カウンタ (drop / mapping-error)。件数は非負整数のみ。stderr 出力は debug 有効時のみ。
// opts.env / opts.write はテスト注入用 (既定は process.env / process.stderr.write)。
function createDiagnostics(opts = {}) {
  const env = opts.env; // 省略時 isDebugEnabled が process.env を参照
  const write =
    typeof opts.write === "function"
      ? opts.write
      : (s) => {
          if (typeof process !== "undefined" && process.stderr) process.stderr.write(s);
        };
  let dropCount = 0;
  let mappingErrorCount = 0;
  function writeDebug(line) {
    if (!isDebugEnabled(env)) return;
    // SEC-1 (裁定後 unblock): 診断 write は **決して throw を呼び元へ戻さない**。
    // stderr が閉じた pipe (daemon 化 opencode) で EPIPE を投げると、noteDrop→enqueue→hook を
    // 貫通して opencode を壊す (fail-open 契約の破れ)。debug 診断は best-effort ゆえ握り潰す
    // (件数カウンタは既に更新済・診断が書けなくても drop 計数は保たれる)。
    try {
      write(`[actradeck-adapter] ${line}\n`);
    } catch {
      /* fail-open: 診断出力の失敗は enqueue/hook へ伝播させない */
    }
  }
  return {
    // reason は closed enum "ring-overflow" | "retry-cap"。n は今回落とした件数 (>=1)。
    noteDrop(reason, n = 1) {
      dropCount += n;
      writeDebug(`drop ${reason} count=${dropCount}`);
    },
    // hook は closed enum "event" | "tool.before" | "tool.after"。
    noteMappingError(hook) {
      mappingErrorCount += 1;
      writeDebug(`mapping-error hook=${hook} count=${mappingErrorCount}`);
    },
    drops: () => dropCount,
    mappingErrors: () => mappingErrorCount,
  };
}

// 写像フック共通の安全ラッパ。写像関数が throw したら diag へ計上し **空配列**を返す
// (fail-open: opencode を壊さない)。factory の 3 フックと共有し、mapping-error を可観測にする。
function safeMap(hook, fn, diag) {
  try {
    return fn();
  } catch {
    diag.noteMappingError(hook);
    return [];
  }
}

// opts (QA-2・全て任意・既定は production 挙動不変):
//   fetchImpl  — 注入可能な fetch (既定 globalThis.fetch)。テストで失敗/記録 fetch を差せる。
//   sleepImpl  — 注入可能な backoff sleep (既定 sleep)。テストで実時間待ちを無効化。
//   autoDrain  — enqueue が自動 drain するか (既定 true)。テストで false にして ring を決定的に検査。
//   diag       — 注入可能な診断カウンタ (TDA-4b・既定は内部生成)。factory は自身の diag を共有させる。
// 返り値に pending()/size()/drain()/dropped() を含め、有界リング/retry-drop/順序を外部から検証可能にする。
function createDelivery(config, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  const autoDrain = opts.autoDrain !== false;
  const diag = opts.diag ?? createDiagnostics(); // TDA-4b: drop 可観測性
  const ring = [];
  let draining = false;

  function enqueue(ev) {
    ring.push(ev);
    if (ring.length > RING_CAP) {
      const overflow = ring.length - RING_CAP;
      ring.splice(0, overflow); // 有界リング: 最古を drop
      diag.noteDrop("ring-overflow", overflow); // TDA-4b: silent drop を計上
    }
    if (autoDrain) void drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (ring.length > 0) {
        // pending を **投入順のまま** batch 配列にまとめて 1 POST する (per-messageID 統合はしない)。
        const batch = ring.splice(0, FLUSH_MAX_BATCH);
        await postBatch(batch);
      }
    } catch {
      // fail-open: 配送不達は opencode を壊さない (握り潰す)。
    } finally {
      draining = false;
    }
  }

  async function postBatch(batch) {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetchImpl(`${config.url}/ingest`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.token}`,
            },
            body: JSON.stringify(batch),
            signal: controller.signal,
          });
          if (res && res.ok) return; // 成功 (event_id 冪等ゆえ二重挿入は backend 側で吸収)
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // ネットワーク/timeout → 再送
      }
      if (attempt < MAX_RETRY) await sleepImpl(backoffMs(attempt));
    }
    // 再送上限を超えたら drop (fail-open)。TDA-4b: 落とした batch 件数を計上。
    diag.noteDrop("retry-cap", batch.length);
  }

  return {
    enqueue,
    drain,
    pending: () => ring.slice(),
    size: () => ring.length,
    // TDA-4b: ring 溢れ + retry 上限の drop 累計 (非負整数)。fail-open の可観測性。
    dropped: () => diag.drops(),
  };
}

// ── turn 稼働中 heartbeat スケジューラ (issue #8 / ADR 019f4cdb slice③) ────────
// turn 実行中のみ周期 heartbeat(process_alive:true) を発行し、cockpit の liveness 合成へ
// **process 生存シグナル**を供給する (稼働中の turn を stalled/idle と誤断定させない)。
// heartbeat は **timer 駆動** で mapEvent/mapCaptureLine の写像経路には一切載らない
//   (写像 histogram = 既知 10 種は不変・fixture 駆動テストにも現れない・純 additive)。
//
// fail-open / リーク防止 / 二重化防止 の 3 規律:
//   - fail-open: tick 内の onTick は try/catch で握り潰す (heartbeat 発行失敗で opencode を壊さない)。
//   - リーク防止: timer は **unref** し opencode プロセスの exit を妨げない。turn 停止で **確実に clear**。
//   - 二重化防止: active 集合が空→非空の遷移でのみ **単一** timer を張る (handle!==null なら再張しない)。
//     多重 turn / 割込みで turn.started が重なっても timer は 1 本 (各 session が 1 heartbeat/tick)。
//
// ライフサイクル (observe が発行済み NormalizedEvent 列から導出する):
//   turn.started              → 当該 session を active へ (開始)
//   turn.completed / error    → 当該 session を active から外す (turn 終了 / エラーで停止)
//   ※ opencode に session 終端イベントは無く adapter は session.ended を捏造しない (ADR D8) ため、
//     「セッション終了」は session.idle→turn.completed 経由で停止に落ちる。プロセス exit は unref が担う。
//
// opts.setTimer/clearTimer/onTick/intervalMs はテスト注入用 (既定 setInterval/clearInterval)。
function createHeartbeat(opts = {}) {
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : HEARTBEAT_INTERVAL_MS;
  const setTimer =
    typeof opts.setTimer === "function" ? opts.setTimer : (fn, ms) => setInterval(fn, ms);
  const clearTimer =
    typeof opts.clearTimer === "function" ? opts.clearTimer : (h) => clearInterval(h);
  const onTick = typeof opts.onTick === "function" ? opts.onTick : () => {};
  const active = new Set(); // heartbeat を出す session_id 集合 (turn 稼働中のみ非空)。
  let handle = null; // 単一 timer ハンドル (null = 停止中)。

  function tick() {
    // active の snapshot を回す (onTick が active を書き換えても走査を壊さない)。
    for (const sessionId of [...active]) {
      try {
        onTick(sessionId);
      } catch {
        /* fail-open: heartbeat 発行失敗は opencode を壊さない (timer は生かす) */
      }
    }
  }
  function ensureTimer() {
    if (handle === null && active.size > 0) {
      handle = setTimer(tick, intervalMs);
      // リーク防止: heartbeat timer は opencode プロセスの exit を妨げない。
      if (handle && typeof handle.unref === "function") handle.unref();
    }
  }
  function maybeStop() {
    if (handle !== null && active.size === 0) {
      clearTimer(handle); // turn 全停止で timer を確実に clear (リーク防止)。
      handle = null;
    }
  }
  function start(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    active.add(sessionId);
    ensureTimer(); // 空→非空でのみ張る (二重化防止)。
  }
  function stop(sessionId) {
    active.delete(sessionId);
    maybeStop();
  }
  // 発行済み NormalizedEvent 列を観測し turn ライフサイクルを heartbeat の on/off へ写す。
  // command.completed/tool.completed 等は {turn.started,turn.completed,error} に含まれず inert。
  function observe(events) {
    for (const ev of events) {
      const t = ev && ev.event_type;
      if (t === "turn.started") start(String(ev.session_id));
      else if (t === "turn.completed" || t === "error") stop(String(ev.session_id));
    }
  }
  return {
    start,
    stop,
    observe,
    activeCount: () => active.size,
    running: () => handle !== null,
  };
}

/**
 * opencode plugin factory (**default 単独 export**)。
 * 契約: `async ({ project, client, $, directory, worktree }) => ({ event, "tool.execute.before", "tool.execute.after" })`。
 * INGEST_TOKEN 未設定なら **静かに無効** (no-op hooks を返し opencode を壊さない)。
 *
 * ── ローダ互換のための default 単独 export (E2E-1・decision 019f3c99) ──────────
 * opencode 1.17.14 の plugin ローダは **モジュールの全 export を factory として呼び出す**
 * (named も default も両方)。かつ **非関数 export が 1 つでもあるとモジュール全体を silent reject**
 * する (実測: 数値 `export const RING_CAP` があるとファイルごと捨てられ、hook が一切登録されない)。
 * よって本 plugin は **default 関数ただ 1 つだけを export** し、pure helpers/定数 (uuidv7 /
 * createAdapterState / mapEvent / mapToolBefore / mapToolAfter / mapCaptureLine / resolveConfig /
 * createDelivery / createDiagnostics / safeMap / createHeartbeat / makeHeartbeatEvent /
 * RING_CAP / MAX_RETRY / HEARTBEAT_INTERVAL_MS) は **この default 関数のプロパティ**として付与する
 * (末尾)。named export は使わない (ローダが factory として誤呼出し + 非関数で poison するため)。
 * 公式 docs の named-export 例と実挙動は乖離しており、実挙動が勝つ (T1 > T3・README §8)。
 * INV-OPENCODE-ADAPTER-LOADER-SAFE が「namespace は default 単独・かつ関数」を回帰固定する。
 */
export default async function ActraDeckOpencodeAdapter() {
  const config = resolveConfig();
  if (!config.enabled) {
    return {}; // 静かに無効 (fail-open の一部)
  }
  const state = createAdapterState();
  const diag = createDiagnostics(); // TDA-4b: drop + mapping-error 可観測性 (factory クロージャ内)
  const delivery = createDelivery(config, { diag });
  const emit = (events) => {
    for (const ev of events) delivery.enqueue(ev);
  };
  // turn 稼働中 heartbeat (issue #8)。tick で active な各 session へ heartbeat(process_alive:true) を
  // enqueue する。emit は throw-free ゆえ onTick も throw-free (createHeartbeat の try/catch は保険)。
  const heartbeat = createHeartbeat({
    onTick: (sessionId) => {
      emit([makeHeartbeatEvent(state, sessionId)]);
    },
  });
  return {
    // フックは enqueue のみ (配送を await しない = opencode をブロックしない fail-open)。
    // 写像は safeMap で包み、throw を diag へ計上して空配列に縮退する (fail-open 維持 + 可観測)。
    // enqueue は throw-free (SEC-1: writeDebug が診断 write の throw を握るため noteDrop→enqueue は
    // 決して throw しない)。ゆえに emit も throw-free で opencode を壊さない (fail-open 契約)。
    // 各フック後に heartbeat.observe(発行済みイベント) で turn ライフサイクルを heartbeat の on/off へ反映。
    event: async ({ event }) => {
      const evs = safeMap("event", () => mapEvent(event, state), diag);
      emit(evs);
      heartbeat.observe(evs); // turn.started で開始 / turn.completed・error で停止。
    },
    "tool.execute.before": async (input, output) => {
      const evs = safeMap("tool.before", () => mapToolBefore(input, output, state), diag);
      emit(evs);
      heartbeat.observe(evs); // command/tool.started は inert (lifecycle 非該当)。
    },
    "tool.execute.after": async (input, output) => {
      const evs = safeMap("tool.after", () => mapToolAfter(input, output, state), diag);
      emit(evs);
      heartbeat.observe(evs); // command/tool.completed は inert (turn.completed とは別)。
    },
  };
}

// ── pure helpers/定数を default factory のプロパティとして公開 ────────────────
// これらは **module export ではない** (ローダは module export のみを factory として呼ぶ)。
// テスト (INV-OPENCODE-ADAPTER-*) と再利用はこのプロパティ経由で写像関数へアクセスする。
// named export に戻すと opencode ローダが factory 誤呼出し/poison するため厳禁
// (INV-OPENCODE-ADAPTER-LOADER-SAFE が RED で検出)。
ActraDeckOpencodeAdapter.uuidv7 = uuidv7;
ActraDeckOpencodeAdapter.createAdapterState = createAdapterState;
ActraDeckOpencodeAdapter.mapEvent = mapEvent;
ActraDeckOpencodeAdapter.mapToolBefore = mapToolBefore;
ActraDeckOpencodeAdapter.mapToolAfter = mapToolAfter;
ActraDeckOpencodeAdapter.mapCaptureLine = mapCaptureLine;
ActraDeckOpencodeAdapter.resolveConfig = resolveConfig;
ActraDeckOpencodeAdapter.createDelivery = createDelivery;
ActraDeckOpencodeAdapter.createDiagnostics = createDiagnostics; // TDA-4b (fail-open 可観測性)
ActraDeckOpencodeAdapter.safeMap = safeMap; // TDA-4b (写像 throw の計上ラッパ)
ActraDeckOpencodeAdapter.createHeartbeat = createHeartbeat; // issue #8 (turn 稼働中 heartbeat スケジューラ)
ActraDeckOpencodeAdapter.makeHeartbeatEvent = makeHeartbeatEvent; // issue #8 (heartbeat event 単一出所)
ActraDeckOpencodeAdapter.RING_CAP = RING_CAP;
ActraDeckOpencodeAdapter.MAX_RETRY = MAX_RETRY;
ActraDeckOpencodeAdapter.HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_MS; // issue #8 (20s < GAP_WARN_MS 60s)
