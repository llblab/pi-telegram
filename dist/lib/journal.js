/**
 * Telegram durable inbound update journal
 * Zones: telegram inbound, filesystem authority, crash recovery
 * Owns profile/bot-scoped raw updates, schema validation, deduplication,
 * bounded atomic publication, durable queue-receipt/failure state, and compaction.
 * It does not own polling, update execution, queue admission, or follower routing.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TELEGRAM_STRICT_READ_FLAGS, renameTelegramPathWithRetry, withTelegramFileTransaction, } from "./locks.js";
import { decodeTelegramSessionDirectoryName, getTelegramProfilePathSuffix, resolveTelegramRuntimeDir, TELEGRAM_DEFAULT_PROFILE_NAME, } from "./paths.js";
import { getTelegramProcessLiveness, } from "./process-identity.js";
import { hasOnlyWireKeys as hasOnlyKeys, isNonEmptyWireString as isNonEmptyString, isWireRecord as isRecord, isNonNegativeWireInteger as isSafeNonNegativeInteger, } from "./wire.js";
import { getTelegramWorkspaceAdmissionScopeKey, runWithTelegramWorkspaceAdmissions, } from "./workspace-admission.js";
export const TELEGRAM_UPDATE_JOURNAL_VERSION = 1;
export const TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION = 2;
export const TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION = 3;
const TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION = 4;
// Receipt and binding identities survive storage-schema upgrades.
const TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION = 1;
const TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES = 10_000;
const TELEGRAM_UPDATE_JOURNAL_MAX_BYTES = 32 * 1024 * 1024;
const TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH = 128;
export const TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH = 256;
const TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH = 256;
const TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES = 4 * 1024;
const TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES = 64;
const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH = 128;
const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MIN_LENGTH = 32;
const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MAX_LENGTH = 256;
export const TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH = 128;
export const TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH = 512;
function escapeTelegramJournalPathPattern(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
/** Read-only discovery for canonical follower journal snapshots and segment roots. */
export function discoverTelegramFollowerJournalPaths(input) {
    const suffix = escapeTelegramJournalPathPattern(getTelegramProfilePathSuffix(input.profileName));
    const pattern = new RegExp(`^(follower-inbox-[a-f0-9]{16}${suffix}\\.json)(?:\\.segments)?$`, "u");
    let entries;
    try {
        entries = readdirSync(input.directory, { withFileTypes: true });
    }
    catch (error) {
        return error.code === "ENOENT"
            ? { paths: [], complete: true }
            : { paths: [], complete: false };
    }
    const paths = new Set();
    let complete = true;
    for (const entry of entries) {
        const match = pattern.exec(entry.name);
        if (!match)
            continue;
        const candidatePath = join(input.directory, entry.name);
        const expectsDirectory = entry.name.endsWith(".segments");
        try {
            const stat = statSync(candidatePath);
            if (expectsDirectory ? !stat.isDirectory() : !stat.isFile()) {
                complete = false;
                continue;
            }
            paths.add(join(input.directory, match[1]));
        }
        catch {
            complete = false;
        }
    }
    return { paths: Array.from(paths).sort(), complete };
}
/** Bounded read-only session-family discovery, not writer closure or deletion authority. */
export function discoverTelegramSessionJournalPaths(input) {
    const maxEntries = input.maxDirectoryEntries ?? 10_000;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
        return { paths: [], complete: false };
    const root = join(input.directory, "sessions");
    const suffix = getTelegramProfilePathSuffix(input.profileName);
    const paths = new Set();
    let remaining = maxEntries;
    let complete = true;
    const scan = (directory) => {
        const entries = [];
        const handle = opendirSync(directory);
        try {
            for (;;) {
                const entry = handle.readSync();
                if (!entry)
                    break;
                if (--remaining < 0) {
                    complete = false;
                    break;
                }
                entries.push(entry);
            }
        }
        finally {
            handle.closeSync();
        }
        return entries;
    };
    try {
        const stat = lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return { paths: [], complete: false };
    }
    catch (error) {
        return {
            paths: [],
            complete: error.code === "ENOENT",
        };
    }
    try {
        for (const session of scan(root)) {
            if (!complete)
                break;
            if (!session.isDirectory() ||
                decodeTelegramSessionDirectoryName(session.name) === undefined) {
                complete = false;
                break;
            }
            const directory = join(root, session.name);
            const sessionStat = lstatSync(directory);
            if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
                complete = false;
                break;
            }
            for (const entry of scan(directory)) {
                if (!complete)
                    break;
                // The leader polling journal and legacy recovery folders are not recipient custody.
                if (entry.name === "recovery" ||
                    /^inbox(?:\.[a-zA-Z0-9._-]+)?\.json(?:\.segments|\.retained)?$/u.test(entry.name))
                    continue;
                const match = /^journal\.([a-f0-9]{16})(\.[a-zA-Z0-9._-]+)?\.json(\.segments|\.retained)?$/u.exec(entry.name);
                if (!match) {
                    complete = false;
                    break;
                }
                const stat = lstatSync(join(directory, entry.name));
                if (stat.isSymbolicLink() ||
                    (match[3] ? !stat.isDirectory() : !stat.isFile())) {
                    complete = false;
                    break;
                }
                if ((match[2] ?? "") !== suffix)
                    continue;
                paths.add(join(directory, entry.name.replace(/\.(?:segments|retained)$/u, "")));
            }
        }
    }
    catch {
        complete = false;
    }
    return { paths: Array.from(paths).sort(), complete };
}
/** Transitional discovery covers both retained flat recipients and session-owned families. */
export function discoverTelegramRecipientJournalPaths(input) {
    const legacy = discoverTelegramFollowerJournalPaths(input);
    const sessions = discoverTelegramSessionJournalPaths(input);
    return {
        paths: Array.from(new Set([...legacy.paths, ...sessions.paths])).sort(),
        complete: legacy.complete && sessions.complete,
    };
}
const TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH = 256;
export const TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT = 256;
export const TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES = 4 * 1024 * 1024;
export class TelegramUpdateJournalError extends Error {
    code;
    path;
    constructor(code, path, message, options = {}) {
        super(message, options);
        this.name = "TelegramUpdateJournalError";
        this.code = code;
        this.path = path;
    }
}
const TELEGRAM_UPDATE_CHAT_CARRIERS = new Set([
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "business_message",
    "edited_business_message",
    "message_reaction",
    "message_reaction_count",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
    "chat_boost",
    "removed_chat_boost",
    "deleted_business_messages",
]);
function getUpdateCarrierScope(value) {
    if (!isRecord(value) || !isRecord(value.chat))
        return undefined;
    const chatId = value.chat.id;
    if (!Number.isSafeInteger(chatId) || chatId === 0)
        return undefined;
    const threadId = value.message_thread_id;
    if (threadId === undefined)
        return { kind: "chat", chatId: chatId };
    if (!Number.isSafeInteger(threadId) || threadId <= 0) {
        return undefined;
    }
    return {
        kind: "target",
        target: { chatId: chatId, threadId: threadId },
    };
}
function getUpdateAdmissionScope(update) {
    const payloadKeys = Object.keys(update).filter((key) => key !== "update_id");
    if (payloadKeys.length !== 1)
        return { kind: "profile" };
    const payloadKey = payloadKeys[0];
    if (TELEGRAM_UPDATE_CHAT_CARRIERS.has(payloadKey)) {
        return getUpdateCarrierScope(update[payloadKey]) ?? { kind: "profile" };
    }
    if (payloadKey === "callback_query") {
        const query = update.callback_query;
        return isRecord(query)
            ? (getUpdateCarrierScope(query.message) ?? { kind: "profile" })
            : { kind: "profile" };
    }
    return { kind: "profile" };
}
export function getTelegramUpdateJournalAdmissionScopes(updates) {
    if (updates.length === 0)
        return [{ kind: "profile" }];
    const scopes = updates.map(getUpdateAdmissionScope);
    if (scopes.some((scope) => scope.kind === "profile")) {
        return [{ kind: "profile" }];
    }
    const chatIds = new Set(scopes
        .filter((scope) => scope.kind === "chat")
        .map((scope) => scope.chatId));
    const unique = new Map();
    for (const scope of scopes) {
        if (scope.kind === "target" && chatIds.has(scope.target.chatId))
            continue;
        unique.set(getTelegramWorkspaceAdmissionScopeKey(scope), scope);
    }
    return Array.from(unique.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, scope]) => scope);
}
function listTelegramUpdateJournalLegacyCustodyCandidates(snapshot) {
    return snapshot.entries
        .flatMap((entry) => {
        const evidence = createTelegramUpdateJournalLegacyCustodyEvidence(entry);
        return evidence
            ? [
                {
                    updateId: evidence.updateId,
                    state: evidence.state,
                    attemptCount: evidence.attemptCount,
                    failureClass: evidence.failureClass,
                    evidenceSha256: evidence.evidenceSha256,
                },
            ]
            : [];
    })
        .sort((left, right) => left.updateId - right.updateId);
}
export function createTelegramUpdateJournalLegacyCustodyEvidence(entry) {
    if ((entry.state !== "retry-wait" && entry.state !== "failed") ||
        !entry.failure ||
        entry.inputClaim ||
        entry.inputProvenance)
        return undefined;
    const base = {
        updateId: entry.updateId,
        state: entry.state,
        attemptCount: entry.failure.attemptCount,
        failedAtMs: entry.failure.failedAtMs,
        failureClass: entry.failure.failureClass,
        summary: entry.failure.summary,
        ...(entry.nextRetryAtMs === undefined
            ? {}
            : { nextRetryAtMs: entry.nextRetryAtMs }),
        ...(entry.terminalAtMs === undefined
            ? {}
            : { terminalAtMs: entry.terminalAtMs }),
        ...(entry.terminalReason === undefined
            ? {}
            : { terminalReason: entry.terminalReason }),
        ...(entry.terminalFailureId === undefined
            ? {}
            : { terminalFailureId: entry.terminalFailureId }),
    };
    return {
        ...base,
        evidenceSha256: createHash("sha256")
            .update(JSON.stringify(base))
            .digest("hex"),
    };
}
export function normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(value, expected) {
    if (!isRecord(value))
        return undefined;
    const keys = [
        "version",
        "dispositionId",
        "updateId",
        "evidenceSha256",
        "action",
        "operatorAuthorityId",
        "authorizedAtMs",
    ];
    if (Object.keys(value).some((key) => !keys.includes(key)) ||
        value.version !== 1 ||
        !isBoundedString(value.dispositionId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
        value.updateId !== expected.updateId ||
        value.evidenceSha256 !== expected.evidenceSha256 ||
        (value.action !== "requeue-v3" && value.action !== "discard") ||
        !isBoundedString(value.operatorAuthorityId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
        !isSafeNonNegativeInteger(value.authorizedAtMs))
        return undefined;
    return {
        version: 1,
        dispositionId: value.dispositionId,
        updateId: expected.updateId,
        evidenceSha256: expected.evidenceSha256,
        action: value.action,
        operatorAuthorityId: value.operatorAuthorityId,
        authorizedAtMs: value.authorizedAtMs,
    };
}
export const TELEGRAM_ROUTING_INPUT_TTL_MS = 60 * 60 * 1000;
function isTelegramUpdateJournalRoutingChooser(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["chatId", "threadId", "messageId"]) &&
        Number.isSafeInteger(value.chatId) &&
        (value.threadId === undefined || isSafePositiveInteger(value.threadId)) &&
        isSafePositiveInteger(value.messageId));
}
export function createTelegramUpdateJournalEntryDigest(entry) {
    return {
        updateId: entry.updateId,
        sourceSha256: createHash("sha256")
            .update(JSON.stringify(entry))
            .digest("hex"),
    };
}
function inspectRoutingInputExpiry(file, journalBindingKey, updateId) {
    const disposition = file.operatorDispositions?.find((value) => value.updateId === updateId &&
        "dispositionKind" in value &&
        value.dispositionKind === "legacy-custody" &&
        value.action === "discard" &&
        value.failureId === `routing-expiry:${value.evidenceSha256}`);
    if (!disposition ||
        !("operatorAuthorityId" in disposition) ||
        file.entries.some((entry) => entry.updateId === updateId))
        return undefined;
    return {
        journalBindingKey,
        updateId,
        operatorAuthorityId: disposition.operatorAuthorityId,
    };
}
function inspectRoutingGroupExpiry(file, journalBindingKey, updateIds) {
    if (!Array.isArray(updateIds) ||
        !updateIds.length ||
        updateIds.length > TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES ||
        updateIds.some((id, index) => !isSafeNonNegativeInteger(id) ||
            (index > 0 && id <= updateIds[index - 1])))
        return undefined;
    if (file.entries.some((entry) => updateIds.includes(entry.updateId)))
        return undefined;
    const expired = updateIds
        .map((id) => inspectRoutingInputExpiry(file, journalBindingKey, id))
        .filter((value) => value !== undefined);
    if (!expired.length ||
        expired.some((value) => value.operatorAuthorityId !== expired[0].operatorAuthorityId))
        return undefined;
    // Some members may have been acknowledged earlier. Whole donor absence plus one exact expiry ends this known cohort,
    // not recipient custody; fresh Thread protection still independently gates deletion.
    return updateIds.map((updateId) => ({
        journalBindingKey,
        updateId,
        operatorAuthorityId: expired[0].operatorAuthorityId,
    }));
}
function createJournalError(code, path, detail, cause) {
    return new TelegramUpdateJournalError(code, path, `Telegram update journal ${detail}: ${path}`, cause === undefined ? undefined : { cause });
}
function isSafePositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function isBoundedString(value, maxLength) {
    return isNonEmptyString(value) && value.length <= maxLength;
}
function validateBotIdentity(value, path) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["botId", "tokenSha256"]) ||
        !isNonEmptyString(value.tokenSha256) ||
        !/^[a-f0-9]{64}$/u.test(value.tokenSha256) ||
        (value.botId !== undefined && !isSafePositiveInteger(value.botId))) {
        throw createJournalError("invalid", path, "has invalid bot identity");
    }
    return {
        ...(value.botId !== undefined ? { botId: value.botId } : {}),
        tokenSha256: value.tokenSha256,
    };
}
function validateJournaledUpdate(value, path) {
    if (!isRecord(value) || !isSafeNonNegativeInteger(value.update_id)) {
        throw createJournalError("invalid", path, "contains an update without a safe integer update_id");
    }
    return value;
}
function normalizeIncomingJournaledUpdate(value, path) {
    let normalized;
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new Error("Update is not JSON serializable.");
        }
        normalized = JSON.parse(serialized);
    }
    catch (error) {
        throw createJournalError("invalid", path, "received a non-JSON update", error);
    }
    return validateJournaledUpdate(normalized, path);
}
function validateJournalQueueOwnerIdentity(value, path) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "instanceId",
            "processId",
            "processBirthId",
            "sessionGeneration",
        ]) ||
        !isBoundedString(value.instanceId, TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH) ||
        !isSafePositiveInteger(value.processId) ||
        !isBoundedString(value.processBirthId, TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH) ||
        !isSafePositiveInteger(value.sessionGeneration)) {
        throw createJournalError("invalid", path, "contains invalid queue owner identity");
    }
    return {
        instanceId: value.instanceId,
        processId: value.processId,
        processBirthId: value.processBirthId,
        sessionGeneration: value.sessionGeneration,
    };
}
function validateJournalQueueOwner(value, path) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "instanceId",
            "processId",
            "processBirthId",
            "sessionGeneration",
            "acquisitionId",
            "acquiredAtMs",
            "handoffId",
        ]) ||
        !isBoundedString(value.acquisitionId, TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH) ||
        !isSafeNonNegativeInteger(value.acquiredAtMs) ||
        (value.handoffId !== undefined &&
            !isBoundedString(value.handoffId, TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH))) {
        throw createJournalError("invalid", path, "contains invalid queue receipt acquisition");
    }
    const identity = validateJournalQueueOwnerIdentity({
        instanceId: value.instanceId,
        processId: value.processId,
        processBirthId: value.processBirthId,
        sessionGeneration: value.sessionGeneration,
    }, path);
    return {
        ...identity,
        acquisitionId: value.acquisitionId,
        acquiredAtMs: value.acquiredAtMs,
        ...(typeof value.handoffId === "string"
            ? { handoffId: value.handoffId }
            : {}),
    };
}
export function parseTelegramUpdateJournalQueueOwner(value) {
    try {
        return validateJournalQueueOwner(value, "Telegram queue handoff acknowledgement");
    }
    catch {
        return undefined;
    }
}
export function isTelegramUpdateJournalQueueOwnerProcess(owner, identity) {
    return (owner.instanceId === identity.instanceId &&
        owner.processId === identity.processId &&
        owner.processBirthId === identity.processBirthId);
}
export function areTelegramUpdateJournalQueueOwnersEqual(left, right) {
    return (isTelegramUpdateJournalQueueOwnerProcess(left, right) &&
        left.sessionGeneration === right.sessionGeneration &&
        left.acquisitionId === right.acquisitionId &&
        left.acquiredAtMs === right.acquiredAtMs &&
        left.handoffId === right.handoffId);
}
function cloneJournalQueueOwner(owner) {
    return { ...owner };
}
function createTelegramUpdateQueueHandoffId(input) {
    return `handoff-${createHash("sha256")
        .update(JSON.stringify({
        version: 1,
        token: input.handoffToken,
        queueKind: input.queueKind,
        receiptId: input.receiptId,
        sourceUpdateIds: [...input.sourceUpdateIds].sort((a, b) => a - b),
        donorAcquisitionId: input.expectedOwner.acquisitionId,
        recipientOwner: input.recipientOwner,
    }))
        .digest("hex")
        .slice(0, 32)}`;
}
function isTelegramInputHandoffId(value) {
    return (isBoundedString(value, TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH) && /^input-handoff-[a-f0-9]{32}$/u.test(value));
}
function createTelegramInputHandoffId(input) {
    return `input-handoff-${createHash("sha256")
        .update(JSON.stringify({
        version: 1,
        token: input.handoffToken,
        source: input.journalBindingKey,
        updateId: input.updateId,
        donorOwner: input.donorOwner,
        recipientOwner: input.recipientOwner,
        recipientBindingKey: input.recipientBindingKey,
    }))
        .digest("hex")
        .slice(0, 32)}`;
}
function validateJournalHandoff(value, path, kind) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["handoffId", "offeredAtMs", "recipientOwner"]) ||
        !isBoundedString(value.handoffId, TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH) ||
        !isSafeNonNegativeInteger(value.offeredAtMs)) {
        throw createJournalError("invalid", path, `contains invalid ${kind} handoff metadata`);
    }
    return {
        handoffId: value.handoffId,
        offeredAtMs: value.offeredAtMs,
        recipientOwner: validateJournalQueueOwnerIdentity(value.recipientOwner, path),
    };
}
function cloneJournalQueueHandoff(handoff) {
    return {
        ...handoff,
        recipientOwner: { ...handoff.recipientOwner },
    };
}
function validateJournalFailure(value, path) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "attemptCount",
            "failedAtMs",
            "failureClass",
            "summary",
        ]) ||
        !isSafePositiveInteger(value.attemptCount) ||
        !isSafeNonNegativeInteger(value.failedAtMs) ||
        !isBoundedString(value.failureClass, TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH) ||
        !isBoundedString(value.summary, TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH)) {
        throw createJournalError("invalid", path, "contains invalid execution failure metadata");
    }
    return {
        attemptCount: value.attemptCount,
        failedAtMs: value.failedAtMs,
        failureClass: value.failureClass,
        summary: value.summary,
    };
}
function createTelegramUpdateTerminalFailureId(input) {
    return `failure-${createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex")
        .slice(0, 32)}`;
}
function validateJournalOperatorDisposition(value, path) {
    if (isRecord(value) && value.dispositionKind === "legacy-custody") {
        if (!hasOnlyKeys(value, [
            "dispositionKind",
            "failureId",
            "updateId",
            "action",
            "committedAtMs",
            "evidenceSha256",
            "operatorAuthorityId",
            "authorizedAtMs",
        ]) ||
            !isBoundedString(value.failureId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
            !isSafeNonNegativeInteger(value.updateId) ||
            (value.action !== "requeue-v3" && value.action !== "discard") ||
            !isSafeNonNegativeInteger(value.committedAtMs) ||
            typeof value.evidenceSha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(value.evidenceSha256) ||
            !isBoundedString(value.operatorAuthorityId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
            !isSafeNonNegativeInteger(value.authorizedAtMs) ||
            value.committedAtMs < value.authorizedAtMs)
            throw createJournalError("invalid", path, "contains invalid legacy custody disposition metadata");
        return {
            dispositionKind: "legacy-custody",
            failureId: value.failureId,
            updateId: value.updateId,
            action: value.action,
            committedAtMs: value.committedAtMs,
            evidenceSha256: value.evidenceSha256,
            operatorAuthorityId: value.operatorAuthorityId,
            authorizedAtMs: value.authorizedAtMs,
        };
    }
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "failureId",
            "updateId",
            "action",
            "committedAtMs",
            "attemptCount",
            "failureClass",
            "terminalAtMs",
            "terminalReason",
        ]) ||
        !isBoundedString(value.failureId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
        !isSafeNonNegativeInteger(value.updateId) ||
        (value.action !== "retry" && value.action !== "discard") ||
        !isSafeNonNegativeInteger(value.committedAtMs) ||
        !isSafePositiveInteger(value.attemptCount) ||
        !isBoundedString(value.failureClass, TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH) ||
        !isSafeNonNegativeInteger(value.terminalAtMs) ||
        value.committedAtMs < value.terminalAtMs ||
        !isBoundedString(value.terminalReason, TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH))
        throw createJournalError("invalid", path, "contains invalid operator disposition metadata");
    return {
        failureId: value.failureId,
        updateId: value.updateId,
        action: value.action,
        committedAtMs: value.committedAtMs,
        attemptCount: value.attemptCount,
        failureClass: value.failureClass,
        terminalAtMs: value.terminalAtMs,
        terminalReason: value.terminalReason,
    };
}
function journalRequiresExclusion(version) {
    return (version === TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION ||
        journalHasCustodyFields(version));
}
function journalHasCustodyFields(version) {
    return version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION ||
        version === TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION;
}
/** Only legacy v1 carries routing-lifetime, scoped-ACK and pairing-free queue-receipt semantics. */
export function isTelegramUpdateJournalLegacyFamilyVersion(version) {
    return version === TELEGRAM_UPDATE_JOURNAL_VERSION;
}
function privateReplyRecord(value, required, optional = []) {
    return isRecord(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
        required.every(key => Object.hasOwn(value, key)) &&
        Reflect.ownKeys(value).every(key => typeof key === "string" &&
            (required.includes(key) || optional.includes(key)) &&
            Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}
function privateReplyString(value, units = 256, bytes = 1024) {
    return typeof value === "string" && value.trim().length > 0 &&
        value.length <= units && Buffer.byteLength(value) <= bytes;
}
function privateReplyTarget(value) {
    return privateReplyRecord(value, ["chatId"], ["threadId"]) &&
        isSafePositiveInteger(value.chatId) &&
        (!Object.hasOwn(value, "threadId") || isSafePositiveInteger(value.threadId));
}
function privateReplyCapabilities(value) {
    if (!Array.isArray(value) || value.length > 64 || Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value") ||
            !privateReplyString(descriptor.value, 128, 512))
            return false;
    }
    return new Set(value).size === value.length;
}
function validatePrivateTextReply(value, path, updateId) {
    const invalid = () => { throw createJournalError("invalid", path, "contains invalid private Text Input evidence"); };
    const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    if (!privateReplyRecord(value, ["source", "expectedSource", "destination"]))
        return invalid();
    const { source, expectedSource, destination: d } = value;
    if (!privateReplyRecord(source, ["journalBindingKey", "tokenSha256", "updateId"]) ||
        !privateReplyString(source.journalBindingKey) || !hash(source.tokenSha256) ||
        !isSafeNonNegativeInteger(source.updateId) || source.updateId !== updateId ||
        !privateReplyRecord(expectedSource, ["updateId", "sourceSha256"]) ||
        expectedSource.updateId !== updateId || !hash(expectedSource.sourceSha256) ||
        !privateReplyRecord(d, ["profile", "botIdentity", "operatorUserId", "sourceTarget", "sourceMessageId",
            "publicationTarget", "publicationMessageId", "requestNonce", "receiver"]) ||
        !privateReplyString(d.profile) || !privateReplyString(d.requestNonce) ||
        !privateReplyRecord(d.botIdentity, ["botId", "tokenSha256"]) ||
        !isSafePositiveInteger(d.botIdentity.botId) || !hash(d.botIdentity.tokenSha256) ||
        d.botIdentity.tokenSha256 !== source.tokenSha256 ||
        !isSafePositiveInteger(d.operatorUserId) || !isSafePositiveInteger(d.sourceMessageId) ||
        !isSafePositiveInteger(d.publicationMessageId) || !privateReplyTarget(d.sourceTarget) ||
        !privateReplyTarget(d.publicationTarget))
        return invalid();
    const r = d.receiver;
    const strings = ["instanceId", "profileKey", "bindingKey", "registrationGeneration", "sessionId", "processBirthId"];
    if (!privateReplyRecord(r, [...strings, "sessionGeneration", "pid", "cwd", "endpoint", "protocol"], ["slot", "target"]) ||
        !strings.every(key => privateReplyString(r[key])) ||
        !isSafeNonNegativeInteger(r.sessionGeneration) || !isSafePositiveInteger(r.pid) ||
        !privateReplyString(r.cwd, 4096, 4096) || !privateReplyString(r.endpoint, 4096, 4096) ||
        (Object.hasOwn(r, "slot") && (typeof r.slot !== "string" || !/^[A-Z]$/u.test(r.slot))) ||
        (Object.hasOwn(r, "target") ? !privateReplyTarget(r.target) || !isDeepStrictEqual(r.target, d.publicationTarget)
            : d.publicationTarget.threadId !== undefined) ||
        !privateReplyRecord(r.protocol, ["protocolVersion", "runtimeBuild", "capabilities"]) ||
        !isSafePositiveInteger(r.protocol.protocolVersion) || !privateReplyString(r.protocol.runtimeBuild) ||
        !privateReplyCapabilities(r.protocol.capabilities))
        return invalid();
    const cloned = structuredClone(value);
    if (Buffer.byteLength(JSON.stringify(cloned)) > 16 * 1024)
        return invalid();
    return cloned;
}
/** Explicit data codec only. Existing journal stores continue refusing v5, including recovery paths. */
export function decodeTelegramTextInputSourceJournalCandidate(serialized, path) {
    const invalid = () => { throw createJournalError("invalid", path, "contains invalid original Text Input association"); };
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > TELEGRAM_UPDATE_JOURNAL_MAX_BYTES)
        return invalid();
    let value;
    try {
        value = JSON.parse(serialized);
    }
    catch {
        return invalid();
    }
    if (!isRecord(value))
        return invalid();
    if (value.version !== 5)
        throw createJournalError("unsupported-version", path, "requires explicit Text Input candidate version 5");
    if (!Array.isArray(value.entries) || value.entries.length > TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES)
        return invalid();
    const associations = value.entries.map(row => isRecord(row) && Object.hasOwn(row, "privateTextInput")
        ? { present: true, value: row.privateTextInput } : { present: false, value: undefined });
    // Reuse v4's common envelope/entry validation, never its store or execution surface.
    const base = parseJournalFile({ ...value, version: 4, entries: value.entries.map(row => {
            if (!isRecord(row))
                return row;
            const { privateTextInput: _association, ...entry } = row;
            return entry;
        }) }, path, 4);
    const bindingKey = createTelegramUpdateJournalBindingKey({ path, profileName: base.profile, botIdentity: base.botIdentity });
    const entries = base.entries.map((entry, index) => {
        if (!associations[index].present)
            return entry;
        const a = associations[index].value;
        if (!privateReplyRecord(a, ["source", "expectedSource", "requestNonce", "operatorUserId", "target", "receiver"]) ||
            !privateReplyRecord(a.source, ["journalBindingKey", "tokenSha256", "updateId"]) ||
            a.source.journalBindingKey !== bindingKey || a.source.tokenSha256 !== base.botIdentity.tokenSha256 || a.source.updateId !== entry.updateId ||
            !privateReplyRecord(a.expectedSource, ["updateId", "sourceSha256"]) ||
            !isDeepStrictEqual(a.expectedSource, createTelegramUpdateJournalEntryDigest(entry)) ||
            typeof a.requestNonce !== "string" || !/^[a-f0-9]{32}$/u.test(a.requestNonce) ||
            !isSafePositiveInteger(a.operatorUserId) || !privateReplyTarget(a.target) || !isSafePositiveInteger(base.botIdentity.botId) ||
            entry.state !== "pending" || entry.preApprovalExcluded !== false || entry.inputClaim || entry.inputProvenance || entry.privateTextReply ||
            entry.queueOwner || entry.queueHandoff || entry.queueReceiptId || entry.queueKind)
            return invalid();
        const receiver = a.receiver, message = entry.update.message;
        if (!privateReplyRecord(receiver, ["instanceId", "processId", "processBirthId", "sessionGeneration", "sessionId", "bindingKey", "deliveryGeneration"]) ||
            !["instanceId", "processBirthId", "sessionId", "bindingKey", "deliveryGeneration"].every(key => privateReplyString(receiver[key])) ||
            !isSafePositiveInteger(receiver.processId) || !isSafeNonNegativeInteger(receiver.sessionGeneration) ||
            entry.update.edited_message !== undefined || !isRecord(message) || !isRecord(message.from) || !isRecord(message.chat) ||
            message.from.is_bot !== false || message.from.id !== a.operatorUserId || !isSafePositiveInteger(message.message_id) ||
            message.chat.type !== "private" || !isDeepStrictEqual(a.target, { chatId: message.chat.id,
            ...(message.message_thread_id === undefined ? {} : { threadId: message.message_thread_id }) }))
            return invalid();
        if (Buffer.byteLength(JSON.stringify(a)) > 16 * 1024)
            return invalid();
        return { ...entry, privateTextInput: structuredClone(a) };
    });
    return { ...base, version: 5, entries };
}
const TEXT_SOURCE_USE_KEY = Symbol("native original Text source use");
class NativeTextSourceUse {
    #input;
    #assert;
    #spent = false;
    #lost = false;
    constructor(key, input, guard) {
        if (key !== TEXT_SOURCE_USE_KEY)
            throw new Error("Text source use is unavailable.");
        this.#input = input;
        this.#assert = guard;
        Object.freeze(this);
    }
    static read(value, consume) {
        if (!value.#assert || value.#spent || value.#lost) {
            value.#lost = true;
            throw new Error("Text source use is unavailable.");
        }
        if (consume) {
            value.#spent = true;
            try {
                value.#assert();
                if (value.#lost)
                    throw new Error("Text source use is unavailable.");
            }
            catch (error) {
                value.#lost = true;
                throw error;
            }
        }
        return value.#input;
    }
    static close(value) { value.#assert = undefined; return value.#spent && !value.#lost; }
}
const readNativeTextSourceUse = NativeTextSourceUse.read;
/** Peek is immutable data only. Consume is one spent-before-probes native source barrier, never an SDK result. */
export function readTelegramNativeTextSourceUse(value, consume = false) {
    return readNativeTextSourceUse(value, consume);
}
function assertPrivateTextReplyContinuity(previous, entry, path) {
    if (previous?.privateTextReply && !isDeepStrictEqual(previous.privateTextReply, entry.privateTextReply))
        throw createJournalError("conflict", path, "changes immutable private Text Input evidence");
}
function validateJournalInputClaim(value, path, updateId) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "phase",
            "owner",
            "recipientBindingKey",
            "handoff",
            "executionUpdate",
        ]) ||
        (value.phase !== "ready" && value.phase !== "running") ||
        !isBoundedString(value.recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
        !value.recipientBindingKey.trim()) {
        throw createJournalError("invalid", path, "contains invalid input claim metadata");
    }
    const owner = validateJournalQueueOwner(value.owner, path);
    const handoff = value.handoff === undefined
        ? undefined
        : validateJournalHandoff(value.handoff, path, "input");
    if ((owner.handoffId !== undefined &&
        !isTelegramInputHandoffId(owner.handoffId)) ||
        (handoff &&
            (!isTelegramInputHandoffId(handoff.handoffId) ||
                value.phase !== "ready" ||
                isTelegramUpdateJournalQueueOwnerProcess(owner, handoff.recipientOwner)))) {
        throw createJournalError("invalid", path, "contains conflicting input handoff metadata");
    }
    const executionUpdate = value.executionUpdate === undefined
        ? undefined
        : validateJournaledUpdate(value.executionUpdate, path);
    if (executionUpdate && executionUpdate.update_id !== updateId) {
        throw createJournalError("invalid", path, "contains an input claim/update id mismatch");
    }
    return {
        phase: value.phase,
        owner,
        recipientBindingKey: value.recipientBindingKey,
        ...(handoff ? { handoff } : {}),
        ...(executionUpdate ? { executionUpdate } : {}),
    };
}
function validateJournalInputProvenance(value, path, updateId) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["owner", "recipientBindingKey", "executionUpdate"]) ||
        !isBoundedString(value.recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
        !value.recipientBindingKey.trim()) {
        throw createJournalError("invalid", path, "contains invalid input queue provenance");
    }
    const owner = validateJournalQueueOwner(value.owner, path);
    if (owner.handoffId !== undefined &&
        !isTelegramInputHandoffId(owner.handoffId)) {
        throw createJournalError("invalid", path, "contains invalid input queue provenance");
    }
    const executionUpdate = value.executionUpdate === undefined
        ? undefined
        : validateJournaledUpdate(value.executionUpdate, path);
    if (executionUpdate && executionUpdate.update_id !== updateId) {
        throw createJournalError("invalid", path, "contains an input provenance/update id mismatch");
    }
    return {
        owner,
        recipientBindingKey: value.recipientBindingKey,
        ...(executionUpdate ? { executionUpdate } : {}),
    };
}
function validateJournalEntry(value, path, version) {
    if (journalRequiresExclusion(version) &&
        (!isRecord(value) ||
            typeof value.preApprovalExcluded !== "boolean" ||
            (value.preApprovalExcluded && value.state === "queued"))) {
        throw createJournalError("pairing-evidence", path, "contains missing, malformed, or queued exclusion evidence");
    }
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "updateId",
            "update",
            "admittedAtMs",
            ...(isTelegramUpdateJournalLegacyFamilyVersion(version)
                ? ["routingInput"]
                : []),
            "state",
            "queueKind",
            "queueReceiptId",
            "queueOwner",
            "queueHandoff",
            "failure",
            "nextRetryAtMs",
            "terminalAtMs",
            "terminalReason",
            "terminalFailureId",
            ...(journalRequiresExclusion(version) ? ["preApprovalExcluded"] : []),
            ...(journalHasCustodyFields(version)
                ? ["inputClaim", "inputProvenance"]
                : []),
            ...(version === TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION ? ["privateTextReply"] : []),
        ]) ||
        !isSafeNonNegativeInteger(value.updateId) ||
        !isSafeNonNegativeInteger(value.admittedAtMs) ||
        (value.state !== "pending" &&
            value.state !== "retry-wait" &&
            value.state !== "queued" &&
            value.state !== "failed")) {
        throw createJournalError("invalid", path, "contains an invalid entry");
    }
    const update = validateJournaledUpdate(value.update, path);
    if (update.update_id !== value.updateId) {
        throw createJournalError("invalid", path, "contains an entry/update id mismatch");
    }
    let routingInput;
    if (value.routingInput !== undefined) {
        const routing = value.routingInput;
        if (!isRecord(routing) ||
            !hasOnlyKeys(routing, [
                "operatorUserId",
                "publishedAtMs",
                "expiresAtMs",
                "phase",
                "chooser",
            ]) ||
            (routing.chooser !== undefined &&
                !isTelegramUpdateJournalRoutingChooser(routing.chooser)) ||
            !isSafePositiveInteger(routing.operatorUserId) ||
            !isSafeNonNegativeInteger(routing.publishedAtMs) ||
            routing.publishedAtMs < value.admittedAtMs ||
            !isSafeNonNegativeInteger(routing.expiresAtMs) ||
            routing.expiresAtMs !==
                routing.publishedAtMs + TELEGRAM_ROUTING_INPUT_TTL_MS ||
            (routing.phase !== "waiting" && routing.phase !== "selected") ||
            (routing.phase === "waiting" && value.state === "queued")) {
            throw createJournalError("invalid", path, "contains invalid routing input lifetime");
        }
        routingInput = {
            operatorUserId: routing.operatorUserId,
            publishedAtMs: routing.publishedAtMs,
            expiresAtMs: routing.expiresAtMs,
            phase: routing.phase,
            ...(routing.chooser !== undefined
                ? {
                    chooser: {
                        ...routing.chooser,
                    },
                }
                : {}),
        };
    }
    const queueKind = value.queueKind;
    const queueReceiptId = value.queueReceiptId;
    const hasQueueMetadata = queueKind !== undefined ||
        queueReceiptId !== undefined ||
        value.queueOwner !== undefined ||
        value.queueHandoff !== undefined;
    const hasFailureMetadata = value.failure !== undefined ||
        value.nextRetryAtMs !== undefined ||
        value.terminalAtMs !== undefined ||
        value.terminalReason !== undefined ||
        value.terminalFailureId !== undefined;
    if (value.state === "pending" && (hasQueueMetadata || hasFailureMetadata)) {
        throw createJournalError("invalid", path, "contains metadata on a pending entry");
    }
    if (value.state === "queued" &&
        ((queueKind !== "prompt" && queueKind !== "control") ||
            !isNonEmptyString(queueReceiptId) ||
            value.queueOwner === undefined ||
            hasFailureMetadata)) {
        throw createJournalError("invalid", path, "contains invalid queued entry metadata");
    }
    const queueOwner = value.state === "queued" && value.queueOwner !== undefined
        ? validateJournalQueueOwner(value.queueOwner, path)
        : undefined;
    const queueHandoff = value.state === "queued" && value.queueHandoff !== undefined
        ? validateJournalHandoff(value.queueHandoff, path, "queue")
        : undefined;
    if (queueHandoff && !queueOwner) {
        throw createJournalError("invalid", path, "contains a queue handoff without donor authority");
    }
    if (value.preApprovalExcluded === true &&
        (value.inputClaim !== undefined || value.inputProvenance !== undefined || value.privateTextReply !== undefined)) {
        throw createJournalError("pairing-evidence", path, "contains claimed exclusion evidence");
    }
    const privateTextReply = value.privateTextReply === undefined
        ? undefined : validatePrivateTextReply(value.privateTextReply, path, value.updateId);
    const inputClaim = value.inputClaim === undefined
        ? undefined
        : validateJournalInputClaim(value.inputClaim, path, value.updateId);
    const inputProvenance = value.inputProvenance === undefined
        ? undefined
        : validateJournalInputProvenance(value.inputProvenance, path, value.updateId);
    if ((inputClaim &&
        (value.state === "queued" ||
            (inputClaim.phase === "running" && value.state !== "pending"))) ||
        (inputProvenance && (value.state !== "queued" || inputClaim))) {
        throw createJournalError("invalid", path, "contains conflicting input claim state");
    }
    let failure;
    if (value.state === "retry-wait" || value.state === "failed") {
        if (hasQueueMetadata) {
            throw createJournalError("invalid", path, "contains queue metadata on a failed execution entry");
        }
        failure = validateJournalFailure(value.failure, path);
    }
    if (value.state === "retry-wait" &&
        (!isSafeNonNegativeInteger(value.nextRetryAtMs) ||
            value.nextRetryAtMs < failure.failedAtMs ||
            value.terminalAtMs !== undefined ||
            value.terminalReason !== undefined ||
            value.terminalFailureId !== undefined)) {
        throw createJournalError("invalid", path, "contains invalid retry-wait metadata");
    }
    if (value.state === "failed" &&
        (!isSafeNonNegativeInteger(value.terminalAtMs) ||
            value.terminalAtMs < failure.failedAtMs ||
            !isBoundedString(value.terminalReason, TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH) ||
            (value.terminalFailureId !== undefined &&
                !isBoundedString(value.terminalFailureId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH)) ||
            value.nextRetryAtMs !== undefined)) {
        throw createJournalError("invalid", path, "contains invalid terminal failure metadata");
    }
    return {
        updateId: value.updateId,
        update,
        ...(journalRequiresExclusion(version)
            ? { preApprovalExcluded: value.preApprovalExcluded }
            : {}),
        ...(inputClaim ? { inputClaim } : {}),
        ...(inputProvenance ? { inputProvenance } : {}),
        ...(privateTextReply ? { privateTextReply } : {}),
        admittedAtMs: value.admittedAtMs,
        ...(routingInput ? { routingInput } : {}),
        state: value.state,
        ...(queueKind === "prompt" || queueKind === "control" ? { queueKind } : {}),
        ...(isNonEmptyString(queueReceiptId) ? { queueReceiptId } : {}),
        ...(queueOwner ? { queueOwner } : {}),
        ...(queueHandoff ? { queueHandoff } : {}),
        ...(failure ? { failure } : {}),
        ...(isSafeNonNegativeInteger(value.nextRetryAtMs)
            ? { nextRetryAtMs: value.nextRetryAtMs }
            : {}),
        ...(isSafeNonNegativeInteger(value.terminalAtMs)
            ? { terminalAtMs: value.terminalAtMs }
            : {}),
        ...(isNonEmptyString(value.terminalReason)
            ? { terminalReason: value.terminalReason }
            : {}),
        ...(value.state === "failed"
            ? {
                terminalFailureId: isBoundedString(value.terminalFailureId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH)
                    ? value.terminalFailureId
                    : createTelegramUpdateTerminalFailureId({
                        updateId: value.updateId,
                        attemptCount: failure.attemptCount,
                        failedAtMs: failure.failedAtMs,
                        failureClass: failure.failureClass,
                        terminalAtMs: value.terminalAtMs,
                        terminalReason: value.terminalReason,
                    }),
            }
            : {}),
    };
}
function assertSupportedJournalVersion(value, path, version = TELEGRAM_UPDATE_JOURNAL_VERSION) {
    if (isRecord(value) &&
        Number.isSafeInteger(value.version) &&
        value.version !== version) {
        throw createJournalError("unsupported-version", path, `uses unsupported version ${String(value.version)}`);
    }
}
function validateJournalSourceCompletion(value, path) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["updateId", "sourceSha256", "completionSha256"]) ||
        !isSafeNonNegativeInteger(value.updateId) ||
        typeof value.sourceSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.sourceSha256) ||
        typeof value.completionSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.completionSha256)) {
        throw createJournalError("invalid", path, "has invalid source completion evidence");
    }
    return {
        updateId: value.updateId,
        sourceSha256: value.sourceSha256,
        completionSha256: value.completionSha256,
    };
}
function validateJournalSourceCompletions(value, path, version, allowEmpty = false) {
    if ((!isTelegramUpdateJournalLegacyFamilyVersion(version) && version !== TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION) ||
        !Array.isArray(value) ||
        (!allowEmpty && !value.length)) {
        throw createJournalError("invalid", path, "has invalid source completion collection");
    }
    const completions = value.map((item) => validateJournalSourceCompletion(item, path));
    const scopes = new Set();
    for (let index = 0; index < completions.length; index++) {
        const completion = completions[index];
        if ((index > 0 && completions[index - 1].updateId >= completion.updateId) ||
            scopes.has(completion.completionSha256)) {
            throw createJournalError("invalid", path, "has duplicate or unordered source completion evidence");
        }
        scopes.add(completion.completionSha256);
    }
    return completions;
}
function assertJournalExclusionCursor(value, path, version) {
    if (journalRequiresExclusion(version) &&
        (!isRecord(value) ||
            !isSafeNonNegativeInteger(value.acceptedThroughUpdateId))) {
        throw createJournalError("pairing-evidence", path, "is missing its exclusion-mode admission cursor");
    }
}
function parseJournalFile(value, path, version = TELEGRAM_UPDATE_JOURNAL_VERSION) {
    assertSupportedJournalVersion(value, path, version);
    assertJournalExclusionCursor(value, path, version);
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "version",
            "revision",
            "acceptedThroughUpdateId",
            "profile",
            "botIdentity",
            "entries",
            "operatorDispositions",
            "sourceCompletions",
        ]) ||
        !Number.isSafeInteger(value.version) ||
        (value.revision !== undefined &&
            (!isSafeNonNegativeInteger(value.revision) || value.revision === 0)) ||
        (value.acceptedThroughUpdateId !== undefined &&
            !isSafeNonNegativeInteger(value.acceptedThroughUpdateId)) ||
        !isNonEmptyString(value.profile) ||
        !Array.isArray(value.entries) ||
        (value.operatorDispositions !== undefined &&
            !Array.isArray(value.operatorDispositions))) {
        throw createJournalError("invalid", path, "has a malformed schema");
    }
    const entries = value.entries.map((entry) => validateJournalEntry(entry, path, version));
    for (let index = 1; index < entries.length; index += 1) {
        if (entries[index].updateId <= entries[index - 1].updateId) {
            throw createJournalError("invalid", path, "contains duplicate or unordered entry ids");
        }
    }
    if (entries.length > 0 &&
        value.acceptedThroughUpdateId !== undefined &&
        value.acceptedThroughUpdateId < entries.at(-1).updateId) {
        throw createJournalError("invalid", path, "has an admission cursor behind its active entries");
    }
    const queuedReceipts = new Map();
    for (const entry of entries) {
        if (entry.state !== "queued" || !entry.queueKind || !entry.queueReceiptId) {
            continue;
        }
        const existing = queuedReceipts.get(entry.queueReceiptId);
        if (existing &&
            (existing.queueKind !== entry.queueKind ||
                (existing.queueOwner === undefined) !==
                    (entry.queueOwner === undefined) ||
                (existing.queueOwner !== undefined &&
                    entry.queueOwner !== undefined &&
                    !areTelegramUpdateJournalQueueOwnersEqual(existing.queueOwner, entry.queueOwner)) ||
                (existing.queueHandoff === undefined) !==
                    (entry.queueHandoff === undefined) ||
                (existing.queueHandoff !== undefined &&
                    entry.queueHandoff !== undefined &&
                    !isDeepStrictEqual(existing.queueHandoff, entry.queueHandoff)))) {
            throw createJournalError("invalid", path, `contains inconsistent queued receipt ${entry.queueReceiptId}`);
        }
        if (!existing) {
            queuedReceipts.set(entry.queueReceiptId, {
                queueKind: entry.queueKind,
                ...(entry.queueOwner
                    ? { queueOwner: cloneJournalQueueOwner(entry.queueOwner) }
                    : {}),
                ...(entry.queueHandoff
                    ? { queueHandoff: cloneJournalQueueHandoff(entry.queueHandoff) }
                    : {}),
            });
        }
    }
    const operatorDispositions = (value.operatorDispositions ?? []).map((disposition) => validateJournalOperatorDisposition(disposition, path));
    const sourceCompletions = value.sourceCompletions === undefined
        ? []
        : validateJournalSourceCompletions(value.sourceCompletions, path, version);
    const botIdentity = validateBotIdentity(value.botIdentity, path);
    const activeIds = new Set(entries.map((entry) => entry.updateId));
    const discardedIds = new Set(operatorDispositions
        .filter((disposition) => disposition.action === "discard")
        .map((disposition) => disposition.updateId));
    if (sourceCompletions.some((completion) => activeIds.has(completion.updateId) ||
        discardedIds.has(completion.updateId) ||
        (value.acceptedThroughUpdateId !== undefined &&
            completion.updateId > value.acceptedThroughUpdateId))) {
        throw createJournalError("invalid", path, "has contradictory source completion evidence");
    }
    const dispositionFailureIds = new Set();
    const entriesByUpdateId = new Map(entries.map((entry) => [entry.updateId, entry]));
    for (const disposition of operatorDispositions) {
        if (dispositionFailureIds.has(disposition.failureId)) {
            throw createJournalError("invalid", path, "contains duplicate operator disposition failure ids");
        }
        const currentEntry = entriesByUpdateId.get(disposition.updateId);
        if (currentEntry?.terminalFailureId === disposition.failureId ||
            (disposition.action === "discard" && currentEntry !== undefined)) {
            throw createJournalError("invalid", path, "contains operator-disposed active authority");
        }
        dispositionFailureIds.add(disposition.failureId);
    }
    return {
        version,
        ...(value.revision !== undefined
            ? { revision: value.revision }
            : {}),
        ...(value.acceptedThroughUpdateId !== undefined
            ? { acceptedThroughUpdateId: value.acceptedThroughUpdateId }
            : {}),
        profile: value.profile,
        botIdentity,
        entries,
        ...(operatorDispositions.length > 0 ? { operatorDispositions } : {}),
        ...(sourceCompletions.length > 0 ? { sourceCompletions } : {}),
    };
}
function assertJournalRoutingInputContinuity(file, entries, path) {
    const previous = new Map(file.entries.map((entry) => [entry.updateId, entry.routingInput]));
    for (const entry of entries) {
        const retained = previous.get(entry.updateId), next = entry.routingInput;
        if (retained &&
            (!next ||
                next.operatorUserId !== retained.operatorUserId ||
                next.publishedAtMs !== retained.publishedAtMs ||
                next.expiresAtMs !== retained.expiresAtMs ||
                (retained.phase === "selected" && next.phase !== "selected"))) {
            throw createJournalError("invalid", path, "regresses retained routing input lifetime");
        }
    }
}
function assertJournalSourceCompletionContinuity(file, segment, path) {
    assertJournalRoutingInputContinuity(file, segment.upsertedEntries, path);
    if (segment.sourceCompletions === undefined)
        return;
    const previous = new Map((file.sourceCompletions ?? []).map((completion) => [
        completion.updateId,
        completion,
    ]));
    const next = new Map(segment.sourceCompletions.map((completion) => [
        completion.updateId,
        completion,
    ]));
    if ([...previous].some(([id, completion]) => !isDeepStrictEqual(completion, next.get(id)))) {
        throw createJournalError("invalid", path, "regresses retained source completion evidence");
    }
    const entries = new Map(file.entries.map((entry) => [entry.updateId, entry]));
    const removed = new Set(segment.removedUpdateIds), upserted = new Set(segment.upsertedEntries.map((entry) => entry.updateId));
    const upsertedReceipts = new Set(segment.upsertedEntries.map((entry) => entry.queueReceiptId));
    // Grouped markers share one whole-receipt check rather than rescanning the group per source.
    const queueGroups = new Map(), queueRemovals = new Map();
    for (const entry of file.entries) {
        if (!entry.queueReceiptId)
            continue;
        const group = queueGroups.get(entry.queueReceiptId) ?? [];
        group.push(entry);
        queueGroups.set(entry.queueReceiptId, group);
    }
    const queueWasRemoved = (source) => {
        const receiptId = source.queueReceiptId;
        if (!receiptId || !source.queueOwner)
            return false;
        if (queueRemovals.has(receiptId))
            return queueRemovals.get(receiptId);
        const group = queueGroups.get(receiptId);
        const valid = !!group?.length &&
            !upsertedReceipts.has(receiptId) &&
            group.every((entry) => removed.has(entry.updateId) &&
                !upserted.has(entry.updateId) &&
                entry.state === "queued" &&
                entry.queueKind === source.queueKind &&
                entry.queueHandoff === undefined &&
                !!entry.queueOwner &&
                areTelegramUpdateJournalQueueOwnersEqual(entry.queueOwner, source.queueOwner));
        queueRemovals.set(receiptId, valid);
        return valid;
    };
    if (file.version === TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION &&
        segment.sourceCompletions.some(completion => !previous.has(completion.updateId)) &&
        file.entries.some(entry => removed.has(entry.updateId) && entry.privateTextReply))
        throw createJournalError("invalid", path, "ordinary source completion removes private Text Input evidence");
    for (const completion of segment.sourceCompletions) {
        if (previous.has(completion.updateId))
            continue;
        const source = entries.get(completion.updateId);
        if (!removed.has(completion.updateId) ||
            !source ||
            (file.version === TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION && source.state !== "queued") ||
            (source.state === "queued" && !queueWasRemoved(source)) ||
            source.state === "failed" ||
            createTelegramUpdateJournalEntryDigest(source).sourceSha256 !==
                completion.sourceSha256) {
            throw createJournalError("invalid", path, "source completion does not match its removal revision");
        }
    }
}
function parseJournalSegment(value, path, version = TELEGRAM_UPDATE_JOURNAL_VERSION) {
    assertSupportedJournalVersion(value, path, version);
    assertJournalExclusionCursor(value, path, version);
    if (!isRecord(value) ||
        !hasOnlyKeys(value, [
            "version",
            "revision",
            "previousRevision",
            "acceptedThroughUpdateId",
            "profile",
            "botIdentity",
            "upsertedEntries",
            "removedUpdateIds",
            "operatorDispositions",
            "sourceCompletions",
        ]) ||
        value.version !== version ||
        !isSafePositiveInteger(value.revision) ||
        !isSafeNonNegativeInteger(value.previousRevision) ||
        (value.acceptedThroughUpdateId !== undefined &&
            !isSafeNonNegativeInteger(value.acceptedThroughUpdateId)) ||
        !isNonEmptyString(value.profile) ||
        !Array.isArray(value.upsertedEntries) ||
        !Array.isArray(value.removedUpdateIds) ||
        (value.operatorDispositions !== undefined &&
            !Array.isArray(value.operatorDispositions))) {
        throw createJournalError("invalid", path, "has a malformed segment schema");
    }
    const upsertedEntries = value.upsertedEntries.map((entry) => validateJournalEntry(entry, path, version));
    const upsertedIds = new Set();
    for (const entry of upsertedEntries) {
        if (upsertedIds.has(entry.updateId)) {
            throw createJournalError("invalid", path, "has duplicate segment upserts");
        }
        upsertedIds.add(entry.updateId);
    }
    if (upsertedEntries.length > 0 &&
        value.acceptedThroughUpdateId !== undefined &&
        value.acceptedThroughUpdateId <
            upsertedEntries.reduce((maximum, entry) => Math.max(maximum, entry.updateId), 0)) {
        throw createJournalError("invalid", path, "has an admission cursor behind its segment upserts");
    }
    const removedUpdateIds = [];
    const removedIds = new Set();
    for (const updateId of value.removedUpdateIds) {
        if (!isSafeNonNegativeInteger(updateId) ||
            removedIds.has(updateId) ||
            upsertedIds.has(updateId)) {
            throw createJournalError("invalid", path, "has invalid segment removals");
        }
        removedIds.add(updateId);
        removedUpdateIds.push(updateId);
    }
    const operatorDispositions = (value.operatorDispositions ?? []).map((disposition) => validateJournalOperatorDisposition(disposition, path));
    const segmentBotIdentity = validateBotIdentity(value.botIdentity, path);
    return {
        version,
        revision: value.revision,
        previousRevision: value.previousRevision,
        ...(value.acceptedThroughUpdateId !== undefined
            ? { acceptedThroughUpdateId: value.acceptedThroughUpdateId }
            : {}),
        profile: value.profile,
        botIdentity: segmentBotIdentity,
        upsertedEntries,
        removedUpdateIds,
        ...(value.operatorDispositions !== undefined
            ? { operatorDispositions }
            : {}),
        ...(value.sourceCompletions !== undefined
            ? {
                sourceCompletions: validateJournalSourceCompletions(value.sourceCompletions, path, version, true),
            }
            : {}),
    };
}
export function inspectTelegramUpdateJournalFamily(input) {
    return acquireTelegramUpdateJournalFamily(input).evidence;
}
/** Classifies private originals against exact discard tombstones; never replay or deletion authority. */
export function inspectTelegramUpdateJournalRetention(input) {
    const acquired = acquireTelegramUpdateJournalFamily(input, undefined, true);
    return {
        evidence: acquired.evidence,
        retainedInputs: acquired.retainedInputs ?? [],
    };
}
/**
 * Read-only source evidence for cooperating writers serialized by the caller through
 * consumption; never readiness, recovery, or permission to publish. Ancestors retain
 * canonical directory type and endpoint dev/ino/mode/uid/gid, tolerating sibling churn.
 * This deliberately loses ancestor size/nlink/mtime/ctime witnesses: no transient
 * namespace/permission/ACL continuity, inode-ABA resistance, or hostile-same-user
 * protection. Manual relocation/restore/security manipulation is outside the protocol.
 * Files and the segment directory retain full inspection checks and bounded census.
 * Identity is never enriched; accounting is physical inspection work, not store capacity.
 */
export function readTelegramUpdateJournalSource(input) {
    const version = input.version;
    if (version !== 1 && version !== 2 && version !== 3 && version !== 4) {
        throw createJournalError("unsupported-version", input.path, "requires a selected source version");
    }
    return acquireTelegramUpdateJournalFamily({
        ...input,
        botIdentity: { ...input.botIdentity },
        limits: { ...input.limits },
    }, version).evidence;
}
function acquireTelegramUpdateJournalFamily(input, selectedVersion, inspectRetention = false, recountedAncestors = false) {
    if (selectedVersion === 5)
        inspectRetention = true;
    const { path, limits } = input;
    const acquiredSegments = [];
    let snapshotRevision = 0;
    const fail = (message) => {
        throw createJournalError("invalid", path, message);
    };
    const capacity = () => {
        throw createJournalError("capacity", path, "exceeds inspection resource limits");
    };
    for (const key of [
        "maxFiles",
        "maxBytes",
        "maxEntries",
        "maxWork",
    ]) {
        if (!isSafePositiveInteger(limits[key]))
            fail("requires positive safe-integer limits");
    }
    const expected = validateBotIdentity(input.botIdentity, path);
    if (!isNonEmptyString(input.profile))
        fail("requires an exact profile");
    const anchor = input.directory;
    const contained = relative(anchor, path);
    if (!isAbsolute(anchor) ||
        resolve(anchor) !== anchor ||
        !isAbsolute(path) ||
        resolve(path) !== path ||
        !contained ||
        contained === ".." ||
        contained.startsWith(`..${sep}`) ||
        isAbsolute(contained))
        fail("escapes its canonical directory anchor");
    let files = 0;
    let bytes = 0;
    let work = 0;
    const observed = new Map();
    const ancestors = new Set();
    const sameAncestor = (a, b) => b.isDirectory() &&
        !b.isSymbolicLink() &&
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.uid === b.uid &&
        a.gid === b.gid;
    const same = (a, b) => a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.nlink === b.nlink &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs;
    const status = (target) => {
        try {
            return lstatSync(target, { bigint: true });
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    };
    const observe = (target, directory, optional = false) => {
        const value = status(target);
        if (!value && !optional)
            fail("has a missing path component");
        if (value &&
            (value.isSymbolicLink() ||
                !(directory ? value.isDirectory() : value.isFile())))
            fail("has a linked or unexpected file type");
        observed.set(target, value);
        return value;
    };
    const charge = (value) => {
        if (!isRecord(value))
            return;
        for (const key of [
            "entries",
            "upsertedEntries",
            "removedUpdateIds",
            "operatorDispositions",
            "sourceCompletions",
        ]) {
            const collection = value[key];
            if (!Array.isArray(collection))
                continue;
            if (collection.length > limits.maxEntries ||
                collection.length > limits.maxWork - work)
                capacity();
            work += collection.length;
        }
    };
    const read = (target, before) => {
        if (before.size > BigInt(limits.maxBytes - bytes))
            capacity();
        const fd = openSync(target, TELEGRAM_STRICT_READ_FLAGS);
        try {
            const opened = fstatSync(fd, { bigint: true });
            if (!opened.isFile() || !same(before, opened))
                fail("changed before handle acquisition");
            const length = Number(opened.size);
            const buffer = Buffer.alloc(length);
            let offset = 0;
            while (offset < length) {
                const count = readSync(fd, buffer, offset, length - offset, offset);
                if (!count)
                    fail("disappeared or shrank during read");
                offset += count;
            }
            if (readSync(fd, Buffer.alloc(1), 0, 1, length) !== 0 ||
                !same(opened, fstatSync(fd, { bigint: true })))
                fail("changed during handle read");
            const after = status(target);
            if (!after || !same(opened, after))
                fail("changed path during read");
            bytes += length;
            const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer));
            charge(value);
            return value;
        }
        finally {
            closeSync(fd);
        }
    };
    const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
    const enumerate = (target = segmentDirectory, pattern = /^\d{16}\.json$/u, usedFiles = files) => {
        const names = [];
        const directory = opendirSync(target, { bufferSize: 1 });
        try {
            for (;;) {
                const entry = directory.readSync();
                if (!entry)
                    break;
                if (names.length >= limits.maxFiles - usedFiles)
                    capacity();
                if (!pattern.test(entry.name) ||
                    !entry.isFile() ||
                    entry.isSymbolicLink())
                    fail("has an unexpected journal evidence entry");
                names.push(entry.name);
            }
        }
        finally {
            directory.closeSync();
        }
        return names.sort();
    };
    try {
        observe(anchor, true);
        ancestors.add(anchor);
        if (realpathSync(anchor) !== anchor)
            fail("requires a canonical directory anchor");
        let parent = anchor;
        for (const component of relative(anchor, dirname(path))
            .split(sep)
            .filter(Boolean)) {
            parent = join(parent, component);
            observe(parent, true);
            ancestors.add(parent);
        }
        const snapshot = observe(path, false, true);
        const segments = observe(segmentDirectory, true, true);
        if (!snapshot && segments)
            fail("retains segments without a snapshot");
        files = snapshot ? 1 : 0;
        const names = segments ? enumerate() : [];
        let file;
        let candidate;
        let knownBotId = expected.botId;
        const identity = (value) => {
            if (value.profile !== input.profile ||
                value.botIdentity.tokenSha256 !== expected.tokenSha256 ||
                (knownBotId !== undefined &&
                    value.botIdentity.botId !== undefined &&
                    knownBotId !== value.botIdentity.botId)) {
                throw createJournalError("identity-mismatch", path, "belongs to another exact journal identity");
            }
            knownBotId ??= value.botIdentity.botId;
        };
        if (snapshot && selectedVersion === 5) {
            if (names.length)
                fail("candidate source does not admit snapshot/segment mixing");
            candidate = decodeTelegramTextInputSourceJournalCandidate(JSON.stringify(read(path, snapshot)), path);
            identity(candidate);
            snapshotRevision = candidate.revision ?? 0;
        }
        if (snapshot && selectedVersion !== 5) {
            const raw = read(path, snapshot);
            if (!isRecord(raw) ||
                (raw.version !== 1 && raw.version !== 2 && raw.version !== 3 && raw.version !== 4)) {
                throw createJournalError("unsupported-version", path, "has an unsupported snapshot version");
            }
            if (selectedVersion !== undefined)
                assertSupportedJournalVersion(raw, path, selectedVersion);
            file = parseJournalFile(raw, path, raw.version);
            snapshotRevision = file.revision ?? 0;
            identity(file);
            for (const name of names) {
                const target = join(segmentDirectory, name);
                const metadata = observe(target, false);
                const previousWork = work;
                const segment = parseJournalSegment(read(target, metadata), target, file.version);
                acquiredSegments.push({
                    name,
                    bytes: Number(metadata.size),
                    work: work - previousWork,
                    ...(segment.botIdentity.botId !== undefined
                        ? { botId: segment.botIdentity.botId }
                        : {}),
                });
                files += 1;
                identity(segment);
                if (segment.revision !== Number(name.slice(0, 16)) ||
                    segment.previousRevision !== segment.revision - 1)
                    fail("has an invalid intrinsic segment revision");
                const dispositionIds = new Set();
                for (const disposition of segment.operatorDispositions ?? []) {
                    if (dispositionIds.has(disposition.failureId))
                        fail("has duplicate segment disposition failure ids");
                    dispositionIds.add(disposition.failureId);
                }
                const revision = file.revision ?? 0;
                if (segment.revision <= revision)
                    continue;
                if (segment.revision !== revision + 1 ||
                    segment.previousRevision !== revision)
                    fail("has a newer revision gap");
                if (segment.acceptedThroughUpdateId !== undefined &&
                    file.acceptedThroughUpdateId !== undefined &&
                    segment.acceptedThroughUpdateId < file.acceptedThroughUpdateId)
                    fail("regresses the admission cursor");
                assertJournalSourceCompletionContinuity(file, segment, target);
                const entries = new Map(file.entries.map((entry) => [entry.updateId, entry]));
                for (const id of segment.removedUpdateIds)
                    entries.delete(id);
                for (const entry of segment.upsertedEntries) {
                    const previous = entries.get(entry.updateId);
                    assertPrivateTextReplyContinuity(previous, entry, target);
                    if (journalRequiresExclusion(file.version) &&
                        ((previous &&
                            previous.preApprovalExcluded !== entry.preApprovalExcluded) ||
                            (!previous &&
                                entry.updateId <= (file.acceptedThroughUpdateId ?? -1)))) {
                        throw createJournalError("pairing-evidence", target, "changes exclusion evidence or resurrects a settled source");
                    }
                    if (!entries.has(entry.updateId) && entries.size >= limits.maxEntries)
                        capacity();
                    entries.set(entry.updateId, entry);
                }
                const next = {
                    ...file,
                    revision: segment.revision,
                    ...(segment.acceptedThroughUpdateId !== undefined
                        ? { acceptedThroughUpdateId: segment.acceptedThroughUpdateId }
                        : {}),
                    entries: [...entries.values()].sort((a, b) => a.updateId - b.updateId),
                    operatorDispositions: segment.operatorDispositions ?? file.operatorDispositions,
                    sourceCompletions: segment.sourceCompletions ?? file.sourceCompletions,
                };
                charge(next);
                file = parseJournalFile(next, target, file.version);
            }
        }
        const retainedInputs = [];
        const retentionDirectory = `${path}.retained`;
        const retention = inspectRetention
            ? observe(retentionDirectory, true, true)
            : undefined;
        const retentionPattern = /^abandon-[a-f0-9]{64}\.json$/u;
        const retentionNames = retention
            ? enumerate(retentionDirectory, retentionPattern)
            : [];
        if (retentionNames.length > limits.maxEntries)
            capacity();
        if (retention) {
            if (!file || file.version !== 1)
                fail("private retention requires its exact v1 journal snapshot");
            const current = file;
            const bindingKeys = new Set([expected, current.botIdentity].map((botIdentity) => createTelegramUpdateJournalBindingKey({
                path,
                profileName: input.profile,
                botIdentity,
            })));
            const updateIds = new Set();
            for (const name of retentionNames) {
                const target = join(retentionDirectory, name);
                const before = observe(target, false);
                if (before.nlink !== 1n)
                    fail("has linked private retention evidence");
                const raw = read(target, before);
                files += 1;
                if (limits.maxWork - work < 2)
                    capacity();
                work += 2;
                if (!isRecord(raw))
                    throw createJournalError("invalid", target, "private retention is not an evidence record");
                if (typeof raw.journalBindingKey !== "string" ||
                    !bindingKeys.has(raw.journalBindingKey))
                    throw createJournalError("invalid", target, "has foreign private retention evidence");
                const entry = validateJournalEntry(raw.entry, target, 1);
                const disposition = validateJournalOperatorDisposition(raw.requestedDisposition, target);
                const digest = createHash("sha256")
                    .update(JSON.stringify({ journalBindingKey: raw.journalBindingKey, entry }))
                    .digest("hex");
                if (!("dispositionKind" in disposition) ||
                    disposition.dispositionKind !== "legacy-custody" ||
                    disposition.action !== "discard" ||
                    entry.state !== "pending" ||
                    disposition.updateId !== entry.updateId ||
                    disposition.evidenceSha256 !== digest ||
                    disposition.failureId !== `abandon-${digest}` ||
                    name !== `${disposition.failureId}.json` ||
                    !isDeepStrictEqual(raw, {
                        version: 1,
                        kind: "pending-input-retention",
                        journalBindingKey: raw.journalBindingKey,
                        entry,
                        requestedDisposition: disposition,
                    }))
                    fail("has inconsistent private retention evidence");
                if (updateIds.has(entry.updateId))
                    fail("has duplicate private retention sources");
                updateIds.add(entry.updateId);
                const committed = current.operatorDispositions?.find((value) => value.failureId === disposition.failureId ||
                    value.updateId === entry.updateId);
                if (committed &&
                    (!isDeepStrictEqual(committed, disposition) ||
                        current.entries.some((value) => value.updateId === entry.updateId)))
                    fail("private retention contradicts its journal disposition");
                const originalTarget = committed && "dispositionKind" in disposition && disposition.dispositionKind === "legacy-custody"
                    ? projectCommittedAbandonmentTarget(entry, disposition.operatorAuthorityId) : undefined;
                retainedInputs.push({
                    path: target,
                    journalBindingKey: raw.journalBindingKey,
                    failureId: disposition.failureId,
                    updateId: entry.updateId,
                    state: committed ? "committed" : "uncommitted",
                    ...(originalTarget ? { originalTarget } : {}),
                });
            }
        }
        if (inspectRetention &&
            file?.operatorDispositions?.some((disposition) => "dispositionKind" in disposition &&
                disposition.dispositionKind === "legacy-custody" &&
                disposition.action === "discard" &&
                /^abandon-[a-f0-9]{64}$/u.test(disposition.failureId) &&
                !retainedInputs.some((original) => original.updateId === disposition.updateId &&
                    original.state === "committed")))
            fail("committed abandonment lost its private original");
        // Re-enumeration has the same bound, rather than allocating an unbounded census.
        let observationLive = true, observing = false;
        const assertObserved = () => {
            if (!observationLive || observing) {
                observationLive = false;
                fail("source observation is no longer current");
            }
            observing = true;
            try {
                if (selectedVersion === 5 && realpathSync(anchor) !== anchor)
                    fail("changed source namespace");
                files = snapshot ? 1 : 0;
                if (segments && !isDeepStrictEqual(names, enumerate()))
                    fail("changed segment namespace");
                files += names.length;
                if (retention && !isDeepStrictEqual(retentionNames, enumerate(retentionDirectory, retentionPattern)))
                    fail("changed private retention namespace");
                files += retentionNames.length;
                for (const [target, before] of observed) {
                    const after = status(target);
                    const compare = (selectedVersion !== undefined || recountedAncestors) && ancestors.has(target) ? sameAncestor : same;
                    if (before ? !after || !compare(before, after) : after !== undefined)
                        fail("changed observed namespace or file");
                }
                if (!observationLive)
                    fail("source observation reentered");
            }
            catch (error) {
                observationLive = false;
                throw error;
            }
            finally {
                observing = false;
            }
        };
        assertObserved();
        if (selectedVersion === 5) {
            if (candidate && createTelegramUpdateJournalReceiptScope({ profileName: input.profile, botIdentity: expected }) !==
                createTelegramUpdateJournalReceiptScope({ profileName: candidate.profile, botIdentity: candidate.botIdentity }))
                throw createJournalError("identity-mismatch", path, "does not retain the candidate receipt scope");
            return { file: candidate, assertCurrent: assertObserved };
        }
        if (selectedVersion !== undefined) {
            if (realpathSync(anchor) !== anchor)
                fail("requires a canonical directory anchor");
            if (file) {
                if (file.version !== selectedVersion) {
                    throw createJournalError("unsupported-version", path, "does not match the selected source version");
                }
                if (createTelegramUpdateJournalReceiptScope({
                    profileName: input.profile,
                    botIdentity: expected,
                }) !==
                    createTelegramUpdateJournalReceiptScope({
                        profileName: file.profile,
                        botIdentity: file.botIdentity,
                    })) {
                    throw createJournalError("identity-mismatch", path, "does not retain the expected receipt scope");
                }
            }
        }
        return {
            assertCurrent: assertObserved,
            evidence: file
                ? {
                    kind: "present",
                    file,
                    ...(knownBotId !== undefined ? { knownBotId } : {}),
                    accounting: { files, bytes, work },
                }
                : { kind: "absent" },
            snapshotRevision,
            segments: acquiredSegments,
            ...(inspectRetention ? { retainedInputs } : {}),
        };
    }
    catch (error) {
        if (error instanceof TelegramUpdateJournalError)
            throw error;
        throw createJournalError("io", path, "could not establish strict journal evidence", error);
    }
}
export function inspectTelegramProfileJournalNamespace(input) {
    return inspectTelegramJournalNamespace(input, false);
}
/** Read-only evidence over polling, retained flat recipients and role-neutral session journals. */
export function inspectTelegramSessionJournalNamespace(input) {
    return inspectTelegramJournalNamespace(input, true);
}
function inspectTelegramJournalNamespace(input, includeSessions) {
    const { directory, profile, limits } = input;
    const fail = (message) => {
        throw createJournalError("invalid", directory, message);
    };
    const capacity = () => {
        throw createJournalError("capacity", directory, "exceeds namespace inspection resource limits");
    };
    for (const key of [
        "maxDirectoryEntries",
        "maxFiles",
        "maxBytes",
        "maxEntries",
        "maxWork",
    ]) {
        if (!isSafePositiveInteger(limits[key]))
            fail("requires positive safe-integer limits");
    }
    if (!/^[a-z0-9]{1,32}$/u.test(profile))
        fail("requires a canonical profile namespace");
    const expected = validateBotIdentity(input.botIdentity, directory);
    if (!isAbsolute(directory) || resolve(directory) !== directory)
        fail("requires a canonical directory anchor");
    const metadata = (target, runtimeKind) => {
        const value = lstatSync(target, { bigint: true });
        if (runtimeKind && (value.isSymbolicLink() || (runtimeKind === "file" ? !value.isFile() || value.nlink !== 1n : !value.isDirectory())))
            fail("has a linked or unexpected runtime entry");
        // Only known non-source runtime payloads may churn; directories retain their original physical identity.
        return {
            dev: value.dev,
            ino: runtimeKind === "file" ? undefined : value.ino,
            mode: value.mode,
            uid: value.uid,
            gid: value.gid,
            nlink: runtimeKind ? undefined : value.nlink,
            size: runtimeKind ? undefined : value.size,
            mtimeNs: runtimeKind ? undefined : value.mtimeNs,
            ctimeNs: runtimeKind ? undefined : value.ctimeNs,
        };
    };
    const suffix = profile === "default" ? "" : `.${profile}`;
    const pollingPath = input.pollingPath ?? join(directory, `inbox${suffix}.json`);
    const polling = relative(directory, pollingPath);
    {
        const parts = polling.split(sep);
        if (!isAbsolute(pollingPath) ||
            resolve(pollingPath) !== pollingPath ||
            parts.at(-1) !== `inbox${suffix}.json` ||
            !(parts.length === 1 ||
                (parts.length === 3 &&
                    parts[0] === "sessions" &&
                    decodeTelegramSessionDirectoryName(parts[1]) !== undefined)))
            fail("requires a canonical polling journal path");
    }
    try {
        const root = lstatSync(directory);
        if (!root.isDirectory() ||
            root.isSymbolicLink() ||
            realpathSync(directory) !== directory)
            fail("requires a canonical directory anchor");
        const beforeRoot = metadata(directory);
        const census = () => {
            const entries = new Map();
            const families = new Map(), profiles = new Set();
            const scan = (parent, visit) => {
                const handle = opendirSync(parent, { bufferSize: 1 });
                try {
                    for (;;) {
                        const entry = handle.readSync();
                        if (!entry)
                            break;
                        if (entries.size >= limits.maxDirectoryEntries)
                            capacity();
                        const target = join(parent, entry.name);
                        const key = relative(directory, target);
                        if (entries.has(key))
                            fail("repeated an observed namespace entry");
                        const runtimeKind = includeSessions && parent === directory
                            ? entry.name === "state.json" || entry.name === "logs.jsonl" ? "file"
                                : entry.name === "runtime" || entry.name === "logs" ? "directory" : undefined
                            : undefined;
                        entries.set(key, metadata(target, runtimeKind));
                        visit(entry.name, target);
                    }
                }
                finally {
                    handle.closeSync();
                }
            };
            const requireType = (target, isDirectory) => {
                const value = lstatSync(target);
                if (value.isSymbolicLink() ||
                    !(isDirectory ? value.isDirectory() : value.isFile()) ||
                    (!isDirectory && value.nlink !== 1))
                    fail("has a linked or unexpected journal type");
            };
            const evidenceDirectory = (target, retained) => scan(target, (name, path) => {
                if (!(retained ? /^abandon-[a-f0-9]{64}\.json$/u : /^\d{16}\.json$/u).test(name))
                    fail("has an unclassified journal evidence entry");
                requireType(path, false);
            });
            const session = (target) => scan(target, (name, path) => {
                if (name === "recovery")
                    return;
                const match = /^(?:journal\.[a-f0-9]{16}|inbox)(?:\.([a-z0-9]{1,32}))?\.json(\.(?:segments|retained))?$/u.exec(name);
                if (!match || match[1] === "default")
                    fail("has an unclassified session journal entry");
                requireType(path, !!match[2]);
                if (match[2])
                    evidenceDirectory(path, match[2] === ".retained");
                const base = path.replace(/\.(?:segments|retained)$/u, ""), familyProfile = match[1] ?? "default";
                profiles.add(familyProfile);
                if (familyProfile === profile && base !== pollingPath)
                    families.set(base, "session");
            });
            scan(directory, (name, target) => {
                // Legacy quarantine folders are disposable housekeeping, never journal authority.
                if (name.toLowerCase() === "recovery")
                    return;
                if (name.toLowerCase() === "sessions") {
                    if (!includeSessions)
                        fail("requires session-qualified namespace inspection");
                    if (name !== "sessions")
                        fail("has a noncanonical session root");
                    requireType(target, true);
                    scan(target, (sessionName, sessionPath) => {
                        if (decodeTelegramSessionDirectoryName(sessionName) === undefined)
                            fail("has a noncanonical session directory");
                        requireType(sessionPath, true);
                        session(sessionPath);
                    });
                    return;
                }
                if (includeSessions && /^journal\./iu.test(name))
                    fail("has a misplaced session journal");
                if (!/inbox/iu.test(name))
                    return;
                const match = /^(inbox|follower-inbox-[a-f0-9]{16})(?:\.([a-z0-9]{1,32}))?\.json(\.(?:segments|retained))?$/u.exec(name);
                if (!match ||
                    match[2] === "default" ||
                    (!includeSessions && match[3] === ".retained"))
                    fail("has a noncanonical journal-like entry");
                requireType(target, !!match[3]);
                if (includeSessions && match[3])
                    evidenceDirectory(target, match[3] === ".retained");
                const base = target.replace(/\.(?:segments|retained)$/u, ""), familyProfile = match[2] ?? "default";
                profiles.add(familyProfile);
                if (familyProfile === profile && base !== pollingPath)
                    families.set(base, match[1] === "inbox" ? "session" : "follower");
            });
            return {
                entries: [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                families: [...families].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
                profiles: [...profiles].sort(),
            };
        };
        const before = census();
        const sourceInventory = [
            [pollingPath, "polling"],
            ...before.families,
        ];
        const sources = [];
        const retainedInputs = [];
        const accounting = {
            directoryEntries: before.entries.length,
            files: 0,
            bytes: 0,
            work: 0,
        };
        let knownBotId = expected.botId;
        for (const [path, role] of sourceInventory) {
            const remaining = {
                maxFiles: limits.maxFiles - accounting.files,
                maxBytes: limits.maxBytes - accounting.bytes,
                maxWork: limits.maxWork - accounting.work,
                maxEntries: limits.maxEntries,
            };
            if (remaining.maxFiles <= 0 ||
                remaining.maxBytes <= 0 ||
                remaining.maxWork <= 0)
                capacity();
            const acquire = () => acquireTelegramUpdateJournalFamily({
                directory,
                path,
                profile,
                botIdentity: {
                    ...expected,
                    ...(knownBotId !== undefined ? { botId: knownBotId } : {}),
                },
                limits: remaining,
            }, undefined, includeSessions, includeSessions);
            const acquired = input.withSourceReference
                ? input.withSourceReference(path, acquire)
                : acquire();
            const evidence = acquired.evidence;
            retainedInputs.push(...(acquired.retainedInputs ?? []).map((original) => ({
                ...original,
                journalPath: path,
            })));
            if (evidence.kind === "absent" &&
                (role !== "polling" ||
                    before.entries.some(([entry]) => entry === polling || entry === `${polling}.segments`))) {
                fail("lost a discovered journal family");
            }
            if (evidence.kind === "present") {
                knownBotId = evidence.knownBotId;
                accounting.files += evidence.accounting.files;
                accounting.bytes += evidence.accounting.bytes;
            }
            accounting.work +=
                evidence.kind === "present" ? Math.max(1, evidence.accounting.work) : 1;
            sources.push({ role, path, evidence });
        }
        const rootCurrent = () => {
            const after = metadata(directory);
            return includeSessions
                ? realpathSync(directory) === directory && beforeRoot.dev === after.dev && beforeRoot.ino === after.ino &&
                    beforeRoot.mode === after.mode && beforeRoot.uid === after.uid && beforeRoot.gid === after.gid
                : isDeepStrictEqual(beforeRoot, after);
        };
        const namespaceCurrent = () => {
            try {
                // Every name and journal/evidence metadata is re-counted; root timestamps also reflect unrelated state writes.
                return rootCurrent() && isDeepStrictEqual(before, census()) && rootCurrent();
            }
            catch {
                return false;
            }
        };
        if (!namespaceCurrent())
            fail("changed observed root namespace or identity");
        return {
            sources,
            accounting,
            ...(includeSessions ? { retainedInputs } : {}),
            ...(knownBotId !== undefined ? { knownBotId } : {}),
        };
    }
    catch (error) {
        if (error instanceof TelegramUpdateJournalError)
            throw error;
        throw createJournalError("io", directory, "could not establish canonical namespace evidence", error);
    }
}
/** Whether an update addresses this private-chat Thread anywhere in its payload (message, callback, reaction, …). */
export function doesTelegramJournalUpdateNameThread(update, target) {
    const matches = (value, depth) => {
        if (depth > 8 || !value || typeof value !== "object")
            return false;
        const record = value;
        if (record.message_thread_id === target.threadId) {
            const chat = record.chat;
            if (!chat || typeof chat !== "object" || chat.id === target.chatId)
                return true;
        }
        return Object.values(record).some((child) => matches(child, depth + 1));
    };
    return matches(update, 0);
}
/** A button tap alone carries no input, so it never keeps a tab whose inputs are resolved (the in-flight Cancel itself). */
export function isTelegramJournalLoneCallbackUpdate(update) {
    if (!update || typeof update !== "object")
        return false;
    const kinds = Object.keys(update).filter((key) => key !== "update_id");
    return kinds.length === 1 && kinds[0] === "callback_query";
}
/** Plain inbound kinds whose address is readable; anything else stays protective. */
const TELEGRAM_CLEANUP_PLAIN_UPDATE_KINDS = [
    "message",
    "edited_message",
    "callback_query",
    "message_reaction",
];
/** Complete-empty protection only; caller holds source serialization through consumption. Never deletion authority. */
export function isTelegramThreadCleanupJournalNamespaceClear(input) {
    if (!input.requiredJournalBindingKeys.length ||
        input.requiredJournalBindingKeys.length > input.limits.maxDirectoryEntries)
        throw new Error("Telegram temporary cleanup requires bounded exact journal references.");
    const requiredPaths = new Set();
    for (const key of input.requiredJournalBindingKeys) {
        const path = getTelegramUpdateJournalBindingPath(key);
        const identities = [
            input.botIdentity,
            { tokenSha256: input.botIdentity.tokenSha256 },
        ];
        if (!path ||
            !identities.some((botIdentity) => key ===
                createTelegramUpdateJournalBindingKey({
                    path,
                    profileName: input.profile,
                    botIdentity,
                })))
            throw new Error("Telegram temporary cleanup has foreign or malformed journal references.");
        requiredPaths.add(path);
    }
    const namespace = inspectTelegramSessionJournalNamespace(input);
    if (namespace.sources.filter((source) => source.role === "polling").length !==
        1 ||
        namespace.retainedInputs?.some((original) => original.state !== "committed") ||
        [...requiredPaths].some((path) => !namespace.sources.some((source) => source.path === path && source.evidence.kind === "present")))
        return false;
    const cleanup = input.cleanup;
    const ownPaths = new Map();
    for (const own of cleanup?.ownInputs ?? []) {
        const path = getTelegramUpdateJournalBindingPath(own.journalBindingKey);
        if (!path)
            return false;
        const ids = ownPaths.get(path) ?? new Set();
        for (const id of own.updateIds)
            ids.add(id);
        ownPaths.set(path, ids);
    }
    // Custody-bearing, failed or unreadable work protects every tab: its reply target is not its message address.
    const isUnrelatedPlainInput = (entry, path) => {
        const kinds = Object.keys(entry.update).filter((key) => key !== "update_id");
        return (!!cleanup &&
            entry.state === "pending" &&
            !entry.queueOwner &&
            !entry.queueReceiptId &&
            !entry.queueKind &&
            !entry.queueHandoff &&
            !entry.inputClaim &&
            !("inputProvenance" in entry) &&
            !entry.failure &&
            kinds.length === 1 &&
            TELEGRAM_CLEANUP_PLAIN_UPDATE_KINDS.includes(kinds[0]) &&
            (isTelegramJournalLoneCallbackUpdate(entry.update) ||
                !doesTelegramJournalUpdateNameThread(entry.update, cleanup.target)) &&
            !ownPaths.get(path)?.has(entry.updateId));
    };
    return namespace.sources.every((source) => source.evidence.kind === "absent" ||
        source.evidence.file.entries.every((entry) => isUnrelatedPlainInput(entry, source.path)));
}
/** Demand-driven recovery only; caller holds temporary-cleanup admission. Never a deletion grant. */
export function recoverTelegramThreadCleanupDeadQueueOwners(input) {
    return input.withSourceSerialization(() => {
        const assertCurrent = () => {
            if (!input.isCurrent())
                throw new Error("Temporary cleanup queue recovery lost authority.");
        };
        assertCurrent();
        if (!input.cleanup)
            return 0;
        // Validate exact references and complete namespace coverage before considering any mutation.
        if (isTelegramThreadCleanupJournalNamespaceClear(input))
            return 0;
        const namespace = inspectTelegramSessionJournalNamespace(input);
        if (namespace.retainedInputs?.some(value => value.state !== "committed") ||
            input.requiredJournalBindingKeys.some(key => !namespace.sources.some(source => source.path === getTelegramUpdateJournalBindingPath(key) && source.evidence.kind === "present")))
            return 0;
        const plans = [];
        for (const source of namespace.sources) {
            if (source.evidence.kind !== "present")
                continue;
            const file = source.evidence.file;
            if (file.version !== TELEGRAM_UPDATE_JOURNAL_VERSION)
                continue;
            const groups = new Map();
            for (const entry of file.entries) {
                if (!entry.queueReceiptId)
                    continue;
                const group = groups.get(entry.queueReceiptId) ?? [];
                group.push(entry);
                groups.set(entry.queueReceiptId, group);
            }
            for (const group of groups.values()) {
                const entry = group[0];
                if (entry.state !== "queued" || !entry.queueReceiptId || !entry.queueOwner ||
                    !entry.queueKind || entry.queueHandoff || entry.inputClaim)
                    continue;
                if (group.some(value => value.state !== "queued" || value.queueHandoff || value.inputClaim ||
                    value.queueKind !== entry.queueKind || !isDeepStrictEqual(value.queueOwner, entry.queueOwner)))
                    continue;
                plans.push({ path: source.path, recovery: {
                        queueKind: entry.queueKind, receiptId: entry.queueReceiptId,
                        sourceUpdateIds: group.map(value => value.updateId).sort((a, b) => a - b),
                        deadOwner: cloneJournalQueueOwner(entry.queueOwner), recoveryOwner: { ...input.recoveryOwner },
                    } });
            }
        }
        const liveness = input.getQueueProcessLiveness ?? getTelegramProcessLiveness;
        const dead = plans.filter(plan => {
            assertCurrent();
            const result = liveness(plan.recovery.deadOwner);
            assertCurrent();
            return result === "dead";
        });
        let removed = 0;
        for (const plan of dead) {
            assertCurrent();
            removed += input.withSourceReference(plan.path, () => {
                const journal = createTelegramUpdateJournalStore({
                    path: plan.path, profileName: input.profile, botIdentity: input.botIdentity,
                    queueRuntimeIdentity: input.recoveryOwner,
                    // This private synchronous store stays inside the cross-family serializer already held above.
                    withSourceSerialization(operation) { assertCurrent(); return operation(); },
                    sourceAccess: { directory: dirname(plan.path), limits: input.limits },
                    getQueueProcessLiveness(owner) {
                        assertCurrent();
                        const result = liveness(owner);
                        assertCurrent();
                        return result;
                    },
                    withWriterAdmission(operation) { assertCurrent(); return operation(); },
                });
                // The journal transaction rechecks whole-group identity, absence of handoff and fresh process-death proof.
                return journal.recoverDeadQueueOwner(plan.recovery).recoveredUpdateIds.length;
            });
        }
        assertCurrent();
        return removed;
    });
}
function cloneEntry(entry) {
    return {
        ...entry,
        update: structuredClone(entry.update),
        ...(entry.privateTextReply ? { privateTextReply: structuredClone(entry.privateTextReply) } : {}),
        ...(entry.inputClaim
            ? { inputClaim: structuredClone(entry.inputClaim) }
            : {}),
        ...(entry.inputProvenance
            ? { inputProvenance: structuredClone(entry.inputProvenance) }
            : {}),
        ...(entry.queueOwner
            ? { queueOwner: cloneJournalQueueOwner(entry.queueOwner) }
            : {}),
        ...(entry.queueHandoff
            ? { queueHandoff: cloneJournalQueueHandoff(entry.queueHandoff) }
            : {}),
        ...(entry.failure ? { failure: { ...entry.failure } } : {}),
        ...(entry.routingInput ? { routingInput: { ...entry.routingInput } } : {}),
    };
}
function cloneFile(file) {
    return {
        version: file.version,
        ...(file.revision !== undefined ? { revision: file.revision } : {}),
        ...(file.acceptedThroughUpdateId !== undefined
            ? { acceptedThroughUpdateId: file.acceptedThroughUpdateId }
            : {}),
        profile: file.profile,
        botIdentity: { ...file.botIdentity },
        entries: file.entries.map(cloneEntry),
        ...(file.sourceCompletions?.length
            ? {
                sourceCompletions: file.sourceCompletions.map((completion) => ({
                    ...completion,
                })),
            }
            : {}),
        ...(file.operatorDispositions?.length
            ? {
                operatorDispositions: file.operatorDispositions.map((disposition) => ({ ...disposition })),
            }
            : {}),
    };
}
function serializeJournalFile(file) {
    return `${JSON.stringify(file, null, 2)}\n`;
}
function getTelegramUpdateJournalSegmentDirectory(path) {
    return `${path}.segments`;
}
function getTelegramUpdateJournalSegmentPath(path, revision) {
    return join(getTelegramUpdateJournalSegmentDirectory(path), `${String(revision).padStart(16, "0")}.json`);
}
function publishTelegramUpdateJournalSegmentUnlocked(path, segment, onPublicationBoundary) {
    const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
    const segmentPath = getTelegramUpdateJournalSegmentPath(path, segment.revision);
    const serialized = `${JSON.stringify(segment, null, 2)}\n`;
    mkdirSync(segmentDirectory, { recursive: true, mode: 0o700 });
    const revisions = readdirSync(segmentDirectory)
        .flatMap((name) => {
        const match = name.match(/^(\d{16})\.json$/u);
        return match ? [Number(match[1])] : [];
    })
        .filter(Number.isSafeInteger);
    let snapshotRevision = 0;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        snapshotRevision =
            parseJournalFile(parsed, path, segment.version).revision ?? 0;
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    const latestRevision = Math.max(snapshotRevision, ...revisions, 0);
    if (latestRevision >= segment.revision) {
        try {
            if (readFileSync(segmentPath, "utf8") === serialized) {
                return {
                    path: segmentPath,
                    revision: segment.revision,
                    serializedBytes: Buffer.byteLength(serialized),
                };
            }
        }
        catch {
            // A compacted snapshot may already contain this revision.
        }
        throw new Error("Telegram update journal segment revision conflicts.");
    }
    if (latestRevision !== segment.previousRevision) {
        throw new Error("Telegram update journal segment revision has a gap.");
    }
    writeJournalFile(segmentPath, serialized, onPublicationBoundary);
    return {
        path: segmentPath,
        revision: segment.revision,
        serializedBytes: Buffer.byteLength(serialized),
    };
}
export function publishTelegramUpdateJournalSegment(path, segment) {
    if (segment.version !== TELEGRAM_UPDATE_JOURNAL_VERSION ||
        !isSafePositiveInteger(segment.revision) ||
        segment.previousRevision !== segment.revision - 1 ||
        !isNonEmptyString(segment.profile) ||
        !Array.isArray(segment.upsertedEntries) ||
        !Array.isArray(segment.removedUpdateIds)) {
        throw new Error("Telegram update journal segment is invalid.");
    }
    return withTelegramFileTransaction(`${path}.transaction`, () => publishTelegramUpdateJournalSegmentUnlocked(path, segment));
}
function normalizeCapacityLimit(value, fallback, label) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new Error(`Telegram update journal ${label} must be a positive integer.`);
    }
    return resolved;
}
function identitiesMatch(left, right) {
    if (left.botId !== undefined &&
        right.botId !== undefined &&
        left.botId !== right.botId) {
        return false;
    }
    return ((left.botId !== undefined && left.botId === right.botId) ||
        left.tokenSha256 === right.tokenSha256);
}
function mergeBotIdentity(stored, current) {
    return {
        ...(current.botId !== undefined
            ? { botId: current.botId }
            : stored.botId !== undefined
                ? { botId: stored.botId }
                : {}),
        tokenSha256: current.tokenSha256,
    };
}
function createPendingRetentionReference(input) {
    const { path, journalBindingKey, entry, maxBytes } = input;
    const evidenceSha256 = createHash("sha256")
        .update(JSON.stringify({ journalBindingKey, entry }))
        .digest("hex");
    const failureId = `abandon-${evidenceSha256}`;
    const retainedDirectory = `${path}.retained`;
    const retainedPath = join(retainedDirectory, `${failureId}.json`);
    const read = () => {
        let directory;
        try {
            directory = lstatSync(retainedDirectory);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
        if (!directory.isDirectory() || directory.isSymbolicLink()) {
            throw createJournalError("invalid", retainedDirectory, "retention directory is not a regular directory");
        }
        let stat;
        try {
            stat = lstatSync(retainedPath);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
        if (!stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > maxBytes + 4096) {
            throw createJournalError("invalid", retainedPath, "retained input is not a bounded regular file");
        }
        const retained = JSON.parse(readFileSync(retainedPath, "utf8"));
        if (!isRecord(retained))
            throw createJournalError("invalid", retainedPath, "retained input is not an evidence record");
        const disposition = validateJournalOperatorDisposition(retained.requestedDisposition, retainedPath);
        if (!("dispositionKind" in disposition) ||
            disposition.dispositionKind !== "legacy-custody" ||
            disposition.failureId !== failureId ||
            disposition.updateId !== entry.updateId ||
            disposition.action !== "discard" ||
            disposition.evidenceSha256 !== evidenceSha256 ||
            !isDeepStrictEqual(retained, {
                version: 1,
                kind: "pending-input-retention",
                journalBindingKey,
                entry,
                requestedDisposition: disposition,
            })) {
            throw createJournalError("conflict", retainedPath, "retained input does not match abandonment evidence");
        }
        return {
            version: 1,
            kind: "pending-input-retention",
            journalBindingKey,
            entry,
            requestedDisposition: disposition,
        };
    };
    return { evidenceSha256, failureId, retainedPath, read };
}
/** Projects body-free locator facts only after the caller has validated committed original retention. */
function projectCommittedAbandonmentTarget(entry, operatorAuthorityId) {
    const update = entry.update, message = update.message;
    // Only an original human bot-chat message supplies this locator. Other cancellation proofs remain useful,
    // but callbacks, business/edited/ambiguous envelopes cannot lend their display target to orphan cleanup.
    return Object.keys(update).length === 2 && "update_id" in update && "message" in update &&
        isRecord(message) && isRecord(message.chat) && isRecord(message.from) &&
        message.chat.type === "private" && isSafePositiveInteger(message.chat.id) &&
        message.from.id === message.chat.id && message.from.is_bot === false &&
        operatorAuthorityId === `telegram-owner:${message.chat.id}` &&
        message.business_connection_id === undefined && message.sender_chat === undefined &&
        isSafePositiveInteger(message.message_thread_id) && isSafePositiveInteger(message.message_id)
        ? Object.freeze({ chatId: message.chat.id, threadId: message.message_thread_id, messageId: message.message_id,
            sourceSha256: createTelegramUpdateJournalEntryDigest(entry).sourceSha256 })
        : undefined;
}
function writeJournalFile(path, serialized, onPublicationBoundary, stagingPath = path) {
    const tempPath = `${stagingPath}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
        onPublicationBoundary?.("before-write", path);
        writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
        chmodSync(tempPath, 0o600);
        onPublicationBoundary?.("after-write-before-rename", path);
        if (!renameTelegramPathWithRetry(tempPath, path)) {
            throw new Error("Temporary journal file disappeared before publication.");
        }
        chmodSync(path, 0o600);
    }
    finally {
        try {
            unlinkSync(tempPath);
        }
        catch {
            // The successful atomic rename already consumed the temporary path.
        }
    }
}
export function createTelegramUpdateQueueHandoffToken() {
    return randomBytes(32).toString("base64url");
}
export function createTelegramUpdateJournalBotIdentity(input) {
    if (!input.botToken) {
        throw new Error("Telegram update journal requires a configured bot token.");
    }
    if (input.botId !== undefined && !isSafePositiveInteger(input.botId)) {
        throw new Error("Telegram update journal bot id must be a safe integer.");
    }
    return {
        ...(input.botId !== undefined ? { botId: input.botId } : {}),
        tokenSha256: createHash("sha256").update(input.botToken).digest("hex"),
    };
}
export function createTelegramUpdateJournalReceiptScope(input) {
    const profile = (input.profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME).trim();
    if (!profile) {
        throw new Error("Telegram update journal receipt scope requires a profile.");
    }
    if (input.botIdentity.botId !== undefined &&
        !isSafePositiveInteger(input.botIdentity.botId)) {
        throw new Error("Telegram update journal bot id must be a safe integer.");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.botIdentity.tokenSha256)) {
        throw new Error("Telegram update journal receipt scope requires a SHA-256 token fingerprint.");
    }
    return JSON.stringify({
        version: TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION,
        profile,
        bot: input.botIdentity.botId === undefined
            ? { tokenSha256: input.botIdentity.tokenSha256 }
            : { botId: input.botIdentity.botId },
    });
}
export function createTelegramUpdateJournalBindingKey(input) {
    if (!input.path) {
        throw new Error("Telegram update journal binding requires a path.");
    }
    return JSON.stringify({
        version: TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION,
        path: input.path,
        receiptScope: createTelegramUpdateJournalReceiptScope(input),
    });
}
export function getTelegramUpdateJournalBindingPath(journalBindingKey) {
    try {
        const value = JSON.parse(journalBindingKey);
        return value.version === TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION &&
            typeof value.path === "string" &&
            value.path.length > 0 &&
            typeof value.receiptScope === "string"
            ? value.path
            : undefined;
    }
    catch {
        return undefined;
    }
}
export function createTelegramUpdateJournalReceiptScopeResolver(deps) {
    let identityKey;
    let receiptScope;
    return () => {
        const botToken = deps.getBotToken();
        if (!botToken) {
            identityKey = undefined;
            receiptScope = undefined;
            return undefined;
        }
        const profileName = deps.getProfileName() ?? TELEGRAM_DEFAULT_PROFILE_NAME;
        const botIdentity = createTelegramUpdateJournalBotIdentity({
            botToken,
            botId: deps.getBotId(),
        });
        const nextIdentityKey = `${profileName}\u0000${botIdentity.tokenSha256}`;
        if (nextIdentityKey === identityKey && receiptScope)
            return receiptScope;
        identityKey = nextIdentityKey;
        receiptScope = createTelegramUpdateJournalReceiptScope({
            profileName,
            botIdentity,
        });
        return receiptScope;
    };
}
export function createTelegramUpdateJournalRuntimeBindingResolver(deps) {
    return () => {
        const botToken = deps.getBotToken();
        if (!botToken)
            return undefined;
        const configuredProfileName = deps.getProfileName();
        const profileName = configuredProfileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
        const botIdentity = createTelegramUpdateJournalBotIdentity({
            botToken,
            botId: deps.getBotId(),
        });
        const path = deps.getJournalPath(configuredProfileName);
        const workspaceAdmission = deps.getWorkspaceAdmission?.();
        const sourceAccess = {
            directory: dirname(path),
            limits: {
                maxFiles: 1024,
                maxBytes: TELEGRAM_UPDATE_JOURNAL_MAX_BYTES * 2,
                maxEntries: TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES,
                maxWork: TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES * 1024,
            },
        };
        const options = {
            path,
            profileName,
            botIdentity,
            ...(deps.getQueueRuntimeIdentity
                ? { queueRuntimeIdentity: deps.getQueueRuntimeIdentity() }
                : {}),
            ...(workspaceAdmission ? { workspaceAdmission } : {}),
            ...(deps.withWriterAdmission
                ? { withWriterAdmission: deps.withWriterAdmission }
                : {}),
            ...(deps.withSourceSerialization
                ? { withSourceSerialization: deps.withSourceSerialization }
                : {}),
            ...(deps.onRecovery ? { onRecovery: deps.onRecovery } : {}),
        };
        const journal = createTelegramUpdateJournalStore(options);
        // Scoped completion and receipt observation always use strict private handles; see TELEGRAM_STRICT_READ_FLAGS.
        const strict = deps.strictSourceAccess ?? true;
        const completionJournal = deps.withSourceSerialization
            ? createTelegramUpdateJournalStore({
                ...options,
                ...(strict ? { sourceAccess } : {}),
            })
            : undefined;
        // Queue receipt readiness gates every ordinary prompt; without strict handles it uses the ordinary journal read.
        const observeQueuedReceipt = (expected) => strict
            ? completionJournal.inspectQueuedReceipt(expected)
            : inspectJournalQueuedReceipt(journal.read(), {
                ...expected,
                queueOwner: validateQueuedReceiptObservation(expected, path),
            }, path);
        return {
            runtimeKey: JSON.stringify({
                path,
                profileName,
                botIdentity,
            }),
            recoveryKey: createTelegramUpdateJournalBindingKey({
                path,
                profileName,
                botIdentity,
            }),
            readForProtection() {
                // Protection must never turn corruption/recovery into empty-work evidence.
                const evidence = inspectTelegramUpdateJournalFamily({
                    ...sourceAccess,
                    path,
                    profile: profileName,
                    botIdentity,
                });
                return {
                    entries: evidence.kind === "present" ? evidence.file.entries : [],
                    exists: evidence.kind === "present",
                };
            },
            journal: completionJournal
                ? {
                    ...journal,
                    removeCompletedExact(updateIds, expectedSources, completions, isCurrent) {
                        return completions !== undefined
                            ? completionJournal.removeCompletedExact(updateIds, expectedSources, completions, isCurrent)
                            : journal.removeCompletedExact(updateIds, expectedSources, undefined, isCurrent);
                    },
                    completeQueuedExact(receipts, completions) {
                        return completionJournal.completeQueuedExact(receipts, completions);
                    },
                    inspectSourceCompletion(expected) {
                        return completionJournal.inspectSourceCompletion(expected);
                    },
                    inspectQueuedReceipt: observeQueuedReceipt,
                    isQueueReceiptCurrent(receipt, owner) {
                        if (receipt.journalBindingKey !==
                            createTelegramUpdateJournalBindingKey({
                                path,
                                profileName,
                                botIdentity,
                            }))
                            return false;
                        return (observeQueuedReceipt({
                            queueKind: receipt.queueKind,
                            receiptId: receipt.receiptId,
                            sourceUpdateIds: [...receipt.sourceUpdateIds],
                            queueOwner: { ...owner },
                        }) !== undefined);
                    },
                }
                : journal,
        };
    };
}
export function createTelegramUpdateJournalReferenceRegistry(input = {}) {
    const maxActive = input.maxActive ?? 64;
    let sequence = 0;
    const active = new Map();
    return {
        acquire(reference) {
            if (!reference.recoveryKey || active.size >= maxActive)
                throw new Error("Telegram update journal reference registry is unavailable or full.");
            const id = ++sequence;
            active.set(id, { ...reference });
            let released = false;
            return () => {
                if (released || !active.delete(id))
                    throw new Error("Telegram update journal reference lease is stale.");
                released = true;
            };
        },
        list: () => [...active.values()].map((reference) => ({ ...reference })),
        withReference(reference, operation) {
            const release = this.acquire(reference);
            try {
                const result = operation();
                if (result &&
                    typeof result.finally === "function")
                    return result.finally(release);
                release();
                return result;
            }
            catch (error) {
                release();
                throw error;
            }
        },
    };
}
export function withTelegramResolvedUpdateJournalReference(input) {
    const binding = input.resolveBinding();
    if (!binding)
        return undefined;
    return input.registry.withReference({ referenceClass: input.referenceClass, recoveryKey: binding.recoveryKey }, () => input.operation(binding));
}
function isPrivateFirstPreparationEntry(entry) {
    return entry.state === "pending" && entry.preApprovalExcluded === false &&
        !entry.inputClaim && !entry.inputProvenance && !entry.privateTextReply &&
        !entry.queueOwner && !entry.queueHandoff && !entry.queueKind && !entry.queueReceiptId;
}
function validateQueuedReceiptObservation(expected, path) {
    if (!isRecord(expected) ||
        !hasOnlyKeys(expected, [
            "queueKind",
            "receiptId",
            "sourceUpdateIds",
            "queueOwner",
        ]) ||
        (expected.queueKind !== "prompt" && expected.queueKind !== "control") ||
        !isNonEmptyString(expected.receiptId) ||
        !Array.isArray(expected.sourceUpdateIds) ||
        expected.sourceUpdateIds.length === 0 ||
        expected.sourceUpdateIds.length > TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES ||
        expected.sourceUpdateIds.some((id, index) => !isSafeNonNegativeInteger(id) ||
            (index > 0 && id <= expected.sourceUpdateIds[index - 1]))) {
        throw createJournalError("invalid", path, "received invalid queue receipt observation authority");
    }
    return validateJournalQueueOwner(expected.queueOwner, path);
}
function inspectJournalQueuedReceipt(file, expected, path) {
    if (!isTelegramUpdateJournalLegacyFamilyVersion(file.version))
        throw createJournalError("invalid", path, "queue receipt observation requires an exact legacy v1 source handle");
    const { queueOwner } = expected;
    const entries = file.entries.filter((entry) => entry.queueReceiptId === expected.receiptId);
    if (entries.length !== expected.sourceUpdateIds.length ||
        entries.some((entry, index) => entry.updateId !== expected.sourceUpdateIds[index] ||
            entry.state !== "queued" ||
            entry.queueKind !== expected.queueKind ||
            entry.queueHandoff !== undefined ||
            !isDeepStrictEqual(entry.queueOwner, queueOwner)))
        return undefined;
    return {
        receipt: {
            queueKind: expected.queueKind,
            receiptId: expected.receiptId,
            sourceUpdateIds: [...expected.sourceUpdateIds],
            queueOwner: { ...queueOwner },
        },
        sources: entries.map(createTelegramUpdateJournalEntryDigest),
        queueOwnerSha256: createHash("sha256")
            .update(JSON.stringify(queueOwner))
            .digest("hex"),
    };
}
function inspectJournalSourceCompletion(file, completion, path) {
    if (!isTelegramUpdateJournalLegacyFamilyVersion(file.version) && file.version !== TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION)
        throw createJournalError("invalid", path, "source completion requires a legacy v1 or explicit v4 source");
    const retained = file.sourceCompletions?.find((value) => value.updateId === completion.updateId);
    if (!retained)
        return undefined;
    if (!isDeepStrictEqual(retained, completion))
        throw createJournalError("conflict", path, "source completion belongs to another exact scope");
    return { ...retained };
}
/** Operator-distinct authority: routing never treats it as an owner cancellation. */
export const TELEGRAM_SESSION_ADOPTION_AUTHORITY_PREFIX = "session-successor:";
function isAdoptablePendingEntry(entry) {
    return (entry.state === "pending" &&
        !entry.inputClaim &&
        !entry.inputProvenance &&
        !entry.routingInput &&
        !entry.queueOwner &&
        !entry.queueHandoff &&
        !entry.queueReceiptId &&
        !entry.queueKind &&
        !entry.failure &&
        entry.preApprovalExcluded !== true);
}
export function createTelegramUpdateJournalBindingRuntime(deps) {
    const resolveLeader = createTelegramUpdateJournalRuntimeBindingResolver({
        ...deps.base,
        getJournalPath: deps.getLeaderJournalPath,
    });
    // Follower and path journals share identity and admission ports, never the leader's queue identity or strict source mode.
    const getSharedResolverPorts = () => ({
        getProfileName: deps.base.getProfileName,
        getBotToken: deps.base.getBotToken,
        getBotId: deps.base.getBotId,
        ...(deps.base.withWriterAdmission
            ? { withWriterAdmission: deps.base.withWriterAdmission }
            : {}),
        // Follower journals need the same strict exact-receipt ports as the leader; without them queue publication cannot complete.
        ...(deps.base.withSourceSerialization
            ? { withSourceSerialization: deps.base.withSourceSerialization }
            : {}),
        ...(deps.base.getWorkspaceAdmission
            ? { getWorkspaceAdmission: deps.base.getWorkspaceAdmission }
            : {}),
        ...(deps.base.onRecovery ? { onRecovery: deps.base.onRecovery } : {}),
    });
    const createFollowerResolver = (bindingKey, includeQueueRuntimeIdentity, sessionId, legacy = false) => {
        // Session-aware composition must not fall back to a process journal before preparation supplies its ID.
        if (!legacy && deps.getActiveFollowerSessionId && !sessionId)
            return () => undefined;
        return createTelegramUpdateJournalRuntimeBindingResolver({
            ...getSharedResolverPorts(),
            ...(includeQueueRuntimeIdentity && deps.base.getQueueRuntimeIdentity
                ? { getQueueRuntimeIdentity: deps.base.getQueueRuntimeIdentity }
                : {}),
            getJournalPath(profileName) {
                return deps.getFollowerJournalPath(bindingKey, profileName, sessionId);
            },
        });
    };
    const resolveFollower = () => createFollowerResolver(deps.getActiveFollowerBindingKey(), true, deps.getActiveFollowerSessionId?.())();
    const resolveActive = () => deps.isFollowerRegistered() ? resolveFollower() : resolveLeader();
    const inspectHistoricalSource = (journalBindingKey, operation) => {
        const path = getTelegramUpdateJournalBindingPath(journalBindingKey);
        const token = deps.base.getBotToken(), botId = deps.base.getBotId();
        const profile = deps.base.getProfileName() ?? TELEGRAM_DEFAULT_PROFILE_NAME;
        if (!path || !token)
            return undefined;
        const botIdentity = createTelegramUpdateJournalBotIdentity({
            botToken: token,
            botId,
        });
        const keys = [botIdentity, { tokenSha256: botIdentity.tokenSha256 }].map((identity) => createTelegramUpdateJournalBindingKey({
            path,
            profileName: profile,
            botIdentity: identity,
        }));
        if (!keys.includes(journalBindingKey))
            return undefined;
        const getRoot = () => deps.getRuntimeDir?.() ?? dirname(deps.getLeaderJournalPath(profile));
        const root = getRoot();
        const parts = relative(root, path).split(sep);
        const suffix = escapeTelegramJournalPathPattern(getTelegramProfilePathSuffix(profile));
        const flat = new RegExp(`^(?:inbox|follower-inbox-[a-f0-9]{16})${suffix}\\.json$`, "u");
        const session = new RegExp(`^(?:journal\\.[a-f0-9]{16}|inbox)${suffix}\\.json$`, "u");
        if (!isAbsolute(root) ||
            resolve(root) !== root ||
            !isAbsolute(path) ||
            resolve(path) !== path ||
            !((parts.length === 1 && flat.test(parts[0])) ||
                (parts.length === 3 &&
                    parts[0] === "sessions" &&
                    decodeTelegramSessionDirectoryName(parts[1]) !== undefined &&
                    session.test(parts[2]))))
            return undefined;
        const current = () => deps.base.getBotToken() === token &&
            deps.base.getBotId() === botId &&
            (deps.base.getProfileName() ?? TELEGRAM_DEFAULT_PROFILE_NAME) ===
                profile &&
            getRoot() === root;
        const inspect = () => {
            if (!current())
                return undefined;
            const observed = inspectTelegramUpdateJournalRetention({
                directory: root,
                path,
                profile,
                botIdentity,
                limits: {
                    maxFiles: 1024,
                    maxBytes: TELEGRAM_UPDATE_JOURNAL_MAX_BYTES * 2,
                    maxEntries: TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES,
                    maxWork: TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES * 1024,
                },
            });
            if (observed.evidence.kind !== "present" || !current())
                return undefined;
            return operation(observed.evidence.file, observed.retainedInputs, path);
        };
        const result = deps.base.withSourceSerialization
            ? deps.base.withSourceSerialization(inspect)
            : inspect();
        return current() ? result : undefined;
    };
    let preparedFollower;
    const runtime = {
        resolveLeader,
        resolveFollower,
        resolveActive,
        getActiveRecoveryKey: () => resolveActive()?.recoveryKey,
        prepareActiveFollowerSuccession(isCurrent) {
            const recipientBindingKey = deps.getActiveFollowerBindingKey();
            const sessionId = deps.getActiveFollowerSessionId?.();
            if (!sessionId)
                return undefined;
            const previous = preparedFollower;
            const result = previous &&
                previous.recipientBindingKey === recipientBindingKey &&
                previous.sessionId !== sessionId
                ? runtime.adoptPredecessorPending({
                    recipientBindingKey,
                    predecessorSessionId: previous.sessionId,
                    successorSessionId: sessionId,
                    isCurrent,
                })
                : undefined;
            // Only a completed adoption advances the predecessor; failures retry idempotently on the next preparation.
            preparedFollower = { recipientBindingKey, sessionId };
            return result;
        },
        inspectSourceAbandonment(journalBindingKey, updateId) {
            if (!isSafeNonNegativeInteger(updateId))
                throw new Error("Telegram abandonment proof requires an exact update ID.");
            return inspectHistoricalSource(journalBindingKey, (file, originals) => {
                const original = originals.find((value) => value.updateId === updateId &&
                    value.state === "committed" &&
                    value.journalBindingKey === journalBindingKey);
                if (!original)
                    return undefined;
                const disposition = file.operatorDispositions?.find((value) => value.failureId === original.failureId);
                if (!disposition ||
                    !("dispositionKind" in disposition) ||
                    disposition.dispositionKind !== "legacy-custody")
                    return undefined;
                return {
                    journalBindingKey,
                    updateId,
                    retainedPath: original.path,
                    operatorAuthorityId: disposition.operatorAuthorityId,
                    ...(original.originalTarget ? { originalTarget: original.originalTarget } : {}),
                };
            });
        },
        inspectSourceGroupExpiry(journalBindingKey, updateIds) {
            return inspectHistoricalSource(journalBindingKey, (file) => inspectRoutingGroupExpiry(file, journalBindingKey, updateIds));
        },
        inspectSourceCompletion(journalBindingKey, expected) {
            const completion = validateJournalSourceCompletion(expected, getTelegramUpdateJournalBindingPath(journalBindingKey) ?? "journal");
            return inspectHistoricalSource(journalBindingKey, (file, _originals, path) => inspectJournalSourceCompletion(file, completion, path));
        },
        inspectQueuedReceipt(journalBindingKey, expected) {
            const queueOwner = validateQueuedReceiptObservation(expected, getTelegramUpdateJournalBindingPath(journalBindingKey) ?? "journal");
            return inspectHistoricalSource(journalBindingKey, (file, _originals, path) => inspectJournalQueuedReceipt(file, { ...expected, queueOwner }, path));
        },
        adoptPredecessorPending(input) {
            const { recipientBindingKey, predecessorSessionId, successorSessionId, isCurrent, } = input;
            if (!recipientBindingKey ||
                !predecessorSessionId ||
                !successorSessionId ||
                predecessorSessionId === successorSessionId ||
                typeof isCurrent !== "function") {
                throw new Error("Telegram session adoption requires distinct exact session identities.");
            }
            const assertCurrent = () => {
                if (!isCurrent())
                    throw new Error("Telegram session adoption lost successor authority.");
            };
            assertCurrent();
            const predecessor = createFollowerResolver(recipientBindingKey, false, predecessorSessionId)();
            const successor = createFollowerResolver(recipientBindingKey, false, successorSessionId)();
            if (!predecessor?.readForProtection ||
                !successor ||
                predecessor.recoveryKey === successor.recoveryKey) {
                throw new Error("Telegram session adoption requires exact predecessor and successor journals.");
            }
            const result = {
                adoptedUpdateIds: [],
                retainedUpdateIds: [],
            };
            // Non-repairing selection; the abandonment CAS rechecks each exact entry under the source lock.
            const candidates = predecessor
                .readForProtection()
                .entries.filter(isAdoptablePendingEntry)
                .sort((left, right) => left.updateId - right.updateId);
            for (const entry of candidates) {
                assertCurrent();
                // Commit away first: a crash afterwards preserves the private original instead of duplicating execution.
                const committed = predecessor.journal.abandonPending({
                    journalBindingKey: predecessor.recoveryKey,
                    entry,
                    operatorAuthorityId: `${TELEGRAM_SESSION_ADOPTION_AUTHORITY_PREFIX}${successorSessionId}`,
                    isCurrent,
                });
                if (committed.duplicate) {
                    result.retainedUpdateIds.push(entry.updateId);
                    continue;
                }
                assertCurrent();
                successor.journal.appendBatch([entry.update]);
                result.adoptedUpdateIds.push(entry.updateId);
            }
            return result;
        },
        createRecipientResolver: (bindingKey, sessionId) => createFollowerResolver(bindingKey, false, sessionId),
        createLegacyRecipientResolver: (bindingKey) => createFollowerResolver(bindingKey, false, undefined, true),
        createPathResolver: (path) => createTelegramUpdateJournalRuntimeBindingResolver({
            ...getSharedResolverPorts(),
            getJournalPath: () => path,
        }),
    };
    return runtime;
}
/**
 * Journal-owned cross-family source serializer, lock-only and never authorization. Its guard lives
 * in the runtime service directory, so journal work never touches `telegram.json` or its
 * transaction. Acquire Workspace admission and any sender (config) admission first; never acquire
 * owners inside it. Callbacks must be synchronous: a returned promise is unprotected after its
 * synchronous prefix.
 */
export function createTelegramJournalSourceSerialization(getTransactionPath = () => join(resolveTelegramRuntimeDir(), "journals.transaction")) {
    return (operation) => withTelegramFileTransaction(getTransactionPath(), operation);
}
export function createTelegramUpdateJournalStore(options) {
    // The core strictly validates the selected persisted version before every read.
    return createJournalStoreCore(options).journal;
}
/** Exact unhanded queued receipt member: requested id, queue kind and owner identity. */
function isExactQueuedReceiptEntry(entry, requestedIds, queueKind, owner) {
    return (requestedIds.has(entry.updateId) &&
        entry.state === "queued" &&
        entry.queueKind === queueKind &&
        !!entry.queueOwner &&
        entry.queueHandoff === undefined &&
        areTelegramUpdateJournalQueueOwnersEqual(entry.queueOwner, owner));
}
function ordinaryV4EntryDigest(entry, path) {
    return createTelegramUpdateJournalEntryDigest(validateJournalEntry(entry, path, 4));
}
function createJournalStoreCore(options, getInputContext, storageVersion = TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION, observationVersion, privateFirstPreparation, ordinaryAppendScope, inputAdmission, ordinaryQueue) {
    const path = options.path;
    const profile = options.profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
    if (!path)
        throw new Error("Telegram update journal path is required.");
    if (!profile)
        throw new Error("Telegram update journal profile is required.");
    const expectedIdentity = validateBotIdentity(options.botIdentity, path);
    const queueRuntimeIdentity = options.queueRuntimeIdentity;
    if (queueRuntimeIdentity !== undefined &&
        (!isBoundedString(queueRuntimeIdentity.instanceId, TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH) ||
            !isSafePositiveInteger(queueRuntimeIdentity.processId) ||
            !isBoundedString(queueRuntimeIdentity.processBirthId, TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH))) {
        throw new Error("Telegram update journal queue process identity is invalid.");
    }
    const maxEntries = normalizeCapacityLimit(options.maxEntries, TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES, "entry limit");
    const maxBytes = normalizeCapacityLimit(options.maxBytes, TELEGRAM_UPDATE_JOURNAL_MAX_BYTES, "byte limit");
    const getNowMs = options.getNowMs ?? Date.now;
    const onPublicationBoundary = options.onPublicationBoundary;
    let completionInFlight, lastCompletion;
    const workspaceAdmission = options.workspaceAdmission;
    const withSourceSerialization = options.withSourceSerialization;
    const sourceAccess = options.sourceAccess && {
        directory: options.sourceAccess.directory,
        limits: { ...options.sourceAccess.limits },
    };
    if (sourceAccess && !withSourceSerialization) {
        throw new Error("Telegram journal source access requires source serialization.");
    }
    const withPairingAdmission = options.withPairingAdmission;
    const withPairedAdmission = options.withPairedAdmission;
    if (withPairingAdmission && withPairedAdmission) {
        throw new Error("Telegram journal admission modes are mutually exclusive.");
    }
    if (observationVersion && (!sourceAccess || !withSourceSerialization || getInputContext))
        throw new Error("Private source observation requires strict read-only construction.");
    const version = observationVersion ?? (getInputContext
        ? storageVersion
        : withPairingAdmission
            ? TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION
            : TELEGRAM_UPDATE_JOURNAL_VERSION);
    const notifyRecovery = (event) => {
        try {
            options.onRecovery?.(event);
        }
        catch {
            // Recovery diagnostics must not break recovered journal authority.
        }
    };
    const getQueueProcessLiveness = options.getQueueProcessLiveness ?? getTelegramProcessLiveness;
    const validateQueueHandoffInput = (input, operation) => {
        if ((input.queueKind !== "prompt" && input.queueKind !== "control") ||
            !isNonEmptyString(input.receiptId) ||
            !Array.isArray(input.sourceUpdateIds) ||
            input.sourceUpdateIds.length === 0 ||
            !isBoundedString(input.handoffToken, TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MAX_LENGTH) ||
            input.handoffToken.length <
                TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MIN_LENGTH) {
            throw createJournalError("invalid", path, `received an invalid queue handoff ${operation}`);
        }
        const expectedOwner = validateJournalQueueOwner(input.expectedOwner, path);
        const recipientOwner = validateJournalQueueOwnerIdentity(input.recipientOwner, path);
        const runtimeIdentity = operation === "accept" ? recipientOwner : expectedOwner;
        if (queueRuntimeIdentity &&
            (runtimeIdentity.instanceId !== queueRuntimeIdentity.instanceId ||
                runtimeIdentity.processId !== queueRuntimeIdentity.processId ||
                runtimeIdentity.processBirthId !== queueRuntimeIdentity.processBirthId)) {
            throw createJournalError("conflict", path, operation === "accept"
                ? `cannot accept queue receipt ${input.receiptId} for another runtime`
                : `cannot ${operation} foreign queue receipt ${input.receiptId}`);
        }
        const requestedIds = new Set();
        for (const updateId of input.sourceUpdateIds) {
            if (!isSafeNonNegativeInteger(updateId) || requestedIds.has(updateId)) {
                throw createJournalError("invalid", path, `received invalid queue handoff ${operation} update ids`);
            }
            requestedIds.add(updateId);
        }
        return {
            expectedOwner,
            recipientOwner,
            requestedIds,
            handoffId: createTelegramUpdateQueueHandoffId({
                handoffToken: input.handoffToken,
                queueKind: input.queueKind,
                receiptId: input.receiptId,
                sourceUpdateIds: [...requestedIds],
                expectedOwner,
                recipientOwner,
            }),
        };
    };
    const getExactQueuedReceiptEntries = (current, input, requestedIds) => {
        const receiptEntries = current.file.entries.filter((entry) => entry.queueReceiptId === input.receiptId);
        if (receiptEntries.length !== requestedIds.size ||
            receiptEntries.some((entry) => !requestedIds.has(entry.updateId) ||
                entry.state !== "queued" ||
                entry.queueKind !== input.queueKind)) {
            throw createJournalError("conflict", path, `cannot hand off stale queue receipt ${input.receiptId}`);
        }
        return receiptEntries;
    };
    const assertCapacity = (file, serialized = serializeJournalFile(file)) => {
        if (file.entries.length > maxEntries) {
            throw createJournalError("capacity", path, `exceeds its ${maxEntries}-entry limit`);
        }
        if ((file.operatorDispositions?.length ?? 0) > maxEntries) {
            throw createJournalError("capacity", path, `exceeds its ${maxEntries}-operator-disposition limit`);
        }
        if ((file.sourceCompletions?.length ?? 0) > maxEntries) {
            throw createJournalError("capacity", path, `exceeds its ${maxEntries}-source-completion limit`);
        }
        const serializedBytes = Buffer.byteLength(serialized);
        if (serializedBytes > maxBytes) {
            throw createJournalError("capacity", path, `exceeds its ${maxBytes}-byte limit`);
        }
        return serializedBytes;
    };
    const emptyFile = () => ({
        version,
        profile,
        botIdentity: { ...expectedIdentity },
        entries: [],
    });
    const readCurrentStrict = (allowReconciliation = true) => {
        let source;
        let recoveringMissingSnapshot = false;
        try {
            const size = statSync(path).size;
            if (size > maxBytes) {
                throw createJournalError("capacity", path, `exceeds its ${maxBytes}-byte limit`);
            }
            source = readFileSync(path, "utf8");
        }
        catch (error) {
            if (error instanceof TelegramUpdateJournalError)
                throw error;
            if (error?.code === "ENOENT") {
                const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
                let orphanedSegmentNames;
                try {
                    orphanedSegmentNames = readdirSync(segmentDirectory).filter((name) => /^\d{16}\.json$/u.test(name));
                }
                catch (segmentError) {
                    if (segmentError?.code === "ENOENT") {
                        return { file: emptyFile(), exists: false, serializedBytes: 0 };
                    }
                    throw createJournalError("io", segmentDirectory, "could not be read while the journal snapshot is missing", segmentError);
                }
                if (orphanedSegmentNames.length > 0) {
                    if (!allowReconciliation)
                        throw createJournalError("invalid", path, "requires explicit missing-snapshot reconciliation");
                    if (withPairingAdmission)
                        throw createJournalError("pairing-evidence", path, "requires explicit missing-snapshot reconciliation");
                    recoveringMissingSnapshot = true;
                    source = serializeJournalFile(emptyFile());
                }
                else {
                    return { file: emptyFile(), exists: false, serializedBytes: 0 };
                }
            }
            else {
                throw createJournalError("io", path, "could not be read", error);
            }
        }
        let parsed;
        try {
            parsed = JSON.parse(source);
        }
        catch (error) {
            throw createJournalError("invalid", path, "contains invalid JSON", error);
        }
        let file = parseJournalFile(parsed, path, version);
        const storedProfile = file.profile;
        const storedIdentity = file.botIdentity;
        const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
        let segmentNames = [];
        try {
            segmentNames = readdirSync(segmentDirectory).filter((name) => /^\d{16}\.json$/u.test(name));
        }
        catch (error) {
            if (error?.code !== "ENOENT") {
                throw createJournalError("io", segmentDirectory, "could not be read", error);
            }
        }
        segmentNames.sort();
        let revision = file.revision ?? 0;
        let unappliedSegmentBytes = 0;
        let orphanRecoverySawUpsert = false;
        let orphanRecoverySawBaseRemoval = false;
        let orphanRecoveryUnsafe = false;
        for (const name of segmentNames) {
            const nameRevision = Number(name.slice(0, 16));
            if (nameRevision <= revision)
                continue;
            const segmentPath = join(segmentDirectory, name);
            let segment;
            try {
                const segmentSize = statSync(segmentPath).size;
                if (segmentSize > maxBytes) {
                    throw createJournalError("capacity", segmentPath, `exceeds its ${maxBytes}-byte limit`);
                }
                unappliedSegmentBytes += segmentSize;
                if (unappliedSegmentBytes > maxBytes) {
                    throw createJournalError("capacity", segmentDirectory, `exceeds its ${maxBytes}-byte unapplied-segment limit`);
                }
                segment = parseJournalSegment(JSON.parse(readFileSync(segmentPath, "utf8")), segmentPath, version);
            }
            catch (error) {
                if (error instanceof TelegramUpdateJournalError)
                    throw error;
                throw createJournalError("invalid", segmentPath, "contains invalid JSON", error);
            }
            if (segment.revision !== nameRevision) {
                throw createJournalError("invalid", segmentPath, "revision does not match its file name");
            }
            if (segment.previousRevision !== revision) {
                throw createJournalError("invalid", segmentPath, `has a revision gap after ${revision}`);
            }
            if (segment.acceptedThroughUpdateId !== undefined &&
                file.acceptedThroughUpdateId !== undefined &&
                segment.acceptedThroughUpdateId < file.acceptedThroughUpdateId) {
                throw createJournalError("invalid", segmentPath, "regresses the admission cursor");
            }
            if (segment.profile !== storedProfile ||
                !identitiesMatch(segment.botIdentity, storedIdentity) ||
                (withPairingAdmission &&
                    segment.botIdentity.tokenSha256 !== storedIdentity.tokenSha256)) {
                throw createJournalError("identity-mismatch", segmentPath, "belongs to another journal identity");
            }
            assertJournalSourceCompletionContinuity(file, segment, segmentPath);
            const entriesById = new Map(file.entries.map((entry) => [entry.updateId, entry]));
            for (const updateId of segment.removedUpdateIds) {
                if (recoveringMissingSnapshot && !entriesById.has(updateId)) {
                    orphanRecoverySawBaseRemoval = true;
                    if (orphanRecoverySawUpsert)
                        orphanRecoveryUnsafe = true;
                }
                entriesById.delete(updateId);
            }
            for (const entry of segment.upsertedEntries) {
                const previous = entriesById.get(entry.updateId);
                assertPrivateTextReplyContinuity(previous, entry, segmentPath);
                if (withPairingAdmission &&
                    ((previous &&
                        previous.preApprovalExcluded !== entry.preApprovalExcluded) ||
                        (!previous &&
                            entry.updateId <= (file.acceptedThroughUpdateId ?? -1)))) {
                    throw createJournalError("pairing-evidence", segmentPath, "changes exclusion evidence or resurrects a settled source");
                }
                entriesById.set(entry.updateId, entry);
            }
            if (segment.upsertedEntries.length > 0)
                orphanRecoverySawUpsert = true;
            file = parseJournalFile({
                version,
                revision: segment.revision,
                ...(segment.acceptedThroughUpdateId !== undefined
                    ? { acceptedThroughUpdateId: segment.acceptedThroughUpdateId }
                    : file.acceptedThroughUpdateId !== undefined
                        ? { acceptedThroughUpdateId: file.acceptedThroughUpdateId }
                        : {}),
                profile: storedProfile,
                botIdentity: mergeBotIdentity(file.botIdentity, segment.botIdentity),
                entries: [...entriesById.values()].sort((left, right) => left.updateId - right.updateId),
                ...(segment.operatorDispositions !== undefined
                    ? { operatorDispositions: segment.operatorDispositions }
                    : file.operatorDispositions?.length
                        ? { operatorDispositions: file.operatorDispositions }
                        : {}),
                ...(segment.sourceCompletions !== undefined
                    ? { sourceCompletions: segment.sourceCompletions }
                    : file.sourceCompletions?.length
                        ? { sourceCompletions: file.sourceCompletions }
                        : {}),
            }, segmentPath, version);
            revision = segment.revision;
        }
        const identityChanged = storedProfile !== profile ||
            !identitiesMatch(file.botIdentity, expectedIdentity) ||
            ((withPairingAdmission || !!file.sourceCompletions?.length) &&
                file.botIdentity.tokenSha256 !== expectedIdentity.tokenSha256);
        if (identityChanged) {
            if (file.entries.length > 0 ||
                file.sourceCompletions?.length ||
                withPairingAdmission ||
                !allowReconciliation) {
                throw createJournalError("identity-mismatch", path, storedProfile !== profile
                    ? `belongs to profile ${storedProfile}, not ${profile}`
                    : "belongs to another Telegram bot identity");
            }
            file = {
                version,
                ...(file.revision !== undefined ? { revision: file.revision } : {}),
                profile,
                botIdentity: { ...expectedIdentity },
                entries: [],
            };
            const rebound = serializeJournalFile(file);
            const reboundBytes = assertCapacity(file, rebound);
            writeJournalFile(path, rebound, onPublicationBoundary);
            for (const name of segmentNames) {
                if (Number(name.slice(0, 16)) <= revision) {
                    try {
                        unlinkSync(join(segmentDirectory, name));
                    }
                    catch {
                        // The rebound snapshot owns the current revision and no old
                        // identity authority; redundant cleanup remains best-effort.
                    }
                }
            }
            try {
                rmdirSync(segmentDirectory);
            }
            catch {
                // Redundant old segments are ignored at or below the snapshot revision.
            }
            return { file, exists: true, serializedBytes: reboundBytes };
        }
        if (recoveringMissingSnapshot) {
            if (orphanRecoveryUnsafe ||
                !orphanRecoverySawBaseRemoval ||
                file.entries.length > 0) {
                throw createJournalError("invalid", path, `is missing while ${segmentDirectory} retains revision segments`);
            }
            const recovered = serializeJournalFile(file);
            const recoveredBytes = assertCapacity(file, recovered);
            writeJournalFile(path, recovered, onPublicationBoundary);
            notifyRecovery({
                kind: "repaired",
                path,
                revision: file.revision,
                reason: "Recovered a missing snapshot from a complete empty segment history.",
            });
            return { file, exists: true, serializedBytes: recoveredBytes };
        }
        const serializedBytes = assertCapacity(file);
        return { file, exists: true, serializedBytes };
    };
    const readCurrent = () => {
        try {
            return readCurrentStrict();
        }
        catch (error) {
            if (withPairingAdmission ||
                !(error instanceof TelegramUpdateJournalError) ||
                error.code !== "invalid") {
                throw error;
            }
            let snapshotExists = false;
            try {
                statSync(path);
                snapshotExists = true;
            }
            catch (snapshotError) {
                if (snapshotError?.code !== "ENOENT")
                    throw error;
            }
            const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
            let segmentNames;
            try {
                segmentNames = readdirSync(segmentDirectory)
                    .filter((name) => /^\d{16}\.json$/u.test(name))
                    .sort();
            }
            catch {
                throw error;
            }
            if (segmentNames.length === 0)
                throw error;
            // Earlier corruption must not hide a newer schema behind repair or reset.
            let recoverySegmentBytes = 0;
            for (const candidatePath of [
                ...(snapshotExists ? [path] : []),
                ...segmentNames.map((name) => join(segmentDirectory, name)),
            ]) {
                const size = statSync(candidatePath).size;
                if (candidatePath !== path)
                    recoverySegmentBytes += size;
                if (size > maxBytes || recoverySegmentBytes > maxBytes) {
                    throw createJournalError("capacity", candidatePath, "exceeds the recovery inspection byte limit");
                }
                try {
                    assertSupportedJournalVersion(JSON.parse(readFileSync(candidatePath, "utf8")), candidatePath);
                }
                catch (inspectionError) {
                    if (!(inspectionError instanceof SyntaxError))
                        throw inspectionError;
                }
            }
            if (snapshotExists) {
                try {
                    const snapshot = parseJournalFile(JSON.parse(readFileSync(path, "utf8")), path);
                    const firstSegmentPath = join(segmentDirectory, segmentNames[0]);
                    const firstSegment = parseJournalSegment(JSON.parse(readFileSync(firstSegmentPath, "utf8")), firstSegmentPath);
                    if (snapshot.revision === undefined &&
                        firstSegment.previousRevision > 0 &&
                        snapshot.profile === firstSegment.profile &&
                        identitiesMatch(snapshot.botIdentity, firstSegment.botIdentity)) {
                        writeJournalFile(path, serializeJournalFile({
                            ...snapshot,
                            revision: firstSegment.previousRevision,
                        }), onPublicationBoundary);
                        const repaired = readCurrentStrict();
                        notifyRecovery({
                            kind: "repaired",
                            path,
                            revision: repaired.file.revision,
                            reason: `Recovered a revisionless snapshot from segment revision ${firstSegment.revision}.`,
                        });
                        return repaired;
                    }
                }
                catch (recoveryError) {
                    if (recoveryError instanceof TelegramUpdateJournalError) {
                        if (recoveryError.code !== "invalid")
                            throw recoveryError;
                    }
                    else if (!(recoveryError instanceof SyntaxError)) {
                        throw recoveryError;
                    }
                    // Only known schema/JSON corruption may fall through to reset.
                }
            }
            // Approved corruption policy: delete damaged evidence instead of quarantining it under recovery/.
            // Segments go first so a fresh revisionless snapshot can never replay them; a crash repeats the reset.
            const deletedPaths = [];
            const deleteDamaged = (target, label) => {
                try {
                    lstatSync(target);
                }
                catch (statError) {
                    if (statError.code === "ENOENT")
                        return;
                    throw createJournalError("io", target, `could not inspect an unrecoverable ${label}`, statError);
                }
                try {
                    rmSync(target, { recursive: true, force: true });
                }
                catch (removeError) {
                    throw createJournalError("io", target, `could not delete an unrecoverable ${label}`, removeError);
                }
                deletedPaths.push(target);
            };
            deleteDamaged(segmentDirectory, "journal segment history");
            // A regular snapshot is replaced atomically below; anything else cannot be a rename target.
            if (snapshotExists && !lstatSync(path).isFile())
                deleteDamaged(path, "journal snapshot");
            const reset = emptyFile();
            const serialized = serializeJournalFile(reset);
            const serializedBytes = assertCapacity(reset, serialized);
            writeJournalFile(path, serialized, onPublicationBoundary);
            if (snapshotExists && !deletedPaths.includes(path))
                deletedPaths.push(path);
            notifyRecovery({
                kind: "reset",
                path,
                deletedPaths,
                reason: error.message,
            });
            return { file: reset, exists: true, serializedBytes };
        }
    };
    const acquireSource = () => sourceAccess
        ? acquireTelegramUpdateJournalFamily({
            ...sourceAccess,
            path,
            profile,
            botIdentity: expectedIdentity,
        }, version)
        : undefined;
    const readAcquiredSource = (source) => {
        const file = source.evidence.kind === "present" ? source.evidence.file : emptyFile();
        return {
            file,
            exists: source.evidence.kind === "present",
            serializedBytes: assertCapacity(file),
            source,
        };
    };
    const runJournalTransaction = (operation) => {
        try {
            // Acquire before the transaction helper can create parents or staging names.
            // The config continuation excludes participating writers through consumption.
            const source = acquireSource();
            const readSource = () => source ? readAcquiredSource(source) : readCurrent();
            return withTelegramFileTransaction(`${path}.transaction`, () => {
                // A different source serializer must not carry stale evidence through this family fence.
                source?.assertCurrent();
                return operation(readSource);
            });
        }
        catch (error) {
            if (error instanceof TelegramUpdateJournalError)
                throw error;
            throw createJournalError("io", path, "mutation failed", error);
        }
    };
    const runMutationCore = (operation) => withSourceSerialization
        ? withSourceSerialization(() => runJournalTransaction(operation))
        : runJournalTransaction(operation);
    const runMutation = (operation) => options.withWriterAdmission
        ? options.withWriterAdmission(() => runMutationCore(operation))
        : runMutationCore(operation);
    const assertSourceResources = (files, bytes, work, collections) => {
        if (!sourceAccess)
            return;
        const limits = sourceAccess.limits;
        if (files > limits.maxFiles ||
            bytes > limits.maxBytes ||
            work > limits.maxWork ||
            collections.some((length) => length > limits.maxEntries)) {
            throw createJournalError("capacity", path, "publication would exceed source inspection resource limits");
        }
    };
    const inputHeadroomText = "\0".repeat(TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH);
    const inputBindingHeadroomText = "\0".repeat(TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH);
    const inputHandoffHeadroomText = "\0".repeat(TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH);
    const getFileWork = (file) => file.entries.length +
        (file.operatorDispositions?.length ?? 0) +
        (file.sourceCompletions?.length ?? 0);
    const advanceInputHeadroomState = (state, entries, projectionSlack) => {
        const revision = (state.file.revision ?? 0) + 1;
        if (!isSafePositiveInteger(revision))
            throw createJournalError("capacity", path, "exhausted input custody revisions");
        return { file: { ...state.file, revision, entries }, projectionSlack };
    };
    const replaceInputHeadroomEntry = (file, updateId, replacement) => file.entries.flatMap((entry) => entry.updateId === updateId
        ? replacement
            ? [replacement]
            : []
        : [entry]);
    const createInputHeadroomClaim = (entry, phase) => ({
        phase,
        owner: {
            instanceId: inputHeadroomText,
            processId: Number.MAX_SAFE_INTEGER,
            processBirthId: inputHeadroomText,
            sessionGeneration: Number.MAX_SAFE_INTEGER,
            acquisitionId: inputHeadroomText,
            acquiredAtMs: Number.MAX_SAFE_INTEGER,
            handoffId: inputHandoffHeadroomText,
        },
        recipientBindingKey: inputBindingHeadroomText,
        executionUpdate: structuredClone(entry.update),
    });
    const largestInputHeadroomEntry = (entries, project) => entries.reduce((selected, entry) => {
        const bytes = Buffer.byteLength(JSON.stringify(project(entry), null, 2));
        return !selected || bytes > selected.bytes ? { entry, bytes } : selected;
    }, undefined)?.entry;
    const smallestInputHeadroomEntry = (entries) => entries.reduce((selected, entry) => {
        const bytes = Buffer.byteLength(JSON.stringify(entry, null, 2));
        return !selected || bytes < selected.bytes ? { entry, bytes } : selected;
    }, undefined)?.entry;
    const createInputHeadroomTransitionPlan = (file, entry) => {
        const initial = { file, projectionSlack: 0 };
        if (entry.inputClaim?.phase === "running")
            return [
                advanceInputHeadroomState(initial, replaceInputHeadroomEntry(file, entry.updateId), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES),
            ];
        if (entry.state === "pending" &&
            entry.inputClaim?.phase === "ready" &&
            entry.inputClaim.handoff) {
            const acceptedClaim = {
                ...entry.inputClaim,
                owner: {
                    ...entry.inputClaim.handoff.recipientOwner,
                    acquisitionId: inputHeadroomText,
                    acquiredAtMs: Number.MAX_SAFE_INTEGER,
                    handoffId: inputHandoffHeadroomText,
                },
            };
            delete acceptedClaim.handoff;
            const acceptedEntry = { ...entry, inputClaim: acceptedClaim };
            const acceptedState = advanceInputHeadroomState(initial, replaceInputHeadroomEntry(file, entry.updateId, acceptedEntry), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
            return [
                acceptedState,
                ...createInputHeadroomTransitionPlan(acceptedState.file, acceptedEntry),
            ];
        }
        if (entry.state === "pending" && entry.inputClaim?.phase === "ready") {
            const runningEntry = {
                ...entry,
                inputClaim: { ...entry.inputClaim, phase: "running" },
            };
            const runningState = advanceInputHeadroomState(initial, replaceInputHeadroomEntry(file, entry.updateId, runningEntry), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
            return [
                runningState,
                advanceInputHeadroomState(runningState, replaceInputHeadroomEntry(runningState.file, entry.updateId), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES),
            ];
        }
        if (entry.state === "pending" &&
            entry.preApprovalExcluded === false &&
            !entry.inputClaim) {
            const readyEntry = {
                ...entry,
                inputClaim: createInputHeadroomClaim(entry, "ready"),
            };
            const readyState = advanceInputHeadroomState(initial, replaceInputHeadroomEntry(file, entry.updateId, readyEntry), TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES);
            const runningEntry = {
                ...readyEntry,
                inputClaim: { ...readyEntry.inputClaim, phase: "running" },
            };
            const runningState = advanceInputHeadroomState(readyState, replaceInputHeadroomEntry(readyState.file, entry.updateId, runningEntry), TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES);
            return [
                readyState,
                runningState,
                advanceInputHeadroomState(runningState, replaceInputHeadroomEntry(runningState.file, entry.updateId), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES),
            ];
        }
        return entry.preApprovalExcluded === true
            ? [
                advanceInputHeadroomState(initial, replaceInputHeadroomEntry(file, entry.updateId), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES),
            ]
            : [];
    };
    const createInputHeadroomCancelPlan = (file, entry) => {
        if (!entry.inputClaim?.handoff)
            return [];
        const claim = structuredClone(entry.inputClaim);
        delete claim.handoff;
        const cancelledEntry = { ...entry, inputClaim: claim };
        const initial = { file, projectionSlack: 0 };
        const cancelledState = advanceInputHeadroomState(initial, replaceInputHeadroomEntry(file, entry.updateId, cancelledEntry), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
        return [
            cancelledState,
            ...createInputHeadroomTransitionPlan(cancelledState.file, cancelledEntry),
        ];
    };
    const createInputHeadroomReleasePlan = (file, entry, allowOffered = false) => {
        if (entry.inputClaim?.handoff && !allowOffered)
            return [];
        const normal = createInputHeadroomTransitionPlan(file, entry);
        const readyState = entry.inputClaim?.phase === "ready"
            ? { file, projectionSlack: 0 }
            : normal[0];
        if (!readyState)
            return [];
        const readyEntry = readyState.file.entries.find((candidate) => candidate.updateId === entry.updateId);
        if (readyEntry?.inputClaim?.phase !== "ready")
            return [];
        const releasedEntry = cloneEntry(readyEntry);
        delete releasedEntry.inputClaim;
        const releasedState = advanceInputHeadroomState(readyState, replaceInputHeadroomEntry(readyState.file, entry.updateId, releasedEntry), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
        const reacquisition = createInputHeadroomTransitionPlan(releasedState.file, releasedEntry);
        return [
            ...(readyState.file === file ? [] : [readyState]),
            releasedState,
            ...reacquisition,
        ];
    };
    const createInputHeadroomQueueCompletionPlan = (file, entries) => {
        if (entries.length === 0 ||
            entries.some((entry) => entry.state !== "queued" || entry.queueHandoff))
            return [];
        const requestedIds = new Set(entries.map((entry) => entry.updateId));
        const initial = { file, projectionSlack: 0 };
        return [
            advanceInputHeadroomState(initial, file.entries.filter((entry) => !requestedIds.has(entry.updateId)), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES),
        ];
    };
    const getInputHeadroomTransitionPlans = (file, updateId) => {
        if (updateId !== "all") {
            const requestedIds = new Set(typeof updateId === "number" ? [updateId] : [...updateId]);
            const requestedEntries = file.entries.filter((entry) => requestedIds.has(entry.updateId));
            const queuedReceiptId = requestedEntries[0]?.queueReceiptId;
            if (requestedEntries.length === requestedIds.size &&
                queuedReceiptId &&
                requestedEntries.every((entry) => entry.state === "queued" &&
                    entry.queueReceiptId === queuedReceiptId) &&
                file.entries.filter((entry) => entry.queueReceiptId === queuedReceiptId)
                    .length === requestedIds.size) {
                const completion = createInputHeadroomQueueCompletionPlan(file, requestedEntries);
                return completion.length > 0 ? [completion] : [];
            }
            if (typeof updateId !== "number")
                return [];
            const entry = requestedEntries[0];
            const plan = entry ? createInputHeadroomTransitionPlan(file, entry) : [];
            const cancel = entry ? createInputHeadroomCancelPlan(file, entry) : [];
            const recover = entry?.inputClaim?.handoff
                ? createInputHeadroomReleasePlan(file, entry, true)
                : [];
            return [plan, cancel, recover].filter((candidate) => candidate.length > 0);
        }
        const running = smallestInputHeadroomEntry(file.entries.filter((entry) => entry.inputClaim?.phase === "running"));
        const offered = largestInputHeadroomEntry(file.entries.filter((entry) => entry.state === "pending" &&
            entry.inputClaim?.phase === "ready" &&
            entry.inputClaim.handoff), (entry) => ({
            ...entry,
            inputClaim: {
                ...entry.inputClaim,
                owner: {
                    ...entry.inputClaim.handoff.recipientOwner,
                    acquisitionId: inputHeadroomText,
                    acquiredAtMs: Number.MAX_SAFE_INTEGER,
                    handoffId: inputHandoffHeadroomText,
                },
                handoff: undefined,
            },
        }));
        const ready = largestInputHeadroomEntry(file.entries.filter((entry) => entry.state === "pending" &&
            entry.inputClaim?.phase === "ready" &&
            !entry.inputClaim.handoff), (entry) => ({
            ...entry,
            inputClaim: { ...entry.inputClaim, phase: "running" },
        }));
        const unclaimed = largestInputHeadroomEntry(file.entries.filter((entry) => entry.state === "pending" &&
            entry.preApprovalExcluded === false &&
            !entry.inputClaim), (entry) => ({
            ...entry,
            inputClaim: createInputHeadroomClaim(entry, "running"),
        }));
        const excluded = smallestInputHeadroomEntry(file.entries.filter((entry) => entry.preApprovalExcluded === true));
        const representatives = [
            running,
            offered,
            ready,
            unclaimed,
            excluded,
        ].filter((entry) => entry !== undefined);
        const plans = representatives.map((entry) => createInputHeadroomTransitionPlan(file, entry));
        if (offered) {
            plans.push(createInputHeadroomCancelPlan(file, offered));
            plans.push(createInputHeadroomReleasePlan(file, offered, true));
        }
        for (const entry of [ready, unclaimed]) {
            if (entry)
                plans.push(createInputHeadroomReleasePlan(file, entry));
        }
        const queuedReceipts = new Map();
        for (const entry of file.entries) {
            if (entry.state !== "queued" ||
                !entry.queueReceiptId ||
                entry.queueHandoff)
                continue;
            const grouped = queuedReceipts.get(entry.queueReceiptId) ?? [];
            grouped.push(entry);
            queuedReceipts.set(entry.queueReceiptId, grouped);
        }
        for (const entries of queuedReceipts.values()) {
            const completion = createInputHeadroomQueueCompletionPlan(file, entries);
            if (completion.length > 0)
                plans.push(completion);
        }
        return plans;
    };
    const createInputHeadroomSegment = (previous, next) => {
        const previousEntries = new Map(previous.entries.map((entry) => [entry.updateId, entry]));
        const nextEntries = new Map(next.entries.map((entry) => [entry.updateId, entry]));
        return {
            version,
            revision: next.revision,
            previousRevision: next.revision - 1,
            profile: next.profile,
            botIdentity: next.botIdentity,
            upsertedEntries: next.entries.filter((entry) => !previousEntries.has(entry.updateId) ||
                !isDeepStrictEqual(previousEntries.get(entry.updateId), entry)),
            removedUpdateIds: previous.entries
                .filter((entry) => !nextEntries.has(entry.updateId))
                .map((entry) => entry.updateId),
            ...(next.acceptedThroughUpdateId !== undefined
                ? { acceptedThroughUpdateId: next.acceptedThroughUpdateId }
                : {}),
        };
    };
    const assertInputHeadroomCapacity = (file, extraBytes) => {
        const bytes = assertCapacity(file);
        if (bytes > maxBytes - extraBytes) {
            throw createJournalError("capacity", path, "does not retain logical input transition headroom");
        }
        return bytes + extraBytes;
    };
    const assertInputProgressHeadroom = (current, publishedFile, updateId, publishedSegment) => {
        const plans = getInputHeadroomTransitionPlans(publishedFile, updateId);
        if (plans.length === 0)
            return;
        const sourceSegments = current.source?.segments ?? [];
        let baseRetainedCount = sourceSegments.length;
        let baseRetainedBytes = sourceSegments.reduce((sum, segment) => sum + segment.bytes, 0);
        let baseRetainedWork = sourceSegments.reduce((sum, segment) => sum + segment.work, 0);
        const publishedBytes = assertInputHeadroomCapacity(publishedFile, 0);
        let baseAccounting = current.source?.evidence.kind === "present"
            ? { ...current.source.evidence.accounting }
            : { files: 1, bytes: publishedBytes, work: getFileWork(publishedFile) };
        if (publishedSegment) {
            const segmentWork = publishedSegment.upsertedEntries.length +
                publishedSegment.removedUpdateIds.length +
                (publishedSegment.operatorDispositions?.length ?? 0) +
                (publishedSegment.sourceCompletions?.length ?? 0);
            const segmentBytes = Buffer.byteLength(`${JSON.stringify(publishedSegment, null, 2)}\n`);
            baseRetainedCount += 1;
            baseRetainedBytes += segmentBytes;
            baseRetainedWork += segmentWork;
            const segmentFirst = {
                files: baseAccounting.files + 1,
                bytes: baseAccounting.bytes + segmentBytes,
                work: baseAccounting.work + segmentWork + getFileWork(publishedFile),
            };
            const compactResidue = {
                files: 1 + baseRetainedCount,
                bytes: publishedBytes + baseRetainedBytes,
                work: getFileWork(publishedFile) + baseRetainedWork,
            };
            baseAccounting = {
                files: Math.max(segmentFirst.files, compactResidue.files),
                bytes: Math.max(segmentFirst.bytes, compactResidue.bytes),
                work: Math.max(segmentFirst.work, compactResidue.work),
            };
        }
        for (const transitions of plans) {
            let retainedCount = baseRetainedCount;
            let retainedBytes = baseRetainedBytes;
            let retainedWork = baseRetainedWork;
            let accounting = { ...baseAccounting };
            let state = {
                file: publishedFile,
                projectionSlack: 0,
            };
            for (const next of transitions) {
                const segment = createInputHeadroomSegment(state.file, next.file);
                const segmentCollections = [
                    segment.upsertedEntries.length,
                    segment.removedUpdateIds.length,
                    segment.operatorDispositions?.length ?? 0,
                    next.file.entries.length,
                    next.file.operatorDispositions?.length ?? 0,
                ];
                const segmentWork = segmentCollections[0] +
                    segmentCollections[1] +
                    segmentCollections[2];
                const segmentBytes = Buffer.byteLength(`${JSON.stringify(segment, null, 2)}\n`) +
                    next.projectionSlack;
                const nextBytes = assertInputHeadroomCapacity(next.file, next.projectionSlack);
                const segmentFirst = {
                    files: accounting.files + 1,
                    bytes: accounting.bytes + segmentBytes,
                    work: accounting.work + segmentWork + getFileWork(next.file),
                };
                assertSourceResources(segmentFirst.files, segmentFirst.bytes, segmentFirst.work, segmentCollections);
                retainedCount += 1;
                retainedBytes += segmentBytes;
                retainedWork += segmentWork;
                const compactResidue = {
                    files: 1 + retainedCount,
                    bytes: nextBytes + retainedBytes,
                    work: getFileWork(next.file) + retainedWork,
                };
                assertSourceResources(compactResidue.files, compactResidue.bytes, compactResidue.work, segmentCollections);
                accounting = {
                    files: Math.max(segmentFirst.files, compactResidue.files),
                    bytes: Math.max(segmentFirst.bytes, compactResidue.bytes),
                    work: Math.max(segmentFirst.work, compactResidue.work),
                };
                state = next;
            }
        }
    };
    const publishSourceSegment = (current, file, segment, publicationBoundary, forceCompact) => {
        const source = current.source;
        if (source.evidence.kind !== "present")
            throw createJournalError("invalid", path, "requires existing source evidence");
        const revisedFile = { ...file, revision: segment.revision };
        const serialized = serializeJournalFile(revisedFile);
        const serializedBytes = assertCapacity(revisedFile, serialized);
        const segmentText = `${JSON.stringify(segment, null, 2)}\n`;
        const segmentBytes = Buffer.byteLength(segmentText);
        const collections = [
            segment.upsertedEntries.length,
            segment.removedUpdateIds.length,
            segment.operatorDispositions?.length ?? 0,
            file.entries.length,
            file.operatorDispositions?.length ?? 0,
            segment.sourceCompletions?.length ?? 0,
            file.sourceCompletions?.length ?? 0,
        ];
        const segmentWork = collections[0] + collections[1] + collections[2] + collections[5];
        const fileWork = collections[3] + collections[4] + collections[6];
        const accounting = source.evidence.accounting;
        // Both the segment-first state and snapshot-first cleanup residue must fit.
        assertSourceResources(accounting.files + 1, accounting.bytes + segmentBytes, accounting.work + segmentWork + fileWork, collections);
        const unapplied = source.segments.filter((item) => Number(item.name.slice(0, 16)) > source.snapshotRevision);
        const compact = forceCompact ||
            unapplied.length + 1 >=
                TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT ||
            unapplied.reduce((sum, item) => sum + item.bytes, segmentBytes) >=
                TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES;
        if (compact) {
            assertSourceResources(accounting.files + 1, serializedBytes +
                source.segments.reduce((sum, item) => sum + item.bytes, segmentBytes), fileWork +
                source.segments.reduce((sum, item) => sum + item.work, segmentWork), collections);
        }
        const segmentPath = getTelegramUpdateJournalSegmentPath(path, segment.revision);
        // A crash may retain staging, so keep it outside the strictly enumerated segment directory.
        writeJournalFile(segmentPath, segmentText, publicationBoundary, path);
        if (compact) {
            writeJournalFile(path, serialized, publicationBoundary);
            // Snapshot scope must not change. Preserve a validated redundant ID witness instead.
            const witness = file.botIdentity.botId === undefined
                ? source.segments.find((item) => item.botId !== undefined)?.name
                : undefined;
            const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
            const names = [
                ...source.segments.map((item) => item.name),
                basename(segmentPath),
            ];
            for (const name of names) {
                if (name === witness)
                    continue;
                try {
                    unlinkSync(join(segmentDirectory, name));
                }
                catch {
                    // Every subset of redundant cleanup residue was admitted above.
                }
            }
            try {
                rmdirSync(segmentDirectory);
            }
            catch {
                /* Retained witness or cleanup residue. */
            }
        }
        return { file: revisedFile, serializedBytes };
    };
    const publishMutation = (current, entries, contentChanged, operatorDispositions = current.file.operatorDispositions, acceptedThroughUpdateId = current.file.acceptedThroughUpdateId, publicationBoundary = onPublicationBoundary, inputHeadroom = journalHasCustodyFields(version)
        ? "all"
        : false, sourceCompletions = current.file.sourceCompletions) => {
        const botIdentity = current.source
            ? current.file.botIdentity
            : mergeBotIdentity(current.file.botIdentity, expectedIdentity);
        if (!contentChanged &&
            isDeepStrictEqual(current.file.botIdentity, botIdentity) &&
            isDeepStrictEqual(current.file.operatorDispositions ?? [], operatorDispositions ?? []) &&
            current.file.acceptedThroughUpdateId === acceptedThroughUpdateId &&
            isDeepStrictEqual(current.file.sourceCompletions ?? [], sourceCompletions ?? [])) {
            return { file: current.file, serializedBytes: current.serializedBytes };
        }
        const file = {
            version,
            profile,
            botIdentity,
            entries,
            ...(acceptedThroughUpdateId !== undefined
                ? { acceptedThroughUpdateId }
                : {}),
            ...(operatorDispositions?.length ? { operatorDispositions } : {}),
            ...(sourceCompletions?.length ? { sourceCompletions } : {}),
        };
        assertJournalRoutingInputContinuity(current.file, entries, path);
        const previousEntries = new Map(current.file.entries.map((entry) => [entry.updateId, entry]));
        if (version === TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION) {
            for (const entry of entries)
                assertPrivateTextReplyContinuity(previousEntries.get(entry.updateId), entry, path);
        }
        if (withPairingAdmission || current.source)
            parseJournalFile(file, path, version);
        const serialized = serializeJournalFile(file);
        const serializedBytes = assertCapacity(file, serialized);
        const changed = contentChanged ||
            current.file.acceptedThroughUpdateId !== acceptedThroughUpdateId ||
            !isDeepStrictEqual(current.file.botIdentity, file.botIdentity) ||
            !isDeepStrictEqual(current.file.sourceCompletions ?? [], sourceCompletions ?? []);
        if (!changed) {
            return { file, serializedBytes: current.serializedBytes };
        }
        if (!current.exists) {
            if (current.source) {
                const collections = [
                    file.entries.length,
                    file.operatorDispositions?.length ?? 0,
                    file.sourceCompletions?.length ?? 0,
                ];
                assertSourceResources(1, serializedBytes, collections[0] + collections[1] + collections[2], collections);
            }
            if (inputHeadroom !== false)
                assertInputProgressHeadroom(current, file, inputHeadroom);
            writeJournalFile(path, serialized, publicationBoundary);
            return { file, serializedBytes };
        }
        if (withPairingAdmission &&
            entries.some((entry) => {
                const previous = previousEntries.get(entry.updateId);
                return (previous && previous.preApprovalExcluded !== entry.preApprovalExcluded);
            })) {
            throw createJournalError("pairing-evidence", path, "changes immutable exclusion evidence");
        }
        const nextEntries = new Map(entries.map((entry) => [entry.updateId, entry]));
        const upsertedEntries = entries.filter((entry) => !previousEntries.has(entry.updateId) ||
            !isDeepStrictEqual(previousEntries.get(entry.updateId), entry));
        const removedUpdateIds = current.file.entries
            .filter((entry) => !nextEntries.has(entry.updateId))
            .map((entry) => entry.updateId);
        const revision = (current.file.revision ?? 0) + 1;
        const segment = {
            version,
            revision,
            previousRevision: revision - 1,
            profile,
            botIdentity: file.botIdentity,
            upsertedEntries,
            removedUpdateIds,
            ...(acceptedThroughUpdateId !== undefined
                ? { acceptedThroughUpdateId }
                : {}),
            ...(!isDeepStrictEqual(current.file.operatorDispositions ?? [], operatorDispositions ?? [])
                ? { operatorDispositions: operatorDispositions ?? [] }
                : {}),
            ...(!isDeepStrictEqual(current.file.sourceCompletions ?? [], sourceCompletions ?? [])
                ? { sourceCompletions: sourceCompletions ?? [] }
                : {}),
        };
        if (current.source) {
            if (!isSafePositiveInteger(revision))
                throw createJournalError("capacity", path, "exhausted source revisions");
            const revisedFile = { ...file, revision };
            if (inputHeadroom !== false)
                assertInputProgressHeadroom(current, revisedFile, inputHeadroom, segment);
            return publishSourceSegment(current, file, segment, publicationBoundary, journalHasCustodyFields(version));
        }
        publishTelegramUpdateJournalSegmentUnlocked(path, segment, publicationBoundary);
        const revisedFile = { ...file, revision };
        const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
        const segmentNames = readdirSync(segmentDirectory).filter((name) => /^\d{16}\.json$/u.test(name));
        let snapshotRevision = 0;
        try {
            snapshotRevision =
                parseJournalFile(JSON.parse(readFileSync(path, "utf8")), path, version).revision ?? 0;
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
        const unappliedSegmentNames = segmentNames.filter((name) => Number(name.slice(0, 16)) > snapshotRevision);
        const segmentBytes = unappliedSegmentNames.reduce((total, name) => total + statSync(join(segmentDirectory, name)).size, 0);
        if (unappliedSegmentNames.length >=
            TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT ||
            segmentBytes >= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES) {
            const compacted = serializeJournalFile(revisedFile);
            const compactedBytes = assertCapacity(revisedFile, compacted);
            writeJournalFile(path, compacted, publicationBoundary);
            for (const name of segmentNames) {
                if (Number(name.slice(0, 16)) <= revision) {
                    try {
                        unlinkSync(join(segmentDirectory, name));
                    }
                    catch {
                        // The published snapshot already owns this revision; redundant
                        // segments are safe and will be ignored on reconstruction.
                    }
                }
            }
            try {
                rmdirSync(segmentDirectory);
            }
            catch {
                // Interrupted cleanup may leave an empty directory or old segments.
            }
            return { file: revisedFile, serializedBytes: compactedBytes };
        }
        return { file: revisedFile, serializedBytes };
    };
    const removeCompleted = (updateIds, expectedSources, exact = false, completionInput, isCurrent) => runMutation((readCurrent) => {
        const assertCurrent = () => {
            if (isCurrent && !isCurrent())
                throw createJournalError("conflict", path, "exact removal authority ended");
        };
        assertCurrent();
        const current = exact && !sourceAccess ? readCurrentStrict(false) : readCurrent();
        if (completionInput !== undefined && !sourceAccess)
            throw createJournalError("invalid", path, "source completion requires an exact source handle");
        const completions = completionInput === undefined
            ? undefined
            : validateJournalSourceCompletions(completionInput, path, version);
        if (exact && expectedSources === undefined)
            throw createJournalError("invalid", path, "received no exact completion sources");
        const requestedIds = new Set();
        for (const updateId of updateIds) {
            if (!isSafeNonNegativeInteger(updateId))
                throw createJournalError("invalid", path, "received an invalid removal update id");
            requestedIds.add(updateId);
        }
        if (expectedSources !== undefined) {
            if (!Array.isArray(expectedSources) || !expectedSources.length)
                throw createJournalError("invalid", path, "received no exact completion sources");
            const expectedIds = new Set();
            for (const expected of expectedSources) {
                if (!isRecord(expected) ||
                    Object.keys(expected).some((key) => !["updateId", "sourceSha256"].includes(key)) ||
                    !isSafeNonNegativeInteger(expected.updateId) ||
                    !requestedIds.has(expected.updateId) ||
                    expectedIds.has(expected.updateId) ||
                    typeof expected.sourceSha256 !== "string" ||
                    !/^[a-f0-9]{64}$/u.test(expected.sourceSha256)) {
                    throw createJournalError("invalid", path, "received an invalid exact completion source");
                }
                expectedIds.add(expected.updateId);
                const entry = current.file.entries.find((value) => value.updateId === expected.updateId);
                if (!entry ||
                    createTelegramUpdateJournalEntryDigest(entry).sourceSha256 !==
                        expected.sourceSha256) {
                    throw createJournalError("conflict", path, "exact completion source changed or disappeared");
                }
            }
        }
        if (completions) {
            const guards = new Map((expectedSources ?? []).map((source) => [
                source.updateId,
                source.sourceSha256,
            ]));
            if (completions.some((completion) => guards.get(completion.updateId) !== completion.sourceSha256)) {
                throw createJournalError("invalid", path, "source completion has no matching exact guard");
            }
        }
        const requestedEntries = current.file.entries.filter((entry) => requestedIds.has(entry.updateId));
        const protectedEntry = requestedEntries.find((entry) => entry.state === "failed" || entry.state === "queued");
        if (protectedEntry)
            throw createJournalError("conflict", path, protectedEntry.state === "failed"
                ? `cannot complete terminal update ${protectedEntry.updateId} without an operator disposition`
                : `cannot complete queued update ${protectedEntry.updateId} without its exact owner receipt`);
        const removedUpdateIds = requestedEntries.map((entry) => entry.updateId);
        const sourceCompletions = completions
            ? [...(current.file.sourceCompletions ?? []), ...completions].sort((a, b) => a.updateId - b.updateId)
            : current.file.sourceCompletions;
        if (sourceCompletions?.length)
            validateJournalSourceCompletions(sourceCompletions, path, version);
        assertCurrent();
        const published = publishMutation(current, current.file.entries.filter((entry) => !requestedIds.has(entry.updateId)), removedUpdateIds.length > 0, current.file.operatorDispositions, current.file.acceptedThroughUpdateId, isCurrent
            ? (boundary, target) => {
                onPublicationBoundary?.(boundary, target);
                assertCurrent();
            }
            : onPublicationBoundary, false, sourceCompletions);
        assertCurrent();
        return {
            removedUpdateIds,
            entryCount: published.file.entries.length,
            serializedBytes: published.serializedBytes,
            ...(completions
                ? {
                    sourceCompletions: completions.map((completion) => ({
                        ...completion,
                    })),
                }
                : {}),
        };
    });
    const completeQueued = (receipts, completionInput, exact = false) => runMutation((readCurrent) => {
        if (exact && !sourceAccess)
            throw createJournalError("invalid", path, "source completion requires an exact source handle");
        const completions = exact
            ? validateJournalSourceCompletions(completionInput, path, version)
            : undefined;
        if (!Array.isArray(receipts) || receipts.length === 0)
            throw createJournalError("invalid", path, "received no queued receipts to complete");
        const current = readCurrent();
        const receiptIds = new Set(), requestedUpdateIds = new Set();
        const queueGroups = new Map();
        for (const entry of current.file.entries) {
            if (!entry.queueReceiptId)
                continue;
            const group = queueGroups.get(entry.queueReceiptId) ?? [];
            group.push(entry);
            queueGroups.set(entry.queueReceiptId, group);
        }
        for (const receipt of receipts) {
            if ((receipt.queueKind !== "prompt" && receipt.queueKind !== "control") ||
                !isNonEmptyString(receipt.receiptId) ||
                receiptIds.has(receipt.receiptId) ||
                !Array.isArray(receipt.sourceUpdateIds) ||
                receipt.sourceUpdateIds.length === 0) {
                throw createJournalError("invalid", path, "received an invalid queued completion receipt");
            }
            receiptIds.add(receipt.receiptId);
            const queueOwner = validateJournalQueueOwner(receipt.queueOwner, path);
            if (queueRuntimeIdentity &&
                (queueOwner.instanceId !== queueRuntimeIdentity.instanceId ||
                    queueOwner.processId !== queueRuntimeIdentity.processId ||
                    queueOwner.processBirthId !== queueRuntimeIdentity.processBirthId)) {
                throw createJournalError("conflict", path, `cannot complete foreign queue receipt ${receipt.receiptId}`);
            }
            const sourceUpdateIds = new Set();
            for (const updateId of receipt.sourceUpdateIds) {
                if (!isSafeNonNegativeInteger(updateId) ||
                    sourceUpdateIds.has(updateId) ||
                    requestedUpdateIds.has(updateId)) {
                    throw createJournalError("invalid", path, "received overlapping queued completion update ids");
                }
                sourceUpdateIds.add(updateId);
                requestedUpdateIds.add(updateId);
            }
            const persistedReceiptEntries = queueGroups.get(receipt.receiptId) ?? [];
            if (persistedReceiptEntries.length !== sourceUpdateIds.size ||
                persistedReceiptEntries.some((entry) => !sourceUpdateIds.has(entry.updateId) ||
                    entry.state !== "queued" ||
                    entry.queueKind !== receipt.queueKind ||
                    !entry.queueOwner ||
                    entry.queueHandoff !== undefined ||
                    !areTelegramUpdateJournalQueueOwnersEqual(entry.queueOwner, queueOwner))) {
                throw createJournalError("conflict", path, `cannot complete stale or foreign queue receipt ${receipt.receiptId}`);
            }
        }
        const removedEntries = current.file.entries.filter((entry) => requestedUpdateIds.has(entry.updateId));
        const removedUpdateIds = removedEntries.map((entry) => entry.updateId);
        if (removedUpdateIds.length !== requestedUpdateIds.size)
            throw createJournalError("conflict", path, "queued completion did not resolve every source update");
        if (completions) {
            // Claims/provenance carry no purpose flag; the durable latch is structural private evidence.
            if (version === TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION && removedEntries.some(entry => entry.privateTextReply))
                throw createJournalError("conflict", path, "ordinary queued completion cannot remove private Text Input evidence");
            const sources = new Map(removedEntries.map((entry) => [
                entry.updateId,
                createTelegramUpdateJournalEntryDigest(entry).sourceSha256,
            ]));
            if (completions.some((completion) => sources.get(completion.updateId) !== completion.sourceSha256)) {
                throw createJournalError("conflict", path, "queued completion source changed or belongs to another receipt");
            }
        }
        const sourceCompletions = completions
            ? [...(current.file.sourceCompletions ?? []), ...completions].sort((a, b) => a.updateId - b.updateId)
            : current.file.sourceCompletions;
        if (sourceCompletions?.length)
            validateJournalSourceCompletions(sourceCompletions, path, version);
        const published = publishMutation(current, current.file.entries.filter((entry) => !requestedUpdateIds.has(entry.updateId)), true, current.file.operatorDispositions, current.file.acceptedThroughUpdateId, onPublicationBoundary, exact ? false : undefined, sourceCompletions);
        return {
            removedUpdateIds,
            entryCount: published.file.entries.length,
            serializedBytes: published.serializedBytes,
            ...(completions
                ? {
                    sourceCompletions: completions.map((completion) => ({
                        ...completion,
                    })),
                }
                : {}),
        };
    });
    const mutateRoutingInputs = (input, select, publishedAtMs, chooser) => runMutation((readCurrent) => {
        if (!isTelegramUpdateJournalLegacyFamilyVersion(version))
            throw createJournalError("unsupported-version", path, "routing input lifetime requires a private v1 source");
        const binding = createTelegramUpdateJournalBindingKey({
            path,
            profileName: profile,
            botIdentity: expectedIdentity,
        });
        if (input.journalBindingKey !== binding ||
            !isSafePositiveInteger(input.operatorUserId) ||
            typeof input.isCurrent !== "function" ||
            !Array.isArray(input.entries) ||
            !input.entries.length ||
            input.entries.length > maxEntries) {
            throw createJournalError("invalid", path, "invalid routing input lifetime authority");
        }
        const assertCurrent = () => {
            if (!input.isCurrent())
                throw createJournalError("conflict", path, "routing input lifetime authority ended");
        };
        assertCurrent();
        const expected = input.entries.map((entry) => validateJournalEntry(entry, path, version));
        if (new Set(expected.map((entry) => entry.updateId)).size !==
            expected.length)
            throw createJournalError("invalid", path, "duplicate routing input sources");
        const current = sourceAccess ? readCurrent() : readCurrentStrict(false);
        const nowMs = select ? getNowMs() : publishedAtMs;
        if (!isSafeNonNegativeInteger(nowMs) ||
            !Number.isSafeInteger(nowMs + TELEGRAM_ROUTING_INPUT_TTL_MS) ||
            (!select && nowMs > getNowMs()))
            throw createJournalError("invalid", path, "invalid routing input lifetime clock");
        let issued = false;
        const changed = new Map();
        const result = expected.map((original) => {
            const entry = current.file.entries.find((value) => value.updateId === original.updateId);
            if (!entry ||
                entry.state !== "pending" ||
                original.state !== "pending" ||
                entry.inputClaim ||
                entry.inputProvenance ||
                entry.queueOwner) {
                throw createJournalError("conflict", path, "routing input source is not unclaimed pending work");
            }
            const withoutLifetime = (value) => {
                const copy = cloneEntry(value);
                delete copy.routingInput;
                return copy;
            };
            if (!isDeepStrictEqual(entry, original) &&
                (!isDeepStrictEqual(withoutLifetime(entry), withoutLifetime(original)) ||
                    (original.routingInput &&
                        !isDeepStrictEqual(original.routingInput, entry.routingInput)))) {
                throw createJournalError("conflict", path, "routing input source changed");
            }
            const lifetime = entry.routingInput;
            if (lifetime && lifetime.operatorUserId !== input.operatorUserId)
                throw createJournalError("conflict", path, "routing input belongs to another operator");
            if (createPendingRetentionReference({
                path,
                journalBindingKey: binding,
                entry,
                maxBytes,
            }).read()) {
                throw createJournalError("conflict", path, "routing input has protected retention");
            }
            if (select) {
                if (!lifetime ||
                    (lifetime.phase === "waiting" && nowMs >= lifetime.expiresAtMs))
                    throw createJournalError("conflict", path, "routing input choice expired or was not armed");
                if (lifetime.phase === "selected")
                    return cloneEntry(entry);
                issued = true;
                const selected = {
                    ...cloneEntry(entry),
                    routingInput: { ...lifetime, phase: "selected" },
                };
                changed.set(entry.updateId, selected);
                return cloneEntry(selected);
            }
            if (lifetime) {
                if (lifetime.phase !== "waiting")
                    throw createJournalError("conflict", path, "selected routing input cannot renew its choice");
                return cloneEntry(entry);
            }
            if (nowMs < entry.admittedAtMs)
                throw createJournalError("conflict", path, "routing input publication predates admission");
            issued = true;
            const armed = {
                ...cloneEntry(entry),
                routingInput: {
                    operatorUserId: input.operatorUserId,
                    publishedAtMs: nowMs,
                    expiresAtMs: nowMs + TELEGRAM_ROUTING_INPUT_TTL_MS,
                    phase: "waiting",
                    ...(chooser ? { chooser: { ...chooser } } : {}),
                },
            };
            changed.set(entry.updateId, armed);
            return cloneEntry(armed);
        });
        assertCurrent();
        if (select &&
            issued &&
            result.some((entry) => !changed.has(entry.updateId)))
            throw createJournalError("conflict", path, "routing input selection has mixed prior phases");
        if (changed.size)
            publishMutation(current, current.file.entries.map((entry) => changed.get(entry.updateId) ?? entry), true, current.file.operatorDispositions, current.file.acceptedThroughUpdateId, (boundary, target) => {
                onPublicationBoundary?.(boundary, target);
                assertCurrent();
            });
        assertCurrent();
        return { issued, entries: result };
    });
    const projectRead = (current) => ({
        ...cloneFile(current.file),
        exists: current.exists,
        serializedBytes: current.serializedBytes,
    });
    const tickets = new WeakSet();
    let appendInFlight;
    const journal = {
        read() {
            // Atomic publication makes a repair-free read safe without serialization, so idle
            // status and polling cursor reads create no guards. Any read that needs reconciliation,
            // or races a compaction, falls back to the serialized path that owns repair.
            const attempt = () => {
                try {
                    const source = acquireSource();
                    return source ? readAcquiredSource(source) : readCurrentStrict(false);
                }
                catch {
                    return undefined;
                }
            };
            const current = options.withWriterAdmission
                ? options.withWriterAdmission(attempt)
                : attempt();
            return current
                ? projectRead(current)
                : runMutation((readCurrent) => projectRead(readCurrent()));
        },
        appendBatch(updates, requestedAcceptedThroughUpdateId, ticket) {
            if (ticket && (!tickets.has(ticket) || !ticket.active || ticket.poisoned))
                throw new Error("Ordinary v4 append ticket is unavailable.");
            const canonicalUpdates = updates.map((update) => normalizeIncomingJournaledUpdate(update, path));
            const normalizedUpdates = [];
            for (const normalized of canonicalUpdates) {
                const previous = normalizedUpdates.at(-1);
                if (previous && normalized.update_id < previous.update_id) {
                    throw createJournalError("invalid", path, "received an unordered update batch");
                }
                if (previous?.update_id === normalized.update_id) {
                    if (!isDeepStrictEqual(previous, normalized)) {
                        throw createJournalError("conflict", path, `received conflicting update ${normalized.update_id}`);
                    }
                    continue;
                }
                normalizedUpdates.push(normalized);
            }
            const transactionalAppendWithEvidence = (preApprovalExcluded) => runJournalTransaction((readCurrent) => {
                if (withPairingAdmission &&
                    (typeof preApprovalExcluded !== "boolean" ||
                        requestedAcceptedThroughUpdateId === undefined)) {
                    throw createJournalError("pairing-evidence", path, "requires exclusion evidence and an admission cursor");
                }
                if (requestedAcceptedThroughUpdateId !== undefined &&
                    !isSafeNonNegativeInteger(requestedAcceptedThroughUpdateId)) {
                    throw createJournalError("invalid", path, "received an invalid admission cursor");
                }
                const current = readCurrent();
                const entriesById = new Map(current.file.entries.map((entry) => [entry.updateId, entry]));
                const previousAcceptedThroughUpdateId = current.file.acceptedThroughUpdateId;
                const discardedUpdateIds = new Set([
                    ...(current.file.operatorDispositions ?? [])
                        .filter((disposition) => disposition.action === "discard")
                        .map((disposition) => disposition.updateId),
                    ...(current.file.sourceCompletions ?? []).map((completion) => completion.updateId),
                ]);
                let admittedAtMs;
                const addedUpdateIds = [];
                const duplicateUpdateIds = [];
                for (const update of normalizedUpdates) {
                    if (discardedUpdateIds.has(update.update_id)) {
                        duplicateUpdateIds.push(update.update_id);
                        continue;
                    }
                    const existing = entriesById.get(update.update_id);
                    if (existing) {
                        if (!isDeepStrictEqual(existing.update, update)) {
                            throw createJournalError("conflict", path, `received conflicting update ${update.update_id}`);
                        }
                        duplicateUpdateIds.push(update.update_id);
                        continue;
                    }
                    if (withPairingAdmission &&
                        previousAcceptedThroughUpdateId !== undefined &&
                        update.update_id <= previousAcceptedThroughUpdateId) {
                        duplicateUpdateIds.push(update.update_id);
                        continue;
                    }
                    if (admittedAtMs === undefined) {
                        admittedAtMs = getNowMs();
                        if (!isSafeNonNegativeInteger(admittedAtMs)) {
                            throw createJournalError("invalid", path, "received an invalid admission timestamp");
                        }
                    }
                    const entry = {
                        updateId: update.update_id,
                        update,
                        ...(withPairingAdmission
                            ? { preApprovalExcluded: preApprovalExcluded }
                            : {}),
                        admittedAtMs,
                        state: "pending",
                    };
                    entriesById.set(entry.updateId, entry);
                    addedUpdateIds.push(entry.updateId);
                }
                const batchLastUpdateId = normalizedUpdates.at(-1)?.update_id;
                if (requestedAcceptedThroughUpdateId !== undefined &&
                    batchLastUpdateId !== undefined &&
                    requestedAcceptedThroughUpdateId < batchLastUpdateId) {
                    throw createJournalError("invalid", path, "received an admission cursor behind its batch");
                }
                if (requestedAcceptedThroughUpdateId !== undefined &&
                    previousAcceptedThroughUpdateId !== undefined &&
                    requestedAcceptedThroughUpdateId < previousAcceptedThroughUpdateId) {
                    throw createJournalError("conflict", path, "received a regressing admission cursor");
                }
                const acceptedThroughUpdateId = requestedAcceptedThroughUpdateId ?? previousAcceptedThroughUpdateId;
                const contentChanged = addedUpdateIds.length > 0;
                const published = publishMutation(current, contentChanged
                    ? Array.from(entriesById.values()).sort((left, right) => left.updateId - right.updateId)
                    : current.file.entries, contentChanged, current.file.operatorDispositions, acceptedThroughUpdateId);
                if (ticket) {
                    if (!ticket.active || ticket.poisoned || ticket.captured) {
                        ticket.poisoned = true;
                        throw new Error("Ordinary v4 append capture is conflicting or expired.");
                    }
                    const added = new Set(addedUpdateIds);
                    ticket.captured = new Map(published.file.entries.filter((entry) => added.has(entry.updateId))
                        .map((entry) => [entry.updateId, ordinaryV4EntryDigest(entry, path)]));
                }
                const result = {
                    nonExcludedUpdateIds: normalizedUpdates.flatMap((update) => {
                        const entry = entriesById.get(update.update_id);
                        return entry && entry.preApprovalExcluded !== true
                            ? [entry.updateId]
                            : [];
                    }),
                    addedUpdateIds,
                    duplicateUpdateIds,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
                if (ticket)
                    ticket.returned = result;
                return result;
            });
            const appendWithEvidence = (preApprovalExcluded) => {
                if (ticket && (!tickets.has(ticket) || !ticket.active || ticket.poisoned || ticket.captured)) {
                    ticket.poisoned = true;
                    throw new Error("Ordinary v4 append capture is conflicting or expired.");
                }
                return transactionalAppendWithEvidence(preApprovalExcluded);
            };
            // Sender admission is the outer config authority; journal serialization nests inside it.
            const serializedAppend = (preApprovalExcluded) => withSourceSerialization
                ? withSourceSerialization(() => appendWithEvidence(preApprovalExcluded))
                : appendWithEvidence(preApprovalExcluded);
            const append = () => {
                if (withPairedAdmission) {
                    const result = withPairedAdmission(normalizedUpdates, () => serializedAppend());
                    if (!result.admitted)
                        throw createJournalError("sender-denied", path, "refused paired-only sender admission");
                    return result.value;
                }
                if (withPairingAdmission)
                    return withPairingAdmission(serializedAppend);
                return serializedAppend();
            };
            const admittedAppend = () => {
                if (!workspaceAdmission)
                    return append();
                const operationHash = createHash("sha256").update(path).update("\0");
                for (const update of canonicalUpdates) {
                    operationHash.update(String(update.update_id)).update("\0");
                }
                operationHash.update(String(requestedAcceptedThroughUpdateId ?? "none"));
                return runWithTelegramWorkspaceAdmissions({
                    ledger: workspaceAdmission,
                    operationId: `journal:${operationHash.digest("hex")}`,
                    operationKind: "journal.append",
                    scopes: getTelegramUpdateJournalAdmissionScopes(canonicalUpdates),
                    operation: append,
                });
            };
            return options.withWriterAdmission
                ? options.withWriterAdmission(admittedAppend)
                : admittedAppend();
        },
        markQueued(receipt) {
            return runMutation((readCurrent) => {
                if ((receipt.queueKind !== "prompt" && receipt.queueKind !== "control") ||
                    !isNonEmptyString(receipt.receiptId) ||
                    !Array.isArray(receipt.sourceUpdateIds) ||
                    receipt.sourceUpdateIds.length === 0) {
                    throw createJournalError("invalid", path, "received an invalid queue receipt");
                }
                const requestedOwner = validateJournalQueueOwnerIdentity(receipt.owner, path);
                if (queueRuntimeIdentity &&
                    (requestedOwner.instanceId !== queueRuntimeIdentity.instanceId ||
                        requestedOwner.processId !== queueRuntimeIdentity.processId ||
                        requestedOwner.processBirthId !==
                            queueRuntimeIdentity.processBirthId)) {
                    throw createJournalError("conflict", path, "cannot acquire a queue receipt for another runtime process generation");
                }
                const requestedIds = new Set();
                for (const updateId of receipt.sourceUpdateIds) {
                    if (!isSafeNonNegativeInteger(updateId) ||
                        requestedIds.has(updateId)) {
                        throw createJournalError("invalid", path, "received invalid or duplicate queue receipt update ids");
                    }
                    requestedIds.add(updateId);
                }
                const current = readCurrent();
                const existingReceiptEntries = [];
                const entriesById = new Map();
                for (const entry of current.file.entries) {
                    entriesById.set(entry.updateId, entry);
                    if (entry.queueReceiptId === receipt.receiptId) {
                        existingReceiptEntries.push(entry);
                    }
                }
                const existingReceiptIds = new Set(existingReceiptEntries.map((entry) => entry.updateId));
                if (existingReceiptIds.size > 0 &&
                    (existingReceiptIds.size !== requestedIds.size ||
                        [...existingReceiptIds].some((updateId) => !requestedIds.has(updateId)))) {
                    throw createJournalError("conflict", path, `has a conflicting queue receipt ${receipt.receiptId}`);
                }
                let queueOwner = existingReceiptEntries[0]?.queueOwner;
                if (existingReceiptEntries.length === 0) {
                    const acquiredAtMs = getNowMs();
                    if (!isSafeNonNegativeInteger(acquiredAtMs)) {
                        throw createJournalError("invalid", path, "received an invalid queue acquisition timestamp");
                    }
                    queueOwner = {
                        ...requestedOwner,
                        acquisitionId: randomUUID(),
                        acquiredAtMs,
                    };
                }
                const queuedUpdateIds = [];
                const duplicateUpdateIds = [];
                for (const updateId of receipt.sourceUpdateIds) {
                    const entry = entriesById.get(updateId);
                    if (!entry) {
                        throw createJournalError("conflict", path, `cannot queue missing update ${updateId}`);
                    }
                    if (entry.preApprovalExcluded) {
                        throw createJournalError("pairing-evidence", path, `cannot queue excluded update ${updateId}`);
                    }
                    if (entry.state === "queued") {
                        if (entry.queueKind !== receipt.queueKind ||
                            entry.queueReceiptId !== receipt.receiptId) {
                            throw createJournalError("conflict", path, `update ${updateId} belongs to another queue receipt`);
                        }
                        duplicateUpdateIds.push(updateId);
                        continue;
                    }
                    if (entry.state === "failed") {
                        throw createJournalError("conflict", path, `cannot queue failed update ${updateId}`);
                    }
                    entriesById.set(updateId, {
                        updateId: entry.updateId,
                        update: entry.update,
                        admittedAtMs: entry.admittedAtMs,
                        ...(entry.preApprovalExcluded !== undefined
                            ? { preApprovalExcluded: entry.preApprovalExcluded }
                            : {}),
                        ...(entry.routingInput
                            ? { routingInput: { ...entry.routingInput } }
                            : {}),
                        ...(entry.privateTextReply ? { privateTextReply: structuredClone(entry.privateTextReply) } : {}),
                        state: "queued",
                        queueKind: receipt.queueKind,
                        queueReceiptId: receipt.receiptId,
                        queueOwner: cloneJournalQueueOwner(queueOwner),
                    });
                    queuedUpdateIds.push(updateId);
                }
                const contentChanged = queuedUpdateIds.length > 0;
                const published = publishMutation(current, contentChanged
                    ? current.file.entries.map((entry) => entriesById.get(entry.updateId))
                    : current.file.entries, contentChanged);
                return {
                    queuedUpdateIds,
                    duplicateUpdateIds,
                    ...(queueOwner
                        ? { queueOwner: cloneJournalQueueOwner(queueOwner) }
                        : {}),
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        markExecutionFailure(input) {
            return runMutation((readCurrent) => {
                if (!isSafeNonNegativeInteger(input.updateId) ||
                    !isSafeNonNegativeInteger(input.expectedAttemptCount) ||
                    !isSafeNonNegativeInteger(input.failedAtMs) ||
                    !isBoundedString(input.failureClass, TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH) ||
                    !isBoundedString(input.summary, TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH) ||
                    (input.disposition !== "retry-wait" && input.disposition !== "failed")) {
                    throw createJournalError("invalid", path, "received invalid execution failure metadata");
                }
                if (input.disposition === "retry-wait" &&
                    (!isSafeNonNegativeInteger(input.nextRetryAtMs) ||
                        input.nextRetryAtMs < input.failedAtMs ||
                        input.terminalReason !== undefined)) {
                    throw createJournalError("invalid", path, "received invalid retry-wait disposition");
                }
                if (input.disposition === "failed" &&
                    (!isBoundedString(input.terminalReason, TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH) ||
                        input.nextRetryAtMs !== undefined)) {
                    throw createJournalError("invalid", path, "received invalid terminal failure disposition");
                }
                const current = readCurrent();
                const entry = current.file.entries.find((candidate) => candidate.updateId === input.updateId);
                if (!entry) {
                    throw createJournalError("conflict", path, `cannot fail missing update ${input.updateId}`);
                }
                if (entry.state !== "pending" && entry.state !== "retry-wait") {
                    throw createJournalError("conflict", path, `cannot fail ${entry.state} update ${input.updateId}`);
                }
                const previousAttemptCount = entry.failure?.attemptCount ?? 0;
                if (previousAttemptCount !== input.expectedAttemptCount) {
                    throw createJournalError("conflict", path, `update ${input.updateId} execution attempt changed`);
                }
                const failure = {
                    attemptCount: previousAttemptCount + 1,
                    failedAtMs: input.failedAtMs,
                    failureClass: input.failureClass,
                    summary: input.summary,
                };
                const terminalFailureId = input.disposition === "failed"
                    ? createTelegramUpdateTerminalFailureId({
                        updateId: entry.updateId,
                        attemptCount: failure.attemptCount,
                        failedAtMs: failure.failedAtMs,
                        failureClass: failure.failureClass,
                        terminalAtMs: input.failedAtMs,
                        terminalReason: input.terminalReason,
                    })
                    : undefined;
                const nextEntry = {
                    updateId: entry.updateId,
                    update: entry.update,
                    admittedAtMs: entry.admittedAtMs,
                    ...(entry.routingInput
                        ? { routingInput: { ...entry.routingInput } }
                        : {}),
                    ...(entry.preApprovalExcluded !== undefined
                        ? { preApprovalExcluded: entry.preApprovalExcluded }
                        : {}),
                    ...(entry.privateTextReply ? { privateTextReply: structuredClone(entry.privateTextReply) } : {}),
                    state: input.disposition,
                    failure,
                    ...(input.disposition === "retry-wait"
                        ? { nextRetryAtMs: input.nextRetryAtMs }
                        : {
                            terminalAtMs: input.failedAtMs,
                            terminalReason: input.terminalReason,
                            terminalFailureId: terminalFailureId,
                        }),
                };
                const published = publishMutation(current, current.file.entries.map((candidate) => candidate.updateId === input.updateId ? nextEntry : candidate), true);
                return {
                    entry: cloneEntry(nextEntry),
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        applyOperatorDisposition(input) {
            return runMutation((readCurrent) => {
                if (!isSafeNonNegativeInteger(input.updateId) ||
                    !isBoundedString(input.failureId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
                    (input.action !== "retry" && input.action !== "discard")) {
                    throw createJournalError("invalid", path, "received an invalid operator disposition");
                }
                const current = readCurrent();
                const existingDisposition = current.file.operatorDispositions?.find((candidate) => candidate.failureId === input.failureId);
                if (existingDisposition) {
                    if ("dispositionKind" in existingDisposition)
                        throw createJournalError("conflict", path, `terminal failure ${input.failureId} collides with legacy custody authority`);
                    if (existingDisposition.updateId !== input.updateId ||
                        existingDisposition.action !== input.action) {
                        throw createJournalError("conflict", path, `terminal failure ${input.failureId} already has another operator disposition`);
                    }
                    return {
                        disposition: { ...existingDisposition },
                        duplicate: true,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                const entry = current.file.entries.find((candidate) => candidate.updateId === input.updateId);
                if (entry?.state !== "failed" ||
                    !entry.failure ||
                    entry.terminalAtMs === undefined ||
                    !entry.terminalReason ||
                    entry.terminalFailureId !== input.failureId) {
                    throw createJournalError("conflict", path, `cannot apply a stale disposition to terminal failure ${input.failureId}`);
                }
                const nowMs = getNowMs();
                if (!isSafeNonNegativeInteger(nowMs)) {
                    throw createJournalError("invalid", path, "received an invalid operator disposition timestamp");
                }
                const disposition = {
                    failureId: entry.terminalFailureId,
                    updateId: entry.updateId,
                    action: input.action,
                    committedAtMs: Math.max(nowMs, entry.terminalAtMs),
                    attemptCount: entry.failure.attemptCount,
                    failureClass: entry.failure.failureClass,
                    terminalAtMs: entry.terminalAtMs,
                    terminalReason: entry.terminalReason,
                };
                const nextEntries = input.action === "retry"
                    ? current.file.entries.map((candidate) => candidate.updateId === entry.updateId
                        ? {
                            updateId: entry.updateId,
                            update: entry.update,
                            admittedAtMs: entry.admittedAtMs,
                            ...(entry.preApprovalExcluded !== undefined
                                ? { preApprovalExcluded: entry.preApprovalExcluded }
                                : {}),
                            ...(entry.privateTextReply ? { privateTextReply: structuredClone(entry.privateTextReply) } : {}),
                            state: "retry-wait",
                            failure: entry.failure,
                            nextRetryAtMs: disposition.committedAtMs,
                        }
                        : candidate)
                    : current.file.entries.filter((candidate) => candidate.updateId !== entry.updateId);
                const published = publishMutation(current, nextEntries, true, [
                    ...(current.file.operatorDispositions ?? []),
                    disposition,
                ]);
                return {
                    disposition: { ...disposition },
                    duplicate: false,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        discardRetryWait(input) {
            return runMutation((readCurrent) => {
                if (version !== TELEGRAM_UPDATE_JOURNAL_VERSION)
                    throw createJournalError("unsupported-version", path, "operator retry discard requires the legacy v1 source");
                const journalBindingKey = createTelegramUpdateJournalBindingKey({ path, profileName: profile, botIdentity: expectedIdentity });
                const operatorAuthorityId = input.operatorAuthorityId, isCurrent = input.isCurrent;
                if (input.journalBindingKey !== journalBindingKey ||
                    !isBoundedString(operatorAuthorityId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) || !operatorAuthorityId.trim() || typeof isCurrent !== "function")
                    throw createJournalError("conflict", path, "operator retry discard lacks exact source authority");
                const expected = validateJournalEntry(input.entry, path, version);
                if (expected.state !== "retry-wait" || !expected.failure || expected.inputClaim || expected.inputProvenance ||
                    expected.queueOwner || expected.queueHandoff || expected.queueReceiptId || expected.queueKind || expected.routingInput)
                    throw createJournalError("conflict", path, "operator retry discard requires an exact unclaimed failed input");
                const assertCurrent = () => {
                    if (!isCurrent())
                        throw createJournalError("conflict", path, "operator retry discard lost authority");
                };
                assertCurrent();
                // The existing terminal-discard audit is readable by v1 peers; do not invent a failed execution attempt.
                const failureId = `operator-discard-${createHash("sha256").update(JSON.stringify({ journalBindingKey, entry: expected, operatorAuthorityId })).digest("hex")}`;
                const current = sourceAccess ? readCurrent() : readCurrentStrict(false);
                const existing = current.file.operatorDispositions?.find(value => value.failureId === failureId);
                const entry = current.file.entries.find(value => value.updateId === expected.updateId);
                if (existing) {
                    if (entry || "dispositionKind" in existing || existing.updateId !== expected.updateId || existing.action !== "discard" ||
                        existing.attemptCount !== expected.failure.attemptCount || existing.failureClass !== expected.failure.failureClass ||
                        existing.terminalReason !== `operator-discard:${operatorAuthorityId}`)
                        throw createJournalError("conflict", path, "operator retry discard has conflicting retained evidence");
                    assertCurrent();
                    return { disposition: { ...existing }, duplicate: true, entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
                }
                if (!entry || !isDeepStrictEqual(entry, expected) || current.file.operatorDispositions?.some(value => value.updateId === expected.updateId))
                    throw createJournalError("conflict", path, "operator retry source changed before discard");
                const nowMs = getNowMs();
                if (!isSafeNonNegativeInteger(nowMs))
                    throw createJournalError("invalid", path, "invalid operator discard timestamp");
                const disposition = {
                    failureId, updateId: expected.updateId, action: "discard", committedAtMs: nowMs,
                    attemptCount: expected.failure.attemptCount, failureClass: expected.failure.failureClass,
                    terminalAtMs: nowMs, terminalReason: `operator-discard:${operatorAuthorityId}`,
                };
                assertCurrent();
                const published = publishMutation(current, current.file.entries.filter(value => value.updateId !== expected.updateId), true, [...(current.file.operatorDispositions ?? []), disposition], current.file.acceptedThroughUpdateId, (boundary, target) => { onPublicationBoundary?.(boundary, target); assertCurrent(); });
                return { disposition, duplicate: false, entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
            });
        },
        applyLegacyCustodyDisposition(authority) {
            return runMutation((readCurrent) => {
                const current = readCurrent();
                if (!journalHasCustodyFields(current.file.version))
                    throw createJournalError("conflict", path, "legacy custody disposition requires a custody journal");
                const existing = current.file.operatorDispositions?.find((candidate) => candidate.failureId === authority.dispositionId);
                if (existing) {
                    if (!("dispositionKind" in existing) ||
                        existing.dispositionKind !== "legacy-custody")
                        throw createJournalError("conflict", path, `legacy custody disposition ${authority.dispositionId} already has another authority`);
                    const normalizedDuplicate = normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(authority, {
                        updateId: existing.updateId,
                        state: "retry-wait",
                        attemptCount: 1,
                        failedAtMs: 0,
                        failureClass: "retained-audit",
                        summary: "retained-audit",
                        evidenceSha256: existing.evidenceSha256,
                    });
                    if (!normalizedDuplicate ||
                        existing.action !== normalizedDuplicate.action ||
                        existing.operatorAuthorityId !==
                            normalizedDuplicate.operatorAuthorityId ||
                        existing.authorizedAtMs !== normalizedDuplicate.authorizedAtMs)
                        throw createJournalError("conflict", path, `legacy custody disposition ${authority.dispositionId} already has another authority`);
                    let authorized = false;
                    try {
                        authorized =
                            options.authorizeLegacyCustodyDisposition?.(normalizedDuplicate) === true;
                    }
                    catch {
                        authorized = false;
                    }
                    if (!authorized)
                        throw createJournalError("conflict", path, "legacy custody disposition is unauthorized");
                    return {
                        disposition: { ...existing },
                        duplicate: true,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                const entry = current.file.entries.find((candidate) => candidate.updateId === authority.updateId);
                const evidence = entry && createTelegramUpdateJournalLegacyCustodyEvidence(entry);
                if (!evidence)
                    throw createJournalError("conflict", path, `cannot dispose non-quarantined update ${authority.updateId}`);
                const normalized = normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(authority, evidence);
                if (!normalized)
                    throw createJournalError("conflict", path, `legacy custody evidence changed for update ${authority.updateId}`);
                let authorized = false;
                try {
                    authorized =
                        options.authorizeLegacyCustodyDisposition?.(normalized) === true;
                }
                catch {
                    authorized = false;
                }
                if (!authorized)
                    throw createJournalError("conflict", path, "legacy custody disposition is unauthorized");
                const nowMs = getNowMs();
                if (!isSafeNonNegativeInteger(nowMs))
                    throw createJournalError("invalid", path, "received an invalid legacy custody disposition timestamp");
                const disposition = {
                    dispositionKind: "legacy-custody",
                    failureId: normalized.dispositionId,
                    updateId: normalized.updateId,
                    action: normalized.action,
                    committedAtMs: Math.max(nowMs, normalized.authorizedAtMs),
                    evidenceSha256: normalized.evidenceSha256,
                    operatorAuthorityId: normalized.operatorAuthorityId,
                    authorizedAtMs: normalized.authorizedAtMs,
                };
                const nextEntries = normalized.action === "discard"
                    ? current.file.entries.filter((candidate) => candidate.updateId !== entry.updateId)
                    : current.file.entries.map((candidate) => candidate.updateId === entry.updateId
                        ? {
                            updateId: entry.updateId,
                            update: entry.update,
                            admittedAtMs: entry.admittedAtMs,
                            ...(entry.preApprovalExcluded === undefined
                                ? {}
                                : { preApprovalExcluded: entry.preApprovalExcluded }),
                            ...(entry.privateTextReply ? { privateTextReply: structuredClone(entry.privateTextReply) } : {}),
                            state: "pending",
                        }
                        : candidate);
                const published = publishMutation(current, nextEntries, true, [
                    ...(current.file.operatorDispositions ?? []),
                    disposition,
                ]);
                return {
                    disposition: { ...disposition },
                    duplicate: false,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        offerQueuedHandoff(input) {
            return runMutation((readCurrent) => {
                const { expectedOwner, recipientOwner, requestedIds, handoffId } = validateQueueHandoffInput(input, "offer");
                if (isTelegramUpdateJournalQueueOwnerProcess(expectedOwner, recipientOwner)) {
                    throw createJournalError("conflict", path, `cannot hand queue receipt ${input.receiptId} to the same runtime process`);
                }
                const current = readCurrent();
                const receiptEntries = getExactQueuedReceiptEntries(current, input, requestedIds);
                if (receiptEntries.some((entry) => !entry.queueOwner ||
                    !areTelegramUpdateJournalQueueOwnersEqual(entry.queueOwner, expectedOwner))) {
                    throw createJournalError("conflict", path, `cannot offer stale queue receipt ${input.receiptId}`);
                }
                const existingHandoff = receiptEntries[0]?.queueHandoff;
                if (existingHandoff) {
                    if (existingHandoff.handoffId !== handoffId ||
                        !isDeepStrictEqual(existingHandoff.recipientOwner, recipientOwner)) {
                        throw createJournalError("conflict", path, `queue receipt ${input.receiptId} already has another handoff offer`);
                    }
                    return {
                        handoff: cloneJournalQueueHandoff(existingHandoff),
                        previousOwner: cloneJournalQueueOwner(expectedOwner),
                        offeredUpdateIds: [...requestedIds].sort((a, b) => a - b),
                        duplicate: true,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                const offeredAtMs = getNowMs();
                if (!isSafeNonNegativeInteger(offeredAtMs)) {
                    throw createJournalError("invalid", path, "received an invalid queue handoff offer timestamp");
                }
                const handoff = {
                    handoffId,
                    offeredAtMs,
                    recipientOwner,
                };
                const published = publishMutation(current, current.file.entries.map((entry) => requestedIds.has(entry.updateId)
                    ? { ...entry, queueHandoff: cloneJournalQueueHandoff(handoff) }
                    : entry), true);
                return {
                    handoff: cloneJournalQueueHandoff(handoff),
                    previousOwner: cloneJournalQueueOwner(expectedOwner),
                    offeredUpdateIds: [...requestedIds].sort((a, b) => a - b),
                    duplicate: false,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        acceptQueuedHandoff(input) {
            return runMutation((readCurrent) => {
                const { expectedOwner, recipientOwner, requestedIds, handoffId } = validateQueueHandoffInput(input, "accept");
                const current = readCurrent();
                const receiptEntries = getExactQueuedReceiptEntries(current, input, requestedIds);
                const existingOwner = receiptEntries[0]?.queueOwner;
                if (existingOwner &&
                    existingOwner.handoffId === handoffId &&
                    isTelegramUpdateJournalQueueOwnerProcess(existingOwner, recipientOwner)) {
                    if (receiptEntries.some((entry) => !entry.queueOwner ||
                        !areTelegramUpdateJournalQueueOwnersEqual(entry.queueOwner, existingOwner) ||
                        entry.queueHandoff !== undefined)) {
                        throw createJournalError("conflict", path, `queue receipt ${input.receiptId} has inconsistent accepted handoff authority`);
                    }
                    return {
                        handoffId,
                        queueOwner: cloneJournalQueueOwner(existingOwner),
                        acceptedUpdateIds: [...requestedIds].sort((a, b) => a - b),
                        duplicate: true,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                if (receiptEntries.some((entry) => !entry.queueOwner ||
                    !areTelegramUpdateJournalQueueOwnersEqual(entry.queueOwner, expectedOwner) ||
                    entry.queueHandoff?.handoffId !== handoffId ||
                    !isDeepStrictEqual(entry.queueHandoff.recipientOwner, recipientOwner))) {
                    throw createJournalError("conflict", path, `cannot accept stale or unauthenticated queue handoff ${input.receiptId}`);
                }
                const acquiredAtMs = getNowMs();
                if (!isSafeNonNegativeInteger(acquiredAtMs)) {
                    throw createJournalError("invalid", path, "received an invalid queue handoff acquisition timestamp");
                }
                const queueOwner = {
                    ...recipientOwner,
                    acquisitionId: randomUUID(),
                    acquiredAtMs,
                    handoffId,
                };
                const published = publishMutation(current, current.file.entries.map((entry) => requestedIds.has(entry.updateId)
                    ? {
                        updateId: entry.updateId,
                        update: entry.update,
                        admittedAtMs: entry.admittedAtMs,
                        ...(entry.preApprovalExcluded !== undefined
                            ? { preApprovalExcluded: entry.preApprovalExcluded }
                            : {}),
                        ...(entry.privateTextReply ? { privateTextReply: structuredClone(entry.privateTextReply) } : {}),
                        state: "queued",
                        queueKind: input.queueKind,
                        queueReceiptId: input.receiptId,
                        queueOwner: cloneJournalQueueOwner(queueOwner),
                        ...(entry.inputProvenance
                            ? {
                                inputProvenance: structuredClone(entry.inputProvenance),
                            }
                            : {}),
                    }
                    : entry), true);
                return {
                    handoffId,
                    previousOwner: cloneJournalQueueOwner(expectedOwner),
                    queueOwner: cloneJournalQueueOwner(queueOwner),
                    acceptedUpdateIds: [...requestedIds].sort((a, b) => a - b),
                    duplicate: false,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        cancelQueuedHandoff(input) {
            return runMutation((readCurrent) => {
                const { expectedOwner, recipientOwner, requestedIds, handoffId } = validateQueueHandoffInput(input, "cancel");
                const current = readCurrent();
                const receiptEntries = getExactQueuedReceiptEntries(current, input, requestedIds);
                if (receiptEntries.some((entry) => !entry.queueOwner ||
                    !areTelegramUpdateJournalQueueOwnersEqual(entry.queueOwner, expectedOwner))) {
                    throw createJournalError("conflict", path, `cannot cancel stale queue handoff ${input.receiptId}`);
                }
                const existingHandoff = receiptEntries[0]?.queueHandoff;
                if (!existingHandoff) {
                    throw createJournalError("conflict", path, `cannot cancel missing queue handoff offer ${input.receiptId}`);
                }
                if (existingHandoff.handoffId !== handoffId ||
                    !isDeepStrictEqual(existingHandoff.recipientOwner, recipientOwner)) {
                    throw createJournalError("conflict", path, `cannot cancel another queue handoff offer ${input.receiptId}`);
                }
                const published = publishMutation(current, current.file.entries.map((entry) => {
                    if (!requestedIds.has(entry.updateId))
                        return entry;
                    const { queueHandoff: _queueHandoff, ...retained } = entry;
                    return retained;
                }), true);
                return {
                    handoffId,
                    previousOwner: cloneJournalQueueOwner(expectedOwner),
                    cancelledUpdateIds: [...requestedIds].sort((a, b) => a - b),
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        completeQueued(receipts) {
            return completeQueued(receipts);
        },
        completeQueuedExact(receipts, completions) {
            return completeQueued(receipts, completions, true);
        },
        discardQueued(input) {
            return runMutation((readCurrent) => {
                if ((input.queueKind !== "prompt" && input.queueKind !== "control") ||
                    !isNonEmptyString(input.receiptId) ||
                    !Array.isArray(input.sourceUpdateIds) ||
                    input.sourceUpdateIds.length === 0) {
                    throw createJournalError("invalid", path, "received an invalid queue discard");
                }
                const expectedOwner = validateJournalQueueOwner(input.expectedOwner, path);
                if (queueRuntimeIdentity &&
                    (expectedOwner.instanceId !== queueRuntimeIdentity.instanceId ||
                        expectedOwner.processId !== queueRuntimeIdentity.processId ||
                        expectedOwner.processBirthId !==
                            queueRuntimeIdentity.processBirthId)) {
                    throw createJournalError("conflict", path, `cannot discard foreign queue receipt ${input.receiptId}`);
                }
                const requestedIds = new Set();
                for (const updateId of input.sourceUpdateIds) {
                    if (!isSafeNonNegativeInteger(updateId) ||
                        requestedIds.has(updateId)) {
                        throw createJournalError("invalid", path, "received invalid queue discard update ids");
                    }
                    requestedIds.add(updateId);
                }
                const current = readCurrent();
                const receiptEntries = current.file.entries.filter((entry) => entry.queueReceiptId === input.receiptId);
                if (receiptEntries.length !== requestedIds.size ||
                    receiptEntries.some((entry) => !isExactQueuedReceiptEntry(entry, requestedIds, input.queueKind, expectedOwner))) {
                    throw createJournalError("conflict", path, `cannot discard stale queue receipt ${input.receiptId}`);
                }
                const removedUpdateIds = [...requestedIds].sort((a, b) => a - b);
                const published = publishMutation(current, current.file.entries.filter((entry) => !requestedIds.has(entry.updateId)), true);
                return {
                    previousOwner: cloneJournalQueueOwner(expectedOwner),
                    removedUpdateIds,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        recoverDeadQueueOwner(input) {
            return runMutation((readCurrent) => {
                if (!getQueueProcessLiveness) {
                    throw createJournalError("conflict", path, "cannot recover queue authority without a process-liveness proof");
                }
                const deadOwner = validateJournalQueueOwner(input.deadOwner, path);
                let ownerLiveness;
                try {
                    ownerLiveness = getQueueProcessLiveness({
                        processId: deadOwner.processId,
                        processBirthId: deadOwner.processBirthId,
                    });
                }
                catch (error) {
                    throw createJournalError("io", path, "could not prove queued owner liveness", error);
                }
                const recoveryOwner = validateJournalQueueOwnerIdentity(input.recoveryOwner, path);
                if (queueRuntimeIdentity &&
                    (recoveryOwner.instanceId !== queueRuntimeIdentity.instanceId ||
                        recoveryOwner.processId !== queueRuntimeIdentity.processId ||
                        recoveryOwner.processBirthId !==
                            queueRuntimeIdentity.processBirthId)) {
                    throw createJournalError("conflict", path, `cannot recover queue receipt ${input.receiptId} for another runtime`);
                }
                const requestedIds = new Set();
                for (const updateId of input.sourceUpdateIds) {
                    if (!isSafeNonNegativeInteger(updateId) ||
                        requestedIds.has(updateId)) {
                        throw createJournalError("invalid", path, "received invalid queue recovery update ids");
                    }
                    requestedIds.add(updateId);
                }
                const current = readCurrent();
                const receiptEntries = current.file.entries.filter((entry) => entry.queueReceiptId === input.receiptId);
                if ((input.queueKind !== "prompt" && input.queueKind !== "control") ||
                    !isNonEmptyString(input.receiptId) ||
                    requestedIds.size === 0 ||
                    receiptEntries.length !== requestedIds.size ||
                    receiptEntries.some((entry) => !isExactQueuedReceiptEntry(entry, requestedIds, input.queueKind, deadOwner))) {
                    throw createJournalError("conflict", path, `cannot recover stale queue receipt ${input.receiptId}`);
                }
                if (ownerLiveness !== "dead") {
                    return {
                        status: ownerLiveness === "alive"
                            ? "owner-alive"
                            : "owner-unverifiable",
                        previousOwner: cloneJournalQueueOwner(deadOwner),
                        recoveredUpdateIds: [],
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                const recoveredUpdateIds = [...requestedIds].sort((a, b) => a - b);
                const published = publishMutation(current, current.file.entries.filter((entry) => !requestedIds.has(entry.updateId)), true);
                return {
                    status: "recovered",
                    previousOwner: cloneJournalQueueOwner(deadOwner),
                    recoveredUpdateIds,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        inspectAbandonedPending(updateId) {
            return runMutation((readCurrent) => {
                if (!isTelegramUpdateJournalLegacyFamilyVersion(version)) {
                    throw createJournalError("unsupported-version", path, "abandonment inspection requires the legacy v1 source");
                }
                if (!isSafeNonNegativeInteger(updateId))
                    throw createJournalError("invalid", path, "invalid abandonment update id");
                // Inspection never repairs or quarantines source evidence.
                const current = sourceAccess ? readCurrent() : readCurrentStrict(false);
                const matches = (current.file.operatorDispositions ?? []).filter((item) => item.updateId === updateId);
                const disposition = matches[0];
                if (matches.length !== 1 ||
                    !disposition ||
                    !("dispositionKind" in disposition) ||
                    disposition.dispositionKind !== "legacy-custody" ||
                    disposition.action !== "discard" ||
                    disposition.failureId !== `abandon-${disposition.evidenceSha256}` ||
                    current.file.entries.some((entry) => entry.updateId === updateId))
                    return undefined;
                const journalBindingKey = createTelegramUpdateJournalBindingKey({
                    path,
                    profileName: profile,
                    botIdentity: expectedIdentity,
                });
                const retainedPath = join(`${path}.retained`, `${disposition.failureId}.json`);
                let stat;
                try {
                    stat = lstatSync(retainedPath);
                }
                catch (error) {
                    if (error.code === "ENOENT")
                        throw createJournalError("conflict", retainedPath, "committed abandonment lost its retained input");
                    throw error;
                }
                if (!stat.isFile() ||
                    stat.isSymbolicLink() ||
                    stat.size > maxBytes + 4096) {
                    throw createJournalError("invalid", retainedPath, "retained input is not a bounded regular file");
                }
                const parsed = JSON.parse(readFileSync(retainedPath, "utf8"));
                if (!isRecord(parsed))
                    throw createJournalError("invalid", retainedPath, "retained input is not an evidence record");
                const entry = validateJournalEntry(parsed.entry, retainedPath, version);
                const reference = createPendingRetentionReference({
                    path,
                    journalBindingKey,
                    entry,
                    maxBytes,
                });
                const retained = reference.read();
                if (entry.updateId !== updateId ||
                    reference.retainedPath !== retainedPath ||
                    !isDeepStrictEqual(retained?.requestedDisposition, disposition)) {
                    throw createJournalError("conflict", retainedPath, "retained input does not match committed abandonment");
                }
                const originalTarget = projectCommittedAbandonmentTarget(entry, disposition.operatorAuthorityId);
                return {
                    journalBindingKey,
                    updateId,
                    retainedPath,
                    operatorAuthorityId: disposition.operatorAuthorityId,
                    ...(originalTarget ? { originalTarget } : {}),
                };
            });
        },
        inspectPendingRetention(entry) {
            return runMutation(() => {
                if (!isTelegramUpdateJournalLegacyFamilyVersion(version)) {
                    throw createJournalError("unsupported-version", path, "pending retention requires the legacy v1 source");
                }
                const expected = validateJournalEntry(entry, path, version);
                if (expected.state !== "pending")
                    throw createJournalError("conflict", path, "retention inspection requires a pending source");
                const journalBindingKey = createTelegramUpdateJournalBindingKey({
                    path,
                    profileName: profile,
                    botIdentity: expectedIdentity,
                });
                const reference = createPendingRetentionReference({
                    path,
                    journalBindingKey,
                    entry: expected,
                    maxBytes,
                });
                const retained = reference.read();
                return retained
                    ? {
                        journalBindingKey,
                        retainedPath: reference.retainedPath,
                        requestedDisposition: retained.requestedDisposition,
                    }
                    : undefined;
            });
        },
        abandonPending(input) {
            return runMutation((readCurrent) => {
                if (!isTelegramUpdateJournalLegacyFamilyVersion(version)) {
                    throw createJournalError("unsupported-version", path, "pending abandonment requires the legacy v1 source");
                }
                const journalBindingKey = createTelegramUpdateJournalBindingKey({
                    path,
                    profileName: profile,
                    botIdentity: expectedIdentity,
                });
                if (input.journalBindingKey !== journalBindingKey) {
                    throw createJournalError("identity-mismatch", path, "pending abandonment belongs to another source");
                }
                if (!isBoundedString(input.operatorAuthorityId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
                    !input.operatorAuthorityId.trim() ||
                    typeof input.isCurrent !== "function") {
                    throw createJournalError("invalid", path, "pending abandonment requires explicit operator authority");
                }
                const assertCurrent = () => {
                    if (!input.isCurrent())
                        throw createJournalError("conflict", path, "pending abandonment lost authority");
                };
                assertCurrent();
                const expected = validateJournalEntry(input.entry, path, version);
                if (expected.state !== "pending" ||
                    expected.inputClaim ||
                    expected.inputProvenance ||
                    expected.queueOwner ||
                    expected.queueHandoff ||
                    expected.queueReceiptId ||
                    expected.failure) {
                    throw createJournalError("conflict", path, "only an exact unclaimed pending source may be abandoned");
                }
                // Never repair/quarantine source evidence while deciding an operator cancellation.
                const readStrict = sourceAccess
                    ? readCurrent
                    : () => readCurrentStrict(false);
                const current = readStrict();
                const { evidenceSha256, failureId, retainedPath, read: readRetention, } = createPendingRetentionReference({
                    path,
                    journalBindingKey,
                    entry: expected,
                    maxBytes,
                });
                const existing = current.file.operatorDispositions?.find((item) => item.failureId === failureId || item.updateId === expected.updateId);
                const currentEntry = current.file.entries.find((entry) => entry.updateId === expected.updateId);
                const assertRetention = (retained, disposition) => {
                    if (!retained ||
                        !isDeepStrictEqual(retained.requestedDisposition, disposition)) {
                        throw createJournalError("conflict", retainedPath, "retained input does not match abandonment evidence");
                    }
                };
                if (existing) {
                    if (currentEntry ||
                        !("dispositionKind" in existing) ||
                        existing.dispositionKind !== "legacy-custody" ||
                        existing.failureId !== failureId ||
                        existing.action !== "discard" ||
                        existing.evidenceSha256 !== evidenceSha256) {
                        throw createJournalError("conflict", path, "pending source already has another disposition");
                    }
                    assertRetention(readRetention(), existing);
                    assertCurrent();
                    return {
                        disposition: existing,
                        retainedPath,
                        duplicate: true,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                if (!currentEntry || !isDeepStrictEqual(currentEntry, expected)) {
                    throw createJournalError("conflict", path, "pending source changed before abandonment");
                }
                const nowMs = getNowMs();
                if (!isSafeNonNegativeInteger(nowMs))
                    throw createJournalError("invalid", path, "invalid abandonment timestamp");
                const retained = readRetention();
                let disposition;
                if (retained) {
                    disposition = retained.requestedDisposition;
                }
                else {
                    // Reuse the existing legacy discard tombstone so older v1 readers also refuse replay.
                    // This is an operator disposition, not a fabricated execution failure or completion.
                    disposition = {
                        dispositionKind: "legacy-custody",
                        failureId,
                        updateId: expected.updateId,
                        action: "discard",
                        committedAtMs: nowMs,
                        evidenceSha256,
                        operatorAuthorityId: input.operatorAuthorityId,
                        authorizedAtMs: nowMs,
                    };
                    const copy = {
                        version: 1,
                        kind: "pending-input-retention",
                        journalBindingKey,
                        entry: expected,
                        requestedDisposition: disposition,
                    };
                    writeJournalFile(retainedPath, `${JSON.stringify(copy)}\n`, (boundary, target) => {
                        onPublicationBoundary?.(boundary, target);
                        assertCurrent();
                    });
                }
                assertCurrent();
                assertRetention(readRetention(), disposition);
                const committed = (snapshot) => !snapshot.file.entries.some((entry) => entry.updateId === expected.updateId) &&
                    snapshot.file.operatorDispositions?.some((item) => isDeepStrictEqual(item, disposition));
                try {
                    const published = publishMutation(current, current.file.entries.filter((entry) => entry.updateId !== expected.updateId), true, [...(current.file.operatorDispositions ?? []), disposition], current.file.acceptedThroughUpdateId, (boundary, target) => {
                        onPublicationBoundary?.(boundary, target);
                        assertCurrent();
                    });
                    return {
                        disposition,
                        retainedPath,
                        duplicate: false,
                        entryCount: published.file.entries.length,
                        serializedBytes: published.serializedBytes,
                    };
                }
                catch (error) {
                    // A segment may be durable even if later snapshot compaction failed.
                    // Only exact read-back can turn that unknown acknowledgement into success.
                    let observed;
                    try {
                        observed = readStrict();
                    }
                    catch {
                        throw error;
                    }
                    if (!committed(observed))
                        throw error;
                    assertRetention(readRetention(), disposition);
                    return {
                        disposition,
                        retainedPath,
                        duplicate: false,
                        entryCount: observed.file.entries.length,
                        serializedBytes: observed.serializedBytes,
                    };
                }
            });
        },
        removeCompleted(updateIds) {
            return removeCompleted(updateIds);
        },
        removeCompletedExact(updateIds, expectedSources, completions, isCurrent) {
            return removeCompleted(updateIds, expectedSources, true, completions, isCurrent);
        },
        inspectQueuedReceipt(expected) {
            return runMutationCore((readCurrent) => {
                if (!sourceAccess ||
                    !isTelegramUpdateJournalLegacyFamilyVersion(version)) {
                    throw createJournalError("invalid", path, "queue receipt observation requires an exact legacy v1 source handle");
                }
                const queueOwner = validateQueuedReceiptObservation(expected, path);
                const current = readCurrent();
                return inspectJournalQueuedReceipt(current.file, { ...expected, queueOwner }, path);
            });
        },
        inspectSourceCompletion(expected) {
            return runMutation((readCurrent) => {
                if (!sourceAccess)
                    throw createJournalError("invalid", path, "source completion requires an exact source handle");
                const completion = validateJournalSourceCompletion(expected, path);
                const current = readCurrent();
                return inspectJournalSourceCompletion(current.file, completion, path);
            });
        },
    };
    if (isTelegramUpdateJournalLegacyFamilyVersion(version))
        journal.routingInputs = {
            arm(input) {
                if (input.chooser !== undefined &&
                    !isTelegramUpdateJournalRoutingChooser(input.chooser))
                    throw createJournalError("invalid", path, "invalid routing input chooser location");
                return mutateRoutingInputs(input, false, input.publishedAtMs, input.chooser).entries;
            },
            select(input) {
                return mutateRoutingInputs(input, true);
            },
            inspectExpiry(updateId) {
                return runMutation((readCurrent) => {
                    if (!isSafeNonNegativeInteger(updateId))
                        throw createJournalError("invalid", path, "invalid routing expiry update ID");
                    return inspectRoutingInputExpiry(readCurrent().file, createTelegramUpdateJournalBindingKey({
                        path,
                        profileName: profile,
                        botIdentity: expectedIdentity,
                    }), updateId);
                });
            },
            inspectGroupExpiry(updateIds) {
                return runMutation((readCurrent) => inspectRoutingGroupExpiry(readCurrent().file, createTelegramUpdateJournalBindingKey({
                    path,
                    profileName: profile,
                    botIdentity: expectedIdentity,
                }), updateIds));
            },
            expire(input) {
                return runMutation((readCurrent) => {
                    const original = validateJournalEntry(input.entry, path, version), lifetime = original.routingInput;
                    const binding = createTelegramUpdateJournalBindingKey({
                        path,
                        profileName: profile,
                        botIdentity: expectedIdentity,
                    });
                    if (!lifetime ||
                        original.state !== "pending" ||
                        original.inputClaim ||
                        original.inputProvenance ||
                        original.queueOwner ||
                        original.queueReceiptId ||
                        original.queueHandoff ||
                        original.failure ||
                        input.journalBindingKey !== binding ||
                        lifetime.operatorUserId !== input.operatorUserId ||
                        !isSafePositiveInteger(input.operatorUserId) ||
                        typeof input.isCurrent !== "function") {
                        throw createJournalError("conflict", path, "routing expiry requires an exact unclaimed chooser source");
                    }
                    const assertCurrent = () => {
                        const now = getNowMs();
                        if (!isSafeNonNegativeInteger(now) ||
                            now < lifetime.expiresAtMs ||
                            !input.isCurrent())
                            throw createJournalError("conflict", path, "routing source has not expired under current authority");
                    };
                    assertCurrent();
                    const current = sourceAccess
                        ? readCurrent()
                        : readCurrentStrict(false);
                    const evidenceSha256 = createHash("sha256")
                        .update(JSON.stringify(original))
                        .digest("hex");
                    const failureId = `routing-expiry:${evidenceSha256}`;
                    const existing = current.file.operatorDispositions?.find((value) => value.updateId === original.updateId);
                    const entry = current.file.entries.find((value) => value.updateId === original.updateId);
                    if (existing) {
                        if (entry ||
                            !("dispositionKind" in existing) ||
                            existing.dispositionKind !== "legacy-custody" ||
                            existing.action !== "discard" ||
                            existing.failureId !== failureId ||
                            existing.evidenceSha256 !== evidenceSha256 ||
                            existing.operatorAuthorityId !==
                                `telegram-owner:${input.operatorUserId}`)
                            throw createJournalError("conflict", path, "routing source has contradictory expiry evidence");
                        assertCurrent();
                        return {
                            disposition: existing,
                            duplicate: true,
                            entryCount: current.file.entries.length,
                            serializedBytes: current.serializedBytes,
                        };
                    }
                    if (!entry || !isDeepStrictEqual(entry, original))
                        throw createJournalError("conflict", path, "routing source changed before expiry");
                    // A discard tombstone prevents old readers and delayed reports from replaying; no prompt-body archive is written.
                    const now = getNowMs();
                    const disposition = {
                        dispositionKind: "legacy-custody",
                        failureId,
                        updateId: original.updateId,
                        action: "discard",
                        committedAtMs: now,
                        authorizedAtMs: now,
                        evidenceSha256,
                        operatorAuthorityId: `telegram-owner:${input.operatorUserId}`,
                    };
                    const published = publishMutation(current, current.file.entries.filter((value) => value.updateId !== original.updateId), true, [...(current.file.operatorDispositions ?? []), disposition], current.file.acceptedThroughUpdateId, (boundary, target) => {
                        onPublicationBoundary?.(boundary, target);
                        assertCurrent();
                    });
                    assertCurrent();
                    return {
                        disposition,
                        duplicate: false,
                        entryCount: published.file.entries.length,
                        serializedBytes: published.serializedBytes,
                    };
                });
            },
        };
    if (!getInputContext)
        return { journal };
    // Strict source acquisition already requires this exact stored receipt scope.
    const bindingKey = createTelegramUpdateJournalBindingKey({
        path,
        profileName: profile,
        botIdentity: expectedIdentity,
    });
    const createInputSourceReference = (updateId) => ({
        journalBindingKey: bindingKey,
        tokenSha256: expectedIdentity.tokenSha256,
        updateId,
    });
    const createInputReceipt = (updateId, owner) => ({
        ...createInputSourceReference(updateId),
        owner: cloneJournalQueueOwner(owner),
    });
    const assertInputProcess = (identity) => {
        if (!queueRuntimeIdentity ||
            identity.instanceId !== queueRuntimeIdentity.instanceId ||
            identity.processId !== queueRuntimeIdentity.processId ||
            identity.processBirthId !== queueRuntimeIdentity.processBirthId) {
            throw createJournalError("conflict", path, "input custody belongs to another runtime");
        }
    };
    const inputOwnerMatchesIdentity = (owner, identity) => isTelegramUpdateJournalQueueOwnerProcess(owner, identity) &&
        owner.sessionGeneration === identity.sessionGeneration;
    const currentInputContext = () => {
        const observed = getInputContext();
        if (observed === undefined)
            throw createJournalError("conflict", path, "input execution context is unavailable");
        const owner = validateJournalQueueOwnerIdentity(observed.owner, path);
        const recipientBindingKey = observed.recipientBindingKey;
        if (!isBoundedString(recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
            !recipientBindingKey.trim()) {
            throw createJournalError("invalid", path, "input execution binding is invalid");
        }
        assertInputProcess(owner);
        return { owner, recipientBindingKey };
    };
    const runInputAdmission = (kind, operation) => workspaceAdmission
        ? runWithTelegramWorkspaceAdmissions({
            ledger: workspaceAdmission,
            operationId: `input:${randomUUID()}`,
            operationKind: `journal.input.${kind}`,
            scopes: [{ kind: "profile" }],
            operation,
        })
        : operation();
    const runInputMutation = (kind, operation) => runInputAdmission(kind, () => runMutation(operation));
    const publishInputMutation = (current, entries, updateId, context, assertAuthority) => {
        assertAuthority?.();
        const published = publishMutation(current, entries, true, current.file.operatorDispositions, current.file.acceptedThroughUpdateId, (boundary, publicationPath) => {
            onPublicationBoundary?.(boundary, publicationPath);
            if (!isDeepStrictEqual(currentInputContext(), context)) {
                throw createJournalError("conflict", path, "input execution context changed before publication");
            }
            assertAuthority?.();
            if (assertAuthority && !isDeepStrictEqual(currentInputContext(), context))
                throw createJournalError("conflict", path, "input execution context changed during authority assertion");
        }, updateId);
        if (assertAuthority) {
            if (!isDeepStrictEqual(currentInputContext(), context))
                throw createJournalError("conflict", path, "input execution context changed after publication");
            assertAuthority();
            if (!isDeepStrictEqual(currentInputContext(), context))
                throw createJournalError("conflict", path, "input execution context changed during post-publication assertion");
        }
        return published;
    };
    const publishInputSettlement = (current, entries, contentChanged) => publishMutation(current, entries, contentChanged, current.file.operatorDispositions, current.file.acceptedThroughUpdateId, onPublicationBoundary, false);
    const normalizeInputSourceReference = (value, operation) => {
        if (!isRecord(value) ||
            !hasOnlyKeys(value, ["journalBindingKey", "tokenSha256", "updateId"])) {
            throw createJournalError("invalid", path, `received invalid input handoff ${operation} source`);
        }
        const journalBindingKey = value.journalBindingKey;
        const updateId = value.updateId;
        if (journalBindingKey !== bindingKey ||
            value.tokenSha256 !== expectedIdentity.tokenSha256 ||
            !isSafeNonNegativeInteger(updateId)) {
            throw createJournalError("conflict", path, "input receipt does not match its source identity");
        }
        return {
            journalBindingKey,
            tokenSha256: expectedIdentity.tokenSha256,
            updateId,
        };
    };
    const normalizeInputReceipt = (value, requireCurrentProcess = true) => {
        if (!isRecord(value) ||
            !hasOnlyKeys(value, [
                "journalBindingKey",
                "tokenSha256",
                "updateId",
                "owner",
            ])) {
            throw createJournalError("invalid", path, "received an invalid input receipt");
        }
        const source = normalizeInputSourceReference({
            journalBindingKey: value.journalBindingKey,
            tokenSha256: value.tokenSha256,
            updateId: value.updateId,
        }, "receipt");
        const owner = validateJournalQueueOwner(value.owner, path);
        if (requireCurrentProcess)
            assertInputProcess(owner);
        return { ...source, owner };
    };
    const normalizeInputHandoffOffer = (value) => {
        if (!isRecord(value) ||
            !hasOnlyKeys(value, ["receipt", "recipientOwner", "handoffToken"]) ||
            !isBoundedString(value.handoffToken, TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MAX_LENGTH) ||
            value.handoffToken.length <
                TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MIN_LENGTH) {
            throw createJournalError("invalid", path, "received invalid input handoff offer");
        }
        const receipt = normalizeInputReceipt(value.receipt);
        const recipientOwner = validateJournalQueueOwnerIdentity(value.recipientOwner, path);
        if (isTelegramUpdateJournalQueueOwnerProcess(receipt.owner, recipientOwner)) {
            throw createJournalError("conflict", path, "cannot transfer input custody to the same runtime process");
        }
        return { receipt, recipientOwner, handoffToken: value.handoffToken };
    };
    const normalizeInputHandoffId = (value, operation) => {
        if (!isTelegramInputHandoffId(value)) {
            throw createJournalError("invalid", path, `received invalid input handoff ${operation}`);
        }
        return value;
    };
    const normalizeInputHandoffAccept = (value) => {
        if (!isRecord(value) ||
            !hasOnlyKeys(value, ["source", "recipientOwner", "handoffId"])) {
            throw createJournalError("invalid", path, "received invalid input handoff accept");
        }
        const source = normalizeInputSourceReference(value.source, "accept");
        const recipientOwner = validateJournalQueueOwnerIdentity(value.recipientOwner, path);
        assertInputProcess(recipientOwner);
        return {
            source,
            recipientOwner,
            handoffId: normalizeInputHandoffId(value.handoffId, "accept"),
        };
    };
    const normalizeInputHandoffCancel = (value) => {
        if (!isRecord(value) ||
            !hasOnlyKeys(value, ["receipt", "recipientOwner", "handoffId"])) {
            throw createJournalError("invalid", path, "received invalid input handoff cancel");
        }
        return {
            receipt: normalizeInputReceipt(value.receipt),
            recipientOwner: validateJournalQueueOwnerIdentity(value.recipientOwner, path),
            handoffId: normalizeInputHandoffId(value.handoffId, "cancel"),
        };
    };
    const normalizeInputQueue = (value) => {
        if (!isRecord(value) ||
            !hasOnlyKeys(value, ["queueKind", "receiptId", "receipts"]) ||
            (value.queueKind !== "prompt" && value.queueKind !== "control") ||
            !isBoundedString(value.receiptId, TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH) ||
            !value.receiptId.trim() ||
            !Array.isArray(value.receipts) ||
            value.receipts.length === 0) {
            throw createJournalError("invalid", path, "received invalid input queue transition");
        }
        const receipts = value.receipts
            .map((receipt) => normalizeInputReceipt(receipt))
            .sort((left, right) => left.updateId - right.updateId);
        if (receipts.some((receipt, index) => index > 0 && receipt.updateId === receipts[index - 1].updateId)) {
            throw createJournalError("invalid", path, "received duplicate input queue transition receipts");
        }
        return { queueKind: value.queueKind, receiptId: value.receiptId, receipts };
    };
    const ownedInput = (current, receipt) => {
        const entry = current.file.entries.find((candidate) => candidate.updateId === receipt.updateId);
        if (!entry?.inputClaim ||
            entry.state !== "pending" ||
            !areTelegramUpdateJournalQueueOwnersEqual(entry.inputClaim.owner, receipt.owner)) {
            throw createJournalError("conflict", path, "input receipt lost its exact acquisition or phase");
        }
        return entry;
    };
    // Handoff offer/cancel require an idle ready donor claim owned by this exact context and binding.
    const readReadyDonorInput = (current, receipt) => {
        const context = currentInputContext();
        const entry = ownedInput(current, receipt);
        const claim = entry.inputClaim;
        if (claim.phase !== "ready" ||
            !inputOwnerMatchesIdentity(receipt.owner, context.owner) ||
            claim.recipientBindingKey !== context.recipientBindingKey) {
            throw createJournalError("conflict", path, "input handoff donor authority is stale or running");
        }
        return { context, current, entry, claim };
    };
    const getReadyInputRelease = (current, receipt, allowOffered = false) => {
        const entry = current.file.entries.find((candidate) => candidate.updateId === receipt.updateId);
        if (!entry ||
            entry.state !== "pending" ||
            entry.preApprovalExcluded !== false) {
            throw createJournalError("conflict", path, "input is unavailable for ready-claim release");
        }
        if (!entry.inputClaim)
            return { entry, unclaimed: true };
        if (!areTelegramUpdateJournalQueueOwnersEqual(entry.inputClaim.owner, receipt.owner) ||
            entry.inputClaim.phase !== "ready" ||
            (!allowOffered && entry.inputClaim.handoff !== undefined)) {
            throw createJournalError("conflict", path, "cannot release stale, running, or offered input authority");
        }
        return { entry, unclaimed: false };
    };
    const publishReadyInputRelease = (current, entry) => {
        const released = cloneEntry(entry);
        delete released.inputClaim;
        return publishMutation(current, current.file.entries.map((candidate) => candidate.updateId === entry.updateId ? released : candidate), true, current.file.operatorDispositions, current.file.acceptedThroughUpdateId, onPublicationBoundary, entry.updateId);
    };
    const input = {
        pinPrivateTextReplyDestination(value) {
            if (version !== TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION)
                throw createJournalError("unsupported-version", path, "requires explicit private Text Input storage v4");
            if (!privateReplyRecord(value, ["receipt", "expectedSource", "destination", "assertAuthority"]) ||
                typeof value.assertAuthority !== "function" ||
                !privateReplyRecord(value.receipt, ["journalBindingKey", "tokenSha256", "updateId", "owner"]) ||
                !privateReplyRecord(value.receipt.owner, ["instanceId", "processId", "processBirthId", "sessionGeneration",
                    "acquisitionId", "acquiredAtMs"], ["handoffId"]))
                throw createJournalError("invalid", path, "requires a synchronous private Text Input authority assertion and exact receipt");
            const callerGuard = value.assertAuthority;
            const receipt = normalizeInputReceipt(value.receipt);
            const evidence = validatePrivateTextReply({
                source: createInputSourceReference(receipt.updateId),
                expectedSource: value.expectedSource,
                destination: value.destination,
            }, path, receipt.updateId);
            if (evidence.destination.profile !== profile ||
                evidence.destination.botIdentity.tokenSha256 !== expectedIdentity.tokenSha256 ||
                (expectedIdentity.botId !== undefined && evidence.destination.botIdentity.botId !== expectedIdentity.botId) ||
                evidence.destination.receiver.instanceId === queueRuntimeIdentity.instanceId)
                throw createJournalError("conflict", path, "private Text Input destination identity does not match its foreign source scope");
            const assertAuthority = () => {
                if (callerGuard() !== undefined)
                    throw createJournalError("invalid", path, "private Text Input authority assertion must be synchronous and return void");
            };
            return runInputMutation("pin-private-text-reply", read => {
                assertAuthority();
                const context = currentInputContext();
                const current = read();
                const ready = readReadyDonorInput(current, receipt);
                if (!isDeepStrictEqual(context, ready.context) || ready.claim.handoff ||
                    ready.entry.preApprovalExcluded !== false || ready.entry.state !== "pending" ||
                    (current.file.botIdentity.botId !== undefined &&
                        current.file.botIdentity.botId !== evidence.destination.botIdentity.botId))
                    throw createJournalError("conflict", path, "private Text Input pin lost ready source authority");
                assertAuthority();
                if (ready.entry.privateTextReply) {
                    const beforePin = cloneEntry(ready.entry);
                    delete beforePin.privateTextReply;
                    if (!isDeepStrictEqual(ready.entry.privateTextReply, evidence) ||
                        !isDeepStrictEqual(createTelegramUpdateJournalEntryDigest(beforePin), evidence.expectedSource))
                        throw createJournalError("conflict", path, "private Text Input destination or original ready authority changed");
                    if (!isDeepStrictEqual(currentInputContext(), context))
                        throw createJournalError("conflict", path, "private Text Input pin context changed");
                    assertAuthority();
                    if (!isDeepStrictEqual(currentInputContext(), context))
                        throw createJournalError("conflict", path, "private Text Input pin context changed during authority assertion");
                    return { pinned: false };
                }
                if (!isDeepStrictEqual(createTelegramUpdateJournalEntryDigest(ready.entry), evidence.expectedSource))
                    throw createJournalError("conflict", path, "private Text Input source digest changed before pin");
                publishInputMutation(current, current.file.entries.map(entry => entry.updateId === receipt.updateId
                    ? { ...entry, privateTextReply: evidence } : entry), receipt.updateId, context, assertAuthority);
                return { pinned: true };
            });
        },
        read: journal.read,
        appendBatch: journal.appendBatch,
        listLegacyCustodyCandidates() {
            const sourceAccess = options.sourceAccess;
            const evidence = readTelegramUpdateJournalSource({
                directory: sourceAccess.directory,
                path,
                profile,
                botIdentity: expectedIdentity,
                limits: sourceAccess.limits,
                version,
            });
            return evidence.kind === "present"
                ? listTelegramUpdateJournalLegacyCustodyCandidates(evidence.file)
                : [];
        },
        applyLegacyCustodyDisposition(value) {
            return runInputAdmission("legacy-custody-disposition", () => journal.applyLegacyCustodyDisposition(value));
        },
        completeQueued(receipts) {
            return runInputAdmission("complete-queued", () => journal.completeQueued(receipts));
        },
        discardQueued(value) {
            return runInputAdmission("discard-queued", () => journal.discardQueued(value));
        },
        recoverDeadQueueOwner(value) {
            return runInputAdmission("recover-queued", () => journal.recoverDeadQueueOwner(value));
        },
        offerQueuedHandoff(value) {
            return runInputAdmission("offer-queued-handoff", () => journal.offerQueuedHandoff(value));
        },
        acceptQueuedHandoff(value) {
            return runInputAdmission("accept-queued-handoff", () => journal.acceptQueuedHandoff(value));
        },
        cancelQueuedHandoff(value) {
            return runInputAdmission("cancel-queued-handoff", () => journal.cancelQueuedHandoff(value));
        },
        removeExcluded(updateIds) {
            const requestedIds = new Set();
            for (const updateId of updateIds) {
                if (!isSafeNonNegativeInteger(updateId)) {
                    throw createJournalError("invalid", path, "received an invalid exclusion removal update id");
                }
                requestedIds.add(updateId);
            }
            return runInputMutation("remove-excluded", (read) => {
                const current = read();
                if (!current.exists ||
                    [...requestedIds].some((id) => id > (current.file.acceptedThroughUpdateId ?? -1))) {
                    throw createJournalError("conflict", path, "exclusion removal lacks retained source admission evidence");
                }
                const selected = current.file.entries.filter((entry) => requestedIds.has(entry.updateId));
                if (selected.some((entry) => entry.preApprovalExcluded !== true)) {
                    throw createJournalError("conflict", path, "cannot remove input without immutable exclusion evidence");
                }
                // Strict v3 decoding already excludes raw claims and queued authority on vetoed entries.
                const removedUpdateIds = selected.map((entry) => entry.updateId);
                const published = publishInputSettlement(current, current.file.entries.filter((entry) => !requestedIds.has(entry.updateId)), removedUpdateIds.length > 0);
                return {
                    removedUpdateIds,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        releaseInput(value) {
            const receipt = normalizeInputReceipt(value);
            return runInputMutation("release", (read) => {
                const current = read();
                const release = getReadyInputRelease(current, receipt);
                if (release.unclaimed)
                    return {
                        released: false,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                const published = publishReadyInputRelease(current, release.entry);
                return {
                    released: true,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        recoverReadyInput(value) {
            if (!isRecord(value) ||
                !hasOnlyKeys(value, ["receipt", "recoveryOwner"])) {
                throw createJournalError("invalid", path, "received invalid ready-input recovery authority");
            }
            const receipt = normalizeInputReceipt(value.receipt, false);
            const recoveryOwner = validateJournalQueueOwnerIdentity(value.recoveryOwner, path);
            assertInputProcess(recoveryOwner);
            return runInputMutation("recover-ready", (read) => {
                const current = read();
                const release = getReadyInputRelease(current, receipt, true);
                if (release.unclaimed)
                    return {
                        status: "unclaimed",
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                let liveness;
                try {
                    liveness = getQueueProcessLiveness({
                        processId: receipt.owner.processId,
                        processBirthId: receipt.owner.processBirthId,
                    });
                }
                catch (error) {
                    throw createJournalError("io", path, "could not prove ready input owner liveness", error);
                }
                if (liveness !== "dead")
                    return {
                        status: liveness === "alive"
                            ? "owner-alive"
                            : "owner-unverifiable",
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                const published = publishReadyInputRelease(current, release.entry);
                return {
                    status: "recovered",
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        offerInputHandoff(value) {
            const { receipt, recipientOwner, handoffToken } = normalizeInputHandoffOffer(value);
            return runInputMutation("offer", (read) => {
                const { context, current, claim } = readReadyDonorInput(read(), receipt);
                if (claim.handoff) {
                    if (!isDeepStrictEqual(claim.handoff.recipientOwner, recipientOwner)) {
                        throw createJournalError("conflict", path, "input already has another handoff offer");
                    }
                    return {
                        source: createInputSourceReference(receipt.updateId),
                        handoff: cloneJournalQueueHandoff(claim.handoff),
                        previousOwner: cloneJournalQueueOwner(receipt.owner),
                        duplicate: true,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                const handoffId = createTelegramInputHandoffId({
                    handoffToken,
                    journalBindingKey: bindingKey,
                    updateId: receipt.updateId,
                    donorOwner: receipt.owner,
                    recipientOwner,
                    recipientBindingKey: claim.recipientBindingKey,
                });
                const offeredAtMs = getNowMs();
                if (!isSafeNonNegativeInteger(offeredAtMs)) {
                    throw createJournalError("invalid", path, "received an invalid input handoff offer timestamp");
                }
                const handoff = {
                    handoffId,
                    offeredAtMs,
                    recipientOwner: { ...recipientOwner },
                };
                const offeredClaim = { ...claim, handoff };
                const published = publishInputMutation(current, current.file.entries.map((candidate) => candidate.updateId === receipt.updateId
                    ? { ...candidate, inputClaim: offeredClaim }
                    : candidate), receipt.updateId, context);
                return {
                    source: createInputSourceReference(receipt.updateId),
                    handoff: cloneJournalQueueHandoff(handoff),
                    previousOwner: cloneJournalQueueOwner(receipt.owner),
                    duplicate: false,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        acceptInputHandoff(value) {
            const { source, recipientOwner, handoffId } = normalizeInputHandoffAccept(value);
            return runInputMutation("accept", (read) => {
                const context = currentInputContext();
                const current = read();
                const entry = current.file.entries.find((candidate) => candidate.updateId === source.updateId);
                const claim = entry?.inputClaim;
                const acceptance = inputAdmission?.();
                if (acceptance && (acceptance.phase !== "accept" || acceptance.updateId !== source.updateId || !entry ||
                    !isDeepStrictEqual(createTelegramUpdateJournalEntryDigest(entry), acceptance.expectedSource)))
                    throw createJournalError("conflict", path, "private input acceptance source changed under serialization");
                const assertAcceptance = acceptance ? () => {
                    const observed = inputAdmission();
                    if (!isDeepStrictEqual(observed, acceptance))
                        throw createJournalError("conflict", path, "private input acceptance authority changed");
                } : undefined;
                if (!entry ||
                    entry.state !== "pending" ||
                    entry.preApprovalExcluded !== false ||
                    !claim ||
                    !isDeepStrictEqual(context.owner, recipientOwner) ||
                    context.recipientBindingKey !== claim.recipientBindingKey) {
                    throw createJournalError("conflict", path, "input handoff recipient authority is unavailable or changed");
                }
                if (claim.owner.handoffId === handoffId &&
                    inputOwnerMatchesIdentity(claim.owner, recipientOwner)) {
                    return {
                        handoffId,
                        receipt: createInputReceipt(source.updateId, claim.owner),
                        duplicate: true,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                if (claim.phase !== "ready" ||
                    claim.handoff?.handoffId !== handoffId ||
                    !isDeepStrictEqual(claim.handoff.recipientOwner, recipientOwner)) {
                    throw createJournalError("conflict", path, "cannot accept stale or unauthenticated input handoff");
                }
                const acquiredAtMs = getNowMs();
                if (!isSafeNonNegativeInteger(acquiredAtMs)) {
                    throw createJournalError("invalid", path, "received an invalid input handoff acquisition timestamp");
                }
                const previousOwner = cloneJournalQueueOwner(claim.owner);
                const owner = {
                    ...recipientOwner,
                    acquisitionId: randomUUID(),
                    acquiredAtMs,
                    handoffId,
                };
                const acceptedClaim = structuredClone(claim);
                acceptedClaim.owner = owner;
                delete acceptedClaim.handoff;
                const publishedEntries = current.file.entries.map((candidate) => candidate.updateId === source.updateId
                    ? { ...candidate, inputClaim: acceptedClaim }
                    : candidate);
                const published = publishInputMutation(current, publishedEntries, source.updateId, context, assertAcceptance);
                return {
                    handoffId,
                    previousOwner,
                    receipt: createInputReceipt(source.updateId, owner),
                    duplicate: false,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        cancelInputHandoff(value) {
            const { receipt, recipientOwner, handoffId } = normalizeInputHandoffCancel(value);
            return runInputMutation("cancel", (read) => {
                const { context, current, claim } = readReadyDonorInput(read(), receipt);
                if (!claim.handoff)
                    return {
                        handoffId,
                        previousOwner: cloneJournalQueueOwner(receipt.owner),
                        cancelled: false,
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                if (claim.handoff.handoffId !== handoffId ||
                    !isDeepStrictEqual(claim.handoff.recipientOwner, recipientOwner)) {
                    throw createJournalError("conflict", path, "cannot cancel another input handoff offer");
                }
                const cancelledClaim = structuredClone(claim);
                delete cancelledClaim.handoff;
                const publishedEntries = current.file.entries.map((candidate) => candidate.updateId === receipt.updateId
                    ? { ...candidate, inputClaim: cancelledClaim }
                    : candidate);
                const published = publishInputMutation(current, publishedEntries, receipt.updateId, context);
                return {
                    handoffId,
                    previousOwner: cloneJournalQueueOwner(receipt.owner),
                    cancelled: true,
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        queueInputs(value) {
            const { queueKind, receiptId, receipts } = normalizeInputQueue(value);
            return runInputMutation("queue", (read) => {
                const context = currentInputContext();
                if (receipts.some((receipt) => !inputOwnerMatchesIdentity(receipt.owner, context.owner))) {
                    throw createJournalError("conflict", path, "input queue transition belongs to another session");
                }
                const current = read();
                if (ordinaryQueue) {
                    const expected = ordinaryQueue();
                    if (expected.length !== receipts.length || receipts.some(receipt => {
                        const row = current.file.entries.find(entry => entry.updateId === receipt.updateId);
                        const source = expected.find(entry => entry.updateId === receipt.updateId);
                        return !row || !source || row.privateTextReply !== undefined || row.inputClaim?.executionUpdate !== undefined ||
                            !isDeepStrictEqual(ordinaryV4EntryDigest(row, path), source);
                    }))
                        throw createJournalError("conflict", path, "ordinary queue serialized running source changed");
                }
                const receiptsById = new Map(receipts.map((receipt) => [receipt.updateId, receipt]));
                const requestedIds = receipts.map((receipt) => receipt.updateId);
                const existingReceiptEntries = current.file.entries.filter((entry) => entry.queueReceiptId === receiptId);
                if (existingReceiptEntries.length > 0) {
                    const queueOwner = existingReceiptEntries[0]?.queueOwner;
                    if (existingReceiptEntries.length !== receipts.length ||
                        !queueOwner ||
                        !inputOwnerMatchesIdentity(queueOwner, context.owner) ||
                        existingReceiptEntries.some((entry) => {
                            const receipt = receiptsById.get(entry.updateId);
                            return (!receipt ||
                                entry.state !== "queued" ||
                                entry.queueKind !== queueKind ||
                                entry.queueHandoff !== undefined ||
                                !entry.inputProvenance ||
                                !areTelegramUpdateJournalQueueOwnersEqual(entry.inputProvenance.owner, receipt.owner) ||
                                entry.inputProvenance.recipientBindingKey !==
                                    context.recipientBindingKey);
                        })) {
                        throw createJournalError("conflict", path, "input queue transition conflicts with queued authority");
                    }
                    return {
                        queued: false,
                        queueReceipt: {
                            queueKind,
                            receiptId,
                            sourceUpdateIds: requestedIds,
                            queueOwner: cloneJournalQueueOwner(queueOwner),
                        },
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                for (const receipt of receipts) {
                    const entry = current.file.entries.find((candidate) => candidate.updateId === receipt.updateId);
                    if (!entry ||
                        entry.state !== "pending" ||
                        entry.preApprovalExcluded !== false ||
                        !entry.inputClaim ||
                        entry.inputClaim.phase !== "running" ||
                        entry.inputClaim.handoff ||
                        !areTelegramUpdateJournalQueueOwnersEqual(entry.inputClaim.owner, receipt.owner) ||
                        entry.inputClaim.recipientBindingKey !== context.recipientBindingKey) {
                        throw createJournalError("conflict", path, "input queue transition lost exact running authority");
                    }
                }
                const acquiredAtMs = getNowMs();
                if (!isSafeNonNegativeInteger(acquiredAtMs)) {
                    throw createJournalError("invalid", path, "received an invalid input queue acquisition timestamp");
                }
                const queueOwner = {
                    ...context.owner,
                    acquisitionId: randomUUID(),
                    acquiredAtMs,
                };
                const queuedEntries = current.file.entries.map((entry) => {
                    const receipt = receiptsById.get(entry.updateId);
                    if (!receipt)
                        return entry;
                    const claim = entry.inputClaim;
                    return {
                        updateId: entry.updateId,
                        update: entry.update,
                        admittedAtMs: entry.admittedAtMs,
                        preApprovalExcluded: false,
                        ...(entry.privateTextReply ? { privateTextReply: structuredClone(entry.privateTextReply) } : {}),
                        state: "queued",
                        queueKind,
                        queueReceiptId: receiptId,
                        queueOwner: cloneJournalQueueOwner(queueOwner),
                        inputProvenance: {
                            owner: cloneJournalQueueOwner(claim.owner),
                            recipientBindingKey: claim.recipientBindingKey,
                            ...(claim.executionUpdate
                                ? { executionUpdate: structuredClone(claim.executionUpdate) }
                                : {}),
                        },
                    };
                });
                const published = publishInputMutation(current, queuedEntries, requestedIds, context);
                return {
                    queued: true,
                    queueReceipt: {
                        queueKind,
                        receiptId,
                        sourceUpdateIds: requestedIds,
                        queueOwner: cloneJournalQueueOwner(queueOwner),
                    },
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
            });
        },
        acquireInput(value) {
            const updateId = value.updateId;
            const recipientBindingKey = value.recipientBindingKey;
            const executionUpdate = value.executionUpdate === undefined
                ? undefined
                : normalizeIncomingJournaledUpdate(value.executionUpdate, path);
            if (!isSafeNonNegativeInteger(updateId) ||
                !isBoundedString(recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
                !recipientBindingKey.trim() ||
                (executionUpdate && executionUpdate.update_id !== updateId)) {
                throw createJournalError("invalid", path, "received invalid input acquisition identity");
            }
            return runInputMutation("acquire", (read) => {
                const context = currentInputContext();
                const identity = context.owner;
                if (recipientBindingKey !== context.recipientBindingKey) {
                    throw createJournalError("conflict", path, "input acquisition targets another execution binding");
                }
                const current = read();
                const entry = current.file.entries.find((candidate) => candidate.updateId === updateId);
                if (!entry ||
                    entry.state !== "pending" ||
                    entry.preApprovalExcluded !== false) {
                    throw createJournalError("conflict", path, "input is not eligible for acquisition");
                }
                if (privateFirstPreparation) {
                    const selected = privateFirstPreparation();
                    if (selected.updateId !== updateId || executionUpdate !== undefined ||
                        !isPrivateFirstPreparationEntry(entry) ||
                        !isDeepStrictEqual(createTelegramUpdateJournalEntryDigest(entry), selected.expectedPendingSource))
                        throw createJournalError("conflict", path, "private first preparation serialized source changed");
                }
                if (inputAdmission) {
                    const selected = inputAdmission();
                    if (selected.phase !== "acquire" || selected.updateId !== updateId || executionUpdate !== undefined ||
                        !isPrivateFirstPreparationEntry(entry) ||
                        !isDeepStrictEqual(ordinaryV4EntryDigest(entry, path), selected.expectedSource))
                        throw createJournalError("conflict", path, "ordinary admission serialized pending source changed");
                }
                const projected = executionUpdate ?? entry.update;
                const existing = entry.inputClaim;
                if (existing) {
                    if (!isTelegramUpdateJournalQueueOwnerProcess(existing.owner, identity) ||
                        existing.owner.sessionGeneration !== identity.sessionGeneration ||
                        existing.recipientBindingKey !== recipientBindingKey ||
                        !isDeepStrictEqual(existing.executionUpdate ?? entry.update, projected)) {
                        throw createJournalError("conflict", path, "input already has another owner or execution projection");
                    }
                    return {
                        acquired: false,
                        receipt: createInputReceipt(updateId, existing.owner),
                    };
                }
                const claim = {
                    phase: "ready",
                    recipientBindingKey,
                    owner: {
                        ...identity,
                        acquisitionId: randomUUID(),
                        acquiredAtMs: getNowMs(),
                    },
                    ...(!isDeepStrictEqual(projected, entry.update)
                        ? { executionUpdate: projected }
                        : {}),
                };
                const claimedEntries = current.file.entries.map((candidate) => candidate.updateId === updateId
                    ? { ...candidate, inputClaim: claim }
                    : candidate);
                const reservedEntry = {
                    ...entry,
                    inputClaim: createInputHeadroomClaim(entry, "ready"),
                };
                const reservedEntries = replaceInputHeadroomEntry(current.file, updateId, reservedEntry);
                const actualBytes = Buffer.byteLength(serializeJournalFile({ ...current.file, entries: claimedEntries }));
                const reservedBytes = Buffer.byteLength(serializeJournalFile({ ...current.file, entries: reservedEntries })) + TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES;
                if (actualBytes > reservedBytes) {
                    throw createJournalError("capacity", path, "execution projection exceeds reserved input headroom");
                }
                publishInputMutation(current, claimedEntries, updateId, context, privateFirstPreparation ? () => { privateFirstPreparation(); } : undefined);
                return {
                    acquired: true,
                    receipt: createInputReceipt(updateId, claim.owner),
                };
            });
        },
        startInput(value) {
            const receipt = normalizeInputReceipt(value);
            return runInputMutation("start", (read) => {
                const context = currentInputContext();
                const current = read();
                const entry = ownedInput(current, receipt);
                const claim = entry.inputClaim;
                if (inputAdmission) {
                    const selected = inputAdmission();
                    if (selected.phase !== "start" || selected.updateId !== receipt.updateId || claim.phase !== "ready" ||
                        !isDeepStrictEqual(ordinaryV4EntryDigest(entry, path), selected.expectedSource))
                        throw createJournalError("conflict", path, "ordinary admission serialized READY source changed");
                }
                if (context.owner.sessionGeneration !== receipt.owner.sessionGeneration ||
                    context.recipientBindingKey !== claim.recipientBindingKey) {
                    throw createJournalError("conflict", path, "input belongs to another execution session or binding");
                }
                if (claim.phase === "running")
                    return { started: false };
                if (claim.handoff)
                    throw createJournalError("conflict", path, "input handoff freezes donor execution");
                publishInputMutation(current, current.file.entries.map((candidate) => candidate.updateId === receipt.updateId
                    ? {
                        ...candidate,
                        inputClaim: { ...claim, phase: "running" },
                    }
                    : candidate), receipt.updateId, context);
                return {
                    started: true,
                    update: structuredClone(claim.executionUpdate ?? entry.update),
                };
            });
        },
        completeInput(value) {
            const receipt = normalizeInputReceipt(value);
            return runInputMutation("complete", (read) => {
                const current = read();
                const selected = inputAdmission?.();
                const existing = current.file.entries.find(entry => entry.updateId === receipt.updateId);
                if (selected && (selected.phase !== "complete" || selected.updateId !== receipt.updateId || !existing ||
                    !isDeepStrictEqual(ordinaryV4EntryDigest(existing, path), selected.expectedSource)))
                    throw createJournalError("conflict", path, "private completion serialized source changed");
                const exists = existing !== undefined;
                if (!exists &&
                    current.exists &&
                    receipt.updateId <= (current.file.acceptedThroughUpdateId ?? -1)) {
                    return {
                        removedUpdateIds: [],
                        entryCount: current.file.entries.length,
                        serializedBytes: current.serializedBytes,
                    };
                }
                const entry = ownedInput(current, receipt);
                if (entry.inputClaim.phase !== "running")
                    throw createJournalError("conflict", path, "input has not started");
                const published = publishInputSettlement(current, current.file.entries.filter((candidate) => candidate.updateId !== receipt.updateId), true);
                const result = {
                    removedUpdateIds: [receipt.updateId],
                    entryCount: published.file.entries.length,
                    serializedBytes: published.serializedBytes,
                };
                if (completionInFlight?.active && selected?.phase === "complete") {
                    completionInFlight.receipt = Object.freeze({ ...receipt, owner: Object.freeze({ ...receipt.owner }) });
                    completionInFlight.source = Object.freeze({ ...selected.expectedSource });
                    completionInFlight.returned = result;
                }
                return result;
            });
        },
    };
    if (version === TELEGRAM_UPDATE_JOURNAL_PRIVATE_TEXT_VERSION) {
        const completionPorts = {
            completeQueuedExact(receipts, completions) {
                return runInputAdmission("complete-queued-exact", () => journal.completeQueuedExact(receipts, completions));
            },
            inspectSourceCompletion(expected) {
                return runInputAdmission("inspect-source-completion", () => journal.inspectSourceCompletion(expected));
            },
        };
        Object.assign(input, completionPorts);
    }
    const nativeAppend = journal.appendBatch.bind(journal);
    const appendAcknowledged = (updates, cursor) => {
        if (appendInFlight) {
            appendInFlight.poisoned = true;
            throw new Error("Ordinary v4 append cannot reenter.");
        }
        if (version !== 4 || !getInputContext || !ordinaryAppendScope)
            throw new Error("Ordinary v4 append requires its retained source scope.");
        const ticket = { active: true, poisoned: false };
        tickets.add(ticket);
        appendInFlight = ticket;
        try {
            const result = ordinaryAppendScope(() => {
                try {
                    return nativeAppend(updates, cursor, ticket);
                }
                finally {
                    ticket.active = false;
                }
            });
            // No synchronous capture authority survives inspection of a supplied return value.
            ticket.active = false;
            if (result !== null && (typeof result === "object" || typeof result === "function") &&
                typeof result.then === "function")
                throw new Error("Ordinary v4 append must return synchronously.");
            if (ticket.poisoned || !ticket.captured || result !== ticket.returned)
                throw new Error("Ordinary v4 append was not acknowledged.");
            return { result, captured: ticket.captured };
        }
        finally {
            ticket.active = false;
            tickets.delete(ticket);
            appendInFlight = undefined;
        }
    };
    const nativeComplete = input.completeInput.bind(input);
    const completeInputAcknowledged = (receipt) => {
        if (completionInFlight) {
            completionInFlight.poisoned = true;
            throw new Error("Private input completion cannot reenter.");
        }
        if (version !== 4 || !inputAdmission)
            throw new Error("Private input completion requires a retained native scope.");
        const ticket = { active: true, poisoned: false };
        completionInFlight = lastCompletion = ticket;
        try {
            const result = nativeComplete(receipt);
            ticket.active = false;
            if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
                ticket.poisoned = true;
                throw new Error("Private input completion must return synchronously.");
            }
            if (ticket.poisoned || !ticket.returned || result !== ticket.returned)
                throw new Error("Private input completion was not acknowledged.");
            return result;
        }
        finally {
            ticket.active = false;
            completionInFlight = undefined;
        }
    };
    const getInputCompletionPublication = () => {
        const ticket = lastCompletion;
        if (!ticket || ticket.active || ticket.poisoned || !ticket.returned || !ticket.receipt || !ticket.source ||
            !isDeepStrictEqual(ticket.returned.removedUpdateIds, [ticket.receipt.updateId]))
            return undefined;
        return Object.freeze({ receipt: ticket.receipt, source: ticket.source, assertPublished() {
                if (ticket.active || ticket.poisoned || !ticket.returned)
                    throw new Error("Private input publication history is unavailable.");
            } });
    };
    return { journal, input, appendAcknowledged, completeInputAcknowledged, getInputCompletionPublication };
}
