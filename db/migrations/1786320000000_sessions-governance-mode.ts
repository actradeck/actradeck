/**
 * sessions にガバナンス保証水準を追加する。
 *
 * event-model の GovernanceMode が closed enum の正典。DB は既存方針どおり TEXT + NULL で
 * 前方互換を保ち、read/集計時に `enforcement` の明示値だけを Protected として扱う。
 * NULL は「旧イベントまたは保証不明」であり、managed 等から推測して埋めない。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("sessions", {
    governance_mode: {
      type: "text",
      notNull: false,
    },
  });
  pgm.createIndex("sessions", "governance_mode");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("sessions", "governance_mode");
  pgm.dropColumn("sessions", "governance_mode");
}
