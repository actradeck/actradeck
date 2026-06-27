import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { BACKEND_NAME, describeBackend, isDirectEntrypoint, maybeStartFromCli } from "./index.js";

describe("backend skeleton", () => {
  it("exposes its name", () => {
    expect(BACKEND_NAME).toBe("@actradeck/backend");
  });

  it("can reference the event-model package", () => {
    expect(describeBackend()).toContain("@actradeck/event-model");
  });
});

/**
 * main-guard 判定 (task 019e93e9): index.ts が **直接実行されたときだけ** server を起動し、
 * import されたときは副作用ゼロ (startFromEnv が import だけで listen しない) ことの契約。
 * 以前は startFromEnv を export するだけで誰も呼ばず dev/start が no-op だった defect の回帰固定。
 */
describe("isDirectEntrypoint (main-guard)", () => {
  const moduleUrl = "file:///repo/apps/backend/src/index.ts";

  it("fires when argv[1] resolves to the same module (direct run, e.g. node --import tsx src/index.ts)", () => {
    const argv1 = "/repo/apps/backend/src/index.ts";
    expect(isDirectEntrypoint(moduleUrl, argv1)).toBe(true);
  });

  it("does NOT fire when imported (argv[1] is a different file, e.g. vitest/test runner)", () => {
    const argv1 = "/repo/node_modules/.bin/vitest";
    expect(isDirectEntrypoint(moduleUrl, argv1)).toBe(false);
  });

  it("does NOT fire when argv[1] is undefined (no script path)", () => {
    expect(isDirectEntrypoint(moduleUrl, undefined)).toBe(false);
  });

  it("normalizes OS path argv[1] to a file URL before comparing (string compare alone would mismatch)", () => {
    // import.meta.url は file URL、argv[1] は OS パス。pathToFileURL で正規化して一致させる。
    const argv1 = "/repo/apps/backend/src/index.ts";
    expect(moduleUrl).toBe(pathToFileURL(argv1).href);
    expect(isDirectEntrypoint(moduleUrl, argv1)).toBe(true);
  });

  it("the guard expression is false under the REAL test runner (import.meta.url ≠ real argv[1])", () => {
    // index.ts のトップレベル guard は `isDirectEntrypoint(import.meta.url)`。
    // QA-1 (M): 手書き argv での評価は tautology (式が常に成立) だった。ここでは **実 process.argv[1]**
    // (vitest runner) と index の実モジュール URL で同じ式を再評価する。偽でなければ import 時に
    // startFromEnv が走ってしまう。第2引数を省略し実 argv に依存させるのが要点。
    const indexUrl = new URL("./index.ts", import.meta.url).href;
    expect(isDirectEntrypoint(indexUrl)).toBe(false);
  });

  it("maybeStartFromCli returns null WITHOUT starting a server when not the direct entrypoint (kills if(true) mutant)", async () => {
    // top-level の guard 付き副作用を named 関数の戻り値に落としたので、negative 分岐
    // (import = 非エントリポイント) が確実に「起動せず null」であることを **await して** 検証できる。
    // mutant が guard を if(true) に壊すと、この non-matching 引数でも startFromEnv が走り、
    // unit 環境では INGEST_TOKEN 不在で reject → この await が throw して fail (= mutant kill)。
    // INGEST_TOKEN が偶発的に存在する環境でも server (非 null) が返り toBeNull() で fail する。
    const started = await maybeStartFromCli(
      "file:///not/the/entrypoint.ts",
      "/repo/node_modules/.bin/vitest",
    );
    expect(started).toBeNull();
  });
});
