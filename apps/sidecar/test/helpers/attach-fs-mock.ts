/**
 * `node:fs` を素通しで包む mock の factory (test only・TDA-STA-7 ≡ TDA-TD-3)。
 *
 * attach の fs 注入 INV (inv-attach-deny-cleanup-fs / inv-attach-teardown-fs) が同じ形を別々に書いていた。
 * `vi.mock("node:fs", async (importOriginal) => wrapNodeFs(await importOriginal(), hook))` の形で使う。
 * この file は **node:fs を import しない** (mock の factory の中から読むので、import すると自分自身の
 * mock を待つことになる)。
 *
 * - `before(name, args)`: 関数の呼び出し前に呼ぶ (throw すればその呼び出しが失敗する = 注入)。
 * - `after(name, args, out, orig)`: 呼び出しが返った後に呼ぶ (読み取りの直後の書き換え等)。
 * 素通しの関数は名前つきで export と `default` の両方に置く (named import と default import のどちらも包む)。
 */
export interface NodeFsHook {
  before?(name: string, args: readonly unknown[]): void;
  after?(name: string, args: readonly unknown[], out: unknown, orig: Record<string, unknown>): void;
}

/** errno つきの Error (注入した失敗)。 */
export function injectedErrno(code: string): Error {
  return Object.assign(new Error(`${code} (injected)`), { code });
}

export function wrapNodeFs<T extends object>(orig: T, hook: NodeFsHook): T {
  const source = orig as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "function" || name === "default") {
      wrapped[name] = value;
      continue;
    }
    const fn = value as (...a: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      hook.before?.(name, args);
      const out = fn(...args);
      hook.after?.(name, args, out, source);
      return out;
    };
  }
  return { ...wrapped, default: wrapped } as T;
}
