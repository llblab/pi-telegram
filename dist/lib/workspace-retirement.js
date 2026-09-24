/**
 * Workspace slot rotation
 * Zones: telegram, workspace identity, lifecycle
 * Owns fail-closed protection, demand-driven pressure retirement, exact-intent admission,
 * successor recovery, and fenced one-shot deletion before durable slot reuse.
 */
import { isDeepStrictEqual } from "node:util";
import { getTelegramApiErrorRequestTarget, isTelegramApiRequestRejected, } from "./telegram-api.js";
import { planTelegramWorkspaceSlotAllocation, TelegramWorkspaceSlotUnavailableError, } from "./workspace-slots.js";
import { createTelegramWorkspaceAdmissionOperationId, isTelegramWorkspaceRetirementFence, runWithTelegramWorkspaceAdmissionsAsync, } from "./workspace-admission.js";
export function createTelegramWorkspaceOperationGate() {
    let tail = Promise.resolve();
    return {
        runExclusive(operation) {
            const run = tail.then(operation);
            tail = run.then(() => undefined, () => undefined);
            return run;
        },
    };
}
export function createTelegramWorkspaceOperationRuntime(input = {}) {
    const gate = createTelegramWorkspaceOperationGate();
    const run = (metadata, operation) => {
        const gated = () => gate.runExclusive(operation);
        if (!input.getWorkspaceAdmission)
            return gated();
        const admission = input.getWorkspaceAdmission();
        if (!admission) {
            throw new Error("Telegram Workspace admission authority is unavailable.");
        }
        return runWithTelegramWorkspaceAdmissionsAsync({
            ledger: admission,
            ...metadata,
            operation: gated,
            onReleaseError(error) {
                input.onReleaseError?.(error, metadata.operationKind);
            },
        });
    };
    return { run, runExclusive: gate.runExclusive };
}
export function captureTelegramWorkspaceJournalProtectionSources(input) {
    const sources = [];
    let complete = input.binding.journalBindingsComplete === true ||
        input.discovery?.complete === true;
    const capture = (scope, resolve) => {
        try {
            const binding = resolve();
            if (!binding) {
                complete = false;
                sources.push({ kind: "unknown", scope });
                return;
            }
            const read = binding.readForProtection ?? binding.journal.read;
            const snapshot = input.withJournalReference
                ? input.withJournalReference(binding, read)
                : read();
            sources.push({ kind: "available", scope, entries: snapshot.entries });
        }
        catch {
            complete = false;
            sources.push({ kind: "unknown", scope });
        }
    };
    capture({ kind: "shared" }, input.resolveLeader);
    for (const journalBindingKey of input.binding.journalBindingKeys ?? []) {
        capture({
            kind: "binding",
            bindingKey: input.binding.bindingKey,
            journalBindingKey,
        }, input.createFollowerResolver(journalBindingKey));
    }
    for (const path of input.discovery?.paths ?? []) {
        capture({ kind: "discovered", path }, input.discovery.createResolver(path));
    }
    return { sources, complete };
}
function getJournalUpdateTarget(update) {
    if (!update || typeof update !== "object" || Array.isArray(update))
        return undefined;
    const record = update;
    if (record.message_reaction !== undefined)
        return undefined;
    const direct = record.message ?? record.edited_message ?? record.guest_message;
    const callback = record.callback_query;
    const message = direct ?? (callback && typeof callback === "object" && !Array.isArray(callback)
        ? callback.message
        : undefined);
    if (!message || typeof message !== "object" || Array.isArray(message))
        return undefined;
    const messageRecord = message;
    const chat = messageRecord.chat;
    if (!chat || typeof chat !== "object" || Array.isArray(chat))
        return undefined;
    const chatId = chat.id;
    if (typeof chatId !== "number")
        return undefined;
    const threadId = messageRecord.message_thread_id;
    return {
        chatId,
        ...(typeof threadId === "number" ? { threadId } : {}),
    };
}
function sameTarget(left, right) {
    return left.chatId === right.chatId && left.threadId === right.threadId;
}
export function resolveTelegramWorkspaceAcceptedWorkProtection(input) {
    if (input.localAcceptedTargets.some((target) => sameTarget(target, input.binding.target))) {
        return "protected";
    }
    let unknown = !input.sourcesComplete;
    for (const source of input.journalSources) {
        const relevant = source.scope.kind !== "binding" ||
            source.scope.bindingKey === input.binding.bindingKey;
        if (!relevant)
            continue;
        if (source.kind === "unknown") {
            unknown = true;
            continue;
        }
        if (source.scope.kind === "binding" && source.entries.length > 0) {
            return "protected";
        }
        for (const entry of source.entries) {
            const target = getJournalUpdateTarget(entry.update);
            if (!target) {
                unknown = true;
                continue;
            }
            if (sameTarget(target, input.binding.target))
                return "protected";
        }
    }
    return unknown ? "unknown" : "clear";
}
export async function pruneTelegramWorkspaceJournalEvidence(input) {
    const operation = async () => {
        const leaderEpoch = input.getLeaderEpoch();
        const profileKey = input.getProfileKey();
        const isCurrent = () => leaderEpoch !== undefined &&
            input.getLeaderEpoch() === leaderEpoch &&
            input.getProfileKey() === profileKey &&
            input.isCurrent?.() !== false;
        if (!isCurrent()) {
            throw new Error("Telegram Workspace journal pruning requires current leader authority.");
        }
        const shared = input.capture.sources.filter((source) => source.scope.kind === "shared");
        const bindingSources = input.capture.sources.filter((source) => source.scope.kind === "binding" &&
            source.scope.bindingKey === input.binding.bindingKey);
        const sourceByKey = new Map(bindingSources.flatMap((source) => source.scope.kind === "binding"
            ? [[source.scope.journalBindingKey, source]]
            : []));
        if (!input.capture.complete ||
            shared.length !== 1 ||
            shared[0]?.kind !== "available" ||
            bindingSources.length !==
                (input.binding.journalBindingKeys ?? []).length ||
            sourceByKey.size !== (input.binding.journalBindingKeys ?? []).length ||
            Array.from(sourceByKey.values()).some((source) => source.kind !== "available")) {
            return { kind: "blocked", reason: "incomplete-evidence" };
        }
        const emptyKeys = (input.binding.journalBindingKeys ?? []).filter((key) => {
            const source = sourceByKey.get(key);
            return source?.kind === "available" && source.entries.length === 0;
        });
        if (emptyKeys.some((key) => input.getJournalWriterProtection(key) !== "clear")) {
            return { kind: "blocked", reason: "writer-not-quiescent" };
        }
        const retainedKeys = (input.binding.journalBindingKeys ?? []).filter((key) => !emptyKeys.includes(key));
        if (!isCurrent()) {
            throw new Error("Telegram Workspace journal pruning lost leader authority.");
        }
        const binding = input.store.commitWorkspaceJournalEvidence(input.binding, retainedKeys, input.binding.journalBindingsComplete === true);
        if (!binding)
            return { kind: "blocked", reason: "state-changed" };
        const removedKeys = (input.binding.journalBindingKeys ?? []).filter((key) => !retainedKeys.includes(key));
        if (removedKeys.length > 0)
            await input.store.persist();
        if (!isCurrent()) {
            throw new Error("Telegram Workspace journal pruning lost leader authority.");
        }
        return { kind: "committed", binding, removedKeys };
    };
    return runWithTelegramWorkspaceAdmissionsAsync({
        ledger: input.admission,
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind: "workspace.prune-journal-evidence",
        scopes: [{ kind: "target", target: input.binding.target }],
        operation,
        onReleaseError(error) {
            input.onAdmissionReleaseError?.(error);
        },
    });
}
export function captureTelegramWorkspaceExternalProtection(input) {
    let liveOwner = "unknown";
    let acceptedWork = "unknown";
    let deliveryAuthority = "unknown";
    try {
        liveOwner = input.getLiveOwnerProtection(input.binding);
    }
    catch {
        // Unavailable registry/process evidence must not clear a binding.
    }
    try {
        const journals = input.captureJournalSources(input.binding);
        const local = input.getLocalAcceptedTargets(input.binding);
        acceptedWork = resolveTelegramWorkspaceAcceptedWorkProtection({
            binding: input.binding,
            localAcceptedTargets: local.targets,
            journalSources: journals.sources,
            sourcesComplete: journals.complete && local.complete,
        });
    }
    catch {
        // Unavailable queue or journal evidence must not clear accepted work.
    }
    try {
        deliveryAuthority = input.getDeliveryAuthorityProtection?.(input.binding) ?? "unknown";
    }
    catch {
        // Unavailable delivery evidence must not clear a binding.
    }
    return { liveOwner, acceptedWork, deliveryAuthority };
}
export function createTelegramWorkspaceExternalProtectionCapture(deps) {
    return function (binding) {
        return captureTelegramWorkspaceExternalProtection({
            binding,
            getLiveOwnerProtection(candidate) {
                if (deps.listFollowers().some((follower) => !!follower.target && sameTarget(follower.target, candidate.target)))
                    return "protected";
                if (!deps.getJournalWriterProtection)
                    return "unknown";
                let unknown = candidate.journalBindingsComplete !== true;
                for (const journalBindingKey of candidate.journalBindingKeys ?? []) {
                    const protection = deps.getJournalWriterProtection(journalBindingKey);
                    if (protection === "protected")
                        return "protected";
                    if (protection === "unknown")
                        unknown = true;
                }
                return unknown ? "unknown" : "clear";
            },
            getLocalAcceptedTargets(candidate) {
                const items = deps.getQueuedItems();
                const targets = [];
                const activeTarget = deps.getActiveTurnTarget();
                if (activeTarget)
                    targets.push(activeTarget);
                let complete = true;
                for (const item of items) {
                    if (item.target)
                        targets.push(item.target);
                    else if (item.chatId === candidate.target.chatId)
                        complete = false;
                }
                return { targets, complete };
            },
            captureJournalSources(candidate) {
                const discovery = candidate.journalBindingsComplete === true
                    ? undefined
                    : deps.discoverFollowerJournals?.();
                return captureTelegramWorkspaceJournalProtectionSources({
                    binding: candidate,
                    resolveLeader: deps.resolveLeaderJournal,
                    createFollowerResolver: deps.createFollowerJournalResolver,
                    ...(deps.withJournalReference
                        ? { withJournalReference: deps.withJournalReference } : {}),
                    ...(discovery && deps.createJournalPathResolver
                        ? { discovery: {
                                ...discovery,
                                createResolver: deps.createJournalPathResolver,
                            } }
                        : {}),
                });
            },
            ...(deps.getDeliveryAuthorityProtection
                ? { getDeliveryAuthorityProtection: deps.getDeliveryAuthorityProtection }
                : {}),
        });
    };
}
export function isCurrentTelegramWorkspaceBinding(store, expected) {
    return store.listWorkspaceBindings().some((binding) => isDeepStrictEqual(binding, expected));
}
/**
 * Demand-only preparation for pressure retirement. Every removed group is still
 * owned by the journal's exact dead-owner CAS; this function never clears local
 * queue memory or turns unknown evidence into deletion authority.
 */
export function createTelegramWorkspaceDeadOwnerQueueReclaimer(deps) {
    const localProtection = (binding) => {
        const active = deps.getActiveTurnTarget();
        if (active && sameTarget(active, binding.target))
            return "protected";
        let unknown = false;
        for (const item of deps.getQueuedItems()) {
            if (item.target && sameTarget(item.target, binding.target))
                return "protected";
            if (!item.target && item.chatId === binding.target.chatId)
                unknown = true;
        }
        return unknown ? "unknown" : "clear";
    };
    return async (binding, isCurrent) => {
        if (!isCurrent() || !deps.isBindingCurrent(binding)) {
            return { kind: "blocked", reason: "authority-changed" };
        }
        const initial = deps.getExternalProtection(binding);
        if (initial.liveOwner !== "clear" || initial.deliveryAuthority !== "clear") {
            return { kind: "blocked", reason: "live-owner" };
        }
        if (localProtection(binding) !== "clear") {
            return { kind: "blocked", reason: "local-work" };
        }
        if (initial.acceptedWork === "clear")
            return { kind: "not-needed" };
        const discovery = binding.journalBindingsComplete === true
            ? undefined
            : deps.discoverFollowerJournals?.();
        let complete = binding.journalBindingsComplete === true || discovery?.complete === true;
        const sources = [];
        const recoveryKeys = new Set();
        const capture = (scope, resolve) => {
            try {
                const source = resolve();
                if (!source?.recoveryKey || !source.readForProtection) {
                    complete = false;
                    return;
                }
                if (recoveryKeys.has(source.recoveryKey))
                    return;
                const snapshot = deps.withJournalReference
                    ? deps.withJournalReference(source, source.readForProtection)
                    : source.readForProtection();
                recoveryKeys.add(source.recoveryKey);
                sources.push({ scope, binding: source, entries: snapshot.entries });
            }
            catch {
                complete = false;
            }
        };
        capture("shared", deps.resolveLeaderJournal);
        for (const key of binding.journalBindingKeys ?? []) {
            capture("binding", deps.createFollowerJournalResolver(key));
        }
        for (const path of discovery?.paths ?? []) {
            if (!deps.createJournalPathResolver) {
                complete = false;
                break;
            }
            capture("discovered", deps.createJournalPathResolver(path));
        }
        if (!complete)
            return { kind: "blocked", reason: "incomplete-source" };
        const plans = [];
        for (const source of sources) {
            const relevant = source.scope === "binding"
                ? [...source.entries]
                : source.entries.filter((entry) => {
                    const target = getJournalUpdateTarget(entry.update);
                    return !!target && sameTarget(target, binding.target);
                });
            if (source.scope === "binding" && relevant.some((entry) => {
                const target = getJournalUpdateTarget(entry.update);
                return !target || !sameTarget(target, binding.target);
            }))
                return { kind: "blocked", reason: "unsupported-custody" };
            const seen = new Set();
            for (const entry of relevant) {
                if (entry.state !== "queued" ||
                    (entry.queueKind !== "prompt" && entry.queueKind !== "control") ||
                    !entry.queueReceiptId || !entry.queueOwner || entry.queueHandoff) {
                    return { kind: "blocked", reason: "unsupported-custody" };
                }
                if (seen.has(entry.queueReceiptId))
                    continue;
                const receiptEntries = source.entries.filter((candidate) => candidate.queueReceiptId === entry.queueReceiptId);
                if (!receiptEntries.length || receiptEntries.some((candidate) => {
                    const target = getJournalUpdateTarget(candidate.update);
                    return candidate.state !== "queued" ||
                        candidate.queueKind !== entry.queueKind ||
                        !candidate.queueOwner || candidate.queueHandoff !== undefined ||
                        !isDeepStrictEqual(candidate.queueOwner, entry.queueOwner) ||
                        !target || !sameTarget(target, binding.target);
                }))
                    return { kind: "blocked", reason: "unsupported-custody" };
                seen.add(entry.queueReceiptId);
                plans.push({
                    source: source.binding,
                    recovery: {
                        queueKind: entry.queueKind,
                        receiptId: entry.queueReceiptId,
                        sourceUpdateIds: receiptEntries.map((candidate) => candidate.updateId).sort((a, b) => a - b),
                        deadOwner: entry.queueOwner,
                        recoveryOwner: deps.getRecoveryOwner(),
                    },
                });
            }
        }
        if (!plans.length)
            return { kind: "blocked", reason: "protection-retained" };
        for (const plan of plans) {
            let liveness = "unverifiable";
            try {
                liveness = deps.getQueueOwnerLiveness(plan.recovery.deadOwner);
            }
            catch { /* Unknown process evidence is never destructive authority. */ }
            if (liveness === "alive")
                return { kind: "blocked", reason: "owner-alive" };
            if (liveness !== "dead")
                return { kind: "blocked", reason: "owner-unverifiable" };
        }
        const recoveredIds = [];
        for (const plan of plans) {
            if (!isCurrent() || !deps.isBindingCurrent(binding)) {
                return { kind: "blocked", reason: "authority-changed" };
            }
            const current = deps.getExternalProtection(binding);
            if (current.liveOwner !== "clear" || current.deliveryAuthority !== "clear") {
                return { kind: "blocked", reason: "live-owner" };
            }
            if (localProtection(binding) !== "clear") {
                return { kind: "blocked", reason: "local-work" };
            }
            let result;
            try {
                result = deps.withJournalReference
                    ? deps.withJournalReference(plan.source, () => plan.source.journal.recoverDeadQueueOwner(plan.recovery))
                    : plan.source.journal.recoverDeadQueueOwner(plan.recovery);
            }
            catch (error) {
                try {
                    deps.onMutationError?.(error);
                }
                catch { /* Diagnostics are fail-open. */ }
                return { kind: "blocked", reason: "mutation-refused" };
            }
            if (result.status === "owner-alive") {
                return { kind: "blocked", reason: "owner-alive" };
            }
            if (result.status === "owner-unverifiable") {
                return { kind: "blocked", reason: "owner-unverifiable" };
            }
            recoveredIds.push(...result.recoveredUpdateIds);
        }
        if (!isCurrent() || !deps.isBindingCurrent(binding)) {
            return { kind: "blocked", reason: "authority-changed" };
        }
        const after = deps.getExternalProtection(binding);
        if (after.liveOwner !== "clear" || after.acceptedWork !== "clear" ||
            after.deliveryAuthority !== "clear") {
            return { kind: "blocked", reason: "protection-retained" };
        }
        return {
            kind: "recovered",
            receipts: plans.length,
            updateIds: recoveredIds.sort((a, b) => a - b),
        };
    };
}
export async function adoptTelegramWorkspaceRetirementIntent(input) {
    return input.runExclusive(async () => {
        const leaderEpoch = input.getLeaderEpoch();
        const profileKey = input.getProfileKey();
        const isCurrent = () => leaderEpoch !== undefined && input.getLeaderEpoch() === leaderEpoch &&
            input.getProfileKey() === profileKey && input.isCurrent?.() !== false;
        if (!isCurrent())
            throw new Error("Telegram Workspace retirement adoption requires current leader authority.");
        const intents = input.store.listWorkspaceRetirementIntents();
        if (intents.length !== 1 || !isDeepStrictEqual(intents[0], input.intent)) {
            return { kind: "blocked", reason: "intent-conflict" };
        }
        if (input.intent.profileKey !== profileKey) {
            return { kind: "blocked", reason: "profile-changed" };
        }
        const binding = input.store.listWorkspaceBindings().find((candidate) => candidate.bindingKey === input.intent.binding.bindingKey);
        if (!binding || !isDeepStrictEqual(binding, input.intent.binding)) {
            return { kind: "blocked", reason: "binding-changed" };
        }
        const eligible = input.store.captureWorkspaceSlotOccupancy(input.getExternalProtection, { expectedRetirement: input.intent }).bindings.find((candidate) => candidate.bindingKey === binding.bindingKey)?.protection === "eligible";
        if (!eligible)
            return { kind: "blocked", reason: "protection-changed" };
        const replacement = { ...input.intent, leaderEpoch: leaderEpoch };
        if (!isCurrent())
            throw new Error("Telegram Workspace retirement adoption lost leader authority.");
        if (!await input.store.replaceWorkspaceRetirementIntent(input.intent, replacement, isCurrent))
            return { kind: "blocked", reason: "commit-rejected" };
        return { kind: "adopted", intent: replacement };
    });
}
function isTelegramWorkspaceDeletionConfirmedAbsent(error) {
    if (!(error instanceof Error))
        return false;
    const status = "status" in error && typeof error.status === "number"
        ? error.status : undefined;
    if (status !== 400)
        return false;
    const message = error.message.toLowerCase();
    return message.includes("topic_id_invalid") ||
        message.includes("message thread not found") ||
        message.includes("thread not found") ||
        message.includes("topic not found") ||
        message.includes("topic deleted");
}
function matchesTelegramWorkspaceRetirementFence(fence, intent) {
    return (fence.retirementIntentId === intent.id &&
        fence.profileKey === intent.profileKey &&
        fence.bindingKey === intent.binding.bindingKey &&
        fence.slot === intent.binding.slot &&
        fence.target.chatId === intent.binding.target.chatId &&
        fence.target.threadId === intent.binding.target.threadId &&
        fence.retirementRequestedAtMs === intent.requestedAtMs);
}
async function cancelRejectedTelegramWorkspaceRetirement(input, retained) {
    const epoch = input.getLeaderEpoch();
    const isCurrent = () => epoch !== undefined && input.getLeaderEpoch() === epoch &&
        input.getProfileKey() === retained.profileKey && input.isCurrent?.() !== false;
    if (!isCurrent())
        return { kind: "retained", reason: "authority-changed" };
    if (retained.phase !== "deletion-rejected" ||
        (retained.destructiveKind ?? "pressure-retirement") !== "pressure-retirement") {
        return { kind: "retained", reason: "fence-conflict" };
    }
    const owner = input.admission.getOwner();
    const fence = retained.leaderEpoch === epoch && isDeepStrictEqual(retained.owner, owner)
        ? retained : input.admission.adoptRetirementFence(retained, { owner, leaderEpoch: epoch });
    if (fence.phase !== "deletion-rejected")
        return { kind: "retained", reason: "fence-conflict" };
    const bindingRetained = () => input.store.listWorkspaceBindings().some(binding => binding.bindingKey === fence.bindingKey && binding.slot === fence.slot && sameTarget(binding.target, fence.target));
    const intents = input.store.listWorkspaceRetirementIntents();
    if (!bindingRetained() || intents.length > 1 ||
        (intents[0] && !matchesTelegramWorkspaceRetirementFence(fence, intents[0]))) {
        return { kind: "retained", reason: "stale-intent" };
    }
    if (intents[0] && !input.store.removeWorkspaceRetirementIntent(intents[0])) {
        return { kind: "retained", reason: "commit-rejected" };
    }
    // Publish even after a same-store retry whose failed write left only a dirty
    // in-memory withdrawal. The rejection fence protects both commit prefixes.
    await input.store.persist();
    if (!isCurrent())
        return { kind: "retained", reason: "authority-changed" };
    if (input.store.listWorkspaceRetirementIntents().length || !bindingRetained()) {
        return { kind: "retained", reason: "commit-rejected" };
    }
    try {
        input.admission.completeRejectedRetirementFence(fence);
    }
    catch {
        if (input.admission.read().fence)
            return { kind: "retained", reason: "fence-release-unconfirmed" };
    }
    return { kind: "cancelled", reason: "delete-rejected" };
}
export async function executeTelegramWorkspaceRetirement(input) {
    return input.runExclusive(async () => {
        const isCurrent = () => input.getLeaderEpoch() === input.intent.leaderEpoch &&
            input.getProfileKey() === input.intent.profileKey &&
            input.isCurrent?.() !== false;
        if (!isCurrent())
            return { kind: "retained", reason: "authority-changed" };
        if (!input.intent.binding.slot || !/^[A-Z]$/u.test(input.intent.binding.slot)) {
            return { kind: "retained", reason: "stale-intent" };
        }
        const owner = input.admission.getOwner();
        const storedFence = input.admission.read().fence;
        if (storedFence && !isTelegramWorkspaceRetirementFence(storedFence)) {
            return { kind: "retained", reason: "fence-conflict" };
        }
        let fence = storedFence;
        if (fence && !matchesTelegramWorkspaceRetirementFence(fence, input.intent)) {
            return { kind: "retained", reason: "fence-conflict" };
        }
        if (fence &&
            (fence.leaderEpoch !== input.intent.leaderEpoch ||
                fence.owner.processId !== owner.processId ||
                fence.owner.processBirthId !== owner.processBirthId)) {
            fence = input.admission.adoptRetirementFence(fence, {
                owner,
                leaderEpoch: input.intent.leaderEpoch,
            });
        }
        if (fence?.phase === "deletion-rejected") {
            return cancelRejectedTelegramWorkspaceRetirement({ ...input, isCurrent }, fence);
        }
        const intent = input.store.listWorkspaceRetirementIntents().find((candidate) => isDeepStrictEqual(candidate, input.intent));
        const binding = input.store.listWorkspaceBindings().find((candidate) => candidate.bindingKey === input.intent.binding.bindingKey);
        if (!intent || !binding || !isDeepStrictEqual(binding, input.intent.binding)) {
            if (!intent && !binding && fence?.phase === "commit-ready") {
                try {
                    input.admission.completeRetirementFence(fence);
                }
                catch {
                    if (input.admission.read().fence) {
                        return { kind: "retained", reason: "fence-release-unconfirmed" };
                    }
                }
                return {
                    kind: "retired",
                    bindingKey: input.intent.binding.bindingKey,
                    slot: input.intent.binding.slot,
                };
            }
            return { kind: "retained", reason: "stale-intent" };
        }
        const eligible = () => input.store.captureWorkspaceSlotOccupancy(input.getExternalProtection, { expectedRetirement: input.intent }).bindings.find((candidate) => candidate.bindingKey === input.intent.binding.bindingKey)?.protection === "eligible";
        if (!eligible())
            return { kind: "retained", reason: "protection-changed" };
        if (!fence) {
            const acquired = input.admission.acquireRetirementFence({
                // A fresh attempt after proven rejection must not revive an old permit.
                operationId: createTelegramWorkspaceAdmissionOperationId(),
                retirementIntentId: input.intent.id,
                bindingKey: binding.bindingKey,
                slot: binding.slot,
                target: binding.target,
                leaderEpoch: input.intent.leaderEpoch,
                retirementRequestedAtMs: input.intent.requestedAtMs,
            });
            if (acquired.kind === "blocked") {
                return {
                    kind: "retained",
                    reason: acquired.reason === "admission-active"
                        ? "admission-active"
                        : "fence-conflict",
                };
            }
            fence = acquired.fence;
        }
        if (!isCurrent())
            return { kind: "retained", reason: "authority-changed" };
        if (fence.phase === "fenced" && !eligible()) {
            input.admission.releaseUnissuedRetirementFence(fence);
            return { kind: "retained", reason: "protection-changed" };
        }
        if (fence.phase === "fenced") {
            const issued = input.admission.issueDeletionPermit(fence);
            if (issued.kind !== "issued") {
                return { kind: "retained", reason: "delete-unconfirmed" };
            }
            fence = issued.fence;
            try {
                await input.deleteForumTopic(issued.permit, {
                    chat_id: binding.target.chatId,
                    message_thread_id: binding.target.threadId,
                }, { maxAttempts: 1 });
            }
            catch (error) {
                if (!isTelegramWorkspaceDeletionConfirmedAbsent(error)) {
                    const target = getTelegramApiErrorRequestTarget(error);
                    if (target && sameTarget(target, binding.target) && isTelegramApiRequestRejected(error, "deleteForumTopic")) {
                        fence = input.admission.confirmRetirementRejection(fence);
                        const cancellation = await cancelRejectedTelegramWorkspaceRetirement({ ...input, isCurrent }, fence);
                        return cancellation.kind === "cancelled" ? { kind: "retained", reason: "delete-rejected" } : cancellation;
                    }
                    return { kind: "retained", reason: "delete-unconfirmed" };
                }
            }
            fence = input.admission.confirmRetirementAbsence(fence);
        }
        else if (fence.phase === "deletion-issued") {
            const absence = await input.confirmTargetAbsent?.(binding.target);
            if (absence !== "absent") {
                return { kind: "retained", reason: "delete-unconfirmed" };
            }
            fence = input.admission.confirmRetirementAbsence(fence);
        }
        if (!isCurrent())
            return { kind: "retained", reason: "authority-changed" };
        if (!eligible())
            return { kind: "retained", reason: "protection-changed" };
        if (!await input.store.commitWorkspaceRetirement(input.intent, isCurrent)) {
            return { kind: "retained", reason: "commit-rejected" };
        }
        try {
            input.admission.completeRetirementFence(fence);
        }
        catch {
            if (input.admission.read().fence) {
                return { kind: "retained", reason: "fence-release-unconfirmed" };
            }
        }
        return {
            kind: "retired",
            bindingKey: binding.bindingKey,
            slot: binding.slot,
        };
    });
}
function findEligibleCandidate(occupancy, reservedSlots, nowMs) {
    const allocation = planTelegramWorkspaceSlotAllocation({
        bindings: occupancy,
        reservedSlots,
        nowMs,
    });
    if (allocation.kind === "free") {
        return { kind: "not-needed", reason: "free-capacity" };
    }
    if (allocation.kind === "blocked")
        return allocation;
    return { kind: "candidate", candidate: allocation.candidate };
}
export async function prepareTelegramWorkspaceRetirement(deps) {
    const getNowMs = deps.getNowMs ?? Date.now;
    const leaderEpoch = deps.getLeaderEpoch();
    const profileKey = deps.getProfileKey();
    const isCurrent = () => leaderEpoch !== undefined &&
        deps.getLeaderEpoch() === leaderEpoch &&
        deps.getProfileKey() === profileKey &&
        deps.isCurrent?.() !== false;
    if (!isCurrent())
        throw new Error("Telegram Workspace retirement requires current leader authority.");
    const existing = deps.store.listWorkspaceRetirementIntents();
    if (existing.length > 1) {
        return { kind: "blocked", reason: "existing-intent-conflict" };
    }
    if (existing.length === 1) {
        const intent = existing[0];
        const binding = deps.store.listWorkspaceBindings().find((candidate) => candidate.bindingKey === intent.binding.bindingKey);
        const snapshot = deps.store.captureWorkspaceSlotOccupancy(deps.getExternalProtection, { expectedRetirement: intent });
        const candidate = snapshot.bindings.find((entry) => entry.bindingKey === intent.binding.bindingKey);
        if (intent.profileKey !== profileKey ||
            intent.leaderEpoch !== leaderEpoch ||
            !binding || !isDeepStrictEqual(binding, intent.binding) ||
            candidate?.protection !== "eligible") {
            return { kind: "blocked", reason: "stale-intent" };
        }
        if (!isCurrent())
            throw new Error("Telegram Workspace retirement lost leader authority.");
        await deps.store.persist();
        if (!isCurrent())
            throw new Error("Telegram Workspace retirement lost leader authority.");
        return { kind: "ready", intent };
    }
    const nowMs = getNowMs();
    const snapshot = deps.store.captureWorkspaceSlotOccupancy(deps.getExternalProtection);
    const selection = findEligibleCandidate(snapshot.bindings, snapshot.reservedSlots, nowMs);
    if (selection.kind !== "candidate")
        return selection;
    const selected = selection.candidate;
    const binding = deps.store.listWorkspaceBindings().find((candidate) => candidate.bindingKey === selected.bindingKey);
    if (!binding?.slot ||
        binding.slot.toLowerCase() !== selected.slot ||
        binding.inactiveSinceMs !== selected.inactiveSinceMs) {
        return { kind: "blocked", reason: "state-changed" };
    }
    const intent = {
        id: `workspace-retirement:pressure:${binding.bindingKey}:${binding.slot}:${binding.inactiveSinceMs}`,
        reason: "pressure",
        profileKey,
        binding,
        leaderEpoch: leaderEpoch,
        requestedAtMs: nowMs,
    };
    if (!isCurrent())
        throw new Error("Telegram Workspace retirement lost leader authority.");
    if (!deps.store.upsertWorkspaceRetirementIntent(intent)) {
        return { kind: "blocked", reason: "state-changed" };
    }
    const rechecked = deps.store.captureWorkspaceSlotOccupancy(deps.getExternalProtection, { expectedRetirement: intent }).bindings.find((candidate) => candidate.bindingKey === binding.bindingKey);
    if (rechecked?.protection !== "eligible" || !isCurrent()) {
        deps.store.removeWorkspaceRetirementIntent(intent);
        if (!isCurrent())
            throw new Error("Telegram Workspace retirement lost leader authority.");
        return { kind: "blocked", reason: "state-changed" };
    }
    await deps.store.persist();
    if (!isCurrent())
        throw new Error("Telegram Workspace retirement lost leader authority.");
    return { kind: "ready", intent };
}
export async function runTelegramWorkspaceRetirementLifecycle(input) {
    let intent = input.store.listWorkspaceRetirementIntents()[0];
    const retainedFence = input.admission.read().fence;
    if (retainedFence && isTelegramWorkspaceRetirementFence(retainedFence) &&
        retainedFence.phase === "deletion-rejected") {
        return input.runExclusive(() => cancelRejectedTelegramWorkspaceRetirement(input, retainedFence));
    }
    if (!intent && retainedFence && isTelegramWorkspaceRetirementFence(retainedFence) &&
        (retainedFence.destructiveKind ?? "pressure-retirement") === "pressure-retirement" &&
        retainedFence.phase === "commit-ready") {
        return input.runExclusive(async () => {
            const epoch = input.getLeaderEpoch();
            if (epoch === undefined || input.getProfileKey() !== retainedFence.profileKey ||
                input.isCurrent?.() === false)
                return { kind: "retained", reason: "authority-changed" };
            if (input.store.listWorkspaceRetirementIntents().length ||
                input.store.listWorkspaceBindings().some((binding) => binding.bindingKey === retainedFence.bindingKey)) {
                return { kind: "retained", reason: "stale-intent" };
            }
            const owner = input.admission.getOwner();
            const fence = retainedFence.leaderEpoch === epoch &&
                isDeepStrictEqual(retainedFence.owner, owner) ? retainedFence :
                input.admission.adoptRetirementFence(retainedFence, { owner, leaderEpoch: epoch });
            input.admission.completeRetirementFence(fence);
            return { kind: "retired", bindingKey: fence.bindingKey, slot: fence.slot };
        });
    }
    if (intent) {
        const adoption = await adoptTelegramWorkspaceRetirementIntent({
            store: input.store,
            intent,
            getExternalProtection: input.getExternalProtection,
            getLeaderEpoch: input.getLeaderEpoch,
            getProfileKey: input.getProfileKey,
            isCurrent: input.isCurrent,
            runExclusive: input.runExclusive,
        });
        if (adoption.kind !== "adopted") {
            return { kind: "blocked", stage: "adoption", reason: adoption.reason };
        }
        intent = adoption.intent;
    }
    else {
        const preparation = await prepareTelegramWorkspaceRetirement({
            store: input.store,
            getExternalProtection: input.getExternalProtection,
            getLeaderEpoch: input.getLeaderEpoch,
            getProfileKey: input.getProfileKey,
            isCurrent: input.isCurrent,
            getNowMs: input.getNowMs,
        });
        if (preparation.kind === "not-needed")
            return preparation;
        if (preparation.kind === "blocked") {
            return { kind: "blocked", stage: "preparation", reason: preparation.reason };
        }
        intent = preparation.intent;
    }
    return executeTelegramWorkspaceRetirement({
        store: input.store,
        intent,
        getExternalProtection: input.getExternalProtection,
        getLeaderEpoch: input.getLeaderEpoch,
        getProfileKey: input.getProfileKey,
        isCurrent: input.isCurrent,
        runExclusive: input.runExclusive,
        admission: input.admission,
        deleteForumTopic: input.deleteForumTopic,
        confirmTargetAbsent: input.confirmTargetAbsent,
    });
}
/** Retry allocation once, only after the failed operation released all ordinary leases. */
export function createTelegramWorkspaceSlotRotation(input) {
    const requests = createTelegramWorkspaceOperationGate();
    return async (operation) => {
        const admission = input.getAdmission();
        const epoch = input.getLeaderEpoch();
        if (!admission || epoch === undefined)
            return operation();
        const profileKey = admission.getProfileKey();
        const isCurrent = () => input.getLeaderEpoch() === epoch &&
            input.getAdmission()?.getProfileKey() === profileKey;
        return requests.runExclusive(async () => {
            if (!isCurrent())
                throw new Error("Telegram Workspace allocation lost leader authority.");
            const rotate = async () => {
                const result = await input.runExclusive(async () => {
                    if (!isCurrent())
                        throw new Error("Telegram Workspace rotation lost leader authority.");
                    await input.store.load();
                    if (!isCurrent())
                        throw new Error("Telegram Workspace rotation lost leader authority.");
                    return runTelegramWorkspaceRetirementLifecycle({
                        store: input.store, admission, getExternalProtection: input.getExternalProtection,
                        getLeaderEpoch: input.getLeaderEpoch, getProfileKey: () => profileKey, isCurrent,
                        // This entire lifecycle already owns the shared gate, without an admission lease.
                        runExclusive: async (action) => action(),
                        deleteForumTopic(permit, body) {
                            return input.deleteThread(() => {
                                const fence = admission.read().fence;
                                if (!isCurrent() || !fence || !isTelegramWorkspaceRetirementFence(fence) ||
                                    (fence.destructiveKind ?? "pressure-retirement") !== "pressure-retirement" ||
                                    (permit.destructiveKind ?? "pressure-retirement") !== "pressure-retirement" ||
                                    fence.phase !== "deletion-issued" ||
                                    !isDeepStrictEqual(fence.owner, admission.getOwner()) ||
                                    fence.profileKey !== permit.profileKey || fence.leaderEpoch !== permit.leaderEpoch ||
                                    fence.operationId !== permit.operationId || fence.retirementIntentId !== permit.retirementIntentId ||
                                    fence.bindingKey !== permit.bindingKey || fence.slot !== permit.slot ||
                                    fence.deletionIssuedAtMs !== permit.issuedAtMs ||
                                    !sameTarget(fence.target, permit.target) ||
                                    body.chat_id !== permit.target.chatId || body.message_thread_id !== permit.target.threadId) {
                                    throw new Error("Telegram Workspace deletion permit is stale.");
                                }
                                return { ...permit.target };
                            });
                        },
                    });
                });
                if (result.kind !== "retired" && result.kind !== "not-needed" && result.kind !== "cancelled") {
                    throw new Error(`Telegram Workspace slots A-Z are unavailable; rotation blocked (${result.reason}).`);
                }
                if (result.kind === "retired") {
                    try {
                        input.recordEvent("Telegram Workspace slot rotated.", { slot: result.slot });
                    }
                    catch { /* Diagnostics cannot turn completed retirement into another attempt. */ }
                }
                if (!isCurrent())
                    throw new Error("Telegram Workspace rotation lost leader authority.");
                return result;
            };
            const pending = await input.runExclusive(async () => {
                await input.store.load();
                if (!isCurrent())
                    throw new Error("Telegram Workspace allocation lost leader authority.");
                return input.store.listWorkspaceRetirementIntents().length > 0;
            });
            const fence = admission.read().fence;
            if (pending || (fence && isTelegramWorkspaceRetirementFence(fence) &&
                (fence.destructiveKind ?? "pressure-retirement") === "pressure-retirement")) {
                const recovered = await rotate();
                if (recovered.kind !== "cancelled")
                    return operation();
            }
            try {
                return await operation();
            }
            catch (error) {
                if (!(error instanceof TelegramWorkspaceSlotUnavailableError))
                    throw error;
                if (input.reclaimDeadOwnerQueuedWork) {
                    const candidates = await input.runExclusive(async () => {
                        await input.store.load();
                        if (!isCurrent())
                            throw new Error("Telegram Workspace reclamation lost leader authority.");
                        const snapshot = input.store.captureWorkspaceSlotOccupancy(input.getExternalProtection);
                        const allocation = planTelegramWorkspaceSlotAllocation({ ...snapshot, nowMs: Date.now() });
                        if (allocation.kind !== "blocked" || allocation.reason !== "protected-capacity")
                            return [];
                        return input.store.listWorkspaceBindings().filter((binding) => typeof binding.inactiveSinceMs === "number" &&
                            Number.isFinite(binding.inactiveSinceMs) &&
                            binding.inactiveSinceMs >= 0).sort((left, right) => left.inactiveSinceMs - right.inactiveSinceMs ||
                            (left.slot ?? "").localeCompare(right.slot ?? ""));
                    });
                    for (const binding of candidates) {
                        const evidence = input.getExternalProtection(binding);
                        if (evidence.liveOwner !== "clear" ||
                            evidence.acceptedWork !== "protected" ||
                            evidence.deliveryAuthority !== "clear")
                            continue;
                        const reclaimed = await input.reclaimDeadOwnerQueuedWork(binding, isCurrent);
                        if (reclaimed.kind === "recovered") {
                            try {
                                input.recordEvent("Telegram Workspace dead-owner queue reclaimed.", {
                                    slot: binding.slot,
                                    receipts: reclaimed.receipts,
                                    updateCount: reclaimed.updateIds.length,
                                });
                            }
                            catch { /* Diagnostics cannot revoke journal-owned recovery. */ }
                            break;
                        }
                    }
                }
                await rotate();
                return operation();
            }
        });
    };
}
