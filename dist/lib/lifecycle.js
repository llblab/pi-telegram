/**
 * Telegram lifecycle hook registration helpers
 * Zones: pi agent lifecycle, telegram session
 * Binds prepared Telegram lifecycle runtimes to pi extension lifecycle events
 */
import * as BusFollower from "./bus-follower.js";
import * as Queue from "./queue.js";
import * as TextGroups from "./text-groups.js";
let resetTransportReplyDedupFn;
export function setResetTransportReplyDedup(fn) {
    resetTransportReplyDedupFn = fn;
}
export function createAgentStartDedupHook(inner, schedulePublication) {
    return async (event, ctx) => {
        const reset = resetTransportReplyDedupFn;
        if (reset) {
            // A new turn must not erase the anchor of a final still ahead in the FIFO.
            if (schedulePublication)
                schedulePublication(async () => { reset(); });
            else
                reset();
        }
        return inner(event, ctx);
    };
}
export function createTelegramSessionContextStore(options = {}) {
    let currentContext;
    let currentIdentity;
    let generation = 0;
    const objectIdentityGenerations = new WeakMap();
    const primitiveIdentityGenerations = new Map();
    const resolveIdentity = (ctx) => options.getIdentity?.(ctx) ?? ctx;
    const getIdentityGeneration = (identity) => (typeof identity === "object" && identity !== null) ||
        typeof identity === "function"
        ? objectIdentityGenerations.get(identity)
        : primitiveIdentityGenerations.get(identity);
    const setIdentityGeneration = (identity, value) => {
        if ((typeof identity === "object" && identity !== null) ||
            typeof identity === "function") {
            objectIdentityGenerations.set(identity, value);
        }
        else {
            primitiveIdentityGenerations.set(identity, value);
        }
    };
    return {
        get: () => currentContext,
        getGeneration: () => generation,
        isCurrent: (ctx, expectedGeneration) => {
            if (currentContext === undefined)
                return false;
            const identity = resolveIdentity(ctx);
            return (identity === currentIdentity &&
                getIdentityGeneration(identity) === generation &&
                (expectedGeneration === undefined || generation === expectedGeneration));
        },
        set: (ctx) => {
            currentContext = ctx;
            currentIdentity = resolveIdentity(ctx);
            generation += 1;
            setIdentityGeneration(currentIdentity, generation);
            return generation;
        },
        clear: (ctx) => {
            if (ctx !== undefined) {
                const identity = resolveIdentity(ctx);
                if (identity !== currentIdentity ||
                    getIdentityGeneration(identity) !== generation) {
                    return false;
                }
            }
            if (currentContext === undefined)
                return false;
            currentContext = undefined;
            currentIdentity = undefined;
            generation += 1;
            return true;
        },
    };
}
export function createTelegramSessionGenerationFence(store, hooks) {
    return {
        async onSessionStart(event, ctx) {
            const generation = store.set(ctx);
            await hooks.onSessionStart(event, ctx);
            if (!store.isCurrent(ctx, generation))
                return;
        },
        async onSessionShutdown(event, ctx) {
            const generation = store.getGeneration();
            if (!store.isCurrent(ctx, generation))
                return;
            await hooks.onSessionShutdown(event, ctx);
            if (store.isCurrent(ctx, generation))
                store.clear(ctx);
        },
    };
}
export function createTelegramBridgeSessionLifecycleDeps(ports) {
    return {
        contextStore: ports.contextStore,
        queue: ports.queue,
        follower: ports.follower,
        services: {
            resumeGroupedInput(ctx) {
                ports.services.mediaGroup.resume(ctx);
                ports.services.textGroup.resume(ctx);
            },
            suspendGroupedInput: TextGroups.createTelegramGroupedInputClearer({
                clearMediaGroups: ports.services.mediaGroup.suspend,
                clearTextGroups: ports.services.textGroup.suspend,
            }),
            delivery: ports.services.delivery,
            polling: ports.services.polling,
            inboundWorker: ports.services.inboundWorker,
            capabilityMonitor: ports.services.capabilityMonitor,
            queueWatchdog: ports.services.queueWatchdog,
            guestPlaceholder: ports.services.guestPlaceholder,
            prepareThreadPreservationOnQuit: ports.services.prepareThreadPreservationOnQuit,
        },
    };
}
export function createTelegramBridgeSessionLifecycleAssembly(deps) {
    const isSessionActive = deps.contextStore.isCurrent;
    const suspendForReplacement = BusFollower.createTelegramBusFollowerSessionReplacementSuspender({
        registrationState: deps.follower.registrationState,
        instanceId: deps.follower.instanceId,
        suspendPolling: deps.follower.suspendPolling,
        recordRuntimeEvent: deps.follower.recordRuntimeEvent,
    });
    const queueLifecycle = Queue.createTelegramSessionLifecycleRuntime({
        ...deps.queue,
        isSessionActive,
        stopPolling: suspendForReplacement,
        clearPendingMediaGroups: deps.services.suspendGroupedInput,
    });
    const servicesLifecycle = {
        async onSessionStart(event, ctx) {
            await queueLifecycle.onSessionStart(event, ctx);
            if (!isSessionActive(ctx))
                return;
            deps.services.resumeGroupedInput(ctx);
            await deps.services.delivery.onSessionStart();
            await deps.services.polling.onSessionStart(event, ctx);
            deps.services.capabilityMonitor.start(ctx);
            deps.services.queueWatchdog.start(ctx);
        },
        async onSessionShutdown(event, ctx) {
            const generation = deps.contextStore.getGeneration();
            const isCurrent = () => deps.contextStore.isCurrent(ctx, generation);
            if (!isCurrent())
                return;
            let preserveThread;
            if (event.reason === "quit") {
                try {
                    preserveThread = deps.services.prepareThreadPreservationOnQuit?.(isCurrent);
                }
                catch (error) {
                    deps.follower.recordRuntimeEvent("session", error, { phase: "preserve-thread-on-quit" });
                }
            }
            deps.services.guestPlaceholder?.stopAll();
            await deps.services.delivery.onSessionShutdown();
            if (!isCurrent())
                return;
            deps.services.queueWatchdog.stop();
            deps.services.capabilityMonitor.stop();
            await queueLifecycle.onSessionShutdown(event, ctx);
            if (!isCurrent())
                return;
            await deps.services.inboundWorker.onSessionShutdown();
            if (!isCurrent())
                return;
            try {
                await preserveThread?.();
            }
            catch (error) {
                deps.follower.recordRuntimeEvent("session", error, { phase: "preserve-thread-on-quit" });
            }
        },
    };
    const followerLifecycle = appendTelegramLifecycleHooks(servicesLifecycle, {
        onSessionStart: BusFollower.createTelegramBusFollowerSessionRefreshHook({
            registrationState: deps.follower.registrationState,
            registrationRuntime: deps.follower.registrationRuntime,
            getLeaderState: deps.follower.getLeaderState,
            isSessionActive,
            updateStatus: deps.follower.updateStatus,
            recordRuntimeEvent: deps.follower.recordRuntimeEvent,
        }),
    }, isSessionActive);
    return createTelegramSessionGenerationFence(deps.contextStore, followerLifecycle);
}
function unrefTelegramLifecycleTimer(timer) {
    if (!timer || typeof timer !== "object")
        return;
    if (typeof timer.unref === "function")
        timer.unref();
}
export function createTelegramCompactionObserverRuntime(deps) {
    const timeoutMs = deps.timeoutMs ?? 300_000;
    const setTimer = deps.setTimer ?? setTimeout;
    const clearTimer = deps.clearTimer ?? clearTimeout;
    let fallbackTimer;
    let observationGeneration = 0;
    let typingStartedByObserver = false;
    const clearFallbackTimer = () => {
        observationGeneration += 1;
        if (!fallbackTimer)
            return;
        clearTimer(fallbackTimer);
        fallbackTimer = undefined;
    };
    const requestDispatch = () => {
        deps.requestDeferredDispatchNextQueuedTelegramTurn(deps.dispatchNextQueuedTelegramTurn);
    };
    return {
        onSessionBeforeCompact: (_event, ctx) => {
            if (deps.isContextActive && !deps.isContextActive(ctx))
                return;
            deps.setCompactionInProgress(true);
            const typingStartResult = deps.startTypingLoop?.(ctx);
            typingStartedByObserver =
                !!deps.startTypingLoop && typingStartResult !== false;
            deps.updateStatus(ctx);
            clearFallbackTimer();
            const admittedGeneration = observationGeneration;
            fallbackTimer = setTimer(() => {
                if (observationGeneration !== admittedGeneration)
                    return;
                observationGeneration += 1;
                fallbackTimer = undefined;
                if (deps.isContextActive && !deps.isContextActive(ctx))
                    return;
                deps.setCompactionInProgress(false);
                if (typingStartedByObserver)
                    deps.stopTypingLoop?.();
                typingStartedByObserver = false;
                deps.updateStatus(ctx);
                deps.recordRuntimeEvent?.("compact", new Error("Compaction observer timed out"));
                deps.onCompactionAbandoned?.();
                requestDispatch();
            }, timeoutMs);
            unrefTelegramLifecycleTimer(fallbackTimer);
        },
        onSessionCompact: (_event, ctx) => {
            if (deps.isContextActive && !deps.isContextActive(ctx))
                return;
            clearFallbackTimer();
            deps.setCompactionInProgress(false);
            if (typingStartedByObserver)
                deps.stopTypingLoop?.();
            typingStartedByObserver = false;
            deps.updateStatus(ctx);
            requestDispatch();
        },
        onSessionCompactFailed: (_event, ctx) => {
            if (deps.isContextActive && !deps.isContextActive(ctx))
                return;
            clearFallbackTimer();
            deps.setCompactionInProgress(false);
            if (typingStartedByObserver)
                deps.stopTypingLoop?.();
            typingStartedByObserver = false;
            deps.updateStatus(ctx);
            deps.onCompactionAbandoned?.();
            requestDispatch();
        },
        onSessionShutdown: () => {
            clearFallbackTimer();
            if (typingStartedByObserver)
                deps.stopTypingLoop?.();
            typingStartedByObserver = false;
        },
    };
}
export function createTelegramMessageActivityTypingHooks(deps) {
    const ensureTyping = (ctx) => {
        if (deps.hasActiveTurn())
            deps.startTypingLoop(ctx);
    };
    const handleMessageActivity = async (phase, event, ctx, inner) => {
        const typedCtx = ctx;
        ensureTyping(typedCtx);
        try {
            await inner(event, ctx);
        }
        catch (error) {
            deps.recordRuntimeEvent?.("message-activity", error, { phase });
        }
        finally {
            ensureTyping(typedCtx);
        }
    };
    return {
        onMessageStart: (event, ctx) => handleMessageActivity("start", event, ctx, deps.onMessageStart),
        onMessageUpdate: (event, ctx) => handleMessageActivity("update", event, ctx, deps.onMessageUpdate),
    };
}
export function createDedupAgentStartHook(dedup, inner) {
    return async (event, ctx) => {
        dedup.reset();
        await inner(event, ctx);
    };
}
export function appendTelegramLifecycleHooks(base, extra, isSessionActive) {
    return {
        onSessionStart: async (event, ctx) => {
            await base.onSessionStart(event, ctx);
            if (isSessionActive?.(ctx) === false)
                return;
            await extra.onSessionStart?.(event, ctx);
        },
        onSessionShutdown: async (event, ctx) => {
            await base.onSessionShutdown(event, ctx);
            if (isSessionActive?.(ctx) === false)
                return;
            await extra.onSessionShutdown?.(event, ctx);
        },
    };
}
export function registerTelegramLifecycleHooks(pi, deps) {
    const isActive = (ctx) => deps.isSessionActive?.(ctx) !== false;
    pi.on("input", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onInput?.(event, ctx);
    });
    pi.on("session_start", async (event, ctx) => {
        await deps.onSessionStart(event, ctx);
    });
    pi.on("session_shutdown", async (event, ctx) => {
        await deps.onSessionShutdown(event, ctx);
    });
    pi.on("session_before_compact", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onSessionBeforeCompact?.(event, ctx);
    });
    pi.on("session_compact", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onSessionCompact?.(event, ctx);
    });
    pi.on("session_compact_failed", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onSessionCompactFailed?.(event, ctx);
    });
    // The Pi SDK still types this result as a string; compatible runtimes may
    // preserve ordered system prompt blocks through the same public hook.
    const registerBeforeAgentStart = pi.on.bind(pi);
    registerBeforeAgentStart("before_agent_start", async (event, ctx) => {
        return deps.onBeforeAgentStart(event, ctx);
    });
    pi.on("model_select", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onModelSelect(event, ctx);
    });
    pi.on("agent_start", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onAgentStart(event, ctx);
    });
    pi.on("tool_execution_start", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onToolExecutionStart(event, ctx);
    });
    pi.on("tool_execution_update", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onToolExecutionUpdate?.(event, ctx);
    });
    pi.on("tool_execution_end", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onToolExecutionEnd(event, ctx);
    });
    pi.on("message_start", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onMessageStart(event, ctx);
    });
    pi.on("message_update", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onMessageUpdate(event, ctx);
    });
    pi.on("message_end", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onMessageEnd?.(event, ctx);
    });
    pi.on("ui_prompt_start", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onUiPromptStart?.(event, ctx);
    });
    pi.on("ui_prompt_end", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onUiPromptEnd?.(event, ctx);
    });
    pi.on("agent_end", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onAgentEnd(event, ctx);
    });
    pi.on("agent_settled", async (event, ctx) => {
        if (!isActive(ctx))
            return;
        await deps.onAgentSettled?.(event, ctx);
    });
}
