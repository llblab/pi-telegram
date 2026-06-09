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

export interface TelegramBridgeStatusLineState {
  hasBotToken?: boolean;
  botUsername?: string;
  allowedUserId?: number;
  lockState?: string;
  pollingActive: boolean;
  lastUpdateId?: number;
  activeSourceMessageIds?: number[];
  pendingDispatch: boolean;
  compactionInProgress: boolean;
  activeToolExecutions: number;
  pendingModelSwitch: boolean;
  queuedItems: Array<{ queueLane: TelegramStatusQueueLane }>;
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
}

export interface TelegramStatusRuntime<
  TContext extends TelegramStatusRuntimeContext,
> {
  updateStatus: (ctx: TContext, error?: string) => void;
  getStatusLines: () => string[];
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
}): (ctx: TContext & TelegramStatusContext) => string {
  return (ctx) =>
    buildStatusHtml(
      { ...ctx, isCompactionInProgress: deps.isCompactionInProgress },
      deps.getActiveModel(ctx),
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
    getStatusLines: () =>
      buildTelegramBridgeStatusLines(deps.getBridgeStatusLineState()),
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
      return {
        hasBotToken: Boolean(config.botToken),
        botUsername: config.botUsername,
        allowedUserId: config.allowedUserId,
        lockState: deps.getRuntimeLockState?.(),
        pollingActive: deps.isPollingActive(),
        lastUpdateId: config.lastUpdateId,
        activeSourceMessageIds: deps.getActiveSourceMessageIds(),
        pendingDispatch: deps.hasDispatchPending(),
        compactionInProgress: deps.isCompactionInProgress(),
        activeToolExecutions: deps.getActiveToolExecutions(),
        pendingModelSwitch: deps.hasPendingModelSwitch(),
        queuedItems: deps.getQueuedItems(),
        recentRuntimeEvents: deps.getRecentRuntimeEvents(),
      };
    },
  });
}

export function getTelegramStatusBarProcessingStatus(state: {
  hasActiveTurn: boolean;
  hasPendingDispatch: boolean;
  hasPendingModelSwitch: boolean;
  activeToolExecutions: number;
  queuedItems: number;
}): string | undefined {
  if (state.hasPendingModelSwitch) return "model";
  if (state.hasActiveTurn && state.activeToolExecutions > 0)
    return "tool running";
  if (state.hasActiveTurn || state.activeToolExecutions > 0) return "active";
  if (state.hasPendingDispatch) return "dispatching";
  if (state.queuedItems > 0) return "queued";
  return undefined;
}

export function buildTelegramStatusBarText(
  theme: TelegramStatusBarTheme,
  state: TelegramStatusBarState,
): string {
  const label = theme.fg("accent", "telegram");
  if (state.error) {
    return `${label} ${theme.fg("error", "error")} ${theme.fg("muted", state.error)}`;
  }
  const queued = state.queuedStatus
    ? theme.fg("success", state.queuedStatus)
    : "";
  if (!state.hasBotToken)
    return `${label} ${theme.fg("muted", "not configured")}${queued}`;
  if (!state.pollingActive)
    return `${label} ${theme.fg("muted", "disconnected")}${queued}`;
  if (!state.paired)
    return `${label} ${theme.fg("warning", "awaiting pairing")}${queued}`;
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
  return `${label} ${theme.fg("success", "connected")}`;
}

function formatTelegramBridgeBotStatus(
  state: Pick<TelegramBridgeStatusLineState, "hasBotToken" | "botUsername">,
): string {
  if (state.botUsername) return `@${state.botUsername}`;
  return state.hasBotToken ? "unknown" : "not configured";
}

export function buildTelegramBridgeStatusLines(
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

export function buildStatusHtml(
  ctx: TelegramStatusContext,
  activeModel: TelegramStatusActiveModel | undefined,
): string {
  const stats = collectUsageStats(ctx);
  const usesSubscription = activeModel
    ? ctx.modelRegistry.isUsingOAuth(activeModel)
    : false;
  const lines: string[] = [buildStatusRow("Status", buildStatusSummary(ctx))];
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
