/**
 * agent-visibility — agentmon doctor の「観測可能性 / 接続証明」(Increment 1・ADR 019f1972 Phase 0)。
 *
 * 動機: `command -v claude` で binary が PATH にあっても、ActraDeck の hook が
 * ユーザーの settings.json に **未注入** なら cockpit は無言で空のまま。binary の有無は
 * 必要条件だが十分条件ではない。本モジュールは daemon を起動せず **純ローカル検査** で
 * 「ActraDeck が実際にそのエージェントを観測する配線になっているか」を計算する。
 *
 * SECURITY (NO-RAW): 返す/出力するのは **boolean・固定 scope enum キー・小さな非負整数のみ**。
 * 絶対パス / settings.json の中身 / home ディレクトリ / token / secret は一切含めない。
 * scope は固定 enum キー名 (`user`/`project`/`projectLocal`) で識別し、パスは出力しない。
 *
 * 検出器は再実装しない: hook 検出は settings-merge.ts の canonical な
 * {@link settingsFileHasActradeckHook} (= isActradeckEntry 共有)、CODEX_HOME 解決は
 * codex-rollout-tailer.ts の {@link resolveCodexHome} / {@link rolloutSessionsDir} を共有する
 * (security-gate-reuse-canonical-parser — drift-prone な二重実装を避ける)。
 */
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { AgentVisibilityWire } from "@actradeck/event-model";

import { resolveCodexHome, rolloutSessionsDir } from "./codex-rollout-tailer.js";
import { settingsFileHasActradeckHook } from "./settings-merge.js";

/** CC settings の scope 識別子 (固定 enum・パスの代わりにこのキーで scope を示す)。 */
export type HookScope = "user" | "project" | "projectLocal";

export interface ClaudeVisibility {
  /** `claude` 実行ファイルが PATH 上で解決可能か (= `command -v claude` 相当)。 */
  readonly binaryOnPath: boolean;
  /** scope 別に ActraDeck hook が settings.json へ注入済か。 */
  readonly hookInstalled: Readonly<Record<HookScope, boolean>>;
  /** いずれかの scope に hook があるか。 */
  readonly anyHook: boolean;
}

export interface CodexVisibility {
  /** `codex` 実行ファイルが PATH 上で解決可能か。 */
  readonly binaryOnPath: boolean;
  /** runtime と同一解決の rollout ディレクトリ (`<CODEX_HOME>/sessions`) がディスク上に存在するか。 */
  readonly rolloutDirResolved: boolean;
}

export interface AgentVisibility {
  readonly claude: ClaudeVisibility;
  readonly codex: CodexVisibility;
}

export interface AgentVisibilityOptions {
  /** project scope の基準ディレクトリ (既定 process.cwd())。 */
  readonly cwd?: string;
  /** user scope の基準ホーム (既定 os.homedir())。 */
  readonly home?: string;
  /** PATH / CODEX_HOME の解決に使う env (既定 process.env)。 */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * `command -v <name>` 相当: PATH の各ディレクトリに実行可能な `<name>` があるか。
 * POSIX 想定 (PATH を delimiter で分割し X_OK を確認)。alias/builtin は対象外だが、
 * binary on PATH の判定としては command -v と等価。
 */
function isExecutableOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const pathVar = env.PATH ?? "";
  if (pathVar.length === 0) return false;
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // このディレクトリには無い / 実行不可 → 次へ。
    }
  }
  return false;
}

/**
 * エージェント観測可能性を **daemon 非起動** の純ローカル検査で計算する。
 * cwd / home / env は注入可能 (temp dir での unit テストのため)。
 */
export function computeAgentVisibility(opts: AgentVisibilityOptions = {}): AgentVisibility {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // CC settings scope パス (これらのパスは出力に出さない — boolean のみ surface)。
  const userPath = join(home, ".claude", "settings.json");
  const projectPath = join(cwd, ".claude", "settings.json");
  const projectLocalPath = join(cwd, ".claude", "settings.local.json");

  const hookInstalled: Record<HookScope, boolean> = {
    user: settingsFileHasActradeckHook(userPath),
    project: settingsFileHasActradeckHook(projectPath),
    projectLocal: settingsFileHasActradeckHook(projectLocalPath),
  };
  const anyHook = hookInstalled.user || hookInstalled.project || hookInstalled.projectLocal;

  const rolloutDir = rolloutSessionsDir(resolveCodexHome(env, home));

  return {
    claude: {
      binaryOnPath: isExecutableOnPath("claude", env),
      hookInstalled,
      anyHook,
    },
    codex: {
      binaryOnPath: isExecutableOnPath("codex", env),
      rolloutDirResolved: existsSync(rolloutDir),
    },
  };
}

/**
 * `AgentVisibility` を backend へ運ぶ wire 形 (`@actradeck/event-model` の正準 `AgentVisibilityWire`)
 * へ射影する **純関数** (ADR 019f1972 §2b・decision 019f1a29)。
 *
 * NO-RAW (表面最小化): wire に載せるのは **boolean 4 個のみ** — claude.binaryOnPath / claude.anyHook /
 * codex.binaryOnPath / codex.rolloutDirResolved。per-scope の `hookInstalled` 詳細・パス・settings 内容は
 * **載せない** (CLI doctor 留保)。既知 field のみを明示射影するため、AgentVisibility に将来 field が増えても
 * wire へ自動で漏れない (NO-RAW by construction)。受信側の `parseAgentVisibilityWire` と対称。
 */
export function toAgentVisibilityWire(v: AgentVisibility): AgentVisibilityWire {
  return {
    claude: { binaryOnPath: v.claude.binaryOnPath, anyHook: v.claude.anyHook },
    codex: { binaryOnPath: v.codex.binaryOnPath, rolloutDirResolved: v.codex.rolloutDirResolved },
  };
}

/**
 * hello frame の `agentVisibilityProvider` に渡す **fail-safe** thunk のための共有ヘルパ。
 * `computeAgentVisibility()` (純ローカル fs 検査) を実行し wire へ射影するが、万一 throw しても
 * **undefined を返して hello 送信を止めない** (後方互換: provider 未注入と同じく field 省略)。
 * 各 daemon が try/catch を重複実装しないための単一出所 (consolidation)。
 */
export function computeAgentVisibilityWire(
  opts: AgentVisibilityOptions = {},
): AgentVisibilityWire | undefined {
  try {
    return toAgentVisibilityWire(computeAgentVisibility(opts));
  } catch {
    // fs 例外等 → 未報告扱い (fail-safe・hello を成立させ続ける)。
    return undefined;
  }
}

/** anyHook が true のとき、最初に hook を持つ scope を返す (人間向け表示用・enum のみ)。 */
export function firstInstalledScope(v: ClaudeVisibility): HookScope | undefined {
  if (v.hookInstalled.user) return "user";
  if (v.hookInstalled.project) return "project";
  if (v.hookInstalled.projectLocal) return "projectLocal";
  return undefined;
}

/** 人間向け (日本語) の概要を描画する (NO-RAW: enum/✓✗ のみ・パス非出力)。 */
export function renderAgentVisibilityHuman(v: AgentVisibility): string {
  const lines: string[] = [];
  const ok = "✓";
  const ng = "✗";
  // Claude
  if (v.claude.binaryOnPath && v.claude.anyHook) {
    // TDA-2 (sweep 019f1991): この分岐は anyHook===true ゆえ firstInstalledScope は必ず scope を返す
    // (user/project/projectLocal のいずれかが true)。`?? "user"` は実行時到達不能な **型レベル fallback**
    // (返り型 HookScope|undefined を絞るため・実挙動には影響しない)。
    const scope = firstInstalledScope(v.claude) ?? "user";
    lines.push(
      `claude: binary ${ok} / hook 注入済(${scope}) ${ok} → Claude セッションを観測できます`,
    );
  } else if (v.claude.binaryOnPath) {
    lines.push(
      `claude: binary ${ok} / hook 未注入 ${ng} → \`./scripts/actradeck up\` (または \`./scripts/ad-attach install-all\`) で hook を配線してください`,
    );
  } else {
    lines.push(`claude: binary ${ng} → claude 未導入 (まず claude を入れてください)`);
  }
  // Codex
  if (v.codex.binaryOnPath && v.codex.rolloutDirResolved) {
    lines.push(`codex: binary ${ok} / rollout-dir ${ok} → Codex rollout を観測できます`);
  } else if (v.codex.binaryOnPath) {
    lines.push(
      `codex: binary ${ok} / rollout-dir 未検出 ${ng} → codex を一度起動し \`./scripts/ad-attach codex install\` で rollout 観測を配線してください`,
    );
  } else {
    lines.push(`codex: binary ${ng} → codex 未導入`);
  }
  return lines.map((l) => `[doctor] connectivity: ${l}`).join("\n") + "\n";
}

/**
 * `agentmon doctor` CLI ハンドラ。`--json` で機械可読 (NO-RAW JSON)、既定は人間向け日本語。
 * daemon を起動しない純検査ゆえ env / token を要求しない。
 */
export function runAgentDoctorCli(
  argv: readonly string[],
  io: { out: (s: string) => void; err: (s: string) => void },
): number {
  const v = computeAgentVisibility();
  if (argv.includes("--json")) {
    io.out(JSON.stringify(v) + "\n");
  } else {
    io.err(renderAgentVisibilityHuman(v));
  }
  return 0;
}
