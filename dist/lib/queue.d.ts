/**
 * Telegram queue core contracts and pure planning helpers
 * Zones: telegram queue, pi agent lifecycle, scheduling
 * Owns queue item contracts, lane admission, pure queue mutations, and dispatch planning
 */
export interface QueuedAttachment {
    path: string;
    fileName: string;
}
export interface TelegramPromptTextContent {
    type: "text";
    text: string;
}
export interface TelegramPromptImageContent {
    type: "image";
    data: string;
    mimeType: string;
}
export type TelegramPromptContent = TelegramPromptTextContent | TelegramPromptImageContent;
export type TelegramQueueItemKind = "prompt" | "control";
export type TelegramQueueLane = "control" | "priority" | "default";
export type TelegramQueueReactionDisposition = {
    kind: "default";
} | {
    kind: "priority";
    emoji: string;
} | {
    kind: "suppressed";
    emoji: string;
} | {
    kind: "priority-suppressed";
    priorityEmoji: string;
    suppressionEmoji: string;
} | {
    kind: "reaction-transition";
    priorityEmoji?: string | null;
    suppressionEmoji?: string | null;
};
export interface TelegramQueueAdmissionReceipt {
    queueKind: TelegramQueueItemKind;
    receiptId: string;
    sourceUpdateIds: readonly number[];
    journalBindingKey?: string;
}
export type TelegramQueueAdmissionMode = "control-queue" | "priority-queue" | "default-queue";
export interface TelegramQueueLaneContract {
    lane: TelegramQueueLane;
    admissionMode: TelegramQueueAdmissionMode;
    dispatchRank: number;
    allowedKinds: readonly TelegramQueueItemKind[];
}
export declare const TELEGRAM_QUEUE_LANE_CONTRACTS: readonly TelegramQueueLaneContract[];
export interface TelegramQueueTarget {
    chatId: number;
    threadId?: number;
}
export interface TelegramTransportStamp {
    profile: string;
    generation: string;
}
export interface TelegramTransportStampRuntime {
    getStamp(): TelegramTransportStamp;
    isActive(stamp: TelegramTransportStamp | undefined): boolean;
}
export interface TelegramQueueItemBase {
    kind: TelegramQueueItemKind;
    chatId: number;
    target?: TelegramQueueTarget;
    transportStamp?: TelegramTransportStamp;
    replyToMessageId: number;
    guestQueryId?: string;
    guestInlineMessageId?: string;
    queueOrder: number;
    queueLane: TelegramQueueLane;
    laneOrder: number;
    statusSummary: string;
    admissionReceipts?: TelegramQueueAdmissionReceipt[];
}
export interface PendingTelegramTurn extends TelegramQueueItemBase {
    kind: "prompt";
    sourceMessageIds: number[];
    queuedAttachments: QueuedAttachment[];
    content: TelegramPromptContent[];
    historyText: string;
    priorityEmoji?: string;
    reactionSuppressionEmoji?: string;
    /** Emit the explicit aborted-turn notice when /next settles this active turn. */
    announceNextAbortOnEnd?: boolean;
    /** Turn should preferably be delivered as voice (mirror mode + user sent voice) */
    voiceReplyPreferred?: boolean;
    /** Turn must be delivered as voice (voice mode) */
    voiceReplyRequired?: boolean;
}
export interface PendingTelegramControlItem<TContext = unknown> extends TelegramQueueItemBase {
    kind: "control";
    controlType: "status" | "model";
    execute: (ctx: TContext) => Promise<void>;
}
export type TelegramQueueItem<TContext = unknown> = PendingTelegramTurn | PendingTelegramControlItem<TContext>;
export declare const TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES: number;
export declare const TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS = 256;
export interface TelegramQueueHandoffBase {
    chatId: number;
    target?: TelegramQueueTarget;
    transportStamp?: TelegramTransportStamp;
    replyToMessageId: number;
    guestQueryId?: string;
    guestInlineMessageId?: string;
    queueOrder: number;
    queueLane: TelegramQueueLane;
    laneOrder: number;
    statusSummary: string;
    admissionReceipts: TelegramQueueAdmissionReceipt[];
}
export interface TelegramPromptQueueHandoffPayload extends TelegramQueueHandoffBase {
    kind: "prompt";
    sourceMessageIds: number[];
    queuedAttachments: QueuedAttachment[];
    content: TelegramPromptContent[];
    historyText: string;
    priorityEmoji?: string;
    reactionSuppressionEmoji?: string;
    voiceReplyPreferred?: boolean;
    voiceReplyRequired?: boolean;
}
export interface TelegramControlQueueHandoffPayload extends TelegramQueueHandoffBase {
    kind: "control";
    controlType: PendingTelegramControlItem<unknown>["controlType"];
}
export type TelegramQueueHandoffPayload = TelegramPromptQueueHandoffPayload | TelegramControlQueueHandoffPayload;
export interface TelegramQueueHandoff {
    handoffToken: string;
    payload: TelegramQueueHandoffPayload;
}
export interface TelegramQueueHandoffStageReceipt {
    status: "staged";
    receiptId: string;
    sourceUpdateIds: readonly number[];
}
export interface TelegramQueueHandoffAcceptedOwner {
    instanceId: string;
    processId: number;
    processBirthId: string;
    sessionGeneration: number;
    acquisitionId: string;
    acquiredAtMs: number;
    handoffId?: string;
}
export interface TelegramQueueHandoffStageResult extends TelegramQueueHandoffStageReceipt {
    queueOwner: TelegramQueueHandoffAcceptedOwner;
}
export interface TelegramQueueHandoffStagingRuntime {
    stage: (payload: TelegramQueueHandoffPayload) => TelegramQueueHandoffStageReceipt;
    accept: (receipt: TelegramQueueAdmissionReceipt) => boolean;
    cancel: (receipt: TelegramQueueAdmissionReceipt) => boolean;
    hasStaged: (receipt: TelegramQueueAdmissionReceipt) => boolean;
}
export interface TelegramQueueStore<TContext = unknown> {
    getQueuedItems: () => TelegramQueueItem<TContext>[];
    setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
}
export interface TelegramQueueStateStore<TContext = unknown> extends TelegramQueueStore<TContext> {
    hasQueuedItems: () => boolean;
}
export interface TelegramActiveTurnStore<TTurn extends PendingTelegramTurn = PendingTelegramTurn> {
    get: () => TTurn | undefined;
    has: () => boolean;
    set: (turn: TTurn) => void;
    clear: () => void;
    markNextAbortAnnouncement: () => boolean;
    clearNextAbortAnnouncement: () => boolean;
    getChatId: () => number | undefined;
    getTarget: () => TelegramQueueTarget | undefined;
    getReplyToMessageId: () => number | undefined;
    getGuestQueryId: () => string | undefined;
    getSourceMessageIds: () => number[] | undefined;
}
export interface TelegramDispatchGuardState {
    compactionInProgress: boolean;
    hasActiveTelegramTurn: boolean;
    hasPendingTelegramDispatch: boolean;
    isIdle: boolean;
    hasPendingMessages: boolean;
}
export declare function createTelegramQueueAdmissionReceipt(options: {
    queueKind: TelegramQueueItemKind;
    scope: string;
    sourceUpdateIds: readonly number[];
}): TelegramQueueAdmissionReceipt | undefined;
export declare function isTelegramQueueItemDurablyAdmitted<TContext = unknown>(item: TelegramQueueItem<TContext>, isReceiptCommitted: (receipt: TelegramQueueAdmissionReceipt) => boolean): boolean;
export declare function getTelegramQueueLaneContract(lane: TelegramQueueLane): TelegramQueueLaneContract;
export declare function getTelegramQueueItemAdmissionMode(item: Pick<TelegramQueueItem, "queueLane">): TelegramQueueAdmissionMode;
export declare function isTelegramQueueItemAdmissionValid(item: Pick<TelegramQueueItem, "kind" | "queueLane">): boolean;
export declare function assertTelegramQueueItemAdmissionValid(item: Pick<TelegramQueueItem, "kind" | "queueLane" | "admissionReceipts">): void;
export declare function isPendingTelegramTurn<TContext = unknown>(item: TelegramQueueItem<TContext>): item is PendingTelegramTurn;
export declare function createTelegramQueueStore<TContext = unknown>(initialItems?: TelegramQueueItem<TContext>[]): TelegramQueueStateStore<TContext>;
export declare function createTelegramTransportStampRuntime(deps: {
    getProfileName(): string | undefined;
    getBotToken(): string | undefined;
}): TelegramTransportStampRuntime;
export declare function createTelegramTransportStampedQueueStore<TContext>(store: TelegramQueueStateStore<TContext>, getTransportStamp: () => TelegramTransportStamp): TelegramQueueStateStore<TContext>;
export declare function isTelegramQueueItemSkipped<TContext = unknown>(item: TelegramQueueItem<TContext>): boolean;
export declare function countExecutableTelegramQueueItems<TContext = unknown>(items: readonly TelegramQueueItem<TContext>[]): number;
export declare function createTelegramQueueItemCountGetter<TContext = unknown>(store: Pick<TelegramQueueStore<TContext>, "getQueuedItems">): () => number;
export declare function createTelegramActiveTurnStore<TTurn extends PendingTelegramTurn = PendingTelegramTurn>(): TelegramActiveTurnStore<TTurn>;
export declare function partitionTelegramQueueItemsForHistory<TContext = unknown>(items: TelegramQueueItem<TContext>[]): {
    historyTurns: PendingTelegramTurn[];
    remainingItems: TelegramQueueItem<TContext>[];
};
export declare function planTelegramPromptEnqueue<TContext = unknown>(items: TelegramQueueItem<TContext>[], foldQueuedPromptsIntoHistory: boolean): {
    historyTurns: PendingTelegramTurn[];
    remainingItems: TelegramQueueItem<TContext>[];
};
export declare function areTelegramQueueAdmissionReceiptsEqual(left: TelegramQueueAdmissionReceipt, right: TelegramQueueAdmissionReceipt): boolean;
export declare function appendTelegramQueueItem<TContext = unknown, TItem extends TelegramQueueItem<TContext> = TelegramQueueItem<TContext>>(items: TelegramQueueItem<TContext>[], item: TItem): TelegramQueueItem<TContext>[];
export declare function createTelegramQueueHandoff<TContext>(input: {
    handoffToken: string;
    item: TelegramQueueItem<TContext>;
}): TelegramQueueHandoff;
export declare function createTelegramQueueHandoffPayload<TContext>(item: TelegramQueueItem<TContext>): TelegramQueueHandoffPayload;
export declare function restoreTelegramQueueHandoffPayload<TContext>(payload: TelegramQueueHandoffPayload, createControlExecution: (payload: TelegramControlQueueHandoffPayload) => PendingTelegramControlItem<TContext>["execute"]): TelegramQueueItem<TContext>;
export declare function removeTelegramQueueItemByReceipt<TContext>(input: {
    receipt: TelegramQueueAdmissionReceipt;
    store: TelegramQueueStore<TContext>;
}): boolean;
export declare function stageTelegramQueueHandoffPayload<TContext>(input: {
    payload: TelegramQueueHandoffPayload;
    store: TelegramQueueStore<TContext>;
    createControlExecution: (payload: TelegramControlQueueHandoffPayload) => PendingTelegramControlItem<TContext>["execute"];
}): TelegramQueueHandoffStageReceipt;
export declare function createTelegramQueueHandoffStagingRuntime<TContext>(input: {
    liveStore: TelegramQueueStore<TContext>;
    createControlExecution: (payload: TelegramControlQueueHandoffPayload) => PendingTelegramControlItem<TContext>["execute"];
}): TelegramQueueHandoffStagingRuntime;
export declare function appendTelegramPromptTurnOnce<TContext = unknown>(items: TelegramQueueItem<TContext>[], turn: PendingTelegramTurn): {
    items: TelegramQueueItem<TContext>[];
    appended: boolean;
};
export declare function compareTelegramQueueItems<TContext = unknown>(left: TelegramQueueItem<TContext>, right: TelegramQueueItem<TContext>): number;
export interface TelegramQueueMessageScope {
    chatId?: number;
    threadId?: number;
}
export declare function removeTelegramQueueItemsByMessageIds<TContext = unknown>(items: TelegramQueueItem<TContext>[], messageIds: number[], scope?: TelegramQueueMessageScope): {
    items: TelegramQueueItem<TContext>[];
    removedItems: TelegramQueueItem<TContext>[];
    removedCount: number;
};
export declare function removeTelegramQueuedGuestPromptByOrder<TContext = unknown>(items: TelegramQueueItem<TContext>[], queueOrder: number): {
    items: TelegramQueueItem<TContext>[];
    removedItems: PendingTelegramTurn[];
    removedCount: number;
};
export declare function applyTelegramQueuePromptReactionDisposition<TContext = unknown>(items: TelegramQueueItem<TContext>[], messageId: number, disposition: TelegramQueueReactionDisposition, destinationLaneOrder?: number, scope?: TelegramQueueMessageScope): {
    items: TelegramQueueItem<TContext>[];
    changed: boolean;
};
export declare function consumeDispatchedTelegramPrompt<TContext = unknown>(items: TelegramQueueItem<TContext>[], hasPendingDispatch: boolean): {
    activeTurn?: PendingTelegramTurn;
    remainingItems: TelegramQueueItem<TContext>[];
};
export declare function formatQueuedTelegramItemsStatus<TContext = unknown>(items: TelegramQueueItem<TContext>[]): string;
export declare function truncateTelegramQueueSummary(text: string, maxWords?: number, maxLength?: number): string;
export declare function canDispatchTelegramTurnState(state: TelegramDispatchGuardState): boolean;
export interface TelegramDispatchReadinessDeps<TContext> {
    isCompactionInProgress: () => boolean;
    hasActiveTurn: () => boolean;
    hasDispatchPending: () => boolean;
    isIdle: (ctx: TContext) => boolean;
    hasPendingMessages: (ctx: TContext) => boolean;
}
export declare function createTelegramDispatchReadinessChecker<TContext>(deps: TelegramDispatchReadinessDeps<TContext>): (ctx: TContext) => boolean;
export declare function buildPendingTelegramControlItem<TContext = unknown>(options: {
    chatId: number;
    target?: TelegramQueueTarget;
    replyToMessageId: number;
    controlType: PendingTelegramControlItem<TContext>["controlType"];
    queueOrder: number;
    laneOrder: number;
    statusSummary: string;
    admissionReceipts?: TelegramQueueAdmissionReceipt[];
    execute: PendingTelegramControlItem<TContext>["execute"];
}): PendingTelegramControlItem<TContext>;
export interface TelegramControlItemBuilderDeps {
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}
export declare function createTelegramControlItemBuilder<TContext = unknown>(deps: TelegramControlItemBuilderDeps): (options: {
    chatId: number;
    target?: TelegramQueueTarget;
    replyToMessageId: number;
    controlType: PendingTelegramControlItem<TContext>["controlType"];
    statusSummary: string;
    admissionReceipts?: TelegramQueueAdmissionReceipt[];
    execute: PendingTelegramControlItem<TContext>["execute"];
}) => PendingTelegramControlItem<TContext>;
export type TelegramQueueDispatchAction<TContext = unknown> = {
    kind: "none";
    remainingItems: TelegramQueueItem<TContext>[];
} | {
    kind: "control";
    item: PendingTelegramControlItem<TContext>;
    remainingItems: TelegramQueueItem<TContext>[];
} | {
    kind: "prompt";
    item: PendingTelegramTurn;
    remainingItems: TelegramQueueItem<TContext>[];
};
export declare function planNextTelegramQueueAction<TContext = unknown>(items: TelegramQueueItem<TContext>[], canDispatch: boolean): TelegramQueueDispatchAction<TContext>;
export declare function shouldDispatchAfterTelegramAgentEnd(options: {
    hasTurn: boolean;
    stopReason?: string;
    foldQueuedPromptsIntoHistory: boolean;
}): boolean;
export interface TelegramAgentStartPlan<TContext = unknown> {
    activeTurn?: PendingTelegramTurn;
    remainingItems: TelegramQueueItem<TContext>[];
    shouldResetPendingModelSwitch: boolean;
    shouldResetToolExecutions: boolean;
    shouldClearDispatchPending: boolean;
    shouldClearAbortHistory: boolean;
}
export interface TelegramAgentStartRuntimeDeps<TTurn extends PendingTelegramTurn, TContext = unknown> extends TelegramRuntimeEventRecorderPort {
    queuedItems: TelegramQueueItem<TContext>[];
    hasPendingDispatch: boolean;
    hasActiveTurn: boolean;
    resetToolExecutions: () => void;
    resetPendingModelSwitch: () => void;
    setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
    clearDispatchPending: () => void;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    setActiveTurn: (turn: TTurn) => void;
    onPromptHandedOff?: (turn: TTurn) => void;
    createPreviewState: () => void;
    startTypingLoop: () => void;
    updateStatus: () => void;
}
export interface TelegramAgentStartHookRuntimeDeps<TTurn extends PendingTelegramTurn, TContext = unknown> extends TelegramRuntimeEventRecorderPort {
    setAbortHandler: (ctx: TContext) => void;
    getQueuedItems: () => TelegramQueueItem<TContext>[];
    hasPendingDispatch: () => boolean;
    hasActiveTurn: () => boolean;
    resetToolExecutions: () => void;
    resetPendingModelSwitch: () => void;
    setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
    clearDispatchPending: () => void;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    setActiveTurn: (turn: TTurn) => void;
    onPromptHandedOff?: (turn: TTurn, ctx: TContext) => void;
    createPreviewState: () => void;
    startTypingLoop: (ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export type TelegramAgentStartHookEvent = unknown;
export interface TelegramToolExecutionRuntimeDeps {
    getActiveToolExecutions: () => number;
    setActiveToolExecutions: (count: number) => void;
}
export interface TelegramToolExecutionEndRuntimeDeps extends TelegramToolExecutionRuntimeDeps {
    triggerPendingModelSwitchAbort: () => void;
}
export interface TelegramToolExecutionHookRuntimeDeps<TContext> extends TelegramToolExecutionRuntimeDeps {
    triggerPendingModelSwitchAbort: (ctx: TContext) => unknown;
}
export type TelegramToolExecutionHookEvent = unknown;
export declare function buildTelegramAgentStartPlan<TContext = unknown>(options: {
    queuedItems: TelegramQueueItem<TContext>[];
    hasPendingDispatch: boolean;
    hasActiveTurn: boolean;
}): TelegramAgentStartPlan<TContext>;
export declare function handleTelegramAgentStartRuntime<TTurn extends PendingTelegramTurn, TContext = unknown>(deps: TelegramAgentStartRuntimeDeps<TTurn, TContext>): void;
export declare function createTelegramAgentStartHook<TTurn extends PendingTelegramTurn, TContext = unknown>(deps: TelegramAgentStartHookRuntimeDeps<TTurn, TContext>): (_event: TelegramAgentStartHookEvent, ctx: TContext) => Promise<void>;
export declare function getNextTelegramToolExecutionCount(options: {
    currentCount: number;
    event: "start" | "end";
}): number;
export declare function handleTelegramToolExecutionStartRuntime(deps: TelegramToolExecutionRuntimeDeps): void;
export declare function handleTelegramToolExecutionEndRuntime(deps: TelegramToolExecutionEndRuntimeDeps): void;
export type TelegramAgentLifecycleHooksRuntimeDeps<TTurn extends PendingTelegramTurn, TContext, TMessage, TReplyMarkup = unknown> = TelegramAgentStartHookRuntimeDeps<TTurn, TContext> & TelegramAgentEndHookRuntimeDeps<TTurn, TContext, TMessage, TReplyMarkup> & TelegramToolExecutionHookRuntimeDeps<TContext>;
export declare function createTelegramAgentLifecycleHooks<TTurn extends PendingTelegramTurn, TContext, TMessage, TReplyMarkup = unknown>(deps: TelegramAgentLifecycleHooksRuntimeDeps<TTurn, TContext, TMessage, TReplyMarkup>): {
    onToolExecutionStart: () => void;
    onToolExecutionEnd: (_event: TelegramToolExecutionHookEvent, ctx: TContext) => void;
    onAgentStart: (_event: TelegramAgentStartHookEvent, ctx: TContext) => Promise<void>;
    onAgentEnd(event: TelegramAgentEndHookEvent<TMessage>, ctx: TContext): Promise<void>;
    onAgentSettled(_event: unknown, ctx: TContext): Promise<void>;
    clearRetainedAgentEnd(): void;
};
export declare function createTelegramToolExecutionHooks<TContext>(deps: TelegramToolExecutionHookRuntimeDeps<TContext>): {
    onToolExecutionStart: () => void;
    onToolExecutionEnd: (_event: TelegramToolExecutionHookEvent, ctx: TContext) => void;
};
export interface TelegramAgentEndPlan {
    kind: "no-turn" | "aborted" | "error" | "text" | "attachments-only" | "empty";
    shouldClearPreview: boolean;
    shouldDispatchNext: boolean;
    shouldSendAbortMessage: boolean;
    shouldSendErrorMessage: boolean;
    shouldSendAttachmentNotice: boolean;
}
export interface TelegramAgentEndAssistantResult {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
    recoveredFromEarlier?: boolean;
}
export interface TelegramAgentEndOutboundVoiceReply {
    text: string;
    lang?: string;
    rate?: string;
}
export interface TelegramAgentEndOutboundReplyPlan<TReplyMarkup = unknown> {
    markdown: string;
    replyMarkup?: TReplyMarkup;
    voiceText?: string;
    voiceReplies?: TelegramAgentEndOutboundVoiceReply[];
    lang?: string;
    rate?: string;
}
export interface TelegramAgentEndRuntimeDeps<TTurn extends PendingTelegramTurn, TReplyMarkup = unknown> {
    turn: TTurn | undefined;
    assistant: TelegramAgentEndAssistantResult;
    foldQueuedPromptsIntoHistory: boolean;
    resetRuntimeState: () => void;
    isSessionActive?: () => boolean;
    isTurnTransportActive?: (turn: TTurn) => boolean;
    waitForTypingIdle?: () => Promise<void>;
    waitForActivityIdle?: () => Promise<void>;
    updateStatus: () => void;
    dispatchNextQueuedTelegramTurn: () => void;
    scheduleActiveTurnDelivery?: (task: () => Promise<void>) => void;
    preparePreviewDelivery?: (isDeliveryActive: () => boolean) => Pick<TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>, "clearPreview" | "setPreviewPendingText" | "finalizeMarkdownPreview"> | undefined;
    preparePreviewClear?: (chatId: number, options?: {
        target?: TelegramQueueTarget;
        isDeliveryActive?: () => boolean;
    }) => () => Promise<void>;
    clearPreview: (chatId: number, options?: {
        target?: TelegramQueueTarget;
    }) => Promise<void>;
    setPreviewPendingText: (text: string) => void;
    finalizeMarkdownPreview: (chatId: number, markdown: string, replyToMessageId: number, options?: {
        replyMarkup?: TReplyMarkup;
        target?: TelegramQueueTarget;
    }) => Promise<boolean>;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        target?: TelegramQueueTarget;
    }) => Promise<unknown>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        target?: TelegramQueueTarget;
        parseMode?: "HTML";
    }) => Promise<unknown>;
    sendQueuedAttachments: (turn: TTurn, options?: {
        isDeliveryActive?: () => boolean;
    }) => Promise<void>;
    sendRichAttachmentReply?: (turn: TTurn, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        isDeliveryActive?: () => boolean;
    }) => Promise<boolean>;
    answerGuestQuery?: (guestQueryId: string, text?: string, options?: {
        parseMode?: string;
    }) => Promise<void>;
    sendGuestReply?: (guestQueryId: string, markdown: string) => Promise<void>;
    /** Replaces the early guest ACK with the final text. */
    editGuestReply?: (inlineMessageId: string, markdown: string) => Promise<void>;
    /** Cancels the animated guest placeholder before the final edit. */
    stopGuestPlaceholder?: (inlineMessageId: string) => Promise<void>;
    sendGuestAttachment?: (turn: TTurn, attachment: QueuedAttachment, caption?: string) => Promise<void>;
    sendGuestVoiceReply?: (turn: TTurn, plan: TelegramAgentEndOutboundReplyPlan<TReplyMarkup>, caption?: string) => Promise<void>;
    planOutboundReply?: (markdown: string) => TelegramAgentEndOutboundReplyPlan<TReplyMarkup>;
    sendOutboundReplyArtifacts?: (turn: TTurn, plan: TelegramAgentEndOutboundReplyPlan, options?: {
        replyToPrompt?: boolean;
        isDeliveryActive?: () => boolean;
    }) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramAgentEndHookRuntimeDeps<TTurn extends PendingTelegramTurn, TContext, TMessage, TReplyMarkup = unknown> {
    getActiveTurn: () => TTurn | undefined;
    loadConfig?: () => Promise<void>;
    extractAssistant: (messages: readonly TMessage[]) => TelegramAgentEndAssistantResult;
    isAssistantAlreadyPublished?: (assistant: TelegramAgentEndAssistantResult) => boolean;
    getFoldQueuedPromptsIntoHistory: () => boolean;
    resetRuntimeState: () => void;
    isSessionActive?: (ctx: TContext) => boolean;
    isTurnTransportActive?: (turn: TTurn) => boolean;
    waitForTypingIdle?: () => Promise<void>;
    waitForActivityIdle?: () => Promise<void>;
    updateStatus: (ctx: TContext) => void;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch: (ctx: TContext) => void) => void;
    scheduleActiveTurnDelivery?: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["scheduleActiveTurnDelivery"];
    reserveActiveTurnDelivery?: () => {
        schedule: (task: () => Promise<void>) => void;
        cancel: () => void;
    };
    preparePreviewDelivery?: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["preparePreviewDelivery"];
    preparePreviewClear?: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["preparePreviewClear"];
    clearPreview: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["clearPreview"];
    setPreviewPendingText: (text: string) => void;
    finalizeMarkdownPreview: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["finalizeMarkdownPreview"];
    sendMarkdownReply: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["sendMarkdownReply"];
    sendTextReply: TelegramAgentEndRuntimeDeps<TTurn>["sendTextReply"];
    sendQueuedAttachments: TelegramAgentEndRuntimeDeps<TTurn>["sendQueuedAttachments"];
    sendRichAttachmentReply?: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["sendRichAttachmentReply"];
    answerGuestQuery?: TelegramAgentEndRuntimeDeps<TTurn>["answerGuestQuery"];
    sendGuestReply?: TelegramAgentEndRuntimeDeps<TTurn>["sendGuestReply"];
    editGuestReply?: TelegramAgentEndRuntimeDeps<TTurn>["editGuestReply"];
    stopGuestPlaceholder?: TelegramAgentEndRuntimeDeps<TTurn>["stopGuestPlaceholder"];
    sendGuestAttachment?: TelegramAgentEndRuntimeDeps<TTurn>["sendGuestAttachment"];
    sendGuestVoiceReply?: TelegramAgentEndRuntimeDeps<TTurn>["sendGuestVoiceReply"];
    planOutboundReply?: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>["planOutboundReply"];
    sendOutboundReplyArtifacts?: TelegramAgentEndRuntimeDeps<TTurn>["sendOutboundReplyArtifacts"];
    recordRuntimeEvent?: TelegramAgentEndRuntimeDeps<TTurn>["recordRuntimeEvent"];
}
export interface TelegramAgentEndHookEvent<TMessage> {
    messages: readonly TMessage[];
}
export declare function buildTelegramAgentEndPlan(options: {
    hasTurn: boolean;
    stopReason?: string;
    hasFinalText: boolean;
    hasQueuedAttachments: boolean;
    foldQueuedPromptsIntoHistory: boolean;
    announceNextAbortOnEnd?: boolean;
}): TelegramAgentEndPlan;
export declare function createTelegramAgentEndHook<TTurn extends PendingTelegramTurn, TContext, TMessage, TReplyMarkup = unknown>(deps: TelegramAgentEndHookRuntimeDeps<TTurn, TContext, TMessage, TReplyMarkup>): (event: TelegramAgentEndHookEvent<TMessage>, ctx: TContext, assistantOverride?: TelegramAgentEndAssistantResult) => Promise<void>;
export declare function handleTelegramAgentEndRuntime<TTurn extends PendingTelegramTurn, TReplyMarkup = unknown>(deps: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>): Promise<void>;
export interface TelegramSessionStartState<TModel = unknown> {
    currentTelegramModel: TModel | undefined;
    activeTelegramToolExecutions: number;
    pendingTelegramModelSwitch: undefined;
    nextQueuedTelegramItemOrder: number;
    nextQueuedTelegramControlOrder: number;
    telegramTurnDispatchPending: boolean;
    compactionInProgress: boolean;
}
export interface TelegramSessionShutdownState<TQueueItem> {
    queuedTelegramItems: TQueueItem[];
    nextQueuedTelegramItemOrder: number;
    nextQueuedTelegramControlOrder: number;
    currentTelegramModel: undefined;
    activeTelegramToolExecutions: number;
    pendingTelegramModelSwitch: undefined;
    telegramTurnDispatchPending: boolean;
    compactionInProgress: boolean;
    foldQueuedPromptsIntoHistory: boolean;
}
export interface TelegramSessionRuntimeCounterState {
    nextQueuedTelegramItemOrder?: number;
    nextQueuedTelegramControlOrder?: number;
}
export interface TelegramSessionRuntimeFlagState {
    activeTelegramToolExecutions?: number;
    telegramTurnDispatchPending?: boolean;
    compactionInProgress?: boolean;
    foldQueuedPromptsIntoHistory?: boolean;
}
export interface TelegramSessionStateApplierDeps<TQueueItem, TModel> {
    setQueuedItems: (items: TQueueItem[]) => void;
    setCurrentModel: (model: TModel | undefined) => void;
    setPendingModelSwitch: (selection: undefined) => void;
    syncCounters: (state: TelegramSessionRuntimeCounterState) => void;
    syncFlags: (state: TelegramSessionRuntimeFlagState) => void;
}
export interface TelegramSessionStateApplier<TQueueItem, TModel> {
    applyStartState: (state: TelegramSessionStartState<TModel>) => void;
    applyShutdownState: (state: TelegramSessionShutdownState<TQueueItem>) => void;
}
export interface TelegramSessionStartRuntimeDeps<TContext, TModel = unknown> {
    ctx: TContext;
    currentModel: TModel | undefined;
    loadConfig: () => Promise<void>;
    isSessionActive?: () => boolean;
    applyState: (state: TelegramSessionStartState<TModel>) => void;
    bindDeferredDispatchContext?: (ctx: TContext) => void;
    prepareTempDir: () => Promise<unknown>;
    updateStatus: () => void;
}
export interface TelegramSessionShutdownRuntimeDeps<TQueueItem> {
    isSessionActive?: () => boolean;
    unbindDeferredDispatchContext?: () => void;
    discardQueuedItems?: () => void;
    applyState: (state: TelegramSessionShutdownState<TQueueItem>) => void;
    clearPendingMediaGroups: () => void;
    clearModelMenuState: () => void;
    getActiveTurnChatId: () => number | undefined;
    getActiveTurnTarget?: () => TelegramQueueTarget | undefined;
    clearPreview: (chatId: number, options?: {
        target?: TelegramQueueTarget;
    }) => Promise<void>;
    previewShutdownTimeoutMs?: number;
    clearActiveTurn: () => void;
    clearAbort: () => void;
    stopPolling: () => Promise<void>;
}
export interface TelegramSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel = unknown> extends TelegramRuntimeEventRecorderPort {
    getCurrentModel: (ctx: TContext) => TModel | undefined;
    loadConfig: () => Promise<void>;
    applySessionStartState: (state: TelegramSessionStartState<TModel>) => void;
    bindDeferredDispatchContext?: (ctx: TContext) => void;
    prepareTempDir: () => Promise<unknown>;
    updateStatus: (ctx: TContext) => void;
    isSessionActive?: (ctx: TContext) => boolean;
    unbindDeferredDispatchContext?: () => void;
    discardQueuedItems?: (ctx: TContext) => void;
    applySessionShutdownState: (state: TelegramSessionShutdownState<TQueueItem>) => void;
    clearPendingMediaGroups: () => void;
    clearModelMenuState: () => void;
    getActiveTurnChatId: () => number | undefined;
    getActiveTurnTarget?: () => TelegramQueueTarget | undefined;
    clearPreview: (chatId: number, options?: {
        target?: TelegramQueueTarget;
    }) => Promise<void>;
    previewShutdownTimeoutMs?: number;
    clearActiveTurn: () => void;
    clearAbort: () => void;
    stopPolling: () => Promise<void>;
}
export type TelegramSessionLifecycleHookEvent = unknown;
export declare function createTelegramSessionStateApplier<TQueueItem, TModel>(deps: TelegramSessionStateApplierDeps<TQueueItem, TModel>): TelegramSessionStateApplier<TQueueItem, TModel>;
export interface TelegramQueueMutationRuntimeDeps<TContext> extends TelegramQueueStore<TContext>, TelegramRuntimeEventRecorderPort {
    ctx: TContext;
    allocateLaneOrder?: () => number;
    onItemsDiscarded?: (items: readonly TelegramQueueItem<TContext>[], ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export interface TelegramQueueMutationControllerDeps<TContext> extends TelegramQueueStore<TContext>, TelegramRuntimeEventRecorderPort {
    allocateLaneOrder?: () => number;
    onItemsDiscarded?: (items: readonly TelegramQueueItem<TContext>[], ctx: TContext) => void;
    updateStatus: (ctx: TContext) => void;
}
export interface TelegramQueueMutationController<TContext> {
    append: (item: TelegramQueueItem<TContext>, ctx: TContext) => void;
    reorder: (ctx: TContext) => void;
    clear: (ctx: TContext) => number;
    removeByMessageIds: (messageIds: number[], ctx: TContext, scope?: TelegramQueueMessageScope) => number;
    removeGuestPromptByQueueOrder?: (queueOrder: number, ctx: TContext) => boolean;
    applyReactionByMessageId: (messageId: number, disposition: TelegramQueueReactionDisposition, ctx: TContext, scope?: TelegramQueueMessageScope) => boolean;
}
export interface TelegramControlQueueControllerDeps<TContext> {
    appendControlItem: (item: PendingTelegramControlItem<TContext>, ctx: TContext) => void;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
}
export interface TelegramControlQueueController<TContext> {
    enqueue: (item: PendingTelegramControlItem<TContext>, ctx: TContext, onQueued?: (item: PendingTelegramControlItem<TContext>) => void) => void;
}
export type TelegramPreparedPromptTurn = (historyTurns: PendingTelegramTurn[]) => PendingTelegramTurn;
export interface TelegramPromptEnqueueRuntimeDeps<TMessage, TContext = unknown> extends TelegramQueueStore<TContext> {
    hasPendingDispatch: () => boolean;
    getFoldQueuedPromptsIntoHistory: () => boolean;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    prepareTurn: (messages: TMessage[]) => Promise<TelegramPreparedPromptTurn>;
    updateStatus: () => void;
    dispatchNextQueuedTelegramTurn: () => void;
    assertExecutionCurrent?: () => void;
    onQueued?: (turn: PendingTelegramTurn) => void;
}
export interface TelegramPromptEnqueueControllerDeps<TMessage, TContext = unknown> extends TelegramQueueStore<TContext> {
    hasPendingDispatch: () => boolean;
    getFoldQueuedPromptsIntoHistory: () => boolean;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
    prepareTurn: (messages: TMessage[], ctx: TContext) => Promise<TelegramPreparedPromptTurn>;
    updateStatus: (ctx: TContext) => void;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
    assertExecutionCurrent?: (messages: TMessage[]) => void;
}
export interface TelegramPromptEnqueueController<TMessage, TContext = unknown> {
    enqueue: (messages: TMessage[], ctx: TContext, onQueued?: (turn: PendingTelegramTurn) => void) => Promise<PendingTelegramTurn>;
}
export declare function buildTelegramSessionStartState<TModel = unknown>(currentModel: TModel | undefined): TelegramSessionStartState<TModel>;
export declare function buildTelegramSessionShutdownState<TQueueItem>(): TelegramSessionShutdownState<TQueueItem>;
export declare function startTelegramSessionRuntime<TContext, TModel = unknown>(deps: TelegramSessionStartRuntimeDeps<TContext, TModel>): Promise<void>;
export declare function shutdownTelegramSessionRuntime<TQueueItem>(deps: TelegramSessionShutdownRuntimeDeps<TQueueItem>): Promise<void>;
export type TelegramSessionLifecycleRuntimeDeps<TContext, TQueueItem, TModel = unknown> = Omit<TelegramSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel>, "applySessionStartState" | "applySessionShutdownState"> & TelegramSessionStateApplierDeps<TQueueItem, TModel>;
export declare function createTelegramSessionLifecycleRuntime<TContext, TQueueItem, TModel = unknown>(deps: TelegramSessionLifecycleRuntimeDeps<TContext, TQueueItem, TModel>): {
    onSessionStart: (_event: TelegramSessionLifecycleHookEvent, ctx: TContext) => Promise<void>;
    onSessionShutdown: (_event?: TelegramSessionLifecycleHookEvent, ctx?: TContext | undefined) => Promise<void>;
};
export declare function createTelegramSessionLifecycleHooks<TContext, TQueueItem, TModel = unknown>(deps: TelegramSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel>): {
    onSessionStart: (_event: TelegramSessionLifecycleHookEvent, ctx: TContext) => Promise<void>;
    onSessionShutdown: (_event?: TelegramSessionLifecycleHookEvent, ctx?: TContext) => Promise<void>;
};
export declare function createTelegramQueueMutationController<TContext>(deps: TelegramQueueMutationControllerDeps<TContext>): TelegramQueueMutationController<TContext>;
export declare function reorderTelegramQueueItemsRuntime<TContext>(deps: TelegramQueueMutationRuntimeDeps<TContext>): void;
export declare function clearTelegramQueueItemsRuntime<TContext>(deps: TelegramQueueMutationRuntimeDeps<TContext>): number;
export declare function removeTelegramQueueItemsByMessageIdsRuntime<TContext>(messageIds: number[], deps: TelegramQueueMutationRuntimeDeps<TContext>, scope?: TelegramQueueMessageScope): number;
export declare function removeTelegramQueuedGuestPromptByOrderRuntime<TContext>(queueOrder: number, deps: TelegramQueueMutationRuntimeDeps<TContext>): boolean;
export declare function applyTelegramQueuePromptReactionDispositionRuntime<TContext>(messageId: number, disposition: TelegramQueueReactionDisposition, deps: TelegramQueueMutationRuntimeDeps<TContext>, scope?: TelegramQueueMessageScope): boolean;
export declare function enqueueTelegramPromptTurnRuntime<TMessage, TContext = unknown>(messages: TMessage[], deps: TelegramPromptEnqueueRuntimeDeps<TMessage, TContext>): Promise<PendingTelegramTurn>;
export declare function createTelegramPromptEnqueueController<TMessage, TContext = unknown>(deps: TelegramPromptEnqueueControllerDeps<TMessage, TContext>): TelegramPromptEnqueueController<TMessage, TContext>;
export declare function createTelegramControlQueueController<TContext>(deps: TelegramControlQueueControllerDeps<TContext>): TelegramControlQueueController<TContext>;
export interface TelegramRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface TelegramControlRuntimeDeps<TContext> extends TelegramRuntimeEventRecorderPort {
    ctx: TContext;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        target?: TelegramQueueTarget;
    }) => Promise<number | undefined>;
    onSettled: (item: PendingTelegramControlItem<TContext>) => void;
}
export declare function executeTelegramControlItemRuntime<TContext>(item: PendingTelegramControlItem<TContext>, deps: TelegramControlRuntimeDeps<TContext>): Promise<void>;
export interface TelegramDeferredQueueDispatchRuntimeDeps extends TelegramRuntimeEventRecorderPort {
    delayMs?: number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface TelegramDeferredQueueDispatchRuntime<TContext = unknown> {
    bind: (ctx: TContext) => void;
    unbind: () => void;
    isBound: () => boolean;
    getGeneration: () => number;
    isGenerationActive: (generation: number) => boolean;
    request: (dispatchNextQueuedTelegramTurn: (ctx: TContext) => void) => void;
}
/**
 * Production debounce for deferred queue dispatch; the factory defaults to this
 * so the entrypoint wires ports instead of policy constants.
 */
export declare const TELEGRAM_DEFERRED_DISPATCH_DELAY_MS = 50;
export declare function createTelegramDeferredQueueDispatchRuntime<TContext = unknown>(deps?: TelegramDeferredQueueDispatchRuntimeDeps): TelegramDeferredQueueDispatchRuntime<TContext>;
export interface TelegramQueueDispatchWatchdogRuntime<TContext = unknown> {
    start: (ctx: TContext) => void;
    stop: () => void;
    poke: () => void;
}
export interface TelegramQueueDispatchWatchdogRuntimeDeps<TContext = unknown> extends TelegramRuntimeEventRecorderPort {
    hasQueuedItems: () => boolean;
    dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
    intervalMs?: number;
    setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}
export declare function createTelegramQueueDispatchWatchdogRuntime<TContext = unknown>(deps: TelegramQueueDispatchWatchdogRuntimeDeps<TContext>): TelegramQueueDispatchWatchdogRuntime<TContext>;
export interface TelegramPromptDeliveryOptions {
    deliverAs: "followUp";
}
export interface TelegramDispatchRuntimeDeps<TContext = unknown> {
    executeControlItem: (item: Extract<TelegramQueueDispatchAction<TContext>, {
        kind: "control";
    }>["item"]) => void;
    onPromptDispatchStart: (chatId: number) => void;
    commitPromptDispatch?: (item: Extract<TelegramQueueDispatchAction<TContext>, {
        kind: "prompt";
    }>["item"]) => boolean;
    sendUserMessage: (content: Extract<TelegramQueueDispatchAction, {
        kind: "prompt";
    }>["item"]["content"], options?: TelegramPromptDeliveryOptions) => void;
    onPromptDispatchFailure: (message: string) => void;
    onIdle: () => void;
}
export interface TelegramQueueDispatchControllerDeps<TContext = unknown> extends TelegramRuntimeEventRecorderPort {
    getQueuedItems: () => TelegramQueueItem<TContext>[];
    setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
    canDispatch: (ctx: TContext) => boolean;
    hasDispatchContext?: () => boolean;
    getDispatchGeneration?: () => number;
    isDispatchGenerationActive?: (generation: number) => boolean;
    updateStatus: (ctx: TContext, error?: string) => void;
    sendTextReply: TelegramControlRuntimeDeps<TContext>["sendTextReply"];
    onPromptDispatchStart: (ctx: TContext, chatId: number) => void;
    commitPromptDispatch?: (item: Extract<TelegramQueueDispatchAction<TContext>, {
        kind: "prompt";
    }>["item"], ctx: TContext) => boolean;
    sendUserMessage: TelegramDispatchRuntimeDeps<TContext>["sendUserMessage"];
    onPromptDispatchFailure: (ctx: TContext, message: string) => void;
    reconcileNextDispatchAnnouncementReplyOwnership?: (item: PendingTelegramTurn) => void;
    isQueueItemTransportActive?: (item: TelegramQueueItem<TContext>) => boolean;
    hasPendingInboundQueueMutationForItem?: (item: TelegramQueueItem<TContext>) => boolean;
    isQueueItemAdmissionReady?: (item: TelegramQueueItem<TContext>) => boolean;
    onControlSettled?: (item: PendingTelegramControlItem<TContext>, ctx: TContext) => void;
    onPromptSkipped?: (item: PendingTelegramTurn, ctx: TContext) => boolean;
}
export interface TelegramQueueDispatchController<TContext = unknown> {
    dispatchNext: (ctx: TContext) => void;
    requestNextDispatchAnnouncement: () => void;
    cancelNextDispatchAnnouncement: () => void;
}
export declare function executeTelegramQueueDispatchPlan<TContext = unknown>(plan: TelegramQueueDispatchAction<TContext>, deps: TelegramDispatchRuntimeDeps<TContext>): void;
export type TelegramQueueDispatchRuntimeDeps<TContext = unknown> = Omit<TelegramQueueDispatchControllerDeps<TContext>, "canDispatch"> & TelegramDispatchReadinessDeps<TContext>;
export declare function createTelegramQueueDispatchRuntime<TContext = unknown>(deps: TelegramQueueDispatchRuntimeDeps<TContext>): TelegramQueueDispatchController<TContext>;
export declare function createTelegramQueueDispatchController<TContext = unknown>(deps: TelegramQueueDispatchControllerDeps<TContext>): TelegramQueueDispatchController<TContext>;
