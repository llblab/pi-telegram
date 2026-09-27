/** Offline regressions for the disconnected confirmed-quit foundation. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import {
  createTelegramQuitAdmissionGate,
  createTelegramQuitFoundation,
  createTelegramQuitAfterDeletion,
  createTelegramFollowerDeleteFirstPort,
  createTelegramQuitCommandController,
  createTelegramQuitLifecycleController,
  createTelegramQuitProductionRuntime,
  resolveTelegramQuitFinalAcceptedInput,
  type TelegramQuitExitSnapshot,
  type TelegramQuitCleanupConsent,
  type TelegramQuitExecutionFence,
  type TelegramQuitFoundationDeps,
  type TelegramQuitScope,
  type TelegramQuitSnapshot,
} from "../lib/quit.ts";
import { createTelegramUpdateWorkerOwnerRuntime } from "../lib/updates.ts";
import { TELEGRAM_BOT_COMMANDS, TELEGRAM_RESERVED_COMMAND_NAMES } from "../lib/commands.ts";

function makeScope(): TelegramQuitScope {
  return { profileKey: "test-profile-generation", botId: 42, ownerUserId: 7, chatId: 7, threadId: 11,
    instanceId: "test-instance", processBirthId: "test-process-birth", sessionId: "test-session",
    sessionGeneration: 1, transportGeneration: "leader-epoch-1/registration-1" };
}
function makeSnapshot(scope = makeScope()): TelegramQuitSnapshot {
  return { scope, automaticCleanup: false,
    quiescence: { agent: "clear", piMessages: "clear", telegramQueue: "clear", dispatch: "clear",
      compaction: "clear", groupedInput: "clear", acceptedInput: "clear", delivery: "clear" },
    transport: { role: "follower", cohortKey: "leader-1/peer-1", survivorCount: 1,
      quitSupported: true, failoverReady: true } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides: Partial<TelegramQuitFoundationDeps> = {}) {
  const scope = makeScope();
  const state = { snapshot: makeSnapshot(scope) as TelegramQuitSnapshot | undefined, now: 1000 };
  const gate = createTelegramQuitAdmissionGate(scope);
  const events: string[] = [];
  const shutdowns: TelegramQuitCleanupConsent[] = [];
  const runtime = createTelegramQuitFoundation({
    gate, readSnapshot: () => state.snapshot, now: () => state.now,
    refresh: async (fence) => { fence.assertCurrent(); events.push("refresh"); },
    acknowledge: async (_confirmation, fence) => { fence.assertCurrent(); events.push("ack"); return true; },
    shutdown: (consent) => { events.push("shutdown"); shutdowns.push(consent); },
    onFailure: (reason) => events.push(`failure:${reason}`),
    ...overrides,
  });
  const source = { scope, actorUserId: 7, messageId: 15 };
  function prepare() {
    const result = runtime.prepare(source);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error("prepare failed");
    return { ...source, token: result.confirmation.token, updateId: 41 };
  }
  return { scope, source, state, gate, events, shutdowns, runtime, prepare,
    async arm() { const input = prepare(); assert.deepEqual(await runtime.confirm(input), { ok: true }); return input; },
    async complete() { runtime.onUpdateCompleted(41, scope); await tick(); },
  };
}

function commandHarness(overrides: {
  send?: () => Promise<number | undefined>;
  edit?: (text: string, markup: { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{ readonly callback_data: string }>> }) => Promise<void>;
} = {}) {
  const scope = makeScope();
  const state = { snapshot: { ...makeSnapshot(scope), automaticCleanup: true } as TelegramQuitSnapshot };
  const events: string[] = [];
  const edits: Array<{ text: string; markup: { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{ readonly callback_data: string }>> } }> = [];
  const answers: string[] = [];
  let nextMessageId = 80;
  const controller = createTelegramQuitCommandController({
    foundation: {
      gate: createTelegramQuitAdmissionGate(scope),
      readSnapshot: () => state.snapshot,
      refresh: async (fence) => { fence.assertCurrent(); events.push("refresh"); },
      shutdown: () => { throw new Error("legacy shutdown must not run"); },
      deleteFirst: async (consent, fence) => {
        fence.assertCurrent(); events.push("delete");
        return { status: "deleted", deletion: { scope, operationId: consent.operationId, confirmed: true } };
      },
      afterDeletion: () => { events.push("exit"); return { status: "shutdown-requested" }; },
    },
    sendInteractiveMessage: async (_chatId, text, _mode, markup) => {
      events.push("send"); edits.push({ text, markup });
      return overrides.send ? await overrides.send() : nextMessageId++;
    },
    editInteractiveMessage: async (_chatId, _messageId, text, _mode, markup) => {
      events.push("edit"); edits.push({ text, markup }); await overrides.edit?.(text, markup);
    },
    answerCallbackQuery: async (_id, text) => { answers.push(text ?? ""); },
  });
  const open = () => controller.open({ chatId: scope.chatId, threadId: scope.threadId, actorUserId: scope.ownerUserId });
  const callback = (data: string, changes: Record<string, unknown> = {}) => ({
    id: "callback-1", data, from: { id: scope.ownerUserId },
    message: { chat: { id: scope.chatId }, message_id: nextMessageId - 1, message_thread_id: scope.threadId },
    ...changes,
  });
  const latestButton = (action: "confirm" | "cancel") => {
    const buttons = edits.flatMap((entry) => entry.markup.inline_keyboard.flat());
    return buttons.findLast((button) => button.callback_data.startsWith(`quit:${action}:`))!.callback_data;
  };
  return { scope, state, events, edits, answers, controller, open, callback, latestButton };
}

test("private quit lifecycle waits for command completion and forwards confirmation completion", async () => {
  const h = commandHarness();
  const results: unknown[] = [];
  const lifecycle = createTelegramQuitLifecycleController({ controller: h.controller, onOpenResult: (result) => results.push(result) });
  h.state.snapshot = { ...h.state.snapshot, quiescence: { ...h.state.snapshot.quiescence, acceptedInput: "busy" } };
  assert.equal(lifecycle.requestOpen({ chatId: h.scope.chatId, threadId: h.scope.threadId,
    actorUserId: h.scope.ownerUserId }, 70), true);
  assert.equal(lifecycle.requestOpen({ chatId: h.scope.chatId, threadId: h.scope.threadId,
    actorUserId: h.scope.ownerUserId }, 71), false);
  assert.equal(h.events.includes("send"), false);
  lifecycle.onUpdateCompleted(69);
  assert.equal(h.events.includes("send"), false);
  h.state.snapshot = { ...h.state.snapshot, quiescence: { ...h.state.snapshot.quiescence, acceptedInput: "clear" } };
  lifecycle.onUpdateCompleted(70);
  await tick();
  assert.deepEqual(results, [{ ok: true }]);
  const confirm = h.latestButton("confirm");
  assert.equal(await h.controller.handleCallback(h.callback(confirm), 71), true);
  lifecycle.onUpdateCompleted(71);
  await tick();
  assert.deepEqual(h.events.filter((event) => event === "delete" || event === "exit"), ["delete", "exit"]);
  lifecycle.dispose();
});

test("private quit controller retires buttons when disposed during confirmation publication", async () => {
  const publishing = deferred<void>();
  let blocked = false;
  const h = commandHarness({ edit: async (text, markup) => {
    if (!blocked && text.includes("Quit this Pi") && markup.inline_keyboard.length > 0) {
      blocked = true; await publishing.promise;
    }
  } });
  const opening = h.open();
  await tick();
  h.controller.dispose();
  publishing.resolve();
  assert.deepEqual(await opening, { ok: false, reason: "acknowledgement-failed" });
  await tick();
  const finalEdit = h.edits.at(-1)!;
  assert.match(finalEdit.text, /confirmation expired/);
  assert.equal(finalEdit.markup.inline_keyboard.length, 0);
});

test("private quit controller cannot publish authority after disposal during initial delivery", async () => {
  const sent = deferred<number | undefined>();
  const h = commandHarness({ send: () => sent.promise });
  const opening = h.open();
  h.controller.dispose();
  sent.resolve(80);
  assert.deepEqual(await opening, { ok: false, reason: "unavailable" });
  assert.equal(h.edits.some((entry) => entry.markup.inline_keyboard.length > 0), false);
});

test("private quit lifecycle disposal drops an uncommitted UI request", async () => {
  const h = commandHarness();
  const lifecycle = createTelegramQuitLifecycleController({ controller: h.controller });
  assert.equal(lifecycle.requestOpen({ chatId: h.scope.chatId, threadId: h.scope.threadId,
    actorUserId: h.scope.ownerUserId }, 72), true);
  lifecycle.dispose();
  lifecycle.onUpdateCompleted(72);
  await tick();
  assert.equal(h.events.includes("send"), false);
});

test("final accepted-input projection treats only exact stopped disconnection as clear without worker state", () => {
  assert.equal(resolveTelegramQuitFinalAcceptedInput(0, false), "clear");
  assert.equal(resolveTelegramQuitFinalAcceptedInput(1, true), "busy");
  assert.equal(resolveTelegramQuitFinalAcceptedInput(undefined, false), "unknown");
  assert.equal(resolveTelegramQuitFinalAcceptedInput(undefined, true), "clear");
  assert.equal(resolveTelegramQuitFinalAcceptedInput(-1, true), "unknown");
});

test("production quit adapter completes the registered command-to-delete-to-native-shutdown path", async () => {
  const scope = makeScope();
  const edits: Array<{ text: string; markup: { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{ readonly callback_data: string }>> } }> = [];
  const events: string[] = [];
  const answers: string[] = [];
  let connected = true;
  const runtime = createTelegramQuitProductionRuntime<{
    chatId: number; threadId: number; actorUserId: number; updateId: number;
  }, {
    id: string; data?: string; from?: { id?: number };
    message?: { chat?: { id?: number }; message_id?: number; message_thread_id?: number };
  }, { id: string }>({
    readScope: () => connected ? scope : undefined,
    readQuiescence: () => ({ agent: "clear", piMessages: "clear", telegramQueue: "clear", dispatch: "clear",
      compaction: "clear", groupedInput: "clear", acceptedInput: "clear", delivery: "clear" }),
    readExitSnapshot: () => ({ identity: { profileKey: scope.profileKey, botId: scope.botId,
      ownerUserId: scope.ownerUserId, chatId: scope.chatId, instanceId: scope.instanceId,
      processBirthId: scope.processBirthId, sessionId: scope.sessionId, sessionGeneration: scope.sessionGeneration },
      connection: connected ? "connected" : "disconnected",
      quiescence: { agent: "clear", piMessages: "clear", telegramQueue: "clear", dispatch: "clear",
        compaction: "clear", groupedInput: "clear", acceptedInput: "clear", delivery: "clear" } }),
    readMessage: (message) => ({ chatId: message.chatId, threadId: message.threadId, actorUserId: message.actorUserId }),
    getExecutionUpdateId: (message) => message.updateId,
    disconnect: async () => {
      events.push("delete"); connected = false;
      return { status: "disconnected", outcome: { instanceId: scope.instanceId,
        registrationGeneration: scope.transportGeneration, target: { chatId: scope.chatId, threadId: scope.threadId },
        deletion: { kind: "follower-disconnect-result", instanceId: scope.instanceId,
          registrationGeneration: scope.transportGeneration, target: { chatId: scope.chatId, threadId: scope.threadId },
          threadDeletion: "confirmed" } } };
    },
    shutdown: () => { events.push("shutdown"); },
    sendInteractiveMessage: async (_chatId, text, _mode, markup) => {
      edits.push({ text, markup }); return 80;
    },
    editInteractiveMessage: async (_chatId, _messageId, text, _mode, markup) => { edits.push({ text, markup }); },
    answerCallbackQuery: async (_id, text) => { answers.push(text ?? ""); },
    rejectCommand: async (_message, text) => { events.push(`reject:${text}`); },
    recordError: () => undefined,
  });
  const ctx = { id: "ctx" };
  assert.equal(await runtime.handleCallback({ id: "other", data: "compact:confirm" }, ctx, 69), false);
  assert.deepEqual(answers, []);
  await runtime.request({ chatId: scope.chatId, threadId: scope.threadId,
    actorUserId: scope.ownerUserId, updateId: 70 }, ctx);
  assert.equal(edits.length, 0, "command update must settle before confirmation publication");
  runtime.onUpdateCompleted(70);
  await tick();
  const confirm = edits.flatMap((entry) => entry.markup.inline_keyboard.flat())
    .find((button) => button.callback_data.startsWith("quit:confirm:"))!.callback_data;
  assert.equal(await runtime.handleCallback({ id: "cb", data: confirm, from: { id: scope.ownerUserId },
    message: { chat: { id: scope.chatId }, message_id: 80, message_thread_id: scope.threadId } }, ctx, 71), true);
  assert.deepEqual(events, []);
  runtime.onUpdateCompleted(71);
  await tick();
  assert.deepEqual(events, ["delete", "shutdown"]);
  assert.equal(await runtime.resolveTerminalCleanup(() => true), false,
    "native session shutdown must not replay already-confirmed Thread cleanup");
  runtime.dispose();
});

test("private quit command controller binds the delivered confirmation and waits for update completion", async () => {
  const h = commandHarness();
  assert.deepEqual(await h.open(), { ok: true });
  const confirm = h.latestButton("confirm");
  assert.equal(confirm.length <= 64, true);
  assert.equal(await h.controller.handleCallback(h.callback(confirm, { from: { id: 99 } }), 51), true);
  assert.equal(h.controller.foundation.getPhase(), "offered");
  assert.equal(await h.controller.handleCallback(h.callback(confirm), 51), true);
  assert.equal(h.controller.foundation.getPhase(), "armed");
  assert.deepEqual(h.events.filter((event) => event === "delete" || event === "exit"), []);
  h.controller.onUpdateCompleted(50);
  await tick();
  assert.equal(h.controller.foundation.getPhase(), "armed");
  h.controller.onUpdateCompleted(51);
  await tick();
  assert.deepEqual(h.events.filter((event) => event === "delete" || event === "exit"), ["delete", "exit"]);
  assert.equal(h.controller.foundation.getPhase(), "shutdown-requested");
  assert.equal(h.answers[0], "⌛ Quit confirmation expired.");
  assert.equal(h.answers.at(-1), "Quit confirmed.");
  h.controller.dispose();
});

test("private quit controller retires confirmed UI when disposed during acknowledgement", async () => {
  const acknowledging = deferred<void>();
  const h = commandHarness({ edit: async (text) => {
    if (text.includes("Quit confirmed")) await acknowledging.promise;
  } });
  assert.deepEqual(await h.open(), { ok: true });
  const confirmation = h.controller.handleCallback(h.callback(h.latestButton("confirm")), 59);
  await tick();
  h.controller.dispose();
  acknowledging.resolve();
  assert.equal(await confirmation, true);
  await tick();
  const finalEdit = h.edits.at(-1)!;
  assert.match(finalEdit.text, /confirmation expired/);
  assert.equal(finalEdit.markup.inline_keyboard.length, 0);
  assert.equal(h.events.includes("delete"), false);
});

test("private quit cancellation reopens admission without a late notice clearing a new attempt", async () => {
  const cancellationEdit = deferred<void>();
  const h = commandHarness({ edit: async (text) => {
    if (text.includes("Quit not completed")) await cancellationEdit.promise;
  } });
  assert.deepEqual(await h.open(), { ok: true });
  assert.equal(await h.controller.handleCallback(h.callback(h.latestButton("cancel")), 60), true);
  assert.deepEqual(await h.open(), { ok: true });
  const replacement = h.latestButton("confirm");
  cancellationEdit.resolve();
  await tick();
  assert.equal(await h.controller.handleCallback(h.callback(replacement), 61), true);
  assert.equal(h.controller.foundation.getPhase(), "armed");
  h.controller.dispose();
});

test("private quit confirmation publication failure cancels authority and permits a fresh attempt", async () => {
  let fail = true;
  const h = commandHarness({ edit: async (text, markup) => {
    if (fail && text.includes("Quit this Pi") && markup.inline_keyboard.length > 0) {
      fail = false; throw new Error("fixture edit failure");
    }
  } });
  assert.deepEqual(await h.open(), { ok: false, reason: "acknowledgement-failed" });
  await tick();
  assert.equal(h.controller.foundation.getPhase(), "idle");
  assert.deepEqual(await h.open(), { ok: true });
  h.controller.dispose();
});

test("delete-first foundation requires paired cleanup and exit ports", () => {
  const h = harness();
  assert.throws(() => createTelegramQuitFoundation({
    gate: h.gate, readSnapshot: () => h.state.snapshot, refresh: async () => undefined,
    acknowledge: async () => true, shutdown: () => undefined,
    deleteFirst: async () => ({ status: "outcome-unknown" }),
  }), /requires both/);
  h.runtime.dispose();
});

test("admission counts exact-scope operations and never releases another attempt", () => {
  const scope = makeScope(), gate = createTelegramQuitAdmissionGate(scope);
  assert.equal(gate.enter({ ...scope, threadId: 99 }), undefined);
  const release = gate.enter(scope)!;
  assert.equal(gate.tryClose(scope), undefined);
  release(); release();
  const first = gate.tryClose(scope)!;
  assert.equal(gate.enter(scope), undefined);
  first.reopen();
  const second = gate.tryClose(scope)!;
  first.reopen();
  assert.equal(gate.getPhase(), "closing");
  assert.equal(first.seal(), false);
  assert.equal(second.seal(), true);
  second.reopen();
  assert.equal(gate.getPhase(), "sealed");
  gate.invalidate();
  assert.equal(second.isCurrent(), false);
  assert.equal(gate.getPhase(), "retired");
});

test("delete-first path keeps consent uncommitted until exact deletion then runs one synchronous exit decision", async (t) => {
  const cleanup = deferred<ReturnType<NonNullable<TelegramQuitFoundationDeps["deleteFirst"]>> extends Promise<infer T> ? T : never>();
  let runtime!: ReturnType<typeof createTelegramQuitFoundation>;
  let cleanupCalls = 0, exitCalls = 0;
  const h = harness({
    deleteFirst: async (candidate, fence) => {
      cleanupCalls++; fence.assertCurrent();
      assert.equal(runtime.getCleanupConsent(candidate.scope), undefined, "cleanup is authorized by the captured candidate, not committed exit consent");
      return cleanup.promise;
    },
    afterDeletion(candidate, deletion) {
      exitCalls++;
      assert.equal(runtime.getCleanupConsent(candidate.scope), candidate);
      assert.equal(deletion.operationId, candidate.operationId);
      return { status: "shutdown-requested" };
    },
  });
  runtime = h.runtime; t.after(() => runtime.dispose());
  h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: true };
  const input = await h.arm();
  h.runtime.onUpdateCompleted(input.updateId, h.scope); await tick();
  assert.equal(h.runtime.getPhase(), "disconnecting"); assert.equal(cleanupCalls, 1);
  assert.equal(h.events.includes("shutdown"), false, "legacy immediate shutdown is bypassed");
  cleanup.resolve({ status: "deleted", deletion: { scope: h.scope, operationId: input.token, confirmed: true } });
  await tick();
  assert.equal(h.runtime.getPhase(), "shutdown-requested"); assert.equal(exitCalls, 1);
  assert.deepEqual(h.runtime.getExitResult(), { status: "shutdown-requested" });
});

for (const reason of ["busy", "unknown", "changed", "unsupported"] as const) {
  test(`delete-first explicit ${reason} refusal reopens without cleanup commitment`, async (t) => {
    let exits = 0;
    const h = harness({ deleteFirst: async () => ({ status: "refused", reason }),
      afterDeletion: () => { exits++; return { status: "shutdown-requested" }; } });
    t.after(() => h.runtime.dispose()); h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: true };
    await h.arm(); await h.complete(); await tick();
    assert.equal(h.runtime.getPhase(), "idle"); assert.equal(h.gate.getPhase(), "open");
    assert.equal(h.runtime.getCleanupConsent(h.scope), undefined); assert.equal(exits, 0);
    assert.ok(h.events.includes(`failure:${reason}`));
  });
}

for (const outcome of ["disconnected-unconfirmed", "outcome-unknown", "throw", "malformed-deleted", "malformed-refusal"] as const) {
  test(`delete-first ${outcome} seals uncertain effects and never requests native shutdown`, async (t) => {
    let exits = 0;
    const h = harness({ deleteFirst: async () => {
      if (outcome === "throw") throw new Error("fixture cleanup outcome unknown");
      if (outcome === "malformed-deleted") return { status: "deleted" } as never;
      if (outcome === "malformed-refusal") return { status: "refused", reason: "retry" } as never;
      return { status: outcome };
    }, afterDeletion: () => { exits++; return { status: "shutdown-requested" }; } });
    t.after(() => h.runtime.dispose()); h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: true };
    await h.arm(); await h.complete(); await tick();
    assert.equal(h.runtime.getPhase(), "outcome-unknown"); assert.equal(h.gate.getPhase(), "sealed");
    assert.equal(exits, 0); assert.equal(h.events.includes("shutdown"), false);
    assert.equal(h.runtime.getCleanupConsent(h.scope), undefined, "uncertain deletion never commits cleanup consent");
    assert.throws(() => h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, () => true), /outcome is uncertain/);
  });
}

test("delete-first composes confirmed deletion with real final busy evidence and never retries", async (t) => {
  let exits = 0, nativeShutdowns = 0, runtime!: ReturnType<typeof createTelegramQuitFoundation>;
  const h = harness({ deleteFirst: async (candidate) => ({ status: "deleted",
      deletion: { scope: candidate.scope, operationId: candidate.operationId, confirmed: true } }),
    afterDeletion(candidate, deletion) {
      exits++;
      const scope = candidate.scope;
      return createTelegramQuitAfterDeletion({ consent: candidate, getCleanupConsent: runtime.getCleanupConsent,
        readExitSnapshot: () => ({ identity: { profileKey: scope.profileKey, botId: scope.botId,
          ownerUserId: scope.ownerUserId, chatId: scope.chatId, instanceId: scope.instanceId,
          processBirthId: scope.processBirthId, sessionId: scope.sessionId, sessionGeneration: scope.sessionGeneration },
          connection: "disconnected", quiescence: { ...makeSnapshot(scope).quiescence, agent: "busy" } }),
        shutdown: () => { nativeShutdowns++; } }).finish(deletion);
    } });
  runtime = h.runtime; t.after(() => h.runtime.dispose()); h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: true };
  await h.arm(); await h.complete(); await tick();
  assert.equal(h.runtime.getPhase(), "left-running");
  assert.deepEqual(h.runtime.getExitResult(), { status: "left-running", reason: "busy" });
  await tick(); assert.equal(exits, 1); assert.equal(nativeShutdowns, 0); assert.equal(h.events.includes("shutdown"), false);
});

test("delete-first disposal during cleanup prevents late exit without reopening retired admission", async () => {
  const cleanup = deferred<{ status: "deleted"; deletion: { scope: TelegramQuitScope; operationId: string; confirmed: true } }>();
  let exits = 0;
  const h = harness({ deleteFirst: async () => cleanup.promise,
    afterDeletion: () => { exits++; return { status: "shutdown-requested" }; } });
  h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: true };
  const input = await h.arm(); h.runtime.onUpdateCompleted(input.updateId, h.scope); await tick();
  assert.equal(h.runtime.getPhase(), "disconnecting"); h.runtime.dispose();
  cleanup.resolve({ status: "deleted", deletion: { scope: h.scope, operationId: input.token, confirmed: true } });
  await tick(); assert.equal(h.runtime.getPhase(), "disposed"); assert.equal(h.gate.getPhase(), "retired"); assert.equal(exits, 0);
});

test("delete-first refuses non-delete consent before invoking cleanup", async (t) => {
  let cleanups = 0;
  const h = harness({ deleteFirst: async () => { cleanups++; return { status: "outcome-unknown" }; },
    afterDeletion: () => ({ status: "shutdown-requested" }) });
  t.after(() => h.runtime.dispose());
  await h.arm(); await h.complete(); await tick();
  assert.equal(cleanups, 0); assert.equal(h.runtime.getPhase(), "idle"); assert.equal(h.gate.getPhase(), "open");
  assert.ok(h.events.includes("failure:unsupported"));
});

test("happy path waits for exact update settlement and captures immutable cleanup consent", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  const input = await h.arm();
  assert.deepEqual(h.events, ["refresh", "ack"]);
  assert.equal(h.gate.enter(h.scope), undefined);
  h.runtime.onUpdateCompleted(40, h.scope);
  h.runtime.onUpdateCompleted(41, { ...h.scope, threadId: 12 });
  await tick();
  assert.equal(h.shutdowns.length, 0);
  h.runtime.onUpdateCompleted(41, h.scope);
  assert.equal(h.shutdowns.length, 0, "handoff must leave the worker callback stack first");
  await tick();
  assert.deepEqual(h.events, ["refresh", "ack", "refresh", "shutdown"]);
  assert.equal(h.runtime.getPhase(), "shutdown-requested");
  const consent = h.runtime.getCleanupConsent(h.scope)!;
  assert.equal(consent.operationId, input.token);
  assert.equal(consent.updateId, 41);
  assert.equal(consent.automaticCleanup, false);
  assert.ok(Object.isFrozen(consent) && Object.isFrozen(consent.scope));
  h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: true };
  assert.equal(h.runtime.getCleanupConsent(h.scope)?.automaticCleanup, false, "later config changes cannot expand this consent");
  assert.equal(h.runtime.getCleanupConsent({ ...h.scope, sessionGeneration: 2 }), undefined);
  assert.equal(h.runtime.cancel(input), false);
  h.runtime.onUpdateCompleted(41, h.scope);
  assert.equal((await h.runtime.confirm(input)).ok, false);
  await tick();
  assert.equal(h.shutdowns.length, 1);
});

test("existing update owner adapter supplies current-context completion without an agent turn", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  let active = true, dispatched = 0;
  const owner = createTelegramUpdateWorkerOwnerRuntime({
    instanceId: h.scope.instanceId, processId: 123, processBirthId: h.scope.processBirthId,
    getSessionGeneration: () => 1, isContextCurrent: (ctx: string) => active && ctx === "current",
    dispatchNext() { const release = h.gate.enter(h.scope); if (release) { dispatched++; release(); } },
    requestQueueHandoffReconciliation() {},
    afterUpdateCompleted: (id) => h.runtime.onUpdateCompleted(id, h.scope),
  });
  const input = h.prepare();
  owner.onUpdateCompleted(41, "current"); // Completion before confirmation is not retained as authority.
  assert.deepEqual(await h.runtime.confirm(input), { ok: true });
  active = false; owner.onUpdateCompleted(41, "current");
  active = true; owner.onUpdateCompleted(41, "obsolete"); owner.onUpdateCompleted(40, "current");
  await tick(); assert.equal(h.shutdowns.length, 0);
  owner.onUpdateCompleted(41, "current");
  await tick();
  assert.equal(h.shutdowns.length, 1);
  assert.equal(dispatched, 1, "only the pre-confirmation dispatch was allowed");
});

for (const key of Object.keys(makeScope()) as (keyof TelegramQuitScope)[]) {
  test(`scope drift in ${key} prevents shutdown`, async (t) => {
    const h = harness(); t.after(() => h.runtime.dispose());
    await h.arm();
    const original = h.scope[key];
    const changed = { ...h.scope, [key]: typeof original === "number" ? original + 1 : `${original}-new` };
    h.state.snapshot = { ...h.state.snapshot!, scope: changed };
    await h.complete();
    assert.equal(h.shutdowns.length, 0);
    assert.equal(h.gate.getPhase(), "open");
  });
}

for (const key of Object.keys(makeSnapshot().quiescence) as (keyof TelegramQuitSnapshot["quiescence"])[]) {
  for (const value of ["busy", "unknown", undefined] as const) {
    test(`${key}=${String(value)} fails closed after confirmation`, async (t) => {
      const h = harness(); t.after(() => h.runtime.dispose());
      await h.arm();
      h.state.snapshot = { ...h.state.snapshot!, quiescence: { ...h.state.snapshot!.quiescence, [key]: value } };
      await h.complete();
      assert.equal(h.shutdowns.length, 0);
      assert.equal(h.gate.getPhase(), "open");
    });
  }
}

test("already admitted work refuses quit without clearing or completing that work", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  const input = h.prepare(), release = h.gate.enter(h.scope)!;
  assert.deepEqual(await h.runtime.confirm(input), { ok: false, reason: "busy" });
  assert.equal(h.gate.tryClose(h.scope), undefined, "existing work retains its admission");
  release();
  const next = await h.arm();
  assert.notEqual(next.token, input.token);
  await h.complete(); assert.equal(h.shutdowns.length, 1);
});

test("only the exact paired actor, message, scope and token can confirm or cancel", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  const input = h.prepare();
  for (const wrong of [{ ...input, actorUserId: 8 }, { ...input, messageId: 16 },
    { ...input, token: "copied" }, { ...input, scope: { ...h.scope, threadId: 99 } }]) {
    assert.equal((await h.runtime.confirm(wrong)).ok, false);
    assert.equal(h.runtime.cancel(wrong), false);
    assert.equal(h.runtime.getPhase(), "offered");
  }
  assert.equal(h.runtime.cancel(input), true);
  assert.equal(h.gate.getPhase(), "open");
  assert.equal((await h.runtime.confirm(input)).ok, false);
});

test("parallel confirmations acknowledge once and new confirmations cannot replace a closing attempt", async (t) => {
  const ack = deferred<boolean>(); let calls = 0;
  const h = harness({ acknowledge: async () => { calls++; return ack.promise; } });
  t.after(() => h.runtime.dispose());
  const input = h.prepare(), first = h.runtime.confirm(input);
  await tick();
  assert.equal((await h.runtime.confirm(input)).ok, false);
  assert.equal(h.runtime.prepare(h.source).ok, false);
  assert.equal(calls, 1);
  ack.resolve(true); await first;
  await h.complete(); assert.equal(h.shutdowns.length, 1);
});

for (const automaticCleanup of [false, true]) {
  test(`cleanup=${automaticCleanup} is captured, and a pre-commit policy change refuses`, async (t) => {
    const h = harness(); t.after(() => h.runtime.dispose());
    h.state.snapshot = { ...h.state.snapshot!, automaticCleanup };
    await h.arm(); await h.complete();
    assert.equal(h.shutdowns[0]?.automaticCleanup, automaticCleanup);
    const other = harness(); t.after(() => other.runtime.dispose());
    other.state.snapshot = { ...other.state.snapshot!, automaticCleanup };
    await other.arm();
    other.state.snapshot = { ...other.state.snapshot!, automaticCleanup: !automaticCleanup };
    await other.complete();
    assert.equal(other.shutdowns.length, 0);
    assert.equal(other.gate.getPhase(), "open");
  });
}

test("refresh rechecks policy after acknowledgement before the irreversible decision", async (t) => {
  let count = 0;
  const h = harness({ refresh: async () => {
    if (++count === 2) h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: true };
  } });
  t.after(() => h.runtime.dispose());
  await h.arm(); await h.complete();
  assert.equal(count, 2); assert.equal(h.shutdowns.length, 0);
});

for (const change of ["role", "cohort", "survivors", "unsupported", "no-successor"] as const) {
  test(`transport change ${change} invalidates shared-transport confirmation`, async (t) => {
    const h = harness(); t.after(() => h.runtime.dispose());
    h.state.snapshot = { ...h.state.snapshot!, transport: { ...h.state.snapshot!.transport, role: "leader" } };
    await h.arm();
    const previous = h.state.snapshot!.transport;
    const transport = change === "role" ? { ...previous, role: "follower" as const }
      : change === "cohort" ? { ...previous, cohortKey: "new-epoch" }
      : change === "survivors" ? { ...previous, survivorCount: 0 }
      : change === "unsupported" ? { ...previous, quitSupported: false }
      : { ...previous, failoverReady: false };
    h.state.snapshot = { ...h.state.snapshot!, transport };
    await h.complete(); assert.equal(h.shutdowns.length, 0);
  });
}

test("a last-instance leader may quit, but a leader with unverified survivors may not", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  h.state.snapshot = { ...h.state.snapshot!, transport: { role: "leader", cohortKey: "solo",
    survivorCount: 0, quitSupported: true, failoverReady: false } };
  await h.arm(); await h.complete(); assert.equal(h.shutdowns.length, 1);
  const blocked = harness(); t.after(() => blocked.runtime.dispose());
  blocked.state.snapshot = { ...blocked.state.snapshot!, transport: { ...h.state.snapshot!.transport, survivorCount: 1 } };
  assert.deepEqual(blocked.runtime.prepare(blocked.source), { ok: false, reason: "unsupported" });
});

for (const which of ["refresh", "acknowledge"] as const) {
  test(`${which} failure reopens admission without shutdown`, async (t) => {
    const h = harness({ [which]: async () => { throw new Error("private error must not be emitted"); } });
    t.after(() => h.runtime.dispose());
    assert.equal((await h.runtime.confirm(h.prepare())).ok, false);
    await h.complete(); assert.equal(h.shutdowns.length, 0);
    assert.equal(h.gate.getPhase(), "open");
    assert.equal(h.events.some((event) => event.includes("private error")), false);
  });
}

test("negative acknowledgement does not arm shutdown", async (t) => {
  const h = harness({ acknowledge: async () => false }); t.after(() => h.runtime.dispose());
  assert.deepEqual(await h.runtime.confirm(h.prepare()), { ok: false, reason: "acknowledgement-failed" });
  await h.complete(); assert.equal(h.shutdowns.length, 0);
});

test("expiry releases a hung port and a late success cannot arm a new confirmation", async (t) => {
  const ack = deferred<boolean>();
  const h = harness({ acknowledge: async () => ack.promise, confirmationTtlMs: 20 });
  t.after(() => h.runtime.dispose());
  const input = h.prepare(), confirming = h.runtime.confirm(input);
  await sleep(50); // A ref'ed wait also keeps the unref'ed expiry timer observable in the test.
  assert.equal((await confirming).ok, false);
  assert.equal(h.gate.getPhase(), "open");
  const next = h.prepare();
  ack.resolve(true); await tick();
  assert.equal(h.runtime.getPhase(), "offered");
  h.runtime.onUpdateCompleted(input.updateId, h.scope); await tick();
  assert.equal(h.shutdowns.length, 0);
  assert.equal(h.runtime.cancel(next), true);
});

test("cancellation and disposal invalidate awaited effects and cleanup authority", async (t) => {
  for (const action of ["cancel", "dispose"] as const) {
    const ack = deferred<boolean>(); let fence: TelegramQuitExecutionFence | undefined;
    const h = harness({ acknowledge: async (_confirmation, execution) => { fence = execution; return ack.promise; } });
    t.after(() => h.runtime.dispose());
    const input = h.prepare(), confirming = h.runtime.confirm(input); await tick();
    if (action === "cancel") h.runtime.cancel(input); else h.runtime.dispose();
    assert.equal((await confirming).ok, false);
    assert.equal(fence?.signal.aborted, true);
    assert.throws(() => fence?.assertCurrent(), /no longer current/);
    ack.reject(new Error("late rejection")); await tick(); await h.complete();
    assert.equal(h.shutdowns.length, 0);
  }
});

test("final refresh can expire or be disposed without triggering shutdown", async (t) => {
  const refresh = deferred<void>(); let count = 0;
  const h = harness({ refresh: async () => { if (++count === 2) await refresh.promise; } });
  t.after(() => h.runtime.dispose());
  await h.arm(); h.runtime.onUpdateCompleted(41, h.scope); await tick();
  h.runtime.dispose(); refresh.resolve(); await tick();
  assert.equal(h.shutdowns.length, 0);
  assert.equal(h.runtime.getCleanupConsent(h.scope), undefined);
});

test("a shutdown throw is outcome-unknown; sealed admission and consent cannot be retried", async (t) => {
  let calls = 0;
  const h = harness({ shutdown: () => { calls++; throw new Error("possibly already shutting down"); } });
  t.after(() => h.runtime.dispose());
  const input = await h.arm(); await h.complete();
  assert.equal(h.runtime.getPhase(), "outcome-unknown");
  assert.equal(h.gate.getPhase(), "sealed");
  assert.equal(h.runtime.getCleanupConsent(h.scope)?.automaticCleanup, false);
  assert.equal(h.runtime.cancel(input), false);
  assert.equal(h.runtime.prepare(h.source).ok, false);
  await h.complete(); assert.equal(calls, 1);
});

test("independent runtimes never share gate state, tokens, or consent", async (t) => {
  const a = harness(), b = harness(); t.after(() => { a.runtime.dispose(); b.runtime.dispose(); });
  const input = await a.arm();
  assert.equal((await b.runtime.confirm(input)).ok, false);
  assert.equal(b.gate.getPhase(), "open");
  await a.complete();
  assert.equal(b.runtime.getCleanupConsent(b.scope), undefined);
  assert.equal(b.shutdowns.length, 0);
});

test("unknown and throwing evidence, malformed identity, and expired offers fail closed", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  h.state.snapshot = undefined;
  assert.equal(h.runtime.prepare(h.source).ok, false);
  const broken = harness({ readSnapshot: () => { throw new Error("unavailable"); } });
  t.after(() => broken.runtime.dispose());
  assert.equal(broken.runtime.prepare(broken.source).ok, false);
  h.state.snapshot = makeSnapshot();
  assert.equal(h.runtime.prepare({ ...h.source, actorUserId: 8 }).ok, false);
  assert.equal(h.runtime.prepare({ ...h.source, messageId: 0 }).ok, false);
  const input = h.prepare(); h.state.now += 60_000;
  assert.deepEqual(await h.runtime.confirm(input), { ok: false, reason: "expired" });
  assert.throws(() => createTelegramQuitAdmissionGate({ ...h.scope, threadId: 0 }), /exact Thread scope/);
});

test("an armed confirmation expires without settlement and cannot shut down later", async (t) => {
  const h = harness({ confirmationTtlMs: 20 }); t.after(() => h.runtime.dispose());
  await h.arm(); await sleep(50);
  assert.equal(h.gate.getPhase(), "open");
  await h.complete(); assert.equal(h.shutdowns.length, 0);
});

test("retiring a gate revokes consent access and pending shutdown authority", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  await h.arm(); h.gate.invalidate(); await h.complete();
  assert.equal(h.shutdowns.length, 0);
  const committed = harness(); t.after(() => committed.runtime.dispose());
  await committed.arm(); await committed.complete();
  committed.gate.invalidate();
  assert.equal(committed.runtime.getCleanupConsent(committed.scope), undefined);
});

test("malformed scalar scope and evidence do not coerce into authority", (t) => {
  assert.throws(() => createTelegramQuitAdmissionGate({ ...makeScope(), threadId: "11" } as unknown as TelegramQuitScope), /exact Thread scope/);
  assert.throws(() => createTelegramQuitAdmissionGate({ ...makeScope(), instanceId: 1 } as unknown as TelegramQuitScope), /exact Thread scope/);
  const h = harness(); t.after(() => h.runtime.dispose());
  for (const bad of [
    { ...makeSnapshot(), automaticCleanup: "false" },
    { ...makeSnapshot(), transport: { ...makeSnapshot().transport, cohortKey: 1 } },
    { ...makeSnapshot(), transport: { ...makeSnapshot().transport, survivorCount: -1 } },
    { ...makeSnapshot(), transport: { ...makeSnapshot().transport, survivorCount: "0" } },
  ]) {
    h.state.snapshot = bad as unknown as TelegramQuitSnapshot;
    assert.equal(h.runtime.prepare(h.source).ok, false);
  }
});

test("diagnostics failure never changes an ambiguous shutdown into a retry", async (t) => {
  let count = 0;
  const h = harness({ shutdown: () => { count++; throw new Error("unknown"); },
    onFailure: () => { throw new Error("logging unavailable"); } });
  t.after(() => h.runtime.dispose());
  await h.arm(); await h.complete(); await h.complete();
  assert.equal(count, 1); assert.equal(h.runtime.getPhase(), "outcome-unknown");
});

test("local cleanup resolver uses committed consent, never settings fallback after invalidation", async (t) => {
  for (const cleanup of [false, true]) {
    const h = harness(); t.after(() => h.runtime.dispose());
    h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: cleanup };
    let reads = 0;
    const fallback = () => { reads++; return !cleanup; };
    assert.equal(await h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, fallback), !cleanup);
    assert.equal(reads, 1, "normal terminal quit still uses its existing policy resolver");
    await h.arm(); await h.complete();
    h.state.snapshot = { ...h.state.snapshot!, automaticCleanup: !cleanup };
    assert.equal(await h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, fallback), cleanup);
    assert.equal(reads, 1);
    assert.throws(() => h.runtime.resolveAutomaticThreadCleanupEnabled({ ...h.scope, sessionGeneration: 2 }, fallback), /unavailable/);
    h.gate.invalidate();
    assert.throws(() => h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, fallback), /unavailable/);
    h.runtime.dispose();
    assert.throws(() => h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, fallback), /unavailable/);
    assert.equal(reads, 1, "missing committed authority must never expand into current settings");
  }
});

test("local cleanup resolver retains consent after ambiguous shutdown and preserves async terminal fallback", async (t) => {
  const h = harness({ shutdown: () => { throw new Error("outcome unknown"); } });
  t.after(() => h.runtime.dispose());
  assert.equal(await h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, async () => true), true);
  await h.arm(); await h.complete();
  assert.equal(h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, () => assert.fail("must not read config")), false);
});

test("local cleanup resolver rechecks lifetime and commitment after awaiting terminal settings", async (t) => {
  const h = harness(); t.after(() => h.runtime.dispose());
  const settings = deferred<boolean>();
  const resolving = h.runtime.resolveAutomaticThreadCleanupEnabled(h.scope, () => settings.promise);
  h.runtime.dispose(); settings.resolve(true);
  await assert.rejects(Promise.resolve(resolving), /unavailable/);
  const current = harness(); t.after(() => current.runtime.dispose());
  const delayed = deferred<boolean>();
  const capturedLater = current.runtime.resolveAutomaticThreadCleanupEnabled(current.scope, () => delayed.promise);
  await current.arm(); await current.complete();
  delayed.resolve(true);
  assert.equal(await capturedLater, false, "an awaited setting cannot override a newly committed cleanup choice");
});

function deleteFirstPortFixture(attempt: Awaited<ReturnType<Parameters<typeof createTelegramFollowerDeleteFirstPort>[0]["disconnect"]>>) {
  const scope = makeScope(), registrationGeneration = "registration-1";
  let assertions = 0;
  const port = createTelegramFollowerDeleteFirstPort({ scope, registrationGeneration, disconnect: async () => attempt });
  const consent: TelegramQuitCleanupConsent = { scope, operationId: "delete-operation", updateId: 41, automaticCleanup: true };
  return { scope, registrationGeneration, consent, port, getAssertions: () => assertions,
    fence: { signal: new AbortController().signal, assertCurrent: () => { assertions++; } } };
}

test("follower delete-first port maps only exact confirmed deletion into consent authority", async () => {
  const scope = makeScope(), registrationGeneration = "registration-1";
  const h = deleteFirstPortFixture({ status: "disconnected", outcome: { instanceId: scope.instanceId,
    registrationGeneration, target: { chatId: scope.chatId, threadId: scope.threadId }, deletion: {
      kind: "follower-disconnect-result", instanceId: scope.instanceId, registrationGeneration,
      target: { chatId: scope.chatId, threadId: scope.threadId }, threadDeletion: "confirmed" } } });
  assert.deepEqual(await h.port(h.consent, h.fence), { status: "deleted", deletion: {
    scope: h.scope, operationId: h.consent.operationId, confirmed: true } });
  assert.equal(h.getAssertions(), 2);
});

test("follower delete-first port preserves certified refusal and treats every result mismatch as uncertain", async () => {
  const refused = deleteFirstPortFixture({ status: "refused", reason: "busy" });
  assert.deepEqual(await refused.port(refused.consent, refused.fence), { status: "refused", reason: "busy" });
  const base = { status: "disconnected" as const, outcome: { instanceId: makeScope().instanceId,
    registrationGeneration: "registration-1", target: { chatId: 7, threadId: 11 } } };
  for (const attempt of [undefined, base,
    { ...base, outcome: { ...base.outcome, instanceId: "other" } },
    { ...base, outcome: { ...base.outcome, registrationGeneration: "replacement" } },
    { ...base, outcome: { ...base.outcome, target: { chatId: 7, threadId: 12 } } },
  ]) {
    const h = deleteFirstPortFixture(attempt);
    assert.deepEqual(await h.port(h.consent, h.fence), attempt === undefined
      ? { status: "refused", reason: "changed" }
      : attempt === base ? { status: "disconnected-unconfirmed" } : { status: "outcome-unknown" });
  }
});

test("follower delete-first port rechecks local authority after the disconnect await", async () => {
  const scope = makeScope(), pending = deferred<Awaited<ReturnType<Parameters<typeof createTelegramFollowerDeleteFirstPort>[0]["disconnect"]>>>();
  let current = true;
  const port = createTelegramFollowerDeleteFirstPort({ scope, registrationGeneration: "registration-1", disconnect: () => pending.promise });
  const running = port({ scope, operationId: "op", updateId: 1, automaticCleanup: true }, {
    signal: new AbortController().signal, assertCurrent() { if (!current) throw new Error("stale"); } });
  current = false; pending.resolve({ status: "refused", reason: "busy" });
  await assert.rejects(running, /stale/);
});

function exitAfterDeletionFixture(overrides: Partial<Parameters<typeof createTelegramQuitAfterDeletion>[0]> = {}) {
  const scope = makeScope();
  const consent: TelegramQuitCleanupConsent = Object.freeze({ scope: Object.freeze(scope),
    operationId: "fixture-delete-operation", updateId: 41, automaticCleanup: true });
  const identity = { profileKey: scope.profileKey, botId: scope.botId, ownerUserId: scope.ownerUserId,
    chatId: scope.chatId, instanceId: scope.instanceId, processBirthId: scope.processBirthId,
    sessionId: scope.sessionId, sessionGeneration: scope.sessionGeneration };
  const state = { consent: consent as TelegramQuitCleanupConsent | undefined,
    snapshot: { identity, connection: "disconnected", quiescence: makeSnapshot().quiescence } as TelegramQuitExitSnapshot | undefined,
    shutdowns: 0, onRead: undefined as (() => void) | undefined };
  const runtime = createTelegramQuitAfterDeletion({ consent,
    getCleanupConsent: () => state.consent,
    readExitSnapshot: () => { state.onRead?.(); return state.snapshot; },
    shutdown: () => { state.shutdowns++; }, ...overrides });
  return { scope, consent, state, runtime,
    deletion: { scope, operationId: consent.operationId, confirmed: true } };
}

test("post-deletion exit uses fresh session identity without requiring the removed transport or Thread", () => {
  const h = exitAfterDeletionFixture();
  assert.equal("threadId" in h.state.snapshot!.identity, false);
  assert.equal("transportGeneration" in h.state.snapshot!.identity, false);
  assert.deepEqual(h.runtime.finish(h.deletion), { status: "shutdown-requested" });
  assert.equal(h.state.shutdowns, 1);
  h.runtime.finish(h.deletion);
  assert.equal(h.state.shutdowns, 1);
});

for (const key of ["agent", "piMessages", "telegramQueue", "dispatch", "compaction", "groupedInput", "acceptedInput", "delivery"] as const) {
  test(`post-deletion exit leaves ${key} work running and never quits later`, async () => {
    const h = exitAfterDeletionFixture();
    h.state.snapshot = { ...h.state.snapshot!, quiescence: { ...h.state.snapshot!.quiescence, [key]: "busy" } };
    assert.deepEqual(h.runtime.finish(h.deletion), { status: "left-running", reason: "busy" });
    h.state.snapshot = { ...h.state.snapshot, quiescence: makeSnapshot().quiescence };
    await tick();
    assert.deepEqual(h.runtime.finish(h.deletion), { status: "left-running", reason: "busy" });
    assert.equal(h.state.shutdowns, 0);
  });
}

test("post-deletion exit refuses every changed session identity component", () => {
  for (const key of Object.keys(exitAfterDeletionFixture().state.snapshot!.identity)) {
    const h = exitAfterDeletionFixture();
    h.state.snapshot = { ...h.state.snapshot!, identity: { ...h.state.snapshot!.identity, [key]: "changed" } };
    assert.deepEqual(h.runtime.finish(h.deletion), { status: "left-running", reason: "session-changed" });
    assert.equal(h.state.shutdowns, 0, key);
  }
});

for (const connection of ["connected", "unknown"] as const) {
  test(`post-deletion exit retains Pi with connection=${connection}`, () => {
    const h = exitAfterDeletionFixture(); h.state.snapshot = { ...h.state.snapshot!, connection };
    assert.deepEqual(h.runtime.finish(h.deletion), { status: "left-running", reason: connection });
    h.state.snapshot = { ...h.state.snapshot, connection: "disconnected" };
    h.runtime.finish(h.deletion); assert.equal(h.state.shutdowns, 0);
  });
}

test("post-deletion exit rejects missing, unconfirmed, wrong-operation and wrong-scope deletion results", () => {
  for (const variant of ["missing", "unconfirmed", "operation", "thread", "registration"] as const) {
    const h = exitAfterDeletionFixture();
    const deletion = variant === "missing" ? undefined : { ...h.deletion,
      confirmed: variant !== "unconfirmed", operationId: variant === "operation" ? "other" : h.deletion.operationId,
      scope: { ...h.scope, ...(variant === "thread" ? { threadId: 99 } : {}),
        ...(variant === "registration" ? { transportGeneration: "replacement" } : {}) } };
    assert.deepEqual(h.runtime.finish(deletion), { status: "left-running", reason: "cleanup-unconfirmed" });
    h.runtime.finish(h.deletion); assert.equal(h.state.shutdowns, 0, variant);
  }
});

test("post-deletion exit requires current consent through the final fresh read", () => {
  for (const late of [false, true]) {
    const h = exitAfterDeletionFixture();
    if (late) h.state.onRead = () => { h.state.consent = undefined; };
    else h.state.consent = { ...h.consent, operationId: "other" };
    assert.deepEqual(h.runtime.finish(h.deletion), { status: "left-running", reason: "consent-unavailable" });
    assert.equal(h.state.shutdowns, 0);
  }
});

test("post-deletion exit leaves Pi running on missing, malformed or throwing readiness", () => {
  for (const variant of ["missing", "incomplete", "unknown", "throw"] as const) {
    const h = exitAfterDeletionFixture();
    if (variant === "missing") h.state.snapshot = undefined;
    if (variant === "incomplete") h.state.snapshot = { ...h.state.snapshot!, quiescence: {} as TelegramQuitExitSnapshot["quiescence"] };
    if (variant === "unknown") h.state.snapshot = { ...h.state.snapshot!, quiescence: { ...h.state.snapshot!.quiescence, agent: "unknown" } };
    if (variant === "throw") h.state.onRead = () => { throw new Error("fixture read failed"); };
    assert.deepEqual(h.runtime.finish(h.deletion), { status: "left-running", reason: "unknown" });
    assert.equal(h.state.shutdowns, 0);
  }
});

test("post-deletion exit consumes actual foundation consent and respects its disposal", async (t) => {
  for (const revoke of [false, true]) {
    const owner = harness(); t.after(() => owner.runtime.dispose());
    owner.state.snapshot = { ...owner.state.snapshot!, automaticCleanup: true };
    await owner.arm(); await owner.complete();
    const consent = owner.runtime.getCleanupConsent(owner.scope)!;
    const h = exitAfterDeletionFixture({ consent, getCleanupConsent: owner.runtime.getCleanupConsent });
    if (revoke) owner.runtime.dispose();
    const result = h.runtime.finish({ scope: consent.scope, operationId: consent.operationId, confirmed: true });
    assert.deepEqual(result, revoke ? { status: "left-running", reason: "consent-unavailable" } : { status: "shutdown-requested" });
    assert.equal(h.state.shutdowns, revoke ? 0 : 1);
  }
});

test("post-deletion native shutdown throw is diagnosed, unknown and cannot be replayed", () => {
  let calls = 0, diagnosed = "";
  const h = exitAfterDeletionFixture({ shutdown: () => { calls++; throw new Error("fixture unknown shutdown"); },
    onShutdownError: (error) => { diagnosed = error instanceof Error ? error.message : String(error); } });
  assert.deepEqual(h.runtime.finish(h.deletion), { status: "shutdown-outcome-unknown" });
  assert.deepEqual(h.runtime.finish(h.deletion), { status: "shutdown-outcome-unknown" });
  assert.equal(calls, 1);
  assert.equal(diagnosed, "fixture unknown shutdown");
});

test("post-deletion shutdown is latched before a reentrant native callback", () => {
  let calls = 0;
  const h = exitAfterDeletionFixture({ shutdown: () => {
    calls++; assert.deepEqual(h.runtime.finish(h.deletion), { status: "shutdown-requested" });
  } });
  h.runtime.finish(h.deletion); assert.equal(calls, 1);
});

test("post-deletion exit cannot be constructed from keep-Thread consent", () => {
  const h = exitAfterDeletionFixture();
  assert.throws(() => exitAfterDeletionFixture({ consent: { ...h.consent, automaticCleanup: false } }), /delete-only consent/);
});

test("quit command is registered only after the live composition imports its authority owner", () => {
  assert.equal(TELEGRAM_BOT_COMMANDS.some((command) => command.command === "quit"), true);
  assert.equal((TELEGRAM_RESERVED_COMMAND_NAMES as readonly string[]).includes("quit"), true);
  assert.match(readFileSync(new URL("../lib/extension.ts", import.meta.url), "utf8"), /["']\.\/quit\.ts["']/);
});
