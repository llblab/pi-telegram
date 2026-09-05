/**
 * Telegram queue core contracts and pure planning helpers
 * Zones: telegram queue, pi agent lifecycle, scheduling
 * Owns queue item contracts, lane admission, pure queue mutations, and dispatch planning
 */

import { createHash } from "node:crypto";

import { isVoiceTurn } from "./voice.ts";

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
  TelegramPromptTextContent | TelegramPromptImageContent;

export type TelegramQueueItemKind = "prompt" | "control";
export type TelegramQueueLane = "control" | "priority" | "default";
export type TelegramQueueReactionDisposition =
  | { kind: "default" }
  | { kind: "priority"; emoji: string }
  | { kind: "suppressed"; emoji: string }
  | {
      kind: "priority-suppressed";
      priorityEmoji: string;
      suppressionEmoji: string;
    }
  | {
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
export type TelegramQueueAdmissionMode =
  "control-queue" | "priority-queue" | "default-queue";

export interface TelegramQueueLaneContract {
  lane: TelegramQueueLane;
  admissionMode: TelegramQueueAdmissionMode;
  dispatchRank: number;
  allowedKinds: readonly TelegramQueueItemKind[];
}

export const TELEGRAM_QUEUE_LANE_CONTRACTS: readonly TelegramQueueLaneContract[] =
  [
    // Control lane intentionally accepts both direct controls and resume prompts.
    // Model-switch continuations need prompt semantics but must run before queued user work.
    // Do not admit ordinary user prompts here without an explicit control-flow reason.
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

  /** Turn should preferably be delivered as voice (mirror mode + user sent voice) */
  voiceReplyPreferred?: boolean;
  /** Turn must be delivered as voice (voice mode) */
  voiceReplyRequired?: boolean;
}

export interface PendingTelegramControlItem<
  TContext = unknown,
> extends TelegramQueueItemBase {
  kind: "control";
  controlType: "status" | "model";
  execute: (ctx: TContext) => Promise<void>;
}

export type TelegramQueueItem<TContext = unknown> =
  PendingTelegramTurn | PendingTelegramControlItem<TContext>;

export const TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS = 256;

export interface TelegramQueueHandoffBase {
  chatId: number;
  target?: TelegramQueueTarget;
  transportStamp?: TelegramTransportStamp;
  replyToMessageId: number;
  guestQueryId?: string;
  queueOrder: number;
  queueLane: TelegramQueueLane;
  laneOrder: number;
  statusSummary: string;
  admissionReceipts: TelegramQueueAdmissionReceipt[];
}

export interface TelegramPromptQueueHandoffPayload
  extends TelegramQueueHandoffBase {
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

export interface TelegramControlQueueHandoffPayload
  extends TelegramQueueHandoffBase {
  kind: "control";
  controlType: PendingTelegramControlItem<unknown>["controlType"];
}

export type TelegramQueueHandoffPayload =
  | TelegramPromptQueueHandoffPayload
  | TelegramControlQueueHandoffPayload;

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

export interface TelegramQueueHandoffStageResult
  extends TelegramQueueHandoffStageReceipt {
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

export function createTelegramQueueAdmissionReceipt(options: {
  queueKind: TelegramQueueItemKind;
  scope: string;
  sourceUpdateIds: readonly number[];
}): TelegramQueueAdmissionReceipt | undefined {
  if (options.sourceUpdateIds.length === 0) return undefined;
  const scope = options.scope.trim();
  if (!scope) {
    throw new Error("Telegram queue admission receipt scope is required.");
  }
  if (options.queueKind !== "prompt" && options.queueKind !== "control") {
    throw new Error("Telegram queue admission receipt kind is invalid.");
  }
  const sourceUpdateIds = [...new Set(options.sourceUpdateIds)].sort(
    (left, right) => left - right,
  );
  if (
    sourceUpdateIds.some(
      (updateId) => !Number.isSafeInteger(updateId) || updateId < 0,
    )
  ) {
    throw new Error("Telegram queue admission update ids must be safe integers.");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        scope,
        queueKind: options.queueKind,
        sourceUpdateIds,
      }),
    )
    .digest("hex");
  return {
    queueKind: options.queueKind,
    receiptId: `telegram-${options.queueKind}-v1-${digest}`,
    sourceUpdateIds,
    journalBindingKey: scope,
  };
}

export function isTelegramQueueItemDurablyAdmitted<TContext = unknown>(
  item: TelegramQueueItem<TContext>,
  isReceiptCommitted: (receipt: TelegramQueueAdmissionReceipt) => boolean,
): boolean {
  assertTelegramQueueItemAdmissionValid(item);
  return (item.admissionReceipts ?? []).every(isReceiptCommitted);
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
  item: Pick<
    TelegramQueueItem,
    "kind" | "queueLane" | "admissionReceipts"
  >,
): void {
  if (!isTelegramQueueItemAdmissionValid(item)) {
    throw new Error(
      `Invalid Telegram queue admission: ${item.kind} item cannot use ${item.queueLane} lane`,
    );
  }
  const receiptIds = new Set<string>();
  for (const receipt of item.admissionReceipts ?? []) {
    const sourceUpdateIds = new Set(receipt.sourceUpdateIds);
    if (
      receipt.queueKind !== item.kind ||
      !receipt.receiptId ||
      receiptIds.has(receipt.receiptId) ||
      receipt.sourceUpdateIds.length === 0 ||
      (receipt.journalBindingKey !== undefined &&
        receipt.journalBindingKey.trim().length === 0) ||
      sourceUpdateIds.size !== receipt.sourceUpdateIds.length ||
      receipt.sourceUpdateIds.some(
        (updateId, index) =>
          !Number.isSafeInteger(updateId) ||
          updateId < 0 ||
          (index > 0 && updateId <= receipt.sourceUpdateIds[index - 1]!),
      )
    ) {
      throw new Error(
        `Invalid Telegram queue receipt for ${item.kind} item`,
      );
    }
    receiptIds.add(receipt.receiptId);
  }
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

export function createTelegramTransportStampRuntime(deps: {
  getProfileName(): string | undefined;
  getBotToken(): string | undefined;
}): TelegramTransportStampRuntime {
  let profile: string | undefined;
  let botToken: string | undefined;
  let generation = 0;
  const getStamp = function (): TelegramTransportStamp {
    const nextProfile = deps.getProfileName() ?? "default";
    const nextBotToken = deps.getBotToken();
    if (nextProfile !== profile || nextBotToken !== botToken) {
      profile = nextProfile;
      botToken = nextBotToken;
      generation += 1;
    }
    return { profile: nextProfile, generation: String(generation) };
  };
  return {
    getStamp,
    isActive(stamp) {
      if (!stamp) return false;
      const current = getStamp();
      return (
        stamp.profile === current.profile &&
        stamp.generation === current.generation
      );
    },
  };
}

export function createTelegramTransportStampedQueueStore<TContext>(
  store: TelegramQueueStateStore<TContext>,
  getTransportStamp: () => TelegramTransportStamp,
): TelegramQueueStateStore<TContext> {
  return {
    getQueuedItems: store.getQueuedItems,
    hasQueuedItems: store.hasQueuedItems,
    setQueuedItems(items) {
      const stamp = getTransportStamp();
      store.setQueuedItems(
        items.map((item) =>
          item.transportStamp ? item : { ...item, transportStamp: stamp },
        ),
      );
    },
  };
}

export function isTelegramQueueItemSkipped<TContext = unknown>(
  item: TelegramQueueItem<TContext>,
): boolean {
  return item.kind === "prompt" && Boolean(item.reactionSuppressionEmoji);
}

export function countExecutableTelegramQueueItems<TContext = unknown>(
  items: readonly TelegramQueueItem<TContext>[],
): number {
  return items.filter((item) => !isTelegramQueueItemSkipped(item)).length;
}

export function createTelegramQueueItemCountGetter<TContext = unknown>(
  store: Pick<TelegramQueueStore<TContext>, "getQueuedItems">,
): () => number {
  return () => countExecutableTelegramQueueItems(store.getQueuedItems());
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
    getTarget: () =>
      activeTurn?.target ? { ...activeTurn.target } : undefined,
    getReplyToMessageId: () => activeTurn?.replyToMessageId,
    getGuestQueryId: () => activeTurn?.guestQueryId,
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
  foldQueuedPromptsIntoHistory: boolean,
): {
  historyTurns: PendingTelegramTurn[];
  remainingItems: TelegramQueueItem<TContext>[];
} {
  if (!foldQueuedPromptsIntoHistory) {
    return { historyTurns: [], remainingItems: items };
  }
  return partitionTelegramQueueItemsForHistory(items);
}

export function areTelegramQueueAdmissionReceiptsEqual(
  left: TelegramQueueAdmissionReceipt,
  right: TelegramQueueAdmissionReceipt,
): boolean {
  return (
    left.queueKind === right.queueKind &&
    left.receiptId === right.receiptId &&
    left.journalBindingKey === right.journalBindingKey &&
    left.sourceUpdateIds.length === right.sourceUpdateIds.length &&
    left.sourceUpdateIds.every(
      (updateId, index) => updateId === right.sourceUpdateIds[index],
    )
  );
}

function getTelegramQueueAdmissionReceiptKey(
  receipt: TelegramQueueAdmissionReceipt,
): string {
  return JSON.stringify([
    receipt.receiptId,
    receipt.journalBindingKey ?? null,
  ]);
}

function isDuplicateTelegramQueueAdmission<TContext>(
  items: TelegramQueueItem<TContext>[],
  item: TelegramQueueItem<TContext>,
): boolean {
  const incomingReceipts = item.admissionReceipts ?? [];
  if (incomingReceipts.length === 0) return false;
  const queuedReceipts = new Map<
    string,
    { receipt: TelegramQueueAdmissionReceipt; count: number }
  >();
  for (const queuedItem of items) {
    for (const receipt of queuedItem.admissionReceipts ?? []) {
      const key = getTelegramQueueAdmissionReceiptKey(receipt);
      const existing = queuedReceipts.get(key);
      if (existing) existing.count += 1;
      else queuedReceipts.set(key, { receipt, count: 1 });
    }
  }
  let duplicateCount = 0;
  for (const incoming of incomingReceipts) {
    const match = queuedReceipts.get(
      getTelegramQueueAdmissionReceiptKey(incoming),
    );
    if (!match) continue;
    if (
      match.count !== 1 ||
      !areTelegramQueueAdmissionReceiptsEqual(match.receipt, incoming)
    ) {
      throw new Error(
        `Conflicting Telegram queue receipt: ${incoming.receiptId}`,
      );
    }
    duplicateCount += 1;
  }
  if (duplicateCount === 0) return false;
  if (duplicateCount === incomingReceipts.length) return true;
  throw new Error("Telegram queue item overlaps an existing receipt.");
}

export function appendTelegramQueueItem<
  TContext = unknown,
  TItem extends TelegramQueueItem<TContext> = TelegramQueueItem<TContext>,
>(
  items: TelegramQueueItem<TContext>[],
  item: TItem,
): TelegramQueueItem<TContext>[] {
  assertTelegramQueueItemAdmissionValid(item);
  if (isDuplicateTelegramQueueAdmission(items, item)) return items;
  return [...items, item];
}

export function createTelegramQueueHandoff<TContext>(input: {
  handoffToken: string;
  item: TelegramQueueItem<TContext>;
}): TelegramQueueHandoff {
  if (!input.handoffToken) {
    throw new Error("Telegram queue handoff token is required.");
  }
  const handoff = {
    handoffToken: input.handoffToken,
    payload: createTelegramQueueHandoffPayload(input.item),
  };
  if (Buffer.byteLength(JSON.stringify(handoff)) > TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES) {
    throw new Error("Telegram queue handoff payload exceeds its byte limit.");
  }
  return handoff;
}

export function createTelegramQueueHandoffPayload<TContext>(
  item: TelegramQueueItem<TContext>,
): TelegramQueueHandoffPayload {
  assertTelegramQueueItemAdmissionValid(item);
  if (!item.admissionReceipts?.length) {
    throw new Error("Telegram queue handoff requires durable admission receipts.");
  }
  if (item.admissionReceipts.length > TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS) {
    throw new Error("Telegram queue handoff has too many admission receipts.");
  }
  if (item.kind === "control") {
    return structuredClone({
      kind: item.kind,
      controlType: item.controlType,
      chatId: item.chatId,
      ...(item.target ? { target: item.target } : {}),
      ...(item.transportStamp ? { transportStamp: item.transportStamp } : {}),
      replyToMessageId: item.replyToMessageId,
      ...(item.guestQueryId ? { guestQueryId: item.guestQueryId } : {}),
      queueOrder: item.queueOrder,
      queueLane: item.queueLane,
      laneOrder: item.laneOrder,
      statusSummary: item.statusSummary,
      admissionReceipts: item.admissionReceipts,
    });
  }
  return structuredClone({
    kind: item.kind,
    chatId: item.chatId,
    ...(item.target ? { target: item.target } : {}),
    ...(item.transportStamp ? { transportStamp: item.transportStamp } : {}),
    replyToMessageId: item.replyToMessageId,
    ...(item.guestQueryId ? { guestQueryId: item.guestQueryId } : {}),
    queueOrder: item.queueOrder,
    queueLane: item.queueLane,
    laneOrder: item.laneOrder,
    statusSummary: item.statusSummary,
    admissionReceipts: item.admissionReceipts,
    sourceMessageIds: item.sourceMessageIds,
    queuedAttachments: item.queuedAttachments,
    content: item.content,
    historyText: item.historyText,
    ...(item.priorityEmoji ? { priorityEmoji: item.priorityEmoji } : {}),
    ...(item.reactionSuppressionEmoji
      ? { reactionSuppressionEmoji: item.reactionSuppressionEmoji }
      : {}),
    ...(item.voiceReplyPreferred !== undefined
      ? { voiceReplyPreferred: item.voiceReplyPreferred }
      : {}),
    ...(item.voiceReplyRequired !== undefined
      ? { voiceReplyRequired: item.voiceReplyRequired }
      : {}),
  });
}

export function restoreTelegramQueueHandoffPayload<TContext>(
  payload: TelegramQueueHandoffPayload,
  createControlExecution: (
    payload: TelegramControlQueueHandoffPayload,
  ) => PendingTelegramControlItem<TContext>["execute"],
): TelegramQueueItem<TContext> {
  const item: TelegramQueueItem<TContext> =
    payload.kind === "prompt"
      ? structuredClone(payload)
      : {
          ...structuredClone(payload),
          execute: createControlExecution(payload),
        };
  assertTelegramQueueItemAdmissionValid(item);
  return item;
}

function getTelegramQueueHandoffReceipt(
  payload: TelegramQueueHandoffPayload,
): TelegramQueueAdmissionReceipt {
  const receipt = payload.admissionReceipts[0];
  if (!receipt || payload.admissionReceipts.length !== 1) {
    throw new Error(
      "Telegram queue handoff requires exactly one complete receipt.",
    );
  }
  return receipt;
}

function findTelegramQueueReceiptItem<TContext>(
  items: readonly TelegramQueueItem<TContext>[],
  receipt: TelegramQueueAdmissionReceipt,
): TelegramQueueItem<TContext> | undefined {
  const receiptKey = getTelegramQueueAdmissionReceiptKey(receipt);
  let match: TelegramQueueItem<TContext> | undefined;
  let matchedReceipt: TelegramQueueAdmissionReceipt | undefined;
  for (const item of items) {
    for (const candidate of item.admissionReceipts ?? []) {
      if (getTelegramQueueAdmissionReceiptKey(candidate) !== receiptKey) {
        continue;
      }
      if (match) {
        throw new Error(
          `Conflicting Telegram queue receipt: ${receipt.receiptId}`,
        );
      }
      match = item;
      matchedReceipt = candidate;
    }
  }
  if (!match) return undefined;
  if (
    !matchedReceipt ||
    !areTelegramQueueAdmissionReceiptsEqual(matchedReceipt, receipt)
  ) {
    throw new Error(`Conflicting Telegram queue receipt: ${receipt.receiptId}`);
  }
  return match;
}

export function removeTelegramQueueItemByReceipt<TContext>(input: {
  receipt: TelegramQueueAdmissionReceipt;
  store: TelegramQueueStore<TContext>;
}): boolean {
  const current = input.store.getQueuedItems();
  const item = findTelegramQueueReceiptItem(current, input.receipt);
  if (!item) return false;
  input.store.setQueuedItems(current.filter((candidate) => candidate !== item));
  return true;
}

export function stageTelegramQueueHandoffPayload<TContext>(input: {
  payload: TelegramQueueHandoffPayload;
  store: TelegramQueueStore<TContext>;
  createControlExecution: (
    payload: TelegramControlQueueHandoffPayload,
  ) => PendingTelegramControlItem<TContext>["execute"];
}): TelegramQueueHandoffStageReceipt {
  const receipt = getTelegramQueueHandoffReceipt(input.payload);
  const item = restoreTelegramQueueHandoffPayload(
    input.payload,
    input.createControlExecution,
  );
  const current = input.store.getQueuedItems();
  const next = appendTelegramQueueItem(current, item);
  if (next !== current) input.store.setQueuedItems(next);
  return {
    status: "staged",
    receiptId: receipt.receiptId,
    sourceUpdateIds: [...receipt.sourceUpdateIds],
  };
}

export function createTelegramQueueHandoffStagingRuntime<TContext>(input: {
  liveStore: TelegramQueueStore<TContext>;
  createControlExecution: (
    payload: TelegramControlQueueHandoffPayload,
  ) => PendingTelegramControlItem<TContext>["execute"];
}): TelegramQueueHandoffStagingRuntime {
  const stagedStore = createTelegramQueueStore<TContext>();
  return {
    stage(payload) {
      const receipt = getTelegramQueueHandoffReceipt(payload);
      const liveItem = findTelegramQueueReceiptItem(
        input.liveStore.getQueuedItems(),
        receipt,
      );
      if (liveItem) {
        throw new Error(
          `Telegram queue handoff receipt ${receipt.receiptId} is already live.`,
        );
      }
      return stageTelegramQueueHandoffPayload({
        payload,
        store: stagedStore,
        createControlExecution: input.createControlExecution,
      });
    },
    accept(receipt) {
      const stagedItems = stagedStore.getQueuedItems();
      const stagedItem = findTelegramQueueReceiptItem(stagedItems, receipt);
      if (!stagedItem) {
        return Boolean(
          findTelegramQueueReceiptItem(
            input.liveStore.getQueuedItems(),
            receipt,
          ),
        );
      }
      const current = input.liveStore.getQueuedItems();
      const next = appendTelegramQueueItem(current, stagedItem);
      if (next !== current) input.liveStore.setQueuedItems(next);
      stagedStore.setQueuedItems(
        stagedItems.filter((candidate) => candidate !== stagedItem),
      );
      return true;
    },
    cancel(receipt) {
      const stagedItems = stagedStore.getQueuedItems();
      const stagedItem = findTelegramQueueReceiptItem(stagedItems, receipt);
      if (!stagedItem) return false;
      stagedStore.setQueuedItems(
        stagedItems.filter((candidate) => candidate !== stagedItem),
      );
      return true;
    },
    hasStaged(receipt) {
      return Boolean(
        findTelegramQueueReceiptItem(stagedStore.getQueuedItems(), receipt),
      );
    },
  };
}

function getTelegramPromptTextSignature(item: PendingTelegramTurn): string {
  return item.content
    .filter(
      (entry): entry is TelegramPromptTextContent => entry.type === "text",
    )
    .map((entry) => entry.text)
    .join("\n");
}

function isDuplicateTelegramPromptTurn(
  left: PendingTelegramTurn,
  right: PendingTelegramTurn,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.target?.threadId === right.target?.threadId &&
    left.replyToMessageId === right.replyToMessageId &&
    getTelegramPromptTextSignature(left) ===
      getTelegramPromptTextSignature(right)
  );
}

export function appendTelegramPromptTurnOnce<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  turn: PendingTelegramTurn,
): { items: TelegramQueueItem<TContext>[]; appended: boolean } {
  assertTelegramQueueItemAdmissionValid(turn);
  if (isDuplicateTelegramQueueAdmission(items, turn)) {
    return { items, appended: false };
  }
  const hasAdmissionReceipts = (turn.admissionReceipts?.length ?? 0) > 0;
  const duplicate =
    !hasAdmissionReceipts &&
    items.some(
      (item) =>
        isPendingTelegramTurn(item) &&
        (item.admissionReceipts?.length ?? 0) === 0 &&
        isDuplicateTelegramPromptTurn(item, turn),
    );
  if (duplicate) return { items, appended: false };
  return {
    items: [...items, turn].sort(compareTelegramQueueItems),
    appended: true,
  };
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

export interface TelegramQueueMessageScope {
  chatId?: number;
  threadId?: number;
}

function isTelegramQueueItemInMessageScope<TContext = unknown>(
  item: TelegramQueueItem<TContext>,
  scope: TelegramQueueMessageScope | undefined,
): boolean {
  if (!scope) return true;
  if (typeof scope.chatId === "number" && item.chatId !== scope.chatId) {
    return false;
  }
  if (typeof scope.threadId === "number") {
    return item.target?.threadId === scope.threadId;
  }
  return true;
}

export function removeTelegramQueueItemsByMessageIds<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
  messageIds: number[],
  scope?: TelegramQueueMessageScope,
): {
  items: TelegramQueueItem<TContext>[];
  removedItems: TelegramQueueItem<TContext>[];
  removedCount: number;
} {
  if (messageIds.length === 0 || items.length === 0) {
    return { items, removedItems: [], removedCount: 0 };
  }
  const deletedMessageIds = new Set(messageIds);
  const nextItems: TelegramQueueItem<TContext>[] = [];
  const removedItems: TelegramQueueItem<TContext>[] = [];
  for (const item of items) {
    const shouldRemove =
      isPendingTelegramTurn(item) &&
      isTelegramQueueItemInMessageScope(item, scope) &&
      item.sourceMessageIds.some((messageId) =>
        deletedMessageIds.has(messageId),
      );
    (shouldRemove ? removedItems : nextItems).push(item);
  }
  return {
    items: nextItems,
    removedItems,
    removedCount: removedItems.length,
  };
}

export function applyTelegramQueuePromptReactionDisposition<
  TContext = unknown,
>(
  items: TelegramQueueItem<TContext>[],
  messageId: number,
  disposition: TelegramQueueReactionDisposition,
  destinationLaneOrder?: number,
  scope?: TelegramQueueMessageScope,
): { items: TelegramQueueItem<TContext>[]; changed: boolean } {
  let nextItems = items;
  for (const [index, item] of items.entries()) {
    if (
      !isPendingTelegramTurn(item) ||
      !isTelegramQueueItemInMessageScope(item, scope) ||
      !item.sourceMessageIds.includes(messageId)
    ) {
      continue;
    }
    const isPriority = disposition.kind === "reaction-transition"
      ? disposition.priorityEmoji === undefined
        ? item.queueLane === "priority"
        : disposition.priorityEmoji !== null
      : disposition.kind === "priority" ||
        disposition.kind === "priority-suppressed";
    const queueLane: TelegramQueueLane = isPriority ? "priority" : "default";
    const laneOrder = item.queueLane === queueLane
      ? item.laneOrder
      : destinationLaneOrder;
    if (laneOrder === undefined) {
      throw new Error("Telegram destination lane order is unavailable.");
    }
    const priorityEmoji = disposition.kind === "reaction-transition"
      ? disposition.priorityEmoji === undefined
        ? item.priorityEmoji
        : disposition.priorityEmoji ?? undefined
      : disposition.kind === "priority"
        ? disposition.emoji
        : disposition.kind === "priority-suppressed"
          ? disposition.priorityEmoji
          : undefined;
    const reactionSuppressionEmoji =
      disposition.kind === "reaction-transition"
        ? disposition.suppressionEmoji === undefined
          ? item.reactionSuppressionEmoji
          : disposition.suppressionEmoji ?? undefined
        : disposition.kind === "suppressed"
          ? disposition.emoji
          : disposition.kind === "priority-suppressed"
            ? disposition.suppressionEmoji
            : undefined;
    if (
      item.queueLane === queueLane &&
      item.laneOrder === laneOrder &&
      item.priorityEmoji === priorityEmoji &&
      item.reactionSuppressionEmoji === reactionSuppressionEmoji
    ) {
      continue;
    }
    if (nextItems === items) nextItems = [...items];
    nextItems[index] = {
      ...item,
      queueLane,
      laneOrder,
      priorityEmoji,
      reactionSuppressionEmoji,
    };
  }
  return { items: nextItems, changed: nextItems !== items };
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

export function formatQueuedTelegramItemsStatus<TContext = unknown>(
  items: TelegramQueueItem<TContext>[],
): string {
  const count = countExecutableTelegramQueueItems(items);
  return count === 0 ? "" : ` +${count}`;
}

export function truncateTelegramQueueSummary(
  text: string,
  maxWords = 5,
  maxLength = 40,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const words = normalized.split(" ");
  let summary = words.slice(0, maxWords).join(" ");
  if (summary.length === 0) summary = normalized;
  if (summary.length > maxLength) {
    summary = summary.slice(0, maxLength).trimEnd();
  }
  return summary.length < normalized.length || words.length > maxWords
    ? `${summary}…`
    : summary;
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
  target?: TelegramQueueTarget;
  replyToMessageId: number;
  controlType: PendingTelegramControlItem<TContext>["controlType"];
  queueOrder: number;
  laneOrder: number;
  statusSummary: string;
  admissionReceipts?: TelegramQueueAdmissionReceipt[];
  execute: PendingTelegramControlItem<TContext>["execute"];
}): PendingTelegramControlItem<TContext> {
  return {
    kind: "control",
    controlType: options.controlType,
    chatId: options.chatId,
    ...(options.target ? { target: options.target } : {}),
    replyToMessageId: options.replyToMessageId,
    queueOrder: options.queueOrder,
    queueLane: "control",
    laneOrder: options.laneOrder,
    statusSummary: options.statusSummary,
    ...(options.admissionReceipts?.length
      ? { admissionReceipts: structuredClone(options.admissionReceipts) }
      : {}),
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
  target?: TelegramQueueTarget;
  replyToMessageId: number;
  controlType: PendingTelegramControlItem<TContext>["controlType"];
  statusSummary: string;
  admissionReceipts?: TelegramQueueAdmissionReceipt[];
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
  foldQueuedPromptsIntoHistory: boolean;
}): boolean {
  if (!options.hasTurn) return true;
  if (options.stopReason === "aborted") {
    return !options.foldQueuedPromptsIntoHistory;
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
  shouldClearAbortHistory: boolean;
}

export interface TelegramAgentStartRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TContext = unknown,
> extends TelegramRuntimeEventRecorderPort {
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

export interface TelegramAgentStartHookRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TContext = unknown,
> extends TelegramRuntimeEventRecorderPort {
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
      shouldClearAbortHistory:
        !options.hasActiveTurn && !options.hasPendingDispatch,
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
    shouldClearAbortHistory: false,
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
  if (startPlan.shouldClearAbortHistory) {
    deps.setFoldQueuedPromptsIntoHistory(false);
  }
  deps.setQueuedItems(startPlan.remainingItems);
  if (startPlan.shouldClearDispatchPending) deps.clearDispatchPending();
  if (startPlan.activeTurn) {
    const activeTurn = startPlan.activeTurn as TTurn;
    deps.setActiveTurn(activeTurn);
    try {
      deps.onPromptHandedOff?.(activeTurn);
    } catch (error) {
      deps.recordRuntimeEvent?.("queue", error, {
        phase: "prompt-handoff-receipt-settlement",
      });
    }
    deps.createPreviewState();
    deps.startTypingLoop();
  }
  deps.updateStatus();
}

export function createTelegramAgentStartHook<
  TTurn extends PendingTelegramTurn,
  TContext = unknown,
>(deps: TelegramAgentStartHookRuntimeDeps<TTurn, TContext>) {
  return async (
    _event: TelegramAgentStartHookEvent,
    ctx: TContext,
  ): Promise<void> => {
    deps.setAbortHandler(ctx);
    handleTelegramAgentStartRuntime<TTurn, TContext>({
      queuedItems: deps.getQueuedItems(),
      hasPendingDispatch: deps.hasPendingDispatch(),
      hasActiveTurn: deps.hasActiveTurn(),
      resetToolExecutions: deps.resetToolExecutions,
      resetPendingModelSwitch: deps.resetPendingModelSwitch,
      setQueuedItems: deps.setQueuedItems,
      clearDispatchPending: deps.clearDispatchPending,
      setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
      setActiveTurn: deps.setActiveTurn,
      onPromptHandedOff: (turn) => deps.onPromptHandedOff?.(turn, ctx),
      createPreviewState: deps.createPreviewState,
      recordRuntimeEvent: deps.recordRuntimeEvent,
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
  const onAgentStart = createTelegramAgentStartHook<TTurn, TContext>(deps);
  const deliverAgentEnd = createTelegramAgentEndHook<
    TTurn,
    TContext,
    TMessage,
    TReplyMarkup
  >(deps);
  let retainedErrorEvent: TelegramAgentEndHookEvent<TMessage> | undefined;
  return {
    onAgentStart,
    async onAgentEnd(
      event: TelegramAgentEndHookEvent<TMessage>,
      ctx: TContext,
    ): Promise<void> {
      const turn = deps.getActiveTurn();
      const assistant = turn ? deps.extractAssistant(event.messages) : {};
      if (turn && assistant.stopReason === "error") {
        retainedErrorEvent = event;
        deps.recordRuntimeEvent?.(
          "provider-retry",
          new Error("Retained Telegram turn after retryable agent error"),
          { phase: "retained", hasFinalText: !!assistant.text?.trim() },
        );
        return;
      }
      if (retainedErrorEvent) {
        retainedErrorEvent = undefined;
        deps.recordRuntimeEvent?.(
          "provider-retry",
          new Error("Recovered retained Telegram turn after agent retry"),
          { phase: "recovered" },
        );
      }
      await deliverAgentEnd(event, ctx, assistant);
    },
    async onAgentSettled(_event: unknown, ctx: TContext): Promise<void> {
      const event = retainedErrorEvent;
      if (!event) return;
      retainedErrorEvent = undefined;
      deps.recordRuntimeEvent?.(
        "provider-retry",
        new Error("Finalized retained Telegram turn after agent settled"),
        { phase: "settled-failure" },
      );
      await deliverAgentEnd(event, ctx);
    },
    clearRetainedAgentEnd(): void {
      retainedErrorEvent = undefined;
    },
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
  foldQueuedPromptsIntoHistory: boolean;
  resetRuntimeState: () => void;
  isSessionActive?: () => boolean;
  isTurnTransportActive?: (turn: TTurn) => boolean;
  waitForTypingIdle?: () => Promise<void>;
  waitForActivityIdle?: () => Promise<void>;
  updateStatus: () => void;
  dispatchNextQueuedTelegramTurn: () => void;
  scheduleActiveTurnDelivery?: (task: () => Promise<void>) => void;
  clearPreview: (
    chatId: number,
    options?: { target?: TelegramQueueTarget },
  ) => Promise<void>;
  setPreviewPendingText: (text: string) => void;
  finalizeMarkdownPreview: (
    chatId: number,
    markdown: string,
    replyToMessageId: number,
    options?: { replyMarkup?: TReplyMarkup; target?: TelegramQueueTarget },
  ) => Promise<boolean>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup; target?: TelegramQueueTarget },
  ) => Promise<unknown>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: { target?: TelegramQueueTarget },
  ) => Promise<unknown>;
  sendQueuedAttachments: (turn: TTurn) => Promise<void>;
  sendRichAttachmentReply?: (
    turn: TTurn,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<boolean>;
  answerGuestQuery?: (
    guestQueryId: string,
    text?: string,
    options?: { parseMode?: string },
  ) => Promise<void>;
  sendGuestReply?: (guestQueryId: string, markdown: string) => Promise<void>;
  sendGuestAttachment?: (
    turn: TTurn,
    attachment: QueuedAttachment,
    caption?: string,
  ) => Promise<void>;
  sendGuestVoiceReply?: (
    turn: TTurn,
    plan: TelegramAgentEndOutboundReplyPlan<TReplyMarkup>,
    caption?: string,
  ) => Promise<void>;
  planOutboundReply?: (
    markdown: string,
  ) => TelegramAgentEndOutboundReplyPlan<TReplyMarkup>;
  sendOutboundReplyArtifacts?: (
    turn: TTurn,
    plan: TelegramAgentEndOutboundReplyPlan,
    options?: { replyToPrompt?: boolean },
  ) => Promise<void>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramAgentEndHookRuntimeDeps<
  TTurn extends PendingTelegramTurn,
  TContext,
  TMessage,
  TReplyMarkup = unknown,
> {
  getActiveTurn: () => TTurn | undefined;
  loadConfig?: () => Promise<void>;
  extractAssistant: (
    messages: readonly TMessage[],
  ) => TelegramAgentEndAssistantResult;
  getFoldQueuedPromptsIntoHistory: () => boolean;
  resetRuntimeState: () => void;
  isSessionActive?: (ctx: TContext) => boolean;
  isTurnTransportActive?: (turn: TTurn) => boolean;
  waitForTypingIdle?: () => Promise<void>;
  waitForActivityIdle?: () => Promise<void>;
  updateStatus: (ctx: TContext) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  requestDeferredDispatchNextQueuedTelegramTurn: (
    dispatch: (ctx: TContext) => void,
  ) => void;
  scheduleActiveTurnDelivery?: TelegramAgentEndRuntimeDeps<
    TTurn,
    TReplyMarkup
  >["scheduleActiveTurnDelivery"];
  clearPreview: TelegramAgentEndRuntimeDeps<
    TTurn,
    TReplyMarkup
  >["clearPreview"];
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
  sendRichAttachmentReply?: TelegramAgentEndRuntimeDeps<
    TTurn,
    TReplyMarkup
  >["sendRichAttachmentReply"];
  answerGuestQuery?: TelegramAgentEndRuntimeDeps<TTurn>["answerGuestQuery"];
  sendGuestReply?: TelegramAgentEndRuntimeDeps<TTurn>["sendGuestReply"];
  sendGuestAttachment?: TelegramAgentEndRuntimeDeps<TTurn>["sendGuestAttachment"];
  sendGuestVoiceReply?: TelegramAgentEndRuntimeDeps<TTurn>["sendGuestVoiceReply"];
  planOutboundReply?: TelegramAgentEndRuntimeDeps<
    TTurn,
    TReplyMarkup
  >["planOutboundReply"];
  sendOutboundReplyArtifacts?: TelegramAgentEndRuntimeDeps<TTurn>["sendOutboundReplyArtifacts"];
  recordRuntimeEvent?: TelegramAgentEndRuntimeDeps<TTurn>["recordRuntimeEvent"];
}

export interface TelegramAgentEndHookEvent<TMessage> {
  messages: readonly TMessage[];
}

export function buildTelegramAgentEndPlan(options: {
  hasTurn: boolean;
  stopReason?: string;
  hasFinalText: boolean;
  hasQueuedAttachments: boolean;
  foldQueuedPromptsIntoHistory: boolean;
}): TelegramAgentEndPlan {
  const shouldDispatchNext = shouldDispatchAfterTelegramAgentEnd({
    hasTurn: options.hasTurn,
    stopReason: options.stopReason,
    foldQueuedPromptsIntoHistory: options.foldQueuedPromptsIntoHistory,
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
  return async (
    event: TelegramAgentEndHookEvent<TMessage>,
    ctx: TContext,
    assistantOverride?: TelegramAgentEndAssistantResult,
  ): Promise<void> => {
    await deps.loadConfig?.();
    if (deps.isSessionActive && !deps.isSessionActive(ctx)) return;
    const turn = deps.getActiveTurn();
    await handleTelegramAgentEndRuntime({
      turn,
      assistant:
        assistantOverride ??
        (turn ? deps.extractAssistant(event.messages) : {}),
      foldQueuedPromptsIntoHistory: deps.getFoldQueuedPromptsIntoHistory(),
      resetRuntimeState: deps.resetRuntimeState,
      isSessionActive: () => deps.isSessionActive?.(ctx) ?? true,
      isTurnTransportActive: deps.isTurnTransportActive,
      waitForTypingIdle: deps.waitForTypingIdle,
      waitForActivityIdle: deps.waitForActivityIdle,
      updateStatus: () => deps.updateStatus(ctx),
      dispatchNextQueuedTelegramTurn: () => {
        deps.requestDeferredDispatchNextQueuedTelegramTurn(
          deps.dispatchNextQueuedTelegramTurn,
        );
      },
      scheduleActiveTurnDelivery: deps.scheduleActiveTurnDelivery
        ? (task) =>
            deps.scheduleActiveTurnDelivery?.(async () => {
              if (deps.isSessionActive?.(ctx) === false) return;
              await task();
            })
        : undefined,
      clearPreview: deps.clearPreview,
      setPreviewPendingText: deps.setPreviewPendingText,
      finalizeMarkdownPreview: deps.finalizeMarkdownPreview,
      sendMarkdownReply: deps.sendMarkdownReply,
      sendTextReply: deps.sendTextReply,
      sendQueuedAttachments: deps.sendQueuedAttachments,
      sendRichAttachmentReply: deps.sendRichAttachmentReply,
      answerGuestQuery: deps.answerGuestQuery,
      sendGuestReply: deps.sendGuestReply,
      sendGuestAttachment: deps.sendGuestAttachment,
      sendGuestVoiceReply: deps.sendGuestVoiceReply,
      planOutboundReply: deps.planOutboundReply,
      sendOutboundReplyArtifacts: deps.sendOutboundReplyArtifacts,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
  };
}

export async function handleTelegramAgentEndRuntime<
  TTurn extends PendingTelegramTurn,
  TReplyMarkup = unknown,
>(deps: TelegramAgentEndRuntimeDeps<TTurn, TReplyMarkup>): Promise<void> {
  const { turn, assistant } = deps;
  const rawFinalText = assistant.text;
  let outboundReply = rawFinalText
    ? deps.planOutboundReply?.(rawFinalText)
    : undefined;
  // Preserve the planned reply so voice-fallback can use stripped markdown + replyMarkup
  const plannedReply = outboundReply;

  // Transparent voice interception: when the turn is voice-tagged and the agent
  // did not explicitly use <!-- telegram_voice --> markup, we automatically
  // convert the whole response to voice.
  const voiceInterceptionGuard =
    turn &&
    isVoiceTurn(turn) &&
    rawFinalText?.trim() &&
    deps.planOutboundReply &&
    (!outboundReply ||
      (!outboundReply.voiceText && !outboundReply.voiceReplies?.length));
  if (voiceInterceptionGuard) {
    const voiceText =
      plannedReply !== undefined
        ? plannedReply.markdown?.trim() || ""
        : (rawFinalText ?? "");
    outboundReply = outboundReply
      ? { ...outboundReply, voiceText, markdown: "" }
      : { markdown: "", voiceText };
  }

  const finalText = outboundReply ? outboundReply.markdown : rawFinalText;
  const hasOutboundArtifacts =
    !!outboundReply?.voiceText || !!outboundReply?.voiceReplies?.length;
  const replyMarkup = outboundReply?.replyMarkup;
  const isDeliveryActive = (): boolean =>
    deps.isSessionActive?.() !== false &&
    (!turn || deps.isTurnTransportActive?.(turn) !== false);
  const updateStatusIgnoringStaleContext = (): void => {
    try {
      deps.updateStatus();
    } catch (error) {
      if (!isTelegramStaleContextError(error)) throw error;
    }
  };
  if (!isDeliveryActive()) {
    deps.resetRuntimeState();
    updateStatusIgnoringStaleContext();
    deps.dispatchNextQueuedTelegramTurn();
    return;
  }
  deps.resetRuntimeState();
  await deps.waitForTypingIdle?.();
  if (!isDeliveryActive()) {
    updateStatusIgnoringStaleContext();
    deps.dispatchNextQueuedTelegramTurn();
    return;
  }
  updateStatusIgnoringStaleContext();
  const endPlan = buildTelegramAgentEndPlan({
    hasTurn: !!turn,
    stopReason: assistant.stopReason,
    hasFinalText: !!finalText || hasOutboundArtifacts,
    hasQueuedAttachments: (turn?.queuedAttachments.length ?? 0) > 0,
    foldQueuedPromptsIntoHistory: deps.foldQueuedPromptsIntoHistory,
  });
  if (!turn) {
    if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
    return;
  }
  if (turn.guestQueryId) {
    if (assistant.errorMessage) {
      await deps.answerGuestQuery?.(
        turn.guestQueryId,
        "Telegram bridge: Pi failed while processing the request.",
      );
      if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
      return;
    }
    const [guestAttachment] = turn.queuedAttachments;
    if (guestAttachment && deps.sendGuestAttachment) {
      try {
        await deps.sendGuestAttachment(
          turn,
          guestAttachment,
          finalText || undefined,
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("delivery", error, {
          phase: "guest-attachment",
          guestQueryId: turn.guestQueryId,
        });
      }
    } else if (
      outboundReply &&
      (outboundReply.voiceText || outboundReply.voiceReplies?.length) &&
      deps.sendGuestVoiceReply
    ) {
      try {
        await deps.sendGuestVoiceReply(
          turn,
          outboundReply,
          finalText || undefined,
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("delivery", error, {
          phase: "guest-voice",
          guestQueryId: turn.guestQueryId,
        });
      }
    } else if (finalText) {
      if (deps.sendGuestReply) {
        await deps.sendGuestReply(turn.guestQueryId, finalText);
      } else {
        await deps.answerGuestQuery?.(turn.guestQueryId, finalText);
      }
    }
    if (!isDeliveryActive()) return;
    if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
    return;
  }
  if (endPlan.shouldClearPreview) {
    await deps.clearPreview(turn.chatId, { target: turn.target });
  }
  if (!isDeliveryActive()) return;
  if (endPlan.shouldSendErrorMessage) {
    await deps.sendTextReply(
      turn.chatId,
      turn.replyToMessageId,
      assistant.errorMessage ||
        "Telegram bridge: Pi failed while processing the request.",
      { target: turn.target },
    );
    if (!isDeliveryActive()) return;
    if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
    return;
  }
  const deliverActiveTurn = async () => {
    await deps.waitForActivityIdle?.();
    if (!isDeliveryActive()) return;
    if (finalText) deps.setPreviewPendingText(finalText);
    if (!finalText && hasOutboundArtifacts)
      await deps.clearPreview(turn.chatId, { target: turn.target });
    if (!isDeliveryActive()) return;
    let richAttachmentDelivered = false;
    if (
      endPlan.kind === "text" &&
      finalText &&
      !hasOutboundArtifacts &&
      deps.sendRichAttachmentReply
    ) {
      try {
        richAttachmentDelivered = await deps.sendRichAttachmentReply(
          turn,
          finalText,
          { replyMarkup },
        );
        if (!isDeliveryActive()) return;
        if (richAttachmentDelivered) {
          await deps.clearPreview(turn.chatId, { target: turn.target });
          if (!isDeliveryActive()) return;
          deps.setPreviewPendingText("");
        }
      } catch (error) {
        deps.recordRuntimeEvent?.("delivery", error, {
          phase: "rich-attachment-commit-unknown",
          chatId: turn.chatId,
        });
        if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
        return;
      }
    }
    if (!isDeliveryActive()) return;
    if (!richAttachmentDelivered && endPlan.kind === "text" && finalText) {
      try {
        const finalized = await deps.finalizeMarkdownPreview(
          turn.chatId,
          finalText,
          turn.replyToMessageId,
          { replyMarkup, target: turn.target },
        );
        if (!isDeliveryActive()) return;
        if (!finalized) {
          await deps.clearPreview(turn.chatId, { target: turn.target });
          if (!isDeliveryActive()) return;
          await deps.sendMarkdownReply(
            turn.chatId,
            turn.replyToMessageId,
            finalText,
            { replyMarkup, target: turn.target },
          );
        }
        if (!isDeliveryActive()) return;
        deps.setPreviewPendingText("");
      } catch (error) {
        deps.recordRuntimeEvent?.("delivery", error, {
          phase: "final-text",
          chatId: turn.chatId,
          replyToMessageId: turn.replyToMessageId,
        });
      }
    }
    if (!isDeliveryActive()) return;
    if (outboundReply && deps.sendOutboundReplyArtifacts) {
      try {
        await deps.sendOutboundReplyArtifacts(turn, outboundReply, {
          replyToPrompt: !finalText,
        });
        if (!isDeliveryActive()) return;
      } catch (error) {
        deps.recordRuntimeEvent?.("delivery", error, {
          phase: "voice-artifacts",
          chatId: turn.chatId,
        });
        // Fallback to planned text when voice delivery fails and text wasn't already delivered
        if (!isDeliveryActive()) return;
        if (rawFinalText?.trim() && !finalText && hasOutboundArtifacts) {
          try {
            const fallbackMarkdown =
              plannedReply?.markdown ||
              outboundReply?.voiceText ||
              rawFinalText;
            await deps.sendMarkdownReply(
              turn.chatId,
              turn.replyToMessageId,
              fallbackMarkdown,
              plannedReply?.replyMarkup || turn.target
                ? {
                    replyMarkup: plannedReply?.replyMarkup,
                    target: turn.target,
                  }
                : undefined,
            );
          } catch (fallbackError) {
            deps.recordRuntimeEvent?.("delivery", fallbackError, {
              phase: "voice-fallback-text",
              chatId: turn.chatId,
            });
          }
        }
      }
    }
    if (!isDeliveryActive()) return;
    if (!richAttachmentDelivered && endPlan.shouldSendAttachmentNotice) {
      await deps.sendTextReply(
        turn.chatId,
        turn.replyToMessageId,
        "Attached requested file(s).",
        { target: turn.target },
      );
    }
    if (!isDeliveryActive()) return;
    if (!richAttachmentDelivered) await deps.sendQueuedAttachments(turn);
    if (!isDeliveryActive()) return;
    if (endPlan.shouldDispatchNext) deps.dispatchNextQueuedTelegramTurn();
  };
  if (
    deps.scheduleActiveTurnDelivery &&
    (endPlan.kind === "text" || endPlan.kind === "attachments-only")
  ) {
    deps.scheduleActiveTurnDelivery(deliverActiveTurn);
    return;
  }
  await deliverActiveTurn();
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
  clearPreview: (
    chatId: number,
    options?: { target?: TelegramQueueTarget },
  ) => Promise<void>;
  previewShutdownTimeoutMs?: number;
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
  isSessionActive?: (ctx: TContext) => boolean;
  unbindDeferredDispatchContext?: () => void;
  discardQueuedItems?: (ctx: TContext) => void;
  applySessionShutdownState: (
    state: TelegramSessionShutdownState<TQueueItem>,
  ) => void;
  clearPendingMediaGroups: () => void;
  clearModelMenuState: () => void;
  getActiveTurnChatId: () => number | undefined;
  getActiveTurnTarget?: () => TelegramQueueTarget | undefined;
  clearPreview: (
    chatId: number,
    options?: { target?: TelegramQueueTarget },
  ) => Promise<void>;
  previewShutdownTimeoutMs?: number;
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
> extends TelegramQueueStore<TContext>, TelegramRuntimeEventRecorderPort {
  ctx: TContext;
  allocateLaneOrder?: () => number;
  onItemsDiscarded?: (
    items: readonly TelegramQueueItem<TContext>[],
    ctx: TContext,
  ) => void;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramQueueMutationControllerDeps<
  TContext,
> extends TelegramQueueStore<TContext>, TelegramRuntimeEventRecorderPort {
  allocateLaneOrder?: () => number;
  onItemsDiscarded?: (
    items: readonly TelegramQueueItem<TContext>[],
    ctx: TContext,
  ) => void;
  updateStatus: (ctx: TContext) => void;
}

export interface TelegramQueueMutationController<TContext> {
  append: (item: TelegramQueueItem<TContext>, ctx: TContext) => void;
  reorder: (ctx: TContext) => void;
  clear: (ctx: TContext) => number;
  removeByMessageIds: (
    messageIds: number[],
    ctx: TContext,
    scope?: TelegramQueueMessageScope,
  ) => number;
  applyReactionByMessageId: (
    messageId: number,
    disposition: TelegramQueueReactionDisposition,
    ctx: TContext,
    scope?: TelegramQueueMessageScope,
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
  enqueue: (
    item: PendingTelegramControlItem<TContext>,
    ctx: TContext,
    onQueued?: (item: PendingTelegramControlItem<TContext>) => void,
  ) => void;
}

export interface TelegramPromptEnqueueRuntimeDeps<
  TMessage,
  TContext = unknown,
> extends TelegramQueueStore<TContext> {
  getFoldQueuedPromptsIntoHistory: () => boolean;
  setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
  createTurn: (
    messages: TMessage[],
    historyTurns: PendingTelegramTurn[],
  ) => Promise<PendingTelegramTurn>;
  updateStatus: () => void;
  dispatchNextQueuedTelegramTurn: () => void;
  assertExecutionCurrent?: () => void;
  onQueued?: (turn: PendingTelegramTurn) => void;
}

export interface TelegramPromptEnqueueControllerDeps<
  TMessage,
  TContext = unknown,
> extends TelegramQueueStore<TContext> {
  getFoldQueuedPromptsIntoHistory: () => boolean;
  setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
  createTurn: (
    messages: TMessage[],
    historyTurns: PendingTelegramTurn[],
    ctx: TContext,
  ) => Promise<PendingTelegramTurn>;
  updateStatus: (ctx: TContext) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  assertExecutionCurrent?: (messages: TMessage[]) => void;
}

export interface TelegramPromptEnqueueController<TMessage, TContext = unknown> {
  enqueue: (
    messages: TMessage[],
    ctx: TContext,
    onQueued?: (turn: PendingTelegramTurn) => void,
  ) => Promise<PendingTelegramTurn>;
}

function isTelegramStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale after session") ||
      error.message.includes("stale ctx"))
  );
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
    currentTelegramModel: undefined,
    activeTelegramToolExecutions: 0,
    pendingTelegramModelSwitch: undefined,
    telegramTurnDispatchPending: false,
    compactionInProgress: false,
    foldQueuedPromptsIntoHistory: false,
  };
}

export async function startTelegramSessionRuntime<TContext, TModel = unknown>(
  deps: TelegramSessionStartRuntimeDeps<TContext, TModel>,
): Promise<void> {
  await deps.loadConfig();
  if (deps.isSessionActive?.() === false) return;
  deps.applyState(buildTelegramSessionStartState(deps.currentModel));
  await deps.prepareTempDir();
  if (deps.isSessionActive?.() === false) return;
  try {
    deps.bindDeferredDispatchContext?.(deps.ctx);
  } catch (error) {
    if (!isTelegramStaleContextError(error)) throw error;
  }
  deps.updateStatus();
}

export async function shutdownTelegramSessionRuntime<TQueueItem>(
  deps: TelegramSessionShutdownRuntimeDeps<TQueueItem>,
): Promise<void> {
  if (deps.isSessionActive?.() === false) return;
  deps.unbindDeferredDispatchContext?.();
  await deps.stopPolling();
  if (deps.isSessionActive?.() === false) return;
  deps.discardQueuedItems?.();
  deps.applyState(buildTelegramSessionShutdownState<TQueueItem>());
  deps.clearPendingMediaGroups();
  deps.clearModelMenuState();
  const activeTurnChatId = deps.getActiveTurnChatId();
  if (activeTurnChatId !== undefined) {
    const target = deps.getActiveTurnTarget?.();
    const previewTimeoutMs = deps.previewShutdownTimeoutMs ?? 1000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      deps.clearPreview(activeTurnChatId, target ? { target } : undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, previewTimeoutMs);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (deps.isSessionActive?.() === false) return;
  }
  deps.clearActiveTurn();
  deps.clearAbort();
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
    isSessionActive: deps.isSessionActive,
    unbindDeferredDispatchContext: deps.unbindDeferredDispatchContext,
    discardQueuedItems: deps.discardQueuedItems,
    applySessionShutdownState: stateApplier.applyShutdownState,
    clearPendingMediaGroups: deps.clearPendingMediaGroups,
    clearModelMenuState: deps.clearModelMenuState,
    getActiveTurnChatId: deps.getActiveTurnChatId,
    getActiveTurnTarget: deps.getActiveTurnTarget,
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
          isSessionActive: () => deps.isSessionActive?.(ctx) ?? true,
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
    onSessionShutdown: async (
      _event?: TelegramSessionLifecycleHookEvent,
      ctx?: TContext,
    ): Promise<void> => {
      try {
        await shutdownTelegramSessionRuntime<TQueueItem>({
          isSessionActive: () =>
            ctx === undefined ? true : (deps.isSessionActive?.(ctx) ?? true),
          unbindDeferredDispatchContext: deps.unbindDeferredDispatchContext,
          discardQueuedItems:
            ctx === undefined || !deps.discardQueuedItems
              ? undefined
              : () => deps.discardQueuedItems!(ctx),
          applyState: deps.applySessionShutdownState,
          clearPendingMediaGroups: deps.clearPendingMediaGroups,
          clearModelMenuState: deps.clearModelMenuState,
          getActiveTurnChatId: deps.getActiveTurnChatId,
          getActiveTurnTarget: deps.getActiveTurnTarget,
          clearPreview: deps.clearPreview,
          previewShutdownTimeoutMs: deps.previewShutdownTimeoutMs,
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
    removeByMessageIds: (messageIds, ctx, scope) =>
      removeTelegramQueueItemsByMessageIdsRuntime(
        messageIds,
        buildRuntimeDeps(ctx),
        scope,
      ),
    applyReactionByMessageId: (messageId, disposition, ctx, scope) =>
      applyTelegramQueuePromptReactionDispositionRuntime(
        messageId,
        disposition,
        buildRuntimeDeps(ctx),
        scope,
      ),
  };
}

function updateTelegramQueueStatusRuntime<TContext>(
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): void {
  try {
    deps.updateStatus(deps.ctx);
  } catch (error) {
    if (!isTelegramStaleContextError(error)) throw error;
  }
}

function commitReorderedTelegramQueueItemsRuntime<TContext>(
  items: TelegramQueueItem<TContext>[],
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): void {
  deps.setQueuedItems([...items].sort(compareTelegramQueueItems));
  updateTelegramQueueStatusRuntime(deps);
}

function appendTelegramQueueItemRuntime<TContext>(
  item: TelegramQueueItem<TContext>,
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): void {
  const currentItems = deps.getQueuedItems();
  const nextItems = appendTelegramQueueItem(currentItems, item);
  if (nextItems === currentItems) return;
  commitReorderedTelegramQueueItemsRuntime(nextItems, deps);
}

export function reorderTelegramQueueItemsRuntime<TContext>(
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): void {
  commitReorderedTelegramQueueItemsRuntime(deps.getQueuedItems(), deps);
}

export function clearTelegramQueueItemsRuntime<TContext>(
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
): number {
  const removedItems = deps.getQueuedItems();
  const removedCount = removedItems.length;
  if (removedCount === 0) return 0;
  deps.onItemsDiscarded?.(removedItems, deps.ctx);
  deps.setQueuedItems([]);
  updateTelegramQueueStatusRuntime(deps);
  return removedCount;
}

export function removeTelegramQueueItemsByMessageIdsRuntime<TContext>(
  messageIds: number[],
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
  scope?: TelegramQueueMessageScope,
): number {
  const { items, removedItems, removedCount } =
    removeTelegramQueueItemsByMessageIds(
      deps.getQueuedItems(),
      messageIds,
      scope,
    );
  if (removedCount === 0) return 0;
  deps.setQueuedItems(items);
  try {
    deps.onItemsDiscarded?.(removedItems, deps.ctx);
  } catch (error) {
    deps.recordRuntimeEvent?.("queue", error, {
      phase: "discard-receipt-settlement",
    });
  }
  updateTelegramQueueStatusRuntime(deps);
  return removedCount;
}

export function applyTelegramQueuePromptReactionDispositionRuntime<TContext>(
  messageId: number,
  disposition: TelegramQueueReactionDisposition,
  deps: TelegramQueueMutationRuntimeDeps<TContext>,
  scope?: TelegramQueueMessageScope,
): boolean {
  const queuedItems = deps.getQueuedItems();
  const changesLane = queuedItems.some((item) => {
    if (
      !isPendingTelegramTurn(item) ||
      !isTelegramQueueItemInMessageScope(item, scope) ||
      !item.sourceMessageIds.includes(messageId)
    ) {
      return false;
    }
    const queueLane: TelegramQueueLane =
      disposition.kind === "reaction-transition"
        ? disposition.priorityEmoji === undefined
          ? item.queueLane
          : disposition.priorityEmoji === null
            ? "default"
            : "priority"
        : disposition.kind === "priority" ||
            disposition.kind === "priority-suppressed"
          ? "priority"
          : "default";
    return item.queueLane !== queueLane;
  });
  const destinationLaneOrder = changesLane
    ? deps.allocateLaneOrder?.()
    : undefined;
  if (changesLane && destinationLaneOrder === undefined) return false;
  const { changed, items } = applyTelegramQueuePromptReactionDisposition(
    queuedItems,
    messageId,
    disposition,
    destinationLaneOrder,
    scope,
  );
  if (!changed) return false;
  commitReorderedTelegramQueueItemsRuntime(items, deps);
  return true;
}

export async function enqueueTelegramPromptTurnRuntime<
  TMessage,
  TContext = unknown,
>(
  messages: TMessage[],
  deps: TelegramPromptEnqueueRuntimeDeps<TMessage, TContext>,
): Promise<PendingTelegramTurn> {
  const enqueuePlan = planTelegramPromptEnqueue(
    deps.getQueuedItems(),
    deps.getFoldQueuedPromptsIntoHistory(),
  );
  deps.assertExecutionCurrent?.();
  deps.setFoldQueuedPromptsIntoHistory(false);
  const turn = await deps.createTurn(messages, enqueuePlan.historyTurns);
  deps.assertExecutionCurrent?.();
  deps.setQueuedItems(
    appendTelegramQueueItem(enqueuePlan.remainingItems, turn),
  );
  deps.onQueued?.(turn);
  deps.updateStatus();
  deps.dispatchNextQueuedTelegramTurn();
  return turn;
}

export function createTelegramPromptEnqueueController<
  TMessage,
  TContext = unknown,
>(
  deps: TelegramPromptEnqueueControllerDeps<TMessage, TContext>,
): TelegramPromptEnqueueController<TMessage, TContext> {
  return {
    enqueue: (messages, ctx, onQueued) =>
      enqueueTelegramPromptTurnRuntime(messages, {
        ...deps,
        createTurn: (nextMessages, historyTurns) =>
          deps.createTurn(nextMessages, historyTurns, ctx),
        updateStatus: () => deps.updateStatus(ctx),
        dispatchNextQueuedTelegramTurn: () =>
          deps.dispatchNextQueuedTelegramTurn(ctx),
        assertExecutionCurrent: () =>
          deps.assertExecutionCurrent?.(messages),
        onQueued,
      }),
  };
}

export function createTelegramControlQueueController<TContext>(
  deps: TelegramControlQueueControllerDeps<TContext>,
): TelegramControlQueueController<TContext> {
  return {
    enqueue: (item, ctx, onQueued) => {
      deps.appendControlItem(item, ctx);
      onQueued?.(item);
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
    options?: { target?: TelegramQueueTarget },
  ) => Promise<number | undefined>;
  onSettled: (item: PendingTelegramControlItem<TContext>) => void;
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
      { target: item.target },
    );
  } finally {
    deps.onSettled(item);
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
  getGeneration: () => number;
  isGenerationActive: (generation: number) => boolean;
  request: (dispatchNextQueuedTelegramTurn: (ctx: TContext) => void) => void;
}

/**
 * Production debounce for deferred queue dispatch; the factory defaults to this
 * so the entrypoint wires ports instead of policy constants.
 */
export const TELEGRAM_DEFERRED_DISPATCH_DELAY_MS = 50;

export function createTelegramDeferredQueueDispatchRuntime<TContext = unknown>(
  deps: TelegramDeferredQueueDispatchRuntimeDeps = {},
): TelegramDeferredQueueDispatchRuntime<TContext> {
  let boundContext: TContext | undefined;
  let generation = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const delayMs = deps.delayMs ?? TELEGRAM_DEFERRED_DISPATCH_DELAY_MS;
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
    getGeneration: () => generation,
    isGenerationActive: (expectedGeneration) =>
      boundContext !== undefined && generation === expectedGeneration,
    request: (dispatchNextQueuedTelegramTurn) => {
      if (boundContext === undefined) return;
      const scheduledGeneration = generation;
      let timer: ReturnType<typeof setTimeout>;
      timer = setTimer(() => {
        timers.delete(timer);
        if (generation !== scheduledGeneration || boundContext === undefined)
          return;
        try {
          dispatchNextQueuedTelegramTurn(boundContext);
        } catch (error) {
          try {
            deps.recordRuntimeEvent?.("dispatch", error, {
              phase: "deferred-queue-dispatch",
              generation: scheduledGeneration,
            });
          } catch {
            // Timer diagnostics cannot escape the deferred owner.
          }
        }
      }, delayMs);
      timer.unref?.();
      timers.add(timer);
    },
  };
}

// --- Dispatch Watchdog Runtime ---

export interface TelegramQueueDispatchWatchdogRuntime<TContext = unknown> {
  start: (ctx: TContext) => void;
  stop: () => void;
  poke: () => void;
}

export interface TelegramQueueDispatchWatchdogRuntimeDeps<
  TContext = unknown,
> extends TelegramRuntimeEventRecorderPort {
  hasQueuedItems: () => boolean;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  intervalMs?: number;
  setInterval?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export function createTelegramQueueDispatchWatchdogRuntime<TContext = unknown>(
  deps: TelegramQueueDispatchWatchdogRuntimeDeps<TContext>,
): TelegramQueueDispatchWatchdogRuntime<TContext> {
  const intervalMs = deps.intervalMs ?? 1000;
  const setIntervalFn: NonNullable<
    TelegramQueueDispatchWatchdogRuntimeDeps<TContext>["setInterval"]
  > = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn: NonNullable<
    TelegramQueueDispatchWatchdogRuntimeDeps<TContext>["clearInterval"]
  > = deps.clearInterval ?? ((timer) => clearInterval(timer));
  let ctx: TContext | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let dispatchInFlight = false;
  const tick = (): void => {
    if (ctx === undefined || dispatchInFlight || !deps.hasQueuedItems()) return;
    dispatchInFlight = true;
    try {
      deps.dispatchNextQueuedTelegramTurn(ctx);
    } catch (error) {
      try {
        deps.recordRuntimeEvent?.("dispatch", error, {
          phase: "queue-watchdog",
        });
      } catch {
        // Watchdog diagnostics cannot escape the interval owner.
      }
    } finally {
      dispatchInFlight = false;
    }
  };
  const stop = (): void => {
    ctx = undefined;
    if (!interval) return;
    clearIntervalFn(interval);
    interval = undefined;
  };
  return {
    start: (nextCtx) => {
      ctx = nextCtx;
      if (!interval) {
        const nextInterval = setIntervalFn(tick, intervalMs);
        interval = nextInterval;
        nextInterval.unref?.();
      }
      tick();
    },
    stop,
    poke: tick,
  };
}

// --- Dispatch Runtime ---

export interface TelegramPromptDeliveryOptions {
  deliverAs: "followUp";
}

export interface TelegramDispatchRuntimeDeps<TContext = unknown> {
  executeControlItem: (
    item: Extract<
      TelegramQueueDispatchAction<TContext>,
      { kind: "control" }
    >["item"],
  ) => void;
  onPromptDispatchStart: (chatId: number) => void;
  commitPromptDispatch?: (
    item: Extract<TelegramQueueDispatchAction<TContext>, { kind: "prompt" }>["item"],
  ) => boolean;
  sendUserMessage: (
    content: Extract<
      TelegramQueueDispatchAction,
      { kind: "prompt" }
    >["item"]["content"],
    options?: TelegramPromptDeliveryOptions,
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
  getDispatchGeneration?: () => number;
  isDispatchGenerationActive?: (generation: number) => boolean;
  updateStatus: (ctx: TContext, error?: string) => void;
  sendTextReply: TelegramControlRuntimeDeps<TContext>["sendTextReply"];
  onPromptDispatchStart: (ctx: TContext, chatId: number) => void;
  commitPromptDispatch?: (
    item: Extract<TelegramQueueDispatchAction<TContext>, { kind: "prompt" }>["item"],
    ctx: TContext,
  ) => boolean;
  sendUserMessage: TelegramDispatchRuntimeDeps<TContext>["sendUserMessage"];
  onPromptDispatchFailure: (ctx: TContext, message: string) => void;
  isQueueItemTransportActive?: (item: TelegramQueueItem<TContext>) => boolean;
  hasPendingInboundQueueMutationForItem?: (
    item: TelegramQueueItem<TContext>,
  ) => boolean;
  isQueueItemAdmissionReady?: (item: TelegramQueueItem<TContext>) => boolean;
  onControlSettled?: (
    item: PendingTelegramControlItem<TContext>,
    ctx: TContext,
  ) => void;
  onPromptSkipped?: (item: PendingTelegramTurn, ctx: TContext) => boolean;
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
    if (deps.commitPromptDispatch && !deps.commitPromptDispatch(plan.item)) {
      throw new Error("Telegram prompt dispatch could not be committed durably.");
    }
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
    getDispatchGeneration: deps.getDispatchGeneration,
    isDispatchGenerationActive: deps.isDispatchGenerationActive,
    updateStatus: deps.updateStatus,
    sendTextReply: deps.sendTextReply,
    onPromptDispatchStart: deps.onPromptDispatchStart,
    commitPromptDispatch: deps.commitPromptDispatch,
    sendUserMessage: deps.sendUserMessage,
    onPromptDispatchFailure: deps.onPromptDispatchFailure,
    isQueueItemTransportActive: deps.isQueueItemTransportActive,
    hasPendingInboundQueueMutationForItem:
      deps.hasPendingInboundQueueMutationForItem,
    isQueueItemAdmissionReady: deps.isQueueItemAdmissionReady,
    onControlSettled: deps.onControlSettled,
    onPromptSkipped: deps.onPromptSkipped,
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
      const queuedItems = deps.getQueuedItems();
      const activeItems: TelegramQueueItem<TContext>[] = [];
      const protectedInactiveItems: TelegramQueueItem<TContext>[] = [];
      const retainedItems: TelegramQueueItem<TContext>[] = [];
      let droppedInactiveItemCount = 0;
      for (const item of queuedItems) {
        if (
          !deps.isQueueItemTransportActive ||
          deps.isQueueItemTransportActive(item)
        ) {
          activeItems.push(item);
          retainedItems.push(item);
        } else if ((item.admissionReceipts?.length ?? 0) > 0) {
          protectedInactiveItems.push(item);
          retainedItems.push(item);
        } else {
          droppedInactiveItemCount += 1;
        }
      }
      if (droppedInactiveItemCount > 0) {
        deps.setQueuedItems(retainedItems);
        deps.recordRuntimeEvent?.(
          "dispatch",
          new Error(
            "Dropped queue work from an inactive Telegram transport generation.",
          ),
          { phase: "transport-generation" },
        );
      }
      const canDispatch = deps.canDispatch(ctx);
      let nextActiveIndex = 0;
      if (canDispatch) {
        while (nextActiveIndex < activeItems.length) {
          const candidate = activeItems[nextActiveIndex];
          if (
            !candidate ||
            candidate.kind !== "prompt" ||
            candidate.reactionSuppressionEmoji === undefined
          ) {
            break;
          }
          if (deps.hasPendingInboundQueueMutationForItem?.(candidate)) {
            deps.updateStatus(ctx);
            return;
          }
          if (
            deps.isQueueItemAdmissionReady &&
            !deps.isQueueItemAdmissionReady(candidate)
          ) {
            deps.updateStatus(ctx);
            return;
          }
          try {
            if (deps.onPromptSkipped && !deps.onPromptSkipped(candidate, ctx)) {
              deps.updateStatus(
                ctx,
                "Telegram skipped prompt could not be settled durably.",
              );
              return;
            }
          } catch (error) {
            deps.recordRuntimeEvent?.("dispatch", error, {
              phase: "skip-receipt-settlement",
            });
            deps.updateStatus(
              ctx,
              "Telegram skipped prompt could not be settled durably.",
            );
            return;
          }
          nextActiveIndex += 1;
          deps.setQueuedItems([
            ...activeItems.slice(nextActiveIndex),
            ...protectedInactiveItems,
          ]);
        }
      }
      const dispatchableItems = activeItems.slice(nextActiveIndex);
      const nextItem = dispatchableItems[0];
      if (
        nextItem &&
        deps.hasPendingInboundQueueMutationForItem?.(nextItem)
      ) {
        deps.updateStatus(ctx);
        return;
      }
      if (
        nextItem &&
        deps.isQueueItemAdmissionReady &&
        !deps.isQueueItemAdmissionReady(nextItem)
      ) {
        deps.updateStatus(ctx);
        return;
      }
      const dispatchPlan = planNextTelegramQueueAction(
        dispatchableItems,
        canDispatch,
      );
      if (dispatchPlan.kind !== "none") {
        deps.setQueuedItems([
          ...dispatchPlan.remainingItems,
          ...protectedInactiveItems,
        ]);
      }
      executeTelegramQueueDispatchPlan(dispatchPlan, {
        executeControlItem: (item) => {
          controlDispatchPending = true;
          const dispatchGeneration = deps.getDispatchGeneration?.();
          deps.updateStatus(ctx);
          void executeTelegramControlItemRuntime(item, {
            ctx,
            sendTextReply: deps.sendTextReply,
            recordRuntimeEvent: deps.recordRuntimeEvent,
            onSettled: (settledItem) => {
              try {
                deps.onControlSettled?.(settledItem, ctx);
              } catch (error) {
                deps.recordRuntimeEvent?.("control", error, {
                  phase: "receipt-settlement",
                  controlType: settledItem.controlType,
                });
              }
              controlDispatchPending = false;
              if (deps.hasDispatchContext && !deps.hasDispatchContext()) return;
              if (
                dispatchGeneration !== undefined &&
                deps.isDispatchGenerationActive &&
                !deps.isDispatchGenerationActive(dispatchGeneration)
              ) {
                return;
              }
              deps.updateStatus(ctx);
              controller.dispatchNext(ctx);
            },
          });
        },
        onPromptDispatchStart: (chatId) => {
          deps.onPromptDispatchStart(ctx, chatId);
        },
        commitPromptDispatch: deps.commitPromptDispatch
          ? (item) => deps.commitPromptDispatch!(item, ctx)
          : undefined,
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
