/**
 * 型安全メッセージカタログ (設計裁定 019eb745)。
 *
 * `ja` を**正典**とし `MessageKey = keyof typeof ja`。`en` は `Record<MessageKey, string>` で
 * 受けることで **キー欠落をコンパイル時に強制**する (next-intl 等のライブラリは不採用)。
 * 純粋な表示層モジュール — realtime/bff/backend を value-import しない (token-isolation)。
 *
 * ⚠️ ユーザーデータ (command / path / session_id 等) をメッセージに埋め込むときは **必ず
 * `params` 経由** (`{name}` プレースホルダ) にする。テンプレート文字列での直結は禁止
 * (INV-I18N-NO-RAW-CJK / 翻訳パリティのため)。
 */
export type Locale = "ja" | "en";

export const LOCALES: readonly Locale[] = ["ja", "en"] as const;

/** UI 上の言語選択ラベル (LocaleToggle の option)。 */
export const LOCALE_LABELS: Record<Locale, string> = {
  ja: "日本語",
  en: "English",
};

/**
 * 日本語カタログ (**正典**)。キー名はドメイン接頭辞付き。値内の `{x}` は `t()` の params で置換する。
 */
const ja = {
  // ── 共通 ───────────────────────────────────────────────────────────────
  "common.product": "ActraDeck",
  "common.tagline": "Agent cockpit",
  "common.dash": "—",
  "common.refresh": "更新",
  "common.details": "詳細へ",
  "common.replay": "再生",
  "common.loading": "読み込み中…",
  "common.skipToMain": "メインコンテンツへスキップ",

  // ── ヘッダー / 言語・テーマ切替 ───────────────────────────────────────────
  "header.theme": "テーマ",
  "header.theme.system": "システム",
  "header.theme.light": "ライト",
  "header.theme.dark": "ダーク",
  "header.theme.hc": "ハイコントラスト",
  "header.locale": "言語",

  // ── 概況メトリクス (CockpitBoard overview) ──────────────────────────────
  "overview.connection": "接続",
  "overview.connected": "起動中",
  "overview.running": "実行中",
  "overview.needsAttention": "要対応",
  "overview.summaryAria": "session summary",

  // ── トップタブ ──────────────────────────────────────────────────────────
  "tab.board": "ボード",
  "tab.inbox": "承認 Inbox",
  "tab.inboxCount": "承認 Inbox ({count})",
  "tab.wall": "Live Wall",
  "tab.audit": "監査",
  "tab.policy": "承認ポリシー",

  // ── 監査ビュー (強み(a) audit view) ─────────────────────────────────────
  "audit.title": "監査ビュー",
  "audit.from": "開始日",
  "audit.to": "終了日",
  "audit.load": "集計",
  "audit.load.title": "指定した期間のセッションを集計する",
  "audit.loading": "集計中…",
  "audit.error": "監査データの取得に失敗しました",
  "audit.exportJson": "JSON 出力",
  "audit.exportJson.title":
    "監査集計を JSON で書き出す(SIEM・プログラム処理・アーカイブ用。秘匿原文は含まない)",
  "audit.exportCsv": "CSV 出力",
  "audit.exportCsv.title":
    "監査集計を CSV で書き出す(Excel・スプレッドシートでの集計・報告用。秘匿原文は含まない)",
  "audit.sessions": "セッション",
  "audit.redactions": "redaction",
  "audit.approvals": "承認",
  "audit.deny": "拒否",
  "audit.allow": "許可",
  "audit.pending": "保留",
  "audit.highRisk": "高リスク",
  "audit.empty": "該当期間のセッションはありません",
  "audit.hasMore": "上限まで表示しています（期間を絞ってください）",
  "audit.lastEvent": "最終イベント",
  "audit.filter.project": "プロジェクト",
  "audit.filter.allProjects": "すべてのプロジェクト",
  "audit.filter.search": "絞り込み",
  "audit.filter.searchPlaceholder": "プロジェクト / パス / ブランチ / セッション",
  "audit.filter.showing": "表示 {shown} / {total}",
  "audit.filteredEmpty": "条件に一致するセッションがありません",
  "audit.initialHint": "期間を選んで「集計」すると、ガバナンス証跡が表示されます",
  "audit.detail.title": "セッション監査詳細",
  "audit.detail.openRow": "詳細を開く",
  "audit.detail.replay": "このセッションを再生",
  "audit.detail.session": "セッション ID",
  "audit.detail.agent": "エージェント",
  "audit.detail.repo": "リポジトリ",
  "audit.detail.cwd": "作業ディレクトリ",
  "audit.detail.captureMode": "取得方式",
  "audit.detail.permissionMode": "権限モード",
  "audit.detail.state": "状態",
  "audit.detail.started": "開始",
  "audit.detail.ended": "終了",
  "audit.detail.governance": "ガバナンス証跡",
  "audit.detail.timeline": "承認イベント",
  "audit.detail.noEntries": "承認イベントはありません",
  "audit.detail.autoAllowed": "自動許可",
  "audit.detail.risk": "リスク",
  // ガバナンス証跡 drill-down (decision 019f03cc)。
  "audit.occurrences.title": "発生イベント",
  "audit.occurrences.loading": "発生イベントを読み込み中…",
  "audit.occurrences.error": "発生イベントの取得に失敗しました",
  "audit.occurrences.empty": "該当する発生イベントはありません",
  "audit.occurrences.showing": "{events} 件のイベント / マスク {markers} 件",
  "audit.occurrences.more": "上限まで表示しています",
  "audit.occurrences.jump": "Replay で確認",

  // ── P2 監査レポート export (ADR 019f2326) ───────────────────────────────
  // 期間集計を HTML/Markdown でも書き出す(既存 JSON/CSV に追加)。いずれも秘匿原文を含まない。
  "audit.exportHtml": "HTML 出力",
  "audit.exportHtml.title":
    "監査集計を HTML で書き出す(そのままブラウザで開ける・チーム/クライアント共有用。秘匿原文は含まない)",
  "audit.exportMarkdown": "Markdown 出力",
  "audit.exportMarkdown.title":
    "監査集計を Markdown で書き出す(PR・Issue・ドキュメント貼り付け用。秘匿原文は含まない)",
  // 単一セッション詳細レポート(時系列・承認・redaction 件数・exit code)。HTML/MD/JSON を選べる。
  "audit.report.export": "レポート出力",
  "audit.report.html": "HTML",
  "audit.report.html.title":
    "このセッションの詳細レポートを HTML で書き出す(時系列・承認・redaction 件数・exit code。秘匿原文は含まない)",
  "audit.report.markdown": "Markdown",
  "audit.report.markdown.title":
    "このセッションの詳細レポートを Markdown で書き出す(秘匿原文は含まない)",
  "audit.report.json": "JSON",
  "audit.report.json.title": "このセッションの詳細レポートを JSON で書き出す(秘匿原文は含まない)",
  "audit.report.includeDiff": "diff を含める",
  "audit.report.includeDiff.title":
    "接続中セッションのみ redaction 済み diff を含める(切断中は取得不可と本文に明記)",
  "audit.report.error": "レポートの出力に失敗しました",

  // ── ワークスペース / セッション一覧パネル ────────────────────────────────
  "workspace.sessions": "Sessions",
  "workspace.title": "Session workspace",
  "workspace.sessionsAria": "sessions",
  "workspace.workspaceAria": "session workspace",
  "workspace.history.showOnlyLive": "起動中のみ",
  "workspace.history.withHistory": "履歴 ({count})",
  "workspace.history.titleHide": "履歴を隠して起動中のみ表示",
  "workspace.history.titleShow": "履歴(完了/切断済み)を含む全件を表示",
  "workspace.search.label": "session 検索",
  "workspace.search.placeholder": "session / repo / action",
  "workspace.empty.noMatch": "検索条件に一致する session はありません。",
  "workspace.empty.searchHistory": "履歴も含めて検索",
  "workspace.empty.noLive":
    "起動中の Claude Code セッションはありません。履歴 {count} 件は「履歴」トグルで表示できます。",
  "workspace.tab.detail": "詳細",
  "workspace.tab.replay": "Replay",

  // ── セッション一覧テーブル (SessionList) ─────────────────────────────────
  "list.empty": "観測中の session はありません。",
  "list.caption": "ライブセッション一覧",
  "list.col.liveness": "liveness",
  "list.col.action": "action",
  "list.col.attention": "要対応",
  "list.col.repo": "repo",
  "list.col.age": "age",
  "list.col.provider": "provider",
  "list.attention": "attention",
  "list.clear": "clear",

  // ── 初回 readiness パネル (SessionList 真の空状態・観測 daemon 数のみ既出データ) ─────────
  "readiness.connected":
    "ActraDeck は接続中です（観測デーモン {count} 件）。Claude Code か Codex をリポジトリで起動すると、最初のセッションがここに表示されます。",
  "readiness.connected.hint":
    "エージェントごとの配線（hook 注入・rollout 検出）は `actradeck doctor` で確認できます。",
  "readiness.disconnected":
    "観測デーモンが未接続です。`./scripts/actradeck up`（または `./scripts/ad-attach install-all`）を実行してください。",
  // task 019f41ec: Docker (cockpit-only) 経路の橋渡し — native scripts が手元に無い環境向けに、host 側
  // sidecar を接続する docs 節をテキストで示す (外部リンク面は新設しない)。
  "readiness.disconnectedDockerHint":
    "Docker イメージで cockpit を動かしている場合は、host 側で sidecar を接続します（docs/docker.md の「Observing a host agent」参照）。",
  // ── per-agent 配線状態 (ADR 019f1972 §2b・観測値であり「リアルタイム」ではない) ─────────
  "readiness.agent.claude.wired": "Claude Code: 配線済み（セッションが表示されます）",
  "readiness.agent.claude.detected":
    "Claude Code: 検出済みだが未配線（actradeck doctor で hook 注入）",
  "readiness.agent.claude.missing": "Claude Code: 未検出",
  "readiness.agent.codex.observable": "Codex: 観測可能",
  "readiness.agent.codex.detected": "Codex: 検出済みだが rollout 未解決",
  "readiness.agent.codex.missing": "Codex: 未検出",
  // Managed 導線 (ADR 019f3960 C): observable/detected の codex 行の下に出す。承認 relay + 予防は
  // Managed 起動でのみ有効 (rollout 観測は検知のみ)。command は SessionList の共有リテラルを <code> で表示。
  "readiness.agent.codex.managedHint":
    "承認 relay と予防を有効にするには Managed で起動します（rollout 観測は検知のみ）:",

  // ── Codex Managed spawn (ADR 019f4206 A段・cockpit から起動) ─────────────────
  // 正直な開示: 一発 prompt (multi-turn 未配線)・headless (TUI でない)・spawn 可能 daemon ゼロ時は env opt-in が必要。
  "codexSpawn.title": "Managed Codex を起動",
  "codexSpawn.lead":
    "接続中の attach デーモン経由で Codex app-server を Managed 起動します（承認 relay と予防が有効）。",
  "codexSpawn.field.prompt": "プロンプト",
  "codexSpawn.field.promptPlaceholder": "Codex に依頼する内容を入力…",
  "codexSpawn.field.cwd": "作業ディレクトリ（絶対パス）",
  "codexSpawn.field.cwdPlaceholder": "/path/to/repo",
  "codexSpawn.field.daemon": "対象デーモン",
  "codexSpawn.submit": "起動",
  "codexSpawn.submitting": "起動中…",
  "codexSpawn.ok": "Managed Codex を起動しました。セッションが一覧に表示されます。",
  "codexSpawn.limits":
    "一発プロンプトのみ（multi-turn は未配線）・headless（TUI ではありません）。起動後は承認カードが Inbox に届きます。",
  "codexSpawn.disabledHint":
    "spawn 可能なデーモンがありません。attach デーモンで環境変数 ACTRADECK_ENABLE_CODEX_SPAWN=1 を設定して再起動すると有効になります。",
  // 失敗文言 (backend/daemon の closed enum code に 1:1・原文非依存・prompt/cwd を含まない)。
  "codexSpawn.error.invalid_request":
    "リクエストが不正です（プロンプト／作業ディレクトリを確認してください）。",
  "codexSpawn.error.cwd_out_of_scope": "作業ディレクトリがプロジェクトスコープ外です。",
  "codexSpawn.error.spawn_disabled":
    "Codex spawn が無効です（ACTRADECK_ENABLE_CODEX_SPAWN=1 を設定してください）。",
  "codexSpawn.error.spawn_cap_reached": "Managed Codex の同時起動数が上限に達しています。",
  "codexSpawn.error.spawn_failed": "Codex の起動に失敗しました。",
  "codexSpawn.error.generic": "起動に失敗しました。",

  // ── Audit coverage パネル (ADR 019f4cdb 後続 UI・per-provider 最終受信 + gap 検知) ─────────
  // 「監査できていない時間」を可視化する。相対時刻は server の generated_at 基準 (client clock 非依存)。
  // {provider} は event-model 正準 parse で slug 検証済み・{age} は language-neutral な数値+単位。
  "audit.coverage.title": "監査カバレッジ",
  "audit.coverage.sessions": "稼働 {count}",
  "audit.coverage.age": "{age}前に受信",
  "audit.coverage.noEvents": "受信なし",
  // gap severity ラベル (色に依存せず語で段階を区別・a11y)。warn=60s〜 / critical=300s〜。
  "audit.coverage.status.warn": "遅延",
  "audit.coverage.status.critical": "停止疑い",
  // staleness 可視化 (誤安心の是正)。stale=表示が古い (最終成功からの経過を明示)・unreachable=一度も取得不能。
  "audit.coverage.staleBanner":
    "この表示は{age}前のデータ — coverage API から有効な応答が得られていません",
  "audit.coverage.unreachable": "監査カバレッジ: API から有効な応答が得られていません",
  // seq-drop 下限 (ADR 019f4cdb Phase2)。hedged ("?"): client 申告 seq の穴＝**下限** (真の欠落はこれ以上)。
  "audit.coverage.seqDrop": "欠落 ≥{count}?",
  // 表示上限超 (SEC-1・桁溢れ防止)。`+` で「これ以上」を示す。
  "audit.coverage.seqDropCapped": "欠落 ≥{count}+?",
  // seq-suppressed 診断 (SEC-6・muted)。密性違反で欠落信号を抑制した session 数 (severity 非連動)。
  "audit.coverage.seqSuppressed": "seq 抑制 {count}",
  "audit.coverage.seqSuppressed.title":
    "dense でない seq を検出し欠落信号を抑制した session 数 (実大量 drop も抑制されうる)",

  // ── first-run セーフティデモ (ADR 019f22a7 P1・空状態 CTA) ─────────────────────
  // 「止める・残さない・証明できる」を静的✓で断定せず、使い捨て30秒デモで実証する capability として提示する。
  "safetyDemo.title": "この端末で守られています",
  "safetyDemo.lead":
    "ActraDeck はこの端末でエージェントを監督します。次の 3 つを、使い捨ての 30 秒デモで実証します。",
  "safetyDemo.cap.blockVerb": "止める",
  "safetyDemo.cap.block": "高リスク操作（rm -rf …/build）を承認前に hold し、Deny で止めます。",
  "safetyDemo.cap.redactVerb": "マスクする",
  "safetyDemo.cap.redact": "検出した secret を保存前に redact します（種別ごとの件数だけを表示）。",
  "safetyDemo.cap.auditVerb": "証明できる",
  "safetyDemo.cap.audit": "command・判断・redaction・diff を Session Replay で証跡化します。",
  "safetyDemo.cta": "30 秒セーフティデモを実行",
  "safetyDemo.launching": "デモを起動しています…",
  "safetyDemo.running": "デモ実行中：承認カードが表示されたら Deny で止めてください。",
  "safetyDemo.error": "デモを起動できませんでした。少し待って再度お試しください。",

  // ── post-demo 段階案内 (task 019f41ec / decision 019fcdaf・デモ完走後の実エージェント接続への橋渡し) ──
  // 表示条件は実データ駆動 (表示 session が全部 demo-safety-* かつ ≥1 terminal)。段階の本文は既存
  // readiness.* キーを再利用する (文言の単一出所・二重保守しない)。
  "postDemo.title": "セーフティデモを体験しました",
  "postDemo.lead":
    "いま見たのは使い捨ての教材セッションです。次は自分の実エージェントを接続すると、実際の作業がここに表示されます。",

  // ── liveness バッジ (liveness-display) ──────────────────────────────────
  "liveness.live": "LIVE",
  "liveness.idle": "IDLE",
  "liveness.stalled": "STALLED?",
  "liveness.unknown": "UNKNOWN",
  "liveness.title.live": "fresh heartbeat observed",
  "liveness.title.idle": "signals stale but process not confirmed dead — not asserting stopped",
  "liveness.title.stalled.suspected": "process not alive and no fresh signal — stalled suspected",
  "liveness.title.stalled.reported":
    "stalled reported by backend — shown as suspected (UI never asserts stopped)",
  "liveness.title.unknown": "no heartbeat signals observed",

  // ── waiting 種別 (一覧バッジ) ────────────────────────────────────────────
  "waiting.approval": "approval",
  "waiting.input": "input",
  "waiting.auth": "auth",

  // ── 承認カード (ApprovalCard / approval-display) ─────────────────────────
  "approval.phase.pending": "未対応",
  "approval.phase.sending": "送信中…",
  "approval.phase.allowed": "許可を送信しました",
  "approval.phase.allowedForSession": "セッション中は許可を送信しました",
  "approval.phase.denied": "拒否を送信しました",
  "approval.phase.cancelled": "取消を送信しました",
  "approval.phase.failed": "中継に失敗しました (再試行してください)",
  "approval.tool.unknown": "(unknown tool)",
  "approval.risk": "risk: {risk}",
  "approval.risk.unknown": "unknown",
  "approval.timeout.expired": "タイムアウト（自動拒否）",
  "approval.timeout.soon": "まもなくタイムアウト（約{seconds}秒・安全側）",
  "approval.timeout.ok": "自動拒否まで 約{seconds}秒（安全側の推定）",
  "approval.highRiskAck": "高リスク操作です。内容を確認しました（許可するにはチェックが必要）。",
  "approval.allow": "許可",
  "approval.allow.title": "この 1 回だけ許可します。",
  "approval.allowForSession": "セッション中は許可",
  "approval.allowForSession.title":
    "以降このセッションで同じ操作 (同一ツール・同一リスク・同一コマンド/パス) のみ自動許可します。それ以外は引き続き確認します。",
  "approval.allowPersist": "再起動後も許可",
  "approval.allowPersist.title":
    "再起動後も同じ操作 (同一コマンド・同一 repo) を自動許可します。期限切れ/失効で再確認します。危険なコマンドは対象外です。",
  "approval.deny": "拒否",
  "approval.deny.title": "この 1 回を拒否します。",
  "approval.cancel": "取消",
  "approval.cancel.title": "承認を取り消します (安全側で拒否として扱われます)。",
  // 自動ガード理由 (ADR 019ecc70 D3): なぜ pause したか + 検出した秘匿種類。raw 値は出さない。
  "approval.reason.secret": "秘匿情報を検出",
  "approval.reason.destructive": "破壊的操作",
  "approval.reason.both": "破壊的操作 + 秘匿情報を検出",
  "approval.reason.secretKind": "{label} を検出",
  "approval.reason.secretKinds.aria": "検出した秘匿情報の種類",

  // ── 永続承認 allowlist パネル (PersistedApprovalsPanel・PAL-v2 / ADR 019ee147) ─────────
  "allowlist.title": "永続承認（この端末）",
  "allowlist.desc":
    "再起動後も有効な承認です。この端末全体で共有されます（署名のみ保持・コマンド原文は保存しません）。",
  "allowlist.load": "永続承認を表示",
  "allowlist.reload": "再読み込み",
  "allowlist.loading": "読み込み中…",
  "allowlist.empty": "永続承認はありません。",
  "allowlist.disabled": "永続化は現在 OFF です（以下は dormant・失効のみ可能）。",
  "allowlist.error": "取得に失敗しました（{error}）",
  "allowlist.count": "{count} 件",
  "allowlist.repo": "repo: {repo}",
  "allowlist.risk": "risk: {risk}",
  "allowlist.expires": "残り {remaining}",
  "allowlist.expired": "期限切れ",
  "allowlist.revoke": "失効",
  "allowlist.revoke.title": "この永続承認を失効します（次回から再承認が必要になります）。",
  "allowlist.revoking": "失効中…",
  "allowlist.aria": "この端末の永続承認一覧",

  // ── 承認ポリシー設定 (PolicySettingsPanel・ADR 019f0c3e Phase 2) ─────────────
  "policy.title": "承認ポリシー（この端末・YOLO 時）",
  "policy.desc":
    "--dangerously-skip-permissions / --yolo の実行時でも、チェックしたカテゴリの操作は明示承認を求めます。この端末全体に適用されます。",
  "policy.load": "ポリシーを表示",
  "policy.reload": "再読み込み",
  "policy.loading": "読み込み中…",
  "policy.error": "取得に失敗しました（{error}）",
  "policy.enabledLabel": "このポリシーを有効化",
  "policy.enabledHint": "OFF にすると YOLO 時は従来どおり全操作を素通しします（純パススルー）。",
  "policy.envDisabled":
    "環境変数 ACTRADECK_BYPASS_CATASTROPHIC_GATE で全体が無効化されています。以下の設定は反映されません。",
  "policy.categoriesLegend": "ゲートするカテゴリ",
  "policy.defaultTag": "既定",
  "policy.save": "保存",
  "policy.saving": "保存中…",
  "policy.aria": "この端末の承認ポリシー設定",
  "policy.cat.recursive-rm": "再帰削除（rm -rf）",
  "policy.cat.disk-destroy": "ディスク破壊（mkfs / dd）",
  "policy.cat.history-rewrite": "履歴改変（git reset --hard 等）",
  "policy.cat.db-drop": "DB 削除（DROP / TRUNCATE）",
  "policy.cat.fork-bomb": "fork 爆弾",
  "policy.cat.secret-egress": "秘匿情報の外部送出（inline）",
  "policy.cat.perm-change": "権限変更（chmod -R 等）",
  "policy.cat.inline-code": "インラインコード実行",
  "policy.cat.secret-file-edit": "秘匿ファイル編集（.env 等）",
  "policy.cat.external-tool": "外部ツール（MCP / WebFetch）",
  "policy.cat.migrate-prod": "本番マイグレーション",
  "policy.cat.high-risk-other": "その他 high-risk（backstop）",
  // ── preset セレクタ (ADR 019f23e1・PolicyPresetSelector) ──
  "policy.preset.legend": "プリセット",
  "policy.preset.current": "現在のプリセット:",
  "policy.preset.custom": "カスタム",
  "policy.preset.strict": "Strict（厳格）",
  "policy.preset.strict.summary":
    "検出できる全カテゴリを止める（最も安全・承認プロンプトは増える）。",
  "policy.preset.balanced": "Balanced（推奨）",
  "policy.preset.balanced.summary": "推奨の既定。破滅的操作＋秘匿情報の外部送出などを止める。",
  "policy.preset.demo": "Demo（デモ用・緩め）",
  "policy.preset.demo.summary":
    "破滅的で不可逆な操作（rm -rf / ディスク破壊 / fork 爆弾）だけを止め、それ以外は素通しします⚠。",
  "policy.preset.looserWarn":
    "このプリセットは推奨既定（Balanced）より緩く、止まるはずの操作が素通しになります。この端末全体（YOLO 時）に適用されます。",
  "policy.enforcementScope":
    "予防が効くのは Managed モード（CC / Codex を ActraDeck 経由で起動）のときだけです。Attach は観測のみ・Codex rollout は検知のみです。",

  // ── per-repo 承認ポリシー設定画面 (ApprovalPolicyView・ADR 019f0eca) ─────────────
  "approvalPolicy.title": "承認ポリシー（この端末・YOLO 時）",
  "approvalPolicy.desc":
    "--dangerously-skip-permissions / --yolo の実行時に明示承認を求めるカテゴリを、Default（マシン基準）と repo ごとに設定します。この端末全体に適用されます。",
  "approvalPolicy.aria": "per-repo 承認ポリシー設定",
  "approvalPolicy.scopesAria": "ポリシー対象（Default と repo）",
  "approvalPolicy.noSession": "接続中のセッションがありません",
  "approvalPolicy.noSessionHint":
    "ポリシーの確認・変更には稼働中のデーモン（接続中の live セッション）が必要です。エージェントを起動してください。",
  "approvalPolicy.offline": "接続中のセッションがありません（最後に取得した設定を表示中）",
  "approvalPolicy.offlineHint":
    "読み取り専用です。最新化・変更・repo の追加には稼働中のデーモン（接続中の live セッション）が必要です。",
  "approvalPolicy.offlineHintCached":
    "読み取り専用（最終取得: {when}）。実際のゲート状態と異なる場合があります。最新化・変更には接続が必要です。",
  "approvalPolicy.loading": "読み込み中…",
  "approvalPolicy.reload": "再読み込み",
  "approvalPolicy.loadHint": "対象を選択してください。",
  "approvalPolicy.error": "取得に失敗しました（{error}）",
  "approvalPolicy.default": "Default",
  "approvalPolicy.defaultSub": "マシン基準（全 repo の既定）",
  "approvalPolicy.unknownRepo": "（不明な repo）",
  "approvalPolicy.badge.override": "Override",
  "approvalPolicy.badge.default": "Default 継承",
  "approvalPolicy.badge.observed": "観測（クリックで設定）",
  "approvalPolicy.observed.legend": "観測された作業ディレクトリ",
  "approvalPolicy.observed.hint":
    "クリックすると git ルートを解決して対象に追加します（パスは保存されません）。",
  "approvalPolicy.observed.note":
    "起動中・過去のセッションの作業場所です。同じ repo のサブディレクトリは、設定すると 1 つの repo にまとまります。",
  "approvalPolicy.add.legend": "repo を追加（パス指定）",
  "approvalPolicy.add.placeholder": "/絶対パス/to/repo",
  "approvalPolicy.add.button": "解決して追加",
  "approvalPolicy.add.resolving": "解決中…",
  "approvalPolicy.add.hint":
    "絶対パスを入力すると、サーバ側で git ルートを解決して対象に追加します（パスは保存されません）。",
  "approvalPolicy.add.error": "解決に失敗しました（{error}）",
  "approvalPolicy.detail.defaultTitle": "Default（マシン基準）",
  "approvalPolicy.detail.repoTitle": "{repo}",
  "approvalPolicy.loosenWarning":
    "この repo は Default より緩い設定です（Default が止める操作の一部を素通しします）。",
  "approvalPolicy.enabledLabel": "このポリシーを有効化",
  "approvalPolicy.enabledHint":
    "OFF にすると、この対象では YOLO 時に全操作を素通しします（純パススルー）。",
  "approvalPolicy.categoriesLegend": "ゲートするカテゴリ",
  "approvalPolicy.save": "保存",
  "approvalPolicy.saving": "保存中…",
  "approvalPolicy.resetToDefault": "Default に戻す",
  "approvalPolicy.resetHint": "この repo の上書きを削除し、Default を継承します。",
  // ── preset セレクタ (ADR 019f23e1・PolicyPresetSelector) ──
  "approvalPolicy.preset.legend": "プリセット",
  "approvalPolicy.preset.current": "現在のプリセット:",
  "approvalPolicy.preset.custom": "カスタム",
  "approvalPolicy.preset.strict": "Strict（厳格）",
  "approvalPolicy.preset.strict.summary":
    "検出できる全カテゴリを止める（最も安全・承認プロンプトは増える）。",
  "approvalPolicy.preset.balanced": "Balanced（推奨）",
  "approvalPolicy.preset.balanced.summary":
    "推奨の既定。破滅的操作＋秘匿情報の外部送出などを止める。",
  "approvalPolicy.preset.demo": "Demo（デモ用・緩め）",
  "approvalPolicy.preset.demo.summary":
    "破滅的で不可逆な操作（rm -rf / ディスク破壊 / fork 爆弾）だけを止め、それ以外は素通しします⚠。",
  "approvalPolicy.preset.looserWarn":
    "このプリセットは推奨既定（Balanced）より緩く、止まるはずの操作が素通しになります。Default に適用すると、上書きの無い全 repo に波及します。",
  "approvalPolicy.enforcementScope":
    "予防が効くのは Managed モード（CC / Codex を ActraDeck 経由で起動）のときだけです。Attach は観測のみ・Codex rollout は検知のみです。",

  // ── 承認 Inbox (ApprovalInbox) ──────────────────────────────────────────
  "inbox.title": "承認 Inbox",
  "inbox.summary": "{total} 件の操作が判断を待っています（{sessions} セッション）",
  "inbox.aria": "approval inbox",
  "inbox.refresh.title": "承認待ちを再取得",
  "inbox.error.title": "承認待ちを取得できませんでした",
  "inbox.empty": "承認待ちはありません。",
  "inbox.session": "session",
  "inbox.groupAria": "approvals for {sessionId}",
  "inbox.open.title": "このセッションの詳細を開く",
  "inbox.replay.title": "このセッションを再生する",

  // ── Action Rail（要対応レーン・decision 019f69ef） ───────────────────────
  "actionRail.aria": "要対応",
  "actionRail.title": "要対応",
  "actionRail.clear": "要対応なし — いま人の操作は不要です",
  "actionRail.signal.open.title": "このセッションの詳細を開く",
  "actionRail.kind.approval": "承認待ち",
  "actionRail.kind.stalled": "停止の疑い",
  "actionRail.kind.auth": "認証待ち",
  "actionRail.kind.input": "入力待ち",
  "actionRail.kind.attention": "要対応",

  // ── セッション詳細 (SessionDetail) ──────────────────────────────────────
  "detail.empty.loading": "詳細を取得中…",
  "detail.empty.select": "session を選択してください。",
  "detail.attention": "要対応",
  "detail.captureMode.nonManaged": "外部起動 ({mode})",
  "detail.captureMode.nonManaged.title":
    "このセッションは ActraDeck が起動を所有しない経路で取得されています。一部の制御 (停止など) は効きません。承認 relay の可否は agent と mode により異なります。",
  // ADR 019f47c2: source=external (第三者 adapter 直取込・gemini/opencode 等) の observe-only バッジ。
  "detail.captureMode.external": "外部 (observe-only)",
  "detail.captureMode.external.title":
    "このセッションは第三者 adapter が直接取り込んだ外部イベントです (observe-only)。ActraDeck は起動を所有せず、停止・承認 relay はできません (検知のみ)。",
  // SEC-1/TDA-4: Codex 導線は provider 非依存の base title と分離し、SessionDetail が
  // detail.provider === "codex" の時のみ追記する (claude-attach は承認 relay 可ゆえ誤導しない)。
  "detail.captureMode.nonManaged.codexHint":
    'Codex の承認 relay と予防を有効にするには Managed で起動してください: `{cmd} "<タスク>"`。',
  "detail.interrupt": "中断 (SIGINT)",
  "detail.interrupt.title":
    "managed claude へ SIGINT を送り協調的に停止を要求します。実行中ツールの巻き戻しではありません。managed でない場合は安全に無視されます。",
  "detail.approval.head": "承認待ち",
  "detail.approval.pendingCount": "{count} 件の操作が判断を待っています。",
  "detail.waiting.approval": "承認待ち",
  "detail.waiting.auth": "認証待ち",
  "detail.waiting.input": "入力待ち",
  "detail.waiting.approval.body": "Web UI で承認/拒否してください。",
  "detail.waiting.auth.body": "エージェントが認証を必要としています。",
  "detail.waiting.input.body": "エージェントが入力を待っています。",
  "detail.liveness.caption": "Liveness evidence（heartbeat シグナル別の鮮度）",
  // ADR 0014 Phase 3c: run lineage メタ (値は enum/短縮 id をそのまま表示・ラベルのみ i18n)。
  "detail.lineage.start": "開始種別",
  "detail.lineage.continuedFrom": "継続元",
  "detail.lineage.linkedUnknown": "連結不明（宣言参照・未観測）",
  "detail.lineage.end": "終了種別",
  "detail.lineage.continuation": "再開可能性",
  "detail.lineage.lastTurn": "直近 turn",
  "detail.lineage.runs": "run 系譜",
  "detail.liveness.evidenceToggle": "Liveness の根拠（heartbeat 分解）を見る",
  "detail.liveness.col.signal": "signal",
  "detail.liveness.col.seen": "seen",
  "detail.liveness.col.age": "age",
  "detail.liveness.col.fresh": "fresh",
  "detail.liveness.col.note": "note",
  "detail.liveness.seen.yes": "yes",
  "detail.liveness.fresh": "fresh",
  "detail.liveness.stale": "stale",
  "detail.meta.repo": "repo",
  "detail.meta.cwd": "cwd",
  "detail.meta.provider": "provider",
  "detail.meta.invalidTransitions": "invalid transitions",

  // ── 現在作業ペイン (CurrentActionPane / current-action-display) ───────────
  "action.view.modelStream": "モデル応答中",
  "action.view.command": "コマンド実行中",
  "action.view.fileEdit": "ファイル編集中",
  "action.view.mcp": "MCP ツール呼び出し中",
  "action.view.web": "Web 検索中",
  "action.view.waiting": "介入待ち",
  "action.view.idle": "アクティブな作業なし",
  "action.currentAria": "現在の作業",
  "action.kill": "停止 (SIGINT)",
  "action.kill.title":
    "managed claude へ SIGINT を送り協調的に停止を要求します。実行中ツールの巻き戻しではありません。managed でない場合は安全に無視されます。",
  "action.empty": "いま観測されているアクティブな作業はありません。",
  "action.meta.cwd": "cwd",
  "action.meta.elapsed": "elapsed",
  "action.meta.exitCode": "exit code",
  "action.output.load": "標準出力を表示",
  "action.output.loading": "出力を取得中…",
  "action.output.load.title":
    "このコマンドの標準出力 (末尾) を取得して表示します。出力は redaction 済みです。",
  "action.output.error": "出力の取得に失敗しました: {error}",
  "action.output.empty": "(出力はありません)",
  "action.output.truncated": "\n[出力は末尾のみ表示しています]",
  "action.output.aria": "標準出力 (末尾・redaction 済み)",

  // ── タイムラインペイン (TimelinePane) ───────────────────────────────────
  "timeline.title": "実行タイムライン",
  "timeline.aria": "実行タイムライン（時系列・新しい行が末尾に追加されます）",
  "timeline.empty": "まだイベントがありません。",

  // ── work-items パネル (ADR 0015 §D8・自己申告完了と検証の可視化) ─────────────
  "workitem.panel.title": "作業項目",
  "workitem.panel.aria": "作業項目と検証状態",
  "workitem.panel.empty": "観測された作業項目はまだありません。",
  "workitem.noSubject": "（件名なし）",
  "workitem.dropped": "上限超過で {count} 件を除外",
  "workitem.count.claimedUnverified": "自己申告のみ {count}",
  "workitem.count.claimedUnverified.title": "完了と自己申告されたが検証されていない項目数",
  // 4 バッジ (§D8・deriveWorkItemBadge 単一正準)。
  "workitem.badge.self_claimed": "自己申告完了",
  "workitem.badge.self_claimed.title": "エージェントが完了と申告。検証はまだ観測されていない。",
  "workitem.badge.verified": "検証済み",
  "workitem.badge.verified.title": "束縛されたチェックが合格（現在のツリー指紋に一致）。",
  "workitem.badge.verification_failed": "検証失敗",
  "workitem.badge.verification_failed.title":
    "この作業を含むツリーで直近の認識済みチェックが失敗（この申告が誤りとは限らない）。",
  "workitem.badge.changed_after_verification": "検証後変更あり",
  "workitem.badge.changed_after_verification.title":
    "検証後にツリー指紋が変化。合格は現在のコードには当てはまらない。",
  // 状態 (非 completed / plain 表示)。
  "workitem.status.pending": "未着手",
  "workitem.status.in_progress": "進行中",
  "workitem.status.completed": "完了",
  "workitem.status.cancelled": "取消",
  "workitem.status.removed": "除外",
  "workitem.status.unknown": "不明",
  // 観測証拠 (§D7 method/fidelity)。
  "workitem.evidence.methodLabel": "経路: {value}",
  "workitem.evidence.fidelityLabel": "確度: {value}",
  "workitem.evidence.method.official_hook": "公式フック",
  "workitem.evidence.method.official_api": "公式 API",
  "workitem.evidence.method.provider_jsonl": "provider JSONL",
  "workitem.evidence.method.local_file": "ローカルファイル",
  "workitem.evidence.method.log_parse": "ログ解析",
  "workitem.evidence.method.heuristic": "ヒューリスティック",
  "workitem.evidence.fidelity.authoritative": "権威",
  "workitem.evidence.fidelity.observed": "観測",
  "workitem.evidence.fidelity.parsed": "解析",
  "workitem.evidence.fidelity.inferred": "推定",
  "workitem.evidence.fidelity.unknown": "不明",
  // check 分類 (§D6)。
  "workitem.check.label": "チェック: {kind}（{match}）",
  "workitem.check.labelKindOnly": "チェック: {kind}",
  "workitem.check.kind.test": "テスト",
  "workitem.check.kind.lint": "lint",
  "workitem.check.kind.typecheck": "型検査",
  "workitem.check.kind.build": "ビルド",
  "workitem.check.kind.format": "整形",
  "workitem.check.match.program": "プログラム",
  "workitem.check.match.script": "スクリプト",
  "workitem.check.exit": "終了コード {code}",
  "workitem.runDirty": "検証中に変更",
  "workitem.runDirty.title":
    "チェックの実行中にツリーが変化（合格をどちらのツリーにも帰属できない）。",
  "workitem.stale.reason": "検証後にツリーが変化",
  // evidence-ref (§D8 claim/check/diff の timeline event へジャンプ)。
  "workitem.ref.label": "根拠:",
  "workitem.ref.jump": "対応するタイムラインのイベントへ移動",
  "workitem.ref.claim": "申告",
  "workitem.ref.check": "チェック",
  "workitem.ref.diff": "差分",
  "timeline.risk": "risk:{risk}",
  "timeline.exit": "exit:{code}",

  // ── アクション単位ビュー (action-units / 行文法・詳細モーダル) ───────────────
  // 行為 (述語)。承認チェーンは解決状態で文言とトーンを変える。
  "action.verb.approvalResolved": "承認 → {decision}",
  "action.verb.approvalPending": "承認待ち",
  "action.verb.approvalHistory": "承認 (履歴)",
  "action.verb.command": "コマンド実行",
  "action.verb.file": "ファイル変更",
  "action.verb.tool": "ツール実行",
  "action.verb.mcp": "MCP 呼び出し",
  "action.verb.web": "Web 検索",
  "action.verb.turn": "ターン",
  "action.verb.session": "セッション",
  "action.verb.message": "メッセージ",
  "action.verb.liveness": "稼働シグナル",
  // error は replay 専用 kind (ReplayEventKind = ActionKind ∪ {"error"})。ActionKind には無い。
  "action.verb.error": "エラー",
  // current_action (一覧/詳細の現在アクション要約) の「述語: 対象」テンプレート (ADR 019eeac6)。
  // verb は action.verb.* の述語、subject は backend redaction-clean な構造値 (params 経由必須)。
  "action.currentAction.withSubject": "{verb}: {subject}",
  "action.decision.allow": "許可",
  "action.decision.deny": "拒否",
  "action.decision.unknown": "解決",
  "action.result.exit": "exit {code}",
  "action.autoAllowed": "自動許可",
  // command 相関ユニットの結果バッジ (成功/失敗/実行中)。
  "action.outcome.succeeded": "成功",
  "action.outcome.failed": "失敗",
  "action.outcome.running": "実行中",
  // ビュー切替トグル (アクション単位 ⇄ raw イベント)。
  "action.toggle.label": "表示",
  "action.toggle.units": "アクション単位",
  "action.toggle.raw": "raw イベント",
  // 行 a11y。
  "action.row.aria": "{verb}: {target}",
  "action.row.openDetails": "詳細を開く",
  "action.target.none": "(対象なし)",

  // ── 詳細モーダル (kit Modal + ActionUnit 詳細) ──────────────────────────────
  "modal.close": "閉じる",
  "modal.detail.title": "アクションの詳細",
  "modal.detail.target": "対象",
  "modal.detail.targetNone": "(対象は観測されていません)",
  "modal.detail.copy": "対象をコピー",
  "modal.detail.copied": "コピーしました",
  "modal.detail.action": "行為",
  "modal.detail.time": "時刻",
  "modal.detail.timeRange": "{start} 〜 {end}",
  "modal.detail.cwd": "作業ディレクトリ",
  "modal.detail.approval": "承認チェーン",
  "modal.detail.risk": "リスク: {risk}",
  "modal.detail.decision": "判断: {decision}",
  "modal.detail.autoAllowed": "自動許可: {value}",
  "modal.detail.exit": "exit code: {code}",
  "modal.detail.elapsed": "経過: {elapsed}",
  "modal.detail.events": "構成イベント",
  "modal.bool.true": "はい",
  "modal.bool.false": "いいえ",
  // コマンド出力 pull (既存 GET /commands/:eventId/output)。
  "modal.output.load": "出力を見る",
  "modal.output.loading": "出力を取得中…",
  "modal.output.error": "出力の取得に失敗しました: {error}",
  "modal.output.empty": "(出力はありません)",
  "modal.output.truncated": "\n[出力は末尾のみ表示しています]",
  "modal.output.notFound": "このコマンドの出力は見つかりませんでした。",
  "modal.output.aria": "標準出力 (末尾・redaction 済み)",
  // セッション現在差分 pull (既存 GET /diff)。per-event ではない旨を明示。
  "modal.diff.load": "現在の差分を見る",
  "modal.diff.loading": "差分を取得中…",
  "modal.diff.error": "差分の取得に失敗しました: {error}",
  "modal.diff.empty": "(差分はありません)",
  "modal.diff.truncated": "\n[差分はサイズ上限で切り詰めています]",
  "modal.diff.note":
    "これはセッションの現在の作業ツリー差分です (この行専用の差分ではありません)。",
  "modal.diff.secret": "secret 検出: {count} 件 (redaction 済み)",
  "modal.diff.aria": "git diff 本文 (redaction 済み)",

  // ── リスクペイン (RiskPane) ─────────────────────────────────────────────
  "risk.title": "変更・リスク",
  "risk.aria": "変更・リスク",
  "risk.highest": "最高リスク: {risk}",
  "risk.files": "変更ファイル: {count}",
  "risk.mcp": "MCP 呼び出しあり",
  "risk.web": "Web/ネットワークあり",
  "risk.failure": "非ゼロ exit あり",
  "risk.captureMode": "取得: {mode}",
  "risk.captureMode.external": "取得: 外部 (observe-only)",
  "risk.permission": "権限: {mode}",
  "risk.permission.title":
    "このセッションの権限モード (sandbox)。bypassPermissions / acceptEdits は自動許可が広いため注意。",
  "risk.secretDetected": "secret 検出: {count} 件 (redaction 済み)",
  "risk.secretDetected.title":
    "diff 本文内で秘匿情報が検出され redaction されました。マスクした値は表示しません (件数のみ)。",
  "risk.secretDetected.session": "このセッションで秘匿を {count} 件検出 (redaction 済み)",
  "risk.secretDetected.session.unknown": "このセッションで秘匿を検出 (redaction 済み)",
  "risk.secretDetected.session.title":
    "このセッション内で redaction が一度でも秘匿を検出した事実です (session 単位・常時)。件数は検出の濃度で、マスクした値は表示しません。",
  "risk.diff.load": "diff 本文を表示",
  "risk.diff.loading": "差分を取得中…",
  "risk.diff.load.title":
    "作業ツリーの git diff 本文を取得して表示します。差分は redaction 済みです。",
  "risk.diff.error": "diff の取得に失敗しました: {error}",
  "risk.diff.empty": "(差分はありません)",
  "risk.diff.truncated": "\n[差分はサイズ上限で切り詰めています]",
  "risk.diff.aria": "git diff 本文 (redaction 済み)",
  "risk.note":
    "diff 本文・secret 検出件数の表示は session 詳細で「diff 本文を表示」から取得できます。",

  // ── Redaction kind 別内訳 (強み(a)③ redaction 可視化) ─────────────────────
  // 種類別タグの見出し / 合計。件数 + kind ラベル (公開 enum) のみ・原文は出さない。
  "risk.redaction.breakdown": "redaction 内訳",
  "risk.redaction.breakdown.title":
    "このセッションで redaction された秘匿の種類別件数です (公開 enum + 件数のみ・マスクした値は表示しません)。",
  "risk.redaction.kindCount": "{label} ×{count}",
  "risk.redaction.total": "計 {count} 件",
  // 未知 kind (deploy skew 等で語彙外) は raw 文字列を画面/属性に出さず汎用ラベルへ畳む (SEC defense-in-depth)。
  "risk.redaction.unknownKind": "その他の秘匿",
  // kind 表示名 (REDACTION_KINDS 全 kind を網羅。表示変換は UI 層のみ・データ層は raw 保持)。
  "redaction.kind.private-key": "秘密鍵",
  "redaction.kind.aws-access-key-id": "AWS アクセスキー",
  "redaction.kind.github-token": "GitHub トークン",
  "redaction.kind.anthropic-key": "Anthropic キー",
  "redaction.kind.openai-key": "OpenAI キー",
  "redaction.kind.google-api-key": "Google API キー",
  "redaction.kind.slack-token": "Slack トークン",
  "redaction.kind.stripe-key": "Stripe キー",
  "redaction.kind.gitlab-token": "GitLab トークン",
  "redaction.kind.sendgrid-key": "SendGrid キー",
  "redaction.kind.huggingface-token": "Hugging Face トークン",
  "redaction.kind.azure-ad-client-secret": "Azure AD クライアントシークレット",
  "redaction.kind.databricks-token": "Databricks トークン",
  "redaction.kind.doppler-token": "Doppler トークン",
  "redaction.kind.planetscale-token": "PlanetScale トークン",
  "redaction.kind.flyio-token": "Fly.io トークン",
  "redaction.kind.slack-webhook": "Slack Webhook",
  "redaction.kind.discord-webhook": "Discord Webhook",
  "redaction.kind.jwt": "JWT",
  "redaction.kind.basic-auth": "Basic 認証",
  "redaction.kind.bearer-token": "Bearer トークン",
  "redaction.kind.auth-header-scheme": "Authorization スキーム",
  "redaction.kind.auth-scheme-value": "Authorization 値",
  "redaction.kind.cookie": "Cookie",
  "redaction.kind.npm-auth-token": "npm 認証トークン",
  "redaction.kind.credential-assignment": "資格情報代入",
  "redaction.kind.url-credential": "URL 埋込資格情報",
  "redaction.kind.high-entropy-secret": "高エントロピー秘匿",
  "redaction.kind.sentry-dsn": "Sentry DSN",

  // ── 通知 (NotificationToggle / use-notifications / notifications) ─────────
  // 本文は list-level 非秘匿のみ (session 短縮 + location + state)。command/secret は載せない。
  "notification.enable": "通知を有効化",
  "notification.enable.title":
    "承認待ち / stalled / 失敗をブラウザ通知でお知らせします（タブが背面のときのみ）。クリックで許可を求めます。",
  "notification.disable": "通知を無効化",
  "notification.disable.title": "ブラウザ通知を止めます（許可状態はそのままです）。",
  "notification.denied": "通知はブロック中",
  "notification.denied.title":
    "ブラウザの設定で通知がブロックされています。サイトの権限から許可してください。",
  "notification.unsupported": "通知は非対応",
  "notification.categories.aria": "通知カテゴリ",
  "notification.category.approval": "承認待ち",
  // "stalled" は意図的に技術語のまま固定 (liveness.stalled="STALLED?" / wall 凡例と統一・誤訳防止)。
  "notification.category.stalled": "stalled",
  "notification.category.failed": "失敗",
  "notification.approval.title": "承認待ち: {session}",
  "notification.approval.body": "{location} — 判断を待っています（{state}）",
  "notification.stalled.title": "stalled の疑い: {session}",
  "notification.stalled.body": "{location} — 60 秒以上イベントなし（{state}）",
  "notification.failed.title": "失敗: {session}",
  "notification.failed.body": "{location} — 異常終了しました（{state}）",

  // ── Live Wall (LiveWall / wall-display) ─────────────────────────────────
  "wall.title": "Live Wall",
  "wall.aria": "live wall",
  "wall.summary": "{count} セッション・直近 {window}の活動",
  "wall.attentionJump": "要対応 {count}",
  "wall.attentionJump.title": "要対応 (承認/入力待ち) のレーンへ順にジャンプ",
  "wall.group.byProject": "プロジェクトでまとめる",
  "wall.group.toggle.title":
    "同一プロジェクト (repo または作業ディレクトリ) のセッションを束ねて表示 (OFF で手動並べ替え)",
  "wall.group.none": "場所不明",
  "wall.refresh.title": "横断フィードを再取得",
  "wall.legend.label": "バーの色 = アクション種別:",
  "wall.legend.aria": "バー色の凡例",
  "wall.legend.command": "コマンド",
  "wall.legend.file": "ファイル / 差分",
  "wall.legend.approval": "承認 / エラー",
  "wall.legend.liveness": "生存信号",
  "wall.legend.default": "ツール / MCP / その他",
  "wall.error.title": "横断フィードを取得できませんでした",
  "wall.empty": "起動中セッションのアクションはありません。",
  "wall.laneAria": "wall lane {sessionId}",
  "wall.lane.session": "session",
  "wall.lane.attention": "要対応",
  "wall.lane.claimedUnverified": "未検証 {count}",
  "wall.lane.claimedUnverified.title": "自己申告完了だが未検証の作業項目数（要対応とは別）",
  "wall.lane.open.title": "このセッションの詳細を開く",
  "wall.lane.replay.title": "このセッションを再生する",
  "wall.lane.dragHandle.title": "ドラッグで並べ替え (キーボードは ↑/↓ ボタン)",
  "wall.lane.collapse.aria": "{sessionId} のレーンを{verb}",
  "wall.lane.collapse.expand": "展開",
  "wall.lane.collapse.collapse": "折りたたみ",
  "wall.lane.collapse.titleExpand": "レーンを展開 (バーを表示)",
  "wall.lane.collapse.titleCollapse": "レーンを折りたたむ (ヘッダのみ)",
  "wall.lane.move.aria": "レーンを並べ替え",
  "wall.lane.moveUp.aria": "{sessionId} を上へ移動",
  "wall.lane.moveUp.title": "上へ移動",
  "wall.lane.moveDown.aria": "{sessionId} を下へ移動",
  "wall.lane.moveDown.title": "下へ移動",
  "wall.lane.elapsed": "実行中 {elapsed}",
  "wall.track.aria": "{count} 件のアクション (直近 {window})",
  "wall.track.empty": "この窓のイベントなし",
  "wall.approvalsAria": "approvals for {sessionId}",

  // ── ルーラー / 経過時間 (wall-display) ──────────────────────────────────
  "time.now": "now",
  "time.ago": "{elapsed}前",
  "time.elapsed.seconds": "{seconds}秒",
  "time.elapsed.minutes": "{minutes}分{seconds}秒",
  "time.window.minutes": "{minutes}分",
  "time.window.seconds": "{seconds}秒",

  // ── Session Replay (SessionReplay) ──────────────────────────────────────
  "replay.title": "Replay",
  "replay.aria": "session-replay",
  "replay.loading": "リプレイを取得中…",
  "replay.empty": "session を選択してください。",
  "replay.loadMore": "さらに読み込む",
  "replay.error.title": "Replay error",
  "replay.invalid.title": "Invalid events",
  "replay.invalid.subtitle": "projection から除外されたイベント: {count}",
  "replay.limitReached": "Replay 表示上限 {limit} 件に達しました。",
  "replay.stepBack": "戻る",
  "replay.play": "再生",
  "replay.pause": "一時停止",
  "replay.stepNext": "次へ",
  "replay.speed": "速度",
  "replay.position.aria": "再生位置",
  "replay.position.valuetext": "{current} / {total} 件目",
  "replay.position.noEvents": "イベントなし",
  "replay.state.state": "state",
  "replay.state.current": "current",
  "replay.state.pending": "pending",
  "replay.replaying": "再生対象",
  "replay.identity.aria": "再生対象のセッション",
  "replay.identity.session": "session",
} as const;

export type MessageKey = keyof typeof ja;

/**
 * 英語カタログ。`Record<MessageKey, string>` 型注釈で **ja のキーを 1 つでも欠くと型エラー** になる
 * (INV-I18N-COMPLETENESS の型側ゲート)。UI として自然な英語にする (直訳調を避ける)。
 */
const en: Record<MessageKey, string> = {
  // ── common ──
  "common.product": "ActraDeck",
  "common.tagline": "Agent cockpit",
  "common.dash": "—",
  "common.refresh": "Refresh",
  "common.details": "Details",
  "common.replay": "Replay",
  "common.loading": "Loading…",
  "common.skipToMain": "Skip to main content",

  // ── header ──
  "header.theme": "Theme",
  "header.theme.system": "System",
  "header.theme.light": "Light",
  "header.theme.dark": "Dark",
  "header.theme.hc": "High contrast",
  "header.locale": "Language",

  // ── overview ──
  "overview.connection": "Connection",
  "overview.connected": "Live",
  "overview.running": "Running",
  "overview.needsAttention": "Needs attention",
  "overview.summaryAria": "session summary",

  // ── tabs ──
  "tab.board": "Board",
  "tab.inbox": "Approvals",
  "tab.inboxCount": "Approvals ({count})",
  "tab.wall": "Live Wall",
  "tab.audit": "Audit",
  "tab.policy": "Approval policy",

  // ── audit view (strength a) ──
  "audit.title": "Audit",
  "audit.from": "From",
  "audit.to": "To",
  "audit.load": "Aggregate",
  "audit.load.title": "Aggregate sessions for the selected date range",
  "audit.loading": "Aggregating…",
  "audit.error": "Failed to load audit data",
  "audit.exportJson": "Export JSON",
  "audit.exportJson.title":
    "Export the audit aggregate as JSON (for SIEM, scripting, archival; no raw secrets)",
  "audit.exportCsv": "Export CSV",
  "audit.exportCsv.title":
    "Export the audit aggregate as CSV (for spreadsheets, reporting; no raw secrets)",
  "audit.sessions": "Sessions",
  "audit.redactions": "Redactions",
  "audit.approvals": "Approvals",
  "audit.deny": "Deny",
  "audit.allow": "Allow",
  "audit.pending": "Pending",
  "audit.highRisk": "High-risk",
  "audit.empty": "No sessions in this range",
  "audit.hasMore": "Showing up to the limit (narrow the range)",
  "audit.lastEvent": "Last event",
  "audit.filter.project": "Project",
  "audit.filter.allProjects": "All projects",
  "audit.filter.search": "Filter",
  "audit.filter.searchPlaceholder": "project / path / branch / session",
  "audit.filter.showing": "Showing {shown} / {total}",
  "audit.filteredEmpty": "No sessions match the filter",
  "audit.initialHint": "Pick a range and Aggregate to see the governance trail",
  "audit.detail.title": "Session audit detail",
  "audit.detail.openRow": "Open detail",
  "audit.detail.replay": "Replay this session",
  "audit.detail.session": "Session ID",
  "audit.detail.agent": "Agent",
  "audit.detail.repo": "Repository",
  "audit.detail.cwd": "Working directory",
  "audit.detail.captureMode": "Capture mode",
  "audit.detail.permissionMode": "Permission mode",
  "audit.detail.state": "State",
  "audit.detail.started": "Started",
  "audit.detail.ended": "Ended",
  "audit.detail.governance": "Governance trail",
  "audit.detail.timeline": "Approval events",
  "audit.detail.noEntries": "No approval events",
  "audit.detail.autoAllowed": "Auto-allowed",
  "audit.detail.risk": "Risk",
  // Governance-trail drill-down (decision 019f03cc).
  "audit.occurrences.title": "Occurrences",
  "audit.occurrences.loading": "Loading occurrences…",
  "audit.occurrences.error": "Failed to load occurrences",
  "audit.occurrences.empty": "No matching occurrences",
  "audit.occurrences.showing": "{events} events / {markers} redactions",
  "audit.occurrences.more": "Showing up to the limit",
  "audit.occurrences.jump": "View in Replay",

  // ── P2 audit report export (ADR 019f2326) ──
  "audit.exportHtml": "Export HTML",
  "audit.exportHtml.title":
    "Export the audit aggregate as HTML (open directly in a browser; share with team/clients; no raw secrets)",
  "audit.exportMarkdown": "Export Markdown",
  "audit.exportMarkdown.title":
    "Export the audit aggregate as Markdown (paste into PRs, issues, docs; no raw secrets)",
  "audit.report.export": "Export report",
  "audit.report.html": "HTML",
  "audit.report.html.title":
    "Export this session's detailed report as HTML (timeline, approvals, redaction counts, exit codes; no raw secrets)",
  "audit.report.markdown": "Markdown",
  "audit.report.markdown.title":
    "Export this session's detailed report as Markdown (no raw secrets)",
  "audit.report.json": "JSON",
  "audit.report.json.title": "Export this session's detailed report as JSON (no raw secrets)",
  "audit.report.includeDiff": "Include diff",
  "audit.report.includeDiff.title":
    "Include the redacted diff for connected sessions only (marked unavailable in-body when disconnected)",
  "audit.report.error": "Failed to export report",

  // ── workspace ──
  "workspace.sessions": "Sessions",
  "workspace.title": "Session workspace",
  "workspace.sessionsAria": "sessions",
  "workspace.workspaceAria": "session workspace",
  "workspace.history.showOnlyLive": "Live only",
  "workspace.history.withHistory": "History ({count})",
  "workspace.history.titleHide": "Hide history and show only live sessions",
  "workspace.history.titleShow": "Show all sessions including history (completed / disconnected)",
  "workspace.search.label": "Search sessions",
  "workspace.search.placeholder": "session / repo / action",
  "workspace.empty.noMatch": "No sessions match your search.",
  "workspace.empty.searchHistory": "Search including history",
  "workspace.empty.noLive":
    "No live Claude Code sessions. {count} in history — show them with the History toggle.",
  "workspace.tab.detail": "Details",
  "workspace.tab.replay": "Replay",

  // ── list ──
  "list.empty": "No sessions are being observed.",
  "list.caption": "Live session list",
  "list.col.liveness": "liveness",
  "list.col.action": "action",
  "list.col.attention": "Needs attention",
  "list.col.repo": "repo",
  "list.col.age": "age",
  "list.col.provider": "provider",
  "list.attention": "attention",
  "list.clear": "clear",

  // ── first-run readiness panel (SessionList true-empty; observer daemon count only) ──
  "readiness.connected":
    "ActraDeck is connected ({count} observer daemon(s)). Start Claude Code or Codex in a repository and the first session will appear here.",
  "readiness.connected.hint":
    "Check per-agent wiring (hook injection, rollout detection) with `actradeck doctor`.",
  "readiness.disconnected":
    "No observer daemon is connected. Run `./scripts/actradeck up` (or `./scripts/ad-attach install-all`).",
  // task 019f41ec: bridge for the Docker (cockpit-only) path — no native scripts on hand, so point at
  // the docs section that wires a host-side sidecar (plain text, no external link surface).
  "readiness.disconnectedDockerHint":
    'Running the cockpit from the Docker image? Wire a host-side sidecar — see "Observing a host agent" in docs/docker.md.',
  // ── per-agent wiring state (ADR 019f1972 §2b; observed value, not "real-time") ──
  "readiness.agent.claude.wired": "Claude Code: wired up (sessions will appear here)",
  "readiness.agent.claude.detected":
    "Claude Code: detected but not wired (inject the hook with actradeck doctor)",
  "readiness.agent.claude.missing": "Claude Code: not detected",
  "readiness.agent.codex.observable": "Codex: observable",
  "readiness.agent.codex.detected": "Codex: detected but rollout dir unresolved",
  "readiness.agent.codex.missing": "Codex: not detected",
  // Managed launch hint (ADR 019f3960 C): shown under the codex row when observable/detected.
  // Approval relay + prevention require Managed launch (rollout observation is detection-only).
  // The command itself is a shared literal rendered in <code> by SessionList (parity, runnable).
  "readiness.agent.codex.managedHint":
    "To relay approvals (prevention), launch Managed — rollout observation is detection-only:",

  // ── Codex Managed spawn (ADR 019f4206 phase A; launch from cockpit) ──
  "codexSpawn.title": "Launch Managed Codex",
  "codexSpawn.lead":
    "Launch Codex app-server in Managed mode via a connected attach daemon (approval relay and prevention enabled).",
  "codexSpawn.field.prompt": "Prompt",
  "codexSpawn.field.promptPlaceholder": "What should Codex do…",
  "codexSpawn.field.cwd": "Working directory (absolute path)",
  "codexSpawn.field.cwdPlaceholder": "/path/to/repo",
  "codexSpawn.field.daemon": "Target daemon",
  "codexSpawn.submit": "Launch",
  "codexSpawn.submitting": "Launching…",
  "codexSpawn.ok": "Managed Codex launched. The session will appear in the list.",
  "codexSpawn.limits":
    "Single prompt only (multi-turn not wired) and headless (not the TUI). After launch, approval cards arrive in the Inbox.",
  "codexSpawn.disabledHint":
    "No spawn-capable daemon. Set ACTRADECK_ENABLE_CODEX_SPAWN=1 on an attach daemon and restart to enable.",
  "codexSpawn.error.invalid_request": "Invalid request (check the prompt and working directory).",
  "codexSpawn.error.cwd_out_of_scope": "Working directory is outside the project scope.",
  "codexSpawn.error.spawn_disabled":
    "Codex spawn is disabled (set ACTRADECK_ENABLE_CODEX_SPAWN=1).",
  "codexSpawn.error.spawn_cap_reached": "Too many concurrent Managed Codex sessions.",
  "codexSpawn.error.spawn_failed": "Failed to launch Codex.",
  "codexSpawn.error.generic": "Launch failed.",

  // ── Audit coverage panel (ADR 019f4cdb follow-up; per-provider last received + gap detection) ──
  "audit.coverage.title": "Audit coverage",
  "audit.coverage.sessions": "{count} active",
  "audit.coverage.age": "{age} ago",
  "audit.coverage.noEvents": "no events",
  "audit.coverage.status.warn": "delayed",
  // TDA-6: hedged 形 ("stalled?"・既存 liveness 慣行 "STALLED?" と整合)。停止を断定しない。
  "audit.coverage.status.critical": "stalled?",
  // staleness surfacing (correcting false reassurance): stale = shown data is old (age since last success),
  // unreachable = never fetched successfully. Observed fact (fetch failed), not a fabricated state.
  "audit.coverage.staleBanner":
    "Showing data from {age} ago — the coverage API is not responding with valid data",
  "audit.coverage.unreachable": "Audit coverage: no valid response from the API",
  // seq-drop lower bound (ADR 019f4cdb Phase2). hedged ("?"): a hole in client-declared seq is a
  // **lower bound** (true loss may be higher; head/tail drops are undetectable).
  "audit.coverage.seqDrop": "≥{count} dropped?",
  // Display cap exceeded (SEC-1・prevents overflow display). "+" conveys "at least this many".
  "audit.coverage.seqDropCapped": "≥{count}+ dropped?",
  // seq-suppressed diagnostic (SEC-6・muted). Count of sessions whose drop signal was suppressed as
  // non-dense (severity-independent).
  "audit.coverage.seqSuppressed": "{count} seq-suppressed",
  "audit.coverage.seqSuppressed.title":
    "Sessions whose drop signal was suppressed as non-dense seq (a genuine massive drop can be suppressed too)",

  // ── first-run safety demo (ADR 019f22a7 P1; empty-state CTA) ──
  "safetyDemo.title": "Protected on this machine",
  "safetyDemo.lead":
    "ActraDeck supervises agents on this machine. The throwaway 30-second demo proves all three below.",
  "safetyDemo.cap.blockVerb": "Stops",
  "safetyDemo.cap.block":
    "Holds high-risk operations (rm -rf …/build) before approval so you can deny and stop them.",
  "safetyDemo.cap.redactVerb": "Redacts",
  "safetyDemo.cap.redact":
    "Redacts detected secrets before they are stored (only per-kind counts are shown).",
  "safetyDemo.cap.auditVerb": "Proves it",
  "safetyDemo.cap.audit":
    "Turns command, decision, redaction and diff into an auditable Session Replay.",
  "safetyDemo.cta": "Run the 30-second safety demo",
  "safetyDemo.launching": "Starting the demo…",
  "safetyDemo.running": "Demo running: when the approval card appears, press Deny to stop it.",
  "safetyDemo.error": "Could not start the demo. Please wait a moment and try again.",

  // ── post-demo next steps (task 019f41ec / decision 019fcdaf; bridge from the demo to real agents) ──
  // Shown only when every displayed session is a throwaway demo-safety-* session with ≥1 terminal.
  // Step bodies reuse the existing readiness.* keys (single source of copy).
  "postDemo.title": "You've seen the safety demo",
  "postDemo.lead":
    "That was a throwaway teaching session. Next, connect your own agents and your real work will show up here.",

  // ── liveness ──
  "liveness.live": "LIVE",
  "liveness.idle": "IDLE",
  "liveness.stalled": "STALLED?",
  "liveness.unknown": "UNKNOWN",
  "liveness.title.live": "fresh heartbeat observed",
  "liveness.title.idle": "signals stale but process not confirmed dead — not asserting stopped",
  "liveness.title.stalled.suspected": "process not alive and no fresh signal — stalled suspected",
  "liveness.title.stalled.reported":
    "stalled reported by backend — shown as suspected (UI never asserts stopped)",
  "liveness.title.unknown": "no heartbeat signals observed",

  // ── waiting ──
  "waiting.approval": "approval",
  "waiting.input": "input",
  "waiting.auth": "auth",

  // ── approval ──
  "approval.phase.pending": "Needs action",
  "approval.phase.sending": "Sending…",
  "approval.phase.allowed": "Allow sent",
  "approval.phase.allowedForSession": "Allow-for-session sent",
  "approval.phase.denied": "Deny sent",
  "approval.phase.cancelled": "Cancel sent",
  "approval.phase.failed": "Relay failed (please retry)",
  "approval.tool.unknown": "(unknown tool)",
  "approval.risk": "risk: {risk}",
  "approval.risk.unknown": "unknown",
  "approval.timeout.expired": "Timed out (auto-denied)",
  "approval.timeout.soon": "Timing out soon (~{seconds}s, fail-safe)",
  "approval.timeout.ok": "Auto-deny in ~{seconds}s (fail-safe estimate)",
  "approval.highRiskAck": "High-risk operation. I have reviewed it (check required to allow).",
  "approval.allow": "Allow",
  "approval.allow.title": "Allow this one time.",
  "approval.allowForSession": "Allow for session",
  "approval.allowForSession.title":
    "Auto-allow only the same operation (same tool, risk, and command/path) for the rest of this session. Everything else still asks.",
  "approval.allowPersist": "Allow after restart",
  "approval.allowPersist.title":
    "Auto-allow the same operation (same command, same repo) even after restart. Re-asks on expiry/revoke. Dangerous commands are excluded.",
  "approval.deny": "Deny",
  "approval.deny.title": "Deny this one time.",
  "approval.cancel": "Cancel",
  "approval.cancel.title": "Cancel the approval (treated as deny on the safe side).",
  // Auto-guard reason (ADR 019ecc70 D3): why it paused + detected secret kinds. Never raw values.
  "approval.reason.secret": "Secret detected",
  "approval.reason.destructive": "Destructive operation",
  "approval.reason.both": "Destructive operation + secret detected",
  "approval.reason.secretKind": "{label} detected",
  "approval.reason.secretKinds.aria": "detected secret kinds",

  // ── persisted approvals allowlist panel (PAL-v2 / ADR 019ee147) ──
  "allowlist.title": "Persisted approvals (this machine)",
  "allowlist.desc":
    "Approvals that survive restarts, shared across this machine (signature only; raw commands are never stored).",
  "allowlist.load": "Show persisted approvals",
  "allowlist.reload": "Reload",
  "allowlist.loading": "Loading…",
  "allowlist.empty": "No persisted approvals.",
  "allowlist.disabled": "Persistence is currently OFF (entries below are dormant; revoke only).",
  "allowlist.error": "Failed to load ({error})",
  "allowlist.count": "{count} item(s)",
  "allowlist.repo": "repo: {repo}",
  "allowlist.risk": "risk: {risk}",
  "allowlist.expires": "expires in {remaining}",
  "allowlist.expired": "expired",
  "allowlist.revoke": "Revoke",
  "allowlist.revoke.title":
    "Revoke this persisted approval (re-approval will be required next time).",
  "allowlist.revoking": "Revoking…",
  "allowlist.aria": "persisted approvals for this machine",

  // ── approval policy settings (PolicySettingsPanel) ──
  "policy.title": "Approval policy (this machine, under YOLO)",
  "policy.desc":
    "Even when running --dangerously-skip-permissions / --yolo, checked categories still require explicit approval. Applies to this whole machine.",
  "policy.load": "Show policy",
  "policy.reload": "Reload",
  "policy.loading": "Loading…",
  "policy.error": "Failed to load ({error})",
  "policy.enabledLabel": "Enable this policy",
  "policy.enabledHint":
    "When OFF, YOLO runs pass through every operation as before (pure passthrough).",
  "policy.envDisabled":
    "Disabled globally via env ACTRADECK_BYPASS_CATASTROPHIC_GATE; the settings below have no effect.",
  "policy.categoriesLegend": "Gated categories",
  "policy.defaultTag": "default",
  "policy.save": "Save",
  "policy.saving": "Saving…",
  "policy.aria": "approval policy for this machine",
  "policy.cat.recursive-rm": "Recursive delete (rm -rf)",
  "policy.cat.disk-destroy": "Disk destruction (mkfs / dd)",
  "policy.cat.history-rewrite": "History rewrite (git reset --hard, etc.)",
  "policy.cat.db-drop": "Database drop (DROP / TRUNCATE)",
  "policy.cat.fork-bomb": "Fork bomb",
  "policy.cat.secret-egress": "Secret egress (inline)",
  "policy.cat.perm-change": "Permission change (chmod -R, etc.)",
  "policy.cat.inline-code": "Inline code execution",
  "policy.cat.secret-file-edit": "Secret file edit (.env, etc.)",
  "policy.cat.external-tool": "External tool (MCP / WebFetch)",
  "policy.cat.migrate-prod": "Production migration",
  "policy.cat.high-risk-other": "Other high-risk (backstop)",
  // ── preset selector (ADR 019f23e1・PolicyPresetSelector) ──
  "policy.preset.legend": "Preset",
  "policy.preset.current": "Current preset:",
  "policy.preset.custom": "Custom",
  "policy.preset.strict": "Strict",
  "policy.preset.strict.summary":
    "Gates every category we can detect (safest; more approval prompts).",
  "policy.preset.balanced": "Balanced (recommended)",
  "policy.preset.balanced.summary":
    "The recommended default. Gates catastrophic operations plus secret egress and more.",
  "policy.preset.demo": "Demo (looser)",
  "policy.preset.demo.summary":
    "Gates only catastrophic, irreversible operations (rm -rf / disk destruction / fork bombs); everything else passes through ⚠.",
  "policy.preset.looserWarn":
    "This preset is looser than the recommended default (Balanced); operations that should be gated will pass through. It applies to this whole machine (under YOLO).",
  "policy.enforcementScope":
    "Prevention only takes effect in Managed mode (CC / Codex launched via ActraDeck). Attach observes only; Codex rollout detects only.",

  // ── per-repo approval policy view (ApprovalPolicyView) ──
  "approvalPolicy.title": "Approval policy (this machine, under YOLO)",
  "approvalPolicy.desc":
    "Choose which categories require explicit approval under --dangerously-skip-permissions / --yolo, per Default (machine baseline) and per repo. Applies to this whole machine.",
  "approvalPolicy.aria": "per-repo approval policy settings",
  "approvalPolicy.scopesAria": "policy scopes (Default and repos)",
  "approvalPolicy.noSession": "No connected session",
  "approvalPolicy.noSessionHint":
    "Viewing or changing the policy needs a running daemon (a connected live session). Start an agent first.",
  "approvalPolicy.offline": "No connected session (showing last-known settings)",
  "approvalPolicy.offlineHint":
    "Read-only. Refreshing, changing, or adding a repo needs a running daemon (a connected live session).",
  "approvalPolicy.offlineHintCached":
    "Read-only (last fetched: {when}). May differ from the actual gate state. Refreshing or changing needs a connection.",
  "approvalPolicy.loading": "Loading…",
  "approvalPolicy.reload": "Reload",
  "approvalPolicy.loadHint": "Select a scope.",
  "approvalPolicy.error": "Failed to load ({error})",
  "approvalPolicy.default": "Default",
  "approvalPolicy.defaultSub": "Machine baseline (default for all repos)",
  "approvalPolicy.unknownRepo": "(unknown repo)",
  "approvalPolicy.badge.override": "Override",
  "approvalPolicy.badge.default": "Inherits Default",
  "approvalPolicy.badge.observed": "Observed (click to configure)",
  "approvalPolicy.observed.legend": "Observed working directories",
  "approvalPolicy.observed.hint":
    "Click to resolve its git root and add it as a scope (the path is not stored).",
  "approvalPolicy.observed.note":
    "Working dirs of running/past sessions. Sub-dirs of the same repo collapse into one repo once configured.",
  "approvalPolicy.add.legend": "Add repo by path",
  "approvalPolicy.add.placeholder": "/absolute/path/to/repo",
  "approvalPolicy.add.button": "Resolve & add",
  "approvalPolicy.add.resolving": "Resolving…",
  "approvalPolicy.add.hint":
    "Enter an absolute path; the server resolves its git root and adds it as a scope (the path is not stored).",
  "approvalPolicy.add.error": "Failed to resolve ({error})",
  "approvalPolicy.detail.defaultTitle": "Default (machine baseline)",
  "approvalPolicy.detail.repoTitle": "{repo}",
  "approvalPolicy.loosenWarning":
    "This repo is looser than Default (it lets through some operations Default would gate).",
  "approvalPolicy.enabledLabel": "Enable this policy",
  "approvalPolicy.enabledHint":
    "When off, this scope lets all operations through under YOLO (pure passthrough).",
  "approvalPolicy.categoriesLegend": "Gated categories",
  "approvalPolicy.save": "Save",
  "approvalPolicy.saving": "Saving…",
  "approvalPolicy.resetToDefault": "Reset to Default",
  "approvalPolicy.resetHint": "Remove this repo's override and inherit Default.",
  // ── preset selector (ADR 019f23e1・PolicyPresetSelector) ──
  "approvalPolicy.preset.legend": "Preset",
  "approvalPolicy.preset.current": "Current preset:",
  "approvalPolicy.preset.custom": "Custom",
  "approvalPolicy.preset.strict": "Strict",
  "approvalPolicy.preset.strict.summary":
    "Gates every category we can detect (safest; more approval prompts).",
  "approvalPolicy.preset.balanced": "Balanced (recommended)",
  "approvalPolicy.preset.balanced.summary":
    "The recommended default. Gates catastrophic operations plus secret egress and more.",
  "approvalPolicy.preset.demo": "Demo (looser)",
  "approvalPolicy.preset.demo.summary":
    "Gates only catastrophic, irreversible operations (rm -rf / disk destruction / fork bombs); everything else passes through ⚠.",
  "approvalPolicy.preset.looserWarn":
    "This preset is looser than the recommended default (Balanced); operations that should be gated will pass through. Applying it to Default propagates to every repo without an override.",
  "approvalPolicy.enforcementScope":
    "Prevention only takes effect in Managed mode (CC / Codex launched via ActraDeck). Attach observes only; Codex rollout detects only.",

  // ── inbox ──
  "inbox.title": "Approvals",
  "inbox.summary": "{total} operations awaiting a decision ({sessions} sessions)",
  "inbox.aria": "approval inbox",
  "inbox.refresh.title": "Refetch pending approvals",
  "inbox.error.title": "Could not load pending approvals",
  "inbox.empty": "No approvals are pending.",
  "inbox.session": "session",
  "inbox.groupAria": "approvals for {sessionId}",
  "inbox.open.title": "Open this session's details",
  "inbox.replay.title": "Replay this session",

  // ── Action Rail (decision 019f69ef) ──
  "actionRail.aria": "Needs action",
  "actionRail.title": "Needs action",
  "actionRail.clear": "All clear — nothing needs you right now",
  "actionRail.signal.open.title": "Open this session's details",
  "actionRail.kind.approval": "Approval",
  "actionRail.kind.stalled": "Stalled?",
  "actionRail.kind.auth": "Auth",
  "actionRail.kind.input": "Input",
  "actionRail.kind.attention": "Attention",

  // ── detail ──
  "detail.empty.loading": "Loading details…",
  "detail.empty.select": "Select a session.",
  "detail.attention": "Needs attention",
  "detail.captureMode.nonManaged": "External launch ({mode})",
  "detail.captureMode.nonManaged.title":
    "This session is captured through a path ActraDeck does not launch. Some controls, such as stop, have no effect. Approval relay support depends on the agent and mode.",
  // ADR 019f47c2: observe-only badge for source=external (third-party adapter ingest; gemini/opencode/etc.).
  "detail.captureMode.external": "External (observe-only)",
  "detail.captureMode.external.title":
    "This session is external events ingested directly by a third-party adapter (observe-only). ActraDeck does not own its launch and cannot stop it or relay approvals (detection only).",
  // SEC-1/TDA-4: Codex-only hint split from the provider-agnostic base title; SessionDetail
  // appends it only when detail.provider === "codex" (claude-attach relays approvals, so no misdirection).
  "detail.captureMode.nonManaged.codexHint":
    'To relay Codex approvals (and prevention), launch it Managed: `{cmd} "<task>"`.',
  "detail.interrupt": "Interrupt (SIGINT)",
  "detail.interrupt.title":
    "Sends SIGINT to the managed claude to request a cooperative stop. This is not a rollback of the running tool. If not managed, it is safely ignored.",
  "detail.approval.head": "Approval needed",
  "detail.approval.pendingCount": "{count} operations awaiting a decision.",
  "detail.waiting.approval": "Approval needed",
  "detail.waiting.auth": "Waiting for auth",
  "detail.waiting.input": "Waiting for input",
  "detail.waiting.approval.body": "Approve or deny in the Web UI.",
  "detail.waiting.auth.body": "The agent needs to authenticate.",
  "detail.waiting.input.body": "The agent is waiting for input.",
  "detail.liveness.caption": "Liveness evidence (freshness per heartbeat signal)",
  // ADR 0014 Phase 3c: run lineage meta (enum values / short ids rendered verbatim; labels i18n'd).
  "detail.lineage.start": "start kind",
  "detail.lineage.continuedFrom": "continued from",
  "detail.lineage.linkedUnknown": "linked-unknown (declared, unobserved)",
  "detail.lineage.end": "end kind",
  "detail.lineage.continuation": "resumability",
  "detail.lineage.lastTurn": "last turn",
  "detail.lineage.runs": "runs",
  "detail.liveness.evidenceToggle": "Show liveness evidence (heartbeat breakdown)",
  "detail.liveness.col.signal": "signal",
  "detail.liveness.col.seen": "seen",
  "detail.liveness.col.age": "age",
  "detail.liveness.col.fresh": "fresh",
  "detail.liveness.col.note": "note",
  "detail.liveness.seen.yes": "yes",
  "detail.liveness.fresh": "fresh",
  "detail.liveness.stale": "stale",
  "detail.meta.repo": "repo",
  "detail.meta.cwd": "cwd",
  "detail.meta.provider": "provider",
  "detail.meta.invalidTransitions": "invalid transitions",

  // ── current action ──
  "action.view.modelStream": "Model responding",
  "action.view.command": "Running command",
  "action.view.fileEdit": "Editing file",
  "action.view.mcp": "Calling MCP tool",
  "action.view.web": "Searching the web",
  "action.view.waiting": "Awaiting intervention",
  "action.view.idle": "No active work",
  "action.currentAria": "Current work",
  "action.kill": "Stop (SIGINT)",
  "action.kill.title":
    "Sends SIGINT to the managed claude to request a cooperative stop. This is not a rollback of the running tool. If not managed, it is safely ignored.",
  "action.empty": "No active work is currently observed.",
  "action.meta.cwd": "cwd",
  "action.meta.elapsed": "elapsed",
  "action.meta.exitCode": "exit code",
  "action.output.load": "Show stdout",
  "action.output.loading": "Loading output…",
  "action.output.load.title": "Fetches and shows this command's stdout (tail). Output is redacted.",
  "action.output.error": "Failed to load output: {error}",
  "action.output.empty": "(no output)",
  "action.output.truncated": "\n[showing only the tail of the output]",
  "action.output.aria": "stdout (tail, redacted)",

  // ── timeline ──
  "timeline.title": "Execution timeline",
  "timeline.aria": "Execution timeline (chronological; new rows are appended at the end)",
  "timeline.empty": "No events yet.",

  // ── work-items panel (ADR 0015 §D8) ─────────────────────────────────────
  "workitem.panel.title": "Work items",
  "workitem.panel.aria": "Work items and verification state",
  "workitem.panel.empty": "No work items observed yet.",
  "workitem.noSubject": "(no subject)",
  "workitem.dropped": "{count} dropped over cap",
  "workitem.count.claimedUnverified": "{count} self-claimed",
  "workitem.count.claimedUnverified.title": "Items claimed complete but not verified",
  "workitem.badge.self_claimed": "Self-claimed",
  "workitem.badge.self_claimed.title":
    "The agent says it is done; no verification has been observed yet.",
  "workitem.badge.verified": "Verified",
  "workitem.badge.verified.title": "A bound check passed (matches the current tree fingerprint).",
  "workitem.badge.verification_failed": "Verification failed",
  "workitem.badge.verification_failed.title":
    "The latest recognized check failed on the tree that includes this claimed work (not necessarily this claim).",
  "workitem.badge.changed_after_verification": "Changed after verification",
  "workitem.badge.changed_after_verification.title":
    "The tree fingerprint changed after verification; the pass no longer applies to the current code.",
  "workitem.status.pending": "Pending",
  "workitem.status.in_progress": "In progress",
  "workitem.status.completed": "Completed",
  "workitem.status.cancelled": "Cancelled",
  "workitem.status.removed": "Removed",
  "workitem.status.unknown": "Unknown",
  "workitem.evidence.methodLabel": "Channel: {value}",
  "workitem.evidence.fidelityLabel": "Fidelity: {value}",
  "workitem.evidence.method.official_hook": "Official hook",
  "workitem.evidence.method.official_api": "Official API",
  "workitem.evidence.method.provider_jsonl": "Provider JSONL",
  "workitem.evidence.method.local_file": "Local file",
  "workitem.evidence.method.log_parse": "Log parse",
  "workitem.evidence.method.heuristic": "Heuristic",
  "workitem.evidence.fidelity.authoritative": "Authoritative",
  "workitem.evidence.fidelity.observed": "Observed",
  "workitem.evidence.fidelity.parsed": "Parsed",
  "workitem.evidence.fidelity.inferred": "Inferred",
  "workitem.evidence.fidelity.unknown": "Unknown",
  "workitem.check.label": "Check: {kind} ({match})",
  "workitem.check.labelKindOnly": "Check: {kind}",
  "workitem.check.kind.test": "test",
  "workitem.check.kind.lint": "lint",
  "workitem.check.kind.typecheck": "typecheck",
  "workitem.check.kind.build": "build",
  "workitem.check.kind.format": "format",
  "workitem.check.match.program": "program",
  "workitem.check.match.script": "script",
  "workitem.check.exit": "exit {code}",
  "workitem.runDirty": "Changed during check",
  "workitem.runDirty.title":
    "The tree moved while the check ran (the pass is not cleanly attributable).",
  "workitem.stale.reason": "Tree changed after verification",
  "workitem.ref.label": "Evidence:",
  "workitem.ref.jump": "Jump to the matching timeline event",
  "workitem.ref.claim": "Claim",
  "workitem.ref.check": "Check",
  "workitem.ref.diff": "Diff",
  "timeline.risk": "risk:{risk}",
  "timeline.exit": "exit:{code}",

  // ── Action-unit view (action-units / line grammar + detail modal) ──────────
  "action.verb.approvalResolved": "Approval → {decision}",
  "action.verb.approvalPending": "Awaiting approval",
  "action.verb.approvalHistory": "Approval (history)",
  "action.verb.command": "Run command",
  "action.verb.file": "Change file",
  "action.verb.tool": "Run tool",
  "action.verb.mcp": "MCP call",
  "action.verb.web": "Web search",
  "action.verb.turn": "Turn",
  "action.verb.session": "Session",
  "action.verb.message": "Message",
  "action.verb.liveness": "Liveness",
  "action.verb.error": "Error",
  "action.currentAction.withSubject": "{verb}: {subject}",
  "action.decision.allow": "allowed",
  "action.decision.deny": "denied",
  "action.decision.unknown": "resolved",
  "action.result.exit": "exit {code}",
  "action.autoAllowed": "auto-allowed",
  "action.outcome.succeeded": "succeeded",
  "action.outcome.failed": "failed",
  "action.outcome.running": "running",
  "action.toggle.label": "View",
  "action.toggle.units": "Action units",
  "action.toggle.raw": "Raw events",
  "action.row.aria": "{verb}: {target}",
  "action.row.openDetails": "Open details",
  "action.target.none": "(no target)",

  // ── Detail modal (kit Modal + ActionUnit detail) ───────────────────────────
  "modal.close": "Close",
  "modal.detail.title": "Action detail",
  "modal.detail.target": "Target",
  "modal.detail.targetNone": "(no target observed)",
  "modal.detail.copy": "Copy target",
  "modal.detail.copied": "Copied",
  "modal.detail.action": "Action",
  "modal.detail.time": "Time",
  "modal.detail.timeRange": "{start} – {end}",
  "modal.detail.cwd": "Working directory",
  "modal.detail.approval": "Approval chain",
  "modal.detail.risk": "Risk: {risk}",
  "modal.detail.decision": "Decision: {decision}",
  "modal.detail.autoAllowed": "Auto-allowed: {value}",
  "modal.detail.exit": "exit code: {code}",
  "modal.detail.elapsed": "Elapsed: {elapsed}",
  "modal.detail.events": "Constituent events",
  "modal.bool.true": "yes",
  "modal.bool.false": "no",
  "modal.output.load": "View output",
  "modal.output.loading": "Loading output…",
  "modal.output.error": "Failed to load output: {error}",
  "modal.output.empty": "(no output)",
  "modal.output.truncated": "\n[output shows tail only]",
  "modal.output.notFound": "No output was found for this command.",
  "modal.output.aria": "stdout (tail, redacted)",
  "modal.diff.load": "View current diff",
  "modal.diff.loading": "Loading diff…",
  "modal.diff.error": "Failed to load diff: {error}",
  "modal.diff.empty": "(no diff)",
  "modal.diff.truncated": "\n[diff truncated at size limit]",
  "modal.diff.note":
    "This is the session's current working-tree diff (not a diff specific to this row).",
  "modal.diff.secret": "secrets detected: {count} (redacted)",
  "modal.diff.aria": "git diff body (redacted)",

  // ── risk ──
  "risk.title": "Changes & risk",
  "risk.aria": "Changes & risk",
  "risk.highest": "Highest risk: {risk}",
  "risk.files": "Changed files: {count}",
  "risk.mcp": "MCP calls present",
  "risk.web": "Web/network present",
  "risk.failure": "Non-zero exit present",
  "risk.captureMode": "Capture: {mode}",
  "risk.captureMode.external": "Capture: external (observe-only)",
  "risk.permission": "Permission: {mode}",
  "risk.permission.title":
    "This session's permission mode (sandbox). bypassPermissions / acceptEdits auto-allow broadly — take care.",
  "risk.secretDetected": "Secrets detected: {count} (redacted)",
  "risk.secretDetected.title":
    "Secrets were detected in the diff body and redacted. Masked values are not shown (count only).",
  "risk.secretDetected.session": "Secrets detected in this session: {count} (redacted)",
  "risk.secretDetected.session.unknown": "Secrets detected in this session (redacted)",
  "risk.secretDetected.session.title":
    "Redaction detected secrets at least once in this session (session-level, always shown). The count is detection density; masked values are not shown.",
  "risk.diff.load": "Show diff body",
  "risk.diff.loading": "Loading diff…",
  "risk.diff.load.title":
    "Fetches and shows the working tree's git diff body. The diff is redacted.",
  "risk.diff.error": "Failed to load diff: {error}",
  "risk.diff.empty": "(no diff)",
  "risk.diff.truncated": "\n[diff truncated at the size limit]",
  "risk.diff.aria": "git diff body (redacted)",
  "risk.note":
    'Show the diff body and secret-detection count via "Show diff body" in session details.',

  // ── Redaction kind breakdown ──
  "risk.redaction.breakdown": "Redaction breakdown",
  "risk.redaction.breakdown.title":
    "Per-kind counts of secrets redacted in this session (public enum + count only; masked values are not shown).",
  "risk.redaction.kindCount": "{label} ×{count}",
  "risk.redaction.total": "{count} total",
  "risk.redaction.unknownKind": "Other secret",
  "redaction.kind.private-key": "Private key",
  "redaction.kind.aws-access-key-id": "AWS access key",
  "redaction.kind.github-token": "GitHub token",
  "redaction.kind.anthropic-key": "Anthropic key",
  "redaction.kind.openai-key": "OpenAI key",
  "redaction.kind.google-api-key": "Google API key",
  "redaction.kind.slack-token": "Slack token",
  "redaction.kind.stripe-key": "Stripe key",
  "redaction.kind.gitlab-token": "GitLab token",
  "redaction.kind.sendgrid-key": "SendGrid key",
  "redaction.kind.huggingface-token": "Hugging Face token",
  "redaction.kind.azure-ad-client-secret": "Azure AD client secret",
  "redaction.kind.databricks-token": "Databricks token",
  "redaction.kind.doppler-token": "Doppler token",
  "redaction.kind.planetscale-token": "PlanetScale token",
  "redaction.kind.flyio-token": "Fly.io token",
  "redaction.kind.slack-webhook": "Slack webhook",
  "redaction.kind.discord-webhook": "Discord webhook",
  "redaction.kind.jwt": "JWT",
  "redaction.kind.basic-auth": "Basic auth",
  "redaction.kind.bearer-token": "Bearer token",
  "redaction.kind.auth-header-scheme": "Authorization scheme",
  "redaction.kind.auth-scheme-value": "Authorization value",
  "redaction.kind.cookie": "Cookie",
  "redaction.kind.npm-auth-token": "npm auth token",
  "redaction.kind.credential-assignment": "Credential assignment",
  "redaction.kind.url-credential": "URL credential",
  "redaction.kind.high-entropy-secret": "High-entropy secret",
  "redaction.kind.sentry-dsn": "Sentry DSN",

  // ── notifications ──
  "notification.enable": "Enable notifications",
  "notification.enable.title":
    "Get browser notifications for approval / stalled / failure (only while the tab is in the background). Click to ask for permission.",
  "notification.disable": "Disable notifications",
  "notification.disable.title": "Stop browser notifications (permission state is left unchanged).",
  "notification.denied": "Notifications blocked",
  "notification.denied.title":
    "Notifications are blocked in your browser. Allow them from the site's permission settings.",
  "notification.unsupported": "Notifications unsupported",
  "notification.categories.aria": "Notification categories",
  "notification.category.approval": "Approval",
  "notification.category.stalled": "Stalled",
  "notification.category.failed": "Failed",
  "notification.approval.title": "Approval needed: {session}",
  "notification.approval.body": "{location} — awaiting a decision ({state})",
  "notification.stalled.title": "Stalled suspected: {session}",
  "notification.stalled.body": "{location} — no events for 60s+ ({state})",
  "notification.failed.title": "Failed: {session}",
  "notification.failed.body": "{location} — terminated abnormally ({state})",

  // ── wall ──
  "wall.title": "Live Wall",
  "wall.aria": "live wall",
  "wall.summary": "{count} sessions · activity over the last {window}",
  "wall.attentionJump": "Needs attention {count}",
  "wall.attentionJump.title": "Jump through lanes needing attention (approval/input wait)",
  "wall.group.byProject": "Group by project",
  "wall.group.toggle.title":
    "Cluster sessions by project (repo or working directory); turn off for manual ordering",
  "wall.group.none": "Unknown location",
  "wall.refresh.title": "Refetch the cross-session feed",
  "wall.legend.label": "Bar color = action type:",
  "wall.legend.aria": "Bar color legend",
  "wall.legend.command": "Command",
  "wall.legend.file": "File / diff",
  "wall.legend.approval": "Approval / error",
  "wall.legend.liveness": "Liveness signal",
  "wall.legend.default": "Tool / MCP / other",
  "wall.error.title": "Could not load the cross-session feed",
  "wall.empty": "No actions from live sessions.",
  "wall.laneAria": "wall lane {sessionId}",
  "wall.lane.session": "session",
  "wall.lane.attention": "Needs attention",
  "wall.lane.claimedUnverified": "{count} unverified",
  "wall.lane.claimedUnverified.title":
    "Work items claimed complete but unverified (separate from needs-attention)",
  "wall.lane.open.title": "Open this session's details",
  "wall.lane.replay.title": "Replay this session",
  "wall.lane.dragHandle.title": "Drag to reorder (use ↑/↓ buttons for keyboard)",
  "wall.lane.collapse.aria": "{verb} the lane for {sessionId}",
  "wall.lane.collapse.expand": "Expand",
  "wall.lane.collapse.collapse": "Collapse",
  "wall.lane.collapse.titleExpand": "Expand lane (show bars)",
  "wall.lane.collapse.titleCollapse": "Collapse lane (header only)",
  "wall.lane.move.aria": "Reorder lanes",
  "wall.lane.moveUp.aria": "Move {sessionId} up",
  "wall.lane.moveUp.title": "Move up",
  "wall.lane.moveDown.aria": "Move {sessionId} down",
  "wall.lane.moveDown.title": "Move down",
  "wall.lane.elapsed": "Running {elapsed}",
  "wall.track.aria": "{count} actions (last {window})",
  "wall.track.empty": "No events in this window",
  "wall.approvalsAria": "approvals for {sessionId}",

  // ── time ──
  "time.now": "now",
  "time.ago": "{elapsed} ago",
  "time.elapsed.seconds": "{seconds}s",
  "time.elapsed.minutes": "{minutes}m {seconds}s",
  "time.window.minutes": "{minutes}m",
  "time.window.seconds": "{seconds}s",

  // ── replay ──
  "replay.title": "Replay",
  "replay.aria": "session-replay",
  "replay.loading": "Loading replay…",
  "replay.empty": "Select a session.",
  "replay.loadMore": "Load more",
  "replay.error.title": "Replay error",
  "replay.invalid.title": "Invalid events",
  "replay.invalid.subtitle": "Events excluded from projection: {count}",
  "replay.limitReached": "Reached the replay display limit of {limit} events.",
  "replay.stepBack": "Back",
  "replay.play": "Play",
  "replay.pause": "Pause",
  "replay.stepNext": "Next",
  "replay.speed": "Speed",
  "replay.position.aria": "Playback position",
  "replay.position.valuetext": "{current} / {total}",
  "replay.position.noEvents": "No events",
  "replay.state.state": "state",
  "replay.state.current": "current",
  "replay.state.pending": "pending",
  "replay.replaying": "Replaying",
  "replay.identity.aria": "Session being replayed",
  "replay.identity.session": "session",
};

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { ja, en };

/**
 * locale + key からメッセージを引き、`{name}` プレースホルダを params で置換する。
 * - locale 未知時 (理論上到達しない) は ja にフォールバック。
 * - params に無いプレースホルダは原文 `{name}` のまま残す (欠落を可視化・無言の空文字にしない)。
 */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const catalog = CATALOGS[locale] ?? ja;
  const template = catalog[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/** テスト/INV 用に両カタログを公開する (実行時キー集合・プレースホルダ検証)。 */
export const CATALOGS_FOR_TEST: Record<Locale, Record<string, string>> = { ja, en };
