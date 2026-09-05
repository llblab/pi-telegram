/**
 * Regression tests for the Telegram polling runtime domain
 * Covers polling request helpers, stop conditions, and the long-poll loop runtime in one suite
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  admitTelegramPollingUpdateBatch,
  applyTelegramThreadCapability,
  buildTelegramInitialSyncRequest,
  buildTelegramLongPollRequest,
  canProbeTelegramThreadCapability,
  createTelegramDurablePollingRuntimeAssembly,
  createTelegramPollingActivityReader,
  createTelegramPollingAdmissionRuntime,
  createTelegramPollingController,
  createTelegramPollingControllerRuntime,
  createTelegramPollingControllerState,
  createTelegramPollingStateReader,
  createTelegramPollLoopRunner,
  createTelegramThreadAwarePollingPorts,
  createTelegramThreadCapabilityMonitor,
  createTelegramThreadCapabilityStateRuntime,
  createTelegramThreadTargetObservationBinding,
  cutOverTelegramPollingCursor,
  getLatestTelegramUpdateId,
  getTelegramGetUpdatesRequestBudgetMs,
  isTelegramGetUpdatesConflictError,
  isTelegramPollingControllerActive,
  runTelegramPollLoop,
  shouldStartTelegramPolling,
  shouldStopTelegramPolling,
  sleepTelegramPollingRetry,
  startTelegramPollingRuntime,
  stopTelegramPollingRuntime,
  TELEGRAM_ALLOWED_UPDATES,
  TelegramGetUpdatesTimeoutError,
  TelegramPollingBatchValidationError,
  TelegramPollingCursorBootstrapError,
} from "../lib/polling.ts";

const TEST_CONTEXT = "ctx";
const NOOP_JOURNAL_ADMISSION = {
  appendUpdateBatch: (_updates: readonly { update_id: number }[]) => undefined,
  getAcceptedThroughUpdateId: () => 1,
  getJournalEntryCount: () => 0,
  signalUpdateWorker: () => {},
};

async function waitForPollingCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("Polling helpers build the initial sync request", () => {
  assert.deepEqual(buildTelegramInitialSyncRequest(), {
    offset: -1,
    limit: 1,
    timeout: 0,
  });
});

test("Polling helpers build long-poll requests with and without lastUpdateId", () => {
  assert.deepEqual(buildTelegramLongPollRequest(), {
    offset: undefined,
    limit: 10,
    timeout: 30,
    allowed_updates: TELEGRAM_ALLOWED_UPDATES,
  });
  assert.deepEqual(buildTelegramLongPollRequest(41), {
    offset: 42,
    limit: 10,
    timeout: 30,
    allowed_updates: TELEGRAM_ALLOWED_UPDATES,
  });
});

test("Polling getUpdates budgets derive from the declared long-poll timeout", () => {
  assert.equal(
    getTelegramGetUpdatesRequestBudgetMs(buildTelegramInitialSyncRequest()),
    10_000,
  );
  assert.equal(
    getTelegramGetUpdatesRequestBudgetMs(buildTelegramLongPollRequest()),
    40_000,
  );
  assert.equal(getTelegramGetUpdatesRequestBudgetMs({ timeout: 2 }, 500), 2_500);
});

test("Polling helpers extract the latest update id", () => {
  assert.equal(getLatestTelegramUpdateId([]), undefined);
  assert.equal(
    getLatestTelegramUpdateId([{ update_id: 1 }, { update_id: 7 }]),
    7,
  );
});

test("Polling cursor cutover is journal-first, idempotent, and preserves existing authority", async () => {
  let legacyCursor: number | undefined = 5;
  let journalCursor: number | undefined;
  const entries = [{ updateId: 7 }];
  const events: string[] = [];
  let failRemoval = true;
  const cutOver = () =>
    cutOverTelegramPollingCursor({
      getLegacyCursor: () => legacyCursor,
      readJournal: () => ({
        ...(journalCursor !== undefined
          ? { acceptedThroughUpdateId: journalCursor }
          : {}),
        entries,
      }),
      publishJournalCursor(cursor) {
        events.push(`journal:${cursor}`);
        journalCursor = cursor;
      },
      removeLegacyCursor() {
        events.push("config:remove");
        if (failRemoval) throw new Error("config publication failed");
        legacyCursor = undefined;
      },
    });

  await assert.rejects(cutOver(), /config publication failed/u);
  assert.equal(journalCursor, 7);
  assert.equal(legacyCursor, 5);
  failRemoval = false;
  await cutOver();
  assert.equal(journalCursor, 7);
  assert.equal(legacyCursor, undefined);
  assert.deepEqual(events, ["journal:7", "config:remove", "config:remove"]);

  legacyCursor = 99;
  journalCursor = 100;
  await cutOver();
  assert.equal(journalCursor, 100);
  assert.equal(legacyCursor, undefined);
});

test("Polling cursor cutover never removes config authority when journal publication fails", async () => {
  let removeCalls = 0;
  await assert.rejects(
    cutOverTelegramPollingCursor({
      getLegacyCursor: () => 5,
      readJournal: () => ({ entries: [] }),
      publishJournalCursor() {
        throw new Error("journal publication failed");
      },
      removeLegacyCursor() {
        removeCalls += 1;
      },
    }),
    /journal publication failed/u,
  );
  assert.equal(removeCalls, 0);
});

test("Polling batch admission journals one latest cursor before worker signal", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  const events: string[] = [];
  const result = await admitTelegramPollingUpdateBatch({
    updates: [{ update_id: 6 }, { update_id: 7 }],
    config,
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    appendBatch(updates, cursor) {
      events.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor!;
    },
    async persistConfig() {
      events.push("unexpected-config-persist");
    },
    signalWorker() {
      events.push("signal");
    },
    onPhaseChange(phase, updateId) {
      events.push(`phase:${phase}:${updateId}`);
    },
  });
  assert.deepEqual(result, { updateCount: 2, latestUpdateId: 7 });
  assert.equal(config.lastUpdateId, 999);
  assert.equal(acceptedThroughUpdateId, 7);
  assert.deepEqual(events, [
    "phase:persisting-journal:6",
    "append:6,7:7",
    "signal",
  ]);
});

test("Polling batch admission leaves offset and worker untouched when journal append fails", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 5 };
  let persistCalls = 0;
  let signalCalls = 0;
  await assert.rejects(
    admitTelegramPollingUpdateBatch({
      updates: [{ update_id: 6 }, { update_id: 7 }],
      config,
      appendBatch() {
        throw new Error("journal unavailable");
      },
      async persistConfig() {
        persistCalls += 1;
      },
      signalWorker() {
        signalCalls += 1;
      },
    }),
    /journal unavailable/u,
  );
  assert.equal(config.lastUpdateId, 5);
  assert.equal(persistCalls, 0);
  assert.equal(signalCalls, 0);
});

test("Polling batch admission leaves cursor and worker untouched when atomic journal publication fails", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  let signalCalls = 0;
  await assert.rejects(
    admitTelegramPollingUpdateBatch({
      updates: [{ update_id: 6 }],
      config,
      getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
      appendBatch() {
        throw new Error("journal commit failed");
      },
      async persistConfig() {
        assert.fail("config persistence must not own the polling cursor");
      },
      signalWorker() {
        signalCalls += 1;
      },
    }),
    /journal commit failed/u,
  );
  assert.equal(acceptedThroughUpdateId, 5);
  assert.equal(config.lastUpdateId, 999);
  assert.equal(signalCalls, 0);
});

test("Polling batch admission fails closed on non-monotonic ids", async () => {
  let appendCalls = 0;
  await assert.rejects(
    admitTelegramPollingUpdateBatch({
      updates: [{ update_id: 7 }, { update_id: 6 }],
      config: { botToken: "123:abc" },
      getAcceptedThroughUpdateId: () => 5,
      appendBatch() {
        appendCalls += 1;
      },
      async persistConfig() {},
      signalWorker() {},
    }),
    TelegramPollingBatchValidationError,
  );
  assert.equal(appendCalls, 0);
});

test("Polling restart replays journal authority after offset commit but before worker signal", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  const journal = new Set<number>();
  await admitTelegramPollingUpdateBatch({
    updates: [{ update_id: 6 }],
    config,
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    appendBatch(updates, cursor) {
      for (const update of updates) journal.add(update.update_id);
      acceptedThroughUpdateId = cursor!;
    },
    async persistConfig() {
      assert.fail("config persistence must not own the polling cursor");
    },
    signalWorker() {
      throw new Error("process exited before worker signal");
    },
  });
  assert.equal(config.lastUpdateId, 999);
  assert.equal(acceptedThroughUpdateId, 6);
  assert.deepEqual([...journal], [6]);

  const replayedOnRestart: number[] = [];
  for (const updateId of journal) replayedOnRestart.push(updateId);
  assert.deepEqual(replayedOnRestart, [6]);
  journal.delete(6);
  assert.deepEqual([...journal], []);
});

test("Polling batch admission contains worker signal failures after durable offset", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 5;
  const runtimeEvents: Array<{
    error: unknown;
    details?: Record<string, unknown>;
  }> = [];
  await admitTelegramPollingUpdateBatch({
    updates: [{ update_id: 6 }],
    config,
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    appendBatch(_updates, cursor) {
      acceptedThroughUpdateId = cursor!;
    },
    async persistConfig() {
      assert.fail("config persistence must not own the polling cursor");
    },
    signalWorker() {
      throw new Error("worker unavailable");
    },
    recordRuntimeEvent(_category, error, details) {
      runtimeEvents.push({ error, details });
    },
  });
  assert.equal(config.lastUpdateId, 999);
  assert.equal(acceptedThroughUpdateId, 6);
  assert.equal(runtimeEvents.length, 1);
  assert.match(String(runtimeEvents[0]?.error), /worker unavailable/u);
  assert.deepEqual(runtimeEvents[0]?.details, {
    phase: "worker-signal",
    updateCount: 1,
    latestUpdateId: 6,
  });
});

test("Polling activity reports lifecycle ownership without inventing health", () => {
  const state = createTelegramPollingControllerState();
  const isActive = createTelegramPollingActivityReader(state);
  const readState = createTelegramPollingStateReader(state);

  assert.equal(isActive(), false);
  assert.deepEqual(readState(), {
    phase: "stopped",
    phaseStartedAtMs: undefined,
    currentUpdateId: undefined,
    startedAtMs: undefined,
    stoppedAtMs: undefined,
    lastSuccessfulResponseAtMs: undefined,
    lastSuccessfulResponseUpdateCount: undefined,
    stopReason: "not-started",
  });

  state.pollingPromise = new Promise<void>(() => {});
  state.phase = "persisting-journal";
  state.currentUpdateId = 42;
  assert.equal(isActive(), true);
  assert.equal(readState().phase, "persisting-journal");
  assert.equal(readState().currentUpdateId, 42);

  state.pollingPromise = undefined;
  assert.equal(isActive(), false);
});

test("Thread capability probes require direct or registered follower authority", () => {
  assert.equal(
    canProbeTelegramThreadCapability(TEST_CONTEXT, {
      ownsLock: () => false,
      isFollowerRegistered: () => false,
    }),
    false,
  );
  assert.equal(
    canProbeTelegramThreadCapability(TEST_CONTEXT, {
      ownsLock: () => true,
      isFollowerRegistered: () => false,
    }),
    true,
  );
  assert.equal(
    canProbeTelegramThreadCapability(TEST_CONTEXT, {
      ownsLock: () => false,
      isFollowerRegistered: () => true,
    }),
    true,
  );
});

test("Thread capability monitor stays passive before transport authorization", async () => {
  let calls = 0;
  const monitor = createTelegramThreadCapabilityMonitor({
    getAllowedUserId: () => 7,
    callApi: async <TResponse>() => {
      calls += 1;
      return {} as TResponse;
    },
    topicTargetStore: {
      load: async () => {},
      persist: async () => {},
      getBotState: () => ({}),
      setBotState: () => {},
    },
    ownsLock: () => false,
    isFollowerRegistered: () => false,
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus: () => {},
    setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {},
    startClassicPolling: () => {},
    stopClassicPolling: () => {},
    startBusPolling: () => {},
    stopBusPolling: () => {},
    startLeaderHealth: () => {},
    stopLeaderHealth: () => {},
    updateStatus: () => {},
    recordEvent: () => {},
    intervalMs: 1,
  });

  monitor.start(TEST_CONTEXT);
  await new Promise((resolve) => setTimeout(resolve, 10));
  monitor.stop();
  assert.equal(calls, 0);
});

test("Thread capability monitor serializes probes across lifecycle generations", async () => {
  let calls = 0;
  let state: { threadMode?: "enabled" | "disabled" | "unknown" } = {};
  const releases: Array<(value: unknown) => void> = [];
  const monitor = createTelegramThreadCapabilityMonitor({
    getAllowedUserId: () => 7,
    callApi: <TResponse>() =>
      new Promise<TResponse>((resolve) => {
        calls += 1;
        releases.push(resolve as (value: unknown) => void);
      }),
    topicTargetStore: {
      load: async () => {},
      persist: async () => {},
      getBotState: () => state,
      setBotState: (next) => {
        state = { ...state, ...next };
      },
    },
    ownsLock: () => true,
    isFollowerRegistered: () => false,
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus: () => {},
    setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {},
    startClassicPolling: () => {},
    stopClassicPolling: () => {},
    startBusPolling: () => {},
    stopBusPolling: () => {},
    startLeaderHealth: () => {},
    stopLeaderHealth: () => {},
    updateStatus: () => {},
    recordEvent: () => {},
    intervalMs: 1,
  });

  monitor.start(TEST_CONTEXT);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  monitor.stop();
  monitor.start(TEST_CONTEXT);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  releases[0]?.({ id: 1, has_topics_enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal(state.threadMode, undefined);
  releases[1]?.({ id: 1, has_topics_enabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.threadMode, "enabled");
  monitor.stop();
});

test("Thread target observation binding supports late runtime composition", async () => {
  const events: string[] = [];
  const binding = createTelegramThreadTargetObservationBinding<string>();

  await binding.handle("before");
  binding.set(async (ctx) => {
    events.push(ctx);
  });
  await binding.handle("after");

  assert.deepEqual(events, ["after"]);
});

test("Thread capability state runtime owns transition flags", () => {
  const state = createTelegramThreadCapabilityStateRuntime();

  assert.equal(state.isBusPollingStarted(), false);
  assert.equal(state.isTopicModeUnavailable(), false);
  assert.equal(state.shouldForceFreshLeaderThread(), false);
  assert.equal(state.getRequestedThreadName(), undefined);

  state.setBusPollingStarted(true);
  state.setTopicModeUnavailable(true);
  state.setForceFreshLeaderThread(true);
  state.setRequestedThreadName("Flightprice");

  assert.equal(state.isBusPollingStarted(), true);
  assert.equal(state.isTopicModeUnavailable(), true);
  assert.equal(state.shouldForceFreshLeaderThread(), true);
  assert.equal(state.getRequestedThreadName(), "Flightprice");
});

test("Thread-aware polling returns disabled mode to classic takeover despite retained thread history", async () => {
  const callApi = async <TResponse,>(): Promise<TResponse> => ({}) as TResponse;
  const store = {
    async load() {},
    async persist() {},
    getBotState() {
      return { threadMode: "disabled" as const };
    },
    setBotState() {},
    list() {
      return [
        {
          status: "active",
          target: { chatId: 42, threadId: 7 },
        },
      ];
    },
  };
  const ports = createTelegramThreadAwarePollingPorts({
    getAllowedUserId: () => 42,
    callApi,
    topicTargetStore: store,
    isBusRuntimeEnabled: () => false,
    isTopicModeUnavailableError: () => false,
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus() {},
    setForceFreshLeaderThreadOnNextStart() {},
    setTopicModeUnavailable() {},
    startClassicPolling() {},
    async stopClassicPolling() {},
    async startBusLeaderPolling() {},
    async stopBusLeaderPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    registerFollowerWithLeader: async () => true,
    stopFollowerRegistration() {},
    recordEvent() {},
  });

  assert.equal(
    await ports.registerFollowerWithOwner?.(TEST_CONTEXT, { pid: 1 }),
    undefined,
  );
});

test("Thread-aware polling refreshes owner-published enabled mode over stale local classic state", async () => {
  let followerRegistrations = 0;
  let threadMode: "disabled" | "enabled" = "disabled";
  const store = {
    async load() {},
    async refresh() {
      threadMode = "enabled";
    },
    async persist() {},
    getBotState() {
      return { threadMode };
    },
    setBotState() {},
    list() {
      return [];
    },
  };
  const ports = createTelegramThreadAwarePollingPorts({
    getAllowedUserId: () => 42,
    callApi: async <TResponse,>(): Promise<TResponse> => ({}) as TResponse,
    topicTargetStore: store,
    isBusRuntimeEnabled: () => false,
    isTopicModeUnavailableError: () => false,
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus() {},
    setForceFreshLeaderThreadOnNextStart() {},
    setTopicModeUnavailable() {},
    startClassicPolling() {},
    async stopClassicPolling() {},
    async startBusLeaderPolling() {},
    async stopBusLeaderPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    async registerFollowerWithLeader() {
      followerRegistrations += 1;
      return true;
    },
    stopFollowerRegistration() {},
    recordEvent() {},
  });

  assert.equal(
    await ports.registerFollowerWithOwner?.(TEST_CONTEXT, { pid: 1 }),
    true,
  );
  assert.equal(followerRegistrations, 1);
});

test("Thread capability downgrade retries classic restore after failure", async () => {
  let state: {
    threadMode?: "enabled" | "disabled" | "unknown";
    updatedAtMs?: number;
    lastReconcileAction?: string;
  } = {
    threadMode: "enabled",
    lastReconcileAction: "capability-monitor-enabled",
  };
  let pollingStartedWithBus = true;
  let classicStarts = 0;
  let persisted = 0;
  const events: Array<{ category: string; details?: Record<string, unknown> }> = [];
  const store = {
    async load() {},
    async persist() {
      persisted += 1;
    },
    getBotState() {
      return state;
    },
    setBotState(next: typeof state) {
      state = { ...state, ...next };
    },
    list() {
      return [
        {
          status: "active",
          target: { chatId: 42, threadId: 7 },
        },
      ];
    },
  };
  const deps = {
    getAllowedUserId: () => 42,
    callApi: async <TResponse,>(): Promise<TResponse> => ({}) as TResponse,
    topicTargetStore: store,
    ownsLock: () => true,
    getPollingStartedWithTelegramBus: () => pollingStartedWithBus,
    setPollingStartedWithTelegramBus(started: boolean) {
      pollingStartedWithBus = started;
    },
    setTopicModeUnavailable() {},
    stopFollowerRegistration() {},
    startClassicPolling() {
      classicStarts += 1;
      if (classicStarts === 1) throw new Error("classic unavailable");
    },
    async stopClassicPolling() {},
    async startBusPolling() {},
    async stopBusPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    isTopicModeUnavailableError: () => false,
    updateStatus() {},
    recordEvent(category: string, _error: unknown, details?: Record<string, unknown>) {
      events.push({ category, details });
    },
  };

  await applyTelegramThreadCapability(
    TEST_CONTEXT,
    false,
    "capability-monitor-disabled-confirmed",
    deps,
  );
  assert.equal(classicStarts, 1);
  assert.equal(
    state.lastReconcileAction,
    "capability-monitor-disabled-confirmed-classic-restore-failed",
  );
  assert.equal(pollingStartedWithBus, false);

  await applyTelegramThreadCapability(
    TEST_CONTEXT,
    false,
    "capability-monitor-disabled-confirmed",
    deps,
  );
  assert.equal(classicStarts, 2);
  assert.equal(state.lastReconcileAction, "capability-monitor-disabled-confirmed");
  assert.equal(persisted >= 3, true);
  assert.equal(events[0].details?.phase, "capability-monitor-disabled-confirmed-classic-restore");
});

test("Thread-aware polling still allows classic takeover path without thread bindings", async () => {
  const callApi = async <TResponse,>(): Promise<TResponse> => ({}) as TResponse;
  const store = {
    async load() {},
    async persist() {},
    getBotState() {
      return { threadMode: "disabled" as const };
    },
    setBotState() {},
    list() {
      return [];
    },
  };
  const ports = createTelegramThreadAwarePollingPorts({
    getAllowedUserId: () => 42,
    callApi,
    topicTargetStore: store,
    isBusRuntimeEnabled: () => false,
    isTopicModeUnavailableError: () => false,
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus() {},
    setForceFreshLeaderThreadOnNextStart() {},
    setTopicModeUnavailable() {},
    startClassicPolling() {},
    async stopClassicPolling() {},
    async startBusLeaderPolling() {},
    async stopBusLeaderPolling() {},
    startLeaderHealth() {},
    stopLeaderHealth() {},
    registerFollowerWithLeader: async () => true,
    stopFollowerRegistration() {},
    recordEvent() {},
  });

  assert.equal(
    await ports.registerFollowerWithOwner?.(TEST_CONTEXT, { pid: 1 }),
    undefined,
  );
});

test("Polling helpers start only when a bot token exists and polling is idle", () => {
  assert.equal(
    shouldStartTelegramPolling({
      hasBotToken: true,
      hasPollingPromise: false,
    }),
    true,
  );
  assert.equal(
    shouldStartTelegramPolling({
      hasBotToken: false,
      hasPollingPromise: false,
    }),
    false,
  );
  assert.equal(
    shouldStartTelegramPolling({
      hasBotToken: true,
      hasPollingPromise: true,
    }),
    false,
  );
});

test("Polling runtime starts and stops polling through state ports", async () => {
  const events: string[] = [];
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  let finishPollLoop: (() => void) | undefined;
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
      events.push(`promise:${promise ? "set" : "clear"}`);
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
      events.push(`controller:${controller ? "set" : "clear"}`);
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    runPollLoop: async (_ctx: string, signal: AbortSignal) => {
      events.push(`run:${signal.aborted}`);
      await new Promise<void>((resolve) => {
        finishPollLoop = resolve;
      });
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
    onPollingStarted: () => {
      events.push("polling:started");
    },
    onPollingStopped: () => {
      events.push("polling:stopped");
    },
  };
  startTelegramPollingRuntime("ctx", deps);
  assert.equal(!!pollingPromise, true);
  assert.equal(!!pollingController, true);
  const stopPromise = stopTelegramPollingRuntime(deps);
  assert.equal(pollingController?.signal.aborted, true);
  assert.equal(!!pollingController, true);
  finishPollLoop?.();
  await stopPromise;
  assert.deepEqual(events, [
    "controller:set",
    "polling:started",
    "run:false",
    "promise:set",
    "status:ctx",
    "typing:stop",
    "promise:clear",
    "controller:clear",
    "polling:stopped",
    "status:ctx",
  ]);
});

test("Polling runtime still aborts and settles when typing cleanup fails", async () => {
  const events: string[] = [];
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  let finishPollLoop: (() => void) | undefined;
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
      events.push(`promise:${promise ? "set" : "clear"}`);
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
      events.push(`controller:${controller ? "set" : "clear"}`);
    },
    stopTypingLoop: () => {
      events.push("typing:throw");
      throw new Error("typing cleanup failed");
    },
    runPollLoop: async (_ctx: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        finishPollLoop = () => {
          events.push(`run-finish:${signal.aborted}`);
          resolve();
        };
      });
    },
    updateStatus: () => {},
    recordRuntimeEvent: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => {
      events.push(
        `${category}:${error instanceof Error ? error.message : String(error)}:${details?.phase}`,
      );
    },
  };
  startTelegramPollingRuntime("ctx", deps);
  const stopPromise = stopTelegramPollingRuntime(deps);
  assert.equal(pollingController?.signal.aborted, true);
  finishPollLoop?.();
  await stopPromise;
  assert.deepEqual(events, [
    "controller:set",
    "promise:set",
    "typing:throw",
    "polling:typing cleanup failed:typing-stop",
    "run-finish:true",
    "promise:clear",
    "controller:clear",
  ]);
});

test("Polling runtime ignores stale-context status failures during cleanup", async () => {
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  let statusCalls = 0;
  const runtimeEvents: string[] = [];
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
    },
    stopTypingLoop: () => {},
    runPollLoop: async () => {},
    updateStatus: () => {
      statusCalls += 1;
      if (statusCalls > 1) throw new Error("stale ctx");
    },
    recordRuntimeEvent: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  };
  startTelegramPollingRuntime("ctx", deps);
  await pollingPromise;
  assert.equal(statusCalls, 2);
  assert.equal(pollingPromise, undefined);
  assert.equal(pollingController, undefined);
  assert.deepEqual(runtimeEvents, ["polling:stale ctx:status-update"]);
});

test("Polling runtime ignores stale-context status failures during start", () => {
  let pollingPromise: Promise<void> | undefined;
  let pollingController: AbortController | undefined;
  const runtimeEvents: string[] = [];
  const deps = {
    hasBotToken: () => true,
    getPollingPromise: () => pollingPromise,
    setPollingPromise: (promise: Promise<void> | undefined) => {
      pollingPromise = promise;
    },
    getPollingController: () => pollingController,
    setPollingController: (controller: AbortController | undefined) => {
      pollingController = controller;
    },
    stopTypingLoop: () => {},
    runPollLoop: async () => {},
    updateStatus: () => {
      throw new Error("stale ctx");
    },
    recordRuntimeEvent: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  };

  assert.doesNotThrow(() => startTelegramPollingRuntime("ctx", deps));
  assert.equal(!!pollingPromise, true);
  assert.equal(!!pollingController, true);
  assert.deepEqual(runtimeEvents, ["polling:stale ctx:status-update"]);
});

test("Polling admission starts the session-owned worker before transport polling", async () => {
  const events: string[] = [];
  let failPollingStart = false;
  let failValidation = false;
  let failPreparation = false;
  const runtime = createTelegramPollingAdmissionRuntime<string>({
    prepareStart: () => {
      events.push("prepare");
      if (failPreparation) throw new Error("cutover failed");
    },
    validateStart: () => {
      events.push("validate");
      if (failValidation) throw new Error("cursor conflict");
    },
    polling: {
      isActive: () => false,
      start: () => {
        events.push("polling:start");
        if (failPollingStart) throw new Error("polling failed");
      },
      stop: async () => {
        events.push("polling:stop");
      },
    },
    worker: {
      onSessionStart: async (ctx) => {
        events.push(`worker:start:${ctx}`);
      },
    },
  });

  await runtime.start("ctx");
  await runtime.stop();
  assert.deepEqual(events, [
    "prepare",
    "validate",
    "worker:start:ctx",
    "polling:start",
    "polling:stop",
  ]);

  events.length = 0;
  failPollingStart = true;
  await assert.rejects(runtime.start("ctx-2"), /polling failed/u);
  assert.deepEqual(events, [
    "prepare",
    "validate",
    "worker:start:ctx-2",
    "polling:start",
  ]);

  events.length = 0;
  failValidation = true;
  await assert.rejects(runtime.start("ctx-3"), /cursor conflict/u);
  assert.deepEqual(events, ["prepare", "validate"]);

  events.length = 0;
  failValidation = false;
  failPreparation = true;
  await assert.rejects(runtime.start("ctx-4"), /cutover failed/u);
  assert.deepEqual(events, ["prepare"]);
});

test("Polling controller owns polling promise and abort-controller state", async () => {
  const events: string[] = [];
  let finishPollLoop: (() => void) | undefined;
  const state = createTelegramPollingControllerState();
  const isPollingActive = createTelegramPollingActivityReader(state);
  const controller = createTelegramPollingController({
    state,
    hasBotToken: () => true,
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    runPollLoop: async (_ctx: string, signal: AbortSignal) => {
      events.push(`run:${signal.aborted}`);
      await new Promise<void>((resolve) => {
        finishPollLoop = resolve;
      });
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
  });
  controller.start("ctx");
  assert.equal(controller.isActive(), true);
  assert.equal(isTelegramPollingControllerActive(state), true);
  assert.equal(isPollingActive(), true);
  controller.start("ctx");
  const stopPromise = controller.stop();
  finishPollLoop?.();
  await stopPromise;
  assert.equal(controller.isActive(), false);
  assert.equal(isTelegramPollingControllerActive(state), false);
  assert.equal(isPollingActive(), false);
  assert.deepEqual(events, [
    "run:false",
    "status:ctx",
    "typing:stop",
    "status:ctx",
  ]);
});

test("Polling controller settles unexpected runner failures into diagnostics", async () => {
  const state = createTelegramPollingControllerState();
  const runtimeEvents: string[] = [];
  const controller = createTelegramPollingController({
    state,
    getNowMs: () => 2_000,
    hasBotToken: () => true,
    stopTypingLoop: () => {},
    runPollLoop: async () => {
      throw new Error("unexpected poll failure");
    },
    updateStatus: () => {},
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push(
        `${category}:${error instanceof Error ? error.message : String(error)}:${details?.phase}`,
      );
    },
  });

  controller.start(TEST_CONTEXT);
  await waitForPollingCondition(
    () => state.phase === "stopped",
    "failed polling controller did not settle",
  );

  assert.equal(controller.isActive(), false);
  assert.equal(state.stopReason, "failed");
  assert.equal(state.stoppedAtMs, 2_000);
  assert.deepEqual(runtimeEvents, [
    "polling:unexpected poll failure:controller",
  ]);
});

test("Durable polling assembly owns journal ports and cursor bootstrap validation", async () => {
  let bootstrapEntryCount = 1;
  let workerStarts = 0;
  const events: string[] = [];
  const assembly = createTelegramDurablePollingRuntimeAssembly<
    { update_id: number },
    string
  >({
    getConfig: () => ({ botToken: "123:abc" }),
    hasBotToken: () => true,
    deleteWebhook: async () => {
      events.push("deleteWebhook");
    },
    getUpdates: async () => {
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => undefined,
    journal: {
      appendBatch: () => undefined,
      getAcceptedThroughUpdateId: () => undefined,
      getEntryCount: () => 0,
      signalWorker: () => undefined,
      getBootstrapEntryCount: () => bootstrapEntryCount,
      onSessionStart: async () => {
        workerStarts += 1;
      },
    },
    stopTypingLoop: () => undefined,
    updateStatus: () => undefined,
  });

  await assert.rejects(
    () => assembly.admission.start("blocked"),
    TelegramPollingCursorBootstrapError,
  );
  assert.equal(workerStarts, 0);
  bootstrapEntryCount = 0;
  await assembly.admission.start("ctx");
  assert.equal(workerStarts, 1);
  assert.equal(assembly.controller.isActive(), true);
  await assembly.admission.stop();
  assert.equal(assembly.controller.isActive(), false);
  assert.deepEqual(events, ["deleteWebhook"]);
});

test("Polling controller runtime binds loop runner and controller state", async () => {
  const events: string[] = [];
  const state = createTelegramPollingControllerState();
  const controller = createTelegramPollingControllerRuntime({
    state,
    getConfig: () => ({ botToken: "123:abc" }),
    hasBotToken: () => true,
    deleteWebhook: async () => {
      events.push("deleteWebhook");
    },
    getUpdates: async () => {
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {
      events.push("persist");
    },
    ...NOOP_JOURNAL_ADMISSION,
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    updateStatus: (_ctx: string, message?: string) => {
      events.push(`status:${message ?? "ok"}`);
    },
  });
  controller.start("ctx");
  assert.equal(controller.isActive(), true);
  await controller.stop();
  assert.equal(controller.isActive(), false);
  assert.deepEqual(events, [
    "deleteWebhook",
    "status:ok",
    "typing:stop",
    "status:ok",
  ]);
});

test("Polling controller exposes exact phases and retained response evidence", async () => {
  let nowMs = 1_000;
  let getUpdatesCalls = 0;
  let acceptedThroughUpdateId = 5;
  let releaseAppend: (() => void) | undefined;
  let secondPollSignal: AbortSignal | undefined;
  const state = createTelegramPollingControllerState();
  const controller = createTelegramPollingControllerRuntime({
    state,
    getNowMs: () => nowMs,
    getConfig: () => ({ botToken: "123:abc", lastUpdateId: 5 }),
    hasBotToken: () => true,
    deleteWebhook: async () => {},
    getUpdates: async (_body, signal) => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) return [{ update_id: 6 }];
      secondPollSignal = signal;
      return await new Promise<never>(() => {});
    },
    appendUpdateBatch: async (_updates, cursor) => {
      await new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      acceptedThroughUpdateId = cursor!;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => {},
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    stopTypingLoop: () => {},
    updateStatus: () => {},
  });

  controller.start(TEST_CONTEXT);
  await waitForPollingCondition(
    () => state.phase === "persisting-journal" && !!releaseAppend,
    "polling did not enter persisting-journal",
  );
  assert.equal(state.currentUpdateId, 6);
  assert.equal(state.phaseStartedAtMs, 1_000);
  assert.equal(state.lastSuccessfulResponseAtMs, 1_000);
  assert.equal(state.lastSuccessfulResponseUpdateCount, 1);

  nowMs = 1_100;
  releaseAppend?.();
  await waitForPollingCondition(
    () => state.phase === "long-poll" && !!secondPollSignal,
    "polling did not resume long-polling",
  );
  assert.equal(acceptedThroughUpdateId, 6);
  assert.equal(state.currentUpdateId, undefined);
  assert.equal(state.phaseStartedAtMs, 1_100);

  nowMs = 1_300;
  await controller.stop();
  assert.equal(secondPollSignal?.aborted, true);
  assert.equal(state.phase, "stopped");
  assert.equal(state.phaseStartedAtMs, 1_300);
  assert.equal(state.stoppedAtMs, 1_300);
  assert.equal(state.stopReason, "requested");
  assert.equal(state.lastSuccessfulResponseAtMs, 1_000);
});

test("Polling helpers stop only for abort conditions", () => {
  assert.equal(shouldStopTelegramPolling(true, new Error("ignored")), true);
  assert.equal(
    shouldStopTelegramPolling(false, new DOMException("aborted", "AbortError")),
    true,
  );
  assert.equal(shouldStopTelegramPolling(false, new Error("network")), false);
});

test("Poll loop cancels stalled getUpdates at its owner-derived budget", async () => {
  const controller = new AbortController();
  const phases: string[] = [];
  const statusMessages: string[] = [];
  const runtimeEvents: Array<{
    error: unknown;
    details?: Record<string, unknown>;
  }> = [];
  let requestSignal: AbortSignal | undefined;

  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: controller.signal,
    config: { botToken: "123:abc" },
    deleteWebhook: async () => {},
    getUpdatesRequestBudgetMs: (body) => {
      assert.equal(body.timeout, 30);
      return 5;
    },
    getUpdates: async (_body, signal) => {
      requestSignal = signal;
      return await new Promise<never>(() => {});
    },
    persistConfig: async () => {},
    ...NOOP_JOURNAL_ADMISSION,
    onErrorStatus: (message) => {
      statusMessages.push(message);
    },
    onStatusReset: () => {
      statusMessages.push("unexpected reset");
    },
    sleep: async (ms, signal) => {
      assert.equal(ms, 3_000);
      assert.equal(signal, controller.signal);
      controller.abort();
    },
    onPhaseChange: (phase, updateId) => {
      phases.push(`${phase}:${updateId ?? "none"}`);
    },
    recordRuntimeEvent: (_category, error, details) => {
      runtimeEvents.push({ error, details });
    },
  });

  assert.equal(requestSignal?.aborted, true);
  assert.ok(requestSignal?.reason instanceof TelegramGetUpdatesTimeoutError);
  assert.deepEqual(phases, ["long-poll:none", "retrying:none"]);
  assert.deepEqual(statusMessages, [
    "Telegram getUpdates timed out after 5 ms.",
  ]);
  assert.equal(runtimeEvents.length, 1);
  assert.ok(runtimeEvents[0]?.error instanceof TelegramGetUpdatesTimeoutError);
  assert.deepEqual(runtimeEvents[0]?.details, {
    phase: "long-poll",
    timeoutMs: 5,
  });
});

test("Poll loop runner binds config, status, and transport ports", async () => {
  const config: { botToken: string; lastUpdateId?: number } = {
    botToken: "123:abc",
    lastUpdateId: 5,
  };
  const events: string[] = [];
  let acceptedThroughUpdateId = 5;
  let calls = 0;
  const runPollLoop = createTelegramPollLoopRunner({
    getConfig: () => config,
    deleteWebhook: async () => {
      events.push("deleteWebhook");
    },
    getUpdates: async () => {
      calls += 1;
      if (calls === 1) return [{ update_id: 6 }];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    appendUpdateBatch: (updates, cursor) => {
      events.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor!;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => {
      events.push("signal");
    },
    updateStatus: (ctx, message) => {
      events.push(`status:${ctx}:${message ?? "ok"}`);
    },
    sleep: async () => {
      events.push("sleep");
    },
    onPhaseChange: (phase, updateId) => {
      events.push(`phase:${phase}:${updateId ?? "none"}`);
    },
    onSuccessfulResponse: (updateCount) => {
      events.push(`response:${updateCount}`);
    },
  });
  await runPollLoop("ctx", new AbortController().signal);
  assert.deepEqual(events, [
    "deleteWebhook",
    "phase:long-poll:none",
    "response:1",
    "phase:persisting-journal:6",
    "append:6:6",
    "signal",
    "phase:long-poll:none",
  ]);
});

test("Poll loop runner ignores stale-context status failures while retrying", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const events: string[] = [];
  const runtimeEvents: string[] = [];
  let calls = 0;
  const runPollLoop = createTelegramPollLoopRunner({
    getConfig: () => config,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    ...NOOP_JOURNAL_ADMISSION,
    updateStatus: (_ctx: string, message?: string) => {
      events.push(`status:${message ?? "ok"}`);
      throw new Error("stale ctx");
    },
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  });
  await runPollLoop("ctx", new AbortController().signal);
  assert.deepEqual(events, ["status:network down", "sleep:3000", "status:ok"]);
  assert.deepEqual(runtimeEvents, [
    "polling:network down:loop",
    "polling:stale ctx:status-update",
    "polling:stale ctx:status-update",
  ]);
});

test("Journal-first poll loop advances before unresolved worker execution", async () => {
  const controller = new AbortController();
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 0;
  const events: string[] = [];
  let getUpdatesCalls = 0;
  let unresolvedWorker: Promise<void> | undefined;

  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: controller.signal,
    config,
    deleteWebhook: async () => undefined,
    getUpdates: async () => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) return [{ update_id: 1 }];
      assert.equal(acceptedThroughUpdateId, 1);
      assert.ok(unresolvedWorker);
      controller.abort();
      throw new DOMException("stop", "AbortError");
    },
    appendUpdateBatch: (updates, cursor) => {
      events.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor!;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => {
      events.push("signal");
      unresolvedWorker = new Promise<void>(() => {});
    },
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    prepareUpdateBatch: (updates) => {
      events.push(`prepare:${updates.length}`);
    },
    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async () => {},
    onPhaseChange: (phase) => events.push(`phase:${phase}`),
  });

  assert.equal(getUpdatesCalls, 2);
  assert.deepEqual(events, [
    "phase:long-poll",
    "prepare:1",
    "phase:persisting-journal",
    "append:1:1",
    "signal",
    "phase:long-poll",
  ]);
});

test("Journal-first poll loop rejects a missing cursor with retained authority", async () => {
  let getUpdatesCalls = 0;
  await assert.rejects(
    runTelegramPollLoop({
      ctx: TEST_CONTEXT,
      signal: new AbortController().signal,
      config: { botToken: "123:abc" },
      deleteWebhook: async () => undefined,
      getUpdates: async () => {
        getUpdatesCalls += 1;
        return [];
      },
      appendUpdateBatch: () => undefined,
      getJournalEntryCount: () => 1,
      signalUpdateWorker: () => {},
      persistConfig: async () => {},
      onErrorStatus: () => {},
      onStatusReset: () => {},
      sleep: async () => {},
    }),
    TelegramPollingCursorBootstrapError,
  );
  assert.equal(getUpdatesCalls, 0);
});

test("Poll loop bootstraps once and journals each prepared response batch", async () => {
  const lifecycle: string[] = [];
  const config: { botToken: string; lastUpdateId?: number } = {
    botToken: "123:abc",
  };
  let getUpdatesCalls = 0;
  let acceptedThroughUpdateId: number | undefined;
  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) return [{ update_id: 5 }];
      if (getUpdatesCalls === 2) return [{ update_id: 6 }, { update_id: 7 }];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    appendUpdateBatch: (updates, cursor) => {
      lifecycle.push(
        `append:${updates.map((update) => update.update_id).join(",")}:${cursor}`,
      );
      acceptedThroughUpdateId = cursor;
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker: () => lifecycle.push("signal"),
    prepareUpdateBatch: (updates) => {
      lifecycle.push(`batch:${updates.map((update) => update.update_id).join(",")}`);
    },
    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async () => {},
  });
  assert.equal(config.lastUpdateId, undefined);
  assert.equal(acceptedThroughUpdateId, 7);
  assert.deepEqual(lifecycle, [
    "append::5",
    "batch:6,7",
    "append:6,7:7",
    "signal",
  ]);
});

test("Polling retry sleep resolves immediately when aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await sleepTelegramPollingRetry(3000, controller.signal);
});

test("Poll loop stops without status reset when aborted during retry sleep", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const controller = new AbortController();
  const statusMessages: string[] = [];
  let calls = 0;
  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: controller.signal,
    config,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      throw new Error("network down");
    },
    persistConfig: async () => {},
    ...NOOP_JOURNAL_ADMISSION,
    onErrorStatus: (message) => {
      statusMessages.push(`error:${message}`);
    },
    onStatusReset: () => {
      statusMessages.push("unexpected:reset");
    },
    sleep: async (_ms, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(statusMessages, ["error:network down"]);
});

test("Poll loop suppresses getUpdates conflicts while another long poll drains", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const statusMessages: string[] = [];
  const runtimeEvents: string[] = [];
  let calls = 0;
  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls <= 4) {
        throw new Error(
          "Telegram API getUpdates failed: HTTP 409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
        );
      }
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: (message) => {
      statusMessages.push(`error:${message}`);
    },
    onStatusReset: () => {
      statusMessages.push("reset");
    },
    sleep: async (ms) => {
      statusMessages.push(`sleep:${ms}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  });
  assert.equal(
    isTelegramGetUpdatesConflictError(
      new Error("HTTP 409: Conflict: terminated by other getUpdates request"),
    ),
    true,
  );
  assert.deepEqual(statusMessages, [
    "sleep:1000",
    "sleep:1000",
    "sleep:3000",
    "sleep:3000",
  ]);
  assert.equal(runtimeEvents.length, 4);
});

test("Poll loop reports retryable errors and sleeps before retrying", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const statusMessages: string[] = [];
  const runtimeEvents: string[] = [];
  let calls = 0;
  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network down");
      }
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: (message) => {
      statusMessages.push(`error:${message}`);
    },
    onStatusReset: () => {
      statusMessages.push("reset");
    },
    sleep: async (ms) => {
      statusMessages.push(`sleep:${ms}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.phase}`);
    },
  });
  assert.deepEqual(statusMessages, [
    "error:network down",
    "sleep:3000",
    "reset",
  ]);
  assert.deepEqual(runtimeEvents, ["polling:network down:loop"]);
});
