/**
 * Regression tests for Telegram bus-aware API runtime
 * Verifies follower outbound API calls route through the local bus while leaders use direct transport
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitForTurn } from "node:timers/promises";
import { createTelegramTransportStampRuntime } from "../lib/queue.ts";
import type { TelegramInlineKeyboardMarkup } from "../lib/keyboard.ts";
import type { TelegramApiUiAuthorityOptions } from "../lib/telegram-api.ts";
import { createTelegramButtonActionStore, planTelegramButtonReply, handleTelegramButtonCallbackQuery } from "../lib/outbound-buttons.ts";
import { createTelegramButtonPublicationEditor, createTelegramButtonSelectionAuthorityCapture, createTelegramQuestionAuthorityCapture, createTelegramArtifactTransportAuthorityCapture, createTelegramBusAwareApiRuntime, createTelegramSelectedMenuTextApi } from "../lib/bus-api.ts";
import { createTelegramBusFollowerRegistrationState } from "../lib/bus-follower.ts";
import { createTelegramExtensionSectionRegistry, handleTelegramSectionCallback, type TelegramSectionRuntimeDeps } from "../lib/sections.ts";
import { createTelegramBusLeaderApiProxy } from "../lib/bus-leader.ts";
import { createTelegramBusProtocolIdentity } from "../lib/bus.ts";
import { assertTelegramApiCallAuthority, callTelegram, createTelegramApiClient, createTelegramBridgeApiRuntime, setTelegramApiHttpsFetchForTesting, TelegramApiAuthorityError, type TelegramApiClient, type TelegramBridgeApiRuntime, type TelegramApiCallOptions } from "../lib/telegram-api.ts";
import { captureTelegramStaleTargetRequestRecovery, type TelegramSyncState } from "../lib/sync.ts";
import type { TelegramTopicTargetRecord } from "../lib/threads.ts";
import { createTelegramTypingLoop, createTelegramTypingLoopStarter } from "../lib/runtime.ts";
import { createTelegramSessionContextStore } from "../lib/lifecycle.ts";
import { createPassthroughFailureLog } from "./fixtures/failure-log.ts";

for (const fault of ["role", "publisher", "method", "provider", "scope", "bot-provider"] as const)
test(`Coordinated question capture retains its original direct publisher (${fault})`, () => {
  const direct = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "unused"), tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  let owns = true, owner = {}, captures = 0;
  const capture = () => { captures++; const original = owner; return () => { if (owner !== original) throw new Error("Ended native question owner"); }; };
  const deps = { directRuntime: direct, ownsDirect: () => owns, captureQuestionAuthority: capture, getQuestionBotId: undefined as (() => number | undefined) | undefined, callFollowerApi: async () => assert.fail("No remote publication") };
  const api = createTelegramBusAwareApiRuntime(deps), original = api.captureQuestionAuthority!(); assert.ok(original); original(); assert.equal(captures, 1);
  const method = direct.sendMessage, originalOwner = owner;
  if (fault === "role") owns = false;
  if (fault === "publisher") deps.directRuntime = { ...direct };
  if (fault === "method") direct.sendMessage = async () => ({ message_id: 1 });
  if (fault === "provider") deps.captureQuestionAuthority = () => () => {};
  if (fault === "scope") owner = {};
  if (fault === "bot-provider") deps.getQuestionBotId = () => 123;
  assert.throws(original);
  owns = true; deps.directRuntime = direct; direct.sendMessage = method; deps.captureQuestionAuthority = capture; owner = originalOwner; deps.getQuestionBotId = undefined;
  assert.throws(original, "Equal-field restoration cannot revive the original scope");
  assert.ok(api.captureQuestionAuthority!(), "Only a genuinely new capture may use the restored native owner");
});

for (const fault of ["healthy", "local-loss", "receiver-loss", "sender", "local-provider", "receiver-provider", "bot-reader", "bot", "role", "async-local", "async-receiver"] as const)
test(`Follower question birth retains original local/receiver/publisher witnesses (${fault})`, () => {
  let local = {}, receiver = {}, bot = 123, direct = false;
  const capture = () => { const owned = local; return () => { if (fault === "async-local") return Promise.resolve(); if (local !== owned) throw new Error("Local birth ended"); }; };
  const captureReceiver = () => { const owned = receiver; return () => { if (fault === "async-receiver") return Promise.resolve(); if (receiver !== owned) throw new Error("Receiver birth ended"); }; };
  const deps = { directRuntime: {} as TelegramBridgeApiRuntime, ownsDirect: () => direct, captureQuestionAuthority: capture,
    captureFollowerApiRegistration: captureReceiver, getQuestionBotId: () => bot, callFollowerApi: async () => ({ message_id: 1 }) };
  const api = createTelegramBusAwareApiRuntime(deps), original = api.captureQuestionAuthority!();
  if (fault === "async-local" || fault === "async-receiver") { assert.equal(original, undefined); return; }
  assert.ok(original); original(); if (fault === "healthy") return;
  const oldLocal = local, oldReceiver = receiver, send = deps.callFollowerApi, readBot = deps.getQuestionBotId;
  if (fault === "local-loss") local = {};
  if (fault === "receiver-loss") receiver = {};
  if (fault === "sender") deps.callFollowerApi = async () => ({ message_id: 1 });
  if (fault === "local-provider") deps.captureQuestionAuthority = () => () => {};
  if (fault === "receiver-provider") deps.captureFollowerApiRegistration = () => () => {};
  if (fault === "bot-reader") deps.getQuestionBotId = () => bot;
  if (fault === "bot") bot = 456;
  if (fault === "role") direct = true;
  assert.throws(original);
  local = oldLocal; receiver = oldReceiver; deps.callFollowerApi = send; deps.captureQuestionAuthority = capture; deps.captureFollowerApiRegistration = captureReceiver;
  deps.getQuestionBotId = readBot; bot = 123; direct = false;
  assert.throws(original, "Equal fields cannot revive original question birth");
});

for (const rich of [false, true]) for (const frame of ["complete", "legacy", "wrong-bot", "wrong-thread", "business", "accessor", "zero-id", "boolean", "no-bot", "undefined-bot", "no-scope", "async-scope", "bot-provider", "bot-value", "publisher", "method", "provider", "role", "lost-during", "boundary-loss", "local-loss", "headed", "hint-getter"] as const)
test(`Direct ordinary first wire retains original publication and native carrier (${rich}/${frame})`, async () => {
  let owner = {}, bot = 123, owns = true, calls = 0, getters = 0, succeeded: boolean | undefined;
  const policies: string[] = [], message: Record<string, unknown> = { message_id: 55, chat: { id: 7 }, message_thread_id: 42, from: { id: 123, is_bot: true } };
  if (frame === "legacy") { delete message.chat; delete message.from; delete message.message_thread_id; }
  if (frame === "wrong-bot") message.from = { id: 456, is_bot: true };
  if (frame === "wrong-thread") message.message_thread_id = 43;
  if (frame === "business") message.business_connection_id = "separate";
  if (frame === "zero-id") message.message_id = 0;
  if (frame === "accessor") Object.defineProperty(message, "from", { get() { getters++; return { id: 123, is_bot: true }; } });
  const capture = (): (() => void) | undefined => { const born = owner; return frame === "no-scope" ? undefined : frame === "async-scope" ? async () => {} : () => { if (owner !== born) throw new Error("Original direct owner ended"); }; };
  const client = { async call(_method: string, _body: unknown, options?: TelegramApiCallOptions) {
    const guarded = !["no-bot", "undefined-bot", "no-scope", "async-scope", "headed", "hint-getter"].includes(frame);
    assert.equal(typeof options?.assertAuthority === "function", guarded);
    if (guarded) { assert.equal(options?.maxAttempts, 1); assert.equal(options?.retrySafety, "non-idempotent"); }
    if (frame === "boundary-loss") bot = 456;
    options?.assertAuthority?.(); calls++;
    if (frame === "lost-during") owner = {};
    options?.assertAuthority?.();
    return frame === "boolean" ? true : message;
  } } as unknown as TelegramApiClient;
  const direct = createTelegramBridgeApiRuntime({ client, tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const deps = { directRuntime: direct, ownsDirect: () => owns, captureQuestionAuthority: capture,
    getQuestionBotId: frame === "no-bot" ? undefined : () => frame === "undefined-bot" ? undefined : bot,
    callFollowerApi: async () => assert.fail("No follower fallback"), beginButtonPublication() {
      if (frame === "bot-provider") deps.getQuestionBotId = () => bot;
      if (frame === "bot-value") bot = 456;
      if (frame === "publisher") deps.directRuntime = { ...direct };
      if (frame === "method") direct.sendMessage = async () => ({ message_id: 55 });
      if (frame === "provider") deps.captureQuestionAuthority = () => () => {};
      if (frame === "role") owns = false;
      if (frame === "headed") owner = {};
      const finish = Object.assign((_value: unknown, ok: boolean) => { succeeded = ok; }, {
        ...(frame === "headed" || frame === "hint-getter" ? {} : { ordinarySource: "first-send" as const }),
        restrictQuestionMembership(policy: "first-send" | "known-parent-edit" | "none") { policies.push(policy); },
      });
      if (frame === "hint-getter") Object.defineProperty(finish, "ordinarySource", { get() { getters++; throw new Error("Foreign hint getter"); } });
      return finish;
    } };
  const api = createTelegramBusAwareApiRuntime(deps), local = () => { if (frame === "local-loss") bot = 456; };
  const work = rich ? api.sendRichMessage({ chat_id: 7, message_thread_id: 42, rich_message: { markdown: "Ordinary source" } }, frame === "local-loss" ? { assertAuthority: local } : undefined) :
    api.sendMessage({ chat_id: 7, message_thread_id: 42, text: "Ordinary source" }, frame === "local-loss" ? { assertLocalAuthority: local } : undefined);
  const refused = ["bot-provider", "bot-value", "publisher", "method", "provider", "role", "lost-during", "boundary-loss", "local-loss"].includes(frame);
  if (refused) { await assert.rejects(work); assert.equal(succeeded, false); assert.equal(calls, frame === "lost-during" ? 1 : 0); }
  else {
    await work; assert.equal(succeeded, true); assert.equal(calls, 1);
    assert.deepEqual(policies, ["no-bot", "undefined-bot", "no-scope", "async-scope", "headed", "hint-getter"].includes(frame) ? [] : frame === "complete" ? ["first-send"] : ["first-send", "none"]);
  }
  assert.equal(getters, 0, "Neither DTO carrier nor hint accessors can mint native publication evidence");
});

for (const rich of [false, true]) for (const phase of ["complete", "before-http", "after-response", "rate-limit", "server"] as const)
test(`Direct first-wire native HTTP fences one irreversible attempt (${rich}/${phase})`, async () => {
  const previous = globalThis.fetch; let bot = 123, calls = 0;
  globalThis.fetch = async () => {
    calls++; if (phase === "after-response") bot = 456;
    const status = phase === "rate-limit" ? 429 : phase === "server" ? 503 : 200;
    return new Response(JSON.stringify(status === 200 ? { ok: true, result: { message_id: 55, chat: { id: 7 }, from: { id: 123, is_bot: true } } } :
      { ok: false, error_code: status, description: "Native first-wire refusal", parameters: { retry_after: 0 } }), { status });
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  try {
    const client = createTelegramApiClient(() => { if (phase === "before-http") bot = 456; return "123:first-wire-fixture"; });
    const native = createTelegramBridgeApiRuntime({ client, tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
    let settled: boolean | undefined;
    const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, captureQuestionAuthority: () => () => {}, getQuestionBotId: () => bot,
      callFollowerApi: async () => assert.fail("No remote retry"), beginButtonPublication: () => Object.assign((_result: unknown, ok: boolean) => { settled = ok; },
        { ordinarySource: "first-send" as const, restrictQuestionMembership() {} }) });
    const pending = rich ? api.sendRichMessage({ chat_id: 7, rich_message: { markdown: "Native source" } }) : api.sendMessage({ chat_id: 7, text: "Native source" });
    if (phase === "complete") { assert.equal((await pending).message_id, 55); assert.equal(settled, true); }
    else { await assert.rejects(pending, error => { if (phase === "before-http") assert.ok(error instanceof TelegramApiAuthorityError && !error.requestIssued); if (phase === "after-response") assert.ok(error instanceof TelegramApiAuthorityError && error.requestIssued); if (phase === "server") assert.equal((error as Error).name, "TelegramApiCommitUnknownError"); return true; }); assert.equal(settled, false); }
    assert.equal(calls, phase === "before-http" ? 0 : 1, "Known refusal, lost original authority and server/rate pressure cannot replay the first wire");
  } finally { restore(); globalThis.fetch = previous; }
});

for (const rich of [false, true]) for (const frame of ["complete", "legacy", "wrong-bot", "no-thread", "accessor", "lost-before", "lost-during", "sender-swap"] as const)
test(`Follower publication preserves I/O while qualifying only original complete first-send (${rich}/${frame})`, async () => {
  let receiver = {}, calls = 0, held = 0, getters = 0, succeeded: boolean | undefined;
  const message: Record<string, unknown> = { message_id: 55, chat: { id: 7 }, message_thread_id: 42, from: { id: 123, is_bot: true } };
  if (frame === "legacy") { delete message.chat; delete message.from; delete message.message_thread_id; }
  if (frame === "wrong-bot") message.from = { id: 456, is_bot: true };
  if (frame === "no-thread") delete message.message_thread_id;
  if (frame === "accessor") Object.defineProperty(message, "from", { get() { getters++; return { id: 123, is_bot: true }; } });
  const deps = { directRuntime: {} as TelegramBridgeApiRuntime, ownsDirect: () => false, captureQuestionAuthority: () => () => {}, getQuestionBotId: () => 123,
    captureFollowerApiRegistration() { const original = receiver; return () => { if (receiver !== original) throw new Error("Receiver ended"); }; },
    beginButtonPublication() {
      if (frame === "lost-before") receiver = {};
      if (frame === "sender-swap") deps.callFollowerApi = async () => { calls++; return message; };
      return Object.assign((_result: unknown, ok: boolean) => { succeeded = ok; }, { restrictQuestionMembership(policy: "first-send" | "known-parent-edit" | "none") { if (policy === "none") held++; } });
    }, async callFollowerApi(_method: string, args: unknown[], options?: Pick<TelegramApiCallOptions, "assertAuthority">) {
      assert.equal((args[2] as { maxAttempts?: number }).maxAttempts, 1); options?.assertAuthority?.(); calls++;
      if (frame === "lost-during") receiver = {};
      return message;
    } };
  const api = createTelegramBusAwareApiRuntime(deps);
  const work = rich ? api.sendRichMessage({ chat_id: 7, message_thread_id: 42, rich_message: { markdown: "Question" } }) : api.sendMessage({ chat_id: 7, message_thread_id: 42, text: "Question" });
  if (["lost-before", "lost-during", "sender-swap"].includes(frame)) {
    await assert.rejects(work); assert.equal(succeeded, false); assert.equal(calls, frame === "lost-during" ? 1 : 0);
  } else {
    assert.equal((await work).message_id, 55); assert.equal(succeeded, true); assert.equal(calls, 1); assert.equal(held, frame === "complete" ? 0 : 1);
  }
  assert.equal(getters, 0, "A foreign DTO getter cannot certify native sender identity");
});

for (const markup of [false, true]) for (const phase of ["complete", "legacy", "boolean", "wrong-id", "wrong-bot", "wrong-thread", "accessor", "unchanged", "provider", "during", "missing-scope", "no-observer", "duplicate", "late", "local-loss"] as const)
test(`Direct original edit carrier stays separate from its public result (${markup}/${phase})`, async () => {
  let calls = 0, owner = {}, getters = 0, native: unknown, outcome: unknown, succeeded: boolean | undefined, late: ((value: unknown) => void) | undefined;
  const policies: string[] = [], message: Record<string, unknown> = { message_id: phase === "wrong-id" ? 56 : 55, chat: { id: 7 },
    message_thread_id: phase === "wrong-thread" ? 43 : 42, from: { id: phase === "wrong-bot" ? 456 : 123, is_bot: true } };
  if (phase === "legacy") { delete message.chat; delete message.from; }
  if (phase === "accessor") Object.defineProperty(message, "from", { get() { getters++; return { id: 123, is_bot: true }; } });
  const client = { async call(_method: string, _body: unknown, options?: TelegramApiCallOptions) {
    options?.assertAuthority?.(); calls++;
    if (phase === "unchanged") throw new Error("Bad Request: message is not modified");
    if (phase === "during") owner = {};
    return phase === "boolean" ? true : message;
  } } as unknown as TelegramApiClient;
  const direct = createTelegramBridgeApiRuntime({ client, tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  if (["no-observer", "duplicate", "late"].includes(phase)) {
    const adapt = (options?: TelegramApiUiAuthorityOptions): TelegramApiUiAuthorityOptions | undefined => {
      const receive = options?.onNativeEditResult;
      if (phase === "late") late = receive;
      return options ? { ...options, onNativeEditResult: phase === "duplicate" ? value => { receive?.(value); receive?.(value); } : undefined } : options;
    };
    const text = direct.editMessageText, keyboard = direct.editMessageReplyMarkup;
    direct.editMessageText = (body, options) => text(body, adapt(options));
    direct.editMessageReplyMarkup = (chat, id, keys, options) => keyboard(chat, id, keys, adapt(options));
  }
  const deps = { directRuntime: direct, ownsDirect: () => true, getQuestionBotId: phase === "missing-scope" ? undefined : () => 123,
    captureQuestionAuthority() { const original = owner; return () => { if (owner !== original) throw new Error("Original edit owner lost"); }; },
    callFollowerApi: async () => assert.fail("No raw/remote replay"), beginButtonPublication() {
      if (phase === "provider") deps.getQuestionBotId = () => 123;
      return Object.assign((value: unknown, ok: boolean, _rejected?: boolean, raw?: unknown) => { outcome = value; succeeded = ok; native = raw; },
        { ordinarySource: "known-parent-edit" as const, restrictQuestionMembership(policy: string) { policies.push(policy); } });
    } };
  const api = createTelegramBusAwareApiRuntime(deps), options: TelegramApiUiAuthorityOptions | undefined = phase === "local-loss" ? { assertLocalAuthority: () => { owner = {}; } } : undefined;
  const pending = markup ? api.editMessageReplyMarkup(7, 55, {}, options) : api.editMessageText({ chat_id: 7, message_id: 55, message_thread_id: 42, text: "Native child" }, options);
  const refused = ["provider", "during", "local-loss"].includes(phase) || markup && ["boolean", "wrong-id", "legacy", "unchanged"].includes(phase);
  if (refused) { await assert.rejects(pending); assert.equal(succeeded, false); }
  else {
    assert.equal(await pending, markup ? undefined : phase === "unchanged" ? "unchanged" : "edited"); assert.equal(succeeded, true);
    assert.equal(outcome, phase === "unchanged" ? "unchanged" : "edited");
    assert.equal(native, ["missing-scope", "no-observer", "duplicate", "late", "unchanged"].includes(phase) ? undefined : phase === "boolean" ? true : message);
    // Positional markup omits request Thread; the Store's captured physical parent must match the raw carrier.
    assert.deepEqual(policies, phase === "missing-scope" ? ["none"] : phase === "complete" || markup && phase === "wrong-thread" ? ["known-parent-edit"] : ["known-parent-edit", "none"]);
  }
  if (phase === "late") { late?.(message); assert.equal(native, undefined, "Settled evidence cannot be renewed by a late result callback"); }
  assert.equal(getters, 0); assert.equal(calls, ["provider", "local-loss"].includes(phase) ? 0 : 1);
});

for (const markup of [false, true]) for (const phase of ["complete", "rate-limit", "server", "after-response", "unchanged"] as const)
test(`Direct native edit keeps original HTTP settlement without replay (${markup}/${phase})`, async () => {
  const previous = globalThis.fetch; let owner = {}, calls = 0, raw: unknown, settled: boolean | undefined;
  globalThis.fetch = async () => {
    calls++; if (phase === "after-response") owner = {};
    const status = phase === "rate-limit" ? 429 : phase === "server" ? 503 : phase === "unchanged" ? 400 : 200;
    return new Response(JSON.stringify(status === 200 ? { ok: true, result: { message_id: 55, chat: { id: 7 }, from: { id: 123, is_bot: true } } } :
      { ok: false, error_code: status, description: phase === "unchanged" ? "Bad Request: message is not modified" : "Native edit refusal", parameters: { retry_after: 0 } }), { status });
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  try {
    const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:edit-carrier-fixture"), tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
    const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, getQuestionBotId: () => 123,
      captureQuestionAuthority() { const original = owner; return () => { if (owner !== original) throw new Error("Original native edit ended"); }; },
      callFollowerApi: async () => assert.fail("No replacement/raw retry"), beginButtonPublication: () => Object.assign((_value: unknown, ok: boolean, _rejected?: boolean, result?: unknown) => { settled = ok; raw = result; },
        { ordinarySource: "known-parent-edit" as const, restrictQuestionMembership() {} }) });
    const pending = markup ? api.editMessageReplyMarkup(7, 55, {}) : api.editMessageText({ chat_id: 7, message_id: 55, text: "Original edit" });
    if (phase === "complete") { assert.equal(await pending, markup ? undefined : "edited"); assert.equal(settled, true); assert.equal((raw as { message_id: number }).message_id, 55); }
    else if (phase === "unchanged" && !markup) { assert.equal(await pending, "unchanged"); assert.equal(raw, undefined); }
    else { await assert.rejects(pending, error => { if (phase === "after-response") assert.ok(error instanceof TelegramApiAuthorityError && error.requestIssued); if (phase === "server") assert.equal((error as Error).name, "TelegramApiCommitUnknownError"); return true; }); assert.equal(settled, false); assert.equal(raw, undefined); }
    assert.equal(calls, 1, "Native edit observation must never reissue an acknowledged, refused or uncertain operation");
  } finally { restore(); globalThis.fetch = previous; }
});

for (const kind of ["text", "markup"] as const) for (const threaded of [false, true]) for (const frame of ["complete", "legacy", "wrong-id", "wrong-bot", "boolean", "accessor"] as const)
test(`Follower edit retains native carrier separately from its legacy outcome (${kind}/${threaded}/${frame})`, async () => {
  let getters = 0, held = 0, calls = 0, native: unknown, outcome: unknown, succeeded: boolean | undefined;
  const message: Record<string, unknown> = { message_id: frame === "wrong-id" ? 56 : 55, chat: { id: 7 },
    ...(threaded ? { message_thread_id: 42 } : {}), from: { id: frame === "wrong-bot" ? 456 : 123, is_bot: true } };
  if (frame === "legacy") { delete message.chat; delete message.from; }
  if (frame === "accessor") Object.defineProperty(message, "from", { get() { getters++; return { id: 123, is_bot: true }; } });
  const carrier = frame === "boolean" ? true : message;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: {} as TelegramBridgeApiRuntime, ownsDirect: () => false,
    captureQuestionAuthority: () => () => {}, captureFollowerApiRegistration: () => () => {}, getQuestionBotId: () => 123,
    beginButtonPublication() {
      return Object.assign((result: unknown, ok: boolean, _rejected?: boolean, raw?: unknown) => { outcome = result; succeeded = ok; native = raw; },
        { restrictQuestionMembership(policy: "first-send" | "known-parent-edit" | "none") { if (policy === "none") held++; else assert.equal(policy, "known-parent-edit"); } });
    }, async callFollowerApi(_method, args, options) {
      calls++; assert.equal(args[0], kind === "text" ? "editMessageText" : "editMessageReplyMarkup"); assert.equal((args[2] as { maxAttempts: number }).maxAttempts, 1); options?.assertAuthority?.(); return carrier;
    } });
  const edited = kind === "text" ? await api.editMessageText({ chat_id: 7, message_id: 55, text: "Replacement" }) : await api.editMessageReplyMarkup(7, 55, {});
  assert.equal(edited, kind === "text" ? "edited" : undefined);
  assert.equal(calls, 1); assert.equal(outcome, kind === "text" ? "edited" : undefined); assert.equal(succeeded, true); assert.equal(native, carrier);
  assert.equal(held, frame === "complete" ? 0 : 1); assert.equal(getters, 0, "Native sender proof never invokes DTO getters");
});

for (const rich of [false, true])
test(`Question capture never enrolls non-question follower traffic (${rich})`, async () => {
  let calls = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: {} as TelegramBridgeApiRuntime, ownsDirect: () => false,
    captureQuestionAuthority: () => () => {}, captureFollowerApiRegistration: () => () => {}, getQuestionBotId: () => 123,
    beginButtonPublication: () => undefined, async callFollowerApi(_method, args, options) {
      calls++; assert.equal(args.length, 2); assert.equal(options, undefined); return { message_id: 55 };
    } });
  const result = rich ? await api.sendRichMessage({ chat_id: 7, rich_message: { markdown: "Ordinary message" } }) : await api.sendMessage({ chat_id: 7, text: "Ordinary message" });
  assert.equal(result.message_id, 55); assert.equal(calls, 1);
});

test("A follower retains ordinary message delivery without coordinated question authority", async () => {
  let captures = 0, sends = 0;
  const direct = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "unused"), tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: direct, ownsDirect: () => false,
    captureQuestionAuthority() { captures++; return () => {}; }, callFollowerApi: async () => { sends++; return { message_id: 9 }; } });
  assert.equal(api.captureQuestionAuthority!(), undefined); assert.equal(captures, 0);
  assert.deepEqual(await api.sendMessage({ chat_id: 7, text: "Independent legacy delivery" }), { message_id: 9 });
  assert.equal(sends, 1); assert.equal(captures, 0);
});

for (const direct of [true, false]) for (const rich of [true, false]) for (const threaded of [true, false])
test(`Acknowledged callback footer expires without input (direct=${direct}, rich=${rich}, threaded=${threaded})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const edits: Array<{ chatId: number; messageId: number; markup: TelegramInlineKeyboardMarkup }> = [];
  const store = createTelegramButtonActionStore({ captureSelectionAuthority: () => () => {} });
  const plan = planTelegramButtonReply('<!-- telegram_choice {"question":"Format?","choices":["PDF","CSV"],"timeoutMs":100} -->',
    { registerAction: store.register });
  const markup = { inline_keyboard: [...plan.replyMarkup!.inline_keyboard, [{ text: "Menu", callback_data: "menu:current" }]] };
  const native = {
    sendMessage: async () => ({ message_id: 11 }), sendRichMessage: async () => ({ message_id: 11 }),
    async editMessageReplyMarkup(chatId: number, messageId: number, next: unknown, options?: TelegramApiUiAuthorityOptions) {
      assert.equal(typeof options?.assertLocalAuthority, "function"); options?.assertLocalAuthority?.();
      edits.push({ chatId, messageId, markup: next as TelegramInlineKeyboardMarkup });
    },
  } as unknown as TelegramBridgeApiRuntime;
  const api = createTelegramBusAwareApiRuntime({
    directRuntime: native, ownsDirect: () => direct, beginButtonPublication: store.beginPublication,
    getDefaultTarget: () => ({ chatId: 7, threadId: 9 }),
    async callFollowerApi(method, args, options) {
      assert.equal(method, "call"); options?.assertAuthority?.();
      assert.equal(JSON.stringify(args).includes("assertLocalAuthority"), false);
      if (args[0] === "editMessageReplyMarkup") {
        const body = args[1] as { chat_id: number; message_id: number; reply_markup: TelegramInlineKeyboardMarkup }; edits.push({ chatId: body.chat_id, messageId: body.message_id, markup: body.reply_markup }); return true;
      }
      return { message_id: 11 };
    },
  });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const common = { chat_id: 7, ...(threaded ? { message_thread_id: 9 } : {}), reply_markup: markup };
  if (rich) await api.sendRichMessage({ ...common, rich_message: { markdown: plan.markdown } });
  else await api.sendMessage({ ...common, text: plan.markdown, parse_mode: "HTML" });
  assert.equal(edits.length, 0);
  t.mock.timers.tick(100); await store.waitForPublicationIdle!();
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.chatId, 7); assert.equal(edits[0]!.messageId, 11);
  for (const row of edits[0]!.markup.inline_keyboard.slice(0, -1)) for (const button of row) {
    assert.equal(button.callback_data, "tgbtn:expired"); assert.match(button.text, /^Expired: /u); assert.equal(button.disabled, undefined);
  }
  assert.equal(edits[0]!.markup.inline_keyboard.at(-1)![0]!.callback_data, "menu:current");
  assert.equal(store.resolve(markup.inline_keyboard[0]![0]!.callback_data), undefined);
  const answers: string[] = [];
  await handleTelegramButtonCallbackQuery({ id: "expired-tap", data: edits[0]!.markup.inline_keyboard[0]![0]!.callback_data,
    message: { chat: { id: 7 }, message_id: 11 } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async (_id, answer) => { answers.push(answer!); },
    enqueueButtonPrompt: () => assert.fail("Expired status cannot enqueue"), invokeBoundAction: async () => assert.fail("Expired status cannot invoke an app"),
  });
  assert.deepEqual(answers, ["Button action expired"]);
});

for (const diagnosticFailure of [false, true])
test(`Callback publications pin the first acknowledged message and its actual Thread, not a configured default (diagnosticFailure=${diagnosticFailure})`, async () => {
  const refusals: Array<Record<string, unknown>> = [];
  const store = createTelegramButtonActionStore({ recordRuntimeEvent(_category, _message, details) {
    if (details?.phase === "button-callback-unavailable") { refusals.push(details); if (diagnosticFailure) throw new Error("fixture diagnostic failure"); }
  } });
  store.bindPublicationEditor!(async () => {});
  const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] };
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }) } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, getDefaultTarget: () => ({ chatId: 7, threadId: 9 }), callFollowerApi: async () => undefined,
    beginButtonPublication: store.beginPublication });
  const query = (id: number, thread?: number) => ({ id: "q", data: key, message: { chat: { id: 7 }, message_id: id, ...(thread === undefined ? {} : { message_thread_id: thread }) } });
  assert.equal(store.resolve(key, query(11)), undefined, "No callback admission before publication ACK");
  await api.sendMessage({ chat_id: 7, text: "A", reply_markup: markup });
  assert.equal(store.resolve(key, query(12)), undefined);
  assert.equal(store.resolve(key, query(11, 9)), undefined, "A default target must not invent a Thread absent from the actual send");
  const copied = store.beginPublication!("sendMessage", { chat_id: 7, text: "Copy", reply_markup: markup });
  copied?.({ message_id: 12 }, true);
  assert.equal(store.resolve(key, query(12)), undefined, "A second publication cannot retarget the original callback");
  assert.equal(store.resolve(key, query(11))!.prompt, "A");
  assert.deepEqual(refusals.map(item => item.reason), ["publication-unavailable", "publication-mismatch", "publication-mismatch", "publication-mismatch"]);
  assert.ok(refusals.every(item => typeof item.ageMs === "number" && item.ttlMs === 86400000));
  assert.doesNotMatch(JSON.stringify(refusals), /tgbtn:|prompt|text/u);
  await store.waitForPublicationIdle!();
});

for (const direct of [true, false]) for (const reason of ["expiry", "completion", "capacity"] as const)
test(`Rich body retirement preserves content and active footer (direct=${direct}, ${reason})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const failures: unknown[] = [];
  const store = createTelegramButtonActionStore({ captureSelectionAuthority: () => () => {}, recordFailure: error => { failures.push(error); } });
  const label = "A\nB", bodyKey = store.register({ text: label, prompt: "A", expiresAt: 1100 });
  const footerKey = store.register({ text: "Footer", prompt: "Footer", expiresAt: 2000 });
  const markdown = '**History**\n\n<tg-button-row><tg-button type="callback_data" data="' + bodyKey + '">A\nB</tg-button></tg-button-row>\n\nFinal text.';
  const rich = { markdown, is_rtl: true, skip_entity_detection: false };
  const markup = { inline_keyboard: [[{ text: "Footer", callback_data: footerKey }, { text: "Menu", callback_data: "menu:current" }]] };
  const edited: Array<{ rich_message?: { markdown: string; is_rtl?: boolean; skip_entity_detection?: boolean }; reply_markup?: TelegramInlineKeyboardMarkup }> = [];
  const native = {
    sendRichMessage: async () => ({ message_id: 11 }),
    async editMessageText(body: typeof edited[number], options?: TelegramApiUiAuthorityOptions) {
      assert.equal(typeof options?.assertLocalAuthority, "function"); options?.assertLocalAuthority?.(); edited.push(body); return "edited";
    },
    editMessageReplyMarkup: async () => {},
  } as unknown as TelegramBridgeApiRuntime;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct, beginButtonPublication: store.beginPublication,
    async callFollowerApi(method, args, options) {
      assert.equal(method, "call"); options?.assertAuthority?.();
      if (args[0] === "editMessageText") { edited.push(args[1] as typeof edited[number]); return true; }
      return { message_id: 11 };
    } });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  await api.sendRichMessage({ chat_id: 7, message_thread_id: 9, rich_message: rich, reply_markup: markup });
  if (reason === "expiry") t.mock.timers.tick(100);
  else if (reason === "completion") assert.equal(store.resolve(bodyKey)!.prompt, "A");
  else for (let i = 0; i < 59; i++) store.register({ text: String(i), prompt: String(i) });
  await store.waitForPublicationIdle!();
  assert.equal(edited.length, 1);
  assert.deepEqual(edited[0]!.rich_message, { ...rich, markdown: reason === "completion"
    ? markdown.replace('type="callback_data" data="' + bodyKey + '"', 'type="disabled"')
    : markdown.replace('type="callback_data" data="' + bodyKey + '">', reason === "capacity" ? 'type="callback_data" data="tgbtn:capacity">Unavailable: ' : 'type="callback_data" data="tgbtn:expired">Expired: ') });
  assert.deepEqual(edited[0]!.reply_markup, markup);
  assert.equal(store.resolve(bodyKey), undefined);
  assert.equal(store.resolve(footerKey)!.prompt, "Footer");
  store.clear!(); await store.waitForPublicationIdle!();
  assert.deepEqual(failures, []);
});

for (const direct of [true, false]) for (const reason of ["deadline", "capacity"] as const)
test(`Rich retirement reaches the actual native guarded body editor (direct=${direct}, ${reason})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const originalFetch = globalThis.fetch, calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1)!; calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }), { status: 200 });
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  try {
    const store = createTelegramButtonActionStore({ captureSelectionAuthority: () => () => {} });
    const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:rich-retirement-fixture", { isThreadedMode: () => true }),
      tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
    const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
    const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct, beginButtonPublication: store.beginPublication,
      async callFollowerApi(method, args, options) {
        options?.assertAuthority?.();
        const result = await proxy(method, structuredClone(args));
        options?.assertAuthority?.(); return result;
      } });
    store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
    const key = store.register({ text: "A", prompt: "A", ...(reason === "deadline" ? { expiresAt: 1100 } : {}) });
    const markdown = 'History\n<tg-button-row><tg-button type="callback_data" data="' + key + '">A</tg-button></tg-button-row>';
    await api.sendRichMessage({ chat_id: 7, message_thread_id: 9, rich_message: { markdown } });
    t.mock.timers.tick(reason === "deadline" ? 100 : 900000);
    if (reason === "capacity") for (let i = 0; i < 60; i++) store.register({ text: "Pressure", prompt: "Pressure" });
    await store.waitForPublicationIdle!();
    assert.deepEqual(calls.map(call => call.method), ["sendRichMessage", "editMessageText"]);
    assert.deepEqual(calls[1]!.body.rich_message, { markdown: markdown.replace('type="callback_data" data="' + key + '">',
      reason === "capacity" ? 'type="callback_data" data="tgbtn:capacity">Unavailable: ' : 'type="callback_data" data="tgbtn:expired">Expired: ') });
    assert.equal(calls[1]!.body.chat_id, 7); assert.equal(calls[1]!.body.message_id, 11);
    assert.equal(JSON.stringify(calls).includes("assertLocalAuthority"), false);
    assert.equal(store.resolve(key), undefined);
    store.clear!(); await store.waitForPublicationIdle!();
  } finally { restore(); globalThis.fetch = originalFetch; }
});

test("Rich cleanup leaves literal fences, code spans, indentation and escaped markers byte-for-byte intact", async () => {
  const store = createTelegramButtonActionStore();
  const key = store.register({ text: "A", prompt: "A" });
  const row = '<tg-button-row><tg-button type="callback_data" data="' + key + '">A</tg-button></tg-button-row>';
  const literal = ['~~~html', row, '~~~', '', '\`' + row + '\`', '', '\`\`', row, '\`\`', '', '    ' + row, '', 'Escaped \\\` marker.'].join('\r\n');
  const markdown = literal + '\r\n' + row + '\r\nTail.';
  let visible = "";
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendRichMessage: async () => ({ message_id: 11 }),
    editMessageText: async (body: { rich_message: { markdown: string } }) => { visible = body.rich_message.markdown; return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  await api.sendRichMessage({ chat_id: 7, rich_message: { markdown } });
  store.resolve(key); await store.waitForPublicationIdle!();
  assert.equal(visible, literal + '\r\n' + row.replace('type="callback_data" data="' + key + '"', 'type="disabled"') + '\r\nTail.');
});

for (const extra of ["media", "html", "oversized"] as const)
test(`Rich background cleanup never replays an unsupported producer payload (${extra})`, async () => {
  const store = createTelegramButtonActionStore();
  let edits = 0;
  const key = store.register({ text: "A", prompt: "A" });
  const row = '<tg-button-row><tg-button type="callback_data" data="' + key + '">A</tg-button></tg-button-row>';
  const rich = { markdown: row + (extra === "oversized" ? "\n" + "x".repeat(65_536) : ""),
    ...(extra === "media" ? { media: [{ id: "private", media: { type: "photo", media: "private-source" } }] } : {}),
    ...(extra === "html" ? { html: "Unowned producer alternative" } : {}) };
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendRichMessage: async () => ({ message_id: 11 }),
    editMessageText: async () => { edits++; return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  await api.sendRichMessage({ chat_id: 7, rich_message: rich as unknown as Parameters<typeof api.sendRichMessage>[0]["rich_message"] });
  assert.equal(store.resolve(key, { id: "q", message: { chat: { id: 7 }, message_id: 11 } })!.prompt, "A");
  await store.waitForPublicationIdle!();
  assert.equal(edits, 0); assert.equal(store.resolve(key), undefined);
});

for (const field of ["chat_id", "message_id", "message_thread_id", "inline_message_id", "business_connection_id", "direct_messages_topic_id"] as const)
test(`Publication locator is pinned across the real queued edit lane (${field})`, async () => {
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] };
  const issued: Record<string, unknown>[] = [];
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    async editMessageText(body: Record<string, unknown>) { issued.push(body); if (issued.length === 1) { entered.resolve(); await release.promise; } return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  await api.sendMessage({ chat_id: 7, message_thread_id: 9, text: "Old", reply_markup: markup });
  const first = api.editMessageText({ chat_id: 7, message_id: 11, text: "First", reply_markup: markup }); await entered.promise;
  const body: Record<string, unknown> & { chat_id: number; message_id: number } = { chat_id: 7, message_id: 11, message_thread_id: 9, text: "Second", reply_markup: markup };
  const second = api.editMessageText(body); void second.catch(() => {});
  (body as Record<string, unknown>)[field] = field.endsWith("_id") && !["inline_message_id", "business_connection_id"].includes(field) ? 99 : "different";
  let drained = false; const idle = store.waitForPublicationIdle!().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
  try { release.resolve(); await first; await assert.rejects(second, /publication locator/u); await idle;
    assert.equal(issued.length, 1, "Changed locator must be refused before second native issuance");
    assert.equal(issued[0]!.message_id, 11); assert.equal(drained, true);
  } finally { release.resolve(); await Promise.allSettled([first, second]); store.clear!(); await store.waitForPublicationIdle!(); }
});

test("Publication locator validates the copied carrier rather than a self-restoring caller getter", async () => {
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] }; let issued = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    async editMessageText() { if (++issued === 1) { entered.resolve(); await release.promise; } return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  await api.sendMessage({ chat_id: 7, text: "Old", reply_markup: markup });
  const first = api.editMessageText({ chat_id: 7, message_id: 11, text: "First", reply_markup: markup }); await entered.promise;
  const body = { chat_id: 7, message_id: 11, text: "Second", reply_markup: markup }, second = api.editMessageText(body); void second.catch(() => {});
  Object.defineProperty(body, "message_id", { configurable: true, enumerable: true, get() {
    Object.defineProperty(body, "message_id", { configurable: true, enumerable: true, value: 11 }); return 99;
  } });
  try { release.resolve(); await first; await assert.rejects(second, /publication locator/u); assert.equal(issued, 1); }
  finally { release.resolve(); await Promise.allSettled([first, second]); store.clear!(); await store.waitForPublicationIdle!(); }
});

for (const direct of [true, false])
test(`Publication locator is checked after the actual body spread and stays sealed in the native adapter (direct=${direct})`, async () => {
  const store = createTelegramButtonActionStore(), key = store.register({ text: "A", prompt: "A" });
  const markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] }; let edits = 0;
  const sink = (body: Record<string, unknown>) => { edits++; assert.equal(Reflect.set(body, "message_id", 99), false);
    assert.equal(Reflect.set(body, "inline_message_id", "other"), false);
    assert.equal(Reflect.set(body, "toJSON", () => ({ chat_id: 99, message_id: 99 })), false); assert.equal(body.message_id, 11); return "edited"; };
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }), editMessageText: async (body: Record<string, unknown>) => sink(body) } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => direct, callFollowerApi: async (_method, args) => args[0] === "sendMessage" ? { message_id: 11 } : sink(args[1] as Record<string, unknown>), beginButtonPublication: store.beginPublication });
  try { await api.sendMessage({ chat_id: 7, message_thread_id: 9, text: "Old", reply_markup: markup });
    await assert.doesNotReject(() => api.editMessageText({ chat_id: 7, message_id: 11, text: "New", reply_markup: markup })); assert.equal(edits, 1);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); }
});

test("Publication locator validates the actual safe carrier even when a rendering getter mutates only caller state", async () => {
  const store = createTelegramButtonActionStore(), key = store.register({ text: "A", prompt: "A" });
  const markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] }; let editedId: unknown;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    async editMessageText(body: Record<string, unknown>) { editedId = body.message_id; return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  try { await api.sendMessage({ chat_id: 7, text: "Old", reply_markup: markup });
    const body = { chat_id: 7, message_id: 11, get text() { body.message_id = 99; return "New"; }, reply_markup: markup };
    await api.editMessageText(body); assert.equal(editedId, 11); assert.equal(body.message_id, 99);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); }
});

test("Publication locator stays original through the real native API recovery hook and HTTP encoding", async () => {
  const previous = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY; process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  const wire: Record<string, unknown>[] = [], store = createTelegramButtonActionStore(); let hooks = 0;
  globalThis.fetch = async (_url, options) => { wire.push(JSON.parse(options!.body as string)); return new Response(JSON.stringify({ ok: true, result: { message_id: 11, chat: { id: 7 }, message_thread_id: 9 } })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:locator-fixture"), tempDir: "/home/llb/pttmp",
    maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {}, captureRequestErrorHandler(body) {
      if (body.message_id !== undefined) { hooks++; assert.equal(Reflect.set(body, "message_id", 99), false); assert.equal(Reflect.set(body, "inline_message_id", "different"), false); }
      return undefined;
    } });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  try { const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] };
    await api.sendMessage({ chat_id: 7, message_thread_id: 9, text: "Old", reply_markup: markup });
    await api.editMessageText({ chat_id: 7, message_id: 11, text: "New", reply_markup: markup });
    assert.equal(hooks, 1); assert.equal(wire.length, 2); assert.equal(wire[1]!.message_id, 11); assert.equal(wire[1]!.chat_id, 7);
    assert.equal(Object.hasOwn(wire[1]!, "inline_message_id"), false);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); restore(); globalThis.fetch = previous;
    if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family; }
});

test("Publication locator refuses a custom whole-body serializer before real native HTTP encoding", async () => {
  const previous = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY; process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  let issued = 0; const store = createTelegramButtonActionStore();
  globalThis.fetch = async () => { issued++; return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:locator-fixture"), tempDir: "/home/llb/pttmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  try { const key = store.register({ text: "A", prompt: "A" });
    await assert.rejects(() => api.sendMessage({ chat_id: 7, text: "A", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: key }]] },
      toJSON() { return { chat_id: 99, text: "Other destination" }; } }), /publication locator/u);
    assert.equal(issued, 0);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); restore(); globalThis.fetch = previous;
    if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family; }
});

test("Publication locator fence leaves unrelated callback-free traffic outside its ownership", async () => {
  const store = createTelegramButtonActionStore(); let calls = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { async editMessageText(body: Record<string, unknown>) {
    calls++; assert.equal(Reflect.set(body, "message_id", 12), true); return "edited";
  } } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  await api.editMessageText({ chat_id: 7, message_id: 11, text: "Plain" }); assert.equal(calls, 1); store.clear!();
});

test("Publication locator rejects accessor identity without issuing native controls", async () => {
  const store = createTelegramButtonActionStore(), key = store.register({ text: "A", prompt: "A" }); let issued = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => { issued++; return { message_id: 11 }; } } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  try { await assert.rejects(() => api.sendMessage({ get chat_id() { return 7; }, text: "A", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: key }]] } }), /publication locator/u);
    assert.equal(issued, 0);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); }
});

test("A queued Rich edit projects expiry at actual issuance and a late edit cannot restore its spent IDs", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const bodyKey = store.register({ text: "A", prompt: "A", expiresAt: 1100 }), footerKey = store.register({ text: "Footer", prompt: "Footer" });
  const markdown = '<tg-button-row><tg-button type="callback_data" data="' + bodyKey + '">A</tg-button></tg-button-row>';
  const markup = { inline_keyboard: [[{ text: "Footer", callback_data: footerKey }]] };
  const edits: string[] = [];
  const api = createTelegramBusAwareApiRuntime({ directRuntime: {
    sendRichMessage: async () => ({ message_id: 11 }),
    async editMessageReplyMarkup() { entered.resolve(); await release.promise; },
    async editMessageText(body: { rich_message: { markdown: string } }) { edits.push(body.rich_message.markdown); return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  await api.sendRichMessage({ chat_id: 7, rich_message: { markdown }, reply_markup: markup });
  store.resolve(footerKey); await entered.promise;
  const update = api.editMessageText({ chat_id: 7, message_id: 11, rich_message: { markdown: "New heading\n" + markdown } });
  t.mock.timers.tick(100); await waitForTurn(); assert.equal(edits.length, 0);
  release.resolve(); await update; await store.waitForPublicationIdle!();
  const disabled = markdown.replace('type="callback_data" data="' + bodyKey + '"', 'type="disabled"');
  assert.deepEqual(edits, ["New heading\n" + markdown.replace('type="callback_data" data="' + bodyKey + '">', 'type="callback_data" data="tgbtn:expired">Expired: ')]);
  await api.editMessageText({ chat_id: 7, message_id: 11, rich_message: { markdown: "Later\n" + markdown } });
  await store.waitForPublicationIdle!();
  assert.equal(edits.at(-1), "Later\n" + disabled); assert.equal(store.resolve(bodyKey), undefined);
});

for (const outcome of ["ack", "unknown"] as const)
test(`Rich expiry waits for actual body edits and uses only the latest acknowledged body (${outcome})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const key = store.register({ text: "A", prompt: "A", expiresAt: 1100 });
  const row = '<tg-button-row><tg-button type="callback_data" data="' + key + '">A</tg-button></tg-button-row>';
  const edits: string[] = [];
  const api = createTelegramBusAwareApiRuntime({ directRuntime: {
    sendRichMessage: async () => ({ message_id: 11 }),
    async editMessageText(body: { rich_message: { markdown: string } }) {
      edits.push(body.rich_message.markdown);
      if (edits.length === 1) { entered.resolve(); await release.promise; if (outcome === "unknown") throw new Error("Unknown body edit"); }
      return "edited";
    },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  await api.sendRichMessage({ chat_id: 7, rich_message: { markdown: "Original\n" + row } });
  const pending = api.editMessageText({ chat_id: 7, message_id: 11, rich_message: { markdown: "Newer\n" + row } }).catch(error => error);
  await entered.promise; t.mock.timers.tick(100);
  let idle = false; const drain = store.waitForPublicationIdle!().then(() => { idle = true; });
  await waitForTurn(); assert.equal(edits.length, 1); assert.equal(idle, false);
  release.resolve(); await pending; await drain;
  assert.deepEqual(edits, outcome === "ack" ? ["Newer\n" + row, "Newer\n" + row.replace('type="callback_data" data="' + key + '">', 'type="callback_data" data="tgbtn:expired">Expired: ')] : ["Newer\n" + row]);
  assert.equal(store.resolve(key), undefined);
});

test("A fresh Rich view waits for cleanup and supersedes it without losing its new callbacks", async () => {
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const row = (key: string) => '<tg-button-row><tg-button type="callback_data" data="' + key + '">A</tg-button></tg-button-row>';
  const edits: string[] = [];
  const api = createTelegramBusAwareApiRuntime({ directRuntime: {
    sendRichMessage: async () => ({ message_id: 11 }),
    async editMessageText(body: { rich_message: { markdown: string } }) { edits.push(body.rich_message.markdown); if (edits.length === 1) { entered.resolve(); await release.promise; } return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const old = store.register({ text: "Old", prompt: "Old" });
  await api.sendRichMessage({ chat_id: 7, rich_message: { markdown: "Old\n" + row(old) } });
  store.resolve(old); await entered.promise;
  const key = store.register({ text: "New", prompt: "New" }), next = "Fresh\n" + row(key);
  const pending = api.editMessageText({ chat_id: 7, message_id: 11, rich_message: { markdown: next } });
  await waitForTurn(); assert.equal(edits.length, 1);
  release.resolve(); await pending; await store.waitForPublicationIdle!(); assert.equal(edits.at(-1), next);
  assert.equal(store.resolve(key, { id: "q", message: { chat: { id: 7 }, message_id: 11 } })!.prompt, "New");
  await store.waitForPublicationIdle!();
});

test("Acknowledged HTML replacement forgets old Rich content and closes absent controls", async () => {
  const store = createTelegramButtonActionStore();
  let bodyEdits = 0, footerEdits = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: {
    sendRichMessage: async () => ({ message_id: 11 }),
    editMessageText: async () => { bodyEdits++; return "edited"; },
    editMessageReplyMarkup: async () => { footerEdits++; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const old = store.register({ text: "Old", prompt: "Old" });
  await api.sendRichMessage({ chat_id: 7, rich_message: { markdown: '<tg-button-row><tg-button type="callback_data" data="' + old + '">Old</tg-button></tg-button-row>' } });
  const key = store.register({ text: "Footer", prompt: "Footer" });
  await api.editMessageText({ chat_id: 7, message_id: 11, text: "<b>New HTML</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Footer", callback_data: key }]] } });
  await store.waitForPublicationIdle!(); assert.equal(store.resolve(old), undefined);
  store.resolve(key); await store.waitForPublicationIdle!();
  assert.equal(bodyEdits, 1, "Cleanup cannot restore an obsolete Rich body after an HTML ACK");
  assert.equal(footerEdits, 1);
});

test("Rich in-body callbacks bind to the acknowledged message and retire its original body", async () => {
  const store = createTelegramButtonActionStore();
  let edits = 0, updated = "";
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendRichMessage: async () => ({ message_id: 11 }),
    editMessageText: async (body: { rich_message: { markdown: string } }) => { edits++; updated = body.rich_message.markdown; return "edited"; },
    editMessageReplyMarkup: async () => assert.fail("Body closure must not use a footer-only mutation") } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const plan = planTelegramButtonReply('\`\`\`telegram_button\n{"text":"A","prompt":"A"}\n\`\`\`',
    { registerAction: store.register, rendering: "rich" });
  assert.equal(plan.replyMarkup, undefined);
  const key = plan.markdown.match(/data="(tgbtn:[a-f0-9]{8})"/u)![1]!;
  await api.sendRichMessage({ chat_id: 7, message_thread_id: 9, rich_message: { markdown: plan.markdown } });
  assert.equal(store.resolve(key, { id: "wrong", message: { chat: { id: 7 }, message_id: 12, message_thread_id: 9 } }), undefined);
  assert.equal(store.resolve(key, { id: "right", message: { chat: { id: 7 }, message_id: 11, message_thread_id: 9 } })!.prompt, "A");
  await store.waitForPublicationIdle!(); assert.equal(edits, 1);
  assert.equal(updated, plan.markdown.replace(/<tg-button type="callback_data" data="tgbtn:[a-f0-9]{8}">/g, '<tg-button type="disabled">'));
});

test("Raw UI calls also publish callback facts without exposing or serializing cleanup authority", async () => {
  const store = createTelegramButtonActionStore();
  let edits = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { call: async () => ({ message_id: 11 }),
    editMessageReplyMarkup: async () => { edits++; } } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const key = store.register({ text: "A", prompt: "A" });
  await api.call("sendMessage", { chat_id: 7, text: "A", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: key }]] } });
  assert.equal(store.resolve(key, { id: "q", message: { chat: { id: 7 }, message_id: 11 } })!.prompt, "A");
  await store.waitForPublicationIdle!(); assert.equal(edits, 1);
});

test("A new app view can bind an acknowledged edit after the spent footer has drained", async () => {
  const store = createTelegramButtonActionStore();
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    editMessageText: async () => "edited", editMessageReplyMarkup: async () => {} } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const old = store.register({ text: "Old", prompt: "Old" });
  await api.sendMessage({ chat_id: 7, message_thread_id: 9, text: "Old", reply_markup: { inline_keyboard: [[{ text: "Old", callback_data: old }]] } });
  assert.ok(store.resolve(old)); await store.waitForPublicationIdle!();
  const key = store.register({ text: "Next", prompt: "Next" });
  await api.editMessageText({ chat_id: 7, message_id: 11, text: "Next", reply_markup: { inline_keyboard: [[{ text: "Next", callback_data: key }]] } });
  assert.equal(store.resolve(key, { id: "q", data: key, message: { chat: { id: 7 }, message_id: 11, message_thread_id: 9 } })!.prompt, "Next");
  await store.waitForPublicationIdle!();
});

for (const outcome of ["ack", "unknown"] as const)
test(`Callback cleanup waits for actual concurrent edit settlement (${outcome})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore({ ttlMs: 100 }), release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let cleanups = 0;
  const native = {
    sendMessage: async () => ({ message_id: 11 }),
    async editMessageText() { entered.resolve(); await release.promise; if (outcome === "unknown") throw new Error("Unknown edit"); return "edited"; },
    async editMessageReplyMarkup() { cleanups++; },
  } as unknown as TelegramBridgeApiRuntime;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, callFollowerApi: async () => undefined,
    beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] };
  await api.sendMessage({ chat_id: 7, text: "Original", reply_markup: markup });
  await store.waitForPublicationIdle!();
  const pending = api.editMessageText({ chat_id: 7, message_id: 11, text: "Updated", reply_markup: markup });
  const observed = pending.catch(error => error);
  await entered.promise; t.mock.timers.tick(100);
  let idle = false; const drain = store.waitForPublicationIdle!().then(() => { idle = true; });
  await waitForTurn(); assert.equal(cleanups, 0); assert.equal(idle, false);
  release.resolve(); await observed; await drain;
  assert.equal(cleanups, outcome === "ack" ? 1 : 0, "Unknown edits fence the snapshot instead of overwriting a possibly newer view");
  assert.equal(store.resolve(key), undefined);
});

test("A delayed app acknowledgement cannot overwrite a newer independent collector footer", async () => {
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let visible: TelegramInlineKeyboardMarkup | undefined;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    editMessageReplyMarkup: async (_chat: number, _id: number, markup: TelegramInlineKeyboardMarkup) => { visible = markup; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const plan = planTelegramButtonReply('<!-- telegram_button {"label":"App","prompt":"counter::next"} --><!-- telegram_choice {"question":"Two","choices":["A","B"],"select":2} -->',
    { registerAction: store.register });
  const query = (data: string, markup: TelegramInlineKeyboardMarkup) => ({ id: data, data, message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } });
  await api.sendMessage({ chat_id: 7, text: plan.markdown, reply_markup: plan.replyMarkup });
  const app = plan.replyMarkup!.inline_keyboard.flat().find(button => button.text === "App")!;
  const pending = handleTelegramButtonCallbackQuery(query(app.callback_data!, plan.replyMarkup!), undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => assert.fail("No model prompt"),
    invokeBoundAction: async () => { entered.resolve(); await release.promise; return "new"; }, editMessageReplyMarkup: api.editMessageReplyMarkup,
  });
  try {
    await entered.promise; await store.waitForPublicationIdle!();
    const choice = visible!.inline_keyboard.flat().find(button => button.text === "A")!;
    await handleTelegramButtonCallbackQuery(query(choice.callback_data!, visible!), undefined, {
      resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => assert.fail("No intermediate model prompt"),
      updateSelectionKeyboard: async (_query, markup, guard) => { await api.editMessageReplyMarkup(7, 11, markup, { assertLocalAuthority: guard }); },
    });
    await store.waitForPublicationIdle!();
    const current = structuredClone(visible!);
    release.resolve(); await pending; await store.waitForPublicationIdle!();
    assert.deepEqual(visible, current, "Finishing the app may not replace the new collector revision with its old callback query");
    const key = current.inline_keyboard.flat().find(button => button.callback_data)!.callback_data!;
    assert.ok(store.resolve(key), "The independent collector must remain usable");
  } finally { release.resolve(); await pending; store.clear!(); await store.waitForPublicationIdle!(); }
});

test("Managed callback cleanup uncertainty cannot authorize a second legacy retirement", async () => {
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let edits = 0;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    editMessageReplyMarkup: async () => { edits++; throw new Error("Unknown cleanup"); },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const key = store.register({ text: "App", prompt: "counter::next" }), markup = { inline_keyboard: [[{ text: "App", callback_data: key }]] };
  await api.sendMessage({ chat_id: 7, text: "App", reply_markup: markup });
  const pending = handleTelegramButtonCallbackQuery({ id: "q", data: key, message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => assert.fail("No model prompt"),
    invokeBoundAction: async () => { entered.resolve(); await release.promise; return "new"; }, editMessageReplyMarkup: api.editMessageReplyMarkup,
  });
  await entered.promise; await store.waitForPublicationIdle!();
  assert.equal(edits, 1);
  release.resolve(); await pending; await store.waitForPublicationIdle!();
  assert.equal(edits, 1, "Unknown native cleanup cannot be retried through the old query styling path");
  assert.equal(store.resolve(key), undefined);
});

test("A later view update waits for actual footer cleanup and cannot be overwritten by it", async () => {
  const store = createTelegramButtonActionStore(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let updates = 0, visible: unknown;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: { sendMessage: async () => ({ message_id: 11 }),
    async editMessageReplyMarkup(_chat: number, _id: number, markup: unknown) { entered.resolve(); await release.promise; visible = markup; },
    async editMessageText(body: { reply_markup?: unknown }) { updates++; visible = body.reply_markup; return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined,
    beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const old = store.register({ text: "Old", prompt: "Old" });
  await api.sendMessage({ chat_id: 7, text: "Old", reply_markup: { inline_keyboard: [[{ text: "Old", callback_data: old }]] } });
  store.resolve(old); await entered.promise;
  const key = store.register({ text: "New", prompt: "New" }), next = { inline_keyboard: [[{ text: "New", callback_data: key }]] };
  const pending = api.editMessageText({ chat_id: 7, message_id: 11, text: "New", reply_markup: next });
  await waitForTurn(); assert.equal(updates, 0);
  release.resolve(); await pending; await store.waitForPublicationIdle!();
  assert.equal(updates, 1); assert.deepEqual(visible, next);
  assert.equal(store.resolve(key, { id: "q", message: { chat: { id: 7 }, message_id: 11 } })!.prompt, "New");
  await store.waitForPublicationIdle!();
});

test("A late footer publication cannot restore spent callback IDs after cleanup has drained", async () => {
  const store = createTelegramButtonActionStore();
  let visible: TelegramInlineKeyboardMarkup | undefined;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: {
    sendMessage: async () => ({ message_id: 11 }), editMessageReplyMarkup: async (_chat: number, _id: number, markup: TelegramInlineKeyboardMarkup) => { visible = markup; },
    editMessageText: async (body: { reply_markup?: TelegramInlineKeyboardMarkup }) => { visible = body.reply_markup; return "edited"; },
  } as unknown as TelegramBridgeApiRuntime, ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }, { text: "Menu", callback_data: "menu:current" }]] };
  await api.sendMessage({ chat_id: 7, text: "A", reply_markup: markup });
  store.resolve(key); await store.waitForPublicationIdle!();
  await api.editMessageText({ chat_id: 7, message_id: 11, text: "Preserve caller text", reply_markup: markup });
  assert.deepEqual(visible!.inline_keyboard[0]![0]!.disabled, {});
  assert.equal(visible!.inline_keyboard[0]![1]!.callback_data, "menu:current");
  assert.equal(markup.inline_keyboard[0]![0]!.callback_data, key, "Projection cannot mutate the caller's snapshot");
  assert.equal(store.resolve(key), undefined); await store.waitForPublicationIdle!();
});

test("Native rejection preserves callbacks for a later acknowledged publication, unlike an unknown edit", async () => {
  const originalFetch = globalThis.fetch, calls: string[] = [];
  let sends = 0;
  globalThis.fetch = async input => {
    const method = String(input).split("/").at(-1)!; calls.push(method);
    const rejected = method === "sendMessage" && sends++ === 0 || method === "editMessageText";
    return new Response(JSON.stringify(rejected ? { ok: false, error_code: 400, description: "Bad Request: fixture rejected" } :
      { ok: true, result: method === "sendMessage" ? { message_id: 11 } : true }), { status: rejected ? 400 : 200 });
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  try {
    const store = createTelegramButtonActionStore(), api = createTelegramBusAwareApiRuntime({
      directRuntime: createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:publication-fixture"),
        tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} }),
      ownsDirect: () => true, callFollowerApi: async () => assert.fail("No route fallback"), beginButtonPublication: store.beginPublication,
    });
    store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
    const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] };
    await assert.rejects(api.sendMessage({ chat_id: 7, text: "Original", reply_markup: markup }));
    await api.sendMessage({ chat_id: 7, text: "Original", reply_markup: markup });
    await assert.rejects(api.editMessageText({ chat_id: 7, message_id: 11, text: "Rejected", reply_markup: markup }));
    assert.equal(store.resolve(key, { id: "q", message: { chat: { id: 7 }, message_id: 11 } })!.prompt, "A");
    await store.waitForPublicationIdle!();
    assert.deepEqual(calls, ["sendMessage", "sendMessage", "editMessageText", "editMessageReplyMarkup"]);
  } finally { restore(); globalThis.fetch = originalFetch; }
});

test("A publication ACK after timeout closes controls but cannot renew expired callbacks", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const release = Promise.withResolvers<{ message_id: number }>();
  const store = createTelegramButtonActionStore({ ttlMs: 100 });
  let cleanups = 0;
  const api = createTelegramBusAwareApiRuntime({
    directRuntime: { sendMessage: () => release.promise, editMessageReplyMarkup: async () => { cleanups++; } } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication,
  });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const key = store.register({ text: "A", prompt: "A" }), markup = { inline_keyboard: [[{ text: "A", callback_data: key }]] };
  const pending = api.sendMessage({ chat_id: 7, text: "Original", reply_markup: markup });
  t.mock.timers.tick(100); assert.equal(store.resolve(key), undefined);
  release.resolve({ message_id: 11 }); await pending; await store.waitForPublicationIdle!();
  assert.equal(cleanups, 1); assert.equal(store.resolve(key), undefined);
});

test("Identical message coordinates in a replacement profile cannot borrow the old publication lifetime", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  let generation = 1, cleanups = 0;
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const store = createTelegramButtonActionStore({ ttlMs: 100, captureSelectionAuthority() {
    const original = generation; return () => { if (generation !== original) throw new Error("Profile replaced"); };
  } });
  const api = createTelegramBusAwareApiRuntime({
    directRuntime: { sendMessage: async () => ({ message_id: 11 }), editMessageText: async () => { entered.resolve(); await release.promise; return "edited"; },
      editMessageReplyMarkup: async () => { cleanups++; } } as unknown as TelegramBridgeApiRuntime,
    ownsDirect: () => true, callFollowerApi: async () => undefined, beginButtonPublication: store.beginPublication,
  });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  const old = store.register({ text: "Old", prompt: "Old" });
  await api.sendMessage({ chat_id: 7, text: "Old", reply_markup: { inline_keyboard: [[{ text: "Old", callback_data: old }]] } });
  generation++;
  const key = store.register({ text: "New", prompt: "New" }), markup = { inline_keyboard: [[{ text: "New", callback_data: key }]] };
  await api.sendMessage({ chat_id: 7, text: "New", reply_markup: markup });
  const editing = api.editMessageText({ chat_id: 7, message_id: 11, text: "Newer", reply_markup: markup });
  await entered.promise;
  assert.equal(store.resolve(old), undefined);
  t.mock.timers.tick(100); await waitForTurn(); assert.equal(cleanups, 0);
  release.resolve(); await editing; await store.waitForPublicationIdle!();
  assert.equal(cleanups, 1); assert.equal(store.resolve(key), undefined);
});

for (const reason of ["capacity", "completion", "scope-loss", "cleanup-failure"] as const)
test(`Callback publication closure is one-shot and original-owner fenced (${reason})`, async () => {
  let owned = true, edits = 0;
  const failures: unknown[] = [];
  const store = createTelegramButtonActionStore({ captureSelectionAuthority: () => () => { if (!owned) throw new Error("Lost owner"); },
    recordFailure: error => { failures.push(error); } });
  const native = { sendMessage: async () => ({ message_id: 11 }),
    async editMessageReplyMarkup() { edits++; if (reason === "cleanup-failure") throw new Error("Unknown cleanup"); },
  } as unknown as TelegramBridgeApiRuntime;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, callFollowerApi: async () => undefined,
    beginButtonPublication: store.beginPublication });
  store.bindPublicationEditor!(createTelegramButtonPublicationEditor(api));
  assert.throws(() => store.bindPublicationEditor!(async () => {}), /already bound/u);
  const key = store.register({ text: "A", prompt: "A" }), peer = store.register({ text: "Peer", prompt: "Peer" });
  await api.sendMessage({ chat_id: 7, text: "Original", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: key }, { text: "Peer", callback_data: peer }]] } });
  if (reason === "capacity") for (let i = 0; i < 60; i++) store.register({ text: String(i), prompt: String(i) });
  else {
    if (reason === "scope-loss") owned = false;
    assert.equal(store.resolve(key)?.prompt, reason === "scope-loss" ? undefined : "A");
    owned = true;
  }
  await store.waitForPublicationIdle!();
  assert.equal(store.resolve(key), undefined);
  assert.equal(edits, reason === "scope-loss" ? 0 : 1);
  if (reason === "cleanup-failure") {
    assert.equal(store.resolve(peer), undefined, "An uncertain footer cannot retain a sibling action");
    assert.equal(failures.length, 1);
    store.clear!(); await store.waitForPublicationIdle!(); assert.equal(edits, 1, "Cleanup uncertainty cannot authorize replay");
  } else store.clear!();
  await store.waitForPublicationIdle!();
});

for (const missing of ["session", "operator", "epoch", "generation", "registration"] as const)
test(`Selection authority cannot initialize without native owner facts (${missing})`, () => {
  const capture = createTelegramButtonSelectionAuthorityCapture({
    captureSession: () => missing === "session" ? undefined : () => true,
    getTransportStamp: () => 1, isTransportStampActive: () => true,
    getAllowedUserId: () => missing === "operator" ? undefined : 7,
    ownsDirect: () => missing !== "generation" && missing !== "registration",
    getLeaderEpoch: () => missing === "epoch" ? undefined : 1,
    getFollowerGeneration: () => missing === "generation" ? undefined : "acknowledged-generation",
    isFollowerRegistered: () => missing !== "registration",
    getLeaderTarget: () => undefined, getFollowerTarget: () => ({ chatId: 7, threadId: 9 }),
  });
  assert.equal(capture(), undefined);
});

for (const direct of [true, false])
for (const change of ["none", "session", "stamp", "operator", "role", "epoch", "generation", "registration", "target", "exception"] as const) {
  if (direct && (change === "generation" || change === "registration") || !direct && change === "epoch") continue;
  test(`Selection authority capture is lazy and sticky across native owner replacement (direct=${direct}, ${change})`, () => {
    let session = true, stamp = 1, operator = 7, role = direct, epoch = 1, generation = 1, registered = !direct, fail = false, captures = 0;
    let target = { chatId: 7, threadId: 9 };
    const capture = createTelegramButtonSelectionAuthorityCapture({
      captureSession() { captures++; return () => session; }, getTransportStamp: () => stamp,
      isTransportStampActive: value => value === stamp, getAllowedUserId: () => operator,
      ownsDirect() { if (fail) throw new Error("Observation failed"); return role; }, getLeaderEpoch: () => epoch,
      getFollowerGeneration: () => generation, isFollowerRegistered: () => registered,
      getLeaderTarget: () => target, getFollowerTarget: () => target,
    });
    assert.equal(captures, 0);
    const guard = capture()!; guard();
    assert.equal(captures, 1);
    if (change === "session") session = false;
    if (change === "stamp") stamp++;
    if (change === "operator") operator++;
    if (change === "role") role = !direct;
    if (change === "epoch") epoch++;
    if (change === "generation") generation++;
    if (change === "registration") registered = false;
    if (change === "target") target = { chatId: 7, threadId: 10 };
    if (change === "exception") fail = true;
    if (change === "none") guard(); else assert.throws(guard);
    session = true; stamp = 1; operator = 7; role = direct; epoch = 1; generation = 1; registered = !direct; fail = false; target = { chatId: 7, threadId: 9 };
    if (change === "none") guard(); else assert.throws(guard, "Restoration cannot renew observed owner loss");
    assert.equal(captures, 1);
  });
}

for (const direct of [true, false]) for (const loss of ["none", "bot", "same-registration", "stopped-registration", "missing-bot", "missing-registration", "provider-replaced", "caught-reentry"] as const) {
  if (direct && ["same-registration", "stopped-registration", "missing-registration"].includes(loss)) continue;
  test(`Question local authority retains original bot and native registration lifetime (direct=${direct}/${loss})`, () => {
    const registration = createTelegramBusFollowerRegistrationState();
    const target = { chatId: 7, threadId: 9 }, metadata = { generation: "same-generation", sessionId: "session", registrationIncarnation: "a".repeat(48) };
    registration.setRegistered(true, target, metadata);
    let botId: number | undefined = loss === "missing-bot" ? undefined : 123;
    let reenter = false, guard: (() => void) | undefined, captures = 0;
    const deps = {
      captureSession: () => () => true, getTransportStamp: () => 1, isTransportStampActive: () => true,
      getAllowedUserId: () => 7, ownsDirect: () => direct, getLeaderEpoch: () => 1,
      getFollowerGeneration: registration.getGeneration, isFollowerRegistered: registration.isRegistered,
      getLeaderTarget: () => target, getFollowerTarget: registration.getTarget,
      getBotId() { if (reenter) { reenter = false; assert.throws(() => guard!(), /unavailable/u); } return botId; },
      captureFollowerRegistration() { captures++; return loss === "missing-registration" ? undefined : registration.capturePublicationRegistration!(); },
    };
    guard = createTelegramQuestionAuthorityCapture(deps)();
    if (loss === "missing-bot" || loss === "missing-registration") { assert.equal(guard, undefined); return; }
    assert.ok(guard); guard();
    const originalBotReader = deps.getBotId;
    if (loss === "bot") botId = 456;
    if (loss === "same-registration") registration.setRegistered(true, target, metadata);
    if (loss === "stopped-registration") registration.setRegistered(false);
    if (loss === "provider-replaced") deps.getBotId = () => botId;
    if (loss === "caught-reentry") reenter = true;
    if (loss === "none") guard(); else assert.throws(guard, /unavailable/u);
    botId = 123; deps.getBotId = originalBotReader; registration.setRegistered(true, target, metadata);
    if (loss === "none" && direct) guard(); else assert.throws(guard, /unavailable/u, "Equal restoration cannot renew original native lifetime");
    assert.equal(captures, direct ? 0 : 1, "Guards never recapture a successor registration");
  });
}

for (const change of ["none", "transport", "profile", "token", "observed-restoration"] as const)
test(`Artifact transport authority capture is lazy and retains both owner lifetimes (${change})`, () => {
  let initialized = false, captures = 0, transport = true, profile = "default", token = "one";
  const stamp = createTelegramTransportStampRuntime({ getProfileName: () => profile, getBotToken: () => token });
  const capture = createTelegramArtifactTransportAuthorityCapture({
    captureCurrentTransportAuthority() {
      assert.equal(initialized, true, "Root construction must not read the later Locks runtime");
      captures++;
      return transport ? () => transport : undefined;
    },
  }, stamp);
  assert.equal(captures, 0);
  initialized = true;
  const current = capture()!;
  assert.equal(captures, 1);
  assert.equal(current(), true);
  if (change === "transport") transport = false;
  if (change === "profile") profile = "other";
  if (change === "token" || change === "observed-restoration") token = "two";
  if (change === "observed-restoration") { stamp.getStamp(); token = "one"; }
  assert.equal(current(), change === "none");
  transport = true; profile = "default"; token = "one";
  assert.equal(current(), change === "none", "Observed loss cannot renew authority");
  transport = false;
  assert.equal(capture(), undefined);
});

test("Artifact direct capture refuses a byte port without its owned reservation and fences replacement capability", () => {
  const client = createTelegramApiClient(() => "123:artifact"), native = createTelegramBridgeApiRuntime({ client, tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const reserve = native.reserveArtifact;
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, captureDirectArtifactAuthority: () => () => true, callFollowerApi: async () => assert.fail("No fallback") });
  native.reserveArtifact = undefined;
  assert.equal(api.captureArtifactTransport!({ chatId: 7 }), undefined);
  native.reserveArtifact = reserve;
  const captured = api.captureArtifactTransport!({ chatId: 7 })!; assert.ok(captured);
  native.reserveArtifact = () => undefined;
  assert.equal(captured.isCurrent(), false);
  native.reserveArtifact = reserve; assert.equal(captured.isCurrent(), false);
});

for (const absent of ["direct-byte-port", "registration", "local-capability", "peer-capability"] as const)
test(`Artifact optional capability absence refuses before any dispatch (${absent})`, () => {
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "artifact", capabilities: ["artifact-document-v1"] }), older = createTelegramBusProtocolIdentity({ runtimeBuild: "old", capabilities: [] });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: createDirectRuntime([]), ownsDirect: () => absent === "direct-byte-port",
    callFollowerApi: async () => assert.fail("No generic multipart fallback or IPC dispatch"), captureDirectArtifactAuthority: () => () => true,
    captureFollowerArtifactRegistration: () => absent === "registration" ? undefined : { incarnation: "a".repeat(48), isCurrent: () => true },
    artifactProtocol: absent === "local-capability" ? older : protocol, getFollowerProtocol: () => absent === "peer-capability" ? older : protocol });
  assert.equal(api.captureArtifactTransport!({ chatId: 7, threadId: 8 }), undefined);
});

for (const outcome of ["not-issued", "before-http", "400", "429", "500", "network", "malformed", "late-authority", "sent"] as const)
test(`Artifact direct origin distinguishes actual HTTP issuance and definitive rejection (${outcome})`, async () => {
  let current = outcome !== "not-issued", calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (outcome === "network") throw new TypeError("private filesystem/token error");
    if (outcome === "late-authority") current = false;
    if (outcome === "malformed") return new Response("malformed");
    const status = ["400", "429", "500"].includes(outcome) ? Number(outcome) : 200;
    return new Response(JSON.stringify(status === 200 ? { ok: true, result: { message_id: 44 } } : { ok: false, error_code: status, description: "private error", parameters: { retry_after: 0 } }), { status });
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => { if (outcome === "before-http") current = false; return "123:artifact"; }), tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => true, callFollowerApi: async () => assert.fail("No route switch"), captureDirectArtifactAuthority: () => () => current });
  try {
    const capture = api.captureArtifactTransport!({ chatId: 7, threadId: 9 });
    if (outcome === "not-issued") { assert.equal(capture, undefined); assert.equal(calls, 0); return; }
    assert.ok(capture);
    const result = await capture.send({ bytes: Buffer.from("bytes"), fileName: "named", expiresAt: Date.now() + 2000, signal: new AbortController().signal, assertAuthority() {} });
    assert.equal(calls, outcome === "before-http" ? 0 : 1);
    assert.equal(result.effect, outcome === "before-http" ? "not-issued" : outcome === "sent" ? "sent" : outcome === "400" || outcome === "429" ? "rejected" : "unknown");
    assert.equal(result.messageId, outcome === "sent" || outcome === "late-authority" ? 44 : undefined);
    assert.doesNotMatch(JSON.stringify(result), /private|token|filesystem/u);
    if (outcome === "late-authority") { current = true; assert.equal(capture.isCurrent(), false, "Observed loss cannot restore an operation"); }
  } finally { restore(); globalThis.fetch = previous; }
});

for (const direct of [true, false]) for (const method of ["send", "edit", "rich-edit", "markup", "answer"] as const) for (const boundary of ["before-issue", "late-ack"] as const) {
test(`Explicit local UI authority fences native issuance/ACK without serializing callbacks (${method}, direct=${direct}, ${boundary})`, async () => {
  let current = true, requests = 0;
  const previousFetch = globalThis.fetch, payloads: unknown[] = [];
  globalThis.fetch = async () => {
    requests++; if (boundary === "late-ack") current = false;
    return new Response(JSON.stringify({ ok: true, result: method === "send" ? { message_id: 501 } : true }));
  };
  const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({
    client: createTelegramApiClient(() => { if (direct && boundary === "before-issue") current = false; return "123:local-ui"; }),
    tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {},
  });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const api = createTelegramBusAwareApiRuntime({
    directRuntime: native, ownsDirect: () => direct,
    async callFollowerApi(name, args, localOptions) {
      if (boundary === "before-issue") current = false;
      assertTelegramApiCallAuthority(localOptions?.assertAuthority, false);
      const wire = structuredClone(args); payloads.push(wire);
      assert.deepEqual(wire[2], { maxAttempts: 1, retrySafety: "non-idempotent" });
      const result = await proxy(name, wire);
      assertTelegramApiCallAuthority(localOptions?.assertAuthority, true);
      return result;
    },
  });
  const options = { assertLocalAuthority() { if (!current) throw new Error("UI owner ended"); } };
  try {
    const request = method === "send" ? api.sendMessage({ chat_id: 7, text: "Question" }, options) :
      method === "edit" ? api.editMessageText({ chat_id: 7, message_id: 501, text: "Done" }, options) :
      method === "rich-edit" ? api.editMessageText({ chat_id: 7, message_id: 501, rich_message: { markdown: "**Next**" } }, options) :
      method === "markup" ? api.editMessageReplyMarkup(7, 501, { inline_keyboard: [] }, options) :
      api.answerCallbackQuery("query", "Selected", options);
    await assert.rejects(request, { name: "TelegramApiAuthorityError", requestIssued: boundary === "late-ack" });
    assert.equal(requests, boundary === "late-ack" ? 1 : 0);
    if (!direct && boundary === "late-ack") assert.equal(payloads.length, 1);
  } finally { restoreHttps(); globalThis.fetch = previousFetch; }
});
}

for (const method of ["send", "edit", "rich-edit", "markup", "answer"] as const) {
test(`UI local support does not downgrade a full authority guard during follower observation (${method})`, async () => {
  const options: Pick<TelegramApiCallOptions, "assertAuthority"> = { assertAuthority() {} };
  const runtime = createTelegramBusAwareApiRuntime({
    ownsDirect() { options.assertAuthority = undefined; return false; },
    directRuntime: createDirectRuntime([]), callFollowerApi: async () => assert.fail("Full authority cannot become local-only"),
  });
  const request = method === "send" ? runtime.sendMessage({ chat_id: 7, text: "Question" }, options) :
    method === "edit" ? runtime.editMessageText({ chat_id: 7, message_id: 501, text: "Done" }, options) :
    method === "rich-edit" ? runtime.editMessageText({ chat_id: 7, message_id: 501, rich_message: { markdown: "**Next**" } }, options) :
    method === "markup" ? runtime.editMessageReplyMarkup(7, 501, { inline_keyboard: [] }, options) :
    runtime.answerCallbackQuery("query", "Selected", options);
  await assert.rejects(request, { name: "TelegramApiAuthorityError", requestIssued: false });
});
}

for (const direct of [true, false]) for (const boundary of ["before-issue", "late-ack"] as const) {
test(`Confirmation deletion keeps local authority across native API/proxy ${boundary} (direct=${direct})`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let current = true, requests = 0;
  const payloads: unknown[] = [], previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requests++; entered.resolve(); await release.promise;
    return new Response(JSON.stringify({ ok: true, result: true }));
  };
  const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const native = createTelegramBridgeApiRuntime({
    client: createTelegramApiClient(() => {
      if (direct && boundary === "before-issue") current = false;
      return "123:fixture";
    }), tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {},
  });
  const proxy = createTelegramBusLeaderApiProxy({ call: native.call, callMultipart: native.callMultipart, downloadFile: native.downloadFile });
  const api = createTelegramBusAwareApiRuntime({ directRuntime: native, ownsDirect: () => direct,
    async callFollowerApi(method, args, localOptions) {
      if (boundary === "before-issue") { entered.resolve(); await release.promise; }
      assertTelegramApiCallAuthority(localOptions?.assertAuthority, false);
      const wire = structuredClone(args); payloads.push(wire);
      const result = await proxy(method, wire);
      assertTelegramApiCallAuthority(localOptions?.assertAuthority, true);
      return result;
    },
  });
  try {
    const result = api.deleteMessage(7, 77, { assertAuthority() { if (!current) throw new Error("Callback source ended"); } });
    const rejected = assert.rejects(result, (error: unknown) => error instanceof TelegramApiAuthorityError &&
      error.requestIssued === (boundary === "late-ack"));
    if (boundary === "late-ack" || !direct) await entered.promise;
    current = false; release.resolve(); await rejected;
    assert.equal(requests, boundary === "before-issue" ? 0 : 1);
    assert.deepEqual(payloads, direct || boundary === "before-issue" ? [] : [["deleteMessage", { chat_id: 7, message_id: 77 }]]);
  } finally { release.resolve(); restoreHttps(); globalThis.fetch = previousFetch; }
});
}

for (const direct of [true, false]) for (const threaded of [true, false]) for (const failure of ["http", "network"] as const) {
  test(`Typing cannot replay HTTP after its captured generation ends (direct=${direct}, threaded=${threaded}, failure=${failure})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const context = createTelegramSessionContextStore<object>(), ctx = {}, typing = createTelegramTypingLoop();
    context.set(ctx); const calls: unknown[] = [], payloads: unknown[] = [], errors: unknown[] = [];
    let finish!: () => void; const settled = new Promise<void>(resolve => { finish = resolve; });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) {
        context.set(ctx); typing.stop();
        if (failure === "network") throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ ok: false, error_code: 500, description: "fixture retry" }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
    const directRuntime = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:fixture", { isThreadedMode: () => threaded }),
      tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
    const proxy = createTelegramBusLeaderApiProxy({ call: directRuntime.call, callMultipart: directRuntime.callMultipart, downloadFile: directRuntime.downloadFile });
    const api = createTelegramBusAwareApiRuntime({ directRuntime, ownsDirect: () => direct,
      async callFollowerApi(method, args, localOptions) {
        localOptions?.assertAuthority?.();
        const wire = structuredClone(args); payloads.push(wire);
        return proxy(method, wire);
      } });
    const start = createTelegramTypingLoopStarter({
      failureLog: createPassthroughFailureLog(error => errors.push(error)),
      typing, getDefaultChatId: () => 7,
      isContextActive: context.isCurrent, getSessionGeneration: context.getGeneration, getTransportAuthority: () => "unchanged", isThreadedMode: () => threaded,
      async sendTypingAction(chatId, options) { try { return await api.sendTypingAction(chatId, options); } finally { finish(); } },
      updateStatus() {}, recordRuntimeEvent(_category, error) { errors.push(error); } });
    const target = { chatId: 7, ...(threaded ? { threadId: 42 } : {}) };
    try {
      start(ctx, 7, { target });
      // Drain the actual sender's outcome, not just the core's forgotten in-flight state after stop.
      await settled; await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls.length, 1); assert.equal(typing.stop(), false); assert.deepEqual(errors, []);
      assert.deepEqual(calls[0], { chat_id: 7, action: "typing", ...(threaded ? { message_thread_id: 42 } : {}) });
      assert.deepEqual(payloads, direct ? [] : [["sendChatAction", calls[0], { maxAttempts: 1, retrySafety: "non-idempotent" }]]);
      start(ctx, 7, { target }); for (let turn = 0; turn < 30; turn++) await new Promise<void>(resolve => setImmediate(resolve));
      t.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls.length, 2, "Fresh context owns its own attempt; old failure cannot stop the replacement");
      assert.equal(typing.stop(), true);
    } finally { typing.stop(); restoreHttps(); globalThis.fetch = previousFetch; }
  });
}

for (const direct of [true, false]) for (const threaded of [true, false]) for (const end of ["stop", "same-target-replacement"] as const) {
  test(`Expired typing loops keep late success fenced without API noise (direct=${direct}, threaded=${threaded}, end=${end})`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const issued = Promise.withResolvers<void>(), response = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>();
    const calls: unknown[] = [], payloads: unknown[] = [], apiErrors: unknown[] = [], typingErrors: unknown[] = [], outcomes: unknown[] = [];
    const typing = createTelegramTypingLoop(), ctx = {};
    let nowMs = 1000;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) { issued.resolve(); await response.promise; }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const restoreHttps = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
    const directRuntime = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:fixture", { isThreadedMode: () => threaded }),
      tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, now: () => nowMs, recordRuntimeEvent(_category, error) { apiErrors.push(error); } });
    const proxy = createTelegramBusLeaderApiProxy({ call: directRuntime.call, callMultipart: directRuntime.callMultipart, downloadFile: directRuntime.downloadFile });
    const api = createTelegramBusAwareApiRuntime({ directRuntime, ownsDirect: () => direct,
      async callFollowerApi(method, args, localOptions) {
        assert.deepEqual(Object.keys(localOptions ?? {}), ["assertAuthority"]);
        assertTelegramApiCallAuthority(localOptions?.assertAuthority, false);
        const wire = structuredClone(args); payloads.push(wire);
        const result = await proxy(method, wire);
        assertTelegramApiCallAuthority(localOptions?.assertAuthority, true);
        return result;
      } });
    const start = createTelegramTypingLoopStarter({
      typing, getDefaultChatId: () => 7, isContextActive: () => true, getSessionGeneration: () => 1,
      getTransportAuthority: () => "unchanged", isThreadedMode: () => threaded,
      failureLog: createPassthroughFailureLog(error => typingErrors.push(error)),
      async sendTypingAction(chatId, options) {
        try { const result = await api.sendTypingAction(chatId, options); outcomes.push(result); return result; }
        catch (error) { outcomes.push(error); throw error; }
        finally { settled.resolve(); }
      },
      updateStatus() { assert.fail("Typing cannot change connection status"); },
    });
    const target = { chatId: 7, ...(threaded ? { threadId: 42 } : {}) };
    try {
      start(ctx, 7, { target }); await issued.promise;
      if (end === "stop") typing.stop(); else start(ctx, 7, { target });
      response.resolve(); await settled.promise; await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls.length, 1);
      assert.ok(outcomes[0] instanceof TelegramApiAuthorityError, "A late HTTP success is not current-owner success");
      assert.equal(outcomes[0].requestIssued, true);
      assert.deepEqual(apiErrors, [], "Expired-loop authority refusal is expected cancellation, not an API failure");
      assert.deepEqual(typingErrors, []);
      nowMs += 3000;
      t.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls.length, end === "stop" ? 1 : 2, "Only a fresh loop can issue another request");
      if (end !== "stop") assert.equal(outcomes[1], true);
      assert.deepEqual(apiErrors, []);
      assert.deepEqual(typingErrors, []);
      assert.equal(typing.stop(), end !== "stop");
      assert.deepEqual(calls[0], { chat_id: 7, action: "typing", ...(threaded ? { message_thread_id: 42 } : {}) });
      assert.deepEqual(payloads, direct ? [] : calls.map(body => ["sendChatAction", body, { maxAttempts: 1, retrySafety: "non-idempotent" }]));
    } finally { response.resolve(); typing.stop(); restoreHttps(); globalThis.fetch = previousFetch; }
  });
}

for (const threaded of [true, false]) test(`Queued direct typing issuance rechecks its local context guard (threaded=${threaded})`, async () => {
  let current = true, fetches = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }); };
  const directRuntime = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:fixture", { isThreadedMode: () => threaded }),
    tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  const api = createTelegramBusAwareApiRuntime({ directRuntime, ownsDirect: () => true, callFollowerApi: async () => assert.fail("No follower") });
  try {
    const task = api.sendTypingAction(7, { ...(threaded ? { message_thread_id: 42 } : {}), assertAuthority() { if (!current) throw new Error("Context ended"); } });
    current = false; await assert.rejects(task); assert.equal(fetches, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("Selected text API preparation proves availability without activating the future recipient", async () => {
  let assertions = 0;
  const config = { operationId: "operation", registrationGeneration: "generation", target: { chatId: 7, threadId: 42 },
    assertAuthority() { assertions++; throw new Error("Future recipient is not released"); },
    deliver: async () => assert.fail("No issuance") };
  const api = createTelegramSelectedMenuTextApi(config);
  assert.equal(assertions, 0);
  for (const change of [{ deliver: undefined }, { assertAuthority: undefined }, { target: { chatId: 7, threadId: 0 } }, { operationId: "" }, { registrationGeneration: "" }]) {
    assert.throws(() => createTelegramSelectedMenuTextApi({ ...config, ...change } as unknown as Parameters<typeof createTelegramSelectedMenuTextApi>[0]));
  }
  assert.equal(assertions, 0);
  await assert.rejects(api.sendMessage({ chat_id: 7, message_thread_id: 42, text: "Status" }, { assertAuthority: config.assertAuthority }));
  assert.equal(assertions, 1);
});

for (const edit of [false, true]) for (const fault of ["current", "callback", "callback-missing", "target", "thread", "extra", "preview", "markup", "mode", "reply", "reply-missing", "lost", "late", "observation", "capture"] as const) {
  test(`Selected text API ${edit ? "edit" : "send"} preserves closed captured menu body (${fault})`, async () => {
    let current = true, calls = 0;
    const assertAuthority = () => { if (!current) throw new Error("Recipient changed"); };
    const gate = Promise.withResolvers<void>(), effects: unknown[] = [];
    const target = { chatId: 7, threadId: 42 }, options = { assertAuthority }, config = { operationId: "operation", registrationGeneration: "generation", target, assertAuthority,
      async deliver(effect: { kind: "send-text" | "edit-text"; text: string }, assertion: () => void) {
        assert.equal(assertion, assertAuthority); calls++; effects.push(structuredClone(effect)); await gate.promise;
        if (fault === "lost") throw new Error("Issued reply lost");
        return { operationId: fault === "observation" ? "other" : "operation", registrationGeneration: "generation", recipient: { target: { chatId: 7, threadId: 42 }, sessionId: "session", sessionGeneration: 1,
          processId: 1, processBirthId: "birth", profileKey: "profile", journalBindingKey: "journal" }, effect: effect.kind, messageId: 11 };
      } };
    const api = createTelegramSelectedMenuTextApi(config);
    const body: Record<string, unknown> = { chat_id: 7, message_thread_id: 42, text: "<b>Status</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Queue", callback_data: "queue" }]] },
      ...(edit ? { message_id: 11 } : { reply_parameters: { message_id: 11, allow_sending_without_reply: true } }) };
    if (fault === "callback") options.assertAuthority = () => {};
    if (fault === "callback-missing") Reflect.deleteProperty(options, "assertAuthority");
    if (fault === "target") body.chat_id = 8;
    if (fault === "thread") body.message_thread_id = 99;
    if (fault === "extra") body.foreign = true;
    if (fault === "preview") body.link_preview_options = { is_disabled: true };
    if (fault === "markup") body.reply_markup = { inline_keyboard: [[{ text: "Site", url: "https://example.com" }]] };
    if (fault === "mode") body.parse_mode = "Markdown";
    if (fault === "reply") body.reply_parameters = { message_id: 11, allow_sending_without_reply: false };
    if (fault === "reply-missing") body.reply_parameters = { allow_sending_without_reply: true };
    const task = edit ? api.editMessageText(body as Parameters<typeof api.editMessageText>[0], options) : api.sendMessage(body as Parameters<typeof api.sendMessage>[0], options);
    const early = ["callback", "callback-missing", "target", "thread", "extra", "preview", "markup", "mode", "reply", "reply-missing"].includes(fault);
    if (fault === "late") current = false;
    if (fault === "capture") { body.text = "changed"; target.threadId = 99; config.assertAuthority = () => {}; options.assertAuthority = () => {}; config.operationId = "changed"; }
    gate.resolve();
    if (early || ["lost", "late", "observation"].includes(fault)) await assert.rejects(task);
    else assert.deepEqual(await task, edit ? "edited" : { message_id: 11 });
    assert.equal(calls, early ? 0 : 1);
    if (calls) assert.deepEqual(effects[0], { kind: edit ? "edit-text" : "send-text", text: "<b>Status</b>", parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "Queue", callback_data: "queue" }]] }, ...(edit ? { messageId: 11 } : { replyToMessageId: 11 }) });
  });
}

test("Follower callback answers ignore only Telegram's expired-query rejection", async () => {
  const fail = (error: Error) => createTelegramBusAwareApiRuntime({ directRuntime: createDirectRuntime([]), ownsDirect: () => false,
    async callFollowerApi() { throw error; } });
  const late = new Error("Telegram API answerCallbackQuery failed: HTTP 400: Bad Request: query is too old and response timeout expired or query ID is invalid");
  await fail(late).answerCallbackQuery("old", "Toast");
  await fail(late).answerCallbackQuery("old");
  for (const error of [new TelegramApiAuthorityError(false), new Error("Telegram bus follower registration was refused"), new Error("Timed out waiting for Telegram bus response")])
    await assert.rejects(fail(error).answerCallbackQuery("old", "Toast"), error, "Refusals before delivery still reach the caller");
});

for (const direct of [true, false]) {
  test(`Typed callback answers send authored toast text verbatim (direct=${direct})`, async () => {
    const calls: unknown[] = [];
    const runtime = createTelegramBusAwareApiRuntime({ directRuntime: createDirectRuntime(calls), ownsDirect: () => direct,
      async callFollowerApi(method, args) { calls.push({ method, args }); return { message_id: 1 }; } });
    // Each toast is written in its final form at its call site; the boundary never rewrites punctuation.
    const cases: Array<string | undefined> = [undefined, "", "✅ Saved", "⚠️ Wrote a period.", "Continue?", "Working…", "v1.2.3"];
    for (const text of cases) {
      const expected = text;
      calls.length = 0;
      await runtime.answerCallbackQuery("callback", text);
      assert.deepEqual(calls, direct ? [{ kind: "answer-callback", callbackQueryId: "callback", text: expected }] :
        [{ method: "call", args: ["answerCallbackQuery", { callback_query_id: "callback", ...(expected !== undefined ? { text: expected } : {}) }] }]);
    }
    calls.length = 0;
    const body = { chat_id: 100, text: "An in-chat notice." };
    await runtime.sendMessage(body);
    assert.deepEqual(calls, direct ? [{ kind: "message", body }] : [{ method: "call", args: ["sendMessage", body] }]);
    calls.length = 0;
    const raw = { callback_query_id: "raw", text: "Explicit raw API payload." };
    await runtime.call("answerCallbackQuery", raw);
    assert.deepEqual(calls, direct ? [{ kind: "call", method: "answerCallbackQuery", body: raw }] :
      [{ method: "call", args: ["answerCallbackQuery", raw, undefined] }]);
  });
}

for (const direct of [true, false]) {
  test(`Companion section toasts reach the client exactly as the companion wrote them (direct=${direct})`, async () => {
    const calls: unknown[] = [], edited: string[] = [];
    const runtime = createTelegramBusAwareApiRuntime({ directRuntime: createDirectRuntime(calls), ownsDirect: () => direct,
      async callFollowerApi(method, args) { calls.push({ method, args }); return { message_id: 1 }; } });
    const registry = createTelegramExtensionSectionRegistry();
    registry.register({ id: "@fixture/companion", label: "Companion", render: () => ({ text: "Companion." }),
      async handleCallback(ctx) {
        await ctx.answerCallback(ctx.payload || undefined);
        await ctx.edit({ text: "An in-chat notice." });
        return "handled" as const;
      } });
    const deps: TelegramSectionRuntimeDeps = {
      answerCallbackQuery: runtime.answerCallbackQuery,
      editInteractiveMessage: async (_chat, _message, text) => { edited.push(text); },
      sendInteractiveMessage: async () => undefined, sendRichMessage: async () => undefined,
      enqueuePrompt: async () => {}, deleteMessage: async () => {},
    };
    for (const [text, expected] of [["✅ Saved", "✅ Saved"], ["⚠️ Operation failed.", "⚠️ Operation failed."],
      ["Continue?", "Continue?"], ["", undefined]] as const) {
      calls.length = 0;
      assert.equal(await handleTelegramSectionCallback(registry, "0", "control", text, 100, 1, "companion-callback", deps), true);
      assert.deepEqual(calls, direct ? [{ kind: "answer-callback", callbackQueryId: "companion-callback", text: expected }] :
        [{ method: "call", args: ["answerCallbackQuery", { callback_query_id: "companion-callback", ...(expected !== undefined ? { text: expected } : {}) }] }]);
      assert.equal(edited.at(-1), "An in-chat notice.");
    }
  });
}

for (const direct of [true, false]) {
  for (const multipart of [true, false]) {
    test(`Per-call API authority ${direct ? "stays local" : "cannot cross IPC"} for ${multipart ? "multipart" : "JSON"}`, async () => {
      const calls: unknown[] = [];
      let guardedDirectCalls = 0;
      const options: TelegramApiCallOptions = { assertAuthority() {} };
      const runtime = createTelegramBusAwareApiRuntime({ ownsDirect: () => direct,
        directRuntime: { ...createDirectRuntime(calls),
          async call<TResponse>(_method: string, _body: Record<string, unknown>, supplied?: TelegramApiCallOptions) {
            assert.equal(supplied?.assertAuthority, options.assertAuthority);
            guardedDirectCalls++;
            return true as TResponse;
          },
          async callMultipart<TResponse>(_method: string, _fields: Record<string, string>, _field: string, _path: string,
            _name: string, supplied?: TelegramApiCallOptions) {
            assert.equal(supplied?.assertAuthority, options.assertAuthority);
            guardedDirectCalls++;
            return true as TResponse;
          },
        },
        async callFollowerApi(method, args) { calls.push({ method, args }); return true; },
      });
      const request = multipart ? runtime.callMultipart("sendDocument", { chat_id: "7" }, "document", "/unused", "fixture.txt", options)
        : runtime.call("sendMessage", { chat_id: 7, text: "menu" }, options);
      if (direct) assert.equal(await request, true);
      else await assert.rejects(request, { name: "TelegramApiAuthorityError", requestIssued: false });
      assert.equal(guardedDirectCalls, direct ? 1 : 0);
      assert.deepEqual(calls, [], "A guarded effect is never serialized without its enforceable lifetime.");
    });
  }
}

for (const direct of [true, false]) {
  test(`Guarded BotFather typed API ${direct ? "preserves direct authority" : "refuses follower serialization"}`, async () => {
    const calls: unknown[] = [], options: Pick<TelegramApiCallOptions, "assertAuthority"> = { assertAuthority() {} };
    const commands = [{ command: "start", description: "Open menu" }];
    let guardedCalls = 0;
    const runtime = createTelegramBusAwareApiRuntime({ ownsDirect: () => direct,
      directRuntime: { ...createDirectRuntime(calls), async setMyCommands(value, supplied) {
        assert.equal(value, commands);
        assert.equal(supplied?.assertAuthority, options.assertAuthority);
        guardedCalls++;
        return true;
      } },
      callFollowerApi: async () => assert.fail("A process-local lifetime cannot become a wire grant"),
    });
    if (direct) assert.equal(await runtime.setMyCommands(commands, options), true);
    else await assert.rejects(runtime.setMyCommands(commands, options), { name: "TelegramApiAuthorityError", requestIssued: false });
    assert.equal(guardedCalls, direct ? 1 : 0);
    assert.deepEqual(calls, []);
  });
}

for (const direct of [true, false]) {
  test(`Typed callback authority ${direct ? "forwards the exact local guard" : "refuses before follower IPC"}`, async () => {
    const calls: unknown[] = [], options: Pick<TelegramApiCallOptions, "assertAuthority"> = { assertAuthority() {} };
    let guardedCalls = 0;
    const runtime = createTelegramBusAwareApiRuntime({ ownsDirect: () => direct,
      directRuntime: { ...createDirectRuntime(calls), async answerCallbackQuery(id, text, supplied) {
        assert.equal(id, "captured-query");
        assert.equal(text, "✅ Saved");
        assert.equal(supplied?.assertAuthority, options.assertAuthority);
        guardedCalls++;
      } },
      callFollowerApi: async () => assert.fail("A callback closure cannot become a wire grant"),
    });
    const request = runtime.answerCallbackQuery("captured-query", "✅ Saved", options);
    if (direct) await request;
    else await assert.rejects(request, { name: "TelegramApiAuthorityError", requestIssued: false });
    assert.equal(guardedCalls, direct ? 1 : 0);
    assert.deepEqual(calls, []);
  });
}

for (const direct of [true, false]) {
  test(`Typed callback authority captures its guard before direct-owner observation (direct=${direct})`, async () => {
    const guard = () => {};
    const options: Pick<TelegramApiCallOptions, "assertAuthority"> = { assertAuthority: guard };
    let guardedCalls = 0;
    const runtime = createTelegramBusAwareApiRuntime({
      ownsDirect() { options.assertAuthority = undefined; return direct; },
      directRuntime: { ...createDirectRuntime([]), async answerCallbackQuery(_id, _text, supplied) {
        assert.equal(supplied?.assertAuthority, guard);
        guardedCalls++;
      } },
      callFollowerApi: async () => assert.fail("Observation cannot drop the captured guard before IPC"),
    });
    const request = runtime.answerCallbackQuery("captured-query", "✅ Saved", options);
    if (direct) await request;
    else await assert.rejects(request, { name: "TelegramApiAuthorityError", requestIssued: false });
    assert.equal(guardedCalls, direct ? 1 : 0);
  });
}

test("Direct bus delivery invalidates only exact still-current stale request targets without replay", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const surface of ["reply", "menu", "activity", "multipart"] as const) {
      for (const race of ["none", "epoch", "generation", "profile", "binding", "load", "unconfirmed", "permission"] as const) {
        let epoch = 1;
        let generation = 1;
        let profile = "default";
        let requests = 0;
        let invalidations = 0;
        let recovered = 0;
        let state: TelegramSyncState = {};
        let record: TelegramTopicTargetRecord | undefined = { profileKey: "leader", instanceId: "leader", target: { chatId: 100, threadId: 42 }, status: "active", createdAtMs: 1, updatedAtMs: 1 };
        globalThis.fetch = async () => {
          requests++;
          if (race === "epoch") epoch++;
          if (race === "generation") generation++;
          if (race === "profile") profile = "other";
          if (race === "binding") record = { ...record!, instanceId: "replacement", updatedAtMs: 2 };
          return new Response(JSON.stringify({ ok: false, description: race === "unconfirmed" ? "Bad Request: possibly message thread not found later" : "Bad Request: message thread not found" }), { status: race === "permission" ? 403 : 400 });
        };
        const direct = createTelegramBridgeApiRuntime({
          client: {
            ...createTelegramApiClient(() => "test-token"),
            callMultipart: (method, fields) => callTelegram("test-token", method, fields),
          },
          tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
          recordRuntimeEvent: () => {},
          captureRequestErrorHandler: (body) => captureTelegramStaleTargetRequestRecovery(body, {
            topicTargetStore: {
              load: async () => { if (race === "load") generation++; },
              list: () => record ? [record] : [],
              markStaleByTarget: () => { record = undefined; invalidations++; return true; },
              persist: async () => {},
              invalidateTarget: async (_target, isCurrent) => {
                if (race === "load") generation++;
                if (!isCurrent()) return false;
                record = undefined;
                invalidations++;
                return true;
              },
            },
            getCurrentLeaderEpoch: () => epoch, getSessionGeneration: () => generation, getProfileName: () => profile,
            getSyncState: () => state, setSyncState: (next) => { state = next; }, recordEvent: () => {},
            onRecovered: () => { recovered++; },
          }),
        });
        const runtime = createTelegramBusAwareApiRuntime({ directRuntime: direct, ownsDirect: () => true, callFollowerApi: async () => assert.fail("unexpected follower call") });
        await assert.rejects(async () => {
          const body = { chat_id: 100, message_thread_id: 42 };
          if (surface === "reply") return runtime.sendRichMessage({ ...body, rich_message: { markdown: "answer" } });
          if (surface === "menu") return runtime.sendMessage({ ...body, text: "menu" });
          if (surface === "activity") return runtime.sendTypingAction(100, { message_thread_id: 42 });
          return runtime.callMultipart("sendDocument", { chat_id: "100", message_thread_id: "42" }, "document", "/unused", "unused");
        });
        assert.equal(requests, 1, `${surface}/${race}: replay`);
        assert.equal(invalidations, race === "none" ? 1 : 0, `${surface}/${race}: invalidation`);
        assert.equal(recovered, invalidations);
        if (race === "none") assert.equal(state["target-bindings"]?.status, "suspect");
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createDirectRuntime(calls: unknown[]): TelegramBridgeApiRuntime {
  return {
    call: async <TResponse>(method: string, body: Record<string, unknown>) => {
      calls.push({ kind: "call", method, body });
      return { ok: true } as TResponse;
    },
    callMultipart: async <TResponse>(
      method: string,
      fields: Record<string, string>,
      fileField: string,
      filePath: string,
      fileName: string,
    ) => {
      calls.push({
        kind: "multipart",
        method,
        fields,
        fileField,
        filePath,
        fileName,
      });
      return { ok: true } as TResponse;
    },
    downloadFile: async (fileId, suggestedName) => {
      calls.push({ kind: "download", fileId, suggestedName });
      return "/tmp/file";
    },
    deleteWebhook: async () => {
      calls.push({ kind: "delete-webhook" });
      return true;
    },
    getUpdates: async (body) => {
      calls.push({ kind: "get-updates", body });
      return [];
    },
    setMyCommands: async (commands) => {
      calls.push({ kind: "commands", commands });
      return true;
    },
    sendChatAction: async (chatId, action, options) => {
      calls.push({ kind: "chat-action", chatId, action, options });
      return true;
    },
    sendTypingAction: async (chatId, options) => {
      calls.push({ kind: "typing", chatId, options });
      return true;
    },
    sendRecordVoiceAction: async (chatId, options) => {
      calls.push({ kind: "record-voice", chatId, options });
      return true;
    },
    sendMessageDraft: async (chatId, draftId, text, options) => {
      calls.push({ kind: "draft", chatId, draftId, text, options });
      return true;
    },
    sendMessage: async (body) => {
      calls.push({ kind: "message", body });
      return { message_id: 1 };
    },
    sendRichMessage: async (body) => {
      calls.push({ kind: "rich", body });
      return { message_id: 2 };
    },
    sendRichMessageDraft: async (body) => {
      calls.push({ kind: "rich-draft", body });
      return true;
    },
    editMessageText: async (body) => {
      calls.push({ kind: "edit", body });
      return "edited";
    },
    editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
      calls.push({ kind: "edit-reply-markup", chatId, messageId, replyMarkup });
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      calls.push({ kind: "answer-callback", callbackQueryId, text });
    },
    answerGuestQuery: async (guestQueryId, text) => {
      calls.push({ kind: "answer-guest", guestQueryId, text });
    },
    answerGuestQueryForInlineMessage: async (guestQueryId, text, options) => {
      calls.push({ kind: "answer-guest-inline", guestQueryId, text, options });
      return "inline-1";
    },
    editGuestInlineMessage: async (inlineMessageId, content) => {
      calls.push({ kind: "edit-guest-inline", inlineMessageId, content });
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push({ kind: "delete", chatId, messageId });
    },
    prepareTempDir: async () => 0,
  };
}

test("Bus-aware API runtime uses direct transport while this instance owns Telegram", async () => {
  const directCalls: unknown[] = [];
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime(directCalls),
    ownsDirect: () => true,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return { message_id: 99 };
    },
  });

  assert.deepEqual(
    await runtime.sendRichMessage({
      chat_id: 1,
      rich_message: { markdown: "hi" },
    }),
    {
      message_id: 2,
    },
  );
  assert.deepEqual(directCalls, [
    { kind: "rich", body: { chat_id: 1, rich_message: { markdown: "hi" } } },
  ]);
  assert.deepEqual(busCalls, []);
});

test("Bus-aware API runtime keeps the guest ACK experiment on direct transport", async () => {
  const directCalls: unknown[] = [];
  const direct = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime(directCalls),
    ownsDirect: () => true,
    callFollowerApi: async () => assert.fail("unexpected follower call"),
  });
  assert.equal(
    await direct.answerGuestQueryForInlineMessage("guest-1", "ack"),
    "inline-1",
  );
  await direct.editGuestInlineMessage("inline-1", {
    richMessage: { markdown: "done" },
  });
  assert.deepEqual(directCalls, [
    {
      kind: "answer-guest-inline",
      guestQueryId: "guest-1",
      text: "ack",
      options: undefined,
    },
    {
      kind: "edit-guest-inline",
      inlineMessageId: "inline-1",
      content: { richMessage: { markdown: "done" } },
    },
  ]);

  const busCalls: unknown[] = [];
  const follower = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return true;
    },
  });
  await assert.rejects(
    follower.answerGuestQueryForInlineMessage("guest-1", "ack"),
    /answerGuestQueryForInlineMessage requires direct transport ownership/,
  );
  await assert.rejects(
    follower.editGuestInlineMessage("inline-1", { text: "done" }),
    /editGuestInlineMessage requires direct transport ownership/,
  );
  assert.deepEqual(busCalls, []);
});

test("Guest inline media edit forwards its guard only through current direct ownership", async () => {
  let owns = true;
  let edits = 0;
  const guard = { assertAuthority() {} };
  const content = { media: { type: "document" as const, media: "cached-id" } };
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: {
      ...createDirectRuntime([]),
      editGuestInlineMessage: async (id, received, options) => {
        assert.equal(id, "inline");
        assert.equal(received, content);
        assert.equal(options, guard);
        edits++;
      },
    },
    ownsDirect: () => owns,
    callFollowerApi: async () => assert.fail("Inline ownership cannot fall back to follower transport"),
  });
  await runtime.editGuestInlineMessage("inline", content, guard);
  owns = false;
  await assert.rejects(runtime.editGuestInlineMessage("inline", content, guard), /requires direct transport ownership/);
  assert.equal(edits, 1);
});

test("Bus-aware polling methods fail closed without direct ownership", async () => {
  const directCalls: unknown[] = [];
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime(directCalls),
    ownsDirect: () => false,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return true;
    },
  });

  await assert.rejects(
    runtime.deleteWebhook(),
    /deleteWebhook requires direct transport ownership/,
  );
  await assert.rejects(
    runtime.getUpdates({ offset: 1 }),
    /getUpdates requires direct transport ownership/,
  );
  assert.deepEqual(directCalls, []);
  assert.deepEqual(busCalls, []);
});

test("Bus-aware API runtime routes follower outbound calls through the leader", async () => {
  const directCalls: unknown[] = [];
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime(directCalls),
    ownsDirect: () => false,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      if (args[0] === "sendRichMessage") return { message_id: 77 };
      if (method === "downloadFile") return "/tmp/leader-photo.png";
      return true;
    },
  });

  assert.deepEqual(
    await runtime.sendRichMessage({
      chat_id: 1,
      rich_message: {
        markdown: "hi\n\n![](tg://photo?id=result)",
        media: [
          {
            id: "result",
            media: { type: "photo", media: "cached-photo" },
          },
        ],
      },
    }),
    {
      message_id: 77,
    },
  );
  assert.equal(
    await runtime.sendChatAction(1, "typing", { message_thread_id: 5 }),
    true,
  );
  assert.equal(
    await runtime.call("sendChatAction", { chat_id: 1, action: "typing" }),
    true,
  );
  assert.equal(
    await runtime.sendMessageDraft(1, 2, "draft", { message_thread_id: 5 }),
    true,
  );
  await runtime.deleteMessage(1, 9);
  await runtime.answerCallbackQuery("cb1", "Done");
  await runtime.answerGuestQuery("guest1", "Hello", { parseMode: "Markdown" });
  await runtime.answerGuestQuery("guest2", undefined, {
    result: {
      type: "photo",
      id: "photo-1",
      photo_file_id: "cached-photo",
      caption: "Result",
    },
  });
  assert.equal(
    await runtime.downloadFile("file1", "photo.png"),
    "/tmp/leader-photo.png",
  );

  assert.deepEqual(directCalls, []);
  assert.deepEqual(busCalls, [
    {
      method: "call",
      args: [
        "sendRichMessage",
        {
          chat_id: 1,
          rich_message: {
            markdown: "hi\n\n![](tg://photo?id=result)",
            media: [
              {
                id: "result",
                media: { type: "photo", media: "cached-photo" },
              },
            ],
          },
        },
      ],
    },
    {
      method: "call",
      args: [
        "sendChatAction",
        { chat_id: 1, action: "typing", message_thread_id: 5 },
        { maxAttempts: 1, retrySafety: "non-idempotent" },
      ],
    },
    {
      method: "call",
      args: ["sendChatAction", { chat_id: 1, action: "typing" }, undefined],
    },
    {
      method: "call",
      args: [
        "sendMessageDraft",
        { chat_id: 1, draft_id: 2, text: "draft", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: ["deleteMessage", { chat_id: 1, message_id: 9 }],
    },
    {
      method: "call",
      args: ["answerCallbackQuery", { callback_query_id: "cb1", text: "Done" }],
    },
    {
      method: "call",
      args: [
        "answerGuestQuery",
        {
          guest_query_id: "guest1",
          result: {
            type: "article",
            id: "1",
            title: "Response",
            input_message_content: {
              message_text: "Hello",
              parse_mode: "Markdown",
            },
          },
        },
      ],
    },
    {
      method: "call",
      args: [
        "answerGuestQuery",
        {
          guest_query_id: "guest2",
          result: {
            type: "photo",
            id: "photo-1",
            photo_file_id: "cached-photo",
            caption: "Result",
          },
        },
      ],
    },
    {
      method: "downloadFile",
      args: ["file1", "photo.png"],
    },
  ]);
});

test("Attachment source survives the bus-aware wrapper and the leader proxy into the scoped file name", async () => {
  const names: string[] = [];
  const direct = createTelegramBridgeApiRuntime({
    client: { ...createTelegramApiClient(() => "test-token"),
      async downloadFile(_fileId, fileName) { names.push(fileName); return `/tmp/${fileName}`; } },
    tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, getBotScope: () => "@pi_bot", recordRuntimeEvent: () => {},
  });
  const source = { kind: "voice", messageId: 175683, chat: { id: 7, type: "private" } };
  const leader = createTelegramBusAwareApiRuntime({ directRuntime: direct, ownsDirect: () => true,
    callFollowerApi: async () => assert.fail("leader downloads directly") });
  assert.equal(await leader.downloadFile("file", "voice-175683.ogg", source), "/tmp/voice-pi_bot-175683.ogg");
  const proxy = createTelegramBusLeaderApiProxy({ call: async () => true, callMultipart: async () => true,
    downloadFile: direct.downloadFile });
  const follower = createTelegramBusAwareApiRuntime({ directRuntime: direct, ownsDirect: () => false,
    callFollowerApi: (method, args) => proxy(method, structuredClone(args)) });
  assert.equal(await follower.downloadFile("file", "voice-9.ogg", { ...source, messageId: 9 }), "/tmp/voice-pi_bot-9.ogg");
  // A malformed follower source is ignored rather than trusted; the plain generated name remains.
  assert.equal(await proxy("downloadFile", ["file", "voice-10.ogg", { kind: "voice", messageId: "10/../x" }]), "/tmp/voice-10.ogg");
  assert.equal(await follower.downloadFile("file", "photo-11.jpg", { kind: "photo", messageId: 11, chat: source.chat, scope: "@peer" }), "/tmp/photo-peer-11.jpg",
    "an explicit guest scope replaces the bot scope across the proxy");
  assert.deepEqual(names, ["voice-pi_bot-175683.ogg", "voice-pi_bot-9.ogg", "voice-10.ogg", "photo-peer-11.jpg"]);
});

test("Bus-aware API runtime applies follower default thread to scoped actions", async () => {
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    getDefaultTarget: () => ({ chatId: 1, threadId: 5 }),
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return true;
    },
  });

  await runtime.sendTypingAction(1);
  await runtime.sendRecordVoiceAction(1);
  await runtime.sendMessageDraft(1, 2, "draft");
  await runtime.sendTypingAction(2);

  assert.deepEqual(busCalls, [
    {
      method: "call",
      args: [
        "sendChatAction",
        { chat_id: 1, action: "typing", message_thread_id: 5 },
        { maxAttempts: 1, retrySafety: "non-idempotent" },
      ],
    },
    {
      method: "call",
      args: [
        "sendChatAction",
        { chat_id: 1, action: "record_voice", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: [
        "sendMessageDraft",
        { chat_id: 1, draft_id: 2, text: "draft", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: ["sendChatAction", { chat_id: 2, action: "typing" }, { maxAttempts: 1, retrySafety: "non-idempotent" }],
    },
  ]);
});

test("Bus-aware API runtime marks follower sends to a different thread", async () => {
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    getDefaultTarget: () => ({ chatId: 1, threadId: 5 }),
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return { message_id: 9 };
    },
  });
  await runtime.sendRichMessage({
    chat_id: 1,
    message_thread_id: 7,
    rich_message: { markdown: "Cross-target" },
  });
  await runtime.sendRichMessage({
    chat_id: 1,
    message_thread_id: 5,
    rich_message: { markdown: "Own target" },
  });
  assert.deepEqual(busCalls, [
    {
      method: "call",
      args: [
        "sendRichMessage",
        {
          chat_id: 1,
          message_thread_id: 7,
          rich_message: { markdown: "Cross-target" },
          __piTelegramCrossTargetDelivery: true,
        },
      ],
    },
    {
      method: "call",
      args: [
        "sendRichMessage",
        {
          chat_id: 1,
          message_thread_id: 5,
          rich_message: { markdown: "Own target" },
        },
      ],
    },
  ]);
});

test("Bus-aware API runtime routes follower multipart uploads through the leader", async () => {
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return { ok: true };
    },
  });

  const richMessage = {
    markdown: "Voice\n\n![](tg://audio?id=voice)",
    media: [
      {
        id: "voice",
        media: { type: "voice_note", media: "attach://voice_upload" },
      },
    ],
  };
  assert.deepEqual(
    await runtime.callMultipart(
      "sendRichMessage",
      { chat_id: "1", rich_message: JSON.stringify(richMessage) },
      "voice_upload",
      "/tmp/voice.ogg",
      "voice.ogg",
    ),
    { ok: true },
  );
  assert.deepEqual(busCalls, [
    {
      method: "callMultipart",
      args: [
        "sendRichMessage",
        { chat_id: "1", rich_message: JSON.stringify(richMessage) },
        "voice_upload",
        "/tmp/voice.ogg",
        "voice.ogg",
        undefined,
      ],
    },
  ]);
});

test("follower editMessageText normalizes an unmodified-message rejection to unchanged", async () => {
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    callFollowerApi: async () => {
      throw new Error(
        "Telegram API editMessageText failed: HTTP 400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      );
    },
  });
  const result = await runtime.editMessageText({
    chat_id: 7,
    message_id: 42,
    text: "same body",
    parse_mode: "HTML",
  });
  assert.equal(result, "unchanged");
});

test("follower editMessageText rethrows non-unmodified failures", async () => {
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    callFollowerApi: async () => {
      throw new Error("Telegram API editMessageText failed: HTTP 400: Bad Request: message text is empty");
    },
  });
  await assert.rejects(
    runtime.editMessageText({
      chat_id: 7,
      message_id: 42,
      text: "",
      parse_mode: "HTML",
    }),
    /message text is empty/,
  );
});
