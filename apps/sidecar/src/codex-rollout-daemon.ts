import { randomBytes } from "node:crypto";

import { AttachSessionRegistry } from "./attach-session-registry.js";
import { CodexRolloutTailer } from "./codex-rollout-tailer.js";
import { buildEvent } from "./event-factory.js";
import { EventSink, type OutOfOrderObservation } from "./sink.js";
import { EventStore } from "./store.js";
import { WsClient } from "./ws-client.js";

export interface CodexRolloutDaemonOptions {
  readonly wsUrl: string;
  readonly dbPath: string;
  readonly codexHome?: string;
  readonly statePath?: string;
  readonly pollIntervalMs?: number;
  readonly backfill?: boolean;
  readonly ingestToken?: string;
  readonly onWarning?: (message: string) => void;
  readonly onValidationError?: (eventType: string, message: string) => void;
  readonly onOutOfOrder?: (obs: OutOfOrderObservation) => void;
  readonly onInterruptIgnored?: (sessionId: string | undefined) => void;
}

type BuiltEvent = ReturnType<typeof buildEvent>;

export class CodexRolloutDaemon {
  readonly store: EventStore;
  readonly wsClient: WsClient;
  readonly sink: EventSink;
  readonly registry: AttachSessionRegistry;
  readonly tailer: CodexRolloutTailer;
  private readonly controlToken: string;
  private readonly onInterruptIgnored: ((sessionId: string | undefined) => void) | undefined;
  private started = false;

  constructor(opts: CodexRolloutDaemonOptions) {
    this.controlToken = randomBytes(32).toString("base64url");
    this.onInterruptIgnored = opts.onInterruptIgnored;
    this.store = new EventStore(opts.dbPath);
    this.wsClient = new WsClient({
      url: opts.wsUrl,
      store: this.store,
      controlToken: this.controlToken,
      // ADR 019f1582 follow-up: codex-rollout は observe-only で policyRequest ハンドラを持たない
      // (interrupt のみ wire)。policyCapable は既定 false のまま広告せず、backend の connectedDaemons から
      // 除外させる (UI が policy 非対応 daemon を addressing して timeout する事故を防ぐ)。
      sessionIdsProvider: () => this.registry.sessionIds(),
      ...(opts.ingestToken !== undefined && opts.ingestToken.length > 0
        ? { ingestToken: opts.ingestToken }
        : {}),
    });
    this.sink = new EventSink({
      store: this.store,
      wsClient: this.wsClient,
      ...(opts.onValidationError !== undefined
        ? { onValidationError: opts.onValidationError }
        : {}),
      ...(opts.onOutOfOrder !== undefined ? { onOutOfOrder: opts.onOutOfOrder } : {}),
    });

    const onGitEvent = (ev: BuiltEvent): void => {
      this.sink.emit(this.withRolloutMode(ev));
    };
    this.registry = new AttachSessionRegistry({
      onGitEvent,
      onChange: () => this.wsClient.reannounce(),
    });

    this.tailer = new CodexRolloutTailer({
      ...(opts.codexHome !== undefined ? { codexHome: opts.codexHome } : {}),
      ...(opts.statePath !== undefined ? { statePath: opts.statePath } : {}),
      ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      ...(opts.backfill !== undefined ? { backfill: opts.backfill } : {}),
      ...(opts.onWarning !== undefined ? { onWarning: opts.onWarning } : {}),
      onSessionContext: ({ sessionId, cwd }) => {
        this.registry.observeHook(sessionId, cwd);
        this.wsClient.reannounce();
      },
      onEvents: (events) => {
        for (const event of events) this.sink.emit(event);
      },
    });

    this.wsClient.on("interrupt", (msg: { session_id?: string }) => {
      this.onInterruptIgnored?.(typeof msg.session_id === "string" ? msg.session_id : undefined);
    });
  }

  private withRolloutMode(ev: BuiltEvent): BuiltEvent {
    return {
      ...ev,
      provider: "codex",
      source: "rollout",
      capture_mode: "codex_rollout",
    };
  }

  get observedSessionCount(): number {
    return this.registry.size;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.wsClient.connect();
    await this.tailer.start();
    this.started = true;
  }

  async shutdown(): Promise<void> {
    await this.tailer.stop();
    await this.registry.dispose();
    this.wsClient.notifyAppended();
    this.wsClient.close();
    this.store.close();
  }
}
