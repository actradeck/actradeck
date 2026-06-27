/**
 * 承認ブリッジ (土台) — 高リスク操作の承認なし自動実行を防ぐ。
 *
 * フロー (plan.md §12):
 *   Claude Code PreToolUse/PermissionRequest → Sidecar → (UI approval card) → User
 *   → Sidecar が hook 応答で allow/deny を返す。
 *
 * 安全側ポリシー (security.md):
 * - 高リスク操作 (rm -rf / chmod / migration / production / .env/secret access) は
 *   常に UI 承認を必要とする。応答なしタイムアウトは deny。
 * - low リスクかつ auto/acceptEdits/bypassPermissions モードでは defer (allow) して
 *   通常フローを妨げない (Managed の体験を壊さない)。
 *
 * MVP の土台: UI 接続 (WsClient.approval) を resolve 経路として配線。UI 未接続時は
 * タイムアウト → 安全側 (deny)。これは Phase 3/4 で UI が来るまでの最小実装。
 */
import { createHash, randomBytes } from "node:crypto";

import type { ApprovalDecision, ApprovalTrigger } from "@actradeck/event-model";
import { isKnownRedactionKind } from "@actradeck/event-model";

import type { ApprovalAllowlistStore } from "./approval-allowlist-store.js";
import { classifyCommandRisk, classifyTool, isPersistDeniedCommand } from "./normalize.js";
import type { HookCommonInput } from "./normalize.js";
import { countRedactionMarkersByKind, redactString } from "./redactor.js";

/**
 * 承認結果の behavior:
 * - allow: UI で明示承認された (allow / allow_for_session)、または同一署名の session-allow
 *   キャッシュ命中で自動承認された → tool を通す。
 * - deny: UI で拒否 (deny / cancel) / タイムアウト / shutdown → tool をブロック。
 * - defer: ゲート対象外 (low-risk) → Claude Code の通常 permission flow に委ねる。
 *   ⚠️ INV-APPROVAL: 「allow を勝手に返さない」。force-allow はユーザー自身の
 *   permission 設定を上書きしてしまうため、ゲート不要時は必ず defer を返す
 *   (decision 019e8e4b)。明示 allow は人間の UI 承認 or その人間が許可した同一署名のみ。
 */
export interface ApprovalResult {
  readonly behavior: "allow" | "deny" | "defer";
  readonly reason?: string;
  /** 段階③: UI が選んだ 4 値 decision (resolved イベントの表示用)。timeout/drain/auto は省略。 */
  readonly decision?: ApprovalDecision;
  /**
   * 段階③: emitRequest を経ずに同一署名 session-allow キャッシュで即 allow したか。
   * true のとき hook-receiver は resolved イベントを出さず通常観測 (command.started 等) する
   * (request_id 無しの resolved で他 pending を誤消去しないため)。
   */
  readonly autoAllowed?: boolean;
  /**
   * 永続 allowlist (ADR 019ee0c0) のディスク署名命中で即 allow したか。autoAllowed と併用し、
   * 観測イベントに persist_grant マーカーを付けて「再起動跨ぎ grant 由来」を監査識別可能にする。
   */
  readonly persistGrant?: boolean;
}

/**
 * 自動ガード (ADR 019ecc70 段階1): なぜ pause したか (理由) を承認要求に添える。
 * emitRequest コールバックの第 2 引数で渡し、hook-receiver → normalize 経由で
 * `tool.permission.requested` payload (trigger / secret_kinds) に載せる。
 *
 * INV-AUTOGUARD-NO-RAW: secretKinds は **redacted 文字列由来の kind 名のみ** (REDACTION_KINDS
 * allowlist)。原文 (秘匿値そのもの) はここにも emit にもログにも一切残さない。
 */
export interface GuardReason {
  /** "destructive" | "secret" | "both"。destructive と secret の OR・両立で "both"。 */
  readonly trigger: ApprovalTrigger;
  /** secret-trigger の kind 名 (REDACTION_KINDS allowlist のみ・原文ゼロ)。非 secret 時は []。 */
  readonly secretKinds: readonly string[];
  /**
   * 永続 allowlist (ADR 019ee0c0) 対象か。UI はこれが true のときのみ「再起動後も許可」を提示する
   * (medium-bash + 非 secret + repo 解決可 + feature-ON のときだけ true)。それ以外は false で、
   * 既存 4 値 (allow/allow_for_session/deny/cancel) のみ。codex/PermissionRequest は常に false。
   */
  readonly persistable: boolean;
}

/**
 * requiresHumanApproval の戻り値 (ADR 019ecc70 D4)。boolean を構造化し、destructive と
 * secret の検出結果を分解して保持する。`gated=false` のとき trigger は無く secretKinds は []。
 */
interface GateDecision {
  readonly gated: boolean;
  /** gated のときのみ意味を持つ理由 (gated=false では undefined)。 */
  readonly trigger?: ApprovalTrigger;
  readonly secretKinds: readonly string[];
}

interface PendingApproval {
  resolve: (r: ApprovalResult) => void;
  timer: NodeJS.Timeout;
  /** 段階③: allow_for_session 命中時に session-allow キャッシュへ登録する操作署名。 */
  readonly signature: string;
  /**
   * ADR 019ecc70 D5: この承認が allow_for_session で署名キャッシュへ登録**可能**か。
   * secret-trigger (secret|both) は false (auto-allow 非対象)。destructive-only は true。
   */
  readonly cacheable: boolean;
  /**
   * ADR 019ee0c0: 永続 allowlist へディスク登録**可能**か (medium-bash + 非 secret + repo 解決可
   * + feature-ON)。resolve で persist=true が来たときこの値が真のときのみディスクへ書く (degrade)。
   */
  readonly persistable: boolean;
  /** persistable のとき確定済みの repo スコープ (sha256 短縮) と表示用 basename。 */
  readonly repoScope?: string;
  readonly repoLabel?: string;
}

/**
 * 段階③ SEC-1 (ADR 019e9b83): 操作署名のエンコード単一出所 (collision-proof)。
 *
 * 3 フィールドを **JSON 配列でエンコード**してから sha256 する。JSON は各要素を quote/escape で
 * 曖昧さなく区切るため、どんな文字 (空白/quote/backslash/`,`/`]`/NUL 等) が operand に出現しても
 * **異なる (kind, risk, operand) が同一署名へ潰れることが構造的に不能** (語彙非依存の injectivity)。
 *
 * computeSignature から分離して **export** するのは、この injectivity 契約を behavior 経由でなく
 * 直接の単体テストで falsifiable にゲートするため (kind/risk が空白なし固定語彙のため behavior
 * 経由では delimiter-smear 衝突が到達不能 = naive-join mutation を赤化できなかった QA-A 所見)。
 * 例: `["bash","high","b c"]` と `["bash","high b","c"]` は素朴な空白連結なら同一文字列
 * `bash high b c` に潰れるが、JSON 配列なら別エンコードで別署名になる (テストがこれをゲートする)。
 */
export function encodeOperationSignature(kind: string, risk: string, operand: string): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, risk, operand]))
    .digest("hex");
}

/**
 * 永続 allowlist 設定 (ADR 019ee0c0)。未指定なら永続化機能は完全に無効 (既存挙動・非退行)。
 * eligibility (medium-bash 判定) は ApprovalBridge が行い、ストアは署名の保存/参照のみ担う。
 */
export interface ApprovalPersistConfig {
  /** 永続ストア (~/.actradeck/approvals/allowlist.json)。 */
  readonly store: ApprovalAllowlistStore;
  /** opt-in フラグ。false のとき disk エントリを honor しない (真の kill-switch)。 */
  readonly enabled: boolean;
  /** 永続 grant の TTL (ms)。add 時 expiresAt = now + ttlMs。 */
  readonly ttlMs: number;
  /**
   * cwd → repo スコープ解決。git root を解決し `{ scope: sha256短縮, label: basename }` を返す。
   * 解決不能 (cwd 無し / git 管理外) なら undefined = **永続化不可** (unscoped grant を作らない fail-safe)。
   */
  readonly resolveRepoScope: (
    cwd: string | undefined,
  ) => Promise<{ scope: string; label?: string } | undefined>;
  /** 現在時刻 (epoch ms)。テスト決定論化のため注入可。既定 Date.now。 */
  readonly now?: () => number;
}

/**
 * PAL-v2 (ADR 019ee147): 永続 allowlist の NO-RAW ビュー (UI/relay 用)。
 * **生コマンドを構造的に含まない** (signature=sha256 / repoScope=sha256短縮 / repoLabel=basename)。
 * PersistedApproval をそのまま使わず view を分けるのは、relay/表示の境界で「載せてよい値」を
 * 型で固定するため (将来 store に raw 隣接フィールドが増えても view が漏らさない)。
 */
export interface PersistedApprovalView {
  readonly signature: string;
  readonly repoScope: string;
  readonly repoLabel?: string;
  readonly risk: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface ApprovalBridgeOptions {
  /** UI 応答待ちタイムアウト (ms)。超過で安全側へ倒す。 */
  readonly timeoutMs?: number;
  /** タイムアウト時の既定動作 (security.md: ask/deny の安全側)。 */
  readonly timeoutBehavior?: "deny";
  /** 承認の再起動跨ぎ永続化 (ADR 019ee0c0)。未指定で無効。 */
  readonly persist?: ApprovalPersistConfig;
}

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;
  /**
   * 段階③: allow_for_session で人間が許可した操作の署名集合 (セッション内 = この sidecar
   * プロセスの寿命内のみ)。命中した同一署名の以降の要求は UI を経ず即 allow する。
   * **同一署名 (tool+risk+command/path) のみ**で、別 tool/別 risk/別コマンドは命中しない
   * (過剰 allow 防止・ADR 019e99ad scope=exact-signature)。プロセス終了で消える (永続しない)。
   */
  private readonly sessionAllowSignatures = new Set<string>();

  /** 永続 allowlist 設定 (ADR 019ee0c0)。未指定 (undefined) で機能無効。 */
  private readonly persist: ApprovalPersistConfig | undefined;
  /** 現在時刻 (注入可・既定 Date.now)。永続 TTL/expiry 判定に使う。 */
  private readonly now: () => number;

  constructor(opts: ApprovalBridgeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.persist = opts.persist;
    this.now = opts.persist?.now ?? (() => Date.now());
  }

  /**
   * 永続化対象 (medium-risk bash) か。high/secret/.env編集/MCP/WebFetch は false。
   * codex/CC PermissionRequest は呼び元で hook_event_name により除外するため、ここは bash 判定のみ。
   *
   * ADR 019ee0c0 / SEC-1/1a/1b/1c: medium でも **構造ゲート** (isPersistDeniedCommand) が永続不可と
   * 判定したものは false。合成メタ文字 (パイプ/置換/連結/リダイレクト/サブシェル)・危険 program
   * (権限昇格/インタプリタ inline/publish/network-exec/shell/ラッパ・version 接尾辞や `\`/クォートも
   * 分類器と同一正規化で正規化)・find -exec を排除する。承認ゲート自体は不変で「再起動後も無人
   * auto-allow」だけを禁じ「危険でないものに限り永続」の脅威モデル前提を守る。
   */
  private isPersistableBash(input: HookCommonInput): boolean {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (classifyTool(toolName) !== "bash") return false;
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") return false;
    if (classifyCommandRisk(command) !== "medium") return false;
    if (isPersistDeniedCommand(command)) return false; // SEC-1/1a/1b/1c: 構造ゲートで永続不可 (degrade)
    return true;
  }

  /**
   * 段階③: 操作の署名を算出する (allow_for_session の同一性判定キー)。
   * `sha256(JSON.stringify([kind, risk, operand]))`。**operand (command/path/args) を平文保持しない**
   * ためハッシュ化する (cache はメモリ内のみだが secret 混入の二重防御)。
   *
   * SEC-1 (ADR 019e9b7a): 3 フィールドを **JSON 配列でエンコード**してから hash する。JSON は
   * 各要素を quote/escape で曖昧さなく区切るため、どんな文字が operand に出現しても異なる
   * (kind, risk, operand) が同一署名に潰れることが**構造的に不能** (語彙非依存の collision-proof)。
   * 同一操作 → 同一署名、別操作 (別コマンド/別パス/別 risk/別 tool) → 必ず別署名で scope 越境を防ぐ。
   */
  private computeSignature(input: HookCommonInput): string {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const kind = classifyTool(toolName);
    const toolInput = (input.tool_input ?? {}) as { command?: unknown; file_path?: unknown };
    let risk = "n/a";
    let operand: string;
    if (kind === "bash" && typeof toolInput.command === "string") {
      risk = classifyCommandRisk(toolInput.command);
      operand = toolInput.command;
    } else if (kind === "edit" && typeof toolInput.file_path === "string") {
      operand = toolInput.file_path;
    } else {
      // mcp / websearch / other: tool 名 + 入力全体で識別 (args 差異を別署名にする)。
      let inputJson = "";
      try {
        inputJson = JSON.stringify(input.tool_input ?? null);
      } catch {
        inputJson = "<unserializable>"; // 異常入力は fail-safe で固定文字列 (別操作と衝突しても再承認側)。
      }
      operand = `${toolName}\0${inputJson}`;
    }
    return encodeOperationSignature(kind, risk, operand);
  }

  /**
   * request_id を高エントロピーで採番する (3#SEC-1)。
   *
   * 旧実装は `${sessionId}:apr-${Date.now()}-${seq}` で Date.now/連番が予測容易だった。
   * inbound 制御チャネル (WsClient) は同チャネルに request_id を observable にするため、
   * 予測可能な id は「foreign request_id 拒否 (SEC-2)」ゲートを総当たりで突破されうる。
   * 16 byte (128bit) の暗号乱数を base64url 化し、sessionId プレフィックスは「自セッション
   * スコープ判定 (SEC-2)」のために残す (突合は乱数部で行う)。
   */
  private nextRequestId(sessionId: string): string {
    return `${sessionId}:apr-${randomBytes(16).toString("base64url")}`;
  }

  /**
   * 既存の destructive 判定 (rm -rf / .env 編集 / MCP / WebFetch)。secret 判定とは独立で、
   * 自動ガード (D4) はこの結果を保持しつつ secret 検出を OR する。挙動は従来と非退行。
   */
  private requiresDestructiveApproval(input: HookCommonInput): boolean {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const kind = classifyTool(toolName);
    const toolInput = (input.tool_input ?? {}) as { command?: unknown; file_path?: unknown };
    if (kind === "bash" && typeof toolInput.command === "string") {
      return classifyCommandRisk(toolInput.command) !== "low";
    }
    // .env / secret / credential ファイルへの編集は常に承認。
    // fail-safe ゲート: secret らしき path は「広めの部分一致」で承認に倒す。
    //   - 部分一致は意図的: over-approval が安全側。anchor (^/$) を足すと網が狭まり
    //     "mysecret_notes" 等を取りこぼすため、CodeQL の missing-anchor 指摘は本ゲートでは
    //     不採用 (anchoring は coverage を縮小する=安全と逆)。
    //   - `.key` は末尾固定にしない: "server.key.bak" 等の鍵バックアップも承認に含める。
    //   - SSH 秘密鍵は 4 種 (rsa/ed25519/ecdsa/dsa)、keystore (.p12/.pfx/.jks)、credential
    //     file (.netrc/.pgpass/.npmrc)、kubeconfig も対象 (QA-1/SEC-2: 取りこぼし防止)。
    if (kind === "edit" && typeof toolInput.file_path === "string") {
      return /\.env|secret|credential|\.pem|\.key|\.p12|\.pfx|\.jks|id_(?:rsa|ed25519|ecdsa|dsa)|\.pgpass|\.netrc|\.npmrc|kubeconfig/i.test(
        toolInput.file_path,
      );
    }
    // 再#SEC-3: MCP tool 呼び出しは高リスク (副作用・credential server を含む)。
    // 個々の MCP server の安全性を sidecar は判定できない → 判定不能は high に倒す
    // (fail-safe; security.md「判定不能→high」)。
    if (kind === "mcp") return true;
    // 再#SEC-3: WebFetch は外部/内部 URL へ到達しうる (SSRF / メタデータ endpoint)。承認必須。
    // WebSearch (検索クエリのみ) は副作用が無いため defer のまま。
    if (kind === "websearch" && toolName === "WebFetch") return true;
    return false;
  }

  /**
   * 自動ガード (ADR 019ecc70 D1/D2): tool_input に secret が含まれるか検出する。
   *
   * - 検出述語は **単一出所** = redactor の既存 `redactString`。新正規表現は作らない。
   *   判定は `redactString(x) !== x` (= 何かマスクされた = secret 検出。ReDoS 既存有界)。
   * - 対象フィールドは ADR D2 の **閉じたリスト**のみ:
   *     Bash → command / Write・Edit 系 → content (+ new_string/new_str) + file_path /
   *     MCP (mcp__*) → tool_input payload (JSON.stringify を redactString に通す・bounded)。
   *   それ以外の tool は段階1 ではスキャンしない (段階2 拡張・D8)。
   * - secretKinds は **redacted 文字列から** countRedactionMarkersByKind で算出し、
   *   REDACTION_KINDS allowlist (isKnownRedactionKind) のみ採る。**raw 値からは作らない**
   *   (INV-AUTOGUARD-NO-RAW)。raw は述語評価のために読むが戻り値/emit/ログに残さない。
   *
   * 戻り値: { secret: boolean; kinds: string[] }。secret=false のとき kinds=[]。
   */
  private detectSecretInInput(input: HookCommonInput): { secret: boolean; kinds: string[] } {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const kind = classifyTool(toolName);
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    // D2: スキャン対象フィールドを閉じたリストで収集する (それ以外は段階1 で見ない)。
    const fields: string[] = [];
    if (kind === "bash") {
      if (typeof toolInput.command === "string") fields.push(toolInput.command);
    } else if (kind === "edit") {
      // Write/Edit/MultiEdit/NotebookEdit の本文系 + file_path。
      for (const key of ["content", "new_string", "new_str"]) {
        const v = toolInput[key];
        if (typeof v === "string") fields.push(v);
      }
      if (typeof toolInput.file_path === "string") fields.push(toolInput.file_path);
    } else if (kind === "mcp") {
      // MCP payload 全体を JSON 文字列化して走査 (失敗時は fail-safe で空文字 = 非検出側だが
      // MCP は destructive ゲートで別途必ず gated になるため secret 未検出でも承認は出る)。
      try {
        fields.push(JSON.stringify(input.tool_input ?? null));
      } catch {
        // 直列化不能な入力は走査不能。MCP は requiresDestructiveApproval=true で gated 済。
      }
    }
    // それ以外の tool (websearch/other): 段階1 はスキャンしない。

    const kinds = new Set<string>();
    let secret = false;
    for (const field of fields) {
      if (field.length === 0) continue;
      // 単一述語: redactString が値を変えた = secret 検出 (raw は保持しない)。
      const redacted = redactString(field);
      if (redacted !== field) {
        secret = true;
        // kind は **redacted 文字列由来** (raw 由来でない)。allowlist のみ採る。
        for (const k of Object.keys(countRedactionMarkersByKind(redacted))) {
          if (isKnownRedactionKind(k)) kinds.add(k);
        }
      }
    }
    return { secret, kinds: [...kinds] };
  }

  /**
   * この hook が UI 承認を要するか (ADR 019ecc70 D4)。
   * destructive 判定 (従来) と secret 検出 (新規) を **OR** し、両立で trigger="both"。
   * gated=false のときは従来どおり defer (force-allow しない)。
   */
  private requiresHumanApproval(input: HookCommonInput): GateDecision {
    const destructive = this.requiresDestructiveApproval(input);
    const { secret, kinds } = this.detectSecretInInput(input);
    if (!destructive && !secret) return { gated: false, secretKinds: [] };
    const trigger: ApprovalTrigger =
      destructive && secret ? "both" : secret ? "secret" : "destructive";
    // secretKinds は secret-trigger のときのみ意味を持つ (destructive-only は [])。
    return { gated: true, trigger, secretKinds: secret ? kinds : [] };
  }

  /**
   * PermissionRequest (CC PermissionRequest / codex 承認 ServerRequest) のゲート判定 (ADR 019ecc70
   * 段階2)。要求自体が承認を要するため **常時 gated**。これは不変 (codex は既に承認を要求している)。
   * 加えて tool_input に secret があれば trigger を destructive→both へ昇格し secretKinds を付与する:
   *   - 承認カードに secret 種別 (REDACTION_KINDS 名) を表示できる。
   *   - secret-trigger (both) は D5 で allow_for_session の auto-allow 非対象になる。
   * secret 無しは従来どおり destructive-only (非退行)。codex で tool_input が無い承認
   * (file/permissions) は detectSecretInInput が空を返し従来挙動。
   */
  private gatePermissionRequest(input: HookCommonInput): GateDecision {
    const { secret, kinds } = this.detectSecretInInput(input);
    return {
      gated: true,
      trigger: secret ? "both" : "destructive",
      secretKinds: secret ? kinds : [],
    };
  }

  /**
   * 承認を要求する。emitRequest は「承認要求イベント」を発行するコールバック
   * (UI が承認カードを出せる)。UI から resolve() が来るか、タイムアウトで安全側に倒す。
   *
   * PreToolUse の low-risk は即 allow (defer 相当) で通常フローを妨げない。
   */
  async requestApproval(
    input: HookCommonInput,
    emitRequest: (requestId: string, reason: GuardReason) => void,
  ): Promise<ApprovalResult> {
    // bypassPermissions (`--dangerously-skip-permissions`): ユーザーが全 permission を明示的に
    // スキップしている。ActraDeck は CC が選んだモードより強いゲートを課さず純観測に徹する
    // (ユーザー指示・decision 019eace6)。force-allow せず **defer** = native flow へ委譲する
    // ため INV-APPROVAL を維持しつつ、bypass では即実行される (承認カード=emitRequest を出さない)。
    // 観測は呼び元 hook-receiver の defer 経路が PreToolUse を従来どおり ingest する。
    // ⚠️ 注意: 既定/acceptEdits/plan など bypassPermissions 以外のモードでは従来どおり高リスクを
    // ゲートする (decision 019e8e71 の破壊的操作ゲートを当該モードでは温存)。
    if (input.permission_mode === "bypassPermissions") {
      return { behavior: "defer", reason: "bypassPermissions: user opted out of approval gating" };
    }

    // PermissionRequest は常にゲート (要求自体が承認要)。PreToolUse は requiresHumanApproval。
    // ADR 019ecc70 段階2: PermissionRequest でも tool_input があれば secret-in-input を検出し、
    //   destructive 常時ゲートに secret-trigger を OR する (codex 承認経路の secret 可視化 + D5)。
    const gate: GateDecision =
      input.hook_event_name === "PermissionRequest"
        ? this.gatePermissionRequest(input)
        : this.requiresHumanApproval(input);

    if (!gate.gated) {
      // ゲート対象外: force-allow せず通常 permission flow に委ねる (INV-APPROVAL)。
      return { behavior: "defer", reason: "not gated; defer to normal permission flow" };
    }

    const trigger: ApprovalTrigger = gate.trigger ?? "destructive";

    // ADR 019ecc70 D5: secret-trigger (secret|both) は allow_for_session の auto-allow 非対象。
    // secret 露出は sensitive・文脈依存ゆえ「一度許可=同型無人 allow」を許さない (放牧の安全性)。
    // destructive-only は従来どおり cache を使う。
    const secretTriggered = trigger === "secret" || trigger === "both";

    const signature = this.computeSignature(input);

    // 段階③: 同一署名を allow_for_session で人間が許可済みなら、UI を経ず即 allow する
    // (in-memory・cheap・先に確認)。**同一署名のみ**命中するため、別操作は依然ゲートされる。
    // D5: secret-trigger は cache をバイパスし常に UI 承認を要求する。
    if (!secretTriggered && this.sessionAllowSignatures.has(signature)) {
      return {
        behavior: "allow",
        reason: "allow_for_session: matching signature previously approved this session",
        autoAllowed: true,
      };
    }

    // ADR 019ee0c0: 永続 allowlist (再起動跨ぎ)。eligibility = feature-ON + 非 secret +
    // **PreToolUse の medium-bash** (codex/PermissionRequest・high・edit・mcp・websearch は構造的に除外)
    // + repo 解決可。repo スコープ解決は eligible なときだけ行う (非対象では git を叩かない)。
    let persistable = false;
    let repoScope: string | undefined;
    let repoLabel: string | undefined;
    if (
      this.persist?.enabled === true &&
      !secretTriggered &&
      input.hook_event_name === "PreToolUse" &&
      this.isPersistableBash(input)
    ) {
      const resolved = await this.persist.resolveRepoScope(input.cwd);
      if (resolved !== undefined) {
        repoScope = resolved.scope;
        repoLabel = resolved.label;
        persistable = true;
        // ディスク署名命中 → UI を経ず即 allow (persistGrant)。期限切れは has が false を返す。
        if (this.persist.store.has(signature, repoScope, this.now())) {
          return {
            behavior: "allow",
            reason: "persistent allowlist: matching signature previously persisted for this repo",
            autoAllowed: true,
            persistGrant: true,
          };
        }
      }
    }

    const reason: GuardReason = { trigger, secretKinds: gate.secretKinds, persistable };

    const requestId = this.nextRequestId(input.session_id);
    emitRequest(requestId, reason);

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ behavior: "deny", reason: "approval timeout (safe default: deny)" });
      }, this.timeoutMs);
      // D5: secret-trigger は resolve で allow_for_session が来ても署名を登録しない
      // (cacheable=false)。destructive-only のみ後で cache 登録しうる。
      // ADR 019ee0c0: persistable / repoScope を保持し、resolve の persist=true で disk 登録する。
      this.pending.set(requestId, {
        resolve,
        timer,
        signature,
        cacheable: !secretTriggered,
        persistable,
        ...(repoScope !== undefined ? { repoScope } : {}),
        ...(repoLabel !== undefined ? { repoLabel } : {}),
      });
    });
  }

  /**
   * UI からの承認決定 (4 値 ApprovalDecision) を解決する (WsClient.approval から呼ばれる)。
   * 段階③:
   *  - allow            → allow。
   *  - allow_for_session → allow + 当該操作の署名を session-allow キャッシュへ登録
   *                        (以降この署名は UI を経ず即 allow)。
   *  - deny             → deny。
   *  - cancel           → deny (安全側。hook には deny を返し pending を破棄)。
   * 4 値以外は呼び出し側 (sidecar.ts) で enum 検証して破棄するため、ここには届かない。
   *
   * ADR 019ee0c0: 第 4 引数 persist=true (UI「再起動後も許可」) は decision=allow_for_session かつ
   * persistable のときのみディスク永続 allowlist へ登録する (非対象は session-only に degrade)。
   */
  resolve(
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
    persist = false,
  ): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    const behavior: "allow" | "deny" =
      decision === "allow" || decision === "allow_for_session" ? "allow" : "deny";
    // allow_for_session のみ署名を登録 (allow/deny/cancel は登録しない)。
    // D5: secret-trigger (cacheable=false) は allow_for_session でも署名を登録しない
    // (同型 secret 再要求でも UI 承認を要求する = auto-allow 非対象)。
    if (decision === "allow_for_session" && p.cacheable) {
      this.sessionAllowSignatures.add(p.signature);
      // ADR 019ee0c0: persist=true かつ persistable (medium-bash + repo 解決済 + feature-ON) のときのみ
      // ディスクへ永続する。非 persistable で persist=true が来ても session-only に degrade (fail-safe)。
      // 署名は sha256 のみ・生コマンドは保存しない (NO-RAW)。
      if (persist && p.persistable && p.repoScope !== undefined && this.persist?.enabled === true) {
        this.persist.store.add({
          signature: p.signature,
          repoScope: p.repoScope,
          ...(p.repoLabel !== undefined ? { repoLabel: p.repoLabel } : {}),
          risk: "medium",
          ttlMs: this.persist.ttlMs,
          now: this.now(),
        });
      }
    }
    p.resolve({ behavior, decision, ...(reason !== undefined ? { reason } : {}) });
    return true;
  }

  /** 保留中の承認件数 (検証・shutdown 用)。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * PAL-v2 (ADR 019ee147): 永続化 honor フラグ (UI が dormant 表示するため)。
   * persist 未設定 (機能完全無効) でも false を返す。
   */
  get persistEnabled(): boolean {
    return this.persist?.enabled === true;
  }

  /**
   * PAL-v2: 永続 allowlist を一覧する (期限内のみ・NO-RAW ビュー)。
   * **enabled 非依存**: 管理パネルは実 disk 状態を見せ、無効化中の dormant エントリも掃除できる
   * (honor flag は persistEnabled で別途返す)。persist 未設定なら空。
   */
  listPersistedApprovals(): PersistedApprovalView[] {
    if (this.persist === undefined) return [];
    return this.persist.store.list(this.now()).map((e) => ({
      signature: e.signature,
      repoScope: e.repoScope,
      ...(e.repoLabel !== undefined ? { repoLabel: e.repoLabel } : {}),
      risk: e.risk,
      createdAtMs: e.createdAt,
      expiresAtMs: e.expiresAt,
    }));
  }

  /**
   * PAL-v2: 永続 allowlist の署名を失効する (戻り=除去件数)。repoScope 指定でその scope のみ、
   * 省略で全 scope の同一署名を除去。**enabled 非依存** (除去は新規 grant を作らない安全方向ゆえ、
   * kill-switch OFF でも dormant エントリを掃除できる)。persist 未設定なら 0。
   */
  revokePersistedApproval(signature: string, repoScope?: string): number {
    if (this.persist === undefined) return 0;
    return this.persist.store.revoke(signature, repoScope);
  }

  /** shutdown 時に保留を安全側 (deny) で解決。 */
  drain(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ behavior: "deny", reason: "sidecar shutdown (safe default: deny)" });
    }
    this.pending.clear();
    // TDA-1 (ADR 019e9b7a): session-allow 署名キャッシュも破棄する。allow_for_session は
    // 「セッション内のみ」の意図で、shutdown/drain 後に持ち越さない (次回起動は再承認)。
    this.sessionAllowSignatures.clear();
    // ADR 019ee0c0: 永続 allowlist (disk) は **意図的にクリアしない**。再起動跨ぎ永続が機能の目的で、
    // 失効は TTL 自動失効 / CLI revoke|clear が担う (drain で消すと「再起動後も許可」が無意味になる)。
  }
}
