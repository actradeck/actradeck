/**
 * vitest setup: root .env のテスト用適用 + production-DB ガード (SEC-2・裁定 019fc4c6)。
 *
 * webui の結合テスト (integration-realtime) は実 backend + 実 PG に接続するが、DATABASE_URL は
 * .env から採用しない (production :55432 をローカル vitest が黙って拾う事故の再発防止)。DB を
 * 渡すのは CI の env 注入か ACTRADECK_TEST_DATABASE_URL (明示 opt-in)。production port を指す
 * 接続文字列は fail-loud で拒否する。ロジックの単一出所は @actradeck/event-model の
 * test-db-guard.ts (backend/db/sidecar と共有・旧 3 コピーの重複を解消)。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyDotenvForTests, applyTestDatabaseGuard } from "@actradeck/event-model";

const here = dirname(fileURLToPath(import.meta.url));
// apps/webui/test/ -> repo root
const envPath = resolve(here, "../../../.env");

try {
  applyDotenvForTests(readFileSync(envPath, "utf8"), process.env);
} catch {
  // .env が無い環境 (CI 等) は env 注入経路に委ねる。実 PG テストは未到達なら skip。
}
applyTestDatabaseGuard(process.env);
