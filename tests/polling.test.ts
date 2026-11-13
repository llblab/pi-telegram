/**
 * Regression tests for the Telegram polling runtime domain
 * Covers polling request helpers, stop conditions, and the long-poll loop runtime in one suite
 * Zones: telegram transport, polling runtime
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  createTelegramThreadCapabilityOrchestration,
  createTelegramThreadCapabilityStateRuntime,
  type TelegramThreadCapabilityState,
  type TelegramPollingFirstObservation,
  type TelegramPollLoopDeps,
  createTelegramThreadTargetObservationBinding,
  cutOverTelegramPollingCursor,
  getLatestTelegramUpdateId,
  getTelegramGetUpdatesRequestBudgetMs,
  getTelegramPollingRetryDelayMs,
  isTelegramGetUpdatesConflictError,
  isTelegramPollingControllerActive,
  runTelegramPollLoop,
  shouldStartTelegramPolling,
  shouldStopTelegramPolling,
  sleepTelegramPollingRetry,
  startTelegramPollingRuntime,
  stopTelegramPollingRuntime,
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_GET_UPDATES_CONFLICT_STOP_LIMIT,
  TelegramPersistentGetUpdatesConflictError,
  TelegramGetUpdatesTimeoutError,
  TelegramPollingBatchValidationError,
  TelegramPollingCursorBootstrapError,
} from "../lib/polling.ts";
import { createPassthroughFailureLog } from "./fixtures/failure-log.ts";
import { createTelegramFailureRunLog } from "../lib/logging.ts";

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

type ObservedUpdate = { update_id: number; message: { text: string } };
function firstObservationHarness() {
  const controller = new AbortController(), events: string[] = [], errors: unknown[] = [];
  const raw: ObservedUpdate[] = [{ update_id: 2, message: { text: "original" } }];
  let captured: Readonly<TelegramPollingFirstObservation<ObservedUpdate>> | undefined;
  const deps: TelegramPollLoopDeps<ObservedUpdate, string> = {
    ctx: "original-context", signal: controller.signal, config: { botToken: "123:offline-polling-observation" },
    async deleteWebhook() {}, async getUpdates() { events.push("fetch"); return raw; },
    getAcceptedThroughUpdateId() { events.push("cursor"); return 1; }, getJournalEntryCount: () => 0,
    onFirstUpdateBatch(scope) { events.push("first"); captured = scope; scope.assertCurrent(scope.updates[0]); },
    onSuccessfulResponse() { events.push("response"); }, onPhaseChange(phase) { events.push(phase); },
    appendUpdateBatch() { events.push("append"); }, signalUpdateWorker() { events.push("signal"); controller.abort(); },
    async persistConfig() { assert.fail("No config write expected"); }, onErrorStatus() { events.push("error"); }, onStatusReset() {},
    async sleep() { events.push("retry"); controller.abort(); }, recordRuntimeEvent(_owner, error) { errors.push(error); },
  };
  return { deps, controller, events, errors, raw, get scope() { return captured; }, run: () => runTelegramPollLoop(deps) };
}

for (const artifact of ["source", "compiled"] as const)
test(`Native polling retains journal authority across an unverifiable source guard (${artifact})`, async () => {
  const journalModule = artifact === "source" ? await import("../lib/journal.ts") : await import("../dist/lib/journal.js");
  const polling = artifact === "source" ? { runTelegramPollLoop } : await import("../dist/lib/polling.js");
  const lag = artifact === "source" ? await import("../lib/loop-lag.ts") : await import("../dist/lib/loop-lag.js");
  const dir = fs.mkdtempSync(join(tmpdir(), "pt-poll-guard-")), path = join(dir, "journal.json"), guard = join(dir, "runtime", "journals.transaction");
  const serialize = journalModule.createTelegramJournalSourceSerialization(() => guard);
  const journal = journalModule.createTelegramUpdateJournalStore({ path, withSourceSerialization: serialize,
    botIdentity: journalModule.createTelegramUpdateJournalBotIdentity({ botToken: "123:offline-polling-observation", botId: 77 }) });
  const h = firstObservationHarness(); let retries = 0, signals = 0;
  try {
    journal.appendBatch([{ update_id: 1, message: { text: "already accepted" } }], 1);
    const original = journal.read(), originalBytes = fs.readFileSync(path, "utf8");
    fs.mkdirSync(guard, { mode: 0o700 }); fs.writeFileSync(join(guard, "owner.fixture.json"), "", { mode: 0o600 });
    const waits = lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0;
    h.deps.getAcceptedThroughUpdateId = () => journal.read().acceptedThroughUpdateId;
    h.deps.getJournalEntryCount = () => journal.read().entries.length;
    h.deps.appendUpdateBatch = (updates, cursor) => { journal.appendBatch(updates, cursor); };
    h.deps.signalUpdateWorker = () => { signals++; h.controller.abort(); };
    h.deps.sleep = async delay => {
      retries++; assert.equal(retries, 1); assert.equal(delay, 1000);
      assert.equal(signals, 0); assert.equal(h.errors.length, 1);
      assert.ok(h.errors[0] instanceof Error); assert.equal(h.errors[0].name, "TelegramFileTransactionGuardError");
      assert.deepEqual(journal.read(), original); assert.equal(fs.readFileSync(path, "utf8"), originalBytes);
      assert.equal(fs.readFileSync(join(guard, "owner.fixture.json"), "utf8"), "");
      assert.equal(lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0, waits);
      // This fixture is the sole writer: simulate a separately authorized repair, never automatic cleanup.
      fs.rmSync(guard, { recursive: true });
    };
    await polling.runTelegramPollLoop(h.deps);
    assert.equal(retries, 1); assert.equal(signals, 1);
    assert.equal(journal.read().acceptedThroughUpdateId, 2);
    assert.deepEqual(journal.read().entries.map(entry => entry.updateId), [1, 2]);
    assert.deepEqual(journal.read().entries[0], original.entries[0]); assert.equal(fs.existsSync(guard), false);
  } finally { h.controller.abort(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Polling first observation precedes response, cursor, phase, append and signal callbacks", async () => {
  const h = firstObservationHarness(); await h.run();
  const seen = h.events.slice(h.events.indexOf("fetch"));
  assert.deepEqual(seen, ["fetch", "first", "response", "cursor", "persisting-journal", "append", "signal"]);
  assert.deepEqual(h.errors, []); assert.ok(h.scope); assert.ok(Object.isFrozen(h.scope) && Object.isFrozen(h.scope.updates));
  assert.ok(Object.isFrozen(h.scope.updates[0])); assert.notEqual(h.scope.updates[0], h.raw[0]);
  assert.equal(h.scope.requestedAfterUpdateId, 1); assert.throws(h.scope.assertCurrent);
});

for (const owner of ["runner", "controller"] as const)
test(`Polling first observation reaches the native ${owner} without a new polling owner`, async () => {
  const h = firstObservationHarness();
  if (owner === "runner") {
    const run = createTelegramPollLoopRunner({ ...h.deps, getConfig: () => h.deps.config, updateStatus() {} });
    await run(h.deps.ctx, h.controller.signal);
  } else {
    const controller = createTelegramPollingControllerRuntime({ ...h.deps, getConfig: () => h.deps.config,
      hasBotToken: () => true, stopTypingLoop() {}, updateStatus() {}, createAbortController: () => h.controller });
    try {
      controller.start(h.deps.ctx);
      await waitForPollingCondition(() => h.events.includes("signal"), "Native controller did not forward the first-observation port");
    } finally { await controller.stop(); }
  }
  assert.ok(h.scope); assert.throws(h.scope.assertCurrent); assert.deepEqual(h.errors, []);
});

test("Polling first observation is closed before ordinary response and append callbacks", async () => {
  const h = firstObservationHarness();
  h.deps.onSuccessfulResponse = () => { assert.ok(h.scope); assert.throws(h.scope.assertCurrent); h.events.push("response"); };
  h.deps.appendUpdateBatch = () => { assert.ok(h.scope); assert.throws(h.scope.assertCurrent); h.events.push("append"); };
  await h.run(); assert.deepEqual(h.errors, []); assert.ok(h.events.includes("append"));
});

test("Polling first observation binds exact scoped records, not equal DTOs or restored failed attempts", async () => {
  const h = firstObservationHarness(); let original: (() => void) | undefined, refusedCopy = false, refusedRestoration = false;
  h.deps.onFirstUpdateBatch = scope => {
    original = scope.assertCurrent;
    try { scope.assertCurrent(structuredClone(scope.updates[0]!)); } catch { refusedCopy = true; }
    try { scope.assertCurrent(scope.updates[0]); } catch { refusedRestoration = true; }
  };
  await h.run(); assert.ok(original); assert.throws(original); assert.equal(refusedCopy, true); assert.equal(refusedRestoration, true);
  assert.ok(h.events.includes("retry")); assert.equal(h.events.includes("response"), false); assert.equal(h.events.includes("append"), false);
});

for (const side of ["raw", "snapshot"] as const)
test(`Polling first observation refuses ${side} mutation without ordinary fallback`, async () => {
  const h = firstObservationHarness(); let refusedMutation = false, refusedRestoration = false;
  h.deps.onFirstUpdateBatch = scope => {
    const data = side === "raw" ? h.raw[0]! : scope.updates[0]!;
    data.message.text = "changed"; try { scope.assertCurrent(); } catch { refusedMutation = true; } data.message.text = "original";
    try { scope.assertCurrent(); } catch { refusedRestoration = true; }
  };
  await h.run(); assert.equal(refusedMutation, true); assert.equal(refusedRestoration, true);
  assert.equal(h.events.includes("append"), false); assert.equal(h.events.includes("signal"), false);
});

test("Polling first observation refuses Promise continuations and never spans an await", async () => {
  const h = firstObservationHarness(); let later: Promise<void> | undefined;
  h.deps.onFirstUpdateBatch = async scope => {
    later = Promise.resolve().then(() => { assert.throws(scope.assertCurrent); }); await later;
  };
  await h.run(); await later; assert.ok(h.events.includes("retry")); assert.equal(h.events.includes("append"), false);
});

test("Polling first observation callback refusal is not swallowed as diagnostic success", async () => {
  const h = firstObservationHarness(); h.deps.onFirstUpdateBatch = () => { throw new Error("Controlled private refusal"); };
  await h.run(); assert.ok(h.events.includes("retry")); assert.equal(h.events.includes("response"), false);
  assert.equal(h.events.includes("append"), false); assert.equal(h.events.includes("signal"), false);
  assert.ok(h.errors.length > 0); assert.equal(h.errors.some(error => error instanceof Error && error.message.includes("Controlled private refusal")), false);
});

for (const port of ["ctx", "config", "token", "getUpdates", "getUpdatesRequestBudgetMs", "appendUpdateBatch", "getAcceptedThroughUpdateId", "signalUpdateWorker", "onFirstUpdateBatch"] as const)
test(`Polling first observation refuses in-flight ${port} renewal before granting a scope`, async () => {
  const h = firstObservationHarness(); let observations = 0;
  h.deps.onFirstUpdateBatch = () => { observations++; };
  const read = h.deps.getUpdates;
  h.deps.getUpdates = async (...args) => {
    const updates = await read(...args);
    if (port === "ctx") h.deps.ctx = "other-context";
    else if (port === "config") h.deps.config = { ...h.deps.config };
    else if (port === "token") h.deps.config.botToken = "123:changed";
    else if (port === "getUpdates") h.deps.getUpdates = h.deps.getUpdates.bind(h.deps);
    else if (port === "getUpdatesRequestBudgetMs") h.deps.getUpdatesRequestBudgetMs = () => 10_000;
    else if (port === "appendUpdateBatch") h.deps.appendUpdateBatch = () => {};
    else if (port === "getAcceptedThroughUpdateId") h.deps.getAcceptedThroughUpdateId = () => 1;
    else if (port === "signalUpdateWorker") h.deps.signalUpdateWorker = () => {};
    else h.deps.onFirstUpdateBatch = () => {};
    return updates;
  };
  await h.run(); assert.equal(observations, 0); assert.ok(h.events.includes("retry")); assert.equal(h.events.includes("append"), false);
});

test("Polling first observation pins the actual request callable before deferred issue, not only after restoration", async () => {
  const h = firstObservationHarness(); let wrongTransportCalls = 0, observations = 0;
  const original = h.deps.getUpdates;
  h.deps.onFirstUpdateBatch = () => { observations++; };
  h.deps.getUpdatesRequestBudgetMs = () => {
    h.deps.getUpdates = async () => { wrongTransportCalls++; h.deps.getUpdates = original; return h.raw; };
    return 10_000;
  };
  await h.run(); assert.equal(wrongTransportCalls, 0); assert.equal(observations, 0);
  assert.ok(h.events.includes("retry")); assert.equal(h.events.includes("append"), false);
});

test("Polling first observation refuses source-owner descriptor substitution without executing its getter", async () => {
  const h = firstObservationHarness(); let getterCalls = 0;
  h.deps.onFirstUpdateBatch = scope => {
    const signal = h.deps.signalUpdateWorker;
    Object.defineProperty(h.deps, "signalUpdateWorker", { configurable: true, get() { getterCalls++; return signal; } });
    assert.throws(scope.assertCurrent);
  };
  await h.run(); assert.equal(getterCalls, 0); assert.equal(h.events.includes("append"), false);
});

test("Polling first observation poisons caught data-observation reentry", async () => {
  const h = firstObservationHarness(); let nested = false, refusedOuter = false, refusedRestoration = false;
  h.deps.onFirstUpdateBatch = scope => {
    Object.assign(h.raw[0]!.message, { toJSON() {
      try { scope.assertCurrent(); } catch { nested = true; }
      return { text: "original" };
    } });
    try { scope.assertCurrent(); } catch { refusedOuter = true; }
    try { scope.assertCurrent(); } catch { refusedRestoration = true; }
  };
  await h.run(); assert.equal(nested, true); assert.equal(refusedOuter, true); assert.equal(refusedRestoration, true);
  assert.equal(h.events.includes("append"), false);
});

test("Polling first observation rejects non-monotonic and oversized incoming packets before callbacks", async () => {
  for (const raw of [[{ update_id: 1, message: { text: "old" } }],
    Array.from({ length: 11 }, (_, i) => ({ update_id: i + 2, message: { text: "over limit" } }))]) {
    const h = firstObservationHarness(); h.deps.getUpdates = async () => raw;
    await h.run(); assert.equal(h.events.includes("first"), false); assert.equal(h.events.includes("response"), false);
    assert.equal(h.events.includes("append"), false);
  }
});

test("Polling first observation is not minted for empty responses or historical cursor bootstrap", async () => {
  const h = firstObservationHarness(); let cursor: number | undefined, fetches = 0, observations = 0;
  h.deps.getAcceptedThroughUpdateId = () => cursor;
  h.deps.getUpdates = async () => ++fetches === 1 ? [{ update_id: 10, message: { text: "history" } }] : [{ update_id: 11, message: { text: "new" } }];
  h.deps.appendUpdateBatch = (updates, accepted) => { if (!updates.length) cursor = accepted; else { assert.equal(updates[0]!.update_id, 11); h.events.push("append"); } };
  h.deps.onFirstUpdateBatch = scope => { observations++; assert.equal(scope.requestedAfterUpdateId, 10); assert.equal(scope.updates[0]!.update_id, 11); };
  await h.run(); assert.equal(observations, 1); assert.equal(fetches, 2); assert.ok(h.events.includes("append"));
  const empty = firstObservationHarness(); empty.deps.getUpdates = async () => [];
  empty.deps.onSuccessfulResponse = () => { empty.controller.abort(); };
  await empty.run(); assert.equal(empty.scope, undefined); assert.deepEqual(empty.errors, []);
});

test("Polling first observation cannot treat a failed cursor bootstrap as incoming-source authority", async () => {
  const h = firstObservationHarness(); let fetches = 0;
  h.deps.getAcceptedThroughUpdateId = () => undefined;
  h.deps.getUpdates = async () => { if (++fetches === 1) throw new Error("bootstrap unavailable"); return h.raw; };
  await h.run(); assert.equal(fetches, 2); assert.equal(h.scope, undefined); assert.equal(h.events.includes("append"), false);
});

test("Polling first observation observes owner abort without source publication or fallback", async () => {
  const h = firstObservationHarness(); h.deps.onFirstUpdateBatch = scope => { h.controller.abort(); assert.throws(scope.assertCurrent); };
  await h.run(); assert.equal(h.events.includes("response"), false); assert.equal(h.events.includes("append"), false);
});

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
    failureLog: createPassthroughFailureLog(),
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

for (const scenario of ["relayed", "leader-probes", "stale-relay"] as const)
test(`Thread capability monitor uses the leader relay only for a follower with a fresh value (${scenario})`, async () => {
  let apiCalls = 0;
  const monitor = createTelegramThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog(),
    getAllowedUserId: () => 7,
    callApi: async <TResponse>() => { apiCalls += 1; return { has_topics_enabled: true } as TResponse; },
    topicTargetStore: { load: async () => {}, persist: async () => {},
      getBotState: () => ({ threadMode: "enabled" as const }), setBotState: () => {} },
    ownsLock: () => scenario === "leader-probes",
    isFollowerRegistered: () => scenario !== "leader-probes",
    getRelayedThreadCapability: () => (scenario === "stale-relay" ? undefined : true),
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus: () => {}, setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {}, startClassicPolling: () => {},
    stopClassicPolling: () => {}, startBusPolling: () => {}, stopBusPolling: () => {},
    startLeaderHealth: () => {}, stopLeaderHealth: () => {}, updateStatus: () => {}, recordEvent: () => {},
    intervalMs: 1,
  });
  monitor.start(TEST_CONTEXT);
  await new Promise((resolve) => setTimeout(resolve, 20));
  monitor.stop();
  if (scenario === "relayed") assert.equal(apiCalls, 0, "A follower with a fresh relayed capability makes no getMe call");
  else assert.ok(apiCalls > 0, "The leader and a follower without a fresh relay still probe Telegram");
});

test("Thread capability monitor stops after synchronous stale-context preflight", async () => {
  let ownershipReads = 0;
  let records = 0;
  let apiCalls = 0;
  const recordEvent = (_category: string, error: unknown) => {
    assert.match(String(error), /ctx is stale/);
    records += 1;
    throw new Error("diagnostic sink failed");
  };
  const staleContext = { get cwd(): string {
    ownershipReads += 1;
    throw new Error("This extension ctx is stale after session replacement or reload.");
  } };
  const monitor = createTelegramThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog((error) => recordEvent("bus", error)),
    getAllowedUserId: () => 7,
    callApi: async <TResponse>() => { apiCalls += 1; return {} as TResponse; },
    topicTargetStore: { load: async () => {}, persist: async () => {},
      getBotState: () => ({}), setBotState: () => {} },
    ownsLock: (ctx: typeof staleContext) => ctx.cwd === "/project",
    isFollowerRegistered: () => false,
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus: () => {}, setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {}, startClassicPolling: () => {},
    stopClassicPolling: () => {}, startBusPolling: () => {}, stopBusPolling: () => {},
    startLeaderHealth: () => {}, stopLeaderHealth: () => {}, updateStatus: () => {},
    recordEvent,
    intervalMs: 1,
  });
  monitor.start(staleContext);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ownershipReads, 1);
  assert.equal(apiCalls, 0);
  assert.equal(records, 1);
  monitor.stop();
});

test("Thread capability monitor collapses a sustained probe failure and reports its recovery", async () => {
  const events: Array<{ details?: Record<string, unknown> }> = [];
  let failing = true;
  let probes = 0;
  const monitor = createTelegramThreadCapabilityMonitor({
    failureLog: createTelegramFailureRunLog({
      category: "bus",
      failurePhase: "capability-monitor",
      outcomePhase: "capability-monitor-recovered",
      label: "Threaded Mode capability probe",
      record: (_category, _errorOrMessage, details) => events.push({ details }),
    }),
    getAllowedUserId: () => 7,
    callApi: async <TResponse>() => {
      probes += 1;
      if (failing) throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
      return { has_topics_enabled: true } as TResponse;
    },
    topicTargetStore: { load: async () => {}, persist: async () => {},
      getBotState: () => ({}), setBotState: () => {} },
    ownsLock: () => true,
    isFollowerRegistered: () => false,
    getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus: () => {}, setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {}, startClassicPolling: () => {},
    stopClassicPolling: () => {}, startBusPolling: () => {}, stopBusPolling: () => {},
    startLeaderHealth: () => {}, stopLeaderHealth: () => {}, updateStatus: () => {},
    recordEvent: (_category, _error, details) => events.push({ details }),
    intervalMs: 5,
  });
  const failures = () => events.filter((event) => event.details?.phase === "capability-monitor");
  const recovered = () => events.find((event) => event.details?.phase === "capability-monitor-recovered");
  try {
    monitor.start(TEST_CONTEXT);
    for (let tick = 0; tick < 50 && (probes < 3 || failures().length === 0); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(probes >= 3, `expected repeated probes, saw ${probes}`);
    assert.equal(failures().length, 1, "a repeated identical probe failure is logged once");
    assert.equal(failures()[0]?.details?.failureSignature, "ENOENT");
    failing = false;
    for (let tick = 0; tick < 50 && !recovered(); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(recovered(), "a successful probe closes the failure run");
    assert.ok(Number(recovered()?.details?.failedAttempts) >= 3);
  } finally {
    monitor.stop();
  }
});

test("Thread capability monitor invalidates a replaced session before reading its context", async () => {
  const reads = { old: 0, current: 0 };
  let records = 0;
  const oldContext = { session: "old" as const };
  const currentContext = { session: "current" as const };
  const monitor = createTelegramThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog(),
    getAllowedUserId: () => 7, callApi: async <TResponse>() => ({} as TResponse),
    topicTargetStore: { load: async () => {}, persist: async () => {},
      getBotState: () => ({}), setBotState: () => {} },
    ownsLock: (ctx: typeof oldContext | typeof currentContext) => {
      reads[ctx.session] += 1;
      if (ctx.session === "old") throw new Error("old context was read");
      return false;
    },
    isFollowerRegistered: () => false, getPollingStartedWithTelegramBus: () => false,
    setPollingStartedWithTelegramBus: () => {}, setTopicModeUnavailable: () => {},
    stopFollowerRegistration: () => {}, startClassicPolling: () => {},
    stopClassicPolling: () => {}, startBusPolling: () => {}, stopBusPolling: () => {},
    startLeaderHealth: () => {}, stopLeaderHealth: () => {}, updateStatus: () => {},
    recordEvent: () => { records += 1; }, intervalMs: 1,
  });
  monitor.start(oldContext);
  monitor.start(currentContext);
  await new Promise(resolve => setTimeout(resolve, 10));
  monitor.stop();
  assert.equal(reads.old, 0);
  assert.ok(reads.current > 0);
  assert.equal(records, 0);
});

test("Thread capability monitor serializes probes across lifecycle generations", async () => {
  let calls = 0;
  let state: { threadMode?: "enabled" | "disabled" | "unknown" } = {};
  const releases: Array<(value: unknown) => void> = [];
  const monitor = createTelegramThreadCapabilityMonitor({
    failureLog: createPassthroughFailureLog(),
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
  state.setRequestedThreadName("Navigator");

  assert.equal(state.isBusPollingStarted(), true);
  assert.equal(state.isTopicModeUnavailable(), true);
  assert.equal(state.shouldForceFreshLeaderThread(), true);
  assert.equal(state.getRequestedThreadName(), "Navigator");
});

function createCapabilityLifecycleFixture(hooks: {
  getMe: () => Promise<boolean | undefined>;
  initialBot?: TelegramThreadCapabilityState;
  ownsLock?: () => boolean;
  isFollowerRegistered?: () => boolean;
  persist?: () => Promise<void>;
  startBus?: () => Promise<void>;
}) {
  const state = createTelegramThreadCapabilityStateRuntime();
  let bot: TelegramThreadCapabilityState = hooks.initialBot ?? {};
  const calls: string[] = [];
  const runtime = createTelegramThreadCapabilityOrchestration<string, unknown>({
    failureLog: createPassthroughFailureLog(),
    state, getAllowedUserId: () => 1,
    callApi: async <TResponse,>() => ({ has_topics_enabled: await hooks.getMe() }) as TResponse,
    topicTargetStore: {
      load: async () => {},
      persist: async () => { calls.push("persist"); await hooks.persist?.(); },
      getBotState: () => bot,
      setBotState: (value) => { bot = value; calls.push(`bot:${value.threadMode}`); },
    },
    ownsLock: hooks.ownsLock ?? (() => true), isFollowerRegistered: hooks.isFollowerRegistered,
    isBusRuntimeEnabled: state.isBusRuntimeEnabled,
    startClassicPolling: () => { calls.push("classic-start"); },
    stopClassicPolling: async () => { calls.push("classic-stop"); },
    startBusLeaderPolling: async () => { calls.push("bus-start"); await hooks.startBus?.(); },
    stopBusLeaderPolling: async () => { calls.push("bus-stop"); },
    startLeaderHealth: () => { calls.push("health-start"); },
    stopLeaderHealth: () => { calls.push("health-stop"); },
    registerFollowerWithLeader: async () => false, stopFollowerRegistration: () => {},
    isTopicModeUnavailableError: () => true,
    updateStatus: () => { calls.push("status"); },
    recordEvent: () => { calls.push("event"); },
  });
  return { runtime, state, calls, getBotState: () => bot };
}

test("A fresh positive probe restores the bus after startup timeout with retained enabled mode", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let probes = 0;
  const fixture = createCapabilityLifecycleFixture({
    initialBot: { threadMode: "enabled" },
    getMe: async () => {
      if (++probes === 1) throw new Error("connect ETIMEDOUT");
      return probes === 2 ? undefined : true;
    },
  });
  const { runtime, state, calls } = fixture;
  const tick = async () => { t.mock.timers.tick(2500); await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await runtime.pollingPorts.startPolling("ctx");
    assert.equal(fixture.getBotState().threadMode, "enabled");
    assert.equal(state.isBusPollingStarted(), false);
    assert.equal(state.isTopicModeUnavailable(), true);
    assert.ok(calls.includes("classic-start"));
    runtime.monitor.start("ctx");
    await tick();
    assert.equal(state.isBusPollingStarted(), false, "An unknown response is not fresh capability proof");
    await tick();
    assert.equal(state.isBusPollingStarted(), true);
    assert.equal(state.isTopicModeUnavailable(), false);
    assert.equal(calls.filter(call => call === "bus-start").length, 1);
    assert.ok(calls.indexOf("classic-stop") < calls.indexOf("bus-start"));
    assert.equal(calls.filter(call => call === "health-start").length, 1);
    await tick();
    assert.equal(calls.filter(call => call === "bus-start").length, 1, "Healthy bus is not restarted");
  } finally {
    runtime.monitor.stop();
    await runtime.pollingPorts.stopPolling();
  }
});

test("An enabled-mode follower probe does not acquire or start a leader bus", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let probes = 0;
  const { runtime, state, calls } = createCapabilityLifecycleFixture({
    initialBot: { threadMode: "enabled" }, ownsLock: () => false, isFollowerRegistered: () => true,
    getMe: async () => { probes++; return true; },
  });
  try {
    runtime.monitor.start("follower");
    t.mock.timers.tick(2500);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(probes, 1);
    assert.equal(state.isBusPollingStarted(), false);
    assert.deepEqual(calls, []);
  } finally {
    runtime.monitor.stop();
  }
});

test("Obsolete startup probes cannot overwrite a replacement after query or persistence awaits", async () => {
  for (const boundary of ["query", "persist"] as const) {
    for (const oldMode of [false, true]) {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const pause = async () => { entered(); await gate; };
      let queries = 0;
      let writes = 0;
      const fixture = createCapabilityLifecycleFixture({
        getMe: async () => {
          if (++queries !== 1) return !oldMode;
          if (boundary === "query") await pause();
          return oldMode;
        },
        persist: async () => { if (++writes === 1 && boundary === "persist") await pause(); },
      });
      const { runtime, state, calls } = fixture;
      try {
        const stale = runtime.pollingPorts.startPolling("old");
        await waiting;
        await runtime.pollingPorts.stopPolling();
        await runtime.pollingPorts.startPolling("replacement");
        const replacementCalls = [...calls];
        release();
        await stale;
        assert.deepEqual(calls, replacementCalls, `${boundary}/${oldMode}`);
        assert.equal(fixture.getBotState().threadMode, oldMode ? "disabled" : "enabled");
        assert.equal(state.isTopicModeUnavailable(), oldMode);
        assert.equal(state.isBusPollingStarted(), !oldMode);
      } finally {
        release();
        runtime.monitor.stop();
        await runtime.pollingPorts.stopPolling();
      }
    }
  }
});

test("Stopped capability transitions cannot restart health, fall back, or mutate a replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const source of ["monitor", "observation"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      for (const replace of [false, true]) {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        let queries = 0;
        let busStarts = 0;
        const fixture = createCapabilityLifecycleFixture({
          getMe: async () => ++queries > 1,
          startBus: async () => {
            if (++busStarts !== 1) return;
            entered();
            await gate;
            if (outcome === "reject") throw new Error("Old transition failed");
          },
        });
        const { runtime, state, calls } = fixture;
        try {
          await runtime.pollingPorts.startPolling("ctx");
          let observation: Promise<void> | undefined;
          if (source === "monitor") {
            runtime.monitor.start("ctx");
            t.mock.timers.tick(2500);
          } else {
            observation = runtime.observeTarget("ctx");
          }
          await waiting;
          runtime.monitor.stop();
          await runtime.pollingPorts.stopPolling();
          if (replace) await runtime.pollingPorts.startPolling("replacement");
          const retainedCalls = [...calls];
          const retainedBot = structuredClone(fixture.getBotState());
          release();
          await observation;
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.deepEqual(calls, retainedCalls, `${source}/${outcome}/${replace}`);
          assert.deepEqual(fixture.getBotState(), retainedBot);
          assert.equal(calls.filter((call) => call === "health-start").length, replace ? 1 : 0);
          assert.equal(state.isBusPollingStarted(), replace);
        } finally {
          release();
          runtime.monitor.stop();
          await runtime.pollingPorts.stopPolling();
        }
      }
    }
  }
});

for (const mode of ["disabled", "unknown", "enabled", undefined] as const)
test(`Thread-aware polling distinguishes pending mode from classic takeover (${mode ?? "missing"})`, async () => {
  let registrations = 0;
  const callApi = async <TResponse,>(): Promise<TResponse> => ({}) as TResponse;
  const store = {
    async load() {},
    async persist() {},
    getBotState() {
      return { threadMode: mode };
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
    registerFollowerWithLeader: async () => { registrations++; return true; },
    stopFollowerRegistration() {},
    recordEvent() {},
  });

  assert.equal(
    await ports.registerFollowerWithOwner?.(TEST_CONTEXT, { pid: 1 }),
    mode === "disabled" ? undefined : mode === "enabled" ? true : "pending",
  );
  assert.equal(registrations, mode === "enabled" ? 1 : 0, "Unknown capability cannot authorize registration from retained history");
});

for (const fault of ["none", "caller-loss", "stop", "superseded", "delegate-replaced", "lifecycle-loss", "reentry", "callback-replaced"] as const)
test(`Follower refresh carries its original attempt to delegation (${fault})`, async () => {
  let release!: () => void, entered!: () => void, refreshes = 0, registrations = 0, effects = 0, current = true, lifecycleCurrent = true;
  let forwarded: (() => void) | undefined, reenter = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const deps = {
    getAllowedUserId: () => 42, callApi: async <TResponse,>() => ({}) as TResponse,
    topicTargetStore: { async load() {}, async refresh() { if (++refreshes === 1) { entered(); await gate; } },
      async persist() {}, getBotState: () => ({ threadMode: "enabled" as const }), setBotState() {} },
    lifecycle: { capture: () => () => lifecycleCurrent, invalidate() { lifecycleCurrent = false; } },
    isBusRuntimeEnabled: () => false, isTopicModeUnavailableError: () => false,
    getPollingStartedWithTelegramBus: () => false, setPollingStartedWithTelegramBus() {}, setForceFreshLeaderThreadOnNextStart() {}, setTopicModeUnavailable() {},
    startClassicPolling() {}, async stopClassicPolling() {}, async startBusLeaderPolling() {}, async stopBusLeaderPolling() {}, startLeaderHealth() {}, stopLeaderHealth() {},
    registerFollowerWithLeader: async (_ctx: typeof TEST_CONTEXT, _owner: { pid: number }, options?: { assertAuthority?: () => void }) => {
      registrations++;
      assert.ok(options?.assertAuthority, "Native registration must receive the original process-local guard");
      if (fault === "reentry") { forwarded = options.assertAuthority; reenter = true; }
      options.assertAuthority(); effects++; return true;
    }, stopFollowerRegistration() {}, recordEvent() {},
  };
  const ports = createTelegramThreadAwarePollingPorts(deps);
  const options = { recoverConnection: true, assertAuthority() {
    if (reenter) { reenter = false; try { forwarded!(); } catch { /* Producer catches the original reentry refusal. */ } }
    if (!current) throw new Error("Fixture original caller ended");
  } };
  const pending = ports.registerFollowerWithOwner(TEST_CONTEXT, { pid: 1 }, options).then(value => ({ value }), error => ({ error }));
  try {
    await waiting;
    if (fault === "caller-loss") current = false;
    if (fault === "callback-replaced") { current = false; options.assertAuthority = () => {}; }
    if (fault === "stop") ports.stopFollowerRegistration();
    if (fault === "lifecycle-loss") lifecycleCurrent = false;
    if (fault === "delegate-replaced") deps.registerFollowerWithLeader = async () => { registrations++; return true; };
    if (fault === "superseded") assert.equal(await ports.registerFollowerWithOwner(TEST_CONTEXT, { pid: 1 }), true);
    release();
    const outcome = await pending;
    if (fault === "none") assert.deepEqual(outcome, { value: true });
    else assert.ok("error" in outcome && outcome.error instanceof Error, "A stale refresh cannot delegate after its original scope ends");
    assert.equal(registrations, fault === "none" || fault === "superseded" || fault === "reentry" ? 1 : 0);
    assert.equal(effects, fault === "none" || fault === "superseded" ? 1 : 0, "Caught reentry cannot restore the original authority");
  } finally { release(); await pending; }
});

for (const outcome of ["enabled", "classic", "timeout", "late-refresh", "long-ack", "rejected", "negative", "restore", "cancelled", "getter-replaced", "constant-clock", "logging"] as const)
test(`Original readiness observation ends before one native registration (${outcome})`, async () => {
  let now = 0, mode: "unknown" | "enabled" | "disabled" = "unknown", waits = 0, refreshes = 0, issues = 0, current = true;
  const original = new Error("Fixture protected refusal");
  const records: unknown[] = [];
  const store = { async load() {}, async refresh() {
    refreshes++;
    if (waits && outcome === "restore") throw original;
    if (waits && outcome === "late-refresh") { await Promise.resolve(); now = 600; mode = "enabled"; }
  }, async persist() {}, getBotState: () => ({ threadMode: mode }), setBotState() {} };
  const ports = createTelegramThreadAwarePollingPorts({
    getAllowedUserId: () => 42, callApi: async <T,>() => ({}) as T, topicTargetStore: store,
    isBusRuntimeEnabled: () => false, isTopicModeUnavailableError: () => false,
    getPollingStartedWithTelegramBus: () => false, setPollingStartedWithTelegramBus() {}, setForceFreshLeaderThreadOnNextStart() {}, setTopicModeUnavailable() {},
    startClassicPolling() { assert.fail("Readiness cannot poll"); }, async stopClassicPolling() {}, async startBusLeaderPolling() { assert.fail("Readiness cannot lead"); },
    async stopBusLeaderPolling() {}, startLeaderHealth() {}, stopLeaderHealth() {}, stopFollowerRegistration() {},
    registerFollowerWithLeader: async (_ctx, _owner, options) => {
      assert.equal(Object.hasOwn(options!, "readiness"), false, "The local readiness budget never enters native registration");
      options?.assertAuthority?.(); issues++;
      if (outcome === "long-ack") { now = 60_000; await Promise.resolve(); options?.assertAuthority?.(); }
      if (outcome === "rejected") throw original;
      return outcome !== "negative";
    }, recordEvent(_category, _error, details) { records.push(details?.phase); if (outcome === "logging") throw original; },
  });
  const pending = ports.registerFollowerWithOwner(TEST_CONTEXT, { pid: 1 }, {
    readiness: {
      remainingMs: () => outcome === "constant-clock" ? 600 : 600 - now,
      async wait() {
        waits++; now += 150;
        if (outcome === "cancelled") current = false;
        if (outcome === "getter-replaced") store.getBotState = () => ({ threadMode: "enabled" });
        if (!["timeout", "late-refresh", "restore", "constant-clock"].includes(outcome)) mode = outcome === "classic" ? "disabled" : "enabled";
        return waits < 4;
      },
    },
    assertAuthority() { if (!current) throw original; },
  });
  if (["rejected", "restore", "cancelled", "getter-replaced"].includes(outcome))
    await assert.rejects(pending, error => outcome === "getter-replaced" ? error instanceof Error : error === original);
  else assert.equal(await pending, ["timeout", "late-refresh", "constant-clock"].includes(outcome) ? "readiness-expired" : outcome === "classic" ? undefined : outcome !== "negative");
  assert.equal(issues, ["enabled", "long-ack", "rejected", "negative", "logging"].includes(outcome) ? 1 : 0);
  assert.equal(records.filter(phase => phase === "follower-readiness-wait").length, 1);
  assert.ok(waits <= 4 && refreshes <= 5, "A frozen clock cannot extend the original observation count");
});

for (const loggingFails of [false, true])
test(`Follower refresh refusal is local and preserves the original error (${loggingFails})`, async () => {
  const original = new Error("Workspace Restore evidence fixture refusal");
  const records: Array<{ error: unknown; details?: Record<string, unknown> }> = [];
  let registrations = 0;
  const ports = createTelegramThreadAwarePollingPorts({
    getAllowedUserId: () => 42, callApi: async <TResponse,>() => ({}) as TResponse,
    topicTargetStore: { async load() { throw original; }, async refresh() { throw original; }, async persist() {}, getBotState: () => ({ threadMode: "enabled" }), setBotState() {} },
    isBusRuntimeEnabled: () => false, isTopicModeUnavailableError: () => false,
    getPollingStartedWithTelegramBus: () => false, setPollingStartedWithTelegramBus() {}, setForceFreshLeaderThreadOnNextStart() {}, setTopicModeUnavailable() {},
    startClassicPolling() {}, async stopClassicPolling() {}, async startBusLeaderPolling() {}, async stopBusLeaderPolling() {}, startLeaderHealth() {}, stopLeaderHealth() {},
    registerFollowerWithLeader: async () => { registrations++; return true; }, stopFollowerRegistration() {},
    recordEvent(_category, error, details) { records.push({ error, details }); if (loggingFails) throw new Error("Fixture diagnostics failed"); },
  });
  await assert.rejects(ports.registerFollowerWithOwner(TEST_CONTEXT, { pid: 1 }), error => error === original);
  assert.equal(registrations, 0, "Local view refusal cannot send a registration request");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.error, original);
  assert.deepEqual(records[0]?.details, { phase: "follower-readiness-refresh-refused", source: "local" });
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

for (const mode of ["enabled", "disabled", "unknown"] as const) for (const remembered of [false, true])
for (const classicOmitted of mode === "disabled" ? [false, true] : [false])
test(`Automatic leader eligibility requires remembered Thread continuity (${mode}, remembered=${remembered}, classicOmitted=${classicOmitted})`, async () => {
  let bus = false, unavailable = false, starts = 0, classic = 0, binding = remembered, loseDuringProbe = false;
  const ports = createTelegramThreadAwarePollingPorts({
    getAllowedUserId: () => 7, callApi: async <T,>() => {
      if (loseDuringProbe) binding = false;
      return { has_topics_enabled: mode === "unknown" || classicOmitted ? undefined : mode === "enabled" } as T;
    },
    topicTargetStore: { async load() {}, async persist() {}, getBotState: () => ({ threadMode: mode }), setBotState() {} },
    isBusRuntimeEnabled: () => !unavailable, isTopicModeUnavailableError: () => false,
    getPollingStartedWithTelegramBus: () => bus, setPollingStartedWithTelegramBus: value => { bus = value; },
    setForceFreshLeaderThreadOnNextStart() {}, setTopicModeUnavailable: value => { unavailable = value; },
    startClassicPolling() { classic++; }, async stopClassicPolling() {}, async startBusLeaderPolling() { starts++; }, async stopBusLeaderPolling() {},
    startLeaderHealth() {}, stopLeaderHealth() {}, registerFollowerWithLeader: async () => true,
    hasRememberedWorkspaceBinding: () => binding, stopFollowerRegistration() {}, recordEvent() {},
  });
  assert.equal(await ports.canAutoStartSession(TEST_CONTEXT), remembered || mode === "disabled");
  if (!remembered && mode !== "disabled") {
    await assert.rejects(ports.startPolling(TEST_CONTEXT, { restoreWorkspaceOnly: true }), /remembered session binding/u);
    assert.equal(starts, 0); assert.equal(classic, 0);
  } else {
    await ports.startPolling(TEST_CONTEXT, { restoreWorkspaceOnly: true });
    assert.equal(starts + classic, 1);
    await ports.stopPolling();
  }
  if (remembered && mode === "enabled") {
    assert.equal(await ports.canAutoStartSession(TEST_CONTEXT), true);
    loseDuringProbe = true;
    await assert.rejects(ports.startPolling(TEST_CONTEXT, { restoreWorkspaceOnly: true }), /remembered session binding/u);
    assert.equal(starts, 1, "Preflight cannot lend a later missing binding to provisioning");
  }
  await ports.stopPolling();
});

test("Thread-aware polling auto-restores followers only for remembered Workspaces", async () => {
  let remembered = false;
  let restores = 0;
  let threadMode: "enabled" | "disabled" = "enabled";
  const reasons: string[] = [];
  const store = {
    async load() {},
    async refresh() {},
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
    registerFollowerWithLeader: async () => true,
    hasRememberedWorkspaceBinding: () => remembered,
    restoreFollowerWithLeader: async () => {
      restores += 1;
      return true;
    },
    stopFollowerRegistration() {},
    recordEvent(_category, _message, details) {
      if (typeof details?.reason === "string") reasons.push(details.reason);
    },
  });

  assert.equal(
    await ports.restoreFollowerWithOwner(TEST_CONTEXT, { pid: 1 }),
    undefined,
  );
  threadMode = "disabled";
  assert.equal(await ports.restoreFollowerWithOwner(TEST_CONTEXT, { pid: 1 }), undefined);
  threadMode = "enabled";
  remembered = true;
  assert.equal(
    await ports.restoreFollowerWithOwner(TEST_CONTEXT, { pid: 1 }),
    true,
  );
  assert.equal(restores, 1);
  assert.deepEqual(reasons, ["session-binding-unavailable", "thread-mode-unavailable"]);
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
  let suspendedTargets = 0;
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
    failureLog: createPassthroughFailureLog(),
    getAllowedUserId: () => 42,
    callApi: async <TResponse,>(): Promise<TResponse> => ({}) as TResponse,
    topicTargetStore: store,
    ownsLock: () => true,
    getPollingStartedWithTelegramBus: () => pollingStartedWithBus,
    setPollingStartedWithTelegramBus(started: boolean) {
      pollingStartedWithBus = started;
    },
    setTopicModeUnavailable() {},
    suspendLiveThreadTarget() {
      suspendedTargets += 1;
    },
    stopFollowerRegistration() {},
    startClassicPolling() {
      assert.equal(suspendedTargets, 1);
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
  assert.equal(suspendedTargets, 1);

  await applyTelegramThreadCapability(
    TEST_CONTEXT,
    false,
    "capability-monitor-disabled-confirmed",
    deps,
  );
  assert.equal(classicStarts, 2);
  assert.equal(suspendedTargets, 1);
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
      appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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

test("Durable polling prepares only admitted non-excluded runs before any microtask consumer", async () => {
  for (const scenario of ["included", "excluded", "barrier", "publication-failure", "preparation-failure", "diagnostic-failure"] as const) {
    const events: string[] = [];
    const prepared: number[][] = [];
    const diagnostics: unknown[] = [];
    let observed: number[][] | undefined;
    let calls = 0;
    let cursor = 0;
    let finished!: () => void;
    const received = new Promise<void>((resolve) => { finished = resolve; });
    const included = scenario === "excluded" ? [] : scenario === "barrier" ? [1, 3] : [1, 2, 3];
    const assembly = createTelegramDurablePollingRuntimeAssembly<{ update_id: number }, string>({
      getConfig: () => ({ botToken: "fixture" }), hasBotToken: () => true,
      deleteWebhook: async () => {}, persistConfig: async () => {},
      getUpdates: async () => {
        if (calls++ === 0) return [{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }];
        finished();
        throw new DOMException("stop", "AbortError");
      },
      journal: {
        appendBatch(_updates, admittedCursor) {
          events.push("append");
          if (scenario === "publication-failure") throw new Error("fixture publication failed");
          cursor = admittedCursor!;
          // Models an already-draining consumer, not one started by signalWorker.
          queueMicrotask(() => { observed = prepared.map((batch) => [...batch]); events.push("reader"); });
          return { nonExcludedUpdateIds: included };
        },
        getAcceptedThroughUpdateId: () => cursor,
        getEntryCount: () => 0, getBootstrapEntryCount: () => 0,
        signalWorker: () => { events.push("signal"); }, onSessionStart: async () => {},
      },
      prepareUpdateBatch: (updates) => {
        if (scenario === "preparation-failure" || scenario === "diagnostic-failure") throw new Error("fixture preparation failed");
        const ids = updates.map((update) => update.update_id);
        prepared.push(ids);
        events.push(`prepare:${ids.join(",")}`);
      },
      recordRuntimeEvent: (_category, _error, details) => {
        if (details?.phase !== "batch-preparation") return;
        diagnostics.push(details.phase);
        if (scenario === "diagnostic-failure") throw new Error("fixture diagnostics failed");
      },
      sleep: async () => {}, stopTypingLoop: () => {}, updateStatus: () => {},
    });
    try {
      await assembly.admission.start(TEST_CONTEXT);
      await received;
      const expected = scenario === "included" ? [[1, 2, 3]] : scenario === "barrier" ? [[1], [3]] : [];
      assert.deepEqual(prepared, expected, scenario);
      assert.deepEqual(diagnostics, scenario === "preparation-failure" || scenario === "diagnostic-failure" ? ["batch-preparation"] : [], scenario);
      assert.deepEqual(observed, scenario === "publication-failure" ? undefined : expected, scenario);
      assert.deepEqual(events, ["append", ...expected.map((ids) => `prepare:${ids.join(",")}`),
        ...(scenario === "publication-failure" ? [] : ["reader", "signal"])], scenario);
    } finally {
      await assembly.admission.stop();
    }
  }
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
      assert.equal(ms, 1_000);
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
  assert.deepEqual(events, ["status:network down", "sleep:1000", "status:ok"]);
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

    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async () => {},
    onPhaseChange: (phase) => events.push(`phase:${phase}`),
  });

  assert.equal(getUpdatesCalls, 2);
  assert.deepEqual(events, [
    "phase:long-poll",
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

test("Poll loop bootstraps once and journals each response batch", async () => {
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

    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async () => {},
  });
  assert.equal(config.lastUpdateId, undefined);
  assert.equal(acceptedThroughUpdateId, 7);
  assert.deepEqual(lifecycle, [
    "append::5",
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
  assert.equal(runtimeEvents.length, 0);
});

test("Poll loop bounds consecutive conflicts, including bootstrap, and resets on other outcomes", async () => {
  const limit = TELEGRAM_GET_UPDATES_CONFLICT_STOP_LIMIT;
  for (const cursor of [undefined, 1]) {
    for (const reset of [undefined, "success", "network"] as const) {
      const outcomes = [
        ...(reset ? [...Array(limit - 1).fill("conflict"), reset] : []),
        ...Array(limit).fill("conflict"),
      ];
      let calls = 0;
      let sleeps = 0;
      await assert.rejects(runTelegramPollLoop({
        ctx: TEST_CONTEXT, signal: new AbortController().signal,
        config: { botToken: "test-token" }, ...NOOP_JOURNAL_ADMISSION,
        getAcceptedThroughUpdateId: () => cursor,
        deleteWebhook: async () => {}, persistConfig: async () => {},
        getUpdates: async () => {
          const outcome = outcomes[calls++];
          if (outcome === "success") return [];
          if (outcome === "network") throw new Error("network down");
          if (!outcome) throw new DOMException("Test safety bound", "AbortError");
          throw new Error("HTTP 409: Conflict: terminated by other getUpdates request");
        },
        onErrorStatus: () => {}, onStatusReset: () => {},
        sleep: async () => { sleeps++; },
      }), (error: unknown) => error instanceof TelegramPersistentGetUpdatesConflictError && error.count === limit);
      assert.equal(calls, outcomes.length, `${cursor}/${reset}`);
      assert.equal(sleeps, (limit - 1) * (reset ? 2 : 1) + (reset === "network" ? 1 : 0));
    }
  }
});

test("Persistent conflict detaches the poller before awaited outer teardown", async () => {
  const state = createTelegramPollingControllerState();
  let notifications = 0;
  let typingStops = 0;
  const controller = createTelegramPollingController({
    state, hasBotToken: () => true, updateStatus: () => {},
    stopTypingLoop: () => { typingStops++; },
    runPollLoop: async () => { throw new TelegramPersistentGetUpdatesConflictError(10); },
    async onPersistentConflict(ctx, count): Promise<void> {
      assert.equal(ctx, TEST_CONTEXT);
      assert.equal(count, 10);
      assert.equal(state.pollingPromise, undefined);
      await controller.stop();
      notifications++;
    },
  });
  controller.start(TEST_CONTEXT);
  await state.pollingPromise;
  assert.equal(notifications, 1);
  assert.equal(typingStops, 1);
  assert.equal(state.stopReason, "persistent-conflict");
  assert.equal(state.phase, "stopped");
});

test("Rejected stale admission leaves the current pending startup intact", async () => {
  for (const boundary of ["prepare", "worker"] as const) {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pause = async () => { entered(); await pending; };
    const starts: string[] = [];
    const runtime = createTelegramPollingAdmissionRuntime({
      canStart: (ctx) => ctx === "current",
      prepareStart: () => boundary === "prepare" ? pause() : undefined,
      worker: { onSessionStart: async () => { if (boundary === "worker") await pause(); } },
      polling: {
        isActive: () => starts.length > 0,
        start: (ctx: string) => { starts.push(ctx); }, stop: async () => {},
      },
    });
    const current = runtime.start("current");
    await started;
    await runtime.start("obsolete");
    release();
    await current;
    assert.deepEqual(starts, ["current"], boundary);
  }
});

test("Admission startup cannot resurrect a stopped or unauthorized poller after an await", async () => {
  for (const boundary of ["prepare", "worker"] as const) {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    let allowed = true;
    const runtime = createTelegramPollingAdmissionRuntime({
      canStart: () => allowed,
      prepareStart: () => boundary === "prepare" ? pending : undefined,
      worker: { onSessionStart: async () => { if (boundary === "worker") await pending; } },
      polling: { isActive: () => false, start: () => { starts++; }, stop: async () => {} },
    });
    const start = runtime.start(TEST_CONTEXT);
    await Promise.resolve();
    await runtime.stop();
    release();
    await start;
    assert.equal(starts, 0);
    allowed = false;
    await runtime.start(TEST_CONTEXT);
    assert.equal(starts, 0);
    allowed = true;
    await runtime.start(TEST_CONTEXT);
    assert.equal(starts, 1);
  }
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
    "sleep:1000",
    "reset",
  ]);
  assert.deepEqual(runtimeEvents, ["polling:network down:loop"]);
});

test("Poll loop caps retry delay but recovers after a prolonged outage without reconnect", async () => {
  const sleeps: number[] = [];
  const responses: number[] = [];
  let calls = 0;
  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config: { botToken: "123:abc" },
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls++;
      if (calls <= 12) throw new Error("network down");
      if (calls === 13) return [];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: () => {},
    onStatusReset: () => {},
    onSuccessfulResponse: (count) => { responses.push(count); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(calls, 14);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000, 16_000, ...Array(7).fill(30_000)]);
  assert.deepEqual(responses, [0], "The existing poller must recover without a new start");
});

test("Poll loop resets backoff after successful durable admission", async () => {
  const config = { botToken: "123:abc", lastUpdateId: 1 };
  const sleeps: number[] = [];
  let calls = 0;
  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config,
    ...NOOP_JOURNAL_ADMISSION,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls += 1;
      if (calls === 1 || calls === 3) throw new Error("network down");
      if (calls === 2) return [];
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {},
    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("Polling retry delay saturates and never becomes non-finite", () => {
  assert.equal(getTelegramPollingRetryDelayMs(1), 1_000);
  assert.equal(getTelegramPollingRetryDelayMs(5), 16_000);
  assert.equal(getTelegramPollingRetryDelayMs(6), 30_000);
  assert.equal(getTelegramPollingRetryDelayMs(1_000), 30_000);
});

test("Successful HTTP responses do not reset backoff while durable admission fails", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  let admissions = 0;
  await runTelegramPollLoop({
    ctx: TEST_CONTEXT,
    signal: new AbortController().signal,
    config: { botToken: "123:abc" },
    ...NOOP_JOURNAL_ADMISSION,
    appendUpdateBatch: () => {
      admissions++;
      if (admissions <= 2) throw new Error("journal unavailable");
    },
    deleteWebhook: async () => {},
    getUpdates: async () => {
      calls++;
      if (calls === 5) throw new DOMException("stop", "AbortError");
      return [{ update_id: calls + 1 }];
    },
    persistConfig: async () => {},
    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(admissions, 4);
  assert.deepEqual(sleeps, [1_000, 2_000]);
});
