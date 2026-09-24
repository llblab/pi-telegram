/**
 * Telegram command routing helpers
 * Zones: telegram controls, pi agent commands, queue controls
 * Owns Telegram slash-command normalization, bot command metadata, pi-side command registration, and command-initiated session replacement orchestration behind runtime ports
 */
import { type TelegramConfigStore } from "./config.ts";
import type * as Pi from "./pi.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi.ts";
import type { TelegramBridgeStatusLineOptions } from "./status.ts";
import type { TelegramSessionReplacementIntent } from "./threads.ts";
import { type PendingTelegramControlItem, type TelegramQueueAdmissionReceipt } from "./queue.ts";
export interface ParsedTelegramCommand {
    name: string;
    args: string;
}
export interface TelegramBotCommandDefinition {
    command: string;
    description: string;
}
export interface TelegramPromptTemplateMenuCommand {
    command: string;
    description?: string;
}
export interface TelegramExtensionCommandContext {
    name: string;
    args: string;
    reply: (text: string) => Promise<void>;
    enqueuePrompt: (prompt: string) => Promise<void>;
}
export interface TelegramExtensionCommandRegistration {
    name: string;
    description?: string;
    order?: number;
    showInMenu?: boolean;
    emoji?: string;
    handler: (ctx: TelegramExtensionCommandContext) => Promise<void> | void;
}
interface RegisteredTelegramExtensionCommand {
    name: string;
    description?: string;
    order: number;
    showInMenu: boolean;
    emoji?: string;
    handler: TelegramExtensionCommandRegistration["handler"];
}
export declare function normalizeTelegramExtensionCommandName(name: string): string;
export declare function isTelegramExtensionCommandName(name: string): boolean;
export declare function registerTelegramCommand(registration: TelegramExtensionCommandRegistration): () => void;
export declare function getTelegramExtensionCommands(): RegisteredTelegramExtensionCommand[];
export declare function findTelegramExtensionCommand(name: string | undefined): RegisteredTelegramExtensionCommand | undefined;
export declare function clearTelegramExtensionCommands(): void;
export declare const TELEGRAM_COMMAND_EMOJI: {
    readonly start: "🟢";
    readonly status: "📊";
    readonly model: "🤖";
    readonly thinking: "🧠";
    readonly compact: "🗜";
    readonly queue: "🔢";
    readonly thread: "🧵";
    readonly next: "⏩";
    readonly continue: "▶️";
    readonly abort: "⏹️";
    readonly stop: "🟥";
    readonly name: "🏷️";
    readonly new: "🆕";
};
export type TelegramCommandEmojiName = keyof typeof TELEGRAM_COMMAND_EMOJI;
export declare function getTelegramCommandEmoji(command: TelegramCommandEmojiName): string;
export declare function formatTelegramCommandEmojiPrefix(command: TelegramCommandEmojiName): string;
export declare function formatTelegramPiCommandHtml(command: string): string;
export declare function formatTelegramInformationHeading(emoji: string, text: string): string;
export declare function formatTelegramInvalidInstanceName(validationError: string): string;
export declare function formatTelegramThreadDisplayNameSavedHeading(name: string): string;
export declare function formatTelegramAutomaticThreadDisplayNameRestoredHeading(name: string): string;
export declare const TELEGRAM_COMPACTION_STARTED_TEXT: string;
export declare const TELEGRAM_COMPACTION_COMPLETED_TEXT: string;
export declare const TELEGRAM_COMPACTION_STARTED_MARKDOWN: string;
export declare const TELEGRAM_COMPACTION_COMPLETED_MARKDOWN = "**\u2705 Compaction completed.**";
export declare const TELEGRAM_BUILTIN_BOT_COMMANDS: readonly TelegramBotCommandDefinition[];
export declare const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommandDefinition[];
export declare function getTelegramReservedCommandNames(): string[];
export interface TelegramBotCommandRegistrationDeps {
    setMyCommands: (commands: readonly TelegramBotCommandDefinition[]) => Promise<unknown>;
}
export declare function registerTelegramBotCommands(deps: TelegramBotCommandRegistrationDeps): Promise<void>;
export declare function createTelegramBotCommandRegistrar(deps: TelegramBotCommandRegistrationDeps): () => Promise<void>;
export interface TelegramBridgeCommandStartPollingOptions {
    force?: boolean;
    forceFreshLeaderThread?: boolean;
}
export interface TelegramBridgeCommandStartPollingResult {
    ok: boolean;
    message?: string;
    canTakeover?: boolean;
    owner?: string;
}
export type TelegramPollingStartRecoveryResult = {
    kind: "unhandled";
} | {
    kind: "retry";
    message: string;
} | {
    kind: "blocked";
    message: string;
};
export interface TelegramBridgeCommandRegistrationDeps {
    promptForConfig: (ctx: ExtensionCommandContext, profileName?: string) => Promise<void>;
    getStatusLines: (options?: TelegramBridgeStatusLineOptions) => string[];
    reloadConfig: () => Promise<void>;
    hasBotToken: () => boolean;
    getBotTokenDiagnostic?: () => string | undefined;
    startPolling: (ctx: ExtensionCommandContext, options?: TelegramBridgeCommandStartPollingOptions) => void | Promise<void | TelegramBridgeCommandStartPollingResult> | TelegramBridgeCommandStartPollingResult;
    stopPolling: () => Promise<void | string>;
    recoverPollingStart?: (error: unknown) => Promise<TelegramPollingStartRecoveryResult>;
    getDisconnectThreadName?: () => string | undefined;
    queueAgentConnectionContext?: (connected: boolean) => void;
    updateStatus: (ctx: ExtensionCommandContext) => void;
    getProfileNames?: () => string[];
    activateDefaultProfileConfig?: (ctx: ExtensionCommandContext) => Promise<void>;
    activateProfileConfig?: (ctx: ExtensionCommandContext, profileName: string) => Promise<boolean>;
}
export type TelegramThreadDisplayNameRenamePort = (target: {
    chatId: number;
    threadId?: number;
}, threadName: string) => Promise<{
    ok: boolean;
    threadName?: string;
    message?: string;
}>;
export type TelegramThreadDisplayNameResetPort = (target: {
    chatId: number;
    threadId?: number;
}) => Promise<{
    ok: boolean;
    threadName?: string;
    message?: string;
}>;
export declare function createTelegramThreadDisplayNameResetBinding(): {
    bind: (reset: TelegramThreadDisplayNameResetPort) => void;
    reset: TelegramThreadDisplayNameResetPort;
};
export declare function createTelegramThreadDisplayNameRenameBinding(): {
    bind: (rename: TelegramThreadDisplayNameRenamePort) => void;
    rename: TelegramThreadDisplayNameRenamePort;
};
export declare function registerTelegramBridgeCommands(pi: ExtensionAPI, deps: TelegramBridgeCommandRegistrationDeps): void;
export declare const TELEGRAM_RESERVED_COMMAND_NAMES: readonly ["stop", "name", "new", "abort", "next", "continue", "status", "queue", "compact", "model", "thinking", "settings", "help", "start"];
export type TelegramReservedCommandName = (typeof TELEGRAM_RESERVED_COMMAND_NAMES)[number];
export declare function isTelegramReservedCommandName(commandName: string | undefined): commandName is TelegramReservedCommandName;
export type TelegramCommandAction = {
    kind: "ignore";
    executionMode: "ignored";
} | {
    kind: "stop";
    executionMode: "immediate";
} | {
    kind: "name";
    executionMode: "immediate";
} | {
    kind: "new";
    executionMode: "immediate";
} | {
    kind: "abort";
    executionMode: "immediate";
} | {
    kind: "next";
    executionMode: "immediate";
} | {
    kind: "continue";
    executionMode: "immediate";
} | {
    kind: "queue";
    executionMode: "immediate";
} | {
    kind: "compact";
    executionMode: "immediate";
} | {
    kind: "status";
    executionMode: "immediate";
} | {
    kind: "model";
    executionMode: "immediate";
} | {
    kind: "thinking";
    executionMode: "immediate";
} | {
    kind: "settings";
    executionMode: "immediate";
} | {
    kind: "help";
    commandName: "help" | "start";
    executionMode: "immediate";
};
export type TelegramCommandExecutionMode = "ignored" | "immediate";
export interface TelegramCommandActionDeps<TMessage, TContext> {
    handleStop: (message: TMessage, ctx: TContext) => Promise<void>;
    handleName: (message: TMessage, ctx: TContext, name: string) => Promise<void>;
    handleNew: (message: TMessage, ctx: TContext) => Promise<void>;
    handleAbort: (message: TMessage, ctx: TContext) => Promise<void>;
    handleNext: (message: TMessage, ctx: TContext) => Promise<void>;
    handleContinue: (message: TMessage, ctx: TContext) => Promise<void>;
    handleQueue: (message: TMessage, ctx: TContext) => Promise<void>;
    handleCompact: (message: TMessage, ctx: TContext) => Promise<void>;
    handleStatus: (message: TMessage, ctx: TContext) => Promise<void>;
    handleModel: (message: TMessage, ctx: TContext) => Promise<void>;
    handleThinking: (message: TMessage, ctx: TContext) => Promise<void>;
    handleSettings?: (message: TMessage, ctx: TContext) => Promise<void>;
    handleHelp: (message: TMessage, commandName: "help" | "start", ctx: TContext) => Promise<void>;
}
export interface TelegramStopCommandDeps {
    hasAbortHandler: () => boolean;
    clearPendingModelSwitch: () => void;
    cancelNextTransitionAnnouncements?: () => void;
    clearQueuedTelegramItems: () => number;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    abortCurrentTurn: () => void;
    updateStatus: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}
export interface TelegramRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramCompactConfirmationReplyMarkup {
    inline_keyboard: {
        text: string;
        callback_data: string;
    }[][];
}
export interface TelegramCompactCommandDeps extends TelegramRuntimeEventRecorderPort {
    isIdle: () => boolean;
    hasPendingMessages: () => boolean;
    hasActiveTelegramTurn: () => boolean;
    hasDispatchPending: () => boolean;
    hasQueuedTelegramItems: () => boolean;
    isCompactionInProgress: () => boolean;
    setCompactionInProgress: (inProgress: boolean) => void;
    updateStatus: () => void;
    dispatchNextQueuedTelegramTurn: () => void;
    requestDeferredDispatchNextQueuedTelegramTurn?: (dispatch: () => void) => void;
    startTypingLoop?: () => void;
    stopTypingLoop?: () => void;
    compact: (callbacks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
    }) => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
    suppressStartNotice?: boolean;
}
export interface TelegramCompactConfirmationDeps {
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramCompactConfirmationReplyMarkup, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
}
export interface TelegramCompactConfirmationCallbackQuery {
    id: string;
    data?: string;
    message?: {
        chat?: {
            id?: number;
        };
        message_id?: number;
        message_thread_id?: number;
    };
}
export interface TelegramNewConfirmationCallbackDeps<TContext> {
    ctx: TContext;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramCompactConfirmationReplyMarkup) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    runNew: (ctx: TContext) => Promise<void>;
}
export interface TelegramCompactConfirmationCallbackDeps<TContext> {
    ctx: TContext;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: TelegramCompactConfirmationReplyMarkup) => Promise<void>;
    runCompact: (ctx: TContext, chatId: number, replyToMessageId: number, target?: {
        chatId: number;
        threadId?: number;
    }) => Promise<void>;
}
export type TelegramControlCommandType = PendingTelegramControlItem<unknown>["controlType"];
export interface TelegramCommandRuntimeMessage {
    chat: {
        id: number;
        type?: string;
        title?: string;
    };
    message_id: number;
    message_thread_id?: number;
    from?: {
        id?: number;
    };
    pi_telegram_source_update_id?: number;
}
export interface TelegramCommandMessageTarget {
    chatId: number;
    threadId?: number;
    replyToMessageId: number;
}
export interface TelegramCommandTargetRuntimeDeps<TContext> {
    enqueueControlItem: (target: TelegramCommandMessageTarget, ctx: TContext, controlType: TelegramControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>, admissionReceipts?: TelegramQueueAdmissionReceipt[], onQueued?: (item: PendingTelegramControlItem<TContext>) => void) => void;
    getAdmissionScope?: () => string | undefined;
    getAdmissionJournalBinding?: () => string | undefined;
    onControlQueued?: (message: TelegramCommandRuntimeMessage, receipt: TelegramQueueAdmissionReceipt) => void;
    showStatus: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
    openModelMenu: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
    openSettingsMenu?: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number) => Promise<void>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        parseMode?: "HTML";
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<unknown>;
}
export interface TelegramCommandTargetRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext> {
    enqueueControlItem: (message: TMessage, ctx: TContext, controlType: TelegramControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>) => void;
    showStatus: (message: TMessage, ctx: TContext) => Promise<void>;
    openModelMenu: (message: TMessage, ctx: TContext) => Promise<void>;
    openSettingsMenu: (message: TMessage, ctx: TContext) => Promise<void>;
    sendTextReply: (message: TMessage, text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}
export declare function getTelegramCommandMessageTarget(message: TelegramCommandRuntimeMessage): TelegramCommandMessageTarget;
export interface TelegramCommandControlQueueRuntimeDeps<TContext> {
    createControlItem: (options: {
        chatId: number;
        target?: {
            chatId: number;
            threadId?: number;
        };
        replyToMessageId: number;
        controlType: TelegramControlCommandType;
        statusSummary: string;
        admissionReceipts?: TelegramQueueAdmissionReceipt[];
        execute: (ctx: TContext) => Promise<void>;
    }) => PendingTelegramControlItem<TContext>;
    appendControlItem: (item: PendingTelegramControlItem<TContext>, ctx: TContext) => void;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
}
export declare function createTelegramCommandControlQueueRuntime<TContext>(deps: TelegramCommandControlQueueRuntimeDeps<TContext>): TelegramCommandTargetRuntimeDeps<TContext>["enqueueControlItem"];
export declare function createTelegramCommandControlEnqueueAdapter<TContext>(deps: {
    createControlItem: (options: {
        chatId: number;
        target?: {
            chatId: number;
            threadId?: number;
        };
        replyToMessageId: number;
        controlType: TelegramControlCommandType;
        statusSummary: string;
        admissionReceipts?: TelegramQueueAdmissionReceipt[];
        execute: (ctx: TContext) => Promise<void>;
    }) => PendingTelegramControlItem<TContext>;
    enqueueControlItem: (item: PendingTelegramControlItem<TContext>, ctx: TContext, onQueued?: (item: PendingTelegramControlItem<TContext>) => void) => void;
}): TelegramCommandTargetRuntimeDeps<TContext>["enqueueControlItem"];
export type TelegramCommandTargetQueueRuntimeDeps<TContext> = TelegramCommandControlQueueRuntimeDeps<TContext> & Omit<TelegramCommandTargetRuntimeDeps<TContext>, "enqueueControlItem">;
export declare function createTelegramCommandTargetQueueRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandTargetQueueRuntimeDeps<TContext>): TelegramCommandTargetRuntime<TMessage, TContext>;
export declare function createTelegramCommandTargetRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandTargetRuntimeDeps<TContext>): TelegramCommandTargetRuntime<TMessage, TContext>;
export interface TelegramCommandOrPromptRuntimeDeps<TMessage, TContext> {
    extractRawText: (messages: TMessage[]) => string;
    shouldIgnoreMessages?: (messages: TMessage[]) => boolean;
    consumeThreadNameInput?: (messages: TMessage[], ctx: TContext) => Promise<boolean>;
    handleCommand: (commandName: string | undefined, message: TMessage, ctx: TContext, commandArgs?: string) => Promise<boolean>;
    executeExtensionCommand?: (command: ParsedTelegramCommand, message: TMessage, ctx: TContext) => Promise<boolean>;
    expandPromptTemplateCommand?: (commandName: string, args: string) => string | undefined;
    replaceMessageText: (message: TMessage, text: string) => TMessage;
    enqueueTurn: (messages: TMessage[], ctx: TContext) => Promise<void>;
    assertExecutionCurrent?: (message: TMessage) => void;
}
export interface TelegramCommandRuntimeDeps<TMessage extends TelegramCommandRuntimeMessage, TContext> extends TelegramRuntimeEventRecorderPort {
    hasAbortHandler: () => boolean;
    clearPendingModelSwitch: () => void;
    hasQueuedTelegramItems: () => boolean;
    clearQueuedTelegramItems: (ctx: TContext) => number;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    abortCurrentTurn: () => void;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
    hasActiveTelegramTurn: () => boolean;
    hasDispatchPending: () => boolean;
    isCompactionInProgress: () => boolean;
    setCompactionInProgress: (inProgress: boolean) => void;
    updateStatus: (ctx: TContext) => void;
    isContextActive?: (ctx: TContext) => boolean;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
    requestNextDispatchAnnouncement?: () => void;
    markActiveTurnNextAbortAnnouncement?: () => boolean;
    cancelNextTransitionAnnouncements?: () => void;
    requestDeferredDispatchNextQueuedTelegramTurn?: (dispatch: (ctx: TContext) => void) => void;
    startTypingLoop?: (ctx: TContext, chatId?: number, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => void;
    stopTypingLoop?: () => void;
    enqueueContinueTurn: (message: TMessage, ctx: TContext) => Promise<void>;
    requestNewSession?: (message: TMessage) => void;
    compact: (ctx: TContext, callbacks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
    }) => void;
    enqueueControlItem: (message: TMessage, ctx: TContext, controlType: TelegramControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>) => void;
    showStatus: (message: TMessage, ctx: TContext) => Promise<void>;
    handleForumBootstrap?: (message: TMessage, ctx: TContext) => Promise<string | undefined>;
    openModelMenu: (message: TMessage, ctx: TContext) => Promise<void>;
    openThinkingMenu: (message: TMessage, ctx: TContext) => Promise<void>;
    openQueueMenu: (message: TMessage, ctx: TContext) => Promise<void>;
    openSettingsMenu?: (message: TMessage, ctx: TContext) => Promise<void>;
    validateThreadName?: (threadName: string) => string | undefined;
    renameCurrentThread?: TelegramThreadDisplayNameRenamePort;
    resetCurrentThreadName?: TelegramThreadDisplayNameResetPort;
    openThreadNameDialog?: (message: TMessage, ctx: TContext) => Promise<void>;
    getAllowedUserId: () => number | undefined;
    persistAllowedUserId: TelegramConfigStore["persistAllowedUserId"];
    registerBotCommands: () => Promise<void>;
    getPromptTemplateCommands?: () => readonly TelegramPromptTemplateMenuCommand[];
    sendTextReply: (message: TMessage, text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
    getActiveTurnReply?: () => ((text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>) | undefined;
    sendInteractiveMessage?: TelegramCompactConfirmationDeps["sendInteractiveMessage"];
    assertExecutionCurrent?: (message: TMessage) => void;
}
export declare const TELEGRAM_APP_MENU_INTRO_HTML: string;
export declare function buildTelegramAppMenuHtml(statusHtml: string, promptTemplates?: readonly TelegramPromptTemplateMenuCommand[]): string;
export declare function createTelegramAppMenuHtmlBuilder<TContext>(deps: {
    buildStatusHtml: (ctx: TContext) => string;
    getPromptTemplateCommands?: () => readonly TelegramPromptTemplateMenuCommand[];
}): (ctx: TContext) => string;
export declare function parseTelegramCommand(text: string): ParsedTelegramCommand | undefined;
export declare const TELEGRAM_COMMAND_ACTIONS: {
    readonly stop: {
        readonly kind: "stop";
        readonly executionMode: "immediate";
    };
    readonly name: {
        readonly kind: "name";
        readonly executionMode: "immediate";
    };
    readonly new: {
        readonly kind: "new";
        readonly executionMode: "immediate";
    };
    readonly abort: {
        readonly kind: "abort";
        readonly executionMode: "immediate";
    };
    readonly next: {
        readonly kind: "next";
        readonly executionMode: "immediate";
    };
    readonly continue: {
        readonly kind: "continue";
        readonly executionMode: "immediate";
    };
    readonly status: {
        readonly kind: "status";
        readonly executionMode: "immediate";
    };
    readonly queue: {
        readonly kind: "queue";
        readonly executionMode: "immediate";
    };
    readonly compact: {
        readonly kind: "compact";
        readonly executionMode: "immediate";
    };
    readonly model: {
        readonly kind: "model";
        readonly executionMode: "immediate";
    };
    readonly thinking: {
        readonly kind: "thinking";
        readonly executionMode: "immediate";
    };
    readonly settings: {
        readonly kind: "settings";
        readonly executionMode: "immediate";
    };
    readonly help: {
        readonly kind: "help";
        readonly commandName: "help";
        readonly executionMode: "immediate";
    };
    readonly start: {
        readonly kind: "help";
        readonly commandName: "start";
        readonly executionMode: "immediate";
    };
};
export declare function buildTelegramCommandAction(commandName: string | undefined): TelegramCommandAction;
export declare function getTelegramCommandExecutionMode(action: TelegramCommandAction): TelegramCommandExecutionMode;
export declare function handleTelegramStopCommand(deps: TelegramStopCommandDeps): Promise<void>;
export declare function handleTelegramAbortCommand(deps: {
    hasAbortHandler: () => boolean;
    hasActiveTelegramTurn: () => boolean;
    clearPendingModelSwitch: () => void;
    cancelNextTransitionAnnouncements?: () => void;
    abortCurrentTurn: () => void;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    updateStatus: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}): Promise<void>;
export declare function handleTelegramNextCommand(deps: {
    hasAbortHandler: () => boolean;
    isIdle: () => boolean;
    hasQueuedItems: () => boolean;
    clearPendingModelSwitch: () => void;
    abortCurrentTurn: () => void;
    dispatchNextQueuedTurn: () => void;
    requestNextDispatchAnnouncement?: () => void;
    markActiveTurnNextAbortAnnouncement?: () => boolean;
    clearFoldForDispatch: () => void;
    updateStatus: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
    getActiveTurnReply?: () => ((text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>) | undefined;
}): Promise<void>;
export declare function handleTelegramContinueCommand<TMessage, TContext>(message: TMessage, ctx: TContext, deps: {
    enqueueContinueTurn: (message: TMessage, ctx: TContext) => Promise<void>;
}): Promise<void>;
export declare function buildTelegramNewConfirmationReplyMarkup(): TelegramCompactConfirmationReplyMarkup;
export declare function getTelegramNewConfirmationHtml(): string;
export declare function openTelegramNewConfirmation(target: TelegramCommandMessageTarget, deps: TelegramCompactConfirmationDeps): Promise<void>;
export declare function handleTelegramNewConfirmationCallback<TContext>(query: TelegramCompactConfirmationCallbackQuery, deps: TelegramNewConfirmationCallbackDeps<TContext>): Promise<boolean>;
export declare function buildTelegramCompactConfirmationReplyMarkup(): TelegramCompactConfirmationReplyMarkup;
export declare function getTelegramCompactConfirmationHtml(): string;
export declare function openTelegramCompactConfirmation(target: TelegramCommandMessageTarget, deps: TelegramCompactConfirmationDeps): Promise<void>;
export declare function handleTelegramCompactConfirmationCallback<TContext>(query: TelegramCompactConfirmationCallbackQuery, deps: TelegramCompactConfirmationCallbackDeps<TContext>): Promise<boolean>;
export interface TelegramNewCommandDeps extends TelegramRuntimeEventRecorderPort {
    isIdle: () => boolean;
    hasPendingMessages: () => boolean;
    hasActiveTelegramTurn: () => boolean;
    hasDispatchPending: () => boolean;
    hasQueuedTelegramItems: () => boolean;
    isCompactionInProgress: () => boolean;
    requestNewSession?: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}
export declare function handleTelegramNewCommand(deps: TelegramNewCommandDeps): Promise<void>;
export declare function handleTelegramCompactCommand(deps: TelegramCompactCommandDeps): Promise<void>;
export declare function handleTelegramStatusCommand<TContext>(deps: {
    ctx: TContext;
    showStatus: (ctx: TContext) => Promise<void>;
}): Promise<void>;
export declare function handleTelegramModelCommand<TContext>(deps: {
    ctx: TContext;
    openModelMenu: (ctx: TContext) => Promise<void>;
}): Promise<void>;
export declare function executeTelegramCommandAction<TMessage, TContext>(action: TelegramCommandAction, message: TMessage, ctx: TContext, deps: TelegramCommandActionDeps<TMessage, TContext>, commandArgs?: string): Promise<boolean>;
export interface TelegramCommandHandlerTargetRuntimeDeps<TMessage extends TelegramCommandRuntimeMessage, TContext> extends Omit<TelegramCommandRuntimeDeps<TMessage, TContext>, "enqueueControlItem" | "showStatus" | "openModelMenu" | "openSettingsMenu" | "sendTextReply" | "registerBotCommands">, Omit<TelegramCommandTargetQueueRuntimeDeps<TContext>, "createControlItem">, TelegramBotCommandRegistrationDeps {
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}
export declare function createTelegramCommandHandlerTargetRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandHandlerTargetRuntimeDeps<TMessage, TContext>): (commandName: string | undefined, message: TMessage, ctx: TContext, commandArgs?: string) => Promise<boolean>;
export declare function createTelegramCommandHandler<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandRuntimeDeps<TMessage, TContext>): (commandName: string | undefined, message: TMessage, ctx: TContext, commandArgs?: string) => Promise<boolean>;
export declare function createTelegramCommandOrPromptRuntime<TMessage, TContext>(deps: TelegramCommandOrPromptRuntimeDeps<TMessage, TContext>): {
    dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
};
export declare const TELEGRAM_INTERNAL_COMMAND_NAME = "telegram-internal";
export declare const TELEGRAM_INTERNAL_COMMAND_DESCRIPTION = "Internal Telegram command cannot be run manually";
export declare const TELEGRAM_INTERNAL_MANUAL_USE_MESSAGE = "This internal Telegram command cannot be run manually.";
export declare function delayTelegramSessionAction(delayMs: number): Promise<void>;
export interface TelegramSessionActionRuntimeDeps {
    registerCommand: Pi.ExtensionAPI["registerCommand"];
    sendUserMessage: Pi.ExtensionAPI["sendUserMessage"];
    notifyResult: (target: {
        chatId: number;
        threadId?: number;
        messageId: number;
    }, result: "success" | "cancelled" | "failure") => Promise<void>;
    prepareReplacement?: (ctx: Pi.ExtensionCommandContext, updateId: number, target: {
        chatId: number;
        threadId?: number;
        messageId: number;
    }) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown) => void;
}
export interface TelegramSessionReplacementSettlementDeps {
    getIntent: () => Promise<TelegramSessionReplacementIntent | undefined>;
    hasSuccessorContinuity: (intent: TelegramSessionReplacementIntent) => boolean;
    editSuccess: (intent: TelegramSessionReplacementIntent) => Promise<{
        ok: boolean;
        retryable?: boolean;
        message?: string;
    }>;
    clearIntent: (intent: TelegramSessionReplacementIntent) => Promise<boolean>;
    profileName: string | undefined;
    cwd: string;
    sessionId: string;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    isCurrent?: () => boolean;
}
export declare function settleTelegramSessionReplacement(deps: TelegramSessionReplacementSettlementDeps): Promise<"none" | "settled" | "expired" | "failed" | "stale">;
export declare function createTelegramSessionReplacementSettlementRuntime<TContext>(deps: {
    resolve: (ctx: TContext) => TelegramSessionReplacementSettlementDeps | undefined;
    onResult?: (result: "none" | "settled" | "expired" | "failed" | "stale") => void;
    onError?: (error: unknown) => void;
}): {
    onSessionStart: (ctx: TContext) => void;
};
export interface TelegramSessionActionAssemblyDeps {
    registerCommand: Pi.ExtensionAPI["registerCommand"];
    sendUserMessage: Pi.ExtensionAPI["sendUserMessage"];
    store: {
        load: () => Promise<void>;
        refresh?: () => Promise<void>;
        getWorkspaceBindingByTarget: (target: {
            chatId: number;
            threadId?: number;
        }, sessionId?: string) => {
            cwd: string;
            sessionId?: string;
            slot?: string;
            threadName?: string;
            manualThreadName?: string;
            target: {
                chatId: number;
                threadId: number;
            };
        } | undefined;
        getSessionReplacementIntent: () => TelegramSessionReplacementIntent | undefined;
        commitSessionReplacementIntent: (intent: TelegramSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
        removeSessionReplacementIntent: (intent: TelegramSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
    };
    getProfileName: () => string | undefined;
    ownsPersistence: () => boolean;
    sendResult: (target: {
        chatId: number;
        threadId?: number;
    }, html: string) => Promise<{
        ok: boolean;
        retryable?: boolean;
    }>;
    handoffTtlMs: number;
    now?: () => number;
    recordRuntimeEvent?: (category: string, error: unknown) => void;
}
export declare function createTelegramSessionActionAssembly(deps: TelegramSessionActionAssemblyDeps): {
    action: TelegramSessionActionRuntime;
    settlement: {
        onSessionStart: (ctx: Pi.ExtensionContext) => void;
    };
};
export interface TelegramSessionActionRuntime {
    register: () => void;
    scheduleAfterUpdate: (updateId: number, target: {
        chatId: number;
        threadId?: number;
        messageId: number;
    }) => boolean;
    onUpdateCompleted: (updateId: number) => void;
    hasPending: () => boolean;
}
export declare function createTelegramSessionActionRuntime(deps: TelegramSessionActionRuntimeDeps): TelegramSessionActionRuntime;
export {};
