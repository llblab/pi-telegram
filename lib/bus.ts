/**
 * Telegram multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { createRequire } from "node:module";
import { platform as getPlatform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  classifyTelegramBusTransportError,
  createTelegramBusTransportTimeoutError,
  delayTelegramBusTransportRetry,
  getTelegramBusEndpointDiagnostics,
  getTelegramBusFollowerEndpoint,
  getTelegramBusLeaderEndpoint,
  getTelegramBusPipePath,
  getTelegramBusTransportRetryPolicy,
  isTelegramBusPipePath,
  isRetryableTelegramBusTransportError,
  probeTelegramBusEndpoint,
  type TelegramBusTransportEventRecorder,
  type TelegramBusTransportRetryPolicy,
} from "./bus-transport.ts";
import {
  TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS,
  TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES,
  type TelegramQueueHandoffPayload,
} from "./queue.ts";
import type { TelegramTarget } from "./target.ts";
import { isProcessAlive } from "./locks.ts";
import { resolveAgentDir } from "./paths.ts";

export interface TelegramBusProcessRuntime {
  instanceId: string;
  processId: number;
  processBirthId: string;
  manualFollowerOwnerId: string;
  getLeaderSocketPath: () => string;
  getFollowerSocketPath: () => string;
}

export interface TelegramProcessBirthIdentityOptions {
  platform?: NodeJS.Platform;
  readProcStat?: (pid: number) => string;
  readDarwinProcessStart?: (pid: number) => string;
}

export type TelegramProcessBirthProof =
  | { status: "proven"; identity: string }
  | { status: "unverifiable" };

export type TelegramProcessLiveness = "alive" | "dead" | "unverifiable";

export interface TelegramProcessLivenessOptions
  extends TelegramProcessBirthIdentityOptions {
  isProcessAlive?: (pid: number) => boolean;
}

function readDarwinProcessStart(pid: number): string {
  return execFileSync(
    "/bin/ps",
    ["-o", "lstart=", "-p", String(pid)],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

export function getTelegramProcessBirthProof(
  pid: number,
  options: TelegramProcessBirthIdentityOptions = {},
): TelegramProcessBirthProof {
  if (pid <= 0) return { status: "unverifiable" };
  const platform = options.platform ?? getPlatform();
  if (platform === "linux") {
    try {
      const stat = (options.readProcStat ?? ((targetPid) =>
        readFileSync(`/proc/${targetPid}/stat`, "utf8")))(pid);
      const closeParen = stat.lastIndexOf(")");
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      if (startTicks) {
        return { status: "proven", identity: `${pid}:start:${startTicks}` };
      }
    } catch {
      /* inaccessible process metadata */
    }
  } else if (platform === "darwin") {
    try {
      const startedAt = (
        options.readDarwinProcessStart ?? readDarwinProcessStart
      )(pid);
      if (startedAt) {
        const fingerprint = createHash("sha256")
          .update(startedAt)
          .digest("hex")
          .slice(0, 16);
        return { status: "proven", identity: `${pid}:start:${fingerprint}` };
      }
    } catch {
      /* inaccessible process metadata */
    }
  }
  return { status: "unverifiable" };
}

export function getTelegramProcessBirthIdentity(
  pid: number,
  fallbackGeneration: number | string,
  options: TelegramProcessBirthIdentityOptions = {},
): string {
  const proof = getTelegramProcessBirthProof(pid, options);
  return proof.status === "proven"
    ? proof.identity
    : `${pid}:generation:${fallbackGeneration}`;
}

export function getTelegramProcessLiveness(
  owner: { processId: number; processBirthId: string },
  options: TelegramProcessLivenessOptions = {},
): TelegramProcessLiveness {
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  if (!processAlive(owner.processId)) return "dead";
  const proof = getTelegramProcessBirthProof(owner.processId, options);
  if (proof.status === "unverifiable") return "unverifiable";
  return proof.identity === owner.processBirthId ? "alive" : "dead";
}

export function createCurrentTelegramBusProcessRuntime(input: {
  getActiveProfileName: () => string | undefined;
  pid?: number;
  parentPid?: number;
  createdAtMs?: number;
}): TelegramBusProcessRuntime {
  return createTelegramBusProcessRuntime({
    getActiveProfileName: input.getActiveProfileName,
    pid: input.pid ?? process.pid,
    parentPid: input.parentPid ?? process.ppid,
    createdAtMs: input.createdAtMs ?? Date.now(),
  });
}

export function createTelegramBusProcessRuntime(input: {
  getActiveProfileName: () => string | undefined;
  pid: number;
  parentPid: number;
  parentProcessIdentity?: string;
  createdAtMs: number;
}): TelegramBusProcessRuntime {
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
        input.getActiveProfileName(),
      ),
    getFollowerSocketPath: () =>
      getTelegramBusFollowerSocketPath(
        instanceId,
        undefined,
        undefined,
        input.getActiveProfileName(),
      ),
  };
}

export function createTelegramBusAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

export const TELEGRAM_BUS_PROTOCOL_VERSION = 1 as const;
export const TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION =
  "durable-follower-admission-v1" as const;
export const TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF =
  "queue-handoff-v1" as const;

export interface TelegramBusProtocolIdentity {
  protocolVersion: number;
  runtimeBuild: string;
  capabilities: string[];
}

export interface TelegramBusProtocolCompatibility {
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
        capability.length > 128 ||
        !/^[a-z0-9][a-z0-9._-]*$/u.test(capability),
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
): string {
  return getTelegramBusLeaderEndpoint({ agentDir, platform, profileName });
}

export function getTelegramBusFollowerSocketPath(
  instanceId: string,
  agentDir = resolveAgentDir(),
  platform = getPlatform(),
  profileName?: string,
): string {
  return getTelegramBusFollowerEndpoint({
    agentDir,
    platform,
    instanceId,
    profileName,
  });
}

export interface TelegramBusInstanceRegistration {
  instanceId: string;
  previousInstanceId?: string;
  profileKey?: string;
  threadName?: string;
  slot?: string;
  cwd?: string;
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
  lastHeartbeatMs: number;
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
}): {
  instanceId: string;
  ownerGeneration: string;
  recipientBindingKey: string;
} | undefined {
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
    };
  }
  // Persisted records are restart hints, not live routing authority. Only an
  // authenticated current follower registration may receive forwarded work.
  return undefined;
}

const TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD = "__piTelegramAggregateDelivery";
const TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD =
  "__piTelegramCrossTargetDelivery";

export function markTelegramBusAggregateDelivery<
  T extends Record<string, unknown>,
>(body: T): T {
  return {
    ...body,
    [TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD]: true,
  };
}

export function isTelegramBusAggregateDelivery(body: unknown): boolean {
  return Boolean(
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>)[TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD] ===
      true,
  );
}

export function markTelegramBusCrossTargetDelivery<
  T extends Record<string, unknown>,
>(body: T): T {
  return {
    ...body,
    [TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD]: true,
  };
}

export function isTelegramBusCrossTargetDelivery(body: unknown): boolean {
  return Boolean(
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>)[
      TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD
    ] === true,
  );
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
      (target.threadId === undefined ||
        !matchesId(threadId, target.threadId))
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
      return isTargetChatScoped(input.args[1]);
    if (
      apiMethod === "sendMessage" &&
      isTelegramBusAggregateDelivery(input.args[1])
    ) {
      const body = input.args[1] as Record<string, unknown>;
      return body.message_thread_id === undefined && isTargetChatScoped(body);
    }
    if (
      (apiMethod === "sendMessage" || apiMethod === "sendRichMessage") &&
      isTelegramBusCrossTargetDelivery(input.args[1])
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

export interface TelegramFollowerApiCallAuthorizationInput {
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
}

export type TelegramBusForeignUpdateFailureClass =
  | "source-update-identity-missing"
  | "recipient-binding-missing"
  | "recipient-generation-missing"
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
    | "leader.forwardEditedMessage";
  recipientBindingKey: string;
  sourceUpdateId: number;
}): TelegramBusFollowerDeliveryIdentity {
  if (
    !input.recipientBindingKey ||
    !Number.isSafeInteger(input.sourceUpdateId) ||
    input.sourceUpdateId < 0
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
  };
}

export type TelegramBusEnvelope = (
  | {
      kind: "follower.register";
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
      kind: "leader.replaceFollowerTarget";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration?: string;
      target: TelegramTarget & { threadId: number };
      oldTarget?: TelegramTarget & { threadId: number };
      reason: "thread-restore";
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
  | {
      kind: "follower.callApi";
      requestId: string;
      instanceId: string;
      registrationGeneration?: string;
      method: string;
      args: unknown[];
      sentAtMs: number;
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
          | "stale-target";
        method?: string;
        chatId?: number;
        threadId?: number;
      };
    }
) & { auth?: string };

export type TelegramBusEnvelopeTrafficClass =
  | "bootstrap"
  | "generation-fenced"
  | "response";

export function getTelegramBusEnvelopeTrafficClass(
  envelope: TelegramBusEnvelope,
): TelegramBusEnvelopeTrafficClass {
  if (envelope.kind === "follower.register") return "bootstrap";
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
      envelope = parseRegisterEnvelope(value, requestId);
      break;
    case "follower.heartbeat":
      envelope = parseHeartbeatEnvelope(value, requestId);
      break;
    case "follower.disconnect":
      envelope = parseDisconnectEnvelope(value, requestId);
      break;
    case "leader.forwardCallback":
      envelope = parseForwardCallbackEnvelope(value, requestId);
      break;
    case "leader.forwardReaction":
      envelope = parseForwardReactionEnvelope(value, requestId);
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
    case "leader.replaceFollowerTarget":
      envelope = parseReplaceFollowerTargetEnvelope(value, requestId);
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
    case "follower.callApi":
      envelope = parseCallApiEnvelope(value, requestId);
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

export interface TelegramBusLocalServer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  ensureEndpoint: () => Promise<boolean>;
}

const TELEGRAM_ACTIVE_LOCAL_SERVERS = Symbol.for(
  "@llblab/pi-telegram/active-local-servers",
);
type TelegramBusServerGlobal = typeof globalThis & {
  [TELEGRAM_ACTIVE_LOCAL_SERVERS]?: Map<string, TelegramBusLocalServer>;
};

function getActiveTelegramBusLocalServers(): Map<string, TelegramBusLocalServer> {
  const root = globalThis as TelegramBusServerGlobal;
  return (root[TELEGRAM_ACTIVE_LOCAL_SERVERS] ??= new Map());
}

export type TelegramBusSocketPathSource = string | (() => string);

const TELEGRAM_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES = 80;

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

export interface TelegramBusLocalServerDeps {
  socketPath: TelegramBusSocketPathSource;
  handleEnvelope: (
    envelope: TelegramBusEnvelope,
  ) =>
    Promise<TelegramBusEnvelope | undefined> | TelegramBusEnvelope | undefined;
  recordTransportEvent?: TelegramBusTransportEventRecorder;
  beforeEndpointPublication?: () => Promise<void> | void;
  commitEndpointPublication?: (commit: () => void) => boolean;
  requestLedgerMaxEntries?: number;
  shouldDropResponse?: (
    request: TelegramBusEnvelope,
    response: TelegramBusEnvelope,
  ) => boolean;
}

export interface TelegramBusLocalClientOptions {
  socketPath: string;
  envelope: TelegramBusEnvelope;
  timeoutMs?: number;
  retry?: TelegramBusTransportRetryPolicy;
  recordTransportEvent?: TelegramBusTransportEventRecorder;
}

export interface TelegramBusForeignOwnedForwarderDeps<TMessage = unknown> {
  socketPath: TelegramBusSocketPathSource;
  createRequestId: () => string;
  getNowMs?: () => number;
  timeoutMs?: number;
  getAuthSecret?: () => string | undefined;
  getForwardCommentBatchPosition?: (
    message: TMessage,
  ) => "comment" | "forward" | undefined;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

interface TelegramBusForwardOwnership {
  instanceId: string;
  ownerGeneration?: string;
  recipientBindingKey?: string;
}

type TelegramBusDurableForwardEnvelope = Extract<
  TelegramBusEnvelope,
  {
    kind:
      | "leader.forwardCallback"
      | "leader.forwardReaction"
      | "leader.forwardMessage"
      | "leader.forwardEditedMessage";
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
      sourceUpdateId:
        input.delivery?.sourceUpdateId ?? input.sourceUpdateId,
    });
    return settlement;
  };
  const prepare = (
    kind: TelegramBusDurableForwardEnvelope["kind"],
    value: unknown,
    ownership: TelegramBusForwardOwnership,
  ):
    | {
        delivery: TelegramBusFollowerDeliveryIdentity;
        recipientRegistrationGeneration: string;
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
    const delivery = createTelegramBusForwardDelivery(
      kind,
      sourceUpdateId,
      ownership.recipientBindingKey,
    );
    if (!ownership.ownerGeneration) {
      return {
        settlement: reject({
          status: "retryable",
          failureClass: "recipient-generation-missing",
          message: "Forwarded Telegram update has no live recipient generation.",
          envelopeKind: kind,
          ownership,
          delivery,
        }),
      };
    }
    return {
      delivery,
      recipientRegistrationGeneration: ownership.ownerGeneration,
    };
  };
  const send = async (
    envelope: TelegramBusDurableForwardEnvelope,
    ownership: TelegramBusForwardOwnership,
  ): Promise<TelegramBusForeignUpdateSettlement> => {
    if (deps.getAuthSecret) envelope.auth = deps.getAuthSecret();
    const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
    let response: TelegramBusEnvelope | undefined;
    try {
      response = await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope,
        timeoutMs: deps.timeoutMs,
        retry: getTelegramBusTransportRetryPolicy({
          endpoint: socketPath,
          operation: "operation",
        }),
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
        message: "Follower acknowledgement returned a mismatched durable receipt.",
        envelopeKind: envelope.kind,
        ownership,
        delivery: envelope.delivery,
      });
    }
    return { status: "accepted", delivery: envelope.delivery };
  };
  return {
    forwardCallback: ({ query, ownership }) => {
      const prepared = prepare("leader.forwardCallback", query, ownership);
      if ("settlement" in prepared) return Promise.resolve(prepared.settlement);
      return send(
        {
          kind: "leader.forwardCallback",
          requestId: deps.createRequestId(),
          recipientInstanceId: ownership.instanceId,
          recipientRegistrationGeneration:
            prepared.recipientRegistrationGeneration,
          delivery: prepared.delivery,
          query,
          sentAtMs: getNowMs(),
        },
        ownership,
      );
    },
    forwardReaction: ({ reactionUpdate, ownership }) => {
      const prepared = prepare(
        "leader.forwardReaction",
        reactionUpdate,
        ownership,
      );
      if ("settlement" in prepared) return Promise.resolve(prepared.settlement);
      return send(
        {
          kind: "leader.forwardReaction",
          requestId: deps.createRequestId(),
          recipientInstanceId: ownership.instanceId,
          recipientRegistrationGeneration:
            prepared.recipientRegistrationGeneration,
          delivery: prepared.delivery,
          reactionUpdate,
          sentAtMs: getNowMs(),
        },
        ownership,
      );
    },
    forwardMessage: ({ message, ownership }) => {
      const prepared = prepare("leader.forwardMessage", message, ownership);
      if ("settlement" in prepared) return Promise.resolve(prepared.settlement);
      return send(
        {
          kind: "leader.forwardMessage",
          requestId: deps.createRequestId(),
          recipientInstanceId: ownership.instanceId,
          recipientRegistrationGeneration:
            prepared.recipientRegistrationGeneration,
          delivery: prepared.delivery,
          message,
          ...(deps.getForwardCommentBatchPosition?.(message) !== undefined
            ? {
                forwardCommentBatchPosition:
                  deps.getForwardCommentBatchPosition(message),
              }
            : {}),
          sentAtMs: getNowMs(),
        },
        ownership,
      );
    },
    forwardEditedMessage: ({ message, ownership }) => {
      const prepared = prepare(
        "leader.forwardEditedMessage",
        message,
        ownership,
      );
      if ("settlement" in prepared) return Promise.resolve(prepared.settlement);
      return send(
        {
          kind: "leader.forwardEditedMessage",
          requestId: deps.createRequestId(),
          recipientInstanceId: ownership.instanceId,
          recipientRegistrationGeneration:
            prepared.recipientRegistrationGeneration,
          delivery: prepared.delivery,
          message,
          sentAtMs: getNowMs(),
        },
        ownership,
      );
    },
  };
}

export interface TelegramBusFollowerThreadRestoreHandlerDeps {
  followerRegistry: Pick<TelegramBusFollowerRegistry, "get" | "register">;
  followerTargetController: ReturnType<
    typeof createTelegramBusFollowerTargetController
  >;
  onRestored?: () => void;
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

export function createTelegramBusFollowerTargetController(
  deps: TelegramBusForeignOwnedForwarderDeps,
): {
  replaceTarget: (input: {
    follower: TelegramBusFollowerView;
    target: TelegramTarget & { threadId: number };
    oldTarget?: TelegramTarget & { threadId: number };
    reason: "thread-restore";
  }) => Promise<boolean>;
} {
  const getNowMs = deps.getNowMs ?? Date.now;
  return {
    async replaceTarget({ follower, target, oldTarget, reason }) {
      if (!follower.busSocketPath || !follower.registrationGeneration) {
        return false;
      }
      const envelope: TelegramBusEnvelope = {
        kind: "leader.replaceFollowerTarget",
        requestId: deps.createRequestId(),
        recipientInstanceId: follower.instanceId,
        recipientRegistrationGeneration: follower.registrationGeneration,
        target,
        ...(oldTarget ? { oldTarget } : {}),
        reason,
        sentAtMs: getNowMs(),
      };
      if (deps.getAuthSecret) envelope.auth = deps.getAuthSecret();
      const response = await sendTelegramBusLocalEnvelope({
        socketPath: follower.busSocketPath,
        envelope,
        timeoutMs: deps.timeoutMs,
        retry: getTelegramBusTransportRetryPolicy({
          endpoint: follower.busSocketPath,
          operation: "operation",
        }),
      });
      return response?.kind === "bus.ack" && response.ok;
    },
  };
}

export function createTelegramBusFollowerThreadRestoreHandler(
  deps: TelegramBusFollowerThreadRestoreHandlerDeps,
): (input: {
  record: { instanceId?: string };
  target: TelegramTarget & { threadId: number };
  oldTarget?: TelegramTarget & { threadId: number };
}) => Promise<boolean> {
  return async ({ record, target, oldTarget }) => {
    if (!record.instanceId) return false;
    const follower = deps.followerRegistry.get(record.instanceId);
    if (!follower) return false;
    const replaced = await deps.followerTargetController.replaceTarget({
      follower,
      target,
      oldTarget,
      reason: "thread-restore",
    });
    if (!replaced) return false;
    deps.followerRegistry.register({
      ...follower,
      target,
      connectedAtMs: follower.connectedAtMs,
    });
    deps.onRestored?.();
    return true;
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

export function createUnauthorizedBusAck(
  requestId: string,
): TelegramBusEnvelope {
  return {
    kind: "bus.ack",
    requestId,
    ok: false,
    message: "Unauthorized Telegram bus envelope.",
  };
}

export function createTelegramBusLocalServer(
  deps: TelegramBusLocalServerDeps,
): TelegramBusLocalServer {
  type LedgerEntry = {
    fingerprint: string;
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
      envelope.kind === "follower.register"
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
    const key = getRequestLedgerKey(envelope);
    const fingerprint = JSON.stringify(envelope);
    const existing = requestLedger.get(key);
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing.result;
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
      settled: false,
      result: Promise.resolve().then(() => deps.handleEnvelope(envelope)),
    };
    requestLedger.set(key, entry);
    void entry.result.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    return entry.result;
  };
  let server: Server | undefined;
  let activeSocketPath: string | undefined;
  let activeListenPath: string | undefined;
  let endpointRecovery: Promise<boolean> | undefined;
  let stopGeneration = 0;
  const sockets = new Set<Socket>();
  const closeSocket = (socket: Socket) => {
    sockets.delete(socket);
    socket.destroy();
  };
  const runtime: TelegramBusLocalServer = {
    start: async () => {
      if (server) return;
      const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
      const activeServers = getActiveTelegramBusLocalServers();
      const replacedServer = activeServers.get(socketPath);
      if (replacedServer && replacedServer !== runtime) {
        await replacedServer.stop();
      }
      const usesWindowsPipe = isTelegramBusPipePath(socketPath);
      const endpointGeneration = randomBytes(8).toString("hex");
      const listenPath = usesWindowsPipe
        ? socketPath
        : join(dirname(socketPath), `.pt-${endpointGeneration}.sock`);
      activeSocketPath = socketPath;
      activeListenPath = listenPath;
      deps.recordTransportEvent?.(
        "server-start",
        getTelegramBusEndpointDiagnostics(socketPath),
      );
      if (!usesWindowsPipe) {
        const socketDir = dirname(socketPath);
        mkdirSync(socketDir, { recursive: true, mode: 0o700 });
        chmodSync(socketDir, 0o700);
        if (existsSync(listenPath)) unlinkSync(listenPath);
        const legacyDeadlineMs = Date.now() + 2000;
        while (true) {
          let isLegacySocket = false;
          try {
            isLegacySocket = lstatSync(socketPath).isSocket();
          } catch {
            /* endpoint does not exist */
          }
          if (!isLegacySocket) break;
          const probe = await probeTelegramBusEndpoint({
            endpoint: socketPath,
            timeoutMs: 50,
          });
          if (!probe.reachable) break;
          if (Date.now() >= legacyDeadlineMs) {
            throw new Error(
              `Timed out waiting for legacy Telegram bus endpoint: ${socketPath}`,
            );
          }
          await delayTelegramBusTransportRetry(25);
        }
      }
      if (usesWindowsPipe) {
        await deps.beforeEndpointPublication?.();
        const committed = deps.commitEndpointPublication
          ? deps.commitEndpointPublication(() => {})
          : true;
        if (!committed) {
          activeSocketPath = undefined;
          activeListenPath = undefined;
          throw new Error(
            "Telegram bus endpoint publication lost transport ownership.",
          );
        }
      }
      server = createServer((socket) => {
        sockets.add(socket);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            void handleTelegramBusSocketLine(
              line,
              socket,
              handleEnvelopeOnce,
              deps.recordTransportEvent,
              socketPath,
              deps.shouldDropResponse,
            );
          }
        });
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", (error) => {
          deps.recordTransportEvent?.("server-socket-error", {
            ...getTelegramBusEndpointDiagnostics(socketPath),
            ...classifyTelegramBusTransportError(error),
          });
          closeSocket(socket);
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server?.once("error", reject);
          server?.listen(listenPath, resolve);
        });
        activeServers.set(socketPath, runtime);
        deps.recordTransportEvent?.(
          "server-started",
          getTelegramBusEndpointDiagnostics(socketPath),
        );
      } catch (error) {
        server = undefined;
        activeSocketPath = undefined;
        activeListenPath = undefined;
        deps.recordTransportEvent?.("server-start-failed", {
          ...getTelegramBusEndpointDiagnostics(socketPath),
          ...classifyTelegramBusTransportError(error),
        });
        throw error;
      }
      if (!usesWindowsPipe) {
        chmodSync(listenPath, 0o600);
        const linkPath = `${socketPath}.link.${endpointGeneration}`;
        try {
          symlinkSync(basename(listenPath), linkPath);
          await deps.beforeEndpointPublication?.();
          const committed = deps.commitEndpointPublication
            ? deps.commitEndpointPublication(() =>
                renameSync(linkPath, socketPath),
              )
            : (renameSync(linkPath, socketPath), true);
          if (!committed) {
            throw new Error(
              "Telegram bus endpoint publication lost transport ownership.",
            );
          }
        } catch (error) {
          try {
            if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
          } catch {
            /* no unpublished link to remove */
          }
          const failedServer = server;
          server = undefined;
          activeSocketPath = undefined;
          activeListenPath = undefined;
          if (activeServers.get(socketPath) === runtime) {
            activeServers.delete(socketPath);
          }
          if (failedServer) {
            await new Promise<void>((resolve) =>
              failedServer.close(() => resolve()),
            );
          }
          throw error;
        }
      }
    },
    stop: async () => {
      stopGeneration += 1;
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

function sendTelegramBusLocalEnvelopeOnce(
  options: TelegramBusLocalClientOptions,
): Promise<TelegramBusEnvelope | undefined> {
  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let settled = false;
    let buffer = "";
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      callback();
    };
    const timeout = setTimeout(() => {
      settle(() =>
        reject(
          createTelegramBusTransportTimeoutError(
            "Timed out waiting for Telegram bus response",
          ),
        ),
      );
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(encodeTelegramBusEnvelope(options.envelope));
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex);
      settle(() => resolve(parseTelegramBusEnvelope(line)));
    });
    socket.once("error", (error) => settle(() => reject(error)));
    socket.once("end", () => settle(() => resolve(undefined)));
  });
}

export async function sendTelegramBusLocalEnvelope(
  options: TelegramBusLocalClientOptions,
): Promise<TelegramBusEnvelope | undefined> {
  const resolvedOptions = {
    ...options,
    socketPath: resolveTelegramBusSocketPath(options.socketPath),
  };
  const attempts = Math.max(1, resolvedOptions.retry?.attempts ?? 1);
  const delayMs = Math.max(0, resolvedOptions.retry?.delayMs ?? 0);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sendTelegramBusLocalEnvelopeOnce(resolvedOptions);
    } catch (error) {
      const info = classifyTelegramBusTransportError(error);
      resolvedOptions.recordTransportEvent?.("client-failed", {
        ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
        ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
        attempt,
        attempts,
        ...info,
      });
      if (attempt >= attempts || !isRetryableTelegramBusTransportError(error)) {
        throw error;
      }
      resolvedOptions.recordTransportEvent?.("client-retry", {
        ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
        ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
        attempt,
        attempts,
        delayMs,
        ...info,
      });
      await delayTelegramBusTransportRetry(delayMs);
    }
  }
}

export interface TelegramBusFollowerRegistry {
  register: (
    registration: TelegramBusInstanceRegistration,
  ) => TelegramBusFollowerView;
  heartbeat: (
    instanceId: string,
    nowMs: number,
  ) => TelegramBusFollowerView | undefined;
  get: (instanceId: string) => TelegramBusFollowerView | undefined;
  getByTarget: (target: TelegramTarget) => TelegramBusFollowerView | undefined;
  list: () => TelegramBusFollowerView[];
  remove: (instanceId: string) => boolean;
  clear: () => void;
  pruneStale: (
    nowMs: number,
    staleAfterMs: number,
  ) => TelegramBusFollowerView[];
}

export function createTelegramBusFollowerRegistry(): TelegramBusFollowerRegistry {
  const followers = new Map<string, TelegramBusFollowerView>();
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
  return {
    register: (registration) => {
      const existing = followers.get(registration.instanceId);
      for (const [instanceId, follower] of followers.entries()) {
        if (instanceId === registration.instanceId) continue;
        const sameProfile =
          registration.profileKey !== undefined &&
          registration.profileKey === follower.profileKey;
        const sameTarget =
          registration.target !== undefined &&
          follower.target?.chatId === registration.target.chatId &&
          follower.target.threadId === registration.target.threadId;
        if (sameProfile || sameTarget) followers.delete(instanceId);
      }
      const next: TelegramBusFollowerView = {
        ...registration,
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
    remove: (instanceId) => followers.delete(instanceId),
    clear: () => followers.clear(),
    pruneStale: (nowMs, staleAfterMs) => {
      const removed: TelegramBusFollowerView[] = [];
      for (const [instanceId, follower] of followers.entries()) {
        if (nowMs - follower.lastHeartbeatMs <= staleAfterMs) continue;
        followers.delete(instanceId);
        removed.push(clone(follower));
      }
      return removed;
    },
  };
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
      encodeTelegramBusEnvelope({
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: false,
        message: "Telegram bus handler failed.",
      }),
    );
  }
}

function parseRegisterEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const registration = parseRegistration(value.registration);
  return registration
    ? { kind: "follower.register", requestId, registration }
    : undefined;
}

function parseHeartbeatEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  return typeof value.instanceId === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "follower.heartbeat",
        requestId,
        instanceId: value.instanceId,
        ...(typeof value.registrationGeneration === "string"
          ? { registrationGeneration: value.registrationGeneration }
          : {}),
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseDisconnectEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  return typeof value.instanceId === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "follower.disconnect",
        requestId,
        instanceId: value.instanceId,
        ...(typeof value.registrationGeneration === "string"
          ? { registrationGeneration: value.registrationGeneration }
          : {}),
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
    !value.recipientBindingKey
  ) {
    return undefined;
  }
  return {
    deliveryId: value.deliveryId,
    sourceUpdateId: value.sourceUpdateId as number,
    recipientBindingKey: value.recipientBindingKey,
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

function parseReplaceFollowerTargetEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  const target = parseThreadTarget(value.target);
  const oldTarget = parseThreadTarget(value.oldTarget);
  if (
    typeof value.recipientInstanceId !== "string" ||
    !target ||
    (value.oldTarget !== undefined && !oldTarget) ||
    value.reason !== "thread-restore" ||
    typeof value.sentAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    kind: "leader.replaceFollowerTarget",
    requestId,
    recipientInstanceId: value.recipientInstanceId,
    ...(typeof value.recipientRegistrationGeneration === "string"
      ? {
          recipientRegistrationGeneration:
            value.recipientRegistrationGeneration,
        }
      : {}),
    target,
    ...(oldTarget ? { oldTarget } : {}),
    reason: value.reason,
    sentAtMs: value.sentAtMs,
  };
}

function parseQueueAdmissionReceipt(
  value: unknown,
  queueKind: "prompt" | "control",
):
  | {
      queueKind: "prompt" | "control";
      receiptId: string;
      sourceUpdateIds: number[];
    }
  | undefined {
  if (!isRecord(value) || value.queueKind !== queueKind) return undefined;
  const sourceUpdateIds = Array.isArray(value.sourceUpdateIds)
    ? value.sourceUpdateIds
    : undefined;
  if (
    typeof value.receiptId !== "string" ||
    !value.receiptId ||
    (value.journalBindingKey !== undefined &&
      (typeof value.journalBindingKey !== "string" ||
        !value.journalBindingKey.trim())) ||
    !sourceUpdateIds ||
    sourceUpdateIds.length === 0 ||
    sourceUpdateIds.some(
      (updateId, index) =>
        !Number.isSafeInteger(updateId) ||
        (updateId as number) < 0 ||
        (index > 0 &&
          (updateId as number) <=
            (sourceUpdateIds[index - 1] as number)),
    )
  ) {
    return undefined;
  }
  return {
    queueKind,
    receiptId: value.receiptId,
    sourceUpdateIds: sourceUpdateIds as number[],
    ...(typeof value.journalBindingKey === "string"
      ? { journalBindingKey: value.journalBindingKey }
      : {}),
  };
}

function parseQueueHandoffPayload(
  value: unknown,
): TelegramQueueHandoffPayload | undefined {
  if (!isRecord(value) || (value.kind !== "prompt" && value.kind !== "control")) {
    return undefined;
  }
  const queueKind = value.kind;
  const target = parseTarget(value.target);
  const transportStamp = isRecord(value.transportStamp) &&
      typeof value.transportStamp.profile === "string" &&
      typeof value.transportStamp.generation === "string"
    ? {
        profile: value.transportStamp.profile,
        generation: value.transportStamp.generation,
      }
    : undefined;
  if (
    !Number.isSafeInteger(value.chatId) ||
    (value.target !== undefined && !target) ||
    (value.transportStamp !== undefined && !transportStamp) ||
    !Number.isSafeInteger(value.replyToMessageId) ||
    (value.guestQueryId !== undefined &&
      typeof value.guestQueryId !== "string") ||
    !Number.isSafeInteger(value.queueOrder) ||
    (value.queueLane !== "control" &&
      value.queueLane !== "priority" &&
      value.queueLane !== "default") ||
    !Number.isSafeInteger(value.laneOrder) ||
    typeof value.statusSummary !== "string" ||
    !Array.isArray(value.admissionReceipts)
  ) {
    return undefined;
  }
  const admissionReceipts = value.admissionReceipts.map((receipt) =>
    parseQueueAdmissionReceipt(receipt, queueKind),
  );
  if (
    admissionReceipts.length === 0 ||
    admissionReceipts.length > TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS ||
    admissionReceipts.some((receipt) => receipt === undefined)
  ) {
    return undefined;
  }
  const queueLane = value.queueLane as "control" | "priority" | "default";
  const base = {
    chatId: value.chatId as number,
    ...(target ? { target } : {}),
    ...(transportStamp ? { transportStamp } : {}),
    replyToMessageId: value.replyToMessageId as number,
    ...(typeof value.guestQueryId === "string"
      ? { guestQueryId: value.guestQueryId }
      : {}),
    queueOrder: value.queueOrder as number,
    queueLane,
    laneOrder: value.laneOrder as number,
    statusSummary: value.statusSummary,
    admissionReceipts: admissionReceipts as NonNullable<
      (typeof admissionReceipts)[number]
    >[],
  };
  if (queueKind === "control") {
    if (
      value.queueLane !== "control" ||
      (value.controlType !== "status" && value.controlType !== "model")
    ) {
      return undefined;
    }
    return { kind: "control", controlType: value.controlType, ...base };
  }
  if (
    value.queueLane === "control" ||
    !Array.isArray(value.sourceMessageIds) ||
    value.sourceMessageIds.some((id) => !Number.isSafeInteger(id)) ||
    !Array.isArray(value.queuedAttachments) ||
    value.queuedAttachments.some(
      (attachment) =>
        !isRecord(attachment) ||
        typeof attachment.path !== "string" ||
        typeof attachment.fileName !== "string",
    ) ||
    !Array.isArray(value.content) ||
    value.content.some(
      (content) =>
        !isRecord(content) ||
        (content.type === "text"
          ? typeof content.text !== "string"
          : content.type === "image"
            ? typeof content.data !== "string" ||
              typeof content.mimeType !== "string"
            : true),
    ) ||
    typeof value.historyText !== "string" ||
    (value.priorityEmoji !== undefined &&
      typeof value.priorityEmoji !== "string") ||
    (value.reactionSuppressionEmoji !== undefined &&
      typeof value.reactionSuppressionEmoji !== "string") ||
    (value.voiceReplyPreferred !== undefined &&
      typeof value.voiceReplyPreferred !== "boolean") ||
    (value.voiceReplyRequired !== undefined &&
      typeof value.voiceReplyRequired !== "boolean")
  ) {
    return undefined;
  }
  return {
    kind: "prompt",
    ...base,
    sourceMessageIds: value.sourceMessageIds as number[],
    queuedAttachments: value.queuedAttachments as Array<{
      path: string;
      fileName: string;
    }>,
    content: value.content as Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >,
    historyText: value.historyText,
    ...(typeof value.priorityEmoji === "string"
      ? { priorityEmoji: value.priorityEmoji }
      : {}),
    ...(typeof value.reactionSuppressionEmoji === "string"
      ? { reactionSuppressionEmoji: value.reactionSuppressionEmoji }
      : {}),
    ...(typeof value.voiceReplyPreferred === "boolean"
      ? { voiceReplyPreferred: value.voiceReplyPreferred }
      : {}),
    ...(typeof value.voiceReplyRequired === "boolean"
      ? { voiceReplyRequired: value.voiceReplyRequired }
      : {}),
  };
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
  const payload = parseQueueHandoffPayload(value.payload);
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

function parseCallApiEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  return typeof value.instanceId === "string" &&
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
      code === "stale-target"
    ) {
      const chatId = value.error.chatId;
      const threadId = value.error.threadId;
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

function parseTarget(value: unknown): TelegramTarget | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.chatId !== "number") return undefined;
  return typeof value.threadId === "number"
    ? { chatId: value.chatId, threadId: value.threadId }
    : { chatId: value.chatId };
}

function parseThreadTarget(
  value: unknown,
): (TelegramTarget & { threadId: number }) | undefined {
  const target = parseTarget(value);
  return target && typeof target.threadId === "number"
    ? { chatId: target.chatId, threadId: target.threadId }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
