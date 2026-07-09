/**
 * Regression tests for Telegram setup prompt helpers
 * Exercises bot-token prompt defaults, setup success/failure, and prompt-runtime guard cleanup
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER,
  createTelegramSetupPromptRuntime,
  getTelegramBotTokenInputDefault,
  getTelegramBotTokenPromptSpec,
  runTelegramSetup,
} from "../lib/setup.ts";

test("Setup token defaults prefer config, then env aliases, then placeholder", () => {
  assert.equal(
    getTelegramBotTokenInputDefault(
      { TELEGRAM_BOT_TOKEN: " env-token " },
      " config-token ",
    ),
    "config-token",
  );
  assert.equal(
    getTelegramBotTokenInputDefault({ TELEGRAM_KEY: " env-key " }),
    "env-key",
  );
  assert.equal(
    getTelegramBotTokenInputDefault({}),
    TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER,
  );
});

test("Setup prompt spec uses editor for real tokens and input for placeholder", () => {
  assert.deepEqual(getTelegramBotTokenPromptSpec({}, "123:abc"), {
    method: "editor",
    value: "123:abc",
  });
  assert.deepEqual(getTelegramBotTokenPromptSpec({}), {
    method: "input",
    value: TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER,
  });
});

test("Setup runner validates token, persists config, starts polling, and updates status", async () => {
  const calls: string[] = [];
  let persisted: unknown;
  const nextConfig = await runTelegramSetup({
    hasUI: true,
    env: {},
    config: { allowedUserId: 42 },
    promptInput: async (_label, value) => {
      calls.push(`input:${value}`);
      return "token";
    },
    promptEditor: async () => {
      throw new Error("must not use editor for placeholder");
    },
    getMe: async (botToken) => {
      calls.push(`getMe:${botToken}`);
      return { ok: true, result: { id: 7, username: "demo_bot" } };
    },
    persistConfig: async (config) => {
      persisted = config;
      calls.push("persist");
    },
    notify: (message, level) => calls.push(`${level}:${message}`),
    startPolling: () => ({ ok: true, message: "Polling started" }),
    updateStatus: () => calls.push("status"),
  });

  assert.deepEqual(nextConfig, {
    status: "success",
    config: {
      allowedUserId: 42,
      botToken: "token",
      botId: 7,
      botUsername: "demo_bot",
    },
  });
  assert.deepEqual(persisted, nextConfig.config);
  assert.deepEqual(calls, [
    `input:${TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER}`,
    "getMe:token",
    "persist",
    "info:Telegram bot connected: @demo_bot",
    "info:Send /start to your bot in Telegram to pair this extension with your account.",
    "info:Polling started",
    "status",
  ]);
});

test("Setup runner reports invalid tokens without persisting or starting polling", async () => {
  const calls: string[] = [];
  const nextConfig = await runTelegramSetup({
    hasUI: true,
    env: {},
    config: {},
    promptInput: async () => "bad-token",
    promptEditor: async () => "bad-token",
    getMe: async () => ({ ok: false, description: "Unauthorized" }),
    persistConfig: async () => {
      calls.push("persist");
    },
    notify: (message, level) => calls.push(`${level}:${message}`),
    startPolling: () => calls.push("start"),
    updateStatus: () => calls.push("status"),
  });

  assert.deepEqual(nextConfig, { status: "validation-failed" });
  assert.deepEqual(calls, ["error:Unauthorized"]);
});

test("Setup runner distinguishes cancellation and polling startup failure", async () => {
  const baseDeps = {
    hasUI: true,
    env: {},
    config: {},
    promptEditor: async () => undefined,
    getMe: async () => ({
      ok: true,
      result: { id: 7, username: "demo_bot" },
    }),
    persistConfig: async () => undefined,
    notify: () => undefined,
    updateStatus: () => undefined,
  };
  assert.deepEqual(
    await runTelegramSetup({
      ...baseDeps,
      hasUI: false,
      promptInput: async () => "token",
      startPolling: () => ({ ok: true }),
    }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await runTelegramSetup({
      ...baseDeps,
      promptInput: async () => undefined,
      startPolling: () => ({ ok: true }),
    }),
    { status: "cancelled" },
  );
  const failed = await runTelegramSetup({
    ...baseDeps,
    promptInput: async () => "token",
    startPolling: () => ({ ok: false, message: "Polling unavailable" }),
  });
  assert.equal(failed.status, "polling-failed");
  assert.equal(
    failed.status === "polling-failed" && failed.config.botToken,
    "token",
  );
});

test("Setup prompt runtime stores config before starting polling", async () => {
  const calls: string[] = [];
  let currentToken: string | undefined;
  const runtime = createTelegramSetupPromptRuntime({
    env: {},
    getConfig: () => ({}),
    setConfig: (config) => {
      currentToken = config.botToken;
      calls.push(`set:${config.botToken}`);
    },
    setupGuard: {
      start: () => true,
      finish: () => calls.push("finish"),
    },
    getMe: async () => ({ ok: true, result: { id: 7, username: "demo_bot" } }),
    persistConfig: async (config) => {
      calls.push(`persist:${config.botToken}`);
    },
    startPolling: () => calls.push(`start:${currentToken ?? "missing"}`),
    updateStatus: () => calls.push("status"),
  });

  await runtime({
    hasUI: true,
    ui: {
      input: async () => "token",
      editor: async () => "token",
      notify: (message) => calls.push(`notify:${message}`),
    },
  });

  assert.deepEqual(calls, [
    "persist:token",
    "set:token",
    "notify:Telegram bot connected: @demo_bot",
    "notify:Send /start to your bot in Telegram to pair this extension with your account.",
    "start:token",
    "status",
    "finish",
  ]);
});

test("Setup prompt runtime reports token check errors and always finishes", async () => {
  const calls: string[] = [];
  let locked = false;
  const runtime = createTelegramSetupPromptRuntime({
    env: {},
    getConfig: () => ({}),
    setConfig: () => calls.push("set-config"),
    setupGuard: {
      start: () => {
        if (locked) return false;
        locked = true;
        calls.push("guard-start");
        return true;
      },
      finish: () => {
        locked = false;
        calls.push("guard-finish");
      },
    },
    getMe: async () => {
      throw new Error("network down");
    },
    persistConfig: async () => {
      calls.push("persist");
    },
    startPolling: () => calls.push("start"),
    updateStatus: () => calls.push("status"),
    recordRuntimeEvent: (category, error) =>
      calls.push(`${category}:${(error as Error).message}`),
  });

  await runtime({
    hasUI: true,
    ui: {
      input: async () => "token",
      editor: async () => "token",
      notify: (message) => calls.push(`notify:${message}`),
    },
  });

  assert.deepEqual(calls, [
    "guard-start",
    "notify:Telegram API check failed: network down",
    "guard-finish",
  ]);
  assert.equal(locked, false);
});
