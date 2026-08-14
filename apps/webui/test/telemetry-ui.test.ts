import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { TelemetrySettings } from "../src/ui/TelemetrySettings.js";
import { parseTelemetryPreview, parseTelemetryStatus } from "../src/ui/use-telemetry.js";

describe("telemetry UI response projection", () => {
  it("projects a valid anonymous status and drops unknown fields", () => {
    expect(
      parseTelemetryStatus({
        schema_version: 1,
        mode: "anonymous",
        offered_endpoint: "https://official.example/v1/events",
        endpoint: "https://telemetry.example/v1/events",
        installation_id: "00000000-0000-4000-8000-000000000001",
        enabled_at: "2026-08-13T00:00:00.000Z",
        collects: ["daily counters"],
        raw_command: "must not survive projection",
      }),
    ).toEqual({
      schema_version: 1,
      mode: "anonymous",
      offered_endpoint: "https://official.example/v1/events",
      endpoint: "https://telemetry.example/v1/events",
      installation_id: "00000000-0000-4000-8000-000000000001",
      enabled_at: "2026-08-13T00:00:00.000Z",
    });
  });

  it("rejects malformed anonymous status", () => {
    expect(parseTelemetryStatus({ schema_version: 1, mode: "anonymous" })).toBeNull();
    expect(parseTelemetryStatus({ schema_version: 2, mode: "off" })).toBeNull();
  });

  it("accepts the disabled preview shape", () => {
    expect(
      parseTelemetryPreview({
        status: { schema_version: 1, mode: "off" },
        batch: null,
        source_range: null,
      }),
    ).toEqual({
      status: { schema_version: 1, mode: "off" },
      batch: null,
      source_range: null,
    });
  });

  it("re-projects the preview batch through the closed wire contract (QA-8)", () => {
    const status = {
      schema_version: 1,
      mode: "anonymous",
      endpoint: "https://telemetry.example/v1/events",
      installation_id: "00000000-0000-4000-8000-000000000001",
      enabled_at: "2026-08-13T00:00:00.000Z",
    };
    const batch = {
      schema_version: 1,
      installation_id: "00000000-0000-4000-8000-000000000001",
      events: [
        {
          event_name: "active_day",
          occurred_on: "2026-08-13",
          app_version: "0.7.0",
          platform: "linux",
          count: 1,
        },
      ],
    };
    const range = { from: "2026-08-13", to: "2026-08-13" };
    // 正当な batch は通る。
    expect(
      parseTelemetryPreview({ status, batch, source_range: range })?.batch?.events,
    ).toHaveLength(1);
    // 将来 wire に sensitive field が混ざっても、read 境界の closed contract 再射影が preview ごと
    // 拒否する (verbatim で DOM に着地しない — SEC-DOC-1 同型 latent の閉塞)。
    expect(
      parseTelemetryPreview({
        status,
        batch: { ...batch, cwd: "/home/operator/secret-project" },
        source_range: range,
      }),
    ).toBeNull();
    expect(
      parseTelemetryPreview({
        status,
        batch: {
          ...batch,
          events: [{ ...batch.events[0], command: "rm -rf /" }],
        },
        source_range: range,
      }),
    ).toBeNull();
    // source_range も {from,to} のみへ射影する (不正形は preview ごと拒否)。
    expect(
      parseTelemetryPreview({ status, batch, source_range: { from: "2026-08-13" } }),
    ).toBeNull();
  });

  it("renders the default-off consent surface in both shipped locales", () => {
    const render = (locale: "ja" | "en") =>
      renderToStaticMarkup(
        createElement(FixedLocaleProvider, {
          locale,
          children: createElement(TelemetrySettings, { active: true }),
        }),
      );
    const ja = render("ja");
    const en = render("en");
    expect(ja).toContain('data-testid="telemetry-settings"');
    expect(ja).toContain("初期設定はOFFです");
    expect(ja).toContain("プロンプト、コマンド、パス");
    expect(en).toContain("Off by default");
    expect(en).toContain("Prompts, commands, paths");
  });
});
