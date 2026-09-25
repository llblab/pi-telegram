/**
 * Telegram bus follower runtime
 * Zones: multi-instance bus, follower lifecycle, manual registration
 * Owns this Pi instance's follower-side bus behavior: manual registration,
 * heartbeat, forwarded-update receiving, and follower-routed API calls.
 * It must not spawn Pi processes or create hidden Telegram-originated instances.
 */
import { basename } from "node:path";
import * as Sync from "./sync.js";
import * as Threads from "./threads.js";
import { parseTelegramUpdateJournalQueueOwner } from "./journal.js";
import { TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS, } from "./locks.js";
import { isTelegramApiMethodRetrySafe, TelegramApiCommitUnknownError, TelegramApiStaleTargetError, } from "./telegram-api.js";
import { createTelegramBusFollowerDeliveryIdentity, createTelegramBusFollowerTargetController, createTelegramBusForeignOwnedUpdateForwarder, createTelegramBusLocalServer, createTelegramBusRequestIdFactory, createUnauthorizedBusAck, getTelegramBusProtocolCompatibility, getTelegramBusSocketPath, hasTelegramBusCapability, isTelegramBusEnvelopeAuthorized, resolveTelegramBusSocketPath, sendTelegramBusLocalEnvelope, TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE, TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT, TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT, } from "./bus.js";
import { getTelegramBusTransportRetryPolicy, TELEGRAM_BUS_REGISTRATION_RETRY, } from "./bus-transport.js";
import { createTelegramWorkspaceAdmissionOperationId, runWithTelegramWorkspaceAdmissionsAsync, } from "./workspace-admission.js";
export const TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS = 2_500;
export const TELEGRAM_FOLLOWER_SESSION_HANDOFF_TTL_MS = 30_000;
export const TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS = 30_000;
export const TELEGRAM_BUS_FOLLOWER_REGISTRATION_WAIT_MS = 30_000;
export const TELEGRAM_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS = TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS;
export const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS = TELEGRAM_BUS_REGISTRATION_RETRY.attempts;
export const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS = TELEGRAM_BUS_REGISTRATION_RETRY.delayMs;
const TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY = "__piTelegramFollowerSessionHandoff";
export function getTelegramFollowerSessionHandoff() {
    const value = globalThis[TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY];
    if (!value || typeof value !== "object")
        return undefined;
    const handoff = value;
    if (typeof handoff.pid !== "number" ||
        typeof handoff.instanceId !== "string" ||
        typeof handoff.createdAtMs !== "number" ||
        !handoff.target ||
        typeof handoff.target !== "object" ||
        typeof handoff.target.chatId !== "number") {
        return undefined;
    }
    return handoff;
}
export function setTelegramFollowerSessionHandoff(handoff) {
    const store = globalThis;
    if (!handoff)
        delete store[TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY];
    else
        store[TELEGRAM_FOLLOWER_SESSION_HANDOFF_KEY] = handoff;
}
export function isTelegramFollowerSessionHandoffFresh(handoff, options = {}) {
    if (!handoff)
        return false;
    const pid = options.pid ?? process.pid;
    const nowMs = options.nowMs ?? Date.now();
    const ttlMs = options.ttlMs ?? TELEGRAM_FOLLOWER_SESSION_HANDOFF_TTL_MS;
    return handoff.pid === pid && nowMs - handoff.createdAtMs <= ttlMs;
}
export function createTelegramManualFollowerProfileKeyResolver(input) {
    return () => Threads.getTelegramThreadOwnerKey({
        kind: "manual-follower",
        instanceId: input.manualFollowerOwnerId,
        telegramProfile: input.getActiveProfileName(),
    });
}
function runTelegramBusFollowerWorkspaceMutation(deps, operationKind, operation) {
    if (!deps.getWorkspaceAdmission)
        return operation();
    const admission = deps.getWorkspaceAdmission();
    if (!admission) {
        throw new Error("Telegram Workspace admission authority is unavailable.");
    }
    return runWithTelegramWorkspaceAdmissionsAsync({
        ledger: admission,
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind,
        scopes: [{ kind: "profile" }],
        operation,
        onReleaseError(error) {
            deps.recordRuntimeEvent?.("bus", error, {
                phase: "workspace-admission-release",
                operationKind,
            });
        },
    });
}
export function createTelegramBusFollowerPromotionHandler(input) {
    return (ctx, binding, election) => runTelegramBusFollowerWorkspaceMutation(input, "workspace.promote-follower", async () => {
        let promotedRecord;
        const promoted = await input.startLeader(ctx, election, async () => {
            promotedRecord =
                await Threads.promoteTelegramFollowerBindingToLeader({
                    store: input.topicTargetStore,
                    instanceId: input.instanceId,
                    cwd: ctx.cwd,
                    sessionId: input.getSessionId?.(ctx),
                    telegramProfile: input.getActiveProfileName(),
                    target: binding.target,
                    slot: binding.slot,
                    threadName: binding.threadName,
                });
            if (!promotedRecord && typeof binding.target?.threadId === "number") {
                throw new Error("Telegram follower promotion slot authority is unavailable.");
            }
            if (promotedRecord) {
                input.recordRuntimeEvent("bus", "Follower thread binding promoted to leader", {
                    phase: "follower-promoted-binding",
                    chatId: promotedRecord.target.chatId,
                    threadId: promotedRecord.target.threadId,
                    slot: promotedRecord.slot,
                    threadName: promotedRecord.threadName,
                });
            }
        });
        if (promoted &&
            promotedRecord &&
            typeof binding.target?.threadId === "number") {
            const profileKey = Threads.getTelegramThreadOwnerKey({
                kind: "leader",
                cwd: ctx.cwd,
                instanceId: input.instanceId,
                telegramProfile: input.getActiveProfileName(),
            });
            Threads.setTelegramLeaderSessionHandoff({
                pid: input.getPid?.() ?? process.pid,
                instanceId: input.instanceId,
                createdAtMs: input.getNowMs?.() ?? Date.now(),
                profileKey,
                target: {
                    chatId: binding.target.chatId,
                    threadId: binding.target.threadId,
                },
                slot: promotedRecord.slot,
                threadName: promotedRecord.threadName,
            });
            input.recordRuntimeEvent("bus", "Promoted leader binding retained for session replacement", {
                phase: "follower-promoted-session-handoff",
                chatId: binding.target.chatId,
                threadId: binding.target.threadId,
                slot: promotedRecord.slot,
                threadName: promotedRecord.threadName,
            });
        }
        return promoted;
    });
}
export function createTelegramBusFollowerRuntimeAssembly(ports) {
    // Binding startup needs registration identity before it can grant inbound authority.
    let readyContext;
    const isReadyContext = (ctx) => Boolean(readyContext &&
        (ctx === undefined || readyContext.ctx === ctx) &&
        ports.registrationState.getGeneration() === readyContext.generation &&
        ports.registration.getSessionGeneration?.() === readyContext.sessionGeneration &&
        ports.registration.isContextActive?.(readyContext.ctx) !== false);
    const prepareContext = async (ctx) => {
        const generation = ports.registrationState.getGeneration();
        const sessionGeneration = ports.registration.getSessionGeneration?.();
        readyContext = undefined;
        await ports.registration.onRegistered?.(ctx);
        if (generation && ports.registrationState.getGeneration() === generation &&
            ports.registration.getSessionGeneration?.() === sessionGeneration &&
            ports.registration.isContextActive?.(ctx) !== false)
            readyContext = { generation, ctx, sessionGeneration };
    };
    const sharedRuntimeDeps = {
        instanceId: ports.instanceId,
        registrationState: ports.registrationState,
        recordRuntimeEvent: ports.recordRuntimeEvent,
    };
    const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
        ...ports.receiver,
        instanceId: ports.instanceId,
        recordRuntimeEvent: ports.recordRuntimeEvent,
        getRegistrationGeneration() {
            return isReadyContext() ? readyContext?.generation : undefined;
        },
        handleReplaceTarget: createTelegramBusFollowerTargetReplacementHandler({
            ...ports.targetReplacement,
            ...sharedRuntimeDeps,
        }),
    });
    let registration;
    const recovery = createTelegramBusFollowerHeartbeatRecoveryHandler({
        ...ports.recovery,
        registrationState: ports.registrationState,
        recordRuntimeEvent: ports.recordRuntimeEvent,
        getRegistrationRuntime: () => registration,
    });
    registration = createTelegramBusFollowerRegistrationRuntime({
        ...ports.registration,
        ...sharedRuntimeDeps,
        startReceiving: receiver.start,
        stopReceiving: receiver.stop,
        onRegistered: prepareContext,
        onHeartbeatFailure: recovery,
    });
    const baseRegistration = registration;
    registration = {
        ...baseRegistration,
        async setContext(ctx) {
            const sessionGeneration = ports.registration.getSessionGeneration?.();
            if (ports.registration.isContextActive?.(ctx) === false)
                return;
            await baseRegistration.setContext(ctx);
            if (ports.registration.getSessionGeneration?.() !== sessionGeneration ||
                ports.registration.isContextActive?.(ctx) === false)
                return;
            if (!isReadyContext(ctx))
                await prepareContext(ctx);
        },
    };
    return { receiver, registration };
}
export function createTelegramBusFollowerTargetReplacementHandler(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    return (input, ctx) => runTelegramBusFollowerWorkspaceMutation(deps, "workspace.replace-follower-target", async () => {
        const assertCurrent = (expectedTarget = input.oldTarget) => {
            const target = deps.registrationState.getTarget();
            if (!input.registrationGeneration ||
                deps.registrationState.getGeneration() !==
                    input.registrationGeneration ||
                !input.oldTarget ||
                !expectedTarget ||
                target?.chatId !== expectedTarget.chatId ||
                target.threadId !== expectedTarget.threadId ||
                input.target.chatId !== input.oldTarget.chatId ||
                input.target.threadId === input.oldTarget.threadId) {
                throw new Error("Stale Telegram follower target replacement authority.");
            }
        };
        assertCurrent();
        await deps.topicTargetStore.load();
        assertCurrent();
        const nowMs = getNowMs();
        const currentRecord = Threads.findCurrentTelegramInstanceThreadRecord({
            records: deps.topicTargetStore.list(),
            instanceId: deps.instanceId,
            preferredTarget: input.oldTarget,
        });
        if (currentRecord &&
            (currentRecord.target.chatId !== input.oldTarget.chatId ||
                currentRecord.target.threadId !== input.oldTarget.threadId)) {
            throw new Error("Stale Telegram follower binding replacement target.");
        }
        const currentSlot = currentRecord?.slot ?? deps.registrationState.getSlot();
        if (!currentSlot || !/^[A-Z]$/u.test(currentSlot)) {
            throw new Error("Telegram Thread slot authority is unavailable.");
        }
        deps.topicTargetStore.markStaleByTarget(input.oldTarget, "deleted", "Follower thread was replaced by thread restore.");
        const profileKey = currentRecord?.profileKey ?? deps.getManualFollowerProfileKey();
        deps.topicTargetStore.upsert({
            profileKey,
            owner: {
                kind: "manual-follower",
                instanceId: deps.manualFollowerOwnerId,
            },
            target: input.target,
            status: "active",
            syncStatus: "open",
            createdAtMs: currentRecord?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
            lastSyncObservedAtMs: nowMs,
            lastReconcileAction: "follower-thread-restore",
            instanceId: deps.instanceId,
            slot: currentSlot,
            threadName: currentRecord?.threadName,
            rerouteConfirmedAtMs: nowMs,
        });
        deps.registrationState.setRegistered(true, input.target, {
            slot: currentSlot,
            threadName: currentRecord?.threadName,
            generation: input.registrationGeneration,
        });
        await deps.topicTargetStore.persist();
        assertCurrent(input.target);
        deps.setSyncState(Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
            nowMs,
            action: "follower-thread-restore",
        }));
        deps.updateStatus(ctx);
        deps.recordRuntimeEvent?.("bus", "Telegram follower thread target replaced", {
            phase: "follower-thread-restore",
            chatId: input.target.chatId,
            threadId: input.target.threadId,
            oldThreadId: input.oldTarget?.threadId ?? currentRecord?.target.threadId,
            slot: currentSlot,
        });
    });
}
export function createTelegramBusFollowerClientRuntime(deps) {
    const createRequestId = createTelegramBusRequestIdFactory(deps.instanceId);
    const timeoutMs = deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
    const sharedClientDeps = {
        socketPath: deps.socketPath,
        createRequestId,
        timeoutMs,
        waitForRegistrationGeneration: deps.waitForRegistrationGeneration,
    };
    return {
        createRequestId,
        callApi: createTelegramBusFollowerApiCaller({
            ...sharedClientDeps,
            instanceId: deps.instanceId,
            getAuthSecret: deps.getApiAuthSecret,
            getRegistrationGeneration: deps.getRegistrationGeneration,
        }),
        agentMessages: createTelegramBusAgentMessageClient({
            ...sharedClientDeps,
            instanceId: deps.instanceId,
            getAuthSecret: deps.getApiAuthSecret,
            getRegistrationGeneration: deps.getRegistrationGeneration,
        }),
        foreignOwnedUpdateForwarder: createTelegramBusForeignOwnedUpdateForwarder({
            ...sharedClientDeps,
            getAuthSecret: deps.getForwardingAuthSecret,
            getForwardCommentBatchPosition: deps.getForwardCommentBatchPosition,
            validateForwardOwnership: deps.validateForwardOwnership,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        }),
        queueHandoff: createTelegramBusFollowerQueueHandoffClient({
            ...sharedClientDeps,
            instanceId: deps.instanceId,
            getAuthSecret: deps.getApiAuthSecret,
            getRegistrationGeneration: deps.getRegistrationGeneration,
        }),
        targetController: createTelegramBusFollowerTargetController({
            ...sharedClientDeps,
            getAuthSecret: deps.getForwardingAuthSecret,
        }),
    };
}
export function createTelegramBusFollowerQueueHandoffClient(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const timeoutMs = deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
    return async (input) => {
        const registration = await resolveTelegramBusFollowerRegistration(deps, timeoutMs);
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        const response = await sendTelegramBusLocalEnvelope({
            socketPath,
            timeoutMs: registration.remainingTimeoutMs,
            retry: getTelegramBusTransportRetryPolicy({
                endpoint: socketPath,
                operation: "operation",
            }),
            envelope: {
                kind: "follower.offerQueueHandoff",
                requestId: deps.createRequestId(),
                auth: deps.getAuthSecret?.(),
                instanceId: deps.instanceId,
                registrationGeneration: registration.generation,
                ...input,
                sentAtMs: getNowMs(),
            },
        });
        const queueOwner = response?.kind === "bus.ack" && isRecord(response.result)
            ? parseTelegramUpdateJournalQueueOwner(response.result.queueOwner)
            : undefined;
        if (response?.kind === "bus.ack" &&
            response.ok &&
            isRecord(response.result) &&
            response.result.status === "staged" &&
            typeof response.result.receiptId === "string" &&
            Array.isArray(response.result.sourceUpdateIds) &&
            response.result.sourceUpdateIds.every(Number.isSafeInteger) &&
            input.payload.admissionReceipts.length === 1 &&
            response.result.receiptId ===
                input.payload.admissionReceipts[0]?.receiptId &&
            response.result.sourceUpdateIds.length ===
                input.payload.admissionReceipts[0].sourceUpdateIds.length &&
            response.result.sourceUpdateIds.every((updateId, index) => updateId === input.payload.admissionReceipts[0].sourceUpdateIds[index]) &&
            queueOwner) {
            return {
                status: "staged",
                receiptId: response.result.receiptId,
                sourceUpdateIds: response.result.sourceUpdateIds,
                queueOwner,
            };
        }
        throw new Error(response?.kind === "bus.ack"
            ? response.message ?? "Telegram queue handoff was rejected."
            : "Telegram queue handoff did not return an acknowledgement.");
    };
}
export function createTelegramBusAgentMessageClient(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const timeoutMs = deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
    const request = async (envelope, requestTimeoutMs = timeoutMs) => {
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        const response = await sendTelegramBusLocalEnvelope({
            socketPath,
            timeoutMs: requestTimeoutMs,
            retry: getTelegramBusTransportRetryPolicy({
                endpoint: socketPath,
                operation: "operation",
            }),
            envelope,
        });
        if (response?.kind === "bus.ack" && response.ok)
            return response.result;
        throw new Error(response?.kind === "bus.ack"
            ? response.message ?? "Telegram bus agent message failed."
            : "Telegram bus agent message did not return an acknowledgement.");
    };
    const registrationFields = async () => {
        const registration = await resolveTelegramBusFollowerRegistration(deps, timeoutMs);
        return {
            fields: {
                auth: deps.getAuthSecret?.(),
                instanceId: deps.instanceId,
                registrationGeneration: registration.generation,
            },
            remainingTimeoutMs: registration.remainingTimeoutMs,
        };
    };
    return {
        async resolveTarget(selector) {
            const registration = await registrationFields();
            const result = await request({
                kind: "follower.resolveAgentTarget",
                requestId: deps.createRequestId(),
                ...registration.fields,
                selector,
                sentAtMs: getNowMs(),
            }, registration.remainingTimeoutMs);
            if (!result || typeof result !== "object" || Array.isArray(result)) {
                throw new Error("Telegram bus returned an invalid agent target.");
            }
            const target = result;
            if (typeof target.chatId !== "number" ||
                typeof target.threadId !== "number") {
                throw new Error("Telegram bus returned an invalid agent target.");
            }
            return { chatId: target.chatId, threadId: target.threadId };
        },
        async routeMessage(message) {
            const registration = await registrationFields();
            await request({
                kind: "follower.routeAgentMessage",
                requestId: deps.createRequestId(),
                ...registration.fields,
                message,
                sentAtMs: getNowMs(),
            }, registration.remainingTimeoutMs);
        },
    };
}
export function createTelegramBusFollowerApiCaller(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const timeoutMs = deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
    return async (method, args) => {
        const registration = await resolveTelegramBusFollowerRegistration(deps, timeoutMs);
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        let response;
        try {
            response = await sendTelegramBusLocalEnvelope({
                socketPath,
                timeoutMs: registration.remainingTimeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: socketPath,
                    operation: "operation",
                }),
                envelope: {
                    kind: "follower.callApi",
                    requestId: deps.createRequestId(),
                    auth: deps.getAuthSecret?.(),
                    instanceId: deps.instanceId,
                    registrationGeneration: registration.generation,
                    method,
                    args,
                    sentAtMs: getNowMs(),
                },
            });
        }
        catch (error) {
            const apiMethod = (method === "call" || method === "callMultipart") &&
                typeof args[0] === "string"
                ? args[0]
                : method;
            if (!isTelegramApiMethodRetrySafe(apiMethod)) {
                throw new TelegramApiCommitUnknownError(apiMethod, error);
            }
            throw error;
        }
        if (response?.kind === "bus.ack" && response.ok)
            return response.result;
        const message = response?.kind === "bus.ack"
            ? response.message
            : "Telegram bus API call did not return an acknowledgement.";
        if (response?.kind === "bus.ack" &&
            response.error?.code === "stale-target" &&
            response.error.chatId !== undefined &&
            response.error.threadId !== undefined) {
            throw new TelegramApiStaleTargetError(message ?? "Telegram thread target is stale.", {
                chatId: response.error.chatId,
                threadId: response.error.threadId,
            });
        }
        if (response?.kind === "bus.ack" &&
            response.error?.code === "commit-unknown") {
            throw new TelegramApiCommitUnknownError(response.error.method ?? method, new Error(message ?? "Telegram bus API call result is ambiguous."));
        }
        throw new Error(message ?? "Telegram bus API call failed.");
    };
}
async function resolveTelegramBusFollowerRegistration(deps, timeoutMs) {
    const current = deps.getRegistrationGeneration();
    if (current)
        return { generation: current, remainingTimeoutMs: timeoutMs };
    const getNowMs = deps.getNowMs ?? Date.now;
    const startedAtMs = getNowMs();
    const restored = await deps.waitForRegistrationGeneration?.(timeoutMs);
    const remainingTimeoutMs = Math.max(0, timeoutMs - (getNowMs() - startedAtMs));
    if (restored && remainingTimeoutMs > 0) {
        return { generation: restored, remainingTimeoutMs };
    }
    throw new Error("Telegram bus follower is not registered.");
}
function isTelegramStaleContextError(error) {
    return (error instanceof Error &&
        (error.message.includes("stale after session") ||
            error.message.includes("stale ctx")));
}
export function createTelegramBusFollowerSessionReplacementSuspender(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const getPid = deps.getPid ?? (() => process.pid);
    return async () => {
        const target = deps.registrationState.getTarget();
        if (deps.registrationState.isRegistered() && target) {
            setTelegramFollowerSessionHandoff({
                pid: getPid(),
                instanceId: deps.instanceId,
                createdAtMs: getNowMs(),
                target,
                slot: deps.registrationState.getSlot(),
                threadName: deps.registrationState.getThreadName(),
            });
            deps.recordRuntimeEvent("bus", "Telegram follower registration suspended for session replacement", {
                phase: "follower-session-handoff",
                instanceId: deps.instanceId,
                chatId: target.chatId,
                threadId: target.threadId,
            });
        }
        else if (deps.isLeader?.()) {
            const leaderBinding = deps.getLeaderBinding?.();
            if (typeof leaderBinding?.target?.threadId === "number") {
                const activeContext = deps.getActiveContext?.();
                const profileKey = Threads.getTelegramThreadOwnerKey({
                    kind: "leader",
                    cwd: activeContext?.cwd,
                    instanceId: deps.instanceId,
                    telegramProfile: deps.getActiveProfileName?.(),
                });
                Threads.setTelegramLeaderSessionHandoff({
                    pid: getPid(),
                    instanceId: deps.instanceId,
                    createdAtMs: getNowMs(),
                    profileKey,
                    target: {
                        chatId: leaderBinding.target.chatId,
                        threadId: leaderBinding.target.threadId,
                    },
                    slot: leaderBinding.slot,
                    threadName: leaderBinding.threadName,
                });
                deps.recordRuntimeEvent("bus", "Telegram leader binding suspended for session replacement", {
                    phase: "leader-session-handoff",
                    instanceId: deps.instanceId,
                    chatId: leaderBinding.target.chatId,
                    threadId: leaderBinding.target.threadId,
                    slot: leaderBinding.slot,
                    threadName: leaderBinding.threadName,
                });
            }
        }
        await deps.suspendPolling();
    };
}
export function createTelegramBusFollowerSessionRefreshHook(deps) {
    return async (_event, ctx) => {
        if (deps.isSessionActive && !deps.isSessionActive(ctx))
            return;
        if (!deps.registrationState.isRegistered()) {
            const handoff = getTelegramFollowerSessionHandoff();
            const lockState = deps.getLeaderState();
            const handoffIsFresh = isTelegramFollowerSessionHandoffFresh(handoff);
            if (handoffIsFresh && lockState.kind === "active-elsewhere") {
                try {
                    const restored = await deps.registrationRuntime.registerWithLeader(ctx, lockState.lock, {
                        target: handoff.target,
                        previousInstanceId: handoff.instanceId,
                    });
                    if (deps.isSessionActive && !deps.isSessionActive(ctx))
                        return;
                    if (restored) {
                        setTelegramFollowerSessionHandoff(undefined);
                        deps.updateStatus(ctx);
                        deps.recordRuntimeEvent("bus", "Telegram follower registration restored after session replacement", {
                            phase: "follower-session-restore",
                            previousInstanceId: handoff.instanceId,
                        });
                    }
                }
                catch (error) {
                    deps.recordRuntimeEvent("bus", error, {
                        phase: "follower-session-restore",
                        previousInstanceId: handoff?.instanceId,
                    });
                }
            }
            else if (handoff) {
                setTelegramFollowerSessionHandoff(undefined);
            }
        }
        if (!deps.registrationState.isRegistered())
            return;
        if (deps.isSessionActive && !deps.isSessionActive(ctx))
            return;
        try {
            await deps.registrationRuntime.setContext(ctx);
        }
        catch (error) {
            deps.recordRuntimeEvent("bus", error, { phase: "follower-session-refresh" });
            return;
        }
        if (deps.isSessionActive && !deps.isSessionActive(ctx))
            return;
        deps.updateStatus(ctx);
        deps.recordRuntimeEvent("bus", "Telegram follower session context refreshed", { phase: "follower-session-refresh" });
    };
}
export function createTelegramBusFollowerControlState() {
    let activeAuthSecret;
    let lifecyclePhase;
    return {
        getActiveAuthSecret: () => activeAuthSecret,
        setActiveAuthSecret(secret) {
            activeAuthSecret = secret;
        },
        getLifecyclePhase: () => lifecyclePhase,
        setLifecyclePhase(phase) {
            lifecyclePhase = phase;
        },
    };
}
export function createTelegramBusFollowerRegistrationState(options = {}) {
    let registered = false;
    let target;
    let slot;
    let threadName;
    let displayTitle;
    let generation;
    let leaderProtocol;
    let eligibleElectionSlots = [];
    let recoveryEpoch = 0;
    let activeRecoveryEpoch;
    const generationWaiters = new Set();
    const settleGenerationWaiters = (value, epoch) => {
        for (const waiter of [...generationWaiters]) {
            if (epoch === undefined || waiter.epoch === epoch)
                waiter.settle(value);
        }
    };
    return {
        isRegistered: () => registered,
        getTarget: () => (target ? { ...target } : undefined),
        getSlot: () => slot,
        getThreadName: () => threadName,
        getDisplayTitle: () => displayTitle,
        setDisplayTitle(title, expectedGeneration) {
            if (!registered || !generation || expectedGeneration !== generation ||
                !title.trim() || title.length > 128 || displayTitle === title)
                return false;
            displayTitle = title;
            return true;
        },
        getGeneration: () => generation,
        beginRecovery: () => {
            if (activeRecoveryEpoch !== undefined)
                return activeRecoveryEpoch;
            activeRecoveryEpoch = ++recoveryEpoch;
            return activeRecoveryEpoch;
        },
        cancelRecovery: () => {
            const epoch = activeRecoveryEpoch;
            activeRecoveryEpoch = undefined;
            if (epoch !== undefined)
                settleGenerationWaiters(undefined, epoch);
        },
        waitForGeneration: (timeoutMs = TELEGRAM_BUS_FOLLOWER_REGISTRATION_WAIT_MS) => {
            if (generation)
                return Promise.resolve(generation);
            const epoch = activeRecoveryEpoch;
            if (epoch === undefined)
                return Promise.resolve(undefined);
            return new Promise((resolve) => {
                let timer;
                const settle = (value) => {
                    generationWaiters.delete(waiter);
                    if (timer)
                        clearTimeout(timer);
                    resolve(value);
                };
                const waiter = { epoch, settle };
                generationWaiters.add(waiter);
                timer = setTimeout(() => settle(undefined), Math.max(0, timeoutMs));
            });
        },
        getLeaderProtocol: () => leaderProtocol
            ? { ...leaderProtocol, capabilities: [...leaderProtocol.capabilities] }
            : undefined,
        getEligibleElectionSlots: () => [...eligibleElectionSlots],
        setEligibleElectionSlots: (slots) => {
            eligibleElectionSlots = Array.from(new Set(slots.filter((slot) => /^[A-Z]$/.test(slot)))).sort();
        },
        setRegistered: (next, nextTarget, metadata) => {
            const retainedDisplayTitle = next && registered &&
                generation === metadata?.generation &&
                target?.chatId === nextTarget?.chatId && target?.threadId === nextTarget?.threadId
                ? displayTitle : undefined;
            const availabilityChanged = registered !== next;
            registered = next;
            target = next ? (nextTarget ? { ...nextTarget } : undefined) : undefined;
            slot = next ? metadata?.slot : undefined;
            threadName = next ? metadata?.threadName : undefined;
            displayTitle = next && nextTarget && metadata?.generation &&
                metadata.displayTitle?.trim() && metadata.displayTitle.length <= 128
                ? metadata.displayTitle : retainedDisplayTitle;
            generation = next ? metadata?.generation : undefined;
            leaderProtocol =
                next && metadata?.leaderProtocol
                    ? {
                        ...metadata.leaderProtocol,
                        capabilities: [...metadata.leaderProtocol.capabilities],
                    }
                    : undefined;
            if (availabilityChanged)
                options.onAvailabilityChanged?.();
            if (generation) {
                activeRecoveryEpoch = undefined;
                settleGenerationWaiters(generation);
            }
        },
    };
}
export function createTelegramBusFollowerHeartbeatRecoveryHandler(deps) {
    const promotionGraceMs = deps.promotionGraceMs ?? TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS;
    const sleep = deps.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const scheduleRetry = deps.scheduleRetry ??
        ((retry, delayMs) => {
            const timer = setTimeout(retry, delayMs);
            timer.unref?.();
        });
    let promotionPending = false;
    const safeUpdateStatus = (ctx) => {
        try {
            deps.updateStatus(ctx);
        }
        catch (error) {
            if (!isTelegramStaleContextError(error))
                throw error;
            deps.recordRuntimeEvent("bus", error, {
                phase: "follower-stale-context-status",
            });
        }
    };
    const clearRegisteredState = (ctx) => {
        deps.registrationState.setRegistered(false);
        safeUpdateStatus(ctx);
    };
    const tryRegisterWithLeader = async (ctx, leader, phase, binding) => {
        try {
            const restored = await deps
                .getRegistrationRuntime()
                .registerWithLeader(ctx, leader, binding?.target ? { target: binding.target } : undefined);
            if (!restored)
                return false;
            deps.setLifecyclePhase(undefined);
            safeUpdateStatus(ctx);
            deps.recordRuntimeEvent("bus", "Telegram follower registration restored", {
                phase,
            });
            return true;
        }
        catch (error) {
            clearRegisteredState(ctx);
            deps.recordRuntimeEvent("bus", error, { phase });
            return false;
        }
    };
    const snapshotBinding = () => ({
        target: deps.registrationState.getTarget(),
        slot: deps.registrationState.getSlot(),
        threadName: deps.registrationState.getThreadName(),
    });
    const scheduleRecovery = (reason, fallbackCtx, binding) => {
        const retry = () => {
            const activeCtx = deps.getActiveContext
                ? deps.getActiveContext()
                : fallbackCtx;
            if (!activeCtx) {
                scheduleRetry(retry, promotionGraceMs);
                return;
            }
            void recover(reason, activeCtx, binding);
        };
        scheduleRetry(retry, promotionGraceMs);
    };
    const promoteToLeader = async (reason, ctx, binding, election) => {
        const activeCtx = deps.getActiveContext?.();
        if (deps.getActiveContext && activeCtx !== ctx) {
            scheduleRecovery(reason, ctx, binding);
            return;
        }
        deps.setLifecyclePhase("electing");
        safeUpdateStatus(ctx);
        deps.recordRuntimeEvent("bus", reason, {
            phase: "follower-promotion-electing",
        });
        deps.getRegistrationRuntime().stop();
        deps.setLifecyclePhase("electing");
        safeUpdateStatus(ctx);
        deps.recordRuntimeEvent("bus", "Telegram follower attempting promotion", {
            phase: "follower-promotion-electing",
        });
        const promoted = await deps.promoteToLeader(ctx, binding, election);
        deps.setLifecyclePhase(undefined);
        safeUpdateStatus(ctx);
        deps.recordRuntimeEvent("bus", promoted
            ? "Telegram follower promotion completed"
            : "Telegram follower promotion lost election", {
            phase: promoted
                ? "follower-promotion-complete"
                : "follower-promotion-lost",
        });
        if (!promoted)
            scheduleRecovery(reason, ctx, binding);
    };
    const attemptPreferredPromotion = async (reason, ctx, binding, candidateState) => {
        const slot = binding.slot;
        const lowerEligibleSlot = slot
            ? deps.registrationState
                .getEligibleElectionSlots()
                .find((candidate) => candidate < slot)
            : undefined;
        if (lowerEligibleSlot) {
            deps.recordRuntimeEvent("bus", "Telegram follower deferring to a lower-slot election candidate", {
                phase: "follower-promotion-slot-priority",
                slot,
                lowerEligibleSlot,
            });
            await sleep(promotionGraceMs);
            candidateState = deps.getLeaderState();
            if (candidateState.kind === "active-elsewhere") {
                if (!(await tryRegisterWithLeader(ctx, candidateState.lock, "follower-register-preferred-successor", binding))) {
                    scheduleRecovery(reason, ctx, binding);
                }
                return;
            }
        }
        if (candidateState.kind !== "stale" && candidateState.kind !== "inactive")
            return;
        await promoteToLeader(reason, ctx, binding, {
            expectedOwner: candidateState.kind === "stale" ? candidateState.lock : undefined,
        });
    };
    const recover = async (error, ctx, carriedBinding) => {
        if (promotionPending)
            return;
        promotionPending = true;
        deps.registrationState.beginRecovery();
        const initialBinding = carriedBinding ?? snapshotBinding();
        try {
            const state = deps.getLeaderState();
            if (state.kind === "active-elsewhere") {
                clearRegisteredState(ctx);
                if (await tryRegisterWithLeader(ctx, state.lock, "follower-register-restore", initialBinding)) {
                    return;
                }
                deps.setLifecyclePhase("electing");
                safeUpdateStatus(ctx);
                deps.recordRuntimeEvent("bus", "Telegram follower waiting for leader reload recovery", { phase: "follower-promotion-grace" });
                await sleep(promotionGraceMs);
                const graceState = deps.getLeaderState();
                if (graceState.kind === "active-elsewhere") {
                    if (await tryRegisterWithLeader(ctx, graceState.lock, "follower-register-restore-grace", initialBinding)) {
                        return;
                    }
                    deps.setLifecyclePhase(undefined);
                    safeUpdateStatus(ctx);
                    deps.recordRuntimeEvent("bus", "Telegram follower promotion blocked by live leader lease", {
                        phase: "follower-promotion-live-owner",
                        leaderInstanceId: graceState.lock.instanceId,
                        leaderEpoch: graceState.lock.leaderEpoch,
                    });
                    scheduleRecovery(error, ctx, initialBinding);
                    return;
                }
                await attemptPreferredPromotion(error, ctx, initialBinding, graceState);
                return;
            }
            await attemptPreferredPromotion(error, ctx, initialBinding, state);
        }
        catch (promotionError) {
            deps.setLifecyclePhase(undefined);
            safeUpdateStatus(ctx);
            if (isTelegramStaleContextError(promotionError)) {
                deps.recordRuntimeEvent("bus", promotionError, {
                    phase: "follower-heartbeat-stale-context",
                });
                return;
            }
            deps.recordRuntimeEvent("bus", promotionError, {
                phase: "follower-promotion-failed",
            });
            scheduleRecovery(promotionError, ctx, initialBinding);
        }
        finally {
            promotionPending = false;
        }
    };
    return recover;
}
export function createTelegramBusFollowerRegistrationRuntime(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const getPid = deps.getPid ?? (() => process.pid);
    const heartbeatMs = deps.heartbeatMs ?? 1000;
    const heartbeatTimeoutMs = deps.heartbeatTimeoutMs ??
        deps.timeoutMs ??
        TELEGRAM_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS;
    const registrationTimeoutMs = deps.registrationTimeoutMs ?? deps.timeoutMs ?? 30000;
    const registrationRetryAttempts = deps.registrationRetryAttempts ??
        TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS;
    const registrationRetryDelayMs = deps.registrationRetryDelayMs ??
        TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS;
    let heartbeatInterval;
    let heartbeatPromise;
    let heartbeatPromiseGeneration;
    let activeLeaderSocketPath;
    let activeAuthSecret;
    let activeRegistrationGeneration;
    let registrationAttempt;
    let activeContext;
    let lastKnownTarget;
    let lastKnownSlot;
    let lastKnownThreadName;
    const stopHeartbeat = () => {
        if (!heartbeatInterval)
            return;
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
    };
    const stop = () => {
        registrationAttempt = undefined;
        stopHeartbeat();
        activeAuthSecret = undefined;
        activeRegistrationGeneration = undefined;
        heartbeatPromise = undefined;
        heartbeatPromiseGeneration = undefined;
        deps.setActiveAuthSecret?.(undefined);
        deps.registrationState?.cancelRecovery();
        deps.registrationState?.setRegistered(false);
        lastKnownTarget = undefined;
        lastKnownSlot = undefined;
        lastKnownThreadName = undefined;
        activeContext = undefined;
        void Promise.resolve(deps.stopReceiving?.()).catch((error) => {
            try {
                deps.recordRuntimeEvent?.("bus", error, {
                    phase: "follower-receiver-stop",
                });
            }
            catch {
                // Stop diagnostics cannot create an unhandled Promise.
            }
        });
    };
    const sendHeartbeat = async () => {
        const leaderSocketPath = activeLeaderSocketPath;
        const registrationGeneration = activeRegistrationGeneration;
        const heartbeatContext = activeContext;
        if (!leaderSocketPath || !registrationGeneration)
            return;
        const isCurrentHeartbeat = () => activeLeaderSocketPath === leaderSocketPath &&
            activeRegistrationGeneration === registrationGeneration &&
            activeContext === heartbeatContext;
        try {
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: leaderSocketPath,
                timeoutMs: heartbeatTimeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: leaderSocketPath,
                    operation: "operation",
                }),
                envelope: {
                    kind: "follower.heartbeat",
                    requestId: deps.createRequestId(),
                    auth: activeAuthSecret,
                    instanceId: deps.instanceId,
                    registrationGeneration,
                    sentAtMs: getNowMs(),
                },
            });
            if (!isCurrentHeartbeat())
                return;
            if (response?.kind === "bus.ack" && response.ok) {
                const heartbeatResult = isRecord(response.result)
                    ? response.result
                    : undefined;
                const slots = Array.isArray(heartbeatResult?.eligibleElectionSlots)
                    ? heartbeatResult.eligibleElectionSlots.filter((slot) => typeof slot === "string")
                    : [];
                deps.registrationState?.setEligibleElectionSlots(slots);
                if (typeof heartbeatResult?.displayTitle === "string" &&
                    deps.registrationState?.setDisplayTitle(heartbeatResult.displayTitle, registrationGeneration) &&
                    heartbeatContext) {
                    try {
                        deps.onDisplayTitleChanged?.(heartbeatContext);
                    }
                    catch {
                        // Display refresh failure must not invalidate a successful heartbeat.
                    }
                }
            }
            if (response?.kind === "bus.ack" && !response.ok) {
                throw new Error(response.message ?? "Telegram bus follower heartbeat was rejected.");
            }
        }
        catch (error) {
            if (!isCurrentHeartbeat())
                return;
            try {
                deps.recordRuntimeEvent?.("bus", error, {
                    phase: "follower-heartbeat",
                });
            }
            catch {
                // Diagnostics cannot replace heartbeat recovery.
            }
            if (!heartbeatContext)
                return;
            try {
                await deps.onHeartbeatFailure?.(error, heartbeatContext);
            }
            catch (recoveryError) {
                try {
                    deps.recordRuntimeEvent?.("bus", recoveryError, {
                        phase: "follower-heartbeat-recovery",
                    });
                }
                catch {
                    // A diagnostic sink cannot create an unhandled interval rejection.
                }
            }
        }
    };
    const requestHeartbeat = () => {
        const generation = activeRegistrationGeneration;
        if (heartbeatPromise && heartbeatPromiseGeneration === generation) {
            return heartbeatPromise;
        }
        let tracked;
        tracked = sendHeartbeat().finally(() => {
            if (heartbeatPromise === tracked) {
                heartbeatPromise = undefined;
                heartbeatPromiseGeneration = undefined;
            }
        });
        heartbeatPromise = tracked;
        heartbeatPromiseGeneration = generation;
        return tracked;
    };
    const startHeartbeat = (socketPath) => {
        stopHeartbeat();
        activeLeaderSocketPath = socketPath;
        heartbeatInterval = setInterval(() => {
            void requestHeartbeat();
        }, heartbeatMs);
        heartbeatInterval.unref?.();
    };
    return {
        registerWithLeader: async (ctx, leader, options) => {
            if (deps.isContextActive?.(ctx) === false)
                return false;
            const sessionGeneration = deps.getSessionGeneration?.();
            const attempt = { ctx, sessionGeneration };
            registrationAttempt = attempt;
            const isCurrentRequest = () => registrationAttempt === attempt &&
                deps.getSessionGeneration?.() === sessionGeneration && deps.isContextActive?.(ctx) !== false;
            const abandonOwnedRequest = async () => {
                if (registrationAttempt !== attempt)
                    return;
                registrationAttempt = undefined;
                stopHeartbeat();
                activeLeaderSocketPath = undefined;
                activeAuthSecret = undefined;
                activeRegistrationGeneration = undefined;
                activeContext = undefined;
                deps.registrationState?.setRegistered(false);
                deps.setActiveAuthSecret?.(undefined);
                await deps.stopReceiving?.();
            };
            const pendingHandoff = options
                ? undefined
                : getTelegramFollowerSessionHandoff();
            const pendingHandoffOptions = isTelegramFollowerSessionHandoffFresh(pendingHandoff)
                ? {
                    target: pendingHandoff.target,
                    previousInstanceId: pendingHandoff.instanceId,
                }
                : undefined;
            const registrationOptions = options ?? pendingHandoffOptions;
            const leaderSocketPath = leader.busSocketPath ??
                deps.getLeaderSocketPath?.() ??
                getTelegramBusSocketPath();
            await deps.startReceiving?.();
            if (!isCurrentRequest()) {
                await abandonOwnedRequest();
                return false;
            }
            activeAuthSecret = deps.getLeaderAuthSecret
                ? deps.getLeaderAuthSecret(leader)
                : leader?.busSecret;
            deps.setActiveAuthSecret?.(activeAuthSecret);
            const registrationGeneration = deps.createRequestId();
            const registrationEnvelope = {
                kind: registrationOptions?.restoreWorkspace
                    ? "follower.restoreWorkspace"
                    : "follower.register",
                requestId: registrationGeneration,
                auth: activeAuthSecret,
                registration: {
                    instanceId: deps.instanceId,
                    ...(registrationOptions?.previousInstanceId
                        ? { previousInstanceId: registrationOptions.previousInstanceId }
                        : {}),
                    profileKey: deps.getProfileKey?.(ctx) ??
                        (ctx.cwd ? `cwd:${ctx.cwd}` : undefined),
                    threadName: deps.registrationState?.getThreadName() ??
                        lastKnownThreadName ??
                        deps.getThreadName?.(ctx) ??
                        (ctx.cwd ? basename(ctx.cwd) : undefined),
                    ...((deps.registrationState?.getSlot() ?? lastKnownSlot)
                        ? { slot: deps.registrationState?.getSlot() ?? lastKnownSlot }
                        : {}),
                    cwd: ctx.cwd,
                    sessionId: deps.getSessionId?.(ctx),
                    pid: getPid(),
                    processBirthId: deps.getProcessBirthId?.(),
                    sessionGeneration,
                    target: registrationOptions?.target ??
                        deps.registrationState?.getTarget() ??
                        lastKnownTarget,
                    busSocketPath: deps.getFollowerBusSocketPath?.() ?? deps.followerBusSocketPath,
                    registrationGeneration,
                    protocol: deps.protocolIdentity,
                    connectedAtMs: getNowMs(),
                },
            };
            let response;
            try {
                response = await sendTelegramBusLocalEnvelope({
                    socketPath: leaderSocketPath,
                    timeoutMs: registrationTimeoutMs,
                    envelope: registrationEnvelope,
                    retry: getTelegramBusTransportRetryPolicy({
                        endpoint: leaderSocketPath,
                        operation: "registration",
                        overrides: {
                            attempts: registrationRetryAttempts,
                            delayMs: registrationRetryDelayMs,
                        },
                    }),
                    recordTransportEvent(phase, details) {
                        deps.recordRuntimeEvent?.("bus", `Telegram bus ${phase}`, {
                            phase: `follower-register-${phase}`,
                            ...details,
                        });
                    },
                });
            }
            catch (error) {
                if (!isCurrentRequest()) {
                    await abandonOwnedRequest();
                    return false;
                }
                stopHeartbeat();
                activeLeaderSocketPath = undefined;
                activeAuthSecret = undefined;
                deps.registrationState?.setRegistered(false);
                deps.setActiveAuthSecret?.(undefined);
                await deps.stopReceiving?.();
                throw error;
            }
            if (!isCurrentRequest()) {
                await abandonOwnedRequest();
                return false;
            }
            const compatibility = getTelegramBusProtocolCompatibility({
                local: deps.protocolIdentity,
                remote: response?.kind === "bus.ack" ? response.protocol : undefined,
            });
            if (!compatibility.compatible) {
                stopHeartbeat();
                activeLeaderSocketPath = undefined;
                activeAuthSecret = undefined;
                deps.registrationState?.setRegistered(false);
                deps.setActiveAuthSecret?.(undefined);
                await deps.stopReceiving?.();
                throw new Error(`Incompatible Telegram bus leader protocol: ${compatibility.reason}.`);
            }
            if (response?.kind === "bus.ack" && !response.ok) {
                stopHeartbeat();
                activeLeaderSocketPath = undefined;
                activeAuthSecret = undefined;
                deps.registrationState?.setRegistered(false);
                deps.setActiveAuthSecret?.(undefined);
                await deps.stopReceiving?.();
                if (registrationOptions?.restoreWorkspace &&
                    response.error?.code === "workspace-binding-unavailable") {
                    deps.recordRuntimeEvent?.("bus", "Telegram follower auto-connect refused by leader: Workspace binding unavailable.", {
                        phase: "follower-auto-connect-skip",
                        reason: "leader-binding-unavailable",
                    });
                    return false;
                }
                throw new Error(response.message ??
                    "Telegram bus follower registration was rejected.");
            }
            if (response?.kind === "bus.ack" && response.ok) {
                const registrationResult = parseRegistrationResult(response.result);
                deps.registrationState?.setRegistered(true, registrationResult.target, {
                    ...registrationResult,
                    generation: registrationGeneration,
                    ...(response.protocol
                        ? { leaderProtocol: response.protocol }
                        : {}),
                });
                lastKnownTarget = registrationResult.target;
                lastKnownSlot = registrationResult.slot;
                lastKnownThreadName = registrationResult.threadName;
                activeLeaderSocketPath = leaderSocketPath;
                activeRegistrationGeneration = registrationGeneration;
                activeContext = ctx;
                try {
                    await deps.onRegistered?.(ctx);
                }
                catch (error) {
                    if (!isCurrentRequest()) {
                        await abandonOwnedRequest();
                        return false;
                    }
                    stopHeartbeat();
                    activeLeaderSocketPath = undefined;
                    activeAuthSecret = undefined;
                    activeRegistrationGeneration = undefined;
                    deps.registrationState?.setRegistered(false);
                    deps.setActiveAuthSecret?.(undefined);
                    await deps.stopReceiving?.();
                    throw error;
                }
                if (!isCurrentRequest()) {
                    await abandonOwnedRequest();
                    return false;
                }
                await requestHeartbeat();
                if (!isCurrentRequest()) {
                    await abandonOwnedRequest();
                    return false;
                }
                startHeartbeat(leaderSocketPath);
                if (pendingHandoffOptions &&
                    getTelegramFollowerSessionHandoff()?.instanceId ===
                        pendingHandoffOptions.previousInstanceId) {
                    setTelegramFollowerSessionHandoff(undefined);
                }
                return true;
            }
            stopHeartbeat();
            activeLeaderSocketPath = undefined;
            activeAuthSecret = undefined;
            deps.registrationState?.setRegistered(false);
            deps.setActiveAuthSecret?.(undefined);
            await deps.stopReceiving?.();
            return false;
        },
        setContext(ctx) {
            if (registrationAttempt && (registrationAttempt.ctx !== ctx ||
                registrationAttempt.sessionGeneration !== deps.getSessionGeneration?.()))
                registrationAttempt = undefined;
            activeContext = ctx;
        },
        async setThreadDisplayMode(mode) {
            const socketPath = activeLeaderSocketPath;
            const generation = activeRegistrationGeneration;
            const auth = activeAuthSecret;
            if (!socketPath || !generation || !deps.registrationState?.isRegistered()) {
                throw new Error("Telegram follower is not registered with the leader.");
            }
            const requiredCapability = mode === "directory-snake" || mode === "directory-title"
                ? TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT
                : TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE;
            if (!hasTelegramBusCapability(deps.protocolIdentity, requiredCapability) ||
                !hasTelegramBusCapability(deps.registrationState.getLeaderProtocol(), requiredCapability)) {
                throw new Error("The Telegram peers do not support this Thread display setting. Update or restart both instances.");
            }
            const requestId = deps.createRequestId();
            const response = await sendTelegramBusLocalEnvelope({
                socketPath, timeoutMs: registrationTimeoutMs,
                envelope: {
                    kind: "follower.setThreadDisplayMode", requestId, auth,
                    instanceId: deps.instanceId, registrationGeneration: generation, mode,
                },
            });
            if (activeLeaderSocketPath !== socketPath || activeRegistrationGeneration !== generation ||
                activeAuthSecret !== auth || deps.registrationState.getGeneration() !== generation) {
                throw new Error("Telegram Thread display setting completed for a stale registration.");
            }
            if (response?.kind !== "bus.ack" || !response.ok || response.requestId !== requestId ||
                !isRecord(response.result) || response.result.mode !== mode) {
                throw new Error(response?.kind === "bus.ack"
                    ? response.message ?? "Telegram Thread display setting was rejected."
                    : "Telegram Thread display setting was not acknowledged.");
            }
        },
        async renameThread(target, threadName) {
            if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
                throw new Error("Telegram follower is not registered with the leader.");
            }
            if (deps.registrationState &&
                !hasTelegramBusCapability(deps.registrationState.getLeaderProtocol(), TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME)) {
                throw new Error("The active Telegram leader does not support Workspace Thread rename. Update or restart that Pi instance.");
            }
            const expectedLeaderSocketPath = activeLeaderSocketPath;
            const expectedRegistrationGeneration = activeRegistrationGeneration;
            const expectedAuthSecret = activeAuthSecret;
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: expectedLeaderSocketPath,
                timeoutMs: registrationTimeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: expectedLeaderSocketPath,
                    operation: "operation",
                }),
                envelope: {
                    kind: "follower.renameThread",
                    requestId: deps.createRequestId(),
                    auth: expectedAuthSecret,
                    instanceId: deps.instanceId,
                    registrationGeneration: expectedRegistrationGeneration,
                    target,
                    threadName,
                    sentAtMs: getNowMs(),
                },
            });
            if (response?.kind !== "bus.ack" || !response.ok) {
                throw new Error(response?.kind === "bus.ack"
                    ? (response.message ?? "Telegram Workspace Thread rename was rejected.")
                    : "Telegram Workspace Thread rename was not acknowledged.");
            }
            if (activeLeaderSocketPath !== expectedLeaderSocketPath ||
                activeRegistrationGeneration !== expectedRegistrationGeneration ||
                (deps.registrationState &&
                    deps.registrationState.getGeneration() !==
                        expectedRegistrationGeneration)) {
                throw new Error("Telegram Workspace Thread rename completed for a stale follower registration.");
            }
            const renamedThreadName = response.result &&
                typeof response.result === "object" &&
                "threadName" in response.result &&
                typeof response.result.threadName === "string"
                ? response.result.threadName
                : threadName;
            const registrationTarget = deps.registrationState?.getTarget();
            if (deps.registrationState && registrationTarget) {
                deps.registrationState.setRegistered(true, registrationTarget, {
                    slot: deps.registrationState.getSlot(),
                    threadName: renamedThreadName,
                    generation: expectedRegistrationGeneration,
                    leaderProtocol: deps.registrationState.getLeaderProtocol(),
                });
            }
            return renamedThreadName;
        },
        async resetThreadName(target) {
            if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
                throw new Error("Telegram follower is not registered with the leader.");
            }
            if (deps.registrationState && !hasTelegramBusCapability(deps.registrationState.getLeaderProtocol(), TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME)) {
                throw new Error("The active Telegram leader does not support Workspace Thread reset. Update or restart that Pi instance.");
            }
            const expectedLeaderSocketPath = activeLeaderSocketPath;
            const expectedRegistrationGeneration = activeRegistrationGeneration;
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: expectedLeaderSocketPath,
                timeoutMs: registrationTimeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: expectedLeaderSocketPath,
                    operation: "operation",
                }),
                envelope: {
                    kind: "follower.resetThreadName",
                    requestId: deps.createRequestId(),
                    auth: activeAuthSecret,
                    instanceId: deps.instanceId,
                    registrationGeneration: expectedRegistrationGeneration,
                    target,
                    sentAtMs: getNowMs(),
                },
            });
            const resetName = response?.kind === "bus.ack" && response.ok &&
                response.result && typeof response.result === "object" &&
                "threadName" in response.result &&
                typeof response.result.threadName === "string"
                ? response.result.threadName : undefined;
            if (!resetName) {
                throw new Error(response?.kind === "bus.ack"
                    ? response.message ?? "Telegram Workspace Thread reset was rejected."
                    : "Telegram Workspace Thread reset was not acknowledged.");
            }
            if (activeLeaderSocketPath !== expectedLeaderSocketPath ||
                activeRegistrationGeneration !== expectedRegistrationGeneration ||
                (deps.registrationState && deps.registrationState.getGeneration() !==
                    expectedRegistrationGeneration)) {
                throw new Error("Telegram Workspace Thread reset completed for a stale follower registration.");
            }
            const registrationTarget = deps.registrationState?.getTarget();
            if (deps.registrationState && registrationTarget) {
                deps.registrationState.setRegistered(true, registrationTarget, {
                    slot: deps.registrationState.getSlot(),
                    threadName: resetName,
                    generation: expectedRegistrationGeneration,
                    leaderProtocol: deps.registrationState.getLeaderProtocol(),
                });
            }
            return resetName;
        },
        async requestSessionReplacement(operation, intent) {
            if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
                throw new Error("Telegram follower is not registered with the leader.");
            }
            if (!hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT) ||
                !hasTelegramBusCapability(deps.registrationState?.getLeaderProtocol(), TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT)) {
                throw new Error("The active Telegram leader does not support follower session replacement. Update or restart that Pi instance.");
            }
            const expectedLeaderSocketPath = activeLeaderSocketPath;
            const expectedRegistrationGeneration = activeRegistrationGeneration;
            const expectedAuthSecret = activeAuthSecret;
            const requestId = deps.createRequestId();
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: expectedLeaderSocketPath,
                timeoutMs: registrationTimeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: expectedLeaderSocketPath,
                    operation: "operation",
                }),
                envelope: {
                    kind: operation === "publish"
                        ? "follower.publishSessionReplacement"
                        : "follower.settleSessionReplacement",
                    requestId,
                    auth: expectedAuthSecret,
                    instanceId: deps.instanceId,
                    registrationGeneration: expectedRegistrationGeneration,
                    intent,
                    sentAtMs: getNowMs(),
                },
            });
            if (response?.kind !== "bus.ack" || !response.ok ||
                response.requestId !== requestId ||
                !isRecord(response.result) || response.result.committed !== true) {
                throw new Error(response?.kind === "bus.ack"
                    ? (response.message ?? "Telegram session replacement was rejected.")
                    : "Telegram session replacement was not acknowledged.");
            }
            if (activeLeaderSocketPath !== expectedLeaderSocketPath ||
                activeRegistrationGeneration !== expectedRegistrationGeneration ||
                activeAuthSecret !== expectedAuthSecret ||
                (deps.registrationState &&
                    deps.registrationState.getGeneration() !==
                        expectedRegistrationGeneration)) {
                throw new Error("Telegram session replacement completed for a stale follower registration.");
            }
            return true;
        },
        async disconnectFromLeader() {
            if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
                return false;
            }
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: activeLeaderSocketPath,
                timeoutMs: registrationTimeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: activeLeaderSocketPath,
                    operation: "operation",
                }),
                envelope: {
                    kind: "follower.disconnect",
                    requestId: deps.createRequestId(),
                    auth: activeAuthSecret,
                    instanceId: deps.instanceId,
                    registrationGeneration: activeRegistrationGeneration,
                    sentAtMs: getNowMs(),
                },
            });
            if (response?.kind === "bus.ack" && response.ok)
                return true;
            throw new Error(response?.kind === "bus.ack"
                ? (response.message ?? "Telegram follower disconnect was rejected.")
                : "Telegram follower disconnect was not acknowledged.");
        },
        stop,
    };
}
const TELEGRAM_FOLLOWER_FORWARD_BATCH_POSITION_FIELD = "pi_telegram_forward_comment_batch_position";
/** Bind source-owned sender checks to the journal's already-admitted synchronous v1 hook. */
export function createTelegramBusFollowerPairedAdmission(deps) {
    return (updates, publish) => {
        if (updates.length !== 1)
            return { admitted: false };
        const update = updates[0];
        const keys = Object.keys(update).filter((key) => key !== "update_id" && key !== TELEGRAM_FOLLOWER_FORWARD_BATCH_POSITION_FIELD);
        if (keys.length !== 1)
            return { admitted: false };
        const kind = keys[0];
        if (kind !== "message" && kind !== "edited_message" &&
            kind !== "callback_query" && kind !== "message_reaction")
            return { admitted: false };
        const position = update[TELEGRAM_FOLLOWER_FORWARD_BATCH_POSITION_FIELD];
        if (position !== undefined && (kind !== "message" ||
            (position !== "comment" && position !== "forward")))
            return { admitted: false };
        const carrier = update[kind];
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0 ||
            !isRecord(carrier) || carrier.pi_telegram_source_update_id !== update.update_id ||
            carrier.sender_chat !== undefined || carrier.actor_chat !== undefined)
            return { admitted: false };
        const sender = kind === "message_reaction" ? carrier.user : carrier.from;
        if (!isRecord(sender) || typeof sender.id !== "number" || !Number.isSafeInteger(sender.id) ||
            sender.id <= 0 || sender.is_bot !== false)
            return { admitted: false };
        return deps.configStore.withPairedUserAdmission(deps.profileName, deps.tokenSha256, sender.id, publish, deps.assertExecutionCurrent);
    };
}
export function prepareTelegramBusFollowerJournaledUpdateForExecution(update, prepareForwardedMessage) {
    const position = update[TELEGRAM_FOLLOWER_FORWARD_BATCH_POSITION_FIELD];
    if (update.message !== undefined &&
        (position === "comment" || position === "forward")) {
        prepareForwardedMessage(update.message, position);
    }
    if (position === undefined)
        return update;
    const prepared = { ...update };
    delete prepared[TELEGRAM_FOLLOWER_FORWARD_BATCH_POSITION_FIELD];
    return prepared;
}
export function createTelegramBusFollowerDurableAdmissionRuntime(deps) {
    return {
        async admit(envelope, ctx) {
            const delivery = envelope.delivery;
            if (!delivery) {
                throw new Error("Telegram follower durable admission requires delivery identity.");
            }
            if (envelope.kind === "leader.wakeInputCustody")
                throw new Error("Telegram follower custody wake cannot use executable-copy admission.");
            const expected = createTelegramBusFollowerDeliveryIdentity({
                kind: envelope.kind,
                recipientBindingKey: delivery.recipientBindingKey,
                sourceUpdateId: delivery.sourceUpdateId,
            });
            if (expected.deliveryId !== delivery.deliveryId) {
                throw new Error("Invalid Telegram follower delivery id.");
            }
            const carrier = envelope.kind === "leader.forwardCallback"
                ? envelope.query
                : envelope.kind === "leader.forwardReaction"
                    ? envelope.reactionUpdate
                    : envelope.message;
            if (!isRecord(carrier) ||
                carrier.pi_telegram_source_update_id !== delivery.sourceUpdateId) {
                throw new Error("Telegram follower delivery source update id mismatch.");
            }
            const update = {
                update_id: delivery.sourceUpdateId,
                ...(envelope.kind === "leader.forwardMessage" &&
                    envelope.forwardCommentBatchPosition
                    ? {
                        [TELEGRAM_FOLLOWER_FORWARD_BATCH_POSITION_FIELD]: envelope.forwardCommentBatchPosition,
                    }
                    : {}),
                ...(envelope.kind === "leader.forwardCallback"
                    ? { callback_query: carrier }
                    : envelope.kind === "leader.forwardReaction"
                        ? { message_reaction: carrier }
                        : envelope.kind === "leader.forwardMessage"
                            ? { message: carrier }
                            : { edited_message: carrier }),
            };
            deps.journal.appendBatch([update]);
            deps.signalWorker(ctx);
            return {
                deliveryId: delivery.deliveryId,
                sourceUpdateId: delivery.sourceUpdateId,
            };
        },
    };
}
export function createTelegramBusFollowerInputCustodyPorts(deps) {
    const getRequired = () => {
        const bundle = deps.getInputCustodyBus();
        if (!bundle)
            throw new Error("Telegram input custody bus binding is unavailable.");
        return bundle;
    };
    return {
        isSourceReferenceAdmissionEnabled: () => Boolean(deps.getInputCustodyBus()),
        handleInputCustodyHandoff(envelope, ctx) {
            return getRequired().acceptHandoff({ sourceRecoveryKey: envelope.sourceRecoveryKey,
                recipientBindingKey: envelope.recipientBindingKey,
                source: envelope.source, handoffId: envelope.handoffId }, ctx);
        },
        sourceReferenceAdmission: createTelegramBusFollowerSourceReferenceAdmissionRuntime({
            wakeSource(input, ctx) { getRequired().wakeSource(input, ctx); },
        }),
        resolveInputCustodyReference(input) {
            return deps.getInputCustodyBus()?.resolveForwardReference(input);
        },
    };
}
export function createTelegramBusFollowerSourceReferenceAdmissionRuntime(deps) {
    return {
        async admit(envelope, ctx) {
            const delivery = envelope.delivery;
            if (!delivery)
                throw new Error("Telegram follower source-reference admission requires delivery identity.");
            if (!delivery.sourceRecoveryKey)
                throw new Error("Telegram follower source-reference admission requires a recovery key.");
            if (!delivery.sourceClaim)
                throw new Error("Telegram follower source-reference admission requires exact claim evidence.");
            const expected = createTelegramBusFollowerDeliveryIdentity({ kind: envelope.kind,
                recipientBindingKey: delivery.recipientBindingKey,
                sourceUpdateId: delivery.sourceUpdateId });
            if (expected.deliveryId !== delivery.deliveryId)
                throw new Error("Invalid Telegram follower source-reference delivery id.");
            const carrier = envelope.kind === "leader.wakeInputCustody" ? undefined
                : envelope.kind === "leader.forwardCallback" ? envelope.query
                    : envelope.kind === "leader.forwardReaction" ? envelope.reactionUpdate : envelope.message;
            if (envelope.kind !== "leader.wakeInputCustody" &&
                (!isRecord(carrier) || carrier.pi_telegram_source_update_id !== delivery.sourceUpdateId))
                throw new Error("Telegram follower source-reference update id mismatch.");
            await deps.wakeSource({ deliveryId: delivery.deliveryId,
                sourceUpdateId: delivery.sourceUpdateId,
                recipientBindingKey: delivery.recipientBindingKey,
                sourceRecoveryKey: delivery.sourceRecoveryKey,
                sourceClaim: { ...delivery.sourceClaim } }, ctx);
            return { deliveryId: delivery.deliveryId, sourceUpdateId: delivery.sourceUpdateId };
        },
    };
}
export function createTelegramBusForwardedUpdateReceiverRuntime(deps) {
    const server = createTelegramBusLocalServer({
        socketPath: deps.socketPath,
        recordTransportEvent(phase, details) {
            deps.recordRuntimeEvent?.("bus", `Telegram bus ${phase}`, {
                phase: `follower-receiver-${phase}`,
                ...details,
            });
        },
        async handleEnvelope(envelope) {
            const authSecret = deps.getAuthSecret?.();
            if (deps.getAuthSecret &&
                (!authSecret || !isTelegramBusEnvelopeAuthorized(envelope, authSecret))) {
                return createUnauthorizedBusAck(envelope.requestId);
            }
            if ((envelope.kind !== "leader.forwardCallback" &&
                envelope.kind !== "leader.forwardReaction" &&
                envelope.kind !== "leader.forwardMessage" &&
                envelope.kind !== "leader.forwardEditedMessage" &&
                envelope.kind !== "leader.wakeInputCustody" &&
                envelope.kind !== "leader.offerInputCustodyHandoff" &&
                envelope.kind !== "leader.replaceFollowerTarget" &&
                envelope.kind !== "leader.offerQueueHandoff") ||
                envelope.recipientInstanceId !== deps.instanceId) {
                return {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: false,
                    message: "Telegram bus receiver cannot handle this envelope.",
                };
            }
            const registrationGeneration = deps.getRegistrationGeneration();
            if (!registrationGeneration ||
                envelope.recipientRegistrationGeneration !== registrationGeneration) {
                return {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: false,
                    message: "Stale Telegram bus follower registration generation.",
                };
            }
            if (envelope.kind === "leader.offerInputCustodyHandoff" &&
                envelope.recipientBindingKey !== deps.getRecipientBindingKey())
                return {
                    kind: "bus.ack", requestId: envelope.requestId, ok: false,
                    message: "Mismatched Telegram follower handoff recipient identity.",
                };
            if (envelope.kind !== "leader.replaceFollowerTarget" &&
                envelope.kind !== "leader.offerQueueHandoff" &&
                envelope.kind !== "leader.offerInputCustodyHandoff" &&
                (!envelope.delivery ||
                    envelope.delivery.recipientBindingKey !==
                        deps.getRecipientBindingKey())) {
                return {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: false,
                    message: "Mismatched Telegram follower delivery identity.",
                };
            }
            const ctx = deps.getContext();
            if (!ctx) {
                return {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: false,
                    message: "Telegram bus follower has no active context.",
                };
            }
            try {
                if (envelope.kind === "leader.offerInputCustodyHandoff") {
                    if (!(deps.isSourceReferenceAdmissionEnabled?.() ?? false))
                        throw new Error("Telegram input custody handoff capability is not enabled.");
                    if (!deps.hasAuthenticatedSourceReferenceTransport?.())
                        throw new Error("Telegram input custody handoff requires authenticated transport.");
                    if (!deps.handleInputCustodyHandoff)
                        throw new Error("Telegram input custody handoff acceptance is unavailable.");
                    const result = await deps.handleInputCustodyHandoff(envelope, ctx);
                    return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result };
                }
                if (envelope.kind !== "leader.replaceFollowerTarget" &&
                    envelope.kind !== "leader.offerQueueHandoff") {
                    const sourceReferenceEnabled = envelope.kind === "leader.wakeInputCustody" ||
                        (deps.isSourceReferenceAdmissionEnabled?.() ?? false);
                    if (sourceReferenceEnabled &&
                        !deps.hasAuthenticatedSourceReferenceTransport?.())
                        throw new Error("Telegram follower source-reference admission requires authenticated transport.");
                    const admission = sourceReferenceEnabled
                        ? deps.sourceReferenceAdmission : deps.durableAdmission;
                    if (!admission)
                        throw new Error("Telegram follower source-reference admission is enabled without a wake authority.");
                    const receipt = await admission.admit(envelope, ctx);
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: true,
                        result: receipt,
                    };
                }
                if (envelope.kind === "leader.offerQueueHandoff") {
                    if (!deps.handleQueueHandoff) {
                        throw new Error("Telegram bus receiver cannot accept queue handoff payloads.");
                    }
                    const result = await deps.handleQueueHandoff(envelope, ctx);
                    const receipt = envelope.payload.admissionReceipts[0];
                    if (envelope.payload.admissionReceipts.length !== 1 ||
                        !receipt ||
                        result.status !== "staged" ||
                        result.receiptId !== receipt.receiptId ||
                        result.sourceUpdateIds.length !== receipt.sourceUpdateIds.length ||
                        result.sourceUpdateIds.some((updateId, index) => updateId !== receipt.sourceUpdateIds[index])) {
                        throw new Error("Telegram queue handoff staging returned a mismatched receipt.");
                    }
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: true,
                        result,
                    };
                }
                {
                    if (!deps.handleReplaceTarget) {
                        throw new Error("Telegram bus receiver cannot replace follower target.");
                    }
                    await deps.handleReplaceTarget({
                        target: envelope.target,
                        ...(envelope.oldTarget ? { oldTarget: envelope.oldTarget } : {}),
                        reason: envelope.reason,
                        registrationGeneration,
                    }, ctx);
                }
                return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
            }
            catch (error) {
                deps.recordRuntimeEvent?.("bus", error, { phase: "follower-forward" });
                return {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: false,
                    message: error instanceof Error
                        ? error.message
                        : "Telegram bus follower dispatch failed.",
                };
            }
        },
    });
    return server;
}
function parseRegistrationResult(value) {
    if (!isRecord(value))
        return {};
    const target = parseTarget(isRecord(value.target) ? value.target : value);
    return {
        ...(target ? { target } : {}),
        ...(typeof value.slot === "string" ? { slot: value.slot } : {}),
        ...(typeof value.threadName === "string"
            ? { threadName: value.threadName }
            : {}),
        ...(typeof value.displayTitle === "string"
            ? { displayTitle: value.displayTitle }
            : {}),
    };
}
function parseTarget(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value) || typeof value.chatId !== "number")
        return undefined;
    const target = { chatId: value.chatId };
    if (typeof value.threadId === "number")
        target.threadId = value.threadId;
    return target;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
