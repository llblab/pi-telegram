/**
 * Telegram session lifecycle coordination and hook registration
 * Zones: pi agent lifecycle, telegram session
 * Owns context generations, bounded connect intent across resume, and session sequencing.
 * Transport authority, durable bindings, and queue custody remain with their owners.
 */
import { randomUUID } from "node:crypto";
import * as BusFollower from "./bus-follower.js";
import * as Machine from "./machine.js";
import * as Queue from "./queue.js";
import { formatTelegramConnectionFailure } from "./status.js";
import * as TextGroups from "./text-groups.js";
export function createAgentStartDedupHook(inner, resetReplyDedup, schedulePublication) {
    return async (event, ctx) => {
        // A new turn must not erase the anchor of a final still ahead in the FIFO.
        if (schedulePublication)
            schedulePublication(async () => {
                resetReplyDedup();
            });
        else
            resetReplyDedup();
        return inner(event, ctx);
    };
}
const HANDOFF_KEY = Symbol.for("pi-telegram.connection-resume.v1");
function processHandoffStore() {
    const globals = globalThis;
    return (globals[HANDOFF_KEY] ??= {});
}
export function createTelegramConnectionLifecycle(deps) {
    return {
        onSessionShutdown(event, ctx) {
            deps.intent.suspend({
                reason: event.reason,
                cwd: ctx.cwd,
                targetSessionFile: event.targetSessionFile,
                connected: deps.isConnected(),
                profileName: deps.getProfileName(),
            });
        },
        prepare(event, ctx) {
            const intent = deps.intent.resume({
                reason: event.reason,
                cwd: ctx.cwd,
                sessionFile: event.reason === "resume"
                    ? ctx.sessionManager.getSessionFile()
                    : undefined,
            });
            if (!intent)
                return undefined;
            const generation = deps.getGeneration();
            const isCurrent = () => deps.intent.isActive(intent.id) &&
                generation === deps.getGeneration() &&
                deps.isCurrent(ctx);
            return () => {
                // Startup remains extension-owned background work; no captured command ctx crosses resume.
                void (async () => {
                    if (!isCurrent())
                        return;
                    if (!(await deps.activateProfile(intent.profileName, isCurrent))) {
                        if (isCurrent())
                            ctx.ui.notify("Telegram profile unavailable. Run /telegram-setup.", "warning");
                        return;
                    }
                    if (!isCurrent())
                        return;
                    const result = await deps.start(ctx);
                    if (!isCurrent())
                        return;
                    if (!result.ok) {
                        deps.recordError(new Error(result.message ?? "Telegram resume connection failed."));
                        ctx.ui.notify(formatTelegramConnectionFailure(result.message), "warning");
                    }
                })()
                    .catch((error) => {
                    deps.recordError(error);
                    if (isCurrent())
                        ctx.ui.notify(formatTelegramConnectionFailure(error), "warning");
                })
                    .finally(() => deps.intent.finish(intent.id));
            };
        },
    };
}
export function createTelegramConnectionIntentRuntime(options = {}) {
    const store = options.store ?? processHandoffStore();
    const now = options.now ?? Date.now;
    const pid = options.pid ?? process.pid;
    let active;
    return {
        begin(cwd, profileName) {
            store.pending = undefined;
            active = { id: randomUUID(), cwd, profileName };
            return active.id;
        },
        isActive(id) {
            return active?.id === id;
        },
        finish(id) {
            if (active?.id === id)
                active = undefined;
        },
        cancel() {
            active = undefined;
            store.pending = undefined;
        },
        suspend(input) {
            const intent = active ??
                (input.connected
                    ? { id: randomUUID(), cwd: input.cwd, profileName: input.profileName }
                    : undefined);
            active = undefined;
            store.pending =
                input.reason === "resume" &&
                    input.targetSessionFile &&
                    intent?.cwd === input.cwd
                    ? {
                        ...intent,
                        pid,
                        targetSessionFile: input.targetSessionFile,
                        expiresAtMs: now() + 30_000,
                    }
                    : undefined;
        },
        resume(input) {
            const handoff = store.pending;
            store.pending = undefined;
            if (!handoff ||
                handoff.pid !== pid ||
                now() >= handoff.expiresAtMs ||
                input.reason !== "resume" ||
                input.cwd !== handoff.cwd ||
                input.sessionFile !== handoff.targetSessionFile)
                return undefined;
            active = {
                id: randomUUID(),
                cwd: handoff.cwd,
                profileName: handoff.profileName,
            };
            return { ...active };
        },
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
/** Artifact disclosure stays bound to the captured session generation and ID, even with reused managers. */
export function createTelegramArtifactSessionCapture(deps) {
    return () => {
        const ctx = deps.context.get(), generation = deps.context.getGeneration(), sessionId = deps.getSessionId(ctx);
        if (ctx === undefined || !sessionId)
            return undefined;
        let lost = false;
        return () => {
            try {
                lost ||= !deps.context.isCurrent(ctx, generation) || deps.getSessionId(deps.context.get()) !== sessionId;
            }
            catch {
                lost = true;
            }
            return !lost;
        };
    };
}
/** Capture drain hints at work admission; late completion never borrows a replacement session or transport. */
export function createTelegramSessionDrainObserver(deps) {
    return () => {
        try {
            const ctx = deps.context.get(), generation = deps.context.getGeneration(), authority = deps.captureAuthority();
            if (ctx === undefined || authority === undefined)
                return undefined;
            return () => {
                queueMicrotask(() => {
                    try {
                        if (!deps.context.isCurrent(ctx, generation) || !deps.isAuthorityActive(authority))
                            return;
                        const emitted = deps.onDrained(ctx);
                        if (emitted)
                            void Promise.resolve(emitted).catch(() => undefined);
                    }
                    catch { /* A drain hint is observational, not execution authority. */ }
                });
            };
        }
        catch {
            return undefined;
        }
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
            connection: ports.services.connection,
            inboundWorker: ports.services.inboundWorker,
            capabilityMonitor: ports.services.capabilityMonitor,
            queueWatchdog: ports.services.queueWatchdog,
            guestPlaceholder: ports.services.guestPlaceholder,
            prepareThreadPreservationOnQuit: ports.services.prepareThreadPreservationOnQuit,
        },
    };
}
export function createTelegramBridgeSessionLifecycleAssembly(deps) {
    const suspendForReplacement = BusFollower.createTelegramBusFollowerSessionReplacementSuspender({
        registrationState: deps.follower.registrationState,
        instanceId: deps.follower.instanceId,
        suspendPolling: deps.follower.suspendPolling,
        recordRuntimeEvent: deps.follower.recordRuntimeEvent,
    });
    // A reused context can be current for a successor; inner awaits need this invocation's generation too.
    const queueLifecycle = (ctx, generation, preserveTarget = true) => Queue.createTelegramSessionLifecycleRuntime({
        ...deps.queue,
        isSessionActive: () => deps.contextStore.isCurrent(ctx, generation),
        stopPolling: () => suspendForReplacement(preserveTarget),
        clearPendingMediaGroups: deps.services.suspendGroupedInput,
    });
    const servicesLifecycle = {
        async onSessionStart(event, ctx) {
            const generation = deps.contextStore.getGeneration();
            const isCurrent = () => deps.contextStore.isCurrent(ctx, generation);
            const resumeConnection = deps.services.connection?.prepare(event, ctx);
            await queueLifecycle(ctx, generation).onSessionStart(event, ctx);
            if (!isCurrent())
                return;
            deps.services.resumeGroupedInput(ctx);
            await deps.services.delivery.onSessionStart();
            if (!isCurrent())
                return;
            if (resumeConnection)
                resumeConnection();
            else
                await deps.services.polling.onSessionStart(event, ctx);
            if (!isCurrent())
                return;
            deps.services.capabilityMonitor.start(ctx);
            deps.services.queueWatchdog.start(ctx);
            await BusFollower.createTelegramBusFollowerSessionRefreshHook({
                registrationState: deps.follower.registrationState,
                registrationRuntime: deps.follower.registrationRuntime,
                getLeaderState: deps.follower.getLeaderState,
                isSessionActive: isCurrent,
                updateStatus: deps.follower.updateStatus,
                recordRuntimeEvent: deps.follower.recordRuntimeEvent,
            })(event, ctx);
        },
        async onSessionShutdown(event, ctx) {
            const generation = deps.contextStore.getGeneration();
            const isCurrent = () => deps.contextStore.isCurrent(ctx, generation);
            if (!isCurrent())
                return;
            deps.services.connection?.onSessionShutdown(event, ctx);
            const preserveTarget = event.reason !== "resume";
            let preserveThread;
            if (event.reason === "quit") {
                try {
                    preserveThread =
                        deps.services.prepareThreadPreservationOnQuit?.(isCurrent);
                }
                catch (error) {
                    deps.follower.recordRuntimeEvent("session", error, {
                        phase: "preserve-thread-on-quit",
                    });
                }
            }
            deps.services.guestPlaceholder?.stopAll();
            await deps.services.delivery.onSessionShutdown();
            if (!isCurrent())
                return;
            deps.services.queueWatchdog.stop();
            deps.services.capabilityMonitor.stop();
            await queueLifecycle(ctx, generation, preserveTarget).onSessionShutdown(event, ctx);
            if (!isCurrent())
                return;
            await deps.services.inboundWorker.onSessionShutdown();
            if (!isCurrent())
                return;
            try {
                await preserveThread?.();
            }
            catch (error) {
                deps.follower.recordRuntimeEvent("session", error, {
                    phase: "preserve-thread-on-quit",
                });
            }
        },
    };
    return createTelegramSessionGenerationFence(deps.contextStore, servicesLifecycle);
}
function unrefTelegramLifecycleTimer(timer) {
    if (!timer || typeof timer !== "object")
        return;
    if (typeof timer.unref === "function")
        timer.unref();
}
export function createTelegramCompactionObserverState() {
    return { observation: null, typingOwned: false, nextObservation: 0 };
}
/**
 * Pure compaction-observer transition. A completion or failure always releases presence; the timeout releases only its
 * own observation. Typing ownership is sticky: a repeated start while the observer's own loop runs reports `false`
 * from the shared loop, and must not hand that loop to nobody.
 */
export function transitionTelegramCompactionObserver(state, event) {
    const cancel = state.observation === null ? [] : [{ type: "cancelTimer" }];
    const release = (...tail) => [
        { type: "setInProgress", inProgress: false },
        ...(state.typingOwned ? [{ type: "stopTyping" }] : []),
        { type: "updateStatus" },
        ...tail,
    ];
    switch (event.type) {
        case "beforeCompact": {
            const observation = state.nextObservation + 1;
            return {
                state: { ...state, observation, nextObservation: observation },
                effects: [
                    { type: "setInProgress", inProgress: true },
                    { type: "startTyping" },
                    { type: "updateStatus" },
                    ...cancel,
                    { type: "armTimer", observation },
                ],
            };
        }
        case "typingStarted":
            return {
                state: { ...state, typingOwned: state.typingOwned || event.started },
                effects: [],
            };
        case "compacted":
            return {
                state: { ...state, observation: null, typingOwned: false },
                effects: [...cancel, ...release({ type: "requestDispatch" })],
            };
        case "compactFailed":
            return {
                state: { ...state, observation: null, typingOwned: false },
                effects: [
                    ...cancel,
                    ...release({ type: "abandoned" }, { type: "requestDispatch" }),
                ],
            };
        case "timerFired":
            if (state.observation !== event.observation)
                return { state, effects: [] };
            // A replaced context consumes its observation without releasing the replacement's presence.
            if (!event.contextActive)
                return { state: { ...state, observation: null }, effects: [] };
            return {
                state: { ...state, observation: null, typingOwned: false },
                effects: release({ type: "recordTimeout" }, { type: "requestDispatch" }),
            };
        case "shutdown":
            return {
                state: { ...state, observation: null, typingOwned: false },
                effects: [
                    ...cancel,
                    ...(state.typingOwned ? [{ type: "stopTyping" }] : []),
                ],
            };
    }
}
/**
 * The shell around `transitionTelegramCompactionObserver`: it fences inactive contexts, runs effects with the calling
 * context, reports the typing start back and owns the fallback timer, which keeps the context it was armed under.
 */
export function createTelegramCompactionObserverRuntime(deps) {
    const timeoutMs = deps.timeoutMs ?? 300_000;
    const setTimer = deps.setTimer ?? setTimeout;
    const clearTimer = deps.clearTimer ?? clearTimeout;
    let fallbackTimer;
    // The context of the event being dispatched; effects run synchronously inside that dispatch.
    let call;
    const machine = Machine.createTelegramMachineRunner({
        initial: createTelegramCompactionObserverState(),
        transition: transitionTelegramCompactionObserver,
        run(effect) {
            const ctx = call;
            switch (effect.type) {
                case "setInProgress":
                    deps.setCompactionInProgress(effect.inProgress);
                    return;
                case "startTyping": {
                    const result = deps.startTypingLoop?.(ctx);
                    machine.dispatch({
                        type: "typingStarted",
                        started: !!deps.startTypingLoop && result !== false,
                    });
                    return;
                }
                case "stopTyping":
                    deps.stopTypingLoop?.();
                    return;
                case "updateStatus":
                    deps.updateStatus(ctx);
                    return;
                case "armTimer": {
                    const armedCtx = ctx;
                    fallbackTimer = setTimer(() => {
                        fallbackTimer = undefined;
                        dispatchFor(armedCtx, {
                            type: "timerFired",
                            observation: effect.observation,
                            contextActive: !deps.isContextActive || deps.isContextActive(armedCtx),
                        });
                    }, timeoutMs);
                    unrefTelegramLifecycleTimer(fallbackTimer);
                    return;
                }
                case "cancelTimer":
                    if (fallbackTimer !== undefined)
                        clearTimer(fallbackTimer);
                    fallbackTimer = undefined;
                    return;
                case "recordTimeout":
                    deps.recordRuntimeEvent?.("compact", new Error("Compaction observer timed out"));
                    return;
                case "abandoned":
                    deps.onCompactionAbandoned?.();
                    return;
                case "requestDispatch":
                    // Observer expiry releases local presence, not Pi's eventual terminal result.
                    deps.requestDeferredDispatchNextQueuedTelegramTurn(deps.dispatchNextQueuedTelegramTurn);
                    return;
            }
        },
    });
    const dispatchFor = (ctx, event) => {
        const previous = call;
        call = ctx;
        try {
            machine.dispatch(event);
        }
        finally {
            call = previous;
        }
    };
    const isActive = (ctx) => !deps.isContextActive || deps.isContextActive(ctx);
    return {
        onSessionBeforeCompact: (_event, ctx) => {
            if (isActive(ctx))
                dispatchFor(ctx, { type: "beforeCompact" });
        },
        onSessionCompact: (_event, ctx) => {
            if (isActive(ctx))
                dispatchFor(ctx, { type: "compacted" });
        },
        onSessionCompactFailed: (_event, ctx) => {
            if (isActive(ctx))
                dispatchFor(ctx, { type: "compactFailed" });
        },
        onSessionShutdown: () => {
            dispatchFor(undefined, { type: "shutdown" });
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
        const generation = deps.getSessionGeneration?.();
        const isCurrent = () => deps.isContextActive?.(typedCtx) !== false &&
            (!deps.getSessionGeneration || Object.is(deps.getSessionGeneration(), generation));
        if (isCurrent())
            ensureTyping(typedCtx);
        try {
            await inner(event, ctx);
        }
        catch (error) {
            deps.recordRuntimeEvent?.("message-activity", error, { phase });
        }
        finally {
            if (isCurrent())
                ensureTyping(typedCtx);
        }
    };
    return {
        onMessageStart: (event, ctx) => handleMessageActivity("start", event, ctx, deps.onMessageStart),
        onMessageUpdate: (event, ctx) => handleMessageActivity("update", event, ctx, deps.onMessageUpdate),
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
    if (deps.onTurnEnd) {
        pi.on("turn_end", (event, ctx) => {
            if (!isActive(ctx))
                return;
            return deps.onTurnEnd?.(event, ctx);
        });
    }
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
