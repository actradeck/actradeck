/**
 * INV-ATTACH-SCOPE-LOCK ヘルパ (test only・vitest 非対象 = .mts): attach の scope lock を **別プロセス**
 * (distinct pid) で保持するワーカー。file-lock は自 pid の lock を奪うので、lock の直列化は thread では検証
 * できない (memory: cross-process-test-needs-real-processes)。
 *
 * MODE:
 * - `start`: 本番と同じ primitive を本番の lock2 と同じ順序で呼ぶ daemon A。`withScopeLock` の中で
 *   `mergeAttachHooks` → (`HOLD_MS` 待つ = merge と state 書込の間の窓を広げる) → `writeDaemonState` (自分の
 *   pid と同一性)。lock を外した後も生き続ける (記録 pid が生きている daemon)。止めるのは呼び元 (SIGKILL)。
 * - `hold`: `withScopeLock` の中で `HOLD_MS` 待つだけ (lock を取得できない経路の検証)。
 *
 * 入出力は env と `SIG_DIR` 配下の sentinel (`held` = lock の中に入った・`released` = lock を外した)。
 * HOME / cwd は呼び元が os.tmpdir 配下を与える (実 ~/.claude・~/.actradeck に触れない)。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scopeTarget, withScopeLock } from "../../src/attach-scope.js";
import { writeDaemonState } from "../../src/daemon-state.js";
import { captureSelfIdentity } from "../../src/process-identity.js";
import { mergeAttachHooks } from "../../src/settings-merge.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0)
    throw new Error(`scope-lock-holder: env ${name} is required`);
  return v;
}

const mode = requireEnv("MODE");
const home = requireEnv("HOME_DIR");
const cwd = requireEnv("CWD_DIR");
const sigDir = requireEnv("SIG_DIR");
const holdMs = Number(requireEnv("HOLD_MS"));

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const target = scopeTarget("project-local", cwd, home);
withScopeLock(target, () => {
  if (mode === "start") {
    const endpoint = requireEnv("ENDPOINT");
    mergeAttachHooks({
      settingsPath: target.settingsPath,
      endpoint,
      tokenMode: "literal",
      token: "tok-scope-lock-holder-0123456789abcdef",
    });
    writeFileSync(join(sigDir, "held"), String(process.pid));
    sleep(holdMs);
    const identity = captureSelfIdentity();
    writeDaemonState(target.artifacts.statePath, {
      pid: process.pid,
      endpoint,
      scope: "project-local",
      settingsPath: target.artifacts.canonicalSettingsPath,
      startedAt: new Date().toISOString(),
      tokenMode: "literal",
      ...(identity !== undefined ? { procIdentity: identity } : {}),
    });
  } else if (mode === "hold") {
    writeFileSync(join(sigDir, "held"), String(process.pid));
    sleep(holdMs);
  } else {
    throw new Error(`scope-lock-holder: unknown MODE ${mode}`);
  }
});
writeFileSync(join(sigDir, "released"), String(process.pid));
// 記録 pid が生きている daemon として居続ける (呼び元が SIGKILL で止める)。
setInterval(() => undefined, 60_000);
