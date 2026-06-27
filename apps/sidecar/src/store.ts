/**
 * ローカル SQLite append-only event log (再送用)。
 *
 * 不変条件:
 * - append-only: UPDATE/DELETE を行わない (送信状態列のみ更新)。
 * - ここに渡る event は「redaction 済み」であることを呼び出し側 (sink) が保証する。
 *   store は redaction を行わない・知らない。raw を書く API を提供しない。
 * - ネット断時も保持し、WS 再接続後に未送信 (sent_at IS NULL) を順序どおり再送する。
 *
 * event_id (UUIDv7) を PRIMARY KEY とし、冪等な再投入を UNIQUE で吸収する。
 */
import Database from "better-sqlite3";

import type { NormalizedEvent } from "@actradeck/event-model";

export interface StoredRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly event_type: string;
  readonly seq: number;
  /** redaction 済み NormalizedEvent の JSON 文字列。 */
  readonly event_json: string;
  readonly created_at: string;
  readonly sent_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,
  session_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  event_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_log_unsent ON event_log (seq) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log (session_id, seq);
`;

export class EventStore {
  private readonly db: Database.Database;
  // shutdown-race backstop (class-wide・SEC/QA/TDA 合同所見)。better-sqlite3 は close 後の文実行で
  // 同期 throw する。emit/flush 経路は await 境界を跨いで store を触りうるため (process-monitor /
  // codex-rollout-tailer / git-watcher の各 in-flight emit、ws-client.flush の pendingUnsent/markSent)、
  // close 後の throw が fire-and-forget(void)を通って unhandledRejection 化し、handler 無し daemon
  // (cli.ts mainDaemon / mainCodexRolloutAttach) をクラッシュさせる。close 後は全 store 操作を
  // **no-op** (throw でなく) 化してクラッシュを構造的に断つ。throw は再び unhandledRejection へ戻り
  // 逆効果ゆえ採らない。append-only は維持 (書かない=不変条件違反なし)。個別 call-site の drain
  // (実イベントの取りこぼし防止) と二段構え: drain が data-loss を、この backstop が crash を防ぐ。
  private closed = false;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  /**
   * redaction 済み event を append する。冪等 (同一 event_id は無視)。
   * 戻り値は採番された seq、または既存行があれば既存 seq。
   */
  append(event: NormalizedEvent): number {
    if (this.closed) return -1; // close 後 no-op (既存の「未存在」sentinel と同値・append-only 維持)
    const json = JSON.stringify(event);
    const info = this.db
      .prepare(
        `INSERT INTO event_log (event_id, session_id, event_type, event_json, created_at)
         VALUES (@event_id, @session_id, @event_type, @event_json, @created_at)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run({
        event_id: event.event_id,
        session_id: event.session_id,
        event_type: event.event_type,
        event_json: json,
        created_at: new Date().toISOString(),
      });
    if (info.changes === 1) {
      return Number(info.lastInsertRowid);
    }
    const existing = this.db
      .prepare(`SELECT seq FROM event_log WHERE event_id = ?`)
      .get(event.event_id) as { seq: number } | undefined;
    return existing?.seq ?? -1;
  }

  /** 未送信イベントを seq 昇順 (= 発生順) で取得する。 */
  pendingUnsent(limit = 500): StoredRow[] {
    if (this.closed) return []; // close 後 no-op → flush は空バッチで即 break (emit-after-close 遮断)
    return this.db
      .prepare(`SELECT * FROM event_log WHERE sent_at IS NULL ORDER BY seq ASC LIMIT ?`)
      .all(limit) as StoredRow[];
  }

  /** 送信完了をマーク (append-only: 行は消さず sent_at のみ設定)。 */
  markSent(eventIds: readonly string[]): void {
    // close 後 no-op: 未マークの行は次回起動で pendingUnsent に再掲され再送される
    // (at-least-once・冪等 event_id で backend が dedup)。data-loss でなく重複送出のみ。
    if (this.closed || eventIds.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE event_log SET sent_at = ? WHERE event_id = ? AND sent_at IS NULL`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) stmt.run(now, id);
    });
    tx(eventIds);
  }

  unsentCount(): number {
    if (this.closed) return 0; // close 後 no-op
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM event_log WHERE sent_at IS NULL`)
      .get() as { c: number };
    return row.c;
  }

  totalCount(): number {
    if (this.closed) return 0; // close 後 no-op
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM event_log`).get() as { c: number };
    return row.c;
  }

  /** 全行を seq 順で返す (検証・テスト用)。 */
  allRows(): StoredRow[] {
    if (this.closed) return []; // close 後 no-op
    return this.db.prepare(`SELECT * FROM event_log ORDER BY seq ASC`).all() as StoredRow[];
  }

  close(): void {
    if (this.closed) return; // 冪等 (二重 close でも throw しない)
    this.closed = true;
    this.db.close();
  }
}
