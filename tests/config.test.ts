/**
 * Regression tests for Telegram config and setup prompt defaults
 * Covers persisted config state plus token-prefill priority across stored config, environment variables, and placeholder fallback
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
import { join } from "node:path";
import test from "node:test";

import { runNodeEval } from "./fixtures/node-eval.ts";
import type { TelegramConfig } from "../lib/config.ts";
import {
  createTelegramConfigControls,
  createTelegramConfigStore,
  createTelegramPollingOffsetPersister,
  createTelegramProactivePushTargetGetter,
  createTelegramTimeInjectionModeGetter,
  createTelegramTimeInjectionModeSetter,
  createTelegramUserPairingRuntime,
  createTelegramVoiceReplyModeConfiguredChecker,
  createTelegramVoiceReplyModeGetter,
  createTelegramVoiceReplyModeSetter,
  getTelegramAuthorizationState,
  isValidTelegramProfileName,
  normalizeTelegramDefaultProfileConfig,
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

test("Telegram profile names allow only lowercase letters and digits", () => {
  assert.equal(isValidTelegramProfileName("work2"), true);
  assert.equal(isValidTelegramProfileName("previous"), true);
  assert.equal(isValidTelegramProfileName("prev"), true);
  assert.equal(isValidTelegramProfileName("default"), true);
  for (const name of [
    "main",
    "active",
    "Work",
    "work-one",
    "work_one",
    "work.one",
    "work one",
    "",
  ]) {
    assert.equal(isValidTelegramProfileName(name), false, name);
  }
});

test("Telegram config helper returns empty config when file is absent", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-missing-config-"));
  assert.deepEqual(
    await readTelegramConfig(join(agentDir, "telegram.json")),
    {},
  );
});

test("Telegram config reads valid atomic snapshots without acquiring the transaction guard", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-config-read-"));
  const configPath = join(agentDir, "telegram.json");
  const transactionPath = `${configPath}.transaction`;
  const generation = "10000000-0000-4000-8000-000000000001";
  await writeFile(configPath, '{"botToken":"123:abc"}\n', "utf8");
  await mkdir(transactionPath);
  await writeFile(
    join(transactionPath, `owner.${generation}.json`),
    `${JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now(), generation })}\n`,
    "utf8",
  );
  try {
    assert.deepEqual(await readTelegramConfig(configPath), {
      botToken: "123:abc",
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
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
  if (process.platform !== "win32") {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    (await readdir(agentDir)).filter((entry) => entry.includes(".tmp-")),
    [],
  );
});

test("Telegram default profile normalization moves legacy root identity", () => {
  const normalized = normalizeTelegramDefaultProfileConfig({
    botToken: "123:abc",
    botUsername: "demo_bot",
    botId: 123,
    allowedUserId: 7,
    lastUpdateId: 9,
    voice: { replyMode: "mirror" },
    profiles: { work: { botToken: "456:def" } },
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    voice: { replyMode: "mirror" },
    profiles: {
      default: {
        botToken: "123:abc",
        botUsername: "demo_bot",
        botId: 123,
        allowedUserId: 7,
        lastUpdateId: 9,
      },
      work: { botToken: "456:def" },
    },
  });
});

test("Telegram default profile normalization rejects conflicting identity", () => {
  assert.throws(
    () =>
      normalizeTelegramDefaultProfileConfig({
        botToken: "123:abc",
        profiles: { default: { botToken: "456:def" } },
      }),
    /Conflicting Telegram default profile identity/,
  );
});

test("Telegram default profile normalization collapses identical duplicates", () => {
  const normalized = normalizeTelegramDefaultProfileConfig({
    botToken: "123:abc",
    allowedUserId: 7,
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
      work: { botToken: "456:def" },
    },
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
      work: { botToken: "456:def" },
    },
  });
});

test("Telegram default profile normalization merges non-conflicting fields", () => {
  const normalized = normalizeTelegramDefaultProfileConfig({
    botToken: "123:abc",
    allowedUserId: 7,
    profiles: {
      default: { botToken: "123:abc", botUsername: "demo_bot" },
    },
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    profiles: {
      default: {
        botToken: "123:abc",
        botUsername: "demo_bot",
        allowedUserId: 7,
      },
    },
  });
});

test("Telegram default profile normalization accepts root session fields without a duplicate token", () => {
  const normalized = normalizeTelegramDefaultProfileConfig({
    lastUpdateId: 9,
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
    },
  });

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    profiles: {
      default: {
        botToken: "123:abc",
        allowedUserId: 7,
        lastUpdateId: 9,
      },
    },
  });
});

test("Telegram config load rejects conflicting default identity without mutation", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-default-conflict-"),
  );
  const configPath = join(agentDir, "telegram.json");
  const original = `${JSON.stringify(
    {
      botToken: "123:abc",
      profiles: { default: { botToken: "456:def" } },
    },
    null,
    2,
  )}\n`;
  await writeFile(configPath, original, "utf8");
  try {
    const store = createTelegramConfigStore({ agentDir, configPath });
    await assert.rejects(
      store.load(),
      /Conflicting Telegram default profile identity/,
    );
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Telegram config load atomically normalizes the default profile", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-default-profile-"),
  );
  const configPath = join(agentDir, "telegram.json");
  await writeTelegramConfig(agentDir, configPath, {
    botToken: "123:abc",
    allowedUserId: 7,
    assistant: { proactivePush: false },
  });
  const store = createTelegramConfigStore({ agentDir, configPath });

  await store.load();

  assert.equal(store.getBotToken(), "123:abc");
  assert.equal(store.getAllowedUserId(), 7);
  assert.deepEqual(await readTelegramConfig(configPath), {
    assistant: { proactivePush: false },
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
    },
  });
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
    voice: { replyMode: "mirror" },
    profiles: {
      default: {
        botToken: "default-token",
        botUsername: "default_bot",
        allowedUserId: 1,
      },
      omp: {
        botToken: "omp-token",
        botUsername: "omp_bot",
        allowedUserId: 3,
        lastUpdateId: 99,
      },
    },
  });
});

test("Telegram config transactions merge concurrent profile offsets and global fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-config-race-"));
  const configPath = join(dir, "telegram.json");
  const startPath = join(dir, "start");
  await writeFile(
    configPath,
    JSON.stringify({
      botToken: "default-token",
      profiles: {
        work: { botToken: "work-token", lastUpdateId: 1 },
        personal: { botToken: "personal-token", lastUpdateId: 2 },
      },
    }),
  );
  const moduleUrl = new URL("../lib/config.ts", import.meta.url).href;
  const children = [
    { profile: "work", offset: "11", field: "proactive" },
    { profile: "personal", offset: "22", field: "voice" },
  ].map(({ profile, offset, field }) => {
    const readyPath = join(dir, `ready-${profile}`);
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createTelegramConfigStore } from ${JSON.stringify(moduleUrl)};
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const store = createTelegramConfigStore({
        agentDir: process.env.AGENT_DIR,
        configPath: process.env.CONFIG_PATH,
      });
      await store.load();
      if (!store.activateProfile(process.env.PROFILE)) throw new Error("profile missing");
      writeFileSync(process.env.READY_PATH, "ready");
      while (!existsSync(process.env.START_PATH)) sleep(2);
      store.update((config) => {
        config.lastUpdateId = Number(process.env.OFFSET);
        if (process.env.FIELD === "proactive") config.assistant = { ...(config.assistant ?? {}), proactivePush: true };
        else config.voice = { ...(config.voice ?? {}), replyMode: "mirror" };
      });
      await store.persist();
    `;
    const done = runNodeEval(source, {
      env: {
        AGENT_DIR: dir,
        CONFIG_PATH: configPath,
        PROFILE: profile,
        OFFSET: offset,
        FIELD: field,
        READY_PATH: readyPath,
        START_PATH: startPath,
      },
    }).then(({ code, stderr }) => {
      if (code !== 0) throw new Error(`config child exited ${code}: ${stderr}`);
    });
    return { readyPath, done };
  });
  try {
    const deadline = Date.now() + 3000;
    while (
      !children.every((child) => existsSync(child.readyPath)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      children.every((child) => existsSync(child.readyPath)),
      true,
    );
    await writeFile(startPath, "start");
    await Promise.all(children.map((child) => child.done));

    assert.deepEqual(await readTelegramConfig(configPath), {
      assistant: { proactivePush: true },
      voice: { replyMode: "mirror" },
      profiles: {
        default: { botToken: "default-token" },
        work: { botToken: "work-token", lastUpdateId: 11 },
        personal: { botToken: "personal-token", lastUpdateId: 22 },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Stale config persistence preserves unrelated global and profile disk deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-config-delta-"));
  const configPath = join(dir, "telegram.json");
  try {
    await writeTelegramConfig(dir, configPath, {
      profiles: {
        default: { botToken: "default-token" },
        work: { botToken: "work-token", lastUpdateId: 10 },
      },
      assistant: { rendering: "rich" },
    });
    const stale = createTelegramConfigStore({ agentDir: dir, configPath });
    await stale.load();

    await writeTelegramConfig(dir, configPath, {
      profiles: {
        default: { botToken: "default-token" },
        work: {
          botToken: "work-token",
          lastUpdateId: 10,
          allowedUserId: 42,
        },
      },
      assistant: { rendering: "rich" },
      time: { interval: 5000, injectionMode: "interval" },
    });
    stale.update((config) => {
      config.voice = { replyMode: "mirror" };
    });
    await stale.persist();

    assert.deepEqual(await readTelegramConfig(configPath), {
      profiles: {
        default: { botToken: "default-token" },
        work: {
          botToken: "work-token",
          lastUpdateId: 10,
          allowedUserId: 42,
        },
      },
      assistant: { rendering: "rich" },
      time: { interval: 5000, injectionMode: "interval" },
      voice: { replyMode: "mirror" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("No-op config persistence adopts newer disk state without rewriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-config-noop-"));
  const configPath = join(dir, "telegram.json");
  try {
    await writeTelegramConfig(dir, configPath, {
      profiles: { default: { botToken: "default-token" } },
    });
    const store = createTelegramConfigStore({ agentDir: dir, configPath });
    await store.load();
    await writeTelegramConfig(dir, configPath, {
      profiles: { default: { botToken: "default-token" } },
      time: { interval: 5000, injectionMode: "interval" },
    });
    const stableTime = new Date("2001-01-01T00:00:00.000Z");
    await utimes(configPath, stableTime, stableTime);

    await store.persist();

    assert.deepEqual(store.get().time, {
      interval: 5000,
      injectionMode: "interval",
    });
    assert.deepEqual(await readTelegramConfig(configPath), {
      profiles: { default: { botToken: "default-token" } },
      time: { interval: 5000, injectionMode: "interval" },
    });
    assert.ok(
      Math.abs((await stat(configPath)).mtimeMs - stableTime.getTime()) < 5,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Telegram config keeps same-profile polling offsets monotonic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-config-offset-"));
  const configPath = join(dir, "telegram.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profiles: { work: { botToken: "work-token", lastUpdateId: 10 } },
    }),
  );
  try {
    const stale = createTelegramConfigStore({ agentDir: dir, configPath });
    const replacement = createTelegramConfigStore({
      agentDir: dir,
      configPath,
    });
    await stale.load();
    await replacement.load();
    assert.equal(stale.activateProfile("work"), true);
    assert.equal(replacement.activateProfile("work"), true);
    const stalePollingConfig = stale.get();
    stalePollingConfig.lastUpdateId = 12;
    const replacementPollingConfig = replacement.get();
    replacementPollingConfig.lastUpdateId = 20;

    await replacement.persist(replacementPollingConfig);
    await stale.persist(stalePollingConfig);

    assert.equal(
      (await readTelegramConfig(configPath)).profiles?.work.lastUpdateId,
      20,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("Telegram voice reply mode helpers normalize legacy manual to hidden", () => {
  let config: TelegramConfig = {};
  const store = { get: () => config };
  const getMode = createTelegramVoiceReplyModeGetter(store);
  const isConfigured = createTelegramVoiceReplyModeConfiguredChecker(store);

  assert.equal(getMode(), "hidden");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "manual" } } as unknown as TelegramConfig;
  assert.equal(getMode(), "hidden");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "invalid" } } as unknown as TelegramConfig;
  assert.equal(getMode(), "hidden");
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
    profiles: { default: { botToken: "123:abc" } },
    voice: { replyMode: "mirror" },
  });

  await setMode("hidden");

  assert.equal(store.get().voice, undefined);
  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
  });
});

test("Telegram proactive push defaults on and reads only assistant.proactivePush", () => {
  const store = createTelegramConfigStore({
    initialConfig: { proactivePush: false } as unknown as TelegramConfig,
  });
  const controls = createTelegramConfigControls(store);

  assert.equal(controls.isProactivePushEnabled(), true);
  store.set({ assistant: { proactivePush: false } });
  assert.equal(controls.isProactivePushEnabled(), false);
  store.set({ assistant: { proactivePush: true } });
  assert.equal(controls.isProactivePushEnabled(), true);
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
  const staleReaderControls = createTelegramConfigControls(firstStore);
  const controls = createTelegramConfigControls(secondStore);
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), true);

  await setVoiceMode("mirror");
  await controls.setProactivePushEnabled(true);
  await controls.setDraftPreviewsEnabled(true);
  await controls.setAssistantRenderingMode("html");
  await controls.setAutomaticThreadCleanupEnabled(false);
  assert.equal(staleReaderControls.isAutomaticThreadCleanupEnabled(), true);
  assert.equal(
    await staleReaderControls.resolveAutomaticThreadCleanupEnabled(),
    false,
  );

  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: {
      draftPreviews: true,
      rendering: "html",
      proactivePush: true,
    },
    voice: { replyMode: "mirror" },
    threads: { automaticCleanup: false },
  });
  assert.equal(controls.getAssistantRenderingMode(), "html");
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), false);
  assert.deepEqual(secondStore.get().voice, { replyMode: "mirror" });
});

test("Automatic thread cleanup fails closed after invalid shared config recovery", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-invalid-cleanup-setting-"),
  );
  const configPath = join(agentDir, "telegram.json");
  await writeTelegramConfig(agentDir, configPath, {
    profiles: { default: { botToken: "123:abc" } },
    threads: { automaticCleanup: false },
  });
  const store = createTelegramConfigStore({ agentDir, configPath });
  await store.load();
  const controls = createTelegramConfigControls(store);
  await writeFile(configPath, "{invalid", "utf8");

  await assert.rejects(
    controls.resolveAutomaticThreadCleanupEnabled(),
    /unavailable after invalid Telegram config recovery/,
  );
  assert.equal(store.didLastLoadRecoverInvalidConfig(), true);
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), false);
});

test("Polling offset persistence cannot erase settings written after poll start", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-poll-settings-"));
  const configPath = join(agentDir, "telegram.json");
  await writeTelegramConfig(agentDir, configPath, {
    botToken: "123:abc",
    lastUpdateId: 10,
    assistant: { rendering: "rich", draftPreviews: false },
  });
  const store = createTelegramConfigStore({ agentDir, configPath });
  await store.load();
  const stalePollingConfig = store.get();

  await createTelegramVoiceReplyModeSetter(store)("mirror");
  await createTelegramConfigControls(store).setProactivePushEnabled(false);
  stalePollingConfig.lastUpdateId = 11;
  await createTelegramPollingOffsetPersister(store)(stalePollingConfig);

  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: {
      default: { botToken: "123:abc", lastUpdateId: 11 },
    },
    assistant: {
      rendering: "rich",
      draftPreviews: false,
      proactivePush: false,
    },
    voice: { replyMode: "mirror" },
  });
});

test("Stale same-profile polling persistence preserves settings from another instance", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-cross-instance-settings-"),
  );
  const configPath = join(agentDir, "telegram.json");
  try {
    await writeTelegramConfig(agentDir, configPath, {
      botToken: "123:abc",
      lastUpdateId: 10,
      assistant: { rendering: "rich", draftPreviews: false },
    });
    const settingsStore = createTelegramConfigStore({ agentDir, configPath });
    const pollingStore = createTelegramConfigStore({ agentDir, configPath });
    await settingsStore.load();
    await pollingStore.load();
    const stalePollingConfig = pollingStore.get();

    await createTelegramVoiceReplyModeSetter(settingsStore)("mirror");
    await createTelegramConfigControls(settingsStore).setProactivePushEnabled(
      false,
    );
    stalePollingConfig.lastUpdateId = 11;
    await createTelegramPollingOffsetPersister(pollingStore)(
      stalePollingConfig,
    );

    assert.deepEqual(await readTelegramConfig(configPath), {
      profiles: {
        default: { botToken: "123:abc", lastUpdateId: 11 },
      },
      assistant: {
        rendering: "rich",
        draftPreviews: false,
        proactivePush: false,
      },
      voice: { replyMode: "mirror" },
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
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
    profiles: { default: { botToken: "123:abc" } },
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
    profiles: { default: { botToken: "123:abc" } },
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
    profiles: { default: { botToken: "123:abc" } },
    time: { interval: 5000, injectionMode: "interval" },
  });

  await setMode("hidden");

  assert.equal(getMode(), "hidden");
  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
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
    profiles: { default: { botToken: "initial" } },
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
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    profiles: {
      default: { botToken: "initial", allowedUserId: 43 },
    },
  });
  store.set({ botToken: "next" });
  assert.deepEqual(store.get(), {
    profiles: { default: { botToken: "next" } },
    botToken: "next",
  });
  await store.load();
  assert.deepEqual(store.get(), {
    inboundHandlers: [{ type: "text", template: "translate" }],
    attachmentHandlers: [{ mime: "audio/*", template: "transcribe {file}" }],
    profiles: {
      default: { botToken: "initial", allowedUserId: 43 },
    },
    botToken: "initial",
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
    "set:demo_bot",
    "persist:new-token",
    "notify:info:Telegram bot connected: @demo_bot",
    "notify:info:Send /start to your bot in Telegram to pair this extension with your account.",
    "poll",
    "status",
    "finish",
    "start",
  ]);
});
