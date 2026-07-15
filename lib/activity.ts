/**
 * Telegram activity lifecycle normalization and extension dispatch
 * Zones: pi agent lifecycle, extension API, operational delivery
 * Owns stable handler registration, evidence-based activity/source identity, assistant segment and reasoning normalization, ordered public-output projection, executed-tool and compaction events, isolated non-blocking queues, shutdown fencing, diagnostics, and fresh delivery contexts; excludes Pi hook wiring, Telegram rendering implementation, raw transport clients, and consumer-extension behavior
 */

import {
  deleteTelegramView,
  editTelegramView,
  sendTelegramChatAction,
  sendTelegramView,
  type TelegramDeliveryChatAction,
  type TelegramDeliveryHandle,
  type TelegramDeliveryResult,
  type TelegramDeliveryScope,
  type TelegramDeliveryTarget,
  type TelegramDeliveryView,
} from "./delivery.ts";

const TELEGRAM_ACTIVITY_REGISTRY_KEY = "__piTelegramActivityRegistry__";

export type TelegramActivitySource =
  | "telegram"
  | "local"
  | "autonomous"
  | "unknown";

export type TelegramActivityTarget = Readonly<TelegramDeliveryTarget>;

export interface TelegramActivityEnvelope {
  activityId: string;
  sequence: number;
  source: TelegramActivitySource;
  target?: TelegramActivityTarget;
  timestamp: number;
}

export type TelegramActivityPayload =
  | { type: "agent-start" }
    | {
        type: "assistant-text-delta";
        contentIndex: number;
        delta: string;
      }
    | {
        type: "assistant-segment";
        contentIndex: number;
        text: string;
        placement: "intermediate" | "final" | "terminal-partial";
      }
    | {
        type: "reasoning-delta";
        contentIndex: number;
        delta: string;
      }
    | {
        type: "reasoning-end";
        contentIndex: number;
        text: string;
      }
    | {
        type: "tool-start";
        toolCallId: string;
        toolName: string;
        args: unknown;
      }
    | {
        type: "tool-update";
        toolCallId: string;
        toolName: string;
        update: unknown;
      }
    | {
        type: "tool-end";
        toolCallId: string;
        toolName: string;
        result: unknown;
        isError: boolean;
      }
    | {
        type: "compaction-start";
        reason: "manual" | "threshold" | "overflow" | "unknown";
      }
    | {
        type: "compaction-end";
        reason: "manual" | "threshold" | "overflow" | "unknown";
      }
    | { type: "agent-end" }
  | { type: "agent-settled" };

export type TelegramActivityEvent = TelegramActivityEnvelope &
  TelegramActivityPayload;

export type TelegramAssistantSegmentEvent = TelegramActivityEnvelope &
  Extract<TelegramActivityPayload, { type: "assistant-segment" }>;

export interface TelegramActivityContext {
  activityId: string;
  sequence: number;
  source: TelegramActivitySource;
  defaultScope: TelegramDeliveryScope;
  send: (
    view: TelegramDeliveryView,
    options?: {
      scope?: TelegramDeliveryScope;
      replyToMessageId?: number;
    },
  ) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
  edit: (
    handle: TelegramDeliveryHandle,
    view: TelegramDeliveryView,
  ) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
  delete: (
    handle: TelegramDeliveryHandle,
  ) => Promise<TelegramDeliveryResult<void>>;
  chatAction: (
    action: TelegramDeliveryChatAction,
    options?: { scope?: TelegramDeliveryScope },
  ) => Promise<TelegramDeliveryResult<void>>;
}

export interface TelegramActivityHandlerRegistration {
  id: string;
  order?: number;
  handle: (
    event: TelegramActivityEvent,
    ctx: TelegramActivityContext,
  ) => void | Promise<void>;
}

interface RegisteredTelegramActivityHandler
  extends TelegramActivityHandlerRegistration {
  id: string;
  order: number;
}

interface TelegramActivityRegistry {
  handlers: Map<string, RegisteredTelegramActivityHandler>;
}

function getOrCreateTelegramActivityRegistry(): TelegramActivityRegistry {
  const globals = globalThis as Record<string, unknown>;
  const existing = globals[TELEGRAM_ACTIVITY_REGISTRY_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    "handlers" in existing &&
    existing.handlers instanceof Map
  ) {
    return existing as TelegramActivityRegistry;
  }
  const registry: TelegramActivityRegistry = { handlers: new Map() };
  globals[TELEGRAM_ACTIVITY_REGISTRY_KEY] = registry;
  return registry;
}

export function registerTelegramActivityHandler(
  registration: TelegramActivityHandlerRegistration,
): () => void {
  const id = registration.id.trim();
  if (!id) throw new Error("Telegram activity handler id is required.");
  const registry = getOrCreateTelegramActivityRegistry();
  if (registry.handlers.has(id)) {
    throw new Error(`Telegram activity handler is already registered: ${id}`);
  }
  const handler: RegisteredTelegramActivityHandler = {
    ...registration,
    id,
    order: registration.order ?? 0,
  };
  registry.handlers.set(id, handler);
  return () => {
    if (registry.handlers.get(id) === handler) registry.handlers.delete(id);
  };
}

/** @internal */
export function clearTelegramActivityHandlers(): void {
  getOrCreateTelegramActivityRegistry().handlers.clear();
}

function getTelegramActivityHandlers(): RegisteredTelegramActivityHandler[] {
  return Array.from(
    getOrCreateTelegramActivityRegistry().handlers.values(),
  ).sort(function (left, right) {
    return left.order - right.order || left.id.localeCompare(right.id);
  });
}

function cloneActivityTarget(
  target: TelegramActivityTarget,
): TelegramActivityTarget {
  return Object.freeze(
    target.threadId === undefined
      ? { chatId: target.chatId }
      : { chatId: target.chatId, threadId: target.threadId },
  );
}

function createTelegramActivityContext(
  event: TelegramActivityEvent,
  isActive: () => boolean,
): TelegramActivityContext {
  const defaultScope: TelegramDeliveryScope = event.target
    ? { kind: "target", target: cloneActivityTarget(event.target) }
    : event.source === "telegram"
      ? { kind: "active-turn" }
      : { kind: "instance" };
  const inactive = <T>(): Promise<TelegramDeliveryResult<T>> =>
    Promise.resolve({
      ok: false,
      reason: "runtime-unavailable",
      message: "Telegram activity context belongs to an inactive session.",
    });
  return {
    activityId: event.activityId,
    sequence: event.sequence,
    source: event.source,
    defaultScope,
    send(view, options) {
      if (!isActive()) return inactive();
      return sendTelegramView(view, {
        scope: options?.scope ?? defaultScope,
        replyToMessageId: options?.replyToMessageId,
      });
    },
    edit(handle, view) {
      return isActive() ? editTelegramView(handle, view) : inactive();
    },
    delete(handle) {
      return isActive() ? deleteTelegramView(handle) : inactive();
    },
    chatAction(action, options) {
      if (!isActive()) return inactive();
      return sendTelegramChatAction(action, {
        scope: options?.scope ?? defaultScope,
      });
    },
  };
}

interface TelegramActivityHandlerQueue {
  registration: RegisteredTelegramActivityHandler;
  events: TelegramActivityEvent[];
  running: boolean;
  active: boolean;
}

function canCoalesceActivityEvents(
  previous: TelegramActivityEvent,
  next: TelegramActivityEvent,
): boolean {
  if (
    previous.activityId !== next.activityId ||
    previous.type !== next.type
  ) {
    return false;
  }
  if (
    previous.type === "assistant-text-delta" &&
    next.type === "assistant-text-delta"
  ) {
    return previous.contentIndex === next.contentIndex;
  }
  if (
    previous.type === "reasoning-delta" &&
    next.type === "reasoning-delta"
  ) {
    return previous.contentIndex === next.contentIndex;
  }
  if (previous.type === "tool-update" && next.type === "tool-update") {
    return previous.toolCallId === next.toolCallId;
  }
  return false;
}

function coalesceActivityEvents(
  previous: TelegramActivityEvent,
  next: TelegramActivityEvent,
): TelegramActivityEvent {
  if (
    previous.type === "assistant-text-delta" &&
    next.type === "assistant-text-delta"
  ) {
    return { ...next, delta: previous.delta + next.delta };
  }
  if (
    previous.type === "reasoning-delta" &&
    next.type === "reasoning-delta"
  ) {
    return { ...next, delta: previous.delta + next.delta };
  }
  return next;
}

/** @internal */
export interface TelegramActivityDispatcher {
  dispatch: (event: TelegramActivityEvent) => void;
  stop: () => void;
}

/** @internal */
export function createTelegramActivityDispatcher(deps: {
  recordFailure?: (
    handlerId: string,
    event: TelegramActivityEvent,
    error: unknown,
  ) => void;
} = {}): TelegramActivityDispatcher {
  const queues = new Map<string, TelegramActivityHandlerQueue>();
  let stopped = false;
  const drain = async (queue: TelegramActivityHandlerQueue): Promise<void> => {
    if (queue.running || !queue.active) return;
    queue.running = true;
    try {
      while (queue.active) {
        const event = queue.events.shift();
        if (!event) break;
        if (
          getOrCreateTelegramActivityRegistry().handlers.get(
            queue.registration.id,
          ) !== queue.registration
        ) {
          queue.active = false;
          queue.events = [];
          break;
        }
        try {
          await queue.registration.handle(
            event,
            createTelegramActivityContext(event, () =>
              queue.active &&
              !stopped &&
              getOrCreateTelegramActivityRegistry().handlers.get(
                queue.registration.id,
              ) === queue.registration,
            ),
          );
        } catch (error) {
          deps.recordFailure?.(queue.registration.id, event, error);
        }
      }
    } finally {
      queue.running = false;
    }
  };
  return {
    dispatch(event) {
      if (stopped) return;
      for (const registration of getTelegramActivityHandlers()) {
        let queue = queues.get(registration.id);
        if (!queue || queue.registration !== registration) {
          queue = {
            registration,
            events: [],
            running: false,
            active: true,
          };
          queues.set(registration.id, queue);
        }
        const previous = queue.events.at(-1);
        if (previous && canCoalesceActivityEvents(previous, event)) {
          queue.events[queue.events.length - 1] = coalesceActivityEvents(
            previous,
            event,
          );
        } else {
          queue.events.push(event);
        }
        queueMicrotask(function () {
          void drain(queue!);
        });
      }
    },
    stop() {
      stopped = true;
      for (const queue of queues.values()) {
        queue.active = false;
        queue.events = [];
      }
      queues.clear();
    },
  };
}

/** @internal */
export function createTelegramActivityBridgeRuntime(deps: {
  generation: string;
  observeEvent?: (event: TelegramActivityEvent) => void;
  recordFailure?: (
    handlerId: string,
    event: TelegramActivityEvent,
    error: unknown,
  ) => void;
  now?: () => number;
}): TelegramActivityRuntime {
  let generationSequence = 0;
  let runtime: TelegramActivityRuntime | undefined;
  const getRuntime = (): TelegramActivityRuntime | undefined => runtime;
  return {
    onSessionStart() {
      runtime?.onSessionShutdown();
      runtime = createTelegramActivityRuntime({
        generation: `${deps.generation}:${++generationSequence}`,
        dispatcher: createTelegramActivityDispatcher({
          recordFailure: deps.recordFailure,
        }),
        observeEvent: deps.observeEvent,
        recordObserverFailure: deps.recordFailure
          ? (event, error) =>
              deps.recordFailure!("@llblab/pi-telegram/proactive", event, error)
          : undefined,
        now: deps.now,
      });
    },
    recordInputSource(source) {
      getRuntime()?.recordInputSource(source);
    },
    onAgentStart(target) {
      getRuntime()?.onAgentStart(target);
    },
    onAssistantEvent(event) {
      getRuntime()?.onAssistantEvent(event);
    },
    onToolStart(event) {
      getRuntime()?.onToolStart(event);
    },
    onToolUpdate(event) {
      getRuntime()?.onToolUpdate(event);
    },
    onToolEnd(event) {
      getRuntime()?.onToolEnd(event);
    },
    onCompactionStart(reason) {
      getRuntime()?.onCompactionStart(reason);
    },
    onCompactionEnd(reason) {
      getRuntime()?.onCompactionEnd(reason);
    },
    onCompactionAbandoned() {
      getRuntime()?.onCompactionAbandoned();
    },
    onAgentEnd() {
      getRuntime()?.onAgentEnd();
    },
    onAgentSettled() {
      getRuntime()?.onAgentSettled();
    },
    onSessionShutdown() {
      runtime?.onSessionShutdown();
      runtime = undefined;
    },
  };
}

export type TelegramActivityInputSource =
  | "interactive"
  | "rpc"
  | "extension"
  | "unknown";

export type TelegramAssistantStreamEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | { type: "done" }
  | { type: "error" };

/** @internal */
export interface TelegramActivityRuntime {
  onSessionStart?: () => void;
  recordInputSource: (source: TelegramActivityInputSource) => void;
  onAgentStart: (activeTelegramTarget?: TelegramActivityTarget) => void;
  onAssistantEvent: (event: TelegramAssistantStreamEvent) => void;
  onToolStart: (event: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }) => void;
  onToolUpdate: (event: {
    toolCallId: string;
    toolName: string;
    update: unknown;
  }) => void;
  onToolEnd: (event: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }) => void;
  onCompactionStart: (
    reason: "manual" | "threshold" | "overflow" | "unknown",
  ) => void;
  onCompactionEnd: (
    reason: "manual" | "threshold" | "overflow" | "unknown",
  ) => void;
  onCompactionAbandoned: () => void;
  onAgentEnd: () => void;
  onAgentSettled: () => void;
  onSessionShutdown: () => void;
}

interface PendingAssistantSegment {
  contentIndex: number;
  text: string;
}

/** @internal */
export function createTelegramActivityRuntime(deps: {
  generation: string;
  dispatcher: TelegramActivityDispatcher;
  observeEvent?: (event: TelegramActivityEvent) => void;
  recordObserverFailure?: (
    event: TelegramActivityEvent,
    error: unknown,
  ) => void;
  now?: () => number;
}): TelegramActivityRuntime {
  const now = deps.now ?? Date.now;
  let nextActivityNumber = 0;
  let activityId: string | undefined;
  let activitySource: TelegramActivitySource = "unknown";
  let activityTarget: TelegramActivityTarget | undefined;
  let sequence = 0;
  let pendingInputSource: TelegramActivityInputSource = "unknown";
  let pendingAssistantSegment: PendingAssistantSegment | undefined;
  let compactionInProgress = false;
  let compactionOwnedActivity = false;
  const ensureActivity = (
    activeTelegramTarget?: TelegramActivityTarget,
  ): string => {
    if (activityId) return activityId;
    nextActivityNumber += 1;
    activityId = `${deps.generation}:${nextActivityNumber}`;
    activitySource = activeTelegramTarget
      ? "telegram"
      : pendingInputSource === "interactive" || pendingInputSource === "rpc"
        ? "local"
        : pendingInputSource === "extension"
          ? "autonomous"
          : "unknown";
    activityTarget = activeTelegramTarget
      ? cloneActivityTarget(activeTelegramTarget)
      : undefined;
    sequence = 0;
    pendingInputSource = "unknown";
    return activityId;
  };
  const emit = (event: TelegramActivityPayload): void => {
    const currentActivityId = ensureActivity();
    sequence += 1;
    const normalizedEvent = {
      ...event,
      activityId: currentActivityId,
      sequence,
      source: activitySource,
      ...(activityTarget ? { target: activityTarget } : {}),
      timestamp: now(),
    } as TelegramActivityEvent;
    try {
      deps.observeEvent?.(normalizedEvent);
    } catch (error) {
      deps.recordObserverFailure?.(normalizedEvent, error);
    }
    deps.dispatcher.dispatch(normalizedEvent);
  };
  const flushPendingSegment = (
    placement: "intermediate" | "final" | "terminal-partial",
  ): void => {
    const segment = pendingAssistantSegment;
    pendingAssistantSegment = undefined;
    if (!segment?.text.trim()) return;
    emit({
      type: "assistant-segment",
      contentIndex: segment.contentIndex,
      text: segment.text,
      placement,
    });
  };
  const clearActivity = (): void => {
    activityId = undefined;
    activitySource = "unknown";
    activityTarget = undefined;
    sequence = 0;
    pendingAssistantSegment = undefined;
    compactionInProgress = false;
    compactionOwnedActivity = false;
  };
  const abandonCompaction = (): void => {
    if (!compactionInProgress) return;
    const shouldClearActivity = compactionOwnedActivity;
    compactionInProgress = false;
    compactionOwnedActivity = false;
    if (shouldClearActivity) clearActivity();
  };
  return {
    recordInputSource(source) {
      pendingInputSource = source;
    },
    onAgentStart(activeTelegramTarget) {
      abandonCompaction();
      ensureActivity(activeTelegramTarget);
      emit({ type: "agent-start" });
    },
    onAssistantEvent(event) {
      if (event.type === "text_start") {
        flushPendingSegment("intermediate");
        return;
      }
      if (event.type === "text_delta") {
        if (!event.delta) return;
        emit({
          type: "assistant-text-delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
        });
        return;
      }
      if (event.type === "text_end") {
        pendingAssistantSegment = {
          contentIndex: event.contentIndex,
          text: event.content,
        };
        return;
      }
      if (event.type === "thinking_delta") {
        if (!event.delta) return;
        emit({
          type: "reasoning-delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
        });
        return;
      }
      if (event.type === "thinking_end") {
        if (!event.content.trim()) return;
        emit({
          type: "reasoning-end",
          contentIndex: event.contentIndex,
          text: event.content,
        });
        return;
      }
      if (event.type === "toolcall_start") {
        flushPendingSegment("intermediate");
        return;
      }
      if (event.type === "done") {
        flushPendingSegment("final");
        return;
      }
      if (event.type === "error") flushPendingSegment("terminal-partial");
    },
    onToolStart(event) {
      emit({ type: "tool-start", ...event });
    },
    onToolUpdate(event) {
      emit({ type: "tool-update", ...event });
    },
    onToolEnd(event) {
      emit({ type: "tool-end", ...event });
    },
    onCompactionStart(reason) {
      abandonCompaction();
      compactionOwnedActivity = !activityId;
      compactionInProgress = true;
      ensureActivity();
      emit({ type: "compaction-start", reason });
    },
    onCompactionEnd(reason) {
      if (!compactionInProgress || !activityId) return;
      const shouldClearActivity = compactionOwnedActivity;
      compactionInProgress = false;
      compactionOwnedActivity = false;
      emit({ type: "compaction-end", reason });
      if (shouldClearActivity) clearActivity();
    },
    onCompactionAbandoned() {
      abandonCompaction();
    },
    onAgentEnd() {
      if (activityId) emit({ type: "agent-end" });
    },
    onAgentSettled() {
      if (!activityId) return;
      flushPendingSegment("terminal-partial");
      emit({ type: "agent-settled" });
      clearActivity();
    },
    onSessionShutdown() {
      pendingInputSource = "unknown";
      clearActivity();
      deps.dispatcher.stop();
    },
  };
}

// --- Public Assistant Output Projection ---

export interface TelegramAssistantOutputRuntime {
  start: () => void;
  accept: (event: TelegramAssistantSegmentEvent) => void;
  waitForIdle: () => Promise<void>;
  stop: () => void;
}

export function createTelegramAssistantOutputRuntime<TAuthority = undefined>(deps: {
  isEnabled: () => boolean;
  captureAuthority?: () => TAuthority;
  isAuthorityActive?: (authority: TAuthority) => boolean;
  canDeliver: (event: TelegramAssistantSegmentEvent) => boolean;
  send: (
    event: TelegramAssistantSegmentEvent,
    authority: TAuthority,
    isAuthorityActive: () => boolean,
  ) => Promise<void>;
  recordFailure?: (
    event: TelegramAssistantSegmentEvent,
    error: unknown,
  ) => void;
}): TelegramAssistantOutputRuntime {
  let generation = 0;
  let running = false;
  let tail: Promise<void> = Promise.resolve();
  const admitted = new Set<string>();
  const isEligibleSource = (
    source: TelegramAssistantSegmentEvent["source"],
  ): boolean => source === "local" || source === "autonomous";

  return {
    start() {
      generation += 1;
      running = true;
      admitted.clear();
      tail = Promise.resolve();
    },
    accept(event) {
      if (!running || !deps.isEnabled()) return;
      if (!isEligibleSource(event.source) || !event.text.trim()) return;
      const key = `${event.activityId}:${event.sequence}`;
      if (admitted.has(key)) return;
      admitted.add(key);
      const admittedGeneration = generation;
      const admittedAuthority = deps.captureAuthority?.();
      tail = tail.then(async () => {
        const isAdmittedAuthorityActive = () =>
          running &&
          generation === admittedGeneration &&
          deps.isEnabled() &&
          (deps.isAuthorityActive === undefined ||
            deps.isAuthorityActive(admittedAuthority as TAuthority));
        if (!isAdmittedAuthorityActive() || !deps.canDeliver(event)) return;
        try {
          await deps.send(
            event,
            admittedAuthority as TAuthority,
            isAdmittedAuthorityActive,
          );
        } catch (error) {
          deps.recordFailure?.(event, error);
        }
      });
    },
    waitForIdle() {
      return tail;
    },
    stop() {
      generation += 1;
      running = false;
      admitted.clear();
    },
  };
}
