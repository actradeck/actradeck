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

/* global process, setTimeout, clearTimeout, AbortController */
// ↑ Node / Bun のランタイム global (依存ゼロ・import しない)。`.js` 化で eslint 対象に入るため
//   ファイルローカルに宣言する (globalThis.crypto / globalThis.fetch は globalThis 経由で参照)。

// ── 配送パラメータ (fail-open・有界) ────────────────────────────────────────
const RING_CAP = 1000; // 有界リングバッファ (最古 drop)
const MAX_RETRY = 3; // POST 失敗時の再送上限 (同一 event_id で at-least-once)
const FETCH_TIMEOUT_MS = 5000; // fetch のハングを防ぐ上限
const FLUSH_MAX_BATCH = 200; // 1 POST あたりの最大イベント数

// ── UUIDv7 自前実装 (event_id 必須・依存ゼロ) ────────────────────────────────
// ActraDeck の event_id は UUIDv7 のみ受理 (crypto.randomUUID は v4 で reject される)。
// globalThis.crypto (Web Crypto) は Node 22+ / Bun 双方で global に存在するため import 不要。
//
// TDA-5 (相互参照): UUIDv7 の hand-rolled 実装はリポジトリ内に 3 箇所ある —
//   (1) 本ファイル (外部 adapter・依存ゼロ制約ゆえ独立実装)、
//   (2) docs/examples/ingest-adapter/adapter.mjs (同・別の外部 adapter 例)、
//   (3) packages/event-model/src/id.ts (T1 正典・uuid@11 の v7 を使用)。
//   (1)(2) は「読者がコピペして動く単一ファイル」制約のため意図的に自前化しており、正典 (3) へ
//   依存しない (共通化しない設計判断)。ビット配置 (version 7 / variant 10xx) は 3 者で一致させる。
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
  };
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
    event_type: eventType,
    timestamp: stampTs(state, sessionId, sourceMs),
    ...extra,
  };
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

// opts (QA-2・全て任意・既定は production 挙動不変):
//   fetchImpl  — 注入可能な fetch (既定 globalThis.fetch)。テストで失敗/記録 fetch を差せる。
//   sleepImpl  — 注入可能な backoff sleep (既定 sleep)。テストで実時間待ちを無効化。
//   autoDrain  — enqueue が自動 drain するか (既定 true)。テストで false にして ring を決定的に検査。
// 返り値に pending()/size()/drain() を含め、有界リング/retry-drop/順序を外部から検証可能にする。
function createDelivery(config, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  const autoDrain = opts.autoDrain !== false;
  const ring = [];
  let draining = false;

  function enqueue(ev) {
    ring.push(ev);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP); // 有界リング: 最古を drop
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
    // 再送上限を超えたら drop (fail-open)
  }

  return {
    enqueue,
    drain,
    pending: () => ring.slice(),
    size: () => ring.length,
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
 * createDelivery / RING_CAP / MAX_RETRY) は **この default 関数のプロパティ**として付与する
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
  const delivery = createDelivery(config);
  const emit = (events) => {
    for (const ev of events) delivery.enqueue(ev);
  };
  return {
    // フックは enqueue のみ (配送を await しない = opencode をブロックしない fail-open)。
    event: async ({ event }) => {
      try {
        emit(mapEvent(event, state));
      } catch {
        /* fail-open */
      }
    },
    "tool.execute.before": async (input, output) => {
      try {
        emit(mapToolBefore(input, output, state));
      } catch {
        /* fail-open */
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        emit(mapToolAfter(input, output, state));
      } catch {
        /* fail-open */
      }
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
ActraDeckOpencodeAdapter.RING_CAP = RING_CAP;
ActraDeckOpencodeAdapter.MAX_RETRY = MAX_RETRY;
