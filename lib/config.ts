/**
 * Telegram bridge config and pairing helpers
 * Zones: telegram config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, live config controls, authorization policy, and first-user pairing side effects
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { TelegramInboundHandlerConfig } from "./inbound.ts";
import type { CommandTemplateObjectConfig } from "./command-templates.ts";

const CONFIG_RUNTIME_KEY = "__piTelegramConfigRuntime__";

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

function getConfigPath(): string {
  return join(getAgentDir(), "telegram.json");
}

export type TelegramOutboundCommandTemplateConfig =
  | string
  | CommandTemplateObjectConfig;
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
  voice?: {
    replyMode?: "manual" | "mirror" | "always";
    /** Whether to attach the provider's transcriptText as caption on voice messages */
    sendTranscript?: boolean;
  };
  time?: TelegramTimeConfig;
  /**
   * Optional user-supplied bot commands to append to the registered Telegram
   * setMyCommands list (the blue `/` autocomplete). Each entry is
   * `{ command, description }`. Names must match `[a-z0-9_]{1,32}` and may not
   * clash with builtin or reserved bridge commands; invalid entries are dropped
   * silently by the registrar. Descriptions are trimmed and capped at 256 chars.
   */
  extraBotCommands?: { command: string; description: string }[];
}

export interface TelegramConfigStore {
  get: () => TelegramConfig;
  set: (config: TelegramConfig) => void;
  update: (mutate: (config: TelegramConfig) => void) => void;
  getBotToken: () => string | undefined;
  hasBotToken: () => boolean;
  getAllowedUserId: () => number | undefined;
  getInboundHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getAttachmentHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getOutboundHandlers: () => TelegramOutboundHandlerConfig[] | undefined;
  getExtraBotCommands: () =>
    | NonNullable<TelegramConfig["extraBotCommands"]>
    | undefined;
  setAllowedUserId: (userId: number) => void;
  load: () => Promise<void>;
  persist: (config?: TelegramConfig) => Promise<void>;
}

export interface TelegramConfigStoreOptions {
  initialConfig?: TelegramConfig;
  agentDir?: string;
  configPath?: string;
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

export function bindGlobalTelegramConfigRuntime(
  configStore: Pick<TelegramConfigStore, "get" | "set" | "persist">,
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

export async function readTelegramConfig(
  configPath: string,
): Promise<TelegramConfig> {
  if (!existsSync(configPath)) return {};
  const content = await readFile(configPath, "utf8");
  return JSON.parse(content) as TelegramConfig;
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

export function createTelegramConfigStore(
  options: TelegramConfigStoreOptions = {},
): TelegramConfigStore {
  let config: TelegramConfig = options.initialConfig ?? {};
  const agentDir = options.agentDir ?? getAgentDir();
  const configPath = options.configPath ?? getConfigPath();
  return {
    get: () => config,
    set: (nextConfig) => {
      config = nextConfig;
    },
    update: (mutate) => {
      mutate(config);
    },
    getBotToken: () => config.botToken,
    hasBotToken: () => !!config.botToken,
    getAllowedUserId: () => config.allowedUserId,
    getInboundHandlers: () => [
      ...(config.inboundHandlers ?? []),
      ...(config.attachmentHandlers ?? []),
    ],
    getAttachmentHandlers: () => config.attachmentHandlers,
    getOutboundHandlers: () => config.outboundHandlers,
    getExtraBotCommands: () => config.extraBotCommands,
    setAllowedUserId: (userId) => {
      config.allowedUserId = userId;
    },
    load: async () => {
      config = await readTelegramConfig(configPath);
    },
    persist: async (nextConfig = config) => {
      await writeTelegramConfig(agentDir, configPath, nextConfig);
    },
  };
}

export function createTelegramProactivePushChecker(
  configStore: Pick<TelegramConfigStore, "get">,
): () => boolean {
  return () => configStore.get().proactivePush ?? false;
}

export function createTelegramProactivePushSetter(
  configStore: Pick<TelegramConfigStore, "get" | "set" | "persist">,
): (enabled: boolean) => Promise<void> {
  return async (enabled) => {
    const config = { ...configStore.get(), proactivePush: enabled };
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
  configStore: Pick<TelegramConfigStore, "get" | "set" | "persist">,
): (replyMode: "manual" | "mirror" | "always" | undefined) => Promise<void> {
  return async (replyMode) => {
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
  configStore: Pick<TelegramConfigStore, "get" | "set" | "persist">,
): (injectionMode: TelegramTimeMode) => Promise<void> {
  return async (injectionMode) => {
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

export function createTelegramProactivePushChatIdGetter(deps: {
  getActiveTurnChatId: () => number | undefined;
  getAllowedUserId: () => number | undefined;
}): () => number | undefined {
  return () => deps.getActiveTurnChatId() ?? deps.getAllowedUserId();
}

export function createTelegramConfigControls(
  configStore: Pick<TelegramConfigStore, "get" | "set" | "persist">,
) {
  return {
    isProactivePushEnabled: createTelegramProactivePushChecker(configStore),
    setProactivePushEnabled: createTelegramProactivePushSetter(configStore),
    getVoiceReplyMode: createTelegramVoiceReplyModeGetter(configStore),
    isVoiceReplyModeConfigured:
      createTelegramVoiceReplyModeConfiguredChecker(configStore),
    setVoiceReplyMode: createTelegramVoiceReplyModeSetter(configStore),
    getTimeInjectionMode: createTelegramTimeInjectionModeGetter(configStore),
    setTimeInjectionMode: createTelegramTimeInjectionModeSetter(configStore),
  };
}

export type TelegramAuthorizationState =
  | { kind: "pair"; userId: number }
  | { kind: "allow" }
  | { kind: "deny" };

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
