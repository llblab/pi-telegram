/**
 * Telegram message ownership helpers
 * Zones: telegram routing, multi-instance bus, in-memory coordination
 * Owns message-id ownership, ordinary live forwarding projections, and opt-in immutable original-receiver provenance; observations never restore input/execution authority
 */
import { TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION, isSameTelegramBusFollowerRegistration, } from "./bus.js";
import { getTelegramTargetKey } from "./target.js";
function getTelegramFollowerOwnershipGeneration(follower) {
    return (follower.registrationGeneration ??
        `${follower.instanceId}:${follower.connectedAtMs}`);
}
function isOriginalPublicationTarget(target) {
    return Number.isSafeInteger(target.chatId) && target.chatId > 0 &&
        (target.threadId === undefined || Number.isSafeInteger(target.threadId) && target.threadId > 0);
}
function isCompleteOriginalRecipient(recipient, target) {
    return !!recipient && [recipient.instanceId, recipient.profileKey, recipient.registrationGeneration, recipient.sessionId,
        recipient.processBirthId, recipient.cwd, recipient.busSocketPath].every(value => typeof value === "string" && value.trim().length > 0) &&
        Number.isSafeInteger(recipient.sessionGeneration) && recipient.sessionGeneration >= 0 &&
        Number.isSafeInteger(recipient.pid) && recipient.pid > 0 && Number.isSafeInteger(recipient.connectedAtMs) && recipient.connectedAtMs >= 0 &&
        (recipient.target === undefined ? target.threadId === undefined :
            isOriginalPublicationTarget(recipient.target) && getTelegramTargetKey(recipient.target) === getTelegramTargetKey(target)) &&
        recipient.protocol?.capabilities.includes(TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION) === true;
}
export function createTelegramBusMessageOwnershipRuntime(deps) {
    const store = createTelegramMessageOwnershipStore({
        getProfileKey: deps.getProfileKey,
        isOwnerGenerationLive(record) {
            if (!record.ownerGeneration)
                return true;
            return deps.listFollowers().some((follower) => {
                return (follower.instanceId === record.instanceId &&
                    getTelegramFollowerOwnershipGeneration(follower) ===
                        record.ownerGeneration);
            });
        },
        resolveOwnerReplacement(record) {
            if (!record.recipientBindingKey)
                return undefined;
            const follower = deps
                .listFollowers()
                .find((candidate) => candidate.profileKey === record.recipientBindingKey);
            return follower
                ? {
                    instanceId: follower.instanceId,
                    ownerGeneration: getTelegramFollowerOwnershipGeneration(follower),
                    recipientBindingKey: record.recipientBindingKey,
                }
                : undefined;
        },
    });
    const recordFollower = function (input) {
        return store.record({
            chatId: input.chatId,
            messageId: input.messageId,
            target: input.target,
            instanceId: input.follower.instanceId,
            ownerGeneration: getTelegramFollowerOwnershipGeneration(input.follower),
            recipientBindingKey: input.follower.profileKey,
            recipient: input.follower,
            retainOriginal: input.retainOriginal,
        });
    };
    const isCurrentRecipient = (recipient) => {
        const live = deps.listFollowers().find(candidate => candidate.instanceId === recipient.instanceId);
        return !!live && isSameTelegramBusFollowerRegistration(live, recipient) &&
            (live.target === undefined ? recipient.target === undefined : recipient.target !== undefined &&
                getTelegramTargetKey(live.target) === getTelegramTargetKey(recipient.target));
    };
    const capturePublication = (target, follower) => {
        const profile = deps.getProfileKey(), capturedTarget = Object.freeze({ ...target });
        const recipient = follower === undefined ? undefined : structuredClone(follower);
        if (!profile.trim() || !isOriginalPublicationTarget(capturedTarget) ||
            (recipient && (!isCompleteOriginalRecipient(recipient, capturedTarget) || !isCurrentRecipient(recipient))) || deps.getProfileKey() !== profile) {
            throw new Error("Original publication scope is unavailable.");
        }
        const readProfile = deps.getProfileKey, readFollowers = deps.listFollowers;
        let current = true, checking = false;
        const assertCurrent = () => {
            try {
                if (!current || checking)
                    throw new Error("Original publication scope is unavailable.");
                checking = true;
                if (deps.getProfileKey !== readProfile || deps.listFollowers !== readFollowers || readProfile.call(deps) !== profile ||
                    recipient && !isCurrentRecipient(recipient) || readProfile.call(deps) !== profile || !current || !checking ||
                    deps.getProfileKey !== readProfile || deps.listFollowers !== readFollowers)
                    throw new Error("Original publication scope is unavailable.");
            }
            catch (error) {
                current = false;
                throw error;
            }
            finally {
                checking = false;
            }
        };
        const record = (messageId) => {
            if (!current || checking) {
                current = false;
                throw new Error("Original publication scope is unavailable.");
            }
            if (deps.getProfileKey() !== profile)
                throw new Error("Original publication profile is no longer current.");
            if (!Number.isSafeInteger(messageId) || messageId <= 0)
                throw new Error("Original publication receipt is invalid.");
            store.record({ chatId: capturedTarget.chatId, messageId, target: capturedTarget,
                instanceId: recipient?.instanceId ?? deps.instanceId, profileKey: profile,
                ...(recipient ? { recipient, ownerGeneration: getTelegramFollowerOwnershipGeneration(recipient), recipientBindingKey: recipient.profileKey } : {}),
                retainOriginal: true, requireFirst: true });
            if (!runtime.getOriginalForwardOwnership(capturedTarget.chatId, messageId) || deps.getProfileKey() !== profile) {
                throw new Error("Original publication receiver is unavailable.");
            }
        };
        return Object.freeze(Object.assign(record, { assertCurrent }));
    };
    const runtime = {
        store,
        captureLocalPublication: target => capturePublication(target),
        captureFollowerPublication: (follower, target) => capturePublication(target, follower),
        getForwardOwnership(chatId, messageId) {
            const record = store.get(chatId, messageId);
            if (!record?.ownerGeneration || !record.recipientBindingKey)
                return record;
            const follower = deps
                .listFollowers()
                .find((candidate) => candidate.instanceId === record.instanceId &&
                candidate.registrationGeneration === record.ownerGeneration &&
                candidate.profileKey === record.recipientBindingKey);
            // Protocol is live registration authority, not message-cache history.
            // Keep an incomplete known owner foreign so the forwarder fails closed.
            return follower?.protocol?.capabilities.includes(TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION)
                ? { ...record, protocolIdentity: follower.protocol }
                : record;
        },
        captureOriginalForwardOwnership(chatId, messageId) {
            const profile = deps.getProfileKey(), original = store.getOriginal(chatId, messageId);
            const ownership = runtime.getOriginalForwardOwnership(chatId, messageId);
            if (!original || !ownership || deps.getProfileKey() !== profile || store.getOriginal(chatId, messageId) !== original)
                return undefined;
            let current = true;
            return Object.freeze({ ownership: Object.freeze(ownership), ...(original.recipient ? { recipient: original.recipient } : {}), assertCurrent() {
                    try {
                        if (current && deps.getProfileKey() === profile && store.getOriginal(chatId, messageId) === original &&
                            runtime.getOriginalForwardOwnership(chatId, messageId) && store.getOriginal(chatId, messageId) === original &&
                            deps.getProfileKey() === profile)
                            return;
                    }
                    catch { /* An unavailable observation cannot renew this captured scope. */ }
                    current = false;
                    throw new Error("Original Telegram message receiver is unavailable.");
                } });
        },
        getOriginalForwardOwnership(chatId, messageId) {
            const original = store.getOriginal(chatId, messageId);
            if (!original)
                return undefined;
            const { record, recipient } = original;
            if (!isOriginalPublicationTarget(record.target) || record.target.chatId !== record.chatId ||
                !Number.isSafeInteger(record.messageId) || record.messageId <= 0 ||
                ![record.instanceId, record.profileKey].every(value => typeof value === "string" && value.trim().length > 0))
                return undefined;
            if (record.instanceId === deps.instanceId)
                return record;
            if (!isCompleteOriginalRecipient(recipient, record.target))
                return undefined;
            if (!recipient.registrationGeneration || !record.ownerGeneration || !record.recipientBindingKey ||
                recipient.instanceId !== record.instanceId || recipient.registrationGeneration !== record.ownerGeneration ||
                recipient.profileKey !== record.recipientBindingKey ||
                !recipient.protocol?.capabilities.includes(TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION))
                return undefined;
            if (!isCurrentRecipient(recipient))
                return undefined;
            return { ...record, protocolIdentity: recipient.protocol };
        },
        recordLocal(input) {
            return store.record({ ...input, instanceId: deps.instanceId });
        },
        recordRouted(input) {
            const follower = deps
                .listFollowers()
                .find((candidate) => candidate.instanceId === input.instanceId);
            return follower
                ? recordFollower({ ...input, follower })
                : store.record(input);
        },
        recordFollower,
        isOwnedByFollower({ chatId, messageId, follower }) {
            const ownership = store.get(chatId, messageId);
            return (ownership?.instanceId === follower.instanceId &&
                ownership.ownerGeneration ===
                    getTelegramFollowerOwnershipGeneration(follower));
        },
    };
    return runtime;
}
function getTelegramMessageOwnershipKey(chatId, messageId, profileKey) {
    return `${profileKey ?? ""}:${chatId}:${messageId}`;
}
function createTelegramMessageOwnershipRecord(input) {
    return {
        chatId: input.chatId,
        messageId: input.messageId,
        target: input.target ?? { chatId: input.chatId },
        instanceId: input.instanceId,
        ...(input.profileKey ? { profileKey: input.profileKey } : {}),
        ...(input.ownerGeneration
            ? { ownerGeneration: input.ownerGeneration }
            : {}),
        ...(input.recipientBindingKey
            ? { recipientBindingKey: input.recipientBindingKey }
            : {}),
        createdAt: input.previous?.createdAt ?? input.now,
        updatedAt: input.now,
    };
}
export function createTelegramMessageOwnershipStore(options = {}) {
    const records = new Map();
    return {
        record: (input) => {
            const profileKey = input.profileKey ?? options.getProfileKey?.();
            const key = getTelegramMessageOwnershipKey(input.chatId, input.messageId, profileKey);
            const now = input.now ?? Date.now();
            const previous = records.get(key);
            if (input.requireFirst === true && previous)
                throw new Error("Original message publication was already observed.");
            const record = createTelegramMessageOwnershipRecord({
                ...input,
                profileKey,
                now,
                previous: previous?.current,
            });
            let original = previous?.original;
            // Only the first publication may opt in; later observations cannot manufacture missing provenance.
            if (!previous && input.retainOriginal === true) {
                const recipient = input.recipient === undefined ? undefined : structuredClone(input.recipient);
                if (recipient?.target)
                    Object.freeze(recipient.target);
                if (recipient?.protocol) {
                    Object.freeze(recipient.protocol.capabilities);
                    Object.freeze(recipient.protocol);
                }
                original = Object.freeze({ record: Object.freeze({ ...record, target: Object.freeze({ ...record.target }) }),
                    ...(recipient ? { recipient: Object.freeze(recipient) } : {}) });
            }
            records.set(key, { current: record, original });
            return record;
        },
        get: (chatId, messageId) => {
            const key = getTelegramMessageOwnershipKey(chatId, messageId, options.getProfileKey?.());
            const entry = records.get(key);
            if (!entry)
                return undefined;
            const record = entry.current;
            if (record.ownerGeneration &&
                options.isOwnerGenerationLive &&
                !options.isOwnerGenerationLive(record)) {
                const replacement = options.resolveOwnerReplacement?.(record);
                if (!replacement)
                    return undefined;
                const rebound = { ...record, ...replacement };
                entry.current = rebound;
                return rebound;
            }
            return record;
        },
        getOriginal: (chatId, messageId) => records.get(getTelegramMessageOwnershipKey(chatId, messageId, options.getProfileKey?.()))?.original,
        forget: (chatId, messageId) => records.delete(getTelegramMessageOwnershipKey(chatId, messageId, options.getProfileKey?.())),
        forgetTarget: (target) => {
            const targetKey = getTelegramTargetKey(target);
            const profileKey = options.getProfileKey?.();
            let removed = 0;
            for (const [key, { current: record }] of records) {
                if ((record.profileKey ?? undefined) !== profileKey)
                    continue;
                if (getTelegramTargetKey(record.target) !== targetKey)
                    continue;
                records.delete(key);
                removed += 1;
            }
            return removed;
        },
        prune: ({ now, maxAgeMs, maxRecords }) => {
            let removed = 0;
            if (maxAgeMs !== undefined) {
                for (const [key, { current: record }] of records) {
                    if (now - record.updatedAt <= maxAgeMs)
                        continue;
                    records.delete(key);
                    removed += 1;
                }
            }
            if (maxRecords !== undefined && records.size > maxRecords) {
                const oldest = [...records.entries()].sort((left, right) => left[1].current.updatedAt - right[1].current.updatedAt);
                for (const [key] of oldest.slice(0, records.size - maxRecords)) {
                    records.delete(key);
                    removed += 1;
                }
            }
            return removed;
        },
        entries: () => [...records.values()].map(entry => entry.current),
        clear: () => {
            records.clear();
        },
    };
}
