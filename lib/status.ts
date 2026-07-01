/**
 * Telegram status rendering helpers
 * Zones: telegram ui, pi agent diagnostics, tui
 * Builds usage, cost, and context summaries for the interactive Telegram status view
 */

export type TelegramStatusQueueLane = "control" | "priority" | "default";

export interface TelegramUsageStats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
}

interface TelegramUsageMessage {
  role: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
}

interface TelegramStatusSessionEntry {
  type: string;
  message?: TelegramUsageMessage;
}

interface TelegramContextUsage {
  contextWindow?: number;
  percent: number | null;
}

export interface TelegramStatusActiveModel {
  provider?: string;
  id?: string;
  contextWindow?: number;
}

export interface TelegramStatusLineProviderContext {
  activeModel: TelegramStatusActiveModel | undefined;
}

export interface TelegramStatusLineProviderResult {
  label: string;
  value: string;
}

export type TelegramStatusLineProvider = (
  ctx: TelegramStatusLineProviderContext,
) => TelegramStatusLineProviderResult | undefined;

export interface TelegramStatusContext {
  sessionManager: { getEntries(): TelegramStatusSessionEntry[] };
  getContextUsage(): TelegramContextUsage | undefined;
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  isCompactionInProgress?: () => boolean;
  modelRegistry: {
    isUsingOAuth(model: TelegramStatusActiveModel): boolean;
  };
}

export type TelegramRuntimeEventDetailValue = string | number | boolean | null;

const TELEGRAM_STATUS_LINE_PROVIDER_REGISTRY_KEY =
  "__piTelegramStatusLineProviders__";
const MAX_RECENT_TELEGRAM_RUNTIME_EVENTS = 10;
const MAX_TELEGRAM_RUNTIME_EVENT_MESSAGE_LENGTH = 1000;
const MAX_TELEGRAM_RUNTIME_EVENT_DETAIL_LENGTH = 1000;

export interface TelegramRuntimeEvent {
  at: number;
  category: string;
  message: string;
  details?: Record<string, TelegramRuntimeEventDetailValue>;
}

export interface TelegramRuntimeEventInput {
  category: string;
  error?: unknown;
  message?: string;
  details?: Record<string, unknown>;
}

export interface TelegramRuntimeEventRecorder {
  record: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getEvents: () => TelegramRuntimeEvent[];
  clear: () => void;
}

export interface TelegramRuntimeEventRecorderOptions {
  getBotToken: () => string | undefined;
  maxEvents?: number;
  now?: () => number;
}

export interface TelegramBridgeStatusBusFollower {
  instanceId: string;
  cwd?: string;
  lastHeartbeatMs: number;
  target?: { chatId: number; threadId?: number };
  slot?: string;
  threadName?: string;
  status?: string;
}

export interface TelegramBridgeStatusLocalBus {
  leaderSocketPath?: string;
  leaderTransport?: "pipe" | "socket";
  followerSocketPath?: string;
  followerTransport?: "pipe" | "socket";
  followerRegistered?: boolean;
  followerTarget?: { chatId: number; threadId?: number };
  followerSlot?: string;
  followerThreadName?: string;
}

export interface TelegramBridgeStatusTopicTarget {
  instanceId?: string;
  status?: string;
  target?: { chatId: number; threadId?: number };
  slot?: string;
  threadName?: string;
  syncStatus?: string;
  lastSyncObservedAtMs?: number;
  lastSyncProbeAtMs?: number;
  lastSyncError?: string;
  lastReconcileAction?: string;
}

export interface TelegramBridgeStatusThreadReservation {
  target?: { chatId: number; threadId?: number };
  slot?: string;
  reason?: string;
  instanceId?: string;
  expiresAtMs?: number;
  lastReconcileAction?: string;
}

export interface TelegramBridgeStatusSyncObservation {
  target?: { chatId: number; threadId?: number };
  syncStatus: string;
  observedAtMs: number;
  instanceId?: string;
  slot?: string;
  lastSyncError?: string;
  lastReconcileAction?: string;
}

export interface TelegramBridgeStatusSyncSlice {
  status: string;
  updatedAtMs?: number;
  suspectAtMs?: number;
  reason?: string;
  lastReconcileAction?: string;
}

export interface TelegramBridgeThreadReconciliationState {
  phase: string;
  event: string;
  atMs: number;
  leaderEpoch?: number | string;
  pendingProvisionCount: number;
  syncActionCount: number;
  cleanupActionCount: number;
}

export type TelegramBridgeBusRole = "leader" | "follower";
export type TelegramBridgeBusLifecyclePhase = "electing";

export interface TelegramBridgeStatusLineState {
  hasBotToken?: boolean;
  botUsername?: string;
  allowedUserId?: number;
  botThreadMode?: "unknown" | "enabled" | "disabled";
  botThreadModeUpdatedAtMs?: number;
  botThreadModeAction?: string;
  busRole?: TelegramBridgeBusRole;
  busLifecyclePhase?: TelegramBridgeBusLifecyclePhase;
  instanceSlot?: string;
  instanceThreadName?: string;
  lockState?: string;
  pollingActive: boolean;
  lastUpdateId?: number;
  activeSourceMessageIds?: number[];
  pendingDispatch: boolean;
  compactionInProgress: boolean;
  activeToolExecutions: number;
  pendingModelSwitch: boolean;
  queuedItems: Array<{ queueLane: TelegramStatusQueueLane }>;
  busFollowers?: TelegramBridgeStatusBusFollower[];
  localBus?: TelegramBridgeStatusLocalBus;
  topicTargets?: TelegramBridgeStatusTopicTarget[];
  threadReservations?: TelegramBridgeStatusThreadReservation[];
  topicSyncObservations?: TelegramBridgeStatusSyncObservation[];
  syncState?: Record<string, TelegramBridgeStatusSyncSlice | undefined>;
  threadReconciliation?: TelegramBridgeThreadReconciliationState;
  busNowMs?: number;
  recentRuntimeEvents: TelegramRuntimeEvent[];
}

export interface TelegramStatusBarTheme {
  fg: (
    token: "accent" | "error" | "muted" | "warning" | "success",
    text: string,
  ) => string;
}

export interface TelegramStatusBarState {
  hasBotToken: boolean;
  pollingActive: boolean;
  paired: boolean;
  busRole?: TelegramBridgeBusRole;
  busLifecyclePhase?: TelegramBridgeBusLifecyclePhase;
  instanceSlot?: string;
  instanceThreadName?: string;
  compactionInProgress: boolean;
  processing: boolean;
  processingStatus?: string;
  queuedStatus: string;
  error?: string;
}

export interface TelegramStatusRuntimeContext {
  ui: {
    theme: TelegramStatusBarTheme;
    setStatus: (key: string, text: string) => void;
  };
}

export interface TelegramStatusRuntimeDeps<
  TContext extends TelegramStatusRuntimeContext,
> {
  statusKey?: string;
  getStatusBarState: (ctx: TContext, error?: string) => TelegramStatusBarState;
  getBridgeStatusLineState: () => TelegramBridgeStatusLineState;
}

export interface TelegramBridgeStatusConfig {
  botToken?: string;
  botUsername?: string;
  allowedUserId?: number;
  lastUpdateId?: number;
}

export interface TelegramBridgeStatusRuntimeDeps<
  TQueueItem extends { queueLane: TelegramStatusQueueLane },
> {
  statusKey?: string;
  getConfig: () => TelegramBridgeStatusConfig;
  isPollingActive: () => boolean;
  getActiveSourceMessageIds: () => number[] | undefined;
  hasActiveTurn: () => boolean;
  hasDispatchPending: () => boolean;
  isCompactionInProgress: () => boolean;
  getActiveToolExecutions: () => number;
  hasPendingModelSwitch: () => boolean;
  getQueuedItems: () => TQueueItem[];
  formatQueuedStatus: (items: TQueueItem[]) => string;
  getRecentRuntimeEvents: () => TelegramRuntimeEvent[];
  getRuntimeLockState?: () => string;
  getBusRole?: () => TelegramBridgeBusRole | undefined;
  getBusLifecyclePhase?: () => TelegramBridgeBusLifecyclePhase | undefined;
  getBotThreadMode?: () =>
    | {
        threadMode: "unknown" | "enabled" | "disabled";
        updatedAtMs?: number;
        lastReconcileAction?: string;
      }
    | undefined;
  getBusFollowers?: () => TelegramBridgeStatusBusFollower[];
  getLocalBus?: () => TelegramBridgeStatusLocalBus | undefined;
  getTopicTargets?: () => TelegramBridgeStatusTopicTarget[];
  getThreadReservations?: () => TelegramBridgeStatusThreadReservation[];
  getTopicSyncObservations?: () => TelegramBridgeStatusSyncObservation[];
  getSyncState?: () => Record<
    string,
    TelegramBridgeStatusSyncSlice | undefined
  >;
  getThreadReconciliationState?: () =>
    | TelegramBridgeThreadReconciliationState
    | undefined;
  getInstanceSlot?: () => string | undefined;
  getInstanceThreadName?: () => string | undefined;
  getNowMs?: () => number;
}

export interface TelegramBridgeStatusLineOptions {
  verbose?: boolean;
}

export interface TelegramStatusRuntime<
  TContext extends TelegramStatusRuntimeContext,
> {
  updateStatus: (ctx: TContext, error?: string) => void;
  getStatusLines: (options?: TelegramBridgeStatusLineOptions) => string[];
  getStatusState: () => TelegramBridgeStatusLineState;
}

function truncateTelegramRuntimeEventText(
  text: string,
  maxLength: number,
): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}… [truncated ${text.length - maxLength} chars]`;
}

export function redactTelegramRuntimeMessage(
  message: string,
  botToken: string | undefined,
): string {
  const redacted = botToken
    ? message.split(botToken).join("<redacted-token>")
    : message;
  return truncateTelegramRuntimeEventText(
    redacted,
    MAX_TELEGRAM_RUNTIME_EVENT_MESSAGE_LENGTH,
  );
}

function redactTelegramRuntimeDetail(
  message: string,
  botToken: string | undefined,
): string {
  const redacted = botToken
    ? message.split(botToken).join("<redacted-token>")
    : message;
  return truncateTelegramRuntimeEventText(
    redacted,
    MAX_TELEGRAM_RUNTIME_EVENT_DETAIL_LENGTH,
  );
}

function normalizeTelegramRuntimeEventDetails(
  details: Record<string, unknown> | undefined,
  botToken: string | undefined,
): Record<string, TelegramRuntimeEventDetailValue> | undefined {
  if (!details) return undefined;
  const normalized: Record<string, TelegramRuntimeEventDetailValue> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
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

function getTelegramRuntimeEventMessage(
  input: TelegramRuntimeEventInput,
): string {
  if (input.message !== undefined) return input.message;
  if (input.error instanceof Error) return input.error.message;
  return String(input.error);
}

export function recordStructuredTelegramRuntimeEvent(
  events: TelegramRuntimeEvent[],
  input: TelegramRuntimeEventInput,
  options: { botToken?: string; maxEvents: number; now?: number },
): void {
  const details = normalizeTelegramRuntimeEventDetails(
    input.details,
    options.botToken,
  );
  events.push({
    at: options.now ?? Date.now(),
    category: input.category,
    message: redactTelegramRuntimeMessage(
      getTelegramRuntimeEventMessage(input),
      options.botToken,
    ),
    ...(details ? { details } : {}),
  });
  while (events.length > options.maxEvents) {
    events.shift();
  }
}

export function recordTelegramRuntimeEvent(
  events: TelegramRuntimeEvent[],
  category: string,
  error: unknown,
  options: { botToken?: string; maxEvents: number; now?: number },
): void {
  recordStructuredTelegramRuntimeEvent(events, { category, error }, options);
}

function getOrCreateTelegramStatusLineProviderRegistry(): Map<
  string,
  TelegramStatusLineProvider
> {
  const existing = (globalThis as Record<string, unknown>)[
    TELEGRAM_STATUS_LINE_PROVIDER_REGISTRY_KEY
  ];
  if (existing instanceof Map)
    return existing as Map<string, TelegramStatusLineProvider>;
  const registry = new Map<string, TelegramStatusLineProvider>();
  (globalThis as Record<string, unknown>)[
    TELEGRAM_STATUS_LINE_PROVIDER_REGISTRY_KEY
  ] = registry;
  return registry;
}

/**
 * Register a compact companion-extension line for the Telegram status menu.
 *
 * Providers are synchronous and should return undefined when their line is not
 * relevant for the active model. Errors are isolated so optional companion
 * status cannot break the core Telegram menu.
 */
export function registerTelegramStatusLineProvider(
  provider: TelegramStatusLineProvider,
  options: { id: string },
): () => void {
  const registry = getOrCreateTelegramStatusLineProviderRegistry();
  registry.set(options.id, provider);
  return () => {
    if (registry.get(options.id) === provider) registry.delete(options.id);
  };
}

export function getTelegramStatusLineProviderResults(
  ctx: TelegramStatusLineProviderContext,
): TelegramStatusLineProviderResult[] {
  const results: TelegramStatusLineProviderResult[] = [];
  const registry = getOrCreateTelegramStatusLineProviderRegistry();
  for (const provider of registry.values()) {
    try {
      const result = provider(ctx);
      if (!result?.label || !result.value) continue;
      results.push(result);
    } catch {
      continue;
    }
  }
  return results;
}

export function clearTelegramStatusLineProviders(): void {
  getOrCreateTelegramStatusLineProviderRegistry().clear();
}

export function createTelegramRuntimeEventRecorder(
  options: TelegramRuntimeEventRecorderOptions,
): TelegramRuntimeEventRecorder {
  const events: TelegramRuntimeEvent[] = [];
  return {
    record: (category, error, details) => {
      recordStructuredTelegramRuntimeEvent(
        events,
        { category, error, details },
        {
          botToken: options.getBotToken(),
          maxEvents: options.maxEvents ?? MAX_RECENT_TELEGRAM_RUNTIME_EVENTS,
          now: options.now?.(),
        },
      );
    },
    getEvents: () => events,
    clear: () => {
      events.length = 0;
    },
  };
}

function formatTelegramRuntimeEventCategory(
  event: TelegramRuntimeEvent,
): string {
  const method = event.details?.method;
  return typeof method === "string"
    ? `${event.category}:${method}`
    : event.category;
}

function formatTelegramRuntimeEventDetails(
  event: TelegramRuntimeEvent,
): string {
  if (!event.details) return "";
  const details = Object.entries(event.details)
    .filter(([key]) => key !== "method")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function formatTelegramRuntimeEventSummary(
  event: TelegramRuntimeEvent,
): string {
  return `${formatTelegramRuntimeEventCategory(event)}: ${event.message}${formatTelegramRuntimeEventDetails(event)}`;
}

function formatTelegramRuntimeEvent(event: TelegramRuntimeEvent): string {
  return `${new Date(event.at).toISOString()} ${formatTelegramRuntimeEventSummary(event)}`;
}

function buildTelegramRuntimeEventSummary(
  events: TelegramRuntimeEvent[],
): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const category = formatTelegramRuntimeEventCategory(event);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => `${category}=${count}`)
    .join(", ");
}

export function buildTelegramRuntimeEventLines(
  events: TelegramRuntimeEvent[],
): string[] {
  if (events.length === 0) return ["recent runtime events: none"];
  return [
    "recent runtime events:",
    `- summary: ${buildTelegramRuntimeEventSummary(events)}`,
    ...events
      .slice()
      .reverse()
      .map((event) => `- ${formatTelegramRuntimeEvent(event)}`),
  ];
}

export function createTelegramStatusHtmlBuilder<TContext>(deps: {
  getActiveModel: (ctx: TContext) => TelegramStatusActiveModel | undefined;
  isCompactionInProgress?: () => boolean;
  getBridgeStatusLineState?: () => TelegramBridgeStatusLineState;
}): (ctx: TContext & TelegramStatusContext) => string {
  return (ctx) =>
    buildStatusHtml(
      { ...ctx, isCompactionInProgress: deps.isCompactionInProgress },
      deps.getActiveModel(ctx),
      deps.getBridgeStatusLineState?.(),
    );
}

export function createTelegramStatusRuntime<
  TContext extends TelegramStatusRuntimeContext,
>(deps: TelegramStatusRuntimeDeps<TContext>): TelegramStatusRuntime<TContext> {
  const statusKey = deps.statusKey ?? "telegram";
  return {
    updateStatus: (ctx, error) => {
      ctx.ui.setStatus(
        statusKey,
        buildTelegramStatusBarText(
          ctx.ui.theme,
          deps.getStatusBarState(ctx, error),
        ),
      );
    },
    getStatusLines: (options) =>
      buildTelegramBridgeStatusLines(deps.getBridgeStatusLineState(), options),
    getStatusState: deps.getBridgeStatusLineState,
  };
}

export function createTelegramBridgeStatusRuntime<
  TContext extends TelegramStatusRuntimeContext,
  TQueueItem extends { queueLane: TelegramStatusQueueLane },
>(
  deps: TelegramBridgeStatusRuntimeDeps<TQueueItem>,
): TelegramStatusRuntime<TContext> {
  return createTelegramStatusRuntime({
    statusKey: deps.statusKey,
    getStatusBarState: (_ctx, error) => {
      const config = deps.getConfig();
      const queuedItems = deps.getQueuedItems();
      const hasActiveTurn = deps.hasActiveTurn();
      const hasPendingDispatch = deps.hasDispatchPending();
      const hasPendingModelSwitch = deps.hasPendingModelSwitch();
      const activeToolExecutions = deps.getActiveToolExecutions();
      const compactionInProgress = deps.isCompactionInProgress();
      return {
        hasBotToken: !!config.botToken,
        pollingActive: deps.isPollingActive(),
        paired: !!config.allowedUserId,
        busRole: deps.getBusRole?.(),
        busLifecyclePhase: deps.getBusLifecyclePhase?.(),
        instanceSlot: deps.getInstanceSlot?.(),
        instanceThreadName: deps.getInstanceThreadName?.(),
        compactionInProgress,
        processing:
          hasActiveTurn ||
          hasPendingDispatch ||
          hasPendingModelSwitch ||
          activeToolExecutions > 0 ||
          queuedItems.length > 0,
        processingStatus: getTelegramStatusBarProcessingStatus({
          hasActiveTurn,
          hasPendingDispatch,
          hasPendingModelSwitch,
          activeToolExecutions,
          queuedItems: queuedItems.length,
        }),
        queuedStatus: deps.formatQueuedStatus(queuedItems),
        error,
      };
    },
    getBridgeStatusLineState: () => {
      const config = deps.getConfig();
      const botThreadMode = deps.getBotThreadMode?.();
      return {
        hasBotToken: Boolean(config.botToken),
        botUsername: config.botUsername,
        allowedUserId: config.allowedUserId,
        botThreadMode: botThreadMode?.threadMode,
        botThreadModeUpdatedAtMs: botThreadMode?.updatedAtMs,
        botThreadModeAction: botThreadMode?.lastReconcileAction,
        busRole: deps.getBusRole?.(),
        busLifecyclePhase: deps.getBusLifecyclePhase?.(),
        instanceSlot: deps.getInstanceSlot?.(),
        instanceThreadName: deps.getInstanceThreadName?.(),
        lockState: deps.getRuntimeLockState?.(),
        pollingActive: deps.isPollingActive(),
        lastUpdateId: config.lastUpdateId,
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

export interface TelegramRuntimeLogScope extends Record<string, unknown> {
  instanceId: string;
  role: string;
  slot?: string;
  threadName?: string;
  lockState?: string;
}

export function createTelegramRuntimeLogScope(input: {
  state: TelegramBridgeStatusLineState;
  instanceId: string;
}): TelegramRuntimeLogScope {
  return {
    instanceId: input.instanceId,
    role: input.state.busRole ?? "classic-or-disconnected",
    slot: input.state.instanceSlot,
    threadName: input.state.instanceThreadName,
    lockState: input.state.lockState,
  };
}

export function createTelegramStatusSnapshot(
  state: TelegramBridgeStatusLineState,
): {
  runtime: Record<string, unknown>;
  liveRoster: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
} {
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

export function createTelegramRuntimeDiagnosticsSnapshotScheduler(deps: {
  persistSnapshot: () => Promise<void>;
  recordError: (error: unknown) => void;
  setTimer?: (callback: () => void, ms: number) => { unref?: () => void };
}): () => void {
  const setTimer = deps.setTimer ?? setTimeout;
  let timer: { unref?: () => void } | number | undefined;
  return () => {
    if (timer) return;
    timer = setTimer(() => {
      timer = undefined;
      void deps.persistSnapshot().catch(deps.recordError);
    }, 0);
    if (typeof timer !== "number") timer?.unref?.();
  };
}

export function getTelegramStatusBarProcessingStatus(state: {
  hasActiveTurn: boolean;
  hasPendingDispatch: boolean;
  hasPendingModelSwitch: boolean;
  activeToolExecutions: number;
  queuedItems: number;
}): string | undefined {
  if (state.hasPendingModelSwitch) return "model";
  if (state.hasActiveTurn || state.activeToolExecutions > 0) return "active";
  if (state.hasPendingDispatch) return "dispatching";
  if (state.queuedItems > 0) return "queued";
  return undefined;
}

function getTelegramStatusBarLabel(state: TelegramStatusBarState): string {
  const threadName = state.instanceThreadName?.trim();
  if (!threadName) return "telegram";
  const genericLabels = new Set(["telegram", "leader", "follower"]);
  if (genericLabels.has(threadName.toLowerCase())) return "telegram";
  return threadName;
}

export function buildTelegramStatusBarText(
  theme: TelegramStatusBarTheme,
  state: TelegramStatusBarState,
): string {
  const label = theme.fg("accent", getTelegramStatusBarLabel(state));
  if (state.error) {
    return `${label} ${theme.fg("error", "error")} ${theme.fg("muted", state.error)}`;
  }
  const queued = state.queuedStatus
    ? theme.fg("success", state.queuedStatus)
    : "";
  if (!state.hasBotToken)
    return `${label} ${theme.fg("muted", "not configured")}${queued}`;
  if (!state.paired)
    return `${label} ${theme.fg("warning", "awaiting pairing")}${queued}`;
  if (state.busLifecyclePhase === "electing")
    return `${label} ${theme.fg("warning", "electing")}${queued}`;
  if (!state.pollingActive && state.busRole !== "follower")
    return `${label} ${theme.fg("muted", "disconnected")}${queued}`;
  if (state.busRole === "follower")
    return `${label} ${theme.fg("success", "follower")}${queued}`;
  if (state.compactionInProgress) {
    return `${label} ${theme.fg("warning", "compacting")}${queued}`;
  }
  if (state.processing) {
    const processingStatus = state.queuedStatus
      ? "active"
      : (state.processingStatus ?? "processing");
    const processingToken =
      processingStatus === "active" ? "warning" : "accent";
    return `${label} ${theme.fg(processingToken, processingStatus)}${queued}`;
  }
  if (state.busRole === "leader")
    return `${label} ${theme.fg("success", "leader")}`;
  return `${label} ${theme.fg("success", "connected")}`;
}

function formatTelegramBridgeBotStatus(
  state: Pick<TelegramBridgeStatusLineState, "hasBotToken" | "botUsername">,
): string {
  if (state.botUsername) return `@${state.botUsername}`;
  return state.hasBotToken ? "unknown" : "not configured";
}

function formatTelegramStatusTarget(
  target: { chatId: number; threadId?: number } | undefined,
): string {
  if (!target) return "";
  return target.threadId === undefined
    ? ` target ${target.chatId}`
    : ` target ${target.chatId}:${target.threadId}`;
}

function formatTelegramThreadStatusLabel(input: {
  threadName?: string;
  slot?: string;
}): string {
  const threadName = input.threadName?.trim();
  if (threadName) return threadName;
  return input.slot ? `[${input.slot}]` : "";
}

function buildTelegramBusFollowerLines(
  state: Pick<TelegramBridgeStatusLineState, "busFollowers" | "busNowMs">,
): string[] {
  const followers = state.busFollowers ?? [];
  if (followers.length === 0) return [];
  const nowMs = state.busNowMs ?? Date.now();
  return [
    "",
    "bus:",
    `- followers: ${followers.length}`,
    ...followers.map((follower) => {
      const ageSeconds = Math.max(
        0,
        Math.round((nowMs - follower.lastHeartbeatMs) / 1000),
      );
      const label = formatTelegramThreadStatusLabel(follower);
      const labelSuffix = label ? ` ${label}` : "";
      const statusLabel = follower.status ? ` (${follower.status})` : "";
      const cwd = follower.cwd ? ` ${follower.cwd}` : "";
      const target = formatTelegramStatusTarget(follower.target);
      return `- ${follower.instanceId}:${labelSuffix} heartbeat ${ageSeconds}s ago${statusLabel}${target}${cwd}`;
    }),
  ];
}

function buildTelegramLocalBusLines(
  state: Pick<TelegramBridgeStatusLineState, "localBus">,
  options: { verbose?: boolean } = {},
): string[] {
  const localBus = state.localBus;
  if (!localBus) return [];
  const target = formatTelegramStatusTarget(localBus.followerTarget);
  const label = formatTelegramThreadStatusLabel({
    slot: localBus.followerSlot,
    threadName: localBus.followerThreadName,
  });
  const followerLine = `- follower registered: ${localBus.followerRegistered ? "yes" : "no"}${label ? ` ${label}` : ""}${target}`;
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
      lines.push(
        `- follower endpoint${transport}: ${localBus.followerSocketPath}`,
      );
    }
  }
  return lines;
}

function buildTelegramSyncSliceLines(
  state: Pick<TelegramBridgeStatusLineState, "syncState">,
): string[] {
  const syncState = state.syncState;
  if (!syncState || Object.keys(syncState).length === 0) return [];
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

function buildTelegramThreadReconciliationLines(
  state: Pick<TelegramBridgeStatusLineState, "threadReconciliation">,
): string[] {
  const reconciliation = state.threadReconciliation;
  if (!reconciliation) return [];
  const epoch =
    reconciliation.leaderEpoch !== undefined
      ? ` epoch=${reconciliation.leaderEpoch}`
      : "";
  return [
    "reconciliation:",
    `- phase: ${reconciliation.phase} event=${reconciliation.event}${epoch}`,
    `- counts: pending=${reconciliation.pendingProvisionCount}, sync=${reconciliation.syncActionCount}, cleanup=${reconciliation.cleanupActionCount}`,
  ];
}

function buildTelegramTopicTargetDiagnosticLines(
  state: Pick<
    TelegramBridgeStatusLineState,
    "topicTargets" | "threadReservations" | "topicSyncObservations"
  >,
): string[] {
  const activeTargets = (state.topicTargets ?? []).filter(
    (record) =>
      !!record.instanceId &&
      (record.status === "active" || record.status === "starting"),
  );
  const reservations = state.threadReservations ?? [];
  const observations = state.topicSyncObservations ?? [];
  if (
    activeTargets.length === 0 &&
    reservations.length === 0 &&
    observations.length === 0
  )
    return [];
  const byInstance = new Map<string, TelegramBridgeStatusTopicTarget[]>();
  for (const record of activeTargets) {
    const key = record.instanceId;
    if (!key) continue;
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

function buildTelegramBridgeCompactThreadLines(
  state: Pick<
    TelegramBridgeStatusLineState,
    | "busFollowers"
    | "topicTargets"
    | "threadReservations"
    | "topicSyncObservations"
  >,
): string[] {
  const activeTargets = (state.topicTargets ?? []).filter(
    (record) =>
      !!record.instanceId &&
      (record.status === "active" || record.status === "starting"),
  );
  const activeLabels = activeTargets
    .map(formatTelegramThreadStatusLabel)
    .filter((label) => label.length > 0);
  const followers = state.busFollowers ?? [];
  const reservations = state.threadReservations ?? [];
  const observations = state.topicSyncObservations ?? [];
  if (
    activeLabels.length === 0 &&
    followers.length === 0 &&
    reservations.length === 0 &&
    observations.length === 0
  ) {
    return [];
  }
  const lines = ["threads:"];
  if (activeLabels.length > 0)
    lines.push(`- active: ${activeLabels.join(", ")}`);
  if (followers.length > 0) lines.push(`- followers: ${followers.length}`);
  if (reservations.length > 0) lines.push(`- reserved: ${reservations.length}`);
  const syncIssueCount = observations.filter(
    (observation) => observation.syncStatus !== "open",
  ).length;
  if (syncIssueCount > 0) lines.push(`- sync issues: ${syncIssueCount}`);
  return lines;
}

function buildTelegramBridgeCompactStatusLines(
  state: TelegramBridgeStatusLineState,
): string[] {
  const controlQueueCount = state.queuedItems.filter(
    (item) => item.queueLane === "control",
  ).length;
  const priorityQueueCount = state.queuedItems.filter(
    (item) => item.queueLane === "priority",
  ).length;
  const defaultQueueCount = state.queuedItems.filter(
    (item) => item.queueLane === "default",
  ).length;
  const queueLine = `- queued turns: ${state.queuedItems.length}${
    state.queuedItems.length > 0
      ? ` (control=${controlQueueCount}, priority=${priorityQueueCount}, default=${defaultQueueCount})`
      : ""
  }`;
  const executionState = state.compactionInProgress
    ? "compacting"
    : state.pendingDispatch
      ? "pending dispatch"
      : state.activeSourceMessageIds?.length
        ? "active"
        : "idle";
  return [
    "connection:",
    `- bot: ${formatTelegramBridgeBotStatus(state)}`,
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
    `- polling: ${state.pollingActive ? "running" : "stopped"}`,
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
    "- state: ~/.pi/agent/tmp/telegram/state.json",
    "- logs: ~/.pi/agent/tmp/telegram/logs.jsonl",
    "- full dump: /telegram-status --debug",
  ];
}

export function buildTelegramBridgeStatusLines(
  state: TelegramBridgeStatusLineState,
  options: TelegramBridgeStatusLineOptions = {},
): string[] {
  if (options.verbose) return buildTelegramBridgeDiagnosticStatusLines(state);
  return buildTelegramBridgeCompactStatusLines(state);
}

export function buildTelegramBridgeDiagnosticStatusLines(
  state: TelegramBridgeStatusLineState,
): string[] {
  const controlQueueCount = state.queuedItems.filter(
    (item) => item.queueLane === "control",
  ).length;
  const priorityQueueCount = state.queuedItems.filter(
    (item) => item.queueLane === "priority",
  ).length;
  const defaultQueueCount = state.queuedItems.filter(
    (item) => item.queueLane === "default",
  ).length;
  return [
    "connection:",
    `- bot: ${formatTelegramBridgeBotStatus(state)}`,
    `- allowed user: ${state.allowedUserId ?? "not paired"}`,
    ...(state.botThreadMode
      ? [
          `- thread mode: ${state.botThreadMode}${state.botThreadModeAction ? ` reconcile=${state.botThreadModeAction}` : ""}`,
        ]
      : []),
    ...(state.busRole ? [`- bus role: ${state.busRole}`] : []),
    ...(state.busLifecyclePhase
      ? [`- bus lifecycle: ${state.busLifecyclePhase}`]
      : []),
    ...(state.instanceThreadName || state.instanceSlot
      ? [`- instance: ${state.instanceThreadName ?? state.instanceSlot}`]
      : []),
    ...(state.lockState ? [`- owner: ${state.lockState}`] : []),
    "",
    "polling:",
    `- state: ${state.pollingActive ? "running" : "stopped"}`,
    `- last update id: ${state.lastUpdateId ?? "none"}`,
    "",
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function collectUsageStats(ctx: TelegramStatusContext): TelegramUsageStats {
  const stats: TelegramUsageStats = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    const usage = entry.message?.usage;
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      !usage
    ) {
      continue;
    }
    stats.totalInput += usage.input;
    stats.totalOutput += usage.output;
    stats.totalCacheRead += usage.cacheRead;
    stats.totalCacheWrite += usage.cacheWrite;
    stats.totalCost += usage.cost.total;
  }
  return stats;
}

function formatStatusRowLabel(label: string): string {
  if (!label) return label;
  return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`;
}

function buildStatusRow(label: string, value: string): string {
  return `<b>${escapeHtml(formatStatusRowLabel(label))}:</b> <code>${escapeHtml(value)}</code>`;
}

function buildUsageSummary(stats: TelegramUsageStats): string | undefined {
  const tokenParts: string[] = [];
  if (stats.totalInput) tokenParts.push(`↑${formatTokens(stats.totalInput)}`);
  if (stats.totalOutput) tokenParts.push(`↓${formatTokens(stats.totalOutput)}`);
  if (stats.totalCacheRead)
    tokenParts.push(`R${formatTokens(stats.totalCacheRead)}`);
  if (stats.totalCacheWrite)
    tokenParts.push(`W${formatTokens(stats.totalCacheWrite)}`);
  return tokenParts.length > 0 ? tokenParts.join(" ") : undefined;
}

function buildCostSummary(
  stats: TelegramUsageStats,
  usesSubscription: boolean,
): string | undefined {
  if (!stats.totalCost && !usesSubscription) return undefined;
  return `$${stats.totalCost.toFixed(3)}${usesSubscription ? " (sub)" : ""}`;
}

function buildContextSummary(
  ctx: TelegramStatusContext,
  activeModel: TelegramStatusActiveModel | undefined,
): string {
  const usage = ctx.getContextUsage();
  if (!usage) return "unknown";
  const contextWindow = usage.contextWindow ?? activeModel?.contextWindow ?? 0;
  const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
  return `${percent}/${formatTokens(contextWindow)}`;
}

function buildStatusSummary(ctx: TelegramStatusContext): string {
  if (ctx.isCompactionInProgress?.()) return "compacting";
  if (ctx.hasPendingMessages?.()) return "pending";
  if (ctx.isIdle?.() === false) return "active";
  if (ctx.isIdle?.() === true) return "idle";
  return "unknown";
}

function buildTelegramStatusRoleSuffix(
  state: TelegramBridgeStatusLineState | undefined,
): string {
  if (state?.botThreadMode !== "enabled" || !state.busRole) return "";
  return ` @${state.busRole}`;
}

export function buildStatusHtml(
  ctx: TelegramStatusContext,
  activeModel: TelegramStatusActiveModel | undefined,
  bridgeStatus?: TelegramBridgeStatusLineState,
): string {
  const stats = collectUsageStats(ctx);
  const usesSubscription = activeModel
    ? ctx.modelRegistry.isUsingOAuth(activeModel)
    : false;
  const lines: string[] = [
    buildStatusRow(
      "Status",
      `${buildStatusSummary(ctx)}${buildTelegramStatusRoleSuffix(bridgeStatus)}`,
    ),
  ];
  const usageSummary = buildUsageSummary(stats);
  const costSummary = buildCostSummary(stats, usesSubscription);
  if (usageSummary) {
    lines.push(buildStatusRow("Usage", usageSummary));
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
