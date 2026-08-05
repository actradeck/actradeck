/**
 * TDA-B3-4 (B3 sweep): work-items locale map の enum-exhaustiveness metatest。
 *
 * work-items-fold.ts の locale map は Record<Enum, MessageKey> で compile-time exhaustive だが、
 * runtime でも zod enum の**全 option** が両 locale catalog に実在するキーへ写ることを固定する
 * (catalog 側のキー欠落・lookup 関数の string 経路での退行を捕捉)。enum 外文字列の fallback
 * (status は unknown キー / それ以外は undefined = 注記非表示) も従来挙動として pin する。
 */
import {
  CheckKind,
  CheckMatch,
  ObservationFidelity,
  ObservationMethod,
  WorkItemStatus,
} from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { CATALOGS_FOR_TEST, LOCALES } from "../src/ui/i18n/messages.js";
import {
  checkKindLabelKey,
  checkMatchLabelKey,
  fidelityLabelKey,
  methodLabelKey,
  statusLabelKey,
} from "../src/ui/work-items-fold.js";

function assertKeyInCatalogs(key: string | undefined, ctx: string): void {
  expect(key, ctx).toBeDefined();
  for (const locale of LOCALES) {
    expect(CATALOGS_FOR_TEST[locale][key!], `${ctx} -> ${key} (${locale})`).toBeDefined();
  }
}

describe("TDA-B3-4: work-items locale maps are enum-exhaustive (runtime)", () => {
  it("WorkItemStatus 全 option が両 locale の catalog キーへ写る", () => {
    for (const s of WorkItemStatus.options) assertKeyInCatalogs(statusLabelKey(s), `status:${s}`);
  });

  it("ObservationMethod 全 option が両 locale の catalog キーへ写る", () => {
    for (const m of ObservationMethod.options)
      assertKeyInCatalogs(methodLabelKey(m), `method:${m}`);
  });

  it("ObservationFidelity 全 option が両 locale の catalog キーへ写る", () => {
    for (const f of ObservationFidelity.options) {
      assertKeyInCatalogs(fidelityLabelKey(f), `fidelity:${f}`);
    }
  });

  it("CheckKind / CheckMatch 全 option が両 locale の catalog キーへ写る", () => {
    for (const k of CheckKind.options) assertKeyInCatalogs(checkKindLabelKey(k), `check_kind:${k}`);
    for (const m of CheckMatch.options) {
      assertKeyInCatalogs(checkMatchLabelKey(m), `check_match:${m}`);
    }
  });

  it("enum 外文字列は fallback (status=unknown キー / それ以外 undefined) — 従来挙動の pin", () => {
    expect(statusLabelKey("no-such-status")).toBe("workitem.status.unknown");
    expect(methodLabelKey("no-such-method")).toBeUndefined();
    expect(fidelityLabelKey("no-such-fidelity")).toBeUndefined();
    expect(checkKindLabelKey("no-such-kind")).toBeUndefined();
    expect(checkMatchLabelKey("no-such-match")).toBeUndefined();
  });
});
