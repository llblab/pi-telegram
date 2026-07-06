/**
 * Telegram setup prompt helpers — MULTI-INSTANCE PATCHED
 * Adds multi-bot profile registry flow for /telegram-setup and /telegram-connect.
 * Zones: pi agent command ui, telegram config
 * Computes token-prefill defaults and prompt mode selection for /telegram-setup
 */

import {
  type TelegramBotProfile,
  type TelegramBotRegistry,
  type TelegramConfig,
  findTelegramBotProfile,
  getActiveTelegramBotProfile,
  readTelegramBotRegistry,
  removeTelegramBotProfile,
  setActiveTelegramBotProfile,
  telegramBotProfileToConfig,
  telegramConfigToBotProfile,
  upsertTelegramBotProfile,
  writeTelegramBotRegistry,
} from "./config.ts";
import { telegramDebugLog } from "./debug-log.ts";

export interface TelegramSetupConfig {
  botToken?: string;
  botId?: number;
  botUsername?: string;
  allowedUserId?: number;
  lastUpdateId?: number;
}

export interface TelegramBotTokenPromptSpec {
  method: "input" | "editor";
  value: string;
}

export interface TelegramSetupUser {
  id: number;
  username?: string;
}

export interface TelegramPollingStartResult {
  ok: boolean;
  message?: string;
}

export interface TelegramSetupDeps {
  hasUI: boolean;
  env: NodeJS.ProcessEnv;
  config: TelegramSetupConfig;
  promptInput: (label: string, value: string) => Promise<string | undefined>;
  promptEditor: (label: string, value: string) => Promise<string | undefined>;
  getMe: (botToken: string) => Promise<{
    ok: boolean;
    result?: TelegramSetupUser;
    description?: string;
  }>;
  persistConfig: (config: TelegramSetupConfig) => Promise<void>;
  notify: (message: string, level: "info" | "error") => void;
  startPolling: () => unknown | Promise<unknown>;
  updateStatus: () => void;
}

export interface TelegramSetupPromptContext {
  hasUI: boolean;
  ui: {
    input: (label: string, value: string) => Promise<string | undefined>;
    editor: (label: string, value: string) => Promise<string | undefined>;
    notify: (message: string, level: "info" | "error") => void;
  };
}

export interface TelegramSetupGuard {
  start: () => boolean;
  finish: () => void;
}

export interface TelegramSetupPromptRuntimeDeps<
  TContext extends TelegramSetupPromptContext,
> {
  env?: NodeJS.ProcessEnv;
  getConfig: () => TelegramSetupConfig;
  setConfig: (config: TelegramSetupConfig) => void;
  setupGuard: TelegramSetupGuard;
  getMe: TelegramSetupDeps["getMe"];
  persistConfig: (config: TelegramSetupConfig) => Promise<void>;
  startPolling: (ctx: TContext) => unknown | Promise<unknown>;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export const TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER = "123456:ABCDEF...";
const TELEGRAM_BOT_TOKEN_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_KEY",
  "TELEGRAM_TOKEN",
  "TELEGRAM_KEY",
] as const;

function isTelegramPollingStartResult(
  value: unknown,
): value is TelegramPollingStartResult {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

export function getTelegramBotTokenInputDefault(
  env: NodeJS.ProcessEnv = process.env,
  configToken?: string,
): string {
  const trimmedConfigToken = configToken?.trim();
  if (trimmedConfigToken) return trimmedConfigToken;
  for (const key of TELEGRAM_BOT_TOKEN_ENV_VARS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER;
}

export function getTelegramBotTokenPromptSpec(
  env: NodeJS.ProcessEnv = process.env,
  configToken?: string,
): TelegramBotTokenPromptSpec {
  const value = getTelegramBotTokenInputDefault(env, configToken);
  return {
    method: value === TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER ? "input" : "editor",
    value,
  };
}

export async function runTelegramSetup(
  deps: TelegramSetupDeps,
): Promise<TelegramSetupConfig | undefined> {
  if (!deps.hasUI) return undefined;
  const tokenPrompt = getTelegramBotTokenPromptSpec(
    deps.env,
    deps.config.botToken,
  );
  const token =
    tokenPrompt.method === "editor"
      ? await deps.promptEditor("Telegram bot token", tokenPrompt.value)
      : await deps.promptInput("Telegram bot token", tokenPrompt.value);
  if (!token) return undefined;
  const nextConfig: TelegramSetupConfig = {
    ...deps.config,
    botToken: token.trim(),
  };
  let data: TelegramGetMeResult;
  try {
    data = await deps.getMe(nextConfig.botToken ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Telegram API check failed: ${message}`, "error");
    return undefined;
  }
  if (!data.ok || !data.result) {
    deps.notify(data.description || "Invalid Telegram bot token", "error");
    return undefined;
  }
  nextConfig.botId = data.result.id;
  nextConfig.botUsername = data.result.username;
  await deps.persistConfig(nextConfig);
  deps.notify(
    `Telegram bot connected: @${nextConfig.botUsername ?? "unknown"}`,
    "info",
  );
  deps.notify(
    "Send /start to your bot in Telegram to pair this extension with your account.",
    "info",
  );
  const startResult = await deps.startPolling();
  if (isTelegramPollingStartResult(startResult) && startResult.message) {
    deps.notify(startResult.message, startResult.ok ? "info" : "error");
  }
  deps.updateStatus();
  return nextConfig;
}

export function createTelegramSetupPromptRuntime<
  TContext extends TelegramSetupPromptContext,
>(deps: TelegramSetupPromptRuntimeDeps<TContext>) {
  return async (ctx: TContext): Promise<void> => {
    if (!ctx.hasUI || !deps.setupGuard.start()) return;
    try {
      await runTelegramSetup({
        hasUI: ctx.hasUI,
        env: deps.env ?? process.env,
        config: deps.getConfig(),
        promptInput: (label, value) => ctx.ui.input(label, value),
        promptEditor: (label, value) => ctx.ui.editor(label, value),
        getMe: deps.getMe,
        persistConfig: async (config) => {
          await deps.persistConfig(config);
          deps.setConfig(config);
        },
        notify: (message, level) => ctx.ui.notify(message, level),
        startPolling: () => deps.startPolling(ctx),
        updateStatus: () => deps.updateStatus(ctx),
      });
    } catch (error) {
      deps.recordRuntimeEvent?.("setup", error);
      throw error;
    } finally {
      deps.setupGuard.finish();
    }
  };
}

export interface TelegramGetMeResult {
  ok: boolean;
  result?: TelegramSetupUser;
  description?: string;
}

// --- MULTI-INSTANCE: multi-bot profile setup & connect picker ---

export interface TelegramMultiBotSetupDeps {
  hasUI: boolean;
  env: NodeJS.ProcessEnv;
  readRegistry: () => TelegramBotRegistry;
  writeRegistry: (registry: TelegramBotRegistry) => Promise<void>;
  getActiveConfig: () => TelegramSetupConfig;
  promptInput: (label: string, value: string) => Promise<string | undefined>;
  promptEditor: (label: string, value: string) => Promise<string | undefined>;
  getMe: (botToken: string) => Promise<TelegramGetMeResult>;
  persistConfig: (config: TelegramSetupConfig) => Promise<void>;
  notify: (message: string, level: "info" | "error") => void;
  startPolling: () => unknown | Promise<unknown>;
  stopPolling?: () => Promise<void>;
  updateStatus: () => void;
}

function profileDisplayName(profile: TelegramBotProfile): string {
  return profile.botUsername
    ? `@${profile.botUsername}`
    : profile.name ?? profile.id;
}

export async function runTelegramMultiBotSetup(
  deps: TelegramMultiBotSetupDeps,
): Promise<void> {
  if (!deps.hasUI) return;
  while (true) {
    const registry = deps.readRegistry();
    telegramDebugLog("setup", "multi-bot menu enter", {
      botCount: registry.bots.length,
      activeBotId: registry.activeBotId,
    });
    const lines: string[] = ["Telegram bots:"];
    registry.bots.forEach((bot, i) => {
      const active = bot.id === registry.activeBotId ? " (active)" : "";
      lines.push(`  ${i + 1}. ${profileDisplayName(bot)}${active}`);
    });
    const hasBots = registry.bots.length > 0;
    const addIdx = registry.bots.length + 1;
    let editIdx = addIdx + 1;
    let removeIdx = addIdx + 1;
    let doneIdx = addIdx + 1;
    lines.push(`  ${addIdx}. Add new bot`);
    if (hasBots) {
      editIdx = addIdx + 1;
      removeIdx = addIdx + 2;
      doneIdx = addIdx + 3;
      lines.push(`  ${editIdx}. Edit bot token`);
      lines.push(`  ${removeIdx}. Remove bot`);
    }
    lines.push(`  ${doneIdx}. Done`);
    deps.notify(lines.join("\n"), "info");
    const choice = ((await deps.promptInput("Choose", "")) ?? "").trim();
    if (!choice) return;
    const num = Number(choice);
    telegramDebugLog("setup", "menu choice", { choice, num, doneIdx });
    if (!Number.isInteger(num) || num < 1 || num > doneIdx) {
      deps.notify("Invalid choice.", "error");
      continue;
    }
    if (num === doneIdx) return;
    if (num === addIdx) {
      await addTelegramBotFlow(deps);
      continue;
    }
    if (hasBots && num === editIdx) {
      await editTelegramBotFlow(deps, deps.readRegistry());
      continue;
    }
    if (hasBots && num === removeIdx) {
      await removeTelegramBotFlow(deps, deps.readRegistry());
      continue;
    }
    const profile = registry.bots[num - 1];
    if (!profile) continue;
    telegramDebugLog("setup", "switch active bot", {
      from: registry.activeBotId,
      to: profile.id,
    });
    // Bug 8: stop polling + release old bot's lock before switching.
    // Without this, the old bot's getUpdates loop keeps running and its
    // lock entry leaks in locks.json (stale until heartbeat expiry).
    if (deps.stopPolling) {
      try {
        await deps.stopPolling();
      } catch (error) {
        deps.notify(
          `Warning: failed to stop previous bot polling: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    }
    const next = setActiveTelegramBotProfile(registry, profile.id);
    await deps.writeRegistry(next);
    await deps.persistConfig(telegramBotProfileToConfig(profile));
    deps.notify(`Active bot: ${profileDisplayName(profile)}`, "info");
    const startIn = (
      (await deps.promptInput("Connect now? [Y/n]", "y")) ?? "y"
    ).trim();
    if (!startIn || /^[yY]/.test(startIn)) {
      const result = await deps.startPolling();
      if (isTelegramPollingStartResult(result) && result.message) {
        deps.notify(result.message, result.ok ? "info" : "error");
      }
      deps.updateStatus();
      return;
    }
  }
}

async function addTelegramBotFlow(
  deps: TelegramMultiBotSetupDeps,
): Promise<void> {
  // Bug 12: auto-migrate legacy single-bot telegram.json into registry.
  // If registry is empty but telegram.json has a botToken, import it as
  // the first profile (preserving allowedUserId/lastUpdateId) before
  // adding the new bot — so the legacy bot isn't lost.
  const registry = deps.readRegistry();
  if (registry.bots.length === 0) {
    const legacyConfig = deps.getActiveConfig();
    if (legacyConfig?.botToken) {
      const legacyProfile = telegramConfigToBotProfile(legacyConfig);
      if (legacyProfile) {
        const migrated = setActiveTelegramBotProfile(
          upsertTelegramBotProfile(registry, legacyProfile),
          legacyProfile.id,
        );
        await deps.writeRegistry(migrated);
        telegramDebugLog("setup", "legacy config migrated", {
          profileId: legacyProfile.id,
          username: legacyProfile.botUsername,
        });
        deps.notify(
          `Migrated existing bot ${profileDisplayName(legacyProfile)} into the registry.`,
          "info",
        );
      }
    }
  }
  const tokenPrompt = getTelegramBotTokenPromptSpec(deps.env, undefined);
  const token =
    tokenPrompt.method === "editor"
      ? await deps.promptEditor("Telegram bot token", tokenPrompt.value)
      : await deps.promptInput("Telegram bot token", tokenPrompt.value);
  await saveTelegramBotFromToken(deps, token.trim());
  telegramDebugLog("setup", "add flow done");
}

async function editTelegramBotFlow(
  deps: TelegramMultiBotSetupDeps,
  registry: TelegramBotRegistry,
): Promise<void> {
  if (registry.bots.length === 0) {
    deps.notify("No bots to edit.", "info");
    return;
  }
  const pickLines: string[] = ["Edit which bot?"];
  registry.bots.forEach((bot, i) => {
    pickLines.push(`  ${i + 1}. ${profileDisplayName(bot)}`);
  });
  pickLines.push(`  ${registry.bots.length + 1}. Cancel`);
  deps.notify(pickLines.join("\n"), "info");
  const choice = ((await deps.promptInput("Choose", "")) ?? "").trim();
  if (!choice) return;
  const num = Number(choice);
  if (!Number.isInteger(num) || num < 1 || num > registry.bots.length) return;
  const existing = registry.bots[num - 1];
  const tokenPrompt = getTelegramBotTokenPromptSpec(deps.env, existing.botToken);
  const token =
    tokenPrompt.method === "editor"
      ? await deps.promptEditor(`New token for ${profileDisplayName(existing)}`, tokenPrompt.value)
      : await deps.promptInput(`New token for ${profileDisplayName(existing)}`, tokenPrompt.value);
  if (!token) return;
  await saveTelegramBotFromToken(deps, token.trim(), existing.id);
}

async function saveTelegramBotFromToken(
  deps: TelegramMultiBotSetupDeps,
  botToken: string,
  existingId?: string,
): Promise<void> {
  telegramDebugLog("setup", "saveTelegramBotFromToken enter", {
    existingId,
    tokenTail: botToken.slice(-6),
  });
  let data: TelegramGetMeResult;
  try {
    data = await deps.getMe(botToken);
  telegramDebugLog("setup", "getMe ok", {
    botId: data.result?.id,
    username: data.result?.username,
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Telegram API check failed: ${message}`, "error");
    return;
  }
  if (!data.ok || !data.result) {
    deps.notify(data.description || "Invalid Telegram bot token", "error");
    return;
  }
  const registry = deps.readRegistry();
  // Bug 3: preserve allowedUserId/lastUpdateId from existing profile
  // (edit-token flow must not lose pairing state)
  const existing = existingId
    ? findTelegramBotProfile(registry, existingId)
    : undefined;
  const profile: TelegramBotProfile = {
    id: existingId ?? String(data.result.id),
    botToken,
    botId: data.result.id,
    botUsername: data.result.username,
    allowedUserId: existing?.allowedUserId,
    lastUpdateId: existing?.lastUpdateId,
  };
  const wasActive = registry.activeBotId === profile.id;
  // Bug 13: first bot becomes active by default
  const isFirstBot = registry.bots.length === 0;
  const shouldActivate = wasActive || isFirstBot;
  const next = shouldActivate
    ? setActiveTelegramBotProfile(
        upsertTelegramBotProfile(registry, profile),
        profile.id,
      )
    : upsertTelegramBotProfile(registry, profile);
  await deps.writeRegistry(next);
  // Bug 2+7: only persist live config (telegram.json) when bot is/will-be
  // active. Non-active bots stay in registry only — telegram.json untouched.
  if (shouldActivate) {
    // CONFIG-MERGE: same as runTelegramBotPicker — preserve allowedUserId
    // and lastUpdateId from the live config that may have been set via pairing.
    const currentConfig = deps.getActiveConfig();
    const config = {
      ...(currentConfig ?? {}),
      ...telegramBotProfileToConfig(profile),
    };
    await deps.persistConfig(config);
  }
  telegramDebugLog("setup", "saveTelegramBotFromToken done", {
    profileId: profile.id,
    shouldActivate,
    botCount: next.bots.length,
  });
  deps.notify(
    `Telegram bot saved: ${profileDisplayName(profile)}`,
    "info",
  );
  deps.notify(
    "Send /start to your bot in Telegram to pair this extension with your account.",
    "info",
  );
}

async function removeTelegramBotFlow(
  deps: TelegramMultiBotSetupDeps,
  registry: TelegramBotRegistry,
): Promise<void> {
  if (registry.bots.length === 0) {
    deps.notify("No bots to remove.", "info");
    return;
  }
  const lines: string[] = ["Remove which bot?"];
  registry.bots.forEach((bot, i) => {
    lines.push(`  ${i + 1}. ${profileDisplayName(bot)}`);
  });
  lines.push(`  ${registry.bots.length + 1}. Cancel`);
  deps.notify(lines.join("\n"), "info");
  const choice = ((await deps.promptInput("Choose", "")) ?? "").trim();
  if (!choice) return;
  const num = Number(choice);
  if (!Number.isInteger(num) || num < 1 || num > registry.bots.length) return;
  const profile = registry.bots[num - 1];
  const wasActive = registry.activeBotId === profile.id;
  const removed = removeTelegramBotProfile(registry, profile.id);
  // Bug 5: explicitly setActive replacement BEFORE writeRegistry —
  // don't rely on syncActiveTelegramBotProfileFromConfig (which, with the
  // Bug 1 fix, runs against the NEW config and would work, but older paths
  // and edge cases make explicit-setActive the robust choice).
  const replacement = wasActive ? removed.bots[0] : undefined;
  const next = wasActive && replacement
    ? setActiveTelegramBotProfile(removed, replacement.id)
    : removed;
  await deps.writeRegistry(next);
  if (wasActive) {
    await deps.persistConfig(
      replacement ? telegramBotProfileToConfig(replacement) : {},
    );
  }
  telegramDebugLog("setup", "remove done", {
    removedId: profile.id,
    wasActive,
    replacementId: replacement?.id,
    botCount: next.bots.length,
  });
  deps.notify(`Removed bot ${profileDisplayName(profile)}`, "info");
}

export interface TelegramMultiBotSetupPromptRuntimeDeps<
  TContext extends TelegramSetupPromptContext,
> {
  env?: NodeJS.ProcessEnv;
  getConfig: () => TelegramSetupConfig;
  setConfig: (config: TelegramSetupConfig) => void;
  setupGuard: TelegramSetupGuard;
  getMe: (botToken: string) => Promise<TelegramGetMeResult>;
  startPolling: (ctx: TContext) => unknown | Promise<unknown>;
  stopPolling?: (ctx: TContext) => Promise<void>;
  updateStatus: (ctx: TContext) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramMultiBotSetupPromptRuntime<
  TContext extends TelegramSetupPromptContext,
>(deps: TelegramMultiBotSetupPromptRuntimeDeps<TContext>) {
  return async (ctx: TContext): Promise<void> => {
    if (!ctx.hasUI || !deps.setupGuard.start()) return;
    try {
      await runTelegramMultiBotSetup({
        hasUI: ctx.hasUI,
        env: deps.env ?? process.env,
        readRegistry: () => readTelegramBotRegistry(),
        writeRegistry: async (registry) => {
          await writeTelegramBotRegistry(registry);
        },
        getActiveConfig: deps.getConfig,
        promptInput: (label, value) => ctx.ui.input(label, value),
        promptEditor: (label, value) => ctx.ui.editor(label, value),
        getMe: deps.getMe,
        persistConfig: async (config) => {
          await deps.persistConfig(config);
          deps.setConfig(config);
        },
        notify: (message, level) => ctx.ui.notify(message, level),
        startPolling: () => deps.startPolling(ctx),
        stopPolling: deps.stopPolling ? () => deps.stopPolling!(ctx) : undefined,
        updateStatus: () => deps.updateStatus(ctx),
      });
    } catch (error) {
      deps.recordRuntimeEvent?.("setup", error);
      throw error;
    } finally {
      deps.setupGuard.finish();
    }
  };
}

// --- MULTI-INSTANCE: /telegram-connect bot picker ---

export interface TelegramBotPickerDeps {
  hasUI: boolean;
  readRegistry: () => TelegramBotRegistry;
  writeRegistry: (registry: TelegramBotRegistry) => Promise<void>;
  getConfig: () => TelegramSetupConfig;
  setConfig: (config: TelegramSetupConfig) => void;
  persistConfig: (config: TelegramSetupConfig) => Promise<void>;
  promptInput: (label: string, value: string) => Promise<string | undefined>;
  notify: (message: string, level: "info" | "error") => void;
}

export async function runTelegramBotPicker(
  deps: TelegramBotPickerDeps,
): Promise<boolean> {
  const registry = deps.readRegistry();
  telegramDebugLog("picker", "enter", { botCount: registry.bots.length });
  if (registry.bots.length === 0) return false;
  let profile: TelegramBotProfile | undefined;
  if (registry.bots.length === 1) {
    profile = registry.bots[0];
  } else {
    const lines: string[] = ["Select bot to connect:"];
    registry.bots.forEach((bot, i) => {
      const active = bot.id === registry.activeBotId ? " (active)" : "";
      lines.push(`  ${i + 1}. ${profileDisplayName(bot)}${active}`);
    });
    lines.push(`  ${registry.bots.length + 1}. Cancel`);
    deps.notify(lines.join("\n"), "info");
    const choice = ((await deps.promptInput("Choose", "")) ?? "").trim();
    if (!choice) return false;
    const num = Number(choice);
    if (!Number.isInteger(num) || num < 1 || num > registry.bots.length) {
      return false;
    }
    profile = registry.bots[num - 1];
  }
  if (!profile) return false;
  telegramDebugLog("picker", "selected", { profileId: profile.id, username: profile.botUsername });
  const next = setActiveTelegramBotProfile(registry, profile.id);
  await deps.writeRegistry(next);
  // CONFIG-MERGE: merge profile config with the current live config so fields
  // like allowedUserId and lastUpdateId (set during /start pairing) are not
  // silently dropped when the profile was created before pairing or the config
  // was written by an older version. Otherwise every /telegram-connect overwrites
  // telegram.json without pairing state → "telegram awaiting pairing" forever.
  const currentConfig = deps.getConfig();
  const config = {
    ...(currentConfig ?? {}),
    ...telegramBotProfileToConfig(profile),
  };
  await deps.persistConfig(config);
  deps.setConfig(config);
  deps.notify(`Active bot: ${profileDisplayName(profile)}`, "info");
  return true;
}

export interface TelegramBotPickerPromptRuntimeDeps<
  TContext extends TelegramSetupPromptContext,
> {
  getConfig: () => TelegramSetupConfig;
  setConfig: (config: TelegramSetupConfig) => void;
  persistConfig: (config: TelegramSetupConfig) => Promise<void>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramBotPickerPromptRuntime<
  TContext extends TelegramSetupPromptContext,
>(deps: TelegramBotPickerPromptRuntimeDeps<TContext>) {
  return async (ctx: TContext): Promise<boolean> => {
    if (!ctx.hasUI) return false;
    try {
      return await runTelegramBotPicker({
        hasUI: ctx.hasUI,
        readRegistry: () => readTelegramBotRegistry(),
        writeRegistry: async (registry) => {
          await writeTelegramBotRegistry(registry);
        },
        getConfig: deps.getConfig,
        setConfig: deps.setConfig,
        persistConfig: async (config) => {
          await deps.persistConfig(config);
          deps.setConfig(config);
        },
        promptInput: (label, value) => ctx.ui.input(label, value),
        notify: (message, level) => ctx.ui.notify(message, level),
      });
    } catch (error) {
      deps.recordRuntimeEvent?.("picker", error);
      return false;
    }
  };
}
