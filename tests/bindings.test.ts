/**
 * Regression tests for Telegram binding composition
 * Covers lifecycle binding delegation across composed runtimes
 * Zones: telegram, pi agent, orchestration
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as waitForTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { MenuModel } from "../lib/model.ts";
import { createTelegramButtonActionStore } from "../lib/outbound-buttons.ts";



for (const kind of ["native", "copy", "missing", "mismatch"] as const)
test(`Private read-only binding forwards exact original lineage only (${kind})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-readonly-binding-")), agentDir = join(root, "agent"), script = join(root, "counter.mjs");
  await writeFile(script, 'export function init(){return {state:0,output:"ready"}} export function peek(){return {output:"next",viewMode:"edit"}}');
  const r = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script }), a = GenerativeApps.getGenerativeAppCallbackBinding(r), owner = GenerativeApps.captureGenerativeAppCallbackOwner(a)!;
  let reads = 0, enabled = true, plans = 0, child: unknown;
  const deps = { agentDir, callbackWorkerDrain: true as const, get callbackSuccessor(): true { reads++; return enabled as true; }, assertExecutionCurrent() {}, getExecutionFence() { return undefined; },
    planOutput(text: string, options?: Parameters<Parameters<typeof createTelegramGenerativeAppBoundButtonActionInvoker>[0]["planOutput"]>[1]) { plans++; child = options?.binding; return { markdown: text }; },
    async sendMarkdownReply() { assert.fail("No ordinary fallback"); }, async editInteractiveMessage() {}, recordRuntimeEvent() {} };
  try {
    const invoke = createTelegramGenerativeAppBoundButtonActionInvoker(deps); enabled = false;
    const binding = kind === "missing" ? undefined : kind === "copy" ? { ...a } : kind === "mismatch" ? { ...a, app: "foreign" } : a;
    const work = invoke({ text: "Peek", prompt: "counter::peek", ...(binding ? { binding } : {}) }, { message: { chat: { id: 42 }, message_id: 201 } });
    if (kind !== "native") { await assert.rejects(work, /callback origin is unavailable/u); assert.equal(plans, 0); }
    else { assert.equal(await work, "edit"); assert.equal(plans, 1); assert.ok(child); assert.equal(owner.captureReadOnlySuccessor!(child), GenerativeApps.captureGenerativeAppCallbackOwner(child)); }
    assert.equal(reads, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const bound of [false, true]) for (const changing of [false, true])
test(`Bound successor composition preserves ordinary execution without fabricating read-only lineage (${bound}/${changing})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pt-bound-successor-")), agentDir = join(root, "agent"), script = join(root, "counter.mjs");
  await writeFile(script, 'export function init(){return {state:0,output:"ready"}} export function peek(){return {output:"next",viewMode:"new"}} export function change({state}){return {state:state+1,output:"changed",viewMode:"new"}}');
  const installed = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script }), binding = GenerativeApps.getGenerativeAppCallbackBinding(installed), owner = GenerativeApps.captureGenerativeAppCallbackOwner(binding)!;
  let child: unknown, plans = 0;
  const invoke = createTelegramGenerativeAppBoundButtonActionInvoker({ agentDir, callbackWorkerDrain: true, callbackSuccessor: "bound", callbackDispatch: "qualified",
    assertExecutionCurrent() {}, getExecutionFence() { return undefined; },
    planOutput(text, options) { plans++; child = options?.binding; return { markdown: text }; }, async sendMarkdownReply() {}, recordRuntimeEvent() {} });
  try {
    assert.equal(await invoke({ text: "Run", prompt: changing ? "counter::change" : "counter::peek", ...(bound ? { binding } : {}) }, { message: { chat: { id: 42 }, message_id: 201 } }), "new");
    assert.equal(plans, 1); assert.ok(child);
    assert.equal(!!owner.captureReadOnlySuccessor!(child), bound && !changing, "Only an original bound, no-state-write invocation may issue lineage");
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const lost of [false, true])
test(`App Markdown editor pins its native port and execution instead of falling through to generic HTML (${lost})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pt-app-markdown-edit-")), agentDir = join(root, "agent"), script = join(root, "counter.mjs");
  await writeFile(script, 'export function init(){return {state:0,output:"ready"}} export function peek(){return {output:"next",viewMode:"edit"}}');
  const installed = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script }), binding = GenerativeApps.getGenerativeAppCallbackBinding(installed);
  let allowed = true, adopted = 0, edits = 0, sends = 0;
  const execution = { signal: new AbortController().signal, assertCurrent() { if (!allowed) throw Error("Original app edit execution lost"); } };
  const deps: Parameters<typeof createTelegramGenerativeAppBoundButtonActionInvoker>[0] = { agentDir, callbackWorkerDrain: true, callbackSuccessor: "bound",
    assertExecutionCurrent() {}, getExecutionFence() { return execution; },
    planOutput(text) { allowed = !lost; execution.assertCurrent = () => { adopted++; }; return { markdown: text }; },
    async editMarkdownMessage(chatId, messageId, text, markup, options) {
      assert.equal(this, deps); assert.equal(chatId, 42); assert.equal(messageId, 201); assert.equal(text, "next"); assert.deepEqual(markup, { inline_keyboard: [] });
      options!.assertLocalAuthority!(); edits++;
    }, async editInteractiveMessage() { assert.fail("No HTML downgrade"); }, async sendMarkdownReply() { sends++; }, recordRuntimeEvent() {} };
  try {
    const invoke = createTelegramGenerativeAppBoundButtonActionInvoker(deps);
    deps.editMarkdownMessage = async () => { assert.fail("No replacement editor"); };
    const work = invoke({ text: "Peek", prompt: "counter::peek", binding }, { message: { chat: { id: 42 }, message_id: 201 } });
    if (lost) await assert.rejects(work, /Original app edit execution lost/u); else assert.equal(await work, "edit");
    assert.equal(edits, lost ? 0 : 1); assert.equal(sends, 0); assert.equal(adopted, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const policy of [true, "bound"] as const)
test(`Successor invocation pins the original native binding before provider replacement (${policy})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pt-pinned-successor-")), agentDir = join(root, "agent"), script = join(root, "counter.mjs");
  await writeFile(script, 'export function init(){return {state:0,output:"ready"}} export function peek(){return {output:"next",viewMode:"new"}}');
  const installed = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script }), original = GenerativeApps.getGenerativeAppCallbackBinding(installed), owner = GenerativeApps.captureGenerativeAppCallbackOwner(original)!;
  const peer = GenerativeApps.getGenerativeAppCallbackBinding(await GenerativeApps.invokeGenerativeApp({ agentDir, app: "counter", method: "peek" })), peerOwner = GenerativeApps.captureGenerativeAppCallbackOwner(peer)!;
  const action = { text: "Peek", prompt: "counter::peek", binding: original };
  let child: unknown;
  const invoke = createTelegramGenerativeAppBoundButtonActionInvoker({ agentDir, callbackWorkerDrain: true, callbackSuccessor: policy,
    assertExecutionCurrent() {}, getLiveSurfaceRuntime() { action.binding = peer; return undefined; }, getExecutionFence() { return undefined; },
    planOutput(text, options) { child = options?.binding; return { markdown: text }; }, async sendMarkdownReply() {}, recordRuntimeEvent() {} });
  try {
    assert.notEqual(original, peer); assert.notEqual(owner, peerOwner);
    assert.equal(await invoke(action, { message: { chat: { id: 42 }, message_id: 201 } }), "new");
    assert.ok(owner.captureReadOnlySuccessor!(child)); assert.equal(peerOwner.captureReadOnlySuccessor!(child), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const value of [false, null, 1, "true", {}])
test(`Private read-only binding rejects invalid successor policy (${JSON.stringify(value)})`, () => {
  assert.throws(() => createTelegramGenerativeAppBoundButtonActionInvoker({ callbackWorkerDrain: true, callbackSuccessor: value } as never), /Callback successor requires true or bound and original worker drain/u);
});
test("Private read-only binding requires original worker drain opt-in", () => {
  assert.throws(() => createTelegramGenerativeAppBoundButtonActionInvoker({ callbackSuccessor: true } as never), /Callback successor requires true or bound and original worker drain/u);
  assert.throws(() => createTelegramGenerativeAppBoundButtonActionInvoker({ callbackSuccessor: "bound" } as never), /Callback successor requires true or bound and original worker drain/u);
});

for (const loss of [false, true])
test(`Private callback worker binding pins policy and original execution factory (${loss})`, { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-callback-worker-binding-")), agentDir = join(root, "agent"), script = join(root, "counter.mjs");
  await writeFile(script, 'export function init(){return {state:0,output:"ready"}} export function peek(){return {output:"next",viewMode:"edit"}}');
  const installed = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script }), binding = GenerativeApps.getGenerativeAppCallbackBinding(installed);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), nativeTerminate = Worker.prototype.terminate;
  let active = true, plans = 0, edits = 0, captures = 0, flagReads = 0, foreignFactories = 0, callSlots = 0, worker: Worker | undefined;
  t.mock.method(Worker.prototype, "terminate", function(this: Worker) { worker = this; entered.resolve(); return release.promise.then(() => Reflect.apply(nativeTerminate, this, [])); });
  const controller = new AbortController(), fence = { signal: controller.signal, assertCurrent() { if (!active) throw Error("Original source lost"); } };
  const deps = { agentDir, get callbackWorkerDrain(): true { flagReads++; return true; }, assertExecutionCurrent() { fence.assertCurrent(); },
    getExecutionFence() { assert.equal(this, deps); captures++; return fence; },
    planOutput(text: string) { plans++; return { markdown: text }; },
    async sendMarkdownReply() { assert.fail("No new-message fallback"); }, async editInteractiveMessage() { edits++; }, recordRuntimeEvent() {} };
  const factory = deps.getExecutionFence, invoke = createTelegramGenerativeAppBoundButtonActionInvoker(deps);
  deps.getExecutionFence = () => { foreignFactories++; return Reflect.apply(factory, deps, []); };
  Object.defineProperty(factory, "call", { value: () => { callSlots++; return Reflect.apply(factory, deps, []); } });
  let settled = false;
  const outcome = invoke({ text: "Peek", prompt: "counter::peek", binding }, { message: { chat: { id: 42 }, message_id: 201 } }).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  const observed = outcome.then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise; await waitForTurn(); assert.equal(plans, 0); assert.equal(edits, 0); assert.equal(settled, false); assert.ok(worker!.threadId > 0);
    if (loss) active = false; release.resolve(); const result = await observed;
    assert.equal("error" in result, loss); assert.equal(plans, loss ? 0 : 1); assert.equal(edits, loss ? 0 : 1); assert.equal(captures, 1); assert.equal(flagReads, 1); assert.equal(foreignFactories, 0); assert.equal(callSlots, 0);
    assert.equal(worker!.threadId, -1);
  } finally { release.resolve(); await observed; t.mock.restoreAll(); controller.abort(); await rm(root, { recursive: true, force: true }); }
});
for (const drained of [false, true])
test(`Bound app new replies retain the original callback target across asynchronous providers (drain=${drained})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pt-callback-target-")), agentDir = join(root, "agent"), script = join(root, "counter.mjs");
  await writeFile(script, 'export function init(){return {state:0,output:"ready"}} export function next(){return {output:"next",viewMode:"new"}}');
  const result = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script }), binding = GenerativeApps.getGenerativeAppCallbackBinding(result);
  const query = { message: { chat: { id: 42 }, message_id: 201, message_thread_id: 11 } }, controller = new AbortController();
  let target: unknown;
  const invoke = createTelegramGenerativeAppBoundButtonActionInvoker<typeof query>({
    agentDir, ...(drained ? { callbackWorkerDrain: true as const } : {}), assertExecutionCurrent() {},
    getLiveSurfaceRuntime() { query.message.message_thread_id = 88; return undefined; },
    getExecutionFence(value) { value.message.message_thread_id = 99; return { signal: controller.signal, assertCurrent() {} }; },
    planOutput(text) { return { markdown: text }; }, async sendMarkdownReply(_chatId, _messageId, _text, options) { target = options?.target; }, recordRuntimeEvent() {},
  });
  try {
    assert.equal(await invoke({ text: "Next", prompt: "counter::next", binding }, query), "new");
    assert.equal(query.message.message_thread_id, 99); assert.deepEqual(target, { chatId: 42, threadId: 11 });
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});

test("Private callback worker binding refuses a missing private execution factory", () => {
  assert.throws(() => createTelegramGenerativeAppBoundButtonActionInvoker({ callbackWorkerDrain: true } as never), /Callback worker execution capture is unavailable/u);
});
test("Private callback worker binding omission does not read an unrelated execution getter", () => {
  assert.equal(typeof createTelegramGenerativeAppBoundButtonActionInvoker({ get getExecutionFence() { return assert.fail("Omitted policy must not capture a factory"); } } as never), "function");
});
for (const value of [false, null, 1, "true", {}])
test(`Private callback worker binding rejects invalid constructor policy (${JSON.stringify(value)})`, () => {
  assert.throws(() => createTelegramGenerativeAppBoundButtonActionInvoker({ callbackWorkerDrain: value } as never), /Callback worker drain must be true or omitted/u);
});

for (const name of ["status", "abort"] as const) for (const mode of ["current", "unavailable", "unsupported", "missing-command", "missing-menu", "recipient-port", "command-port", "availability-port", "command-name", "menu-port", "deliver-port", "wrong-context", "wrong-target", "wrong-recipient", "target-copy", "getter-command"] as const) {
  test(`Selected command binding composes captured owners without activation or ordinary fallback (${name}/${mode})`, () => {
    const ctx = { id: "ctx" }, target = { chatId: 7, threadId: 42 };
    let active = mode !== "unavailable", preparations = 0, effects = 0, getterDrift = false;
    const assertRecipientCurrent = () => { effects++; assert.fail("Preparation must not activate the future recipient"); };
    const recipient = { isCurrent: () => { if (getterDrift) command.prepareHeldCommand = () => undefined; return active; }, assertRecipientCurrent };
    const command = { canPrepareHeldCommand: () => mode !== "unsupported", prepareHeldCommand(...args: Parameters<Parameters<typeof createTelegramFollowerSelectedCommandBinding<typeof ctx, MenuModel>>[0]["command"]["prepareHeldCommand"]>) {
      preparations++; assert.equal(args[0], name); assert.equal(args[2], ctx); assert.equal(args[3].assertRecipientCurrent, assertRecipientCurrent); assert.deepEqual(args[3].target, { chatId: 7, threadId: 42 });
      assert.equal(typeof args[4]?.[name === "status" ? "showStatus" : "sendTextReply"], "function"); return undefined;
    } };
    const noEffect = () => { effects++; assert.fail("No rendering/state/transport during availability or preparation"); };
    const deps = { name: name as string, ctx, operationId: "operation", registrationGeneration: "registration", target, recipient, command,
      menu: { getModelMenuState: async () => noEffect(), getActiveModel: () => undefined, getThinkingLevel: () => "medium" as const,
        buildStatusHtml: noEffect, storeModelMenuState: noEffect, isIdle: () => true, canOfferInFlightModelSwitch: () => false },
      deliver: async () => noEffect(), recordOwnership: noEffect };
    if (mode === "missing-command") Reflect.deleteProperty(command, "prepareHeldCommand");
    if (mode === "missing-menu") Reflect.deleteProperty(deps.menu, "getModelMenuState");
    const bound = createTelegramFollowerSelectedCommandBinding(deps);
    if (["unavailable", "unsupported", "missing-command", "missing-menu"].includes(mode)) { assert.equal(bound, undefined); assert.equal(effects, 0); return; }
    assert.ok(bound); assert.equal(bound.isCurrent(), true); assert.equal(bound.assertRecipientCurrent, assertRecipientCurrent);
    if (mode === "target-copy") target.threadId = 99;
    if (mode === "recipient-port") recipient.assertRecipientCurrent = () => noEffect();
    if (mode === "command-port") command.prepareHeldCommand = () => undefined;
    if (mode === "availability-port") command.canPrepareHeldCommand = () => true;
    if (mode === "command-name") deps.name = "stop";
    if (mode === "menu-port") deps.menu.getModelMenuState = async () => noEffect();
    if (mode === "deliver-port") deps.deliver = async () => noEffect();
    if (mode === "getter-command") getterDrift = true;
    if (["recipient-port", "command-port", "availability-port", "command-name", "menu-port", "deliver-port", "getter-command"].includes(mode)) assert.equal(bound.isCurrent(), false);
    bound.prepare(undefined as unknown as Parameters<typeof bound.prepare>[0], mode === "wrong-context" ? { id: "other" } : ctx,
      { target: mode === "wrong-target" ? { chatId: 7, threadId: 99 } : { chatId: 7, threadId: 42 }, assertSourceCurrent: noEffect,
        assertRecipientCurrent: mode === "wrong-recipient" ? noEffect : assertRecipientCurrent });
    assert.equal(preparations, mode === "current" || mode === "target-copy" ? 1 : 0); assert.equal(effects, 0);
    active = false; assert.equal(bound.isCurrent(), false);
  });
}

import {
  createTelegramActivityBindingRuntime,
  createTelegramAgentMessageToolRoutingRuntime,
  createTelegramAssistantOutputBindingRuntime,
  createTelegramQueueBindingRuntime,
  createTelegramLiveTargetWorkObserver,
  createTelegramFollowerSelectedCommandBinding,
  createTelegramGenerativeAppBoundButtonActionInvoker,
  createTelegramGenerativeAppLiveSurfaceBinding,
  registerTelegramCommandsAndTools,
  registerTelegramLifecycleRuntimeHooks,
} from "../lib/bindings.ts";
import * as Activity from "../lib/activity.ts";
import * as Config from "../lib/config.ts";
import * as Bus from "../lib/bus.ts";
import * as BusApi from "../lib/bus-api.ts";
import * as BusFollower from "../lib/bus-follower.ts";
import * as BusLeader from "../lib/bus-leader.ts";
import type { TelegramBridgeApiRuntime } from "../lib/telegram-api.ts";
import { createTelegramApiTargetActivityRuntime } from "../lib/telegram-api.ts";
import { createTelegramDeliveryLifecycleHooks, createTelegramDeliveryRuntime } from "../lib/delivery.ts";
import * as Outbound from "../lib/outbound.ts";
import * as OutboundAttachments from "../lib/outbound-attachments.ts";
import * as Queue from "../lib/queue.ts";
import * as Runtime from "../lib/runtime.ts";
import * as Commands from "../lib/commands.ts";
import * as Menu from "../lib/menu.ts";
import * as Replies from "../lib/replies.ts";
import * as Journal from "../lib/journal.ts";
import * as Updates from "../lib/updates.ts";
import { prepareLiveRebindThreadCleanup } from "../lib/thread-reconciler.ts";
import * as GenerativeApps from "../lib/generative-apps.ts";
import type { TelegramQueueAdmissionItemLike } from "../lib/updates.ts";
import type { ExtensionAPI, ExtensionContext, TurnEndEventResult } from "../lib/pi.ts";

test("Live target work projection observes existing work and pre-API delivery owners without mutation", async () => {
  const old = { chatId: 7, threadId: 10 }, next = { chatId: 7, threadId: 42 }, ctx = {};
  const lifecycle = Runtime.createTelegramBridgeRuntime().lifecycle;
  const queue = Queue.createTelegramQueueStore(), activeTurn = Queue.createTelegramActiveTurnStore();
  const publication = Activity.createTelegramActivityPublicationRuntime();
  const activity = Activity.createTelegramActivityBridgeRuntime({ generation: "work" });
  const api = createTelegramApiTargetActivityRuntime();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let idle = true, pendingMessages = false, pendingControl = false;
  const delivery = createTelegramDeliveryLifecycleHooks(() => createTelegramDeliveryRuntime({ generation: "work", getActiveTurnTarget: () => old,
    getInstanceTarget: () => next, getAggregateTarget: () => next, isExplicitTargetAuthorized: () => true,
    renderView: view => [{ text: view.text, parseMode: "markdown" }],
    async sendChunk() { started.resolve(); await finish.promise; return 1; },
    async editChunk() {}, async deleteMessage() {}, async sendChatAction() {},
  }));
  const observe = createTelegramLiveTargetWorkObserver({ queue, activeTurn, lifecycle, publication, activity, delivery, api,
    isIdle: () => idle, hasPendingMessages: () => pendingMessages, hasPendingControl: () => pendingControl });
  const clear = { sessionBusy: false, targetWork: false, deliveryPending: false, unknown: false };
  const turn: Queue.PendingTelegramTurn = { kind: "prompt", chatId: 7, target: old, queueOrder: 1, queueLane: "default", laneOrder: 1,
    statusSummary: "held", replyToMessageId: 1, sourceMessageIds: [1], queuedAttachments: [], content: [], historyText: "", reactionSuppressionEmoji: "💩" };
  assert.equal(observe(old, ctx).unknown, true, "Unavailable activity/delivery owners are not settled");
  activity.onSessionStart?.(); await delivery.onSessionStart();
  try {
    assert.deepEqual(observe(old, ctx), clear);
    for (const flag of ["idle", "messages", "control", "dispatch", "compaction", "tools"] as const) {
      if (flag === "idle") idle = false;
      if (flag === "messages") pendingMessages = true;
      if (flag === "control") pendingControl = true;
      if (flag === "dispatch") lifecycle.setDispatchPending(true);
      if (flag === "compaction") lifecycle.setCompactionInProgress(true);
      if (flag === "tools") lifecycle.setActiveToolExecutions(1);
      assert.deepEqual(observe(old, ctx), { ...clear, sessionBusy: true }, flag);
      idle = true; pendingMessages = pendingControl = false; lifecycle.clearDispatchPending(); lifecycle.setCompactionInProgress(false); lifecycle.resetActiveToolExecutions();
    }
    activeTurn.set(turn); queue.setQueuedItems([turn]);
    const queued = queue.getQueuedItems(), active = structuredClone(activeTurn.get());
    assert.equal(observe(old, ctx).targetWork, true, "Skip/receipt-held work still owns its captured target");
    assert.equal(observe(next, ctx).targetWork, false, "Local rebinding cannot move captured work to the new target");
    assert.equal(queue.getQueuedItems(), queued); assert.deepEqual(activeTurn.get(), active);
    activeTurn.clear(); assert.equal(observe(old, ctx).targetWork, true, "A skipped physical item still owns its receipt/delivery target");
    queue.setQueuedItems([]);
    const reservation = publication.reserve();
    assert.deepEqual(observe(old, ctx), { ...clear, deliveryPending: true }, "A final reservation protects delivery before any API call");
    await reservation.publish(async () => {}); assert.deepEqual(observe(old, ctx), clear);
    const endApi = api.begin("editMessageText", { chat_id: 7, message_id: 1 });
    assert.equal(observe(old, ctx).deliveryPending, true, "Unaddressed chat edits protect all Threads in that chat");
    assert.equal(observe({ chatId: 8, threadId: 10 }, ctx).deliveryPending, false);
    endApi(); assert.deepEqual(observe(old, ctx), clear);
    // The logical Delivery queue is occupied before and between actual transport calls.
    const { sendTelegramView } = await import("../lib/delivery.ts");
    const sending = sendTelegramView({ text: "old reply" }, { scope: { kind: "target", target: old } });
    await started.promise;
    const second = sendTelegramView({ text: "queued reply" }, { scope: { kind: "target", target: old } });
    assert.equal(api.hasPendingTarget(old), false, "No fake API request is needed to expose logical pending delivery");
    assert.equal(observe(old, ctx).deliveryPending, true); assert.equal(observe(next, ctx).deliveryPending, false);
    finish.resolve(); await Promise.all([sending, second]); assert.deepEqual(observe(old, ctx), clear);
    queue.setQueuedItems([{ ...turn, target: undefined }]);
    assert.equal(observe(old, ctx).unknown, true, "An unaddressed same-chat item is not known-clear");
    queue.setQueuedItems([{ ...turn, target: { chatId: 8, threadId: 10 } }]);
    assert.equal(observe(old, ctx).unknown, true, "Contradictory captured namespace is not known-clear");
  } finally { finish.resolve(); activity.onSessionShutdown(); await delivery.onSessionShutdown(); }
  assert.equal(observe(old, ctx).unknown, true);
});

for (const stopped of [false, true]) test(`Native disposed old-target command rendering remains protected through pre-API work and late uncertainty (${stopped ? "stopped" : "running"})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-command-work-")), old = { chatId: 7, threadId: 10 }, next = { chatId: 7, threadId: 42 }, ctx = {};
  const publication = Activity.createTelegramActivityPublicationRuntime(), activity = Activity.createTelegramActivityBridgeRuntime({ generation: "command-work" });
  const api = createTelegramApiTargetActivityRuntime(), lifecycle = Runtime.createTelegramBridgeRuntime().lifecycle;
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), renderedDone = Promise.withResolvers<void>();
  const requests: Record<string, unknown>[] = [];
  const delivery = createTelegramDeliveryLifecycleHooks(() => createTelegramDeliveryRuntime({ generation: "command-work", getActiveTurnTarget: () => old,
    getInstanceTarget: () => next, getAggregateTarget: () => next, isExplicitTargetAuthorized: () => true, renderView: view => [{ text: view.text, parseMode: "markdown" }],
    async sendChunk() { return 1; }, async editChunk() {}, async deleteMessage() {}, async sendChatAction() {} }));
  const observe = createTelegramLiveTargetWorkObserver({ publication, activity, delivery, api, lifecycle, queue: Queue.createTelegramQueueStore(), activeTurn: Queue.createTelegramActiveTurnStore(),
    isIdle: () => true, hasPendingMessages: () => false, hasPendingControl: () => false });
  const rendered = Replies.createTelegramRenderedMessageDeliveryRuntime({ async sendMessage(body) {
    const end = api.begin("sendMessage", body); requests.push(body as unknown as Record<string, unknown>); end(); return { message_id: 700 };
  }, async sendRichMessage() { assert.fail("No rich fallback"); }, async editMessage() { assert.fail("No edit"); } });
  const state: Menu.TelegramModelMenuState = { chatId: 7, threadId: 10, messageId: 0, mode: "model", scope: "all", page: 0, scopedModels: [], allModels: [] };
  const menus = Menu.createTelegramMenuActionRuntime({ async getModelMenuState() { entered.resolve(); await finish.promise; return state; }, storeModelMenuState() { renderedDone.resolve(); },
    buildStatusHtml: () => "<b>Old-target status</b>", getActiveModel: () => undefined, getThinkingLevel: () => "medium", isIdle: () => true, canOfferInFlightModelSwitch: () => false,
    sendTextReply: rendered.sendTextReply, sendInteractiveMessage: rendered.sendInteractiveMessage, editInteractiveMessage: rendered.editInteractiveMessage });
  const command = Commands.createTelegramCommandHandlerTargetRuntime<Commands.TelegramCommandRuntimeMessage, typeof ctx>({ getAllowedUserId: () => 7,
    assertExecutionCurrent: Updates.assertTelegramUpdateExecutionCurrent, isContextActive: () => true, showStatus: menus.sendStatusMessage,
    beginCommandEffectWork: publication.beginWork, recordRuntimeEvent() {} } as unknown as Parameters<typeof Commands.createTelegramCommandHandlerTargetRuntime<Commands.TelegramCommandRuntimeMessage, typeof ctx>>[0]);
  const journal = Journal.createTelegramUpdateJournalStore({ path: join(dir, "source.json"), botIdentity: Journal.createTelegramUpdateJournalBotIdentity({ botToken: "command-work-fixture" }) });
  const worker = Updates.createTelegramUpdateAdmissionWorkerRuntime<Journal.TelegramJournaledUpdate, typeof ctx>({ journal, getJournalBindingKey: () => "command-work-source", hasAuthority: () => true,
    isContextCurrent: () => true, getQueueOwnerIdentity: () => ({ instanceId: "leader", processId: process.pid, processBirthId: `${process.pid}:command-work`, sessionGeneration: 1 }),
    async defaultHandle(update) { await command("status", update.message as Commands.TelegramCommandRuntimeMessage, ctx); } });
  activity.onSessionStart?.(); await delivery.onSessionStart(); worker.start(ctx); await worker.waitForDrain();
  const preparation = () => prepareLiveRebindThreadCleanup({ operationId: "command-work", oldTarget: old, recipientTarget: next, leaderEpoch: "epoch", targetProtected: false, work: observe(old, ctx) });
  try {
    journal.appendBatch([{ update_id: 100, message: { message_id: 100, message_thread_id: 10, text: "/status", chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false } } }]);
    worker.signal(); await worker.waitForDrain(); await entered.promise; assert.equal(journal.read().entries.length, 0); if (stopped) await worker.stop();
    assert.equal(requests.length, 0); assert.equal(api.hasPendingTarget(old), false); assert.equal(observe(old, ctx).deliveryPending, true); assert.equal(preparation(), undefined);
    let ordered = false; await publication.enqueue(async () => { ordered = true; }); assert.equal(ordered, true, "No ordering or ordinary-send change");
    finish.resolve(); await renderedDone.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1); assert.equal(requests[0]!.message_thread_id, 10); assert.equal(state.messageId, 700);
    assert.equal(publication.hasPending(), false); assert.equal(publication.hasUnconfirmed(), stopped, "Lost post-effect source authority is not known idle");
    assert.equal(observe(old, ctx).unknown, stopped); assert.equal(!!preparation(), !stopped);
    publication.reset(); assert.equal(observe(old, ctx).unknown, false); assert.equal(requests.length, 1, "Lifecycle reset never replays work");
  } finally { finish.resolve(); await worker.stop(); activity.onSessionShutdown(); await delivery.onSessionShutdown(); await rm(dir, { recursive: true, force: true }); }
});

type RegisteredBindingHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

type RegisteredBindingTool = {
  name?: string;
  execute: (
    toolCallId: string,
    params: Record<string, string>,
  ) => Promise<unknown>;
};

function createBindingApiHarness() {
  const handlers = new Map<string, RegisteredBindingHandler>();
  const tools = new Map<string, RegisteredBindingTool>();
  const commands = new Map<string, unknown>();
  const messages: Array<{ message: unknown; options?: unknown }> = [];
  const api = {
    on: (event: string, handler: RegisteredBindingHandler) => {
      handlers.set(event, handler);
    },
    registerTool: (definition: RegisteredBindingTool) => {
      if (definition.name) tools.set(definition.name, definition);
    },
    registerCommand: (name: string, definition: unknown) => {
      commands.set(name, definition);
    },
    sendMessage: (message: unknown, options?: unknown) => {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, tools, commands, messages };
}

test("Generative App live-surface binding shuts down and clears session authority", () => {
  const binding = createTelegramGenerativeAppLiveSurfaceBinding();
  let shutdowns = 0;
  binding.set({ shutdown: () => { shutdowns += 1; } } as unknown as GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>);

  binding.shutdown();
  binding.shutdown();

  assert.equal(shutdowns, 1);
  assert.equal(binding.get(), undefined);
});

test("Generative App bound-button composition leaves unbound ordinary prompts to the prompt plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-binding-ordinary-"));
  const events: unknown[] = [];
  try {
    const invoke = createTelegramGenerativeAppBoundButtonActionInvoker({
      agentDir: join(root, "agent"),
      assertExecutionCurrent: () => undefined,
      getExecutionFence: () => undefined,
      planOutput: Outbound.createTelegramOutboundReplyPlanner(
        Outbound.createTelegramButtonActionStore(),
      ),
      sendMarkdownReply: async () => {
        throw new Error("must not send");
      },
      recordRuntimeEvent: (...args) => {
        events.push(args);
      },
    });
    const query = { message: { chat: { id: 1 }, message_id: 2 } };
    for (const prompt of [
      "Check std::map usage",
      "std::map",
      "poker::fold trailing",
      "Poker::fold",
      "cargo test foo::bar({x})",
      "tool::run()",
      "ghost::fold",
    ]) {
      assert.equal(await invoke({ prompt, text: "Option" }, query), false, prompt);
    }
    assert.deepEqual(events, []);
    await assert.rejects(
      invoke(
        {
          prompt: "poker::fold trailing",
          text: "Option",
          binding: { generation: "g", app: "poker", revision: 0 },
        },
        query,
      ),
      /Malformed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App bound-button composition rejects a retained stale revision before delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-binding-app-"));
  const agentDir = join(root, "agent");
  const script = join(root, "counter.mjs");
  const store = Outbound.createTelegramButtonActionStore();
  const edited: string[] = [];
  const sent: string[] = [];
  try {
    await writeFile(
      script,
      `
export function init() { return { state: { count: 0 }, output: "ready" }; }
export function increment({ state }) {
  return { state: { count: state.count + 1 }, output: "next", viewMode: "edit" };
}
`,
      "utf8",
    );
    const installed = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script });
    const execution = new AbortController();
    const invoke = createTelegramGenerativeAppBoundButtonActionInvoker({
      agentDir,
      assertExecutionCurrent: () => undefined,
      getExecutionFence: () => ({
        assertCurrent: () => undefined,
        signal: execution.signal,
      }),
      planOutput: Outbound.createTelegramOutboundReplyPlanner(store),
      sendMarkdownReply: async (_chatId, _messageId, markdown) => {
        sent.push(markdown);
      },
      editInteractiveMessage: async (_chatId, _messageId, markdown) => {
        edited.push(markdown);
      },
      recordRuntimeEvent: () => undefined,
    });
    const action = {
      binding: { generation: installed.generation, app: "counter", revision: 0 },
      prompt: "counter::increment",
      text: "Next",
    };
    assert.equal(
      await invoke(
        action,
        { message: { chat: { id: 1 }, message_id: 2 } },
      ),
      "edit",
    );
    assert.deepEqual(edited, ["next"]);
    const invokeWithFallback = createTelegramGenerativeAppBoundButtonActionInvoker({
      agentDir,
      assertExecutionCurrent: () => undefined,
      getExecutionFence: () => ({
        assertCurrent: () => undefined,
        signal: execution.signal,
      }),
      planOutput: Outbound.createTelegramOutboundReplyPlanner(store),
      sendMarkdownReply: async (_chatId, _messageId, markdown) => {
        sent.push(markdown);
      },
      editInteractiveMessage: async () => {
        throw new Error("message not found");
      },
      recordRuntimeEvent: () => undefined,
    });
    assert.equal(
      await invokeWithFallback(
        {
          ...action,
          binding: {
            generation: installed.generation,
            app: "counter",
            revision: 1,
          },
        },
        { message: { chat: { id: 1 }, message_id: 2 } },
      ),
      "new",
    );
    assert.deepEqual(sent, ["next"]);
    await assert.rejects(
      invoke(
        action,
        { message: { chat: { id: 1 }, message_id: 2 } },
      ),
      /action is stale/,
    );
    assert.deepEqual(edited, ["next"]);
    assert.deepEqual(sent, ["next"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Generative App bound action edits and reschedules the exact live surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-binding-app-"));
  const agentDir = join(root, "agent");
  const script = join(root, "dashboard.mjs");
  const timers: Array<() => void> = [];
  const deliveryEdits: string[] = [];
  let legacyEdits = 0;
  try {
    await writeFile(script, `
export function init() { return { state: { count: 0 }, output: "ready" }; }
export function increment({ state }) {
  return { state: { count: state.count + 1 }, output: "next", viewMode: "edit", refreshAfterMs: 2000 };
}
export function refresh() { return { output: "later" }; }
`, "utf8");
    const installed = await GenerativeApps.installGenerativeApp({
      agentDir,
      app: "dashboard",
      script,
    });
    const runtime = GenerativeApps.createGenerativeAppLiveSurfaceRuntime<
      GenerativeApps.TelegramBindLiveHandle
    >({
      agentDir,
      isCurrent: () => true,
      plan: (result, handle) => ({
        digest: result.output,
        handle: { ...handle, view: { text: result.output, parseMode: "markdown" } },
      }),
      async edit(frame) {
        deliveryEdits.push(frame.handle.view!.text);
        return frame.handle;
      },
      setTimer(callback) {
        timers.push(callback);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    runtime.open({
      app: "dashboard",
      appGeneration: installed.generation,
      appRevision: installed.revision,
      handle: {
        delivery: {
          target: { chatId: 1, threadId: 3 },
          messageIds: [2],
          generation: "delivery-1",
        },
      },
      initialDigest: "ready",
      key: GenerativeApps.getTelegramBindLiveSurfaceKey(
        "dashboard",
        "work",
        { chatId: 1, threadId: 3 },
      ),
      refreshAfterMs: 2000,
    });
    const invoke = createTelegramGenerativeAppBoundButtonActionInvoker({
      agentDir,
      assertExecutionCurrent: () => undefined,
      getExecutionFence: () => undefined,
      getActiveProfileName: () => "work",
      getLiveSurfaceRuntime: () => runtime,
      planOutput: Outbound.createTelegramOutboundReplyPlanner(
        Outbound.createTelegramButtonActionStore(),
      ),
      sendMarkdownReply: async () => undefined,
      editInteractiveMessage: async () => { legacyEdits += 1; },
      recordRuntimeEvent: () => undefined,
    });
    assert.equal(await invoke(
      {
        binding: { generation: installed.generation, app: "dashboard", revision: 0 },
        prompt: "dashboard::increment",
        text: "Next",
      },
      { message: { chat: { id: 1 }, message_id: 2, message_thread_id: 3 } },
    ), "edit");
    assert.deepEqual(deliveryEdits, ["next"]);
    assert.equal(legacyEdits, 0);
    assert.equal(timers.length, 2);
    assert.equal(runtime.take(GenerativeApps.getTelegramBindLiveSurfaceKey(
      "dashboard",
      "work",
      { chatId: 1, threadId: 3 },
    ))?.appRevision, 1);
    runtime.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent message tool routing selects leader or follower composition", async () => {
  let leader = true;
  let followerRegistered = false;
  const calls: string[] = [];
  const runtime = createTelegramAgentMessageToolRoutingRuntime({
    ownsLeader: () => leader,
    ownsDirectDelivery: () => leader,
    isFollowerRegistered: () => followerRegistered,
    getSourceTarget: () => ({ chatId: 7, threadId: 10 }),
    getSourceThreadName: () => "Source",
    local: {
      resolveTarget: (_selector, sourceTarget) => {
        calls.push(`local-resolve:${sourceTarget?.threadId}`);
        return { chatId: 7, threadId: 20 };
      },
      async route(input) {
        calls.push(`local-route:${input.sourceThreadName}`);
      },
    },
    follower: {
      async resolveTarget() {
        calls.push("follower-resolve");
        return { chatId: 7, threadId: 30 };
      },
      async routeMessage() {
        calls.push("follower-route");
      },
    },
  });
  assert.deepEqual(await runtime.resolveAgentTarget({ threadId: 20 }), {
    chatId: 7,
    threadId: 20,
  });
  await runtime.routeAgentMessage({
    target: { chatId: 7, threadId: 20 },
    text: "hello",
    messageId: 1,
  });
  assert.equal(runtime.canSendDirect(), true);
  leader = false;
  followerRegistered = true;
  assert.deepEqual(await runtime.resolveAgentTarget({ threadId: 30 }), {
    chatId: 7,
    threadId: 30,
  });
  await runtime.routeAgentMessage({
    target: { chatId: 7, threadId: 30 },
    text: "hello",
    messageId: 2,
  });
  assert.equal(runtime.canSendDirect(), true);
  assert.deepEqual(calls, [
    "local-resolve:10",
    "local-route:Source",
    "follower-resolve",
    "follower-route",
  ]);
});

for (const lane of ["default", "steer"] as const) {
test(`Confirmed quit fences actual completion dispatch before SDK calls and uses normal shutdown disposition (${lane})`, async () => {
  const store = Queue.createTelegramQueueStore<string>(), deferred = Queue.createTelegramDeferredQueueDispatchRuntime<string>();
  deferred.bind("ctx");
  const events: string[] = [];
  let submitted = 0, committed = 0, shutdown = Promise.resolve();
  const action = Commands.createTelegramSessionActionRuntime({
    sendUserMessage: () => assert.fail("Quit never enters a model/command turn"), notifyResult: async () => {},
    getQuitContext: () => ({
      abort() { assert.equal(store.getQueuedItems().length, 1); events.push("abort"); },
      shutdown() { events.push("shutdown"); shutdown = hooks.onSessionShutdown({ type: "session_shutdown", reason: "quit" }, "ctx"); },
    }),
  });
  const binding = createTelegramQueueBindingRuntime({
    store, deferredDispatch: deferred, queue: { allocateItemOrder: () => 1 },
    lifecycle: { isCompactionInProgress: () => false, hasDispatchPending: () => false },
    activeTurn: { has: () => false }, transportStamp: { isActive: () => true },
    admission: { getSettlement: () => ({
      isItemReady: () => true, onControlSettled: () => {},
      onPromptHandedOff() { committed++; return true; },
      onItemsDiscarded(items) { assert.equal(items.length, 1); events.push("discard"); return true; },
    }), hasPendingQueueMutationForItem: () => false },
    promptDispatch: { startTypingLoop() {}, onPromptDispatchStart() {}, onPromptDispatchFailure() {} },
    isIdle: () => lane === "default", hasPendingMessages: () => false,
    isContextCurrent: value => value === "ctx", isContextAborted: () => false,
    isShutdownRequested: action.isQuitting, updateStatus() {}, sendTextReply: async () => {},
    sendUserMessage() { submitted++; },
  });
  binding.mutation.append({ kind: "prompt", chatId: 7, replyToMessageId: 1, sourceMessageIds: [1],
    queueOrder: 1, queueLane: lane, laneOrder: 1, queuedAttachments: [], content: [{ type: "text", text: "waiting" }],
    historyText: "", statusSummary: "waiting",
    admissionReceipts: [{ queueKind: "prompt", receiptId: "receipt", sourceUpdateIds: [1] }] }, "ctx");
  const hooks = Queue.createTelegramSessionLifecycleHooks({
    getCurrentModel: () => undefined, loadConfig: async () => {}, applySessionStartState() {},
    prepareTempDir: async () => {}, updateStatus() {}, clearPendingMediaGroups() {}, clearModelMenuState() {},
    getActiveTurnChatId: () => undefined, clearPreview: async () => {}, clearActiveTurn() {}, clearAbort() {},
    stopPolling: async () => {}, discardQueuedItems: binding.mutation.clear,
    applySessionShutdownState() { events.push("clear"); assert.equal(store.getQueuedItems().length, 0); },
  });
  const owner = Updates.createTelegramUpdateWorkerOwnerRuntime({
    instanceId: "quit", processId: process.pid, processBirthId: "quit-native", getSessionGeneration: () => 1,
    isContextCurrent: (value: string) => value === "ctx", requestQueueHandoffReconciliation() {},
    dispatchNext(value) {
      events.push("completion-dispatch");
      if (lane === "default") binding.dispatchNext(value);
      else assert.equal(binding.onTurnEnd({ turnIndex: 1, outcome: "completed" }, value), undefined);
    },
    afterUpdateCompleted(updateId, _ctx, key) { action.onUpdateCompleted(updateId, key); },
  });
  assert.equal(action.scheduleAfterUpdate(41, { chatId: 7, messageId: 9 },
    { journalBindingKey: "original", isCurrent: () => true }, "quit"), true);
  owner.onUpdateCompleted(41, "ctx", "original");
  assert.deepEqual(events, ["completion-dispatch"]);
  await new Promise<void>(resolve => setImmediate(resolve)); await shutdown;
  assert.equal(submitted, 0); assert.equal(committed, 0);
  assert.deepEqual(events, ["completion-dispatch", "abort", "shutdown", "discard", "clear"]);
});
}

test("Queue binding requires durable handoff for every burst item and fails closed on missing settlement", () => {
  for (const mode of ["success", "missing", "uncompleted", "shutdown"] as const) {
    const store = Queue.createTelegramQueueStore<string>();
    const deferredDispatch = Queue.createTelegramDeferredQueueDispatchRuntime<string>();
    deferredDispatch.bind("ctx");
    const committed = new Set<number>();
    const events: string[] = [];
    let available = true;
    const settlement = {
      isItemReady: (item: TelegramQueueAdmissionItemLike) =>
        !committed.has(item.admissionReceipts![0]!.sourceUpdateIds[0]!),
      onPromptHandedOff: (item: TelegramQueueAdmissionItemLike) => {
        const id = item.admissionReceipts![0]!.sourceUpdateIds[0]!;
        events.push(`commit:${id}`);
        if (mode === "success") committed.add(id);
        return mode === "success";
      },
      onItemsDiscarded: () => false, onControlSettled: () => {},
    };
    const runtime = createTelegramQueueBindingRuntime({
      store, queue: { allocateItemOrder: () => 0 }, deferredDispatch,
      lifecycle: { isCompactionInProgress: () => false, hasDispatchPending: () => false },
      activeTurn: { has: () => false },
      admission: {
        getSettlement: () => available ? settlement : undefined,
        hasPendingQueueMutationForItem: () => false,
      },
      transportStamp: { isActive: () => true },
      promptDispatch: {
        startTypingLoop: () => {},
        onPromptDispatchStart: () => { if (mode === "missing") available = false; },
        onPromptDispatchFailure: () => { events.push("failed"); },
      },
      isIdle: () => true, hasPendingMessages: () => false, updateStatus: () => {},
      isShutdownRequested: () => mode === "shutdown",
      sendTextReply: async () => undefined,
      sendUserMessage: () => {
        const item = store.getQueuedItems()[0]!;
        events.push(`send:${item.queueOrder}`);
        if (!committed.has(item.queueOrder)) events.push("uncommitted-send");
        store.setQueuedItems(store.getQueuedItems().slice(1));
      },
    });
    for (let id = 1; id <= 3; id++) {
      runtime.mutation.append({
        kind: "prompt", chatId: 7, replyToMessageId: id, sourceMessageIds: [id],
        admissionReceipts: [{ queueKind: "prompt", receiptId: `receipt-${id}`, sourceUpdateIds: [id] }],
        queueOrder: id, queueLane: "default", laneOrder: id, queuedAttachments: [],
        content: [{ type: "text", text: `prompt-${id}` }], historyText: "", statusSummary: "prompt",
      }, "ctx");
    }
    for (let index = 0; index < 3; index++) runtime.dispatchNext("ctx");
    if (mode === "success") {
      assert.deepEqual(events, ["commit:1", "send:1", "commit:2", "send:2", "commit:3", "send:3"]);
      assert.equal(store.getQueuedItems().length, 0);
    } else {
      assert.ok(!events.some((event) => event.startsWith("send:")));
      if (mode === "shutdown") assert.deepEqual(events, []);
      else assert.ok(events.includes("failed"));
      assert.equal(store.getQueuedItems().length, 3);
      assert.equal(committed.size, 0);
    }
  }
});

test("Steer binding commits a whole receipt portfolio once and retains uncertain prefixes", () => {
  for (const mode of ["success", "partial", "missing", "native", "compaction", "pending", "aborted", "wrong-profile", "mutation", "shutdown"] as const) {
    const store = Queue.createTelegramQueueStore<string>();
    const deferred = Queue.createTelegramDeferredQueueDispatchRuntime<string>();
    deferred.bind("ctx");
    let calls = 0, normalSends = 0, idle = false, discardAllowed = false;
    const committed: number[] = [];
    const receipt1 = Queue.createTelegramQueueAdmissionReceipt({ queueKind: "prompt", scope: "one", sourceUpdateIds: [1, 2] })!;
    const receipt2 = Queue.createTelegramQueueAdmissionReceipt({ queueKind: "prompt", scope: "two", sourceUpdateIds: [3] })!;
    const settlement = {
      isItemReady: () => true, onControlSettled: () => {},
      onItemsDiscarded(items: readonly Queue.TelegramQueueItem<string>[]) {
        assert.deepEqual(items.flatMap(item => item.admissionReceipts ?? []), [receipt1, receipt2]);
        return discardAllowed;
      },
      onPromptHandedOff(item: TelegramQueueAdmissionItemLike) {
        calls++;
        assert.deepEqual(item.admissionReceipts, [receipt1, receipt2]);
        assert.strictEqual(item.admissionReceipts![0], receipt1);
        committed.push(1);
        if (mode === "partial") return false;
        committed.push(3);
        return true;
      },
    };
    const runtime = createTelegramQueueBindingRuntime({ store, deferredDispatch: deferred,
      queue: { allocateItemOrder: () => 4 },
      lifecycle: { isCompactionInProgress: () => mode === "compaction", hasDispatchPending: () => mode === "pending" },
      activeTurn: { has: () => false }, transportStamp: { isActive: () => mode !== "wrong-profile" },
      admission: { getSettlement: () => mode === "missing" ? undefined : settlement,
        hasPendingQueueMutationForItem: () => mode === "mutation" },
      promptDispatch: { startTypingLoop: () => assert.fail("Steer cannot start a new Telegram turn"),
        onPromptDispatchStart: () => {}, onPromptDispatchFailure: () => {} },
      isIdle: () => idle, hasPendingMessages: () => mode === "native",
      isContextCurrent: ctx => ctx === "ctx", isContextAborted: () => mode === "aborted",
      isShutdownRequested: () => mode === "shutdown",
      updateStatus: () => {}, sendTextReply: async () => undefined, sendUserMessage: () => { normalSends++; },
    });
    for (const [index, receipt] of [receipt1, receipt2].entries()) runtime.mutation.append({
      kind: "prompt", chatId: 7, target: { chatId: 7, threadId: 10 }, replyToMessageId: index + 1,
      queueOrder: index + 1, queueLane: "steer", laneOrder: index + 1, sourceMessageIds: [index + 1],
      queuedAttachments: [], content: [{ type: "text", text: `steer-${index}` }], historyText: "", statusSummary: "steer",
      admissionReceipts: [receipt],
    }, "ctx");
    const result = runtime.onTurnEnd({ turnIndex: 1, outcome: "completed" }, "ctx");
    assert.equal(result?.continue, mode === "success" ? true : undefined, mode);
    assert.equal(calls, mode === "success" || mode === "partial" ? 1 : 0, mode);
    assert.equal(normalSends, 0);
    if (mode === "success") assert.equal(store.getQueuedItems().length, 0);
    else assert.equal(store.getQueuedItems().length, 2);
    if (mode === "partial") {
      assert.deepEqual(committed, [1]);
      assert.equal(runtime.onTurnEnd({ turnIndex: 2, outcome: "completed" }, "ctx"), undefined);
      assert.equal(calls, 1);
      assert.equal(Queue.createTelegramQueueItemCountGetter(store)(), 0);
      runtime.mutation.append({ kind: "prompt", chatId: 7, queueOrder: 4, queueLane: "default", laneOrder: 4,
        replyToMessageId: 4, sourceMessageIds: [4], queuedAttachments: [], content: [{ type: "text", text: "normal" }],
        historyText: "", statusSummary: "normal" }, "ctx");
      assert.equal(Queue.createTelegramQueueItemCountGetter(store)(), 1);
      idle = true;
      runtime.dispatchNext("ctx");
      assert.equal(normalSends, 1, "A frozen failed packet cannot starve independent Normal work");
      assert.equal(store.getQueuedItems()[0]!.queueOrder, 4, "agent_start must see the actual dispatched head");
      assert.equal(runtime.mutation.applyReactionByMessageId(1,
        { kind: "reaction-transition", promptLane: "default" }, "ctx"), false);
      const retained = store.getQueuedItems();
      assert.throws(() => runtime.mutation.clear("ctx"), /could not be discarded durably/);
      assert.equal(store.getQueuedItems(), retained, "Unconfirmed cleanup cannot lose a frozen partial prefix");
      discardAllowed = true;
      assert.equal(runtime.mutation.clear("ctx"), 3);
      assert.equal(store.getQueuedItems().length, 0);
      assert.equal(calls, 1); assert.equal(normalSends, 1, "Explicit exact disposal never reissues the packet");
    }
  }
});

test("Steer idle binding preserves exact receipt identities through pending-head and active-turn handoff", () => {
  for (const mode of ["success", "partial", "missing", "legacy-context", "after-start-native"] as const) {
    const store = Queue.createTelegramQueueStore<string>();
    const deferred = Queue.createTelegramDeferredQueueDispatchRuntime<string>(); deferred.bind("ctx");
    const receipts = [1, 2].map(id => Queue.createTelegramQueueAdmissionReceipt({
      queueKind: "prompt", scope: `idle-${id}`, sourceUpdateIds: [id * 2, id * 2 + 1],
    })!);
    const disposed = new Set<string>();
    let sourceCalls = 0, sends = 0, pending = false, native = false;
    let active: Queue.PendingTelegramTurn | undefined;
    const settlement = {
      isItemReady: (item: TelegramQueueAdmissionItemLike) => !disposed.has(item.admissionReceipts![0]!.receiptId),
      onControlSettled: () => {}, onItemsDiscarded: () => false,
      onPromptHandedOff(item: TelegramQueueAdmissionItemLike) {
        sourceCalls += 1;
        assert.equal(pending, false, "Journal disposition precedes pending-head publication");
        assert.equal(item.admissionReceipts!.length, 2);
        assert.equal(item.admissionReceipts![0], receipts[0]); assert.equal(item.admissionReceipts![1], receipts[1]);
        disposed.add(receipts[0]!.receiptId);
        if (mode === "partial") return false;
        disposed.add(receipts[1]!.receiptId);
        return true;
      },
    };
    const runtime = createTelegramQueueBindingRuntime({ store, deferredDispatch: deferred,
      queue: { allocateItemOrder: () => 3 },
      lifecycle: { isCompactionInProgress: () => false, hasDispatchPending: () => pending },
      activeTurn: { has: () => active !== undefined }, transportStamp: { isActive: () => true },
      admission: { getSettlement: () => mode === "missing" ? undefined : settlement, hasPendingQueueMutationForItem: () => false },
      ...(mode === "legacy-context" ? {} : { isContextCurrent: (ctx: string) => ctx === "ctx", isContextAborted: () => false }),
      isIdle: () => true, hasPendingMessages: () => native, updateStatus: () => {}, sendTextReply: async () => undefined,
      promptDispatch: { startTypingLoop: () => {}, onPromptDispatchStart: () => {
        pending = true; if (mode === "after-start-native") native = true;
      }, onPromptDispatchFailure: () => { pending = false; } },
      sendUserMessage: content => {
        sends += 1;
        Queue.handleTelegramAgentStartRuntime<Queue.PendingTelegramTurn, string>({
          queuedItems: store.getQueuedItems(), hasPendingDispatch: pending, hasActiveTurn: false,
          ...store, resetToolExecutions: () => {}, resetPendingModelSwitch: () => {},
          clearDispatchPending: () => { pending = false; }, setFoldQueuedPromptsIntoHistory: () => {},
          setActiveTurn: turn => { active = turn; assert.deepEqual(turn.content, content); },
          onPromptHandedOff: turn => {
            assert.equal(turn.admissionReceipts![0], receipts[0]); assert.equal(turn.admissionReceipts![1], receipts[1]);
            assert.ok(turn.admissionReceipts!.every(receipt => disposed.has(receipt.receiptId)), "Only exact acknowledged sources reach agent_start");
          }, createPreviewState: () => {}, startTypingLoop: () => {}, updateStatus: () => {},
        });
      },
    });
    for (const [index, receipt] of receipts.entries()) runtime.mutation.append({
      kind: "prompt", chatId: 7, target: { chatId: 7, threadId: 10 }, replyToMessageId: index + 1,
      queueOrder: index + 1, queueLane: "steer", laneOrder: index + 1, sourceMessageIds: [index + 1],
      queuedAttachments: [], content: [{ type: "text", text: `idle-${index}` }], historyText: `idle-${index}`, statusSummary: "steer",
      admissionReceipts: [receipt],
    }, "ctx");
    const originals = [...store.getQueuedItems()];
    runtime.dispatchNext("ctx"); runtime.dispatchNext("ctx");
    assert.equal(sourceCalls, mode === "missing" || mode === "legacy-context" ? 0 : 1);
    assert.equal(sends, mode === "success" ? 1 : 0);
    assert.equal(pending, false, "Refusal after pending publication cannot contaminate a later native agent_start");
    assert.equal(store.getQueuedItems().length, mode === "success" ? 0 : 2);
    if (mode === "success") {
      assert.deepEqual(active!.sourceMessageIds, [1, 2]); assert.deepEqual(active!.steerPacketSourceOrders, [1, 2]);
      assert.equal(active!.replyToMessageId, 1);
    } else assert.deepEqual(store.getQueuedItems(), originals);
  }
});

test("Queue binding composes mutation, admission, dispatch, and watchdog ports", () => {
  const events: string[] = [];
  const store = Queue.createTelegramQueueStore<string>();
  const deferredDispatch =
    Queue.createTelegramDeferredQueueDispatchRuntime<string>();
  deferredDispatch.bind("ctx");
  let nextLaneOrder = 0;
  let admissionReady = true;
  const runtime = createTelegramQueueBindingRuntime({
    store,
    queue: {
      allocateItemOrder: () => nextLaneOrder++,
    },
    lifecycle: {
      isCompactionInProgress: () => false,
      hasDispatchPending: () => false,
    },
    activeTurn: { has: () => false },
    admission: {
      getSettlement: () => ({
        onItemsDiscarded: (items) => {
          events.push(`discard:${items.length}`);
          return true;
        },
        isItemReady: () => admissionReady,
        onPromptHandedOff: () => {
          admissionReady = false;
          events.push("prompt-committed");
          return true;
        },
        onControlSettled: () => {
          events.push("control-settled");
        },
      }),
      hasPendingQueueMutationForItem: () => false,
    },
    transportStamp: { isActive: () => true },
    deferredDispatch,
    promptDispatch: {
      startTypingLoop: () => {},
      onPromptDispatchStart: () => {
        events.push("dispatch-start");
      },
      onPromptDispatchFailure: () => {
        events.push("dispatch-failure");
      },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    updateStatus: () => {
      events.push("status");
    },
    sendTextReply: async () => undefined,
    sendUserMessage: () => {
      events.push("send");
    },
  });
  runtime.mutation.append(
    {
      kind: "prompt",
      chatId: 7,
      replyToMessageId: 10,
      sourceMessageIds: [10],
      admissionReceipts: [
        {
          queueKind: "prompt",
          receiptId: "prompt-10",
          sourceUpdateIds: [10],
        },
      ],
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      queuedAttachments: [],
      content: [{ type: "text", text: "prompt" }],
      historyText: "prompt",
      statusSummary: "prompt",
    },
    "ctx",
  );
  assert.equal(
    runtime.mutation.applyReactionByMessageId(
      10,
      { kind: "priority", emoji: "👍" },
      "ctx",
    ),
    true,
  );
  runtime.dispatchNext("ctx");
  assert.equal(runtime.mutation.removeByMessageIds([10], "ctx"), 1);
  assert.equal(nextLaneOrder, 1);
  assert.deepEqual(events, [
    "status",
    "status",
    "dispatch-start",
    "prompt-committed",
    "send",
    "discard:1",
    "status",
  ]);
  runtime.mutation.append({ kind: "prompt", chatId: 7, replyToMessageId: 12, sourceMessageIds: [12],
    queueOrder: 2, queueLane: "control", laneOrder: 2, statusSummary: "continue", queuedAttachments: [],
    content: [{ type: "text", text: "continue" }], historyText: "continue",
    admissionReceipts: [{ queueKind: "prompt", receiptId: "continue-12", sourceUpdateIds: [12] }] }, "ctx");
  assert.equal(runtime.mutation.applyReactionByMessageId(12, { kind: "suppressed", emoji: "👎" }, "ctx", { chatId: 7 }), true,
    "Production composition passes the dispatched-head guard to source-owned continuation cancellation");
  assert.equal(store.getQueuedItems().length, 0);
  assert.deepEqual(events.slice(-3), ["status", "discard:1", "status"]);
});

for (const preparation of ["text", "voice", "attachment"] as const) {
for (const replaceRegistration of [false, true]) {
  test(`Follower IPC fences delayed ${preparation} preparation${replaceRegistration ? " across registration replacement" : " before later activity"}`, { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-publication-"));
    const socketPath = join(dir, "leader.sock");
    const committed: string[] = [];
    const failures: unknown[] = [];
    let generation = "registration-1";
    let requestId = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const registry = Bus.createTelegramBusFollowerRegistry();
    const register = () => registry.register({
      instanceId: "follower", connectedAtMs: Date.now(),
      registrationGeneration: generation, target: { chatId: 7, threadId: 42 },
    });
    register();
    const server = Bus.createTelegramBusLocalServer({
      socketPath,
      handleEnvelope: BusLeader.createTelegramBusLeaderEnvelopeHandler({
        followerRegistry: registry,
        authSecret: "fixture-secret",
        protocolIdentity: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "test" }),
        authorizeFollowerApiCall: Bus.isTelegramFollowerApiCallAllowed,
        callApi: async (method, args) => {
          if (method === "callMultipart") {
            assert.equal(args[0], preparation === "voice" ? "sendVoice" : "sendDocument");
            const fields = args[1] as Record<string, string>;
            assert.equal(fields.chat_id, "7");
            assert.equal(fields.message_thread_id, "42");
            committed.push(String(args[0]));
            return { message_id: committed.length };
          }
          assert.equal(method, "call");
          assert.equal(args[0], "sendRichMessage");
          const body = args[1] as { chat_id: number; message_thread_id: number; rich_message: { markdown?: string } };
          assert.equal(body.chat_id, 7);
          assert.equal(body.message_thread_id, 42);
          committed.push(body.rich_message.markdown ?? "tool");
          return { message_id: committed.length };
        },
      }),
    });
    const api = BusApi.createTelegramBusAwareApiRuntime({
      directRuntime: {} as TelegramBridgeApiRuntime,
      ownsDirect: () => false,
      callFollowerApi: BusFollower.createTelegramBusFollowerApiCaller({
        socketPath, instanceId: "follower",
        createRequestId: () => `publication-${++requestId}`,
        getAuthSecret: () => "fixture-secret",
        getRegistrationGeneration: () => generation,
      }),
    });
    const binding = createTelegramActivityBindingRuntime({
      generation: "session",
      assistantOutput: {
        authority: {
          getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
          getFallbackChatId: () => 7,
          getTransportStamp: () => "stamp",
          isTransportStampActive: () => true,
          ownsDirect: () => false,
          getDirectEpoch: () => undefined,
          isFollowerRegistered: () => true,
          getFollowerGeneration: () => generation,
        },
        sender: {
          sendMessage: api.sendMessage,
          sendRichMessage: api.sendRichMessage,
          editMessage: async () => undefined,
          getAssistantRenderingMode: () => "rich",
          getHandlers: () => [{ type: "text", template: "/fixture/prepare" }],
          execCommand: async (_command, _args, options) => {
            markStarted();
            await gate;
            return { stdout: options?.stdin ?? "", stderr: "", code: 0, killed: false };
          },
        },
        recordRuntimeEvent: (_category, error) => { failures.push(error); },
      },
      activityVerbosity: {
        getActivityMode: () => "tools",
        resolveTarget: () => ({ chatId: 7, threadId: 42 }),
        sendMessage: api.sendMessage,
        sendRichMessage: api.sendRichMessage,
        editMessageText: async () => "edited",
      },
    });
    const startTurn = () => {
      binding.activityRuntime.recordInputSource("extension");
      binding.activityRuntime.onAgentStart();
    };
    const finishTurn = () => {
      binding.activityRuntime.onAgentEnd();
      binding.activityRuntime.onAgentSettled();
    };
    const unregisterVoice = preparation === "voice"
      ? Outbound.registerTelegramVoiceSynthesisProvider(async () => {
          markStarted(); await gate;
          const path = join(dir, "voice.ogg");
          await writeFile(path, "fixture voice bytes");
          return path;
        }, { id: "publication-ipc-fixture" })
      : () => {};
    try {
      await server.start();
      binding.assistantOutputRuntime.start();
      binding.activityRuntime.onSessionStart?.();
      if (preparation === "text") {
        startTurn();
        binding.activityRuntime.onAssistantEvent({ type: "text_end", contentIndex: 0, content: "Prepared final" });
        binding.activityRuntime.onAssistantEvent({ type: "done" });
        finishTurn();
      } else {
        const path = join(dir, "artifact.txt");
        await writeFile(path, "fixture attachment");
        const authority = binding.publicationRuntime.capture();
        await Queue.handleTelegramAgentEndRuntime({
          turn: {
            kind: "prompt", chatId: 7, replyToMessageId: 1,
            target: { chatId: 7, threadId: 42 }, sourceMessageIds: [1],
            queueOrder: 1, queueLane: "default", laneOrder: 1,
            content: [{ type: "text", text: "fixture" }], historyText: "fixture", statusSummary: "fixture",
            queuedAttachments: preparation === "attachment" ? [{ path, fileName: "artifact.txt" }] : [],
          },
          assistant: { text: "Final caption" },
          foldQueuedPromptsIntoHistory: false,
          isTurnTransportActive: authority.isCurrent,
          resetRuntimeState: () => {}, updateStatus: () => {}, dispatchNextQueuedTelegramTurn: () => {},
          scheduleActiveTurnDelivery: (task) => { void binding.publicationRuntime.enqueue(task).catch((error) => failures.push(error)); },
          clearPreview: async () => {}, setPreviewPendingText: () => {}, finalizeMarkdownPreview: async () => false,
          sendMarkdownReply: async (_chat, _reply, text) => {
            await api.sendRichMessage({ chat_id: 7, message_thread_id: 42, rich_message: { markdown: text } });
          },
          sendTextReply: async () => { assert.fail("Unexpected attachment fallback"); },
          sendQueuedAttachments: OutboundAttachments.createTelegramQueuedOutboundAttachmentSender({
            statPath: async (file) => { markStarted(); await gate; return stat(file); },
            sendMultipart: api.callMultipart,
            sendTextReply: async () => { assert.fail("Unexpected attachment failure notice"); },
          }),
          planOutboundReply: preparation === "voice" ? () => ({ markdown: "", voiceText: "Spoken final" }) : undefined,
          sendOutboundReplyArtifacts: Outbound.createTelegramOutboundReplyArtifactSender({
            execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
            sendMultipart: api.callMultipart,
          }),
        });
      }
      await started;
      startTurn();
      binding.activityRuntime.onToolEnd({ toolCallId: "read", toolName: "read", result: "contents", isError: false });
      finishTurn();
      if (preparation !== "text") {
        const authority = binding.publicationRuntime.capture();
        void binding.publicationRuntime.enqueue(async () => {
          if (authority.isCurrent()) await api.sendRichMessage({ chat_id: 7, message_thread_id: 42, rich_message: { markdown: "Following notice" } });
        }).catch((error) => failures.push(error));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const prefix: string[] = [];
      assert.deepEqual(committed, prefix);
      if (replaceRegistration) {
        generation = "registration-2";
        register();
      }
      release();
      await binding.publicationRuntime.enqueue(async () => {});
      const expected = preparation === "text"
        ? ["Prepared final", "tool"]
        : preparation === "attachment"
          ? ["sendDocument", "Final caption", "tool", "Following notice"]
          : ["sendVoice", "tool", "Following notice"];
      assert.deepEqual(committed, replaceRegistration ? prefix : expected);
      assert.equal(requestId, replaceRegistration ? prefix.length : expected.length);
      assert.equal(failures.length, replaceRegistration && preparation === "text" ? 1 : 0);
      if (replaceRegistration) {
        if (preparation === "text") assert.match(String(failures[0]), /lost admission authority before transport mutation/);
        startTurn();
        binding.activityRuntime.onAssistantEvent({ type: "text_end", contentIndex: 0, content: "Fresh final" });
        binding.activityRuntime.onAssistantEvent({ type: "done" });
        finishTurn();
        await binding.publicationRuntime.enqueue(async () => {});
        assert.deepEqual(committed, [...prefix, "Fresh final"]);
        assert.equal(requestId, prefix.length + 1);
      }
    } finally {
      release();
      binding.activityRuntime.onSessionShutdown();
      binding.assistantOutputRuntime.stop();
      binding.activityVerbosityRuntime.stop();
      await server.stop();
      unregisterVoice();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
}

test("Activity binding composes bridge fanout and output ordering", async () => {
  const sent: string[] = [];
  const binding = createTelegramActivityBindingRuntime({
    generation: "generation-1",
    assistantOutput: {
      authority: {
        getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
        getFallbackChatId: () => 7,
        getTransportStamp: () => "stamp-1",
        isTransportStampActive: (stamp) => stamp === "stamp-1",
        ownsDirect: () => true,
        getDirectEpoch: () => 1,
        isFollowerRegistered: () => false,
        getFollowerGeneration: () => undefined,
      },
      sender: {
        sendMessage: async () => ({ message_id: 1 }),
        sendRichMessage: async (body) => {
          sent.push(body.rich_message.markdown ?? "");
          return { message_id: 2 };
        },
        editMessage: async () => undefined,
        getAssistantRenderingMode: () => "rich",
        execCommand: async (_command, _args, options) => ({
          stdout: options?.stdin ?? "",
          stderr: "",
          code: 0,
          killed: false,
        }),
      },
      recordRuntimeEvent: () => undefined,
    },
    activityVerbosity: {
      getActivityMode: () => "quiet",
      resolveTarget: (event) => event.target,
      sendMessage: async () => ({ message_id: 3 }),
      sendRichMessage: async () => ({ message_id: 4 }),
      editMessageText: async () => "edited",
    },
  });
  binding.assistantOutputRuntime.start();
  binding.activityRuntime.onSessionStart?.();
  binding.activityRuntime.recordInputSource("extension");
  binding.activityRuntime.onAgentStart();
  binding.activityRuntime.onAssistantEvent({
    type: "text_end",
    contentIndex: 0,
    content: "public output",
  });
  binding.activityRuntime.onAssistantEvent({ type: "done" });
  binding.activityRuntime.onAgentEnd();
  binding.activityRuntime.onAgentSettled();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await binding.assistantOutputRuntime.waitForIdle();
  assert.deepEqual(sent, ["public output"]);
  binding.activityVerbosityRuntime.stop();
  binding.assistantOutputRuntime.stop();
});

for (const [route, replaceAuthority] of [
  ["direct", false], ["follower", false],
  ["direct", true], ["follower", true],
] as const) {
test(`Activity publication preserves cross-turn order with ${route}${replaceAuthority ? " replacement" : ""}`, async () => {
  const sent: string[] = [];
  let epoch = 1;
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const binding = createTelegramActivityBindingRuntime({
    generation: "ordered-generation",
    assistantOutput: {
      authority: {
        getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
        getFallbackChatId: () => 7,
        getTransportStamp: () => "stamp",
        isTransportStampActive: () => true,
        ownsDirect: () => route === "direct",
        getDirectEpoch: () => epoch,
        isFollowerRegistered: () => route === "follower",
        getFollowerGeneration: () => `registration-${epoch}`,
      },
      sender: {
        sendMessage: async () => ({ message_id: 1 }),
        sendRichMessage: async () => { markStarted(); await gate; sent.push("assistant"); return { message_id: 2 }; },
        editMessage: async () => undefined,
        getAssistantRenderingMode: () => "rich",
        execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      },
      recordRuntimeEvent: () => undefined,
    },
    activityVerbosity: {
      getActivityMode: () => "tools",
      resolveTarget: () => ({ chatId: 7, threadId: 42 }),
      sendMessage: async () => { sent.push("tool"); return { message_id: 3 }; },
      sendRichMessage: async () => { sent.push("tool"); return { message_id: 3 }; },
      editMessageText: async () => "edited",
    },
  });
  try {
    binding.assistantOutputRuntime.start();
    binding.activityRuntime.onSessionStart?.();
    binding.activityRuntime.recordInputSource("extension");
    binding.activityRuntime.onAgentStart();
    binding.activityRuntime.onAssistantEvent({ type: "text_end", contentIndex: 0, content: "Checkpoint" });
    binding.activityRuntime.onAssistantEvent({ type: "toolcall_start", contentIndex: 1 });
    binding.activityRuntime.onAgentEnd();
    binding.activityRuntime.onAgentSettled();
    binding.activityRuntime.recordInputSource("extension");
    binding.activityRuntime.onAgentStart();
    binding.activityRuntime.onToolStart({ toolCallId: "read-1", toolName: "read", args: { path: "fixture.txt" } });
    binding.activityRuntime.onToolEnd({ toolCallId: "read-1", toolName: "read", result: "fixture contents", isError: false });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, []);
    if (replaceAuthority) epoch += 1;
    release();
    await binding.publicationRuntime.enqueue(async () => {});
    assert.deepEqual(sent, replaceAuthority ? ["assistant"] : ["assistant", "tool"]);
    if (replaceAuthority) {
      binding.activityRuntime.onAgentEnd();
      binding.activityRuntime.onAgentSettled();
      binding.activityRuntime.recordInputSource("extension");
      binding.activityRuntime.onAgentStart();
      binding.activityRuntime.onToolEnd({ toolCallId: "read-new", toolName: "read", result: "current output", isError: false });
      await binding.publicationRuntime.enqueue(async () => {});
      assert.deepEqual(sent, ["assistant", "tool"]);
    }
  } finally {
    release();
    binding.activityRuntime.onSessionShutdown();
    binding.assistantOutputRuntime.stop();
    binding.activityVerbosityRuntime.stop();
  }
});
}

test("Assistant output binding composes admission, delivery, and observation", async () => {
  const sent: string[] = [];
  const order: string[] = [];
  const binding = createTelegramAssistantOutputBindingRuntime({
    authority: {
      getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
      getFallbackChatId: () => 7,
      getTransportStamp: () => "stamp-1",
      isTransportStampActive: (stamp) => stamp === "stamp-1",
      ownsDirect: () => true,
      getDirectEpoch: () => 1,
      isFollowerRegistered: () => false,
      getFollowerGeneration: () => undefined,
    },
    sender: {
      sendMessage: async () => ({ message_id: 1 }),
      sendRichMessage: async (body) => {
        order.push("send");
        sent.push(body.rich_message.markdown ?? "");
        return { message_id: 2 };
      },
      editMessage: async () => undefined,
      getAssistantRenderingMode: () => "rich",
      execCommand: async (_command, _args, options) => ({
        stdout: options?.stdin ?? "",
        stderr: "",
        code: 0,
        killed: false,
      }),
    },
    waitForActivityIdle: async () => {
      order.push("activity-idle");
    },
    recordRuntimeEvent: () => undefined,
  });
  binding.runtime.start();
  binding.observeEvent({
    type: "assistant-segment",
    activityId: "activity-1",
    sequence: 1,
    source: "local",
    timestamp: 1,
    contentIndex: 0,
    text: "public output",
    placement: "final",
  });
  await binding.runtime.waitForIdle();
  assert.deepEqual(sent, ["public output"]);
  assert.deepEqual(order, ["activity-idle", "send"]);
});

function getRequiredBindingHandler(
  handlers: Map<string, RegisteredBindingHandler>,
  name: string,
): RegisteredBindingHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected binding handler ${name}`);
  return handler;
}

test("Command binding exposes no agent interaction tools or thread rename tool", () => {
  const harness = createBindingApiHarness();
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({}),
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => {},
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => ({ ok: true }),
      stop: async () => undefined,
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  assert.equal(harness.tools.has("telegram_rename_thread"), false);
  for (const name of ["telegram_confirm", "telegram_choice", "telegram_task_view", "telegram_artifact"])
    assert.equal(harness.tools.has(name), false);
});

test("Command binding rejects a missing profile without stopping active polling", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  let activeProfileName: string | undefined = "active";
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: "active-token" }),
      getStoredConfig: () => ({
        profiles: { active: { botToken: "active-token" } },
      }),
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => {
        events.push("load");
      },
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        events.push("start");
        return { ok: true };
      },
      stop: async () => {
        events.push("stop");
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const connect = harness.commands.get("telegram-connect") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  const notifications: string[] = [];
  await connect.handler("missing", {
    cwd: "/repo",
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext);
  assert.equal(activeProfileName, "active");
  assert.deepEqual(events, ["load", "status"]);
  assert.deepEqual(notifications, ['Profile "missing" not found.']);
});

test("Named profile connect completes old teardown before activating new identity", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  const storedConfig = { profiles: { active: { botToken: "active-token" }, work: { botToken: "work-token" } } };
  let activeProfileName: string | undefined = "active";
  let stopCompleted = false;
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: `${activeProfileName}-token` }),
      getStoredConfig: () => storedConfig,
      getBotToken: (profileName = activeProfileName) => storedConfig.profiles[profileName as keyof typeof storedConfig.profiles]?.botToken,
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        assert.equal(stopCompleted, true);
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => events.push("load"),
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      prepareConnection: (_ctx: unknown, isCurrent: () => boolean) => {
        assert.equal(isCurrent(), true); events.push("prepare");
      },
      start: async () => {
        events.push(`start:${activeProfileName}`);
        return { ok: true };
      },
      stop: async () => {
        events.push(`stop:${activeProfileName}`);
        await Promise.resolve();
        stopCompleted = true;
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => events.push("status"),
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);

  const connect = harness.commands.get("telegram-connect") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  await connect.handler("work", {
    cwd: "/repo",
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext);

  assert.equal(activeProfileName, "work");
  assert.deepEqual(events, [
    "load",
    "prepare",
    "stop:active",
    "activate:work",
    "start:work",
    "status",
  ]);
  assert.deepEqual(harness.messages, [
    {
      message: {
        customType: "telegram-connection-state",
        content:
          "Telegram session connected. Use Telegram features for Telegram-originated turns or explicit Telegram requests; connectivity alone is not user intent.",
        display: false,
      },
      options: { deliverAs: "nextTurn" },
    },
  ]);
});

for (const named of [false, true])
for (const boundary of ["known", "cancel-before-prep", "cancel-in-prep", "profile-in-prep", "config-in-prep", "token-in-prep", "config-in-stop", "cancel-in-stop", "config-after-activate", "profile-after-activate", "cancel-after-activate", "prepare-error", "reset", "cancel-in-refresh", "config-in-refresh", "refresh-error", "refresh-unavailable"] as const)
test(`Connect preparation pins selected profile before old cleanup (${named ? "named" : "default"}/${boundary})`, async () => {
  const harness = createBindingApiHarness(), events: string[] = [];
  const env: NodeJS.ProcessEnv = { SELECTED_CONNECT_TOKEN: "123:selected" };
  const selected = named ? "work" : "default";
  const store = Config.createTelegramConfigStore({ env, initialConfig: { profiles: {
    default: { botToken: "$SELECTED_CONNECT_TOKEN" }, work: { botToken: "$SELECTED_CONNECT_TOKEN" }, old: { botToken: "123:old" },
  } } });
  store.activateProfile("old");
  const activate = store.activateProfile;
  store.activateProfile = profile => { events.push("activate"); return activate(profile); };
  let current = true, generation = 1;
  store.load = async () => { if (boundary === "cancel-before-prep") current = false; };
  const changeConfig = () => store.setProfile(selected, { botToken: "$SELECTED_CONNECT_TOKEN" });
  registerTelegramCommandsAndTools({
    pi: harness.api, configStore: store, setup: { start: () => true, finish() {} }, activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      prepareConnection(_ctx: unknown, isCurrent: () => boolean) {
        events.push("prepare");
        assert.equal(store.getActiveProfileName(), "old", "Inspection does not lend old teardown the new identity");
        assert.equal(store.getBotToken(selected), "123:selected");
        if (boundary === "cancel-in-prep") current = false;
        if (boundary === "profile-in-prep") activate("work");
        if (boundary === "config-in-prep") changeConfig();
        if (boundary === "token-in-prep") env.SELECTED_CONNECT_TOKEN = "123:replacement";
        if (boundary === "prepare-error") throw new Error("Fixture preparation refused");
        if (!isCurrent()) throw new Error("Fixture preparation superseded");
        return ["reset", "cancel-in-refresh", "config-in-refresh", "refresh-error", "refresh-unavailable"].includes(boundary);
      },
      start: async () => { events.push("start"); assert.equal(store.getActiveProfileName(), named ? "work" : undefined); return { ok: true }; },
      stop: async () => assert.fail("The captured composed teardown port owns this stop"),
    },
    stopPolling: async () => {
      events.push("stop"); assert.equal(store.getActiveProfileName(), "old");
      await Promise.resolve();
      if (boundary === "config-in-stop") changeConfig();
      if (boundary === "cancel-in-stop") generation++;
    },
    ...(boundary === "refresh-unavailable" ? {} : { refreshProfileStateAfterReset: async () => {
      events.push("refresh");
      assert.equal(store.getActiveProfileName(), named ? "work" : undefined);
      await Promise.resolve();
      if (boundary === "cancel-in-refresh") generation++;
      if (boundary === "config-in-refresh") changeConfig();
      if (boundary === "refresh-error") throw new Error("Fixture selected projection refused");
    } }),
    onTransportChanged: async () => {
      await Promise.resolve();
      if (boundary === "config-after-activate") changeConfig();
      if (boundary === "profile-after-activate") activate("old");
      if (boundary === "cancel-after-activate") generation++;
    },
    getSessionGeneration: () => generation, isContextCurrent: () => current,
    getStatusLines: () => [], buttonActionStore: { register: () => "fixture" },
    sendMarkdownReply: async () => 1, callMultipart: async () => ({ ok: true }), getDefaultChatId: () => 42,
    canSendDirect: () => true, updateStatus() {}, recordRuntimeEvent() {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const connect = harness.commands.get("telegram-connect") as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
  await connect.handler(named ? "work" : "", { cwd: "/repo", ui: { notify() {} } } as unknown as ExtensionContext);
  if (boundary === "known") assert.deepEqual(events, ["prepare", "stop", "activate", "start"]);
  else if (boundary === "reset") assert.deepEqual(events, ["prepare", "stop", "activate", "refresh", "start"]);
  else if (["cancel-in-refresh", "config-in-refresh", "refresh-error"].includes(boundary)) assert.deepEqual(events, ["prepare", "stop", "activate", "refresh"]);
  else if (boundary === "refresh-unavailable") assert.deepEqual(events, ["prepare", "stop", "activate"]);
  else if (boundary === "cancel-before-prep") assert.deepEqual(events, []);
  else if (boundary.endsWith("in-stop")) assert.deepEqual(events, ["prepare", "stop"]);
  else if (boundary.endsWith("after-activate")) assert.deepEqual(events, ["prepare", "stop", "activate"]);
  else assert.deepEqual(events, ["prepare"], "A refused preparation cannot start old cleanup or change identity");
});

test("Named profile setup cancellation preserves the active runtime", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  let activeProfileName: string | undefined = "active";
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: "active-token" }),
      getStoredConfig: () => ({
        profiles: { active: { botToken: "active-token" } },
      }),
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => undefined,
      persist: async () => {
        events.push("persist");
      },
      set: () => {
        events.push("set");
      },
    },
    setup: {
      start: () => {
        events.push("guard-start");
        return true;
      },
      finish: () => {
        events.push("guard-finish");
      },
    },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        events.push("start");
        return { ok: true };
      },
      stop: async () => {
        events.push("stop");
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const setupCommand = harness.commands.get("telegram-setup") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  const notifications: string[] = [];
  await setupCommand.handler("newprofile", {
    cwd: "/repo",
    hasUI: true,
    ui: {
      input: async () => undefined,
      editor: async () => undefined,
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext);
  assert.equal(activeProfileName, "active");
  assert.deepEqual(events, ["guard-start", "guard-finish"]);
  assert.deepEqual(notifications, []);
});

test("Named setup preserves a display preference changed while the token form was open", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-setup-display-"));
  const configPath = join(dir, "telegram.json");
  const store = Config.createTelegramConfigStore({ agentDir: dir, configPath, initialConfig: {
    profiles: { default: { botToken: "default-token" },
      work: { botToken: "old-token" } },
    threads: { displayMode: "letters" },
  } });
  await store.persist();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    ok: true, result: { id: 123, username: "testbot" },
  }), { headers: { "content-type": "application/json" } }));
  const harness = createBindingApiHarness();
  registerTelegramCommandsAndTools({
    pi: harness.api, configStore: store, persistConfig: store.persist,
    setup: { start: () => true, finish() {} }, activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: { start: async () => ({ ok: true }), stop: async () => "stopped" },
    getStatusLines: () => [], buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1, callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 7, canSendDirect: () => true, updateStatus() {}, recordRuntimeEvent() {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  try {
    const setupCommand = harness.commands.get("telegram-setup") as {
      handler(args: string, ctx: ExtensionContext): Promise<void>;
    };
    await setupCommand.handler("work", {
      cwd: "/repo", hasUI: true,
      ui: {
        async editor() {
          const other = Config.createTelegramConfigStore({ agentDir: dir, configPath });
          await other.load(); other.activateProfile("work");
          await Config.setTelegramThreadDisplayMode(other, "directory-snake", () => true);
          return "new-token";
        },
        async input() { return "new-token"; }, notify() {},
      },
    } as unknown as ExtensionContext);
    const saved = await Config.readTelegramConfig(configPath);
    assert.equal(saved.profiles?.work.botToken, "new-token");
    assert.equal(saved.threads?.displayMode, "directory-snake");
    assert.deepEqual(Object.keys(saved.profiles?.work ?? {}).sort(), ["botId", "botToken", "botUsername"]);
    assert.equal(store.getActiveProfileName(), "work");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Lifecycle binding drains diagnostics before quit cleanup and preserves cleanup after failure", async () => {
  const events: string[] = [];
  const callbacks = createTelegramButtonActionStore();
  let holdDiagnostics = false, current = true, generation = 1;
  let releaseDiagnostics: (() => void) | undefined;
  let disconnectFails = false;
  let automaticCleanupEnabled = true;
  let cleanupPreferenceGate: Promise<void> | undefined, disconnectGate: Promise<void> | undefined;
  const harness = createBindingApiHarness();
  const deps = {
    diagnostics: {
      onSessionStart() {},
      onSessionShutdown() {
        events.push("diagnostics:suspend");
        return holdDiagnostics ? new Promise<void>(resolve => { releaseDiagnostics = resolve; }) : Promise.resolve();
      },
    },
    isSessionContextActive: () => current,
    getSessionGeneration: () => generation,
    pi: harness.api,
    activityRuntime: {
      recordInputSource: () => {},
      onAgentStart: () => {},
      onAssistantEvent: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onToolEnd: () => {},
      onCompactionStart: () => {},
      onCompactionEnd: () => {},
      onCompactionAbandoned: () => {},
      onAgentEnd: () => {},
      onAgentSettled: () => {},
      onSessionShutdown: () => {},
    },
    publicationRuntime: {
      ...Activity.createTelegramActivityPublicationRuntime(),
      capture: () => ({ target: { chatId: 7 }, isCurrent: () => true }),
    },
    assistantOutputRuntime: { start: () => {}, stop: () => {} },
    sessionLifecycleRuntime: {
      onSessionStart: async () => {
        events.push("session-start");
      },
      onSessionShutdown: async () => {
        events.push("composed-shutdown");
      },
      onModelSelect: () => {
        events.push("model-select");
      },
    },
    configStore: { get: () => ({}), getOutboundHandlers: () => [] },
    abort: { setHandler: () => {}, clearHandler: () => {} },
    typing: { stop: () => {}, waitForIdle: async () => {} },
    progress: {
      start: () => ({ active: true, chatId: 1, text: "", updatedAtMs: 0 }),
      update: () => undefined,
      stop: () => undefined,
      get: () => undefined,
    },
    lifecycle: {
      resetActiveToolExecutions: () => {},
      clearDispatchPending: () => {},
      hasDispatchPending: () => false,
      setFoldQueuedPromptsIntoHistory: () => {},
      shouldFoldQueuedPromptsIntoHistory: () => false,
      getActiveToolExecutions: () => 0,
      setActiveToolExecutions: () => {},
      setCompactionInProgress: () => {},
    },
    activeTurnRuntime: {
      clear: () => {},
      has: () => false,
      set: () => {},
      get: () => undefined,
    },
    telegramQueueStore: {
      getQueuedItems: () => [],
      setQueuedItems: () => {},
    },
    modelSwitchController: {
      clearPendingSwitch: () => {},
      triggerPendingAbort: () => {},
    },
    previewRuntime: {
      invalidate: () => undefined,
      resetState: () => undefined,
      clear: () => {},
      setPendingText: () => {},
      onMessageStart: async () => {},
      onMessageUpdate: async () => {},
    },
    promptDispatchRuntime: {
      startTypingLoop: () => events.push("typing:start"),
    },
    deferredQueueDispatchRuntime: { request: () => {} },
    modelContextAvailabilityRuntime: { reconcile: () => {} },
    disconnectOnQuit: async () => {
      events.push("disconnect-on-quit");
      if (disconnectGate) await disconnectGate;
      if (disconnectFails) throw new Error("cleanup unavailable");
    },
    shutdownGenerativeAppLiveSurfaces: () => {
      events.push("live-surfaces-shutdown");
    },
    resolveAutomaticThreadCleanupEnabled: async () => {
      if (cleanupPreferenceGate) { events.push("cleanup-preference"); await cleanupPreferenceGate; }
      return automaticCleanupEnabled;
    },
    buttonActionStore: callbacks,
    callMultipart: async () => ({ ok: true }),
    sendChatAction: async () => ({ ok: true }),
    sendRecordVoiceAction: async () => ({ ok: true }),
    sendMarkdownReply: async () => ({ ok: true }),
    sendTextReply: async () => ({ ok: true }),
    editInteractiveMessage: async () => undefined,
    deleteMessage: async () => undefined,
    dispatchNextQueuedTelegramTurn: () => {},
    onSteerTurnEnd: () => ({ entries: [{ type: "custom_message", customType: "telegram-steer", content: "steer", display: true }], continue: true }),
    answerGuestQuery: async () => ({ ok: true }),
    sendGuestReply: async () => ({ ok: true }),
    finalizeMarkdownPreview: async () => undefined,
    canSendAgentActivity: () => false,
    updateStatus: () => {},
    recordRuntimeEvent: (
      _category: string,
      _error: unknown,
      details?: { phase?: string },
    ) => {
      if (details?.phase) events.push(`runtime:${details.phase}`);
    },
  } as unknown as Parameters<typeof registerTelegramLifecycleRuntimeHooks>[0];

  registerTelegramLifecycleRuntimeHooks(deps);
  const oldStart = callbacks.register({ text: "Old session", prompt: "Old session" });
  await getRequiredBindingHandler(harness.handlers, "session_start")({ type: "session_start" }, {} as ExtensionContext);
  assert.equal(callbacks.resolve(oldStart), undefined);
  events.length = 0;
  const preceding = { type: "custom", customType: "preceding", data: { preserved: true } };
  const step = await getRequiredBindingHandler(harness.handlers, "turn_end")(
    { entries: [preceding], turnIndex: 1, outcome: "completed" }, {} as ExtensionContext,
  ) as { entries: Array<{ customType: string }>; continue: boolean };
  assert.strictEqual(step.entries[0], preceding);
  assert.equal(step.entries[1]!.customType, "telegram-steer");
  assert.equal(step.continue, true);
  assert.equal(events.length, 0, "Model-step insertion cannot reset active reply/lifecycle ownership");
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );
  const shutdown = getRequiredBindingHandler(
    harness.handlers,
    "session_shutdown",
  );
  const oldShutdown = callbacks.register({ text: "Before shutdown", prompt: "Before shutdown" });
  await shutdown(
    { type: "session_shutdown", reason: "reload" },
    {} as ExtensionContext,
  );
  assert.equal(callbacks.resolve(oldShutdown), undefined);
  await shutdown(
    { type: "session_shutdown", reason: "quit" },
    {} as ExtensionContext,
  );
  disconnectFails = true;
  await shutdown(
    { type: "session_shutdown", reason: "quit" },
    {} as ExtensionContext,
  );
  automaticCleanupEnabled = false;
  await shutdown(
    { type: "session_shutdown", reason: "quit" },
    {} as ExtensionContext,
  );

  assert.deepEqual(events, [
    "diagnostics:suspend", "live-surfaces-shutdown", "composed-shutdown",
    "diagnostics:suspend", "live-surfaces-shutdown", "disconnect-on-quit", "composed-shutdown",
    "diagnostics:suspend", "live-surfaces-shutdown", "disconnect-on-quit",
    "runtime:automatic-disconnect-on-quit", "composed-shutdown",
    "diagnostics:suspend", "live-surfaces-shutdown", "composed-shutdown",
  ]);
  events.length = 0;
  holdDiagnostics = true;
  const stopped = shutdown({ type: "session_shutdown", reason: "quit" }, {} as ExtensionContext);
  await Promise.resolve();
  assert.deepEqual(events, ["diagnostics:suspend", "live-surfaces-shutdown"]);
  const successor = callbacks.register({ text: "Successor", prompt: "Successor" });
  current = false;
  releaseDiagnostics!();
  await stopped;
  assert.equal(callbacks.resolve(successor)!.prompt, "Successor");
  const inactive = callbacks.register({ text: "Inactive shutdown must not clear", prompt: "Keep" });
  await shutdown({ type: "session_shutdown", reason: "reload" }, {} as ExtensionContext);
  assert.equal(callbacks.resolve(inactive)!.prompt, "Keep");
  assert.deepEqual(events, ["diagnostics:suspend", "live-surfaces-shutdown"], "Retired shutdown cannot continue into a successor after the drain");
  current = true;
  const buttons = Promise.withResolvers<void>(), diagnosticFailure = new Error("Diagnostic stop failed");
  callbacks.waitForPublicationIdle = () => buttons.promise;
  deps.diagnostics!.onSessionShutdown = () => Promise.reject(diagnosticFailure);
  let finished = false;
  const failed = Promise.resolve(shutdown({ type: "session_shutdown", reason: "quit" }, {} as ExtensionContext))
    .catch((error: unknown) => { finished = true; return error; });
  await waitForTurn();
  assert.equal(finished, false, "A diagnostic failure must not skip actual callback cleanup drain");
  buttons.resolve();
  assert.equal(await failed, diagnosticFailure);
  automaticCleanupEnabled = true; disconnectFails = false;
  const reused = {} as ExtensionContext;
  for (const boundary of ["diagnostics", "cleanup-preference", "disconnect"] as const) {
    events.length = 0;
    const pending = Promise.withResolvers<void>();
    deps.diagnostics!.onSessionShutdown = () => {
      events.push("diagnostics:suspend");
      return boundary === "diagnostics" ? pending.promise : Promise.resolve();
    };
    cleanupPreferenceGate = boundary === "cleanup-preference" ? pending.promise : undefined;
    disconnectGate = boundary === "disconnect" ? pending.promise : undefined;
    let returned = false;
    const old = Promise.resolve(shutdown({ type: "session_shutdown", reason: "quit" }, reused)).then(() => { returned = true; });
    await waitForTurn();
    assert.equal(returned, false, "The selected original teardown operation is still awaited");
    if (boundary !== "diagnostics") assert.ok(events.includes(boundary === "disconnect" ? "disconnect-on-quit" : "cleanup-preference"));
    generation++;
    pending.resolve(); await old;
    assert.equal(events.includes("composed-shutdown"), false, "Late original completion cannot enter the successor's composed teardown");
    assert.equal(events.includes("disconnect-on-quit"), boundary === "disconnect", "A superseded preference read cannot issue destructive cleanup");
  }
});

test("Lifecycle binding routes native typing, previews, and normalized activity", async () => {
  const events: string[] = [];
  const typingEnsures: boolean[] = [];
  let generation = 1, previewGate: Promise<void> | undefined, previewResets = 0;
  const harness = createBindingApiHarness();
  const runtime = Runtime.createTelegramBridgeRuntime();
  const steerStore = Queue.createTelegramQueueStore<ExtensionContext>();
  const steerContext = {} as ExtensionContext;
  const deferred = Queue.createTelegramDeferredQueueDispatchRuntime<ExtensionContext>(); deferred.bind(steerContext);
  const active: Queue.PendingTelegramTurn = { kind: "prompt", chatId: 42, target: { chatId: 42, threadId: 9 },
    replyToMessageId: 20, queueOrder: 1, queueLane: "default", laneOrder: 1, statusSummary: "active",
    sourceMessageIds: [20], content: [{ type: "text", text: "original" }], queuedAttachments: [], historyText: "original",
    voiceReplyRequired: true };
  let activeTurn = false, nativePending = false, aborted = false;
  const deps = {
    pi: harness.api,
    activityRuntime: {
      recordInputSource: (source: string) =>
        events.push(`activity:input:${source}`),
      onAgentStart: (target?: { chatId: number; threadId?: number }) =>
        events.push(
          `activity:agent-start:${target?.threadId ?? target?.chatId ?? "none"}`,
        ),
      onAssistantEvent: (event: { type: string }) =>
        events.push(`activity:assistant:${event.type}`),
      onToolStart: (event: { toolName: string }) =>
        events.push(`activity:tool-start:${event.toolName}`),
      onToolUpdate: (event: { toolName: string }) =>
        events.push(`activity:tool-update:${event.toolName}`),
      onToolEnd: (event: { toolName: string }) =>
        events.push(`activity:tool-end:${event.toolName}`),
      onCompactionStart: (reason: string) =>
        events.push(`activity:compact-start:${reason}`),
      onCompactionEnd: (reason: string) =>
        events.push(`activity:compact-end:${reason}`),
      onCompactionAbandoned: () =>
        events.push("activity:compact-abandoned"),
      onUiPromptStart: (kind: string, title?: string) =>
        events.push(`activity:ui-start:${kind}:${title ?? "none"}`),
      onUiPromptEnd: () => events.push("activity:ui-end"),
      onAgentEnd: () => events.push("activity:agent-end"),
      onAgentSettled: () => events.push("activity:agent-settled"),
      onSessionShutdown: () => events.push("activity:shutdown"),
    },
    publicationRuntime: {
      ...Activity.createTelegramActivityPublicationRuntime(),
      capture: () => ({ target: { chatId: 7 }, isCurrent: () => true }),
    },
    assistantOutputRuntime: {
      beginTurn: () => {},
      start: () => events.push("assistant-output:start"),
      stop: () => events.push("assistant-output:stop"),
    },
    sessionLifecycleRuntime: {
      onSessionStart: async () => {},
      onSessionShutdown: async () => {},
      onModelSelect: () => {},
    },
    configStore: {
      get: () => ({}),
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
    },
    abort: runtime.abort,
    typing: runtime.typing,
    lifecycle: runtime.lifecycle,
    activeTurnRuntime: {
      clear: () => {},
      has: () => activeTurn,
      set: () => { activeTurn = true; },
      get: () =>
        activeTurn
          ? active
          : undefined,
    },
    telegramQueueStore: steerStore,
    modelSwitchController: {
      clearPendingSwitch: () => {},
      triggerPendingAbort: () => {},
    },
    previewRuntime: {
      resetState: () => { previewResets++; return undefined; },
      clear: () => { previewResets++; },
      setPendingText: () => {},
      onMessageStart: async () => { events.push("preview:start"); await previewGate; },
      onMessageUpdate: async () => events.push("preview:update"),
    },
    promptDispatchRuntime: {
      startTypingLoop: (
        _ctx: ExtensionContext,
        chatId?: number,
        options?: { target?: { threadId?: number }; ensure?: boolean },
      ) => {
        typingEnsures.push(options?.ensure === true);
        return events.push(`typing:${chatId ?? "none"}:${options?.target?.threadId ?? "all"}`);
      },
    },
    deferredQueueDispatchRuntime: { request: () => {} },
    modelContextAvailabilityRuntime: { reconcile: () => {} },
    buttonActionStore: { register: () => "button-action" },
    callMultipart: async () => ({ ok: true }),
    sendChatAction: async () => ({ ok: true }),
    sendRecordVoiceAction: async () => ({ ok: true }),
    sendMarkdownReply: async (
      _chatId: number,
      _replyTo: number | undefined,
      text: string,
    ) => {
      events.push(`send:${text}`);
      return 77;
    },
    sendTextReply: async () => ({ ok: true }),
    editInteractiveMessage: async () => events.push("edit"),
    deleteMessage: async () => undefined,
    dispatchNextQueuedTelegramTurn: () => {},
    answerGuestQuery: async () => ({ ok: true }),
    sendGuestReply: async () => ({ ok: true }),
    finalizeMarkdownPreview: async () => undefined,
    proactivePushTargetGetter: () => ({ chatId: 42, threadId: 8 }),
    canSendAgentActivity: () => true,
    getSessionGeneration: () => generation,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramLifecycleRuntimeHooks>[0];
  const steerBinding = createTelegramQueueBindingRuntime({ store: steerStore, deferredDispatch: deferred,
    queue: runtime.queue, lifecycle: runtime.lifecycle, activeTurn: deps.activeTurnRuntime,
    admission: { getSettlement: () => undefined, hasPendingQueueMutationForItem: () => false },
    transportStamp: { isActive: () => true }, isIdle: () => false, hasPendingMessages: () => nativePending,
    isContextCurrent: ctx => ctx === steerContext, isContextAborted: () => aborted,
    promptDispatch: { startTypingLoop: () => assert.fail("An active packet cannot start typing/preview ownership"),
      onPromptDispatchStart: () => assert.fail("An active packet cannot publish a new pending head"), onPromptDispatchFailure() {} },
    sendUserMessage: () => assert.fail("An active packet cannot issue an idle user prompt"), sendTextReply: async () => undefined,
    updateStatus() {} });
  deps.onSteerTurnEnd = steerBinding.onTurnEnd;
  registerTelegramLifecycleRuntimeHooks(deps);

  await getRequiredBindingHandler(harness.handlers, "agent_start")(
    { type: "agent_start" },
    { abort: () => undefined } as ExtensionContext,
  );
  activeTurn = true;
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_start")(
    { kind: "confirm", title: "Approve?" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_end")(
    {},
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "message_start")(
    { message: {} },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "message_update")(
    {
      message: {},
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "ponder <edge>",
      },
    },
    {} as ExtensionContext,
  );
  const waiting: Queue.PendingTelegramTurn[] = [11, 12].map((id, index) => ({ ...active,
    queueOrder: index + 2, laneOrder: index + 2, queueLane: "steer", replyToMessageId: id,
    sourceMessageIds: [id], content: [{ type: "text", text: `steer-${id}` }], voiceReplyRequired: false }));
  const image = { type: "image" as const, data: "fixture-image", mimeType: "image/png" };
  waiting[1]!.content.push(image);
  const activeSnapshot = structuredClone(active);
  for (const item of waiting) steerBinding.mutation.append(item, steerContext);
  const boundary = getRequiredBindingHandler(harness.handlers, "turn_end");
  const prior: NonNullable<TurnEndEventResult["entries"]> = [{ type: "custom_message", customType: "earlier-producer",
    content: "prior", display: true }];
  const event = { type: "turn_end", turnIndex: 1, outcome: "completed", entries: prior };
  const beforeEvents = [...events], beforePreviewResets = previewResets;
  for (const guard of ["native", "compaction", "tools", "abort", "control"] as const) {
    nativePending = guard === "native"; aborted = guard === "abort";
    runtime.lifecycle.setCompactionInProgress(guard === "compaction");
    runtime.lifecycle.setActiveToolExecutions(guard === "tools" ? 1 : 0);
    if (guard === "control") steerStore.setQueuedItems([{ ...active, queueOrder: 4, laneOrder: 4,
      queueLane: "control", content: [{ type: "text", text: "continue after model selection" }] }, ...waiting]);
    assert.equal(await boundary(event, steerContext), undefined, guard);
    assert.ok(waiting.every(item => !item.steerAttempted), "Readiness refusal cannot spend waiting input");
    steerStore.setQueuedItems([...waiting]);
  }
  const proposal = await boundary(event, steerContext) as TurnEndEventResult;
  assert.equal(proposal.continue, true);
  assert.equal(proposal.entries?.[0], prior[0], "Earlier producers retain their public boundary drafts");
  assert.equal(proposal.entries?.length, 2);
  const packetDraft = proposal.entries![1]!;
  assert.equal(packetDraft.type, "custom_message");
  if (packetDraft.type === "custom_message") {
    assert.ok(Array.isArray(packetDraft.content));
    assert.equal(packetDraft.content[packetDraft.content.length - 1], image, "Whole image blocks retain FIFO identity");
  }
  assert.deepEqual(active, activeSnapshot, "No anchor, source, voice or original content metadata is rewritten");
  assert.equal(steerStore.getQueuedItems().length, 0);
  assert.equal(deps.activeTurnRuntime.get(), active, "The existing reply/voice/anchor owner remains the same object");
  assert.equal(active.replyToMessageId, 20); assert.equal(active.voiceReplyRequired, true);
  assert.equal(previewResets, beforePreviewResets, "Model-step insertion cannot clear or replace preview state");
  assert.deepEqual(events, beforeEvents, "No typing, activity restart or delivery is emitted by the packet hook");
  await getRequiredBindingHandler(harness.handlers, "tool_execution_start")(
    {
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "read",
      args: { path: "README.md" },
    },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_compact")(
    { type: "session_compact" },
    {} as ExtensionContext,
  );
  activeTurn = false;
  await getRequiredBindingHandler(harness.handlers, "agent_end")(
    { type: "agent_end", messages: [] },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_start")(
    { kind: "confirm", title: "Approve compaction?" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_end")(
    {},
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_compact")(
    { type: "session_compact" },
    {} as ExtensionContext,
  );

  await deps.publicationRuntime.enqueue(async () => {});
  const expected = [
    "activity:agent-start:none",
    "typing:42:8",
    "activity:ui-start:confirm:Approve?",
    "activity:ui-end",
    "typing:42:9",
    "typing:42:9",
    "preview:start",
    "typing:42:9",
    "activity:assistant:thinking_delta",
    "typing:42:9",
    "preview:update",
    "typing:42:9",
    "activity:tool-start:read",
    "activity:compact-start:unknown",
    "typing:42:9",
    "send:**🗜 Compaction started.**",
    "activity:compact-end:unknown",
    "send:**✅ Compaction completed.**",
    "activity:agent-end",
    "activity:compact-start:unknown",
    "typing:42:8",
    "send:**🗜 Compaction started.**",
    "activity:ui-start:confirm:Approve compaction?",
    "activity:ui-end",
    "typing:42:8",
    "activity:compact-end:unknown",
    "send:**✅ Compaction completed.**",
  ];
  assert.ok(typingEnsures.length > 0 && typingEnsures.every(Boolean), "Activity, streaming, UI resume and compaction must ensure existing presence");
  // Pi hooks keep their order without waiting for the independently delivered projection.
  assert.deepEqual(events.filter((event) => !event.startsWith("send:")), expected.filter((event) => !event.startsWith("send:")));
  assert.deepEqual(events.filter((event) => event.startsWith("send:")), expected.filter((event) => event.startsWith("send:")));

  events.length = 0; activeTurn = true;
  let finish!: () => void;
  previewGate = new Promise<void>(resolve => { finish = resolve; });
  const sameContext = { abort() {} } as ExtensionContext;
  const oldMessage = getRequiredBindingHandler(harness.handlers, "message_start")({ message: {} }, sameContext);
  await Promise.resolve(); generation++; finish(); await oldMessage;
  assert.deepEqual(events, ["typing:42:9", "preview:start"], "A held old message cannot re-arm typing in its finally after a generation change");
  events.length = 0;
  const oldStart = getRequiredBindingHandler(harness.handlers, "agent_start")({ type: "agent_start" }, sameContext);
  generation++; await oldStart;
  assert.deepEqual(events, [], "A superseded agent-start continuation cannot publish activity or claim replacement typing");

  typingEnsures.length = 0;
  activeTurn = false;
  steerStore.setQueuedItems([{ ...active, queueLane: "default" }]);
  runtime.lifecycle.setDispatchPending(true);
  await getRequiredBindingHandler(harness.handlers, "agent_start")({ type: "agent_start" }, sameContext);
  assert.deepEqual(typingEnsures, [false, true], "Queued handoff replaces the owner before ordinary activity ensures it");
});
