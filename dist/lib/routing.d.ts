/**
 * Telegram inbound routing composition
 * Zones: telegram inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing, and owns exact assistant-output target/route authority capture
 */
import * as Bus from "./bus.ts";
import * as Commands from "./commands.ts";
import type { TelegramConfigStore } from "./config.ts";
import type { TelegramInboundHandlerRuntime } from "./inbound.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Queue from "./queue.ts";
import type { TelegramBridgeRuntime } from "./runtime.ts";
import type { TelegramSectionRegistry } from "./sections.ts";
import type { TelegramInputRichMessage } from "./telegram-api.ts";
import * as TextGroups from "./text-groups.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import type { TelegramInstanceThreadIdentityCandidate, TelegramTopicTargetRecord } from "./threads.ts";
import * as Turns from "./turns.ts";
interface TelegramPromptPeerView {
    id?: unknown;
    is_bot?: unknown;
    username?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    title?: unknown;
}
export declare function resolveTelegramGuestPromptPeer(input: {
    chatType?: string;
    chat?: TelegramPromptPeerView;
    from?: TelegramPromptPeerView;
    replyFrom?: TelegramPromptPeerView;
    guestBotCallerUser?: TelegramPromptPeerView;
    guestBotCallerChat?: TelegramPromptPeerView;
    ownerUserId?: number;
}): string | undefined;
import * as Threads from "./threads.ts";
import * as Updates from "./updates.ts";
export declare const TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS: number;
export declare function isTelegramAllTabCommandExpired(message: {
    date?: number;
    message_thread_id?: number;
}, nowMs?: number): boolean;
export type TelegramRoutedMessage = {
    date?: number;
} & Updates.TelegramUpdateMessage & Media.TelegramMediaMessage & Media.TelegramMediaGroupMessage & Commands.TelegramCommandRuntimeMessage & Turns.TelegramTurnMessage;
export type TelegramRoutedCallbackQuery = Updates.TelegramCallbackQuery & Menu.MenuCallbackQuery;
export interface TelegramInboundBusProjectionRuntime {
    getTargetOwnership: Updates.TelegramTargetOwnershipLookup;
    getLiveThreadTargets(): Queue.TelegramQueueTarget[];
    getLocalThreadLabelForTarget(target: Queue.TelegramQueueTarget): string | undefined;
}
export declare function createTelegramInboundBusProjectionRuntime(deps: {
    instanceId: string;
    listFollowers(): readonly Bus.TelegramBusFollowerView[];
    listThreadRecords(): readonly TelegramTopicTargetRecord[];
    getLeaderTarget(): Queue.TelegramQueueTarget | undefined;
    isFollowerRegistered(): boolean;
    getFollowerTarget(): Queue.TelegramQueueTarget | undefined;
    getCurrentIdentity(target?: Queue.TelegramQueueTarget): TelegramInstanceThreadIdentityCandidate;
}): TelegramInboundBusProjectionRuntime;
export interface TelegramInboundRouteRuntimeDeps<TMessage extends TelegramRoutedMessage, TCallbackQuery extends TelegramRoutedCallbackQuery, TContext, TModel extends Model.MenuModel> {
    configStore: Pick<TelegramConfigStore, "get" | "getAllowedUserId" | "persistAllowedUserId" | "persist"> & {
        set?: TelegramConfigStore["set"];
    };
    callApi?: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    getCurrentInstanceId?: () => string | undefined;
    getAdmissionScope?: () => string | undefined;
    getAdmissionJournalBinding?: () => string | undefined;
    getMessageOwnership?: Updates.TelegramMessageOwnershipLookup;
    getTargetOwnership?: Updates.TelegramTargetOwnershipLookup;
    recordMessageOwnership?: Updates.TelegramMessageOwnershipRecorder;
    getLiveThreadTargets?: () => Queue.TelegramQueueTarget[];
    getDisplayTitle?: Threads.TelegramCurrentThreadAssembly["getDisplayTitle"];
    getLocalThreadLabelForTarget?: (target: Queue.TelegramQueueTarget) => string | undefined;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    setCurrentLeaderIdentity?: (identity: {
        target: Queue.TelegramQueueTarget;
        slot?: string;
        threadName?: string;
    }) => void;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    handleTelegramTopicLifecycleUpdate?: (lifecycle: Updates.TelegramTopicLifecycleUpdate<TMessage>, ctx: TContext) => Promise<void> | void;
    handleTelegramThreadTargetObserved?: (target: Threads.TelegramTopicTargetRecord["target"], ctx: TContext) => Promise<void> | void;
    foreignOwnedUpdateForwarder?: Updates.TelegramForeignOwnedUpdateForwarder<TContext, Updates.TelegramMessageReactionUpdated, TCallbackQuery, TMessage>;
    replaceFollowerThreadTarget?: (input: {
        record: Threads.TelegramTopicTargetRecord;
        target: Threads.TelegramTopicTargetRecord["target"];
        oldTarget: Threads.TelegramTopicTargetRecord["target"];
    }) => Promise<boolean>;
    bridgeRuntime: TelegramBridgeRuntime;
    activeTurnRuntime: Queue.TelegramActiveTurnStore;
    mediaGroupRuntime: Media.TelegramMediaGroupController<TMessage, TContext>;
    textGroupRuntime: TextGroups.TelegramTextGroupController<TMessage, TContext>;
    telegramQueueStore: Queue.TelegramQueueStateStore<TContext>;
    queueMutationRuntime: Queue.TelegramQueueMutationController<TContext>;
    modelMenuRuntime: Menu.TelegramModelMenuRuntime<TModel>;
    currentModelRuntime: Model.CurrentModelRuntime<TContext, TModel>;
    modelSwitchController: Model.TelegramModelSwitchController<TContext, Model.ScopedTelegramModel<TModel>>;
    menuActions: Menu.TelegramMenuActionRuntime<TContext, TModel>;
    updateSettingsMenuMessage?: (state: Menu.TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    openQueueMenu: (chatId: number, replyToMessageId: number, ctx: TContext) => Promise<void>;
    openSettingsMenu?: (chatId: number, replyToMessageId: number, ctx: TContext) => Promise<void>;
    settingsMenuCallbackHandler?: (query: TCallbackQuery, ctx: TContext) => Promise<boolean>;
    queueMenuCallbackHandler: (query: TCallbackQuery, ctx: TContext) => Promise<boolean>;
    buttonActionStore?: OutboundHandlers.TelegramButtonActionStore;
    invokeBoundButtonAction?: (action: OutboundHandlers.TelegramOutboundButtonAction, query: TCallbackQuery, ctx: TContext) => Promise<false | "new" | "edit">;
    inboundHandlerRuntime: TelegramInboundHandlerRuntime<TContext>;
    threadStore?: Threads.TelegramTopicTargetStore;
    runWorkspaceOperation?: <T>(input: {
        operationId: string;
        operationKind: string;
        scopes: readonly [{
            kind: "profile";
        }];
    }, operation: () => Promise<T>) => Promise<T>;
    updateStatus: (ctx: TContext, error?: string) => void;
    isContextActive?: (ctx: TContext) => boolean;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
    requestNextDispatchAnnouncement?: () => void;
    cancelNextDispatchAnnouncement?: () => void;
    requestDeferredDispatchNextQueuedTelegramTurn?: (dispatch: (ctx: TContext) => void) => void;
    hasDeferredDispatchContext?: () => boolean;
    startTypingLoop?: (ctx: TContext, chatId?: number, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => void;
    stopTypingLoop?: () => void;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    editInteractiveMessage?: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: Menu.TelegramReplyMarkup) => Promise<void>;
    editMessageReplyMarkup?: (chatId: number, messageId: number, replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup) => Promise<void>;
    sendInteractiveMessage?: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: Menu.TelegramReplyMarkup, options?: {
        target?: Queue.TelegramQueueTarget;
        replyToMessageId?: number;
    }) => Promise<number | undefined>;
    deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string) => Promise<void>;
    /** Answers the guest query immediately and returns its inline message id. */
    answerGuestQueryForInlineMessage?: (guestQueryId: string, text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<string | undefined>;
    /** Starts the animated placeholder on an answered guest inline message. */
    startGuestPlaceholder?: (inlineMessageId: string) => void;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        parseMode?: "HTML";
        target?: Queue.TelegramQueueTarget;
    }) => Promise<number | undefined>;
    setMyCommands: Commands.TelegramBotCommandRegistrationDeps["setMyCommands"];
    validateThreadName?: (threadName: string) => string | undefined;
    renameCurrentThread?: Commands.TelegramThreadDisplayNameRenamePort;
    resetCurrentThreadName?: Commands.TelegramThreadDisplayNameResetPort;
    getCommands: () => Parameters<typeof PromptTemplates.getTelegramPromptTemplateCommands>[0];
    downloadFile: Media.DownloadTelegramMessageFilesDeps["downloadFile"];
    resolveTimeLine?: (chatId: number) => string | null;
    getThinkingLevel: () => Model.ThinkingLevel;
    setThinkingLevel: (level: Model.ThinkingLevel) => void;
    persistScopedModelPatterns?: (patterns: string[], ctx: TContext) => Promise<void>;
    setModel: (model: TModel) => Promise<boolean>;
    sendUserMessage?: (message: string, options?: Queue.TelegramPromptDeliveryOptions) => void;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
    requestNewSession?: (source: unknown) => void;
    compact: (ctx: TContext, callbacks: {
        onComplete: () => void;
        onError: (error: unknown) => void;
    }) => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    sectionRegistry?: TelegramSectionRegistry;
    sendSectionRichMessage?: (chatId: number, message: TelegramInputRichMessage, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
}
export declare function createTelegramInboundRouteRuntime<TUpdate extends Updates.TelegramUpdateFlow & {
    message?: TMessage;
    edited_message?: TMessage;
    callback_query?: TCallbackQuery;
}, TMessage extends TelegramRoutedMessage, TCallbackQuery extends TelegramRoutedCallbackQuery, TContext, TModel extends Model.MenuModel>(deps: TelegramInboundRouteRuntimeDeps<TMessage, TCallbackQuery, TContext, TModel>): Updates.TelegramUpdateRuntimeController<TContext, TUpdate>;
export interface TelegramAssistantOutputAuthority<TTransportStamp> {
    transportStamp: TTransportStamp;
    route: "direct" | "follower" | "none";
    directEpoch?: number | string;
    followerGeneration?: string;
    target?: Queue.TelegramQueueTarget;
}
export interface TelegramAssistantOutputAuthorityRuntime<TTransportStamp> {
    captureAuthority: () => TelegramAssistantOutputAuthority<TTransportStamp>;
    isAuthorityActive: (authority: TelegramAssistantOutputAuthority<TTransportStamp>) => boolean;
    canDeliver: () => boolean;
}
export declare function createTelegramAssistantOutputAuthorityRuntime<TTransportStamp>(deps: {
    getPreferredTarget: () => Queue.TelegramQueueTarget | undefined;
    getFallbackChatId: () => number | undefined;
    getTransportStamp: () => TTransportStamp;
    isTransportStampActive: (stamp: TTransportStamp) => boolean;
    ownsDirect: () => boolean;
    getDirectEpoch: () => number | string | undefined;
    isFollowerRegistered: () => boolean;
    getFollowerGeneration: () => string | undefined;
}): TelegramAssistantOutputAuthorityRuntime<TTransportStamp>;
export {};
