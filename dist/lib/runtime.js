/**
 * Telegram bridge runtime-state helpers
 * Zones: pi agent runtime state, telegram session, shared coordination
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Telegram transport
 */
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
export function createTelegramBridgeRuntime(state = createTelegramBridgeRuntimeState()) {
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
        typing: {
            start: (deps) => startTelegramTypingLoop(state, deps),
            stop: () => stopTelegramTypingLoop(state),
            waitForIdle: () => waitForTelegramTypingLoopIdle(state),
        },
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
function getTelegramTypingLoopThreadParams(target) {
    const threadId = target?.threadId;
    return Number.isInteger(threadId)
        ? { message_thread_id: threadId }
        : undefined;
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
    return (ctx, chatId, options) => {
        const transportAuthority = deps.getTransportAuthority?.();
        const hasTransport = () => deps.getTransportAuthority
            ? transportAuthority !== undefined &&
                Object.is(deps.getTransportAuthority(), transportAuthority)
            : deps.isTransportAvailable?.() !== false;
        if (!hasTransport())
            return false;
        let active = true;
        return deps.typing.start({
            chatId: chatId ?? deps.getDefaultChatId(),
            target: options?.target,
            intervalMs: deps.intervalMs ?? TELEGRAM_TYPING_ACTION_INTERVAL_MS,
            sendTypingAction: async (targetChatId, actionOptions) => {
                if (!active)
                    return;
                if (!hasTransport()) {
                    deps.typing.stop();
                    return;
                }
                try {
                    await deps.sendTypingAction(targetChatId, actionOptions);
                }
                catch (error) {
                    if (deps.isContextActive?.(ctx) === false)
                        return;
                    if (!active)
                        return;
                    if (!hasTransport()) {
                        deps.typing.stop();
                        return;
                    }
                    try {
                        deps.recordRuntimeEvent?.("typing", error, {
                            chatId: targetChatId,
                        });
                    }
                    catch {
                        // Typing diagnostics cannot escape the in-flight action owner.
                    }
                }
            },
            shouldContinue: hasTransport,
            onStopped: () => {
                active = false;
            },
        });
    };
}
function getTelegramTypingLoopKey(deps) {
    const threadId = deps.target?.threadId;
    return `${deps.chatId ?? 0}:${Number.isInteger(threadId) ? threadId : "all"}`;
}
export function startTelegramTypingLoop(state, deps) {
    if (deps.chatId === undefined || deps.chatId === 0)
        return false;
    const previousKey = state.typingLoopKey;
    const previousDeps = state.typingLoopDeps;
    const nextKey = getTelegramTypingLoopKey(deps);
    if (previousDeps && previousDeps !== deps) {
        previousDeps.onStopped?.();
        state.typingInFlight = undefined;
    }
    state.typingLoopDeps = deps;
    state.typingLoopKey = nextKey;
    const sendTyping = () => {
        const activeDeps = state.typingLoopDeps;
        if (!activeDeps ||
            activeDeps.chatId === undefined ||
            activeDeps.chatId === 0)
            return;
        if (activeDeps.shouldContinue?.() === false) {
            stopTelegramTypingLoop(state);
            return;
        }
        if (state.typingInFlight)
            return;
        const targetChatId = activeDeps.chatId;
        const threadParams = getTelegramTypingLoopThreadParams(activeDeps.target);
        const typing = Promise.resolve()
            .then(() => activeDeps.sendTypingAction(targetChatId, threadParams))
            .then(() => undefined)
            .catch(() => undefined);
        state.typingInFlight = typing;
        void typing.finally(() => {
            if (state.typingInFlight === typing)
                state.typingInFlight = undefined;
        });
    };
    if (state.typingInterval) {
        if (previousKey === nextKey)
            return false;
        sendTyping();
        return true;
    }
    sendTyping();
    state.typingInterval = setInterval(sendTyping, deps.intervalMs);
    state.typingInterval.unref?.();
    return true;
}
export function stopTelegramTypingLoop(state) {
    if (!state.typingInterval)
        return false;
    clearInterval(state.typingInterval);
    const activeDeps = state.typingLoopDeps;
    state.typingInterval = undefined;
    state.typingLoopDeps = undefined;
    state.typingLoopKey = undefined;
    state.typingInFlight = undefined;
    activeDeps?.onStopped?.();
    return true;
}
export async function waitForTelegramTypingLoopIdle(state, timeoutMs = TELEGRAM_TYPING_IDLE_DRAIN_MAX_MS) {
    const inFlight = state.typingInFlight;
    if (!inFlight)
        return;
    if (timeoutMs <= 0) {
        await Promise.race([inFlight, Promise.resolve()]);
        return;
    }
    await Promise.race([
        inFlight,
        new Promise((resolve) => {
            setTimeout(resolve, timeoutMs);
        }),
    ]);
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
        onPromptDispatchStart: (ctx, chatId) => {
            deps.lifecycle.setDispatchPending(true);
            deps.startTypingLoop(ctx, chatId);
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
