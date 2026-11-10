/**
 * Telegram multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { platform as getPlatform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  classifyTelegramBusTransportError,
  createTelegramBusTransportTimeoutError,
  delayTelegramBusTransportRetry,
  getTelegramBusEndpointDiagnostics,
  getTelegramBusFollowerEndpoint,
  getTelegramBusLeaderEndpoint,
  getTelegramBusPipePath,
  getTelegramBusTransportRetryPolicy,
  isRetryableTelegramBusTransportError,
  isTelegramBusPipePath,
  probeTelegramBusEndpoint,
  TELEGRAM_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES,
  TelegramBusConnectionReadinessExpiredError,
  type TelegramBusEndpointLayout,
  type TelegramBusTransportEventRecorder,
  type TelegramBusTransportRetryPolicy,
} from "./bus-transport.ts";
import type { TelegramThreadDisplayMode } from "./config.ts";
import {
  isSameTelegramLockOwner,
  TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
  type TelegramLockEntry,
  type TelegramLockState,
} from "./locks.ts";
import { resolveAgentDir } from "./paths.ts";
import type { TelegramFollowerReadiness } from "./polling.ts";
import { getTelegramProcessBirthIdentity } from "./process-identity.ts";
import {
  parseTelegramQueueHandoffPayload,
  TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES,
  type TelegramQueueHandoffPayload,
} from "./queue.ts";
import {
  areTelegramTargetsEqual,
  parseTelegramTarget as parseTarget,
  type TelegramTarget,
} from "./target.ts";
import {
  normalizeTelegramSessionReplacementIntent,
  type TelegramSessionReplacementIntent,
} from "./threads.ts";
import {
  hasOnlyWireKeys,
  isTelegramArtifactCaption,
  isTelegramArtifactFileName,
  isWireRecord as isRecord,
  TELEGRAM_ARTIFACT_MAX_BYTES,
} from "./wire.ts";

interface TelegramBusProcessRuntime {
  instanceId: string;
  processId: number;
  processBirthId: string;
  manualFollowerOwnerId: string;
  getLeaderSocketPath: () => string;
  getFollowerSocketPath: () => string;
}

export function createCurrentTelegramBusProcessRuntime(input: {
  getActiveProfileName: () => string | undefined;
  endpointLayout?: TelegramBusEndpointLayout;
  pid?: number;
  parentPid?: number;
  createdAtMs?: number;
}): TelegramBusProcessRuntime {
  return createTelegramBusProcessRuntime({
    getActiveProfileName: input.getActiveProfileName,
    endpointLayout: input.endpointLayout,
    pid: input.pid ?? process.pid,
    parentPid: input.parentPid ?? process.ppid,
    createdAtMs: input.createdAtMs ?? Date.now(),
  });
}

export function createTelegramBusProcessRuntime(input: {
  getActiveProfileName: () => string | undefined;
  endpointLayout?: TelegramBusEndpointLayout;
  pid: number;
  parentPid: number;
  parentProcessIdentity?: string;
  createdAtMs: number;
}): TelegramBusProcessRuntime {
  const getActiveProfileName = input.getActiveProfileName,
    endpointLayout = input.endpointLayout;
  const instanceId = `${input.pid}:${input.createdAtMs}`;
  const ownerPid = input.parentPid || input.pid;
  const manualFollowerOwnerId =
    input.parentProcessIdentity ??
    getTelegramProcessBirthIdentity(ownerPid, input.createdAtMs);
  return {
    instanceId,
    processId: input.pid,
    processBirthId: getTelegramProcessBirthIdentity(input.pid, instanceId),
    manualFollowerOwnerId,
    getLeaderSocketPath: () =>
      getTelegramBusSocketPath(
        undefined,
        undefined,
        getActiveProfileName(),
        endpointLayout,
      ),
    getFollowerSocketPath: () =>
      getTelegramBusFollowerSocketPath(
        instanceId,
        undefined,
        undefined,
        getActiveProfileName(),
        endpointLayout,
      ),
  };
}

export function createTelegramBusAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

// v3: journal source serialization left the config transaction; mixed v2/v3 peers would not exclude each other.
const TELEGRAM_BUS_PROTOCOL_VERSION = 3 as const;
export const TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION =
  "durable-follower-admission-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF =
  "queue-handoff-v1" as const;
/** Unspent Steer lane codec; independent from baseline receipt handoff support. */
export const TELEGRAM_BUS_CAPABILITY_QUEUE_STEER = "queue-steer-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_CONNECT_RECOVERY = "explicit-connect-recovery-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE =
  "input-custody-reference-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME =
  "workspace-thread-rename-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE =
  "thread-display-mode-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT =
  "directory-display-format-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT =
  "workspace-follower-auto-connect-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT =
  "session-replacement-intent-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE =
  "workspace-restore-v1" as const;
/** Shared Workspace readers understand independent pre-dispatch input/cleanup state. */
export const TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND = "live-rebind-pre-dispatch-reader-v2" as const;
/** Shared Workspace decoder understands non-creating, unissued cancelled-orphan intents; no execution/deletion grant. */
export const TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER = "workspace-orphan-intent-reader-v1" as const;
/** Adds the irreversible issued marker and its original-scope/current-executor codec; independent of execution authority. */
export const TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER = "workspace-orphan-intent-reader-v2" as const;
export const TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION = "live-rebind-pre-dispatch-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE =
  "live-thread-rebind-save-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY =
  "live-thread-rebind-apply-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE =
  "live-thread-rebind-settle-v1" as const;
/** Restricted recipient text/menu delivery; negotiated identity and captured effect authority remain required. */
export const TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY =
  "selected-menu-delivery-v1" as const;
/** Versioned held-command set; syntax is shared, while the captured recipient Commands registry owns supported plans. */
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET =
  "live-thread-rebind-command-set-v1" as const;
/** Every live rebinding needs the save/apply/settle trio; held command selections additionally need these two. */
export const TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES = [
  TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
  TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY,
  TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
] as const;
export const TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES = [
  TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET,
  TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
] as const;

/** Start/help are restricted menu aliases, negotiated separately from the original held-command set. */
export const TELEGRAM_BUS_CAPABILITY_HELD_MENU_ALIASES = "held-menu-aliases-v1" as const;
export function getTelegramBusHeldCommandCapabilities(name: string): readonly string[] {
  return name === "start" || name === "help"
    ? [...TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES, TELEGRAM_BUS_CAPABILITY_HELD_MENU_ALIASES]
    : TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES;
}

export interface TelegramBusSelectedCommandInput {
  name: string;
  target: TelegramTarget & { threadId: number };
}

function parseSelectedCommandInput(
  value: unknown,
): TelegramBusSelectedCommandInput | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyWireKeys(value, ["name", "target"]) ||
    typeof value.name !== "string" ||
    !/^[a-z0-9_]{1,32}$/u.test(value.name) ||
    !isRecord(value.target) ||
    !hasOnlyWireKeys(value.target, ["chatId", "threadId"])
  )
    return undefined;
  const target = parseThreadTarget(value.target);
  return target &&
    Number.isSafeInteger(target.chatId) &&
    target.chatId > 0 &&
    Number.isSafeInteger(target.threadId) &&
    target.threadId > 0
    ? { name: value.name, target }
    : undefined;
}

export type TelegramBusSelectedMenuTextEffect = {
  text: string;
  parseMode?: "HTML";
  replyMarkup?: {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
} & (
  | { kind: "send-text"; replyToMessageId?: number }
  | { kind: "edit-text"; messageId: number }
);

/** Serializable identity/effect description, never a process-local callback or standalone delivery grant. */
export interface TelegramBusSelectedMenuDelivery {
  kind: "follower.deliverSelectedMenu";
  requestId: string;
  instanceId: string;
  registrationGeneration: string;
  operationId: string;
  recipient: {
    sessionId: string;
    sessionGeneration: number;
    processId: number;
    processBirthId: string;
    profileKey: string;
    journalBindingKey: string;
    target: TelegramTarget & { threadId: number };
  };
  executor: { instanceId: string; leaderEpoch: string };
  operatorUserId: number;
  effect: TelegramBusSelectedMenuTextEffect;
  sentAtMs: number;
}

export interface TelegramBusSelectedMenuDeliveryObservation {
  operationId: string;
  recipient: TelegramBusSelectedMenuDelivery["recipient"];
  registrationGeneration: string;
  effect: TelegramBusSelectedMenuTextEffect["kind"];
  messageId: number;
}

/** Closed wire projection of prepared recipient source; independent of journal implementation and never a removal grant. */
export interface TelegramBusPreparedCommandSource {
  journalBindingKey: string;
  updateId: number;
  sourceSha256: string;
}

/** Pure live-rebind recipient/operation identity shared by prepare/apply/settle envelopes. */
function parseLiveRebindRecipient(value: Record<string, unknown>):
  | {
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      recipientSessionId: string;
      recipientBindingKey: string;
      operationId: string;
    }
  | undefined {
  const {
    recipientInstanceId,
    recipientRegistrationGeneration,
    recipientSessionId,
    recipientBindingKey,
    operationId,
  } = value;
  return typeof recipientInstanceId === "string" &&
    recipientInstanceId &&
    typeof recipientRegistrationGeneration === "string" &&
    recipientRegistrationGeneration &&
    typeof recipientSessionId === "string" &&
    recipientSessionId &&
    typeof recipientBindingKey === "string" &&
    recipientBindingKey &&
    typeof operationId === "string" &&
    operationId.length > 0 &&
    operationId.length <= 128
    ? {
        recipientInstanceId,
        recipientRegistrationGeneration,
        recipientSessionId,
        recipientBindingKey,
        operationId,
      }
    : undefined;
}

/** Non-empty, duplicate-free, non-negative safe-integer Telegram update ids. */
function isUniqueSourceUpdateIds(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => Number.isSafeInteger(id) && (id as number) >= 0) &&
    new Set(value).size === value.length
  );
}

function parsePreparedCommandSource(
  value: unknown,
): TelegramBusPreparedCommandSource | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyWireKeys(value, [
      "journalBindingKey",
      "updateId",
      "sourceSha256",
    ]) ||
    typeof value.journalBindingKey !== "string" ||
    !value.journalBindingKey ||
    !Number.isSafeInteger(value.updateId) ||
    (value.updateId as number) < 0 ||
    typeof value.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceSha256)
  )
    return undefined;
  return {
    journalBindingKey: value.journalBindingKey,
    updateId: value.updateId as number,
    sourceSha256: value.sourceSha256,
  };
}

export interface TelegramBusLiveRebindSaveObservation {
  operationId: string;
  recipient: {
    instanceId: string;
    sessionId: string;
    generation: string;
    bindingKey: string;
  };
  sourceUpdateIds: number[];
  selectedCommand?: TelegramBusSelectedCommandInput;
  preparedSource?: TelegramBusPreparedCommandSource;
  status: "saved";
}

/** Read-only warm observation; semantic completion and exact source ACK are distinct from detached delivery. */
export interface TelegramBusLiveRebindCommandObservation extends Omit<
  TelegramBusLiveRebindSaveObservation,
  "status" | "preparedSource" | "selectedCommand"
> {
  status: "command-observed";
  selectedCommand: TelegramBusSelectedCommandInput;
  preparedSource: TelegramBusPreparedCommandSource;
  command: "completed" | "unknown" | "not-issued";
  sourceAck?: TelegramBusPreparedCommandSource;
}

export interface TelegramBusLiveRebindWorkState {
  sessionBusy: boolean;
  targetWork: boolean;
  deliveryPending: boolean;
  unknown: boolean;
}

export interface TelegramBusLiveRebindWorkObservation extends Omit<
  TelegramBusLiveRebindSaveObservation,
  "status"
> {
  status: "observed";
  oldTarget: TelegramTarget & { threadId: number };
  work: TelegramBusLiveRebindWorkState;
}

export interface TelegramBusLiveRebindSettlementObservation extends Omit<
  TelegramBusLiveRebindSaveObservation,
  "status"
> {
  action: "release" | "discard";
  status: "released" | "discarded" | "protected" | "unknown";
}

export interface TelegramBusLiveRebindApplyObservation extends Omit<
  TelegramBusLiveRebindSaveObservation,
  "status"
> {
  status: "saved" | "applied";
  target: TelegramTarget & { threadId: number };
  slot: string;
}

export interface TelegramBusWorkspaceRestoreObservation {
  operationId: string;
  recipient: {
    kind: "follower";
    instanceId: string;
    sessionId: string;
    generation: string;
  };
  target: TelegramTarget & { threadId: number };
  slot: string;
  ready: boolean;
}

export interface TelegramBusProtocolIdentity {
  protocolVersion: number;
  runtimeBuild: string;
  capabilities: string[];
}

interface TelegramBusProtocolCompatibility {
  compatible: boolean;
  reason?: "missing-identity" | "version-mismatch" | "missing-capability";
  missingCapabilities: string[];
}

export function createTelegramBusProtocolIdentity(input: {
  runtimeBuild: string;
  capabilities?: readonly string[];
}): TelegramBusProtocolIdentity {
  const runtimeBuild = input.runtimeBuild.trim();
  if (!runtimeBuild || runtimeBuild.length > 128) {
    throw new Error("Telegram bus runtime build identity is invalid.");
  }
  const capabilities = [...new Set(input.capabilities ?? [])].sort();
  if (
    capabilities.length > 32 ||
    capabilities.some(
      (capability) =>
        capability.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/u.test(capability),
    )
  ) {
    throw new Error("Telegram bus capabilities must be canonical identifiers.");
  }
  return {
    protocolVersion: TELEGRAM_BUS_PROTOCOL_VERSION,
    runtimeBuild,
    capabilities,
  };
}

export function createTelegramCurrentBusProtocolIdentity(
  capabilities: readonly string[] = [],
): TelegramBusProtocolIdentity {
  const packageMetadata = createRequire(import.meta.url)("../package.json") as {
    version?: unknown;
  };
  if (typeof packageMetadata.version !== "string") {
    throw new Error("Telegram package build identity is unavailable.");
  }
  return createTelegramBusProtocolIdentity({
    runtimeBuild: packageMetadata.version,
    capabilities,
  });
}

export function hasTelegramBusCapability(
  identity: TelegramBusProtocolIdentity | undefined,
  capability: string,
): boolean {
  return identity?.capabilities.includes(capability) ?? false;
}

export function hasTelegramBusSteerQueueHandoffCapability(identity: TelegramBusProtocolIdentity | undefined): boolean {
  return hasTelegramBusCapability(identity, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF) &&
    hasTelegramBusCapability(identity, TELEGRAM_BUS_CAPABILITY_QUEUE_STEER);
}

/** Both peers advertise every required capability over a compatible protocol; reads only the two identities. */
export function hasTelegramBusSharedCapabilities(
  local: TelegramBusProtocolIdentity,
  remote: TelegramBusProtocolIdentity | undefined,
  required: readonly string[],
): boolean {
  return (
    required.every(
      (capability) =>
        hasTelegramBusCapability(local, capability) &&
        hasTelegramBusCapability(remote, capability),
    ) && getTelegramBusProtocolCompatibility({ local, remote }).compatible
  );
}

export function getTelegramBusProtocolCompatibility(input: {
  local: TelegramBusProtocolIdentity;
  remote?: TelegramBusProtocolIdentity;
}): TelegramBusProtocolCompatibility {
  if (!input.remote) {
    return {
      compatible: false,
      reason: "missing-identity",
      missingCapabilities: [],
    };
  }
  if (input.remote.protocolVersion !== input.local.protocolVersion) {
    return {
      compatible: false,
      reason: "version-mismatch",
      missingCapabilities: [],
    };
  }
  const remoteCapabilities = new Set(input.remote.capabilities);
  const missingCapabilities = input.local.capabilities
    .filter(
      (capability) =>
        capability === TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    )
    .filter((capability) => !remoteCapabilities.has(capability));
  return missingCapabilities.length > 0
    ? {
        compatible: false,
        reason: "missing-capability",
        missingCapabilities,
      }
    : { compatible: true, missingCapabilities: [] };
}

export function getTelegramBusSocketPath(
  agentDir = resolveAgentDir(),
  platform = getPlatform(),
  profileName?: string,
  layout?: TelegramBusEndpointLayout,
): string {
  return getTelegramBusLeaderEndpoint({
    agentDir,
    platform,
    profileName,
    layout,
  });
}

export function getTelegramBusFollowerSocketPath(
  instanceId: string,
  agentDir = resolveAgentDir(),
  platform = getPlatform(),
  profileName?: string,
  layout?: TelegramBusEndpointLayout,
): string {
  return getTelegramBusFollowerEndpoint({
    agentDir,
    platform,
    instanceId,
    profileName,
    layout,
  });
}

export interface TelegramBusInstanceRegistration {
  instanceId: string;
  previousInstanceId?: string;
  profileKey?: string;
  threadName?: string;
  slot?: string;
  cwd?: string;
  sessionId?: string;
  pid?: number;
  target?: TelegramTarget;
  busSocketPath?: string;
  registrationGeneration?: string;
  protocol?: TelegramBusProtocolIdentity;
  sessionGeneration?: number;
  processBirthId?: string;
  connectedAtMs: number;
}

export interface TelegramBusFollowerView extends TelegramBusInstanceRegistration {
  /** Leader-owned identity; never accepted from a registering peer. */
  registrationIncarnation?: string;
  lastHeartbeatMs: number;
}

/** Whether a live follower is still exactly the captured registration: identity, process, session, endpoint and negotiated protocol. */
export function isSameTelegramBusFollowerRegistration(
  live: TelegramBusInstanceRegistration,
  captured: TelegramBusInstanceRegistration,
): boolean {
  return (
    live.instanceId === captured.instanceId &&
    live.profileKey === captured.profileKey &&
    live.sessionId === captured.sessionId &&
    live.registrationGeneration === captured.registrationGeneration &&
    live.pid === captured.pid &&
    live.processBirthId === captured.processBirthId &&
    live.sessionGeneration === captured.sessionGeneration &&
    live.cwd === captured.cwd &&
    live.slot === captured.slot &&
    live.busSocketPath === captured.busSocketPath &&
    isDeepStrictEqual(live.protocol, captured.protocol)
  );
}

export function getTelegramFollowerTargetOwnership(input: {
  target: TelegramTarget;
  followers: readonly TelegramBusFollowerView[];
  activeThreadRecords?: readonly {
    status?: string;
    instanceId?: string;
    profileKey?: string;
    owner?: { kind?: string };
    target: TelegramTarget;
  }[];
  currentInstanceId?: string;
}):
  | {
      instanceId: string;
      ownerGeneration: string;
      recipientBindingKey: string;
      protocolIdentity: TelegramBusProtocolIdentity;
    }
  | undefined {
  const liveFollower = input.followers.find((follower) => {
    return (
      follower.target?.chatId === input.target.chatId &&
      follower.target.threadId === input.target.threadId
    );
  });
  if (
    liveFollower?.registrationGeneration &&
    liveFollower.profileKey &&
    liveFollower.protocol?.capabilities.includes(
      TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    )
  ) {
    return {
      instanceId: liveFollower.instanceId,
      ownerGeneration: liveFollower.registrationGeneration,
      recipientBindingKey: liveFollower.profileKey,
      protocolIdentity: liveFollower.protocol,
    };
  }
  // Persisted records are restart hints, not live routing authority. Only an
  // authenticated current follower registration may receive forwarded work.
  return undefined;
}

const TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD = "__piTelegramAggregateDelivery";
const TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD =
  "__piTelegramCrossTargetDelivery";

type TelegramBusDeliveryMarker =
  | typeof TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD
  | typeof TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD;

function hasTelegramBusDeliveryMarker(
  body: unknown,
  marker: TelegramBusDeliveryMarker,
): boolean {
  return Boolean(
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>)[marker] === true,
  );
}

export function markTelegramBusCrossTargetDelivery<
  T extends Record<string, unknown>,
>(body: T): T {
  return { ...body, [TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD]: true };
}

export function stripTelegramBusApiMetadata<T extends Record<string, unknown>>(
  body: T,
): T {
  if (
    !(TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD in body) &&
    !(TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD in body)
  ) {
    return body;
  }
  const clean = { ...body };
  delete clean[TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD];
  delete clean[TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD];
  return clean;
}

export function isTelegramFollowerApiCallAllowed(input: {
  follower: TelegramBusFollowerView;
  method: string;
  args: unknown[];
  isMessageOwned?: (chatId: number, messageId: number) => boolean;
}): boolean {
  const allowedCallMethods = new Set([
    "answerCallbackQuery",
    "answerGuestQuery",
    "closeForumTopic",
    "deleteForumTopic",
    "deleteMessage",
    "editForumTopic",
    "editMessageReplyMarkup",
    "editMessageText",
    "sendChatAction",
    "sendMessage",
    "sendMessageDraft",
    "sendRichMessage",
    "sendRichMessageDraft",
  ]);
  const allowedMultipartMethods = new Set([
    "sendAudio",
    "sendDocument",
    "sendMediaGroup",
    "sendPhoto",
    "sendRichMessage",
    "sendVoice",
  ]);
  const target = input.follower.target;
  const matchesId = (value: unknown, expected: number): boolean =>
    value === expected || value === String(expected);
  const isTargetScoped = (body: unknown): boolean => {
    if (!target) return false;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const record = body as Record<string, unknown>;
    if (!matchesId(record.chat_id, target.chatId)) return false;
    if (target.threadId === undefined) return true;
    return matchesId(record.message_thread_id, target.threadId);
  };
  const isTargetChatScoped = (body: unknown): boolean => {
    if (!target) return false;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const record = body as Record<string, unknown>;
    return matchesId(record.chat_id, target.chatId);
  };
  const isDifferentTargetScoped = (body: unknown): boolean => {
    if (!target || !isTargetChatScoped(body)) return false;
    const threadId = (body as Record<string, unknown>).message_thread_id;
    if (threadId === undefined) return target.threadId !== undefined;
    const parsedThreadId =
      typeof threadId === "number" ? threadId : Number(threadId);
    return (
      Number.isInteger(parsedThreadId) &&
      (target.threadId === undefined || !matchesId(threadId, target.threadId))
    );
  };
  const isTargetMessageScoped = (body: unknown): boolean => {
    if (!isTargetChatScoped(body)) return false;
    const messageId = (body as Record<string, unknown>).message_id;
    const parsedMessageId =
      typeof messageId === "number" ? messageId : Number(messageId);
    return (
      Number.isInteger(parsedMessageId) && matchesId(messageId, parsedMessageId)
    );
  };
  const isBotCommandRegistration = (body: unknown): boolean => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const commands = (body as Record<string, unknown>).commands;
    return (
      Array.isArray(commands) &&
      commands.every(
        (command) =>
          command &&
          typeof command === "object" &&
          !Array.isArray(command) &&
          typeof (command as Record<string, unknown>).command === "string" &&
          typeof (command as Record<string, unknown>).description === "string",
      )
    );
  };
  if (input.method === "downloadFile") return true;
  if (input.method === "call") {
    const apiMethod = input.args[0];
    if (typeof apiMethod !== "string") return false;
    if (
      apiMethod === "answerCallbackQuery" ||
      apiMethod === "answerGuestQuery"
    ) {
      return true;
    }
    if (apiMethod === "getMe") return true;
    if (apiMethod === "setMyCommands")
      return isBotCommandRegistration(input.args[1]);
    if (apiMethod === "sendChatAction")
      return isTargetScoped(input.args[1]);
    if (
      apiMethod === "sendMessage" &&
      hasTelegramBusDeliveryMarker(
        input.args[1],
        TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD,
      )
    ) {
      return false;
    }
    if (
      (apiMethod === "sendMessage" || apiMethod === "sendRichMessage") &&
      hasTelegramBusDeliveryMarker(
        input.args[1],
        TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD,
      )
    ) {
      return isDifferentTargetScoped(input.args[1]);
    }
    if (
      apiMethod === "deleteMessage" ||
      apiMethod === "editMessageReplyMarkup" ||
      apiMethod === "editMessageText"
    ) {
      if (!isTargetMessageScoped(input.args[1])) return false;
      const body = input.args[1] as Record<string, unknown>;
      const messageId =
        typeof body.message_id === "number"
          ? body.message_id
          : Number(body.message_id);
      return input.isMessageOwned?.(target!.chatId, messageId) === true;
    }
    return allowedCallMethods.has(apiMethod) && isTargetScoped(input.args[1]);
  }
  if (input.method === "callMultipart") {
    const apiMethod = input.args[0];
    return (
      typeof apiMethod === "string" &&
      allowedMultipartMethods.has(apiMethod) &&
      isTargetScoped(input.args[1])
    );
  }
  return false;
}

interface TelegramFollowerApiCallAuthorizationInput {
  follower: TelegramBusFollowerView;
  method: string;
  args: unknown[];
}

export function createTelegramFollowerApiCallAuthorizer(deps: {
  isMessageOwned(input: {
    chatId: number;
    messageId: number;
    follower: TelegramBusFollowerView;
  }): boolean;
}): (input: TelegramFollowerApiCallAuthorizationInput) => boolean {
  return (input) =>
    isTelegramFollowerApiCallAllowed({
      ...input,
      isMessageOwned(chatId, messageId) {
        return deps.isMessageOwned({
          chatId,
          messageId,
          follower: input.follower,
        });
      },
    });
}

export interface TelegramBusAgentTargetSelector {
  chatId?: number;
  threadId?: number;
  threadName?: string;
}

export interface TelegramBusAgentMessage {
  target: TelegramTarget & { threadId: number };
  messageId: number;
  text: string;
}

export interface TelegramBusFollowerDeliveryIdentity {
  deliveryId: string;
  sourceUpdateId: number;
  recipientBindingKey: string;
  sourceRecoveryKey?: string;
  sourceClaim?: {
    acquisitionId: string;
    handoffId: string;
  };
}

type TelegramBusForeignUpdateFailureClass =
  | "source-update-identity-missing"
  | "recipient-binding-missing"
  | "recipient-generation-missing"
  | "source-reference-missing"
  | "recipient-ownership-stale"
  | "transport-failed"
  | "acknowledgement-missing"
  | "acknowledgement-rejected"
  | "acknowledgement-mismatched"
  | "durable-receipt-missing"
  | "durable-receipt-mismatched";

export type TelegramBusForeignUpdateSettlement =
  | {
      status: "accepted";
      delivery: TelegramBusFollowerDeliveryIdentity;
    }
  | {
      status: "retryable" | "terminal-rejected";
      failureClass: TelegramBusForeignUpdateFailureClass;
      message: string;
      delivery?: TelegramBusFollowerDeliveryIdentity;
      sourceUpdateId?: number;
    };

export function createTelegramBusFollowerDeliveryIdentity(input: {
  kind:
    | "leader.forwardCallback"
    | "leader.forwardReaction"
    | "leader.forwardMessage"
    | "leader.forwardEditedMessage"
    | "leader.wakeInputCustody";
  recipientBindingKey: string;
  sourceUpdateId: number;
  sourceRecoveryKey?: string;
  sourceClaim?: {
    acquisitionId: string;
    handoffId: string;
  };
}): TelegramBusFollowerDeliveryIdentity {
  if (
    !input.recipientBindingKey ||
    !Number.isSafeInteger(input.sourceUpdateId) ||
    input.sourceUpdateId < 0 ||
    (input.sourceClaim !== undefined &&
      (!input.sourceClaim.acquisitionId ||
        input.sourceClaim.acquisitionId.length > 256 ||
        !input.sourceClaim.handoffId ||
        input.sourceClaim.handoffId.length > 256))
  ) {
    throw new Error("Telegram follower delivery identity is incomplete.");
  }
  const deliveryId = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        kind: input.kind,
        recipientBindingKey: input.recipientBindingKey,
        sourceUpdateId: input.sourceUpdateId,
      }),
    )
    .digest("hex");
  return {
    deliveryId: `telegram-follower-v1-${deliveryId}`,
    sourceUpdateId: input.sourceUpdateId,
    recipientBindingKey: input.recipientBindingKey,
    ...(input.sourceRecoveryKey
      ? { sourceRecoveryKey: input.sourceRecoveryKey }
      : {}),
    ...(input.sourceClaim ? { sourceClaim: { ...input.sourceClaim } } : {}),
  };
}

export function canUseTelegramBusInputCustodyReference(input: {
  local?: TelegramBusProtocolIdentity;
  remote?: TelegramBusProtocolIdentity;
}): boolean {
  return (
    hasTelegramBusCapability(
      input.local,
      TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE,
    ) &&
    hasTelegramBusCapability(
      input.remote,
      TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE,
    )
  );
}

export function createTelegramBusFollowerSourceReferenceDeliveryIdentity(input: {
  kind:
    | "leader.forwardCallback"
    | "leader.forwardReaction"
    | "leader.forwardMessage"
    | "leader.forwardEditedMessage"
    | "leader.wakeInputCustody";
  recipientBindingKey: string;
  sourceRecoveryKey: string;
  source: {
    updateId: number;
    owner: { acquisitionId: string; handoffId?: string };
  };
}): TelegramBusFollowerDeliveryIdentity {
  if (!input.sourceRecoveryKey || !input.source.owner.handoffId)
    throw new Error(
      "Telegram follower source-reference delivery requires an accepted handoff.",
    );
  return createTelegramBusFollowerDeliveryIdentity({
    kind: input.kind,
    recipientBindingKey: input.recipientBindingKey,
    sourceUpdateId: input.source.updateId,
    sourceRecoveryKey: input.sourceRecoveryKey,
    sourceClaim: {
      acquisitionId: input.source.owner.acquisitionId,
      handoffId: input.source.owner.handoffId,
    },
  });
}

export type TelegramBusEnvelope = (
  | {
      kind: "follower.register";
      requestId: string;
      recoverConnection?: true;
      registration: TelegramBusInstanceRegistration;
    }
  | {
      kind: "follower.restoreWorkspace";
      requestId: string;
      registration: TelegramBusInstanceRegistration;
    }
  | {
      kind: "follower.heartbeat";
      requestId: string;
      instanceId: string;
      registrationGeneration?: string;
      sentAtMs: number;
    }
  | {
      kind: "follower.disconnect";
      requestId: string;
      instanceId: string;
      registrationGeneration?: string;
      sentAtMs: number;
    }
  | {
      kind: "follower.setThreadDisplayMode";
      requestId: string;
      instanceId: string;
      registrationGeneration: string;
      mode: TelegramThreadDisplayMode;
    }
  | {
      kind: "follower.renameThread";
      requestId: string;
      instanceId: string;
      registrationGeneration: string;
      target: TelegramTarget & { threadId: number };
      threadName: string;
      sentAtMs: number;
    }
  | {
      kind: "follower.resetThreadName";
      requestId: string;
      instanceId: string;
      registrationGeneration: string;
      target: TelegramTarget & { threadId: number };
      sentAtMs: number;
    }
  | {
      kind:
        | "follower.publishSessionReplacement"
        | "follower.settleSessionReplacement";
      requestId: string;
      instanceId: string;
      registrationGeneration: string;
      intent: TelegramSessionReplacementIntent;
      sentAtMs: number;
    }
  | {
      kind: "leader.forwardCallback";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      delivery: TelegramBusFollowerDeliveryIdentity;
      query: unknown;
      sentAtMs: number;
    }
  | {
      kind: "leader.forwardReaction";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      delivery: TelegramBusFollowerDeliveryIdentity;
      reactionUpdate: unknown;
      sentAtMs: number;
    }
  | {
      kind: "leader.forwardMessage";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      delivery: TelegramBusFollowerDeliveryIdentity;
      message: unknown;
      forwardCommentBatchPosition?: "comment" | "forward";
      sentAtMs: number;
    }
  | {
      kind: "leader.forwardEditedMessage";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      delivery: TelegramBusFollowerDeliveryIdentity;
      message: unknown;
      sentAtMs: number;
    }
  | {
      kind: "leader.offerInputCustodyHandoff";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      recipientBindingKey: string;
      sourceRecoveryKey: string;
      source: {
        journalBindingKey: string;
        tokenSha256: string;
        updateId: number;
      };
      handoffId: string;
      sentAtMs: number;
    }
  | {
      kind: "leader.wakeInputCustody";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      delivery: TelegramBusFollowerDeliveryIdentity;
      sentAtMs: number;
    }
  | {
      kind: "leader.prepareLiveRebind";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      recipientSessionId: string;
      recipientBindingKey: string;
      operationId: string;
      updates: ({ update_id: number } & Record<string, unknown>)[];
      selectedCommand?: TelegramBusSelectedCommandInput;
      sentAtMs: number;
    }
  | {
      kind: "leader.applyLiveRebind";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      recipientSessionId: string;
      recipientBindingKey: string;
      operationId: string;
      sourceUpdateIds: number[];
      mode: "apply" | "inspect";
      preparedSource?: TelegramBusPreparedCommandSource;
      selectedCommand?: TelegramBusSelectedCommandInput;
      sentAtMs: number;
    }
  | {
      kind: "leader.settleLiveRebind";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      recipientSessionId: string;
      recipientBindingKey: string;
      operationId: string;
      sourceUpdateIds: number[];
      mode: "release" | "discard" | "observe" | "observe-held" | "observe-command";
      oldTarget?: TelegramTarget & { threadId: number };
      preparedSource?: TelegramBusPreparedCommandSource;
      selectedCommand?: TelegramBusSelectedCommandInput;
      sentAtMs: number;
    }
  | {
      kind: "leader.workspaceRestore";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      operationId: string;
      mode: "apply" | "inspect";
      sentAtMs: number;
    }
  | {
      kind: "leader.offerQueueHandoff";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      donorInstanceId: string;
      donorProcessId: number;
      donorProcessBirthId: string;
      donorSessionGeneration: number;
      donorAcquisitionId: string;
      donorAcquiredAtMs: number;
      handoffToken: string;
      payload: TelegramQueueHandoffPayload;
      sentAtMs: number;
    }
  | {
      kind: "follower.offerQueueHandoff";
      requestId: string;
      instanceId: string;
      registrationGeneration: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration: string;
      donorProcessId: number;
      donorProcessBirthId: string;
      donorSessionGeneration: number;
      donorAcquisitionId: string;
      donorAcquiredAtMs: number;
      handoffToken: string;
      payload: TelegramQueueHandoffPayload;
      sentAtMs: number;
    }
  | {
      kind: "follower.resolveAgentTarget";
      requestId: string;
      instanceId: string;
      registrationGeneration?: string;
      selector: TelegramBusAgentTargetSelector;
      sentAtMs: number;
    }
  | {
      kind: "follower.routeAgentMessage";
      requestId: string;
      instanceId: string;
      registrationGeneration?: string;
      message: TelegramBusAgentMessage;
      sentAtMs: number;
    }
  | TelegramBusSelectedMenuDelivery
  | {
      kind: "follower.callApi";
      requestId: string;
      instanceId: string;
      registrationGeneration?: string;
      /** Ordinary API binding identity from the original acknowledged registry row. */
      apiRegistrationIncarnation?: string;
      /** Private Attachment publication; fences the acknowledged recipient before HTTP. */
      attachmentRegistrationIncarnation?: string;
      method: string;
      args: unknown[];
      sentAtMs: number;
    }
  | {
      /** Side-effect-free leader liveness probe; any acknowledgement proves a responsive event loop. */
      kind: "bus.probe";
      requestId: string;
    }
  | {
      kind: "bus.ack";
      requestId: string;
      ok: boolean;
      message?: string;
      result?: unknown;
      protocol?: TelegramBusProtocolIdentity;
      error?: {
        code:
          | "commit-unknown"
          | "request-id-collision"
          | "ledger-overloaded"
          | "incompatible-protocol"
          | "stale-target"
          | "follower-api-not-allowed"
          | "workspace-binding-unavailable";
        method?: string;
        chatId?: number;
        threadId?: number;
      };
    }
) & { auth?: string };

/** Follower-staged queue handoff offer before the follower adds its own request and registration framing. */
export type TelegramBusFollowerQueueHandoffOffer = Omit<
  Extract<TelegramBusEnvelope, { kind: "follower.offerQueueHandoff" }>,
  | "kind"
  | "requestId"
  | "instanceId"
  | "registrationGeneration"
  | "sentAtMs"
  | "auth"
>;

/** Leader-routed queue handoff offer as donors and leaders exchange it before envelope framing. */
export type TelegramBusLeaderQueueHandoffOffer = Omit<
  Extract<TelegramBusEnvelope, { kind: "leader.offerQueueHandoff" }>,
  "kind"
>;

type TelegramBusEnvelopeTrafficClass =
  "bootstrap" | "generation-fenced" | "response";

export function getTelegramBusEnvelopeTrafficClass(
  envelope: TelegramBusEnvelope,
): TelegramBusEnvelopeTrafficClass {
  if (
    envelope.kind === "follower.register" ||
    envelope.kind === "follower.restoreWorkspace" ||
    envelope.kind === "bus.probe"
  )
    return "bootstrap";
  if (envelope.kind === "bus.ack") return "response";
  return "generation-fenced";
}

export function createTelegramBusRequestId(input: {
  instanceId: string;
  sequence: number;
}): string {
  return `${input.instanceId}:${input.sequence}`;
}

export function createTelegramBusRequestIdFactory(
  instanceId: string,
): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return createTelegramBusRequestId({ instanceId, sequence });
  };
}

export function encodeTelegramBusEnvelope(
  envelope: TelegramBusEnvelope,
): string {
  return `${JSON.stringify(envelope)}\n`;
}

export function parseTelegramBusEnvelope(
  line: string,
): TelegramBusEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  const requestId = value.requestId;
  if (typeof kind !== "string" || typeof requestId !== "string") {
    return undefined;
  }
  let envelope: TelegramBusEnvelope | undefined;
  switch (kind) {
    case "follower.register":
    case "follower.restoreWorkspace":
      envelope = parseRegisterEnvelope(value, requestId, kind);
      break;
    case "follower.heartbeat":
    case "follower.disconnect":
      envelope = parseFollowerPresenceEnvelope(value, requestId, kind);
      break;
    case "follower.setThreadDisplayMode":
      if (
        typeof value.instanceId === "string" &&
        typeof value.registrationGeneration === "string" &&
        (value.mode === "letters" ||
          value.mode === "names" ||
          value.mode === "directory-snake" ||
          value.mode === "directory-title")
      ) {
        envelope = {
          kind,
          requestId,
          instanceId: value.instanceId,
          registrationGeneration: value.registrationGeneration,
          mode: value.mode,
        };
      }
      break;
    case "follower.renameThread":
      envelope = parseRenameThreadEnvelope(value, requestId);
      break;
    case "follower.resetThreadName": {
      const target = parseTarget(value.target);
      if (
        typeof value.instanceId === "string" &&
        typeof value.registrationGeneration === "string" &&
        typeof value.sentAtMs === "number" &&
        target?.threadId !== undefined
      ) {
        envelope = {
          kind,
          requestId,
          instanceId: value.instanceId,
          registrationGeneration: value.registrationGeneration,
          target: { chatId: target.chatId, threadId: target.threadId },
          sentAtMs: value.sentAtMs,
        };
      }
      break;
    }
    case "follower.publishSessionReplacement":
    case "follower.settleSessionReplacement": {
      const intent = normalizeTelegramSessionReplacementIntent(value.intent);
      if (
        typeof value.instanceId === "string" &&
        typeof value.registrationGeneration === "string" &&
        typeof value.sentAtMs === "number" &&
        intent
      ) {
        envelope = {
          kind,
          requestId,
          instanceId: value.instanceId,
          registrationGeneration: value.registrationGeneration,
          intent,
          sentAtMs: value.sentAtMs,
        };
      }
      break;
    }
    case "leader.forwardCallback":
      envelope = parseForwardCallbackEnvelope(value, requestId);
      break;
    case "leader.forwardReaction":
      envelope = parseForwardReactionEnvelope(value, requestId);
      break;
    case "leader.offerInputCustodyHandoff":
      envelope = parseOfferInputCustodyHandoffEnvelope(value, requestId);
      break;
    case "leader.wakeInputCustody":
      envelope = parseWakeInputCustodyEnvelope(value, requestId);
      break;
    case "leader.forwardMessage":
      envelope = parseForwardMessageEnvelope(
        value,
        requestId,
        "leader.forwardMessage",
      );
      break;
    case "leader.forwardEditedMessage":
      envelope = parseForwardMessageEnvelope(
        value,
        requestId,
        "leader.forwardEditedMessage",
      );
      break;
    case "leader.prepareLiveRebind": {
      const selectedCommand = parseSelectedCommandInput(value.selectedCommand);
      if (
        !hasOnlyWireKeys(value, [
          "kind",
          "requestId",
          "auth",
          "recipientInstanceId",
          "recipientRegistrationGeneration",
          "recipientSessionId",
          "recipientBindingKey",
          "operationId",
          "updates",
          "selectedCommand",
          "sentAtMs",
        ]) ||
        (Object.hasOwn(value, "selectedCommand") &&
          (!selectedCommand ||
            !Array.isArray(value.updates) ||
            value.updates.length !== 1))
      )
        break;
      const recipient = parseLiveRebindRecipient(value);
      if (
        recipient &&
        Array.isArray(value.updates) &&
        value.updates.every(isRecord) &&
        isUniqueSourceUpdateIds(
          value.updates.map((update) => update.update_id),
        ) &&
        typeof value.sentAtMs === "number" &&
        Number.isFinite(value.sentAtMs)
      ) {
        envelope = {
          kind: "leader.prepareLiveRebind",
          requestId,
          ...recipient,
          updates: value.updates as ({ update_id: number } & Record<
            string,
            unknown
          >)[],
          sentAtMs: value.sentAtMs,
          ...(selectedCommand ? { selectedCommand } : {}),
        };
      }
      break;
    }
    case "leader.applyLiveRebind":
    case "leader.settleLiveRebind": {
      const selectedCommand = parseSelectedCommandInput(value.selectedCommand),
        preparedSource = parsePreparedCommandSource(value.preparedSource);
      if (
        !hasOnlyWireKeys(value, [
          "kind",
          "requestId",
          "auth",
          "recipientInstanceId",
          "recipientRegistrationGeneration",
          "recipientSessionId",
          "recipientBindingKey",
          "operationId",
          "sourceUpdateIds",
          "mode",
          "oldTarget",
          "selectedCommand",
          "preparedSource",
          "sentAtMs",
        ]) ||
        (Object.hasOwn(value, "preparedSource") && !selectedCommand) ||
        (value.mode === "observe-command" &&
          (!selectedCommand || Object.hasOwn(value, "oldTarget"))) ||
        (value.mode === "observe-held" && (parseThreadTarget(value.oldTarget)?.threadId ?? 0) <= 0)
      )
        break;
      if (
        Object.hasOwn(value, "selectedCommand") &&
        (!selectedCommand ||
          !Array.isArray(value.sourceUpdateIds) ||
          value.sourceUpdateIds.length !== 1 ||
          !preparedSource ||
          preparedSource.updateId !== value.sourceUpdateIds[0] ||
          preparedSource.journalBindingKey !== value.recipientBindingKey)
      )
        break;
      const recipient = parseLiveRebindRecipient(value);
      if (
        recipient &&
        (value.kind === "leader.applyLiveRebind"
          ? value.mode === "apply" || value.mode === "inspect"
          : value.mode === "release" ||
            value.mode === "discard" ||
            value.mode === "observe-command" ||
            ((value.mode === "observe" || value.mode === "observe-held") &&
              !!parseThreadTarget(value.oldTarget))) &&
        isUniqueSourceUpdateIds(value.sourceUpdateIds) &&
        typeof value.sentAtMs === "number" &&
        Number.isFinite(value.sentAtMs)
      ) {
        envelope = {
          kind: value.kind,
          requestId,
          ...recipient,
          sourceUpdateIds: value.sourceUpdateIds,
          mode: value.mode as
            | "apply"
            | "inspect"
            | "release"
            | "discard"
            | "observe"
            | "observe-held"
            | "observe-command",
          sentAtMs: value.sentAtMs,
          ...((value.mode === "observe" || value.mode === "observe-held")
            ? { oldTarget: parseThreadTarget(value.oldTarget)! }
            : {}),
          ...(selectedCommand ? { selectedCommand, preparedSource } : {}),
        } as TelegramBusEnvelope;
      }
      break;
    }
    case "leader.workspaceRestore":
      if (
        typeof value.recipientInstanceId === "string" &&
        value.recipientInstanceId &&
        typeof value.recipientRegistrationGeneration === "string" &&
        value.recipientRegistrationGeneration &&
        typeof value.operationId === "string" &&
        value.operationId.length > 0 &&
        value.operationId.length <= 128 &&
        (value.mode === "apply" || value.mode === "inspect") &&
        typeof value.sentAtMs === "number" &&
        Number.isFinite(value.sentAtMs)
      ) {
        envelope = {
          kind: "leader.workspaceRestore",
          requestId,
          recipientInstanceId: value.recipientInstanceId,
          recipientRegistrationGeneration:
            value.recipientRegistrationGeneration,
          operationId: value.operationId,
          mode: value.mode,
          sentAtMs: value.sentAtMs,
        };
      }
      break;
    case "leader.offerQueueHandoff":
      envelope = parseQueueHandoffEnvelope(
        value,
        requestId,
        "leader.offerQueueHandoff",
      );
      break;
    case "follower.offerQueueHandoff":
      envelope = parseQueueHandoffEnvelope(
        value,
        requestId,
        "follower.offerQueueHandoff",
      );
      break;
    case "follower.resolveAgentTarget":
      envelope = parseResolveAgentTargetEnvelope(value, requestId);
      break;
    case "follower.routeAgentMessage":
      envelope = parseRouteAgentMessageEnvelope(value, requestId);
      break;
    case "follower.deliverSelectedMenu":
      envelope = parseSelectedMenuDeliveryEnvelope(value, requestId);
      break;
    case "follower.callApi":
      envelope = parseCallApiEnvelope(value, requestId);
      break;
    case "bus.probe":
      envelope = { kind, requestId };
      break;
    case "bus.ack":
      envelope = parseAckEnvelope(value, requestId);
      break;
    default:
      return undefined;
  }
  const auth = value.auth;
  if (envelope && typeof auth === "string") envelope.auth = auth;
  return envelope;
}

/**
 * One leader liveness observation. `silent` (connected or connecting, no answer within the window) and
 * `unreachable` (an endpoint that refuses connections: nobody listens) can support a takeover. A missing endpoint is
 * `unknown`: a live classic-mode leader has no socket at all. Any bytes or an orderly close prove the peer's event
 * loop handled the connection, so even an older leader rejecting the unknown kind is `responsive`.
 */
export type TelegramBusLeaderProbeResult =
  | "responsive"
  | "silent"
  | "unreachable"
  | "unknown";

export function probeTelegramBusLeader(input: {
  socketPath: TelegramBusSocketPathSource;
  secret?: string;
  timeoutMs?: number;
}): Promise<TelegramBusLeaderProbeResult> {
  const timeoutMs = input.timeoutMs ?? TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    const finish = (result: TelegramBusLeaderProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("silent"), timeoutMs);
    let connected = false;
    try {
      socket = createConnection(resolveTelegramBusSocketPath(input.socketPath));
    } catch {
      finish("unknown");
      return;
    }
    socket.once("connect", () => {
      connected = true;
      socket!.write(
        encodeTelegramBusEnvelope({
          kind: "bus.probe",
          requestId: `probe:${randomBytes(8).toString("hex")}`,
          ...(input.secret ? { auth: input.secret } : {}),
        }),
      );
    });
    socket.once("data", () => finish("responsive"));
    socket.once("end", () => finish("responsive"));
    socket.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(
        !connected && code === "ECONNREFUSED" ? "unreachable" : "unknown",
      );
    });
  });
}

/**
 * Takeover evidence replacing the retired file heartbeat: a full silent window, or an unreachable endpoint
 * confirmed again after one more window (a just-started leader binds its socket well within it). The owner must
 * stay the same throughout; the lock acquisition then CAS-checks that exact owner.
 */
export async function proveTelegramBusLeaderUnresponsive(input: {
  probe: () => Promise<TelegramBusLeaderProbeResult>;
  isSameOwner: () => boolean;
  sleep: (ms: number) => Promise<void>;
  windowMs?: number;
}): Promise<boolean> {
  const first = await input.probe();
  if (first === "silent") return input.isSameOwner();
  if (first !== "unreachable") return false;
  await input.sleep(input.windowMs ?? TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS);
  if (!input.isSameOwner()) return false;
  const second = await input.probe();
  return (second === "silent" || second === "unreachable") && input.isSameOwner();
}

/** Composition-ready takeover proof for one profile's leader lock and endpoint. */
export function createTelegramBusLeaderUnresponsivenessProof(deps: {
  getLeaderState: () => TelegramLockState;
  getLeaderSocketPath: () => string;
  probe?: typeof probeTelegramBusLeader;
  sleep?: (ms: number) => Promise<void>;
}): (owner: TelegramLockEntry) => Promise<boolean> {
  const probe = deps.probe ?? probeTelegramBusLeader;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return (owner) =>
    proveTelegramBusLeaderUnresponsive({
      probe: () =>
        probe({
          socketPath: owner.busSocketPath ?? deps.getLeaderSocketPath(),
          secret: owner.busSecret,
        }),
      isSameOwner: () => {
        const state = deps.getLeaderState();
        return (
          state.kind === "active-elsewhere" &&
          isSameTelegramLockOwner(state.lock, owner)
        );
      },
      sleep,
    });
}

interface TelegramBusLocalServer {
  start: (assertAuthority?: () => void) => Promise<void>;
  stop: () => Promise<void>;
  ensureEndpoint: () => Promise<boolean>;
}

const TELEGRAM_ACTIVE_LOCAL_SERVERS = Symbol.for(
  "@llblab/pi-telegram/active-local-servers",
);
type TelegramBusServerGlobal = typeof globalThis & {
  [TELEGRAM_ACTIVE_LOCAL_SERVERS]?: Map<string, TelegramBusLocalServer>;
};

function getActiveTelegramBusLocalServers(): Map<
  string,
  TelegramBusLocalServer
> {
  const root = globalThis as TelegramBusServerGlobal;
  return (root[TELEGRAM_ACTIVE_LOCAL_SERVERS] ??= new Map());
}

export type TelegramBusSocketPathSource = string | (() => string);

export function resolveTelegramBusSocketPath(
  source: TelegramBusSocketPathSource,
  platform: NodeJS.Platform | string = getPlatform(),
): string {
  const endpoint = typeof source === "function" ? source() : source;
  if (platform === "win32") {
    if (isTelegramBusPipePath(endpoint)) return endpoint;
    return getTelegramBusPipePath({
      agentDir: dirname(endpoint),
      scope: basename(endpoint),
    });
  }
  const ownerScope = process.getuid?.() ?? "user";
  const fallbackDir = join(tmpdir(), `pi-telegram-${ownerScope}`);
  if (
    dirname(endpoint) === fallbackDir &&
    /^[0-9a-f]{16}\.sock$/u.test(basename(endpoint))
  ) {
    return endpoint;
  }
  if (
    Buffer.byteLength(endpoint) <= TELEGRAM_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES
  ) {
    return endpoint;
  }
  const digest = createHash("sha256")
    .update(endpoint)
    .digest("hex")
    .slice(0, 16);
  return join(fallbackDir, `${digest}.sock`);
}

interface TelegramBusLocalServerDeps {
  socketPath: TelegramBusSocketPathSource;
  handleEnvelope: (
    envelope: TelegramBusEnvelope,
  ) =>
    Promise<TelegramBusEnvelope | undefined> | TelegramBusEnvelope | undefined;
  recordTransportEvent?: TelegramBusTransportEventRecorder;
  beforeEndpointPublication?: () => Promise<void> | void;
  commitEndpointPublication?: (commit: () => void) => boolean;
  requestLedgerMaxEntries?: number;
  /** Artifact-only gate, called before every lookup and again before releasing an ACK. */
  captureArtifactAuthority?: (envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>) => (() => boolean) | undefined;
  shouldDropResponse?: (
    request: TelegramBusEnvelope,
    response: TelegramBusEnvelope,
  ) => boolean;
}

/** Local IPC issuance proof only: this callback/error never enters the envelope or certifies a remote API effect. */
export class TelegramBusLocalAuthorityError extends Error {
  readonly requestIssued: boolean;
  constructor(requestIssued: boolean, reason?: string) {
    super(
      reason
        ? `Telegram bus local authority is unavailable: ${reason}`
        : "Telegram bus local authority is unavailable.",
    );
    this.name = "TelegramBusLocalAuthorityError";
    this.requestIssued = requestIssued;
  }
}

/** Origin-local proof only; never serialized as a remote execution grant. */
export class TelegramBusArtifactIpcError extends Error {
  readonly requestIssued: boolean;
  constructor(requestIssued: boolean, cause: unknown) {
    super("Artifact IPC operation did not complete.", { cause });
    this.name = "TelegramBusArtifactIpcError";
    this.requestIssued = requestIssued;
  }
}

interface TelegramBusLocalClientOptions {
  /** Original registration-only budget. Never consulted after issuance or serialized. */
  connectionReadiness?: TelegramFollowerReadiness;
  assertAuthority?: () => void;
  onRequestIssued?: () => void;
  socketPath: string;
  envelope: TelegramBusEnvelope;
  timeoutMs?: number;
  retry?: TelegramBusTransportRetryPolicy;
  recordTransportEvent?: TelegramBusTransportEventRecorder;
}

interface TelegramBusForeignOwnedForwarderDeps<TMessage = unknown> {
  socketPath: TelegramBusSocketPathSource;
  createRequestId: () => string;
  getNowMs?: () => number;
  timeoutMs?: number;
  getAuthSecret?: () => string | undefined;
  getForwardCommentBatchPosition?: (
    message: TMessage,
  ) => "comment" | "forward" | undefined;
  localProtocolIdentity?: TelegramBusProtocolIdentity;
  validateForwardOwnership?: (
    ownership: TelegramBusForwardOwnership,
  ) => boolean;
  resolveInputCustodyReference?: (input: {
    sourceUpdateId: number;
    recipientBindingKey: string;
  }) =>
    | {
        sourceRecoveryKey: string;
        source: {
          updateId: number;
          owner: { acquisitionId: string; handoffId?: string };
        };
      }
    | undefined;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusForwardOwnership {
  instanceId: string;
  ownerGeneration?: string;
  recipientBindingKey?: string;
  protocolIdentity?: TelegramBusProtocolIdentity;
}

export function isTelegramBusForwardOwnershipCurrent(
  expected: TelegramBusForwardOwnership,
  current: TelegramBusForwardOwnership | undefined,
): boolean {
  return Boolean(
    current &&
    current.instanceId === expected.instanceId &&
    current.ownerGeneration === expected.ownerGeneration &&
    current.recipientBindingKey === expected.recipientBindingKey &&
    JSON.stringify(current.protocolIdentity) ===
      JSON.stringify(expected.protocolIdentity),
  );
}

type TelegramBusDurableForwardEnvelope = Extract<
  TelegramBusEnvelope,
  {
    kind:
      | "leader.forwardCallback"
      | "leader.forwardReaction"
      | "leader.forwardMessage"
      | "leader.forwardEditedMessage"
      | "leader.wakeInputCustody";
  }
> & {
  recipientRegistrationGeneration: string;
  delivery: TelegramBusFollowerDeliveryIdentity;
};

function getTelegramBusForwardSourceUpdateId(
  value: unknown,
): number | undefined {
  if (!isRecord(value)) return undefined;
  const updateId = value.pi_telegram_source_update_id;
  return Number.isSafeInteger(updateId) && (updateId as number) >= 0
    ? (updateId as number)
    : undefined;
}

function createTelegramBusForwardDelivery(
  kind:
    | "leader.forwardCallback"
    | "leader.forwardReaction"
    | "leader.forwardMessage"
    | "leader.forwardEditedMessage",
  sourceUpdateId: number,
  recipientBindingKey: string,
): TelegramBusFollowerDeliveryIdentity {
  return createTelegramBusFollowerDeliveryIdentity({
    kind,
    recipientBindingKey,
    sourceUpdateId,
  });
}

/**
 * Leader-to-follower forwards and control replies share the stale-liveness window: a follower doing journal work or stalled
 * by an ordinary multi-second Pi/TUI turn, or a slower Windows named pipe, is not a lost recipient.
 */
const TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS =
  TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS;

export function createTelegramBusForeignOwnedUpdateForwarder<
  TContext,
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
>(
  deps: TelegramBusForeignOwnedForwarderDeps<TMessage>,
): {
  forwardCallback: (input: {
    query: TCallbackQuery;
    ownership: TelegramBusForwardOwnership;
    ctx: TContext;
  }) => Promise<TelegramBusForeignUpdateSettlement>;
  forwardReaction: (input: {
    reactionUpdate: TReactionUpdate;
    ownership: TelegramBusForwardOwnership;
    ctx: TContext;
  }) => Promise<TelegramBusForeignUpdateSettlement>;
  forwardMessage: (input: {
    message: TMessage;
    ownership: TelegramBusForwardOwnership;
    ctx: TContext;
    /** Process-local source/recipient lifetime; never part of the wire envelope. */
    assertAuthority?: () => void;
  }) => Promise<TelegramBusForeignUpdateSettlement>;
  forwardEditedMessage: (input: {
    message: TMessage;
    ownership: TelegramBusForwardOwnership;
    ctx: TContext;
  }) => Promise<TelegramBusForeignUpdateSettlement>;
} {
  const getNowMs = deps.getNowMs ?? Date.now;
  const reject = (input: {
    status: "retryable" | "terminal-rejected";
    failureClass: TelegramBusForeignUpdateFailureClass;
    message: string;
    envelopeKind: TelegramBusDurableForwardEnvelope["kind"];
    ownership: TelegramBusForwardOwnership;
    delivery?: TelegramBusFollowerDeliveryIdentity;
    sourceUpdateId?: number;
  }): TelegramBusForeignUpdateSettlement => {
    const settlement: TelegramBusForeignUpdateSettlement = {
      status: input.status,
      failureClass: input.failureClass,
      message: input.message,
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.sourceUpdateId !== undefined
        ? { sourceUpdateId: input.sourceUpdateId }
        : {}),
    };
    deps.recordRuntimeEvent?.("bus", input.message, {
      phase: "foreign-update-forward-rejected",
      settlement: input.status,
      failureClass: input.failureClass,
      envelopeKind: input.envelopeKind,
      recipientInstanceId: input.ownership.instanceId,
      deliveryId: input.delivery?.deliveryId,
      sourceUpdateId: input.delivery?.sourceUpdateId ?? input.sourceUpdateId,
    });
    return settlement;
  };
  const prepare = (
    kind:
      | "leader.forwardCallback"
      | "leader.forwardReaction"
      | "leader.forwardMessage"
      | "leader.forwardEditedMessage",
    value: unknown,
    ownership: TelegramBusForwardOwnership,
  ):
    | {
        delivery: TelegramBusFollowerDeliveryIdentity;
        recipientRegistrationGeneration: string;
        sourceReference: boolean;
      }
    | { settlement: TelegramBusForeignUpdateSettlement } => {
    const sourceUpdateId = getTelegramBusForwardSourceUpdateId(value);
    if (sourceUpdateId === undefined) {
      return {
        settlement: reject({
          status: "terminal-rejected",
          failureClass: "source-update-identity-missing",
          message: "Forwarded Telegram update has no durable source identity.",
          envelopeKind: kind,
          ownership,
        }),
      };
    }
    if (!ownership.recipientBindingKey) {
      return {
        settlement: reject({
          status: "terminal-rejected",
          failureClass: "recipient-binding-missing",
          message: "Forwarded Telegram update has no stable recipient binding.",
          envelopeKind: kind,
          ownership,
          sourceUpdateId,
        }),
      };
    }
    const sourceReference = canUseTelegramBusInputCustodyReference({
      local: deps.localProtocolIdentity,
      remote: ownership.protocolIdentity,
    });
    const reference = sourceReference
      ? deps.resolveInputCustodyReference?.({
          sourceUpdateId,
          recipientBindingKey: ownership.recipientBindingKey,
        })
      : undefined;
    if (sourceReference && !reference)
      return {
        settlement: reject({
          status: "retryable",
          failureClass: "source-reference-missing",
          message: "Forwarded Telegram update has no exact custody reference.",
          envelopeKind: kind,
          ownership,
          sourceUpdateId,
        }),
      };
    const delivery = reference
      ? createTelegramBusFollowerSourceReferenceDeliveryIdentity({
          kind: "leader.wakeInputCustody",
          recipientBindingKey: ownership.recipientBindingKey,
          sourceRecoveryKey: reference.sourceRecoveryKey,
          source: reference.source,
        })
      : createTelegramBusForwardDelivery(
          kind,
          sourceUpdateId,
          ownership.recipientBindingKey,
        );
    if (!ownership.ownerGeneration) {
      return {
        settlement: reject({
          status: "retryable",
          failureClass: "recipient-generation-missing",
          message:
            "Forwarded Telegram update has no live recipient generation.",
          envelopeKind: kind,
          ownership,
          delivery,
        }),
      };
    }
    return {
      delivery,
      recipientRegistrationGeneration: ownership.ownerGeneration,
      sourceReference,
    };
  };
  const send = async (
    envelope: TelegramBusDurableForwardEnvelope,
    ownership: TelegramBusForwardOwnership,
    assertAuthority?: () => void,
  ): Promise<TelegramBusForeignUpdateSettlement> => {
    if (
      deps.validateForwardOwnership &&
      !deps.validateForwardOwnership(ownership)
    )
      return reject({
        status: "retryable",
        failureClass: "recipient-ownership-stale",
        message: "Telegram follower ownership changed before forwarding.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    if (deps.getAuthSecret) envelope.auth = deps.getAuthSecret();
    const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
    let response: TelegramBusEnvelope | undefined;
    try {
      response = await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope,
        timeoutMs: deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS,
        retry: assertAuthority ? { attempts: 1, delayMs: 0 } : getTelegramBusTransportRetryPolicy({
          endpoint: socketPath,
          operation: "operation",
        }),
        ...(assertAuthority || deps.validateForwardOwnership ? { assertAuthority() {
          assertAuthority?.();
          if (deps.validateForwardOwnership && !deps.validateForwardOwnership(ownership))
            throw new Error("Telegram follower forwarding ownership changed.");
        } } : {}),
      });
    } catch (error) {
      return reject({
        status: "retryable",
        failureClass: "transport-failed",
        message:
          error instanceof Error
            ? error.message
            : "Telegram follower forwarding transport failed.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    }
    if (response?.kind !== "bus.ack") {
      return reject({
        status: "retryable",
        failureClass: "acknowledgement-missing",
        message: "Follower returned no forwarding acknowledgement.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    }
    if (response.requestId !== envelope.requestId) {
      return reject({
        status: "terminal-rejected",
        failureClass: "acknowledgement-mismatched",
        message: "Follower returned a mismatched forwarding acknowledgement.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    }
    if (!response.ok) {
      return reject({
        status: "retryable",
        failureClass: "acknowledgement-rejected",
        message:
          response.message ?? "Follower rejected forwarded Telegram update.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    }
    const receipt = response.result;
    if (
      !isRecord(receipt) ||
      typeof receipt.deliveryId !== "string" ||
      !Number.isSafeInteger(receipt.sourceUpdateId)
    ) {
      return reject({
        status: "terminal-rejected",
        failureClass: "durable-receipt-missing",
        message: "Follower acknowledgement omitted the durable receipt.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    }
    if (
      receipt.deliveryId !== envelope.delivery.deliveryId ||
      receipt.sourceUpdateId !== envelope.delivery.sourceUpdateId
    ) {
      return reject({
        status: "terminal-rejected",
        failureClass: "durable-receipt-mismatched",
        message:
          "Follower acknowledgement returned a mismatched durable receipt.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    }
    return { status: "accepted", delivery: envelope.delivery };
  };
  type ForwardKind = Parameters<typeof prepare>[0];
  type ForwardBase = Pick<
    Extract<
      TelegramBusDurableForwardEnvelope,
      { kind: "leader.wakeInputCustody" }
    >,
    | "requestId"
    | "recipientInstanceId"
    | "recipientRegistrationGeneration"
    | "delivery"
  >;
  // A recipient already holding the source reference is only woken; it never receives a second payload copy.
  const forward = (
    kind: ForwardKind,
    value: unknown,
    ownership: TelegramBusForwardOwnership,
    build: (
      base: ForwardBase,
      sentAtMs: number,
    ) => TelegramBusDurableForwardEnvelope,
    assertAuthority?: () => void,
  ): Promise<TelegramBusForeignUpdateSettlement> => {
    const prepared = prepare(kind, value, ownership);
    if ("settlement" in prepared) return Promise.resolve(prepared.settlement);
    const base = {
      requestId: deps.createRequestId(),
      recipientInstanceId: ownership.instanceId,
      recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
      delivery: prepared.delivery,
    };
    return send(
      prepared.sourceReference
        ? { kind: "leader.wakeInputCustody", ...base, sentAtMs: getNowMs() }
        : build(base, getNowMs()),
      ownership,
      assertAuthority,
    );
  };
  return {
    forwardCallback: ({ query, ownership }) =>
      forward("leader.forwardCallback", query, ownership, (base, sentAtMs) => ({
        kind: "leader.forwardCallback",
        ...base,
        query,
        sentAtMs,
      })),
    forwardReaction: ({ reactionUpdate, ownership }) =>
      forward(
        "leader.forwardReaction",
        reactionUpdate,
        ownership,
        (base, sentAtMs) => ({
          kind: "leader.forwardReaction",
          ...base,
          reactionUpdate,
          sentAtMs,
        }),
      ),
    forwardMessage: ({ message, ownership, assertAuthority }) =>
      forward("leader.forwardMessage", message, ownership, (base, sentAtMs) => {
        const forwardCommentBatchPosition =
          deps.getForwardCommentBatchPosition?.(message);
        return {
          kind: "leader.forwardMessage",
          ...base,
          message,
          ...(forwardCommentBatchPosition !== undefined
            ? { forwardCommentBatchPosition }
            : {}),
          sentAtMs,
        };
      }, assertAuthority),
    forwardEditedMessage: ({ message, ownership }) =>
      forward(
        "leader.forwardEditedMessage",
        message,
        ownership,
        (base, sentAtMs) => ({
          kind: "leader.forwardEditedMessage",
          ...base,
          message,
          sentAtMs,
        }),
      ),
  };
}

export function listTelegramBusLiveThreadTargets(input: {
  leaderTarget?: TelegramTarget;
  followers: readonly TelegramBusFollowerView[];
}): TelegramTarget[] {
  const targets: TelegramTarget[] = [];
  if (input.leaderTarget?.threadId !== undefined) {
    targets.push(input.leaderTarget);
  }
  for (const follower of input.followers) {
    if (follower.target?.threadId !== undefined) targets.push(follower.target);
  }
  return targets;
}

/** Caller owns the durable one-shot apply grant. Inspections never grant another apply. */
export function createTelegramBusWorkspaceRestoreController(deps: {
  getFollower: (instanceId: string) => TelegramBusFollowerView | undefined;
  localProtocolIdentity: TelegramBusProtocolIdentity;
  createRequestId: () => string;
  getAuthSecret: () => string | undefined;
  timeoutMs?: number;
}) {
  return async (input: {
    operationId: string;
    instanceId: string;
    sessionId: string;
    slot: string;
    target: TelegramTarget & { threadId: number };
    oldTarget: TelegramTarget & { threadId: number };
    mode: "apply" | "inspect";
    isCurrent: () => boolean;
  }): Promise<TelegramBusWorkspaceRestoreObservation | undefined> => {
    const isCurrent = input.isCurrent.bind(input);
    if (!isCurrent()) return undefined;
    const follower = deps.getFollower(input.instanceId);
    const secret = deps.getAuthSecret();
    if (
      !secret ||
      !follower?.registrationGeneration ||
      !follower.busSocketPath ||
      follower.sessionId !== input.sessionId ||
      follower.slot !== input.slot ||
      !hasTelegramBusSharedCapabilities(
        deps.localProtocolIdentity,
        follower.protocol,
        [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE],
      )
    )
      return undefined;
    const captured = structuredClone(follower);
    const expected = {
      operationId: input.operationId,
      sessionId: input.sessionId,
      slot: input.slot,
      target: { ...input.target },
      oldTarget: { ...input.oldTarget },
      mode: input.mode,
    };
    const current = (): boolean => {
      if (
        !isCurrent() ||
        deps.getAuthSecret() !== secret ||
        !hasTelegramBusCapability(
          deps.localProtocolIdentity,
          TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
        )
      )
        return false;
      const live = deps.getFollower(captured.instanceId);
      return (
        !!live &&
        live.registrationGeneration === captured.registrationGeneration &&
        live.sessionId === captured.sessionId &&
        live.cwd === captured.cwd &&
        live.slot === captured.slot &&
        live.busSocketPath === captured.busSocketPath &&
        live.target?.chatId === captured.target?.chatId &&
        live.target?.threadId === captured.target?.threadId &&
        hasTelegramBusCapability(
          live.protocol,
          TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
        ) &&
        getTelegramBusProtocolCompatibility({
          local: deps.localProtocolIdentity,
          remote: live.protocol,
        }).compatible
      );
    };
    if (!current()) return undefined;
    const requestId = deps.createRequestId();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath: captured.busSocketPath!,
      timeoutMs: deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS,
      retry: { attempts: 1, delayMs: 0 },
      envelope: {
        kind: "leader.workspaceRestore",
        requestId,
        recipientInstanceId: captured.instanceId,
        recipientRegistrationGeneration: captured.registrationGeneration!,
        operationId: expected.operationId,
        mode: expected.mode,
        auth: secret,
        sentAtMs: Date.now(),
      },
    });
    if (
      !current() ||
      response?.kind !== "bus.ack" ||
      response.requestId !== requestId ||
      response.ok !== true ||
      !response.result ||
      typeof response.result !== "object"
    )
      return undefined;
    const result = response.result as Record<string, unknown>;
    const recipient = result.recipient as Record<string, unknown> | undefined;
    const target = parseThreadTarget(result.target);
    const wanted = result.ready === true ? expected.target : expected.oldTarget;
    if (
      result.operationId !== expected.operationId ||
      typeof result.ready !== "boolean" ||
      result.slot !== expected.slot ||
      !target ||
      target.chatId !== wanted.chatId ||
      target.threadId !== wanted.threadId ||
      recipient?.kind !== "follower" ||
      recipient.instanceId !== captured.instanceId ||
      recipient.sessionId !== expected.sessionId ||
      recipient.generation !== captured.registrationGeneration
    )
      return undefined;
    return {
      operationId: expected.operationId,
      recipient: {
        kind: "follower",
        instanceId: captured.instanceId,
        sessionId: expected.sessionId,
        generation: captured.registrationGeneration!,
      },
      target,
      slot: expected.slot,
      ready: result.ready,
    };
  };
}

/** Each capability has its own effect boundary; transport retries never replay save/dispatch/disposal. */
export function createTelegramBusLiveRebindController(deps: {
  getFollower(instanceId: string): TelegramBusFollowerView | undefined;
  localProtocolIdentity: TelegramBusProtocolIdentity;
  createRequestId(): string;
  getAuthSecret(): string | undefined;
  timeoutMs?: number;
}) {
  return async (
    input: {
      operationId: string;
      instanceId: string;
      sessionId: string;
      recipientBindingKey: string;
      isCurrent(): boolean;
      selectedCommand?: TelegramBusSelectedCommandInput;
      preparedSource?: TelegramBusPreparedCommandSource;
    } & (
      | { updates: ({ update_id: number } & Record<string, unknown>)[] }
      | {
          mode:
            | "apply"
            | "inspect"
            | "release"
            | "discard"
            | "observe"
            | "observe-held"
            | "observe-command";
          sourceUpdateIds: number[];
          slot: string;
          target: TelegramTarget & { threadId: number };
          oldTarget: TelegramTarget & { threadId: number };
        }
    ),
  ): Promise<
    | TelegramBusLiveRebindSaveObservation
    | TelegramBusLiveRebindApplyObservation
    | TelegramBusLiveRebindSettlementObservation
    | TelegramBusLiveRebindWorkObservation
    | TelegramBusLiveRebindCommandObservation
    | undefined
  > => {
    const isCurrent = input.isCurrent.bind(input),
      localProtocol = structuredClone(deps.localProtocolIdentity);
    const selectedCommand = parseSelectedCommandInput(input.selectedCommand),
      held = selectedCommand,
      preparedSource = parsePreparedCommandSource(input.preparedSource);
    if (
      !hasOnlyWireKeys(input, [
        "operationId",
        "instanceId",
        "sessionId",
        "recipientBindingKey",
        "isCurrent",
        "selectedCommand",
        "preparedSource",
        "updates",
        "mode",
        "sourceUpdateIds",
        "slot",
        "target",
        "oldTarget",
      ]) ||
      ("mode" in input &&
        (![
          "apply",
          "inspect",
          "release",
          "discard",
          "observe",
          "observe-held",
          "observe-command",
        ].includes(input.mode) ||
          (input.mode === "observe-command" && !selectedCommand)))
    )
      return undefined;
    if (
      (input.preparedSource !== undefined &&
        (!held ||
          !preparedSource ||
          preparedSource.journalBindingKey !== input.recipientBindingKey ||
          preparedSource.updateId !==
            ("mode" in input
              ? input.sourceUpdateIds[0]
              : input.updates[0]?.update_id))) ||
      (held && "mode" in input && !preparedSource)
    )
      return undefined;
    if (
      input.selectedCommand !== undefined &&
      (!held ||
        ("mode" in input
          ? input.sourceUpdateIds.length !== 1 ||
            !areTelegramTargetsEqual(input.target, held.target)
          : input.updates.length !== 1))
    )
      return undefined;
    const marker = selectedCommand ? { selectedCommand } : {};
    const expected = structuredClone({
      operationId: input.operationId,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
      recipientBindingKey: input.recipientBindingKey,
      ...(held
        ? { ...marker, ...(preparedSource ? { preparedSource } : {}) }
        : {}),
      ...("mode" in input
        ? {
            mode: input.mode,
            sourceUpdateIds: input.sourceUpdateIds,
            slot: input.slot,
            target: input.target,
            oldTarget: input.oldTarget,
          }
        : { updates: input.updates }),
    });
    const observing = "mode" in expected && (expected.mode === "observe" || expected.mode === "observe-held");
    const observingHeld = "mode" in expected && expected.mode === "observe-held";
    const commandObserving =
      "mode" in expected && expected.mode === "observe-command";
    const settling =
      "mode" in expected &&
      (expected.mode === "release" ||
        expected.mode === "discard" ||
        observing ||
        commandObserving);
    const required = [
      TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
      ...("mode" in expected || held
        ? [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY]
        : []),
      ...(settling || held ? [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE] : []),
      ...(observingHeld ? [TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION] : []),
      ...(held ? getTelegramBusHeldCommandCapabilities(held.name) : []),
    ];
    const follower = deps.getFollower(expected.instanceId),
      secret = deps.getAuthSecret();
    if (
      !isCurrent() ||
      !secret ||
      !follower?.registrationGeneration ||
      !follower.busSocketPath ||
      follower.sessionId !== expected.sessionId ||
      !hasTelegramBusSharedCapabilities(
        deps.localProtocolIdentity,
        follower.protocol,
        required,
      )
    )
      return undefined;
    const captured = structuredClone(follower);
    /** The first failed authority condition, by fixed label; undefined while the captured recipient is current. */
    const staleReason = (): string | undefined => {
      if (!isCurrent()) return "caller authority";
      if (deps.getAuthSecret() !== secret) return "auth secret";
      if (
        !isDeepStrictEqual(deps.localProtocolIdentity, localProtocol) ||
        !required.every((cap) =>
          hasTelegramBusCapability(deps.localProtocolIdentity, cap),
        )
      )
        return "local protocol";
      const live = deps.getFollower(expected.instanceId);
      if (!live) return "follower registration";
      if (
        live.sessionId !== captured.sessionId ||
        live.registrationGeneration !== captured.registrationGeneration ||
        live.sessionGeneration !== captured.sessionGeneration
      )
        return "follower generation";
      if (
        live.pid !== captured.pid ||
        live.processBirthId !== captured.processBirthId
      )
        return "follower process";
      if (
        live.busSocketPath !== captured.busSocketPath ||
        live.slot !== captured.slot ||
        live.cwd !== captured.cwd
      )
        return "follower endpoint";
      if (
        "mode" in expected
          ? live.slot !== expected.slot ||
            !live.target ||
            (!areTelegramTargetsEqual(live.target, expected.target!) &&
              !areTelegramTargetsEqual(live.target, expected.oldTarget!))
          : !isDeepStrictEqual(live.target, captured.target)
      )
        return "follower target";
      if (
        !required.every((cap) =>
          hasTelegramBusCapability(live.protocol, cap),
        ) ||
        !isDeepStrictEqual(live.protocol, captured.protocol) ||
        !getTelegramBusProtocolCompatibility({
          local: deps.localProtocolIdentity,
          remote: live.protocol,
        }).compatible
      )
        return "follower protocol";
      return undefined;
    };
    const current = () => staleReason() === undefined;
    if (!current()) return undefined;
    const requestId = deps.createRequestId();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath: captured.busSocketPath!,
      timeoutMs: deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS,
      retry: { attempts: 1, delayMs: 0 },
      ...(held
        ? {
            assertAuthority: () => {
              const reason = staleReason();
              if (reason)
                throw new Error(
                  `Selected held input sender authority changed (${reason}).`,
                );
            },
          }
        : {}),
      envelope: {
        requestId,
        auth: secret,
        ...(held
          ? {
              ...marker,
              ...("mode" in expected
                ? { preparedSource: expected.preparedSource }
                : {}),
            }
          : {}),
        recipientInstanceId: expected.instanceId,
        recipientRegistrationGeneration: captured.registrationGeneration!,
        recipientSessionId: expected.sessionId,
        recipientBindingKey: expected.recipientBindingKey,
        operationId: expected.operationId,
        sentAtMs: Date.now(),
        ...("mode" in expected
          ? settling
            ? {
                kind: "leader.settleLiveRebind" as const,
                mode: expected.mode as
                  "release" | "discard" | "observe" | "observe-held" | "observe-command",
                sourceUpdateIds: expected.sourceUpdateIds!,
                ...(observing ? { oldTarget: expected.oldTarget } : {}),
              }
            : {
                kind: "leader.applyLiveRebind" as const,
                mode: expected.mode as "apply" | "inspect",
                sourceUpdateIds: expected.sourceUpdateIds!,
              }
          : {
              kind: "leader.prepareLiveRebind" as const,
              updates: expected.updates!,
            }),
      },
    });
    if (
      !current() ||
      response?.kind !== "bus.ack" ||
      response.requestId !== requestId ||
      response.ok !== true ||
      !isRecord(response.result)
    )
      return undefined;
    const result = response.result,
      recipient = result.recipient;
    if (
      !hasOnlyWireKeys(result, [
        "operationId",
        "recipient",
        "sourceUpdateIds",
        "selectedCommand",
        "preparedSource",
        "status",
        "command",
        "sourceAck",
        "target",
        "slot",
        "action",
        "oldTarget",
        "work",
      ])
    )
      return undefined;
    if (
      selectedCommand
        ? !isDeepStrictEqual(
            parseSelectedCommandInput(result.selectedCommand),
            selectedCommand,
          )
        : Object.hasOwn(result, "selectedCommand")
    )
      return undefined;
    const ids = (
      "mode" in expected
        ? [...expected.sourceUpdateIds!]
        : expected.updates!.map((update) => update.update_id)
    ).sort((a, b) => a - b);
    const observedSource = parsePreparedCommandSource(result.preparedSource);
    if (
      held
        ? !observedSource ||
          observedSource.updateId !== ids[0] ||
          observedSource.journalBindingKey !== expected.recipientBindingKey ||
          (expected.preparedSource &&
            !isDeepStrictEqual(observedSource, expected.preparedSource))
        : Object.hasOwn(result, "preparedSource")
    )
      return undefined;
    if (
      result.operationId !== expected.operationId ||
      !(commandObserving
        ? result.status === "command-observed"
        : observing
          ? result.status === "observed"
          : settling
            ? result.status === "protected" ||
              result.status === "unknown" ||
              result.status ===
                (expected.mode === "release" ? "released" : "discarded")
            : "mode" in expected
              ? result.status === "saved" || result.status === "applied"
              : result.status === "saved") ||
      !isRecord(recipient) ||
      recipient.instanceId !== expected.instanceId ||
      recipient.sessionId !== expected.sessionId ||
      recipient.generation !== captured.registrationGeneration ||
      recipient.bindingKey !== expected.recipientBindingKey ||
      !Array.isArray(result.sourceUpdateIds) ||
      result.sourceUpdateIds.length !== ids.length ||
      result.sourceUpdateIds.some((id, index) => id !== ids[index])
    )
      return undefined;
    const observation: TelegramBusLiveRebindSaveObservation = {
      operationId: expected.operationId,
      recipient: {
        instanceId: expected.instanceId,
        sessionId: expected.sessionId,
        generation: captured.registrationGeneration!,
        bindingKey: expected.recipientBindingKey,
      },
      sourceUpdateIds: ids,
      ...(held
        ? { ...structuredClone(marker), preparedSource: { ...observedSource! } }
        : {}),
      status: "saved",
    };
    if (!("mode" in expected)) return observation;
    if (commandObserving) {
      const sourceAck = parsePreparedCommandSource(result.sourceAck);
      if (
        !hasOnlyWireKeys(result, [
          "operationId",
          "recipient",
          "sourceUpdateIds",
          "selectedCommand",
          "preparedSource",
          "status",
          "command",
          "sourceAck",
        ]) ||
        !hasOnlyWireKeys(recipient, [
          "instanceId",
          "sessionId",
          "generation",
          "bindingKey",
        ]) ||
        !["completed", "unknown", "not-issued"].includes(
          result.command as string,
        ) ||
        (Object.hasOwn(result, "sourceAck") &&
          (!sourceAck ||
            !isDeepStrictEqual(sourceAck, expected.preparedSource) ||
            result.command === "not-issued"))
      )
        return undefined;
      const settled = {
        command:
          result.command as TelegramBusLiveRebindCommandObservation["command"],
        ...(sourceAck ? { sourceAck: { ...sourceAck } } : {}),
      };
      return {
        ...observation,
        status: "command-observed",
        selectedCommand: structuredClone(selectedCommand!),
        preparedSource: { ...observedSource! },
        ...settled,
      };
    }
    if (observing) {
      const work = result.work,
        oldTarget = parseThreadTarget(result.oldTarget);
      if (
        !oldTarget ||
        !isDeepStrictEqual(oldTarget, expected.oldTarget) ||
        !isRecord(work) ||
        [
          work.sessionBusy,
          work.targetWork,
          work.deliveryPending,
          work.unknown,
        ].some((flag) => typeof flag !== "boolean")
      )
        return undefined;
      return {
        ...observation,
        status: "observed",
        oldTarget,
        work: {
          sessionBusy: work.sessionBusy as boolean,
          targetWork: work.targetWork as boolean,
          deliveryPending: work.deliveryPending as boolean,
          unknown: work.unknown as boolean,
        },
      };
    }
    if (settling) {
      if (result.action !== expected.mode) return undefined;
      return {
        ...observation,
        action: expected.mode as "release" | "discard",
        status:
          result.status as TelegramBusLiveRebindSettlementObservation["status"],
      };
    }
    const target = parseThreadTarget(result.target),
      wanted =
        result.status === "applied" ? expected.target : expected.oldTarget;
    if (
      !target ||
      !isDeepStrictEqual(target, wanted) ||
      result.slot !== expected.slot
    )
      return undefined;
    return {
      ...observation,
      status: result.status as "saved" | "applied",
      target,
      slot: expected.slot!,
    };
  };
}

export function isTelegramBusEnvelopeAuthorized(
  envelope: TelegramBusEnvelope,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  if (typeof envelope.auth !== "string") return false;
  const auth = Buffer.from(envelope.auth);
  const expected = Buffer.from(secret);
  return auth.length === expected.length && timingSafeEqual(auth, expected);
}

/** Negative acknowledgement carrying only a diagnostic message. */
export const TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE =
  "Telegram bus API call is not allowed for this follower.";

export function rejectTelegramBusRequest(
  requestId: string,
  message: string,
): Extract<TelegramBusEnvelope, { kind: "bus.ack" }> {
  return { kind: "bus.ack", requestId, ok: false, message };
}

export function createUnauthorizedBusAck(
  requestId: string,
): TelegramBusEnvelope {
  return rejectTelegramBusRequest(
    requestId,
    "Unauthorized Telegram bus envelope.",
  );
}

export function createTelegramBusLocalServer(
  deps: TelegramBusLocalServerDeps,
): TelegramBusLocalServer {
  type LedgerEntry = {
    fingerprint: string;
    artifactGuard?: () => boolean;
    settled: boolean;
    result: Promise<TelegramBusEnvelope | undefined>;
  };
  const requestLedger = new Map<string, LedgerEntry>();
  const requestLedgerMaxEntries = Math.max(
    1,
    deps.requestLedgerMaxEntries ?? 4096,
  );
  const getRequestLedgerKey = (envelope: TelegramBusEnvelope): string => {
    const identity =
      envelope.kind === "follower.register" ||
      envelope.kind === "follower.restoreWorkspace"
        ? envelope.registration.instanceId
        : "instanceId" in envelope
          ? envelope.instanceId
          : "recipientInstanceId" in envelope
            ? envelope.recipientInstanceId
            : "ack";
    return `${envelope.auth ?? ""}:${identity}:${envelope.requestId}`;
  };
  const handleEnvelopeOnce = (
    envelope: TelegramBusEnvelope,
  ): Promise<TelegramBusEnvelope | undefined> => {
    const artifact = envelope.kind === "follower.callApi" && envelope.method === "sendArtifactDocument";
    const artifactGuard = artifact ? deps.captureArtifactAuthority?.(envelope) : undefined;
    const refused = () => rejectTelegramBusRequest(envelope.requestId, "Artifact authority is unavailable.");
    if (artifact && !artifactGuard?.()) return Promise.resolve(refused());
    const release = (result: Promise<TelegramBusEnvelope | undefined>) => artifact
      ? result.then(value => artifactGuard?.() ? value : refused()) : result;
    const rawKey = getRequestLedgerKey(envelope);
    const key = artifact ? Buffer.from(rawKey, "utf8").toString("utf8") : rawKey;
    const fingerprint = artifact ? createHash("sha256").update(JSON.stringify(envelope)).digest("hex") : JSON.stringify(envelope);
    const existing = requestLedger.get(key);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        if (artifact && !existing.artifactGuard?.()) return Promise.resolve(refused());
        return release(artifact ? existing.result.then(value => existing.artifactGuard?.() ? value : refused()) : existing.result);
      }
      return Promise.resolve({
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: false,
        message: "Telegram bus request id was reused with a different payload.",
        error: { code: "request-id-collision" },
      });
    }
    if (requestLedger.size >= requestLedgerMaxEntries) {
      const settledKey = Array.from(requestLedger.entries()).find(
        ([, entry]) => entry.settled,
      )?.[0];
      if (settledKey) requestLedger.delete(settledKey);
    }
    if (requestLedger.size >= requestLedgerMaxEntries) {
      return Promise.resolve({
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: false,
        message: "Telegram bus request ledger is full.",
        error: { code: "ledger-overloaded" },
      });
    }
    const entry: LedgerEntry = {
      fingerprint,
      ...(artifactGuard ? { artifactGuard } : {}),
      settled: false,
      result: artifact
        ? Promise.resolve().then(() => deps.handleEnvelope(envelope)).catch(() => rejectTelegramBusRequest(Buffer.from(envelope.requestId, "utf8").toString("utf8"), "Artifact operation outcome is unconfirmed."))
        : Promise.resolve().then(() => deps.handleEnvelope(envelope)),
    };
    requestLedger.set(key, entry);
    const settled = () => {
      entry.settled = true;
    };
    void entry.result.then(settled, settled);
    return release(entry.result);
  };
  let server: Server | undefined;
  let activeSocketPath: string | undefined;
  let activeListenPath: string | undefined;
  let endpointRecovery: Promise<boolean> | undefined;
  let stopGeneration = 0;
  let startInFlight: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const closeSocket = (socket: Socket) => {
    sockets.delete(socket);
    socket.destroy();
  };
  const runtime: TelegramBusLocalServer = {
    start: (assertAuthority) => {
      if (startInFlight) return assertAuthority ? startInFlight.then(() => { assertAuthority?.(); }) : startInFlight;
      if (server) return Promise.resolve().then(() => { assertAuthority?.(); });
      const generation = stopGeneration;
      const ports = { socketPath: deps.socketPath, before: deps.beforeEndpointPublication, commit: deps.commitEndpointPublication,
        record: deps.recordTransportEvent };
      let lost = false, checking = false, originalPath: string | undefined;
      const assertStarting = () => {
        if (lost || checking) { lost = true; throw new Error("Telegram bus server startup was cancelled or superseded."); }
        checking = true;
        try {
          assertAuthority?.();
          if (generation !== stopGeneration || deps.socketPath !== ports.socketPath || deps.beforeEndpointPublication !== ports.before ||
            deps.commitEndpointPublication !== ports.commit) lost = true;
          if (!lost && originalPath !== undefined && (typeof ports.socketPath === "function" ? ports.socketPath() : ports.socketPath) !== originalPath) lost = true;
          assertAuthority?.();
          if (generation !== stopGeneration || lost) { lost = true; throw new Error("Telegram bus server startup was cancelled or superseded."); }
        } catch (error) { lost = true; throw error; }
        finally { checking = false; }
      };
      const record = (phase: string, details: Record<string, unknown>) => {
        try { ports.record?.(phase, details); } catch { /* Diagnostics cannot replace startup or publication authority. */ }
      };
      let resolveStarted!: () => void, rejectStarted!: (error: unknown) => void;
      const result = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
      startInFlight = result;
      const run = async () => {
        let ownServer: Server | undefined, socketPath: string | undefined, listenPath: string | undefined, linkPath: string | undefined;
        const ownSockets = new Set<Socket>();
        const activeServers = getActiveTelegramBusLocalServers();
        try {
          assertStarting();
          originalPath = typeof ports.socketPath === "function" ? ports.socketPath() : ports.socketPath;
          assertStarting();
          socketPath = resolveTelegramBusSocketPath(originalPath);
          const replacedServer = activeServers.get(socketPath);
          if (replacedServer && replacedServer !== runtime) await replacedServer.stop();
          assertStarting();
          const usesWindowsPipe = isTelegramBusPipePath(socketPath);
          const endpointGeneration = randomBytes(8).toString("hex");
          listenPath = usesWindowsPipe ? socketPath : join(dirname(socketPath), `.pt-${endpointGeneration}.sock`);
          activeSocketPath = socketPath;
          activeListenPath = listenPath;
          record("server-start", getTelegramBusEndpointDiagnostics(socketPath));
          assertStarting();
          if (!usesWindowsPipe) {
            mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
            chmodSync(dirname(socketPath), 0o700);
            if (existsSync(listenPath)) unlinkSync(listenPath);
            const legacyDeadlineMs = Date.now() + 2000;
            for (;;) {
              assertStarting();
              let legacy = false;
              try { legacy = lstatSync(socketPath).isSocket(); } catch { /* Endpoint does not exist. */ }
              if (!legacy) break;
              const probe = await probeTelegramBusEndpoint({ endpoint: socketPath, timeoutMs: 50 });
              assertStarting();
              if (!probe.reachable) break;
              if (Date.now() >= legacyDeadlineMs) throw new Error(`Timed out waiting for legacy Telegram bus endpoint: ${socketPath}`);
              await delayTelegramBusTransportRetry(25);
              assertStarting();
            }
          }
          const publish = (effect: () => void) => {
            assertStarting();
            let issued = false;
            const commit = () => {
              if (issued) { lost = true; throw new Error("Telegram bus endpoint publication was already issued."); }
              assertStarting();
              issued = true;
              effect();
            };
            const accepted = ports.commit ? ports.commit(commit) : (commit(), true);
            assertStarting();
            if (accepted !== true || !issued) throw new Error("Telegram bus endpoint publication lost transport ownership.");
          };
          if (usesWindowsPipe) {
            await ports.before?.();
            assertStarting();
            publish(() => {});
          }
          assertStarting();
          const startedPath = socketPath;
          ownServer = createServer((socket) => {
            if (generation !== stopGeneration) { socket.destroy(); return; }
            sockets.add(socket); ownSockets.add(socket);
            let buffer = "";
            socket.setEncoding("utf8");
            socket.on("data", chunk => {
              if (generation !== stopGeneration) { closeSocket(socket); return; }
              buffer += chunk;
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) void handleTelegramBusSocketLine(line, socket, handleEnvelopeOnce, ports.record, startedPath, deps.shouldDropResponse);
            });
            socket.on("close", () => { sockets.delete(socket); ownSockets.delete(socket); });
            socket.on("error", error => {
              record("server-socket-error", { ...getTelegramBusEndpointDiagnostics(startedPath), ...classifyTelegramBusTransportError(error) });
              closeSocket(socket);
            });
          });
          server = ownServer;
          const listener = ownServer;
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(listenPath, resolve);
          });
          assertStarting();
          activeServers.set(socketPath, runtime);
          record("server-started", getTelegramBusEndpointDiagnostics(socketPath));
          assertStarting();
          if (!usesWindowsPipe) {
            chmodSync(listenPath, 0o600);
            linkPath = `${socketPath}.link.${endpointGeneration}`;
            symlinkSync(basename(listenPath), linkPath);
            await ports.before?.();
            assertStarting();
            publish(() => renameSync(linkPath!, startedPath));
          }
          assertStarting();
        } catch (error) {
          lost = true;
          if (linkPath && listenPath) {
            try { if (lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === basename(listenPath)) unlinkSync(linkPath); }
            catch { /* Only this unpublished generation link may be removed. */ }
          }
          if (generation === stopGeneration) {
            if (socketPath && activeServers.get(socketPath) === runtime) activeServers.delete(socketPath);
            if (server === ownServer) server = undefined;
            activeSocketPath = undefined; activeListenPath = undefined;
          }
          for (const socket of ownSockets) closeSocket(socket);
          if (ownServer) await new Promise<void>(resolve => ownServer!.close(() => resolve()));
          if (socketPath) record("server-start-failed", { ...getTelegramBusEndpointDiagnostics(socketPath), ...classifyTelegramBusTransportError(error) });
          throw error;
        }
      };
      void run().then(() => {
        assertAuthority = undefined;
        if (startInFlight === result) startInFlight = undefined;
        resolveStarted();
      }, error => {
        assertAuthority = undefined;
        if (startInFlight === result) startInFlight = undefined;
        rejectStarted(error);
      });
      return result;
    },
    stop: async () => {
      stopGeneration += 1;
      startInFlight = undefined;
      requestLedger.clear();
      const activeServer = server;
      const socketPath = activeSocketPath;
      const listenPath = activeListenPath;
      if (
        socketPath &&
        getActiveTelegramBusLocalServers().get(socketPath) === runtime
      ) {
        getActiveTelegramBusLocalServers().delete(socketPath);
      }
      server = undefined;
      activeSocketPath = undefined;
      activeListenPath = undefined;
      for (const socket of sockets) closeSocket(socket);
      if (activeServer) {
        await new Promise<void>((resolve) =>
          activeServer.close(() => resolve()),
        );
      }
      if (socketPath && listenPath && !isTelegramBusPipePath(socketPath)) {
        try {
          if (
            lstatSync(socketPath).isSymbolicLink() &&
            readlinkSync(socketPath) === basename(listenPath)
          ) {
            // Leave the generation link in place. Node removes only the unique
            // listen path on close; a later generation atomically replaces this
            // link, and existsSync() treats the stopped dangling link as missing.
          }
        } catch {
          /* endpoint already moved or removed */
        }
      }
      if (socketPath) {
        deps.recordTransportEvent?.(
          "server-stopped",
          getTelegramBusEndpointDiagnostics(socketPath),
        );
      }
    },
    ensureEndpoint: async () => {
      const socketPath = activeSocketPath;
      if (
        !server ||
        !socketPath ||
        isTelegramBusPipePath(socketPath) ||
        existsSync(socketPath)
      ) {
        return false;
      }
      if (endpointRecovery) return endpointRecovery;
      endpointRecovery = (async () => {
        deps.recordTransportEvent?.(
          "server-endpoint-missing",
          getTelegramBusEndpointDiagnostics(socketPath),
        );
        const recoveryStopGeneration = stopGeneration + 1;
        await runtime.stop();
        if (stopGeneration !== recoveryStopGeneration) return false;
        await runtime.start();
        if (stopGeneration !== recoveryStopGeneration) {
          await runtime.stop();
          return false;
        }
        deps.recordTransportEvent?.(
          "server-endpoint-recovered",
          getTelegramBusEndpointDiagnostics(socketPath),
        );
        return true;
      })();
      try {
        return await endpointRecovery;
      } finally {
        endpointRecovery = undefined;
      }
    },
  };
  return runtime;
}

function getTelegramBusEnvelopeDiagnostics(
  envelope: TelegramBusEnvelope,
): Record<string, unknown> {
  return {
    envelopeKind: envelope.kind,
    requestId: envelope.requestId,
  };
}

/** Private positive origin proof: only the native socket error path may construct this before issuance. */
class TelegramBusUnissuedConnectionError extends Error {
  readonly nativeError: Error;
  constructor(nativeError: Error) { super(nativeError.message, { cause: nativeError }); this.nativeError = nativeError; }
}

function sendTelegramBusLocalEnvelopeOnce(
  options: TelegramBusLocalClientOptions,
): Promise<TelegramBusEnvelope | undefined> {
  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve, reject) => {
    const assertAuthority = options.assertAuthority, readiness = options.connectionReadiness;
    let issued = false;
    const readRemaining = () => {
      const remaining = readiness!.remainingMs();
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647) throw new TelegramBusConnectionReadinessExpiredError();
      return remaining;
    };
    const assertCurrent = (beforeWrite = false) => {
      try {
        assertAuthority?.();
      } catch (error) {
        // The caller's reason is a fixed condition label, never request or credential content.
        throw new TelegramBusLocalAuthorityError(
          issued,
          error instanceof Error ? error.message : undefined,
        );
      }
      if (readiness && (!issued || beforeWrite)) readRemaining();
    };
    try {
      assertCurrent();
    } catch (error) {
      reject(error);
      return;
    }
    const socket = createConnection(options.socketPath);
    let settled = false;
    let buffer = "";
    let timeoutFinalizer: ReturnType<typeof setImmediate> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (readinessTimeout) clearTimeout(readinessTimeout);
      if (timeoutFinalizer) clearImmediate(timeoutFinalizer);
      socket.destroy();
      callback();
    };
    const startResponseTimeout = () => {
      timeout = setTimeout(() => {
        // A long synchronous Pi/TUI turn can resume in the timers phase after
        // the peer acknowledgement is already buffered. Give pending socket I/O
        // two poll phases before converting elapsed wall time into a transport
        // failure; Darwin can surface buffered Unix-socket input only on the
        // second cycle after a long stall, while a silent peer stays bounded.
        timeoutFinalizer = setImmediate(() => {
          timeoutFinalizer = setImmediate(() => {
            settle(() =>
              reject(
                createTelegramBusTransportTimeoutError(
                  "Timed out waiting for Telegram bus response",
                ),
              ),
            );
          });
        });
      }, timeoutMs);
    };
    if (!readiness) startResponseTimeout();
    if (readiness) {
      try {
        readinessTimeout = setTimeout(() => {
          if (!issued) settle(() => reject(new TelegramBusConnectionReadinessExpiredError()));
        }, readRemaining());
      } catch (error) { settle(() => reject(error)); return; }
    }
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (settled) return;
      try {
        assertCurrent();
        const encoded = encodeTelegramBusEnvelope(options.envelope);
        assertCurrent();
        issued = true;
        if (readinessTimeout) clearTimeout(readinessTimeout);
        if (readiness) startResponseTimeout();
        options.onRequestIssued?.();
        assertCurrent(true);
        socket.write(encoded);
      } catch (error) {
        settle(() => reject(error));
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex);
      try {
        const response = parseTelegramBusEnvelope(line);
        assertCurrent();
        settle(() => resolve(response));
      } catch (error) {
        settle(() => reject(error));
      }
    });
    socket.once("error", (error) => settle(() => reject(readiness && !issued ? new TelegramBusUnissuedConnectionError(error) : error)));
    socket.once("end", () => settle(() => resolve(undefined)));
  });
}

export async function sendTelegramBusLocalEnvelope(
  options: TelegramBusLocalClientOptions,
): Promise<TelegramBusEnvelope | undefined> {
  const originalAuthority = options.assertAuthority, issuedCallback = options.onRequestIssued, readiness = options.connectionReadiness;
  const remainingMs = readiness?.remainingMs, wait = readiness?.wait, recorder = options.recordTransportEvent;
  const record = (phase: string, details: Record<string, unknown>) => {
    if (!readiness) return recorder?.(phase, details);
    try { recorder?.(phase, details); } catch { /* Diagnostics cannot turn connection waiting into takeover evidence. */ }
  };
  if (readiness && (options.envelope.kind !== "follower.register" || !originalAuthority || !remainingMs || !wait))
    throw new Error("Connection readiness requires original registration authority.");
  let requestIssued = false;
  const resolvedOptions = {
    ...options,
    connectionReadiness: readiness ? Object.freeze({ remainingMs: () => remainingMs!.call(readiness), wait: () => wait!.call(readiness) }) : undefined,
    assertAuthority() {
      try {
        originalAuthority?.();
        if (!requestIssued && readiness && (readiness.remainingMs !== remainingMs || readiness.wait !== wait))
          throw new Error("Original connection readiness changed.");
      } catch (error) {
        throw new TelegramBusLocalAuthorityError(requestIssued, error instanceof Error ? error.message : undefined);
      }
    },
    onRequestIssued() { requestIssued = true; issuedCallback?.(); },
    socketPath: resolveTelegramBusSocketPath(options.socketPath),
  };
  const attempts = Math.max(1, resolvedOptions.retry?.attempts ?? 1);
  const delayMs = Math.max(0, resolvedOptions.retry?.delayMs ?? 0);
  // Log the first failure, then only the outcome: a reloading leader would otherwise log every attempt.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await sendTelegramBusLocalEnvelopeOnce(resolvedOptions);
      if (attempt > 1)
        record("client-recovered", {
          ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
          ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
          attempt,
          ...(readiness ? { readinessBounded: true } : { attempts }),
        });
      return response;
    } catch (error) {
      const nativeError = error instanceof TelegramBusUnissuedConnectionError ? error.nativeError : error;
      const info = classifyTelegramBusTransportError(nativeError);
      const safeConnectionRetry = readiness && !requestIssued && error instanceof TelegramBusUnissuedConnectionError &&
        info.syscall === "connect" && info.retryable;
      const final = readiness ? !safeConnectionRetry :
        error instanceof TelegramBusLocalAuthorityError ||
        attempt >= attempts ||
        !isRetryableTelegramBusTransportError(error);
      if (attempt === 1 || final)
        record("client-failed", {
          ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
          ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
          attempt,
          ...(readiness ? { readinessBounded: true } : { attempts }),
          ...info,
        });
      if (final) throw nativeError;
      if (attempt === 1)
        record("client-retry", {
          ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
          ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
          attempt,
          ...(readiness ? { readinessBounded: true } : { attempts, delayMs }),
          ...info,
        });
      if (readiness) {
        resolvedOptions.assertAuthority();
        if (!(await wait!.call(readiness))) throw new TelegramBusConnectionReadinessExpiredError();
        resolvedOptions.assertAuthority();
      } else await delayTelegramBusTransportRetry(delayMs);
    }
  }
}

/** Ordinary guarded call authority only; neither question membership nor Input receiver readiness. */
export const TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY = "guarded-api-authority-v1" as const;
/** Existing registry incarnation, acknowledged independently of Artifact and matched by guarded API calls. */
export const TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY = "api-registration-authority-v1" as const;

/** Private publication contract only; never add to production advertisement before input privacy readiness. */
export const TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION = "attachment-original-publication-v1" as const;
export const TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT = "__piTelegramAttachmentPublication" as const;
export interface TelegramBusAttachmentPublicationReceipt {
  readonly version: 1;
  readonly requestId: string;
  readonly nonce: string;
  readonly instanceId: string;
  readonly registrationGeneration: string;
  readonly registrationIncarnation: string;
  readonly botId: number;
  readonly messageId: number;
  readonly target: Readonly<TelegramTarget>;
}
/** Private decoded-data evidence, not a receiver, source submission or business grant. */
export function parseTelegramBusAttachmentPublicationReceipt(raw: unknown): Readonly<TelegramBusAttachmentPublicationReceipt> | undefined {
  if (!isRecord(raw) || Object.keys(raw).length !== 9 || Object.keys(raw).some(key =>
    !["version", "requestId", "nonce", "instanceId", "registrationGeneration", "registrationIncarnation", "botId", "messageId", "target"].includes(key)) || raw.version !== 1 ||
    [raw.requestId, raw.instanceId, raw.registrationGeneration].some(value => typeof value !== "string" || !value.trim() ||
      value !== value.trim() || value.length > 512 || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) ||
    typeof raw.registrationIncarnation !== "string" || !/^[a-f0-9]{48}$/u.test(raw.registrationIncarnation) ||
    typeof raw.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(raw.nonce) || !Number.isSafeInteger(raw.botId) || (raw.botId as number) <= 0 ||
    !Number.isSafeInteger(raw.messageId) || (raw.messageId as number) <= 0 || !isRecord(raw.target) ||
    Object.keys(raw.target).some(key => key !== "chatId" && key !== "threadId") ||
    !Number.isSafeInteger(raw.target.chatId) || (raw.target.chatId as number) <= 0 ||
    raw.target.threadId !== undefined && (!Number.isSafeInteger(raw.target.threadId) || (raw.target.threadId as number) <= 0)) return undefined;
  return Object.freeze({ version: 1, requestId: raw.requestId as string, nonce: raw.nonce, instanceId: raw.instanceId as string,
    registrationGeneration: raw.registrationGeneration as string, registrationIncarnation: raw.registrationIncarnation, botId: raw.botId as number, messageId: raw.messageId as number,
    target: Object.freeze({ chatId: raw.target.chatId as number, ...(raw.target.threadId !== undefined ? { threadId: raw.target.threadId as number } : {}) }) });
}

export const TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT = "artifact-document-v1" as const;

export interface TelegramBusArtifactDocument {
  version: 1;
  registrationIncarnation: string;
  target: TelegramTarget;
  fileName: string;
  byteLength: number;
  bytesBase64: string;
  caption?: string;
  expiresAt: number;
}

/** Avoid RegExp's process-wide last-input retention for payload-bearing strings. */
function isCanonicalArtifactBase64(encoded: string, byteLength: number): boolean {
  if (encoded.length !== 4 * Math.ceil(byteLength / 3)) return false;
  const padding = (3 - byteLength % 3) % 3, end = encoded.length - padding;
  for (let i = 0; i < end; i++) {
    const c = encoded.charCodeAt(i);
    if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47)) return false;
  }
  for (let i = end; i < encoded.length; i++) if (encoded.charCodeAt(i) !== 61) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return padding === 0 || (alphabet.indexOf(encoded[end - 1]!) & (padding === 2 ? 15 : 3)) === 0;
}

/** Strict bounded wire validation does not decode bytes or grant source/business authority. */
export function parseTelegramBusArtifactDocument(args: unknown[]): TelegramBusArtifactDocument | undefined {
  if (args.length !== 1) return undefined;
  const value = args[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>, t = v.target as Record<string, unknown> | undefined;
  if (Object.keys(v).some(k => !["version", "registrationIncarnation", "target", "fileName", "byteLength", "bytesBase64", "caption", "expiresAt"].includes(k)) ||
      v.version !== 1 || typeof v.registrationIncarnation !== "string" || !/^[a-f0-9]{48}$/u.test(v.registrationIncarnation) ||
      !t || typeof t !== "object" || Array.isArray(t) || Object.keys(t).some(k => k !== "chatId" && k !== "threadId") ||
      !Number.isSafeInteger(t.chatId) || (t.chatId as number) <= 0 ||
      (t.threadId !== undefined && (!Number.isSafeInteger(t.threadId) || (t.threadId as number) <= 0)) ||
      !isTelegramArtifactFileName(v.fileName) ||
      !Number.isSafeInteger(v.byteLength) || (v.byteLength as number) < 1 || (v.byteLength as number) > TELEGRAM_ARTIFACT_MAX_BYTES ||
      typeof v.bytesBase64 !== "string" || !isCanonicalArtifactBase64(v.bytesBase64, v.byteLength as number) ||
      (v.caption !== undefined && !isTelegramArtifactCaption(v.caption)) ||
      !Number.isSafeInteger(v.expiresAt) || (v.expiresAt as number) <= Date.now()) return undefined;
  return value as TelegramBusArtifactDocument;
}

export interface TelegramBusFollowerRegistry {
  register: (
    registration: TelegramBusInstanceRegistration,
  ) => TelegramBusFollowerView;
  /** Native registry lifetime only; not Artifact, publication or source custody authority. */
  captureRegistration?: (instanceId: string, generation: string) => (() => boolean) | undefined;
  captureArtifactRegistration?: (instanceId: string, incarnation: string) => (() => boolean) | undefined;
  /** Native whole-roster codec compatibility; membership churn spends the capture, heartbeat alone does not. Not a write grant. */
  captureOrphanIntentReaderCompatibility?: (local: TelegramBusProtocolIdentity, mode?: "intent" | "cleanup") => (() => boolean) | undefined;
  heartbeat: (
    instanceId: string,
    nowMs: number,
  ) => TelegramBusFollowerView | undefined;
  get: (instanceId: string) => TelegramBusFollowerView | undefined;
  getByTarget: (target: TelegramTarget) => TelegramBusFollowerView | undefined;
  list: () => TelegramBusFollowerView[];
  remove: (instanceId: string) => boolean;
  clear: () => void;
  observeUnregistered: (follower: TelegramBusFollowerView) => {
    isCurrent: () => boolean;
    release: () => void;
  };
  pruneStale: (
    nowMs: number,
    staleAfterMs: number,
  ) => TelegramBusFollowerView[];
}

export function createTelegramBusForwardOwnershipValidator(
  registry: Pick<TelegramBusFollowerRegistry, "get">,
): (ownership: TelegramBusForwardOwnership) => boolean {
  return (ownership) => {
    const follower = registry.get(ownership.instanceId);
    return isTelegramBusForwardOwnershipCurrent(
      ownership,
      follower?.registrationGeneration &&
        follower.profileKey &&
        follower.protocol
        ? {
            instanceId: follower.instanceId,
            ownerGeneration: follower.registrationGeneration,
            recipientBindingKey: follower.profileKey,
            protocolIdentity: follower.protocol,
          }
        : undefined,
    );
  };
}

function hasTelegramBusFollowerIdentityOverlap(
  first: TelegramBusInstanceRegistration,
  second: TelegramBusInstanceRegistration,
): boolean {
  return (
    first.instanceId === second.instanceId ||
    (first.profileKey !== undefined &&
      first.profileKey === second.profileKey) ||
    (first.target !== undefined &&
      first.target.chatId === second.target?.chatId &&
      first.target.threadId === second.target.threadId)
  );
}

export function createTelegramBusFollowerRegistry(): TelegramBusFollowerRegistry {
  const followers = new Map<string, TelegramBusFollowerView>();
  let membership = {};
  const observations = new Set<{
    follower: TelegramBusFollowerView;
    current: boolean;
  }>();
  const clone = (
    follower: TelegramBusFollowerView,
  ): TelegramBusFollowerView => ({
    ...follower,
    target: follower.target ? { ...follower.target } : undefined,
    ...(follower.protocol
      ? {
          protocol: {
            ...follower.protocol,
            capabilities: [...follower.protocol.capabilities],
          },
        }
      : {}),
  });
  const captureLifetime = (owned: TelegramBusFollowerView) => {
    // Keep owner-created scalars, never a payload-backed registering peer's object.
    const id = owned.instanceId, incarnation = owned.registrationIncarnation;
    let lost = false;
    const current = () => { lost ||= followers.get(id)?.registrationIncarnation !== incarnation; return !lost; };
    return current() ? current : undefined;
  };
  const registry: TelegramBusFollowerRegistry = {
    captureOrphanIntentReaderCompatibility(local, mode = "intent") {
      if (mode !== "intent" && mode !== "cleanup") return undefined;
      const required = [TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER,
        ...(mode === "cleanup" ? [TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER] : [])];
      const born = membership, protocol = structuredClone(local);
      const keys = ["captureOrphanIntentReaderCompatibility", "list", "get", "register", "remove", "clear", "pruneStale"] as const;
      const methods = keys.map(key => registry[key]);
      let lost = false;
      if (required.some(capability => !hasTelegramBusCapability(protocol, capability)) ||
        [...followers.values()].some(row => !row.registrationGeneration ||
          required.some(capability => !hasTelegramBusCapability(row.protocol, capability)))) return undefined;
      const current = () => {
        lost ||= membership !== born || !isDeepStrictEqual(local, protocol) || keys.some((key, index) => registry[key] !== methods[index]);
        return !lost;
      };
      return current() ? current : undefined;
    },
    captureRegistration(instanceId, generation) {
      const owned = followers.get(instanceId);
      return owned?.registrationGeneration === generation ? captureLifetime(owned) : undefined;
    },
    captureArtifactRegistration(instanceId, incarnation) {
      const owned = followers.get(instanceId);
      return owned?.registrationIncarnation === incarnation ? captureLifetime(owned) : undefined;
    },
    register: (registration) => {
      membership = {};
      const existing = followers.get(registration.instanceId);
      for (const [instanceId, follower] of followers.entries()) {
        if (instanceId === registration.instanceId) continue;
        if (hasTelegramBusFollowerIdentityOverlap(registration, follower))
          followers.delete(instanceId);
      }
      const next: TelegramBusFollowerView = {
        ...registration,
        registrationIncarnation: randomBytes(24).toString("hex"),
        target: registration.target ? { ...registration.target } : undefined,
        ...(registration.protocol
          ? {
              protocol: {
                ...registration.protocol,
                capabilities: [...registration.protocol.capabilities],
              },
            }
          : {}),
        lastHeartbeatMs:
          existing?.lastHeartbeatMs ?? registration.connectedAtMs,
      };
      followers.set(registration.instanceId, next);
      for (const observation of observations) {
        if (!hasTelegramBusFollowerIdentityOverlap(next, observation.follower))
          continue;
        observation.current = false;
        observations.delete(observation);
      }
      return clone(next);
    },
    heartbeat: (instanceId, nowMs) => {
      const existing = followers.get(instanceId);
      if (!existing) return undefined;
      const next = { ...existing, lastHeartbeatMs: nowMs };
      followers.set(instanceId, next);
      return clone(next);
    },
    get: (instanceId) => {
      const existing = followers.get(instanceId);
      return existing ? clone(existing) : undefined;
    },
    getByTarget: (target) => {
      for (const follower of followers.values()) {
        if (
          follower.target?.chatId === target.chatId &&
          follower.target.threadId === target.threadId
        ) {
          return clone(follower);
        }
      }
      return undefined;
    },
    list: () => [...followers.values()].map(clone),
    remove: (instanceId) => {
      const removed = followers.delete(instanceId);
      if (removed) membership = {};
      return removed;
    },
    clear: () => {
      if (followers.size) membership = {};
      followers.clear();
      for (const observation of observations) observation.current = false;
      observations.clear();
    },
    observeUnregistered: (follower) => {
      // This watches replacement, not process death or delivery authority.
      const observation = {
        follower: clone(follower),
        current: ![...followers.values()].some((current) =>
          hasTelegramBusFollowerIdentityOverlap(current, follower),
        ),
      };
      if (observation.current) observations.add(observation);
      return {
        isCurrent: () => observation.current,
        release() {
          observation.current = false;
          observations.delete(observation);
        },
      };
    },
    pruneStale: (nowMs, staleAfterMs) => {
      const removed: TelegramBusFollowerView[] = [];
      for (const [instanceId, follower] of followers.entries()) {
        if (nowMs - follower.lastHeartbeatMs <= staleAfterMs) continue;
        followers.delete(instanceId);
        removed.push(clone(follower));
      }
      if (removed.length) membership = {};
      return removed;
    },
  };
  return registry;
}

async function handleTelegramBusSocketLine(
  line: string,
  socket: Socket,
  handleEnvelope: TelegramBusLocalServerDeps["handleEnvelope"],
  recordTransportEvent: TelegramBusTransportEventRecorder | undefined,
  socketPath: string,
  shouldDropResponse?: (
    request: TelegramBusEnvelope,
    response: TelegramBusEnvelope,
  ) => boolean,
): Promise<void> {
  const envelope = parseTelegramBusEnvelope(line);
  if (!envelope) {
    recordTransportEvent?.("server-invalid-envelope", {
      ...getTelegramBusEndpointDiagnostics(socketPath),
      byteLength: Buffer.byteLength(line),
    });
    socket.write(
      encodeTelegramBusEnvelope({
        kind: "bus.ack",
        requestId: "invalid",
        ok: false,
        message: "Invalid Telegram bus envelope.",
      }),
    );
    return;
  }
  try {
    const response = await handleEnvelope(envelope);
    if (response && !shouldDropResponse?.(envelope, response)) {
      socket.write(encodeTelegramBusEnvelope(response));
    }
  } catch (error) {
    recordTransportEvent?.("server-handler-failed", {
      ...getTelegramBusEndpointDiagnostics(socketPath),
      ...getTelegramBusEnvelopeDiagnostics(envelope),
      ...classifyTelegramBusTransportError(error),
    });
    socket.write(
      encodeTelegramBusEnvelope(
        rejectTelegramBusRequest(
          envelope.requestId,
          "Telegram bus handler failed.",
        ),
      ),
    );
  }
}

function parseRegisterEnvelope(
  value: Record<string, unknown>,
  requestId: string,
  kind: "follower.register" | "follower.restoreWorkspace",
): TelegramBusEnvelope | undefined {
  if (value.recoverConnection !== undefined &&
      (kind !== "follower.register" || value.recoverConnection !== true)) return undefined;
  const registration = parseRegistration(value.registration);
  return registration ? { kind, requestId, registration,
    ...(kind === "follower.register" && value.recoverConnection === true ? { recoverConnection: true as const } : {}),
  } : undefined;
}

function parseFollowerPresenceEnvelope(
  value: Record<string, unknown>,
  requestId: string,
  kind: "follower.heartbeat" | "follower.disconnect",
): TelegramBusEnvelope | undefined {
  return typeof value.instanceId === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind,
        requestId,
        instanceId: value.instanceId,
        ...(typeof value.registrationGeneration === "string"
          ? { registrationGeneration: value.registrationGeneration }
          : {}),
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseRenameThreadEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const target = parseTarget(value.target);
  return typeof value.instanceId === "string" &&
    typeof value.registrationGeneration === "string" &&
    target?.threadId !== undefined &&
    typeof value.threadName === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "follower.renameThread",
        requestId,
        instanceId: value.instanceId,
        registrationGeneration: value.registrationGeneration,
        target: { chatId: target.chatId, threadId: target.threadId },
        threadName: value.threadName,
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseTelegramBusFollowerDeliveryIdentity(
  value: unknown,
): TelegramBusFollowerDeliveryIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.deliveryId !== "string" ||
    !/^telegram-follower-v1-[a-f0-9]{64}$/u.test(value.deliveryId) ||
    !Number.isSafeInteger(value.sourceUpdateId) ||
    (value.sourceUpdateId as number) < 0 ||
    typeof value.recipientBindingKey !== "string" ||
    !value.recipientBindingKey ||
    (value.sourceRecoveryKey !== undefined &&
      (typeof value.sourceRecoveryKey !== "string" ||
        !value.sourceRecoveryKey ||
        value.sourceRecoveryKey.length > 1_024)) ||
    (value.sourceClaim !== undefined &&
      (!isRecord(value.sourceClaim) ||
        typeof value.sourceClaim.acquisitionId !== "string" ||
        !value.sourceClaim.acquisitionId ||
        value.sourceClaim.acquisitionId.length > 256 ||
        typeof value.sourceClaim.handoffId !== "string" ||
        !value.sourceClaim.handoffId ||
        value.sourceClaim.handoffId.length > 256))
  ) {
    return undefined;
  }
  return {
    deliveryId: value.deliveryId,
    sourceUpdateId: value.sourceUpdateId as number,
    recipientBindingKey: value.recipientBindingKey,
    ...(typeof value.sourceRecoveryKey === "string"
      ? { sourceRecoveryKey: value.sourceRecoveryKey }
      : {}),
    ...(isRecord(value.sourceClaim)
      ? {
          sourceClaim: {
            acquisitionId: value.sourceClaim.acquisitionId as string,
            handoffId: value.sourceClaim.handoffId as string,
          },
        }
      : {}),
  };
}

function parseForwardCallbackEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
  return delivery &&
    typeof value.recipientInstanceId === "string" &&
    typeof value.recipientRegistrationGeneration === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "leader.forwardCallback",
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        recipientRegistrationGeneration: value.recipientRegistrationGeneration,
        delivery,
        query: value.query,
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseForwardReactionEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
  return delivery &&
    typeof value.recipientInstanceId === "string" &&
    typeof value.recipientRegistrationGeneration === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "leader.forwardReaction",
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        recipientRegistrationGeneration: value.recipientRegistrationGeneration,
        delivery,
        reactionUpdate: value.reactionUpdate,
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseForwardMessageEnvelope(
  value: Record<string, unknown>,
  requestId: string,
  kind: "leader.forwardMessage" | "leader.forwardEditedMessage",
): TelegramBusEnvelope | undefined {
  const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
  return delivery &&
    typeof value.recipientInstanceId === "string" &&
    typeof value.recipientRegistrationGeneration === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind,
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        recipientRegistrationGeneration: value.recipientRegistrationGeneration,
        delivery,
        message: value.message,
        ...(kind === "leader.forwardMessage" &&
        (value.forwardCommentBatchPosition === "comment" ||
          value.forwardCommentBatchPosition === "forward")
          ? {
              forwardCommentBatchPosition: value.forwardCommentBatchPosition,
            }
          : {}),
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseOfferInputCustodyHandoffEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const source = value.source;
  if (
    !isRecord(source) ||
    typeof value.recipientInstanceId !== "string" ||
    typeof value.recipientRegistrationGeneration !== "string" ||
    typeof value.recipientBindingKey !== "string" ||
    !value.recipientBindingKey ||
    typeof value.sourceRecoveryKey !== "string" ||
    !value.sourceRecoveryKey ||
    value.sourceRecoveryKey.length > 1_024 ||
    typeof source.journalBindingKey !== "string" ||
    !source.journalBindingKey ||
    source.journalBindingKey !== value.sourceRecoveryKey ||
    typeof source.tokenSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.tokenSha256) ||
    !Number.isSafeInteger(source.updateId) ||
    (source.updateId as number) < 0 ||
    typeof value.handoffId !== "string" ||
    !value.handoffId ||
    value.handoffId.length > 256 ||
    typeof value.sentAtMs !== "number"
  )
    return undefined;
  return {
    kind: "leader.offerInputCustodyHandoff",
    requestId,
    recipientInstanceId: value.recipientInstanceId,
    recipientRegistrationGeneration: value.recipientRegistrationGeneration,
    recipientBindingKey: value.recipientBindingKey,
    sourceRecoveryKey: value.sourceRecoveryKey,
    source: {
      journalBindingKey: source.journalBindingKey,
      tokenSha256: source.tokenSha256,
      updateId: source.updateId as number,
    },
    handoffId: value.handoffId,
    sentAtMs: value.sentAtMs,
  };
}

function parseWakeInputCustodyEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
  return delivery &&
    delivery.sourceRecoveryKey &&
    delivery.sourceClaim &&
    typeof value.recipientInstanceId === "string" &&
    typeof value.recipientRegistrationGeneration === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "leader.wakeInputCustody",
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        recipientRegistrationGeneration: value.recipientRegistrationGeneration,
        delivery,
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseQueueHandoffEnvelope(
  value: Record<string, unknown>,
  requestId: string,
  kind: "leader.offerQueueHandoff" | "follower.offerQueueHandoff",
): TelegramBusEnvelope | undefined {
  let serializedPayloadBytes: number;
  try {
    serializedPayloadBytes = Buffer.byteLength(JSON.stringify(value.payload));
  } catch {
    return undefined;
  }
  if (serializedPayloadBytes > TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES) {
    return undefined;
  }
  const payload = parseTelegramQueueHandoffPayload(value.payload);
  if (
    !payload ||
    typeof value.recipientInstanceId !== "string" ||
    typeof value.recipientRegistrationGeneration !== "string" ||
    !Number.isSafeInteger(value.donorProcessId) ||
    (value.donorProcessId as number) <= 0 ||
    typeof value.donorProcessBirthId !== "string" ||
    !value.donorProcessBirthId ||
    !Number.isSafeInteger(value.donorSessionGeneration) ||
    (value.donorSessionGeneration as number) <= 0 ||
    typeof value.donorAcquisitionId !== "string" ||
    !value.donorAcquisitionId ||
    !Number.isSafeInteger(value.donorAcquiredAtMs) ||
    (value.donorAcquiredAtMs as number) < 0 ||
    typeof value.handoffToken !== "string" ||
    value.handoffToken.length < 32 ||
    value.handoffToken.length > 256 ||
    value.donorProcessBirthId.length > 256 ||
    value.donorAcquisitionId.length > 256 ||
    typeof value.sentAtMs !== "number"
  ) {
    return undefined;
  }
  const fields = {
    requestId,
    recipientInstanceId: value.recipientInstanceId,
    recipientRegistrationGeneration: value.recipientRegistrationGeneration,
    donorProcessId: value.donorProcessId as number,
    donorProcessBirthId: value.donorProcessBirthId,
    donorSessionGeneration: value.donorSessionGeneration as number,
    donorAcquisitionId: value.donorAcquisitionId,
    donorAcquiredAtMs: value.donorAcquiredAtMs as number,
    handoffToken: value.handoffToken,
    payload,
    sentAtMs: value.sentAtMs,
  };
  if (kind === "leader.offerQueueHandoff") {
    return typeof value.donorInstanceId === "string"
      ? { kind, donorInstanceId: value.donorInstanceId, ...fields }
      : undefined;
  }
  return typeof value.instanceId === "string" &&
    typeof value.registrationGeneration === "string"
    ? {
        kind,
        instanceId: value.instanceId,
        registrationGeneration: value.registrationGeneration,
        ...fields,
      }
    : undefined;
}

function parseResolveAgentTargetEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const selectorValue = isRecord(value.selector) ? value.selector : undefined;
  if (
    typeof value.instanceId !== "string" ||
    !selectorValue ||
    typeof value.sentAtMs !== "number"
  ) {
    return undefined;
  }
  const chatId =
    typeof selectorValue.chatId === "number" &&
    Number.isInteger(selectorValue.chatId)
      ? selectorValue.chatId
      : undefined;
  const threadId =
    typeof selectorValue.threadId === "number" &&
    Number.isInteger(selectorValue.threadId) &&
    selectorValue.threadId > 0
      ? selectorValue.threadId
      : undefined;
  const threadName =
    typeof selectorValue.threadName === "string" &&
    selectorValue.threadName.trim()
      ? selectorValue.threadName.trim()
      : undefined;
  if ((threadId === undefined) === (threadName === undefined)) return undefined;
  return {
    kind: "follower.resolveAgentTarget",
    requestId,
    instanceId: value.instanceId,
    ...(typeof value.registrationGeneration === "string"
      ? { registrationGeneration: value.registrationGeneration }
      : {}),
    selector: {
      ...(chatId !== undefined ? { chatId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(threadName !== undefined ? { threadName } : {}),
    },
    sentAtMs: value.sentAtMs,
  };
}

function parseRouteAgentMessageEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const messageValue = isRecord(value.message) ? value.message : undefined;
  const target = parseThreadTarget(messageValue?.target);
  if (
    typeof value.instanceId !== "string" ||
    !messageValue ||
    !target ||
    typeof messageValue.messageId !== "number" ||
    !Number.isInteger(messageValue.messageId) ||
    messageValue.messageId <= 0 ||
    typeof messageValue.text !== "string" ||
    !messageValue.text.trim() ||
    typeof value.sentAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    kind: "follower.routeAgentMessage",
    requestId,
    instanceId: value.instanceId,
    ...(typeof value.registrationGeneration === "string"
      ? { registrationGeneration: value.registrationGeneration }
      : {}),
    message: {
      target,
      messageId: messageValue.messageId,
      text: messageValue.text,
    },
    sentAtMs: value.sentAtMs,
  };
}

const nonempty = (input: unknown, limit = 128): input is string =>
  typeof input === "string" && !!input.trim() && input.length <= limit;
const positive = (input: unknown): input is number =>
  Number.isSafeInteger(input) && (input as number) > 0;
const nonnegative = (input: unknown): input is number =>
  Number.isSafeInteger(input) && (input as number) >= 0;

/** Shared closed text-effect codec; parsing alone supplies no recipient or issuance authority. */
export function parseTelegramBusSelectedMenuTextEffect(
  effect: unknown,
): TelegramBusSelectedMenuTextEffect | undefined {
  if (
    !isRecord(effect) ||
    (effect.kind !== "send-text" && effect.kind !== "edit-text") ||
    !hasOnlyWireKeys(effect, [
      "kind",
      "text",
      "parseMode",
      "replyMarkup",
      ...(effect.kind === "send-text" ? ["replyToMessageId"] : ["messageId"]),
    ]) ||
    !nonempty(effect.text, 4096) ||
    (effect.parseMode !== undefined && effect.parseMode !== "HTML") ||
    (effect.kind === "send-text"
      ? effect.replyToMessageId !== undefined &&
        !positive(effect.replyToMessageId)
      : !positive(effect.messageId))
  )
    return undefined;
  let replyMarkup: TelegramBusSelectedMenuTextEffect["replyMarkup"];
  if (effect.replyMarkup !== undefined) {
    const markup = effect.replyMarkup;
    if (
      !isRecord(markup) ||
      !hasOnlyWireKeys(markup, ["inline_keyboard"]) ||
      !Array.isArray(markup.inline_keyboard) ||
      markup.inline_keyboard.length > 32 ||
      markup.inline_keyboard.some(
        (row) =>
          !Array.isArray(row) ||
          !row.length ||
          row.length > 8 ||
          row.some(
            (button) =>
              !isRecord(button) ||
              !hasOnlyWireKeys(button, ["text", "callback_data"]) ||
              !nonempty(button.text) ||
              !nonempty(button.callback_data, 64) ||
              Buffer.byteLength(button.callback_data, "utf8") > 64,
          ),
      )
    )
      return undefined;
    replyMarkup = {
      inline_keyboard: markup.inline_keyboard.map((row) =>
        (row as { text: string; callback_data: string }[]).map((button) => ({
          text: button.text,
          callback_data: button.callback_data,
        })),
      ),
    };
  }
  const common = {
    text: effect.text,
    ...(effect.parseMode === "HTML" ? { parseMode: "HTML" as const } : {}),
    ...(replyMarkup ? { replyMarkup } : {}),
  };
  return effect.kind === "send-text"
    ? {
        ...common,
        kind: "send-text",
        ...(effect.replyToMessageId !== undefined
          ? { replyToMessageId: effect.replyToMessageId as number }
          : {}),
      }
    : { ...common, kind: "edit-text", messageId: effect.messageId as number };
}

function parseSelectedMenuDeliveryEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusSelectedMenuDelivery | undefined {
  const recipient = value.recipient,
    executor = value.executor,
    effect = parseTelegramBusSelectedMenuTextEffect(value.effect);
  if (
    !hasOnlyWireKeys(value, [
      "kind",
      "requestId",
      "auth",
      "instanceId",
      "registrationGeneration",
      "operationId",
      "recipient",
      "executor",
      "operatorUserId",
      "effect",
      "sentAtMs",
    ]) ||
    !nonempty(requestId) ||
    !nonempty(value.instanceId) ||
    !nonempty(value.registrationGeneration) ||
    !nonempty(value.operationId) ||
    !isRecord(recipient) ||
    !hasOnlyWireKeys(recipient, [
      "sessionId",
      "sessionGeneration",
      "processId",
      "processBirthId",
      "profileKey",
      "journalBindingKey",
      "target",
    ]) ||
    !nonempty(recipient.sessionId) ||
    !nonnegative(recipient.sessionGeneration) ||
    !positive(recipient.processId) ||
    !nonempty(recipient.processBirthId) ||
    !nonempty(recipient.profileKey, 1024) ||
    !nonempty(recipient.journalBindingKey, 8192) ||
    recipient.profileKey === recipient.journalBindingKey ||
    !isRecord(recipient.target) ||
    !hasOnlyWireKeys(recipient.target, ["chatId", "threadId"]) ||
    !positive(recipient.target.chatId) ||
    !positive(recipient.target.threadId) ||
    !positive(value.operatorUserId) ||
    value.operatorUserId !== recipient.target.chatId ||
    !isRecord(executor) ||
    !hasOnlyWireKeys(executor, ["instanceId", "leaderEpoch"]) ||
    !nonempty(executor.instanceId) ||
    !nonempty(executor.leaderEpoch) ||
    !effect ||
    typeof value.sentAtMs !== "number" ||
    !Number.isFinite(value.sentAtMs) ||
    value.sentAtMs < 0 ||
    (value.auth !== undefined && typeof value.auth !== "string")
  )
    return undefined;
  return {
    kind: "follower.deliverSelectedMenu",
    requestId,
    instanceId: value.instanceId,
    registrationGeneration: value.registrationGeneration,
    operationId: value.operationId,
    recipient: {
      sessionId: recipient.sessionId,
      sessionGeneration: recipient.sessionGeneration,
      processId: recipient.processId,
      processBirthId: recipient.processBirthId,
      profileKey: recipient.profileKey,
      journalBindingKey: recipient.journalBindingKey,
      target: {
        chatId: recipient.target.chatId,
        threadId: recipient.target.threadId,
      },
    },
    executor: {
      instanceId: executor.instanceId,
      leaderEpoch: executor.leaderEpoch,
    },
    operatorUserId: value.operatorUserId,
    effect,
    sentAtMs: value.sentAtMs,
  };
}

function parseCallApiEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  return typeof value.instanceId === "string" &&
    (value.apiRegistrationIncarnation === undefined || typeof value.apiRegistrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(value.apiRegistrationIncarnation)) &&
    (value.attachmentRegistrationIncarnation === undefined || typeof value.attachmentRegistrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(value.attachmentRegistrationIncarnation)) &&
    typeof value.method === "string" &&
    Array.isArray(value.args) &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "follower.callApi",
        requestId,
        instanceId: value.instanceId,
        ...(typeof value.registrationGeneration === "string"
          ? { registrationGeneration: value.registrationGeneration }
          : {}),
        ...(typeof value.apiRegistrationIncarnation === "string" ? { apiRegistrationIncarnation: value.apiRegistrationIncarnation } : {}),
        ...(typeof value.attachmentRegistrationIncarnation === "string" ? { attachmentRegistrationIncarnation: value.attachmentRegistrationIncarnation } : {}),
        method: value.method,
        args: value.args,
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseAckEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  if (typeof value.ok !== "boolean") return undefined;
  const envelope: TelegramBusEnvelope = {
    kind: "bus.ack",
    requestId,
    ok: value.ok,
    message: typeof value.message === "string" ? value.message : undefined,
  };
  if (Object.hasOwn(value, "result")) envelope.result = value.result;
  const protocol = parseTelegramBusProtocolIdentity(value.protocol);
  if (protocol) envelope.protocol = protocol;
  if (isRecord(value.error)) {
    const code = value.error.code;
    if (
      code === "commit-unknown" ||
      code === "request-id-collision" ||
      code === "ledger-overloaded" ||
      code === "incompatible-protocol" ||
      code === "stale-target" ||
      code === "follower-api-not-allowed" ||
      code === "workspace-binding-unavailable"
    ) {
      const chatId = value.error.chatId;
      const threadId = value.error.threadId;
      if (
        code === "follower-api-not-allowed" &&
        (value.ok || Object.hasOwn(value, "result") ||
          typeof value.error.method !== "string" ||
          !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.error.method))
      ) return undefined;
      if (
        code === "stale-target" &&
        (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId))
      ) {
        return undefined;
      }
      envelope.error = {
        code,
        ...(typeof value.error.method === "string"
          ? { method: value.error.method }
          : {}),
        ...(typeof chatId === "number" ? { chatId } : {}),
        ...(typeof threadId === "number" ? { threadId } : {}),
      };
    }
  }
  return envelope;
}

function parseTelegramBusProtocolIdentity(
  value: unknown,
): TelegramBusProtocolIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.protocolVersion) ||
    (value.protocolVersion as number) <= 0 ||
    typeof value.runtimeBuild !== "string" ||
    !value.runtimeBuild.trim() ||
    value.runtimeBuild !== value.runtimeBuild.trim() ||
    value.runtimeBuild.length > 128 ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 32 ||
    value.capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        capability.length > 128 ||
        !/^[a-z0-9][a-z0-9._-]*$/u.test(capability),
    )
  ) {
    return undefined;
  }
  const capabilities = value.capabilities as string[];
  if (
    capabilities.some(
      (capability, index) =>
        index > 0 && capability <= capabilities[index - 1]!,
    )
  ) {
    return undefined;
  }
  return {
    protocolVersion: value.protocolVersion as number,
    runtimeBuild: value.runtimeBuild,
    capabilities: [...capabilities],
  };
}

function parseRegistration(
  value: unknown,
): TelegramBusInstanceRegistration | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.instanceId !== "string") return undefined;
  if (typeof value.connectedAtMs !== "number") return undefined;
  const target = parseTarget(value.target);
  if (value.target !== undefined && !target) return undefined;
  const registration: TelegramBusInstanceRegistration = {
    instanceId: value.instanceId,
    connectedAtMs: value.connectedAtMs,
  };
  if (typeof value.previousInstanceId === "string") {
    registration.previousInstanceId = value.previousInstanceId;
  }
  if (typeof value.profileKey === "string")
    registration.profileKey = value.profileKey;
  if (typeof value.threadName === "string")
    registration.threadName = value.threadName;
  if (typeof value.slot === "string" && /^[A-Z]$/.test(value.slot)) {
    registration.slot = value.slot;
  }
  if (typeof value.cwd === "string") registration.cwd = value.cwd;
  if (value.sessionId !== undefined) {
    if (
      typeof value.sessionId !== "string" ||
      !value.sessionId ||
      value.sessionId !== value.sessionId.trim() ||
      Buffer.byteLength(value.sessionId, "utf8") > 256
    )
      return undefined;
    registration.sessionId = value.sessionId;
  }
  if (typeof value.pid === "number") registration.pid = value.pid;
  if (typeof value.busSocketPath === "string") {
    registration.busSocketPath = value.busSocketPath;
  }
  if (typeof value.registrationGeneration === "string") {
    registration.registrationGeneration = value.registrationGeneration;
  }
  if (
    Number.isSafeInteger(value.sessionGeneration) &&
    (value.sessionGeneration as number) > 0
  ) {
    registration.sessionGeneration = value.sessionGeneration as number;
  }
  if (typeof value.processBirthId === "string" && value.processBirthId) {
    registration.processBirthId = value.processBirthId;
  }
  const protocol = parseTelegramBusProtocolIdentity(value.protocol);
  if (protocol) registration.protocol = protocol;
  if (target) registration.target = target;
  return registration;
}

function parseThreadTarget(
  value: unknown,
): (TelegramTarget & { threadId: number }) | undefined {
  const target = parseTarget(value);
  return target && typeof target.threadId === "number"
    ? { chatId: target.chatId, threadId: target.threadId }
    : undefined;
}
