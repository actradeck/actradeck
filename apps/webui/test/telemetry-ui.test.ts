import { TELEMETRY_RETENTION_MONTHS } from "@actradeck/telemetry-contract";
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

  // 同意画面の「送るもの」は wire 契約の全 per-row field を名指しし、保持/削除の限界を開示する
  // (2026-08-26 disclosure drift: version/platform が UI から欠落・retention 未記載)。
  // 各 assert は当該語を消す変異で RED になる (フェンスは変異で実測済み)。
  it("consent copy names every per-row wire field and discloses retention limits", () => {
    const render = (locale: "ja" | "en") =>
      renderToStaticMarkup(
        createElement(FixedLocaleProvider, {
          locale,
          children: createElement(TelemetrySettings, { active: true }),
        }),
      );
    const ja = render("ja");
    const en = render("en");
    // app_version / platform — wire 契約 TelemetryDailyEvent の per-row field。
    expect(ja).toContain("バージョン（semver）");
    expect(ja).toContain("linux／darwin／win32／other");
    expect(en).toContain("version (semver)");
    expect(en).toContain("linux/darwin/win32/other");
    // cockpit_started は回数でなく 1 日 1 回上限の日次プレゼンス。
    expect(ja).toContain("1日1回");
    expect(en).toContain("at most once per day");
    // 保持と削除: 保持期間は契約の TELEMETRY_RETENTION_MONTHS と結合 (purge と開示の単一出所)・
    // disable はローカル ID のみ・削除依頼は ID 添付が前提 (ID 消失後は不可)。
    expect(TELEMETRY_RETENTION_MONTHS).toBe(24);
    expect(ja).toContain(`${TELEMETRY_RETENTION_MONTHS}か月保持し`);
    expect(ja).toContain("毎日自動削除します");
    expect(ja).toContain("送信済みの行は24か月の期限までサーバーに残ります");
    expect(ja).toContain("IDを削除する前に");
    expect(ja).toContain("IDを失うと行を特定できず削除できません");
    expect(en).toContain(`for ${TELEMETRY_RETENTION_MONTHS} months`);
    expect(en).toContain("automatically deletes older days every day");
    expect(en).toContain("rows already sent stay on the server until the 24-month limit");
    expect(en).toContain("before you delete it");
    expect(en).toContain("once the ID is gone, the rows can no longer be identified or deleted");
    // 目的: 集計での利用判断 + 開発優先順位のみ。課金/広告/特定/第三者提供に使わないことを明示。
    expect(ja).toContain("開発の優先順位を決めるためだけに使います");
    expect(ja).toContain("課金・広告・個人の特定・生データの第三者提供には使いません");
    expect(en).toContain("prioritise development");
    expect(en).toContain(
      "not used for billing, advertising, identifying anyone, or sharing raw rows with third parties",
    );
  });
});
