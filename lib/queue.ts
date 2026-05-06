/**
 * Telegram queue core contracts and pure planning helpers
 * Zones: telegram queue, pi agent lifecycle, scheduling
 * Owns queue item contracts, lane admission, pure queue mutations, and dispatch planning
 */

// --- Queue Items ---

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

export type TelegramPromptContent =
  | TelegramPromptTextContent
  | TelegramPromptImageContent;

export type TelegramQueueItemKind = "prompt" | "control";
export type TelegramQueueLane = "control" | "priority" | "default";
export type TelegramQueueAdmissionMode =
  | "control-queue"
  | "priority-queue"
  | "default-queue";

export interface TelegramQueueLaneContract {
  lane: TelegramQueueLane;
  admissionMode: TelegramQueueAdmissionMode;
  dispatchRank: number;
  allowedKinds: readonly TelegramQueueItemKind[];
}

export const TELEGRAM_QUEUE_LANE_CONTRACTS: readonly TelegramQueueLaneContract[] =
  [
    {
      lane: "control",
      admissionMode: "control-queue",
      dispatchRank: 0,
      allowedKinds: ["control", "prompt"],
    },
    {
      lane: "priority",
      admissionMode: "priority-queue",
      dispatchRank: 1,
      allowedKinds: ["prompt"],
    },
    {
      lane: "default",
      admissionMode: "default-queue",
      dispatchRank: 2,
      allowedKinds: ["prompt"],
    },
  ] as const;

export interface TelegramQueueItemBase {
  kind: TelegramQueueItemKind;
  chatId: number;
  replyToMessageId: number;
  queueOrder: number;
  queueLane: TelegramQueueLane;
  laneOrder: number;
  statusSummary: string;
}

export interface PendingTelegramTurn extends TelegramQueueItemBase {
  kind: "prompt";
  sourceMessageIds: number[];
  queuedAttachments: QueuedAttachment[];
  content: TelegramPromptContent[];
  historyText: string;
  priorityEmoji?: string;
}

export interface PendingTelegramControlItem<
  TContext = unknown,
> extends TelegramQueueItemBase {
  kind: "control";
  controlType: "status" | "model";
  execute: (ctx: TContext) => Promise<void>;
}

export type TelegramQueueItem<TContext = unknown> =
  | PendingTelegramTurn
  | PendingTelegramControlItem<TContext>;

export interface TelegramQueueStore<TContext = unknown> {
  getQueuedItems: () => TelegramQueueItem<TContext>[];
  setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
}

export interface TelegramQueueStateStore<
  TContext = unknown,
> extends TelegramQueueStore<TContext> {
  hasQueuedItems: () => boolean;
}

export interface TelegramActiveTurnStore<
  TTurn extends PendingTelegramTurn = PendingTelegramTurn,
> {
  get: () => TTurn | undefined;
  has: () => boolean;
  set: (turn: TTurn) => void;
  clear: () => void;
  getChatId: () => number | undefined;
  getReplyToMessageId: () => number | undefined;
  getSourceMessageIds: () => number[] | undefined;
}

export interface TelegramDispatchGuardState {
  compactionInProgress: boolean;
  hasActiveTelegramTurn: boolean;
  hasPendingTelegramDispatch: boolean;
  isIdle: boolean;
  hasPendingMessages: boolean;
}

export function getTelegramQueueLaneContract(
  lane: TelegramQueueLane,
): TelegramQueueLaneContract {
  const contract = TELEGRAM_QUEUE_LANE_CONTRACTS.find(
    (entry) => entry.lane === lane,
  );
  if (!contract) throw new Error(`Unknown Telegram queue lane: ${lane}`);
  return contract;
}

export function getTelegramQueueItemAdmissionMode(
  item: Pick<TelegramQueueItem, "queueLane">,
): TelegramQueueAdmissionMode {
  return getTelegramQueueLaneContract(item.queueLane).admissionMode;
}

export function isTelegramQueueItemAdmissionValid(
  item: Pick<TelegramQueueItem, "kind" | "queueLane">,
): boolean {
  return getTelegramQueueLaneContract(item.queueLane).allowedKinds.includes(
    item.kind,
  );
}

export function assertTelegramQueueItemAdmissionValid(
  item: Pick<TelegramQueueItem, "kind" | "queueLane">,
): void {
  if (isTelegramQueueItemAdmissionValid(item)) return;
  throw new Error(
    `Invalid Telegram queue admission: ${item.kind} item cannot use ${item.queueLane} lane`,
  );
}

function getTelegramQueueLaneRank(lane: TelegramQueueLane): number {
  return getTelegramQueueLaneContract(lane).dispatchRank;
}

export function isPendingTelegramTurn<TContext = unknown>(
  item: TelegramQueueItem<TContext>,
): item is PendingTelegramTurn {
  return item.kind === "prompt";
}

export function createTelegramQueueStore<TContext = unknown>(
  initialItems: TelegramQueueItem<TContext>[] = [],
): TelegramQueueStateStore<TContext> {
  let queuedItems = initialItems;
  return {
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    hasQueuedItems: () => queuedItems.length > 0,
  };
}

export function createTelegramQueueItemCountGetter<TContext = unknown>(
  store: Pick<TelegramQueueStore<TContext>, "getQueuedItems">,
): () => number {
  return function getTelegramQueueItemCount() {
    return store.getQueuedItems().length;
  };
}

export function createTelegramActiveTurnStore<
  TTurn extends PendingTelegramTurn = PendingTelegramTurn,
>(): TelegramActiveTurnStore<TTurn> {
  let activeTurn: TTurn | undefined;
  return {
    get: () => activeTurn,
    has: () => !!activeTurn,
    set: (turn) => {
      activeTurn = { ...turn };
    },
    clear: () => {
      activeTurn = undefined;
    },
    getChatId: () => activeTurn?.chatId,
    getReplyToMessageId: () => activeTurn?.replyToMessageId,
    getSourceMessageIds: () => activeTurn?.sourceMessageIds,
  };
}

// --- Queue Mutations ---

export function partitionTelegramQueueItemsForHistory<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
): {
  historyTurns: PendingTelegramTurn[];
  remainingItems: TelegramQueueItem<TContext>[];
} {
  const historyTurns: PendingTelegramTurn[] = [];
  const remainingItems: TelegramQueueItem<TContext>[] = [];
  for (const item of items) {
    if (isPendingTelegramTurn(item)) {
      historyTurns.push(item);
      continue;
    }
    remainingItems.push(item);
  }
  return { historyTurns, remainingItems };
}

export function planTelegramPromptEnqueue<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  preserveQueuedTurnsAsHistory: boolean,
): {
  historyTurns: PendingTelegramTurn[];
  remainingItems: TelegramQueueItem<TContext>[];
} {
  if (!preserveQueuedTurnsAsHistory) {
    return { historyTurns: [], remainingItems: items };
  }
  return partitionTelegramQueueItemsForHistory(items);
}

export function appendTelegramQueueItem<
  TContext = unknown,
  TItem extends TelegramQueueItem<TContext> = TelegramQueueItem<TContext>,
>(
  items: TelegramQueueItem<TContext>[],
  item: TItem,
): TelegramQueueItem<TContext>[] {
  assertTelegramQueueItemAdmissionValid(item);
  return [...items, item];
}

export function compareTelegramQueueItems<TContext = unknown>(
  left: TelegramQueueItem<TContext>,
  right: TelegramQueueItem<TContext>,
): number {
  assertTelegramQueueItemAdmissionValid(left);
  assertTelegramQueueItemAdmissionValid(right);
  const laneRankDelta =
    getTelegramQueueLaneRank(left.queueLane) -
    getTelegramQueueLaneRank(right.queueLane);
  if (laneRankDelta !== 0) return laneRankDelta;
  if (left.laneOrder !== right.laneOrder) {
    return left.laneOrder - right.laneOrder;
  }
  return left.queueOrder - right.queueOrder;
}

export function removeTelegramQueueItemsByMessageIds<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  messageIds: number[],
): { items: TelegramQueueItem<TContext>[]; removedCount: number } {
  if (messageIds.length === 0 || items.length === 0) {
    return { items, removedCount: 0 };
  }
  const deletedMessageIds = new Set(messageIds);
  const nextItems = items.filter((item) => {
    if (!isPendingTelegramTurn(item)) return true;
    return !item.sourceMessageIds.some((messageId) =>
      deletedMessageIds.has(messageId),
    );
  });
  return {
    items: nextItems,
    removedCount: items.length - nextItems.length,
  };
}

export function clearTelegramQueuePromptPriority<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  messageId: number,
): { items: TelegramQueueItem<TContext>[]; changed: boolean } {
  let changed = false;
  const nextItems = items.map((item) => {
    if (
      !isPendingTelegramTurn(item) ||
      !item.sourceMessageIds.includes(messageId) ||
      item.queueLane !== "priority"
    ) {
      return item;
    }
    changed = true;
    return {
      ...item,
      queueLane: "default" as const,
      laneOrder: item.queueOrder,
      priorityEmoji: undefined,
    };
  });
  return { items: nextItems, changed };
}

export function prioritizeTelegramQueuePrompt<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  messageId: number,
  laneOrder: number,
  priorityEmoji = "⚡",
): { items: TelegramQueueItem<TContext>[]; changed: boolean } {
  let changed = false;
  const nextItems = items.map((item) => {
    if (
      !isPendingTelegramTurn(item) ||
      !item.sourceMessageIds.includes(messageId)
    ) {
      return item;
    }
    changed = true;
    return {
      ...item,
      queueLane: "priority" as const,
      laneOrder,
      priorityEmoji,
    };
  });
  return { items: nextItems, changed };
}

export function consumeDispatchedTelegramPrompt<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  hasPendingDispatch: boolean,
): {
  activeTurn?: PendingTelegramTurn;
  remainingItems: TelegramQueueItem<TContext>[];
} {
  if (!hasPendingDispatch) {
    return { activeTurn: undefined, remainingItems: items };
  }
  const nextItem = items[0];
  if (!nextItem || !isPendingTelegramTurn(nextItem)) {
    return { activeTurn: undefined, remainingItems: items };
  }
  return { activeTurn: nextItem, remainingItems: items.slice(1) };
}

function formatTelegramQueueItemStatusSummary<TContext = unknown>(
  item: TelegramQueueItem<TContext>,
): string {
  if (item.queueLane === "priority") {
    return `${item.kind === "prompt" ? item.priorityEmoji ?? "⚡" : "⚡"} ${item.statusSummary}`;
  }
  return item.statusSummary;
}

export function formatQueuedTelegramItemsStatus<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
): string {
  if (items.length === 0) return "";
  const previewCount = 4;
  const summaries = items
    .slice(0, previewCount)
    .map(formatTelegramQueueItemStatusSummary)
    .filter(Boolean);
  if (summaries.length === 0) return ` +${items.length}`;
  const suffix = items.length > summaries.length ? ", …" : "";
  return ` +${items.length}: [${summaries.join(", ")}${suffix}]`;
}

export function canDispatchTelegramTurnState(
  state: TelegramDispatchGuardState,
): boolean {
  return (
    !state.compactionInProgress &&
    !state.hasActiveTelegramTurn &&
    !state.hasPendingTelegramDispatch &&
    state.isIdle &&
    !state.hasPendingMessages
  );
}

export interface TelegramDispatchReadinessDeps<TContext> {
  isCompactionInProgress: () => boolean;
  hasActiveTurn: () => boolean;
  hasDispatchPending: () => boolean;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
}

export function createTelegramDispatchReadinessChecker<TContext>(
  deps: TelegramDispatchReadinessDeps<TContext>,
): (ctx: TContext) => boolean {
  return (ctx) =>
    canDispatchTelegramTurnState({
      compactionInProgress: deps.isCompactionInProgress(),
      hasActiveTelegramTurn: deps.hasActiveTurn(),
      hasPendingTelegramDispatch: deps.hasDispatchPending(),
      isIdle: deps.isIdle(ctx),
      hasPendingMessages: deps.hasPendingMessages(ctx),
    });
}

export function buildPendingTelegramControlItem<TContext = unknown>(options: {
  chatId: number;
  replyToMessageId: number;
  controlType: PendingTelegramControlItem<TContext>["controlType"];
  queueOrder: number;
  laneOrder: number;
  statusSummary: string;
  execute: PendingTelegramControlItem<TContext>["execute"];
}): PendingTelegramControlItem<TContext> {
  return {
    kind: "control",
    controlType: options.controlType,
    chatId: options.chatId,
    replyToMessageId: options.replyToMessageId,
    queueOrder: options.queueOrder,
    queueLane: "control",
    laneOrder: options.laneOrder,
    statusSummary: options.statusSummary,
    execute: options.execute,
  };
}

export interface TelegramControlItemBuilderDeps {
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
}

export function createTelegramControlItemBuilder<TContext = unknown>(
  deps: TelegramControlItemBuilderDeps,
): (options: {
  chatId: number;
  replyToMessageId: number;
  controlType: PendingTelegramControlItem<TContext>["controlType"];
  statusSummary: string;
  execute: PendingTelegramControlItem<TContext>["execute"];
}) => PendingTelegramControlItem<TContext> {
  return (options) =>
    buildPendingTelegramControlItem<TContext>({
      ...options,
      queueOrder: deps.allocateItemOrder(),
      laneOrder: deps.allocateControlOrder(),
    });
}

// --- Dispatch Planning ---

export type TelegramQueueDispatchAction<TContext = unknown> =
  | { kind: "none"; remainingItems: TelegramQueueItem<TContext>[] }
  | {
      kind: "control";
      item: PendingTelegramControlItem<TContext>;
      remainingItems: TelegramQueueItem<TContext>[];
    }
  | {
      kind: "prompt";
      item: PendingTelegramTurn;
      remainingItems: TelegramQueueItem<TContext>[];
    };

export function planNextTelegramQueueAction<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  canDispatch: boolean,
): TelegramQueueDispatchAction<TContext> {
  if (!canDispatch || items.length === 0) {
    return { kind: "none", remainingItems: items };
  }
  const [firstItem, ...remainingItems] = items;
  if (!firstItem) {
    return { kind: "none", remainingItems: items };
  }
  assertTelegramQueueItemAdmissionValid(firstItem);
  if (isPendingTelegramTurn(firstItem)) {
    return { kind: "prompt", item: firstItem, remainingItems: items };
  }
  return { kind: "control", item: firstItem, remainingItems };
}

export function shouldDispatchAfterTelegramAgentEnd(options: {
  hasTurn: boolean;
  stopReason?: string;
  preserveQueuedTurnsAsHistory: boolean;
}): boolean {
  if (!options.hasTurn) return true;
  if (options.stopReason === "aborted") {
    return !options.preserveQueuedTurnsAsHistory;
  }
  return true;
}

// --- Agent Runtime ---

export interface TelegramAgentStartPlan<TContext = unknown> {
  activeTurn?: PendingTelegramTurn;
  remainingItems: TelegramQueueItem<TContext>[];
  shouldResetPendingModelSwitch: boolean;
  shouldResetToolExecutions: boolean;
  shouldClearDispatchPending: boolean;
}

export interface TelegramAgentStartRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TContext = unknown,
> {
  queuedItems: TelegramQueueItem<TContext>[];
  hasPendingDispatch: boolean;
  hasActiveTurn: boolean;
  resetToolExecutions: () => void;
  resetPendingModelSwitch: () => void;
  setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
  clearDispatchPending: () => void;
  setActiveTurn: (turn: TTurn) => void;
  createPreviewState: () => void;
  startTypingLoop: () => void;
  updateStatus: () => void;
}

export interface TelegramAgentStartHookRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TContext = unknown,
> {
  setAbortHandler: (ctx: TContext) => void;
  getQueuedItems: () => TelegramQueueItem<TContext>[];
  hasPendingDispatch: () => boolean;
  hasActiveTurn: () => boolean;
  resetToolExecutions: () => void;
  resetPendingModelSwitch: () => void;
  setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
  clearDispatchPending: () => void;
  setActiveTurn: (turn: TTurn) => void;
  createPreviewState: () => void;
  startTypingLoop: (ctx: TContext) => void;
  updateStatus: (ctx: TContext) => void;
}

export type TelegramAgentStartHookEvent = unknown;

export interface TelegramToolExecutionRuntimeDeps {
  hasActiveTurn: () => boolean;
  getActiveToolExecutions: () => number;
  setActiveToolExecutions: (count: number) => void;
}

export interface TelegramToolExecutionEndRuntimeDeps extends TelegramToolExecutionRuntimeDeps {
  triggerPendingModelSwitchAbort: () => void;
}

export interface TelegramToolExecutionHookRuntimeDeps<
  TContext,
> extends TelegramToolExecutionRuntimeDeps {
  triggerPendingModelSwitchAbort: (ctx: TContext) => unknown;
}

export type TelegramToolExecutionHookEvent = unknown;

export function buildTelegramAgentStartPlan<TContext = unknown>(options: {
  queuedItems: TelegramQueueItem<TContext>[];
  hasPendingDispatch: boolean;
  hasActiveTurn: boolean;
}): TelegramAgentStartPlan<TContext> {
  if (options.hasActiveTurn || !options.hasPendingDispatch) {
    return {
      activeTurn: undefined,
      remainingItems: options.queuedItems,
      shouldResetPendingModelSwitch: true,
      shouldResetToolExecutions: true,
      shouldClearDispatchPending: options.hasPendingDispatch,
    };
  }
  const nextDispatch = consumeDispatchedTelegramPrompt(
    options.queuedItems,
    options.hasPendingDispatch,
  );
  return {
    activeTurn: nextDispatch.activeTurn,
    remainingItems: nextDispatch.remainingItems,
    shouldResetPendingModelSwitch: true,
    shouldResetToolExecutions: true,
    shouldClearDispatchPending: options.hasPendingDispatch,
  };
}

export function handleTelegramAgentStartRuntime<
  TTurn extends PendingTelegramTurn,
  TContext = unknown,
>(deps: TelegramAgentStartRuntimeDeps<TTurn, TContext>): void {
  const startPlan = buildTelegramAgentStartPlan({
    queuedItems: deps.queuedItems,
    hasPendingDispatch: deps.hasPendingDispatch,
    hasActiveTurn: deps.hasActiveTurn,
  });
  if (startPlan.shouldResetToolExecutions) deps.resetToolExecutions();
  if (startPlan.shouldResetPendingModelSwitch) deps.resetPendingModelSwitch();
  deps.setQueuedItems(startPlan.remainingItems);
  if (startPlan.shouldClearDispatchPending) deps.clearDispatchPending();
  if (startPlan.activeTurn) {
    deps.setActiveTurn(startPlan.activeTurn as TTurn);
    deps.createPreviewState();
    deps.startTypingLoop();
  }
  deps.updateStatus();
}

export function createTelegramAgentStartHook<
  TTurn extends PendingTelegramTurn,
  TContext = unknown,
>(deps: TelegramAgentStartHookRuntimeDeps<TTurn, TContext>) {
  return async function onAgentStart(
    _event: TelegramAgentStartHookEvent,
    ctx: TContext,
  ): Promise<void> {
    deps.setAbortHandler(ctx);
    handleTelegramAgentStartRuntime<TTurn, TContext>({
      queuedItems: deps.getQueuedItems(),
      hasPendingDispatch: deps.hasPendingDispatch(),
      hasActiveTurn: deps.hasActiveTurn(),
      resetToolExecutions: deps.resetToolExecutions,
      resetPendingModelSwitch: deps.resetPendingModelSwitch,
      setQueuedItems: deps.setQueuedItems,
      clearDispatchPending: deps.clearDispatchPending,
      setActiveTurn: deps.setActiveTurn,
      createPreviewState: deps.createPreviewState,
      startTypingLoop: () => deps.startTypingLoop(ctx),
      updateStatus: () => deps.updateStatus(ctx),
    });
  };
}

export function getNextTelegramToolExecutionCount(options: {
  hasActiveTurn: boolean;
  currentCount: number;
  event: "start" | "end";
}): number {
  if (!options.hasActiveTurn) return options.currentCount;
  if (options.event === "start") {
    return options.currentCount + 1;
  }
  return Math.max(0, options.currentCount - 1);
}

export function handleTelegramToolExecutionStartRuntime(
  deps: TelegramToolExecutionRuntimeDeps,
): void {
  deps.setActiveToolExecutions(
    getNextTelegramToolExecutionCount({
      hasActiveTurn: deps.hasActiveTurn(),
      currentCount: deps.getActiveToolExecutions(),
      event: "start",
    }),
  );
}

export function handleTelegramToolExecutionEndRuntime(
  deps: TelegramToolExecutionEndRuntimeDeps,
): void {
  const hasActiveTurn = deps.hasActiveTurn();
  deps.setActiveToolExecutions(
    getNextTelegramToolExecutionCount({
      hasActiveTurn,
      currentCount: deps.getActiveToolExecutions(),
      event: "end",
    }),
  );
  if (hasActiveTurn) deps.triggerPendingModelSwitchAbort();
}

export type TelegramAgentLifecycleHooksRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TContext,
  TMessage,
  TReplyMarkup = unknown,
> = TelegramAgentStartHookRuntimeDeps<TTurn, TContext> &
  TelegramAgentEndHookRuntimeDeps<TTurn, TContext, TMessage, TReplyMarkup> &
  TelegramToolExecutionHookRuntimeDeps<TContext>;

export function createTelegramAgentLifecycleHooks<
  TTurn extends PendingTelegramTurn,
  TContext,
  TMessage,
  TReplyMarkup = unknown,
>(
  deps: TelegramAgentLifecycleHooksRuntimeDeps<
    TTurn,
    TContext,
    TMessage,
    TReplyMarkup
  >,
) {
  return {
    onAgentStart: createTelegramAgentStartHook<TTurn, TContext>(deps),
    onAgentEnd: createTelegramAgentEndHook<
      TTurn,
      TContext,
      TMessage,
      TReplyMarkup
    >(deps),
    ...createTelegramToolExecutionHooks<TContext>(deps),
  };
}

export function createTelegramToolExecutionHooks<TContext>(
  deps: TelegramToolExecutionHookRuntimeDeps<TContext>,
) {
  return {
    onToolExecutionStart: (): void => {
      handleTelegramToolExecutionStartRuntime(deps);
    },
    onToolExecutionEnd: (
      _event: TelegramToolExecutionHookEvent,
      ctx: TContext,
    ): void => {
      handleTelegramToolExecutionEndRuntime({
        hasActiveTurn: deps.hasActiveTurn,
        getActiveToolExecutions: deps.getActiveToolExecutions,
        setActiveToolExecutions: deps.setActiveToolExecutions,
        triggerPendingModelSwitchAbort: () => {
          deps.triggerPendingModelSwitchAbort(ctx);
        },
      });
    },
  };
}

// --- Agent End Lifecycle ---

export interface TelegramAgentEndPlan {
  kind: "no-turn" | "aborted" | "error" | "text" | "attachments-only" | "empty";
  shouldClearPreview: boolean;
  shouldDispatchNext: boolean;
  shouldSendErrorMessage: boolean;
  shouldSendAttachmentNotice: boolean;
}

export interface TelegramAgentEndAssistantResult {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
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

export interface TelegramAgentEndRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TReplyMarkup = unknown,
> {
  turn: TTurn | undefined;
  assistant: TelegramAgentEndAssistantResult;
  preserveQueuedTurnsAsHistory: boolean;
  resetRuntimeState: () => void;
  updateStatus: () => void;
  isCurrentOwner?: () => boolean;
  dispatchNextQueuedTelegramTurn: () => void;
  clearPreview: (chatId: number) => Promise<void>;
  setPreviewPendingText: (text: string) => void;
  finalizeMarkdownPreview: (
    chatId: number,
    markdown: string,
    replyToMessageId: number,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<boolean>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<unknown>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
  sendQueuedAttachments: (turn: TTurn) => Promise<void>;
  planOutboundReply?: (
    markdown: string,
  ) => TelegramAgentEndOutboundReplyPlan<TReplyMarkup>;
  sendOutboundReplyArtifacts?: (
    turn: TTurn,
    plan: TelegramAgentEndOutboundReplyPlan,
    options?: { replyToPrompt?: boolean },
  ) => Promise<void>;
}

export interface TelegramAgentEndHookRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TContext,
  TMessage,
  TReplyMarkup = unknown,
> {
  getActiveTurn: () => TTurn | undefined;
  extractAssistant: (
    messages: readonly TMessage[],
  ) => TelegramAgentEndAssistantResult;
  getPreserveQueuedTurnsAsHistory: () => boolean;
  resetRuntimeState: () => void;
  updateStatus: (ctx: TContext) => void;
  isCurrentOwner?: (ctx: TContext) => boolean;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  requestDeferredDispatchNextQueuedTelegramTurn: (
    dispatch: (ctx: TContext) => void,
  ) => void;
  clearPreview: (chatId: number) => Promise<void>;
  setPreviewPendingText: (text: string) => void;
  finalizeMarkdownPreview: TelegramAgentEndRuntimeDeps<
    TTurn,
    TReplyMarkup
  >["finalizeMarkdownPreview"];
  sendMarkdownReply: TelegramAgentEndRuntimeDeps<
    TTurn,
    TReplyMarkup
  >["sendMarkdownReply"];
  sendTextReply: TelegramAgentEndRuntimeDeps<TTurn>["sendTextReply"];
  sendQueuedAttachments: (turn: TTurn) => Promise<void>;
  planOutboundReply?: TelegramAgentEndRuntimeDeps<
    TTurn,
    TReplyMarkup
  >["planOutboundReply"];
  sendOutboundReplyArtifacts?: TelegramAgentEndRuntimeDeps<TTurn>["sendOutboundReplyArtifacts"];
}

export interface TelegramAgentEndHookEvent<TMessage> {
  messages: readonly TMessage[];
}

export function buildTelegramAgentEndPlan(options: {
  hasTurn: boolean;
  stopReason?: string;
  hasFinalText: boolean;
  hasQueuedAttachments: boolean;
  preserveQueuedTurnsAsHistory: boolean;
}): TelegramAgentEndPlan {
  const shouldDispatchNext = shouldDispatchAfterTelegramAgentEnd({
    hasTurn: options.hasTurn,
    stopReason: options.stopReason,
    preserveQueuedTurnsAsHistory: options.preserveQueuedTurnsAsHistory,
  });
  if (!options.hasTurn) {
    return {
      kind: "no-turn",
      shouldClearPreview: false,
      shouldDispatchNext,
      shouldSendErrorMessage: false,
      shouldSendAttachmentNotice: false,
    };
  }
  if (options.stopReason === "aborted") {
    return {
      kind: "aborted",
      shouldClearPreview: true,
      shouldDispatchNext,
      shouldSendErrorMessage: false,
      shouldSendAttachmentNotice: false,
    };
  }
  if (options.stopReason === "error") {
    return {
      kind: "error",
      shouldClearPreview: true,
      shouldDispatchNext,
      shouldSendErrorMessage: true,
      shouldSendAttachmentNotice: false,
    };
  }
  if (options.hasFinalText) {
    return {
      kind: "text",
      shouldClearPreview: false,
      shouldDispatchNext,
      shouldSendErrorMessage: false,
      shouldSendAttachmentNotice: false,
    };
  }
  if (options.hasQueuedAttachments) {
    return {
      kind: "attachments-only",
      shouldClearPreview: true,
      shouldDispatchNext,
      shouldSendErrorMessage: false,
      shouldSendAttachmentNotice: true,
    };
  }
  return {
    kind: "empty",
    shouldClearPreview: true,
    shouldDispatchNext,
    shouldSendErrorMessage: false,
    shouldSendAttachmentNotice: false,
  };
}

export function createTelegramAgentEndHook<
  TTurn extends PendingTelegramTurn,
  TContext,
  TMessage,
  TReplyMarkup = unknown,
>(
  deps: TelegramAgentEndHookRuntimeDeps<
    TTurn,
    TContext,
    TMessage,
    TReplyMarkup
  >,
) {
  return async function onAgentEnd(
    event: TelegramAgentEndHookEvent<TMessage>,
    ctx: TContext,
  ): Promise<void> {
    const turn = deps.getActiveTurn();
    await handleTelegramAgentEndRuntime({
      turn,
      assistant: turn ? deps.extractAssistant(event.messages) : {},
      preserveQueuedTurnsAsHistory: deps.getPreserveQueuedTurnsAsHistory(),
      resetRuntimeState: deps.resetRuntimeState,
      updateStatus: () => deps.updateStatus(ctx),
      isCurrentOwner: deps.isCurrentOwner
        ? () => deps.isCurrentOwner?.(ctx) ?? false
        : undefined,
      dispatchNextQueuedTelegramTurn: () => {
        deps.requestDeferredDispatchNextQueuedTelegramTurn(
          deps.dispatchNextQueuedTelegramTurn,
        );
      },
      clearPreview: deps.clearPreview,
      setPreviewPendingText: deps.setPreviewPendingText,
      finalizeMarkdownPreview: deps.finalizeMarkdownPreview,
      sendMarkdownReply: deps.sendMarkdownReply,
      sendTextReply: deps.sendTextReply,
      sendQueuedAttachments: deps.sendQueuedAttachments,
      planOutboundReply: deps.planOutboundReply,
      sendOutboundReplyArtifacts: deps.sendOutboundReplyArtifacts,
    });
  };
}

export async function handleTelegramAgentEndRuntime<
  TTurn extends PendingTelegramTurn,
  TReplyMarkup = unknown,
>(deps: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>): Promise<void> {
  const { turn, assistant } = deps;
  const rawFinalText = assistant.text;
  const outboundReply = rawFinalText
    ? deps.planOutboundReply?.(rawFinalText)
    : undefined;
  const finalText = outboundReply ? outboundReply.markdown : rawFinalText;
  const hasOutboundArtifacts =
    !!outboundReply?.voiceText || !!outboundReply?.voiceReplies?.length;
  const replyMarkup = outboundReply?.replyMarkup;
  deps.resetRuntimeState();
  deps.updateStatus();
  if (turn && deps.isCurrentOwner && !deps.isCurrentOwner()) {
    await deps.clearPreview(turn.chatId);
    return;
  }
  const endPlan = buildTelegramAgentEndPlan({
    hasTurn: !!turn,
    stopReason: assistant.stopReason,
    hasFinalText: !!finalText || hasOutboundArtifacts,
    hasQueuedAttachments: (turn?.queuedAttachments.length ?? 0) > 0,
    preserveQueuedTurnsAsHistory: deps.preserveQueuedTurnsAsHistory,
  });
  if (!turn) {
    if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
    return;
  }
  if (endPlan.shouldClearPreview) {
    await deps.clearPreview(turn.chatId);
  }
  if (endPlan.shouldSendErrorMessage) {
    await deps.sendTextReply(
      turn.chatId,
      turn.replyToMessageId,
      assistant.errorMessage ||
        "Telegram bridge: π failed while processing the request.",
    );
    if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
    return;
  }
  if (finalText) deps.setPreviewPendingText(finalText);
  if (!finalText && hasOutboundArtifacts) await deps.clearPreview(turn.chatId);
  if (endPlan.kind === "text" && finalText) {
    const finalized = await deps.finalizeMarkdownPreview(
      turn.chatId,
      finalText,
      turn.replyToMessageId,
      { replyMarkup },
    );
    if (!finalized) {
      await deps.clearPreview(turn.chatId);
      await deps.sendMarkdownReply(
        turn.chatId,
        turn.replyToMessageId,
        finalText,
        { replyMarkup },
      );
    }
  }
  if (outboundReply && deps.sendOutboundReplyArtifacts) {
    await deps.sendOutboundReplyArtifacts(turn, outboundReply, {
      replyToPrompt: !finalText,
    });
  }
  if (endPlan.shouldSendAttachmentNotice) {
    await deps.sendTextReply(
      turn.chatId,
      turn.replyToMessageId,
      "Attached requested file(s).",
    );
  }
  await deps.sendQueuedAttachments(turn);
  if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
}

// --- Session Runtime ---

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
  nextPriorityReactionOrder: number;
  currentTelegramModel: undefined;
  activeTelegramToolExecutions: number;
  pendingTelegramModelSwitch: undefined;
  telegramTurnDispatchPending: boolean;
  compactionInProgress: boolean;
  preserveQueuedTurnsAsHistory: boolean;
}

export interface TelegramSessionRuntimeCounterState {
  nextQueuedTelegramItemOrder?: number;
  nextQueuedTelegramControlOrder?: number;
  nextPriorityReactionOrder?: number;
}

export interface TelegramSessionRuntimeFlagState {
  activeTelegramToolExecutions?: number;
  telegramTurnDispatchPending?: boolean;
  compactionInProgress?: boolean;
  preserveQueuedTurnsAsHistory?: boolean;
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
  applyState: (state: TelegramSessionStartState<TModel>) => void;
  bindDeferredDispatchContext?: (ctx: TContext) => void;
  prepareTempDir: () => Promise<unknown>;
  updateStatus: () => void;
}

export interface TelegramSessionShutdownRuntimeDeps<TQueueItem> {
  unbindDeferredDispatchContext?: () => void;
  applyState: (state: TelegramSessionShutdownState<TQueueItem>) => void;
  clearPendingMediaGroups: () => void;
  clearModelMenuState: () => void;
  getActiveTurnChatId: () => number | undefined;
  clearPreview: (chatId: number) => Promise<void>;
  clearActiveTurn: () => void;
  clearAbort: () => void;
  stopPolling: () => Promise<void>;
}

export interface TelegramSessionLifecycleHookRuntimeDeps<
  TContext,
  TQueueItem,
  TModel = unknown,
> extends TelegramRuntimeEventRecorderPort {
  getCurrentModel: (ctx: TContext) => TModel | undefined;
  loadConfig: () => Promise<void>;
  applySessionStartState: (state: TelegramSessionStartState<TModel>) => void;
  bindDeferredDispatchContext?: (ctx: TContext) => void;
  prepareTempDir: () => Promise<unknown>;
  updateStatus: (ctx: TContext) => void;
  unbindDeferredDispatchContext?: () => void;
  applySessionShutdownState: (
    state: TelegramSessionShutdownState<TQueueItem>,
  ) => void;
  clearPendingMediaGroups: () => void;
  clearModelMenuState: () => void;
  getActiveTurnChatId: () => number | undefined;
  clearPreview: (chatId: number) => Promise<void>;
  clearActiveTurn: () => void;
  clearAbort: () => void;
  stopPolling: () => Promise<void>;
}

export type TelegramSessionLifecycleHookEvent = unknown;

export function createTelegramSessionStateApplier<TQueueItem, TModel>(
  deps: TelegramSessionStateApplierDeps<TQueueItem, TModel>,
): TelegramSessionStateApplier<TQueueItem, TModel> {
  return {
    applyStartState: (state) => {
      deps.setCurrentModel(state.currentTelegramModel);
      deps.setPendingModelSwitch(state.pendingTelegramModelSwitch);
      deps.syncCounters(state);
      deps.syncFlags(state);
    },
    applyShutdownState: (state) => {
      deps.setQueuedItems(state.queuedTelegramItems);
      deps.syncCounters(state);
      deps.syncFlags(state);
      deps.setCurrentModel(state.currentTelegramModel);
      deps.setPendingModelSwitch(state.pendingTelegramModelSwitch);
    },
  };
}

export interface TelegramQueueMutationRuntimeDeps<
  TContext,
> extends TelegramQueueStore<TContext> {
  ctx: TContext;
  getNextPriorityReactionOrder?: () => number;
  incrementNextPriorityReactionOrder?: () => void;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramQueueMutationControllerDeps<
  TContext,
> extends TelegramQueueStore<TContext> {
  getNextPriorityReactionOrder?: () => number;
  incrementNextPriorityReactionOrder?: () => void;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramQueueMutationController<TContext> {
  append: (item: TelegramQueueItem<TContext>, ctx: TContext) => void;
  reorder: (ctx: TContext) => void;
  clear: (ctx: TContext) => number;
  removeByMessageIds: (messageIds: number[], ctx: TContext) => number;
  clearPriorityByMessageId: (messageId: number, ctx: TContext) => boolean;
  prioritizeByMessageId: (
    messageId: number,
    ctx: TContext,
    priorityEmoji?: string,
  ) => boolean;
}

export interface TelegramControlQueueControllerDeps<TContext> {
  appendControlItem: (
    item: PendingTelegramControlItem<TContext>,
    ctx: TContext,
  ) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
}

export interface TelegramControlQueueController<TContext> {
  enqueue: (item: PendingTelegramControlItem<TContext>, ctx: TContext) => void;
}

export interface TelegramPromptEnqueueRuntimeDeps<
  TMessage,
  TContext = unknown,
> extends TelegramQueueStore<TContext> {
  getPreserveQueuedTurnsAsHistory: () => boolean;
  setPreserveQueuedTurnsAsHistory: (preserve: boolean) => void;
  createTurn: (
    messages: TMessage[],
    historyTurns: PendingTelegramTurn[],
  ) => Promise<PendingTelegramTurn>;
  updateStatus: () => void;
  dispatchNextQueuedTelegramTurn: () => void;
}

export interface TelegramPromptEnqueueControllerDeps<
  TMessage,
  TContext = unknown,
> extends TelegramQueueStore<TContext> {
  getPreserveQueuedTurnsAsHistory: () => boolean;
  setPreserveQueuedTurnsAsHistory: (preserve: boolean) => void;
  createTurn: (
    messages: TMessage[],
    historyTurns: PendingTelegramTurn[],
    ctx: TContext,
  ) => Promise<PendingTelegramTurn>;
  updateStatus: (ctx: TContext) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
}

export interface TelegramPromptEnqueueController<TMessage, TContext = unknown> {
  enqueue: (messages: TMessage[], ctx: TContext) => Promise<void>;
}

export function buildTelegramSessionStartState<TModel = unknown>(
  currentModel: TModel | undefined,
): TelegramSessionStartState<TModel> {
  return {
    currentTelegramModel: currentModel,
    activeTelegramToolExecutions: 0,
    pendingTelegramModelSwitch: undefined,
    nextQueuedTelegramItemOrder: 0,
    nextQueuedTelegramControlOrder: 0,
    telegramTurnDispatchPending: false,
    compactionInProgress: false,
  };
}

export function buildTelegramSessionShutdownState<
  TQueueItem,
>(): TelegramSessionShutdownState<TQueueItem> {
  return {
    queuedTelegramItems: [],
    nextQueuedTelegramItemOrder: 0,
    nextQueuedTelegramControlOrder: 0,
    nextPriorityReactionOrder: 0,
    currentTelegramModel: undefined,
    activeTelegramToolExecutions: 0,
    pendingTelegramModelSwitch: undefined,
    telegramTurnDispatchPending: false,
    compactionInProgress: false,
    preserveQueuedTurnsAsHistory: false,
  };
}

export async function startTelegramSessionRuntime<TContext, TModel = unknown>(
  deps: TelegramSessionStartRuntimeDeps<TContext, TModel>,
): Promise<void> {
  await deps.loadConfig();
  deps.applyState(buildTelegramSessionStartState(deps.currentModel));
  await deps.prepareTempDir();
  deps.bindDeferredDispatchContext?.(deps.ctx);
  deps.updateStatus();
}

export async function shutdownTelegramSessionRuntime<TQueueItem>(
  deps: TelegramSessionShutdownRuntimeDeps<TQueueItem>,
): Promise<void> {
  deps.unbindDeferredDispatchContext?.();
  deps.applyState(buildTelegramSessionShutdownState<TQueueItem>());
  deps.clearPendingMediaGroups();
  deps.clearModelMenuState();
  const activeTurnChatId = deps.getActiveTurnChatId();
  if (activeTurnChatId !== undefined) {
    await deps.clearPreview(activeTurnChatId);
  }
  deps.clearActiveTurn();
  deps.clearAbort();
  await deps.stopPolling();
}

export type TelegramSessionLifecycleRuntimeDeps<
  TContext,
  TQueueItem,
  TModel = unknown,
> = Omit<
  TelegramSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel>,
  "applySessionStartState" | "applySessionShutdownState"
> &
  TelegramSessionStateApplierDeps<TQueueItem, TModel>;

export function createTelegramSessionLifecycleRuntime<
  TContext,
  TQueueItem,
  TModel = unknown,
>(deps: TelegramSessionLifecycleRuntimeDeps<TContext, TQueueItem, TModel>) {
  const stateApplier = createTelegramSessionStateApplier({
    setQueuedItems: deps.setQueuedItems,
    setCurrentModel: deps.setCurrentModel,
    setPendingModelSwitch: deps.setPendingModelSwitch,
    syncCounters: deps.syncCounters,
    syncFlags: deps.syncFlags,
  });
  return createTelegramSessionLifecycleHooks({
    getCurrentModel: deps.getCurrentModel,
    loadConfig: deps.loadConfig,
    applySessionStartState: stateApplier.applyStartState,
    bindDeferredDispatchContext: deps.bindDeferredDispatchContext,
    prepareTempDir: deps.prepareTempDir,
    updateStatus: deps.updateStatus,
    unbindDeferredDispatchContext: deps.unbindDeferredDispatchContext,
    applySessionShutdownState: stateApplier.applyShutdownState,
    clearPendingMediaGroups: deps.clearPendingMediaGroups,
    clearModelMenuState: deps.clearModelMenuState,
    getActiveTurnChatId: deps.getActiveTurnChatId,
    clearPreview: deps.clearPreview,
    clearActiveTurn: deps.clearActiveTurn,
    clearAbort: deps.clearAbort,
    stopPolling: deps.stopPolling,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export function createTelegramSessionLifecycleHooks<
  TContext,
  TQueueItem,
  TModel = unknown,
>(deps: TelegramSessionLifecycleHookRuntimeDeps<TContext, TQueueItem, TModel>) {
  return {
    onSessionStart: async (
      _event: TelegramSessionLifecycleHookEvent,
      ctx: TContext,
    ): Promise<void> => {
      try {
        await startTelegramSessionRuntime({
          ctx,
          currentModel: deps.getCurrentModel(ctx),
          loadConfig: deps.loadConfig,
          applyState: deps.applySessionStartState,
          bindDeferredDispatchContext: deps.bindDeferredDispatchContext,
          prepareTempDir: deps.prepareTempDir,
          updateStatus: () => deps.updateStatus(ctx),
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("session", error, { phase: "start" });
        throw error;
      }
    },
    onSessionShutdown: async (): Promise<void> => {
      try {
        await shutdownTelegramSessionRuntime<TQueueItem>({
          unbindDeferredDispatchContext: deps.unbindDeferredDispatchContext,
          applyState: deps.applySessionShutdownState,
          clearPendingMediaGroups: deps.clearPendingMediaGroups,
          clearModelMenuState: deps.clearModelMenuState,
          getActiveTurnChatId: deps.getActiveTurnChatId,
          clearPreview: deps.clearPreview,
          clearActiveTurn: deps.clearActiveTurn,
          clearAbort: deps.clearAbort,
          stopPolling: deps.stopPolling,
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("session", error, { phase: "shutdown" });
        throw error;
      }
    },
  };
}

export function createTelegramQueueMutationController<TContext>(
  deps: TelegramQueueMutationControllerDeps<TContext>,
): TelegramQueueMutationController<TContext> {
  const buildRuntimeDeps = (
    ctx: TContext,
  ): TelegramQueueMutationRuntimeDeps<TContext> => ({
    ...deps,
    ctx,
  });
  return {
    append: (item, ctx) =>
      appendTelegramQueueItemRuntime(item, buildRuntimeDeps(ctx)),
    reorder: (ctx) => reorderTelegramQueueItemsRuntime(buildRuntimeDeps(ctx)),
    clear: (ctx) => clearTelegramQueueItemsRuntime(buildRuntimeDeps(ctx)),
    removeByMessageIds: (messageIds, ctx) =>
      removeTelegramQueueItemsByMessageIdsRuntime(
        messageIds,
        buildRuntimeDeps(ctx),
      ),
    clearPriorityByMessageId: (messageId, ctx) =>
      clearTelegramQueuePromptPriorityRuntime(messageId, buildRuntimeDeps(ctx)),
    prioritizeByMessageId: (messageId, ctx, priorityEmoji) =>
      prioritizeTelegramQueuePromptRuntime(
        messageId,
        buildRuntimeDeps(ctx),
        priorityEmoji,
      ),
  };
}

function appendTelegramQueueItemRuntime<TContext>(
  item: TelegramQueueItem<TContext>,
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): void {
  deps.setQueuedItems(appendTelegramQueueItem(deps.getQueuedItems(), item));
  reorderTelegramQueueItemsRuntime(deps);
}

export function reorderTelegramQueueItemsRuntime<TContext>(
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): void {
  deps.setQueuedItems(
    [...deps.getQueuedItems()].sort(compareTelegramQueueItems),
  );
  deps.updateStatus(deps.ctx);
}

export function clearTelegramQueueItemsRuntime<TContext>(
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): number {
  const removedCount = deps.getQueuedItems().length;
  if (removedCount === 0) return 0;
  deps.setQueuedItems([]);
  deps.updateStatus(deps.ctx);
  return removedCount;
}

export function removeTelegramQueueItemsByMessageIdsRuntime<TContext>(
  messageIds: number[],
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): number {
  const { items, removedCount } = removeTelegramQueueItemsByMessageIds(
    deps.getQueuedItems(),
    messageIds,
  );
  if (removedCount === 0) return 0;
  deps.setQueuedItems(items);
  deps.updateStatus(deps.ctx);
  return removedCount;
}

export function clearTelegramQueuePromptPriorityRuntime<TContext>(
  messageId: number,
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): boolean {
  const { changed, items } = clearTelegramQueuePromptPriority(
    deps.getQueuedItems(),
    messageId,
  );
  if (!changed) return false;
  deps.setQueuedItems(items);
  reorderTelegramQueueItemsRuntime(deps);
  return true;
}

export function prioritizeTelegramQueuePromptRuntime<TContext>(
  messageId: number,
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
  priorityEmoji?: string,
): boolean {
  const nextPriorityReactionOrder = deps.getNextPriorityReactionOrder?.();
  if (nextPriorityReactionOrder === undefined) return false;
  const { changed, items } = prioritizeTelegramQueuePrompt(
    deps.getQueuedItems(),
    messageId,
    nextPriorityReactionOrder,
    priorityEmoji,
  );
  if (!changed) return false;
  deps.setQueuedItems(items);
  deps.incrementNextPriorityReactionOrder?.();
  reorderTelegramQueueItemsRuntime(deps);
  return true;
}

export async function enqueueTelegramPromptTurnRuntime<
  TMessage,
  TContext = unknown,
>(
  messages: TMessage[],
  deps: TelegramPromptEnqueueRuntimeDeps<TMessage, TContext>,
): Promise<void> {
  const enqueuePlan = planTelegramPromptEnqueue(
    deps.getQueuedItems(),
    deps.getPreserveQueuedTurnsAsHistory(),
  );
  deps.setPreserveQueuedTurnsAsHistory(false);
  const turn = await deps.createTurn(messages, enqueuePlan.historyTurns);
  deps.setQueuedItems(
    appendTelegramQueueItem(enqueuePlan.remainingItems, turn),
  );
  deps.updateStatus();
  deps.dispatchNextQueuedTelegramTurn();
}

export function createTelegramPromptEnqueueController<
  TMessage,
  TContext = unknown,
>(
  deps: TelegramPromptEnqueueControllerDeps<TMessage, TContext>,
): TelegramPromptEnqueueController<TMessage, TContext> {
  return {
    enqueue: (messages, ctx) =>
      enqueueTelegramPromptTurnRuntime(messages, {
        ...deps,
        createTurn: (nextMessages, historyTurns) =>
          deps.createTurn(nextMessages, historyTurns, ctx),
        updateStatus: () => deps.updateStatus(ctx),
        dispatchNextQueuedTelegramTurn: () =>
          deps.dispatchNextQueuedTelegramTurn(ctx),
      }),
  };
}

export function createTelegramControlQueueController<TContext>(
  deps: TelegramControlQueueControllerDeps<TContext>,
): TelegramControlQueueController<TContext> {
  return {
    enqueue: (item, ctx) => {
      deps.appendControlItem(item, ctx);
      deps.dispatchNextQueuedTelegramTurn(ctx);
    },
  };
}

// --- Control Runtime ---

function getTelegramQueueErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TelegramRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramControlRuntimeDeps<
  TContext,
> extends TelegramRuntimeEventRecorderPort {
  ctx: TContext;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<number | undefined>;
  onSettled: () => void;
}

export async function executeTelegramControlItemRuntime<TContext>(
  item: PendingTelegramControlItem<TContext>,
  deps: TelegramControlRuntimeDeps<TContext>,
): Promise<void> {
  try {
    await item.execute(deps.ctx);
  } catch (error) {
    const message = getTelegramQueueErrorMessage(error);
    deps.recordRuntimeEvent?.("control", error, {
      controlType: item.controlType,
      chatId: item.chatId,
      replyToMessageId: item.replyToMessageId,
    });
    await deps.sendTextReply(
      item.chatId,
      item.replyToMessageId,
      `Telegram control action failed: ${message}`,
    );
  } finally {
    deps.onSettled();
  }
}

// --- Deferred Dispatch Runtime ---

export interface TelegramDeferredQueueDispatchRuntimeDeps extends TelegramRuntimeEventRecorderPort {
  delayMs?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface TelegramDeferredQueueDispatchRuntime<TContext = unknown> {
  bind: (ctx: TContext) => void;
  unbind: () => void;
  isBound: () => boolean;
  request: (dispatchNextQueuedTelegramTurn: (ctx: TContext) => void) => void;
}

export function createTelegramDeferredQueueDispatchRuntime<TContext = unknown>(
  deps: TelegramDeferredQueueDispatchRuntimeDeps = {},
): TelegramDeferredQueueDispatchRuntime<TContext> {
  let boundContext: TContext | undefined;
  let generation = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const delayMs = deps.delayMs ?? 0;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ??
    ((timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer));
  const clearTimers = (): void => {
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  };
  return {
    bind: (ctx) => {
      boundContext = ctx;
      generation += 1;
    },
    unbind: () => {
      boundContext = undefined;
      generation += 1;
      clearTimers();
    },
    isBound: () => boundContext !== undefined,
    request: (dispatchNextQueuedTelegramTurn) => {
      if (boundContext === undefined) return;
      const scheduledGeneration = generation;
      let timer: ReturnType<typeof setTimeout>;
      timer = setTimer(() => {
        timers.delete(timer);
        if (generation !== scheduledGeneration || boundContext === undefined)
          return;
        dispatchNextQueuedTelegramTurn(boundContext);
      }, delayMs);
      timers.add(timer);
    },
  };
}

// --- Dispatch Runtime ---

export interface TelegramDispatchRuntimeDeps<TContext = unknown> {
  executeControlItem: (
    item: Extract<
      TelegramQueueDispatchAction<TContext>,
      { kind: "control" }
    >["item"],
  ) => void;
  onPromptDispatchStart: (chatId: number) => void;
  sendUserMessage: (
    content: Extract<
      TelegramQueueDispatchAction,
      { kind: "prompt" }
    >["item"]["content"],
  ) => void;
  onPromptDispatchFailure: (message: string) => void;
  onIdle: () => void;
}

export interface TelegramQueueDispatchControllerDeps<
  TContext = unknown,
> extends TelegramRuntimeEventRecorderPort {
  getQueuedItems: () => TelegramQueueItem<TContext>[];
  setQueuedItems: (items: TelegramQueueItem<TContext>[]) => void;
  canDispatch: (ctx: TContext) => boolean;
  hasDispatchContext?: () => boolean;
  updateStatus: (ctx: TContext, error?: string) => void;
  sendTextReply: TelegramControlRuntimeDeps<TContext>["sendTextReply"];
  onPromptDispatchStart: (ctx: TContext, chatId: number) => void;
  sendUserMessage: TelegramDispatchRuntimeDeps<TContext>["sendUserMessage"];
  onPromptDispatchFailure: (ctx: TContext, message: string) => void;
}

export interface TelegramQueueDispatchController<TContext = unknown> {
  dispatchNext: (ctx: TContext) => void;
}

export function executeTelegramQueueDispatchPlan<TContext = unknown>(
  plan: TelegramQueueDispatchAction<TContext>,
  deps: TelegramDispatchRuntimeDeps<TContext>,
): void {
  if (plan.kind === "none") {
    deps.onIdle();
    return;
  }
  if (plan.kind === "control") {
    deps.executeControlItem(plan.item);
    return;
  }
  deps.onPromptDispatchStart(plan.item.chatId);
  try {
    deps.sendUserMessage(plan.item.content);
  } catch (error) {
    const message = getTelegramQueueErrorMessage(error);
    deps.onPromptDispatchFailure(message);
  }
}

export type TelegramQueueDispatchRuntimeDeps<TContext = unknown> = Omit<
  TelegramQueueDispatchControllerDeps<TContext>,
  "canDispatch"
> &
  TelegramDispatchReadinessDeps<TContext>;

export function createTelegramQueueDispatchRuntime<TContext = unknown>(
  deps: TelegramQueueDispatchRuntimeDeps<TContext>,
): TelegramQueueDispatchController<TContext> {
  return createTelegramQueueDispatchController({
    getQueuedItems: deps.getQueuedItems,
    setQueuedItems: deps.setQueuedItems,
    canDispatch: createTelegramDispatchReadinessChecker({
      isCompactionInProgress: deps.isCompactionInProgress,
      hasActiveTurn: deps.hasActiveTurn,
      hasDispatchPending: deps.hasDispatchPending,
      isIdle: deps.isIdle,
      hasPendingMessages: deps.hasPendingMessages,
    }),
    hasDispatchContext: deps.hasDispatchContext,
    updateStatus: deps.updateStatus,
    sendTextReply: deps.sendTextReply,
    onPromptDispatchStart: deps.onPromptDispatchStart,
    sendUserMessage: deps.sendUserMessage,
    onPromptDispatchFailure: deps.onPromptDispatchFailure,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export function createTelegramQueueDispatchController<TContext = unknown>(
  deps: TelegramQueueDispatchControllerDeps<TContext>,
): TelegramQueueDispatchController<TContext> {
  let controlDispatchPending = false;
  const controller: TelegramQueueDispatchController<TContext> = {
    dispatchNext: (ctx) => {
      if (deps.hasDispatchContext && !deps.hasDispatchContext()) return;
      if (controlDispatchPending) {
        deps.updateStatus(ctx);
        return;
      }
      const dispatchPlan = planNextTelegramQueueAction(
        deps.getQueuedItems(),
        deps.canDispatch(ctx),
      );
      if (dispatchPlan.kind !== "none") {
        deps.setQueuedItems(dispatchPlan.remainingItems);
      }
      executeTelegramQueueDispatchPlan(dispatchPlan, {
        executeControlItem: (item) => {
          controlDispatchPending = true;
          deps.updateStatus(ctx);
          void executeTelegramControlItemRuntime(item, {
            ctx,
            sendTextReply: deps.sendTextReply,
            recordRuntimeEvent: deps.recordRuntimeEvent,
            onSettled: () => {
              controlDispatchPending = false;
              if (deps.hasDispatchContext && !deps.hasDispatchContext()) return;
              deps.updateStatus(ctx);
              controller.dispatchNext(ctx);
            },
          });
        },
        onPromptDispatchStart: (chatId) => {
          deps.onPromptDispatchStart(ctx, chatId);
        },
        sendUserMessage: deps.sendUserMessage,
        onPromptDispatchFailure: (message) => {
          deps.onPromptDispatchFailure(ctx, message);
        },
        onIdle: () => {
          deps.updateStatus(ctx);
        },
      });
    },
  };
  return controller;
}
