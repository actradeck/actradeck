"use client";

import { useState } from "react";

import { Button, InlineAlert, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { useTelemetry } from "./use-telemetry";

export interface TelemetrySettingsProps {
  readonly active: boolean;
}

function localTime(iso: string | undefined, locale: "ja" | "en"): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(locale === "ja" ? "ja-JP" : "en-US");
}

export function TelemetrySettings({ active }: TelemetrySettingsProps): React.JSX.Element {
  const { locale, t } = useLocale();
  const telemetry = useTelemetry(active);
  const [endpoint, setEndpoint] = useState("");
  const enabled = telemetry.status?.mode === "anonymous";

  return (
    <section className="ad-telemetry" data-testid="telemetry-settings">
      <div className="ad-telemetry__head">
        <h2>{t("telemetry.title")}</h2>
        <Tag tone={enabled ? "success" : "muted"} size="md">
          {enabled ? t("telemetry.on") : t("telemetry.off")}
        </Tag>
      </div>

      <InlineAlert kind="info" title={t("telemetry.defaultOff")} subtitle={t("telemetry.lead")} />

      <div className="ad-telemetry__privacy">
        <div>
          <h3>{t("telemetry.collects.title")}</h3>
          <p>{t("telemetry.collects.body")}</p>
        </div>
        <div>
          <h3>{t("telemetry.excludes.title")}</h3>
          <p>{t("telemetry.excludes.body")}</p>
        </div>
      </div>

      {telemetry.error ? <InlineAlert kind="error" title={t("telemetry.error")} /> : null}

      {enabled ? (
        <div className="ad-telemetry__status">
          <dl>
            <div>
              <dt>{t("telemetry.endpoint")}</dt>
              <dd>{telemetry.status?.endpoint ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("telemetry.id")}</dt>
              <dd>{telemetry.status?.installation_id ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("telemetry.enabledAt")}</dt>
              <dd>{localTime(telemetry.status?.enabled_at, locale)}</dd>
            </div>
            <div>
              <dt>{t("telemetry.lastSent")}</dt>
              <dd>{localTime(telemetry.status?.last_success_at, locale)}</dd>
            </div>
          </dl>
          <div className="ad-telemetry__actions">
            <Button
              kind="secondary"
              size="sm"
              disabled={telemetry.loading}
              onClick={() => void telemetry.flush()}
            >
              {t("telemetry.sendNow")}
            </Button>
            <Button
              kind="secondary"
              size="sm"
              disabled={telemetry.loading}
              onClick={() => void telemetry.resetId()}
            >
              {t("telemetry.resetId")}
            </Button>
            <Button
              kind="danger"
              size="sm"
              disabled={telemetry.loading}
              onClick={() => void telemetry.disable()}
            >
              {t("telemetry.disable")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="ad-telemetry__enable">
          <label htmlFor="telemetry-endpoint">{t("telemetry.endpoint")}</label>
          <input
            id="telemetry-endpoint"
            type="url"
            value={endpoint}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
            placeholder={
              telemetry.status?.offered_endpoint ??
              "https://actradeck-telemetry.actradeck-telemetry-collector.workers.dev/v1/events"
            }
            autoComplete="off"
            spellCheck={false}
          />
          <p>{t("telemetry.endpointHint")}</p>
          <Button
            kind="primary"
            disabled={telemetry.loading}
            onClick={() => void telemetry.enable(endpoint.trim() || undefined)}
          >
            {t("telemetry.enable")}
          </Button>
        </div>
      )}

      <div className="ad-telemetry__preview-actions">
        <Button
          kind="ghost"
          size="sm"
          disabled={telemetry.loading}
          onClick={() =>
            telemetry.preview ? telemetry.clearPreview() : void telemetry.loadPreview()
          }
        >
          {telemetry.preview ? t("telemetry.previewHide") : t("telemetry.preview")}
        </Button>
      </div>
      {telemetry.preview ? (
        <div className="ad-telemetry__preview">
          <p>{t("telemetry.previewLead")}</p>
          <pre>{JSON.stringify(telemetry.preview.batch, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}
