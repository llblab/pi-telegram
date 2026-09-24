/**
 * Telegram status rendering helpers
 * Zones: telegram ui, pi agent diagnostics, tui
 * Builds usage, cost, and context summaries for the interactive Telegram status view
 */
const TELEGRAM_STATUS_DEFAULT_PROFILE_NAME = "default";
const TELEGRAM_STATUS_LINE_PROVIDER_REGISTRY_KEY = "__piTelegramStatusLineProviders__";
const MAX_RECENT_TELEGRAM_RUNTIME_EVENTS = 10;
const MAX_TELEGRAM_RUNTIME_EVENT_MESSAGE_LENGTH = 1000;
const MAX_TELEGRAM_RUNTIME_EVENT_DETAIL_LENGTH = 1000;
/**
 * Project a config store into the status view without moving token-reference
 * resolution into this structural leaf domain.
 */
export function createTelegramBridgeStatusConfigGetter(source) {
    return () => {
        const config = source.get();
        return {
            ...config,
            ...(source.hasBotToken ? { botHasToken: source.hasBotToken() } : {}),
            ...(source.getBotTokenDiagnostic
                ? { botTokenDiagnostic: source.getBotTokenDiagnostic() }
                : {}),
        };
    };
}
function truncateTelegramRuntimeEventText(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.slice(0, maxLength).trimEnd()}… [truncated ${text.length - maxLength} chars]`;
}
export function redactTelegramRuntimeMessage(message, botToken) {
    const redacted = botToken
        ? message.split(botToken).join("<redacted-token>")
        : message;
    return truncateTelegramRuntimeEventText(redacted, MAX_TELEGRAM_RUNTIME_EVENT_MESSAGE_LENGTH);
}
function redactTelegramRuntimeDetail(message, botToken) {
    const redacted = botToken
        ? message.split(botToken).join("<redacted-token>")
        : message;
    return truncateTelegramRuntimeEventText(redacted, MAX_TELEGRAM_RUNTIME_EVENT_DETAIL_LENGTH);
}
function normalizeTelegramRuntimeEventDetails(details, botToken) {
    if (!details)
        return undefined;
    const normalized = {};
    for (const [key, value] of Object.entries(details)) {
        if (value === undefined)
            continue;
        if (typeof value === "string") {
            normalized[key] = redactTelegramRuntimeDetail(value, botToken);
            continue;
        }
        if (typeof value === "number" || typeof value === "boolean") {
            normalized[key] = value;
            continue;
        }
        if (value === null) {
            normalized[key] = null;
            continue;
        }
        normalized[key] = redactTelegramRuntimeDetail(String(value), botToken);
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function getTelegramRuntimeEventMessage(input) {
    if (input.message !== undefined)
        return input.message;
    if (input.error instanceof Error)
        return input.error.message;
    return String(input.error);
}
export function recordStructuredTelegramRuntimeEvent(events, input, options) {
    const details = normalizeTelegramRuntimeEventDetails(input.details, options.botToken);
    events.push({
        at: options.now ?? Date.now(),
        category: input.category,
        message: redactTelegramRuntimeMessage(getTelegramRuntimeEventMessage(input), options.botToken),
        ...(details ? { details } : {}),
    });
    while (events.length > options.maxEvents) {
        events.shift();
    }
}
function getOrCreateTelegramStatusLineProviderRegistry() {
    const existing = globalThis[TELEGRAM_STATUS_LINE_PROVIDER_REGISTRY_KEY];
    if (existing instanceof Map)
        return existing;
    const registry = new Map();
    globalThis[TELEGRAM_STATUS_LINE_PROVIDER_REGISTRY_KEY] = registry;
    return registry;
}
/**
 * Register a compact extension-provided line for the Telegram status menu.
 *
 * Providers are synchronous and should return undefined when their line is not
 * relevant for the active model. Errors are isolated so optional extension
 * status cannot break the core Telegram menu.
 */
export function registerTelegramStatusLineProvider(provider, options) {
    const registry = getOrCreateTelegramStatusLineProviderRegistry();
    registry.set(options.id, provider);
    return () => {
        if (registry.get(options.id) === provider)
            registry.delete(options.id);
    };
}
export function getTelegramStatusLineProviderResults(ctx) {
    const results = [];
    const registry = getOrCreateTelegramStatusLineProviderRegistry();
    for (const provider of registry.values()) {
        try {
            const result = provider(ctx);
            if (!result?.label || !result.value)
                continue;
            results.push(result);
        }
        catch {
            continue;
        }
    }
    return results;
}
export function clearTelegramStatusLineProviders() {
    getOrCreateTelegramStatusLineProviderRegistry().clear();
}
export function createTelegramRuntimeEventRecorder(options) {
    const events = [];
    return {
        record: (category, error, details) => {
            recordStructuredTelegramRuntimeEvent(events, { category, error, details }, {
                botToken: options.getBotToken(),
                maxEvents: options.maxEvents ?? MAX_RECENT_TELEGRAM_RUNTIME_EVENTS,
                now: options.now?.(),
            });
        },
        getEvents: () => events,
        clear: () => {
            events.length = 0;
        },
    };
}
function formatTelegramRuntimeEventCategory(event) {
    const method = event.details?.method;
    return typeof method === "string"
        ? `${event.category}:${method}`
        : event.category;
}
function formatTelegramRuntimeEventDetails(event) {
    if (!event.details)
        return "";
    const details = Object.entries(event.details)
        .filter(([key]) => key !== "method")
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    return details.length > 0 ? ` (${details.join(", ")})` : "";
}
function formatTelegramRuntimeEventSummary(event) {
    return `${formatTelegramRuntimeEventCategory(event)}: ${event.message}${formatTelegramRuntimeEventDetails(event)}`;
}
function formatTelegramRuntimeEvent(event) {
    return `${new Date(event.at).toISOString()} ${formatTelegramRuntimeEventSummary(event)}`;
}
function buildTelegramRuntimeEventSummary(events) {
    const counts = new Map();
    for (const event of events) {
        const category = formatTelegramRuntimeEventCategory(event);
        counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, count]) => `${category}=${count}`)
        .join(", ");
}
export function buildTelegramRuntimeEventLines(events) {
    if (events.length === 0)
        return ["recent runtime events: none"];
    return [
        "recent runtime events:",
        `- summary: ${buildTelegramRuntimeEventSummary(events)}`,
        ...events
            .slice()
            .reverse()
            .map((event) => `- ${formatTelegramRuntimeEvent(event)}`),
    ];
}
export function createTelegramStatusHtmlBuilder(deps) {
    return (ctx) => buildStatusHtml({ ...ctx, isCompactionInProgress: deps.isCompactionInProgress }, deps.getActiveModel(ctx), deps.getBridgeStatusLineState?.());
}
function resolveStatusBarTheme(ctx) {
    try {
        const theme = ctx.ui?.theme;
        return typeof theme?.fg === "function" ? theme : undefined;
    }
    catch {
        return undefined;
    }
}
export function createTelegramStatusRuntime(deps) {
    const statusKey = deps.statusKey ?? "telegram";
    return {
        updateStatus: (ctx, error) => {
            const theme = resolveStatusBarTheme(ctx);
            if (!theme)
                return;
            ctx.ui.setStatus(statusKey, buildTelegramStatusBarText(theme, deps.getStatusBarState(ctx, error)));
        },
        getStatusLines: (options) => buildTelegramBridgeStatusLines(deps.getBridgeStatusLineState(), options),
        getStatusState: deps.getBridgeStatusLineState,
    };
}
export function createTelegramBridgeStatusRuntime(deps) {
    return createTelegramStatusRuntime({
        statusKey: deps.statusKey,
        getStatusBarState: (_ctx, error) => {
            const config = deps.getConfig();
            const queuedItems = deps.getQueuedItems();
            const hasPendingDispatch = deps.hasDispatchPending();
            const waitingItems = hasPendingDispatch ? queuedItems.slice(1) : queuedItems;
            const queuedItemCount = deps.getQueuedItemCount?.(waitingItems) ?? waitingItems.length;
            const hasActiveTurn = deps.hasActiveTurn();
            const hasPendingModelSwitch = deps.hasPendingModelSwitch();
            const activeToolExecutions = deps.getActiveToolExecutions();
            const compactionInProgress = deps.isCompactionInProgress();
            const localBus = deps.getLocalBus?.();
            return {
                hasBotToken: config.botHasToken ?? Boolean(config.botToken),
                pollingActive: deps.isPollingActive(),
                paired: !!config.allowedUserId,
                busRole: deps.getBusRole?.(),
                followerRegistered: localBus?.followerRegistered,
                busLifecyclePhase: deps.getBusLifecyclePhase?.(),
                instanceSlot: deps.getInstanceSlot?.(),
                instanceThreadName: deps.getInstanceThreadName?.(),
                compactionInProgress,
                processing: hasActiveTurn ||
                    hasPendingDispatch ||
                    hasPendingModelSwitch ||
                    activeToolExecutions > 0 ||
                    queuedItemCount > 0,
                processingStatus: getTelegramStatusBarProcessingStatus({
                    hasActiveTurn,
                    hasPendingDispatch,
                    hasPendingModelSwitch,
                    activeToolExecutions,
                    queuedItems: queuedItemCount,
                }),
                queuedStatus: queuedItemCount > 0 ? ` +${queuedItemCount}` : "",
                pollingStopReason: deps.getPollingState?.().stopReason,
                error,
            };
        },
        getBridgeStatusLineState: () => {
            const config = deps.getConfig();
            const botThreadMode = deps.getBotThreadMode?.();
            const activeProfileName = deps.getActiveProfileName
                ? (deps.getActiveProfileName() ?? TELEGRAM_STATUS_DEFAULT_PROFILE_NAME)
                : undefined;
            return {
                hasBotToken: config.botHasToken ?? Boolean(config.botToken),
                botUsername: config.botUsername,
                botTokenDiagnostic: config.botTokenDiagnostic,
                activeProfileName,
                diagnosticPaths: deps.getDiagnosticPaths?.(activeProfileName),
                allowedUserId: config.allowedUserId,
                botThreadMode: botThreadMode?.threadMode,
                botThreadModeUpdatedAtMs: botThreadMode?.updatedAtMs,
                botThreadModeAction: botThreadMode?.lastReconcileAction,
                busRole: deps.getBusRole?.(),
                busProtocol: deps.getBusProtocol?.(),
                busLifecyclePhase: deps.getBusLifecyclePhase?.(),
                instanceSlot: deps.getInstanceSlot?.(),
                instanceThreadName: deps.getInstanceThreadName?.(),
                lockState: deps.getRuntimeLockState?.(),
                pollingActive: deps.isPollingActive(),
                ...(deps.getPollingState
                    ? { polling: deps.getPollingState() }
                    : {}),
                ...(deps.getInboundWorkerState
                    ? { inboundWorker: deps.getInboundWorkerState() }
                    : {}),
                lastUpdateId: deps.getAcceptedThroughUpdateId?.(),
                activeSourceMessageIds: deps.getActiveSourceMessageIds(),
                pendingDispatch: deps.hasDispatchPending(),
                compactionInProgress: deps.isCompactionInProgress(),
                activeToolExecutions: deps.getActiveToolExecutions(),
                pendingModelSwitch: deps.hasPendingModelSwitch(),
                queuedItems: deps.getQueuedItems(),
                busFollowers: deps.getBusFollowers?.(),
                localBus: deps.getLocalBus?.(),
                topicTargets: deps.getTopicTargets?.(),
                threadReservations: deps.getThreadReservations?.(),
                topicSyncObservations: deps.getTopicSyncObservations?.(),
                syncState: deps.getSyncState?.(),
                threadReconciliation: deps.getThreadReconciliationState?.(),
                busNowMs: deps.getNowMs?.(),
                recentRuntimeEvents: deps.getRecentRuntimeEvents(),
            };
        },
    });
}
export function createTelegramRuntimeLogScope(input) {
    return {
        instanceId: input.instanceId,
        role: input.state.busRole ?? "classic-or-disconnected",
        slot: input.state.instanceSlot,
        threadName: input.state.instanceThreadName,
        lockState: input.state.lockState,
    };
}
export function createTelegramStatusSnapshot(state) {
    return {
        runtime: {
            busRole: state.busRole,
            ...(state.busLifecyclePhase
                ? { busLifecyclePhase: state.busLifecyclePhase }
                : {}),
            botThreadMode: state.botThreadMode,
            botThreadModeUpdatedAtMs: state.botThreadModeUpdatedAtMs,
            botThreadModeAction: state.botThreadModeAction,
            instanceSlot: state.instanceSlot,
            instanceThreadName: state.instanceThreadName,
            pollingActive: state.pollingActive,
            ...(state.polling ? { polling: state.polling } : {}),
            lockState: state.lockState,
        },
        liveRoster: {
            busFollowers: state.busFollowers ?? [],
            ...(state.localBus ? { localBus: state.localBus } : {}),
            topicTargets: state.topicTargets ?? [],
            reservations: state.threadReservations ?? [],
            syncObservations: state.topicSyncObservations ?? [],
        },
        diagnostics: {
            pendingDispatch: state.pendingDispatch,
            compactionInProgress: state.compactionInProgress,
            activeToolExecutions: state.activeToolExecutions,
            pendingModelSwitch: state.pendingModelSwitch,
            syncState: state.syncState,
            threadReconciliation: state.threadReconciliation,
            recentRuntimeEvents: state.recentRuntimeEvents,
        },
    };
}
const TELEGRAM_DIAGNOSTICS_SNAPSHOT_COALESCE_MS = 100;
export function createTelegramRuntimeDiagnosticsSnapshotScheduler(deps) {
    const setTimer = deps.setTimer ?? setTimeout;
    let timer;
    let persistPromise;
    let pending = false;
    const recordError = (error) => {
        try {
            deps.recordError(error);
        }
        catch {
            // Snapshot diagnostics cannot create an unhandled scheduler rejection.
        }
    };
    const request = () => {
        if (timer || persistPromise) {
            pending = true;
            return;
        }
        timer = setTimer(() => {
            timer = undefined;
            let tracked;
            tracked = Promise.resolve()
                .then(deps.persistSnapshot)
                .catch(recordError)
                .finally(() => {
                if (persistPromise !== tracked)
                    return;
                persistPromise = undefined;
                if (pending) {
                    pending = false;
                    request();
                }
            });
            persistPromise = tracked;
        }, TELEGRAM_DIAGNOSTICS_SNAPSHOT_COALESCE_MS);
        if (typeof timer !== "number")
            timer?.unref?.();
    };
    return request;
}
export function getTelegramStatusBarProcessingStatus(state) {
    if (state.hasPendingModelSwitch)
        return "model";
    if (state.hasActiveTurn || state.activeToolExecutions > 0)
        return "active";
    if (state.hasPendingDispatch)
        return "dispatching";
    if (state.queuedItems > 0)
        return "queued";
    return undefined;
}
function getTelegramStatusBarLabel(state) {
    const threadName = state.instanceThreadName?.trim();
    if (!threadName)
        return "telegram";
    const genericLabels = new Set(["telegram", "leader", "follower"]);
    if (genericLabels.has(threadName.toLowerCase()))
        return "telegram";
    return threadName;
}
export function buildTelegramStatusBarText(theme, state) {
    const label = theme.fg("accent", getTelegramStatusBarLabel(state));
    const queued = state.queuedStatus
        ? theme.fg("warning", state.queuedStatus)
        : "";
    if (!state.hasBotToken)
        return `${label} ${theme.fg("muted", "not configured")}${queued}`;
    if (state.pollingStopReason === "persistent-conflict" && state.busRole !== "follower")
        return `${label} ${theme.fg("error", "error")}`;
    if (!state.paired)
        return `${label} ${theme.fg("warning", "awaiting pairing")}${queued}`;
    if (state.busLifecyclePhase === "electing")
        return `${label} ${theme.fg("warning", "electing")}${queued}`;
    if (!state.pollingActive && state.busRole !== "follower")
        return `${theme.fg("accent", "telegram")} ${theme.fg("dim", "disconnected")}${queued}`;
    if (state.error) {
        return `${label} ${theme.fg("error", "error")}${queued}`;
    }
    if (state.busRole === "follower" && state.followerRegistered === false) {
        return `${label} ${theme.fg("warning", "reconnecting")}${queued}`;
    }
    if (state.busRole === "follower")
        return `${label} ${theme.fg("success", "follower")}${queued}`;
    if (state.busRole === "leader")
        return `${label} ${theme.fg("success", "leader")}${queued}`;
    return `${label} ${theme.fg("success", "connected")}${queued}`;
}
function formatTelegramBridgeBotStatus(state) {
    if (state.botUsername)
        return `@${state.botUsername}`;
    if (state.hasBotToken)
        return "unknown";
    return state.botTokenDiagnostic ?? "not configured";
}
function formatTelegramStatusTarget(target) {
    if (!target)
        return "";
    return target.threadId === undefined
        ? ` target ${target.chatId}`
        : ` target ${target.chatId}:${target.threadId}`;
}
function formatTelegramThreadStatusLabel(input) {
    const threadName = input.threadName?.trim();
    if (threadName)
        return threadName;
    return input.slot ? `[${input.slot}]` : "";
}
function formatTelegramBusProtocolIdentity(protocol) {
    if (!protocol)
        return "";
    const capabilities = protocol.capabilities.length > 0
        ? ` capabilities=${protocol.capabilities.join(",")}`
        : " capabilities=none";
    return ` protocol=v${protocol.protocolVersion} build=${protocol.runtimeBuild}${capabilities}`;
}
function buildTelegramBusFollowerLines(state) {
    const followers = state.busFollowers ?? [];
    if (followers.length === 0)
        return [];
    const nowMs = state.busNowMs ?? Date.now();
    return [
        "",
        "bus:",
        `- followers: ${followers.length}`,
        ...followers.map((follower) => {
            const ageSeconds = Math.max(0, Math.round((nowMs - follower.lastHeartbeatMs) / 1000));
            const label = formatTelegramThreadStatusLabel(follower);
            const labelSuffix = label ? ` ${label}` : "";
            const statusLabel = follower.status ? ` (${follower.status})` : "";
            const cwd = follower.cwd ? ` ${follower.cwd}` : "";
            const target = formatTelegramStatusTarget(follower.target);
            const protocol = formatTelegramBusProtocolIdentity(follower.protocol);
            return `- ${follower.instanceId}:${labelSuffix} heartbeat ${ageSeconds}s ago${statusLabel}${target}${cwd}${protocol}`;
        }),
    ];
}
function buildTelegramLocalBusLines(state, options = {}) {
    const localBus = state.localBus;
    if (!localBus)
        return [];
    const target = formatTelegramStatusTarget(localBus.followerTarget);
    const label = formatTelegramThreadStatusLabel({
        slot: localBus.followerSlot,
        threadName: localBus.followerThreadName,
    });
    const protocol = formatTelegramBusProtocolIdentity(localBus.leaderProtocol);
    const followerLine = `- follower registered: ${localBus.followerRegistered ? "yes" : "no"}${label ? ` ${label}` : ""}${target}${protocol}`;
    const lines = ["", "local bus:", followerLine];
    if (options.verbose) {
        if (localBus.leaderSocketPath) {
            const transport = localBus.leaderTransport
                ? ` [${localBus.leaderTransport}]`
                : "";
            lines.push(`- leader endpoint${transport}: ${localBus.leaderSocketPath}`);
        }
        if (localBus.followerSocketPath) {
            const transport = localBus.followerTransport
                ? ` [${localBus.followerTransport}]`
                : "";
            lines.push(`- follower endpoint${transport}: ${localBus.followerSocketPath}`);
        }
    }
    return lines;
}
function buildTelegramSyncSliceLines(state) {
    const syncState = state.syncState;
    if (!syncState || Object.keys(syncState).length === 0)
        return [];
    return [
        "sync:",
        ...Object.entries(syncState).map(([slice, value]) => {
            const status = value?.status ?? "unknown";
            const action = value?.lastReconcileAction
                ? ` reconcile=${value.lastReconcileAction}`
                : "";
            const reason = value?.reason ? ` reason=${value.reason}` : "";
            return `- ${slice}: ${status}${action}${reason}`;
        }),
    ];
}
function buildTelegramThreadReconciliationLines(state) {
    const reconciliation = state.threadReconciliation;
    if (!reconciliation)
        return [];
    const epoch = reconciliation.leaderEpoch !== undefined
        ? ` epoch=${reconciliation.leaderEpoch}`
        : "";
    return [
        "reconciliation:",
        `- phase: ${reconciliation.phase} event=${reconciliation.event}${epoch}`,
        `- counts: pending=${reconciliation.pendingProvisionCount}, sync=${reconciliation.syncActionCount}, cleanup=${reconciliation.cleanupActionCount}`,
    ];
}
function buildTelegramTopicTargetDiagnosticLines(state) {
    const activeTargets = (state.topicTargets ?? []).filter((record) => !!record.instanceId &&
        (record.status === "active" || record.status === "starting"));
    const reservations = state.threadReservations ?? [];
    const observations = state.topicSyncObservations ?? [];
    if (activeTargets.length === 0 &&
        reservations.length === 0 &&
        observations.length === 0)
        return [];
    const byInstance = new Map();
    for (const record of activeTargets) {
        const key = record.instanceId;
        if (!key)
            continue;
        const records = byInstance.get(key) ?? [];
        records.push(record);
        byInstance.set(key, records);
    }
    const duplicateLines = Array.from(byInstance.entries())
        .filter(([, records]) => records.length > 1)
        .map(([instanceId, records]) => {
        const targets = records
            .map((record) => {
            const label = formatTelegramThreadStatusLabel(record);
            return `${label}${formatTelegramStatusTarget(record.target) || " unknown"}`.trim();
        })
            .join(", ");
        return `- duplicate ${instanceId}: ${records.length} active threads ${targets}`;
    });
    const twinLines = activeTargets.map((record) => {
        const label = formatTelegramThreadStatusLabel(record);
        const target = formatTelegramStatusTarget(record.target) || " unknown";
        const sync = record.syncStatus ? ` sync=${record.syncStatus}` : "";
        const observed = record.lastSyncObservedAtMs
            ? ` observed=${new Date(record.lastSyncObservedAtMs).toISOString()}`
            : "";
        const probe = record.lastSyncProbeAtMs
            ? ` probed=${new Date(record.lastSyncProbeAtMs).toISOString()}`
            : "";
        const error = record.lastSyncError
            ? ` syncError=${record.lastSyncError}`
            : "";
        const action = record.lastReconcileAction
            ? ` reconcile=${record.lastReconcileAction}`
            : "";
        return `- ${label}${target}${sync}${observed}${probe}${error}${action}`.trim();
    });
    const reservationLines = reservations.map((reservation) => {
        const slot = reservation.slot ? `[${reservation.slot}]` : "";
        const target = formatTelegramStatusTarget(reservation.target) || " unknown";
        const reason = reservation.reason ? ` reason=${reservation.reason}` : "";
        const instance = reservation.instanceId
            ? ` instance=${reservation.instanceId}`
            : "";
        const action = reservation.lastReconcileAction
            ? ` reconcile=${reservation.lastReconcileAction}`
            : "";
        return `- reservation ${slot}${target}${reason}${instance}${action}`.trim();
    });
    const observationLines = observations.map((observation) => {
        const slot = observation.slot ? `[${observation.slot}]` : "";
        const target = formatTelegramStatusTarget(observation.target) || " unknown";
        const observed = ` observed=${new Date(observation.observedAtMs).toISOString()}`;
        const instance = observation.instanceId
            ? ` instance=${observation.instanceId}`
            : "";
        const error = observation.lastSyncError
            ? ` syncError=${observation.lastSyncError}`
            : "";
        const action = observation.lastReconcileAction
            ? ` reconcile=${observation.lastReconcileAction}`
            : "";
        return `- sync ${slot}${target} sync=${observation.syncStatus}${observed}${instance}${error}${action}`.trim();
    });
    return [
        "topics:",
        `- active bindings: instances=${byInstance.size}, targets=${activeTargets.length}`,
        ...duplicateLines,
        ...twinLines,
        ...reservationLines,
        ...observationLines,
    ];
}
function buildTelegramBridgeCompactThreadLines(state) {
    const activeTargets = (state.topicTargets ?? []).filter((record) => !!record.instanceId &&
        (record.status === "active" || record.status === "starting"));
    const activeLabels = activeTargets
        .map(formatTelegramThreadStatusLabel)
        .filter((label) => label.length > 0);
    const followers = state.busFollowers ?? [];
    const reservations = state.threadReservations ?? [];
    const observations = state.topicSyncObservations ?? [];
    if (activeLabels.length === 0 &&
        followers.length === 0 &&
        reservations.length === 0 &&
        observations.length === 0) {
        return [];
    }
    const lines = ["threads:"];
    if (activeLabels.length > 0)
        lines.push(`- active: ${activeLabels.join(", ")}`);
    if (followers.length > 0)
        lines.push(`- followers: ${followers.length}`);
    if (reservations.length > 0)
        lines.push(`- reserved: ${reservations.length}`);
    const syncIssueCount = observations.filter((observation) => observation.syncStatus !== "open").length;
    if (syncIssueCount > 0)
        lines.push(`- sync issues: ${syncIssueCount}`);
    return lines;
}
function formatTelegramPollingLifecycle(state) {
    const lifecycle = state.pollingActive ? "running" : "stopped";
    if (!state.polling)
        return lifecycle;
    if (state.pollingActive)
        return `${lifecycle} (${state.polling.phase})`;
    return state.polling.stopReason
        ? `${lifecycle} (${state.polling.stopReason})`
        : lifecycle;
}
function buildTelegramPollingDiagnosticLines(polling) {
    if (!polling)
        return [];
    return [
        `- phase: ${polling.phase}`,
        ...(polling.phaseStartedAtMs !== undefined
            ? [
                `- phase started: ${new Date(polling.phaseStartedAtMs).toISOString()}`,
            ]
            : []),
        ...(polling.currentUpdateId !== undefined
            ? [`- current update id: ${polling.currentUpdateId}`]
            : []),
        ...(polling.lastSuccessfulResponseAtMs !== undefined
            ? [
                `- last successful response: ${new Date(polling.lastSuccessfulResponseAtMs).toISOString()} (updates=${polling.lastSuccessfulResponseUpdateCount ?? "unknown"})`,
            ]
            : []),
        ...(polling.startedAtMs !== undefined
            ? [`- started: ${new Date(polling.startedAtMs).toISOString()}`]
            : []),
        ...(polling.stoppedAtMs !== undefined
            ? [`- stopped: ${new Date(polling.stoppedAtMs).toISOString()}`]
            : []),
        ...(polling.stopReason ? [`- stop reason: ${polling.stopReason}`] : []),
    ];
}
function formatTelegramInboundWorkerState(worker) {
    if (!worker)
        return "not started";
    const depth = worker.journalEntryCount;
    return `${worker.phase} (depth=${depth}, queued=${worker.queuedClaimCount}, foreign=${worker.foreignQueuedCount}, deferred=${worker.deferredClaimCount}, retry=${worker.retryWaitCount}, failed=${worker.failedCount})`;
}
function buildTelegramInboundWorkerDiagnosticLines(worker) {
    if (!worker)
        return ["- state: not started"];
    return [
        `- state: ${worker.phase}`,
        `- generation: ${worker.generation}`,
        ...(worker.phaseStartedAtMs !== undefined
            ? [`- phase started: ${new Date(worker.phaseStartedAtMs).toISOString()}`]
            : []),
        `- journal: entries=${worker.journalEntryCount}, bytes=${worker.journalSerializedBytes}`,
        `- claims: queued=${worker.queuedClaimCount}, foreign-queued=${worker.foreignQueuedCount}, deferred=${worker.deferredClaimCount}, unsettled=${worker.unsettledExecutionCount}`,
        ...(worker.foreignQueuedOwner
            ? [
                `- queued semantic owner: instance=${worker.foreignQueuedOwner.instanceId}, pid=${worker.foreignQueuedOwner.processId}, birth=${worker.foreignQueuedOwner.processBirthId}, session=${worker.foreignQueuedOwner.sessionGeneration}, acquisition=${worker.foreignQueuedOwner.acquisitionId}, liveness=${worker.foreignQueuedOwnerLiveness ?? "unknown"}`,
            ]
            : []),
        `- failures: retry-wait=${worker.retryWaitCount}, terminal=${worker.failedCount}`,
        ...(worker.currentUpdateId !== undefined
            ? [`- current update id: ${worker.currentUpdateId}`]
            : []),
        ...(worker.nextRetryUpdateId !== undefined
            ? [
                `- next retry: update=${worker.nextRetryUpdateId}, attempt=${worker.nextRetryAttemptCount ?? "unknown"}, class=${worker.nextRetryFailureClass ?? "unknown"}${worker.nextRetryAtMs !== undefined ? ` at ${new Date(worker.nextRetryAtMs).toISOString()}` : ""}`,
            ]
            : []),
        ...(worker.failedUpdateId !== undefined
            ? [
                `- terminal update: id=${worker.failedUpdateId}, failure=${worker.failedFailureId ?? "unknown"}, attempts=${worker.failedAttemptCount ?? "unknown"}, class=${worker.failedClass ?? "unknown"}${worker.terminalFailureAtMs !== undefined ? ` at ${new Date(worker.terminalFailureAtMs).toISOString()}` : ""}`,
                ...(worker.failedSummary
                    ? [`- terminal summary: ${worker.failedSummary}`]
                    : []),
            ]
            : []),
        ...(worker.oldestAdmittedAtMs !== undefined
            ? [
                `- oldest admitted: ${new Date(worker.oldestAdmittedAtMs).toISOString()}`,
            ]
            : []),
        ...(worker.blockedReason
            ? [`- blocked reason: ${worker.blockedReason}`]
            : []),
        ...(worker.blockedInputCustody
            ? [`- blocked input custody: update=${worker.blockedInputCustody.updateId}, kind=${worker.blockedInputCustody.kind}`]
            : []),
        ...(worker.lastCompletedUpdateId !== undefined
            ? [
                `- last completed: ${worker.lastCompletedUpdateId}${worker.lastCompletedAtMs !== undefined ? ` at ${new Date(worker.lastCompletedAtMs).toISOString()}` : ""}`,
            ]
            : []),
        ...(worker.lastFailurePhase
            ? [
                `- last failure: ${worker.lastFailurePhase}${worker.lastFailureAtMs !== undefined ? ` at ${new Date(worker.lastFailureAtMs).toISOString()}` : ""}`,
            ]
            : []),
    ];
}
function buildTelegramBridgeCompactStatusLines(state) {
    const controlQueueCount = state.queuedItems.filter((item) => item.queueLane === "control").length;
    const priorityQueueCount = state.queuedItems.filter((item) => item.queueLane === "priority").length;
    const defaultQueueCount = state.queuedItems.filter((item) => item.queueLane === "default").length;
    const queueLine = `- queued turns: ${state.queuedItems.length}${state.queuedItems.length > 0
        ? ` (control=${controlQueueCount}, priority=${priorityQueueCount}, default=${defaultQueueCount})`
        : ""}`;
    const executionState = state.pendingDispatch
        ? "pending dispatch"
        : state.activeSourceMessageIds?.length
            ? "active"
            : "idle";
    const diagnosticsProfileName = state.activeProfileName === TELEGRAM_STATUS_DEFAULT_PROFILE_NAME
        ? undefined
        : state.activeProfileName;
    const profileSuffix = diagnosticsProfileName
        ? `.${diagnosticsProfileName.replace(/[^a-zA-Z0-9._-]+/g, "_")}`
        : "";
    const diagnosticsPaths = state.diagnosticPaths ?? {
        state: `~/.pi/agent/tmp/telegram/state${profileSuffix}.json`,
        logs: `~/.pi/agent/tmp/telegram/logs${profileSuffix}.jsonl`,
    };
    return [
        "connection:",
        `- bot: ${formatTelegramBridgeBotStatus(state)}`,
        ...(state.activeProfileName
            ? [`- profile: ${state.activeProfileName}`]
            : []),
        `- user: ${state.allowedUserId ?? "not paired"}`,
        ...(state.botThreadMode ? [`- thread mode: ${state.botThreadMode}`] : []),
        ...(state.busRole ? [`- role: ${state.busRole}`] : []),
        ...(state.busLifecyclePhase
            ? [`- lifecycle: ${state.busLifecyclePhase}`]
            : []),
        ...(state.instanceThreadName || state.instanceSlot
            ? [`- instance: ${state.instanceThreadName ?? state.instanceSlot}`]
            : []),
        ...(state.lockState ? [`- owner: ${state.lockState}`] : []),
        "",
        "health:",
        `- polling: ${formatTelegramPollingLifecycle(state)}`,
        ...(state.inboundWorker
            ? [
                `- inbound worker: ${formatTelegramInboundWorkerState(state.inboundWorker)}`,
            ]
            : []),
        `- state: ${executionState}`,
        queueLine,
        ...(state.activeToolExecutions > 0
            ? [`- active tools: ${state.activeToolExecutions}`]
            : []),
        ...(state.pendingModelSwitch ? ["- pending model switch: yes"] : []),
        ...buildTelegramBridgeCompactThreadLines(state),
        ...buildTelegramBusFollowerLines(state),
        ...buildTelegramLocalBusLines(state),
        ...buildTelegramThreadReconciliationLines(state),
        "",
        "diagnostics:",
        `- state: ${diagnosticsPaths.state}`,
        `- logs: ${diagnosticsPaths.logs}`,
        "- full dump: /telegram-status --debug",
    ];
}
export function buildTelegramBridgeStatusLines(state, options = {}) {
    if (options.verbose)
        return buildTelegramBridgeDiagnosticStatusLines(state);
    return buildTelegramBridgeCompactStatusLines(state);
}
export function buildTelegramBridgeDiagnosticStatusLines(state) {
    const controlQueueCount = state.queuedItems.filter((item) => item.queueLane === "control").length;
    const priorityQueueCount = state.queuedItems.filter((item) => item.queueLane === "priority").length;
    const defaultQueueCount = state.queuedItems.filter((item) => item.queueLane === "default").length;
    return [
        "connection:",
        `- bot: ${formatTelegramBridgeBotStatus(state)}`,
        ...(state.activeProfileName
            ? [`- profile: ${state.activeProfileName}`]
            : []),
        `- allowed user: ${state.allowedUserId ?? "not paired"}`,
        ...(state.botThreadMode
            ? [
                `- thread mode: ${state.botThreadMode}${state.botThreadModeAction ? ` reconcile=${state.botThreadModeAction}` : ""}`,
            ]
            : []),
        ...(state.busRole ? [`- bus role: ${state.busRole}`] : []),
        ...(state.busProtocol
            ? [`- bus${formatTelegramBusProtocolIdentity(state.busProtocol)}`]
            : []),
        ...(state.busLifecyclePhase
            ? [`- bus lifecycle: ${state.busLifecyclePhase}`]
            : []),
        ...(state.instanceThreadName || state.instanceSlot
            ? [`- instance: ${state.instanceThreadName ?? state.instanceSlot}`]
            : []),
        ...(state.lockState ? [`- owner: ${state.lockState}`] : []),
        "",
        "polling:",
        `- state: ${formatTelegramPollingLifecycle(state)}`,
        ...buildTelegramPollingDiagnosticLines(state.polling),
        `- last update id: ${state.lastUpdateId ?? "none"}`,
        "",
        ...(state.inboundWorker
            ? [
                "inbound worker:",
                ...buildTelegramInboundWorkerDiagnosticLines(state.inboundWorker),
                "",
            ]
            : []),
        "execution:",
        `- active turn: ${state.activeSourceMessageIds?.join(",") || "no"}`,
        `- pending dispatch: ${state.pendingDispatch ? "yes" : "no"}`,
        `- compaction: ${state.compactionInProgress ? "running" : "idle"}`,
        `- active tools: ${state.activeToolExecutions}`,
        `- pending model switch: ${state.pendingModelSwitch ? "yes" : "no"}`,
        "",
        "queue:",
        `- queued turns: ${state.queuedItems.length}`,
        `- lanes: control=${controlQueueCount}, priority=${priorityQueueCount}, default=${defaultQueueCount}`,
        ...buildTelegramBusFollowerLines(state),
        ...buildTelegramLocalBusLines(state, { verbose: true }),
        ...buildTelegramTopicTargetDiagnosticLines(state),
        ...buildTelegramThreadReconciliationLines(state),
        ...buildTelegramSyncSliceLines(state),
        "",
        ...buildTelegramRuntimeEventLines(state.recentRuntimeEvents),
    ];
}
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    if (count < 10000000)
        return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}
function collectUsageStats(ctx) {
    const stats = {
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalCost: 0,
    };
    for (const entry of ctx.sessionManager.getEntries()) {
        const usage = entry.message?.usage;
        if (entry.type !== "message" ||
            entry.message?.role !== "assistant" ||
            !usage) {
            continue;
        }
        stats.totalInput += usage.input;
        stats.totalOutput += usage.output;
        stats.totalCacheRead += usage.cacheRead;
        stats.totalCacheWrite += usage.cacheWrite;
        stats.totalCost += usage.cost.total;
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        stats.latestCacheHitRate =
            promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
    }
    return stats;
}
function formatStatusRowLabel(label) {
    if (!label)
        return label;
    return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`;
}
function buildStatusRow(label, value) {
    return `<b>${escapeHtml(formatStatusRowLabel(label))}:</b> <code>${escapeHtml(value)}</code>`;
}
function buildUsageSummary(stats) {
    const tokenParts = [];
    if (stats.totalInput)
        tokenParts.push(`↑${formatTokens(stats.totalInput)}`);
    if (stats.totalOutput)
        tokenParts.push(`↓${formatTokens(stats.totalOutput)}`);
    return tokenParts.length > 0 ? tokenParts.join(" ") : undefined;
}
function buildCacheSummary(stats) {
    const cacheParts = [];
    if (stats.totalCacheRead)
        cacheParts.push(`R${formatTokens(stats.totalCacheRead)}`);
    if (stats.totalCacheWrite)
        cacheParts.push(`W${formatTokens(stats.totalCacheWrite)}`);
    if ((stats.totalCacheRead > 0 || stats.totalCacheWrite > 0) &&
        stats.latestCacheHitRate !== undefined) {
        cacheParts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
    }
    return cacheParts.length > 0 ? cacheParts.join(" ") : undefined;
}
function buildCostSummary(stats, usesSubscription) {
    if (!stats.totalCost && !usesSubscription)
        return undefined;
    return `$${stats.totalCost.toFixed(3)}${usesSubscription ? " (sub)" : ""}`;
}
function buildContextSummary(ctx, activeModel) {
    const usage = ctx.getContextUsage();
    if (!usage)
        return "unknown";
    const contextWindow = usage.contextWindow ?? activeModel?.contextWindow ?? 0;
    const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
    return `${percent}/${formatTokens(contextWindow)}`;
}
function buildStatusSummary(ctx) {
    if (ctx.isCompactionInProgress?.())
        return "compacting";
    if (ctx.hasPendingMessages?.())
        return "pending";
    if (ctx.isIdle?.() === false)
        return "active";
    if (ctx.isIdle?.() === true)
        return "idle";
    return "unknown";
}
function buildTelegramStatusRoleSuffix(state) {
    if (state?.botThreadMode !== "enabled" || !state.busRole)
        return "";
    return ` @${state.busRole}`;
}
export function buildStatusHtml(ctx, activeModel, bridgeStatus) {
    const stats = collectUsageStats(ctx);
    const usesSubscription = activeModel
        ? ctx.modelRegistry.isUsingOAuth(activeModel)
        : false;
    const lines = [
        buildStatusRow("Status", `${buildStatusSummary(ctx)}${buildTelegramStatusRoleSuffix(bridgeStatus)}`),
    ];
    const usageSummary = buildUsageSummary(stats);
    const cacheSummary = buildCacheSummary(stats);
    const costSummary = buildCostSummary(stats, usesSubscription);
    if (usageSummary) {
        lines.push(buildStatusRow("Tokens", usageSummary));
    }
    if (cacheSummary) {
        lines.push(buildStatusRow("Cache", cacheSummary));
    }
    if (costSummary) {
        lines.push(buildStatusRow("Cost", costSummary));
    }
    lines.push(buildStatusRow("Context", buildContextSummary(ctx, activeModel)));
    for (const row of getTelegramStatusLineProviderResults({ activeModel })) {
        lines.push(buildStatusRow(row.label, row.value));
    }
    return lines.join("\n");
}
