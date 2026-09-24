/**
 * Telegram bridge binding composition
 * Zones: telegram, pi agent, orchestration
 * Owns pi-facing tool, command, and lifecycle hook registration for the entrypoint
 */
import * as Activity from "./activity.ts";
import * as ActivityVerbosity from "./activity-verbosity.ts";
import * as ChannelPosts from "./channel-posts.ts";
import * as Commands from "./commands.ts";
import * as Config from "./config.ts";
import * as Keyboard from "./keyboard.ts";
import * as Lifecycle from "./lifecycle.ts";
import * as Locks from "./locks.ts";
import * as Model from "./model.ts";
import * as OutboundAttachments from "./outbound-attachments.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as Pi from "./pi.ts";
import * as Preview from "./preview.ts";
import * as Prompts from "./prompts.ts";
import * as Queue from "./queue.ts";
import * as Routing from "./routing.ts";
import * as Runtime from "./runtime.ts";
import * as Setup from "./setup.ts";
import * as Status from "./status.ts";
import * as TelegramApi from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import * as GenerativeApps from "./generative-apps.ts";
type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;
type TelegramRuntimeEventRecorder = (category: string, error: unknown, details?: Record<string, unknown>) => void;
type TelegramBridgeStatusUpdater = Status.TelegramStatusRuntime<Pi.ExtensionContext>["updateStatus"];
type TelegramAgentTargetResolver = NonNullable<OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["resolveAgentTarget"]>;
type TelegramAgentMessageRouter = NonNullable<OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["routeAgentMessage"]>;
export interface TelegramQueueBindingRuntime<TContext> {
    mutation: Queue.TelegramQueueMutationController<TContext>;
    dispatchNext: (ctx: TContext) => void;
    requestNextDispatchAnnouncement: () => void;
    cancelNextDispatchAnnouncement: () => void;
    watchdog: Queue.TelegramQueueDispatchWatchdogRuntime<TContext>;
}
export declare function createTelegramQueueBindingRuntime<TContext>(deps: {
    store: Queue.TelegramQueueStateStore<TContext>;
    queue: Pick<Runtime.TelegramBridgeRuntime["queue"], "allocateItemOrder">;
    lifecycle: Pick<Runtime.TelegramBridgeRuntime["lifecycle"], "isCompactionInProgress" | "hasDispatchPending">;
    activeTurn: Pick<Queue.TelegramActiveTurnStore, "has">;
    admission: {
        getSettlement: () => {
            onItemsDiscarded: (items: readonly Queue.TelegramQueueItem<TContext>[], ctx: TContext) => boolean;
            isItemReady: (item: Queue.TelegramQueueItem<TContext>) => boolean;
            onPromptHandedOff?: (item: Queue.PendingTelegramTurn, ctx: TContext) => boolean;
            onControlSettled: (item: Queue.PendingTelegramControlItem<TContext>, ctx: TContext) => void;
        } | undefined;
        hasPendingQueueMutationForItem: (item: Queue.TelegramQueueItem<TContext>) => boolean;
    };
    transportStamp: Pick<Queue.TelegramTransportStampRuntime, "isActive">;
    deferredDispatch: Pick<Queue.TelegramDeferredQueueDispatchRuntime<TContext>, "isBound" | "getGeneration" | "isGenerationActive">;
    promptDispatch: Runtime.TelegramPromptDispatchRuntime<TContext>;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
    updateStatus: (ctx: TContext, error?: string) => void;
    sendTextReply: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendTextReply"];
    sendUserMessage: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendUserMessage"];
    reconcileNextDispatchAnnouncementReplyOwnership?: (item: Queue.PendingTelegramTurn) => void;
    recordRuntimeEvent?: TelegramRuntimeEventRecorder;
}): TelegramQueueBindingRuntime<TContext>;
export interface TelegramGenerativeAppLiveSurfaceBinding {
    get: () => GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle> | undefined;
    set: (runtime: GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle> | undefined) => void;
    shutdown: () => void;
}
export declare function createTelegramGenerativeAppLiveSurfaceBinding(): TelegramGenerativeAppLiveSurfaceBinding;
export declare function createTelegramGenerativeAppBoundButtonActionInvoker<TQuery extends {
    message?: {
        chat?: {
            id?: number;
        };
        message_id?: number;
        message_thread_id?: number;
    };
}>(deps: {
    agentDir: string;
    assertExecutionCurrent: (query: TQuery) => void;
    getExecutionFence: (query: TQuery) => GenerativeApps.GenerativeAppExecutionFence | undefined;
    getActiveProfileName?: () => string | undefined;
    getLiveSurfaceRuntime?: () => GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle> | undefined;
    planOutput: ReturnType<typeof OutboundHandlers.createTelegramOutboundReplyPlanner>;
    sendMarkdownReply: (chatId: number, replyToMessageId: number, markdown: string, options?: {
        replyMarkup?: OutboundHandlers.TelegramOutboundButtonMarkup;
    }) => Promise<unknown>;
    editInteractiveMessage?: (chatId: number, messageId: number, markdown: string, mode: "markdown", replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup) => Promise<void>;
    recordRuntimeEvent: TelegramRuntimeEventRecorder;
}): (action: OutboundHandlers.TelegramOutboundButtonAction, query: TQuery) => Promise<false | "new" | "edit">;
export interface TelegramAgentMessageToolRoutingRuntime {
    resolveAgentTarget: TelegramAgentTargetResolver;
    routeAgentMessage: TelegramAgentMessageRouter;
    canSendDirect: () => boolean;
}
export declare function createTelegramAgentMessageToolRoutingRuntime(deps: {
    ownsLeader: () => boolean;
    ownsDirectDelivery: () => boolean;
    isFollowerRegistered: () => boolean;
    getSourceTarget: () => TelegramTarget | undefined;
    getSourceThreadName: () => string | undefined;
    local: {
        resolveTarget: (selector: Parameters<TelegramAgentTargetResolver>[0], sourceTarget?: TelegramTarget) => Awaited<ReturnType<TelegramAgentTargetResolver>> | undefined;
        route: (input: {
            sourceTarget?: TelegramTarget;
            sourceThreadName?: string;
            message: Parameters<TelegramAgentMessageRouter>[0];
        }) => Promise<void>;
    };
    follower: {
        resolveTarget: TelegramAgentTargetResolver;
        routeMessage: TelegramAgentMessageRouter;
    };
}): TelegramAgentMessageToolRoutingRuntime;
export interface TelegramAssistantOutputBindingRuntime<TTransportStamp> {
    runtime: Activity.TelegramAssistantOutputRuntime;
    observeEvent: (event: Activity.TelegramActivityEvent) => void;
    authority: Routing.TelegramAssistantOutputAuthorityRuntime<TTransportStamp>;
}
export declare function createTelegramAssistantOutputBindingRuntime<TTransportStamp>(deps: {
    authority: {
        getPreferredTarget: () => OutboundAttachments.TelegramQueuedOutboundAttachmentTurnView["target"] | undefined;
        getFallbackChatId: () => number | undefined;
        getTransportStamp: () => TTransportStamp;
        isTransportStampActive: (stamp: TTransportStamp) => boolean;
        ownsDirect: () => boolean;
        getDirectEpoch: () => number | string | undefined;
        isFollowerRegistered: () => boolean;
        getFollowerGeneration: () => string | undefined;
    };
    sender: Parameters<typeof OutboundHandlers.createTelegramAssistantOutputSender<TTransportStamp>>[0];
    waitForActivityIdle?: () => Promise<void>;
    prepareTelegramPreview?: () => Activity.TelegramAssistantOutputPreparation | undefined;
    enqueue?: Activity.TelegramActivityPublicationRuntime["enqueue"];
    recordRuntimeEvent: TelegramRuntimeEventRecorder;
}): TelegramAssistantOutputBindingRuntime<TTransportStamp>;
type TelegramAssistantOutputAuthority<TTransportStamp> = ReturnType<Routing.TelegramAssistantOutputAuthorityRuntime<TTransportStamp>["captureAuthority"]>;
export interface TelegramBridgePublicationRuntime {
    enqueue: Activity.TelegramActivityPublicationRuntime["enqueue"];
    reserve: Activity.TelegramActivityPublicationRuntime["reserve"];
    capture: () => {
        target?: Queue.TelegramQueueTarget;
        isCurrent: () => boolean;
    };
}
export interface TelegramActivityBindingRuntime {
    publicationRuntime: TelegramBridgePublicationRuntime;
    activityRuntime: Activity.TelegramActivityRuntime;
    activityVerbosityRuntime: ActivityVerbosity.TelegramActivityVerbosityRuntime;
    assistantOutputRuntime: Activity.TelegramAssistantOutputRuntime;
}
/** Compose public activity fanout, verbosity, and assistant output ordering. */
export declare function createTelegramActivityBindingRuntime<TTransportStamp>(deps: {
    generation: string;
    assistantOutput: Omit<Parameters<typeof createTelegramAssistantOutputBindingRuntime<TTransportStamp>>[0], "waitForActivityIdle" | "enqueue">;
    activityVerbosity: Omit<Parameters<typeof ActivityVerbosity.createTelegramActivityVerbosityRuntime<TelegramAssistantOutputAuthority<TTransportStamp>>>[0], "captureAuthority" | "isAuthorityActive" | "recordFailure" | "enqueue">;
}): TelegramActivityBindingRuntime;
interface TelegramCommandsAndToolsBindingDeps {
    pi: Pi.ExtensionAPI;
    agentDir: string;
    configStore: Config.TelegramConfigStore;
    persistConfig: (config?: Config.TelegramConfig) => Promise<void>;
    setup: Setup.TelegramSetupGuard;
    activeTurnRuntime: Queue.TelegramActiveTurnStore<Queue.PendingTelegramTurn>;
    lockedPollingRuntime: Locks.TelegramLockedPollingRuntime<Pi.ExtensionContext>;
    stopPolling?: () => Promise<void | string>;
    recoverPollingStart?: Commands.TelegramBridgeCommandRegistrationDeps["recoverPollingStart"];
    getDisconnectThreadName?: () => string | undefined;
    onTransportChanged?: () => Promise<void> | void;
    getStatusLines: (options?: Status.TelegramBridgeStatusLineOptions) => string[];
    buttonActionStore: OutboundHandlers.TelegramButtonActionStore;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: unknown;
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    sendChannelMarkdownMessage: NonNullable<OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["sendChannelMarkdownMessage"]>;
    sendChannelMediaMessage: NonNullable<OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["sendChannelMediaMessage"]>;
    listChannelPosts: ChannelPosts.TelegramChannelPostJournalStore["list"];
    mutateChannelPost(input: {
        action: "edit" | "delete";
        operationId: string;
        mutationId: string;
        markdown?: string;
    }): Promise<ChannelPosts.TelegramChannelPostRecord>;
    callMultipart: OutboundHandlers.TelegramVoiceReplySenderDeps["sendMultipart"];
    getDefaultChatId: () => number | undefined;
    getDefaultTarget?: () => OutboundAttachments.TelegramQueuedOutboundAttachmentTurnView["target"];
    resolveAgentTarget?: OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["resolveAgentTarget"];
    routeAgentMessage?: OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["routeAgentMessage"];
    canSendDirect: () => boolean;
    setGenerativeAppLiveSurfaceRuntime?: (runtime: GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle> | undefined) => void;
    updateStatus: TelegramBridgeStatusUpdater;
    recordRuntimeEvent: TelegramRuntimeEventRecorder;
}
export declare function registerTelegramCommandsAndTools({ pi, agentDir, configStore, persistConfig, setup, activeTurnRuntime, lockedPollingRuntime, stopPolling, recoverPollingStart, getDisconnectThreadName, onTransportChanged, getStatusLines, buttonActionStore, sendMarkdownReply, sendChannelMarkdownMessage, sendChannelMediaMessage, listChannelPosts, mutateChannelPost, callMultipart, getDefaultChatId, getDefaultTarget, resolveAgentTarget, routeAgentMessage, canSendDirect, setGenerativeAppLiveSurfaceRuntime, recordRuntimeEvent, updateStatus, }: TelegramCommandsAndToolsBindingDeps): void;
interface TelegramLifecycleBindingDeps {
    pi: Pi.ExtensionAPI;
    publicationRuntime: TelegramBridgePublicationRuntime;
    activityRuntime: Activity.TelegramActivityRuntime;
    activityVerbosityRuntime?: ActivityVerbosity.TelegramActivityVerbosityRuntime;
    assistantOutputRuntime: Pick<Activity.TelegramAssistantOutputRuntime, "start" | "beginTurn" | "hasAdmittedTelegramIntermediate" | "waitForIdle" | "stop">;
    sessionLifecycleRuntime: Pick<Lifecycle.TelegramLifecycleRegistrationDeps, "onSessionStart" | "onSessionShutdown" | "onModelSelect">;
    configStore: Pick<Config.TelegramConfigStore, "get" | "getOutboundHandlers" | "hasBotToken" | "load">;
    abort: Runtime.TelegramRuntimeAbortPort;
    typing: Runtime.TelegramRuntimeTypingPort;
    lifecycle: Runtime.TelegramRuntimeLifecyclePort;
    activeTurnRuntime: Queue.TelegramActiveTurnStore<Queue.PendingTelegramTurn>;
    telegramQueueStore: Queue.TelegramQueueStore<Pi.ExtensionContext>;
    modelSwitchController: Model.TelegramModelSwitchController<Pi.ExtensionContext, Model.ScopedTelegramModel<ActivePiModel>>;
    previewRuntime: Preview.TelegramAssistantPreviewRuntime<Pi.AgentEndEvent["messages"][number], Keyboard.TelegramInlineKeyboardMarkup>;
    promptDispatchRuntime: Runtime.TelegramPromptDispatchRuntime<Pi.ExtensionContext>;
    deferredQueueDispatchRuntime: Queue.TelegramDeferredQueueDispatchRuntime<Pi.ExtensionContext>;
    modelContextAvailabilityRuntime: Prompts.TelegramModelContextAvailabilityRuntime;
    disconnectOnQuit?: () => Promise<unknown>;
    onSessionStarted?: (event: Pi.SessionStartEvent, ctx: Pi.ExtensionContext) => void;
    shutdownGenerativeAppLiveSurfaces?: () => void;
    resolveAutomaticThreadCleanupEnabled?: () => boolean | Promise<boolean>;
    buttonActionStore: OutboundHandlers.TelegramButtonActionStore;
    callMultipart: OutboundHandlers.TelegramVoiceReplySenderDeps["sendMultipart"];
    sendChatAction: NonNullable<OutboundHandlers.TelegramVoiceReplySenderDeps["sendChatAction"]>;
    sendRecordVoiceAction: NonNullable<OutboundHandlers.TelegramVoiceReplySenderDeps["sendRecordVoiceAction"]>;
    sendMarkdownReply: Queue.TelegramAgentEndHookRuntimeDeps<Queue.PendingTelegramTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.TelegramInlineKeyboardMarkup>["sendMarkdownReply"];
    sendTextReply: Queue.TelegramAgentEndHookRuntimeDeps<Queue.PendingTelegramTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.TelegramInlineKeyboardMarkup>["sendTextReply"] & NonNullable<OutboundHandlers.TelegramVoiceReplySenderDeps["sendTextReply"]>;
    dispatchNextQueuedTelegramTurn: (ctx: Pi.ExtensionContext) => void;
    onPromptHandedOff?: (turn: Queue.PendingTelegramTurn, ctx: Pi.ExtensionContext) => void;
    answerGuestQuery: TelegramApi.TelegramBridgeApiRuntime["answerGuestQuery"];
    deleteMessage: TelegramApi.TelegramBridgeApiRuntime["deleteMessage"];
    sendGuestReply: NonNullable<Queue.TelegramAgentEndHookRuntimeDeps<Queue.PendingTelegramTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.TelegramInlineKeyboardMarkup>["sendGuestReply"]>;
    editGuestReply?: Queue.TelegramAgentEndHookRuntimeDeps<Queue.PendingTelegramTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.TelegramInlineKeyboardMarkup>["editGuestReply"];
    stopGuestPlaceholder?: Queue.TelegramAgentEndHookRuntimeDeps<Queue.PendingTelegramTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.TelegramInlineKeyboardMarkup>["stopGuestPlaceholder"];
    preparePreviewDelivery?: Queue.TelegramAgentEndRuntimeDeps<Queue.PendingTelegramTurn>["preparePreviewDelivery"];
    finalizeMarkdownPreview: Queue.TelegramAgentEndHookRuntimeDeps<Queue.PendingTelegramTurn, Pi.ExtensionContext, Pi.AgentEndEvent["messages"][number], Keyboard.TelegramInlineKeyboardMarkup>["finalizeMarkdownPreview"];
    proactivePushTargetGetter: () => Queue.TelegramQueueTarget | undefined;
    getAssistantRenderingMode: () => "rich" | "html";
    recordMessageOwnership?: (input: {
        chatId: number;
        messageId: number;
        target?: Queue.TelegramQueueTarget;
    }) => void;
    canSendAgentActivity: (ctx: Pi.ExtensionContext) => boolean;
    isSessionContextActive: (ctx: Pi.ExtensionContext) => boolean;
    isTurnTransportActive?: (turn: Queue.PendingTelegramTurn) => boolean;
    updateStatus: TelegramBridgeStatusUpdater;
    recordRuntimeEvent: TelegramRuntimeEventRecorder;
}
export declare function registerTelegramLifecycleRuntimeHooks({ pi, publicationRuntime, activityRuntime, activityVerbosityRuntime, assistantOutputRuntime, sessionLifecycleRuntime, configStore, abort, typing, lifecycle, activeTurnRuntime, telegramQueueStore, modelSwitchController, previewRuntime, promptDispatchRuntime, deferredQueueDispatchRuntime, modelContextAvailabilityRuntime, disconnectOnQuit, onSessionStarted, shutdownGenerativeAppLiveSurfaces, resolveAutomaticThreadCleanupEnabled, buttonActionStore, callMultipart, sendChatAction, sendRecordVoiceAction, sendMarkdownReply, sendTextReply, dispatchNextQueuedTelegramTurn, onPromptHandedOff, answerGuestQuery, deleteMessage, sendGuestReply, editGuestReply, stopGuestPlaceholder, preparePreviewDelivery, finalizeMarkdownPreview, proactivePushTargetGetter, getAssistantRenderingMode, recordMessageOwnership, canSendAgentActivity, isSessionContextActive, isTurnTransportActive, updateStatus, recordRuntimeEvent, }: TelegramLifecycleBindingDeps): void;
export {};
