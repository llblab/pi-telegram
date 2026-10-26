/**
 * Telegram bridge config and pairing helpers
 * Zones: telegram config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, live config controls, authorization policy, and first-user pairing side effects
 */
import type { CommandTemplateObjectConfig } from "./command-templates.ts";
import type { TelegramInboundHandlerConfig } from "./inbound.ts";
export { TELEGRAM_DEFAULT_PROFILE_NAME } from "./paths.ts";
/** Parsed stored bot-token form: a literal secret or one environment-variable reference. */
export type TelegramBotTokenReference = {
    kind: "literal";
    token: string;
} | {
    kind: "environment";
    variable: string;
} | {
    kind: "malformed";
};
/** Resolve a persisted token at a validation/activation boundary. */
export declare function resolveTelegramBotToken(value: string | undefined, env?: NodeJS.ProcessEnv): string | undefined;
/** Redacted diagnostic for an unresolved or malformed token reference. */
export declare function getTelegramBotTokenDiagnostic(value: string | undefined, env?: NodeJS.ProcessEnv): string | undefined;
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
export type TelegramThreadDisplayMode = "letters" | "names" | "directories" | "directory-snake" | "directory-title";
export declare function resolveTelegramThreadDisplayMode(config: Pick<TelegramConfig, "threads">): TelegramThreadDisplayMode;
export declare function setTelegramThreadDisplayMode(store: TelegramConfigStore, mode: TelegramThreadDisplayMode, isCurrent: () => boolean): Promise<void>;
export type TelegramAssistantRenderingMode = "rich" | "html";
export type TelegramActivityVerbosity = "quiet" | "thinking" | "tools" | "verbose" | "stream";
export interface TelegramConfig {
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    botToken?: string;
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    botUsername?: string;
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    botId?: number;
    /** @deprecated persisted identity belongs in profiles.default; retained for effective/legacy views */
    allowedUserId?: number;
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
        /** Automatic Thread title strategy shared by every profile; absent or invalid resolves to `letters`. */
        displayMode?: TelegramThreadDisplayMode;
    };
    /** Canonical bot/session profiles, including profiles.default. */
    profiles?: Record<string, TelegramBotProfile>;
}
/**
 * Per-profile bot identity and paired owner only.
 * Stored under `profiles.<name>` in telegram.json.
 * Shared bridge settings (handlers, assistant, voice, time, threads) stay at
 * the top level and never leak into profiles.
 */
export interface TelegramBotProfile {
    botToken: string;
    botUsername?: string;
    botId?: number;
    allowedUserId?: number;
}
export declare function isValidTelegramProfileName(name: string): boolean;
/** List defined profile names. */
export declare function getTelegramProfileNames(config: TelegramConfig): string[];
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
    persistAllowedUserId: (userId: number, assertExecutionCurrent?: () => void, commitIfOwned?: (commit: () => void) => boolean) => Promise<boolean>;
    /** Trusted synchronous publication only; caller acquires Workspace admission before this config transaction. */
    withPairingAdmission: <T>(profileName: string, tokenSha256: string, publish: (preApprovalExcluded: boolean) => T) => T;
    /** Observe an existing exact owner and refresh an unpaired cache; never create an owner. Callback must be synchronous. */
    withPairedUserAdmission: <T>(profileName: string, tokenSha256: string, userId: number, publish: () => T, assertExecutionCurrent?: () => void) => {
        admitted: false;
    } | {
        admitted: true;
        value: T;
    };
    load: () => Promise<void>;
    didLastLoadRecoverInvalidConfig: () => boolean;
    persist: (config?: TelegramConfig, options?: {
        isCurrent?: () => boolean;
    }) => Promise<void>;
}
export declare function createTelegramConfigBotIdGetter(store: Pick<TelegramConfigStore, "get">): () => number | undefined;
export declare function createTelegramActiveProfileKeyGetter(store: Pick<TelegramConfigStore, "getActiveProfileName">): () => string;
export interface TelegramConfigStoreOptions {
    initialConfig?: TelegramConfig;
    agentDir?: string;
    configPath?: string;
    /** Environment used to resolve `$NAME` token references; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramInvalidConfigRecovery {
    configPath: string;
    recoveryPath: string;
    error: unknown;
}
type TelegramMutableConfigStore = Pick<TelegramConfigStore, "get" | "set" | "persist"> & {
    load?: () => Promise<void>;
    didLastLoadRecoverInvalidConfig?: () => boolean;
};
export declare function readTelegramConfig(configPath: string, options?: {
    onInvalidConfig?: (recovery: TelegramInvalidConfigRecovery) => void;
}): Promise<TelegramConfig>;
export declare function getTelegramProfileFields(config: TelegramConfig): TelegramBotProfile | undefined;
export declare function normalizeTelegramDefaultProfileConfig(config: TelegramConfig): {
    config: TelegramConfig;
    changed: boolean;
};
export declare function createTelegramConfigStore(options?: TelegramConfigStoreOptions): TelegramConfigStore;
export declare function resolveTelegramActivityVerbosity(config: Pick<TelegramConfig, "assistant">): TelegramActivityVerbosity;
export declare function createTelegramVoiceReplyModeGetter(configStore: Pick<TelegramConfigStore, "get">): () => "manual" | "mirror" | "always";
export declare function createTelegramVoiceReplyModeConfiguredChecker(configStore: Pick<TelegramConfigStore, "get">): () => boolean;
export declare function createTelegramVoiceReplyModeSetter(configStore: TelegramMutableConfigStore): (replyMode: "manual" | "hidden" | "mirror" | "always" | undefined) => Promise<void>;
export declare function resolveTelegramTimeConfig(raw: TelegramTimeConfig | undefined, timeInjection?: TelegramTimeMode | undefined): ResolvedTelegramTimeConfig;
export declare function createTelegramTimeConfigGetter(configStore: Pick<TelegramConfigStore, "get">): () => ResolvedTelegramTimeConfig;
export declare function createTelegramTimeInjectionModeGetter(configStore: Pick<TelegramConfigStore, "get">): () => TelegramTimeMode;
export declare function createTelegramTimeInjectionModeSetter(configStore: TelegramMutableConfigStore): (injectionMode: TelegramTimeMode) => Promise<void>;
export interface TelegramProactivePushTarget {
    chatId: number;
    threadId?: number;
}
export declare function createTelegramProactivePushChatIdGetter(getTarget: () => TelegramProactivePushTarget | undefined): () => number | undefined;
export declare function createTelegramProactivePushTargetGetter(deps: {
    getActiveTurnTarget: () => TelegramProactivePushTarget | undefined;
    getAssignedTarget: () => TelegramProactivePushTarget | undefined;
    getAllowedUserId: () => number | undefined;
}): () => TelegramProactivePushTarget | undefined;
export declare function createTelegramConfigControls(configStore: TelegramMutableConfigStore): {
    areDraftPreviewsEnabled: () => boolean;
    setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
    getAssistantRenderingMode: () => TelegramAssistantRenderingMode;
    setAssistantRenderingMode: (mode: TelegramAssistantRenderingMode) => Promise<void>;
    getActivityVerbosity: () => TelegramActivityVerbosity;
    isActivityStreamMode: () => boolean;
    refreshActivityVerbosity: () => Promise<void>;
    setActivityVerbosity: (verbosity: TelegramActivityVerbosity) => Promise<void>;
    getVoiceReplyMode: () => "manual" | "mirror" | "always";
    isVoiceReplyModeConfigured: () => boolean;
    setVoiceReplyMode: (replyMode: "manual" | "hidden" | "mirror" | "always" | undefined) => Promise<void>;
    getTimeInjectionMode: () => TelegramTimeMode;
    setTimeInjectionMode: (injectionMode: TelegramTimeMode) => Promise<void>;
    isAutomaticThreadCleanupEnabled: () => boolean;
    resolveAutomaticThreadCleanupEnabled: () => Promise<boolean>;
    setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
};
export type TelegramAuthorizationState = {
    kind: "pair";
    userId: number;
} | {
    kind: "allow";
} | {
    kind: "deny";
};
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
    pairIfNeeded: (userId: number, ctx: TContext, assertExecutionCurrent?: () => void) => Promise<boolean>;
}
export declare function getTelegramAuthorizationState(userId: number, allowedUserId?: number): TelegramAuthorizationState;
export declare function pairTelegramUserIfNeeded<TContext>(userId: number, deps: TelegramUserPairingDeps<TContext>): Promise<boolean>;
export declare function createTelegramUserPairingRuntime<TContext>(deps: TelegramUserPairingRuntimeDeps<TContext>): TelegramUserPairingRuntime<TContext>;
