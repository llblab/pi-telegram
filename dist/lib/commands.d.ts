/**
 * Telegram command routing helpers
 * Zones: telegram controls, pi agent commands, queue controls
 * Owns Telegram slash-command normalization, bot command metadata, pi-side command registration, and command-initiated session replacement orchestration behind runtime ports
 */
import type { TelegramActivityPublicationWork } from "./activity.ts";
import { type TelegramConfigStore } from "./config.ts";
import type * as Pi from "./pi.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi.ts";
import type { TelegramPromptTemplateCommand } from "./prompt-templates.ts";
import { createTelegramControlItemBuilder, type PendingTelegramControlItem, type TelegramControlQueueController, type TelegramControlQueueControllerDeps, type TelegramQueueAdmissionReceipt } from "./queue.ts";
import { type TelegramBridgeStatusLineOptions } from "./status.ts";
import { type TelegramApiCallOptions } from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import type { TelegramSessionReplacementIntent } from "./threads.ts";
import { type TelegramDeferredSourceEvidence, type TelegramLiveSourceCompletionReadiness, type TelegramQueueAdmissionReceiptLike } from "./updates.ts";
export type TelegramHeldCommandName = "status" | "start" | "help" | "abort" | "stop" | "next" | "continue";
/** Commands-owned no-fold admission over the ordinary recipient queue; source reporting stays separate from removal. */
export interface TelegramHeldTurnAdmission {
    assertCurrent(): void;
    report(receipts: readonly TelegramQueueAdmissionReceiptLike[]): void;
}
export interface TelegramPreparedHeldCommand {
    readonly source: TelegramDeferredSourceEvidence;
    readonly command: ParsedTelegramCommand;
    bindCarrier(value: unknown): boolean;
    execute(): Promise<boolean>;
    /** Source disposal only, independent of detached delivery and ended source-execution/chooser callbacks. */
    inspectCompletion(): TelegramDeferredSourceEvidence | undefined;
}
/** Saved-original admission for a held follower plan: fixed target plus independent source and recipient lifetimes. */
export interface TelegramHeldCommandAdmission {
    target: {
        chatId: number;
        threadId: number;
    };
    assertSourceCurrent(): void;
    assertRecipientCurrent(): void;
}
/** Recipient-scoped reply sender; the plan never falls back to ordinary follower API delivery. */
export interface TelegramHeldCommandReply {
    sendTextReply(chatId: number, replyToMessageId: number, text: string, options: {
        parseMode?: "HTML";
        target: {
            chatId: number;
            threadId: number;
        };
        assertAuthority: () => void;
    }): Promise<unknown>;
}
/** Captured recipient effects; a supplied but unavailable effect never falls back to ordinary dispatch. */
export type TelegramHeldCommandEffects<TContext> = Partial<TelegramHeldCommandReply & Pick<TelegramCommandHandlerTargetRuntimeDeps<TelegramCommandRuntimeMessage, TContext>, "showStatus">>;
export interface ParsedTelegramCommand {
    name: string;
    args: string;
}
/** Exact singleton operator-private text command original eligible for a held follower plan. */
export declare function isTelegramSelectedHeldOriginal(update: unknown, target: {
    chatId: number;
    threadId: number;
}, operator: number | undefined, name: string): boolean;
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
export interface SelectedPreparationInput {
    readonly name: string;
    readonly args: string;
}
export interface SelectedCommandExecution {
    /** Recheck before producer mutations and after awaits; this is a trusted contract, not a sandbox. */
    assertCurrent(): void;
    /** Acceptance of semantic completion only, never a source-removal ACK or delivery/cleanup proof. */
    reportCompleted(): boolean;
    /** Queue detached recipient text without waiting for delivery as semantic completion. */
    reply(text: string): void;
}
export type PreparedSelectedCommand = {
    kind: "command-only";
    execute(ctx: SelectedCommandExecution): void | Promise<void>;
} | {
    kind: "generated-prompt";
    prompt: string;
};
export interface TelegramExtensionCommandRegistration {
    name: string;
    description?: string;
    order?: number;
    showInMenu?: boolean;
    emoji?: string;
    handler: (ctx: TelegramExtensionCommandContext) => Promise<void> | void;
    /** Trusted side-effect-free plan preparation for single-message leader selection; ordinary dispatch still uses handler. */
    selected?: {
        prepare(input: SelectedPreparationInput): PreparedSelectedCommand | undefined | Promise<PreparedSelectedCommand | undefined>;
    };
}
interface RegisteredTelegramExtensionCommand {
    name: string;
    description?: string;
    order: number;
    showInMenu: boolean;
    emoji?: string;
    handler: TelegramExtensionCommandRegistration["handler"];
    selected?: Readonly<TelegramExtensionCommandRegistration["selected"]>;
}
export declare function registerTelegramCommand(registration: TelegramExtensionCommandRegistration): () => void;
export declare function findTelegramExtensionCommand(name: string | undefined): RegisteredTelegramExtensionCommand | undefined;
/** Preparation only: no execution, admission, source freeze or binding effects. Routing owns those later. */
export declare function prepareTelegramSelectedExtensionCommand(command: ParsedTelegramCommand, authority: {
    assertSourceCurrent(): void;
    assertRecipientCurrent(): void;
}): Promise<{
    plan: Readonly<PreparedSelectedCommand>;
    assertRegistrationCurrent(): void;
} | undefined>;
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
export declare function formatTelegramCommandEmojiPrefix(command: TelegramCommandEmojiName): string;
export declare function formatTelegramPiCommandHtml(command: string): string;
export declare function formatTelegramInformationHeading(emoji: string, text: string): string;
export declare function formatTelegramInvalidInstanceName(validationError: string): string;
export declare function formatTelegramThreadDisplayNameSavedHeading(name: string): string;
export declare function formatTelegramAutomaticThreadDisplayNameRestoredHeading(name: string): string;
export declare const TELEGRAM_COMPACTION_STARTED_MARKDOWN: string;
export declare const TELEGRAM_COMPACTION_COMPLETED_MARKDOWN = "**\u2705 Compaction completed.**";
export declare const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommandDefinition[];
export declare function getTelegramReservedCommandNames(): string[];
export interface TelegramBotCommandRegistrationDeps {
    setMyCommands: (commands: readonly TelegramBotCommandDefinition[], options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<unknown>;
}
export declare function registerTelegramBotCommands(deps: TelegramBotCommandRegistrationDeps, options?: Pick<TelegramApiCallOptions, "assertAuthority">): Promise<void>;
export declare function createTelegramBotCommandRegistrar(deps: TelegramBotCommandRegistrationDeps): (options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
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
export interface TelegramBridgeCommandRegistrationDeps {
    handleInternalAction?: TelegramSessionActionRuntime["handleInternalAction"];
    promptForConfig: (ctx: ExtensionCommandContext, profileName?: string) => Promise<void>;
    getStatusLines: (options?: TelegramBridgeStatusLineOptions) => string[];
    reloadConfig: () => Promise<void>;
    hasBotToken: () => boolean;
    getBotTokenDiagnostic?: () => string | undefined;
    startPolling: (ctx: ExtensionCommandContext, options?: TelegramBridgeCommandStartPollingOptions) => void | Promise<void | TelegramBridgeCommandStartPollingResult> | TelegramBridgeCommandStartPollingResult;
    stopPolling: () => Promise<void | string>;
    recordConnectionEvent?: (error: unknown, phase: string) => void;
    getDisconnectThreadName?: () => string | undefined;
    queueAgentConnectionContext?: (connected: boolean) => void;
    updateStatus: (ctx: ExtensionCommandContext) => void;
    isContextCurrent?: (ctx: ExtensionCommandContext) => boolean;
    getSessionGeneration?: () => number;
    connectionIntent?: {
        begin(cwd: string, profileName?: string): string;
        finish(id: string): void;
        isActive(id: string): boolean;
        cancel(): void;
    };
    getProfileNames?: () => string[];
    getActiveProfileName?: () => string | undefined;
    activateDefaultProfileConfig?: (ctx: ExtensionCommandContext, isCurrent: () => boolean) => Promise<void>;
    activateProfileConfig?: (ctx: ExtensionCommandContext, profileName: string, isCurrent: () => boolean) => Promise<boolean>;
}
/** Bound adapters must carry the optional recipient guard through their own effect/publication awaits. */
export type TelegramThreadDisplayNameRenamePort = (target: {
    chatId: number;
    threadId?: number;
}, threadName: string, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<{
    ok: boolean;
    threadName?: string;
    message?: string;
}>;
/** Reset adapters must preserve the same optional recipient lifetime as manual rename adapters. */
export type TelegramThreadDisplayNameResetPort = (target: {
    chatId: number;
    threadId?: number;
}, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<{
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
export interface TelegramProfileCompletionItem {
    value: string;
    label: string;
    description?: string;
}
export declare function getTelegramProfileCompletions(deps: Pick<TelegramBridgeCommandRegistrationDeps, "getProfileNames" | "getActiveProfileName">, argumentPrefix: string): TelegramProfileCompletionItem[] | null;
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
/** Pi or Telegram work that must drain before a session-level command may replace or compact the session. */
export interface TelegramSessionBusyPorts {
    isIdle: () => boolean;
    hasPendingMessages: () => boolean;
    hasActiveTelegramTurn: () => boolean;
    hasDispatchPending: () => boolean;
    hasQueuedTelegramItems: () => boolean;
    isCompactionInProgress: () => boolean;
}
export interface TelegramCompactCommandDeps extends TelegramRuntimeEventRecorderPort, TelegramSessionBusyPorts {
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
        assertAuthority?: TelegramApiCallOptions["assertAuthority"];
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
        is_bot?: boolean;
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
    /** Ordinary reply destination selected before publication, not resend authority. */
    getReplyTarget?: (message: TelegramCommandRuntimeMessage) => TelegramTarget | undefined;
    onControlQueued?: (message: TelegramCommandRuntimeMessage, receipt: TelegramQueueAdmissionReceipt) => void;
    showStatus: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openModelMenu: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu?: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    sendTextReply: (chatId: number, replyToMessageId: number | undefined, text: string, options?: {
        parseMode?: "HTML";
        target?: {
            chatId: number;
            threadId?: number;
        };
        assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    }) => Promise<unknown>;
}
export interface TelegramCommandTargetRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext> {
    enqueueControlItem: (message: TMessage, ctx: TContext, controlType: TelegramControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>) => void;
    showStatus: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openModelMenu: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    sendTextReply: (message: TMessage, text: string, options?: {
        parseMode?: "HTML";
        assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    }) => Promise<void>;
}
export declare function getTelegramCommandMessageTarget(message: TelegramCommandRuntimeMessage): TelegramCommandMessageTarget;
export declare function createTelegramCommandControlEnqueueAdapter<TContext>(deps: {
    createControlItem: ReturnType<typeof createTelegramControlItemBuilder<TContext>>;
    enqueueControlItem: TelegramControlQueueController<TContext>["enqueue"];
}): TelegramCommandTargetRuntimeDeps<TContext>["enqueueControlItem"];
export type TelegramCommandTargetQueueRuntimeDeps<TContext> = TelegramControlQueueControllerDeps<TContext> & {
    createControlItem: ReturnType<typeof createTelegramControlItemBuilder<TContext>>;
} & Omit<TelegramCommandTargetRuntimeDeps<TContext>, "enqueueControlItem">;
export declare function createTelegramCommandTargetQueueRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandTargetQueueRuntimeDeps<TContext>): TelegramCommandTargetRuntime<TMessage, TContext>;
export declare function createTelegramCommandTargetRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandTargetRuntimeDeps<TContext>): TelegramCommandTargetRuntime<TMessage, TContext>;
export interface TelegramCommandOrPromptDispatcherDeps<TMessage, TContext> {
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
interface TelegramCommandEffectWorkPort {
    beginCommandEffectWork?: () => TelegramActivityPublicationWork;
}
export interface TelegramCommandRuntimeDeps<TMessage extends TelegramCommandRuntimeMessage, TContext> extends TelegramRuntimeEventRecorderPort, TelegramCommandEffectWorkPort {
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
    heldTurn?: {
        enqueue(message: TMessage, ctx: TContext, kind: "continue" | "prompt", admission: TelegramHeldTurnAdmission): Promise<void>;
        templates?: {
            getCommands(): readonly TelegramPromptTemplateCommand[];
            expand(name: string, args: string): string | undefined;
        };
    };
    requestNewSession?: (message: TMessage) => void;
    compact: (ctx: TContext, callbacks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
    }) => void;
    enqueueControlItem: (message: TMessage, ctx: TContext, controlType: TelegramControlCommandType, statusSummary: string, execute: (ctx: TContext) => Promise<void>) => void;
    showStatus: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    /** Supplied adapters must forward recipient authority into issuance and recheck it after awaits. */
    handleForumBootstrap?: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<string | undefined>;
    openModelMenu: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openThinkingMenu: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openQueueMenu: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu?: (message: TMessage, ctx: TContext, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    validateThreadName?: (threadName: string) => string | undefined;
    renameCurrentThread?: TelegramThreadDisplayNameRenamePort;
    resetCurrentThreadName?: TelegramThreadDisplayNameResetPort;
    openThreadNameDialog?: (message: TMessage, ctx: TContext, admission?: {
        assertSemanticCurrent(): void;
        assertRecipientCurrent(): void;
    }) => Promise<void | {
        assertPublished(): void;
    }>;
    getAllowedUserId: () => number | undefined;
    persistAllowedUserId: TelegramConfigStore["persistAllowedUserId"];
    registerBotCommands: (options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    getPromptTemplateCommands?: () => readonly TelegramPromptTemplateMenuCommand[];
    sendTextReply: (message: TMessage, text: string, options?: {
        parseMode?: "HTML";
        assertAuthority?: TelegramApiCallOptions["assertAuthority"];
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
export declare function openTelegramNewConfirmation(target: TelegramCommandMessageTarget, deps: TelegramCompactConfirmationDeps, assertAuthority?: TelegramApiCallOptions["assertAuthority"]): Promise<void>;
export declare function handleTelegramNewConfirmationCallback<TContext>(query: TelegramCompactConfirmationCallbackQuery, deps: TelegramNewConfirmationCallbackDeps<TContext>): Promise<boolean>;
export declare function handleTelegramCompactConfirmationCallback<TContext>(query: TelegramCompactConfirmationCallbackQuery, deps: TelegramCompactConfirmationCallbackDeps<TContext>): Promise<boolean>;
export interface TelegramNewCommandDeps extends TelegramRuntimeEventRecorderPort, TelegramSessionBusyPorts {
    requestNewSession?: () => void;
    sendTextReply: (text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<void>;
}
export declare function handleTelegramNewCommand(deps: TelegramNewCommandDeps): Promise<void>;
export declare function handleTelegramCompactCommand(deps: TelegramCompactCommandDeps): Promise<void>;
export declare function handleTelegramModelCommand<TContext>(deps: {
    ctx: TContext;
    openModelMenu: (ctx: TContext) => Promise<void>;
}): Promise<void>;
export declare function executeTelegramCommandAction<TMessage, TContext>(action: TelegramCommandAction, message: TMessage, ctx: TContext, deps: TelegramCommandActionDeps<TMessage, TContext>, commandArgs?: string): Promise<boolean>;
export interface TelegramCommandHandlerTargetRuntimeDeps<TMessage extends TelegramCommandRuntimeMessage, TContext> extends Omit<TelegramCommandRuntimeDeps<TMessage, TContext>, "enqueueControlItem" | "showStatus" | "openModelMenu" | "openSettingsMenu" | "sendTextReply" | "registerBotCommands">, Omit<TelegramCommandTargetQueueRuntimeDeps<TContext>, "createControlItem">, TelegramBotCommandRegistrationDeps {
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}
export declare function createTelegramCommandHandlerTargetRuntime<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandHandlerTargetRuntimeDeps<TMessage, TContext>): ReturnType<typeof createTelegramCommandHandler<TMessage, TContext>>;
/** Released exact-source admission for one selected command: source/recipient lifetimes and one completion report. */
export interface TelegramSelectedCommandAdmission {
    assertSourceCurrent(): void;
    /** Independent exact recipient/target lifetime, including inside captured menu transport adapters. */
    assertRecipientCurrent(): void;
    reportCompleted(): boolean;
    /** Optional recipient release barrier after acceptance; rejection suppresses effects without replay. */
    beforeEffects?(): Promise<void>;
}
export declare function createTelegramCommandHandler<TMessage extends TelegramCommandRuntimeMessage, TContext>(deps: TelegramCommandRuntimeDeps<TMessage, TContext>): ((commandName: string | undefined, message: TMessage, ctx: TContext, commandArgs?: string) => Promise<boolean>) & {
    /** Command-only producer execution; Routing must supply the captured plan and released exact-source authority. */
    prepareSelectedExtensionCommand(prepared: NonNullable<Awaited<ReturnType<typeof prepareTelegramSelectedExtensionCommand>>>, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission): (() => Promise<void>) | undefined;
    /** Selected help/start require the existing authenticated owner; cold pairing remains ordinary first contact. */
    prepareSelectedStartCommand: (command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    prepareSelectedHelpCommand: (command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Selected new handles only confirmation; the later authenticated callback owns replacement admission. */
    prepareSelectedNewCommand: (command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Selected compaction handles only confirmation; the later authenticated callback owns actual compaction. */
    prepareSelectedCompactCommand: (command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Bare naming completes only after the exact dialog owner confirms current publication, not delivery alone. */
    prepareSelectedNameDialogCommand(command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission): (() => Promise<boolean>) | undefined;
    /** Explicit naming retains source authority until its owner result; bare dialogs use their own publication leaf. */
    prepareSelectedNameCommand(command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission): (() => Promise<boolean>) | undefined;
    /** Genuine leader originals capture their warm queue owner before release; no hold copy or semantic-completion report. */
    prepareSelectedQueueCommand(command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramHeldCommandAdmission): Omit<TelegramPreparedHeldCommand, "bindCarrier"> | undefined;
    /** Selected leaders reuse registry semantics; native source/recipient admission and inline transport remain role-owned. */
    prepareSelectedCommand: (command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission) => (() => Promise<boolean>) | undefined;
    /** Existing native publication boundary; unrelated/legacy receipts keep their ordinary owner. */
    prepareHeldQueueReceipt: (receipt: TelegramQueueAdmissionReceipt, queueOwner: import("./journal.ts").TelegramUpdateJournalQueueOwner, context: TContext, isWorkerCurrent: () => boolean) => import("./updates.ts").TelegramQueueSourceCompletion[] | undefined;
    /** Pure registry/effect availability; never reads a source or activates future recipient authority. */
    canPrepareHeldCommand(name: string, effects?: TelegramHeldCommandEffects<TContext>): boolean;
    /** Compile one registry plan from a saved original; no admission, recipient activation or update-handler replay. */
    prepareHeldCommand(name: string, readiness: TelegramLiveSourceCompletionReadiness, ctx: TContext, admission: TelegramHeldCommandAdmission, effects?: TelegramHeldCommandEffects<TContext>): TelegramPreparedHeldCommand | undefined;
    /** Warm menu-only issuance; completion reporting is not a receipt or a durable removal ACK. */
    prepareSelectedMenuCommand(command: ParsedTelegramCommand, messages: readonly TMessage[], ctx: TContext, admission: TelegramSelectedCommandAdmission): (() => Promise<boolean>) | undefined;
};
export declare function createTelegramCommandOrPromptDispatcher<TMessage, TContext>(deps: TelegramCommandOrPromptDispatcherDeps<TMessage, TContext>): (messages: TMessage[], ctx: TContext) => Promise<void>;
export declare const TELEGRAM_CONNECT_COMMAND_NAME = "telegram-connect";
export declare const TELEGRAM_INTERNAL_COMMAND_FLAG = "--internal";
export declare const TELEGRAM_INTERNAL_MANUAL_USE_MESSAGE = "This internal Telegram action cannot be run manually.";
export interface TelegramSessionActionRuntimeDeps {
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
export interface TelegramSessionActionAssemblyDeps {
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
    /**
     * Registered-follower port. A follower cannot persist leader-owned state, so
     * its Workspace Thread intent is published and claimed by the leader over
     * authenticated generation-fenced bus RPC.
     */
    follower?: {
        instanceId: string;
        isRegisteredFor: (target: {
            chatId: number;
            threadId?: number;
        }) => boolean;
        requestSessionReplacement: (operation: "publish" | "settle", intent: TelegramSessionReplacementIntent) => Promise<boolean>;
    };
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
    handleInternalAction: (args: string, ctx: Pi.ExtensionCommandContext) => Promise<void>;
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
