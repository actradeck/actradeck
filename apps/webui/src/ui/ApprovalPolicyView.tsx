"use client";

/**
 * ApprovalPolicyView — bypass/YOLO 承認ポリシーの **per-repo 設定画面** (ADR 019f0eca・監査タブの隣)。
 *
 * master-detail:
 *  - 左: 「Default(マシン基準)」を先頭固定 + repo override 一覧 (Override/Default バッジ) +
 *    **観測 cwd サジェスト** (ADR §8・観測済みセッションの distinct cwd を basename で提示) + repo 追加導線。
 *  - 右: 選択 scope のカテゴリ checkbox (default プリセット表示・緩和時警告・「Default に戻す」) +
 *    「この repo の永続承認」(allowlist) を同居 (両者 repo-scoped)。
 *
 * 設計:
 *  - policy は **machine-global** (この端末の全 daemon が共有)。sessionId は relay の宛先解決にのみ使う。
 *    接続中の live session が無いと relay できないため、その旨を正直に表示する。
 *  - categories は **closed enum (PolicyCategory)** のみ (生コマンド非描画・NO-RAW)。
 *  - repo 追加は **方式B** (絶対パス入力→server-side git root 解決→scope)。生パスは保存も再表示もしない
 *    (scope=hash・label=basename のみ)。方式A (サーバ側ディレクトリブラウザ) は次段。
 *  - **観測 cwd サジェスト** (ADR §8): 既知セッションの cwd を basename だけ提示し、クリックで方式B と同じ
 *    resolve 経路 (cwd→git root→scope) を呼んで candidate 化する。生 cwd は DOM へ出さない (label=basename・
 *    key=非可逆ハッシュ・生 cwd は resolve 入力に限る)。表示専用で override 化は明示 Save→relay が必須。
 *  - 編集はドラフトで行い Save まで適用しない。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_GATED_CATEGORIES,
  PolicyCategory,
  sanitizeRepoLabel,
} from "@actradeck/event-model";

import { Button, InlineAlert, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { PersistedApprovalsPanel } from "./PersistedApprovalsPanel";
import { loadCandidateStubs, saveCandidateStubs } from "./policy-cache";
import {
  usePolicyAdmin,
  type PolicyRelayTarget,
  type PolicyRepoSummary,
  type PolicyScopeView,
} from "./use-policy-admin";

/** 全 policy カテゴリ (checkbox 母集合・T1 enum 単一ソース)。 */
const ALL_CATEGORIES: readonly PolicyCategory[] = PolicyCategory.options;
const DEFAULT_SET: ReadonlySet<PolicyCategory> = new Set(DEFAULT_GATED_CATEGORIES);
/** 左ペインの Default 項目を表す選択キー (repoScope は常に非空 hex ゆえ空文字で衝突しない)。 */
const DEFAULT_KEY = "";

export interface ApprovalPolicyViewProps {
  readonly active: boolean;
  /**
   * ADR 019f1582: policy relay の宛先。接続中エージェントセッション (kind="session"・従来経路) か、
   * 接続中 daemon の直指定 (kind="daemon"・エージェント未稼働でも per-repo 設定可)。どちらも無い場合 null
   * = offline (read-only)。policy は machine-global ゆえどちらの宛先でも fan-out で全 daemon へ収束する。
   */
  readonly relayTarget: PolicyRelayTarget | null;
  /** 残り期限算出の基準時刻 (allowlist co-location の決定論化用)。 */
  readonly nowMs?: number;
  /**
   * ADR 019f0eca §8: 観測済みセッションの作業ディレクトリ (distinct cwd)。左ペインに「観測（未設定）」
   * サジェストとして basename のみ描画し、クリックで既存 resolve 経路 (cwd→git root→scope) へ流す。
   * **生パスは DOM へ出さない** (label=basename・key=非可逆ハッシュ)。生パスは onClick の resolve 入力に限る。
   */
  readonly observedCwds?: readonly string[];
}

function setEquals(a: ReadonlySet<PolicyCategory>, b: ReadonlySet<PolicyCategory>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** cwd の非可逆 UI キー (djb2→base36)。生パスを DOM 属性/testid へ出さないための安定識別子。 */
function cwdKey(cwd: string): string {
  let h = 5381;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) + h + cwd.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function ApprovalPolicyView({
  active,
  relayTarget,
  nowMs,
  observedCwds,
}: ApprovalPolicyViewProps): React.JSX.Element {
  const { t, locale } = useLocale();
  const { data, loading, error, saving, reload, save, unset, resolve, cachedAt } =
    usePolicyAdmin(relayTarget);
  // 安定 key (kind:id)。effect 依存に object を直接載せず churn を防ぐ。daemon 再接続で id が変われば key も
  // 変わり auto-refresh が 1 度再発火する (新 daemon の最新値を取得)。
  const relayTargetKey = relayTarget ? `${relayTarget.kind}:${relayTarget.id}` : null;
  // allowlist (list/revoke) は本 PR の scope 外で session-scoped 維持。session 宛のときのみ sessionId を渡す
  // (daemon-only モードでは allowlist 同居を非表示・daemon 宛 allowlist は follow-up)。
  const allowlistSessionId = relayTarget?.kind === "session" ? relayTarget.id : null;

  // 選択中 scope ("" = Default / それ以外 = repoScope)。
  const [selected, setSelected] = useState<string>(DEFAULT_KEY);
  // resolve で追加したが未保存の repo (default 継承・list には現れない)。scope→ビュー。
  const [candidates, setCandidates] = useState<ReadonlyMap<string, PolicyScopeView>>(new Map());
  // 観測 cwd のうち resolve 済 (candidate/override 化・または解決失敗で隠す) のもの。サジェストから除く。
  const [resolvedCwds, setResolvedCwds] = useState<ReadonlySet<string>>(new Set());
  // 方式B のパス入力。
  const [addPath, setAddPath] = useState("");
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [resolving, setResolving] = useState(false);
  // 編集ドラフト。
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftCats, setDraftCats] = useState<ReadonlySet<PolicyCategory>>(new Set());

  // relay-target が在る間は active 化 / target 変化で 1 度 pull し live 値へ更新する。
  // キャッシュ復元で data が既に在っても、target が在れば必ず最新へ refresh する
  // (loadedTargetRef で target 毎に 1 回・churn を防ぐ)。relay-target ゼロ (relayTargetKey=null) では
  // pull せず、hook が復元したキャッシュ (last-known) を read-only で見せる。
  const loadedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !relayTargetKey) return;
    if (loading) return;
    // TDA-3: error ガードは置かない。前 target の sticky error が次 target の auto-refresh を
    // 阻むのを防ぐ (loadedTargetRef が同 target 連打を防ぎ、reload 自身が error を clear する)。
    // QA-8 (観測のみ): loadedTargetRef はリセットしないため target が offline→同一 key へ戻った場合は
    // auto-refresh が再発火せず last-known を表示し続ける (reload ボタンで手動更新可)。表示専用ゆえ
    // INV-APPROVAL 非該当。daemon 再接続で id (=key) が変われば再発火し新 daemon の最新値を取得する。
    if (loadedTargetRef.current === relayTargetKey) return;
    loadedTargetRef.current = relayTargetKey;
    reload();
  }, [active, relayTargetKey, loading, reload]);

  // relay-target ゼロ (接続中 session も daemon も無い) = read-only。mutation (save/unset/resolve) は
  // relay = 接続中の session 所有 daemon または接続中 daemon 直指定が要る (ADR 019f1582)。
  const offline = !relayTarget;

  // 手動 add した未保存 candidate をリロード跨ぎで保持する。data (defaultView) 確定後 1 回だけ
  // localStorage から復元し、現 Default を継承する candidate として一覧へ戻す。既に override 化
  // された scope は復元しない (list が権威)。
  const candidatesHydratedRef = useRef(false);
  useEffect(() => {
    if (candidatesHydratedRef.current || data === undefined) return;
    candidatesHydratedRef.current = true;
    const stubs = loadCandidateStubs();
    if (stubs.length === 0) return;
    const overrideSet = new Set(data.repos.map((r) => r.repoScope));
    setCandidates((prev) => {
      const next = new Map(prev);
      for (const s of stubs) {
        if (overrideSet.has(s.repoScope) || next.has(s.repoScope)) continue;
        next.set(s.repoScope, {
          enabled: data.defaultView.enabled,
          categories: data.defaultView.categories,
          envGateEnabled: data.defaultView.envGateEnabled,
          repoScope: s.repoScope,
          ...(s.repoLabel !== undefined ? { repoLabel: s.repoLabel } : {}),
          isOverride: false,
        });
      }
      return next;
    });
  }, [data]);

  // candidate 集合の変化を永続する (hydration 完了後のみ・初回空での上書きを防ぐ)。
  useEffect(() => {
    if (!candidatesHydratedRef.current) return;
    saveCandidateStubs(
      [...candidates.entries()].map(([repoScope, v]) => ({
        repoScope,
        ...(v.repoLabel !== undefined ? { repoLabel: v.repoLabel } : {}),
      })),
    );
  }, [candidates]);

  // 選択 scope の現在ビューを解決 (Default / override / candidate)。
  const currentView: PolicyScopeView | undefined = useMemo(() => {
    if (data === undefined) return undefined;
    if (selected === DEFAULT_KEY) return data.defaultView;
    const ov = data.repos.find((r) => r.repoScope === selected);
    if (ov !== undefined) {
      return {
        enabled: ov.enabled,
        categories: ov.categories,
        envGateEnabled: data.defaultView.envGateEnabled,
        repoScope: ov.repoScope,
        ...(ov.repoLabel !== undefined ? { repoLabel: ov.repoLabel } : {}),
        isOverride: true,
      };
    }
    return candidates.get(selected);
  }, [data, selected, candidates]);

  // 選択/データ変化でドラフトを同期。
  useEffect(() => {
    if (currentView === undefined) return;
    setDraftEnabled(currentView.enabled);
    setDraftCats(new Set(currentView.categories));
  }, [currentView]);

  function toggleCat(cat: PolicyCategory): void {
    setDraftCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  const dirty =
    currentView !== undefined &&
    (draftEnabled !== currentView.enabled ||
      !setEquals(draftCats, new Set(currentView.categories)));

  // 緩和警告: Default より緩い repo override (Default が gate する category を外す / 無効化) のとき。
  const isRepo = selected !== DEFAULT_KEY;
  const defaultCats = data?.defaultView.categories ?? [];
  const looser =
    isRepo &&
    data !== undefined &&
    ((data.defaultView.enabled && !draftEnabled) || defaultCats.some((c) => !draftCats.has(c)));

  async function onSave(): Promise<void> {
    const scope = selected === DEFAULT_KEY ? undefined : selected;
    const label = currentView?.repoLabel;
    try {
      await save(scope, {
        enabled: draftEnabled,
        categories: [...draftCats],
        ...(label !== undefined ? { repoLabel: label } : {}),
      });
      // override 化したので candidate からは外す (list が権威表示になる)。
      if (scope !== undefined) {
        setCandidates((prev) => {
          if (!prev.has(scope)) return prev;
          const next = new Map(prev);
          next.delete(scope);
          return next;
        });
      }
    } catch {
      /* error は hook が state へ載せる。 */
    }
  }

  async function onReset(): Promise<void> {
    if (selected === DEFAULT_KEY) return;
    const scope = selected;
    const label = currentView?.repoLabel;
    try {
      await unset(scope);
      // Default 継承の candidate として残し、一覧から消えないようにする。
      setCandidates((prev) => {
        const next = new Map(prev);
        next.set(scope, {
          enabled: data?.defaultView.enabled ?? true,
          categories: data?.defaultView.categories ?? [],
          envGateEnabled: data?.defaultView.envGateEnabled ?? true,
          repoScope: scope,
          ...(label !== undefined ? { repoLabel: label } : {}),
          isOverride: false,
        });
        return next;
      });
    } catch {
      /* error は hook が state へ載せる。 */
    }
  }

  // path を resolve し scope を candidate 化/選択する共通経路 (手動 add と観測 cwd ピック双方)。成功で true。
  async function resolveAndAdd(path: string): Promise<boolean> {
    setResolving(true);
    setAddError(undefined);
    try {
      const r = await resolve(path);
      // 既に override 済みなら list に在るので選択のみ。未 override は candidate へ。
      if (!r.isOverride) {
        setCandidates((prev) => {
          const next = new Map(prev);
          next.set(r.repoScope, {
            enabled: r.enabled,
            categories: r.categories,
            envGateEnabled: data?.defaultView.envGateEnabled ?? true,
            repoScope: r.repoScope,
            ...(r.repoLabel !== undefined ? { repoLabel: r.repoLabel } : {}),
            isOverride: false,
          });
          return next;
        });
      }
      setSelected(r.repoScope);
      return true;
    } catch (err) {
      setAddError((err as Error).message);
      return false;
    } finally {
      setResolving(false);
    }
  }

  async function onAdd(): Promise<void> {
    const path = addPath.trim();
    if (path.length === 0) return;
    if (await resolveAndAdd(path)) setAddPath("");
  }

  // 観測 cwd サジェストのクリック: 同経路で resolve。成功時のみサジェストから外す (candidate/override
  // として別途出るため)。失敗 (非 git/scope 外) は addError を出しつつ再掲を許す (transient 失敗の再試行可)。
  async function onPickObserved(cwd: string): Promise<void> {
    if (await resolveAndAdd(cwd)) {
      setResolvedCwds((prev) => {
        const next = new Set(prev);
        next.add(cwd);
        return next;
      });
    }
  }

  // 左ペイン項目: Default + override (list) + candidate (未保存)。重複 scope は override 優先。
  const repoItems: PolicyRepoSummary[] = useMemo(() => {
    const out: PolicyRepoSummary[] = data ? [...data.repos] : [];
    const have = new Set(out.map((r) => r.repoScope));
    for (const [scope, v] of candidates) {
      if (have.has(scope)) continue;
      out.push({
        repoScope: scope,
        ...(v.repoLabel !== undefined ? { repoLabel: v.repoLabel } : {}),
        enabled: v.enabled,
        categories: v.categories,
      });
    }
    return out.sort((a, b) =>
      (a.repoLabel ?? a.repoScope).localeCompare(b.repoLabel ?? b.repoScope),
    );
  }, [data, candidates]);

  const overrideScopes = useMemo(
    () => new Set((data?.repos ?? []).map((r) => r.repoScope)),
    [data],
  );

  // 観測 cwd サジェスト: distinct cwd を basename ラベルへ畳む。resolve 済 cwd は除外。
  // NO-RAW: basename 化できない (sanitize 後空) cwd はサジェストしない (生 cwd を label/DOM に出さない)。
  const observedItems = useMemo(() => {
    const seen = new Set<string>();
    const out: { readonly cwd: string; readonly label: string; readonly key: string }[] = [];
    for (const cwd of observedCwds ?? []) {
      if (typeof cwd !== "string" || cwd.length === 0) continue;
      if (resolvedCwds.has(cwd) || seen.has(cwd)) continue;
      seen.add(cwd);
      const label = sanitizeRepoLabel(cwd);
      if (label === undefined) continue;
      out.push({ cwd, label, key: cwdKey(cwd) });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [observedCwds, resolvedCwds]);

  // 接続ゼロ かつ キャッシュも無い (last-known 未取得) → 真に表示できるものが無い。
  if (offline && data === undefined) {
    return (
      <section
        className="ad-policyview"
        data-testid="policyview"
        aria-label={t("approvalPolicy.aria")}
      >
        <h2 className="ad-pane-title">{t("approvalPolicy.title")}</h2>
        <InlineAlert
          kind="info"
          data-testid="policyview-no-session"
          title={t("approvalPolicy.noSession")}
          subtitle={t("approvalPolicy.noSessionHint")}
        />
      </section>
    );
  }

  return (
    <section
      className="ad-policyview"
      data-testid="policyview"
      aria-label={t("approvalPolicy.aria")}
    >
      <div className="ad-policyview__head">
        <h2 className="ad-pane-title">{t("approvalPolicy.title")}</h2>
        <p className="ad-policyview__desc">{t("approvalPolicy.desc")}</p>
        <Button
          kind="ghost"
          size="sm"
          iconStart="time"
          data-testid="policyview-reload"
          onClick={() => reload()}
          disabled={loading || saving || offline}
        >
          {loading ? t("approvalPolicy.loading") : t("approvalPolicy.reload")}
        </Button>
      </div>

      {offline ? (
        <InlineAlert
          kind="info"
          data-testid="policyview-offline"
          title={t("approvalPolicy.offline")}
          subtitle={
            cachedAt !== undefined
              ? t("approvalPolicy.offlineHintCached", {
                  when: new Date(cachedAt).toLocaleString(locale === "ja" ? "ja-JP" : "en-US"),
                })
              : t("approvalPolicy.offlineHint")
          }
        />
      ) : null}

      {data?.defaultView.envGateEnabled === false ? (
        <InlineAlert
          kind="warning"
          data-testid="policyview-env-disabled"
          title={t("policy.envDisabled")}
        />
      ) : null}

      {error !== undefined ? (
        <p className="ad-body-error" data-testid="policyview-error">
          {t("approvalPolicy.error", { error })}
        </p>
      ) : null}

      <div className="ad-policyview__grid">
        {/* 左: scope 一覧 + repo 追加。 */}
        <aside className="ad-policyview__list" aria-label={t("approvalPolicy.scopesAria")}>
          <ul className="ad-policyview__scopes" data-testid="policyview-scopes">
            <li>
              <button
                type="button"
                className="ad-policyview__scope"
                data-testid="policyview-scope-default"
                data-active={selected === DEFAULT_KEY}
                aria-pressed={selected === DEFAULT_KEY}
                onClick={() => setSelected(DEFAULT_KEY)}
              >
                <span className="ad-policyview__scope-label">{t("approvalPolicy.default")}</span>
                <span className="ad-policyview__scope-sub">{t("approvalPolicy.defaultSub")}</span>
              </button>
            </li>
            {repoItems.map((r) => {
              const isOv = overrideScopes.has(r.repoScope);
              return (
                <li key={r.repoScope}>
                  <button
                    type="button"
                    className="ad-policyview__scope"
                    data-testid={`policyview-scope-${r.repoScope}`}
                    data-active={selected === r.repoScope}
                    aria-pressed={selected === r.repoScope}
                    onClick={() => setSelected(r.repoScope)}
                  >
                    <span className="ad-policyview__scope-label">
                      {r.repoLabel ?? t("approvalPolicy.unknownRepo")}
                    </span>
                    {/* path は NO-RAW ゆえ basename(label) + scope 先頭で衝突回避表示。 */}
                    <span className="ad-policyview__scope-sub">
                      <code>{r.repoScope.slice(0, 8)}</code>
                    </span>
                    <Tag
                      tone={isOv ? "warn" : "muted"}
                      size="sm"
                      data-testid={`policyview-badge-${r.repoScope}`}
                    >
                      {isOv
                        ? t("approvalPolicy.badge.override")
                        : t("approvalPolicy.badge.default")}
                    </Tag>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* ADR 019f0eca §8: 観測済み作業ディレクトリのサジェスト。クリックで cwd→git root→scope を
              既存 resolve 経路で解決し candidate 化 (設定可能に)。NO-RAW: basename のみ表示・key は非可逆ハッシュ。 */}
          {observedItems.length > 0 ? (
            <div className="ad-policyview__observed" data-testid="policyview-observed">
              <p className="ad-policyview__observed-legend">
                {t("approvalPolicy.observed.legend")}
              </p>
              <ul className="ad-policyview__scopes" data-testid="policyview-observed-list">
                {observedItems.map((o) => (
                  <li key={o.key}>
                    <button
                      type="button"
                      className="ad-policyview__scope"
                      data-testid={`policyview-observed-${o.key}`}
                      onClick={() => void onPickObserved(o.cwd)}
                      disabled={resolving || offline}
                      title={t("approvalPolicy.observed.hint")}
                    >
                      <span className="ad-policyview__scope-label">{o.label}</span>
                      <Tag tone="muted" size="sm">
                        {t("approvalPolicy.badge.observed")}
                      </Tag>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="ad-policyview__observed-note">{t("approvalPolicy.observed.note")}</p>
            </div>
          ) : null}

          <div className="ad-policyview__add" data-testid="policyview-add">
            <label className="ad-policyview__add-label" htmlFor="policyview-add-path">
              {t("approvalPolicy.add.legend")}
            </label>
            {/* 方式B: 絶対パスをテキスト入力 (native folder picker は絶対パスを返さない仕様)。 */}
            <input
              id="policyview-add-path"
              type="text"
              className="ad-policyview__add-input"
              data-testid="policyview-add-path"
              placeholder={t("approvalPolicy.add.placeholder")}
              value={addPath}
              disabled={resolving || offline}
              onChange={(e) => setAddPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onAdd();
              }}
            />
            <Button
              kind="secondary"
              size="sm"
              data-testid="policyview-add-button"
              onClick={() => void onAdd()}
              disabled={resolving || offline || addPath.trim().length === 0}
            >
              {resolving ? t("approvalPolicy.add.resolving") : t("approvalPolicy.add.button")}
            </Button>
            <p className="ad-policyview__add-hint">{t("approvalPolicy.add.hint")}</p>
            {addError !== undefined ? (
              <p className="ad-body-error" data-testid="policyview-add-error">
                {t("approvalPolicy.add.error", { error: addError })}
              </p>
            ) : null}
          </div>
        </aside>

        {/* 右: 選択 scope の詳細。 */}
        <div className="ad-policyview__detail" data-testid="policyview-detail">
          {currentView === undefined ? (
            <p className="ad-policyview__empty">{t("approvalPolicy.loadHint")}</p>
          ) : (
            <>
              <h3 className="ad-pane-title" data-testid="policyview-detail-title">
                {selected === DEFAULT_KEY
                  ? t("approvalPolicy.detail.defaultTitle")
                  : t("approvalPolicy.detail.repoTitle", {
                      repo: currentView.repoLabel ?? t("approvalPolicy.unknownRepo"),
                    })}
              </h3>

              {looser ? (
                <InlineAlert
                  kind="warning"
                  data-testid="policyview-loosen"
                  title={t("approvalPolicy.loosenWarning")}
                />
              ) : null}

              <label className="ad-policy__enable" data-testid="policyview-enabled">
                <input
                  type="checkbox"
                  checked={draftEnabled}
                  disabled={saving || offline}
                  onChange={() => setDraftEnabled((v) => !v)}
                  data-testid="policyview-enabled-input"
                />
                <span>{t("approvalPolicy.enabledLabel")}</span>
              </label>
              <p className="ad-policy__hint">{t("approvalPolicy.enabledHint")}</p>

              <fieldset
                className="ad-policy__cats"
                data-testid="policyview-categories"
                disabled={saving || offline}
              >
                <legend className="ad-policy__legend">
                  {t("approvalPolicy.categoriesLegend")}
                </legend>
                {ALL_CATEGORIES.map((cat) => (
                  <label key={cat} className="ad-policy__cat" data-testid={`policyview-cat-${cat}`}>
                    <input
                      type="checkbox"
                      checked={draftCats.has(cat)}
                      onChange={() => toggleCat(cat)}
                      data-testid={`policyview-cat-input-${cat}`}
                    />
                    <span className="ad-policy__cat-label">{t(`policy.cat.${cat}`)}</span>
                    {DEFAULT_SET.has(cat) ? (
                      <Tag tone="info" size="sm">
                        {t("policy.defaultTag")}
                      </Tag>
                    ) : null}
                  </label>
                ))}
              </fieldset>

              <div className="ad-policyview__actions">
                <Button
                  kind="primary"
                  size="sm"
                  data-testid="policyview-save"
                  onClick={() => void onSave()}
                  disabled={saving || offline || !dirty}
                >
                  {saving ? t("approvalPolicy.saving") : t("approvalPolicy.save")}
                </Button>
                {isRepo && currentView.isOverride ? (
                  <Button
                    kind="ghost"
                    size="sm"
                    data-testid="policyview-reset"
                    title={t("approvalPolicy.resetHint")}
                    onClick={() => void onReset()}
                    disabled={saving || offline}
                  >
                    {t("approvalPolicy.resetToDefault")}
                  </Button>
                ) : null}
              </div>

              {/* この repo の永続承認 (allowlist) を同居 (両者 repo-scoped)。Default では端末全体を表示。
                  allowlist (list/revoke) は本 PR の daemon-addressed scope 外で **session-scoped 維持**ゆえ、
                  接続中エージェントセッションがあるとき (relayTarget.kind==="session") のみ表示する。daemon-only
                  モード (エージェント未稼働で daemon 直指定) では非表示 (daemon 宛 allowlist は follow-up)。 */}
              {allowlistSessionId !== null ? (
                <div className="ad-policyview__allowlist" data-testid="policyview-allowlist">
                  <PersistedApprovalsPanel
                    sessionId={allowlistSessionId}
                    nowMs={nowMs}
                    {...(isRepo ? { filterScope: selected } : {})}
                  />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
