/**
 * Telegram multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */

import { randomBytes } from "node:crypto";
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
import { platform as getPlatform } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  classifyTelegramBusTransportError,
  createTelegramBusTransportTimeoutError,
  delayTelegramBusTransportRetry,
  getTelegramBusEndpointDiagnostics,
  getTelegramBusFollowerEndpoint,
  getTelegramBusLeaderEndpoint,
  getTelegramBusTransportRetryPolicy,
  isTelegramBusPipePath,
  isRetryableTelegramBusTransportError,
  probeTelegramBusEndpoint,
  type TelegramBusTransportEventRecorder,
  type TelegramBusTransportRetryPolicy,
} from "./bus-transport.ts";
import type { TelegramTarget } from "./target.ts";
import { resolveAgentDir } from "./paths.ts";

export type TelegramBusRole = "leader" | "follower";

export interface TelegramBusProcessRuntime {
  instanceId: string;
  manualFollowerOwnerId: string;
  getLeaderSocketPath: () => string;
  getFollowerSocketPath: () => string;
}

export function getTelegramProcessBirthIdentity(
  pid: number,
  fallbackGeneration: number | string,
): string {
  if (pid > 0) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      if (startTicks) return `${pid}:start:${startTicks}`;
    } catch {
      /* non-Linux or inaccessible process metadata */
    }
  }
  return `${pid}:generation:${fallbackGeneration}`;
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
  profileKey?: string;
  threadName?: string;
  slot?: string;
  cwd?: string;
  pid?: number;
  target?: TelegramTarget;
  busSocketPath?: string;
  registrationGeneration?: string;
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
}): { instanceId: string } | undefined {
  const liveFollower = input.followers.find((follower) => {
    return (
      follower.target?.chatId === input.target.chatId &&
      follower.target.threadId === input.target.threadId
    );
  });
  if (liveFollower) return { instanceId: liveFollower.instanceId };
  const record = input.activeThreadRecords?.find((candidate) => {
    const isFollowerRecord = candidate.owner?.kind
      ? candidate.owner.kind === "manual-follower"
      : candidate.profileKey?.startsWith("manual:") === true;
    return (
      isFollowerRecord &&
      candidate.status === "active" &&
      candidate.instanceId &&
      candidate.instanceId !== input.currentInstanceId &&
      candidate.target.chatId === input.target.chatId &&
      candidate.target.threadId === input.target.threadId
    );
  });
  return record?.instanceId ? { instanceId: record.instanceId } : undefined;
}

const TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD = "__piTelegramAggregateDelivery";

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

export function stripTelegramBusApiMetadata<T extends Record<string, unknown>>(
  body: T,
): T {
  if (!(TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD in body)) return body;
  const clean = { ...body };
  delete clean[TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD];
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
    if (apiMethod === "deleteMessage" || apiMethod === "editMessageText") {
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
      kind: "leader.forwardCallback";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration?: string;
      query: unknown;
      sentAtMs: number;
    }
  | {
      kind: "leader.forwardReaction";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration?: string;
      reactionUpdate: unknown;
      sentAtMs: number;
    }
  | {
      kind: "leader.forwardMessage";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration?: string;
      message: unknown;
      sentAtMs: number;
    }
  | {
      kind: "leader.forwardEditedMessage";
      requestId: string;
      recipientInstanceId: string;
      recipientRegistrationGeneration?: string;
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
      error?: {
        code: "commit-unknown" | "request-id-collision" | "ledger-overloaded";
        method?: string;
      };
    }
) & { auth?: string };

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

export type TelegramBusSocketPathSource = string | (() => string);

export function resolveTelegramBusSocketPath(
  source: TelegramBusSocketPathSource,
): string {
  return typeof source === "function" ? source() : source;
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

export interface TelegramBusForeignOwnedForwarderDeps {
  socketPath: TelegramBusSocketPathSource;
  createRequestId: () => string;
  getNowMs?: () => number;
  timeoutMs?: number;
  getAuthSecret?: () => string | undefined;
}

export function createTelegramBusForeignOwnedUpdateForwarder<
  TContext,
  TReactionUpdate,
  TCallbackQuery,
  TMessage = unknown,
>(
  deps: TelegramBusForeignOwnedForwarderDeps,
): {
  forwardCallback: (input: {
    query: TCallbackQuery;
    ownership: { instanceId: string; ownerGeneration?: string };
    ctx: TContext;
  }) => Promise<boolean>;
  forwardReaction: (input: {
    reactionUpdate: TReactionUpdate;
    ownership: { instanceId: string; ownerGeneration?: string };
    ctx: TContext;
  }) => Promise<boolean>;
  forwardMessage: (input: {
    message: TMessage;
    ownership: { instanceId: string; ownerGeneration?: string };
    ctx: TContext;
  }) => Promise<boolean>;
  forwardEditedMessage: (input: {
    message: TMessage;
    ownership: { instanceId: string; ownerGeneration?: string };
    ctx: TContext;
  }) => Promise<boolean>;
} {
  const getNowMs = deps.getNowMs ?? Date.now;
  const send = async (envelope: TelegramBusEnvelope): Promise<boolean> => {
    if (deps.getAuthSecret) envelope.auth = deps.getAuthSecret();
    const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope,
      timeoutMs: deps.timeoutMs,
      retry: getTelegramBusTransportRetryPolicy({
        endpoint: socketPath,
        operation: "operation",
      }),
    });
    return response?.kind === "bus.ack" && response.ok;
  };
  return {
    forwardCallback: ({ query, ownership }) =>
      send({
        kind: "leader.forwardCallback",
        requestId: deps.createRequestId(),
        recipientInstanceId: ownership.instanceId,
        ...(ownership.ownerGeneration
          ? { recipientRegistrationGeneration: ownership.ownerGeneration }
          : {}),
        query,
        sentAtMs: getNowMs(),
      }),
    forwardReaction: ({ reactionUpdate, ownership }) =>
      send({
        kind: "leader.forwardReaction",
        requestId: deps.createRequestId(),
        recipientInstanceId: ownership.instanceId,
        ...(ownership.ownerGeneration
          ? { recipientRegistrationGeneration: ownership.ownerGeneration }
          : {}),
        reactionUpdate,
        sentAtMs: getNowMs(),
      }),
    forwardMessage: ({ message, ownership }) =>
      send({
        kind: "leader.forwardMessage",
        requestId: deps.createRequestId(),
        recipientInstanceId: ownership.instanceId,
        ...(ownership.ownerGeneration
          ? { recipientRegistrationGeneration: ownership.ownerGeneration }
          : {}),
        message,
        sentAtMs: getNowMs(),
      }),
    forwardEditedMessage: ({ message, ownership }) =>
      send({
        kind: "leader.forwardEditedMessage",
        requestId: deps.createRequestId(),
        recipientInstanceId: ownership.instanceId,
        ...(ownership.ownerGeneration
          ? { recipientRegistrationGeneration: ownership.ownerGeneration }
          : {}),
        message,
        sentAtMs: getNowMs(),
      }),
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
      if (!follower.busSocketPath) return false;
      const envelope: TelegramBusEnvelope = {
        kind: "leader.replaceFollowerTarget",
        requestId: deps.createRequestId(),
        recipientInstanceId: follower.instanceId,
        ...(follower.registrationGeneration
          ? {
              recipientRegistrationGeneration: follower.registrationGeneration,
            }
          : {}),
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
  return !secret || envelope.auth === secret;
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
      const usesWindowsPipe = isTelegramBusPipePath(socketPath);
      const endpointGeneration = randomBytes(8).toString("hex");
      const listenPath = usesWindowsPipe
        ? socketPath
        : join(dirname(socketPath), `.pi-telegram-${endpointGeneration}.sock`);
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
    timeout.unref?.();
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
  const attempts = Math.max(1, options.retry?.attempts ?? 1);
  const delayMs = Math.max(0, options.retry?.delayMs ?? 0);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sendTelegramBusLocalEnvelopeOnce(options);
    } catch (error) {
      const info = classifyTelegramBusTransportError(error);
      options.recordTransportEvent?.("client-failed", {
        ...getTelegramBusEndpointDiagnostics(options.socketPath),
        ...getTelegramBusEnvelopeDiagnostics(options.envelope),
        attempt,
        attempts,
        ...info,
      });
      if (attempt >= attempts || !isRetryableTelegramBusTransportError(error)) {
        throw error;
      }
      options.recordTransportEvent?.("client-retry", {
        ...getTelegramBusEndpointDiagnostics(options.socketPath),
        ...getTelegramBusEnvelopeDiagnostics(options.envelope),
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

function parseForwardCallbackEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  return typeof value.recipientInstanceId === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "leader.forwardCallback",
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        ...(typeof value.recipientRegistrationGeneration === "string"
          ? {
              recipientRegistrationGeneration:
                value.recipientRegistrationGeneration,
            }
          : {}),
        query: value.query,
        sentAtMs: value.sentAtMs,
      }
    : undefined;
}

function parseForwardReactionEnvelope(
  value: Record<string, unknown>,
  requestId: string,
): TelegramBusEnvelope | undefined {
  return typeof value.recipientInstanceId === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind: "leader.forwardReaction",
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        ...(typeof value.recipientRegistrationGeneration === "string"
          ? {
              recipientRegistrationGeneration:
                value.recipientRegistrationGeneration,
            }
          : {}),
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
  return typeof value.recipientInstanceId === "string" &&
    typeof value.sentAtMs === "number"
    ? {
        kind,
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        ...(typeof value.recipientRegistrationGeneration === "string"
          ? {
              recipientRegistrationGeneration:
                value.recipientRegistrationGeneration,
            }
          : {}),
        message: value.message,
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
  if (isRecord(value.error)) {
    const code = value.error.code;
    if (
      code === "commit-unknown" ||
      code === "request-id-collision" ||
      code === "ledger-overloaded"
    ) {
      envelope.error = {
        code,
        ...(typeof value.error.method === "string"
          ? { method: value.error.method }
          : {}),
      };
    }
  }
  return envelope;
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
