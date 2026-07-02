/**
 * agent-visibility-wire — agent 観測可能性 (Claude/Codex が「セッションが cockpit に出る状態か」) を
 * sidecar→backend→webui へ運ぶ wire 射影 + 受信検証の **正準実装** (T1・単一出所).
 *
 * 背景 (ADR 019f1972 Phase 0・増分2 スライス2b・decision 019f1a29):
 * sidecar の `computeAgentVisibility()` (daemon 非依存の純ローカル検査) は CLI `agentmon doctor` でしか
 * 露出しない。cockpit の first-run readiness パネルで per-agent ✓/✗ を出すため、hello frame に optional
 * `agent_visibility` を相乗りさせ backend→webui へ運ぶ。信頼境界 (sidecar→backend) を越える新 field ゆえ、
 * 複数ティアが各々再解釈すると drift が連続バイパス源になる (security-gate-reuse-canonical-parser)。
 * よって wire 型 + 射影 + 受信検証 + 集約をここへ集約し、sidecar(射影)/backend(受信検証+集約)/webui(応答 parse)
 * が**手書きコピーを禁止して共有**する。
 *
 * NO-RAW 契約 (security.md): wire/endpoint には **boolean のみ**を載せる。パス・settings 内容・token・
 * 生 cwd は決して載せない (per-scope hook 詳細すら載せず CLI doctor 留保＝表面最小化)。`parseAgentVisibilityWire`
 * は既知の 4 boolean のみ抽出し**余剰 field を構造的に落とす**ため、buggy/adversarial daemon が追加 field に
 * パス等を詰めても parse 境界で消える (NO-RAW by construction)。
 *
 * 純粋・依存ゼロ・fs/net 非アクセス ＝ browser/edge でも安全。
 *
 * fail-safe 意味論:
 *  - 非 object / claude・codex sub-object 欠落・非 object → **undefined** (「この daemon は visibility 未報告」
 *    = 集約から除外)。例外は投げない。
 *  - sub-object はあるが個別 field が非 boolean → **false へ縮退** (安全側＝「未配線/未観測」。false positive で
 *    「配線済み」と誤主張しない)。
 *  - 集約 (`aggregateAgentReadiness`) は report 群を field ごと OR fold。空配列 → 全 false (誰も報告せず → 未観測)。
 */

/** agent 観測可能性の wire 射影 (NO-RAW・boolean のみ). */
export interface AgentVisibilityWire {
  /** Claude Code: PATH 上に binary があるか / ActraDeck hook がいずれかの scope に注入されているか. */
  readonly claude: { readonly binaryOnPath: boolean; readonly anyHook: boolean };
  /** Codex: PATH 上に binary があるか / rollout sessions ディレクトリが解決できるか (観測可能か). */
  readonly codex: { readonly binaryOnPath: boolean; readonly rolloutDirResolved: boolean };
}

/** 非 boolean を安全側 false へ縮退する (NO-RAW・false positive を作らない). */
function asBool(v: unknown): boolean {
  return v === true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * wire (untrusted・hello frame 由来) を `AgentVisibilityWire` へ検証射影する正準パーサ。
 * 既知 4 boolean のみ抽出し余剰 field を落とす (NO-RAW)。shape 不正は undefined (集約から除外・非 throw)。
 * backend `handleHello` 受信検証 + webui endpoint 応答 parse がこれを共有する。
 */
export function parseAgentVisibilityWire(raw: unknown): AgentVisibilityWire | undefined {
  if (!isPlainObject(raw)) return undefined;
  const claude = raw.claude;
  const codex = raw.codex;
  if (!isPlainObject(claude) || !isPlainObject(codex)) return undefined;
  return {
    claude: { binaryOnPath: asBool(claude.binaryOnPath), anyHook: asBool(claude.anyHook) },
    codex: {
      binaryOnPath: asBool(codex.binaryOnPath),
      rolloutDirResolved: asBool(codex.rolloutDirResolved),
    },
  };
}

/**
 * 複数 daemon の report を field ごと OR fold して machine 全体の観測可能性を導く。
 * visibility は machine-global (binary on PATH / user-scope hook / codex rollout dir) ゆえ、
 * いずれかの open daemon が見えていれば true とするのが「観測しているか」に忠実。
 * 空配列 → 全 false (誰も報告せず＝未観測・安全側).
 */
export function aggregateAgentReadiness(
  reports: readonly AgentVisibilityWire[],
): AgentVisibilityWire {
  return {
    claude: {
      binaryOnPath: reports.some((r) => r.claude.binaryOnPath),
      anyHook: reports.some((r) => r.claude.anyHook),
    },
    codex: {
      binaryOnPath: reports.some((r) => r.codex.binaryOnPath),
      rolloutDirResolved: reports.some((r) => r.codex.rolloutDirResolved),
    },
  };
}
