/**
 * Test-only minimal-quit probes registered by integration.test.ts. No production wiring.
 * Zones: telegram, pi agent
 * PASS cases demonstrate bounded compositions, not live Pi exit. GAP cases assert
 * existing counterexamples: a green test run does NOT mean those requirements pass.
 * All journals/IPC endpoints are disposable; Telegram effects and Pi shutdown are spies.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import * as Activity from "../../lib/activity.ts";
import * as Bindings from "../../lib/bindings.ts";
import * as Bus from "../../lib/bus.ts";
import * as BusFollower from "../../lib/bus-follower.ts";
import * as BusLeader from "../../lib/bus-leader.ts";
import * as Journal from "../../lib/journal.ts";
import * as Media from "../../lib/media.ts";
import * as Ownership from "../../lib/ownership.ts";
import * as Pi from "../../lib/pi.ts";
import * as Queue from "../../lib/queue.ts";
import * as Quit from "../../lib/quit.ts";
import * as Runtime from "../../lib/runtime.ts";
import * as Routing from "../../lib/routing.ts";
import * as Sync from "../../lib/sync.ts";
import * as TelegramApi from "../../lib/telegram-api.ts";
import * as TextGroups from "../../lib/text-groups.ts";
import * as Threads from "../../lib/threads.ts";
import * as Updates from "../../lib/updates.ts";

const confirmationId = 41;
const target = { chatId: 7, threadId: 11 };
const protocol = Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "offline-quit-fixture",
  capabilities: [Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION] });
const noop = () => {};
const asyncNoop = async () => {};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("offline fixture condition did not settle");
    await sleep(5);
  }
}
function fixtureDirectory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-quit-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function makeJournal(dir: string, name: string, getNowMs = Date.now) {
  return Journal.createTelegramUpdateJournalStore({ path: join(dir, `${name}.json`), getNowMs,
    botIdentity: Journal.createTelegramUpdateJournalBotIdentity({ botToken: "42:offline-not-a-bot-token" }) });
}
function queuedPrompt(): Queue.PendingTelegramTurn {
  return { kind: "prompt", chatId: 7, target, replyToMessageId: 51, queueOrder: 1,
    queueLane: "default", laneOrder: 1, statusSummary: "fixture", sourceMessageIds: [51],
    content: [{ type: "text", text: "retained work" }], historyText: "retained work", queuedAttachments: [] };
}

/** Proposed projection lives ONLY in the test, using real owner queries where available.
 * Known-empty grouped inputs/publications are fixture preconditions, not production observations.
 * Follower membership/compatibility are injected facts; this is not a registration/election proof.
 */
function fixture(t: TestContext, role: "leader" | "follower" = "follower", cleanup = false) {
  const dir = fixtureDirectory(t);
  const journal = makeJournal(dir, "local");
  const bridge = Runtime.createTelegramBridgeRuntime();
  const queue = Queue.createTelegramQueueStore<Pi.ExtensionContext>();
  const apiActivity = TelegramApi.createTelegramApiTargetActivityRuntime();
  const scope: Quit.TelegramQuitScope = { profileKey: "fixture-profile/token-generation-1", botId: 42,
    ownerUserId: 7, ...target, instanceId: "fixture-pi", processBirthId: "fixture-birth",
    sessionId: "fixture-session", sessionGeneration: 1, transportGeneration: "epoch-1/registration-1" };
  const state = { idle: true, piMessages: false, cleanup, deleteOnly: false, survivors: role === "leader" ? 0 : 1,
    enforceV1Policy: true, grouped: "clear" as "clear" | "unknown", ackOk: true,
    groupedPending: () => false, publicationPending: () => false, sourcePending: () => false,
    ack: undefined as undefined | Promise<boolean> };
  const events: string[] = [];
  const consent: Quit.TelegramQuitCleanupConsent[] = [];
  const ctx = { isIdle: () => state.idle, hasPendingMessages: () => state.piMessages,
    shutdown: () => { events.push("shutdown"); } } as Pi.ExtensionContext;
  const gate = Quit.createTelegramQuitAdmissionGate(scope);
  const readSnapshot = (): Quit.TelegramQuitSnapshot => ({ scope, automaticCleanup: state.deleteOnly || state.cleanup,
    quiescence: {
      agent: !Pi.isExtensionContextIdle(ctx) || bridge.lifecycle.getActiveToolExecutions() > 0 ? "busy" : "clear",
      piMessages: Pi.hasExtensionContextPendingMessages(ctx) ? "busy" : "clear",
      telegramQueue: queue.getQueuedItems().length > 0 ? "busy" : "clear",
      dispatch: bridge.lifecycle.hasDispatchPending() ? "busy" : "clear",
      compaction: bridge.lifecycle.isCompactionInProgress() ? "busy" : "clear",
      groupedInput: state.grouped === "unknown" ? "unknown" : state.groupedPending() ? "busy" : "clear",
      acceptedInput: journal.read().entries.some((entry) => entry.updateId !== confirmationId) || state.sourcePending() ? "busy" : "clear",
      delivery: apiActivity.hasPendingTarget(target) || state.publicationPending() ? "busy" : "clear",
    },
    transport: { role, cohortKey: `fixture-cohort/${state.survivors}`, survivorCount: state.survivors,
      quitSupported: !(state.enforceV1Policy && role === "leader" && state.survivors > 0),
      failoverReady: true },
  });
  const quit = Quit.createTelegramQuitFoundation({ gate, readSnapshot,
    refresh: async (fence) => { fence.assertCurrent(); },
    acknowledge: async (_confirmation, fence) => {
      fence.assertCurrent(); events.push("ack");
      return state.ack ? await state.ack : state.ackOk;
    },
    shutdown: (captured) => {
      assert.equal(journal.read().entries.length, 0, "local confirmation must already be durably removed");
      consent.push(captured); ctx.shutdown();
    },
  });
  t.after(() => quit.dispose());
  const source = { scope, actorUserId: 7, messageId: 15 };
  function offer() {
    const offered = quit.prepare(source);
    assert.equal(offered.ok, true, JSON.stringify(offered));
    if (!offered.ok) throw new Error("fixture offer refused");
    return { ...source, token: offered.confirmation.token, updateId: confirmationId };
  }
  const owner = Updates.createTelegramUpdateWorkerOwnerRuntime({ instanceId: scope.instanceId,
    processId: process.pid, processBirthId: scope.processBirthId, getSessionGeneration: () => 1,
    isContextCurrent: (current: Pi.ExtensionContext) => current === ctx,
    dispatchNext() { // This is proposed wiring, not a change to the production dispatcher.
      const release = gate.enter(scope);
      if (release) { events.push("dispatch"); release(); }
    },
    requestQueueHandoffReconciliation: noop,
    afterUpdateCompleted: (id) => { events.push(`completed:${id}`); quit.onUpdateCompleted(id, scope); },
  });
  async function runConfirmation(afterOffer?: () => void) {
    const input = offer(); afterOffer?.();
    const worker = Updates.createTelegramUpdateWorkerRuntime({ journal, hasAuthority: () => true,
      executeUpdate: async (update) => {
        if (update.update_id !== confirmationId) return { kind: "deferred" };
        const result = await quit.confirm(input); events.push(`confirm:${result.ok}`);
        return { kind: "complete" };
      },
      onUpdateCompleted: owner.onUpdateCompleted,
    });
    journal.appendBatch([{ update_id: confirmationId }]);
    worker.start(ctx);
    try { await worker.waitForDrain(); await tick(); }
    finally { await worker.stop(); }
    return input;
  }
  return { dir, journal, bridge, queue, apiActivity, scope, state, events, consent, ctx, gate,
    quit, source, offer, owner, runConfirmation, readSnapshot };
}

/** Existing registered shutdown hook, with fake peripheral services/effects.
 * We deliberately retain its production live-setting resolver, not a consent-aware replacement.
 */
function existingShutdownHook(h: ReturnType<typeof fixture>, resolveCleanup: () => boolean | Promise<boolean> = () => h.state.cleanup) {
  type Handler = (event: unknown, ctx: Pi.ExtensionContext) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  Bindings.registerTelegramLifecycleRuntimeHooks({
    pi: { on: (name: string, handler: Handler) => handlers.set(name, handler) },
    publicationRuntime: { ...Activity.createTelegramActivityPublicationRuntime(),
      capture: () => ({ target, isCurrent: () => true }) },
    activityRuntime: { onSessionShutdown: noop }, assistantOutputRuntime: { stop: noop },
    sessionLifecycleRuntime: { onSessionShutdown: async () => { h.events.push("teardown"); } },
    configStore: { get: () => ({}), getOutboundHandlers: () => [] },
    abort: h.bridge.abort, typing: h.bridge.typing, lifecycle: h.bridge.lifecycle,
    activeTurnRuntime: { clear: noop, has: () => false, get: () => undefined }, telegramQueueStore: h.queue,
    modelSwitchController: { clearPendingSwitch: noop, triggerPendingAbort: noop },
    previewRuntime: { onMessageStart: asyncNoop, onMessageUpdate: asyncNoop },
    promptDispatchRuntime: { startTypingLoop: noop }, deferredQueueDispatchRuntime: { request: noop },
    modelContextAvailabilityRuntime: { reconcile: noop },
    resolveAutomaticThreadCleanupEnabled: resolveCleanup,
    disconnectOnQuit: async () => { h.events.push("delete-thread-spy"); },
    buttonActionStore: { register: () => "fixture" },
    callMultipart: asyncNoop, sendChatAction: asyncNoop, sendRecordVoiceAction: asyncNoop,
    sendMarkdownReply: asyncNoop, sendTextReply: asyncNoop, editInteractiveMessage: asyncNoop,
    deleteMessage: asyncNoop, dispatchNextQueuedTelegramTurn: noop, answerGuestQuery: asyncNoop,
    sendGuestReply: asyncNoop, finalizeMarkdownPreview: asyncNoop,
    canSendAgentActivity: () => false, isSessionContextActive: (ctx: Pi.ExtensionContext) => ctx === h.ctx,
    updateStatus: noop, recordRuntimeEvent: noop,
  } as unknown as Parameters<typeof Bindings.registerTelegramLifecycleRuntimeHooks>[0]);
  const shutdown = handlers.get("session_shutdown")!;
  assert.ok(shutdown);
  return () => shutdown({ type: "session_shutdown", reason: "quit" }, h.ctx);
}

export function registerQuitFeasibilityTests(
  test: (name: string, body: (context: TestContext) => void | Promise<void>) => void,
): void {
for (const role of ["leader", "follower"] as const) {
  for (const cleanup of [false, true]) {
    test(`PASS bounded composition: idle ${role}, cleanup=${cleanup}, local durable settlement then shutdown spy`, async (t) => {
      const h = fixture(t, role, cleanup);
      const shutdownHook = existingShutdownHook(h);
      const input = await h.runConfirmation();
      assert.equal(h.consent.length, 1);
      assert.equal(h.consent[0]?.automaticCleanup, cleanup);
      assert.ok(h.events.indexOf("ack") < h.events.indexOf(`completed:${confirmationId}`));
      assert.ok(h.events.indexOf(`completed:${confirmationId}`) < h.events.indexOf("shutdown"));
      await shutdownHook();
      assert.equal(h.events.includes("delete-thread-spy"), cleanup);
      assert.equal((await h.quit.confirm(input)).ok, false);
      h.owner.onUpdateCompleted(confirmationId, h.ctx); await tick();
      assert.equal(h.consent.length, 1);
    });
  }
}

test("PASS proposed v1 policy: shared owner refuses; Q1 alone still allows its originally approved wider policy", (t) => {
  const h = fixture(t, "leader"); h.state.survivors = 1;
  assert.deepEqual(h.quit.prepare(h.source), { ok: false, reason: "unsupported" });
  assert.equal(h.gate.getPhase(), "open");
  h.state.enforceV1Policy = false;
  assert.equal(h.quit.prepare(h.source).ok, true, "v1 restriction needs explicit wiring; it is not in Q1");
  assert.equal(h.consent.length, 0);
});

test("PASS unknown membership refuses rather than treating it as a last instance", (t) => {
  const h = fixture(t, "leader"); h.state.survivors = Number.NaN;
  assert.deepEqual(h.quit.prepare(h.source), { ok: false, reason: "unknown" });
  assert.equal(h.consent.length, 0);
});

for (const busy of ["agent", "tools", "pi-messages", "queue", "skipped-queue", "dispatch", "compaction", "accepted-input", "delivery"] as const) {
  test(`PASS real owner observation: ${busy} appearing after offer refuses without clearing work`, async (t) => {
    const h = fixture(t);
    let release = noop;
    await h.runConfirmation(() => {
      switch (busy) {
        case "agent": h.state.idle = false; break;
        case "tools": h.bridge.lifecycle.setActiveToolExecutions(1); break;
        case "pi-messages": h.state.piMessages = true; break;
        case "queue": h.queue.setQueuedItems([queuedPrompt()]); break;
        case "skipped-queue": h.queue.setQueuedItems([{ ...queuedPrompt(), reactionSuppressionEmoji: "👎" }]); break;
        case "dispatch": h.bridge.lifecycle.setDispatchPending(true); break;
        case "compaction": h.bridge.lifecycle.setCompactionInProgress(true); break;
        case "accepted-input": h.journal.appendBatch([{ update_id: 42 }]); break;
        case "delivery": release = h.apiActivity.begin("sendMessage", { chat_id: 7, message_thread_id: 11 }); break;
      }
    });
    release();
    assert.equal(h.consent.length, 0);
    assert.equal(h.gate.getPhase(), "open");
    assert.equal(h.events.includes("ack"), false);
    if (busy.endsWith("queue")) assert.equal(h.queue.getQueuedItems().length, 1);
    if (busy === "accepted-input") assert.deepEqual(h.journal.read().entries.map((entry) => entry.updateId), [42]);
  });
}

test("PASS pending input during awaited acknowledgement cancels quit and retains source", async (t) => {
  const h = fixture(t), ack = deferred<boolean>(); h.state.ack = ack.promise;
  const input = h.offer(), confirming = h.quit.confirm(input);
  await until(() => h.events.includes("ack"));
  h.journal.appendBatch([{ update_id: 52 }]);
  ack.resolve(true);
  assert.deepEqual(await confirming, { ok: false, reason: "busy" });
  assert.equal(h.consent.length, 0);
  assert.deepEqual(h.journal.read().entries.map((entry) => entry.updateId), [52]);
});

test("PASS acknowledgement failure and missing completion never request shutdown", async (t) => {
  const h = fixture(t); h.state.ackOk = false;
  await h.runConfirmation(); assert.equal(h.consent.length, 0);
  const other = fixture(t);
  assert.deepEqual(await other.quit.confirm(other.offer()), { ok: true });
  await tick(); assert.equal(other.consent.length, 0);
});

for (const kind of ["media", "text"] as const) {
  test(`GAP observation: real pending ${kind} group is invisible to queue/API-only readiness`, async (t) => {
    const h = fixture(t, "leader");
    let dispatches = 0;
    const message = { message_id: 51, chat: { id: 7 }, message_thread_id: 11,
      from: { id: 7, is_bot: false }, text: "x".repeat(4090), media_group_id: "fixture-album" };
    // No automatic timer can dispatch fixture input; flush below is explicit.
    const timers = { setTimer: () => ({ unref: noop }) as ReturnType<typeof setTimeout>, clearTimer: noop };
    const group = kind === "media" ? Media.createTelegramMediaGroupController<typeof message, Pi.ExtensionContext>(timers)
      : TextGroups.createTelegramTextGroupController<typeof message, Pi.ExtensionContext>(timers);
    const input = kind === "media" ? message : { ...message, media_group_id: undefined };
    assert.equal(group.queueMessage({ message: input as typeof message, context: h.ctx,
      dispatchMessages: async () => { dispatches++; } }), true);
    t.after(() => group.clear());
    assert.equal(h.queue.getQueuedItems().length, 0);
    assert.equal(h.apiActivity.hasPendingTarget(target), false);
    h.state.grouped = "unknown";
    assert.deepEqual(h.quit.prepare(h.source), { ok: false, reason: "unknown" });
    // A naive 'clear' default really would allow shutdown with buffered input still present.
    h.state.grouped = "clear"; await h.runConfirmation();
    assert.equal(h.consent.length, 1);
    assert.equal(dispatches, 0);
    await group.flushMessage(message.message_id);
    assert.equal(dispatches, 1);
    t.diagnostic("FEASIBILITY GAP: add an owner query for buffered/in-flight groups; unknown correctly refuses.");
  });
}

for (const kind of ["media", "text", "publication"] as const) {
  test(`PASS local pending observer: ${kind} blocks quit until its owner reports clear`, async (t) => {
    const h = fixture(t, "leader");
    const timers = { setTimer: () => ({ unref: noop }) as ReturnType<typeof setTimeout>, clearTimer: noop };
    const media = Media.createTelegramMediaGroupController(timers);
    const text = TextGroups.createTelegramTextGroupController(timers);
    const publication = Activity.createTelegramActivityPublicationRuntime();
    h.state.groupedPending = () => media.hasPendingWork() || text.hasPendingWork();
    h.state.publicationPending = publication.hasPendingWork;
    t.after(() => { media.clear(); text.clear(); publication.reset(); });
    const message = { message_id: 51, chat: { id: 7 }, from: { id: 7, is_bot: false }, text: "x".repeat(4090) };
    if (kind === "publication") publication.reserve();
    else if (kind === "media") media.queueMessage({ message: { ...message, media_group_id: "album" }, dispatchMessages: asyncNoop });
    else text.queueMessage({ message, context: h.ctx, dispatchMessages: asyncNoop });
    assert.deepEqual(h.quit.prepare(h.source), { ok: false, reason: "busy" });
    assert.equal(h.consent.length, 0);
    // Explicit fixture cancellation is separate from quit; no quit path clears work.
    media.clear(); text.clear(); publication.reset();
    await h.runConfirmation(); assert.equal(h.consent.length, 1);
  });
}

test("GAP observation: queued final publication can exist while target API activity is clear", async (t) => {
  const h = fixture(t, "leader"), publication = Activity.createTelegramActivityPublicationRuntime();
  const blocker = publication.reserve(); t.after(() => publication.reset());
  let sent = false;
  const waiting = publication.enqueue(async () => {
    const end = h.apiActivity.begin("sendMessage", { chat_id: 7, message_thread_id: 11 });
    sent = true; end();
  });
  await tick(); assert.equal(sent, false);
  assert.equal(h.apiActivity.hasPendingTarget(target), false);
  await h.runConfirmation(); assert.equal(h.consent.length, 1);
  blocker.cancel(); await waiting;
  assert.equal(sent, true, "accepted publication was queued before the shutdown decision");
  t.diagnostic("FEASIBILITY GAP: publication reservations must participate in pending-output evidence.");
});

for (const cleanup of [false, true]) {
  test(`GAP cleanup: registered shutdown hook rereads policy after consent=${cleanup}`, async (t) => {
    const h = fixture(t, "leader", cleanup), shutdownHook = existingShutdownHook(h);
    await h.runConfirmation();
    h.state.cleanup = !cleanup;
    await shutdownHook();
    assert.equal(h.consent[0]?.automaticCleanup, cleanup);
    assert.equal(h.events.includes("delete-thread-spy"), !cleanup, "existing hook uses changed settings, not committed consent");
    t.diagnostic("FEASIBILITY GAP: bind the cleanup resolver to exact committed quit consent; preserve terminal quit fallback.");
  });
}

for (const cleanup of [false, true]) {
  test(`PASS test-only resolver wiring: committed cleanup=${cleanup} wins over later settings`, async (t) => {
    const h = fixture(t, "leader", cleanup);
    const shutdownHook = existingShutdownHook(h,
      () => h.quit.resolveAutomaticThreadCleanupEnabled(h.scope, () => h.state.cleanup));
    await h.runConfirmation(); h.state.cleanup = !cleanup;
    await shutdownHook();
    assert.equal(h.events.includes("delete-thread-spy"), cleanup);
    assert.equal(h.consent.length, 1);
  });
}

test("PASS cleanup: settings changing before the decision cancel instead of widening consent", async (t) => {
  const h = fixture(t, "leader", false), ack = deferred<boolean>(); h.state.ack = ack.promise;
  const confirming = h.quit.confirm(h.offer()); await until(() => h.events.includes("ack"));
  h.state.cleanup = true; ack.resolve(true);
  assert.deepEqual(await confirming, { ok: false, reason: "changed" });
  assert.equal(h.consent.length, 0);
});

test("PASS local consent resolver feeds preserved-leader teardown after settings change", async (t) => {
  const h = fixture(t, "leader", false); await h.runConfirmation();
  let detached = false;
  const preserve = Sync.createTelegramPreservedLeaderQuitHandler({ instanceId: h.scope.instanceId,
    getCurrentLeaderEpoch: () => 1, getProfileName: () => "fixture", isPollingSuspended: () => true,
    resolveAutomaticThreadCleanupEnabled: () => h.quit.resolveAutomaticThreadCleanupEnabled(h.scope, () => h.state.cleanup),
    runWorkspaceOperation: async (_input: unknown, operation: () => Promise<void>) => operation(),
    topicTargetStore: { load: asyncNoop,
      list: () => [{ instanceId: h.scope.instanceId, target, status: "active" }],
      listPendingCleanups: () => [], detachTargetOwner: async () => { detached = true; return true; } },
  } as unknown as Parameters<typeof Sync.createTelegramPreservedLeaderQuitHandler>[0])(() => true)!;
  h.state.cleanup = true; await preserve();
  assert.equal(detached, true);
});

test("PASS missing committed local consent skips deletion rather than falling back to settings", async (t) => {
  const h = fixture(t, "leader", false);
  const shutdownHook = existingShutdownHook(h,
    () => h.quit.resolveAutomaticThreadCleanupEnabled(h.scope, () => h.state.cleanup));
  await h.runConfirmation(); h.quit.dispose(); h.state.cleanup = true;
  await shutdownHook();
  assert.equal(h.events.includes("delete-thread-spy"), false);
  assert.equal(h.events.includes("teardown"), true);
});

test("GAP cleanup: preserved-leader hook independently rereads policy", async (t) => {
  const h = fixture(t, "leader", false); await h.runConfirmation();
  let detached = false;
  const preserve = Sync.createTelegramPreservedLeaderQuitHandler({ instanceId: h.scope.instanceId,
    getCurrentLeaderEpoch: () => 1, getProfileName: () => "fixture", isPollingSuspended: () => true,
    resolveAutomaticThreadCleanupEnabled: () => h.state.cleanup,
    runWorkspaceOperation: async (_input: unknown, operation: () => Promise<void>) => operation(),
    topicTargetStore: { load: asyncNoop,
      list: () => [{ instanceId: h.scope.instanceId, target, status: "active" }],
      listPendingCleanups: () => [], detachTargetOwner: async () => { detached = true; return true; } },
  } as unknown as Parameters<typeof Sync.createTelegramPreservedLeaderQuitHandler>[0])(() => true)!;
  h.state.cleanup = true; await preserve();
  assert.equal(detached, false);
  assert.equal(h.consent[0]?.automaticCleanup, false);
  t.diagnostic("FEASIBILITY GAP: preservation must consume the same policy snapshot as deletion.");
});

for (const flip of [false, true]) {
  test(`${flip ? "GAP" : "PASS bounded"} follower cleanup OFF: leader prune ${flip ? "rereads changed" : "uses unchanged"} policy`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = fixture(t, "follower", false); await h.runConfirmation();
    const registry = Bus.createTelegramBusFollowerRegistry();
    registry.register({ instanceId: h.scope.instanceId, profileKey: "manual:fixture", pid: 12345,
      registrationGeneration: "fixture-reg", connectedAtMs: 0, target, protocol });
    let deletes = 0, preserves = 0;
    const leader = BusLeader.createTelegramBusLeaderRuntime({ socketPath: join(h.dir, "prune.sock"),
      followerRegistry: registry, protocolIdentity: protocol, getNowMs: () => 1000,
      getCurrentLeaderEpoch: () => 1, followerStaleAfterMs: 100,
      // No real PID is inspected or signalled. Death is a fixture input.
      isFollowerProcessAlive: () => false,
      shouldCleanupConfirmedDeadFollower: () => h.state.cleanup,
      onFollowerConfirmedDead: () => { deletes++; },
      onFollowerConfirmedDeadPreserved: () => { preserves++; return true; },
      startPolling: noop, stopPolling: noop,
    });
    try {
      h.state.cleanup = flip;
      await leader.startPolling("fixture-context");
      t.mock.timers.tick(1000);
      await until(() => deletes + preserves > 0);
      assert.equal(deletes, flip ? 1 : 0); assert.equal(preserves, flip ? 0 : 1);
      assert.equal(h.consent[0]?.automaticCleanup, false);
      if (flip) t.diagnostic("FEASIBILITY GAP: follower-local consent is not conveyed to later leader pruning.");
    } finally { await leader.stopPolling(); }
  });
}

/** Authenticated real local IPC + real durable follower journal. No TCP/Telegram transport. */
async function forwardingFixture(t: TestContext) {
  const h = fixture(t), receiverPath = join(h.dir, "receiver.sock"), proxyPath = join(h.dir, "proxy.sock");
  const generation = "registration-1";
  let dropAck = false, sequence = 0, now = 1000;
  let onAdmitted = noop;
  let admissionGate: Quit.TelegramQuitAdmissionGate | undefined;
  const admission = BusFollower.createTelegramBusFollowerDurableAdmissionRuntime<Pi.ExtensionContext>({
    journal: h.journal, signalWorker: () => onAdmitted(),
  });
  const receiver = BusFollower.createTelegramBusForwardedUpdateReceiverRuntime({ socketPath: receiverPath,
    instanceId: h.scope.instanceId, getAuthSecret: () => "fixture-auth", getRegistrationGeneration: () => generation,
    getRecipientBindingKey: () => "manual:fixture", getContext: () => h.ctx,
    durableAdmission: { async admit(envelope, ctx) {
      if (!admissionGate) return admission.admit(envelope, ctx);
      const release = admissionGate.enter(h.scope);
      if (!release) throw new Error("fixture recipient closing");
      try { return await admission.admit(envelope, ctx); } finally { release(); }
    } },
  });
  const proxy = Bus.createTelegramBusLocalServer({ socketPath: proxyPath,
    handleEnvelope: (envelope) => Bus.sendTelegramBusLocalEnvelope({ socketPath: receiverPath, envelope }),
    shouldDropResponse: () => dropAck,
  });
  const forwarder = Bus.createTelegramBusForeignOwnedUpdateForwarder<Pi.ExtensionContext, Updates.TelegramMessageReactionUpdated,
    Updates.TelegramCallbackQuery, Updates.TelegramUpdateMessage>({ socketPath: proxyPath,
    createRequestId: () => `fixture-request:${++sequence}`, getAuthSecret: () => "fixture-auth", timeoutMs: 100 });
  const ownership = () => ({ instanceId: h.scope.instanceId, ownerGeneration: generation,
    recipientBindingKey: "manual:fixture", protocolIdentity: protocol });
  const leaderJournal = makeJournal(h.dir, "leader", () => now);
  await receiver.start();
  const close = async () => { await proxy.stop(); await receiver.stop(); };
  t.after(close);
  await proxy.start();
  return { h, leaderJournal, forwarder, ownership, close,
    setDrop: (value: boolean) => { dropAck = value; },
    setAdmissionGate: (gate: Quit.TelegramQuitAdmissionGate) => { admissionGate = gate; },
    setSignal: (signal: () => void) => { onAdmitted = signal; },
    getNow: () => now, setNow: (value: number) => { now = value; } };
}

for (const automaticCleanup of [false, true]) {
  test(`DELETE-ONLY explicit confirmation requests deletion with automatic cleanup=${automaticCleanup}`, async (t) => {
    const h = fixture(t, "follower", automaticCleanup); h.state.deleteOnly = true;
    const resolve = () => h.quit.resolveAutomaticThreadCleanupEnabled(h.scope, () => h.state.cleanup);
    assert.equal(await resolve(), automaticCleanup, "ordinary terminal quit still uses settings before any confirmed operation");
    await h.runConfirmation(() => { h.state.cleanup = !automaticCleanup; });
    h.state.cleanup = false;
    await existingShutdownHook(h, resolve)();
    assert.equal(h.consent.length, 1);
    assert.equal(h.consent[0]?.automaticCleanup, true);
    assert.equal(h.events.filter((event) => event === "delete-thread-spy").length, 1);
    t.diagnostic("The test-only v1 projection captures explicit deletion rather than a settings-dependent choice. No command is registered.");
  });
}

for (const outcome of ["deleted", "delete-failed", "ack-lost", "busy-after-delete", "protected-replacement", "persist-failed", "epoch-lost"] as const) {
  test(`DELETE-ONLY existing follower disconnect: ${outcome}`, async (t) => {
    const h = fixture(t), path = join(h.dir, "delete-state.json"), socketPath = join(h.dir, "delete.sock");
    const store = Threads.createTelegramTopicTargetStore({ path, getNowMs: () => 2000 });
    const registry = Bus.createTelegramBusFollowerRegistry();
    for (const [instanceId, threadId] of [[h.scope.instanceId, 11], ["other-pi", 12]] as const) {
      registry.register({ instanceId, profileKey: `manual:${instanceId}`, registrationGeneration: `${instanceId}:1`,
        connectedAtMs: 1000, target: { chatId: 7, threadId }, protocol });
      store.upsert({ profileKey: `manual:${instanceId}`, instanceId,
        owner: { kind: "manual-follower", instanceId }, target: { chatId: 7, threadId },
        status: "active", createdAtMs: 1000, updatedAtMs: 1000 });
    }
    await store.persist();
    const methods: string[] = [];
    let persists = 0, epoch = 1;
    const disconnect = BusLeader.createTelegramBusFollowerDisconnectHandler({ topicTargetStore: { ...store,
      async persist() {
        if (++persists === 2 && outcome === "persist-failed") throw new Error("fixture final persistence failed");
        await store.persist();
      } },
      getCurrentLeaderEpoch: () => epoch, getSyncState: () => ({}), setSyncState: noop,
      recordRuntimeEvent: noop, getNowMs: () => 2000,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        assert.equal(body.chat_id, 7); assert.equal(body.message_thread_id, 11);
        methods.push(method); h.events.push(`cleanup:${method}`);
        if (outcome === "delete-failed" && method === "deleteForumTopic") throw new Error("fixture deletion failed");
        if (outcome === "busy-after-delete" && method === "deleteForumTopic") h.state.idle = false;
        if (outcome === "epoch-lost" && method === "deleteForumTopic") epoch++;
        if (outcome === "protected-replacement" && method === "closeForumTopic") {
          store.upsert({ profileKey: "manual:replacement", instanceId: "replacement", target,
            status: "active", createdAtMs: Date.now(), updatedAtMs: Date.now() });
        }
        return { ok: true } as TResponse;
      } });
    const server = Bus.createTelegramBusLocalServer({ socketPath,
      shouldDropResponse: () => outcome === "ack-lost",
      handleEnvelope: BusLeader.createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry,
        authSecret: "fixture-delete-secret", protocolIdentity: protocol, getCurrentLeaderEpoch: () => epoch,
        onFollowerDisconnected: disconnect }) });
    // Committed user consent is an injected prerequisite here, not a new confirmation/wire protocol.
    const consent: Quit.TelegramQuitCleanupConsent = Object.freeze({
      scope: Object.freeze({ ...h.scope, transportGeneration: `epoch-1/${h.scope.instanceId}:1` }),
      operationId: "fixture-delete", updateId: confirmationId, automaticCleanup: true });
    const exit = Quit.createTelegramQuitAfterDeletion({ consent, getCleanupConsent: () => consent,
      readExitSnapshot: () => ({ identity: h.scope, connection: registry.get(h.scope.instanceId) ? "connected" : "disconnected",
        quiescence: { agent: h.state.idle ? "clear" : "busy", piMessages: "clear", telegramQueue: "clear",
          dispatch: "clear", compaction: "clear", groupedInput: "clear", acceptedInput: "clear", delivery: "clear" } }),
      shutdown: h.ctx.shutdown });
    await server.start();
    try {
      const response = await Bus.sendTelegramBusLocalEnvelope({ socketPath, timeoutMs: 200,
        envelope: { kind: "follower.disconnect", requestId: "fixture-delete", auth: "fixture-delete-secret",
          instanceId: h.scope.instanceId, registrationGeneration: `${h.scope.instanceId}:1`, sentAtMs: 2000 },
      }).catch(() => undefined);
      const acknowledged = response?.kind === "bus.ack" && response.ok === true;
      assert.equal(acknowledged, outcome === "deleted" || outcome === "busy-after-delete" || outcome === "protected-replacement");
      const confirmed = Bus.isTelegramBusFollowerDisconnectDeletionConfirmed(response, {
        requestId: consent.operationId, instanceId: h.scope.instanceId,
        registrationGeneration: `${h.scope.instanceId}:1`, target });
      assert.equal(confirmed, outcome === "deleted" || outcome === "busy-after-delete");
      assert.deepEqual(methods, outcome === "protected-replacement" ? ["closeForumTopic"] : ["closeForumTopic", "deleteForumTopic"]);
      const reopened = Threads.createTelegramTopicTargetStore({ path, getNowMs: () => 2000 });
      await reopened.load();
      const failed = outcome === "delete-failed" || outcome === "persist-failed" || outcome === "epoch-lost";
      assert.equal(reopened.listSyncObservations().some((entry) => entry.target.threadId === 11 && entry.syncStatus === "deleted"), !failed && outcome !== "protected-replacement");
      assert.equal(reopened.listPendingCleanups().length, failed || outcome === "protected-replacement" ? 1 : 0);
      assert.equal(!!registry.get(h.scope.instanceId), failed);
      assert.equal(registry.get("other-pi")?.target?.threadId, 12);
      assert.equal(reopened.getActiveByInstanceId("other-pi")?.target.threadId, 12);
      assert.equal(h.consent.length, 0, "disconnect itself does not ask Pi to shut down");
      const deletion = { scope: consent.scope, operationId: consent.operationId, confirmed };
      const result = exit.finish(deletion);
      assert.deepEqual(result, outcome === "deleted" ? { status: "shutdown-requested" }
        : { status: "left-running", reason: outcome === "busy-after-delete" ? "busy" : "cleanup-unconfirmed" });
      h.state.idle = true; await tick();
      assert.deepEqual(exit.finish(deletion), result, "later idle cannot turn cleanup into a delayed quit");
      assert.equal(h.events.filter((event) => event === "shutdown").length, outcome === "deleted" ? 1 : 0);
      if (outcome === "deleted") assert.ok(h.events.indexOf("cleanup:deleteForumTopic") < h.events.indexOf("shutdown"));
    } finally { await server.stop(); }
    t.diagnostic("Existing authenticated disconnect/reconciler precedes the real post-deletion decision with an injected committed consent and shutdown spy. Busy after cleanup stays running; failed/lost ACK never requests exit. No live deletion, complete confirmation/ingress handshake or real Pi exit is proved.");
  });
}

for (const interrupted of [false, true]) {
test(`DELETE-ONLY resolved: deleted-source settlement ${interrupted ? "after owner replacement" : "before cached successor delegation"}`, async (t) => {
  const h = fixture(t), store = Threads.createTelegramTopicTargetStore({ path: join(h.dir, "deleted-target.json") });
  store.upsert({ profileKey: "manual:stable", instanceId: "old-pi", target,
    status: "active", createdAtMs: Date.now(), updatedAtMs: Date.now() });
  store.markStaleByTarget(target, "deleted"); await store.persist();
  const old = { instanceId: "old-pi", profileKey: "manual:stable", registrationGeneration: "old:1",
    connectedAtMs: 1, target, protocol };
  let followers = [old];
  const ownership = Ownership.createTelegramBusMessageOwnershipRuntime({ instanceId: "leader",
    getProfileKey: () => "fixture-profile", listFollowers: () => followers });
  ownership.recordFollower({ chatId: 7, messageId: 52, target, follower: old });
  followers = [{ ...old, instanceId: "new-pi", registrationGeneration: "new:1", target: { chatId: 7, threadId: 12 } }];
  const forwarded: string[] = []; let deletionChecks = 0;
  const source = makeJournal(h.dir, "deleted-source");
  const processed = deferred<void>(), release = deferred<void>();
  const execute = (update: Journal.TelegramJournaledUpdate, signal: AbortSignal, currentStore = store) =>
    Updates.executeTelegramUpdate(update as Updates.TelegramUpdateFlow, 7, {
    ctx: h.ctx, getCurrentInstanceId: () => "leader", getMessageOwnership: ownership.getForwardOwnership,
    execution: { generation: 1, updateId: update.update_id, signal,
      isCurrent: () => !signal.aborted, assertCurrent: () => signal.throwIfAborted() },
    isTargetConfirmedDeleted: Routing.createTelegramDeletedTargetLookup({ threadStore: currentStore,
      getAdmissionScope: () => h.scope.profileKey, isContextActive: (ctx) => ctx === h.ctx }),
    getTargetOwnership: () => undefined,
    foreignOwnedUpdateForwarder: { forwardMessage: ({ ownership: recipient }) => {
      forwarded.push(recipient.instanceId);
      return { status: "accepted", delivery: Bus.createTelegramBusFollowerDeliveryIdentity({
        kind: "leader.forwardMessage", recipientBindingKey: "manual:stable", sourceUpdateId: 52 }) };
    } },
    handleUnboundTelegramTopicMessage: async () => {
      deletionChecks++;
      assert.equal(store.listSyncObservations().some((entry) => entry.syncStatus === "deleted" && entry.target.threadId === 11), true);
    },
    removePendingMediaGroupMessages: noop, removeQueuedTelegramTurnsByMessageIds: () => 0,
    handleAuthorizedTelegramReactionUpdate: asyncNoop, pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: asyncNoop, answerGuestQuery: asyncNoop, handleAuthorizedTelegramCallbackQuery: asyncNoop,
    sendTextReply: async () => undefined, handleAuthorizedTelegramMessage: asyncNoop, handleAuthorizedTelegramEditedMessage: asyncNoop,
  });
  const worker = Updates.createTelegramUpdateWorkerRuntime({ journal: source, hasAuthority: () => true,
    executeUpdate: async (update, _ctx, signal) => {
      await execute(update, signal);
      if (interrupted) { processed.resolve(); await release.promise; }
      return { kind: "complete" };
    } });
  source.appendBatch([{ update_id: 52, message: { message_id: 52,
    chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, message_thread_id: 11, text: "retained input" } }]);
  try {
    worker.start(h.ctx);
    if (interrupted) {
      await Promise.race([processed.promise, worker.waitForDrain().then(() => { throw new Error("fixture pause was not reached"); })]);
      const stopping = worker.stop(); release.resolve(); await stopping;
      assert.equal(source.read().entries.length, 1, "stopping before durable completion retains the source");
      const reopenedStore = Threads.createTelegramTopicTargetStore({ path: join(h.dir, "deleted-target.json") });
      const replacement = Updates.createTelegramUpdateWorkerRuntime({ journal: makeJournal(h.dir, "deleted-source"),
        hasAuthority: () => true, executeUpdate: async (update, _ctx, signal) => {
          await execute(update, signal, reopenedStore); return { kind: "complete" };
        } });
      try { replacement.start(h.ctx); await replacement.waitForDrain(); }
      finally { await replacement.stop(); }
    } else await worker.waitForDrain();
    assert.deepEqual(forwarded, []); assert.equal(deletionChecks, 0);
    assert.equal(makeJournal(h.dir, "deleted-source").read().entries.length, 0, "real source completion survives reopen");
  } finally { release.resolve(); await worker.stop(); }
  t.diagnostic("The production lookup prevents cached successor delegation and the existing source worker completes the deleted-target update, including replay against reopened stores after an interrupted completion. No new journal disposition or live Pi exit is implied.");
});
}

for (const outcome of ["delivered", "notice-failed", "owner-stopped"] as const) {
  test(`COORD source-owner closing disposition: ${outcome}`, async (t) => {
    const h = fixture(t), source = makeJournal(h.dir, "source");
    const notice = deferred<void>();
    let started = false, notifications = 0, otherThreadCalls = 0;
    const worker = Updates.createTelegramUpdateWorkerRuntime({ journal: source,
      hasAuthority: () => true, scheduleRetry: () => 0, cancelRetry: noop,
      executeUpdate: async (update, _ctx, signal) => {
        const assertCurrent = () => signal.throwIfAborted();
        assertCurrent();
        const addressed = Updates.getTelegramMessageTarget(update.message as Updates.TelegramUpdateMessage);
        if (addressed?.chatId !== target.chatId || addressed.threadId !== target.threadId) {
          otherThreadCalls++; return { kind: "complete" };
        }
        // Proposed SOURCE-OWNER branch, not a forwarding ACK. Exact closing
        // authority is an injected precondition here, not a proven bus handshake.
        started = true;
        if (outcome === "owner-stopped") await notice.promise;
        assertCurrent();
        if (outcome === "notice-failed") throw new Error("fixture notification failed");
        notifications++;
        return { kind: "complete" };
      },
    });
    source.appendBatch([
      { update_id: 51, message: { message_id: 51, chat: { id: 7, type: "private" },
        message_thread_id: 11, from: { id: 7, is_bot: false }, text: "late input" } },
      { update_id: 52, message: { message_id: 52, chat: { id: 7, type: "private" },
        message_thread_id: 12, from: { id: 7, is_bot: false }, text: "other Thread" } },
    ]);
    worker.start(h.ctx);
    try {
      if (outcome === "owner-stopped") {
        await until(() => started);
        const stopping = worker.stop(); notice.resolve(); await stopping;
        assert.equal(notifications, 0);
        assert.equal(source.read().entries.some((entry) => entry.updateId === 51), true);
      } else {
        await worker.waitForDrain();
        assert.equal(otherThreadCalls, 1, "a rejected target does not block the next independent Thread");
        assert.equal(notifications, outcome === "delivered" ? 1 : 0);
        assert.deepEqual(source.read().entries.map((entry) => [entry.updateId, entry.state]),
          outcome === "delivered" ? [] : [[51, "retry-wait"]]);
      }
      assert.equal(h.journal.read().entries.length, 0, "closing input never enters recipient custody");
      assert.equal(h.consent.length, 0, "this probe does not request Pi shutdown");
    } finally { notice.resolve(); await worker.stop(); }
    t.diagnostic("A leader-owned disposition can use ordinary worker completion, not a forged accepted forwarding receipt. The closing authority and notification are test-only; no live routing/handshake is proved.");
  });
}

test("COORD GAP: an in-memory closing disposition is lost across source-owner replacement", async (t) => {
  const h = fixture(t), source = makeJournal(h.dir, "closing-source"), notice = deferred<void>();
  let notified = false, ordinaryHandlerCalls = 0;
  const worker = Updates.createTelegramUpdateWorkerRuntime({ journal: source, hasAuthority: () => true,
    executeUpdate: async (_update, _ctx, signal) => {
      signal.throwIfAborted();
      notified = true; // Fake successful 'not sent to Pi; session closing' notice.
      await notice.promise; signal.throwIfAborted();
      return { kind: "complete" };
    } });
  source.appendBatch([{ update_id: 53, message: { message_id: 53, chat: { id: 7, type: "private" },
    message_thread_id: 11, from: { id: 7, is_bot: false }, text: "input rejected while closing" } }]);
  worker.start(h.ctx);
  try {
    await until(() => notified);
    const stopping = worker.stop(); notice.resolve(); await stopping;
    assert.equal(source.read().entries.length, 1);
    const reopened = makeJournal(h.dir, "closing-source");
    const replacement = Updates.createTelegramUpdateWorkerRuntime({ journal: reopened, hasAuthority: () => true,
      executeUpdate: async () => { ordinaryHandlerCalls++; return { kind: "complete" }; } });
    try {
      replacement.start({ ...h.ctx }); await replacement.waitForDrain();
      assert.equal(ordinaryHandlerCalls, 1);
      assert.equal(reopened.read().entries.length, 0);
    } finally { await replacement.stop(); }
    t.diagnostic("Concrete recovery gap in the proposed memory-only guard: the ordinary successor handler can receive an input already announced rejected. This proves source-worker invocation, not model execution. A durable closing disposition or equivalent existing proof is needed before enabling this path.");
  } finally { notice.resolve(); await worker.stop(); }
});

test("COORD refusal: follower-local idle does not erase an earlier lost-ACK source", async (t) => {
  const f = await forwardingFixture(t), h = f.h;
  const message = { message_id: 52, chat: { id: 7, type: "private" }, message_thread_id: 11,
    from: { id: 7, is_bot: false }, text: "earlier accepted input", pi_telegram_source_update_id: 52 };
  let handled = 0;
  const recipient = Updates.createTelegramUpdateWorkerRuntime({ journal: h.journal, hasAuthority: () => true,
    executeUpdate: async () => { handled++; return { kind: "complete" }; } });
  f.setSignal(recipient.signal); recipient.start(h.ctx);
  const source = Updates.createTelegramUpdateWorkerRuntime({ journal: f.leaderJournal, hasAuthority: () => true,
    scheduleRetry: () => 0, cancelRetry: noop,
    executeUpdate: async () => {
      const result = await f.forwarder.forwardMessage({ ownership: f.ownership(), ctx: h.ctx, message });
      if (result.status !== "accepted") throw new Error("fixture missing ACK");
      return { kind: "complete" };
    } });
  try {
    f.setDrop(true);
    f.leaderJournal.appendBatch([{ update_id: 52, message }]); source.start(h.ctx);
    await source.waitForDrain(); await recipient.waitForDrain();
    assert.equal(handled, 1); assert.equal(h.journal.read().entries.length, 0);
    assert.equal(f.leaderJournal.read().entries[0]?.state, "retry-wait");
    // Read directly through the real source owner in this single-process fixture.
    // Production needs an authenticated exact-owner observation, not follower disk reads.
    h.state.sourcePending = () => f.leaderJournal.read().entries.length > 0;
    assert.deepEqual(h.quit.prepare(h.source), { ok: false, reason: "busy" });
    const follower = { instanceId: h.scope.instanceId, profileKey: "manual:fixture", registrationGeneration: "registration-1",
      connectedAtMs: 1, lastHeartbeatMs: 1, target };
    const registry = Bus.createTelegramBusFollowerRegistry(); registry.register(follower);
    const closingGate = BusLeader.createTelegramBusFollowerClosingGate();
    let disconnects = 0;
    const coordinator = BusLeader.createTelegramBusFollowerQuitClosingCoordinator({ gate: closingGate,
      getCurrentFollower: registry.get,
      observeSourceSettlement: () => Updates.observeTelegramFollowerSourceSettlement({
        snapshot: f.leaderJournal.read(), recipientBindingKey: "manual:fixture", target }),
      async disconnect() { disconnects++; return undefined; },
    });
    assert.deepEqual(await coordinator.close(follower), { status: "refused", reason: "source-busy" });
    assert.equal(disconnects, 0); assert.equal(closingGate.getPhase(follower), "open");
    assert.equal(h.consent.length, 0);
    assert.equal(f.leaderJournal.read().entries.length, 1, "do not relabel earlier uncertain delivery as late rejected input");
  } finally { await source.stop(); await recipient.stop(); await f.close(); }
});

test("COORD refusal: own confirmation exclusion cannot outlive leader source settlement", async (t) => {
  const f = await forwardingFixture(t), h = f.h, input = h.offer();
  const callback = { id: "fixture-confirm", from: { id: 7, is_bot: false }, data: input.token,
    message: { message_id: 15, chat: { id: 7, type: "private" }, message_thread_id: 11 },
    pi_telegram_source_update_id: confirmationId };
  h.state.sourcePending = () => f.leaderJournal.read().entries.some((entry) =>
    entry.updateId !== confirmationId || h.quit.getPhase() === "finalizing");
  const recipient = Updates.createTelegramUpdateWorkerRuntime({ journal: h.journal, hasAuthority: () => true,
    executeUpdate: async () => { await h.quit.confirm(input); return { kind: "complete" }; },
    onUpdateCompleted: h.owner.onUpdateCompleted });
  f.setSignal(recipient.signal); recipient.start(h.ctx);
  const source = Updates.createTelegramUpdateWorkerRuntime({ journal: f.leaderJournal, hasAuthority: () => true,
    scheduleRetry: () => 0, cancelRetry: noop,
    executeUpdate: async () => {
      const result = await f.forwarder.forwardCallback({ ownership: f.ownership(), ctx: h.ctx, query: callback });
      if (result.status !== "accepted") throw new Error("fixture missing ACK");
      return { kind: "complete" };
    } });
  try {
    f.setDrop(true);
    f.leaderJournal.appendBatch([{ update_id: confirmationId, callback_query: callback }]); source.start(h.ctx);
    await source.waitForDrain(); await recipient.waitForDrain(); await tick();
    assert.equal(h.journal.read().entries.length, 0);
    assert.equal(f.leaderJournal.read().entries[0]?.state, "retry-wait");
    assert.equal(h.consent.length, 0);
    assert.equal(h.quit.getPhase(), "idle", "the source-aware final check refuses instead of shutting down");
    assert.equal(h.gate.getPhase(), "open");
    t.diagnostic("A lost confirmation ACK requires source-owner settlement evidence before final shutdown. This prototype refuses; it does not implement a cross-process wait/commit handshake.");
  } finally { await source.stop(); await recipient.stop(); await f.close(); }
});

test("BOUNDARY lost quit ACK: leader source survives local completion, but old token cannot request another shutdown", async (t) => {
  const f = await forwardingFixture(t), h = f.h, input = h.offer();
  const callback: Updates.TelegramCallbackQuery & { data: string; pi_telegram_source_update_id: number } = {
    id: "fixture-confirm", from: { id: 7, is_bot: false },
    data: input.token, message: { message_id: 15, chat: { id: 7, type: "private" }, message_thread_id: 11 },
    pi_telegram_source_update_id: confirmationId };
  let handlerCalls = 0;
  const worker = Updates.createTelegramUpdateWorkerRuntime({ journal: h.journal, hasAuthority: () => true,
    executeUpdate: async (update) => {
      assert.equal((update.callback_query as typeof callback).data, input.token);
      handlerCalls++;
      await h.quit.confirm(input); return { kind: "complete" };
    },
    onUpdateCompleted: h.owner.onUpdateCompleted,
  });
  f.setSignal(worker.signal); worker.start(h.ctx);
  const leaderWorker = Updates.createTelegramUpdateWorkerRuntime({ journal: f.leaderJournal, hasAuthority: () => true,
    getNowMs: f.getNow, scheduleRetry: () => 0, cancelRetry: noop,
    executeUpdate: async () => {
      const result = await f.forwarder.forwardCallback({ query: callback, ownership: f.ownership(), ctx: h.ctx });
      if (result.status !== "accepted") throw new Error("fixture forwarding acknowledgement unavailable");
      return { kind: "complete" };
    },
  });
  try {
    f.setDrop(true);
    f.leaderJournal.appendBatch([{ update_id: confirmationId, callback_query: callback }]);
    leaderWorker.start(h.ctx); await leaderWorker.waitForDrain(); await worker.waitForDrain(); await tick();
    assert.equal(h.consent.length, 1);
    assert.equal(h.journal.read().entries.length, 0);
    const retained = f.leaderJournal.read().entries[0]!;
    assert.equal(retained.state, "retry-wait");
    assert.equal(retained.updateId, confirmationId);
    f.setDrop(false); f.setNow(retained.nextRetryAtMs!);
    leaderWorker.signal(); await leaderWorker.waitForDrain(); await worker.waitForDrain(); await tick();
    assert.equal(f.leaderJournal.read().entries.length, 0);
    assert.equal(handlerCalls, 2, "the lost-ACK retry really re-entered the confirmation handler");
    assert.equal(h.consent.length, 1, "same-process retry of old confirmation cannot repeat shutdown");
    const successor = fixture(t);
    assert.equal((await successor.quit.confirm(input)).ok, false, "fresh runtime has no authority for the old token");
    assert.equal(successor.consent.length, 0);
    t.diagnostic("Local post-completion is not leader-source settlement; one-use quit tokens already protect shutdown replay.");
  } finally { await leaderWorker.stop(); await worker.stop(); await f.close(); }
});

test("GAP closing race: ordinary input is durably admitted behind a sealed local quit gate and reaches a replacement worker", async (t) => {
  const f = await forwardingFixture(t), h = f.h;
  await h.runConfirmation(); assert.equal(h.gate.getPhase(), "sealed");
  // Model the teardown interval before receiver shutdown. The shutdown port is a spy:
  // this proves receiver/journal behavior, not the timing of a real Pi process exit.
  const message = { message_id: 52, chat: { id: 7, type: "private" }, message_thread_id: 11,
    from: { id: 7, is_bot: false }, text: "arrived while closing", pi_telegram_source_update_id: 52 };
  const result = await f.forwarder.forwardMessage({ ownership: f.ownership(), ctx: h.ctx, message });
  assert.equal(result.status, "accepted");
  assert.deepEqual(h.journal.read().entries.map((entry) => entry.updateId), [52]);
  let executed = 0;
  const successorWorker = Updates.createTelegramUpdateWorkerRuntime({ journal: h.journal, hasAuthority: () => true,
    executeUpdate: async () => { executed++; return { kind: "complete" }; } });
  try {
    successorWorker.start({ ...h.ctx }); await successorWorker.waitForDrain();
    assert.equal(executed, 1);
    assert.equal(h.consent.length, 1);
  } finally { await successorWorker.stop(); await f.close(); }
  t.diagnostic("FEASIBILITY GAP: Q1 closure is not composed with receiving admission. This proves worker invocation, not model execution.");
});

test("GAP naive gate wiring: rejecting a closing follower retains the leader source for retry", async (t) => {
  const f = await forwardingFixture(t), h = f.h;
  await h.runConfirmation(); f.setAdmissionGate(h.gate);
  const message = { message_id: 52, chat: { id: 7, type: "private" }, message_thread_id: 11,
    from: { id: 7, is_bot: false }, text: "arrived while closing", pi_telegram_source_update_id: 52 };
  let settlement: Bus.TelegramBusForeignUpdateSettlement | undefined;
  const leaderWorker = Updates.createTelegramUpdateWorkerRuntime({ journal: f.leaderJournal,
    hasAuthority: () => true, getNowMs: f.getNow, scheduleRetry: () => 0, cancelRetry: noop,
    executeUpdate: async () => {
      settlement = await f.forwarder.forwardMessage({ ownership: f.ownership(), ctx: h.ctx, message });
      if (settlement.status !== "accepted") throw new Error("fixture recipient closing");
      return { kind: "complete" };
    },
  });
  try {
    f.leaderJournal.appendBatch([{ update_id: 52, message }]); leaderWorker.start(h.ctx);
    await leaderWorker.waitForDrain();
    assert.equal(settlement?.status, "retryable");
    assert.equal(h.journal.read().entries.length, 0);
    const retained = f.leaderJournal.read().entries;
    assert.deepEqual(retained.map((entry) => [entry.updateId, entry.state]), [[52, "retry-wait"]]);
    assert.equal(h.consent.length, 1);
    t.diagnostic("FEASIBILITY GAP: negative forwarding ACK is not a settled user-visible closing rejection; leader custody remains.");
  } finally { await leaderWorker.stop(); await f.close(); }
});
}
