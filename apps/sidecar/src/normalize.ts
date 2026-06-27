/**
 * Claude Code hooks → NormalizedEvent 正規化 (provider=claude_code, source=hooks)。
 *
 * 仕様出所: code.claude.com/docs/en/hooks (WebSearch 2026-06)。
 * HTTP hook の POST body は command-hook stdin と同形:
 *   { session_id, transcript_path, cwd, permission_mode, hook_event_name, ...event固有 }
 *
 * マッピング表は decision 019e8e49-725d を参照。生 hook 形状は UI へ素通ししない
 * (plan.md §14): 必要な構造化フィールドのみ payload に正規化する。
 *
 * ⚠️ ここで作る候補は EventSink.emit() に渡され、その中で redaction されてから
 *    parse/persist/send される。normalize 自体は redaction しない (choke point は一箇所)。
 */
import type { EventType, RiskLevel, State } from "@actradeck/event-model";

import { type BuildEventInput, buildEvent } from "./event-factory.js";
import { redactString } from "./redactor.js";

/** Claude Code hook の共通入力 (HTTP body = command stdin と同形)。 */
export interface HookCommonInput {
  readonly session_id: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly permission_mode?: string;
  readonly hook_event_name: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  /**
   * ツール呼び出しの一意 ID (実観測 `toolu_<id>`、PreToolUse/PostToolUse 共通)。
   * command.started↔completed を結ぶ相関キーの出所 (toolUseCorrelationId)。
   */
  readonly tool_use_id?: string;
  // event 固有フィールド (loose)。
  readonly [k: string]: unknown;
}

/** PreToolUse の tool_input でよく使うフィールド。 */
interface ToolInput {
  readonly command?: string;
  readonly file_path?: string;
  readonly query?: string;
  readonly [k: string]: unknown;
}

/**
 * 高リスクコマンド判定 (plan.md §18 Risk Lens / QA-2 監査所見)。
 *
 * 字面マッチではなくトークン正規化ベースで判定する。承認バイパスを許さないため
 * **判定不能・曖昧は high に倒す (fail-safe)**。検出対象:
 *   - rm の再帰+強制 (-r/-R/-f/--recursive/--force、順不同・融合 -fr/-rf・分割)
 *   - git push の強制 (-f/--force/--force-with-lease)
 *   - chmod の world-writable (数値 xx7 / a+w / o+w) と -R
 *   - mkfs / dd of= / fork bomb / DROP|TRUNCATE TABLE / migrate / production
 *   - ブロックデバイスへの書込/リダイレクト (> /dev/sd* /dev/nvme* /dev/disk* と dd of=)
 *   - SEC-1: シェル/インタプリタのインラインコード (`sh -c "..."` / `python -c "..."` /
 *     `node -e "..."` 等) と eval / コマンド置換 `$(...)`・backtick。内側コードを再分類できれば
 *     その risk、再パース不能なら fail-safe で medium に床上げ (over-gate 許容)。
 *
 * ⚠️ この判定は承認ゲート (approval-bridge.requiresHumanApproval) の唯一の根拠。
 *    false-negative = 無承認で破壊的操作が走る = INV-APPROVAL 違反。
 */

/**
 * payload に格納する command 文字列の最大長 (再#SEC-1)。
 * 巨大コマンドを無切り詰めで保持・redaction すると負荷源になるため上限を設ける。
 */
export const MAX_COMMAND_LEN = 4096;

/** コマンドを ; | && || で区切った各セグメントへ分解 (パイプ/連結内の個別 cmd を見る)。 */
function splitSegments(command: string): string[] {
  return command
    .split(/[;\n]|\|\||&&|\||(?<!\d)>{1,2}|<{1,2}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * セグメントを空白でトークン化する。
 *
 * 再監査#4 round2 (G): 旧実装 `.replace(/["'`]/g, " ")` は全クォートを**空白置換**するため、
 * 実シェルでは連結される単語内クォート (`r""m` / `'r'm` → `rm`) を `r m` に誤分割し、
 * commandName が "r" になって rm 検出を取りこぼしていた (承認ゲート素通り)。
 *
 * 修正: クォート (`"` `'` backtick) を **単語境界か単語内か**で振り分ける:
 *  - 単語境界 (前後いずれかが空白 or 文字列端) → 空白化 (従来通りトークン区切り)。
 *    例 `sh -c "rm -rf /"` の ` "` は前が空白 → 空白化し `-c` 検出と内側分解を維持。
 *  - 単語内 (前後とも非空白) → 空文字化 (連結を正しく再現)。
 *    例 `r""m` → `rm` / `echo "a"b"c"` → `echo abc`。
 *
 * 純粋な文字走査 (正規表現の置換ループ無し・O(n) 線形) で実装し ReDoS 経路を増やさない。
 */
const QUOTE_CHARS = new Set(['"', "'", "`"]);
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && !/\s/.test(ch);
}
function tokenize(segment: string): string[] {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch !== undefined && QUOTE_CHARS.has(ch)) {
      // 前後とも非空白 (単語内) なら連結のため空文字化、さもなくば区切りとして空白化。
      out += isWordChar(segment[i - 1]) && isWordChar(segment[i + 1]) ? "" : " ";
      continue;
    }
    out += ch;
  }
  return out.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * トークン先頭をコマンド名 (basename, 小文字化) に正規化する。
 *
 * QA-3: `tokens[0] !== "rm"` のような **大小文字を区別する素の比較**は uppercase 変種
 * (`RM -RF /tmp`) を取りこぼし、承認ゲートを素通りさせていた。コマンド名比較は常に本関数で
 * 小文字化した basename に対して行う (`/usr/bin/RM` → `rm`)。引数・パスは大小文字を保つため
 * ここでは tokens[0] のみを対象にする。
 */
function commandName(tokens: string[]): string {
  const first = tokens[0];
  if (typeof first !== "string" || first.length === 0) return "";
  const base = first.includes("/") ? (first.split("/").pop() ?? first) : first;
  return base.toLowerCase();
}

/**
 * 既知の command-runner ラッパ (再#3 QA-1 / QA-3)。
 *
 * これらは「後続の引数列を別コマンドとして実行する」プログラム。tokens[0] の basename だけで
 * 対象を同定すると、`env rm -rf /` / `timeout 5 rm -rf /tmp` / `sudo rm -rf /` のように配下の
 * 破壊コマンドを取りこぼし low/medium に落ち、承認ゲートを素通りさせていた。分類前にラッパを
 * **再帰的に剥がして**実コマンドを同定する。
 *
 * 各ラッパが「実コマンドの前に取りうる自分用の引数」をスキップするためのルールを持つ:
 *  - env: `-i` / `-u NAME` / `VAR=val` (代入) / `-` を実コマンド前に取る。
 *  - timeout: option (`-s X`/`--signal=...`/`-k`/`--preserve-status` 等) + duration を取る。
 *  - sudo: `-u user` / `-g group` / `-i` / `-E` / `-H` 等を取る。
 *  - nice: `-n N` / `-N` を取る。
 *  - その他 (xargs/nohup/command/stdbuf/setsid) は短/長オプションのみを汎用スキップ。
 *
 * ⚠️ sh/bash 等のシェルは RUNNER_WRAPPERS に**含めない**。シェルの扱いは 2 通りに分岐する:
 *    - `sh script.sh` のようなファイル実行は通常コマンド (low のまま、over-gate しない)。
 *    - `sh -c "..."` のようなインラインコードは classifyInlineCode が別途検出してゲートする
 *      (SEC-1。stripRunnerWrappers の責務外 = 実コマンド同定ではなく「内側コードの再分類/床上げ」)。
 */
const RUNNER_WRAPPERS = new Set([
  "env",
  "xargs",
  "timeout",
  "nohup",
  "nice",
  "command",
  "stdbuf",
  "setsid",
  "sudo",
  "doas",
  // SEC-12 (round D 再監査): 権限昇格ラッパは配下を別コマンドとして実行する。pkexec/run0 を剥がさないと
  //   `pkexec wipefs /dev/sda` が commandName=pkexec で破壊ツールを取りこぼし floor で medium 止まり
  //   (本来 high)。sudo/doas と対称化する。
  "pkexec",
  "run0",
  // 再監査#4 round2 (E): 後続を実コマンドとして実行/評価する prefix ビルトイン。
  //   `exec sh -c "..."` / `time rm -rf /` / `builtin rm -rf /` の prefix で実コマンドが隠れる穴を、
  //   既存のラッパ剥がし機構で一括除去する (剥がし後の実コマンドを構造判定の対象にする)。
  //   `.` / `source` は「ファイル/プロセス置換を source 実行する」別挙動のため (F) で扱う。
  "exec",
  "time",
  "builtin",
]);

/** ラッパ剥がしの最大反復 (二重・多重ラッパでも有界に止める。ReDoS/無限ループ防止)。 */
const MAX_WRAPPER_STRIP = 8;

/**
 * tokens 先頭の runner ラッパを再帰的に剥がし、実コマンドのトークン列を返す。
 *
 * 純粋なトークン走査 (正規表現なし) で実装し、ReDoS 経路を増やさない。各ラッパ固有の引数
 * (env の VAR=val / timeout の duration / sudo の -u user / nice の -n N 等) を控えめに
 * スキップする。判定不能なときは「剥がさない」側に倒し、過剰スキップで実コマンドを失わない。
 *
 * 戻り値の `capExhausted`: 反復上限に達してもなお先頭がラッパのとき true。ラッパを多重に
 * 積んで実コマンドを上限の奥へ隠す回避を fail-safe (gated) に倒すためのシグナル。
 */
function stripRunnerWrappers(tokens: string[]): { tokens: string[]; capExhausted: boolean } {
  let cur = tokens;
  for (let iter = 0; iter < MAX_WRAPPER_STRIP; iter++) {
    if (cur.length === 0) return { tokens: cur, capExhausted: false };
    const name = commandName(cur);
    if (!RUNNER_WRAPPERS.has(name)) return { tokens: cur, capExhausted: false };

    let i = 1; // ラッパ自身の次から実コマンドを探す。
    while (i < cur.length) {
      const t = cur[i];
      if (t === undefined) break; // 防御 (noUncheckedIndexedAccess)。到達しないが型安全。
      if (t === "--") {
        i++;
        break;
      } // 明示的な引数終端。
      // env の VAR=val 代入はオプション位置にのみ現れる。
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      if (t.startsWith("-")) {
        // オプション。値を別トークンで取るものをラッパ別にスキップする。
        if (name === "env" && (t === "-u" || t === "-S")) {
          i += 2;
          continue;
        } // env -u NAME / -S
        if (name === "nice" && t === "-n") {
          i += 2;
          continue;
        } // nice -n N
        if (
          (name === "sudo" &&
            (t === "-u" || t === "-g" || t === "-U" || t === "-p" || t === "-C")) ||
          // SEC-2 (round D 再監査): doas は値付きオプションの文法が sudo と別。`-u user` / `-C config` /
          //   `-a style` を skip しないと `doas -u root <破壊ツール>` で配下コマンドを取りこぼす
          //   (`-u` を単独オプション扱い→`root` を実コマンド誤認)。RUNNER_WRAPPERS 収録済みなのに
          //   値 skip 表が sudo 専用だった非対称を解消する。
          (name === "doas" && (t === "-u" || t === "-C" || t === "-a")) ||
          // SEC-12: pkexec/run0 の対象ユーザ指定 (`pkexec --user root <破壊>` / `run0 -u root <破壊>`) を
          //   skip しないと配下コマンドを取りこぼす。
          ((name === "pkexec" || name === "run0") && (t === "-u" || t === "--user"))
        ) {
          i += 2;
          continue;
        } // sudo -u user / doas -u user / pkexec --user user 等 (値あり)
        if (name === "timeout" && (t === "-s" || t === "-k")) {
          i += 2;
          continue;
        } // timeout -s SIG / -k DUR
        i++; // それ以外の単独オプション (-i / --signal=KILL 等)。
        continue;
      }
      // 非オプション・非代入トークン = 実コマンド or ラッパ固有の位置引数。
      // timeout は最初の非オプション位置引数が duration なのでスキップして次を実コマンドとみなす。
      if (name === "timeout") {
        i++; // duration をスキップ。
        break;
      }
      break; // env/sudo/nice/xargs/... はここが実コマンド。
    }
    const next = cur.slice(i);
    if (next.length === 0) return { tokens: cur, capExhausted: false }; // ラッパ単体 → 剥がさない。
    if (next.length === cur.length) return { tokens: cur, capExhausted: false }; // 進捗なし → 停止。
    cur = next;
  }
  // 上限到達。なお先頭がラッパなら「実コマンドを上限の奥へ隠した」可能性 → fail-safe gated。
  return { tokens: cur, capExhausted: RUNNER_WRAPPERS.has(commandName(cur)) };
}

/** rm が再帰かつ強制か (フラグの順不同・融合・分割・long を全許容)。 */
function isRecursiveForcedRm(tokens: string[]): boolean {
  if (commandName(tokens) !== "rm") return false;
  let recursive = false;
  let force = false;
  for (const t of tokens.slice(1)) {
    const tl = t.toLowerCase();
    if (tl === "--recursive") recursive = true;
    else if (tl === "--force") force = true;
    else if (/^-[a-z]*$/i.test(t)) {
      // 融合短フラグ (-rf / -fr / -Rf 等) を 1 文字ずつ。
      // QA-3: コマンド全体が uppercase (`RM -RF`) の変種を取りこぼさないため小文字化して判定する。
      if (/r/.test(tl)) recursive = true;
      if (/f/.test(tl)) force = true;
    }
  }
  return recursive && force;
}

/** git push が強制か。 */
function isForcedGitPush(tokens: string[]): boolean {
  if (commandName(tokens) !== "git" || !tokens.includes("push")) return false;
  return tokens.some(
    (t) =>
      t === "-f" ||
      t === "--force" ||
      t === "--force-with-lease" ||
      (/^-[a-z]*$/i.test(t) && t.startsWith("-") && !t.startsWith("--") && t.includes("f")),
  );
}

/** chmod が world-writable / 再帰か。 */
function isDangerousChmod(tokens: string[]): boolean {
  if (commandName(tokens) !== "chmod") return false;
  for (const t of tokens.slice(1)) {
    if (t === "-R" || t === "--recursive") return true;
    if (/^[0-7]{3,4}$/.test(t) && /[2367]$/.test(t)) return true; // others ビットに write
    if (/[ao]\+?w/i.test(t) || /\+w/.test(t)) return true; // a+w / o+w / +w
  }
  return false;
}

/** ブロックデバイスへの書込 (リダイレクト or dd of=)。 */
const BLOCK_DEVICE_RE = /\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z]|vd[a-z]|mmcblk\d)/i;
function writesBlockDevice(command: string, tokens: string[]): boolean {
  // > /dev/sda 等のリダイレクト先。
  if (/[<>]\s*\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z]|vd[a-z]|mmcblk\d)/i.test(command)) return true;
  // dd of=/dev/...
  if (commandName(tokens) === "dd" && tokens.some((t) => /^of=\/dev\//i.test(t))) return true;
  return false;
}

/**
 * ディスク / ファイルシステム / パーティション / 暗号デバイス / LVM・RAID を**不可逆に破壊しうる**
 * プログラム (basename, 正規化後)。SEC-7。
 *
 * 背景: `\bmkfs\b` (HIGH_RISK_LITERAL_RE) は `mkfs.ext4` を捕捉するが、同等に破壊的な兄弟ツール
 * (`mke2fs` = mkfs.ext* の実体 / `wipefs` / `blkdiscard` / `sfdisk` 等) を取りこぼし、`wipefs -a /dev/sda`
 * のような不可逆操作が low → 承認ゲート素通り (auto/bypassPermissions で無承認実行) になっていた。
 *
 * 構造ゲート (memory security-gate-reuse-canonical-parser): literal 正規表現への列挙追記 (いたちごっこ)
 * でなく、**分類器が共有する tokenize → stripRunnerWrappers → commandName → normalizeCommandName と
 * 同一の正規化**で basename を照合する。これにより `/sbin/wipefs` / `'wipefs'` / `sudo wipefs` /
 * `env X=1 wipefs` を path/quote/wrapper 非依存で同一に捕捉する (PERSIST_DENY_PROGRAMS と同方式)。
 * `mkfs.<fstype>` ファミリ (ext2/3/4・xfs・btrfs・vfat・ntfs・exfat・f2fs…) は列挙せず prefix で一括。
 *
 * 設計上の over-gate 許容: `parted -l` / `cryptsetup status` のような読取専用サブコマンドも high に倒すが、
 * 承認ゲートは fail-safe (false-negative=leak を許さず false-positive=確認過多は許容)・かつこれらは
 * コーディングエージェントの通常作業に現れない root/admin ツールゆえ実害ゼロ。引数解析で読取/破壊を
 * 区別する複雑化は新たな bypass 面を作るため採らない (program 単位で倒すのが最も堅牢)。
 */
const DESTRUCTIVE_DISK_PROGRAMS: ReadonlySet<string> = new Set([
  // ファイルシステム作成 (mkfs.* は isDestructiveDiskProgram の prefix 判定で一括)。
  "mke2fs", // mkfs.ext2/3/4 の実体バイナリ
  "mkswap",
  "mkdosfs", // = mkfs.fat/vfat
  "mkntfs", // = mkfs.ntfs
  // パーティションテーブル編集 (誤操作で全データ喪失)。
  "fdisk",
  "cfdisk",
  "sfdisk",
  "gdisk",
  "cgdisk",
  "sgdisk",
  "parted",
  // 署名/データ消去・低レベル破壊書込。
  "wipefs",
  "blkdiscard",
  "shred",
  "badblocks", // -w は破壊的書込テスト
  // 暗号デバイス (luksFormat 等で鍵スロット不可逆初期化)。
  "cryptsetup",
  // 低レベル format / secure-erase (読取モードを持たず常時破壊・SEC-3)。
  "sg_format", // SCSI low-level format
  "wipe", // secure file/device wipe
  "nwipe", // secure device wipe
  // LVM / RAID の不可逆破壊。
  "pvremove",
  "vgremove",
  "lvremove",
  "lvreduce", // 論理ボリューム縮小 = データ喪失 (読取モードなし・SEC-3)
  "vgreduce", // VG から PV 除去 (SEC-3)
  "mdadm", // --create はメンバディスクを破壊
]);

/**
 * 破壊的ディスク/FS プログラムか (SEC-7)。commandName + normalizeCommandName で正規化した basename を
 * 照合し (分類器と同一正規化を共有)、`mkfs` 単体と `mkfs.<fstype>` ファミリは prefix で一括捕捉する。
 *
 * `tokens` の前処理は caller 依存 (TDA-1): classify 路は deassign + stripRunnerWrappers 後の実コマンド
 * (`sudo wipefs` → wipefs)、persist 路は raw tokenize 列 (合成/ラッパは上流 SHELL_COMPOSITION_RE /
 * isCleanExecutableToken / PERSIST_DENY_PROGRAMS で既に排除済ゆえ bare な破壊 program のみ本述語に到達)。
 */
function isDestructiveDiskProgram(tokens: string[]): boolean {
  const name = normalizeCommandName(commandName(tokens));
  if (name === "mkfs" || name.startsWith("mkfs.")) return true; // mkfs / mkfs.ext4 / mkfs.xfs …
  return DESTRUCTIVE_DISK_PROGRAMS.has(name);
}

/**
 * 読取モードを**日常的に持つ**ストレージツール (nvme/zpool/zfs/dmsetup) の、**読取以外**の
 * サブコマンドを gate (high) に倒す (SEC-7 / SEC-3 / SEC-9 / SEC-10 round D 再監査)。
 *
 * ## allowlist 反転 (SEC-10): 旧実装は破壊サブコマンドの **denylist** (destroy/format/…) だったが、
 *   full 再監査が `nvme delete-ns` / `zfs rollback` / `zpool split` 等の取りこぼし (SEC-9) を連続検出した。
 *   denylist 列挙は「ツールがサブコマンドを増やすたび追従が要る」いたちごっこで、fail-safe (false-negative=
 *   無承認破壊を禁止) と本質的に相性が悪い (memory security-gate-reuse-canonical-parser)。よって
 *   **読取サブコマンドの allowlist** に反転し、**未知/非読取は既定で gate** する (新破壊サブコマンドが
 *   将来追加されても自動的に塞がる)。allowlist 外しが over-gate (= 承認過多) で済み leak にならないのが要点。
 *   nvme/zpool/zfs/dmsetup の非読取サブコマンドはコーディングエージェントの通常作業に現れない admin 操作
 *   ゆえ over-gate の実害ゼロ。
 *
 * `tokens` は分類器と同一正規化を共有。先頭の global option (`-x`/`--y`) は飛ばして最初の非オプション
 * トークンをサブコマンドとみなす (`zfs -foo destroy x` でも捕捉)。サブコマンド無し (bare `zfs` /
 * `zfs --help`) は false (= 委ねる)。
 */
const READ_ONLY_STORAGE_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "nvme",
    new Set([
      "list",
      "list-ns",
      "list-subsys",
      "list-ctrl",
      "id-ctrl",
      "id-ns",
      "ns-descs",
      "smart-log",
      "error-log",
      "fw-log",
      "get-log",
      "get-feature",
      "show-regs",
      "telemetry-log",
      "self-test-log",
      "version",
      "help",
    ]),
  ],
  ["zpool", new Set(["list", "status", "get", "history", "iostat", "version", "help"])],
  ["zfs", new Set(["list", "get", "holds", "version", "help"])],
  ["dmsetup", new Set(["ls", "info", "status", "table", "deps", "targets", "version", "help"])],
]);
/**
 * hdparm の破壊フラグ (ATA secure-erase / TRIM 範囲 / 不良セクタ書込 / DCO 復元 / セクタ書込 / FW 書込)。
 * 固定リテラル alternation・ReDoS 無し。`--flag=value` 連結形 (SEC-8) に対応するため `=` 前で照合する。
 */
const HDPARM_DESTRUCTIVE_FLAG_RE =
  /^--(security-erase|security-erase-enhanced|trim-sector-ranges|trim-sector-ranges-stdin|make-bad-sector|dco-restore|write-sector|fwdownload)$/;

/**
 * 値を取らないことが普遍的に確実な先頭フラグ (help/version/verbose/quiet)。これらは subcommand 前に
 * 現れても安全に skip できる (値を消費しない)。これ以外の先頭オプションは値を取るか不明ゆえ skip しない。
 */
const SAFE_LEADING_FLAGS: ReadonlySet<string> = new Set([
  "-h",
  "--help",
  "-v",
  "--verbose",
  "-q",
  "--quiet",
  "-V",
  "--version",
  "-?",
  "--usage",
]);

/**
 * サブコマンドを持つストレージツールのサブコマンドを同定する (QA-1 round D 再監査)。
 *
 * これらのツールは subcommand が第1引数 (`zfs <sub> [opts]`)。**値付き global option の値を subcommand と
 * 誤認する leak** を防ぐため、option-skip は **値を取らないと確実な安全フラグ (help/verbose 等) のみ**に
 * 限定する。未知の先頭オプション (`-o status` の `-o` 等・値を取りうる) に当たったら同定不能ゆえ
 * `{ ambiguous: true }` を返し、呼び出し側が fail-safe gate する (旧実装は全 option を skip し
 * `zpool -o status create` の値 `status` を read-only subcommand と誤認して破壊 `create` を素通りさせた)。
 */
function storageSubcommand(tokens: string[]): { sub: string | undefined; ambiguous: boolean } {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (!t.startsWith("-")) return { sub: t.toLowerCase(), ambiguous: false }; // 最初の非オプション = subcommand
    if (!SAFE_LEADING_FLAGS.has(t.toLowerCase().split("=")[0] ?? t)) {
      return { sub: undefined, ambiguous: true }; // 値を取りうる未知 option → 同定不能 → gate
    }
    // 安全フラグ (-h/--help/-v 等) は値を消費しないので skip して次を見る。
  }
  return { sub: undefined, ambiguous: false }; // subcommand 無し (bare / 安全フラグのみ = --help)。
}

function isDestructiveDiskSubcommand(tokens: string[]): boolean {
  const name = normalizeCommandName(commandName(tokens));
  const readOnly = READ_ONLY_STORAGE_SUBCOMMANDS.get(name);
  if (readOnly) {
    const { sub, ambiguous } = storageSubcommand(tokens);
    if (ambiguous) return true; // 未知の先頭 option で subcommand 同定不能 → fail-safe gate (QA-1)。
    if (sub === undefined) return false; // bare / help-only は委ねる。
    return !readOnly.has(sub); // 読取 allowlist 外 = 未知/破壊 → gate (fail-safe)。
  }
  // hdparm は flag 駆動。SEC-8: `--flag=value` 連結形を `=` 前で照合する。
  if (name === "hdparm") {
    return tokens.slice(1).some((t) => HDPARM_DESTRUCTIVE_FLAG_RE.test(t.split("=")[0] ?? t));
  }
  return false;
}

/**
 * find の破壊オプション (QA-3)。
 *
 * `find ... -delete` はマッチ全件を削除し、`find ... -exec <cmd> ...` /
 * `-execdir` / `-ok` は配下で任意コマンドを実行する。これらは構造判定の対象外だったため
 * `find . -delete` / `find . -exec rm -rf {} +` が low に落ち承認ゲートを素通りしていた。
 *
 * 戻り値:
 *  - "high": -exec 配下が再帰強制 rm 等、字面で確実に破壊的なもの。
 *  - "medium": -delete / 一般の -exec (副作用ありだが内容まで断定しない) → ゲート対象。
 *  - undefined: find ではない / 破壊オプション無し。
 */
function findDestructiveRisk(tokens: string[]): "high" | "medium" | undefined {
  if (commandName(tokens) !== "find") return undefined;
  let sawExec = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-delete") return "medium";
    if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
      sawExec = true;
      // -exec 配下の最初のコマンドが既知の破壊コマンドなら high。
      const sub = tokens.slice(i + 1);
      if (sub.length > 0 && isRecursiveForcedRm(sub)) return "high";
    }
  }
  return sawExec ? "medium" : undefined;
}

/** chown が再帰 (-R/--recursive) か。所有権の再帰変更はゲート対象 (QA-3)。 */
function isRecursiveChown(tokens: string[]): boolean {
  const name = commandName(tokens);
  if (name !== "chown" && name !== "chgrp") return false;
  return tokens
    .slice(1)
    .some((t) => t === "-R" || t === "--recursive" || (/^-[a-z]*$/i.test(t) && /R/.test(t)));
}

/**
 * SEC-1: シェル/インタプリタのインラインコード + コマンド置換が承認ゲートを素通りする穴を塞ぐ。
 *
 * 背景: classifyCommandRisk は承認ゲート (approval-bridge.requiresHumanApproval) の唯一の根拠。
 * `sh -c "rm -rf /"` / `python -c "..."` / `$(rm -rf /tmp)` / `eval "..."` は、tokenize が
 * クォート/バッククォートを雑に剥がす都合で内側コマンドが構造判定に乗らず low に落ちていた。
 * low → defer → ActraDeck ゲートを張らず native flow 委譲 → bypassPermissions/auto で無承認実行。
 *
 * 方針 (ReDoS 回避が必須・memory「正規表現拡張は ReDoS 検査」):
 *  - 新規の生正規表現で内側コードを再パースしない (シェル文法の正規表現再パースは ReDoS/誤検出源)。
 *  - 既存のトークン/構造判定を再利用し、**有界**な処理のみで分類する。
 *  - 内側を確実に再パースできないものは fail-safe で **medium に床上げ** (over-gate を許容、
 *    INV-APPROVAL の false-negative を許さない)。
 */

/** インラインコードを実行するシェル (basename, 小文字)。 */
const INLINE_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** インラインコードを実行するインタプリタ (バージョンサフィックス除去後の正規名)。 */
const INLINE_INTERPRETERS = new Set(["python", "perl", "ruby", "node", "nodejs", "php"]);
/** シェルのインラインコードフラグ (-c / -lc / -ic / -i 等。融合短フラグも許容)。 */
const SHELL_INLINE_FLAG_RE = /^-[a-z]*c$/i; // 末尾が c の融合短フラグ (-c/-lc/-ic) を拾う。
/** インタプリタのインラインコードフラグ。 */
const INTERPRETER_INLINE_FLAGS = new Set(["-c", "-e", "-E", "-r", "-R"]);

/**
 * SEC-1 #5: コマンド名からバージョンサフィックスを剥がして正規名にする。
 *
 * `python3.11` / `python3` / `python2` / `node20` / `php8.2` 等のバージョン付きバイナリは、
 * INLINE_SHELLS / INLINE_INTERPRETERS の **完全一致**を漏らし承認ゲートを素通りさせていた。
 * 末尾の数字 + ドット区切り数字 (`\d+(\.\d+)*`) を 1 回だけ剥がす (有界量化子のみ・ReDoS 無し)。
 * 既知の言語/シェル名プレフィックスに一致したときのみ剥がし、`python3.11` → `python`。
 * `bash`/`sh` 等サフィックス無しの名前はそのまま返す。`go1` のような非対象は影響しない。
 */
const VERSION_SUFFIX_RE = /^([a-z]+?)\d+(?:\.\d+)*$/; // bash:語幹を非貪欲・末尾の version を有界に剥がす。
function normalizeCommandName(name: string): string {
  if (INLINE_SHELLS.has(name) || INLINE_INTERPRETERS.has(name)) return name; // サフィックス無しは即返し。
  const m = VERSION_SUFFIX_RE.exec(name);
  if (m) {
    const stem = m[1] ?? "";
    if (INLINE_SHELLS.has(stem) || INLINE_INTERPRETERS.has(stem)) return stem;
  }
  return name;
}

/** 正規化後の名前がインラインシェルか。 */
function isInlineShell(name: string): boolean {
  return INLINE_SHELLS.has(normalizeCommandName(name));
}
/** 正規化後の名前がインラインインタプリタか。 */
function isInlineInterpreter(name: string): boolean {
  return INLINE_INTERPRETERS.has(normalizeCommandName(name));
}

/** コマンド置換 `$(...)` / backtick をセグメント (raw 文字列) が含むか。 */
function hasCommandSubstitution(rawSegment: string): boolean {
  return rawSegment.includes("$(") || rawSegment.includes("`");
}

/** プロセス置換 `<(...)` / `>(...)` を文字列が含むか (SEC-1 #4)。 */
function hasProcessSubstitution(command: string): boolean {
  return command.includes("<(") || command.includes(">(");
}

/**
 * シェル/インタプリタが「スクリプトファイルを実行する形」か (SEC-1 #1-3)。
 *
 * tokens[0] (コマンド名) 以降に **非フラグの operand** が 1 つでもあればファイル実行
 * (`bash script.sh` / `python manage.py runserver`) と見なし low 維持。operand が無い
 * (フラグだけ or コマンド名のみ = `echo ... | sh` のパイプ先 / 引数なし対話シェル) なら
 * stdin からコードを読む = 中身を再分類できない → 呼び出し側が fail-safe gated に倒す。
 * 純トークン走査 (正規表現なし・有界) で ReDoS 経路を増やさない。
 */
function hasScriptFileOperand(tokens: string[]): boolean {
  return tokens.slice(1).some((t) => !t.startsWith("-"));
}

/**
 * 再監査#4 round2 (D): 構造的に解析不能なセグメントの一般化 fail-safe。
 *
 * これまでのゲートは「先頭トークンを basename 化して既知の破壊コマンド/シェルに照合する」前提
 * だった。だがサブシェル `(rm -rf /)` / ブレースグループ `{ rm -rf /; }` / 括弧付きパイプ先
 * `(sh)` / 変数展開起動 `$X -rf /` / 先頭コマンド置換 `$(echo rm) -rf /` は、先頭トークンが
 * クリーンな実行可能名にならず commandName が誤判定 → low 素通り (個別パッチのいたちごっこ)。
 *
 * 一般化ルール: stripRunnerWrappers 後の先頭トークンが「クリーンな実行可能名」に正規化できない
 * (= パス/バージョン込みの通常コマンド名 EXECUTABLE_NAME_RE にマッチしない、または ( ) { } $ < >
 * 等のシェルメタ文字を含む) とき、そのセグメントは構造判定不能 → fail-safe medium 床上げ。
 * 可能なら括弧/ブレース等を剥がして内側を再分類し high を拾う。ReDoS 回避のため有界量化子のみ。
 */
// 通常のコマンド名トークン (英数・パス区切り・ドット・プラス・ハイフン・アンダースコア)。
// 有界文字クラスのみ (量化子 + は線形)。シェルメタ文字 ( ) { } $ < > | & ` ; * ? は含まない。
const EXECUTABLE_NAME_RE = /^[A-Za-z0-9._/+-]+$/;
// 先頭の env 代入 (`VAR=val`) — 通常のシェル構文。コマンド名ではないのでスキップする。
const ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// 先頭の grouping/quote メタ文字を剥がして内側コマンドを露出させる (有界文字クラス)。
const LEADING_GROUPING_RE = /^[({\s'"]+/;
// 末尾の grouping/terminator メタ文字を剥がす。
const TRAILING_GROUPING_RE = /[)}\s;'"]+$/;

/** 先頭トークンがクリーンな実行可能名か (メタ文字を含まない通常コマンド名)。 */
function isCleanExecutableToken(token: string): boolean {
  return EXECUTABLE_NAME_RE.test(token);
}

/**
 * セグメント先頭の env 代入トークン (`VAR=val`) をスキップして実コマンド先頭の index を返す。
 * `FOO=bar ls` のような正当な代入プレフィックスを「解析不能メタ文字」と誤認しないため。
 */
function skipLeadingAssignments(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t !== undefined && ASSIGNMENT_TOKEN_RE.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * 解析不能セグメント (先頭がシェルメタ文字) の risk を判定する (D)。
 * grouping メタ文字を剥がした内側を再分類して high を拾い、不能なら medium 床上げ。
 * 該当しない (先頭がクリーンな実行可能名 / 代入のみ) なら undefined を返す。
 *
 * `fromProcSubSplit`: このセグメントが `<(`/`>(` の split 断片 (`(ls)` 等) で、かつコマンドの
 * 起動が process-sub を**実行しない**ベニーン (diff/cat 等) のときに medium 床上げを抑止する。
 * `diff <(ls) <(ls)` を low 維持するため (over-gate 防止)。内側が high なら依然 high を返す。
 */
function unanalyzableSegmentRisk(
  rawTokens: string[],
  rawSegment: string,
  depth: number,
  suppressMediumFloor: boolean,
): "high" | "medium" | undefined {
  const startIdx = skipLeadingAssignments(rawTokens);
  const first = rawTokens[startIdx];
  if (first === undefined) return undefined; // 代入のみ (`FOO=bar`) → コマンド無し。委ねる。
  if (isCleanExecutableToken(first)) return undefined; // 通常コマンド名 → 既存判定に委ねる。

  // grouping/quote メタ文字を剥がして内側を露出させ、再分類で high を拾う。
  if (depth < MAX_INLINE_DEPTH) {
    const unwrapped = rawSegment.replace(LEADING_GROUPING_RE, "").replace(TRAILING_GROUPING_RE, "");
    // 剥がしで実際に変化したときのみ再分類 (無限ループ防止)。
    if (unwrapped.length > 0 && unwrapped !== rawSegment) {
      const inner = classifyCommandRiskInternal(unwrapped, depth + 1);
      if (inner === "high") return "high";
    }
  }
  // process-sub の split 断片かつ起動がベニーン (実行しない) なら medium 床上げを抑止 (low 維持)。
  if (suppressMediumFloor) return undefined;
  // 先頭メタ文字を持つ = 構造判定不能 → fail-safe medium (over-gate 許容)。
  return "medium";
}

/**
 * インラインコード/置換の risk を判定する (SEC-1)。
 *
 * tokens は quote-strip 済みトークン列、rawSegment は同セグメントの生文字列 (置換検出用)。
 * 戻り値: "high" (内側が確実に破壊的) / "medium" (ゲート対象・床上げ) / undefined (該当せず)。
 *
 * depth: 再帰深さ。内側コードを classifyCommandRisk で再分類する際、無限再帰を防ぐ上限を設ける。
 */
const MAX_INLINE_DEPTH = 4;
function inlineCodeRisk(
  tokens: string[],
  rawSegment: string,
  depth: number,
): "high" | "medium" | undefined {
  const name = commandName(tokens);

  // eval "..." → 内側は任意コマンド。再パースは困難なので medium 以上 (over-gate)。
  if (name === "eval") return "medium";

  // シェルのインラインコード (sh -c "..." 等)。SEC-1 #5: python3.11 等のバージョン付きでも拾う。
  if (isInlineShell(name)) {
    const flagIdx = tokens.findIndex((t, i) => i > 0 && SHELL_INLINE_FLAG_RE.test(t));
    if (flagIdx >= 0) {
      // クォートは tokenize で剥がれているため、フラグ以降のトークンが内側コードの語列。
      const inner = tokens.slice(flagIdx + 1);
      if (inner.length > 0 && depth < MAX_INLINE_DEPTH) {
        // 内側を再帰再分類: high を拾えれば high、そうでなければ fail-safe で medium に床上げ。
        const innerRisk = classifyCommandRiskInternal(inner.join(" "), depth + 1);
        return innerRisk === "high" ? "high" : "medium";
      }
      // 内側が抽出できない (クォート/エスケープで再パース不能) → fail-safe medium。
      return "medium";
    }
    // インラインフラグが無い場合: ファイル実行 (`sh script.sh`) なら low、stdin からコードを
    // 読む形 (`echo ... | sh` / 引数なし `sh`) なら中身を再分類できない → fail-safe medium (#1-3)。
    if (!hasScriptFileOperand(tokens)) return "medium"; // 非フラグ operand 無し = stdin/対話 → gated。
    // -c 等のインラインフラグが無い `sh script.sh` はファイル実行 → ゲート対象外 (over-gate 防止)。
  }

  // インタプリタのインラインコード (python -c / node -e 等)。言語別の安全な再パースは困難 →
  // インラインフラグがあれば一律 medium 以上 (fail-safe; over-gate を許容)。SEC-1 #5: バージョン付き対応。
  if (isInlineInterpreter(name)) {
    const hasInlineFlag = tokens.slice(1).some((t) => INTERPRETER_INLINE_FLAGS.has(t));
    if (hasInlineFlag) return "medium";
    // pipe-to-interpreter (`cat foo | python` 引数なし = stdin からコードを読む) → fail-safe medium。
    if (!hasScriptFileOperand(tokens)) return "medium";
    // `node app.js` / `python manage.py runserver` のようなファイル実行は low のまま。
  }

  // コマンド置換 `$(...)` / backtick。可能なら内側を再帰再分類して high を拾う。
  if (hasCommandSubstitution(rawSegment)) {
    if (depth < MAX_INLINE_DEPTH) {
      const innerRisk = reclassifySubstitution(rawSegment, depth + 1);
      if (innerRisk === "high") return "high";
    }
    return "medium"; // 置換あり = 中身が再分類で確定しなくてもゲート対象。
  }

  return undefined;
}

/**
 * `$(...)` / backtick の中身を抽出して再分類する (有界・正規表現の再パース無し)。
 * 文字走査でネスト無視の素朴抽出 (最外の開き〜対応する閉じ)。over-extraction しても
 * classifyCommandRisk が安全側に倒すため許容。high を拾えればそれを返す。
 */
function reclassifySubstitution(rawSegment: string, depth: number): "high" | "medium" | undefined {
  const inners: string[] = [];
  // $(...) 抽出 (ネストは無視し、最初の ) で閉じる素朴版)。
  let i = 0;
  while (i < rawSegment.length) {
    if (rawSegment[i] === "$" && rawSegment[i + 1] === "(") {
      const end = rawSegment.indexOf(")", i + 2);
      if (end < 0) break;
      inners.push(rawSegment.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  // backtick `...` 抽出。
  const bt = rawSegment.split("`");
  for (let k = 1; k < bt.length; k += 2) {
    const seg = bt[k];
    if (seg !== undefined && seg.length > 0) inners.push(seg);
  }
  let medium = false;
  for (const inner of inners) {
    const r = classifyCommandRiskInternal(inner, depth + 1);
    if (r === "high") return "high";
    if (r === "medium") medium = true;
  }
  return medium ? "medium" : undefined;
}

/**
 * プロセス置換 `<(...)` / `>(...)` の中身を抽出して再分類する (SEC-1 #4)。
 * `$(...)` 抽出と同型の素朴な文字走査 (有界・正規表現の再パース無し)。`bash <(echo "rm -rf /")`
 * の `<(...)` 内コマンドを拾い、破壊的なら high を返す。over-extraction は安全側に倒すため許容。
 */
function reclassifyProcessSubstitution(
  command: string,
  depth: number,
): "high" | "medium" | undefined {
  const inners: string[] = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if ((c === "<" || c === ">") && command[i + 1] === "(") {
      const end = command.indexOf(")", i + 2);
      if (end < 0) break;
      inners.push(command.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  let medium = false;
  for (const inner of inners) {
    const r = classifyCommandRiskInternal(inner, depth + 1);
    if (r === "high") return "high";
    if (r === "medium") medium = true;
  }
  return medium ? "medium" : undefined;
}

/**
 * 後続のファイル/プロセス置換を「実行/source 評価する」起動コマンド (SEC-1 #4 / round2 F)。
 * shell/インタプリタに加え、source 系ビルトイン `.` / `source` / `eval` を含める。
 * `. <(echo "rm -rf /")` / `source <(...)` は中身を source 実行するためゲート対象。
 * ⚠️ `diff <(ls)` / `cat <(...)` / `tee` のように中身を**ファイルとして読むだけで実行しない**
 *    コマンドは含めない (over-gate 防止。BENIGN は low 維持)。
 */
const PROC_SUBST_EXECUTING_BUILTINS = new Set([".", "source", "eval"]);
function isProcessSubstitutionExecutor(name: string): boolean {
  return (
    isInlineShell(name) || isInlineInterpreter(name) || PROC_SUBST_EXECUTING_BUILTINS.has(name)
  );
}

/**
 * コマンドが「実行系起動コマンド + プロセス置換」か (SEC-1 #4 / round2 F)。
 * 起動コマンド (先頭セグメントの runner ラッパ剥がし後) が実行/source 系で、かつ
 * 文字列に `<(`/`>(` を含むとき true。プロセス置換の中身は再パースしづらいためゲート対象。
 */
function launchesShellWithProcessSubstitution(command: string): boolean {
  if (!hasProcessSubstitution(command)) return false;
  const firstSeg = splitSegments(command)[0];
  if (firstSeg === undefined) return false;
  const { tokens } = stripRunnerWrappers(tokenize(firstSeg));
  const name = commandName(tokens);
  return isProcessSubstitutionExecutor(name);
}

/** 字面で確実に high な操作 (構造判定の補完)。 */
const HIGH_RISK_LITERAL_RE =
  /\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bdrop\s+table\b|\btruncate\s+table\b|\bmigrate\b|\bproduction\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/i;

export function classifyCommandRisk(command: string): RiskLevel {
  return classifyCommandRiskInternal(command, 0);
}

/**
 * 永続化適格判定の **構造ゲート** (ADR 019ee0c0 / SEC-1/1a/1b/1c)。承認の再起動跨ぎ永続化
 * (allow_for_session + persist) の対象を「**構造的に単純で危険 program を含まない** medium コマンド」に
 * 限定する。承認ゲート自体は不変 (毎回 / セッション内 確認は可能) で「再起動後も無人 auto-allow」だけを禁じる。
 *
 * SEC が 3 連続 (SEC-1/1a/1b) で denylist のバイパス (`node -e`/`. <(curl)`/`| /bin/sh`/backtick/
 * `\sudo`/`python3.11 -c`/`'sudo'`/`find -exec +`) を実証した。根因は **persist ゲートが分類器とは別の
 * 手書きパーサを使い正規化が乖離する**こと。そこで `isPersistDeniedCommand` (下記) が分類器と同一の
 * tokenize/commandName/normalizeCommandName/isCleanExecutableToken を共有して乖離を構造的に排除する。
 *
 * SHELL_COMPOSITION_RE = 合成メタ文字 (`| & ; $ \` ( ) { } < > 改行`)。これを含むコマンドはパイプ
 * (curl|sh・絶対パス/任意シェル含む)・コマンド置換 (`$(...)`/backtick)・プロセス置換 (`<(...)`)・連結
 * (`&&`/`;`)・リダイレクト・サブシェルのいずれかゆえ **語彙非依存で永続不可**にする (新シェル名や新 DL
 * ツールが来ても閉じたまま)。ReDoS 安全: 文字クラス 1 個 (backtracking なし・redaction-redos 教訓)。
 */
const SHELL_COMPOSITION_RE = /[|&;$`(){}<>\n]/;

/**
 * 永続化を許さない program (basename)。合成メタ文字を含まない平坦コマンドの残余危険源。
 * 権限昇格 / インタプリタ inline (任意コード) / 公開 (不可逆) / network-exec (供給鎖) / shell 起動 / ラッパ。
 */
const PERSIST_DENY_PROGRAMS: ReadonlySet<string> = new Set([
  // 権限昇格・ラッパ (実体プログラムを後置で隠す)。
  "sudo",
  "su",
  "doas",
  "pkexec",
  "run0",
  "env",
  "command",
  "exec",
  "eval",
  "source",
  ".",
  "xargs",
  "nice",
  "ionice",
  "timeout",
  "watch",
  "setsid",
  "stdbuf",
  "nohup",
  "chroot",
  "unshare",
  // shell 起動 (inline -c / スクリプト実行)。
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "ash",
  // 言語インタプリタ inline (-e/-c/-r で任意コード)。
  "node",
  "nodejs",
  "deno",
  "bun",
  "ts-node",
  "tsx",
  "python",
  "python2",
  "python3",
  "pypy",
  "pypy3",
  "perl",
  "ruby",
  "php",
  "lua",
  "luajit",
  "Rscript",
  "groovy",
  "scala",
  // パッケージ runner / 公開 (任意 script 実行・不可逆公開)。
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "pnpx",
  "bunx",
  // ビルド/タスク runner (任意 target を exec)。
  "make",
  "cmake",
  "gradle",
  "gradlew",
  "mvn",
  "ant",
  "bazel",
  "task",
  "just",
  // コンテナ / オーケストレータ (任意 entrypoint exec)。
  "docker",
  "podman",
  "nerdctl",
  "kubectl",
  "helm",
  "compose",
  // network-exec (供給鎖 / リモート実行)。
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
  // 破壊的ファイルシステム / システム mutator (SEC-5/SEC-6・ADR 019ee0c0)。
  //   chown/chgrp は唯一の medium-destructive 操作で**不可逆** (元の所有者マップ喪失) → 永続不可必須 (SEC-5)。
  //   他は現状 high で非 persistable だが、将来の risk 再分類に対する防御多層 backstop (SEC-6)。
  //   program 名 deny ゆえ非再帰 chown(low・元々非persistable) を over-gate しない (degrade も session のみ)。
  "chown",
  "chgrp",
  "chmod",
  "rm",
  "rmdir",
  "dd",
  "shred",
  "truncate",
  "mv",
  "ln",
  "mkfs",
  "mount",
  "umount",
  "kill",
  "pkill",
  "killall",
  "crontab",
  "at",
  // SEC-8: 権限/属性/セキュリティコンテキスト mutator + 特権配置。いずれも**常に変更系**で良性な
  //   read 形を持たない (read は getfacl/lsattr/ls -Z)。現状 low ゆえ persist 経路に来ないが、
  //   chmod/chown と同クラスの backstop として deny を明示 (将来 medium 再分類でも over-gate=安全側のみ)。
  //   sed -i / cp -rf / tar -x / rsync --delete 等の **flag 条件付き** 破壊形は、支配的に良性な
  //   read/copy 形 (sed ''/cp/tar -c/rsync) を blanket program-deny で過剰 gate しないため**非追加**
  //   (現状すべて low=非 gated)。medium 再分類時は flag 認識 deny が必要 (mv が deny で cp が非 deny の前例と同方針)。
  "install",
  "setfacl",
  "chattr",
  "chcon",
]);

/** find が -exec/-execdir/-ok/-okdir で任意コマンドを起動するか (SEC-1c)。-delete のみは永続可。 */
function findUsesExec(tokens: string[]): boolean {
  if (commandName(tokens) !== "find") return false;
  return tokens
    .slice(1)
    .some((t) => t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir");
}

/**
 * medium-risk でも **永続化不可** か (true=永続不可・session-only に degrade)。
 *
 * SEC 3 連続所見 (SEC-1/1a/1b) の根因は「persist ゲートが分類器とは別の手書きパーサを使い正規化が
 * 乖離する」こと (`\sudo` / `python3.11 -c` / `'sudo'` / `find -exec +` が片側だけ素通り)。本実装は
 * **分類器と同一のトークン化/正規化を共有**して乖離を構造的に排除する:
 *  1. SHELL_COMPOSITION_RE: 合成メタ文字 (パイプ/置換/連結/リダイレクト/サブシェル) を語彙非依存で排除。
 *  2. tokenize: 分類器と同じトークナイザ (クォートを正規化し `'sudo'`→`sudo`)。
 *  3. isCleanExecutableToken: 先頭 program がクリーン実行可能名でない (`\sudo` / `$X` 等) → 構造判定不能
 *     ゆえ fail-safe deny (分類器が unanalyzable を medium 床上げするのと同一基準・SEC-1b)。
 *  4. findUsesExec: find -exec/-execdir/-ok は任意コマンド実行 → deny (-delete のみ許容・SEC-1c)。
 *  5. PERSIST_DENY_PROGRAMS: commandName(path/大小文字) + normalizeCommandName(version 接尾辞) で正規化した
 *     basename を集合照合 (`/usr/bin/sudo`→sudo / `python3.11`→python・TDA-6)。
 *
 * ReDoS 安全: 文字クラス test + 既存トークナイザ (有界) のみ。承認分類 (classifyCommandRisk) は不変。
 */
export function isPersistDeniedCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return true; // fail-safe
  if (SHELL_COMPOSITION_RE.test(command)) return true; // 合成/置換/連結/リダイレクト/サブシェル
  const tokens = tokenize(command);
  const first = tokens[0];
  if (first === undefined) return true; // fail-safe (空/空白のみ)
  // SEC-1b: 先頭 program がクリーン実行可能名でない (\sudo / $X / メタ混入) → 構造判定不能 → deny。
  if (!isCleanExecutableToken(first)) return true;
  // SEC-1c: find -exec 系は任意コマンド実行。
  if (findUsesExec(tokens)) return true;
  // SEC-7/SEC-3: 破壊的ディスク/FS program (mkfs ファミリ + DESTRUCTIVE_DISK_PROGRAMS) と
  //   破壊サブコマンド (nvme format / zfs destroy / hdparm --security-erase…)。現状 classify-high ゆえ
  //   そもそも persist 候補に来ないが、将来 risk 再分類に対する防御多層 backstop として deny を明示
  //   (classify gate と同一述語を共有し DRY・SEC-5/SEC-6 の chown/rm/dd backstop と同方針)。
  if (isDestructiveDiskProgram(tokens) || isDestructiveDiskSubcommand(tokens)) return true;
  // 危険 program (path/version/quote 正規化後の basename)。分類器と同一の正規化を共有 (SEC-1b/TDA-6)。
  return PERSIST_DENY_PROGRAMS.has(normalizeCommandName(commandName(tokens)));
}

/**
 * classifyCommandRisk の本体 (depth 付き)。
 *
 * depth: SEC-1 のインラインコード/コマンド置換の内側を再帰再分類する際の深さ。
 * MAX_INLINE_DEPTH で有界化し、`$(...)` をネストした病的入力でも無限再帰しない。
 */
function classifyCommandRiskInternal(command: string, depth: number): RiskLevel {
  if (typeof command !== "string" || command.length === 0) return "high"; // fail-safe
  if (command.length > 16 * 1024) return "high"; // 解析不能に巨大 → fail-safe high
  if (depth >= MAX_INLINE_DEPTH) return "medium"; // 再帰上限到達 → 分類不能を gated に倒す。

  if (HIGH_RISK_LITERAL_RE.test(command)) return "high";
  if (BLOCK_DEVICE_RE.test(command) && /[<>]|dd\b/i.test(command)) return "high";

  // 構造判定: medium は「ゲート対象だが high まで断定しない」もの。high が見つかれば即返す。
  let medium = false;

  // SEC-1 #4: シェル/インタプリタ + プロセス置換 `<(...)`/`>(...)`。splitSegments が `<`/`>` で
  //   分割するため起動シェルが裸セグメント化して (B) でも拾えるが、ここで明示的に中身を再分類し
  //   破壊的なら high を拾う。再分類不能でも medium に床上げ (fail-safe)。
  const procSubExecutor = launchesShellWithProcessSubstitution(command);
  if (procSubExecutor) {
    if (depth < MAX_INLINE_DEPTH) {
      const inner = reclassifyProcessSubstitution(command, depth + 1);
      if (inner === "high") return "high";
    }
    medium = true;
  }
  // process-sub があるが起動がベニーン (diff/cat 等 = 中身を実行しない) なら、`<(`/`>( ` の split で
  //   生じる `(ls)` 断片に対する (D) の medium 床上げを抑止して low を維持する (over-gate 防止)。
  //   内側が high のときは依然 high を拾う (`diff <(rm -rf /tmp)`)。
  const suppressGroupingMedium = hasProcessSubstitution(command) && !procSubExecutor;

  for (const seg of splitSegments(command)) {
    const rawTokens = tokenize(seg);
    if (rawTokens.length === 0) {
      // トークンが無くても置換 `$(...)`/backtick だけのセグメントは SEC-1 でゲートする。
      if (hasCommandSubstitution(seg)) medium = true;
      continue;
    }
    // 再監査#4 round2 (D): 先頭がシェルメタ文字 ( { $ < > 等でクリーンな実行可能名に正規化できない
    //   セグメントは構造判定不能 → grouping を剥がして内側を再分類 (high を拾う)、不能なら medium 床上げ。
    //   `(rm -rf /)` / `{ rm -rf /; }` / `(sh)` / `$X -rf /` を一括捕捉。
    const unanalyzable = unanalyzableSegmentRisk(rawTokens, seg, depth, suppressGroupingMedium);
    if (unanalyzable === "high") return "high";
    if (unanalyzable === "medium") medium = true;
    // SEC-1 (round D 再監査): bare な先頭 env 代入 (`FOO=bar rm -rf /`) は RUNNER_WRAPPERS に無く
    //   commandName が `FOO=bar` を返すため、全構造述語が実コマンドを取りこぼし承認ゲートを素通り
    //   させていた (ラッパ経由 `env FOO=bar rm` は捕捉できるのに bare 代入が素通りする非対称が証拠)。
    //   構造判定の前に先頭代入を skip し、ラッパ剥がしと同列に正規化する。skip 後に runner ラッパを剥がす
    //   (`FOO=bar sudo rm -rf /` の順序も成立)。
    const deassigned = rawTokens.slice(skipLeadingAssignments(rawTokens));
    // 再#3 QA-1/QA-3: env / timeout / sudo 等の runner ラッパを再帰的に剥がし、配下の実コマンドを
    //   構造判定の対象にする。剥がす前後で対象同定が変わらないものはそのまま (剥がし=no-op)。
    const { tokens, capExhausted } = stripRunnerWrappers(deassigned);
    if (tokens.length === 0) continue;
    // 多重ラッパで実コマンドを剥がし上限の奥に隠した疑い → 分類不能として gated (medium) に倒す。
    if (capExhausted) medium = true;
    if (
      isRecursiveForcedRm(tokens) ||
      isForcedGitPush(tokens) ||
      isDangerousChmod(tokens) ||
      writesBlockDevice(seg, tokens) ||
      isDestructiveDiskProgram(tokens) || // SEC-7: wipefs/mke2fs/blkdiscard/sfdisk/parted/cryptsetup…
      isDestructiveDiskSubcommand(tokens) // SEC-3: nvme format / zpool destroy / zfs destroy / hdparm --security-erase…
    ) {
      return "high";
    }
    // QA-3: find の破壊オプション / chown -R はゲート対象 (medium 以上)。
    const findRisk = findDestructiveRisk(tokens);
    if (findRisk === "high") return "high";
    if (findRisk === "medium" || isRecursiveChown(tokens)) medium = true;
    // SEC-1: シェル/インタプリタのインラインコード + コマンド置換。
    //   stripRunnerWrappers 後の実コマンドに対して判定する (env X=1 bash -c "..." 等を拾う)。
    const inlineRisk = inlineCodeRisk(tokens, seg, depth);
    if (inlineRisk === "high") return "high";
    if (inlineRisk === "medium") medium = true;
  }

  if (medium) return "medium";
  // SEC-11 (round D 再監査): 権限昇格ラッパは sudo と対称に medium 床上げする (doas/pkexec/run0 を追加)。
  //   `su` は短く一般語 (su.txt 等) の部分一致で誤爆するため字面床上げには含めない (配下が破壊的なら
  //   構造述語が high を返すので leak にはならない・昇格自体の per-invocation 床上げのみの差)。
  if (/\b(sudo|doas|pkexec|run0)\b|\bcurl\b.*\|\s*(sh|bash)|npm\s+publish/i.test(command))
    return "medium";
  return "low";
}

/** ツール名から「種別」を判定 (Bash / Edit系 / MCP / WebSearch / その他)。 */
type ToolKind = "bash" | "edit" | "mcp" | "websearch" | "other";
export function classifyTool(toolName: string): ToolKind {
  if (toolName === "Bash" || toolName === "BashOutput") return "bash";
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit"
  )
    return "edit";
  if (toolName.startsWith("mcp__")) return "mcp";
  if (toolName === "WebSearch" || toolName === "WebFetch") return "websearch";
  return "other";
}

/** mcp__server__tool → { server, tool }。 */
function parseMcpToolName(toolName: string): { server: string; tool: string } {
  const parts = toolName.split("__");
  return { server: parts[1] ?? "unknown", tool: parts.slice(2).join("__") || "unknown" };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * 空文字も undefined に倒す string ガード。
 *
 * `asString("") === ""` のため `asString(x) ?? fallback` は **空文字を素通り**させる
 * (?? は null/undefined しか捕まえない穴)。agent_type のように「空 = 値なし」とみなす
 * フィールドはこちらを使い、空文字を欠落と同一視する (INV-SUBAGENT-BOUNDARY)。
 */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * 有限数値ガード。NaN/Infinity/数値以外は undefined に倒す。
 *
 * exit_code のように「実在が確認できたもののみ載せる (捏造禁止)」フィールドで使う。
 * CC の PostToolUse `tool_response.exit_code` は実観測上 number だが、CC バージョン差で
 * 欠落・非数値になりうるため、number かつ有限のときだけ採用し、欠落時は **0 を捏造しない**。
 */
function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * command ライフサイクル相関キーのプレフィックス (started↔completed を結ぶ共有キー)。
 *
 * 出所は CC hook の `tool_use_id` (実観測 `toolu_<id>`、PreToolUse/PostToolUse 共通)。
 * 承認 request_id は `<session_id>:<base64url 乱数>` 形式 (`:` を含む) なので、本キーは
 * `tu:` プレフィックスで **キー空間を明示分離**し、両者が同じ `request_id` フィールドに
 * 載っても突合ロジックが取り違えない (cross-namespace collision を構造的に防ぐ)。
 * tool_use_id が欠落/空なら undefined を返し、相関キーを載せない (捏造しない)。
 */
function toolUseCorrelationId(input: HookCommonInput): string | undefined {
  const id = nonEmptyString(input.tool_use_id);
  return id !== undefined ? `tu:${id}` : undefined;
}

/**
 * 表示用に 1 行へ畳んで上限長で切り詰める。
 *
 * 3#SEC-2 (truncation-before-redaction): **切り詰めの前に redaction を適用**する。
 * normalize は EventSink.emit の前段で走るため、ここで生 command/text を先に slice すると
 * MAX_REDACT_INPUT / max 境界を跨ぐ secret 断片 (例: `ghp_…` が最小長ルール未満まで切られる)
 * が emit 後の redactDeep でも未マッチのまま summary/payload に残留しうる。よって
 * **redactString → 1 行化 → slice** の順にして、切り詰める時点で値が既にマスク済みである
 * ことを保証する (INV-REDACTION の順序: redact→persist→send を normalize 段でも先取り)。
 */
function summarize(s: string, max = 120): string {
  const masked = redactString(s);
  const oneLine = masked.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/**
 * 1 件の hook 入力を 0..N 件の NormalizedEvent 候補へ正規化する。
 * 多くは 1 件だが、将来 batch hook 等で複数化しうるため配列で返す。
 *
 * approvalRequestId: PermissionRequest 時に承認ブリッジが採番した相関 ID を
 * summary 兼 payload に乗せて UI 側で突合できるようにする (任意)。
 */
export interface NormalizeContext {
  readonly approvalRequestId?: string;
  /**
   * 自動ガード (ADR 019ecc70 段階1・D3/D4): なぜ pause したか。approvalRequestId と並んで渡し、
   * `tool.permission.requested` payload の `trigger` に載せる (additive optional)。
   */
  readonly guardTrigger?: "destructive" | "secret" | "both";
  /**
   * 自動ガード (ADR 019ecc70 D3): secret-trigger の kind 名 (REDACTION_KINDS allowlist のみ)。
   * INV-AUTOGUARD-NO-RAW: 原文ゼロ。`tool.permission.requested` payload の `secret_kinds` に載せる。
   */
  readonly guardSecretKinds?: readonly string[];
  /**
   * SEC-2 (ADR 019e9b89): allow_for_session の同一署名キャッシュ命中で **auto-allow** された
   * 高リスク操作のとき true。PreToolUse の観測 payload に `auto_allowed: true` を付け、監査ログで
   * 「session-grant 由来の自動許可」を low-risk defer と識別可能にする (over-allow ではない)。
   */
  readonly autoAllowed?: boolean;
  /**
   * ADR 019ee0c0: この承認要求が永続 allowlist 対象 (medium-bash + 非 secret + repo 解決可 +
   * feature-ON) のとき true。`tool.permission.requested` payload の `persistable` に載せ、UI が
   * 「再起動後も許可」を提示するか決める根拠にする (additive optional)。
   */
  readonly guardPersistable?: boolean;
  /**
   * ADR 019ee0c0: 永続 allowlist のディスク署名命中で auto-allow されたとき true。autoAllowed と
   * 並んで PreToolUse 観測 payload に `persist_grant: true` を付け、「再起動跨ぎ grant 由来の自動許可」を
   * session-grant (auto_allowed のみ) と監査識別可能にする。
   */
  readonly persistGrant?: boolean;
  /**
   * 観測モード (ADR 019ea476 D8)。Attach 経路の hook 正規化では "attach" を渡し、
   * 全候補イベントに capture_mode="attach" を付与する。省略時は付与しない (managed 既定扱い)。
   */
  readonly captureMode?: "managed" | "attach";
}

export function normalizeHook(
  input: HookCommonInput,
  ctx: NormalizeContext = {},
): ReturnType<typeof buildEvent>[] {
  const base: Pick<
    BuildEventInput,
    "session_id" | "cwd" | "agent_id" | "capture_mode" | "permission_mode"
  > = {
    session_id: input.session_id,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
    ...(ctx.captureMode !== undefined ? { capture_mode: ctx.captureMode } : {}),
    // 段階2 (ADR 019ea4ba D3): hook の permission_mode を投影 (sandbox 表示・後方互換 optional)。
    ...(typeof input.permission_mode === "string" && input.permission_mode.length > 0
      ? { permission_mode: input.permission_mode }
      : {}),
  };

  const make = (
    event_type: EventType,
    state: State | undefined,
    extra: {
      summary?: string;
      payload?: Record<string, unknown>;
      turn_id?: string;
    } = {},
  ): ReturnType<typeof buildEvent> =>
    buildEvent({
      ...base,
      event_type,
      ...(state !== undefined ? { state } : {}),
      ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
      ...(extra.turn_id !== undefined ? { turn_id: extra.turn_id } : {}),
      payload: { kind: event_type, ...(extra.payload ?? {}) },
    });

  switch (input.hook_event_name) {
    case "SessionStart": {
      const source = asString(input.source);
      return [
        make("session.started", "starting", {
          summary: `セッション開始 (${source ?? "startup"})`,
          payload: { ...(input.cwd ? { repo: input.cwd } : {}), ...(source ? { source } : {}) },
        }),
      ];
    }

    case "UserPromptSubmit": {
      const prompt = asString(input.prompt) ?? "";
      return [
        make("turn.started", "running.model_wait", {
          summary: prompt ? `依頼: ${summarize(prompt)}` : "ユーザー依頼",
          payload: { prompt_summary: summarize(prompt, 200) },
        }),
      ];
    }

    case "PreToolUse": {
      const toolName = asString(input.tool_name) ?? "unknown";
      const toolInput = (input.tool_input ?? {}) as ToolInput;
      const kind = classifyTool(toolName);

      // ADR 019e9999 (中心的所見): PreToolUse がゲート対象 (高リスク) のとき、承認ブリッジは
      // ingest(input, requestId) で approvalRequestId を渡す (low-risk は defer で渡さない)。
      // この場合は command.started 等 (running.*) ではなく **request_id 付き
      // tool.permission.requested (waiting.approval)** を emit し、UI が承認カードを出して
      // approve frame に request_id を載せられるようにする。これが無いと最頻の高リスク経路
      // (auto/bypass の rm -rf 等) で UI は承認待ちすら見えなかった (INV-APPROVAL-PRETOOLUSE-EMIT)。
      // command は summarize(redact→1行→slice) で redaction 済み。path は生載せだが、
      // 全イベントは EventSink.emit の choke point で redactDeep を通ってから保存・送信される
      // (SEC-3 訂正: path の redaction は summarize でなく sink.redactDeep が担保)。
      if (ctx.approvalRequestId !== undefined) {
        const payload: Record<string, unknown> = {
          request_id: ctx.approvalRequestId,
          tool_name: toolName,
        };
        // 自動ガード (ADR 019ecc70 D3/D4): なぜ pause したか / secret kind を載せる (additive)。
        // secret_kinds は非空のときのみ (空配列は付けない)。原文は載らない (kind 名のみ・上流で allowlist 済)。
        if (ctx.guardTrigger !== undefined) payload.trigger = ctx.guardTrigger;
        if (ctx.guardSecretKinds !== undefined && ctx.guardSecretKinds.length > 0) {
          payload.secret_kinds = [...ctx.guardSecretKinds];
        }
        // ADR 019ee0c0: 永続化可能なときのみ persistable=true を載せる (UI が「再起動後も許可」を出す根拠)。
        if (ctx.guardPersistable === true) payload.persistable = true;
        let summary = `承認待ち: ${toolName}`;
        if (kind === "bash") {
          const command = asString(toolInput.command) ?? "";
          payload.command = summarize(command, MAX_COMMAND_LEN);
          payload.risk_level = classifyCommandRisk(command);
          summary = `承認待ち: ${toolName} (${summarize(command, 60)})`;
        } else if (kind === "edit") {
          const path = asString(toolInput.file_path) ?? "unknown";
          payload.path = path;
          summary = `承認待ち: ${toolName} (${path})`;
        } else if (kind === "mcp") {
          const { server, tool } = parseMcpToolName(toolName);
          summary = `承認待ち: MCP ${server}/${tool}`;
        }
        return [make("tool.permission.requested", "waiting.approval", { summary, payload })];
      }

      // SEC-2: allow_for_session の同一署名 auto-allow 経由の観測には auto_allowed マーカーを付け、
      // 監査ログで「session-grant 由来の自動許可」を low-risk defer と識別可能にする (over-allow でない)。
      // SEC-2 / ADR 019ee0c0: auto-allow 由来を監査識別する。persist_grant は再起動跨ぎ disk grant 由来。
      const autoMark =
        ctx.autoAllowed === true
          ? { auto_allowed: true, ...(ctx.persistGrant === true ? { persist_grant: true } : {}) }
          : {};

      if (kind === "bash") {
        const command = asString(toolInput.command) ?? "";
        const correlationId = toolUseCorrelationId(input);
        return [
          make("command.started", "running.command_executing", {
            summary: `コマンド実行: ${summarize(command, 100)}`,
            payload: {
              // 再#SEC-1: command も無切り詰めで保持しない (巨大入力での redaction/保存負荷を抑制)。
              command: summarize(command, MAX_COMMAND_LEN),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              risk_level: classifyCommandRisk(command),
              // tool_use_id 由来の相関キー。同じキーを command.completed に載せ started↔completed を結ぶ。
              ...(correlationId !== undefined ? { request_id: correlationId } : {}),
              ...autoMark,
            },
          }),
        ];
      }
      if (kind === "edit") {
        const path = asString(toolInput.file_path) ?? "unknown";
        return [
          make("file.change.proposed", "running.file_editing", {
            summary: `ファイル編集: ${path}`,
            payload: { path, ...autoMark },
          }),
        ];
      }
      if (kind === "mcp") {
        const { server, tool } = parseMcpToolName(toolName);
        return [
          make("mcp.call.started", "running.mcp_tool_calling", {
            summary: `MCP: ${server}/${tool}`,
            payload: { server, tool, ...autoMark },
          }),
        ];
      }
      if (kind === "websearch") {
        const query = asString(toolInput.query) ?? "";
        return [
          make("web.search.started", "running.web_searching", {
            summary: `Web 検索: ${summarize(query, 80)}`,
            payload: { query, ...autoMark },
          }),
        ];
      }
      return [
        make("tool.started", "running.tool_preparing", {
          summary: `ツール: ${toolName}`,
          payload: { tool_name: toolName, ...autoMark },
        }),
      ];
    }

    case "PostToolUse": {
      const toolName = asString(input.tool_name) ?? "unknown";
      const kind = classifyTool(toolName);
      if (kind === "bash") {
        // 実観測 (code.claude.com/docs hooks + live probe 2026-06):
        //  - PostToolUse(Bash) は tool_response={stdout,stderr,exit_code(number)}(+任意 interrupted/isImage)。
        //  - tool_use_id は PreToolUse と同一値で運ばれ、started↔completed の相関キー出所。
        // 載せるのは「実在が確認できたもののみ」: exit_code は number のときだけ (0 を捏造しない)。
        // stdout/stderr 本文は載せない (既存の output delta excerpt 経路があり redaction 面を広げない)。
        const toolInput = (input.tool_input ?? {}) as ToolInput;
        const command = asString(toolInput.command);
        const toolResponse = (input.tool_response ?? {}) as Record<string, unknown>;
        const exitCode = asFiniteNumber(toolResponse.exit_code);
        const correlationId = toolUseCorrelationId(input);
        const payload: Record<string, unknown> = {};
        if (exitCode !== undefined) payload.exit_code = exitCode;
        if (command !== undefined) payload.command = summarize(command, MAX_COMMAND_LEN);
        if (correlationId !== undefined) payload.request_id = correlationId;
        const exitLabel = exitCode !== undefined ? ` (exit ${exitCode})` : "";
        return [
          make("command.completed", "running.model_wait", {
            summary: `コマンド完了: ${toolName}${exitLabel}`,
            payload,
          }),
        ];
      }
      if (kind === "edit") {
        const toolInput = (input.tool_input ?? {}) as ToolInput;
        const path = asString(toolInput.file_path) ?? "unknown";
        return [
          make("file.change.applied", "running.model_wait", {
            summary: `ファイル適用: ${path}`,
            payload: { path },
          }),
        ];
      }
      if (kind === "mcp") {
        const { server, tool } = parseMcpToolName(toolName);
        return [
          make("mcp.call.completed", "running.model_wait", {
            summary: `MCP 完了: ${server}/${tool}`,
            payload: { server, tool },
          }),
        ];
      }
      return [
        make("tool.completed", "running.model_wait", {
          summary: `ツール完了: ${toolName}`,
          payload: { tool_name: toolName },
        }),
      ];
    }

    case "PostToolUseFailure": {
      const toolName = asString(input.tool_name) ?? "unknown";
      // tool_response は string (旧前提) か object のどちらもありうる。Bash 等は
      // {stdout,stderr,exit_code} の object。string ならそのまま errorText、object なら
      // stderr を errorText に採り、exit_code/command/相関キーを PostToolUse と整合させる
      // (実在が確認できたもののみ・捏造しない)。
      const rawResponse = input.tool_response;
      const responseObj =
        rawResponse !== null && typeof rawResponse === "object"
          ? (rawResponse as Record<string, unknown>)
          : undefined;
      const errorText = asString(rawResponse) ?? asString(responseObj?.stderr) ?? "tool failed";
      const toolInput = (input.tool_input ?? {}) as ToolInput;
      const command = asString(toolInput.command);
      const exitCode = asFiniteNumber(responseObj?.exit_code);
      const correlationId = toolUseCorrelationId(input);
      const payload: Record<string, unknown> = {
        tool_name: toolName,
        error: summarize(errorText, 200),
      };
      if (exitCode !== undefined) payload.exit_code = exitCode;
      if (command !== undefined) payload.command = summarize(command, MAX_COMMAND_LEN);
      if (correlationId !== undefined) payload.request_id = correlationId;
      return [
        make("tool.failed", "running.model_wait", {
          summary: `ツール失敗: ${toolName}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`,
          payload,
        }),
      ];
    }

    case "PermissionRequest": {
      const toolName = asString(input.tool_name) ?? "unknown";
      const toolInput = (input.tool_input ?? {}) as ToolInput;
      const kind = classifyTool(toolName);
      const payload: Record<string, unknown> = { tool_name: toolName };
      if (kind === "bash" && toolInput.command) {
        payload.command = summarize(asString(toolInput.command) ?? "", MAX_COMMAND_LEN);
        payload.risk_level = classifyCommandRisk(asString(toolInput.command) ?? "");
      }
      if (kind === "edit" && toolInput.file_path) payload.path = toolInput.file_path;
      if (ctx.approvalRequestId) payload.request_id = ctx.approvalRequestId;
      return [
        make("tool.permission.requested", "waiting.approval", {
          summary: `承認待ち: ${toolName}${toolInput.command ? ` (${summarize(asString(toolInput.command) ?? "", 60)})` : ""}`,
          payload,
        }),
      ];
    }

    case "Notification": {
      const ntype = asString(input.notification_type);
      const message = asString(input.message) ?? "";
      if (ntype === "permission_prompt") {
        return [
          make("heartbeat", "waiting.approval", {
            summary: `承認プロンプト: ${summarize(message, 80)}`,
            payload: { process_alive: true },
          }),
        ];
      }
      if (ntype === "idle_prompt") {
        return [
          make("heartbeat", "waiting.user_input", {
            summary: "入力待ち",
            payload: { process_alive: true },
          }),
        ];
      }
      // auth_success 等は状態変更なしの軽量 heartbeat。
      return [
        make("heartbeat", undefined, {
          summary: `通知: ${ntype ?? "notification"}`,
          payload: { process_alive: true },
        }),
      ];
    }

    // INV-SUBAGENT-BOUNDARY: subagent.started/completed は **agent_type が非空のときだけ** emit する。
    // 公式 hooks 仕様では Subagent{Start,Stop} は 1 サブエージェントにつき 1 回ずつ agent_type 付きで
    // 発火する。だが --agent / --fork-session / 常駐 daemon の spare/slash で起動された session 自身の
    // 停止は、**対応する SubagentStart の無い** agent_type 空の SubagentStop を発火させる
    // (実データ ~/.actradeck/sidecar.db: 空 agent_type の completed 67/67 が start と非相関、
    //  named 109/109 が agent_id で start と 1:1 相関)。これを completed 化すると started≠completed と
    // なり「稼働中サブエージェント数」がアンダーフローしうる。空/欠落は境界でなく heartbeat 化する。
    case "SubagentStart": {
      const agentType = nonEmptyString(input.agent_type);
      if (agentType === undefined) {
        return [
          make("heartbeat", undefined, {
            summary: "通知: subagent start (agent_type 無し)",
            payload: { process_alive: true },
          }),
        ];
      }
      return [
        make("subagent.started", undefined, {
          summary: `サブエージェント開始: ${agentType}`,
          payload: { task: agentType, agent_type: agentType },
        }),
      ];
    }

    case "SubagentStop": {
      const agentType = nonEmptyString(input.agent_type);
      if (agentType === undefined) {
        return [
          make("heartbeat", undefined, {
            summary: "通知: subagent stop (agent_type 無し)",
            payload: { process_alive: true },
          }),
        ];
      }
      return [
        make("subagent.completed", undefined, {
          summary: `サブエージェント完了: ${agentType}`,
          payload: { agent_type: agentType },
        }),
      ];
    }

    case "PreCompact": {
      const trigger = asString(input.trigger);
      return [
        make("context.compacted", "compacting", {
          summary: `コンテキスト圧縮 (${trigger ?? "auto"})`,
          payload: { trigger: trigger === "manual" ? "manual" : "auto" },
        }),
      ];
    }

    case "PostCompact": {
      return [
        make("heartbeat", "running.model_wait", {
          summary: "圧縮完了 → 作業再開",
          payload: { process_alive: true },
        }),
      ];
    }

    case "Stop": {
      return [
        make("turn.completed", "idle", {
          summary: "ターン完了",
          payload: {},
        }),
      ];
    }

    case "SessionEnd": {
      const reason = asString(input.reason) ?? "other";
      return [
        make("session.ended", "completed", {
          summary: `セッション終了 (${reason})`,
          payload: { reason },
        }),
      ];
    }

    default:
      // 未対応 hook も観測の事実として heartbeat 化 (落とさず可視化)。
      return [
        make("heartbeat", undefined, {
          summary: `hook: ${input.hook_event_name}`,
          payload: { process_alive: true },
        }),
      ];
  }
}
