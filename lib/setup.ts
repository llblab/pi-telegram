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

export type TelegramSetupCompletion =
  | { status: "success"; config: TelegramSetupConfig }
  | { status: "cancelled" | "unavailable" | "busy" | "validation-failed" }
  | { status: "polling-failed"; config: TelegramSetupConfig };

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
): Promise<TelegramSetupCompletion> {
  if (!deps.hasUI) return { status: "unavailable" };
  const tokenPrompt = getTelegramBotTokenPromptSpec(
    deps.env,
    deps.config.botToken,
  );
  const token =
    tokenPrompt.method === "editor"
      ? await deps.promptEditor("Telegram bot token", tokenPrompt.value)
      : await deps.promptInput("Telegram bot token", tokenPrompt.value);
  if (!token) return { status: "cancelled" };
  const nextConfig: TelegramSetupConfig = {
    ...deps.config,
    botToken: token.trim(),
  };
  let data: Awaited<ReturnType<TelegramSetupDeps["getMe"]>>;
  try {
    data = await deps.getMe(nextConfig.botToken ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Telegram API check failed: ${message}`, "error");
    return { status: "validation-failed" };
  }
  if (!data.ok || !data.result) {
    deps.notify(data.description || "Invalid Telegram bot token", "error");
    return { status: "validation-failed" };
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
  let startResult: unknown;
  try {
    startResult = await deps.startPolling();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Telegram polling failed: ${message}`, "error");
    deps.updateStatus();
    return { status: "polling-failed", config: nextConfig };
  }
  if (isTelegramPollingStartResult(startResult) && startResult.message) {
    deps.notify(startResult.message, startResult.ok ? "info" : "error");
  }
  deps.updateStatus();
  if (isTelegramPollingStartResult(startResult) && !startResult.ok) {
    return { status: "polling-failed", config: nextConfig };
  }
  return { status: "success", config: nextConfig };
}

export function createTelegramSetupPromptRuntime<
  TContext extends TelegramSetupPromptContext,
>(deps: TelegramSetupPromptRuntimeDeps<TContext>) {
  return async (ctx: TContext): Promise<TelegramSetupCompletion> => {
    if (!ctx.hasUI) return { status: "unavailable" };
    if (!deps.setupGuard.start()) return { status: "busy" };
    try {
      return await runTelegramSetup({
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
