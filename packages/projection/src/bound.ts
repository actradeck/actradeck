/**
 * 表示用有界化の leaf module (依存ゼロ・A1 TDA-4).
 *
 * `boundTurnSummary` は session_state reducer (index.ts) と work-items fold (work-items.ts) の
 * **両方**が使う。work-items.ts が index.ts から import すると index ↔ work-items の 2 ノード循環
 * (index.ts は fold の再 export 元) になるため、共有点をこの leaf へ置き循環を断つ。
 * 実装・docstring は index.ts から移設 (意味変更なし)。
 */

/**
 * turn 依頼/応答要約の **表示用有界化上限** (SEC-1・CONDITIONAL 019f47f0 unblock).
 *
 * gemini adapter は truncate-before-redact straddle leak を避けるため prompt/response を **小 cap で
 * 切詰めず**、床 (ingress redaction) が secret 全体を見てから redact する (adapter § SUMMARY_SANITY_CAP)。
 * その結果 `payload.prompt_summary` / `response_summary` は **redacted だが有界でない**まま at-rest に載る。
 * 表示 subject (current_action_subject / replay DTO subject) の有界化は **床の後 (redacted 値に対して)**
 * ここで行う: NormalizedEvent.payload は `parseEvent` が looseObject passthrough する (payload の zod
 * discriminated union は再パースしない) ため schema の `.transform` は走らず、**共有 boundTurnSummary が
 * 唯一の post-floor bound 実装点**になる (subject は deriveActionSubject の turn.* 分岐、turn DTO の
 * summary/display_text 搬送は replay-store が同一関数を通す。INV-REDACTION-SUMMARY-STRADDLE (D) が
 * bound を回帰固定)。
 *
 * 値は既に redacted ゆえ任意位置の slice で raw secret が現れることはない (slice は文字を **除くだけ**で
 * raw を新たに導入しない・この bound 自体の安全性は不変)。redaction マーカーの途中で切れて多少見栄えが
 * 崩れても安全側 (raw は載らない)。
 *
 * ## scope の正直な開示 (SEC-2): 「床が全 secret を redact 済」は token 系 + PEM 双方で成立
 * 本 bound の安全性は「入力値が床で redacted 済」を前提に成る。この前提は bounded 捕捉長の token 系
 * ルールに加え、**private-key (PEM) も境界跨ぎを含め成立する** (SEC-2 解消・ADR 019f482a /
 * task 019f482c-0904)。redactor の private-key ルールは terminator (`-----END ... PRIVATE KEY-----`) が
 * pre-redact window 外へ落ちても head→window 末尾を greedy にマスクする fallback を内包し、
 * MAX_REDACT_INPUT 境界を跨ぐ巨大単一行/複数行 PEM でも raw partial を残さない
 * (INV-REDACTION-PEM-STRADDLE が redactor 単体 + real PG で回帰固定)。加えて本 slice は redacted 値から
 * 文字を **除くだけ**で raw を新たに導入しないため、bound 自体は二重に安全である。gemini adapter は
 * sanity 上限のみで secret を分割しないため、adapter 起因の straddle leak は無い (adapter § SUMMARY_SANITY_CAP)。
 */
export const SUMMARY_SUBJECT_CAP = 200;

/**
 * redacted な turn 要約を表示用に post-floor で有界化する (SEC-1)。cap 超過は ellipsis を付す。
 *
 * export する唯一の bound 実装点 (単一出所): subject 導出 (deriveActionSubject の turn.* 分岐) に
 * 加え、backend replay-store が turn.started/completed の DTO `summary` / `display_text` 搬送を同じ
 * 関数で有界化する (gemini-obs SEC-3=TDA-3: adapter は uncapped 送出ゆえ at-rest の redacted summary は
 * 有界でない。DTO 搬送だけ post-floor で bound し、unbounded 値を webui へ運ばない)。入力は必ず
 * redaction 床の後の値であること (redact→truncate 順・slice は raw を新規導入しない)。
 */
export function boundTurnSummary(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > SUMMARY_SUBJECT_CAP ? s.slice(0, SUMMARY_SUBJECT_CAP) + "…" : s;
}
