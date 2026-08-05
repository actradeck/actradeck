/**
 * CockpitBoard 系テストが共有する周辺 hook の中立 mock 実装 (cockpit sweep TDA-2)。
 *
 * cockpit-hidden-history / cockpit-post-demo-wiring / cockpit-board-adapter の 3 ファイルで
 * factory body が byte 重複していたものを単一出所化する。`vi.mock(path, factory)` 自体は
 * hoisting 制約で各テストファイルに残し、返す実装だけを async factory + dynamic import で
 * ここから参照する。
 *
 * **検証対象の mock はここに置かない**: 各テストがアサートする mock (use-realtime の
 * 可変 state / post-demo の use-daemons・use-readiness の vi.fn 呼び出し検証ラッパ等) は
 * ファイル固有のまま — ここは「そのテストが見ていない周辺 hook を無害化する中立実装」専用。
 */

export function notificationsHookMock() {
  return {
    settings: { enabled: false, categories: {} },
    permission: "default",
    notify: () => {},
    requestEnable: () => {},
    disable: () => {},
    setCategory: () => {},
  };
}

export function daemonsHookMock() {
  return {
    daemonIds: [] as readonly string[],
    spawnDaemonIds: [] as readonly string[],
    refresh: () => {},
  };
}

export function readinessHookMock() {
  return { readiness: null, refresh: () => {} };
}

export function sessionEventsHookMock() {
  return { events: [], loading: false, error: null, reload: () => {} };
}

export function sessionBodyHookMock() {
  return {
    diff: null,
    diffLoading: false,
    diffError: null,
    loadDiff: () => {},
    output: null,
    outputLoading: false,
    outputError: null,
    loadOutput: () => {},
    clear: () => {},
  };
}

/**
 * use-safety-demo の module mock: isPostDemoBoardState / SAFETY_DEMO_SESSION_PREFIX 等の
 * 純関数/定数は実物を使い、hook だけ中立実装へ差し替える。
 */
export async function safetyDemoModuleMock(
  importOriginal: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return {
    ...(await importOriginal()),
    useSafetyDemo: () => ({ phase: "idle", sessionId: null, launch: () => {} }),
  };
}
