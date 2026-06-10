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
  createTelegramBridgeApiRuntime,
  createTelegramChatActionSender,
  downloadTelegramFile,
  fetchTelegramBotIdentity,
  getTelegramInboundFileByteLimitFromEnv,
  isTelegramMessageNotModifiedError,
  prepareTelegramTempDir,
  TELEGRAM_FILE_MAX_BYTES,
  type TelegramApiClient,
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
  const calls: Array<[number, string]> = [];
  const sendTyping = createTelegramChatActionSender(async (chatId, action) => {
    calls.push([chatId, action]);
  }, "typing");
  await sendTyping(7);
  assert.deepEqual(calls, [[7, "typing"]]);
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
  assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
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

test("Telegram API helpers retry 429 and 5xx responses", async () => {
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
    const result = await callTelegram<string>(
      "123:abc",
      "sendMessage",
      {},
      {
        retryBaseDelayMs: 10,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(result, "sent");
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2000, 20]);
  } finally {
    restoreFetch();
  }
});

test("Telegram multipart API rebuilds forms for retryable responses", async () => {
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
    assert.equal(
      await callTelegramMultipart<boolean>(
        "123:abc",
        "sendDocument",
        { chat_id: "1" },
        "document",
        filePath,
        "demo.txt",
        { retryBaseDelayMs: 0, sleep: async () => {} },
      ),
      true,
    );
    assert.equal(calls, 2);
    assert.deepEqual(contentTypes, ["blob", "blob"]);
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
    assert.equal((await stat(tempDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
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
        if (method === "sendMessage") return { message_id: 9 } as TResponse;
        if (method === "getUpdates") return [{ update_id: 10 }] as TResponse;
        return true as TResponse;
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
