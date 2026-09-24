/**
 * Telegram target-aware operational delivery and logical message lifecycle
 * Zones: telegram delivery, extension API, runtime binding
 * Owns the public extension delivery contract, authorized scope resolution, operational rendering adapter, per-target serialization, chunk reconciliation, generation-fenced logical handles, and process-local runtime membrane; composes the established reply renderer with bus-aware Telegram API ports and excludes bot clients, Pi contexts, and consumer-extension policy
 */
import { markTelegramBusAggregateDelivery } from "./bus.js";
import { assertTelegramInlineKeyboardCallbackData, } from "./keyboard.js";
import { withTelegramReplyParameters, renderTelegramMessage, } from "./replies.js";
import { getTelegramTargetThreadParams, } from "./target.js";
import { getTelegramApiRetryAfterMs, isRetryableTelegramApiError, isTelegramApiCommitUnknownError, isTelegramMessageUnavailableError, } from "./telegram-api.js";
const TELEGRAM_DELIVERY_RUNTIME_KEY = "__piTelegramDeliveryRuntime__";
class TelegramDeliveryTransportGenerationError extends Error {
    constructor() {
        super("Telegram Delivery transport generation is no longer active.");
        this.name = "TelegramDeliveryTransportGenerationError";
    }
}
/** @internal */
export function createTelegramDeliveryLifecycleHooks(createRuntime) {
    let runtime;
    let unbind;
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
export function createTelegramDeliveryGenerationSeed(instanceId) {
    return `${instanceId}:${Date.now()}`;
}
/** @internal */
export function createTelegramBridgeDeliveryLifecycleHooks(deps) {
    let generationSequence = 0;
    return createTelegramDeliveryLifecycleHooks(() => {
        const transportStamp = deps.getTransportStamp?.();
        return createTelegramBridgeDeliveryRuntime({
            ...deps,
            generation: `${deps.generationSeed}:${++generationSequence}`,
            isTransportActive: transportStamp !== undefined && deps.isTransportStampActive
                ? () => deps.isTransportStampActive?.(transportStamp) ?? false
                : undefined,
        });
    });
}
function getTelegramDeliveryRuntimeRegistry() {
    const globals = globalThis;
    const existing = globals[TELEGRAM_DELIVERY_RUNTIME_KEY];
    if (existing && typeof existing === "object" && "runtime" in existing) {
        return existing;
    }
    const registry = {};
    globals[TELEGRAM_DELIVERY_RUNTIME_KEY] = registry;
    return registry;
}
function failure(reason, message, partial, retryAfterMs) {
    const retry = retryAfterMs === undefined ? {} : { retryAfterMs };
    return partial === undefined
        ? { ok: false, reason, message, ...retry }
        : { ok: false, reason, message, partial, ...retry };
}
export function classifyTelegramDeliveryTransportError(error) {
    if (isTelegramApiCommitUnknownError(error))
        return { reason: "commit-unknown" };
    if (isTelegramMessageUnavailableError(error))
        return { reason: "message-unavailable" };
    const retryAfterMs = getTelegramApiRetryAfterMs(error);
    if (retryAfterMs !== undefined)
        return { reason: "rate-limited", retryAfterMs };
    if (isRetryableTelegramApiError(error))
        return { reason: "transport-retryable" };
    return { reason: "transport-failed" };
}
/** @internal */
export function createTelegramDeliveryTargetPolicyRuntime(deps) {
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
export function resolveTelegramDeliveryInstanceTarget(view) {
    if (!view.canDeliver)
        return undefined;
    return (view.followerTarget ??
        view.leaderTarget ??
        (view.allowedChatId === undefined
            ? undefined
            : { chatId: view.allowedChatId }));
}
/** @internal */
export function resolveTelegramDeliveryAggregateTarget(view) {
    return !view.canDeliver || view.allowedChatId === undefined
        ? undefined
        : { chatId: view.allowedChatId };
}
/** @internal */
export function isTelegramDeliveryExplicitTargetAuthorized(candidate, view) {
    if (!view.canDeliver ||
        view.allowedChatId === undefined ||
        candidate.chatId !== view.allowedChatId) {
        return false;
    }
    if (candidate.threadId === undefined)
        return true;
    if (view.followerTarget) {
        return areDeliveryTargetsEqual(candidate, view.followerTarget);
    }
    if (!view.ownsDirect)
        return false;
    if (view.leaderTarget &&
        areDeliveryTargetsEqual(candidate, view.leaderTarget)) {
        return true;
    }
    return (view.liveTargets ?? []).some(function (target) {
        return areDeliveryTargetsEqual(candidate, target);
    });
}
function areDeliveryTargetsEqual(left, right) {
    return left.chatId === right.chatId && left.threadId === right.threadId;
}
function cloneTarget(target) {
    return target.threadId === undefined
        ? { chatId: target.chatId }
        : { chatId: target.chatId, threadId: target.threadId };
}
function targetKey(target) {
    return `${target.chatId}:${target.threadId ?? "root"}`;
}
function resolveTelegramDeliveryTarget(scope, deps) {
    if (scope.kind === "target") {
        if (!deps.isExplicitTargetAuthorized(scope.target)) {
            return failure("target-unauthorized", "Telegram delivery target is not authorized for this runtime.");
        }
        return { ok: true, value: cloneTarget(scope.target) };
    }
    const target = scope.kind === "active-turn"
        ? deps.getActiveTurnTarget()
        : scope.kind === "instance"
            ? deps.getInstanceTarget()
            : deps.getAggregateTarget();
    if (!target) {
        return failure("target-unavailable", `Telegram delivery ${scope.kind} target is unavailable.`);
    }
    return { ok: true, value: cloneTarget(target) };
}
function createTelegramDeliveryTargetQueue() {
    const queues = new Map();
    return async function run(target, operation) {
        const key = targetKey(target);
        const previous = queues.get(key) ?? Promise.resolve();
        const current = previous.then(operation, operation);
        const settled = current.then(() => { }, () => { });
        queues.set(key, settled);
        try {
            return await current;
        }
        finally {
            if (queues.get(key) === settled)
                queues.delete(key);
        }
    };
}
function getChunkTransportOptions(view, index, chunkCount, replyToMessageId, editing = false) {
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
export function createTelegramDeliveryRuntime(deps) {
    let active = true;
    const handleBindings = new WeakMap();
    const runForTarget = createTelegramDeliveryTargetQueue();
    const render = (view) => {
        const chunks = deps.renderView(view);
        if (chunks.length === 0 ||
            chunks.some((chunk) => typeof chunk.text !== "string" || chunk.text.trim().length === 0)) {
            return failure("invalid-view", "Telegram delivery view rendered no content.");
        }
        return { ok: true, value: chunks };
    };
    const inactive = () => failure("runtime-unavailable", "Telegram delivery runtime generation is inactive.");
    const transportFailure = (operation, error, target, partial) => {
        deps.recordFailure?.(operation, error, target);
        if (error instanceof TelegramDeliveryTransportGenerationError) {
            return inactive();
        }
        const classified = classifyTelegramDeliveryTransportError(error);
        return failure(classified.reason, classified.reason === "commit-unknown"
            ? `Telegram delivery ${operation} may have committed before transport failed.`
            : `Telegram delivery ${operation} failed.`, partial, classified.retryAfterMs);
    };
    const createHandle = (target, messageIds) => {
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
    const resolveHandle = (handle) => {
        if (!active)
            return inactive();
        const binding = handleBindings.get(handle);
        if (!binding || handle.generation !== deps.generation) {
            return failure("stale-handle", "Telegram delivery handle belongs to an inactive runtime generation.");
        }
        const authorized = resolveTelegramDeliveryTarget({ kind: "target", target: binding.target }, deps);
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
            if (!active)
                return inactive();
            const resolved = resolveTelegramDeliveryTarget(options.scope, deps);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const rendered = render(view);
            if (!rendered.ok)
                return failure(rendered.reason, rendered.message);
            const target = resolved.value;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                const messageIds = [];
                try {
                    for (const [index, chunk] of rendered.value.entries()) {
                        if (!active)
                            return inactive();
                        const messageId = await deps.sendChunk(target, chunk, getChunkTransportOptions(view, index, rendered.value.length, options.replyToMessageId));
                        messageIds.push(messageId);
                        if (!active)
                            return inactive();
                    }
                    return { ok: true, value: createHandle(target, messageIds) };
                }
                catch (error) {
                    return active
                        ? transportFailure("send", error, target, messageIds.length > 0
                            ? createHandle(target, messageIds)
                            : undefined)
                        : inactive();
                }
            });
        },
        async editView(handle, view) {
            const resolved = resolveHandle(handle);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const rendered = render(view);
            if (!rendered.ok)
                return failure(rendered.reason, rendered.message);
            const target = resolved.value.target;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                const visibleMessageIds = [...resolved.value.messageIds];
                try {
                    const sharedCount = Math.min(visibleMessageIds.length, rendered.value.length);
                    for (let index = 0; index < sharedCount; index += 1) {
                        if (!active)
                            return inactive();
                        await deps.editChunk(target, visibleMessageIds[index], rendered.value[index], getChunkTransportOptions(view, index, rendered.value.length, undefined, true));
                        if (!active)
                            return inactive();
                    }
                    for (let index = sharedCount; index < rendered.value.length; index += 1) {
                        if (!active)
                            return inactive();
                        visibleMessageIds.push(await deps.sendChunk(target, rendered.value[index], getChunkTransportOptions(view, index, rendered.value.length)));
                        if (!active)
                            return inactive();
                    }
                    const removedMessageIds = visibleMessageIds.slice(rendered.value.length);
                    for (const messageId of removedMessageIds) {
                        if (!active)
                            return inactive();
                        await deps.deleteMessage(target, messageId);
                        visibleMessageIds.splice(visibleMessageIds.indexOf(messageId), 1);
                        if (!active)
                            return inactive();
                    }
                    return {
                        ok: true,
                        value: createHandle(target, visibleMessageIds),
                    };
                }
                catch (error) {
                    return active
                        ? transportFailure("edit", error, target, createHandle(target, visibleMessageIds))
                        : inactive();
                }
            });
        },
        async deleteView(handle) {
            const resolved = resolveHandle(handle);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const target = resolved.value.target;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                try {
                    for (const messageId of resolved.value.messageIds) {
                        if (!active)
                            return inactive();
                        await deps.deleteMessage(target, messageId);
                        if (!active)
                            return inactive();
                    }
                    return { ok: true, value: undefined };
                }
                catch (error) {
                    return active
                        ? transportFailure("delete", error, target)
                        : inactive();
                }
            });
        },
        async sendChatAction(action, scope) {
            if (!active)
                return inactive();
            const resolved = resolveTelegramDeliveryTarget(scope, deps);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const target = resolved.value;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                try {
                    await deps.sendChatAction(target, action);
                    if (!active)
                        return inactive();
                    return { ok: true, value: undefined };
                }
                catch (error) {
                    return active
                        ? transportFailure("chat-action", error, target)
                        : inactive();
                }
            });
        },
    };
}
/** @internal */
export function createTelegramBridgeDeliveryRuntime(deps) {
    const getPolicyView = deps.getTargetPolicyView;
    const assertTransportActive = () => {
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
            return isTelegramDeliveryExplicitTargetAuthorized(target, getPolicyView());
        },
        renderView(view) {
            assertTelegramInlineKeyboardCallbackData(view.replyMarkup);
            return renderTelegramMessage(view.text, {
                mode: view.parseMode ?? "plain",
            }).map(function (chunk) {
                return {
                    text: chunk.text,
                    parseMode: chunk.parseMode === "HTML" ? "html" : "plain",
                };
            });
        },
        async sendChunk(target, chunk, options) {
            assertTransportActive();
            const sent = await withTelegramReplyParameters(target.chatId, options.replyToMessageId, target, (replyParameters) => {
                const body = {
                    chat_id: target.chatId,
                    text: chunk.text,
                    ...(chunk.parseMode === "html" ? { parse_mode: "HTML" } : {}),
                    ...getTelegramTargetThreadParams(target),
                    ...(replyParameters ? { reply_parameters: replyParameters } : {}),
                    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
                };
                return deps.api.sendMessage(target.threadId === undefined
                    ? markTelegramBusAggregateDelivery(body)
                    : body);
            });
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
                ...(chunk.parseMode === "html" ? { parse_mode: "HTML" } : {}),
                reply_markup: options.replyMarkup === null
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
function getBoundTelegramDeliveryRuntime() {
    const runtime = getTelegramDeliveryRuntimeRegistry().runtime;
    return (runtime ??
        failure("runtime-unavailable", "Telegram delivery runtime is unavailable in this Pi session."));
}
function isFailure(value) {
    return "ok" in value;
}
function validateView(view) {
    if (typeof view.text !== "string" || view.text.trim().length === 0) {
        return failure("invalid-view", "Telegram delivery view text is empty.");
    }
    return undefined;
}
async function runDeliveryOperation(operation) {
    const runtime = getBoundTelegramDeliveryRuntime();
    if (isFailure(runtime))
        return runtime;
    try {
        return await operation(runtime);
    }
    catch {
        return failure("transport-failed", "Telegram delivery failed.");
    }
}
/** @internal */
export function bindTelegramDeliveryRuntime(runtime) {
    const registry = getTelegramDeliveryRuntimeRegistry();
    if (registry.runtime !== runtime)
        registry.runtime?.shutdown();
    registry.runtime = runtime;
    return () => {
        if (registry.runtime === runtime)
            registry.runtime = undefined;
    };
}
/** @internal */
export function clearTelegramDeliveryRuntime() {
    const registry = getTelegramDeliveryRuntimeRegistry();
    registry.runtime?.shutdown();
    registry.runtime = undefined;
}
/** @internal */
export function isTelegramDeliveryHandleCurrent(handle) {
    const runtime = getTelegramDeliveryRuntimeRegistry().runtime;
    return runtime !== undefined && runtime.generation === handle.generation;
}
export async function sendTelegramView(view, options) {
    const invalid = validateView(view);
    if (invalid)
        return invalid;
    return runDeliveryOperation((runtime) => runtime.sendView(view, options));
}
/** @internal Edit an exact Telegram message through the currently bound runtime generation. */
export async function editTelegramTargetView(target, messageId, view) {
    const invalid = validateView(view);
    if (invalid)
        return invalid;
    return runDeliveryOperation((runtime) => runtime.editView({
        target: { ...target },
        messageIds: [messageId],
        generation: runtime.generation,
    }, view));
}
export async function editTelegramView(handle, view) {
    const invalid = validateView(view);
    if (invalid)
        return invalid;
    return runDeliveryOperation((runtime) => {
        if (runtime.generation !== handle.generation) {
            return Promise.resolve(failure("stale-handle", "Telegram delivery handle belongs to an inactive runtime generation."));
        }
        return runtime.editView(handle, view);
    });
}
export async function deleteTelegramView(handle) {
    return runDeliveryOperation((runtime) => {
        if (runtime.generation !== handle.generation) {
            return Promise.resolve(failure("stale-handle", "Telegram delivery handle belongs to an inactive runtime generation."));
        }
        return runtime.deleteView(handle);
    });
}
export async function sendTelegramChatAction(action, options) {
    return runDeliveryOperation((runtime) => runtime.sendChatAction(action, options.scope));
}
