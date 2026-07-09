/**
 * Regression tests for Telegram config and setup prompt defaults
 * Covers persisted config state plus token-prefill priority across stored config, environment variables, and placeholder fallback
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TelegramConfig } from "../lib/config.ts";
import {
  createTelegramConfigControls,
  createTelegramConfigStore,
  createTelegramProactivePushTargetGetter,
  createTelegramTimeInjectionModeGetter,
  createTelegramTimeInjectionModeSetter,
  createTelegramUserPairingRuntime,
  createTelegramVoiceReplyModeConfiguredChecker,
  createTelegramVoiceReplyModeGetter,
  createTelegramVoiceReplyModeSetter,
  getTelegramAuthorizationState,
  pairTelegramUserIfNeeded,
  readTelegramConfig,
  setGlobalTelegramConfigRuntime,
  updateTelegramVoiceConfig,
  writeTelegramConfig,
} from "../lib/config.ts";
import { createTelegramSettingsMenuRuntime } from "../lib/menu-settings.ts";
import {
  createTelegramSetupPromptRuntime,
  getTelegramBotTokenInputDefault,
  getTelegramBotTokenPromptSpec,
  runTelegramSetup,
} from "../lib/setup.ts";

test("Telegram config helper returns empty config when file is absent", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-missing-config-"));
  assert.deepEqual(
    await readTelegramConfig(join(agentDir, "telegram.json")),
    {},
  );
});

test("Telegram proactive target getter prefers active then assigned targets", () => {
  const target = createTelegramProactivePushTargetGetter({
    getActiveTurnTarget: () => undefined,
    getAssignedTarget: () => ({ chatId: -1007, threadId: 42 }),
    getAllowedUserId: () => 7,
  });
  assert.deepEqual(target(), { chatId: -1007, threadId: 42 });

  const activeTarget = createTelegramProactivePushTargetGetter({
    getActiveTurnTarget: () => ({ chatId: -1008, threadId: 99 }),
    getAssignedTarget: () => ({ chatId: -1007, threadId: 42 }),
    getAllowedUserId: () => 7,
  });
  assert.deepEqual(activeTarget(), { chatId: -1008, threadId: 99 });

  const privateTarget = createTelegramProactivePushTargetGetter({
    getActiveTurnTarget: () => undefined,
    getAssignedTarget: () => undefined,
    getAllowedUserId: () => 7,
  });
  assert.deepEqual(privateTarget(), { chatId: 7 });
});

test("Telegram config helpers persist and reload config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-config-"));
  const configPath = join(agentDir, "telegram.json");
  const config = {
    botToken: "123:abc",
    botUsername: "demo_bot",
    allowedUserId: 42,
  };
  await writeTelegramConfig(agentDir, configPath, config);
  const reloaded = await readTelegramConfig(configPath);
  assert.deepEqual(reloaded, config);
  const raw = await readFile(configPath, "utf8");
  assert.match(raw, /demo_bot/);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(agentDir)).filter((entry) => entry.includes(".tmp-")),
    [],
  );
});

test("Telegram config store persists active named profile session fields without overwriting default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-profile-config-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    agentDir,
    configPath,
    initialConfig: {
      botToken: "default-token",
      botUsername: "default_bot",
      allowedUserId: 1,
      voice: { replyMode: "mirror" },
      profiles: {
        omp: {
          botToken: "omp-token",
          botUsername: "omp_bot",
          allowedUserId: 2,
          lastUpdateId: 10,
        },
      },
    },
  });

  assert.equal(store.activateProfile("omp"), true);
  assert.equal(store.getBotToken(), "omp-token");
  assert.equal(store.getAllowedUserId(), 2);
  store.setAllowedUserId(3);
  await store.persist({ ...store.get(), lastUpdateId: 99 });

  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "default-token",
    botUsername: "default_bot",
    allowedUserId: 1,
    voice: { replyMode: "mirror" },
    profiles: {
      omp: {
        botToken: "omp-token",
        botUsername: "omp_bot",
        allowedUserId: 3,
        lastUpdateId: 99,
      },
    },
  });
});

test("Telegram config store rejects missing named profile activation", () => {
  const store = createTelegramConfigStore({
    initialConfig: { profiles: { work: { botToken: "work-token" } } },
  });

  assert.equal(store.activateProfile("missing"), false);
  assert.equal(store.getActiveProfileName(), undefined);
  assert.equal(store.getBotToken(), undefined);
});

test("Telegram config load recovers invalid JSON and records a diagnostic", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-invalid-config-"));
  const configPath = join(agentDir, "telegram.json");
  await writeFile(configPath, "{not valid json", "utf8");
  const events: string[] = [];
  const store = createTelegramConfigStore({
    agentDir,
    configPath,
    initialConfig: { botToken: "previous" },
    recordRuntimeEvent: (category, error, details) => {
      events.push(
        `${category}:${error instanceof Error ? error.name : String(error)}:${details?.phase}:${String(details?.recoveryPath ?? "")}`,
      );
    },
  });

  await store.load();

  assert.deepEqual(store.get(), {});
  const entries = await readdir(agentDir);
  const recovery = entries.find((entry) =>
    entry.startsWith("telegram.json.invalid-"),
  );
  assert.ok(recovery);
  assert.equal(
    await readFile(join(agentDir, recovery), "utf8"),
    "{not valid json",
  );
  assert.equal(entries.includes("telegram.json"), false);
  assert.equal(events.length, 1);
  assert.match(events[0] ?? "", /^config:SyntaxError:load:/);
});

test("Telegram voice reply mode helpers distinguish implicit and explicit manual", () => {
  let config: TelegramConfig = {};
  const store = { get: () => config };
  const getMode = createTelegramVoiceReplyModeGetter(store);
  const isConfigured = createTelegramVoiceReplyModeConfiguredChecker(store);

  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "manual" } };
  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), true);

  config = { voice: { replyMode: "invalid" } } as unknown as TelegramConfig;
  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);
});

test("Telegram voice reply mode setter persists telegram.json", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-voice-mode-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    initialConfig: { botToken: "123:abc" },
    agentDir,
    configPath,
  });
  const setMode = createTelegramVoiceReplyModeSetter(store);

  await setMode("mirror");

  assert.deepEqual(store.get().voice, { replyMode: "mirror" });
  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "123:abc",
    voice: { replyMode: "mirror" },
  });

  await setMode(undefined);

  assert.equal(store.get().voice, undefined);
  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "123:abc",
  });
});

test("Telegram settings setters reload before scoped writes to preserve shared config changes", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-shared-settings-"),
  );
  const configPath = join(agentDir, "telegram.json");
  await writeTelegramConfig(agentDir, configPath, { botToken: "123:abc" });
  const firstStore = createTelegramConfigStore({ agentDir, configPath });
  const secondStore = createTelegramConfigStore({ agentDir, configPath });
  await firstStore.load();
  await secondStore.load();

  const setVoiceMode = createTelegramVoiceReplyModeSetter(firstStore);
  const controls = createTelegramConfigControls(secondStore);

  await setVoiceMode("mirror");
  await controls.setProactivePushEnabled(true);
  await controls.setDraftPreviewsEnabled(true);
  await controls.setAssistantRenderingMode("html");

  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "123:abc",
    proactivePush: true,
    assistant: { draftPreviews: true, rendering: "html" },
    voice: { replyMode: "mirror" },
  });
  assert.equal(controls.getAssistantRenderingMode(), "html");
  assert.deepEqual(secondStore.get().voice, { replyMode: "mirror" });
});

test("Telegram draft preview config reads and migrates legacy rich flag", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-draft-legacy-"));
  const configPath = join(agentDir, "telegram.json");
  await writeTelegramConfig(agentDir, configPath, {
    botToken: "123:abc",
    richDraftPreviews: true,
  });
  const store = createTelegramConfigStore({ agentDir, configPath });
  await store.load();
  const controls = createTelegramConfigControls(store);

  assert.equal(controls.areDraftPreviewsEnabled(), true);
  await controls.setDraftPreviewsEnabled(false);
  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "123:abc",
    assistant: { draftPreviews: false },
  });
});

test("Telegram settings menu callbacks persist voice and time settings to telegram.json", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-settings-callbacks-"),
  );
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    initialConfig: { botToken: "123:abc" },
    agentDir,
    configPath,
  });
  const controls = createTelegramConfigControls(store);
  const state = {
    chatId: 1,
    messageId: 2,
    mode: "settings" as const,
    page: 0,
    scope: "all" as const,
    scopedModels: [],
    allModels: [],
  };
  const runtime = createTelegramSettingsMenuRuntime({
    ...controls,
    getModelMenuState: async () => state,
    getStoredModelMenuState: () => state,
    storeModelMenuState: () => {},
    editInteractiveMessage: async () => {},
    sendInteractiveMessage: async () => state.messageId,
    answerCallbackQuery: async () => {},
  });

  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "voice",
        data: "settings:set:voice-reply:mirror",
        message: { message_id: state.messageId },
      },
      {},
    ),
    true,
  );
  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "time",
        data: "settings:set:time-injection:always",
        message: { message_id: state.messageId },
      },
      {},
    ),
    true,
  );
  assert.equal(
    await runtime.handleCallbackQuery(
      {
        id: "drafts",
        data: "settings:set:draft-previews:on",
        message: { message_id: state.messageId },
      },
      {},
    ),
    true,
  );
  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "123:abc",
    assistant: { draftPreviews: true },
    voice: { replyMode: "mirror" },
    time: { injectionMode: "always" },
  });
});

test("Telegram time injection mode setter persists telegram.json", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-time-mode-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    initialConfig: { botToken: "123:abc", time: { interval: 5000 } },
    agentDir,
    configPath,
  });
  const getMode = createTelegramTimeInjectionModeGetter(store);
  const setMode = createTelegramTimeInjectionModeSetter(store);

  assert.equal(getMode(), "hidden");

  await setMode("interval");

  assert.equal(getMode(), "interval");
  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "123:abc",
    time: { interval: 5000, injectionMode: "interval" },
  });

  await setMode("hidden");

  assert.equal(getMode(), "hidden");
  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "123:abc",
    time: { interval: 5000 },
  });
});

test("Telegram config runtime lets extensions update live voice config", async () => {
  let voice: TelegramConfig["voice"] | undefined;
  setGlobalTelegramConfigRuntime({
    updateVoiceConfig: (nextVoice) => {
      voice = nextVoice;
    },
  });
  try {
    assert.equal(updateTelegramVoiceConfig({ replyMode: "mirror" }), true);
    assert.deepEqual(voice, { replyMode: "mirror" });
  } finally {
    setGlobalTelegramConfigRuntime(undefined);
  }
  assert.equal(updateTelegramVoiceConfig({ replyMode: "always" }), false);
});

test("Telegram config store owns load, mutation, and persistence", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-store-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    initialConfig: {
      botToken: "initial",
      inboundHandlers: [{ type: "text", template: "translate" }],
      attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    },
    agentDir,
    configPath,
  });
  assert.deepEqual(store.get(), {
    botToken: "initial",
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
  });
  store.update((config) => {
    config.allowedUserId = 42;
  });
  assert.equal(store.getBotToken(), "initial");
  assert.equal(store.hasBotToken(), true);
  assert.equal(store.getAllowedUserId(), 42);
  assert.deepEqual(store.getInboundHandlers(), [
    { type: "text", template: "translate" },
    { mime: "audio/*", template: "transcribe {file}" },
  ]);
  assert.deepEqual(store.getAttachmentHandlers(), [
    { mime: "audio/*", template: "transcribe {file}" },
  ]);
  store.setAllowedUserId(43);
  assert.equal(store.getAllowedUserId(), 43);
  await store.persist();
  assert.deepEqual(await readTelegramConfig(configPath), {
    botToken: "initial",
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    allowedUserId: 43,
  });
  store.set({ botToken: "next" });
  assert.deepEqual(store.get(), { botToken: "next" });
  await store.load();
  assert.deepEqual(store.get(), {
    botToken: "initial",
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    allowedUserId: 43,
  });
});

test("Telegram config helpers classify authorization state for pair, allow, and deny", () => {
  assert.deepEqual(getTelegramAuthorizationState(10), {
    kind: "pair",
    userId: 10,
  });
  assert.deepEqual(getTelegramAuthorizationState(10, 10), { kind: "allow" });
  assert.deepEqual(getTelegramAuthorizationState(10, 11), { kind: "deny" });
});

test("Telegram config helpers pair only when no user is configured", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
  assert.equal(
    await pairTelegramUserIfNeeded(10, {
      allowedUserId,
      ctx: "ctx",
      setAllowedUserId: (userId) => {
        allowedUserId = userId;
        events.push(`set:${userId}`);
      },
      persistConfig: async () => {
        events.push("persist");
      },
      updateStatus: (ctx) => {
        events.push(`status:${ctx}`);
      },
    }),
    true,
  );
  assert.equal(
    await pairTelegramUserIfNeeded(11, {
      allowedUserId,
      ctx: "ctx",
      setAllowedUserId: () => {
        events.push("unexpected:set");
      },
      persistConfig: async () => {
        events.push("unexpected:persist");
      },
      updateStatus: () => {
        events.push("unexpected:status");
      },
    }),
    false,
  );
  assert.equal(allowedUserId, 10);
  assert.deepEqual(events, ["set:10", "persist", "status:ctx"]);
});

test("Telegram config pairing swallows only stale context status errors", async () => {
  await assert.doesNotReject(() =>
    pairTelegramUserIfNeeded(10, {
      ctx: "ctx",
      setAllowedUserId: () => {},
      persistConfig: async () => {},
      updateStatus: () => {
        throw new Error("ctx is stale after session replacement");
      },
    }),
  );
  await assert.rejects(
    () =>
      pairTelegramUserIfNeeded(10, {
        ctx: "ctx",
        setAllowedUserId: () => {},
        persistConfig: async () => {},
        updateStatus: () => {
          throw new Error("status broke");
        },
      }),
    /status broke/,
  );
});

test("Telegram config pairing runtime binds config and status ports", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
  const runtime = createTelegramUserPairingRuntime({
    getAllowedUserId: () => allowedUserId,
    setAllowedUserId: (userId) => {
      allowedUserId = userId;
      events.push(`set:${userId}`);
    },
    persistConfig: async () => {
      events.push("persist");
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
  });
  assert.equal(await runtime.pairIfNeeded(7, "ctx"), true);
  assert.equal(await runtime.pairIfNeeded(8, "ctx"), false);
  assert.deepEqual(events, ["set:7", "persist", "status:ctx"]);
});

test("Bot token input prefers stored config over env vars", () => {
  const value = getTelegramBotTokenInputDefault(
    {
      TELEGRAM_KEY: "key-last",
      TELEGRAM_TOKEN: "token-third",
      TELEGRAM_BOT_KEY: "key-second",
      TELEGRAM_BOT_TOKEN: "token-first",
    },
    "stored-token",
  );
  assert.equal(value, "stored-token");
});

test("Bot token input prefers the first configured Telegram env var when no config exists", () => {
  const value = getTelegramBotTokenInputDefault({
    TELEGRAM_KEY: "key-last",
    TELEGRAM_TOKEN: "token-third",
    TELEGRAM_BOT_KEY: "key-second",
    TELEGRAM_BOT_TOKEN: "token-first",
  });
  assert.equal(value, "token-first");
});

test("Bot token prompt uses the editor when a real prefill exists", () => {
  const prompt = getTelegramBotTokenPromptSpec({
    TELEGRAM_BOT_TOKEN: "token-first",
  });
  assert.deepEqual(prompt, {
    method: "editor",
    value: "token-first",
  });
});

test("Bot token prompt shows stored config before env values", () => {
  const prompt = getTelegramBotTokenPromptSpec(
    {
      TELEGRAM_BOT_TOKEN: "token-first",
    },
    "stored-token",
  );
  assert.deepEqual(prompt, {
    method: "editor",
    value: "stored-token",
  });
});

test("Bot token input skips blank env vars and falls back to config", () => {
  const value = getTelegramBotTokenInputDefault(
    {
      TELEGRAM_BOT_TOKEN: "   ",
      TELEGRAM_BOT_KEY: "",
      TELEGRAM_TOKEN: "  ",
    },
    "stored-token",
  );
  assert.equal(value, "stored-token");
});

test("Bot token input falls back to placeholder when no value exists", () => {
  const value = getTelegramBotTokenInputDefault({});
  assert.equal(value, "123456:ABCDEF...");
});

test("Bot token prompt uses placeholder input when no prefill exists", () => {
  const prompt = getTelegramBotTokenPromptSpec({});
  assert.deepEqual(prompt, {
    method: "input",
    value: "123456:ABCDEF...",
  });
});

test("Setup runtime prompts, validates token, persists config, and starts polling", async () => {
  const events: string[] = [];
  const nextConfig = await runTelegramSetup({
    hasUI: true,
    env: { TELEGRAM_BOT_TOKEN: "env-token" },
    config: { allowedUserId: 7 },
    promptInput: async () => {
      events.push("input");
      return undefined;
    },
    promptEditor: async (label, value) => {
      events.push(`editor:${label}:${value}`);
      return "new-token";
    },
    getMe: async (botToken) => {
      events.push(`getMe:${botToken}`);
      return { ok: true, result: { id: 42, username: "demo_bot" } };
    },
    persistConfig: async (config) => {
      events.push(`persist:${config.botToken}:${config.botUsername}`);
    },
    notify: (message, level) => {
      events.push(`notify:${level}:${message}`);
    },
    startPolling: async () => {
      events.push("poll");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  assert.deepEqual(nextConfig, {
    status: "success",
    config: {
      allowedUserId: 7,
      botToken: "new-token",
      botId: 42,
      botUsername: "demo_bot",
    },
  });
  assert.deepEqual(events, [
    "editor:Telegram bot token:env-token",
    "getMe:new-token",
    "persist:new-token:demo_bot",
    "notify:info:Telegram bot connected: @demo_bot",
    "notify:info:Send /start to your bot in Telegram to pair this extension with your account.",
    "poll",
    "status",
  ]);
});

test("Setup runtime reports invalid tokens without persisting", async () => {
  const events: string[] = [];
  const nextConfig = await runTelegramSetup({
    hasUI: true,
    env: {},
    config: {},
    promptInput: async () => "bad-token",
    promptEditor: async () => undefined,
    getMe: async () => ({ ok: false, description: "nope" }),
    persistConfig: async () => {
      events.push("persist");
    },
    notify: (message, level) => {
      events.push(`notify:${level}:${message}`);
    },
    startPolling: async () => {
      events.push("poll");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  assert.deepEqual(nextConfig, { status: "validation-failed" });
  assert.deepEqual(events, ["notify:error:nope"]);
});

test("Setup prompt runtime guards concurrent setup and stores successful config", async () => {
  const events: string[] = [];
  let config: TelegramConfig = { allowedUserId: 7 };
  let inProgress = false;
  const promptForConfig = createTelegramSetupPromptRuntime({
    env: { TELEGRAM_BOT_TOKEN: "env-token" },
    getConfig: () => config,
    setConfig: (nextConfig) => {
      config = nextConfig;
      events.push(`set:${nextConfig.botUsername}`);
    },
    setupGuard: {
      start: () => {
        events.push("start");
        if (inProgress) return false;
        inProgress = true;
        return true;
      },
      finish: () => {
        events.push("finish");
        inProgress = false;
      },
    },
    getMe: async (botToken) => {
      events.push(`getMe:${botToken}`);
      return { ok: true, result: { id: 42, username: "demo_bot" } };
    },
    persistConfig: async (nextConfig) => {
      events.push(`persist:${nextConfig.botToken}`);
    },
    startPolling: async () => {
      events.push("poll");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  await promptForConfig({
    hasUI: true,
    ui: {
      input: async () => undefined,
      editor: async (_label, value) => {
        events.push(`editor:${value}`);
        return "new-token";
      },
      notify: (message, level) => {
        events.push(`notify:${level}:${message}`);
      },
    },
  });
  inProgress = true;
  await promptForConfig({
    hasUI: true,
    ui: {
      input: async () => {
        events.push("blocked-input");
        return undefined;
      },
      editor: async () => {
        events.push("blocked-editor");
        return undefined;
      },
      notify: () => {
        events.push("blocked-notify");
      },
    },
  });
  assert.deepEqual(config, {
    allowedUserId: 7,
    botToken: "new-token",
    botId: 42,
    botUsername: "demo_bot",
  });
  assert.deepEqual(events, [
    "start",
    "editor:env-token",
    "getMe:new-token",
    "persist:new-token",
    "set:demo_bot",
    "notify:info:Telegram bot connected: @demo_bot",
    "notify:info:Send /start to your bot in Telegram to pair this extension with your account.",
    "poll",
    "status",
    "finish",
    "start",
  ]);
});
