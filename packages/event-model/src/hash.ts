/**
 * Isomorphic な同期 SHA-256 (ADR 0015・T1 正典).
 *
 * ## なぜ自前実装か (Node 依存を増やさない・isomorphic 制約)
 * work-item id (`deriveWorkItemId`) / tree fingerprint (`treeFingerprint`) は
 * **projection の純 fold の中で同期的に**算出され、その fold は backend (Node) と webui
 * (browser・`"use client"` replay-state.ts が `reduceEvents` を呼ぶのと同じ経路) の**両方**で走る。
 * `node:crypto` は browser bundle で解決できず、Web Crypto (`crypto.subtle.digest`) は **async** ゆえ
 * 同期 fold に載せられない。event-model は既に node: 依存ゼロの isomorphic package (path-scope.ts 参照)
 * ゆえ、その規律を保つため依存を足さず、`TextEncoder` (Node18+/browser 共通) の上に純 TS の
 * SHA-256 を単一出所として置く。
 *
 * ## 正当性
 * 標準 FIPS 180-4 の SHA-256。NIST 既知応答ベクタ ("" / "abc" / 2-block) を INV-WORKITEM-ID が
 * 回帰固定する。用途は content-addressing (dedup 目的の同一性) であり認証用途ではないが、実装は標準準拠。
 * 入力文字列は UTF-8 でバイト化してから処理する (git-watcher の `sha256(status ∥ \0 ∥ diff)` と同じ
 * NUL 連結規約に整合)。UTF-8 エンコードは lib=ES2023 だけで型付くよう自前実装し (`TextEncoder` は
 * DOM/node lib 依存)、event-model の isomorphic + 依存ゼロ規律を保つ。
 *
 * ## sha256 実装は意図的に 2 面 (A1 SEC-2≡TDA-2・naive な一本化禁止)
 * Node 専用 tier の `apps/backend/src/audit-integrity.ts` (`sha256Hex`) は perf のため `node:crypto`
 * を維持する。browser を含む fold 経路だけが本 pure-TS 実装を使う。どちらかへ一本化すると
 * isomorphic 制約 (browser で node:crypto 不可) か Node perf のどちらかを壊すため、境界を跨いだ
 * 統合をしないこと (相互参照コメントあり)。
 */

/**
 * 文字列を UTF-8 バイト列へ (surrogate pair 対応・lone surrogate は U+FFFD)。
 * `TextEncoder` (DOM/node グローバル) に依存せず ES2023 lib のみで型が付く。
 */
function utf8Bytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      } else {
        bytes.push(0xef, 0xbf, 0xbd); // lone high surrogate → replacement char
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes.push(0xef, 0xbf, 0xbd); // lone low surrogate → replacement char
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

/** SHA-256 ラウンド定数 (FIPS 180-4 §4.2.2)。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 32-bit 右ローテート。 */
function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 入力文字列の SHA-256 を lowercase hex (64 文字) で返す。UTF-8 でバイト化してから処理する。 */
export function sha256Hex(input: string): string {
  const msg = utf8Bytes(input);
  const l = msg.length;

  // padding: msg + 0x80 + zeros + 64-bit big-endian bit-length を 64 バイト境界へ。
  const padded = new Uint8Array((((l + 8) >> 6) + 1) * 64);
  padded.set(msg);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  // bit 長 (l*8) の上位/下位 32-bit を big-endian で末尾 8 バイトへ。
  const bitLenHi = Math.floor(l / 0x20000000) >>> 0; // = floor(l*8 / 2^32)
  const bitLenLo = (l * 8) >>> 0;
  dv.setUint32(padded.length - 8, bitLenHi, false);
  dv.setUint32(padded.length - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(7, w15) ^ rotr(18, w15) ^ (w15 >>> 3);
      const s1 = rotr(17, w2) ^ rotr(19, w2) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}
