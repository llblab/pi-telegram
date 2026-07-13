/**
 * Telegram target-aware operational delivery and logical message lifecycle
 * Zones: telegram delivery, extension API, runtime binding
 * Owns the public extension delivery contract, authorized scope resolution, operational rendering adapter, per-target serialization, chunk reconciliation, generation-fenced logical handles, and process-local runtime membrane; composes the established reply renderer with bus-aware Telegram API ports and excludes bot clients, Pi contexts, and consumer-extension policy
 */

import { markTelegramBusAggregateDelivery } from "./bus.ts";
import {
  assertTelegramInlineKeyboardCallbackData,
  type TelegramInlineKeyboardMarkup,
} from "./keyboard.ts";
import {
  buildTelegramReplyParameters,
  renderTelegramMessage,
} from "./replies.ts";
import {
  getTelegramTargetThreadParams,
  type TelegramTarget,
} from "./target.ts";
import {
  isTelegramApiCommitUnknownError,
  type TelegramBridgeApiRuntime,
} from "./telegram-api.ts";

const TELEGRAM_DELIVERY_RUNTIME_KEY = "__piTelegramDeliveryRuntime__";

class TelegramDeliveryTransportGenerationError extends Error {
  constructor() {
    super("Telegram Delivery transport generation is no longer active.");
    this.name = "TelegramDeliveryTransportGenerationError";
  }
}

export type TelegramDeliveryParseMode = "plain" | "html" | "markdown";

export interface TelegramDeliveryView {
  text: string;
  parseMode?: TelegramDeliveryParseMode;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export type TelegramDeliveryTarget = TelegramTarget;

export type TelegramDeliveryScope =
  | { kind: "active-turn" }
  | { kind: "instance" }
  | { kind: "aggregate" }
  | { kind: "target"; target: TelegramDeliveryTarget };

export interface TelegramDeliveryHandle {
  readonly target: TelegramDeliveryTarget;
  readonly messageIds: readonly number[];
  readonly generation: string;
}

export type TelegramDeliveryFailureReason =
  | "runtime-unavailable"
  | "target-unavailable"
  | "target-unauthorized"
  | "stale-handle"
  | "invalid-view"
  | "commit-unknown"
  | "transport-failed";

export type TelegramDeliveryResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: TelegramDeliveryFailureReason;
      message: string;
      /** Successfully materialized state that callers may edit or delete to recover. */
      partial?: T;
    };

export interface SendTelegramViewOptions {
  scope: TelegramDeliveryScope;
  replyToMessageId?: number;
}

export type TelegramDeliveryChatAction =
  "typing" | "upload_document" | "upload_photo" | "record_voice";

/** @internal */
export interface TelegramDeliveryRuntime {
  readonly generation: string;
  shutdown: () => void;
  sendView: (
    view: TelegramDeliveryView,
    options: SendTelegramViewOptions,
  ) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
  editView: (
    handle: TelegramDeliveryHandle,
    view: TelegramDeliveryView,
  ) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
  deleteView: (
    handle: TelegramDeliveryHandle,
  ) => Promise<TelegramDeliveryResult<void>>;
  sendChatAction: (
    action: TelegramDeliveryChatAction,
    scope: TelegramDeliveryScope,
  ) => Promise<TelegramDeliveryResult<void>>;
}

/** @internal */
export interface TelegramDeliveryTargetResolverDeps {
  getActiveTurnTarget: () => TelegramDeliveryTarget | undefined;
  getInstanceTarget: () => TelegramDeliveryTarget | undefined;
  getAggregateTarget: () => TelegramDeliveryTarget | undefined;
  isExplicitTargetAuthorized: (target: TelegramDeliveryTarget) => boolean;
}

/** @internal */
export interface TelegramDeliveryRenderedChunk {
  text: string;
  parseMode: TelegramDeliveryParseMode;
}

/** @internal */
export interface TelegramDeliveryTransportOptions {
  replyToMessageId?: number;
  replyMarkup?: TelegramInlineKeyboardMarkup | null;
}

/** @internal */
export interface TelegramDeliveryRuntimeDeps extends TelegramDeliveryTargetResolverDeps {
  generation: string;
  renderView: (
    view: TelegramDeliveryView,
  ) => readonly TelegramDeliveryRenderedChunk[];
  sendChunk: (
    target: TelegramDeliveryTarget,
    chunk: TelegramDeliveryRenderedChunk,
    options: TelegramDeliveryTransportOptions,
  ) => Promise<number>;
  editChunk: (
    target: TelegramDeliveryTarget,
    messageId: number,
    chunk: TelegramDeliveryRenderedChunk,
    options: TelegramDeliveryTransportOptions,
  ) => Promise<void>;
  deleteMessage: (
    target: TelegramDeliveryTarget,
    messageId: number,
  ) => Promise<void>;
  sendChatAction: (
    target: TelegramDeliveryTarget,
    action: TelegramDeliveryChatAction,
  ) => Promise<void>;
  recordFailure?: (
    operation: "send" | "edit" | "delete" | "chat-action",
    error: unknown,
    target?: TelegramDeliveryTarget,
  ) => void;
}

/** @internal */
export interface TelegramBridgeDeliveryRuntimeDeps {
  generation: string;
  getTargetPolicyView: () => TelegramDeliveryTargetPolicyView;
  getActiveTurnTarget: () => TelegramDeliveryTarget | undefined;
  isTransportActive?: () => boolean;
  api: Pick<
    TelegramBridgeApiRuntime,
    "sendMessage" | "editMessageText" | "deleteMessage" | "sendChatAction"
  >;
  recordOwnership: (input: {
    chatId: number;
    messageId: number;
    target: TelegramDeliveryTarget;
  }) => void;
  recordFailure?: TelegramDeliveryRuntimeDeps["recordFailure"];
}

/** @internal */
export function createTelegramDeliveryLifecycleHooks(
  createRuntime: () => TelegramDeliveryRuntime,
): {
  onSessionStart: () => Promise<void>;
  onSessionShutdown: () => Promise<void>;
} {
  let runtime: TelegramDeliveryRuntime | undefined;
  let unbind: ReturnType<typeof bindTelegramDeliveryRuntime> | undefined;
  const stopCurrentRuntime = () => {
    unbind?.();
    unbind = undefined;
    runtime?.shutdown();
    runtime = undefined;
  };
  return {
    onSessionStart: async () => {
      stopCurrentRuntime();
      runtime = createRuntime();
      unbind = bindTelegramDeliveryRuntime(runtime);
    },
    onSessionShutdown: async () => {
      stopCurrentRuntime();
    },
  };
}

/** @internal */
export function createTelegramBridgeDeliveryLifecycleHooks<TTransportStamp>(
  deps: Omit<
    TelegramBridgeDeliveryRuntimeDeps,
    "generation" | "isTransportActive"
  > & {
    generationSeed: string;
    getTransportStamp?: () => TTransportStamp;
    isTransportStampActive?: (stamp: TTransportStamp) => boolean;
  },
): ReturnType<typeof createTelegramDeliveryLifecycleHooks> {
  let generationSequence = 0;
  return createTelegramDeliveryLifecycleHooks(() => {
    const transportStamp = deps.getTransportStamp?.();
    return createTelegramBridgeDeliveryRuntime({
      ...deps,
      generation: `${deps.generationSeed}:${++generationSequence}`,
      isTransportActive:
        transportStamp !== undefined && deps.isTransportStampActive
          ? () => deps.isTransportStampActive?.(transportStamp) ?? false
          : undefined,
    });
  });
}

interface TelegramDeliveryRuntimeRegistry {
  runtime?: TelegramDeliveryRuntime;
}

function getTelegramDeliveryRuntimeRegistry(): TelegramDeliveryRuntimeRegistry {
  const globals = globalThis as Record<string, unknown>;
  const existing = globals[TELEGRAM_DELIVERY_RUNTIME_KEY];
  if (existing && typeof existing === "object" && "runtime" in existing) {
    return existing as TelegramDeliveryRuntimeRegistry;
  }
  const registry: TelegramDeliveryRuntimeRegistry = {};
  globals[TELEGRAM_DELIVERY_RUNTIME_KEY] = registry;
  return registry;
}

function failure<T>(
  reason: TelegramDeliveryFailureReason,
  message: string,
  partial?: T,
): TelegramDeliveryResult<T> {
  return partial === undefined
    ? { ok: false, reason, message }
    : { ok: false, reason, message, partial };
}

/** @internal */
export interface TelegramDeliveryTargetPolicyView {
  canDeliver: boolean;
  ownsDirect: boolean;
  allowedChatId?: number;
  followerTarget?: TelegramDeliveryTarget;
  leaderTarget?: TelegramDeliveryTarget;
  liveTargets?: readonly TelegramDeliveryTarget[];
}

/** @internal */
export interface TelegramDeliveryTargetPolicyRuntime {
  getTargetPolicyView(): TelegramDeliveryTargetPolicyView;
  getActiveTurnTarget(): TelegramDeliveryTarget | undefined;
}

/** @internal */
export function createTelegramDeliveryTargetPolicyRuntime(deps: {
  ownsDirect(): boolean;
  isFollowerRegistered(): boolean;
  getAllowedChatId(): number | undefined;
  getFollowerTarget(): TelegramDeliveryTarget | undefined;
  getLeaderTarget(): TelegramDeliveryTarget | undefined;
  listThreadRecords(): readonly { target: TelegramDeliveryTarget }[];
  getActiveTurnTarget(): TelegramDeliveryTarget | undefined;
  getActiveGuestQueryId(): string | undefined;
}): TelegramDeliveryTargetPolicyRuntime {
  return {
    getTargetPolicyView() {
      const ownsDirect = deps.ownsDirect();
      return {
        canDeliver: ownsDirect || deps.isFollowerRegistered(),
        ownsDirect,
        allowedChatId: deps.getAllowedChatId(),
        followerTarget: deps.getFollowerTarget(),
        leaderTarget: deps.getLeaderTarget(),
        liveTargets: deps.listThreadRecords().map((record) => record.target),
      };
    },
    getActiveTurnTarget() {
      return deps.getActiveGuestQueryId()
        ? undefined
        : deps.getActiveTurnTarget();
    },
  };
}

/** @internal */
export function resolveTelegramDeliveryInstanceTarget(
  view: TelegramDeliveryTargetPolicyView,
): TelegramDeliveryTarget | undefined {
  if (!view.canDeliver) return undefined;
  return (
    view.followerTarget ??
    view.leaderTarget ??
    (view.allowedChatId === undefined
      ? undefined
      : { chatId: view.allowedChatId })
  );
}

/** @internal */
export function resolveTelegramDeliveryAggregateTarget(
  view: TelegramDeliveryTargetPolicyView,
): TelegramDeliveryTarget | undefined {
  return !view.canDeliver || view.allowedChatId === undefined
    ? undefined
    : { chatId: view.allowedChatId };
}

/** @internal */
export function isTelegramDeliveryExplicitTargetAuthorized(
  candidate: TelegramDeliveryTarget,
  view: TelegramDeliveryTargetPolicyView,
): boolean {
  if (
    !view.canDeliver ||
    view.allowedChatId === undefined ||
    candidate.chatId !== view.allowedChatId
  ) {
    return false;
  }
  if (candidate.threadId === undefined) return true;
  if (view.followerTarget) {
    return areDeliveryTargetsEqual(candidate, view.followerTarget);
  }
  if (!view.ownsDirect) return false;
  if (
    view.leaderTarget &&
    areDeliveryTargetsEqual(candidate, view.leaderTarget)
  ) {
    return true;
  }
  return (view.liveTargets ?? []).some(function (target) {
    return areDeliveryTargetsEqual(candidate, target);
  });
}

function areDeliveryTargetsEqual(
  left: TelegramDeliveryTarget,
  right: TelegramDeliveryTarget,
): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

function cloneTarget(target: TelegramDeliveryTarget): TelegramDeliveryTarget {
  return target.threadId === undefined
    ? { chatId: target.chatId }
    : { chatId: target.chatId, threadId: target.threadId };
}

function targetKey(target: TelegramDeliveryTarget): string {
  return `${target.chatId}:${target.threadId ?? "root"}`;
}

function resolveTelegramDeliveryTarget(
  scope: TelegramDeliveryScope,
  deps: TelegramDeliveryTargetResolverDeps,
): TelegramDeliveryResult<TelegramDeliveryTarget> {
  if (scope.kind === "target") {
    if (!deps.isExplicitTargetAuthorized(scope.target)) {
      return failure(
        "target-unauthorized",
        "Telegram delivery target is not authorized for this runtime.",
      );
    }
    return { ok: true, value: cloneTarget(scope.target) };
  }
  const target =
    scope.kind === "active-turn"
      ? deps.getActiveTurnTarget()
      : scope.kind === "instance"
        ? deps.getInstanceTarget()
        : deps.getAggregateTarget();
  if (!target) {
    return failure(
      "target-unavailable",
      `Telegram delivery ${scope.kind} target is unavailable.`,
    );
  }
  return { ok: true, value: cloneTarget(target) };
}

function createTelegramDeliveryTargetQueue() {
  const queues = new Map<string, Promise<void>>();
  return async function run<T>(
    target: TelegramDeliveryTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = targetKey(target);
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => {},
      () => {},
    );
    queues.set(key, settled);
    try {
      return await current;
    } finally {
      if (queues.get(key) === settled) queues.delete(key);
    }
  };
}

function getChunkTransportOptions(
  view: TelegramDeliveryView,
  index: number,
  chunkCount: number,
  replyToMessageId?: number,
  editing = false,
): TelegramDeliveryTransportOptions {
  const isFirst = index === 0;
  const isLast = index === chunkCount - 1;
  return {
    ...(isFirst && replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(isLast
      ? { replyMarkup: view.replyMarkup ?? (editing ? null : undefined) }
      : editing
        ? { replyMarkup: null }
        : {}),
  };
}

/** @internal */
export function createTelegramDeliveryRuntime(
  deps: TelegramDeliveryRuntimeDeps,
): TelegramDeliveryRuntime {
  let active = true;
  const handleBindings = new WeakMap<
    TelegramDeliveryHandle,
    { target: TelegramDeliveryTarget; messageIds: readonly number[] }
  >();
  const runForTarget = createTelegramDeliveryTargetQueue();
  const render = (
    view: TelegramDeliveryView,
  ): TelegramDeliveryResult<readonly TelegramDeliveryRenderedChunk[]> => {
    const chunks = deps.renderView(view);
    if (
      chunks.length === 0 ||
      chunks.some(
        (chunk) =>
          typeof chunk.text !== "string" || chunk.text.trim().length === 0,
      )
    ) {
      return failure(
        "invalid-view",
        "Telegram delivery view rendered no content.",
      );
    }
    return { ok: true, value: chunks };
  };
  const inactive = <T>(): TelegramDeliveryResult<T> =>
    failure(
      "runtime-unavailable",
      "Telegram delivery runtime generation is inactive.",
    );
  const transportFailure = <T>(
    operation: "send" | "edit" | "delete" | "chat-action",
    error: unknown,
    target?: TelegramDeliveryTarget,
    partial?: T,
  ): TelegramDeliveryResult<T> => {
    deps.recordFailure?.(operation, error, target);
    if (error instanceof TelegramDeliveryTransportGenerationError) {
      return inactive();
    }
    return failure(
      isTelegramApiCommitUnknownError(error)
        ? "commit-unknown"
        : "transport-failed",
      isTelegramApiCommitUnknownError(error)
        ? `Telegram delivery ${operation} may have committed before transport failed.`
        : `Telegram delivery ${operation} failed.`,
      partial,
    );
  };
  const createHandle = (
    target: TelegramDeliveryTarget,
    messageIds: readonly number[],
  ): TelegramDeliveryHandle => {
    const canonicalTarget = Object.freeze(cloneTarget(target));
    const canonicalMessageIds = Object.freeze([...messageIds]);
    const handle = Object.freeze({
      target: canonicalTarget,
      messageIds: canonicalMessageIds,
      generation: deps.generation,
    });
    handleBindings.set(handle, {
      target: canonicalTarget,
      messageIds: canonicalMessageIds,
    });
    return handle;
  };
  const resolveHandle = (
    handle: TelegramDeliveryHandle,
  ): TelegramDeliveryResult<{
    target: TelegramDeliveryTarget;
    messageIds: readonly number[];
  }> => {
    if (!active) return inactive();
    const binding = handleBindings.get(handle);
    if (!binding || handle.generation !== deps.generation) {
      return failure(
        "stale-handle",
        "Telegram delivery handle belongs to an inactive runtime generation.",
      );
    }
    const authorized = resolveTelegramDeliveryTarget(
      { kind: "target", target: binding.target },
      deps,
    );
    if (!authorized.ok) {
      return failure(authorized.reason, authorized.message);
    }
    return { ok: true, value: binding };
  };
  return {
    generation: deps.generation,
    shutdown() {
      active = false;
    },
    async sendView(view, options) {
      if (!active) return inactive();
      const resolved = resolveTelegramDeliveryTarget(options.scope, deps);
      if (!resolved.ok) return failure(resolved.reason, resolved.message);
      const rendered = render(view);
      if (!rendered.ok) return failure(rendered.reason, rendered.message);
      const target = resolved.value;
      return runForTarget(target, async () => {
        if (!active) return inactive();
        const messageIds: number[] = [];
        try {
          for (const [index, chunk] of rendered.value.entries()) {
            if (!active) return inactive();
            const messageId = await deps.sendChunk(
              target,
              chunk,
              getChunkTransportOptions(
                view,
                index,
                rendered.value.length,
                options.replyToMessageId,
              ),
            );
            messageIds.push(messageId);
            if (!active) return inactive();
          }
          return { ok: true, value: createHandle(target, messageIds) };
        } catch (error) {
          return active
            ? transportFailure(
                "send",
                error,
                target,
                messageIds.length > 0
                  ? createHandle(target, messageIds)
                  : undefined,
              )
            : inactive();
        }
      });
    },
    async editView(handle, view) {
      const resolved = resolveHandle(handle);
      if (!resolved.ok) return failure(resolved.reason, resolved.message);
      const rendered = render(view);
      if (!rendered.ok) return failure(rendered.reason, rendered.message);
      const target = resolved.value.target;
      return runForTarget(target, async () => {
        if (!active) return inactive();
        const visibleMessageIds = [...resolved.value.messageIds];
        try {
          const sharedCount = Math.min(
            visibleMessageIds.length,
            rendered.value.length,
          );
          for (let index = 0; index < sharedCount; index += 1) {
            if (!active) return inactive();
            await deps.editChunk(
              target,
              visibleMessageIds[index]!,
              rendered.value[index]!,
              getChunkTransportOptions(
                view,
                index,
                rendered.value.length,
                undefined,
                true,
              ),
            );
            if (!active) return inactive();
          }
          for (
            let index = sharedCount;
            index < rendered.value.length;
            index += 1
          ) {
            if (!active) return inactive();
            visibleMessageIds.push(
              await deps.sendChunk(
                target,
                rendered.value[index]!,
                getChunkTransportOptions(view, index, rendered.value.length),
              ),
            );
            if (!active) return inactive();
          }
          const removedMessageIds = visibleMessageIds.slice(
            rendered.value.length,
          );
          for (const messageId of removedMessageIds) {
            if (!active) return inactive();
            await deps.deleteMessage(target, messageId);
            visibleMessageIds.splice(visibleMessageIds.indexOf(messageId), 1);
            if (!active) return inactive();
          }
          return {
            ok: true,
            value: createHandle(target, visibleMessageIds),
          };
        } catch (error) {
          return active
            ? transportFailure(
                "edit",
                error,
                target,
                createHandle(target, visibleMessageIds),
              )
            : inactive();
        }
      });
    },
    async deleteView(handle) {
      const resolved = resolveHandle(handle);
      if (!resolved.ok) return failure(resolved.reason, resolved.message);
      const target = resolved.value.target;
      return runForTarget(target, async () => {
        if (!active) return inactive();
        try {
          for (const messageId of resolved.value.messageIds) {
            if (!active) return inactive();
            await deps.deleteMessage(target, messageId);
            if (!active) return inactive();
          }
          return { ok: true, value: undefined };
        } catch (error) {
          return active
            ? transportFailure("delete", error, target)
            : inactive();
        }
      });
    },
    async sendChatAction(action, scope) {
      if (!active) return inactive();
      const resolved = resolveTelegramDeliveryTarget(scope, deps);
      if (!resolved.ok) return failure(resolved.reason, resolved.message);
      const target = resolved.value;
      return runForTarget(target, async () => {
        if (!active) return inactive();
        try {
          await deps.sendChatAction(target, action);
          if (!active) return inactive();
          return { ok: true, value: undefined };
        } catch (error) {
          return active
            ? transportFailure("chat-action", error, target)
            : inactive();
        }
      });
    },
  };
}

/** @internal */
export function createTelegramBridgeDeliveryRuntime(
  deps: TelegramBridgeDeliveryRuntimeDeps,
): TelegramDeliveryRuntime {
  const getPolicyView = deps.getTargetPolicyView;
  const assertTransportActive = (): void => {
    if (deps.isTransportActive?.() === false) {
      throw new TelegramDeliveryTransportGenerationError();
    }
  };
  return createTelegramDeliveryRuntime({
    generation: deps.generation,
    getActiveTurnTarget: deps.getActiveTurnTarget,
    getInstanceTarget() {
      return resolveTelegramDeliveryInstanceTarget(getPolicyView());
    },
    getAggregateTarget() {
      return resolveTelegramDeliveryAggregateTarget(getPolicyView());
    },
    isExplicitTargetAuthorized(target) {
      return isTelegramDeliveryExplicitTargetAuthorized(
        target,
        getPolicyView(),
      );
    },
    renderView(view) {
      assertTelegramInlineKeyboardCallbackData(view.replyMarkup);
      return renderTelegramMessage(view.text, {
        mode: view.parseMode ?? "plain",
      }).map(function (chunk) {
        return {
          text: chunk.text,
          parseMode: chunk.parseMode === "HTML" ? "html" : "plain",
        } as const;
      });
    },
    async sendChunk(target, chunk, options) {
      assertTransportActive();
      const replyParameters = buildTelegramReplyParameters(
        target.chatId,
        options.replyToMessageId,
        target,
      );
      const body = {
        chat_id: target.chatId,
        text: chunk.text,
        ...(chunk.parseMode === "html" ? { parse_mode: "HTML" as const } : {}),
        ...getTelegramTargetThreadParams(target),
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      };
      const sent = await deps.api.sendMessage(
        target.threadId === undefined
          ? markTelegramBusAggregateDelivery(body)
          : body,
      );
      assertTransportActive();
      deps.recordOwnership({
        chatId: target.chatId,
        messageId: sent.message_id,
        target,
      });
      return sent.message_id;
    },
    async editChunk(target, messageId, chunk, options) {
      assertTransportActive();
      await deps.api.editMessageText({
        chat_id: target.chatId,
        message_id: messageId,
        text: chunk.text,
        ...(chunk.parseMode === "html" ? { parse_mode: "HTML" as const } : {}),
        reply_markup:
          options.replyMarkup === null
            ? { inline_keyboard: [] }
            : options.replyMarkup,
      });
    },
    deleteMessage(target, messageId) {
      assertTransportActive();
      return deps.api.deleteMessage(target.chatId, messageId);
    },
    async sendChatAction(target, action) {
      assertTransportActive();
      await deps.api.sendChatAction(target.chatId, action, {
        message_thread_id: target.threadId,
      });
    },
    recordFailure: deps.recordFailure,
  });
}

function getBoundTelegramDeliveryRuntime():
  TelegramDeliveryRuntime | TelegramDeliveryResult<never> {
  const runtime = getTelegramDeliveryRuntimeRegistry().runtime;
  return (
    runtime ??
    failure(
      "runtime-unavailable",
      "Telegram delivery runtime is unavailable in this Pi session.",
    )
  );
}

function isFailure(
  value: TelegramDeliveryRuntime | TelegramDeliveryResult<never>,
): value is TelegramDeliveryResult<never> {
  return "ok" in value;
}

function validateView<T>(
  view: TelegramDeliveryView,
): TelegramDeliveryResult<T> | undefined {
  if (typeof view.text !== "string" || view.text.trim().length === 0) {
    return failure("invalid-view", "Telegram delivery view text is empty.");
  }
  return undefined;
}

async function runDeliveryOperation<T>(
  operation: (
    runtime: TelegramDeliveryRuntime,
  ) => Promise<TelegramDeliveryResult<T>>,
): Promise<TelegramDeliveryResult<T>> {
  const runtime = getBoundTelegramDeliveryRuntime();
  if (isFailure(runtime)) return runtime;
  try {
    return await operation(runtime);
  } catch {
    return failure("transport-failed", "Telegram delivery failed.");
  }
}

/** @internal */
export function bindTelegramDeliveryRuntime(
  runtime: TelegramDeliveryRuntime,
): () => void {
  const registry = getTelegramDeliveryRuntimeRegistry();
  if (registry.runtime !== runtime) registry.runtime?.shutdown();
  registry.runtime = runtime;
  return () => {
    if (registry.runtime === runtime) registry.runtime = undefined;
  };
}

/** @internal */
export function clearTelegramDeliveryRuntime(): void {
  const registry = getTelegramDeliveryRuntimeRegistry();
  registry.runtime?.shutdown();
  registry.runtime = undefined;
}

export async function sendTelegramView(
  view: TelegramDeliveryView,
  options: SendTelegramViewOptions,
): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>> {
  const invalid = validateView<TelegramDeliveryHandle>(view);
  if (invalid) return invalid;
  return runDeliveryOperation((runtime) => runtime.sendView(view, options));
}

export async function editTelegramView(
  handle: TelegramDeliveryHandle,
  view: TelegramDeliveryView,
): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>> {
  const invalid = validateView<TelegramDeliveryHandle>(view);
  if (invalid) return invalid;
  return runDeliveryOperation((runtime) => {
    if (runtime.generation !== handle.generation) {
      return Promise.resolve(
        failure(
          "stale-handle",
          "Telegram delivery handle belongs to an inactive runtime generation.",
        ),
      );
    }
    return runtime.editView(handle, view);
  });
}

export async function deleteTelegramView(
  handle: TelegramDeliveryHandle,
): Promise<TelegramDeliveryResult<void>> {
  return runDeliveryOperation((runtime) => {
    if (runtime.generation !== handle.generation) {
      return Promise.resolve(
        failure(
          "stale-handle",
          "Telegram delivery handle belongs to an inactive runtime generation.",
        ),
      );
    }
    return runtime.deleteView(handle);
  });
}

export async function sendTelegramChatAction(
  action: TelegramDeliveryChatAction,
  options: { scope: TelegramDeliveryScope },
): Promise<TelegramDeliveryResult<void>> {
  return runDeliveryOperation((runtime) =>
    runtime.sendChatAction(action, options.scope),
  );
}
