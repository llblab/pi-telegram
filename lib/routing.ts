/**
 * Telegram inbound routing composition
 * Zones: telegram inbound, orchestration, queue/menu/command composition
 * Wires authorized updates into menus, commands, media grouping, and prompt queueing, and owns exact assistant-output target/route authority capture
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as Bus from "./bus.ts";
import * as Commands from "./commands.ts";
import type { TelegramConfigStore } from "./config.ts";
import type { TelegramInboundHandlerRuntime } from "./inbound.ts";
import type {
  TelegramUpdateJournalQueuedCompletion,
  TelegramUpdateJournalQueuedReceiptEvidence,
} from "./journal.ts";
import * as Media from "./media.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as PromptTemplates from "./prompt-templates.ts";
import * as Queue from "./queue.ts";
import { escapeHtml } from "./rendering.ts";
import * as Replies from "./replies.ts";
import type { TelegramBridgeRuntime } from "./runtime.ts";
import type { TelegramSectionRegistry } from "./sections.ts";
import type {
  TelegramApiCallOptions,
  TelegramInputRichMessage,
} from "./telegram-api.ts";
import * as TelegramApi from "./telegram-api.ts";
import * as TextGroups from "./text-groups.ts";
import * as ThreadNaming from "./thread-naming.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import type {
  TelegramInstanceThreadIdentityCandidate,
  TelegramTopicTargetRecord,
} from "./threads.ts";
import * as Turns from "./turns.ts";
import * as WorkspaceIdentity from "./workspace-identity.ts";
import type { createTelegramWorkspaceExternalProtectionCapture } from "./workspace-retirement.ts";

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

/** Stable file scope of the remote Guest Mode peer: username, else numeric id; never the bot's own scope. */
export function resolveTelegramGuestFileScope(
  input: Parameters<typeof resolveTelegramGuestPromptPeer>[0],
): string {
  const candidates =
    input.chatType !== "private"
      ? [input.chat]
      : [
          input.from,
          input.chat,
          input.guestBotCallerUser,
          input.guestBotCallerChat,
          input.replyFrom,
        ];
  for (const candidate of candidates) {
    if (
      !candidate ||
      (input.chatType === "private" &&
        (isTelegramPromptOwnerPeer(candidate, input.ownerUserId) ||
          isTelegramPromptBotPeer(candidate)))
    )
      continue;
    if (typeof candidate.username === "string" && candidate.username.length > 0)
      return candidate.username;
    if (typeof candidate.id === "number" && Number.isSafeInteger(candidate.id))
      return String(Math.abs(candidate.id));
  }
  return "guest";
}

function appendTelegramSourceAttachmentSection(
  text: string,
  from: string | undefined,
  files: Pick<Media.DownloadedTelegramFile, "path">[],
  outputs: readonly string[] = [],
): string {
  if (files.length === 0 && outputs.length === 0) return text;
  const dirs = [...new Set(files.map((file) => dirname(file.path)))];
  const sameDir = dirs.length === 1;
  const source = from ? `|from:${from}` : "";
  const header = sameDir
    ? `[attachments${source}] ${dirs[0]}`
    : `[attachments${source}]`;
  const items = sameDir
    ? files.map((file) => `/${basename(file.path)}`)
    : files.map((file) => file.path);
  const sections = text ? [text] : [];
  if (items.length > 0) {
    sections.push(`${header}\n${items.map((item) => `- ${item}`).join("\n")}`);
  }
  if (outputs.length > 0) {
    const outputHeader = `[outputs${source}]`;
    sections.push(
      `${outputHeader}\n${outputs.map((output) => `- ${output}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
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

const TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX = "reroute:";
const TELEGRAM_UNBOUND_REROUTE_RESTORE_MENU_CALLBACK_PREFIX = "rerouterestore:";
const TELEGRAM_UNBOUND_REROUTE_MENU_CALLBACK_PREFIX = "reroutemenu:";
const TELEGRAM_UNBOUND_REROUTE_ROOT_CALLBACK_PREFIX = "rerouteroot:";
const TELEGRAM_UNBOUND_REROUTE_NEW_SLOT_CALLBACK_PREFIX = "reroutenew:";
const TELEGRAM_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX = "reroutecancel:";
const TELEGRAM_PENDING_CANCELLATION_REVIEW_PREFIX = "reroutecancel:review:";
const TELEGRAM_RETIRED_HISTORICAL_REVIEW_PREFIX = "reroutecancel:history:";
const TELEGRAM_SLOT_CAPACITY_MESSAGE =
  "No Telegram instance slot is available. Automatic reclamation is disabled for safety.";

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
): { rerouteId: string; restore: boolean; root: boolean } | undefined {
  const match = data?.match(
    /^(rerouterestore|reroutemenu|rerouteroot):([a-z0-9]+)$/,
  );
  const rerouteId = match?.[2];
  return rerouteId
    ? {
        rerouteId,
        restore: match?.[1] === "rerouterestore",
        root: match?.[1] === "rerouteroot",
      }
    : undefined;
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
  getDisplayTitle?: Threads.TelegramCurrentThreadAssembly["getDisplayTitle"],
): string {
  return (
    getDisplayTitle?.(record.target) ??
    getRestoredThreadName(record, record.slot ?? "")
  );
}

function getRestoredThreadName(
  record: Threads.TelegramTopicTargetRecord,
  slot: string,
): string {
  return record.threadName &&
    ThreadNaming.isTelegramTopicThreadNameValidForSlot(record.threadName, slot)
    ? record.threadName
    : (ThreadNaming.chooseTelegramThreadName({ slot }) ?? "Pi");
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

/**
 * Owner inputs that stayed in All while their chooser moved to a routing tab: a menu-picked command arrives
 * threadless, whereas a typed All input already opens its own tab and leaves with it.
 */
function getTelegramAllTabSourceMessageIds(
  messages: readonly Partial<TelegramRoutedMessage>[],
  chatId: number,
): number[] {
  return messages.flatMap((message) =>
    message.chat?.type === "private" &&
    message.chat.id === chatId &&
    message.message_thread_id === undefined &&
    message.from?.is_bot === false &&
    Number.isSafeInteger(message.message_id) &&
    message.message_id! > 0
      ? [message.message_id!]
      : [],
  );
}

/** What a route chooser moves: `<code>/name</code>` for a command, otherwise "this message". */
function formatTelegramRouteSubject(command?: string): string {
  return command ? `<code>/${escapeHtml(command)}</code>` : "this message";
}

/** Root chooser heading; the buttons themselves name each available action. */
function formatTelegramTemporaryThreadChooserText(command?: string): string {
  return [
    `<b>🚦 Route ${formatTelegramRouteSubject(command)}:</b>`,
    "",
    "<i>The choice expires in 60 minutes.</i>",
  ].join("\n");
}

/** The message field holding a Telegram file (`file_id`, directly or in a size array), named by Telegram itself. */
function findTelegramMessageFileField(
  fields: Record<string, unknown>,
): string | undefined {
  const hasFileId = (value: unknown): boolean =>
    !!value &&
    typeof value === "object" &&
    typeof (value as { file_id?: unknown }).file_id === "string";
  return Object.keys(fields).find((key) => {
    const value = fields[key];
    return Array.isArray(value) ? value.some(hasFileId) : hasFileId(value);
  });
}

/** One-line review label for any message: its text, or `📎` plus the caption, file name or file field. */
function formatTelegramRoutingInputPreview(message: object): string {
  const fields = message as Record<string, unknown>;
  const clean = (value: unknown): string =>
    typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  let label = clean(fields.text);
  if (!label) {
    const field = findTelegramMessageFileField(fields);
    const file = field ? fields[field] : undefined;
    const fileName = clean(
      !Array.isArray(file) && file
        ? (file as { file_name?: unknown }).file_name
        : undefined,
    );
    const kind = field?.replace(/_/gu, " ") ?? "message";
    const caption = clean(fields.caption);
    label = caption ? `📎 ${kind}: ${caption}` : `📎 ${fileName || kind}`;
  }
  const chars = Array.from(label);
  return (
    escapeHtml(chars.slice(0, 80).join("")) + (chars.length > 80 ? "…" : "")
  );
}

function formatTelegramAllTabMenuChooserText(command: string): string {
  return [
    `<b>🚦 Route ${formatTelegramRouteSubject(command)}:</b>`,
    "",
    "<i>To restore a Pi instead, send a message in a new tab.</i>",
  ].join("\n");
}

function buildTelegramUnboundRerouteChooserMarkup(
  rerouteId: string,
  records: readonly Threads.TelegramTopicTargetRecord[],
  options: {
    canRestore: boolean;
    canCancel?: boolean;
    getDisplayTitle?: Threads.TelegramCurrentThreadAssembly["getDisplayTitle"];
  },
): Menu.TelegramReplyMarkup {
  const activeRecords = records.filter((record) => record.status === "active");
  const canRestoreAnyLiveThread =
    options.canRestore && activeRecords.length > 0;
  const rows = activeRecords.length
    ? [
        [
          {
            text: "🔀 Reroute: send it to a Pi thread",
            callback_data: `${TELEGRAM_UNBOUND_REROUTE_MENU_CALLBACK_PREFIX}${rerouteId}`,
          },
        ],
      ]
    : [];
  if (canRestoreAnyLiveThread)
    rows.push([
      {
        text: "🔁 Restore: move a Pi into this tab",
        callback_data:
          formatTelegramUnboundRerouteRestoreMenuCallbackData(rerouteId),
      },
    ]);
  if (options.canCancel)
    rows.push([
      {
        text: "⛔️ Cancel routing",
        callback_data: `${TELEGRAM_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX}${rerouteId}`,
      },
    ]);
  return { inline_keyboard: rows };
}

function buildTelegramUnboundRerouteRestoreChooserMarkup(
  rerouteId: string,
  records: readonly Threads.TelegramTopicTargetRecord[],
  getDisplayTitle?: Threads.TelegramCurrentThreadAssembly["getDisplayTitle"],
): Menu.TelegramReplyMarkup {
  return {
    inline_keyboard: records
      .filter((record) => record.status === "active")
      .map((record) => [
        {
          text: `🧵 ${getTelegramThreadRecordLabel(record, getDisplayTitle)}`,
          callback_data: formatTelegramUnboundRerouteNewSlotCallbackData(
            rerouteId,
            record.target.threadId,
          ),
        },
      ]),
  };
}

function formatTelegramUnboundRerouteChooserText(command?: string): string {
  return `<b>🔀 Reroute ${formatTelegramRouteSubject(command)} to:</b>`;
}

function formatTelegramUnboundRerouteRestoreChooserText(
  command?: string,
): string {
  return `<b>🔁 Restore into this tab & send ${formatTelegramRouteSubject(command)}:</b>`;
}

function formatTelegramUnboundTopicGuidance(): string {
  return [
    "<b>⚠️ New thread is not a Pi instance.</b>",
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

import * as Threads from "./threads.ts";
import type { TelegramUser } from "./updates.ts";
import * as Updates from "./updates.ts";
import { getTelegramVoiceReplyMode } from "./voice.ts";

/** Prepare the selected leader's exact retained originals; no copy, adoption, acceptance proof or dispatch. */
export function prepareTelegramLiveLeaderOriginal(input: {
  request: Threads.TelegramWorkspaceRestoreRequest;
  messages: readonly unknown[];
  isCurrent(): boolean;
}): Updates.TelegramLiveDeferredInputPreparation | undefined {
  const source = structuredClone(input.request.source),
    messages = [...input.messages];
  if (
    !input.isCurrent() ||
    input.request.owner.owner?.kind !== "leader" ||
    !isDeepStrictEqual(
      Updates.collectTelegramAdmissionSourceUpdateIds(messages),
      [...source.updateIds].sort((a, b) => a - b),
    )
  )
    return undefined;
  const originals = messages.map(Updates.inspectTelegramDeferredSource);
  if (
    originals.some(
      (original) =>
        !original ||
        original.journalBindingKey !== source.journalBindingKey ||
        original.completionSha256,
    )
  )
    return undefined;
  return Updates.prepareTelegramLiveDeferredInput(
    messages,
    input.isCurrent.bind(input),
  );
}

/**
 * Pure canonical read: exactly one live binding row for the request, relocated to its target, and exactly one active
 * owner claiming that slot or target. Callers add their own recipient/owner-kind/local checks; this grants nothing.
 */
function findRelocatedBindingOwner(
  view: Readonly<
    Pick<Threads.TelegramTopicTargetFile, "threads" | "workspaceBindings">
  >,
  request: Threads.TelegramWorkspaceRestoreRequest,
):
  | {
      row: Threads.TelegramWorkspaceThreadBinding;
      owner: Threads.TelegramTopicTargetRecord;
    }
  | undefined {
  const rows = (view.workspaceBindings ?? []).filter(
    (value) => value.bindingKey === request.binding.bindingKey,
  );
  const owners = view.threads.filter(
    (value) =>
      value.status === "active" &&
      (value.slot === request.binding.slot ||
        isDeepStrictEqual(value.target, request.target)),
  );
  const row = rows[0],
    owner = owners[0];
  return rows.length === 1 &&
    owners.length === 1 &&
    !!row &&
    !!owner &&
    row.sessionId === request.binding.sessionId &&
    row.cwd === request.binding.cwd &&
    row.slot === request.binding.slot &&
    row.inactiveSinceMs === undefined &&
    isDeepStrictEqual(row.target, request.target) &&
    owner.slot === request.binding.slot &&
    owner.profileKey === request.owner.profileKey &&
    isDeepStrictEqual(owner.target, request.target)
    ? { row, owner }
    : undefined;
}

export type TelegramLiveRebindCleanupIssue =
  | { status: "not-ready" }
  | {
      status: "finished";
      operationId: string;
      cleanup: ThreadReconciler.TelegramLiveRebindCleanupOutcome;
      recorded: boolean;
    };

/** Confirmed absence is an exact HTTP 400 deleted/missing Thread; other method rejections are definite failures. */
function classifyLiveRebindCleanupFailure(
  error: unknown,
): "absent" | "rejected" | "unknown" {
  if (
    error instanceof Error &&
    "status" in error &&
    error.status === 400 &&
    ThreadReconciler.isTelegramTopicDeletedErrorMessage(error.message)
  )
    return "absent";
  return TelegramApi.isTelegramApiRequestRejected(error, "deleteForumTopic")
    ? "rejected"
    : "unknown";
}

/** Default live-rebind cleanup pacing: quick early attempts, then minutely, within a 15-minute window. */
export const TELEGRAM_LIVE_REBIND_CLEANUP_SCHEDULE = Object.freeze({
  delaysMs: Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]),
  intervalMs: 60_000,
  windowMs: 15 * 60_000,
});

/** Chooser-scoped saved command reference; it is never retained after the chooser record. */
type TelegramLiveRebindSelectedCommandReference = {
  operationId: string;
  preparedSource: Bus.TelegramBusPreparedCommandSource;
  selectedCommand: Bus.TelegramBusSelectedCommandInput;
};

/** One warm live attempt with exact post-release peer donor settlement; no startup recovery, Restore ACK or cleanup. */
export function createTelegramLiveRebindCoordinator(input: {
  request: Threads.TelegramWorkspaceRestoreRequest;
  /** Captures caller source/reference, admission, profile, transport and Pi lifetime. */
  authority: Threads.TelegramWorkspaceRestoreAuthority;
  messages: readonly unknown[];
  restoreStore: Threads.TelegramWorkspaceRestore;
  threadStore: Pick<
    Threads.TelegramTopicTargetStore,
    "withWorkspaceRestoreSnapshot"
  >;
  getRecipient():
    | (Threads.TelegramWorkspaceRestoreRecipient & { bindingKey: string })
    | undefined;
  leader?: {
    apply(
      intent: Threads.TelegramWorkspaceLiveRebindIntent,
      mode: "apply" | "inspect",
      isCurrent: () => boolean,
    ): Promise<void>;
    /** Synchronous local identity only; safe inside a Workspace publication fence. */
    isApplied(intent: Threads.TelegramWorkspaceLiveRebindIntent): boolean;
  } & (
    | {
        /** Confirm ordinary queue admission of these same bound messages, never handler replay. */
        continue(
          messages: readonly unknown[],
          isCurrent: () => boolean,
        ): Promise<boolean>;
        /** Observe only the same issued admission through its existing receipt owner; never re-enqueue. */
        observeAdmission?(): boolean;
        complete?: never;
      }
    | {
        /** Issue one semantic completion; the adapter owns detached delivery and errors, not a removal ACK. */
        complete(messages: readonly unknown[], isCurrent: () => boolean): void;
        continue?: never;
      }
  );
  follower?: {
    run: ReturnType<typeof Bus.createTelegramBusLiveRebindController>;
    /** Explicit staged singleton command branch; absence preserves ordinary live input behavior. */
    selectedCommand?: Bus.TelegramBusSelectedCommandInput;
  };
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details: Record<string, unknown>,
  ) => void;
}) {
  const request = structuredClone(input.request),
    messages = [...input.messages];
  const executor = structuredClone(input.authority.executor),
    operatorUserId = input.authority.operatorUserId;
  const leader = input.leader && { ...input.leader },
    follower = input.follower,
    followerRun = follower?.run;
  const selectedCommand =
      follower?.selectedCommand && structuredClone(follower.selectedCommand),
    held = selectedCommand;
  const observedRecipient = input.getRecipient(),
    recipient = observedRecipient && structuredClone(observedRecipient);
  const sources = messages.map(Updates.inspectTelegramDeferredSource);
  const originals =
    recipient?.kind === "follower"
      ? messages.map(Updates.inspectTelegramDeferredSourceSnapshot)
      : undefined;
  const fences = messages.map(Updates.getTelegramUpdateExecutionFence);
  const commandValid =
    follower?.selectedCommand === undefined ||
    (!!held &&
      recipient?.kind === "follower" &&
      isDeepStrictEqual(held.target, request.target) &&
      originals?.length === 1 &&
      Commands.isTelegramSelectedHeldOriginal(
        originals[0]?.update,
        held.target,
        operatorUserId,
        held.name,
      ));
  const valid =
    commandValid &&
    Threads.isTelegramWorkspaceRestoreRequest(request) &&
    !!recipient?.bindingKey &&
    Threads.isTelegramWorkspaceRestoreRecipient(
      recipient && {
        kind: recipient.kind,
        instanceId: recipient.instanceId,
        sessionId: recipient.sessionId,
        generation: recipient.generation,
      },
    ) &&
    recipient?.sessionId === request.binding.sessionId &&
    recipient?.instanceId === request.owner.instanceId &&
    recipient?.kind ===
      (request.owner.owner?.kind === "leader" ? "leader" : "follower") &&
    isDeepStrictEqual(
      Updates.collectTelegramAdmissionSourceUpdateIds(messages),
      request.source.updateIds,
    ) &&
    sources.length === request.source.updateIds.length &&
    sources.every(
      (source) =>
        source &&
        !source.completionSha256 &&
        source.journalBindingKey === request.source.journalBindingKey,
    ) &&
    (!originals ||
      originals.every(
        (original, index) =>
          original &&
          isDeepStrictEqual(original.source, sources[index]) &&
          original.update.update_id === original.source.updateId,
      )) &&
    fences.every((fence) => fence && fence.signal === fences[0]?.signal);
  const current = () =>
    valid &&
    (!held ||
      (input.follower === follower &&
        follower?.run === followerRun &&
        isDeepStrictEqual(follower?.selectedCommand, selectedCommand))) &&
    input.authority.isCurrent() &&
    input.authority.operatorUserId === operatorUserId &&
    isDeepStrictEqual(input.authority.executor, executor) &&
    isDeepStrictEqual(input.getRecipient(), recipient) &&
    messages.every(
      (message, index) =>
        Updates.getTelegramUpdateExecutionFence(message) === fences[index] &&
        fences[index]?.isCurrent() === true,
    );
  const sourceSaved = () =>
    current() &&
    messages.every((message, index) =>
      isDeepStrictEqual(
        Updates.inspectTelegramDeferredSource(message),
        sources[index],
      ),
    );
  const authority = { executor, operatorUserId, isCurrent: current };
  const retained = () => {
    if (!current()) return undefined;
    const intent = input.restoreStore
      .listLiveRebindings()
      .find((value) => value.request.operationId === request.operationId);
    return current() &&
      intent &&
      isDeepStrictEqual(intent.request, request) &&
      intent.operatorUserId === operatorUserId &&
      isDeepStrictEqual(intent.executor, executor) &&
      isDeepStrictEqual(intent.recipient, {
        kind: recipient!.kind,
        instanceId: recipient!.instanceId,
        sessionId: recipient!.sessionId,
        generation: recipient!.generation,
      })
      ? intent
      : undefined;
  };
  const canonical = (expected: Threads.TelegramWorkspaceLiveRebindIntent) => {
    if (!current() || !isDeepStrictEqual(retained(), expected)) return false;
    let confirmed = false;
    input.threadStore.withWorkspaceRestoreSnapshot(expected, (snapshot) => {
      const owner = findRelocatedBindingOwner(snapshot, request)?.owner;
      confirmed =
        current() &&
        owner?.instanceId === recipient!.instanceId &&
        isDeepStrictEqual(owner.owner, request.owner.owner);
    });
    return confirmed && current();
  };
  let preparation: Updates.TelegramLiveDeferredInputPreparation | undefined;
  let saved = false,
    commitIssued = false,
    applyIssued = false,
    peerReleaseIssued = false,
    donorSettlementAttempted = false,
    continuationIssued = false,
    released = false,
    advancing = false;
  let preparedSource: Bus.TelegramBusPreparedCommandSource | undefined;
  const runFollower = async (
    mode?: "apply" | "inspect" | "release" | "observe-command",
  ) => {
    if (!input.follower || !recipient || !current()) return undefined;
    const run = held ? followerRun! : input.follower.run;
    return run.call(input.follower, {
      operationId: request.operationId,
      instanceId: recipient.instanceId,
      sessionId: recipient.sessionId,
      recipientBindingKey: recipient.bindingKey,
      isCurrent: current,
      ...(held
        ? {
            selectedCommand: structuredClone(selectedCommand!),
            ...(preparedSource
              ? { preparedSource: { ...preparedSource } }
              : {}),
          }
        : {}),
      ...(mode
        ? {
            mode,
            sourceUpdateIds: request.source.updateIds,
            slot: request.binding.slot!,
            target: request.target,
            oldTarget: request.binding.target,
          }
        : {
            updates: originals!.map((original) =>
              structuredClone(original!.update),
            ),
          }),
    });
  };
  const matches = (observation: Awaited<ReturnType<typeof runFollower>>) =>
    !!observation &&
    current() &&
    observation.operationId === request.operationId &&
    isDeepStrictEqual(observation.sourceUpdateIds, request.source.updateIds) &&
    isDeepStrictEqual(observation.selectedCommand, selectedCommand) &&
    (held
      ? !preparedSource ||
        isDeepStrictEqual(observation.preparedSource, preparedSource)
      : observation.preparedSource === undefined) &&
    isDeepStrictEqual(observation.recipient, {
      instanceId: recipient!.instanceId,
      sessionId: recipient!.sessionId,
      generation: recipient!.generation,
      bindingKey: recipient!.bindingKey,
    });
  const releaseFollower = async (
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
  ): Promise<"unknown" | "released"> => {
    if (!held || !peerReleaseIssued) {
      peerReleaseIssued = true;
      const observation = await runFollower("release");
      if (
        !matches(observation) ||
        observation?.status !== "released" ||
        !("action" in observation) ||
        observation.action !== "release" ||
        !canonical(intent)
      )
        return "unknown";
    }
    if (held) {
      const observation = await runFollower("observe-command");
      if (
        !matches(observation) ||
        observation?.status !== "command-observed" ||
        !("command" in observation) ||
        observation.command !== "completed" ||
        !preparedSource ||
        !isDeepStrictEqual(observation.sourceAck, preparedSource) ||
        !canonical(intent)
      )
        return "unknown";
    }
    donorSettlementAttempted = true;
    if (preparation?.settleTransferred(() => canonical(intent)) !== "settled")
      return "unknown";
    released = true;
    return "released";
  };
  const observeCommandCompletion = (): "unknown" | "released" => {
    const intent = retained();
    if (
      !intent ||
      intent.phase !== "released" ||
      intent.cleanup ||
      !canonical(intent) ||
      !leader?.isApplied(intent)
    )
      return "unknown";
    const completions = messages.map(
      Updates.inspectTelegramDeferredSourceCompletion,
    );
    return completions.every(
      (completion, index) =>
        completion && isDeepStrictEqual(completion, sources[index]),
    ) &&
      current() &&
      canonical(intent) &&
      leader.isApplied(intent) &&
      current()
      ? "released"
      : "unknown";
  };
  return {
    /** Correlation only; a later cleanup attempt rereads and revalidates the canonical row itself. */
    operationId: request.operationId,
    /** Body-free copy of the authenticated saved command reference: correlation only, never authority, an ACK or a cleanup permit. */
    selectedCommandReference():
      TelegramLiveRebindSelectedCommandReference | undefined {
      return held && preparedSource
        ? {
            operationId: request.operationId,
            selectedCommand: structuredClone(selectedCommand!),
            preparedSource: { ...preparedSource },
          }
        : undefined;
    },
    async advance(): Promise<"protected" | "unknown" | "released"> {
      if (advancing || !current()) return "protected";
      if (released) return "released";
      if (
        (continuationIssued &&
          !leader?.complete &&
          !leader?.observeAdmission) ||
        donorSettlementAttempted
      )
        return "unknown";
      advancing = true;
      try {
        // Completion consumes source inspection; only the issued worker ACK can resolve it, without replay.
        if (continuationIssued) {
          if (leader?.complete) return observeCommandCompletion();
          const intent = retained();
          if (
            !intent ||
            intent.phase !== "released" ||
            intent.cleanup ||
            !canonical(intent) ||
            !leader?.isApplied(intent) ||
            !leader.observeAdmission?.() ||
            !current() ||
            !canonical(intent) ||
            !leader.isApplied(intent)
          )
            return "unknown";
          released = true;
          return "released";
        }
        if (!sourceSaved()) return "protected";
        if (!saved) {
          if (recipient!.kind === "leader") {
            if (!leader || !!leader.continue === !!leader.complete)
              return "protected";
            preparation ??= prepareTelegramLiveLeaderOriginal({
              request,
              messages,
              isCurrent: current,
            });
            if (!preparation?.confirmSaved()) return "protected";
          } else {
            if (!input.follower) return "protected";
            preparation ??= Updates.prepareTelegramLiveDeferredInput(
              messages,
              current,
            );
            if (!preparation?.confirmSaved()) return "protected";
            const observation = await runFollower();
            if (
              !matches(observation) ||
              observation?.status !== "saved" ||
              !sourceSaved()
            )
              return "unknown";
            if (held) {
              const proof = observation.preparedSource;
              if (
                !proof ||
                Object.keys(proof).some(
                  (key) =>
                    !["journalBindingKey", "updateId", "sourceSha256"].includes(
                      key,
                    ),
                ) ||
                proof.journalBindingKey !== recipient!.bindingKey ||
                proof.updateId !== request.source.updateIds[0] ||
                typeof proof.sourceSha256 !== "string" ||
                !/^[a-f0-9]{64}$/.test(proof.sourceSha256)
              )
                return "unknown";
              preparedSource = { ...proof };
            }
          }
          saved = true;
        }
        if (!sourceSaved() || (preparation && !preparation.confirmSaved()))
          return "protected";
        // A lost commit reply permits exact readback, never another relocation in this warm attempt.
        let intent = retained();
        if (!intent) {
          if (commitIssued) return "unknown";
          commitIssued = true;
          intent = await input.restoreStore.commitLiveRebind(
            request,
            {
              kind: recipient!.kind,
              instanceId: recipient!.instanceId,
              sessionId: recipient!.sessionId,
              generation: recipient!.generation,
            },
            authority,
          );
        } else if (!commitIssued) return "protected";
        if (
          !intent ||
          !sourceSaved() ||
          !canonical(intent) ||
          intent.phase === "finished" ||
          intent.cleanup
        )
          return "protected";
        // A released peer may already have completed its sources; only its retained settlement can reobserve that outcome.
        if (recipient!.kind === "follower" && peerReleaseIssued)
          return intent.phase === "released"
            ? await releaseFollower(intent)
            : "protected";
        const mode =
          applyIssued || intent.phase === "released" ? "inspect" : "apply";
        applyIssued = true;
        if (recipient!.kind === "leader") {
          await leader!.apply(structuredClone(intent), mode, current);
          if (!current() || !canonical(intent) || !leader!.isApplied(intent))
            return "unknown";
        } else {
          const observation = await runFollower(mode);
          if (
            !matches(observation) ||
            observation?.status !== "applied" ||
            !("target" in observation) ||
            !isDeepStrictEqual(observation.target, request.target) ||
            observation.slot !== request.binding.slot ||
            !canonical(intent)
          )
            return "unknown";
        }
        if (!sourceSaved() || (preparation && !preparation.confirmSaved()))
          return "protected";
        if (intent.phase === "rebound") {
          const expected = intent;
          input.restoreStore.advanceLiveRebind(
            expected,
            "release",
            recipient!.kind === "leader"
              ? {
                  ...authority,
                  isCurrent: () => current() && leader!.isApplied(expected),
                }
              : authority,
          );
          intent = retained();
        }
        if (
          !intent ||
          intent.phase !== "released" ||
          intent.cleanup ||
          !canonical(intent)
        )
          return "protected";
        if (recipient!.kind === "leader") {
          const expected = intent;
          if (
            !preparation?.beginRelease(
              () => canonical(expected) && leader!.isApplied(expected),
            )
          )
            return "protected";
          continuationIssued = true;
          const canContinue = () =>
            current() && canonical(expected) && leader!.isApplied(expected);
          if (leader!.complete) {
            leader!.complete([...messages], canContinue);
            return observeCommandCompletion();
          }
          if (!(await leader!.continue!(messages, canContinue)))
            return "unknown";
        } else return await releaseFollower(intent);
        if (!current()) return "unknown";
        released = true;
        return "released";
      } catch (error) {
        input.recordRuntimeEvent?.("telegram", error, {
          phase: "live-rebind-routing",
        });
        return "unknown";
      } finally {
        advancing = false;
      }
    },
  };
}

/** One admitted Restore attempt through recipient readiness, never source dispatch or cleanup. */
export async function advanceTelegramWorkspaceRestore(input: {
  request: Threads.TelegramWorkspaceRestoreRequest;
  authority: Threads.TelegramWorkspaceRestoreAuthority;
  restoreStore: Threads.TelegramWorkspaceRestore;
  getRecipient: () => Threads.TelegramWorkspaceRestoreRecipient | undefined;
  /** Adapter proves current canonical ownership and authenticates observations; apply needs a fresh issuance. */
  runRecipient: (input: {
    intent: Threads.TelegramWorkspaceRestoreIntent;
    mode: "apply" | "inspect";
    isCurrent: () => boolean;
  }) => Promise<
    | {
        operationId: string;
        recipient: Threads.TelegramWorkspaceRestoreRecipient;
        target: Threads.TelegramWorkspaceRestoreRequest["target"];
        slot: string;
        ready: boolean;
      }
    | undefined
  >;
  /**
   * Recovery for a same-session successor already on the relocated target: it may receive the first grant, but only
   * read-only inspection runs. It never commits a new relocation or applies a target.
   */
  inspectOnly?: true;
}): Promise<Threads.TelegramWorkspaceRestoreIntent | undefined> {
  const isCurrent = input.authority.isCurrent.bind(input.authority);
  if (!isCurrent()) return undefined;
  const request = structuredClone(input.request);
  if (!Threads.isTelegramWorkspaceRestoreRequest(request)) return undefined;
  const getRecipient = input.getRecipient;
  const runRecipient = input.runRecipient;
  const observedRecipient = getRecipient();
  if (
    !Threads.isTelegramWorkspaceRestoreRecipient(observedRecipient) ||
    observedRecipient.sessionId !== request.binding.sessionId
  )
    return undefined;
  const recipient = structuredClone(observedRecipient);
  const executor = structuredClone(input.authority.executor);
  const operatorUserId = input.authority.operatorUserId;
  const current = (): boolean =>
    isCurrent() &&
    input.authority.operatorUserId === operatorUserId &&
    isDeepStrictEqual(input.authority.executor, executor) &&
    isDeepStrictEqual(getRecipient(), recipient);
  const authority = { executor, operatorUserId, isCurrent: current };
  const { restoreStore } = input;
  const retained = (): Threads.TelegramWorkspaceRestoreIntent | undefined => {
    if (!current()) return undefined;
    const found = restoreStore
      .list()
      .find((value) => value.request.operationId === request.operationId);
    return current() &&
      found &&
      isDeepStrictEqual(found.request, request) &&
      found.operatorUserId === operatorUserId &&
      isDeepStrictEqual(found.executor, executor)
      ? found
      : undefined;
  };
  let intent = retained();
  const predecessor = intent
    ? undefined
    : restoreStore
        .list()
        .find((value) => value.request.operationId === request.operationId);
  if (
    predecessor &&
    current() &&
    isDeepStrictEqual(predecessor.request, request) &&
    predecessor.operatorUserId === operatorUserId &&
    !isDeepStrictEqual(predecessor.executor, executor)
  ) {
    // Adoption transfers executor authority only. Issued grants stay issued, so a successor can merely inspect them.
    try {
      intent = restoreStore.adopt(predecessor, authority);
    } catch (error) {
      intent = retained();
      if (!intent) throw error;
    }
    if (!current() || !intent) return undefined;
    intent = retained();
    if (!intent) return undefined;
  }
  if (input.inspectOnly && !intent) return undefined;
  if (!intent || intent.phase === "relocated") {
    if (
      (!input.inspectOnly &&
        recipient.instanceId !== request.owner.instanceId) ||
      recipient.kind !==
        (request.owner.owner?.kind === "leader" ? "leader" : "follower")
    )
      return undefined;
    intent = await restoreStore.commit(request, authority);
    if (!current() || !intent) return undefined;
  }
  let mode: "apply" | "inspect" = "inspect";
  if (intent.phase === "relocated") {
    try {
      const issuance = restoreStore.issueRecipient(
        intent,
        recipient,
        authority,
      );
      if (issuance) {
        intent = issuance.intent;
        mode = input.inspectOnly ? "inspect" : "apply";
      } else intent = retained();
    } catch (error) {
      intent = retained();
      if (intent?.phase !== "recipient-issued") throw error;
      // A retained issued phase is not a fresh grant, even when publication's reply was lost.
    }
  }
  if (
    !current() ||
    !intent ||
    !["recipient-issued", "ready"].includes(intent.phase) ||
    (mode === "apply" && !isDeepStrictEqual(intent.recipient, recipient))
  )
    return undefined;
  const expected = structuredClone(intent);
  if (!isDeepStrictEqual(retained(), expected)) return undefined;
  const observation = await runRecipient({
    intent: structuredClone(expected),
    mode,
    isCurrent: current,
  });
  if (
    !current() ||
    !isDeepStrictEqual(retained(), expected) ||
    !observation ||
    observation.ready !== true ||
    observation.operationId !== request.operationId ||
    !isDeepStrictEqual(observation.recipient, recipient) ||
    !isDeepStrictEqual(observation.target, request.target) ||
    observation.slot !== request.binding.slot
  )
    return undefined;
  if (
    expected.phase === "ready" &&
    isDeepStrictEqual(expected.readyRecipient ?? expected.recipient, recipient)
  )
    return retained();
  try {
    intent =
      mode === "inspect"
        ? restoreStore.confirmInspectedReady(expected, recipient, authority)
        : restoreStore.confirmReady(expected, recipient, authority);
  } catch (error) {
    intent = retained();
    if (
      intent?.phase !== "ready" ||
      !isDeepStrictEqual(intent.readyRecipient ?? intent.recipient, recipient)
    )
      throw error;
  }
  const confirmed = retained();
  return current() &&
    confirmed?.phase === "ready" &&
    isDeepStrictEqual(
      confirmed.readyRecipient ?? confirmed.recipient,
      recipient,
    )
    ? confirmed
    : undefined;
}

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
    isCleanupTargetProtected: Threads.createTelegramCleanupTargetProtection(
      deps.threadStore,
    ),
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

export const TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS = 60 * 60_000;
/** The toast for expired or previous-process routing controls; the chooser notice is written separately. */
export const TELEGRAM_ROUTING_CHOICE_EXPIRED = "Routing choice expired";
/** Every temporary routing tab carries this name, whether the bot created it or adopted Telegram's native tab. */
const TELEGRAM_TEMPORARY_THREAD_NAME = "🚦 Routing";
/** A mobile client's native tab creation precedes the All input it is named after by about a second. */
const TELEGRAM_IMPLICIT_ALL_INPUT_WINDOW_SEC = 10;

export function isTelegramAllTabCommandExpired(
  message: { date?: number; message_thread_id?: number },
  nowMs = Date.now(),
): boolean {
  return (
    message.message_thread_id === undefined &&
    typeof message.date === "number" &&
    Number.isFinite(message.date) &&
    message.date > 0 &&
    Number.isFinite(nowMs) &&
    nowMs - message.date * 1000 >= TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS
  );
}

export type TelegramRoutedMessage = {
  date?: number;
} & Updates.TelegramUpdateMessage &
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

/** Fenced temporary-Thread authority; see `captureTemporaryThreadAuthority`. */
interface TemporaryThreadAuthority {
  store: Threads.TelegramWorkspaceRestore;
  operatorUserId: number;
  journalBindingKey: string;
  epoch: number | string;
  authority: Threads.TelegramWorkspaceRestoreAuthority;
  isCurrent: () => boolean;
  adopt: (
    entry: Threads.TelegramTemporaryThreadEntry,
  ) => Threads.TelegramTemporaryThreadEntry | undefined;
}

export interface TelegramInboundRouteRuntimeDeps<
  TMessage extends TelegramRoutedMessage,
  TCallbackQuery extends TelegramRoutedCallbackQuery,
  TContext,
  TModel extends Model.MenuModel,
> {
  configStore: Pick<
    TelegramConfigStore,
    "get" | "getAllowedUserId" | "persistAllowedUserId" | "persist"
  > & { set?: TelegramConfigStore["set"] };
  callApi?: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  getCurrentInstanceId?: () => string | undefined;
  getAdmissionScope?: () => string | undefined;
  getAdmissionJournalBinding?: () => string | undefined;
  getMessageOwnership?: Updates.TelegramMessageOwnershipLookup;
  getTargetOwnership?: Updates.TelegramTargetOwnershipLookup;
  recordMessageOwnership?: Updates.TelegramMessageOwnershipRecorder;
  getLiveThreadTargets?: () => Queue.TelegramQueueTarget[];
  getDisplayTitle?: Threads.TelegramCurrentThreadAssembly["getDisplayTitle"];
  getLocalThreadLabelForTarget?: (
    target: Queue.TelegramQueueTarget,
  ) => string | undefined;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  setCurrentLeaderIdentity?: (identity: {
    target: Queue.TelegramQueueTarget;
    slot?: string;
    threadName?: string;
  }) => void;
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
  getWorkspaceRestoreStore?: () => Threads.TelegramWorkspaceRestore | undefined;
  captureWorkspaceExternalProtection?: ReturnType<
    typeof createTelegramWorkspaceExternalProtectionCapture
  >;
  /** Strict committed abandonment plus retained original; shared by Restore and temporary-input cancellation. */
  inspectRestoreSourceAbandonment?: (
    updateId: number,
    journalBindingKey: string,
  ) => Threads.TelegramTemporaryThreadCancellationEvidence | undefined;
  inspectRoutingInputGroupExpiry?: (
    input: Threads.TelegramTemporaryThreadInput,
  ) =>
    readonly Threads.TelegramTemporaryThreadCancellationEvidence[] | undefined;
  /** Strict active-journal observation only; a hint or missing source never substitutes for this ACK. */
  inspectRestoreSourceCompletion?: (
    expected: Updates.TelegramDeferredSourceEvidence & {
      completionSha256: string;
    },
  ) =>
    | (Updates.TelegramDeferredSourceEvidence & { completionSha256: string })
    | undefined;
  inspectRestoreQueuedReceipt?: (
    expected: TelegramUpdateJournalQueuedCompletion & {
      journalBindingKey: string;
    },
  ) => TelegramUpdateJournalQueuedReceiptEvidence | undefined;
  hasWorkspaceRestoreAuthority?: () => boolean;
  /** Exact live root authority; capability advertisement alone cannot replace owned profile/session/recipient fences. */
  hasWorkspaceLiveRebindAuthority?: () => boolean;
  /** Strict complete namespace plus exact current/historical references; only an empty result clears journal protection. */
  inspectTemporaryThreadSources?: (
    target: Queue.TelegramQueueTarget,
    requiredJournalBindingKeys: readonly string[],
    ownInputs?: readonly Threads.TelegramTemporaryThreadInput[],
  ) => readonly number[] | undefined;
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
    observeLeaderWork?: (
      oldTarget: Queue.TelegramQueueTarget & { threadId: number },
      ctx: TContext,
    ) => Bus.TelegramBusLiveRebindWorkState;
    followerRegistry: Pick<Bus.TelegramBusFollowerRegistry, "get" | "register">;
    runFollower: ReturnType<
      typeof Bus.createTelegramBusWorkspaceRestoreController
    >;
    liveFollower?: {
      /** Pure trusted assembly availability (Commands/native/menu and local protocol), never future target activation. */
      isSelectedCommandAvailable?(
        follower: Readonly<Bus.TelegramBusFollowerView>,
        name: string,
      ): boolean;
      /** Exact session journal identity from the existing registration/journal owners, never the profile routing key. */
      getJournalBindingKey(
        follower: Bus.TelegramBusFollowerView,
      ): string | undefined;
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
  modelSwitchController: Model.TelegramModelSwitchController<
    TContext,
    Model.ScopedTelegramModel<TModel>
  >;
  menuActions: Menu.TelegramMenuActionRuntime<TContext, TModel>;
  /** Thinking controls refuse while the active Telegram turn expects a voice reply. */
  isVoiceReplyActive?: () => boolean;
  updateSettingsMenuMessage?: (
    state: Menu.TelegramModelMenuState<TModel>,
    ctx: TContext,
  ) => Promise<void>;
  openQueueMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    threadId?: number,
    options?: Pick<TelegramApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  openSettingsMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    threadId?: number,
    options?: Pick<TelegramApiCallOptions, "assertAuthority">,
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
  invokeBoundButtonAction?: (
    action: OutboundHandlers.TelegramOutboundButtonAction,
    query: TCallbackQuery,
    ctx: TContext,
  ) => Promise<false | "new" | "edit">;
  inboundHandlerRuntime: TelegramInboundHandlerRuntime<TContext>;
  threadStore?: Threads.TelegramTopicTargetStore;
  runWorkspaceOperation?: <T>(
    input: {
      operationId: string;
      operationKind: string;
      scopes: readonly [{ kind: "profile" }];
    },
    operation: () => Promise<T>,
  ) => Promise<T>;
  updateStatus: (ctx: TContext, error?: string) => void;
  isContextActive?: (ctx: TContext) => boolean;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  requestNextDispatchAnnouncement?: () => void;
  cancelNextDispatchAnnouncement?: () => void;
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
    options?: Pick<TelegramApiCallOptions, "assertAuthority">,
  ) => Promise<void>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: Menu.TelegramReplyMarkup,
    options?: {
      target?: Queue.TelegramQueueTarget;
      assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    },
  ) => Promise<void>;
  editMessageReplyMarkup?: (
    chatId: number,
    messageId: number,
    replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup,
  ) => Promise<void>;
  sendInteractiveMessage?: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: Menu.TelegramReplyMarkup,
    options?: {
      target?: Queue.TelegramQueueTarget;
      replyToMessageId?: number;
      assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    },
  ) => Promise<number | undefined>;
  deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
  answerGuestQuery: (guestQueryId: string, text?: string) => Promise<void>;
  /** Answers the guest query immediately and returns its inline message id. */
  answerGuestQueryForInlineMessage?: (
    guestQueryId: string,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<string | undefined>;
  /** Starts the animated placeholder on an answered guest inline message. */
  startGuestPlaceholder?: (inlineMessageId: string) => void;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: {
      parseMode?: "HTML";
      target?: Queue.TelegramQueueTarget;
      assertAuthority?: TelegramApiCallOptions["assertAuthority"];
    },
  ) => Promise<number | undefined>;
  setMyCommands: Commands.TelegramBotCommandRegistrationDeps["setMyCommands"];
  /** Captures independent recipient authority, never the source execution or dialog handle. */
  captureThreadNameRecipientAuthority?: (
    target: Queue.TelegramQueueTarget,
    ctx: TContext,
  ) => (() => void) | undefined;
  validateThreadName?: (threadName: string) => string | undefined;
  renameCurrentThread?: Commands.TelegramThreadDisplayNameRenamePort;
  resetCurrentThreadName?: Commands.TelegramThreadDisplayNameResetPort;
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
  requestNewSession?: (source: unknown) => void;
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  beginCommandEffectWork?: Commands.TelegramCommandRuntimeDeps<
    TMessage,
    TContext
  >["beginCommandEffectWork"];
  sectionRegistry?: TelegramSectionRegistry;
  sendSectionRichMessage?: (
    chatId: number,
    message: TelegramInputRichMessage,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => Promise<number | undefined>;
}

const TELEGRAM_OWNED_CALLBACK_PREFIXES = [
  "allmenu:",
  TELEGRAM_UNBOUND_REROUTE_CALLBACK_PREFIX,
  TELEGRAM_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX,
  "compact:",
  "menu:",
  "model:",
  "new:",
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
): Updates.TelegramUpdateRuntimeController<TContext, TUpdate> & {
  expireRoutingInput: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["expireRoutingInput"]
  >;
  shouldReviewHistoricalInput: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["shouldReviewHistoricalInput"]
  >;
  shouldHoldPendingInput: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["shouldHoldPendingInput"]
  >;
  forgetPreviousWorld(
    input: Updates.TelegramHeldSourcePreparation<TContext>,
    captureTransport?: (ctx: TContext) => (() => boolean) | undefined,
  ): Promise<{ forgotten: number; deleted: number }>;
  beforeQueueReceiptPublished: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["beforeQueueReceiptPublished"]
  >;
  onQueueReceiptCommitted: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["onQueueReceiptCommitted"]
  >;
  onQueueReceiptCompleted: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["onQueueReceiptCompleted"]
  >;
  onUpdateCompleted: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["onUpdateCompleted"]
  >;
  onWorkspaceRestoreRecipientObserved(
    follower: Bus.TelegramBusFollowerView,
    isCurrent: () => boolean,
    ctx: TContext | undefined,
  ): Promise<void> | undefined;
  waitForRestoreSettlement(): Promise<void>;
  /** Commands-owned registry port for dormant scoped recipient assembly, not ordinary update replay. */
  prepareHeldCommand: ReturnType<
    typeof Commands.createTelegramCommandHandlerTargetRuntime<
      TMessage,
      TContext
    >
  >["prepareHeldCommand"];
  canPrepareHeldCommand: ReturnType<
    typeof Commands.createTelegramCommandHandlerTargetRuntime<
      TMessage,
      TContext
    >
  >["canPrepareHeldCommand"];
  /** Fresh body-free recipient observation only; never reconstructs an attempt or grants cleanup. */
  observeLiveRebindLeaderWork(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ): Promise<Bus.TelegramBusLiveRebindWorkObservation | undefined>;
  /** Fresh non-destructive candidate only; no retained idle, cleanup action or deletion grant. */
  prepareLiveRebindLeaderCleanup(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ): Promise<ThreadReconciler.TelegramLiveRebindCleanupPreparation | undefined>;
  /** Requires the authenticated peer's exact retained released carrier; never recreates save/apply/release. */
  prepareLiveRebindFollowerCleanup(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ): Promise<ThreadReconciler.TelegramLiveRebindCleanupPreparation | undefined>;
  /**
   * One cleanup attempt under fresh admission: a fresh clear sample, then the durable issue marker, one unretried
   * deletion and the terminal record. `not-ready` leaves the released row unissued; `undefined` is lost authority.
   */
  issueLiveRebindLeaderCleanup(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ): Promise<TelegramLiveRebindCleanupIssue | undefined>;
  issueLiveRebindFollowerCleanup(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ): Promise<TelegramLiveRebindCleanupIssue | undefined>;
  /** Coordinator-only prompt admission; caller retains Workspace/canonical and exact recipient authority. */
  continueLiveRebindPrompt(
    messages: readonly TMessage[],
    ctx: TContext,
    target: Queue.TelegramQueueTarget & { threadId: number },
    isCurrent: () => boolean,
  ): Promise<boolean>;
} {
  type PendingRerouteCleanup =
    | {
        kind: "unbound";
        target: { chatId: number; threadId: number };
        messageId?: number;
        temporaryThread?: Threads.TelegramTemporaryThreadEntry;
      }
    | {
        kind: "previous-leader";
        target: { chatId: number; threadId: number };
      }
    | {
        kind: "replaced-follower";
        target: { chatId: number; threadId: number };
        instanceId?: string;
      };
  type PendingUnboundReroute = {
    sourceTarget: Queue.TelegramQueueTarget;
    chooserMessageId?: number;
    rootChooserText?: string;
    messages: TMessage[];
    dispatchKind: "prompt" | "command";
    routingOperatorUserId?: number;
    expiresAtMs?: number;
    phase: PendingReroutePhase;
    workspaceRestore?: {
      operationId: string;
      record: Threads.TelegramTopicTargetRecord;
      messages: TMessage[];
    };
    liveRebind?: {
      record: Threads.TelegramTopicTargetRecord;
      messages: TMessage[];
      template?: {
        command: Commands.ParsedTelegramCommand;
        expandedSha256: string;
      };
      continueCommand?: Commands.ParsedTelegramCommand;
      menuCommand?: Commands.ParsedTelegramCommand;
      abortCommand?: Commands.ParsedTelegramCommand;
      nextCommand?: Commands.ParsedTelegramCommand;
      stopCommand?: Commands.ParsedTelegramCommand;
      helpCommand?: Commands.ParsedTelegramCommand;
      nameCommand?: Commands.ParsedTelegramCommand;
      confirmationCommand?: Commands.ParsedTelegramCommand;
      extensionCommand?: Commands.ParsedTelegramCommand;
      extensionKind?: Commands.PreparedSelectedCommand["kind"];
      coordinator?: ReturnType<typeof createTelegramLiveRebindCoordinator>;
      isCurrent?: () => boolean;
    };
    /** The acknowledged tab presenting an All source; `sourceTarget` is this tab, not the original's location. */
    temporaryThread?: Threads.TelegramTemporaryThreadEntry;
    /** Source copies left in All (a menu-picked command); deleted once, when the input is consumed. */
    allTabCopies?: number[];
    /** Acknowledged same-tab membership stays protective when its reader disappears; never a dispatch/cleanup grant. */
    temporaryMembership?: true;
    /** Re-entrancy lock for one command route in flight; orthogonal to `phase`. */
    dispatching?: boolean;
    abandonment?: {
      ownerUserId: number;
      journalBindingKey: string;
      leaderEpoch: number | string;
      running?: boolean;
      attempted?: boolean;
      /** Per-source retention receipts; the chooser is cancelled once every source has one. */
      sourceResults?: Map<
        number,
        NonNullable<ReturnType<typeof Updates.abandonTelegramDeferredUpdate>>
      >;
    };
    pauseExpiry?: () => void;
    stopExpiry?: () => void;
  };
  /**
   * One chooser's routing progress. Every phase after `waiting` means a selection ran, so Cancel and sibling
   * retention no longer apply; `released` re-arms All-command expiry after a selection that routed nothing.
   */
  type PendingReroutePhase =
    | { kind: "waiting" }
    | { kind: "selected" }
    | { kind: "released" }
    /** Some Forward outcome is unknown; process-local, so restart-safe issuance remains a release gate. */
    | { kind: "forward-unknown" }
    | { kind: "cleanup"; cleanup: PendingRerouteCleanup }
    | { kind: "finalizing"; message: string };
  /** The command a chooser routes, read from its own source exactly as the root heading named it. */
  const getPendingRerouteCommandName = (
    pending: PendingUnboundReroute,
  ): string | undefined =>
    pending.dispatchKind === "command"
      ? Commands.parseTelegramCommand(
          Media.extractFirstTelegramMessageText(pending.messages).trim(),
        )?.name
      : undefined;
  /** Untouched by selection or dispatch, so the owner may still cancel and Restore may retain it. */
  const isPendingRerouteUntouched = (pending: PendingUnboundReroute): boolean =>
    pending.phase.kind === "waiting" && !pending.dispatching;
  /** A frozen destination pauses All-command expiry until routing finishes or releases it. */
  const isPendingRerouteDestinationHeld = (
    pending: PendingUnboundReroute,
  ): boolean =>
    pending.phase.kind !== "waiting" && pending.phase.kind !== "released";
  const pendingUnboundReroutes = new Map<string, PendingUnboundReroute>();
  const implicitThreadCreations = new Map<
    string,
    {
      ctx: TContext;
      updateId: number;
      operatorUserId: number;
      journalBindingKey: string;
      executor: Threads.TelegramWorkspaceRestoreExecutor;
      generation: number | undefined;
      scope: string | undefined;
      target: { chatId: number; threadId: number };
      name: string;
      createdAtSec: number;
    }
  >();
  const guidedUnboundTopicKeys = new Set<string>();
  let nextUnboundRerouteId = 0;
  type RecoverySource =
    Updates.TelegramDeferredAbandonmentRecoveryPage["sources"][number];
  type CancellationReview = {
    id: string;
    target: Queue.TelegramQueueTarget;
    messageId: number;
    ownerUserId: number;
    journalBindingKey: string;
    isCurrent: () => boolean;
    running?: boolean;
    nextAfterUpdateId?: number;
    unsupported: boolean;
    sources: Array<
      RecoverySource & {
        preview: string;
        result?: NonNullable<ReturnType<RecoverySource["retry"]>>;
      }
    >;
  };
  let cancellationReview: CancellationReview | undefined;
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
  const resolveTelegramThreadLabel = (message: {
    chat: { id: number };
    message_thread_id?: number;
  }): string | undefined => {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;
    if (!threadId) return undefined;
    const localLabel =
      deps.getDisplayTitle?.({ chatId, threadId }) ??
      deps.getLocalThreadLabelForTarget?.({ chatId, threadId });
    if (localLabel) return localLabel;
    if (!deps.threadStore) return undefined;
    const records = deps.threadStore.list();
    const currentInstanceId = deps.getCurrentInstanceId?.();
    for (const record of records) {
      if (
        record.target.chatId !== chatId ||
        record.target.threadId !== threadId
      ) {
        continue;
      }
      if (
        currentInstanceId &&
        record.instanceId &&
        record.instanceId !== currentInstanceId
      ) {
        continue;
      }
      return record.threadName &&
        ThreadNaming.isTelegramTopicThreadNameValidForSlot(
          record.threadName,
          record.slot,
        )
        ? record.threadName
        : getRestoredThreadName(record, record.slot ?? "");
    }
    return undefined;
  };
  const createAdmissionReceipts = (
    queueKind: Queue.TelegramQueueItemKind,
    sources: readonly unknown[],
  ): Queue.TelegramQueueAdmissionReceipt[] => {
    const sourceUpdateIds =
      Updates.collectTelegramAdmissionSourceUpdateIds(sources);
    if (sourceUpdateIds.length === 0) return [];
    const receipt = Queue.createTelegramQueueAdmissionReceipt({
      queueKind,
      scope: deps.getAdmissionScope?.() ?? "",
      sourceUpdateIds,
    });
    const journalBindingKey = deps.getAdmissionJournalBinding?.();
    return receipt
      ? [
          {
            ...receipt,
            ...(journalBindingKey ? { journalBindingKey } : {}),
          },
        ]
      : [];
  };
  const reportQueueAdmission = (
    sources: readonly unknown[],
    receipts: readonly Queue.TelegramQueueAdmissionReceipt[],
  ): void => {
    Updates.reportTelegramQueueAdmission(sources, receipts);
  };
  const removePendingReroute = (id: string): void => {
    pendingUnboundReroutes.get(id)?.stopExpiry?.();
    pendingUnboundReroutes.delete(id);
  };
  const expirePendingCommand = (
    id: string,
    pending: PendingUnboundReroute,
  ): boolean => {
    if (
      isPendingRerouteDestinationHeld(pending) ||
      pending.expiresAtMs === undefined ||
      Date.now() < pending.expiresAtMs
    )
      return false;
    if (pendingUnboundReroutes.get(id) !== pending) return true;
    for (const message of pending.messages)
      Updates.reportTelegramUpdateCompleted(message);
    removePendingReroute(id);
    return true;
  };
  const armPendingCommandExpiry = (
    id: string,
    pending: PendingUnboundReroute,
  ): void => {
    if (
      pending.dispatchKind !== "command" ||
      pending.sourceTarget.threadId !== undefined
    )
      return;
    pending.stopExpiry?.();
    const execution = Updates.getTelegramUpdateExecutionFence(
      pending.messages[0],
    );
    const onAbort = () => removePendingReroute(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    pending.pauseExpiry = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    pending.stopExpiry = () => {
      stopped = true;
      pending.pauseExpiry?.();
      execution?.signal.removeEventListener("abort", onAbort);
    };
    execution?.signal.addEventListener("abort", onAbort, { once: true });
    if (execution?.signal.aborted) {
      onAbort();
      return;
    }
    if (pending.expiresAtMs === undefined) {
      const date = pending.messages[0]?.date;
      if (
        typeof date !== "number" ||
        !Number.isFinite(date) ||
        date <= 0 ||
        date * 1000 > Date.now()
      )
        return;
      pending.expiresAtMs = date * 1000 + TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS;
    }
    const schedule = (): void => {
      if (
        stopped ||
        isPendingRerouteDestinationHeld(pending) ||
        pendingUnboundReroutes.get(id) !== pending
      )
        return;
      if (expirePendingCommand(id, pending)) return;
      const delay = Math.min(
        TELEGRAM_ALL_TAB_COMMAND_MAX_AGE_MS,
        pending.expiresAtMs! - Date.now(),
      );
      timer = setTimeout(schedule, Math.max(1, delay));
      timer.unref?.();
    };
    schedule();
  };
  const prunePendingCommandReroutes = () => {
    // Deferred prompts and selected routes with cleanup work must retain their control.
    // Age is not settlement; the chooser capacity limit still bounds retained entries.
    for (const [id, entry] of pendingUnboundReroutes) {
      if (
        entry.dispatchKind === "command" &&
        entry.sourceTarget.threadId === undefined
      ) {
        expirePendingCommand(id, entry);
      }
    }
  };
  const storePendingUnboundReroute = (
    messages: TMessage[],
    dispatchKind: "prompt" | "command" = "prompt",
    presentationTarget?: { chatId: number; threadId: number },
  ): string => {
    prunePendingCommandReroutes();
    if (pendingUnboundReroutes.size >= 100) {
      throw new Error(
        "Telegram route chooser capacity reached; source remains retryable.",
      );
    }
    nextUnboundRerouteId += 1;
    const id = nextUnboundRerouteId.toString(36);
    pendingUnboundReroutes.set(id, {
      sourceTarget: presentationTarget
        ? { ...presentationTarget }
        : {
            chatId: messages[0]!.chat.id,
            ...(typeof messages[0]!.message_thread_id === "number"
              ? { threadId: messages[0]!.message_thread_id }
              : {}),
          },
      messages,
      dispatchKind,
      phase: { kind: "waiting" },
    });
    const pending = pendingUnboundReroutes.get(id)!;
    armPendingCommandExpiry(id, pending);
    return id;
  };
  const rememberRerouteChooser = (
    id: string,
    messageId: number | undefined,
  ): void => {
    const pending = pendingUnboundReroutes.get(id);
    if (!pending) return;
    pending.chooserMessageId = messageId;
    if (Number.isSafeInteger(messageId) && messageId! > 0) {
      const owner = deps.configStore.getAllowedUserId();
      if (
        owner !== undefined &&
        pending.messages.every(
          (source) =>
            source.from?.id === owner &&
            !source.from.is_bot &&
            source.chat.type === "private",
        )
      ) {
        try {
          const lifetime = Updates.armTelegramRoutingInputs(
            pending.messages,
            owner,
            {
              chatId: pending.sourceTarget.chatId,
              ...(pending.sourceTarget.threadId !== undefined
                ? { threadId: pending.sourceTarget.threadId }
                : {}),
              messageId: messageId!,
            },
          );
          if (lifetime) pending.routingOperatorUserId = lifetime.operatorUserId;
        } catch (error) {
          deps.recordRuntimeEvent?.("routing", error, {
            phase: "routing-input-clock",
          });
        }
      }
    }
    if (
      messageId === undefined ||
      pending.dispatchKind !== "command" ||
      pending.sourceTarget.threadId !== undefined ||
      pending.phase.kind !== "waiting"
    )
      return;
    const source = pending.messages[0];
    const text = source?.text?.trim();
    const execution = Updates.getTelegramUpdateExecutionFence(source);
    const sourceIds = Updates.collectTelegramAdmissionSourceUpdateIds(
      pending.messages,
    );
    if (
      !text ||
      Commands.parseTelegramCommand(text)?.name !== "start" ||
      source?.from?.id === undefined ||
      !execution?.isCurrent() ||
      sourceIds.length !== 1 ||
      expirePendingCommand(id, pending)
    )
      return;
    for (const [oldId, old] of pendingUnboundReroutes) {
      if (
        oldId === id ||
        old.dispatchKind !== "command" ||
        !isPendingRerouteUntouched(old) ||
        old.sourceTarget.threadId !== undefined ||
        old.sourceTarget.chatId !== pending.sourceTarget.chatId
      )
        continue;
      const oldSource = old.messages[0];
      const oldIds = Updates.collectTelegramAdmissionSourceUpdateIds(
        old.messages,
      );
      if (
        oldSource?.from?.id !== source.from.id ||
        oldSource?.text?.trim() !== text ||
        oldIds.length !== 1 ||
        oldIds[0]! >= sourceIds[0]! ||
        Updates.getTelegramUpdateExecutionFence(oldSource)?.signal !==
          execution.signal
      )
        continue;
      if (Updates.reportTelegramUpdateCompleted(oldSource))
        removePendingReroute(oldId);
    }
  };
  const matchesRerouteChooser = (
    pending: PendingUnboundReroute,
    query: TCallbackQuery,
  ): boolean => {
    const message = query.message;
    return (
      !!message &&
      pending.chooserMessageId !== undefined &&
      message.message_id === pending.chooserMessageId &&
      message.chat.id === pending.sourceTarget.chatId &&
      (message.message_thread_id === undefined ||
        message.message_thread_id === pending.sourceTarget.threadId)
    );
  };
  const pendingUnboundRerouteMediaGroups = new Map<
    string,
    {
      messages: TMessage[];
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const threadNameDialog = ThreadNaming.createTelegramThreadNameDialogRuntime();
  const getThreadNameDialogScope = () =>
    deps.getCurrentInstanceId?.() ?? "local";
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
    sendSectionRichMessage: deps.sendSectionRichMessage,
    deleteMessage: deps.deleteMessage,
    isVoiceReplyActive: deps.isVoiceReplyActive,
    enqueueSectionPrompt: async (
      prompt: string,
      ctx: TContext,
      target?: Queue.TelegramQueueTarget,
      source?: unknown,
    ) => {
      const chatId = target?.chatId ?? deps.configStore.getAllowedUserId();
      if (typeof chatId !== "number") return;
      const order = deps.bridgeRuntime.queue.allocateItemOrder();
      const admissionReceipts = createAdmissionReceipts(
        "prompt",
        source === undefined ? [] : [source],
      );
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
        ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
      };
      deps.queueMutationRuntime.append(turn, ctx);
      reportQueueAdmission(
        source === undefined ? [] : [source],
        admissionReceipts,
      );
      deps.updateStatus(ctx);
      requestDispatchNextQueuedTelegramTurn(ctx);
    },
  });
  const cloneTelegramMessagesForThread = (
    messages: TMessage[],
    threadId: number,
  ): TMessage[] => {
    return messages.map((message) =>
      Updates.carryTelegramUpdateExecutionFence(message, {
        ...message,
        message_id: 0,
        message_thread_id: threadId,
        reply_to_message: undefined,
      } as TMessage),
    );
  };
  /** Whether a chooser is still pending in this Thread, ignoring the ones the caller itself owns. */
  const hasPendingRerouteForTarget = (
    target: Queue.TelegramQueueTarget,
    own?: (pending: PendingUnboundReroute) => boolean,
  ): boolean =>
    [...pendingUnboundReroutes.values()].some(
      (pending) =>
        pending.sourceTarget.chatId === target.chatId &&
        pending.sourceTarget.threadId === target.threadId &&
        !own?.(pending),
    );
  const isOwnTemporaryChooser =
    (entry: Threads.TelegramTemporaryThreadEntry) =>
    (pending: PendingUnboundReroute): boolean =>
      pending.temporaryThread?.token === entry.token &&
      isDeepStrictEqual(pending.temporaryThread.source, entry.source);
  const hasOtherTemporaryThreadReroute = (
    target: Queue.TelegramQueueTarget,
    own: Threads.TelegramTemporaryThreadEntry,
  ): boolean => hasPendingRerouteForTarget(target, isOwnTemporaryChooser(own));
  const applyThreadCleanupPlan = async (
    plan: ThreadReconciler.ThreadReconciliationPlan,
    assertExecutionCurrent?: () => void,
    restoreCleanup?: Threads.TelegramWorkspaceRestoreIntent,
    temporaryCleanup?: Threads.TelegramTemporaryThreadEntry,
  ): Promise<boolean> => {
    assertExecutionCurrent?.();
    if (
      (restoreCleanup && restoreCleanup.routing?.cleanup !== "issued") ||
      (temporaryCleanup && !temporaryCleanup.cleanupIssued)
    )
      return false;
    let protectedTarget = false,
      temporaryDeleteConfirmed = false,
      temporaryTransportUncertain = false;
    deps.recordThreadReconciliationPlan?.(plan);
    const result = await ThreadReconciler.applyThreadReconciliationPlan(plan, {
      skipCloseBeforeDelete: (temporaryCleanup?.target?.chatId ?? 0) > 0,
      isCleanupTargetProtected(target) {
        assertExecutionCurrent?.();
        // A tab's first source is not authority over sibling choosers, including unsettled cleanup-only work.
        const siblingProtected =
          !!temporaryCleanup &&
          hasOtherTemporaryThreadReroute(target, temporaryCleanup);
        const lostTemporaryGrant =
          !!temporaryCleanup &&
          !deps
            .getWorkspaceRestoreStore?.()
            ?.listTemporaryThreads()
            .some((entry) => isDeepStrictEqual(entry, temporaryCleanup));
        const protectedNow =
          temporaryTransportUncertain ||
          lostTemporaryGrant ||
          siblingProtected ||
          isRerouteTargetProtected(target, restoreCleanup, temporaryCleanup);
        protectedTarget ||= protectedNow;
        return protectedNow;
      },
      callApi:
        temporaryCleanup && deps.callApi
          ? async <TResponse>(
              method: string,
              body: Record<string, unknown>,
            ): Promise<TResponse> => {
              try {
                assertExecutionCurrent?.();
                const result = await deps.callApi!<TResponse>(method, body, {
                  maxAttempts: 1,
                  retrySafety: "non-idempotent",
                });
                assertExecutionCurrent?.();
                if (result !== true)
                  throw new Error(
                    "Temporary Thread cleanup lacks a positive API acknowledgement.",
                  );
                if (method === "deleteForumTopic")
                  temporaryDeleteConfirmed = true;
                return result;
              } catch (error) {
                temporaryTransportUncertain = true;
                throw error;
              }
            }
          : deps.callApi,
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
    assertExecutionCurrent?.();
    return (
      !protectedTarget &&
      (!temporaryCleanup || temporaryDeleteConfirmed) &&
      (result.incompleteActions?.length ?? 0) === 0
    );
  };
  const findCreatedTemporaryThread = (
    target: Queue.TelegramQueueTarget,
  ): Threads.TelegramTemporaryThreadEntry | undefined => {
    try {
      return deps
        .getWorkspaceRestoreStore?.()
        ?.listTemporaryThreads()
        .find(
          (value) =>
            value.phase === "created" &&
            isDeepStrictEqual(value.target, target),
        );
    } catch {
      return undefined;
    }
  };
  /**
   * One fenced capture of leader epoch, operator, journal binding and context for a temporary-Thread effect. `isCurrent`
   * re-reads every captured fact (plus an optional extra fence) at each boundary, so a delayed effect keeps the identity it
   * was scheduled under; `adopt` re-keys an entry to this executor before a write.
   */
  const captureTemporaryThreadAuthority = (
    ctx: TContext,
    extra?: () => boolean,
  ): TemporaryThreadAuthority | undefined => {
    const store = deps.getWorkspaceRestoreStore?.();
    const instanceId = deps.getCurrentInstanceId?.(),
      epoch = deps.getCurrentLeaderEpoch?.();
    const operatorUserId = deps.configStore.getAllowedUserId(),
      journalBindingKey = deps.getAdmissionJournalBinding?.();
    const generation = deps.getSessionGeneration?.(),
      scope = deps.getAdmissionScope?.();
    if (
      !store ||
      !instanceId ||
      epoch === undefined ||
      operatorUserId === undefined ||
      !journalBindingKey
    )
      return undefined;
    const isCurrent = (): boolean =>
      deps.isContextActive?.(ctx) === true &&
      deps.getCurrentInstanceId?.() === instanceId &&
      deps.getSessionGeneration?.() === generation &&
      deps.getAdmissionScope?.() === scope &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      deps.configStore.getAllowedUserId() === operatorUserId &&
      deps.getAdmissionJournalBinding?.() === journalBindingKey &&
      (extra?.() ?? true);
    const authority = {
      executor: { instanceId, leaderEpoch: String(epoch) },
      operatorUserId,
      isCurrent,
    };
    return {
      store,
      operatorUserId,
      journalBindingKey,
      epoch,
      authority,
      isCurrent,
      adopt: (entry) =>
        isDeepStrictEqual(entry.executor, authority.executor)
          ? entry
          : store.adoptTemporaryThread(entry, authority),
    };
  };
  const isTemporaryTabTarget = (
    target: Queue.TelegramQueueTarget | undefined,
  ): boolean => !!target && findCreatedTemporaryThread(target) !== undefined;
  /** Restore may choose one input only when every other known group is cancelled or a live unassigned chooser that can be retained. */
  const areTemporaryThreadSiblingsAccountedForRestore = (
    entry: Threads.TelegramTemporaryThreadEntry,
    from: PendingUnboundReroute,
  ): boolean => {
    const target = entry.target;
    if (!target) return false;
    const group = {
      journalBindingKey: entry.source.journalBindingKey,
      updateIds: Updates.collectTelegramAdmissionSourceUpdateIds(from.messages),
    };
    const inputs = Threads.getTelegramTemporaryThreadInputs(entry),
      resolved = [
        ...(entry.cancelledInputs ?? []),
        ...(entry.completedInputs ?? []),
      ];
    if (
      !inputs.some((input) => isDeepStrictEqual(input, group)) ||
      resolved.some((input) => isDeepStrictEqual(input, group))
    )
      return false;
    const others = [...pendingUnboundReroutes.values()].filter(
      (pending) =>
        pending !== from &&
        pending.sourceTarget.chatId === target.chatId &&
        pending.sourceTarget.threadId === target.threadId,
    );
    const groupOf = (pending: PendingUnboundReroute) => ({
      journalBindingKey: entry.source.journalBindingKey,
      updateIds: Updates.collectTelegramAdmissionSourceUpdateIds(
        pending.messages,
      ),
    });
    if (
      !others.every(
        (pending) =>
          !!pending.abandonment &&
          !isPendingRerouteCancelled(pending) &&
          isPendingRerouteUntouched(pending) &&
          !pending.workspaceRestore &&
          !entry.forwardedInputs?.some((input) =>
            isDeepStrictEqual(input, groupOf(pending)),
          ) &&
          inputs.some((input) => isDeepStrictEqual(input, groupOf(pending))),
      )
    )
      return false;
    return inputs.every(
      (input) =>
        isDeepStrictEqual(input, group) ||
        resolved.some((other) => isDeepStrictEqual(other, input)) ||
        others.some((pending) => isDeepStrictEqual(groupOf(pending), input)),
    );
  };
  const isRerouteTargetProtected = (
    target: Queue.TelegramQueueTarget,
    ownRestore?: Threads.TelegramWorkspaceRestoreIntent,
    ownTemporary?: Threads.TelegramTemporaryThreadEntry,
    restoreFrom?: PendingUnboundReroute,
  ): boolean => {
    const matches = (candidate: Queue.TelegramQueueTarget): boolean =>
      candidate.chatId === target.chatId &&
      candidate.threadId === target.threadId;
    const activeTarget = deps.activeTurnRuntime.getTarget();
    if (
      (activeTarget && matches(activeTarget)) ||
      deps.telegramQueueStore
        .getQueuedItems()
        .some((item) => item.target && matches(item.target)) ||
      (deps.getLiveThreadTargets?.() ?? []).some(matches) ||
      (deps.threadStore?.list() ?? []).some((record) =>
        matches(record.target),
      ) ||
      (deps.threadStore?.listReservations() ?? []).some((record) =>
        matches(record.target),
      ) ||
      (deps.threadStore?.listPendingProvisions() ?? []).some(
        (record) => record.target && matches(record.target),
      )
    )
      return true;
    const store = deps.getWorkspaceRestoreStore?.();
    if (deps.getWorkspaceRestoreStore && !store) return true;
    let temporary: Threads.TelegramTemporaryThreadEntry[];
    try {
      temporary = store?.listTemporaryThreads() ?? [];
    } catch {
      return true;
    }
    // Only the source's own Forward/Cancel may remove its retained tab; adoption may have changed its executor.
    const ownTab = (entry: Threads.TelegramTemporaryThreadEntry): boolean =>
      !!ownTemporary &&
      entry.token === ownTemporary.token &&
      isDeepStrictEqual(entry.source, ownTemporary.source) &&
      isDeepStrictEqual(entry.target, ownTemporary.target);
    if (
      temporary.some(
        (entry) =>
          !!entry.target &&
          matches(entry.target) &&
          (!ownTab(entry) ||
            (Threads.getTelegramTemporaryThreadInputs(entry).length > 1 &&
              !Threads.isTelegramTemporaryThreadFullyResolved(entry) &&
              !(
                restoreFrom &&
                areTemporaryThreadSiblingsAccountedForRestore(
                  entry,
                  restoreFrom,
                )
              ))),
      )
    )
      return true;
    // Whole-tab cleanup after cancellation also needs a fresh census of retained arrivals no membership has seen.
    if (
      !restoreFrom &&
      temporary.some(
        (entry) =>
          ownTab(entry) &&
          !!(entry.cancelledInputs?.length || entry.completedInputs?.length),
      )
    ) {
      try {
        const required = [
          ...new Set(
            [
              deps.getAdmissionJournalBinding?.(),
              ownTemporary!.source.journalBindingKey,
              ...Threads.getTelegramTemporaryThreadInputs(ownTemporary!).map(
                (input) => input.journalBindingKey,
              ),
            ].filter((key): key is string => !!key),
          ),
        ];
        if (
          deps.inspectTemporaryThreadSources?.(
            { chatId: target.chatId, threadId: target.threadId! },
            required,
            Threads.getTelegramTemporaryThreadInputs(ownTemporary!),
          )?.length !== 0
        )
          return true;
      } catch {
        return true;
      }
    }
    const retained = store?.list() ?? [];
    // Exempt only the exact operation's old target. Cleanup itself also requires its issued grant.
    if (
      ownRestore &&
      (!matches(ownRestore.request.binding.target) ||
        !retained.some((intent) => isDeepStrictEqual(intent, ownRestore)))
    )
      return true;
    if (
      retained.some(
        (intent) =>
          (matches(intent.request.binding.target) ||
            matches(intent.request.target)) &&
          !(
            ownRestore &&
            isDeepStrictEqual(intent, ownRestore) &&
            matches(intent.request.binding.target)
          ),
      )
    )
      return true;
    if (!ownRestore) return false;
    let acceptedWorkClear = false;
    try {
      deps.threadStore?.withWorkspaceRestoreSnapshot(ownRestore, (snapshot) => {
        const bindings =
          snapshot.workspaceBindings?.filter(
            (binding) =>
              binding.bindingKey === ownRestore.request.binding.bindingKey,
          ) ?? [];
        if (bindings.length !== 1 || !deps.captureWorkspaceExternalProtection)
          return undefined;
        const binding = bindings[0]!;
        // Relocation does not erase predecessor references or prove where their work executes.
        const journalBindingKeys = [
          ...new Set([
            ...(ownRestore.request.binding.journalBindingKeys ?? []),
            ...(binding.journalBindingKeys ?? []),
          ]),
        ];
        const journalSources = [
          ...new Map(
            [
              ...(ownRestore.request.binding.journalSources ?? []),
              ...(binding.journalSources ?? []),
            ].map((source) => [
              JSON.stringify([source.sessionId, source.recipientBindingKey]),
              source,
            ]),
          ).values(),
        ];
        acceptedWorkClear =
          deps.captureWorkspaceExternalProtection(
            {
              ...binding,
              target: ownRestore.request.binding.target,
              journalBindingKeys,
              journalSources,
            },
            { requireBindingProvenance: true },
          ).acceptedWork === "clear";
        return undefined;
      });
    } catch (error) {
      acceptedWorkClear = false;
      deps.recordRuntimeEvent?.("telegram", error, {
        phase: "workspace-restore-protection",
      });
    }
    return !acceptedWorkClear;
  };
  /** Best-effort, once consumed: All keeps no copy of an input whose routing tab carried it; failure is only recorded. */
  const deleteAllTabMessages = async (
    chatId: number,
    messageIds: readonly number[],
  ): Promise<void> => {
    if (!deps.deleteMessage) return;
    for (const messageId of messageIds) {
      try {
        await deps.deleteMessage(chatId, messageId);
      } catch (error) {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "all-tab-source-delete",
          chatId,
          messageId,
        });
      }
    }
  };
  /** One-shot per chooser: the copies are taken before deletion, so a later consuming path finds none. */
  const deleteAllTabCopies = (pending: PendingUnboundReroute): Promise<void> =>
    deleteAllTabMessages(
      pending.sourceTarget.chatId,
      pending.allTabCopies?.splice(0) ?? [],
    );
  const dismissRerouteChooserMessage = async (
    query: TCallbackQuery,
    assertExecutionCurrent?: () => void,
  ): Promise<boolean> => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (
      typeof chatId !== "number" ||
      typeof messageId !== "number" ||
      !deps.deleteMessage
    ) {
      return false;
    }
    try {
      assertExecutionCurrent?.();
      await deps.deleteMessage(chatId, messageId);
      assertExecutionCurrent?.();
      return true;
    } catch (error) {
      assertExecutionCurrent?.();
      deps.recordRuntimeEvent?.("telegram", error, {
        phase: "reroute-chooser-delete",
        chatId,
        messageId,
        threadId: query.message?.message_thread_id,
      });
      return false;
    }
  };
  const closeReroutedUnboundTopic = async (
    target: { chatId: number; threadId: number } | undefined,
    messageId: number | undefined,
    assertExecutionCurrent?: () => void,
    ownTemporary?: Threads.TelegramTemporaryThreadEntry,
  ): Promise<boolean> => {
    if (!target || !deps.threadStore) return true;
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
    // A temporary grant licenses this tab only, not unrelated cleanup emitted by the general planner.
    const scoped = ownTemporary
      ? {
          ...plan,
          actions: plan.actions.filter(
            (action) =>
              action.kind === "close-delete-unbound-topic" &&
              isDeepStrictEqual(action.target, target),
          ),
        }
      : plan;
    return applyThreadCleanupPlan(
      scoped,
      assertExecutionCurrent,
      undefined,
      ownTemporary,
    );
  };
  const closePreviousLeaderThread = async (
    target: { chatId: number; threadId: number } | undefined,
    assertExecutionCurrent?: () => void,
    restoreCleanup?: Threads.TelegramWorkspaceRestoreIntent,
  ): Promise<boolean> => {
    if (!target || !deps.threadStore) return true;
    const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
    return applyThreadCleanupPlan(
      {
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
      },
      assertExecutionCurrent,
      restoreCleanup,
    );
  };
  const closeReplacedFollowerThread = async (
    target: { chatId: number; threadId: number } | undefined,
    instanceId: string | undefined,
    assertExecutionCurrent?: () => void,
    restoreCleanup?: Threads.TelegramWorkspaceRestoreIntent,
  ): Promise<boolean> => {
    if (!target || !deps.threadStore) return true;
    const currentLeaderEpoch = deps.getCurrentLeaderEpoch?.();
    return applyThreadCleanupPlan(
      {
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
      },
      assertExecutionCurrent,
      restoreCleanup,
    );
  };
  // Worker ACK observers outlive callback admission. Re-enter the existing Workspace gate;
  // never await this continuation while holding the dispatch invocation's gate.
  const restoreSettlementTasks = new Set<Promise<void>>();
  /**
   * After a Restore into a temporary tab reached positive terminal settlement, every still-unassigned sibling there is retained
   * privately and cancelled without Pi delivery. Missing proof, authority or abandonment leaves that sibling pending and the
   * tab's temporary entry protected; selected, queued, running or unknown work is never touched.
   */
  const disposeTemporaryThreadSiblingsAfterRestore = async (
    intent: Threads.TelegramWorkspaceRestoreIntent,
    ctx: TContext,
    restoreCurrent: () => boolean,
  ): Promise<void> => {
    const target = intent.request.target,
      cap = captureTemporaryThreadAuthority(ctx, restoreCurrent);
    const entry = findCreatedTemporaryThread(target);
    if (!cap || !entry || !entry.target || !cap.isCurrent()) return;
    const operatorUserId = intent.operatorUserId,
      journalBindingKey = intent.request.source.journalBindingKey;
    if (
      cap.operatorUserId !== operatorUserId ||
      cap.journalBindingKey !== journalBindingKey ||
      entry.operatorUserId !== operatorUserId ||
      entry.source.journalBindingKey !== journalBindingKey
    )
      return;
    const group = {
      journalBindingKey,
      updateIds: [...intent.request.source.updateIds],
    };
    if (
      !Threads.getTelegramTemporaryThreadInputs(entry).some((input) =>
        isDeepStrictEqual(input, group),
      )
    )
      return;
    for (const [id, pending] of [...pendingUnboundReroutes]) {
      const cancellation = pending.abandonment;
      if (
        pending.sourceTarget.chatId !== target.chatId ||
        pending.sourceTarget.threadId !== target.threadId ||
        pending.workspaceRestore?.operationId === intent.request.operationId ||
        !cancellation ||
        pending.messages.length === 0 ||
        isPendingRerouteCancelled(pending) ||
        cancellation.running
      )
        continue;
      const current = (): boolean =>
        cap.isCurrent() &&
        pendingUnboundReroutes.get(id) === pending &&
        pending.abandonment === cancellation &&
        isPendingRerouteUntouched(pending) &&
        !pending.workspaceRestore &&
        pending.messages.every(
          (source) =>
            Updates.getTelegramUpdateExecutionFence(source)?.signal.aborted ===
            false,
        ) &&
        cancellation.ownerUserId === operatorUserId &&
        cancellation.journalBindingKey === journalBindingKey;
      if (!current()) continue;
      cancellation.running = true;
      try {
        cancellation.attempted = true;
        if (!abandonPendingRerouteSources(pending, operatorUserId, current))
          continue;
        if (!recordCancelledTemporaryThreadInput(pending, ctx, current))
          continue;
        if (await retireCancellationChooser(id, pending, current))
          await deleteAllTabCopies(pending);
      } catch (error) {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "temporary-thread-restore-sibling",
          rerouteId: id,
        });
      } finally {
        cancellation.running = false;
      }
    }
    // The entry is released only after every sibling is gone and the Restore group's completion is the single uncancelled input.
    if (
      hasPendingRerouteForTarget(
        target,
        (pending) =>
          pending.workspaceRestore?.operationId === intent.request.operationId,
      ) ||
      !cap.isCurrent()
    )
      return;
    const fresh = findCreatedTemporaryThread(target),
      owned = fresh && cap.adopt(fresh);
    if (owned && cap.isCurrent())
      cap.store.retireTemporaryThread(owned, cap.authority, group);
  };
  const observeRestoreSettlement = (
    signal:
      | {
          kind: "source";
          evidence: Threads.TelegramWorkspaceRestoreSourceSettlement;
        }
      | {
          kind: "recipient";
          follower: Bus.TelegramBusFollowerView;
          isCurrent: () => boolean;
        },
    ctx: TContext,
  ): Promise<void> | undefined => {
    if (
      !deps.hasWorkspaceRestoreAuthority?.() ||
      !deps.runWorkspaceOperation ||
      !deps.getWorkspaceRestoreStore ||
      !deps.getSessionGeneration ||
      deps.isContextActive?.(ctx) === false
    )
      return;
    const evidence =
      signal.kind === "source" ? structuredClone(signal.evidence) : undefined;
    const follower =
      signal.kind === "recipient"
        ? structuredClone(signal.follower)
        : undefined;
    const recipientCurrent = (): boolean => {
      if (signal.kind !== "recipient" || !follower) return true;
      const live = deps.workspaceRestoreRecipient?.followerRegistry.get(
        follower.instanceId,
      );
      return (
        signal.isCurrent() &&
        !!live &&
        Bus.hasTelegramBusCapability(
          live.protocol,
          Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
        ) &&
        isDeepStrictEqual(
          {
            ...live,
            lastHeartbeatMs: undefined,
            connectedAtMs: undefined,
            threadName: undefined,
          },
          {
            ...follower,
            lastHeartbeatMs: undefined,
            connectedAtMs: undefined,
            threadName: undefined,
          },
        )
      );
    };
    const recipientMatches = (
      intent: Threads.TelegramWorkspaceRestoreIntent,
    ): boolean => {
      if (!follower) return true;
      const ready = intent.readyRecipient ?? intent.recipient;
      return (
        ready?.kind === "follower" &&
        ready.instanceId === follower.instanceId &&
        ready.sessionId === follower.sessionId &&
        ready.generation === follower.registrationGeneration &&
        !!follower.cwd &&
        intent.request.binding.cwd ===
          WorkspaceIdentity.normalizeTelegramWorkspacePath(follower.cwd) &&
        intent.request.binding.slot === follower.slot &&
        isDeepStrictEqual(intent.request.target, follower.target)
      );
    };
    // A same-session successor already registered on the relocated target may prove an issued grant by inspection only.
    const inspectableSuccessor = (
      intent: Threads.TelegramWorkspaceRestoreIntent,
    ): boolean =>
      !!follower?.registrationGeneration &&
      !!follower.cwd &&
      (intent.phase === "relocated" || intent.phase === "recipient-issued") &&
      intent.request.owner.owner?.kind === "manual-follower" &&
      follower.sessionId === intent.request.binding.sessionId &&
      intent.request.binding.cwd ===
        WorkspaceIdentity.normalizeTelegramWorkspacePath(follower.cwd) &&
      intent.request.binding.slot === follower.slot &&
      isDeepStrictEqual(intent.request.target, follower.target);
    const instanceId = deps.getCurrentInstanceId?.(),
      epoch = deps.getCurrentLeaderEpoch?.();
    const operatorUserId = deps.configStore.getAllowedUserId();
    const generation = deps.getSessionGeneration(),
      scope = deps.getAdmissionScope?.();
    const sourceBinding = deps.getAdmissionJournalBinding?.();
    if (
      !instanceId ||
      epoch === undefined ||
      operatorUserId === undefined ||
      !scope ||
      !sourceBinding ||
      (evidence && evidence.journalBindingKey !== sourceBinding) ||
      !recipientCurrent()
    )
      return;
    // This same-session leader already runs on the relocated target; it may only inspect an issued leader grant.
    const leaderSessionId = deps.workspaceRestoreRecipient?.getSessionId(ctx);
    const leaderCwd = deps.workspaceRestoreRecipient?.getCwd(ctx);
    const leaderAt = (
      request: Threads.TelegramWorkspaceRestoreRequest,
    ): boolean => {
      const ports = deps.workspaceRestoreRecipient;
      const cwd = ports?.getCwd(ctx),
        local = ports?.getLeaderIdentity();
      return (
        !!cwd &&
        cwd === leaderCwd &&
        ports?.getSessionId(ctx) === leaderSessionId &&
        leaderSessionId === request.binding.sessionId &&
        WorkspaceIdentity.normalizeTelegramWorkspacePath(cwd) ===
          request.binding.cwd &&
        !!local &&
        local.slot === request.binding.slot &&
        isDeepStrictEqual(local.target, request.target)
      );
    };
    const observeLeaderRestore = (
      intent: Threads.TelegramWorkspaceRestoreIntent,
      recipient: Threads.TelegramWorkspaceRestoreRecipient,
      isCurrent: () => boolean,
    ): Awaited<
      ReturnType<
        Parameters<typeof advanceTelegramWorkspaceRestore>[0]["runRecipient"]
      >
    > => {
      const threads = deps.threadStore;
      if (!threads || !isCurrent() || !leaderAt(intent.request))
        return undefined;
      const { request } = intent;
      let observation: Awaited<
        ReturnType<
          Parameters<typeof advanceTelegramWorkspaceRestore>[0]["runRecipient"]
        >
      >;
      threads.withWorkspaceRestoreSnapshot(intent, (snapshot) => {
        if (!isCurrent() || !leaderAt(request)) return;
        const owner = findRelocatedBindingOwner(snapshot, request)?.owner;
        if (
          owner?.owner?.kind !== "leader" ||
          owner.instanceId !== recipient.instanceId ||
          owner.owner.instanceId !== recipient.instanceId ||
          !owner.owner.cwd ||
          WorkspaceIdentity.normalizeTelegramWorkspacePath(owner.owner.cwd) !==
            request.binding.cwd
        )
          return;
        observation = {
          operationId: request.operationId,
          recipient,
          target: request.target,
          slot: request.binding.slot!,
          ready: true,
        };
      });
      return isCurrent() && leaderAt(request) ? observation : undefined;
    };
    // Same-process lost replies stay with their chooser; this path only serves a restarted leader process.
    const inspectableLeader = (
      intent: Threads.TelegramWorkspaceRestoreIntent,
    ): boolean =>
      !!evidence &&
      intent.request.owner.owner?.kind === "leader" &&
      leaderAt(intent.request) &&
      (intent.phase === "relocated"
        ? intent.request.owner.instanceId !== instanceId
        : intent.phase === "recipient-issued" &&
          intent.recipient?.kind === "leader" &&
          intent.recipient.instanceId !== instanceId);
    const current = (): boolean =>
      deps.hasWorkspaceRestoreAuthority?.() === true &&
      deps.isContextActive?.(ctx) !== false &&
      deps.getSessionGeneration?.() === generation &&
      deps.getAdmissionScope?.() === scope &&
      deps.getAdmissionJournalBinding?.() === sourceBinding &&
      deps.getCurrentInstanceId?.() === instanceId &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      deps.configStore.getAllowedUserId() === operatorUserId &&
      recipientCurrent();
    const recoveryRecipient = (
      intent: Threads.TelegramWorkspaceRestoreIntent,
    ): Bus.TelegramBusFollowerView | undefined => {
      const ready = intent.readyRecipient ?? intent.recipient;
      if (
        !deps.inspectRestoreSourceCompletion ||
        !deps.workspaceRestoreRecipient ||
        intent.phase !== "ready" ||
        !intent.routing ||
        intent.routing.cleanup !== undefined ||
        intent.operatorUserId !== operatorUserId ||
        !intent.routing.acceptances?.some((value) => value.kind === "forwarded")
      )
        return undefined;
      const live = deps.workspaceRestoreRecipient.followerRegistry.get(
        follower?.instanceId ?? ready?.instanceId ?? "",
      );
      return ready?.kind === "follower" &&
        live?.registrationGeneration &&
        live.cwd &&
        Bus.hasTelegramBusCapability(
          live.protocol,
          Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
        ) &&
        Bus.hasTelegramBusCapability(
          live.protocol,
          Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
        ) &&
        live.sessionId === intent.request.binding.sessionId &&
        WorkspaceIdentity.normalizeTelegramWorkspacePath(live.cwd) ===
          intent.request.binding.cwd &&
        live.slot === intent.request.binding.slot &&
        isDeepStrictEqual(live.target, intent.request.target)
        ? live
        : undefined;
    };
    const recoveryLeader = (
      intent: Threads.TelegramWorkspaceRestoreIntent,
    ): Threads.TelegramWorkspaceRestoreRecipient | undefined => {
      const ready = intent.readyRecipient ?? intent.recipient;
      if (
        evidence?.kind !== "completed" ||
        !deps.inspectRestoreSourceCompletion ||
        !deps.threadStore ||
        intent.phase !== "ready" ||
        !intent.routing ||
        intent.routing.cleanup !== undefined ||
        intent.operatorUserId !== operatorUserId ||
        intent.request.owner.owner?.kind !== "leader" ||
        ready?.kind !== "leader" ||
        ready.sessionId !== intent.request.binding.sessionId ||
        !leaderAt(intent.request) ||
        !intent.routing.acceptances?.some(
          (value) => value.kind === "completed" || value.kind === "queued",
        )
      )
        return undefined;
      return {
        kind: "leader",
        instanceId,
        sessionId: intent.request.binding.sessionId!,
        generation: String(generation),
      };
    };
    let selected: string[];
    try {
      selected =
        deps
          .getWorkspaceRestoreStore()
          ?.list()
          .filter((intent) => {
            if (intent.request.source.journalBindingKey !== sourceBinding)
              return false;
            if (
              evidence &&
              intent.request.source.updateIds.some((id) =>
                evidence.updateIds.includes(id),
              )
            )
              return true;
            if (
              ((evidence?.kind === "completed" || follower) &&
                recoveryRecipient(intent)) ||
              recoveryLeader(intent)
            )
              return true;
            if (
              follower &&
              deps.workspaceRestoreRecipient &&
              inspectableSuccessor(intent)
            )
              return true;
            if (deps.threadStore && inspectableLeader(intent)) return true;
            // Completion rechecks an unsent Restore whose originals may all have been abandoned before its retirement published.
            if (
              evidence?.kind === "completed" &&
              deps.inspectRestoreSourceAbandonment &&
              intent.phase === "ready" &&
              intent.routing === undefined
            )
              return true;
            // Hints only wake fully settled, unissued cleanup. They never settle another source.
            return (
              (evidence?.kind === "completed" || !!follower) &&
              intent.phase === "ready" &&
              intent.routing?.cleanup === undefined &&
              recipientMatches(intent) &&
              intent.request.source.updateIds.every((id) =>
                intent.routing?.settlements.some(
                  (value) =>
                    value.kind !== "queued" && value.updateIds.includes(id),
                ),
              )
            );
          })
          .map((intent) => intent.request.operationId) ?? [];
    } catch (error) {
      deps.recordRuntimeEvent?.("telegram", error, {
        phase: "workspace-restore-settlement",
      });
      return;
    }
    if (!selected.length || !current()) return;
    const task = Promise.resolve()
      .then(() =>
        deps.runWorkspaceOperation!(
          {
            operationId: `restore-settlement-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.restore-settlement",
            scopes: [{ kind: "profile" }],
          },
          async () => {
            if (!current()) return;
            const store = deps.getWorkspaceRestoreStore!();
            if (!store) return;
            const authority: Threads.TelegramWorkspaceRestoreAuthority = {
              executor: { instanceId, leaderEpoch: String(epoch) },
              operatorUserId,
              isCurrent: current,
            };
            const assertCurrent = (): void => {
              if (!current())
                throw new Error(
                  "Workspace Restore settlement authority ended.",
                );
            };
            // Exact owner abandonment of every original is terminal for an unsent Restore; no cleanup or delivery follows.
            const abandoned = (
              value: Threads.TelegramWorkspaceRestoreIntent,
            ): boolean => {
              if (
                evidence?.kind !== "completed" ||
                !value.request.source.updateIds.length
              )
                return false;
              return value.request.source.updateIds.every((updateId) => {
                const proof = deps.inspectRestoreSourceAbandonment?.(
                  updateId,
                  sourceBinding,
                );
                assertCurrent();
                return (
                  proof?.journalBindingKey === sourceBinding &&
                  proof.updateId === updateId &&
                  proof.operatorAuthorityId ===
                    `telegram-owner:${operatorUserId}`
                );
              });
            };
            for (const operationId of selected) {
              assertCurrent();
              let intent = store
                .list()
                .find((value) => value.request.operationId === operationId);
              let settlementCurrent = current;
              let settlementCanonicalCurrent: (() => boolean) | undefined;
              let retired = false;
              if (
                follower &&
                intent &&
                inspectableSuccessor(intent) &&
                intent.operatorUserId === operatorUserId
              ) {
                const ports = deps.workspaceRestoreRecipient!;
                const successor: Threads.TelegramWorkspaceRestoreRecipient = {
                  kind: "follower",
                  instanceId: follower.instanceId,
                  sessionId: follower.sessionId!,
                  generation: follower.registrationGeneration!,
                };
                const { request } = intent;
                // Adoption plus inspect never consumes the original apply grant, delivers input or issues cleanup.
                await advanceTelegramWorkspaceRestore({
                  request,
                  authority,
                  restoreStore: store,
                  inspectOnly: true,
                  getRecipient: () => (current() ? successor : undefined),
                  async runRecipient(action) {
                    if (action.mode !== "inspect" || !action.isCurrent())
                      return undefined;
                    return ports.runFollower({
                      operationId: request.operationId,
                      instanceId: successor.instanceId,
                      sessionId: successor.sessionId,
                      slot: request.binding.slot!,
                      target: request.target,
                      oldTarget: request.binding.target,
                      mode: "inspect",
                      isCurrent: action.isCurrent,
                    });
                  },
                });
                continue;
              }
              if (
                intent &&
                inspectableLeader(intent) &&
                intent.operatorUserId === operatorUserId
              ) {
                const threads = deps.threadStore!;
                const leader: Threads.TelegramWorkspaceRestoreRecipient = {
                  kind: "leader",
                  instanceId,
                  sessionId: intent.request.binding.sessionId!,
                  generation: String(generation),
                };
                const { request } = intent;
                await threads.load();
                assertCurrent();
                await advanceTelegramWorkspaceRestore({
                  request,
                  authority,
                  restoreStore: store,
                  inspectOnly: true,
                  getRecipient: () =>
                    current() && leaderAt(request) ? leader : undefined,
                  async runRecipient(action) {
                    if (action.mode !== "inspect") return undefined;
                    return observeLeaderRestore(
                      action.intent,
                      leader,
                      action.isCurrent,
                    );
                  },
                });
                continue;
              }
              if (
                intent?.phase === "ready" &&
                intent.routing === undefined &&
                intent.operatorUserId === operatorUserId &&
                intent.request.source.journalBindingKey === sourceBinding &&
                abandoned(intent)
              ) {
                const owned = isDeepStrictEqual(
                  intent.executor,
                  authority.executor,
                )
                  ? intent
                  : store.adopt(intent, authority);
                assertCurrent();
                if (owned)
                  store.retireAbandoned(
                    owned,
                    owned.request.source.updateIds,
                    authority,
                  );
                continue;
              }
              const liveRecipient = intent && recoveryRecipient(intent),
                localRecipient = intent && recoveryLeader(intent);
              if (
                intent &&
                (liveRecipient || localRecipient) &&
                intent.request.source.journalBindingKey === sourceBinding
              ) {
                const expected = intent,
                  ports = deps.workspaceRestoreRecipient!;
                const recoveryCurrent = (): boolean =>
                  current() &&
                  (localRecipient
                    ? leaderAt(expected.request) &&
                      isDeepStrictEqual(
                        recoveryLeader(expected),
                        localRecipient,
                      )
                    : isDeepStrictEqual(
                        {
                          ...recoveryRecipient(expected),
                          lastHeartbeatMs: undefined,
                          connectedAtMs: undefined,
                          threadName: undefined,
                        },
                        {
                          ...liveRecipient,
                          lastHeartbeatMs: undefined,
                          connectedAtMs: undefined,
                          threadName: undefined,
                        },
                      ));
                // Storage authority callbacks check live fences only; canonical reads cannot re-enter their transaction lock.
                const recoveryAuthority = {
                  ...authority,
                  isCurrent: recoveryCurrent,
                };
                settlementCurrent = recoveryCurrent;
                if (localRecipient) {
                  settlementCanonicalCurrent = () =>
                    !!intent &&
                    !!observeLeaderRestore(
                      intent,
                      localRecipient,
                      recoveryCurrent,
                    );
                  if (!settlementCanonicalCurrent()) continue; // A local target alone cannot authorize executor adoption.
                }
                const inspect = (
                  acceptance: Threads.TelegramWorkspaceRestoreSourceAcceptance,
                  operation: Threads.TelegramWorkspaceRestoreIntent,
                ): boolean => {
                  const completion = {
                    journalBindingKey: sourceBinding,
                    updateId: acceptance.updateId,
                    sourceSha256: acceptance.sourceSha256,
                    completionSha256:
                      Threads.getTelegramWorkspaceRestoreSourceCompletionSha256(
                        operation,
                        acceptance,
                      ),
                  };
                  const observed = deps.inspectRestoreSourceCompletion!({
                    ...completion,
                  });
                  if (!recoveryCurrent())
                    throw new Error(
                      "Workspace Restore completion observation authority ended.",
                    );
                  return isDeepStrictEqual(observed, completion);
                };
                // Inspect proof before adopting: missing/foreign ACKs cannot even re-key the retained operation.
                const accepted = expected.routing!.acceptances!.filter(
                  (value) =>
                    (localRecipient
                      ? value.kind === "completed" || value.kind === "queued"
                      : value.kind === "forwarded") && inspect(value, expected),
                );
                if (accepted.length) {
                  const successor: Threads.TelegramWorkspaceRestoreRecipient =
                    localRecipient ?? {
                      kind: "follower",
                      instanceId: liveRecipient!.instanceId,
                      sessionId: liveRecipient!.sessionId!,
                      generation: liveRecipient!.registrationGeneration!,
                    };
                  const { request } = expected;
                  const inspected = await advanceTelegramWorkspaceRestore({
                    request,
                    authority: recoveryAuthority,
                    restoreStore: store,
                    inspectOnly: true,
                    getRecipient: () =>
                      recoveryCurrent() ? successor : undefined,
                    async runRecipient(action) {
                      if (action.mode !== "inspect" || !action.isCurrent())
                        return undefined;
                      if (localRecipient)
                        return observeLeaderRestore(
                          action.intent,
                          successor,
                          action.isCurrent,
                        );
                      return ports.runFollower({
                        operationId: request.operationId,
                        instanceId: successor.instanceId,
                        sessionId: successor.sessionId,
                        slot: request.binding.slot!,
                        target: request.target,
                        oldTarget: request.binding.target,
                        mode: "inspect",
                        isCurrent: action.isCurrent,
                      });
                    },
                  });
                  if (!inspected || !recoveryCurrent()) continue;
                  intent = inspected;
                  if (
                    settlementCanonicalCurrent &&
                    !settlementCanonicalCurrent()
                  )
                    continue;
                  // The await cannot lend earlier readback; confirm each immutable proof again before publication.
                  const settledIds = new Set(
                    intent
                      .routing!.settlements.filter(
                        (value) => value.kind !== "queued",
                      )
                      .flatMap((value) => value.updateIds),
                  );
                  const recovered = new Map<
                    string,
                    Threads.TelegramWorkspaceRestoreSourceSettlement
                  >();
                  for (const acceptance of accepted.filter(
                    (value) =>
                      !settledIds.has(value.updateId) &&
                      inspect(value, intent!),
                  )) {
                    const key =
                      acceptance.kind === "queued"
                        ? JSON.stringify([
                            acceptance.receiptId,
                            acceptance.queueKind,
                          ])
                        : "completed";
                    const settlement = recovered.get(key) ?? {
                      journalBindingKey: sourceBinding,
                      updateIds: [],
                      ...(acceptance.kind === "queued"
                        ? {
                            kind: "queue-completed" as const,
                            receiptId: acceptance.receiptId,
                            queueKind: acceptance.queueKind,
                          }
                        : { kind: "completed" as const }),
                    };
                    settlement.updateIds.push(acceptance.updateId);
                    recovered.set(key, settlement);
                  }
                  for (const settlement of recovered.values()) {
                    intent = store.recordSourceSettlement(
                      intent!,
                      settlement,
                      recoveryAuthority,
                    );
                    if (!intent) break;
                  }
                  if (!intent) continue;
                }
              }
              // Source hints carry no registry fence; cleanup must keep the acknowledged recipient exact across awaits.
              const readyRecipientCurrent = (): boolean => {
                const ready = intent?.readyRecipient ?? intent?.recipient;
                if (intent?.phase !== "ready" || ready?.kind !== "follower")
                  return true;
                const live =
                  deps.workspaceRestoreRecipient?.followerRegistry.get(
                    ready.instanceId,
                  );
                return (
                  !!live?.cwd &&
                  live.registrationGeneration === ready.generation &&
                  live.sessionId === ready.sessionId &&
                  WorkspaceIdentity.normalizeTelegramWorkspacePath(live.cwd) ===
                    intent.request.binding.cwd &&
                  live.slot === intent.request.binding.slot &&
                  isDeepStrictEqual(live.target, intent.request.target) &&
                  Bus.hasTelegramBusCapability(
                    live.protocol,
                    Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
                  ) &&
                  Bus.hasTelegramBusCapability(
                    live.protocol,
                    Bus.TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
                  )
                );
              };
              const settlementAuthority = {
                ...authority,
                isCurrent: function () {
                  return settlementCurrent() && readyRecipientCurrent();
                },
              };
              const assertSettlementCurrent = (): void => {
                if (
                  !settlementAuthority.isCurrent() ||
                  (!retired &&
                    settlementCanonicalCurrent &&
                    !settlementCanonicalCurrent())
                ) {
                  throw new Error(
                    "Workspace Restore settlement authority ended.",
                  );
                }
              };
              assertSettlementCurrent();
              if (
                !intent ||
                intent.phase !== "ready" ||
                !intent.routing ||
                !isDeepStrictEqual(intent.executor, authority.executor) ||
                intent.operatorUserId !== operatorUserId ||
                intent.request.source.journalBindingKey !== sourceBinding
              )
                continue;
              const settled = new Set(
                intent.routing.settlements.flatMap((value) => value.updateIds),
              );
              if (
                follower &&
                (intent.routing.cleanup !== undefined ||
                  !recipientMatches(intent) ||
                  !intent.request.source.updateIds.every((id) =>
                    settled.has(id),
                  ))
              )
                continue;
              const updateIds =
                evidence?.updateIds.filter(
                  (id) =>
                    intent!.request.source.updateIds.includes(id) &&
                    !settled.has(id),
                ) ?? [];
              if (evidence && updateIds.length) {
                intent = store.recordSourceSettlement(
                  intent,
                  { ...evidence, updateIds },
                  settlementAuthority,
                );
                if (!intent) continue;
              }
              if (intent.routing?.cleanup === undefined) {
                if (
                  !intent.request.source.updateIds.every((id) =>
                    intent!.routing!.settlements.some(
                      (value) =>
                        value.kind !== "queued" && value.updateIds.includes(id),
                    ),
                  )
                )
                  continue;
                // Positive settlement of every selected source is the success proof; old-thread cleanup may stay protected indefinitely.
                await disposeTemporaryThreadSiblingsAfterRestore(
                  intent,
                  ctx,
                  settlementAuthority.isCurrent,
                );
                assertSettlementCurrent();
                if (
                  isRerouteTargetProtected(
                    intent.request.binding.target,
                    intent,
                  )
                )
                  continue;
                const grant = store.issueCleanup(intent, settlementAuthority);
                if (!grant) continue;
                intent = grant.intent;
                const oldTarget = intent.request.binding.target;
                const completed =
                  intent.request.owner.owner?.kind === "leader"
                    ? await closePreviousLeaderThread(
                        oldTarget,
                        assertSettlementCurrent,
                        intent,
                      )
                    : await closeReplacedFollowerThread(
                        oldTarget,
                        intent.request.owner.instanceId,
                        assertSettlementCurrent,
                        intent,
                      );
                assertSettlementCurrent();
                if (!completed) continue; // Issued uncertainty stays protected, never downgraded or retried.
                intent = store.recordCleanup(
                  intent,
                  { kind: "completed", target: oldTarget },
                  settlementAuthority,
                );
                if (!intent) continue;
              }
              if (!store.retire(intent, settlementAuthority)) continue;
              retired = true;
              for (const [id, pending] of pendingUnboundReroutes) {
                if (pending.workspaceRestore?.operationId !== operationId)
                  continue;
                pending.phase = { kind: "finalizing", message: "Restored" };
                if (
                  !deps.editInteractiveMessage ||
                  pending.chooserMessageId === undefined
                )
                  continue;
                assertSettlementCurrent();
                await deps.editInteractiveMessage(
                  pending.sourceTarget.chatId,
                  pending.chooserMessageId,
                  "<b>✅ Message routed.</b>",
                  "html",
                  { inline_keyboard: [] },
                );
                assertSettlementCurrent();
                if (pendingUnboundReroutes.get(id) === pending)
                  removePendingReroute(id);
              }
            }
          },
        ),
      )
      .catch((error) => {
        deps.recordRuntimeEvent?.("telegram", error, {
          phase: "workspace-restore-settlement",
        });
      });
    restoreSettlementTasks.add(task);
    void task.finally(() => restoreSettlementTasks.delete(task));
    return task;
  };
  const beforeQueueReceiptPublished: NonNullable<
    Updates.TelegramUpdateWorkerRuntimeDeps<TContext>["beforeQueueReceiptPublished"]
  > = async (receipt, queueOwner, ctx, isWorkerCurrent) => {
    const heldScopes = commandHandler.prepareHeldQueueReceipt(
      receipt,
      queueOwner,
      ctx,
      isWorkerCurrent,
    );
    if (heldScopes !== undefined) return heldScopes;
    const store = deps.getWorkspaceRestoreStore?.();
    if (!store) return;
    const selected = store
      .list()
      .filter(
        (intent) =>
          intent.request.source.journalBindingKey ===
            receipt.journalBindingKey &&
          intent.request.source.updateIds.some((id) =>
            receipt.sourceUpdateIds.includes(id),
          ),
      )
      .map((intent) => intent.request.operationId);
    if (!selected.length) return;
    const instanceId = deps.getCurrentInstanceId?.(),
      epoch = deps.getCurrentLeaderEpoch?.();
    const generation = deps.getSessionGeneration?.(),
      scope = deps.getAdmissionScope?.(),
      operatorUserId = deps.configStore.getAllowedUserId();
    const binding = receipt.journalBindingKey,
      ports = deps.workspaceRestoreRecipient,
      threads = deps.threadStore;
    if (
      !instanceId ||
      epoch === undefined ||
      generation === undefined ||
      !scope ||
      !binding ||
      operatorUserId === undefined ||
      !ports ||
      !threads ||
      !deps.runWorkspaceOperation ||
      !deps.inspectRestoreQueuedReceipt
    ) {
      throw new Error(
        "Workspace Restore queued acceptance authority is unavailable.",
      );
    }
    const expectedReceipt: TelegramUpdateJournalQueuedCompletion = {
      queueKind: receipt.queueKind,
      receiptId: receipt.receiptId,
      sourceUpdateIds: [...receipt.sourceUpdateIds],
      queueOwner: { ...queueOwner },
    };
    const current = (): boolean =>
      isWorkerCurrent() &&
      deps.hasWorkspaceRestoreAuthority?.() === true &&
      deps.isContextActive?.(ctx) !== false &&
      deps.getSessionGeneration?.() === generation &&
      deps.getAdmissionScope?.() === scope &&
      deps.getAdmissionJournalBinding?.() === binding &&
      deps.getCurrentInstanceId?.() === instanceId &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      deps.configStore.getAllowedUserId() === operatorUserId &&
      queueOwner.instanceId === instanceId &&
      queueOwner.sessionGeneration === generation;
    const assertCurrent = (): void => {
      if (!current())
        throw new Error(
          "Workspace Restore queued acceptance authority changed.",
        );
    };
    assertCurrent();
    const recipientGuards: Array<() => boolean> = [];
    const sourceCompletions: Updates.TelegramQueueSourceCompletion[] = [];
    await deps.runWorkspaceOperation(
      {
        operationId: `restore-queue-acceptance-${randomBytes(16).toString("hex")}`,
        operationKind: "workspace.restore-queue-acceptance",
        scopes: [{ kind: "profile" }],
      },
      async () => {
        assertCurrent();
        const active = deps.getWorkspaceRestoreStore?.();
        if (!active)
          throw new Error(
            "Workspace Restore queued acceptance storage disappeared.",
          );
        const proof = deps.inspectRestoreQueuedReceipt!({
          ...structuredClone(expectedReceipt),
          journalBindingKey: binding,
        });
        assertCurrent();
        if (
          !proof ||
          !isDeepStrictEqual(proof.receipt, expectedReceipt) ||
          !/^[a-f0-9]{64}$/u.test(proof.queueOwnerSha256) ||
          proof.sources.length !== receipt.sourceUpdateIds.length ||
          proof.sources.some(
            (source, index) =>
              source.updateId !== receipt.sourceUpdateIds[index] ||
              !/^[a-f0-9]{64}$/u.test(source.sourceSha256),
          )
        ) {
          throw new Error(
            "Workspace Restore queued receipt proof is unavailable.",
          );
        }
        for (const operationId of selected) {
          let intent = active
            .list()
            .find((value) => value.request.operationId === operationId);
          const recipient = intent?.readyRecipient ?? intent?.recipient;
          if (
            !intent ||
            intent.phase !== "ready" ||
            !intent.routing ||
            intent.operatorUserId !== operatorUserId ||
            !isDeepStrictEqual(intent.executor, {
              instanceId,
              leaderEpoch: String(epoch),
            }) ||
            intent.request.source.journalBindingKey !== binding ||
            recipient?.kind !== "leader" ||
            recipient.instanceId !== instanceId ||
            recipient.generation !== String(generation) ||
            recipient.sessionId !== intent.request.binding.sessionId
          ) {
            throw new Error(
              "Workspace Restore queued recipient proof changed.",
            );
          }
          const request = intent.request;
          const localRecipientMatches = (): boolean => {
            const local = ports.getLeaderIdentity(),
              cwd = ports.getCwd(ctx);
            return (
              !!local &&
              local.slot === request.binding.slot &&
              isDeepStrictEqual(local.target, request.target) &&
              ports.getSessionId(ctx) === recipient.sessionId &&
              !!cwd &&
              WorkspaceIdentity.normalizeTelegramWorkspacePath(cwd) ===
                request.binding.cwd
            );
          };
          const liveRecipientCurrent = (): boolean =>
            current() && localRecipientMatches();
          const recipientCurrent = (): boolean => {
            if (!liveRecipientCurrent()) return false;
            let committed = false;
            threads.withWorkspaceRestoreSnapshot(intent!, (snapshot) => {
              const live =
                snapshot.workspaceBindings?.filter(
                  (value) => value.bindingKey === request.binding.bindingKey,
                ) ?? [];
              const owners = snapshot.threads.filter(
                (value) =>
                  value.status === "active" &&
                  (value.slot === request.binding.slot ||
                    isDeepStrictEqual(value.target, request.target)),
              );
              committed =
                live.length === 1 &&
                live[0]?.sessionId === recipient.sessionId &&
                live[0].cwd === request.binding.cwd &&
                live[0].slot === request.binding.slot &&
                live[0].inactiveSinceMs === undefined &&
                isDeepStrictEqual(live[0].target, request.target) &&
                owners.length === 1 &&
                owners[0]?.owner?.kind === "leader" &&
                owners[0].instanceId === instanceId &&
                owners[0].owner.instanceId === instanceId &&
                !!owners[0].owner.cwd &&
                WorkspaceIdentity.normalizeTelegramWorkspacePath(
                  owners[0].owner.cwd,
                ) === request.binding.cwd &&
                owners[0].profileKey === request.owner.profileKey &&
                owners[0].slot === request.binding.slot &&
                isDeepStrictEqual(owners[0].target, request.target) &&
                localRecipientMatches();
            });
            return committed && liveRecipientCurrent();
          };
          recipientGuards.push(recipientCurrent);
          // Storage owns the canonical CAS; its in-transaction authority callback cannot reacquire the snapshot lock.
          const authority: Threads.TelegramWorkspaceRestoreAuthority = {
            executor: { instanceId, leaderEpoch: String(epoch) },
            operatorUserId,
            isCurrent: liveRecipientCurrent,
          };
          for (const source of proof.sources.filter((value) =>
            request.source.updateIds.includes(value.updateId),
          )) {
            if (!recipientCurrent())
              throw new Error(
                "Workspace Restore queued recipient authority changed.",
              );
            const evidence: Threads.TelegramWorkspaceRestoreSourceAcceptance = {
              ...source,
              journalBindingKey: binding,
              recipient,
              kind: "queued",
              receiptId: receipt.receiptId,
              queueKind: receipt.queueKind,
              queueOwnerSha256: proof.queueOwnerSha256,
            };
            let accepted: Threads.TelegramWorkspaceRestoreIntent | undefined,
              failure: unknown;
            try {
              accepted = active.recordSourceAcceptance(
                intent,
                evidence,
                authority,
              );
            } catch (error) {
              failure = error;
            }
            if (!accepted)
              accepted = active
                .list()
                .find(
                  (value) =>
                    value.request.operationId === operationId &&
                    isDeepStrictEqual(value.request, request) &&
                    isDeepStrictEqual(value.executor, authority.executor) &&
                    value.operatorUserId === operatorUserId &&
                    value.routing?.acceptances?.some((retained) =>
                      isDeepStrictEqual(retained, evidence),
                    ),
                );
            if (
              !accepted ||
              !isDeepStrictEqual(accepted.request, request) ||
              !isDeepStrictEqual(accepted.executor, authority.executor) ||
              accepted.operatorUserId !== operatorUserId ||
              !accepted.routing?.acceptances?.some((value) =>
                isDeepStrictEqual(value, evidence),
              )
            ) {
              throw (
                failure ??
                new Error(
                  "Workspace Restore queued acceptance was not published.",
                )
              );
            }
            intent = accepted;
            sourceCompletions.push({
              ...source,
              journalBindingKey: binding,
              completionSha256:
                Threads.getTelegramWorkspaceRestoreSourceCompletionSha256(
                  accepted,
                  evidence,
                ),
            });
            if (!recipientCurrent())
              throw new Error(
                "Workspace Restore queued recipient authority changed.",
              );
          }
        }
        const observed = deps.inspectRestoreQueuedReceipt!({
          ...structuredClone(expectedReceipt),
          journalBindingKey: binding,
        });
        assertCurrent();
        if (!isDeepStrictEqual(observed, proof))
          throw new Error(
            "Workspace Restore queued receipt changed after publication.",
          );
      },
    );
    assertCurrent();
    if (recipientGuards.some((guard) => !guard()))
      throw new Error(
        "Workspace Restore queued recipient changed after admission.",
      );
    return sourceCompletions.sort((a, b) => a.updateId - b.updateId);
  };
  const onQueueReceiptCompleted = (
    receipt: Updates.TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
  ): void => {
    // A hint re-enters admission and rereads scoped proof; it never supplies completed command evidence for a queued source.
    if (!receipt.journalBindingKey) return;
    observeRestoreSettlement(
      {
        kind: "source",
        evidence: {
          journalBindingKey: receipt.journalBindingKey,
          updateIds: [...receipt.sourceUpdateIds],
          kind: "completed",
        },
      },
      ctx,
    );
    for (const updateId of receipt.sourceUpdateIds)
      retireCompletedTemporaryThread(updateId, ctx, receipt.journalBindingKey);
  };
  const onQueueReceiptCommitted = (
    receipt: Updates.TelegramQueueAdmissionReceiptLike,
    ctx: TContext,
  ): void => {
    if (receipt.journalBindingKey)
      observeRestoreSettlement(
        {
          kind: "source",
          evidence: {
            journalBindingKey: receipt.journalBindingKey,
            updateIds: [...receipt.sourceUpdateIds],
            kind: "queued",
            receiptId: receipt.receiptId,
            queueKind: receipt.queueKind,
          },
        },
        ctx,
      );
  };
  // Worker-confirmed source completion is the only evidence for a Forwarded input. It records a durable group fact and
  // starts the same delayed, fully rechecked cleanup as the last Cancel; deletion itself never happens here.
  const completedTemporaryInputIds = new Map<string, Set<number>>();
  const retireCompletedTemporaryThread = (
    updateId: number,
    ctx: TContext,
    journalBindingKey: string,
  ): void => {
    const cap = captureTemporaryThreadAuthority(ctx);
    if (
      !cap ||
      !deps.runWorkspaceOperation ||
      cap.journalBindingKey !== journalBindingKey
    )
      return;
    const store = cap.store;
    const matches = (entry: Threads.TelegramTemporaryThreadEntry) =>
      entry.source.journalBindingKey === journalBindingKey &&
      entry.source.updateId === updateId;
    const inGroup = (entry: Threads.TelegramTemporaryThreadEntry) =>
      Threads.getTelegramTemporaryThreadInputs(entry).some(
        (input) =>
          input.journalBindingKey === journalBindingKey &&
          input.updateIds.includes(updateId),
      );
    let restoreOwned = false;
    try {
      if (
        !store
          .listTemporaryThreads()
          .some((entry) => matches(entry) || inGroup(entry))
      )
        return;
      restoreOwned = store
        .list()
        .some(
          (intent) =>
            intent.request.source.journalBindingKey === journalBindingKey &&
            intent.request.source.updateIds.includes(updateId),
        );
    } catch (error) {
      deps.recordRuntimeEvent?.("routing", error, {
        phase: "temporary-thread-retire",
      });
      return;
    }
    const task = Promise.resolve()
      .then(() =>
        deps.runWorkspaceOperation!(
          {
            operationId: `temporary-thread-retire-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.temporary-thread",
            scopes: [{ kind: "profile" }],
          },
          async () => {
            if (!cap.isCurrent()) return;
            let entry = store
              .listTemporaryThreads()
              .find(restoreOwned ? matches : inGroup);
            if (!entry) return;
            if (restoreOwned) {
              // A Restore keeps its own lifecycle: only its source entry may be released, never by Forward bookkeeping.
              if (
                entry.target &&
                hasOtherTemporaryThreadReroute(entry.target, entry)
              )
                return;
              entry = cap.adopt(entry);
              if (entry && cap.isCurrent())
                store.retireTemporaryThread(entry, cap.authority);
              return;
            }
            const group = Threads.getTelegramTemporaryThreadInputs(entry).find(
              (input) =>
                input.journalBindingKey === journalBindingKey &&
                input.updateIds.includes(updateId),
            );
            const target = entry.target;
            if (!group || entry.phase !== "created" || !target) return;
            if (
              entry.cancelledInputs?.some((input) =>
                isDeepStrictEqual(input, group),
              ) ||
              entry.completedInputs?.some((input) =>
                isDeepStrictEqual(input, group),
              )
            )
              return;
            // Process-local accumulation only: a restart forgets partial groups and the tab stays protected.
            const seen =
              completedTemporaryInputIds.get(entry.token) ?? new Set<number>();
            seen.add(updateId);
            completedTemporaryInputIds.set(entry.token, seen);
            if (!group.updateIds.every((id) => seen.has(id))) return;
            entry = cap.adopt(entry);
            if (
              !entry ||
              !cap.isCurrent() ||
              !store.recordTemporaryThreadInputCompletion(
                entry,
                group,
                cap.authority,
              ) ||
              !cap.isCurrent()
            )
              return;
            scheduleTemporaryThreadCleanup(target, ctx);
            return true;
          },
        ),
      )
      .then((published) => {
        // A sibling may complete after Restore already settled. Reinspect only after its terminal fact publishes and admission releases.
        if (published && cap.isCurrent())
          observeRestoreSettlement(
            {
              kind: "source",
              evidence: {
                journalBindingKey,
                updateIds: [updateId],
                kind: "completed",
              },
            },
            ctx,
          );
      })
      .catch((error) => {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "temporary-thread-retire",
        });
      });
    restoreSettlementTasks.add(task);
    void task.finally(() => restoreSettlementTasks.delete(task));
  };
  const onUpdateCompleted = (
    updateId: number,
    ctx: TContext,
    journalBindingKey?: string,
  ): void => {
    if (!journalBindingKey) return;
    observeRestoreSettlement(
      {
        kind: "source",
        evidence: {
          journalBindingKey,
          updateIds: [updateId],
          kind: "completed",
        },
      },
      ctx,
    );
    retireCompletedTemporaryThread(updateId, ctx, journalBindingKey);
  };
  const getLiveRebindMenu = (messages: readonly TMessage[]) => {
    const command =
      messages.length === 1
        ? Commands.parseTelegramCommand(
            Media.extractFirstTelegramMessageText([...messages]),
          )
        : undefined;
    const action = command && Commands.buildTelegramCommandAction(command.name);
    if (
      !command ||
      !action ||
      !["status", "model", "thinking", "queue", "settings"].includes(
        action.kind,
      ) ||
      (action.kind === "settings" && !deps.openSettingsMenu)
    )
      return undefined;
    return command;
  };
  const getLiveRebindAbort = (messages: readonly TMessage[]) => {
    if (messages.length !== 1) return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    return command?.name === "abort" ? command : undefined;
  };
  const getLiveRebindNext = (messages: readonly TMessage[]) => {
    if (messages.length !== 1) return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    return command?.name === "next" ? command : undefined;
  };
  const getLiveRebindStop = (messages: readonly TMessage[]) => {
    if (messages.length !== 1 || !deps.cancelNextDispatchAnnouncement)
      return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    return command?.name === "stop" ? command : undefined;
  };
  const getLiveRebindHelp = (messages: readonly TMessage[]) => {
    if (messages.length !== 1) return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    return command?.name === "start" || command?.name === "help"
      ? command
      : undefined;
  };
  const getLiveRebindName = (messages: readonly TMessage[]) => {
    if (messages.length !== 1) return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    if (
      command?.name !== "name" ||
      (command.args.trim()
        ? /^[A-Z]$/.test(command.args.trim())
          ? !deps.resetCurrentThreadName
          : !deps.renameCurrentThread
        : !deps.sendInteractiveMessage ||
          !deps.captureThreadNameRecipientAuthority)
    )
      return undefined;
    return command;
  };
  const getLiveRebindConfirmation = (messages: readonly TMessage[]) => {
    if (
      messages.length !== 1 ||
      !deps.sendInteractiveMessage ||
      !deps.captureThreadNameRecipientAuthority
    )
      return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    return command?.name === "compact" || command?.name === "new"
      ? command
      : undefined;
  };
  const getLiveRebindContinue = (messages: readonly TMessage[]) => {
    if (messages.length !== 1) return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    return command?.name === "continue" ? command : undefined;
  };
  const getLiveRebindTemplate = (messages: readonly TMessage[]) => {
    if (messages.length !== 1) return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    if (
      !command ||
      reservedCommandNames().has(command.name) ||
      Commands.findTelegramExtensionCommand(command.name)
    )
      return undefined;
    try {
      const expanded = expandPromptTemplateCommand(command.name, command.args);
      return expanded === undefined
        ? undefined
        : {
            command,
            expandedSha256: createHash("sha256").update(expanded).digest("hex"),
          };
    } catch {
      return undefined;
    }
  };
  const getLiveRebindExtension = (messages: readonly TMessage[]) => {
    if (messages.length !== 1) return undefined;
    const command = Commands.parseTelegramCommand(
      Media.extractFirstTelegramMessageText([...messages]),
    );
    return command &&
      Commands.findTelegramExtensionCommand(command.name)?.selected
      ? command
      : undefined;
  };
  const prepareLiveSelection = async (
    selection: NonNullable<PendingUnboundReroute["liveRebind"]>,
    selectedTarget: Queue.TelegramQueueTarget & { threadId: number },
    ctx: TContext,
  ): Promise<
    ReturnType<typeof createTelegramLiveRebindCoordinator> | undefined
  > => {
    const target = { ...selectedTarget };
    const ports = deps.workspaceRestoreRecipient,
      threads = deps.threadStore,
      store = deps.getWorkspaceRestoreStore?.();
    const instanceId = deps.getCurrentInstanceId?.(),
      epoch = deps.getCurrentLeaderEpoch?.();
    const operatorUserId = deps.configStore.getAllowedUserId(),
      journalBindingKey = deps.getAdmissionJournalBinding?.();
    const generation = deps.getSessionGeneration?.(),
      scope = deps.getAdmissionScope?.();
    const callerSessionId = ports?.getSessionId(ctx),
      callerCwd = ports?.getCwd(ctx);
    if (
      !ports ||
      !threads ||
      !store ||
      !instanceId ||
      epoch === undefined ||
      !callerSessionId ||
      !callerCwd ||
      operatorUserId === undefined ||
      !journalBindingKey ||
      generation === undefined ||
      !scope ||
      !selection.isCurrent?.()
    )
      return undefined;
    const bindings = threads
      .listWorkspaceBindings()
      .filter((value) =>
        isDeepStrictEqual(value.target, selection.record.target),
      );
    const binding = bindings.length === 1 ? bindings[0] : undefined;
    if (!binding?.sessionId || !binding.slot) return undefined;
    const isLeader =
      selection.record.owner?.kind === "leader" &&
      selection.record.instanceId === instanceId;
    const selectedFollower =
      selection.record.owner?.kind === "manual-follower" &&
      selection.record.instanceId
        ? ports.followerRegistry.get(selection.record.instanceId)
        : undefined;
    const follower = selectedFollower && structuredClone(selectedFollower);
    const liveFollower = ports.liveFollower,
      followerRun = liveFollower?.run,
      followerJournal = liveFollower?.getJournalBindingKey;
    const commandName =
      !isLeader && selection.messages.length === 1
        ? Commands.parseTelegramCommand(
            Media.extractFirstTelegramMessageText([...selection.messages]),
          )?.name
        : undefined;
    const selectedCommand = commandName
      ? { name: commandName, target: { ...target } }
      : undefined;
    const heldSelected = selectedCommand,
      commandAvailability = liveFollower?.isSelectedCommandAvailable;
    const recipientJournalKey = isLeader
      ? journalBindingKey
      : follower && liveFollower?.getJournalBindingKey(follower);
    if (
      isLeader
        ? !deps.setCurrentLeaderIdentity ||
          callerSessionId !== binding.sessionId ||
          WorkspaceIdentity.normalizeTelegramWorkspacePath(callerCwd) !==
            binding.cwd
        : !follower?.registrationGeneration ||
          !follower.profileKey ||
          follower.profileKey !== selection.record.profileKey ||
          follower.instanceId !== selection.record.instanceId ||
          follower.sessionId !== binding.sessionId ||
          !follower.cwd ||
          WorkspaceIdentity.normalizeTelegramWorkspacePath(follower.cwd) !==
            binding.cwd ||
          follower.slot !== binding.slot ||
          !follower.busSocketPath ||
          !recipientJournalKey ||
          recipientJournalKey === follower.profileKey ||
          !liveFollower
    )
      return undefined;
    const request: Threads.TelegramWorkspaceRestoreRequest = {
      operationId: `live-${randomBytes(16).toString("hex")}`,
      binding: structuredClone(binding),
      owner: structuredClone(selection.record),
      target: { ...target },
      source: {
        journalBindingKey,
        updateIds: Updates.collectTelegramAdmissionSourceUpdateIds(
          selection.messages,
        ),
      },
    };
    // Detached command replies retain recipient lifetime, never the chooser lease or completed source.
    const recipientLifetime = () =>
      deps.hasWorkspaceLiveRebindAuthority?.() === true &&
      deps.isContextActive?.(ctx) === true &&
      deps.getSessionGeneration?.() === generation &&
      deps.getCurrentInstanceId?.() === instanceId &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      deps.getAdmissionScope?.() === scope &&
      deps.getAdmissionJournalBinding?.() === journalBindingKey &&
      deps.configStore.getAllowedUserId() === operatorUserId &&
      deps.getWorkspaceRestoreStore?.() === store &&
      ports.getSessionId(ctx) === callerSessionId &&
      ports.getCwd(ctx) === callerCwd;
    let extensionRegistrationCurrent: (() => void) | undefined;
    const registrationCurrent = () => {
      try {
        extensionRegistrationCurrent?.();
        return true;
      } catch {
        return false;
      }
    };
    const current = () =>
      selection.isCurrent?.() === true &&
      recipientLifetime() &&
      registrationCurrent() &&
      (!selection.extensionCommand ||
        isDeepStrictEqual(
          getLiveRebindExtension(selection.messages),
          selection.extensionCommand,
        )) &&
      (!selection.menuCommand ||
        isDeepStrictEqual(
          getLiveRebindMenu(selection.messages),
          selection.menuCommand,
        )) &&
      (!selection.abortCommand ||
        isDeepStrictEqual(
          getLiveRebindAbort(selection.messages),
          selection.abortCommand,
        )) &&
      (!selection.nextCommand ||
        isDeepStrictEqual(
          getLiveRebindNext(selection.messages),
          selection.nextCommand,
        )) &&
      (!selection.stopCommand ||
        isDeepStrictEqual(
          getLiveRebindStop(selection.messages),
          selection.stopCommand,
        )) &&
      (!selection.helpCommand ||
        isDeepStrictEqual(
          getLiveRebindHelp(selection.messages),
          selection.helpCommand,
        )) &&
      (!selection.nameCommand ||
        isDeepStrictEqual(
          getLiveRebindName(selection.messages),
          selection.nameCommand,
        )) &&
      (!selection.confirmationCommand ||
        isDeepStrictEqual(
          getLiveRebindConfirmation(selection.messages),
          selection.confirmationCommand,
        )) &&
      (!selection.template ||
        isDeepStrictEqual(
          getLiveRebindTemplate(selection.messages),
          selection.template,
        )) &&
      (!selection.continueCommand ||
        isDeepStrictEqual(
          getLiveRebindContinue(selection.messages),
          selection.continueCommand,
        ));
    const recipient = {
      kind: isLeader ? ("leader" as const) : ("follower" as const),
      instanceId: isLeader ? instanceId : follower!.instanceId,
      sessionId: binding.sessionId,
      generation: isLeader
        ? String(generation)
        : follower!.registrationGeneration!,
      bindingKey: recipientJournalKey!,
    };
    const followerCurrent = () => {
      if (isLeader) return true;
      const live = ports.followerRegistry.get(follower!.instanceId);
      if (heldSelected) {
        if (
          !commandAvailability ||
          ports.liveFollower !== liveFollower ||
          liveFollower?.run !== followerRun ||
          liveFollower?.getJournalBindingKey !== followerJournal ||
          liveFollower?.isSelectedCommandAvailable !== commandAvailability ||
          !live
        )
          return false;
        try {
          if (
            commandAvailability.call(
              liveFollower,
              structuredClone(live),
              selectedCommand!.name,
            ) !== true
          )
            return false;
        } catch {
          return false;
        }
        if (
          ports.liveFollower !== liveFollower ||
          liveFollower?.run !== followerRun ||
          liveFollower?.getJournalBindingKey !== followerJournal ||
          liveFollower?.isSelectedCommandAvailable !== commandAvailability
        )
          return false;
      }
      return (
        !!live &&
        Bus.isSameTelegramBusFollowerRegistration(live, follower!) &&
        [
          ...Bus.TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES,
          ...(heldSelected ? Bus.TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES : []),
        ].every((cap) => Bus.hasTelegramBusCapability(live.protocol, cap)) &&
        !!live.target &&
        live.target.chatId === binding.target.chatId &&
        (live.target.threadId === binding.target.threadId ||
          live.target.threadId === target.threadId) &&
        liveFollower!.getJournalBindingKey(live) === recipientJournalKey
      );
    };
    const getRecipient = (
      snapshot?: Readonly<
        Pick<Threads.TelegramTopicTargetFile, "threads" | "workspaceBindings">
      >,
    ) => {
      if (!recipientLifetime() || !followerCurrent()) return undefined;
      const live = (
        snapshot?.workspaceBindings ?? threads.listWorkspaceBindings()
      ).filter((value) => value.bindingKey === binding.bindingKey);
      const row = live[0];
      const owners = (snapshot?.threads ?? threads.list()).filter(
        (value) =>
          value.status === "active" &&
          (value.slot === binding.slot ||
            (row && isDeepStrictEqual(value.target, row.target))),
      );
      const owner = owners[0];
      return live.length === 1 &&
        row?.sessionId === binding.sessionId &&
        row.cwd === binding.cwd &&
        row.slot === binding.slot &&
        row.workspaceKey === binding.workspaceKey &&
        row.inactiveSinceMs === undefined &&
        (isDeepStrictEqual(row.target, binding.target) ||
          isDeepStrictEqual(row.target, target)) &&
        owners.length === 1 &&
        owner?.instanceId === recipient.instanceId &&
        owner.slot === binding.slot &&
        owner.profileKey === request.owner.profileKey &&
        isDeepStrictEqual(owner.owner, request.owner.owner) &&
        isDeepStrictEqual(owner.target, row.target)
        ? recipient
        : undefined;
    };
    const isApplied = () => {
      const local = ports.getLeaderIdentity();
      return (
        current() &&
        !!local &&
        local.slot === binding.slot &&
        isDeepStrictEqual(local.target, target)
      );
    };
    if (!current() || !getRecipient()) return undefined;
    let commandCurrent: (() => boolean) | undefined;
    const useLiveRecipientSnapshot =
      !!selection.nameCommand ||
      !!selection.confirmationCommand ||
      !!selection.extensionCommand;
    const assertRecipientCurrent = () => {
      let confirmed = false;
      if (isLeader && recipientLifetime()) {
        const intent = store
          .listLiveRebindings()
          .find((value) => value.request.operationId === request.operationId);
        if (
          intent?.phase === "released" &&
          !intent.cleanup &&
          isDeepStrictEqual(intent.request, request) &&
          intent.operatorUserId === operatorUserId &&
          isDeepStrictEqual(intent.executor, {
            instanceId,
            leaderEpoch: String(epoch),
          }) &&
          isDeepStrictEqual(intent.recipient, {
            kind: recipient.kind,
            instanceId: recipient.instanceId,
            sessionId: recipient.sessionId,
            generation: recipient.generation,
          })
        )
          (useLiveRecipientSnapshot
            ? threads.withWorkspaceLiveRebindSnapshot
            : threads.withWorkspaceRestoreSnapshot)(intent, (snapshot) => {
            const local = ports.getLeaderIdentity();
            confirmed =
              recipientLifetime() &&
              !!getRecipient(snapshot) &&
              !!local &&
              local.slot === binding.slot &&
              isDeepStrictEqual(local.target, target) &&
              snapshot.workspaceBindings?.some(
                (value) =>
                  value.bindingKey === binding.bindingKey &&
                  isDeepStrictEqual(value.target, target),
              ) === true;
          });
      }
      if (!confirmed || !recipientLifetime())
        throw new Error(
          "Live-rebind detached menu recipient authority changed.",
        );
    };
    const original = selection.messages[0],
      originalSnapshots = selection.messages.map(
        Updates.inspectTelegramDeferredSourceSnapshot,
      );
    if (
      originalSnapshots.some((snapshot) => !snapshot) ||
      (heldSelected &&
        (originalSnapshots.length !== 1 ||
          !Commands.isTelegramSelectedHeldOriginal(
            originalSnapshots[0]?.update,
            target,
            operatorUserId,
            heldSelected.name,
          )))
    )
      return undefined;
    let source = originalSnapshots[0]?.source;
    // Each selected owner gets a fresh fenced copy of the original, retargeted to the new Thread. These stay
    // closures because `source` is reassigned after a held selection is frozen.
    const retargetedOriginal = () => [
      Updates.carryTelegramUpdateExecutionFence(original, {
        ...original,
        message_thread_id: target.threadId,
        ...(original.message_thread_id === target.threadId
          ? {}
          : { message_id: 0, reply_to_message: undefined }),
      } as TMessage),
    ];
    const selectedPorts = (label: string) => ({
      assertSourceCurrent() {
        if (!commandCurrent?.())
          throw new Error(
            `Live-rebind selected ${label} source authority changed.`,
          );
      },
      assertRecipientCurrent,
      reportCompleted: () =>
        Updates.reportTelegramUpdateCompleted(original, source),
    });
    const menu =
      isLeader &&
      selection.menuCommand &&
      source &&
      commandHandler.prepareSelectedMenuCommand(
        selection.menuCommand,
        retargetedOriginal(),
        ctx,
        selectedPorts("menu"),
      );
    const abort =
      isLeader &&
      selection.abortCommand &&
      source &&
      commandHandler.prepareSelectedCommand(
        selection.abortCommand,
        retargetedOriginal(),
        ctx,
        selectedPorts("abort"),
      );
    const next =
      isLeader &&
      selection.nextCommand &&
      source &&
      commandHandler.prepareSelectedCommand(
        selection.nextCommand,
        retargetedOriginal(),
        ctx,
        selectedPorts("next"),
      );
    const stop =
      isLeader &&
      selection.stopCommand &&
      source &&
      commandHandler.prepareSelectedCommand(
        selection.stopCommand,
        retargetedOriginal(),
        ctx,
        selectedPorts("stop"),
      );
    const help =
      isLeader &&
      selection.helpCommand &&
      source &&
      (selection.helpCommand.name === "start"
        ? commandHandler.prepareSelectedStartCommand
        : commandHandler.prepareSelectedHelpCommand)(
        selection.helpCommand,
        retargetedOriginal(),
        ctx,
        selectedPorts("help/start"),
      );
    const sourceFence =
      original && Updates.getTelegramUpdateExecutionFence(original);
    let releaseSelectedSource: (() => void) | undefined;
    const finishSelectedSource = () => {
      const release = releaseSelectedSource;
      releaseSelectedSource = undefined;
      release?.();
    };
    const originalUnchanged = () =>
      Updates.getTelegramUpdateExecutionFence(original) === sourceFence &&
      sourceFence?.isCurrent() === true &&
      isDeepStrictEqual(
        Updates.inspectTelegramDeferredSource(original),
        source,
      );
    const reportSelectedCompleted = () => {
      try {
        return Updates.reportTelegramUpdateCompleted(original, source);
      } finally {
        finishSelectedSource();
      }
    };
    const name =
      isLeader &&
      selection.nameCommand &&
      source &&
      (selection.nameCommand.args.trim()
        ? commandHandler.prepareSelectedNameCommand
        : commandHandler.prepareSelectedNameDialogCommand)(
        selection.nameCommand,
        retargetedOriginal(),
        ctx,
        {
          assertSourceCurrent() {
            // Owner awaits may outlive chooser admission, but never the exact held original or its worker fence.
            if (
              !releaseSelectedSource ||
              !recipientLifetime() ||
              !isDeepStrictEqual(
                getLiveRebindName(selection.messages),
                selection.nameCommand,
              )
            )
              throw new Error(
                "Live-rebind selected name source authority changed (lifetime or syntax).",
              );
            if (
              Updates.getTelegramUpdateExecutionFence(original) !==
                sourceFence ||
              sourceFence?.isCurrent() !== true
            )
              throw new Error(
                "Live-rebind selected name source authority changed (execution).",
              );
            if (
              !isDeepStrictEqual(
                Updates.inspectTelegramDeferredSource(original),
                source,
              )
            )
              throw new Error(
                "Live-rebind selected name source authority changed (original).",
              );
          },
          assertRecipientCurrent,
          reportCompleted: reportSelectedCompleted,
        },
      );
    const captureConfirmationRecipient =
      deps.captureThreadNameRecipientAuthority;
    let confirmationRecipient: (() => void) | undefined;
    const confirmation =
      isLeader &&
      selection.confirmationCommand &&
      source &&
      (selection.confirmationCommand.name === "new"
        ? commandHandler.prepareSelectedNewCommand
        : commandHandler.prepareSelectedCompactCommand)(
        selection.confirmationCommand,
        retargetedOriginal(),
        ctx,
        {
          assertSourceCurrent() {
            if (
              !releaseSelectedSource ||
              !recipientLifetime() ||
              !isDeepStrictEqual(
                getLiveRebindConfirmation(selection.messages),
                selection.confirmationCommand,
              ) ||
              !originalUnchanged()
            )
              throw new Error(
                "Live-rebind selected confirmation source authority changed.",
              );
          },
          assertRecipientCurrent() {
            assertRecipientCurrent();
            if (!confirmationRecipient)
              throw new Error(
                "Live-rebind confirmation recipient capture is unavailable.",
              );
            confirmationRecipient();
            assertRecipientCurrent();
          },
          reportCompleted: reportSelectedCompleted,
        },
      );
    let extensionIssued = false,
      extensionRecipient: (() => void) | undefined;
    let extension: (() => Promise<void>) | undefined;
    let generated:
      | {
          continue(
            messages: readonly TMessage[],
            isCurrent: () => boolean,
          ): Promise<boolean>;
          observe(): boolean;
        }
      | undefined;
    if (selection.extensionCommand) {
      // Establish authenticated preparation and execution owners before any source freeze or binding effect.
      if (!isLeader || !source || !deps.captureThreadNameRecipientAuthority)
        return undefined;
      const preparationRecipient = deps.captureThreadNameRecipientAuthority(
        { ...binding.target },
        ctx,
      );
      if (!preparationRecipient) return undefined;
      const assertExtensionSource = () => {
        if (
          !(extensionIssued
            ? !!releaseSelectedSource && recipientLifetime()
            : current()) ||
          !isDeepStrictEqual(
            getLiveRebindExtension(selection.messages),
            selection.extensionCommand,
          ) ||
          !originalUnchanged()
        )
          throw new Error(
            "Live-rebind selected extension source authority changed.",
          );
      };
      const assertExtensionRecipient = () => {
        if (!extensionIssued) {
          if (!current() || !getRecipient())
            throw new Error(
              "Live-rebind extension preparation recipient changed.",
            );
          preparationRecipient();
          if (!current() || !getRecipient())
            throw new Error(
              "Live-rebind extension preparation recipient changed.",
            );
          return;
        }
        assertRecipientCurrent();
        if (!extensionRecipient)
          throw new Error(
            "Live-rebind extension recipient capture is unavailable.",
          );
        extensionRecipient();
        assertRecipientCurrent();
      };
      const prepared = await Commands.prepareTelegramSelectedExtensionCommand(
        selection.extensionCommand,
        {
          assertSourceCurrent: assertExtensionSource,
          assertRecipientCurrent: assertExtensionRecipient,
        },
      );
      if (!prepared) return undefined;
      extensionRegistrationCurrent = prepared.assertRegistrationCurrent;
      selection.extensionKind = prepared.plan.kind;
      if (prepared.plan.kind === "command-only") {
        extension = commandHandler.prepareSelectedExtensionCommand(
          prepared,
          retargetedOriginal(),
          ctx,
          {
            assertSourceCurrent: assertExtensionSource,
            assertRecipientCurrent: assertExtensionRecipient,
            reportCompleted: reportSelectedCompleted,
          },
        );
      } else {
        const receiptOwner =
            Updates.prepareTelegramDeferredQueueAdmission(original),
          preparedSource = { ...source };
        if (!receiptOwner?.isCurrent()) return undefined;
        const plan = prepared.plan;
        let admittedTurn: Queue.PendingTelegramTurn | undefined;
        generated = {
          async continue(messages, isCurrent) {
            await continueLiveRebindInput(messages, ctx, target, isCurrent, {
              prompt: plan.prompt,
              assertRegistrationCurrent: prepared.assertRegistrationCurrent,
              onQueued(turn) {
                admittedTurn = structuredClone(turn);
              },
            });
            return generated!.observe();
          },
          observe() {
            try {
              if (!admittedTurn || !current() || !receiptOwner.isCurrent())
                return false;
              prepared.assertRegistrationCurrent();
              assertRecipientCurrent();
              const receipt = admittedTurn.admissionReceipts?.[0];
              const matches = deps.telegramQueueStore
                .getQueuedItems()
                .filter(
                  (item) =>
                    item.kind === "prompt" &&
                    item.admissionReceipts?.some((value) =>
                      isDeepStrictEqual(value, receipt),
                    ),
                );
              const turn = matches[0];
              if (
                !receipt ||
                matches.length !== 1 ||
                !turn ||
                turn.kind !== "prompt" ||
                turn.chatId !== admittedTurn.chatId ||
                turn.replyToMessageId !== admittedTurn.replyToMessageId ||
                turn.historyText !== admittedTurn.historyText ||
                !isDeepStrictEqual(turn.target, admittedTurn.target) ||
                !isDeepStrictEqual(turn.content, admittedTurn.content) ||
                !isDeepStrictEqual(
                  turn.sourceMessageIds,
                  admittedTurn.sourceMessageIds,
                ) ||
                !isDeepStrictEqual(
                  turn.admissionReceipts,
                  admittedTurn.admissionReceipts,
                )
              )
                return false;
              const proof = receiptOwner.inspectReceipt(receipt);
              if (
                !proof ||
                !isDeepStrictEqual(proof.source, preparedSource) ||
                proof.receipt.queueKind !== "prompt" ||
                proof.receipt.receiptId !== receipt.receiptId ||
                !isDeepStrictEqual(
                  proof.receipt.sourceUpdateIds,
                  request.source.updateIds,
                ) ||
                proof.receipt.queueOwner.instanceId !== recipient.instanceId ||
                proof.receipt.queueOwner.sessionGeneration !== generation
              )
                return false;
              assertRecipientCurrent();
              return current() && receiptOwner.isCurrent();
            } catch {
              return false;
            }
          },
        };
      }
      if ((!extension && !generated) || !current() || !getRecipient())
        return undefined;
    }
    if (
      !selectedCommand &&
      ((selection.menuCommand && !menu) ||
        (selection.abortCommand && !abort) ||
        (selection.nextCommand && !next) ||
        (selection.stopCommand && !stop) ||
        (selection.helpCommand && !help) ||
        (selection.nameCommand && !name) ||
        (selection.confirmationCommand && !confirmation))
    )
      return undefined;
    const completeCommand =
      menu ||
      abort ||
      next ||
      stop ||
      help ||
      name ||
      confirmation ||
      extension;
    const createCoordinator = () =>
      createTelegramLiveRebindCoordinator({
        request,
        messages: selection.messages,
        restoreStore: store,
        threadStore: threads,
        authority: {
          executor: { instanceId, leaderEpoch: String(epoch) },
          operatorUserId,
          isCurrent: current,
        },
        getRecipient,
        follower: isLeader
          ? undefined
          : {
              ...(selectedCommand ? { selectedCommand } : {}),
              async run(action) {
                const observation = await (
                  heldSelected ? followerRun! : liveFollower!.run
                ).call(liveFollower, action);
                if (
                  observation?.status === "applied" &&
                  current() &&
                  getRecipient() &&
                  "target" in observation &&
                  observation.operationId === request.operationId &&
                  observation.slot === binding.slot &&
                  isDeepStrictEqual(observation.target, target) &&
                  isDeepStrictEqual(
                    observation.sourceUpdateIds,
                    request.source.updateIds,
                  ) &&
                  isDeepStrictEqual(observation.recipient, {
                    instanceId: recipient.instanceId,
                    sessionId: recipient.sessionId,
                    generation: recipient.generation,
                    bindingKey: recipient.bindingKey,
                  })
                ) {
                  const intent = store
                    .listLiveRebindings()
                    .find(
                      (value) =>
                        value.request.operationId === request.operationId,
                    );
                  if (
                    intent &&
                    isDeepStrictEqual(intent.request, request) &&
                    intent.operatorUserId === operatorUserId &&
                    isDeepStrictEqual(intent.executor, {
                      instanceId,
                      leaderEpoch: String(epoch),
                    }) &&
                    !intent.cleanup &&
                    (intent.phase === "rebound" ||
                      intent.phase === "released") &&
                    isDeepStrictEqual(intent.recipient, {
                      kind: recipient.kind,
                      instanceId: recipient.instanceId,
                      sessionId: recipient.sessionId,
                      generation: recipient.generation,
                    })
                  )
                    threads.withWorkspaceRestoreSnapshot(intent, (snapshot) => {
                      if (!action.isCurrent() || !getRecipient(snapshot))
                        return;
                      const row = snapshot.workspaceBindings?.find(
                        (value) => value.bindingKey === binding.bindingKey,
                      );
                      const live = ports.followerRegistry.get(
                        recipient.instanceId,
                      );
                      if (live && row && isDeepStrictEqual(row.target, target))
                        ports.followerRegistry.register({
                          ...live,
                          target: { ...target },
                          connectedAtMs: live.connectedAtMs,
                        });
                    });
                }
                return observation;
              },
            },
        leader: isLeader
          ? {
              async apply(intent, mode, isCurrent) {
                threads.withWorkspaceRestoreSnapshot(intent, (snapshot) => {
                  if (!isCurrent() || !getRecipient(snapshot)) return;
                  const row = snapshot.workspaceBindings?.find(
                      (value) => value.bindingKey === binding.bindingKey,
                    ),
                    local = ports.getLeaderIdentity();
                  if (
                    !row ||
                    !isDeepStrictEqual(row.target, target) ||
                    !local ||
                    local.slot !== binding.slot ||
                    (!isDeepStrictEqual(local.target, binding.target) &&
                      !isDeepStrictEqual(local.target, target))
                  )
                    return;
                  if (
                    mode === "apply" &&
                    !isDeepStrictEqual(local.target, target) &&
                    intent.phase === "rebound" &&
                    isCurrent()
                  )
                    deps.setCurrentLeaderIdentity!({
                      target: { ...target },
                      slot: binding.slot,
                      threadName: request.owner.threadName,
                    });
                });
              },
              isApplied,
              ...(completeCommand
                ? {
                    complete(
                      _messages: readonly unknown[],
                      isCurrent: () => boolean,
                    ) {
                      commandCurrent = isCurrent;
                      if (name || confirmation || extension) {
                        if (!isCurrent())
                          throw new Error(
                            "Live-rebind selected command issuance authority changed.",
                          );
                        if (extension) {
                          extensionRecipient =
                            deps.captureThreadNameRecipientAuthority?.(
                              { ...target },
                              ctx,
                            );
                          if (!extensionRecipient)
                            throw new Error(
                              "Live-rebind extension recipient capture is unavailable.",
                            );
                          extensionRecipient();
                          if (!isCurrent())
                            throw new Error(
                              "Live-rebind selected extension issuance authority changed.",
                            );
                          extensionIssued = true;
                        }
                        if (confirmation) {
                          // Reuse only root recipient identity capture, never naming input/publication semantics.
                          confirmationRecipient =
                            captureConfirmationRecipient?.({ ...target }, ctx);
                          if (!confirmationRecipient)
                            throw new Error(
                              "Live-rebind confirmation recipient capture is unavailable.",
                            );
                          confirmationRecipient();
                          if (!isCurrent())
                            throw new Error(
                              "Live-rebind selected confirmation issuance authority changed.",
                            );
                        }
                        releaseSelectedSource =
                          Updates.acquireTelegramUpdateRouting(original);
                      }
                      void completeCommand()
                        .catch((error) => {
                          try {
                            deps.recordRuntimeEvent?.("routing", error, {
                              phase: extension
                                ? "live-rebind-selected-extension"
                                : confirmation
                                  ? `live-rebind-selected-${selection.confirmationCommand!.name}`
                                  : name
                                    ? "live-rebind-selected-name"
                                    : help
                                      ? `live-rebind-selected-${selection.helpCommand!.name}`
                                      : stop
                                        ? "live-rebind-selected-stop"
                                        : next
                                          ? "live-rebind-selected-next"
                                          : abort
                                            ? "live-rebind-selected-abort"
                                            : "live-rebind-selected-menu",
                            });
                          } catch {
                            /* Diagnostics cannot replay the issued command or reject detached work. */
                          }
                        })
                        .finally(() => {
                          if (name || confirmation || extension)
                            finishSelectedSource();
                        });
                    },
                  }
                : generated
                  ? {
                      continue: (
                        messages: readonly unknown[],
                        isCurrent: () => boolean,
                      ) =>
                        generated.continue(messages as TMessage[], isCurrent),
                      observeAdmission: generated.observe,
                    }
                  : selection.template || selection.continueCommand
                    ? {
                        continue(
                          messages: readonly unknown[],
                          isCurrent: () => boolean,
                        ) {
                          queueCurrent = isCurrent;
                          if (
                            !selectedQueue ||
                            messages.length !== selection.messages.length ||
                            messages.some(
                              (message, index) =>
                                message !== selection.messages[index],
                            )
                          )
                            return Promise.resolve(false);
                          return selectedQueue.execute();
                        },
                      }
                    : {
                        continue: (
                          messages: readonly unknown[],
                          isCurrent: () => boolean,
                        ) =>
                          continueLiveRebindInput(
                            messages as TMessage[],
                            ctx,
                            target,
                            isCurrent,
                          ),
                      }),
            }
          : undefined,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
    let coordinator:
      ReturnType<typeof createTelegramLiveRebindCoordinator> | undefined;
    let selectedQueue:
        | ReturnType<typeof commandHandler.prepareSelectedQueueCommand>
        | undefined,
      queueCurrent: (() => boolean) | undefined;
    return {
      operationId: request.operationId,
      selectedCommandReference: () => coordinator?.selectedCommandReference(),
      async advance() {
        if (!coordinator) {
          if (!current() || !getRecipient()) return "protected";
          // Selection may change only worker-owned clock metadata, never the prepared original payload.
          const selected = selection.messages.map(
            Updates.inspectTelegramDeferredSourceSnapshot,
          );
          if (
            !current() ||
            selected.length !== originalSnapshots.length ||
            selected.some(
              (snapshot, index) =>
                !snapshot ||
                snapshot.source.updateId !==
                  originalSnapshots[index]!.source.updateId ||
                snapshot.source.journalBindingKey !==
                  originalSnapshots[index]!.source.journalBindingKey ||
                JSON.stringify(snapshot.update) !==
                  JSON.stringify(originalSnapshots[index]!.update),
            )
          )
            return "protected";
          source = selected[0]!.source;
          const queuedCommand =
            selection.continueCommand ?? selection.template?.command;
          if (isLeader && queuedCommand) {
            selectedQueue = commandHandler.prepareSelectedQueueCommand(
              queuedCommand,
              selection.messages,
              ctx,
              {
                target,
                assertSourceCurrent() {
                  if (!queueCurrent?.() || !current())
                    throw new Error(
                      "Live-rebind selected queue source authority changed.",
                    );
                },
                assertRecipientCurrent,
              },
            );
            if (!selectedQueue) return "protected";
          }
          coordinator = createCoordinator();
        }
        return coordinator.advance();
      },
    };
  };
  function inspectLiveRebindRecipient(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
    mode: "work",
  ): Promise<Bus.TelegramBusLiveRebindWorkObservation | undefined>;
  function inspectLiveRebindRecipient(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
    mode: "cleanup" | "follower-cleanup",
  ): Promise<ThreadReconciler.TelegramLiveRebindCleanupPreparation | undefined>;
  function inspectLiveRebindRecipient(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
    mode: "issue" | "follower-issue",
  ): Promise<TelegramLiveRebindCleanupIssue | undefined>;
  async function inspectLiveRebindRecipient(
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
    mode: "work" | "cleanup" | "follower-cleanup" | "issue" | "follower-issue",
  ): Promise<
    | Bus.TelegramBusLiveRebindWorkObservation
    | ThreadReconciler.TelegramLiveRebindCleanupPreparation
    | TelegramLiveRebindCleanupIssue
    | undefined
  > {
    const ports = deps.workspaceRestoreRecipient,
      threads = deps.threadStore,
      store = deps.getWorkspaceRestoreStore?.();
    const followerMode =
        mode === "follower-cleanup" || mode === "follower-issue",
      cleanupMode = mode !== "work";
    const issueMode = mode === "issue" || mode === "follower-issue",
      callApi = deps.callApi;
    const collector = ports?.observeLeaderWork,
      peer = ports?.liveFollower,
      peerRun = peer?.run,
      peerJournal = peer?.getJournalBindingKey;
    const run = deps.runWorkspaceOperation;
    if (
      !ports ||
      !threads ||
      !store ||
      (followerMode ? !peer || !peerRun || !peerJournal : !collector) ||
      !run ||
      (issueMode && !callApi) ||
      deps.isContextActive?.(ctx) !== true
    )
      return undefined;
    try {
      const expected = structuredClone(intent),
        { request, recipient, executor } = expected;
      const instanceId = deps.getCurrentInstanceId?.(),
        epoch = deps.getCurrentLeaderEpoch?.(),
        generation = deps.getSessionGeneration?.();
      const operatorUserId = deps.configStore.getAllowedUserId(),
        scope = deps.getAdmissionScope?.(),
        journalBindingKey = deps.getAdmissionJournalBinding?.();
      const sessionId = ports.getSessionId(ctx),
        cwd = ports.getCwd(ctx),
        snapshot = threads.withWorkspaceLiveRebindSnapshot;
      const protection = threads.isWorkspaceLiveRebindCleanupTargetProtected;
      if (cleanupMode && typeof protection !== "function") return undefined;
      const registered = followerMode
        ? ports.followerRegistry.get(recipient.instanceId)
        : undefined;
      const follower = registered && structuredClone(registered),
        registry = ports.followerRegistry;
      const recipientJournalKey = follower && peerJournal?.call(peer, follower);
      // The selected-status reference lives only while its chooser record does; absence keeps the generic request.
      const findReference = () => {
        if (!followerMode) return undefined;
        const found = [...pendingUnboundReroutes.values()]
          .map((pending) =>
            pending.liveRebind?.coordinator?.selectedCommandReference(),
          )
          .filter((value) => value?.operationId === request.operationId);
        return found.length === 1 ? found[0] : undefined;
      };
      const reference = findReference();
      const referenceMarker = reference?.selectedCommand;
      if (
        reference &&
        (request.source.updateIds.length !== 1 ||
          !referenceMarker ||
          !isDeepStrictEqual(referenceMarker.target, request.target) ||
          reference.preparedSource.updateId !== request.source.updateIds[0] ||
          reference.preparedSource.journalBindingKey !== recipientJournalKey)
      )
        return undefined;
      if (
        expected.kind !== "live-rebind" ||
        expected.phase !== "released" ||
        expected.cleanup ||
        recipient.kind !== (followerMode ? "follower" : "leader") ||
        !instanceId ||
        epoch === undefined ||
        generation === undefined ||
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        !scope ||
        !journalBindingKey ||
        !sessionId ||
        !cwd ||
        operatorUserId !== expected.operatorUserId ||
        executor.instanceId !== instanceId ||
        executor.leaderEpoch !== String(epoch) ||
        request.source.journalBindingKey !== journalBindingKey ||
        request.binding.sessionId !== recipient.sessionId ||
        !request.binding.slot ||
        request.owner.instanceId !== recipient.instanceId ||
        (followerMode
          ? request.owner.owner?.kind !== "manual-follower" ||
            !follower?.registrationGeneration ||
            !follower.profileKey ||
            follower.profileKey !== request.owner.profileKey ||
            follower.sessionId !== recipient.sessionId ||
            follower.registrationGeneration !== recipient.generation ||
            !follower.cwd ||
            WorkspaceIdentity.normalizeTelegramWorkspacePath(follower.cwd) !==
              request.binding.cwd ||
            follower.slot !== request.binding.slot ||
            !follower.busSocketPath ||
            !recipientJournalKey ||
            recipientJournalKey === follower.profileKey
          : recipient.instanceId !== instanceId ||
            recipient.sessionId !== sessionId ||
            recipient.generation !== String(generation) ||
            request.owner.owner?.kind !== "leader" ||
            WorkspaceIdentity.normalizeTelegramWorkspacePath(cwd) !==
              request.binding.cwd)
      )
        return undefined;
      const followerCurrent = () => {
        if (!followerMode) return true;
        const live = registry.get(recipient.instanceId);
        return (
          ports.followerRegistry === registry &&
          ports.liveFollower === peer &&
          peer?.run === peerRun &&
          peer?.getJournalBindingKey === peerJournal &&
          !!live &&
          Bus.isSameTelegramBusFollowerRegistration(live, follower!) &&
          Bus.TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES.every((cap) =>
            Bus.hasTelegramBusCapability(live.protocol, cap),
          ) &&
          !!live.target &&
          live.target.chatId === request.target.chatId &&
          live.target.threadId === request.target.threadId &&
          peerJournal!.call(peer, live) === recipientJournalKey &&
          isDeepStrictEqual(findReference(), reference)
        );
      };
      const current = () =>
        deps.hasWorkspaceLiveRebindAuthority?.() === true &&
        deps.isContextActive?.(ctx) === true &&
        deps.workspaceRestoreRecipient === ports &&
        (followerMode || ports.observeLeaderWork === collector) &&
        deps.threadStore === threads &&
        threads.withWorkspaceLiveRebindSnapshot === snapshot &&
        (!cleanupMode ||
          threads.isWorkspaceLiveRebindCleanupTargetProtected === protection) &&
        deps.getWorkspaceRestoreStore?.() === store &&
        deps.runWorkspaceOperation === run &&
        deps.getCurrentInstanceId?.() === instanceId &&
        deps.getCurrentLeaderEpoch?.() === epoch &&
        deps.getSessionGeneration?.() === generation &&
        deps.getAdmissionScope?.() === scope &&
        deps.getAdmissionJournalBinding?.() === journalBindingKey &&
        (!issueMode || deps.callApi === callApi) &&
        deps.configStore.getAllowedUserId() === operatorUserId &&
        ports.getSessionId(ctx) === sessionId &&
        ports.getCwd(ctx) === cwd &&
        followerCurrent();
      // After the issue marker, the exact issued row (not the released original) is the canonical evidence.
      const assertCanonical = (
        row: Threads.TelegramWorkspaceLiveRebindIntent = expected,
      ) => {
        if (!current())
          throw new Error("Live-rebind work recipient authority changed.");
        let confirmed = false;
        snapshot.call(threads, row, (view) => {
          const found = findRelocatedBindingOwner(view, request),
            local = followerMode
              ? registry.get(recipient.instanceId)
              : ports.getLeaderIdentity();
          confirmed =
            current() &&
            !!found &&
            found.row.workspaceKey === request.binding.workspaceKey &&
            found.owner.instanceId === recipient.instanceId &&
            isDeepStrictEqual(found.owner.owner, request.owner.owner) &&
            !!local &&
            local.slot === request.binding.slot &&
            local.target?.chatId === request.target.chatId &&
            local.target.threadId === request.target.threadId;
        });
        if (!confirmed || !current())
          throw new Error(
            "Live-rebind work canonical/local recipient changed.",
          );
      };
      const sample = async () => {
        assertCanonical();
        if (cleanupMode && protection.call(threads, expected) !== false)
          return undefined;
        const target = { ...request.binding.target };
        let value: Bus.TelegramBusLiveRebindWorkState | undefined;
        if (followerMode) {
          const observation = await peerRun!.call(peer, {
            operationId: request.operationId,
            instanceId: recipient.instanceId,
            sessionId: recipient.sessionId,
            recipientBindingKey: recipientJournalKey!,
            mode: "observe",
            sourceUpdateIds: [...request.source.updateIds],
            slot: request.binding.slot!,
            target: { ...request.target },
            oldTarget: target,
            isCurrent: current,
            ...(reference
              ? {
                  selectedCommand: structuredClone(reference.selectedCommand),
                  preparedSource: { ...reference.preparedSource },
                }
              : {}),
          });
          assertCanonical();
          if (
            observation?.status !== "observed" ||
            observation.operationId !== request.operationId ||
            !isDeepStrictEqual(
              observation.selectedCommand,
              reference?.selectedCommand,
            ) ||
            !isDeepStrictEqual(
              observation.preparedSource,
              reference?.preparedSource,
            ) ||
            !isDeepStrictEqual(observation.oldTarget, request.binding.target) ||
            !isDeepStrictEqual(
              observation.sourceUpdateIds,
              request.source.updateIds,
            ) ||
            !isDeepStrictEqual(observation.recipient, {
              instanceId: recipient.instanceId,
              sessionId: recipient.sessionId,
              generation: recipient.generation,
              bindingKey: recipientJournalKey,
            })
          )
            return undefined;
          value = observation.work;
        } else value = collector!(target, ctx);
        const work = {
          sessionBusy: value?.sessionBusy,
          targetWork: value?.targetWork,
          deliveryPending: value?.deliveryPending,
          unknown: value?.unknown,
        };
        if (
          !isDeepStrictEqual(target, request.binding.target) ||
          Object.values(work).some((flag) => typeof flag !== "boolean")
        )
          throw new Error(
            "Live-rebind work sample is unavailable or changed target.",
          );
        assertCanonical();
        if (cleanupMode) {
          const prepared = ThreadReconciler.prepareLiveRebindThreadCleanup({
            operationId: request.operationId,
            oldTarget: request.binding.target,
            recipientTarget: request.target,
            leaderEpoch: executor.leaderEpoch,
            targetProtected: protection.call(threads, expected),
            work,
          });
          assertCanonical();
          return prepared;
        }
        return {
          status: "observed" as const,
          operationId: request.operationId,
          recipient: {
            instanceId,
            sessionId,
            generation: String(generation),
            bindingKey: journalBindingKey,
          },
          sourceUpdateIds: [...request.source.updateIds],
          oldTarget: { ...request.binding.target },
          work,
        };
      };
      if (!current()) return undefined;
      if (issueMode) {
        // One admission spans the fresh sample, durable issue marker, single deletion and terminal record.
        return await run(
          {
            operationId: `live-${mode}-${randomBytes(16).toString("hex")}`,
            operationKind: "workspace.live-rebind-cleanup",
            scopes: [{ kind: "profile" }],
          },
          async (): Promise<TelegramLiveRebindCleanupIssue | undefined> => {
            const prepared = await sample();
            if (
              !prepared ||
              prepared.status !== "prepared" ||
              !current() ||
              protection.call(threads, expected) !== false
            )
              return { status: "not-ready" };
            const authority = {
              executor: structuredClone(executor),
              operatorUserId: expected.operatorUserId,
              isCurrent: current,
            };
            const grant = store.advanceLiveRebind(
              expected,
              "issue-cleanup",
              authority,
            );
            if (!grant) return undefined;
            const assertGranted = () => assertCanonical(grant);
            const cleanup = await ThreadReconciler.issueLiveRebindThreadCleanup(
              prepared,
              {
                assertCurrent: assertGranted,
                deleteTopic: (target) =>
                  callApi!(
                    "deleteForumTopic",
                    {
                      chat_id: target.chatId,
                      message_thread_id: target.threadId,
                    },
                    { maxAttempts: 1, assertAuthority: assertGranted },
                  ),
                classifyFailure: classifyLiveRebindCleanupFailure,
              },
            );
            let recorded = false;
            try {
              recorded = !!store.advanceLiveRebind(grant, cleanup, authority);
            } catch (error) {
              deps.recordRuntimeEvent?.("routing", error, {
                phase: "live-rebind-cleanup-terminal",
              });
            }
            return {
              status: "finished",
              operationId: request.operationId,
              cleanup,
              recorded,
            };
          },
        );
      }
      const observation = await run(
        {
          operationId: `live-${mode}-${randomBytes(16).toString("hex")}`,
          operationKind: "workspace.live-rebind-observe",
          scopes: [{ kind: "profile" }],
        },
        async () => sample(),
      );
      assertCanonical();
      // Admission release is an await too. Recollect for refusal only; the returned candidate retains no lease or issuance authority.
      return cleanupMode && observation ? sample() : observation;
    } catch (error) {
      try {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: issueMode
            ? "live-rebind-cleanup-issuance"
            : cleanupMode
              ? "live-rebind-cleanup-preparation"
              : "live-rebind-work-observation",
        });
      } catch {
        /* Diagnostics cannot turn missing work evidence into idle or an effect grant. */
      }
      return undefined;
    }
  }
  const observeLiveRebindLeaderWork = (
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ) => inspectLiveRebindRecipient(intent, ctx, "work");
  const prepareLiveRebindLeaderCleanup = (
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ) => inspectLiveRebindRecipient(intent, ctx, "cleanup");
  const prepareLiveRebindFollowerCleanup = (
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ) => inspectLiveRebindRecipient(intent, ctx, "follower-cleanup");
  const issueLiveRebindLeaderCleanup = (
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ) => inspectLiveRebindRecipient(intent, ctx, "issue");
  const issueLiveRebindFollowerCleanup = (
    intent: Threads.TelegramWorkspaceLiveRebindIntent,
    ctx: TContext,
  ) => inspectLiveRebindRecipient(intent, ctx, "follower-issue");
  // One pacing chain per operation: a waiting timer or a running attempt; repeated choices never start another.
  const liveRebindCleanupChains = new Map<
    string,
    ReturnType<typeof setTimeout> | "running"
  >();
  /** End an unissued attempt honestly under fresh admission and current operator authority; no executor grant is borrowed. */
  const terminalizeUnissuedLiveRebindCleanup = async (
    operationId: string,
    ctx: TContext,
  ): Promise<void> => {
    const run = deps.runWorkspaceOperation,
      store = deps.getWorkspaceRestoreStore?.();
    const instanceId = deps.getCurrentInstanceId?.(),
      epoch = deps.getCurrentLeaderEpoch?.(),
      operatorUserId = deps.configStore.getAllowedUserId();
    if (
      !run ||
      !store ||
      !instanceId ||
      epoch === undefined ||
      operatorUserId === undefined
    )
      return;
    const current = () =>
      deps.isContextActive?.(ctx) === true &&
      deps.getWorkspaceRestoreStore?.() === store &&
      deps.getCurrentInstanceId?.() === instanceId &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      deps.configStore.getAllowedUserId() === operatorUserId;
    await run(
      {
        operationId: `live-cleanup-expiry-${randomBytes(16).toString("hex")}`,
        operationKind: "workspace.live-rebind-cleanup",
        scopes: [{ kind: "profile" }],
      },
      async () => {
        const intent = store
          .listLiveRebindings()
          .find((value) => value.request.operationId === operationId);
        if (
          !current() ||
          intent?.phase !== "released" ||
          intent.cleanup !== undefined ||
          intent.operatorUserId !== operatorUserId
        )
          return;
        store.advanceLiveRebind(intent, "not-issued", {
          executor: { instanceId, leaderEpoch: String(epoch) },
          operatorUserId,
          isCurrent: current,
        });
      },
    );
  };
  /**
   * Bounded best-effort pacing after a confirmed release. Each attempt is a fresh `issue*` call; `not-ready` waits,
   * a finished outcome or an inactive session stops, and the window ends in `not-issued` so no released row becomes a
   * permanent rebinding blocker. Waiting timers never join settlement; only a running attempt does.
   */
  const scheduleLiveRebindCleanup = (
    operationId: string,
    role: "leader" | "follower",
    ctx: TContext,
    startedAtMs = Date.now(),
    attempt = 0,
  ): void => {
    const pacing = deps.liveRebindCleanupSchedule;
    const chain = liveRebindCleanupChains.get(operationId);
    if (
      !pacing ||
      (attempt === 0 ? chain !== undefined : chain !== "running") ||
      deps.isContextActive?.(ctx) !== true
    ) {
      if (attempt > 0 && chain === "running")
        liveRebindCleanupChains.delete(operationId);
      return;
    }
    const timer = setTimeout(() => {
      if (liveRebindCleanupChains.get(operationId) !== timer) return;
      liveRebindCleanupChains.set(operationId, "running");
      let continued = false;
      const task = (async () => {
        if (deps.isContextActive?.(ctx) !== true) return;
        const intent = deps
          .getWorkspaceRestoreStore?.()
          ?.listLiveRebindings()
          .find((value) => value.request.operationId === operationId);
        if (intent?.phase !== "released" || intent.cleanup !== undefined)
          return;
        const result =
          role === "leader"
            ? await issueLiveRebindLeaderCleanup(intent, ctx)
            : await issueLiveRebindFollowerCleanup(intent, ctx);
        if (
          result?.status === "finished" ||
          deps.isContextActive?.(ctx) !== true
        )
          return;
        if (Date.now() - startedAtMs >= pacing.windowMs)
          return terminalizeUnissuedLiveRebindCleanup(operationId, ctx);
        continued = true;
        scheduleLiveRebindCleanup(
          operationId,
          role,
          ctx,
          startedAtMs,
          attempt + 1,
        );
      })()
        .catch((error) =>
          deps.recordRuntimeEvent?.("routing", error, {
            phase: "live-rebind-cleanup-schedule",
          }),
        )
        .finally(() => {
          if (
            !continued &&
            liveRebindCleanupChains.get(operationId) === "running"
          )
            liveRebindCleanupChains.delete(operationId);
        });
      restoreSettlementTasks.add(task);
      void task.finally(() => restoreSettlementTasks.delete(task));
    }, pacing.delaysMs[attempt] ?? pacing.intervalMs);
    timer.unref?.();
    liveRebindCleanupChains.set(operationId, timer);
  };
  const restoreWorkspace = deps.workspaceRestoreRecipient
    ? async (input: {
        operationId: string;
        record: Threads.TelegramTopicTargetRecord;
        target: Threads.TelegramTopicTargetRecord["target"];
        messages: readonly TMessage[];
        ctx: TContext;
        isCurrent: () => boolean;
        dispatch: (
          recipient: { kind: "leader" | "follower"; instanceId: string },
          isRecipientCurrent: () => boolean,
          recordForwardAcceptance: (
            message: TMessage,
            delivery: Bus.TelegramBusFollowerDeliveryIdentity,
          ) => Updates.TelegramDeferredSourceEvidence,
          recordLocalAcceptance: (
            message: TMessage,
          ) => Updates.TelegramDeferredSourceEvidence,
        ) => Promise<boolean>;
      }) => {
        const ports = deps.workspaceRestoreRecipient!;
        const threads = deps.threadStore;
        if (
          !threads ||
          !deps.getWorkspaceRestoreStore ||
          !deps.getSessionGeneration ||
          !deps.hasWorkspaceRestoreAuthority?.() ||
          !input.isCurrent() ||
          input.target.threadId === undefined
        )
          return "protected";
        const instanceId = deps.getCurrentInstanceId?.(),
          epoch = deps.getCurrentLeaderEpoch?.();
        const operatorUserId = deps.configStore.getAllowedUserId(),
          scope = deps.getAdmissionScope?.();
        const journalBindingKey = deps.getAdmissionJournalBinding?.(),
          generation = deps.getSessionGeneration();
        const sourceIds = Updates.collectTelegramAdmissionSourceUpdateIds(
          input.messages,
        );
        if (
          !instanceId ||
          epoch === undefined ||
          operatorUserId === undefined ||
          !scope ||
          !journalBindingKey ||
          !sourceIds.length
        )
          return "protected";
        const current = (): boolean =>
          input.isCurrent() &&
          deps.hasWorkspaceRestoreAuthority?.() === true &&
          deps.isContextActive?.(input.ctx) !== false &&
          deps.getSessionGeneration?.() === generation &&
          deps.getCurrentInstanceId?.() === instanceId &&
          deps.getCurrentLeaderEpoch?.() === epoch &&
          deps.getAdmissionScope?.() === scope &&
          deps.getAdmissionJournalBinding?.() === journalBindingKey &&
          deps.configStore.getAllowedUserId() === operatorUserId;
        await threads.load();
        if (!current()) return "protected";
        const store = deps.getWorkspaceRestoreStore();
        if (!store) return "protected";
        const retained = store
          .list()
          .find((value) => value.request.operationId === input.operationId);
        const bindings = threads
          .listWorkspaceBindings()
          .filter((value) =>
            isDeepStrictEqual(value.target, input.record.target),
          );
        const binding =
          retained?.request.binding ??
          (bindings.length === 1 ? bindings[0] : undefined);
        if (!binding || !binding.sessionId || !binding.slot) return "protected";
        const { sessionId, slot } = binding;
        const request: Threads.TelegramWorkspaceRestoreRequest = {
          operationId: input.operationId,
          binding,
          owner: structuredClone(input.record),
          target: {
            chatId: input.target.chatId,
            threadId: input.target.threadId,
          },
          source: { journalBindingKey, updateIds: sourceIds },
        };
        if (retained && !isDeepStrictEqual(retained.request, request))
          return "protected";
        const getRecipient = (
          snapshot?: Readonly<
            Pick<
              Threads.TelegramTopicTargetFile,
              "threads" | "workspaceBindings"
            >
          >,
        ): Threads.TelegramWorkspaceRestoreRecipient | undefined => {
          if (!current()) return undefined;
          const liveBindings = (
            snapshot
              ? (snapshot.workspaceBindings ?? [])
              : threads.listWorkspaceBindings()
          ).filter((value) => value.bindingKey === binding.bindingKey);
          const live = liveBindings[0];
          if (
            liveBindings.length !== 1 ||
            live?.sessionId !== binding.sessionId ||
            live.cwd !== binding.cwd ||
            live.slot !== binding.slot ||
            live.inactiveSinceMs !== undefined ||
            (!isDeepStrictEqual(live.target, binding.target) &&
              !isDeepStrictEqual(live.target, request.target))
          )
            return undefined;
          const records = (snapshot ? snapshot.threads : threads.list()).filter(
            (value) =>
              value.status === "active" &&
              (value.slot === binding.slot ||
                isDeepStrictEqual(value.target, live.target)),
          );
          const record = records[0];
          if (
            records.length !== 1 ||
            record?.slot !== binding.slot ||
            !isDeepStrictEqual(record.target, live.target)
          )
            return undefined;
          if (
            record.owner?.kind === "leader" &&
            record.instanceId === instanceId
          ) {
            const cwd = ports.getCwd(input.ctx);
            if (
              ports.getSessionId(input.ctx) !== sessionId ||
              !cwd ||
              WorkspaceIdentity.normalizeTelegramWorkspacePath(cwd) !==
                binding.cwd ||
              !deps.setCurrentLeaderIdentity
            )
              return undefined;
            return {
              kind: "leader",
              instanceId,
              sessionId,
              generation: String(generation),
            };
          }
          if (record.owner?.kind !== "manual-follower" || !record.instanceId)
            return undefined;
          const follower = ports.followerRegistry.get(record.instanceId);
          if (
            !follower?.registrationGeneration ||
            !follower.cwd ||
            follower.sessionId !== sessionId ||
            WorkspaceIdentity.normalizeTelegramWorkspacePath(follower.cwd) !==
              binding.cwd ||
            follower.slot !== slot ||
            !Bus.hasTelegramBusCapability(
              follower.protocol,
              Bus.TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
            )
          )
            return undefined;
          return {
            kind: "follower",
            instanceId: follower.instanceId,
            sessionId,
            generation: follower.registrationGeneration,
          };
        };
        const hasCommittedTarget = (): boolean =>
          threads
            .listWorkspaceBindings()
            .some(
              (value) =>
                value.bindingKey === binding.bindingKey &&
                isDeepStrictEqual(value.target, request.target),
            );
        const authority = {
          executor: { instanceId, leaderEpoch: String(epoch) },
          operatorUserId,
          isCurrent: current,
        };
        const ready = await advanceTelegramWorkspaceRestore({
          request,
          authority,
          restoreStore: store,
          getRecipient,
          async runRecipient(action) {
            const recipient = getRecipient();
            if (!recipient || !action.isCurrent() || !hasCommittedTarget())
              return undefined;
            if (recipient.kind === "follower") {
              const follower = ports.followerRegistry.get(recipient.instanceId);
              const observation = await ports.runFollower({
                operationId: request.operationId,
                instanceId: recipient.instanceId,
                sessionId: recipient.sessionId,
                slot: binding.slot!,
                target: request.target,
                oldTarget: binding.target,
                mode: action.mode,
                isCurrent: action.isCurrent,
              });
              if (!action.isCurrent() || !hasCommittedTarget())
                return undefined;
              if (!follower || !observation?.ready) return observation;
              if (
                observation.operationId !== request.operationId ||
                !isDeepStrictEqual(observation.recipient, recipient) ||
                !isDeepStrictEqual(observation.target, request.target) ||
                observation.slot !== binding.slot
              )
                return undefined;
              const actual = ports.followerRegistry.get(recipient.instanceId);
              if (
                !actual ||
                actual.registrationGeneration !==
                  follower.registrationGeneration ||
                actual.sessionId !== follower.sessionId ||
                actual.cwd !== follower.cwd ||
                actual.slot !== follower.slot ||
                actual.profileKey !== follower.profileKey ||
                actual.busSocketPath !== follower.busSocketPath ||
                !isDeepStrictEqual(actual.target, follower.target) ||
                !isDeepStrictEqual(actual.protocol, follower.protocol)
              )
                return undefined;
              threads.commitWorkspaceRestoreRegistration(
                {
                  target: request.target,
                  bindingKey: binding.bindingKey,
                  slot: binding.slot,
                },
                () => {
                  if (!action.isCurrent())
                    throw new Error(
                      "Workspace Restore recipient authority changed.",
                    );
                  ports.followerRegistry.register({
                    ...actual,
                    target: request.target,
                    connectedAtMs: actual.connectedAtMs,
                  });
                },
              );
              return observation;
            }
            let observation: Awaited<
              ReturnType<
                Parameters<
                  typeof advanceTelegramWorkspaceRestore
                >[0]["runRecipient"]
              >
            >;
            threads.withWorkspaceRestoreSnapshot(action.intent, (snapshot) => {
              if (
                !action.isCurrent() ||
                !isDeepStrictEqual(getRecipient(snapshot), recipient)
              )
                return;
              const live = snapshot.workspaceBindings?.find(
                (value) => value.bindingKey === binding.bindingKey,
              );
              if (!live || !isDeepStrictEqual(live.target, request.target))
                return;
              const local = ports.getLeaderIdentity();
              if (
                !local ||
                local.slot !== binding.slot ||
                (!isDeepStrictEqual(local.target, binding.target) &&
                  !isDeepStrictEqual(local.target, request.target))
              )
                return;
              if (
                action.mode === "apply" &&
                !isDeepStrictEqual(local.target, request.target)
              ) {
                if (
                  action.intent.phase !== "recipient-issued" ||
                  !action.isCurrent()
                )
                  return;
                deps.setCurrentLeaderIdentity!({
                  target: request.target,
                  slot: binding.slot,
                  threadName: request.owner.threadName,
                });
              }
              if (
                !action.isCurrent() ||
                !isDeepStrictEqual(getRecipient(snapshot), recipient)
              )
                return;
              const observed = ports.getLeaderIdentity();
              if (!observed || observed.slot !== binding.slot) return;
              observation = {
                operationId: request.operationId,
                recipient,
                target: observed.target as typeof request.target,
                slot: binding.slot!,
                ready: isDeepStrictEqual(observed.target, request.target),
              };
            });
            return observation;
          },
        }).catch((error) => {
          deps.recordRuntimeEvent?.("telegram", error, {
            phase: "workspace-restore-recipient",
          });
          return undefined;
        });
        if (!ready || !current() || ready.routing) return "protected";
        const recipient = ready.readyRecipient ?? ready.recipient;
        const recipientCurrent = (): boolean => {
          if (
            !current() ||
            !recipient ||
            !hasCommittedTarget() ||
            !isDeepStrictEqual(getRecipient(), recipient)
          )
            return false;
          const observed =
            recipient.kind === "leader"
              ? ports.getLeaderIdentity()
              : ports.followerRegistry.get(recipient.instanceId);
          return (
            observed?.slot === slot &&
            isDeepStrictEqual(observed.target, request.target)
          );
        };
        if (!recipient || !recipientCurrent()) return "protected";
        if (deps.callApi) {
          try {
            await deps.callApi("editForumTopic", {
              chat_id: request.target.chatId,
              message_thread_id: request.target.threadId,
              name:
                deps.getDisplayTitle?.(request.target) ??
                ThreadNaming.getTelegramTopicTitleForThreadName(
                  getRestoredThreadName(request.owner, slot),
                  slot,
                ),
            });
          } catch (error) {
            deps.recordRuntimeEvent?.("telegram", error, {
              phase: "workspace-restore-title",
            });
          }
        }
        if (
          !recipientCurrent() ||
          !store.issueRouting(ready, {
            ...authority,
            isCurrent: recipientCurrent,
          })
        )
          return "protected";
        const recordAcceptance = (
          message: TMessage,
          delivery?: Bus.TelegramBusFollowerDeliveryIdentity,
        ): Updates.TelegramDeferredSourceEvidence => {
          if (
            !recipientCurrent() ||
            recipient.kind !== (delivery ? "follower" : "leader")
          )
            throw new Error("Workspace Restore acceptance authority changed.");
          const source = Updates.inspectTelegramDeferredSource(message);
          const follower = ports.followerRegistry.get(recipient.instanceId);
          const ownership = deps.getTargetOwnership?.(request.target);
          if (
            !source ||
            source.journalBindingKey !== journalBindingKey ||
            !request.source.updateIds.includes(source.updateId) ||
            (delivery &&
              (!follower ||
                ownership?.instanceId !== recipient.instanceId ||
                ownership.ownerGeneration !== recipient.generation ||
                !ownership.recipientBindingKey ||
                delivery.sourceUpdateId !== source.updateId ||
                delivery.recipientBindingKey !==
                  ownership.recipientBindingKey ||
                delivery.deliveryId !==
                  Bus.createTelegramBusFollowerDeliveryIdentity({
                    kind: "leader.forwardMessage",
                    recipientBindingKey: ownership.recipientBindingKey,
                    sourceUpdateId: source.updateId,
                  }).deliveryId)) ||
            !recipientCurrent()
          )
            throw new Error(
              "Workspace Restore acceptance source or delivery changed.",
            );
          const evidence: Threads.TelegramWorkspaceRestoreSourceAcceptance = {
            ...source,
            recipient,
            ...(delivery
              ? {
                  kind: "forwarded",
                  deliveryId: delivery.deliveryId,
                  recipientBindingKey: delivery.recipientBindingKey,
                }
              : { kind: "completed" }),
          };
          const expected = store
            .list()
            .find((value) => value.request.operationId === request.operationId);
          if (
            !expected ||
            !isDeepStrictEqual(expected.request, request) ||
            !expected.routing ||
            !recipientCurrent()
          )
            throw new Error("Workspace Restore dispatch proof is unavailable.");
          let accepted: Threads.TelegramWorkspaceRestoreIntent | undefined;
          let failure: { error: unknown } | undefined;
          const acceptanceAuthority = {
            ...authority,
            isCurrent: recipientCurrent,
          };
          try {
            accepted = store.recordSourceAcceptance(
              expected,
              evidence,
              acceptanceAuthority,
            );
          } catch (error) {
            failure = { error };
          }
          if (!recipientCurrent())
            throw new Error("Workspace Restore acceptance authority changed.");
          // A lost rename reply observes only the exact full retained proof; it never resends the accepted message.
          if (!accepted) {
            const observed = store
              .list()
              .find(
                (value) => value.request.operationId === request.operationId,
              );
            if (
              observed &&
              isDeepStrictEqual(observed.request, request) &&
              isDeepStrictEqual(observed.executor, authority.executor) &&
              observed.operatorUserId === operatorUserId &&
              observed.routing?.acceptances?.some((value) =>
                isDeepStrictEqual(value, evidence),
              )
            )
              accepted = observed;
          }
          if (
            !accepted ||
            !isDeepStrictEqual(accepted.request, request) ||
            !isDeepStrictEqual(accepted.executor, authority.executor) ||
            accepted.operatorUserId !== operatorUserId ||
            !accepted.routing?.acceptances?.some((value) =>
              isDeepStrictEqual(value, evidence),
            ) ||
            !recipientCurrent()
          )
            throw (
              failure?.error ??
              new Error("Workspace Restore acceptance was not published.")
            );
          return {
            ...source,
            completionSha256:
              Threads.getTelegramWorkspaceRestoreSourceCompletionSha256(
                accepted,
                evidence,
              ),
          };
        };
        try {
          await input.dispatch(
            recipient,
            recipientCurrent,
            recordAcceptance,
            (message) => recordAcceptance(message),
          );
        } catch (error) {
          deps.recordRuntimeEvent?.("telegram", error, {
            phase: "workspace-restore-dispatch",
          });
        }
        // Positive worker ACKs own settlement and cleanup under a subsequent admission.
        return "protected";
      }
    : undefined;
  const retryPendingRerouteCleanup = async (
    cleanup: PendingRerouteCleanup,
    assertExecutionCurrent?: () => void,
  ): Promise<boolean> => {
    if (cleanup.kind === "unbound") {
      return closeReroutedUnboundTopic(
        cleanup.target,
        cleanup.messageId,
        assertExecutionCurrent,
        cleanup.temporaryThread,
      );
    }
    if (cleanup.kind === "previous-leader") {
      return closePreviousLeaderThread(cleanup.target, assertExecutionCurrent);
    }
    return closeReplacedFollowerThread(
      cleanup.target,
      cleanup.instanceId,
      assertExecutionCurrent,
    );
  };
  let dispatchReroutedCommandMessages:
    ((messages: TMessage[], ctx: TContext) => Promise<void>) | undefined;
  const dispatchPendingRerouteMessages = async (
    pending: Pick<
      PendingUnboundReroute,
      "dispatchKind" | "sourceTarget" | "temporaryThread"
    >,
    messages: TMessage[],
    ctx: TContext,
  ): Promise<void> => {
    if (pending.dispatchKind === "command" && dispatchReroutedCommandMessages) {
      await dispatchReroutedCommandMessages(messages, ctx);
      // Every command chooser deferred its exact original, whether the tab came from Telegram or the bridge.
      // A queued command retains its separately reported receipt; this cannot settle accepted queue custody.
      for (const message of messages)
        Updates.reportTelegramUpdateCompleted(message);
      return;
    }
    await promptEnqueue(messages, ctx);
  };
  const finalizePendingReroute = async (
    rerouteId: string,
    pending: PendingUnboundReroute,
    query: TCallbackQuery,
    successMessage: string,
    assertExecutionCurrent = Updates.createTelegramUpdateExecutionFenceGuard(
      query,
    ),
  ): Promise<void> => {
    assertExecutionCurrent();
    const dismissed = await dismissRerouteChooserMessage(
      query,
      assertExecutionCurrent,
    );
    assertExecutionCurrent();
    if (dismissed) {
      removePendingReroute(rerouteId);
      await deps.answerCallbackQuery(query.id, successMessage);
      await deleteAllTabCopies(pending);
      return;
    }
    pending.phase = { kind: "finalizing", message: successMessage };
    await deps.answerCallbackQuery(
      query.id,
      `${successMessage}; tap again to clear the menu`,
    );
  };
  const isTemporaryReroute = (pending: PendingUnboundReroute): boolean =>
    !!pending.temporaryThread ||
    pending.temporaryMembership === true ||
    isTemporaryTabTarget(pending.sourceTarget);
  const isTemporaryThreadForwardIssued = (
    pending: PendingUnboundReroute,
  ): boolean => {
    try {
      const entry =
        pending.temporaryThread ??
        findCreatedTemporaryThread(pending.sourceTarget);
      const store = deps.getWorkspaceRestoreStore?.();
      if ((entry || pending.temporaryMembership) && !store) return true;
      const stored =
        entry &&
        store
          ?.listTemporaryThreads()
          .find((value) => value.token === entry.token);
      const updateIds = Updates.collectTelegramAdmissionSourceUpdateIds(
        pending.messages,
      );
      return !!stored?.forwardedInputs?.some((input) =>
        input.updateIds.some((id) => updateIds.includes(id)),
      );
    } catch {
      return true;
    }
  };
  /** Publishes the durable one-time Forward fact for this chooser's exact group; false means nothing may be sent. */
  const issueTemporaryThreadForward = (
    pending: PendingUnboundReroute,
    ctx: TContext,
  ): boolean => {
    const entry =
      pending.temporaryThread ??
      findCreatedTemporaryThread(pending.sourceTarget);
    const cap = captureTemporaryThreadAuthority(ctx);
    if (!entry || !cap) return false;
    const group = {
      journalBindingKey: entry.source.journalBindingKey,
      updateIds: Updates.collectTelegramAdmissionSourceUpdateIds(
        pending.messages,
      ),
    };
    try {
      const current = cap.store
        .listTemporaryThreads()
        .find((value) => value.token === entry.token);
      const adopted =
        current && cap.isCurrent() ? cap.adopt(current) : undefined;
      return (
        !!adopted &&
        cap.isCurrent() &&
        !!cap.store.recordTemporaryThreadForwardIssued(
          adopted,
          group,
          cap.authority,
        ) &&
        cap.isCurrent()
      );
    } catch (error) {
      deps.recordRuntimeEvent?.("routing", error, {
        phase: "temporary-thread-forward-issue",
      });
      return false;
    }
  };
  const forwardPendingRerouteMessages = async (
    pending: PendingUnboundReroute,
    instanceId: string,
    threadId: number,
    ctx: TContext,
    assertExecutionCurrent?: () => void,
    recordForwardAcceptance?: (
      message: TMessage,
      delivery: Bus.TelegramBusFollowerDeliveryIdentity,
    ) => Updates.TelegramDeferredSourceEvidence,
  ): Promise<boolean> => {
    assertExecutionCurrent?.();
    const forwardMessage = deps.foreignOwnedUpdateForwarder?.forwardMessage;
    if (!forwardMessage || pending.phase.kind === "forward-unknown")
      return false;
    const target = { ...pending.sourceTarget, threadId };
    const liveOwnership = deps.getTargetOwnership?.(target);
    if (
      !liveOwnership ||
      liveOwnership.instanceId !== instanceId ||
      !liveOwnership.ownerGeneration ||
      !liveOwnership.recipientBindingKey
    )
      return false;
    const ownership = structuredClone(liveOwnership);
    const messages = cloneTelegramMessagesForThread(pending.messages, threadId);
    // Issuance is durable before the RPC: an unacknowledged temporary-tab Forward never becomes another dispatch grant,
    // even after restart. Any refusal or publication failure sends nothing and keeps the input held.
    if (
      !recordForwardAcceptance &&
      isTemporaryReroute(pending) &&
      !issueTemporaryThreadForward(pending, ctx)
    ) {
      if (isTemporaryThreadForwardIssued(pending))
        pending.phase = { kind: "forward-unknown" };
      return false;
    }
    if (!recordForwardAcceptance && isTemporaryReroute(pending))
      pending.phase = { kind: "forward-unknown" };
    const outcomes = await Promise.allSettled(
      messages.map((message) =>
        forwardMessage({
          message,
          ownership,
          ctx,
        }),
      ),
    );
    assertExecutionCurrent?.();
    if (!isDeepStrictEqual(deps.getTargetOwnership?.(target), ownership))
      return false;
    pending.messages = pending.messages.filter((_, index) => {
      const outcome = outcomes[index];
      if (
        outcome?.status === "fulfilled" &&
        outcome.value.status === "accepted"
      ) {
        // Restore publishes acceptance before reporting completion; cleanup still waits for journal disposition.
        const expectedSource = recordForwardAcceptance?.(
          pending.messages[index],
          outcome.value.delivery,
        );
        assertExecutionCurrent?.();
        Updates.reportTelegramUpdateCompleted(
          pending.messages[index],
          expectedSource,
        );
        return false;
      }
      if (outcome?.status === "rejected") {
        deps.recordRuntimeEvent?.("bus", outcome.reason, {
          phase: "reroute-foreign-forward",
          instanceId,
          threadId,
          messageIndex: index,
        });
      }
      return true;
    });
    if (
      pending.messages.length === 0 &&
      pending.phase.kind === "forward-unknown"
    )
      pending.phase = { kind: "selected" };
    return pending.messages.length === 0;
  };
  const temporaryCleanupTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; settle: () => void }
  >();
  const cancelTemporaryThreadCleanup = (token: string): void => {
    const scheduled = temporaryCleanupTimers.get(token);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    temporaryCleanupTimers.delete(token);
    scheduled.settle();
  };
  /**
   * One cleanup attempt after the quiet period. Cancellation facts are only a precondition: fresh authority, proof,
   * absence of chooser and journal custody, and the ordinary protection checks must all hold again. The attempt is
   * durably issued once; a skipped or unknown removal keeps the entry protecting the tab across restart.
   */
  const runTemporaryThreadCleanup = async (
    token: string,
    cap: TemporaryThreadAuthority,
    reconcileExpiry: boolean,
  ): Promise<void> => {
    const store = cap.store;
    if (
      (!deps.inspectRestoreSourceAbandonment &&
        !deps.inspectRoutingInputGroupExpiry) ||
      !deps.runWorkspaceOperation ||
      !deps.callApi ||
      !cap.isCurrent()
    )
      return;
    await deps.runWorkspaceOperation(
      {
        operationId: `temporary-thread-cleanup-${randomBytes(16).toString("hex")}`,
        operationKind: "workspace.temporary-thread",
        scopes: [{ kind: "profile" }],
      },
      async () => {
        if (!cap.isCurrent()) return;
        let entry = store
          .listTemporaryThreads()
          .find(
            (value) =>
              value.token === token &&
              value.phase === "created" &&
              !!value.target,
          );
        const target = entry?.target;
        if (
          !entry ||
          !target ||
          entry.cleanupIssued ||
          entry.operatorUserId !== cap.operatorUserId ||
          entry.source.journalBindingKey !== cap.journalBindingKey
        )
          return;
        const owner = `telegram-owner:${cap.operatorUserId}`;
        if (reconcileExpiry && deps.inspectRoutingInputGroupExpiry) {
          for (const group of Threads.getTelegramTemporaryThreadInputs(entry)) {
            if (
              [
                ...(entry.cancelledInputs ?? []),
                ...(entry.completedInputs ?? []),
              ].some((value) => isDeepStrictEqual(value, group))
            )
              continue;
            const inspect = (id: number) =>
              deps.inspectRoutingInputGroupExpiry!(group)?.find(
                (value) => value.updateId === id,
              );
            if (
              !group.updateIds.every(
                (id) => inspect(id)?.operatorAuthorityId === owner,
              )
            )
              continue;
            entry = cap.adopt(entry);
            if (!entry || !cap.isCurrent()) return;
            let recorded: Threads.TelegramTemporaryThreadEntry | undefined,
              failure: unknown;
            try {
              recorded = store.recordTemporaryThreadInputExpiry(
                entry,
                group,
                cap.authority,
                inspect,
              );
            } catch (error) {
              failure = error;
            }
            if (!cap.isCurrent()) return;
            const retained = store
              .listTemporaryThreads()
              .find((value) => value.token === token);
            // A lost publication ACK may already have recorded the group or retired a bound tab's temporary frame.
            if (!retained) return;
            if (
              !recorded &&
              !retained.cancelledInputs?.some((value) =>
                isDeepStrictEqual(value, group),
              )
            )
              throw (
                failure ??
                new Error("Chooser expiry metadata was not confirmed.")
              );
            entry = retained;
          }
        }
        if (
          !Threads.isTelegramTemporaryThreadFullyResolved(entry) ||
          hasPendingRerouteForTarget(target)
        )
          return;
        const cancelled = entry.cancelledInputs ?? [];
        const cancelledCurrent = () =>
          cancelled.every((input) => {
            const expiry = deps.inspectRoutingInputGroupExpiry?.(input);
            return input.updateIds.every((updateId) => {
              const evidence =
                deps.inspectRestoreSourceAbandonment?.(
                  updateId,
                  input.journalBindingKey,
                ) ?? expiry?.find((value) => value.updateId === updateId);
              return (
                evidence?.journalBindingKey === input.journalBindingKey &&
                evidence.updateId === updateId &&
                evidence.operatorAuthorityId === owner
              );
            });
          });
        if (!cancelledCurrent()) return;
        entry = cap.adopt(entry);
        if (
          !entry ||
          !cap.isCurrent() ||
          isRerouteTargetProtected(target, undefined, entry)
        )
          return;
        const issued = store.issueTemporaryThreadCleanup(entry, cap.authority);
        if (!issued || !cap.isCurrent()) return;
        entry = issued.entry;
        const issuedEntry = entry;
        const assertCurrent = (): void => {
          if (
            !cap.isCurrent() ||
            !cancelledCurrent() ||
            !store.isTemporaryThreadCleanupCurrent(issuedEntry, cap.authority)
          )
            throw new Error(
              "Temporary Thread cleanup authority or exact grant evidence changed.",
            );
        };
        if (
          !(await closeReroutedUnboundTopic(
            target,
            undefined,
            assertCurrent,
            entry,
          )) ||
          !cap.isCurrent()
        )
          return;
        store.retireTemporaryThread(entry, cap.authority);
      },
    );
  };
  // Reuse the one timer per tab for body-free metadata retries. Future retry timers do not join settlement waits;
  // only their running attempt does. No retry is licensed once a destructive grant may have been issued.
  const queueTemporaryThreadCleanup = (
    token: string,
    cap: TemporaryThreadAuthority,
    delay: number,
    reconcileExpiry: boolean,
    retry = false,
  ): void => {
    cancelTemporaryThreadCleanup(token);
    let settle = (): void => undefined;
    const task = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      if (temporaryCleanupTimers.get(token)?.timer !== timer) return;
      temporaryCleanupTimers.delete(token);
      if (retry) restoreSettlementTasks.add(task);
      runTemporaryThreadCleanup(token, cap, reconcileExpiry)
        .catch((error) => {
          deps.recordRuntimeEvent?.("routing", error, {
            phase: "temporary-thread-cleanup",
          });
          if (!reconcileExpiry || !cap.isCurrent()) return;
          try {
            const retained = cap.store
              .listTemporaryThreads()
              .find((value) => value.token === token);
            if (retained && !retained.cleanupIssued && cap.isCurrent())
              queueTemporaryThreadCleanup(token, cap, 60_000, true, true);
          } catch {
            /* Unknown grant state never licenses a retry. */
          }
        })
        .finally(settle);
    }, delay);
    timer.unref?.();
    temporaryCleanupTimers.set(token, { timer, settle });
    if (!retry) restoreSettlementTasks.add(task);
    void task.finally(() => restoreSettlementTasks.delete(task));
  };
  /** Starts the quiet period for resolved groups or body-free expiry reconciliation; fresh input/authority revokes it. */
  const scheduleTemporaryThreadCleanup = (
    target: Queue.TelegramQueueTarget,
    ctx: TContext,
    reconcileExpiry = false,
  ): void => {
    const cap = captureTemporaryThreadAuthority(ctx);
    if (
      !cap ||
      !deps.runWorkspaceOperation ||
      target.threadId === undefined ||
      hasPendingRerouteForTarget(target)
    )
      return;
    let entry: Threads.TelegramTemporaryThreadEntry | undefined;
    try {
      entry = cap.store
        .listTemporaryThreads()
        .find(
          (value) =>
            value.phase === "created" &&
            isDeepStrictEqual(value.target, target),
        );
    } catch (error) {
      deps.recordRuntimeEvent?.("routing", error, {
        phase: "temporary-thread-cleanup-schedule",
      });
      return;
    }
    if (
      !entry ||
      entry.cleanupIssued ||
      entry.operatorUserId !== cap.operatorUserId ||
      entry.source.journalBindingKey !== cap.journalBindingKey
    )
      return;
    if (
      !reconcileExpiry &&
      !Threads.isTelegramTemporaryThreadFullyResolved(entry)
    ) {
      try {
        reconcileExpiry = Threads.getTelegramTemporaryThreadInputs(entry).some(
          (group) => !!deps.inspectRoutingInputGroupExpiry?.(group),
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "temporary-thread-cleanup-schedule",
        });
        return;
      }
    }
    if (
      !reconcileExpiry &&
      !Threads.isTelegramTemporaryThreadFullyResolved(entry)
    )
      return;
    // No grace by default: the attempt still queues behind the Cancel's own Workspace operation, so the notice lands first.
    const requested = deps.temporaryThreadCleanupDelayMs;
    const delay =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.max(0, requested)
        : 0;
    queueTemporaryThreadCleanup(entry.token, cap, delay, reconcileExpiry);
  };
  const recordCancelledTemporaryThreadInput = (
    pending: PendingUnboundReroute,
    ctx: TContext,
    isCurrent: () => boolean,
  ): boolean => {
    const store = deps.getWorkspaceRestoreStore?.(),
      target = pending.sourceTarget;
    if (!store || target.threadId === undefined)
      return !pending.temporaryThread;
    let entry = store
      .listTemporaryThreads()
      .find(
        (value) =>
          value.phase === "created" && isDeepStrictEqual(value.target, target),
      );
    if (!entry) return !pending.temporaryThread;
    const cap = captureTemporaryThreadAuthority(ctx, isCurrent),
      inspect = deps.inspectRestoreSourceAbandonment;
    if (
      !cap ||
      !inspect ||
      cap.operatorUserId !== entry.operatorUserId ||
      cap.journalBindingKey !== entry.source.journalBindingKey
    )
      return false;
    const { operatorUserId, journalBindingKey } = cap,
      current = cap.isCurrent;
    const input = {
      journalBindingKey,
      updateIds: Updates.collectTelegramAdmissionSourceUpdateIds(
        pending.messages,
      ),
    };
    if (!current()) return false;
    entry = cap.adopt(entry);
    if (!entry || !current()) return false;
    const recorded = store.recordTemporaryThreadInputCancellation(
      entry,
      input,
      cap.authority,
      (updateId) => inspect(updateId, journalBindingKey),
    );
    if (
      !recorded ||
      !current() ||
      !recorded.cancelledInputs?.some((value) =>
        isDeepStrictEqual(value, input),
      )
    )
      return false;
    const observed = store
      .listTemporaryThreads()
      .find((value) => isDeepStrictEqual(value, recorded));
    return (
      !!observed &&
      input.updateIds.every((updateId) => {
        const evidence = inspect(updateId, journalBindingKey);
        return (
          evidence?.journalBindingKey === journalBindingKey &&
          evidence.updateId === updateId &&
          evidence.operatorAuthorityId === `telegram-owner:${operatorUserId}`
        );
      }) &&
      current()
    );
  };
  /** Every source of the chooser has a private retention receipt. */
  const isPendingRerouteCancelled = (
    pending: PendingUnboundReroute,
  ): boolean => {
    const results = pending.abandonment?.sourceResults;
    return (
      !!results &&
      pending.messages.length > 0 &&
      pending.messages.every((source) => {
        const [updateId] = Updates.collectTelegramAdmissionSourceUpdateIds([
          source,
        ]);
        return updateId !== undefined && results.has(updateId);
      })
    );
  };
  /**
   * Retains every source of one chooser privately, exactly once each. False means a source cannot be abandoned
   * now; sources already retained keep their receipts, so a retry finishes only the remainder.
   */
  const abandonPendingRerouteSources = (
    pending: PendingUnboundReroute,
    operatorUserId: number,
    isCurrent: () => boolean,
  ): boolean => {
    const results = (pending.abandonment!.sourceResults ??= new Map());
    for (const source of pending.messages) {
      const [updateId] = Updates.collectTelegramAdmissionSourceUpdateIds([
        source,
      ]);
      if (updateId === undefined) return false;
      if (results.has(updateId)) continue;
      const result = Updates.abandonTelegramDeferredUpdate(source, {
        operatorAuthorityId: `telegram-owner:${operatorUserId}`,
        isCurrent,
      });
      if (!result) return false;
      results.set(updateId, result);
    }
    return isPendingRerouteCancelled(pending);
  };
  /** Review recovery retains one source; its chooser completes only after every source is retained. */
  const recordRecoveredRerouteSource = (
    pending: PendingUnboundReroute,
    updateId: number,
    result: NonNullable<
      ReturnType<typeof Updates.abandonTelegramDeferredUpdate>
    >,
  ): boolean => {
    const cancellation = pending.abandonment!;
    (cancellation.sourceResults ??= new Map()).set(updateId, result);
    cancellation.attempted = true;
    return isPendingRerouteCancelled(pending);
  };
  const retireCancellationChooser = async (
    id: string,
    pending: PendingUnboundReroute,
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    if (
      !isPendingRerouteCancelled(pending) ||
      !isCurrent() ||
      !deps.editInteractiveMessage ||
      pending.chooserMessageId === undefined
    )
      return false;
    await deps.editInteractiveMessage(
      pending.sourceTarget.chatId,
      pending.chooserMessageId,
      "<b>⛔️ Routing cancelled.</b>",
      "html",
      { inline_keyboard: [] },
    );
    if (!isCurrent() || pendingUnboundReroutes.get(id) !== pending)
      return false;
    removePendingReroute(id);
    return true;
  };
  /** Historical holds stay text-only; cancellation review accepts any owner input outside the business namespace. */
  const isReviewText = (
    message: Partial<TMessage> | undefined,
    anyKind = false,
  ): boolean => {
    if (
      !message ||
      message.chat?.type !== "private" ||
      !Number.isSafeInteger(message.chat.id) ||
      !Number.isSafeInteger(message.from?.id) ||
      message.from?.is_bot !== false ||
      !Number.isSafeInteger(message.message_id) ||
      message.message_id! <= 0 ||
      !Number.isSafeInteger(message.message_thread_id) ||
      message.message_thread_id! <= 0
    )
      return false;
    if (anyKind)
      return (
        (message as Record<string, unknown>).business_connection_id ===
        undefined
      );
    if (
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.trim().startsWith("/")
    )
      return false;
    const fields = message as Record<string, unknown>;
    return [
      "media_group_id",
      "business_connection_id",
      "photo",
      "video",
      "audio",
      "voice",
      "document",
      "animation",
      "sticker",
      "contact",
      "location",
      "venue",
      "poll",
      "dice",
      "story",
    ].every((key) => fields[key] === undefined);
  };
  const reviewMessage = (
    entry: RecoverySource["original"],
    anyKind = false,
  ): Partial<TMessage> | undefined => {
    const message = entry.update.message as Partial<TMessage> | undefined;
    if (
      entry.state !== "pending" ||
      entry.preApprovalExcluded ||
      entry.inputClaim ||
      entry.inputProvenance ||
      entry.queueOwner ||
      entry.queueReceiptId ||
      entry.queueHandoff ||
      entry.failure ||
      Object.keys(entry.update).some(
        (key) => key !== "update_id" && key !== "message",
      ) ||
      !isReviewText(message, anyKind) ||
      Reflect.has(message!, "pi_telegram_source_update_id")
    )
      return undefined;
    return message;
  };
  const needsHistoricalReview = (message: Partial<TMessage>): boolean => {
    if (!deps.threadStore)
      throw new Error("Historical routing requires a current Thread snapshot.");
    if (deps.threadStore.getBotState().threadMode === "disabled") return true;
    return !getTelegramRoutableThreadRecords(
      deps.threadStore.list(),
      deps.getLiveThreadTargets?.(),
    ).some(
      (record) =>
        record.target.chatId === message.chat!.id &&
        record.target.threadId === message.message_thread_id,
    );
  };
  /** New-world restart: forget previous-instance Restore/temporary state, then one silent delete per positively disposable tab. */
  const forgetPreviousWorld = async (
    input: Updates.TelegramHeldSourcePreparation<TContext>,
    captureTransport?: (ctx: TContext) => (() => boolean) | undefined,
  ): Promise<{ forgotten: number; deleted: number }> => {
    const result = { forgotten: 0, deleted: 0 };
    const {
      ctx,
      signal,
      journalBindingKey,
      isCurrent: preparedCurrent,
    } = input;
    const transport = captureTransport ? captureTransport(ctx) : () => true;
    const cap =
      transport &&
      captureTemporaryThreadAuthority(
        ctx,
        () =>
          !signal.aborted &&
          preparedCurrent() &&
          transport() &&
          deps.hasWorkspaceRestoreAuthority?.() === true,
      );
    const threads = deps.threadStore;
    if (
      !cap?.isCurrent() ||
      cap.journalBindingKey !== journalBindingKey ||
      !threads ||
      !deps.runWorkspaceOperation
    )
      return result;
    try {
      await deps.runWorkspaceOperation(
        {
          operationId: `new-world-${randomBytes(16).toString("hex")}`,
          operationKind: "workspace.forget-previous-world",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          if (!cap.isCurrent()) return;
          await threads.load();
          if (!cap.isCurrent()) return;
          const self = cap.authority.executor.instanceId;
          const entries = cap.store.listTemporaryThreads();
          const preserved = entries
            .filter(
              (entry) =>
                entry.operatorUserId === cap.operatorUserId &&
                entry.phase === "created" &&
                cap.store.inspectTemporaryThreadTarget(entry, cap.authority)
                  ?.kind === "temporary" &&
                Threads.getTelegramTemporaryThreadInputs(entry).some(
                  (source) =>
                    source.journalBindingKey === journalBindingKey &&
                    source.updateIds.some((id) =>
                      input.routingSourceIds?.includes(id),
                    ),
                ),
            )
            .map((entry) => entry.token);
          const disposable = entries.flatMap((entry) =>
            entry.operatorUserId === cap.operatorUserId &&
            !preserved.includes(entry.token) &&
            entry.executor.instanceId !== self &&
            entry.phase === "created" &&
            entry.target &&
            cap.store.inspectTemporaryThreadTarget(entry, cap.authority)
              ?.kind === "temporary"
              ? [entry]
              : [],
          );
          const forgotten = cap.store.forgetPreviousWorld(
            cap.authority,
            preserved,
          );
          if (!forgotten) return;
          result.forgotten =
            forgotten.operations.length + forgotten.temporaryThreads.length;
          for (const entry of disposable) {
            const target = entry.target!;
            if (!cap.isCurrent() || !deps.callApi) break;
            await threads.load();
            const same = (
              value: { chatId: number; threadId?: number } | undefined,
            ) =>
              value?.chatId === target.chatId &&
              value.threadId === target.threadId;
            if (
              !cap.isCurrent() ||
              threads
                .listWorkspaceBindings()
                .some((value) => same(value.target)) ||
              threads
                .list()
                .some(
                  (record) => record.status === "active" && same(record.target),
                ) ||
              cap.store
                .listTemporaryThreads()
                .some((entry) => same(entry.target)) ||
              cap.store
                .list()
                .some(
                  ({ request }) =>
                    same(request.target) || same(request.binding.target),
                )
            )
              continue;
            try {
              const required = [
                ...new Set([
                  cap.journalBindingKey,
                  entry.source.journalBindingKey,
                  ...Threads.getTelegramTemporaryThreadInputs(entry).map(
                    (input) => input.journalBindingKey,
                  ),
                ]),
              ];
              if (
                deps.inspectTemporaryThreadSources?.(
                  target,
                  required,
                  Threads.getTelegramTemporaryThreadInputs(entry),
                )?.length !== 0 ||
                !cap.isCurrent()
              )
                continue;
              // Exactly one attempt; the entry is already forgotten, so failure or silence leaves the tab without retry.
              if (
                (await deps.callApi<boolean>(
                  "deleteForumTopic",
                  {
                    chat_id: target.chatId,
                    message_thread_id: target.threadId,
                  },
                  { maxAttempts: 1, retrySafety: "non-idempotent" },
                )) === true
              )
                result.deleted++;
            } catch (error) {
              deps.recordRuntimeEvent?.("routing", error, {
                phase: "new-world-tab-delete",
              });
            }
          }
          // Same-instance session replacement may have lost a metadata-only timer after the source was already spent.
          // Reconstruct from retained tab/source proof under fresh authority, never from a prompt body or an issued delete.
          for (const entry of cap.store.listTemporaryThreads()) {
            if (!cap.isCurrent()) break;
            if (
              entry.phase !== "created" ||
              !entry.target ||
              entry.cleanupIssued ||
              entry.operatorUserId !== cap.operatorUserId ||
              entry.source.journalBindingKey !== journalBindingKey
            )
              continue;
            if (
              Threads.getTelegramTemporaryThreadInputs(entry).some(
                (group) => !!deps.inspectRoutingInputGroupExpiry?.(group),
              )
            )
              scheduleTemporaryThreadCleanup(entry.target, ctx, true);
          }
        },
      );
    } catch (error) {
      deps.recordRuntimeEvent?.("routing", error, {
        phase: "new-world-forget",
      });
    }
    return result;
  };
  /** Historical temporary sources await the cold policy; warm bound/unknown sources never fall into ordinary dispatch. */
  const isRecordedTemporaryThreadInputHeld = (
    entry: RecoverySource["original"],
    ctx: TContext,
    signal: AbortSignal,
    historical = false,
  ): boolean => {
    const store = deps.getWorkspaceRestoreStore?.(),
      binding = deps.getAdmissionJournalBinding?.();
    if (!store || !binding) return false;
    const members = store
      .listTemporaryThreads()
      .filter((temporary) =>
        Threads.getTelegramTemporaryThreadInputs(temporary).some(
          (input) =>
            input.journalBindingKey === binding &&
            input.updateIds.includes(entry.updateId),
        ),
      );
    const cap = captureTemporaryThreadAuthority(ctx, () => !signal.aborted);
    return members.some((temporary) => {
      if (!cap?.isCurrent()) return true;
      const observation = store.inspectTemporaryThreadTarget(
        temporary,
        cap.authority,
      );
      return historical || !observation || observation.kind !== "temporary";
    });
  };
  const shouldHoldPendingInput = async (
    entry: RecoverySource["original"],
    ctx: TContext,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const binding = deps.getAdmissionJournalBinding?.();
    const current = () =>
      !signal.aborted &&
      deps.isContextActive?.(ctx) === true &&
      deps.getAdmissionJournalBinding?.() === binding;
    if (!current())
      throw new Error("Temporary Thread source generation ended.");
    const held = isRecordedTemporaryThreadInputHeld(entry, ctx, signal);
    if (!current())
      throw new Error("Temporary Thread source authority changed.");
    return held;
  };
  /**
   * A restarted owner revives a chooser only when its saved clock proves nothing was selected, its tab is still
   * unbound and live threads exist to choose from; anything else keeps the protective startup hold.
   */
  const canReviveRoutingChooser = async (
    entry: RecoverySource["original"],
    message: Partial<TMessage> | undefined,
    ctx: TContext,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const lifetime = entry.routingInput,
      chooser = lifetime?.chooser,
      operator = deps.configStore.getAllowedUserId();
    if (
      !Updates.isRevivableTelegramRoutingInput(entry, Date.now()) ||
      !chooser ||
      !deps.threadStore ||
      operator === undefined ||
      lifetime!.operatorUserId !== operator ||
      message?.chat?.type !== "private" ||
      message.chat.id !== chooser.chatId ||
      message.from?.id !== operator ||
      message.from.is_bot !== false ||
      Object.keys(entry.update).some(
        (key) => key !== "update_id" && key !== "message",
      )
    )
      return false;
    const epoch = deps.getCurrentLeaderEpoch?.(),
      binding = deps.getAdmissionJournalBinding?.();
    const current = () =>
      !signal.aborted &&
      deps.isContextActive?.(ctx) === true &&
      epoch !== undefined &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      !!binding &&
      deps.getAdmissionJournalBinding?.() === binding;
    if (!current()) return false;
    await deps.threadStore.load();
    if (!current()) return false;
    const routable = getTelegramRoutableThreadRecords(
      deps.threadStore.list(),
      deps.getLiveThreadTargets?.(),
    );
    const at = (target: { chatId: number; threadId?: number } | undefined) =>
      target?.chatId === chooser.chatId && target.threadId === chooser.threadId;
    return (
      routable.length > 0 &&
      (chooser.threadId === undefined ||
        (!routable.some((record) => at(record.target)) &&
          !deps.threadStore
            .listWorkspaceBindings()
            .some((binding) => at(binding.target))))
    );
  };
  const shouldReviewHistoricalInput = async (
    entry: RecoverySource["original"],
    ctx: TContext,
    signal: AbortSignal,
  ): Promise<Updates.TelegramHistoricalReviewVerdict> => {
    if (signal.aborted) throw new Error("Historical routing generation ended.");
    const message = entry.update.message as Partial<TMessage> | undefined;
    if (await canReviveRoutingChooser(entry, message, ctx, signal))
      return "revive";
    const unsupported = !reviewMessage(entry);
    const retainable =
      unsupported &&
      entry.state === "pending" &&
      !entry.preApprovalExcluded &&
      !entry.inputClaim &&
      !entry.inputProvenance &&
      !entry.queueOwner &&
      !entry.queueReceiptId &&
      !entry.queueHandoff &&
      !entry.failure &&
      Object.keys(entry.update).every(
        (key) => key === "update_id" || key === "message",
      ) &&
      message?.chat?.type === "private" &&
      Number.isSafeInteger(message.chat.id) &&
      Number.isSafeInteger(message.from?.id) &&
      message.from?.is_bot === false &&
      Number.isSafeInteger(message.message_id) &&
      message.message_id! > 0 &&
      Number.isSafeInteger(message.message_thread_id) &&
      message.message_thread_id! > 0 &&
      !Reflect.has(message, "pi_telegram_source_update_id") &&
      !Reflect.has(message, "business_connection_id");
    const temporary = isRecordedTemporaryThreadInputHeld(
      entry,
      ctx,
      signal,
      true,
    );
    if (!retainable && temporary) return true;
    if (!retainable && unsupported) return false;
    if (signal.aborted) throw new Error("Historical routing generation ended.");
    const epoch = deps.getCurrentLeaderEpoch?.();
    const binding = deps.getAdmissionJournalBinding?.();
    const current = () =>
      !signal.aborted &&
      deps.isContextActive?.(ctx) === true &&
      epoch !== undefined &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      !!binding &&
      deps.getAdmissionJournalBinding?.() === binding;
    if (!current() || !deps.threadStore)
      throw new Error("Historical routing authority is unavailable.");
    await deps.threadStore.load();
    if (!current()) throw new Error("Historical routing authority changed.");
    // Raw unsupported startup originals stay protected even when a bound target outlives forgotten Restore membership.
    // Holding protects evidence, not sender authorization; owner-bearing sources keep their existing paths.
    return retainable ? "retain" : needsHistoricalReview(message!);
  };
  const recoveryPreview = (
    source: RecoverySource,
    owner: number,
    chatId: number,
    binding: string,
  ): string | undefined => {
    const entry = source.original;
    const message = reviewMessage(entry, true);
    if (!message || message.chat!.id !== chatId || message.from!.id !== owner)
      return undefined;
    for (const pending of pendingUnboundReroutes.values()) {
      if (
        pending.abandonment?.journalBindingKey === binding &&
        Updates.collectTelegramAdmissionSourceUpdateIds(
          pending.messages,
        ).includes(entry.updateId) &&
        // Revoked carriers describe a past attempt, not a live selection veto.
        // Current claim/entry authority still comes from the worker and journal CAS.
        pending.messages.some(
          (value) =>
            Updates.getTelegramUpdateExecutionFence(value)?.signal.aborted !==
            true,
        ) &&
        (!isPendingRerouteUntouched(pending) || pending.abandonment.running)
      )
        return undefined;
    }
    return formatTelegramRoutingInputPreview(message);
  };
  const expireRoutingInput = async (
    source: Updates.TelegramRoutingInputExpirySource,
    ctx: TContext,
    signal: AbortSignal,
  ): Promise<void> => {
    const operator = deps.configStore.getAllowedUserId(),
      epoch = deps.getCurrentLeaderEpoch?.();
    const message = source.original.update.message as
      Partial<TMessage> | undefined;
    const runtimeCurrent = () =>
      !signal.aborted &&
      operator !== undefined &&
      epoch !== undefined &&
      deps.isContextActive?.(ctx) === true &&
      deps.configStore.getAllowedUserId() === operator &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      deps.getAdmissionJournalBinding?.() === source.journalBindingKey &&
      source.original.routingInput?.operatorUserId === operator &&
      message?.from?.id === operator &&
      message.from.is_bot !== true &&
      message.chat?.type === "private";
    const current = () => runtimeCurrent() && source.isCurrent();
    if (!current() || !deps.runWorkspaceOperation) return;
    await deps.runWorkspaceOperation(
      {
        operationId: `routing-expiry-${randomBytes(16).toString("hex")}`,
        operationKind: "workspace.expire-unbound-routing",
        scopes: [{ kind: "profile" }],
      },
      async () => {
        if (!current()) return;
        const restores = deps.getWorkspaceRestoreStore?.();
        if (deps.getWorkspaceRestoreStore && !restores) return;
        const temporary = restores
          ?.listTemporaryThreads()
          .find((entry) =>
            Threads.getTelegramTemporaryThreadInputs(entry).some(
              (input) =>
                input.journalBindingKey === source.journalBindingKey &&
                input.updateIds.includes(source.original.updateId),
            ),
          );
        const result = source.expire();
        if (!result) return;
        // Expiry revokes the donor carrier; old controls and late ACKs cannot issue another delivery. No body is archived.
        for (const [id, pending] of pendingUnboundReroutes) {
          if (
            !Updates.collectTelegramAdmissionSourceUpdateIds(
              pending.messages,
            ).includes(source.original.updateId)
          )
            continue;
          removePendingReroute(id);
          if (
            signal.aborted ||
            deps.isContextActive?.(ctx) !== true ||
            deps.configStore.getAllowedUserId() !== operator ||
            deps.getCurrentLeaderEpoch?.() !== epoch ||
            deps.getAdmissionJournalBinding?.() !== source.journalBindingKey
          )
            continue;
          if (
            deps.editInteractiveMessage &&
            pending.chooserMessageId !== undefined
          ) {
            try {
              await deps.editInteractiveMessage(
                pending.sourceTarget.chatId,
                pending.chooserMessageId,
                "<b>⌛ Routing choice expired.</b>",
                "html",
                { inline_keyboard: [] },
              );
            } catch (error) {
              deps.recordRuntimeEvent?.("routing", error, {
                phase: "routing-input-expiry-view",
              });
            }
          }
        }
        // The scheduled stage captures only context/epoch and a tab token. It reconstructs disposition from body-free proof,
        // never closes over this source or asks the worker to retain a terminal prompt while metadata publication fails.
        if (temporary?.target && runtimeCurrent()) {
          scheduleTemporaryThreadCleanup(temporary.target, ctx, true);
          await deleteAllTabMessages(
            temporary.target.chatId,
            getTelegramAllTabSourceMessageIds(
              [message!],
              temporary.target.chatId,
            ),
          );
        }
      },
    );
  };
  const renderCancellationReview = async (
    view: CancellationReview,
    isCurrent: () => boolean,
  ): Promise<void> => {
    if (!isCurrent()) return;
    const data = (action: string) =>
      `${TELEGRAM_PENDING_CANCELLATION_REVIEW_PREFIX}${view.id}:${action}`;
    const rows: Menu.TelegramReplyMarkup["inline_keyboard"] = [
      [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
    ];
    const lines = [
      "<b>☑️ Review pending cancellations:</b>",
      "",
      "Finish stopping routing retries to retain the original privately. No new delivery is started; previously accepted work may continue. No Telegram message or Thread is deleted.",
    ];
    if (!view.sources.length)
      lines.push("", "No supported pending cancellations on this page.");
    for (const [index, source] of view.sources.entries()) {
      lines.push(
        "",
        `<b>${index + 1}. ${source.result ? "⛔️ Routing cancelled." : "Protected input"}</b>`,
        source.preview,
      );
      if (!source.result)
        rows.push([
          {
            text: `❌ Finish cancellation ${index + 1}`,
            callback_data: data(`retry:${index}`),
          },
        ]);
    }
    if (view.unsupported)
      lines.push(
        "",
        "Other protected inputs are not available in this view and remain untouched.",
      );
    if (view.nextAfterUpdateId !== undefined)
      rows.push([{ text: "🟣 More", callback_data: data("more") }]);
    rows.push([{ text: "🔄 Refresh", callback_data: data("refresh") }]);
    await deps.editInteractiveMessage!(
      view.target.chatId,
      view.messageId,
      lines.join("\n"),
      "html",
      { inline_keyboard: rows },
    );
  };
  const handleCancellationReview = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<boolean> => {
    const matches = (view: CancellationReview) =>
      query.message?.message_id === view.messageId &&
      query.message.chat.id === view.target.chatId &&
      (query.message.message_thread_id === undefined ||
        query.message.message_thread_id === view.target.threadId);
    if (query.data?.startsWith(TELEGRAM_RETIRED_HISTORICAL_REVIEW_PREFIX)) {
      await deps.answerCallbackQuery(
        query.id,
        "This control is no longer available",
      );
      return true;
    }
    const ownsReview =
      query.data?.startsWith(TELEGRAM_PENDING_CANCELLATION_REVIEW_PREFIX) ===
      true;
    const prefix = TELEGRAM_PENDING_CANCELLATION_REVIEW_PREFIX;
    if (!ownsReview && cancellationReview && matches(cancellationReview)) {
      if (cancellationReview.running && cancellationReview.isCurrent()) {
        await deps.answerCallbackQuery(query.id, "Cancellation is in progress");
        return true;
      }
      cancellationReview = undefined;
      return false;
    }
    if (!ownsReview) return false;
    const unavailable = async () => {
      await deps.answerCallbackQuery(
        query.id,
        "Cancellation review expired or unavailable. Open Status again",
      );
      return true;
    };
    const execution = Updates.getTelegramUpdateExecutionFence(query);
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    if (
      execution?.isCurrent() !== true ||
      deps.isContextActive?.(ctx) !== true ||
      !deps.editInteractiveMessage ||
      !deps.runWorkspaceOperation ||
      query.message?.chat.type !== "private" ||
      typeof chatId !== "number" ||
      !Number.isSafeInteger(chatId) ||
      typeof messageId !== "number" ||
      !Number.isSafeInteger(messageId) ||
      messageId <= 0
    )
      return unavailable();
    const owner = deps.configStore.getAllowedUserId();
    const journalBindingKey = deps.getAdmissionJournalBinding?.();
    const epoch = deps.getCurrentLeaderEpoch?.();
    if (
      owner === undefined ||
      query.from.id !== owner ||
      query.from.is_bot ||
      !journalBindingKey ||
      epoch === undefined
    )
      return unavailable();
    const current = () =>
      execution.isCurrent() &&
      deps.isContextActive?.(ctx) === true &&
      deps.configStore.getAllowedUserId() === owner &&
      deps.getAdmissionJournalBinding?.() === journalBindingKey &&
      deps.getCurrentLeaderEpoch?.() === epoch;
    const parsed = query
      .data!.slice(prefix.length)
      .match(/^([a-z0-9]+):(retry:(\d+)|refresh|more)$/);
    const prior = cancellationReview;
    const open = query.data === `${prefix}open`;
    if (
      !open &&
      (!parsed ||
        !prior ||
        parsed[1] !== prior.id ||
        !matches(prior) ||
        !prior.isCurrent())
    )
      return unavailable();
    if (prior?.running && prior.isCurrent()) {
      await deps.answerCallbackQuery(query.id, "Cancellation is in progress");
      return true;
    }
    let view = prior;
    let selected: CancellationReview["sources"][number] | undefined;
    try {
      if (open || parsed?.[2] === "refresh" || parsed?.[2] === "more") {
        if (parsed?.[2] === "more" && prior?.nextAfterUpdateId === undefined)
          return unavailable();
        const next: CancellationReview = {
          id: randomBytes(16).toString("hex"),
          target: {
            chatId,
            ...(query.message.message_thread_id !== undefined
              ? { threadId: query.message.message_thread_id }
              : {}),
          },
          messageId,
          ownerUserId: owner,
          journalBindingKey,
          sources: [],
          unsupported: false,
          isCurrent: () => cancellationReview === next && current(),
        };
        cancellationReview = view = next;
        const page = Updates.inspectTelegramAbandoningUpdates(query, {
          journalBindingKey,
          isCurrent: next.isCurrent,
          ...(parsed?.[2] === "more"
            ? { afterUpdateId: prior!.nextAfterUpdateId }
            : {}),
        });
        if (!page) {
          if (cancellationReview === next) cancellationReview = undefined;
          return unavailable();
        }
        for (const source of page.sources) {
          const preview = recoveryPreview(
            source,
            owner,
            next.target.chatId,
            journalBindingKey,
          );
          if (preview === undefined) {
            next.unsupported = true;
            continue;
          }
          if (next.sources.length === 5) {
            next.nextAfterUpdateId = next.sources.at(-1)!.original.updateId;
            break;
          }
          next.sources.push({ ...source, preview });
        }
        next.nextAfterUpdateId ??= page.nextAfterUpdateId;
        next.running = true;
        await renderCancellationReview(next, next.isCurrent);
        if (next.isCurrent()) await deps.answerCallbackQuery(query.id);
      } else {
        if (!view || !parsed?.[3] || !parsed[2].startsWith("retry:"))
          return unavailable();
        selected = view.sources[Number(parsed[3])];
        if (!selected) return unavailable();
        const activeView = view;
        const source = selected;
        const isCurrent = () =>
          current() &&
          activeView.isCurrent() &&
          recoveryPreview(
            source,
            owner,
            activeView.target.chatId,
            journalBindingKey,
          ) !== undefined;
        view.running = true;
        await deps.runWorkspaceOperation(
          {
            operationId: `workspace-cancellation-recovery:${query.id}`,
            operationKind: "workspace.recover-unbound-cancellation",
            scopes: [{ kind: "profile" }],
          },
          async () => {
            if (!isCurrent()) return;
            source.result ??= source.retry({
              operatorAuthorityId: `telegram-owner:${owner}`,
              isCurrent,
            });
            if (!source.result) {
              await unavailable();
              return;
            }
            for (const [id, pending] of pendingUnboundReroutes) {
              if (
                pending.abandonment?.ownerUserId !== owner ||
                pending.abandonment.journalBindingKey !== journalBindingKey ||
                !Updates.collectTelegramAdmissionSourceUpdateIds(
                  pending.messages,
                ).includes(source.original.updateId)
              )
                continue;
              if (
                !recordRecoveredRerouteSource(
                  pending,
                  source.original.updateId,
                  source.result,
                )
              )
                continue;
              try {
                await retireCancellationChooser(id, pending, isCurrent);
              } catch (error) {
                deps.recordRuntimeEvent?.("routing", error, {
                  phase: "recovered-chooser-cleanup",
                });
              }
            }
            await renderCancellationReview(activeView, isCurrent);
            if (isCurrent())
              await deps.answerCallbackQuery(query.id, "Routing cancelled");
          },
        );
      }
    } catch (error) {
      deps.recordRuntimeEvent?.("routing", error, {
        phase: "unbound-cancellation-recovery",
      });
      if (current())
        await deps.answerCallbackQuery(
          query.id,
          selected?.result
            ? "Routing cancelled; view update failed. Retry the same button"
            : "Recovery incomplete; inputs stay protected. Check /telegram-status --debug",
        );
    } finally {
      if (view) view.running = false;
    }
    return true;
  };
  const handleUnboundRerouteCancelCallback = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<boolean> => {
    if (
      !query.data?.startsWith(TELEGRAM_UNBOUND_REROUTE_CANCEL_CALLBACK_PREFIX)
    )
      return false;
    const rerouteId = query.data.match(/^reroutecancel:([a-z0-9]+)$/)?.[1];
    const pending = rerouteId
      ? pendingUnboundReroutes.get(rerouteId)
      : undefined;
    const cancellation = pending?.abandonment;
    const sources = pending?.messages ?? [];
    const execution = Updates.getTelegramUpdateExecutionFence(query);
    const isAuthorityCurrent = () =>
      !!cancellation &&
      execution?.isCurrent() === true &&
      sources.length > 0 &&
      sources.every(
        (source) =>
          Updates.getTelegramUpdateExecutionFence(source)?.signal.aborted ===
          false,
      ) &&
      deps.isContextActive?.(ctx) === true &&
      query.from.id === cancellation.ownerUserId &&
      !query.from.is_bot &&
      deps.configStore.getAllowedUserId() === cancellation.ownerUserId &&
      deps.getAdmissionJournalBinding?.() === cancellation.journalBindingKey &&
      deps.getCurrentLeaderEpoch?.() === cancellation.leaderEpoch;
    const isCurrent = () =>
      isAuthorityCurrent() &&
      !!pending &&
      !!cancellation &&
      pendingUnboundReroutes.get(rerouteId!) === pending &&
      pending.abandonment === cancellation &&
      matchesRerouteChooser(pending, query) &&
      query.message?.chat.type === "private" &&
      pending.messages.every(
        (source) => source.from?.id === cancellation.ownerUserId,
      ) &&
      isPendingRerouteUntouched(pending);
    if (
      !isCurrent() ||
      !deps.runWorkspaceOperation ||
      !deps.editInteractiveMessage
    ) {
      // A chooser from a previous process (new world) or an expired one simply reads as expired.
      await deps.answerCallbackQuery(
        query.id,
        pending
          ? "This message can no longer be cancelled"
          : TELEGRAM_ROUTING_CHOICE_EXPIRED,
      );
      return true;
    }
    if (cancellation!.running) {
      await deps.answerCallbackQuery(query.id, "Already cancelling");
      return true;
    }
    cancellation!.running = true;
    let closed = false;
    try {
      await deps.runWorkspaceOperation(
        {
          operationId: `workspace-reroute-cancel:${query.id}`,
          operationKind: "workspace.cancel-unbound-routing",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          if (!isCurrent()) return;
          if (!isPendingRerouteCancelled(pending!)) {
            const wasAttempted = cancellation!.attempted;
            cancellation!.attempted = true;
            if (
              !abandonPendingRerouteSources(
                pending!,
                cancellation!.ownerUserId,
                isCurrent,
              )
            ) {
              if (!cancellation!.sourceResults?.size)
                cancellation!.attempted = wasAttempted;
              await deps.answerCallbackQuery(
                query.id,
                "Cannot cancel right now",
              );
              return;
            }
          }
          if (!isCurrent()) return;
          if (!recordCancelledTemporaryThreadInput(pending!, ctx, isCurrent)) {
            if (isAuthorityCurrent())
              await deps.answerCallbackQuery(
                query.id,
                "Cancelled; tap Cancel again to close the tab",
              );
            return;
          }
          if (
            (await retireCancellationChooser(
              rerouteId!,
              pending!,
              isCurrent,
            )) &&
            isAuthorityCurrent()
          ) {
            scheduleTemporaryThreadCleanup(pending!.sourceTarget, ctx);
            closed = true;
          }
        },
      );
      // Released admission lets the tab cleanup start right after the notice; the toast and All copy go alongside it.
      if (closed)
        await Promise.all([
          deps.answerCallbackQuery(query.id, "Routing cancelled"),
          deleteAllTabCopies(pending!),
        ]);
    } catch (error) {
      deps.recordRuntimeEvent?.("routing", error, {
        phase: "unbound-cancellation",
        rerouteId,
      });
      if (isCurrent())
        await deps.answerCallbackQuery(
          query.id,
          isPendingRerouteCancelled(pending!)
            ? "Cancelled; tap Cancel again to update the menu"
            : "Not fully cancelled; tap Cancel again",
        );
    } finally {
      cancellation!.running = false;
    }
    return true;
  };
  const withPendingRerouteSelection = async (
    rerouteId: string,
    query: TCallbackQuery,
    operation: () => Promise<boolean>,
  ): Promise<boolean> => {
    Updates.assertTelegramUpdateExecutionCurrent(query);
    const pending = pendingUnboundReroutes.get(rerouteId);
    if (
      pending?.phase.kind === "forward-unknown" &&
      matchesRerouteChooser(pending, query)
    ) {
      await deps.answerCallbackQuery(
        query.id,
        "Delivery unconfirmed; not resending",
      );
      return true;
    }
    if (
      pending &&
      matchesRerouteChooser(pending, query) &&
      (pending.abandonment?.attempted ||
        pending.abandonment?.running ||
        pending.messages.some(
          (message) =>
            Updates.getTelegramUpdateExecutionFence(message)?.isCurrent() ===
            false,
        ))
    ) {
      await deps.answerCallbackQuery(query.id, TELEGRAM_ROUTING_CHOICE_EXPIRED);
      return true;
    }
    const releases: Array<() => void> = [];
    try {
      if (pending && matchesRerouteChooser(pending, query)) {
        try {
          for (const message of pending.messages)
            releases.push(Updates.acquireTelegramUpdateRouting(message));
        } catch (error) {
          deps.recordRuntimeEvent?.("routing", error, {
            phase: "routing-input-selection",
          });
          await deps.answerCallbackQuery(
            query.id,
            "This choice is no longer available",
          );
          return true;
        }
      }
      return await operation();
    } finally {
      for (const release of releases) release();
    }
  };
  const executeUnboundRerouteRestoreMenuCallback = async (
    query: TCallbackQuery,
    _ctx: TContext,
  ): Promise<boolean> => {
    const parsed = parseTelegramUnboundRerouteRestoreMenuCallbackData(
      query.data,
    );
    if (!parsed) return false;
    const assertExecutionCurrent =
      Updates.createTelegramUpdateExecutionFenceGuard(query);
    assertExecutionCurrent();
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const pending = pendingUnboundReroutes.get(parsed.rerouteId);
    if (
      typeof chatId !== "number" ||
      typeof messageId !== "number" ||
      !deps.threadStore ||
      !pending ||
      !matchesRerouteChooser(pending, query) ||
      (parsed.root && pending.rootChooserText === undefined) ||
      expirePendingCommand(parsed.rerouteId, pending)
    ) {
      await deps.answerCallbackQuery(query.id, TELEGRAM_ROUTING_CHOICE_EXPIRED);
      return true;
    }
    if (parsed.restore && pending.sourceTarget.threadId === undefined) {
      await deps.answerCallbackQuery(
        query.id,
        "Restore needs a new tab; send a message there first",
      );
      return true;
    }
    await deps.threadStore.load();
    assertExecutionCurrent();
    const activeRecords = getTelegramRoutableThreadRecords(
      deps.threadStore.list(),
      deps.getLiveThreadTargets?.(),
    );
    const replyMarkup = parsed.root
      ? buildTelegramUnboundRerouteChooserMarkup(
          parsed.rerouteId,
          activeRecords,
          {
            canRestore: pending.sourceTarget.threadId !== undefined,
            canCancel: !!pending.abandonment,
            getDisplayTitle: deps.getDisplayTitle,
          },
        )
      : parsed.restore
        ? buildTelegramUnboundRerouteRestoreChooserMarkup(
            parsed.rerouteId,
            activeRecords,
            deps.getDisplayTitle,
          )
        : {
            inline_keyboard: activeRecords.map((record) => [
              {
                text: `🧵 ${getTelegramThreadRecordLabel(record, deps.getDisplayTitle)}`,
                callback_data: formatTelegramUnboundRerouteCallbackData(
                  parsed.rerouteId,
                  record.target.threadId,
                ),
              },
            ]),
          };
    const chooserText = parsed.root
      ? pending.rootChooserText!
      : parsed.restore
        ? formatTelegramUnboundRerouteRestoreChooserText(
            getPendingRerouteCommandName(pending),
          )
        : formatTelegramUnboundRerouteChooserText(
            getPendingRerouteCommandName(pending),
          );
    if (!parsed.root)
      replyMarkup.inline_keyboard.unshift([
        {
          text: "⬆️ Back",
          callback_data: `${TELEGRAM_UNBOUND_REROUTE_ROOT_CALLBACK_PREFIX}${parsed.rerouteId}`,
        },
      ]);
    if (deps.editInteractiveMessage) {
      await deps.editInteractiveMessage(
        chatId,
        messageId,
        chooserText,
        "html",
        replyMarkup,
      );
    } else if (deps.sendInteractiveMessage) {
      const chooserId = await deps.sendInteractiveMessage(
        chatId,
        chooserText,
        "html",
        replyMarkup,
        { target: pending.sourceTarget, replyToMessageId: messageId },
      );
      assertExecutionCurrent();
      rememberRerouteChooser(parsed.rerouteId, chooserId);
    }
    assertExecutionCurrent();
    // Navigation answers silently, like the main menu: the edited chooser is the feedback.
    await deps.answerCallbackQuery(query.id);
    return true;
  };
  const executeUnboundRerouteCallbackOperation = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<boolean> => {
    const parsed = parseTelegramUnboundRerouteCallbackData(query.data);
    if (!parsed) return false;
    const assertExecutionCurrent =
      Updates.createTelegramUpdateExecutionFenceGuard(query);
    assertExecutionCurrent();
    const chatId = query.message?.chat?.id;
    const pending = pendingUnboundReroutes.get(parsed.rerouteId);
    if (
      typeof chatId !== "number" ||
      !deps.threadStore ||
      !pending ||
      !matchesRerouteChooser(pending, query) ||
      expirePendingCommand(parsed.rerouteId, pending)
    ) {
      await deps.answerCallbackQuery(query.id, TELEGRAM_ROUTING_CHOICE_EXPIRED);
      return true;
    }
    await deps.threadStore.load();
    assertExecutionCurrent();
    if (
      pendingUnboundReroutes.get(parsed.rerouteId) !== pending ||
      expirePendingCommand(parsed.rerouteId, pending)
    ) {
      await deps.answerCallbackQuery(query.id, TELEGRAM_ROUTING_CHOICE_EXPIRED);
      return true;
    }
    if (pending.phase.kind === "finalizing") {
      await finalizePendingReroute(
        parsed.rerouteId,
        pending,
        query,
        pending.phase.message,
        assertExecutionCurrent,
      );
      return true;
    }
    if (
      pending.liveRebind &&
      (!parsed.useNewSlot ||
        pending.liveRebind.record.target.threadId !== parsed.threadId)
    ) {
      await deps.answerCallbackQuery(
        query.id,
        "Live rebind is already selected. Use the original choice",
      );
      return true;
    }
    if (
      pending.workspaceRestore &&
      (!restoreWorkspace ||
        !parsed.useNewSlot ||
        pending.workspaceRestore.record.target.threadId !== parsed.threadId)
    ) {
      await deps.answerCallbackQuery(query.id, "Restore is already chosen");
      return true;
    }
    if (pending.phase.kind === "cleanup") {
      const cleanupComplete = await retryPendingRerouteCleanup(
        pending.phase.cleanup,
        assertExecutionCurrent,
      );
      if (!cleanupComplete) {
        await deps.answerCallbackQuery(
          query.id,
          "Sent; tap again to close the tab",
        );
        return true;
      }
      pending.phase = { kind: "selected" };
      await finalizePendingReroute(
        parsed.rerouteId,
        pending,
        query,
        "Tab closed",
        assertExecutionCurrent,
      );
      return true;
    }
    if (
      !pending.workspaceRestore &&
      isTemporaryReroute(pending) &&
      isTemporaryThreadForwardIssued(pending)
    ) {
      await deps.answerCallbackQuery(
        query.id,
        "Delivery unconfirmed; not resending",
      );
      return true;
    }
    const record =
      pending.liveRebind?.record ??
      pending.workspaceRestore?.record ??
      getTelegramRoutableThreadRecords(
        deps.threadStore.list(),
        deps.getLiveThreadTargets?.(),
      ).find(
        (candidate) =>
          candidate.target.chatId === chatId &&
          candidate.target.threadId === parsed.threadId,
      );
    if (!record) {
      await deps.answerCallbackQuery(query.id, "Thread is not active yet");
      return true;
    }
    const reroutedMessages = cloneTelegramMessagesForThread(
      pending.messages,
      parsed.threadId,
    );
    const sourceTarget =
      typeof pending.sourceTarget.threadId === "number"
        ? { chatId, threadId: pending.sourceTarget.threadId }
        : undefined;
    const sourceMessageId = pending.chooserMessageId;
    const completeRoutedReroute = async (): Promise<boolean> => {
      // A temporary tab is removed only after every input in it resolves, never by one Forward.
      const cleanupComplete =
        isTemporaryTabTarget(sourceTarget) ||
        (await closeReroutedUnboundTopic(
          sourceTarget,
          sourceMessageId,
          assertExecutionCurrent,
          pending.temporaryThread,
        ));
      if (!cleanupComplete && sourceTarget) {
        pending.phase = {
          kind: "cleanup",
          cleanup: {
            kind: "unbound",
            target: sourceTarget,
            ...(typeof sourceMessageId === "number"
              ? { messageId: sourceMessageId }
              : {}),
            ...(pending.temporaryThread
              ? { temporaryThread: pending.temporaryThread }
              : {}),
          },
        };
        await deps.answerCallbackQuery(
          query.id,
          "Sent; tap again to close the tab",
        );
        return true;
      }
      await finalizePendingReroute(parsed.rerouteId, pending, query, "Sent");
      if (sourceTarget && isTemporaryTabTarget(sourceTarget))
        scheduleTemporaryThreadCleanup(sourceTarget, ctx);
      return true;
    };
    if (parsed.useNewSlot && !sourceTarget) {
      await deps.answerCallbackQuery(
        query.id,
        "Restore needs a new tab; send a message there first",
      );
      return true;
    }
    if (
      parsed.useNewSlot &&
      sourceTarget &&
      record.target.chatId === sourceTarget.chatId &&
      record.target.threadId === sourceTarget.threadId
    ) {
      await deps.answerCallbackQuery(query.id, "Already in this thread");
      return true;
    }
    // A source's own temporary tab is its Restore destination; only other protection refuses it.
    if (
      parsed.useNewSlot &&
      sourceTarget &&
      !pending.workspaceRestore &&
      !pending.liveRebind &&
      isRerouteTargetProtected(
        sourceTarget,
        undefined,
        pending.temporaryThread ?? findCreatedTemporaryThread(sourceTarget),
        pending,
      )
    ) {
      await deps.answerCallbackQuery(query.id, "This tab already has a Pi");
      return true;
    }
    // Restore has one controller. Without it or its negotiated authority, refuse before selection so the chooser keeps
    // its other routes and Cancel.
    const useLiveRebind =
      !!pending.liveRebind || deps.hasWorkspaceLiveRebindAuthority?.() === true;
    if (
      parsed.useNewSlot &&
      sourceTarget &&
      !pending.workspaceRestore &&
      !useLiveRebind &&
      (!restoreWorkspace || deps.hasWorkspaceRestoreAuthority?.() !== true)
    ) {
      await deps.answerCallbackQuery(
        query.id,
        "Restore unavailable; the message is kept",
      );
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
      !parsed.useNewSlot &&
      record.instanceId &&
      record.instanceId !== currentInstanceId &&
      !isCurrentLeaderRecord &&
      !deps.foreignOwnedUpdateForwarder?.forwardMessage
    ) {
      if (pending.routingOperatorUserId === undefined) {
        pending.phase = { kind: "selected" };
        pending.pauseExpiry?.();
      }
      await deps.answerCallbackQuery(
        query.id,
        "Open that thread and send it there",
      );
      return true;
    }
    if (
      pending.routingOperatorUserId !== undefined &&
      (pending.routingOperatorUserId !== query.from.id ||
        pending.routingOperatorUserId !== deps.configStore.getAllowedUserId())
    ) {
      await deps.answerCallbackQuery(
        query.id,
        "Routing changed; reopen the menu",
      );
      return true;
    }
    // Unsupported live selections never freeze input or borrow legacy Restore/Forward dispatch.
    const liveTemplate =
      pending.liveRebind?.template ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindTemplate(pending.messages)
        : undefined);
    const liveContinue =
      pending.liveRebind?.continueCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindContinue(pending.messages)
        : undefined);
    const liveMenu =
      pending.liveRebind?.menuCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindMenu(pending.messages)
        : undefined);
    const liveAbort =
      pending.liveRebind?.abortCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindAbort(pending.messages)
        : undefined);
    const liveNext =
      pending.liveRebind?.nextCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindNext(pending.messages)
        : undefined);
    const liveStop =
      pending.liveRebind?.stopCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindStop(pending.messages)
        : undefined);
    const liveHelp =
      pending.liveRebind?.helpCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindHelp(pending.messages)
        : undefined);
    const liveName =
      pending.liveRebind?.nameCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindName(pending.messages)
        : undefined);
    const liveConfirmation =
      pending.liveRebind?.confirmationCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindConfirmation(pending.messages)
        : undefined);
    const liveExtension =
      pending.liveRebind?.extensionCommand ??
      (parsed.useNewSlot && useLiveRebind && pending.dispatchKind === "command"
        ? getLiveRebindExtension(pending.messages)
        : undefined);
    // Albums enter through prompt coalescing, but a producer command cannot borrow that admission mode.
    const groupedExtension =
      pending.messages.length > 1 &&
      Commands.findTelegramExtensionCommand(
        Commands.parseTelegramCommand(
          Media.extractFirstTelegramMessageText(pending.messages),
        )?.name,
      );
    const groupedFollowerCommand =
      record.owner?.kind === "manual-follower" &&
      pending.messages.length > 1 &&
      Commands.parseTelegramCommand(
        Media.extractFirstTelegramMessageText(pending.messages),
      );
    // Follower syntax is shared; prepareLiveSelection asks the recipient's registry before freezing or saving.
    const selectedFollowerCommand =
      record.owner?.kind === "manual-follower" &&
      pending.messages.length === 1 &&
      Commands.parseTelegramCommand(
        Media.extractFirstTelegramMessageText(pending.messages),
      );
    if (
      parsed.useNewSlot &&
      useLiveRebind &&
      (deps.hasWorkspaceLiveRebindAuthority?.() !== true ||
        groupedExtension ||
        groupedFollowerCommand ||
        (pending.dispatchKind === "command" &&
          (record.owner?.kind === "leader"
            ? !liveTemplate &&
              !liveContinue &&
              !liveMenu &&
              !liveAbort &&
              !liveNext &&
              !liveStop &&
              !liveHelp &&
              !liveName &&
              !liveConfirmation &&
              !liveExtension
            : !selectedFollowerCommand)) ||
        !deps.runWorkspaceOperation ||
        !deps.workspaceRestoreRecipient ||
        (record.owner?.kind === "leader"
          ? record.instanceId !== currentInstanceId ||
            !deps.setCurrentLeaderIdentity
          : record.owner?.kind !== "manual-follower" ||
            !deps.workspaceRestoreRecipient.liveFollower))
    ) {
      await deps.answerCallbackQuery(
        query.id,
        "Live rebind is unavailable for this input or recipient. The message stays pending",
      );
      return true;
    }
    // Freeze only a validated actual destination, inside the same admission as its effect. Menu browsing,
    // unavailable recipients and refused Restore capability never turn a waiting source into a selected grant.
    const selectPendingDestination = async (): Promise<boolean> => {
      try {
        const release = Updates.acquireTelegramUpdateRouting(
          pending.messages[0],
          true,
          Updates.collectTelegramAdmissionSourceUpdateIds(pending.messages),
        );
        release();
      } catch (error) {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "routing-input-selection",
        });
        await deps.answerCallbackQuery(
          query.id,
          "This choice is no longer available",
        );
        return false;
      }
      pending.phase = { kind: "selected" };
      pending.pauseExpiry?.();
      return true;
    };
    if (parsed.useNewSlot && sourceTarget && useLiveRebind) {
      const selection: NonNullable<PendingUnboundReroute["liveRebind"]> =
        pending.liveRebind ?? {
          record: structuredClone(record),
          messages: [...pending.messages],
          template: liveTemplate,
          continueCommand: liveContinue,
          menuCommand: liveMenu,
          abortCommand: liveAbort,
          nextCommand: liveNext,
          stopCommand: liveStop,
          helpCommand: liveHelp,
          nameCommand: liveName,
          confirmationCommand: liveConfirmation,
          extensionCommand: liveExtension,
        };
      const current = () => {
        try {
          assertExecutionCurrent();
        } catch {
          return false;
        }
        return (
          deps.runWorkspaceOperation !== undefined &&
          deps.isContextActive?.(ctx) === true &&
          query.from.id === deps.configStore.getAllowedUserId() &&
          pendingUnboundReroutes.get(parsed.rerouteId) === pending &&
          (pending.liveRebind === undefined || pending.liveRebind === selection)
        );
      };
      let outcome: "protected" | "unknown" | "released" = "protected";
      // The enclosing selection owner holds these exact source references across admission and every await.
      selection.isCurrent = current;
      try {
        selection.coordinator ??= await prepareLiveSelection(
          selection,
          sourceTarget,
          ctx,
        );
        if (!selection.coordinator) {
          await deps.answerCallbackQuery(
            query.id,
            "Live rebind recipient authority is unavailable. The message stays pending",
          );
          return true;
        }
        // Keep the captured plan even if the source owner's issued selection result is lost.
        pending.liveRebind ??= selection;
        if (!(await selectPendingDestination())) return true;
        if (current()) outcome = await selection.coordinator.advance();
        // Cleanup readiness follows the canonical released row, not source disposal: a detached command ACK may
        // still be pending while every attempt samples current work afresh.
        const operationId = selection.coordinator.operationId;
        const row =
          outcome === "protected"
            ? undefined
            : deps
                .getWorkspaceRestoreStore?.()
                ?.listLiveRebindings()
                .find((value) => value.request.operationId === operationId);
        if (row?.phase === "released" && row.cleanup === undefined)
          scheduleLiveRebindCleanup(
            operationId,
            selection.record.owner?.kind === "leader" ? "leader" : "follower",
            ctx,
          );
        if (outcome === "released") await deleteAllTabCopies(pending);
      } catch (error) {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "live-rebind-chooser",
        });
      } finally {
        selection.isCurrent = undefined;
      }
      assertExecutionCurrent();
      await deps.answerCallbackQuery(
        query.id,
        outcome === "released"
          ? selection.extensionKind === "generated-prompt"
            ? "Input queued in the rebound Thread; old-Thread cleanup is scheduled, not confirmed"
            : selection.extensionCommand
              ? "Command source disposal confirmed; reply delivery and old-Thread cleanup are not confirmed"
              : selection.nameCommand
                ? selection.nameCommand.args.trim()
                  ? "Command source disposal confirmed; title/reply delivery and old-Thread cleanup are not confirmed"
                  : "Command source disposal confirmed; name-dialog publication was handled, not title change or old-Thread cleanup"
                : selection.confirmationCommand
                  ? `Command source disposal confirmed; confirmation delivery and actual ${selection.confirmationCommand.name === "new" ? "session replacement" : "compaction"} or old-Thread cleanup are not confirmed`
                  : selection.helpCommand
                    ? "Command source disposal confirmed; menu/sync delivery and old-Thread cleanup are not confirmed"
                    : selection.stopCommand
                      ? "Command source disposal confirmed; abort settlement, reply delivery and old-Thread cleanup are not confirmed"
                      : selection.nextCommand
                        ? "Command source disposal confirmed; queue dispatch, transition notices and old-Thread cleanup are not confirmed"
                        : selection.menuCommand || selection.abortCommand
                          ? `Command source disposal confirmed; ${selection.menuCommand ? "menu" : "reply"} delivery and old-Thread cleanup are not confirmed`
                          : selection.coordinator?.selectedCommandReference()
                            ? "Command source disposal confirmed; recipient command effects and old-Thread cleanup are not confirmed"
                            : "Input queued in the rebound Thread; old-Thread cleanup is scheduled, not confirmed"
          : "Live rebind is unconfirmed; this choice never replays issued input",
      );
      return true;
    }
    if (!(await selectPendingDestination())) return true;
    if (parsed.useNewSlot && sourceTarget && restoreWorkspace) {
      const selection = (pending.workspaceRestore ??= {
        operationId: `restore-${randomBytes(16).toString("hex")}`,
        record: structuredClone(record),
        messages: [...pending.messages],
      });
      let active = true;
      const ownerUserId = deps.configStore.getAllowedUserId();
      const leaderEpoch = deps.getCurrentLeaderEpoch?.();
      const admissionScope = deps.getAdmissionScope?.();
      const journalBinding = deps.getAdmissionJournalBinding?.();
      const selectionCurrent = (): boolean => {
        try {
          assertExecutionCurrent();
        } catch {
          return false;
        }
        return (
          ownerUserId === query.from.id &&
          deps.configStore.getAllowedUserId() === ownerUserId &&
          deps.getCurrentLeaderEpoch?.() === leaderEpoch &&
          deps.getAdmissionScope?.() === admissionScope &&
          deps.getAdmissionJournalBinding?.() === journalBinding &&
          deps.isContextActive?.(ctx) !== false &&
          pendingUnboundReroutes.get(parsed.rerouteId) === pending &&
          pending.workspaceRestore === selection
        );
      };
      const current = (): boolean => active && selectionCurrent();
      const assertRestoreCurrent = (): void => {
        assertExecutionCurrent();
        if (!current()) throw new Error("Stale Workspace Restore callback.");
      };
      try {
        await restoreWorkspace({
          operationId: selection.operationId,
          record: structuredClone(selection.record),
          target: { ...sourceTarget },
          messages: [...selection.messages],
          ctx,
          isCurrent: current,
          async dispatch(
            recipient,
            isRecipientCurrent,
            recordForwardAcceptance,
            recordLocalAcceptance,
          ) {
            const assertRecipientCurrent = (): void => {
              assertRestoreCurrent();
              if (!isRecipientCurrent())
                throw new Error(
                  "Workspace Restore recipient authority changed.",
                );
            };
            assertRecipientCurrent();
            if (recipient.kind === "leader") {
              if (recipient.instanceId !== currentInstanceId) return false;
              const routed = cloneTelegramMessagesForThread(
                pending.messages,
                sourceTarget.threadId,
              );
              const messages =
                pending.dispatchKind === "command"
                  ? routed.map((message, index) =>
                      Updates.bindTelegramUpdateCompletionAcceptance(
                        message,
                        () => recordLocalAcceptance(pending.messages[index]!),
                      ),
                    )
                  : routed;
              await dispatchPendingRerouteMessages(pending, messages, ctx);
              assertRecipientCurrent();
              await deleteAllTabCopies(pending);
              return true;
            }
            const forwarded = await forwardPendingRerouteMessages(
              pending,
              recipient.instanceId,
              sourceTarget.threadId,
              ctx,
              assertRecipientCurrent,
              recordForwardAcceptance,
            );
            if (forwarded) await deleteAllTabCopies(pending);
            return forwarded;
          },
        });
      } finally {
        active = false;
      }
      assertExecutionCurrent();
      if (!selectionCurrent()) return true;
      await deps.answerCallbackQuery(
        query.id,
        "Restore unconfirmed; not resending",
      );
      return true;
    }
    if (
      record.instanceId &&
      record.instanceId !== currentInstanceId &&
      !isCurrentLeaderRecord
    ) {
      const allForwarded = await forwardPendingRerouteMessages(
        pending,
        record.instanceId,
        parsed.threadId,
        ctx,
        assertExecutionCurrent,
      );
      if (!allForwarded) {
        await deps.answerCallbackQuery(
          query.id,
          pending.phase.kind === "forward-unknown"
            ? "Delivery unconfirmed; not resending"
            : "Thread unavailable; a retry sends only the rest",
        );
        return true;
      }
      return completeRoutedReroute();
    }
    // Local handlers and queue admission consume the same one-time group grant as follower forwarding.
    if (
      isTemporaryReroute(pending) &&
      !issueTemporaryThreadForward(pending, ctx)
    ) {
      await deps.answerCallbackQuery(
        query.id,
        "Delivery unconfirmed; not resending",
      );
      return true;
    }
    await dispatchPendingRerouteMessages(pending, reroutedMessages, ctx);
    pending.messages = [];
    return completeRoutedReroute();
  };
  const executeUnboundRerouteCallback = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<boolean> => {
    const parsed = parseTelegramUnboundRerouteCallbackData(query.data);
    if (!parsed) return false;
    return withPendingRerouteSelection(parsed.rerouteId, query, () => {
      if (!deps.runWorkspaceOperation)
        return executeUnboundRerouteCallbackOperation(query, ctx);
      return deps.runWorkspaceOperation(
        {
          operationId: `workspace-reroute:${query.id}`,
          operationKind: "workspace.route-unbound-thread",
          scopes: [{ kind: "profile" }],
        },
        () => executeUnboundRerouteCallbackOperation(query, ctx),
      );
    });
  };
  const handleUnboundRerouteCallback = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<boolean> => {
    const parsed = parseTelegramUnboundRerouteCallbackData(query.data);
    const pending = parsed && pendingUnboundReroutes.get(parsed.rerouteId);
    if (
      !parsed ||
      !pending ||
      pending.dispatchKind !== "command" ||
      (pending.sourceTarget.threadId !== undefined &&
        !pending.temporaryThread) ||
      !matchesRerouteChooser(pending, query)
    ) {
      return executeUnboundRerouteCallback(query, ctx);
    }
    if (pending.dispatching) {
      await deps.answerCallbackQuery(query.id, "Already routing this command");
      return true;
    }
    pending.dispatching = true;
    try {
      return await executeUnboundRerouteCallback(query, ctx);
    } finally {
      pending.dispatching = false;
      if (
        pendingUnboundReroutes.get(parsed.rerouteId) === pending &&
        pending.phase.kind === "selected" &&
        pending.messages.length > 0
      ) {
        pending.phase = { kind: "released" };
        armPendingCommandExpiry(parsed.rerouteId, pending);
      }
    }
  };
  const callbackHandler = async (
    query: TCallbackQuery,
    ctx: TContext,
  ): Promise<void> => {
    const assertExecutionCurrent =
      Updates.createTelegramUpdateExecutionFenceGuard(query);
    assertExecutionCurrent();
    if (await handleCancellationReview(query, ctx)) return;
    if (await handleUnboundRerouteCancelCallback(query, ctx)) return;
    const restore = parseTelegramUnboundRerouteRestoreMenuCallbackData(
      query.data,
    );
    if (
      restore &&
      (await withPendingRerouteSelection(restore.rerouteId, query, () =>
        executeUnboundRerouteRestoreMenuCallback(query, ctx),
      ))
    )
      return;
    if (await handleUnboundRerouteCallback(query, ctx)) return;
    if (deps.buttonActionStore) {
      const handled = await OutboundHandlers.handleTelegramButtonCallbackQuery(
        query,
        ctx,
        {
          resolveAction: deps.buttonActionStore.resolve,
          answerCallbackQuery: deps.answerCallbackQuery,
          ...(deps.invokeBoundButtonAction
            ? {
                invokeBoundAction: (buttonQuery, action, context) =>
                  deps.invokeBoundButtonAction!(
                    action,
                    buttonQuery as TCallbackQuery,
                    context,
                  ),
              }
            : {}),
          editMessageReplyMarkup: deps.editMessageReplyMarkup
            ? async (chatId, messageId, replyMarkup) => {
                try {
                  await deps.editMessageReplyMarkup?.(
                    chatId,
                    messageId,
                    replyMarkup,
                  );
                } catch (error) {
                  deps.recordRuntimeEvent?.("telegram", error, {
                    phase: "button-selection-mark",
                    chatId,
                    messageId,
                  });
                }
              }
            : undefined,
          enqueueButtonPrompt: (buttonQuery, action, context) => {
            const chatId = buttonQuery.message?.chat?.id;
            const messageId = buttonQuery.message?.message_id;
            if (typeof chatId !== "number" || typeof messageId !== "number")
              return false;
            const queueOrder = deps.bridgeRuntime.queue.allocateItemOrder();
            const admissionReceipts = createAdmissionReceipts("prompt", [
              buttonQuery,
            ]);
            const turn: Queue.PendingTelegramTurn = {
              ...OutboundHandlers.createTelegramButtonPromptTurn({
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
                telegramPrefix: Turns.createTelegramTurnPrefix({
                  thread: resolveTelegramThreadLabel({
                    chat: { id: chatId },
                    message_thread_id: buttonQuery.message?.message_thread_id,
                  }),
                }),
              }),
              ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
            };
            const result = Queue.appendTelegramPromptTurnOnce(
              deps.telegramQueueStore.getQueuedItems(),
              turn,
            );
            if (!result.appended) {
              reportQueueAdmission([buttonQuery], admissionReceipts);
              return false;
            }
            Updates.assertTelegramUpdateExecutionCurrent(buttonQuery);
            deps.telegramQueueStore.setQueuedItems(result.items);
            reportQueueAdmission([buttonQuery], admissionReceipts);
            deps.updateStatus(context);
            requestDispatchNextQueuedTelegramTurn(context);
            return true;
          },
        },
      );
      assertExecutionCurrent();
      if (handled) return;
    }
    if (query.data?.startsWith("thread-name:")) {
      const chatId = query.message?.chat?.id;
      const dialogMessageId = query.message?.message_id;
      if (typeof chatId !== "number" || typeof dialogMessageId !== "number") {
        await deps.answerCallbackQuery(query.id, "Rename dialog expired");
        return;
      }
      const target =
        typeof query.message?.message_thread_id === "number"
          ? { chatId, threadId: query.message.message_thread_id }
          : { chatId };
      const action = query.data.slice("thread-name:".length);
      if (action !== "reset" && action !== "cancel") {
        await deps.answerCallbackQuery(query.id, "Rename dialog expired");
        return;
      }
      const queryId = query.id;
      const {
        resetCurrentThreadName,
        editInteractiveMessage,
        answerCallbackQuery,
      } = deps;
      const lifetime = threadNameDialog.capture({
        scope: getThreadNameDialogScope(),
        target,
        dialogMessageId,
      });
      if (!lifetime) {
        await answerCallbackQuery(queryId, "Rename dialog expired");
        return;
      }
      const portsCurrent = () =>
        deps.resetCurrentThreadName === resetCurrentThreadName &&
        deps.editInteractiveMessage === editInteractiveMessage &&
        deps.answerCallbackQuery === answerCallbackQuery;
      const isCurrent = () =>
        portsCurrent() && lifetime.isCurrent() && portsCurrent();
      const assertRecipient = lifetime.assertAuthority;
      const assertInputAuthority = assertRecipient
        ? () => {
            if (!isCurrent())
              throw new Error(
                "Telegram Thread name callback lost owner authority.",
              );
          }
        : undefined;
      const ownerOptions: [] | [{ assertAuthority: () => void }] =
        assertInputAuthority ? [{ assertAuthority: assertInputAuthority }] : [];
      // Detached effects retain recipient/port authority, never the ended or expiring input handle.
      const assertEffectAuthority = assertRecipient
        ? () => {
            assertRecipient();
            const current = portsCurrent();
            assertRecipient();
            if (!current || !portsCurrent())
              throw new Error(
                "Telegram Thread name callback lost port authority.",
              );
          }
        : undefined;
      const editOptions:
        | []
        | [{ target: Queue.TelegramQueueTarget; assertAuthority: () => void }] =
        assertEffectAuthority
          ? [{ target: { ...target }, assertAuthority: assertEffectAuthority }]
          : [];
      const answerOptions: [] | [{ assertAuthority: () => void }] =
        assertEffectAuthority
          ? [{ assertAuthority: assertEffectAuthority }]
          : [];
      if (!isCurrent()) {
        lifetime.finish();
        return;
      }
      const selected = lifetime.select(action);
      if (selected.kind === "expired") {
        lifetime.finish();
        return;
      }
      if (selected.kind === "cancel") {
        // Cancellation terminalizes exact input before independent recipient/API delivery.
        if (!portsCurrent()) return;
        assertEffectAuthority?.();
        await editInteractiveMessage?.(
          chatId,
          dialogMessageId,
          "<b>✖ Rename cancelled.</b>",
          "html",
          { inline_keyboard: [] },
          ...editOptions,
        );
        if (portsCurrent()) {
          assertEffectAuthority?.();
          if (assertEffectAuthority)
            await answerCallbackQuery(queryId, undefined, {
              assertAuthority: assertEffectAuthority,
            });
          else await answerCallbackQuery(queryId);
          assertEffectAuthority?.();
        }
        return;
      }
      let reopen = false;
      try {
        if (!isCurrent()) return;
        const result = await resetCurrentThreadName?.(
          { ...target },
          ...ownerOptions,
        );
        if (!isCurrent()) return;
        if (!result?.ok) {
          throw new Error(
            result?.message ?? "Thread display name reset is unavailable.",
          );
        }
        const replyText = result.message
          ? Commands.formatTelegramInformationHeading("✅", result.message)
          : Commands.formatTelegramAutomaticThreadDisplayNameRestoredHeading(
              result.threadName ?? "automatic",
            );
        if (!isCurrent()) return;
        assertEffectAuthority?.();
        await editInteractiveMessage?.(
          chatId,
          dialogMessageId,
          replyText,
          "html",
          { inline_keyboard: [] },
          ...editOptions,
        );
        if (!isCurrent()) return;
        assertEffectAuthority?.();
        if (assertEffectAuthority)
          await answerCallbackQuery(queryId, undefined, {
            assertAuthority: assertEffectAuthority,
          });
        else await answerCallbackQuery(queryId);
        assertEffectAuthority?.();
      } catch (error) {
        if (!isCurrent()) return;
        reopen = true;
        deps.recordRuntimeEvent?.("telegram-command", error, {
          command: "name",
          phase: "reset",
        });
        if (isCurrent()) {
          assertEffectAuthority?.();
          await answerCallbackQuery(
            queryId,
            "Thread name reset failed",
            ...answerOptions,
          );
          assertEffectAuthority?.();
        }
      } finally {
        if (reopen && isCurrent()) lifetime.reopen();
        lifetime.finish();
      }
      return;
    }
    const handledByNew = await Commands.handleTelegramNewConfirmationCallback(
      query,
      {
        ctx,
        answerCallbackQuery: deps.answerCallbackQuery,
        editInteractiveMessage: deps.editInteractiveMessage ?? (async () => {}),
        deleteMessage: deps.deleteMessage ?? (async () => {}),
        runNew: async (newCtx) => {
          await Commands.handleTelegramNewCommand({
            isIdle: () => deps.isIdle(newCtx),
            hasPendingMessages: () => deps.hasPendingMessages(newCtx),
            hasActiveTelegramTurn: deps.activeTurnRuntime.has,
            hasDispatchPending: deps.bridgeRuntime.lifecycle.hasDispatchPending,
            hasQueuedTelegramItems: deps.telegramQueueStore.hasQueuedItems,
            isCompactionInProgress:
              deps.bridgeRuntime.lifecycle.isCompactionInProgress,
            requestNewSession: deps.requestNewSession
              ? () => deps.requestNewSession!(query)
              : undefined,
            sendTextReply: async (text) => {
              const chatId = query.message?.chat?.id;
              const messageId = query.message?.message_id;
              if (typeof chatId !== "number" || typeof messageId !== "number")
                return;
              await deps.editInteractiveMessage?.(
                chatId,
                messageId,
                text,
                "html",
                { inline_keyboard: [] },
              );
            },
            recordRuntimeEvent: deps.recordRuntimeEvent,
          });
        },
      },
    );
    assertExecutionCurrent();
    if (handledByNew) return;
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
            sendTextReply: (text, options) =>
              deps
                .sendTextReply(chatId, replyToMessageId, text, {
                  target,
                  parseMode: options?.parseMode,
                })
                .then(() => {}),
            suppressStartNotice: true,
            recordRuntimeEvent: deps.recordRuntimeEvent,
          });
        },
      });
    assertExecutionCurrent();
    if (handledByCompact) return;
    const handledByQueue = await deps.queueMenuCallbackHandler(query, ctx);
    assertExecutionCurrent();
    if (handledByQueue) return;
    const handledBySettings = await deps.settingsMenuCallbackHandler?.(
      query,
      ctx,
    );
    assertExecutionCurrent();
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
        const admissionReceipts = createAdmissionReceipts("prompt", [query]);
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
          ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
        };
        const result = Queue.appendTelegramPromptTurnOnce(
          deps.telegramQueueStore.getQueuedItems(),
          turn,
        );
        if (result.appended) {
          Updates.assertTelegramUpdateExecutionCurrent(query);
          deps.telegramQueueStore.setQueuedItems(result.items);
          reportQueueAdmission([query], admissionReceipts);
          deps.updateStatus(ctx);
          requestDispatchNextQueuedTelegramTurn(ctx);
        } else {
          reportQueueAdmission([query], admissionReceipts);
        }
      }
      await deps.answerCallbackQuery(query.id);
      return;
    }
    await menuCallbackHandler(query, ctx);
  };
  const preparePromptTurn = Turns.createTelegramPromptTurnRuntimePreparer<
    TMessage,
    TContext
  >({
    allocateQueueOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    downloadFile: deps.downloadFile,
    processAttachments: deps.inboundHandlerRuntime.process,
    resolveTimeLine: deps.resolveTimeLine,
    getAllowedUserId: deps.configStore.getAllowedUserId,
    getAdmissionScope: deps.getAdmissionScope,
    getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
    assertExecutionCurrent(message) {
      Updates.assertTelegramUpdateExecutionCurrent(message);
    },

    // Voice policy resolves missing, invalid, and legacy manual config to hidden.
    getVoiceReplyMode: () => getTelegramVoiceReplyMode(deps.configStore.get()),
    getTelegramThreadLabel: resolveTelegramThreadLabel,
  });
  const enqueueContinueTurn = async (
    message: TMessage,
    ctx: TContext,
    admission?: {
      assertCurrent: () => void;
      report: (turn: Queue.PendingTelegramTurn) => void;
    },
  ): Promise<void> => {
    admission?.assertCurrent();
    Updates.assertTelegramUpdateExecutionCurrent(message);
    if (!admission)
      deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory(false);
    const continueMessage = Updates.carryTelegramUpdateExecutionFence(message, {
      ...message,
      text: "continue",
      caption: undefined,
    } as TMessage);
    const buildTurn = await preparePromptTurn([continueMessage], ctx);
    admission?.assertCurrent();
    const turn = buildTurn([]);
    const continueTurn = {
      ...turn,
      queueLane: "control" as const,
      laneOrder: deps.bridgeRuntime.queue.allocateControlOrder(),
      statusSummary: "continue",
    };
    admission?.assertCurrent();
    Updates.assertTelegramUpdateExecutionCurrent(message);
    deps.queueMutationRuntime.append(continueTurn, ctx);
    if (admission) admission.report(continueTurn);
    else
      reportQueueAdmission(
        [continueMessage],
        continueTurn.admissionReceipts ?? [],
      );
    requestDispatchNextQueuedTelegramTurn(ctx);
  };
  const reservedCommandNames = () =>
    new Set(Commands.getTelegramReservedCommandNames());
  const getPromptTemplateCommands = () =>
    PromptTemplates.getTelegramPromptTemplateCommands(
      deps.getCommands(),
      reservedCommandNames(),
    );
  const expandPromptTemplateCommand = (name: string, args: string) =>
    PromptTemplates.expandTelegramPromptTemplateCommand(
      name,
      args,
      getPromptTemplateCommands(),
    );
  const commandHandler = Commands.createTelegramCommandHandlerTargetRuntime<
    TMessage,
    TContext
  >({
    assertExecutionCurrent(message) {
      Updates.assertTelegramUpdateExecutionCurrent(message);
    },
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
    isContextActive: deps.isContextActive,
    beginCommandEffectWork: deps.beginCommandEffectWork,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    requestNextDispatchAnnouncement: deps.requestNextDispatchAnnouncement,
    cancelNextTransitionAnnouncements: () => {
      deps.activeTurnRuntime.clearNextAbortAnnouncement();
      deps.cancelNextDispatchAnnouncement?.();
    },
    requestDeferredDispatchNextQueuedTelegramTurn:
      deps.requestDeferredDispatchNextQueuedTelegramTurn,
    startTypingLoop: deps.startTypingLoop,
    stopTypingLoop: deps.stopTypingLoop,
    enqueueContinueTurn,
    heldTurn: {
      templates: {
        getCommands: getPromptTemplateCommands,
        expand: expandPromptTemplateCommand,
      },
      async enqueue(message, ctx, kind, admission) {
        admission.assertCurrent();
        if (kind === "continue")
          await enqueueContinueTurn(message, ctx, {
            assertCurrent: admission.assertCurrent,
            report: (turn) => admission.report(turn.admissionReceipts ?? []),
          });
        else
          await promptEnqueueController.enqueue(
            [message],
            ctx,
            (turn) => admission.report(turn.admissionReceipts ?? []),
            { preserveQueued: true, assertCurrent: admission.assertCurrent },
          );
      },
    },
    compact: deps.compact,
    requestNewSession: deps.requestNewSession,
    allocateItemOrder: deps.bridgeRuntime.queue.allocateItemOrder,
    allocateControlOrder: deps.bridgeRuntime.queue.allocateControlOrder,
    appendControlItem: deps.queueMutationRuntime.append,
    getAdmissionScope: deps.getAdmissionScope,
    getAdmissionJournalBinding: deps.getAdmissionJournalBinding,
    onControlQueued: (message, receipt) =>
      reportQueueAdmission([message], [receipt]),
    showStatus: deps.menuActions.sendStatusMessage,
    openModelMenu: deps.menuActions.openModelMenu,
    openThinkingMenu: (message, ctx, options) => {
      const target = Commands.getTelegramCommandMessageTarget(message);
      return deps.menuActions.openThinkingMenu(
        target.chatId,
        target.replyToMessageId,
        ctx,
        target.threadId,
        options,
      );
    },
    openQueueMenu: (message, ctx, options) => {
      const target = Commands.getTelegramCommandMessageTarget(message);
      return deps.openQueueMenu(
        target.chatId,
        target.replyToMessageId,
        ctx,
        target.threadId,
        options,
      );
    },
    openSettingsMenu: deps.openSettingsMenu,
    getAllowedUserId: deps.configStore.getAllowedUserId,
    persistAllowedUserId: deps.configStore.persistAllowedUserId,
    setMyCommands: deps.setMyCommands,
    validateThreadName: deps.validateThreadName,
    renameCurrentThread: deps.renameCurrentThread,
    resetCurrentThreadName: deps.resetCurrentThreadName,
    openThreadNameDialog: async (message, ctx, admission) => {
      const assertSemanticCurrent = admission?.assertSemanticCurrent;
      const assertSelectedRecipient = admission?.assertRecipientCurrent;
      assertSemanticCurrent?.();
      const address = Updates.getTelegramMessageTarget(message);
      const target = address && { ...address };
      const {
        sendInteractiveMessage,
        getCurrentInstanceId,
        getSessionGeneration,
        isContextActive,
        getCurrentLeaderEpoch,
        getAdmissionScope,
        getAdmissionJournalBinding,
        captureThreadNameRecipientAuthority,
      } = deps;
      const configStore = deps.configStore,
        threadStore = deps.threadStore;
      const getAllowedUserId = configStore.getAllowedUserId;
      if (!sendInteractiveMessage || !target) {
        if (admission) return;
        await deps.sendTextReply(
          message.chat.id,
          message.message_id,
          Commands.formatTelegramInformationHeading(
            "🏷️",
            "Usage: /name Navigator",
          ),
          { parseMode: "HTML", target },
        );
        return;
      }
      const assertRecipient = captureThreadNameRecipientAuthority?.(
        { ...target },
        ctx,
      );
      if (admission && !assertRecipient) return;
      const scope = getCurrentInstanceId?.() ?? "local",
        generation = getSessionGeneration?.();
      const operator = getAllowedUserId(),
        epoch = getCurrentLeaderEpoch?.();
      const admissionScope = getAdmissionScope?.(),
        journalBinding = getAdmissionJournalBinding?.();
      const portsCurrent = () =>
        deps.sendInteractiveMessage === sendInteractiveMessage &&
        deps.configStore === configStore &&
        configStore.getAllowedUserId === getAllowedUserId &&
        deps.threadStore === threadStore &&
        deps.getCurrentInstanceId === getCurrentInstanceId &&
        deps.getSessionGeneration === getSessionGeneration &&
        deps.isContextActive === isContextActive &&
        deps.getCurrentLeaderEpoch === getCurrentLeaderEpoch &&
        deps.getAdmissionScope === getAdmissionScope &&
        deps.getAdmissionJournalBinding === getAdmissionJournalBinding &&
        deps.captureThreadNameRecipientAuthority ===
          captureThreadNameRecipientAuthority;
      const isCurrent = () => {
        assertSelectedRecipient?.();
        assertRecipient?.();
        const current =
          portsCurrent() &&
          (!isContextActive || isContextActive(ctx) === true) &&
          getAllowedUserId() === operator &&
          getCurrentLeaderEpoch?.() === epoch &&
          getAdmissionScope?.() === admissionScope &&
          getAdmissionJournalBinding?.() === journalBinding &&
          (getCurrentInstanceId?.() ?? "local") === scope &&
          getSessionGeneration?.() === generation;
        assertRecipient?.();
        assertSelectedRecipient?.();
        return current && portsCurrent();
      };
      // This delivery guard outlives input settlement; it never borrows the expiring dialog handle.
      const assertAuthority = assertRecipient
        ? () => {
            if (!isCurrent())
              throw new Error(
                "Telegram Thread name dialog lost recipient authority.",
              );
          }
        : undefined;
      // Reserve the exact existing owner entry before delivery; late results cannot replace a successor.
      const lifetime = threadNameDialog.prepare({
        scope,
        target,
        isCurrent,
        assertAuthority,
      });
      if (!lifetime) return;
      let published = false;
      try {
        const hasManualName =
          threadStore
            ?.listWorkspaceBindings()
            .some(
              (binding) =>
                binding.target.chatId === target.chatId &&
                binding.target.threadId === target.threadId &&
                typeof binding.manualThreadName === "string",
            ) ?? false;
        const instructions = hasManualName
          ? "<b>🏷️ Send a new Thread name using printable ASCII, reset to automatic, or cancel.</b>"
          : "<b>🏷️ Send a Thread name using printable ASCII, or cancel.</b>";
        const buttons = hasManualName
          ? [
              {
                text: "↩️ Reset to automatic",
                callback_data: "thread-name:reset",
              },
              { text: "✖ Cancel rename", callback_data: "thread-name:cancel" },
            ]
          : [{ text: "✖ Cancel rename", callback_data: "thread-name:cancel" }];
        assertSemanticCurrent?.();
        if (!lifetime.isCurrent()) return;
        const dialogMessageId = await sendInteractiveMessage(
          target.chatId,
          instructions,
          "html",
          { inline_keyboard: buttons.map((button) => [button]) },
          {
            target: { ...target },
            ...(assertAuthority ? { assertAuthority } : {}),
          },
        );
        assertAuthority?.();
        assertSemanticCurrent?.();
        if (typeof dialogMessageId === "number")
          published = !!lifetime.publish(
            dialogMessageId,
            assertSemanticCurrent,
          );
        if (published)
          return {
            assertPublished() {
              if (!lifetime.isCurrent())
                throw new Error(
                  "Telegram Thread name dialog publication is no longer current.",
                );
            },
          };
      } finally {
        if (!published) lifetime.finish();
      }
    },
    getPromptTemplateCommands,
    sendTextReply: deps.sendTextReply,
    markActiveTurnNextAbortAnnouncement:
      deps.activeTurnRuntime.markNextAbortAnnouncement,
    getActiveTurnReply: () => {
      const activeTurn = deps.activeTurnRuntime.get();
      if (!activeTurn) return undefined;
      return async (text, options) => {
        await deps.sendTextReply(
          activeTurn.chatId,
          activeTurn.replyToMessageId,
          text,
          { target: activeTurn.target, parseMode: options?.parseMode },
        );
      };
    },
    sendInteractiveMessage: deps.sendInteractiveMessage,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const promptEnqueueController = Queue.createTelegramPromptEnqueueController<
    TMessage,
    TContext
  >({
    ...deps.telegramQueueStore,
    hasPendingDispatch: deps.bridgeRuntime.lifecycle.hasDispatchPending,
    getFoldQueuedPromptsIntoHistory:
      deps.bridgeRuntime.lifecycle.shouldFoldQueuedPromptsIntoHistory,
    setFoldQueuedPromptsIntoHistory:
      deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
    prepareTurn: async (messages, turnCtx) => {
      const buildTurn = await preparePromptTurn(messages, turnCtx);
      return (historyTurns) => {
        const turn = buildTurn(historyTurns);
        return turn.replyToMessageId > 0
          ? turn
          : { ...turn, replyToMessageId: 0 };
      };
    },
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: requestDispatchNextQueuedTelegramTurn,
    assertExecutionCurrent: (messages) =>
      Updates.assertTelegramUpdateExecutionCurrent(messages[0]),
  });
  const promptEnqueue = async (
    messages: TMessage[],
    ctx: TContext,
  ): Promise<Queue.PendingTelegramTurn> => {
    return promptEnqueueController.enqueue(messages, ctx, (turn) => {
      reportQueueAdmission(messages, turn.admissionReceipts ?? []);
    });
  };
  const continueLiveRebindPrompt = (
    originals: readonly TMessage[],
    ctx: TContext,
    selectedTarget: Queue.TelegramQueueTarget & { threadId: number },
    isCurrent: () => boolean,
  ): Promise<boolean> =>
    continueLiveRebindInput(originals, ctx, selectedTarget, isCurrent);
  const continueLiveRebindInput = async (
    originals: readonly TMessage[],
    ctx: TContext,
    selectedTarget: Queue.TelegramQueueTarget & { threadId: number },
    isCurrent: () => boolean,
    generated?: {
      prompt: string;
      assertRegistrationCurrent(): void;
      onQueued(turn: Queue.PendingTelegramTurn): void;
    },
  ): Promise<boolean> => {
    const messages = [...originals],
      target = { ...selectedTarget };
    const operatorUserId = deps.configStore.getAllowedUserId(),
      journalBindingKey = deps.getAdmissionJournalBinding?.();
    const scope = deps.getAdmissionScope?.(),
      generation = deps.getSessionGeneration?.();
    const sources = messages.map(Updates.inspectTelegramDeferredSource);
    const fences = messages.map(Updates.getTelegramUpdateExecutionFence);
    const ids = Updates.collectTelegramAdmissionSourceUpdateIds(messages);
    const current = () =>
      isCurrent() &&
      !!operatorUserId &&
      !!journalBindingKey &&
      !!scope &&
      generation !== undefined &&
      deps.isContextActive?.(ctx) === true &&
      deps.getSessionGeneration?.() === generation &&
      deps.configStore.getAllowedUserId() === operatorUserId &&
      deps.getAdmissionScope?.() === scope &&
      deps.getAdmissionJournalBinding?.() === journalBindingKey &&
      messages.length > 0 &&
      ids.length === messages.length &&
      Number.isSafeInteger(target.threadId) &&
      target.threadId > 0 &&
      messages.every(
        (message, index) =>
          message.chat.type === "private" &&
          message.chat.id === target.chatId &&
          message.from?.id === operatorUserId &&
          !message.from?.is_bot &&
          fences[index]?.isCurrent() === true &&
          Updates.getTelegramUpdateExecutionFence(message) === fences[index] &&
          sources[index]?.journalBindingKey === journalBindingKey &&
          !sources[index]?.completionSha256,
      );
    const assertCurrent = () => {
      generated?.assertRegistrationCurrent();
      if (
        !current() ||
        !messages.every((message, index) =>
          isDeepStrictEqual(
            Updates.inspectTelegramDeferredSource(message),
            sources[index],
          ),
        )
      )
        throw new Error("Live-rebind input admission authority changed.");
    };
    const references: Array<() => void> = [];
    let admitted = false;
    try {
      assertCurrent();
      for (const message of messages)
        references.push(Updates.acquireTelegramUpdateRouting(message));
      assertCurrent();
      const routed = messages.map((message) => {
        const sameTarget = message.message_thread_id === target.threadId;
        return Updates.carryTelegramUpdateExecutionFence(message, {
          ...message,
          message_thread_id: target.threadId,
          ...(sameTarget ? {} : { message_id: 0, reply_to_message: undefined }),
        } as TMessage);
      });
      const enqueue = async (values: TMessage[], turnCtx: TContext) => {
        assertCurrent();
        await promptEnqueueController.enqueue(
          values,
          turnCtx,
          (turn) => {
            assertCurrent();
            admitted = Updates.reportTelegramQueueAdmission(
              messages,
              turn.admissionReceipts ?? [],
            );
            if (!admitted)
              throw new Error(
                "Live-rebind original receipt admission was not confirmed.",
              );
          },
          { preserveQueued: true, assertCurrent },
        );
      };
      if (generated) {
        if (routed.length !== 1) return false;
        await Queue.enqueueTelegramPromptTurnRuntime(routed, {
          ...deps.telegramQueueStore,
          hasPendingDispatch: deps.bridgeRuntime.lifecycle.hasDispatchPending,
          getFoldQueuedPromptsIntoHistory:
            deps.bridgeRuntime.lifecycle.shouldFoldQueuedPromptsIntoHistory,
          setFoldQueuedPromptsIntoHistory:
            deps.bridgeRuntime.lifecycle.setFoldQueuedPromptsIntoHistory,
          preserveQueued: true,
          assertExecutionCurrent: assertCurrent,
          async prepareTurn(values) {
            // Only the captured producer text enters the normal turn builder; raw command media/handlers never run.
            const turn = await Turns.buildTelegramPromptTurnRuntime({
              messages: values,
              telegramPrefix: Turns.createTelegramTurnPrefix({
                thread: resolveTelegramThreadLabel(values[0]!),
              }),
              rawText: generated.prompt,
              files: [],
              queueOrder: deps.bridgeRuntime.queue.allocateItemOrder(),
              inferImageMimeType: Media.guessMediaType,
              timeLine: deps.resolveTimeLine?.(target.chatId),
              voiceReplyMode: getTelegramVoiceReplyMode(deps.configStore.get()),
              admissionScope: scope,
              admissionJournalBinding: journalBindingKey,
            });
            assertCurrent();
            if (
              turn.kind !== "prompt" ||
              turn.queueLane !== "default" ||
              turn.historyText !== generated.prompt ||
              !isDeepStrictEqual(turn.target, target) ||
              turn.admissionReceipts?.length !== 1 ||
              turn.admissionReceipts[0]?.queueKind !== "prompt" ||
              turn.admissionReceipts[0]?.journalBindingKey !==
                journalBindingKey ||
              !isDeepStrictEqual(
                turn.admissionReceipts[0]?.sourceUpdateIds,
                ids,
              )
            )
              throw new Error("Live-rebind generated payload/receipt changed.");
            return (history) => {
              if (history.length)
                throw new Error(
                  "Live-rebind generated admission cannot fold queued history.",
                );
              return turn;
            };
          },
          onQueued(turn) {
            assertCurrent();
            generated.onQueued(turn);
            admitted = Updates.reportTelegramQueueAdmission(
              messages,
              turn.admissionReceipts ?? [],
            );
            if (!admitted)
              throw new Error(
                "Live-rebind generated receipt report was not confirmed.",
              );
          },
          updateStatus: () => deps.updateStatus(ctx),
          dispatchNextQueuedTelegramTurn: () =>
            requestDispatchNextQueuedTelegramTurn(ctx),
        });
      } else await enqueue(routed, ctx);
      return admitted && current();
    } catch (error) {
      deps.recordRuntimeEvent?.("routing", error, {
        phase: "live-rebind-input-admission",
      });
      return false;
    } finally {
      for (const release of references) release();
    }
  };
  const recordUnboundTemporaryThreadInput = async (
    messages: TMessage[],
    ctx: TContext,
  ): Promise<boolean> => {
    const message = messages[0],
      target = message && Updates.getTelegramMessageTarget(message);
    const store = deps.getWorkspaceRestoreStore?.();
    if (!target?.threadId || !store) return false;
    let found = store
      .listTemporaryThreads()
      .find(
        (entry) =>
          entry.phase === "created" &&
          entry.target &&
          entry.target.chatId === target.chatId &&
          entry.target.threadId === target.threadId,
      );
    const key = formatTelegramTargetKey(target),
      implicit = implicitThreadCreations.get(key);
    if (!found && !implicit) return false;
    const updateIds = Updates.collectTelegramAdmissionSourceUpdateIds(messages);
    const operatorUserId = deps.configStore.getAllowedUserId();
    const cap = captureTemporaryThreadAuthority(ctx, () =>
      messages.every(
        (source) =>
          Updates.getTelegramUpdateExecutionFence(source)?.isCurrent() ===
            true &&
          source.chat.type === "private" &&
          source.chat.id === target.chatId &&
          source.message_thread_id === target.threadId &&
          source.from?.id === operatorUserId &&
          source.from?.is_bot === false,
      ),
    );
    if (!found && implicit) {
      // The first live input group (one message or an album) adopts the native tab, whatever its kind.
      if (
        !deps.runWorkspaceOperation ||
        !cap ||
        implicit.ctx !== ctx ||
        implicit.operatorUserId !== cap.operatorUserId ||
        implicit.journalBindingKey !== cap.journalBindingKey ||
        !isDeepStrictEqual(implicit.executor, cap.authority.executor) ||
        implicit.generation !== deps.getSessionGeneration?.() ||
        implicit.scope !== deps.getAdmissionScope?.() ||
        !updateIds.length ||
        updateIds.some((id) => id <= implicit.updateId) ||
        !cap.isCurrent()
      ) {
        implicitThreadCreations.delete(key);
        return false;
      }
      found = store.registerImplicitTemporaryThread(
        { journalBindingKey: cap.journalBindingKey, updateIds },
        { chatId: target.chatId, threadId: target.threadId },
        randomBytes(16).toString("hex"),
        {
          ...cap.authority,
          isCurrent: () =>
            cap.isCurrent() && implicitThreadCreations.get(key) === implicit,
        },
      );
      if (!found || !cap.isCurrent())
        throw new Error(
          "Implicit Telegram Thread registration was not acknowledged; source remains protected.",
        );
      implicitThreadCreations.delete(key);
      // Adopted native tabs share the routing name; a failed rename never blocks routing.
      try {
        await deps.callApi?.("editForumTopic", {
          chat_id: target.chatId,
          message_thread_id: target.threadId,
          name: TELEGRAM_TEMPORARY_THREAD_NAME,
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "temporary-thread-name",
        });
      }
    }
    if (!found) return false;
    cancelTemporaryThreadCleanup(found.token);
    if (
      !deps.runWorkspaceOperation ||
      !cap ||
      cap.operatorUserId !== found.operatorUserId ||
      cap.journalBindingKey !== found.source.journalBindingKey ||
      !updateIds.length ||
      !cap.isCurrent()
    ) {
      throw new Error(
        "Temporary Thread input membership requires exact current source authority.",
      );
    }
    // The caller already holds the profile Workspace admission (the non-reentrant gate): no nested operation here.
    let entry = store
      .listTemporaryThreads()
      .find(
        (value) =>
          value.token === found.token &&
          isDeepStrictEqual(value.source, found.source) &&
          isDeepStrictEqual(value.target, target),
      );
    if (!entry)
      throw new Error(
        "Temporary Thread input target changed before membership publication.",
      );
    entry = cap.adopt(entry);
    if (
      !entry ||
      !cap.isCurrent() ||
      !store.recordTemporaryThreadInput(
        entry,
        { journalBindingKey: cap.journalBindingKey, updateIds },
        cap.authority,
      ) ||
      !cap.isCurrent()
    ) {
      throw new Error(
        "Temporary Thread input membership was not acknowledged; the source remains protected.",
      );
    }
    return true;
  };
  /** Publishes a root chooser; a revived source edits its recorded chooser back to life instead of posting another. */
  const publishRerouteChooser = async (
    pending: PendingUnboundReroute,
    text: string,
    replyMarkup: Menu.TelegramReplyMarkup,
    sendOptions: {
      target?: Queue.TelegramQueueTarget;
      replyToMessageId?: number;
    },
  ): Promise<number | undefined> => {
    const target = pending.sourceTarget;
    const recorded = Updates.getTelegramUpdateRoutingInput(
      pending.messages[0],
    )?.chooser;
    if (
      recorded &&
      deps.editInteractiveMessage &&
      recorded.chatId === target.chatId &&
      recorded.threadId === target.threadId
    ) {
      try {
        await deps.editInteractiveMessage(
          recorded.chatId,
          recorded.messageId,
          text,
          "html",
          replyMarkup,
        );
        return recorded.messageId;
      } catch (error) {
        // The old chooser may be gone; a fresh one keeps the same saved deadline.
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "chooser-revival",
        });
      }
    }
    return deps.sendInteractiveMessage!(
      target.chatId,
      text,
      "html",
      replyMarkup,
      sendOptions,
    );
  };
  const sendUnboundRerouteChooserNow = async (
    messages: TMessage[],
    ctx: TContext,
    reportDeferred = true,
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
          `This thread is not bound to a Pi instance. Open an active Pi thread or run ${Commands.formatTelegramPiCommandHtml("/telegram-connect")} from a Pi session to bind one.`,
        ]
          .filter((line): line is string => typeof line === "string")
          .join("\n\n"),
        { parseMode: "HTML", target: sourceTarget },
      );
      return;
    }
    const command =
      messages.length === 1
        ? getKnownTelegramAllTabCommand(
            Media.extractFirstTelegramMessageText(messages).trim(),
          )
        : undefined;
    const rerouteId = storePendingUnboundReroute(
      messages,
      command ? "command" : "prompt",
    );
    if (reportDeferred) {
      for (const source of messages) {
        Updates.reportTelegramUpdateDeferred(source);
      }
    }
    const inTemporaryThread = await recordUnboundTemporaryThreadInput(
      messages,
      ctx,
    );
    const pending = pendingUnboundReroutes.get(rerouteId)!;
    if (inTemporaryThread) pending.temporaryMembership = true;
    // Any input kind, single or grouped, is cancellable once every source can be retained privately.
    if (
      sourceTarget &&
      deps.runWorkspaceOperation &&
      deps.editInteractiveMessage &&
      deps.getAdmissionJournalBinding &&
      deps.getCurrentLeaderEpoch &&
      deps.isContextActive?.(ctx) === true
    ) {
      const ownerUserId = deps.configStore.getAllowedUserId();
      const journalBindingKey = deps.getAdmissionJournalBinding();
      if (
        ownerUserId !== undefined &&
        journalBindingKey &&
        messages.every(
          (source) =>
            source.chat.type === "private" &&
            source.from?.id === ownerUserId &&
            Updates.getTelegramUpdateExecutionFence(source)?.isCurrent() ===
              true &&
            Updates.supportsTelegramDeferredAbandonment(
              source,
              journalBindingKey,
            ),
        )
      ) {
        const leaderEpoch = deps.getCurrentLeaderEpoch();
        if (leaderEpoch !== undefined)
          pending.abandonment = { ownerUserId, journalBindingKey, leaderEpoch };
      }
    }
    const text = formatTelegramTemporaryThreadChooserText(command?.name);
    pending.rootChooserText = text;
    const replyMarkup = buildTelegramUnboundRerouteChooserMarkup(
      rerouteId,
      activeRecords,
      {
        canRestore: sourceTarget !== undefined,
        canCancel: !!pending.abandonment,
        getDisplayTitle: deps.getDisplayTitle,
      },
    );
    if (deps.sendInteractiveMessage) {
      const chooserId = await publishRerouteChooser(
        pending,
        text,
        replyMarkup,
        sourceTarget
          ? { target: sourceTarget, replyToMessageId: message.message_id }
          : { replyToMessageId: message.message_id },
      );
      rememberRerouteChooser(rerouteId, chooserId);
      return;
    }
    const chooserId = await deps.sendTextReply(
      message.chat.id,
      message.message_id,
      text,
      {
        parseMode: "HTML",
        target: sourceTarget,
      },
    );
    rememberRerouteChooser(rerouteId, chooserId);
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
      // A media group's timer runs outside any request, so it takes the same profile admission as a single message.
      const send = (): Promise<void> =>
        sendUnboundRerouteChooserNow(messages, ctx, false);
      const task = deps.runWorkspaceOperation
        ? deps.runWorkspaceOperation(
            {
              operationId: `workspace-unbound-group:${groupKey}:${randomBytes(8).toString("hex")}`,
              operationKind: "workspace.route-unbound-thread",
              scopes: [{ kind: "profile" }],
            },
            send,
          )
        : send();
      void task.catch((error) => {
        deps.recordRuntimeEvent?.("routing", error, {
          phase: "unbound-media-group-chooser",
        });
      });
    }, 1200);
    timer.unref?.();
    pendingUnboundRerouteMediaGroups.set(groupKey, { messages, timer });
    Updates.reportTelegramUpdateDeferred(message);
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
  /** A fresh implicit native tab whose name the All input starts with, observed just before it in the same exact scope. */
  const findImplicitCreationForAllInput = (
    message: TMessage,
    updateId: number,
    cap: NonNullable<ReturnType<typeof captureTemporaryThreadAuthority>>,
    ctx: TContext,
  ) => {
    const text = (message.text ?? message.caption ?? "").trim();
    let match:
      | {
          key: string;
          implicit: typeof implicitThreadCreations extends Map<string, infer V>
            ? V
            : never;
        }
      | undefined;
    for (const [key, implicit] of implicitThreadCreations) {
      if (
        implicit.name &&
        text.startsWith(implicit.name) &&
        implicit.updateId < updateId &&
        implicit.createdAtSec > 0 &&
        message.date !== undefined &&
        message.date >= implicit.createdAtSec &&
        message.date - implicit.createdAtSec <=
          TELEGRAM_IMPLICIT_ALL_INPUT_WINDOW_SEC &&
        implicit.ctx === ctx &&
        implicit.operatorUserId === cap.operatorUserId &&
        implicit.journalBindingKey === cap.journalBindingKey &&
        isDeepStrictEqual(implicit.executor, cap.authority.executor) &&
        implicit.generation === deps.getSessionGeneration?.() &&
        implicit.scope === deps.getAdmissionScope?.() &&
        (!match || implicit.updateId > match.implicit.updateId)
      )
        match = { key, implicit };
    }
    return match;
  };
  /**
   * An All input gets one source-bound tab. The original stays deferred in All until explicit routing,
   * and an existing entry is reused on replay, so restart never creates a second tab or retries an unknown one.
   */
  const sendAllTabTemporaryInputChooser = async (
    command: Commands.ParsedTelegramCommand | undefined,
    commandText: string,
    message: TMessage,
    ctx: TContext,
  ): Promise<boolean> => {
    const [updateId] = Updates.collectTelegramAdmissionSourceUpdateIds([
      message,
    ]);
    const execution = Updates.getTelegramUpdateExecutionFence(message);
    const cap = captureTemporaryThreadAuthority(
      ctx,
      () => execution?.isCurrent() === true,
    );
    if (
      !cap ||
      !deps.runWorkspaceOperation ||
      !deps.callApi ||
      updateId === undefined ||
      message.chat.type !== "private" ||
      message.chat.id !== cap.operatorUserId ||
      message.from?.id !== cap.operatorUserId ||
      !cap.isCurrent()
    )
      return false;
    const { store, operatorUserId, journalBindingKey, epoch, authority } = cap,
      current = cap.isCurrent;
    const source = { journalBindingKey, updateId };
    const find = () =>
      store
        .listTemporaryThreads()
        .find(
          (entry) =>
            entry.source.journalBindingKey === journalBindingKey &&
            entry.source.updateId === updateId,
        );
    let entry: Threads.TelegramTemporaryThreadEntry | undefined;
    await deps.runWorkspaceOperation(
      {
        operationId: `temporary-thread-${randomBytes(16).toString("hex")}`,
        operationKind: "workspace.temporary-thread",
        scopes: [{ kind: "profile" }],
      },
      async () => {
        if (!current()) return;
        let found = find();
        found = found && cap.adopt(found);
        if (found) {
          entry = found;
          return;
        }
        // Mobile clients sending from All first create a native tab named after the input, then deliver
        // the input itself to All: adopt that tab rather than leaving it behind next to a second one.
        const native = findImplicitCreationForAllInput(message, updateId, cap, ctx);
        if (native) {
          const adopted = store.registerImplicitTemporaryThread(
            { journalBindingKey, updateIds: [updateId] },
            native.implicit.target,
            randomBytes(16).toString("hex"),
            {
              ...authority,
              isCurrent: () =>
                current() &&
                implicitThreadCreations.get(native.key) === native.implicit,
            },
          );
          if (adopted && current()) {
            implicitThreadCreations.delete(native.key);
            entry = adopted;
            // Adopted native tabs share the routing name; a failed rename never blocks routing.
            try {
              await deps.callApi!("editForumTopic", {
                chat_id: native.implicit.target.chatId,
                message_thread_id: native.implicit.target.threadId,
                name: TELEGRAM_TEMPORARY_THREAD_NAME,
              });
            } catch (error) {
              deps.recordRuntimeEvent?.("routing", error, {
                phase: "temporary-thread-name",
              });
            }
            return;
          }
        }
        const reservation = store.reserveTemporaryThread(
          source,
          randomBytes(16).toString("hex"),
          authority,
        );
        entry = reservation?.entry;
        if (!reservation?.reserved || !current()) return;
        let created: { message_thread_id?: unknown } | undefined;
        try {
          // The single creation attempt; any failure leaves `creating` as an unknown outcome, never a retry.
          created = await deps.callApi!<{ message_thread_id?: unknown }>(
            "createForumTopic",
            {
              chat_id: operatorUserId,
              name: TELEGRAM_TEMPORARY_THREAD_NAME,
            },
          );
        } catch (error) {
          deps.recordRuntimeEvent?.("routing", error, {
            phase: "temporary-thread-create",
          });
          return;
        }
        const threadId = created?.message_thread_id;
        if (
          !current() ||
          typeof threadId !== "number" ||
          !Number.isSafeInteger(threadId) ||
          threadId <= 0
        )
          return;
        entry =
          store.acknowledgeTemporaryThread(
            reservation.entry,
            { chatId: operatorUserId, threadId },
            authority,
          ) ?? entry;
      },
    );
    if (!current() || !entry)
      throw new Error(
        "Temporary Thread authority changed; the input remains retryable.",
      );
    const commandMessage = Updates.carryTelegramUpdateExecutionFence(message, {
      ...message,
      text: commandText,
      caption: undefined,
    } as TMessage);
    if (entry.phase !== "created" || !entry.target) {
      Updates.reportTelegramUpdateDeferred(commandMessage);
      await deps.sendTextReply(
        message.chat.id,
        message.message_id,
        "<b>⚠️ The routing tab for this command could not be confirmed.</b> It stays held and was not sent to Pi.",
        { parseMode: "HTML" },
      );
      return true;
    }
    const target = entry.target;
    const records = getTelegramRoutableThreadRecords(
      deps.threadStore?.list() ?? [],
      deps.getLiveThreadTargets?.(),
    );
    const rerouteId = storePendingUnboundReroute(
      [commandMessage],
      command ? "command" : "prompt",
      target,
    );
    const pending = pendingUnboundReroutes.get(rerouteId)!;
    pending.temporaryThread = entry;
    pending.allTabCopies = getTelegramAllTabSourceMessageIds(
      [message],
      target.chatId,
    );
    Updates.reportTelegramUpdateDeferred(commandMessage);
    // Cancel is offered only when the exact source can still be abandoned; the tab removal needs that retention first.
    if (
      deps.editInteractiveMessage &&
      Updates.supportsTelegramDeferredAbandonment(
        commandMessage,
        journalBindingKey,
      )
    ) {
      pending.abandonment = {
        ownerUserId: operatorUserId,
        journalBindingKey,
        leaderEpoch: epoch,
      };
    }
    pending.rootChooserText = formatTelegramTemporaryThreadChooserText(
      command?.name,
    );
    try {
      if (!deps.sendInteractiveMessage)
        throw new Error("Temporary Thread chooser publication is unavailable.");
      const chooserId = await publishRerouteChooser(
        pending,
        pending.rootChooserText,
        buildTelegramUnboundRerouteChooserMarkup(rerouteId, records, {
          canRestore: true,
          canCancel: !!pending.abandonment,
          getDisplayTitle: deps.getDisplayTitle,
        }),
        { target },
      );
      rememberRerouteChooser(rerouteId, chooserId);
    } catch (error) {
      removePendingReroute(rerouteId);
      throw error;
    }
    return true;
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
    const commandMessage = Updates.carryTelegramUpdateExecutionFence(message, {
      ...message,
      text: commandText,
      caption: undefined,
    } as TMessage);
    const rerouteId = storePendingUnboundReroute([commandMessage], "command");
    Updates.reportTelegramUpdateDeferred(commandMessage);
    const text = formatTelegramAllTabMenuChooserText(command.name);
    pendingUnboundReroutes.get(rerouteId)!.rootChooserText = text;
    const replyMarkup = buildTelegramUnboundRerouteChooserMarkup(
      rerouteId,
      activeRecords,
      {
        canRestore: typeof message.message_thread_id === "number",
        getDisplayTitle: deps.getDisplayTitle,
      },
    );
    let chooserId: number | undefined;
    try {
      if (deps.sendInteractiveMessage) {
        chooserId = await deps.sendInteractiveMessage(
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
      } else if (deps.callApi) {
        const chooser = await deps.callApi<{ message_id?: number }>(
          "sendMessage",
          {
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
          },
        );
        chooserId = chooser?.message_id;
      } else {
        chooserId = await deps.sendTextReply(
          message.chat.id,
          message.message_id,
          text,
          {
            parseMode: "HTML",
            target: options.target,
          },
        );
      }
    } catch (error) {
      removePendingReroute(rerouteId);
      throw error;
    }
    rememberRerouteChooser(rerouteId, chooserId);
    Updates.reportTelegramUpdateCompleted(commandMessage);
    return true;
  };
  const dispatchCommandOrPrompt =
    Commands.createTelegramCommandOrPromptDispatcher<TMessage, TContext>({
      extractRawText: Media.extractFirstTelegramMessageText,
      assertExecutionCurrent(message) {
        Updates.assertTelegramUpdateExecutionCurrent(message);
      },
      shouldIgnoreMessages: (messages) =>
        !Media.hasTelegramMessagesPromptContent(messages),
      consumeThreadNameInput: async (messages) => {
        const message = messages[0];
        if (!message || messages.length !== 1) return false;
        const address = Updates.getTelegramMessageTarget(message);
        if (!address) return false;
        const target = { ...address },
          replyToMessageId = message.message_id;
        const candidate = threadNameDialog.inspect(target);
        if (!candidate || candidate.scope !== getThreadNameDialogScope())
          return false;
        const {
          validateThreadName,
          renameCurrentThread,
          resetCurrentThreadName,
          sendTextReply,
        } = deps;
        const lifetime = threadNameDialog.capture(candidate);
        if (!lifetime) return false;
        const portsCurrent = () =>
          deps.validateThreadName === validateThreadName &&
          deps.renameCurrentThread === renameCurrentThread &&
          deps.resetCurrentThreadName === resetCurrentThreadName &&
          deps.sendTextReply === sendTextReply;
        const isCurrent = () =>
          portsCurrent() && lifetime.isCurrent() && portsCurrent();
        const assertRecipient = lifetime.assertAuthority;
        const assertInputAuthority = assertRecipient
          ? () => {
              if (!isCurrent())
                throw new Error(
                  "Telegram Thread name input lost owner authority.",
                );
            }
          : undefined;
        const ownerOptions: [] | [{ assertAuthority: () => void }] =
          assertInputAuthority
            ? [{ assertAuthority: assertInputAuthority }]
            : [];
        // Result effects may outlive input settlement, but never recipient or captured-port loss.
        const assertResultAuthority = assertRecipient
          ? () => {
              assertRecipient();
              if (!portsCurrent())
                throw new Error(
                  "Telegram Thread name result lost port authority.",
                );
              assertRecipient();
            }
          : undefined;
        const replyOptions = () => ({
          parseMode: "HTML" as const,
          target: { ...target },
          ...(assertResultAuthority
            ? { assertAuthority: assertResultAuthority }
            : {}),
        });
        if (!isCurrent()) {
          lifetime.finish();
          return true;
        }
        const name = Media.extractFirstTelegramMessageText(messages).trim();
        const reset = /^[A-Z]$/.test(name) && !!resetCurrentThreadName;
        if (!reset) {
          const validationError = validateThreadName?.(name);
          if (!isCurrent()) {
            lifetime.finish();
            return true;
          }
          if (!name || validationError) {
            await sendTextReply(
              target.chatId,
              replyToMessageId,
              validationError
                ? Commands.formatTelegramInvalidInstanceName(validationError)
                : Commands.formatTelegramInformationHeading(
                    "⚠️",
                    "Send 1–96 printable ASCII characters.",
                  ),
              replyOptions(),
            );
            return true;
          }
        }
        let reopen = false;
        try {
          if (!isCurrent()) return true;
          const consumed = lifetime.consumeName(name);
          if (consumed.kind !== "name" || !isCurrent()) return true;
          const result = reset
            ? await resetCurrentThreadName!({ ...target }, ...ownerOptions)
            : await renameCurrentThread?.(
                { ...target },
                consumed.name,
                ...ownerOptions,
              );
          if (!isCurrent()) return true;
          reopen = !result?.ok;
          const replyText =
            result?.ok && !result.message
              ? reset
                ? Commands.formatTelegramAutomaticThreadDisplayNameRestoredHeading(
                    result.threadName ?? name,
                  )
                : Commands.formatTelegramThreadDisplayNameSavedHeading(
                    result.threadName ?? consumed.name,
                  )
              : Commands.formatTelegramInformationHeading(
                  result?.ok ? "✅" : "⚠️",
                  result?.message ??
                    (reset
                      ? "Thread display name reset failed."
                      : "Thread display name update failed."),
                );
          if (result?.ok) {
            Updates.assertTelegramUpdateExecutionCurrent(message);
            if (!isCurrent()) return true;
            Updates.reportTelegramUpdateCompleted(message);
            if (!isCurrent()) return true;
            // Input completion cannot lend its ended handle to detached recipient/API effects.
            void sendTextReply(
              target.chatId,
              replyToMessageId,
              replyText,
              replyOptions(),
            ).catch((error) =>
              deps.recordRuntimeEvent?.("telegram-command", error, {
                command: "name",
                phase: reset ? "reset-result" : "rename-result",
              }),
            );
            return true;
          }
          if (!isCurrent()) return true;
          await sendTextReply(
            target.chatId,
            replyToMessageId,
            replyText,
            replyOptions(),
          );
          return true;
        } finally {
          if (reopen && isCurrent()) lifetime.reopen();
          lifetime.finish();
        }
      },
      handleCommand: commandHandler,
      executeExtensionCommand: async (command, message, ctx) => {
        const extensionCommand = Commands.findTelegramExtensionCommand(
          command.name,
        );
        if (!extensionCommand) return false;
        const sourceTarget = Updates.getTelegramMessageTarget(message);
        const assertExecutionCurrent =
          Updates.createTelegramUpdateExecutionFenceGuard(message);
        try {
          assertExecutionCurrent();
          await extensionCommand.handler({
            name: command.name,
            args: command.args,
            reply: async (text) => {
              assertExecutionCurrent();
              await deps.sendTextReply(
                message.chat.id,
                message.message_id,
                text,
                { target: sourceTarget },
              );
              assertExecutionCurrent();
            },
            enqueuePrompt: async (prompt) => {
              assertExecutionCurrent();
              await promptEnqueue(
                [
                  {
                    ...message,
                    text: prompt,
                    caption: undefined,
                  } as TMessage,
                ],
                ctx,
              );
            },
          });
          assertExecutionCurrent();
        } catch (error) {
          deps.recordRuntimeEvent?.("telegram-command", error, {
            command: command.name,
          });
          assertExecutionCurrent();
          await deps.sendTextReply(
            message.chat.id,
            message.message_id,
            "Command failed.",
            { target: sourceTarget },
          );
        }
        return true;
      },
      expandPromptTemplateCommand,
      replaceMessageText: (message, text) =>
        Updates.carryTelegramUpdateExecutionFence(message, {
          ...message,
          text,
          caption: undefined,
        } as TMessage),
      enqueueTurn: async (messages, ctx) => {
        await promptEnqueue(messages, ctx);
      },
    });
  dispatchReroutedCommandMessages = dispatchCommandOrPrompt;
  const mediaDispatch = Media.createTelegramMediaGroupDispatchRuntime<
    TMessage,
    TContext
  >({
    mediaGroups: deps.mediaGroupRuntime,
    dispatchMessages: dispatchCommandOrPrompt,
    onDeferredMessage: Updates.reportTelegramUpdateDeferred,
  });
  const textDispatch = TextGroups.createTelegramTextGroupDispatchRuntime<
    TMessage,
    TContext
  >({
    textGroups: deps.textGroupRuntime,
    dispatchMessages: dispatchCommandOrPrompt,
    dispatchSingleMessage: mediaDispatch.handleMessage,
    onDeferredMessage: Updates.reportTelegramUpdateDeferred,
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
    const assertExecutionCurrent =
      Updates.createTelegramUpdateExecutionFenceGuard(lifecycle.message);
    assertExecutionCurrent();
    await deps.handleTelegramTopicLifecycleUpdate?.(lifecycle, ctx);
    assertExecutionCurrent();
    const key = formatTelegramTargetKey(lifecycle.target);
    if (lifecycle.kind !== "created" || !deps.threadStore) {
      implicitThreadCreations.delete(key);
      return;
    }
    await deps.threadStore.load();
    assertExecutionCurrent();
    const message = lifecycle.message,
      created = message.forum_topic_created;
    const [updateId] = Updates.collectTelegramAdmissionSourceUpdateIds([
      message,
    ]);
    const cap = captureTemporaryThreadAuthority(
      ctx,
      () =>
        Updates.getTelegramUpdateExecutionFence(message)?.isCurrent() === true,
    );
    if (
      created &&
      typeof created === "object" &&
      "is_name_implicit" in created &&
      created.is_name_implicit === true &&
      cap &&
      deps.runWorkspaceOperation &&
      updateId !== undefined &&
      !Updates.isTelegramHistoricalInput(message) &&
      message.chat.type === "private" &&
      message.chat.id === cap.operatorUserId &&
      message.from?.id === cap.operatorUserId &&
      message.from.is_bot === false &&
      cap.isCurrent() &&
      implicitThreadCreations.size < 100
    ) {
      implicitThreadCreations.set(key, {
        ctx,
        updateId,
        operatorUserId: cap.operatorUserId,
        journalBindingKey: cap.journalBindingKey,
        executor: structuredClone(cap.authority.executor),
        generation: deps.getSessionGeneration?.(),
        scope: deps.getAdmissionScope?.(),
        target: {
          chatId: lifecycle.target.chatId,
          threadId: lifecycle.target.threadId!,
        },
        name: "name" in created && typeof created.name === "string" ? created.name : "",
        createdAtSec: message.date ?? 0,
      });
    } else implicitThreadCreations.delete(key);
  };
  // Answer the guest query immediately so the agent-end edit can replace the
  // early ACK once the turn settles. The ACK is the first placeholder frame and
  // the loop rotates through the remaining frames until the replacement.
  const TELEGRAM_GUEST_ACK_HTML = Replies.buildTelegramGuestPlaceholderFrame(0);
  const handleAuthorizedTelegramGuestMessage = async (
    guestMessage: Updates.TelegramGuestMessage & { from: TelegramUser },
    ctx: TContext,
  ): Promise<void> => {
    const assertExecutionCurrent =
      Updates.createTelegramUpdateExecutionFenceGuard(guestMessage);
    assertExecutionCurrent();
    let guestInlineMessageId: string | undefined;
    if (deps.answerGuestQueryForInlineMessage) {
      try {
        guestInlineMessageId = await deps.answerGuestQueryForInlineMessage(
          guestMessage.guest_query_id,
          TELEGRAM_GUEST_ACK_HTML,
          { parseMode: "HTML" },
        );
        if (guestInlineMessageId) {
          deps.startGuestPlaceholder?.(guestInlineMessageId);
        }
        deps.recordRuntimeEvent?.(
          "guest",
          new Error("Guest ACK answered the guest query"),
          {
            phase: "guest-ack-sent",
            guestQueryId: guestMessage.guest_query_id,
            hasInlineMessageId: !!guestInlineMessageId,
          },
        );
      } catch (error) {
        deps.recordRuntimeEvent?.("guest", error, {
          phase: "guest-ack-failed",
          guestQueryId: guestMessage.guest_query_id,
        });
      }
      assertExecutionCurrent();
    }
    // Media messages carry the user's text as a caption.
    const text = guestMessage.text ?? guestMessage.caption ?? "";
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
    // Guest message IDs belong to the peer's chat; scope files to that peer so they cannot collide with bot-chat files.
    const guestScope = resolveTelegramGuestFileScope({
      chatType,
      chat: chatRaw,
      from: fromRaw,
      replyFrom: replyFromRaw,
      guestBotCallerUser,
      guestBotCallerChat,
      ownerUserId,
    });
    const downloadGuestFile: typeof deps.downloadFile = (
      fileId,
      fileName,
      source,
    ) =>
      deps.downloadFile(
        fileId,
        fileName,
        source ? { ...source, scope: guestScope } : source,
      );
    const replyFiles = guestMsg.reply_to_message
      ? await Media.downloadTelegramMessageFiles(
          [guestMsg.reply_to_message as Media.TelegramMediaMessage],
          { downloadFile: downloadGuestFile },
        )
      : [];
    assertExecutionCurrent();
    const processedReply =
      replyFiles.length > 0
        ? await deps.inboundHandlerRuntime.process(replyFiles, "", ctx)
        : undefined;
    assertExecutionCurrent();
    const files = await Media.downloadTelegramMessageFiles([guestMsg], {
      downloadFile: downloadGuestFile,
    });
    assertExecutionCurrent();
    const processed = await deps.inboundHandlerRuntime.process(
      files,
      text,
      ctx,
    );
    assertExecutionCurrent();
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
        processedReply?.promptFiles ?? replyFiles,
        processedReply?.handlerOutputs,
      );
    }
    const promptText = Turns.buildTelegramTurnPrompt({
      telegramPrefix,
      rawText,
      files,
      promptFiles: processed.promptFiles,
      handlerOutputs: processed.handlerOutputs,
      sourceContext,
      // Guest Mode allows exactly one reply within Telegram's limited response
      // window; the note travels with the turn text so the agent sees it at
      // execution time without a guest-specific system prompt variant.
      guestTurn: true,
    });
    const order = deps.bridgeRuntime.queue.allocateItemOrder();
    const content: Queue.TelegramPromptContent[] = [
      { type: "text", text: promptText },
    ];
    for (const file of processed.promptFiles) {
      if (file.isImage && file.mimeType) {
        try {
          const buffer = await readFile(file.path);
          assertExecutionCurrent();
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
    const admissionReceipts = createAdmissionReceipts("prompt", [guestMessage]);
    const guestTurn: Queue.PendingTelegramTurn = {
      kind: "prompt",
      chatId: 0,
      replyToMessageId: 0,
      guestQueryId: guestMessage.guest_query_id,
      ...(guestInlineMessageId ? { guestInlineMessageId } : {}),
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
      ...(admissionReceipts.length > 0 ? { admissionReceipts } : {}),
    };
    const items = deps.telegramQueueStore.getQueuedItems();
    Updates.assertTelegramUpdateExecutionCurrent(guestMessage);
    deps.telegramQueueStore.setQueuedItems(
      Queue.appendTelegramQueueItem(items, guestTurn),
    );
    reportQueueAdmission([guestMessage], admissionReceipts);
    deps.updateStatus(ctx);
    requestDispatchNextQueuedTelegramTurn(ctx);
  };
  const runtime = Updates.createTelegramPairedUpdateRuntime<TContext, TUpdate>({
    getAllowedUserId: deps.configStore.getAllowedUserId,
    getCurrentInstanceId: deps.getCurrentInstanceId,
    getMessageOwnership: deps.getMessageOwnership,
    getTargetOwnership: deps.getTargetOwnership,
    recordMessageOwnership: deps.recordMessageOwnership,
    handleTelegramTopicLifecycleUpdate,
    foreignOwnedUpdateForwarder: deps.foreignOwnedUpdateForwarder,
    persistAllowedUserId: deps.configStore.persistAllowedUserId,
    updateStatus: deps.updateStatus,
    removePendingMediaGroupMessages: deps.mediaGroupRuntime.removeMessages,
    flushPendingMediaGroupMessage: deps.mediaGroupRuntime.flushMessage,
    flushPendingTextGroupMessage: deps.textGroupRuntime.flushMessage,
    removeQueuedTelegramTurnsByMessageIds:
      deps.queueMutationRuntime.removeByMessageIds,
    applyQueuedTelegramTurnReactionByMessageId:
      deps.queueMutationRuntime.applyReactionByMessageId,
    answerCallbackQuery: deps.answerCallbackQuery,
    answerGuestQuery: deps.answerGuestQuery,
    handleAuthorizedTelegramCallbackQuery: callbackHandler,
    sendTextReply: deps.sendTextReply,
    handleAuthorizedTelegramMessage: async (message, ctx) => {
      const assertExecutionCurrent =
        Updates.createTelegramUpdateExecutionFenceGuard(message);
      assertExecutionCurrent();
      if (typeof message.message_thread_id === "number") {
        await deps.handleTelegramThreadTargetObserved?.(
          {
            chatId: message.chat.id,
            threadId: message.message_thread_id,
          },
          ctx,
        );
        assertExecutionCurrent();
      }
      const text = Media.extractFirstTelegramMessageText([
        message as TMessage,
      ]).trim();
      if (deps.threadStore && typeof message.message_thread_id !== "number") {
        await deps.threadStore.load();
        assertExecutionCurrent();
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
        const [sourceUpdateId] =
          Updates.collectTelegramAdmissionSourceUpdateIds([message]);
        const presented =
          sourceUpdateId !== undefined &&
          deps
            .getWorkspaceRestoreStore?.()
            ?.listTemporaryThreads()
            .some(
              (entry) =>
                entry.source.updateId === sourceUpdateId &&
                entry.source.journalBindingKey ===
                  deps.getAdmissionJournalBinding?.(),
            ) === true;
        // Returning before deferral lets the admission worker terminally settle expired replay; a presented tab is not expiry.
        if (
          command &&
          command.name !== "thread" &&
          !presented &&
          isTelegramAllTabCommandExpired(message)
        )
          return;
        if (
          command?.name !== "thread" &&
          (bindings.length > 0 || presented) &&
          typeof message.text === "string" &&
          message.text.trim() &&
          (await sendAllTabTemporaryInputChooser(
            command,
            text,
            message as TMessage,
            ctx,
          ))
        )
          return;
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
                assertExecutionCurrent();
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
    handleUnboundTelegramTopicMessage: (message, ctx) => {
      const operation = async (): Promise<void> => {
        const assertExecutionCurrent =
          Updates.createTelegramUpdateExecutionFenceGuard(message);
        assertExecutionCurrent();
        if (!deps.threadStore) {
          await textDispatch.handleMessage(message as TMessage, ctx);
          return;
        }
        await deps.threadStore.load();
        assertExecutionCurrent();
        if (
          Updates.isTelegramHistoricalInput(
            message,
            (entry) => reviewMessage(entry) !== undefined,
          ) &&
          isReviewText(message as TMessage) &&
          deps.getCurrentLeaderEpoch?.() !== undefined &&
          needsHistoricalReview(message as TMessage)
        ) {
          if (!Updates.reportTelegramHistoricalRoutingReview(message))
            throw new Error("Historical routing hold is unavailable.");
          return;
        }
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
        const unboundTarget = {
          chatId: target.chatId,
          threadId: target.threadId,
        };
        /** Rebinds the leader record to this unbound tab, publishes its identity and handles the message there. */
        const reclaimUnboundTargetForLeader = async (
          base: Partial<Threads.TelegramTopicTargetRecord> &
            Pick<Threads.TelegramTopicTargetRecord, "createdAtMs">,
          profileKey: string,
          slot: string,
          threadName: string,
          event: string,
          details: Record<string, unknown>,
        ): Promise<void> => {
          deps.threadStore!.upsert({
            ...base,
            profileKey,
            owner: {
              kind: "leader",
              cwd:
                typeof (ctx as { cwd?: unknown }).cwd === "string"
                  ? (ctx as { cwd?: string }).cwd
                  : undefined,
              instanceId,
            },
            target: { ...unboundTarget },
            status: "active",
            updatedAtMs: Date.now(),
            threadName,
            instanceId,
            slot,
          });
          await deps.threadStore!.persist();
          assertExecutionCurrent();
          deps.setCurrentLeaderIdentity?.({
            target: { ...unboundTarget },
            slot,
            threadName,
          });
          deps.recordRuntimeEvent?.("bus", event, {
            ...details,
            ...unboundTarget,
            slot,
            profileKey,
          });
          await textDispatch.handleMessage(message as TMessage, ctx);
        };
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
              assertExecutionCurrent();
            }
            await textDispatch.handleMessage(message as TMessage, ctx);
            return;
          }
          if (existing.status === "starting") {
            await deps.sendTextReply(
              target.chatId,
              message.message_id,
              "Instance " +
                getTelegramThreadRecordLabel(existing, deps.getDisplayTitle) +
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
                escapeHtml(
                  getTelegramThreadRecordLabel(existing, deps.getDisplayTitle),
                ) +
                ` is not currently registered with the Telegram bus. This thread is preserved; retry shortly. If it does not recover, run ${Commands.formatTelegramPiCommandHtml("/telegram-connect")} in that Pi instance.`,
              { parseMode: "HTML", target },
            );
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
        const deletedObservation = deps.threadStore
          .listSyncObservations()
          .find(
            (observation) =>
              observation.syncStatus === "deleted" &&
              observation.target.chatId === target.chatId &&
              observation.target.threadId === target.threadId,
          );
        if (deletedObservation) {
          deps.recordRuntimeEvent?.(
            "inbound-worker",
            "Discarded update from a confirmed deleted Telegram thread",
            {
              phase: "discard-deleted-thread",
              chatId: target.chatId,
              threadId: target.threadId,
              messageId: message.message_id,
            },
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
          await sendUnboundRerouteChooser(message as TMessage, ctx);
          return;
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
              const slot = deps.threadStore.allocateSlot(leaderProfileKey);
              if (!slot) {
                deps.threadStore.markStaleByTarget(
                  currentLeaderRecord.target,
                  "deleted",
                  "Current leader thread is stale during unbound prompt routing.",
                );
                await deps.threadStore.persist();
                assertExecutionCurrent();
                await deps.sendTextReply(
                  target.chatId,
                  message.message_id,
                  TELEGRAM_SLOT_CAPACITY_MESSAGE,
                  { target },
                );
                return;
              }
              deps.threadStore.markStaleByTarget(
                currentLeaderRecord.target,
                "deleted",
                "Current leader thread is stale during unbound prompt routing.",
              );
              const threadName = getRestoredThreadName(
                currentLeaderRecord,
                slot,
              );
              await reclaimUnboundTargetForLeader(
                currentLeaderRecord,
                leaderProfileKey,
                slot,
                threadName,
                "Bus leader reclaimed stale-current unbound thread",
                {
                  phase: "leader-topic-unbound-stale-reclaim",
                  staleThreadId: currentLeaderRecord.target.threadId,
                },
              );
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
          const slot = deps.threadStore.allocateSlot(
            leaderProfileKey,
            priorLeaderRecord?.slot ?? priorLeaderIdentity?.slot,
          );
          if (!slot) {
            await deps.sendTextReply(
              target.chatId,
              message.message_id,
              TELEGRAM_SLOT_CAPACITY_MESSAGE,
              { target },
            );
            return;
          }
          const identityThreadName =
            priorLeaderIdentity?.threadName &&
            ThreadNaming.isTelegramTopicThreadNameValidForSlot(
              priorLeaderIdentity.threadName,
              slot,
            )
              ? priorLeaderIdentity.threadName
              : undefined;
          const threadName =
            priorLeaderRecord?.threadName ??
            identityThreadName ??
            ThreadNaming.chooseTelegramThreadName({ slot }) ??
            "Pi";
          await reclaimUnboundTargetForLeader(
            { createdAtMs: priorLeaderRecord?.createdAtMs ?? Date.now() },
            leaderProfileKey,
            slot,
            threadName,
            "Bus leader reclaimed unbound thread",
            { phase: "leader-topic-reclaim" },
          );
          return;
        }
        await sendUnboundRerouteChooser(message as TMessage, ctx);
        return;
      };
      if (!deps.runWorkspaceOperation) return operation();
      return deps.runWorkspaceOperation(
        {
          operationId: `workspace-unbound:${message.chat.id}:${message.message_id}`,
          operationKind: "workspace.route-unbound-thread",
          scopes: [{ kind: "profile" }],
        },
        operation,
      );
    },
  });
  return {
    ...runtime,
    expireRoutingInput,
    shouldReviewHistoricalInput,
    shouldHoldPendingInput,
    forgetPreviousWorld,
    beforeQueueReceiptPublished,
    onQueueReceiptCommitted,
    onQueueReceiptCompleted,
    onUpdateCompleted,
    prepareHeldCommand: commandHandler.prepareHeldCommand,
    canPrepareHeldCommand: commandHandler.canPrepareHeldCommand,
    observeLiveRebindLeaderWork,
    prepareLiveRebindLeaderCleanup,
    prepareLiveRebindFollowerCleanup,
    issueLiveRebindLeaderCleanup,
    issueLiveRebindFollowerCleanup,
    onWorkspaceRestoreRecipientObserved(follower, isCurrent, ctx) {
      if (ctx !== undefined)
        return observeRestoreSettlement(
          { kind: "recipient", follower, isCurrent },
          ctx,
        );
      return undefined;
    },
    continueLiveRebindPrompt,
    async waitForRestoreSettlement() {
      await Promise.all([...restoreSettlementTasks]);
    },
  };
}

// --- Assistant Output Delivery Authority ---

export interface TelegramAssistantOutputAuthority<TTransportStamp> {
  transportStamp: TTransportStamp;
  route: "direct" | "follower" | "none";
  directEpoch?: number | string;
  followerGeneration?: string;
  target?: Queue.TelegramQueueTarget;
}

export interface TelegramAssistantOutputAuthorityRuntime<TTransportStamp> {
  captureAuthority: () => TelegramAssistantOutputAuthority<TTransportStamp>;
  isAuthorityActive: (
    authority: TelegramAssistantOutputAuthority<TTransportStamp>,
  ) => boolean;
  canDeliver: () => boolean;
}

export function createTelegramAssistantOutputAuthorityRuntime<
  TTransportStamp,
>(deps: {
  getPreferredTarget: () => Queue.TelegramQueueTarget | undefined;
  getFallbackChatId: () => number | undefined;
  getTransportStamp: () => TTransportStamp;
  isTransportStampActive: (stamp: TTransportStamp) => boolean;
  ownsDirect: () => boolean;
  getDirectEpoch: () => number | string | undefined;
  isFollowerRegistered: () => boolean;
  getFollowerGeneration: () => string | undefined;
}): TelegramAssistantOutputAuthorityRuntime<TTransportStamp> {
  const getCurrentTarget = (): Queue.TelegramQueueTarget | undefined => {
    const preferred = deps.getPreferredTarget();
    if (preferred) return { ...preferred };
    const chatId = deps.getFallbackChatId();
    return chatId === undefined ? undefined : { chatId };
  };
  return {
    captureAuthority() {
      const target = getCurrentTarget();
      const directEpoch = deps.ownsDirect() ? deps.getDirectEpoch() : undefined;
      const followerGeneration = deps.isFollowerRegistered()
        ? deps.getFollowerGeneration()
        : undefined;
      return {
        transportStamp: deps.getTransportStamp(),
        route:
          directEpoch !== undefined
            ? "direct"
            : followerGeneration !== undefined
              ? "follower"
              : "none",
        directEpoch,
        followerGeneration,
        target,
      };
    },
    isAuthorityActive(authority) {
      if (!deps.isTransportStampActive(authority.transportStamp)) return false;
      const target = getCurrentTarget();
      if (
        authority.target === undefined ||
        target?.chatId !== authority.target.chatId ||
        target?.threadId !== authority.target.threadId
      ) {
        return false;
      }
      if (authority.route === "direct") {
        return (
          deps.ownsDirect() && deps.getDirectEpoch() === authority.directEpoch
        );
      }
      if (authority.route === "follower") {
        return (
          !deps.ownsDirect() &&
          deps.isFollowerRegistered() &&
          deps.getFollowerGeneration() === authority.followerGeneration
        );
      }
      return false;
    },
    canDeliver() {
      return deps.ownsDirect() || deps.isFollowerRegistered();
    },
  };
}
