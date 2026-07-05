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
ALLOWED_CTX = {"github.ref", "github.event_name", "vars.ENABLE_GHCR_PUBLISH", "true", "false"}
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
    matrix = [
        ({"github.ref": TAG, "github.event_name": "workflow_dispatch", "vars.ENABLE_GHCR_PUBLISH": ""},     True,  "tag+dispatch"),
        ({"github.ref": TAG, "github.event_name": "push",              "vars.ENABLE_GHCR_PUBLISH": "true"}, True,  "tag+push+var"),
        ({"github.ref": TAG, "github.event_name": "push",              "vars.ENABLE_GHCR_PUBLISH": ""},     False, "tag+push+novar"),
        ({"github.ref": BR,  "github.event_name": "workflow_dispatch", "vars.ENABLE_GHCR_PUBLISH": ""},     False, "nontag+dispatch"),
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
def name(s): return str(s.get("name", ""))
def is_scan(s):
    n = name(s).lower(); return "scan" in n and "leak" in n
def is_guard(s):
    n = name(s).lower(); return "publish" in n and "guard" in n
def is_push(s):
    w = s.get("with") or {}
    return (str(s.get("uses", "")).startswith("docker/build-push-action")
            and str(w.get("push", "")).lower() in ("true", "1", "yes")) \
        or "docker push" in str(s.get("run", ""))
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
# Execute a guard run body under one (ref, event, enable) context; exit code = the guard's.
guard_ctx() { env GITHUB_REF="$2" GITHUB_EVENT_NAME="$3" ENABLE_GHCR_PUBLISH="$4" bash -c "$1" >/dev/null 2>&1; }
# True iff a guard run body enforces tag∧opt-in across the context matrix (fail-closed). R5-L3
# widens the sample points beyond the original 4 to shrink (not eliminate) the sampling hole:
# a SECOND tag version catches a guard hardcoded to one tag, a non-dispatch/non-push event and
# a `false` opt-in value (broken-disable) catch a guard that treats "anything set" as authorized.
# HONEST LIMIT (sweep — QA-R5-2): this executes only the extracted RUN body, so a step/job-level
# `env: ENABLE_GHCR_PUBLISH: 'true'` defang (which the checker does not see) is not caught here;
# that residual is if:-gated + disclosed and carried to the v0.4.0 sweep, not chased into a denylist.
guard_matrix_ok() {
  local run="$1"
  guard_ctx "$run" refs/tags/v1.2.3 workflow_dispatch ''    ; [ $? -eq 0 ] || return 1  # tag+dispatch -> allow
  guard_ctx "$run" refs/tags/v1.2.3 push             true  ; [ $? -eq 0 ] || return 1  # tag+push+var -> allow
  guard_ctx "$run" refs/tags/v9.9.9 workflow_dispatch ''    ; [ $? -eq 0 ] || return 1  # OTHER tag+dispatch -> allow
  guard_ctx "$run" refs/tags/v1.2.3 push             ''    ; [ $? -ne 0 ] || return 1  # tag+push+novar -> BLOCK
  guard_ctx "$run" refs/tags/v9.9.9 push             ''    ; [ $? -ne 0 ] || return 1  # OTHER tag+push+novar -> BLOCK
  guard_ctx "$run" refs/tags/v1.2.3 push             false ; [ $? -ne 0 ] || return 1  # broken-disable ENABLE=false -> BLOCK
  guard_ctx "$run" refs/tags/v1.2.3 schedule         ''    ; [ $? -ne 0 ] || return 1  # tag+non-dispatch event -> BLOCK
  guard_ctx "$run" refs/heads/main  workflow_dispatch ''    ; [ $? -ne 0 ] || return 1  # nontag -> BLOCK
  return 0
}

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

# a tag matching the root version exists in repo <r>
tag_matches_version() {
  local r="$1" v
  v="$(jq -r '.version' "$r/package.json" 2>/dev/null)"
  git -C "$r" rev-parse -q --verify "refs/tags/v$v" >/dev/null 2>&1
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
SIGNING_WRITE_ALLOWED = {"contents", "packages", "id-token", "attestations"}
for name, job in (d.get("jobs") or {}).items():
    jp = job.get("permissions") or {}
    writes = [k for k, v in jp.items() if v == "write"]
    if writes:
        is_signing = jp.get("id-token") == "write" and jp.get("attestations") == "write"
        if not is_signing:
            print(f"job '{name}' holds write {writes} but is not the signing job"); sys.exit(1)
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
# The push step is a `docker push` (R2-L3 retag-and-push) or a build-push-action with push:true;
# a re-building push (build-push-action push:true) is rejected (scanned image != pushed image).
# NOTE: this is only the SECONDARY (wiring) check. The AUTHORITATIVE leak gate is the real image
# FS scan (scripts/lib/scan-image-fs.sh, run in release.yml before push AND in ci.yml's
# docker-image-scan job on every image-content change).
docker_scan_before_push() {
  python3 - "$1" <<'PY'
import sys, os, re, yaml
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
scan_i = next((i for i, s in enumerate(steps) if sp.is_scan(s)), None)
push_i = next((i for i, s in enumerate(steps) if sp.is_push(s)), None)
if push_i is None:
    print("no push step (docker push / build-push-action push:true) in docker job"); sys.exit(1)
if scan_i is None:
    print("no image leak-scan step found in docker job"); sys.exit(1)
if scan_i >= push_i:
    print(f"scan step (index {scan_i}) is not BEFORE push step (index {push_i})"); sys.exit(1)
scan = steps[scan_i]
if not sp.enabled(scan):
    print(f"scan step is disabled by `if: {scan.get('if')}`"); sys.exit(1)
if sp.cont_on_err(scan):
    print("scan step has `continue-on-error: true` — a leak `exit 1` would not fail the job"); sys.exit(1)
run = strip_run(str(scan.get("run", "")))
via_lib = "scan_image_fs" in run
via_inline = ("docker export" in run) and ("exit 1" in run)
if not (via_lib or via_inline):
    print("scan step `run:` has no EXECUTABLE scan call (scan_image_fs, or docker export + exit 1) after comment/string strip"); sys.exit(1)
rebuild = [sp.name(s) for s in steps
           if str(s.get("uses", "")).startswith("docker/build-push-action")
           and str((s.get("with") or {}).get("push", "")).lower() in ("true", "1", "yes")]
if rebuild:
    print("push re-builds the image (build-push-action push:true) — scanned image != pushed image:", rebuild); sys.exit(1)
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
  if versions_consistent "$VR" >/dev/null 2>&1 && tag_matches_version "$VR"; then
    ok "INV-TAG-MATCHES-VERSION: version.sh stamped 0.2.0 lockstep AND created tag v0.2.0"
  else
    ng "INV-TAG-MATCHES-VERSION: version.sh ran but tag/version disagree (see $WORK/version.log)"
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
    mutate_scan "$op" "$REL_YML" "$WORK/rel.scan.$op.yml"
    if docker_scan_before_push "$WORK/rel.scan.$op.yml" >/dev/null 2>&1; then
      ng "INV-DOCKER-SCAN-BEFORE-PUSH: DEAD GATE — $desc still passed"; scan_red_ok=0
    fi
  done
  [ "$scan_red_ok" = 1 ] && ok "INV-DOCKER-SCAN-BEFORE-PUSH: gate FAILS on all 9 no-op/bypass forms incl continue-on-error \${{ true }} / \${{ expr }} (R6-M1 fail-closed) (falsifiable)"
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
# the CI). This gate reads EVERY .github/workflows/*.yml and fails if a remote `uses:`
# carries anything other than `@<40-hex>`. Local (`./…`) uses are exempt (they resolve
# inside the repo, not by a mutable Git tag). `docker://…` uses are UNCONDITIONALLY exempt
# and the gate does NOT inspect them for a digest: `docker://image@sha256:…` would resolve
# by digest, but `docker://image:tag` (a MUTABLE registry tag) is not caught — a known
# coverage gap tracked in task 019f3460 to close before GHCR publish. (There are 0
# `docker://` uses in the current tree, so nothing un-pinned slips through today.)
actions_sha_pinned() {  # $@ = workflow / composite-action YAML files; nonzero + prints violations
  # SEC-PIN-R2-1: parse each file with a real YAML parser and recursively walk EVERY key
  #   literally named `uses` (jobs.*.steps[].uses AND composite runs.steps[].uses). Because
  #   block-style, flow-style (`- {uses: …}`), flow-sequence (`steps: [{uses: …}]`) and
  #   line-continuation all normalize to the same parsed structure, one walk catches every
  #   syntax — no per-shape regex whack-a-mole. PyYAML absent => fail-closed (never silent-pass).
  python3 - "$@" <<'PY'
import sys, os, re
sha_re = re.compile(r'@[0-9a-fA-F]{40}$')
try:
    import yaml
except Exception:
    sys.stderr.write("PyYAML unavailable — fail-closed\n")
    sys.exit(2)

def walk_uses(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'uses' and isinstance(v, str):
                out.append(v)
            walk_uses(v, out)
    elif isinstance(node, list):
        for it in node:
            walk_uses(it, out)

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
    refs = []
    walk_uses(doc, refs)
    for ref in refs:
        r = ref.strip().strip('"\'')
        if r.startswith('./') or r.startswith('docker://'):
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
#   refs in workflows and composites only. It does NOT reach non-workflow ref sites such
#   as `docker://image:tag` uses (see docker:// note above) — all 0-instance in the current
#   tree, tracked in task 019f3460.
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
fi

# ============================================================================
# INV-IMAGE-DIGEST-PINNED  (C3: every container image is pinned to a @sha256: digest)
# ============================================================================
# Supply-chain tripwire: a bare `postgres:17.5-alpine` / `node:22-slim` tag is mutable —
# the same tag can point at a different image tomorrow. C3 pins every image we consume by
# manifest digest. This gate covers all three surfaces where an image ref lives: the
# Dockerfile `FROM` lines, the workflow service-container `image:` lines (ci.yml postgres),
# and docker-compose.yml `image:`. `FROM scratch` and internal multi-stage `FROM <stage>`
# references (which resolve to a prior build stage, not a registry image) are exempt.
image_digest_pinned() {  # $@ = files (Dockerfile* parsed as FROM lines, else YAML-walked for image:)
  # SEC-PIN-R2-1 / QA-PIN-R2-2 / QA-PIN-R2-3: YAML files (workflows + compose) are parsed with a
  #   real YAML parser and EVERY key named `image` is walked (block/flow syntax alike). Dockerfiles
  #   are not YAML: a robust FROM line-parser joins `\`-continuations, skips build flags
  #   (`--platform=…`), and honors `scratch` + multi-stage self-references. All refs must carry a
  #   FULL `@sha256:<64-hex>` digest (a truncated 8-hex digest is rejected). PyYAML absent =>
  #   fail-closed.
  python3 - "$@" <<'PY'
import sys, os, re
# full 64-hex digest; the negative lookahead rejects a 65+ hex run and (via the {64} minimum)
# a truncated one like @sha256:deadbeef.
digest_re = re.compile(r'@sha256:[0-9a-fA-F]{64}(?![0-9a-fA-F])')
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

def walk_images(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'image' and isinstance(v, str):
                out.append(v)
            walk_images(v, out)
    elif isinstance(node, list):
        for it in node:
            walk_images(it, out)

viol = []
for p in sys.argv[1:]:
    if not os.path.isfile(p):
        continue
    base = os.path.basename(p)
    is_df = base == 'Dockerfile' or base.startswith('Dockerfile.')
    if is_df:
        stages = set()
        for lineno, line in logical_lines(p):
            m = re.match(r'^\s*FROM\s+(.*)', line, re.I)
            if not m:
                continue
            toks = m.group(1).split()
            img, rest = None, []
            for j, t in enumerate(toks):          # skip build flags (--platform=…); first bare token = image
                if t.startswith('--'):
                    continue
                img = t.strip('"\''); rest = toks[j + 1:]; break
            if img is None:
                continue
            stage = None
            for j, t in enumerate(rest):          # `AS <stage>` alias -> exempt later self-references
                if t.upper() == 'AS' and j + 1 < len(rest):
                    stage = rest[j + 1]; break
            if img.lower() != 'scratch' and img not in stages and not digest_re.search(img):
                viol.append(f"{base}:{lineno}: FROM {img}")
            if stage:
                stages.add(stage)
    else:
        try:
            doc = yaml.safe_load(open(p))
        except Exception as e:
            viol.append(f"{base}: YAML parse error ({e}) — fail-closed")
            continue
        imgs = []
        walk_images(doc, imgs)
        for img in imgs:
            r = img.strip().strip('"\'')
            if not digest_re.search(r):
                viol.append(f"{base}: image {r}")
if viol:
    sys.stderr.write("\n".join(viol) + "\n")
    sys.exit(1)
sys.exit(0)
PY
}
# SEC-PIN-R2-2: glob discovery (Dockerfile* at repo ROOT ONLY, all workflow YAML, compose
#   files) — never hardcode ci/release/codeql. HONEST SCOPE — this discovery is NON-RECURSIVE
#   and NAME-BOUND: it scans only `$ROOT/Dockerfile` + `$ROOT/Dockerfile.*`, root compose,
#   and workflow YAML. A Dockerfile in a subdirectory or under a non-standard name (e.g.
#   `backend/Dockerfile`, `deploy/app.dockerfile`) is NOT walked. It also does not resolve
#   image refs living elsewhere: external `COPY --from=<image>` / `RUN --mount=…,from=<image>`
#   in a Dockerfile, `docker://image:tag`, dynamic `FROM ${VAR}` build-args, or a compose
#   `build:` context's Dockerfile. All of these are 0-instance in the current tree; the
#   hardening to cover them is tracked in task 019f3460 (before GHCR publish).
IMG_FILES=()
for f in "$ROOT"/Dockerfile "$ROOT"/Dockerfile.*; do [ -f "$f" ] && IMG_FILES+=("$f"); done
for f in "$ROOT"/docker-compose.yml "$ROOT"/docker-compose.yaml "$ROOT"/compose.yml "$ROOT"/compose.yaml; do [ -f "$f" ] && IMG_FILES+=("$f"); done
for f in "$WF_DIR"/*.yml "$WF_DIR"/*.yaml; do [ -f "$f" ] && IMG_FILES+=("$f"); done
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import yaml" >/dev/null 2>&1; then
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
fi

# ============================================================================
echo
if [ "$fail" = 0 ]; then
  echo "ALL release-prep invariants PASS."
else
  echo "One or more release-prep invariants are DEAD — see FAIL lines above."
fi
exit "$fail"
