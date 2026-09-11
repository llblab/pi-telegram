/**
 * Telegram bridge config and pairing helpers
 * Zones: telegram config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, live config controls, authorization policy, and first-user pairing side effects
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import {
  resolveAgentDir,
  resolveTelegramConfigPath,
  TELEGRAM_DEFAULT_PROFILE_NAME,
} from "./paths.ts";
export { TELEGRAM_DEFAULT_PROFILE_NAME } from "./paths.ts";

import type { CommandTemplateObjectConfig } from "./command-templates.ts";
import type { TelegramInboundHandlerConfig } from "./inbound.ts";
import { withTelegramFileTransaction } from "./locks.ts";

const CONFIG_RUNTIME_KEY = "__piTelegramConfigRuntime__";
const CONFIG_REPLACE_RETRY_ATTEMPTS = 5;
const CONFIG_REPLACE_RETRY_DELAY_MS = 25;

function isRetryableConfigReplaceError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepConfigReplaceRetry(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function replaceTelegramConfigFile(tempPath: string, configPath: string): void {
  for (let attempt = 0; attempt < CONFIG_REPLACE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      renameSync(tempPath, configPath);
      return;
    } catch (error) {
      if (
        !isRetryableConfigReplaceError(error) ||
        attempt === CONFIG_REPLACE_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      sleepConfigReplaceRetry(CONFIG_REPLACE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function getConfigPath(): string {
  return resolveTelegramConfigPath();
}

const TELEGRAM_BOT_TOKEN_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parsed stored bot-token form: a literal secret or one environment-variable reference. */
export type TelegramBotTokenReference =
  | { kind: "literal"; token: string }
  | { kind: "environment"; variable: string }
  | { kind: "malformed" };

/**
 * Parse a persisted bot-token value. `$NAME` and `${NAME}` are exact
 * environment-variable references. Any other `$`-prefixed value is malformed
 * rather than a literal secret so a broken reference fails closed.
 */
export function getTelegramBotTokenReference(
  value: string | undefined,
): TelegramBotTokenReference | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("$")) return { kind: "literal", token: trimmed };
  const body =
    trimmed.startsWith("${") && trimmed.endsWith("}")
      ? trimmed.slice(2, -1)
      : trimmed.slice(1);
  return TELEGRAM_BOT_TOKEN_ENV_NAME_PATTERN.test(body)
    ? { kind: "environment", variable: body }
    : { kind: "malformed" };
}

/** Resolve a persisted token at a validation/activation boundary. */
export function resolveTelegramBotToken(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reference = getTelegramBotTokenReference(value);
  if (reference?.kind === "literal") return reference.token;
  if (reference?.kind !== "environment") return undefined;
  return env[reference.variable]?.trim() || undefined;
}

/** Redacted diagnostic for an unresolved or malformed token reference. */
export function getTelegramBotTokenDiagnostic(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reference = getTelegramBotTokenReference(value);
  if (reference?.kind === "malformed") {
    return "Telegram bot token environment reference is malformed; use $NAME or ${NAME}.";
  }
  if (reference?.kind !== "environment") return undefined;
  if (resolveTelegramBotToken(value, env)) return undefined;
  return `Telegram bot token environment variable ${reference.variable} is not set.`;
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
  interval?: number;
}

export interface ResolvedTelegramTimeConfig {
  injectionMode: TelegramTimeMode;
  interval: number;
  timezone: string;
}

export type TelegramThreadDisplayMode = "letters" | "names" | "directories";

export function resolveTelegramThreadDisplayMode(
  config: Pick<TelegramConfig, "threadDisplayMode">,
): TelegramThreadDisplayMode {
  return config.threadDisplayMode === "names"
    ? "names"
    : config.threadDisplayMode === "directories"
      ? "directories"
      : "letters";
}

export async function setTelegramThreadDisplayMode(
  store: TelegramConfigStore,
  mode: TelegramThreadDisplayMode,
  isCurrent: () => boolean,
): Promise<void> {
  if (!["letters", "names", "directories"].includes(mode)) {
    throw new Error("Invalid Telegram Thread display mode.");
  }
  const profile = store.getActiveProfileName();
  const current = () => isCurrent() && store.getActiveProfileName() === profile;
  if (!current()) throw new Error("Telegram Thread display setting lost authority.");
  await store.load();
  if (!current() || !store.hasBotToken()) {
    throw new Error("Telegram Thread display setting lost its configured profile.");
  }
  await store.persist({ ...store.get(), threadDisplayMode: mode }, { isCurrent: current });
  if (!current()) throw new Error("Telegram Thread display setting changed during persistence.");
}

export type TelegramAssistantRenderingMode = "rich" | "html";
export type TelegramActivityVerbosity =
  | "quiet"
  | "thinking"
  | "tools"
  | "verbose";

export interface TelegramConfig {
  /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
  botToken?: string;
  /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
  botUsername?: string;
  /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
  botId?: number;
  /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
  allowedUserId?: number;
  /** Effective view; persisted under profiles.<name>. */
  threadDisplayMode?: TelegramThreadDisplayMode;
  inboundHandlers?: TelegramInboundHandlerConfig[];
  attachmentHandlers?: TelegramInboundHandlerConfig[];
  outboundHandlers?: TelegramOutboundHandlerConfig[];
  assistant?: {
    draftPreviews?: boolean;
    rendering?: TelegramAssistantRenderingMode;
    activity?: TelegramActivityVerbosity;
    timeInjection?: TelegramTimeMode;
    /** @deprecated use activity */
    activityVerbosity?: TelegramActivityVerbosity;
  };
  /** @deprecated use assistant.draftPreviews */
  draftPreviews?: boolean;
  /** @deprecated use assistant.draftPreviews */
  richDraftPreviews?: boolean;
  /** @deprecated use assistant.rendering */
  assistantRendering?: TelegramAssistantRenderingMode;
  voice?: {
    /** `hidden` is a read-only compatibility alias for the former manual mode. */
    replyMode?: "manual" | "hidden" | "mirror" | "always";
  };
  time?: TelegramTimeConfig;
  threads?: {
    /** Delete this instance's bound Telegram thread on graceful Pi quit. */
    automaticCleanup?: boolean;
  };
  /** Canonical bot/session profiles, including profiles.default. */
  profiles?: Record<string, TelegramBotProfile>;
}

/**
 * Per-profile bot/session identity and Thread display preference.
 * Stored under `profiles.<name>` in telegram.json.
 * Shared bridge settings (inboundHandlers, outboundHandlers, voice, time,
 * assistant) stay at the top level.
 */
export interface TelegramBotProfile {
  botToken: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  threadDisplayMode?: TelegramThreadDisplayMode;
}

interface TelegramLegacyCursorCarrier {
  lastUpdateId?: number;
}

/** Profile names must contain only lowercase ASCII letters and digits; max 32 chars. */
const TELEGRAM_PROFILE_NAME_PATTERN = /^[a-z0-9]{1,32}$/;
const TELEGRAM_RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "main",
  "active",
]);

export function isValidTelegramProfileName(name: string): boolean {
  return (
    TELEGRAM_PROFILE_NAME_PATTERN.test(name) &&
    !TELEGRAM_RESERVED_PROFILE_NAMES.has(name)
  );
}

/** List defined profile names. */
export function getTelegramProfileNames(config: TelegramConfig): string[] {
  return Object.keys(config.profiles ?? {}).sort();
}

export interface TelegramConfigStore {
  get: () => TelegramConfig;
  getStoredConfig: () => TelegramConfig;
  set: (config: TelegramConfig) => void;
  setProfile: (profileName: string, profile: TelegramBotProfile) => void;
  update: (mutate: (config: TelegramConfig) => void) => void;
  activateProfile: (profileName: string | undefined) => boolean;
  getActiveProfileName: () => string | undefined;
  getBotToken: () => string | undefined;
  getBotTokenDiagnostic: () => string | undefined;
  hasBotToken: () => boolean;
  getAllowedUserId: () => number | undefined;
  getLegacyPollingCursor: () => number | undefined;
  removeLegacyPollingCursor: () => void;
  getInboundHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getAttachmentHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  getOutboundHandlers: () => TelegramOutboundHandlerConfig[] | undefined;
  setAllowedUserId: (userId: number) => void;
  /** Publish an unpaired profile owner atomically; true only for the resulting exact owner. */
  persistAllowedUserId: (
    userId: number,
    assertExecutionCurrent?: () => void,
    commitIfOwned?: (commit: () => void) => boolean,
  ) => Promise<boolean>;
  /** Lock-only serialization for trusted synchronous source operations, not authorization.
   * Does not read/adopt config. Acquire required Workspace admission first; never
   * acquire owners or nest config admission here. Do not pass async callbacks:
   * returned promises are not protected after their synchronous prefix.
   */
  withSourceSerialization: <T>(operation: () => T) => T;
  /** Trusted synchronous publication only; caller acquires Workspace admission before this config transaction. */
  withPairingAdmission: <T>(
    profileName: string,
    tokenSha256: string,
    publish: (preApprovalExcluded: boolean) => T,
  ) => T;
  /** Observe an existing exact owner and refresh an unpaired cache; never create an owner. Callback must be synchronous. */
  withPairedUserAdmission: <T>(
    profileName: string,
    tokenSha256: string,
    userId: number,
    publish: () => T,
    assertExecutionCurrent?: () => void,
  ) => { admitted: false } | { admitted: true; value: T };
  load: () => Promise<void>;
  didLastLoadRecoverInvalidConfig: () => boolean;
  persist: (config?: TelegramConfig, options?: { isCurrent?: () => boolean }) => Promise<void>;
}

export function createTelegramConfigBotIdGetter(
  store: Pick<TelegramConfigStore, "get">,
): () => number | undefined {
  return () => store.get().botId;
}

export function createTelegramActiveProfileKeyGetter(
  store: Pick<TelegramConfigStore, "getActiveProfileName">,
): () => string {
  return () => store.getActiveProfileName() ?? TELEGRAM_DEFAULT_PROFILE_NAME;
}

export interface TelegramConfigStoreOptions {
  initialConfig?: TelegramConfig;
  agentDir?: string;
  configPath?: string;
  /** Environment used to resolve `$NAME` token references; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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
  didLastLoadRecoverInvalidConfig?: () => boolean;
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
  const content = readFileSync(configPath, "utf8");
  try {
    return JSON.parse(content) as TelegramConfig;
  } catch {
    // Atomic config publication makes ordinary reads safe without serialization.
    // Acquire the transaction only before destructive invalid-file recovery.
    return withTelegramFileTransaction(`${configPath}.transaction`, () => {
      if (!existsSync(configPath)) return {};
      const identity = statSync(configPath);
      const currentContent = readFileSync(configPath, "utf8");
      try {
        return JSON.parse(currentContent) as TelegramConfig;
      } catch (error) {
        const currentIdentity = statSync(configPath);
        if (
          currentIdentity.dev !== identity.dev ||
          currentIdentity.ino !== identity.ino ||
          currentIdentity.size !== identity.size ||
          currentIdentity.mtimeMs !== identity.mtimeMs
        ) {
          throw new Error(
            `Telegram config changed while validating invalid content: ${configPath}`,
            { cause: error },
          );
        }
        const recoveryPath = getInvalidTelegramConfigRecoveryPath(configPath);
        renameSync(configPath, recoveryPath);
        options.onInvalidConfig?.({ configPath, recoveryPath, error });
        return {};
      }
    });
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

function isPlainConfigRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneTelegramConfig<T>(value: T): T {
  return structuredClone(value);
}

function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeTelegramConfigDelta(
  base: Record<string, unknown>,
  desired: Record<string, unknown>,
  latest: Record<string, unknown>,
): Record<string, unknown> {
  const merged = cloneTelegramConfig(latest);
  for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
    const baseHas = Object.hasOwn(base, key);
    const desiredHas = Object.hasOwn(desired, key);
    const baseValue = base[key];
    const desiredValue = desired[key];
    if (baseHas === desiredHas && configValuesEqual(baseValue, desiredValue)) {
      continue;
    }
    if (!desiredHas) {
      delete merged[key];
      continue;
    }
    if (
      isPlainConfigRecord(desiredValue) &&
      (!baseHas || isPlainConfigRecord(baseValue))
    ) {
      merged[key] = mergeTelegramConfigDelta(
        isPlainConfigRecord(baseValue) ? baseValue : {},
        desiredValue,
        isPlainConfigRecord(merged[key]) ? merged[key] : {},
      );
      continue;
    }
    merged[key] = cloneTelegramConfig(desiredValue);
  }
  return merged;
}

function readTelegramConfigForTransaction(configPath: string): TelegramConfig {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isPlainConfigRecord(parsed)) {
    throw new Error(`Invalid Telegram config object: ${configPath}`);
  }
  return parsed as TelegramConfig;
}

function writeTelegramConfigInTransaction(
  agentDir: string,
  configPath: string,
  config: TelegramConfig,
): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const tempConfigPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tempConfigPath, `${JSON.stringify(config, null, "\t")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(tempConfigPath, 0o600);
  try {
    replaceTelegramConfigFile(tempConfigPath, configPath);
    chmodSync(configPath, 0o600);
  } finally {
    try {
      unlinkSync(tempConfigPath);
    } catch {
      /* rename consumed the temp file or cleanup is best effort */
    }
  }
}

export function getTelegramProfileFields(
  config: TelegramConfig,
): TelegramBotProfile | undefined {
  const token = config.botToken?.trim();
  if (!token) return undefined;
  const legacyCursor = (config as TelegramConfig & TelegramLegacyCursorCarrier)
    .lastUpdateId;
  return {
    botToken: token,
    ...(config.botUsername !== undefined
      ? { botUsername: config.botUsername }
      : {}),
    ...(config.botId !== undefined ? { botId: config.botId } : {}),
    ...(config.allowedUserId !== undefined
      ? { allowedUserId: config.allowedUserId }
      : {}),
    ...(config.threadDisplayMode !== undefined
      ? { threadDisplayMode: config.threadDisplayMode }
      : {}),
    ...(legacyCursor !== undefined ? { lastUpdateId: legacyCursor } : {}),
  };
}

function omitTelegramRootProfileFields(config: TelegramConfig): TelegramConfig {
  const {
    botToken: _botToken,
    botUsername: _botUsername,
    botId: _botId,
    allowedUserId: _allowedUserId,
    threadDisplayMode: _threadDisplayMode,
    lastUpdateId: _lastUpdateId,
    ...sharedConfig
  } = config as TelegramConfig & TelegramLegacyCursorCarrier;
  return sharedConfig;
}

function omitRetiredProactivePush(config: TelegramConfig): {
  config: TelegramConfig;
  changed: boolean;
} {
  const assistant = config.assistant as
    | (NonNullable<TelegramConfig["assistant"]> & { proactivePush?: unknown })
    | undefined;
  if (!assistant || !Object.hasOwn(assistant, "proactivePush")) {
    return { config, changed: false };
  }
  const { proactivePush: _proactivePush, ...remainingAssistant } = assistant;
  const next = { ...config };
  if (Object.keys(remainingAssistant).length > 0) {
    next.assistant = remainingAssistant;
  } else {
    delete next.assistant;
  }
  return { config: next, changed: true };
}

export function normalizeTelegramDefaultProfileConfig(config: TelegramConfig): {
  config: TelegramConfig;
  changed: boolean;
} {
  const retiredProactivePush = omitRetiredProactivePush(config);
  config = retiredProactivePush.config;
  const hasLegacyRootProfile = [
    "botToken",
    "botUsername",
    "botId",
    "allowedUserId",
    "threadDisplayMode",
    "lastUpdateId",
  ].some((field) => Object.hasOwn(config, field));
  if (!hasLegacyRootProfile) {
    return { config, changed: retiredProactivePush.changed };
  }
  const canonicalProfile = config.profiles?.[TELEGRAM_DEFAULT_PROFILE_NAME];
  const legacyToken = config.botToken?.trim();
  if (Object.hasOwn(config, "botToken") && !legacyToken) {
    throw new Error("Legacy Telegram default profile has no bot token");
  }
  const legacyProfile: Partial<TelegramBotProfile> &
    TelegramLegacyCursorCarrier = {
    ...(legacyToken ? { botToken: legacyToken } : {}),
    ...(config.botUsername !== undefined
      ? { botUsername: config.botUsername }
      : {}),
    ...(config.botId !== undefined ? { botId: config.botId } : {}),
    ...(config.allowedUserId !== undefined
      ? { allowedUserId: config.allowedUserId }
      : {}),
    ...(config.threadDisplayMode !== undefined
      ? { threadDisplayMode: config.threadDisplayMode }
      : {}),
    ...((config as TelegramConfig & TelegramLegacyCursorCarrier)
      .lastUpdateId !== undefined
      ? {
          lastUpdateId: (config as TelegramConfig & TelegramLegacyCursorCarrier)
            .lastUpdateId,
        }
      : {}),
  };
  if (!canonicalProfile && !legacyToken) {
    throw new Error("Legacy Telegram default profile has no bot token");
  }
  const hasConflict = canonicalProfile
    ? Object.entries(legacyProfile).some(
        ([field, value]) =>
          Object.hasOwn(canonicalProfile, field) &&
          !configValuesEqual(
            canonicalProfile[field as keyof TelegramBotProfile],
            value,
          ),
      )
    : false;
  if (hasConflict) {
    throw new Error(
      "Conflicting Telegram default profile identity at root and profiles.default",
    );
  }
  const normalizedProfile: TelegramBotProfile = canonicalProfile
    ? { ...legacyProfile, ...canonicalProfile }
    : (legacyProfile as TelegramBotProfile);
  return {
    config: {
      ...omitTelegramRootProfileFields(config),
      profiles: {
        ...(config.profiles ?? {}),
        [TELEGRAM_DEFAULT_PROFILE_NAME]: normalizedProfile,
      },
    },
    changed: true,
  };
}

function applyTelegramProfile(
  config: TelegramConfig,
  profileName: string | undefined,
): TelegramConfig {
  const effectiveProfileName = profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
  const profile = config.profiles?.[effectiveProfileName];
  if (!profile) return omitTelegramRootProfileFields(config);
  return {
    ...omitTelegramRootProfileFields(config),
    ...profile,
  };
}

function storeTelegramEffectiveConfig(
  baseConfig: TelegramConfig,
  nextConfig: TelegramConfig,
  profileName: string | undefined,
): TelegramConfig {
  const effectiveProfileName = profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
  const profile = getTelegramProfileFields(nextConfig);
  const profiles = { ...(baseConfig.profiles ?? {}) };
  if (profile) profiles[effectiveProfileName] = profile;
  else delete profiles[effectiveProfileName];
  return {
    ...omitTelegramRootProfileFields(nextConfig),
    profiles: Object.keys(profiles).length > 0 ? profiles : undefined,
  };
}

export function createTelegramConfigStore(
  options: TelegramConfigStoreOptions = {},
): TelegramConfigStore {
  let config: TelegramConfig = normalizeTelegramDefaultProfileConfig(
    cloneTelegramConfig(options.initialConfig ?? {}),
  ).config;
  let persistedConfig: TelegramConfig = {};
  let mutationVersion = 0;
  let persistQueue: Promise<void> = Promise.resolve();
  let activeProfileName: string | undefined;
  let lastLoadRecoveredInvalidConfig = false;
  const agentDir = options.agentDir ?? resolveAgentDir();
  const configPath = options.configPath ?? getConfigPath();
  const env = options.env ?? process.env;
  const getEffectiveConfig = () =>
    applyTelegramProfile(config, activeProfileName);
  const setEffectiveConfig = (nextConfig: TelegramConfig) => {
    config = storeTelegramEffectiveConfig(
      config,
      nextConfig,
      activeProfileName,
    );
    mutationVersion += 1;
  };
  const adoptPersistedConfig = (merged: TelegramConfig, preserveLocalChanges: boolean) => {
    // Local edits are relative to the latest observation, not a queued write's older request baseline.
    const nextConfig = preserveLocalChanges
      ? mergeTelegramConfigDelta(persistedConfig as Record<string, unknown>, config as Record<string, unknown>,
          merged as Record<string, unknown>) as TelegramConfig
      : cloneTelegramConfig(merged);
    persistedConfig = cloneTelegramConfig(merged);
    config = nextConfig;
  };
  const withPersistedPairingProfile = <T>(
    profileName: string, tokenSha256: string,
    observe: (latest: TelegramConfig, profile: TelegramBotProfile) => T,
  ): T => {
    if ((profileName !== TELEGRAM_DEFAULT_PROFILE_NAME && !isValidTelegramProfileName(profileName)) ||
        !/^[a-f0-9]{64}$/u.test(tokenSha256)) {
      throw new Error("Invalid Telegram pairing admission identity.");
    }
    return withTelegramFileTransaction(`${configPath}.transaction`, () => {
      const latest = readTelegramConfigForTransaction(configPath);
      const profile = latest.profiles?.[profileName];
      const resolvedToken =
        typeof profile?.botToken === "string"
          ? resolveTelegramBotToken(profile.botToken, env)
          : undefined;
      if (!profile || !resolvedToken ||
          createHash("sha256").update(resolvedToken).digest("hex") !== tokenSha256 ||
          (profile.allowedUserId !== undefined &&
            (!Number.isSafeInteger(profile.allowedUserId) || profile.allowedUserId <= 0))) {
        throw new Error("Telegram pairing admission authority is unavailable or changed.");
      }
      return observe(latest, profile);
    });
  };
  return {
    get: getEffectiveConfig,
    getStoredConfig: () => config,
    set: setEffectiveConfig,
    setProfile: (profileName, profile) => {
      config = {
        ...omitTelegramRootProfileFields(config),
        profiles: {
          ...(config.profiles ?? {}),
          [profileName]: cloneTelegramConfig(profile),
        },
      };
      mutationVersion += 1;
    },
    update: (mutate) => {
      const nextConfig = getEffectiveConfig();
      mutate(nextConfig);
      setEffectiveConfig(nextConfig);
    },
    activateProfile: (profileName) => {
      const normalizedProfileName =
        !profileName || profileName === TELEGRAM_DEFAULT_PROFILE_NAME
          ? undefined
          : profileName;
      if (normalizedProfileName && !config.profiles?.[normalizedProfileName]) {
        return false;
      }
      activeProfileName = normalizedProfileName;
      return true;
    },
    getActiveProfileName: () => activeProfileName,
    getBotToken: () => resolveTelegramBotToken(getEffectiveConfig().botToken, env),
    getBotTokenDiagnostic: () =>
      getTelegramBotTokenDiagnostic(getEffectiveConfig().botToken, env),
    hasBotToken: () => !!resolveTelegramBotToken(getEffectiveConfig().botToken, env),
    getAllowedUserId: () => getEffectiveConfig().allowedUserId,
    getLegacyPollingCursor: () =>
      (getEffectiveConfig() as TelegramConfig & TelegramLegacyCursorCarrier)
        .lastUpdateId,
    removeLegacyPollingCursor: () => {
      const next = {
        ...(getEffectiveConfig() as TelegramConfig & TelegramLegacyCursorCarrier),
      };
      delete next.lastUpdateId;
      setEffectiveConfig(next);
    },
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
    withSourceSerialization: (operation) =>
      withTelegramFileTransaction(`${configPath}.transaction`, operation),
    withPairingAdmission: (profileName, tokenSha256, publish) =>
      withPersistedPairingProfile(profileName, tokenSha256, (_latest, profile) =>
        publish(profile.allowedUserId === undefined)),
    withPairedUserAdmission: (profileName, tokenSha256, userId, publish, assertExecutionCurrent) => {
      if (!Number.isSafeInteger(userId) || userId <= 0) return { admitted: false };
      assertExecutionCurrent?.();
      return withPersistedPairingProfile(profileName, tokenSha256, (latest, profile) => {
        if (profile.allowedUserId !== userId) return { admitted: false };
        assertExecutionCurrent?.();
        const current = getEffectiveConfig();
        const previousOwner = persistedConfig.profiles?.[profileName]?.allowedUserId;
        if ((activeProfileName ?? TELEGRAM_DEFAULT_PROFILE_NAME) !== profileName ||
            current.botToken !== profile.botToken ||
            (current.allowedUserId !== undefined && current.allowedUserId !== userId) ||
            (current.allowedUserId === undefined && previousOwner !== undefined)) {
          throw new Error("Telegram paired admission lost local profile authority.");
        }
        // Observation is not a local edit; queued persistence still adopts its own fresh disk result.
        adoptPersistedConfig(latest, true);
        return { admitted: true, value: publish() };
      });
    },
    persistAllowedUserId: (userId, assertExecutionCurrent, commitIfOwned) => {
      const profileName = activeProfileName;
      const profileKey = profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
      const botToken = getEffectiveConfig().botToken;
      const previousOwner = getEffectiveConfig().allowedUserId;
      const assertCurrent = () => {
        assertExecutionCurrent?.();
        if (activeProfileName !== profileName || getEffectiveConfig().botToken !== botToken ||
            getEffectiveConfig().allowedUserId !== previousOwner) {
          throw new Error("Telegram pairing lost its originating profile authority.");
        }
      };
      const pairing = persistQueue.then(() => {
        assertCurrent();
        if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid Telegram pairing user ID.");
        let merged: TelegramConfig | undefined;
        const publish = () => {
          merged = withTelegramFileTransaction(`${configPath}.transaction`, () => {
            const latest = readTelegramConfigForTransaction(configPath);
            const profile = latest.profiles?.[profileKey];
            if (!botToken || profile?.botToken !== botToken) {
              throw new Error("Telegram pairing profile is unavailable or changed.");
            }
            assertCurrent();
            if (profile.allowedUserId !== undefined) return latest;
            const next = { ...latest, profiles: { ...latest.profiles,
              [profileKey]: { ...profile, allowedUserId: userId } } };
            writeTelegramConfigInTransaction(agentDir, configPath, next);
            return next;
          });
        };
        if (commitIfOwned) {
          if (!commitIfOwned(publish)) throw new Error("Telegram pairing lost transport ownership before publication.");
        } else {
          publish();
        }
        if (!merged) throw new Error("Telegram pairing publication did not execute.");
        adoptPersistedConfig(merged, true);
        return merged.profiles?.[profileKey]?.allowedUserId === userId;
      });
      persistQueue = pairing.then(() => undefined, () => undefined);
      return pairing;
    },
    load: async () => {
      lastLoadRecoveredInvalidConfig = false;
      const loadedConfig = await readTelegramConfig(configPath, {
        onInvalidConfig: (recovery) => {
          lastLoadRecoveredInvalidConfig = true;
          options.recordRuntimeEvent?.("config", recovery.error, {
            phase: "load",
            configPath: recovery.configPath,
            recoveryPath: recovery.recoveryPath,
          });
        },
      });
      let normalized: ReturnType<typeof normalizeTelegramDefaultProfileConfig>;
      try {
        normalized = normalizeTelegramDefaultProfileConfig(loadedConfig);
      } catch (error) {
        options.recordRuntimeEvent?.("config", error, {
          phase: "default-profile-normalize",
          configPath,
        });
        throw error;
      }
      config = normalized.changed
        ? withTelegramFileTransaction(`${configPath}.transaction`, () => {
            const latestConfig = readTelegramConfigForTransaction(configPath);
            const latestNormalized =
              normalizeTelegramDefaultProfileConfig(latestConfig);
            if (latestNormalized.changed) {
              writeTelegramConfigInTransaction(
                agentDir,
                configPath,
                latestNormalized.config,
              );
            }
            return latestNormalized.config;
          })
        : normalized.config;
      persistedConfig = cloneTelegramConfig(config);
      mutationVersion += 1;
    },
    didLastLoadRecoverInvalidConfig: () => lastLoadRecoveredInvalidConfig,
    persist: (nextConfig = getEffectiveConfig(), options) => {
      const profileName = activeProfileName;
      const desiredConfig = storeTelegramEffectiveConfig(
        config,
        cloneTelegramConfig(nextConfig),
        profileName,
      );
      const baseConfig = cloneTelegramConfig(persistedConfig);
      const capturedMutationVersion = mutationVersion;
      const persist = persistQueue.then(() => {
        const mergedConfig = withTelegramFileTransaction(
          `${configPath}.transaction`,
          () => {
            if (options?.isCurrent && !options.isCurrent()) {
              throw new Error("Telegram config update lost its originating authority.");
            }
            const latestConfig = readTelegramConfigForTransaction(configPath);
            const merged = mergeTelegramConfigDelta(
              baseConfig as Record<string, unknown>,
              desiredConfig as Record<string, unknown>,
              latestConfig as Record<string, unknown>,
            ) as TelegramConfig;
            if (!configValuesEqual(latestConfig, merged)) {
              writeTelegramConfigInTransaction(agentDir, configPath, merged);
            }
            return merged;
          },
        );
        adoptPersistedConfig(mergedConfig, mutationVersion !== capturedMutationVersion);
      });
      persistQueue = persist.catch(() => undefined);
      return persist;
    },
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
      true
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

export function createTelegramActivityVerbosityGetter(
  configStore: Pick<TelegramConfigStore, "get">,
): () => TelegramActivityVerbosity {
  return () => {
    const assistant = configStore.get().assistant;
    if (assistant?.activity !== undefined) {
      if (
        assistant.activity === "thinking" ||
        assistant.activity === "tools" ||
        assistant.activity === "verbose"
      ) {
        return assistant.activity;
      }
      return "quiet";
    }
    if (assistant?.activityVerbosity !== undefined) {
      return assistant.activityVerbosity === "verbose" ? "verbose" : "quiet";
    }
    return "verbose";
  };
}

export function createTelegramActivityVerbosityRefresher(
  configStore: TelegramMutableConfigStore,
): () => Promise<void> {
  return () => loadLatestTelegramConfig(configStore);
}

export function createTelegramActivityVerbositySetter(
  configStore: TelegramMutableConfigStore,
): (verbosity: TelegramActivityVerbosity) => Promise<void> {
  return async (verbosity) => {
    await loadLatestTelegramConfig(configStore);
    const current = configStore.get();
    const {
      activityVerbosity: _legacyActivityVerbosity,
      ...assistant
    } = current.assistant ?? {};
    const config = {
      ...current,
      assistant: {
        ...assistant,
        activity: verbosity,
      },
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
    return mode === "mirror" || mode === "always" ? mode : "manual";
  };
}

export function createTelegramVoiceReplyModeConfiguredChecker(
  configStore: Pick<TelegramConfigStore, "get">,
): () => boolean {
  return () => {
    const mode = configStore.get().voice?.replyMode;
    return mode === "mirror" || mode === "always";
  };
}

export function createTelegramVoiceReplyModeSetter(
  configStore: TelegramMutableConfigStore,
): (replyMode: "manual" | "hidden" | "mirror" | "always" | undefined) => Promise<void> {
  return async (replyMode) => {
    await loadLatestTelegramConfig(configStore);
    const current = configStore.get();
    if (
      replyMode === undefined ||
      replyMode === "manual" ||
      replyMode === "hidden"
    ) {
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
  timeInjection: TelegramTimeMode | undefined = undefined,
): ResolvedTelegramTimeConfig {
  const injectionMode: TelegramTimeMode =
    timeInjection === undefined
      ? "interval"
      : timeInjection === "always" || timeInjection === "interval"
        ? timeInjection
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
  return () => {
    const config = configStore.get();
    return resolveTelegramTimeConfig(
      config.time,
      config.assistant?.timeInjection,
    );
  };
}

export function createTelegramTimeInjectionModeGetter(
  configStore: Pick<TelegramConfigStore, "get">,
): () => TelegramTimeMode {
  return () => {
    const config = configStore.get();
    return resolveTelegramTimeConfig(
      config.time,
      config.assistant?.timeInjection,
    ).injectionMode;
  };
}

export function createTelegramTimeInjectionModeSetter(
  configStore: TelegramMutableConfigStore,
): (injectionMode: TelegramTimeMode) => Promise<void> {
  return async (injectionMode) => {
    await loadLatestTelegramConfig(configStore);
    const current = configStore.get();
    const next = {
      ...current,
      assistant: {
        ...(current.assistant ?? {}),
        timeInjection: injectionMode,
      },
    };
    configStore.set(next);
    await configStore.persist(next);
  };
}

export interface TelegramProactivePushTarget {
  chatId: number;
  threadId?: number;
}

export function createTelegramProactivePushChatIdGetter(
  getTarget: () => TelegramProactivePushTarget | undefined,
): () => number | undefined {
  return () => getTarget()?.chatId;
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

export function createTelegramAutomaticThreadCleanupChecker(
  configStore: Pick<TelegramConfigStore, "get">,
): () => boolean {
  return () => configStore.get().threads?.automaticCleanup ?? true;
}

export function createTelegramAutomaticThreadCleanupResolver(
  configStore: TelegramMutableConfigStore,
): () => Promise<boolean> {
  return async () => {
    await loadLatestTelegramConfig(configStore);
    if (configStore.didLastLoadRecoverInvalidConfig?.()) {
      throw new Error(
        "Thread cleanup setting is unavailable after invalid Telegram config recovery.",
      );
    }
    return createTelegramAutomaticThreadCleanupChecker(configStore)();
  };
}

export function createTelegramAutomaticThreadCleanupSetter(
  configStore: TelegramMutableConfigStore,
): (enabled: boolean) => Promise<void> {
  return async (enabled) => {
    await loadLatestTelegramConfig(configStore);
    const current = configStore.get();
    const config = {
      ...current,
      threads: { ...current.threads, automaticCleanup: enabled },
    };
    configStore.set(config);
    await configStore.persist(config);
  };
}

export function createTelegramConfigControls(
  configStore: TelegramMutableConfigStore,
) {
  return {
    areDraftPreviewsEnabled: createTelegramDraftPreviewsChecker(configStore),
    setDraftPreviewsEnabled: createTelegramDraftPreviewsSetter(configStore),
    getAssistantRenderingMode:
      createTelegramAssistantRenderingModeGetter(configStore),
    setAssistantRenderingMode:
      createTelegramAssistantRenderingModeSetter(configStore),
    getActivityVerbosity:
      createTelegramActivityVerbosityGetter(configStore),
    refreshActivityVerbosity:
      createTelegramActivityVerbosityRefresher(configStore),
    setActivityVerbosity:
      createTelegramActivityVerbositySetter(configStore),
    getVoiceReplyMode: createTelegramVoiceReplyModeGetter(configStore),
    isVoiceReplyModeConfigured:
      createTelegramVoiceReplyModeConfiguredChecker(configStore),
    setVoiceReplyMode: createTelegramVoiceReplyModeSetter(configStore),
    getTimeInjectionMode: createTelegramTimeInjectionModeGetter(configStore),
    setTimeInjectionMode: createTelegramTimeInjectionModeSetter(configStore),
    isAutomaticThreadCleanupEnabled:
      createTelegramAutomaticThreadCleanupChecker(configStore),
    resolveAutomaticThreadCleanupEnabled:
      createTelegramAutomaticThreadCleanupResolver(configStore),
    setAutomaticThreadCleanupEnabled:
      createTelegramAutomaticThreadCleanupSetter(configStore),
  };
}

export type TelegramAuthorizationState =
  { kind: "pair"; userId: number } | { kind: "allow" } | { kind: "deny" };

export interface TelegramUserPairingDeps<TContext> {
  allowedUserId?: number;
  ctx: TContext;
  persistAllowedUserId: TelegramConfigStore["persistAllowedUserId"];
  updateStatus: (ctx: TContext) => void;
  assertExecutionCurrent?: () => void;
}

export interface TelegramUserPairingRuntimeDeps<TContext> {
  getAllowedUserId: () => number | undefined;
  persistAllowedUserId: TelegramConfigStore["persistAllowedUserId"];
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramUserPairingRuntime<TContext> {
  /** True means this user is authorized, whether newly paired or already configured. */
  pairIfNeeded: (
    userId: number,
    ctx: TContext,
    assertExecutionCurrent?: () => void,
  ) => Promise<boolean>;
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
  if (authorization.kind !== "pair") return authorization.kind === "allow";
  deps.assertExecutionCurrent?.();
  const allowed = await deps.persistAllowedUserId(authorization.userId, deps.assertExecutionCurrent);
  deps.assertExecutionCurrent?.();
  if (!allowed) return false;
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
    pairIfNeeded: (userId, ctx, assertExecutionCurrent) =>
      pairTelegramUserIfNeeded(userId, {
        allowedUserId: deps.getAllowedUserId(),
        ctx,
        persistAllowedUserId: deps.persistAllowedUserId,
        updateStatus: deps.updateStatus,
        assertExecutionCurrent,
      }),
  };
}
