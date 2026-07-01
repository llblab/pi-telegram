/**
 * Cross-domain integration tests for the Telegram extension
 * Exercises extension-level polling, queue/lifecycle wiring, previews, reactions, compaction, and model switching
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import testRoot, { mock, type TestContext } from "node:test";

import * as Runtime from "../lib/runtime.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";

type RuntimeTestHandler = (context: TestContext) => void | Promise<void>;
type RuntimeTelegramExtension = (typeof import("../index.ts"))["default"];

function test(name: string, fn: RuntimeTestHandler): void {
  void testRoot(name, { concurrency: false, timeout: 5000 }, fn);
}

let runtimeTelegramExtension: RuntimeTelegramExtension | undefined;
let runtimeAgentDir: string | undefined;

async function ensureRuntimeAgentDir(): Promise<string> {
  if (!runtimeAgentDir) {
    runtimeAgentDir = await mkdtemp(
      join(tmpdir(), "pi-telegram-runtime-agent-"),
    );
    process.env.PI_CODING_AGENT_DIR = runtimeAgentDir;
  }
  return runtimeAgentDir;
}

async function getRuntimeTelegramExtension(): Promise<RuntimeTelegramExtension> {
  if (runtimeTelegramExtension) return runtimeTelegramExtension;
  await ensureRuntimeAgentDir();
  runtimeTelegramExtension = (await import("../index.ts")).default;
  return runtimeTelegramExtension;
}

async function flushMicrotasks(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

async function waitForEventLoopCondition(
  predicate: () => boolean,
  iterations = 100,
): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for event-loop condition");
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function parseJsonRequestBody(
  init: RequestInit | undefined,
): Record<string, unknown> | undefined {
  if (typeof init?.body !== "string") return undefined;
  return JSON.parse(init.body) as Record<string, unknown>;
}

function getRuntimeTelegramApiMethod(input: string | URL | Request): string {
  const url = typeof input === "string" ? input : input.toString();
  return url.split("/").at(-1) ?? "";
}

function getRuntimeTelegramApiText(
  body: Record<string, unknown> | undefined,
): string {
  const richMessage = body?.rich_message as
    | { html?: string; markdown?: string }
    | undefined;
  return String(body?.text ?? richMessage?.html ?? richMessage?.markdown ?? "");
}

function setRuntimeTestFetch(fetchImpl: typeof fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function createRuntimeTelegramConfigFixture() {
  const agentDir = await ensureRuntimeAgentDir();
  const configPath = join(agentDir, "telegram.json");
  const previousConfig = await readFile(configPath, "utf8").catch(
    () => undefined,
  );
  const isolated = process.env.PI_CODING_AGENT_DIR === agentDir;
  return {
    write: async (config: Record<string, unknown>) => {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(config, null, "\t") + "\n",
        "utf8",
      );
    },
    restore: async () => {
      if (isolated) return;
      if (previousConfig === undefined) {
        await rm(configPath, { force: true });
        return;
      }
      await writeFile(configPath, previousConfig, "utf8");
    },
  };
}

async function writeRuntimeTelegramLocks(
  locks: Record<string, unknown>,
): Promise<void> {
  const agentDir = await ensureRuntimeAgentDir();
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "locks.json"),
    JSON.stringify(locks, null, "\t") + "\n",
    "utf8",
  );
}

function createRuntimeDeferredResponse() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createRuntimeTelegramApiResponse(result: unknown): Response {
  return { json: async () => ({ ok: true, result }) } as Response;
}

function createRuntimeTelegramApiErrorResponse(
  status: number,
  description: string,
): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ "retry-after": "0" }),
    text: async () => JSON.stringify({ ok: false, description }),
  } as Response;
}

function createRuntimeExtensionContext(
  overrides: Record<string, unknown> = {},
) {
  return {
    hasUI: true,
    model: undefined,
    signal: undefined,
    ui: {
      theme: {
        fg: (_token: string, text: string) => text,
      },
      setStatus: () => {},
      notify: () => {},
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    ...overrides,
  };
}

type RuntimeModelFixture = {
  provider: string;
  id: string;
  reasoning?: boolean;
};

function createRuntimeModel(
  provider: string,
  id: string,
  reasoning?: boolean,
): RuntimeModelFixture {
  return reasoning === undefined
    ? { provider, id }
    : { provider, id, reasoning };
}

type RuntimeModelContextOptions = {
  model?: RuntimeModelFixture;
  availableModels: RuntimeModelFixture[];
  isIdle?: () => boolean;
  abort?: () => void;
  setStatus?: (slot: string, text: string) => void;
};

function createRuntimeModelContext(options: RuntimeModelContextOptions) {
  return createRuntimeExtensionContext({
    cwd: process.cwd(),
    model: options.model,
    ui: {
      theme: {
        fg: (_token: string, text: string) => text,
      },
      setStatus: options.setStatus ?? (() => {}),
      notify: () => {},
    },
    sessionManager: {
      getEntries: () => [],
    },
    modelRegistry: {
      refresh: () => {},
      getAvailable: () => options.availableModels,
      isUsingOAuth: () => false,
    },
    getContextUsage: () => undefined,
    isIdle: options.isIdle ?? (() => true),
    abort: options.abort ?? (() => {}),
  });
}

type RuntimeHarnessTextBlock = { type: string; text?: string };
type RuntimeHarnessMessage = string | RuntimeHarnessTextBlock[];

function getRuntimeHarnessTextBlock(
  content: RuntimeHarnessMessage | undefined,
): RuntimeHarnessTextBlock {
  assert.equal(Array.isArray(content), true);
  if (!Array.isArray(content)) throw new Error("Expected text-block message");
  return content[0] ?? { type: "" };
}

function getRuntimeHarnessMessageText(content: RuntimeHarnessMessage): string {
  if (typeof content === "string") return content;
  return getRuntimeHarnessTextBlock(content).text ?? "";
}

function recordRuntimeDispatchEvent(
  events: string[],
  content: RuntimeHarnessMessage,
): void {
  events.push(`dispatch:${getRuntimeHarnessMessageText(content)}`);
}

type RuntimeHarnessHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
type RuntimeHarnessCommand = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};
type RuntimePiHarnessOptions = {
  sendUserMessage?: (content: RuntimeHarnessMessage) => void;
  getThinkingLevel?: () => string;
  setModel?: (model: { provider: string; id: string }) => Promise<boolean>;
  setThinkingLevel?: (level: string) => void;
  getCommands?: () => unknown[];
};

function createRuntimePiHarness(options: RuntimePiHarnessOptions = {}) {
  const handlers = new Map<string, RuntimeHarnessHandler>();
  const commands = new Map<string, RuntimeHarnessCommand>();
  const pi = {
    on: (event: string, handler: RuntimeHarnessHandler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, definition: RuntimeHarnessCommand) => {
      commands.set(name, definition);
    },
    registerTool: () => {},
    sendUserMessage: options.sendUserMessage ?? (() => {}),
    getCommands: options.getCommands ?? (() => []),
    getThinkingLevel: options.getThinkingLevel ?? (() => "medium"),
    ...(options.setModel ? { setModel: options.setModel } : {}),
    ...(options.setThinkingLevel
      ? { setThinkingLevel: options.setThinkingLevel }
      : {}),
  };
  return { handlers, commands, pi: pi as never };
}

test("Extension runtime polls, pairs, and dispatches an inbound Telegram turn into pi", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  let resolveDispatch: ((value: RuntimeHarnessMessage) => void) | undefined;
  const dispatched = new Promise<RuntimeHarnessMessage>((resolve) => {
    resolveDispatch = resolve;
  });
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      resolveDispatch?.(content);
    },
  });
  let getUpdatesCalls = 0;
  let sendMessageCalls = 0;
  const apiCalls: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    apiCalls.push(method);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 42,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "hello from telegram",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sendMessageCalls += 1;
      if (sendMessageCalls === 1) {
        return createRuntimeTelegramApiErrorResponse(
          500,
          "temporary send failure",
        );
      }
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({ botToken: "123:abc", lastUpdateId: 0 });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    const dispatchedContent = await dispatched;
    assert.equal(sentMessages.length, 1);
    assert.equal(Array.isArray(dispatchedContent), true);
    assert.equal(apiCalls.includes("sendMessage"), true);
    assert.equal(sendMessageCalls, 2);
    assert.equal(apiCalls.includes("sendChatAction"), true);
    const promptBlock = getRuntimeHarnessTextBlock(dispatchedContent);
    assert.equal(promptBlock.type, "text");
    assert.match(promptBlock.text ?? "", /^\[telegram\] hello from telegram$/);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime finalizes queued turn after polling ownership moves away", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  let resolveDispatch: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });
  const draftTexts: string[] = [];
  const sentTexts: string[] = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const editedTexts: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: () => {
      resolveDispatch?.();
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 7,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "please answer",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessageDraft") {
      draftTexts.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendRichMessageDraft") {
      const richMessage = body?.rich_message as
        | { markdown?: string }
        | undefined;
      draftTexts.push(String(richMessage?.markdown ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendRichMessage") {
      const richMessage = body?.rich_message as
        | { markdown?: string }
        | undefined;
      sentTexts.push(String(richMessage?.markdown ?? ""));
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sentTexts.length,
      });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentTexts.push(String(body?.text ?? ""));
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sentTexts.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "editMessageText") {
      editedTexts.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    mock.timers.enable({ apis: ["setTimeout"] });
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await dispatched;
    await handlers.get("agent_start")?.({}, ctx);
    await writeFile(
      join(await ensureRuntimeAgentDir(), "locks.json"),
      JSON.stringify(
        {
          "@llblab/pi-telegram": {
            pid: process.pid + 1_000_000,
            cwd: "/tmp/other-pi-instance",
          },
        },
        null,
        "\t",
      ) + "\n",
      "utf8",
    );
    mock.timers.tick(1100);
    await flushMicrotasks(20);
    await handlers.get("message_update")?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Draft **preview**" }],
        },
      },
      ctx,
    );
    mock.timers.tick(1000);
    await flushMicrotasks(50);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Final **answer**" }],
          },
        ],
      },
      ctx,
    );
    mock.timers.tick(0);
    await flushMicrotasks(20);
    assert.deepEqual(draftTexts, ["Draft **preview**"]);
    assert.equal(sentTexts.length, 1);
    assert.match(sentTexts[0] ?? "", /Final \*\*answer\*\*/);
    assert.deepEqual(sentBodies[0]?.reply_parameters, {
      message_id: 7,
      allow_sending_without_reply: true,
    });
    assert.deepEqual(editedTexts, []);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    mock.timers.reset();
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime dispatches accepted queued work after polling ownership moves away", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 7,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first accepted",
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 8,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "second queued",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendRichMessage") {
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(body ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/queue-owner-a",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() => sentMessages.length === 1);
    assert.match(
      getRuntimeHarnessMessageText(sentMessages[0] as RuntimeHarnessMessage),
      /^\[telegram\] first accepted$/,
    );
    await handlers.get("agent_start")?.({}, ctx);
    await writeRuntimeTelegramLocks({
      "@llblab/pi-telegram": {
        pid: process.pid + 1_000_000,
        cwd: "/repo/queue-owner-b",
      },
    });
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "First **final**" }],
          },
        ],
      },
      ctx,
    );
    // Follow-up dispatch is intentionally routed through the session-bound
    // deferred queue timer; wait on real time instead of setImmediate turns.
    await waitForCondition(() => sentMessages.length === 2);
    assert.match(
      String(
        (sentBodies[0]?.rich_message as { markdown?: string } | undefined)
          ?.markdown ?? "",
      ),
      /First \*\*final\*\*/,
    );
    assert.match(
      getRuntimeHarnessMessageText(sentMessages[1] as RuntimeHarnessMessage),
      /^\[telegram\] second queued$/,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime keeps proactive local result disabled even with Telegram lock ownership", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: false,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-disabled-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await flushMicrotasks(20);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(sentBodies, []);
    await commands.get("telegram-disconnect")?.handler("", ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime resolves stale same-cwd lock before proactive local result", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  let getUpdatesCalls = 0;
  const { handlers, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    const cwd = "/repo/proactive-stale-owner";
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: true,
    });
    await writeRuntimeTelegramLocks({
      "@llblab/pi-telegram": {
        pid: process.pid + 1_000_000,
        cwd,
      },
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({ cwd });
    await handlers.get("session_start")?.({}, ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 1, 5000);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0]?.chat_id, 77);
    assert.match(
      String(
        (sentBodies[0]?.rich_message as { markdown?: string } | undefined)
          ?.markdown ?? "",
      ),
      /Local \*\*done\*\*/,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime sends proactive local result only while owning Telegram lock", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, commands, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: true,
    });
    await writeRuntimeTelegramLocks({});
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await flushMicrotasks(20);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0]?.chat_id, 77);
    assert.match(
      String(
        (sentBodies[0]?.rich_message as { markdown?: string } | undefined)
          ?.markdown ?? "",
      ),
      /Local \*\*done\*\*/,
    );
    await commands.get("telegram-disconnect")?.handler("", ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime skips proactive local result without Telegram lock ownership", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentBodies: Array<Record<string, unknown>> = [];
  const { handlers, pi } = createRuntimePiHarness();
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "sendMessage" || method === "sendRichMessage") {
      sentBodies.push(parseJsonRequestBody(init) ?? {});
      return createRuntimeTelegramApiResponse({ message_id: 100 });
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
      proactivePush: true,
    });
    await writeRuntimeTelegramLocks({
      "@llblab/pi-telegram": {
        pid: process.pid + 1_000_000,
        cwd: "/repo/another-instance",
      },
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      cwd: "/repo/proactive-non-owner",
    });
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Local **done**" }],
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(sentBodies, []);
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears queued follow-ups after a Telegram stop", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const sentMessages: RuntimeHarnessMessage[] = [];
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const fourthUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      sentMessages.push(content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const sendTexts: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      if (getUpdatesCalls === 4) return fourthUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      sendTexts.push(getRuntimeTelegramApiText(body));
      return createRuntimeTelegramApiResponse({
        message_id: 100 + sendTexts.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const idleCtx = createRuntimeExtensionContext();
    let aborted = false;
    const activeCtx = createRuntimeExtensionContext({
      isIdle: () => false,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 11,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 12,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/stop",
          },
        },
      ]),
    );
    await waitForCondition(() => aborted);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    const dispatchCountBeforeNextTurn = sentMessages.length;
    fourthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message: {
            message_id: 13,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "new request",
          },
        },
      ]),
    );
    await waitForCondition(
      () => sentMessages.length === dispatchCountBeforeNextTurn + 1,
    );
    const promptText =
      getRuntimeHarnessTextBlock(sentMessages.at(-1)).text ?? "";
    assert.equal(promptText, "[telegram] new request");
    assert.equal(promptText.includes("follow up"), false);
    assert.equal(
      sendTexts.includes("Aborted current turn. Cleared 1 queued turn."),
      true,
    );
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime handles immediate status before queued prompt after agent end", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolved = false;
  let shutdownCtx: unknown;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 20,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const baseCtx = createRuntimeExtensionContext({
      cwd: process.cwd(),
      sessionManager: {
        getEntries: () => [],
      },
      modelRegistry: {
        refresh: () => {},
        getAvailable: () => [],
        isUsingOAuth: () => false,
      },
      getContextUsage: () => undefined,
    });
    const idleCtx = {
      ...baseCtx,
      isIdle: () => true,
    };
    const activeCtx = {
      ...baseCtx,
      isIdle: () => false,
    };
    shutdownCtx = idleCtx;
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 21,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/status",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 22,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after status",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.length >= 1);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length >= 3);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.match(runtimeEvents[1] ?? "", /^send:<b>Pi Telegram<\/b>/);
    assert.equal(
      runtimeEvents[2],
      "dispatch:[telegram] follow up after status",
    );
  } finally {
    if (shutdownCtx) await handlers.get("session_shutdown")?.({}, shutdownCtx);
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime opens immediate model menu before queued prompt after agent end", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 23,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const baseCtx = createRuntimeExtensionContext({
      cwd: process.cwd(),
      model: modelA,
      sessionManager: {
        getEntries: () => [],
      },
      modelRegistry: {
        refresh: () => {},
        getAvailable: () => [modelA, modelB],
        isUsingOAuth: () => false,
      },
      getContextUsage: () => undefined,
    });
    const idleCtx = {
      ...baseCtx,
      isIdle: () => true,
    };
    const activeCtx = {
      ...baseCtx,
      isIdle: () => false,
    };
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 24,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/model",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 25,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after model",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.length >= 1);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length >= 3);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.equal(runtimeEvents[1], "send:<b>🤖 Choose a model:</b>");
    assert.equal(runtimeEvents[2], "dispatch:[telegram] follow up after model");
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime keeps queued turns blocked until compaction completes", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let compactHooks:
    | {
        onComplete: () => void;
        onError: (error: unknown) => void;
      }
    | undefined;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 30,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/compact",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) {
        return secondUpdates.promise;
      }
      if (getUpdatesCalls === 3) {
        return thirdUpdates.promise;
      }
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (method === "sendChatAction") {
      runtimeEvents.push(
        `typing:${String(body?.chat_id ?? "")}:${String(body?.action ?? "")}`,
      );
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      runtimeEvents.push(`answer:${String(body?.callback_query_id ?? "")}`);
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext({
      compact: (hooks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
      }) => {
        compactHooks = hooks;
        runtimeEvents.push("compact:start");
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:<b>Compact session?</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          callback_query: {
            id: "confirm-compact",
            from: { id: 77, is_bot: false, first_name: "Test" },
            message: {
              message_id: 101,
              chat: { id: 99, type: "private" },
            },
            data: "compact:confirm",
          },
        },
      ]),
    );
    await waitForCondition(() => runtimeEvents.includes("compact:start"));
    await waitForCondition(
      () =>
        runtimeEvents.includes("edit:🗜 Compaction started.") &&
        runtimeEvents.includes("typing:99:typing"),
    );
    assert.equal(
      runtimeEvents.indexOf("edit:🗜 Compaction started.") <
        runtimeEvents.indexOf("typing:99:typing"),
      true,
    );

    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 31,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "follow up after compaction",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    assert.equal(
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] follow up after compaction",
      ),
      false,
    );
    compactHooks?.onComplete();
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] follow up after compaction"),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("send:✅ Compaction completed."),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime blocks queued dispatch during observed auto-compaction", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolve: (() => void) | undefined;
  const firstDispatched = new Promise<void>((resolve) => {
    firstDispatchResolve = resolve;
  });
  const secondUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolve?.();
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 41,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first telegram turn",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({
        message_id: 100 + runtimeEvents.length,
      });
    }
    if (
      method === "sendMessageDraft" ||
      method === "sendChatAction" ||
      method === "editMessageText"
    ) {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await firstDispatched;
    await handlers.get("agent_start")?.({}, ctx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 42,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "queued during active turn",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
      },
      ctx,
    );
    await handlers.get("session_before_compact")?.(
      { signal: new AbortController().signal },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued during active turn"),
      false,
    );
    await handlers.get("session_compact")?.({}, ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] queued during active turn"),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime coalesces media-group updates into one delayed dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 40,
              media_group_id: "album-1",
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              caption: "first caption",
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 41,
              media_group_id: "album-1",
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              caption: "second caption",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    assert.equal(runtimeEvents.length, 0);
    await waitForCondition(() => runtimeEvents.length === 1, 3000);
    assert.equal(
      runtimeEvents[0],
      "dispatch:[telegram] first caption\n\nsecond caption",
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime coalesces likely split long text updates into one dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 50,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "x".repeat(3600),
            },
          },
          {
            _: "other",
            update_id: 2,
            message: {
              message_id: 51,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "tail",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 1, 5000);
    await flushMicrotasks();
    assert.equal(runtimeEvents.length, 0);
    await waitForCondition(() => runtimeEvents.length === 1, 3000);
    assert.equal(
      runtimeEvents[0],
      `dispatch:[telegram] ${"x".repeat(3600)}\n\ntail`,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears pending split-text dispatch on shutdown", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 60,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "x".repeat(3600),
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    await handlers.get("session_shutdown")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(runtimeEvents, []);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime clears pending media-group dispatch on shutdown", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 61,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              media_group_id: "album-1",
              text: "album item",
            },
          },
        ]);
      }
      throw new DOMException("stop", "AbortError");
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeExtensionContext();
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForEventLoopCondition(() => getUpdatesCalls >= 2, 5000);
    await handlers.get("session_shutdown")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(runtimeEvents, []);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime applies reaction priority and removal before the next dispatch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  let firstDispatchResolved = false;
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const fourthUpdates = createRuntimeDeferredResponse();
  const fifthUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
      firstDispatchResolved = true;
    },
  });
  let getUpdatesCalls = 0;
  const restoreFetch = setRuntimeTestFetch(async (input) => {
    const method = getRuntimeTelegramApiMethod(input);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 30,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "first request",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      if (getUpdatesCalls === 4) return fourthUpdates.promise;
      if (getUpdatesCalls === 5) return fifthUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const idleCtx = createRuntimeExtensionContext();
    const activeCtx = createRuntimeExtensionContext({
      isIdle: () => false,
    });
    await handlers.get("session_start")?.({}, idleCtx);
    await commands.get("telegram-connect")?.handler("", idleCtx);
    await waitForCondition(() => firstDispatchResolved);
    await handlers.get("agent_start")?.({}, activeCtx);
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 31,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "older waiting",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 3);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 32,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "newer waiting",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 4);
    fourthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message_reaction: {
            chat: { id: 99, type: "private" },
            message_id: 32,
            user: { id: 77, is_bot: false, first_name: "Test" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "👍" }],
            date: 1,
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 5);
    fifthUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 5,
          message_reaction: {
            chat: { id: 99, type: "private" },
            message_id: 31,
            user: { id: 77, is_bot: false, first_name: "Test" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "👎" }],
            date: 2,
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 6);
    await flushMicrotasks(50);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await waitForCondition(() => runtimeEvents.length === 2);
    assert.equal(runtimeEvents[0], "dispatch:[telegram] first request");
    assert.equal(runtimeEvents[1], "dispatch:[telegram] newer waiting");
    await handlers.get("agent_start")?.({}, activeCtx);
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      idleCtx,
    );
    await flushMicrotasks();
    assert.deepEqual(runtimeEvents, [
      "dispatch:[telegram] first request",
      "dispatch:[telegram] newer waiting",
    ]);
    await handlers.get("session_shutdown")?.({}, idleCtx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime applies idle model picks immediately and refreshes status", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const previousArgv = [...process.argv];
  const runtimeEvents: string[] = [];
  const statusEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", true);
  const setModels: Array<string> = [];
  const thinkingLevels: Array<string> = [];
  let shutdownCtx: unknown;
  const secondUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    getThinkingLevel: () => thinkingLevels.at(-1) ?? "medium",
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: (level) => {
      thinkingLevels.push(level);
    },
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 60,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    process.argv = [
      previousArgv[0] ?? "node",
      previousArgv[1] ?? "index.ts",
      "--models=anthropic/claude-b:high",
    ];
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      setStatus: (_slot, text) => {
        statusEvents.push(text);
      },
    });
    shutdownCtx = ctx;
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    const statusCountBeforePick = statusEvents.length;
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          callback_query: {
            id: "cb-idle-1",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:0",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => setModels.length === 1);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.deepEqual(thinkingLevels, ["high"]);
    assert.equal(callbackAnswers.includes("Switched to claude-b"), true);
    assert.equal(statusEvents.length > statusCountBeforePick, true);
    assert.equal(
      runtimeEvents.some(
        (event) =>
          event.startsWith("edit:<b>Pi Telegram</b>") ||
          event.startsWith("edit:<b>🤖 Choose a model:</b>"),
      ),
      true,
    );
  } finally {
    if (shutdownCtx) await handlers.get("session_shutdown")?.({}, shutdownCtx);
    process.argv = previousArgv;
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime switches model in flight and dispatches a continuation turn after abort", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let aborted = false;
  const setModels: Array<string> = [];
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 40,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 41,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] first request",
      ),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          callback_query: {
            id: "cb-1",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => aborted);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(
      callbackAnswers.includes("Switching to claude-b and continuing…"),
      true,
    );
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    await waitForCondition(() =>
      runtimeEvents.some((event) =>
        event.includes(
          "Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] first request"),
      true,
    );
    assert.equal(
      runtimeEvents.some((event) =>
        event.includes(
          "dispatch:[telegram] Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
      true,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime preserves long-session queue through abort, next, and model switch", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let abortCount = 0;
  const setModels: Array<string> = [];
  const updates = Array.from({ length: 5 }, () =>
    createRuntimeDeferredResponse(),
  );
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook")
      return createRuntimeTelegramApiResponse(true);
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 70,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      const update = updates[getUpdatesCalls - 2];
      if (update) return update.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction")
      return createRuntimeTelegramApiResponse(true);
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        abortCount += 1;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.includes("send:<b>🤖 Choose a model:</b>"),
    );
    updates[0].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 71,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first long-session request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] first long-session request"),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    updates[1].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          message: {
            message_id: 72,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "queued after abort",
          },
        },
      ]),
    );
    await waitForCondition(() => getUpdatesCalls >= 4);
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      false,
    );
    updates[2].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 4,
          message: {
            message_id: 73,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/abort",
          },
        },
      ]),
    );
    await waitForCondition(() => abortCount === 1);
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      false,
    );
    updates[3].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 5,
          message: {
            message_id: 74,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "/next",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    updates[4].resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 6,
          callback_query: {
            id: "cb-long-session",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() => abortCount === 2);
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(
      callbackAnswers.includes("Switching to claude-b and continuing…"),
      true,
    );
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    assert.equal(
      runtimeEvents.includes("dispatch:[telegram] queued after abort"),
      true,
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});

test("Extension runtime delays model-switch abort until the active tool finishes", async () => {
  const telegramConfig = await createRuntimeTelegramConfigFixture();
  const runtimeEvents: string[] = [];
  const modelA = createRuntimeModel("openai", "gpt-a", true);
  const modelB = createRuntimeModel("anthropic", "claude-b", false);
  let idle = true;
  let aborted = false;
  const setModels: Array<string> = [];
  const secondUpdates = createRuntimeDeferredResponse();
  const thirdUpdates = createRuntimeDeferredResponse();
  const { handlers, commands, pi } = createRuntimePiHarness({
    sendUserMessage: (content) => {
      recordRuntimeDispatchEvent(runtimeEvents, content);
    },
    setModel: async (model) => {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel: () => {},
  });
  let getUpdatesCalls = 0;
  let nextMessageId = 100;
  const callbackAnswers: string[] = [];
  const restoreFetch = setRuntimeTestFetch(async (input, init) => {
    const method = getRuntimeTelegramApiMethod(input);
    const body = parseJsonRequestBody(init);
    if (method === "deleteWebhook") {
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "getUpdates") {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return createRuntimeTelegramApiResponse([
          {
            _: "other",
            update_id: 1,
            message: {
              message_id: 50,
              chat: { id: 99, type: "private" },
              from: { id: 77, is_bot: false, first_name: "Test" },
              text: "/model",
            },
          },
        ]);
      }
      if (getUpdatesCalls === 2) return secondUpdates.promise;
      if (getUpdatesCalls === 3) return thirdUpdates.promise;
      throw new DOMException("stop", "AbortError");
    }
    if (method === "sendMessage" || method === "sendRichMessage") {
      runtimeEvents.push(`send:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse({ message_id: nextMessageId++ });
    }
    if (method === "editMessageText") {
      runtimeEvents.push(`edit:${getRuntimeTelegramApiText(body)}`);
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(String(body?.text ?? ""));
      return createRuntimeTelegramApiResponse(true);
    }
    if (method === "sendChatAction") {
      return createRuntimeTelegramApiResponse(true);
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });
  try {
    await telegramConfig.write({
      botToken: "123:abc",
      allowedUserId: 77,
      lastUpdateId: 0,
    });
    (await getRuntimeTelegramExtension())(pi);
    const ctx = createRuntimeModelContext({
      model: modelA,
      availableModels: [modelA, modelB],
      isIdle: () => idle,
      abort: () => {
        aborted = true;
      },
    });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("telegram-connect")?.handler("", ctx);
    await waitForCondition(() =>
      runtimeEvents.some((event) => event === "send:<b>🤖 Choose a model:</b>"),
    );
    secondUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 2,
          message: {
            message_id: 51,
            chat: { id: 99, type: "private" },
            from: { id: 77, is_bot: false, first_name: "Test" },
            text: "first request",
          },
        },
      ]),
    );
    await waitForCondition(() =>
      runtimeEvents.some(
        (event) => event === "dispatch:[telegram] first request",
      ),
    );
    idle = false;
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("tool_execution_start")?.({}, ctx);
    thirdUpdates.resolve(
      createRuntimeTelegramApiResponse([
        {
          _: "other",
          update_id: 3,
          callback_query: {
            id: "cb-2",
            from: { id: 77, is_bot: false, first_name: "Test" },
            data: "model:pick:1",
            message: {
              message_id: 100,
              chat: { id: 99, type: "private" },
            },
          },
        },
      ]),
    );
    await waitForCondition(() =>
      callbackAnswers.includes(
        "Switched to claude-b. Restarting after the current tool finishes…",
      ),
    );
    assert.deepEqual(setModels, ["anthropic/claude-b"]);
    assert.equal(aborted, false);
    await handlers.get("tool_execution_end")?.({}, ctx);
    await waitForCondition(() => aborted);
    idle = true;
    await handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      ctx,
    );
    await waitForCondition(() =>
      runtimeEvents.some((event) =>
        event.includes(
          "dispatch:[telegram] Continue the interrupted previous Telegram request using the newly selected model (anthropic/claude-b)",
        ),
      ),
    );
    await handlers.get("session_shutdown")?.({}, ctx);
  } finally {
    restoreFetch();
    await telegramConfig.restore();
  }
});
