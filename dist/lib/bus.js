/**
 * Telegram multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer, } from "node:net";
import { platform as getPlatform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { classifyTelegramBusTransportError, createTelegramBusTransportTimeoutError, delayTelegramBusTransportRetry, getTelegramBusEndpointDiagnostics, getTelegramBusFollowerEndpoint, getTelegramBusLeaderEndpoint, getTelegramBusPipePath, getTelegramBusTransportRetryPolicy, isRetryableTelegramBusTransportError, isTelegramBusPipePath, probeTelegramBusEndpoint, TELEGRAM_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES, } from "./bus-transport.js";
import { isSameTelegramLockOwner, TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS, } from "./locks.js";
import { resolveAgentDir } from "./paths.js";
import { getTelegramProcessBirthIdentity } from "./process-identity.js";
import { parseTelegramQueueHandoffPayload, TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES, } from "./queue.js";
import { areTelegramTargetsEqual, parseTelegramTarget as parseTarget, } from "./target.js";
import { normalizeTelegramSessionReplacementIntent, } from "./threads.js";
import { hasOnlyWireKeys, isTelegramArtifactCaption, isTelegramArtifactFileName, isWireRecord as isRecord, TELEGRAM_ARTIFACT_MAX_BYTES, } from "./wire.js";
export function createCurrentTelegramBusProcessRuntime(input) {
    return createTelegramBusProcessRuntime({
        getActiveProfileName: input.getActiveProfileName,
        endpointLayout: input.endpointLayout,
        pid: input.pid ?? process.pid,
        parentPid: input.parentPid ?? process.ppid,
        createdAtMs: input.createdAtMs ?? Date.now(),
    });
}
export function createTelegramBusProcessRuntime(input) {
    const getActiveProfileName = input.getActiveProfileName, endpointLayout = input.endpointLayout;
    const instanceId = `${input.pid}:${input.createdAtMs}`;
    const ownerPid = input.parentPid || input.pid;
    const manualFollowerOwnerId = input.parentProcessIdentity ??
        getTelegramProcessBirthIdentity(ownerPid, input.createdAtMs);
    return {
        instanceId,
        processId: input.pid,
        processBirthId: getTelegramProcessBirthIdentity(input.pid, instanceId),
        manualFollowerOwnerId,
        getLeaderSocketPath: () => getTelegramBusSocketPath(undefined, undefined, getActiveProfileName(), endpointLayout),
        getFollowerSocketPath: () => getTelegramBusFollowerSocketPath(instanceId, undefined, undefined, getActiveProfileName(), endpointLayout),
    };
}
export function createTelegramBusAuthSecret() {
    return randomBytes(32).toString("base64url");
}
// v3: journal source serialization left the config transaction; mixed v2/v3 peers would not exclude each other.
const TELEGRAM_BUS_PROTOCOL_VERSION = 3;
export const TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION = "durable-follower-admission-v1";
export const TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF = "queue-handoff-v1";
/** Unspent Steer lane codec; independent from baseline receipt handoff support. */
export const TELEGRAM_BUS_CAPABILITY_QUEUE_STEER = "queue-steer-v1";
export const TELEGRAM_BUS_CAPABILITY_CONNECT_RECOVERY = "explicit-connect-recovery-v1";
export const TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE = "input-custody-reference-v1";
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME = "workspace-thread-rename-v1";
export const TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE = "thread-display-mode-v1";
export const TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT = "directory-display-format-v1";
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT = "workspace-follower-auto-connect-v1";
export const TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT = "session-replacement-intent-v1";
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE = "workspace-restore-v1";
/** Shared Workspace readers understand independent pre-dispatch input/cleanup state. */
export const TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND = "live-rebind-pre-dispatch-reader-v2";
/** Shared Workspace decoder understands non-creating, unissued cancelled-orphan intents; no execution/deletion grant. */
export const TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER = "workspace-orphan-intent-reader-v1";
/** Adds the irreversible issued marker and its original-scope/current-executor codec; independent of execution authority. */
export const TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER = "workspace-orphan-intent-reader-v2";
export const TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION = "live-rebind-pre-dispatch-v1";
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE = "live-thread-rebind-save-v1";
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY = "live-thread-rebind-apply-v1";
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE = "live-thread-rebind-settle-v1";
/** Restricted recipient text/menu delivery; negotiated identity and captured effect authority remain required. */
export const TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY = "selected-menu-delivery-v1";
/** Versioned held-command set; syntax is shared, while the captured recipient Commands registry owns supported plans. */
export const TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET = "live-thread-rebind-command-set-v1";
/** Every live rebinding needs the save/apply/settle trio; held command selections additionally need these two. */
export const TELEGRAM_BUS_LIVE_REBIND_CAPABILITIES = [
    TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
    TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY,
    TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE,
];
export const TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES = [
    TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_COMMAND_SET,
    TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
];
/** Start/help are restricted menu aliases, negotiated separately from the original held-command set. */
export const TELEGRAM_BUS_CAPABILITY_HELD_MENU_ALIASES = "held-menu-aliases-v1";
export function getTelegramBusHeldCommandCapabilities(name) {
    return name === "start" || name === "help"
        ? [...TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES, TELEGRAM_BUS_CAPABILITY_HELD_MENU_ALIASES]
        : TELEGRAM_BUS_HELD_COMMAND_CAPABILITIES;
}
function parseSelectedCommandInput(value) {
    if (!isRecord(value) ||
        !hasOnlyWireKeys(value, ["name", "target"]) ||
        typeof value.name !== "string" ||
        !/^[a-z0-9_]{1,32}$/u.test(value.name) ||
        !isRecord(value.target) ||
        !hasOnlyWireKeys(value.target, ["chatId", "threadId"]))
        return undefined;
    const target = parseThreadTarget(value.target);
    return target &&
        Number.isSafeInteger(target.chatId) &&
        target.chatId > 0 &&
        Number.isSafeInteger(target.threadId) &&
        target.threadId > 0
        ? { name: value.name, target }
        : undefined;
}
/** Pure live-rebind recipient/operation identity shared by prepare/apply/settle envelopes. */
function parseLiveRebindRecipient(value) {
    const { recipientInstanceId, recipientRegistrationGeneration, recipientSessionId, recipientBindingKey, operationId, } = value;
    return typeof recipientInstanceId === "string" &&
        recipientInstanceId &&
        typeof recipientRegistrationGeneration === "string" &&
        recipientRegistrationGeneration &&
        typeof recipientSessionId === "string" &&
        recipientSessionId &&
        typeof recipientBindingKey === "string" &&
        recipientBindingKey &&
        typeof operationId === "string" &&
        operationId.length > 0 &&
        operationId.length <= 128
        ? {
            recipientInstanceId,
            recipientRegistrationGeneration,
            recipientSessionId,
            recipientBindingKey,
            operationId,
        }
        : undefined;
}
/** Non-empty, duplicate-free, non-negative safe-integer Telegram update ids. */
function isUniqueSourceUpdateIds(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.every((id) => Number.isSafeInteger(id) && id >= 0) &&
        new Set(value).size === value.length);
}
function parsePreparedCommandSource(value) {
    if (!isRecord(value) ||
        !hasOnlyWireKeys(value, [
            "journalBindingKey",
            "updateId",
            "sourceSha256",
        ]) ||
        typeof value.journalBindingKey !== "string" ||
        !value.journalBindingKey ||
        !Number.isSafeInteger(value.updateId) ||
        value.updateId < 0 ||
        typeof value.sourceSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.sourceSha256))
        return undefined;
    return {
        journalBindingKey: value.journalBindingKey,
        updateId: value.updateId,
        sourceSha256: value.sourceSha256,
    };
}
export function createTelegramBusProtocolIdentity(input) {
    const runtimeBuild = input.runtimeBuild.trim();
    if (!runtimeBuild || runtimeBuild.length > 128) {
        throw new Error("Telegram bus runtime build identity is invalid.");
    }
    const capabilities = [...new Set(input.capabilities ?? [])].sort();
    if (capabilities.length > 32 ||
        capabilities.some((capability) => capability.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/u.test(capability))) {
        throw new Error("Telegram bus capabilities must be canonical identifiers.");
    }
    return {
        protocolVersion: TELEGRAM_BUS_PROTOCOL_VERSION,
        runtimeBuild,
        capabilities,
    };
}
export function createTelegramCurrentBusProtocolIdentity(capabilities = []) {
    const packageMetadata = createRequire(import.meta.url)("../package.json");
    if (typeof packageMetadata.version !== "string") {
        throw new Error("Telegram package build identity is unavailable.");
    }
    return createTelegramBusProtocolIdentity({
        runtimeBuild: packageMetadata.version,
        capabilities,
    });
}
export function hasTelegramBusCapability(identity, capability) {
    return identity?.capabilities.includes(capability) ?? false;
}
export function hasTelegramBusSteerQueueHandoffCapability(identity) {
    return hasTelegramBusCapability(identity, TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF) &&
        hasTelegramBusCapability(identity, TELEGRAM_BUS_CAPABILITY_QUEUE_STEER);
}
/** Both peers advertise every required capability over a compatible protocol; reads only the two identities. */
export function hasTelegramBusSharedCapabilities(local, remote, required) {
    return (required.every((capability) => hasTelegramBusCapability(local, capability) &&
        hasTelegramBusCapability(remote, capability)) && getTelegramBusProtocolCompatibility({ local, remote }).compatible);
}
export function getTelegramBusProtocolCompatibility(input) {
    if (!input.remote) {
        return {
            compatible: false,
            reason: "missing-identity",
            missingCapabilities: [],
        };
    }
    if (input.remote.protocolVersion !== input.local.protocolVersion) {
        return {
            compatible: false,
            reason: "version-mismatch",
            missingCapabilities: [],
        };
    }
    const remoteCapabilities = new Set(input.remote.capabilities);
    const missingCapabilities = input.local.capabilities
        .filter((capability) => capability === TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION)
        .filter((capability) => !remoteCapabilities.has(capability));
    return missingCapabilities.length > 0
        ? {
            compatible: false,
            reason: "missing-capability",
            missingCapabilities,
        }
        : { compatible: true, missingCapabilities: [] };
}
export function getTelegramBusSocketPath(agentDir = resolveAgentDir(), platform = getPlatform(), profileName, layout) {
    return getTelegramBusLeaderEndpoint({
        agentDir,
        platform,
        profileName,
        layout,
    });
}
export function getTelegramBusFollowerSocketPath(instanceId, agentDir = resolveAgentDir(), platform = getPlatform(), profileName, layout) {
    return getTelegramBusFollowerEndpoint({
        agentDir,
        platform,
        instanceId,
        profileName,
        layout,
    });
}
/** Whether a live follower is still exactly the captured registration: identity, process, session, endpoint and negotiated protocol. */
export function isSameTelegramBusFollowerRegistration(live, captured) {
    return (live.instanceId === captured.instanceId &&
        live.profileKey === captured.profileKey &&
        live.sessionId === captured.sessionId &&
        live.registrationGeneration === captured.registrationGeneration &&
        live.pid === captured.pid &&
        live.processBirthId === captured.processBirthId &&
        live.sessionGeneration === captured.sessionGeneration &&
        live.cwd === captured.cwd &&
        live.slot === captured.slot &&
        live.busSocketPath === captured.busSocketPath &&
        isDeepStrictEqual(live.protocol, captured.protocol));
}
export function getTelegramFollowerTargetOwnership(input) {
    const liveFollower = input.followers.find((follower) => {
        return (follower.target?.chatId === input.target.chatId &&
            follower.target.threadId === input.target.threadId);
    });
    if (liveFollower?.registrationGeneration &&
        liveFollower.profileKey &&
        liveFollower.protocol?.capabilities.includes(TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION)) {
        return {
            instanceId: liveFollower.instanceId,
            ownerGeneration: liveFollower.registrationGeneration,
            recipientBindingKey: liveFollower.profileKey,
            protocolIdentity: liveFollower.protocol,
        };
    }
    // Persisted records are restart hints, not live routing authority. Only an
    // authenticated current follower registration may receive forwarded work.
    return undefined;
}
const TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD = "__piTelegramAggregateDelivery";
const TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD = "__piTelegramCrossTargetDelivery";
function hasTelegramBusDeliveryMarker(body, marker) {
    return Boolean(body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body[marker] === true);
}
export function markTelegramBusCrossTargetDelivery(body) {
    return { ...body, [TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD]: true };
}
export function stripTelegramBusApiMetadata(body) {
    if (!(TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD in body) &&
        !(TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD in body)) {
        return body;
    }
    const clean = { ...body };
    delete clean[TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD];
    delete clean[TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD];
    return clean;
}
export function isTelegramFollowerApiCallAllowed(input) {
    const allowedCallMethods = new Set([
        "answerCallbackQuery",
        "answerGuestQuery",
        "closeForumTopic",
        "deleteForumTopic",
        "deleteMessage",
        "editForumTopic",
        "editMessageReplyMarkup",
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
        "sendRichMessage",
        "sendVoice",
    ]);
    const target = input.follower.target;
    const matchesId = (value, expected) => value === expected || value === String(expected);
    const isTargetScoped = (body) => {
        if (!target)
            return false;
        if (!body || typeof body !== "object" || Array.isArray(body))
            return false;
        const record = body;
        if (!matchesId(record.chat_id, target.chatId))
            return false;
        if (target.threadId === undefined)
            return true;
        return matchesId(record.message_thread_id, target.threadId);
    };
    const isTargetChatScoped = (body) => {
        if (!target)
            return false;
        if (!body || typeof body !== "object" || Array.isArray(body))
            return false;
        const record = body;
        return matchesId(record.chat_id, target.chatId);
    };
    const isDifferentTargetScoped = (body) => {
        if (!target || !isTargetChatScoped(body))
            return false;
        const threadId = body.message_thread_id;
        if (threadId === undefined)
            return target.threadId !== undefined;
        const parsedThreadId = typeof threadId === "number" ? threadId : Number(threadId);
        return (Number.isInteger(parsedThreadId) &&
            (target.threadId === undefined || !matchesId(threadId, target.threadId)));
    };
    const isTargetMessageScoped = (body) => {
        if (!isTargetChatScoped(body))
            return false;
        const messageId = body.message_id;
        const parsedMessageId = typeof messageId === "number" ? messageId : Number(messageId);
        return (Number.isInteger(parsedMessageId) && matchesId(messageId, parsedMessageId));
    };
    const isBotCommandRegistration = (body) => {
        if (!body || typeof body !== "object" || Array.isArray(body))
            return false;
        const commands = body.commands;
        return (Array.isArray(commands) &&
            commands.every((command) => command &&
                typeof command === "object" &&
                !Array.isArray(command) &&
                typeof command.command === "string" &&
                typeof command.description === "string"));
    };
    if (input.method === "downloadFile")
        return true;
    if (input.method === "call") {
        const apiMethod = input.args[0];
        if (typeof apiMethod !== "string")
            return false;
        if (apiMethod === "answerCallbackQuery" ||
            apiMethod === "answerGuestQuery") {
            return true;
        }
        if (apiMethod === "getMe")
            return true;
        if (apiMethod === "setMyCommands")
            return isBotCommandRegistration(input.args[1]);
        if (apiMethod === "sendChatAction")
            return isTargetScoped(input.args[1]);
        if (apiMethod === "sendMessage" &&
            hasTelegramBusDeliveryMarker(input.args[1], TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD)) {
            return false;
        }
        if ((apiMethod === "sendMessage" || apiMethod === "sendRichMessage") &&
            hasTelegramBusDeliveryMarker(input.args[1], TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD)) {
            return isDifferentTargetScoped(input.args[1]);
        }
        if (apiMethod === "deleteMessage" ||
            apiMethod === "editMessageReplyMarkup" ||
            apiMethod === "editMessageText") {
            if (!isTargetMessageScoped(input.args[1]))
                return false;
            const body = input.args[1];
            const messageId = typeof body.message_id === "number"
                ? body.message_id
                : Number(body.message_id);
            return input.isMessageOwned?.(target.chatId, messageId) === true;
        }
        return allowedCallMethods.has(apiMethod) && isTargetScoped(input.args[1]);
    }
    if (input.method === "callMultipart") {
        const apiMethod = input.args[0];
        return (typeof apiMethod === "string" &&
            allowedMultipartMethods.has(apiMethod) &&
            isTargetScoped(input.args[1]));
    }
    return false;
}
export function createTelegramFollowerApiCallAuthorizer(deps) {
    return (input) => isTelegramFollowerApiCallAllowed({
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
export function createTelegramBusFollowerDeliveryIdentity(input) {
    if (!input.recipientBindingKey ||
        !Number.isSafeInteger(input.sourceUpdateId) ||
        input.sourceUpdateId < 0 ||
        (input.sourceClaim !== undefined &&
            (!input.sourceClaim.acquisitionId ||
                input.sourceClaim.acquisitionId.length > 256 ||
                !input.sourceClaim.handoffId ||
                input.sourceClaim.handoffId.length > 256))) {
        throw new Error("Telegram follower delivery identity is incomplete.");
    }
    const deliveryId = createHash("sha256")
        .update(JSON.stringify({
        version: 1,
        kind: input.kind,
        recipientBindingKey: input.recipientBindingKey,
        sourceUpdateId: input.sourceUpdateId,
    }))
        .digest("hex");
    return {
        deliveryId: `telegram-follower-v1-${deliveryId}`,
        sourceUpdateId: input.sourceUpdateId,
        recipientBindingKey: input.recipientBindingKey,
        ...(input.sourceRecoveryKey
            ? { sourceRecoveryKey: input.sourceRecoveryKey }
            : {}),
        ...(input.sourceClaim ? { sourceClaim: { ...input.sourceClaim } } : {}),
    };
}
export function canUseTelegramBusInputCustodyReference(input) {
    return (hasTelegramBusCapability(input.local, TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE) &&
        hasTelegramBusCapability(input.remote, TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE));
}
export function createTelegramBusFollowerSourceReferenceDeliveryIdentity(input) {
    if (!input.sourceRecoveryKey || !input.source.owner.handoffId)
        throw new Error("Telegram follower source-reference delivery requires an accepted handoff.");
    return createTelegramBusFollowerDeliveryIdentity({
        kind: input.kind,
        recipientBindingKey: input.recipientBindingKey,
        sourceUpdateId: input.source.updateId,
        sourceRecoveryKey: input.sourceRecoveryKey,
        sourceClaim: {
            acquisitionId: input.source.owner.acquisitionId,
            handoffId: input.source.owner.handoffId,
        },
    });
}
export function getTelegramBusEnvelopeTrafficClass(envelope) {
    if (envelope.kind === "follower.register" ||
        envelope.kind === "follower.restoreWorkspace" ||
        envelope.kind === "bus.probe")
        return "bootstrap";
    if (envelope.kind === "bus.ack")
        return "response";
    return "generation-fenced";
}
export function createTelegramBusRequestId(input) {
    return `${input.instanceId}:${input.sequence}`;
}
export function createTelegramBusRequestIdFactory(instanceId) {
    let sequence = 0;
    return () => {
        sequence += 1;
        return createTelegramBusRequestId({ instanceId, sequence });
    };
}
export function encodeTelegramBusEnvelope(envelope) {
    return `${JSON.stringify(envelope)}\n`;
}
export function parseTelegramBusEnvelope(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value))
        return undefined;
    const kind = value.kind;
    const requestId = value.requestId;
    if (typeof kind !== "string" || typeof requestId !== "string") {
        return undefined;
    }
    let envelope;
    switch (kind) {
        case "follower.register":
        case "follower.restoreWorkspace":
            envelope = parseRegisterEnvelope(value, requestId, kind);
            break;
        case "follower.heartbeat":
        case "follower.disconnect":
            envelope = parseFollowerPresenceEnvelope(value, requestId, kind);
            break;
        case "follower.setThreadDisplayMode":
            if (typeof value.instanceId === "string" &&
                typeof value.registrationGeneration === "string" &&
                (value.mode === "letters" ||
                    value.mode === "names" ||
                    value.mode === "directory-snake" ||
                    value.mode === "directory-title")) {
                envelope = {
                    kind,
                    requestId,
                    instanceId: value.instanceId,
                    registrationGeneration: value.registrationGeneration,
                    mode: value.mode,
                };
            }
            break;
        case "follower.renameThread":
            envelope = parseRenameThreadEnvelope(value, requestId);
            break;
        case "follower.resetThreadName": {
            const target = parseTarget(value.target);
            if (typeof value.instanceId === "string" &&
                typeof value.registrationGeneration === "string" &&
                typeof value.sentAtMs === "number" &&
                target?.threadId !== undefined) {
                envelope = {
                    kind,
                    requestId,
                    instanceId: value.instanceId,
                    registrationGeneration: value.registrationGeneration,
                    target: { chatId: target.chatId, threadId: target.threadId },
                    sentAtMs: value.sentAtMs,
                };
            }
            break;
        }
        case "follower.publishSessionReplacement":
        case "follower.settleSessionReplacement": {
            const intent = normalizeTelegramSessionReplacementIntent(value.intent);
            if (typeof value.instanceId === "string" &&
                typeof value.registrationGeneration === "string" &&
                typeof value.sentAtMs === "number" &&
                intent) {
                envelope = {
                    kind,
                    requestId,
                    instanceId: value.instanceId,
                    registrationGeneration: value.registrationGeneration,
                    intent,
                    sentAtMs: value.sentAtMs,
                };
            }
            break;
        }
        case "leader.forwardCallback":
            envelope = parseForwardCallbackEnvelope(value, requestId);
            break;
        case "leader.forwardReaction":
            envelope = parseForwardReactionEnvelope(value, requestId);
            break;
        case "leader.offerInputCustodyHandoff":
            envelope = parseOfferInputCustodyHandoffEnvelope(value, requestId);
            break;
        case "leader.wakeInputCustody":
            envelope = parseWakeInputCustodyEnvelope(value, requestId);
            break;
        case "leader.forwardMessage":
            envelope = parseForwardMessageEnvelope(value, requestId, "leader.forwardMessage");
            break;
        case "leader.forwardEditedMessage":
            envelope = parseForwardMessageEnvelope(value, requestId, "leader.forwardEditedMessage");
            break;
        case "leader.prepareLiveRebind": {
            const selectedCommand = parseSelectedCommandInput(value.selectedCommand);
            if (!hasOnlyWireKeys(value, [
                "kind",
                "requestId",
                "auth",
                "recipientInstanceId",
                "recipientRegistrationGeneration",
                "recipientSessionId",
                "recipientBindingKey",
                "operationId",
                "updates",
                "selectedCommand",
                "sentAtMs",
            ]) ||
                (Object.hasOwn(value, "selectedCommand") &&
                    (!selectedCommand ||
                        !Array.isArray(value.updates) ||
                        value.updates.length !== 1)))
                break;
            const recipient = parseLiveRebindRecipient(value);
            if (recipient &&
                Array.isArray(value.updates) &&
                value.updates.every(isRecord) &&
                isUniqueSourceUpdateIds(value.updates.map((update) => update.update_id)) &&
                typeof value.sentAtMs === "number" &&
                Number.isFinite(value.sentAtMs)) {
                envelope = {
                    kind: "leader.prepareLiveRebind",
                    requestId,
                    ...recipient,
                    updates: value.updates,
                    sentAtMs: value.sentAtMs,
                    ...(selectedCommand ? { selectedCommand } : {}),
                };
            }
            break;
        }
        case "leader.applyLiveRebind":
        case "leader.settleLiveRebind": {
            const selectedCommand = parseSelectedCommandInput(value.selectedCommand), preparedSource = parsePreparedCommandSource(value.preparedSource);
            if (!hasOnlyWireKeys(value, [
                "kind",
                "requestId",
                "auth",
                "recipientInstanceId",
                "recipientRegistrationGeneration",
                "recipientSessionId",
                "recipientBindingKey",
                "operationId",
                "sourceUpdateIds",
                "mode",
                "oldTarget",
                "selectedCommand",
                "preparedSource",
                "sentAtMs",
            ]) ||
                (Object.hasOwn(value, "preparedSource") && !selectedCommand) ||
                (value.mode === "observe-command" &&
                    (!selectedCommand || Object.hasOwn(value, "oldTarget"))) ||
                (value.mode === "observe-held" && (parseThreadTarget(value.oldTarget)?.threadId ?? 0) <= 0))
                break;
            if (Object.hasOwn(value, "selectedCommand") &&
                (!selectedCommand ||
                    !Array.isArray(value.sourceUpdateIds) ||
                    value.sourceUpdateIds.length !== 1 ||
                    !preparedSource ||
                    preparedSource.updateId !== value.sourceUpdateIds[0] ||
                    preparedSource.journalBindingKey !== value.recipientBindingKey))
                break;
            const recipient = parseLiveRebindRecipient(value);
            if (recipient &&
                (value.kind === "leader.applyLiveRebind"
                    ? value.mode === "apply" || value.mode === "inspect"
                    : value.mode === "release" ||
                        value.mode === "discard" ||
                        value.mode === "observe-command" ||
                        ((value.mode === "observe" || value.mode === "observe-held") &&
                            !!parseThreadTarget(value.oldTarget))) &&
                isUniqueSourceUpdateIds(value.sourceUpdateIds) &&
                typeof value.sentAtMs === "number" &&
                Number.isFinite(value.sentAtMs)) {
                envelope = {
                    kind: value.kind,
                    requestId,
                    ...recipient,
                    sourceUpdateIds: value.sourceUpdateIds,
                    mode: value.mode,
                    sentAtMs: value.sentAtMs,
                    ...((value.mode === "observe" || value.mode === "observe-held")
                        ? { oldTarget: parseThreadTarget(value.oldTarget) }
                        : {}),
                    ...(selectedCommand ? { selectedCommand, preparedSource } : {}),
                };
            }
            break;
        }
        case "leader.workspaceRestore":
            if (typeof value.recipientInstanceId === "string" &&
                value.recipientInstanceId &&
                typeof value.recipientRegistrationGeneration === "string" &&
                value.recipientRegistrationGeneration &&
                typeof value.operationId === "string" &&
                value.operationId.length > 0 &&
                value.operationId.length <= 128 &&
                (value.mode === "apply" || value.mode === "inspect") &&
                typeof value.sentAtMs === "number" &&
                Number.isFinite(value.sentAtMs)) {
                envelope = {
                    kind: "leader.workspaceRestore",
                    requestId,
                    recipientInstanceId: value.recipientInstanceId,
                    recipientRegistrationGeneration: value.recipientRegistrationGeneration,
                    operationId: value.operationId,
                    mode: value.mode,
                    sentAtMs: value.sentAtMs,
                };
            }
            break;
        case "leader.offerQueueHandoff":
            envelope = parseQueueHandoffEnvelope(value, requestId, "leader.offerQueueHandoff");
            break;
        case "follower.offerQueueHandoff":
            envelope = parseQueueHandoffEnvelope(value, requestId, "follower.offerQueueHandoff");
            break;
        case "follower.resolveAgentTarget":
            envelope = parseResolveAgentTargetEnvelope(value, requestId);
            break;
        case "follower.routeAgentMessage":
            envelope = parseRouteAgentMessageEnvelope(value, requestId);
            break;
        case "follower.deliverSelectedMenu":
            envelope = parseSelectedMenuDeliveryEnvelope(value, requestId);
            break;
        case "follower.callApi":
            envelope = parseCallApiEnvelope(value, requestId);
            break;
        case "bus.probe":
            envelope = { kind, requestId };
            break;
        case "bus.ack":
            envelope = parseAckEnvelope(value, requestId);
            break;
        default:
            return undefined;
    }
    const auth = value.auth;
    if (envelope && typeof auth === "string")
        envelope.auth = auth;
    return envelope;
}
export function probeTelegramBusLeader(input) {
    const timeoutMs = input.timeoutMs ?? TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS;
    return new Promise((resolve) => {
        let settled = false;
        let socket;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket?.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => finish("silent"), timeoutMs);
        let connected = false;
        try {
            socket = createConnection(resolveTelegramBusSocketPath(input.socketPath));
        }
        catch {
            finish("unknown");
            return;
        }
        socket.once("connect", () => {
            connected = true;
            socket.write(encodeTelegramBusEnvelope({
                kind: "bus.probe",
                requestId: `probe:${randomBytes(8).toString("hex")}`,
                ...(input.secret ? { auth: input.secret } : {}),
            }));
        });
        socket.once("data", () => finish("responsive"));
        socket.once("end", () => finish("responsive"));
        socket.once("error", (error) => {
            const code = error.code;
            finish(!connected && code === "ECONNREFUSED" ? "unreachable" : "unknown");
        });
    });
}
/**
 * Takeover evidence replacing the retired file heartbeat: a full silent window, or an unreachable endpoint
 * confirmed again after one more window (a just-started leader binds its socket well within it). The owner must
 * stay the same throughout; the lock acquisition then CAS-checks that exact owner.
 */
export async function proveTelegramBusLeaderUnresponsive(input) {
    const first = await input.probe();
    if (first === "silent")
        return input.isSameOwner();
    if (first !== "unreachable")
        return false;
    await input.sleep(input.windowMs ?? TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS);
    if (!input.isSameOwner())
        return false;
    const second = await input.probe();
    return (second === "silent" || second === "unreachable") && input.isSameOwner();
}
/** Composition-ready takeover proof for one profile's leader lock and endpoint. */
export function createTelegramBusLeaderUnresponsivenessProof(deps) {
    const probe = deps.probe ?? probeTelegramBusLeader;
    const sleep = deps.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    return (owner) => proveTelegramBusLeaderUnresponsive({
        probe: () => probe({
            socketPath: owner.busSocketPath ?? deps.getLeaderSocketPath(),
            secret: owner.busSecret,
        }),
        isSameOwner: () => {
            const state = deps.getLeaderState();
            return (state.kind === "active-elsewhere" &&
                isSameTelegramLockOwner(state.lock, owner));
        },
        sleep,
    });
}
const TELEGRAM_ACTIVE_LOCAL_SERVERS = Symbol.for("@llblab/pi-telegram/active-local-servers");
function getActiveTelegramBusLocalServers() {
    const root = globalThis;
    return (root[TELEGRAM_ACTIVE_LOCAL_SERVERS] ??= new Map());
}
export function resolveTelegramBusSocketPath(source, platform = getPlatform()) {
    const endpoint = typeof source === "function" ? source() : source;
    if (platform === "win32") {
        if (isTelegramBusPipePath(endpoint))
            return endpoint;
        return getTelegramBusPipePath({
            agentDir: dirname(endpoint),
            scope: basename(endpoint),
        });
    }
    const ownerScope = process.getuid?.() ?? "user";
    const fallbackDir = join(tmpdir(), `pi-telegram-${ownerScope}`);
    if (dirname(endpoint) === fallbackDir &&
        /^[0-9a-f]{16}\.sock$/u.test(basename(endpoint))) {
        return endpoint;
    }
    if (Buffer.byteLength(endpoint) <= TELEGRAM_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES) {
        return endpoint;
    }
    const digest = createHash("sha256")
        .update(endpoint)
        .digest("hex")
        .slice(0, 16);
    return join(fallbackDir, `${digest}.sock`);
}
/** Local IPC issuance proof only: this callback/error never enters the envelope or certifies a remote API effect. */
export class TelegramBusLocalAuthorityError extends Error {
    requestIssued;
    constructor(requestIssued, reason) {
        super(reason
            ? `Telegram bus local authority is unavailable: ${reason}`
            : "Telegram bus local authority is unavailable.");
        this.name = "TelegramBusLocalAuthorityError";
        this.requestIssued = requestIssued;
    }
}
/** Origin-local proof only; never serialized as a remote execution grant. */
export class TelegramBusArtifactIpcError extends Error {
    requestIssued;
    constructor(requestIssued, cause) {
        super("Artifact IPC operation did not complete.", { cause });
        this.name = "TelegramBusArtifactIpcError";
        this.requestIssued = requestIssued;
    }
}
export function isTelegramBusForwardOwnershipCurrent(expected, current) {
    return Boolean(current &&
        current.instanceId === expected.instanceId &&
        current.ownerGeneration === expected.ownerGeneration &&
        current.recipientBindingKey === expected.recipientBindingKey &&
        JSON.stringify(current.protocolIdentity) ===
            JSON.stringify(expected.protocolIdentity));
}
function getTelegramBusForwardSourceUpdateId(value) {
    if (!isRecord(value))
        return undefined;
    const updateId = value.pi_telegram_source_update_id;
    return Number.isSafeInteger(updateId) && updateId >= 0
        ? updateId
        : undefined;
}
function createTelegramBusForwardDelivery(kind, sourceUpdateId, recipientBindingKey) {
    return createTelegramBusFollowerDeliveryIdentity({
        kind,
        recipientBindingKey,
        sourceUpdateId,
    });
}
/**
 * Leader-to-follower forwards and control replies share the stale-liveness window: a follower doing journal work or stalled
 * by an ordinary multi-second Pi/TUI turn, or a slower Windows named pipe, is not a lost recipient.
 */
const TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS = TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS;
export function createTelegramBusForeignOwnedUpdateForwarder(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const reject = (input) => {
        const settlement = {
            status: input.status,
            failureClass: input.failureClass,
            message: input.message,
            ...(input.delivery ? { delivery: input.delivery } : {}),
            ...(input.sourceUpdateId !== undefined
                ? { sourceUpdateId: input.sourceUpdateId }
                : {}),
        };
        deps.recordRuntimeEvent?.("bus", input.message, {
            phase: "foreign-update-forward-rejected",
            settlement: input.status,
            failureClass: input.failureClass,
            envelopeKind: input.envelopeKind,
            recipientInstanceId: input.ownership.instanceId,
            deliveryId: input.delivery?.deliveryId,
            sourceUpdateId: input.delivery?.sourceUpdateId ?? input.sourceUpdateId,
        });
        return settlement;
    };
    const prepare = (kind, value, ownership) => {
        const sourceUpdateId = getTelegramBusForwardSourceUpdateId(value);
        if (sourceUpdateId === undefined) {
            return {
                settlement: reject({
                    status: "terminal-rejected",
                    failureClass: "source-update-identity-missing",
                    message: "Forwarded Telegram update has no durable source identity.",
                    envelopeKind: kind,
                    ownership,
                }),
            };
        }
        if (!ownership.recipientBindingKey) {
            return {
                settlement: reject({
                    status: "terminal-rejected",
                    failureClass: "recipient-binding-missing",
                    message: "Forwarded Telegram update has no stable recipient binding.",
                    envelopeKind: kind,
                    ownership,
                    sourceUpdateId,
                }),
            };
        }
        const sourceReference = canUseTelegramBusInputCustodyReference({
            local: deps.localProtocolIdentity,
            remote: ownership.protocolIdentity,
        });
        const reference = sourceReference
            ? deps.resolveInputCustodyReference?.({
                sourceUpdateId,
                recipientBindingKey: ownership.recipientBindingKey,
            })
            : undefined;
        if (sourceReference && !reference)
            return {
                settlement: reject({
                    status: "retryable",
                    failureClass: "source-reference-missing",
                    message: "Forwarded Telegram update has no exact custody reference.",
                    envelopeKind: kind,
                    ownership,
                    sourceUpdateId,
                }),
            };
        const delivery = reference
            ? createTelegramBusFollowerSourceReferenceDeliveryIdentity({
                kind: "leader.wakeInputCustody",
                recipientBindingKey: ownership.recipientBindingKey,
                sourceRecoveryKey: reference.sourceRecoveryKey,
                source: reference.source,
            })
            : createTelegramBusForwardDelivery(kind, sourceUpdateId, ownership.recipientBindingKey);
        if (!ownership.ownerGeneration) {
            return {
                settlement: reject({
                    status: "retryable",
                    failureClass: "recipient-generation-missing",
                    message: "Forwarded Telegram update has no live recipient generation.",
                    envelopeKind: kind,
                    ownership,
                    delivery,
                }),
            };
        }
        return {
            delivery,
            recipientRegistrationGeneration: ownership.ownerGeneration,
            sourceReference,
        };
    };
    const send = async (envelope, ownership, assertAuthority) => {
        if (deps.validateForwardOwnership &&
            !deps.validateForwardOwnership(ownership))
            return reject({
                status: "retryable",
                failureClass: "recipient-ownership-stale",
                message: "Telegram follower ownership changed before forwarding.",
                envelopeKind: envelope.kind,
                ownership,
                delivery: envelope.delivery,
            });
        if (deps.getAuthSecret)
            envelope.auth = deps.getAuthSecret();
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        let response;
        try {
            response = await sendTelegramBusLocalEnvelope({
                socketPath,
                envelope,
                timeoutMs: deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS,
                retry: assertAuthority ? { attempts: 1, delayMs: 0 } : getTelegramBusTransportRetryPolicy({
                    endpoint: socketPath,
                    operation: "operation",
                }),
                ...(assertAuthority || deps.validateForwardOwnership ? { assertAuthority() {
                        assertAuthority?.();
                        if (deps.validateForwardOwnership && !deps.validateForwardOwnership(ownership))
                            throw new Error("Telegram follower forwarding ownership changed.");
                    } } : {}),
            });
        }
        catch (error) {
            return reject({
                status: "retryable",
                failureClass: "transport-failed",
                message: error instanceof Error
                    ? error.message
                    : "Telegram follower forwarding transport failed.",
                envelopeKind: envelope.kind,
                ownership,
                delivery: envelope.delivery,
            });
        }
        if (response?.kind !== "bus.ack") {
            return reject({
                status: "retryable",
                failureClass: "acknowledgement-missing",
                message: "Follower returned no forwarding acknowledgement.",
                envelopeKind: envelope.kind,
                ownership,
                delivery: envelope.delivery,
            });
        }
        if (response.requestId !== envelope.requestId) {
            return reject({
                status: "terminal-rejected",
                failureClass: "acknowledgement-mismatched",
                message: "Follower returned a mismatched forwarding acknowledgement.",
                envelopeKind: envelope.kind,
                ownership,
                delivery: envelope.delivery,
            });
        }
        if (!response.ok) {
            return reject({
                status: "retryable",
                failureClass: "acknowledgement-rejected",
                message: response.message ?? "Follower rejected forwarded Telegram update.",
                envelopeKind: envelope.kind,
                ownership,
                delivery: envelope.delivery,
            });
        }
        const receipt = response.result;
        if (!isRecord(receipt) ||
            typeof receipt.deliveryId !== "string" ||
            !Number.isSafeInteger(receipt.sourceUpdateId)) {
            return reject({
                status: "terminal-rejected",
                failureClass: "durable-receipt-missing",
                message: "Follower acknowledgement omitted the durable receipt.",
                envelopeKind: envelope.kind,
                ownership,
                delivery: envelope.delivery,
            });
        }
        if (receipt.deliveryId !== envelope.delivery.deliveryId ||
            receipt.sourceUpdateId !== envelope.delivery.sourceUpdateId) {
            return reject({
                status: "terminal-rejected",
                failureClass: "durable-receipt-mismatched",
                message: "Follower acknowledgement returned a mismatched durable receipt.",
                envelopeKind: envelope.kind,
                ownership,
                delivery: envelope.delivery,
            });
        }
        return { status: "accepted", delivery: envelope.delivery };
    };
    // A recipient already holding the source reference is only woken; it never receives a second payload copy.
    const forward = (kind, value, ownership, build, assertAuthority) => {
        const prepared = prepare(kind, value, ownership);
        if ("settlement" in prepared)
            return Promise.resolve(prepared.settlement);
        const base = {
            requestId: deps.createRequestId(),
            recipientInstanceId: ownership.instanceId,
            recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
            delivery: prepared.delivery,
        };
        return send(prepared.sourceReference
            ? { kind: "leader.wakeInputCustody", ...base, sentAtMs: getNowMs() }
            : build(base, getNowMs()), ownership, assertAuthority);
    };
    return {
        forwardCallback: ({ query, ownership }) => forward("leader.forwardCallback", query, ownership, (base, sentAtMs) => ({
            kind: "leader.forwardCallback",
            ...base,
            query,
            sentAtMs,
        })),
        forwardReaction: ({ reactionUpdate, ownership }) => forward("leader.forwardReaction", reactionUpdate, ownership, (base, sentAtMs) => ({
            kind: "leader.forwardReaction",
            ...base,
            reactionUpdate,
            sentAtMs,
        })),
        forwardMessage: ({ message, ownership, assertAuthority }) => forward("leader.forwardMessage", message, ownership, (base, sentAtMs) => {
            const forwardCommentBatchPosition = deps.getForwardCommentBatchPosition?.(message);
            return {
                kind: "leader.forwardMessage",
                ...base,
                message,
                ...(forwardCommentBatchPosition !== undefined
                    ? { forwardCommentBatchPosition }
                    : {}),
                sentAtMs,
            };
        }, assertAuthority),
        forwardEditedMessage: ({ message, ownership }) => forward("leader.forwardEditedMessage", message, ownership, (base, sentAtMs) => ({
            kind: "leader.forwardEditedMessage",
            ...base,
            message,
            sentAtMs,
        })),
    };
}
export function listTelegramBusLiveThreadTargets(input) {
    const targets = [];
    if (input.leaderTarget?.threadId !== undefined) {
        targets.push(input.leaderTarget);
    }
    for (const follower of input.followers) {
        if (follower.target?.threadId !== undefined)
            targets.push(follower.target);
    }
    return targets;
}
/** Caller owns the durable one-shot apply grant. Inspections never grant another apply. */
export function createTelegramBusWorkspaceRestoreController(deps) {
    return async (input) => {
        const isCurrent = input.isCurrent.bind(input);
        if (!isCurrent())
            return undefined;
        const follower = deps.getFollower(input.instanceId);
        const secret = deps.getAuthSecret();
        if (!secret ||
            !follower?.registrationGeneration ||
            !follower.busSocketPath ||
            follower.sessionId !== input.sessionId ||
            follower.slot !== input.slot ||
            !hasTelegramBusSharedCapabilities(deps.localProtocolIdentity, follower.protocol, [TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE]))
            return undefined;
        const captured = structuredClone(follower);
        const expected = {
            operationId: input.operationId,
            sessionId: input.sessionId,
            slot: input.slot,
            target: { ...input.target },
            oldTarget: { ...input.oldTarget },
            mode: input.mode,
        };
        const current = () => {
            if (!isCurrent() ||
                deps.getAuthSecret() !== secret ||
                !hasTelegramBusCapability(deps.localProtocolIdentity, TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE))
                return false;
            const live = deps.getFollower(captured.instanceId);
            return (!!live &&
                live.registrationGeneration === captured.registrationGeneration &&
                live.sessionId === captured.sessionId &&
                live.cwd === captured.cwd &&
                live.slot === captured.slot &&
                live.busSocketPath === captured.busSocketPath &&
                live.target?.chatId === captured.target?.chatId &&
                live.target?.threadId === captured.target?.threadId &&
                hasTelegramBusCapability(live.protocol, TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE) &&
                getTelegramBusProtocolCompatibility({
                    local: deps.localProtocolIdentity,
                    remote: live.protocol,
                }).compatible);
        };
        if (!current())
            return undefined;
        const requestId = deps.createRequestId();
        const response = await sendTelegramBusLocalEnvelope({
            socketPath: captured.busSocketPath,
            timeoutMs: deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS,
            retry: { attempts: 1, delayMs: 0 },
            envelope: {
                kind: "leader.workspaceRestore",
                requestId,
                recipientInstanceId: captured.instanceId,
                recipientRegistrationGeneration: captured.registrationGeneration,
                operationId: expected.operationId,
                mode: expected.mode,
                auth: secret,
                sentAtMs: Date.now(),
            },
        });
        if (!current() ||
            response?.kind !== "bus.ack" ||
            response.requestId !== requestId ||
            response.ok !== true ||
            !response.result ||
            typeof response.result !== "object")
            return undefined;
        const result = response.result;
        const recipient = result.recipient;
        const target = parseThreadTarget(result.target);
        const wanted = result.ready === true ? expected.target : expected.oldTarget;
        if (result.operationId !== expected.operationId ||
            typeof result.ready !== "boolean" ||
            result.slot !== expected.slot ||
            !target ||
            target.chatId !== wanted.chatId ||
            target.threadId !== wanted.threadId ||
            recipient?.kind !== "follower" ||
            recipient.instanceId !== captured.instanceId ||
            recipient.sessionId !== expected.sessionId ||
            recipient.generation !== captured.registrationGeneration)
            return undefined;
        return {
            operationId: expected.operationId,
            recipient: {
                kind: "follower",
                instanceId: captured.instanceId,
                sessionId: expected.sessionId,
                generation: captured.registrationGeneration,
            },
            target,
            slot: expected.slot,
            ready: result.ready,
        };
    };
}
/** Each capability has its own effect boundary; transport retries never replay save/dispatch/disposal. */
export function createTelegramBusLiveRebindController(deps) {
    return async (input) => {
        const isCurrent = input.isCurrent.bind(input), localProtocol = structuredClone(deps.localProtocolIdentity);
        const selectedCommand = parseSelectedCommandInput(input.selectedCommand), held = selectedCommand, preparedSource = parsePreparedCommandSource(input.preparedSource);
        if (!hasOnlyWireKeys(input, [
            "operationId",
            "instanceId",
            "sessionId",
            "recipientBindingKey",
            "isCurrent",
            "selectedCommand",
            "preparedSource",
            "updates",
            "mode",
            "sourceUpdateIds",
            "slot",
            "target",
            "oldTarget",
        ]) ||
            ("mode" in input &&
                (![
                    "apply",
                    "inspect",
                    "release",
                    "discard",
                    "observe",
                    "observe-held",
                    "observe-command",
                ].includes(input.mode) ||
                    (input.mode === "observe-command" && !selectedCommand))))
            return undefined;
        if ((input.preparedSource !== undefined &&
            (!held ||
                !preparedSource ||
                preparedSource.journalBindingKey !== input.recipientBindingKey ||
                preparedSource.updateId !==
                    ("mode" in input
                        ? input.sourceUpdateIds[0]
                        : input.updates[0]?.update_id))) ||
            (held && "mode" in input && !preparedSource))
            return undefined;
        if (input.selectedCommand !== undefined &&
            (!held ||
                ("mode" in input
                    ? input.sourceUpdateIds.length !== 1 ||
                        !areTelegramTargetsEqual(input.target, held.target)
                    : input.updates.length !== 1)))
            return undefined;
        const marker = selectedCommand ? { selectedCommand } : {};
        const expected = structuredClone({
            operationId: input.operationId,
            instanceId: input.instanceId,
            sessionId: input.sessionId,
            recipientBindingKey: input.recipientBindingKey,
            ...(held
                ? { ...marker, ...(preparedSource ? { preparedSource } : {}) }
                : {}),
            ...("mode" in input
                ? {
                    mode: input.mode,
                    sourceUpdateIds: input.sourceUpdateIds,
                    slot: input.slot,
                    target: input.target,
                    oldTarget: input.oldTarget,
                }
                : { updates: input.updates }),
        });
        const observing = "mode" in expected && (expected.mode === "observe" || expected.mode === "observe-held");
        const observingHeld = "mode" in expected && expected.mode === "observe-held";
        const commandObserving = "mode" in expected && expected.mode === "observe-command";
        const settling = "mode" in expected &&
            (expected.mode === "release" ||
                expected.mode === "discard" ||
                observing ||
                commandObserving);
        const required = [
            TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SAVE,
            ...("mode" in expected || held
                ? [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_APPLY]
                : []),
            ...(settling || held ? [TELEGRAM_BUS_CAPABILITY_LIVE_REBIND_SETTLE] : []),
            ...(observingHeld ? [TELEGRAM_BUS_CAPABILITY_PRE_DISPATCH_REBIND_EXECUTION] : []),
            ...(held ? getTelegramBusHeldCommandCapabilities(held.name) : []),
        ];
        const follower = deps.getFollower(expected.instanceId), secret = deps.getAuthSecret();
        if (!isCurrent() ||
            !secret ||
            !follower?.registrationGeneration ||
            !follower.busSocketPath ||
            follower.sessionId !== expected.sessionId ||
            !hasTelegramBusSharedCapabilities(deps.localProtocolIdentity, follower.protocol, required))
            return undefined;
        const captured = structuredClone(follower);
        /** The first failed authority condition, by fixed label; undefined while the captured recipient is current. */
        const staleReason = () => {
            if (!isCurrent())
                return "caller authority";
            if (deps.getAuthSecret() !== secret)
                return "auth secret";
            if (!isDeepStrictEqual(deps.localProtocolIdentity, localProtocol) ||
                !required.every((cap) => hasTelegramBusCapability(deps.localProtocolIdentity, cap)))
                return "local protocol";
            const live = deps.getFollower(expected.instanceId);
            if (!live)
                return "follower registration";
            if (live.sessionId !== captured.sessionId ||
                live.registrationGeneration !== captured.registrationGeneration ||
                live.sessionGeneration !== captured.sessionGeneration)
                return "follower generation";
            if (live.pid !== captured.pid ||
                live.processBirthId !== captured.processBirthId)
                return "follower process";
            if (live.busSocketPath !== captured.busSocketPath ||
                live.slot !== captured.slot ||
                live.cwd !== captured.cwd)
                return "follower endpoint";
            if ("mode" in expected
                ? live.slot !== expected.slot ||
                    !live.target ||
                    (!areTelegramTargetsEqual(live.target, expected.target) &&
                        !areTelegramTargetsEqual(live.target, expected.oldTarget))
                : !isDeepStrictEqual(live.target, captured.target))
                return "follower target";
            if (!required.every((cap) => hasTelegramBusCapability(live.protocol, cap)) ||
                !isDeepStrictEqual(live.protocol, captured.protocol) ||
                !getTelegramBusProtocolCompatibility({
                    local: deps.localProtocolIdentity,
                    remote: live.protocol,
                }).compatible)
                return "follower protocol";
            return undefined;
        };
        const current = () => staleReason() === undefined;
        if (!current())
            return undefined;
        const requestId = deps.createRequestId();
        const response = await sendTelegramBusLocalEnvelope({
            socketPath: captured.busSocketPath,
            timeoutMs: deps.timeoutMs ?? TELEGRAM_BUS_FOLLOWER_CONTROL_TIMEOUT_MS,
            retry: { attempts: 1, delayMs: 0 },
            ...(held
                ? {
                    assertAuthority: () => {
                        const reason = staleReason();
                        if (reason)
                            throw new Error(`Selected held input sender authority changed (${reason}).`);
                    },
                }
                : {}),
            envelope: {
                requestId,
                auth: secret,
                ...(held
                    ? {
                        ...marker,
                        ...("mode" in expected
                            ? { preparedSource: expected.preparedSource }
                            : {}),
                    }
                    : {}),
                recipientInstanceId: expected.instanceId,
                recipientRegistrationGeneration: captured.registrationGeneration,
                recipientSessionId: expected.sessionId,
                recipientBindingKey: expected.recipientBindingKey,
                operationId: expected.operationId,
                sentAtMs: Date.now(),
                ...("mode" in expected
                    ? settling
                        ? {
                            kind: "leader.settleLiveRebind",
                            mode: expected.mode,
                            sourceUpdateIds: expected.sourceUpdateIds,
                            ...(observing ? { oldTarget: expected.oldTarget } : {}),
                        }
                        : {
                            kind: "leader.applyLiveRebind",
                            mode: expected.mode,
                            sourceUpdateIds: expected.sourceUpdateIds,
                        }
                    : {
                        kind: "leader.prepareLiveRebind",
                        updates: expected.updates,
                    }),
            },
        });
        if (!current() ||
            response?.kind !== "bus.ack" ||
            response.requestId !== requestId ||
            response.ok !== true ||
            !isRecord(response.result))
            return undefined;
        const result = response.result, recipient = result.recipient;
        if (!hasOnlyWireKeys(result, [
            "operationId",
            "recipient",
            "sourceUpdateIds",
            "selectedCommand",
            "preparedSource",
            "status",
            "command",
            "sourceAck",
            "target",
            "slot",
            "action",
            "oldTarget",
            "work",
        ]))
            return undefined;
        if (selectedCommand
            ? !isDeepStrictEqual(parseSelectedCommandInput(result.selectedCommand), selectedCommand)
            : Object.hasOwn(result, "selectedCommand"))
            return undefined;
        const ids = ("mode" in expected
            ? [...expected.sourceUpdateIds]
            : expected.updates.map((update) => update.update_id)).sort((a, b) => a - b);
        const observedSource = parsePreparedCommandSource(result.preparedSource);
        if (held
            ? !observedSource ||
                observedSource.updateId !== ids[0] ||
                observedSource.journalBindingKey !== expected.recipientBindingKey ||
                (expected.preparedSource &&
                    !isDeepStrictEqual(observedSource, expected.preparedSource))
            : Object.hasOwn(result, "preparedSource"))
            return undefined;
        if (result.operationId !== expected.operationId ||
            !(commandObserving
                ? result.status === "command-observed"
                : observing
                    ? result.status === "observed"
                    : settling
                        ? result.status === "protected" ||
                            result.status === "unknown" ||
                            result.status ===
                                (expected.mode === "release" ? "released" : "discarded")
                        : "mode" in expected
                            ? result.status === "saved" || result.status === "applied"
                            : result.status === "saved") ||
            !isRecord(recipient) ||
            recipient.instanceId !== expected.instanceId ||
            recipient.sessionId !== expected.sessionId ||
            recipient.generation !== captured.registrationGeneration ||
            recipient.bindingKey !== expected.recipientBindingKey ||
            !Array.isArray(result.sourceUpdateIds) ||
            result.sourceUpdateIds.length !== ids.length ||
            result.sourceUpdateIds.some((id, index) => id !== ids[index]))
            return undefined;
        const observation = {
            operationId: expected.operationId,
            recipient: {
                instanceId: expected.instanceId,
                sessionId: expected.sessionId,
                generation: captured.registrationGeneration,
                bindingKey: expected.recipientBindingKey,
            },
            sourceUpdateIds: ids,
            ...(held
                ? { ...structuredClone(marker), preparedSource: { ...observedSource } }
                : {}),
            status: "saved",
        };
        if (!("mode" in expected))
            return observation;
        if (commandObserving) {
            const sourceAck = parsePreparedCommandSource(result.sourceAck);
            if (!hasOnlyWireKeys(result, [
                "operationId",
                "recipient",
                "sourceUpdateIds",
                "selectedCommand",
                "preparedSource",
                "status",
                "command",
                "sourceAck",
            ]) ||
                !hasOnlyWireKeys(recipient, [
                    "instanceId",
                    "sessionId",
                    "generation",
                    "bindingKey",
                ]) ||
                !["completed", "unknown", "not-issued"].includes(result.command) ||
                (Object.hasOwn(result, "sourceAck") &&
                    (!sourceAck ||
                        !isDeepStrictEqual(sourceAck, expected.preparedSource) ||
                        result.command === "not-issued")))
                return undefined;
            const settled = {
                command: result.command,
                ...(sourceAck ? { sourceAck: { ...sourceAck } } : {}),
            };
            return {
                ...observation,
                status: "command-observed",
                selectedCommand: structuredClone(selectedCommand),
                preparedSource: { ...observedSource },
                ...settled,
            };
        }
        if (observing) {
            const work = result.work, oldTarget = parseThreadTarget(result.oldTarget);
            if (!oldTarget ||
                !isDeepStrictEqual(oldTarget, expected.oldTarget) ||
                !isRecord(work) ||
                [
                    work.sessionBusy,
                    work.targetWork,
                    work.deliveryPending,
                    work.unknown,
                ].some((flag) => typeof flag !== "boolean"))
                return undefined;
            return {
                ...observation,
                status: "observed",
                oldTarget,
                work: {
                    sessionBusy: work.sessionBusy,
                    targetWork: work.targetWork,
                    deliveryPending: work.deliveryPending,
                    unknown: work.unknown,
                },
            };
        }
        if (settling) {
            if (result.action !== expected.mode)
                return undefined;
            return {
                ...observation,
                action: expected.mode,
                status: result.status,
            };
        }
        const target = parseThreadTarget(result.target), wanted = result.status === "applied" ? expected.target : expected.oldTarget;
        if (!target ||
            !isDeepStrictEqual(target, wanted) ||
            result.slot !== expected.slot)
            return undefined;
        return {
            ...observation,
            status: result.status,
            target,
            slot: expected.slot,
        };
    };
}
export function isTelegramBusEnvelopeAuthorized(envelope, secret) {
    if (!secret)
        return true;
    if (typeof envelope.auth !== "string")
        return false;
    const auth = Buffer.from(envelope.auth);
    const expected = Buffer.from(secret);
    return auth.length === expected.length && timingSafeEqual(auth, expected);
}
/** Negative acknowledgement carrying only a diagnostic message. */
export const TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE = "Telegram bus API call is not allowed for this follower.";
export function rejectTelegramBusRequest(requestId, message) {
    return { kind: "bus.ack", requestId, ok: false, message };
}
export function createUnauthorizedBusAck(requestId) {
    return rejectTelegramBusRequest(requestId, "Unauthorized Telegram bus envelope.");
}
export function createTelegramBusLocalServer(deps) {
    const requestLedger = new Map();
    const requestLedgerMaxEntries = Math.max(1, deps.requestLedgerMaxEntries ?? 4096);
    const getRequestLedgerKey = (envelope) => {
        const identity = envelope.kind === "follower.register" ||
            envelope.kind === "follower.restoreWorkspace"
            ? envelope.registration.instanceId
            : "instanceId" in envelope
                ? envelope.instanceId
                : "recipientInstanceId" in envelope
                    ? envelope.recipientInstanceId
                    : "ack";
        return `${envelope.auth ?? ""}:${identity}:${envelope.requestId}`;
    };
    const handleEnvelopeOnce = (envelope) => {
        const artifact = envelope.kind === "follower.callApi" && envelope.method === "sendArtifactDocument";
        const artifactGuard = artifact ? deps.captureArtifactAuthority?.(envelope) : undefined;
        const refused = () => rejectTelegramBusRequest(envelope.requestId, "Artifact authority is unavailable.");
        if (artifact && !artifactGuard?.())
            return Promise.resolve(refused());
        const release = (result) => artifact
            ? result.then(value => artifactGuard?.() ? value : refused()) : result;
        const rawKey = getRequestLedgerKey(envelope);
        const key = artifact ? Buffer.from(rawKey, "utf8").toString("utf8") : rawKey;
        const fingerprint = artifact ? createHash("sha256").update(JSON.stringify(envelope)).digest("hex") : JSON.stringify(envelope);
        const existing = requestLedger.get(key);
        if (existing) {
            if (existing.fingerprint === fingerprint) {
                if (artifact && !existing.artifactGuard?.())
                    return Promise.resolve(refused());
                return release(artifact ? existing.result.then(value => existing.artifactGuard?.() ? value : refused()) : existing.result);
            }
            return Promise.resolve({
                kind: "bus.ack",
                requestId: envelope.requestId,
                ok: false,
                message: "Telegram bus request id was reused with a different payload.",
                error: { code: "request-id-collision" },
            });
        }
        if (requestLedger.size >= requestLedgerMaxEntries) {
            const settledKey = Array.from(requestLedger.entries()).find(([, entry]) => entry.settled)?.[0];
            if (settledKey)
                requestLedger.delete(settledKey);
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
        const entry = {
            fingerprint,
            ...(artifactGuard ? { artifactGuard } : {}),
            settled: false,
            result: artifact
                ? Promise.resolve().then(() => deps.handleEnvelope(envelope)).catch(() => rejectTelegramBusRequest(Buffer.from(envelope.requestId, "utf8").toString("utf8"), "Artifact operation outcome is unconfirmed."))
                : Promise.resolve().then(() => deps.handleEnvelope(envelope)),
        };
        requestLedger.set(key, entry);
        const settled = () => {
            entry.settled = true;
        };
        void entry.result.then(settled, settled);
        return release(entry.result);
    };
    let server;
    let activeSocketPath;
    let activeListenPath;
    let endpointRecovery;
    let stopGeneration = 0;
    const sockets = new Set();
    const closeSocket = (socket) => {
        sockets.delete(socket);
        socket.destroy();
    };
    const runtime = {
        start: async () => {
            if (server)
                return;
            const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
            const activeServers = getActiveTelegramBusLocalServers();
            const replacedServer = activeServers.get(socketPath);
            if (replacedServer && replacedServer !== runtime) {
                await replacedServer.stop();
            }
            const usesWindowsPipe = isTelegramBusPipePath(socketPath);
            const endpointGeneration = randomBytes(8).toString("hex");
            const listenPath = usesWindowsPipe
                ? socketPath
                : join(dirname(socketPath), `.pt-${endpointGeneration}.sock`);
            activeSocketPath = socketPath;
            activeListenPath = listenPath;
            deps.recordTransportEvent?.("server-start", getTelegramBusEndpointDiagnostics(socketPath));
            if (!usesWindowsPipe) {
                const socketDir = dirname(socketPath);
                mkdirSync(socketDir, { recursive: true, mode: 0o700 });
                chmodSync(socketDir, 0o700);
                if (existsSync(listenPath))
                    unlinkSync(listenPath);
                const legacyDeadlineMs = Date.now() + 2000;
                while (true) {
                    let isLegacySocket = false;
                    try {
                        isLegacySocket = lstatSync(socketPath).isSocket();
                    }
                    catch {
                        /* endpoint does not exist */
                    }
                    if (!isLegacySocket)
                        break;
                    const probe = await probeTelegramBusEndpoint({
                        endpoint: socketPath,
                        timeoutMs: 50,
                    });
                    if (!probe.reachable)
                        break;
                    if (Date.now() >= legacyDeadlineMs) {
                        throw new Error(`Timed out waiting for legacy Telegram bus endpoint: ${socketPath}`);
                    }
                    await delayTelegramBusTransportRetry(25);
                }
            }
            if (usesWindowsPipe) {
                await deps.beforeEndpointPublication?.();
                const committed = deps.commitEndpointPublication
                    ? deps.commitEndpointPublication(() => { })
                    : true;
                if (!committed) {
                    activeSocketPath = undefined;
                    activeListenPath = undefined;
                    throw new Error("Telegram bus endpoint publication lost transport ownership.");
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
                        void handleTelegramBusSocketLine(line, socket, handleEnvelopeOnce, deps.recordTransportEvent, socketPath, deps.shouldDropResponse);
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
                await new Promise((resolve, reject) => {
                    server?.once("error", reject);
                    server?.listen(listenPath, resolve);
                });
                activeServers.set(socketPath, runtime);
                deps.recordTransportEvent?.("server-started", getTelegramBusEndpointDiagnostics(socketPath));
            }
            catch (error) {
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
                        ? deps.commitEndpointPublication(() => renameSync(linkPath, socketPath))
                        : (renameSync(linkPath, socketPath), true);
                    if (!committed) {
                        throw new Error("Telegram bus endpoint publication lost transport ownership.");
                    }
                }
                catch (error) {
                    try {
                        if (lstatSync(linkPath).isSymbolicLink())
                            unlinkSync(linkPath);
                    }
                    catch {
                        /* no unpublished link to remove */
                    }
                    const failedServer = server;
                    server = undefined;
                    activeSocketPath = undefined;
                    activeListenPath = undefined;
                    if (activeServers.get(socketPath) === runtime) {
                        activeServers.delete(socketPath);
                    }
                    if (failedServer) {
                        await new Promise((resolve) => failedServer.close(() => resolve()));
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
            if (socketPath &&
                getActiveTelegramBusLocalServers().get(socketPath) === runtime) {
                getActiveTelegramBusLocalServers().delete(socketPath);
            }
            server = undefined;
            activeSocketPath = undefined;
            activeListenPath = undefined;
            for (const socket of sockets)
                closeSocket(socket);
            if (activeServer) {
                await new Promise((resolve) => activeServer.close(() => resolve()));
            }
            if (socketPath && listenPath && !isTelegramBusPipePath(socketPath)) {
                try {
                    if (lstatSync(socketPath).isSymbolicLink() &&
                        readlinkSync(socketPath) === basename(listenPath)) {
                        // Leave the generation link in place. Node removes only the unique
                        // listen path on close; a later generation atomically replaces this
                        // link, and existsSync() treats the stopped dangling link as missing.
                    }
                }
                catch {
                    /* endpoint already moved or removed */
                }
            }
            if (socketPath) {
                deps.recordTransportEvent?.("server-stopped", getTelegramBusEndpointDiagnostics(socketPath));
            }
        },
        ensureEndpoint: async () => {
            const socketPath = activeSocketPath;
            if (!server ||
                !socketPath ||
                isTelegramBusPipePath(socketPath) ||
                existsSync(socketPath)) {
                return false;
            }
            if (endpointRecovery)
                return endpointRecovery;
            endpointRecovery = (async () => {
                deps.recordTransportEvent?.("server-endpoint-missing", getTelegramBusEndpointDiagnostics(socketPath));
                const recoveryStopGeneration = stopGeneration + 1;
                await runtime.stop();
                if (stopGeneration !== recoveryStopGeneration)
                    return false;
                await runtime.start();
                if (stopGeneration !== recoveryStopGeneration) {
                    await runtime.stop();
                    return false;
                }
                deps.recordTransportEvent?.("server-endpoint-recovered", getTelegramBusEndpointDiagnostics(socketPath));
                return true;
            })();
            try {
                return await endpointRecovery;
            }
            finally {
                endpointRecovery = undefined;
            }
        },
    };
    return runtime;
}
function getTelegramBusEnvelopeDiagnostics(envelope) {
    return {
        envelopeKind: envelope.kind,
        requestId: envelope.requestId,
    };
}
function sendTelegramBusLocalEnvelopeOnce(options) {
    const timeoutMs = options.timeoutMs ?? 1000;
    return new Promise((resolve, reject) => {
        const assertAuthority = options.assertAuthority;
        let issued = false;
        const assertCurrent = () => {
            try {
                assertAuthority?.();
            }
            catch (error) {
                // The caller's reason is a fixed condition label, never request or credential content.
                throw new TelegramBusLocalAuthorityError(issued, error instanceof Error ? error.message : undefined);
            }
        };
        try {
            assertCurrent();
        }
        catch (error) {
            reject(error);
            return;
        }
        const socket = createConnection(options.socketPath);
        let settled = false;
        let buffer = "";
        let timeoutFinalizer;
        const settle = (callback) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (timeoutFinalizer)
                clearImmediate(timeoutFinalizer);
            socket.destroy();
            callback();
        };
        const timeout = setTimeout(() => {
            // A long synchronous Pi/TUI turn can resume in the timers phase after
            // the peer acknowledgement is already buffered. Give pending socket I/O
            // two poll phases before converting elapsed wall time into a transport
            // failure; Darwin can surface buffered Unix-socket input only on the
            // second cycle after a long stall, while a silent peer stays bounded.
            timeoutFinalizer = setImmediate(() => {
                timeoutFinalizer = setImmediate(() => {
                    settle(() => reject(createTelegramBusTransportTimeoutError("Timed out waiting for Telegram bus response")));
                });
            });
        }, timeoutMs);
        socket.setEncoding("utf8");
        socket.once("connect", () => {
            try {
                assertCurrent();
                const encoded = encodeTelegramBusEnvelope(options.envelope);
                assertCurrent();
                issued = true;
                options.onRequestIssued?.();
                socket.write(encoded);
            }
            catch (error) {
                settle(() => reject(error));
            }
        });
        socket.on("data", (chunk) => {
            buffer += chunk;
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex < 0)
                return;
            const line = buffer.slice(0, newlineIndex);
            try {
                const response = parseTelegramBusEnvelope(line);
                assertCurrent();
                settle(() => resolve(response));
            }
            catch (error) {
                settle(() => reject(error));
            }
        });
        socket.once("error", (error) => settle(() => reject(error)));
        socket.once("end", () => settle(() => resolve(undefined)));
    });
}
export async function sendTelegramBusLocalEnvelope(options) {
    const resolvedOptions = {
        ...options,
        socketPath: resolveTelegramBusSocketPath(options.socketPath),
    };
    const attempts = Math.max(1, resolvedOptions.retry?.attempts ?? 1);
    const delayMs = Math.max(0, resolvedOptions.retry?.delayMs ?? 0);
    // Log the first failure, then only the outcome: a reloading leader would otherwise log every attempt.
    for (let attempt = 1;; attempt += 1) {
        try {
            const response = await sendTelegramBusLocalEnvelopeOnce(resolvedOptions);
            if (attempt > 1)
                resolvedOptions.recordTransportEvent?.("client-recovered", {
                    ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
                    ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
                    attempt,
                    attempts,
                });
            return response;
        }
        catch (error) {
            const info = classifyTelegramBusTransportError(error);
            const final = error instanceof TelegramBusLocalAuthorityError ||
                attempt >= attempts ||
                !isRetryableTelegramBusTransportError(error);
            if (attempt === 1 || final)
                resolvedOptions.recordTransportEvent?.("client-failed", {
                    ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
                    ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
                    attempt,
                    attempts,
                    ...info,
                });
            if (final)
                throw error;
            if (attempt === 1)
                resolvedOptions.recordTransportEvent?.("client-retry", {
                    ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
                    ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
                    attempt,
                    attempts,
                    delayMs,
                    ...info,
                });
            await delayTelegramBusTransportRetry(delayMs);
        }
    }
}
/** Ordinary guarded call authority only; neither question membership nor Input receiver readiness. */
export const TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY = "guarded-api-authority-v1";
/** Existing registry incarnation, acknowledged independently of Artifact and matched by guarded API calls. */
export const TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY = "api-registration-authority-v1";
/** Private publication contract only; never add to production advertisement before input privacy readiness. */
export const TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION = "attachment-original-publication-v1";
export const TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT = "__piTelegramAttachmentPublication";
/** Private decoded-data evidence, not a receiver, source submission or business grant. */
export function parseTelegramBusAttachmentPublicationReceipt(raw) {
    if (!isRecord(raw) || Object.keys(raw).length !== 9 || Object.keys(raw).some(key => !["version", "requestId", "nonce", "instanceId", "registrationGeneration", "registrationIncarnation", "botId", "messageId", "target"].includes(key)) || raw.version !== 1 ||
        [raw.requestId, raw.instanceId, raw.registrationGeneration].some(value => typeof value !== "string" || !value.trim() ||
            value !== value.trim() || value.length > 512 || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) ||
        typeof raw.registrationIncarnation !== "string" || !/^[a-f0-9]{48}$/u.test(raw.registrationIncarnation) ||
        typeof raw.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(raw.nonce) || !Number.isSafeInteger(raw.botId) || raw.botId <= 0 ||
        !Number.isSafeInteger(raw.messageId) || raw.messageId <= 0 || !isRecord(raw.target) ||
        Object.keys(raw.target).some(key => key !== "chatId" && key !== "threadId") ||
        !Number.isSafeInteger(raw.target.chatId) || raw.target.chatId <= 0 ||
        raw.target.threadId !== undefined && (!Number.isSafeInteger(raw.target.threadId) || raw.target.threadId <= 0))
        return undefined;
    return Object.freeze({ version: 1, requestId: raw.requestId, nonce: raw.nonce, instanceId: raw.instanceId,
        registrationGeneration: raw.registrationGeneration, registrationIncarnation: raw.registrationIncarnation, botId: raw.botId, messageId: raw.messageId,
        target: Object.freeze({ chatId: raw.target.chatId, ...(raw.target.threadId !== undefined ? { threadId: raw.target.threadId } : {}) }) });
}
export const TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT = "artifact-document-v1";
/** Avoid RegExp's process-wide last-input retention for payload-bearing strings. */
function isCanonicalArtifactBase64(encoded, byteLength) {
    if (encoded.length !== 4 * Math.ceil(byteLength / 3))
        return false;
    const padding = (3 - byteLength % 3) % 3, end = encoded.length - padding;
    for (let i = 0; i < end; i++) {
        const c = encoded.charCodeAt(i);
        if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 43 || c === 47))
            return false;
    }
    for (let i = end; i < encoded.length; i++)
        if (encoded.charCodeAt(i) !== 61)
            return false;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    return padding === 0 || (alphabet.indexOf(encoded[end - 1]) & (padding === 2 ? 15 : 3)) === 0;
}
/** Strict bounded wire validation does not decode bytes or grant source/business authority. */
export function parseTelegramBusArtifactDocument(args) {
    if (args.length !== 1)
        return undefined;
    const value = args[0];
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const v = value, t = v.target;
    if (Object.keys(v).some(k => !["version", "registrationIncarnation", "target", "fileName", "byteLength", "bytesBase64", "caption", "expiresAt"].includes(k)) ||
        v.version !== 1 || typeof v.registrationIncarnation !== "string" || !/^[a-f0-9]{48}$/u.test(v.registrationIncarnation) ||
        !t || typeof t !== "object" || Array.isArray(t) || Object.keys(t).some(k => k !== "chatId" && k !== "threadId") ||
        !Number.isSafeInteger(t.chatId) || t.chatId <= 0 ||
        (t.threadId !== undefined && (!Number.isSafeInteger(t.threadId) || t.threadId <= 0)) ||
        !isTelegramArtifactFileName(v.fileName) ||
        !Number.isSafeInteger(v.byteLength) || v.byteLength < 1 || v.byteLength > TELEGRAM_ARTIFACT_MAX_BYTES ||
        typeof v.bytesBase64 !== "string" || !isCanonicalArtifactBase64(v.bytesBase64, v.byteLength) ||
        (v.caption !== undefined && !isTelegramArtifactCaption(v.caption)) ||
        !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= Date.now())
        return undefined;
    return value;
}
export function createTelegramBusForwardOwnershipValidator(registry) {
    return (ownership) => {
        const follower = registry.get(ownership.instanceId);
        return isTelegramBusForwardOwnershipCurrent(ownership, follower?.registrationGeneration &&
            follower.profileKey &&
            follower.protocol
            ? {
                instanceId: follower.instanceId,
                ownerGeneration: follower.registrationGeneration,
                recipientBindingKey: follower.profileKey,
                protocolIdentity: follower.protocol,
            }
            : undefined);
    };
}
function hasTelegramBusFollowerIdentityOverlap(first, second) {
    return (first.instanceId === second.instanceId ||
        (first.profileKey !== undefined &&
            first.profileKey === second.profileKey) ||
        (first.target !== undefined &&
            first.target.chatId === second.target?.chatId &&
            first.target.threadId === second.target.threadId));
}
export function createTelegramBusFollowerRegistry() {
    const followers = new Map();
    let membership = {};
    const observations = new Set();
    const clone = (follower) => ({
        ...follower,
        target: follower.target ? { ...follower.target } : undefined,
        ...(follower.protocol
            ? {
                protocol: {
                    ...follower.protocol,
                    capabilities: [...follower.protocol.capabilities],
                },
            }
            : {}),
    });
    const captureLifetime = (owned) => {
        // Keep owner-created scalars, never a payload-backed registering peer's object.
        const id = owned.instanceId, incarnation = owned.registrationIncarnation;
        let lost = false;
        const current = () => { lost ||= followers.get(id)?.registrationIncarnation !== incarnation; return !lost; };
        return current() ? current : undefined;
    };
    const registry = {
        captureOrphanIntentReaderCompatibility(local, mode = "intent") {
            if (mode !== "intent" && mode !== "cleanup")
                return undefined;
            const required = [TELEGRAM_BUS_CAPABILITY_ORPHAN_INTENT_READER,
                ...(mode === "cleanup" ? [TELEGRAM_BUS_CAPABILITY_ORPHAN_CLEANUP_READER] : [])];
            const born = membership, protocol = structuredClone(local);
            const keys = ["captureOrphanIntentReaderCompatibility", "list", "get", "register", "remove", "clear", "pruneStale"];
            const methods = keys.map(key => registry[key]);
            let lost = false;
            if (required.some(capability => !hasTelegramBusCapability(protocol, capability)) ||
                [...followers.values()].some(row => !row.registrationGeneration ||
                    required.some(capability => !hasTelegramBusCapability(row.protocol, capability))))
                return undefined;
            const current = () => {
                lost ||= membership !== born || !isDeepStrictEqual(local, protocol) || keys.some((key, index) => registry[key] !== methods[index]);
                return !lost;
            };
            return current() ? current : undefined;
        },
        captureRegistration(instanceId, generation) {
            const owned = followers.get(instanceId);
            return owned?.registrationGeneration === generation ? captureLifetime(owned) : undefined;
        },
        captureArtifactRegistration(instanceId, incarnation) {
            const owned = followers.get(instanceId);
            return owned?.registrationIncarnation === incarnation ? captureLifetime(owned) : undefined;
        },
        register: (registration) => {
            membership = {};
            const existing = followers.get(registration.instanceId);
            for (const [instanceId, follower] of followers.entries()) {
                if (instanceId === registration.instanceId)
                    continue;
                if (hasTelegramBusFollowerIdentityOverlap(registration, follower))
                    followers.delete(instanceId);
            }
            const next = {
                ...registration,
                registrationIncarnation: randomBytes(24).toString("hex"),
                target: registration.target ? { ...registration.target } : undefined,
                ...(registration.protocol
                    ? {
                        protocol: {
                            ...registration.protocol,
                            capabilities: [...registration.protocol.capabilities],
                        },
                    }
                    : {}),
                lastHeartbeatMs: existing?.lastHeartbeatMs ?? registration.connectedAtMs,
            };
            followers.set(registration.instanceId, next);
            for (const observation of observations) {
                if (!hasTelegramBusFollowerIdentityOverlap(next, observation.follower))
                    continue;
                observation.current = false;
                observations.delete(observation);
            }
            return clone(next);
        },
        heartbeat: (instanceId, nowMs) => {
            const existing = followers.get(instanceId);
            if (!existing)
                return undefined;
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
                if (follower.target?.chatId === target.chatId &&
                    follower.target.threadId === target.threadId) {
                    return clone(follower);
                }
            }
            return undefined;
        },
        list: () => [...followers.values()].map(clone),
        remove: (instanceId) => {
            const removed = followers.delete(instanceId);
            if (removed)
                membership = {};
            return removed;
        },
        clear: () => {
            if (followers.size)
                membership = {};
            followers.clear();
            for (const observation of observations)
                observation.current = false;
            observations.clear();
        },
        observeUnregistered: (follower) => {
            // This watches replacement, not process death or delivery authority.
            const observation = {
                follower: clone(follower),
                current: ![...followers.values()].some((current) => hasTelegramBusFollowerIdentityOverlap(current, follower)),
            };
            if (observation.current)
                observations.add(observation);
            return {
                isCurrent: () => observation.current,
                release() {
                    observation.current = false;
                    observations.delete(observation);
                },
            };
        },
        pruneStale: (nowMs, staleAfterMs) => {
            const removed = [];
            for (const [instanceId, follower] of followers.entries()) {
                if (nowMs - follower.lastHeartbeatMs <= staleAfterMs)
                    continue;
                followers.delete(instanceId);
                removed.push(clone(follower));
            }
            if (removed.length)
                membership = {};
            return removed;
        },
    };
    return registry;
}
async function handleTelegramBusSocketLine(line, socket, handleEnvelope, recordTransportEvent, socketPath, shouldDropResponse) {
    const envelope = parseTelegramBusEnvelope(line);
    if (!envelope) {
        recordTransportEvent?.("server-invalid-envelope", {
            ...getTelegramBusEndpointDiagnostics(socketPath),
            byteLength: Buffer.byteLength(line),
        });
        socket.write(encodeTelegramBusEnvelope({
            kind: "bus.ack",
            requestId: "invalid",
            ok: false,
            message: "Invalid Telegram bus envelope.",
        }));
        return;
    }
    try {
        const response = await handleEnvelope(envelope);
        if (response && !shouldDropResponse?.(envelope, response)) {
            socket.write(encodeTelegramBusEnvelope(response));
        }
    }
    catch (error) {
        recordTransportEvent?.("server-handler-failed", {
            ...getTelegramBusEndpointDiagnostics(socketPath),
            ...getTelegramBusEnvelopeDiagnostics(envelope),
            ...classifyTelegramBusTransportError(error),
        });
        socket.write(encodeTelegramBusEnvelope(rejectTelegramBusRequest(envelope.requestId, "Telegram bus handler failed.")));
    }
}
function parseRegisterEnvelope(value, requestId, kind) {
    if (value.recoverConnection !== undefined &&
        (kind !== "follower.register" || value.recoverConnection !== true))
        return undefined;
    const registration = parseRegistration(value.registration);
    return registration ? { kind, requestId, registration,
        ...(kind === "follower.register" && value.recoverConnection === true ? { recoverConnection: true } : {}),
    } : undefined;
}
function parseFollowerPresenceEnvelope(value, requestId, kind) {
    return typeof value.instanceId === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind,
            requestId,
            instanceId: value.instanceId,
            ...(typeof value.registrationGeneration === "string"
                ? { registrationGeneration: value.registrationGeneration }
                : {}),
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseRenameThreadEnvelope(value, requestId) {
    const target = parseTarget(value.target);
    return typeof value.instanceId === "string" &&
        typeof value.registrationGeneration === "string" &&
        target?.threadId !== undefined &&
        typeof value.threadName === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind: "follower.renameThread",
            requestId,
            instanceId: value.instanceId,
            registrationGeneration: value.registrationGeneration,
            target: { chatId: target.chatId, threadId: target.threadId },
            threadName: value.threadName,
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseTelegramBusFollowerDeliveryIdentity(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.deliveryId !== "string" ||
        !/^telegram-follower-v1-[a-f0-9]{64}$/u.test(value.deliveryId) ||
        !Number.isSafeInteger(value.sourceUpdateId) ||
        value.sourceUpdateId < 0 ||
        typeof value.recipientBindingKey !== "string" ||
        !value.recipientBindingKey ||
        (value.sourceRecoveryKey !== undefined &&
            (typeof value.sourceRecoveryKey !== "string" ||
                !value.sourceRecoveryKey ||
                value.sourceRecoveryKey.length > 1_024)) ||
        (value.sourceClaim !== undefined &&
            (!isRecord(value.sourceClaim) ||
                typeof value.sourceClaim.acquisitionId !== "string" ||
                !value.sourceClaim.acquisitionId ||
                value.sourceClaim.acquisitionId.length > 256 ||
                typeof value.sourceClaim.handoffId !== "string" ||
                !value.sourceClaim.handoffId ||
                value.sourceClaim.handoffId.length > 256))) {
        return undefined;
    }
    return {
        deliveryId: value.deliveryId,
        sourceUpdateId: value.sourceUpdateId,
        recipientBindingKey: value.recipientBindingKey,
        ...(typeof value.sourceRecoveryKey === "string"
            ? { sourceRecoveryKey: value.sourceRecoveryKey }
            : {}),
        ...(isRecord(value.sourceClaim)
            ? {
                sourceClaim: {
                    acquisitionId: value.sourceClaim.acquisitionId,
                    handoffId: value.sourceClaim.handoffId,
                },
            }
            : {}),
    };
}
function parseForwardCallbackEnvelope(value, requestId) {
    const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
    return delivery &&
        typeof value.recipientInstanceId === "string" &&
        typeof value.recipientRegistrationGeneration === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind: "leader.forwardCallback",
            requestId,
            recipientInstanceId: value.recipientInstanceId,
            recipientRegistrationGeneration: value.recipientRegistrationGeneration,
            delivery,
            query: value.query,
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseForwardReactionEnvelope(value, requestId) {
    const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
    return delivery &&
        typeof value.recipientInstanceId === "string" &&
        typeof value.recipientRegistrationGeneration === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind: "leader.forwardReaction",
            requestId,
            recipientInstanceId: value.recipientInstanceId,
            recipientRegistrationGeneration: value.recipientRegistrationGeneration,
            delivery,
            reactionUpdate: value.reactionUpdate,
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseForwardMessageEnvelope(value, requestId, kind) {
    const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
    return delivery &&
        typeof value.recipientInstanceId === "string" &&
        typeof value.recipientRegistrationGeneration === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind,
            requestId,
            recipientInstanceId: value.recipientInstanceId,
            recipientRegistrationGeneration: value.recipientRegistrationGeneration,
            delivery,
            message: value.message,
            ...(kind === "leader.forwardMessage" &&
                (value.forwardCommentBatchPosition === "comment" ||
                    value.forwardCommentBatchPosition === "forward")
                ? {
                    forwardCommentBatchPosition: value.forwardCommentBatchPosition,
                }
                : {}),
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseOfferInputCustodyHandoffEnvelope(value, requestId) {
    const source = value.source;
    if (!isRecord(source) ||
        typeof value.recipientInstanceId !== "string" ||
        typeof value.recipientRegistrationGeneration !== "string" ||
        typeof value.recipientBindingKey !== "string" ||
        !value.recipientBindingKey ||
        typeof value.sourceRecoveryKey !== "string" ||
        !value.sourceRecoveryKey ||
        value.sourceRecoveryKey.length > 1_024 ||
        typeof source.journalBindingKey !== "string" ||
        !source.journalBindingKey ||
        source.journalBindingKey !== value.sourceRecoveryKey ||
        typeof source.tokenSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(source.tokenSha256) ||
        !Number.isSafeInteger(source.updateId) ||
        source.updateId < 0 ||
        typeof value.handoffId !== "string" ||
        !value.handoffId ||
        value.handoffId.length > 256 ||
        typeof value.sentAtMs !== "number")
        return undefined;
    return {
        kind: "leader.offerInputCustodyHandoff",
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        recipientRegistrationGeneration: value.recipientRegistrationGeneration,
        recipientBindingKey: value.recipientBindingKey,
        sourceRecoveryKey: value.sourceRecoveryKey,
        source: {
            journalBindingKey: source.journalBindingKey,
            tokenSha256: source.tokenSha256,
            updateId: source.updateId,
        },
        handoffId: value.handoffId,
        sentAtMs: value.sentAtMs,
    };
}
function parseWakeInputCustodyEnvelope(value, requestId) {
    const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
    return delivery &&
        delivery.sourceRecoveryKey &&
        delivery.sourceClaim &&
        typeof value.recipientInstanceId === "string" &&
        typeof value.recipientRegistrationGeneration === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind: "leader.wakeInputCustody",
            requestId,
            recipientInstanceId: value.recipientInstanceId,
            recipientRegistrationGeneration: value.recipientRegistrationGeneration,
            delivery,
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseQueueHandoffEnvelope(value, requestId, kind) {
    let serializedPayloadBytes;
    try {
        serializedPayloadBytes = Buffer.byteLength(JSON.stringify(value.payload));
    }
    catch {
        return undefined;
    }
    if (serializedPayloadBytes > TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES) {
        return undefined;
    }
    const payload = parseTelegramQueueHandoffPayload(value.payload);
    if (!payload ||
        typeof value.recipientInstanceId !== "string" ||
        typeof value.recipientRegistrationGeneration !== "string" ||
        !Number.isSafeInteger(value.donorProcessId) ||
        value.donorProcessId <= 0 ||
        typeof value.donorProcessBirthId !== "string" ||
        !value.donorProcessBirthId ||
        !Number.isSafeInteger(value.donorSessionGeneration) ||
        value.donorSessionGeneration <= 0 ||
        typeof value.donorAcquisitionId !== "string" ||
        !value.donorAcquisitionId ||
        !Number.isSafeInteger(value.donorAcquiredAtMs) ||
        value.donorAcquiredAtMs < 0 ||
        typeof value.handoffToken !== "string" ||
        value.handoffToken.length < 32 ||
        value.handoffToken.length > 256 ||
        value.donorProcessBirthId.length > 256 ||
        value.donorAcquisitionId.length > 256 ||
        typeof value.sentAtMs !== "number") {
        return undefined;
    }
    const fields = {
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        recipientRegistrationGeneration: value.recipientRegistrationGeneration,
        donorProcessId: value.donorProcessId,
        donorProcessBirthId: value.donorProcessBirthId,
        donorSessionGeneration: value.donorSessionGeneration,
        donorAcquisitionId: value.donorAcquisitionId,
        donorAcquiredAtMs: value.donorAcquiredAtMs,
        handoffToken: value.handoffToken,
        payload,
        sentAtMs: value.sentAtMs,
    };
    if (kind === "leader.offerQueueHandoff") {
        return typeof value.donorInstanceId === "string"
            ? { kind, donorInstanceId: value.donorInstanceId, ...fields }
            : undefined;
    }
    return typeof value.instanceId === "string" &&
        typeof value.registrationGeneration === "string"
        ? {
            kind,
            instanceId: value.instanceId,
            registrationGeneration: value.registrationGeneration,
            ...fields,
        }
        : undefined;
}
function parseResolveAgentTargetEnvelope(value, requestId) {
    const selectorValue = isRecord(value.selector) ? value.selector : undefined;
    if (typeof value.instanceId !== "string" ||
        !selectorValue ||
        typeof value.sentAtMs !== "number") {
        return undefined;
    }
    const chatId = typeof selectorValue.chatId === "number" &&
        Number.isInteger(selectorValue.chatId)
        ? selectorValue.chatId
        : undefined;
    const threadId = typeof selectorValue.threadId === "number" &&
        Number.isInteger(selectorValue.threadId) &&
        selectorValue.threadId > 0
        ? selectorValue.threadId
        : undefined;
    const threadName = typeof selectorValue.threadName === "string" &&
        selectorValue.threadName.trim()
        ? selectorValue.threadName.trim()
        : undefined;
    if ((threadId === undefined) === (threadName === undefined))
        return undefined;
    return {
        kind: "follower.resolveAgentTarget",
        requestId,
        instanceId: value.instanceId,
        ...(typeof value.registrationGeneration === "string"
            ? { registrationGeneration: value.registrationGeneration }
            : {}),
        selector: {
            ...(chatId !== undefined ? { chatId } : {}),
            ...(threadId !== undefined ? { threadId } : {}),
            ...(threadName !== undefined ? { threadName } : {}),
        },
        sentAtMs: value.sentAtMs,
    };
}
function parseRouteAgentMessageEnvelope(value, requestId) {
    const messageValue = isRecord(value.message) ? value.message : undefined;
    const target = parseThreadTarget(messageValue?.target);
    if (typeof value.instanceId !== "string" ||
        !messageValue ||
        !target ||
        typeof messageValue.messageId !== "number" ||
        !Number.isInteger(messageValue.messageId) ||
        messageValue.messageId <= 0 ||
        typeof messageValue.text !== "string" ||
        !messageValue.text.trim() ||
        typeof value.sentAtMs !== "number") {
        return undefined;
    }
    return {
        kind: "follower.routeAgentMessage",
        requestId,
        instanceId: value.instanceId,
        ...(typeof value.registrationGeneration === "string"
            ? { registrationGeneration: value.registrationGeneration }
            : {}),
        message: {
            target,
            messageId: messageValue.messageId,
            text: messageValue.text,
        },
        sentAtMs: value.sentAtMs,
    };
}
const nonempty = (input, limit = 128) => typeof input === "string" && !!input.trim() && input.length <= limit;
const positive = (input) => Number.isSafeInteger(input) && input > 0;
const nonnegative = (input) => Number.isSafeInteger(input) && input >= 0;
/** Shared closed text-effect codec; parsing alone supplies no recipient or issuance authority. */
export function parseTelegramBusSelectedMenuTextEffect(effect) {
    if (!isRecord(effect) ||
        (effect.kind !== "send-text" && effect.kind !== "edit-text") ||
        !hasOnlyWireKeys(effect, [
            "kind",
            "text",
            "parseMode",
            "replyMarkup",
            ...(effect.kind === "send-text" ? ["replyToMessageId"] : ["messageId"]),
        ]) ||
        !nonempty(effect.text, 4096) ||
        (effect.parseMode !== undefined && effect.parseMode !== "HTML") ||
        (effect.kind === "send-text"
            ? effect.replyToMessageId !== undefined &&
                !positive(effect.replyToMessageId)
            : !positive(effect.messageId)))
        return undefined;
    let replyMarkup;
    if (effect.replyMarkup !== undefined) {
        const markup = effect.replyMarkup;
        if (!isRecord(markup) ||
            !hasOnlyWireKeys(markup, ["inline_keyboard"]) ||
            !Array.isArray(markup.inline_keyboard) ||
            markup.inline_keyboard.length > 32 ||
            markup.inline_keyboard.some((row) => !Array.isArray(row) ||
                !row.length ||
                row.length > 8 ||
                row.some((button) => !isRecord(button) ||
                    !hasOnlyWireKeys(button, ["text", "callback_data"]) ||
                    !nonempty(button.text) ||
                    !nonempty(button.callback_data, 64) ||
                    Buffer.byteLength(button.callback_data, "utf8") > 64)))
            return undefined;
        replyMarkup = {
            inline_keyboard: markup.inline_keyboard.map((row) => row.map((button) => ({
                text: button.text,
                callback_data: button.callback_data,
            }))),
        };
    }
    const common = {
        text: effect.text,
        ...(effect.parseMode === "HTML" ? { parseMode: "HTML" } : {}),
        ...(replyMarkup ? { replyMarkup } : {}),
    };
    return effect.kind === "send-text"
        ? {
            ...common,
            kind: "send-text",
            ...(effect.replyToMessageId !== undefined
                ? { replyToMessageId: effect.replyToMessageId }
                : {}),
        }
        : { ...common, kind: "edit-text", messageId: effect.messageId };
}
function parseSelectedMenuDeliveryEnvelope(value, requestId) {
    const recipient = value.recipient, executor = value.executor, effect = parseTelegramBusSelectedMenuTextEffect(value.effect);
    if (!hasOnlyWireKeys(value, [
        "kind",
        "requestId",
        "auth",
        "instanceId",
        "registrationGeneration",
        "operationId",
        "recipient",
        "executor",
        "operatorUserId",
        "effect",
        "sentAtMs",
    ]) ||
        !nonempty(requestId) ||
        !nonempty(value.instanceId) ||
        !nonempty(value.registrationGeneration) ||
        !nonempty(value.operationId) ||
        !isRecord(recipient) ||
        !hasOnlyWireKeys(recipient, [
            "sessionId",
            "sessionGeneration",
            "processId",
            "processBirthId",
            "profileKey",
            "journalBindingKey",
            "target",
        ]) ||
        !nonempty(recipient.sessionId) ||
        !nonnegative(recipient.sessionGeneration) ||
        !positive(recipient.processId) ||
        !nonempty(recipient.processBirthId) ||
        !nonempty(recipient.profileKey, 1024) ||
        !nonempty(recipient.journalBindingKey, 8192) ||
        recipient.profileKey === recipient.journalBindingKey ||
        !isRecord(recipient.target) ||
        !hasOnlyWireKeys(recipient.target, ["chatId", "threadId"]) ||
        !positive(recipient.target.chatId) ||
        !positive(recipient.target.threadId) ||
        !positive(value.operatorUserId) ||
        value.operatorUserId !== recipient.target.chatId ||
        !isRecord(executor) ||
        !hasOnlyWireKeys(executor, ["instanceId", "leaderEpoch"]) ||
        !nonempty(executor.instanceId) ||
        !nonempty(executor.leaderEpoch) ||
        !effect ||
        typeof value.sentAtMs !== "number" ||
        !Number.isFinite(value.sentAtMs) ||
        value.sentAtMs < 0 ||
        (value.auth !== undefined && typeof value.auth !== "string"))
        return undefined;
    return {
        kind: "follower.deliverSelectedMenu",
        requestId,
        instanceId: value.instanceId,
        registrationGeneration: value.registrationGeneration,
        operationId: value.operationId,
        recipient: {
            sessionId: recipient.sessionId,
            sessionGeneration: recipient.sessionGeneration,
            processId: recipient.processId,
            processBirthId: recipient.processBirthId,
            profileKey: recipient.profileKey,
            journalBindingKey: recipient.journalBindingKey,
            target: {
                chatId: recipient.target.chatId,
                threadId: recipient.target.threadId,
            },
        },
        executor: {
            instanceId: executor.instanceId,
            leaderEpoch: executor.leaderEpoch,
        },
        operatorUserId: value.operatorUserId,
        effect,
        sentAtMs: value.sentAtMs,
    };
}
function parseCallApiEnvelope(value, requestId) {
    return typeof value.instanceId === "string" &&
        (value.apiRegistrationIncarnation === undefined || typeof value.apiRegistrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(value.apiRegistrationIncarnation)) &&
        (value.attachmentRegistrationIncarnation === undefined || typeof value.attachmentRegistrationIncarnation === "string" && /^[a-f0-9]{48}$/u.test(value.attachmentRegistrationIncarnation)) &&
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
            ...(typeof value.apiRegistrationIncarnation === "string" ? { apiRegistrationIncarnation: value.apiRegistrationIncarnation } : {}),
            ...(typeof value.attachmentRegistrationIncarnation === "string" ? { attachmentRegistrationIncarnation: value.attachmentRegistrationIncarnation } : {}),
            method: value.method,
            args: value.args,
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseAckEnvelope(value, requestId) {
    if (typeof value.ok !== "boolean")
        return undefined;
    const envelope = {
        kind: "bus.ack",
        requestId,
        ok: value.ok,
        message: typeof value.message === "string" ? value.message : undefined,
    };
    if (Object.hasOwn(value, "result"))
        envelope.result = value.result;
    const protocol = parseTelegramBusProtocolIdentity(value.protocol);
    if (protocol)
        envelope.protocol = protocol;
    if (isRecord(value.error)) {
        const code = value.error.code;
        if (code === "commit-unknown" ||
            code === "request-id-collision" ||
            code === "ledger-overloaded" ||
            code === "incompatible-protocol" ||
            code === "stale-target" ||
            code === "follower-api-not-allowed" ||
            code === "workspace-binding-unavailable") {
            const chatId = value.error.chatId;
            const threadId = value.error.threadId;
            if (code === "follower-api-not-allowed" &&
                (value.ok || Object.hasOwn(value, "result") ||
                    typeof value.error.method !== "string" ||
                    !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.error.method)))
                return undefined;
            if (code === "stale-target" &&
                (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId))) {
                return undefined;
            }
            envelope.error = {
                code,
                ...(typeof value.error.method === "string"
                    ? { method: value.error.method }
                    : {}),
                ...(typeof chatId === "number" ? { chatId } : {}),
                ...(typeof threadId === "number" ? { threadId } : {}),
            };
        }
    }
    return envelope;
}
function parseTelegramBusProtocolIdentity(value) {
    if (!isRecord(value))
        return undefined;
    if (!Number.isSafeInteger(value.protocolVersion) ||
        value.protocolVersion <= 0 ||
        typeof value.runtimeBuild !== "string" ||
        !value.runtimeBuild.trim() ||
        value.runtimeBuild !== value.runtimeBuild.trim() ||
        value.runtimeBuild.length > 128 ||
        !Array.isArray(value.capabilities) ||
        value.capabilities.length > 32 ||
        value.capabilities.some((capability) => typeof capability !== "string" ||
            capability.length > 128 ||
            !/^[a-z0-9][a-z0-9._-]*$/u.test(capability))) {
        return undefined;
    }
    const capabilities = value.capabilities;
    if (capabilities.some((capability, index) => index > 0 && capability <= capabilities[index - 1])) {
        return undefined;
    }
    return {
        protocolVersion: value.protocolVersion,
        runtimeBuild: value.runtimeBuild,
        capabilities: [...capabilities],
    };
}
function parseRegistration(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.instanceId !== "string")
        return undefined;
    if (typeof value.connectedAtMs !== "number")
        return undefined;
    const target = parseTarget(value.target);
    if (value.target !== undefined && !target)
        return undefined;
    const registration = {
        instanceId: value.instanceId,
        connectedAtMs: value.connectedAtMs,
    };
    if (typeof value.previousInstanceId === "string") {
        registration.previousInstanceId = value.previousInstanceId;
    }
    if (typeof value.profileKey === "string")
        registration.profileKey = value.profileKey;
    if (typeof value.threadName === "string")
        registration.threadName = value.threadName;
    if (typeof value.slot === "string" && /^[A-Z]$/.test(value.slot)) {
        registration.slot = value.slot;
    }
    if (typeof value.cwd === "string")
        registration.cwd = value.cwd;
    if (value.sessionId !== undefined) {
        if (typeof value.sessionId !== "string" ||
            !value.sessionId ||
            value.sessionId !== value.sessionId.trim() ||
            Buffer.byteLength(value.sessionId, "utf8") > 256)
            return undefined;
        registration.sessionId = value.sessionId;
    }
    if (typeof value.pid === "number")
        registration.pid = value.pid;
    if (typeof value.busSocketPath === "string") {
        registration.busSocketPath = value.busSocketPath;
    }
    if (typeof value.registrationGeneration === "string") {
        registration.registrationGeneration = value.registrationGeneration;
    }
    if (Number.isSafeInteger(value.sessionGeneration) &&
        value.sessionGeneration > 0) {
        registration.sessionGeneration = value.sessionGeneration;
    }
    if (typeof value.processBirthId === "string" && value.processBirthId) {
        registration.processBirthId = value.processBirthId;
    }
    const protocol = parseTelegramBusProtocolIdentity(value.protocol);
    if (protocol)
        registration.protocol = protocol;
    if (target)
        registration.target = target;
    return registration;
}
function parseThreadTarget(value) {
    const target = parseTarget(value);
    return target && typeof target.threadId === "number"
        ? { chatId: target.chatId, threadId: target.threadId }
        : undefined;
}
