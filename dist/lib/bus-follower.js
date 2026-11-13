/**
 * Telegram bus follower runtime
 * Zones: multi-instance bus, follower lifecycle, manual registration
 * Owns this Pi instance's follower-side bus behavior: manual registration,
 * heartbeat, forwarded-update receiving, and follower-routed API calls.
 * It must not spawn Pi processes or create hidden Telegram-originated instances.
 */
import { createHash } from "node:crypto";
import { getTelegramAttachmentControlId, getTelegramTextInputControlId } from "./delivery.js";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getTelegramBusTransportRetryPolicy, TELEGRAM_BUS_REGISTRATION_RETRY, TelegramBusConnectionReadinessExpiredError, } from "./bus-transport.js";
import { createTelegramBusFollowerDeliveryIdentity, createTelegramBusForeignOwnedUpdateForwarder, createTelegramBusLocalServer, createTelegramBusRequestIdFactory, createUnauthorizedBusAck, rejectTelegramBusRequest, getTelegramBusProtocolCompatibility, getTelegramBusSocketPath, hasTelegramBusCapability, hasTelegramBusSteerQueueHandoffCapability, isTelegramBusEnvelopeAuthorized, isSameTelegramBusFollowerRegistration, parseTelegramBusEnvelope, resolveTelegramBusSocketPath, sendTelegramBusLocalEnvelope, TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE, TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION, TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION, TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY, TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT, parseTelegramBusAttachmentPublicationReceipt, TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE, TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE, TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME, TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES, getTelegramBusHeldCommandCapabilities, TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES, TelegramBusLocalAuthorityError, TelegramBusArtifactIpcError, TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE, } from "./bus.js";
import { parseTelegramUpdateJournalQueueOwner, } from "./journal.js";
import { TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS, } from "./locks.js";
import * as Machine from "./machine.js";
import { TelegramFollowerRegistrationCancelledError, TelegramFollowerReadinessExpiredError } from "./polling.js";
import { isPiStaleContextError } from "./pi.js";
import { parseTelegramTarget as parseTarget, } from "./target.js";
import { isTelegramApiMethodRetrySafe, assertTelegramApiCallAuthority, TelegramApiAuthorityError, TelegramApiCommitUnknownError, TelegramApiFollowerNotAllowedError, TelegramApiStaleTargetError, } from "./telegram-api.js";
import * as Threads from "./threads.js";
import { isWireRecord as isRecord } from "./wire.js";
import { createTelegramWorkspaceAdmissionOperationId, runWithTelegramWorkspaceAdmissionsAsync, } from "./workspace-admission.js";
import * as WorkspaceIdentity from "./workspace-identity.js";
const TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS = 2_500;
const TELEGRAM_FOLLOWER_SESSION_HANDOFF_TTL_MS = 30_000;
const TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS = 30_000;
const TELEGRAM_BUS_FOLLOWER_API_SLOW_CALL_MS = 1_500;
/** One extra liveness probe before a missed heartbeat discards the registration; short so a dead leader still fails over fast. */
const TELEGRAM_BUS_FOLLOWER_REGISTRATION_PROBE_MS = 2_000;
/** A relayed capability older than a few missed heartbeats is stale and the follower probes for itself again. */
const TELEGRAM_BUS_FOLLOWER_RELAYED_CAPABILITY_MAX_AGE_MS = 5_000;
const TELEGRAM_BUS_FOLLOWER_REGISTRATION_WAIT_MS = 30_000;
export const TELEGRAM_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS = TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS;
const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_ATTEMPTS = TELEGRAM_BUS_REGISTRATION_RETRY.attempts;
const TELEGRAM_BUS_FOLLOWER_REGISTRATION_RETRY_DELAY_MS = TELEGRAM_BUS_REGISTRATION_RETRY.delayMs;
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
function isTelegramFollowerSessionHandoffFresh(handoff, options = {}) {
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
            promotedRecord = await Threads.promoteTelegramFollowerBindingToLeader({
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
    const isReadyContext = () => Boolean(readyContext &&
        ports.receiver.getContext() === readyContext.ctx &&
        ports.registrationState.getGeneration() === readyContext.generation &&
        ports.registration.getSessionGeneration?.() ===
            readyContext.sessionGeneration &&
        ports.registration.getSessionId?.(readyContext.ctx) ===
            readyContext.sessionId &&
        ports.registration.isContextActive?.(readyContext.ctx) !== false);
    const prepareContext = async (ctx) => {
        const generation = ports.registrationState.getGeneration();
        const sessionGeneration = ports.registration.getSessionGeneration?.();
        const sessionId = ports.registration.getSessionId?.(ctx);
        const executionContext = ports.receiver.getContext();
        readyContext = undefined;
        if (!generation ||
            executionContext === undefined ||
            ports.registration.isContextActive?.(ctx) === false ||
            ports.registration.isContextActive?.(executionContext) === false ||
            ports.registration.getSessionId?.(executionContext) !== sessionId ||
            (executionContext !== ctx &&
                (sessionId === undefined ||
                    !ports.registration.isContextActive ||
                    !ports.registration.getSessionGeneration)) ||
            (sessionId !== undefined &&
                ports.registrationState.getSessionId(sessionId) !== sessionId))
            throw new Error("Telegram follower session change requires acknowledged leader registration and a current canonical context.");
        // Connect has a command context; inbound work uses the session's canonical object.
        await ports.registration.onRegistered?.(executionContext);
        if (generation &&
            ports.registrationState.getGeneration() === generation &&
            ports.registration.getSessionGeneration?.() === sessionGeneration &&
            ports.receiver.getContext() === executionContext &&
            ports.registration.getSessionId?.(ctx) === sessionId &&
            ports.registration.getSessionId?.(executionContext) === sessionId &&
            ports.registration.isContextActive?.(ctx) !== false &&
            ports.registration.isContextActive?.(executionContext) !== false)
            readyContext = {
                generation,
                ctx: executionContext,
                sessionGeneration,
                sessionId,
            };
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
    });
    let registration;
    const recovery = createTelegramBusFollowerHeartbeatRecoveryHandler({
        ...ports.recovery,
        registrationState: ports.registrationState,
        recordRuntimeEvent: ports.recordRuntimeEvent,
        getRegistrationRuntime: () => baseRegistration,
        // Only a registration this follower still considers live can be kept; a cleared one must re-register.
        async probeRegistration() {
            return ports.registrationState.isRegistered() &&
                (await baseRegistration.probeRegistration?.()) === true;
        },
    });
    registration = createTelegramBusFollowerRegistrationRuntime({
        ...ports.registration,
        failureLog: ports.failureLog,
        ...sharedRuntimeDeps,
        startReceiving: receiver.start,
        stopReceiving: receiver.stop,
        onRegistered: prepareContext,
        onHeartbeatFailure: recovery,
    });
    const baseRegistration = registration;
    registration = {
        ...baseRegistration,
        // Public stop is deliberate (disconnect, suspension); recovery keeps the base stop for promotion.
        stop() {
            recovery.halt();
            baseRegistration.stop();
        },
        registerWithLeader(ctx, leader, options) {
            recovery.resume();
            return baseRegistration.registerWithLeader(ctx, leader, options);
        },
        async setContext(ctx) {
            const sessionGeneration = ports.registration.getSessionGeneration?.();
            if (ports.registration.isContextActive?.(ctx) === false)
                return;
            await baseRegistration.setContext(ctx);
            if (ports.registration.getSessionGeneration?.() !== sessionGeneration ||
                ports.registration.isContextActive?.(ctx) === false)
                return;
            if (!isReadyContext())
                await prepareContext(ctx);
        },
    };
    return {
        receiver,
        registration,
        getReadySessionId: () => isReadyContext() ? readyContext?.sessionId : undefined,
    };
}
/** Binds Restore to real Pi lifetime and the current authenticated transport owner, not request fields. */
export function createTelegramBusFollowerRestoreContextGetter(deps) {
    return (ctx) => {
        if (!deps.isContextCurrent(ctx))
            return undefined;
        const leader = deps.getLeaderState();
        const secret = deps.getAuthenticatedSecret();
        const leaderProtocol = deps.getLeaderProtocol();
        if (!leaderProtocol ||
            !hasTelegramBusCapability(leaderProtocol, deps.capability ?? TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE))
            return undefined;
        if (leader.kind !== "active-elsewhere" ||
            !secret ||
            leader.lock.busSecret !== secret ||
            !leader.lock.instanceId ||
            leader.lock.leaderEpoch === undefined)
            return undefined;
        const profileBindingKey = deps.getProfileBindingKey();
        const operatorUserId = deps.getOperatorUserId();
        const sessionId = deps.getSessionId(ctx);
        const cwd = deps.getCwd(ctx);
        const generation = deps.getGeneration();
        if (!profileBindingKey ||
            !sessionId ||
            !cwd ||
            typeof operatorUserId !== "number" ||
            !Number.isSafeInteger(operatorUserId) ||
            operatorUserId <= 0 ||
            !Number.isSafeInteger(generation) ||
            generation < 0 ||
            !deps.isContextCurrent(ctx))
            return undefined;
        return {
            executor: {
                instanceId: leader.lock.instanceId,
                leaderEpoch: String(leader.lock.leaderEpoch),
            },
            profileBindingKey,
            operatorUserId,
            sessionId,
            cwd,
            generation,
            leaderProtocol: structuredClone(leaderProtocol),
        };
    };
}
/** Shared canonical/local target owner and scoped live-carrier hooks; caller authenticates transport, no canonical writes or cleanup. */
export function createTelegramBusFollowerWorkspaceRestoreHandler(deps) {
    const handler = async (input, ctx) => {
        const scope = input.liveRebind, ports = scope && {
            isCurrent: scope.isCurrent,
            release: scope.release,
            observeWork: scope.observeWork,
        };
        const suppliedTarget = scope?.expectedTarget, expectedTarget = suppliedTarget && { ...suppliedTarget };
        const sourceUpdateIds = scope && [...scope.sourceUpdateIds].sort((a, b) => a - b);
        const liveCurrent = scope && ports.isCurrent.bind(scope), release = scope && ports.release?.bind(scope), workObserver = scope && ports.observeWork?.bind(scope);
        const captured = deps.getContextAuthority(ctx);
        if (!captured)
            throw new Error("Stale Telegram follower Restore context.");
        const snapshotStore = deps.topicTargetStore, liveSnapshot = snapshotStore.withWorkspaceLiveRebindSnapshot, restoreSnapshot = snapshotStore.withWorkspaceRestoreSnapshot;
        const authority = structuredClone(captured);
        const request = structuredClone({
            operationId: input.operationId,
            registrationGeneration: input.registrationGeneration,
            mode: input.mode,
        });
        const readIntent = () => liveCurrent
            ? deps.readLiveRebindIntent?.(request.operationId, authority.profileBindingKey)
            : deps.readRestoreIntent(request.operationId, authority.profileBindingKey);
        let sampleWork;
        if (suppliedTarget !== undefined && !expectedTarget)
            throw new Error("Invalid prepared live-rebind target.");
        if (expectedTarget &&
            (!Number.isSafeInteger(expectedTarget.chatId) ||
                expectedTarget.chatId !== authority.operatorUserId ||
                !Number.isSafeInteger(expectedTarget.threadId) ||
                expectedTarget.threadId <= 0))
            throw new Error("Invalid prepared live-rebind target.");
        if ((release || workObserver) &&
            !hasTelegramBusCapability(authority.leaderProtocol, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE))
            throw new Error("Live-rebind settlement capability is unavailable.");
        if (liveCurrent &&
            !hasTelegramBusCapability(authority.leaderProtocol, TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY))
            throw new Error("Live-rebind apply capability is unavailable.");
        if (!authority.profileBindingKey ||
            !authority.sessionId ||
            !authority.cwd ||
            !authority.executor?.instanceId ||
            !authority.executor.leaderEpoch ||
            !(typeof authority.generation === "string"
                ? authority.generation.length > 0
                : Number.isSafeInteger(authority.generation) &&
                    authority.generation >= 0) ||
            !Number.isSafeInteger(authority.operatorUserId) ||
            authority.operatorUserId <= 0 ||
            !request.operationId ||
            !request.registrationGeneration ||
            !["apply", "inspect"].includes(request.mode))
            throw new Error("Invalid Telegram follower Restore authority.");
        const assertCurrent = () => {
            if (!isDeepStrictEqual(deps.getContextAuthority(ctx), authority) ||
                deps.topicTargetStore !== snapshotStore ||
                (liveCurrent
                    ? snapshotStore.withWorkspaceLiveRebindSnapshot !== liveSnapshot
                    : snapshotStore.withWorkspaceRestoreSnapshot !== restoreSnapshot) ||
                liveCurrent?.() === false ||
                (scope &&
                    (input.liveRebind !== scope ||
                        Object.entries(ports).some(([key, value]) => Reflect.get(scope, key) !== value))) ||
                deps.registrationState.getGeneration() !==
                    request.registrationGeneration)
                throw new Error("Stale Telegram follower Restore authority.");
        };
        assertCurrent();
        if (!deps.getWorkspaceAdmission)
            throw new Error("Telegram Workspace admission authority is unavailable.");
        const result = await runTelegramBusFollowerWorkspaceMutation(deps, "workspace.restore-follower-target", async () => {
            assertCurrent();
            const intent = readIntent();
            assertCurrent();
            if (!intent ||
                intent.request.operationId !== request.operationId ||
                (liveCurrent
                    ? !("kind" in intent) ||
                        intent.kind !== "live-rebind" ||
                        (intent.inputRelease !== undefined && !hasTelegramBusCapability(authority.leaderProtocol, TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION)) ||
                        !isDeepStrictEqual([...intent.request.source.updateIds].sort((a, b) => a - b), sourceUpdateIds) ||
                        (request.mode === "apply"
                            ? intent.phase !== "rebound"
                            : !["rebound", "released", "finished"].includes(intent.phase))
                    : "kind" in intent ||
                        (intent.phase !== "recipient-issued" &&
                            intent.phase !== "ready")) ||
                (expectedTarget &&
                    !isDeepStrictEqual(intent.request.target, expectedTarget)) ||
                !isDeepStrictEqual(intent.executor, authority.executor) ||
                intent.operatorUserId !== authority.operatorUserId ||
                !intent.recipient ||
                ((request.mode === "apply" || liveCurrent) &&
                    (intent.recipient.kind !== "follower" ||
                        intent.recipient.instanceId !== deps.instanceId ||
                        intent.recipient.generation !==
                            request.registrationGeneration)) ||
                intent.recipient.sessionId !== authority.sessionId ||
                intent.request.binding.sessionId !== authority.sessionId ||
                intent.request.binding.cwd !==
                    WorkspaceIdentity.normalizeTelegramWorkspacePath(authority.cwd))
                throw new Error("Telegram follower Restore intent does not match this recipient.");
            const expected = structuredClone(intent);
            await snapshotStore.load();
            assertCurrent();
            const observe = (canonical) => {
                if (!isDeepStrictEqual(readIntent(), expected))
                    throw new Error("Telegram follower Restore intent changed.");
                assertCurrent();
                const { binding, target } = expected.request;
                const bindings = (canonical.workspaceBindings ?? []).filter((value) => value.bindingKey === binding.bindingKey);
                const snapshot = canonical.threads;
                const records = snapshot.filter((value) => value.instanceId === deps.instanceId);
                const owners = snapshot.filter((value) => value.status === "active" &&
                    (value.slot === binding.slot ||
                        isDeepStrictEqual(value.target, target)));
                if (bindings.length !== 1 ||
                    records.length !== 1 ||
                    owners.length !== 1 ||
                    bindings[0]?.cwd !== binding.cwd ||
                    bindings[0]?.sessionId !== binding.sessionId ||
                    bindings[0]?.slot !== binding.slot ||
                    bindings[0]?.inactiveSinceMs !== undefined ||
                    !isDeepStrictEqual(bindings[0]?.target, target) ||
                    records[0]?.status !== "active" ||
                    records[0]?.owner?.kind !== "manual-follower" ||
                    records[0]?.slot !== binding.slot ||
                    !isDeepStrictEqual(records[0]?.target, target) ||
                    deps.registrationState.getSlot() !== binding.slot)
                    throw new Error("Telegram follower Restore canonical binding is not committed.");
                const localTarget = deps.registrationState.getTarget();
                const alreadyReady = isDeepStrictEqual(localTarget, target);
                if (!alreadyReady && !isDeepStrictEqual(localTarget, binding.target))
                    throw new Error("Telegram follower Restore local target changed.");
                assertCurrent();
                if (!alreadyReady && request.mode === "apply") {
                    if (expected.phase !== (liveCurrent ? "rebound" : "recipient-issued"))
                        throw new Error("Telegram follower Restore readiness regressed.");
                    deps.registrationState.setRegistered(true, target, {
                        slot: binding.slot,
                        threadName: records[0]?.threadName,
                        generation: request.registrationGeneration,
                        leaderProtocol: deps.registrationState.getLeaderProtocol(),
                    });
                }
                assertCurrent();
                const observedTarget = deps.registrationState.getTarget();
                if (!observedTarget ||
                    (!isDeepStrictEqual(observedTarget, target) &&
                        !isDeepStrictEqual(observedTarget, binding.target)))
                    throw new Error("Telegram follower Restore local target changed.");
                const ready = isDeepStrictEqual(observedTarget, target);
                assertCurrent();
                return {
                    operationId: request.operationId,
                    recipient: {
                        kind: "follower",
                        instanceId: deps.instanceId,
                        sessionId: authority.sessionId,
                        generation: request.registrationGeneration,
                    },
                    target: {
                        chatId: observedTarget.chatId,
                        threadId: observedTarget.threadId,
                    },
                    slot: binding.slot,
                    ready,
                };
            };
            const withSnapshot = (observer) => {
                assertCurrent();
                if ("kind" in expected) {
                    if (!liveSnapshot)
                        throw new Error("Live-rebind read-only Workspace snapshot is unavailable.");
                    liveSnapshot.call(snapshotStore, expected, observer);
                }
                else
                    restoreSnapshot.call(snapshotStore, expected, observer);
                assertCurrent();
            };
            let result;
            withSnapshot((snapshot) => {
                result = observe(snapshot);
            });
            if (!result)
                throw new Error("Telegram follower Restore observation was not completed.");
            if (release || workObserver) {
                if (!("kind" in expected) ||
                    expected.kind !== "live-rebind" ||
                    (release ? !Threads.isTelegramLiveRebindInputAuthorized(expected)
                        : !(Threads.isTelegramLiveRebindInputAuthorized(expected) || expected.phase === "released" && expected.inputRelease === "held" && !expected.cleanup)) ||
                    !result.ready ||
                    request.mode !== "inspect")
                    throw new Error("Live-rebind dispatch has no canonical released/local-applied grant.");
                // Live barriers reobserve read-only Workspace evidence; journal reads never borrow publication authority.
                if (workObserver)
                    sampleWork = () => {
                        withSnapshot((snapshot) => {
                            if (!observe(snapshot).ready)
                                throw new Error("Live-rebind work observation lost local target application.");
                            workObserver(expected.request.binding.target);
                            assertCurrent();
                        });
                    };
                release?.(() => {
                    assertCurrent();
                    let ready = false;
                    withSnapshot((snapshot) => {
                        ready = observe(snapshot).ready;
                    });
                    assertCurrent();
                    return ready;
                }, { ...expected.request.target });
            }
            return result;
        });
        assertCurrent();
        if (!isDeepStrictEqual(deps.registrationState.getTarget(), result.target) ||
            deps.registrationState.getSlot() !== result.slot)
            throw new Error("Telegram follower Restore local registration changed after admission release.");
        // Work can change while admission releases; sample only after that await under a fresh canonical snapshot.
        sampleWork?.();
        assertCurrent();
        return result;
    };
    return Object.assign(handler, {
        /** Capture availability only; asserting current recipient requires canonical released/local-applied ownership. */
        prepareLiveCommandRecipient(input, ctx) {
            const expected = structuredClone(input), getAuthority = deps.getContextAuthority, read = deps.readLiveRebindIntent, store = deps.topicTargetStore;
            const snapshot = store.withWorkspaceLiveRebindSnapshot, state = deps.registrationState;
            const statePorts = {
                getTarget: state.getTarget,
                getSlot: state.getSlot,
                getGeneration: state.getGeneration,
                getLeaderProtocol: state.getLeaderProtocol,
            };
            const instanceId = deps.instanceId, authority = structuredClone(getAuthority.call(deps, ctx)), oldTarget = structuredClone(state.getTarget()), slot = state.getSlot();
            if (!authority ||
                !read ||
                !snapshot ||
                !instanceId ||
                !slot ||
                !expected.operationId?.trim() ||
                !expected.registrationGeneration?.trim() ||
                expected.sessionId !== authority.sessionId ||
                expected.sourceUpdateIds.length !== 1 ||
                !Number.isSafeInteger(expected.sourceUpdateIds[0]) ||
                expected.sourceUpdateIds[0] < 0 ||
                typeof authority.generation !== "number" ||
                !Number.isSafeInteger(authority.generation) ||
                authority.generation < 0 ||
                !authority.profileBindingKey?.trim() ||
                !authority.cwd?.trim() ||
                !authority.executor?.instanceId?.trim() ||
                !authority.executor.leaderEpoch?.trim() ||
                !Number.isSafeInteger(authority.operatorUserId) ||
                authority.operatorUserId <= 0 ||
                expected.target.chatId !== authority.operatorUserId ||
                !Number.isSafeInteger(expected.target.threadId) ||
                expected.target.threadId <= 0 ||
                !oldTarget ||
                oldTarget.chatId !== expected.target.chatId ||
                !Number.isSafeInteger(oldTarget.threadId) ||
                oldTarget.threadId <= 0)
                return undefined;
            const portsCurrent = () => deps.instanceId === instanceId &&
                deps.getContextAuthority === getAuthority &&
                deps.readLiveRebindIntent === read &&
                deps.topicTargetStore === store &&
                store.withWorkspaceLiveRebindSnapshot === snapshot &&
                deps.registrationState === state &&
                Object.entries(statePorts).every(([key, value]) => Reflect.get(state, key) === value);
            const isCurrent = () => {
                try {
                    if (!portsCurrent() ||
                        !isDeepStrictEqual(getAuthority.call(deps, ctx), authority) ||
                        state.getGeneration() !== expected.registrationGeneration ||
                        state.getSlot() !== slot ||
                        !isDeepStrictEqual(state.getLeaderProtocol(), authority.leaderProtocol) ||
                        ![
                            ...TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES,
                            ...TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES,
                        ].every((cap) => hasTelegramBusCapability(authority.leaderProtocol, cap)) ||
                        ![oldTarget, expected.target].some((target) => isDeepStrictEqual(state.getTarget(), target)))
                        return false;
                    return (portsCurrent() &&
                        isDeepStrictEqual(getAuthority.call(deps, ctx), authority) &&
                        state.getGeneration() === expected.registrationGeneration &&
                        state.getSlot() === slot &&
                        isDeepStrictEqual(state.getLeaderProtocol(), authority.leaderProtocol) &&
                        [oldTarget, expected.target].some((target) => isDeepStrictEqual(state.getTarget(), target)) &&
                        portsCurrent());
                }
                catch {
                    return false;
                }
            };
            if (!isCurrent())
                return undefined;
            return {
                isCurrent,
                assertRecipientCurrent() {
                    if (!isCurrent())
                        throw new Error("Selected command recipient authority changed.");
                    const value = read.call(deps, expected.operationId, authority.profileBindingKey);
                    if (!value ||
                        value.kind !== "live-rebind" ||
                        !Threads.isTelegramLiveRebindInputAuthorized(value) ||
                        value.request.operationId !== expected.operationId ||
                        value.recipient.kind !== "follower" ||
                        value.recipient.instanceId !== instanceId ||
                        value.recipient.sessionId !== expected.sessionId ||
                        value.recipient.generation !== expected.registrationGeneration ||
                        !isDeepStrictEqual(value.executor, authority.executor) ||
                        value.operatorUserId !== authority.operatorUserId ||
                        !isDeepStrictEqual(value.request.source.updateIds, expected.sourceUpdateIds) ||
                        !isDeepStrictEqual(value.request.target, expected.target) ||
                        !isDeepStrictEqual(value.request.binding.target, oldTarget) ||
                        value.request.owner.instanceId !== instanceId ||
                        value.request.owner.owner?.kind !== "manual-follower" ||
                        value.request.owner.slot !== slot ||
                        !isDeepStrictEqual(value.request.owner.target, oldTarget) ||
                        value.request.binding.cwd !==
                            WorkspaceIdentity.normalizeTelegramWorkspacePath(authority.cwd) ||
                        value.request.binding.sessionId !== expected.sessionId ||
                        value.request.binding.slot !== slot ||
                        !isCurrent())
                        throw new Error("Selected command recipient has no exact released intent.");
                    const intent = structuredClone(value);
                    let confirmed = false;
                    snapshot.call(store, intent, (canonical) => {
                        if (!isCurrent() ||
                            !isDeepStrictEqual(read.call(deps, expected.operationId, authority.profileBindingKey), intent))
                            return;
                        const bindings = (canonical.workspaceBindings ?? []).filter((row) => row.bindingKey === intent.request.binding.bindingKey);
                        const owners = canonical.threads.filter((row) => row.status === "active" &&
                            (row.slot === slot ||
                                isDeepStrictEqual(row.target, expected.target)));
                        const row = bindings[0], owner = owners[0];
                        confirmed =
                            bindings.length === 1 &&
                                row?.sessionId === expected.sessionId &&
                                row.cwd === intent.request.binding.cwd &&
                                row.slot === slot &&
                                row.workspaceKey === intent.request.binding.workspaceKey &&
                                row.inactiveSinceMs === undefined &&
                                isDeepStrictEqual(row.target, expected.target) &&
                                owners.length === 1 &&
                                owner?.instanceId === instanceId &&
                                owner.owner?.kind === "manual-follower" &&
                                owner.slot === slot &&
                                owner.profileKey === intent.request.owner.profileKey &&
                                isDeepStrictEqual(owner.owner, intent.request.owner.owner) &&
                                isDeepStrictEqual(owner.target, expected.target) &&
                                isDeepStrictEqual(state.getTarget(), expected.target) &&
                                isCurrent() &&
                                isDeepStrictEqual(read.call(deps, expected.operationId, authority.profileBindingKey), intent);
                    });
                    if (!confirmed || !isCurrent())
                        throw new Error("Selected command canonical/local recipient changed.");
                },
            };
        },
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
    const callApi = createTelegramBusFollowerApiCaller({ ...sharedClientDeps,
        getLocalProtocol: deps.getLocalProtocol, getLeaderProtocol: deps.getLeaderProtocol,
        capturePublicationRegistration: deps.capturePublicationRegistration, instanceId: deps.instanceId,
        getAuthSecret: deps.getApiAuthSecret, getRegistrationGeneration: deps.getRegistrationGeneration, recordRuntimeEvent: deps.recordRuntimeEvent });
    return {
        createRequestId,
        callApi,
        captureApiAuthority: callApi.captureAuthority,
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
    };
}
export function createTelegramBusFollowerQueueHandoffClient(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const timeoutMs = deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
    return async (input) => {
        const registration = await resolveTelegramBusFollowerRegistration(deps, timeoutMs);
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        const response = await sendTelegramBusOperation(socketPath, registration.remainingTimeoutMs, {
            kind: "follower.offerQueueHandoff",
            requestId: deps.createRequestId(),
            auth: deps.getAuthSecret?.(),
            instanceId: deps.instanceId,
            registrationGeneration: registration.generation,
            ...input,
            sentAtMs: getNowMs(),
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
            response.result.sourceUpdateIds.every((updateId, index) => updateId ===
                input.payload.admissionReceipts[0].sourceUpdateIds[index]) &&
            queueOwner) {
            return {
                status: "staged",
                receiptId: response.result.receiptId,
                sourceUpdateIds: response.result.sourceUpdateIds,
                queueOwner,
            };
        }
        throw new Error(response?.kind === "bus.ack"
            ? (response.message ?? "Telegram queue handoff was rejected.")
            : "Telegram queue handoff did not return an acknowledgement.");
    };
}
function createTelegramBusAgentMessageClient(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const timeoutMs = deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
    const request = async (envelope, requestTimeoutMs = timeoutMs) => {
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        const response = await sendTelegramBusOperation(socketPath, requestTimeoutMs, envelope);
        if (response?.kind === "bus.ack" && response.ok)
            return response.result;
        throw new Error(response?.kind === "bus.ack"
            ? (response.message ?? "Telegram bus agent message failed.")
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
/** Private selected text-effect caller; not a guarded ordinary API adapter or follower command admission grant. */
export function createTelegramBusFollowerSelectedMenuCaller(deps) {
    return async (input) => {
        let dispatched = false, method = "sendMessage";
        try {
            const client = { ...deps.client }, recipient = deps.recipient, ctx = input.ctx, assertAuthority = input.assertAuthority;
            const getAuthority = recipient.getContextAuthority, getJournal = recipient.getJournalBindingKey, getProcess = recipient.getProcessIdentity;
            const state = recipient.registrationState, statePorts = {
                getTarget: state.getTarget,
                getSlot: state.getSlot,
                getGeneration: state.getGeneration,
                getLeaderProtocol: state.getLeaderProtocol,
            };
            const authority = structuredClone(getAuthority.call(recipient, ctx));
            const journalBindingKey = getJournal.call(recipient, ctx), process = structuredClone(getProcess.call(recipient)), target = structuredClone(state.getTarget()), slot = state.getSlot();
            const protocol = structuredClone(deps.protocolIdentity), leaderProtocol = structuredClone(state.getLeaderProtocol()), auth = client.getAuthSecret?.();
            const endpoint = resolveTelegramBusSocketPath(client.socketPath), timeoutMs = client.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
            if (!authority ||
                typeof authority.generation !== "number" ||
                typeof assertAuthority !== "function" ||
                !slot ||
                !auth ||
                !Number.isFinite(timeoutMs) ||
                timeoutMs <= 0)
                throw new Error("Selected-menu local owner is unavailable.");
            const decoded = parseTelegramBusEnvelope(JSON.stringify({
                kind: "follower.deliverSelectedMenu",
                requestId: client.createRequestId(),
                auth,
                instanceId: client.instanceId,
                operationId: input.operationId,
                registrationGeneration: input.registrationGeneration,
                recipient: {
                    sessionId: authority.sessionId,
                    sessionGeneration: authority.generation,
                    ...process,
                    profileKey: authority.profileBindingKey,
                    journalBindingKey,
                    target,
                },
                executor: authority.executor,
                operatorUserId: authority.operatorUserId,
                effect: structuredClone(input.effect),
                sentAtMs: (client.getNowMs ?? Date.now)(),
            }));
            if (decoded?.kind !== "follower.deliverSelectedMenu")
                throw new Error("Selected-menu local description is invalid.");
            const expected = decoded;
            method =
                expected.effect.kind === "send-text"
                    ? "sendMessage"
                    : "editMessageText";
            const assertCurrent = (allowPending = false) => {
                assertAuthority();
                const local = getAuthority.call(recipient, ctx), currentGeneration = client.getRegistrationGeneration();
                if (!isDeepStrictEqual(deps.client, client) ||
                    deps.recipient !== recipient ||
                    recipient.getContextAuthority !== getAuthority ||
                    recipient.getJournalBindingKey !== getJournal ||
                    recipient.getProcessIdentity !== getProcess ||
                    recipient.registrationState !== state ||
                    !Object.entries(statePorts).every(([key, value]) => state[key] === value) ||
                    !isDeepStrictEqual(local, authority) ||
                    getJournal.call(recipient, ctx) !== journalBindingKey ||
                    !isDeepStrictEqual(getProcess.call(recipient), process) ||
                    !isDeepStrictEqual(state.getTarget(), target) ||
                    state.getSlot() !== slot ||
                    state.getGeneration() !== expected.registrationGeneration ||
                    (!allowPending &&
                        currentGeneration !== expected.registrationGeneration) ||
                    (currentGeneration !== undefined &&
                        currentGeneration !== expected.registrationGeneration) ||
                    client.getAuthSecret?.() !== auth ||
                    resolveTelegramBusSocketPath(client.socketPath) !== endpoint ||
                    !isDeepStrictEqual(deps.protocolIdentity, protocol) ||
                    !isDeepStrictEqual(state.getLeaderProtocol(), leaderProtocol) ||
                    !getTelegramBusProtocolCompatibility({
                        local: protocol,
                        remote: leaderProtocol,
                    }).compatible ||
                    !hasTelegramBusCapability(protocol, TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY) ||
                    !hasTelegramBusCapability(leaderProtocol, TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY))
                    throw new Error("Selected-menu local authority changed.");
                if (!isDeepStrictEqual(getAuthority.call(recipient, ctx), authority))
                    throw new Error("Selected-menu context changed after local observations.");
                assertAuthority();
            };
            assertCurrent(true);
            const registration = await resolveTelegramBusFollowerRegistration(client, timeoutMs);
            if (registration.generation !== expected.registrationGeneration)
                throw new Error("Selected-menu registration changed.");
            assertCurrent();
            dispatched = true;
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: endpoint,
                envelope: expected,
                timeoutMs: registration.remainingTimeoutMs,
                retry: { attempts: 1, delayMs: 0 },
                assertAuthority: () => assertCurrent(),
            });
            assertCurrent();
            if (response?.kind !== "bus.ack" ||
                response.requestId !== expected.requestId ||
                !response.ok ||
                response.error !== undefined ||
                (response.protocol !== undefined &&
                    !isDeepStrictEqual(response.protocol, leaderProtocol)) ||
                !isRecord(response.result))
                throw new Error("Selected-menu acknowledgement is unconfirmed.");
            const result = response.result;
            if (!isDeepStrictEqual(Object.keys(result).sort(), [
                "effect",
                "messageId",
                "operationId",
                "recipient",
                "registrationGeneration",
            ]) ||
                result.operationId !== expected.operationId ||
                result.registrationGeneration !== expected.registrationGeneration ||
                result.effect !== expected.effect.kind ||
                !isDeepStrictEqual(result.recipient, expected.recipient) ||
                typeof result.messageId !== "number" ||
                !Number.isSafeInteger(result.messageId) ||
                result.messageId <= 0 ||
                (expected.effect.kind === "edit-text" &&
                    result.messageId !== expected.effect.messageId))
                throw new Error("Selected-menu recipient/result is unconfirmed.");
            assertCurrent();
            return {
                operationId: expected.operationId,
                recipient: structuredClone(expected.recipient),
                registrationGeneration: expected.registrationGeneration,
                effect: expected.effect.kind,
                messageId: result.messageId,
            };
        }
        catch (error) {
            if (!dispatched ||
                (error instanceof TelegramBusLocalAuthorityError &&
                    !error.requestIssued))
                throw new TelegramApiAuthorityError(false);
            throw new TelegramApiCommitUnknownError(method, error);
        }
    };
}
export function createTelegramBusFollowerApiCaller(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const timeoutMs = deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CLIENT_TIMEOUT_MS;
    const slowCallMs = deps.slowCallMs ?? TELEGRAM_BUS_FOLLOWER_API_SLOW_CALL_MS;
    const birth = { endpoint: deps.socketPath, instanceId: deps.instanceId, auth: deps.getAuthSecret, generation: deps.getRegistrationGeneration,
        capture: deps.capturePublicationRegistration, local: deps.getLocalProtocol, peer: deps.getLeaderProtocol };
    const captureAuthority = (scope) => {
        const bound = () => deps.socketPath === birth.endpoint && deps.instanceId === birth.instanceId && deps.getAuthSecret === birth.auth &&
            deps.getRegistrationGeneration === birth.generation && deps.capturePublicationRegistration === birth.capture && deps.getLocalProtocol === birth.local && deps.getLeaderProtocol === birth.peer &&
            Object.getOwnPropertyDescriptor(api, "captureAuthority")?.value === captureAuthority;
        try {
            if (!bound() || scope !== undefined && scope !== "registration")
                return undefined;
            const generation = birth.generation(), native = generation ? birth.capture?.() : undefined, check = native?.isCurrent;
            if (!native || typeof check !== "function")
                return undefined;
            const auth = birth.auth?.(), endpoint = resolveTelegramBusSocketPath(birth.endpoint), local = structuredClone(birth.local?.()), peer = structuredClone(birth.peer?.());
            if (!auth || !local || !peer || !hasTelegramBusCapability(local, TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY) ||
                !hasTelegramBusCapability(peer, TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY) || !getTelegramBusProtocolCompatibility({ local, remote: peer }).compatible)
                return undefined;
            const apiIncarnation = scope === "registration" ? native.apiIncarnation : undefined;
            if (scope === "registration" && (!apiIncarnation || !/^[a-f0-9]{48}$/u.test(apiIncarnation) ||
                !hasTelegramBusCapability(local, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY) || !hasTelegramBusCapability(peer, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY)))
                return undefined;
            const assertNative = () => {
                const observed = check.call(native);
                if (observed !== true) {
                    void Promise.resolve(observed).catch(() => { });
                    throw new TelegramApiAuthorityError(false);
                }
            };
            let lost = false, checking = false;
            const assertCurrent = () => {
                if (lost || checking) {
                    lost = true;
                    throw new TelegramApiAuthorityError(false);
                }
                checking = true;
                try {
                    const current = () => bound() && (scope !== "registration" || native.apiIncarnation === apiIncarnation) && birth.generation() === generation && birth.auth?.() === auth && resolveTelegramBusSocketPath(birth.endpoint) === endpoint &&
                        isDeepStrictEqual(birth.local?.(), local) && isDeepStrictEqual(birth.peer?.(), peer) && bound();
                    if (!current() || native.isCurrent !== check)
                        throw new TelegramApiAuthorityError(false);
                    assertNative();
                    if (!current() || native.isCurrent !== check)
                        throw new TelegramApiAuthorityError(false);
                    assertNative();
                    if (!bound())
                        throw new TelegramApiAuthorityError(false);
                }
                catch (error) {
                    lost = true;
                    throw error;
                }
                finally {
                    checking = false;
                }
            };
            assertCurrent();
            return assertCurrent;
        }
        catch {
            return undefined;
        }
    };
    const caller = async (method, args, localOptions, timing) => {
        const ports = { endpoint: deps.socketPath, instanceId: deps.instanceId, auth: deps.getAuthSecret,
            generation: deps.getRegistrationGeneration, wait: deps.waitForRegistrationGeneration, capture: deps.capturePublicationRegistration };
        const assertion = localOptions?.assertAuthority;
        let assertOriginal, wireAuth, wireProtocol, wireApiIncarnation;
        let assertAttachment, attachmentScope;
        const assertCurrent = () => assertTelegramApiCallAuthority(() => { assertion?.(); assertOriginal?.(); assertAttachment?.(); }, false);
        assertCurrent();
        // Match IPC's JSON semantics once, before awaits; send and refusal metadata share this identity.
        const requestArgs = JSON.parse(JSON.stringify(args));
        const apiMethod = (method === "call" || method === "callMultipart") && typeof requestArgs[0] === "string"
            ? requestArgs[0] : method;
        timing.apiMethod = apiMethod;
        const artifact = method === "sendArtifactDocument";
        const attachment = method === "call" && apiMethod === "sendMessage" && getTelegramAttachmentControlId(isRecord(requestArgs[1]) ? requestArgs[1].reply_markup : undefined);
        if (attachment) {
            const readLocal = deps.getLocalProtocol, readLeader = deps.getLeaderProtocol, readGeneration = deps.getRegistrationGeneration, readAuth = deps.getAuthSecret, capture = deps.captureAttachmentPublicationRegistration;
            assertTelegramApiCallAuthority(() => { attachmentScope = capture?.(); }, false);
            const scope = attachmentScope, assertRegistration = scope?.assertCurrent;
            let local, leader, generation, auth;
            const endpoint = resolveTelegramBusSocketPath(deps.socketPath), instanceId = deps.instanceId, body = requestArgs[1];
            assertTelegramApiCallAuthority(() => { local = structuredClone(readLocal?.()); leader = structuredClone(readLeader?.()); generation = readGeneration(); auth = readAuth?.(); }, false);
            let live = true, checking = false;
            const bound = () => live && deps.instanceId === instanceId && deps.getLocalProtocol === readLocal && deps.getLeaderProtocol === readLeader && deps.getRegistrationGeneration === readGeneration &&
                deps.getAuthSecret === readAuth && deps.captureAttachmentPublicationRegistration === capture && scope?.assertCurrent === assertRegistration;
            assertAttachment = () => {
                if (checking) {
                    live = false;
                    throw new Error("Attachment publication peer is unavailable.");
                }
                checking = true;
                try {
                    if (!bound() || !scope || !assertRegistration || requestArgs.length !== 2 || !isRecord(body) || !generation || !auth || !readLocal || !readLeader || !local || !leader)
                        throw new Error("Attachment publication peer is unavailable.");
                    assertRegistration.call(scope);
                    if (!hasTelegramBusCapability(local, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION) ||
                        !hasTelegramBusCapability(leader, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION) || !getTelegramBusProtocolCompatibility({ local, remote: leader }).compatible ||
                        scope.registration.instanceId !== instanceId || scope.registration.registrationGeneration !== generation || scope.leaderSocketPath !== endpoint ||
                        scope.registration.target?.chatId !== body.chat_id || scope.registration.target?.threadId !== body.message_thread_id ||
                        !/^[a-f0-9]{48}$/u.test(scope.registrationIncarnation) || !isDeepStrictEqual(scope.registration.protocol, local) || !isDeepStrictEqual(scope.leaderProtocol, leader) ||
                        deps.instanceId !== instanceId || readGeneration() !== generation || readAuth?.() !== auth || resolveTelegramBusSocketPath(deps.socketPath) !== endpoint ||
                        !isDeepStrictEqual(readLocal(), local) || !isDeepStrictEqual(readLeader(), leader) || !bound())
                        throw new Error("Attachment publication peer is unavailable.");
                    assertRegistration.call(scope);
                    if (!bound())
                        throw new Error("Attachment publication peer is unavailable.");
                }
                catch (error) {
                    live = false;
                    throw error;
                }
                finally {
                    checking = false;
                }
            };
            assertCurrent();
        }
        const fixedGeneration = artifact || attachment ? deps.getRegistrationGeneration() : undefined;
        if ((artifact || attachment) && !fixedGeneration)
            throw new TelegramApiAuthorityError(false);
        const scoped = !!assertion && !artifact && !attachment;
        const bound = () => deps.socketPath === ports.endpoint && deps.instanceId === ports.instanceId && deps.getAuthSecret === ports.auth &&
            deps.getRegistrationGeneration === ports.generation && deps.waitForRegistrationGeneration === ports.wait && deps.capturePublicationRegistration === ports.capture;
        if (scoped && !bound())
            throw new TelegramApiAuthorityError(false);
        const readyGeneration = scoped ? ports.generation() : undefined;
        let native = scoped && readyGeneration ? ports.capture?.() : undefined;
        // An already-ready attempt captures its native lifetime before any await can replace equal fields.
        const registration = artifact || attachment ? { generation: fixedGeneration, remainingTimeoutMs: timeoutMs } : readyGeneration
            ? { generation: readyGeneration, remainingTimeoutMs: timeoutMs }
            : await resolveTelegramBusFollowerRegistration(scoped ? { getRegistrationGeneration: ports.generation, waitForRegistrationGeneration: ports.wait, getNowMs } : deps, timeoutMs);
        if (scoped) {
            if (!bound())
                throw new TelegramApiAuthorityError(false);
            if (!readyGeneration)
                native = ports.capture?.();
            const check = native?.isCurrent;
            if (ports.capture && (!native || typeof check !== "function"))
                throw new TelegramApiAuthorityError(false);
            const auth = ports.auth?.(), endpoint = resolveTelegramBusSocketPath(ports.endpoint);
            let lost = false, checking = false;
            assertOriginal = () => {
                if (lost || checking) {
                    lost = true;
                    throw new Error("Original follower API admission is unavailable.");
                }
                checking = true;
                try {
                    const current = () => bound() && ports.generation() === registration.generation && ports.auth?.() === auth && resolveTelegramBusSocketPath(ports.endpoint) === endpoint && bound();
                    if (!current() || native && native.isCurrent !== check)
                        throw new Error("Original follower API admission is unavailable.");
                    const observed = check?.call(native);
                    if (check && observed !== true) {
                        void Promise.resolve(observed).catch(() => { });
                        throw new Error("Original follower API admission is unavailable.");
                    }
                    if (!current() || native && native.isCurrent !== check)
                        throw new Error("Original follower API admission is unavailable.");
                }
                catch (error) {
                    lost = true;
                    throw error;
                }
                finally {
                    checking = false;
                }
            };
            wireAuth = auth;
            const options = isRecord(requestArgs[2]) ? requestArgs[2] : undefined;
            if (method === "call" && requestArgs.length === 3 && options?.maxAttempts === 1 && options.retrySafety === "non-idempotent" &&
                !getTelegramTextInputControlId(isRecord(requestArgs[1]) ? requestArgs[1].reply_markup : undefined) &&
                hasTelegramBusCapability(deps.getLocalProtocol?.(), TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY) &&
                hasTelegramBusCapability(deps.getLeaderProtocol?.(), TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY)) {
                const authority = captureAuthority(), original = assertOriginal;
                if (!authority)
                    throw new TelegramApiAuthorityError(false);
                assertTelegramApiCallAuthority(() => { wireProtocol = structuredClone(deps.getLeaderProtocol()); }, false);
                const registered = hasTelegramBusCapability(deps.getLocalProtocol?.(), TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY) &&
                    hasTelegramBusCapability(wireProtocol, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY);
                const registrationAuthority = registered ? captureAuthority("registration") : undefined;
                if (registered && !registrationAuthority)
                    throw new TelegramApiAuthorityError(false);
                if (registered)
                    wireApiIncarnation = native?.apiIncarnation;
                assertOriginal = () => { original(); authority(); registrationAuthority?.(); original(); };
                assertTelegramApiCallAuthority(assertOriginal, false);
            }
        }
        timing.registeredAtMs = getNowMs();
        assertCurrent();
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        let response;
        const requestId = deps.createRequestId();
        let ipcIssued = false;
        try {
            response = await sendTelegramBusOperation(socketPath, registration.remainingTimeoutMs, {
                kind: "follower.callApi",
                requestId,
                auth: scoped ? wireAuth : deps.getAuthSecret?.(),
                instanceId: deps.instanceId,
                registrationGeneration: registration.generation,
                ...(wireApiIncarnation ? { apiRegistrationIncarnation: wireApiIncarnation } : {}),
                ...(attachmentScope ? { attachmentRegistrationIncarnation: attachmentScope.registrationIncarnation } : {}),
                method,
                args: requestArgs,
                sentAtMs: getNowMs(),
            }, assertion || attachment ? assertCurrent : undefined, artifact || attachment ? () => { ipcIssued = true; } : undefined);
        }
        catch (error) {
            if (artifact)
                throw new TelegramBusArtifactIpcError(ipcIssued, error);
            if (attachment && (ipcIssued || error instanceof TelegramBusLocalAuthorityError && error.requestIssued))
                throw new TelegramApiCommitUnknownError("sendMessage", error);
            if (error instanceof TelegramBusLocalAuthorityError)
                throw new TelegramApiAuthorityError(error.requestIssued);
            if (!isTelegramApiMethodRetrySafe(apiMethod)) {
                throw new TelegramApiCommitUnknownError(apiMethod, error);
            }
            throw error;
        }
        if (assertOriginal)
            assertTelegramApiCallAuthority(assertCurrent, true);
        if (artifact) {
            const result = response?.kind === "bus.ack" && response.ok && response.requestId === requestId ? response.result : undefined;
            const wire = requestArgs[0];
            if (!isRecord(result) || Object.keys(result).some(key => !["version", "requestId", "registrationIncarnation", "effect", "reason", "messageId", "httpIssued", "telegramRejected"].includes(key)) ||
                result.version !== 1 || result.requestId !== requestId || result.registrationIncarnation !== wire?.registrationIncarnation ||
                typeof result.httpIssued !== "boolean" || typeof result.telegramRejected !== "boolean" ||
                result.effect === "not-issued" && result.httpIssued !== false || result.effect !== "not-issued" && result.httpIssued !== true ||
                result.telegramRejected !== (result.effect === "rejected") || result.effect === "sent" && result.messageId === undefined ||
                !["not-issued", "rejected", "unknown", "sent"].includes(String(result.effect)) ||
                typeof result.reason !== "string" || result.reason.length > 64 ||
                (result.messageId !== undefined && (!Number.isSafeInteger(result.messageId) || result.messageId <= 0)))
                throw new TelegramApiCommitUnknownError(method, new Error("Artifact acknowledgement is unconfirmed."));
            assertTelegramApiCallAuthority(assertion, true);
            return result;
        }
        if (attachment) {
            try {
                assertCurrent();
                if (response?.kind !== "bus.ack" || response.requestId !== requestId)
                    throw new Error("Attachment acknowledgement is unconfirmed.");
                if (response.ok) {
                    const result = response.result, body = requestArgs[1];
                    if (!isRecord(result) || !isRecord(body))
                        throw new Error("Attachment publication result is unavailable.");
                    const receipt = parseTelegramBusAttachmentPublicationReceipt(result[TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT]);
                    if (!receipt || receipt.requestId !== requestId || receipt.nonce !== attachment || receipt.instanceId !== deps.instanceId ||
                        receipt.registrationGeneration !== registration.generation || receipt.registrationIncarnation !== attachmentScope?.registrationIncarnation || receipt.messageId !== result.message_id || receipt.target.chatId !== body.chat_id ||
                        receipt.target.threadId !== body.message_thread_id || !isDeepStrictEqual(response.protocol, deps.getLeaderProtocol?.()))
                        throw new Error("Attachment publication receipt is unconfirmed.");
                    return response.result;
                }
            }
            catch (error) {
                throw new TelegramApiCommitUnknownError("sendMessage", error);
            }
        }
        if (response?.kind !== "bus.ack" || response.requestId !== requestId || wireProtocol && !isDeepStrictEqual(response.protocol, wireProtocol)) {
            const error = new Error("Telegram bus API acknowledgement is unconfirmed.");
            if (!isTelegramApiMethodRetrySafe(apiMethod))
                throw new TelegramApiCommitUnknownError(apiMethod, error);
            throw error;
        }
        if (response.ok)
            return response.result;
        const message = response.message;
        if (response.error?.code === "stale-target" &&
            response.error.chatId !== undefined &&
            response.error.threadId !== undefined) {
            throw new TelegramApiStaleTargetError(message ?? "Telegram thread target is stale.", {
                chatId: response.error.chatId,
                threadId: response.error.threadId,
            });
        }
        if (response.error?.code === "commit-unknown") {
            throw new TelegramApiCommitUnknownError(response.error.method ?? method, new Error(message ?? "Telegram bus API call result is ambiguous."));
        }
        const refusedMethod = response.error?.code === "follower-api-not-allowed" &&
            response.error.method === apiMethod
            ? apiMethod : undefined;
        if (refusedMethod || message === TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE) {
            const body = (method === "call" || method === "callMultipart") && isRecord(requestArgs[1])
                ? requestArgs[1]
                : undefined;
            const chatId = Number(body?.chat_id);
            const threadId = Number(body?.message_thread_id);
            throw new TelegramApiFollowerNotAllowedError(message ?? TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE, Number.isSafeInteger(chatId) && Number.isSafeInteger(threadId)
                ? { chatId, threadId }
                : undefined, refusedMethod);
        }
        throw new Error(message ?? "Telegram bus API call failed.");
    };
    const api = Object.assign(async (method, args, localOptions) => {
        const startedAtMs = getNowMs();
        const timing = {};
        let outcome = "ok";
        try {
            return await caller(method, args, localOptions, timing);
        }
        catch (error) {
            outcome = "error";
            throw error;
        }
        finally {
            const elapsedMs = getNowMs() - startedAtMs;
            if (elapsedMs >= slowCallMs) {
                const apiMethod = timing.apiMethod ?? method;
                try {
                    deps.recordRuntimeEvent?.("bus", `Telegram bus follower API call was slow (${elapsedMs}ms).`, {
                        phase: "follower-api-slow",
                        method: apiMethod,
                        elapsedMs,
                        registrationWaitMs: (timing.registeredAtMs ?? getNowMs()) - startedAtMs,
                        ...(timing.registeredAtMs === undefined
                            ? {}
                            : { transportMs: getNowMs() - timing.registeredAtMs }),
                        outcome,
                    });
                }
                catch {
                    // Diagnostics cannot change the API call outcome.
                }
            }
        }
    }, { captureAuthority });
    return api;
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
export function createTelegramBusFollowerSessionReplacementSuspender(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const getPid = deps.getPid ?? (() => process.pid);
    return async (preserveTarget = true) => {
        if (!preserveTarget) {
            setTelegramFollowerSessionHandoff(undefined);
            Threads.setTelegramLeaderSessionHandoff(undefined);
            await deps.suspendPolling();
            return;
        }
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
            deps.recordRuntimeEvent("bus", error, {
                phase: "follower-session-refresh",
            });
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
    let registrationLifetime = {};
    let registrationIncarnation, apiRegistrationIncarnation;
    let target;
    let slot;
    let threadName;
    let displayTitle;
    let generation;
    let sessionId;
    let leaderProtocol;
    let eligibleElectionSlots = [];
    let relayedThreadCapability;
    let recoveryEpoch = 0;
    let activeRecoveryEpoch;
    const generationWaiters = new Set();
    const settleGenerationWaiters = (value, epoch) => {
        for (const waiter of [...generationWaiters]) {
            if (epoch === undefined || waiter.epoch === epoch)
                waiter.settle(value);
        }
    };
    const capturePublicationRegistration = () => {
        if (!registered || !generation)
            return undefined;
        const lifetime = registrationLifetime, incarnation = registrationIncarnation, apiIncarnation = apiRegistrationIncarnation;
        let lost = false;
        return { incarnation, apiIncarnation, isCurrent() { lost ||= !registered || registrationLifetime !== lifetime || registrationIncarnation !== incarnation || apiRegistrationIncarnation !== apiIncarnation; return !lost; } };
    };
    return {
        isRegistered: () => registered,
        capturePublicationRegistration,
        captureArtifactRegistration() {
            const registration = capturePublicationRegistration();
            return registration?.incarnation ? { incarnation: registration.incarnation, isCurrent: registration.isCurrent } : undefined;
        },
        getTarget: () => (target ? { ...target } : undefined),
        getSlot: () => slot,
        getThreadName: () => threadName,
        getDisplayTitle: () => displayTitle,
        setDisplayTitle(title, expectedGeneration) {
            if (!registered ||
                !generation ||
                expectedGeneration !== generation ||
                !title.trim() ||
                title.length > 128 ||
                displayTitle === title)
                return false;
            displayTitle = title;
            return true;
        },
        getGeneration: () => generation,
        getSessionId: (currentSessionId) => registered && generation && currentSessionId === sessionId
            ? sessionId
            : undefined,
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
        setRelayedThreadCapability: (enabled, relayGeneration) => {
            relayedThreadCapability =
                enabled === undefined || !registered || generation !== relayGeneration
                    ? undefined
                    : { enabled, generation: relayGeneration, atMs: Date.now() };
        },
        getRelayedThreadCapability: () => {
            const relayed = relayedThreadCapability;
            return registered &&
                relayed &&
                relayed.generation === generation &&
                Date.now() - relayed.atMs <= TELEGRAM_BUS_FOLLOWER_RELAYED_CAPABILITY_MAX_AGE_MS
                ? relayed.enabled
                : undefined;
        },
        setRegistered: (next, nextTarget, metadata) => {
            relayedThreadCapability = undefined;
            registrationLifetime = {};
            registrationIncarnation = next && typeof metadata?.registrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(metadata.registrationIncarnation)
                ? metadata.registrationIncarnation : undefined;
            apiRegistrationIncarnation = next && typeof metadata?.apiRegistrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(metadata.apiRegistrationIncarnation)
                ? metadata.apiRegistrationIncarnation : undefined;
            const retainedDisplayTitle = next &&
                registered &&
                generation === metadata?.generation &&
                target?.chatId === nextTarget?.chatId &&
                target?.threadId === nextTarget?.threadId
                ? displayTitle
                : undefined;
            const retainedSessionId = next && registered && generation === metadata?.generation
                ? sessionId
                : undefined;
            const availabilityChanged = registered !== next;
            registered = next;
            target = next ? (nextTarget ? { ...nextTarget } : undefined) : undefined;
            slot = next ? metadata?.slot : undefined;
            threadName = next ? metadata?.threadName : undefined;
            displayTitle =
                next &&
                    nextTarget &&
                    metadata?.generation &&
                    metadata.displayTitle?.trim() &&
                    metadata.displayTitle.length <= 128
                    ? metadata.displayTitle
                    : retainedDisplayTitle;
            generation = next ? metadata?.generation : undefined;
            sessionId = next ? (metadata?.sessionId ?? retainedSessionId) : undefined;
            leaderProtocol =
                next && metadata?.leaderProtocol
                    ? {
                        ...metadata.leaderProtocol,
                        capabilities: [...metadata.leaderProtocol.capabilities],
                    }
                    : undefined;
            // Retain this exact mutation before callouts: reentry with equal data must not return a renewed scope.
            const lifetime = registrationLifetime;
            let lost = false;
            const retained = next && generation ? Object.freeze({ isCurrent() { lost ||= !registered || registrationLifetime !== lifetime; return !lost; } }) : undefined;
            if (availabilityChanged)
                options.onAvailabilityChanged?.();
            if (generation) {
                activeRecoveryEpoch = undefined;
                settleGenerationWaiters(generation);
            }
            options.onRegistrationChanged?.();
            return retained;
        },
    };
}
export function createTelegramBusFollowerRecoveryState() {
    return {
        epoch: 0,
        halted: false,
        recovering: false,
        retryId: null,
        nextRetryId: 0,
    };
}
/**
 * Pure follower-recovery lifecycle. An operator stop halts it and a connect resumes it, each in a new epoch: work
 * from the old epoch, a recovery still awaiting or a retry still armed, can no longer register or promote.
 */
export function transitionTelegramBusFollowerRecovery(state, event) {
    const cancelRetry = state.retryId === null
        ? []
        : [{ type: "cancelRetry", retryId: state.retryId }];
    const start = (from) => from.halted || from.recovering
        ? { state: from, effects: [] }
        : {
            state: { ...from, recovering: true },
            effects: [{ type: "runRecovery", epoch: from.epoch }],
        };
    switch (event.type) {
        case "recoverRequested":
            return start(state);
        case "recoverySettled":
            return event.epoch === state.epoch
                ? { state: { ...state, recovering: false }, effects: [] }
                : { state, effects: [] };
        case "retryRequested": {
            if (event.epoch !== state.epoch || state.halted)
                return { state, effects: [] };
            const retryId = state.nextRetryId + 1;
            return {
                state: { ...state, retryId, nextRetryId: retryId },
                effects: [...cancelRetry, { type: "armRetry", retryId }],
            };
        }
        case "retryFired":
            if (state.retryId !== event.retryId)
                return { state, effects: [] };
            return start({ ...state, retryId: null });
        case "halted":
        case "resumed":
            return {
                state: {
                    ...state,
                    epoch: state.epoch + 1,
                    halted: event.type === "halted",
                    recovering: false,
                    retryId: null,
                },
                effects: cancelRetry,
            };
    }
}
export function createTelegramBusFollowerHeartbeatRecoveryHandler(deps) {
    // Promotion stops registration internally and must keep retrying; only an operator stop or a confirmed
    // switch to classic mode halts recovery, so it never re-registers behind a disconnect.
    const promotionGraceMs = deps.promotionGraceMs ?? TELEGRAM_BUS_FOLLOWER_PROMOTION_GRACE_MS;
    const sleep = deps.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // A cancelled retry still fires through an injected scheduler; its id no longer matches and it does nothing.
    const scheduleRetry = deps.scheduleRetry ??
        ((retry, delayMs) => {
            const timer = setTimeout(retry, delayMs);
            timer.unref?.();
        });
    const retryRequests = new Map();
    let pendingRetry;
    let request;
    let running = Promise.resolve();
    const machine = Machine.createTelegramMachineRunner({
        initial: createTelegramBusFollowerRecoveryState(),
        transition: transitionTelegramBusFollowerRecovery,
        run(effect) {
            switch (effect.type) {
                case "runRecovery": {
                    const started = request;
                    running = runRecovery(started, effect.epoch).finally(() => machine.dispatch({ type: "recoverySettled", epoch: effect.epoch }));
                    return;
                }
                case "armRetry": {
                    const retryId = effect.retryId;
                    retryRequests.set(retryId, pendingRetry);
                    const fire = () => {
                        const carried = retryRequests.get(retryId);
                        if (!carried || machine.state.retryId !== retryId)
                            return;
                        const activeCtx = deps.getActiveContext
                            ? deps.getActiveContext()
                            : carried.ctx;
                        if (!activeCtx) {
                            scheduleRetry(fire, promotionGraceMs);
                            return;
                        }
                        retryRequests.delete(retryId);
                        void requestRecovery({ ...carried, ctx: activeCtx }, {
                            type: "retryFired",
                            retryId,
                        });
                    };
                    scheduleRetry(fire, promotionGraceMs);
                    return;
                }
                case "cancelRetry":
                    retryRequests.delete(effect.retryId);
                    return;
            }
        },
    });
    const requestRecovery = (next, event) => {
        const before = running;
        request = next;
        try {
            machine.dispatch(event);
        }
        finally {
            request = undefined;
        }
        return running === before ? Promise.resolve() : running;
    };
    const runRecovery = async ({ reason: error, ctx, binding: carriedBinding }, epoch) => {
        const isCurrent = () => machine.state.epoch === epoch && !machine.state.halted;
        const scheduleRecovery = (reason, fallbackCtx, binding) => {
            pendingRetry = { reason, ctx: fallbackCtx, binding };
            try {
                machine.dispatch({ type: "retryRequested", epoch });
            }
            finally {
                pendingRetry = undefined;
            }
        };
        const safeUpdateStatus = (ctx) => {
            try {
                deps.updateStatus(ctx);
            }
            catch (error) {
                if (!isPiStaleContextError(error))
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
            if (!isCurrent())
                return false;
            try {
                const restored = await deps
                    .getRegistrationRuntime()
                    .registerWithLeader(ctx, leader, binding?.target ? { target: binding.target } : undefined);
                // Registration owns its attempt cleanup; an obsolete recovery cannot stop the shared replacement runtime.
                if (!restored || !isCurrent())
                    return false;
                deps.setLifecyclePhase(undefined);
                safeUpdateStatus(ctx);
                deps.recordRuntimeEvent("bus", "Telegram follower registration restored", {
                    phase,
                });
                return true;
            }
            catch (error) {
                if (!isCurrent())
                    return false;
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
        const promoteToLeader = async (reason, ctx, binding, election) => {
            if (!isCurrent())
                return;
            if (deps.getActiveContext) {
                // Pi hands every event and command a fresh context object, so a manually connected follower never holds
                // the stored session object. Promote through the live session context instead of rescheduling: heartbeat
                // failures re-request recovery faster than the retry grace, so a reschedule-only path never fires.
                const activeCtx = deps.getActiveContext();
                if (!activeCtx) {
                    scheduleRecovery(reason, ctx, binding);
                    return;
                }
                ctx = activeCtx;
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
            if (!isCurrent())
                return;
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
                if (!isCurrent())
                    return;
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
        // A leader that stalled past the heartbeat timeout but still holds this registration needs no new generation;
        // re-registering would invalidate every forward already in flight to the old one.
        if ((await deps.probeRegistration?.()) === true) {
            if (isCurrent())
                deps.recordRuntimeEvent("bus", "Telegram follower kept its registration: the leader answered after a missed heartbeat.", { phase: "follower-heartbeat-registration-kept" });
            return;
        }
        if (!isCurrent())
            return;
        deps.registrationState.beginRecovery();
        const initialBinding = carriedBinding ?? snapshotBinding();
        try {
            let threadModeDisabled = false;
            try {
                threadModeDisabled = (await deps.isThreadModeDisabled?.()) === true;
            }
            catch (stateError) {
                deps.recordRuntimeEvent("bus", stateError, {
                    phase: "follower-thread-mode-read",
                });
            }
            if (!isCurrent())
                return;
            if (threadModeDisabled) {
                machine.dispatch({ type: "halted" });
                deps.getRegistrationRuntime().stop();
                deps.setLifecyclePhase(undefined);
                safeUpdateStatus(ctx);
                deps.recordRuntimeEvent("bus", "Telegram follower went offline: Threaded Mode is off. Run /telegram-connect after turning it back on.", { phase: "follower-thread-mode-disabled" });
                return;
            }
            const state = deps.getLeaderState();
            if (state.kind === "active-elsewhere") {
                clearRegisteredState(ctx);
                if (await tryRegisterWithLeader(ctx, state.lock, "follower-register-restore", initialBinding)) {
                    return;
                }
                if (!isCurrent())
                    return;
                deps.setLifecyclePhase("electing");
                safeUpdateStatus(ctx);
                deps.recordRuntimeEvent("bus", "Telegram follower waiting for leader reload recovery", { phase: "follower-promotion-grace" });
                await sleep(promotionGraceMs);
                if (!isCurrent())
                    return;
                const graceState = deps.getLeaderState();
                if (graceState.kind === "active-elsewhere") {
                    if (await tryRegisterWithLeader(ctx, graceState.lock, "follower-register-restore-grace", initialBinding)) {
                        return;
                    }
                    const unresponsive = await deps.proveLeaderUnresponsive?.(graceState.lock);
                    if (!isCurrent())
                        return;
                    if (unresponsive) {
                        await promoteToLeader(error, ctx, initialBinding, {
                            expectedOwner: graceState.lock,
                            unresponsive: true,
                        });
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
            if (!isCurrent())
                return;
            deps.setLifecyclePhase(undefined);
            safeUpdateStatus(ctx);
            if (isPiStaleContextError(promotionError)) {
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
    };
    return Object.assign((error, ctx) => requestRecovery({ reason: error, ctx }, { type: "recoverRequested" }), {
        halt() {
            machine.dispatch({ type: "halted" });
        },
        resume() {
            machine.dispatch({ type: "resumed" });
        },
    });
}
export function createTelegramBusFollowerRegistrationRuntime(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const pidProvider = deps.getPid, getPid = pidProvider ?? (() => process.pid);
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
    let attachmentRegistration;
    let lastKnownTarget;
    let lastKnownSlot;
    let lastKnownThreadName;
    // A leader result is accepted only for the same endpoint and registration generation that issued the request.
    const isLeaderSessionCurrent = (socketPath, generation) => activeLeaderSocketPath === socketPath &&
        activeRegistrationGeneration === generation &&
        (!deps.registrationState ||
            deps.registrationState.getGeneration() === generation);
    const stopHeartbeat = () => {
        // A stopped heartbeat ends the current failure run, so a later run logs its own first failure.
        heartbeatFailureLog.reset();
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
    /** A sustained leader outage repeats one identical failure every interval; the port collapses the run. */
    const heartbeatFailureLog = deps.failureLog ?? {
        record(error) {
            try {
                deps.recordRuntimeEvent?.("bus", error, {
                    phase: "follower-heartbeat",
                });
            }
            catch {
                // Diagnostics cannot replace heartbeat recovery.
            }
            return true;
        },
        settled: () => undefined,
        reset: () => undefined,
    };
    const sendHeartbeat = async () => {
        const leaderSocketPath = activeLeaderSocketPath;
        const registrationGeneration = activeRegistrationGeneration;
        const heartbeatContext = activeContext;
        const heartbeatTarget = deps.registrationState?.getTarget();
        if (!leaderSocketPath || !registrationGeneration)
            return;
        const isCurrentHeartbeat = () => activeLeaderSocketPath === leaderSocketPath &&
            activeRegistrationGeneration === registrationGeneration &&
            activeContext === heartbeatContext;
        try {
            const response = await sendTelegramBusOperation(leaderSocketPath, heartbeatTimeoutMs, {
                kind: "follower.heartbeat",
                requestId: deps.createRequestId(),
                auth: activeAuthSecret,
                instanceId: deps.instanceId,
                registrationGeneration,
                sentAtMs: getNowMs(),
            });
            if (!isCurrentHeartbeat())
                return;
            if (response?.kind === "bus.ack" && response.ok) {
                heartbeatFailureLog.settled();
                const heartbeatResult = isRecord(response.result)
                    ? response.result
                    : undefined;
                const slots = Array.isArray(heartbeatResult?.eligibleElectionSlots)
                    ? heartbeatResult.eligibleElectionSlots.filter((slot) => typeof slot === "string")
                    : [];
                deps.registrationState?.setEligibleElectionSlots(slots);
                deps.registrationState?.setRelayedThreadCapability(typeof heartbeatResult?.threadCapability === "boolean"
                    ? heartbeatResult.threadCapability
                    : undefined, registrationGeneration);
                if (typeof heartbeatResult?.displayTitle === "string" &&
                    isDeepStrictEqual(deps.registrationState?.getTarget(), heartbeatTarget) &&
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
            heartbeatFailureLog.record(error);
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
    const probeRegistration = async () => {
        const leaderSocketPath = activeLeaderSocketPath;
        const registrationGeneration = activeRegistrationGeneration;
        const probeContext = activeContext;
        if (!leaderSocketPath || !registrationGeneration)
            return false;
        try {
            const response = await sendTelegramBusOperation(leaderSocketPath, TELEGRAM_BUS_FOLLOWER_REGISTRATION_PROBE_MS, {
                kind: "follower.heartbeat",
                requestId: deps.createRequestId(),
                auth: activeAuthSecret,
                instanceId: deps.instanceId,
                registrationGeneration,
                sentAtMs: getNowMs(),
            });
            if (activeLeaderSocketPath !== leaderSocketPath ||
                activeRegistrationGeneration !== registrationGeneration ||
                activeContext !== probeContext ||
                response?.kind !== "bus.ack" ||
                !response.ok)
                return false;
            heartbeatFailureLog.settled();
            return true;
        }
        catch {
            return false;
        }
    };
    return {
        probeRegistration,
        captureAttachmentPublicationRegistration() {
            try {
                attachmentRegistration?.assertCurrent();
                return attachmentRegistration;
            }
            catch {
                return undefined;
            }
        },
        registerWithLeader: async (ctx, leader, options) => {
            const assertCaller = options?.assertAuthority, connectionSource = options?.connectionReadiness, startReceiving = deps.startReceiving;
            const remainingMs = connectionSource?.remainingMs, wait = connectionSource?.wait;
            const connectionReadiness = connectionSource ? { remainingMs: () => remainingMs.call(connectionSource), wait: () => wait.call(connectionSource) } : undefined;
            let connectionIssued = false;
            let callerLost = false, checkingCaller = false;
            const isCallerCurrent = () => {
                if (callerLost || checkingCaller) {
                    callerLost = true;
                    return false;
                }
                checkingCaller = true;
                try {
                    assertCaller?.();
                    if (!connectionIssued && connectionSource && (connectionSource.remainingMs !== remainingMs || connectionSource.wait !== wait))
                        callerLost = true;
                }
                catch {
                    callerLost = true;
                }
                finally {
                    checkingCaller = false;
                }
                return !callerLost;
            };
            if (!isCallerCurrent())
                return false;
            attachmentRegistration = undefined;
            const readers = { state: deps.registrationState, profile: deps.getProfileKey, session: deps.getSessionId, generation: deps.getSessionGeneration,
                birth: deps.getProcessBirthId, pid: pidProvider, endpoint: deps.getFollowerBusSocketPath, leaderEndpoint: deps.getLeaderSocketPath,
                auth: deps.getLeaderAuthSecret, active: deps.isContextActive, protocol: deps.protocolIdentity,
                target: deps.registrationState?.getTarget, slot: deps.registrationState?.getSlot, ackSession: deps.registrationState?.getSessionId,
                ackGeneration: deps.registrationState?.getGeneration, peer: deps.registrationState?.getLeaderProtocol, set: deps.registrationState?.setRegistered };
            if (deps.isContextActive?.(ctx) === false)
                return false;
            const sessionGeneration = deps.getSessionGeneration?.();
            const sessionId = deps.getSessionId?.(ctx);
            const attempt = { ctx, sessionGeneration, sessionId };
            registrationAttempt = attempt;
            const isCurrentRequest = () => registrationAttempt === attempt &&
                deps.getSessionGeneration?.() === sessionGeneration &&
                deps.getSessionId?.(ctx) === sessionId &&
                deps.isContextActive?.(ctx) !== false && isCallerCurrent();
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
            // Failed registration releases its leader session but keeps the attempt owner for caller-visible errors.
            const failRegistration = async (clearGeneration = false) => {
                stopHeartbeat();
                activeLeaderSocketPath = undefined;
                activeAuthSecret = undefined;
                if (clearGeneration)
                    activeRegistrationGeneration = undefined;
                deps.registrationState?.setRegistered(false);
                deps.setActiveAuthSecret?.(undefined);
                await deps.stopReceiving?.();
            };
            const expireRegistration = async () => {
                try {
                    await failRegistration();
                }
                catch (cleanupError) {
                    try {
                        deps.recordRuntimeEvent?.("bus", cleanupError, { phase: "follower-register-readiness-cleanup" });
                    }
                    catch { /* Keep protective expiry even if diagnostics fail. */ }
                }
                throw new TelegramFollowerReadinessExpiredError();
            };
            // A fresh handoff belongs to this same process, so a replaced session reuses its Thread: the tab keeps
            // one identity and only its owner rotates. Explicit options still override the preserved target.
            const pendingHandoff = getTelegramFollowerSessionHandoff();
            const pendingHandoffOptions = isTelegramFollowerSessionHandoffFresh(pendingHandoff)
                ? {
                    target: pendingHandoff.target,
                    previousInstanceId: pendingHandoff.instanceId,
                }
                : undefined;
            const registrationOptions = options ? { ...pendingHandoffOptions, ...options } : pendingHandoffOptions;
            const leaderSocketPath = leader.busSocketPath ??
                deps.getLeaderSocketPath?.() ??
                getTelegramBusSocketPath();
            const attachmentLeaderSocketPath = resolveTelegramBusSocketPath(leaderSocketPath);
            const assertReceiving = () => {
                if (deps.startReceiving !== startReceiving)
                    callerLost = true;
                if (!isCurrentRequest())
                    throw new TelegramFollowerRegistrationCancelledError();
                if (connectionReadiness) {
                    const remaining = connectionReadiness.remainingMs();
                    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647)
                        throw new TelegramFollowerReadinessExpiredError();
                }
                if (!isCurrentRequest())
                    throw new TelegramFollowerRegistrationCancelledError();
            };
            if (!isCurrentRequest()) {
                await abandonOwnedRequest();
                return false;
            }
            try {
                assertReceiving();
                await startReceiving?.call(deps, assertReceiving);
                assertReceiving();
            }
            catch (error) {
                if (!isCurrentRequest()) {
                    await abandonOwnedRequest();
                    return false;
                }
                if (error instanceof TelegramFollowerReadinessExpiredError)
                    return await expireRegistration();
                await failRegistration();
                throw error;
            }
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
                ...(registrationOptions?.recoverConnection && !registrationOptions.restoreWorkspace
                    ? { recoverConnection: true } : {}),
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
                    sessionId,
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
            const issued = structuredClone(registrationEnvelope.registration);
            const localProtocol = structuredClone(issued.protocol), leaderEndpoint = leader.busSocketPath, leaderSecret = leader.busSecret;
            let response;
            try {
                response = await sendTelegramBusLocalEnvelope({
                    socketPath: leaderSocketPath,
                    timeoutMs: registrationTimeoutMs,
                    envelope: registrationEnvelope,
                    ...(connectionReadiness ? { connectionReadiness, onRequestIssued() { connectionIssued = true; } } : {}),
                    assertAuthority() {
                        if (!isCurrentRequest())
                            throw new Error("Telegram follower registration authority changed.");
                    },
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
                if (error instanceof TelegramBusConnectionReadinessExpiredError)
                    return await expireRegistration();
                await failRegistration();
                throw error;
            }
            if (!isCurrentRequest()) {
                await abandonOwnedRequest();
                return false;
            }
            // Correlate the original bootstrap before protocol/error interpretation or publishing readiness.
            if (response?.kind !== "bus.ack" || response.requestId !== registrationGeneration) {
                await failRegistration();
                throw new Error("Telegram follower registration acknowledgement is unconfirmed.");
            }
            const compatibility = getTelegramBusProtocolCompatibility({
                local: deps.protocolIdentity,
                remote: response.protocol,
            });
            // An identity-less error ACK is a rejection/transport failure, not evidence of an incompatible leader.
            const unidentifiedRejection = response?.kind === "bus.ack" &&
                !response.ok &&
                response.protocol === undefined;
            if (!compatibility.compatible && !unidentifiedRejection) {
                await failRegistration();
                throw new Error(`Incompatible Telegram bus leader protocol: ${compatibility.reason}.`);
            }
            if (response?.kind === "bus.ack" && !response.ok) {
                await failRegistration();
                if (registrationOptions?.restoreWorkspace &&
                    response.error?.code === "workspace-binding-unavailable") {
                    deps.recordRuntimeEvent?.("bus", "Telegram follower auto-connect refused by leader: Workspace binding unavailable.", {
                        phase: "follower-auto-connect-skip",
                        reason: "leader-binding-unavailable",
                    });
                    return false;
                }
                try {
                    deps.recordRuntimeEvent?.("bus", response.message ?? "Telegram leader rejected follower registration.", {
                        phase: "follower-register-rejected", source: "leader", reason: response.error?.code ?? "leader-rejected",
                    });
                }
                catch { /* Diagnostics cannot replace the original correlated leader rejection. */ }
                throw new Error(response.message ??
                    "Telegram bus follower registration was rejected.");
            }
            if (response?.kind === "bus.ack" && response.ok) {
                const registrationResult = parseRegistrationResult(response.result);
                if (!isCurrentRequest()) {
                    await abandonOwnedRequest();
                    return false;
                }
                const lifetime = deps.registrationState?.setRegistered(true, registrationResult.target, {
                    ...registrationResult,
                    apiRegistrationIncarnation: hasTelegramBusCapability(localProtocol, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY) &&
                        hasTelegramBusCapability(response.protocol, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY) ? registrationResult.apiRegistrationIncarnation : undefined,
                    generation: registrationGeneration,
                    sessionId,
                    ...(response.protocol ? { leaderProtocol: response.protocol } : {}),
                });
                lastKnownTarget = registrationResult.target;
                lastKnownSlot = registrationResult.slot;
                lastKnownThreadName = registrationResult.threadName;
                activeLeaderSocketPath = leaderSocketPath;
                activeRegistrationGeneration = registrationGeneration;
                activeContext = ctx;
                const recipient = structuredClone({ ...issued, target: registrationResult.target, slot: registrationResult.slot, threadName: registrationResult.threadName });
                const peerProtocol = response.protocol ? structuredClone(response.protocol) : undefined, secret = activeAuthSecret;
                if (lifetime && response.requestId === registrationGeneration && registrationResult.registrationIncarnation && secret &&
                    [recipient.instanceId, recipient.profileKey, recipient.sessionId, recipient.processBirthId, recipient.cwd, recipient.busSocketPath].every(value => typeof value === "string" && !!value.trim()) &&
                    Number.isSafeInteger(recipient.pid) && recipient.pid > 0 && Number.isSafeInteger(recipient.sessionGeneration) && recipient.sessionGeneration >= 0 &&
                    recipient.target && (recipient.target.threadId === undefined || /^[A-Z]$/u.test(recipient.slot ?? "")) &&
                    hasTelegramBusCapability(localProtocol, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION) &&
                    hasTelegramBusCapability(peerProtocol, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION)) {
                    if (recipient.target)
                        Object.freeze(recipient.target);
                    if (recipient.protocol) {
                        Object.freeze(recipient.protocol.capabilities);
                        Object.freeze(recipient.protocol);
                    }
                    Object.freeze(recipient);
                    Object.freeze(peerProtocol.capabilities);
                    Object.freeze(peerProtocol);
                    let lost = false, checking = false;
                    const portsCurrent = () => deps.registrationState === readers.state && deps.getProfileKey === readers.profile && deps.getSessionId === readers.session &&
                        deps.getSessionGeneration === readers.generation && deps.getProcessBirthId === readers.birth && deps.getPid === readers.pid &&
                        deps.getFollowerBusSocketPath === readers.endpoint && deps.getLeaderSocketPath === readers.leaderEndpoint &&
                        deps.getLeaderAuthSecret === readers.auth && deps.isContextActive === readers.active && deps.protocolIdentity === readers.protocol &&
                        readers.state?.getTarget === readers.target && readers.state?.getSlot === readers.slot && readers.state?.getSessionId === readers.ackSession &&
                        readers.state?.getGeneration === readers.ackGeneration && readers.state?.getLeaderProtocol === readers.peer && readers.state?.setRegistered === readers.set;
                    const assertCurrent = () => {
                        if (lost || checking) {
                            lost = true;
                            throw new Error("Attachment publication registration is unavailable.");
                        }
                        checking = true;
                        const currentContext = activeContext;
                        try {
                            if (!portsCurrent() || !lifetime.isCurrent() || registrationAttempt !== attempt || !activeContext ||
                                !isLeaderSessionCurrent(leaderSocketPath, registrationGeneration) || activeAuthSecret !== secret ||
                                leader.busSocketPath !== leaderEndpoint || leader.busSecret !== leaderSecret ||
                                (leader.busSocketPath ?? readers.leaderEndpoint?.() ?? getTelegramBusSocketPath()) !== leaderSocketPath ||
                                (readers.auth ? readers.auth(leader) : leader.busSecret) !== secret ||
                                readers.active?.(activeContext) === false ||
                                !isSameTelegramBusFollowerRegistration({ ...recipient, instanceId: deps.instanceId, cwd: activeContext.cwd,
                                    profileKey: readers.profile?.(activeContext) ?? (activeContext.cwd ? `cwd:${activeContext.cwd}` : undefined),
                                    sessionId: readers.session?.(activeContext), sessionGeneration: readers.generation?.(), pid: getPid(), processBirthId: readers.birth?.(),
                                    busSocketPath: readers.endpoint?.() ?? deps.followerBusSocketPath, protocol: deps.protocolIdentity,
                                    target: readers.state?.getTarget(), slot: readers.state?.getSlot(), registrationGeneration: readers.state?.getGeneration() }, recipient) ||
                                readers.state?.getSessionId(recipient.sessionId) !== recipient.sessionId || !isDeepStrictEqual(readers.state?.getTarget(), recipient.target) ||
                                !isDeepStrictEqual(readers.state?.getLeaderProtocol(), peerProtocol) ||
                                !isDeepStrictEqual(deps.protocolIdentity, localProtocol) || !portsCurrent() || !lifetime.isCurrent() ||
                                registrationAttempt !== attempt || activeContext !== currentContext || deps.instanceId !== recipient.instanceId ||
                                activeLeaderSocketPath !== leaderSocketPath || activeRegistrationGeneration !== registrationGeneration || activeAuthSecret !== secret || lost)
                                throw new Error("Attachment publication registration is unavailable.");
                        }
                        catch (error) {
                            lost = true;
                            throw error;
                        }
                        finally {
                            checking = false;
                        }
                    };
                    attachmentRegistration = Object.freeze({ registration: recipient, registrationIncarnation: registrationResult.registrationIncarnation,
                        leaderSocketPath: attachmentLeaderSocketPath, leaderProtocol: peerProtocol, assertCurrent });
                }
                if (!isCurrentRequest()) {
                    await abandonOwnedRequest();
                    return false;
                }
                try {
                    await deps.onRegistered?.(ctx);
                }
                catch (error) {
                    if (!isCurrentRequest()) {
                        await abandonOwnedRequest();
                        return false;
                    }
                    await failRegistration(true);
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
            await failRegistration();
            return false;
        },
        setContext(ctx) {
            // Pi hands every event a fresh context object. Only a replaced session drops an in-flight attempt.
            if (registrationAttempt &&
                (registrationAttempt.sessionGeneration !==
                    deps.getSessionGeneration?.() ||
                    registrationAttempt.sessionId !== deps.getSessionId?.(ctx)))
                registrationAttempt = undefined;
            activeContext = ctx;
        },
        async setThreadDisplayMode(mode) {
            const socketPath = activeLeaderSocketPath;
            const generation = activeRegistrationGeneration;
            const auth = activeAuthSecret;
            if (!socketPath ||
                !generation ||
                !deps.registrationState?.isRegistered()) {
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
                socketPath,
                timeoutMs: registrationTimeoutMs,
                envelope: {
                    kind: "follower.setThreadDisplayMode",
                    requestId,
                    auth,
                    instanceId: deps.instanceId,
                    registrationGeneration: generation,
                    mode,
                },
            });
            if (activeLeaderSocketPath !== socketPath ||
                activeRegistrationGeneration !== generation ||
                activeAuthSecret !== auth ||
                deps.registrationState.getGeneration() !== generation) {
                throw new Error("Telegram Thread display setting completed for a stale registration.");
            }
            if (response?.kind !== "bus.ack" ||
                !response.ok ||
                response.requestId !== requestId ||
                !isRecord(response.result) ||
                response.result.mode !== mode) {
                throw new Error(response?.kind === "bus.ack"
                    ? (response.message ??
                        "Telegram Thread display setting was rejected.")
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
            const response = await sendTelegramBusOperation(expectedLeaderSocketPath, registrationTimeoutMs, {
                kind: "follower.renameThread",
                requestId: deps.createRequestId(),
                auth: expectedAuthSecret,
                instanceId: deps.instanceId,
                registrationGeneration: expectedRegistrationGeneration,
                target,
                threadName,
                sentAtMs: getNowMs(),
            });
            if (response?.kind !== "bus.ack" || !response.ok) {
                throw new Error(response?.kind === "bus.ack"
                    ? (response.message ??
                        "Telegram Workspace Thread rename was rejected.")
                    : "Telegram Workspace Thread rename was not acknowledged.");
            }
            if (!isLeaderSessionCurrent(expectedLeaderSocketPath, expectedRegistrationGeneration)) {
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
            if (deps.registrationState &&
                !hasTelegramBusCapability(deps.registrationState.getLeaderProtocol(), TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME)) {
                throw new Error("The active Telegram leader does not support Workspace Thread reset. Update or restart that Pi instance.");
            }
            const expectedLeaderSocketPath = activeLeaderSocketPath;
            const expectedRegistrationGeneration = activeRegistrationGeneration;
            const response = await sendTelegramBusOperation(expectedLeaderSocketPath, registrationTimeoutMs, {
                kind: "follower.resetThreadName",
                requestId: deps.createRequestId(),
                auth: activeAuthSecret,
                instanceId: deps.instanceId,
                registrationGeneration: expectedRegistrationGeneration,
                target,
                sentAtMs: getNowMs(),
            });
            const resetName = response?.kind === "bus.ack" &&
                response.ok &&
                response.result &&
                typeof response.result === "object" &&
                "threadName" in response.result &&
                typeof response.result.threadName === "string"
                ? response.result.threadName
                : undefined;
            if (!resetName) {
                throw new Error(response?.kind === "bus.ack"
                    ? (response.message ??
                        "Telegram Workspace Thread reset was rejected.")
                    : "Telegram Workspace Thread reset was not acknowledged.");
            }
            if (!isLeaderSessionCurrent(expectedLeaderSocketPath, expectedRegistrationGeneration)) {
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
            const response = await sendTelegramBusOperation(expectedLeaderSocketPath, registrationTimeoutMs, {
                kind: operation === "publish"
                    ? "follower.publishSessionReplacement"
                    : "follower.settleSessionReplacement",
                requestId,
                auth: expectedAuthSecret,
                instanceId: deps.instanceId,
                registrationGeneration: expectedRegistrationGeneration,
                intent,
                sentAtMs: getNowMs(),
            });
            if (response?.kind !== "bus.ack" ||
                !response.ok ||
                response.requestId !== requestId ||
                !isRecord(response.result) ||
                response.result.committed !== true) {
                throw new Error(response?.kind === "bus.ack"
                    ? (response.message ?? "Telegram session replacement was rejected.")
                    : "Telegram session replacement was not acknowledged.");
            }
            if (!isLeaderSessionCurrent(expectedLeaderSocketPath, expectedRegistrationGeneration) ||
                activeAuthSecret !== expectedAuthSecret) {
                throw new Error("Telegram session replacement completed for a stale follower registration.");
            }
            return true;
        },
        async disconnectFromLeader() {
            if (!activeLeaderSocketPath || !activeRegistrationGeneration) {
                return false;
            }
            const response = await sendTelegramBusOperation(activeLeaderSocketPath, registrationTimeoutMs, {
                kind: "follower.disconnect",
                requestId: deps.createRequestId(),
                auth: activeAuthSecret,
                instanceId: deps.instanceId,
                registrationGeneration: activeRegistrationGeneration,
                sentAtMs: getNowMs(),
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
/** One authenticated local operation request with the shared operation retry policy; no replay semantics. */
function sendTelegramBusOperation(socketPath, timeoutMs, envelope, assertAuthority, onRequestIssued) {
    return sendTelegramBusLocalEnvelope({
        socketPath,
        timeoutMs,
        envelope,
        assertAuthority,
        onRequestIssued,
        retry: assertAuthority || onRequestIssued ? { attempts: 1, delayMs: 0 } : getTelegramBusTransportRetryPolicy({
            endpoint: socketPath,
            operation: "operation",
        }),
    });
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
/** Copy the captured command target for the native owner; ordinary input supplies no target constraint. */
function copyLiveRebindCommandTarget(saved) {
    return saved.selectedCommand
        ? { expectedTarget: { ...saved.selectedCommand.target } }
        : {};
}
/** Exact operation/recipient/source agreement between a retained save and a later request; identity only, never currency. */
function matchesLiveRebindCarrier(saved, envelope) {
    return (saved.operationId === envelope.operationId &&
        saved.recipient.instanceId === envelope.recipientInstanceId &&
        saved.recipient.sessionId === envelope.recipientSessionId &&
        saved.recipient.generation === envelope.recipientRegistrationGeneration &&
        saved.recipient.bindingKey === envelope.recipientBindingKey &&
        isDeepStrictEqual(saved.sourceUpdateIds, [...envelope.sourceUpdateIds].sort((a, b) => a - b)));
}
/** Exact branch agreement: a command record requires its saved proof; ordinary input refuses any proof. */
function matchesLiveRebindBranch(saved, status, envelope) {
    return (isDeepStrictEqual(saved.selectedCommand, envelope.selectedCommand) &&
        (status
            ? isDeepStrictEqual(saved.preparedSource, envelope.preparedSource)
            : envelope.preparedSource === undefined));
}
/** One current warm preparation, not a prompt queue or restart recovery record. */
export function createTelegramBusFollowerLiveRebindRuntime(deps) {
    let retained;
    const runtime = {
        save(envelope, ctx, isCurrent) {
            const captured = structuredClone(envelope), selectedCommand = captured.selectedCommand;
            const heldMarker = selectedCommand, getCommandOwner = heldMarker ? deps.getCommandOwner : undefined, applyOwner = deps.applyTarget;
            if (heldMarker !== undefined &&
                (!getCommandOwner || !applyOwner || captured.updates.length !== 1))
                throw new Error("Selected command native consumption is unavailable.");
            const admission = deps.getAdmission(ctx), prepareInput = admission?.prepareLiveInput, append = admission?.appendBatch;
            let status = retained?.operationId === captured.operationId
                ? retained.status
                : undefined;
            const current = () => isCurrent() &&
                deps.getAdmission(ctx) === admission &&
                admission?.getJournalBindingKey() === captured.recipientBindingKey &&
                (!heldMarker ||
                    (deps.getCommandOwner === getCommandOwner &&
                        deps.applyTarget === applyOwner &&
                        admission?.prepareLiveInput === prepareInput &&
                        admission?.appendBatch === append &&
                        !!status?.current()));
            if (retained?.status &&
                retained.operationId !== captured.operationId &&
                retained.outcome?.status === "released" &&
                (retained.status.result !== "completed" ||
                    !retained.status.ports?.inspectCompletion.call(retained.status.plan)))
                throw new Error("Released held command is unconfirmed; no carrier replacement.");
            if (heldMarker && !status) {
                const { recipientInstanceId, recipientRegistrationGeneration, recipientSessionId, recipientBindingKey, operationId, updates, } = captured;
                const owner = getCommandOwner(structuredClone({
                    recipientInstanceId,
                    recipientRegistrationGeneration,
                    recipientSessionId,
                    recipientBindingKey,
                    operationId,
                    updates,
                    selectedCommand,
                }), ctx);
                if (!owner ||
                    typeof owner.isCurrent !== "function" ||
                    typeof owner.prepare !== "function" ||
                    typeof owner.assertRecipientCurrent !== "function")
                    throw new Error("Selected command preparation owner is unavailable.");
                const ports = {
                    isCurrent: owner.isCurrent,
                    prepare: owner.prepare,
                    assertRecipientCurrent: owner.assertRecipientCurrent,
                };
                status = {
                    owner,
                    current: () => Object.entries(ports).every(([key, value]) => Reflect.get(owner, key) === value) &&
                        (!status?.plan ||
                            Object.entries(status.ports).every(([key, value]) => Reflect.get(status.plan, key) === value)) &&
                        ports.isCurrent.call(owner),
                    prepare: ports.prepare,
                    recipient: ports.assertRecipientCurrent,
                };
            }
            if (!admission?.prepareLiveInput || !current())
                throw new Error("Live-rebind recipient admission is unavailable.");
            const digest = createHash("sha256")
                .update(JSON.stringify(captured.updates))
                .digest("hex");
            if (retained?.status && !retained.current())
                throw new Error("Prepared command authority changed; no replacement adoption.");
            if (retained &&
                (!retained.current() ||
                    (retained.operationId !== envelope.operationId &&
                        (retained.outcome?.status === "released" ||
                            retained.outcome?.status === "discarded"))))
                retained = undefined;
            if (heldMarker &&
                retained &&
                (retained.ctx !== ctx ||
                    retained.observation.recipient.instanceId !==
                        captured.recipientInstanceId ||
                    retained.observation.recipient.sessionId !==
                        captured.recipientSessionId ||
                    retained.observation.recipient.generation !==
                        captured.recipientRegistrationGeneration ||
                    retained.observation.recipient.bindingKey !==
                        captured.recipientBindingKey))
                throw new Error("Selected command saved recipient changed.");
            if (retained &&
                (retained.operationId !== captured.operationId ||
                    retained.digest !== digest ||
                    !isDeepStrictEqual(retained.observation.selectedCommand, selectedCommand)))
                throw new Error("Another live-rebind input or branch is already prepared.");
            if (!retained) {
                const held = admission.prepareLiveInput(ctx, captured.updates.map((update) => update.update_id), current);
                if (!held)
                    throw new Error("Live-rebind recipient input cannot be prepared.");
                if (heldMarker && !held.canPrepareStatusConsumption?.()) {
                    held.cancelEmpty();
                    throw new Error("Selected command native consumption is unavailable.");
                }
                retained = {
                    operationId: captured.operationId,
                    digest,
                    current,
                    held,
                    ctx,
                    ...(status ? { status } : {}),
                    observation: {
                        operationId: captured.operationId,
                        recipient: {
                            instanceId: captured.recipientInstanceId,
                            sessionId: captured.recipientSessionId,
                            generation: captured.recipientRegistrationGeneration,
                            bindingKey: captured.recipientBindingKey,
                        },
                        sourceUpdateIds: [...held.sourceUpdateIds].sort((a, b) => a - b),
                        ...(selectedCommand
                            ? { selectedCommand: structuredClone(selectedCommand) }
                            : {}),
                        status: "saved",
                    },
                };
                try {
                    admission.appendBatch(captured.updates);
                }
                catch (error) {
                    if (!held.confirmSaved())
                        throw error;
                }
            }
            if (!current() || !retained.held.confirmSaved())
                throw new Error("Live-rebind recipient save is unconfirmed.");
            if (status && !status.plan) {
                if (status.attempted)
                    throw new Error("Selected command preparation is unconfirmed; no replay.");
                status.attempted = true;
                const record = retained, readiness = record.held.prepareSourceCompletion?.();
                const assertSourceCurrent = () => {
                    if (retained !== record ||
                        !record.current() ||
                        !record.held.isOwnerCurrent())
                        throw new Error("Selected command source owner changed.");
                };
                const plan = readiness &&
                    status.prepare.call(status.owner, readiness, ctx, {
                        target: { ...heldMarker.target },
                        assertSourceCurrent,
                        assertRecipientCurrent: status.recipient,
                    });
                if (!plan ||
                    !current() ||
                    !record.held.confirmSaved() ||
                    !isDeepStrictEqual(plan.source, readiness.snapshot.source) ||
                    [plan.bindCarrier, plan.execute, plan.inspectCompletion].some((port) => typeof port !== "function"))
                    throw new Error("Selected command plan is unavailable.");
                status.plan = plan;
                status.ports = {
                    bindCarrier: plan.bindCarrier,
                    execute: plan.execute,
                    inspectCompletion: plan.inspectCompletion,
                };
                const continuation = {
                    source: plan.source,
                    assertCurrent() {
                        assertSourceCurrent();
                        if (record.outcome?.status !== "released")
                            throw new Error("Selected command has no confirmed peer release.");
                        status.recipient.call(status.owner);
                    },
                    bindCarrier: status.ports.bindCarrier.bind(plan),
                    async execute() {
                        status.result = "unknown";
                        const completed = await status.ports.execute.call(plan);
                        if (completed && record.current() && record.held.isOwnerCurrent())
                            status.result = "completed";
                        return completed;
                    },
                };
                if (!record.held.prepareStatusConsumption?.(continuation) ||
                    !current()) {
                    delete status.plan;
                    delete status.ports;
                    throw new Error("Selected command consumption is unconfirmed.");
                }
                record.observation.preparedSource = { ...plan.source };
            }
            return structuredClone(retained.observation);
        },
        async apply(envelope, ctx, isCurrent) {
            const record = retained;
            if (envelope.selectedCommand !== undefined && !record?.status?.plan)
                throw new Error("Selected command native consumption is unavailable.");
            const current = () => retained === record &&
                !!record &&
                record.ctx === ctx &&
                record.current() &&
                isCurrent() &&
                record.held.isCurrent() &&
                matchesLiveRebindBranch(record.observation, !!record.status, envelope);
            if (!record ||
                !current() ||
                !record.held.confirmSaved() ||
                !deps.applyTarget ||
                record.applying ||
                record.settling ||
                !matchesLiveRebindCarrier(record.observation, envelope))
                throw new Error("Live-rebind apply has no exact current saved carrier.");
            const mode = envelope.mode === "apply" && !record.applyIssued ? "apply" : "inspect";
            if (mode === "apply")
                record.applyIssued = true;
            record.applying = true;
            try {
                const observation = await deps.applyTarget({
                    operationId: record.operationId,
                    registrationGeneration: envelope.recipientRegistrationGeneration,
                    mode,
                    liveRebind: {
                        sourceUpdateIds: record.observation.sourceUpdateIds,
                        isCurrent: current,
                        ...copyLiveRebindCommandTarget(record.observation),
                    },
                }, ctx);
                if (!current() ||
                    !record.held.confirmSaved() ||
                    observation.operationId !== record.operationId ||
                    observation.recipient.instanceId !== envelope.recipientInstanceId ||
                    observation.recipient.sessionId !== envelope.recipientSessionId ||
                    observation.recipient.generation !==
                        envelope.recipientRegistrationGeneration)
                    throw new Error("Live-rebind apply observation changed.");
                return {
                    ...structuredClone(record.observation),
                    target: { ...observation.target },
                    slot: observation.slot,
                    status: observation.ready ? "applied" : "saved",
                };
            }
            finally {
                delete record.applying;
            }
        },
        async settle(envelope, ctx, isCurrent) {
            if (envelope.mode === "observe-command")
                return inspectCommandCompletion(envelope, ctx, isCurrent);
            const record = retained, status = record?.status, plan = status?.plan;
            if (envelope.selectedCommand !== undefined && !plan)
                throw new Error("Selected command native consumption is unavailable.");
            // Only the marked read-only held work sample may outlive the source worker, through the captured recipient owner.
            const commandWork = envelope.mode === "observe" && envelope.selectedCommand !== undefined;
            const recipientCurrent = () => {
                if (record?.status !== status ||
                    status?.plan !== plan ||
                    !status?.current())
                    return false;
                try {
                    status.recipient.call(status.owner);
                    return true;
                }
                catch {
                    return false;
                }
            };
            const current = () => retained === record &&
                !!record &&
                record.ctx === ctx &&
                record.current() &&
                isCurrent() &&
                (commandWork ? recipientCurrent() : record.held.isOwnerCurrent()) &&
                matchesLiveRebindBranch(record.observation, !!record.status, envelope);
            if (!record ||
                !current() ||
                record.applying ||
                record.settling ||
                !matchesLiveRebindCarrier(record.observation, envelope))
                throw new Error("Live-rebind settlement has no exact current carrier.");
            if (envelope.mode === "observe" || envelope.mode === "observe-held") {
                const beforeRelease = envelope.mode === "observe-held";
                if ((beforeRelease ? !!record.outcome || !record.applyIssued || !record.held.confirmSaved() : record.outcome?.status !== "released") ||
                    !deps.applyTarget ||
                    !deps.observeWork ||
                    !envelope.oldTarget)
                    throw new Error("Live-rebind work observation has no released carrier or observer.");
                const oldTarget = { ...envelope.oldTarget };
                let work;
                record.settling = true;
                try {
                    await deps.applyTarget({
                        operationId: record.operationId,
                        registrationGeneration: envelope.recipientRegistrationGeneration,
                        mode: "inspect",
                        liveRebind: {
                            sourceUpdateIds: record.observation.sourceUpdateIds,
                            isCurrent: current,
                            ...copyLiveRebindCommandTarget(record.observation),
                            observeWork(canonicalOldTarget) {
                                if (!current() ||
                                    !isDeepStrictEqual(canonicalOldTarget, oldTarget))
                                    throw new Error("Live-rebind old work target changed.");
                                work = structuredClone(deps.observeWork(canonicalOldTarget, ctx));
                                if (!current() ||
                                    !isDeepStrictEqual(canonicalOldTarget, oldTarget))
                                    throw new Error("Live-rebind work observer authority or target changed.");
                            },
                        },
                    }, ctx);
                    if (!current() || !work)
                        throw new Error("Live-rebind work observation is unconfirmed.");
                    // Unfinished or unconfirmed selected execution stays unknown; later settled delivery cannot clear it.
                    if (!beforeRelease && commandWork && status.result !== "completed")
                        work.unknown = true;
                    if (!current())
                        throw new Error("Live-rebind work observer authority changed.");
                    return {
                        ...structuredClone(record.observation),
                        status: "observed",
                        oldTarget,
                        work,
                    };
                }
                finally {
                    delete record.settling;
                }
            }
            const action = envelope.mode;
            if (record.outcome) {
                if (record.outcome.action !== envelope.mode)
                    throw new Error("Live-rebind input already has another disposition.");
                return structuredClone(record.outcome);
            }
            record.settling = true;
            const observation = (status) => ({
                ...structuredClone(record.observation),
                action,
                status,
            });
            try {
                if (envelope.mode === "discard") {
                    record.outcome = observation("unknown");
                    const status = record.held.discardSaved(current);
                    record.outcome =
                        status === "protected" ? undefined : observation(status);
                    if (!current())
                        throw new Error("Live-rebind disposal authority changed.");
                    return observation(status);
                }
                if (!record.held.isCurrent() ||
                    !record.held.confirmSaved() ||
                    !deps.applyTarget)
                    throw new Error("Live-rebind input cannot be released.");
                await deps.applyTarget({
                    operationId: record.operationId,
                    registrationGeneration: envelope.recipientRegistrationGeneration,
                    mode: "inspect",
                    liveRebind: {
                        sourceUpdateIds: record.observation.sourceUpdateIds,
                        isCurrent: current,
                        ...copyLiveRebindCommandTarget(record.observation),
                        release(canRelease, target) {
                            if (!target)
                                throw new Error("Live-rebind release target is unconfirmed.");
                            record.outcome = observation("unknown");
                            record.outcome = record.held.release(() => current() && canRelease(), target)
                                ? observation("released")
                                : undefined;
                        },
                    },
                }, ctx);
                if (!current())
                    throw new Error("Live-rebind release authority changed.");
                return structuredClone(record.outcome ?? observation("protected"));
            }
            finally {
                delete record.settling;
            }
        },
    };
    async function inspectCommandCompletion(envelope, ctx, isCurrent) {
        const record = retained;
        const current = () => retained === record &&
            !!record?.status?.plan &&
            record.ctx === ctx &&
            record.current() &&
            record.held.isOwnerCurrent() &&
            isCurrent() &&
            matchesLiveRebindBranch(record.observation, true, envelope);
        if (!record?.status?.plan ||
            !deps.applyTarget ||
            !current() ||
            record.outcome?.status !== "released" ||
            record.applying ||
            record.settling ||
            !matchesLiveRebindCarrier(record.observation, envelope))
            throw new Error("Selected command completion has no exact released carrier.");
        record.settling = true;
        try {
            const assertRecipient = () => {
                record.status.recipient.call(record.status.owner);
                if (!current())
                    throw new Error("Selected command completion recipient changed.");
            };
            assertRecipient();
            const observed = await deps.applyTarget({
                operationId: record.operationId,
                registrationGeneration: record.observation.recipient.generation,
                mode: "inspect",
                liveRebind: {
                    sourceUpdateIds: record.observation.sourceUpdateIds,
                    expectedTarget: { ...record.observation.selectedCommand.target },
                    isCurrent: current,
                },
            }, ctx);
            if (!observed.ready || !current())
                throw new Error("Selected command completion target is unconfirmed.");
            assertRecipient();
            const sourceAck = record.status.ports.inspectCompletion.call(record.status.plan);
            assertRecipient();
            if (sourceAck &&
                !isDeepStrictEqual(sourceAck, record.observation.preparedSource))
                throw new Error("Selected command completion exact ACK changed.");
            const settled = {
                preparedSource: { ...record.observation.preparedSource },
                command: record.status.result ?? "not-issued",
                ...(sourceAck ? { sourceAck: { ...sourceAck } } : {}),
            };
            const { selectedCommand } = record.observation;
            if (envelope.mode !== "observe-command" || !selectedCommand)
                throw new Error("Held completion mode does not match its marker.");
            return {
                ...structuredClone(record.observation),
                status: "command-observed",
                selectedCommand: structuredClone(selectedCommand),
                ...settled,
            };
        }
        finally {
            delete record.settling;
        }
    }
    return runtime;
}
export function createTelegramBusFollowerDurableAdmissionRuntime(deps) {
    // The journal forgets a delivery once its worker completes; this window absorbs a leader retry after a lost ACK.
    const recentDeliveries = new Map();
    const getNowMs = deps.getNowMs ?? Date.now;
    const limit = deps.recentDeliveryLimit ?? {
        maxAgeMs: 24 * 60 * 60 * 1000,
        maxEntries: 4096,
    };
    const pruneRecentDeliveries = (nowMs) => {
        for (const [deliveryId, admittedAtMs] of recentDeliveries) {
            if (recentDeliveries.size <= limit.maxEntries &&
                nowMs - admittedAtMs < limit.maxAgeMs)
                break;
            recentDeliveries.delete(deliveryId);
        }
    };
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
            const result = {
                deliveryId: delivery.deliveryId,
                sourceUpdateId: delivery.sourceUpdateId,
            };
            pruneRecentDeliveries(getNowMs());
            if (recentDeliveries.has(delivery.deliveryId))
                return result;
            deps.journal.appendBatch([update]);
            recentDeliveries.set(delivery.deliveryId, getNowMs());
            pruneRecentDeliveries(getNowMs());
            deps.signalWorker(ctx);
            return result;
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
                envelope.kind !== "leader.workspaceRestore" &&
                envelope.kind !== "leader.prepareLiveRebind" &&
                envelope.kind !== "leader.applyLiveRebind" &&
                envelope.kind !== "leader.settleLiveRebind" &&
                envelope.kind !== "leader.offerQueueHandoff") ||
                envelope.recipientInstanceId !== deps.instanceId) {
                return rejectTelegramBusRequest(envelope.requestId, "Telegram bus receiver cannot handle this envelope.");
            }
            const registrationGeneration = deps.getRegistrationGeneration();
            if (!registrationGeneration ||
                envelope.recipientRegistrationGeneration !== registrationGeneration) {
                return rejectTelegramBusRequest(envelope.requestId, "Stale Telegram bus follower registration generation.");
            }
            if (envelope.kind === "leader.prepareLiveRebind" ||
                envelope.kind === "leader.applyLiveRebind" ||
                envelope.kind === "leader.settleLiveRebind") {
                const apply = envelope.kind !== "leader.prepareLiveRebind", settle = envelope.kind === "leader.settleLiveRebind";
                const commandInput = envelope.selectedCommand, commandEnabled = deps.isLiveRebindCommandSetEnabled;
                const required = [
                    TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
                    ...(apply ? [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY] : []),
                    ...(settle ? [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE] : []),
                    ...(envelope.kind === "leader.settleLiveRebind" && envelope.mode === "observe-held"
                        ? [TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION] : []),
                    ...(commandInput
                        ? [
                            TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY,
                            TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
                            ...getTelegramBusHeldCommandCapabilities(commandInput.name),
                        ]
                        : []),
                ];
                const ctx = deps.getContext(), sessionId = deps.getSessionId?.(), bindingKey = deps.getLiveRebindJournalBindingKey?.();
                const protocol = structuredClone(deps.getLeaderProtocol?.()), localProtocol = structuredClone(deps.getLocalProtocol?.());
                const current = () => !!authSecret &&
                    deps.getAuthSecret?.() === authSecret &&
                    deps.getContext() === ctx &&
                    deps.getRegistrationGeneration() === registrationGeneration &&
                    deps.getSessionId?.() === sessionId &&
                    deps.getLiveRebindJournalBindingKey?.() === bindingKey &&
                    deps.isLiveRebindSaveEnabled?.() === true &&
                    (!apply || deps.isLiveRebindApplyEnabled?.() === true) &&
                    (!settle || deps.isLiveRebindSettleEnabled?.() === true) &&
                    (!commandInput ||
                        (typeof commandEnabled === "function" &&
                            deps.isLiveRebindCommandSetEnabled === commandEnabled &&
                            commandEnabled())) &&
                    isDeepStrictEqual(deps.getLeaderProtocol?.(), protocol) &&
                    isDeepStrictEqual(deps.getLocalProtocol?.(), localProtocol);
                if (!authSecret ||
                    !ctx ||
                    !bindingKey ||
                    sessionId !== envelope.recipientSessionId ||
                    bindingKey !== envelope.recipientBindingKey ||
                    !required.every((cap) => hasTelegramBusCapability(protocol, cap) &&
                        hasTelegramBusCapability(localProtocol, cap)) ||
                    !localProtocol ||
                    !getTelegramBusProtocolCompatibility({
                        local: localProtocol,
                        remote: protocol,
                    }).compatible ||
                    !current() ||
                    (settle
                        ? !deps.handleLiveRebindSettle
                        : apply
                            ? !deps.handleLiveRebindApply
                            : !deps.handleLiveRebindSave))
                    return rejectTelegramBusRequest(envelope.requestId, "Live-rebind capability or recipient authority is unavailable.");
                try {
                    const result = envelope.kind === "leader.settleLiveRebind"
                        ? await deps.handleLiveRebindSettle(envelope, ctx, current)
                        : envelope.kind === "leader.applyLiveRebind"
                            ? await deps.handleLiveRebindApply(envelope, ctx, current)
                            : await deps.handleLiveRebindSave(envelope, ctx, current);
                    if (!current())
                        throw new Error("Live-rebind receiver authority changed.");
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: true,
                        result,
                    };
                }
                catch (error) {
                    deps.recordRuntimeEvent?.("bus", error, {
                        phase: "follower-live-rebind-control",
                    });
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: false,
                        message: error instanceof Error
                            ? error.message
                            : "Live-rebind request failed.",
                    };
                }
            }
            if (envelope.kind === "leader.workspaceRestore") {
                const ctx = deps.getContext();
                if (!authSecret ||
                    !ctx ||
                    !deps.isWorkspaceRestoreEnabled?.() ||
                    !deps.handleWorkspaceRestore)
                    return rejectTelegramBusRequest(envelope.requestId, "Workspace Restore capability is unavailable.");
                try {
                    const result = await deps.handleWorkspaceRestore({
                        operationId: envelope.operationId,
                        registrationGeneration,
                        mode: envelope.mode,
                    }, ctx);
                    if (deps.getAuthSecret?.() !== authSecret ||
                        deps.getRegistrationGeneration() !== registrationGeneration ||
                        deps.getContext() !== ctx ||
                        !deps.isWorkspaceRestoreEnabled())
                        throw new Error("Workspace Restore receiver authority changed.");
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: true,
                        result,
                    };
                }
                catch (error) {
                    deps.recordRuntimeEvent?.("bus", error, {
                        phase: "follower-workspace-restore",
                    });
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: false,
                        message: error instanceof Error
                            ? error.message
                            : "Workspace Restore failed.",
                    };
                }
            }
            if (envelope.kind === "leader.offerInputCustodyHandoff" &&
                envelope.recipientBindingKey !== deps.getRecipientBindingKey())
                return rejectTelegramBusRequest(envelope.requestId, "Mismatched Telegram follower handoff recipient identity.");
            if (envelope.kind !== "leader.offerQueueHandoff" &&
                envelope.kind !== "leader.offerInputCustodyHandoff" &&
                (!envelope.delivery ||
                    envelope.delivery.recipientBindingKey !==
                        deps.getRecipientBindingKey())) {
                return rejectTelegramBusRequest(envelope.requestId, "Mismatched Telegram follower delivery identity.");
            }
            const ctx = deps.getContext();
            if (!ctx) {
                return rejectTelegramBusRequest(envelope.requestId, "Telegram bus follower has no active context.");
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
                    return {
                        kind: "bus.ack",
                        requestId: envelope.requestId,
                        ok: true,
                        result,
                    };
                }
                if (envelope.kind !== "leader.offerQueueHandoff") {
                    const sourceReferenceEnabled = envelope.kind === "leader.wakeInputCustody" ||
                        (deps.isSourceReferenceAdmissionEnabled?.() ?? false);
                    if (sourceReferenceEnabled &&
                        !deps.hasAuthenticatedSourceReferenceTransport?.())
                        throw new Error("Telegram follower source-reference admission requires authenticated transport.");
                    const admission = sourceReferenceEnabled
                        ? deps.sourceReferenceAdmission
                        : deps.durableAdmission;
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
                if (envelope.payload.queueLane === "steer" &&
                    ![deps.getLocalProtocol?.(), deps.getLeaderProtocol?.()].every(hasTelegramBusSteerQueueHandoffCapability)) {
                    throw new Error("Steer queue handoff capability was not negotiated.");
                }
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
        ...(typeof value.registrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(value.registrationIncarnation) ? { registrationIncarnation: value.registrationIncarnation } : {}),
        ...(typeof value.apiRegistrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(value.apiRegistrationIncarnation) ? { apiRegistrationIncarnation: value.apiRegistrationIncarnation } : {}),
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
