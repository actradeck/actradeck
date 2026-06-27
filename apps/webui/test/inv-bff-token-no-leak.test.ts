/**
 * INV-TOKEN-ISOLATION (BFF server スライス, ADR 019e92b7):
 * custom server (server.ts) は REALTIME_TOKEN を保持・Bearer 中継するが、その token が
 * **ブラウザ向け経路に出ない** ことを静的・動的に固定する。
 *
 *  1. server.ts は browser graph (ui/ realtime/ app) の **外** に置く (ここに置けるから bff を
 *     value-import してよい)。逆に browser graph が server.ts を value-import していないこと。
 *  2. ブラウザ向けに渡る token 標識 (REALTIME_TOKEN / Authorization / Bearer) が
 *     browser graph のソースに **現れない** (定数名すら埋め込まない)。
 *  3. ログ用 redaction は Bearer 実値を絶対に出さない (redactUpstreamForLog は authorization を
 *     URL に載せない契約なので、出力に "Bearer" が出ない)。
 *
 * 既存 inv-token-isolation.test.ts (bff/backend の value-import 禁止) と二重ゲート。
 *
 * TDA-1 (audit ad14a947): browser graph の収集・読み取りは共有 snapshot (BROWSER_SOURCES) を使う。
 * runtime の再 readFileSync を無くし並行 next build との flaky を解消。TDA-5: walk/path import を dedup。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BROWSER_SOURCES, WEBUI_ROOT } from "./_support/browser-graph.js";
import { redactUpstreamForLog } from "../src/server/upgrade-routing.js";

describe("INV-BFF: custom server placement & token non-leak", () => {
  it("server.ts exists at apps/webui/ root (outside browser graph)", () => {
    expect(existsSync(join(WEBUI_ROOT, "server.ts"))).toBe(true);
  });

  it("no browser-graph file value-imports server.ts", () => {
    const offenders = BROWSER_SOURCES.filter(({ source }) =>
      // value import of ../server / ./server (型 import は contract のみで server を参照しない)。
      /(^|\n)\s*import\s+(?!type\s)[^;]*?from\s*["'][^"']*\/server(\.js)?["']/.test(source),
    ).map(({ path }) => path);
    expect(offenders, `browser graph must not import server.ts: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("no browser-graph file reads the token from env or builds an Authorization header", () => {
    // prose/コメントでの言及 (「token は渡らない」等の説明) は許可。実際の **コード経路** だけを
    // 検出する: env からの token 読み取り / Bearer 文字列の組み立て / authorization ヘッダ代入。
    const codeLeakPatterns: RegExp[] = [
      /\bprocess\.env\b[^.\n]*REALTIME_TOKEN/, // process.env.REALTIME_TOKEN / process.env["REALTIME_TOKEN"]
      /REALTIME_TOKEN\s*[\])]/, // env["REALTIME_TOKEN"] アクセス
      /["'`]\s*Bearer\s*[$\\{]/, // `Bearer ${...}` の組み立て
      /\bauthorization\b\s*:/i, // authorization: ... ヘッダ代入
    ];
    const offenders: string[] = [];
    for (const { path, source } of BROWSER_SOURCES) {
      if (codeLeakPatterns.some((re) => re.test(source))) offenders.push(path);
    }
    expect(
      offenders,
      `browser graph must not read token / build Bearer header: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("redactUpstreamForLog output never contains a Bearer credential", () => {
    // token を query/userinfo に押し込んだ最悪ケースでも Bearer / 値が出ないこと。
    const samples = [
      "ws://127.0.0.1:8787/realtime/ws",
      "ws://h:1/realtime/ws?token=topsecret&authorization=Bearer%20leaked",
      "wss://user:topsecret@h:1/realtime/ws",
    ];
    for (const s of samples) {
      const out = redactUpstreamForLog(s);
      expect(out).not.toContain("topsecret");
      expect(out).not.toContain("leaked");
      expect(out.toLowerCase()).not.toContain("bearer");
    }
  });
});
