/**
 * Telegram setup prompt helpers
 * Zones: pi agent command ui, telegram config
 * Computes token-prefill defaults and prompt mode selection for /telegram-setup
 */
export const TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER = "123456:ABCDEF...";
const TELEGRAM_BOT_TOKEN_ENV_VARS = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_KEY",
    "TELEGRAM_TOKEN",
    "TELEGRAM_KEY",
];
/**
 * Default submitted-token handling for structural callers that inject no
 * reference port: plain literals pass through, while `$`-prefixed values fail
 * closed instead of being sent to the Bot API as a literal token.
 */
function resolveSubmittedTelegramBotToken(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("$"))
        return undefined;
    return trimmed;
}
function describeSubmittedTelegramBotToken(value) {
    return value.trim().startsWith("$")
        ? "Telegram bot token environment reference is unavailable in this setup environment."
        : undefined;
}
function isTelegramPollingStartResult(value) {
    return (!!value &&
        typeof value === "object" &&
        typeof value.ok === "boolean");
}
export function getTelegramBotTokenInputDefault(env = process.env, configToken) {
    const trimmedConfigToken = configToken?.trim();
    if (trimmedConfigToken)
        return trimmedConfigToken;
    for (const key of TELEGRAM_BOT_TOKEN_ENV_VARS) {
        // Persist the originating alias rather than copying the resolved secret.
        if (env[key]?.trim())
            return `$${key}`;
    }
    return TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER;
}
export function getTelegramBotTokenPromptSpec(env = process.env, configToken) {
    const value = getTelegramBotTokenInputDefault(env, configToken);
    return {
        method: value === TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER ? "input" : "editor",
        value,
    };
}
export async function runTelegramSetup(deps) {
    if (!deps.hasUI)
        return { status: "unavailable" };
    const tokenPrompt = getTelegramBotTokenPromptSpec(deps.env, deps.config.botToken);
    const token = tokenPrompt.method === "editor"
        ? await deps.promptEditor("Telegram bot token", tokenPrompt.value)
        : await deps.promptInput("Telegram bot token", tokenPrompt.value);
    if (!token)
        return { status: "cancelled" };
    const submittedToken = token.trim();
    const resolveBotToken = deps.resolveBotToken ?? resolveSubmittedTelegramBotToken;
    const describeBotToken = deps.describeBotToken ?? describeSubmittedTelegramBotToken;
    const resolvedToken = resolveBotToken(submittedToken);
    const nextConfig = {
        ...deps.config,
        botToken: submittedToken,
    };
    if (!resolvedToken) {
        deps.notify(describeBotToken(submittedToken) ?? "Invalid Telegram bot token", "error");
        return { status: "validation-failed" };
    }
    let data;
    try {
        data = await deps.getMe(resolvedToken);
    }
    catch (error) {
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
    deps.notify(`Telegram bot connected: @${nextConfig.botUsername ?? "unknown"}`, "info");
    deps.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
    let startResult;
    try {
        startResult = await deps.startPolling();
    }
    catch (error) {
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
export function createTelegramSetupPromptRuntime(deps) {
    return async (ctx) => {
        if (!ctx.hasUI)
            return { status: "unavailable" };
        if (!deps.setupGuard.start())
            return { status: "busy" };
        try {
            return await runTelegramSetup({
                hasUI: ctx.hasUI,
                env: deps.env ?? process.env,
                config: deps.getConfig(),
                promptInput: (label, value) => ctx.ui.input(label, value),
                promptEditor: (label, value) => ctx.ui.editor(label, value),
                getMe: deps.getMe,
                resolveBotToken: deps.resolveBotToken,
                describeBotToken: deps.describeBotToken,
                persistConfig: async (config) => {
                    const previousConfig = deps.getConfig();
                    deps.setConfig(config);
                    try {
                        await deps.persistConfig(config);
                    }
                    catch (error) {
                        deps.setConfig(previousConfig);
                        throw error;
                    }
                },
                notify: (message, level) => ctx.ui.notify(message, level),
                startPolling: () => deps.startPolling(ctx),
                updateStatus: () => deps.updateStatus(ctx),
            });
        }
        catch (error) {
            deps.recordRuntimeEvent?.("setup", error);
            throw error;
        }
        finally {
            deps.setupGuard.finish();
        }
    };
}
