"use client";

/**
 * useRealtime — RealtimeClient + reducer を React 状態へ橋渡しするフック.
 *
 * 状態と表示の分離: フックは「接続状態 / 一覧 ListState / 選択中 detail」を保持し、
 * RealtimeClient からの ServerFrame を reducer に通すだけ。描画は呼び元コンポーネント。
 * socketFactory を注入可能にして (既定 = browser WebSocket)、テスト/SSR で差し替えられる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RealtimeClient, type ConnectionStatus, type SocketFactory } from "../realtime/client";
import {
  emptyListState,
  purgeStale,
  toDisplayList,
  type ListState,
} from "../realtime/list-reducer";

import {
  ackFromServerFrame,
  buildApproveFrame,
  markApproveSending,
  reduceApproveAck,
  type ApprovalDecision,
  type AckState,
} from "./approval-display";
import { applyListFrame } from "./list-frame-glue";

import type { ServerFrame, SessionDetail, SessionListItem } from "../realtime/contract";

export interface UseRealtimeOptions {
  /** same-origin BFF WS URL。token は含めない (BFF が server-side で付与)。 */
  readonly url: string;
  /** 既定 = browser の WebSocket。SSR/テストで差し替える。 */
  readonly socketFactory?: SocketFactory;
  /**
   * delta.list 受信時に prev→curr を渡すフック（既定なし）。通知エンジン等の副作用配線に使う。
   * **snapshot.list では呼ばない**（初回 snapshot で既に true の session を一斉発火させないため）。
   * 純粋に観測エッジを渡すだけで、リスト state 自体には影響しない。
   */
  readonly onListDelta?: (prev: SessionListItem | undefined, curr: SessionListItem) => void;
}

export interface UseRealtimeResult {
  readonly status: ConnectionStatus;
  readonly sessions: readonly SessionListItem[];
  readonly selectedId: string | null;
  readonly detail: SessionDetail | null;
  readonly select: (sessionId: string) => void;
  readonly clearSelection: () => void;
  /**
   * 承認判断を送信する (D3: 楽観更新しない)。送信時点で lastAck に "送信中" を立て、
   * backend の ack(ok/error) を request_id 突合で反映する。pending の消滅は delta.detail が確定。
   */
  readonly approve: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
    persist?: boolean,
  ) => void;
  /** session の実行を中断要求する (interrupt frame 送信)。 */
  readonly interrupt: (sessionId: string) => void;
  /** approve ack を request_id をキーに保持 (カードの送信中/許可送信済/拒否送信済/relay失敗 表示用)。 */
  readonly lastAck: ReadonlyMap<string, AckState>;
  /** 履歴(connected=false)も表示するか。既定 false=接続在席のみ(ADR 019ea2bf)。 */
  readonly showHistory: boolean;
  /** 履歴トグルの切替(localStorage 永続)。 */
  readonly setShowHistory: (v: boolean) => void;
  /** 接続在席(connected=true)の session 数(トグル既定で見えている件数)。 */
  readonly connectedCount: number;
  /** 受信済み全 session 数(履歴含む。トグル ON で見える件数)。 */
  readonly totalCount: number;
}

function browserSocketFactory(url: string): ReturnType<SocketFactory> {
  // ブラウザ native WebSocket を SocketLike として返す。token は URL に含めない (BFF が付与)。
  return new WebSocket(url) as unknown as ReturnType<SocketFactory>;
}

/**
 * 履歴トグル(connected=false も表示するか)の永続キー。ADR 019ea2bf。
 * 既定 false = 接続在席のみ。SSR/localStorage 不在では false 初期(架空状態を出さない)。
 */
const SHOW_HISTORY_STORAGE_KEY = "actradeck.list.showHistory";

function readShowHistory(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(SHOW_HISTORY_STORAGE_KEY) === "1";
  } catch {
    return false; // localStorage 不可(プライベートモード等)は既定 false。
  }
}

function persistShowHistory(v: boolean): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(SHOW_HISTORY_STORAGE_KEY, v ? "1" : "0");
  } catch {
    // 永続失敗は無視(セッション内 state は保持される)。
  }
}

export function useRealtime(opts: UseRealtimeOptions): UseRealtimeResult {
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [listState, setListState] = useState<ListState>(emptyListState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [lastAck, setLastAck] = useState<ReadonlyMap<string, AckState>>(() => new Map());
  const clientRef = useRef<RealtimeClient | null>(null);
  const selectedRef = useRef<string | null>(null);
  // 最新の listState を保持（delta.list で prev を副作用に渡すため。setState 内で副作用を起こさない）。
  const listStateRef = useRef<ListState>(emptyListState);
  // onListDelta を最新参照で呼ぶ（handleFrame を作り直さない）。
  const onListDeltaRef = useRef<UseRealtimeOptions["onListDelta"]>(opts.onListDelta);
  onListDeltaRef.current = opts.onListDelta;

  const handleFrame = useCallback((frame: ServerFrame) => {
    switch (frame.type) {
      case "snapshot.list":
      case "delta.list": {
        // list 反映 + onListDelta 副作用は純経路 (applyListFrame) へ委譲 (単一出所・node で配線検証可能)。
        // snapshot は onListDelta を呼ばない / delta は反映前 prev を渡し 1 回呼ぶ — 契約は glue が pin。
        listStateRef.current = applyListFrame(listStateRef.current, frame, onListDeltaRef.current);
        setListState(listStateRef.current);
        return;
      }
      case "snapshot.detail":
        if (frame.session_id === selectedRef.current) setDetail(frame.detail);
        return;
      case "delta.detail":
        if (frame.session_id === selectedRef.current) setDetail(frame.detail);
        return;
      case "ack": {
        // 承認 ack のみ request_id 突合で lastAck へ反映 (D3: ok/error を表示するだけ。
        // pending の消滅は delta.detail が確定させる)。subscribe/unsubscribe/interrupt ack や
        // request_id を持たない ack は表示状態に触れない。action フィルタは ackFromServerFrame
        // (純関数・単一出所) が担い、null のとき lastAck を変えない。
        const ack = ackFromServerFrame(frame);
        if (ack) setLastAck((prev) => reduceApproveAck(prev, ack));
        return;
      }
    }
  }, []);

  const factory = opts.socketFactory ?? browserSocketFactory;
  useEffect(() => {
    const client = new RealtimeClient({
      url: opts.url,
      socketFactory: factory,
      onFrame: handleFrame,
      onStatus: setStatus,
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [opts.url, factory, handleFrame]);

  // 古いイベントの purge を定期実行 (バックプレッシャ対策・live は消さない)。
  useEffect(() => {
    const id = setInterval(() => {
      setListState((prev) => {
        const next = purgeStale(prev);
        listStateRef.current = next; // prev 参照を最新に保つ（purge も反映）。
        return next;
      });
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const select = useCallback((sessionId: string) => {
    const client = clientRef.current;
    if (!client) return;
    if (selectedRef.current && selectedRef.current !== sessionId) {
      client.unsubscribe(selectedRef.current);
    }
    selectedRef.current = sessionId;
    setSelectedId(sessionId);
    setDetail(null);
    client.subscribe(sessionId);
  }, []);

  const clearSelection = useCallback(() => {
    const client = clientRef.current;
    if (client && selectedRef.current) client.unsubscribe(selectedRef.current);
    selectedRef.current = null;
    setSelectedId(null);
    setDetail(null);
  }, []);

  const approve = useCallback(
    (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
      reason?: string,
      persist?: boolean,
    ) => {
      const client = clientRef.current;
      if (!client) return;
      // D3: 送信時点では pending を消さず、ack 待ち ("送信中") を request_id へ立てるだけ。
      setLastAck((prev) => markApproveSending(prev, requestId, decision));
      // ADR 019ee0c0: persist=true は「再起動後も許可」(allow_for_session + 永続) のとき。
      client.send(buildApproveFrame(sessionId, requestId, decision, reason, persist));
    },
    [],
  );

  const interrupt = useCallback((sessionId: string) => {
    const client = clientRef.current;
    if (!client) return;
    client.send({ type: "interrupt", session_id: sessionId });
  }, []);

  // 履歴トグル(初期値は localStorage、SSR 安全)。
  const [showHistory, setShowHistoryState] = useState<boolean>(false);
  useEffect(() => {
    // クライアントマウント後に永続値を反映(SSR ハイドレーション不一致を避けるため初期は false)。
    setShowHistoryState(readShowHistory());
  }, []);
  const setShowHistory = useCallback((v: boolean) => {
    setShowHistoryState(v);
    persistShowHistory(v);
  }, []);

  const sessions = useMemo(
    () => toDisplayList(listState, { showHistory }),
    [listState, showHistory],
  );
  const connectedCount = useMemo(() => {
    let n = 0;
    for (const s of listState.items.values()) if (s.connected !== false) n++;
    return n;
  }, [listState]);
  const totalCount = listState.items.size;

  return {
    status,
    sessions,
    selectedId,
    detail,
    select,
    clearSelection,
    approve,
    interrupt,
    lastAck,
    showHistory,
    setShowHistory,
    connectedCount,
    totalCount,
  };
}
