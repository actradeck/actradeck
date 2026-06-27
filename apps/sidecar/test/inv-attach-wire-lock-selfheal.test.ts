/**
 * INV-ATTACH-WIRE-LOCK / INV-ATTACH-SELF-HEAL (ADR: attach settings 配線 race 恒久対策)。
 *
 * Step 1 で実証した 2 つの窓を塞ぐ:
 *  - lost update: systemctl restart で旧 detach と新 merge の read→compute→write が
 *    インターリーブし「両 port 残存 / 片方消失 / 観測ゼロ」へ収束する窓
 *    → mergeAttachHooks/detachAttachHooks を withFileLock で直列化して塞ぐ。
 *  - dead-port residue: crash で detach されず残った旧 port marker、event 集合縮小で
 *    touch されない event の旧 marker、同 event の複数 ActraDeck group
 *    → 毎 merge で self-heal (canonical endpoint 以外の marker を全除去) して回収。
 *
 * mutation:
 *  - WIRE-LOCK: mergeAttachHooks の withFileLock を素通しにすると「held lock 中の
 *    merge が fail-loud する」テストが緑のまま通ってしまい赤化 (merge が lock を
 *    取らずに成功してしまう)。
 *  - SELF-HEAL: computeMergedSettings の purgeNonCanonicalActradeck を外すと
 *    「dead-port residue が消える」テストが赤化。
 *
 * 🔴 すべて os.tmpdir() 配下。実 ~/.claude/settings.json 不可侵。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeMergedSettings,
  detachAttachHooks,
  isActradeckEntry,
  mergeAttachHooks,
  type MergeOptions,
} from "../src/settings-merge.js";

let dir: string;
let settingsPath: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-wirelock-"));
  settingsPath = join(dir, "settings.local.json");
  // SEC-1: 本番既定の lock 名と一致させる (foreign-pid を書いて held lock を模すテストが
  // mergeAttachHooks/detachAttachHooks の実際に叩く lockPath を握れるように)。
  lockPath = `${settingsPath}.actradeck-lock`;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OLD = "http://127.0.0.1:40001/hook";
const ALT = "http://127.0.0.1:40003/hook";
const NEW = "http://127.0.0.1:40002/hook";

const opts = (endpoint: string, events: string[]): MergeOptions => ({
  settingsPath,
  endpoint,
  tokenMode: "literal",
  token: "nonce",
  events,
});

interface HookEntry {
  type?: string;
  url?: string;
  command?: string;
  [k: string]: unknown;
}
interface Group {
  hooks?: HookEntry[];
}
function readJson(): { hooks?: Record<string, Group[]> } {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, Group[]> };
}
/** 全 event・全 group の ActraDeck entry を `event:url` で列挙。 */
function actradeckWiring(): string[] {
  const s = readJson();
  const out: string[] = [];
  for (const ev of Object.keys(s.hooks ?? {})) {
    for (const g of s.hooks![ev] ?? []) {
      for (const h of g.hooks ?? []) {
        if (isActradeckEntry(h)) out.push(`${ev}:${String(h.url)}`);
      }
    }
  }
  return out.sort();
}

describe("INV-ATTACH-WIRE-LOCK: merge/detach は withFileLock で直列化される", () => {
  it("mergeAttachHooks fails loud when the settings lock is held by a live process", () => {
    // 別の生存プロセスが lock を保持中を装う (init pid=1 は奪取されない)。
    const livePid = process.pid === 1 ? 2 : 1;
    writeFileSync(lockPath, `${livePid}\n`);
    // merge が lock を取りに行く → 生存保持者あり → fail-loud。
    // (mutation: withFileLock 素通しだとここで throw せず merge 成功 → 赤)。
    expect(() => mergeAttachHooks(opts(NEW, ["SessionStart"]))).toThrow(/failed to acquire/);
    // settings は書かれていない (lock 取れず critical section 未実行)。
    expect(existsSync(settingsPath)).toBe(false);
    rmSync(lockPath, { force: true });
  });

  it("detachAttachHooks fails loud when the settings lock is held by a live process", () => {
    mergeAttachHooks(opts(OLD, ["SessionStart"])); // 先に配線
    const livePid = process.pid === 1 ? 2 : 1;
    writeFileSync(lockPath, `${livePid}\n`);
    const before = readFileSync(settingsPath, "utf8");
    expect(() => detachAttachHooks(settingsPath)).toThrow(/failed to acquire/);
    // detach されていない (lock 取れず)。
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    rmSync(lockPath, { force: true });
  });

  it("releases the settings lock after a successful merge (no leak)", () => {
    mergeAttachHooks(opts(NEW, ["SessionStart"]));
    expect(existsSync(lockPath)).toBe(false); // 自己 unlink 済
    // 続く detach も lock を取れる (リークしていれば fail-loud で落ちる)。
    const r = detachAttachHooks(settingsPath);
    expect(r.removed).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("INV-ATTACH-SELF-HEAL: dead-port residue を canonical 1 セットへ回収", () => {
  it("purges dead-port marker in an event NOT touched by the new merge", () => {
    // 旧 daemon が SessionStart+Stop を OLD で配線して crash 残留。
    mergeAttachHooks(opts(OLD, ["SessionStart", "Stop"]));
    expect(actradeckWiring()).toEqual([`SessionStart:${OLD}`, `Stop:${OLD}`]);
    // 新 daemon は SessionStart のみ NEW で配線。
    mergeAttachHooks(opts(NEW, ["SessionStart"]));
    // Stop:OLD の dead port は self-heal で消え、SessionStart:NEW 1 本のみ。
    expect(actradeckWiring()).toEqual([`SessionStart:${NEW}`]);
  });

  it("collapses multiple stale ActraDeck groups in the same event to one canonical", () => {
    // lost-update 等で同 event に複数 ActraDeck group が残ったケース + ユーザー hook。
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "user-keep" }] },
            { hooks: [{ type: "http", url: OLD, __actradeck: true }] },
            { hooks: [{ type: "http", url: ALT, __actradeck: true }] },
          ],
        },
      }),
    );
    mergeAttachHooks(opts(NEW, ["SessionStart"]));
    // canonical NEW 1 本のみ・dead port 全消去。
    expect(actradeckWiring()).toEqual([`SessionStart:${NEW}`]);
    // ユーザー hook は温存。
    const flat = (readJson().hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []);
    expect(flat).toContainEqual({ type: "command", command: "user-keep" });
  });

  it("self-heal preserves user hooks and the canonical entry while removing dead ports", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "user-pre" }] },
            { hooks: [{ type: "http", url: NEW, __actradeck: true }] }, // canonical already present
            { hooks: [{ type: "http", url: OLD, __actradeck: true }] }, // dead
          ],
        },
      }),
    );
    const { settings } = computeMergedSettings(
      JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>,
      opts(NEW, ["PreToolUse"]),
    );
    const wiring: string[] = [];
    const hooks = (settings as { hooks?: Record<string, Group[]> }).hooks ?? {};
    for (const ev of Object.keys(hooks))
      for (const g of hooks[ev] ?? [])
        for (const h of g.hooks ?? [])
          if (isActradeckEntry(h)) wiring.push(`${ev}:${String(h.url)}`);
    expect(wiring.sort()).toEqual([`PreToolUse:${NEW}`]); // dead OLD purged, canonical kept once
    const flat = (hooks.PreToolUse ?? []).flatMap((g) => g.hooks ?? []);
    expect(flat).toContainEqual({ type: "command", command: "user-pre" });
  });

  it("self-heal does NOT touch settings that have only user hooks (no actradeck markers)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "only-user" }] }] },
      }),
    );
    mergeAttachHooks(opts(NEW, ["SessionStart"]));
    // ユーザーの Stop hook は不変・SessionStart に canonical 追加のみ。
    const s = readJson();
    expect(s.hooks?.Stop).toEqual([{ hooks: [{ type: "command", command: "only-user" }] }]);
    expect(actradeckWiring()).toEqual([`SessionStart:${NEW}`]);
  });
});

describe("INV-ATTACH-WIRE-LOCK: read は critical section 内 (lost-update interleave 防止)", () => {
  // QA-1 (falsifiable): 「read が lock 内で行われ直前 holder が commit した状態を読む」を pin。
  // mutation: readSettings を lock 外へ出すと赤化 (compute-from-stale を捕捉)。
  //   具体: mergeAttachHooks の readSettings を withFileLock の外 (lock 取得前) へ出すと、
  //   この read は onLockAcquired 前の (空) 状態を読み、注入された user hook を
  //   compute-from-stale で上書き喪失させ、本テストが赤化する。
  //   実証済み: hoist mutation で本テストのみ赤 → 復元で緑 (実装報告参照)。
  it("reads disk inside the lock so a just-committed user hook is preserved while appending NEW marker", () => {
    // 空 settings から開始。lock 取得直後 (= 直前 holder が commit した相当) に、
    // user hook を含む settings をディスクへ差し込む。
    const raced = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "raced-user-hook" }] }],
      },
    };
    mergeAttachHooks({
      ...opts(NEW, ["SessionStart"]),
      lockOptions: {
        onLockAcquired: () => writeFileSync(settingsPath, JSON.stringify(raced)),
      },
    });

    const flat = (readJson().hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []);
    // read が lock 内なら: user hook を温存 (read で拾う) + canonical marker を append。
    expect(flat).toContainEqual({ type: "command", command: "raced-user-hook" }); // user hook 温存
    expect(actradeckWiring()).toEqual([`SessionStart:${NEW}`]); // marker は 1 本のみ
  });
});

describe("INV-ATTACH-WIRE-LOCK: retry budget は本番呼び出し経路で縛られる", () => {
  // QA-3: 生存 foreign pid が lock を保持中、mergeAttachHooks (本番経路) が
  //       ちょうど maxRetries 回 sleep してから fail-loud することを示す。
  it("mergeAttachHooks sleeps exactly maxRetries times then fails loud", () => {
    const livePid = process.pid === 1 ? 2 : 1;
    writeFileSync(lockPath, `${livePid}\n`);
    let slept = 0;
    expect(() =>
      mergeAttachHooks({
        ...opts(NEW, ["SessionStart"]),
        lockOptions: { maxRetries: 3, isAlive: () => true, sleep: () => void (slept += 1) },
      }),
    ).toThrow(/failed to acquire .* after 3 retries/);
    expect(slept).toBe(3);
    rmSync(lockPath, { force: true });
  });

  it("detachAttachHooks sleeps exactly maxRetries times then fails loud", () => {
    mergeAttachHooks(opts(OLD, ["SessionStart"])); // 先に配線
    const livePid = process.pid === 1 ? 2 : 1;
    writeFileSync(lockPath, `${livePid}\n`);
    let slept = 0;
    expect(() =>
      detachAttachHooks(settingsPath, {
        maxRetries: 3,
        isAlive: () => true,
        sleep: () => void (slept += 1),
      }),
    ).toThrow(/failed to acquire .* after 3 retries/);
    expect(slept).toBe(3);
    rmSync(lockPath, { force: true });
  });
});

describe("INV-ATTACH-SELF-HEAL: legacy (marker-less) ActraDeck orphan を署名で回収", () => {
  // 恒久修正 (task 019ec8e0): isActradeckEntry が `__actradeck` マーカー導入以前の
  // legacy entry を ActraDeck 専用トークン署名で識別する:
  //   - literal: headers["X-ActraDeck-Hook-Token"] を持つ。
  //   - env: allowedEnvVars に "ACTRADECK_HOOK_TOKEN" を列挙。
  // これを欠くと marker 無しの dead-port orphan が self-heal/detach で取りこぼされ、
  // CC hook が毎回 dead endpoint へ POST (ECONNREFUSED) し続け、解放済 port を
  // squat した別プロセスへ CC payload + 旧 token を流す窓が残る (SEC orphan loopback leak)。
  // mutation: hasActradeckTokenSignature を `return false` 固定にすると本 describe が赤化する
  //           (実証済: legacy orphan が purge/detach されず残る)。
  const HDR = "X-ActraDeck-Hook-Token";

  it("purges a marker-less legacy entry (literal header) at a dead port on next merge", () => {
    // 旧 ActraDeck が marker を付けず literal ヘッダだけで配線した dead-port orphan。
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "user-keep" }] },
            { hooks: [{ type: "http", url: OLD, timeout: 10, headers: { [HDR]: "old-nonce" } }] },
          ],
        },
      }),
    );
    mergeAttachHooks(opts(NEW, ["SessionStart"]));
    // legacy orphan は署名で識別され purge、canonical NEW 1 本のみ残る。
    expect(actradeckWiring()).toEqual([`SessionStart:${NEW}`]);
    // ユーザー hook は温存。
    const flat = (readJson().hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []);
    expect(flat).toContainEqual({ type: "command", command: "user-keep" });
    // 旧 nonce は settings から消える (解放済 port の squatter へ漏らさない)。
    expect(readFileSync(settingsPath, "utf8")).not.toContain("old-nonce");
  });

  it("purges a marker-less legacy entry (env allowedEnvVars) in an untouched event", () => {
    // env token-mode の legacy orphan (Authorization $VAR + allowedEnvVars、marker 無し)。
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "http",
                  url: OLD,
                  headers: { Authorization: "Bearer $ACTRADECK_HOOK_TOKEN" },
                  allowedEnvVars: ["ACTRADECK_HOOK_TOKEN"],
                },
              ],
            },
          ],
        },
      }),
    );
    mergeAttachHooks(opts(NEW, ["SessionStart"]));
    // env 署名 legacy orphan も回収され、空になった Stop event は掃除される。
    expect(actradeckWiring()).toEqual([`SessionStart:${NEW}`]);
    expect(readJson().hooks?.Stop).toBeUndefined();
  });

  it("detach removes a marker-less legacy ActraDeck entry too (only-own)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "user-keep" }] },
            { hooks: [{ type: "http", url: OLD, headers: { [HDR]: "old-nonce" } }] },
          ],
        },
      }),
    );
    const res = detachAttachHooks(settingsPath);
    expect(res.removed).toBe(true);
    const flat = (readJson().hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []);
    // legacy ActraDeck entry は除去・ユーザー hook は温存・旧 nonce は消える。
    expect(flat).toContainEqual({ type: "command", command: "user-keep" });
    expect(flat.some((h) => isActradeckEntry(h))).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).not.toContain("old-nonce");
  });

  it("does NOT misidentify a genuine user http hook (no ActraDeck signature) as ActraDeck", () => {
    // ユーザー自身の HTTP hook (ActraDeck 専用ヘッダ/env var を一切持たない)。
    const userHttp = {
      type: "http",
      url: "http://127.0.0.1:9999/my-hook",
      headers: { Authorization: "Bearer $MY_TOKEN" },
      allowedEnvVars: ["MY_TOKEN"],
    };
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [userHttp] }] } }),
    );
    // 別 event へ canonical 配線 → self-heal がユーザー HTTP hook を誤除去しない。
    mergeAttachHooks(opts(NEW, ["Stop"]));
    let flat = (readJson().hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []);
    expect(flat).toContainEqual(userHttp);
    // detach も canonical(Stop) のみ除去し、ユーザー HTTP hook は温存。
    const det = detachAttachHooks(settingsPath);
    expect(det.removed).toBe(true);
    flat = (readJson().hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []);
    expect(flat).toContainEqual(userHttp);
  });
});

describe("isActradeckEntry: 署名識別の境界 (防御分岐・QA-1)", () => {
  // QA-1 (security-adjacent): hasActradeckTokenSignature の防御分岐を述語境界で pin。
  // 過検出 (ユーザー hook 誤除去) と過小検出 (orphan 残存) の両リグレッションを捕捉する。
  const HDR = "X-ActraDeck-Hook-Token";

  it("recognizes the canonical marker", () => {
    expect(isActradeckEntry({ type: "http", url: NEW, __actradeck: true })).toBe(true);
  });

  it("recognizes a literal-header legacy entry (own-property)", () => {
    expect(isActradeckEntry({ type: "http", url: OLD, headers: { [HDR]: "x" } })).toBe(true);
  });

  it("recognizes an env legacy entry (allowedEnvVars value membership)", () => {
    expect(
      isActradeckEntry({ type: "http", url: OLD, allowedEnvVars: ["ACTRADECK_HOOK_TOKEN"] }),
    ).toBe(true);
  });

  it("does NOT match a genuine user command hook", () => {
    expect(isActradeckEntry({ type: "command", command: "echo hi" })).toBe(false);
  });

  it("does NOT match a user http hook with unrelated header/env", () => {
    expect(
      isActradeckEntry({
        type: "http",
        url: "http://127.0.0.1:9999/x",
        headers: { Authorization: "Bearer $MY_TOKEN" },
        allowedEnvVars: ["MY_TOKEN"],
      }),
    ).toBe(false);
  });

  it("ignores non-object / array / null headers (no literal match)", () => {
    expect(isActradeckEntry({ type: "http", url: OLD, headers: [HDR] })).toBe(false);
    expect(isActradeckEntry({ type: "http", url: OLD, headers: null })).toBe(false);
    expect(isActradeckEntry({ type: "http", url: OLD, headers: "x" })).toBe(false);
  });

  it("does NOT treat a string allowedEnvVars as containing the env var (no substring confusion)", () => {
    // 文字列 "ACTRADECK_HOOK_TOKEN" は配列でないため env 署名にならない。
    expect(
      isActradeckEntry({ type: "http", url: OLD, allowedEnvVars: "ACTRADECK_HOOK_TOKEN" }),
    ).toBe(false);
  });

  it("only matches the header as an own-property, not via the prototype chain", () => {
    // prototype に専用ヘッダを持つ headers は own-property でないため署名にしない。
    const headers = Object.create({ [HDR]: "x" }) as Record<string, unknown>;
    expect(isActradeckEntry({ type: "http", url: OLD, headers })).toBe(false);
  });

  it("does NOT match a token-less literal legacy entry (SEC-1 accepted residue boundary)", () => {
    // 空 token で配線され headers:{} になった marker 無し entry は署名を欠く → 回収対象外。
    // 漏洩面ゼロ (token 不在) ゆえ許容する境界を pin (実装が誤って url 等で拾い出さない)。
    expect(isActradeckEntry({ type: "http", url: OLD, headers: {} })).toBe(false);
    expect(isActradeckEntry({ type: "http", url: OLD })).toBe(false);
  });

  it("rejects non-object entries", () => {
    expect(isActradeckEntry(null)).toBe(false);
    expect(isActradeckEntry("x")).toBe(false);
    expect(isActradeckEntry(undefined)).toBe(false);
  });
});

describe("INV-ATTACH-SELF-HEAL: self-heal 後の再 merge は冪等", () => {
  // QA-5: 2 回目の merge は変化なし (wired=false) かつ backup を量産しない。
  it("second merge is a no-op (wired=false) and does not create extra backups", () => {
    const first = mergeAttachHooks(opts(NEW, ["SessionStart"]));
    expect(first.wired).toBe(true);
    const baksAfterFirst = readdirSync(dir).filter((f) => f.includes(".actradeck-bak-")).length;

    const second = mergeAttachHooks(opts(NEW, ["SessionStart"]));
    expect(second.wired).toBe(false); // 変化なし冪等
    const baksAfterSecond = readdirSync(dir).filter((f) => f.includes(".actradeck-bak-")).length;
    expect(baksAfterSecond).toBe(baksAfterFirst); // backup を増やさない
  });
});
