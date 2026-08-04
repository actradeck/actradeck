/**
 * INV-TEST-DB-GUARD-WIRING (QA-1 + SEC-1 + TDA-3・裁定 019fcd5f): guard の「配線」を構造 pin する。
 *
 * INV-TEST-DB-GUARD は純ライブラリの挙動を固定するが、SEC-2 の実効防御は
 * 「guard が全 harness に配線されていること」に宿る。本メタテストは次の退行をすべて赤化する:
 * - いずれかの setup-env が applyTestDatabaseGuard を呼ばなくなる (呼び忘れ / 削除)。
 * - backend/webui/db の setup-env が applyDotenvForTests を使わず旧 inline ループ
 *   (process.env[key] 直接代入 = .env から DATABASE_URL を採用しうる形) へ戻る。
 * - いずれかの vitest.config から setupFiles 配線が落ちる。
 * - boot-smoke (vitest 非経由の直接 node harness・SEC-1) が spawn 前の guard 呼び出しを失う。
 * - docker-compose の production port fallback と DEFAULT_PROD_PG_PORT が乖離する (TDA-3 —
 *   compose 側だけ変えると guard の既定被覆が silent に無効化するため parity で束縛)。
 *
 * 文字列レベルの静的 assert である理由: app 側 vitest.config を import すると各 app の alias /
 * plugin 依存を event-model のテスト文脈へ持ち込む。配線の存在 pin には source 文字列で十分で、
 * 落とし方はいずれも該当行の削除 = 即 RED (falsifiable)。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_PROD_PG_PORT } from "../src/test-db-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
// packages/event-model/test -> repo root
const repoRoot = resolve(here, "../../..");
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8");

/** dotenv も読む 3 harness (旧 inline ループの単一出所化元)。 */
const DOTENV_SETUP_FILES = [
  "apps/backend/test/setup-env.ts",
  "apps/webui/test/setup-env.ts",
  "db/test/setup-env.ts",
] as const;

/** guard のみの harness (sidecar は .env 非ロード設計)。 */
const GUARD_ONLY_SETUP_FILES = ["apps/sidecar/test/setup-env.ts"] as const;

const ALL_SETUP_FILES = [...DOTENV_SETUP_FILES, ...GUARD_ONLY_SETUP_FILES];

const VITEST_CONFIGS = [
  "apps/backend/vitest.config.ts",
  "apps/webui/vitest.config.ts",
  "apps/sidecar/vitest.config.ts",
  "db/vitest.config.ts",
] as const;

describe("INV-TEST-DB-GUARD-WIRING: every harness wires the canonical guard", () => {
  it.each(ALL_SETUP_FILES)("%s imports the guard and applies it to process.env", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/from "@actradeck\/event-model"/);
    expect(src).toMatch(/applyTestDatabaseGuard\(process\.env\)/);
  });

  it.each(DOTENV_SETUP_FILES)(
    "%s parses .env only through applyDotenvForTests (no raw adoption loop)",
    (rel) => {
      const src = read(rel);
      expect(src).toMatch(/applyDotenvForTests\(/);
      // 旧 inline ループの指紋: process.env への key 添字代入。復活 = .env の DATABASE_URL を
      //   再び採用しうる形なので存在自体を禁止する。
      expect(src).not.toMatch(/process\.env\[/);
    },
  );

  it.each(VITEST_CONFIGS)("%s keeps the setupFiles wiring", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/setupFiles:\s*\[\s*"\.\/test\/setup-env\.ts"\s*\]/);
  });

  it("boot-smoke (direct-node harness, SEC-1) applies the guard before spawning anything", () => {
    const src = read("apps/webui/smoke/boot-smoke.ts");
    const guardAt = src.indexOf("applyTestDatabaseGuard(process.env)");
    expect(guardAt).toBeGreaterThan(-1);
    // 子プロセス起動より前に guard が走ること (起動 backend が startup reap = DELETE を行うため)。
    const spawnAt = src.indexOf("spawn(");
    expect(spawnAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(spawnAt);
  });

  it("DEFAULT_PROD_PG_PORT matches every docker-compose ACTRADECK_PG_PORT fallback (TDA-3)", () => {
    const compose = read("docker-compose.yml");
    const fallbacks = [...compose.matchAll(/\$\{ACTRADECK_PG_PORT:-([0-9]+)\}/g)].map((m) => m[1]);
    // compose に fallback が存在しなくなったらこの pin 自体を見直す (silent pass にしない)。
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const port of fallbacks) {
      expect(port).toBe(DEFAULT_PROD_PG_PORT);
    }
  });
});
