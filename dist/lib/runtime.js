/**
 * Telegram bridge runtime-state helpers
 * Zones: pi agent runtime state, telegram session, shared coordination
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Telegram transport
 */
import * as Machine from "./machine.js";
/** A faulty diagnostics port must not break its owning loop, probe, interval callback or completed outcome. */
function guardTelegramRepeatedFailureLog(port) {
    const guarded = (call) => (...args) => {
        try {
            call(...args);
        }
        catch {
            // Diagnostics are best-effort.
        }
    };
    return {
        record: guarded((error, details) => port.record(error, details)),
        settled: guarded(() => port.settled()),
        reset: guarded(() => port.reset()),
    };
}
const TELEGRAM_TYPING_ACTION_INTERVAL_MS = 3_000;
const TELEGRAM_TYPING_IDLE_DRAIN_MAX_MS = 250;
export function createTelegramBridgeRuntimeState() {
    return {
        nextQueuedTelegramItemOrder: 0,
        nextQueuedTelegramControlOrder: 0,
        activeTelegramToolExecutions: 0,
        telegramTurnDispatchPending: false,
        compactionInProgress: false,
        foldQueuedPromptsIntoHistory: false,
        setupInProgress: false,
    };
}
export function createTelegramBridgeRuntime(state = createTelegramBridgeRuntimeState(), typing = createTelegramTypingLoop()) {
    return {
        state,
        queue: {
            syncCounters: (counters) => syncTelegramQueueRuntimeCounters(state, counters),
            allocateItemOrder: () => allocateTelegramQueueItemOrder(state),
            allocateControlOrder: () => allocateTelegramQueueControlOrder(state),
        },
        lifecycle: {
            syncFlags: (flags) => syncTelegramLifecycleRuntimeFlags(state, flags),
            getActiveToolExecutions: () => getActiveTelegramToolExecutions(state),
            setActiveToolExecutions: (count) => setActiveTelegramToolExecutions(state, count),
            resetActiveToolExecutions: () => resetActiveTelegramToolExecutions(state),
            hasDispatchPending: () => hasTelegramDispatchPending(state),
            setDispatchPending: (pending) => setTelegramDispatchPending(state, pending),
            clearDispatchPending: () => clearTelegramDispatchPending(state),
            isCompactionInProgress: () => isTelegramCompactionInProgress(state),
            setCompactionInProgress: (inProgress) => setTelegramCompactionInProgress(state, inProgress),
            shouldFoldQueuedPromptsIntoHistory: () => shouldFoldQueuedPromptsIntoHistory(state),
            setFoldQueuedPromptsIntoHistory: (fold) => setFoldQueuedPromptsIntoHistory(state, fold),
        },
        setup: {
            isInProgress: () => isTelegramSetupInProgress(state),
            start: () => startTelegramSetup(state),
            finish: () => finishTelegramSetup(state),
        },
        abort: {
            hasHandler: () => hasTelegramAbortHandler(state),
            setHandler: (abortHandler) => setTelegramAbortHandler(state, abortHandler),
            clearHandler: () => clearTelegramAbortHandler(state),
            getHandler: () => getTelegramAbortHandler(state),
            abortTurn: () => abortTelegramTurn(state),
        },
        typing,
    };
}
export function syncTelegramQueueRuntimeCounters(state, counters) {
    if (counters.nextQueuedTelegramItemOrder !== undefined) {
        state.nextQueuedTelegramItemOrder = counters.nextQueuedTelegramItemOrder;
    }
    if (counters.nextQueuedTelegramControlOrder !== undefined) {
        state.nextQueuedTelegramControlOrder =
            counters.nextQueuedTelegramControlOrder;
    }
}
export function allocateTelegramQueueItemOrder(state) {
    return state.nextQueuedTelegramItemOrder++;
}
export function allocateTelegramQueueControlOrder(state) {
    return state.nextQueuedTelegramControlOrder++;
}
export function syncTelegramLifecycleRuntimeFlags(state, flags) {
    if (flags.activeTelegramToolExecutions !== undefined) {
        state.activeTelegramToolExecutions = flags.activeTelegramToolExecutions;
    }
    if (flags.telegramTurnDispatchPending !== undefined) {
        state.telegramTurnDispatchPending = flags.telegramTurnDispatchPending;
    }
    if (flags.compactionInProgress !== undefined) {
        state.compactionInProgress = flags.compactionInProgress;
    }
    if (flags.foldQueuedPromptsIntoHistory !== undefined) {
        state.foldQueuedPromptsIntoHistory = flags.foldQueuedPromptsIntoHistory;
    }
    if (flags.setupInProgress !== undefined) {
        state.setupInProgress = flags.setupInProgress;
    }
}
export function getActiveTelegramToolExecutions(state) {
    return state.activeTelegramToolExecutions;
}
export function setActiveTelegramToolExecutions(state, count) {
    state.activeTelegramToolExecutions = count;
}
export function resetActiveTelegramToolExecutions(state) {
    state.activeTelegramToolExecutions = 0;
}
export function hasTelegramDispatchPending(state) {
    return state.telegramTurnDispatchPending;
}
function setTelegramDispatchPending(state, pending) {
    state.telegramTurnDispatchPending = pending;
}
export function clearTelegramDispatchPending(state) {
    state.telegramTurnDispatchPending = false;
}
export function isTelegramCompactionInProgress(state) {
    return state.compactionInProgress;
}
export function setTelegramCompactionInProgress(state, inProgress) {
    state.compactionInProgress = inProgress;
}
export function shouldFoldQueuedPromptsIntoHistory(state) {
    return state.foldQueuedPromptsIntoHistory;
}
export function setFoldQueuedPromptsIntoHistory(state, fold) {
    state.foldQueuedPromptsIntoHistory = fold;
}
export function isTelegramSetupInProgress(state) {
    return state.setupInProgress;
}
export function startTelegramSetup(state) {
    if (state.setupInProgress)
        return false;
    state.setupInProgress = true;
    return true;
}
export function finishTelegramSetup(state) {
    state.setupInProgress = false;
}
export function hasTelegramAbortHandler(state) {
    return !!state.abortHandler;
}
export function setTelegramAbortHandler(state, abortHandler) {
    state.abortHandler = abortHandler;
}
export function clearTelegramAbortHandler(state) {
    state.abortHandler = undefined;
}
export function getTelegramAbortHandler(state) {
    return state.abortHandler;
}
export function abortTelegramTurn(state) {
    if (!state.abortHandler)
        return false;
    state.abortHandler();
    return true;
}
function updateTelegramRuntimeStatusSafely(updateStatus, ctx, options) {
    try {
        updateStatus(ctx, options.error);
    }
    catch (statusError) {
        try {
            options.recordRuntimeEvent?.(options.category, statusError, {
                phase: options.phase,
            });
        }
        catch {
            // Status diagnostics cannot escape an asynchronous runtime owner.
        }
    }
}
export function createTelegramTypingLoopStarter(deps) {
    let currentOwner;
    // An unreachable transport repeats one identical presence failure every tick; the port collapses the run.
    const typingFailureLog = guardTelegramRepeatedFailureLog(deps.failureLog);
    return (ctx, chatId, options) => {
        const sessionGeneration = deps.getSessionGeneration?.();
        const transportAuthority = deps.getTransportAuthority?.();
        const isContextCurrent = () => deps.isContextActive?.(ctx) !== false &&
            (!deps.getSessionGeneration || Object.is(deps.getSessionGeneration(), sessionGeneration));
        const hasTransport = () => deps.getTransportAuthority
            ? transportAuthority !== undefined &&
                Object.is(deps.getTransportAuthority(), transportAuthority)
            : deps.isTransportAvailable?.() !== false;
        const target = options?.target ? { ...options.target } : undefined;
        const canContinue = () => isContextCurrent() && hasTransport() &&
            (deps.isThreadedMode?.() !== true ||
                (target?.threadId !== undefined && Number.isSafeInteger(target.threadId) && target.threadId > 0));
        // Queue dispatch precedes agent_start: only an explicit destination permits Threaded presence, never chat fallback.
        if (!canContinue())
            return false;
        const resolvedChatId = chatId ?? deps.getDefaultChatId();
        if (resolvedChatId === undefined || resolvedChatId === 0)
            return false;
        // Streaming updates ensure presence without revoking the same owner's pending HTTP/IPC action.
        // Explicit starts still replace the loop, including a new turn on the same session and Thread.
        if (options?.ensure && currentOwner?.canContinue() &&
            (deps.getSessionGeneration
                ? Object.is(currentOwner.sessionGeneration, sessionGeneration)
                : Object.is(currentOwner.ctx, ctx)) &&
            Object.is(currentOwner.transportAuthority, transportAuthority) &&
            currentOwner.chatId === resolvedChatId && currentOwner.threadId === target?.threadId)
            return false;
        const owner = { ctx, sessionGeneration, transportAuthority, chatId: resolvedChatId,
            threadId: target?.threadId, canContinue };
        currentOwner = owner;
        let active = true;
        return deps.typing.start({
            chatId: resolvedChatId,
            target,
            intervalMs: deps.intervalMs ?? TELEGRAM_TYPING_ACTION_INTERVAL_MS,
            sendTypingAction: async (targetChatId, actionOptions) => {
                if (!active)
                    return;
                if (!canContinue()) {
                    deps.typing.stop();
                    return;
                }
                try {
                    await deps.sendTypingAction(targetChatId, {
                        ...actionOptions,
                        isCancelled: () => !active,
                        // This stays process-local; adapters recheck it before HTTP/IPC issuance, not just loop ticks.
                        assertAuthority() {
                            if (!active || !canContinue())
                                throw new Error("Typing context authority changed.");
                        },
                    });
                    typingFailureLog.settled();
                }
                catch (error) {
                    if (!active)
                        return;
                    if (!canContinue()) {
                        deps.typing.stop();
                        return;
                    }
                    typingFailureLog.record(error, { chatId: targetChatId });
                }
            },
            shouldContinue: canContinue,
            onStopped: () => {
                active = false;
                typingFailureLog.reset();
                if (currentOwner === owner)
                    currentOwner = undefined;
            },
        });
    };
}
function getTelegramTypingLoopKey(deps) {
    const threadId = deps.target?.threadId;
    return `${deps.chatId ?? 0}:${Number.isInteger(threadId) ? threadId : "all"}`;
}
export function createTelegramTypingMachineState() {
    return { loop: null, inFlight: null, nextSendId: 0 };
}
const typingStep = (state, result, ...effects) => ({ state, effects, result });
function stopTypingLoop(state) {
    if (!state.loop)
        return typingStep(state, false);
    return typingStep({ ...state, loop: null, inFlight: null }, true, { type: "cancelInterval" }, { type: "loopEnded", loopId: state.loop.id });
}
/** One action per tick, never two at once; a caller that stops continuing ends the loop instead. */
function sendTypingAction(state, continues) {
    const loop = state.loop;
    if (!loop)
        return typingStep(state, false);
    if (!continues)
        return stopTypingLoop(state);
    if (state.inFlight !== null)
        return typingStep(state, false);
    const sendId = state.nextSendId + 1;
    return typingStep({ ...state, inFlight: sendId, nextSendId: sendId }, false, {
        type: "send",
        loopId: loop.id,
        sendId,
        chatId: loop.chatId,
        ...(loop.threadParams ? { threadParams: loop.threadParams } : {}),
    });
}
/**
 * Pure typing-loop transition. Every start replaces the caller's callbacks, even on the same target, and forgets the
 * old in-flight action; only a new target sends at once on a running loop, whose interval keeps its phase.
 */
export function transitionTelegramTypingLoop(state, event) {
    switch (event.type) {
        case "started": {
            if (event.chatId === undefined || event.chatId === 0)
                return typingStep(state, false);
            const previous = state.loop;
            const replaced = previous
                ? [{ type: "loopEnded", loopId: previous.id }]
                : [];
            const next = {
                ...state,
                inFlight: previous ? null : state.inFlight,
                loop: {
                    id: event.loopId,
                    key: event.key,
                    chatId: event.chatId,
                    ...(event.threadParams ? { threadParams: event.threadParams } : {}),
                },
            };
            if (previous?.key === event.key)
                return typingStep(next, false, ...replaced);
            if (previous) {
                const sent = sendTypingAction(next, event.continues);
                return typingStep(sent.state, true, ...replaced, ...sent.effects);
            }
            // A fresh loop always arms its interval; a caller that already stopped continuing ends it on the first tick.
            const sent = event.continues
                ? sendTypingAction(next, true)
                : typingStep(next, false);
            return typingStep(sent.state, true, ...sent.effects, {
                type: "armInterval",
                intervalMs: event.intervalMs,
            });
        }
        case "ticked":
            return sendTypingAction(state, event.continues);
        case "sendSettled":
            return typingStep(state.inFlight === event.sendId ? { ...state, inFlight: null } : state, false);
        case "stopRequested":
            return stopTypingLoop(state);
    }
}
/**
 * The shell around `transitionTelegramTypingLoop`: it holds each loop's callbacks, samples `shouldContinue` into
 * events, owns the interval and turns every action outcome into `sendSettled`.
 */
export function createTelegramTypingLoop() {
    const callbacks = new Map();
    let interval;
    let loopIds = 0;
    const continues = (loopId) => loopId === undefined
        ? false
        : callbacks.get(loopId)?.shouldContinue?.() !== false;
    const machine = Machine.createTelegramMachineRunner({
        initial: createTelegramTypingMachineState(),
        transition: transitionTelegramTypingLoop,
        run(effect) {
            switch (effect.type) {
                case "send": {
                    const send = callbacks.get(effect.loopId)?.sendTypingAction;
                    // Failures belong to the caller's action; the loop only needs to know the action is over.
                    void Promise.resolve()
                        .then(() => send?.(effect.chatId, effect.threadParams))
                        .then(() => undefined, () => undefined)
                        .then(() => machine.dispatch({ type: "sendSettled", sendId: effect.sendId }));
                    return;
                }
                case "armInterval":
                    interval = setInterval(() => machine.dispatch({
                        type: "ticked",
                        continues: continues(machine.state.loop?.id),
                    }), effect.intervalMs);
                    interval.unref?.();
                    return;
                case "cancelInterval":
                    clearInterval(interval);
                    interval = undefined;
                    return;
                case "loopEnded": {
                    const ended = callbacks.get(effect.loopId);
                    callbacks.delete(effect.loopId);
                    ended?.onStopped?.();
                    return;
                }
            }
        },
    });
    return {
        start(deps) {
            const loopId = ++loopIds;
            callbacks.set(loopId, deps);
            const threadId = deps.target?.threadId;
            const started = machine.dispatch({
                type: "started",
                loopId,
                chatId: deps.chatId,
                key: getTelegramTypingLoopKey(deps),
                ...(Number.isInteger(threadId)
                    ? { threadParams: { message_thread_id: threadId } }
                    : {}),
                intervalMs: deps.intervalMs,
                continues: continues(loopId),
            });
            if (machine.state.loop?.id !== loopId)
                callbacks.delete(loopId);
            return started.result;
        },
        stop: () => machine.dispatch({ type: "stopRequested" }).result,
        async waitForIdle(timeoutMs = TELEGRAM_TYPING_IDLE_DRAIN_MAX_MS) {
            if (machine.state.inFlight === null)
                return;
            const idle = machine.waitFor((state) => state.inFlight === null);
            await Promise.race([
                idle,
                timeoutMs <= 0
                    ? Promise.resolve()
                    : new Promise((resolve) => setTimeout(resolve, timeoutMs)),
            ]);
        },
    };
}
export function createTelegramContextAbortHandlerSetter(abort) {
    return (ctx) => {
        abort.setHandler(() => ctx.abort());
    };
}
export function createTelegramAgentEndResetter(deps) {
    return () => {
        deps.abort.clearHandler();
        deps.typing.stop();
        deps.clearActiveTurn();
        deps.resetToolExecutions();
        deps.clearPendingModelSwitch();
        deps.clearDispatchPending();
    };
}
export function createTelegramPromptDispatchRuntime(deps) {
    const startTypingLoop = createTelegramTypingLoopStarter(deps);
    return {
        startTypingLoop,
        ...createTelegramPromptDispatchLifecycle({
            lifecycle: deps.lifecycle,
            typing: deps.typing,
            startTypingLoop,
            updateStatus: deps.updateStatus,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        }),
    };
}
export function createTelegramPromptDispatchLifecycle(deps) {
    return {
        onPromptDispatchStart: (ctx, chatId, target) => {
            deps.lifecycle.setDispatchPending(true);
            deps.startTypingLoop(ctx, chatId, { target });
            updateTelegramRuntimeStatusSafely(deps.updateStatus, ctx, {
                category: "dispatch",
                phase: "status-update",
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
        onPromptDispatchFailure: (ctx, message) => {
            deps.lifecycle.clearDispatchPending();
            deps.typing.stop();
            deps.recordRuntimeEvent?.("dispatch", new Error(message));
            updateTelegramRuntimeStatusSafely(deps.updateStatus, ctx, {
                error: `dispatch failed: ${message}`,
                category: "dispatch",
                phase: "status-update",
                recordRuntimeEvent: deps.recordRuntimeEvent,
            });
        },
    };
}
