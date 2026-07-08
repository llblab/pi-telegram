/**
 * Telegram bridge config and pairing helpers
 * Zones: telegram config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, live config controls, authorization policy, and first-user pairing side effects
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolveAgentDir, resolveTelegramConfigPath } from "./paths.ts";

import type { TelegramInboundHandlerConfig } from "./inbound.ts";
import type { CommandTemplateObjectConfig } from "./command-templates.ts";

const CONFIG_RUNTIME_KEY = "__piTelegramConfigRuntime__";

function getConfigPath(): string {
  return resolveTelegramConfigPath();
}

export type TelegramOutboundCommandTemplateConfig =
  string | CommandTemplateObjectConfig;
export interface TelegramOutboundHandlerConfig extends CommandTemplateObjectConfig {
  type?: string;
  match?: string | string[];
  output?: string;
  timeout?: number | string;
}

export type TelegramTimeMode = "hidden" | "always" | "interval";

export interface TelegramTimeConfig {
  injectionMode?: TelegramTimeMode;
  interval?: number;
}

export interface ResolvedTelegramTimeConfig {
  injectionMode: TelegramTimeMode;
  interval: number;
  timezone: string;
}

export type TelegramAssistantRenderingMode = "rich" | "html";

export interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
  inboundHandlers?: TelegramInboundHandlerConfig[];
  attachmentHandlers?: TelegramInboundHandlerConfig[];
  outboundHandlers?: TelegramOutboundHandlerConfig[];
  proactivePush?: boolean;
  assistant?: {
    draftPreviews?: boolean;
    rendering?: TelegramAssistantRenderingMode;
  };
  /** @deprecated use assistant.draftPreviews */
  draftPreviews?: boolean;
  /** @deprecated use assistant.draftPreviews */
  richDraftPreviews?: boolean;
  /** @deprecated use assistant.rendering */
  assistantRendering?: TelegramAssistantRenderingMode;
  voice?: {
    replyMode?: "manual" | "mirror" | "always";
    /** Whether to attach the provider's transcriptText as caption on voice messages */
    sendTranscript?: boolean;
  };
  time?: TelegramTimeConfig;
  /** Named bot/session profiles (e.g. "work", "omp"). */
  profiles?: Record<string, TelegramBotProfile>;
}

/**
 * Per-profile bot/session identity fields.
 * Stored under `profiles.<name>` in telegram.json.
 * Shared bridge settings (inboundHandlers, outboundHandlers, voice, time,
 * assistant, proactivePush) stay at the top level.
 */
export interface TelegramBotProfile {
  botToken: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
}

/** Profile names must be lowercase letters, digits, hyphens, underscores; max 32 chars. */
const TELEGRAM_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TELEGRAM_RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "default",
  "main",
  "active",
]);

export function isValidTelegramProfileName(name: string): boolean {
  return (
    TELEGRAM_PROFILE_NAME_PATTERN.test(name) &&
    !TELEGRAM_RESERVED_PROFILE_NAMES.has(name)
  );
}

/**
 * Resolve the effective config for a named (or default) profile.
 * Returns bot/session fields from the named profile, falling back to
 * top-level fields for the default profile. Shared bridge settings
 * always come from the top level.
 */
export function resolveTelegramActiveProfile(
  config: TelegramConfig,
  profileName?: string,
): {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
} {
  if (!profileName || !config.profiles?.[profileName]) {
    return {
      botToken: config.botToken,
      botUsername: config.botUsername,
      botId: config.botId,
      allowedUserId: config.allowedUserId,
      lastUpdateId: config.lastUpdateId,
    };
  }
  const profile = config.profiles[profileName];
  return {
    botToken: profile.botToken,
    botUsername: profile.botUsername,
    botId: profile.botId,
    allowedUserId: profile.allowedUserId,
    lastUpdateId: profile.lastUpdateId,
  };
}

/** List defined profile names. */
export function getTelegramProfileNames(
  config: TelegramConfig,
): string[] {
  return Object.keys(config.profiles ?? {}).sort();
}

export interface TelegramConfigStore {
  get: () => TelegramConfig;
  getStoredConfig: () => TelegramConfig;
  set: (config: TelegramConfig) => void;
  update: (mutate: (config: TelegramConfig) => void) => void;
  activateProfile: (profileName: string | undefined) => boolean;
  getActiveProfileName: () => string | undefined;
  getBotToken: () => string | undefined;
  hasBotToken: () => boolean;
  getAllowedUserId: () => number | undefined;
  getInboundHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getAttachmentHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getOutboundHandlers: () => TelegramOutboundHandlerConfig[] | undefined;
  setAllowedUserId: (userId: number) => void;
  load: () => Promise<void>;
  persist: (config?: TelegramConfig) => Promise<void>;
}

export interface TelegramConfigStoreOptions {
  initialConfig?: TelegramConfig;
  agentDir?: string;
  configPath?: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramInvalidConfigRecovery {
  configPath: string;
  recoveryPath: string;
  error: unknown;
}

export interface TelegramConfigRuntime {
  updateVoiceConfig: (voice: NonNullable<TelegramConfig["voice"]>) => void;
}

export function setGlobalTelegramConfigRuntime(
  runtime: TelegramConfigRuntime | undefined,
): void {
  const globals = globalThis as Record<string, unknown>;
  if (runtime) globals[CONFIG_RUNTIME_KEY] = runtime;
  else delete globals[CONFIG_RUNTIME_KEY];
}

export function updateTelegramVoiceConfig(
  voice: NonNullable<TelegramConfig["voice"]>,
): boolean {
  const runtime = (globalThis as Record<string, unknown>)[
    CONFIG_RUNTIME_KEY
  ] as TelegramConfigRuntime | undefined;
  if (!runtime || typeof runtime.updateVoiceConfig !== "function") return false;
  runtime.updateVoiceConfig(voice);
  return true;
}

type TelegramMutableConfigStore = Pick<
  TelegramConfigStore,
  "get" | "set" | "persist"
> & {
  load?: () => Promise<void>;
};

function isEmptyTelegramConfig(config: TelegramConfig): boolean {
  return Object.keys(config).length === 0;
}

async function loadLatestTelegramConfig(
  configStore: TelegramMutableConfigStore,
): Promise<void> {
  if (!configStore.load) return;
  const before = configStore.get();
  await configStore.load();
  if (
    !isEmptyTelegramConfig(before) &&
    isEmptyTelegramConfig(configStore.get())
  ) {
    configStore.set(before);
  }
}

export function bindGlobalTelegramConfigRuntime(
  configStore: TelegramMutableConfigStore,
): void {
  setGlobalTelegramConfigRuntime({
    updateVoiceConfig(voice) {
      const current = configStore.get();
      const next = {
        ...current,
        voice: { ...(current.voice ?? {}), ...voice },
      };
      configStore.set(next);
      void configStore.persist(next);
    },
  });
}

function getInvalidTelegramConfigRecoveryPath(configPath: string): string {
  return `${configPath}.invalid-${process.pid}-${Date.now()}`;
}

export async function readTelegramConfig(
  configPath: string,
  options: {
    onInvalidConfig?: (recovery: TelegramInvalidConfigRecovery) => void;
  } = {},
): Promise<TelegramConfig> {
  if (!existsSync(configPath)) return {};
  const content = await readFile(configPath, "utf8");
  try {
    return JSON.parse(content) as TelegramConfig;
  } catch (error) {
    const recoveryPath = getInvalidTelegramConfigRecoveryPath(configPath);
    await rename(configPath, recoveryPath);
    options.onInvalidConfig?.({ configPath, recoveryPath, error });
    return {};
  }
}

export async function writeTelegramConfig(
  agentDir: string,
  configPath: string,
  config: TelegramConfig,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const tempConfigPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempConfigPath, JSON.stringify(config, null, "\t") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempConfigPath, 0o600);
  await rename(tempConfigPath, configPath);
  await chmod(configPath, 0o600);
}

function getTelegramProfileFields(config: TelegramConfig): TelegramBotProfile | undefined {
  const token = config.botToken?.trim();
  if (!token) return undefined;
  return {
    botToken: token,
    botUsername: config.botUsername,
    botId: config.botId,
    allowedUserId: config.allowedUserId,
    lastUpdateId: config.lastUpdateId,
  };
}

function applyTelegramProfile(
  config: TelegramConfig,
  profileName: string | undefined,
): TelegramConfig {
  if (!profileName) return config;
  const profile = config.profiles?.[profileName];
  if (!profile) return config;
  return {
    ...config,
    botToken: profile.botToken,
    botUsername: profile.botUsername,
    botId: profile.botId,
    allowedUserId: profile.allowedUserId,
    lastUpdateId: profile.lastUpdateId,
  };
}

function storeTelegramEffectiveConfig(
  baseConfig: TelegramConfig,
  nextConfig: TelegramConfig,
  profileName: string | undefined,
): TelegramConfig {
  if (!profileName) return nextConfig;
  const profile = getTelegramProfileFields(nextConfig);
  const profiles = { ...(baseConfig.profiles ?? {}) };
  if (profile) profiles[profileName] = profile;
  else delete profiles[profileName];
  return {
    ...nextConfig,
    botToken: baseConfig.botToken,
    botUsername: baseConfig.botUsername,
    botId: baseConfig.botId,
    allowedUserId: baseConfig.allowedUserId,
    lastUpdateId: baseConfig.lastUpdateId,
    profiles: Object.keys(profiles).length > 0 ? profiles : undefined,
  };
}

export function createTelegramConfigStore(
  options: TelegramConfigStoreOptions = {},
): TelegramConfigStore {
  let config: TelegramConfig = options.initialConfig ?? {};
  let activeProfileName: string | undefined;
  const agentDir = options.agentDir ?? resolveAgentDir();
  const configPath = options.configPath ?? getConfigPath();
  const getEffectiveConfig = () => applyTelegramProfile(config, activeProfileName);
  const setEffectiveConfig = (nextConfig: TelegramConfig) => {
    config = storeTelegramEffectiveConfig(config, nextConfig, activeProfileName);
  };
  return {
    get: getEffectiveConfig,
    getStoredConfig: () => config,
    set: setEffectiveConfig,
    update: (mutate) => {
      const nextConfig = getEffectiveConfig();
      mutate(nextConfig);
      setEffectiveConfig(nextConfig);
    },
    activateProfile: (profileName) => {
      if (profileName && !config.profiles?.[profileName]) return false;
      activeProfileName = profileName;
      return true;
    },
    getActiveProfileName: () => activeProfileName,
    getBotToken: () => getEffectiveConfig().botToken,
    hasBotToken: () => !!getEffectiveConfig().botToken,
    getAllowedUserId: () => getEffectiveConfig().allowedUserId,
    getInboundHandlers: () => [
      ...(config.inboundHandlers ?? []),
      ...(config.attachmentHandlers ?? []),
    ],
    getAttachmentHandlers: () => config.attachmentHandlers,
    getOutboundHandlers: () => config.outboundHandlers,
    setAllowedUserId: (userId) => {
      const nextConfig = getEffectiveConfig();
      nextConfig.allowedUserId = userId;
      setEffectiveConfig(nextConfig);
    },
    load: async () => {
      config = await readTelegramConfig(configPath, {
        onInvalidConfig: (recovery) => {
          options.recordRuntimeEvent?.("config", recovery.error, {
            phase: "load",
            configPath: recovery.configPath,
            recoveryPath: recovery.recoveryPath,
          });
        },
      });
      if (activeProfileName && !config.profiles?.[activeProfileName]) {
        activeProfileName = undefined;
      }
    },
    persist: async (nextConfig = getEffectiveConfig()) => {
      const storedConfig = storeTelegramEffectiveConfig(
        config,
        nextConfig,
        activeProfileName,
      );
      config = storedConfig;
      await writeTelegramConfig(agentDir, configPath, storedConfig);
    },
  };
}

export function createTelegramProactivePushChecker(
  configStore: Pick<TelegramConfigStore, "get">,
): () => boolean {
  return () => configStore.get().proactivePush ?? false;
}

export function createTelegramProactivePushSetter(
  configStore: TelegramMutableConfigStore,
): (enabled: boolean) => Promise<void> {
  return async (enabled) => {
    await loadLatestTelegramConfig(configStore);
    const config = { ...configStore.get(), proactivePush: enabled };
    configStore.set(config);
    await configStore.persist(config);
  };
}

export function createTelegramDraftPreviewsChecker(
  configStore: Pick<TelegramConfigStore, "get">,
): () => boolean {
  return () => {
    const config = configStore.get();
    return (
      config.assistant?.draftPreviews ??
      config.draftPreviews ??
      config.richDraftPreviews ??
      false
    );
  };
}

export function createTelegramDraftPreviewsSetter(
  configStore: TelegramMutableConfigStore,
): (enabled: boolean) => Promise<void> {
  return async (enabled) => {
    await loadLatestTelegramConfig(configStore);
    const {
      draftPreviews: _legacyDraftPreviews,
      richDraftPreviews: _legacyRichDraftPreviews,
      ...current
    } = configStore.get();
    const config = {
      ...current,
      assistant: { ...current.assistant, draftPreviews: enabled },
    };
    configStore.set(config);
    await configStore.persist(config);
  };
}

export function createTelegramAssistantRenderingModeGetter(
  configStore: Pick<TelegramConfigStore, "get">,
): () => TelegramAssistantRenderingMode {
  return () => {
    const config = configStore.get();
    const mode = config.assistant?.rendering ?? config.assistantRendering;
    return mode === "html" ? "html" : "rich";
  };
}

export function createTelegramAssistantRenderingModeSetter(
  configStore: TelegramMutableConfigStore,
): (mode: TelegramAssistantRenderingMode) => Promise<void> {
  return async (mode) => {
    await loadLatestTelegramConfig(configStore);
    const { assistantRendering: _legacyAssistantRendering, ...current } =
      configStore.get();
    const config = {
      ...current,
      assistant: { ...current.assistant, rendering: mode },
    };
    configStore.set(config);
    await configStore.persist(config);
  };
}

export function createTelegramVoiceReplyModeGetter(
  configStore: Pick<TelegramConfigStore, "get">,
): () => "manual" | "mirror" | "always" {
  return () => {
    const mode = configStore.get().voice?.replyMode;
    return mode === "mirror" || mode === "always" || mode === "manual"
      ? mode
      : "manual";
  };
}

export function createTelegramVoiceReplyModeConfiguredChecker(
  configStore: Pick<TelegramConfigStore, "get">,
): () => boolean {
  return () => {
    const mode = configStore.get().voice?.replyMode;
    return mode === "mirror" || mode === "always" || mode === "manual";
  };
}

export function createTelegramVoiceReplyModeSetter(
  configStore: TelegramMutableConfigStore,
): (replyMode: "manual" | "mirror" | "always" | undefined) => Promise<void> {
  return async (replyMode) => {
    await loadLatestTelegramConfig(configStore);
    const current = configStore.get();
    if (replyMode === undefined) {
      const { replyMode: _replyMode, ...remainingVoice } = current.voice ?? {};
      const next = { ...current };
      if (Object.keys(remainingVoice).length > 0) next.voice = remainingVoice;
      else delete next.voice;
      configStore.set(next);
      await configStore.persist(next);
      return;
    }
    const next = { ...current, voice: { ...(current.voice ?? {}), replyMode } };
    configStore.set(next);
    await configStore.persist(next);
  };
}

function getSystemTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

export function resolveTelegramTimeConfig(
  raw: TelegramTimeConfig | undefined,
): ResolvedTelegramTimeConfig {
  const injectionMode: TelegramTimeMode =
    raw?.injectionMode === "always" || raw?.injectionMode === "interval"
      ? raw.injectionMode
      : "hidden";
  const interval =
    typeof raw?.interval === "number" && raw.interval > 0
      ? raw.interval
      : 60 * 60 * 1000;
  const timezone = getSystemTimezone();
  return { injectionMode, interval, timezone };
}

export function createTelegramTimeConfigGetter(
  configStore: Pick<TelegramConfigStore, "get">,
): () => ResolvedTelegramTimeConfig {
  return () => resolveTelegramTimeConfig(configStore.get().time);
}

export function createTelegramTimeInjectionModeGetter(
  configStore: Pick<TelegramConfigStore, "get">,
): () => TelegramTimeMode {
  return () => resolveTelegramTimeConfig(configStore.get().time).injectionMode;
}

export function createTelegramTimeInjectionModeSetter(
  configStore: TelegramMutableConfigStore,
): (injectionMode: TelegramTimeMode) => Promise<void> {
  return async (injectionMode) => {
    await loadLatestTelegramConfig(configStore);
    const current = configStore.get();
    if (injectionMode === "hidden") {
      const { injectionMode: _injectionMode, ...remainingTime } =
        current.time ?? {};
      const next = { ...current };
      if (Object.keys(remainingTime).length > 0) next.time = remainingTime;
      else delete next.time;
      configStore.set(next);
      await configStore.persist(next);
      return;
    }
    const next = {
      ...current,
      time: { ...(current.time ?? {}), injectionMode },
    };
    configStore.set(next);
    await configStore.persist(next);
  };
}

export interface TelegramProactivePushTarget {
  chatId: number;
  threadId?: number;
}

export function createTelegramProactivePushChatIdGetter(deps: {
  getActiveTurnChatId: () => number | undefined;
  getAllowedUserId: () => number | undefined;
}): () => number | undefined {
  return () => deps.getActiveTurnChatId() ?? deps.getAllowedUserId();
}

export function createTelegramProactivePushTargetGetter(deps: {
  getActiveTurnTarget: () => TelegramProactivePushTarget | undefined;
  getAssignedTarget: () => TelegramProactivePushTarget | undefined;
  getAllowedUserId: () => number | undefined;
}): () => TelegramProactivePushTarget | undefined {
  return () => {
    const activeTarget = deps.getActiveTurnTarget();
    if (activeTarget) return activeTarget;
    const assignedTarget = deps.getAssignedTarget();
    if (assignedTarget) return assignedTarget;
    const chatId = deps.getAllowedUserId();
    return typeof chatId === "number" ? { chatId } : undefined;
  };
}

export function createTelegramConfigControls(
  configStore: TelegramMutableConfigStore,
) {
  return {
    isProactivePushEnabled: createTelegramProactivePushChecker(configStore),
    setProactivePushEnabled: createTelegramProactivePushSetter(configStore),
    areDraftPreviewsEnabled: createTelegramDraftPreviewsChecker(configStore),
    setDraftPreviewsEnabled: createTelegramDraftPreviewsSetter(configStore),
    getAssistantRenderingMode:
      createTelegramAssistantRenderingModeGetter(configStore),
    setAssistantRenderingMode:
      createTelegramAssistantRenderingModeSetter(configStore),
    getVoiceReplyMode: createTelegramVoiceReplyModeGetter(configStore),
    isVoiceReplyModeConfigured:
      createTelegramVoiceReplyModeConfiguredChecker(configStore),
    setVoiceReplyMode: createTelegramVoiceReplyModeSetter(configStore),
    getTimeInjectionMode: createTelegramTimeInjectionModeGetter(configStore),
    setTimeInjectionMode: createTelegramTimeInjectionModeSetter(configStore),
  };
}

export type TelegramAuthorizationState =
  { kind: "pair"; userId: number } | { kind: "allow" } | { kind: "deny" };

export interface TelegramUserPairingDeps<TContext> {
  allowedUserId?: number;
  ctx: TContext;
  setAllowedUserId: (userId: number) => void;
  persistConfig: () => Promise<void>;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramUserPairingRuntimeDeps<TContext> {
  getAllowedUserId: () => number | undefined;
  setAllowedUserId: (userId: number) => void;
  persistConfig: () => Promise<void>;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramUserPairingRuntime<TContext> {
  pairIfNeeded: (userId: number, ctx: TContext) => Promise<boolean>;
}

export function getTelegramAuthorizationState(
  userId: number,
  allowedUserId?: number,
): TelegramAuthorizationState {
  if (allowedUserId === undefined) {
    return { kind: "pair", userId };
  }
  if (userId === allowedUserId) {
    return { kind: "allow" };
  }
  return { kind: "deny" };
}

function isTelegramStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale after session") ||
      error.message.includes("stale ctx"))
  );
}

export async function pairTelegramUserIfNeeded<TContext>(
  userId: number,
  deps: TelegramUserPairingDeps<TContext>,
): Promise<boolean> {
  const authorization = getTelegramAuthorizationState(
    userId,
    deps.allowedUserId,
  );
  if (authorization.kind !== "pair") return false;
  deps.setAllowedUserId(authorization.userId);
  await deps.persistConfig();
  try {
    deps.updateStatus(deps.ctx);
  } catch (error) {
    if (!isTelegramStaleContextError(error)) throw error;
  }
  return true;
}

export function createTelegramUserPairingRuntime<TContext>(
  deps: TelegramUserPairingRuntimeDeps<TContext>,
): TelegramUserPairingRuntime<TContext> {
  return {
    pairIfNeeded: (userId, ctx) =>
      pairTelegramUserIfNeeded(userId, {
        allowedUserId: deps.getAllowedUserId(),
        ctx,
        setAllowedUserId: deps.setAllowedUserId,
        persistConfig: deps.persistConfig,
        updateStatus: deps.updateStatus,
      }),
  };
}
