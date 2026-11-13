/**
 * Telegram preview streaming helpers
 * Zones: telegram outbound, native rich markdown drafts
 * Owns safe draft preview selection, runtime updates, and preview finalization
 * The streaming state machine is a pure transition function driven by one imperative shell per runtime.
 */

import type { TelegramAssistantOutputPreparation } from "./activity.ts";
import * as Machine from "./machine.ts";
import { stripTelegramCommentMarkupForPreview } from "./outbound-markup.ts";
import {
  isTelegramMarkdownFenceClosing,
  normalizeTelegramNativeMarkdown,
  parseTelegramMarkdownFenceOpening,
  type TelegramMarkdownFence,
} from "./replies.ts";
import {
  getTelegramTargetThreadParams,
  type TelegramTarget,
} from "./target.ts";
import { shouldSuppressPreviewForVoice } from "./voice.ts";

const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_DRAFT_PREVIEW_MAX_CHARS = 4096;
// Native draft cadence: at most one frame per interval, and a fresh preview
// segment holds its first frame for one full interval so the opening frame is
// an accumulated passage rather than a single streamed word.
const TELEGRAM_DRAFT_INTERVAL_MS = 2_000;

export interface TelegramPreviewState {
  mode: "draft";
  draftId?: number;
  pendingText: string;
  lastSentText: string;
}

/** One immutable preview segment; a replacement segment gets a new id, so late results for an old one are dropped. */
export interface TelegramPreviewSegment extends Readonly<TelegramPreviewState> {
  readonly id: number;
  readonly sealed: boolean;
}

export type TelegramPreviewReplyMarkup = unknown;

type TelegramDraftSender = (
  chatId: number,
  draftId: number,
  text?: string,
  options?: {
    parse_mode?: string;
    entities?: unknown[];
    message_thread_id?: number;
  },
) => Promise<unknown>;

type TelegramPreviewEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

export interface TelegramPreviewActiveTurn {
  chatId: number;
  replyToMessageId?: number;
  target?: TelegramTarget;
  voiceReplyPreferred?: boolean;
  voiceReplyRequired?: boolean;
  guestQueryId?: string;
}

export interface TelegramAssistantMessagePreviewHookEvent<TMessage> {
  message: TMessage;
}

export interface TelegramAssistantMessagePreviewHooks<TMessage> {
  onMessageStart: (
    event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
  onMessageUpdate: (
    event: TelegramAssistantMessagePreviewHookEvent<TMessage>,
  ) => Promise<void>;
}

export interface TelegramPreviewControllerDeps {
  getDefaultReplyToMessageId?: () => number | undefined;
  maxMessageLength?: number;
  sendDraft: TelegramDraftSender;
  canSend?: () => boolean;
  maxDraftId?: number;
  /** Throttle between draft frames; defaults to the native draft cadence. */
  minDraftIntervalMs?: number;
  recordRuntimeEvent?: TelegramPreviewEventRecorder;
}

export type TelegramPreviewTargetOptions = { target?: TelegramTarget };

export interface TelegramPreviewController {
  /** Read-only view of the current segment; it never grants mutation. */
  getState: () => TelegramPreviewSegment | undefined;
  /** True while a draft request is in flight or a pending request waits behind a publication. */
  isFlushing: () => boolean;
  seal: () => void;
  preparePublication: () => TelegramAssistantOutputPreparation | undefined;
  prepareClear: (
    chatId: number,
    options?: TelegramPreviewTargetOptions & {
      isDeliveryActive?: () => boolean;
    },
  ) => () => Promise<void>;
  setPendingText: (text: string) => void;
  resetState: () => void;
  invalidate: () => void;
  clear: (
    chatId: number,
    options?: TelegramPreviewTargetOptions & { awaitFlush?: boolean },
  ) => Promise<void>;
  flush: (
    chatId: number,
    options?: TelegramPreviewTargetOptions,
  ) => Promise<void>;
  scheduleFlush: (
    chatId: number,
    options?: TelegramPreviewTargetOptions,
  ) => void;
  finalize: (
    chatId: number,
    replyToMessageId?: number,
    options?: TelegramPreviewTargetOptions,
  ) => Promise<boolean>;
}

export interface TelegramAssistantPreviewRuntimeDeps<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> extends TelegramPreviewControllerDeps {
  getActiveTurn: () => TelegramPreviewActiveTurn | undefined;
  isAssistantMessage: (message: TMessage) => boolean;
  getMessageText: (message: TMessage) => string;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
  ) => Promise<number | undefined>;
}

type TelegramMarkdownFinalizer<TReplyMarkup> = (
  chatId: number,
  markdown: string,
  replyToMessageId?: number,
  options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
) => Promise<boolean>;

export interface TelegramPreparedPreviewDelivery<TReplyMarkup = unknown> {
  clearPreview: TelegramPreviewController["clear"];
  setPreviewPendingText: TelegramPreviewController["setPendingText"];
  finalizeMarkdownPreview: TelegramMarkdownFinalizer<TReplyMarkup>;
}

export type TelegramAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
> = TelegramPreviewController &
  TelegramAssistantMessagePreviewHooks<TMessage> & {
    prepareDelivery: (
      isDeliveryActive: () => boolean,
    ) => TelegramPreparedPreviewDelivery<TReplyMarkup>;
    finalizeMarkdown: TelegramMarkdownFinalizer<TReplyMarkup>;
  };

interface TelegramPreviewFlushRequest {
  chatId: number;
  target?: TelegramTarget;
}

interface TelegramPreviewMachineConfig {
  maxDraftId: number;
  maxMessageLength: number;
  minDraftIntervalMs: number;
}

/** The whole preview state; only `transitionTelegramPreview` produces a new one. */
export interface TelegramPreviewMachineState {
  readonly segment: TelegramPreviewSegment | null;
  /** Bumped by reset and invalidation; a result issued under an older generation is inert. */
  readonly generation: number;
  readonly nextSegmentId: number;
  readonly nextDraftId: number;
  readonly nextDraftAt: number;
  /** Segment that owns the current generation's issued draft; old-generation requests do not block it. */
  readonly inFlight: number | null;
  /** The one coalesced flush request waiting behind an in-flight draft or an open publication. */
  readonly pending: TelegramPreviewFlushRequest | null;
  readonly publications: readonly number[];
  /** The segment the throttle timer is armed for; the timer belongs to that segment alone. */
  readonly timerSegmentId: number | null;
}

/** Impure inputs the runner samples at dispatch time, so transitions stay pure. */
interface TelegramPreviewClock {
  now: number;
  canSend: boolean;
}

export type TelegramPreviewEvent =
  | { type: "reset" }
  | { type: "invalidated" }
  | { type: "segmentStarted" }
  | { type: "segmentEnsured" }
  | { type: "sealed" }
  | { type: "discarded" }
  | { type: "textSet"; text: string }
  | { type: "draftWindowOpened"; at: number }
  | ({
      type: "flushRequested";
      request: TelegramPreviewFlushRequest;
    } & TelegramPreviewClock)
  | ({
      type: "timerFired";
      request: TelegramPreviewFlushRequest;
      segmentId: number;
    } & TelegramPreviewClock)
  | ({
      type: "draftSettled";
      segmentId: number;
      generation: number;
      /** Present only when Telegram accepted the draft. */
      text?: string;
    } & TelegramPreviewClock)
  | { type: "publicationOpened"; id: number }
  | ({ type: "publicationSettled"; id: number } & TelegramPreviewClock);

export type TelegramPreviewEffect =
  | {
      type: "sendDraft";
      request: TelegramPreviewFlushRequest;
      draftId: number;
      text: string;
      segmentId: number;
      generation: number;
    }
  | {
      type: "armTimer";
      delay: number;
      request: TelegramPreviewFlushRequest;
      segmentId: number;
    }
  | { type: "cancelTimer" }
  | { type: "clearClosedGate"; request: TelegramPreviewFlushRequest };

export interface TelegramPreviewStep {
  state: TelegramPreviewMachineState;
  effects: readonly TelegramPreviewEffect[];
}

export function createTelegramPreviewMachineState(): TelegramPreviewMachineState {
  return {
    segment: null,
    generation: 0,
    nextSegmentId: 0,
    nextDraftId: 0,
    nextDraftAt: 0,
    inFlight: null,
    pending: null,
    publications: [],
    timerSegmentId: null,
  };
}

const step = (
  state: TelegramPreviewMachineState,
  ...effects: TelegramPreviewEffect[]
): TelegramPreviewStep => ({ state, effects });

/** Drops the armed throttle timer, if any; every caller replaces or seals its segment. */
const withoutTimer = (
  state: TelegramPreviewMachineState,
): TelegramPreviewStep =>
  state.timerSegmentId === null
    ? step(state)
    : step({ ...state, timerSegmentId: null }, { type: "cancelTimer" });

/** A replaced segment takes its pending request and its throttle timer with it. */
function replaceSegment(
  state: TelegramPreviewMachineState,
  segment: TelegramPreviewSegment | null,
): TelegramPreviewStep {
  return withoutTimer({ ...state, segment, pending: null });
}

function startSegment(
  state: TelegramPreviewMachineState,
  carry: Partial<TelegramPreviewState> = {},
): TelegramPreviewStep {
  const id = state.nextSegmentId + 1;
  return replaceSegment(
    { ...state, nextSegmentId: id },
    {
      id,
      mode: "draft",
      pendingText: "",
      lastSentText: "",
      sealed: false,
      ...carry,
    },
  );
}

/** One flush attempt for the current segment: gate, throttle, safe snapshot and draft id. */
function attemptFlush(
  state: TelegramPreviewMachineState,
  request: TelegramPreviewFlushRequest,
  clock: TelegramPreviewClock,
  config: TelegramPreviewMachineConfig,
): TelegramPreviewStep {
  const segment = state.segment;
  if (!segment || segment.sealed) return step(state);
  if (!clock.canSend) return step(state, { type: "clearClosedGate", request });
  const delay = state.nextDraftAt - clock.now;
  if (delay > 0) {
    if (state.timerSegmentId !== null) return step(state);
    return step(
      { ...state, timerSegmentId: segment.id },
      { type: "armTimer", delay, request, segmentId: segment.id },
    );
  }
  const idle = withoutTimer(state);
  const snapshot = buildTelegramNativeMarkdownPreviewSnapshot(
    segment,
    config.maxMessageLength,
  );
  if (!snapshot) return idle;
  const draftId =
    segment.draftId ??
    allocateTelegramDraftId(state.nextDraftId, config.maxDraftId);
  return {
    state: {
      ...idle.state,
      segment: { ...segment, draftId },
      nextDraftId: segment.draftId === undefined ? draftId : state.nextDraftId,
      nextDraftAt: clock.now + config.minDraftIntervalMs,
      inFlight: segment.id,
    },
    effects: [
      ...idle.effects,
      {
        type: "sendDraft",
        request,
        draftId,
        text: snapshot.text,
        segmentId: segment.id,
        generation: state.generation,
      },
    ],
  };
}

/** Single flight: a request during an in-flight draft or behind a publication waits as the one pending request. */
function requestFlush(
  state: TelegramPreviewMachineState,
  request: TelegramPreviewFlushRequest,
  clock: TelegramPreviewClock,
  config: TelegramPreviewMachineConfig,
): TelegramPreviewStep {
  // Only a live, unsealed segment accepts flush requests, whatever the caller checked.
  if (!state.segment || state.segment.sealed) return step(state);
  if (state.inFlight !== null || state.publications.length > 0)
    return step({ ...state, pending: request });
  return attemptFlush(state, request, clock, config);
}

/** A coalesced request runs once the in-flight draft and every open publication have settled. */
function drainPending(
  state: TelegramPreviewMachineState,
  clock: TelegramPreviewClock,
  config: TelegramPreviewMachineConfig,
): TelegramPreviewStep {
  const request = state.pending;
  if (!request || state.inFlight !== null || state.publications.length > 0)
    return step(state);
  return attemptFlush({ ...state, pending: null }, request, clock, config);
}

export function transitionTelegramPreview(
  state: TelegramPreviewMachineState,
  event: TelegramPreviewEvent,
  config: TelegramPreviewMachineConfig,
): TelegramPreviewStep {
  switch (event.type) {
    case "reset":
    case "invalidated": {
      const replacement = {
        ...state,
        generation: state.generation + 1,
        inFlight: null,
        publications: [],
        nextDraftAt: 0,
      };
      return event.type === "reset"
        ? startSegment(replacement)
        : replaceSegment(replacement, null);
    }
    case "segmentStarted": {
      // Carry the previous delivery boundary; permanent text remains with its publication owner.
      const draftId = state.segment?.draftId;
      return startSegment(state, draftId === undefined ? {} : { draftId });
    }
    case "segmentEnsured":
      return state.segment ? step(state) : startSegment(state);
    case "sealed": {
      const segment = state.segment;
      return withoutTimer({
        ...state,
        segment:
          segment && !segment.sealed ? { ...segment, sealed: true } : segment,
        pending: null,
      });
    }
    case "discarded":
      return replaceSegment(state, null);
    case "textSet":
      return state.segment
        ? step({
            ...state,
            segment: { ...state.segment, pendingText: event.text },
          })
        : step(state);
    case "draftWindowOpened":
      return step({
        ...state,
        nextDraftAt: Math.max(state.nextDraftAt, event.at),
      });
    case "flushRequested":
      return requestFlush(state, event.request, event, config);
    case "timerFired": {
      if (
        state.timerSegmentId !== event.segmentId ||
        state.segment?.id !== event.segmentId
      )
        return step(state);
      return requestFlush(
        { ...state, timerSegmentId: null },
        event.request,
        event,
        config,
      );
    }
    case "draftSettled": {
      if (
        state.generation !== event.generation ||
        state.inFlight !== event.segmentId
      )
        return step(state);
      const segment = state.segment;
      // A delivered draft updates only the segment and generation that issued it.
      const applies =
        event.text !== undefined &&
        segment?.id === event.segmentId &&
        event.canSend;
      return drainPending(
        {
          ...state,
          inFlight: null,
          segment:
            applies && segment
              ? { ...segment, lastSentText: event.text! }
              : segment,
        },
        event,
        config,
      );
    }
    case "publicationOpened":
      return step({
        ...state,
        publications: [...state.publications, event.id],
      });
    case "publicationSettled":
      if (!state.publications.includes(event.id)) return step(state);
      return drainPending(
        {
          ...state,
          publications: state.publications.filter((id) => id !== event.id),
        },
        event,
        config,
      );
  }
}

/** True while a draft request is in flight, or, when publications block, a pending request waits behind one. */
export function isTelegramPreviewBusy(
  state: TelegramPreviewMachineState,
  blockedByPublication = true,
): boolean {
  return (
    state.inFlight !== null ||
    (blockedByPublication &&
      state.pending !== null &&
      state.publications.length > 0)
  );
}

/**
 * The imperative shell around `transitionTelegramPreview`: it samples the clock and send gate into events, runs
 * effects, records every transport failure in one place and resolves promise-shaped ports through `waitFor`.
 */
function createTelegramPreviewModel(deps: TelegramPreviewControllerDeps) {
  const config: TelegramPreviewMachineConfig = {
    maxDraftId: deps.maxDraftId ?? TELEGRAM_DRAFT_ID_MAX,
    maxMessageLength: deps.maxMessageLength ?? TELEGRAM_DRAFT_PREVIEW_MAX_CHARS,
    minDraftIntervalMs: deps.minDraftIntervalMs ?? TELEGRAM_DRAFT_INTERVAL_MS,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publicationIds = 0;
  const clock = (): TelegramPreviewClock => ({
    now: Date.now(),
    canSend: deps.canSend?.() !== false,
  });
  const machine = Machine.createTelegramMachineRunner<
    TelegramPreviewMachineState,
    TelegramPreviewEvent,
    TelegramPreviewEffect
  >({
    initial: createTelegramPreviewMachineState(),
    transition: (state, event) =>
      transitionTelegramPreview(state, event, config),
    run: (effect) => run(effect),
  });
  const { dispatch, waitFor } = machine;
  const whenIdle = (): Promise<void> => {
    const generation = machine.state.generation;
    return waitFor(
      (current) =>
        current.generation !== generation || !isTelegramPreviewBusy(current),
    );
  };
  /** Captures predecessors only: a later draft/publication must never extend the boundary that blocks it. */
  const whenBoundarySettles = (includePublications = true): Promise<void> => {
    const { generation, inFlight, publications } = machine.state;
    return waitFor(
      (current) =>
        current.generation !== generation ||
        ((inFlight === null || current.inFlight !== inFlight) &&
          (!includePublications ||
            publications.every((id) => !current.publications.includes(id)))),
    );
  };
  const canSendFor = (generation: number): boolean =>
    machine.state.generation === generation && deps.canSend?.() !== false;

  /** The one place preview transport failures become diagnostics; a failed call reports `false`. */
  const callTransport = async (
    phase: "draft" | "clear-draft",
    request: TelegramPreviewFlushRequest,
    draftId: number,
    text: string | undefined,
  ): Promise<unknown> => {
    try {
      return await deps.sendDraft(request.chatId, draftId, text, {
        ...getTelegramTargetThreadParams(
          request.target ?? { chatId: request.chatId },
        ),
      });
    } catch (error) {
      deps.recordRuntimeEvent?.("preview", error, {
        phase,
        chatId: request.chatId,
        draftId,
      });
      return false;
    }
  };
  const sendDraft = async (
    effect: Extract<TelegramPreviewEffect, { type: "sendDraft" }>,
  ): Promise<void> => {
    const delivered = await callTransport(
      "draft",
      effect.request,
      effect.draftId,
      normalizeTelegramNativeMarkdown(effect.text),
    );
    dispatch({
      type: "draftSettled",
      segmentId: effect.segmentId,
      generation: effect.generation,
      ...(delivered === false ? {} : { text: effect.text }),
      ...clock(),
    });
  };
  const run = (effect: TelegramPreviewEffect): void => {
    switch (effect.type) {
      case "sendDraft":
        void sendDraft(effect);
        return;
      case "armTimer":
        timer = setTimeout(() => {
          timer = undefined;
          dispatch({
            type: "timerFired",
            request: effect.request,
            segmentId: effect.segmentId,
            ...clock(),
          });
        }, effect.delay);
        timer.unref?.();
        return;
      case "cancelTimer":
        if (timer) clearTimeout(timer);
        timer = undefined;
        return;
      case "clearClosedGate":
        void clear(effect.request.chatId, {
          awaitFlush: false,
          target: effect.request.target,
        });
        return;
    }
  };

  const seal = (): void => {
    dispatch({ type: "sealed" });
  };

  const clear = async (
    chatId: number,
    options: TelegramPreviewTargetOptions & {
      awaitFlush?: boolean;
      isDeliveryActive?: () => boolean;
    } = {},
    generation = machine.state.generation,
  ): Promise<void> => {
    const segment = machine.state.segment;
    if (!segment || options.isDeliveryActive?.() === false) return;
    seal();
    if (machine.state.inFlight !== null && options.awaitFlush !== false) {
      await whenBoundarySettles(false);
      if (machine.state.segment?.id !== segment.id) return;
    }
    if (options.isDeliveryActive?.() === false) return;
    const issued = machine.state.segment ?? segment;
    dispatch({ type: "discarded" });
    if (issued.draftId !== undefined && canSendFor(generation))
      await callTransport(
        "clear-draft",
        { chatId, target: options.target },
        issued.draftId,
        undefined,
      );
  };

  const flush = async (
    chatId: number,
    options: TelegramPreviewTargetOptions = {},
  ): Promise<void> => {
    if (!machine.state.segment || machine.state.segment.sealed) return;
    dispatch({
      type: "flushRequested",
      request: { chatId, target: options.target },
      ...clock(),
    });
    await whenIdle();
  };

  const prepareFinalizer = <TReplyMarkup>(input: {
    sendMarkdownReply: TelegramAssistantPreviewRuntimeDeps<
      unknown,
      TReplyMarkup
    >["sendMarkdownReply"];
    isDeliveryActive?: () => boolean;
  }): TelegramMarkdownFinalizer<TReplyMarkup> => {
    const segmentId = machine.state.segment?.id;
    const generation = machine.state.generation;
    seal();
    const predecessors = whenBoundarySettles();
    return async (chatId, markdown, replyToMessageId, options) => {
      if (input.isDeliveryActive?.() === false) return false;
      await predecessors;
      if (
        machine.state.generation !== generation ||
        machine.state.segment?.id !== segmentId ||
        input.isDeliveryActive?.() === false
      )
        return false;
      await input.sendMarkdownReply(
        chatId,
        replyToMessageId,
        markdown,
        options,
      );
      if (
        machine.state.segment?.id === segmentId &&
        input.isDeliveryActive?.() !== false
      )
        dispatch({ type: "discarded" });
      return true;
    };
  };

  const controller: TelegramPreviewController = {
    getState: () => machine.state.segment ?? undefined,
    isFlushing: () => isTelegramPreviewBusy(machine.state),
    seal,
    setPendingText: (text) => dispatch({ type: "textSet", text }),
    resetState: () => dispatch({ type: "reset" }),
    invalidate: () => dispatch({ type: "invalidated" }),
    preparePublication: () => {
      if (!machine.state.segment) return undefined;
      seal();
      const id = (publicationIds += 1);
      const prior = whenBoundarySettles();
      dispatch({ type: "publicationOpened", id });
      let settled = false;
      return {
        wait: () => prior,
        settle: () => {
          if (settled) return;
          settled = true;
          dispatch({ type: "publicationSettled", id, ...clock() });
        },
      };
    },
    prepareClear: (chatId, options) => {
      const admitted = machine.state.segment?.id;
      const generation = machine.state.generation;
      return async () => {
        if (machine.state.segment?.id !== admitted) return;
        await clear(
          chatId,
          {
            ...options,
            isDeliveryActive: () =>
              canSendFor(generation) && options?.isDeliveryActive?.() !== false,
          },
          generation,
        );
      };
    },
    clear: (chatId, options) => clear(chatId, options),
    flush,
    scheduleFlush: (chatId, options) => {
      if (!machine.state.segment) return;
      void flush(chatId, options);
    },
    finalize: async (chatId, _replyToMessageId, options) => {
      const segment = machine.state.segment;
      if (!segment) return false;
      if (!canSendFor(machine.state.generation)) {
        await clear(chatId, options);
        return false;
      }
      await flush(chatId, options);
      const current = machine.state.segment;
      if (current?.id !== segment.id) return false;
      const finalText = buildTelegramPreviewFinalText(current);
      if (!finalText) {
        await clear(chatId, options);
        return false;
      }
      dispatch({ type: "discarded" });
      return false;
    },
  };
  return {
    controller,
    prepareFinalizer,
    startSegment: (): void => {
      dispatch({ type: "segmentStarted" });
    },
    ensureSegment: (): TelegramPreviewSegment => {
      dispatch({ type: "segmentEnsured" });
      return machine.state.segment!;
    },
    openDraftWindow: (at: number): void => {
      dispatch({ type: "draftWindowOpened", at });
    },
    discard: (): void => {
      dispatch({ type: "discarded" });
    },
  };
}

export function createTelegramPreviewController(
  deps: TelegramPreviewControllerDeps,
): TelegramPreviewController {
  return createTelegramPreviewModel(deps).controller;
}

/**
 * Returns true when the active turn is a Telegram Guest Mode query. A guest
 * query allows exactly one answer within a limited Telegram response window,
 * so it must never emit streaming draft previews.
 */
export function shouldSuppressPreviewForGuestTurn(
  turn: { guestQueryId?: string } | null | undefined,
): boolean {
  return !!turn?.guestQueryId;
}

export function createTelegramAssistantPreviewRuntime<
  TMessage,
  TReplyMarkup = TelegramPreviewReplyMarkup,
>(
  deps: TelegramAssistantPreviewRuntimeDeps<TMessage, TReplyMarkup>,
): TelegramAssistantPreviewRuntime<TMessage, TReplyMarkup> {
  const model = createTelegramPreviewModel(deps);
  const { controller } = model;
  const suppressed = (turn: TelegramPreviewActiveTurn): boolean =>
    shouldSuppressPreviewForVoice(turn) ||
    shouldSuppressPreviewForGuestTurn(turn);
  return {
    ...controller,
    finalizeMarkdown: (...args) =>
      model.prepareFinalizer<TReplyMarkup>({
        sendMarkdownReply: deps.sendMarkdownReply,
      })(...args),
    prepareDelivery(isDeliveryActive) {
      const admitted = controller.getState()?.id;
      return {
        setPreviewPendingText(text) {
          if (controller.getState()?.id === admitted && isDeliveryActive())
            controller.setPendingText(text);
        },
        clearPreview: async (chatId, options) => {
          if (controller.getState()?.id !== admitted || !isDeliveryActive())
            return;
          await controller.prepareClear(chatId, {
            ...options,
            isDeliveryActive,
          })();
        },
        finalizeMarkdownPreview: model.prepareFinalizer<TReplyMarkup>({
          sendMarkdownReply: deps.sendMarkdownReply,
          isDeliveryActive,
        }),
      };
    },
    onMessageStart: async ({ message }) => {
      const turn = deps.getActiveTurn();
      if (!turn || !deps.isAssistantMessage(message)) return;
      if ((deps.canSend && !deps.canSend()) || suppressed(turn)) {
        model.discard();
        return;
      }
      model.startSegment();
    },
    onMessageUpdate: async ({ message }) => {
      const turn = deps.getActiveTurn();
      if (!turn || !deps.isAssistantMessage(message)) return;
      if (deps.canSend && !deps.canSend()) {
        model.discard();
        return;
      }
      if (suppressed(turn)) return;
      const segment = model.ensureSegment();
      if (segment.sealed) return;
      const hadVisibleText = segment.pendingText.length > 0;
      const pendingText = stripTelegramCommentMarkupForPreview(
        deps.getMessageText(message),
      );
      controller.setPendingText(pendingText);
      // The first visible text of a preview segment opens an initial accumulation
      // window, so the segment's first frame cannot ship as a single word even
      // when the previous cadence boundary has already passed (fresh turn, slow
      // first token, or message rollover after tool work). Later deltas keep the
      // trailing deadline instead of sliding it on every update.
      const interval = deps.minDraftIntervalMs ?? TELEGRAM_DRAFT_INTERVAL_MS;
      if (
        interval > 0 &&
        !hadVisibleText &&
        !segment.lastSentText &&
        pendingText.length > 0
      )
        model.openDraftWindow(Date.now() + interval);
      controller.scheduleFlush(turn.chatId, { target: turn.target });
    },
  };
}

export function buildTelegramPreviewFinalText(
  state: TelegramPreviewState,
): string | undefined {
  const finalText = state.pendingText.trim();
  if (finalText) return finalText;
  return state.lastSentText.trim() || undefined;
}

export function allocateTelegramDraftId(
  currentDraftId: number,
  maxDraftId: number,
): number {
  return currentDraftId >= maxDraftId ? 1 : currentDraftId + 1;
}

interface TelegramDraftInlineState {
  codeTicks: number;
  htmlComment: boolean;
  displayMath: boolean;
  fence?: TelegramMarkdownFence;
  strongAsterisk: boolean;
  emphasisAsterisk: boolean;
  strongUnderscore: boolean;
  emphasisUnderscore: boolean;
  strike: boolean;
  linkText: boolean;
  linkDestination: boolean;
}

function createTelegramDraftInlineState(): TelegramDraftInlineState {
  return {
    codeTicks: 0,
    htmlComment: false,
    displayMath: false,
    strongAsterisk: false,
    emphasisAsterisk: false,
    strongUnderscore: false,
    emphasisUnderscore: false,
    strike: false,
    linkText: false,
    linkDestination: false,
  };
}

function isTelegramDraftInlineStateClosed(
  state: TelegramDraftInlineState,
): boolean {
  return (
    state.codeTicks === 0 &&
    !state.htmlComment &&
    !state.displayMath &&
    !state.fence &&
    !state.strongAsterisk &&
    !state.emphasisAsterisk &&
    !state.strongUnderscore &&
    !state.emphasisUnderscore &&
    !state.strike &&
    !state.linkText &&
    !state.linkDestination
  );
}

function countRepeatedChars(text: string, index: number, char: string): number {
  let count = 0;
  while (text[index + count] === char) count += 1;
  return count;
}

function isEscapedMarkdownChar(text: string, index: number): boolean {
  let slashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isInlineDelimiterCandidate(
  text: string,
  index: number,
  length: number,
): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + length] ?? "";
  if (!next || /\s/.test(next))
    return previous.length > 0 && !/\s/.test(previous);
  if (!previous || /\s/.test(previous)) return true;
  return /[\p{P}\p{S}]/u.test(previous) || /[\p{P}\p{S}]/u.test(next);
}

function updateTelegramDraftInlineStateForLine(
  line: string,
  state: TelegramDraftInlineState,
): void {
  if (state.fence || state.displayMath) return;
  for (let index = 0; index < line.length; index += 1) {
    if (state.htmlComment) {
      const closeIndex = line.indexOf("-->", index);
      if (closeIndex === -1) return;
      state.htmlComment = false;
      index = closeIndex + 2;
      continue;
    }
    if (state.codeTicks > 0) {
      const ticks = countRepeatedChars(line, index, "`");
      if (ticks >= state.codeTicks) {
        state.codeTicks = 0;
        index += ticks - 1;
      }
      continue;
    }
    if (isEscapedMarkdownChar(line, index)) continue;
    if (line.startsWith("<!--", index)) {
      const closeIndex = line.indexOf("-->", index + 4);
      if (closeIndex === -1) {
        state.htmlComment = true;
        return;
      }
      index = closeIndex + 2;
      continue;
    }
    const ticks = countRepeatedChars(line, index, "`");
    if (ticks > 0) {
      state.codeTicks = ticks;
      index += ticks - 1;
      continue;
    }
    if (line.startsWith("][", index) || line.startsWith("](", index)) {
      state.linkText = false;
      state.linkDestination = true;
      index += 1;
      continue;
    }
    if (line[index] === "[" && !state.linkDestination) {
      state.linkText = true;
      continue;
    }
    if (line[index] === ")" && state.linkDestination) {
      state.linkDestination = false;
      continue;
    }
    if (
      line.startsWith("~~", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strike = !state.strike;
      index += 1;
      continue;
    }
    if (
      line.startsWith("**", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strongAsterisk = !state.strongAsterisk;
      index += 1;
      continue;
    }
    if (line[index] === "*" && isInlineDelimiterCandidate(line, index, 1)) {
      state.emphasisAsterisk = !state.emphasisAsterisk;
      continue;
    }
    if (
      line.startsWith("__", index) &&
      isInlineDelimiterCandidate(line, index, 2)
    ) {
      state.strongUnderscore = !state.strongUnderscore;
      index += 1;
      continue;
    }
    if (line[index] === "_" && isInlineDelimiterCandidate(line, index, 1)) {
      state.emphasisUnderscore = !state.emphasisUnderscore;
    }
  }
}

function updateTelegramDraftBlockStateForLine(
  line: string,
  state: TelegramDraftInlineState,
): boolean {
  if (state.fence) {
    if (isTelegramMarkdownFenceClosing(line, state.fence)) {
      state.fence = undefined;
    }
    return true;
  }
  if (state.displayMath) {
    if (line.trim() === "$$") state.displayMath = false;
    return true;
  }
  const openingFence = parseTelegramMarkdownFenceOpening(line);
  if (openingFence) {
    state.fence = openingFence;
    return true;
  }
  if (line.trim() === "$$") {
    state.displayMath = true;
    return true;
  }
  return false;
}

function findSafeTelegramRichMarkdownDraftEnd(markdown: string): number {
  const state = createTelegramDraftInlineState();
  let offset = 0;
  let safeEnd = 0;
  for (const line of markdown.split("\n")) {
    const lineEnd = offset + line.length;
    const consumedAsBlock = updateTelegramDraftBlockStateForLine(line, state);
    if (!consumedAsBlock) updateTelegramDraftInlineStateForLine(line, state);
    const nextOffset = lineEnd + 1;
    if (isTelegramDraftInlineStateClosed(state)) safeEnd = lineEnd;
    offset = nextOffset;
  }
  if (isTelegramDraftInlineStateClosed(state)) return markdown.length;
  return safeEnd;
}

function hasTelegramPreviewVisibleContent(markdown: string): boolean {
  return /[\p{L}\p{N}]/u.test(markdown);
}

export function getSafeTelegramRichMarkdownDraftPrefix(
  markdown: string,
  maxMessageLength: number,
): string | undefined {
  const source = markdown.trim();
  if (!source) return undefined;
  const limited =
    source.length > maxMessageLength
      ? source.slice(0, maxMessageLength)
      : source;
  const safeEnd = findSafeTelegramRichMarkdownDraftEnd(limited);
  if (safeEnd > 0) {
    const safePrefix = limited.slice(0, safeEnd).trimEnd();
    return hasTelegramPreviewVisibleContent(safePrefix)
      ? safePrefix
      : undefined;
  }
  let candidateEnd = limited.length;
  while (candidateEnd > 0) {
    candidateEnd = limited.lastIndexOf(" ", candidateEnd - 1);
    if (candidateEnd <= 0) return undefined;
    const candidate = limited.slice(0, candidateEnd).trimEnd();
    if (
      hasTelegramPreviewVisibleContent(candidate) &&
      findSafeTelegramRichMarkdownDraftEnd(candidate) === candidate.length
    ) {
      return candidate || undefined;
    }
  }
  return undefined;
}

function buildTelegramNativeMarkdownPreviewSnapshot(
  state: TelegramPreviewState,
  maxMessageLength: number,
): { text: string } | undefined {
  const safeText = getSafeTelegramRichMarkdownDraftPrefix(
    state.pendingText,
    maxMessageLength,
  );
  if (!safeText || safeText === state.lastSentText) return undefined;
  return { text: safeText };
}
