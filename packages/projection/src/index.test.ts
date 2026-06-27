import { newEventId, parseEvent, type NormalizedEvent } from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { applyEvent, initialProjection, parsePendingApprovals, reduceEvents } from "./index.js";

function ev(o: {
  readonly session_id?: string;
  readonly event_type: string;
  readonly state?: string;
  readonly timestamp?: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
}): NormalizedEvent {
  return parseEvent({
    event_id: newEventId(),
    provider: "claude_code",
    source: "hooks",
    session_id: o.session_id ?? "s1",
    event_type: o.event_type,
    ...(o.state !== undefined ? { state: o.state } : {}),
    timestamp: o.timestamp ?? "2026-06-06T00:00:00.000Z",
    ...(o.summary !== undefined ? { summary: o.summary } : {}),
    payload: o.payload ?? {},
  });
}

describe("@actradeck/projection reducer", () => {
  it("rebuilds approval pending state and resolves by request_id", () => {
    const requested = ev({
      event_type: "tool.permission.requested",
      state: "waiting.approval",
      summary: "approval",
      payload: {
        request_id: "s1:apr-1",
        tool_name: "Bash",
        command: "rm -rf /tmp/x",
        risk_level: "high",
      },
    });
    const resolved = ev({
      event_type: "tool.permission.resolved",
      state: "running.tool_preparing",
      timestamp: "2026-06-06T00:00:01.000Z",
      summary: "resolved",
      payload: { request_id: "s1:apr-1", decision: "deny" },
    });

    const pending = applyEvent(initialProjection("s1"), requested).projection;
    expect(pending.pending_approvals).toHaveLength(1);
    expect(pending.needs_attention).toBe(true);

    const done = applyEvent(pending, resolved).projection;
    expect(done.pending_approvals).toHaveLength(0);
    expect(done.state).toBe("running.tool_preparing");
  });

  it("INV-REQUEST-ID-NAMESPACE: request_id を持つ command.* は pending_approvals に影響しない (event_type ゲート)", () => {
    // sidecar 55a5abf 以降、command.started/completed は `tu:<tool_use_id>` request_id を持つ
    // (packages/event-model/src/payload.ts)。pending_approvals の投影は event_type で
    // ゲートされており、command イベントは (a) 承認を追加しない (b) **承認キーと同一文字列の
    // request_id を持っていても** 既存 pending を解決・削除しない、ことを pin する。
    // ゲートを「request_id 存在」へ緩める退行は本ケースで赤化する (QA-2, decision 019ebc01)。
    const requested = ev({
      event_type: "tool.permission.requested",
      state: "waiting.approval",
      summary: "approval",
      payload: { request_id: "s1:apr-9", tool_name: "Bash", command: "make deploy" },
    });
    const pending = applyEvent(initialProjection("s1"), requested).projection;
    expect(pending.pending_approvals).toHaveLength(1);

    // (a) tu: namespace の command イベントは pending に乗らない。
    const completedTu = ev({
      event_type: "command.completed",
      state: "running.model_wait",
      timestamp: "2026-06-06T00:00:01.000Z",
      summary: "コマンド完了: Bash",
      payload: { kind: "command.completed", request_id: "tu:toolu_01X", exit_code: 0 },
    });
    const afterTu = applyEvent(pending, completedTu).projection;
    expect(afterTu.pending_approvals).toHaveLength(1);
    expect(afterTu.pending_approvals[0]!.request_id).toBe("s1:apr-9");

    // (b) 敵対的: 承認キーと byte 同一の request_id を command が持っても解決扱いにしない。
    const completedCollide = ev({
      event_type: "command.completed",
      state: "running.model_wait",
      timestamp: "2026-06-06T00:00:02.000Z",
      summary: "コマンド完了: Bash",
      payload: { kind: "command.completed", request_id: "s1:apr-9", exit_code: 0 },
    });
    const afterCollide = applyEvent(afterTu, completedCollide).projection;
    expect(afterCollide.pending_approvals).toHaveLength(1);
    expect(afterCollide.pending_approvals[0]!.request_id).toBe("s1:apr-9");
  });

  describe("INV-SECRET-DETECTED-FOLD: secret_detected の session 単位畳み込み", () => {
    function evWithCount(o: {
      event_id?: string;
      event_type?: string;
      timestamp?: string;
      redaction_count?: number;
      redaction_count_by_kind?: Record<string, number>;
    }): NormalizedEvent {
      return parseEvent({
        event_id: o.event_id ?? newEventId(),
        provider: "claude_code",
        source: "hooks",
        session_id: "s1",
        event_type: o.event_type ?? "heartbeat",
        timestamp: o.timestamp ?? "2026-06-06T00:00:00.000Z",
        ...(o.redaction_count !== undefined ? { redaction_count: o.redaction_count } : {}),
        ...(o.redaction_count_by_kind !== undefined
          ? { redaction_count_by_kind: o.redaction_count_by_kind }
          : {}),
        payload: {},
      });
    }

    it("initialProjection の既定は false / 0", () => {
      const init = initialProjection("s1");
      expect(init.secret_detected).toBe(false);
      expect(init.secret_redaction_count).toBe(0);
    });

    it("count を累積し bool を OR する (複数 event)", () => {
      const seq = [
        evWithCount({ redaction_count: 0, timestamp: "2026-06-06T00:00:00.000Z" }),
        evWithCount({ redaction_count: 2, timestamp: "2026-06-06T00:00:01.000Z" }),
        evWithCount({ redaction_count: 3, timestamp: "2026-06-06T00:00:02.000Z" }),
      ];
      const proj = reduceEvents("s1", seq);
      expect(proj.secret_redaction_count).toBe(5);
      expect(proj.secret_detected).toBe(true);
    });

    it("redaction_count 欠落イベントは 0 件扱い (false 維持)", () => {
      const proj = reduceEvents("s1", [
        evWithCount({ timestamp: "2026-06-06T00:00:00.000Z" }),
        evWithCount({ timestamp: "2026-06-06T00:00:01.000Z" }),
      ]);
      expect(proj.secret_detected).toBe(false);
      expect(proj.secret_redaction_count).toBe(0);
    });

    it("一度でも検出されたら以降 detected を維持する (OR 畳み)", () => {
      const proj = reduceEvents("s1", [
        evWithCount({ redaction_count: 1, timestamp: "2026-06-06T00:00:00.000Z" }),
        evWithCount({ redaction_count: 0, timestamp: "2026-06-06T00:00:01.000Z" }),
      ]);
      expect(proj.secret_detected).toBe(true);
      expect(proj.secret_redaction_count).toBe(1);
    });

    it("同一 event_id の再適用で増殖しない (冪等)", () => {
      const id = newEventId();
      const e = evWithCount({ event_id: id, redaction_count: 4 });
      const once = applyEvent(initialProjection("s1"), e).projection;
      expect(once.secret_redaction_count).toBe(4);
      expect(once.secret_detected).toBe(true);
      // 同一 event_id をもう一度 fold しても増えない。
      const twice = applyEvent(once, e).projection;
      expect(twice.secret_redaction_count).toBe(4);
      expect(twice.secret_detected).toBe(true);
    });

    describe("強み(a)③: secret_redaction_count_by_kind の kind 別 merge fold", () => {
      it("initialProjection の既定は {}", () => {
        expect(initialProjection("s1").secret_redaction_count_by_kind).toEqual({});
      });

      it("kind 別を merge し各 kind を合算する (複数 event)", () => {
        const proj = reduceEvents("s1", [
          evWithCount({
            redaction_count: 3,
            redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
            timestamp: "2026-06-06T00:00:00.000Z",
          }),
          evWithCount({
            redaction_count: 2,
            redaction_count_by_kind: { "github-token": 1, "high-entropy-secret": 1 },
            timestamp: "2026-06-06T00:00:01.000Z",
          }),
        ]);
        expect(proj.secret_redaction_count_by_kind).toEqual({
          "github-token": 3,
          "aws-access-key-id": 1,
          "high-entropy-secret": 1,
        });
        // INV: sum(by_kind) === secret_redaction_count (同出所の総和)。
        const sum = Object.values(proj.secret_redaction_count_by_kind).reduce((a, b) => a + b, 0);
        expect(sum).toBe(proj.secret_redaction_count);
        expect(sum).toBe(5);
      });

      it("kind 別件数欠落イベントは {} 維持 (no-op)", () => {
        const proj = reduceEvents("s1", [
          evWithCount({ redaction_count: 0, timestamp: "2026-06-06T00:00:00.000Z" }),
          evWithCount({ redaction_count: 0, timestamp: "2026-06-06T00:00:01.000Z" }),
        ]);
        expect(proj.secret_redaction_count_by_kind).toEqual({});
      });

      // QA-1 = TDA-2 (M / BLOCK 解消 decision 019ec6fd): legacy/混在 event (count>0・by_kind 欠落)
      //   を畳むと scalar は加算・by-kind は no-op となり sum(by_kind) < secret_redaction_count に
      //   なる。これを **仕様として明示 pin** する (旧 `===` 構造保証コメントは誇張だった)。
      //   既存 no-op テストは redaction_count:0 ゆえ sum===count(0) が自明成立し乖離を隠していた。
      it("count>0 かつ by_kind 欠落 (legacy) を畳むと sum(by_kind) < secret_redaction_count (乖離を pin)", () => {
        const proj = reduceEvents("s1", [
          // legacy 形: redaction_count はあるが redaction_count_by_kind は欠落。
          evWithCount({ redaction_count: 3, timestamp: "2026-06-06T00:00:00.000Z" }),
          // 通常形: 既知 kind 2 件。
          evWithCount({
            redaction_count: 2,
            redaction_count_by_kind: { "github-token": 2 },
            timestamp: "2026-06-06T00:00:01.000Z",
          }),
        ]);
        // scalar は全 event 合算 (3 + 2 = 5)。
        expect(proj.secret_redaction_count).toBe(5);
        // by-kind は legacy event を no-op で飛ばすため github-token 2 のみ。
        expect(proj.secret_redaction_count_by_kind).toEqual({ "github-token": 2 });
        const sum = Object.values(proj.secret_redaction_count_by_kind).reduce((a, b) => a + b, 0);
        // 正直な不変条件: sum(by_kind) <= secret_redaction_count。legacy 混在では厳密に <。
        expect(sum).toBeLessThanOrEqual(proj.secret_redaction_count);
        expect(sum).toBeLessThan(proj.secret_redaction_count);
        expect(sum).toBe(2);
      });

      // per-event は「全 secret が既知 kind」のとき sum(by_kind) === redaction_count を維持する
      //   (乖離は legacy/phantom のときだけ起き、正常経路では等号)。
      it("per-event (全 secret 既知 kind) は sum(by_kind) === redaction_count を維持", () => {
        const proj = reduceEvents("s1", [
          evWithCount({
            redaction_count: 3,
            redaction_count_by_kind: { "github-token": 2, "slack-token": 1 },
            timestamp: "2026-06-06T00:00:00.000Z",
          }),
        ]);
        const sum = Object.values(proj.secret_redaction_count_by_kind).reduce((a, b) => a + b, 0);
        expect(sum).toBe(proj.secret_redaction_count);
        expect(sum).toBe(3);
      });

      it("同一 event_id の再適用で kind 別件数も二重加算しない (冪等)", () => {
        const id = newEventId();
        const e = evWithCount({
          event_id: id,
          redaction_count: 3,
          redaction_count_by_kind: { "github-token": 2, "slack-token": 1 },
        });
        const once = applyEvent(initialProjection("s1"), e).projection;
        expect(once.secret_redaction_count_by_kind).toEqual({
          "github-token": 2,
          "slack-token": 1,
        });
        const twice = applyEvent(once, e).projection;
        // 再適用しても各 kind は増えない。
        expect(twice.secret_redaction_count_by_kind).toEqual({
          "github-token": 2,
          "slack-token": 1,
        });
        expect(twice.secret_redaction_count).toBe(3);
      });

      it("fold は prev の by_kind record を破壊しない (純関数)", () => {
        const prev = initialProjection("s1");
        const prevByKind = prev.secret_redaction_count_by_kind;
        applyEvent(
          prev,
          evWithCount({ redaction_count: 1, redaction_count_by_kind: { "github-token": 1 } }),
        );
        // prev の record は変化しない (新しい record を返す)。
        expect(prevByKind).toEqual({});
      });

      // SEC-3 (M / round-2 CONDITIONAL 解消 decision 019ec720): projection ingest 経路の closed-enum
      //   gate。network 受信イベント (token 認証された crafted event) が任意/phantom kind を
      //   redaction_count_by_kind に載せても、唯一の書込点 mergeRedactionCountByKind が
      //   REDACTION_KINDS_SET allowlist で捨てるため session_state jsonb / DTO / WS へ漏れない。
      //   背景: event-model schema は z.record(z.string(), …) で kind を全 string 許容 (loose) ゆえ
      //   parseEvent は phantom kind を通す。enforcement は projection gate が load-bearing。
      // mutation 反証: index.ts の mergeRedactionCountByKind が使う `gateRedactionCountByKind(incoming, true)`
      //   を素の incoming に戻す (gate 無効化) → foo-bar / 任意 kind が proj に載り本ブロック赤化。
      describe("INV-PROJECTION-BYKIND-ALLOWLIST (SEC-3): phantom kind を jsonb/DTO へ通さない", () => {
        it("crafted event の phantom kind (foo-bar / 任意名) は projection に現れない", () => {
          const proj = reduceEvents("s1", [
            evWithCount({
              redaction_count: 3,
              // foo-bar は loose schema を通る (parseEvent reject しない) が、projection gate が捨てる。
              redaction_count_by_kind: { "foo-bar": 2, "github-token": 1, "totally-fake": 5 },
            }),
          ]);
          // 既知 kind のみ残る。phantom は jsonb/DTO へ出ない。
          expect(proj.secret_redaction_count_by_kind).toEqual({ "github-token": 1 });
          expect(proj.secret_redaction_count_by_kind).not.toHaveProperty("foo-bar");
          expect(proj.secret_redaction_count_by_kind).not.toHaveProperty("totally-fake");
        });

        it("secret 形文字列を kind 名 (key) に注入しても projection に永続しない", () => {
          // closed-enum 契約破れ + 自己注入型表示の遮断。値は int だが kind 名自体を秘匿風文字列に
          //   できないことを pin (kind 名は redactor 由来 enum のみ)。擬似 secret は文書例。
          const injected = "ghpfaketokenstring";
          const proj = reduceEvents("s1", [
            evWithCount({
              redaction_count: 1,
              redaction_count_by_kind: { [injected]: 1, "slack-token": 1 },
            }),
          ]);
          expect(proj.secret_redaction_count_by_kind).toEqual({ "slack-token": 1 });
          expect(Object.keys(proj.secret_redaction_count_by_kind)).not.toContain(injected);
        });

        it("phantom のみの event は projection by_kind を空に保つ", () => {
          const proj = reduceEvents("s1", [
            evWithCount({ redaction_count: 2, redaction_count_by_kind: { "foo-bar": 2 } }),
          ]);
          expect(proj.secret_redaction_count_by_kind).toEqual({});
          // scalar は別経路 (event 載値) ゆえ phantom 排除に巻き込まれない (sum<=count 維持)。
          expect(proj.secret_redaction_count).toBe(2);
        });
      });

      // QA-1r (M / round-2 CONDITIONAL 解消): mergeRedactionCountByKind の prototype 防御を
      //   projection test で **load-bearing に pin** する (redactor 側の toBeUndefined 相当を projection
      //   にも)。constructor/__proto__ 等の proto 名 kind を merge しても値が文字列化せず・継承汚染なし。
      // mutation 反証:
      //   (a) `Object.create(null)` を `{}` に戻す → constructor 経由で型崩壊/汚染し本ブロック赤化。
      //   (b) allowlist gate を外す → proto 名 kind が proj に載り赤化 (allowlist も proto 名を弾く)。
      describe("INV-PROJECTION-BYKIND-PROTO (QA-1r): prototype 名 kind の型崩壊/汚染なし", () => {
        it("constructor / __proto__ を含む incoming を畳んでも値は number・proj に proto 名が載らない", () => {
          // constructor は loose schema を通る。__proto__ は zod が own-key から strip する。
          const proj = reduceEvents("s1", [
            evWithCount({
              redaction_count: 7,
              redaction_count_by_kind: {
                constructor: 5,
                __proto__: 9,
                "github-token": 2,
              } as Record<string, number>,
            }),
          ]);
          // 既知 kind のみ残る (proto 名は allowlist 非該当で捨てられる)。
          expect(proj.secret_redaction_count_by_kind).toEqual({ "github-token": 2 });
          // 値はすべて number (文字列化していない)。
          for (const v of Object.values(proj.secret_redaction_count_by_kind)) {
            expect(typeof v).toBe("number");
          }
          // 継承汚染なし: グローバル Object.prototype が汚れていない。
          expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
          expect((Object.prototype as Record<string, unknown>)["constructor"]).toBe(Object);
        });

        it("merge 後の by_kind record は null-prototype (Object.create(null) が load-bearing)", () => {
          // allowlist gate と独立に null-proto 防御を pin する。allowlist は kind 名を弾くが、
          //   蓄積側の null-proto は「proto 名が継承プロパティとして解決されない」ことを構造で保証する。
          // mutation 反証: index.ts の `Object.create(null)` を `{}` に戻す → prototype が Object.prototype
          //   になり本 assert が赤化する (allowlist だけでは検出できない死角を専用に塞ぐ)。
          const proj = reduceEvents("s1", [
            evWithCount({
              redaction_count: 2,
              redaction_count_by_kind: { "github-token": 2 },
            }),
          ]);
          expect(Object.getPrototypeOf(proj.secret_redaction_count_by_kind)).toBeNull();
          // 継承プロパティ (toString / constructor) が record 経由で参照解決されない。
          expect(
            (proj.secret_redaction_count_by_kind as Record<string, unknown>)["toString"],
          ).toBeUndefined();
          expect(
            (proj.secret_redaction_count_by_kind as Record<string, unknown>)["constructor"],
          ).toBeUndefined();
        });
      });

      // SEC-1r / TDA-4 (round-2): merge は incoming だけでなく **prev (DB jsonb 由来)** も同一
      //   helper で再 gate する。所有パッケージ (T1 canonical) の自前 suite で prev-gate を
      //   load-bearing に pin する (旧: backend alias 経由でしか赤化しなかった死角を埋める)。
      // mutation 反証: index.ts merge の `gateRedactionCountByKind(prev, true)` を素の prev コピーに
      //   戻す → phantom/constructor が持ち越され本ブロック赤化。
      describe("INV-PROJECTION-BYKIND-PREV-GATE (SEC-1r/TDA-4): prev の phantom を持ち越さない", () => {
        it("prev jsonb に紛れた phantom / proto 名 kind は fold で除外される", () => {
          // ops backfill / restore / 第二 writer で prev に phantom が入った想定を手組みする。
          const prev = {
            ...initialProjection("s1"),
            state: "running.model_wait",
            last_event_id: "e0",
            secret_detected: true,
            secret_redaction_count: 2,
            secret_redaction_count_by_kind: JSON.parse(
              '{"github-token":2,"phantom-evil-kind":9,"constructor":7}',
            ) as Record<string, number>,
          };
          const out = applyEvent(
            prev,
            evWithCount({ redaction_count: 1, redaction_count_by_kind: { "github-token": 1 } }),
          ).projection.secret_redaction_count_by_kind;
          // 既知 kind のみ持ち越し合算。phantom / proto 名は prev gate で落ちる。
          expect(out).toEqual({ "github-token": 3 });
          expect(Object.prototype.hasOwnProperty.call(out, "phantom-evil-kind")).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(out, "constructor")).toBe(false);
        });
      });
    });

    it("同じ event 列 (redaction_count を **載せた** 列) の再 reduce は決定的に同値", () => {
      // TDA-2: ここでの決定性は「**redaction_count を保持した同一 event 列**を再 fold すると
      //   同値になる」という fold の純関数性のみを主張する。events に count を永続しない実運用では
      //   events からの rebuild で count は 0 になり再現しない (session_state が唯一の権威)。
      //   「Session Replay 整合」(events から完全 rebuild) は count には適用されないため主張しない。
      const seq = [
        evWithCount({ redaction_count: 2, timestamp: "2026-06-06T00:00:00.000Z" }),
        evWithCount({ redaction_count: 0, timestamp: "2026-06-06T00:00:01.000Z" }),
        evWithCount({ redaction_count: 1, timestamp: "2026-06-06T00:00:02.000Z" }),
      ];
      const a = reduceEvents("s1", seq);
      const b = reduceEvents("s1", seq);
      expect(a.secret_redaction_count).toBe(3);
      expect(a).toEqual(b);
    });
  });

  /**
   * 自動ガード (ADR 019ecc70 D3) 段階1 下流スライス: pending_approvals が guard 理由
   * (trigger / secret_kinds) を closed-enum 防御つきで運ぶことを固定する。
   */
  describe("INV-AUTOGUARD-PROJECTION-CARRY: trigger/secret_kinds を pending へ畳む / resolved で消える", () => {
    function requestedGuard(payload: Record<string, unknown>): NormalizedEvent {
      return ev({
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        summary: "approval",
        timestamp: "2026-06-15T00:00:00.000Z",
        payload: { request_id: "s1:apr-g", tool_name: "Bash", ...payload },
      });
    }

    it("trigger=secret / secret_kinds=[github-token] が pending に載る", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({
          command: "echo $GITHUB_TOKEN",
          risk_level: "high",
          trigger: "secret",
          secret_kinds: ["github-token"],
        }),
      ).projection;
      expect(proj.pending_approvals).toHaveLength(1);
      const p = proj.pending_approvals[0]!;
      // mutation 反証: foldPendingApprovals の trigger/secret_kinds 行を allow-list から外すと赤化。
      expect(p.trigger).toBe("secret");
      expect(p.secret_kinds).toEqual(["github-token"]);
    });

    it("trigger=both / 複数 secret_kinds を保持する", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({
          command: "rm -rf / && echo $AWS",
          trigger: "both",
          secret_kinds: ["github-token", "aws-access-key-id"],
        }),
      ).projection;
      const p = proj.pending_approvals[0]!;
      expect(p.trigger).toBe("both");
      expect(p.secret_kinds).toEqual(["github-token", "aws-access-key-id"]);
    });

    it("destructive のみ (secret_kinds 無し) は trigger=destructive / secret_kinds=undefined", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({ command: "rm -rf /tmp/x", risk_level: "high", trigger: "destructive" }),
      ).projection;
      const p = proj.pending_approvals[0]!;
      expect(p.trigger).toBe("destructive");
      expect(p.secret_kinds).toBeUndefined();
    });

    it("guard 理由が全く無い旧経路は trigger/secret_kinds ともに undefined (後方互換)", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({ command: "make build" }),
      ).projection;
      const p = proj.pending_approvals[0]!;
      expect(p.trigger).toBeUndefined();
      expect(p.secret_kinds).toBeUndefined();
    });

    it("resolved (同 request_id) で pending が消える (resolved には trigger/secret_kinds 無し)", () => {
      let proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({ trigger: "secret", secret_kinds: ["github-token"] }),
      ).projection;
      expect(proj.pending_approvals).toHaveLength(1);
      const resolved = ev({
        event_type: "tool.permission.resolved",
        state: "running.tool_preparing",
        timestamp: "2026-06-15T00:00:01.000Z",
        payload: { request_id: "s1:apr-g", decision: "deny" },
      });
      proj = applyEvent(proj, resolved).projection;
      expect(proj.pending_approvals).toHaveLength(0);
    });
  });

  /**
   * INV-PERSIST-PROJECTION-CARRY (ADR 019ee0c0): permission.requested の persistable を pending DTO へ
   * closed-enum boolean で畳む (read/write 対称)。**リテラル true のみ**採用し、"true" 文字列 / 1 /
   * 欠落は undefined (= 永続化不可 = 安全側)。crafted event が文字列等で UI 永続ボタンを誤提示させない。
   * mutation 反証: foldPendingApprovals の persistable 行を消すと「載る」テストが赤化。normalizePersistable を
   *   `Boolean(v)` に変えると「"true" 文字列 → undefined」「1 → undefined」が赤化。
   */
  describe("INV-PERSIST-PROJECTION-CARRY: persistable を closed-enum boolean で畳む", () => {
    function requested(payload: Record<string, unknown>): NormalizedEvent {
      return ev({
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: "2026-06-15T00:00:00.000Z",
        payload: { request_id: "s1:apr-p", tool_name: "Bash", ...payload },
      });
    }

    it("persistable=true (リテラル) が pending に載る (write 層)", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requested({ command: "find . -delete", risk_level: "medium", persistable: true }),
      ).projection;
      expect(proj.pending_approvals[0]!.persistable).toBe(true);
    });

    it("persistable 無し → undefined (後方互換・既存経路は永続化不可)", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requested({ command: "rm -rf /tmp/x", risk_level: "high" }),
      ).projection;
      expect(proj.pending_approvals[0]!.persistable).toBeUndefined();
    });

    it.each([
      ["文字列 'true'", "true"],
      ["数値 1", 1],
      ["false", false],
      ["オブジェクト", {}],
    ])("persistable=%s (非リテラル true) は undefined に落とす", (_label, val) => {
      const proj = applyEvent(
        initialProjection("s1"),
        requested({ command: "find . -delete", persistable: val }),
      ).projection;
      expect(proj.pending_approvals[0]!.persistable).toBeUndefined();
    });

    it("read 層 (parsePendingApprovals) も同じ closed-enum boolean 防御を対称適用する", () => {
      const parsed = parsePendingApprovals([
        { request_id: "r1", persistable: true },
        { request_id: "r2", persistable: "true" }, // 文字列 → drop
        { request_id: "r3" }, // 欠落 → undefined
      ]);
      expect(parsed.find((p) => p.request_id === "r1")!.persistable).toBe(true);
      expect(parsed.find((p) => p.request_id === "r2")!.persistable).toBeUndefined();
      expect(parsed.find((p) => p.request_id === "r3")!.persistable).toBeUndefined();
    });
  });

  /**
   * INV-AUTOGUARD-PROJECTION-NO-RAW (ADR 019ecc70 D3 / PR#29 no-raw-display と同方針):
   * secret_kinds に未知値 / raw 文字列 (例 "ghp_xxx") が来ても投影で drop され、語彙 (REDACTION_KINDS)
   * のみが残る。trigger も closed-enum 3 値以外は drop。原文 / 未知文字列を投影に残さない。
   * mutation 反証: index.ts normalizeSecretKinds の isKnownRedactionKind filter を外す → raw が proj に
   *   載り本ブロック赤化。normalizeTrigger の APPROVAL_TRIGGERS gate を外す → 任意 trigger が載り赤化。
   */
  describe("INV-AUTOGUARD-PROJECTION-NO-RAW: 未知/raw を drop し語彙のみ投影", () => {
    function requestedGuard(payload: Record<string, unknown>): NormalizedEvent {
      return ev({
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: "2026-06-15T00:00:00.000Z",
        payload: { request_id: "s1:apr-r", tool_name: "Bash", ...payload },
      });
    }

    it("raw secret 文字列 (ghp_xxx) を secret_kinds に注入しても投影に出ない", () => {
      const rawSecret = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({
          trigger: "secret",
          secret_kinds: [rawSecret, "github-token", "totally-fake-kind"],
        }),
      ).projection;
      const p = proj.pending_approvals[0]!;
      // 既知 kind のみ残る。raw / phantom は drop。
      expect(p.secret_kinds).toEqual(["github-token"]);
      expect(p.secret_kinds).not.toContain(rawSecret);
      expect(p.secret_kinds).not.toContain("totally-fake-kind");
      // raw が DTO 相当の文字列化に一切現れない (no-raw)。
      expect(JSON.stringify(proj.pending_approvals)).not.toContain("ghp_");
    });

    it("全要素が未知なら secret_kinds=undefined (空配列でなくキー落とし)", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({ trigger: "secret", secret_kinds: ["nope", "still-nope", 123] }),
      ).projection;
      expect(proj.pending_approvals[0]!.secret_kinds).toBeUndefined();
    });

    it("非配列 secret_kinds は undefined", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({ trigger: "secret", secret_kinds: "github-token" }),
      ).projection;
      expect(proj.pending_approvals[0]!.secret_kinds).toBeUndefined();
    });

    it("未知 trigger (任意文字列) は drop = undefined (closed-enum)", () => {
      const proj = applyEvent(
        initialProjection("s1"),
        requestedGuard({ trigger: "ghp_injected_as_trigger", secret_kinds: ["github-token"] }),
      ).projection;
      const p = proj.pending_approvals[0]!;
      expect(p.trigger).toBeUndefined();
      // secret_kinds 側は正常 kind ゆえ残る (各フィールド独立 gate)。
      expect(p.secret_kinds).toEqual(["github-token"]);
    });

    it("parsePendingApprovals (read 層) も同じ closed-enum 防御を対称適用する", () => {
      // jsonb at-rest → DTO 透過点。crafted jsonb に raw/未知が混じっても drop。
      const parsed = parsePendingApprovals([
        {
          request_id: "s1:apr-x",
          trigger: "secret",
          secret_kinds: ["github-token", "ghp_rawvalue", "phantom"],
        },
        {
          request_id: "s1:apr-y",
          trigger: "bogus-trigger",
          secret_kinds: ["nope"],
        },
      ]);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.trigger).toBe("secret");
      expect(parsed[0]!.secret_kinds).toEqual(["github-token"]);
      expect(parsed[1]!.trigger).toBeUndefined();
      expect(parsed[1]!.secret_kinds).toBeUndefined();
      expect(JSON.stringify(parsed)).not.toContain("ghp_");
    });
  });

  it("is deterministic over the same event sequence", () => {
    const seq = [
      ev({ event_type: "session.started", state: "starting", summary: "start" }),
      ev({
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: "2026-06-06T00:00:01.000Z",
        summary: "npm test",
        payload: { command: "npm test" },
      }),
      ev({
        event_type: "turn.completed",
        state: "completed",
        timestamp: "2026-06-06T00:00:02.000Z",
        summary: "done",
      }),
    ];
    expect(reduceEvents("s1", seq)).toEqual(reduceEvents("s1", seq));
  });

  describe("INV-CURRENT-ACTION-KIND: 最新イベントの event_type を ActionKind へ写す", () => {
    it("initialProjection は kind/subject ともに undefined", () => {
      const p = initialProjection("s1");
      expect(p.current_action_kind).toBeUndefined();
      expect(p.current_action_subject).toBeUndefined();
    });

    it("各 event_type が期待 ActionKind を返す (legacy current_action は保持)", () => {
      const cases: ReadonlyArray<[string, string]> = [
        ["session.started", "session"],
        ["turn.started", "turn"],
        ["agent.message.delta", "message"],
        ["tool.permission.requested", "approval"],
        ["command.started", "command"],
        ["file.change.applied", "file"],
        ["mcp.call.started", "mcp"],
        ["web.search.started", "web"],
        ["tool.started", "tool"],
        ["error", "tool"],
        ["heartbeat", "liveness"],
        ["subagent.started", "other"],
      ];
      for (const [eventType, expectedKind] of cases) {
        const out = applyEvent(initialProjection("s1"), ev({ event_type: eventType })).projection;
        expect(out.current_action_kind).toBe(expectedKind);
      }
    });

    it("kind は最新イベント由来で更新される (世代が古い kind を残さない)", () => {
      let p = applyEvent(initialProjection("s1"), ev({ event_type: "command.started" })).projection;
      expect(p.current_action_kind).toBe("command");
      p = applyEvent(
        p,
        ev({ event_type: "web.search.started", payload: { query: "q" } }),
      ).projection;
      expect(p.current_action_kind).toBe("web");
    });

    it("subject は最新イベント由来で更新される (世代が古い subject を残さない)", () => {
      let p = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "command.started", payload: { command: "npm test" } }),
      ).projection;
      expect(p.current_action_subject).toBe("npm test");
      expect(p.current_action_kind).toBe("command");
      // 別 kind のイベントを続けて適用 → subject/kind が共に最新へ更新され、
      // event1 の subject ("npm test") を保持しない (load-bearing: 古い subject の残留禁止)。
      p = applyEvent(
        p,
        ev({ event_type: "file.change.applied", payload: { path: "src/x.ts" } }),
      ).projection;
      expect(p.current_action_subject).toBe("src/x.ts");
      expect(p.current_action_subject).not.toBe("npm test");
      expect(p.current_action_kind).toBe("file");
    });
  });

  describe("INV-CURRENT-ACTION-SUBJECT: redacted payload allowlist から subject を引く", () => {
    it("command 系は payload.command を引く", () => {
      const out = applyEvent(
        initialProjection("s1"),
        ev({
          event_type: "command.started",
          summary: "コマンド実行: npm test", // 日本語焼付け summary は subject にしない
          payload: { command: "npm test" },
        }),
      ).projection;
      expect(out.current_action_subject).toBe("npm test");
      // legacy current_action (summary) は保持される (fallback)。
      expect(out.current_action).toBe("コマンド実行: npm test");
    });

    it("file 系は payload.path を引く", () => {
      const out = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "file.change.applied", payload: { path: "src/app.ts" } }),
      ).projection;
      expect(out.current_action_subject).toBe("src/app.ts");
    });

    it("mcp 系は server/tool を組み立てる", () => {
      const out = applyEvent(
        initialProjection("s1"),
        ev({
          event_type: "mcp.call.started",
          payload: { server: "memorymcp", tool: "decision.add" },
        }),
      ).projection;
      expect(out.current_action_subject).toBe("memorymcp/decision.add");
    });

    it("web 系は payload.query を引く", () => {
      const out = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "web.search.started", payload: { query: "OTLP GenAI spec" } }),
      ).projection;
      expect(out.current_action_subject).toBe("OTLP GenAI spec");
    });

    it("tool 系は payload.tool_name を引く", () => {
      const out = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "tool.started", payload: { tool_name: "Read" } }),
      ).projection;
      expect(out.current_action_subject).toBe("Read");
    });

    it("permission は command 優先・無ければ path", () => {
      const withCmd = applyEvent(
        initialProjection("s1"),
        ev({
          event_type: "tool.permission.requested",
          payload: { request_id: "s1:apr-1", command: "rm -rf x", path: "x" },
        }),
      ).projection;
      expect(withCmd.current_action_subject).toBe("rm -rf x");
      const withPath = applyEvent(
        initialProjection("s1"),
        ev({
          event_type: "tool.permission.requested",
          payload: { request_id: "s1:apr-2", path: "secrets.txt" },
        }),
      ).projection;
      expect(withPath.current_action_subject).toBe("secrets.txt");
    });

    it("session.ended は reason / turn.failed は error 優先・reason fallback (T1 正典)", () => {
      // TDA-2: T1 (payload.ts) では SessionEnded=reason 専有・TurnFailed=error が正典。
      //   codex rollout turn_aborted は error と reason を両載せ → error を優先する。
      const ended = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "session.ended", state: "completed", payload: { reason: "user_exit" } }),
      ).projection;
      expect(ended.current_action_subject).toBe("user_exit");
      const failed = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "turn.failed", state: "failed", payload: { error: "boom" } }),
      ).projection;
      expect(failed.current_action_subject).toBe("boom");
      // error と reason 両載せ (codex rollout) では error を優先 (T1 正典フィールド)。
      const both = applyEvent(
        initialProjection("s1"),
        ev({
          event_type: "turn.failed",
          state: "failed",
          payload: { error: "aborted", reason: "user_cancel" },
        }),
      ).projection;
      expect(both.current_action_subject).toBe("aborted");
      // error 欠落時のみ reason へ後方互換 fallback。
      const onlyReason = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "turn.failed", state: "failed", payload: { reason: "user_cancel" } }),
      ).projection;
      expect(onlyReason.current_action_subject).toBe("user_cancel");
    });

    it("構造的 subject が無い event_type は undefined (diff.updated / heartbeat / turn.completed)", () => {
      for (const eventType of ["diff.updated", "heartbeat", "turn.completed"]) {
        const out = applyEvent(
          initialProjection("s1"),
          ev({ event_type: eventType, summary: "焼付け日本語要約" }),
        ).projection;
        expect(out.current_action_subject).toBeUndefined();
      }
    });
  });

  describe("INV-CURRENT-ACTION-NO-LEAK: subject は redacted payload を写すだけ (再 redaction しない)", () => {
    // projection は sidecar choke を信頼する: payload は既に redactDeepWithCount を通過済 (= marker 化済)。
    // 単体では「redacted payload を写すと marker がそのまま subject になる」を pin する。raw secret を
    // payload に入れても、projection は payload を再解釈せず**そのまま写す**ため、sink を通った後の
    // marker が subject になる契約を担保する (e2e の no-leak は backend/sidecar 層で別途)。
    it("redacted な command (marker 含む) はそのまま subject になる (改変しない)", () => {
      const redactedCommand = "export TOKEN=[REDACTED:github-token] && deploy";
      const out = applyEvent(
        initialProjection("s1"),
        ev({ event_type: "command.started", payload: { command: redactedCommand } }),
      ).projection;
      expect(out.current_action_subject).toBe(redactedCommand);
      // raw secret 形が残っていないことも pin (この入力には raw が無い = sink 後の正しい状態)。
      expect(out.current_action_subject).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    });

    it("subject の出所は payload のみ・summary は決して使わない", () => {
      // summary に「対象らしき」文字列があっても subject は payload からしか引かない。
      const out = applyEvent(
        initialProjection("s1"),
        ev({
          event_type: "command.started",
          summary: "コマンド実行: ghp_RAW_SECRET_FROM_SUMMARY_SHOULD_NOT_LEAK",
          payload: { command: "[REDACTED:github-token]" },
        }),
      ).projection;
      expect(out.current_action_subject).toBe("[REDACTED:github-token]");
      // summary 由来の raw が subject に混入しないこと (出所が payload 限定である証左)。
      expect(out.current_action_subject).not.toContain("ghp_RAW_SECRET_FROM_SUMMARY");
    });
  });
});
