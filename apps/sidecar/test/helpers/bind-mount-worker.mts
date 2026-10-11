/**
 * bind mount の残余 vector (SEC-SL-1 repro 2) を `unshare -rm` の private mount namespace の中で走らせるワーカー
 * (test only・vitest 非対象 = .mts)。呼び元が `unshare -rm <tsx> <this file>` で起動する (root 不要・mount は
 * namespace の外に見えない)。
 *
 * 手順 (SEC の det-probes bind-mount と同じ): <BASE>/repo を <BASE>/alt へ bind mount する (scopeKey は別になる)。
 * 実 attach CLI の daemon Y を repo で常駐させ、alt の path に stale 記録を置き、alt で拒否される起動を実 CLI で
 * 走らせる。Y の entry の前後の数などを JSON 1 行で stdout に出す。HOME は <BASE>/home (呼び元の tmp)。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scopeArtifacts, writeDaemonState } from "../../src/daemon-state.js";
import { endpointOfEntry, isActradeckEntry } from "../../src/settings-merge.js";

const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = process.env.TSX_BIN as string;
const base = process.env.BASE as string;
const cli = join(sidecarRoot, "src", "cli.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const repo = join(base, "repo");
const alt = join(base, "alt");
const home = join(base, "home");
for (const d of [join(repo, ".claude"), alt, home]) mkdirSync(d, { recursive: true });
const settingsPath = join(repo, ".claude", "settings.local.json");
writeFileSync(
  settingsPath,
  JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }],
    },
  }),
);
const env = (db: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  ACTRADECK_WS_URL: "ws://127.0.0.1:1",
  ACTRADECK_DB: db,
});
const entries = (): Array<string | undefined> => {
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
  };
  return Object.values(s.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter(isActradeckEntry)
    .map(endpointOfEntry);
};

const m = spawnSync("mount", ["--bind", repo, alt], { encoding: "utf8" });
if (m.status !== 0) throw new Error(`mount failed: ${m.stderr}`);
const altSettings = join(alt, ".claude", "settings.local.json");
const repoArt = scopeArtifacts(settingsPath, home);
const altArt = scopeArtifacts(altSettings, home);

const y = spawn(tsx, [cli, "attach", "--cwd", repo], {
  cwd: repo,
  env: env(join(base, "y.db")),
  stdio: ["ignore", "ignore", "pipe"],
  detached: true,
});
let err = "";
y.stderr.on("data", (c: Buffer) => (err += c.toString()));
const deadline = Date.now() + 30_000;
let endpoint: string | undefined;
while (Date.now() < deadline && endpoint === undefined) {
  endpoint = /常駐中 \(endpoint=(http:\/\/127\.0\.0\.1:\d+\/hook)\)/.exec(err)?.[1];
  await sleep(50);
}
if (endpoint === undefined) throw new Error(`Y not resident: ${err}`);

const srv = createServer();
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const addr = srv.address();
const port = typeof addr === "object" && addr !== null ? addr.port : 0;
await new Promise<void>((r) => srv.close(() => r()));
const staleEp = `http://127.0.0.1:${port}/hook`;
writeDaemonState(altArt.statePath, {
  pid: spawnSync(process.execPath, ["-e", ""]).pid,
  endpoint: staleEp,
  scope: "project-local",
  settingsPath: altArt.canonicalSettingsPath,
  startedAt: new Date().toISOString(),
  tokenMode: "literal",
});
const before = entries().filter((e) => e === endpoint).length;
const r = spawnSync(tsx, [cli, "attach", "--cwd", alt, "--token-mode", "env"], {
  cwd: alt,
  env: env(join(base, "b.db")),
  encoding: "utf8",
  timeout: 60_000,
});
const after = entries().filter((e) => e === endpoint).length;
let yAlive = true;
try {
  process.kill(-(y.pid as number), 0);
} catch {
  yAlive = false;
}
const out = {
  keys: { repo: repoArt.scopeKey, alt: altArt.scopeKey },
  yEntriesBefore: before,
  yEntriesAfter: after,
  yAlive,
  yStateStill: existsSync(repoArt.statePath),
  altStateStill: existsSync(altArt.statePath),
  refusedExit: r.status,
  refusedStderr: r.stderr,
};
try {
  process.kill(-(y.pid as number), "SIGKILL");
} catch {
  /* 既に終了 */
}
spawnSync("umount", [alt]);
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
