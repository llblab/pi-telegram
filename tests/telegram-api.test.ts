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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  answerTelegramCallbackQuery,
  callTelegram,
  callTelegramMultipart,
  cleanupTelegramTempFiles,
  createDefaultTelegramBridgeApiRuntime,
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
  getTelegramInboundFileByteLimitFromEnv,
  isTelegramApiCommitUnknownError,
  isTelegramMessageNotModifiedError,
  setTelegramApiHttpsFetchForTesting,
  prepareTelegramTempDir,
  TELEGRAM_FILE_MAX_BYTES,
  TelegramApiWorkspaceAdmissionError,
  type TelegramApiCallOptions,
  type TelegramApiClient,
  type TelegramInputRichMessage,
} from "../lib/telegram-api.ts";
import { isTelegramTopicTargetStaleError } from "../lib/threads.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import { createTelegramAssistantPreviewRuntime } from "../lib/preview.ts";
import { createTelegramBusAwareApiRuntime } from "../lib/bus-api.ts";

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
    const restoreFetch = setApiTestFetch(async () => createApiErrorResponse(status, description));
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

function getApiTestFetchUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input.toString();
}

function setApiTestFetch(fetchImpl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => {
    globalThis.fetch = originalFetch;
  };
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
      const restoreFetch = setApiTestFetch(async (input, init) => {
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
    const restoreFetch = setApiTestFetch(async (input, init) => {
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

test("Sealed preview drains its issued request but never waits for a 429 draft retry", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const issued = new Promise<void>((resolve) => { entered = resolve; });
  let requests = 0;
  let sleeps = 0;
  let finalSent = false;
  let final: Promise<boolean> | undefined;
  let flush: Promise<void> | undefined;
  const restoreFetch = setApiTestFetch(async () => {
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
    flush = preview.getState()?.flushPromise;
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
    getTelegramInboundFileByteLimitFromEnv({}, []),
    TELEGRAM_FILE_MAX_BYTES,
  );
});

test("Telegram API byte-limit config prefers positive integer env values", () => {
  assert.equal(
    getTelegramInboundFileByteLimitFromEnv(
      { PI_TELEGRAM_INBOUND_FILE_MAX_BYTES: "12345" },
      ["PI_TELEGRAM_INBOUND_FILE_MAX_BYTES"],
      99,
    ),
    12345,
  );
  assert.equal(
    getTelegramInboundFileByteLimitFromEnv(
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

test("Telegram bridge API runtime owns reply-markup edits", async () => {
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
  const replyMarkup = { inline_keyboard: [[{ text: "Run" }]] };

  await runtime.editMessageReplyMarkup(7, 42, replyMarkup);

  assert.deepEqual(calls, [
    {
      method: "editMessageReplyMarkup",
      body: { chat_id: 7, message_id: 42, reply_markup: replyMarkup },
    },
  ]);
});

test("Telegram bridge API runtime coalesces and spaces identical chat actions", async () => {
  let nowMs = 1000;
  let releaseFirst: (value: boolean) => void = () => {};
  const firstResult = new Promise<boolean>((resolve) => {
    releaseFirst = resolve;
  });
  const callOptions: Array<{ maxAttempts?: number } | undefined> = [];
  let calls = 0;
  const runtime = createTelegramBridgeApiRuntime({
    client: createApiRuntimeClient({
      call: async <TResponse>(
        _method: string,
        _body: Record<string, unknown>,
        options?: TelegramApiCallOptions,
      ) => {
        calls += 1;
        callOptions.push(options);
        return (calls === 1 ? await firstResult : true) as TResponse;
      },
    }),
    tempDir: "/tmp",
    maxFileSizeBytes: 1,
    tempFileMaxAgeMs: 1,
    recordRuntimeEvent: () => {},
    now: () => nowMs,
    chatActionMinIntervalMs: 2000,
  });
  const body = { chat_id: 7, action: "typing" };

  const first = runtime.call<boolean>("sendChatAction", body);
  const joined = runtime.call<boolean>("sendChatAction", body);
  await Promise.resolve();
  assert.equal(calls, 1);
  releaseFirst(true);
  assert.deepEqual(await Promise.all([first, joined]), [true, true]);
  assert.deepEqual(callOptions, [{ retryRateLimit: false }]);

  nowMs = 2999;
  assert.equal(await runtime.call<boolean>("sendChatAction", body), true);
  assert.equal(calls, 1);
  nowMs = 3000;
  assert.equal(await runtime.call<boolean>("sendChatAction", body), true);
  assert.equal(calls, 2);
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

test("Telegram bridge API runtime shares retry-after suppression for chat actions", async () => {
  let nowMs = 1000;
  let calls = 0;
  const events: Array<Record<string, unknown>> = [];
  const restoreFetch = setApiTestFetch(async () => {
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
    const body = { chat_id: 7, action: "typing" };

    assert.equal(await runtime.call<boolean>("sendChatAction", body), true);
    assert.equal(calls, 1);
    assert.deepEqual(events, [
      {
        method: "sendChatAction",
        rateLimited: true,
        retryAfterMs: 3000,
      },
    ]);

    nowMs = 3999;
    assert.equal(await runtime.call<boolean>("sendChatAction", body), true);
    assert.equal(calls, 1);
    nowMs = 4000;
    assert.equal(await runtime.call<boolean>("sendChatAction", body), true);
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});

test("Telegram bridge API runtime preserves transient 5xx chat-action retries", async () => {
  let calls = 0;
  const restoreFetch = setApiTestFetch(async () => {
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

    assert.equal(
      await runtime.call<boolean>(
        "sendChatAction",
        { chat_id: 7, action: "typing" },
        { retryBaseDelayMs: 0, sleep: async () => {} },
      ),
      true,
    );
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
  const restoreFetch = setApiTestFetch(async () => {
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

test("Telegram temp cleanup removes only stale UUID-prefixed scratch files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-cleanup-"));
  const oldFile = join(
    tempDir,
    "00000000-0000-4000-8000-000000000001-old.txt",
  );
  const freshFile = join(
    tempDir,
    "00000000-0000-4000-8000-000000000002-fresh.txt",
  );
  const journalFile = join(tempDir, "inbox.json");
  const nestedDir = join(tempDir, "nested");
  await writeFile(oldFile, "old", "utf8");
  await writeFile(freshFile, "fresh", "utf8");
  await writeFile(journalFile, "durable", "utf8");
  await mkdir(nestedDir);
  await writeFile(join(nestedDir, "keep.txt"), "keep", "utf8");
  await utimes(oldFile, new Date(1_000), new Date(1_000));
  await utimes(journalFile, new Date(1_000), new Date(1_000));
  await utimes(freshFile, new Date(10_000), new Date(10_000));
  assert.equal(await cleanupTelegramTempFiles(tempDir, 5_000, 11_000), 1);
  assert.deepEqual((await readdir(tempDir)).sort(), [
    "00000000-0000-4000-8000-000000000002-fresh.txt",
    "inbox.json",
    "nested",
  ]);
});

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
  const restoreFetch = setApiTestFetch(async () => {
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

test("Non-idempotent Telegram API calls retry explicit 429 but report 5xx commit unknown", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async () => {
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

test("Telegram API retry waits settle immediately when their owner aborts", async () => {
  const controller = new AbortController();
  const reason = { kind: "polling-request-expired" };
  let calls = 0;
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async (_input, init) => {
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
  const restoreFetch = setApiTestFetch(async (input) => {
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
  const restoreFetch = setApiTestFetch(async (_input, init) => {
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

test("Telegram file downloads use unique sanitized temp file names", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-download-"));
  const restoreFetch = setApiTestFetch(async (input) => {
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
    assert.match(path, /[0-9a-f-]{36}-bad_name_\.txt$/);
    assert.equal(await readFile(path, "utf8"), "hello");
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
  const restoreFetch = setApiTestFetch(async (input) => {
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

test("Telegram streaming downloads remove partial files after limit failures", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-download-partial-"),
  );
  const restoreFetch = setApiTestFetch(async (input) => {
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
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async () =>
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
  const restoreFetch = setApiTestFetch(async () => {
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
  const restoreFetch = setApiTestFetch(async (input) => {
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
  const restoreFetch = setApiTestFetch(async () => {
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
  const tempDir = resolve(agentDir, "tmp", "telegram");
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
  const restoreFetch = setApiTestFetch(async (input) => {
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
