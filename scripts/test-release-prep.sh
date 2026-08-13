#!/usr/bin/env bash
#
# test-release-prep.sh — falsifiability meta-tests for the release / supply-chain gate
# (ADR 0013 / decision 019f2bc1). Each invariant is asserted GREEN on the real tree,
# then a controlled mutation is injected and the gate is asserted RED. A gate that
# cannot be made to fail is dead.
#
# Conventions (mirrors scripts/test-oss-prep.sh): capture command output with
# out="$(cmd)" and match with printf '%s' "$out" | grep, NEVER `heavy | grep -q` (the
# pipefail x SIGPIPE inversion makes the latter a false PASS on match).
#
# This script SHIPS in the public mirror (release.yml / version.sh / sbom.sh are public
# infra). It self-adapts: the tarball leak test builds a mirror via scripts/prepare-oss.sh
# when that private tooling is present, and otherwise scans `git archive HEAD` directly
# (the mirror tree is already sanitized). Injection vectors use `/home/tester/` — NOT the
# maintainer path — so the shipped file itself carries no coupling/secret literal.
#
# QA-4 caveat: INV-TARBALL-NO-LEAK assumes the git origin is a GitHub remote. With a
# local-path origin (e.g. file:// clone), prepare-oss's private-repo-ref rewrite/scan is a
# no-op, so a would-be private ref would go unrewritten — but the gate errs fail-closed
# (a spurious RED at most, never a spurious PASS), so the assumption is safe-side.
#
# Usage: ./scripts/test-release-prep.sh   (exit 0 = all PASS / exit 1 = a gate is dead)
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF/.." && pwd)"
fail=0
ok() { printf 'PASS  %s\n' "$1"; }
ng() { printf 'FAIL  %s\n' "$1"; fail=1; }

# shellcheck source=lib/sbom.sh
. "$SELF/lib/sbom.sh"

WORK="$(mktemp -d /tmp/release-prep-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null 2>&1 || { ng "jq is required for the release-prep tests"; exit 1; }

# ============================================================================
# Shared GitHub-Actions `if:` parser/evaluator (single source — R4-M1b/L6)
# ============================================================================
# Written to ONE file and used in two modes so the lexer/parser is not duplicated:
#   if_gate_check_str <expr>  -> mode=validate : closed-enum + &&-tag-guard + 4-context matrix.
#                                Used to VALIDATE the CANONICAL_IF constant and as the parser
#                                unit test (INV-IF-GATE-PARSER).
#   if_ast_repr <expr>        -> mode=repr     : deterministic AST serialization, for the
#                                CANONICAL_IF exact-match pin (INV-GHCR-PUBLISH-GATED).
IF_GATE_PY="$WORK/if_gate.py"
cat > "$IF_GATE_PY" <<'PYEOF'
import sys

class Tok:
    def __init__(s, k, v): s.k, s.v = k, v
def lex(x):
    i, n, out = 0, len(x), []
    while i < n:
        c = x[i]
        if c.isspace(): i += 1; continue
        if c == "'":
            j = i + 1; buf = []
            while j < n and x[j] != "'": buf.append(x[j]); j += 1
            out.append(Tok("str", "".join(buf))); i = j + 1; continue
        for op in ("&&", "||", "==", "!="):
            if x.startswith(op, i): out.append(Tok("op", op)); i += 2; break
        else:
            if c in "()!,": out.append(Tok(c, c)); i += 1; continue
            j = i
            while j < n and (x[j].isalnum() or x[j] in "._-"): j += 1
            if j == i: print("lex error at", x[i:]); sys.exit(1)
            out.append(Tok("id", x[i:j])); i = j
    out.append(Tok("eof", None)); return out
class P:
    def __init__(s, t): s.t, s.i = t, 0
    def pk(s): return s.t[s.i]
    def eat(s, k=None):
        tk = s.t[s.i]
        if k and tk.k != k and not (k == "op" and tk.k == "op"): print("parse err want", k, "got", tk.k); sys.exit(1)
        s.i += 1; return tk
    def orr(s):
        a = s.andd()
        while s.pk().k == "op" and s.pk().v == "||": s.eat(); a = ("||", a, s.andd())
        return a
    def andd(s):
        a = s.eq()
        while s.pk().k == "op" and s.pk().v == "&&": s.eat(); a = ("&&", a, s.eq())
        return a
    def eq(s):
        a = s.un()
        if s.pk().k == "op" and s.pk().v in ("==", "!="): o = s.eat().v; a = (o, a, s.un())
        return a
    def un(s):
        if s.pk().k == "!": s.eat(); return ("!", s.un())
        return s.prim()
    def prim(s):
        tk = s.pk()
        if tk.k == "(":
            s.eat(); e = s.orr(); s.eat(")"); return e
        if tk.k == "str": s.eat(); return ("lit", tk.v)
        if tk.k == "id":
            s.eat()
            if s.pk().k == "(":
                s.eat("("); args = []
                if s.pk().k != ")":
                    args.append(s.orr())
                    while s.pk().k == ",": s.eat(); args.append(s.orr())
                s.eat(")"); return ("call", tk.v, args)
            return ("ctx", tk.v)
        print("parse err at", tk.k, tk.v); sys.exit(1)
def parse(cond):
    try:
        p = P(lex(cond))
        ast = p.orr()
        # R5-L1: require ALL tokens consumed. Without this, a trailing token after a complete
        # expression is silently DROPPED (`<canonical> foo` would parse to <canonical> and match
        # the pin / validate). Non-exploitable (juxtaposition is a GHA syntax error, operator
        # continuations already parse/RED), but parser soundness: reject leftover tokens.
        if p.pk().k != "eof":
            print("trailing token(s) after expression:", p.pk().v); sys.exit(1)
        return ast
    except SystemExit: raise
    except Exception as e:
        print("could not parse if:", e); sys.exit(1)

# closed-enum allowlist: every context ref must be a gate input; string literals only as
# comparison/function operands (no bare-literal boolean like `|| 'false'`).
# Two opt-in toggles are permitted: ENABLE_GHCR_PUBLISH (docker job) and ENABLE_NPM_PUBLISH
# (npm job, decision 019f5131). Both are known publish gates; the exact AST pin per job still
# catches any real deviation in release.yml, so widening the enum by one sibling toggle does
# not weaken either gate.
ALLOWED_CTX = {"github.ref", "github.event_name", "vars.ENABLE_GHCR_PUBLISH", "vars.ENABLE_NPM_PUBLISH", "true", "false"}
def check_closed_enum(node, parent):
    t = node[0]
    if t == "ctx":
        if node[1] not in ALLOWED_CTX:
            print(f"context '{node[1]}' is outside the closed enum {sorted(ALLOWED_CTX)}"); sys.exit(1)
    elif t == "lit":
        if parent not in ("==", "!=", "call"):
            print(f"bare string literal '{node[1]}' used as a boolean operand (not a comparison/arg)"); sys.exit(1)
    elif t == "call":
        for a in node[2]: check_closed_enum(a, "call")
    elif t in ("==", "!="):
        check_closed_enum(node[1], t); check_closed_enum(node[2], t)
    elif t in ("&&", "||"):
        check_closed_enum(node[1], t); check_closed_enum(node[2], t)
    elif t == "!":
        check_closed_enum(node[1], t)
    else:
        print("unexpected node in closed-enum walk:", t); sys.exit(1)

def truth(v):
    # GitHub coercion: a NON-EMPTY string is truthy (incl. the string 'false').
    if isinstance(v, bool): return v
    if v is None: return False
    return str(v) != ""
def ev(node, ctx):
    t = node[0]
    if t == "lit": return node[1]
    if t == "ctx":
        name = node[1]
        if name == "true": return True
        if name == "false": return False
        return ctx.get(name, "")
    if t == "!": return not truth(ev(node[1], ctx))
    if t == "==": return str(ev(node[1], ctx)) == str(ev(node[2], ctx))
    if t == "!=": return str(ev(node[1], ctx)) != str(ev(node[2], ctx))
    if t == "&&":
        l = ev(node[1], ctx); return ev(node[2], ctx) if truth(l) else l
    if t == "||":
        l = ev(node[1], ctx); return l if truth(l) else ev(node[2], ctx)
    if t == "call":
        fn, args = node[1], [ev(a, ctx) for a in node[2]]
        if fn == "startsWith": return str(args[0]).startswith(str(args[1]))
        if fn == "endsWith":   return str(args[0]).endswith(str(args[1]))
        if fn == "contains":   return str(args[1]) in str(args[0])
        print("unknown fn", fn); sys.exit(1)
    print("bad node", t); sys.exit(1)
def refs_github_ref(node):
    if node[0] == "ctx": return node[1] == "github.ref"
    if node[0] == "lit": return False
    return any(refs_github_ref(c) for c in node[1:] if isinstance(c, tuple)) or \
        (node[0] == "call" and any(refs_github_ref(a) for a in node[2]))
def flatten_and(node):
    if node[0] == "&&": return flatten_and(node[1]) + flatten_and(node[2])
    return [node]

def validate(cond):
    if not cond.strip(): print("empty `if:` expression"); sys.exit(1)
    ast = parse(cond)
    check_closed_enum(ast, None)
    if ast[0] != "&&":
        print("top-level `if:` operator is not && (tag guard not ANDed):", ast[0]); sys.exit(1)
    if not any(refs_github_ref(c) for c in flatten_and(ast)):
        print("no github.ref (tag) guard among top-level conjuncts"); sys.exit(1)
    TAG = "refs/tags/v1.2.3"; BR = "refs/heads/main"
    # Each row sets BOTH opt-in toggles to the SAME value, so a canonical that references either
    # ENABLE_GHCR_PUBLISH (docker) or ENABLE_NPM_PUBLISH (npm) evaluates identically — the matrix
    # validates each single-toggle gate without a per-job branch.
    matrix = [
        ({"github.ref": TAG, "github.event_name": "workflow_dispatch", "vars.ENABLE_GHCR_PUBLISH": "",     "vars.ENABLE_NPM_PUBLISH": ""},     True,  "tag+dispatch"),
        ({"github.ref": TAG, "github.event_name": "push",              "vars.ENABLE_GHCR_PUBLISH": "true", "vars.ENABLE_NPM_PUBLISH": "true"}, True,  "tag+push+var"),
        ({"github.ref": TAG, "github.event_name": "push",              "vars.ENABLE_GHCR_PUBLISH": "",     "vars.ENABLE_NPM_PUBLISH": ""},     False, "tag+push+novar"),
        ({"github.ref": BR,  "github.event_name": "workflow_dispatch", "vars.ENABLE_GHCR_PUBLISH": "",     "vars.ENABLE_NPM_PUBLISH": ""},     False, "nontag+dispatch"),
    ]
    for ctx, want, label in matrix:
        if truth(ev(ast, ctx)) != want:
            print(f"context {label}: expected {want}"); sys.exit(1)

mode = sys.argv[1]; cond = sys.argv[2]
if mode == "validate":
    validate(cond); sys.exit(0)
elif mode == "repr":
    if not cond.strip(): print("empty `if:` expression"); sys.exit(1)
    print(repr(parse(cond))); sys.exit(0)
else:
    print("unknown mode", mode); sys.exit(2)
PYEOF
if_gate_check_str() { python3 "$IF_GATE_PY" validate "$1"; }
if_ast_repr()       { python3 "$IF_GATE_PY" repr "$1"; }

# ============================================================================
# Shared docker-job STEP predicates (single source — R5-M1 / TDA-R5-1)
# ============================================================================
# is_scan / is_guard / is_push / enabled / cont_on_err were drifting across THREE python
# programs (docker_publish_guard_run, docker_scan_before_push, the step mutator). The guard
# checker had simply FORGOTTEN the neuter checks (enabled / cont_on_err) its sibling scan
# checker already had (SEC-R5-1 ≡ QA-R5-1). Defining them ONCE here and importing everywhere
# closes both the guard hole and the 3-program drift. Consumers add SP_DIR to sys.path and
# `import step_predicates as sp` (SP_DIR is exported below; inherited by every python3 call).
SP_DIR="$WORK"; export SP_DIR
cat > "$WORK/step_predicates.py" <<'PYEOF'
# Canonical docker-job step predicates. Imported by the guard checker, the scan checker, and
# the step mutator so their classification + neutralization rules can never drift apart.
import re
def name(s): return str(s.get("name", ""))
def is_scan(s):
    n = name(s).lower(); return "scan" in n and "leak" in n
def is_guard(s):
    n = name(s).lower(); return "publish" in n and "guard" in n
# SINGLE SOURCE (SEC-R2 / QA-R2): a `docker buildx build …` invocation that PUBLISHES to a registry.
# Both the scan checker (per-arch coverage) and the push mutator import this, so they cannot drift on
# what counts as a buildx publish (the mutator used to keep a private copy — TDA-R1). Recognized forms:
#   `--push`                       (the canonical multi-arch manifest-list push), OR
#   `--output type=registry`       (equivalent — writes the manifest list straight to the registry),
#   `--output=type=registry`, `-o type=registry`, `-o=type=registry`, the pflag-FUSED short form
#   `-otype=registry` (SEC-R3-1), or an `--output …,push=true`.
# HONEST SCOPE: "recognizes MORE publish steps == fail-closed" holds only within the spellings enumerated
# here — a publish step written in a form this predicate does NOT match (an exotic publisher like
# skopeo/crane, or an `--output` variant not covered) is unrecognized and falls through to "no push
# step" -> a spurious RED, never a silent pass (a tracked sweep item). So it is NOT an unconditional
# "no mixed publish step can hide"; a step whose publish flag IS one of these spellings can't hide.
def buildx_publishes(run):
    if "docker buildx build" not in run:
        return False
    if "--push" in run:
        return True
    # SEC-R3-1: `-o` is a pflag short option, so `-otype=registry` (value FUSED with no separator) is a
    # legitimate spelling of `-o type=registry`. The old `-o[=\s]` required a separator and under-matched
    # the fused form. Cover: `--output[=]<…>`, `-o[=\s]<…>` (space/`=`-separated), and `-o<fused>` (\S*?).
    return re.search(
        r'(?:--output=?[^\n]*?|(?:^|\s)-o[=\s][^\n]*?|(?:^|\s)-o\S*?)'
        r'(?:type=registry|push=true)', run) is not None
def is_push(s):
    # A step PUSHES the image if it is a build-push-action with push:true, a plain `docker push`,
    # OR (multi-arch) a `docker buildx build …` that publishes to a registry (buildx_publishes:
    # `--push` or an `--output type=registry` / `push=true`) — the last forms emit the manifest
    # list directly and did not exist in the single-arch layout (arm64 expansion).
    w = s.get("with") or {}
    run = str(s.get("run", ""))
    return (str(s.get("uses", "")).startswith("docker/build-push-action")
            and str(w.get("push", "")).lower() in ("true", "1", "yes")) \
        or "docker push" in run \
        or buildx_publishes(run)
def enabled(s):
    # A step is DISABLED (not guaranteed to run) unless its `if:` is ABSENT or a plain truthy
    # CONSTANT. `if: false` / `if: ${{ false }}` -> disabled. A dynamic/unusual `if:` — incl.
    # `always()` (which changes failure semantics, not "run unconditionally as written") — is
    # treated as NOT-guaranteed-enabled and rejected, so a security-critical step (scan/guard)
    # can't be silently neutered by an `if:` the checker can't fully reason about.
    c = s.get("if", None)
    if c is None: return True
    if isinstance(c, bool): return c
    return str(c).strip().lower() in ("true", "success()", "${{ true }}")
def cont_on_err(s):
    # `continue-on-error: true` swallows a step's non-zero exit -> its `exit 1` no longer fails
    # the job. GHA also accepts an EXPRESSION here (`continue-on-error: ${{ true }}` /
    # `${{ github.event_name == 'workflow_dispatch' }}`), so matching only the literal `true`
    # was fail-OPEN (R6-M1). Mirror enabled()'s fail-CLOSED rule: treat the step as carrying
    # continue-on-error UNLESS it is provably safe — absent, or a constant that is explicitly
    # `false`. Anything else (literal true, an expression `${{ ... }}`, any non-constant) is
    # treated as possibly-continuing and REJECTED, so a security-critical step can't be silently
    # neutered by a continue-on-error value the checker can't fully reason about.
    c = s.get("continue-on-error", None)
    if c is None: return False
    if isinstance(c, bool): return c
    return str(c).strip().lower() != "false"
PYEOF

# extract the docker job's `if:` string from a workflow file (or a sentinel on absence).
docker_if_string() {
  python3 - "$1" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
j = (d.get("jobs") or {}).get("docker")
if not j: print("__NOJOB__"); sys.exit(0)
c = j.get("if")
print(c if isinstance(c, str) else "__NONSTRING__")
PY
}

# extract the npm job's `if:` string (or a sentinel on absence) — decision 019f5131.
npm_if_string() {
  python3 - "$1" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
j = (d.get("jobs") or {}).get("npm")
if not j: print("__NOJOB__"); sys.exit(0)
c = j.get("if")
print(c if isinstance(c, str) else "__NONSTRING__")
PY
}

# Print the npm job's runtime publish-guard run body iff it is a VALID gate: present, BEFORE the
# `npm publish` step, enabled, and not neutered by continue-on-error. Reuses the SHARED step
# predicates (sp.is_guard / sp.enabled / sp.cont_on_err); the publish step is an `npm publish`
# (its own detector — is_push is docker-specific). Non-zero exit (empty stdout) = "no valid guard".
npm_publish_guard_run() {
  python3 - "$1" <<'PY'
import sys, os, re, yaml
sys.path.insert(0, os.environ["SP_DIR"]); import step_predicates as sp
d = yaml.safe_load(open(sys.argv[1]))
steps = ((d.get("jobs") or {}).get("npm") or {}).get("steps") or []
# The PUBLISH step runs `npm publish` as a COMMAND (line start, after whitespace) — NOT the
# guard's own echo "npm publish authorized …" (a quoted string). Anchor at a line start and
# exclude the guard step, so the guard's message can't be mistaken for the publish command.
def is_publish(s):
    if sp.is_guard(s): return False
    return re.search(r'(^|\n)\s*npm publish\b', str(s.get("run", ""))) is not None
gi = next((i for i, s in enumerate(steps) if sp.is_guard(s)), None)
pi = next((i for i, s in enumerate(steps) if is_publish(s)), None)
if gi is None: sys.stderr.write("no npm publish-guard step\n"); sys.exit(1)
if pi is None: sys.stderr.write("no npm publish step\n"); sys.exit(1)
if gi >= pi:   sys.stderr.write("guard is not before npm publish\n"); sys.exit(1)
g = steps[gi]
if not sp.enabled(g): sys.stderr.write(f"guard disabled by `if: {g.get('if')}`\n"); sys.exit(1)
if sp.cont_on_err(g): sys.stderr.write("guard has a non-false continue-on-error\n"); sys.exit(1)
sys.stdout.write(str(g.get("run", "")))
PY
}
# (npm runtime-guard matrix is `npm_guard_matrix_ok`, a wrapper over the SHARED
#  guard_matrix_ok_var defined alongside the docker one below — TDA-1/QA-3: single 8-point
#  matrix parameterized by the opt-in env-var name, so docker and npm can't drift.)

# --- runtime publish-guard helpers (R4-M1a / R5-M1) ------------------------------------
# Print the docker job's runtime publish-guard step run body, but ONLY if that step is a VALID
# gate: it exists, sits before the push step, is NOT disabled by a falsy/dynamic `if:`, and does
# NOT carry a `continue-on-error` that isn't a provable `false`. The last two use the SHARED step
# predicates (R5-M1 — the guard checker used to omit them while the scan checker enforced them;
# R6-M1 made cont_on_err fail-closed for expression forms). Non-zero exit (empty stdout) = "no
# valid guard".
docker_publish_guard_run() {
  python3 - "$1" <<'PY'
import sys, os, yaml
sys.path.insert(0, os.environ["SP_DIR"]); import step_predicates as sp
d = yaml.safe_load(open(sys.argv[1]))
steps = ((d.get("jobs") or {}).get("docker") or {}).get("steps") or []
gi = next((i for i, s in enumerate(steps) if sp.is_guard(s)), None)
pi = next((i for i, s in enumerate(steps) if sp.is_push(s)), None)
if gi is None: sys.stderr.write("no publish-guard step\n"); sys.exit(1)
if pi is None: sys.stderr.write("no push step\n"); sys.exit(1)
if gi >= pi:   sys.stderr.write("guard is not before push\n"); sys.exit(1)
g = steps[gi]
if not sp.enabled(g):     sys.stderr.write(f"guard disabled by `if: {g.get('if')}`\n"); sys.exit(1)
if sp.cont_on_err(g):     sys.stderr.write("guard has a non-false `continue-on-error` (exit 1 may be swallowed)\n"); sys.exit(1)
sys.stdout.write(str(g.get("run", "")))
PY
}
# Execute a guard run body under one context; $5 = the opt-in env-var NAME (docker/npm differ
# ONLY here — TDA-1/QA-3: parameterized so a single helper drives both). `"$5=$4"` builds the
# `NAME=VALUE` assignment env consumes (env parses NAME=VALUE args until the command).
guard_ctx_var() { # $1=run $2=ref $3=event $4=enableval $5=envname
  env GITHUB_REF="$2" GITHUB_EVENT_NAME="$3" "$5=$4" bash -c "$1" >/dev/null 2>&1
}
# True iff a guard run body enforces tag∧opt-in across the 8-sample matrix (fail-closed), where
# $2 = the opt-in env-var name. R5-L3 sample points (shared by docker AND npm now): a SECOND tag
# version catches a guard hardcoded to one tag; a `false` opt-in value (broken-disable) and a
# non-dispatch/non-push (schedule) event catch a guard that treats "anything set" as authorized.
# HONEST LIMIT (sweep — QA-R5-2): executes only the extracted RUN body, so a step/job-level
# `env: <VAR>: 'true'` defang (not visible to the checker) is not caught here; that residual is
# if:-gated + disclosed, not chased into a denylist.
guard_matrix_ok_var() { # $1=run $2=envname
  local run="$1" v="$2"
  guard_ctx_var "$run" refs/tags/v1.2.3 workflow_dispatch ''    "$v"; [ $? -eq 0 ] || return 1  # tag+dispatch -> allow
  guard_ctx_var "$run" refs/tags/v1.2.3 push             true  "$v"; [ $? -eq 0 ] || return 1  # tag+push+var -> allow
  guard_ctx_var "$run" refs/tags/v9.9.9 workflow_dispatch ''    "$v"; [ $? -eq 0 ] || return 1  # OTHER tag+dispatch -> allow
  guard_ctx_var "$run" refs/tags/v1.2.3 push             ''    "$v"; [ $? -ne 0 ] || return 1  # tag+push+novar -> BLOCK
  guard_ctx_var "$run" refs/tags/v9.9.9 push             ''    "$v"; [ $? -ne 0 ] || return 1  # OTHER tag+push+novar -> BLOCK
  guard_ctx_var "$run" refs/tags/v1.2.3 push             false "$v"; [ $? -ne 0 ] || return 1  # broken-disable ENABLE=false -> BLOCK
  guard_ctx_var "$run" refs/tags/v1.2.3 schedule         ''    "$v"; [ $? -ne 0 ] || return 1  # tag+non-dispatch event -> BLOCK
  guard_ctx_var "$run" refs/heads/main  workflow_dispatch ''    "$v"; [ $? -ne 0 ] || return 1  # nontag -> BLOCK
  return 0
}
# Thin per-job wrappers (single source above; no drift). docker reads ENABLE_GHCR_PUBLISH,
# npm reads ENABLE_NPM_PUBLISH — the ONLY difference between the two gates' guards.
guard_matrix_ok()     { guard_matrix_ok_var "$1" ENABLE_GHCR_PUBLISH; }
npm_guard_matrix_ok() { guard_matrix_ok_var "$1" ENABLE_NPM_PUBLISH; }

# --- single-source docker STEP mutator (R4-L6 + R5-M1: is_scan/is_guard from step_predicates) -
# Apply a named mutation to the docker job's scan OR guard step and write the mutated workflow.
# scan ops:  remove | reorder_last | gut | disable | coe | comment | echo
# guard ops: guard_remove | guard_disable | guard_coe | guard_always
MUTATE_STEP_PY="$WORK/mutate_step.py"
cat > "$MUTATE_STEP_PY" <<'PYEOF'
import sys, os, yaml
sys.path.insert(0, os.environ["SP_DIR"]); import step_predicates as sp
op, inp, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = yaml.safe_load(open(inp))
job = (d.get("jobs") or {}).get("docker") or {}
steps = job.get("steps") or []
COE_EXPR_T = "${{ true }}"
COE_EXPR_C = "${{ github.event_name == 'workflow_dispatch' }}"
SCAN_OPS = ("gut", "disable", "coe", "coe_exprT", "coe_exprC", "coe_false", "comment", "echo")
GUARD_STEP_OPS = ("guard_disable", "guard_coe", "guard_coe_exprT", "guard_coe_exprC",
                  "guard_coe_false", "guard_always")
if op == "remove":
    job["steps"] = [s for s in steps if not sp.is_scan(s)]
elif op == "reorder_last":
    job["steps"] = [s for s in steps if not sp.is_scan(s)] + [s for s in steps if sp.is_scan(s)]
elif op == "guard_remove":
    job["steps"] = [s for s in steps if not sp.is_guard(s)]
elif op in SCAN_OPS or op in GUARD_STEP_OPS:
    for s in steps:
        if op in SCAN_OPS and sp.is_scan(s):
            if op == "gut":         s["run"] = "echo scanning done"
            elif op == "disable":   s["if"] = False
            elif op == "coe":       s["continue-on-error"] = True
            elif op == "coe_exprT": s["continue-on-error"] = COE_EXPR_T
            elif op == "coe_exprC": s["continue-on-error"] = COE_EXPR_C
            elif op == "coe_false": s["continue-on-error"] = False
            elif op == "comment":   s["run"] = "set -euo pipefail\n# scan_image_fs docker export exit 1 (all in a comment)\necho no real scan"
            elif op == "echo":      s["run"] = 'echo "scan_image_fs docker export exit 1"'
        elif op in GUARD_STEP_OPS and sp.is_guard(s):
            if op == "guard_disable":     s["if"] = False
            elif op == "guard_coe":       s["continue-on-error"] = True
            elif op == "guard_coe_exprT": s["continue-on-error"] = COE_EXPR_T
            elif op == "guard_coe_exprC": s["continue-on-error"] = COE_EXPR_C
            elif op == "guard_coe_false": s["continue-on-error"] = False
            elif op == "guard_always":    s["if"] = "always()"
else:
    sys.stderr.write(f"unknown op {op}\n"); sys.exit(2)
yaml.safe_dump(d, open(out, "w"))
PYEOF
mutate_scan()  { python3 "$MUTATE_STEP_PY" "$1" "$2" "$3"; }
mutate_guard() { python3 "$MUTATE_STEP_PY" "$1" "$2" "$3"; }

# --- multi-arch push mutator (arm64 / SEC-1 + QA-1/2/3/4 + SEC-R1/R2 RED probes) --------
# Apply a named mutation to the docker job's buildx publish step (or the per-arch scan step) so each
# unblock-fix path can be asserted to make docker_scan_before_push FAIL. The buildx-publish step is
# located via the SHARED step_predicates.buildx_publishes (no private copy — TDA-R1/QA-R2), so the
# mutator and the checker agree on what counts as a publish. is_scan is likewise shared.
MUTATE_PUSH_PY="$WORK/mutate_push.py"
cat > "$MUTATE_PUSH_PY" <<'PYEOF'
import sys, os, re, yaml
sys.path.insert(0, os.environ["SP_DIR"]); import step_predicates as sp
op, inp, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = yaml.safe_load(open(inp))
job = (d.get("jobs") or {}).get("docker") or {}
steps = job.get("steps") or []
def is_pub(s):
    return sp.buildx_publishes(str(s.get("run", "")))
def first(pred):
    return next((s for s in steps if pred(s)), None)
if op == "plat_env":            # (a) --platform env indirection -> non-literal -> fail-closed
    s = first(is_pub); s["run"] = re.sub(r'--platform[ =]+\S+', '--platform ${{ env.PLATFORMS }}', s["run"], count=1)
elif op == "plat_continuation": # (b) split the --platform list across a line-continuation, arm side unscanned
    s = first(is_pub); s["run"] = re.sub(r'--platform[ =]+\S+', '--platform linux/amd64,\\\nlinux/s390x', s["run"], count=1)
elif op == "scan_echo_only":    # (c) scan amd64 for real; arm64 only inside an echo STRING
    s = first(sp.is_scan)
    s["run"] = ('set -euo pipefail\n. scripts/lib/scan-image-fs.sh\n'
                'for arch in amd64; do scan_image_fs "img:${arch}"; done\n'
                'echo "arm64 was considered here only in this string"\n')
elif op == "plat_substring":    # (d) push linux/arm; scan has arm64 -> substring must NOT cover
    s = first(is_pub); s["run"] = s["run"].replace("linux/arm64", "linux/arm")
elif op == "extra_push_s390x":  # (e) a SECOND buildx --push publishing an unscanned arch
    steps.append({"name": "Push extra arch",
                  "run": 'docker buildx build --platform linux/s390x '
                         '--cache-from "type=local,src=/tmp/adcache-s390x" --push -t img:x .'})
elif op == "drop_all_cachefrom":   # (f) remove EVERY --cache-from -> unscanned rebuild
    s = first(is_pub); s["run"] = "\n".join(l for l in s["run"].splitlines() if "--cache-from" not in l)
elif op == "drop_one_cachefrom":   # (g) remove only the arm64 --cache-from
    s = first(is_pub); kept = []; dropped = False
    for l in s["run"].splitlines():
        if not dropped and "--cache-from" in l and "arm64" in l: dropped = True; continue
        kept.append(l)
    s["run"] = "\n".join(kept)
elif op == "comment_arm64_cachefrom":  # (h) SEC-R1: comment-OUT the arm64 --cache-from line (not delete)
    s = first(is_pub); s["run"] = "\n".join(('# ' + l if ("--cache-from" in l and "arm64" in l) else l)
                                            for l in s["run"].splitlines())
elif op == "echo_spoof_cachefrom":     # (i) SEC-R1: drop the real arm64 flag, mention adcache-arm64 in an echo STRING
    s = first(is_pub)
    kept = [l for l in s["run"].splitlines() if not ("--cache-from" in l and "arm64" in l)]
    kept.insert(1, '          echo "prev: --cache-from type=local,src=/tmp/adcache-arm64"')
    s["run"] = "\n".join(kept)
elif op == "extra_output_registry":    # (j) SEC-R2: a SECOND buildx that publishes via --output type=registry (no --push)
    steps.append({"name": "Publish extra arch via output",
                  "run": 'docker buildx build --platform linux/s390x '
                         '--cache-from "type=local,src=/tmp/adcache-s390x" --output type=registry -t img:x .'})
elif op == "nested_platform_shc":       # (k) QA-R3-1: --platform buried in a nested `sh -c "…"` quote -> shlex single-tokens
    # Wrap the buildx publish inside `sh -c "…"`. shlex collapses the whole inner command into ONE
    # quoted token, so _flag_values('--platform') surfaces nothing — yet the arch (s390x) rides along
    # UNSCANNED. Pre-fix this hit the "no --platform = native single arch" skip (fail-OPEN = gate PASSES,
    # DEAD GATE). Post-fix the raw-substring backstop FAILS CLOSED (the `--platform` substring is present).
    s = first(is_pub)
    s["run"] = ('set -euo pipefail\n'
                'sh -c "docker buildx build --platform linux/amd64,linux/arm64,linux/s390x '
                '--push -t img:x ."\n')
elif op == "extra_output_registry_fused":  # (l) SEC-R3-1: a SECOND buildx publishing via the FUSED short flag -otype=registry
    # Pre-fix buildx_publishes' `-o[=\s]` under-matched `-otype=registry`, so this step was NOT seen as
    # a push (fail-OPEN = its unscanned s390x hid = gate PASSES). Post-fix it is recognized -> covered
    # -> unscanned arch REJECT.
    steps.append({"name": "Publish extra arch via fused -o",
                  "run": 'docker buildx build --platform linux/s390x '
                         '--cache-from "type=local,src=/tmp/adcache-s390x" -otype=registry -t img:x .'})
else:
    sys.stderr.write(f"unknown op {op}\n"); sys.exit(2)
job["steps"] = steps
yaml.safe_dump(d, open(out, "w"))
PYEOF
mutate_push() { python3 "$MUTATE_PUSH_PY" "$1" "$2" "$3"; }

# ============================================================================
# Checkers under test (pure; operate on a given tree/file)
# ============================================================================

# every workspace package.json version === root version
versions_consistent() {
  local r="$1" rootv f pv
  rootv="$(jq -r '.version' "$r/package.json" 2>/dev/null)"
  for f in "$r/package.json" "$r"/db/package.json "$r"/packages/*/package.json "$r"/apps/*/package.json; do
    [ -f "$f" ] || continue
    pv="$(jq -r '.version' "$f" 2>/dev/null)"
    [ "$pv" = "$rootv" ] || { echo "version mismatch: $f = $pv (root $rootv)"; return 1; }
  done
  return 0
}

# a tag matching the working-tree root version exists and its OWN tree carries that version
tag_matches_version() {
  local r="$1" v tagged
  v="$(jq -r '.version' "$r/package.json" 2>/dev/null)"
  git -C "$r" rev-parse -q --verify "refs/tags/v$v" >/dev/null 2>&1 || return 1
  tagged="$(git -C "$r" show "v$v:package.json" 2>/dev/null | jq -r '.version' 2>/dev/null)"
  [ "$tagged" = "$v" ]
}

# SBOM component names ⊇ every direct EXTERNAL prod dep of the workspace
sbom_covers_prod_deps() {
  local sbom="$1" r="$2" miss=0 dep comps deps
  comps="$(jq -r '.components[].name' "$sbom" 2>/dev/null | sort -u)"
  deps="$(cat "$r"/package.json "$r"/db/package.json "$r"/packages/*/package.json "$r"/apps/*/package.json 2>/dev/null \
          | jq -rs '[.[].dependencies // {} | keys[]] | unique | .[]' 2>/dev/null | grep -v '^@actradeck/')"
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    # QA-3: membership via a captured newline-delimited set (no `heavy | grep -q` pipe —
    # this file's own convention avoids the pipefail x SIGPIPE inversion class). Package
    # names contain no glob metacharacters, so the case-glob match is exact.
    case $'\n'"$comps"$'\n' in
      *$'\n'"$dep"$'\n'*) : ;;
      *) echo "SBOM missing prod dep: $dep"; miss=1 ;;
    esac
  done <<< "$deps"
  return "$miss"
}

# no forbidden internal file, and no MAINTAINER coupling string, in an extracted tree <d>.
# NOTE: a generic '/home/<user>/' scan is deliberately NOT used — the mirror legitimately
# ships many SYNTHETIC example paths (/home/user, /home/me, /home/x) in test fixtures and
# the demo cast. The real leak concern is the maintainer's own path/handle, caught by the
# canonical maintainer-coupling scan (maintainer home path, project id, handle, …). That
# lib is private (unshipped); in the mirror the tree is already sanitized by prepare-oss and the
# forbidden-files check remains the last line of defense.
tarball_no_leak() {
  local d="$1" bad=0 out
  out="$(cd "$d" && find . \( -name '.env' -o -name '.mcp.json' -o -name 'CLAUDE.md' \
           -o -name 'AGENTS.md' -o -name 'plan.md' -o -name '.claude' \) -print 2>/dev/null)"
  [ -n "$out" ] && { echo "forbidden internal path(s): $out"; bad=1; }
  if [ -f "$SELF/lib/oss-patterns.sh" ]; then
    # shellcheck source=lib/oss-patterns.sh
    . "$SELF/lib/oss-patterns.sh"
    out="$(grep -rIEn -e "$OSS_COUPLING_RE" "$d" 2>/dev/null)" || true
    [ -n "$out" ] && { echo "maintainer coupling string leaked: $(printf '%s' "$out" | head -1)"; bad=1; }
  fi
  return "$bad"
}

# release.yml has top-level permissions == {contents: read}; write is job-scoped only
perms_minimal() {
  python3 - "$1" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
top = d.get("permissions")
if top != {"contents": "read"}:
    print("top-level permissions not minimal:", top); sys.exit(1)
# QA-2: a job may hold WRITE only if it is the signing/release job, identified
# structurally by declaring id-token:write AND attestations:write (name-agnostic). Any
# OTHER job carrying a write scope (e.g. an injected `packages: write` on verify) FAILS.
#
# SEC-4: there are now TWO signing jobs (release: contents+id-token+attestations; docker:
# packages+id-token+attestations). The is_signing gate alone would pass a signing job that
# ALSO grabbed an unrelated write (e.g. `actions: write` / `deployments: write`). So each
# signing job's write set must additionally be a SUBSET of the expected signing scopes.
#
# npm Phase 3 (decision 019f5131): a THIRD write-holder — the Trusted-Publishing `npm` job —
# holds ONLY `id-token: write` (OIDC token exchange; it stores no npm token and needs neither
# attestations nor contents/packages). It is recognized STRUCTURALLY by its write set being
# EXACTLY {id-token}. Any other write on such a job (e.g. an injected contents:write) makes the
# set != {id-token}, so it is neither a signing job nor an OIDC-publish job and FAILS closed.
SIGNING_WRITE_ALLOWED = {"contents", "packages", "id-token", "attestations"}
for name, job in (d.get("jobs") or {}).items():
    jp = job.get("permissions") or {}
    writes = sorted(k for k, v in jp.items() if v == "write")
    if not writes:
        continue
    is_signing = jp.get("id-token") == "write" and jp.get("attestations") == "write"
    is_oidc_publish = writes == ["id-token"]
    if not (is_signing or is_oidc_publish):
        print(f"job '{name}' holds write {writes} but is neither the signing job nor an OIDC-publish job"); sys.exit(1)
    if is_signing:
        surplus = [k for k in writes if k not in SIGNING_WRITE_ALLOWED]
        if surplus:
            print(f"signing job '{name}' holds unexpected write scope(s) {surplus}"); sys.exit(1)
sys.exit(0)
PY
}

# SEC-2 (R2-M2 → R3-M2): inside the `docker` job the image leak-scan step MUST come BEFORE the
# push AND actually run for real. A name+order check was a DEAD GATE; even the R2 hardening was
# defeated by `continue-on-error: true` (exit 1 no longer fails the job) and by burying the
# load-bearing token in a COMMENT or an echo STRING (substring match). R3-M2 hardens against
# those three no-op forms — but this is a SECONDARY wiring check, NOT an exhaustive proof the
# scan runs (the AUTHORITATIVE leak gate is the real image scan; see the NOTE below):
#   (i)   NOT disabled by a falsy `if:`,
#   (ii)  NO `continue-on-error: true` (an `exit 1` must actually fail the job),
#   (iii) the run body, AFTER stripping comments + quoted-string contents, still contains an
#         EXECUTABLE call to the canonical scan — `scan_image_fs` (scripts/lib/scan-image-fs.sh,
#         R3-L1) OR the inline pair `docker export` + `exit 1`.
# The push step is a `docker push` (R2-L3 retag-and-push), a `docker buildx build … --push`
# (multi-arch manifest-list push — arm64 expansion), or a build-push-action with push:true; a
# re-building build-push-action push:true is rejected (scanned image != pushed image).
# MULTI-ARCH EXPANSION (arm64 / decision 019f4fc1): the buildx `--push` re-assembles the manifest
# list FROM THE PER-ARCH BUILD CACHE the `--load` builds wrote, so the pushed per-arch layers come
# from the SAME cache that was scanned. Because one push now publishes MANY platforms, the checker
# hardens across EVERY push step (not just the first):
#   - ALL scan steps (not just the first) must be enabled / non-continue-on-error / executable.
#   - SEC-1 (fail-closed): a buildx publish whose --platform is NOT a literal `linux/<arch>[,…]` list
#     (env indirection `${{ … }}` / `${VAR}` / an unsupported variant) is REJECTED, because coverage
#     is unverifiable — silently skipping was fail-OPEN.
#   - QA-2/3: every pushed arch must appear as a WHOLE TOKEN in a valid scan's EXECUTABLE body
#     (strings + comments stripped; `linux/arm` is not covered by a scan's `arm64` substring).
#   - QA-1 + SEC-R1: each pushed arch must be referenced by a `--cache-from` (adcache-<arch>) on the
#     push step, so the pushed layers are the scanned ones and not an unscanned fresh rebuild. Both
#     --platform and --cache-from are read by shlex TOKEN POSITION (_flag_values), so a `#`-commented
#     flag or a flag name buried inside an `echo "…"` string does NOT count (raw substring did — the
#     comment/echo spoof SEC-R1). SEC-R2: the publish step is detected via the shared
#     step_predicates.buildx_publishes, so an `--output type=registry` publish is covered like `--push`.
# NOTE: this is only the SECONDARY (wiring) check. The AUTHORITATIVE leak gate is the real image
# FS scan (scripts/lib/scan-image-fs.sh, run in release.yml before push AND in ci.yml's
# docker-image-scan job on every image-content change).
docker_scan_before_push() {
  python3 - "$1" <<'PY'
import sys, os, re, shlex, yaml
sys.path.insert(0, os.environ["SP_DIR"]); import step_predicates as sp
d = yaml.safe_load(open(sys.argv[1]))
job = (d.get("jobs") or {}).get("docker")
if not job:
    print("no `docker` job in workflow"); sys.exit(1)
steps = job.get("steps") or []
def strip_run(run):
    # remove QUOTED string contents first (so a token inside echo "..." / '...' is gone), then
    # strip shell comments — leaving only EXECUTABLE tokens. A token that survives is a real
    # command, not a comment or an echo argument. (scan-specific; not a shared step predicate.)
    out = []
    for line in run.splitlines():
        line = re.sub(r"'[^']*'", "''", line)
        line = re.sub(r'"[^"]*"', '""', line)
        line = re.sub(r'#.*$', '', line)
        out.append(line)
    return "\n".join(out)
scan_idxs = [i for i, s in enumerate(steps) if sp.is_scan(s)]
push_idxs = [i for i, s in enumerate(steps) if sp.is_push(s)]
if not push_idxs:
    print("no push step (docker push / docker buildx build --push / build-push-action push:true) in docker job"); sys.exit(1)
push_i = push_idxs[0]
if not scan_idxs:
    print("no image leak-scan step found in docker job"); sys.exit(1)
# EVERY leak-scan step must sit BEFORE the (first) push, be enabled, not swallow its exit, and carry
# an EXECUTABLE scan call. The single-arch layout had ONE scan step; the multi-arch layout may split
# per platform — ALL of them must hold, so a neutralized *second* scan can't slip an unscanned arch
# past a still-valid *first* scan. Collect the STRIPPED bodies (quoted strings + comments removed,
# via strip_run) of the valid scans for the coverage check below — QA-2: an arch mentioned only in
# an `echo "…arm64…"` string or a comment does NOT count as scanned.
scanned_bodies = []
for si in scan_idxs:
    scan = steps[si]
    if si >= push_i:
        print(f"scan step (index {si}) is not BEFORE push step (index {push_i})"); sys.exit(1)
    if not sp.enabled(scan):
        print(f"scan step is disabled by `if: {scan.get('if')}`"); sys.exit(1)
    if sp.cont_on_err(scan):
        print("scan step has `continue-on-error: true` — a leak `exit 1` would not fail the job"); sys.exit(1)
    body = strip_run(str(scan.get("run", "")))
    via_lib = "scan_image_fs" in body
    via_inline = ("docker export" in body) and ("exit 1" in body)
    if not (via_lib or via_inline):
        print("scan step `run:` has no EXECUTABLE scan call (scan_image_fs, or docker export + exit 1) after comment/string strip"); sys.exit(1)
    scanned_bodies.append(body)
rebuild = [sp.name(s) for s in steps
           if str(s.get("uses", "")).startswith("docker/build-push-action")
           and str((s.get("with") or {}).get("push", "")).lower() in ("true", "1", "yes")]
if rebuild:
    print("push re-builds the image (build-push-action push:true) — scanned image != pushed image:", rebuild); sys.exit(1)

# ---- MULTI-ARCH per-push COVERAGE + CACHE PARITY (arm64 expansion; SEC-1 / QA-1 / QA-2/3/4) ----
# For EVERY push step (QA-4), and specifically the buildx `--push` form (multi-arch manifest list):
#   (SEC-1 fail-closed) the --platform value MUST be a literal `linux/<arch>[,linux/<arch>…]` list.
#     If --platform is present but non-literal (env indirection `${{ … }}` / `${VAR}`, or a value we
#     cannot resolve to literal even after joining shell line-continuations) we CANNOT verify per-arch
#     coverage, so we FAIL CLOSED — mirroring enabled()/cont_on_err(). Silently skipping (the old
#     fail-OPEN) let `--platform ${{ env.PLATFORMS }}` ship an unscanned arch.
#   (QA-2/3) every pushed arch must appear as a WHOLE TOKEN in a valid scan step's EXECUTABLE body
#     (strings + comments already stripped) — `linux/arm` must NOT be covered by the substring of a
#     scan's `arm64`, and an arch named only in a string/comment does not count.
#   (QA-1) the buildx `--push` re-assembles the image FROM the per-arch build cache; require a
#     `--cache-from` referencing EACH arch (adcache-<arch>) so the pushed layers come from the SAME
#     cache that was scanned. A missing cache-from (all arches, or a single arch) = an unscanned
#     fresh rebuild -> REJECT (the build-push-action rebuild-reject above has no reach here).
# Legitimate SKIP: a plain `docker push` retag, or a build-push-action (rejected above). A buildx
# publish with NO --platform is also skipped here (it builds a single host-arch image — NOT a retag
# of a scanned image; tying that fresh single-arch build to a pre-push scan is a tracked sweep item,
# SEC-R3). The release.yml push always carries an explicit multi-arch --platform, so it never skips.
def _join_cont(run):
    # shell line-continuation removes the backslash+newline with NO inserted space (faithful join),
    # so a value split across `linux/amd64,\<newline>linux/s390x` rejoins to `linux/amd64,linux/s390x`
    # (a legitimately continuation-split list is accepted, not falsely rejected).
    return re.sub(r'\\\n', '', run)
def _flag_values(run, flag):
    # SEC-R1: extract a flag's values by TOKEN POSITION, not a raw regex. shlex tokenizes the shell
    # command (after joining line-continuations) with comments=True, so (a) a `#`-commented flag is
    # dropped, (b) a flag name appearing INSIDE an `echo "…--cache-from…"` string is a quoted argument
    # token, never at a flag position, and (c) the real quoted value `"type=local,src=/tmp/adcache-amd64"`
    # survives as ONE token (a naive strip_run would delete it and falsely REJECT the real workflow).
    try:
        toks = shlex.split(_join_cont(run), comments=True, posix=True)
    except ValueError:
        return None  # unbalanced quotes etc. — caller treats as unverifiable (fail-closed)
    out = []
    for i, t in enumerate(toks):
        if t == flag and i + 1 < len(toks):
            out.append(toks[i + 1])
        elif t.startswith(flag + "="):
            out.append(t[len(flag) + 1:])
    return out
def _whole_token(tok, hay):
    return re.search(r'(?<![A-Za-z0-9_])' + re.escape(tok) + r'(?![A-Za-z0-9_])', hay) is not None
LIT_PLATFORM = re.compile(r'^linux/[A-Za-z0-9._-]+(?:,linux/[A-Za-z0-9._-]+)*$')
scanned_all = "\n".join(scanned_bodies)
for pi in push_idxs:
    prun_raw = str(steps[pi].get("run", ""))
    # SEC-R2 / SEC-R3-1: gate on the SHARED buildx-publish predicate, so a step that publishes via
    # `--output type=registry` / the fused `-otype=registry` (not just `--push`) is covered too — a
    # publish step whose flag is one of the recognized spellings can't hide (see buildx_publishes for
    # the honest scope: an unrecognized publisher spelling falls through fail-closed, not silently).
    if not sp.buildx_publishes(prun_raw):
        continue  # docker push (retag) / build-push-action — single-arch legacy, coverage N/A
    plat_vals = _flag_values(prun_raw, "--platform")
    if plat_vals is None:
        print(f"push step (index {pi}) run could not be tokenized (unbalanced quotes?) — cannot verify per-arch coverage; FAIL CLOSED"); sys.exit(1)
    if not plat_vals:
        # QA-R3-1 (fail-closed backstop): _flag_values could surface NO --platform token, yet the raw
        # run text DOES contain the `--platform` substring. That means the flag is present but shlex
        # could not place it at a token position — e.g. a NESTED-QUOTE wrapper `sh -c "docker buildx
        # build --platform …,linux/s390x --push …"` collapses the whole inner command into ONE quoted
        # token, so per-arch coverage is unverifiable. Treat as unresolvable and FAIL CLOSED (symmetric
        # with the `plat_vals is None` unbalanced-quote path), rather than falling into the "no
        # --platform = native single host arch" skip below (which would be fail-OPEN — an unscanned arch
        # could ride the wrapper). HONEST SCOPE: this over-rejects a publish step that merely MENTIONS
        # `--platform` in an echo/comment while carrying no real flag — the safe side (a spurious RED,
        # never a silent pass), consistent with the file's fail-closed convention.
        if "--platform" in prun_raw:
            print(f"push step (index {pi}) has a `--platform` substring but shlex surfaced no --platform token (nested-quote wrapper like `sh -c \"…--platform…\"`?) — cannot verify per-arch coverage; FAIL CLOSED"); sys.exit(1)
        continue  # buildx publish with no --platform = native single host arch (legacy-equivalent)
    arches = []
    for v in plat_vals:
        vv = v.strip().strip('"').strip("'")
        if not LIT_PLATFORM.match(vv):
            hint = ("shell/Actions indirection (${{…}} / ${VAR})" if ("$" in vv or "{" in vv or "`" in vv)
                    else "an unsupported platform form (e.g. a linux/arm/v7 variant)")
            print(f"push step (index {pi}) has a non-literal --platform ('{v}') — {hint}; this checker cannot resolve it to a literal linux/<arch>[,linux/<arch>] list, so it FAILS CLOSED"); sys.exit(1)
        arches += [p.split("/")[-1] for p in vv.split(",")]
    arches = [a for a in arches if a]
    for a in arches:
        if not _whole_token(a, scanned_all):
            print(f"push step (index {pi}) publishes linux/{a} but no pre-push scan references it as a whole token (unscanned arch)"); sys.exit(1)
    cache_vals = " ".join(_flag_values(prun_raw, "--cache-from") or [])
    # N2 (considered, NOT tightened — decision 019f50ec follow-up): `_whole_token` treats `-`/`/` as
    # word boundaries, so a DECOY cache dir whose name merely CONTAINS the arch (e.g.
    # `src=/tmp/adcache-arm64-fake`, which does not hold the real arm64 cache) satisfies this parity
    # check. Tightening to require the arch as the TRAILING path segment of the `src=`/`dest=` value
    # (basename endswith `-<arch>`) would reject that decoy — but it was deliberately NOT implemented:
    #   (1) the decoy needs an adversarial/careless WORKFLOW AUTHOR (single-operator, maintainer-owned)
    #       who fakes a cache name while dropping the real one — outside this SECONDARY wiring check's
    #       threat model (the AUTHORITATIVE gate is the real per-arch image FS scan, which runs on the
    #       actually-built images before push and a fake `--cache-from` does not bypass);
    #   (2) a trailing-segment heuristic over-rejects LEGITIMATE cache backends the release may adopt —
    #       `type=gha,scope=<arch>`, `type=registry,ref=img:cache-<arch>`, nested paths, trailing
    #       slashes — turning a benign backend swap into a spurious RED (the file's "NO OVER-REJECT:
    #       fail-closed must stay precise" principle). A brittle heuristic RED-flagging a legit refactor
    #       is a worse failure mode than a contrived author-only decoy.
    # Net: parity stays a whole-token "the arch is referenced by a cache-from" hint; the real scan is the
    # enforcement. Revisit if a non-author trust boundary (multi-operator / remote push authoring) opens.
    for a in arches:
        if not _whole_token(a, cache_vals):
            print(f"push step (index {pi}) publishes linux/{a} but has no --cache-from referencing it (adcache-{a}) — pushed layers would be an unscanned rebuild"); sys.exit(1)
sys.exit(0)
PY
}

# TDA-1 (R2-M3 → R3-M3): the Dockerfile's RUNTIME stage must NOT carry a broad copy of the
# whole `/app` tree from a build stage — that re-bakes the entire source tree (test fixtures
# with private coupling literals) into the shipped image. Prior checkers keyed on the LITERAL
# `COPY --from=builder` with the flag FIRST — a DEAD GATE bypassed by flag reordering
# (`COPY --chown=1:1 --from=builder …`), extra flags (`--link`), a renamed build stage
# (`--from=b`), and path idioms (`/app/`, `/app/./`). R3-M3 is flag- and stage-INDEPENDENT:
# tokenize every COPY line, resolve `--from=<stage>` in ANY position (any stage name), and
# normalize each path (collapse `/./`, dup slashes, trailing slash) before deciding — broad iff
# any SOURCE that comes FROM A BUILD STAGE normalizes to exactly `/app`. HONEST LIMITS (this is a
# SECONDARY check; the authoritative leak gate is the real image scan): normalization does NOT
# resolve `..` segments or Dockerfile build-args (`$STAGE` / `${FOO}`), so a `COPY --from=builder
# /app/../app …` or a build-arg-obscured source is not recognized here — those would still be
# caught downstream by the real image FS scan (a `..`-escape is exotic and re-fires that scan).
dockerfile_runtime_allowlist() {
  python3 - "$1" <<'PY'
import sys, re
raw = open(sys.argv[1]).read()
raw = re.sub(r'\\\n', ' ', raw)                 # join line-continuations into one logical line
lines = raw.splitlines()
start = next((i for i, l in enumerate(lines)
              if re.match(r'\s*FROM\s+.*\bAS\s+runtime\b', l, re.I)), None)
if start is None:
    print("no `AS runtime` stage in Dockerfile"); sys.exit(1)
seg = lines[start + 1:]
nxt = next((i for i, l in enumerate(seg) if re.match(r'\s*FROM\s', l, re.I)), None)
if nxt is not None:
    seg = seg[:nxt]

def norm(p):
    # normalize a COPY path the way Docker/OCI treats it: strip quotes, collapse `/./`
    # segments, collapse duplicate slashes, drop the trailing slash. So `/app`, `/app/`,
    # `/app/.`, `/app/./`, `/app//` all normalize to `/app`.
    p = p.strip().strip('"').strip("'")
    p = re.sub(r'/\.(?=/|$)', '/', p)   # `/.` -> `/`  (repeat below collapses the result)
    p = re.sub(r'/\.(?=/|$)', '/', p)
    p = re.sub(r'/+', '/', p)           # collapse duplicate slashes
    p = re.sub(r'/$', '', p) or "/"     # drop trailing slash
    return p

copies = []
for l in seg:
    toks = l.split()
    if not toks or toks[0].upper() != "COPY":
        continue
    # A COPY has a build-stage source iff it carries a `--from=<stage>` flag in ANY position
    # AND that stage is NOT an external image ref (contains no ':' / '/' registry markers).
    from_stage = None
    for t in toks[1:]:
        m = re.match(r'--from=(.+)$', t)
        if m:
            from_stage = m.group(1)
    has_build_from = from_stage is not None and (":" not in from_stage and "/" not in from_stage)
    paths = [t for t in toks[1:] if not t.startswith("--")]
    if len(paths) < 2:
        continue  # heredoc / malformed — no path pair to classify
    srcs, dest = paths[:-1], paths[-1]
    copies.append((srcs, dest, has_build_from, l))

# sanity: the runtime stage should copy SOMETHING from a build stage (the allowlist).
if not any(has_build_from for (_, _, has_build_from, _) in copies):
    print("runtime stage has no `COPY --from=<build-stage>` (unexpected)"); sys.exit(1)
bad = [l for (srcs, dest, has_build_from, l) in copies
       if has_build_from and any(norm(s) == "/app" for s in srcs)]
if bad:
    print("runtime stage has a BROAD whole-tree copy:", bad[0].strip()); sys.exit(1)
sys.exit(0)
PY
}

# invoke install.sh's pure verify helpers in an isolated subshell (no network)
inst() { ( ACTRADECK_INSTALL_SOURCE_ONLY=1 . "$SELF/install.sh"; "$@" ); }

# ============================================================================
# INV-RELEASE-VERSION-SINGLE-SOURCE
# ============================================================================
if versions_consistent "$ROOT" >/dev/null 2>&1; then
  ok "INV-VERSION-SINGLE-SOURCE: all workspace package.json versions match root"
else
  ng "INV-VERSION-SINGLE-SOURCE: live tree versions already inconsistent"
fi
# RED: copy the package.json set, flip ONE, assert the checker fails.
VT="$WORK/vtree"; mkdir -p "$VT"
( cd "$ROOT" && find . -maxdepth 3 -name package.json \
    -not -path './node_modules/*' -not -path '*/node_modules/*' \
    -exec cp --parents {} "$VT/" \; ) 2>/dev/null
tmp="$(jq '.version="9.9.9"' "$VT/apps/backend/package.json")"; printf '%s\n' "$tmp" > "$VT/apps/backend/package.json"
if versions_consistent "$VT" >/dev/null 2>&1; then
  ng "INV-VERSION-SINGLE-SOURCE: DEAD GATE — mismatched version still passed"
else
  ok "INV-VERSION-SINGLE-SOURCE: gate FAILS when one package.json diverges (falsifiable)"
fi

# TDA-1 (2026-08-13 audit): no hardcoded product-version literal in TypeScript sources.
# version.sh stamps package.json files only; a semver literal assigned to an APP_VERSION-style
# constant in src/ silently reports a stale version forever after the next release (the
# telemetry app_version did exactly this). Runtime code must derive from its package.json.
# Scan is scoped to assignment-shaped occurrences to avoid matching test fixtures/semver ranges.
# TDA-R2-1 (audit R2): the original regex missed the exact shape it protects — a *typed*
# declaration (`NAME: string = "x.y.z"`) — plus object-property form (`Version: "x.y.z"`),
# template-literal quotes, and .tsx files. The regex below allows an optional type annotation
# between the identifier and `=`, accepts `:` (property) as the assignment shape, and any of
# the three quote styles. Known limits (documented, not silent): identifiers must end in
# Version/_VERSION/_version, and non-scalar type annotations (e.g. `string[]`) are not covered.
version_literal_scan() {
  # $@ = roots to scan
  grep -rnE \
    '(_VERSION|_version|Version)[[:space:]]*(:[[:space:]]*[A-Za-z_][A-Za-z0-9_.<>|[:space:]]*)?[=:][[:space:]]*["'\''`][0-9]+\.[0-9]+\.[0-9]+' \
    "$@" --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v -e '\.test\.ts' -e '\.spec\.ts' -e '\.test\.tsx' -e '\.spec\.tsx' \
    | grep -vE '(SCHEMA|PROTOCOL|MANIFEST|PACKET)_VERSION' || true
}
VERSION_LITERALS="$(version_literal_scan "$ROOT"/apps/*/src "$ROOT"/packages/*/src)"
if [ -z "$VERSION_LITERALS" ]; then
  ok "INV-VERSION-SINGLE-SOURCE: no hardcoded app-version literal in runtime sources"
else
  ng "INV-VERSION-SINGLE-SOURCE: hardcoded version literal(s) in runtime sources: $VERSION_LITERALS"
fi
# RED probes (falsifiable, TDA-R2-1): inject the exact re-hardcoding shapes into a throwaway
# tree and assert the same scanner (single source: version_literal_scan) reports each of them.
VLP="$WORK/vliteral/src"; mkdir -p "$VLP"
printf 'export const ACTRADECK_APP_VERSION: string = "9.9.9";\n' > "$VLP/typed.ts"
printf 'const AppVersion = "9.9.9";\n' > "$VLP/untyped.ts"
printf 'const meta = { appVersion: "9.9.9" };\n' > "$VLP/property.tsx"
for probe in typed.ts untyped.ts property.tsx; do
  if version_literal_scan "$WORK/vliteral" | grep -q "$probe"; then
    ok "INV-VERSION-SINGLE-SOURCE: scanner catches injected literal ($probe)"
  else
    ng "INV-VERSION-SINGLE-SOURCE: DEAD GATE — injected literal escaped the scanner ($probe)"
  fi
done
printf 'export const CLEAN_VERSION: string = readManifest().version;\n' > "$VLP/clean.ts"
if version_literal_scan "$WORK/vliteral" | grep -q 'clean\.ts'; then
  ng "INV-VERSION-SINGLE-SOURCE: scanner false-positives on manifest-derived version (clean.ts)"
else
  ok "INV-VERSION-SINGLE-SOURCE: scanner ignores manifest-derived version (no false positive)"
fi

# ============================================================================
# INV-DOCS-SCRIPT-PARITY (TDA-R2-2, 2026-08-13 audit R2)
# ============================================================================
# Operator-facing docs quote `pnpm --filter <pkg> [run] <script>` commands. A package script
# rename (this branch renamed the collector's test/build to test:worker/build:worker) silently
# hard-fails the documented first-deployment steps. Extract every such command from the given
# docs and assert the script exists in the named package's manifest. `exec ...` is not a script.
docs_script_parity() {
  # $1 = repo root whose package manifests are authoritative; $2.. = doc files to scan
  local root="$1"; shift
  local drift="" cmd pkg script pkgjson
  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    pkg="$(printf '%s' "$cmd" | awk '{print $3}')"
    script="$(printf '%s' "$cmd" | awk '{ if ($4=="run") print $5; else print $4 }')"
    [ "$script" = "exec" ] && continue
    [ -z "$script" ] && continue
    pkgjson="$(grep -rl "\"name\": \"$pkg\"" "$root"/apps/*/package.json "$root"/packages/*/package.json 2>/dev/null | head -1)"
    if [ -z "$pkgjson" ]; then
      drift="$drift [$cmd -> package not found]"
    elif ! jq -e --arg s "$script" '.scripts[$s]' "$pkgjson" >/dev/null 2>&1; then
      drift="$drift [$cmd -> script '$script' missing in $(basename "$(dirname "$pkgjson")")]"
    fi
  done <<EOF
$(grep -rhoE 'pnpm --filter @actradeck/[a-z0-9-]+ (run )?[a-zA-Z][A-Za-z0-9:._-]*' "$@" 2>/dev/null | sort -u || true)
EOF
  printf '%s' "$drift"
}
DOCS_DRIFT="$(docs_script_parity "$ROOT" "$ROOT"/docs/*.md "$ROOT"/README.md)"
if [ -z "$DOCS_DRIFT" ]; then
  ok "INV-DOCS-SCRIPT-PARITY: every documented pnpm --filter command maps to a real package script"
else
  ng "INV-DOCS-SCRIPT-PARITY: documented commands reference missing scripts:$DOCS_DRIFT"
fi
# RED probe (falsifiable): a doc quoting a script that does not exist must be reported.
DSP="$WORK/docs-parity"; mkdir -p "$DSP"
printf '```bash\npnpm --filter @actradeck/telemetry-collector test\n```\n' > "$DSP/stale.md"
if [ -n "$(docs_script_parity "$ROOT" "$DSP/stale.md")" ]; then
  ok "INV-DOCS-SCRIPT-PARITY: gate FAILS on a doc referencing a renamed-away script (falsifiable)"
else
  ng "INV-DOCS-SCRIPT-PARITY: DEAD GATE — stale documented command passed"
fi

# ============================================================================
# INV-RELEASE-TAG-MATCHES-VERSION  (run version.sh in an isolated throwaway repo)
# ============================================================================
VR="$WORK/vrepo"
mkdir -p "$VR/scripts/lib" "$VR/db" "$VR/packages/p1" "$VR/apps/a1"
cp "$SELF/version.sh" "$VR/scripts/version.sh"
for d in . db packages/p1 apps/a1; do
  printf '{\n  "name": "x",\n  "version": "0.0.0",\n  "private": true\n}\n' > "$VR/$d/package.json"
done
printf '# Changelog\n\n## [Unreleased]\n\n- seed\n\n[Unreleased]: https://example/commits/main\n' > "$VR/CHANGELOG.md"
git -C "$VR" init -q
git -C "$VR" config user.email test@example.invalid
git -C "$VR" config user.name  test
git -C "$VR" add -A && git -C "$VR" commit -qm init
if "$VR/scripts/version.sh" 0.2.0 >"$WORK/version.log" 2>&1; then
  if git -C "$VR" rev-parse -q --verify refs/tags/v0.2.0 >/dev/null 2>&1; then
    ng "INV-TAG-MATCHES-VERSION: stamp phase tagged the pre-commit tree (must be tag-free)"
  elif ! versions_consistent "$VR" >/dev/null 2>&1; then
    ng "INV-TAG-MATCHES-VERSION: version.sh did not stamp 0.2.0 lockstep"
  else
    git -C "$VR" add -A && git -C "$VR" commit -qm "release: v0.2.0"
    if "$VR/scripts/version.sh" 0.2.0 --tag-only >>"$WORK/version.log" 2>&1 &&
       tag_matches_version "$VR" &&
       [ "$(git -C "$VR" rev-parse 'v0.2.0^{}')" = "$(git -C "$VR" rev-parse HEAD)" ]; then
      ok "INV-TAG-MATCHES-VERSION: stamp → commit → --tag-only points v0.2.0 at the 0.2.0 tree"
    else
      ng "INV-TAG-MATCHES-VERSION: tag-only did not bind v0.2.0 to the committed 0.2.0 tree (see $WORK/version.log)"
    fi
  fi
else
  ng "INV-TAG-MATCHES-VERSION: version.sh failed in isolated repo (see $WORK/version.log)"
fi
# RED: bump the version WITHOUT a matching tag -> the checker must fail.
tmp="$(jq '.version="0.3.0"' "$VR/package.json")"; printf '%s\n' "$tmp" > "$VR/package.json"
if tag_matches_version "$VR"; then
  ng "INV-TAG-MATCHES-VERSION: DEAD GATE — no v0.3.0 tag yet still matched"
else
  ok "INV-TAG-MATCHES-VERSION: gate FAILS when version has no matching tag (falsifiable)"
fi

# ============================================================================
# INV-SBOM-COVERS-PROD-DEPS  +  INV-SBOM-NO-RAW
# ============================================================================
SBOM="$WORK/sbom.cdx.json"
if sbom_generate "$ROOT" "$SBOM" 2>/dev/null && [ -s "$SBOM" ]; then
  ok "SBOM generated ($(jq '.components|length' "$SBOM") components) for coverage/no-raw checks"

  if sbom_covers_prod_deps "$SBOM" "$ROOT" >/dev/null 2>&1; then
    ok "INV-SBOM-COVERS-PROD-DEPS: SBOM covers every direct external prod dependency"
  else
    ng "INV-SBOM-COVERS-PROD-DEPS: SBOM is missing a prod dependency"
  fi
  # RED: drop a known prod dep (fastify) from the SBOM -> coverage must fail.
  jq '(.components) |= map(select(.name != "fastify"))' "$SBOM" > "$WORK/sbom.mut.json"
  if sbom_covers_prod_deps "$WORK/sbom.mut.json" "$ROOT" >/dev/null 2>&1; then
    ng "INV-SBOM-COVERS-PROD-DEPS: DEAD GATE — dropping fastify still passed"
  else
    ok "INV-SBOM-COVERS-PROD-DEPS: gate FAILS when a prod dep is dropped (falsifiable)"
  fi

  if sbom_scan_noraw "$SBOM" >/dev/null 2>&1; then
    ok "INV-SBOM-NO-RAW: generated SBOM carries no absolute path / secret shape"
  else
    ng "INV-SBOM-NO-RAW: generated SBOM tripped the NO-RAW scan"
  fi
  # RED: inject an absolute machine path into a component (not the maintainer path).
  jq '.components += [{"type":"library","name":"planted","version":"0","evidence":"/home/tester/leak/x"}]' \
     "$SBOM" > "$WORK/sbom.raw.json"
  if sbom_scan_noraw "$WORK/sbom.raw.json" >/dev/null 2>&1; then
    ng "INV-SBOM-NO-RAW: DEAD GATE — injected absolute path still passed"
  else
    ok "INV-SBOM-NO-RAW: gate FAILS on an injected absolute path (falsifiable)"
  fi
else
  ng "SBOM generation failed (need installed prod deps: run 'pnpm install') — coverage/no-raw untested"
fi

# ============================================================================
# INV-RELEASE-TARBALL-NO-LEAK
# ============================================================================
REL_TREE="$WORK/reltree"; mkdir -p "$REL_TREE"
if [ -f "$ROOT/scripts/prepare-oss.sh" ]; then
  # Private context: build the curated mirror from the CURRENT working tree (staged into
  # a throwaway index so uncommitted release changes are included), then scan it.
  IDX="$WORK/idx"; rm -f "$IDX"
  GIT_INDEX_FILE="$IDX" git -C "$ROOT" read-tree HEAD 2>/dev/null
  GIT_INDEX_FILE="$IDX" git -C "$ROOT" add -A 2>/dev/null
  TREE="$(GIT_INDEX_FILE="$IDX" git -C "$ROOT" write-tree 2>/dev/null)"
  if OSS_DIR="$REL_TREE" OSS_SOURCE_REF="$TREE" bash "$ROOT/scripts/prepare-oss.sh" >"$WORK/mirror.log" 2>&1; then
    : # mirror built
  else
    ng "INV-TARBALL-NO-LEAK: prepare-oss.sh failed to build a clean mirror (see $WORK/mirror.log)"
  fi
  SRC_DESC="curated mirror (prepare-oss.sh)"
else
  # Mirror context: the tree itself is sanitized; the release tarball is git archive HEAD.
  git -C "$ROOT" archive HEAD | tar -x -C "$REL_TREE"
  SRC_DESC="git archive HEAD (already-sanitized mirror)"
fi

if [ -n "$(ls -A "$REL_TREE" 2>/dev/null)" ]; then
  if tarball_no_leak "$REL_TREE" >/dev/null 2>&1; then
    ok "INV-TARBALL-NO-LEAK: release tree clean — $SRC_DESC"
  else
    ng "INV-TARBALL-NO-LEAK: release tree has a leak — $SRC_DESC"
  fi
  # TDA-1: the single-source SBOM lib MUST ship in the release tree (release.yml, which
  # runs inside the mirror, sources scripts/lib/sbom.sh to regenerate the SBOM). If it is
  # dropped by an .ossfilter regression, the mirror's release job breaks — pin it here.
  if [ -f "$REL_TREE/scripts/lib/sbom.sh" ]; then
    ok "INV-TARBALL-NO-LEAK: scripts/lib/sbom.sh ships in the release tree (release.yml can source it)"
  else
    ng "INV-TARBALL-NO-LEAK: scripts/lib/sbom.sh MISSING from release tree (.ossfilter regression — release.yml would break)"
  fi
  # RED (a): plant a forbidden internal file (works in both private and mirror mode).
  LK1="$WORK/leak1"; rm -rf "$LK1"; cp -a "$REL_TREE" "$LK1"; : > "$LK1/.env"
  if tarball_no_leak "$LK1" >/dev/null 2>&1; then
    ng "INV-TARBALL-NO-LEAK: DEAD GATE — planted .env still passed"
  else
    ok "INV-TARBALL-NO-LEAK: gate FAILS on a planted .env (falsifiable)"
  fi
  # RED (b): plant the MAINTAINER coupling path — only meaningful where the canonical
  # coupling lib is present (private). The vector is BUILT AT RUNTIME so this shipped
  # file carries no literal maintainer path. `H` holds "/home"; concatenation yields the
  # real coupling string only at execution time.
  if [ -f "$SELF/lib/oss-patterns.sh" ]; then
    LK2="$WORK/leak2"; rm -rf "$LK2"; cp -a "$REL_TREE" "$LK2"
    H="/home"; printf 'built at %s/%s/x\n' "$H" "owner" > "$LK2/README.leak.md"
    if tarball_no_leak "$LK2" >/dev/null 2>&1; then
      ng "INV-TARBALL-NO-LEAK: DEAD GATE — planted maintainer coupling path still passed"
    else
      ok "INV-TARBALL-NO-LEAK: gate FAILS on a planted maintainer coupling path (falsifiable)"
    fi
  fi
else
  ng "INV-TARBALL-NO-LEAK: could not materialize a release tree to scan"
fi

# ============================================================================
# INV-RELEASE-WORKFLOW-PERMS-MINIMAL
# ============================================================================
REL_YML="$ROOT/.github/workflows/release.yml"
if [ ! -f "$REL_YML" ]; then
  ng "INV-PERMS-MINIMAL: release.yml not found at $REL_YML"
elif ! command -v python3 >/dev/null 2>&1; then
  ng "INV-PERMS-MINIMAL: python3 required to parse the workflow"
else
  if perms_minimal "$REL_YML" >/dev/null 2>&1; then
    ok "INV-PERMS-MINIMAL: release.yml top-level permissions == {contents: read}"
  else
    ng "INV-PERMS-MINIMAL: release.yml top-level permissions are not minimal"
  fi
  # RED: promote a broad write to top-level -> the checker must fail.
  python3 - "$REL_YML" "$WORK/rel.mut.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
d["permissions"] = {"contents": "write"}
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
  if perms_minimal "$WORK/rel.mut.yml" >/dev/null 2>&1; then
    ng "INV-PERMS-MINIMAL: DEAD GATE — top-level contents:write still passed"
  else
    ok "INV-PERMS-MINIMAL: gate FAILS on top-level write (falsifiable)"
  fi
  # RED (QA-2): grant write to a NON-signing job (inject `packages: write` on verify) ->
  # the negative assert must fail (only the id-token+attestations job may hold write).
  python3 - "$REL_YML" "$WORK/rel.job.mut.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
jobs = d.get("jobs") or {}
# pick a non-release job (the first that isn't the signing job)
victim = next((n for n in jobs if n != "release"), None)
if victim is None:
    # no distinct job to mutate; write an obviously-bad file so the checker fails
    d["jobs"] = {"release": {}, "verify": {"permissions": {"packages": "write"}}}
else:
    jobs[victim]["permissions"] = {"packages": "write"}
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
  if perms_minimal "$WORK/rel.job.mut.yml" >/dev/null 2>&1; then
    ng "INV-PERMS-MINIMAL: DEAD GATE — write on a non-signing job still passed"
  else
    ok "INV-PERMS-MINIMAL: gate FAILS when a non-signing job holds write (falsifiable)"
  fi
  # RED (SEC-4): grant a SIGNING job an unexpected surplus write (id-token+attestations are
  # kept, so is_signing still holds) -> the subset check must fail.
  python3 - "$REL_YML" "$WORK/rel.surplus.mut.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
jobs = d.get("jobs") or {}
# find a signing job (id-token+attestations write) and add a surplus write to it
target = next((n for n, j in jobs.items()
               if (j.get("permissions") or {}).get("id-token") == "write"
               and (j.get("permissions") or {}).get("attestations") == "write"), None)
if target is None:
    d["jobs"] = {"release": {"permissions": {"id-token": "write", "attestations": "write",
                                             "actions": "write"}}}
else:
    jobs[target]["permissions"]["actions"] = "write"
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
  if perms_minimal "$WORK/rel.surplus.mut.yml" >/dev/null 2>&1; then
    ng "INV-PERMS-MINIMAL: DEAD GATE — surplus write on a signing job still passed"
  else
    ok "INV-PERMS-MINIMAL: gate FAILS when a signing job holds a surplus write (falsifiable)"
  fi
fi

# ============================================================================
# INV-GHCR-PUBLISH-GATED  (R4-M1b: the docker if: must AST-MATCH the CANONICAL_IF constant)
# ============================================================================
# Publish-gate defense is now THREE layers (honest framing — the closed-enum alone does NOT
# close it): (1) the closed-enum whitelist makes an ENUM-OUTSIDE bypass unexpressible; (2) but
# an ENUM-INSIDE weakening (`|| github.event_name != 'push'`, `|| vars.ENABLE_GHCR_PUBLISH != ''`)
# is closed-enum-valid and slips a 4-context SAMPLING matrix — so the SEMANTIC check here is an
# exact CANONICAL_IF AST-match: ANY deviation (weaken OR strengthen) breaks it; (3) the runtime
# publish guard (INV-PUBLISH-RUNTIME-GUARD) is the AUTHORITATIVE backstop that blocks the push
# even if the if: is changed. The closed-enum/evaluator/4-context matrix is retained to VALIDATE
# the CANONICAL_IF constant itself + as the parser unit test (INV-IF-GATE-PARSER).
CANONICAL_IF="startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true')"
if [ ! -f "$REL_YML" ] || ! command -v python3 >/dev/null 2>&1; then
  ng "INV-GHCR-PUBLISH-GATED: release.yml or python3 missing"
else
  # 1. the canonical constant is itself a valid closed-enum tag∧opt-in gate (validates the pin target).
  if if_gate_check_str "$CANONICAL_IF" >/dev/null 2>&1; then
    ok "INV-GHCR-PUBLISH-GATED: CANONICAL_IF is a valid closed-enum tag-gated form (pin target sound)"
  else
    ng "INV-GHCR-PUBLISH-GATED: CANONICAL_IF constant is itself malformed"
  fi
  # 2. release.yml docker if: must AST-match CANONICAL_IF exactly.
  canon_repr="$(if_ast_repr "$CANONICAL_IF")"
  real_if="$(docker_if_string "$REL_YML")"
  real_repr="$(if_ast_repr "$real_if" 2>/dev/null || echo PARSE_FAIL)"
  if [ "$real_repr" = "$canon_repr" ]; then
    ok "INV-GHCR-PUBLISH-GATED: release.yml docker if: AST-matches CANONICAL_IF"
  else
    ng "INV-GHCR-PUBLISH-GATED: release.yml docker if: DEVIATES from CANONICAL_IF — if you intentionally changed the gate, update the CANONICAL_IF constant in scripts/test-release-prep.sh in the SAME PR (2-point, review-visible change)"
  fi
  # RED (R4-M1c): SEC's A/C/D vectors inject a weakening disjunct INSIDE the opt-in group, so they
  # stay closed-enum-valid AND keep top-level && with a tag guard — i.e. they PASS if_gate_check_str
  # (the 4-context matrix samples only ref=v1.2.3, event∈{dispatch,push}, ENABLE∈{'',true}, so the
  # extra disjunct is true only OUTSIDE those samples: A=ENABLE set to anything non-empty like
  # 'false'/broken-disable, C=any non-push event on a tag, D=any tag != v1.2.3 = near-total bypass).
  # The canonical AST pin catches every one. Assert for each: (i) the evaluator ACCEPTS it (proves
  # the matrix alone is insufficient — the pin's whole reason), AND (ii) the AST pin BREAKS on it.
  pin_red=1; pin_n=0
  while IFS= read -r form; do
    [ -n "$form" ] || continue
    pin_n=$((pin_n + 1))
    if ! if_gate_check_str "$form" >/dev/null 2>&1; then
      ng "INV-GHCR-PUBLISH-GATED: SEC vector no longer slips the matrix (demonstration stale): $form"; pin_red=0
    fi
    wrepr="$(if_ast_repr "$form" 2>/dev/null || echo PARSE_FAIL)"
    if [ "$wrepr" = "$canon_repr" ]; then
      ng "INV-GHCR-PUBLISH-GATED: DEAD PIN — enum-inside weakening AST-matched canonical: $form"; pin_red=0
    fi
  done <<'FORMS'
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true' || vars.ENABLE_GHCR_PUBLISH != '')
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true' || github.event_name != 'push')
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true' || github.ref != 'refs/tags/v1.2.3')
FORMS
  [ "$pin_red" = 1 ] && ok "INV-GHCR-PUBLISH-GATED: canonical pin BREAKS on all $pin_n opt-in-group enum-inside weakenings that PASS the 4-ctx matrix (SEC A/C/D) (falsifiable)"
fi

# ============================================================================
# INV-PUBLISH-RUNTIME-GUARD  (R4-M1a: authoritative runtime backstop before the push)
# ============================================================================
# Symmetric with the leak face's real image scan: a step BEFORE push that fails closed unless
# tag∧opt-in truly holds. Even if if: is weakened, this blocks the push. The INV EXECUTES the
# guard's run body under the 8-context matrix (real behavior, not a structural guess).
if [ ! -f "$REL_YML" ] || ! command -v python3 >/dev/null 2>&1; then
  ng "INV-PUBLISH-RUNTIME-GUARD: release.yml or python3 missing"
else
  guard_run="$(docker_publish_guard_run "$REL_YML" 2>/dev/null)"; guard_present=$?
  if [ "$guard_present" -ne 0 ] || [ -z "$guard_run" ]; then
    ng "INV-PUBLISH-RUNTIME-GUARD: no runtime publish-guard step before the push step"
  else
    ok "INV-PUBLISH-RUNTIME-GUARD: guard step present before the push step"
    if guard_matrix_ok "$guard_run"; then
      ok "INV-PUBLISH-RUNTIME-GUARD: guard fails-closed correctly across the 8-context matrix"
    else
      ng "INV-PUBLISH-RUNTIME-GUARD: guard does not enforce tag∧opt-in (8-context mismatch)"
    fi
    # RED (R5-M1): guard-step NEUTRALIZATION forms the guard checker previously ignored — its
    # sibling scan checker already rejected `if: false` / `continue-on-error: true` (the
    # consolidation gap SEC-R5-1 ≡ QA-R5-1). Now that both share step_predicates, each of these
    # makes docker_publish_guard_run report "no valid guard" (exit non-zero). `always()` is
    # rejected because enabled() admits only a plain truthy constant (see step_predicates).
    guard_red_ok=1
    for m in \
      "guard_remove:removing the guard step" \
      "guard_disable:disabling the guard with if:false" \
      "guard_coe:continue-on-error:true on the guard" \
      "guard_coe_exprT:continue-on-error:\${{ true }} on the guard" \
      "guard_coe_exprC:continue-on-error:\${{ expr }} on the guard" \
      "guard_always:if:always() on the guard"; do
      op="${m%%:*}"; desc="${m#*:}"
      mutate_guard "$op" "$REL_YML" "$WORK/rel.$op.yml"
      if docker_publish_guard_run "$WORK/rel.$op.yml" >/dev/null 2>&1; then
        ng "INV-PUBLISH-RUNTIME-GUARD: DEAD GATE — $desc still passed"; guard_red_ok=0
      fi
    done
    [ "$guard_red_ok" = 1 ] && ok "INV-PUBLISH-RUNTIME-GUARD: gate FAILS on all 6 guard-neuter forms (remove / if:false / continue-on-error true/\${{ true }}/\${{ expr }} / always()) (falsifiable)"
    # NO OVER-REJECT (R6-M1): a provably-safe `continue-on-error: false` on the guard must NOT
    # be rejected (fail-closed must stay precise).
    mutate_guard guard_coe_false "$REL_YML" "$WORK/rel.guard_coe_false.yml"
    if docker_publish_guard_run "$WORK/rel.guard_coe_false.yml" >/dev/null 2>&1; then
      ok "INV-PUBLISH-RUNTIME-GUARD: continue-on-error:false is NOT over-rejected (fail-closed is precise)"
    else
      ng "INV-PUBLISH-RUNTIME-GUARD: OVER-REJECT — a safe continue-on-error:false guard was rejected"
    fi
    # RED: defang the guard's fail path (exit 1 -> exit 0) -> the 8-context matrix must mismatch.
    defanged="${guard_run//exit 1/exit 0}"
    if guard_matrix_ok "$defanged"; then
      ng "INV-PUBLISH-RUNTIME-GUARD: DEAD GATE — defanged guard (exit 1->exit 0) still matched"
    else
      ok "INV-PUBLISH-RUNTIME-GUARD: matrix FAILS when the guard fail path is defanged (falsifiable)"
    fi
    # RED: invert the opt-in condition (|| -> &&) -> the 8-context matrix must mismatch.
    inverted="${guard_run// || / && }"
    if guard_matrix_ok "$inverted"; then
      ng "INV-PUBLISH-RUNTIME-GUARD: DEAD GATE — inverted guard (|| -> &&) still matched"
    else
      ok "INV-PUBLISH-RUNTIME-GUARD: matrix FAILS when the guard condition is inverted (falsifiable)"
    fi
  fi
fi

# ============================================================================
# INV-IF-GATE-PARSER  (R3-L3 → R4: parser/evaluator unit tests — validate the pin target)
# ============================================================================
# These string-level tests keep the closed-enum + evaluator + 4-context matrix honest: they
# prove if_gate_check_str (which VALIDATES CANONICAL_IF above) accepts valid tag∧opt-in forms
# and rejects every malformed / weakened / enum-outside one. NOTE: rejecting an enum-OUTSIDE
# vector at parse time is real, but it is NOT the whole publish-gate defense — an enum-INSIDE
# weakening is caught by the canonical AST pin, and the runtime guard is the final backstop.
if ! command -v python3 >/dev/null 2>&1; then
  ng "INV-IF-GATE-PARSER: python3 required"
else
  ifp_ok=1
  while IFS= read -r good; do
    [ -n "$good" ] || continue
    if_gate_check_str "$good" >/dev/null 2>&1 || { ng "INV-IF-GATE-PARSER: wrongly REJECTED valid: $good"; ifp_ok=0; }
  done <<'GOOD'
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true')
startsWith(github.ref, 'refs/tags/') && (vars.ENABLE_GHCR_PUBLISH == 'true' || github.event_name == 'workflow_dispatch')
GOOD
  [ "$ifp_ok" = 1 ] && ok "INV-IF-GATE-PARSER: accepts valid closed-enum tag-gated forms"
  # INVALID forms (structural + behavioral-bypass) the evaluator must REJECT.
  ifp_bad=1; ifp_bn=0
  while IFS= read -r bad; do
    [ -n "$bad" ] || continue
    ifp_bn=$((ifp_bn + 1))
    if if_gate_check_str "$bad" >/dev/null 2>&1; then ng "INV-IF-GATE-PARSER: wrongly ACCEPTED invalid: $bad"; ifp_bad=0; fi
  done <<'BAD'
github.event_name == 'workflow_dispatch'
startsWith(github.ref, 'refs/tags/') || github.event_name == 'workflow_dispatch'
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || github.actor != '')
startsWith(github.ref, 'refs/tags/') && (github.event_name != 'workflow_dispatch')
true
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true') || true
startsWith(github.ref, 'refs/tags/') && (github.event_name != 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true')
true || (startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true'))
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_GHCR_PUBLISH == 'true') trailingtoken
BAD
  [ "$ifp_bad" = 1 ] && ok "INV-IF-GATE-PARSER: rejects all $ifp_bn invalid/bypass forms (no-guard / top-OR / enum-outside / negated / bare-true / ||true / AND→OR / true|| / trailing-token)"
  # ENUM-OUTSIDE weakeners appended to the canonical form — all rejected at PARSE time. Includes
  # freshly INVENTED siblings to show the class is closed (no denylist to keep updating).
  ifp_eo=1; ifp_en=0
  while IFS= read -r vec; do
    [ -n "$vec" ] || continue
    ifp_en=$((ifp_en + 1))
    if if_gate_check_str "$CANONICAL_IF $vec" >/dev/null 2>&1; then ng "INV-IF-GATE-PARSER: enum-outside vector ACCEPTED: $vec"; ifp_eo=0; fi
  done <<'VECS'
|| github.repository_owner == 'someorg'
|| github.actor != ''
|| 'false'
|| github.sha != ''
|| github.run_id != ''
|| secrets.FOO != ''
|| contains(github.event.head_commit.message, 'ship')
|| runner.os == 'Linux'
|| env.PUBLISH == '1'
|| always()
VECS
  [ "$ifp_eo" = 1 ] && ok "INV-IF-GATE-PARSER: rejects all $ifp_en enum-outside/bare-literal vectors at parse time (closed-enum class closed)"
fi

# ============================================================================
# npm-face invariants (decision 019f5131 — packages/cli is the sole publishable package)
# ============================================================================
# Shared pure checkers (operate on a package.json / tree / listing; no build required).
CLI_PKG="$ROOT/packages/cli/package.json"

# every packed path is on the allowlist {package.json, README.md, LICENSE, dist/**} AND none of
# the known path-leak / redundant artifacts:
#   - .tsbuildinfo (SEC/TDA): a tsc build-cache file that bakes ABSOLUTE filesystem paths (the
#     maintainer's home under a symlinked/pnpm node_modules) into the tarball.
#   - *.map (SEC-1): source/declaration maps embed source-tree paths and are useless to a CLI
#     consumer; disabled at the tsc level (sourceMap/declarationMap:false) AND forbidden here as
#     a structural backstop (a future tsconfig flip re-emitting them is caught).
# Capture-then-test (no `| grep -q`) to avoid the pipefail x SIGPIPE inversion on a match.
pack_allowlist_ok() {
  local listing="$1" bad tsb maps
  bad="$(printf '%s\n' "$listing" | grep -vE '^(package\.json|README\.md|LICENSE|dist/.+)$')" || true
  [ -n "$bad" ] && return 1
  tsb="$(printf '%s\n' "$listing" | grep -E '(^|/)\.tsbuildinfo$')" || true
  [ -n "$tsb" ] && return 1
  maps="$(printf '%s\n' "$listing" | grep -E '\.map$')" || true
  [ -n "$maps" ] && return 1
  return 0
}
# no install-time lifecycle script in <pkg.json> (postinstall etc. = supply-chain footgun)
no_lifecycle_ok() {
  local pj="$1" hit
  hit="$(jq -r '.scripts // {} | keys[]' "$pj" 2>/dev/null | grep -E '^(preinstall|install|postinstall|prepare|prepack)$')" || true
  [ -z "$hit" ]
}
# every non-cli workspace package.json under <r> is private:true; packages/cli is NOT private
private_guard_ok() {
  local r="$1" f priv clipriv
  clipriv="$(jq -r '.private // false' "$r/packages/cli/package.json" 2>/dev/null)"
  [ "$clipriv" = "true" ] && { echo "packages/cli must NOT be private (it is the publishable package)"; return 1; }
  for f in "$r"/package.json "$r"/db/package.json "$r"/packages/*/package.json "$r"/apps/*/package.json; do
    [ -f "$f" ] || continue
    case "$f" in
      "$r"/package.json) continue ;;            # root is a private, non-published workspace root
      "$r"/packages/cli/package.json) continue ;;
    esac
    priv="$(jq -r '.private // false' "$f")"
    [ "$priv" = "true" ] || { echo "non-cli workspace not private: $f"; return 1; }
  done
  return 0
}

# --- INV-NPM-PACK-ALLOWLIST -------------------------------------------------
# GREEN/RED on the allowlist LOGIC (falsifiable without a build); the REAL packed tarball is
# additionally checked in the tooling-guarded build block below.
if pack_allowlist_ok "$(printf 'package.json\nREADME.md\nLICENSE\ndist/index.js\ndist/lib/checksum.js\n')"; then
  ok "INV-NPM-PACK-ALLOWLIST: allowlist accepts {package.json, README.md, LICENSE, dist/**}"
else
  ng "INV-NPM-PACK-ALLOWLIST: allowlist wrongly REJECTED a valid packed listing"
fi
if pack_allowlist_ok "$(printf 'package.json\ndist/index.js\nsrc/secret.ts\n')"; then
  ng "INV-NPM-PACK-ALLOWLIST: DEAD GATE — an out-of-allowlist path (src/secret.ts) still passed"
else
  ok "INV-NPM-PACK-ALLOWLIST: gate FAILS on an out-of-allowlist path (falsifiable)"
fi
# RED: .tsbuildinfo (abs-path leak vector) must be rejected even though it sits under dist/.
if pack_allowlist_ok "$(printf 'package.json\ndist/index.js\ndist/.tsbuildinfo\n')"; then
  ng "INV-NPM-PACK-ALLOWLIST: DEAD GATE — dist/.tsbuildinfo (abs-path leak vector) still passed"
else
  ok "INV-NPM-PACK-ALLOWLIST: gate FAILS on a packed .tsbuildinfo (falsifiable)"
fi
# RED (SEC-1): a sourcemap/declaration-map must be rejected (path-embed vector; disabled at tsc).
if pack_allowlist_ok "$(printf 'package.json\ndist/index.js\ndist/index.js.map\n')"; then
  ng "INV-NPM-PACK-ALLOWLIST: DEAD GATE — dist/index.js.map (path-embed vector) still passed"
else
  ok "INV-NPM-PACK-ALLOWLIST: gate FAILS on a packed .map (SEC-1・falsifiable)"
fi
# leak-pattern RED (only meaningful where the canonical coupling lib is present = private): a
# planted coupling literal in a fake packed tree must be caught by the SHARED tarball_no_leak
# (which sources oss-patterns.sh). The vector is BUILT AT RUNTIME so THIS shipped file carries
# no literal maintainer path (H holds "/home"; the coupling string exists only at execution).
if [ -f "$SELF/lib/oss-patterns.sh" ]; then
  NPKL="$WORK/npmleak"; mkdir -p "$NPKL"
  H="/home"; printf 'const home = "%s/%s/secret";\n' "$H" "owner" > "$NPKL/planted.js"
  if tarball_no_leak "$NPKL" >/dev/null 2>&1; then
    ng "INV-NPM-PACK-ALLOWLIST: DEAD GATE — planted coupling literal not caught"
  else
    ok "INV-NPM-PACK-ALLOWLIST: leak scan FIRES on a planted coupling literal (falsifiable)"
  fi
fi

# --- INV-NPM-NO-LIFECYCLE ---------------------------------------------------
if [ -f "$CLI_PKG" ] && no_lifecycle_ok "$CLI_PKG"; then
  ok "INV-NPM-NO-LIFECYCLE: packages/cli declares no preinstall/install/postinstall/prepare/prepack"
else
  ng "INV-NPM-NO-LIFECYCLE: packages/cli carries an install-time lifecycle script (or is missing)"
fi
# RED: inject a postinstall into a copy -> the checker must fail.
if [ -f "$CLI_PKG" ]; then
  jq '.scripts.postinstall="curl evil | sh"' "$CLI_PKG" > "$WORK/cli-lifecycle.json"
  if no_lifecycle_ok "$WORK/cli-lifecycle.json"; then
    ng "INV-NPM-NO-LIFECYCLE: DEAD GATE — injected postinstall still passed"
  else
    ok "INV-NPM-NO-LIFECYCLE: gate FAILS on an injected postinstall (falsifiable)"
  fi
fi

# --- INV-NPM-PRIVATE-GUARD --------------------------------------------------
if private_guard_ok "$ROOT" >/dev/null 2>&1; then
  ok "INV-NPM-PRIVATE-GUARD: cli publishable; every other workspace is private:true"
else
  ng "INV-NPM-PRIVATE-GUARD: live tree violates the private-guard (see private_guard_ok output)"
fi
# RED (a): a non-cli workspace losing private:true must fail.
PGT="$WORK/pgtree"; mkdir -p "$PGT/packages/cli" "$PGT/apps/backend" "$PGT/db" "$PGT/packages/x"
printf '{"name":"actradeck"}\n'          > "$PGT/package.json"
printf '{"name":"actradeck"}\n'          > "$PGT/packages/cli/package.json"   # cli: not private (ok)
printf '{"private":true}\n'              > "$PGT/apps/backend/package.json"
printf '{"private":true}\n'              > "$PGT/db/package.json"
printf '{"private":true}\n'              > "$PGT/packages/x/package.json"
if private_guard_ok "$PGT" >/dev/null 2>&1; then : ; else ng "INV-NPM-PRIVATE-GUARD: over-strict — a valid synthetic tree was rejected"; fi
printf '{"name":"pub"}\n'                > "$PGT/apps/backend/package.json"    # remove private:true
if private_guard_ok "$PGT" >/dev/null 2>&1; then
  ng "INV-NPM-PRIVATE-GUARD: DEAD GATE — a non-cli workspace without private:true still passed"
else
  ok "INV-NPM-PRIVATE-GUARD: gate FAILS when a non-cli workspace drops private:true (falsifiable)"
fi
# RED (b): the cli becoming private:true (unpublishable) must fail.
printf '{"private":true}\n'              > "$PGT/apps/backend/package.json"    # restore
printf '{"private":true}\n'              > "$PGT/packages/cli/package.json"    # cli private == wrong
if private_guard_ok "$PGT" >/dev/null 2>&1; then
  ng "INV-NPM-PRIVATE-GUARD: DEAD GATE — cli marked private:true still passed"
else
  ok "INV-NPM-PRIVATE-GUARD: gate FAILS when cli is marked private:true (falsifiable)"
fi

# --- INV-NPM-VERSION-LOCKSTEP -----------------------------------------------
# (a) packages/cli is covered by the single-source version gate (versions_consistent).
VTC="$WORK/vtree-cli"; mkdir -p "$VTC"
( cd "$ROOT" && find . -maxdepth 3 -name package.json \
    -not -path './node_modules/*' -not -path '*/node_modules/*' \
    -exec cp --parents {} "$VTC/" \; ) 2>/dev/null
if versions_consistent "$VTC" >/dev/null 2>&1; then
  ok "INV-NPM-VERSION-LOCKSTEP: packages/cli version matches root (single-source consistent)"
else
  ng "INV-NPM-VERSION-LOCKSTEP: live tree versions already inconsistent (cli?)"
fi
if [ -f "$VTC/packages/cli/package.json" ]; then
  jq '.version="9.9.9"' "$VTC/packages/cli/package.json" > "$VTC/packages/cli/pj.tmp" && mv "$VTC/packages/cli/pj.tmp" "$VTC/packages/cli/package.json"
  if versions_consistent "$VTC" >/dev/null 2>&1; then
    ng "INV-NPM-VERSION-LOCKSTEP: DEAD GATE — a diverged packages/cli version still passed (cli not covered)"
  else
    ok "INV-NPM-VERSION-LOCKSTEP: gate FAILS when packages/cli diverges (cli IS covered, falsifiable)"
  fi
else
  ng "INV-NPM-VERSION-LOCKSTEP: packages/cli/package.json missing from the version glob"
fi
# (b) packages/cli is in scripts/version.sh's stamp set (packages/* glob) — dry-run enumerates it.
LSR="$WORK/lockstep-repo"; mkdir -p "$LSR/scripts" "$LSR/packages/cli" "$LSR/packages/other" "$LSR/db" "$LSR/apps/a"
cp "$SELF/version.sh" "$LSR/scripts/version.sh"
for d in . packages/cli packages/other db apps/a; do
  printf '{"name":"x","version":"0.0.0","private":true}\n' > "$LSR/$d/package.json"
done
printf '# Changelog\n\n## [Unreleased]\n\n[Unreleased]: https://github.com/actradeck/actradeck/compare/v0.0.0...HEAD\n' > "$LSR/CHANGELOG.md"
lsr_out="$(cd "$LSR" && bash scripts/version.sh 0.2.0 --dry-run --no-tag 2>&1)" || true
if printf '%s' "$lsr_out" | grep -q 'packages/cli/package.json'; then
  ok "INV-NPM-VERSION-LOCKSTEP: version.sh stamp set includes packages/cli (dry-run enumerates it)"
else
  ng "INV-NPM-VERSION-LOCKSTEP: version.sh does NOT enumerate packages/cli in its stamp set"
fi

# --- INV-NPM-DEFAULT-REPO-SYNC (TDA-3) --------------------------------------
# repo.ts's DEFAULT_REPO is a third copy of the canonical OSS_DEFAULT_REPO (a dependency-free
# published package can't source shell libs). Assert they agree so the default mirror can't
# drift across tiers. Guarded ONLY on oss-patterns.sh presence (absent in the mirror, where this
# shipped meta-test self-adapts); when present, the repo.ts file MUST exist and be read — a
# missing path is a FAILURE (ng), never a silent skip (a wrong path would otherwise mask drift).
# Falsifiable: change the repo.ts literal -> RED.
REPO_TS="$ROOT/packages/cli/src/lib/repo.ts"
if [ -f "$SELF/lib/oss-patterns.sh" ]; then
  # shellcheck source=lib/oss-patterns.sh
  . "$SELF/lib/oss-patterns.sh"
  if [ ! -f "$REPO_TS" ]; then
    ng "INV-NPM-DEFAULT-REPO-SYNC: $REPO_TS not found (moved/renamed?) — cannot verify default-repo sync"
  else
    repo_ts_default="$(grep -oE 'DEFAULT_REPO = "[^"]+"' "$REPO_TS" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
    if [ -n "$repo_ts_default" ] && [ "$repo_ts_default" = "$OSS_DEFAULT_REPO" ]; then
      ok "INV-NPM-DEFAULT-REPO-SYNC: repo.ts DEFAULT_REPO == OSS_DEFAULT_REPO ($OSS_DEFAULT_REPO)"
    else
      ng "INV-NPM-DEFAULT-REPO-SYNC: repo.ts DEFAULT_REPO ('$repo_ts_default') != OSS_DEFAULT_REPO ('$OSS_DEFAULT_REPO') — cross-tier drift"
    fi
  fi
fi

# --- INV-NPM-PUBLISH-GATED  (two-layer: AST pin + runtime guard) ------------
# TDA-R2-1: CANONICAL_NPM_IF is an INTENTIONAL parallel duplicate of CANONICAL_IF (docker), and
# differs ONLY in the opt-in var (ENABLE_NPM_PUBLISH vs ENABLE_GHCR_PUBLISH). It is deliberately
# NOT parameterized into one templated constant: each gate's pin should be a literal, self-evident
# expression a reviewer can read at a glance (the runtime-guard DRIVER is shared/parameterized;
# the PIN target stays literal per job). If either canonical changes, update it in the same PR.
CANONICAL_NPM_IF="startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_NPM_PUBLISH == 'true')"
if [ ! -f "$REL_YML" ] || ! command -v python3 >/dev/null 2>&1; then
  ng "INV-NPM-PUBLISH-GATED: release.yml or python3 missing"
else
  # 1. the npm canonical is a valid closed-enum tag∧opt-in gate (validates the pin target).
  if if_gate_check_str "$CANONICAL_NPM_IF" >/dev/null 2>&1; then
    ok "INV-NPM-PUBLISH-GATED: CANONICAL_NPM_IF is a valid closed-enum tag-gated form (pin target sound)"
  else
    ng "INV-NPM-PUBLISH-GATED: CANONICAL_NPM_IF constant is itself malformed"
  fi
  # 2. release.yml npm if: must AST-match CANONICAL_NPM_IF exactly.
  canon_npm_repr="$(if_ast_repr "$CANONICAL_NPM_IF")"
  real_npm_if="$(npm_if_string "$REL_YML")"
  real_npm_repr="$(if_ast_repr "$real_npm_if" 2>/dev/null || echo PARSE_FAIL)"
  if [ "$real_npm_repr" = "$canon_npm_repr" ]; then
    ok "INV-NPM-PUBLISH-GATED: release.yml npm if: AST-matches CANONICAL_NPM_IF"
  else
    ng "INV-NPM-PUBLISH-GATED: release.yml npm if: DEVIATES from CANONICAL_NPM_IF — if you intentionally changed the gate, update CANONICAL_NPM_IF in scripts/test-release-prep.sh in the SAME PR"
  fi
  # 3. enum-inside weakenings (A/C/D with the npm var) break the AST pin.
  npm_pin_red=1; npm_pin_n=0
  while IFS= read -r form; do
    [ -n "$form" ] || continue
    npm_pin_n=$((npm_pin_n + 1))
    wrepr="$(if_ast_repr "$form" 2>/dev/null || echo PARSE_FAIL)"
    [ "$wrepr" = "$canon_npm_repr" ] && { ng "INV-NPM-PUBLISH-GATED: DEAD PIN — enum-inside weakening AST-matched canonical: $form"; npm_pin_red=0; }
  done <<'FORMS'
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_NPM_PUBLISH == 'true' || vars.ENABLE_NPM_PUBLISH != '')
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_NPM_PUBLISH == 'true' || github.event_name != 'push')
startsWith(github.ref, 'refs/tags/') && (github.event_name == 'workflow_dispatch' || vars.ENABLE_NPM_PUBLISH == 'true' || github.ref != 'refs/tags/v1.2.3')
FORMS
  [ "$npm_pin_red" = 1 ] && ok "INV-NPM-PUBLISH-GATED: canonical pin BREAKS on all $npm_pin_n opt-in-group enum-inside weakenings (falsifiable)"
  # 4. runtime publish guard: present before `npm publish`, fails-closed across the 4-ctx matrix,
  #    and RED on remove / defang (exit 1->0) / invert (|| -> &&).
  npm_guard_run="$(npm_publish_guard_run "$REL_YML" 2>/dev/null)"; npm_guard_present=$?
  if [ "$npm_guard_present" -ne 0 ] || [ -z "$npm_guard_run" ]; then
    ng "INV-NPM-PUBLISH-GATED: no runtime publish-guard step before the npm publish step"
  else
    ok "INV-NPM-PUBLISH-GATED: runtime publish-guard present before npm publish"
    if npm_guard_matrix_ok "$npm_guard_run"; then
      ok "INV-NPM-PUBLISH-GATED: guard fails-closed correctly across the 8-context matrix (2nd tag / broken-disable / schedule)"
    else
      ng "INV-NPM-PUBLISH-GATED: guard does not enforce tag∧opt-in (8-context mismatch)"
    fi
    # mutation_applied contract (QA-3): a mutation that silently no-ops would make the RED probe
    # pass VACUOUSLY (gate "correctly fails" for the WRONG reason). Require each mutation to be
    # genuinely applied first — the file mutation via `cmp -s` against a yaml-roundtrip baseline,
    # the in-string mutations via a plain string-inequality (symmetric with the docker harness).
    NPM_BASELINE="$WORK/rel.npm.baseline.yml"
    python3 -c 'import sys,yaml; yaml.safe_dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],"w"))' "$REL_YML" "$NPM_BASELINE"
    npm_mutation_applied() { [ "$2" -eq 0 ] && [ -f "$1" ] && ! cmp -s "$1" "$NPM_BASELINE"; }
    # RED (remove): drop the guard step -> npm_publish_guard_run reports no valid guard.
    python3 - "$REL_YML" "$WORK/rel.npm.noguard.yml" <<'PY'
import sys, os, yaml
sys.path.insert(0, os.environ["SP_DIR"]); import step_predicates as sp
d = yaml.safe_load(open(sys.argv[1]))
job = (d.get("jobs") or {}).get("npm") or {}
job["steps"] = [s for s in (job.get("steps") or []) if not sp.is_guard(s)]
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
    nmrc=$?
    if ! npm_mutation_applied "$WORK/rel.npm.noguard.yml" "$nmrc"; then
      ng "INV-NPM-PUBLISH-GATED: HARNESS — guard-remove mutation did not apply (rc=$nmrc / missing / ==baseline)"
    elif npm_publish_guard_run "$WORK/rel.npm.noguard.yml" >/dev/null 2>&1; then
      ng "INV-NPM-PUBLISH-GATED: DEAD GATE — removing the guard step still passed"
    else
      ok "INV-NPM-PUBLISH-GATED: gate FAILS when the guard step is removed (mutation applied → falsifiable)"
    fi
    # RED (defang): exit 1 -> exit 0 makes the matrix mismatch. Assert the mutation actually changed
    # the body (else a guard without `exit 1` would make this vacuously green).
    npm_defanged="${npm_guard_run//exit 1/exit 0}"
    if [ "$npm_defanged" = "$npm_guard_run" ]; then
      ng "INV-NPM-PUBLISH-GATED: HARNESS — defang mutation did not change the guard body (no 'exit 1'?)"
    elif npm_guard_matrix_ok "$npm_defanged"; then
      ng "INV-NPM-PUBLISH-GATED: DEAD GATE — defanged guard (exit 1->exit 0) still matched"
    else
      ok "INV-NPM-PUBLISH-GATED: matrix FAILS when the guard fail path is defanged (mutation applied → falsifiable)"
    fi
    # RED (invert): || -> && makes the matrix mismatch. Assert the mutation actually changed the body.
    npm_inverted="${npm_guard_run// || / && }"
    if [ "$npm_inverted" = "$npm_guard_run" ]; then
      ng "INV-NPM-PUBLISH-GATED: HARNESS — invert mutation did not change the guard body (no ' || '?)"
    elif npm_guard_matrix_ok "$npm_inverted"; then
      ng "INV-NPM-PUBLISH-GATED: DEAD GATE — inverted guard (|| -> &&) still matched"
    else
      ok "INV-NPM-PUBLISH-GATED: matrix FAILS when the guard condition is inverted (mutation applied → falsifiable)"
    fi
  fi
fi

# --- INV-NPM-EXEC-E2E  (isolated HOME: pack -> global install -> run the real bin) ---
# Environment-dependent (needs npm + pnpm + an installed workspace). When present (CI + dev)
# it builds the CLI, packs a REAL tarball, installs it into an isolated prefix/HOME, runs the
# real `actradeck` bin, AND re-scans the packed tarball against the allowlist + leak patterns
# for real. When the toolchain is absent it prints an informational SKIP (the config-level
# npm INVs above still ran, falsifiably).
if command -v npm >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && [ -d "$ROOT/node_modules" ] && [ -f "$CLI_PKG" ]; then
  E2E="$WORK/npm-e2e"; mkdir -p "$E2E/home" "$E2E/prefix" "$E2E/pack"
  if pnpm --filter ./packages/cli run build >/dev/null 2>&1; then
    if ( cd "$ROOT/packages/cli" && npm pack --pack-destination "$E2E/pack" >/dev/null 2>&1 ); then
      NPM_TGZ="$(find "$E2E/pack" -name '*.tgz' -print -quit)"
      # REAL packed tarball: allowlist + leak (authoritative, alongside the logic checks above).
      real_listing="$(tar tzf "$NPM_TGZ" | sed 's#^package/##' | grep -v '^$')" || true
      if pack_allowlist_ok "$real_listing"; then
        ok "INV-NPM-PACK-ALLOWLIST: REAL npm pack tarball is within the allowlist (built + packed)"
      else
        ng "INV-NPM-PACK-ALLOWLIST: REAL npm pack tarball ships a file outside the allowlist"
      fi
      # The conformance bundle (esbuild output) MUST be packed and MUST be a plain dist/** .js with
      # no sibling .map (capture-then-test; no `| grep -q` per the header convention).
      bundle_hit="$(printf '%s\n' "$real_listing" | grep -E '^dist/lib/conformance-core\.js$')" || true
      if [ -n "$bundle_hit" ]; then
        ok "INV-NPM-PACK-ALLOWLIST: REAL tarball ships the conformance bundle (dist/lib/conformance-core.js)"
      else
        ng "INV-NPM-PACK-ALLOWLIST: REAL tarball is MISSING the conformance bundle (dist/lib/conformance-core.js)"
      fi
      bundle_map="$(printf '%s\n' "$real_listing" | grep -E '^dist/lib/conformance-core\.js\.map$')" || true
      if [ -z "$bundle_map" ]; then
        ok "INV-NPM-PACK-ALLOWLIST: no sourcemap emitted alongside the conformance bundle"
      else
        ng "INV-NPM-PACK-ALLOWLIST: a sourcemap was packed next to the conformance bundle (forbidden)"
      fi
      # SEC-2: the bundled MIT deps (zod + uuid) ship no inline license comment, so their notices
      # are collected into dist/THIRD-PARTY-NOTICES.txt — it MUST be packed and MUST carry an MIT
      # permission notice (attribution requirement of the redistributed npm artifact).
      notices_hit="$(printf '%s\n' "$real_listing" | grep -E '^dist/THIRD-PARTY-NOTICES\.txt$')" || true
      if [ -n "$notices_hit" ]; then
        notices_txt="$(tar -xzOf "$NPM_TGZ" package/dist/THIRD-PARTY-NOTICES.txt 2>/dev/null)" || true
        mit_hit="$(printf '%s' "$notices_txt" | grep -icE 'permission is hereby granted')" || true
        if [ "${mit_hit:-0}" -ge 1 ]; then
          ok "INV-NPM-PACK-ALLOWLIST: THIRD-PARTY-NOTICES packed with the bundled-deps MIT notice(s)"
        else
          ng "INV-NPM-PACK-ALLOWLIST: THIRD-PARTY-NOTICES packed but carries NO MIT permission notice"
        fi
      else
        ng "INV-NPM-PACK-ALLOWLIST: THIRD-PARTY-NOTICES.txt is MISSING from the packed tarball"
      fi
      NPX="$E2E/pack/x"; mkdir -p "$NPX"; tar xzf "$NPM_TGZ" -C "$NPX"
      # SHARED checker (forbidden files + coupling scan when oss-patterns.sh is present) — no
      # literal coupling pattern in this shipped file.
      if tarball_no_leak "$NPX" >/dev/null 2>&1; then
        ok "INV-NPM-PACK-ALLOWLIST: REAL npm pack tarball is leak-clean (forbidden-file + coupling scan)"
      else
        ng "INV-NPM-PACK-ALLOWLIST: REAL npm pack tarball tripped the leak scan"
      fi
      # isolated global install + run the real bin.
      if HOME="$E2E/home" npm install -g --prefix "$E2E/prefix" "$NPM_TGZ" >/dev/null 2>&1; then
        NPM_BIN="$E2E/prefix/bin/actradeck"
        ver_out="$(HOME="$E2E/home" "$NPM_BIN" version 2>&1)" || true
        doc_out="$(HOME="$E2E/home" "$NPM_BIN" doctor 2>&1)" || true
        rootv="$(jq -r '.version' "$ROOT/package.json")"
        if printf '%s' "$ver_out" | grep -qF "actradeck $rootv"; then
          ok "INV-NPM-EXEC-E2E: installed bin 'actradeck version' prints the packaged version ($rootv)"
        else
          ng "INV-NPM-EXEC-E2E: installed bin did not print 'actradeck $rootv' (got: $(printf '%s' "$ver_out" | head -1))"
        fi
        if printf '%s' "$doc_out" | grep -qE '\] (platform|node)'; then
          ok "INV-NPM-EXEC-E2E: installed bin 'actradeck doctor' runs and reports checks"
        else
          ng "INV-NPM-EXEC-E2E: installed bin 'actradeck doctor' produced no diagnostic table"
        fi
      else
        ng "INV-NPM-EXEC-E2E: isolated 'npm install -g' of the packed tarball failed"
      fi
    else
      ng "INV-NPM-EXEC-E2E: npm pack of packages/cli failed"
    fi
  else
    ng "INV-NPM-EXEC-E2E: could not build packages/cli (pnpm --filter ./packages/cli run build failed)"
  fi
else
  echo "SKIP  INV-NPM-EXEC-E2E / REAL pack: npm/pnpm/node or node_modules absent — config-level npm INVs above still ran (falsifiable)."
fi

# --- INV-NPM-CLI-BUNDLE-SELF-CONTAINED --------------------------------------
# The `conformance` subcommand's checker is @actradeck/event-model's `checkConformance` BUNDLED
# into dist at build time (esbuild-wasm · decision 019f739f), so the published `actradeck` stays
# dependency-zero (ADR 019f5131) and event-model stays private. Prove the built dist is genuinely
# SELF-CONTAINED: copied into a dir with ZERO node_modules and NO package dependencies, the
# conformance code path still runs — it resolves neither `@actradeck/*` nor a bare `zod`/`uuid` at
# runtime (everything is inlined). Falsifiable: a mutant bundle that DID import a bare module must
# fail in the same isolated dir. Environment-dependent (needs node + pnpm + an installed workspace);
# informational SKIP otherwise (the config-level INVs above still ran).
if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1 && [ -d "$ROOT/node_modules" ] && [ -f "$CLI_PKG" ]; then
  if pnpm --filter ./packages/cli run build >/dev/null 2>&1; then
    BND="$ROOT/packages/cli/dist/lib/conformance-core.js"
    if [ -f "$BND" ]; then
      ok "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: build emitted the conformance bundle (dist/lib/conformance-core.js)"
      # STATIC: the bundle inlines its whole closure — no residual external import specifier for
      # @actradeck/*, zod, or uuid (minified esbuild output uses from"x"/require("x")). Capture-then-
      # test; the file is scanned directly (no pipe from a heavy producer).
      ext_hit="$(grep -oE 'from"@actradeck/[^"]+"|from"zod"|require\("zod"\)|from"uuid"|require\("uuid"\)' "$BND")" || true
      if [ -z "$ext_hit" ]; then
        ok "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: bundle carries NO external @actradeck/zod/uuid import (inlined)"
      else
        ng "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: bundle still references an external module ($ext_hit)"
      fi
      # falsifiable: the same scan MUST fire on a bare-zod import (else the scan is dead).
      probe='import{z}from"zod";const a=1;'
      probe_hit="$(printf '%s' "$probe" | grep -oE 'from"zod"')" || true
      if [ -n "$probe_hit" ]; then
        ok "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: external-import scan FIRES on a bare zod import (falsifiable)"
      else
        ng "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: DEAD SCAN — a bare zod import was not detected"
      fi
      # RUNTIME: copy dist into a ZERO-node_modules dir (under /tmp WORK, no ancestor node_modules)
      # and run the checker end to end over the real fixtures.
      ISO="$WORK/bundle-iso"; rm -rf "$ISO"; mkdir -p "$ISO"
      cp -r "$ROOT/packages/cli/dist" "$ISO/dist"
      printf '{"name":"iso","version":"0.0.0","type":"module","bin":{"actradeck":"dist/index.js"}}\n' > "$ISO/package.json"
      VALIDJL="$ROOT/docs/examples/conformance/valid.jsonl"
      INVALIDJL="$ROOT/docs/examples/conformance/invalid.jsonl"
      iso_ok=1
      vout="$(node "$ISO/dist/index.js" conformance "$VALIDJL" 2>/dev/null)"; vcode=$?
      vpass="$(printf '%s' "$vout" | grep -E '^PASS')" || true
      [ -n "$vpass" ] && [ "$vcode" -eq 0 ] || iso_ok=0
      ivout="$(node "$ISO/dist/index.js" conformance "$INVALIDJL" 2>/dev/null)"; ivcode=$?
      ivfail="$(printf '%s' "$ivout" | grep -E '^FAIL')" || true
      [ -n "$ivfail" ] && [ "$ivcode" -eq 1 ] || iso_ok=0
      if [ "$iso_ok" -eq 1 ]; then
        ok "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: dist runs conformance with ZERO node_modules (valid->PASS/0, invalid->FAIL/1)"
      else
        ng "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: dist FAILED to run conformance without node_modules (vcode=$vcode ivcode=$ivcode)"
      fi
      # falsifiable: a MUTANT bundle that imports a bare `zod` must FAIL in the SAME isolated dir
      # (ERR_MODULE_NOT_FOUND) — proving the isolation genuinely denies external resolution (not a
      # vacuous PASS because node_modules happened to be reachable).
      MUT="$WORK/bundle-iso-mut"; rm -rf "$MUT"; mkdir -p "$MUT/dist"
      cp -r "$ROOT/packages/cli/dist/." "$MUT/dist/"
      { printf 'import"zod";\n'; cat "$BND"; } > "$MUT/dist/lib/conformance-core.js"
      printf '{"name":"iso","version":"0.0.0","type":"module"}\n' > "$MUT/package.json"
      node "$MUT/dist/index.js" conformance "$VALIDJL" >/dev/null 2>&1; mcode=$?
      if [ "$mcode" -ne 0 ]; then
        ok "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: mutant bundle importing bare zod FAILS in the isolated dir (isolation is real -> falsifiable)"
      else
        ng "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: DEAD GATE — mutant bundle with bare zod still ran (isolation not enforced)"
      fi
    else
      ng "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: build did NOT emit dist/lib/conformance-core.js"
    fi
  else
    ng "INV-NPM-CLI-BUNDLE-SELF-CONTAINED: could not build packages/cli (pnpm --filter ./packages/cli run build failed)"
  fi
else
  echo "SKIP  INV-NPM-CLI-BUNDLE-SELF-CONTAINED: node/pnpm/node_modules absent — config-level npm INVs above still ran."
fi

# --- INV-NPM-CLI-TYPE-MIRROR (TDA-1) ----------------------------------------
# The CLI ships a LOCAL mirror of event-model's conformance report types (dep-zero: it cannot
# import the private event-model at build time). A compile-time bidirectional `Equal<>` assertion
# (packages/cli/test/conformance-types.type-test.ts, run by `type-check:test`) ties the mirror to
# the canonical exports — the output-equivalence E2E canNOT catch a type drift (both sides call the
# same runtime checker). Assert the live assertion is GREEN, and prove the mechanism is FALSIFIABLE
# without mutating the tracked tree (a copy of the real mirror + a deliberately WRONG `Equal<>` must
# make tsc RED).
if command -v pnpm >/dev/null 2>&1 && [ -d "$ROOT/node_modules" ] && [ -f "$CLI_PKG" ] && jq -e '.scripts["type-check:test"]' "$CLI_PKG" >/dev/null 2>&1; then
  if pnpm --filter ./packages/cli run type-check:test >/dev/null 2>&1; then
    ok "INV-NPM-CLI-TYPE-MIRROR: mirror<->canonical type-equivalence holds (type-check:test green)"
  else
    ng "INV-NPM-CLI-TYPE-MIRROR: type-check:test FAILED — the local mirror drifted from event-model canonical"
  fi
  TM="$WORK/typemirror"; rm -rf "$TM"; mkdir -p "$TM"
  cp "$ROOT/packages/cli/src/lib/conformance-types.ts" "$TM/mirror.ts"
  cat > "$TM/probe.ts" <<'PROBE'
import type { ConformanceReport } from "./mirror.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// WRONG on purpose: the canonical report is far richer than { total }, so Equal<> is `false`.
const bad: Equal<ConformanceReport, { total: number }> = true;
void bad;
PROBE
  cat > "$TM/tsconfig.json" <<'TSC'
{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true, "skipLibCheck": true }, "include": ["probe.ts", "mirror.ts"] }
TSC
  if pnpm --filter ./packages/cli exec tsc -p "$TM/tsconfig.json" >/dev/null 2>&1; then
    ng "INV-NPM-CLI-TYPE-MIRROR: DEAD GATE — a wrong-shape Equal<> assertion still type-checked"
  else
    ok "INV-NPM-CLI-TYPE-MIRROR: Equal<> assertion FAILS on a wrong report shape (mechanism live -> falsifiable)"
  fi
else
  echo "SKIP  INV-NPM-CLI-TYPE-MIRROR: pnpm/node_modules/type-check:test absent."
fi

# --- INV-NPM-TS-SHELL-PARITY (TDA-2) ----------------------------------------
# The CLI (TypeScript) and scripts/install.sh (POSIX sh) each implement the SAME verify
# primitives: expected_digest_for / verify_sha256 (byte-identical digest semantics) and the
# owner/name reduction (repo_slug / repoSlug). Feed IDENTICAL vectors to both and assert equal
# outputs, so a change to one that silently diverges from the other is caught. `inst` sources
# install.sh's pure helpers (ACTRADECK_INSTALL_SOURCE_ONLY=1); `tseval` runs the built CLI dist.
# PARITY DOMAIN for repo_slug: FULL URLs with a host (install.sh's real input; the shell helper
# defers shape validation to its caller and does NOT handle bare `owner/name` or scp `host:o/r`,
# whereas the TS repoSlug validates inline — those inputs are out of the shared domain by design).
# PARITY DOMAIN for digests: SPACE-FREE asset names (real release assets are actradeck-X.Y.Z.*).
# A name containing whitespace parses differently by design (awk `$2` = first token vs TS `(.+)` =
# rest-of-line) — out of the shared domain; both sides stay fail-closed for the real (space-free)
# query names, and the tarball itself is anchored by attestation before the checksums parse
# (SEC-1 accepted-risk, 裁定 019f5606).
if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1 && [ -d "$ROOT/node_modules" ] && [ -f "$ROOT/packages/cli/package.json" ]; then
  if pnpm --filter ./packages/cli run build >/dev/null 2>&1; then
    TSJS="$WORK/ts-eval.mjs"
    cat > "$TSJS" <<'JS'
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const cli = process.argv[2];
const { repoSlug } = await import(pathToFileURL(cli + "/dist/lib/repo.js").href);
const { expectedDigestFor, verifySha256 } = await import(pathToFileURL(cli + "/dist/lib/checksum.js").href);
const op = process.argv[3], a = process.argv.slice(4);
if (op === "repo_slug") process.stdout.write(repoSlug(a[0]) ?? "");
else if (op === "expected_digest_for") process.stdout.write(expectedDigestFor(readFileSync(a[0], "utf8"), a[1]) ?? "");
else if (op === "verify_sha256") process.stdout.write(verifySha256(readFileSync(a[0]), a[1] || null) ? "true" : "false");
JS
    tseval() { node "$TSJS" "$ROOT/packages/cli" "$@"; }
    shv()   { inst verify_sha256 "$1" "$2" >/dev/null 2>&1 && echo true || echo false; }

    P_OK=1; P_N=0
    parity() { # $1=label $2=shell_out $3=ts_out
      P_N=$((P_N + 1))
      [ "$2" = "$3" ] || { ng "INV-NPM-TS-SHELL-PARITY: MISMATCH on $1 (shell='$2' ts='$3')"; P_OK=0; }
    }

    # digest vectors -----------------------------------------------------------
    PARF="$WORK/parity"; mkdir -p "$PARF"
    CONTENT="$PARF/actradeck-0.4.0.tar.gz"; printf 'parity-content\n' > "$CONTENT"
    DGT="$(sha256sum "$CONTENT" | cut -d' ' -f1)"
    CSF="$PARF/checksums.txt"; printf '%s  actradeck-0.4.0.tar.gz\n%s  other.bin\n' "$DGT" "0000000000000000000000000000000000000000000000000000000000000000" > "$CSF"
    parity "expected_digest_for(present)" "$(inst expected_digest_for "$CSF" actradeck-0.4.0.tar.gz)" "$(tseval expected_digest_for "$CSF" actradeck-0.4.0.tar.gz)"
    parity "expected_digest_for(absent)"  "$(inst expected_digest_for "$CSF" nope.tar.gz)"           "$(tseval expected_digest_for "$CSF" nope.tar.gz)"
    parity "verify_sha256(match)"    "$(shv "$CONTENT" "$DGT")"                    "$(tseval verify_sha256 "$CONTENT" "$DGT")"
    parity "verify_sha256(mismatch)" "$(shv "$CONTENT" 0000000000000000000000000000000000000000000000000000000000000000)" "$(tseval verify_sha256 "$CONTENT" 0000000000000000000000000000000000000000000000000000000000000000)"
    parity "verify_sha256(empty)"    "$(shv "$CONTENT" "")"                        "$(tseval verify_sha256 "$CONTENT" "")"
    # QA-R2-1a — UPPERCASE-hex checksums: both sides must NORMALIZE case (a hex digest is
    # case-insensitive). expected_digest_for must return the SAME (lowercased) digest; verify_sha256
    # must ACCEPT an uppercase expected. (pre-fix: shell was case-sensitive -> divergence.)
    UP="$(printf '%s' "$DGT" | tr 'a-f' 'A-F')"
    CSU="$PARF/checksums.upper.txt"; printf '%s  actradeck-0.4.0.tar.gz\n' "$UP" > "$CSU"
    parity "expected_digest_for(upper-hex)" "$(inst expected_digest_for "$CSU" actradeck-0.4.0.tar.gz)" "$(tseval expected_digest_for "$CSU" actradeck-0.4.0.tar.gz)"
    parity "verify_sha256(upper-expected)"  "$(shv "$CONTENT" "$UP")"                                   "$(tseval verify_sha256 "$CONTENT" "$UP")"
    # QA-R2-1b — CRLF checksums: expected_digest_for must find the digest despite \r\n line endings.
    # (pre-fix: shell awk saw `name\r` != `name` -> not found -> divergence.)
    CSC="$PARF/checksums.crlf.txt"; printf '%s  actradeck-0.4.0.tar.gz\r\n%s  other.bin\r\n' "$DGT" "0000000000000000000000000000000000000000000000000000000000000000" > "$CSC"
    parity "expected_digest_for(crlf)" "$(inst expected_digest_for "$CSC" actradeck-0.4.0.tar.gz)" "$(tseval expected_digest_for "$CSC" actradeck-0.4.0.tar.gz)"
    # SEC-R3-1 — an INTERIOR \r must stay significant on BOTH sides (fail-closed together).
    # (pre-fix: the shell's gsub deleted interior \r so `…gz\rX` matched a query `…gzX` while
    # the TS `.trim()` kept it -> divergence. trailing-only sub() restores parity.)
    CSI="$PARF/checksums.interior.txt"; printf '%s  actradeck-0.4.0.tar.gz\rX\n' "$DGT" > "$CSI"
    parity "expected_digest_for(interior-cr)" "$(inst expected_digest_for "$CSI" actradeck-0.4.0.tar.gzX)" "$(tseval expected_digest_for "$CSI" actradeck-0.4.0.tar.gzX)"
    # duplicate asset-name lines: FIRST match wins on both sides (checksum.ts returns the
    # first regex hit; install.sh pins `!found`) — the ambiguous second digest never surfaces.
    CSD="$PARF/checksums.dup.txt"; printf '%s  actradeck-0.4.0.tar.gz\n1111111111111111111111111111111111111111111111111111111111111111  actradeck-0.4.0.tar.gz\n' "$DGT" > "$CSD"
    parity "expected_digest_for(dup-first-wins)" "$(inst expected_digest_for "$CSD" actradeck-0.4.0.tar.gz)" "$(tseval expected_digest_for "$CSD" actradeck-0.4.0.tar.gz)"
    # non-64-hex digest field: malformed lines are "not found" (fail-closed) on both sides —
    # never returned as a non-hex "digest" (pre-fix: shell printed the raw field -> divergence).
    CSB="$PARF/checksums.badhex.txt"; printf 'zzzz  actradeck-0.4.0.tar.gz\nshort0abc  actradeck-0.4.0.tar.gz\n' > "$CSB"
    parity "expected_digest_for(non-64hex)" "$(inst expected_digest_for "$CSB" actradeck-0.4.0.tar.gz)" "$(tseval expected_digest_for "$CSB" actradeck-0.4.0.tar.gz)"
    # repo_slug vectors (full-URL domain) --------------------------------------
    for u in "https://github.com/acme/tool" "https://github.com/acme/tool.git" "https://x:y@github.com/acme/tool"; do
      parity "repo_slug($u)" "$(inst repo_slug "$u")" "$(tseval repo_slug "$u")"
    done
    [ "$P_OK" = 1 ] && ok "INV-NPM-TS-SHELL-PARITY: TS and install.sh agree on all $P_N digest/repo vectors"

    # injected-divergence RED: feed the two sides DIFFERENT asset names -> outputs differ ->
    # the parity comparison MUST detect the mismatch (proves it isn't vacuous).
    d_shell="$(inst expected_digest_for "$CSF" actradeck-0.4.0.tar.gz)"
    d_ts="$(tseval expected_digest_for "$CSF" other-name.tar.gz)"
    if [ "$d_shell" != "$d_ts" ]; then
      ok "INV-NPM-TS-SHELL-PARITY: comparison DETECTS an injected TS/shell divergence (falsifiable)"
    else
      ng "INV-NPM-TS-SHELL-PARITY: DEAD — injected divergence not detected (vacuous parity)"
    fi
  else
    ng "INV-NPM-TS-SHELL-PARITY: could not build packages/cli for the differential test"
  fi
else
  echo "SKIP  INV-NPM-TS-SHELL-PARITY: node/pnpm/node_modules absent (differential test needs the built dist)."
fi

# ============================================================================
# INV-DOCKER-SCAN-BEFORE-PUSH  (SEC-2: leak scan runs before the GHCR push)
# ============================================================================
if [ ! -f "$REL_YML" ]; then
  ng "INV-DOCKER-SCAN-BEFORE-PUSH: release.yml not found at $REL_YML"
elif ! command -v python3 >/dev/null 2>&1; then
  ng "INV-DOCKER-SCAN-BEFORE-PUSH: python3 required to parse the workflow"
else
  if docker_scan_before_push "$REL_YML" >/dev/null 2>&1; then
    ok "INV-DOCKER-SCAN-BEFORE-PUSH: image leak-scan step precedes the push step"
  else
    ng "INV-DOCKER-SCAN-BEFORE-PUSH: no leak-scan step before push in the docker job"
  fi
  # RED probes via the single-source mutate_scan (L6 — is_scan lives in ONE place). Each named
  # mutation is a distinct no-op / bypass form the checker must FAIL on.
  #   remove       : delete the scan step (nothing gates the push)
  #   reorder_last : move the scan step after push
  #   gut          : replace run with a no-op echo
  #   disable      : `if: false` on the scan step
  #   coe          : `continue-on-error: true` (leak exit 1 ignored)
  #   comment      : load-bearing token only in a comment
  #   echo         : load-bearing token only inside an echo string
  # QA-R2 / TDA-R1 harness self-check: a mutation probe is only meaningful if the mutation ACTUALLY
  # applied. If a mutator can't find its target (e.g. the push step drifted to a form it no longer
  # matches) it may no-op or crash, leaving a file that either doesn't exist or equals the untouched
  # baseline — and docker_scan_before_push would then "correctly fail" for the WRONG reason (a vacuous
  # green). Compare each mutated file against a yaml-roundtrip baseline of REL_YML (a no-op compares
  # EQUAL) and require: mutator exit 0 + output exists + differs from baseline. Symmetric with the
  # actions probe's `assert src2 != src`.
  BASELINE="$WORK/rel.baseline.yml"
  python3 -c 'import sys,yaml; yaml.safe_dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],"w"))' "$REL_YML" "$BASELINE"
  mutation_applied() { # $1=mutated file  $2=mutator rc  -> 0 iff genuinely applied (rc0 + exists + ≠baseline)
    [ "$2" -eq 0 ] && [ -f "$1" ] && ! cmp -s "$1" "$BASELINE"
  }
  scan_red_ok=1
  for m in \
    "remove:removing the scan step" \
    "reorder_last:moving the scan step after push" \
    "gut:gutting the scan run to echo" \
    "disable:disabling the scan step with if:false" \
    "coe:continue-on-error:true on the scan step" \
    "coe_exprT:continue-on-error:\${{ true }} on the scan step" \
    "coe_exprC:continue-on-error:\${{ expr }} on the scan step" \
    "comment:the scan token only in a comment" \
    "echo:the scan token only inside an echo string"; do
    op="${m%%:*}"; desc="${m#*:}"
    mutate_scan "$op" "$REL_YML" "$WORK/rel.scan.$op.yml"; mrc=$?
    if ! mutation_applied "$WORK/rel.scan.$op.yml" "$mrc"; then
      ng "INV-DOCKER-SCAN-BEFORE-PUSH: HARNESS — scan mutation '$op' did not apply (rc=$mrc / missing / ==baseline)"; scan_red_ok=0; continue
    fi
    if docker_scan_before_push "$WORK/rel.scan.$op.yml" >/dev/null 2>&1; then
      ng "INV-DOCKER-SCAN-BEFORE-PUSH: DEAD GATE — $desc still passed"; scan_red_ok=0
    fi
  done
  [ "$scan_red_ok" = 1 ] && ok "INV-DOCKER-SCAN-BEFORE-PUSH: gate FAILS on all 9 no-op/bypass forms incl continue-on-error \${{ true }} / \${{ expr }} (R6-M1 fail-closed), each mutation verified applied (falsifiable)"
  # NO OVER-REJECT (R6-M1): a provably-safe `continue-on-error: false` must NOT be rejected.
  mutate_scan coe_false "$REL_YML" "$WORK/rel.scan.coe_false.yml"
  if docker_scan_before_push "$WORK/rel.scan.coe_false.yml" >/dev/null 2>&1; then
    ok "INV-DOCKER-SCAN-BEFORE-PUSH: continue-on-error:false is NOT over-rejected (fail-closed is precise)"
  else
    ng "INV-DOCKER-SCAN-BEFORE-PUSH: OVER-REJECT — a safe continue-on-error:false was rejected"
  fi
  # RED (R2-L3): a re-building push (build-push-action push:true) is a DISTINCT build from the
  # scanned image -> must fail. (Appends a step; not an is_scan mutation.)
  python3 - "$REL_YML" "$WORK/rel.rebuild.mut.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
job = (d.get("jobs") or {}).get("docker") or {}
job["steps"] = (job.get("steps") or []) + [
    {"name": "Rebuild and push", "uses": "docker/build-push-action@v6",
     "with": {"context": ".", "push": True}}
]
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
  if docker_scan_before_push "$WORK/rel.rebuild.mut.yml" >/dev/null 2>&1; then
    ng "INV-DOCKER-SCAN-BEFORE-PUSH: DEAD GATE — re-building push (build-push-action push:true) still passed"
  else
    ok "INV-DOCKER-SCAN-BEFORE-PUSH: gate FAILS when the push re-builds the image (falsifiable)"
  fi
  # RED (arm64 multi-arch coverage): inject a THIRD platform into the push's --platform list
  # WITHOUT adding a scan for it. The manifest list would then publish linux/s390x unscanned ->
  # the per-arch coverage clause must FAIL (every pushed arch must be scanned first). This is the
  # multi-arch expansion of the invariant: scanning only the first arch no longer suffices.
  python3 - "$REL_YML" "$WORK/rel.unscanned_arch.yml" <<'PY'
import sys, os, re, yaml
sys.path.insert(0, os.environ["SP_DIR"]); import step_predicates as sp
d = yaml.safe_load(open(sys.argv[1]))
steps = ((d.get("jobs") or {}).get("docker") or {}).get("steps") or []
for s in steps:
    if sp.is_push(s) and "run" in s:
        s["run"] = re.sub(r'(--platform[ =]+linux/[A-Za-z0-9._-]+(?:,linux/[A-Za-z0-9._-]+)*)',
                          r'\1,linux/s390x', s["run"], count=1)
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
  if docker_scan_before_push "$WORK/rel.unscanned_arch.yml" >/dev/null 2>&1; then
    ng "INV-DOCKER-SCAN-BEFORE-PUSH: DEAD GATE — pushing an unscanned platform (linux/s390x) still passed"
  else
    ok "INV-DOCKER-SCAN-BEFORE-PUSH: gate FAILS when the push publishes a platform no pre-push scan covers (falsifiable)"
  fi
  # RED (arm64 unblock — SEC-1 fail-closed + QA-1/2/3/4 + SEC-R1/R2): ten push-face bypass forms the
  # remediation must FAIL on. Each mutation makes docker_scan_before_push exit non-zero (and each is
  # verified to have genuinely applied via mutation_applied — QA-R2):
  #   plat_env           (a) --platform via ${{ env.… }} indirection -> non-literal -> fail-closed REJECT
  #   plat_continuation  (b) --platform list split across a `\`-newline with the arm side unscanned
  #   scan_echo_only     (c) scan only amd64; arm64 mentioned solely inside an echo STRING (strip -> gone)
  #   plat_substring     (d) push linux/arm while a scan has arm64 -> substring must NOT falsely cover
  #   extra_push_s390x   (e) a SECOND buildx --push publishing an arch no scan covers (all-push-steps)
  #   drop_all_cachefrom (f) remove every --cache-from -> pushed layers are an unscanned rebuild
  #   drop_one_cachefrom (g) remove only the arm64 --cache-from -> that arch is an unscanned rebuild
  #   comment_arm64_cachefrom (h) SEC-R1: comment-OUT the arm64 --cache-from -> not a live flag token
  #   echo_spoof_cachefrom    (i) SEC-R1: arm64 --cache-from removed but named inside an echo STRING
  #   extra_output_registry   (j) SEC-R2: a SECOND buildx publishing via --output type=registry (no --push)
  #   nested_platform_shc     (k) QA-R3-1: --platform buried in a nested `sh -c "…"` quote (shlex single-tokens)
  #   extra_output_registry_fused (l) SEC-R3-1: a SECOND buildx publishing via the FUSED short flag -otype=registry
  push_red_ok=1; push_n=0
  for op in plat_env plat_continuation scan_echo_only plat_substring extra_push_s390x drop_all_cachefrom drop_one_cachefrom comment_arm64_cachefrom echo_spoof_cachefrom extra_output_registry nested_platform_shc extra_output_registry_fused; do
    push_n=$((push_n + 1))
    mutate_push "$op" "$REL_YML" "$WORK/rel.push.$op.yml"; mrc=$?
    if ! mutation_applied "$WORK/rel.push.$op.yml" "$mrc"; then
      ng "INV-DOCKER-SCAN-BEFORE-PUSH: HARNESS — push mutation '$op' did not apply (rc=$mrc / missing / ==baseline)"; push_red_ok=0; continue
    fi
    if docker_scan_before_push "$WORK/rel.push.$op.yml" >/dev/null 2>&1; then
      ng "INV-DOCKER-SCAN-BEFORE-PUSH: DEAD GATE — push-face bypass '$op' still passed"; push_red_ok=0
    fi
  done
  [ "$push_red_ok" = 1 ] && ok "INV-DOCKER-SCAN-BEFORE-PUSH: gate FAILS on all $push_n push-face bypasses (non-literal/continuation/nested-quote --platform, echo-only scan, substring arch, extra unscanned --push/--output/fused-\`-o\`, dropped/commented/echo-spoofed cache-from), each mutation verified applied (falsifiable)"
fi

# ============================================================================
# INV-DOCKERFILE-RUNTIME-ALLOWLIST  (TDA-1: no broad whole-tree copy into runtime)
# ============================================================================
DOCKERFILE="$ROOT/Dockerfile"
if [ ! -f "$DOCKERFILE" ]; then
  ng "INV-DOCKERFILE-RUNTIME-ALLOWLIST: Dockerfile not found at $DOCKERFILE"
elif ! command -v python3 >/dev/null 2>&1; then
  ng "INV-DOCKERFILE-RUNTIME-ALLOWLIST: python3 required to parse the Dockerfile"
else
  if dockerfile_runtime_allowlist "$DOCKERFILE" >/dev/null 2>&1; then
    ok "INV-DOCKERFILE-RUNTIME-ALLOWLIST: runtime stage uses an allowlist COPY (no broad /app copy)"
  else
    ng "INV-DOCKERFILE-RUNTIME-ALLOWLIST: runtime stage has a broad whole-tree copy"
  fi
  # RED: reintroduce a broad `COPY --from=builder /app /app` in the runtime stage.
  DFM="$WORK/Dockerfile.broad"; cp "$DOCKERFILE" "$DFM"
  printf 'COPY --from=builder /app /app\n' >> "$DFM"
  if dockerfile_runtime_allowlist "$DFM" >/dev/null 2>&1; then
    ng "INV-DOCKERFILE-RUNTIME-ALLOWLIST: DEAD GATE — broad /app copy still passed"
  else
    ok "INV-DOCKERFILE-RUNTIME-ALLOWLIST: gate FAILS on a broad whole-tree copy (falsifiable)"
  fi
  # RED (R2-M3 + R3-M3): flag/stage/path variants Docker treats as the SAME broad copy but the
  # old flag-first / stage-literal / trailing-slash regex let through. ALL must be caught after
  # tokenization + normalization.
  m3_all_red=1; m3_n=0
  while IFS= read -r variant; do
    [ -n "$variant" ] || continue
    m3_n=$((m3_n + 1))
    DFV="$WORK/Dockerfile.m3.$m3_n"; cp "$DOCKERFILE" "$DFV"; printf '%s\n' "$variant" >> "$DFV"
    if dockerfile_runtime_allowlist "$DFV" >/dev/null 2>&1; then
      ng "INV-DOCKERFILE-RUNTIME-ALLOWLIST: DEAD GATE — broad-copy variant ACCEPTED: $variant"; m3_all_red=0
    fi
  done <<'VARIANTS'
COPY --from=builder /app /app
COPY --from=builder /app/ /app/
COPY --chown=1:1 --from=builder /app /app
COPY --from=builder --link /app /app
COPY --from=b /app /app
COPY --from=builder /app/./ /app/
COPY --from=builder /app//. /app/
VARIANTS
  [ "$m3_all_red" = 1 ] && ok "INV-DOCKERFILE-RUNTIME-ALLOWLIST: gate FAILS on all $m3_n broad-copy variants (flag order / --link / renamed stage / /./ / trailing slash) (falsifiable)"
fi

# ============================================================================
# INV-INSTALL-VERIFY-REJECTS-TAMPER  (pure digest path; gh not invoked)
# ============================================================================
ASSET="$WORK/asset.tar.gz"; printf 'verified actradeck payload\n' > "$ASSET"
GOOD="$(sha256sum "$ASSET" | cut -d' ' -f1)"
printf '%s  actradeck-0.1.0.tar.gz\n' "$GOOD" > "$WORK/checksums.txt"

# correct digest -> accept
if inst verify_sha256 "$ASSET" "$GOOD" >/dev/null 2>&1; then
  ok "INV-INSTALL-VERIFY: correct digest accepted"
else
  ng "INV-INSTALL-VERIFY: correct digest was rejected"
fi
# checksums lookup resolves
got="$(inst expected_digest_for "$WORK/checksums.txt" actradeck-0.1.0.tar.gz 2>/dev/null)"
[ "$got" = "$GOOD" ] && ok "INV-INSTALL-VERIFY: expected_digest_for resolves the asset digest" \
                      || ng "INV-INSTALL-VERIFY: expected_digest_for did not resolve the digest"
# 1-byte flip -> reject
printf 'verified actradeck payloadX\n' > "$ASSET"
if inst verify_sha256 "$ASSET" "$GOOD" >/dev/null 2>&1; then
  ng "INV-INSTALL-VERIFY: DEAD GATE — tampered (1-byte) asset accepted"
else
  ok "INV-INSTALL-VERIFY: tampered asset rejected (fail-closed)"
fi
# empty expected digest (attestation/checksum absent) -> reject
if inst verify_sha256 "$ASSET" "" >/dev/null 2>&1; then
  ng "INV-INSTALL-VERIFY: DEAD GATE — empty expected digest accepted"
else
  ok "INV-INSTALL-VERIFY: missing/empty expected digest rejected (fail-closed)"
fi
# missing asset in checksums.txt -> non-zero
if inst expected_digest_for "$WORK/checksums.txt" not-present.tar.gz >/dev/null 2>&1; then
  ng "INV-INSTALL-VERIFY: DEAD GATE — missing asset resolved a digest"
else
  ok "INV-INSTALL-VERIFY: absent asset yields no digest (fail-closed)"
fi

# ============================================================================
# INV-ACTIONS-SHA-PINNED  (C1: every remote `uses:` is pinned to a full commit SHA)
# ============================================================================
# Supply-chain tripwire: a raw `@vN` action tag is a mutable, hijackable reference. C1
# pins every third-party action to a 40-hex commit SHA (dependabot moves the pin, not
# the CI). This gate reads EVERY .github/workflows/*.yml plus any composite
# .github/actions/**/action.yml and fails if a remote `uses:` carries anything other than
# `@<40-hex>`. Local (`./…`) uses are exempt (they resolve inside the repo, not by a
# mutable Git tag). `docker://…` uses are NO LONGER exempt: `docker://image@sha256:<64hex>`
# passes, but `docker://image:tag` (a MUTABLE registry tag) FAILS (SEC-PIN-R3-4, closed —
# task 019f3460 landed). A NON-SCALAR `uses:` value is a violation, not a silent skip
# (SEC-PIN-R3-3). HONEST SCOPE: this is a CI-side tripwire, not adversary-proof — an
# expression ref (`uses: ${{ matrix.action }}`) does not match `@<40-hex>` and so fails
# CLOSED (a spurious RED, never a silent pass). PyYAML must be preinstalled (ci.yml verifies
# it fail-loud; the gate itself does no unpinned install).
actions_sha_pinned() {  # $@ = workflow / composite-action YAML files; nonzero + prints violations
  # SEC-PIN-R2-1: parse each file with a real YAML parser and recursively walk EVERY key
  #   literally named `uses` (jobs.*.steps[].uses AND composite runs.steps[].uses). Because
  #   block-style, flow-style (`- {uses: …}`), flow-sequence (`steps: [{uses: …}]`) and
  #   line-continuation all normalize to the same parsed structure, one walk catches every
  #   syntax — no per-shape regex whack-a-mole. PyYAML absent => fail-closed (never silent-pass).
  python3 - "$@" <<'PY'
import sys, os, re
sha_re = re.compile(r'@[0-9a-fA-F]{40}$')
# a docker:// ref must carry a FULL 64-hex manifest digest (SEC-PIN-R3-4).
digest_re = re.compile(r'@sha256:[0-9a-fA-F]{64}(?![0-9a-fA-F])')
try:
    import yaml
except Exception:
    sys.stderr.write("PyYAML unavailable — fail-closed\n")
    sys.exit(2)

def walk_uses(node, out, bad):
    # collect every `uses` value; a NON-SCALAR value (list/mapping) is recorded in `bad`
    # as a violation rather than silently skipped (SEC-PIN-R3-3) — a valid workflow never
    # has a non-string uses.
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'uses':
                if isinstance(v, str):
                    out.append(v)
                else:
                    bad.append(type(v).__name__)
            walk_uses(v, out, bad)
    elif isinstance(node, list):
        for it in node:
            walk_uses(it, out, bad)

viol = []
for p in sys.argv[1:]:
    if not os.path.isfile(p):
        continue
    base = os.path.basename(p)
    try:
        doc = yaml.safe_load(open(p))
    except Exception as e:
        viol.append(f"{base}: YAML parse error ({e}) — fail-closed")
        continue
    refs, bad = [], []
    walk_uses(doc, refs, bad)
    for t in bad:
        viol.append(f"{base}: uses value is non-scalar ({t}) — scalar action ref required (SEC-PIN-R3-3)")
    for ref in refs:
        r = ref.strip().strip('"\'')
        if r.startswith('./'):
            continue                       # local action; resolves inside the repo, not a mutable tag
        if r.startswith('docker://'):
            # SEC-PIN-R3-4: docker://image:tag is a mutable registry tag; require @sha256:<64hex>.
            if not digest_re.search(r):
                viol.append(f"{base}: uses {r} (docker:// requires @sha256:<64hex>)")
            continue
        if not sha_re.search(r):
            viol.append(f"{base}: uses {r}")
if viol:
    sys.stderr.write("\n".join(viol) + "\n")
    sys.exit(1)
sys.exit(0)
PY
}
WF_DIR="$ROOT/.github/workflows"
# SEC-PIN-R2-2: discover action targets by glob, not by hardcoding ci/release/codeql:
#   `.github/workflows/*.yml|*.yaml` plus any composite action
#   (`.github/actions/**/action.yml|yaml`) if present. HONEST SCOPE: this covers `uses:`
#   refs (including docker://, SEC-PIN-R3-4) in workflows and composites. Composite
#   `runs.image` refs are checked on the image side (INV-IMAGE-DIGEST-PINNED). Expression
#   refs fail CLOSED (see note above).
ACT_FILES=()
for f in "$WF_DIR"/*.yml "$WF_DIR"/*.yaml; do [ -f "$f" ] && ACT_FILES+=("$f"); done
ACT_COMPOSITE=0
if [ -d "$ROOT/.github/actions" ]; then
  while IFS= read -r f; do ACT_FILES+=("$f"); ACT_COMPOSITE=$((ACT_COMPOSITE+1)); done \
    < <(find "$ROOT/.github/actions" -type f \( -name action.yml -o -name action.yaml \) 2>/dev/null)
fi
if [ ! -d "$WF_DIR" ]; then
  ng "INV-ACTIONS-SHA-PINNED: .github/workflows not found at $WF_DIR"
elif ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import yaml" >/dev/null 2>&1; then
  ng "INV-ACTIONS-SHA-PINNED: python3 + PyYAML required to parse the workflows (fail-closed)"
elif [ "${#ACT_FILES[@]}" -eq 0 ]; then
  ng "INV-ACTIONS-SHA-PINNED: no workflow YAML files discovered under $WF_DIR"
else
  if actions_sha_pinned "${ACT_FILES[@]}" >/dev/null 2>&1; then
    ok "INV-ACTIONS-SHA-PINNED: every remote uses: (block/flow/list/continuation) is 40-hex SHA-pinned [${#ACT_FILES[@]} files, ${ACT_COMPOSITE} composite]"
  else
    ng "INV-ACTIONS-SHA-PINNED: a workflow uses: is not SHA-pinned — $(actions_sha_pinned "${ACT_FILES[@]}" 2>&1 | tr '\n' ' ')"
  fi
  # RED 1 (block-style, existing): rewrite ONE SHA-pinned uses back to a bare `@vN` tag.
  WFM="$WORK/wf-bare"; rm -rf "$WFM"; mkdir -p "$WFM"; cp "$WF_DIR/ci.yml" "$WFM/ci.yml"
  python3 - "$WFM/ci.yml" <<'PY'
import sys, re
p = sys.argv[1]
src = open(p).read()
# actions/checkout@<40-hex> # v4  ->  actions/checkout@v4  (bare mutable tag)
src2 = re.sub(r'(uses:\s*actions/checkout)@[0-9a-fA-F]{40}(\s*#[^\n]*)?', r'\1@v4', src, count=1)
assert src2 != src, "mutation did not apply (DEAD MUTATION)"
open(p, 'w').write(src2)
PY
  if actions_sha_pinned "$WFM/ci.yml" >/dev/null 2>&1; then
    ng "INV-ACTIONS-SHA-PINNED: DEAD GATE — a bare @vN block-style uses still passed"
  else
    ok "INV-ACTIONS-SHA-PINNED: gate FAILS on a bare @vN block-style uses (falsifiable)"
  fi
  # RED 2 (flow-style step — the SEC-PIN-R2-1 hole the line-regex missed): `- {uses: foo@v4}`.
  FS="$WORK/wf-flowstep.yml"
  cat > "$FS" <<'YML'
name: probe
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - {uses: actions/checkout@v4}
YML
  if actions_sha_pinned "$FS" >/dev/null 2>&1; then
    ng "INV-ACTIONS-SHA-PINNED: DEAD GATE — a flow-style {uses: @v4} passed (SEC-PIN-R2-1)"
  else
    ok "INV-ACTIONS-SHA-PINNED: gate FAILS on a flow-style {uses: @v4} (SEC-PIN-R2-1 closed)"
  fi
  # RED 3 (flow-sequence list): `steps: [{uses: foo@v4}]`.
  FL="$WORK/wf-flowlist.yml"
  cat > "$FL" <<'YML'
name: probe
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{uses: pnpm/action-setup@v4}]
YML
  if actions_sha_pinned "$FL" >/dev/null 2>&1; then
    ng "INV-ACTIONS-SHA-PINNED: DEAD GATE — a flow-sequence [{uses: @v4}] passed"
  else
    ok "INV-ACTIONS-SHA-PINNED: gate FAILS on a flow-sequence [{uses: @v4}]"
  fi
  # RED 4 (continuation / folded scalar — the uses: value on the next line).
  FC="$WORK/wf-cont.yml"
  cat > "$FC" <<'YML'
name: probe
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: >-
          actions/setup-node@v4
YML
  if actions_sha_pinned "$FC" >/dev/null 2>&1; then
    ng "INV-ACTIONS-SHA-PINNED: DEAD GATE — a continuation (folded) uses @v4 passed"
  else
    ok "INV-ACTIONS-SHA-PINNED: gate FAILS on a continuation (folded) uses @v4"
  fi
  # GREEN (over-detection guard): a flow-style step that IS 40-hex pinned must PASS.
  FG="$WORK/wf-flow-ok.yml"
  cat > "$FG" <<'YML'
name: probe
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - {uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5}
YML
  if actions_sha_pinned "$FG" >/dev/null 2>&1; then
    ok "INV-ACTIONS-SHA-PINNED: a 40-hex-pinned flow-style step PASSES (no over-detection)"
  else
    ng "INV-ACTIONS-SHA-PINNED: OVER-FAIL — a 40-hex-pinned flow-style step was rejected"
  fi
  # RED 5 (SEC-PIN-R3-4 / QA-PIN-R3-1): a docker:// uses with a MUTABLE tag must FAIL.
  DKR="$WORK/wf-docker-tag.yml"
  cat > "$DKR" <<'YML'
name: probe
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:latest
YML
  if actions_sha_pinned "$DKR" >/dev/null 2>&1; then
    ng "INV-ACTIONS-SHA-PINNED: DEAD GATE — docker://alpine:latest (mutable tag) passed (SEC-PIN-R3-4)"
  else
    ok "INV-ACTIONS-SHA-PINNED: gate FAILS on docker://<image>:<tag> without a digest (SEC-PIN-R3-4 closed)"
  fi
  # RED 6 (SEC-PIN-R3-3): a non-scalar uses: value (list) must FAIL — no silent skip.
  NSU="$WORK/wf-nonstr-uses.yml"
  cat > "$NSU" <<'YML'
name: probe
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses:
          - actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
YML
  if actions_sha_pinned "$NSU" >/dev/null 2>&1; then
    ng "INV-ACTIONS-SHA-PINNED: DEAD GATE — a non-scalar uses: value was silently skipped (SEC-PIN-R3-3)"
  else
    ok "INV-ACTIONS-SHA-PINNED: gate FAILS on a non-scalar uses: value (SEC-PIN-R3-3 closed)"
  fi
  # GREEN (over-fail guard): a docker:// ref pinned by @sha256:<64hex> must PASS.
  DKG="$WORK/wf-docker-ok.yml"; DKG_HEX="$(printf '0%.0s' $(seq 1 64))"
  printf 'name: probe\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker://alpine@sha256:%s\n' "$DKG_HEX" > "$DKG"
  if actions_sha_pinned "$DKG" >/dev/null 2>&1; then
    ok "INV-ACTIONS-SHA-PINNED: a docker://<image>@sha256:<64hex> ref PASSES (no over-fail)"
  else
    ng "INV-ACTIONS-SHA-PINNED: OVER-FAIL — a digest-pinned docker:// ref was rejected"
  fi
fi

# ============================================================================
# INV-IMAGE-DIGEST-PINNED  (C3: every container image is pinned to a @sha256: digest)
# ============================================================================
# Supply-chain tripwire: a bare `postgres:17.5-alpine` / `node:22-slim` tag is mutable —
# the same tag can point at a different image tomorrow. C3 pins every image we consume by
# manifest digest. This gate covers every surface where an image ref lives: Dockerfile
# `FROM` lines, external `COPY --from=<image>` and `RUN --mount=…,from=<image>` refs
# (SEC-PIN-R3-1), the workflow service-container `image:` lines (ci.yml postgres),
# docker-compose.yml `image:`, and composite action `runs.image` (TDA-PIN-R3-3). `FROM
# scratch`, internal multi-stage self-references (`FROM <stage>` / `COPY --from=<stage>`,
# case-insensitive) and numeric `--from=<index>` are exempt; a dynamic `FROM ${VAR}`
# build-arg is unverifiable and REJECTED (SEC-PIN-R3-2).
image_digest_pinned() {  # $@ = files (Dockerfile* parsed as FROM lines, else YAML-walked for image:)
  # SEC-PIN-R2-1 / QA-PIN-R2-2 / QA-PIN-R2-3: YAML files (workflows + compose + composite action.yml)
  #   are parsed with a real YAML parser and EVERY key named `image` is walked (block/flow syntax
  #   alike); a composite `runs.image: 'Dockerfile'` (local build) is exempt (TDA-PIN-R3-3). A
  #   NON-SCALAR image value is a violation, not a silent skip (SEC-PIN-R3-3). Dockerfiles are not
  #   YAML: a robust line-parser joins `\`-continuations, skips build flags (`--platform=…`), honors
  #   `scratch` + multi-stage self-references, and additionally enforces external `COPY --from=<img>`
  #   and `RUN --mount=…,from=<img>` refs (SEC-PIN-R3-1) — prior stage names (case-insensitive) and
  #   numeric `--from=<index>` are exempt. A dynamic `FROM ${VAR}` build-arg is unverifiable and
  #   REJECTED (SEC-PIN-R3-2). All literal refs must carry a FULL `@sha256:<64-hex>` digest (a
  #   truncated 8-hex digest is rejected). PyYAML absent => fail-closed.
  IMG_ROOT="$ROOT" python3 - "$@" <<'PY'
import sys, os, re
# full 64-hex digest; the negative lookahead rejects a 65+ hex run and (via the {64} minimum)
# a truncated one like @sha256:deadbeef.
digest_re = re.compile(r'@sha256:[0-9a-fA-F]{64}(?![0-9a-fA-F])')
_root = os.environ.get('IMG_ROOT') or ''
def rel_label(p):
    # TDA-COV-2 / SEC-PIN-COV-3: repo-relative violation label so a subdir Dockerfile is not
    # collapsed to an ambiguous `Dockerfile:1` (basename). Falls back to basename for files
    # outside the repo root (temp-probe inputs) so no absolute path leaks into the label.
    if _root:
        r = os.path.relpath(p, _root)
        if not r.startswith('..'):
            return r
    return os.path.basename(p)
try:
    import yaml
except Exception:
    sys.stderr.write("PyYAML unavailable — fail-closed\n")
    sys.exit(2)

def logical_lines(path):
    # join Dockerfile `\`-continuations into one logical line (keeps the first line number).
    out, buf, start = [], '', None
    for idx, raw in enumerate(open(path).read().split('\n'), 1):
        s = raw.rstrip()
        if start is None:
            start = idx
        if s.endswith('\\'):
            buf += s[:-1] + ' '
        else:
            buf += s
            out.append((start, buf)); buf, start = '', None
    if buf.strip():
        out.append((start or 1, buf))
    return out

def walk_images(node, out, bad):
    # collect every `image` value; a NON-SCALAR value (list/mapping) is recorded in `bad`
    # as a violation rather than silently skipped (SEC-PIN-R3-3).
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'image':
                if isinstance(v, str):
                    out.append(v)
                else:
                    bad.append(type(v).__name__)
            walk_images(v, out, bad)
    elif isinstance(node, list):
        for it in node:
            walk_images(it, out, bad)

def is_dockerfile(base):
    # mirror the recursive shell discovery: basename matches (case-insensitive)
    #   dockerfile | Dockerfile.* | Dockerfile-* | *.dockerfile
    b = base.lower()
    return b == 'dockerfile' or b.startswith('dockerfile.') or b.startswith('dockerfile-') or b.endswith('.dockerfile')

def check_ref(ref, base, lineno, kind, stages, viol):
    # shared exemption logic for FROM / COPY --from / RUN --mount from image refs.
    r = ref.strip().strip('"\'')
    if r.lower() in stages:          # prior build stage (Docker resolves stage names casefold)
        return
    if r.isdigit():                  # numeric stage index (--from=0)
        return
    if '$' in r:                     # dynamic build-arg ref is unverifiable
        viol.append(f"{base}:{lineno}: {kind} {r} — build-arg FROM は pin 検証不能。literal digest-pin へ")
        return
    if kind == 'FROM' and r.lower() == 'scratch':
        return
    if not digest_re.search(r):
        viol.append(f"{base}:{lineno}: {kind} {r}")

viol = []
for p in sys.argv[1:]:
    if not os.path.isfile(p):
        continue
    base = os.path.basename(p)       # basename drives Dockerfile-name detection
    disp = rel_label(p)              # repo-relative label for violation messages (TDA-COV-2)
    if is_dockerfile(base):
        stages = set()               # lowercased stage aliases seen so far (AS <stage>)
        for lineno, line in logical_lines(p):
            mkw = re.match(r'^\s*([A-Za-z_]+)\s+(.*)', line)
            if not mkw:
                continue
            kw, rest_line = mkw.group(1).upper(), mkw.group(2)
            if kw == 'FROM':
                toks = rest_line.split()
                img, rest = None, []
                for j, t in enumerate(toks):      # skip build flags (--platform=…); first bare token = image
                    if t.startswith('--'):
                        continue
                    img = t; rest = toks[j + 1:]; break
                if img is None:
                    continue
                check_ref(img, disp, lineno, 'FROM', stages, viol)
                for j, t in enumerate(rest):      # `AS <stage>` alias -> exempt later self-references
                    if t.upper() == 'AS' and j + 1 < len(rest):
                        stages.add(rest[j + 1].strip('"\'').lower()); break
            elif kw == 'COPY':
                for t in rest_line.split():        # SEC-PIN-R3-1: external COPY --from=<image> must be digest-pinned
                    if t.startswith('--from='):
                        check_ref(t[len('--from='):], disp, lineno, 'COPY --from', stages, viol)
            elif kw == 'RUN':
                for mnt in re.findall(r'--mount=(\S+)', rest_line):  # SEC-PIN-R3-1: RUN --mount=…,from=<image>
                    for field in mnt.split(','):
                        if field.startswith('from='):
                            check_ref(field[len('from='):], disp, lineno, 'RUN --mount from', stages, viol)
    else:
        try:
            doc = yaml.safe_load(open(p))
        except Exception as e:
            viol.append(f"{disp}: YAML parse error ({e}) — fail-closed")
            continue
        imgs, bad = [], []
        walk_images(doc, imgs, bad)
        for t in bad:
            viol.append(f"{disp}: image value is non-scalar ({t}) — scalar digest ref required (SEC-PIN-R3-3)")
        for img in imgs:
            r = img.strip().strip('"\'')
            if r == 'Dockerfile':      # TDA-PIN-R3-3: composite action runs.image: 'Dockerfile' = local build;
                continue               #   its FROM is covered by recursive Dockerfile discovery
            if not digest_re.search(r):
                viol.append(f"{disp}: image {r}")
if viol:
    sys.stderr.write("\n".join(viol) + "\n")
    sys.exit(1)
sys.exit(0)
PY
}
# SEC-PIN-R3-2: discover Dockerfiles RECURSIVELY + case-insensitively across the whole
#   TRACKED tree — basename matches `dockerfile` | `Dockerfile.*` | `Dockerfile-*` |
#   `*.dockerfile` (catches backend/Dockerfile, dev.Dockerfile, Dockerfile-legacy). We
#   enumerate via `git ls-files` (NOT a filesystem walk) because CI checks out only tracked
#   files, so this is byte-for-byte what CI sees, and it structurally excludes the untracked
#   ./oss + .oss-sync mirror copies and node_modules — no prune list to keep in sync. git
#   unavailable => fail-closed. HONEST SCOPE: a CI-side tripwire enforcing LITERAL digest
#   pins, not an adversary-proof control. This is a NAME-PATTERN gate: a compose `build:`
#   context that points at a conventionally-named Dockerfile (the patterns above) is covered,
#   but an OCI `Containerfile` / `build.dockerfile: <arbitrary-name>` is NOT scanned (TDA-COV-1,
#   0-instance today). Discovery is over TRACKED files (git ls-files) = the tree CI checks out,
#   so an un-committed Dockerfile is invisible to a LOCAL run, covered once committed (TDA-COV-3).
discover_dockerfiles() {  # $1 = repo root; prints tracked Dockerfile paths NUL-separated (recursive, case-insensitive)
  # SEC-PIN-COV-1: force `core.quotepath=false` + `-z` so paths with non-ASCII (CJK/accent/emoji),
  #   spaces or newlines are emitted VERBATIM and NUL-delimited. The default `quotepath=true`
  #   octal-escapes such names (e.g. `"\346\227\245.../Dockerfile"`) which then MISS the grep and
  #   SILENT-SKIP an unpinned FROM (unpinned image ships un-checked). NUL output pairs with a
  #   `read -r -d ''` consumer so the whole transport-encoding blind-spot class is closed uniformly.
  git -c core.quotepath=false -C "$1" ls-files -z 2>/dev/null \
    | grep -z -iE '(^|/)(dockerfile(\.[^/]*|-[^/]*)?|[^/]*\.dockerfile)$'
}
IMG_FILES=()
GIT_OK=1
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  while IFS= read -r -d '' rel; do [ -n "$rel" ] || continue; IMG_FILES+=("$ROOT/$rel"); done \
    < <(discover_dockerfiles "$ROOT")
else
  GIT_OK=0
fi
for f in "$ROOT"/docker-compose.yml "$ROOT"/docker-compose.yaml "$ROOT"/compose.yml "$ROOT"/compose.yaml; do [ -f "$f" ] && IMG_FILES+=("$f"); done
for f in "$WF_DIR"/*.yml "$WF_DIR"/*.yaml; do [ -f "$f" ] && IMG_FILES+=("$f"); done
# TDA-PIN-R3-3: composite action.yml runs.image is an image surface too (walk finds `image`).
if [ -d "$ROOT/.github/actions" ]; then
  while IFS= read -r f; do IMG_FILES+=("$f"); done \
    < <(find "$ROOT/.github/actions" -type f \( -name action.yml -o -name action.yaml \) 2>/dev/null)
fi
if [ "$GIT_OK" = 0 ]; then
  ng "INV-IMAGE-DIGEST-PINNED: git ls-files unavailable — cannot enumerate Dockerfiles (fail-closed)"
elif ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import yaml" >/dev/null 2>&1; then
  ng "INV-IMAGE-DIGEST-PINNED: python3 + PyYAML required to parse the image refs (fail-closed)"
elif [ "${#IMG_FILES[@]}" -eq 0 ]; then
  ng "INV-IMAGE-DIGEST-PINNED: no Dockerfile / compose / workflow files discovered"
else
  if image_digest_pinned "${IMG_FILES[@]}" >/dev/null 2>&1; then
    ok "INV-IMAGE-DIGEST-PINNED: every FROM / service image: / compose image: carries a full @sha256:<64hex> digest [${#IMG_FILES[@]} files]"
  else
    ng "INV-IMAGE-DIGEST-PINNED: a container image is not digest-pinned — $(image_digest_pinned "${IMG_FILES[@]}" 2>&1 | tr '\n' ' ')"
  fi
  # RED (a): strip the digest from the Dockerfile base image -> gate must fail.
  #   TDA-PIN-R2-2: assert the mutation actually applied (DEAD MUTATION guard, symmetric to actions).
  DFD="$WORK/Dockerfile.bare"; cp "$ROOT/Dockerfile" "$DFD"
  perl -0pi -e 's/(FROM\s+\S+?)\@sha256:[0-9a-fA-F]{64}/$1/g' "$DFD"
  if diff -q "$ROOT/Dockerfile" "$DFD" >/dev/null; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD MUTATION — Dockerfile digest strip was a no-op"
  elif image_digest_pinned "$DFD" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a bare Dockerfile FROM tag still passed"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS when a Dockerfile FROM drops its digest (falsifiable)"
  fi
  # RED (b): strip the digest from the workflow service-container image -> gate must fail.
  CID="$WORK/ci-bare.yml"; cp "$WF_DIR/ci.yml" "$CID"
  perl -0pi -e 's/(image:\s*\S+?)\@sha256:[0-9a-fA-F]{64}/$1/g' "$CID"
  if diff -q "$WF_DIR/ci.yml" "$CID" >/dev/null; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD MUTATION — workflow image digest strip was a no-op"
  elif image_digest_pinned "$CID" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a bare workflow service image: still passed"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS when a workflow service image: drops its digest (falsifiable)"
  fi
  # RED (c): strip the digest from docker-compose.yml image -> gate must fail.
  CMP="$WORK/compose-bare.yml"; cp "$ROOT/docker-compose.yml" "$CMP"
  perl -0pi -e 's/(image:\s*\S+?)\@sha256:[0-9a-fA-F]{64}/$1/g' "$CMP"
  if diff -q "$ROOT/docker-compose.yml" "$CMP" >/dev/null; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD MUTATION — compose image digest strip was a no-op"
  elif image_digest_pinned "$CMP" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a bare docker-compose image: still passed"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS when docker-compose image: drops its digest (falsifiable)"
  fi
  # RED (d): flow-style service image (the syntax the line-based gate missed): `{image: <tag>}`.
  FSI="$WORK/compose-flow.yml"
  cat > "$FSI" <<'YML'
services:
  db: {image: postgres:17.5-alpine}
YML
  if image_digest_pinned "$FSI" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a flow-style {image: <tag>} passed (SEC-PIN-R2-1)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a flow-style {image: <tag>} (SEC-PIN-R2-1 closed)"
  fi
  # RED (e): a truncated 8-hex digest must be rejected — full 64-hex required (QA-PIN-R2-2).
  SHX="$WORK/compose-shorthex.yml"
  cat > "$SHX" <<'YML'
services:
  db:
    image: postgres@sha256:deadbeef
YML
  if image_digest_pinned "$SHX" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — an 8-hex @sha256:deadbeef passed (QA-PIN-R2-2)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a truncated 8-hex digest — full 64-hex required (QA-PIN-R2-2)"
  fi
  # RED (f): a `\`-continuation FROM whose base drops its digest must fail (continuation support).
  DFC="$WORK/Dockerfile.cont"
  printf 'FROM \\\n  node:22-bookworm-slim\n' > "$DFC"
  if image_digest_pinned "$DFC" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a continuation FROM without a digest passed"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a line-continuation FROM missing its digest"
  fi
  # GREEN (over-fail guard): a `FROM --platform=… <img>@sha256:<64hex>` must PASS (QA-PIN-R2-3).
  PLT="$WORK/Dockerfile.platform"
  PLT_HEX="$(printf '0%.0s' $(seq 1 64))"
  printf 'FROM --platform=$BUILDPLATFORM node:22@sha256:%s AS builder\n' "$PLT_HEX" > "$PLT"
  if image_digest_pinned "$PLT" >/dev/null 2>&1; then
    ok "INV-IMAGE-DIGEST-PINNED: FROM --platform=… <img>@sha256:<64hex> PASSES (no over-fail, QA-PIN-R2-3)"
  else
    ng "INV-IMAGE-DIGEST-PINNED: OVER-FAIL — a --platform-flagged, digest-pinned FROM was rejected"
  fi
  # RED (g): SEC-PIN-R3-1 — an external `COPY --from=<image>` must be digest-pinned.
  DCPF="$WORK/Dockerfile.copyfrom"
  printf 'FROM node:22@sha256:%s AS build\nCOPY --from=postgres:17.5-alpine /a /a\n' "$PLT_HEX" > "$DCPF"
  if image_digest_pinned "$DCPF" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — external COPY --from=postgres:17.5-alpine passed (SEC-PIN-R3-1)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on external COPY --from=<image> without a digest (SEC-PIN-R3-1)"
  fi
  # RED (h): SEC-PIN-R3-1 — an external `RUN --mount=…,from=<image>` must be digest-pinned.
  DMNT="$WORK/Dockerfile.mount"
  printf 'FROM node:22@sha256:%s AS build\nRUN --mount=type=cache,from=node:22 echo hi\n' "$PLT_HEX" > "$DMNT"
  if image_digest_pinned "$DMNT" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — external RUN --mount=…,from=node:22 passed (SEC-PIN-R3-1)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on external RUN --mount=…,from=<image> without a digest (SEC-PIN-R3-1)"
  fi
  # RED (i): SEC-PIN-R3-2 — a dynamic build-arg `FROM ${VAR}` is unverifiable -> REJECT.
  DVAR="$WORK/Dockerfile.var"
  printf 'ARG BASE\nFROM ${BASE}\n' > "$DVAR"
  if image_digest_pinned "$DVAR" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a dynamic FROM \${BASE} build-arg passed (SEC-PIN-R3-2)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a dynamic FROM \${VAR} build-arg (SEC-PIN-R3-2 — reject)"
  fi
  # RED (i'): QA-COV-R3-1 — a dynamic ref that ALSO embeds a valid 64-hex digest
  #   (`FROM ${REG}/img@sha256:<64hex>`) must STILL be rejected: the registry/repo half is
  #   build-arg-controlled so the pin is unverifiable. This makes the `$`-detection branch
  #   LOAD-BEARING — remove it and digest_re would match the embedded digest and SLIP. (The
  #   plain `FROM ${BASE}` probe (i) is vacuous: it already fails on the absent digest even
  #   without the `$` check, so it does not lock the dynamic-reject branch on its own.)
  DVARH="$WORK/Dockerfile.varhex"
  printf 'ARG REG\nFROM ${REG}/img@sha256:%s\n' "$PLT_HEX" > "$DVARH"
  if image_digest_pinned "$DVARH" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a dynamic FROM \${REG}/img@sha256:<64hex> passed (QA-COV-R3-1)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a digest-embedding dynamic FROM \${REG}/… (QA-COV-R3-1 — \$-branch load-bearing)"
  fi
  # RED (j): SEC-PIN-R3-2 — recursive + non-standard-name discovery. A subdir Dockerfile and
  #   non-standard names (*.Dockerfile / Dockerfile-*) must be DISCOVERED, and the checker must
  #   FAIL on the discovered bare FROM. Probe a real temp git repo (discovery is git-ls-files based).
  DREPO="$WORK/df-discovery"; rm -rf "$DREPO"; mkdir -p "$DREPO/backend"
  git -C "$DREPO" init -q >/dev/null 2>&1
  printf 'FROM node:22-alpine\n' > "$DREPO/backend/Dockerfile"
  printf 'FROM node:22-alpine\n' > "$DREPO/dev.Dockerfile"
  printf 'FROM node:22-alpine\n' > "$DREPO/Dockerfile-legacy"
  git -C "$DREPO" add -A >/dev/null 2>&1
  df_found=()   # NUL-read: discover_dockerfiles emits NUL-delimited paths (SEC-PIN-COV-1)
  while IFS= read -r -d '' f; do df_found+=("$f"); done < <(discover_dockerfiles "$DREPO")
  df_miss=0
  for want in backend/Dockerfile dev.Dockerfile Dockerfile-legacy; do
    df_hit=0
    for got in ${df_found[@]+"${df_found[@]}"}; do [ "$got" = "$want" ] && { df_hit=1; break; }; done
    [ "$df_hit" = 1 ] || df_miss=1
  done
  if [ "$df_miss" = 0 ]; then
    ok "INV-IMAGE-DIGEST-PINNED: recursive discovery finds subdir + non-standard-name Dockerfiles (backend/Dockerfile, dev.Dockerfile, Dockerfile-legacy) (SEC-PIN-R3-2)"
  else
    ng "INV-IMAGE-DIGEST-PINNED: DEAD DISCOVERY — recursive/non-standard Dockerfile not enumerated: [${df_found[*]-}]"
  fi
  if image_digest_pinned "$DREPO/backend/Dockerfile" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a discovered subdir backend/Dockerfile bare FROM passed"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a subdir Dockerfile's bare FROM (falsifiable)"
  fi
  # RED (m): SEC-PIN-COV-1 — a NON-ASCII (CJK) path Dockerfile must be DISCOVERED verbatim and its
  #   bare FROM must FAIL. Falsifiable PASS->FAIL transition: with the default core.quotepath=true
  #   git octal-escapes the CJK name and the grep misses it (matched 0 -> unpinned FROM ships
  #   SILENT-PASS); the `-c core.quotepath=false` + `-z` transport fix restores enumeration
  #   (matched 1 -> INV FAIL). Reverting the fix flips THIS discovery assert to FAIL.
  UREPO="$WORK/df-unicode"; rm -rf "$UREPO"; mkdir -p "$UREPO/サブディレクトリ"
  git -C "$UREPO" init -q >/dev/null 2>&1
  printf 'FROM node:22-alpine\n' > "$UREPO/サブディレクトリ/Dockerfile"
  git -C "$UREPO" add -A >/dev/null 2>&1
  u_found=()
  while IFS= read -r -d '' f; do u_found+=("$f"); done < <(discover_dockerfiles "$UREPO")
  u_hit=0
  for got in ${u_found[@]+"${u_found[@]}"}; do [ "$got" = "サブディレクトリ/Dockerfile" ] && u_hit=1; done
  if [ "$u_hit" = 1 ]; then
    ok "INV-IMAGE-DIGEST-PINNED: non-ASCII (CJK) path Dockerfile discovered verbatim — no quotepath silent-skip (SEC-PIN-COV-1)"
  else
    ng "INV-IMAGE-DIGEST-PINNED: DEAD DISCOVERY — non-ASCII path Dockerfile silent-skipped: [${u_found[*]-}] (SEC-PIN-COV-1)"
  fi
  if image_digest_pinned "$UREPO/サブディレクトリ/Dockerfile" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a discovered non-ASCII-path Dockerfile bare FROM passed (SEC-PIN-COV-1)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a non-ASCII-path Dockerfile's bare FROM (SEC-PIN-COV-1 falsifiable)"
  fi
  # RED (n): SEC-PIN-COV-1 — a path containing a SPACE (same NUL transport that carries newlines)
  #   must be enumerated verbatim and gate-checked. Guards the NUL read against whitespace field-splitting.
  WREPO="$WORK/df-space"; rm -rf "$WREPO"; mkdir -p "$WREPO/my dir"
  git -C "$WREPO" init -q >/dev/null 2>&1
  printf 'FROM node:22-alpine\n' > "$WREPO/my dir/Dockerfile"
  git -C "$WREPO" add -A >/dev/null 2>&1
  w_found=()
  while IFS= read -r -d '' f; do w_found+=("$f"); done < <(discover_dockerfiles "$WREPO")
  w_hit=0
  for got in ${w_found[@]+"${w_found[@]}"}; do [ "$got" = "my dir/Dockerfile" ] && w_hit=1; done
  if [ "$w_hit" = 1 ] && ! image_digest_pinned "$WREPO/my dir/Dockerfile" >/dev/null 2>&1; then
    ok "INV-IMAGE-DIGEST-PINNED: whitespace-in-path Dockerfile discovered verbatim and gate-checked (SEC-PIN-COV-1)"
  else
    ng "INV-IMAGE-DIGEST-PINNED: whitespace-in-path Dockerfile mis-handled (discovered=$w_hit) (SEC-PIN-COV-1)"
  fi
  # RED (k): TDA-PIN-R3-3 — a composite action.yml runs.image with a docker:// mutable tag must FAIL.
  AYML="$WORK/action-docker.yml"
  cat > "$AYML" <<'YML'
name: probe
runs:
  using: docker
  image: docker://alpine:3.19
YML
  if image_digest_pinned "$AYML" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — action.yml runs.image docker://alpine:3.19 passed (TDA-PIN-R3-3)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on composite action.yml runs.image docker://<tag> (TDA-PIN-R3-3)"
  fi
  # RED (l): SEC-PIN-R3-3 — a non-scalar image value must FAIL (no silent skip).
  NSI="$WORK/compose-nonstr.yml"
  cat > "$NSI" <<'YML'
services:
  db:
    image:
      - postgres:17.5
YML
  if image_digest_pinned "$NSI" >/dev/null 2>&1; then
    ng "INV-IMAGE-DIGEST-PINNED: DEAD GATE — a non-scalar image: value was silently skipped (SEC-PIN-R3-3)"
  else
    ok "INV-IMAGE-DIGEST-PINNED: gate FAILS on a non-scalar image: value (SEC-PIN-R3-3 closed)"
  fi
  # GREEN (over-fail guard): internal COPY --from=<stage> (casefold: `AS Builder` + `--from=builder`)
  #   and a numeric `--from=0` index must PASS (QA-PIN-R3-2 — no over-reject).
  DINT="$WORK/Dockerfile.internal"
  printf 'FROM node:22@sha256:%s AS Builder\nRUN true\nFROM node:22@sha256:%s AS runtime\nCOPY --from=builder /app /app\nCOPY --from=0 /x /x\n' "$PLT_HEX" "$PLT_HEX" > "$DINT"
  if image_digest_pinned "$DINT" >/dev/null 2>&1; then
    ok "INV-IMAGE-DIGEST-PINNED: internal COPY --from=<stage> (casefold AS Builder/--from=builder) + --from=0 index PASS (no over-fail, QA-PIN-R3-2)"
  else
    ng "INV-IMAGE-DIGEST-PINNED: OVER-FAIL — an internal stage/index COPY --from was rejected"
  fi
  # GREEN (over-fail guard): QA-COV-R3-3 — the REVERSE casefold (`AS builder` lower-case + `COPY
  #   --from=Builder` upper-case) is valid Docker (stage names resolve case-insensitively) and must
  #   PASS. The forward guard above only exercised `AS Builder`/`--from=builder`.
  DINTR="$WORK/Dockerfile.internal-rev"
  printf 'FROM node:22@sha256:%s AS builder\nRUN true\nFROM node:22@sha256:%s AS runtime\nCOPY --from=Builder /app /app\n' "$PLT_HEX" "$PLT_HEX" > "$DINTR"
  if image_digest_pinned "$DINTR" >/dev/null 2>&1; then
    ok "INV-IMAGE-DIGEST-PINNED: reverse-casefold stage (AS builder / COPY --from=Builder) PASSES (no over-fail, QA-COV-R3-3)"
  else
    ng "INV-IMAGE-DIGEST-PINNED: OVER-FAIL — reverse-casefold internal stage COPY --from=Builder rejected (QA-COV-R3-3)"
  fi
  # GREEN (over-fail guard): a composite action.yml runs.image: 'Dockerfile' (local build) must PASS.
  ALOC="$WORK/action-local.yml"
  cat > "$ALOC" <<'YML'
name: probe
runs:
  using: docker
  image: 'Dockerfile'
YML
  if image_digest_pinned "$ALOC" >/dev/null 2>&1; then
    ok "INV-IMAGE-DIGEST-PINNED: composite runs.image: 'Dockerfile' (local build) PASSES (no over-fail)"
  else
    ng "INV-IMAGE-DIGEST-PINNED: OVER-FAIL — runs.image: 'Dockerfile' local build rejected"
  fi
fi

# ============================================================================
echo
if [ "$fail" = 0 ]; then
  echo "ALL release-prep invariants PASS."
else
  echo "One or more release-prep invariants are DEAD — see FAIL lines above."
fi
exit "$fail"
