/**
 * Telegram setup prompt helpers
 * Zones: pi agent command ui, telegram config
 * Computes token-prefill defaults and prompt mode selection for /telegram-setup
 */
export interface TelegramSetupConfig {
    botToken?: string;
    botId?: number;
    botUsername?: string;
    allowedUserId?: number;
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
export type TelegramSetupCompletion = {
    status: "success";
    config: TelegramSetupConfig;
} | {
    status: "cancelled" | "unavailable" | "busy" | "validation-failed";
} | {
    status: "polling-failed";
    config: TelegramSetupConfig;
};
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
    /** Resolve a submitted literal token or `$NAME`/`${NAME}` reference. */
    resolveBotToken?: (value: string) => string | undefined;
    /** Redacted diagnostic for an unresolved or malformed token reference. */
    describeBotToken?: (value: string) => string | undefined;
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
export interface TelegramSetupPromptRuntimeDeps<TContext extends TelegramSetupPromptContext> {
    env?: NodeJS.ProcessEnv;
    getConfig: () => TelegramSetupConfig;
    setConfig: (config: TelegramSetupConfig) => void;
    setupGuard: TelegramSetupGuard;
    getMe: TelegramSetupDeps["getMe"];
    resolveBotToken?: TelegramSetupDeps["resolveBotToken"];
    describeBotToken?: TelegramSetupDeps["describeBotToken"];
    persistConfig: (config: TelegramSetupConfig) => Promise<void>;
    startPolling: (ctx: TContext) => unknown | Promise<unknown>;
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare const TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER = "123456:ABCDEF...";
export declare function getTelegramBotTokenInputDefault(env?: NodeJS.ProcessEnv, configToken?: string): string;
export declare function getTelegramBotTokenPromptSpec(env?: NodeJS.ProcessEnv, configToken?: string): TelegramBotTokenPromptSpec;
export declare function runTelegramSetup(deps: TelegramSetupDeps): Promise<TelegramSetupCompletion>;
export declare function createTelegramSetupPromptRuntime<TContext extends TelegramSetupPromptContext>(deps: TelegramSetupPromptRuntimeDeps<TContext>): (ctx: TContext) => Promise<TelegramSetupCompletion>;
