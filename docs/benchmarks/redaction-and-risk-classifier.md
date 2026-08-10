# Redaction & risk-classifier benchmark

ActraDeck redacts secrets _before_ they are persisted or sent, and classifies shell commands into
high-risk categories so a bypass/YOLO agent's most dangerous actions can still be held for human
approval. The README states plainly that detection is **"best-effort pattern matching — a strong
safety net, not an absolute guarantee."** This page backs that claim with a **reproducible,
synthetic benchmark** and reports the **actual measured numbers**.

> **Honesty first.** The corpus is synthetic (no real secrets — this is a redaction product, so we
> never commit real credentials). Numbers are measured, not asserted; run the command yourself and
> you will get the same figures (the redactor and classifier are pure functions and the corpus is
> fixed, so output is byte-stable across runs).

## Reproduce

```bash
pnpm --filter @actradeck/sidecar run bench:safety          # human-readable tables + JSON
pnpm --filter @actradeck/sidecar run bench:safety -- --json # JSON only (for tooling)
```

Source: `apps/sidecar/e2e/safety-bench/` (corpus + scoring harness) and
`docs/benchmarks/redaction-and-risk-classifier.md` (this page). The harness exercises the **real
production code** — `redactString` from `@actradeck/redaction` and `classifyCommandWithCategories`
from `apps/sidecar/src/normalize.ts` — with no mocks.

## Methodology

- **Ground truth is human-assigned.** For redaction, each positive vector declares the exact secret
  substring that MUST NOT survive; each negative declares a benign string that MUST be preserved.
  For the classifier, expected categories are labelled from the category _definitions_ (the intent
  documented on `PolicyCategory` in `packages/event-model/src/payload.ts`), **not** derived from the
  classifier's own output — otherwise precision/recall would be a tautological 100%.
- **Redaction recall = leak avoidance.** A positive counts as detected iff the raw secret substring
  is absent from the output — the security-relevant metric. A leak (the secret survives) is a
  false negative.
- **Redaction precision = over-redaction avoidance.** A negative counts as a false positive iff any
  `[REDACTED:…]` marker appears in the output (a benign string was masked). ActraDeck's product
  value is showing real paths / commands / correlation ids, so over-redaction destroys supervisory
  signal.
- **Classifier metrics** are standard multi-label precision/recall against the human category
  labels, plus a **gate-decision** outcome (would this command be held for approval under a given
  enabled-category policy?) and a risk-level exact-match accuracy.
- **Fixtures reuse existing test values.** Every fake secret is reused from the committed test
  suite so no new value trips GitHub Push Protection on publish. The corpus lives under the
  `apps/sidecar/e2e` tree, which the OSS secret scan exempts _by path_ (not by content marker), so
  the strict leak gate over the rest of the tree stays hole-free.

Corpus size: **38 redaction positives** across **29 kind families**, **28 hard negatives**, and
**53 classifier command vectors** (including shell-escape, multi-call binary, Git global-option,
Git shell-alias, and dynamic-executable adversarial forms).

## Results — redaction

Measured on 2026-08-06 against the T1 canonical redactor (`packages/redaction/src/redactor.ts`).

| Metric                                   | Value                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Overall recall (full secret caught)      | **100.0%** (38/38, 0 full leaks)                                         |
| Mask precision (masks that hit a secret) | **90.5%** (38/42 — the 4 extra masks are the safe over-redactions below) |
| Benign preservation (hard negatives)     | **85.7%** (24/28 preserved verbatim)                                     |
| Fragment survival (partial leaks)        | **0 vectors** (tail-hardened — see Fragment survival below)              |
| Kind families covered                    | 29                                                                       |

"Overall recall" is measured by **full-secret** substring survival — the exact metric a full-match
check gives. It is deliberately paired with the fragment-survival metric below, which catches
**partial** leaks that a full-match check reports as "detected."

**Per-kind recall: 100% for every one of the 29 families** — private-key, aws-access-key-id,
github-token, anthropic-key, openai-key, google-api-key, slack-token, stripe-key, gitlab-token,
sendgrid-key, huggingface-token, azure-ad-client-secret, databricks-token, doppler-token,
planetscale-token, flyio-token, slack-webhook, discord-webhook, jwt, basic-auth, bearer-token,
auth-header-scheme, auth-scheme-value, cookie, npm-auth-token, credential-assignment,
url-credential, high-entropy-secret, sentry-dsn.

**Four false positives (over-redaction, safe direction).** Three are the disclosed port-shape-gate
residuals of the @-less `url-credential` rule, measured on purpose (the corpus includes the shapes
the gate is known to over-redact): markdown-bold `**http://localhost:55400**.`, the version tag
`docker://alpine:3.19`, and the word placeholder `ws://host:port` — all masked as `url-credential`
(pinned residuals; the unified charset/gate redesign is tracked with a deadline). The fourth:
a `sess_<uuidv7>` correlation id passed as
**free text** to `redactString` is masked as `high-entropy-secret`. This is by design and worth
understanding: session-id preservation is **field-aware** — the redactor keeps `sess_<uuid>` only
when it appears as a top-level correlation-key field of a structured event (see
`isCorrelationKeyValue` / `CORRELATION_KEY_FIELDS` in the redactor). In free-form summary/stdout
text the same value looks like a high-entropy token and is masked. The failure direction is safe
(over-redaction, never a leak), so we report it honestly rather than hiding it behind a curated
100%.

## Fragment survival (partial leaks a full-match check misses)

A leak measured only by **full-secret** substring survival (`output.includes(secret)`) is blind to
**partial** survival: a redactor can mask the head of a secret while a long tail fragment survives,
and the full-match check still reports "detected." That is the same danger class as a straddle leak.
The benchmark therefore also measures **fragment survival**: any contiguous substring of the raw
secret of length **≥ 8** that survives in the output and is **not** explained by preserved
non-secret input (see `leakedFragmentSpan` in `bench.ts`).

> **Why "not explained by preserved input" matters.** A naive "any ≥8-char substring of the secret
> present in the output" over-counts. In this corpus the `discord-webhook` positive embeds the digit
> run `…0123456789…` inside its secret, while the URL prefix redaction legitimately **preserves**
> contains the public webhook id `…123456789012345678…`. The token itself is fully masked, yet an
> 8-char digit run coincides between the secret and the preserved public id. That is **not** a leak.
> So a fragment counts only if it appears in the output and does **not** appear in the input with the
> secret removed. This keeps the metric honest in both directions.

**Measured result: 0 fragment leaks across the 38 positives** (0 full leaks). This is the state
**after the tail-hardening fix** (`INV-REDACTION-TAIL-SURVIVAL`, task 019f5b5e-f9e9). Before the fix,
one vector leaked: a constructed long credential assignment (`HUGE_SECRET_BLOB=<9000-char value>`)
whose head the `credential-assignment` rule masked while its `MAX_VALUE_LEN` (4096)-bounded capture
left a **~4904-character contiguous tail** raw (the leftover run also exceeded the standalone
`high-entropy-secret` rule's old `{40,4096}` bound, so nothing re-anchored it). The full-substring
recall counted that vector as _detected_ (the full 9000-char string was absent because the head was
masked) — exactly the blind spot R4 flagged, which only the fragment-survival metric caught.

**The fix.** The redactor's arbitrary-length **value** captures (credential-assignment bare/quoted,
`auth-header-scheme`, `auth-scheme-value`, `npm-auth-token`, `url-credential` pass, and
`high-entropy-secret`) were unbounded from `{N,MAX_VALUE_LEN}` to a **single-character-class
unbounded quantifier** (`{1,}` / `{0,}` / `{40,}`). A lone greedy character-class scan has no nested
or alternating quantifier, so it stays **linear (ReDoS-safe)** — the measured `t(2n)/t(n)` scaling
ratios for every unbounded matching path are ≈ 2.0 (well under the 3.5 super-linear threshold; pinned
by `INV-REDACTION-REDOS-SCALING` in the redaction package). Values ≤ `MAX_VALUE_LEN` are byte-for-byte
identical (the bound was never reached), so recall/precision/negative-preservation are unchanged
(measured: identical to the pre-fix run). The previously-leaking `HUGE_SECRET_BLOB` vector is now
masked head-to-tail (surviving span 0) and is **retained as a regression guard**: re-bounding any
value capture makes the tail reappear and turns `INV-REDACTION-TAIL-SURVIVAL` and the fragment-survival
metric RED.

> The fragment metric itself is unchanged and still exercised: `inv-safety-bench-metric.test.ts` pins
> `leakedFragmentSpan` on synthetic masked/leaked/full-leak/coincidence inputs (so a metric regression
> — a broadened threshold or a dropped remainder-exclusion — still turns those assertions RED), plus
> the corpus-level assertion that fragment leaks total 0.

**Fixed, with pinned tests** (this PR is not measurement-only — it closes the residual in production):

- **REDACT-F2 (fragment leak, bounded-capture residual) — FIXED.** The long-credential tail above and
  the sibling rules that shared the identical bounded-value shape are all masked head-to-tail. The
  related full-leak residual — a **standalone** base64 run longer than 4096 chars with no vendor
  prefix / credential key / PEM or JWT marker — was the old `SEC-3` "scope 境界" source note; it is
  now closed by the unbounded `high-entropy-secret` `{40,}` and pinned by `INV-REDACTION-TAIL-SURVIVAL`
  (a new production test in the redaction package). See "Honest limitations" for what genuinely
  remains (a narrow, KB-scale quoted-value straddle and the PEM/JWT compensated fallbacks).

## Results — risk classifier

Measured against `classifyCommandWithCategories` (`apps/sidecar/src/normalize.ts`).
Classifier results below were regenerated on 2026-08-10.

**Scope.** This benchmarks the **command-pattern** categories the classifier derives from the
command string: `recursive-rm`, `disk-destroy`, `history-rewrite`, `db-drop`, `fork-bomb`,
`perm-change`, `inline-code`, `migrate-prod`, `high-risk-other`. The composite/context categories
`secret-egress`, `secret-file-edit`, and `external-tool` are decided in the approval-bridge from
the tool input (not from the command string alone) and are **out of scope** for this harness.

| Category          | Support | Precision | Recall     |
| ----------------- | ------- | --------- | ---------- |
| recursive-rm      | 9       | 100.0%    | 100.0%     |
| disk-destroy      | 4       | 80.0%     | 100.0%     |
| history-rewrite   | 7       | 100.0%    | 100.0%     |
| db-drop           | 3       | 75.0%     | 100.0%     |
| fork-bomb         | 1       | 100.0%    | 100.0%     |
| perm-change       | 3       | 100.0%    | 100.0%     |
| inline-code       | 5       | 100.0%    | 100.0%     |
| migrate-prod      | 2       | 50.0%     | 100.0%     |
| high-risk-other   | 1       | 100.0%    | 100.0%     |
| **micro-average** | 35      | **89.7%** | **100.0%** |

**Recall is 100% on every category** — nothing dangerous in the corpus slips past the classifier.
Precision is below 100% only where a keyword literal fires on a benign near-miss (below). This is
the deliberate design bias: **under-detection (a real destructive op sneaking through) is far worse
than over-gating (an extra approval prompt)**, so ambiguous cases fail toward "gate it."

### Gate-decision outcome (would the command be held for approval?)

| Policy                              | Precision | Recall | TP / FP / FN / TN |
| ----------------------------------- | --------- | ------ | ----------------- |
| default-gated (out-of-box)          | 93.5%     | 100.0% | 29 / 2 / 0 / 22   |
| strict-all (every category enabled) | 89.5%     | 100.0% | 34 / 4 / 0 / 15   |

- Risk-level exact-match accuracy: **88.7%**.
- Danger recall (vectors labelled non-`low` that the classifier flags non-`low`): **97.1%**.

Under the out-of-box `DEFAULT_GATED_CATEGORIES`, `inline-code` is **on by default** alongside the
catastrophic categories: interpreter-mediated operations are held even when the classifier cannot
prove the inner action's named category. `perm-change` and `migrate-prod` remain operator opt-ins;
their noisier keyword matches therefore do not affect default-gated precision.

### Divergences from human labels (findings / calibration notes)

The harness prints every divergence. All false positives are **safe-direction over-gates** driven
by whole-command keyword literals:

| Command                                 | Divergence               | Nature                                                                                                  |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `dd if=backup.iso of=restore.iso bs=4M` | predicted `disk-destroy` | `dd if=` literal fires even for a file-to-file copy (no block device). Intentional safe-side over-gate. |
| `grep -rn 'DROP TABLE' migrations/`     | predicted `db-drop`      | The literal `DROP TABLE` string appears in a _search_ argument. Keyword match, not intent.              |
| `echo 'see the production runbook'`     | predicted `migrate-prod` | `production` keyword in prose. Off by default.                                                          |
| `cat docs/migrate-guide.md`             | predicted `migrate-prod` | `migrate` keyword in a filename. Off by default.                                                        |

Risk-level calibration notes (not safety gaps):

- `psql -c 'DROP DATABASE prod'` classifies as risk `low` while the `db-drop` **category still
  fires** (so the gate still holds it). `DROP DATABASE` is intentionally a _category-only_ literal:
  it drives the approval gate without inflating the risk score. The safety outcome (held for
  approval under default policy) is correct; only the numeric risk label differs from a human's.
- `find … -exec rm {} ;` classifies as `medium` rather than `high`; it is still gated
  (`recursive-rm`).

## External corpus cross-evaluation (gitleaks)

The corpus above is authored by the same people who wrote the redactor, so its recall is
self-correlated (R4 finding B: no independent holdout). To cross-check against an **independent**
ground truth, `cross-eval.mts` measures our redactor against the secret-detection rules shipped by
[gitleaks](https://github.com/gitleaks/gitleaks) (MIT licensed) — a widely used, independently
maintained secret scanner.

**Method.** gitleaks ships its rules as regexes in `config/gitleaks.toml`. The harness fetches that
single file at a **pinned commit** at run time (gitleaks **v8.30.1**, commit
`83d9cd684c87d95d656c1458ef04895a7f1cbd8e`), verifies its integrity (git-blob object id
`256f6479…`, 97 731 bytes, and raw SHA-256 `e163e53b…` — all enforced, fail-loud on mismatch), and —
for a curated subset of gitleaks rules that map onto our redaction kinds — synthesizes a sample that
is a **valid instance of the gitleaks rule** (verified against the rule's own regex), then runs it
through our production `redactString`. The gitleaks file is **fetched, never vendored** into this
repo, and **no gitleaks secret value is printed** here or committed. The numbers below are from an
actual live fetch of the pinned file (measured 2026-07-13).

```bash
pnpm --filter @actradeck/sidecar run bench:cross-eval   # opt-in; network-dependent; NOT run in CI
```

**Result: we mask 10 of 17 mapped gitleaks rules (58.8%) on their _minimal valid instance_.** Samples
are synthesized as the shortest legal instance (first alternation branch, minimum repetition), which
is a deliberately harsh setting — several "misses" are cases where gitleaks' regex accepts a shorter
or looser string than a real secret, and a **realistic** instance _does_ mask (verified below, with
the marker kind our redactor emits — never the value).

| gitleaks rule            | our kind          | min-instance result    | triage                                                                                               |
| ------------------------ | ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| github-pat               | github-token      | ✅ github-token        | —                                                                                                    |
| github-fine-grained-pat  | github-token      | ✅ github-token        | —                                                                                                    |
| slack-bot-token          | slack-token       | ✅ slack-token         | —                                                                                                    |
| slack-webhook-url        | slack-webhook     | ✅ high-entropy-secret | masked via a different kind (gitleaks' new `services/<43–56>` shape, no `T…/B…/` segments)           |
| npm-access-token         | npm-auth-token    | ✅ high-entropy-secret | masked via the high-entropy fallback rather than the labelled npm rule                               |
| huggingface-access-token | huggingface-token | ✅ huggingface-token   | —                                                                                                    |
| databricks-api-token     | databricks-token  | ✅ databricks-token    | —                                                                                                    |
| doppler-api-token        | doppler-token     | ✅ doppler-token       | —                                                                                                    |
| flyio-access-token       | flyio-token       | ✅ flyio-token         | —                                                                                                    |
| openai-api-key           | openai-key        | ✅ openai-key          | —                                                                                                    |
| aws-access-token         | aws-access-key-id | ❌ missed              | **gap**: first-branch `A3T` prefix; we cover `AKIA/ASIA/AROA/AIDA` but not `A3T/ABIA/ACCA`           |
| stripe-access-token      | stripe-key        | ❌ missed              | **gap**: gitleaks accepts `{10,99}`; our rule requires `{16,}` — a ≥16-char key masks                |
| planetscale-password     | planetscale-token | ❌ missed              | **gap**: `pscale_pw_` prefix (we model `pscale_tkn_/oauth_`); a long alnum pw masks via high-entropy |
| gitlab-pat               | gitlab-token      | ❌ missed              | **artifact**: synth tail ends in `-`; a `glpat-`+20-alnum instance masks as gitlab-token             |
| sendgrid-api-token       | sendgrid-key      | ❌ missed              | **artifact**: gitleaks' loose `SG.{66}` class; a real `SG.<22>.<43>` key masks as sendgrid-key       |
| jwt                      | jwt               | ❌ missed              | **artifact**: gitleaks' `ey`+alnum minimal instance; a real `eyJ…` JWT masks as jwt                  |
| private-key              | private-key       | ❌ missed              | **artifact**: gitleaks permits a missing space after `BEGIN`; a real PEM masks as private-key        |

**Triage (verified with realistic instances against the real redactor):** of the 7 misses, **4 are
synthesis-minimality/looseness artifacts** — gitlab, sendgrid, jwt, and private-key all mask once the
sample is a realistic secret rather than gitleaks' loosest legal string. **3 are genuine (narrow)
coverage gaps** worth noting: the AWS `A3T/ABIA/ACCA` key prefixes, the PlanetScale `pscale_pw_`
prefix (though a sufficiently long alphanumeric password is still caught by the high-entropy
fallback), and Stripe keys shorter than 16 characters.

**Fair-conditions disclosure.**

- **Different scope.** gitleaks is an **at-rest git-history scanner**; ActraDeck is a **streaming
  text redactor**. They overlap on inline token _shapes_ but not on operating model, so this is a
  shape-recall comparison on a mappable subset, not a like-for-like tool benchmark.
- **Mappable subset only.** gitleaks ships 170+ rules; the 17 above are the ones whose secret shape
  maps onto a kind we model. The rest (vendor-specific tokens we do not target) are **out of scope**
  and are not counted against recall — the claim is deliberately limited to "on the mappable
  subset, we mask this fraction of gitleaks' shapes."
- **Minimal-instance harshness.** The synthesized sample is the shortest legal instance, so misses
  driven by looseness in gitleaks' own regex (private-key without a space, `ey` without the `J`,
  Stripe below 16 chars) count against the raw number; the triage column separates these from real
  gaps. Misses are described by **rule name and shape only — never by value**.
- **Pinned point-in-time.** Numbers are for gitleaks v8.30.1 (of 221 rules parsed, 204 are outside
  our modelled kinds and 17 are mapped). gitleaks is feature-complete, so its ruleset changes
  rarely, but a different pin can shift the mapping. The step-by-step re-pin procedure (new SHA → 3
  checksums → MAPPING diff → re-measure) is documented in the `## Updating the pin` block at the top
  of `apps/sidecar/e2e/safety-bench/cross-eval.mts`.

## Honest limitations

- **Synthetic corpus.** These numbers characterize the detectors against curated vectors, not a
  representative sample of real-world traffic. 100% recall means "no vector in this corpus leaked,"
  not "no secret can ever leak."
- **Inline detection only.** Both the redactor and the `secret-egress` composite detect secrets
  present **inline** in the text/command. File-reference exfiltration (`curl --data @.env`,
  `scp .env host:`) carries no inline secret and is out of reach of pattern matching — the same
  limitation gitleaks-style tools share.
- **Bounded-value tail residuals — now FIXED and test-pinned.** All the arbitrary-length value
  captures — the over-long credential tail (bare **and** quoted), the sibling rules
  `auth-header-scheme`, `auth-scheme-value`, `npm-auth-token` (bare **and** quoted), `url-credential`
  (user **and** pass, both the `scheme://` and bare `user:pass@host` forms), and the standalone
  `>4096`-char base64 run (the old `SEC-3` "scope 境界" note) — masked only up to `MAX_VALUE_LEN` and
  left the remainder raw (bare) or full-leaked (quoted / url, closing delimiter beyond the cap). They
  are now **unbounded** (single-character-class `{N,}`, linear/ReDoS-safe) and pinned by the new
  production test `INV-REDACTION-TAIL-SURVIVAL`, which falsifies **each capture individually** with
  backstop-free (≤2-char-class) vectors — reverting any single capture to bounded turns exactly its
  own case RED (per-rule mutation log in the PR report). A full-secret recall of "100%" plus 0
  fragment leaks is still scoped to this corpus; it is not a claim that no secret can ever leak.
- **What genuinely remains (honest residuals).**
  - **Compensated straddle fallbacks (PEM / JWT).** A PEM private key or a long JWT whose closing
    terminator (`-----END … PRIVATE KEY-----` / the 2nd `.` + signature) falls outside the ~264 KB
    pre-redact window is masked by a dedicated bounded-greedy **fallback branch** in those two rules
    (pinned by `INV-REDACTION-PEM-STRADDLE` / `INV-REDACTION-JWT-STRADDLE`). This is a compensation,
    not a leak, but it is a distinct mechanism from the general value captures and worth naming.
  - **Unterminated / newline-split quoted credential values — closed for credential-assignment
    (SEC-1, landed 2026-07 via full re-audit).** The quoted/bare rules capture `[^"\r\n]` /
    `[^'\r\n]` / `[^\s"',;]`, so their value stops at a newline or an absent closing quote; a
    **raw-text** (string-path) credential whose quote is **not closed** (`password="abc123…`) or
    whose value is **split across newlines** (`password="line1\nline2"`) previously failed all
    three rules and was **not masked at all** (measured for short ~50-char, multi-line, and
    low-entropy `<3-char-class` values alike). A **4th `credential-assignment` fallback** now
    detects keyword + `[:=]` + opening quote and masks via branch1 (cross-newline lazy to the
    in-window closing quote) / branch2 (unterminated → EOL); `_authToken` covers unterminated
    quoted npm tokens by keyword overlap. Pinned by `INV-REDACTION-QUOTED-CRED-UNTERMINATED`
    (falsifiable RED-before). The **object path was already safe** (`isCredentialKey` masks a
    credential **key**'s whole value regardless of quoting/newlines).
    - **Closure update (task `019f5ca4`).** A structural scanner now closes the previously
      disclosed residuals: truly multi-line unterminated / `>PRE_REDACT_SLICE` newline-split
      values are greedily masked to the window end (with a ` [REDACT-SWALLOWED:n]` length hint),
      and a closing quote immediately preceded by another credential opener is rejected as a
      terminator (merge/A1, single-line and multi-line). The missing-`@host` `url-credential`
      class is closed by an @-less rule with a port-shape gate and RFC-3986 capture charsets.
    - **Remaining honest residuals (pinned by tests).** (a) The scanner is quote-anchored:
      YAML block scalars (`password: |`), backticks, bare newline-split values and heredocs
      are out of scope. (b) A multi-line value closes at the first non-suspicious same-type
      quote; content after that structural close is outside the string. (c) @-less URL
      passwords of 1-5 pure digits (port-indistinguishable) or digits followed by a structural
      delimiter are kept. A pass containing a structural delimiter (`/ ? #`) is masked up to
      that delimiter (marker present, tail raw); a pass containing any other URL-illegal
      character (`{ } | ^ < > " ] [` etc.) makes the match be abandoned entirely — no marker,
      fully raw (the unified charset/gate redesign is tracked with a deadline). In the
      over-redaction direction, non-digit port positions (word tags/placeholders) and valid
      ports followed by symbols outside the gate terminator set are masked; all pinned by
      tests. (d) The unterminated-opener greedy swallow trades
      observability for containment: one unterminated credential opener swallows the rest of
      the field (disclosed via the length hint).
  - The benchmark **measures** partial survival directly (fragment-survival metric) rather than only
    asserting it — the upgrade R4 asked for — and now reports 0.
- **Remainder-aware exclusion can hide a _true_ partial leak (false-negative direction).** The
  fragment metric ignores a surviving fragment that also appears in the input with the secret
  removed, to avoid alarming on coincidences with preserved benign text (the `discord-webhook`
  digit-run example). If a real secret fragment happened to coincide with preserved public text, it
  would be suppressed. This trades a false-positive risk for a false-negative one; it is the safe
  direction for a "does over-redaction destroy signal" benchmark, but it is a genuine limit. On the
  current corpus, zero true leaks are suppressed (every positive was checked by hand).
- **Bounded adversarial coverage, not a shell proof.** The command corpus now mixes canonical forms
  with shell-escaped executables, BusyBox/Toybox applets, Git global options and shell aliases, and
  dynamic executable expansion. It is still finite. An interpreter-mediated equivalent (for
  example, `perl -e 'unlink glob "*"'`) may carry only the default-ON `inline-code` category and miss
  the more specific `recursive-rm` label. The measured 100% recall applies to this committed corpus,
  not every program or shell grammar.
- **Best-effort, by construction.** New vendor token formats appear constantly; the rule set is
  maintained, not exhaustive. The classifier's category keywords are a denylist-plus-structural
  hybrid, not a complete grammar of dangerous shell. Treat both as a strong safety net layered on
  top of the agent's own permissions, never as the sole control.

## Relationship to the invariant tests

This benchmark is a **measurement**, not a security gate. The hard guarantees live in the
`INV-REDACTION-*` and classifier invariant tests (`packages/redaction/test/`, `apps/sidecar/test/`),
which fail CI on regression. The benchmark corpus is deliberately separate so that adding measurement
vectors never weakens a security invariant, and so the published numbers can be regenerated on demand.

**The published numbers on this page cannot silently rot.** `INV-SAFETY-BENCH-PUBLISHED`
(`apps/sidecar/test/inv-safety-bench-published.test.ts`) runs the live bench (`scoreRedaction` /
`scoreClassifier` over the real redactor + classifier) and asserts every figure above — recall,
mask precision, benign preservation, the per-category and gate-decision tables, risk-level accuracy,
and danger recall — against a single source of truth, then asserts this markdown **prints those same
numbers**. A code change that moves a number fails the bench-side check; an edit that drifts the doc
away from the numbers fails the doc-side check. This gates DOC HONESTY (not code behaviour): if a
number legitimately changes, you update the constant and the doc together and the test passes again.
The corpus-completeness (`INV-SAFETY-BENCH-KINDS`) and fragment-metric (`INV-SAFETY-BENCH-METRIC`)
guards remain. The gitleaks cross-evaluation (58.8%) is intentionally outside this guard because it
is network-dependent and not run in CI.
