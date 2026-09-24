/**
 * Telegram multi-instance bus protocol and IPC helpers
 * Zones: multi-instance bus, local IPC contract, live instance routing
 * Owns serializable bus envelopes, socket/auth helpers, local IPC client/server primitives,
 * cross-instance forwarding helpers, and the live follower registry model.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, } from "node:fs";
import { createConnection, createServer, } from "node:net";
import { createRequire } from "node:module";
import { platform as getPlatform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyTelegramBusTransportError, createTelegramBusTransportTimeoutError, delayTelegramBusTransportRetry, getTelegramBusEndpointDiagnostics, getTelegramBusFollowerEndpoint, getTelegramBusLeaderEndpoint, getTelegramBusPipePath, getTelegramBusTransportRetryPolicy, isTelegramBusPipePath, isRetryableTelegramBusTransportError, probeTelegramBusEndpoint, } from "./bus-transport.js";
import { TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS, TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES, } from "./queue.js";
import { isProcessAlive } from "./locks.js";
import { resolveAgentDir } from "./paths.js";
function readDarwinProcessStart(pid) {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}
export function getTelegramProcessBirthProof(pid, options = {}) {
    if (pid <= 0)
        return { status: "unverifiable" };
    const platform = options.platform ?? getPlatform();
    if (platform === "linux") {
        try {
            const stat = (options.readProcStat ?? ((targetPid) => readFileSync(`/proc/${targetPid}/stat`, "utf8")))(pid);
            const closeParen = stat.lastIndexOf(")");
            const fields = stat
                .slice(closeParen + 2)
                .trim()
                .split(/\s+/u);
            const startTicks = fields[19];
            if (startTicks) {
                return { status: "proven", identity: `${pid}:start:${startTicks}` };
            }
        }
        catch {
            /* inaccessible process metadata */
        }
    }
    else if (platform === "darwin") {
        try {
            const startedAt = (options.readDarwinProcessStart ?? readDarwinProcessStart)(pid);
            if (startedAt) {
                const fingerprint = createHash("sha256")
                    .update(startedAt)
                    .digest("hex")
                    .slice(0, 16);
                return { status: "proven", identity: `${pid}:start:${fingerprint}` };
            }
        }
        catch {
            /* inaccessible process metadata */
        }
    }
    return { status: "unverifiable" };
}
export function getTelegramProcessBirthIdentity(pid, fallbackGeneration, options = {}) {
    const proof = getTelegramProcessBirthProof(pid, options);
    return proof.status === "proven"
        ? proof.identity
        : `${pid}:generation:${fallbackGeneration}`;
}
export function getTelegramProcessLiveness(owner, options = {}) {
    const processAlive = options.isProcessAlive ?? isProcessAlive;
    if (!processAlive(owner.processId))
        return "dead";
    const proof = getTelegramProcessBirthProof(owner.processId, options);
    if (proof.status === "unverifiable")
        return "unverifiable";
    return proof.identity === owner.processBirthId ? "alive" : "dead";
}
export function getTelegramProcessBirthIdentityLiveness(processBirthId, options = {}) {
    const match = /^(\d+):(start|generation):(.+)$/u.exec(processBirthId);
    if (!match)
        return "unverifiable";
    const processId = Number(match[1]);
    if (!Number.isSafeInteger(processId) || processId <= 0)
        return "unverifiable";
    const processAlive = options.isProcessAlive ?? isProcessAlive;
    if (!processAlive(processId))
        return "dead";
    if (match[2] === "generation")
        return "unverifiable";
    const proof = getTelegramProcessBirthProof(processId, options);
    if (proof.status === "unverifiable")
        return "unverifiable";
    return proof.identity === processBirthId ? "alive" : "dead";
}
export function createCurrentTelegramBusProcessRuntime(input) {
    return createTelegramBusProcessRuntime({
        getActiveProfileName: input.getActiveProfileName,
        pid: input.pid ?? process.pid,
        parentPid: input.parentPid ?? process.ppid,
        createdAtMs: input.createdAtMs ?? Date.now(),
    });
}
export function createTelegramBusProcessRuntime(input) {
    const instanceId = `${input.pid}:${input.createdAtMs}`;
    const ownerPid = input.parentPid || input.pid;
    const manualFollowerOwnerId = input.parentProcessIdentity ??
        getTelegramProcessBirthIdentity(ownerPid, input.createdAtMs);
    return {
        instanceId,
        processId: input.pid,
        processBirthId: getTelegramProcessBirthIdentity(input.pid, instanceId),
        manualFollowerOwnerId,
        getLeaderSocketPath: () => getTelegramBusSocketPath(undefined, undefined, input.getActiveProfileName()),
        getFollowerSocketPath: () => getTelegramBusFollowerSocketPath(instanceId, undefined, undefined, input.getActiveProfileName()),
    };
}
export function createTelegramBusAuthSecret() {
    return randomBytes(32).toString("base64url");
}
export const TELEGRAM_BUS_PROTOCOL_VERSION = 2;
export const TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION = "durable-follower-admission-v1";
export const TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF = "queue-handoff-v1";
export const TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE = "input-custody-reference-v1";
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME = "workspace-thread-rename-v1";
export const TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE = "thread-display-mode-v1";
export const TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT = "directory-display-format-v1";
export const TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT = "workspace-follower-auto-connect-v1";
export function createTelegramBusProtocolIdentity(input) {
    const runtimeBuild = input.runtimeBuild.trim();
    if (!runtimeBuild || runtimeBuild.length > 128) {
        throw new Error("Telegram bus runtime build identity is invalid.");
    }
    const capabilities = [...new Set(input.capabilities ?? [])].sort();
    if (capabilities.length > 32 ||
        capabilities.some((capability) => capability.length > 128 ||
            !/^[a-z0-9][a-z0-9._-]*$/u.test(capability))) {
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
export function getTelegramInputCustodyPeerReadiness(followers) {
    return followers.map(follower => {
        if (!follower.registrationGeneration || !follower.protocol)
            return "unknown";
        return hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION) &&
            hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE) ? "ready" : "legacy";
    });
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
export function getTelegramBusSocketPath(agentDir = resolveAgentDir(), platform = getPlatform(), profileName) {
    return getTelegramBusLeaderEndpoint({ agentDir, platform, profileName });
}
export function getTelegramBusFollowerSocketPath(instanceId, agentDir = resolveAgentDir(), platform = getPlatform(), profileName) {
    return getTelegramBusFollowerEndpoint({
        agentDir,
        platform,
        instanceId,
        profileName,
    });
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
export function markTelegramBusAggregateDelivery(body) {
    return {
        ...body,
        [TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD]: true,
    };
}
export function isTelegramBusAggregateDelivery(body) {
    return Boolean(body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body[TELEGRAM_BUS_AGGREGATE_DELIVERY_FIELD] ===
            true);
}
export function markTelegramBusCrossTargetDelivery(body) {
    return {
        ...body,
        [TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD]: true,
    };
}
export function isTelegramBusCrossTargetDelivery(body) {
    return Boolean(body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body[TELEGRAM_BUS_CROSS_TARGET_DELIVERY_FIELD] === true);
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
            (target.threadId === undefined ||
                !matchesId(threadId, target.threadId)));
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
            return isTargetChatScoped(input.args[1]);
        if (apiMethod === "sendMessage" &&
            isTelegramBusAggregateDelivery(input.args[1])) {
            const body = input.args[1];
            return body.message_thread_id === undefined && isTargetChatScoped(body);
        }
        if ((apiMethod === "sendMessage" || apiMethod === "sendRichMessage") &&
            isTelegramBusCrossTargetDelivery(input.args[1])) {
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
            (!input.sourceClaim.acquisitionId || input.sourceClaim.acquisitionId.length > 256 ||
                !input.sourceClaim.handoffId || input.sourceClaim.handoffId.length > 256))) {
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
        ...(input.sourceRecoveryKey ? { sourceRecoveryKey: input.sourceRecoveryKey } : {}),
        ...(input.sourceClaim ? { sourceClaim: { ...input.sourceClaim } } : {}),
    };
}
export function canUseTelegramBusInputCustodyReference(input) {
    return hasTelegramBusCapability(input.local, TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE) &&
        hasTelegramBusCapability(input.remote, TELEGRAM_BUS_CAPABILITY_INPUT_CUSTODY_REFERENCE);
}
export function createTelegramBusFollowerSourceReferenceDeliveryIdentity(input) {
    if (!input.sourceRecoveryKey || !input.source.owner.handoffId)
        throw new Error("Telegram follower source-reference delivery requires an accepted handoff.");
    return createTelegramBusFollowerDeliveryIdentity({ kind: input.kind,
        recipientBindingKey: input.recipientBindingKey,
        sourceUpdateId: input.source.updateId,
        sourceRecoveryKey: input.sourceRecoveryKey,
        sourceClaim: { acquisitionId: input.source.owner.acquisitionId,
            handoffId: input.source.owner.handoffId } });
}
export function getTelegramBusEnvelopeTrafficClass(envelope) {
    if (envelope.kind === "follower.register" ||
        envelope.kind === "follower.restoreWorkspace")
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
            envelope = parseHeartbeatEnvelope(value, requestId);
            break;
        case "follower.disconnect":
            envelope = parseDisconnectEnvelope(value, requestId);
            break;
        case "follower.setThreadDisplayMode":
            if (typeof value.instanceId === "string" &&
                typeof value.registrationGeneration === "string" &&
                (value.mode === "letters" || value.mode === "names" ||
                    value.mode === "directory-snake" || value.mode === "directory-title")) {
                envelope = { kind, requestId, instanceId: value.instanceId,
                    registrationGeneration: value.registrationGeneration, mode: value.mode };
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
        case "leader.replaceFollowerTarget":
            envelope = parseReplaceFollowerTargetEnvelope(value, requestId);
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
        case "follower.callApi":
            envelope = parseCallApiEnvelope(value, requestId);
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
const TELEGRAM_ACTIVE_LOCAL_SERVERS = Symbol.for("@llblab/pi-telegram/active-local-servers");
function getActiveTelegramBusLocalServers() {
    const root = globalThis;
    return (root[TELEGRAM_ACTIVE_LOCAL_SERVERS] ??= new Map());
}
const TELEGRAM_BUS_MAX_DIRECT_UNIX_ENDPOINT_BYTES = 80;
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
export function isTelegramBusForwardOwnershipCurrent(expected, current) {
    return Boolean(current && current.instanceId === expected.instanceId &&
        current.ownerGeneration === expected.ownerGeneration &&
        current.recipientBindingKey === expected.recipientBindingKey &&
        JSON.stringify(current.protocolIdentity) === JSON.stringify(expected.protocolIdentity));
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
            local: deps.localProtocolIdentity, remote: ownership.protocolIdentity
        });
        const reference = sourceReference ? deps.resolveInputCustodyReference?.({
            sourceUpdateId, recipientBindingKey: ownership.recipientBindingKey
        }) : undefined;
        if (sourceReference && !reference)
            return { settlement: reject({
                    status: "retryable", failureClass: "source-reference-missing",
                    message: "Forwarded Telegram update has no exact custody reference.",
                    envelopeKind: kind, ownership, sourceUpdateId
                }) };
        const delivery = reference
            ? createTelegramBusFollowerSourceReferenceDeliveryIdentity({
                kind: "leader.wakeInputCustody", recipientBindingKey: ownership.recipientBindingKey,
                sourceRecoveryKey: reference.sourceRecoveryKey, source: reference.source
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
    const send = async (envelope, ownership) => {
        if (deps.validateForwardOwnership && !deps.validateForwardOwnership(ownership))
            return reject({
                status: "retryable", failureClass: "recipient-ownership-stale",
                message: "Telegram follower ownership changed before forwarding.",
                envelopeKind: envelope.kind, ownership, delivery: envelope.delivery
            });
        if (deps.getAuthSecret)
            envelope.auth = deps.getAuthSecret();
        const socketPath = resolveTelegramBusSocketPath(deps.socketPath);
        let response;
        try {
            response = await sendTelegramBusLocalEnvelope({
                socketPath,
                envelope,
                timeoutMs: deps.timeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: socketPath,
                    operation: "operation",
                }),
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
    return {
        forwardCallback: ({ query, ownership }) => {
            const prepared = prepare("leader.forwardCallback", query, ownership);
            if ("settlement" in prepared)
                return Promise.resolve(prepared.settlement);
            if (prepared.sourceReference)
                return send({ kind: "leader.wakeInputCustody",
                    requestId: deps.createRequestId(), recipientInstanceId: ownership.instanceId,
                    recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                    delivery: prepared.delivery, sentAtMs: getNowMs() }, ownership);
            return send({
                kind: "leader.forwardCallback",
                requestId: deps.createRequestId(),
                recipientInstanceId: ownership.instanceId,
                recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                delivery: prepared.delivery,
                query,
                sentAtMs: getNowMs(),
            }, ownership);
        },
        forwardReaction: ({ reactionUpdate, ownership }) => {
            const prepared = prepare("leader.forwardReaction", reactionUpdate, ownership);
            if ("settlement" in prepared)
                return Promise.resolve(prepared.settlement);
            if (prepared.sourceReference)
                return send({ kind: "leader.wakeInputCustody",
                    requestId: deps.createRequestId(), recipientInstanceId: ownership.instanceId,
                    recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                    delivery: prepared.delivery, sentAtMs: getNowMs() }, ownership);
            return send({
                kind: "leader.forwardReaction",
                requestId: deps.createRequestId(),
                recipientInstanceId: ownership.instanceId,
                recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                delivery: prepared.delivery,
                reactionUpdate,
                sentAtMs: getNowMs(),
            }, ownership);
        },
        forwardMessage: ({ message, ownership }) => {
            const prepared = prepare("leader.forwardMessage", message, ownership);
            if ("settlement" in prepared)
                return Promise.resolve(prepared.settlement);
            if (prepared.sourceReference)
                return send({ kind: "leader.wakeInputCustody",
                    requestId: deps.createRequestId(), recipientInstanceId: ownership.instanceId,
                    recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                    delivery: prepared.delivery, sentAtMs: getNowMs() }, ownership);
            return send({
                kind: "leader.forwardMessage",
                requestId: deps.createRequestId(),
                recipientInstanceId: ownership.instanceId,
                recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                delivery: prepared.delivery,
                message,
                ...(deps.getForwardCommentBatchPosition?.(message) !== undefined
                    ? {
                        forwardCommentBatchPosition: deps.getForwardCommentBatchPosition(message),
                    }
                    : {}),
                sentAtMs: getNowMs(),
            }, ownership);
        },
        forwardEditedMessage: ({ message, ownership }) => {
            const prepared = prepare("leader.forwardEditedMessage", message, ownership);
            if ("settlement" in prepared)
                return Promise.resolve(prepared.settlement);
            if (prepared.sourceReference)
                return send({ kind: "leader.wakeInputCustody",
                    requestId: deps.createRequestId(), recipientInstanceId: ownership.instanceId,
                    recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                    delivery: prepared.delivery, sentAtMs: getNowMs() }, ownership);
            return send({
                kind: "leader.forwardEditedMessage",
                requestId: deps.createRequestId(),
                recipientInstanceId: ownership.instanceId,
                recipientRegistrationGeneration: prepared.recipientRegistrationGeneration,
                delivery: prepared.delivery,
                message,
                sentAtMs: getNowMs(),
            }, ownership);
        },
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
export function createTelegramBusFollowerTargetController(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    return {
        async replaceTarget({ follower, target, oldTarget, reason }) {
            if (!follower.busSocketPath || !follower.registrationGeneration) {
                return false;
            }
            const envelope = {
                kind: "leader.replaceFollowerTarget",
                requestId: deps.createRequestId(),
                recipientInstanceId: follower.instanceId,
                recipientRegistrationGeneration: follower.registrationGeneration,
                target,
                ...(oldTarget ? { oldTarget } : {}),
                reason,
                sentAtMs: getNowMs(),
            };
            if (deps.getAuthSecret)
                envelope.auth = deps.getAuthSecret();
            const response = await sendTelegramBusLocalEnvelope({
                socketPath: follower.busSocketPath,
                envelope,
                timeoutMs: deps.timeoutMs,
                retry: getTelegramBusTransportRetryPolicy({
                    endpoint: follower.busSocketPath,
                    operation: "operation",
                }),
            });
            return response?.kind === "bus.ack" && response.ok;
        },
    };
}
export function createTelegramBusFollowerThreadRestoreHandler(deps) {
    return async ({ record, target, oldTarget }) => {
        if (!record.instanceId)
            return false;
        const follower = deps.followerRegistry.get(record.instanceId);
        if (!follower?.registrationGeneration || !oldTarget ||
            follower.target?.chatId !== oldTarget.chatId ||
            follower.target.threadId !== oldTarget.threadId ||
            target.chatId !== oldTarget.chatId || target.threadId === oldTarget.threadId)
            return false;
        const replaced = await deps.followerTargetController.replaceTarget({
            follower,
            target,
            oldTarget,
            reason: "thread-restore",
        });
        const current = deps.followerRegistry.get(record.instanceId);
        if (!replaced || !current ||
            current.registrationGeneration !== follower.registrationGeneration ||
            current.target?.chatId !== oldTarget.chatId ||
            current.target.threadId !== oldTarget.threadId)
            return false;
        deps.followerRegistry.register({
            ...current,
            target,
            connectedAtMs: current.connectedAtMs,
        });
        deps.onRestored?.();
        return true;
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
export function createUnauthorizedBusAck(requestId) {
    return {
        kind: "bus.ack",
        requestId,
        ok: false,
        message: "Unauthorized Telegram bus envelope.",
    };
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
        const key = getRequestLedgerKey(envelope);
        const fingerprint = JSON.stringify(envelope);
        const existing = requestLedger.get(key);
        if (existing) {
            if (existing.fingerprint === fingerprint)
                return existing.result;
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
            settled: false,
            result: Promise.resolve().then(() => deps.handleEnvelope(envelope)),
        };
        requestLedger.set(key, entry);
        void entry.result.then(() => {
            entry.settled = true;
        }, () => {
            entry.settled = true;
        });
        return entry.result;
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
            socket.write(encodeTelegramBusEnvelope(options.envelope));
        });
        socket.on("data", (chunk) => {
            buffer += chunk;
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex < 0)
                return;
            const line = buffer.slice(0, newlineIndex);
            settle(() => resolve(parseTelegramBusEnvelope(line)));
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
    for (let attempt = 1;; attempt += 1) {
        try {
            return await sendTelegramBusLocalEnvelopeOnce(resolvedOptions);
        }
        catch (error) {
            const info = classifyTelegramBusTransportError(error);
            resolvedOptions.recordTransportEvent?.("client-failed", {
                ...getTelegramBusEndpointDiagnostics(resolvedOptions.socketPath),
                ...getTelegramBusEnvelopeDiagnostics(resolvedOptions.envelope),
                attempt,
                attempts,
                ...info,
            });
            if (attempt >= attempts || !isRetryableTelegramBusTransportError(error)) {
                throw error;
            }
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
export function createTelegramBusForwardOwnershipValidator(registry) {
    return ownership => {
        const follower = registry.get(ownership.instanceId);
        return isTelegramBusForwardOwnershipCurrent(ownership, follower?.registrationGeneration && follower.profileKey && follower.protocol ? {
            instanceId: follower.instanceId,
            ownerGeneration: follower.registrationGeneration,
            recipientBindingKey: follower.profileKey,
            protocolIdentity: follower.protocol,
        } : undefined);
    };
}
function hasTelegramBusFollowerIdentityOverlap(first, second) {
    return first.instanceId === second.instanceId ||
        (first.profileKey !== undefined && first.profileKey === second.profileKey) ||
        (first.target !== undefined && first.target.chatId === second.target?.chatId &&
            first.target.threadId === second.target.threadId);
}
export function createTelegramBusFollowerRegistry() {
    const followers = new Map();
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
    return {
        register: (registration) => {
            const existing = followers.get(registration.instanceId);
            for (const [instanceId, follower] of followers.entries()) {
                if (instanceId === registration.instanceId)
                    continue;
                if (hasTelegramBusFollowerIdentityOverlap(registration, follower))
                    followers.delete(instanceId);
            }
            const next = {
                ...registration,
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
        remove: (instanceId) => followers.delete(instanceId),
        clear: () => {
            followers.clear();
            for (const observation of observations)
                observation.current = false;
            observations.clear();
        },
        observeUnregistered: (follower) => {
            // This watches replacement, not process death or delivery authority.
            const observation = { follower: clone(follower), current: ![...followers.values()]
                    .some((current) => hasTelegramBusFollowerIdentityOverlap(current, follower)) };
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
            return removed;
        },
    };
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
        socket.write(encodeTelegramBusEnvelope({
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message: "Telegram bus handler failed.",
        }));
    }
}
function parseRegisterEnvelope(value, requestId, kind) {
    const registration = parseRegistration(value.registration);
    return registration ? { kind, requestId, registration } : undefined;
}
function parseHeartbeatEnvelope(value, requestId) {
    return typeof value.instanceId === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind: "follower.heartbeat",
            requestId,
            instanceId: value.instanceId,
            ...(typeof value.registrationGeneration === "string"
                ? { registrationGeneration: value.registrationGeneration }
                : {}),
            sentAtMs: value.sentAtMs,
        }
        : undefined;
}
function parseDisconnectEnvelope(value, requestId) {
    return typeof value.instanceId === "string" &&
        typeof value.sentAtMs === "number"
        ? {
            kind: "follower.disconnect",
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
            (typeof value.sourceRecoveryKey !== "string" || !value.sourceRecoveryKey ||
                value.sourceRecoveryKey.length > 1_024)) ||
        (value.sourceClaim !== undefined &&
            (!isRecord(value.sourceClaim) ||
                typeof value.sourceClaim.acquisitionId !== "string" ||
                !value.sourceClaim.acquisitionId || value.sourceClaim.acquisitionId.length > 256 ||
                typeof value.sourceClaim.handoffId !== "string" ||
                !value.sourceClaim.handoffId || value.sourceClaim.handoffId.length > 256))) {
        return undefined;
    }
    return {
        deliveryId: value.deliveryId,
        sourceUpdateId: value.sourceUpdateId,
        recipientBindingKey: value.recipientBindingKey,
        ...(typeof value.sourceRecoveryKey === "string"
            ? { sourceRecoveryKey: value.sourceRecoveryKey } : {}),
        ...(isRecord(value.sourceClaim)
            ? { sourceClaim: { acquisitionId: value.sourceClaim.acquisitionId,
                    handoffId: value.sourceClaim.handoffId } } : {}),
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
    if (!isRecord(source) || typeof value.recipientInstanceId !== "string" ||
        typeof value.recipientRegistrationGeneration !== "string" ||
        typeof value.recipientBindingKey !== "string" || !value.recipientBindingKey ||
        typeof value.sourceRecoveryKey !== "string" || !value.sourceRecoveryKey ||
        value.sourceRecoveryKey.length > 1_024 ||
        typeof source.journalBindingKey !== "string" || !source.journalBindingKey ||
        source.journalBindingKey !== value.sourceRecoveryKey ||
        typeof source.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.tokenSha256) ||
        !Number.isSafeInteger(source.updateId) || source.updateId < 0 ||
        typeof value.handoffId !== "string" || !value.handoffId || value.handoffId.length > 256 ||
        typeof value.sentAtMs !== "number")
        return undefined;
    return { kind: "leader.offerInputCustodyHandoff", requestId,
        recipientInstanceId: value.recipientInstanceId,
        recipientRegistrationGeneration: value.recipientRegistrationGeneration,
        recipientBindingKey: value.recipientBindingKey,
        sourceRecoveryKey: value.sourceRecoveryKey,
        source: { journalBindingKey: source.journalBindingKey,
            tokenSha256: source.tokenSha256, updateId: source.updateId },
        handoffId: value.handoffId, sentAtMs: value.sentAtMs };
}
function parseWakeInputCustodyEnvelope(value, requestId) {
    const delivery = parseTelegramBusFollowerDeliveryIdentity(value.delivery);
    return delivery && delivery.sourceRecoveryKey && delivery.sourceClaim &&
        typeof value.recipientInstanceId === "string" &&
        typeof value.recipientRegistrationGeneration === "string" &&
        typeof value.sentAtMs === "number"
        ? { kind: "leader.wakeInputCustody", requestId,
            recipientInstanceId: value.recipientInstanceId,
            recipientRegistrationGeneration: value.recipientRegistrationGeneration,
            delivery, sentAtMs: value.sentAtMs }
        : undefined;
}
function parseReplaceFollowerTargetEnvelope(value, requestId) {
    const target = parseThreadTarget(value.target);
    const oldTarget = parseThreadTarget(value.oldTarget);
    if (typeof value.recipientInstanceId !== "string" ||
        !target ||
        (value.oldTarget !== undefined && !oldTarget) ||
        value.reason !== "thread-restore" ||
        typeof value.sentAtMs !== "number") {
        return undefined;
    }
    return {
        kind: "leader.replaceFollowerTarget",
        requestId,
        recipientInstanceId: value.recipientInstanceId,
        ...(typeof value.recipientRegistrationGeneration === "string"
            ? {
                recipientRegistrationGeneration: value.recipientRegistrationGeneration,
            }
            : {}),
        target,
        ...(oldTarget ? { oldTarget } : {}),
        reason: value.reason,
        sentAtMs: value.sentAtMs,
    };
}
function parseQueueAdmissionReceipt(value, queueKind) {
    if (!isRecord(value) || value.queueKind !== queueKind)
        return undefined;
    const sourceUpdateIds = Array.isArray(value.sourceUpdateIds)
        ? value.sourceUpdateIds
        : undefined;
    if (typeof value.receiptId !== "string" ||
        !value.receiptId ||
        (value.journalBindingKey !== undefined &&
            (typeof value.journalBindingKey !== "string" ||
                !value.journalBindingKey.trim())) ||
        !sourceUpdateIds ||
        sourceUpdateIds.length === 0 ||
        sourceUpdateIds.some((updateId, index) => !Number.isSafeInteger(updateId) ||
            updateId < 0 ||
            (index > 0 &&
                updateId <=
                    sourceUpdateIds[index - 1]))) {
        return undefined;
    }
    return {
        queueKind,
        receiptId: value.receiptId,
        sourceUpdateIds: sourceUpdateIds,
        ...(typeof value.journalBindingKey === "string"
            ? { journalBindingKey: value.journalBindingKey }
            : {}),
    };
}
function parseQueueHandoffPayload(value) {
    if (!isRecord(value) || (value.kind !== "prompt" && value.kind !== "control")) {
        return undefined;
    }
    const queueKind = value.kind;
    const target = parseTarget(value.target);
    const transportStamp = isRecord(value.transportStamp) &&
        typeof value.transportStamp.profile === "string" &&
        typeof value.transportStamp.generation === "string"
        ? {
            profile: value.transportStamp.profile,
            generation: value.transportStamp.generation,
        }
        : undefined;
    if (!Number.isSafeInteger(value.chatId) ||
        (value.target !== undefined && !target) ||
        (value.transportStamp !== undefined && !transportStamp) ||
        !Number.isSafeInteger(value.replyToMessageId) ||
        (value.guestQueryId !== undefined &&
            typeof value.guestQueryId !== "string") ||
        (value.guestInlineMessageId !== undefined &&
            typeof value.guestInlineMessageId !== "string") ||
        !Number.isSafeInteger(value.queueOrder) ||
        (value.queueLane !== "control" &&
            value.queueLane !== "priority" &&
            value.queueLane !== "default") ||
        !Number.isSafeInteger(value.laneOrder) ||
        typeof value.statusSummary !== "string" ||
        !Array.isArray(value.admissionReceipts)) {
        return undefined;
    }
    const admissionReceipts = value.admissionReceipts.map((receipt) => parseQueueAdmissionReceipt(receipt, queueKind));
    if (admissionReceipts.length === 0 ||
        admissionReceipts.length > TELEGRAM_QUEUE_HANDOFF_MAX_RECEIPTS ||
        admissionReceipts.some((receipt) => receipt === undefined)) {
        return undefined;
    }
    const queueLane = value.queueLane;
    const base = {
        chatId: value.chatId,
        ...(target ? { target } : {}),
        ...(transportStamp ? { transportStamp } : {}),
        replyToMessageId: value.replyToMessageId,
        ...(typeof value.guestQueryId === "string"
            ? { guestQueryId: value.guestQueryId }
            : {}),
        ...(typeof value.guestInlineMessageId === "string"
            ? { guestInlineMessageId: value.guestInlineMessageId }
            : {}),
        queueOrder: value.queueOrder,
        queueLane,
        laneOrder: value.laneOrder,
        statusSummary: value.statusSummary,
        admissionReceipts: admissionReceipts,
    };
    if (queueKind === "control") {
        if (value.queueLane !== "control" ||
            (value.controlType !== "status" && value.controlType !== "model")) {
            return undefined;
        }
        return { kind: "control", controlType: value.controlType, ...base };
    }
    if (value.queueLane === "control" ||
        !Array.isArray(value.sourceMessageIds) ||
        value.sourceMessageIds.some((id) => !Number.isSafeInteger(id)) ||
        !Array.isArray(value.queuedAttachments) ||
        value.queuedAttachments.some((attachment) => !isRecord(attachment) ||
            typeof attachment.path !== "string" ||
            typeof attachment.fileName !== "string") ||
        !Array.isArray(value.content) ||
        value.content.some((content) => !isRecord(content) ||
            (content.type === "text"
                ? typeof content.text !== "string"
                : content.type === "image"
                    ? typeof content.data !== "string" ||
                        typeof content.mimeType !== "string"
                    : true)) ||
        typeof value.historyText !== "string" ||
        (value.priorityEmoji !== undefined &&
            typeof value.priorityEmoji !== "string") ||
        (value.reactionSuppressionEmoji !== undefined &&
            typeof value.reactionSuppressionEmoji !== "string") ||
        (value.voiceReplyPreferred !== undefined &&
            typeof value.voiceReplyPreferred !== "boolean") ||
        (value.voiceReplyRequired !== undefined &&
            typeof value.voiceReplyRequired !== "boolean")) {
        return undefined;
    }
    return {
        kind: "prompt",
        ...base,
        sourceMessageIds: value.sourceMessageIds,
        queuedAttachments: value.queuedAttachments,
        content: value.content,
        historyText: value.historyText,
        ...(typeof value.priorityEmoji === "string"
            ? { priorityEmoji: value.priorityEmoji }
            : {}),
        ...(typeof value.reactionSuppressionEmoji === "string"
            ? { reactionSuppressionEmoji: value.reactionSuppressionEmoji }
            : {}),
        ...(typeof value.voiceReplyPreferred === "boolean"
            ? { voiceReplyPreferred: value.voiceReplyPreferred }
            : {}),
        ...(typeof value.voiceReplyRequired === "boolean"
            ? { voiceReplyRequired: value.voiceReplyRequired }
            : {}),
    };
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
    const payload = parseQueueHandoffPayload(value.payload);
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
function parseCallApiEnvelope(value, requestId) {
    return typeof value.instanceId === "string" &&
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
            code === "workspace-binding-unavailable") {
            const chatId = value.error.chatId;
            const threadId = value.error.threadId;
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
        if (typeof value.sessionId !== "string" || !value.sessionId ||
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
function parseTarget(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value) || typeof value.chatId !== "number")
        return undefined;
    return typeof value.threadId === "number"
        ? { chatId: value.chatId, threadId: value.threadId }
        : { chatId: value.chatId };
}
function parseThreadTarget(value) {
    const target = parseTarget(value);
    return target && typeof target.threadId === "number"
        ? { chatId: target.chatId, threadId: target.threadId }
        : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
