/**
 * vitest setup: production-DB ガードのみ (SEC-2・裁定 019fc4c6)。
 *
 * sidecar は従来どおり root .env を自動ロードしない (real-PG e2e へ DB を渡すのは CI の
 * env 注入)。このガードは、shell に export された production DATABASE_URL (:55432) を
 * テストが拾って接続する事故クラスを backend/webui/db と一様に fail-loud で遮断する。
 * ACTRADECK_TEST_DATABASE_URL (明示 opt-in) は DATABASE_URL より優先して採用される。
 * ロジックの単一出所は @actradeck/event-model の test-db-guard.ts。
 */
import { applyTestDatabaseGuard } from "@actradeck/event-model";

applyTestDatabaseGuard(process.env);
