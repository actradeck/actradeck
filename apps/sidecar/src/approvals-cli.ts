/**
 * approvals-cli — 永続承認 allowlist (ADR 019ee0c0) の閲覧/失効 CLI ロジック (v1 の「UI で失効」相当)。
 *
 *   agentmon approvals list                 永続承認を一覧 (署名・repo・risk・残り期限)。
 *   agentmon approvals revoke <sig|prefix>   署名 (完全一致 or 一意プレフィックス) を失効。
 *   agentmon approvals clear                 全永続承認を削除。
 *
 * I/O (store / now / 出力) を注入して純粋にテストする。署名は sha256 hex で **生コマンドを含まない**
 * ため一覧表示しても秘匿露出はない (repoLabel は basename のみ)。
 */
import type { ApprovalAllowlistStore } from "./approval-allowlist-store.js";

export interface ApprovalsCliIo {
  readonly store: ApprovalAllowlistStore;
  /** 現在時刻 (epoch ms)。残り期限表示・期限切れ除外に使う。 */
  readonly now: number;
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

/** 残り期限を人間可読に (分→時→日)。 */
function formatRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** approvals サブコマンドを実行し exit code を返す (0=成功 / 1=対象なし / 2=usage)。 */
export function runApprovalsCli(args: readonly string[], io: ApprovalsCliIo): number {
  const cmd = args[0];

  if (cmd === "list") {
    const entries = io.store.list(io.now);
    if (entries.length === 0) {
      io.out("永続承認はありません (0 件)。\n");
      return 0;
    }
    io.out(`永続承認 ${entries.length} 件 (${io.store.filePath}):\n`);
    for (const e of entries) {
      io.out(
        `  ${e.signature}  repo=${e.repoLabel ?? "?"}  risk=${e.risk}  ` +
          `expires_in=${formatRemaining(e.expiresAt, io.now)}\n`,
      );
    }
    return 0;
  }

  if (cmd === "revoke") {
    const target = args[1];
    if (target === undefined || target.length === 0) {
      io.err("usage: agentmon approvals revoke <signature|prefix>\n");
      return 2;
    }
    // 完全一致をまず試す (全 repoScope の同一署名を除去)。
    let removed = io.store.revoke(target);
    if (removed === 0) {
      // プレフィックス一致 (一意のときのみ失効・曖昧なら拒否=誤失効防止)。
      const distinct = [
        ...new Set(
          io.store
            .list(io.now)
            .filter((e) => e.signature.startsWith(target))
            .map((e) => e.signature),
        ),
      ];
      if (distinct.length === 0) {
        io.err(`一致する署名がありません: ${target}\n`);
        return 1;
      }
      if (distinct.length > 1) {
        io.err(
          `プレフィックスが曖昧です (${distinct.length} 件一致)。より長い署名を指定してください。\n`,
        );
        return 2;
      }
      removed = io.store.revoke(distinct[0]!);
    }
    io.out(`失効しました: ${removed} 件。\n`);
    return 0;
  }

  if (cmd === "clear") {
    io.store.clear();
    io.out("全永続承認を削除しました。\n");
    return 0;
  }

  io.err("usage: agentmon approvals <list | revoke <signature|prefix> | clear>\n");
  return 2;
}
