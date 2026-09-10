/**
 * Regression tests for Telegram config and setup prompt defaults
 * Covers persisted config state plus token-prefill priority across stored config, environment variables, and placeholder fallback
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { TelegramConfig } from "../lib/config.ts";
import {
  createTelegramActiveProfileKeyGetter,
  createTelegramConfigBotIdGetter,
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
  isValidTelegramProfileName,
  normalizeTelegramDefaultProfileConfig,
  pairTelegramUserIfNeeded,
  readTelegramConfig,
  resolveTelegramThreadDisplayMode,
  setTelegramThreadDisplayMode,
  setGlobalTelegramConfigRuntime,
  updateTelegramVoiceConfig,
  writeTelegramConfig,
} from "../lib/config.ts";
import { createTelegramSettingsMenuRuntime } from "../lib/menu-settings.ts";
import { createTelegramLockRuntime } from "../lib/locks.ts";

const execFileAsync = promisify(execFile);

function legacyConfig(value: Record<string, unknown>): TelegramConfig {
  return value as TelegramConfig;
}
import {
  createTelegramSetupPromptRuntime,
  getTelegramBotTokenInputDefault,
  getTelegramBotTokenPromptSpec,
  runTelegramSetup,
} from "../lib/setup.ts";

test("Thread display mode maps legacy names and invalid values to letters", () => {
  for (const mode of [undefined, "invalid", null]) {
    assert.equal(resolveTelegramThreadDisplayMode(legacyConfig({
      threadDisplayMode: mode,
    })), "letters");
  }
  assert.equal(resolveTelegramThreadDisplayMode({ threadDisplayMode: "names" }), "letters");
  assert.equal(resolveTelegramThreadDisplayMode({ threadDisplayMode: "letters" }), "letters");
  assert.equal(resolveTelegramThreadDisplayMode({ threadDisplayMode: "directories" }), "directories");
});

test("Thread display mode persists per profile and survives effective config updates", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-display-mode-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({ agentDir, configPath, initialConfig: {
    profiles: {
      default: { botToken: "token-default", threadDisplayMode: "letters" },
      work: { botToken: "token-work", threadDisplayMode: "directories" },
    },
  } });
  try {
    assert.equal(resolveTelegramThreadDisplayMode(store.get()), "letters");
    store.activateProfile("work");
    assert.equal(resolveTelegramThreadDisplayMode(store.get()), "directories");
    store.update((config) => { config.assistant = { rendering: "html" }; });
    await store.persist();
    const saved = await readTelegramConfig(configPath);
    assert.equal(saved.threadDisplayMode, undefined);
    assert.equal(saved.profiles?.default.threadDisplayMode, "letters");
    assert.equal(saved.profiles?.work.threadDisplayMode, "directories");
    const restored = createTelegramConfigStore({ agentDir, configPath });
    await restored.load();
    assert.equal(resolveTelegramThreadDisplayMode(restored.get()), "letters");
    restored.activateProfile("work");
    assert.equal(resolveTelegramThreadDisplayMode(restored.get()), "directories");
    restored.update((config) => { config.threadDisplayMode = "names"; });
    await restored.persist();
    restored.activateProfile("default");
    assert.equal(resolveTelegramThreadDisplayMode(restored.get()), "letters");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Thread display preference writes fence authority inside the config transaction", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-display-fence-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({ agentDir, configPath,
    initialConfig: { profiles: { default: { botToken: "token" } } } });
  try {
    await store.persist();
    await setTelegramThreadDisplayMode(store, "directories", () => true);
    assert.equal(resolveTelegramThreadDisplayMode(store.get()), "directories");
    let current = true;
    const pending = store.persist({ ...store.get(), threadDisplayMode: "letters" }, {
      isCurrent: () => current,
    });
    current = false;
    await assert.rejects(pending, /originating authority/);
    assert.equal((await readTelegramConfig(configPath)).profiles?.default.threadDisplayMode, "directories");
    assert.equal(resolveTelegramThreadDisplayMode(store.get()), "directories");
    await assert.rejects(
      setTelegramThreadDisplayMode(store, "names", () => false),
      /Invalid Telegram Thread display mode/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Config projections own bot and effective profile lookup", () => {
  const store = createTelegramConfigStore({
    initialConfig: {
      profiles: {
        default: { botToken: "token-a", botId: 7 },
        work: { botToken: "token-b", botId: 8 },
      },
    },
  });
  const getBotId = createTelegramConfigBotIdGetter(store);
  const getProfileKey = createTelegramActiveProfileKeyGetter(store);
  assert.equal(getBotId(), 7);
  assert.equal(getProfileKey(), "default");
  store.activateProfile("work");
  assert.equal(getBotId(), 8);
  assert.equal(getProfileKey(), "work");
});

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

test("activity defaults absent config to verbose, fails invalid values closed, and migrates legacy verbosity on write", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-verbosity-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    agentDir,
    configPath,
    initialConfig: {
      assistant: {
        activityVerbosity: "verbose",
      },
    },
  });
  const controls = createTelegramConfigControls(store);
  store.set({});
  assert.equal(controls.getActivityVerbosity(), "verbose");
  store.set({ assistant: { activityVerbosity: "quiet" } });
  assert.equal(controls.getActivityVerbosity(), "quiet");
  store.set({ assistant: { activityVerbosity: "verbose" } });
  assert.equal(controls.getActivityVerbosity(), "verbose");
  store.set({
    assistant: {
      activity: "unexpected" as "quiet",
      activityVerbosity: "verbose",
    },
  });
  assert.equal(controls.getActivityVerbosity(), "quiet");
  await controls.setActivityVerbosity("thinking");
  assert.equal(controls.getActivityVerbosity(), "thinking");
  await controls.setActivityVerbosity("tools");
  assert.equal(controls.getActivityVerbosity(), "tools");
  await controls.setActivityVerbosity("verbose");
  assert.equal(controls.getActivityVerbosity(), "verbose");
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.assistant.activity, "verbose");
  assert.equal(persisted.assistant.activityVerbosity, undefined);
});

test("Concurrent config processes preserve independent settings mutations", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-config-processes-"));
  const configPath = join(agentDir, "telegram.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ assistant: { activity: "verbose", timeInjection: "interval" } })}\n`,
    "utf8",
  );
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "lib", "config.ts"),
  ).href;
  const script = `
    import { createTelegramConfigControls, createTelegramConfigStore } from ${JSON.stringify(moduleUrl)};
    const store = createTelegramConfigStore({
      agentDir: process.env.TEST_AGENT_DIR,
      configPath: process.env.TEST_CONFIG_PATH,
    });
    await store.load();
    const controls = createTelegramConfigControls(store);
    if (process.env.TEST_MUTATION === "activity") {
      await controls.setActivityVerbosity("quiet");
    } else {
      await controls.setTimeInjectionMode("always");
    }
  `;
  const runMutation = (mutation: "activity" | "time") =>
    execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          TEST_AGENT_DIR: agentDir,
          TEST_CONFIG_PATH: configPath,
          TEST_MUTATION: mutation,
        },
        timeout: 10_000,
      },
    );
  try {
    await Promise.all([runMutation("activity"), runMutation("time")]);
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.assistant.activity, "quiet");
    assert.equal(persisted.assistant.timeInjection, "always");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Cross-process pairing observation serializes before an owner-fenced grant", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "telegram-pair-process-order-"));
  const configPath = join(agentDir, "telegram.json");
  const locksPath = join(agentDir, "owners.json");
  const startPath = join(agentDir, "start");
  const ownerHeldPath = join(agentDir, "owner-held");
  const configModule = new URL("../lib/config.ts", import.meta.url).href;
  const locksModule = new URL("../lib/locks.ts", import.meta.url).href;
  await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { createTelegramConfigStore } from ${JSON.stringify(configModule)};
    import { createTelegramLockRuntime } from ${JSON.stringify(locksModule)};
    const store = createTelegramConfigStore({ agentDir: process.env.TEST_AGENT_DIR, configPath: process.env.TEST_CONFIG_PATH });
    await store.load();
    const deadline = Date.now() + 8000;
    while (!existsSync(process.env.TEST_START_PATH)) {
      if (Date.now() >= deadline) throw new Error("start barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    const owner = createTelegramLockRuntime({ locksPath: process.env.TEST_LOCKS_PATH, instanceId: "pair-grant-child" });
    if (!owner.acquire({ cwd: "/fixture" }).ok) throw new Error("fixture ownership unavailable");
    try {
      const allowed = await store.persistAllowedUserId(42, undefined, (publish) => owner.commitIfOwned(() => {
        writeFileSync(process.env.TEST_OWNER_HELD_PATH, "held");
        publish();
      }));
      process.stdout.write(JSON.stringify({ allowed, userId: store.getAllowedUserId() }));
    } finally { owner.release(); }
  `;
  const grant = execFileAsync(process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script], {
      env: { ...process.env, TEST_AGENT_DIR: agentDir, TEST_CONFIG_PATH: configPath,
        TEST_LOCKS_PATH: locksPath, TEST_START_PATH: startPath, TEST_OWNER_HELD_PATH: ownerHeldPath },
      timeout: 15_000,
    });
  try {
    const store = createTelegramConfigStore({ agentDir, configPath });
    await store.load();
    const tokenSha256 = createHash("sha256").update("fixture-token").digest("hex");
    const before = store.withPairingAdmission("default", tokenSha256, (excluded) => {
      fs.writeFileSync(startPath, "start");
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(ownerHeldPath)) {
        if (Date.now() >= deadline) throw new Error("owner barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      assert.equal(fs.existsSync(`${configPath}.transaction`), true);
      assert.equal(fs.existsSync(`${locksPath}.transaction`), true);
      assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).profiles.default.allowedUserId, undefined);
      return excluded;
    });
    assert.equal(before, true);
    assert.deepEqual(JSON.parse((await grant).stdout), { allowed: true, userId: 42 });
    assert.equal(store.getAllowedUserId(), undefined, "The observing process still has its original cache");
    assert.equal(store.withPairingAdmission("default", tokenSha256, (excluded) => excluded), false);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
    assert.equal(fs.existsSync(`${locksPath}.transaction`), false);
  } finally {
    await grant.catch(() => undefined);
    await rm(agentDir, { recursive: true, force: true });
  }
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
  const normalized = normalizeTelegramDefaultProfileConfig(legacyConfig({
    botToken: "123:abc",
    botUsername: "demo_bot",
    botId: 123,
    allowedUserId: 7,
    lastUpdateId: 9,
    voice: { replyMode: "mirror" },
    profiles: { work: { botToken: "456:def" } },
  }));

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
  await writeTelegramConfig(
    agentDir,
    configPath,
    legacyConfig({
      botToken: "123:abc",
      allowedUserId: 7,
      assistant: { proactivePush: false },
    }),
  );
  const store = createTelegramConfigStore({ agentDir, configPath });

  await store.load();

  assert.equal(store.getBotToken(), "123:abc");
  assert.equal(store.getAllowedUserId(), 7);
  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: {
      default: { botToken: "123:abc", allowedUserId: 7 },
    },
  });
});

test("Telegram config store persists active named profile configuration without overwriting default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-profile-config-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    agentDir,
    configPath,
    initialConfig: legacyConfig({
      botToken: "default-token",
      botUsername: "default_bot",
      allowedUserId: 1,
      voice: { replyMode: "mirror" },
      profiles: {
        omp: {
          botToken: "omp-token",
          botUsername: "omp_bot",
          allowedUserId: 2,
        },
      },
    }),
  });

  assert.equal(store.activateProfile("omp"), true);
  assert.equal(store.getBotToken(), "omp-token");
  assert.equal(store.getAllowedUserId(), 2);
  store.setAllowedUserId(3);
  await store.persist();

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
      },
    },
  });
});

test("Stale config persistence preserves unrelated global and profile disk deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-config-delta-"));
  const configPath = join(dir, "telegram.json");
  try {
    await writeTelegramConfig(dir, configPath, legacyConfig({
      profiles: {
        default: { botToken: "default-token" },
        work: { botToken: "work-token", lastUpdateId: 10 },
      },
      assistant: { rendering: "rich" },
    }));
    const stale = createTelegramConfigStore({ agentDir: dir, configPath });
    await stale.load();

    await writeTelegramConfig(dir, configPath, legacyConfig({
      profiles: {
        default: { botToken: "default-token" },
        work: {
          botToken: "work-token",
          lastUpdateId: 10,
          allowedUserId: 42,
        },
      },
      assistant: { rendering: "rich", timeInjection: "interval" },
      time: { interval: 5000 },
    }));
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
      assistant: { rendering: "rich", timeInjection: "interval" },
      time: { interval: 5000 },
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
      assistant: { timeInjection: "interval" },
      time: { interval: 5000 },
    });
    const stableTime = new Date("2001-01-01T00:00:00.000Z");
    await utimes(configPath, stableTime, stableTime);

    await store.persist();

    assert.deepEqual(store.get().time, { interval: 5000 });
    assert.deepEqual(await readTelegramConfig(configPath), {
      profiles: { default: { botToken: "default-token" } },
      assistant: { timeInjection: "interval" },
      time: { interval: 5000 },
    });
    assert.ok(
      Math.abs((await stat(configPath)).mtimeMs - stableTime.getTime()) < 5,
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

test("Telegram voice reply mode helpers normalize legacy hidden to manual", () => {
  let config: TelegramConfig = {};
  const store = { get: () => config };
  const getMode = createTelegramVoiceReplyModeGetter(store);
  const isConfigured = createTelegramVoiceReplyModeConfiguredChecker(store);

  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "hidden" } };
  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);

  config = { voice: { replyMode: "manual" } };
  assert.equal(getMode(), "manual");
  assert.equal(isConfigured(), false);

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
    profiles: { default: { botToken: "123:abc" } },
    voice: { replyMode: "mirror" },
  });

  await setMode("manual");

  assert.equal(store.get().voice, undefined);
  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
  });
});

test("Telegram config normalization removes the retired proactive push option", () => {
  const normalized = normalizeTelegramDefaultProfileConfig(
    legacyConfig({
      assistant: { proactivePush: false, rendering: "html" },
    }),
  );

  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.config, {
    assistant: { rendering: "html" },
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
  const staleReaderControls = createTelegramConfigControls(firstStore);
  const controls = createTelegramConfigControls(secondStore);
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), true);

  await setVoiceMode("mirror");
  await controls.setDraftPreviewsEnabled(true);
  await controls.setAssistantRenderingMode("html");
  await controls.setActivityVerbosity("verbose");
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
      activity: "verbose",
    },
    voice: { replyMode: "mirror" },
    threads: { automaticCleanup: false },
  });
  assert.equal(controls.getAssistantRenderingMode(), "html");
  assert.equal(controls.getActivityVerbosity(), "verbose");
  assert.equal(controls.isAutomaticThreadCleanupEnabled(), false);
  assert.deepEqual(secondStore.get().voice, { replyMode: "mirror" });
});

test("Thread cleanup fails closed after invalid shared config recovery", async () => {
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

test("Telegram draft previews default on while explicit current and legacy choices remain authoritative", async () => {
  for (const [config, expected] of [
    [{ profiles: { default: { botToken: "123:abc" } } }, true],
    [{ profiles: { default: { botToken: "123:abc" } }, assistant: { draftPreviews: false } }, false],
    [{ profiles: { default: { botToken: "123:abc" } }, draftPreviews: false }, false],
    [{ profiles: { default: { botToken: "123:abc" } }, richDraftPreviews: false }, false],
  ] as const) {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-draft-default-"));
    const configPath = join(agentDir, "telegram.json");
    await writeTelegramConfig(agentDir, configPath, config);
    const store = createTelegramConfigStore({ agentDir, configPath });
    await store.load();
    assert.equal(createTelegramConfigControls(store).areDraftPreviewsEnabled(), expected);
    assert.deepEqual(await readTelegramConfig(configPath), config, "Reading a default must not persist or migrate config");
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
    assistant: { draftPreviews: true, timeInjection: "always" },
    voice: { replyMode: "mirror" },
  });
});

test("Telegram time injection mode setter persists telegram.json", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-time-mode-"));
  const configPath = join(agentDir, "telegram.json");
  const store = createTelegramConfigStore({
    initialConfig: {
      botToken: "123:abc",
      time: { interval: 5000, injectionMode: "always" },
    } as TelegramConfig,
    agentDir,
    configPath,
  });
  const getMode = createTelegramTimeInjectionModeGetter(store);
  const setMode = createTelegramTimeInjectionModeSetter(store);

  assert.equal(getMode(), "interval");

  await setMode("interval");

  assert.equal(getMode(), "interval");
  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: { timeInjection: "interval" },
    time: { interval: 5000, injectionMode: "always" },
  });

  await setMode("hidden");

  assert.equal(getMode(), "hidden");
  assert.deepEqual(await readTelegramConfig(configPath), {
    profiles: { default: { botToken: "123:abc" } },
    assistant: { timeInjection: "hidden" },
    time: { interval: 5000, injectionMode: "always" },
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

test("Paired-only admission adopts a peer grant without writing config or losing local settings", async (t) => {
  for (const profileName of ["default", "work"]) {
    const dir = await mkdtemp(join(tmpdir(), "telegram-paired-only-"));
    const configPath = join(dir, "telegram.json");
    const hash = createHash("sha256").update("fixture-token").digest("hex");
    let pendingSettings: Promise<void> | undefined;
    try {
      await writeFile(configPath, JSON.stringify({ profiles: { [profileName]: { botToken: "fixture-token" } }, assistant: { activity: "verbose" } }));
      const store = createTelegramConfigStore({ agentDir: dir, configPath });
      await store.load();
      assert.equal(store.activateProfile(profileName), true);
      const unpaired = await readFile(configPath, "utf8");
      assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 42, () => assert.fail("unpaired publication")), { admitted: false });
      assert.equal(store.getAllowedUserId(), undefined);
      assert.equal(await readFile(configPath, "utf8"), unpaired);
      const peer = createTelegramConfigStore({ agentDir: dir, configPath });
      await peer.load();
      peer.activateProfile(profileName);
      assert.equal(await peer.persistAllowedUserId(42), true);
      const granted = await readFile(configPath, "utf8");
      store.update((value) => { value.assistant = { ...value.assistant, activity: "quiet" }; });
      pendingSettings = store.persist();
      const originalRename = fs.renameSync;
      const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (to === configPath) assert.fail("paired-only admission wrote config");
        return originalRename(from, to);
      });
      syncBuiltinESMExports();
      try {
        assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 42, () => {
          assert.equal(fs.existsSync(`${configPath}.transaction`), true);
          assert.equal(store.getAllowedUserId(), 42, "Refresh must precede the publication callback");
          assert.equal(store.get().assistant?.activity, "quiet");
          return "published";
        }), { admitted: true, value: "published" });
        assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 43, () => assert.fail("wrong-owner publication")), { admitted: false });
        assert.throws(() => store.withPairedUserAdmission(profileName, hash, 42, () => { throw new Error("append failed"); }), /append failed/);
        assert.equal(store.getAllowedUserId(), 42, "A failed append does not revoke an existing durable grant");
        assert.equal(fs.existsSync(`${configPath}.transaction`), false);
        assert.equal(fs.readFileSync(configPath, "utf8"), granted);
      } finally {
        rename.mock.restore();
        syncBuiltinESMExports();
      }
      store.update((value) => { value.assistant = { ...value.assistant, timeInjection: "always" }; });
      await pendingSettings;
      assert.equal(store.getAllowedUserId(), 42);
      assert.equal(store.get().assistant?.timeInjection, "always");
      await store.persist();
      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(persisted.profiles[profileName].allowedUserId, 42);
      assert.equal(persisted.assistant.activity, "quiet");
      assert.equal(persisted.assistant.timeInjection, "always");
    } finally {
      await pendingSettings?.catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }
});

for (const profileName of ["default", "work"]) {
  for (const change of ["local-unpair", "disk-revocation"] as const) {
    test(`Queued config adoption preserves ${change} after paired observation (${profileName})`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "telegram-observation-rebase-"));
      const configPath = join(dir, "telegram.json");
      const hash = createHash("sha256").update("fixture-token").digest("hex");
      let pendingSettings: Promise<void> | undefined;
      try {
        await writeFile(configPath, JSON.stringify({ profiles: { [profileName]: { botToken: "fixture-token" } } }));
        const store = createTelegramConfigStore({ agentDir: dir, configPath });
        await store.load();
        store.activateProfile(profileName);
        const peer = createTelegramConfigStore({ agentDir: dir, configPath });
        await peer.load();
        peer.activateProfile(profileName);
        await peer.persistAllowedUserId(42);
        store.update((value) => { value.assistant = { ...value.assistant, activity: "quiet" }; });
        pendingSettings = store.persist();
        assert.deepEqual(store.withPairedUserAdmission(profileName, hash, 42, () => "observed"),
          { admitted: true, value: "observed" });
        if (change === "local-unpair") {
          store.update((value) => { delete value.allowedUserId; });
        } else {
          store.update((value) => { value.assistant = { ...value.assistant, timeInjection: "always" }; });
          const revoked = JSON.parse(fs.readFileSync(configPath, "utf8"));
          delete revoked.profiles[profileName].allowedUserId;
          fs.writeFileSync(configPath, JSON.stringify(revoked));
        }
        await pendingSettings;
        const diskOwner = JSON.parse(await readFile(configPath, "utf8")).profiles[profileName].allowedUserId;
        assert.equal(diskOwner, change === "local-unpair" ? 42 : undefined);
        assert.equal(store.getAllowedUserId(), undefined, "Queued completion must not restore observed authority into the cache");
        assert.equal(store.get().assistant?.activity, "quiet");
        const admit = () => store.withPairedUserAdmission(profileName, hash, 42, () => assert.fail("unpaired publication"));
        if (change === "local-unpair") assert.throws(admit, /local profile authority/);
        else {
          assert.deepEqual(admit(), { admitted: false });
          assert.equal(store.get().assistant?.timeInjection, "always");
        }
        await store.persist();
        assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles[profileName].allowedUserId, undefined,
          "A later settings save must not recreate a grant");
        assert.equal(store.getAllowedUserId(), undefined);
      } finally {
        await pendingSettings?.catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("Paired-only admission rejects stale or conflicting authority without cache adoption or publication", async () => {
  for (const scenario of ["entry-fence", "commit-fence", "local-profile", "local-token", "local-owner", "local-unpair", "disk-token", "disk-owner", "malformed-owner", "invalid-user"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "telegram-paired-only-denial-"));
    const configPath = join(dir, "telegram.json");
    const hash = createHash("sha256").update("fixture-token").digest("hex");
    try {
      await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
      const store = createTelegramConfigStore({ agentDir: dir, configPath });
      await store.load();
      await writeFile(configPath, JSON.stringify({ profiles: { default: {
        botToken: scenario === "disk-token" ? "rebound" : "fixture-token",
        allowedUserId: scenario === "disk-owner" ? 43 : scenario === "malformed-owner" ? "42" : 42,
      } } }));
      if (scenario === "local-profile") { store.setProfile("other", { botToken: "other" }); store.activateProfile("other"); }
      if (scenario === "local-token") store.update((value) => { value.botToken = "unsaved-token"; });
      if (scenario === "local-owner") store.setAllowedUserId(9);
      if (scenario === "local-unpair") { await store.load(); store.update((value) => { delete value.allowedUserId; }); }
      const before = structuredClone(store.getStoredConfig());
      const bytes = await readFile(configPath, "utf8");
      let checks = 0;
      const attempt = () => store.withPairedUserAdmission("default", hash, scenario === "invalid-user" ? 0 : 42,
        () => assert.fail(`rejected source reached publication: ${scenario}`), () => {
          checks++;
          if (scenario === "entry-fence" || (scenario === "commit-fence" && checks === 2)) throw new Error("fixture stale authority");
        });
      if (scenario === "disk-owner" || scenario === "invalid-user") assert.deepEqual(attempt(), { admitted: false }, scenario);
      else assert.throws(attempt, /authority|local profile/, scenario);
      assert.deepEqual(store.getStoredConfig(), before, scenario);
      assert.equal(await readFile(configPath, "utf8"), bytes, scenario);
      assert.equal(fs.existsSync(`${configPath}.transaction`), false, scenario);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Source serialization is lock-only across config absence, corruption and authority changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-source-serialization-"));
  const configPath = join(dir, "telegram.json");
  const originalRead = fs.readFileSync;
  const read = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    assert.notEqual(args[0], configPath, "Serialization must not read config contents");
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const activeProfile of [undefined, "work"]) {
      const store = createTelegramConfigStore({ agentDir: dir, configPath, initialConfig: {
        profiles: {
          default: { botToken: "cached-default", allowedUserId: 42 },
          work: { botToken: "cached-work", allowedUserId: 43 },
        },
      } });
      assert.equal(store.activateProfile(activeProfile), true);
      store.update((config) => { config.assistant = { activity: "quiet" }; });
      const cached = store.getStoredConfig();
      for (const bytes of [undefined, "{broken", JSON.stringify({ profiles: {
        default: { botToken: "rotated-default" },
        work: { botToken: "rotated-work", allowedUserId: 99 },
      } })]) {
        if (bytes === undefined) await rm(configPath, { force: true });
        else await writeFile(configPath, bytes);
        const result = {};
        let calls = 0;
        assert.equal(store.withSourceSerialization((...args) => {
          calls += 1;
          assert.deepEqual(args, [], "No config data or lock capability is exposed");
          assert.equal(fs.existsSync(`${configPath}.transaction`), true);
          return result;
        }), result);
        assert.equal(calls, 1);
        const failure = new Error("source operation failed");
        assert.throws(() => store.withSourceSerialization(() => { throw failure; }), (error) => error === failure);
        assert.equal(fs.existsSync(`${configPath}.transaction`), false);
        assert.equal(store.withSourceSerialization(() => "retry"), "retry");
        assert.equal(store.getStoredConfig(), cached);
        assert.equal(store.getActiveProfileName(), activeProfile);
        assert.equal(store.getAllowedUserId(), activeProfile ? 43 : 42);
        assert.equal(store.get().assistant?.activity, "quiet");
        if (bytes === undefined) assert.equal(fs.existsSync(configPath), false);
        else assert.equal(await readFile(configPath, "utf8"), bytes);
        assert.deepEqual(await readdir(dir), bytes === undefined ? [] : ["telegram.json"]);
      }
      // Misuse witness: an async continuation is outside this synchronous contract.
      let lockAfterAwait: boolean | undefined;
      const unsupported = store.withSourceSerialization(async () => {
        assert.equal(fs.existsSync(`${configPath}.transaction`), true);
        await Promise.resolve();
        lockAfterAwait = fs.existsSync(`${configPath}.transaction`);
      });
      assert.equal(fs.existsSync(`${configPath}.transaction`), false);
      await unsupported;
      assert.equal(lockAfterAwait, false);
    }
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Source serialization contends with real observation, sender admission and owner-fenced grant", async (t) => {
  for (const mode of ["observation", "paired", "grant"] as const) {
    await t.test(mode, async () => {
      const dir = await mkdtemp(join(tmpdir(), "telegram-source-contention-"));
      const configPath = join(dir, "telegram.json");
      const startPath = join(dir, "start");
      const blockedPath = join(dir, "blocked");
      const enteredPath = join(dir, "entered");
      const configModule = new URL("../lib/config.ts", import.meta.url).href;
      const locksModule = new URL("../lib/locks.ts", import.meta.url).href;
      const original = JSON.stringify({ profiles: { default: {
        botToken: "fixture-token", ...(mode === "paired" ? { allowedUserId: 42 } : {}),
      } } });
      await writeFile(configPath, original);
      const script = `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { createHash } from "node:crypto";
        import { createTelegramConfigStore } from ${JSON.stringify(configModule)};
        import { createTelegramLockRuntime } from ${JSON.stringify(locksModule)};
        const dir = ${JSON.stringify(dir)};
        const configPath = ${JSON.stringify(configPath)};
        const mode = ${JSON.stringify(mode)};
        const store = createTelegramConfigStore({ agentDir: dir, configPath });
        await store.load();
        const deadline = Date.now() + 8000;
        while (!fs.existsSync(${JSON.stringify(startPath)})) {
          if (Date.now() >= deadline) throw new Error("start barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
        const exists = fs.existsSync;
        fs.existsSync = (path) => {
          const present = exists(path);
          // The real guard refuses publication when this acquisition check returns true.
          if (path === configPath + ".transaction" && present) {
            fs.writeFileSync(${JSON.stringify(blockedPath)}, "contended acquisition");
          }
          return present;
        };
        syncBuiltinESMExports();
        const hash = createHash("sha256").update("fixture-token").digest("hex");
        const entered = () => { fs.writeFileSync(${JSON.stringify(enteredPath)}, "entered"); return "entered"; };
        let result;
        if (mode === "observation") result = store.withPairingAdmission("default", hash, entered);
        else if (mode === "paired") result = store.withPairedUserAdmission("default", hash, 42, entered);
        else {
          const owner = createTelegramLockRuntime({ locksPath: dir + "/owners.json", instanceId: "source-grant-child" });
          if (!owner.acquire({ cwd: "/fixture" }).ok) throw new Error("fixture owner unavailable");
          try { result = await store.persistAllowedUserId(42, undefined, owner.commitIfOwned); entered(); }
          finally { owner.release(); }
        }
        process.stdout.write(JSON.stringify(result));
      `;
      const child = execFileAsync(process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", script], { timeout: 15_000 });
      try {
        const store = createTelegramConfigStore({ agentDir: dir, configPath });
        store.withSourceSerialization(() => {
          fs.writeFileSync(startPath, "start");
          const deadline = Date.now() + 8000;
          while (!fs.existsSync(blockedPath)) {
            if (Date.now() >= deadline) throw new Error("contention barrier timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          }
          assert.equal(fs.existsSync(enteredPath), false);
          assert.equal(fs.readFileSync(configPath, "utf8"), original);
        });
        const result = JSON.parse((await child).stdout);
        assert.deepEqual(result, mode === "paired" ? { admitted: true, value: "entered" } : mode === "grant" ? true : "entered");
        assert.equal(fs.existsSync(enteredPath), true);
        assert.equal(fs.existsSync(`${configPath}.transaction`), false);
        assert.equal(fs.existsSync(join(dir, "owners.json.transaction")), false);
        if (mode === "grant") assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles.default.allowedUserId, 42);
        else assert.equal(await readFile(configPath, "utf8"), original);
      } finally {
        await child.catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("Pairing admission observes exact persisted identity under the config transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-pair-observation-"));
  const configPath = join(dir, "telegram.json");
  const tokenSha256 = createHash("sha256").update("fixture-token").digest("hex");
  try {
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    const store = createTelegramConfigStore({ agentDir: dir, configPath });
    await store.load();
    const classifications: boolean[] = [];
    const observe = () => store.withPairingAdmission("default", tokenSha256, (excluded) => {
      assert.equal(fs.existsSync(`${configPath}.transaction`), true);
      classifications.push(excluded);
      return "synchronous-result";
    });
    const grant = store.persistAllowedUserId(42);
    assert.equal(observe(), "synchronous-result");
    assert.equal(store.getAllowedUserId(), undefined);
    await grant;
    observe();
    assert.deepEqual(classifications, [true, false]);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
    const original = await readFile(configPath, "utf8");
    for (const [profile, hash] of [["missing", tokenSha256], ["default", "b".repeat(64)], ["../work", tokenSha256]]) {
      assert.throws(() => store.withPairingAdmission(profile!, hash!, () => assert.fail("invalid identity reached publication")), /pairing admission/);
    }
    assert.throws(() => store.withPairingAdmission("default", tokenSha256, () => { throw new Error("append failed"); }), /append failed/);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
    assert.equal(await readFile(configPath, "utf8"), original);
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    observe();
    assert.deepEqual(classifications, [true, false, true], "Admission must not trust the cached paired owner");
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token", allowedUserId: "unknown" } } }));
    assert.throws(observe, /authority is unavailable or changed/);
    assert.equal(classifications.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing owner guard encloses the queued synchronous config commit and rejects a replaced owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-pair-owner-commit-"));
  const configPath = join(dir, "telegram.json");
  const locksPath = join(dir, "owners.json");
  const originalRename = fs.renameSync;
  let configRenames = 0;
  const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === configPath) {
      configRenames++;
      assert.equal(fs.existsSync(`${locksPath}.transaction`), true, "Owner transaction must enclose rename");
      assert.equal(fs.existsSync(`${configPath}.transaction`), true, "Config transaction must enclose rename");
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    const store = createTelegramConfigStore({ agentDir: dir, configPath });
    await store.load();
    const first = createTelegramLockRuntime({ locksPath, instanceId: "first" });
    const acquired = first.acquire({ cwd: "/fixture" });
    assert.equal(acquired.ok, true);
    let callReturned = false;
    const pending = store.persistAllowedUserId(42, undefined, (commit) => {
      assert.equal(callReturned, true, "Do not acquire owner authority while waiting for the persistence queue");
      return first.commitIfOwned(commit);
    });
    callReturned = true;
    const replacement = createTelegramLockRuntime({ locksPath, instanceId: "replacement" });
    assert.equal(replacement.acquire({ cwd: "/fixture" }, {
      force: true, expectedOwner: acquired.ok ? acquired.lock : undefined,
    }).ok, true);
    await assert.rejects(pending, /lost transport ownership/);
    assert.equal(store.getAllowedUserId(), undefined);
    assert.equal(configRenames, 0);
    assert.equal(await store.persistAllowedUserId(42, undefined, replacement.commitIfOwned), true);
    assert.equal(configRenames, 1);
    assert.equal(store.getAllowedUserId(), 42);
    assert.equal(fs.existsSync(`${locksPath}.transaction`), false);
    assert.equal(fs.existsSync(`${configPath}.transaction`), false);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing publication failure never grants in-memory authority and retry publishes first", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-pair-publication-"));
  const configPath = join(dir, "telegram.json");
  const renameSync = fs.renameSync;
  let fail = true;
  const rename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === configPath && fail) throw new Error("injected pairing publication failure");
    return renameSync(from, to);
  });
  syncBuiltinESMExports();
  try {
    await writeFile(configPath, JSON.stringify({ profiles: { default: { botToken: "fixture-token" } } }));
    const store = createTelegramConfigStore({ agentDir: dir, configPath });
    await store.load();
    const original = await readFile(configPath, "utf8");
    let statuses = 0;
    const runtime = createTelegramUserPairingRuntime({ getAllowedUserId: store.getAllowedUserId,
      persistAllowedUserId: store.persistAllowedUserId, updateStatus() { statuses++; } });
    const rejected = runtime.pairIfNeeded(42, {});
    assert.equal(store.getAllowedUserId(), undefined);
    await assert.rejects(rejected, /pairing publication failure/);
    assert.equal(store.getAllowedUserId(), undefined);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(statuses, 0);
    fail = false;
    assert.equal(await runtime.pairIfNeeded(42, {}), true);
    assert.equal(store.getAllowedUserId(), 42);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles.default.allowedUserId, 42);
    assert.equal(statuses, 1);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing compares the disk owner atomically and preserves unrelated local edits and profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-pair-owner-"));
  const configPath = join(dir, "telegram.json");
  try {
    await writeFile(configPath, JSON.stringify({ profiles: {
      default: { botToken: "fixture-default" }, work: { botToken: "fixture-work" },
    } }));
    const first = createTelegramConfigStore({ agentDir: dir, configPath });
    const second = createTelegramConfigStore({ agentDir: dir, configPath });
    await first.load();
    await second.load();
    second.update((config) => { config.assistant = { activity: "quiet" }; });
    assert.deepEqual(await Promise.all([first.persistAllowedUserId(42), second.persistAllowedUserId(43)]), [true, false]);
    assert.equal(second.getAllowedUserId(), 42);
    assert.equal(second.get().assistant?.activity, "quiet");
    await second.persist();
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).profiles.default.allowedUserId, 42);
    second.activateProfile("work");
    assert.equal(second.getAllowedUserId(), undefined);
    assert.equal(await second.persistAllowedUserId(43), true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.profiles.default.allowedUserId, 42);
    assert.equal(saved.profiles.work.allowedUserId, 43);
    assert.equal(saved.assistant.activity, "quiet");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pairing rejects stale execution, switched profiles, and changed disk bot identity before publication", async () => {
  for (const scenario of ["stale-entry", "stale-commit", "profile-switch", "token-rebind"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "telegram-pair-fence-"));
    const configPath = join(dir, "telegram.json");
    try {
      const initial = { profiles: { default: { botToken: "fixture-default" }, work: { botToken: "fixture-work" } } };
      await writeFile(configPath, JSON.stringify(initial));
      const store = createTelegramConfigStore({ agentDir: dir, configPath });
      await store.load();
      let guards = 0;
      const pending = store.persistAllowedUserId(42, () => {
        guards++;
        if ((scenario === "stale-entry" && guards === 1) || (scenario === "stale-commit" && guards === 2)) {
          throw new Error("stale execution");
        }
      });
      if (scenario === "profile-switch") store.activateProfile("work");
      if (scenario === "token-rebind") {
        initial.profiles.default.botToken = "fixture-replacement";
        fs.writeFileSync(configPath, JSON.stringify(initial));
      }
      await assert.rejects(pending, /stale execution|profile authority|profile is unavailable or changed/);
      assert.equal(store.getAllowedUserId(), undefined);
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), initial);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
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
      persistAllowedUserId: async (userId) => {
        events.push(`persist:${userId}`);
        allowedUserId = userId;
        return true;
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
      persistAllowedUserId: async () => {
        events.push("unexpected:persist");
        return false;
      },
      updateStatus: () => {
        events.push("unexpected:status");
      },
    }),
    false,
  );
  assert.equal(allowedUserId, 10);
  assert.deepEqual(events, ["persist:10", "status:ctx"]);
});

test("Telegram config pairing rechecks execution authority around persistence", async () => {
  let current = false;
  let persisted = 0;
  await assert.rejects(
    pairTelegramUserIfNeeded(10, {
      ctx: "ctx",
      persistAllowedUserId: async () => {
        persisted += 1;
        return true;
      },
      updateStatus: () => {},
      assertExecutionCurrent() {
        if (!current) throw new DOMException("Aborted", "AbortError");
      },
    }),
    /Abort/u,
  );
  assert.equal(persisted, 0);
});

test("Telegram config pairing swallows only stale context status errors", async () => {
  await assert.doesNotReject(() =>
    pairTelegramUserIfNeeded(10, {
      ctx: "ctx",
      persistAllowedUserId: async () => true,
      updateStatus: () => {
        throw new Error("ctx is stale after session replacement");
      },
    }),
  );
  await assert.rejects(
    () =>
      pairTelegramUserIfNeeded(10, {
        ctx: "ctx",
        persistAllowedUserId: async () => true,
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
    persistAllowedUserId: async (userId) => {
      events.push(`persist:${userId}`);
      allowedUserId = userId;
      return true;
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
  });
  assert.equal(await runtime.pairIfNeeded(7, "ctx"), true);
  assert.equal(await runtime.pairIfNeeded(7, "ctx"), true);
  assert.equal(await runtime.pairIfNeeded(8, "ctx"), false);
  assert.deepEqual(events, ["persist:7", "status:ctx"]);
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
