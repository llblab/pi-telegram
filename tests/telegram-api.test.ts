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
  createTelegramAssistantDraftSender,
  createTelegramBridgeApiRuntime,
  createTelegramChatActionSender,
  createTelegramNativeMarkdownDraftSender,
  downloadTelegramFile,
  fetchTelegramBotIdentity,
  getTelegramInboundFileByteLimitFromEnv,
  isTelegramApiCommitUnknownError,
  isTelegramMessageNotModifiedError,
  setTelegramApiHttpsFetchForTesting,
  prepareTelegramTempDir,
  TELEGRAM_FILE_MAX_BYTES,
  type TelegramApiCallOptions,
  type TelegramApiClient,
  type TelegramInputRichMessage,
} from "../lib/telegram-api.ts";

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

test("Outgoing Rich Message type excludes explicit structured blocks", () => {
  // @ts-expect-error Core output supports Markdown/HTML only; blocks include draft-only Thinking.
  const unsupported: TelegramInputRichMessage = { blocks: [] };
  assert.deepEqual(unsupported, { blocks: [] });
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

test("Telegram native Markdown draft sender disables automatic entity detection", async () => {
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
        skip_entity_detection: true,
      },
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

test("Telegram temp cleanup removes only stale files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-cleanup-"));
  const oldFile = join(tempDir, "old.txt");
  const freshFile = join(tempDir, "fresh.txt");
  const nestedDir = join(tempDir, "nested");
  await writeFile(oldFile, "old", "utf8");
  await writeFile(freshFile, "fresh", "utf8");
  await mkdir(nestedDir);
  await writeFile(join(nestedDir, "keep.txt"), "keep", "utf8");
  await utimes(oldFile, new Date(1_000), new Date(1_000));
  await utimes(freshFile, new Date(10_000), new Date(10_000));
  assert.equal(await cleanupTelegramTempFiles(tempDir, 5_000, 11_000), 1);
  assert.deepEqual((await readdir(tempDir)).sort(), ["fresh.txt", "nested"]);
});

test("Telegram temp preparation creates the directory and removes stale files", async () => {
  const parentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-prepare-parent-"),
  );
  const tempDir = join(parentDir, "nested", "telegram");
  assert.equal(await prepareTelegramTempDir(tempDir, 5_000), 0);
  if (process.platform !== "win32") {
    assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
  }
  const oldFile = join(tempDir, "old.txt");
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
  const staleFile = join(tempDir, "stale.txt");
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
