/**
 * Telegram command routing helpers
 * Zones: telegram controls, pi agent commands, queue controls
 * Owns Telegram slash-command normalization, bot command metadata, pi-side command registration, and command-initiated session replacement orchestration behind runtime ports
 */
import { randomUUID } from "node:crypto";
import { pairTelegramUserIfNeeded, TELEGRAM_DEFAULT_PROFILE_NAME, } from "./config.js";
import { escapeHtml } from "./rendering.js";
import { createTelegramControlItemBuilder, createTelegramControlQueueController, createTelegramQueueAdmissionReceipt, } from "./queue.js";
const TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY = "__piTelegramCommandRegistry__";
const TELEGRAM_BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
function getOrCreateTelegramCommandRegistry() {
    const existing = globalThis[TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY];
    if (existing &&
        typeof existing === "object" &&
        existing !== null &&
        "commands" in existing &&
        existing.commands instanceof Map) {
        return existing;
    }
    const registry = { commands: new Map() };
    globalThis[TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY] = registry;
    return registry;
}
export function normalizeTelegramExtensionCommandName(name) {
    return name.trim().replace(/^\/+/, "").toLowerCase();
}
export function isTelegramExtensionCommandName(name) {
    return TELEGRAM_BOT_COMMAND_NAME_PATTERN.test(name);
}
function normalizeTelegramExtensionCommandEmoji(emoji) {
    const normalized = emoji?.trim();
    return normalized ? normalized : undefined;
}
export function registerTelegramCommand(registration) {
    const name = normalizeTelegramExtensionCommandName(registration.name);
    const showInMenu = registration.showInMenu ?? false;
    const emoji = normalizeTelegramExtensionCommandEmoji(registration.emoji);
    if (!isTelegramExtensionCommandName(name)) {
        throw new Error(`Invalid Telegram command name: ${registration.name}`);
    }
    if (showInMenu && !emoji) {
        throw new Error(`Visible Telegram command requires emoji: ${name}`);
    }
    if (emoji && emoji.length > 8) {
        throw new Error(`Telegram command emoji is too long: ${name}`);
    }
    if (isTelegramReservedCommandName(name)) {
        throw new Error(`Telegram command conflicts with built-in command: ${name}`);
    }
    const registry = getOrCreateTelegramCommandRegistry();
    if (registry.commands.has(name)) {
        throw new Error(`Telegram command is already registered: ${name}`);
    }
    const command = {
        name,
        description: registration.description,
        order: registration.order ?? 0,
        showInMenu,
        emoji,
        handler: registration.handler,
    };
    registry.commands.set(name, command);
    return () => {
        if (registry.commands.get(name) === command)
            registry.commands.delete(name);
    };
}
export function getTelegramExtensionCommands() {
    return Array.from(getOrCreateTelegramCommandRegistry().commands.values()).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}
export function findTelegramExtensionCommand(name) {
    if (!name)
        return undefined;
    return getOrCreateTelegramCommandRegistry().commands.get(normalizeTelegramExtensionCommandName(name));
}
export function clearTelegramExtensionCommands() {
    getOrCreateTelegramCommandRegistry().commands.clear();
}
export const TELEGRAM_COMMAND_EMOJI = {
    start: "🟢",
    status: "📊",
    model: "🤖",
    thinking: "🧠",
    compact: "🗜",
    queue: "🔢",
    thread: "🧵",
    next: "⏩",
    continue: "▶️",
    abort: "⏹️",
    stop: "🟥",
    name: "🏷️",
    new: "🆕",
};
export function getTelegramCommandEmoji(command) {
    return TELEGRAM_COMMAND_EMOJI[command];
}
export function formatTelegramCommandEmojiPrefix(command) {
    return `${getTelegramCommandEmoji(command)} `;
}
export function formatTelegramPiCommandHtml(command) {
    return `<code>${escapeHtml(command)}</code>`;
}
export function formatTelegramInformationHeading(emoji, text) {
    return `<b>${escapeHtml(emoji)} ${escapeHtml(text)}</b>`;
}
export function formatTelegramInvalidInstanceName(validationError) {
    const details = validationError.replace(/^Invalid Telegram (?:instance name|Thread display name):\s*/, "");
    const items = details
        .split(/;\s+|(?<=\.)\s+(?=[A-Z])/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => /[.!?]$/.test(item) ? item : `${item}.`)
        .map((item) => item[0].toUpperCase() + item.slice(1));
    return [
        "<b>⚠️ Invalid Thread Display Name:</b>\n",
        ...items.map((item) => `• ${escapeHtml(item)}`),
    ].join("\n");
}
export function formatTelegramThreadDisplayNameSavedHeading(name) {
    return `<b>✅ Thread display name saved as <i>${escapeHtml(name)}</i>.</b>`;
}
export function formatTelegramAutomaticThreadDisplayNameRestoredHeading(name) {
    return `<b>✅ Automatic Thread display name restored as <i>${escapeHtml(name)}</i>.</b>`;
}
export const TELEGRAM_COMPACTION_STARTED_TEXT = formatTelegramInformationHeading(getTelegramCommandEmoji("compact"), "Compaction started.");
export const TELEGRAM_COMPACTION_COMPLETED_TEXT = formatTelegramInformationHeading("✅", "Compaction completed.");
export const TELEGRAM_COMPACTION_STARTED_MARKDOWN = `**${formatTelegramCommandEmojiPrefix("compact")}Compaction started.**`;
export const TELEGRAM_COMPACTION_COMPLETED_MARKDOWN = "**✅ Compaction completed.**";
function formatTelegramBotCommandDescription(command, description) {
    return `${formatTelegramCommandEmojiPrefix(command)}${description}`;
}
export const TELEGRAM_BUILTIN_BOT_COMMANDS = [
    {
        command: "start",
        description: formatTelegramBotCommandDescription("start", "Open menu / Pair bridge"),
    },
    {
        command: "compact",
        description: formatTelegramBotCommandDescription("compact", "Compact current session"),
    },
    {
        command: "new",
        description: formatTelegramBotCommandDescription("new", "Start a new session"),
    },
    {
        command: "continue",
        description: formatTelegramBotCommandDescription("continue", "Queue continue prompt"),
    },
    {
        command: "next",
        description: formatTelegramBotCommandDescription("next", "Force next turn"),
    },
    {
        command: "abort",
        description: formatTelegramBotCommandDescription("abort", "Abort Pi"),
    },
    {
        command: "stop",
        description: formatTelegramBotCommandDescription("stop", "Abort Pi & Clear queue"),
    },
];
export const TELEGRAM_BOT_COMMANDS = TELEGRAM_BUILTIN_BOT_COMMANDS;
function getVisibleTelegramExtensionBotCommands() {
    return getTelegramExtensionCommands()
        .filter((command) => command.showInMenu && command.description)
        .map((command) => ({
        command: command.name,
        description: `${command.emoji} ${command.description ?? command.name}`,
    }));
}
export function getTelegramReservedCommandNames() {
    return [
        ...TELEGRAM_RESERVED_COMMAND_NAMES,
        ...getTelegramExtensionCommands().map((command) => command.name),
    ];
}
export async function registerTelegramBotCommands(deps) {
    const extensionCommands = getVisibleTelegramExtensionBotCommands();
    if (extensionCommands.length === 0) {
        await deps.setMyCommands(TELEGRAM_BOT_COMMANDS);
        return;
    }
    const nextCommandIndex = TELEGRAM_BOT_COMMANDS.findIndex((command) => command.command === "next");
    if (nextCommandIndex === -1) {
        await deps.setMyCommands([...TELEGRAM_BOT_COMMANDS, ...extensionCommands]);
        return;
    }
    await deps.setMyCommands([
        ...TELEGRAM_BOT_COMMANDS.slice(0, nextCommandIndex + 1),
        ...extensionCommands,
        ...TELEGRAM_BOT_COMMANDS.slice(nextCommandIndex + 1),
    ]);
}
export function createTelegramBotCommandRegistrar(deps) {
    let pending;
    return () => {
        if (pending)
            return pending;
        let request;
        request = registerTelegramBotCommands(deps).finally(() => {
            if (pending === request)
                pending = undefined;
        });
        pending = request;
        return request;
    };
}
export function createTelegramThreadDisplayNameResetBinding() {
    let current;
    return {
        bind(reset) { current = reset; },
        async reset(target) {
            return current
                ? current(target)
                : { ok: false, message: "Thread display name reset is unavailable." };
        },
    };
}
export function createTelegramThreadDisplayNameRenameBinding() {
    let current;
    return {
        bind(rename) {
            current = rename;
        },
        async rename(target, threadName) {
            if (!current) {
                return {
                    ok: false,
                    message: "Thread display naming is unavailable.",
                };
            }
            return current(target, threadName);
        },
    };
}
function parseTelegramProfileArg(args) {
    const word = args.trim().split(/\s+/)[0];
    if (!word || word.length === 0)
        return undefined;
    if (word.startsWith("-") || /^as=/i.test(word))
        return undefined;
    return word === TELEGRAM_DEFAULT_PROFILE_NAME ? undefined : word;
}
function formatTelegramTakeoverTitle(ctx) {
    return ctx.ui.theme.fg("accent", "pi-telegram");
}
function formatTelegramTakeoverPrompt(ctx, owner) {
    const theme = ctx.ui.theme;
    const action = theme.fg("warning", "move singleton lock here?");
    const from = theme.fg("muted", "from:");
    const to = theme.fg("muted", "to:");
    const source = owner ?? "another Pi instance";
    return `${action}\n\n${from} ${source}\n${to} ${ctx.cwd}`;
}
export function registerTelegramBridgeCommands(pi, deps) {
    pi.registerCommand("telegram-setup", {
        description: "<profile> — Configure Telegram bot token",
        handler: async (args, ctx) => {
            await deps.promptForConfig(ctx, parseTelegramProfileArg(args));
        },
    });
    pi.registerCommand("telegram-status", {
        description: "Show Telegram bridge status",
        handler: async (args, ctx) => {
            const verbose = /(^|\s)(--debug|debug|--verbose|verbose)(\s|$)/i.test(args);
            ctx.ui.notify(deps.getStatusLines({ verbose }).join("\n"), "info");
        },
    });
    pi.registerCommand("telegram-connect", {
        description: "<profile> — Start Telegram bridge",
        handler: async (args, ctx) => {
            if (args.trim().split(/\s+/).some((word) => /^as=/i.test(word))) {
                ctx.ui.notify("Thread names are configured from Telegram, not from Pi commands.", "warning");
                deps.updateStatus(ctx);
                return;
            }
            const profileName = parseTelegramProfileArg(args);
            if (profileName && deps.activateProfileConfig) {
                const ok = await deps.activateProfileConfig(ctx, profileName);
                if (!ok) {
                    ctx.ui.notify(`Profile "${profileName}" not found.`, "error");
                    deps.updateStatus(ctx);
                    return;
                }
                ctx.ui.notify(`Activated profile "${profileName}".`, "info");
            }
            else {
                await (deps.activateDefaultProfileConfig?.(ctx) ?? deps.reloadConfig());
            }
            if (!deps.hasBotToken()) {
                const botTokenDiagnostic = deps.getBotTokenDiagnostic?.();
                if (botTokenDiagnostic)
                    ctx.ui.notify(botTokenDiagnostic, "error");
                const profileNames = deps.getProfileNames?.() ?? [];
                if (!profileName && profileNames.length > 0) {
                    ctx.ui.notify(`No default Telegram profile configured. Available profiles: ${profileNames.join(", ")}. Use /telegram-connect <profileName> or /telegram-setup to create a default profile.`, "info");
                    deps.updateStatus(ctx);
                    return;
                }
                await deps.promptForConfig(ctx, profileName);
                return;
            }
            let recoveryUsed = false;
            const startWithRecovery = async (options) => {
                try {
                    return await deps.startPolling(ctx, options);
                }
                catch (error) {
                    if (!deps.recoverPollingStart || recoveryUsed)
                        throw error;
                    const recovery = await deps.recoverPollingStart(error);
                    if (recovery.kind === "unhandled")
                        throw error;
                    if (recovery.kind === "blocked") {
                        return { ok: false, message: recovery.message };
                    }
                    recoveryUsed = true;
                    try {
                        const retry = await deps.startPolling(ctx, options);
                        if (!retry) {
                            return { ok: true, message: recovery.message };
                        }
                        return {
                            ...retry,
                            message: retry.ok
                                ? `${recovery.message} ${retry.message ?? "Telegram bridge connected."}`
                                : retry.message,
                        };
                    }
                    catch {
                        return {
                            ok: false,
                            message: "Telegram temporary state was recovered, but the bridge could not restart. Restart this Pi instance and run /telegram-connect again.",
                        };
                    }
                }
            };
            let result = await startWithRecovery({
                forceFreshLeaderThread: true,
            });
            if (result && !result.ok && result.canTakeover) {
                const confirmed = await ctx.ui.confirm(formatTelegramTakeoverTitle(ctx), formatTelegramTakeoverPrompt(ctx, result.owner));
                if (!confirmed) {
                    ctx.ui.notify("Telegram bridge takeover cancelled.", "info");
                    deps.updateStatus(ctx);
                    return;
                }
                result = await startWithRecovery({
                    force: true,
                    forceFreshLeaderThread: true,
                });
            }
            if (result?.message) {
                ctx.ui.notify(result.message, result.ok ? "info" : "warning");
            }
            if (!result || result.ok) {
                deps.queueAgentConnectionContext?.(true);
            }
            deps.updateStatus(ctx);
        },
    });
    pi.registerCommand("telegram-disconnect", {
        description: "Stop Telegram and delete current thread in Threaded Mode",
        handler: async (_args, ctx) => {
            const threadName = deps.getDisconnectThreadName?.();
            if (threadName) {
                const confirmed = await ctx.ui.confirm(ctx.ui.theme.fg("accent", "pi-telegram"), `Delete Telegram thread ${ctx.ui.theme.fg("warning", threadName)} and disconnect this Pi session?`);
                if (!confirmed) {
                    ctx.ui.notify("Telegram disconnect cancelled.", "info");
                    deps.updateStatus(ctx);
                    return;
                }
            }
            try {
                const message = await deps.stopPolling();
                if (message)
                    ctx.ui.notify(message, "info");
                deps.queueAgentConnectionContext?.(false);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Telegram disconnect did not complete: ${detail} Keep this Pi session open, restore leader connectivity, inspect /telegram-status --debug, and retry /telegram-disconnect.`, "warning");
                throw error;
            }
            finally {
                deps.updateStatus(ctx);
            }
        },
    });
}
export const TELEGRAM_RESERVED_COMMAND_NAMES = [
    "stop",
    "name",
    "new",
    "abort",
    "next",
    "continue",
    "status",
    "queue",
    "compact",
    "model",
    "thinking",
    "settings",
    "help",
    "start",
];
const TELEGRAM_RESERVED_COMMAND_NAME_SET = new Set(TELEGRAM_RESERVED_COMMAND_NAMES);
export function isTelegramReservedCommandName(commandName) {
    return (commandName !== undefined &&
        TELEGRAM_RESERVED_COMMAND_NAME_SET.has(commandName));
}
function canPairTelegramUserFromCommandMessage(message) {
    return message.chat.type === undefined || message.chat.type === "private";
}
export function getTelegramCommandMessageTarget(message) {
    return {
        chatId: message.chat.id,
        threadId: typeof message.message_thread_id === "number"
            ? message.message_thread_id
            : undefined,
        replyToMessageId: message.message_id,
    };
}
export function createTelegramCommandControlQueueRuntime(deps) {
    const controlQueueController = createTelegramControlQueueController({
        appendControlItem: deps.appendControlItem,
        dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    });
    return createTelegramCommandControlEnqueueAdapter({
        createControlItem: deps.createControlItem,
        enqueueControlItem: controlQueueController.enqueue,
    });
}
export function createTelegramCommandControlEnqueueAdapter(deps) {
    return (target, ctx, controlType, statusSummary, execute, admissionReceipts, onQueued) => {
        deps.enqueueControlItem(deps.createControlItem({
            ...target,
            controlType,
            statusSummary,
            ...(admissionReceipts?.length ? { admissionReceipts } : {}),
            execute,
        }), ctx, onQueued);
    };
}
export function createTelegramCommandTargetQueueRuntime(deps) {
    return createTelegramCommandTargetRuntime({
        enqueueControlItem: createTelegramCommandControlQueueRuntime({
            createControlItem: deps.createControlItem,
            appendControlItem: deps.appendControlItem,
            dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
        }),
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        onControlQueued: deps.onControlQueued,
        showStatus: deps.showStatus,
        openModelMenu: deps.openModelMenu,
        openSettingsMenu: deps.openSettingsMenu,
        sendTextReply: deps.sendTextReply,
    });
}
export function createTelegramCommandTargetRuntime(deps) {
    return {
        enqueueControlItem: (message, ctx, controlType, statusSummary, execute) => {
            const sourceUpdateId = message.pi_telegram_source_update_id;
            const baseReceipt = typeof sourceUpdateId === "number"
                ? createTelegramQueueAdmissionReceipt({
                    queueKind: "control",
                    scope: deps.getAdmissionScope?.() ?? "",
                    sourceUpdateIds: [sourceUpdateId],
                })
                : undefined;
            const journalBindingKey = deps.getAdmissionJournalBinding?.();
            const receipt = baseReceipt
                ? {
                    ...baseReceipt,
                    ...(journalBindingKey ? { journalBindingKey } : {}),
                }
                : undefined;
            deps.enqueueControlItem(getTelegramCommandMessageTarget(message), ctx, controlType, statusSummary, execute, receipt ? [receipt] : undefined, receipt
                ? () => deps.onControlQueued?.(message, receipt)
                : undefined);
        },
        showStatus: (message, ctx) => {
            const target = getTelegramCommandMessageTarget(message);
            return deps.showStatus(target.chatId, target.replyToMessageId, ctx, target.threadId);
        },
        openModelMenu: (message, ctx) => {
            const target = getTelegramCommandMessageTarget(message);
            return deps.openModelMenu(target.chatId, target.replyToMessageId, ctx, target.threadId);
        },
        openSettingsMenu: async (message, ctx) => {
            const target = getTelegramCommandMessageTarget(message);
            if (!deps.openSettingsMenu) {
                await deps.sendTextReply(target.chatId, target.replyToMessageId, formatTelegramInformationHeading("🚫", "Settings menu is unavailable."), { target, parseMode: "HTML" });
                return;
            }
            await deps.openSettingsMenu(target.chatId, target.replyToMessageId, ctx, target.threadId);
        },
        sendTextReply: async (message, text, options) => {
            const target = getTelegramCommandMessageTarget(message);
            await deps.sendTextReply(target.chatId, target.replyToMessageId, text, {
                ...options,
                target,
            });
        },
    };
}
export const TELEGRAM_APP_MENU_INTRO_HTML = [
    "<b>Pi Telegram</b>",
    "",
    `${formatTelegramCommandEmojiPrefix("start")}/start — Open menu / Pair bridge`,
    `${formatTelegramCommandEmojiPrefix("compact")}/compact — Compact current session`,
    `${formatTelegramCommandEmojiPrefix("new")}/new — Start a new session`,
    `${formatTelegramCommandEmojiPrefix("continue")}/continue — Queue continue prompt`,
    `${formatTelegramCommandEmojiPrefix("next")}/next — Force next turn`,
    `${formatTelegramCommandEmojiPrefix("abort")}/abort — Abort Pi`,
    `${formatTelegramCommandEmojiPrefix("stop")}/stop — Abort Pi & Clear queue`,
].join("\n");
function escapeTelegramCommandMenuHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function buildTelegramPromptTemplateMenuHtml(promptTemplates = []) {
    if (promptTemplates.length === 0)
        return "";
    return promptTemplates
        .map((template) => `🧩 /${escapeTelegramCommandMenuHtml(template.command)}`)
        .join("\n");
}
function buildTelegramExtensionCommandMenuLines() {
    return getTelegramExtensionCommands()
        .filter((command) => command.showInMenu)
        .map((command) => {
        const prefix = `${escapeTelegramCommandMenuHtml(command.emoji ?? "")} /${escapeTelegramCommandMenuHtml(command.name)}`;
        if (!command.description)
            return prefix;
        return `${prefix} — ${escapeTelegramCommandMenuHtml(command.description)}`;
    });
}
function buildTelegramAppMenuIntroHtml() {
    const extensionLines = buildTelegramExtensionCommandMenuLines();
    if (extensionLines.length === 0)
        return TELEGRAM_APP_MENU_INTRO_HTML;
    return [
        "<b>Pi Telegram</b>",
        "",
        `${formatTelegramCommandEmojiPrefix("start")}/start — Open menu / Pair bridge`,
        `${formatTelegramCommandEmojiPrefix("compact")}/compact — Compact current session`,
        `${formatTelegramCommandEmojiPrefix("new")}/new — Start a new session`,
        `${formatTelegramCommandEmojiPrefix("continue")}/continue — Queue continue prompt`,
        `${formatTelegramCommandEmojiPrefix("next")}/next — Force next turn`,
        ...extensionLines,
        `${formatTelegramCommandEmojiPrefix("abort")}/abort — Abort Pi`,
        `${formatTelegramCommandEmojiPrefix("stop")}/stop — Abort Pi & Clear queue`,
    ].join("\n");
}
export function buildTelegramAppMenuHtml(statusHtml, promptTemplates = []) {
    const introHtml = buildTelegramAppMenuIntroHtml();
    const promptTemplateHtml = buildTelegramPromptTemplateMenuHtml(promptTemplates);
    if (!promptTemplateHtml)
        return `${introHtml}\n\n${statusHtml}`;
    return `${introHtml}\n\n${promptTemplateHtml}\n\n${statusHtml}`;
}
export function createTelegramAppMenuHtmlBuilder(deps) {
    return (ctx) => {
        return buildTelegramAppMenuHtml(deps.buildStatusHtml(ctx), deps.getPromptTemplateCommands?.());
    };
}
function getTelegramCommandErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatTelegramCompactionFailure(error) {
    let message = getTelegramCommandErrorMessage(error).trim();
    const redundantPrefixes = [
        "Compaction failed: ",
        "Turn prefix summarization failed: ",
    ];
    let stripped = true;
    while (stripped) {
        stripped = false;
        for (const prefix of redundantPrefixes) {
            if (!message.startsWith(prefix))
                continue;
            message = message.slice(prefix.length).trim();
            stripped = true;
        }
    }
    const sentence = /[.!?]$/u.test(message) ? message : `${message}.`;
    return `Compaction failed! ${sentence}`;
}
export function parseTelegramCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/"))
        return undefined;
    const [head, ...tail] = trimmed.split(/\s+/);
    const name = head.slice(1).split("@")[0]?.toLowerCase();
    if (!name)
        return undefined;
    return { name, args: tail.join(" ").trim() };
}
export const TELEGRAM_COMMAND_ACTIONS = {
    stop: { kind: "stop", executionMode: "immediate" },
    name: { kind: "name", executionMode: "immediate" },
    new: { kind: "new", executionMode: "immediate" },
    abort: { kind: "abort", executionMode: "immediate" },
    next: { kind: "next", executionMode: "immediate" },
    continue: { kind: "continue", executionMode: "immediate" },
    status: { kind: "status", executionMode: "immediate" },
    queue: { kind: "queue", executionMode: "immediate" },
    compact: { kind: "compact", executionMode: "immediate" },
    model: { kind: "model", executionMode: "immediate" },
    thinking: { kind: "thinking", executionMode: "immediate" },
    settings: { kind: "settings", executionMode: "immediate" },
    help: { kind: "help", commandName: "help", executionMode: "immediate" },
    start: { kind: "help", commandName: "start", executionMode: "immediate" },
};
export function buildTelegramCommandAction(commandName) {
    if (!isTelegramReservedCommandName(commandName)) {
        return { kind: "ignore", executionMode: "ignored" };
    }
    return TELEGRAM_COMMAND_ACTIONS[commandName];
}
export function getTelegramCommandExecutionMode(action) {
    return action.executionMode;
}
function formatTelegramQueuedTurnCount(count) {
    return count === 1 ? "1 queued turn" : `${count} queued turns`;
}
export async function handleTelegramStopCommand(deps) {
    deps.clearPendingModelSwitch();
    deps.cancelNextTransitionAnnouncements?.();
    const clearedCount = deps.clearQueuedTelegramItems();
    deps.setFoldQueuedPromptsIntoHistory(false);
    if (!deps.hasAbortHandler()) {
        const clearedSuffix = clearedCount > 0
            ? ` Cleared ${formatTelegramQueuedTurnCount(clearedCount)}.`
            : "";
        if (clearedCount > 0)
            deps.updateStatus();
        await deps.sendTextReply(formatTelegramInformationHeading("💤", `No active turn.${clearedSuffix}`), { parseMode: "HTML" });
        return;
    }
    deps.abortCurrentTurn();
    deps.updateStatus();
    const clearedSuffix = clearedCount > 0
        ? ` Cleared ${formatTelegramQueuedTurnCount(clearedCount)}.`
        : "";
    await deps.sendTextReply(formatTelegramInformationHeading("⏹️", `Aborted current turn.${clearedSuffix}`), { parseMode: "HTML" });
}
export async function handleTelegramAbortCommand(deps) {
    deps.clearPendingModelSwitch();
    deps.cancelNextTransitionAnnouncements?.();
    if (!deps.hasAbortHandler()) {
        await deps.sendTextReply(formatTelegramInformationHeading("💤", "No active turn."), { parseMode: "HTML" });
        return;
    }
    deps.setFoldQueuedPromptsIntoHistory(deps.hasActiveTelegramTurn());
    deps.abortCurrentTurn();
    deps.updateStatus();
    await deps.sendTextReply(formatTelegramInformationHeading("⏹️", "Aborted current turn."), { parseMode: "HTML" });
}
export async function handleTelegramNextCommand(deps) {
    deps.clearPendingModelSwitch();
    if (!deps.hasQueuedItems()) {
        await deps.sendTextReply(formatTelegramInformationHeading("⌛", "Queue is empty"), { parseMode: "HTML" });
        return;
    }
    if (!deps.isIdle() && deps.hasAbortHandler()) {
        deps.clearFoldForDispatch();
        deps.requestNextDispatchAnnouncement?.();
        deps.markActiveTurnNextAbortAnnouncement?.();
        deps.abortCurrentTurn();
        deps.updateStatus();
        return;
    }
    if (!deps.isIdle()) {
        await deps.sendTextReply(formatTelegramInformationHeading("⏳", "Pi is busy. Send /abort or /stop first."), { parseMode: "HTML" });
        return;
    }
    deps.requestNextDispatchAnnouncement?.();
    deps.dispatchNextQueuedTurn();
    deps.updateStatus();
}
export async function handleTelegramContinueCommand(message, ctx, deps) {
    await deps.enqueueContinueTurn(message, ctx);
}
function dispatchNextQueuedTelegramTurnAfterCompact(deps) {
    if (deps.requestDeferredDispatchNextQueuedTelegramTurn) {
        deps.requestDeferredDispatchNextQueuedTelegramTurn(deps.dispatchNextQueuedTelegramTurn);
        return;
    }
    deps.dispatchNextQueuedTelegramTurn();
}
export function buildTelegramNewConfirmationReplyMarkup() {
    return {
        inline_keyboard: [
            [
                { text: "🆕 Yes, start new", callback_data: "new:confirm" },
                { text: "❌ No", callback_data: "new:cancel" },
            ],
        ],
    };
}
export function getTelegramNewConfirmationHtml() {
    return "<b>Start a new session?</b>";
}
export async function openTelegramNewConfirmation(target, deps) {
    await deps.sendInteractiveMessage(target.chatId, getTelegramNewConfirmationHtml(), "html", buildTelegramNewConfirmationReplyMarkup(), target.threadId !== undefined
        ? { target: { chatId: target.chatId, threadId: target.threadId } }
        : undefined);
}
export async function handleTelegramNewConfirmationCallback(query, deps) {
    if (query.data !== "new:confirm" && query.data !== "new:cancel")
        return false;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") {
        await deps.answerCallbackQuery(query.id, "⌛ Interactive message expired.");
        return true;
    }
    if (query.data === "new:cancel") {
        await deps.editInteractiveMessage(chatId, messageId, "<b>🚫 New session cancelled.</b>", "html", { inline_keyboard: [] });
        await deps.answerCallbackQuery(query.id);
        return true;
    }
    await deps.answerCallbackQuery(query.id);
    await deps.deleteMessage(chatId, messageId);
    await deps.runNew(deps.ctx);
    return true;
}
export function buildTelegramCompactConfirmationReplyMarkup() {
    return {
        inline_keyboard: [
            [
                { text: "🗜 Yes, compact", callback_data: "compact:confirm" },
                { text: "❌ No", callback_data: "compact:cancel" },
            ],
        ],
    };
}
export function getTelegramCompactConfirmationHtml() {
    return "<b>Compact session?</b>";
}
export async function openTelegramCompactConfirmation(target, deps) {
    await deps.sendInteractiveMessage(target.chatId, getTelegramCompactConfirmationHtml(), "html", buildTelegramCompactConfirmationReplyMarkup(), target.threadId !== undefined
        ? { target: { chatId: target.chatId, threadId: target.threadId } }
        : undefined);
}
export async function handleTelegramCompactConfirmationCallback(query, deps) {
    if (query.data !== "compact:confirm" && query.data !== "compact:cancel") {
        return false;
    }
    const callbackMessage = query.message;
    const chatId = callbackMessage?.chat?.id;
    const messageId = callbackMessage?.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") {
        await deps.answerCallbackQuery(query.id, "⌛ Interactive message expired.");
        return true;
    }
    if (query.data === "compact:cancel") {
        await deps.editInteractiveMessage(chatId, messageId, "<b>🚫 Compaction cancelled.</b>", "html", { inline_keyboard: [] });
        await deps.answerCallbackQuery(query.id);
        return true;
    }
    await deps.editInteractiveMessage(chatId, messageId, TELEGRAM_COMPACTION_STARTED_TEXT, "html", { inline_keyboard: [] });
    await deps.answerCallbackQuery(query.id);
    const threadId = callbackMessage?.message_thread_id;
    await deps.runCompact(deps.ctx, chatId, messageId, typeof threadId === "number" ? { chatId, threadId } : { chatId });
    return true;
}
export async function handleTelegramNewCommand(deps) {
    if (!deps.isIdle() ||
        deps.hasPendingMessages() ||
        deps.hasActiveTelegramTurn() ||
        deps.hasDispatchPending() ||
        deps.hasQueuedTelegramItems() ||
        deps.isCompactionInProgress()) {
        await deps.sendTextReply(formatTelegramInformationHeading("⏳", "Cannot start a new session while Pi or the Telegram queue is busy. Wait for queued turns to finish or send /abort first."), { parseMode: "HTML" });
        return;
    }
    if (!deps.requestNewSession) {
        await deps.sendTextReply(formatTelegramInformationHeading("🚫", "Session replacement is unavailable in this Pi runtime."), { parseMode: "HTML" });
        return;
    }
    deps.requestNewSession();
}
export async function handleTelegramCompactCommand(deps) {
    if (!deps.isIdle() ||
        deps.hasPendingMessages() ||
        deps.hasActiveTelegramTurn() ||
        deps.hasDispatchPending() ||
        deps.hasQueuedTelegramItems() ||
        deps.isCompactionInProgress()) {
        await deps.sendTextReply(formatTelegramInformationHeading("⏳", "Cannot compact while Pi or the Telegram queue is busy. Wait for queued turns to finish or send /abort first."), { parseMode: "HTML" });
        return;
    }
    deps.setCompactionInProgress(true);
    deps.updateStatus();
    deps.startTypingLoop?.();
    try {
        deps.compact({
            onComplete: () => {
                deps.stopTypingLoop?.();
                deps.setCompactionInProgress(false);
                deps.updateStatus();
                dispatchNextQueuedTelegramTurnAfterCompact(deps);
                void deps.sendTextReply(TELEGRAM_COMPACTION_COMPLETED_TEXT, {
                    parseMode: "HTML",
                });
            },
            onError: (error) => {
                deps.stopTypingLoop?.();
                deps.setCompactionInProgress(false);
                deps.updateStatus();
                dispatchNextQueuedTelegramTurnAfterCompact(deps);
                deps.recordRuntimeEvent?.("compact", error);
                void deps.sendTextReply(formatTelegramInformationHeading("⚠️", formatTelegramCompactionFailure(error)), { parseMode: "HTML" });
            },
        });
    }
    catch (error) {
        deps.stopTypingLoop?.();
        deps.setCompactionInProgress(false);
        deps.updateStatus();
        deps.recordRuntimeEvent?.("compact", error);
        await deps.sendTextReply(formatTelegramInformationHeading("⚠️", formatTelegramCompactionFailure(error)), { parseMode: "HTML" });
        return;
    }
    if (!deps.suppressStartNotice) {
        await deps.sendTextReply(TELEGRAM_COMPACTION_STARTED_TEXT, {
            parseMode: "HTML",
        });
    }
}
function isTelegramStaleContextError(error) {
    return (error instanceof Error &&
        (error.message.includes("stale after session") ||
            error.message.includes("stale ctx")));
}
export async function handleTelegramStatusCommand(deps) {
    try {
        await deps.showStatus(deps.ctx);
    }
    catch (error) {
        if (!isTelegramStaleContextError(error))
            throw error;
    }
}
export async function handleTelegramModelCommand(deps) {
    try {
        await deps.openModelMenu(deps.ctx);
    }
    catch (error) {
        if (!isTelegramStaleContextError(error))
            throw error;
    }
}
export async function executeTelegramCommandAction(action, message, ctx, deps, commandArgs = "") {
    switch (action.kind) {
        case "ignore":
            return false;
        case "stop":
            await deps.handleStop(message, ctx);
            return true;
        case "name":
            await deps.handleName(message, ctx, commandArgs);
            return true;
        case "new":
            await deps.handleNew(message, ctx);
            return true;
        case "abort":
            await deps.handleAbort(message, ctx);
            return true;
        case "next":
            await deps.handleNext(message, ctx);
            return true;
        case "continue":
            await deps.handleContinue(message, ctx);
            return true;
        case "queue":
            await deps.handleQueue(message, ctx);
            return true;
        case "compact":
            await deps.handleCompact(message, ctx);
            return true;
        case "status":
            await deps.handleStatus(message, ctx);
            return true;
        case "model":
            await deps.handleModel(message, ctx);
            return true;
        case "thinking":
            await deps.handleThinking(message, ctx);
            return true;
        case "settings":
            if (!deps.handleSettings)
                return false;
            await deps.handleSettings(message, ctx);
            return true;
        case "help":
            await deps.handleHelp(message, action.commandName, ctx);
            return true;
    }
}
export function createTelegramCommandHandlerTargetRuntime(deps) {
    const commandTargetRuntime = createTelegramCommandTargetQueueRuntime({
        createControlItem: createTelegramControlItemBuilder({
            allocateItemOrder: deps.allocateItemOrder,
            allocateControlOrder: deps.allocateControlOrder,
        }),
        appendControlItem: deps.appendControlItem,
        dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
        getAdmissionScope: deps.getAdmissionScope,
        getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
        onControlQueued: deps.onControlQueued,
        showStatus: deps.showStatus,
        openModelMenu: deps.openModelMenu,
        openSettingsMenu: deps.openSettingsMenu,
        sendTextReply: deps.sendTextReply,
    });
    return createTelegramCommandHandler({
        hasAbortHandler: deps.hasAbortHandler,
        clearPendingModelSwitch: deps.clearPendingModelSwitch,
        hasQueuedTelegramItems: deps.hasQueuedTelegramItems,
        clearQueuedTelegramItems: deps.clearQueuedTelegramItems,
        setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
        abortCurrentTurn: deps.abortCurrentTurn,
        isIdle: deps.isIdle,
        hasPendingMessages: deps.hasPendingMessages,
        hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
        hasDispatchPending: deps.hasDispatchPending,
        isCompactionInProgress: deps.isCompactionInProgress,
        setCompactionInProgress: deps.setCompactionInProgress,
        updateStatus: deps.updateStatus,
        isContextActive: deps.isContextActive,
        dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
        requestNextDispatchAnnouncement: deps.requestNextDispatchAnnouncement,
        markActiveTurnNextAbortAnnouncement: deps.markActiveTurnNextAbortAnnouncement,
        cancelNextTransitionAnnouncements: deps.cancelNextTransitionAnnouncements,
        startTypingLoop: deps.startTypingLoop,
        stopTypingLoop: deps.stopTypingLoop,
        enqueueContinueTurn: deps.enqueueContinueTurn,
        compact: deps.compact,
        requestNewSession: deps.requestNewSession,
        sendInteractiveMessage: deps.sendInteractiveMessage,
        enqueueControlItem: commandTargetRuntime.enqueueControlItem,
        showStatus: commandTargetRuntime.showStatus,
        openModelMenu: commandTargetRuntime.openModelMenu,
        openThinkingMenu: deps.openThinkingMenu,
        openQueueMenu: deps.openQueueMenu,
        openSettingsMenu: commandTargetRuntime.openSettingsMenu,
        handleForumBootstrap: deps.handleForumBootstrap,
        getAllowedUserId: deps.getAllowedUserId,
        persistAllowedUserId: deps.persistAllowedUserId,
        registerBotCommands: createTelegramBotCommandRegistrar({
            setMyCommands: deps.setMyCommands,
        }),
        validateThreadName: deps.validateThreadName,
        renameCurrentThread: deps.renameCurrentThread,
        resetCurrentThreadName: deps.resetCurrentThreadName,
        openThreadNameDialog: deps.openThreadNameDialog,
        sendTextReply: commandTargetRuntime.sendTextReply,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
}
export function createTelegramCommandHandler(deps) {
    return async (commandName, message, ctx, commandArgs) => {
        return handleTelegramCommandRuntime(commandName, message, ctx, deps, commandArgs);
    };
}
export function createTelegramCommandOrPromptRuntime(deps) {
    return {
        dispatchMessages: async (messages, ctx) => {
            const firstMessage = messages[0];
            if (!firstMessage)
                return;
            if (deps.shouldIgnoreMessages?.(messages))
                return;
            deps.assertExecutionCurrent?.(firstMessage);
            if (await deps.consumeThreadNameInput?.(messages, ctx)) {
                deps.assertExecutionCurrent?.(firstMessage);
                return;
            }
            const command = parseTelegramCommand(deps.extractRawText(messages));
            const handled = await deps.handleCommand(command?.name, firstMessage, ctx, command?.args);
            deps.assertExecutionCurrent?.(firstMessage);
            if (handled)
                return;
            if (command && deps.executeExtensionCommand) {
                const handledByExtension = await deps.executeExtensionCommand(command, messages[0], ctx);
                deps.assertExecutionCurrent?.(firstMessage);
                if (handledByExtension)
                    return;
            }
            if (command?.name && deps.expandPromptTemplateCommand) {
                const expanded = deps.expandPromptTemplateCommand(command.name, command.args);
                if (expanded !== undefined) {
                    deps.assertExecutionCurrent?.(firstMessage);
                    await deps.enqueueTurn([
                        deps.replaceMessageText(firstMessage, expanded),
                        ...messages.slice(1),
                    ], ctx);
                    return;
                }
            }
            deps.assertExecutionCurrent?.(firstMessage);
            await deps.enqueueTurn(messages, ctx);
        },
    };
}
function scheduleTelegramCommandEffect(ctx, command, phase, deps, effect, assertExecutionCurrent) {
    void Promise.resolve()
        .then(async () => {
        if (deps.isContextActive?.(ctx) === false)
            return;
        assertExecutionCurrent?.();
        await effect();
        assertExecutionCurrent?.();
    })
        .catch((error) => {
        try {
            deps.recordRuntimeEvent?.("telegram-command", error, {
                command,
                phase,
            });
        }
        catch {
            // Effect diagnostics cannot create an unhandled detached Promise.
        }
    });
}
async function handleTelegramCommandRuntime(commandName, message, ctx, deps, commandArgs = "") {
    const assertExecutionCurrentFor = (nextMessage) => () => deps.assertExecutionCurrent?.(nextMessage);
    const sendReplyFor = (nextMessage) => async (text, options) => {
        deps.assertExecutionCurrent?.(nextMessage);
        await deps.sendTextReply(nextMessage, text, options);
        deps.assertExecutionCurrent?.(nextMessage);
    };
    const updateStatusFor = (commandCtx) => () => deps.updateStatus(commandCtx);
    return executeTelegramCommandAction(buildTelegramCommandAction(commandName), message, ctx, {
        handleStop: async (nextMessage, commandCtx) => {
            await handleTelegramStopCommand({
                hasAbortHandler: deps.hasAbortHandler,
                clearPendingModelSwitch: deps.clearPendingModelSwitch,
                cancelNextTransitionAnnouncements: deps.cancelNextTransitionAnnouncements,
                clearQueuedTelegramItems: () => deps.clearQueuedTelegramItems(commandCtx),
                setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
                abortCurrentTurn: deps.abortCurrentTurn,
                updateStatus: updateStatusFor(commandCtx),
                sendTextReply: sendReplyFor(nextMessage),
            });
        },
        handleName: async (nextMessage, _commandCtx, requestedName) => {
            const threadName = requestedName.trim();
            if (!threadName) {
                if (deps.openThreadNameDialog) {
                    await deps.openThreadNameDialog(nextMessage, _commandCtx);
                }
                else {
                    await sendReplyFor(nextMessage)(formatTelegramInformationHeading("🏷️", "Usage: /name Navigator"), { parseMode: "HTML" });
                }
                return;
            }
            if (/^[A-Z]$/.test(threadName) && deps.resetCurrentThreadName) {
                const result = await deps.resetCurrentThreadName(getTelegramCommandMessageTarget(nextMessage));
                await sendReplyFor(nextMessage)(result.ok && !result.message
                    ? formatTelegramAutomaticThreadDisplayNameRestoredHeading(result.threadName ?? threadName)
                    : formatTelegramInformationHeading(result.ok ? "✅" : "⚠️", result.message ?? "Thread display name reset failed."), { parseMode: "HTML" });
                return;
            }
            const validationError = deps.validateThreadName?.(threadName);
            if (validationError) {
                await sendReplyFor(nextMessage)(formatTelegramInvalidInstanceName(validationError), { parseMode: "HTML" });
                return;
            }
            if (!deps.renameCurrentThread) {
                await sendReplyFor(nextMessage)(formatTelegramInformationHeading("🚫", "Thread display naming is unavailable."), { parseMode: "HTML" });
                return;
            }
            deps.assertExecutionCurrent?.(nextMessage);
            const result = await deps.renameCurrentThread(getTelegramCommandMessageTarget(nextMessage), threadName);
            deps.assertExecutionCurrent?.(nextMessage);
            await sendReplyFor(nextMessage)(result.ok && !result.message
                ? formatTelegramThreadDisplayNameSavedHeading(result.threadName ?? threadName)
                : formatTelegramInformationHeading(result.ok ? "✅" : "⚠️", result.message ?? "Thread display name update failed."), { parseMode: "HTML" });
        },
        handleAbort: async (nextMessage, commandCtx) => {
            await handleTelegramAbortCommand({
                hasAbortHandler: deps.hasAbortHandler,
                hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
                clearPendingModelSwitch: deps.clearPendingModelSwitch,
                cancelNextTransitionAnnouncements: deps.cancelNextTransitionAnnouncements,
                abortCurrentTurn: deps.abortCurrentTurn,
                setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
                updateStatus: updateStatusFor(commandCtx),
                sendTextReply: sendReplyFor(nextMessage),
            });
        },
        handleNext: async (nextMessage, commandCtx) => {
            await handleTelegramNextCommand({
                hasAbortHandler: deps.hasAbortHandler,
                isIdle: () => deps.isIdle(commandCtx),
                hasQueuedItems: deps.hasQueuedTelegramItems,
                clearPendingModelSwitch: deps.clearPendingModelSwitch,
                abortCurrentTurn: deps.abortCurrentTurn,
                dispatchNextQueuedTurn: () => deps.dispatchNextQueuedTelegramTurn(commandCtx),
                requestNextDispatchAnnouncement: deps.requestNextDispatchAnnouncement,
                markActiveTurnNextAbortAnnouncement: deps.markActiveTurnNextAbortAnnouncement,
                clearFoldForDispatch: () => deps.setFoldQueuedPromptsIntoHistory(false),
                updateStatus: updateStatusFor(commandCtx),
                sendTextReply: sendReplyFor(nextMessage),
                getActiveTurnReply: deps.getActiveTurnReply,
            });
        },
        handleContinue: async (nextMessage, commandCtx) => {
            await handleTelegramContinueCommand(nextMessage, commandCtx, {
                enqueueContinueTurn: deps.enqueueContinueTurn,
            });
        },
        handleQueue: async (nextMessage, commandCtx) => {
            scheduleTelegramCommandEffect(commandCtx, "queue", "menu-render", deps, () => deps.openQueueMenu(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
        },
        handleNew: async (nextMessage, commandCtx) => {
            if (deps.sendInteractiveMessage) {
                await openTelegramNewConfirmation(getTelegramCommandMessageTarget(nextMessage), { sendInteractiveMessage: deps.sendInteractiveMessage });
                return;
            }
            await handleTelegramNewCommand({
                isIdle: () => deps.isIdle(commandCtx),
                hasPendingMessages: () => deps.hasPendingMessages(commandCtx),
                hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
                hasDispatchPending: deps.hasDispatchPending,
                hasQueuedTelegramItems: deps.hasQueuedTelegramItems,
                isCompactionInProgress: deps.isCompactionInProgress,
                requestNewSession: deps.requestNewSession
                    ? () => deps.requestNewSession(nextMessage)
                    : undefined,
                sendTextReply: sendReplyFor(nextMessage),
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
        handleCompact: async (nextMessage, commandCtx) => {
            if (deps.sendInteractiveMessage) {
                await openTelegramCompactConfirmation(getTelegramCommandMessageTarget(nextMessage), { sendInteractiveMessage: deps.sendInteractiveMessage });
                return;
            }
            await handleTelegramCompactCommand({
                isIdle: () => deps.isIdle(commandCtx),
                hasPendingMessages: () => deps.hasPendingMessages(commandCtx),
                hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
                hasDispatchPending: deps.hasDispatchPending,
                hasQueuedTelegramItems: deps.hasQueuedTelegramItems,
                isCompactionInProgress: deps.isCompactionInProgress,
                setCompactionInProgress: deps.setCompactionInProgress,
                updateStatus: updateStatusFor(commandCtx),
                dispatchNextQueuedTelegramTurn: () => deps.dispatchNextQueuedTelegramTurn(commandCtx),
                requestDeferredDispatchNextQueuedTelegramTurn: deps.requestDeferredDispatchNextQueuedTelegramTurn
                    ? (dispatch) => deps.requestDeferredDispatchNextQueuedTelegramTurn?.(() => dispatch())
                    : undefined,
                compact: (callbacks) => deps.compact(commandCtx, callbacks),
                startTypingLoop: deps.startTypingLoop
                    ? () => deps.startTypingLoop?.(commandCtx, nextMessage.chat.id, {
                        target: getTelegramCommandMessageTarget(nextMessage),
                    })
                    : undefined,
                stopTypingLoop: deps.stopTypingLoop,
                sendTextReply: sendReplyFor(nextMessage),
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
        handleStatus: async (nextMessage, commandCtx) => {
            scheduleTelegramCommandEffect(commandCtx, "status", "menu-render", deps, () => deps.showStatus(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
        },
        handleModel: async (nextMessage, commandCtx) => {
            scheduleTelegramCommandEffect(commandCtx, "model", "menu-render", deps, () => handleTelegramModelCommand({
                ctx: commandCtx,
                openModelMenu: (controlCtx) => deps.openModelMenu(nextMessage, controlCtx),
            }), assertExecutionCurrentFor(nextMessage));
        },
        handleThinking: async (nextMessage, commandCtx) => {
            scheduleTelegramCommandEffect(commandCtx, "thinking", "menu-render", deps, () => deps.openThinkingMenu(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
        },
        handleSettings: deps.openSettingsMenu
            ? async (nextMessage, commandCtx) => {
                scheduleTelegramCommandEffect(commandCtx, "settings", "menu-render", deps, () => deps.openSettingsMenu(nextMessage, commandCtx), assertExecutionCurrentFor(nextMessage));
            }
            : undefined,
        handleHelp: async (nextMessage, nextCommandName, commandCtx) => {
            if (nextMessage.from?.id !== undefined &&
                canPairTelegramUserFromCommandMessage(nextMessage)) {
                const allowed = await pairTelegramUserIfNeeded(nextMessage.from.id, {
                    allowedUserId: deps.getAllowedUserId(),
                    ctx: undefined,
                    persistAllowedUserId: deps.persistAllowedUserId,
                    updateStatus: updateStatusFor(commandCtx),
                    assertExecutionCurrent: assertExecutionCurrentFor(nextMessage),
                });
                if (!allowed)
                    return;
            }
            const isContextActive = () => deps.isContextActive?.(commandCtx) !== false;
            scheduleTelegramCommandEffect(commandCtx, nextCommandName, "menu-render", deps, async () => {
                let forumBootstrapMessage;
                if (nextCommandName === "start" && deps.handleForumBootstrap) {
                    forumBootstrapMessage = await deps.handleForumBootstrap(nextMessage, commandCtx);
                }
                if (!isContextActive())
                    return;
                if (forumBootstrapMessage) {
                    await deps.sendTextReply(nextMessage, forumBootstrapMessage);
                }
                if (!isContextActive())
                    return;
                await deps.showStatus(nextMessage, commandCtx);
            }, assertExecutionCurrentFor(nextMessage));
            scheduleTelegramCommandEffect(commandCtx, nextCommandName, "bot-command-sync", deps, deps.registerBotCommands, assertExecutionCurrentFor(nextMessage));
        },
    }, commandArgs);
}
export const TELEGRAM_INTERNAL_COMMAND_NAME = "telegram-internal";
export const TELEGRAM_INTERNAL_COMMAND_DESCRIPTION = "Internal Telegram command cannot be run manually";
export const TELEGRAM_INTERNAL_MANUAL_USE_MESSAGE = "This internal Telegram command cannot be run manually.";
export function delayTelegramSessionAction(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
export async function settleTelegramSessionReplacement(deps) {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    while (deps.isCurrent?.() !== false) {
        const intent = await deps.getIntent();
        if (!intent || intent.sourceSessionId === deps.sessionId)
            return "none";
        if (intent.profileName !== deps.profileName || intent.cwd !== deps.cwd)
            return "stale";
        if (now() >= intent.expiresAtMs)
            return "expired";
        if (!deps.hasSuccessorContinuity(intent)) {
            await sleep(100);
            continue;
        }
        if (!await deps.clearIntent(intent))
            return "failed";
        do {
            const delivered = await deps.editSuccess(intent);
            if (delivered.ok)
                return "settled";
            if (!delivered.retryable)
                return "failed";
            await sleep(100);
        } while (deps.isCurrent?.() !== false && now() < intent.expiresAtMs);
        return "failed";
    }
    return "stale";
}
export function createTelegramSessionReplacementSettlementRuntime(deps) {
    let generation = 0;
    return {
        onSessionStart(ctx) {
            const currentGeneration = ++generation;
            const resolved = deps.resolve(ctx);
            if (!resolved)
                return;
            void settleTelegramSessionReplacement({
                ...resolved,
                isCurrent: () => currentGeneration === generation &&
                    resolved.isCurrent?.() !== false,
            }).then(deps.onResult, deps.onError);
        },
    };
}
export function createTelegramSessionActionAssembly(deps) {
    const now = deps.now ?? Date.now;
    const report = (error) => deps.recordRuntimeEvent?.("new-session", error);
    const sendTerminalResult = async (target, result) => {
        const text = result === "success" ? "<b>🆕 New session started.</b>"
            : result === "cancelled" ? "<b>🚫 New session cancelled.</b>"
                : "<b>⚠️ New session failed.</b>";
        const deadline = now() + 10_000;
        do {
            const delivery = await deps.sendResult(target, text);
            if (delivery.ok)
                return;
            if (!delivery.retryable)
                break;
            await delayTelegramSessionAction(100);
        } while (now() < deadline);
        report(new Error("Telegram new-session result delivery failed."));
    };
    const action = createTelegramSessionActionRuntime({
        registerCommand: deps.registerCommand,
        sendUserMessage: deps.sendUserMessage,
        notifyResult(target, result) { return sendTerminalResult(target, result); },
        async prepareReplacement(ctx, updateId, target) {
            const follower = !deps.ownsPersistence() && typeof target.threadId === "number" &&
                deps.follower?.isRegisteredFor(target)
                ? deps.follower
                : undefined;
            // Follower memory is not authority; reread the leader-published snapshot.
            if (follower && deps.store.refresh)
                await deps.store.refresh();
            else
                await deps.store.load();
            const sessionId = ctx.sessionManager.getSessionId();
            const binding = typeof target.threadId === "number"
                ? deps.store.getWorkspaceBindingByTarget(target)
                : undefined;
            if (typeof target.threadId === "number" &&
                (!binding || binding.cwd !== ctx.cwd || binding.sessionId !== sessionId)) {
                throw new Error("Telegram session replacement binding is unavailable.");
            }
            const createdAtMs = now();
            const intent = {
                continuity: binding ? "workspace-thread" : "classic-chat",
                cwd: binding?.cwd ?? ctx.cwd,
                profileName: deps.getProfileName() ?? "default",
                sourceSessionId: sessionId,
                sourceUpdateId: updateId,
                target: binding ? { ...binding.target } : { chatId: target.chatId },
                messageId: target.messageId,
                ...(binding?.slot ? { slot: binding.slot } : {}),
                ...(binding?.manualThreadName ?? binding?.threadName
                    ? { threadName: binding.manualThreadName ?? binding.threadName } : {}),
                createdAtMs,
                expiresAtMs: createdAtMs + deps.handoffTtlMs,
                ...(follower ? { sourceInstanceId: follower.instanceId } : {}),
            };
            if (!await (follower
                ? follower.requestSessionReplacement("publish", intent)
                : deps.store.commitSessionReplacementIntent(intent, deps.ownsPersistence))) {
                throw new Error("Telegram session replacement intent was not persisted.");
            }
        },
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const settlement = createTelegramSessionReplacementSettlementRuntime({
        resolve(ctx) {
            const sessionId = ctx.sessionManager?.getSessionId?.();
            if (!sessionId)
                return undefined;
            return {
                async getIntent() { await deps.store.refresh?.(); return deps.store.getSessionReplacementIntent(); },
                hasSuccessorContinuity(intent) {
                    if (intent.continuity === "classic-chat")
                        return true;
                    if (deps.store.getWorkspaceBindingByTarget(intent.target, sessionId)?.cwd !==
                        intent.cwd)
                        return false;
                    // A follower successor claims only after its own re-registration is live.
                    return intent.sourceInstanceId === undefined || deps.ownsPersistence() ||
                        deps.follower?.isRegisteredFor(intent.target) === true;
                },
                editSuccess(intent) { return deps.sendResult(intent.target, "<b>🆕 New session started.</b>"); },
                async clearIntent(intent) {
                    if (intent.sourceInstanceId === undefined || deps.ownsPersistence()) {
                        return deps.store.removeSessionReplacementIntent(intent, deps.ownsPersistence);
                    }
                    return await deps.follower?.requestSessionReplacement("settle", intent) ?? false;
                },
                profileName: deps.getProfileName() ?? "default",
                cwd: ctx.cwd,
                sessionId,
            };
        },
        onResult(result) {
            if (result === "expired" || result === "failed") {
                report(new Error(`Telegram session replacement successor settlement ${result}.`));
            }
        },
        onError: report,
    });
    return { action, settlement };
}
export function createTelegramSessionActionRuntime(deps) {
    let pendingUpdateId;
    let pendingTarget;
    let pendingAction;
    let registered = false;
    const reportFailure = (error) => {
        try {
            deps.recordRuntimeEvent?.("new-session", error);
        }
        catch {
            // Diagnostics cannot make a completed durable update retryable.
        }
    };
    return {
        register() {
            if (registered)
                return;
            registered = true;
            deps.registerCommand(TELEGRAM_INTERNAL_COMMAND_NAME, {
                description: TELEGRAM_INTERNAL_COMMAND_DESCRIPTION,
                handler: async (args, ctx) => {
                    const action = pendingAction;
                    if (!action || args.trim() !== action.token) {
                        ctx.ui.notify(TELEGRAM_INTERNAL_MANUAL_USE_MESSAGE, "warning");
                        return;
                    }
                    pendingAction = undefined;
                    switch (action.kind) {
                        case "replace-session":
                            try {
                                await deps.prepareReplacement?.(ctx, action.updateId, action.target);
                                const result = await ctx.newSession();
                                if (result.cancelled)
                                    await deps.notifyResult(action.target, "cancelled");
                            }
                            catch (error) {
                                reportFailure(error);
                                await deps.notifyResult(action.target, "failure");
                            }
                            return;
                    }
                },
            });
        },
        scheduleAfterUpdate(updateId, target) {
            if (pendingUpdateId !== undefined || pendingAction !== undefined)
                return false;
            pendingUpdateId = updateId;
            pendingTarget = { ...target };
            return true;
        },
        onUpdateCompleted(updateId) {
            if (pendingUpdateId !== updateId)
                return;
            pendingUpdateId = undefined;
            const target = pendingTarget;
            pendingTarget = undefined;
            if (!target)
                return;
            const token = randomUUID();
            pendingAction = { kind: "replace-session", token, updateId, target };
            void Promise.resolve()
                .then(() => deps.sendUserMessage(`/${TELEGRAM_INTERNAL_COMMAND_NAME} ${token}`, {
                expandPromptTemplates: true,
            }))
                .catch((error) => {
                pendingAction = undefined;
                reportFailure(error);
            });
        },
        hasPending() {
            return pendingUpdateId !== undefined || pendingAction !== undefined;
        },
    };
}
