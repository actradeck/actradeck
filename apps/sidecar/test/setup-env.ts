/**
 * vitest setup: production-DB ガードのみ (SEC-2・裁定 019fc4c6)。
 *
 * sidecar は従来どおり root .env を自動ロードしない (real-PG e2e へ DB を渡すのは CI の
 * env 注入)。このガードは、shell に export された production DATABASE_URL (:55432) を
 * テストが拾って接続する事故クラスを backend/webui/db と同様に fail-loud で遮断する。
 * ACTRADECK_TEST_DATABASE_URL (明示 opt-in) は DATABASE_URL より優先して採用される。
 * ロジックの単一出所は @actradeck/event-model の test-db-guard.ts。
 *
 * 非対称の明示 (TDA-2・裁定 019fcd5f): .env を読まないため、.env にのみ書かれた custom
 * ACTRADECK_PG_PORT は sidecar 側 forbidden 集合へ反映されない (既定 55432 + shell env の
 * ACTRADECK_PG_PORT のみ)。既定 port 運用 (quickstart 標準) では全 harness 一様。
 */
import { applyTestDatabaseGuard } from "@actradeck/event-model";

applyTestDatabaseGuard(process.env);
