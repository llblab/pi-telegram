/**
 * Telegram bus leader orchestration
 * Zones: multi-instance bus, leader polling/server lifecycle, follower routing
 * Owns leader-only runtime orchestration: follower registration envelopes, follower API proxying,
 * leader activation hot-switching, local bus server startup, and stale follower pruning.
 */
import * as Sync from "./sync.js";
import { createTelegramThreadDisplayReconciler, resolveTelegramInitialWorkspaceDisplayName, resolveTelegramLiveWorkspaceBindingKeys, } from "./thread-display.js";
import * as ThreadReconciler from "./thread-reconciler.js";
import { getTelegramApiErrorRequestTarget, isTelegramApiCommitUnknownError, } from "./telegram-api.js";
import * as Threads from "./threads.js";
import { createTelegramBusLocalServer, createUnauthorizedBusAck, getTelegramBusEnvelopeTrafficClass, getTelegramBusProtocolCompatibility, hasTelegramBusCapability, isTelegramBusEnvelopeAuthorized, getTelegramBusFollowerSocketPath, sendTelegramBusLocalEnvelope, stripTelegramBusApiMetadata, TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF, TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT, TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE, TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT, TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT, } from "./bus.js";
import { getTelegramBusTransportRetryPolicy } from "./bus-transport.js";
import { createTelegramWorkspaceOperationRuntime, createTelegramWorkspaceSlotRotation, } from "./workspace-retirement.js";
import { createTelegramWorkspaceAdmissionOperationId, runWithTelegramWorkspaceAdmissionsAsync, } from "./workspace-admission.js";
import { TELEGRAM_WORKSPACE_SLOTS, TelegramWorkspaceSlotUnavailableError } from "./workspace-slots.js";
export const TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS = 15_000;
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function formatTelegramBusInstanceLabel(input) {
    const threadName = input.threadName?.trim();
    if (threadName)
        return escapeHtml(threadName);
    return input.slot && /^[A-Z]$/.test(input.slot) ? input.slot : "?";
}
/**
 * Leader-owned durable session-replacement authority for registered followers.
 * Followers cannot persist `state.json`; the leader validates the request
 * against its live registry entry and authoritative Workspace binding before
 * one CAS publication or claim. Follower memory is never accepted as binding
 * evidence.
 */
export function createTelegramBusFollowerSessionReplacementAuthority(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const ttlMs = deps.ttlMs ?? Threads.TELEGRAM_LEADER_SESSION_HANDOFF_TTL_MS;
    const assertCommon = (follower, intent) => {
        const cwd = follower.cwd
            ? Threads.normalizeTelegramWorkspacePath(follower.cwd)
            : undefined;
        const sessionId = follower.sessionId
            ? Threads.normalizeTelegramSessionId(follower.sessionId)
            : undefined;
        const nowMs = getNowMs();
        if (intent.continuity !== "workspace-thread" ||
            typeof intent.target.threadId !== "number" ||
            follower.target?.chatId !== intent.target.chatId ||
            follower.target.threadId !== intent.target.threadId ||
            !cwd || cwd !== intent.cwd || !sessionId ||
            intent.profileName !== (deps.getTelegramProfile?.() ?? "default")) {
            throw new Error("Telegram session replacement does not match the current follower registration.");
        }
        if (intent.expiresAtMs <= nowMs || intent.expiresAtMs > nowMs + ttlMs) {
            throw new Error("Telegram session replacement intent is expired or unbounded.");
        }
        return { cwd, sessionId };
    };
    return {
        async publish(follower, intent, isCurrent) {
            const { sessionId } = assertCommon(follower, intent);
            if (intent.sourceInstanceId !== follower.instanceId ||
                intent.sourceSessionId !== sessionId) {
                throw new Error("Telegram session replacement source does not match the current follower registration.");
            }
            await deps.store.load();
            if (!isCurrent())
                return false;
            const binding = deps.store.getWorkspaceBindingByTarget(intent.target);
            if (!binding || binding.cwd !== intent.cwd ||
                binding.sessionId !== intent.sourceSessionId ||
                binding.slot !== intent.slot ||
                (binding.manualThreadName ?? binding.threadName) !== intent.threadName) {
                throw new Error("Telegram session replacement binding is unavailable.");
            }
            return deps.store.commitSessionReplacementIntent(intent, isCurrent);
        },
        async settle(follower, intent, isCurrent) {
            const { sessionId } = assertCommon(follower, intent);
            if (!intent.sourceInstanceId ||
                (intent.sourceInstanceId !== follower.instanceId &&
                    intent.sourceInstanceId !== follower.previousInstanceId) ||
                intent.sourceSessionId === sessionId) {
                throw new Error("Telegram session replacement successor does not match the current follower registration.");
            }
            await deps.store.load();
            if (!isCurrent())
                return false;
            if (deps.store.getWorkspaceBindingByTarget(intent.target, sessionId)?.cwd !==
                intent.cwd) {
                throw new Error("Telegram session replacement successor binding is unavailable.");
            }
            return deps.store.removeSessionReplacementIntent(intent, isCurrent);
        },
    };
}
export function createTelegramBusLeaderRuntimeAssembly(deps) {
    const runWorkspaceAdmission = deps.getWorkspaceAdmission
        ? (input, operation) => {
            const admission = deps.getWorkspaceAdmission?.();
            if (!admission) {
                throw new Error("Telegram Workspace admission authority is unavailable.");
            }
            return runWithTelegramWorkspaceAdmissionsAsync({
                ledger: admission,
                ...input,
                operation,
                onReleaseError(error) {
                    deps.recordRuntimeEvent("bus", error, {
                        phase: "workspace-admission-release",
                        operationKind: input.operationKind,
                    });
                },
            });
        }
        : undefined;
    const runWorkspaceOperation = deps.runWorkspaceOperation ??
        createTelegramWorkspaceOperationRuntime({
            getWorkspaceAdmission: deps.getWorkspaceAdmission,
            onReleaseError(error, operationKind) {
                deps.recordRuntimeEvent("bus", error, {
                    phase: "workspace-admission-release",
                    operationKind,
                });
            },
        }).run;
    const runWithWorkspaceCapacity = deps.workspaceRotation && deps.captureWorkspaceExternalProtection &&
        deps.getCurrentLeaderEpoch ? createTelegramWorkspaceSlotRotation({
        ...deps.workspaceRotation, store: deps.topicTargetStore,
        getLeaderEpoch: deps.getCurrentLeaderEpoch,
        getExternalProtection: deps.captureWorkspaceExternalProtection,
        recordEvent(message, details) { deps.recordRuntimeEvent("bus", message, details); },
    }) : undefined;
    const captureLiveBindingKeys = (bindings) => resolveTelegramLiveWorkspaceBindingKeys(bindings, deps.topicTargetStore.getActiveByInstanceId(deps.instanceId)?.target, deps.runtime.followerRegistry.list());
    const provisionerPorts = {
        getAllowedUserId: deps.getAllowedUserId,
        topicTargetStore: deps.topicTargetStore,
        callApi: deps.callApi,
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        getSyncState: deps.getSyncState,
        setSyncState: deps.setSyncState,
        onProvisioningStart: deps.onProvisioningStart,
        onProvisioningEnd: deps.onProvisioningEnd,
        ...(deps.getThreadDisplayMode
            ? {
                resolveInitialWorkspaceDisplayTitle(binding) {
                    return resolveTelegramInitialWorkspaceDisplayName({
                        bindings: deps.topicTargetStore.listWorkspaceBindings(),
                        binding,
                        mode: deps.getThreadDisplayMode(),
                        liveBindingKeys: captureLiveBindingKeys(deps.topicTargetStore.listWorkspaceBindings()),
                    });
                },
            }
            : {}),
        runWorkspaceOperation,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    };
    const display = deps.getThreadDisplayMode ? createTelegramThreadDisplayReconciler({
        store: deps.topicTargetStore,
        getMode: deps.getThreadDisplayMode,
        getProfileKey: () => deps.getTelegramProfile?.() ?? "default",
        getLeaderEpoch: () => deps.getCurrentLeaderEpoch?.(),
        captureLiveBindingKeys,
        captureBindingAuthority(binding) {
            const matches = (target) => target?.chatId === binding.target.chatId && target?.threadId === binding.target.threadId;
            const leader = deps.topicTargetStore.getActiveByInstanceId(deps.instanceId);
            if (leader && matches(leader.target)) {
                return () => matches(deps.topicTargetStore.getActiveByInstanceId(deps.instanceId)?.target);
            }
            const follower = deps.runtime.followerRegistry.getByTarget(binding.target);
            if (!follower?.registrationGeneration)
                return undefined;
            const generation = follower.registrationGeneration;
            return () => {
                const current = deps.runtime.followerRegistry.get(follower.instanceId);
                return current?.registrationGeneration === generation && matches(current.target);
            };
        },
        callApi: deps.callApi,
    }) : undefined;
    const reconcileThreadDisplayOperation = async () => {
        const result = await display.reconcile();
        deps.onThreadDisplayChanged?.();
        return result;
    };
    const reconcileThreadDisplay = () => runWorkspaceOperation({
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind: "workspace.reconcile-display",
        scopes: [{ kind: "profile" }],
    }, reconcileThreadDisplayOperation);
    let startupDisplayTimer;
    let startupDisplayGeneration = 0;
    let startupDisplaySettled = true;
    const cancelStartupDisplayStabilization = () => {
        startupDisplayGeneration += 1;
        startupDisplaySettled = true;
        if (startupDisplayTimer)
            clearTimeout(startupDisplayTimer);
        startupDisplayTimer = undefined;
    };
    const scheduleDisplay = () => {
        if (!display || !startupDisplaySettled)
            return;
        void reconcileThreadDisplay().catch((error) => {
            deps.recordRuntimeEvent("bus", error, { phase: "thread-display-reconcile" });
        });
    };
    const beginStartupDisplayStabilization = () => {
        cancelStartupDisplayStabilization();
        startupDisplaySettled = false;
    };
    const armStartupDisplayReconciliation = () => {
        const generation = startupDisplayGeneration;
        const delayMs = deps.runtime.followerStaleAfterMs ??
            TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS;
        startupDisplayTimer = setTimeout(() => {
            if (startupDisplayGeneration !== generation)
                return;
            startupDisplayTimer = undefined;
            startupDisplaySettled = true;
            scheduleDisplay();
        }, delayMs);
        startupDisplayTimer.unref?.();
    };
    let modeTail = Promise.resolve();
    const applyThreadDisplayMode = (mode, isCurrent) => {
        const epoch = deps.getCurrentLeaderEpoch?.();
        const profile = deps.getTelegramProfile?.();
        const current = () => epoch !== undefined && deps.getCurrentLeaderEpoch?.() === epoch &&
            deps.getTelegramProfile?.() === profile && isCurrent();
        const run = modeTail.then(() => runWorkspaceOperation({
            operationId: createTelegramWorkspaceAdmissionOperationId(),
            operationKind: "workspace.set-display-mode",
            scopes: [{ kind: "profile" }],
        }, async () => {
            if (!display || !deps.persistThreadDisplayMode || !current()) {
                throw new Error("Telegram Thread display setting requires current leader authority.");
            }
            const assertDisplayPeers = () => {
                const requiredCapability = mode === "directory-snake" || mode === "directory-title"
                    ? TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT
                    : TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE;
                if (mode !== "names" && deps.runtime.followerRegistry.list().some((follower) => !hasTelegramBusCapability(follower.protocol, requiredCapability)))
                    throw new Error("Update or restart all connected followers before changing Thread display mode.");
            };
            assertDisplayPeers();
            await deps.persistThreadDisplayMode(mode, current);
            assertDisplayPeers();
            if (!current() || deps.getThreadDisplayMode?.() !== mode) {
                throw new Error("Telegram Thread display preference changed before application.");
            }
            await reconcileThreadDisplayOperation();
            if (!current() || deps.getThreadDisplayMode?.() !== mode) {
                throw new Error("Telegram Thread display application lost its originating authority.");
            }
        }));
        modeTail = run.catch(() => undefined);
        return run;
    };
    const provisionLeaderTarget = createTelegramBusLeaderTargetProvisioner({
        ...provisionerPorts,
        instanceId: deps.instanceId,
        getCwd: deps.getCwd,
        getSessionId: deps.getSessionId,
        getTelegramProfile: deps.getTelegramProfile,
        shouldForceFreshUnnamed: deps.shouldForceFreshUnnamed,
        getRequestedThreadName: deps.getRequestedThreadName,
        getThreadReconciliationMachineState: deps.getThreadReconciliationMachineState,
        recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
        setLeaderTarget: deps.setLeaderTarget,
    });
    const disconnectFollower = createTelegramBusFollowerDisconnectHandler({
        ...provisionerPorts,
    });
    const cleanupConfirmedDeadFollower = createTelegramBusFollowerConfirmedDeadHandler({
        ...provisionerPorts,
    });
    const provisionFollowerTarget = createTelegramBusFollowerTargetProvisioner({
        ...provisionerPorts,
    });
    const renameLeaderThreadAdmitted = async (threadName, expectedTarget) => {
        const leaderEpoch = deps.getCurrentLeaderEpoch?.();
        if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
            throw new Error("Telegram Workspace Thread rename requires leader ownership.");
        }
        const record = Threads.findCurrentTelegramInstanceThreadRecord({
            records: deps.topicTargetStore.list(),
            instanceId: deps.instanceId,
        });
        if (typeof record?.target.threadId !== "number") {
            throw new Error("No Workspace Thread is bound to this Pi instance.");
        }
        if (expectedTarget && (record.target.chatId !== expectedTarget.chatId ||
            record.target.threadId !== expectedTarget.threadId)) {
            throw new Error("Telegram Workspace Thread rename target changed.");
        }
        const rename = Threads.createTelegramTopicTargetRenamer({
            store: deps.topicTargetStore,
            callApi: deps.callApi,
            assertAuthority() {
                if (deps.getCurrentLeaderEpoch &&
                    deps.getCurrentLeaderEpoch() !== leaderEpoch) {
                    throw new Error("Telegram Workspace Thread rename lost leader ownership.");
                }
                const current = Threads.findCurrentTelegramInstanceThreadRecord({
                    records: deps.topicTargetStore.list(),
                    instanceId: deps.instanceId,
                });
                if (current?.target.chatId !== record.target.chatId ||
                    current.target.threadId !== record.target.threadId) {
                    throw new Error("Telegram Workspace Thread rename target changed.");
                }
            },
        });
        const renamed = await rename({
            target: {
                chatId: record.target.chatId,
                threadId: record.target.threadId,
            },
            threadName,
            slot: record.slot,
        });
        if (!renamed) {
            throw new Error(Threads.getTelegramTopicThreadNameValidationError(threadName, record.slot) ?? "Telegram Workspace Thread name is already reserved.");
        }
        await deps.topicTargetStore.persist();
        return renamed;
    };
    const resetThreadNameAdmitted = async (target, assertTargetCurrent = () => undefined) => {
        const leaderEpoch = deps.getCurrentLeaderEpoch?.();
        if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
            throw new Error("Telegram Workspace Thread reset requires leader ownership.");
        }
        const binding = deps.topicTargetStore.listWorkspaceBindings().find((candidate) => candidate.target.chatId === target.chatId &&
            candidate.target.threadId === target.threadId);
        if (!binding)
            throw new Error("No Workspace Thread binding is available to reset.");
        const automaticTitle = resolveTelegramInitialWorkspaceDisplayName({
            bindings: deps.topicTargetStore.listWorkspaceBindings(),
            binding: { ...binding, manualThreadName: undefined },
            mode: deps.getThreadDisplayMode?.() ?? "letters",
            preserveRetainedManualName: false,
        });
        if (!automaticTitle) {
            throw new Error("Telegram Workspace automatic title is unavailable.");
        }
        assertTargetCurrent();
        await deps.callApi("editForumTopic", {
            chat_id: target.chatId,
            message_thread_id: target.threadId,
            name: automaticTitle,
        });
        if (deps.getCurrentLeaderEpoch &&
            deps.getCurrentLeaderEpoch() !== leaderEpoch) {
            throw new Error("Telegram Workspace Thread reset lost leader ownership.");
        }
        assertTargetCurrent();
        const reset = deps.topicTargetStore.clearManualNameByTarget(target, automaticTitle);
        if (!reset)
            throw new Error("Telegram Workspace Thread reset changed binding.");
        await deps.topicTargetStore.persist();
        return { threadName: automaticTitle };
    };
    const renameLeaderThread = (threadName) => runWorkspaceOperation({
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind: "workspace.rename-leader",
        scopes: [{ kind: "profile" }],
    }, () => renameLeaderThreadAdmitted(threadName));
    const resetLeaderThreadName = (expectedTarget) => runWorkspaceOperation({
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind: "workspace.reset-leader-name",
        scopes: [{ kind: "profile" }],
    }, () => {
        const record = Threads.findCurrentTelegramInstanceThreadRecord({
            records: deps.topicTargetStore.list(),
            instanceId: deps.instanceId,
        });
        if (!record || typeof record.target.threadId !== "number") {
            throw new Error("No Workspace Thread is bound to this Pi instance.");
        }
        if (record.target.chatId !== expectedTarget.chatId ||
            record.target.threadId !== expectedTarget.threadId) {
            throw new Error("Telegram Workspace Thread reset target changed.");
        }
        return resetThreadNameAdmitted(record.target, () => {
            const current = Threads.findCurrentTelegramInstanceThreadRecord({
                records: deps.topicTargetStore.list(),
                instanceId: deps.instanceId,
            });
            if (current?.target.chatId !== expectedTarget.chatId ||
                current.target.threadId !== expectedTarget.threadId) {
                throw new Error("Telegram Workspace Thread reset target changed.");
            }
        });
    });
    const followerSessionReplacement = createTelegramBusFollowerSessionReplacementAuthority({
        store: deps.topicTargetStore,
        getTelegramProfile: deps.getTelegramProfile,
        getNowMs: deps.runtime.getNowMs,
    });
    const runtime = createTelegramBusLeaderRuntime({
        ...deps.runtime,
        applyThreadDisplayMode,
        getThreadDisplayMode: deps.getThreadDisplayMode,
        onFollowerRegistered: scheduleDisplay,
        provisionLeaderTarget: (ctx) => {
            const chatId = deps.getAllowedUserId();
            const provision = () => runWorkspaceOperation({
                operationId: `leader-provision:${deps.instanceId}`,
                operationKind: "workspace.provision-leader",
                scopes: [
                    typeof chatId === "number"
                        ? { kind: "chat", chatId }
                        : { kind: "profile" },
                ],
            }, () => provisionLeaderTarget(ctx));
            return runWithWorkspaceCapacity ? runWithWorkspaceCapacity(provision) : provision();
        },
        getFollowerDisplayTitle(follower) {
            const binding = deps.topicTargetStore.listWorkspaceBindings().find((binding) => binding.target.chatId === follower.target?.chatId &&
                binding.target.threadId === follower.target?.threadId);
            return binding?.displayTitle ?? binding?.threadName;
        },
        onFollowerDisconnected: async (follower) => {
            await runWorkspaceOperation({
                operationId: createTelegramWorkspaceAdmissionOperationId(),
                operationKind: "workspace.disconnect-follower",
                scopes: [{ kind: "profile" }],
            }, () => disconnectFollower(follower));
            scheduleDisplay();
        },
        async renameFollowerThread(follower, threadName) {
            return runWorkspaceOperation({
                operationId: createTelegramWorkspaceAdmissionOperationId(),
                operationKind: "workspace.rename-follower",
                scopes: [{ kind: "profile" }],
            }, async () => {
                const leaderEpoch = deps.getCurrentLeaderEpoch?.();
                if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
                    throw new Error("Telegram Workspace Thread rename requires leader ownership.");
                }
                if (typeof follower.target?.threadId !== "number") {
                    throw new Error("Telegram follower has no bound Workspace Thread.");
                }
                const rename = Threads.createTelegramTopicTargetRenamer({
                    store: deps.topicTargetStore,
                    callApi: deps.callApi,
                    assertAuthority() {
                        if (deps.getCurrentLeaderEpoch &&
                            deps.getCurrentLeaderEpoch() !== leaderEpoch) {
                            throw new Error("Telegram Workspace Thread rename lost leader ownership.");
                        }
                        const current = deps.runtime.followerRegistry.get(follower.instanceId);
                        if (current?.registrationGeneration !== follower.registrationGeneration ||
                            current?.target?.chatId !== follower.target?.chatId ||
                            current?.target?.threadId !== follower.target?.threadId) {
                            throw new Error("Telegram follower Workspace Thread target changed.");
                        }
                    },
                });
                const renamed = await rename({
                    target: {
                        chatId: follower.target.chatId,
                        threadId: follower.target.threadId,
                    },
                    threadName,
                    slot: follower.slot,
                });
                if (deps.getCurrentLeaderEpoch &&
                    deps.getCurrentLeaderEpoch() !== leaderEpoch) {
                    throw new Error("Telegram Workspace Thread rename lost leader ownership.");
                }
                if (!renamed) {
                    throw new Error(Threads.getTelegramTopicThreadNameValidationError(threadName, follower.slot) ?? "Telegram Workspace Thread name is already reserved.");
                }
                await deps.topicTargetStore.persist();
                return { threadName: renamed.manualThreadName ?? threadName };
            });
        },
        resetFollowerThreadName: (follower) => runWorkspaceOperation({
            operationId: createTelegramWorkspaceAdmissionOperationId(),
            operationKind: "workspace.reset-follower-name",
            scopes: [{ kind: "profile" }],
        }, () => {
            if (!follower.target || typeof follower.target.threadId !== "number") {
                throw new Error("Telegram follower has no bound Workspace Thread.");
            }
            const target = {
                chatId: follower.target.chatId,
                threadId: follower.target.threadId,
            };
            return resetThreadNameAdmitted(target, () => {
                const current = deps.runtime.followerRegistry.get(follower.instanceId);
                if (current?.registrationGeneration !== follower.registrationGeneration ||
                    current?.target?.chatId !== target.chatId ||
                    current?.target?.threadId !== target.threadId) {
                    throw new Error("Telegram follower Workspace Thread target changed.");
                }
            });
        }),
        publishFollowerSessionReplacement: (follower, intent, isCurrent) => runWorkspaceOperation({
            operationId: createTelegramWorkspaceAdmissionOperationId(),
            operationKind: "workspace.publish-follower-session-replacement",
            scopes: [{ kind: "profile" }],
        }, () => followerSessionReplacement.publish(follower, intent, isCurrent)),
        settleFollowerSessionReplacement: (follower, intent, isCurrent) => runWorkspaceOperation({
            operationId: createTelegramWorkspaceAdmissionOperationId(),
            operationKind: "workspace.settle-follower-session-replacement",
            scopes: [{ kind: "profile" }],
        }, () => followerSessionReplacement.settle(follower, intent, isCurrent)),
        onFollowerConfirmedDead: async (follower) => {
            await runWorkspaceOperation({
                operationId: createTelegramWorkspaceAdmissionOperationId(),
                operationKind: "workspace.cleanup-dead-follower",
                scopes: [{ kind: "profile" }],
            }, () => cleanupConfirmedDeadFollower(follower));
            scheduleDisplay();
        },
        async onFollowerConfirmedDeadPreserved(follower, isDetached, operationId) {
            const epoch = deps.getCurrentLeaderEpoch?.();
            const profile = deps.getTelegramProfile?.();
            if (epoch === undefined || !follower.registrationGeneration ||
                typeof follower.target?.threadId !== "number")
                return false;
            const isCurrent = () => isDetached() && deps.getCurrentLeaderEpoch?.() === epoch &&
                deps.getTelegramProfile?.() === profile;
            if (!isCurrent())
                return false;
            const settled = await runWorkspaceOperation({
                operationId,
                operationKind: "workspace.preserve-dead-follower",
                scopes: [{ kind: "profile" }],
            }, async () => {
                if (!isCurrent())
                    return false;
                await deps.topicTargetStore.load();
                if (!isCurrent())
                    return false;
                const record = deps.topicTargetStore.getActiveByInstanceId(follower.instanceId);
                if (!record || (follower.profileKey && record.profileKey !== follower.profileKey) ||
                    record.target.chatId !== follower.target.chatId ||
                    record.target.threadId !== follower.target.threadId)
                    return true;
                const committed = await deps.topicTargetStore.detachTargetOwner(record, isCurrent);
                if (!committed && isCurrent()) {
                    throw new Error("Telegram preserved follower detachment was not committed.");
                }
                return committed;
            });
            if (settled && isCurrent())
                scheduleDisplay();
            return settled;
        },
        provisionFollowerTarget: (registration, options) => runWorkspaceOperation({
            operationId: `follower-provision:${registration.instanceId}:${registration.registrationGeneration}`,
            operationKind: "workspace.provision-follower",
            scopes: [{ kind: "profile" }],
        }, () => provisionFollowerTarget(registration, options)),
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        getTelegramProfile: deps.getTelegramProfile,
        runWorkspaceAdmission,
        runWithWorkspaceCapacity,
        callApi: createTelegramBusLeaderApiProxy({
            call: deps.callApi,
            callMultipart: deps.callMultipart,
            downloadFile: deps.downloadFile,
            recoverStaleTargetError: deps.recoverStaleTargetError,
        }),
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const assembled = {
        ...runtime,
        runWorkspaceOperation,
        renameLeaderThread,
        renameLeaderThreadAdmitted,
        resetLeaderThreadName,
        resetThreadNameAdmitted,
        captureWorkspaceExternalProtection: deps.captureWorkspaceExternalProtection,
        async startPolling(ctx) {
            if (display)
                beginStartupDisplayStabilization();
            try {
                await runtime.startPolling(ctx);
            }
            catch (error) {
                cancelStartupDisplayStabilization();
                throw error;
            }
            if (display)
                armStartupDisplayReconciliation();
        },
        async stopPolling() {
            cancelStartupDisplayStabilization();
            await runtime.stopPolling();
        },
    };
    if (!display)
        return assembled;
    return {
        ...assembled,
        reconcileThreadDisplay,
        setThreadDisplayMode: (mode) => applyThreadDisplayMode(mode, () => true),
    };
}
export function createTelegramBusInstanceLifecycleAnnouncement(input) {
    return {
        target: { ...input.target },
        text: `<b>📡 Instance <i>${formatTelegramBusInstanceLabel(input)}</i> ${input.state}.</b>`,
        parseMode: "HTML",
    };
}
const TELEGRAM_BUS_SLOW_FOLLOWER_REGISTRATION_MS = 1000;
function scheduleTelegramBusLeaderBackgroundTask(task, onError) {
    const timer = setTimeout(() => {
        void task().catch((error) => {
            try {
                onError(error);
            }
            catch {
                // Background diagnostics cannot create an unhandled timer rejection.
            }
        });
    }, 0);
    timer.unref?.();
}
function recordSlowTelegramBusFollowerRegistrationStep(deps, input) {
    if (input.elapsedMs < TELEGRAM_BUS_SLOW_FOLLOWER_REGISTRATION_MS)
        return;
    deps.recordRuntimeEvent("bus", `Telegram bus follower registration step was slow (${input.elapsedMs}ms).`, {
        phase: input.phase,
        elapsedMs: input.elapsedMs,
        instanceId: input.instanceId,
        reused: input.reused,
        chatId: input.target?.chatId,
        threadId: input.target?.threadId,
    });
}
export function createTelegramBusFollowerTargetProvisioner(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const pendingRegistrations = new Map();
    return async (registration, options) => {
        if (options?.existingWorkspaceBindingOnly && !registration.cwd) {
            return undefined;
        }
        const registrationStartedAtMs = Date.now();
        const chatId = deps.getAllowedUserId();
        if (typeof chatId !== "number")
            return registration.target;
        await deps.topicTargetStore.load();
        let capacityUnavailable = false;
        const workspaceIdentity = registration.cwd
            ? deps.topicTargetStore.claimWorkspaceIdentity(registration.cwd, registration.instanceId, registration.previousInstanceId, {
                existingBindingOnly: options?.existingWorkspaceBindingOnly === true,
                sessionId: registration.sessionId,
                onCapacityUnavailable() {
                    capacityUnavailable = true;
                },
            })
            : undefined;
        if (registration.cwd && !workspaceIdentity) {
            if (options?.existingWorkspaceBindingOnly)
                return undefined;
            if (capacityUnavailable) {
                throw new TelegramWorkspaceSlotUnavailableError();
            }
            throw new Error("Telegram Workspace identity is already claimed.");
        }
        const workspaceBinding = workspaceIdentity
            ? deps.topicTargetStore.getWorkspaceBinding(workspaceIdentity.cwd, workspaceIdentity.instanceSlot, workspaceIdentity.sessionId)
            : undefined;
        const provision = Threads.createTelegramTopicTargetProvisioner({
            topicChatId: chatId,
            store: deps.topicTargetStore,
            getNowMs,
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            callApi: deps.callApi,
            // Manual follower registration should create a visible fresh topic unless
            // the same profile key already has a known live/reusable binding. Do not
            // silently claim old offline/failed tabs: they may be closed/deleted in
            // Telegram and therefore invisible to the operator.
            claimPendingTargets: false,
            resolveInitialWorkspaceDisplayTitle: deps.resolveInitialWorkspaceDisplayTitle,
        });
        const recordsBeforeProvision = deps.topicTargetStore.list();
        const followerProfileKey = registration.profileKey ?? `manual:${registration.instanceId}`;
        const requestedTarget = registration.target ?? workspaceBinding?.target;
        const reconnectRecord = recordsBeforeProvision.find((record) => {
            const matchesRequestedTarget = !requestedTarget ||
                (record.target.chatId === requestedTarget.chatId &&
                    record.target.threadId === requestedTarget.threadId);
            const matchesCurrentIdentity = record.instanceId === registration.instanceId ||
                record.profileKey === followerProfileKey;
            const matchesSessionHandoff = !!requestedTarget &&
                !!registration.previousInstanceId &&
                record.instanceId === registration.previousInstanceId &&
                matchesRequestedTarget;
            const matchesWorkspaceRecovery = !!workspaceBinding &&
                record.status === "probe-required" &&
                matchesRequestedTarget;
            return (record.owner?.kind === "manual-follower" &&
                ((matchesCurrentIdentity && matchesRequestedTarget) ||
                    matchesSessionHandoff || matchesWorkspaceRecovery));
        });
        const followerOwner = Threads.getTelegramThreadOwnerFromProfileKey(followerProfileKey);
        const recoverableTarget = !reconnectRecord &&
            requestedTarget?.chatId === chatId &&
            requestedTarget.threadId !== undefined &&
            !recordsBeforeProvision.some((record) => record.target.chatId === requestedTarget.chatId &&
                record.target.threadId === requestedTarget.threadId)
            ? requestedTarget
            : undefined;
        const recoveryHint = recoverableTarget
            ? deps.topicTargetStore.getFollowerRecoveryHintByTarget?.(recoverableTarget)
            : undefined;
        const registrationKey = workspaceIdentity?.bindingKey ||
            followerProfileKey ||
            registration.instanceId;
        const pendingRegistration = pendingRegistrations.get(registrationKey);
        if (pendingRegistration)
            return pendingRegistration;
        const provisionTarget = async () => {
            deps.onProvisioningStart?.();
            try {
                return await provision({
                    instanceId: registration.instanceId,
                    owner: followerOwner.kind === "manual-follower"
                        ? followerOwner
                        : {
                            kind: "manual-follower",
                            instanceId: registration.instanceId,
                        },
                    profileKey: followerProfileKey,
                    threadName: workspaceBinding?.threadName ?? registration.threadName,
                    preferredSlot: workspaceIdentity?.slot ?? workspaceBinding?.slot ?? registration.slot,
                    ...(workspaceIdentity
                        ? {
                            workspaceBindingKey: workspaceIdentity.bindingKey,
                            workspaceCwd: workspaceIdentity.cwd,
                        }
                        : {}),
                });
            }
            finally {
                deps.onProvisioningEnd?.();
            }
        };
        const recoverRequestedTarget = async () => {
            const nowMs = getNowMs();
            const carriedThreadName = workspaceBinding?.threadName ?? registration.threadName;
            const requestedThreadName = carriedThreadName &&
                Threads.isTelegramTopicThreadNameValidForSlot(carriedThreadName, registration.slot)
                ? carriedThreadName
                : recoveryHint?.threadName &&
                    Threads.isTelegramTopicThreadNameValidForSlot(recoveryHint.threadName, recoveryHint.slot)
                    ? recoveryHint.threadName
                    : undefined;
            const requestedSlot = workspaceIdentity?.slot ?? workspaceBinding?.slot ?? registration.slot ?? recoveryHint?.slot;
            const recoveredSlot = deps.topicTargetStore.allocateSlot(followerProfileKey, requestedSlot, workspaceIdentity?.bindingKey);
            if (!recoveredSlot) {
                throw new TelegramWorkspaceSlotUnavailableError();
            }
            const recoveredRecord = {
                profileKey: followerProfileKey,
                owner: followerOwner.kind === "manual-follower"
                    ? followerOwner
                    : {
                        kind: "manual-follower",
                        instanceId: registration.instanceId,
                    },
                target: {
                    chatId: recoverableTarget.chatId,
                    threadId: recoverableTarget.threadId,
                },
                status: "active",
                createdAtMs: registration.connectedAtMs || nowMs,
                updatedAtMs: nowMs,
                instanceId: registration.instanceId,
                ...(requestedThreadName ? { threadName: requestedThreadName } : {}),
                slot: recoveredSlot,
                lastSyncObservedAtMs: nowMs,
                lastReconcileAction: "follower-live-target-recovery",
            };
            return {
                target: recoveredRecord.target,
                reused: true,
                record: recoveredRecord,
            };
        };
        const runRegistration = async () => {
            const recoveryTarget = reconnectRecord?.target ?? recoverableTarget;
            if (recoveryTarget) {
                Threads.assertTelegramPendingTopicRecoveryAllowed(deps.topicTargetStore, recoveryTarget);
            }
            const pendingTargetRecovery = recoverableTarget && deps.topicTargetStore.listPendingProvisions().some((entry) => entry.target?.chatId === recoverableTarget.chatId &&
                entry.target?.threadId === recoverableTarget.threadId &&
                (entry.instanceId === registration.instanceId || entry.profileKey === followerProfileKey));
            let result = reconnectRecord
                ? {
                    target: reconnectRecord.target,
                    reused: true,
                    record: reconnectRecord,
                }
                : recoverableTarget && !pendingTargetRecovery
                    ? await recoverRequestedTarget()
                    : await provisionTarget();
            const alignResultWithWorkspaceSlot = () => {
                if (!workspaceIdentity ||
                    result.record.slot === workspaceIdentity.slot)
                    return;
                deps.recordRuntimeEvent("bus", "Telegram follower record slot reconciled to its Workspace claim", {
                    phase: "follower-register-slot-reconcile",
                    instanceId: registration.instanceId,
                    chatId: result.target.chatId,
                    threadId: result.target.threadId,
                    previousSlot: result.record.slot,
                    slot: workspaceIdentity.slot,
                });
                result = {
                    ...result,
                    record: { ...result.record, slot: workspaceIdentity.slot },
                };
            };
            alignResultWithWorkspaceSlot();
            const crossSessionReuse = !!reconnectRecord &&
                reconnectRecord.instanceId !== registration.instanceId;
            if (reconnectRecord && !crossSessionReuse) {
                const nowMs = getNowMs();
                const refreshedRecord = deps.topicTargetStore.upsert({
                    ...result.record,
                    instanceId: registration.instanceId,
                    updatedAtMs: nowMs,
                    lastSyncObservedAtMs: nowMs,
                    lastReconcileAction: "follower-register-reuse",
                });
                await deps.topicTargetStore.persist();
                result = {
                    target: refreshedRecord.target,
                    reused: true,
                    record: refreshedRecord,
                };
            }
            const probeRequiredRecord = reconnectRecord?.status === "probe-required";
            const exactSessionHandoff = crossSessionReuse &&
                !!requestedTarget &&
                registration.previousInstanceId === reconnectRecord?.instanceId &&
                requestedTarget.chatId === reconnectRecord.target.chatId &&
                requestedTarget.threadId === reconnectRecord.target.threadId;
            const requiresVisibilityProbe = crossSessionReuse ||
                probeRequiredRecord ||
                recoverableTarget !== undefined;
            let connectedAnnouncement = !result.reused || requiresVisibilityProbe
                ? createTelegramBusInstanceLifecycleAnnouncement({
                    target: result.target,
                    threadName: result.displayTitle ??
                        (workspaceBinding?.target.chatId === result.target.chatId &&
                            workspaceBinding.target.threadId === result.target.threadId
                            ? workspaceBinding.displayTitle : undefined) ?? result.record.threadName,
                    slot: result.record.slot,
                    state: "connected",
                })
                : undefined;
            if (requiresVisibilityProbe && connectedAnnouncement) {
                try {
                    await deps.callApi(exactSessionHandoff ? "sendChatAction" : "sendMessage", exactSessionHandoff
                        ? {
                            chat_id: connectedAnnouncement.target.chatId,
                            message_thread_id: connectedAnnouncement.target.threadId,
                            action: "typing",
                        }
                        : {
                            chat_id: connectedAnnouncement.target.chatId,
                            message_thread_id: connectedAnnouncement.target.threadId,
                            text: connectedAnnouncement.text,
                            parse_mode: connectedAnnouncement.parseMode,
                        });
                    if (recoverableTarget || probeRequiredRecord) {
                        const activatedRecord = deps.topicTargetStore.upsert({
                            ...result.record,
                            ...(probeRequiredRecord && crossSessionReuse
                                ? {
                                    profileKey: followerProfileKey,
                                    owner: followerOwner.kind === "manual-follower"
                                        ? followerOwner
                                        : {
                                            kind: "manual-follower",
                                            instanceId: registration.instanceId,
                                        },
                                    instanceId: registration.instanceId,
                                }
                                : {}),
                            status: "active",
                            updatedAtMs: getNowMs(),
                            lastSyncObservedAtMs: getNowMs(),
                            lastReconcileAction: "follower-live-target-recovery",
                        });
                        await deps.topicTargetStore.persist();
                        result = {
                            target: activatedRecord.target,
                            reused: true,
                            record: activatedRecord,
                        };
                    }
                    else if (crossSessionReuse && reconnectRecord) {
                        const nowMs = getNowMs();
                        const transferredRecord = deps.topicTargetStore.upsert({
                            ...result.record,
                            profileKey: followerProfileKey,
                            owner: followerOwner.kind === "manual-follower"
                                ? followerOwner
                                : {
                                    kind: "manual-follower",
                                    instanceId: registration.instanceId,
                                },
                            instanceId: registration.instanceId,
                            updatedAtMs: nowMs,
                            lastSyncObservedAtMs: nowMs,
                            lastReconcileAction: "follower-session-handoff",
                        });
                        await deps.topicTargetStore.persist();
                        result = {
                            target: transferredRecord.target,
                            reused: true,
                            record: transferredRecord,
                        };
                    }
                    connectedAnnouncement = undefined;
                }
                catch (error) {
                    if (Threads.isTelegramTopicTargetStaleError(error)) {
                        deps.topicTargetStore.markStaleByTarget(result.target, "deleted", error instanceof Error ? error.message : String(error));
                        await deps.topicTargetStore.persist();
                        result = await provisionTarget();
                        connectedAnnouncement =
                            createTelegramBusInstanceLifecycleAnnouncement({
                                target: result.target,
                                threadName: result.displayTitle ?? result.record.threadName,
                                slot: result.record.slot,
                                state: "connected",
                            });
                    }
                    else {
                        deps.recordRuntimeEvent("telegram", error, {
                            phase: "follower-topic-reuse-probe",
                            instanceId: registration.instanceId,
                            chatId: result.target.chatId,
                            threadId: result.target.threadId,
                        });
                        if (recoverableTarget) {
                            deps.topicTargetStore.upsert({
                                ...result.record,
                                status: "probe-required",
                                updatedAtMs: getNowMs(),
                                lastSyncError: error instanceof Error ? error.message : String(error),
                                lastReconcileAction: "follower-visibility-probe-required",
                            });
                            await deps.topicTargetStore.persist();
                        }
                        throw error;
                    }
                }
            }
            if (workspaceIdentity) {
                alignResultWithWorkspaceSlot();
                const workspaceCommit = Threads.commitTelegramWorkspaceProvisionBinding({
                    store: deps.topicTargetStore,
                    instanceId: registration.instanceId,
                    profileKey: followerProfileKey,
                    displayTitle: result.displayTitle,
                    binding: {
                        ...workspaceIdentity,
                        target: { ...result.target },
                        ...(result.record.threadName
                            ? { threadName: result.record.threadName }
                            : {}),
                        slot: workspaceIdentity.slot,
                        journalBindingKeys: [followerProfileKey],
                        journalBindingsComplete: true,
                        updatedAtMs: getNowMs(),
                    },
                });
                if (connectedAnnouncement && workspaceCommit.displayTitle) {
                    connectedAnnouncement = createTelegramBusInstanceLifecycleAnnouncement({
                        target: result.target, threadName: workspaceCommit.displayTitle,
                        slot: result.record.slot, state: "connected",
                    });
                }
                deps.topicTargetStore.markWorkspaceBindingActiveByTarget(result.target);
                await deps.topicTargetStore.persist();
            }
            deps.setSyncState(Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
                nowMs: getNowMs(),
                action: "follower-register",
            }));
            recordSlowTelegramBusFollowerRegistrationStep(deps, {
                phase: "follower-register-critical",
                elapsedMs: Date.now() - registrationStartedAtMs,
                instanceId: registration.instanceId,
                target: result.target,
                reused: result.reused,
            });
            scheduleTelegramBusLeaderBackgroundTask(async () => {
                const backgroundStartedAtMs = Date.now();
                if (connectedAnnouncement) {
                    try {
                        await deps.callApi("sendMessage", {
                            chat_id: connectedAnnouncement.target.chatId,
                            message_thread_id: connectedAnnouncement.target.threadId,
                            text: connectedAnnouncement.text,
                            parse_mode: connectedAnnouncement.parseMode,
                        });
                    }
                    catch (error) {
                        deps.recordRuntimeEvent("telegram", error, {
                            phase: "follower-topic-announce",
                            instanceId: registration.instanceId,
                            chatId: result.target.chatId,
                            threadId: result.target.threadId,
                        });
                    }
                }
                const reconcile = async () => {
                    await ThreadReconciler.applyThreadReconciliationPlan(ThreadReconciler.planThreadReconciliation({
                        nowMs: getNowMs(),
                        currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
                        records: recordsBeforeProvision,
                        pendingProvisions: deps.topicTargetStore.listPendingProvisions(),
                        replacedBindings: [
                            {
                                instanceId: registration.instanceId,
                                replacementTarget: result.target,
                            },
                        ],
                    }), {
                        isCleanupTargetProtected: Threads.createTelegramCleanupTargetProtection(deps.topicTargetStore),
                        callApi: deps.callApi,
                        markStaleByTarget(target, syncStatus, lastSyncError) {
                            return deps.topicTargetStore.markStaleByTarget(target, syncStatus, lastSyncError);
                        },
                        persist() {
                            return deps.topicTargetStore.persist();
                        },
                        removePendingProvisionById(id) {
                            return deps.topicTargetStore.removePendingProvision(id);
                        },
                        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
                        recordRuntimeEvent: deps.recordRuntimeEvent,
                    });
                    await deps.topicTargetStore.persist();
                };
                try {
                    if (deps.runWorkspaceOperation) {
                        await deps.runWorkspaceOperation({
                            operationId: createTelegramWorkspaceAdmissionOperationId(),
                            operationKind: "workspace.reconcile-follower-provision",
                            scopes: [{ kind: "profile" }],
                        }, reconcile);
                    }
                    else {
                        await reconcile();
                    }
                }
                catch (error) {
                    deps.recordRuntimeEvent("telegram", error, {
                        phase: "follower-register-background-reconcile",
                        instanceId: registration.instanceId,
                        chatId: result.target.chatId,
                        threadId: result.target.threadId,
                    });
                }
                recordSlowTelegramBusFollowerRegistrationStep(deps, {
                    phase: "follower-register-background",
                    elapsedMs: Date.now() - backgroundStartedAtMs,
                    instanceId: registration.instanceId,
                    target: result.target,
                    reused: result.reused,
                });
            }, (error) => {
                deps.recordRuntimeEvent("bus", error, {
                    phase: "follower-register-background-owner",
                    instanceId: registration.instanceId,
                });
            });
            return {
                ...result.target,
                slot: result.record.slot,
                threadName: result.record.threadName,
            };
        };
        const registrationPromise = runRegistration().finally(() => {
            pendingRegistrations.delete(registrationKey);
            deps.topicTargetStore.releaseWorkspaceClaim(registration.instanceId);
        });
        pendingRegistrations.set(registrationKey, registrationPromise);
        return registrationPromise;
    };
}
function createTelegramBusFollowerCleanupHandler(deps, trigger) {
    return async (follower) => {
        const target = follower.target;
        if (!target?.threadId)
            return;
        const leaderEpoch = deps.getCurrentLeaderEpoch?.();
        if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
            throw new Error("Follower disconnect cleanup requires leader ownership.");
        }
        if (!follower.registrationGeneration) {
            throw new Error("Follower disconnect cleanup requires an exact registration generation.");
        }
        const intent = {
            id: `cleanup:${follower.instanceId}:${follower.registrationGeneration}:${target.chatId}:${target.threadId}`,
            owner: "manual-follower",
            instanceId: follower.instanceId,
            runtimeGeneration: follower.registrationGeneration,
            ...(follower.profileKey ? { profileKey: follower.profileKey } : {}),
            target: { chatId: target.chatId, threadId: target.threadId },
            requestedAtMs: (deps.getNowMs ?? Date.now)(),
        };
        const departingRecord = deps.topicTargetStore.list().find((record) => record.instanceId === follower.instanceId &&
            record.target.chatId === target.chatId && record.target.threadId === target.threadId);
        const isCleanupTargetProtected = Threads.createTelegramCleanupTargetProtection(deps.topicTargetStore, departingRecord);
        deps.topicTargetStore.upsertPendingCleanup(intent);
        await deps.topicTargetStore.persist();
        const cleanupPlan = ThreadReconciler.planThreadReconciliation({
            nowMs: (deps.getNowMs ?? Date.now)(),
            currentLeaderEpoch: leaderEpoch,
            records: [],
            pendingCleanups: [intent],
        });
        const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(cleanupPlan, {
            isCleanupTargetProtected,
            callApi: deps.callApi,
            markStaleByTarget(target, syncStatus, lastSyncError) {
                return deps.topicTargetStore.markStaleByTarget(target, syncStatus, lastSyncError);
            },
            removeCleanupIntentById: deps.topicTargetStore.removePendingCleanup,
            persist: deps.topicTargetStore.persist,
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        });
        if (cleanupPlan.actions.some((action) => isCleanupTargetProtected(action.target, action)))
            return;
        if (cleanup.incompleteActions?.length) {
            throw new Error("Telegram follower thread deletion was not confirmed; reconnect the leader to retry cleanup.");
        }
        if (deps.getCurrentLeaderEpoch &&
            deps.getCurrentLeaderEpoch() !== leaderEpoch) {
            throw new Error("Follower disconnect cleanup lost leader ownership.");
        }
        deps.setSyncState(Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
            nowMs: (deps.getNowMs ?? Date.now)(),
            action: trigger === "confirmed-dead"
                ? "manual-follower-confirmed-dead"
                : "manual-follower-disconnect",
        }));
        deps.recordRuntimeEvent("bus", trigger === "confirmed-dead"
            ? "Confirmed-dead Telegram bus follower thread cleaned up"
            : "Telegram bus follower disconnected", {
            phase: trigger === "confirmed-dead"
                ? "follower-confirmed-dead-cleanup"
                : "follower-disconnect",
            instanceId: follower.instanceId,
            chatId: target.chatId,
            threadId: target.threadId,
        });
    };
}
export function createTelegramBusFollowerDisconnectHandler(deps) {
    return createTelegramBusFollowerCleanupHandler(deps, "graceful-disconnect");
}
export function createTelegramBusFollowerConfirmedDeadHandler(deps) {
    return createTelegramBusFollowerCleanupHandler(deps, "confirmed-dead");
}
export function createTelegramBusLeaderTargetProvisioner(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    return async (ctx) => {
        const leaderEpoch = deps.getCurrentLeaderEpoch?.();
        if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
            throw new Error("Telegram leader target provisioning requires ownership.");
        }
        await deps.topicTargetStore.load();
        const cwd = deps.getCwd?.(ctx);
        const normalizedCwd = cwd
            ? Threads.normalizeTelegramWorkspacePath(cwd)
            : undefined;
        const profileKey = Threads.getTelegramThreadOwnerKey({
            kind: "leader",
            cwd: normalizedCwd,
            instanceId: deps.instanceId,
            telegramProfile: deps.getTelegramProfile?.(),
        });
        const reusableOwnRecord = deps.topicTargetStore.getByProfileKey(profileKey);
        const pendingCleanups = deps.topicTargetStore.listPendingCleanups();
        const deferredOwnCleanups = reusableOwnRecord?.status === "active"
            ? pendingCleanups.filter((cleanup) => cleanup.owner === "leader" &&
                cleanup.target.chatId === reusableOwnRecord.target.chatId &&
                cleanup.target.threadId === reusableOwnRecord.target.threadId)
            : [];
        const deferredOwnCleanupIds = new Set(deferredOwnCleanups.map((cleanup) => cleanup.id));
        const pendingCleanupPlan = ThreadReconciler.planThreadReconciliation({
            nowMs: getNowMs(),
            currentLeaderEpoch: leaderEpoch,
            previousState: deps.getThreadReconciliationMachineState?.(),
            records: deps.topicTargetStore.list(),
            pendingCleanups: pendingCleanups.filter((cleanup) => !deferredOwnCleanupIds.has(cleanup.id)),
        });
        deps.recordThreadReconciliationPlan?.(pendingCleanupPlan);
        const cleanupPorts = {
            isCleanupTargetProtected: Threads.createTelegramCleanupTargetProtection(deps.topicTargetStore),
            callApi: deps.callApi,
            markStaleByTarget: deps.topicTargetStore.markStaleByTarget,
            removeCleanupIntentById: deps.topicTargetStore.removePendingCleanup,
            persist: deps.topicTargetStore.persist,
            getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        };
        await ThreadReconciler.applyThreadReconciliationPlan(pendingCleanupPlan, cleanupPorts);
        deps.onProvisioningStart?.();
        let ownTarget;
        try {
            ownTarget = await Sync.ensureTelegramLeaderThreadBinding({
                getAllowedUserId: deps.getAllowedUserId,
                instanceId: deps.instanceId,
                cwd: normalizedCwd,
                sessionId: deps.getSessionId?.(ctx),
                telegramProfile: deps.getTelegramProfile?.(),
                forceFreshUnnamed: deps.shouldForceFreshUnnamed?.(),
                requestedThreadName: deps.getRequestedThreadName?.(),
                resolveInitialWorkspaceDisplayTitle: deps.resolveInitialWorkspaceDisplayTitle,
                getNowMs,
                getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
                getThreadReconciliationMachineState: deps.getThreadReconciliationMachineState,
                recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
                topicTargetStore: deps.topicTargetStore,
                callApi: deps.callApi,
                probeWorkspaceBinding: async (binding) => {
                    const announcement = createTelegramBusInstanceLifecycleAnnouncement({
                        target: binding.target,
                        threadName: binding.displayTitle ?? binding.threadName,
                        slot: binding.slot,
                        state: "connected",
                    });
                    await deps.callApi("sendMessage", {
                        chat_id: announcement.target.chatId,
                        message_thread_id: announcement.target.threadId,
                        text: announcement.text,
                        parse_mode: announcement.parseMode,
                    });
                },
                recordEvent: deps.recordRuntimeEvent,
            });
        }
        finally {
            deps.onProvisioningEnd?.();
        }
        if (deferredOwnCleanups.length > 0) {
            const supersededCleanupPlan = ThreadReconciler.planThreadReconciliation({
                nowMs: getNowMs(),
                currentLeaderEpoch: leaderEpoch,
                previousState: deps.getThreadReconciliationMachineState?.(),
                records: deps.topicTargetStore.list(),
                pendingCleanups: deferredOwnCleanups,
            });
            deps.recordThreadReconciliationPlan?.(supersededCleanupPlan);
            await ThreadReconciler.applyThreadReconciliationPlan(supersededCleanupPlan, cleanupPorts);
        }
        if (deps.getCurrentLeaderEpoch &&
            deps.getCurrentLeaderEpoch() !== leaderEpoch) {
            throw new Error("Telegram leader target provisioning lost ownership.");
        }
        if (!ownTarget)
            return;
        deps.setLeaderTarget({
            target: ownTarget.target,
            slot: ownTarget.slot,
            threadName: ownTarget.threadName,
        });
        const nowMs = getNowMs();
        let syncState = deps.getSyncState();
        syncState = Sync.markTelegramSyncSliceFresh(syncState, "target-bindings", {
            nowMs,
            action: "leader-startup",
        });
        syncState = Sync.markTelegramSyncSliceFresh(syncState, "reservations", {
            nowMs,
            action: "leader-startup",
        });
        syncState = Sync.markTelegramSyncSliceFresh(syncState, "topic-capability", {
            nowMs,
            action: "leader-startup",
        });
        deps.setSyncState(syncState);
        if (ownTarget.reused)
            return;
        const connectedAnnouncement = createTelegramBusInstanceLifecycleAnnouncement({
            target: ownTarget.target,
            threadName: ownTarget.displayTitle ?? ownTarget.threadName,
            slot: ownTarget.slot,
            state: "connected",
        });
        try {
            await deps.callApi("sendMessage", {
                chat_id: connectedAnnouncement.target.chatId,
                message_thread_id: connectedAnnouncement.target.threadId,
                text: connectedAnnouncement.text,
                parse_mode: connectedAnnouncement.parseMode,
            });
        }
        catch (error) {
            deps.recordRuntimeEvent("telegram", error, {
                phase: "leader-topic-announce",
                instanceId: deps.instanceId,
                chatId: ownTarget.target.chatId,
                threadId: ownTarget.target.threadId,
                slot: ownTarget.slot,
            });
        }
    };
}
export function createTelegramBusLeaderApiProxy(deps) {
    return async (method, args) => {
        if (method === "call") {
            const body = stripTelegramBusApiMetadata(args[1]);
            try {
                return await deps.call(args[0], body, args[2]);
            }
            catch (error) {
                await deps.recoverStaleTargetError?.(body, error);
                throw error;
            }
        }
        if (method === "callMultipart") {
            const fields = args[1];
            try {
                return await deps.callMultipart(args[0], fields, args[2], args[3], args[4], args[5]);
            }
            catch (error) {
                await deps.recoverStaleTargetError?.(fields, error);
                throw error;
            }
        }
        if (method === "downloadFile") {
            return deps.downloadFile(args[0], args[1]);
        }
        throw new Error(`Unsupported Telegram bus API method: ${method}`);
    };
}
function createTelegramBusFollowerMutationRunner() {
    const tails = new Map();
    return async (follower, operation) => {
        const key = follower.profileKey
            ? `profile:${follower.profileKey}`
            : `instance:${follower.instanceId}`;
        const previous = tails.get(key);
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        tails.set(key, current);
        if (previous)
            await previous;
        try {
            return await operation();
        }
        finally {
            release();
            if (tails.get(key) === current)
                tails.delete(key);
        }
    };
}
export function createTelegramBusLeaderEnvelopeHandler(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const runFollowerMutation = deps.runFollowerMutation ?? createTelegramBusFollowerMutationRunner();
    const handleAgentRequest = async (envelope) => {
        const follower = deps.followerRegistry.get(envelope.instanceId);
        if (!follower) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Unknown Telegram bus follower instance.",
            };
        }
        if (!follower.registrationGeneration ||
            envelope.registrationGeneration !== follower.registrationGeneration) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Stale Telegram bus follower registration generation.",
            };
        }
        deps.followerRegistry.heartbeat(envelope.instanceId, getNowMs());
        if (envelope.kind === "follower.resolveAgentTarget") {
            const target = await deps.resolveAgentTarget?.(follower, envelope.selector);
            return target
                ? {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: true,
                    result: target,
                }
                : {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: false,
                    message: "Telegram agent target is unavailable or ambiguous.",
                };
        }
        if (!deps.routeAgentMessage) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Telegram agent message routing is unavailable.",
            };
        }
        await deps.routeAgentMessage(follower, envelope.message);
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
    };
    const routeQueueHandoff = async (envelope) => {
        const donor = deps.followerRegistry.get(envelope.instanceId);
        if (!donor) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Unknown Telegram bus follower instance.",
            };
        }
        if (!donor.registrationGeneration ||
            envelope.registrationGeneration !== donor.registrationGeneration) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Stale Telegram bus follower registration generation.",
            };
        }
        const recipient = deps.followerRegistry.get(envelope.recipientInstanceId);
        if (!hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF) ||
            !hasTelegramBusCapability(donor.protocol, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF) ||
            !hasTelegramBusCapability(recipient?.protocol, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF)) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Telegram queue handoff capability was not negotiated.",
            };
        }
        if (!recipient?.registrationGeneration ||
            envelope.recipientRegistrationGeneration !==
                recipient.registrationGeneration) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Stale Telegram queue handoff recipient registration generation.",
            };
        }
        if (donor.instanceId === recipient.instanceId) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Telegram queue handoff recipient must be another runtime.",
            };
        }
        if (deps.routeQueueHandoff) {
            const result = await deps.routeQueueHandoff(donor, envelope);
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: true,
                ...(result !== undefined ? { result } : {}),
            };
        }
        const recipientSocketPath = recipient.busSocketPath ??
            getTelegramBusFollowerSocketPath(recipient.instanceId);
        const response = await sendTelegramBusLocalEnvelope({
            socketPath: recipientSocketPath,
            timeoutMs: deps.timeoutMs,
            retry: getTelegramBusTransportRetryPolicy({
                endpoint: recipientSocketPath,
                operation: "operation",
            }),
            envelope: {
                kind: "leader.offerQueueHandoff",
                requestId: envelope.requestId,
                auth: envelope.auth,
                recipientInstanceId: recipient.instanceId,
                recipientRegistrationGeneration: recipient.registrationGeneration,
                donorInstanceId: donor.instanceId,
                donorProcessId: envelope.donorProcessId,
                donorProcessBirthId: envelope.donorProcessBirthId,
                donorSessionGeneration: envelope.donorSessionGeneration,
                donorAcquisitionId: envelope.donorAcquisitionId,
                donorAcquiredAtMs: envelope.donorAcquiredAtMs,
                handoffToken: envelope.handoffToken,
                payload: envelope.payload,
                sentAtMs: envelope.sentAtMs,
            },
        });
        if (response?.kind === "bus.ack" && response.ok) {
            deps.followerRegistry.heartbeat(donor.instanceId, getNowMs());
            deps.followerRegistry.heartbeat(recipient.instanceId, getNowMs());
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: true,
                ...(response.result !== undefined ? { result: response.result } : {}),
            };
        }
        return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: response?.kind === "bus.ack"
                ? response.message
                : "Telegram queue handoff recipient did not acknowledge staging.",
        };
    };
    const forwardToFollower = async (envelope) => {
        const follower = deps.followerRegistry.get(envelope.recipientInstanceId);
        if (!follower) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Unknown Telegram bus follower instance.",
            };
        }
        if (!follower.registrationGeneration ||
            envelope.recipientRegistrationGeneration !==
                follower.registrationGeneration) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Stale Telegram bus follower registration generation.",
            };
        }
        const followerSocketPath = follower.busSocketPath ??
            getTelegramBusFollowerSocketPath(envelope.recipientInstanceId);
        deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
        try {
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: followerSocketPath,
                envelope,
                timeoutMs: deps.timeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: followerSocketPath,
                    operation: "operation",
                }),
            });
            if (response?.kind === "bus.ack" && response.ok) {
                deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
                return {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: true,
                    ...(response.result !== undefined ? { result: response.result } : {}),
                };
            }
            const message = response?.kind === "bus.ack" ? response.message : undefined;
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: message ?? "Telegram bus follower rejected forwarded update.",
            };
        }
        catch (error) {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: error instanceof Error
                    ? error.message
                    : "Telegram bus follower forwarding failed.",
            };
        }
    };
    return async (envelope) => {
        const trafficClass = getTelegramBusEnvelopeTrafficClass(envelope);
        if (trafficClass === "response") {
            return {
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Telegram bus response envelope cannot be used as a request.",
            };
        }
        if (!isTelegramBusEnvelopeAuthorized(envelope, deps.authSecret)) {
            return createUnauthorizedBusAck(envelope.requestId);
        }
        switch (envelope.kind) {
            case "follower.register":
            case "follower.restoreWorkspace": {
                const compatibility = getTelegramBusProtocolCompatibility({
                    local: deps.protocolIdentity,
                    remote: envelope.registration.protocol,
                });
                const displayCompatible = () => (deps.getThreadDisplayMode?.() ?? "names") === "names" || (hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE) &&
                    hasTelegramBusCapability(envelope.registration.protocol, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE));
                const restoringWorkspace = envelope.kind === "follower.restoreWorkspace";
                const supportsWorkspaceAutoConnect = hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT) &&
                    hasTelegramBusCapability(envelope.registration.protocol, TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT);
                if (!compatibility.compatible || !displayCompatible() ||
                    (envelope.registration.cwd !== undefined &&
                        envelope.registration.sessionId === undefined) ||
                    (restoringWorkspace && !supportsWorkspaceAutoConnect)) {
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: false,
                        protocol: deps.protocolIdentity,
                        error: { code: "incompatible-protocol" },
                        message: `Incompatible Telegram bus protocol: ${compatibility.reason ??
                            (envelope.registration.cwd !== undefined &&
                                envelope.registration.sessionId === undefined
                                ? "missing-session-identity"
                                : "missing-capability")}.`,
                    };
                }
                if (!envelope.registration.registrationGeneration) {
                    return {
                        kind: "bus.ack", requestId: envelope.requestId, ok: false,
                        protocol: deps.protocolIdentity,
                        message: "Telegram follower registration requires an exact generation.",
                    };
                }
                const registrationOperation = () => runFollowerMutation(envelope.registration, async () => {
                    try {
                        const leaderEpoch = deps.getCurrentLeaderEpoch?.();
                        if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
                            throw new Error("Telegram follower registration requires leader ownership.");
                        }
                        const target = await deps.provisionFollowerTarget?.(envelope.registration, { existingWorkspaceBindingOnly: restoringWorkspace });
                        if (restoringWorkspace && !target) {
                            return {
                                kind: "bus.ack",
                                requestId: envelope.requestId,
                                ok: false,
                                protocol: deps.protocolIdentity,
                                error: { code: "workspace-binding-unavailable" },
                                message: "No remembered Telegram Workspace Thread is available.",
                            };
                        }
                        if (deps.getCurrentLeaderEpoch &&
                            deps.getCurrentLeaderEpoch() !== leaderEpoch) {
                            throw new Error("Telegram follower registration lost leader ownership.");
                        }
                        if (!displayCompatible()) {
                            throw new Error("Thread display mode changed; update or restart this follower before connecting.");
                        }
                        const registeredTarget = target ?? envelope.registration.target;
                        const registeredSlot = target?.slot ?? envelope.registration.slot;
                        if (deps.provisionFollowerTarget &&
                            registeredTarget?.threadId !== undefined &&
                            (!registeredSlot || !/^[A-Z]$/u.test(registeredSlot))) {
                            throw new Error("Telegram Thread slot authority is unavailable.");
                        }
                        deps.followerRegistry.register({
                            ...envelope.registration,
                            connectedAtMs: getNowMs(),
                            target: registeredTarget,
                            ...(registeredSlot ? { slot: registeredSlot } : {}),
                            ...((target?.threadName ?? envelope.registration.threadName)
                                ? {
                                    threadName: target?.threadName ?? envelope.registration.threadName,
                                }
                                : {}),
                        });
                        const follower = deps.followerRegistry.get(envelope.registration.instanceId);
                        const displayTitle = follower ? deps.getFollowerDisplayTitle?.(follower) : undefined;
                        deps.onFollowerRegistered?.();
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: true,
                            protocol: deps.protocolIdentity,
                            ...(registeredTarget ? {
                                result: {
                                    ...registeredTarget,
                                    ...(displayTitle !== undefined ? { displayTitle } : {}),
                                },
                            } : {}),
                        };
                    }
                    catch (error) {
                        if (!restoringWorkspace && deps.runWithWorkspaceCapacity &&
                            error instanceof TelegramWorkspaceSlotUnavailableError)
                            throw error;
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            protocol: deps.protocolIdentity,
                            message: error instanceof Error
                                ? error.message
                                : "Telegram bus follower target provisioning failed.",
                        };
                    }
                });
                const register = () => deps.runWorkspaceAdmission ? deps.runWorkspaceAdmission({
                    operationId: `follower-registration:${envelope.requestId}`,
                    operationKind: "workspace.register-follower",
                    scopes: [{ kind: "profile" }],
                }, registrationOperation) : registrationOperation();
                try {
                    return await (!restoringWorkspace && deps.runWithWorkspaceCapacity
                        ? deps.runWithWorkspaceCapacity(register) : register());
                }
                catch (error) {
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: false,
                        protocol: deps.protocolIdentity,
                        message: error instanceof Error
                            ? error.message
                            : "Telegram bus follower registration admission failed.",
                    };
                }
            }
            case "follower.offerQueueHandoff":
                return routeQueueHandoff(envelope);
            case "follower.setThreadDisplayMode": {
                const epoch = deps.getCurrentLeaderEpoch?.();
                const current = () => epoch !== undefined && deps.getCurrentLeaderEpoch?.() === epoch &&
                    deps.followerRegistry.get(envelope.instanceId)?.registrationGeneration === envelope.registrationGeneration;
                const follower = deps.followerRegistry.get(envelope.instanceId);
                const requiredCapability = envelope.mode === "directory-snake" || envelope.mode === "directory-title"
                    ? TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT
                    : TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE;
                if (!current() || !follower?.registrationGeneration || !deps.applyThreadDisplayMode ||
                    !hasTelegramBusCapability(deps.protocolIdentity, requiredCapability) ||
                    !hasTelegramBusCapability(follower.protocol, requiredCapability)) {
                    return { kind: "bus.ack", requestId: envelope.requestId, ok: false,
                        message: "Thread display settings require current registration and compatible leader authority." };
                }
                try {
                    await deps.applyThreadDisplayMode(envelope.mode, current);
                    if (!current())
                        throw new Error("Thread display setting completed for a stale registration.");
                    return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result: { mode: envelope.mode } };
                }
                catch (error) {
                    return { kind: "bus.ack", requestId: envelope.requestId, ok: false,
                        message: error instanceof Error ? error.message : "Thread display setting was not fully applied." };
                }
            }
            case "follower.renameThread": {
                const registeredFollower = deps.followerRegistry.get(envelope.instanceId);
                return runFollowerMutation(registeredFollower ?? { instanceId: envelope.instanceId }, async () => {
                    const follower = deps.followerRegistry.get(envelope.instanceId);
                    if (!follower) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Unknown Telegram bus follower instance.",
                        };
                    }
                    if (!follower.registrationGeneration ||
                        envelope.registrationGeneration !== follower.registrationGeneration ||
                        follower.target?.chatId !== envelope.target.chatId ||
                        follower.target?.threadId !== envelope.target.threadId) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Stale Telegram bus follower registration generation.",
                        };
                    }
                    if (!hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME) ||
                        !hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME) ||
                        !deps.renameFollowerThread) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Telegram Workspace Thread rename is unavailable.",
                        };
                    }
                    try {
                        const result = await deps.renameFollowerThread(follower, envelope.threadName);
                        const current = deps.followerRegistry.get(follower.instanceId);
                        if (current?.registrationGeneration !== follower.registrationGeneration) {
                            return {
                                kind: "bus.ack",
                                requestId: envelope.requestId,
                                ok: false,
                                message: "Stale Telegram bus follower registration generation.",
                            };
                        }
                        deps.followerRegistry.register({
                            ...current,
                            threadName: result.threadName,
                            connectedAtMs: current.connectedAtMs,
                        });
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: true,
                            result,
                        };
                    }
                    catch (error) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: error instanceof Error
                                ? error.message
                                : "Telegram Workspace Thread rename failed.",
                        };
                    }
                });
            }
            case "follower.resetThreadName": {
                const registeredFollower = deps.followerRegistry.get(envelope.instanceId);
                return runFollowerMutation(registeredFollower ?? { instanceId: envelope.instanceId }, async () => {
                    const follower = deps.followerRegistry.get(envelope.instanceId);
                    if (!follower || !follower.registrationGeneration ||
                        envelope.registrationGeneration !== follower.registrationGeneration ||
                        follower.target?.chatId !== envelope.target.chatId ||
                        follower.target?.threadId !== envelope.target.threadId) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Stale or unknown Telegram bus follower registration.",
                        };
                    }
                    if (!hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME) || !hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME) || !deps.resetFollowerThreadName) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Telegram Workspace Thread reset is unavailable.",
                        };
                    }
                    try {
                        const result = await deps.resetFollowerThreadName(follower);
                        const current = deps.followerRegistry.get(follower.instanceId);
                        if (current?.registrationGeneration !==
                            follower.registrationGeneration) {
                            return {
                                kind: "bus.ack",
                                requestId: envelope.requestId,
                                ok: false,
                                message: "Stale Telegram bus follower registration generation.",
                            };
                        }
                        deps.followerRegistry.register({
                            ...current,
                            threadName: result.threadName,
                            connectedAtMs: current.connectedAtMs,
                        });
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: true,
                            result,
                        };
                    }
                    catch (error) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: error instanceof Error
                                ? error.message : "Telegram Workspace Thread reset failed.",
                        };
                    }
                });
            }
            case "follower.publishSessionReplacement":
            case "follower.settleSessionReplacement": {
                const registeredFollower = deps.followerRegistry.get(envelope.instanceId);
                return runFollowerMutation(registeredFollower ?? { instanceId: envelope.instanceId }, async () => {
                    const publish = envelope.kind === "follower.publishSessionReplacement";
                    const operation = publish
                        ? deps.publishFollowerSessionReplacement
                        : deps.settleFollowerSessionReplacement;
                    const epoch = deps.getCurrentLeaderEpoch?.();
                    const follower = deps.followerRegistry.get(envelope.instanceId);
                    const isCurrent = () => epoch !== undefined &&
                        deps.getCurrentLeaderEpoch?.() === epoch &&
                        deps.followerRegistry.get(envelope.instanceId)?.registrationGeneration ===
                            envelope.registrationGeneration;
                    if (!follower?.registrationGeneration ||
                        follower.registrationGeneration !== envelope.registrationGeneration ||
                        !isCurrent() || !operation ||
                        !hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT) ||
                        !hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT)) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Telegram session replacement requires current follower registration and compatible leader authority.",
                        };
                    }
                    try {
                        const committed = await operation(follower, envelope.intent, isCurrent);
                        if (!committed || !isCurrent()) {
                            return {
                                kind: "bus.ack",
                                requestId: envelope.requestId,
                                ok: false,
                                message: publish
                                    ? "Telegram session replacement intent was not persisted."
                                    : "Telegram session replacement intent was not claimed.",
                            };
                        }
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: true,
                            result: { committed: true },
                        };
                    }
                    catch (error) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: error instanceof Error
                                ? error.message
                                : "Telegram session replacement request failed.",
                        };
                    }
                });
            }
            case "follower.disconnect": {
                const registeredFollower = deps.followerRegistry.get(envelope.instanceId);
                return runFollowerMutation(registeredFollower ?? { instanceId: envelope.instanceId }, async () => {
                    const follower = deps.followerRegistry.get(envelope.instanceId);
                    if (!follower) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Unknown Telegram bus follower instance.",
                        };
                    }
                    if (!follower.registrationGeneration ||
                        !envelope.registrationGeneration ||
                        envelope.registrationGeneration !== follower.registrationGeneration) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Stale Telegram bus follower registration generation.",
                        };
                    }
                    await deps.onFollowerDisconnected?.(follower);
                    const current = deps.followerRegistry.get(follower.instanceId);
                    if (current?.registrationGeneration !== follower.registrationGeneration) {
                        return {
                            kind: "bus.ack",
                            requestId: envelope.requestId,
                            ok: false,
                            message: "Stale Telegram bus follower registration generation.",
                        };
                    }
                    deps.followerRegistry.remove(follower.instanceId);
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: true,
                    };
                });
            }
            case "follower.heartbeat": {
                const current = deps.followerRegistry.get(envelope.instanceId);
                if (!current) {
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: false,
                        message: "Unknown Telegram bus follower instance.",
                    };
                }
                if (!current.registrationGeneration ||
                    envelope.registrationGeneration !== current.registrationGeneration) {
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: false,
                        message: "Stale Telegram bus follower registration generation.",
                    };
                }
                const follower = deps.followerRegistry.heartbeat(envelope.instanceId, getNowMs());
                const displayTitle = follower ? deps.getFollowerDisplayTitle?.(follower) : undefined;
                return follower
                    ? {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: true,
                        result: {
                            ...(displayTitle !== undefined ? { displayTitle } : {}),
                            eligibleElectionSlots: deps.followerRegistry
                                .list()
                                .filter((candidate) => !deps.protocolIdentity.capabilities.includes(TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION) ||
                                candidate.protocol?.capabilities.includes(TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION))
                                .map((candidate) => candidate.slot)
                                .filter((slot) => typeof slot === "string" && /^[A-Z]$/.test(slot))
                                .sort(),
                        },
                    }
                    : {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: false,
                        message: "Unknown Telegram bus follower instance.",
                    };
            }
            case "follower.resolveAgentTarget":
            case "follower.routeAgentMessage":
                return handleAgentRequest(envelope);
            case "leader.forwardCallback":
            case "leader.forwardReaction":
            case "leader.forwardMessage":
            case "leader.forwardEditedMessage":
                return forwardToFollower(envelope);
            case "follower.callApi":
                return handleFollowerApiCall(envelope, { ...deps, getNowMs });
            default:
                return {
                    kind: "bus.ack",
                    requestId: envelope.requestId,
                    ok: false,
                    message: "Telegram bus envelope is not handled by this leader.",
                };
        }
    };
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function asInteger(value) {
    if (typeof value === "number" && Number.isInteger(value))
        return value;
    if (typeof value !== "string" || value.trim() === "")
        return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
}
function getFollowerApiMethodAndBody(envelope) {
    if (envelope.method === "call" || envelope.method === "callMultipart") {
        return {
            apiMethod: typeof envelope.args[0] === "string" ? envelope.args[0] : "",
            body: asRecord(envelope.args[1]),
        };
    }
    return { apiMethod: envelope.method, body: asRecord(envelope.args[0]) };
}
function getSentMessageIds(result) {
    const values = Array.isArray(result) ? result : [result];
    return values
        .map((value) => asInteger(asRecord(value)?.message_id))
        .filter((messageId) => messageId !== undefined);
}
function recordFollowerApiMessageOwnership(input) {
    if (!input.record)
        return;
    const { apiMethod, body } = getFollowerApiMethodAndBody(input.envelope);
    if (apiMethod !== "sendMessage" &&
        apiMethod !== "sendRichMessage" &&
        apiMethod !== "sendPhoto" &&
        apiMethod !== "sendDocument" &&
        apiMethod !== "sendVoice" &&
        apiMethod !== "sendMediaGroup") {
        return;
    }
    const chatId = asInteger(body?.chat_id) ?? input.follower.target?.chatId;
    if (chatId === undefined)
        return;
    const threadId = asInteger(body?.message_thread_id) ?? input.follower.target?.threadId;
    const target = threadId !== undefined ? { chatId, threadId } : { chatId };
    for (const messageId of getSentMessageIds(input.result)) {
        input.record({
            follower: input.follower,
            chatId,
            messageId,
            target,
        });
    }
}
async function handleFollowerApiCall(envelope, deps) {
    const follower = deps.followerRegistry.get(envelope.instanceId);
    if (!follower) {
        return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: "Unknown Telegram bus follower instance.",
        };
    }
    if (!follower.registrationGeneration ||
        envelope.registrationGeneration !== follower.registrationGeneration) {
        return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: "Stale Telegram bus follower registration generation.",
        };
    }
    deps.followerRegistry.heartbeat(envelope.instanceId, deps.getNowMs());
    if (deps.authorizeFollowerApiCall &&
        !deps.authorizeFollowerApiCall({
            follower,
            method: envelope.method,
            args: envelope.args,
        })) {
        return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: "Telegram bus API call is not allowed for this follower.",
        };
    }
    if (!deps.callApi) {
        return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: "Telegram bus leader does not expose API calling.",
        };
    }
    try {
        const result = await deps.callApi(envelope.method, envelope.args);
        recordFollowerApiMessageOwnership({
            envelope,
            follower,
            result,
            record: deps.recordFollowerMessageOwnership,
        });
        return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result,
        };
    }
    catch (error) {
        const staleTarget = Threads.isTelegramTopicTargetStaleError(error)
            ? getTelegramApiErrorRequestTarget(error)
            : undefined;
        return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: error instanceof Error
                ? error.message
                : "Telegram bus API call failed.",
            ...(staleTarget
                ? {
                    error: {
                        code: "stale-target",
                        chatId: staleTarget.chatId,
                        threadId: staleTarget.threadId,
                    },
                }
                : isTelegramApiCommitUnknownError(error)
                    ? {
                        error: {
                            code: "commit-unknown",
                            method: error.method,
                        },
                    }
                    : {}),
        };
    }
}
export function createTelegramBusLeaderActivationScheduler(deps) {
    let pending = false;
    return (ctx) => {
        if (deps.isBusPollingStarted() || pending)
            return;
        if (!deps.isBusEnabled())
            return;
        if (!deps.ownsPolling(ctx))
            return;
        pending = true;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    if (deps.isBusPollingStarted())
                        return;
                    if (!deps.isBusEnabled())
                        return;
                    if (!deps.ownsPolling(ctx))
                        return;
                    await deps.stopClassicPolling();
                    try {
                        await deps.startBusLeaderPolling(ctx);
                        deps.setBusPollingStarted(true);
                        deps.updateStatus(ctx);
                        deps.recordRuntimeEvent?.("bus", "Telegram bus leader mode activated", { phase: "leader-hot-switch" });
                    }
                    catch (error) {
                        deps.recordRuntimeEvent?.("bus", error, {
                            phase: "leader-hot-switch",
                        });
                        deps.setBusPollingStarted(false);
                        await deps.startClassicPolling(ctx);
                    }
                }
                finally {
                    pending = false;
                }
            })();
        }, 0);
        timer.unref?.();
    };
}
export function createTelegramBusLeaderRuntime(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const followerPruneIntervalMs = deps.followerPruneIntervalMs ?? 1000;
    const followerStaleAfterMs = deps.followerStaleAfterMs ?? TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS;
    const runFollowerMutation = createTelegramBusFollowerMutationRunner();
    let pruneInterval;
    let pruneGeneration = 0;
    let prunePromise;
    const pendingPreservations = new Map();
    const forgetPreservation = (observation) => {
        if (!observation)
            return;
        if (pendingPreservations.get(observation.follower.instanceId) === observation) {
            pendingPreservations.delete(observation.follower.instanceId);
        }
        observation.registration.release();
    };
    const stopPruning = () => {
        pruneGeneration += 1;
        for (const observation of pendingPreservations.values())
            forgetPreservation(observation);
        if (pruneInterval)
            clearInterval(pruneInterval);
        pruneInterval = undefined;
        prunePromise = undefined;
    };
    const recordPruneEvent = (error, details) => {
        try {
            deps.recordRuntimeEvent?.("bus", error, details);
        }
        catch {
            // Prune diagnostics cannot replace lifecycle-owned reconciliation.
        }
    };
    const pruneFollowers = async (expectedGeneration) => {
        const epoch = deps.getCurrentLeaderEpoch?.();
        const profile = deps.getTelegramProfile?.();
        const isCurrent = () => pruneGeneration === expectedGeneration &&
            deps.getTelegramProfile?.() === profile &&
            (!deps.getCurrentLeaderEpoch || (epoch !== undefined && deps.getCurrentLeaderEpoch() === epoch));
        try {
            await localServer.ensureEndpoint();
        }
        catch (error) {
            recordPruneEvent(error, { phase: "leader-endpoint-recovery" });
        }
        if (pruneGeneration !== expectedGeneration)
            return;
        for (const observation of pendingPreservations.values()) {
            if (!observation.isCurrent())
                forgetPreservation(observation);
        }
        if (!isCurrent())
            return;
        const attempts = [...pendingPreservations.values()].map((observation) => ({
            follower: observation.follower, observation, fresh: false,
        }));
        const removed = deps.followerRegistry.pruneStale(getNowMs(), followerStaleAfterMs);
        for (const follower of removed) {
            forgetPreservation(pendingPreservations.get(follower.instanceId));
            let observation;
            if (deps.onFollowerConfirmedDeadPreserved && epoch !== undefined &&
                follower.registrationGeneration && Number.isSafeInteger(follower.pid) && follower.pid > 0 &&
                Number.isSafeInteger(follower.target?.threadId) && follower.target.threadId > 0) {
                if (pendingPreservations.size < TELEGRAM_WORKSPACE_SLOTS.length) {
                    const registration = deps.followerRegistry.observeUnregistered(follower);
                    let current = true;
                    observation = {
                        follower, registration,
                        // Reuse exact admission authority after a lost acquisition acknowledgement.
                        operationId: createTelegramWorkspaceAdmissionOperationId(),
                        isCurrent() {
                            current = current && isCurrent() && registration.isCurrent();
                            return current;
                        },
                    };
                    pendingPreservations.set(follower.instanceId, observation);
                }
                else {
                    recordPruneEvent("Telegram follower preservation observation capacity exhausted; retaining binding", {
                        phase: "follower-preservation-capacity", instanceId: follower.instanceId,
                    });
                }
            }
            attempts.push({ follower, observation, fresh: true });
        }
        for (const { follower, observation, fresh } of attempts) {
            if (!isCurrent())
                return;
            if (observation && !observation.isCurrent()) {
                forgetPreservation(observation);
                continue;
            }
            let processConfirmedDead = false;
            if (follower.pid !== undefined && Number.isSafeInteger(follower.pid) &&
                follower.pid > 0 && deps.isFollowerProcessAlive) {
                try {
                    processConfirmedDead = deps.isFollowerProcessAlive(follower.pid) === false;
                }
                catch (error) {
                    if (fresh)
                        recordPruneEvent(error, {
                            phase: "follower-process-liveness", instanceId: follower.instanceId, pid: follower.pid,
                        });
                }
            }
            if (!processConfirmedDead) {
                if (fresh)
                    recordPruneEvent("Telegram bus follower heartbeat stale; preserving thread binding", {
                        phase: "follower-pruned", instanceId: follower.instanceId,
                        processLiveness: follower.pid === undefined || !deps.isFollowerProcessAlive ? "unknown" : "alive-or-unknown",
                    });
                continue;
            }
            let cleanupEnabled;
            try {
                cleanupEnabled = await deps.shouldCleanupConfirmedDeadFollower?.();
            }
            catch (error) {
                recordPruneEvent(error, {
                    phase: "follower-confirmed-dead-cleanup-policy", instanceId: follower.instanceId, pid: follower.pid,
                });
            }
            if (!isCurrent()) {
                forgetPreservation(observation);
                return;
            }
            const recordPreserved = () => recordPruneEvent("Telegram bus follower process confirmed dead; preserving thread binding", { phase: "follower-confirmed-dead-preserved", instanceId: follower.instanceId,
                pid: follower.pid, cleanupEnabled });
            // Deferred observations authorize only non-destructive publication, never deletion retries.
            if (cleanupEnabled === true && !fresh) {
                forgetPreservation(observation);
                recordPreserved();
                continue;
            }
            const onConfirmedDead = cleanupEnabled === true ? deps.onFollowerConfirmedDead :
                cleanupEnabled === false && observation ? deps.onFollowerConfirmedDeadPreserved : undefined;
            if (!onConfirmedDead) {
                if (cleanupEnabled === true)
                    forgetPreservation(observation);
                if (fresh)
                    recordPreserved();
                continue;
            }
            const findReplacement = () => deps.followerRegistry.list().find((candidate) => candidate.instanceId === follower.instanceId ||
                (!!follower.profileKey && candidate.profileKey === follower.profileKey) ||
                (!!follower.target && candidate.target?.chatId === follower.target.chatId &&
                    candidate.target?.threadId === follower.target.threadId));
            let settled = false;
            try {
                await runFollowerMutation(follower, async () => {
                    const isDetached = () => isCurrent() && (!observation || observation.isCurrent()) &&
                        !findReplacement() && deps.isFollowerProcessAlive?.(follower.pid) === false;
                    if (!isDetached())
                        return;
                    if (cleanupEnabled === true)
                        await deps.onFollowerConfirmedDead(follower);
                    else
                        settled = await deps.onFollowerConfirmedDeadPreserved(follower, isDetached, observation.operationId);
                });
                if (!cleanupEnabled)
                    recordPreserved();
            }
            catch (error) {
                recordPruneEvent(error, {
                    phase: cleanupEnabled ? "follower-confirmed-dead-cleanup" : "follower-confirmed-dead-preserve",
                    instanceId: follower.instanceId, pid: follower.pid,
                    chatId: follower.target?.chatId, threadId: follower.target?.threadId,
                });
            }
            finally {
                if (settled || cleanupEnabled === true || (observation && !observation.isCurrent())) {
                    forgetPreservation(observation);
                }
            }
        }
    };
    const requestPrune = () => {
        if (prunePromise)
            return prunePromise;
        const expectedGeneration = pruneGeneration;
        let tracked;
        tracked = pruneFollowers(expectedGeneration)
            .catch((error) => {
            if (pruneGeneration === expectedGeneration) {
                recordPruneEvent(error, { phase: "follower-prune-owner" });
            }
        })
            .finally(() => {
            if (prunePromise === tracked)
                prunePromise = undefined;
        });
        prunePromise = tracked;
        return tracked;
    };
    const startPruning = () => {
        stopPruning();
        pruneInterval = setInterval(() => {
            void requestPrune();
        }, followerPruneIntervalMs);
        pruneInterval.unref?.();
    };
    const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
        followerRegistry: deps.followerRegistry,
        authSecret: deps.authSecret,
        protocolIdentity: deps.protocolIdentity,
        getNowMs,
        callApi: deps.callApi,
        authorizeFollowerApiCall: deps.authorizeFollowerApiCall,
        recordFollowerMessageOwnership: deps.recordFollowerMessageOwnership,
        resolveAgentTarget: deps.resolveAgentTarget,
        routeAgentMessage: deps.routeAgentMessage,
        routeQueueHandoff: deps.routeQueueHandoff,
        provisionFollowerTarget: deps.provisionFollowerTarget ? (registration, options) => {
            // Same-instance ownership can change in the store before registry publication.
            forgetPreservation(pendingPreservations.get(registration.instanceId));
            return deps.provisionFollowerTarget(registration, options);
        } : undefined,
        onFollowerDisconnected: deps.onFollowerDisconnected,
        renameFollowerThread: deps.renameFollowerThread,
        resetFollowerThreadName: deps.resetFollowerThreadName,
        publishFollowerSessionReplacement: deps.publishFollowerSessionReplacement,
        settleFollowerSessionReplacement: deps.settleFollowerSessionReplacement,
        getFollowerDisplayTitle: deps.getFollowerDisplayTitle,
        onFollowerRegistered: deps.onFollowerRegistered,
        applyThreadDisplayMode: deps.applyThreadDisplayMode,
        getThreadDisplayMode: deps.getThreadDisplayMode,
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        runFollowerMutation,
        runWorkspaceAdmission: deps.runWorkspaceAdmission,
        runWithWorkspaceCapacity: deps.runWithWorkspaceCapacity,
    });
    const routeQueueHandoffEnvelope = async (input) => {
        const recipient = deps.followerRegistry.get(input.recipientInstanceId);
        if (!hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF) ||
            !hasTelegramBusCapability(recipient?.protocol, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF)) {
            return {
                kind: "bus.ack",
                requestId: input.requestId,
                ok: false,
                message: "Telegram queue handoff capability was not negotiated.",
            };
        }
        if (!recipient?.registrationGeneration ||
            input.recipientRegistrationGeneration !==
                recipient.registrationGeneration) {
            return {
                kind: "bus.ack",
                requestId: input.requestId,
                ok: false,
                message: "Stale Telegram queue handoff recipient registration generation.",
            };
        }
        const recipientSocketPath = recipient.busSocketPath ??
            getTelegramBusFollowerSocketPath(recipient.instanceId);
        const response = await sendTelegramBusLocalEnvelope({
            socketPath: recipientSocketPath,
            timeoutMs: deps.timeoutMs,
            retry: getTelegramBusTransportRetryPolicy({
                endpoint: recipientSocketPath,
                operation: "operation",
            }),
            envelope: {
                kind: "leader.offerQueueHandoff",
                requestId: input.requestId,
                auth: input.auth,
                recipientInstanceId: recipient.instanceId,
                recipientRegistrationGeneration: recipient.registrationGeneration,
                donorInstanceId: input.donorInstanceId,
                donorProcessId: input.donorProcessId,
                donorProcessBirthId: input.donorProcessBirthId,
                donorSessionGeneration: input.donorSessionGeneration,
                donorAcquisitionId: input.donorAcquisitionId,
                donorAcquiredAtMs: input.donorAcquiredAtMs,
                handoffToken: input.handoffToken,
                payload: input.payload,
                sentAtMs: input.sentAtMs,
            },
        });
        if (response?.kind === "bus.ack" && response.ok) {
            deps.followerRegistry.heartbeat(recipient.instanceId, getNowMs());
            return {
                kind: "bus.ack",
                requestId: input.requestId,
                ok: true,
                ...(response.result !== undefined ? { result: response.result } : {}),
            };
        }
        return {
            kind: "bus.ack",
            requestId: input.requestId,
            ok: false,
            message: response?.kind === "bus.ack"
                ? response.message
                : "Telegram queue handoff recipient did not acknowledge staging.",
        };
    };
    const localServer = createTelegramBusLocalServer({
        socketPath: deps.socketPath,
        commitEndpointPublication: deps.commitEndpointPublication,
        recordTransportEvent(phase, details) {
            deps.recordRuntimeEvent?.("bus", `Telegram bus ${phase}`, {
                phase: `leader-${phase}`,
                ...details,
            });
        },
        handleEnvelope,
    });
    return {
        routeQueueHandoff: (envelope) => routeQueueHandoffEnvelope(envelope),
        startPolling: async (ctx) => {
            // Replay durable cleanup before publishing the follower endpoint so a
            // replacement registration cannot reclaim a target while it is deleted.
            await deps.provisionLeaderTarget?.(ctx);
            await localServer.start();
            startPruning();
            try {
                await deps.startPolling(ctx);
            }
            catch (error) {
                stopPruning();
                await localServer.stop();
                throw error;
            }
        },
        stopPolling: async () => {
            stopPruning();
            try {
                await deps.stopPolling();
            }
            finally {
                await localServer
                    .stop()
                    .catch((error) => deps.recordRuntimeEvent?.("bus", error, { phase: "stop" }));
                deps.followerRegistry.clear();
            }
        },
    };
}
