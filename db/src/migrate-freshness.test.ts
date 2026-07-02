/**
 * INV-DB-MIGRATION-FRESH — assertMigrationsFresh の純関数 falsifiability (TDA-1 / decision 019f1b97)。
 *
 * 埋込 PGlite の runMigrations は dist/migrations/*.js を読むが、CLI は migrations/*.ts (db/migrations) を読む。
 * db を rebuild せず backend を起動すると stale dist で schema drift が silent に起きる。この鮮度
 * 検証が fail-loud に働くことを固定する (throw を消すと missing ケースが緑化して赤くなる)。
 */
import { describe, expect, it } from "vitest";

import { assertMigrationsFresh } from "./migrate.js";

describe("INV-DB-MIGRATION-FRESH: assertMigrationsFresh", () => {
  it("src == dist なら通る", () => {
    expect(() => assertMigrationsFresh(["a", "b"], ["a", "b"])).not.toThrow();
  });

  it("dist が src を包含 (superset・古い migration 残存) なら通る", () => {
    expect(() => assertMigrationsFresh(["a"], ["a", "b"])).not.toThrow();
  });

  it("src にあって dist に無い (未ビルド/stale) と fail-loud で throw し欠落名を含める", () => {
    expect(() => assertMigrationsFresh(["a", "b", "c"], ["a"])).toThrow(/not built or stale/);
    expect(() => assertMigrationsFresh(["a", "b", "c"], ["a"])).toThrow(/b, c/);
  });

  it("dist 空 (完全未ビルド) は build 案内付きで throw", () => {
    expect(() => assertMigrationsFresh(["a"], [])).toThrow(/pnpm --filter @actradeck\/db build/);
  });

  it("src 空 (dist-only 配布) は比較対象なしで通る", () => {
    expect(() => assertMigrationsFresh([], ["a", "b"])).not.toThrow();
  });
});
