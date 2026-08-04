/**
 * vitest setup: root .env のテスト用適用 + production-DB ガード (SEC-2・裁定 019fc4c6)。
 *
 * DATABASE_URL は .env から採用しない (production :55432 をローカル vitest が黙って拾い
 * INSERT/DELETE した事故の再発防止)。real-PG テストへ DB を渡すのは CI の env 注入か
 * ACTRADECK_TEST_DATABASE_URL (明示 opt-in)。production port を指す接続文字列は fail-loud で
 * 拒否する。ロジックの単一出所は @actradeck/event-model の test-db-guard.ts (webui/db/sidecar と共有)。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyDotenvForTests, applyTestDatabaseGuard } from "@actradeck/event-model";

const here = dirname(fileURLToPath(import.meta.url));
// apps/backend/test/ -> repo root
const envPath = resolve(here, "../../../.env");

try {
  applyDotenvForTests(readFileSync(envPath, "utf8"), process.env);
} catch {
  // .env が無い環境 (CI 等) は env 注入経路に委ねる。実 PG テストは未到達なら skip。
}
applyTestDatabaseGuard(process.env);
