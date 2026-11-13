/**
 * Regression tests for Telegram API helpers
 * Verifies direct helper behavior around missing tokens, callback-query failures, downloads, and runtime transport binding
 */

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import fileSystem from "node:fs/promises";
import nativeFileSystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  answerTelegramCallbackQuery,
  callTelegram,
  callTelegramMultipart,
  cleanupTelegramTempFiles,
  createDefaultTelegramBridgeApiRuntime,
  createTelegramAttachmentFileName,
  createTelegramApiClient,
  createTelegramApiTargetActivityRuntime,
  createTelegramApiTargetTrackingClient,
  createTelegramApiWorkspaceAdmissionClient,
  createTelegramAssistantDraftSender,
  createTelegramBridgeApiRuntime,
  createTelegramChatActionSender,
  createTelegramNativeMarkdownDraftSender,
  downloadTelegramFile,
  fetchTelegramBotIdentity,
  getTelegramApiErrorRequestTarget,
  getTelegramApiWorkspaceAdmissionScope,
  getTelegramByteLimitFromEnv,
  isTelegramApiCommitUnknownError,
  isTelegramApiRequestRejected,
  isTelegramMessageNotModifiedError,
  setTelegramApiHttpsFetchForTesting,
  prepareTelegramTempDir,
  TELEGRAM_FILE_MAX_BYTES,
  TelegramApiWorkspaceAdmissionError,
  TelegramApiAuthorityError,
  type TelegramApiCallOptions,
  type TelegramApiClient,
  type TelegramApiUiAuthorityOptions,
  type TelegramInputRichMessage,
} from "../lib/telegram-api.ts";
import { isTelegramTopicTargetStaleError } from "../lib/threads.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import { createTelegramAssistantPreviewRuntime } from "../lib/preview.ts";
import { createTelegramBusAwareApiRuntime } from "../lib/bus-api.ts";
import { createGuestMarkdownReplyEditor } from "../lib/replies.ts";
import { handleTelegramAgentEndRuntime, type PendingTelegramTurn } from "../lib/queue.ts";
import { deliverTelegramGuestCachedAttachment } from "../lib/outbound-attachments.ts";
import { setTestFetch } from "./fixtures/shared.ts";

for (const markup of [false, true]) for (const phase of ["message", "boolean", "unchanged", "client-loss", "callback-loss", "observer-swap", "guard-swap", "observer-getter", "nonfunction", "callback-throw"] as const)
test(`Original native edit response is captured before normalization (${markup}/${phase})`, async () => {
  let current = true, calls = 0, observed = 0, replacements = 0, recoveries = 0, getterCalls = 0;
  const message = { message_id: 55, chat: { id: 7 }, message_thread_id: 42, from: { id: 123, is_bot: true } };
  let raw: unknown;
  const guard = () => { if (!current) throw new Error("Original native owner ended"); };
  const options: TelegramApiUiAuthorityOptions = { assertLocalAuthority: guard, onNativeEditResult(value) {
    observed++; raw = value; if (phase === "callback-loss") current = false; if (phase === "callback-throw") throw new Error("Local data observer failed");
  } };
  if (phase === "observer-getter") Object.defineProperty(options, "onNativeEditResult", { get() { getterCalls++; return () => {}; } });
  if (phase === "nonfunction") Object.defineProperty(options, "onNativeEditResult", { value: 7 });
  const client = { async call(_method: string, _body: unknown, local?: TelegramApiCallOptions) {
    calls++; assert.equal(local?.assertAuthority, guard); assert.equal(Object.hasOwn(local!, "onNativeEditResult"), false); local?.assertAuthority?.();
    if (phase === "unchanged") throw new Error("Bad Request: message is not modified");
    if (phase === "client-loss") current = false;
    return phase === "boolean" ? true : message;
  } } as unknown as TelegramApiClient;
  const runtime = createTelegramBridgeApiRuntime({ client, tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {}, captureRequestErrorHandler() {
    if (phase === "observer-swap") options.onNativeEditResult = () => { replacements++; };
    if (phase === "guard-swap") options.assertLocalAuthority = () => { replacements++; };
    return async () => { recoveries++; };
  } });
  const pending = markup ? runtime.editMessageReplyMarkup(7, 55, { inline_keyboard: [] }, options) : runtime.editMessageText({ chat_id: 7, message_id: 55, text: "Edited" }, options);
  if (["observer-getter", "nonfunction"].includes(phase)) { await assert.rejects(pending, /Native edit observer/u); assert.equal(calls, 0); assert.equal(observed, 0); }
  else if (phase === "client-loss" || phase === "callback-loss") { await assert.rejects(pending, error => error instanceof TelegramApiAuthorityError && error.requestIssued); assert.equal(observed, phase === "callback-loss" ? 1 : 0); }
  else if (phase === "callback-throw") { await assert.rejects(pending, /Local data observer failed/u); assert.equal(observed, 1); assert.equal(recoveries, 0, "An observation failure is not a second API recovery/issuance"); }
  else if (phase === "unchanged") { if (markup) await assert.rejects(pending, isTelegramMessageNotModifiedError); else assert.equal(await pending, "unchanged"); assert.equal(observed, 0); }
  else if (markup && phase === "boolean") { await assert.rejects(pending, /acknowledgement is unavailable/u); assert.equal(observed, 0); }
  else { assert.equal(await pending, "edited"); assert.equal(observed, 1); assert.equal(raw, phase === "boolean" ? true : message, "Capture the actual native result, never synthesize a carrier from the public outcome"); }
  assert.equal(getterCalls, 0); assert.equal(replacements, 0); assert.equal(calls, ["observer-getter", "nonfunction"].includes(phase) ? 0 : 1);
});

async function withNativeMarkupBody(capture: NonNullable<Parameters<typeof createTelegramBridgeApiRuntime>[0]["captureRequestErrorHandler"]>,
  run: (runtime: ReturnType<typeof createTelegramBridgeApiRuntime>, requests: Record<string, unknown>[], setResponse: (value: Response) => void) => Promise<void>) {
  const previous = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY, requests: Record<string, unknown>[] = [];
  let response: Response | undefined; process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options!.body as string)); return response ?? new Response(JSON.stringify({ ok: true, result: { message_id: 201, chat: { id: 42 } } })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const runtime = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:markup-body"), tempDir: "/home/llb/pttmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
    captureRequestErrorHandler: capture, recordRuntimeEvent() {} });
  try { await run(runtime, requests, value => { response = value; }); }
  finally { restore(); globalThis.fetch = previous; if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family; }
}

for (const field of ["chat_id", "message_id", "message_thread_id", "inline_message_id", "business_connection_id", "direct_messages_topic_id"])
test(`Native positional markup body keeps original route through recovery capture (${field})`, async () => {
  const markup = { inline_keyboard: [[{ text: "Original", callback_data: "data" }]] };
  await withNativeMarkupBody(body => {
    assert.equal(Reflect.set(body, field, field.endsWith("_id") && field !== "inline_message_id" && field !== "business_connection_id" ? 99 : "alternate"), false,
      "Native reconstruction must not lose the original carrier's routing fence");
    assert.equal(body.reply_markup, markup); assert.equal(Object.isFrozen(markup), false); markup.inline_keyboard[0]![0]!.text = "Caller mutation";
    return undefined;
  }, async (runtime, requests) => {
    assert.equal(await runtime.editMessageReplyMarkup(42, 201, markup), "edited");
    assert.deepEqual(requests, [{ chat_id: 42, message_id: 201, reply_markup: { inline_keyboard: [[{ text: "Caller mutation", callback_data: "data" }]] } }]);
  });
});

test("Native positional markup body excludes whole-body serialization replacement", async () => {
  await withNativeMarkupBody(body => {
    assert.equal(Reflect.set(body, "toJSON", () => ({ chat_id: 99, message_id: 909 })), false);
    assert.equal(body.toJSON, undefined); assert.equal(Object.prototype.propertyIsEnumerable.call(body, "toJSON"), true, "Client snapshots must retain the undefined serializer sentinel"); return undefined;
  }, async (runtime, requests) => { await runtime.editMessageReplyMarkup(42, 201, { inline_keyboard: [] }); assert.equal(requests[0]!.chat_id, 42); assert.equal(requests[0]!.message_id, 201); });
});

test("Native positional markup body excludes prototype serializer replacement", async () => {
  await withNativeMarkupBody(body => {
    assert.equal(Reflect.setPrototypeOf(body, { toJSON: () => ({ chat_id: 99, message_id: 909 }) }), false); return undefined;
  }, async (runtime, requests) => { await runtime.editMessageReplyMarkup(42, 201, { inline_keyboard: [] }); assert.equal(requests[0]!.chat_id, 42); assert.equal(requests[0]!.message_id, 201); });
});

test("Native positional markup excludes inherited serializer on the existing prototype", async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    await withNativeMarkupBody(_body => {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value(this: unknown) { return typeof this === "object" && this !== null && "chat_id" in this && "message_id" in this ? { chat_id: 99, message_id: 909 } : this; } });
      return undefined;
    }, async (runtime, requests) => { await runtime.editMessageReplyMarkup(42, 201, { inline_keyboard: [] }); assert.equal(requests[0]!.chat_id, 42); assert.equal(requests[0]!.message_id, 201); });
  } finally { if (previous) Object.defineProperty(Object.prototype, "toJSON", previous); else Reflect.deleteProperty(Object.prototype, "toJSON"); }
});

test("Native positional markup strict recovery mutation refuses before actual issuance", async () => {
  await withNativeMarkupBody(body => { body.chat_id = 99; return undefined; }, async (runtime, requests) => {
    await assert.rejects(runtime.editMessageReplyMarkup(42, 201, { inline_keyboard: [] }), TypeError); assert.equal(requests.length, 0);
  });
});

test("Native positional markup preserves method-bound not-modified rejection", async () => {
  await withNativeMarkupBody(body => { assert.equal(Reflect.set(body, "inline_message_id", "alternate"), false); return undefined; }, async (runtime, requests, setResponse) => {
    setResponse(new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }), { status: 400 }));
    await assert.rejects(runtime.editMessageReplyMarkup(42, 201, { inline_keyboard: [] }), error => { assert.ok(isTelegramMessageNotModifiedError(error)); assert.ok(isTelegramApiRequestRejected(error, "editMessageReplyMarkup")); return true; });
    assert.equal(requests.length, 1); assert.equal(requests[0]!.chat_id, 42); assert.equal(requests[0]!.message_id, 201);
  });
});

for (const result of [true, false, null, {}, { message_id: 201 }, { message_id: 202, chat: { id: 42 } }, { message_id: 201, chat: { id: 99 } }, [{ message_id: 201, chat: { id: 42 } }]])
test(`Native markup positive outcome refuses malformed or mismatched response (${JSON.stringify(result)})`, async () => {
  await withNativeMarkupBody(() => undefined, async (runtime, requests, setResponse) => {
    setResponse(new Response(JSON.stringify({ ok: true, result })));
    await assert.rejects(runtime.editMessageReplyMarkup(42, 201, { inline_keyboard: [] }), error => {
      assert.match(String(error), /acknowledgement is unavailable/u); assert.equal(isTelegramApiRequestRejected(error, "editMessageReplyMarkup"), false,
        "An issued malformed success is unknown, not native non-use/rejection authority"); return true;
    });
    assert.equal(requests.length, 1); assert.equal(requests[0]!.chat_id, 42); assert.equal(requests[0]!.message_id, 201);
  });
});

test("Native positional markup protection does not freeze unrelated caller-owned send bodies", async () => {
  const original = { chat_id: 42, text: "Original" };
  await withNativeMarkupBody(body => { assert.equal(body, original); assert.equal(Object.isFrozen(body), false); body.text = "Caller rendering"; return undefined; },
    async (runtime, requests) => { await runtime.sendMessage(original); assert.deepEqual(requests, [{ chat_id: 42, text: "Caller rendering" }]); });
});

test("Artifact observer carrier preserves original and ordered secondary identities only in process", async () => {
  const previous = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  let requests = 0, issued = 0, original: unknown;
  const recovery = new Error("private recovery"), diagnostics = [new Error("private recovery diagnostic"), new TelegramApiAuthorityError(false)];
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ ok: false, error_code: 400, description: "private rejection" }), { status: 400 }); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const runtime = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:artifact"), tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
    captureRequestErrorHandler: () => async error => { original = error; throw recovery; },
    recordRuntimeEvent() { throw diagnostics.shift(); } });
  const firstDiagnostic = diagnostics[0], secondDiagnostic = diagnostics[1];
  try {
    await assert.rejects(runtime.callArtifactBytes!({ chat_id: "7" }, Buffer.from("abc"), "file", { onRequestIssued() { issued++; } }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.deepEqual(error.errors, [original, recovery, firstDiagnostic, secondDiagnostic]);
      for (const [index, cause] of [original, recovery, firstDiagnostic, secondDiagnostic].entries()) assert.equal(error.errors[index], cause);
      assert.equal(isTelegramApiRequestRejected(error, "sendDocument"), true);
      assert.equal(isTelegramApiRequestRejected(error, "sendMessage"), false);
      assert.equal(isTelegramApiRequestRejected(new AggregateError([original], "metadata", { cause: original }), "sendDocument"), false);
      return true;
    });
    assert.equal(requests, 1); assert.equal(issued, 1);
    const fresh = runtime.reserveArtifact!(); assert.ok(fresh); fresh.release();
  } finally { restore(); globalThis.fetch = previous; if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family; }
});

test("Artifact native reservation is single-use, owner-matched and held through actual work despite early release", async () => {
  const previous = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4";
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0;
  globalThis.fetch = async () => { requests++; entered.resolve(); await release.promise; return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })); };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch), client = createTelegramApiClient(() => "123:artifact"), other = createTelegramApiClient(() => "123:other");
  const permit = client.reserveArtifact!()!;
  let work: Promise<unknown> | undefined;
  try {
    const send = (artifactReservation = permit) => client.callArtifactBytes!({ chat_id: "7" }, Buffer.from("abc"), "file", { artifactReservation });
    const foreign = other.reserveArtifact!()!;
    await assert.rejects(send(foreign), TelegramApiAuthorityError); foreign.release();
    work = send(); await entered.promise;
    permit.release(); permit.release();
    assert.equal(client.reserveArtifact!(), undefined);
    await assert.rejects(send(), TelegramApiAuthorityError);
    assert.equal(requests, 1); release.resolve(); await work;
    const replacement = client.reserveArtifact!()!; assert.ok(replacement);
    permit.release(); assert.equal(client.reserveArtifact!(), undefined, "Old cleanup cannot clear replacement lease");
    replacement.release(); const fresh = client.reserveArtifact!(); assert.ok(fresh); fresh.release();
  } finally { release.resolve(); await work; restore(); globalThis.fetch = previous; if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family; }
});

for (const status of [200, 400, 429, 500]) test(`Artifact native byte upload uses activity, Workspace and one HTTP attempt (${status})`, async () => {
  const activity = createTelegramApiTargetActivityRuntime(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const dir = await mkdtemp(join(tmpdir(), "pt-artifact-api-"));
  const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"), profileKey: "artifact", owner: { processId: process.pid, processBirthId: `${process.pid}:artifact` }, getProcessLiveness: () => "alive" });
  let requests = 0, admissions = 0, releases = 0, issued = 0;
  const bytes = Buffer.from([0, 255, 13, 10, 1]);
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const form = init!.body as FormData;
    assert.equal(form.get("chat_id"), "7"); assert.equal(form.get("message_thread_id"), "9");
    const file = form.get("document") as File;
    assert.equal(file.name, "résumé.bin"); assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    entered.resolve(); await release.promise;
    return new Response(JSON.stringify(status === 200 ? { ok: true, result: { message_id: 51 } } : { ok: false, error_code: status, description: "rejected", parameters: { retry_after: 0 } }), { status });
  };
  const restore = setTelegramApiHttpsFetchForTesting(globalThis.fetch);
  const admitted = createTelegramApiWorkspaceAdmissionClient(createTelegramApiClient(() => "123:artifact"), {
    acquireAdmission(input) { admissions++; return ledger.acquireAdmission(input); },
    releaseAdmission(lease) { releases++; return ledger.releaseAdmission(lease); },
  });
  const runtime = createTelegramBridgeApiRuntime({ client: createTelegramApiTargetTrackingClient(admitted, activity),
    tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent() {} });
  try {
    const work = runtime.callArtifactBytes!<{ message_id: number }>({ chat_id: "7", message_thread_id: "9" }, bytes, "résumé.bin", {
      maxAttempts: 12, retrySafety: "safe", onRequestIssued() { issued++; }, assertAuthority() {},
    });
    // Install rejection handling before releasing native work.
    const result = work.then(value => value, error => error);
    await entered.promise;
    assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 9 }), true);
    assert.equal(admissions, 1); assert.equal(releases, 0);
    release.resolve();
    const settled = await result;
    if (status === 200) assert.equal(settled.message_id, 51); else assert.ok(settled instanceof Error);
    assert.equal(requests, 1); assert.equal(issued, 1); assert.equal(releases, 1);
    assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 9 }), false);
  } finally { release.resolve(); restore(); globalThis.fetch = previous; await rm(dir, { recursive: true, force: true }); }
});

test("Target activity tracks exact JSON and multipart transport until settlement", async () => {
  const activity = createTelegramApiTargetActivityRuntime();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const client: TelegramApiClient = {
    async call<TResponse>() { await held; return true as TResponse; },
    async callMultipart() { throw new Error("upload failed"); },
    async downloadFile() { return "/tmp/file"; },
    async answerCallbackQuery() {},
  };
  const tracked = createTelegramApiTargetTrackingClient(client, activity);
  const request = tracked.call("sendMessage", {
    chat_id: "-1007", message_thread_id: "42", text: "hello",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(activity.hasPendingTarget({ chatId: -1007, threadId: 42 }), true);
  assert.deepEqual(activity.listPendingTargets(), [{ chatId: -1007, threadId: 42 }]);
  assert.equal(activity.hasPendingTarget({ chatId: -1007, threadId: 43 }), false);
  release?.();
  await request;
  assert.equal(activity.hasPendingTarget({ chatId: -1007, threadId: 42 }), false);
  await assert.rejects(tracked.callMultipart("sendDocument", {
    chat_id: "-1007", message_thread_id: "42",
  }, "document", "/tmp/file", "file.txt"), /upload failed/);
  assert.deepEqual(activity.listPendingTargets(), []);
  const messageScoped = activity.begin("editMessageText", {
    chat_id: -1007, message_id: 9,
  });
  assert.equal(activity.hasPendingTarget({ chatId: -1007, threadId: 42 }), true);
  assert.deepEqual(activity.listPendingChats(), [-1007]);
  messageScoped();
  assert.equal(activity.hasPendingTarget({ chatId: -1007, threadId: 42 }), false);
  const unscoped = activity.begin("getUpdates", { timeout: 1 });
  assert.deepEqual(activity.listPendingTargets(), []);
  assert.deepEqual(activity.listPendingChats(), []);
  unscoped();
});

test("API Workspace admission scope is exact, chat-wide, or conservatively profile-wide", () => {
  assert.deepEqual(
    getTelegramApiWorkspaceAdmissionScope({
      chat_id: "-1007",
      message_thread_id: "42",
    }),
    { kind: "target", target: { chatId: -1007, threadId: 42 } },
  );
  assert.deepEqual(
    getTelegramApiWorkspaceAdmissionScope({ chat_id: -1007, message_id: 9 }),
    { kind: "chat", chatId: -1007 },
  );
  assert.deepEqual(
    getTelegramApiWorkspaceAdmissionScope({
      chat_id: -1007,
      message_thread_id: "invalid",
    }),
    { kind: "profile" },
  );
  assert.deepEqual(
    getTelegramApiWorkspaceAdmissionScope({ chat_id: "invalid" }),
    { kind: "profile" },
  );
  assert.equal(getTelegramApiWorkspaceAdmissionScope({ timeout: 30 }), undefined);
});

test("JSON and multipart API calls hold exact Workspace admission through settlement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-api-admission-"));
  try {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "workspace-admission.json"),
      profileKey: "profile:api",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:api-admission-test`,
      },
      getProcessLiveness: () => "alive",
    });
    let jsonObserved = false;
    let multipartObserved = false;
    const client: TelegramApiClient = {
      async call<TResponse>() {
        const snapshot = admission.read();
        jsonObserved =
          snapshot.leases.length === 1 &&
          snapshot.leases[0]?.operationKind === "api.sendMessage" &&
          snapshot.leases[0]?.scope.kind === "target";
        const fence = admission.acquireRetirementFence({
          operationId: "api-json-fence",
          retirementIntentId: "api-json-intent",
          bindingKey: "api-json-binding",
          slot: "A",
          target: { chatId: -1007, threadId: 42 },
          leaderEpoch: 1,
          retirementRequestedAtMs: 1,
        });
        assert.deepEqual(fence, { kind: "blocked", reason: "admission-active" });
        return true as TResponse;
      },
      async callMultipart<TResponse>() {
        const snapshot = admission.read();
        multipartObserved =
          snapshot.leases.length === 1 &&
          snapshot.leases[0]?.operationKind === "api.sendDocument" &&
          snapshot.leases[0]?.scope.kind === "target";
        return true as TResponse;
      },
      async downloadFile() {
        return "/tmp/file";
      },
      async answerCallbackQuery() {},
    };
    const admitted = createTelegramApiWorkspaceAdmissionClient(
      client,
      admission,
      { createOperationId: () => "stable-api-operation" },
    );
    assert.equal(
      await admitted.call("sendMessage", {
        chat_id: -1007,
        message_thread_id: 42,
        text: "hello",
      }),
      true,
    );
    assert.deepEqual(admission.read().leases, []);
    assert.equal(
      await admitted.callMultipart(
        "sendDocument",
        { chat_id: "-1007", message_thread_id: "42" },
        "document",
        "/tmp/file",
        "file.txt",
      ),
      true,
    );
    assert.equal(jsonObserved, true);
    assert.equal(multipartObserved, true);
    assert.deepEqual(admission.read().leases, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Concurrent API calls cannot share one Workspace admission operation identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-api-operation-id-"));
  let releaseTransport: (() => void) | undefined;
  try {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "workspace-admission.json"),
      profileKey: "profile:api-duplicate",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:api-duplicate-test`,
      },
      getProcessLiveness: () => "alive",
    });
    const heldTransport = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    let transportCalls = 0;
    const client: TelegramApiClient = {
      async call<TResponse>() {
        transportCalls += 1;
        await heldTransport;
        return true as TResponse;
      },
      async callMultipart<TResponse>() {
        return true as TResponse;
      },
      async downloadFile() {
        return "/tmp/file";
      },
      async answerCallbackQuery() {},
    };
    const admitted = createTelegramApiWorkspaceAdmissionClient(
      client,
      admission,
      { createOperationId: () => "shared-live-operation" },
    );
    const first = admitted.call("sendMessage", {
      chat_id: -1007,
      message_thread_id: 42,
      text: "first",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(admission.read().leases.length, 1);

    await assert.rejects(
      () => admitted.call("sendMessage", {
        chat_id: -1007,
        message_thread_id: 42,
        text: "second",
      }),
      (error) => error instanceof TelegramApiWorkspaceAdmissionError &&
        error.code === "duplicate-operation",
    );
    assert.equal(transportCalls, 1);
    assert.equal(admission.read().leases.length, 1);
    assert.deepEqual(
      admission.acquireRetirementFence({
        operationId: "duplicate-api-fence",
        retirementIntentId: "duplicate-api-intent",
        bindingKey: "duplicate-api-binding",
        slot: "A",
        target: { chatId: -1007, threadId: 42 },
        leaderEpoch: 1,
        retirementRequestedAtMs: 1,
      }),
      { kind: "blocked", reason: "admission-active" },
    );
    if (!releaseTransport) throw new Error("Transport release was not captured.");
    releaseTransport();
    await first;
    assert.deepEqual(admission.read().leases, []);
  } finally {
    releaseTransport?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("API Workspace fence blocks issuance and failed requests still release leases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-api-fence-"));
  try {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "workspace-admission.json"),
      profileKey: "profile:api",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:api-admission-test`,
      },
      getProcessLiveness: () => "alive",
    });
    const fenced = admission.acquireRetirementFence({
      operationId: "api-active-fence",
      retirementIntentId: "api-active-intent",
      bindingKey: "api-active-binding",
      slot: "A",
      target: { chatId: -1007, threadId: 42 },
      leaderEpoch: 1,
      retirementRequestedAtMs: 1,
    });
    assert.equal(fenced.kind, "acquired");
    let calls = 0;
    const client: TelegramApiClient = {
      async call() {
        calls += 1;
        throw new Error("request failed");
      },
      async callMultipart<TResponse>() {
        calls += 1;
        return true as TResponse;
      },
      async downloadFile() {
        return "/tmp/file";
      },
      async answerCallbackQuery() {},
    };
    const admitted = createTelegramApiWorkspaceAdmissionClient(client, admission);
    await assert.rejects(
      admitted.call("sendMessage", {
        chat_id: -1007,
        message_thread_id: 42,
      }),
      (error) =>
        error instanceof TelegramApiWorkspaceAdmissionError &&
        error.code === "blocked",
    );
    assert.equal(calls, 0);
    if (fenced.kind === "acquired") {
      assert.equal(admission.releaseUnissuedRetirementFence(fenced.fence), true);
    }
    await assert.rejects(
      admitted.call("sendMessage", {
        chat_id: -1007,
        message_thread_id: 42,
      }),
      /request failed/u,
    );
    assert.equal(calls, 1);
    assert.deepEqual(admission.read().leases, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("API admission release failure cannot turn a settled request into replay", async () => {
  const releaseErrors: unknown[] = [];
  const admitted = createTelegramApiWorkspaceAdmissionClient(
    {
      async call<TResponse>() {
        return "sent" as TResponse;
      },
      async callMultipart<TResponse>() {
        return "uploaded" as TResponse;
      },
      async downloadFile() {
        return "/tmp/file";
      },
      async answerCallbackQuery() {},
    },
    {
      acquireAdmission(input) {
        return {
          kind: "acquired",
          resumed: false,
          lease: {
            ...input,
            profileKey: "profile:api",
            owner: {
              processId: process.pid,
              processBirthId: `${process.pid}:api-admission-test`,
            },
            acquiredAtMs: 1,
          },
        };
      },
      releaseAdmission() {
        throw new Error("release outcome unknown");
      },
    },
    {
      createOperationId: () => "settled-request",
      onReleaseError(error) {
        releaseErrors.push(error);
      },
    },
  );
  assert.equal(
    await admitted.call("sendMessage", {
      chat_id: -1007,
      message_thread_id: 42,
    }),
    "sent",
  );
  assert.equal(releaseErrors.length, 1);
});

function createApiResponseBody(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result };
}

function createApiJsonResponse(result: unknown): Response {
  const body = createApiResponseBody(result);
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function createApiErrorResponse(
  status: number,
  description: string,
  headers?: Headers,
): Response {
  return {
    ok: false,
    status,
    headers,
    text: async () => JSON.stringify({ ok: false, description }),
  } as Response;
}

test("Message deletion accepts only typed exact HTTP 400 already-absent evidence", async () => {
  for (const [status, description, succeeds] of [
    [400, "Bad Request: message to delete not found", true],
    [403, "Bad Request: message to delete not found", false],
    [400, "Bad Request: message can't be deleted", false],
  ] as const) {
    const restoreFetch = setTestFetch(async () => createApiErrorResponse(status, description));
    try {
      const runtime = createDefaultTelegramBridgeApiRuntime({
        getBotToken: () => "test-token",
        recordRuntimeEvent: () => {},
      });
      if (succeeds) await runtime.deleteMessage(100, 99);
      else await assert.rejects(runtime.deleteMessage(100, 99));
    } finally {
      restoreFetch();
    }
  }
});

function createMalformedApiTextResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => text,
  } as Response;
}

for (const fail of ["none", "capture", "sync", "async"] as const)
test(`API drain observation follows per-target and chat counts without changing requests (${fail})`, async () => {
  let notifications = 0;
  const activity = createTelegramApiTargetActivityRuntime({ captureDrain() {
    if (fail === "capture") throw new Error("observer");
    return () => {
      if (fail === "sync") throw new Error("observer");
      if (fail === "async") return Promise.reject(new Error("observer"));
      notifications++;
    };
  } });
  const first = activity.begin("sendMessage", { chat_id: 7, message_thread_id: 10 });
  const last = activity.begin("sendMessage", { chat_id: 7, message_thread_id: 10 });
  first(); first();
  assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 10 }), true);
  assert.equal(notifications, 0);
  last(); last();
  assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 10 }), false);
  const chat = activity.begin("editMessageText", { chat_id: 7, message_id: 99 });
  assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 42 }), true);
  chat();
  assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 42 }), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(notifications, fail === "none" ? 2 : 0);
});

function getApiTestFetchUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input.toString();
}

function setApiTestNetworkFamily(value: string | undefined): () => void {
  const previous = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  if (value === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
  else process.env.PI_TELEGRAM_NETWORK_FAMILY = value;
  return () => {
    if (previous === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
    else process.env.PI_TELEGRAM_NETWORK_FAMILY = previous;
  };
}

function createSyntheticFetchFailure(): TypeError {
  const ipv6Error = Object.assign(new Error("connect ENETUNREACH"), {
    code: "ENETUNREACH",
    address: "2a0a:f280::1",
    port: 443,
    family: 6,
  });
  const ipv4Error = Object.assign(new Error("connect ETIMEDOUT"), {
    code: "ETIMEDOUT",
    address: "149.154.167.220",
    port: 443,
    family: 4,
  });
  return new TypeError("fetch failed", {
    cause: new AggregateError([ipv6Error, ipv4Error], "connect failed"),
  });
}

function hasApiTestFamily(family: unknown): boolean {
  return family === 4 || family === 6;
}

function createApiRuntimeClient(
  overrides: Partial<TelegramApiClient> = {},
): TelegramApiClient {
  return {
    call: async <TResponse>() => true as TResponse,
    callMultipart: async <TResponse>() => true as TResponse,
    downloadFile: async () => "/tmp/file",
    answerCallbackQuery: async () => {},
    ...overrides,
  };
}

for (const rich of [false, true]) {
  for (const follower of [false, true]) {
    test(`${follower ? "Follower adapter" : "Direct"} ${rich ? "Rich" : "HTML"} drafts defer fresh updates without replaying rate-limited snapshots`, async () => {
      let now = 1000;
      let token = "123:fixture";
      let sleeps = 0;
      let permanentRequests = 0;
      const drafts: string[] = [];
      const restoreFetch = setTestFetch(async (input, init) => {
        const body = JSON.parse(String(init?.body));
        if (getApiTestFetchUrl(input).endsWith("/sendMessage")) {
          permanentRequests += 1;
          return permanentRequests === 1
            ? createApiErrorResponse(429, "Too Many Requests", new Headers({ "retry-after": "2" }))
            : createApiJsonResponse({ message_id: 100 });
        }
        drafts.push(body.rich_message?.markdown ?? body.text);
        return drafts.length === 1
          ? createApiErrorResponse(429, "Too Many Requests", new Headers({ "retry-after": "2" }))
          : createApiJsonResponse(true);
      });
      const client = createTelegramApiClient(() => token, { now: () => now });
      const runtime = createTelegramBridgeApiRuntime({
        tempDir: "/fixture", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, now: () => now,
        recordRuntimeEvent: () => {},
        client: createApiRuntimeClient({
          call: <T>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) =>
            client.call<T>(method, body, { ...options, sleep: async () => { sleeps += 1; } }),
        }),
      });
      const api = createTelegramBusAwareApiRuntime({
        directRuntime: runtime, ownsDirect: () => !follower,
        callFollowerApi: async (method, args) => {
          assert.equal(method, "call");
          return runtime.call(String(args[0]), args[1] as Record<string, unknown>, args[2] as TelegramApiCallOptions | undefined);
        },
      });
      const send = (text: string, threadId = 42) => rich
        ? api.sendRichMessageDraft({ chat_id: 7, message_thread_id: threadId, draft_id: 1, rich_message: { markdown: text } })
        : api.sendMessageDraft(7, 1, text, { message_thread_id: threadId });
      try {
        await assert.rejects(send("Initial"), /429/);
        assert.equal(sleeps, 0);
        assert.equal(await send("Deferred"), false);
        assert.equal(await api.call(rich ? "sendMessageDraft" : "sendRichMessageDraft", { chat_id: 7, message_thread_id: 42, draft_id: 2 }), false);
        assert.equal(await send("Other target", 43), true);
        token = "456:fixture";
        assert.equal(await send("Other bot"), true);
        token = "123:rotated-fixture";
        assert.equal(await send("Same bot after rotation"), false);
        await api.sendMessage({ chat_id: 7, message_thread_id: 42, text: "Final" });
        assert.equal(permanentRequests, 2);
        assert.equal(sleeps, 1, "Permanent-send retry policy remains unchanged");
        now = 2999;
        assert.equal(await send("Still deferred"), false);
        now = 3000;
        assert.equal(await send("Fresh"), true);
        assert.deepEqual(drafts, ["Initial", "Other target", "Other bot", "Fresh"]);
      } finally { restoreFetch(); }
    });
  }
}

for (const { status, retryAfter, delayMs } of [
  { status: 503, retryAfter: "3", delayMs: 3000 },
  { status: 500, retryAfter: undefined, delayMs: 500 },
  { status: 400, retryAfter: undefined, delayMs: 0 },
]) {
  test(`Draft HTTP ${status} preserves its existing retry eligibility and backoff without delaying final`, async () => {
    let now = 1000;
    let sleeps = 0;
    const drafts: string[] = [];
    const restoreFetch = setTestFetch(async (input, init) => {
      if (getApiTestFetchUrl(input).endsWith("/sendMessage")) return createApiJsonResponse({ message_id: 100 });
      const body = JSON.parse(String(init?.body));
      drafts.push(body.rich_message.markdown);
      return drafts.length === 1
        ? createApiErrorResponse(status, "Rejected draft", retryAfter ? new Headers({ "retry-after": retryAfter }) : undefined)
        : createApiJsonResponse(true);
    });
    const client = createTelegramApiClient(() => "123:fixture", { now: () => now });
    const send = (text: string) => client.call<boolean>("sendRichMessageDraft", {
      chat_id: 7, message_thread_id: 42, draft_id: 1, rich_message: { markdown: text },
    }, { sleep: async () => { sleeps += 1; } });
    try {
      await assert.rejects(send("Initial"), new RegExp(String(status)));
      assert.equal(sleeps, 0, "The rejected snapshot must not enter API retry backoff");
      if (delayMs > 0) {
        assert.equal(await send("Deferred"), false);
        now += delayMs - 1;
        assert.equal(await send("Still deferred"), false);
      }
      const final = await client.call<{ message_id: number }>("sendMessage", {
        chat_id: 7, message_thread_id: 42, text: "Final",
      });
      assert.equal(final.message_id, 100);
      if (delayMs > 0) now += 1;
      assert.equal(await send("Fresh"), true);
      assert.deepEqual(drafts, ["Initial", "Fresh"]);
    } finally { restoreFetch(); }
  });
}

test("Sealed preview drains its issued request but never waits for a 429 draft retry", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const issued = new Promise<void>((resolve) => { entered = resolve; });
  let requests = 0;
  let sleeps = 0;
  let finalSent = false;
  let final: Promise<boolean> | undefined;
  let flush: Promise<void> | undefined;
  const restoreFetch = setTestFetch(async () => {
    requests += 1; entered(); await gate;
    return createApiErrorResponse(429, "Too Many Requests", new Headers({ "retry-after": "3" }));
  });
  const client = createTelegramApiClient(() => "123:fixture");
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/fixture", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1, recordRuntimeEvent: () => {},
    client: createApiRuntimeClient({
      call: <T>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) =>
        client.call<T>(method, body, { ...options, sleep: async () => { sleeps += 1; } }),
    }),
  });
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: createTelegramNativeMarkdownDraftSender(runtime),
    sendMarkdownReply: async () => { finalSent = true; return 100; },
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "Completed answer." } });
    t.mock.timers.tick(2000);
    flush = preview.flush(7);
    await issued;
    final = preview.finalizeMarkdown(7, "Completed answer.", 21);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finalSent, false, "The issued HTTP request still owns its effect boundary");
    release(); await final;
    assert.equal(finalSent, true);
    assert.equal(requests, 1);
    assert.equal(sleeps, 0);
  } finally {
    release(); await Promise.allSettled([flush, final]);
    preview.invalidate(); restoreFetch();
  }
});

test("Outgoing Rich Message type supports explicit structured blocks", () => {
  const structured: TelegramInputRichMessage = {
    blocks: [{ type: "pre", text: "Working" }],
  };
  assert.deepEqual(structured, {
    blocks: [{ type: "pre", text: "Working" }],
  });
});

test("Telegram API byte-limit helpers expose the inbound file default", () => {
  assert.equal(TELEGRAM_FILE_MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(
    getTelegramByteLimitFromEnv({}, [], TELEGRAM_FILE_MAX_BYTES),
    TELEGRAM_FILE_MAX_BYTES,
  );
});

test("Telegram API byte-limit config prefers positive integer env values", () => {
  assert.equal(
    getTelegramByteLimitFromEnv(
      { PI_TELEGRAM_INBOUND_FILE_MAX_BYTES: "12345" },
      ["PI_TELEGRAM_INBOUND_FILE_MAX_BYTES"],
      99,
    ),
    12345,
  );
  assert.equal(
    getTelegramByteLimitFromEnv(
      {
        PI_TELEGRAM_INBOUND_FILE_MAX_BYTES: "0",
        TELEGRAM_MAX_FILE_SIZE_BYTES: "bad",
      },
      ["PI_TELEGRAM_INBOUND_FILE_MAX_BYTES", "TELEGRAM_MAX_FILE_SIZE_BYTES"],
      99,
    ),
    99,
  );
});

test("Telegram API helpers detect unchanged edit errors", () => {
  assert.equal(
    isTelegramMessageNotModifiedError(
      new Error("Bad Request: message is not modified"),
    ),
    true,
  );
  assert.equal(isTelegramMessageNotModifiedError(new Error("other")), false);
});

test("Telegram API chat-action sender binds a fixed action", async () => {
  const calls: Array<[number, string, number | undefined]> = [];
  const sendTyping = createTelegramChatActionSender(
    async (chatId, action, options) => {
      calls.push([chatId, action, options?.message_thread_id]);
    },
    "typing",
  );
  await sendTyping(7, { message_thread_id: 42 });
  assert.deepEqual(calls, [[7, "typing", 42]]);
});

test("Telegram bridge API runtime includes thread target on chat actions", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const runtime = createTelegramBridgeApiRuntime({
    client: createApiRuntimeClient({
      call: async <TResponse>(
        method: string,
        body: Record<string, unknown>,
      ) => {
        calls.push({ method, body });
        return true as TResponse;
      },
    }),
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {},
  });
  await runtime.sendTypingAction(7, { message_thread_id: 42 });
  await runtime.sendChatAction(7, "upload_document", { message_thread_id: 42 });
  assert.deepEqual(calls, [
    {
      method: "sendChatAction",
      body: { chat_id: 7, action: "typing", message_thread_id: 42 },
    },
    {
      method: "sendChatAction",
      body: { chat_id: 7, action: "upload_document", message_thread_id: 42 },
    },
  ]);
});

test("Telegram bridge API runtime leaves caller-owned expected failures to the caller's diagnostics", async () => {
  const logged: unknown[] = [];
  const runtime = createTelegramBridgeApiRuntime({
    client: createApiRuntimeClient({
      call: async () => {
        throw new Error("Telegram API sendMessage failed: HTTP 400: Bad Request: message thread not found");
      },
    }),
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: (_category, error) => logged.push(error),
  });
  await assert.rejects(runtime.call("sendMessage", { chat_id: 7 }, { isExpectedError: () => true }), /thread not found/);
  assert.deepEqual(logged, [], "an expected failure is still thrown but not logged as an API error");
  await assert.rejects(runtime.call("sendMessage", { chat_id: 7 }, { isExpectedError: () => false }), /thread not found/);
  assert.equal(logged.length, 1, "an unexpected failure keeps the API diagnostic");
});

for (const cancelled of [false, true]) for (const kind of ["authority", "http", "network"] as const) for (const requestIssued of kind === "authority" ? [false, true] : [true]) {
  test(`Typing cancellation suppresses only obsolete authority diagnostics (cancelled=${cancelled}, kind=${kind}, issued=${requestIssued})`, async () => {
    const error = kind === "authority" ? new TelegramApiAuthorityError(requestIssued)
      : kind === "http" ? new Error("HTTP 500 fixture") : new TypeError("fetch failed");
    const logged: unknown[] = [];
    const runtime = createTelegramBridgeApiRuntime({
      client: createApiRuntimeClient({ call: async (_method, _body, options) => {
        assert.equal(options?.maxAttempts, 1);
        throw error;
      } }),
      tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
      recordRuntimeEvent: (_category, failure) => logged.push(failure),
    });
    await assert.rejects(runtime.sendTypingAction(7, { isCancelled: () => cancelled }), failure => failure === error);
    assert.deepEqual(logged, cancelled && kind === "authority" ? [] : [error]);
  });
}

for (const kind of ["http", "network"] as const) {
  test(`Typing cancellation preserves real-client late ${kind} failure diagnostics`, async () => {
    const issued = Promise.withResolvers<void>(), response = Promise.withResolvers<void>();
    const logged: unknown[] = [];
    let cancelled = false, calls = 0;
    const networkError = new TypeError("fetch failed");
    const restoreFetch = setTestFetch(async () => {
      calls++; issued.resolve(); await response.promise;
      if (kind === "network") throw networkError;
      return createApiErrorResponse(500, "late failure fixture");
    });
    const runtime = createTelegramBridgeApiRuntime({ client: createTelegramApiClient(() => "123:fixture"),
      tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
      recordRuntimeEvent(_category, error) { logged.push(error); } });
    try {
      const request = runtime.sendTypingAction(7, {
        assertAuthority() { if (cancelled) throw new Error("Loop ended"); },
        isCancelled: () => cancelled,
      });
      await issued.promise; cancelled = true; response.resolve();
      const error = await request.catch((failure: unknown) => failure);
      assert.ok(error instanceof TelegramApiAuthorityError);
      assert.equal(error.requestIssued, true);
      assert.equal(calls, 1, "Cancellation cannot grant an HTTP retry");
      assert.equal(isTelegramApiCommitUnknownError(error), false);
      assert.equal(logged.length, 1, "Underlying transport failure must remain diagnostic");
      assert.equal(logged[0], error.cause);
      if (kind === "network") assert.equal(error.cause, networkError);
      else assert.match(String(error.cause), /HTTP 500.*late failure fixture/u);
    } finally { response.resolve(); restoreFetch(); }
  });
}

test("Telegram bridge API runtime owns reply-markup edits", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const runtime = createTelegramBridgeApiRuntime({
    client: createApiRuntimeClient({
      call: async <TResponse>(
        method: string,
        body: Record<string, unknown>,
      ) => {
        calls.push({ method, body });
        return { message_id: body.message_id, chat: { id: body.chat_id } } as TResponse;
      },
    }),
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {},
  });
  const replyMarkup = { inline_keyboard: [[{ text: "Run" }]] };

  await runtime.editMessageReplyMarkup(7, 42, replyMarkup);

  assert.deepEqual(calls, [
    {
      method: "editMessageReplyMarkup",
      body: { chat_id: 7, message_id: 42, reply_markup: replyMarkup, toJSON: undefined },
    },
  ]);
});

test("Telegram bridge API runtime coalesces exact actions while different Threads send independently", async () => {
  let nowMs = 1000, firstSettled = false;
  const firstResult = Promise.withResolvers<boolean>();
  const secondResult = Promise.withResolvers<boolean>();
  const calls: number[] = [];
  const callOptions: Array<{ maxAttempts?: number } | undefined> = [];
  const runtime = createTelegramBridgeApiRuntime({
    client: createApiRuntimeClient({
      call: async <TResponse>(_method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => {
        const thread = Number(body.message_thread_id);
        calls.push(thread);
        callOptions.push(options);
        return await (thread === 41 ? firstResult.promise : secondResult.promise) as TResponse;
      },
    }),
    tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {}, now: () => nowMs, chatActionMinIntervalMs: 2000,
  });
  const send = (thread: number) => runtime.sendTypingAction(7, { message_thread_id: thread });
  const first = send(41).then(value => { firstSettled = true; return value; });
  const joinedFirst = send(41);
  const second = send(42), joinedSecond = send(42);
  try {
    await Promise.resolve();
    assert.deepEqual(calls, [41, 42], "Both concrete Threads issue before either request completes");
    secondResult.resolve(true);
    assert.deepEqual(await Promise.all([second, joinedSecond]), [true, true]);
    assert.equal(firstSettled, false, "A slow Thread cannot delay its peer");
    firstResult.resolve(true);
    assert.deepEqual(await Promise.all([first, joinedFirst]), [true, true]);
    const policy = { assertAuthority: undefined, retryRateLimit: false, maxAttempts: 1, retrySafety: "non-idempotent" };
    assert.deepEqual(callOptions, [policy, policy]);
    nowMs = 2999;
    await Promise.all([send(41), send(42)]);
    assert.deepEqual(calls, [41, 42], "Each exact action retains its own minimum interval");
    nowMs = 3000;
    await Promise.all([send(41), send(42)]);
    assert.deepEqual(calls, [41, 42, 41, 42]);
  } finally {
    firstResult.resolve(true); secondResult.resolve(true);
    await Promise.all([first, joinedFirst, second, joinedSecond]);
  }
});

test("Concurrent Thread actions retain one shared 429 cooldown through peer completion", async () => {
  let nowMs = 1000;
  const first = Promise.withResolvers<Response>(), second = Promise.withResolvers<Response>();
  const calls: number[] = [], events: Record<string, unknown>[] = [];
  const restoreFetch = setTestFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { message_thread_id: number };
    calls.push(body.message_thread_id);
    return body.message_thread_id === 41 ? first.promise
      : body.message_thread_id === 42 ? second.promise : createApiJsonResponse(true);
  });
  try {
    const runtime = createTelegramBridgeApiRuntime({
      client: createTelegramApiClient(() => "123:fixture"),
      tempDir: "/tmp", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
      recordRuntimeEvent: (_kind, _error, details) => { events.push(details ?? {}); },
      now: () => nowMs, chatActionMinIntervalMs: 2000,
    });
    const send = (thread: number) => runtime.sendTypingAction(7, { message_thread_id: thread });
    const a = send(41), b = send(42);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(calls, [41, 42]);
      second.resolve(createApiJsonResponse(true));
      await b;
      await send(43);
      assert.deepEqual(calls, [41, 42, 43], "Peer completion cannot replace the still-pending first call\'s chat state");
      first.resolve(createApiErrorResponse(429, "Too Many Requests: retry after 3", new Headers({ "retry-after": "3" })));
      assert.equal(await a, true);
      assert.deepEqual(events, [{ method: "sendChatAction", rateLimited: true, retryAfterMs: 3000 }]);
      nowMs = 2000;
      assert.equal(await send(44), true);
      assert.deepEqual(calls, [41, 42, 43], "A late 429 must still govern every peer Thread");
      nowMs = 3999;
      await send(44);
      assert.deepEqual(calls, [41, 42, 43]);
      nowMs = 4000;
      await send(44);
      assert.deepEqual(calls, [41, 42, 43, 44], "Only a fresh action after retry_after may issue");
    } finally {
      first.resolve(createApiJsonResponse(true)); second.resolve(createApiJsonResponse(true));
      await Promise.all([a, b]);
    }
  } finally { restoreFetch(); }
});

test("Telegram bridge API runtime bounds active chat-action gates", async () => {
  let nowMs = 1000;
  const calls: string[] = [];
  const runtime = createTelegramBridgeApiRuntime({
    client: createApiRuntimeClient({
      call: async <TResponse>(
        _method: string,
        body: Record<string, unknown>,
      ) => {
        calls.push(String(body.chat_id));
        return true as TResponse;
      },
    }),
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {},
    now: () => nowMs,
    chatActionMinIntervalMs: 2000,
    chatActionMaxGates: 2,
  });
  const send = (chatId: number) =>
    runtime.call<boolean>("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });

  await send(1);
  await send(2);
  assert.equal(await send(3), true);
  assert.deepEqual(calls, ["1", "2"]);

  nowMs = 3000;
  assert.equal(await send(3), true);
  assert.deepEqual(calls, ["1", "2", "3"]);
});

test("Telegram bridge API runtime shares retry-after suppression across one chat", async () => {
  let nowMs = 1000;
  let calls = 0;
  const events: Array<Record<string, unknown>> = [];
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    return calls === 1
      ? createApiErrorResponse(
          429,
          "Too Many Requests: retry after 3",
          new Headers({ "retry-after": "3" }),
        )
      : createApiJsonResponse(true);
  });
  try {
    const runtime = createTelegramBridgeApiRuntime({
      client: createTelegramApiClient(() => "123:abc"),
      tempDir: "/tmp",
      maxFileSizeBytes: 1,
      tempFileMaxAgeMs: 1,
      recordRuntimeEvent: (_kind, _error, details) => {
        events.push(details ?? {});
      },
      now: () => nowMs,
      chatActionMinIntervalMs: 2000,
    });
    const body = {
      chat_id: 7,
      message_thread_id: 11,
      action: "typing",
    };
    const peerThreadBody = { ...body, message_thread_id: 12 };

    assert.equal(await runtime.call<boolean>("sendChatAction", body), true);
    assert.equal(calls, 1);
    assert.deepEqual(events, [
      {
        method: "sendChatAction",
        rateLimited: true,
        retryAfterMs: 3000,
      },
    ]);

    nowMs = 2000;
    assert.equal(
      await runtime.call<boolean>("sendChatAction", peerThreadBody),
      true,
    );
    assert.equal(calls, 1);
    assert.equal(
      await runtime.call<boolean>("sendChatAction", {
        ...peerThreadBody,
        chat_id: 8,
      }),
      true,
    );
    assert.equal(calls, 2);

    nowMs = 3999;
    assert.equal(
      await runtime.call<boolean>("sendChatAction", peerThreadBody),
      true,
    );
    assert.equal(calls, 2);
    nowMs = 4000;
    assert.equal(
      await runtime.call<boolean>("sendChatAction", peerThreadBody),
      true,
    );
    assert.equal(calls, 3);
  } finally {
    restoreFetch();
  }
});

for (const action of ["typing", "record_voice"] as const) test(`Chat-action retry policy preserves voice but never replays typing (${action})`, async () => {
  let calls = 0;
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    return calls === 1
      ? createApiErrorResponse(500, "Server Error")
      : createApiJsonResponse(true);
  });
  try {
    const runtime = createTelegramBridgeApiRuntime({
      client: createTelegramApiClient(() => "123:abc"),
      tempDir: "/tmp",
      maxFileSizeBytes: 1,
      tempFileMaxAgeMs: 1,
      recordRuntimeEvent: () => {},
    });

    const attempt = () => runtime.call<boolean>("sendChatAction", { chat_id: 7, action },
      { maxAttempts: 3, retrySafety: "safe", retryBaseDelayMs: 0, sleep: async () => {} });
    if (action === "typing") {
      await assert.rejects(attempt(), error => isTelegramApiCommitUnknownError(error));
      assert.equal(calls, 1, "Even explicit caller retry options cannot grant replay of ephemeral typing");
      assert.equal(await attempt(), true, "A fresh owner-controlled keepalive is an independent attempt");
    } else assert.equal(await attempt(), true);
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});

test("Telegram bridge API runtime still rejects non-rate-limit chat-action failures", async () => {
  const events: string[] = [];
  const runtime = createTelegramBridgeApiRuntime({
    client: createApiRuntimeClient({
      call: async () => {
        throw new Error("chat action failed");
      },
    }),
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: (kind, error) => {
      events.push(`${kind}:${error instanceof Error ? error.message : error}`);
    },
  });

  await assert.rejects(
    () =>
      runtime.call<boolean>("sendChatAction", {
        chat_id: 7,
        action: "typing",
      }),
    /chat action failed/,
  );
  assert.deepEqual(events, ["api:chat action failed"]);
});

test("Telegram native Markdown draft sender permits automatic entity detection", async () => {
  const richBodies: Record<string, unknown>[] = [];
  const legacyCalls: unknown[] = [];
  const sendDraft = createTelegramNativeMarkdownDraftSender({
    sendMessageDraft: async (...args) => {
      legacyCalls.push(args);
      return true;
    },
    sendRichMessageDraft: async (body) => {
      richBodies.push(body);
      return true;
    },
  });
  await sendDraft(7, 9, "#tag /cmd https://example.com");
  await sendDraft(7, 10, undefined);
  assert.deepEqual(richBodies, [
    {
      chat_id: 7,
      draft_id: 9,
      rich_message: {
        markdown: "#tag /cmd https://example.com",
      }
    },
  ]);
  assert.equal(legacyCalls.length, 1);
});

test("Telegram assistant draft sender follows final rendering mode", async () => {
  const richBodies: Record<string, unknown>[] = [];
  const legacyCalls: unknown[] = [];
  const sendDraft = createTelegramAssistantDraftSender({
    getAssistantRenderingMode: () => "html",
    renderMarkdownToHtmlDraft: (markdown) => `<b>${markdown}</b>`,
    sendMessageDraft: async (...args) => {
      legacyCalls.push(args);
      return true;
    },
    sendRichMessageDraft: async (body) => {
      richBodies.push(body);
      return true;
    },
  });
  await sendDraft(7, 9, "**draft**", { message_thread_id: 42 });
  await sendDraft(7, 10, undefined, { message_thread_id: 42 });
  assert.deepEqual(richBodies, []);
  assert.deepEqual(legacyCalls, [
    [7, 9, "<b>**draft**</b>", { message_thread_id: 42, parse_mode: "HTML" }],
    [7, 10, undefined, { message_thread_id: 42 }],
  ]);
});

test("Telegram API helper fetches bot identity through getMe", async () => {
  const response = await fetchTelegramBotIdentity("123:abc", async (url) => {
    assert.equal(String(url), "https://api.telegram.org/bot123:abc/getMe");
    return createApiJsonResponse({
      id: 1,
      is_bot: true,
      first_name: "Demo",
      username: "demo",
    });
  });
  assert.equal(response.ok, true);
  assert.equal(response.result?.username, "demo");
});

test("Telegram API helper fetches bot identity through IPv4 fallback", async () => {
  const familySeen: boolean[] = [];
  const restoreEnv = setApiTestNetworkFamily("ipv4-fallback");
  const restoreFetch = setTestFetch(async () => {
    familySeen.push(false);
    throw createSyntheticFetchFailure();
  });
  const restoreHttpsFetch = setTelegramApiHttpsFetchForTesting(
    async (_input, _init, family) => {
      familySeen.push(hasApiTestFamily(family));
      return createApiJsonResponse({
        id: 1,
        is_bot: true,
        first_name: "Demo",
        username: "demo",
      });
    },
  );
  try {
    const response = await fetchTelegramBotIdentity("123:abc");
    assert.equal(response.ok, true);
    assert.equal(response.result?.username, "demo");
    assert.deepEqual(familySeen, [false, true]);
  } finally {
    restoreHttpsFetch();
    restoreFetch();
    restoreEnv();
  }
});

test("Telegram temp cleanup removes stale attachment files by age and keeps directories", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-cleanup-"));
  const oldFile = join(tempDir, "voice-mybot-1.ogg");
  const stalePart = join(tempDir, "voice-mybot-2.ogg.00000000-0000-4000-8000-000000000001.part");
  const freshFile = join(tempDir, "voice-mybot-3.ogg");
  const nestedDir = join(tempDir, "nested");
  await writeFile(oldFile, "old", "utf8");
  await writeFile(stalePart, "partial", "utf8");
  await writeFile(freshFile, "fresh", "utf8");
  await mkdir(nestedDir);
  await writeFile(join(nestedDir, "keep.txt"), "keep", "utf8");
  await utimes(oldFile, new Date(1_000), new Date(1_000));
  await utimes(stalePart, new Date(1_000), new Date(1_000));
  await utimes(freshFile, new Date(10_000), new Date(10_000));
  assert.equal(await cleanupTelegramTempFiles(tempDir, 5_000, 11_000), 2);
  assert.deepEqual((await readdir(tempDir)).sort(), ["nested", "voice-mybot-3.ogg"]);
});

for (const [name, source, scope, expected] of [
  ["private chat uses the bot username", { kind: "voice", messageId: 174576, chat: { id: 7, type: "private" } }, "@my_bot", "voice-my_bot-174576.ogg"],
  ["private chat falls back to the bot id", { kind: "voice", messageId: 4, chat: { id: 7, type: "private" } }, "8502475096", "voice-8502475096-4.ogg"],
  ["public group uses its username", { kind: "photo", messageId: 9, chat: { id: -1001, type: "supergroup", username: "Team_Chat" } }, "@my_bot", "photo-Team_Chat-9.ogg"],
  ["anonymous group uses its unsigned id with a single dash", { kind: "photo", messageId: 9, chat: { id: -1001234567890, type: "supergroup" } }, "@my_bot", "photo-1001234567890-9.ogg"],
  ["titles never name files", { kind: "voice", messageId: 1, chat: { id: -5, type: "group" } }, "@my_bot", "voice-5-1.ogg"],
  ["rich message index", { kind: "photo", messageId: 2, index: 3, chat: { id: 7, type: "private" } }, "mybot", "photo-mybot-2-3.ogg"],
  ["sender file names stay a readable suffix", { kind: "document", messageId: 6, userFileName: "my report?.pdf", chat: { id: 7, type: "private" } }, "mybot", "document-mybot-6-my_report_.pdf"],
  ["unknown chat and scope omit the segment", { kind: "voice", messageId: 8 }, undefined, "voice-8.ogg"],
] as const) {
  test(`Attachment names are kind-scope-messageId without UUIDs (${name})`, () => {
    assert.equal(createTelegramAttachmentFileName(source, "generated.ogg", scope), expected);
    assert.doesNotMatch(expected, /--|[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });
}

test("Telegram temp preparation creates the directory and removes stale scratch files", async () => {
  const parentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-prepare-parent-"),
  );
  const tempDir = join(parentDir, "nested", "telegram");
  assert.equal(await prepareTelegramTempDir(tempDir, 5_000), 0);
  if (process.platform !== "win32") {
    assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
  }
  const oldFile = join(
    tempDir,
    "00000000-0000-4000-8000-000000000003-old.txt",
  );
  await writeFile(oldFile, "old", "utf8");
  await utimes(oldFile, new Date(1_000), new Date(1_000));
  assert.equal(await prepareTelegramTempDir(tempDir, 5_000), 1);
  assert.deepEqual(await readdir(tempDir), []);
});

test("Telegram API helpers reject missing bot token for direct calls", async () => {
  await assert.rejects(() => callTelegram(undefined, "getMe", {}), {
    message: "Telegram bot token is not configured",
  });
  await assert.rejects(
    () =>
      downloadTelegramFile(
        undefined,
        "file-id",
        "demo.txt",
        join(tmpdir(), "pi-telegram-missing-token"),
      ),
    {
      message: "Telegram bot token is not configured",
    },
  );
});

test("Telegram API helpers include HTTP status details for failed responses", async () => {
  const restoreFetch = setTestFetch(async () => {
    return createApiErrorResponse(429, "Too Many Requests");
  });
  try {
    await assert.rejects(
      () => callTelegram("123:abc", "sendMessage", {}, { maxAttempts: 1 }),
      {
        message: "Telegram API sendMessage failed: HTTP 429: Too Many Requests",
      },
    );
  } finally {
    restoreFetch();
  }
});

for (const surface of ["helper", "client", "direct", "bus-direct", "default-direct", "default-bus"] as const) {
  for (const boundary of ["current", "entry", "response", "parsing", "replacement"] as const) {
    test(`Typed callback authority ${surface} preserves its captured recipient (${boundary})`, async () => {
      let current = boundary !== "entry", calls = 0;
      const events: unknown[] = [], bodies: unknown[] = [];
      const options: Pick<TelegramApiCallOptions, "assertAuthority"> = {
        assertAuthority() { if (!current) throw new Error("recipient replaced with secret fixture context"); },
      };
      const restoreFetch = setTestFetch(async (_input, init) => {
        calls++;
        bodies.push(JSON.parse(String(init?.body)));
        const response = createApiJsonResponse(true);
        if (boundary === "response" || boundary === "replacement") {
          await Promise.resolve(); current = false;
          if (boundary === "replacement") options.assertAuthority = () => {};
        } else if (boundary === "parsing") {
          response.text = async () => { await Promise.resolve(); current = false; return JSON.stringify({ ok: true, result: true }); };
        }
        return response;
      });
      const client = createTelegramApiClient(() => "123:abc");
      const direct = createTelegramBridgeApiRuntime({ client, tempDir: "/unused", maxFileSizeBytes: 1,
        tempFileMaxAgeMs: 1, recordRuntimeEvent(_kind, error) { events.push(error); } });
      const bus = createTelegramBusAwareApiRuntime({ directRuntime: direct, ownsDirect: () => true,
        callFollowerApi: async () => assert.fail("Direct callback authority never crosses IPC") });
      const defaultDirect = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:abc",
        targetActivity: createTelegramApiTargetActivityRuntime(),
        recordRuntimeEvent(_kind, error) { events.push(error); } });
      const defaultBus = createTelegramBusAwareApiRuntime({ directRuntime: defaultDirect, ownsDirect: () => true,
        callFollowerApi: async () => assert.fail("Default direct callback authority never crosses IPC") });
      try {
        const request = surface === "helper" ? answerTelegramCallbackQuery("123:abc", "captured-query", "✅ Saved", options)
          : (surface === "client" ? client : surface === "direct" ? direct : surface === "bus-direct" ? bus
            : surface === "default-direct" ? defaultDirect : defaultBus)
            .answerCallbackQuery("captured-query", "✅ Saved", options);
        if (boundary === "current") await request;
        else await assert.rejects(request, (error: unknown) => {
          assert.ok(error instanceof TelegramApiAuthorityError);
          assert.equal(error.requestIssued, boundary !== "entry");
          assert.doesNotMatch(error.message, /secret fixture context/);
          return true;
        });
        assert.equal(calls, boundary === "entry" ? 0 : 1, "Refused authority cannot report success or replay a toast");
        assert.deepEqual(bodies, boundary === "entry" ? [] : [{ callback_query_id: "captured-query",
          text: "✅ Saved" }], "A local closure is never part of the Bot API body");
        if (surface !== "helper" && surface !== "client" && boundary !== "current") {
          assert.equal(events.length, 1);
          assert.ok(events[0] instanceof TelegramApiAuthorityError, "The direct owner still records the refusal");
        }
      } finally { restoreFetch(); }
    });
  }
}

test("Typed callback authority captures its guard before the client token observation", async () => {
  let current = true, calls = 0;
  const options: Pick<TelegramApiCallOptions, "assertAuthority"> = {
    assertAuthority() { if (!current) throw new Error("Original recipient lost"); },
  };
  const client = createTelegramApiClient(() => { current = false; options.assertAuthority = () => {}; return "123:abc"; });
  const restoreFetch = setTestFetch(async () => { calls++; return createApiJsonResponse(true); });
  try {
    await assert.rejects(client.answerCallbackQuery("captured-query", "Saved", options),
      { name: "TelegramApiAuthorityError", requestIssued: false });
    assert.equal(calls, 0);
  } finally { restoreFetch(); }
});

for (const guarded of [false, true]) {
  test(`Typed callback authority retains best-effort nonauthority failure diagnostics (guarded=${guarded})`, async () => {
    let calls = 0;
    const events: unknown[] = [];
    const runtime = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:abc",
      recordRuntimeEvent(_kind, error) { events.push(error); } });
    const restoreFetch = setTestFetch(async () => { calls++; return createApiErrorResponse(400, "Query expired"); });
    try {
      await runtime.answerCallbackQuery("captured-query", "Saved", guarded ? { assertAuthority() {} } : undefined);
      assert.equal(calls, 1);
      assert.equal(events.length, 1, "The existing diagnostic owner records once without retrying");
      assert.ok(events[0] instanceof Error);
      assert.match(events[0].message, /Query expired/);
    } finally { restoreFetch(); }
  });
}

for (const boundary of ["entry", "encoding"] as const) {
  test(`Per-call API authority refuses JSON ${boundary} loss before issuance`, async () => {
    let current = boundary !== "entry", calls = 0;
    const restoreFetch = setTestFetch(async () => { calls++; return createApiJsonResponse(true); });
    try {
      await assert.rejects(callTelegram("123:abc", "sendMessage", {
        chat_id: 7, message_thread_id: 42,
        toJSON() { current = false; return { chat_id: 7, message_thread_id: 42 }; },
      }, { assertAuthority() { if (!current) throw createSyntheticFetchFailure(); } }),
      { name: "TelegramApiAuthorityError", requestIssued: false });
      assert.equal(calls, 0);
    } finally { restoreFetch(); }
  });
}

for (const boundary of ["transport", "parsing"] as const) {
  test(`Per-call API authority refuses acknowledged success after ${boundary} loss`, async () => {
    let current = true, calls = 0, sleeps = 0;
    const restoreFetch = setTestFetch(async () => {
      calls++;
      const response = createApiJsonResponse(true);
      if (boundary === "transport") { await Promise.resolve(); current = false; }
      else response.text = async () => { await Promise.resolve(); current = false; return JSON.stringify({ ok: true, result: true }); };
      return response;
    });
    try {
      const error = await callTelegram("123:abc", "editMessageText", { chat_id: 7, message_thread_id: 42 }, {
        assertAuthority() { if (!current) throw createSyntheticFetchFailure(); },
        sleep: async () => { sleeps++; },
      }).catch((error: unknown) => error);
      assert.ok(error instanceof TelegramApiAuthorityError);
      assert.equal(error.requestIssued, true);
      assert.equal(isTelegramApiCommitUnknownError(error), false);
      assert.equal(isTelegramApiRequestRejected(error, "editMessageText"), false);
      assert.equal(getTelegramApiErrorRequestTarget(error), undefined, "Authority refusal is not stale-target evidence.");
      assert.equal(calls, 1);
      assert.equal(sleeps, 0);
    } finally { restoreFetch(); }
  });
}

test("Per-call API authority captures its guard before asynchronous response work", async () => {
  let current = true, calls = 0;
  const options: TelegramApiCallOptions = { assertAuthority() { if (!current) throw new Error("recipient replaced"); } };
  const restoreFetch = setTestFetch(async () => {
    calls++;
    await Promise.resolve();
    current = false;
    options.assertAuthority = () => {};
    return createApiJsonResponse(true);
  });
  try {
    await assert.rejects(callTelegram("123:abc", "sendMessage", {}, options),
      { name: "TelegramApiAuthorityError", requestIssued: true });
    assert.equal(calls, 1);
  } finally { restoreFetch(); }
});

for (const status of [429, 503]) {
  test(`Per-call API authority loss during HTTP ${status} wait cannot reissue`, async () => {
    let current = true, calls = 0, sleeps = 0;
    const restoreFetch = setTestFetch(async () => { calls++; return createApiErrorResponse(status, "rejected"); });
    try {
      await assert.rejects(callTelegram("123:abc", status === 429 ? "sendMessage" : "editMessageText", {}, {
        assertAuthority() { if (!current) throw new Error("recipient replaced"); },
        sleep: async () => { sleeps++; await Promise.resolve(); current = false; },
      }), { name: "TelegramApiAuthorityError", requestIssued: true });
      assert.equal(calls, 1);
      assert.equal(sleeps, 1);
    } finally { restoreFetch(); }
  });
}

for (const revoke of [false, true]) {
  test(`Per-call API authority ${revoke ? "refuses revoked" : "permits current"} IPv4 fallback`, async () => {
    let current = true, calls = 0, fallbackCalls = 0;
    const restoreEnv = setApiTestNetworkFamily("ipv4-fallback");
    const restoreFetch = setTestFetch(async () => { calls++; current = !revoke; throw createSyntheticFetchFailure(); });
    const restoreHttpsFetch = setTelegramApiHttpsFetchForTesting(async () => { fallbackCalls++; return createApiJsonResponse(true); });
    try {
      const request = callTelegram("123:abc", "editMessageText", {}, {
        maxAttempts: 1, assertAuthority() { if (!current) throw createSyntheticFetchFailure(); },
      });
      if (revoke) await assert.rejects(request, { name: "TelegramApiAuthorityError", requestIssued: true });
      else assert.equal(await request, true);
      assert.equal(calls, 1);
      assert.equal(fallbackCalls, revoke ? 0 : 1);
    } finally { restoreHttpsFetch(); restoreFetch(); restoreEnv(); }
  });
}

for (const boundary of ["entry", "blob", "encoding"] as const) {
  test(`Per-call API authority refuses multipart ${boundary} loss before issuance`, async () => {
    let current = boundary !== "entry", opens = 0, calls = 0;
    const originalOpen = nativeFileSystem.openAsBlob;
    const options: TelegramApiCallOptions = { assertAuthority() { if (!current) throw createSyntheticFetchFailure(); } };
    const restoreEnv = setApiTestNetworkFamily("ipv4");
    const restoreHttpsFetch = setTelegramApiHttpsFetchForTesting(async () => { calls++; return createApiJsonResponse(true); });
    nativeFileSystem.openAsBlob = async () => {
      opens++;
      await Promise.resolve();
      if (boundary === "blob") current = false;
      options.assertAuthority = () => {};
      const blob = new Blob(["selected recipient data"]);
      const arrayBuffer = blob.arrayBuffer.bind(blob);
      blob.arrayBuffer = async () => { const result = await arrayBuffer(); current = false; return result; };
      return blob;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(callTelegramMultipart("123:abc", "sendDocument", { chat_id: "7" },
        "document", "/not-a-real-file", "fixture.txt", options),
      { name: "TelegramApiAuthorityError", requestIssued: false });
      assert.equal(opens, boundary === "entry" ? 0 : 1);
      assert.equal(calls, 0);
    } finally {
      nativeFileSystem.openAsBlob = originalOpen;
      syncBuiltinESMExports();
      restoreHttpsFetch(); restoreEnv();
    }
  });
}

for (const revoke of [false, true]) {
  test(`Per-call API authority survives actual client activity/Workspace adapters with ${revoke ? "revoked" : "current"} recipient`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-telegram-api-authority-"));
    let current = true, calls = 0, observedLease = false;
    const ledger = createTelegramWorkspaceAdmissionLedger({ path: join(dir, "admission.json"), profileKey: "profile:api-authority",
      owner: { processId: process.pid, processBirthId: `${process.pid}:api-authority` }, getProcessLiveness: () => "alive" });
    const activity = createTelegramApiTargetActivityRuntime();
    const restoreFetch = setTestFetch(async () => {
      calls++;
      observedLease = ledger.read().leases.length === 1;
      assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 42 }), true);
      return createApiJsonResponse({ message_id: 17 });
    });
    const client = createTelegramApiTargetTrackingClient(createTelegramApiWorkspaceAdmissionClient(createTelegramApiClient(() => "123:abc"), {
      acquireAdmission(input) { const result = ledger.acquireAdmission(input); current = !revoke; return result; },
      releaseAdmission: ledger.releaseAdmission,
    }), activity);
    try {
      const request = client.call("sendMessage", { chat_id: 7, message_thread_id: 42, text: "menu" }, {
        assertAuthority() { if (!current) throw new Error("recipient replaced"); },
      });
      if (revoke) await assert.rejects(request, { name: "TelegramApiAuthorityError", requestIssued: false });
      else assert.deepEqual(await request, { message_id: 17 });
      assert.equal(calls, revoke ? 0 : 1);
      assert.equal(observedLease, !revoke);
      assert.deepEqual(ledger.read().leases, []);
      assert.equal(activity.hasPendingTarget({ chatId: 7, threadId: 42 }), false);
    } finally { restoreFetch(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("Non-idempotent Telegram API calls retry explicit 429 but report 5xx commit unknown", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    if (calls === 1) {
      return createApiErrorResponse(
        429,
        "Too Many Requests",
        new Headers({ "retry-after": "2" }),
      );
    }
    if (calls === 2) {
      return createApiErrorResponse(502, "Bad Gateway");
    }
    return createApiJsonResponse("sent");
  });
  try {
    await assert.rejects(
      () =>
        callTelegram<string>("123:abc", "sendMessage", {}, {
          retryBaseDelayMs: 10,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }),
      (error) =>
        isTelegramApiCommitUnknownError(error) &&
        error.method === "sendMessage",
    );
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [2000]);
  } finally {
    restoreFetch();
  }
});

test("Retry-safe Telegram API methods replay 5xx responses", async () => {
  let calls = 0;
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    return calls === 1
      ? createApiErrorResponse(502, "Bad Gateway")
      : createApiJsonResponse("edited");
  });
  try {
    assert.equal(
      await callTelegram<string>(
        "123:abc",
        "editMessageText",
        {},
        { retryBaseDelayMs: 0, sleep: async () => {} },
      ),
      "edited",
    );
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});

test("Rate-limit retry waits record the method and duration before the pause", async () => {
  const events: Array<{
    kind: string;
    message: string;
    details?: Record<string, unknown>;
  }> = [];
  let calls = 0;
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    return calls === 1
      ? createApiErrorResponse(
          429,
          "Too Many Requests",
          new Headers({ "retry-after": "2" }),
        )
      : createApiJsonResponse(true);
  });
  try {
    const client = createTelegramApiClient(() => "123:abc", {
      recordRuntimeEvent: (kind, error, details) => {
        events.push({
          kind,
          message: error instanceof Error ? error.message : String(error),
          ...(details ? { details } : {}),
        });
      },
    });
    assert.equal(
      await client.call<boolean>("editMessageText", {}, {
        sleep: async () => {},
      }),
      true,
    );
    assert.equal(calls, 2);
    assert.deepEqual(events, [
      {
        kind: "api",
        message:
          "Telegram API rate limit: waiting 2000 ms before retrying editMessageText",
        details: {
          phase: "retry-wait",
          method: "editMessageText",
          waitMs: 2000,
          attempt: 0,
          retryAfterSeconds: 2,
        },
      },
    ]);
  } finally {
    restoreFetch();
  }
});

test("5xx retry waits stay out of the rate-limit event stream", async () => {
  const events: unknown[] = [];
  let calls = 0;
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    return calls === 1
      ? createApiErrorResponse(500, "Server Error")
      : createApiJsonResponse(true);
  });
  try {
    const client = createTelegramApiClient(() => "123:abc", {
      recordRuntimeEvent: () => {
        events.push(true);
      },
    });
    assert.equal(
      await client.call<boolean>("editMessageText", {}, {
        retryBaseDelayMs: 0,
        sleep: async () => {},
      }),
      true,
    );
    assert.deepEqual(events, []);
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});

test("Telegram API retry waits settle immediately when their owner aborts", async () => {
  const controller = new AbortController();
  const reason = { kind: "polling-request-expired" };
  let calls = 0;
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    if (calls === 1) {
      setTimeout(() => controller.abort(reason), 0);
      return createApiErrorResponse(502, "Bad Gateway");
    }
    return createApiJsonResponse("unexpected replay");
  });
  try {
    await assert.rejects(
      () =>
        callTelegram<string>("123:abc", "getMe", {}, {
          signal: controller.signal,
          retryBaseDelayMs: 10_000,
        }),
      (error) => error === reason,
    );
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

test("Retry-safe Telegram API transport falls back to IPv4 once", async () => {
  const familySeen: boolean[] = [];
  let calls = 0;
  const restoreEnv = setApiTestNetworkFamily("ipv4-fallback");
  const restoreFetch = setTestFetch(async () => {
    calls += 1;
    familySeen.push(false);
    throw createSyntheticFetchFailure();
  });
  const restoreHttpsFetch = setTelegramApiHttpsFetchForTesting(
    async (_input, _init, family) => {
      calls += 1;
      familySeen.push(hasApiTestFamily(family));
      return createApiJsonResponse("sent");
    },
  );
  try {
    assert.equal(
      await callTelegram<string>(
        "123:abc",
        "editMessageText",
        {},
        {
          maxAttempts: 1,
        },
      ),
      "sent",
    );
    assert.equal(calls, 2);
    assert.deepEqual(familySeen, [false, true]);
  } finally {
    restoreHttpsFetch();
    restoreFetch();
    restoreEnv();
  }
});

test("Telegram API HTTP errors retain only the exact threaded request target", async () => {
  const restoreFetch = setTestFetch(async () => {
    return createApiErrorResponse(400, "Bad Request: message thread not found");
  });
  try {
    const error = await callTelegram(
      "123:abc",
      "sendMessage",
      {
        chat_id: 42,
        message_thread_id: 7,
        text: "private payload",
      },
      { maxAttempts: 1 },
    ).catch((failure: unknown) => failure);
    assert.deepEqual(getTelegramApiErrorRequestTarget(error), {
      chatId: 42,
      threadId: 7,
    });
    assert.doesNotMatch(String(error), /private payload/u);
  } finally {
    restoreFetch();
  }
});

test("Telegram API stale-looking HTTP 500 errors remain transient", async () => {
  const restoreFetch = setTestFetch(async () => {
    return createApiErrorResponse(500, "message thread not found");
  });
  try {
    const error = await callTelegram(
      "123:abc",
      "sendChatAction",
      { chat_id: 42, message_thread_id: 7, action: "typing" },
      { maxAttempts: 1 },
    ).catch((failure: unknown) => failure);
    assert.equal(isTelegramTopicTargetStaleError(error), false);
    assert.deepEqual(getTelegramApiErrorRequestTarget(error), {
      chatId: 42,
      threadId: 7,
    });
  } finally {
    restoreFetch();
  }
});

test("Telegram API transport does not IPv4-fallback retry HTTP 400", async () => {
  const familySeen: boolean[] = [];
  const restoreEnv = setApiTestNetworkFamily("ipv4-fallback");
  const restoreFetch = setTestFetch(async () => {
    familySeen.push(false);
    return createApiErrorResponse(400, "Bad Request");
  });
  try {
    await assert.rejects(
      () => callTelegram("123:abc", "sendMessage", {}, { maxAttempts: 1 }),
      {
        message: "Telegram API sendMessage failed: HTTP 400: Bad Request",
      },
    );
    assert.deepEqual(familySeen, [false]);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("Telegram multipart transport failure reports commit unknown without fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-upload-fallback-"));
  const filePath = join(tempDir, "demo.txt");
  await writeFile(filePath, "hello", "utf8");
  const formStates: string[] = [];
  const forms = new Set<FormData>();
  let calls = 0;
  const restoreEnv = setApiTestNetworkFamily("ipv4-fallback");
  const restoreFetch = setTestFetch(async (_input, init) => {
    calls += 1;
    const form = init?.body as FormData;
    forms.add(form);
    formStates.push(
      `auto:${form.get("document") instanceof Blob ? "blob" : "missing"}`,
    );
    throw createSyntheticFetchFailure();
  });
  const restoreHttpsFetch = setTelegramApiHttpsFetchForTesting(
    async (_input, init, family) => {
      calls += 1;
      formStates.push(
        `${hasApiTestFamily(family) ? "ipv4" : "auto"}:${
          init.body instanceof Uint8Array ? "buffer" : "missing"
        }`,
      );
      return createApiJsonResponse(true);
    },
  );
  try {
    await assert.rejects(
      () =>
        callTelegramMultipart<boolean>(
          "123:abc",
          "sendDocument",
          { chat_id: "1" },
          "document",
          filePath,
          "demo.txt",
          { maxAttempts: 1 },
        ),
      (error) => isTelegramApiCommitUnknownError(error),
    );
    assert.deepEqual(formStates, ["auto:blob"]);
    assert.equal(forms.size, 1);
    assert.equal(calls, 1);
  } finally {
    restoreHttpsFetch();
    restoreFetch();
    restoreEnv();
  }
});

test("Telegram file downloads use transport fallback for file content", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-download-fallback-"),
  );
  const calls: string[] = [];
  const restoreEnv = setApiTestNetworkFamily("ipv4-fallback");
  const restoreFetch = setTestFetch(async (input) => {
    const url = getApiTestFetchUrl(input);
    if (url.includes("/getFile")) {
      return createApiJsonResponse({ file_path: "files/demo" });
    }
    calls.push("auto");
    throw createSyntheticFetchFailure();
  });
  const restoreHttpsFetch = setTelegramApiHttpsFetchForTesting(
    async (_input, _init, family) => {
      calls.push(hasApiTestFamily(family) ? "ipv4" : "auto");
      return new Response("hello", { status: 200 });
    },
  );
  try {
    const path = await downloadTelegramFile(
      "123:abc",
      "file-id",
      "demo.txt",
      tempDir,
    );
    assert.deepEqual(calls, ["auto", "ipv4"]);
    assert.equal(await readFile(path, "utf8"), "hello");
  } finally {
    restoreHttpsFetch();
    restoreFetch();
    restoreEnv();
  }
});

test("Telegram transport diagnostics serialize nested fetch causes", async () => {
  const events: Array<Record<string, unknown>> = [];
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/tmp/telegram",
    maxFileSizeBytes: 123,
    tempFileMaxAgeMs: 60_000,
    recordRuntimeEvent: (_kind, _error, details) => {
      events.push(details ?? {});
    },
    client: createApiRuntimeClient({
      call: async () => {
        throw createSyntheticFetchFailure();
      },
    }),
  });
  await assert.rejects(() => runtime.call("sendMessage", {}), {
    message: "fetch failed",
  });
  assert.deepEqual(events, [
    {
      method: "sendMessage",
      transport: {
        error: { name: "TypeError", message: "fetch failed" },
        cause: { name: "AggregateError", message: "connect failed" },
        attempts: [
          {
            name: "Error",
            code: "ENETUNREACH",
            address: "2a0a:f280::1",
            port: 443,
            family: 6,
          },
          {
            name: "Error",
            code: "ETIMEDOUT",
            address: "149.154.167.220",
            port: 443,
            family: 4,
          },
        ],
      },
    },
  ]);
});

test("Telegram multipart 5xx reports commit unknown without replay", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-upload-"));
  const filePath = join(tempDir, "demo.txt");
  await writeFile(filePath, "hello", "utf8");
  const contentTypes: string[] = [];
  let calls = 0;
  const restoreFetch = setTestFetch(async (_input, init) => {
    calls += 1;
    contentTypes.push(
      (init?.body as FormData).get("document") instanceof Blob
        ? "blob"
        : "missing",
    );
    if (calls === 1) {
      return createApiErrorResponse(500, "Server Error");
    }
    return createApiJsonResponse(true);
  });
  try {
    await assert.rejects(
      () =>
        callTelegramMultipart<boolean>(
          "123:abc",
          "sendDocument",
          { chat_id: "1" },
          "document",
          filePath,
          "demo.txt",
          { retryBaseDelayMs: 0, sleep: async () => {} },
        ),
      (error) => isTelegramApiCommitUnknownError(error),
    );
    assert.equal(calls, 1);
    assert.deepEqual(contentTypes, ["blob"]);
  } finally {
    restoreFetch();
  }
});

test("Telegram file downloads use deterministic sanitized names published by rename", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-download-"));
  const restoreFetch = setTestFetch(async (input) => {
    const url = getApiTestFetchUrl(input);
    if (url.includes("/getFile")) {
      return createApiJsonResponse({ file_path: "files/demo" });
    }
    return new Response("hello", { status: 200 });
  });
  try {
    const path = await downloadTelegramFile(
      "123:abc",
      "file-id",
      "bad name?.txt",
      tempDir,
    );
    assert.equal(path, join(tempDir, "bad_name_.txt"));
    assert.equal(await readFile(path, "utf8"), "hello");
    assert.deepEqual(await readdir(tempDir), ["bad_name_.txt"], "no partial file remains after publication");
    if (process.platform !== "win32") {
      assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    restoreFetch();
  }
});

test("Telegram file downloads reject files above configured limits", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-download-limit-"));
  let calls = 0;
  const restoreFetch = setTestFetch(async (input) => {
    calls += 1;
    const url = getApiTestFetchUrl(input);
    if (url.includes("/getFile")) {
      return createApiJsonResponse({ file_path: "files/demo", file_size: 10 });
    }
    return new Response("too large", { status: 200 });
  });
  try {
    await assert.rejects(
      () =>
        downloadTelegramFile("123:abc", "file-id", "demo.txt", tempDir, {
          maxFileSizeBytes: 5,
        }),
      { message: "Telegram file exceeds size limit (10 bytes > 5 bytes)" },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    restoreFetch();
  }
});

for (const method of ["sendMessage", "sendRichMessage", "sendPhoto", "sendVoice", "sendMediaGroup", "copyMessage", "copyMessages", "forwardMessage", "forwardMessages", "sendMessageDraft", "sendRichMessageDraft", "sendChatAction"]) {
  test(`Threaded Bot API refuses output to All before transport (${method})`, async () => {
    let calls = 0, threaded = true;
    const restoreFetch = setTestFetch(async () => { calls++; return createApiJsonResponse({ message_id: 1 }); });
    const runtime = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", isThreadedMode: () => threaded, recordRuntimeEvent() {} });
    try {
      for (const message_thread_id of [undefined, 0, "0", "", true, -1]) await assert.rejects(
        runtime.call(method, { chat_id: "0007", message_thread_id, text: "output", action: "typing" }), /All is input-only/);
      assert.equal(calls, 0);
      await runtime.call(method, { chat_id: 7, message_thread_id: 42, text: "temporary/bound Thread", action: "typing" });
      await runtime.call(method, { chat_id: "@channel_name", text: "explicit channel" });
      threaded = false;
      await runtime.call(method, { chat_id: 7, text: "classic DM" });
      assert.equal(calls, 3);
    } finally { restoreFetch(); }
  });
}

test("Threaded multipart refuses All before file access and fences mode change before upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-output-policy-")), path = join(dir, "voice.ogg");
  let calls = 0, threaded = true;
  const restoreFetch = setTestFetch(async () => { calls++; return createApiJsonResponse(true); });
  const runtime = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", isThreadedMode: () => threaded, recordRuntimeEvent() {} });
  try {
    await assert.rejects(runtime.callMultipart("sendVoice", { chat_id: "7" }, "voice", join(dir, "missing"), "voice.ogg"), /All is input-only/);
    await writeFile(path, "voice fixture");
    threaded = false;
    const pending = runtime.callMultipart("sendVoice", { chat_id: "7" }, "voice", path, "voice.ogg");
    threaded = true;
    await assert.rejects(pending, /authority/i); assert.equal(calls, 0);
    await runtime.callMultipart("sendVoice", { chat_id: "7", message_thread_id: "42" }, "voice", path, "voice.ogg");
    assert.equal(calls, 1);
  } finally { restoreFetch(); await rm(dir, { recursive: true, force: true }); }
});

test("Threaded policy preserves non-output operations and cannot be evaded by a reply anchor or caller guard", async () => {
  let calls = 0;
  const restoreFetch = setTestFetch(async () => { calls++; return createApiJsonResponse(true); });
  const client = createTelegramApiClient(() => "123:fixture", { isThreadedMode: () => true });
  try {
    await assert.rejects(client.call("sendMessage", { chat_id: 7, text: "All", reply_parameters: { message_id: 1, message_thread_id: 42 } }, { assertAuthority() {} }), /All is input-only/);
    for (const method of ["deleteMessage", "answerCallbackQuery", "getMe", "createForumTopic", "deleteForumTopic"]) await client.call(method, { chat_id: 7 });
    await client.call("sendMessage", { chat_id: 7, business_connection_id: "business", text: "separate namespace" });
    assert.equal(calls, 6);
  } finally { restoreFetch(); }
});

test("Threaded policy stops a classic output retry after mode changes", async () => {
  let threaded = false, calls = 0;
  const restoreFetch = setTestFetch(async () => { calls++; threaded = true; return createApiJsonResponse(true); });
  const client = createTelegramApiClient(() => "123:fixture", { isThreadedMode: () => threaded });
  try {
    await assert.rejects(client.call("sendMessage", { chat_id: 7, text: "classic" }, { maxAttempts: 3 }), /authority/i);
    assert.equal(calls, 1);
  } finally { restoreFetch(); }
});

test("Telegram streaming downloads remove partial files after limit failures", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-download-partial-"),
  );
  const restoreFetch = setTestFetch(async (input) => {
    const url = getApiTestFetchUrl(input);
    if (url.includes("/getFile")) {
      return createApiJsonResponse({ file_path: "files/demo" });
    }
    return new Response("too large", { status: 200 });
  });
  try {
    await assert.rejects(
      () =>
        downloadTelegramFile("123:abc", "file-id", "demo.txt", tempDir, {
          maxFileSizeBytes: 5,
        }),
      { message: "Telegram file exceeds size limit (9 bytes > 5 bytes)" },
    );
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    restoreFetch();
  }
});

test("Telegram API helpers reject malformed successful responses", async () => {
  const restoreFetch = setTestFetch(async () => {
    return createMalformedApiTextResponse("not json");
  });
  try {
    await assert.rejects(() => callTelegram("123:abc", "getMe", {}), {
      message: "Telegram API getMe returned invalid JSON",
    });
  } finally {
    restoreFetch();
  }
});

test("Non-idempotent malformed success becomes commit-unknown", async () => {
  const restoreFetch = setTestFetch(async () =>
    createMalformedApiTextResponse("not json"),
  );
  try {
    await assert.rejects(
      () =>
        callTelegram("123:abc", "createForumTopic", {}, {
          maxAttempts: 1,
        }),
      isTelegramApiCommitUnknownError,
    );
  } finally {
    restoreFetch();
  }
});

test("answerTelegramCallbackQuery records Telegram API failures without throwing", async () => {
  const events: Array<Record<string, unknown>> = [];
  const restoreFetch = setTestFetch(async () => {
    throw new Error("network down");
  });
  try {
    await assert.doesNotReject(() =>
      answerTelegramCallbackQuery("123:abc", "callback-id", "ok", {
        recordRuntimeEvent: (kind, error, details) => {
          events.push({
            kind,
            message: error instanceof Error ? error.message : String(error),
            details,
          });
        },
      }),
    );
    assert.deepEqual(events, [
      {
        kind: "api",
        message: "network down",
        details: { method: "answerCallbackQuery" },
      },
    ]);
  } finally {
    restoreFetch();
  }
});

test("Default Telegram bridge API runtime binds lazy token client and defaults", async () => {
  const calls: string[] = [];
  const restoreFetch = setTestFetch(async (input) => {
    calls.push(getApiTestFetchUrl(input));
    return createApiJsonResponse(true);
  });
  try {
    const runtime = createDefaultTelegramBridgeApiRuntime({
      getBotToken: () => "123:abc",
      recordRuntimeEvent: () => {},
    });
    assert.equal(await runtime.sendTypingAction(7), true);
    assert.match(calls[0] ?? "", /bot123:abc\/sendChatAction$/);
  } finally {
    restoreFetch();
  }
});

test("Workspace deletion requires executor authority and never retries transport or ambiguous success", async () => {
  let requests = 0;
  let outcome: "success" | "false" | "absent" | "network" = "success";
  const previousFamily = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  process.env.PI_TELEGRAM_NETWORK_FAMILY = "ipv4-fallback";
  const restoreFetch = setTestFetch(async (input) => {
    requests++;
    assert.match(getApiTestFetchUrl(input), /deleteForumTopic$/);
    if (outcome === "network") throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    if (outcome === "absent") return createApiErrorResponse(400, "Bad Request: message thread not found");
    return createApiJsonResponse(outcome === "success");
  });
  const runtime = createDefaultTelegramBridgeApiRuntime({
    getBotToken: () => "123:abc", recordRuntimeEvent() {},
    workspaceAdmission: { acquireAdmission: () => ({ kind: "blocked", reason: "retirement-fenced" }),
      releaseAdmission: () => { throw new Error("no ordinary lease"); } },
  });
  const authorize = () => ({ chatId: 7, threadId: 42 });
  try {
    await assert.rejects(runtime.call("deleteForumTopic", { chat_id: 7, message_thread_id: 42 }), /unavailable/);
    await assert.rejects(runtime.deleteWorkspaceThread(() => { throw new Error("stale permit"); }), /stale permit/);
    assert.equal(requests, 0);
    await runtime.deleteWorkspaceThread(authorize);
    assert.equal(requests, 1);
    outcome = "false";
    await assert.rejects(runtime.deleteWorkspaceThread(authorize), /not confirmed/);
    assert.equal(requests, 2);
    outcome = "absent";
    await assert.rejects(runtime.deleteWorkspaceThread(authorize), (error) =>
      error instanceof Error && "status" in error && error.status === 400);
    assert.equal(requests, 3);
    outcome = "network";
    await assert.rejects(runtime.deleteWorkspaceThread(authorize));
    assert.equal(requests, 4);
  } finally {
    restoreFetch();
    if (previousFamily === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
    else process.env.PI_TELEGRAM_NETWORK_FAMILY = previousFamily;
  }
});

test("Request rejection requires matching method and parsed Telegram no-effect response evidence", async () => {
  for (const [status, code, ok, rejected] of [
    [400, 400, false, true], [401, 401, false, true], [403, 403, false, true],
    [404, 404, false, true], [429, 429, false, true], [408, 408, false, false],
    [500, 500, false, false], [429, 400, false, false], [429, "429", false, false],
    [429, 429, true, false], [429, undefined, false, false],
  ] as const) {
    const restore = setTestFetch(async () => new Response(JSON.stringify({
      ok, error_code: code, description: "fixture rejection",
    }), { status }));
    try {
      const api = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
      await assert.rejects(api.deleteWorkspaceThread(() => ({ chatId: 7, threadId: 42 })), error => {
        assert.equal(isTelegramApiRequestRejected(error, "deleteForumTopic"), rejected);
        assert.equal(isTelegramApiRequestRejected(error, "sendMessage"), false);
        assert.equal(isTelegramApiRequestRejected(error, undefined as unknown as string), false);
        return true;
      });
    } finally { restore(); }
  }
  assert.equal(isTelegramApiRequestRejected(Object.assign(new Error("rejected"), {
    status: 429, rejectedRequestMethod: "deleteForumTopic",
  }), "deleteForumTopic"), false);
});

test("Default Telegram bridge API runtime applies optional Workspace admission", async () => {
  let activeLease:
    | {
        operationId: string;
        operationKind: string;
        profileKey: string;
        scope:
          | { kind: "target"; target: { chatId: number; threadId: number } }
          | { kind: "chat"; chatId: number }
          | { kind: "profile" };
        owner: { processId: number; processBirthId: string };
        acquiredAtMs: number;
      }
    | undefined;
  const restoreFetch = setTestFetch(async () => {
    assert.equal(activeLease?.operationKind, "api.sendChatAction");
    assert.deepEqual(activeLease?.scope, { kind: "chat", chatId: 7 });
    return createApiJsonResponse(true);
  });
  try {
    const runtime = createDefaultTelegramBridgeApiRuntime({
      getBotToken: () => "123:abc",
      recordRuntimeEvent: () => {},
      workspaceAdmission: {
        acquireAdmission(input) {
          activeLease = {
            ...input,
            profileKey: "profile:api",
            owner: {
              processId: process.pid,
              processBirthId: `${process.pid}:api-admission-test`,
            },
            acquiredAtMs: 1,
          };
          return { kind: "acquired", lease: activeLease, resumed: false };
        },
        releaseAdmission(expected) {
          assert.deepEqual(expected, activeLease);
          activeLease = undefined;
          return true;
        },
      },
    });
    assert.equal(await runtime.sendTypingAction(7), true);
    assert.equal(activeLease, undefined);
  } finally {
    restoreFetch();
  }
});

test("Default Telegram bridge API runtime honors PI_CODING_AGENT_DIR for temp files", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-agent-dir-"));
  const tempDir = resolve(agentDir, "tmp", "pi-telegram", "attachments");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const runtime = createDefaultTelegramBridgeApiRuntime({
      getBotToken: () => "123:abc",
      recordRuntimeEvent: () => {},
    });
    assert.equal(await runtime.prepareTempDir(), 0);
    assert.deepEqual(await readdir(tempDir), []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("Telegram bridge API runtime prepares its configured temp directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "telegram-runtime-temp-"));
  const staleFile = join(
    tempDir,
    "00000000-0000-4000-8000-000000000004-stale.txt",
  );
  await writeFile(staleFile, "old");
  const oldDate = new Date(Date.now() - 2_000);
  await utimes(staleFile, oldDate, oldDate);
  const runtime = createTelegramBridgeApiRuntime({
    tempDir,
    maxFileSizeBytes: 123,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {},
    client: createApiRuntimeClient({
      downloadFile: async () => staleFile,
    }),
  });
  assert.equal(await runtime.prepareTempDir(), 1);
  assert.deepEqual(await readdir(tempDir), []);
});

test("Telegram bridge API runtime names attachments from their source and the live bot scope", async () => {
  const names: string[] = [];
  let scope: string | undefined = "@my_bot";
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/tmp/pi-telegram/attachments",
    maxFileSizeBytes: 123,
    tempFileMaxAgeMs: 60_000,
    getBotScope: () => scope,
    recordRuntimeEvent: () => {},
    client: createApiRuntimeClient({
      downloadFile: async (_fileId, suggestedName) => { names.push(suggestedName); return `/tmp/${suggestedName}`; },
    }),
  });
  await runtime.downloadFile("a", "voice-1.ogg", { kind: "voice", messageId: 1, chat: { id: 7, type: "private" } });
  scope = "8502475096";
  await runtime.downloadFile("b", "voice-1.ogg", { kind: "voice", messageId: 1, chat: { id: 7, type: "private" } });
  await runtime.downloadFile("c", "voice-1.ogg", { kind: "voice", messageId: 1, chat: { id: -1009, type: "supergroup", username: "team" } });
  await runtime.downloadFile("d", "legacy.bin");
  assert.deepEqual(names, ["voice-my_bot-1.ogg", "voice-8502475096-1.ogg", "voice-team-1.ogg", "legacy.bin"]);
});

test("Download publication bounds Windows sharing retries without refetching or hiding failure", async (t) => {
  const scenarios = [
    { platform: "win32", code: "EPERM", mode: "transient", attempts: 3 },
    { platform: "win32", code: "EACCES", mode: "transient", attempts: 3 },
    { platform: "win32", code: "EPERM", mode: "permanent", attempts: 6 },
    { platform: "linux", code: "EPERM", mode: "permanent", attempts: 1 },
    { platform: "win32", code: "ENOENT", mode: "permanent", attempts: 1 },
    { platform: "win32", code: "EPERM", mode: "cancel", attempts: 1 },
  ] as const;
  for (const scenario of scenarios) {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-download-sharing-"));
    const targetPath = join(tempDir, "voice-bot-9.ogg");
    await writeFile(targetPath, "previous complete payload");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const realRename = fileSystem.rename;
    const controller = new AbortController();
    const cancellation = new Error("Download cancelled during publication retry");
    const failure = Object.assign(new Error("File publication denied"), { code: scenario.code });
    let renameCalls = 0;
    const requests: string[] = [];
    const restoreFetch = setTestFetch(async (input) => {
      const url = getApiTestFetchUrl(input);
      requests.push(url.includes("/getFile") ? "metadata" : "content");
      if (url.includes("/getFile")) return createApiJsonResponse({ file_path: "files/demo" });
      return new Response("new complete payload", { status: 200 });
    });
    const renameMock = t.mock.method(fileSystem, "rename", async (...[source, target]: Parameters<typeof realRename>) => {
      renameCalls++;
      assert.equal(target, targetPath);
      assert.equal(await readFile(source, "utf8"), "new complete payload", "Only a complete part may be republished");
      if (scenario.mode === "transient" && renameCalls > 2) return realRename(source, target);
      if (scenario.mode === "cancel") setImmediate(() => controller.abort(cancellation));
      throw failure;
    });
    Object.defineProperty(process, "platform", { ...platform, value: scenario.platform });
    syncBuiltinESMExports();
    try {
      const operation = downloadTelegramFile("123:abc", "file-id", "voice-bot-9.ogg", tempDir,
        { signal: controller.signal });
      if (scenario.mode === "transient") {
        assert.equal(await operation, targetPath);
        assert.equal(await readFile(targetPath, "utf8"), "new complete payload");
      } else {
        await assert.rejects(operation, (error) => error === (scenario.mode === "cancel" ? cancellation : failure));
        assert.equal(await readFile(targetPath, "utf8"), "previous complete payload");
      }
      if (scenario.mode === "transient") assert.ok(renameCalls >= scenario.attempts && renameCalls <= 6);
      else assert.equal(renameCalls, scenario.attempts);
      assert.deepEqual(requests, ["metadata", "content"], "Publication retry must not replay HTTP");
      assert.deepEqual(await readdir(tempDir), ["voice-bot-9.ogg"], "Part cleanup also runs after exhaustion/cancellation");
    } finally {
      renameMock.mock.restore();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
      restoreFetch();
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("Concurrent downloads of one message publish one complete file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-download-race-"));
  const restoreFetch = setTestFetch(async (input) => {
    const url = getApiTestFetchUrl(input);
    if (url.includes("/getFile")) return createApiJsonResponse({ file_path: "files/demo" });
    return new Response("complete payload", { status: 200 });
  });
  try {
    const paths = await Promise.all([1, 2, 3].map(() => downloadTelegramFile("123:abc", "file-id", "voice-bot-9.ogg", tempDir)));
    assert.deepEqual(new Set(paths), new Set([join(tempDir, "voice-bot-9.ogg")]));
    assert.equal(await readFile(paths[0]!, "utf8"), "complete payload");
    assert.deepEqual(await readdir(tempDir), ["voice-bot-9.ogg"], "no partial file remains");
  } finally {
    restoreFetch();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Telegram bridge API runtime records structured failures", async () => {
  const events: Array<Record<string, unknown>> = [];
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/tmp/telegram",
    maxFileSizeBytes: 123,
    tempFileMaxAgeMs: 60_000,
    recordRuntimeEvent: (kind, error, details) => {
      events.push({
        kind,
        message: error instanceof Error ? error.message : String(error),
        details,
      });
    },
    client: createApiRuntimeClient({
      call: async () => {
        throw new Error("api failed");
      },
      callMultipart: async () => {
        throw new Error("multipart failed");
      },
      downloadFile: async (_fileId, _suggestedName, tempDir, options) => {
        events.push({ tempDir, maxFileSizeBytes: options?.maxFileSizeBytes });
        throw new Error("download failed");
      },
      answerCallbackQuery: async () => {
        throw new Error("answer failed");
      },
    }),
  });
  await assert.rejects(() => runtime.call("sendMessage", {}), {
    message: "api failed",
  });
  await assert.rejects(
    () =>
      runtime.callMultipart("sendDocument", {}, "document", "/tmp/a", "a.txt"),
    { message: "multipart failed" },
  );
  await assert.rejects(() => runtime.downloadFile("file-id", "demo.txt"), {
    message: "download failed",
  });
  await runtime.answerCallbackQuery("cb-1", "ok");
  assert.deepEqual(events, [
    {
      kind: "api",
      message: "api failed",
      details: { method: "sendMessage" },
    },
    {
      kind: "multipart",
      message: "multipart failed",
      details: { method: "sendDocument", fileName: "a.txt" },
    },
    { tempDir: "/tmp/telegram", maxFileSizeBytes: 123 },
    {
      kind: "download",
      message: "download failed",
      details: { suggestedName: "demo.txt" },
    },
    {
      kind: "api",
      message: "answer failed",
      details: { method: "answerCallbackQuery" },
    },
  ]);
});

for (const outcome of ["success", "rejected", "unknown"] as const) {
  test(`Guest ACK completion composes cached upload and inline edit (${outcome})`, async () => {
    const events: string[] = [];
    const restore = setTestFetch(async (input, init) => {
      const method = String(input).split("/").at(-1);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.inline_message_id, "inline");
      events.push(method!);
      if (method === "editMessageMedia") {
        assert.deepEqual(body.media, { type: "photo", media: "cached-photo", caption: "done" });
        if (outcome === "unknown") throw new Error("lost response");
        if (outcome === "rejected") return new Response(JSON.stringify({ ok: false, error_code: 400, description: "fixture rejection" }), { status: 400 });
      } else {
        assert.equal(method, "editMessageText");
        assert.match(body.rich_message.markdown, /could not deliver.*attachment/);
      }
      return new Response(JSON.stringify({ ok: true, result: true }));
    });
    try {
      const api = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
      const turn: PendingTelegramTurn = {
        kind: "prompt", chatId: 0, replyToMessageId: 0,
        queueOrder: 1, queueLane: "default", laneOrder: 1,
        content: [], historyText: "", sourceMessageIds: [], statusSummary: "guest",
        guestQueryId: "answered", guestInlineMessageId: "inline",
        queuedAttachments: [{ path: "photo.png", fileName: "photo.png" }],
      };
      await handleTelegramAgentEndRuntime({
        turn, assistant: { text: "done" }, foldQueuedPromptsIntoHistory: false,
        resetRuntimeState() {}, updateStatus() {}, clearPreview: async () => {},
        setPreviewPendingText() {}, finalizeMarkdownPreview: async () => false,
        dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
        sendMarkdownReply: async () => {}, sendTextReply: async () => {}, sendQueuedAttachments: async () => {},
        stopGuestPlaceholder: async () => { events.push("stop"); },
        editGuestReply: createGuestMarkdownReplyEditor({ editGuestInlineMessage: api.editGuestInlineMessage }),
        sendGuestAttachment: (captured, attachment, caption, options) => deliverTelegramGuestCachedAttachment({
          guestQueryId: captured.guestQueryId!, guestInlineMessageId: captured.guestInlineMessageId,
          stagingChatId: 7, stagingTarget: { chatId: 7, threadId: 9 }, attachment, caption,
          isDeliveryActive: options?.isDeliveryActive, editGuestInlineMessage: api.editGuestInlineMessage,
          sendMultipart: async () => { events.push("upload"); return { message_id: 11, photo: [{ file_id: "cached-photo" }] }; },
          answerGuestQuery: async () => assert.fail("Already answered"),
          deleteMessage: async () => { events.push("delete"); },
        }),
      });
      assert.deepEqual(events, ["stop", "upload", "editMessageMedia", "delete",
        ...(outcome === "rejected" ? ["editMessageText"] : []), "dispatch"]);
    } finally { restore(); }
  });
}

test("Guest inline media edits use cached media, exact authority and one checked acknowledgement", async () => {
  const calls: unknown[] = [];
  let current = true;
  let response: unknown = true;
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/tmp/telegram", maxFileSizeBytes: 123, tempFileMaxAgeMs: 60_000,
    recordRuntimeEvent() {},
    client: createApiRuntimeClient({
      call: async <T>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => {
        options?.assertAuthority?.();
        assert.equal(options?.maxAttempts, 1);
        assert.equal(options?.retryRateLimit, false);
        calls.push({ method, body });
        return response as T;
      },
    }),
  });
  const content = { media: { type: "photo" as const, media: "cached-id", caption: "caption" } };
  const options = { assertAuthority() { if (!current) throw new Error("retired"); } };
  await runtime.editGuestInlineMessage("inline-1", content, options);
  assert.deepEqual(calls, [{ method: "editMessageMedia", body: {
    inline_message_id: "inline-1", media: content.media,
  } }]);
  current = false;
  await assert.rejects(runtime.editGuestInlineMessage("inline-1", content, options), isTelegramApiCommitUnknownError);
  assert.equal(calls.length, 1);
  current = true;
  response = undefined;
  await assert.rejects(runtime.editGuestInlineMessage("inline-1", content, options), isTelegramApiCommitUnknownError);
});

test("Telegram bridge API runtime captures guest inline message ids and edits them", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/tmp/telegram",
    maxFileSizeBytes: 123,
    tempFileMaxAgeMs: 60_000,
    recordRuntimeEvent: () => {},
    client: createApiRuntimeClient({
      call: async <TResponse>(
        method: string,
        body: Record<string, unknown>,
      ) => {
        calls.push({ method, body });
        const inputContent = (
          (body.result as Record<string, unknown> | undefined)
            ?.input_message_content as Record<string, unknown> | undefined
        );
        return (inputContent?.message_text === "ack"
          ? { inline_message_id: "inline-42" }
          : true) as TResponse;
      },
    }),
  });
  assert.equal(
    await runtime.answerGuestQueryForInlineMessage("guest-1", "ack"),
    "inline-42",
  );
  assert.equal(
    await runtime.answerGuestQueryForInlineMessage(
      "guest-2",
      undefined,
      { richMessage: { markdown: "hi" } },
    ),
    undefined,
  );
  await runtime.editGuestInlineMessage("inline-42", {
    richMessage: { markdown: "**done**" },
  });
  await runtime.editGuestInlineMessage("inline-43", { text: "plain" });
  await runtime.editGuestInlineMessage("inline-44", {
    text: "<b>frame</b>",
    parseMode: "HTML",
  });
  assert.deepEqual(calls, [
    {
      method: "answerGuestQuery",
      body: {
        guest_query_id: "guest-1",
        result: {
          type: "article",
          id: "1",
          title: "Response",
          input_message_content: { message_text: "ack" },
        },
      },
    },
    {
      method: "answerGuestQuery",
      body: {
        guest_query_id: "guest-2",
        result: {
          type: "article",
          id: "1",
          title: "Response",
          input_message_content: { rich_message: { markdown: "hi" } },
        },
      },
    },
    {
      method: "editMessageText",
      body: {
        inline_message_id: "inline-42",
        rich_message: { markdown: "**done**" },
      },
    },
    {
      method: "editMessageText",
      body: { inline_message_id: "inline-43", text: "plain" },
    },
    {
      method: "editMessageText",
      body: {
        inline_message_id: "inline-44",
        text: "<b>frame</b>",
        parse_mode: "HTML",
      },
    },
  ]);
});

test("Telegram bridge API runtime exposes typed Bot API helpers", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/tmp/telegram",
    maxFileSizeBytes: 123,
    tempFileMaxAgeMs: 60_000,
    recordRuntimeEvent: () => {},
    client: createApiRuntimeClient({
      call: async <TResponse>(
        method: string,
        body: Record<string, unknown>,
      ) => {
        calls.push({ method, body });
        if (method === "sendMessage" || method === "sendRichMessage") {
          return { message_id: 9 } as TResponse;
        }
        if (method === "getUpdates") return [{ update_id: 10 }] as TResponse;
        return true as TResponse;
      },
      callMultipart: async <TResponse>(
        method: string,
        fields: Record<string, string>,
        fileField: string,
        filePath: string,
        fileName: string,
      ) => {
        calls.push({
          method,
          body: { fields, fileField, filePath, fileName },
        });
        return { message_id: 10 } as TResponse;
      },
    }),
  });
  assert.equal(await runtime.deleteWebhook(), true);
  assert.deepEqual(await runtime.getUpdates({ offset: 1 }), [
    { update_id: 10 },
  ]);
  assert.equal(
    await runtime.setMyCommands([{ command: "start", description: "Start" }]),
    true,
  );
  assert.equal(await runtime.sendChatAction(1, "typing"), true);
  assert.equal(await runtime.sendTypingAction(2), true);
  await runtime.answerGuestQuery("guest-1", "hello");
  await runtime.answerGuestQuery("guest-rich", undefined, {
    richMessage: { markdown: "**hello**", skip_entity_detection: true },
  });
  await runtime.answerGuestQuery("guest-voice", undefined, {
    result: {
      type: "voice",
      id: "voice-1",
      voice_file_id: "cached-voice",
      title: "Response",
      caption: "hello",
    },
  });
  await runtime.answerGuestQuery("guest-2");
  assert.equal(await runtime.sendMessageDraft(1, 2, "draft"), true);
  assert.equal(await runtime.sendMessageDraft(1, 2, ""), true);
  assert.equal(await runtime.sendMessageDraft(1, 2, undefined), true);
  assert.equal(
    await runtime.sendMessageDraft(1, 2, "rich", {
      parse_mode: "HTML",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    }),
    true,
  );
  assert.deepEqual(await runtime.sendMessage({ chat_id: 1, text: "hello" }), {
    message_id: 9,
  });
  assert.deepEqual(
    await runtime.sendRichMessage({
      chat_id: 1,
      rich_message: {
        markdown:
          "# hello\n\n![](tg://photo?id=cover)\n\n![](tg://audio?id=voice)",
        media: [
          {
            id: "cover",
            media: { type: "photo", media: "https://example.com/cover.jpg" },
          },
          {
            id: "voice",
            media: {
              type: "voice_note",
              media: "cached-voice",
              duration: 4,
            },
          },
        ],
      },
    }),
    { message_id: 9 },
  );
  assert.equal(
    await runtime.sendRichMessageDraft({
      chat_id: 1,
      draft_id: 3,
      rich_message: { markdown: "**draft**" },
    }),
    true,
  );
  const uploadRichMessage = {
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
      { chat_id: "1", rich_message: JSON.stringify(uploadRichMessage) },
      "voice_upload",
      "/tmp/voice.ogg",
      "voice.ogg",
    ),
    { message_id: 10 },
  );
  assert.deepEqual(calls, [
    { method: "deleteWebhook", body: { drop_pending_updates: false } },
    { method: "getUpdates", body: { offset: 1 } },
    {
      method: "setMyCommands",
      body: { commands: [{ command: "start", description: "Start" }] },
    },
    { method: "sendChatAction", body: { chat_id: 1, action: "typing" } },
    { method: "sendChatAction", body: { chat_id: 2, action: "typing" } },
    {
      method: "answerGuestQuery",
      body: {
        guest_query_id: "guest-1",
        result: {
          type: "article",
          id: "1",
          title: "Response",
          input_message_content: { message_text: "hello" },
        },
      },
    },
    {
      method: "answerGuestQuery",
      body: {
        guest_query_id: "guest-rich",
        result: {
          type: "article",
          id: "1",
          title: "Response",
          input_message_content: {
            rich_message: {
              markdown: "**hello**",
              skip_entity_detection: true,
            },
          },
        },
      },
    },
    {
      method: "answerGuestQuery",
      body: {
        guest_query_id: "guest-voice",
        result: {
          type: "voice",
          id: "voice-1",
          voice_file_id: "cached-voice",
          title: "Response",
          caption: "hello",
        },
      },
    },
    { method: "answerGuestQuery", body: { guest_query_id: "guest-2" } },
    {
      method: "sendMessageDraft",
      body: { chat_id: 1, draft_id: 2, text: "draft" },
    },
    {
      method: "sendMessageDraft",
      body: { chat_id: 1, draft_id: 2, text: "" },
    },
    {
      method: "sendMessageDraft",
      body: { chat_id: 1, draft_id: 2 },
    },
    {
      method: "sendMessageDraft",
      body: {
        chat_id: 1,
        draft_id: 2,
        text: "rich",
        parse_mode: "HTML",
        entities: [{ type: "bold", offset: 0, length: 4 }],
      },
    },
    { method: "sendMessage", body: { chat_id: 1, text: "hello" } },
    {
      method: "sendRichMessage",
      body: {
        chat_id: 1,
        rich_message: {
          markdown:
            "# hello\n\n![](tg://photo?id=cover)\n\n![](tg://audio?id=voice)",
          media: [
            {
              id: "cover",
              media: {
                type: "photo",
                media: "https://example.com/cover.jpg",
              },
            },
            {
              id: "voice",
              media: {
                type: "voice_note",
                media: "cached-voice",
                duration: 4,
              },
            },
          ],
        },
      },
    },
    {
      method: "sendRichMessageDraft",
      body: {
        chat_id: 1,
        draft_id: 3,
        rich_message: { markdown: "**draft**" },
      },
    },
    {
      method: "sendRichMessage",
      body: {
        fields: {
          chat_id: "1",
          rich_message: JSON.stringify(uploadRichMessage),
        },
        fileField: "voice_upload",
        filePath: "/tmp/voice.ogg",
        fileName: "voice.ogg",
      },
    },
  ]);
});

test("Telegram bridge API runtime edits messages and tolerates unchanged text", async () => {
  const events: Array<Record<string, unknown>> = [];
  const runtime = createTelegramBridgeApiRuntime({
    tempDir: "/tmp/telegram",
    maxFileSizeBytes: 123,
    tempFileMaxAgeMs: 60_000,
    recordRuntimeEvent: (kind, error, details) => {
      events.push({
        kind,
        message: error instanceof Error ? error.message : String(error),
        details,
      });
    },
    client: createApiRuntimeClient({
      call: async <TResponse>(
        _method: string,
        body: Record<string, unknown>,
      ) => {
        if (body.text === "same") {
          throw new Error("Bad Request: message is not modified");
        }
        return true as TResponse;
      },
    }),
  });
  assert.equal(
    await runtime.editMessageText({ chat_id: 1, message_id: 2, text: "next" }),
    "edited",
  );
  assert.equal(
    await runtime.editMessageText({ chat_id: 1, message_id: 2, text: "same" }),
    "unchanged",
  );
  assert.deepEqual(events, []);
});

test("Telegram API client resolves bot tokens lazily for wrapped calls", async () => {
  const calls: string[] = [];
  let botToken = "123:abc";
  const restoreFetch = setTestFetch(async (input) => {
    calls.push(getApiTestFetchUrl(input));
    return createApiJsonResponse(true);
  });
  try {
    const client = createTelegramApiClient(() => botToken);
    await client.call("sendChatAction", { chat_id: 1, action: "typing" });
    botToken = "456:def";
    await client.answerCallbackQuery("cb-1", "ok");
    assert.match(calls[0] ?? "", /bot123:abc\/sendChatAction$/);
    assert.match(calls[1] ?? "", /bot456:def\/answerCallbackQuery$/);
  } finally {
    restoreFetch();
  }
});
