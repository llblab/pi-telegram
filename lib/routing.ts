/**
 * Telegram inbound routing composition
 * Zones: telegram inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing
 */

import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import * as Bus from "./bus.ts";
import * as Commands from "./commands.ts";
import type { TelegramConfigStore } from "./config.ts";
import type { TelegramSectionRegistry } from "./sections.ts";
import type { TelegramInboundHandlerRuntime } from "./inbound.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Queue from "./queue.ts";
import type { TelegramBridgeRuntime } from "./runtime.ts";
import * as TextGroups from "./text-groups.ts";
import type {
  TelegramInstanceThreadIdentityCandidate,
  TelegramTopicTargetRecord,
} from "./threads.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import * as Turns from "./turns.ts";

interface TelegramPromptPeerView {
  id?: unknown;
  is_bot?: unknown;
  username?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  title?: unknown;
}

function formatTelegramPromptPeer(
  peer: TelegramPromptPeerView | undefined,
): string | undefined {
  if (!peer) return undefined;
  if (typeof peer.username === "string" && peer.username.length > 0) {
    return peer.username;
  }
  const displayName = [peer.first_name, peer.last_name]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");
  if (displayName) return displayName;
  if (typeof peer.title === "string" && peer.title.length > 0) {
    return peer.title;
  }
  return typeof peer.id === "number" ? String(peer.id) : undefined;
}

function isTelegramPromptOwnerPeer(
  peer: TelegramPromptPeerView | undefined,
  ownerUserId: number | undefined,
): boolean {
  return ownerUserId !== undefined && peer?.id === ownerUserId;
}

function isTelegramPromptBotPeer(
  peer: TelegramPromptPeerView | undefined,
): boolean {
  return peer?.is_bot === true;
}

export function resolveTelegramGuestPromptPeer(input: {
  chatType?: string;
  chat?: TelegramPromptPeerView;
  from?: TelegramPromptPeerView;
  replyFrom?: TelegramPromptPeerView;
  guestBotCallerUser?: TelegramPromptPeerView;
  guestBotCallerChat?: TelegramPromptPeerView;
  ownerUserId?: number;
}): string | undefined {
  if (input.chatType !== "private") {
    return formatTelegramPromptPeer(input.chat);
  }
  if (
    !isTelegramPromptOwnerPeer(input.from, input.ownerUserId) &&
    !isTelegramPromptBotPeer(input.from)
  ) {
    return formatTelegramPromptPeer(input.from);
  }
  for (const candidate of [
    input.chat,
    input.guestBotCallerUser,
    input.guestBotCallerChat,
    input.replyFrom,
  ]) {
    if (
      isTelegramPromptOwnerPeer(candidate, input.ownerUserId) ||
      isTelegramPromptBotPeer(candidate)
    ) {
      continue;
    }
    const peer = formatTelegramPromptPeer(candidate);
    if (peer) return peer;
  }
  return undefined;
}

function appendTelegramSourceAttachmentSection(
  text: string,
  from: string | undefined,
  files: Pick<Media.DownloadedTelegramFile, "path">[],
): string {
  if (files.length === 0) return text;
  const dirs = [...new Set(files.map((file) => dirname(file.path)))];
  const sameDir = dirs.length === 1;
  const source = from ? `|from:${from}` : "";
  const header = sameDir
    ? `[attachments${source}] ${dirs[0]}`
    : `[attachments${source}]`;
  const items = sameDir
    ? files.map((file) => `/${basename(file.path)}`)
    : files.map((file) => file.path);
  const prefix = text.length > 0 ? `${text}\n\n` : "";
  return `${prefix}${header}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function getContextCwd(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const cwd = (ctx as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function getLeaderTopicProfileKey(
  ctx: unknown,
  instanceId: string | undefined,
): string | undefined {
  const cwd = getContextCwd(ctx);
  if (cwd) return `cwd:${cwd}`;
  return instanceId ? `leader:${instanceId}` : undefined;
}

function isCurrentLeaderTopicRecord(
  record: Threads.TelegramTopicTargetRecord,
  profileKey: string | undefined,
  instanceId: string | undefined,
): boolean {
  if (instanceId && record.instanceId === instanceId) return true;
  return !!profileKey && record.profileKey === profileKey;
}

function hasActiveLeaderTopic(
  records: Threads.TelegramTopicTargetRecord[],
  profileKey: string | undefined,
  instanceId: string | undefined,
): boolean {
  return records.some((record) => {
    if (record.status !== "active") return false;
    return isCurrentLeaderTopicRecord(record, profileKey, instanceId);
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface TelegramAllTabPendingCommand {
  command: Commands.ParsedTelegramCommand;
  text: string;
  createdAtMs: number;
}

const TELEGRAM_ALL_TAB_MENU_CALLBACK_PREFIX = "allmenu:";
const TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX = "reroute:";
const TELEGRAM_UNBOUND_REROUTE_RESTORE_MENU_CALLBACK_PREFIX = "rerouterestore:";
const TELEGRAM_UNBOUND_REROUTE_NEW_SLOT_CALLBACK_PREFIX = "reroutenew:";

function formatTelegramAllTabMenuCallbackData(
  commandId: string,
  threadId: number,
): string {
  return `${TELEGRAM_ALL_TAB_MENU_CALLBACK_PREFIX}${commandId}:${threadId}`;
}

function parseTelegramAllTabMenuCallbackData(
  data: string | undefined,
): { commandId: string; threadId: number } | undefined {
  const match = data?.match(/^allmenu:([a-z0-9]+):(\d+)$/);
  const commandId = match?.[1];
  const threadId = Number(match?.[2]);
  if (!commandId || !Number.isSafeInteger(threadId)) return undefined;
  return { commandId, threadId };
}

function formatTelegramUnboundRerouteCallbackData(
  rerouteId: string,
  threadId: number,
): string {
  return `${TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX}${rerouteId}:${threadId}`;
}

function formatTelegramUnboundRerouteRestoreMenuCallbackData(
  rerouteId: string,
): string {
  return `${TELEGRAM_UNBOUND_REROUTE_RESTORE_MENU_CALLBACK_PREFIX}${rerouteId}`;
}

function formatTelegramUnboundRerouteNewSlotCallbackData(
  rerouteId: string,
  threadId: number,
): string {
  return `${TELEGRAM_UNBOUND_REROUTE_NEW_SLOT_CALLBACK_PREFIX}${rerouteId}:${threadId}`;
}

function parseTelegramUnboundRerouteRestoreMenuCallbackData(
  data: string | undefined,
): { rerouteId: string } | undefined {
  const match = data?.match(/^rerouterestore:([a-z0-9]+)$/);
  const rerouteId = match?.[1];
  return rerouteId ? { rerouteId } : undefined;
}

function parseTelegramUnboundRerouteCallbackData(
  data: string | undefined,
): { rerouteId: string; threadId: number; useNewSlot: boolean } | undefined {
  const match = data?.match(/^(reroute|reroutenew):([a-z0-9]+):(\d+)$/);
  const prefix = match?.[1];
  const rerouteId = match?.[2];
  const threadId = Number(match?.[3]);
  if (!prefix || !rerouteId || !Number.isSafeInteger(threadId))
    return undefined;
  return { rerouteId, threadId, useNewSlot: prefix === "reroutenew" };
}

function getTelegramThreadRecordLabel(
  record: Threads.TelegramTopicTargetRecord,
): string {
  return getRestoredThreadName(record, record.slot ?? "");
}

function getTelegramRouteThreadButtonLabel(
  record: Threads.TelegramTopicTargetRecord,
): string {
  return `↪️ ${getTelegramThreadRecordLabel(record)}`;
}

function getTelegramReplaceThreadButtonLabel(
  record: Threads.TelegramTopicTargetRecord,
): string {
  return `➡️ ${getTelegramThreadRecordLabel(record)}`;
}

function getNextTelegramSlotPreference(
  slot: string | undefined,
): string | undefined {
  if (!slot || !/^[A-Z]$/.test(slot)) return undefined;
  const index = slot.charCodeAt(0) - "A".charCodeAt(0);
  return String.fromCharCode("A".charCodeAt(0) + ((index + 1) % 26));
}

function getRestoredThreadName(
  record: Threads.TelegramTopicTargetRecord,
  slot: string,
): string {
  return record.threadName &&
    Threads.isTelegramTopicThreadNameValidForSlot(record.threadName, slot)
    ? record.threadName
    : (Threads.chooseTelegramThreadName({ slot }) ?? "Pi");
}

function isTelegramLiveThreadTarget(
  record: Threads.TelegramTopicTargetRecord,
  liveTargets: readonly Queue.TelegramQueueTarget[] | undefined,
): boolean {
  if (!liveTargets) return record.status === "active";
  return liveTargets.some(
    (target) =>
      target.chatId === record.target.chatId &&
      target.threadId === record.target.threadId,
  );
}

function getTelegramRoutableThreadRecords(
  records: readonly Threads.TelegramTopicTargetRecord[],
  liveTargets: readonly Queue.TelegramQueueTarget[] | undefined,
): Threads.TelegramTopicTargetRecord[] {
  return records.filter(
    (record) =>
      record.status === "active" &&
      isTelegramLiveThreadTarget(record, liveTargets),
  );
}

function buildTelegramAllTabMenuChooserMarkup(
  commandId: string,
  records: readonly Threads.TelegramTopicTargetRecord[],
): Menu.TelegramReplyMarkup {
  const rows = records.map((record) => [
    {
      text: getTelegramRouteThreadButtonLabel(record),
      callback_data: formatTelegramAllTabMenuCallbackData(
        commandId,
        record.target.threadId,
      ),
    },
  ]);
  return { inline_keyboard: rows };
}

function formatTelegramAllTabMenuChooserText(command: string): string {
  return [
    "<b>🧵 Choose target thread</b>",
    "",
    `You used <code>/${escapeHtml(command)}</code> from the <b>All</b> tab.`,
    "Select the Pi thread that should handle it:",
  ].join("\n");
}

function buildTelegramUnboundRerouteChooserMarkup(
  rerouteId: string,
  records: readonly Threads.TelegramTopicTargetRecord[],
  _options: {
    currentLeaderProfileKey?: string;
    currentInstanceId?: string;
  } = {},
): Menu.TelegramReplyMarkup {
  const activeRecords = records.filter((record) => record.status === "active");
  const canRestoreAnyLiveThread = activeRecords.length > 0;
  const rows = activeRecords.map((record) => [
    {
      text: getTelegramRouteThreadButtonLabel(record),
      callback_data: formatTelegramUnboundRerouteCallbackData(
        rerouteId,
        record.target.threadId,
      ),
    },
  ]);
  return {
    inline_keyboard: canRestoreAnyLiveThread
      ? [
          ...rows,
          [
            {
              text: "🔁 Replace/restore thread…",
              callback_data:
                formatTelegramUnboundRerouteRestoreMenuCallbackData(rerouteId),
            },
          ],
        ]
      : rows,
  };
}

function buildTelegramUnboundRerouteRestoreChooserMarkup(
  rerouteId: string,
  records: readonly Threads.TelegramTopicTargetRecord[],
): Menu.TelegramReplyMarkup {
  return {
    inline_keyboard: records
      .filter((record) => record.status === "active")
      .map((record) => [
        {
          text: getTelegramReplaceThreadButtonLabel(record),
          callback_data: formatTelegramUnboundRerouteNewSlotCallbackData(
            rerouteId,
            record.target.threadId,
          ),
        },
      ]),
  };
}

function formatTelegramUnboundRerouteRestoreChooserText(): string {
  return [
    "<b>🧵 Replace/restore Telegram thread</b>",
    "",
    "Choose the Pi instance to move to this new Telegram thread:",
  ].join("\n");
}

function formatTelegramUnboundTopicGuidance(): string {
  return [
    "⚠️ <b>New thread is not a Pi instance</b>",
    "",
    "To create a bound Telegram tab:",
    "<code>1.</code> Start another Pi instance in your terminal.",
    "<code>2.</code> Run <code>/telegram-connect</code> in that instance.",
    "<code>3.</code> The bridge will create and bind a fresh Telegram tab for it.",
  ].join("\n");
}

function formatTelegramTargetKey(target: Queue.TelegramQueueTarget): string {
  return `${target.chatId}:${target.threadId ?? "all"}`;
}

function formatTelegramUnboundRerouteChooserText(
  _records: readonly Threads.TelegramTopicTargetRecord[],
  options: { includeGuidance?: boolean } = {},
): string {
  const rerouteText = [
    "🧵 <b>Choose target thread</b>",
    "",
    "Your message is still in this Telegram thread.",
    "Select the Pi thread that should handle it:",
  ].join("\n");
  return options.includeGuidance === false
    ? rerouteText
    : [formatTelegramUnboundTopicGuidance(), "", rerouteText].join("\n");
}

import { getTelegramVoiceReplyMode } from "./voice.ts";
import type { TelegramUser } from "./updates.ts";
import * as Threads from "./threads.ts";
import * as Updates from "./updates.ts";

async function deleteReservedTelegramTopicThroughReconciler(
  deps: {
    callApi?: <TResponse>(
      method: string,
      body: Record<string, unknown>,
    ) => Promise<TResponse>;
    threadStore?: Pick<
      Threads.TelegramTopicTargetStore,
      | "list"
      | "listReservations"
      | "listSyncObservations"
      | "markStaleByTarget"
      | "persist"
    >;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () =>
      ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (
      plan: ThreadReconciler.ThreadReconciliationPlan,
    ) => void;
    recordRuntimeEvent?: (
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) => void;
  },
  target: { chatId: number; threadId: number },
  messageId: number,
): Promise<boolean> {
  if (!deps.threadStore) return false;
  const nowMs = Date.now();
  const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
  const plan = ThreadReconciler.planThreadReconciliation({
    nowMs,
    currentLeaderEpoch,
    previousState: deps.getThreadReconciliationMachineState?.(),
    records: deps.threadStore.list(),
    reservations: deps.threadStore.listReservations(),
    observations: deps.threadStore.listSyncObservations(),
    reservedMessages: [
      {
        target,
        observedAtMs: nowMs,
        messageId,
        ...(currentLeaderEpoch !== undefined
          ? { leaderEpoch: currentLeaderEpoch }
          : {}),
      },
    ],
  });
  deps.recordThreadReconciliationPlan?.(plan);
  await ThreadReconciler.applyThreadReconciliationPlan(plan, {
    callApi: deps.callApi,
    markStaleByTarget: (staleTarget, syncStatus, lastSyncError) =>
      deps.threadStore?.markStaleByTarget(
        staleTarget,
        syncStatus,
        lastSyncError,
      ) ?? false,
    persist: () => deps.threadStore?.persist() ?? Promise.resolve(),
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  return plan.actions.some(
    (action) => action.kind === "close-delete-reserved-topic",
  );
}

export type TelegramRoutedMessage = Updates.TelegramUpdateMessage &
  Media.TelegramMediaMessage &
  Media.TelegramMediaGroupMessage &
  Commands.TelegramCommandRuntimeMessage &
  Turns.TelegramTurnMessage;

export type TelegramRoutedCallbackQuery = Updates.TelegramCallbackQuery &
  Menu.MenuCallbackQuery;

export interface TelegramInboundBusProjectionRuntime {
  getTargetOwnership: Updates.TelegramTargetOwnershipLookup;
  getLiveThreadTargets(): Queue.TelegramQueueTarget[];
  getLocalThreadLabelForTarget(
    target: Queue.TelegramQueueTarget,
  ): string | undefined;
}

export function createTelegramInboundBusProjectionRuntime(deps: {
  instanceId: string;
  listFollowers(): readonly Bus.TelegramBusFollowerView[];
  listThreadRecords(): readonly TelegramTopicTargetRecord[];
  getLeaderTarget(): Queue.TelegramQueueTarget | undefined;
  isFollowerRegistered(): boolean;
  getFollowerTarget(): Queue.TelegramQueueTarget | undefined;
  getCurrentIdentity(
    target?: Queue.TelegramQueueTarget,
  ): TelegramInstanceThreadIdentityCandidate;
}): TelegramInboundBusProjectionRuntime {
  return {
    getTargetOwnership(target) {
      return Bus.getTelegramFollowerTargetOwnership({
        target,
        followers: deps.listFollowers(),
        activeThreadRecords: deps.listThreadRecords(),
        currentInstanceId: deps.instanceId,
      });
    },
    getLiveThreadTargets() {
      return Bus.listTelegramBusLiveThreadTargets({
        leaderTarget: deps.getLeaderTarget(),
        followers: deps.listFollowers(),
      });
    },
    getLocalThreadLabelForTarget(target) {
      const followerTarget = deps.getFollowerTarget();
      const leaderTarget = deps.getLeaderTarget();
      const isLocalFollowerTarget =
        deps.isFollowerRegistered() &&
        followerTarget?.chatId === target.chatId &&
        followerTarget.threadId === target.threadId;
      const isLocalLeaderTarget =
        leaderTarget?.chatId === target.chatId &&
        leaderTarget.threadId === target.threadId;
      if (!isLocalFollowerTarget && !isLocalLeaderTarget) return undefined;
      return deps.getCurrentIdentity(target).threadName;
    },
  };
}

export interface TelegramInboundRouteRuntimeDeps<
  TMessage extends TelegramRoutedMessage,
  TCallbackQuery extends TelegramRoutedCallbackQuery,
  TContext,
  TModel extends Model.MenuModel,
> {
  configStore: Pick<
    TelegramConfigStore,
    "get" | "getAllowedUserId" | "setAllowedUserId" | "persist"
  > & { set?: TelegramConfigStore["set"] };
  callApi?: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  getCurrentInstanceId?: () => string | undefined;
  getMessageOwnership?: Updates.TelegramMessageOwnershipLookup;
  getTargetOwnership?: Updates.TelegramTargetOwnershipLookup;
  recordMessageOwnership?: Updates.TelegramMessageOwnershipRecorder;
  getLiveThreadTargets?: () => Queue.TelegramQueueTarget[];
  getLocalThreadLabelForTarget?: (
    target: Queue.TelegramQueueTarget,
  ) => string | undefined;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  handleTelegramTopicLifecycleUpdate?: (
    lifecycle: Updates.TelegramTopicLifecycleUpdate<TMessage>,
    ctx: TContext,
  ) => Promise<void> | void;
  handleTelegramThreadTargetObserved?: (
    target: Threads.TelegramTopicTargetRecord["target"],
    ctx: TContext,
  ) => Promise<void> | void;
  foreignOwnedUpdateForwarder?: Updates.TelegramForeignOwnedUpdateForwarder<
    TContext,
    Updates.TelegramMessageReactionUpdated,
    TCallbackQuery,
    TMessage
  >;
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
  modelSwitchController: Model.TelegramModelSwitchController<
    TContext,
    Model.ScopedTelegramModel<TModel>
  >;
  menuActions: Menu.TelegramMenuActionRuntime<TContext, TModel>;
  updateSettingsMenuMessage?: (
    state: Menu.TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  openQueueMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  openSettingsMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  settingsMenuCallbackHandler?: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  queueMenuCallbackHandler: (
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<boolean>;
  buttonActionStore?: OutboundHandlers.TelegramButtonActionStore;
  inboundHandlerRuntime: TelegramInboundHandlerRuntime<TContext>;
  threadStore?: Threads.TelegramTopicTargetStore;
  updateStatus: (ctx: TContext, error?: string) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  requestDeferredDispatchNextQueuedTelegramTurn?: (
    dispatch: (ctx: TContext) => void,
  ) => void;
  hasDeferredDispatchContext?: () => boolean;
  startTypingLoop?: (
    ctx: TContext,
    chatId?: number,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => void;
  stopTypingLoop?: () => void;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: Menu.TelegramReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: Menu.TelegramReplyMarkup,
    options?: { target?: Queue.TelegramQueueTarget; replyToMessageId?: number },
  ) => Promise<number | undefined>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
  answerGuestQuery: (guestQueryId: string, text?: string) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: { parseMode?: "HTML"; target?: Queue.TelegramQueueTarget },
  ) => Promise<number | undefined>;
  setMyCommands: Commands.TelegramBotCommandRegistrationDeps["setMyCommands"];
  getCommands: () => Parameters<
    typeof PromptTemplates.getTelegramPromptTemplateCommands
  >[0];
  downloadFile: Media.DownloadTelegramMessageFilesDeps["downloadFile"];
  resolveTimeLine?: (chatId: number) => string | null;
  getThinkingLevel: () => Model.ThinkingLevel;
  setThinkingLevel: (level: Model.ThinkingLevel) => void;
  persistScopedModelPatterns?: (
    patterns: string[],
    ctx: TContext,
  ) => Promise<void>;
  setModel: (model: TModel) => Promise<boolean>;
  sendUserMessage?: (
    message: string,
    options?: Queue.TelegramPromptDeliveryOptions,
  ) => void;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  sectionRegistry?: TelegramSectionRegistry;
}

const TELEGRAM_OWNED_CALLBACK_PREFIXES = [
  TELEGRAM_ALL_TAB_MENU_CALLBACK_PREFIX,
  TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX,
  "compact:",
  "menu:",
  "model:",
  "queue:",
  "section:",
  "settings:",
  "status:",
  "tgbtn:",
  "thinking:",
] as const;

function isTelegramOwnedCallbackData(data: string): boolean {
  return TELEGRAM_OWNED_CALLBACK_PREFIXES.some((prefix) =>
    data.startsWith(prefix),
  );
}

export function createTelegramInboundRouteRuntime<
  TUpdate extends Updates.TelegramUpdateFlow & {
    message?: TMessage;
    edited_message?: TMessage;
    callback_query?: TCallbackQuery;
  },
  TMessage extends TelegramRoutedMessage,
  TCallbackQuery extends TelegramRoutedCallbackQuery,
  TContext,
  TModel extends Model.MenuModel,
>(
  deps: TelegramInboundRouteRuntimeDeps<
    TMessage,
    TCallbackQuery,
    TContext,
    TModel
  >,
): Updates.TelegramUpdateRuntimeController<TContext, TUpdate> {
  const pendingUnboundReroutes = new Map<
    string,
    { messages: TMessage[]; createdAtMs: number }
  >();
  const pendingAllTabCommands = new Map<string, TelegramAllTabPendingCommand>();
  const guidedUnboundTopicKeys = new Set<string>();
  let nextUnboundRerouteId = 0;
  let nextAllTabCommandId = 0;
  const requestDispatchNextQueuedTelegramTurn = (ctx: TContext): void => {
    deps.dispatchNextQueuedTelegramTurn(ctx);
    if (
      deps.requestDeferredDispatchNextQueuedTelegramTurn &&
      deps.hasDeferredDispatchContext?.() !== false
    ) {
      deps.requestDeferredDispatchNextQueuedTelegramTurn(
        deps.dispatchNextQueuedTelegramTurn,
      );
    }
  };
  const prunePendingUnboundReroutes = () => {
    const nowMs = Date.now();
    for (const [id, entry] of pendingUnboundReroutes) {
      if (nowMs - entry.createdAtMs > 30 * 60_000) {
        pendingUnboundReroutes.delete(id);
      }
    }
    while (pendingUnboundReroutes.size > 100) {
      const oldest = pendingUnboundReroutes.keys().next().value;
      if (!oldest) break;
      pendingUnboundReroutes.delete(oldest);
    }
  };
  const storePendingUnboundReroute = (messages: TMessage[]): string => {
    prunePendingUnboundReroutes();
    nextUnboundRerouteId += 1;
    const id = nextUnboundRerouteId.toString(36);
    pendingUnboundReroutes.set(id, { messages, createdAtMs: Date.now() });
    return id;
  };
  const pendingUnboundRerouteMediaGroups = new Map<
    string,
    {
      messages: TMessage[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const prunePendingAllTabCommands = () => {
    const nowMs = Date.now();
    for (const [id, entry] of pendingAllTabCommands) {
      if (nowMs - entry.createdAtMs > 30 * 60_000) {
        pendingAllTabCommands.delete(id);
      }
    }
    while (pendingAllTabCommands.size > 100) {
      const oldest = pendingAllTabCommands.keys().next().value;
      if (!oldest) break;
      pendingAllTabCommands.delete(oldest);
    }
  };
  const storePendingAllTabCommand = (
    command: Commands.ParsedTelegramCommand,
    text: string,
  ): string => {
    prunePendingAllTabCommands();
    const bareCommandText = `/${command.name}`;
    const id = text.trim() === bareCommandText ? command.name : undefined;
    if (id) {
      pendingAllTabCommands.set(id, { command, text, createdAtMs: Date.now() });
      return id;
    }
    nextAllTabCommandId += 1;
    const generatedId = nextAllTabCommandId.toString(36);
    pendingAllTabCommands.set(generatedId, {
      command,
      text,
      createdAtMs: Date.now(),
    });
    return generatedId;
  };
  const menuCallbackHandler = Menu.createTelegramMenuCallbackHandlerForContext<
    TCallbackQuery,
    TContext,
    TModel
  >({
    getStoredModelMenuState: deps.modelMenuRuntime.getState,
    getActiveModel: deps.currentModelRuntime.get,
    getThinkingLevel: deps.getThinkingLevel,
    setThinkingLevel: deps.setThinkingLevel,
    updateStatus: deps.updateStatus,
    updateModelMenuMessage: deps.menuActions.updateModelMenuMessage,
    updateThinkingMenuMessage: deps.menuActions.updateThinkingMenuMessage,
    updateStatusMessage: deps.menuActions.updateStatusMessage,
    updateSettingsMenuMessage: deps.updateSettingsMenuMessage,
    answerCallbackQuery: deps.answerCallbackQuery,
    isIdle: deps.isIdle,
    hasActiveTelegramTurn: deps.activeTurnRuntime.has,
    hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
    getActiveToolExecutions:
      deps.bridgeRuntime.lifecycle.getActiveToolExecutions,
    persistScopedModelPatterns: deps.persistScopedModelPatterns,
    setModel: deps.setModel,
    setCurrentModel: deps.currentModelRuntime.setCurrentModel,
    stagePendingModelSwitch: deps.modelSwitchController.stagePendingSwitch,
    restartInterruptedTelegramTurn:
      deps.modelSwitchController.restartInterruptedTurn,
    sectionRegistry: deps.sectionRegistry,
    editInteractiveMessage: deps.editInteractiveMessage,
    sendInteractiveMessage: deps.sendInteractiveMessage,
    deleteMessage: deps.deleteMessage,
    enqueueSectionPrompt: async (
      prompt: string,
      ctx: TContext,
      target?: Queue.TelegramQueueTarget,
    ) => {
      const chatId = target?.chatId ?? deps.configStore.getAllowedUserId();
      if (typeof chatId !== "number") return;
      const order = deps.bridgeRuntime.queue.allocateItemOrder();
      const turn: Queue.PendingTelegramTurn = {
        kind: "prompt",
        chatId,
        ...(target ? { target } : {}),
        replyToMessageId: 0,
        sourceMessageIds: [],
        queueOrder: order,
        queueLane: "default",
        laneOrder: order,
        queuedAttachments: [],
        content: [
          {
            type: "text",
            text: `[telegram] ${prompt}`,
          },
        ],
        historyText: Turns.truncateTelegramQueueSummary(prompt),
        statusSummary: Turns.truncateTelegramQueueSummary(prompt),
      };
      deps.queueMutationRuntime.append(turn, ctx);
      deps.updateStatus(ctx);
      requestDispatchNextQueuedTelegramTurn(ctx);
    },
  });
  const cloneTelegramMessagesForThread = (
    messages: TMessage[],
    threadId: number,
  ): TMessage[] => {
    return messages.map(
      (message) =>
        ({
          ...message,
          message_id: 0,
          message_thread_id: threadId,
          reply_to_message: undefined,
        }) as TMessage,
    );
  };
  const applyThreadCleanupPlan = async (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ): Promise<void> => {
    deps.recordThreadReconciliationPlan?.(plan);
    await ThreadReconciler.applyThreadReconciliationPlan(plan, {
      callApi: deps.callApi,
      markStaleByTarget: (staleTarget, syncStatus, lastSyncError) =>
        deps.threadStore?.markStaleByTarget(
          staleTarget,
          syncStatus,
          lastSyncError,
        ) ?? false,
      persist: () => deps.threadStore?.persist() ?? Promise.resolve(),
      removePendingProvisionById: (id) =>
        deps.threadStore?.removePendingProvision(id) ?? false,
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
  };
  const dismissRerouteChooserMessage = async (
    query: TCallbackQuery,
  ): Promise<void> => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (
      typeof chatId !== "number" ||
      typeof messageId !== "number" ||
      !deps.deleteMessage
    ) {
      return;
    }
    try {
      await deps.deleteMessage(chatId, messageId);
    } catch (error) {
      deps.recordRuntimeEvent?.("telegram", error, {
        phase: "reroute-chooser-delete",
        chatId,
        messageId,
        threadId: query.message?.message_thread_id,
      });
    }
  };
  const closeReroutedUnboundTopic = async (
    target: { chatId: number; threadId: number } | undefined,
    messageId: number | undefined,
  ): Promise<void> => {
    if (!target || !deps.threadStore) return;
    const nowMs = Date.now();
    const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
    const plan = ThreadReconciler.planThreadReconciliation({
      nowMs,
      currentLeaderEpoch,
      previousState: deps.getThreadReconciliationMachineState?.(),
      records: deps.threadStore.list(),
      reservations: deps.threadStore.listReservations(),
      pendingProvisions: deps.threadStore.listPendingProvisions(),
      unboundMessages: [
        {
          target,
          observedAtMs: nowMs,
          ...(typeof messageId === "number" ? { messageId } : {}),
          ...(currentLeaderEpoch !== undefined
            ? { leaderEpoch: currentLeaderEpoch }
            : {}),
        },
      ],
    });
    await applyThreadCleanupPlan(plan);
  };
  const closePreviousLeaderThread = async (
    target: { chatId: number; threadId: number } | undefined,
  ): Promise<void> => {
    if (!target || !deps.threadStore) return;
    const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
    await applyThreadCleanupPlan({
      actions: [
        {
          kind: "close-delete-previous-leader-topic",
          target,
          reason: "previous-leader",
          instanceId: deps.getCurrentInstanceId?.(),
          ...(currentLeaderEpoch !== undefined
            ? { leaderEpoch: currentLeaderEpoch }
            : {}),
        },
      ],
    });
  };
  const closeReplacedFollowerThread = async (
    target: { chatId: number; threadId: number } | undefined,
    instanceId: string | undefined,
  ): Promise<void> => {
    if (!target || !deps.threadStore) return;
    const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
    await applyThreadCleanupPlan({
      actions: [
        {
          kind: "close-delete-replaced-follower-topic",
          target,
          reason: "replaced-follower",
          instanceId,
          ...(currentLeaderEpoch !== undefined
            ? { leaderEpoch: currentLeaderEpoch }
            : {}),
        },
      ],
    });
  };
  const handleUnboundRerouteRestoreMenuCallback = async (
    query: TCallbackQuery,
    _ctx: TContext,
  ): Promise<boolean> => {
    const parsed = parseTelegramUnboundRerouteRestoreMenuCallbackData(
      query.data,
    );
    if (!parsed) return false;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const pending = pendingUnboundReroutes.get(parsed.rerouteId);
    if (
      typeof chatId !== "number" ||
      typeof messageId !== "number" ||
      !deps.threadStore ||
      !pending
    ) {
      await deps.answerCallbackQuery(query.id, "Message route expired.");
      return true;
    }
    await deps.threadStore.load();
    const activeRecords = getTelegramRoutableThreadRecords(
      deps.threadStore.list(),
      deps.getLiveThreadTargets?.(),
    );
    const replyMarkup = buildTelegramUnboundRerouteRestoreChooserMarkup(
      parsed.rerouteId,
      activeRecords,
    );
    if (deps.editInteractiveMessage) {
      await deps.editInteractiveMessage(
        chatId,
        messageId,
        formatTelegramUnboundRerouteRestoreChooserText(),
        "html",
        replyMarkup,
      );
    } else if (deps.sendInteractiveMessage) {
      await deps.sendInteractiveMessage(
        chatId,
        formatTelegramUnboundRerouteRestoreChooserText(),
        "html",
        replyMarkup,
        typeof query.message?.message_thread_id === "number"
          ? {
              target: { chatId, threadId: query.message.message_thread_id },
              replyToMessageId: messageId,
            }
          : undefined,
      );
    }
    await deps.answerCallbackQuery(query.id, "Choose instance to restore.");
    return true;
  };
  const handleUnboundRerouteCallback = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<boolean> => {
    const parsed = parseTelegramUnboundRerouteCallbackData(query.data);
    if (!parsed) return false;
    const chatId = query.message?.chat?.id;
    const pending = pendingUnboundReroutes.get(parsed.rerouteId);
    if (typeof chatId !== "number" || !deps.threadStore || !pending) {
      await deps.answerCallbackQuery(query.id, "Message route expired.");
      return true;
    }
    await deps.threadStore.load();
    const record = getTelegramRoutableThreadRecords(
      deps.threadStore.list(),
      deps.getLiveThreadTargets?.(),
    ).find(
      (candidate) =>
        candidate.target.chatId === chatId &&
        candidate.target.threadId === parsed.threadId,
    );
    if (!record) {
      await deps.answerCallbackQuery(query.id, "Thread is not active yet.");
      return true;
    }
    const reroutedMessages = cloneTelegramMessagesForThread(
      pending.messages,
      parsed.threadId,
    );
    const sourceTarget =
      typeof query.message?.message_thread_id === "number"
        ? { chatId, threadId: query.message.message_thread_id }
        : undefined;
    const sourceMessageId = query.message?.message_id;
    const currentInstanceId = deps.getCurrentInstanceId?.();
    const leaderProfileKey = getLeaderTopicProfileKey(ctx, currentInstanceId);
    const isCurrentLeaderRecord = isCurrentLeaderTopicRecord(
      record,
      leaderProfileKey,
      currentInstanceId,
    );
    if (parsed.useNewSlot && !isCurrentLeaderRecord) {
      if (
        !sourceTarget ||
        !deps.replaceFollowerThreadTarget ||
        !deps.foreignOwnedUpdateForwarder?.forwardMessage
      ) {
        await deps.answerCallbackQuery(
          query.id,
          "Follower thread restore is not available yet.",
        );
        return true;
      }
      const replaced = await deps.replaceFollowerThreadTarget({
        record,
        target: sourceTarget,
        oldTarget: record.target,
      });
      if (!replaced) {
        await deps.answerCallbackQuery(
          query.id,
          "Follower thread is unavailable.",
        );
        return true;
      }
      const nowMs = Date.now();
      const slot = record.slot ?? "?";
      const threadName = getRestoredThreadName(record, slot);
      deps.threadStore.markStaleByTarget(
        record.target,
        "deleted",
        "Follower thread was replaced by restore source.",
      );
      deps.threadStore.upsert({
        ...record,
        target: sourceTarget,
        status: "active",
        syncStatus: "open",
        updatedAtMs: nowMs,
        threadName,
        lastSyncObservedAtMs: nowMs,
        lastReconcileAction: "follower-thread-restore",
        rerouteConfirmedAtMs: nowMs,
      });
      await deps.threadStore.persist();
      if (deps.callApi) {
        try {
          await deps.callApi("editForumTopic", {
            chat_id: sourceTarget.chatId,
            message_thread_id: sourceTarget.threadId,
            name: Threads.getTelegramTopicTitleForThreadName(threadName, slot),
          });
        } catch (renameError) {
          deps.recordRuntimeEvent?.("telegram", renameError, {
            phase: "follower-topic-reroute-restore-rename",
            chatId: sourceTarget.chatId,
            threadId: sourceTarget.threadId,
            slot: record.slot,
          });
        }
      }
      await closeReplacedFollowerThread(record.target, record.instanceId);
      const forwarded = await Promise.all(
        cloneTelegramMessagesForThread(
          pending.messages,
          sourceTarget.threadId,
        ).map((message) =>
          deps.foreignOwnedUpdateForwarder!.forwardMessage!({
            message,
            ownership: { instanceId: record.instanceId! },
            ctx,
          }),
        ),
      );
      const allForwarded = forwarded.every(Boolean);
      if (allForwarded) {
        pendingUnboundReroutes.delete(parsed.rerouteId);
        await dismissRerouteChooserMessage(query);
      }
      await deps.answerCallbackQuery(
        query.id,
        allForwarded ? "Message routed." : "Target thread is unavailable.",
      );
      return true;
    }
    if (
      record.instanceId &&
      record.instanceId !== currentInstanceId &&
      !isCurrentLeaderRecord
    ) {
      if (!deps.foreignOwnedUpdateForwarder?.forwardMessage) {
        await deps.answerCallbackQuery(
          query.id,
          "Open that thread and resend the message there.",
        );
        return true;
      }
      const forwarded = await Promise.all(
        reroutedMessages.map((message) =>
          deps.foreignOwnedUpdateForwarder!.forwardMessage!({
            message,
            ownership: { instanceId: record.instanceId! },
            ctx,
          }),
        ),
      );
      const allForwarded = forwarded.every(Boolean);
      if (allForwarded) {
        pendingUnboundReroutes.delete(parsed.rerouteId);
        await dismissRerouteChooserMessage(query);
        await closeReroutedUnboundTopic(sourceTarget, sourceMessageId);
      }
      await deps.answerCallbackQuery(
        query.id,
        allForwarded ? "Message routed." : "Target thread is unavailable.",
      );
      return true;
    }
    if (
      sourceTarget &&
      isCurrentLeaderRecord &&
      (parsed.useNewSlot || typeof record.rerouteConfirmedAtMs !== "number") &&
      (record.target.chatId !== sourceTarget.chatId ||
        record.target.threadId !== sourceTarget.threadId)
    ) {
      deps.threadStore.markStaleByTarget(
        record.target,
        "deleted",
        parsed.useNewSlot
          ? "Current leader thread was replaced by a new-slot reroute source."
          : "Current leader thread was replaced by reroute source.",
      );
      const slot = parsed.useNewSlot
        ? (deps.threadStore.allocateSlot(
            leaderProfileKey ?? record.profileKey,
            getNextTelegramSlotPreference(record.slot),
          ) ??
          record.slot ??
          "?")
        : (record.slot ?? "?");
      const nowMs = Date.now();
      const threadName = getRestoredThreadName(record, slot);
      deps.threadStore.upsert({
        ...record,
        target: sourceTarget,
        status: "active",
        updatedAtMs: nowMs,
        threadName,
        instanceId: currentInstanceId,
        slot,
        lastReconcileAction: parsed.useNewSlot
          ? "reroute-new-slot"
          : "reroute-reclaim",
        rerouteConfirmedAtMs: nowMs,
      });
      await deps.threadStore.persist();
      if (deps.callApi) {
        try {
          await deps.callApi("editForumTopic", {
            chat_id: sourceTarget.chatId,
            message_thread_id: sourceTarget.threadId,
            name: Threads.getTelegramTopicTitleForThreadName(threadName, slot),
          });
        } catch (renameError) {
          deps.recordRuntimeEvent?.("telegram", renameError, {
            phase: "leader-topic-reroute-reclaim-rename",
            chatId: sourceTarget.chatId,
            threadId: sourceTarget.threadId,
            slot,
          });
        }
      }
      deps.recordRuntimeEvent?.(
        "bus",
        "Bus leader reclaimed reroute source thread",
        {
          phase: "leader-topic-reroute-reclaim",
          chatId: sourceTarget.chatId,
          threadId: sourceTarget.threadId,
          staleThreadId: record.target.threadId,
          slot,
        },
      );
      if (parsed.useNewSlot) {
        await closePreviousLeaderThread(record.target);
      }
      await promptEnqueue(
        cloneTelegramMessagesForThread(pending.messages, sourceTarget.threadId),
        ctx,
      );
      pendingUnboundReroutes.delete(parsed.rerouteId);
      await dismissRerouteChooserMessage(query);
      await deps.answerCallbackQuery(query.id, "Message routed.");
      return true;
    }
    await promptEnqueue(reroutedMessages, ctx);
    pendingUnboundReroutes.delete(parsed.rerouteId);
    await dismissRerouteChooserMessage(query);
    await closeReroutedUnboundTopic(sourceTarget, sourceMessageId);
    await deps.answerCallbackQuery(query.id, "Message routed.");
    return true;
  };
  let dispatchAllTabCommandToTarget:
    | ((
        commandText: string,
        query: TCallbackQuery,
        threadId: number,
        ctx: TContext,
      ) => Promise<void>)
    | undefined;
  const handleAllTabMenuCallback = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<boolean> => {
    const parsed = parseTelegramAllTabMenuCallbackData(query.data);
    if (!parsed) return false;
    const chatId = query.message?.chat?.id;
    const pending = pendingAllTabCommands.get(parsed.commandId);
    if (typeof chatId !== "number" || !deps.threadStore || !pending) {
      await deps.answerCallbackQuery(query.id, "Thread menu expired.");
      return true;
    }
    await deps.threadStore.load();
    const record = getTelegramRoutableThreadRecords(
      deps.threadStore.list(),
      deps.getLiveThreadTargets?.(),
    ).find(
      (candidate) =>
        candidate.target.chatId === chatId &&
        candidate.target.threadId === parsed.threadId,
    );
    if (!record) {
      await deps.answerCallbackQuery(query.id, "Thread is not active yet.");
      return true;
    }
    const currentInstanceId = deps.getCurrentInstanceId?.();
    const leaderProfileKey = getLeaderTopicProfileKey(ctx, currentInstanceId);
    const isCurrentLeaderRecord = isCurrentLeaderTopicRecord(
      record,
      leaderProfileKey,
      currentInstanceId,
    );
    if (
      record.instanceId &&
      record.instanceId !== currentInstanceId &&
      !isCurrentLeaderRecord
    ) {
      if (!deps.foreignOwnedUpdateForwarder?.forwardMessage) {
        await deps.answerCallbackQuery(
          query.id,
          "Open that thread and run /start there.",
        );
        return true;
      }
      const forwarded = await deps.foreignOwnedUpdateForwarder.forwardMessage({
        message: {
          ...(query.message ?? {}),
          message_id: query.message?.message_id ?? 0,
          chat: { id: chatId, type: "private" },
          from: query.from,
          message_thread_id: parsed.threadId,
          text: pending.text,
        } as TMessage,
        ownership: { instanceId: record.instanceId },
        ctx,
      });
      if (forwarded) pendingAllTabCommands.delete(parsed.commandId);
      await deps.answerCallbackQuery(
        query.id,
        forwarded
          ? "Opening in target thread."
          : "Target thread is unavailable.",
      );
      return true;
    }
    if (!dispatchAllTabCommandToTarget) {
      await deps.answerCallbackQuery(query.id, "Thread menu expired.");
      return true;
    }
    await dispatchAllTabCommandToTarget(
      pending.text,
      query,
      parsed.threadId,
      ctx,
    );
    pendingAllTabCommands.delete(parsed.commandId);
    await deps.answerCallbackQuery(query.id, "Opening in target thread.");
    return true;
  };
  const callbackHandler = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<void> => {
    if (await handleUnboundRerouteRestoreMenuCallback(query, ctx)) return;
    if (await handleUnboundRerouteCallback(query, ctx)) return;
    if (await handleAllTabMenuCallback(query, ctx)) return;
    if (deps.buttonActionStore) {
      const handled = await OutboundHandlers.handleTelegramButtonCallbackQuery(
        query,
        ctx,
        {
          resolveAction: deps.buttonActionStore.resolve,
          answerCallbackQuery: deps.answerCallbackQuery,
          enqueueButtonPrompt: (buttonQuery, action, context) => {
            const chatId = buttonQuery.message?.chat?.id;
            const messageId = buttonQuery.message?.message_id;
            if (typeof chatId !== "number" || typeof messageId !== "number")
              return;
            const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
            const turn = OutboundHandlers.createTelegramButtonPromptTurn({
              chatId,
              target:
                typeof buttonQuery.message?.message_thread_id === "number"
                  ? {
                      chatId,
                      threadId: buttonQuery.message.message_thread_id,
                    }
                  : { chatId },
              replyToMessageId: messageId,
              queueOrder,
              action,
            });
            const result = Queue.appendTelegramPromptTurnOnce(
              deps.telegramQueueStore.getQueuedItems(),
              turn,
            );
            if (!result.appended) return;
            deps.telegramQueueStore.setQueuedItems(result.items);
            deps.updateStatus(context);
            requestDispatchNextQueuedTelegramTurn(context);
          },
        },
      );
      if (handled) return;
    }
    const handledByCompact =
      await Commands.handleTelegramCompactConfirmationCallback(query, {
        ctx,
        answerCallbackQuery: deps.answerCallbackQuery,
        editInteractiveMessage: deps.editInteractiveMessage ?? (async () => {}),
        runCompact: async (compactCtx, chatId, replyToMessageId, target) => {
          await Commands.handleTelegramCompactCommand({
            isIdle: () => deps.isIdle(compactCtx),
            hasPendingMessages: () => deps.hasPendingMessages(compactCtx),
            hasActiveTelegramTurn: deps.activeTurnRuntime.has,
            hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
            hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
            isCompactionInProgress:
              deps.bridgeRuntime.lifecycle.isCompactionInProgress,
            setCompactionInProgress:
              deps.bridgeRuntime.lifecycle.setCompactionInProgress,
            updateStatus: () => deps.updateStatus(compactCtx),
            dispatchNextQueuedTelegramTurn: () =>
              deps.dispatchNextQueuedTelegramTurn(compactCtx),
            requestDeferredDispatchNextQueuedTelegramTurn:
              deps.requestDeferredDispatchNextQueuedTelegramTurn
                ? (dispatch) =>
                    deps.requestDeferredDispatchNextQueuedTelegramTurn?.(() =>
                      dispatch(),
                    )
                : undefined,
            compact: (callbacks) => deps.compact(compactCtx, callbacks),
            startTypingLoop: deps.startTypingLoop
              ? () =>
                  deps.startTypingLoop?.(compactCtx, chatId, {
                    target,
                  })
              : undefined,
            stopTypingLoop: deps.stopTypingLoop,
            sendTextReply: (text) =>
              deps
                .sendTextReply(chatId, replyToMessageId, text, { target })
                .then(() => {}),
            suppressStartNotice: true,
            recordRuntimeEvent: deps.recordRuntimeEvent,
          });
        },
      });
    if (handledByCompact) return;
    const handledByQueue = await deps.queueMenuCallbackHandler(query, ctx);
    if (handledByQueue) return;
    const handledBySettings = await deps.settingsMenuCallbackHandler?.(
      query,
      ctx,
    );
    if (handledBySettings) return;
    const callbackData = query.data;
    if (callbackData && !isTelegramOwnedCallbackData(callbackData)) {
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (typeof chatId === "number" && typeof messageId === "number") {
        const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
        const target =
          typeof query.message?.message_thread_id === "number"
            ? { chatId, threadId: query.message.message_thread_id }
            : { chatId };
        const turn: Queue.PendingTelegramTurn = {
          kind: "prompt",
          chatId,
          target,
          replyToMessageId: messageId,
          sourceMessageIds: [messageId],
          queueOrder,
          queueLane: "priority",
          laneOrder: queueOrder,
          queuedAttachments: [],
          content: [{ type: "text", text: `[callback] ${callbackData}` }],
          historyText: callbackData,
          statusSummary: callbackData,
        };
        const result = Queue.appendTelegramPromptTurnOnce(
          deps.telegramQueueStore.getQueuedItems(),
          turn,
        );
        if (result.appended) {
          deps.telegramQueueStore.setQueuedItems(result.items);
          deps.updateStatus(ctx);
          requestDispatchNextQueuedTelegramTurn(ctx);
        }
      }
      await deps.answerCallbackQuery(query.id);
      return;
    }
    await menuCallbackHandler(query, ctx);
  };
  const promptTurnBuilder = Turns.createTelegramPromptTurnRuntimeBuilder<
    TMessage,
    TContext
  >({
    allocateQueueOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    downloadFile: deps.downloadFile,
    processAttachments: deps.inboundHandlerRuntime.process,
    resolveTimeLine: deps.resolveTimeLine,
    getAllowedUserId: deps.configStore.getAllowedUserId,

    // Voice policy for the current turn. Missing config still behaves as manual,
    // but only explicit telegram.json voice.replyMode is shown in prompt context.
    getVoiceReplyMode: () => getTelegramVoiceReplyMode(deps.configStore.get()),
    isVoiceReplyModeConfigured: () => {
      const mode = deps.configStore.get().voice?.replyMode;
      return mode === "manual" || mode === "mirror" || mode === "always";
    },
    getTelegramThreadLabel(message) {
      if (!deps.threadStore) return undefined;
      const chatId = message.chat.id;
      const threadId = message.message_thread_id;
      if (!threadId) return undefined;
      const localLabel = deps.getLocalThreadLabelForTarget?.({
        chatId,
        threadId,
      });
      if (localLabel) return localLabel;
      const records = deps.threadStore.list();
      const currentInstanceId = deps.getCurrentInstanceId?.();
      for (const r of records) {
        if (r.target.chatId !== chatId || r.target.threadId !== threadId)
          continue;
        if (
          currentInstanceId &&
          r.instanceId &&
          r.instanceId !== currentInstanceId
        )
          continue;
        return r.threadName &&
          Threads.isTelegramTopicThreadNameValidForSlot(r.threadName, r.slot)
          ? r.threadName
          : getRestoredThreadName(r, r.slot ?? "");
      }
      return undefined;
    },
  });
  const enqueueContinueTurn = async (
    message: TMessage,
    ctx: TContext,
  ): Promise<void> => {
    deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory(false);
    const continueMessage = {
      ...message,
      text: "continue",
      caption: undefined,
    } as TMessage;
    const turn = await promptTurnBuilder([continueMessage], [], ctx);
    const continueTurn = {
      ...turn,
      queueLane: "control" as const,
      laneOrder: deps.bridgeRuntime.queue.allocateControlOrder(),
      statusSummary: "continue",
    };
    deps.queueMutationRuntime.append(continueTurn, ctx);
    requestDispatchNextQueuedTelegramTurn(ctx);
  };
  const reservedCommandNames = () =>
    new Set(Commands.getTelegramReservedCommandNames());
  const getPromptTemplateCommands = () =>
    PromptTemplates.getTelegramPromptTemplateCommands(
      deps.getCommands(),
      reservedCommandNames(),
    );
  const commandHandler = Commands.createTelegramCommandHandlerTargetRuntime<
    TMessage,
    TContext
  >({
    hasAbortHandler: deps.bridgeRuntime.abort.hasHandler,
    clearPendingModelSwitch: deps.modelSwitchController.clearPendingSwitch,
    hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
    clearQueuedTelegramItems: deps.queueMutationRuntime.clear,
    setFoldQueuedPromptsIntoHistory:
      deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
    abortCurrentTurn: deps.bridgeRuntime.abort.abortTurn,
    isIdle: deps.isIdle,
    hasPendingMessages: deps.hasPendingMessages,
    hasActiveTelegramTurn: deps.activeTurnRuntime.has,
    hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
    isCompactionInProgress: deps.bridgeRuntime.lifecycle.isCompactionInProgress,
    setCompactionInProgress:
      deps.bridgeRuntime.lifecycle.setCompactionInProgress,
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deps.requestDeferredDispatchNextQueuedTelegramTurn,
    startTypingLoop: deps.startTypingLoop,
    stopTypingLoop: deps.stopTypingLoop,
    enqueueContinueTurn,
    compact: deps.compact,
    allocateItemOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    allocateControlOrder: deps.bridgeRuntime.queue.allocateControlOrder,
    appendControlItem: deps.queueMutationRuntime.append,
    showStatus: deps.menuActions.sendStatusMessage,
    openModelMenu: deps.menuActions.openModelMenu,
    openThinkingMenu: (message, ctx) => {
      const chatId = (message as { chat: { id: number } }).chat.id;
      return deps.menuActions.openThinkingMenu(chatId, message.message_id, ctx);
    },
    openQueueMenu: (message, ctx) => {
      const chatId = (message as { chat: { id: number } }).chat.id;
      return deps.openQueueMenu(chatId, message.message_id, ctx);
    },
    openSettingsMenu: deps.openSettingsMenu,
    getAllowedUserId: deps.configStore.getAllowedUserId,
    setAllowedUserId: deps.configStore.setAllowedUserId,
    setMyCommands: deps.setMyCommands,
    getPromptTemplateCommands,
    persistConfig: deps.configStore.persist,
    sendTextReply: deps.sendTextReply,
    sendInteractiveMessage: deps.sendInteractiveMessage,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const promptEnqueue = Queue.createTelegramPromptEnqueueController<
    TMessage,
    TContext
  >({
    ...deps.telegramQueueStore,
    getFoldQueuedPromptsIntoHistory:
      deps.bridgeRuntime.lifecycle.shouldFoldQueuedPromptsIntoHistory,
    setFoldQueuedPromptsIntoHistory:
      deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
    createTurn: async (messages, historyTurns, turnCtx) => {
      const turn = await promptTurnBuilder(messages, historyTurns, turnCtx);
      return turn.replyToMessageId > 0
        ? turn
        : { ...turn, replyToMessageId: 0 };
    },
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: requestDispatchNextQueuedTelegramTurn,
  }).enqueue;
  const sendUnboundRerouteChooserNow = async (
    messages: TMessage[],
    ctx: TContext,
  ): Promise<void> => {
    const message = messages[0];
    if (!message || !deps.threadStore) return;
    const records = deps.threadStore.list();
    const activeRecords = getTelegramRoutableThreadRecords(
      records,
      deps.getLiveThreadTargets?.(),
    );
    const sourceTarget =
      typeof message.message_thread_id === "number"
        ? { chatId: message.chat.id, threadId: message.message_thread_id }
        : undefined;
    const sourceKey = sourceTarget
      ? formatTelegramTargetKey(sourceTarget)
      : undefined;
    const includeGuidance = sourceKey
      ? !guidedUnboundTopicKeys.has(sourceKey)
      : true;
    if (sourceKey) guidedUnboundTopicKeys.add(sourceKey);
    if (activeRecords.length === 0) {
      await deps.sendTextReply(
        message.chat.id,
        message.message_id,
        [
          includeGuidance ? formatTelegramUnboundTopicGuidance() : undefined,
          "This thread is not bound to a Pi instance. Open an active Pi thread or run /telegram-connect from a Pi session to bind one.",
        ]
          .filter((line): line is string => typeof line === "string")
          .join("\n\n"),
        { parseMode: "HTML", target: sourceTarget },
      );
      return;
    }
    const rerouteId = storePendingUnboundReroute(messages);
    const text = formatTelegramUnboundRerouteChooserText(activeRecords, {
      includeGuidance,
    });
    const currentInstanceId = deps.getCurrentInstanceId?.();
    const replyMarkup = buildTelegramUnboundRerouteChooserMarkup(
      rerouteId,
      activeRecords,
      {
        currentLeaderProfileKey: getLeaderTopicProfileKey(
          ctx,
          currentInstanceId,
        ),
        currentInstanceId,
      },
    );
    if (deps.sendInteractiveMessage) {
      await deps.sendInteractiveMessage(
        message.chat.id,
        text,
        "html",
        replyMarkup,
        sourceTarget
          ? { target: sourceTarget, replyToMessageId: message.message_id }
          : { replyToMessageId: message.message_id },
      );
      return;
    }
    await deps.sendTextReply(message.chat.id, message.message_id, text, {
      parseMode: "HTML",
      target: sourceTarget,
    });
  };
  const sendUnboundRerouteChooser = async (
    message: TMessage,
    ctx: TContext,
  ): Promise<void> => {
    const groupKey = Media.getTelegramMediaGroupKey(message);
    if (!groupKey) {
      await sendUnboundRerouteChooserNow([message], ctx);
      return;
    }
    const existing = pendingUnboundRerouteMediaGroups.get(groupKey);
    if (existing) clearTimeout(existing.timer);
    const messages = [...(existing?.messages ?? []), message];
    const timer = setTimeout(() => {
      pendingUnboundRerouteMediaGroups.delete(groupKey);
      void sendUnboundRerouteChooserNow(messages, ctx);
    }, 1200);
    timer.unref?.();
    pendingUnboundRerouteMediaGroups.set(groupKey, { messages, timer });
  };
  const getKnownTelegramAllTabCommand = (
    text: string,
  ): Commands.ParsedTelegramCommand | undefined => {
    const command = Commands.parseTelegramCommand(text);
    if (!command) return undefined;
    if (reservedCommandNames().has(command.name)) return command;
    if (Commands.findTelegramExtensionCommand(command.name)) return command;
    if (
      getPromptTemplateCommands().some(
        (template) => template.command === command.name,
      )
    ) {
      return command;
    }
    return undefined;
  };
  const sendAllTabCommandChooser = async (
    command: Commands.ParsedTelegramCommand,
    commandText: string,
    message: TMessage,
    options: {
      replyToSource?: boolean;
      target?: Queue.TelegramQueueTarget;
    } = {},
  ): Promise<boolean> => {
    if (!deps.threadStore) return false;
    const records = deps.threadStore.list();
    const activeRecords = getTelegramRoutableThreadRecords(
      records,
      deps.getLiveThreadTargets?.(),
    );
    if (activeRecords.length === 0) return false;
    const commandId = storePendingAllTabCommand(command, commandText);
    const text = formatTelegramAllTabMenuChooserText(command.name);
    const replyMarkup = buildTelegramAllTabMenuChooserMarkup(
      commandId,
      activeRecords,
    );
    if (deps.sendInteractiveMessage) {
      await deps.sendInteractiveMessage(
        message.chat.id,
        text,
        "html",
        replyMarkup,
        options.target || options.replyToSource
          ? {
              ...(options.target ? { target: options.target } : {}),
              ...(options.replyToSource
                ? { replyToMessageId: message.message_id }
                : {}),
            }
          : undefined,
      );
      return true;
    }
    if (deps.callApi) {
      await deps.callApi("sendMessage", {
        chat_id: message.chat.id,
        text,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
        ...(typeof options.target?.threadId === "number"
          ? { message_thread_id: options.target.threadId }
          : {}),
        ...(options.replyToSource
          ? {
              reply_parameters: {
                message_id: message.message_id,
                allow_sending_without_reply: true,
              },
            }
          : {}),
      });
      return true;
    }
    await deps.sendTextReply(message.chat.id, message.message_id, text, {
      parseMode: "HTML",
      target: options.target,
    });
    return true;
  };
  const commandOrPrompt = Commands.createTelegramCommandOrPromptRuntime<
    TMessage,
    TContext
  >({
    extractRawText: Media.extractFirstTelegramMessageText,
    shouldIgnoreMessages: (messages) =>
      !Media.hasTelegramMessagesPromptContent(messages),
    handleCommand: commandHandler,
    executeExtensionCommand: async (command, message, ctx) => {
      const extensionCommand = Commands.findTelegramExtensionCommand(
        command.name,
      );
      if (!extensionCommand) return false;
      const sourceTarget = Updates.getTelegramMessageTarget(message);
      try {
        await extensionCommand.handler({
          name: command.name,
          args: command.args,
          reply: (text) =>
            deps
              .sendTextReply(message.chat.id, message.message_id, text, {
                target: sourceTarget,
              })
              .then(() => {}),
          enqueuePrompt: (prompt) =>
            promptEnqueue(
              [
                {
                  ...message,
                  text: prompt,
                  caption: undefined,
                } as TMessage,
              ],
              ctx,
            ),
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("telegram-command", error, {
          command: command.name,
        });
        await deps.sendTextReply(
          message.chat.id,
          message.message_id,
          "Command failed.",
          { target: sourceTarget },
        );
      }
      return true;
    },
    expandPromptTemplateCommand: (commandName, args) =>
      PromptTemplates.expandTelegramPromptTemplateCommand(
        commandName,
        args,
        getPromptTemplateCommands(),
      ),
    replaceMessageText: (message, text) =>
      ({ ...message, text, caption: undefined }) as TMessage,
    enqueueTurn: promptEnqueue,
  });
  dispatchAllTabCommandToTarget = async (commandText, query, threadId, ctx) => {
    const chatId = query.message?.chat?.id;
    if (typeof chatId !== "number") return;
    await commandOrPrompt.dispatchMessages(
      [
        {
          ...(query.message ?? {}),
          message_id: 0,
          chat: { id: chatId, type: "private" },
          from: query.from,
          message_thread_id: threadId,
          text: commandText,
          caption: undefined,
        } as TMessage,
      ],
      ctx,
    );
  };
  const mediaDispatch = Media.createTelegramMediaGroupDispatchRuntime<
    TMessage,
    TContext
  >({
    mediaGroups: deps.mediaGroupRuntime,
    dispatchMessages: commandOrPrompt.dispatchMessages,
  });
  const textDispatch = TextGroups.createTelegramTextGroupDispatchRuntime<
    TMessage,
    TContext
  >({
    textGroups: deps.textGroupRuntime,
    dispatchMessages: commandOrPrompt.dispatchMessages,
    dispatchSingleMessage: mediaDispatch.handleMessage,
  });
  const editRuntime = Turns.createTelegramQueuedPromptEditRuntime<
    TMessage,
    TContext
  >({
    ...deps.telegramQueueStore,
    updateStatus: deps.updateStatus,
  });
  const handleTelegramTopicLifecycleUpdate = async (
    lifecycle: Updates.TelegramTopicLifecycleUpdate<TMessage>,
    ctx: TContext,
  ): Promise<void> => {
    await deps.handleTelegramTopicLifecycleUpdate?.(lifecycle, ctx);
    if (lifecycle.kind !== "created" || !deps.threadStore) {
      return;
    }
    await deps.threadStore.load();
  };
  const handleAuthorizedTelegramGuestMessage = async (
    guestMessage: Updates.TelegramGuestMessage & { from: TelegramUser },
    ctx: TContext,
  ): Promise<void> => {
    const text = guestMessage.text ?? "";
    const gm = guestMessage as unknown as Record<string, unknown>;
    // Build telegram prefix with guest context
    const chatRaw = gm.chat as Record<string, unknown>;
    const chatType = chatRaw?.type as string;
    const fromRaw = gm.from as Record<string, unknown> | undefined;
    const replyMsg = gm.reply_to_message as Record<string, unknown> | undefined;
    const replyFromRaw = replyMsg?.from as Record<string, unknown> | undefined;
    const guestBotCallerUser = gm.guest_bot_caller_user as
      Record<string, unknown> | undefined;
    const guestBotCallerChat = gm.guest_bot_caller_chat as
      Record<string, unknown> | undefined;
    const ownerUserId = deps.configStore.getAllowedUserId();
    const replyPeer = formatTelegramPromptPeer(replyFromRaw);
    const guestPeer = resolveTelegramGuestPromptPeer({
      chatType,
      chat: chatRaw,
      from: fromRaw,
      replyFrom: replyFromRaw,
      guestBotCallerUser,
      guestBotCallerChat,
      ownerUserId,
    });
    const prefixParts = ["telegram"];
    if (guestPeer) {
      prefixParts.push(`guest:${guestPeer}`);
    } else if (chatType === "private") {
      deps.recordRuntimeEvent?.(
        "guest",
        new Error("Private Guest Mode remote peer could not be resolved"),
        {
          phase: "peer-attribution",
          chatId: typeof chatRaw?.id === "number" ? chatRaw.id : undefined,
          fromId: typeof fromRaw?.id === "number" ? fromRaw.id : undefined,
          hasReplyFrom: !!replyFromRaw,
          hasCallerUser: !!guestBotCallerUser,
          hasCallerChat: !!guestBotCallerChat,
        },
      );
    }
    const telegramPrefix = `[${prefixParts.join("|")}]`;
    // Extract reply context
    const replyText = replyMsg
      ? ((replyMsg.text as string) || (replyMsg.caption as string) || "").trim()
      : "";
    // Download files, run inbound handlers
    const guestMsg = guestMessage as unknown as Media.TelegramMediaMessage;
    const replyFiles = guestMsg.reply_to_message
      ? await Media.downloadTelegramMessageFiles(
          [guestMsg.reply_to_message as Media.TelegramMediaMessage],
          { downloadFile: deps.downloadFile },
        )
      : [];
    const files = await Media.downloadTelegramMessageFiles([guestMsg], {
      downloadFile: deps.downloadFile,
    });
    const processed = await deps.inboundHandlerRuntime.process(
      files,
      text,
      ctx,
    );
    const rawText = processed.rawText || text;
    let sourceContext = "";
    if (replyMsg) {
      const replyHeader = replyPeer ? `[reply|from:${replyPeer}]` : "[reply]";
      const replyBlock = replyText
        ? `${replyHeader} ${replyText}`
        : replyHeader;
      sourceContext = appendTelegramSourceAttachmentSection(
        replyBlock,
        replyPeer,
        replyFiles,
      );
    }
    const promptText = Turns.buildTelegramTurnPrompt({
      telegramPrefix,
      rawText,
      files,
      promptFiles: processed.promptFiles,
      handlerOutputs: processed.handlerOutputs,
      sourceContext,
    });
    const order = deps.bridgeRuntime.queue.allocateItemOrder();
    const content: Queue.TelegramPromptContent[] = [
      { type: "text", text: promptText },
    ];
    for (const file of processed.promptFiles) {
      if (file.isImage && file.mimeType) {
        try {
          const buffer = await readFile(file.path);
          content.push({
            type: "image",
            data: Buffer.from(buffer).toString("base64"),
            mimeType: file.mimeType,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
    const guestTurn: Queue.PendingTelegramTurn = {
      kind: "prompt",
      chatId: 0,
      replyToMessageId: 0,
      guestQueryId: guestMessage.guest_query_id,
      sourceMessageIds: [],
      queueOrder: order,
      queueLane: "default",
      laneOrder: order,
      queuedAttachments: [],
      content,
      historyText: Turns.formatTelegramTurnStatusSummary(
        processed.rawText || text,
        processed.promptFiles,
        processed.handlerOutputs,
      ),
      statusSummary: Turns.truncateTelegramQueueSummary(
        processed.rawText || text,
      ),
    };
    const items = deps.telegramQueueStore.getQueuedItems();
    deps.telegramQueueStore.setQueuedItems(
      Queue.appendTelegramQueueItem(items, guestTurn),
    );
    deps.updateStatus(ctx);
    requestDispatchNextQueuedTelegramTurn(ctx);
  };
  return Updates.createTelegramPairedUpdateRuntime<TContext, TUpdate>({
    getAllowedUserId: deps.configStore.getAllowedUserId,
    getCurrentInstanceId: deps.getCurrentInstanceId,
    getMessageOwnership: deps.getMessageOwnership,
    getTargetOwnership: deps.getTargetOwnership,
    recordMessageOwnership: deps.recordMessageOwnership,
    handleTelegramTopicLifecycleUpdate,
    foreignOwnedUpdateForwarder: deps.foreignOwnedUpdateForwarder,
    setAllowedUserId: deps.configStore.setAllowedUserId,
    persistConfig: deps.configStore.persist,
    updateStatus: deps.updateStatus,
    removePendingMediaGroupMessages: deps.mediaGroupRuntime.removeMessages,
    removeQueuedTelegramTurnsByMessageIds:
      deps.queueMutationRuntime.removeByMessageIds,
    clearQueuedTelegramTurnPriorityByMessageId:
      deps.queueMutationRuntime.clearPriorityByMessageId,
    prioritizeQueuedTelegramTurnByMessageId:
      deps.queueMutationRuntime.prioritizeByMessageId,
    answerCallbackQuery: deps.answerCallbackQuery,
    answerGuestQuery: deps.answerGuestQuery,
    handleAuthorizedTelegramCallbackQuery: callbackHandler,
    sendTextReply: deps.sendTextReply,
    handleAuthorizedTelegramMessage: async (message, ctx) => {
      if (typeof message.message_thread_id === "number") {
        await deps.handleTelegramThreadTargetObserved?.(
          {
            chatId: message.chat.id,
            threadId: message.message_thread_id,
          },
          ctx,
        );
      }
      const text = Media.extractFirstTelegramMessageText([
        message as TMessage,
      ]).trim();
      if (deps.threadStore && typeof message.message_thread_id !== "number") {
        await deps.threadStore.load();
        if (deps.threadStore.getBotState().threadMode === "disabled") {
          await textDispatch.handleMessage(message as TMessage, ctx);
          return;
        }
        const records = deps.threadStore.list();
        const bindings = getTelegramRoutableThreadRecords(
          records,
          deps.getLiveThreadTargets?.(),
        );
        const command = getKnownTelegramAllTabCommand(text);
        if (bindings.length > 0 && command && command.name !== "thread") {
          if (
            await sendAllTabCommandChooser(command, text, message as TMessage, {
              replyToSource: true,
            })
          ) {
            return;
          }
        }
        if (bindings.length > 0 && !text.startsWith("/")) {
          const probeTarget = bindings[0]?.target;
          if (probeTarget?.threadId && deps.callApi) {
            try {
              await deps.callApi("sendChatAction", {
                chat_id: probeTarget.chatId,
                message_thread_id: probeTarget.threadId,
                action: "typing",
              });
            } catch (error) {
              if (
                Threads.isTelegramTopicModeUnavailableError(error) ||
                Threads.isTelegramTopicTargetStaleError(error)
              ) {
                deps.threadStore.setBotState({
                  threadMode: "disabled",
                  updatedAtMs: Date.now(),
                  lastReconcileAction:
                    "thread-mode-unavailable-threadless-prompt",
                });
                await deps.threadStore.persist();
                await textDispatch.handleMessage(message as TMessage, ctx);
                return;
              }
              deps.recordRuntimeEvent?.("telegram", error, {
                phase: "threadless-topic-capability-check",
                chatId: probeTarget.chatId,
                threadId: probeTarget.threadId,
              });
            }
          }
          await deps.sendTextReply(
            message.chat.id,
            message.message_id,
            "This bot is in threaded multi-instance mode. Send prompts in a bound Pi thread tab so they route to the right instance.",
          );
          return;
        }
      }
      await textDispatch.handleMessage(message as TMessage, ctx);
    },
    handleAuthorizedTelegramEditedMessage: editRuntime.updateFromEditedMessage,
    handleAuthorizedTelegramGuestMessage,
    handleUnboundTelegramTopicMessage: async (message, ctx) => {
      if (!deps.threadStore) {
        await textDispatch.handleMessage(message as TMessage, ctx);
        return;
      }
      await deps.threadStore.load();
      if (deps.threadStore.getBotState().threadMode === "disabled") {
        await textDispatch.handleMessage(message as TMessage, ctx);
        return;
      }
      const target = Updates.getTelegramMessageTarget(message);
      if (!target?.threadId) {
        await textDispatch.handleMessage(message as TMessage, ctx);
        return;
      }
      const text = Media.extractFirstTelegramMessageText([
        message as TMessage,
      ]).trim();
      const instanceId = deps.getCurrentInstanceId?.();
      const leaderProfileKey = getLeaderTopicProfileKey(ctx, instanceId);
      const records = deps.threadStore.list();
      const routableRecords = getTelegramRoutableThreadRecords(
        records,
        deps.getLiveThreadTargets?.(),
      );
      const hasAnyRoutableThread = routableRecords.length > 0;
      const existing = records.find((r) => {
        return (
          r.target.chatId === target.chatId &&
          r.target.threadId === target.threadId
        );
      });
      if (existing) {
        const isLeaderTopic =
          (instanceId && existing.instanceId === instanceId) ||
          (!!leaderProfileKey && existing.profileKey === leaderProfileKey);
        if (existing.status === "active" && isLeaderTopic) {
          if (typeof existing.rerouteConfirmedAtMs !== "number") {
            const nowMs = Date.now();
            deps.threadStore.upsert({
              ...existing,
              updatedAtMs: nowMs,
              rerouteConfirmedAtMs: nowMs,
            });
            await deps.threadStore.persist();
          }
          await textDispatch.handleMessage(message as TMessage, ctx);
          return;
        }
        if (existing.status === "starting") {
          await deps.sendTextReply(
            target.chatId,
            message.message_id,
            "Instance " +
              getTelegramThreadRecordLabel(existing) +
              " is starting. Please wait…",
            { target },
          );
          return;
        }
        if (existing.status === "active") {
          await deps.sendTextReply(
            target.chatId,
            message.message_id,
            "Instance " +
              getTelegramThreadRecordLabel(existing) +
              " is not connected to the Telegram bus yet. Run /telegram-connect in that Pi instance; keeping this thread.",
            { target },
          );
          return;
        }
        if (
          (existing.status === "stale" || existing.status === "offline") &&
          leaderProfileKey &&
          !hasActiveLeaderTopic(
            deps.threadStore.list(),
            leaderProfileKey,
            instanceId,
          ) &&
          !hasAnyRoutableThread
        ) {
          const priorLeaderRecord =
            deps.threadStore.getByProfileKey(leaderProfileKey);
          const slot =
            deps.threadStore.allocateSlot(
              leaderProfileKey,
              priorLeaderRecord?.slot ?? existing.slot,
            ) ??
            priorLeaderRecord?.slot ??
            existing.slot ??
            "A";
          const threadName =
            priorLeaderRecord?.threadName ??
            existing.threadName ??
            Threads.chooseTelegramThreadName({ slot }) ??
            "Pi";
          deps.threadStore.upsert({
            profileKey: leaderProfileKey,
            owner: {
              kind: "leader",
              cwd:
                typeof (ctx as { cwd?: unknown }).cwd === "string"
                  ? (ctx as { cwd?: string }).cwd
                  : undefined,
              instanceId,
            },
            target: { chatId: target.chatId, threadId: target.threadId },
            status: "active",
            createdAtMs: priorLeaderRecord?.createdAtMs ?? existing.createdAtMs,
            updatedAtMs: Date.now(),
            threadName,
            instanceId,
            slot,
          });
          await deps.threadStore.persist();
          deps.recordRuntimeEvent?.(
            "bus",
            "Bus leader reclaimed unbound thread",
            {
              phase: "leader-topic-reclaim",
              chatId: target.chatId,
              threadId: target.threadId,
              slot,
              profileKey: leaderProfileKey,
            },
          );
          await textDispatch.handleMessage(message as TMessage, ctx);
          return;
        }
        await deps.sendTextReply(
          target.chatId,
          message.message_id,
          "Topic " +
            (existing.slot ?? "?") +
            " is " +
            existing.status +
            ". Start a Pi instance to claim it.",
          { target },
        );
        return;
      }
      const reservations = deps.threadStore.listReservations();
      const reservation = reservations.find(
        (reservation) =>
          reservation.target.chatId === target.chatId &&
          reservation.target.threadId === target.threadId,
      );
      if (reservation) {
        await deps.sendTextReply(
          target.chatId,
          message.message_id,
          "Previous leader thread (" +
            (reservation.slot ?? "?") +
            "). Closing and deleting this old topic. Use the current thread tab instead.",
          { target },
        );
        await deleteReservedTelegramTopicThroughReconciler(
          deps,
          { chatId: target.chatId, threadId: target.threadId },
          message.message_id,
        );
        return;
      }
      const command = getKnownTelegramAllTabCommand(text);
      if (command && hasAnyRoutableThread) {
        if (
          await sendAllTabCommandChooser(command, text, message as TMessage, {
            target: { chatId: target.chatId, threadId: target.threadId },
            replyToSource: true,
          })
        ) {
          return;
        }
      }
      if (leaderProfileKey && deps.callApi) {
        const currentLeaderRecord = records.find((record) => {
          if (record.status !== "active") return false;
          if (instanceId && record.instanceId === instanceId) return true;
          return record.profileKey === leaderProfileKey;
        });
        if (
          currentLeaderRecord &&
          (currentLeaderRecord.target.chatId !== target.chatId ||
            currentLeaderRecord.target.threadId !== target.threadId)
        ) {
          let currentLeaderIsStale = false;
          try {
            await deps.callApi("sendChatAction", {
              chat_id: currentLeaderRecord.target.chatId,
              message_thread_id: currentLeaderRecord.target.threadId,
              action: "typing",
            });
          } catch (error) {
            currentLeaderIsStale =
              Threads.isTelegramTopicTargetStaleError(error);
            if (!currentLeaderIsStale) throw error;
          }
          if (currentLeaderIsStale) {
            deps.threadStore.markStaleByTarget(
              currentLeaderRecord.target,
              "deleted",
              "Current leader thread is stale during unbound prompt routing.",
            );
            const slot = currentLeaderRecord.slot ?? "A";
            const threadName = getRestoredThreadName(currentLeaderRecord, slot);
            deps.threadStore.upsert({
              ...currentLeaderRecord,
              profileKey: leaderProfileKey,
              owner: {
                kind: "leader",
                cwd:
                  typeof (ctx as { cwd?: unknown }).cwd === "string"
                    ? (ctx as { cwd?: string }).cwd
                    : undefined,
                instanceId,
              },
              target: { chatId: target.chatId, threadId: target.threadId },
              status: "active",
              updatedAtMs: Date.now(),
              threadName,
              instanceId,
              slot,
            });
            await deps.threadStore.persist();
            deps.recordRuntimeEvent?.(
              "bus",
              "Bus leader reclaimed stale-current unbound thread",
              {
                phase: "leader-topic-unbound-stale-reclaim",
                chatId: target.chatId,
                threadId: target.threadId,
                staleThreadId: currentLeaderRecord.target.threadId,
                slot,
                profileKey: leaderProfileKey,
              },
            );
            await textDispatch.handleMessage(message as TMessage, ctx);
            return;
          }
        }
      }
      if (
        leaderProfileKey &&
        !hasActiveLeaderTopic(records, leaderProfileKey, instanceId) &&
        !hasAnyRoutableThread
      ) {
        const priorLeaderRecord =
          deps.threadStore.getByProfileKey(leaderProfileKey);
        const priorLeaderIdentity =
          deps.threadStore.getIdentityByProfileKey(leaderProfileKey);
        const slot =
          deps.threadStore.allocateSlot(
            leaderProfileKey,
            priorLeaderRecord?.slot ?? priorLeaderIdentity?.slot,
          ) ??
          priorLeaderRecord?.slot ??
          priorLeaderIdentity?.slot ??
          "A";
        const identityThreadName =
          priorLeaderIdentity?.threadName &&
          Threads.isTelegramTopicThreadNameValidForSlot(
            priorLeaderIdentity.threadName,
            slot,
          )
            ? priorLeaderIdentity.threadName
            : undefined;
        const threadName =
          priorLeaderRecord?.threadName ??
          identityThreadName ??
          Threads.chooseTelegramThreadName({ slot }) ??
          "Pi";
        deps.threadStore.upsert({
          profileKey: leaderProfileKey,
          owner: {
            kind: "leader",
            cwd:
              typeof (ctx as { cwd?: unknown }).cwd === "string"
                ? (ctx as { cwd?: string }).cwd
                : undefined,
            instanceId,
          },
          target: { chatId: target.chatId, threadId: target.threadId },
          status: "active",
          createdAtMs: priorLeaderRecord?.createdAtMs ?? Date.now(),
          updatedAtMs: Date.now(),
          threadName,
          instanceId,
          slot,
        });
        await deps.threadStore.persist();
        deps.recordRuntimeEvent?.(
          "bus",
          "Bus leader reclaimed unbound thread",
          {
            phase: "leader-topic-reclaim",
            chatId: target.chatId,
            threadId: target.threadId,
            slot,
            profileKey: leaderProfileKey,
          },
        );
        await textDispatch.handleMessage(message as TMessage, ctx);
        return;
      }
      await sendUnboundRerouteChooser(message as TMessage, ctx);
      return;
    },
  });
}
