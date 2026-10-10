/**
 * Telegram inbound routing composition
 * Zones: telegram inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing, and owns exact assistant-output target/route authority capture
 */
import * as Bus from "./bus.ts";
import * as Commands from "./commands.ts";
import type { TelegramConfigStore } from "./config.ts";
import type { TelegramInboundHandlerRuntime } from "./inbound.ts";
import type { TelegramUpdateJournalQueuedCompletion, TelegramUpdateJournalQueuedReceiptEvidence } from "./journal.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Queue from "./queue.ts";
import type { TelegramBridgeRuntime } from "./runtime.ts";
import type { TelegramSectionRegistry } from "./sections.ts";
import type { TelegramApiCallOptions, TelegramInputRichMessage } from "./telegram-api.ts";
import * as TextGroups from "./text-groups.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import type { TelegramInstanceThreadIdentityCandidate, TelegramTopicTargetRecord } from "./threads.ts";
import * as Turns from "./turns.ts";
import type { createTelegramWorkspaceExternalProtectionCapture } from "./workspace-retirement.ts";
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
/** Stable file scope of the remote Guest Mode peer: username, else numeric id; never the bot's own scope. */
export declare function resolveTelegramGuestFileScope(input: Parameters<typeof resolveTelegramGuestPromptPeer>[0]): string;
import * as Threads from "./threads.ts";
import * as Updates from "./updates.ts";
/** Prepare the selected leader's exact retained originals; no copy, adoption, acceptance proof or dispatch. */
export declare function prepareTelegramLiveLeaderOriginal(input: {
    request: Threads.TelegramWorkspaceRestoreRequest;
    messages: readonly unknown[];
    isCurrent(): boolean;
}): Updates.TelegramLiveDeferredInputPreparation | undefined;
export type TelegramLiveRebindCleanupIssue = {
    status: "not-ready";
} | {
    status: "finished";
    operationId: string;
    cleanup: ThreadReconciler.TelegramLiveRebindCleanupOutcome;
    recorded: boolean;
};
/**
 * Default live-rebind cleanup pacing: quick early attempts, then minutely, within a 15-minute window. The first
 * delay is not cosmetic: a leader's detached command reply still needs the released, cleanup-free row.
 */
export declare const TELEGRAM_LIVE_REBIND_CLEANUP_SCHEDULE: Readonly<{
    delaysMs: readonly number[];
    intervalMs: 60000;
    windowMs: number;
}>;
/** Chooser-scoped saved command reference; it is never retained after the chooser record. */
type TelegramLiveRebindSelectedCommandReference = {
    operationId: string;
    preparedSource: Bus.TelegramBusPreparedCommandSource;
    selectedCommand: Bus.TelegramBusSelectedCommandInput;
};
/** One warm live attempt with exact post-release peer donor settlement; no startup recovery, Restore ACK or cleanup. */
export declare function createTelegramLiveRebindCoordinator(input: {
    request: Threads.TelegramWorkspaceRestoreRequest;
    /** Captures caller source/reference, admission, profile, transport and Pi lifetime. */
    authority: Threads.TelegramWorkspaceRestoreAuthority;
    messages: readonly unknown[];
    restoreStore: Threads.TelegramWorkspaceRestore;
    threadStore: Pick<Threads.TelegramTopicTargetStore, "withWorkspaceRestoreSnapshot">;
    getRecipient(): (Threads.TelegramWorkspaceRestoreRecipient & {
        bindingKey: string;
    }) | undefined;
    leader?: {
        apply(intent: Threads.TelegramWorkspaceLiveRebindIntent, mode: "apply" | "inspect", isCurrent: () => boolean): Promise<void>;
        /** Synchronous local identity only; safe inside a Workspace publication fence. */
        isApplied(intent: Threads.TelegramWorkspaceLiveRebindIntent): boolean;
    } & ({
        /** Confirm ordinary queue admission of these same bound messages, never handler replay. */
        continue(messages: readonly unknown[], isCurrent: () => boolean): Promise<boolean>;
        /** Observe only the same issued admission through its existing receipt owner; never re-enqueue. */
        observeAdmission?(): boolean;
        complete?: never;
    } | {
        /** Issue one semantic completion; the adapter owns detached delivery and errors, not a removal ACK. */
        complete(messages: readonly unknown[], isCurrent: () => boolean): void;
        continue?: never;
    });
    follower?: {
        run: ReturnType<typeof Bus.createTelegramBusLiveRebindController>;
        /** Explicit staged singleton command branch; absence preserves ordinary live input behavior. */
        selectedCommand?: Bus.TelegramBusSelectedCommandInput;
    };
    /** Restore moves the tab to its new owner: once applied, show that owner's title (best-effort, never blocking). */
    retitle?: (isCurrent: () => boolean) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown, details: Record<string, unknown>) => void;
}): {
    /** Correlation only; a later cleanup attempt rereads and revalidates the canonical row itself. */
    operationId: string;
    /** Body-free copy of the authenticated saved command reference: correlation only, never authority, an ACK or a cleanup permit. */
    selectedCommandReference(): TelegramLiveRebindSelectedCommandReference | undefined;
    advance(): Promise<"protected" | "unknown" | "released">;
};
/** One admitted Restore attempt through recipient readiness, never source dispatch or cleanup. */
export declare function advanceTelegramWorkspaceRestore(input: {
    request: Threads.TelegramWorkspaceRestoreRequest;
    authority: Threads.TelegramWorkspaceRestoreAuthority;
    restoreStore: Threads.TelegramWorkspaceRestore;
    getRecipient: () => Threads.TelegramWorkspaceRestoreRecipient | undefined;
    /** Adapter proves current canonical ownership and authenticates observations; apply needs a fresh issuance. */
    runRecipient: (input: {
        intent: Threads.TelegramWorkspaceRestoreIntent;
        mode: "apply" | "inspect";
        isCurrent: () => boolean;
    }) => Promise<{
        operationId: string;
        recipient: Threads.TelegramWorkspaceRestoreRecipient;
        target: Threads.TelegramWorkspaceRestoreRequest["target"];
        slot: string;
        ready: boolean;
    } | undefined>;
    /**
     * Recovery for a same-session successor already on the relocated target: it may receive the first grant, but only
     * read-only inspection runs. It never commits a new relocation or applies a target.
     */
    inspectOnly?: true;
}): Promise<Threads.TelegramWorkspaceRestoreIntent | undefined>;
export declare const TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS: number;
/** The toast for expired or previous-process routing controls; the chooser notice is written separately. */
export declare const TELEGRAM_ROUTING_CHOICE_EXPIRED = "Routing choice expired";
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
    callApi?: <TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) => Promise<TResponse>;
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
    getWorkspaceRestoreStore?: () => Threads.TelegramWorkspaceRestore | undefined;
    captureWorkspaceExternalProtection?: ReturnType<typeof createTelegramWorkspaceExternalProtectionCapture>;
    /** Strict committed abandonment plus retained original; shared by Restore and temporary-input cancellation. */
    inspectRestoreSourceAbandonment?: (updateId: number, journalBindingKey: string) => Threads.TelegramTemporaryThreadCancellationEvidence | undefined;
    inspectRoutingInputGroupExpiry?: (input: Threads.TelegramTemporaryThreadInput) => readonly Threads.TelegramTemporaryThreadCancellationEvidence[] | undefined;
    /** Strict active-journal observation only; a hint or missing source never substitutes for this ACK. */
    inspectRestoreSourceCompletion?: (expected: Updates.TelegramDeferredSourceEvidence & {
        completionSha256: string;
    }) => (Updates.TelegramDeferredSourceEvidence & {
        completionSha256: string;
    }) | undefined;
    inspectRestoreQueuedReceipt?: (expected: TelegramUpdateJournalQueuedCompletion & {
        journalBindingKey: string;
    }) => TelegramUpdateJournalQueuedReceiptEvidence | undefined;
    hasWorkspaceRestoreAuthority?: () => boolean;
    /** Exact live root authority; capability advertisement alone cannot replace owned profile/session/recipient fences. */
    hasWorkspaceLiveRebindAuthority?: () => boolean;
    /** Strict complete namespace plus exact current/historical references; only an empty result clears journal protection. */
    inspectTemporaryThreadSources?: (target: Queue.TelegramQueueTarget, requiredJournalBindingKeys: readonly string[], ownInputs?: readonly Threads.TelegramTemporaryThreadInput[]) => readonly number[] | undefined;
    /** Quiet period after the last cancelled input before one cleanup attempt; defaults to 1000 ms. */
    temporaryThreadCleanupDelayMs?: number;
    /** Live-rebind cleanup attempt pacing; the bounded window ends in `not-issued`, never a time-based deletion. */
    liveRebindCleanupSchedule?: {
        delaysMs: readonly number[];
        intervalMs: number;
        windowMs: number;
    };
    getSessionGeneration?: () => number;
    workspaceRestoreRecipient?: {
        getSessionId: (ctx: TContext) => string | undefined;
        getCwd: (ctx: TContext) => string | undefined;
        getLeaderIdentity: Threads.TelegramLeaderThreadStateRuntime["getIdentity"];
        /** Read-only current leader work; source/chooser lifetime is not recipient authority. */
        observeLeaderWork?: (oldTarget: Queue.TelegramQueueTarget & {
            threadId: number;
        }, ctx: TContext) => Bus.TelegramBusLiveRebindWorkState;
        followerRegistry: Pick<Bus.TelegramBusFollowerRegistry, "get" | "register">;
        runFollower: ReturnType<typeof Bus.createTelegramBusWorkspaceRestoreController>;
        liveFollower?: {
            /** Pure trusted assembly availability (Commands/native/menu and local protocol), never future target activation. */
            isSelectedCommandAvailable?(follower: Readonly<Bus.TelegramBusFollowerView>, name: string): boolean;
            /** Exact session journal identity from the existing registration/journal owners, never the profile routing key. */
            getJournalBindingKey(follower: Bus.TelegramBusFollowerView): string | undefined;
            run: ReturnType<typeof Bus.createTelegramBusLiveRebindController>;
        };
    };
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
    /** Thinking controls refuse while the active Telegram turn expects a voice reply. */
    isVoiceReplyActive?: () => boolean;
    updateSettingsMenuMessage?: (state: Menu.TelegramModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    openQueueMenu: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    openSettingsMenu?: (chatId: number, replyToMessageId: number, ctx: TContext, threadId?: number, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
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
    answerCallbackQuery: (callbackQueryId: string, text?: string, options?: Pick<TelegramApiCallOptions, "assertAuthority">) => Promise<void>;
    editInteractiveMessage?: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: Menu.TelegramReplyMarkup, options?: {
        target?: Queue.TelegramQueueTarget;
        assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    }) => Promise<void>;
    editMessageReplyMarkup?: (chatId: number, messageId: number, replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup) => Promise<void>;
    sendInteractiveMessage?: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: Menu.TelegramReplyMarkup, options?: {
        target?: Queue.TelegramQueueTarget;
        replyToMessageId?: number;
        assertAuthority?: TelegramApiCallOptions["assertAuthority"];
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
        assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    }) => Promise<number | undefined>;
    setMyCommands: Commands.TelegramBotCommandRegistrationDeps["setMyCommands"];
    /** Captures independent recipient authority, never the source execution or dialog handle. */
    captureThreadNameRecipientAuthority?: (target: Queue.TelegramQueueTarget, ctx: TContext) => (() => void) | undefined;
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
    beginCommandEffectWork?: Commands.TelegramCommandRuntimeDeps<TMessage, TContext>["beginCommandEffectWork"];
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
}, TMessage extends TelegramRoutedMessage, TCallbackQuery extends TelegramRoutedCallbackQuery, TContext, TModel extends Model.MenuModel>(deps: TelegramInboundRouteRuntimeDeps<TMessage, TCallbackQuery, TContext, TModel>): Updates.TelegramUpdateRuntimeController<TContext, TUpdate> & {
    expireRoutingInput: NonNullable<Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["expireRoutingInput"]>;
    shouldReviewHistoricalInput: NonNullable<Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["shouldReviewHistoricalInput"]>;
    shouldHoldPendingInput: NonNullable<Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["shouldHoldPendingInput"]>;
    forgetPreviousWorld(input: Updates.TelegramHeldSourcePreparation<TContext>, captureTransport?: (ctx: TContext) => (() => boolean) | undefined): Promise<{
        forgotten: number;
        deleted: number;
    }>;
    beforeQueueReceiptPublished: NonNullable<Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["beforeQueueReceiptPublished"]>;
    onQueueReceiptCommitted: NonNullable<Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["onQueueReceiptCommitted"]>;
    onQueueReceiptCompleted: NonNullable<Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["onQueueReceiptCompleted"]>;
    onUpdateCompleted: NonNullable<Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["onUpdateCompleted"]>;
    onWorkspaceRestoreRecipientObserved(follower: Bus.TelegramBusFollowerView, isCurrent: () => boolean, ctx: TContext | undefined): Promise<void> | undefined;
    waitForRestoreSettlement(): Promise<void>;
    /** Commands-owned registry port for dormant scoped recipient assembly, not ordinary update replay. */
    prepareHeldCommand: ReturnType<typeof Commands.createTelegramCommandHandlerTargetRuntime<TMessage, TContext>>["prepareHeldCommand"];
    canPrepareHeldCommand: ReturnType<typeof Commands.createTelegramCommandHandlerTargetRuntime<TMessage, TContext>>["canPrepareHeldCommand"];
    /** Agent-settled hint: wakes waiting leader cleanup retries early; every readiness gate is still sampled fresh. */
    onSessionSettled(ctx: TContext): void;
    /** Fresh body-free recipient observation only; never reconstructs an attempt or grants cleanup. */
    observeLiveRebindLeaderWork(intent: Threads.TelegramWorkspaceLiveRebindIntent, ctx: TContext): Promise<Bus.TelegramBusLiveRebindWorkObservation | undefined>;
    /** Fresh non-destructive candidate only; no retained idle, cleanup action or deletion grant. */
    prepareLiveRebindLeaderCleanup(intent: Threads.TelegramWorkspaceLiveRebindIntent, ctx: TContext): Promise<ThreadReconciler.TelegramLiveRebindCleanupPreparation | undefined>;
    /** Requires the authenticated peer's exact retained released carrier; never recreates save/apply/release. */
    prepareLiveRebindFollowerCleanup(intent: Threads.TelegramWorkspaceLiveRebindIntent, ctx: TContext): Promise<ThreadReconciler.TelegramLiveRebindCleanupPreparation | undefined>;
    /**
     * One cleanup attempt under fresh admission: a fresh clear sample, then the durable issue marker, one unretried
     * deletion and the terminal record. `not-ready` leaves the released row unissued; `undefined` is lost authority.
     */
    issueLiveRebindLeaderCleanup(intent: Threads.TelegramWorkspaceLiveRebindIntent, ctx: TContext): Promise<TelegramLiveRebindCleanupIssue | undefined>;
    issueLiveRebindFollowerCleanup(intent: Threads.TelegramWorkspaceLiveRebindIntent, ctx: TContext): Promise<TelegramLiveRebindCleanupIssue | undefined>;
    /** Coordinator-only prompt admission; caller retains Workspace/canonical and exact recipient authority. */
    continueLiveRebindPrompt(messages: readonly TMessage[], ctx: TContext, target: Queue.TelegramQueueTarget & {
        threadId: number;
    }, isCurrent: () => boolean): Promise<boolean>;
};
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
