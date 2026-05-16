/**
 * Telegram bridge config and pairing helpers
 * Zones: telegram config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, authorization policy, and first-user pairing side effects
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { TelegramInboundHandlerConfig } from "./inbound-handlers.ts";
import type { CommandTemplateObjectConfig } from "./command-templates.ts";

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
  pipe?: TelegramOutboundCommandTemplateConfig[];
  output?: string;
  timeout?: number;
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
    replyMode?: "manual" | "mirror" | "voice";
    /** Whether to attach the provider's transcriptText as caption on voice messages */
    sendTranscript?: boolean;
  };
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
  setAllowedUserId: (userId: number) => void;
  load: () => Promise<void>;
  persist: (config?: TelegramConfig) => Promise<void>;
}

export interface TelegramConfigStoreOptions {
  initialConfig?: TelegramConfig;
  agentDir?: string;
  configPath?: string;
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

export function createTelegramProactivePushChatIdGetter(deps: {
  getActiveTurnChatId: () => number | undefined;
  getAllowedUserId: () => number | undefined;
}): () => number | undefined {
  return () => deps.getActiveTurnChatId() ?? deps.getAllowedUserId();
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
