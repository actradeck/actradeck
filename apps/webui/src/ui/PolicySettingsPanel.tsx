"use client";

/**
 * PolicySettingsPanel — bypass/YOLO 承認ポリシーの in-UI 設定 (ADR 019f0c3e Phase 2)。
 *
 * - policy は **machine-global** (この端末の全 daemon が ~/.actradeck/approvals/policy.json を共有)。
 *   session 詳細内に置くが、対象は端末全体である旨を文言で明示する (PersistedApprovalsPanel と対称)。
 * - データは usePolicy が同一 origin の BFF proxy 経由で get/set する。categories は **closed enum**
 *   (PolicyCategory) のみで、生コマンドは構造的に描画しない (security.md / NO-RAW)。
 * - lazy: 既定では出さず、明示操作 (load) で取得する (allowlist と同じ pull-on-demand)。
 * - enabled は **file-level** master トグル。env kill-switch (envGateEnabled=false) のときは file-level
 *   設定に関わらず全体パススルーになるため、その旨を **正直に警告**する (看板=実挙動一致)。
 * - 編集はドラフト状態で行い、保存 (Save) するまで適用しない (set は明示操作のみ)。
 */
import { useEffect, useState } from "react";

import { DEFAULT_GATED_CATEGORIES, type PolicyCategory } from "@actradeck/event-model";

import { Button, InlineAlert, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { ALL_POLICY_CATEGORIES, usePolicy } from "./use-policy";

export interface PolicySettingsPanelProps {
  readonly sessionId: string;
}

const DEFAULT_SET: ReadonlySet<PolicyCategory> = new Set(DEFAULT_GATED_CATEGORIES);

function setEquals(a: ReadonlySet<PolicyCategory>, b: ReadonlySet<PolicyCategory>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function PolicySettingsPanel({ sessionId }: PolicySettingsPanelProps) {
  const { t } = useLocale();
  const { view, loading, error, load, save, saving } = usePolicy(sessionId);

  // 編集中のドラフト状態 (保存するまで適用しない)。view を取得/再取得したら同期する。
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftCats, setDraftCats] = useState<ReadonlySet<PolicyCategory>>(new Set());

  useEffect(() => {
    if (view === undefined) return;
    setDraftEnabled(view.enabled);
    setDraftCats(new Set(view.categories));
  }, [view]);

  function toggleCat(cat: PolicyCategory): void {
    setDraftCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  const dirty =
    view !== undefined &&
    (draftEnabled !== view.enabled || !setEquals(draftCats, new Set(view.categories)));

  return (
    <section className="ad-policy" data-testid="policy-panel" aria-label={t("policy.aria")}>
      <h3 className="ad-pane-title">{t("policy.title")}</h3>
      <p className="ad-policy__desc">{t("policy.desc")}</p>

      {view === undefined ? (
        <Button
          kind="ghost"
          size="sm"
          data-testid="policy-load"
          onClick={() => load()}
          disabled={loading}
        >
          {loading ? t("policy.loading") : t("policy.load")}
        </Button>
      ) : (
        <>
          <div className="ad-policy__head">
            <Button
              kind="ghost"
              size="sm"
              data-testid="policy-reload"
              onClick={() => load()}
              disabled={loading || saving}
            >
              {loading ? t("policy.loading") : t("policy.reload")}
            </Button>
          </div>

          {!view.envGateEnabled ? (
            <InlineAlert
              kind="warning"
              data-testid="policy-env-disabled"
              title={t("policy.envDisabled")}
            />
          ) : null}

          <label className="ad-policy__enable" data-testid="policy-enabled">
            <input
              type="checkbox"
              checked={draftEnabled}
              disabled={saving}
              onChange={() => setDraftEnabled((v) => !v)}
              data-testid="policy-enabled-input"
            />
            <span>{t("policy.enabledLabel")}</span>
          </label>
          <p className="ad-policy__hint">{t("policy.enabledHint")}</p>

          <fieldset className="ad-policy__cats" data-testid="policy-categories" disabled={saving}>
            <legend className="ad-policy__legend">{t("policy.categoriesLegend")}</legend>
            {ALL_POLICY_CATEGORIES.map((cat) => (
              <label key={cat} className="ad-policy__cat" data-testid={`policy-cat-${cat}`}>
                <input
                  type="checkbox"
                  checked={draftCats.has(cat)}
                  onChange={() => toggleCat(cat)}
                  data-testid={`policy-cat-input-${cat}`}
                />
                <span className="ad-policy__cat-label">{t(`policy.cat.${cat}`)}</span>
                {DEFAULT_SET.has(cat) ? (
                  <Tag tone="info" size="sm" data-testid={`policy-cat-default-${cat}`}>
                    {t("policy.defaultTag")}
                  </Tag>
                ) : null}
              </label>
            ))}
          </fieldset>

          <Button
            kind="primary"
            size="sm"
            data-testid="policy-save"
            onClick={() => save({ enabled: draftEnabled, categories: [...draftCats] })}
            disabled={saving || !dirty}
          >
            {saving ? t("policy.saving") : t("policy.save")}
          </Button>
        </>
      )}

      {error !== undefined ? (
        <p className="ad-body-error" data-testid="policy-error">
          {t("policy.error", { error })}
        </p>
      ) : null}
    </section>
  );
}
