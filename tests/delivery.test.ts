/**
 * Telegram delivery API domain regressions
 * Zones: telegram delivery, extension API, runtime binding
 * Mirrors lib/delivery.ts and protects public operation delegation, generation fencing, and fail-soft availability
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTelegramDeliveryRuntime,
  clearTelegramDeliveryRuntime,
  createTelegramBridgeDeliveryRuntime,
  createTelegramDeliveryLifecycleHooks,
  createTelegramDeliveryTargetPolicyRuntime,
  createTelegramDeliveryRuntime as createConcreteDeliveryRuntime,
  deleteTelegramView,
  editTelegramView,
  isTelegramDeliveryExplicitTargetAuthorized,
  resolveTelegramDeliveryAggregateTarget,
  resolveTelegramDeliveryInstanceTarget,
  sendTelegramChatAction,
  sendTelegramView,
  type TelegramDeliveryHandle,
  type TelegramDeliveryRuntime,
  type TelegramDeliveryRuntimeDeps,
} from "../lib/delivery.ts";
import { TelegramApiCommitUnknownError } from "../lib/telegram-api.ts";

const target = { chatId: 42, threadId: 7 };

function createRuntime(
  generation: string,
  calls: string[] = [],
): TelegramDeliveryRuntime {
  return {
    generation,
    shutdown() {},
    async sendView() {
      calls.push("send");
      return {
        ok: true,
        value: { target, messageIds: [11], generation },
      };
    },
    async editView() {
      calls.push("edit");
      return {
        ok: true,
        value: { target, messageIds: [11], generation },
      };
    },
    async deleteView() {
      calls.push("delete");
      return { ok: true, value: undefined };
    },
    async sendChatAction(action) {
      calls.push(`action:${action}`);
      return { ok: true, value: undefined };
    },
  };
}

function handle(generation: string): TelegramDeliveryHandle {
  return { target, messageIds: [11], generation };
}

test.afterEach(() => clearTelegramDeliveryRuntime());

test("Delivery API fails softly while no runtime is bound", async () => {
  const result = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "runtime-unavailable",
    message: "Telegram delivery runtime is unavailable in this Pi session.",
  });
});

test("Delivery API delegates operations to the current runtime", async () => {
  const calls: string[] = [];
  bindTelegramDeliveryRuntime(createRuntime("one", calls));
  const sent = await sendTelegramView(
    { text: "hello", parseMode: "html" },
    { scope: { kind: "active-turn" }, replyToMessageId: 5 },
  );
  assert.equal(sent.ok, true);
  await editTelegramView(handle("one"), { text: "updated" });
  await deleteTelegramView(handle("one"));
  await sendTelegramChatAction("typing", {
    scope: { kind: "aggregate" },
  });
  assert.deepEqual(calls, ["send", "edit", "delete", "action:typing"]);
});

test("Delivery API rejects empty views before transport", async () => {
  const calls: string[] = [];
  bindTelegramDeliveryRuntime(createRuntime("one", calls));
  const result = await sendTelegramView(
    { text: "  " },
    { scope: { kind: "instance" } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid-view");
  assert.deepEqual(calls, []);
});

test("Delivery API fences handles from older runtime generations", async () => {
  const calls: string[] = [];
  bindTelegramDeliveryRuntime(createRuntime("new", calls));
  const edited = await editTelegramView(handle("old"), { text: "updated" });
  const deleted = await deleteTelegramView(handle("old"));
  assert.equal(edited.ok, false);
  assert.equal(deleted.ok, false);
  if (!edited.ok) assert.equal(edited.reason, "stale-handle");
  if (!deleted.ok) assert.equal(deleted.reason, "stale-handle");
  assert.deepEqual(calls, []);
});

test("A stale runtime disposer cannot clear its replacement", async () => {
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  const disposeFirst = bindTelegramDeliveryRuntime(
    createRuntime("first", firstCalls),
  );
  bindTelegramDeliveryRuntime(createRuntime("second", secondCalls));
  disposeFirst();
  await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.deepEqual(firstCalls, []);
  assert.deepEqual(secondCalls, ["send"]);
});

test("Delivery lifecycle mints fresh generations and invalidates on shutdown", async () => {
  const calls: string[] = [];
  let sequence = 0;
  const lifecycle = createTelegramDeliveryLifecycleHooks(() =>
    createRuntime(`generation-${++sequence}`, calls),
  );
  await lifecycle.onSessionStart();
  const active = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.equal(active.ok, true);
  if (!active.ok) return;

  await lifecycle.onSessionShutdown();
  const stopped = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.equal(stopped.reason, "runtime-unavailable");

  await lifecycle.onSessionStart();
  const replacement = await sendTelegramView(
    { text: "replacement" },
    { scope: { kind: "instance" } },
  );
  assert.equal(replacement.ok, true);
  if (replacement.ok) {
    assert.notEqual(replacement.value.generation, active.value.generation);
  }
  const staleEdit = await editTelegramView(active.value, { text: "stale" });
  const staleDelete = await deleteTelegramView(active.value);
  assert.equal(staleEdit.ok, false);
  assert.equal(staleDelete.ok, false);
  if (!staleEdit.ok) assert.equal(staleEdit.reason, "stale-handle");
  if (!staleDelete.ok) assert.equal(staleDelete.reason, "stale-handle");
  assert.deepEqual(calls, ["send", "send"]);
});

test("Delivery shutdown fences an in-flight chunk sequence and queued work", async () => {
  const transportCalls: string[] = [];
  let releaseFirstChunk: (() => void) | undefined;
  let markFirstChunkStarted: (() => void) | undefined;
  const firstChunkGate = new Promise<void>((resolve) => {
    releaseFirstChunk = resolve;
  });
  const firstChunkStarted = new Promise<void>((resolve) => {
    markFirstChunkStarted = resolve;
  });
  const runtime = createConcreteDeliveryRuntime({
    generation: "generation-one",
    getActiveTurnTarget: () => target,
    getInstanceTarget: () => target,
    getAggregateTarget: () => ({ chatId: target.chatId }),
    isExplicitTargetAuthorized: () => true,
    renderView: () => [
      { text: "first", parseMode: "html" },
      { text: "second", parseMode: "html" },
    ],
    async sendChunk() {
      transportCalls.push("send");
      if (transportCalls.length === 1) {
        markFirstChunkStarted?.();
        await firstChunkGate;
      }
      return 100 + transportCalls.length;
    },
    async editChunk() {
      transportCalls.push("edit");
    },
    async deleteMessage() {
      transportCalls.push("delete");
    },
    async sendChatAction() {
      transportCalls.push("action");
    },
  });

  const inFlight = runtime.sendView(
    { text: "two chunks" },
    { scope: { kind: "instance" } },
  );
  await firstChunkStarted;
  const queued = runtime.sendChatAction("typing", { kind: "instance" });
  runtime.shutdown();
  releaseFirstChunk?.();

  const [inFlightResult, queuedResult] = await Promise.all([inFlight, queued]);
  assert.equal(inFlightResult.ok, false);
  assert.equal(queuedResult.ok, false);
  if (!inFlightResult.ok) {
    assert.equal(inFlightResult.reason, "runtime-unavailable");
  }
  if (!queuedResult.ok) assert.equal(queuedResult.reason, "runtime-unavailable");
  assert.deepEqual(transportCalls, ["send"]);
});

test("Delivery API converts unexpected runtime errors into transport failures", async () => {
  const runtime = createRuntime("one");
  runtime.sendView = async () => {
    throw new Error("secret transport detail");
  };
  bindTelegramDeliveryRuntime(runtime);
  const result = await sendTelegramView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "transport-failed",
    message: "Telegram delivery failed.",
  });
});

test("Delivery target policy runtime projects live authority and excludes Guest turns", () => {
  let ownsDirect = false;
  let followerRegistered = true;
  let guestQueryId: string | undefined;
  const runtime = createTelegramDeliveryTargetPolicyRuntime({
    ownsDirect: () => ownsDirect,
    isFollowerRegistered: () => followerRegistered,
    getAllowedChatId: () => 42,
    getFollowerTarget: () => ({ chatId: 42, threadId: 7 }),
    getLeaderTarget: () => ({ chatId: 42, threadId: 8 }),
    listThreadRecords: () => [
      { target: { chatId: 42, threadId: 7 } },
      { target: { chatId: 42, threadId: 8 } },
    ],
    getActiveTurnTarget: () => ({ chatId: 42, threadId: 7 }),
    getActiveGuestQueryId: () => guestQueryId,
  });

  assert.deepEqual(runtime.getTargetPolicyView(), {
    canDeliver: true,
    ownsDirect: false,
    allowedChatId: 42,
    followerTarget: { chatId: 42, threadId: 7 },
    leaderTarget: { chatId: 42, threadId: 8 },
    liveTargets: [
      { chatId: 42, threadId: 7 },
      { chatId: 42, threadId: 8 },
    ],
  });
  assert.deepEqual(runtime.getActiveTurnTarget(), {
    chatId: 42,
    threadId: 7,
  });
  guestQueryId = "guest";
  assert.equal(runtime.getActiveTurnTarget(), undefined);
  followerRegistered = false;
  ownsDirect = false;
  assert.equal(runtime.getTargetPolicyView().canDeliver, false);
});

test("Delivery target policy resolves classic, leader, and follower instance surfaces", () => {
  assert.deepEqual(
    resolveTelegramDeliveryInstanceTarget({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
    }),
    { chatId: 42 },
  );
  assert.deepEqual(
    resolveTelegramDeliveryInstanceTarget({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
      leaderTarget: { chatId: 42, threadId: 3 },
    }),
    { chatId: 42, threadId: 3 },
  );
  assert.deepEqual(
    resolveTelegramDeliveryInstanceTarget({
      canDeliver: true,
      ownsDirect: false,
      allowedChatId: 42,
      followerTarget: { chatId: 42, threadId: 7 },
    }),
    { chatId: 42, threadId: 7 },
  );
  assert.deepEqual(
    resolveTelegramDeliveryAggregateTarget({
      canDeliver: true,
      ownsDirect: false,
      allowedChatId: 42,
    }),
    { chatId: 42 },
  );
});

test("Delivery target policy restricts follower and leader explicit targets", () => {
  const followerView = {
    canDeliver: true,
    ownsDirect: false,
    allowedChatId: 42,
    followerTarget: { chatId: 42, threadId: 7 },
  };
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized(
      { chatId: 42, threadId: 7 },
      followerView,
    ),
    true,
  );
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized(
      { chatId: 42, threadId: 8 },
      followerView,
    ),
    false,
  );
  const leaderView = {
    canDeliver: true,
    ownsDirect: true,
    allowedChatId: 42,
    leaderTarget: { chatId: 42, threadId: 3 },
    liveTargets: [{ chatId: 42, threadId: 8 }],
  };
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized(
      { chatId: 42, threadId: 8 },
      leaderView,
    ),
    true,
  );
  assert.equal(
    isTelegramDeliveryExplicitTargetAuthorized({ chatId: 99 }, leaderView),
    false,
  );
});

function createConcreteRuntimeHarness(
  overrides: Partial<TelegramDeliveryRuntimeDeps> = {},
) {
  let nextMessageId = 100;
  const events: Array<Record<string, unknown>> = [];
  const deps: TelegramDeliveryRuntimeDeps = {
    generation: "generation-one",
    getActiveTurnTarget: () => target,
    getInstanceTarget: () => target,
    getAggregateTarget: () => ({ chatId: target.chatId }),
    isExplicitTargetAuthorized: (candidate) => candidate.chatId === target.chatId,
    renderView: (view) =>
      view.text.split("|").map((text) => ({
        text,
        parseMode: view.parseMode ?? "plain",
      })),
    async sendChunk(deliveryTarget, chunk, options) {
      nextMessageId += 1;
      events.push({ type: "send", deliveryTarget, chunk, options, messageId: nextMessageId });
      return nextMessageId;
    },
    async editChunk(deliveryTarget, messageId, chunk, options) {
      events.push({ type: "edit", deliveryTarget, messageId, chunk, options });
    },
    async deleteMessage(deliveryTarget, messageId) {
      events.push({ type: "delete", deliveryTarget, messageId });
    },
    async sendChatAction(deliveryTarget, action) {
      events.push({ type: "action", deliveryTarget, action });
    },
    ...overrides,
  };
  return { runtime: createConcreteDeliveryRuntime(deps), events };
}

test("Bridge delivery runtime owns rendering and bus-aware transport adaptation", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const ownership: Array<Record<string, unknown>> = [];
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "generation-one",
    getTargetPolicyView: () => ({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
      leaderTarget: target,
    }),
    getActiveTurnTarget: () => target,
    api: {
      async sendMessage(body) {
        sentBodies.push(body);
        return { message_id: 101 };
      },
      async editMessageText() {
        return "edited";
      },
      async deleteMessage() {},
      async sendChatAction() {
        return true;
      },
    },
    recordOwnership(input) {
      ownership.push(input);
    },
  });

  const result = await runtime.sendView(
    { text: "<b>Working</b>", parseMode: "html" },
    { scope: { kind: "active-turn" }, replyToMessageId: 9 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(sentBodies, [
    {
      chat_id: 42,
      text: "<b>Working</b>",
      parse_mode: "HTML",
      message_thread_id: 7,
      reply_parameters: {
        message_id: 9,
        allow_sending_without_reply: true,
      },
    },
  ]);
  assert.deepEqual(ownership, [
    { chatId: 42, messageId: 101, target },
  ]);
});

test("Bridge delivery runtime rejects work after transport generation replacement", async () => {
  let transportActive = true;
  let apiCalls = 0;
  const runtime = createTelegramBridgeDeliveryRuntime({
    generation: "generation-one",
    isTransportActive: () => transportActive,
    getTargetPolicyView: () => ({
      canDeliver: true,
      ownsDirect: true,
      allowedChatId: 42,
      leaderTarget: target,
    }),
    getActiveTurnTarget: () => target,
    api: {
      async sendMessage() {
        apiCalls += 1;
        return { message_id: 101 };
      },
      async editMessageText() {
        apiCalls += 1;
        return "edited";
      },
      async deleteMessage() {
        apiCalls += 1;
      },
      async sendChatAction() {
        apiCalls += 1;
        return true;
      },
    },
    recordOwnership() {},
  });
  transportActive = false;

  const result = await runtime.sendView(
    { text: "stale" },
    { scope: { kind: "instance" } },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "runtime-unavailable");
  assert.equal(apiCalls, 0);
});

test("Concrete delivery runtime resolves scopes and rejects unauthorized targets", async () => {
  const { runtime, events } = createConcreteRuntimeHarness();
  const sent = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  const denied = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "target", target: { chatId: 99 } } },
  );
  assert.equal(sent.ok, true);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.reason, "target-unauthorized");
  assert.equal(events.length, 1);
});

test("Concrete delivery runtime keeps active-turn, instance, and aggregate scopes distinct", async () => {
  const activeTurnTarget = { chatId: 42, threadId: 7 };
  const instanceTarget = { chatId: 42, threadId: 3 };
  const aggregateTarget = { chatId: 42 };
  const { runtime, events } = createConcreteRuntimeHarness({
    getActiveTurnTarget: () => activeTurnTarget,
    getInstanceTarget: () => instanceTarget,
    getAggregateTarget: () => aggregateTarget,
  });

  await runtime.sendView(
    { text: "turn" },
    { scope: { kind: "active-turn" } },
  );
  await runtime.sendView(
    { text: "instance" },
    { scope: { kind: "instance" } },
  );
  await runtime.sendView(
    { text: "all" },
    { scope: { kind: "aggregate" } },
  );

  assert.deepEqual(
    events.map((event) => event.deliveryTarget),
    [activeTurnTarget, instanceTarget, aggregateTarget],
  );
});

test("Concrete delivery runtime anchors first chunk and keyboard on last chunk", async () => {
  const { runtime, events } = createConcreteRuntimeHarness();
  const replyMarkup = {
    inline_keyboard: [[{ text: "Run", callback_data: "demo:run" }]],
  };
  const result = await runtime.sendView(
    { text: "one|two", parseMode: "html", replyMarkup },
    { scope: { kind: "active-turn" }, replyToMessageId: 9 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    events.map((event) => event.options),
    [{ replyToMessageId: 9 }, { replyMarkup }],
  );
  if (result.ok) assert.deepEqual(result.value.messageIds, [101, 102]);
});

test("Concrete delivery runtime keeps handles opaque and deeply immutable", async () => {
  const { runtime } = createConcreteRuntimeHarness();
  const sent = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "instance" } },
  );
  assert.equal(sent.ok, true);
  if (!sent.ok) return;
  assert.equal(Object.isFrozen(sent.value), true);
  assert.equal(Object.isFrozen(sent.value.target), true);
  assert.equal(Object.isFrozen(sent.value.messageIds), true);
  assert.throws(() => {
    (sent.value.target as { threadId?: number }).threadId = 999;
  }, TypeError);
  const forged = {
    ...sent.value,
    target: { ...sent.value.target },
    messageIds: [...sent.value.messageIds],
  };
  const edited = await runtime.editView(forged, { text: "forged" });
  assert.equal(edited.ok, false);
  if (!edited.ok) assert.equal(edited.reason, "stale-handle");
});

test("Concrete delivery runtime exposes non-idempotent commit-unknown outcomes", async () => {
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      throw new TelegramApiCommitUnknownError(
        "sendMessage",
        new TypeError("fetch failed"),
      );
    },
  });
  const result = await runtime.sendView(
    { text: "hello" },
    { scope: { kind: "target", target } },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "commit-unknown",
    message: "Telegram delivery send may have committed before transport failed.",
  });
});

test("Concrete delivery runtime returns a recoverable handle after partial send failure", async () => {
  let sendCount = 0;
  const deleted: number[] = [];
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      sendCount += 1;
      if (sendCount === 2) throw new Error("second chunk failed");
      return 101;
    },
    async deleteMessage(_deliveryTarget, messageId) {
      deleted.push(messageId);
    },
  });

  const result = await runtime.sendView(
    { text: "one|two" },
    { scope: { kind: "instance" } },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "transport-failed");
  assert.deepEqual(result.partial?.messageIds, [101]);
  assert.equal(result.partial?.generation, "generation-one");
  assert.deepEqual(result.partial?.target, target);
  assert.ok(result.partial);
  const cleanup = await runtime.deleteView(result.partial);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(deleted, [101]);
});

test("Concrete delivery runtime returns all visible ids after edit growth failure", async () => {
  let growthSendCount = 0;
  const deleted: number[] = [];
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      growthSendCount += 1;
      if (growthSendCount === 3) throw new Error("growth chunk failed");
      return growthSendCount === 1 ? 11 : 12;
    },
    async deleteMessage(_deliveryTarget, messageId) {
      deleted.push(messageId);
    },
  });
  const initial = await runtime.sendView(
    { text: "one" },
    { scope: { kind: "instance" } },
  );
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const result = await runtime.editView(initial.value, {
    text: "one|two|three",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "transport-failed");
  assert.deepEqual(result.partial?.messageIds, [11, 12]);
  assert.ok(result.partial);
  const cleanup = await runtime.deleteView(result.partial);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(deleted, [11, 12]);
});

test("Concrete delivery runtime removes already-deleted ids from partial edit recovery", async () => {
  const deleteCalls: number[] = [];
  let failedOnce = false;
  const { runtime } = createConcreteRuntimeHarness({
    async deleteMessage(_deliveryTarget, messageId) {
      deleteCalls.push(messageId);
      if (messageId === 103 && !failedOnce) {
        failedOnce = true;
        throw new Error("shrink delete failed");
      }
    },
  });
  const initial = await runtime.sendView(
    { text: "one|two|three" },
    { scope: { kind: "instance" } },
  );
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const result = await runtime.editView(initial.value, { text: "one" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.partial?.messageIds, [101, 103]);
  assert.ok(result.partial);
  const cleanup = await runtime.deleteView(result.partial);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(deleteCalls, [102, 103, 101, 103]);
});

test("Concrete delivery runtime reconciles logical view growth and shrink", async () => {
  const { runtime, events } = createConcreteRuntimeHarness();
  const initial = await runtime.sendView(
    { text: "one" },
    { scope: { kind: "instance" } },
  );
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  events.length = 0;
  const grown = await runtime.editView(initial.value, { text: "one|two" });
  assert.equal(grown.ok, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["edit", "send"],
  );
  assert.deepEqual(events[0]?.options, { replyMarkup: null });
  if (!grown.ok) return;
  events.length = 0;
  const shrunk = await runtime.editView(grown.value, { text: "one" });
  assert.equal(shrunk.ok, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["edit", "delete"],
  );
  assert.deepEqual(events[0]?.options, { replyMarkup: null });
});

test("Concrete delivery runtime serializes operations per target", async () => {
  let releaseFirst: (() => void) | undefined;
  const order: string[] = [];
  const { runtime } = createConcreteRuntimeHarness({
    async sendChunk() {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
      return 201;
    },
    async sendChatAction() {
      order.push("action");
    },
  });
  const sending = runtime.sendView(
    { text: "one" },
    { scope: { kind: "instance" } },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const action = runtime.sendChatAction("typing", { kind: "instance" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["first-start"]);
  releaseFirst?.();
  await Promise.all([sending, action]);
  assert.deepEqual(order, ["first-start", "first-end", "action"]);
});
