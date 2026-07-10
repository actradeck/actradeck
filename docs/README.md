# ActraDeck documentation

Where to go depending on what you need:

| I want to… | Read |
|---|---|
| Install and see my first session | [Getting started](./getting-started.md) — one-line install, quickstart, manual steps, troubleshooting |
| Observe my existing `claude` / `codex` sessions from anywhere | [Attach Mode](./attach-mode.md) — the always-on daemons (`actradeck up` / `ad-attach`), systemd & launchd, constraints |
| Govern what agents may do (approvals, YOLO gating) | [Approval policy — operations guide](./approval-policy.md) — approval flow, bypass/YOLO gate, category list, per-repo policy, persistent allowlist, kill switches |
| Add another tool or agent to the cockpit | [Public ingestion contract](./ingestion-contract.md) — normalize events, use `provider=<your slug>` / `source=external`, and POST them into ActraDeck |
| Look up an environment variable | [Configuration reference](./configuration.md) — every operator-facing setting, defaults, and which tier reads it |
| Demo the product | [90-second demo runbook](./demo-90s.md) |
| Understand why it's built this way | [Architecture decision records](./adr/) |

Quick orientation:

- **What ActraDeck is**: a local, vendor-neutral cockpit for coding agents (Claude Code,
  Codex) — live session wall, cross-vendor secret redaction before anything is stored and
  audit/replay, plus a selective approval inbox (Claude Code today, Codex in Managed Mode;
  external adapters are observe-only). The product overview lives in the repo-root
  [README](../README.md).
- **Extending ActraDeck**: third-party tools can use the public ingestion contract and
  the example adapter under [`examples/ingest-adapter/`](./examples/ingest-adapter/).
- **Security model**: single operator, local filesystem, loopback. Threat model and
  reporting: [SECURITY.md](../SECURITY.md).
- **Media**: the GIFs/videos embedded in these pages are real captures and live in
  [`media/`](./media/).
- **Languages**: shipped docs are English-canonical; `*.ja.md` are Japanese companions. Update
  the canonical file first, then sync the companion and its sync marker. Japanese companions
  currently exist for [`ingestion-contract.ja.md`](./ingestion-contract.ja.md),
  [`attach-mode.ja.md`](./attach-mode.ja.md),
  [`examples/opencode-adapter/README.ja.md`](./examples/opencode-adapter/README.ja.md), and
  [`examples/ingest-adapter/README.ja.md`](./examples/ingest-adapter/README.ja.md).
