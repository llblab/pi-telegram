/**
 * Telegram outbound button helpers
 * Zones: telegram outbound, assistant markup, callback routing
 * Owns assistant-authored telegram_button extraction, button action storage, callback handling, and prompt-turn construction
 */

import { randomUUID } from "node:crypto";
import { getGenerativeAppRefreshPublicationSource, type GenerativeAppCallbackOwner } from "./generative-apps.ts";
import { TELEGRAM_QUESTION_TAIL_MS, type TelegramQuestionLifetimeOwner } from "./delivery.ts";
import { renderTelegramMessage, splitTelegramNativeMarkdown, parseTelegramMarkdownFenceOpening, isTelegramMarkdownFenceClosing, type TelegramMarkdownFence } from "./replies.ts";

import type {
  TelegramInlineKeyboardButtonStyle,
  TelegramInlineKeyboardMarkup,
} from "./keyboard.ts";
import {
  getTelegramActionString as getTelegramButtonString,
  parseTelegramActionPayloadRows,
  parseTelegramButtonPayloadRows,
  parseTelegramUiDeclaration,
  type TelegramUiChoiceQuestion,
  replaceTelegramButtonFences,
  replaceTelegramHtmlComments,
  stripTelegramCommentMarkupForDelivery,
} from "./outbound-markup.ts";
import {
  type PendingTelegramTurn,
  type TelegramQueueTarget,
  truncateTelegramQueueSummary,
} from "./queue.ts";

const TELEGRAM_BUTTON_CALLBACK_PREFIX = "tgbtn";
const PUBLICATION_SOURCE_KEY = Symbol("native original publication source");
const TELEGRAM_BUTTON_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_BUTTON_EXPIRED_CALLBACK = "tgbtn:expired";
const TELEGRAM_BUTTON_CAPACITY_CALLBACK = "tgbtn:capacity";
type TelegramButtonRetirementReason = "deadline" | "capacity" | "consumed" | "owner-lost" | "publication-lost" | "clear" | "superseded" | "admission-failed";
const TELEGRAM_BUTTON_ACTION_CAPACITY = 60;

export interface TelegramOutboundButtonBinding {
  assertCurrent?: () => void;
  generation: string;
  app: string;
  revision: number;
}

export interface TelegramOutboundButtonAction {
  text: string;
  prompt: string;
  /** Compiler-owned routing class; selection values never enter the bound-method parser. */
  promptKind?: "selection";
  /** Process-local finite collector; never serialized into a prompt or SDK result. */
  selection?: TelegramButtonSelectionAction;
  /** One structured question; ordinary prompt peers intentionally have no shared completion group. */
  completionGroup?: TelegramButtonCompletionGroup;
  /** Store-produced consumed callback IDs used only to retire the old keyboard. */
  completedCallbacks?: readonly string[];
  /** The publication owner, not a stale callback query, owns all visual retirement. */
  publicationManaged?: true;
  binding?: TelegramOutboundButtonBinding;
  selectedStyle?: TelegramInlineKeyboardButtonStyle;
  disabled?: true;
  /** Optional declaration deadline; enforced by the existing action store, without another timer. */
  expiresAt?: number;
}

/** @internal Exact native store dispatch origin, not invocation/result or footer-transition authority. */
export interface TelegramOrdinaryCallbackDispatch {
  readonly binding: TelegramOutboundButtonBinding;
  readonly prompt: string;
  readonly assertCurrent: () => void;
  readonly assertObservedCurrent: () => void;
  /** @internal One exact native invocation; not an effect executor. */
  readonly takeInvocation?: () => object | undefined;
  readonly captureReadOnlySuccessor?: (binding: unknown, invocation: unknown) => Readonly<GenerativeAppCallbackOwner> | undefined;
}
const ORDINARY_DISPATCH_KEY = Symbol("native ordinary callback dispatch");
const NativeDispatchWeakRef = WeakRef, readDispatchWeakRef = WeakRef.prototype.deref;
class NativeOrdinaryCallbackAction implements TelegramOutboundButtonAction {
  declare text: string;
  declare prompt: string;
  #capture?: (query: unknown) => Readonly<TelegramOrdinaryCallbackDispatch> | undefined;
  constructor(key: symbol, fields: TelegramOutboundButtonAction, capture: (query: unknown) => Readonly<TelegramOrdinaryCallbackDispatch> | undefined) {
    if (key !== ORDINARY_DISPATCH_KEY) throw new Error("Telegram ordinary callback dispatch is unavailable.");
    Object.assign(this, fields); this.#capture = capture; Object.freeze(this);
  }
  static hasOrigin(key: symbol, action: unknown): boolean {
    if (key !== ORDINARY_DISPATCH_KEY) return false;
    try { return #capture in (action as NativeOrdinaryCallbackAction); } catch { return false; }
  }
  static take(key: symbol, action: unknown, query: unknown): Readonly<TelegramOrdinaryCallbackDispatch> | undefined {
    if (key !== ORDINARY_DISPATCH_KEY) return undefined;
    try {
      const native = action as NativeOrdinaryCallbackAction, capture = native.#capture;
      try { return capture?.(query); }
      finally { native.#capture = undefined; }
    } catch { return undefined; }
  }
}
const takeNativeOrdinaryDispatch = NativeOrdinaryCallbackAction.take, hasNativeOrdinaryOrigin = NativeOrdinaryCallbackAction.hasOrigin;
/** @internal Classifies original versus absent provenance, including spent/refused native origins. Grants no dispatch. */
export function hasTelegramOrdinaryCallbackOrigin(action: unknown): boolean {
  return hasNativeOrdinaryOrigin(ORDINARY_DISPATCH_KEY, action);
}
/** @internal One attempt on the original resolved action/query; foreign actions are not probed. */
export function captureTelegramOrdinaryCallbackDispatch(action: unknown, query: unknown): Readonly<TelegramOrdinaryCallbackDispatch> | undefined {
  return takeNativeOrdinaryDispatch(ORDINARY_DISPATCH_KEY, action, query);
}

interface TelegramButtonQuestionDeadline {
  readonly expiresAt: number;
  readonly bindStore: (notify: () => void) => void;
  readonly shorten: (expiresAt: number) => void;
}

/** @internal Native producer deadline; no answer, SDK membership or publication authority. */
export function createTelegramButtonQuestionDeadline(expiresAt: number): Readonly<TelegramButtonQuestionDeadline> {
  let notify: (() => void) | undefined;
  return Object.freeze({ get expiresAt() { return expiresAt; },
    bindStore(original: () => void) {
      if (notify && notify !== original) throw new Error("Telegram question deadline already has an owner.");
      notify = original;
    },
    shorten(next: number) { if (next < expiresAt) { expiresAt = next; notify?.(); } },
  });
}

interface TelegramButtonCompletionGroup {
  readonly deadline?: Readonly<TelegramButtonQuestionDeadline>;
  readonly retire?: (reason?: TelegramButtonRetirementReason) => void;
  readonly complete?: (callbackData: string) => void;
}

interface TelegramButtonSelectionAction {
  readonly owner: object;
  readonly revision: number;
  readonly requiresMessageUpdate?: boolean;
  readonly prepare: (query: TelegramButtonCallbackQuery) => TelegramButtonSelectionUpdate | undefined;
}

interface TelegramButtonSelectionUpdate {
  readonly replyMarkup: TelegramOutboundButtonMarkup;
  readonly message?: { readonly markdown: string; readonly rendering: "rich" | "html" };
  readonly prompt?: string;
  readonly assertCurrent: () => void;
  readonly commit: () => void;
  readonly fail: () => void;
}

export interface TelegramOutboundButtonStoredAction extends TelegramOutboundButtonAction {
  createdAt: number;
}

export type TelegramOutboundButtonMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramButtonReplyPlan {
  markdown: string;
  replyMarkup?: TelegramOutboundButtonMarkup;
}

export type TelegramButtonPublicationObserver = (method: string, body: Readonly<Record<string, unknown>>) =>
  (((result: unknown, succeeded: boolean, rejected?: boolean, nativeEditResult?: unknown) => void) & { ordinarySource?: "first-send" | "known-parent-edit"; ready?: Promise<void>; prepareReplyMarkup?: () => unknown; prepareRichMessage?: () => unknown; assertPublicationBody?: (body: Readonly<Record<string, unknown>>) => void; restrictQuestionMembership?: (policy: "first-send" | "known-parent-edit" | "none") => void }) | undefined;
export interface TelegramButtonPublicationRichMessage {
  markdown: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}
export type TelegramButtonPublicationEditor = (target: Readonly<{ chatId: number; messageId: number; replyMarkup?: TelegramOutboundButtonMarkup; richMessage?: TelegramButtonPublicationRichMessage }>, assertCurrent: () => void) => Promise<void>;

export interface TelegramButtonActionStore {
  /** Private synchronous native SDK subscriber; not a public admission surface. */
  onQuestionAdmission?: (admission: unknown) => void;
  observeAppOwner?: (owner: Readonly<{ app: string; generation: string; revision?: number; reset?: boolean }>) => void;
  beginPublication?: TelegramButtonPublicationObserver;
  /** Private read-only first physical app/SDK parent snapshot; no refresh transition or membership grant. */
  capturePublicationSource?: (handle: Readonly<{ target: Readonly<{ chatId: number; threadId?: number }>; messageIds: readonly number[] }>, binding: unknown) => Readonly<{ assertCurrent: () => void }> | undefined;
  bindPublicationEditor?: (editor: TelegramButtonPublicationEditor) => void;
  waitForPublicationIdle?: () => Promise<void>;
  clear?: () => void;
  /** @internal Optional main-side native result origin; never a method-routing binding. */
  register: (action: TelegramOutboundButtonAction, questionResultBinding?: unknown) => string;
  resolve: (
    callbackData: string | undefined,
    query?: TelegramButtonCallbackQuery,
  ) => TelegramOutboundButtonAction | undefined;
}

export interface TelegramButtonCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    chat?: { id?: number };
    reply_markup?: TelegramOutboundButtonMarkup;
  };
}

export interface TelegramButtonCallbackHandlerDeps<TContext = unknown> {
  resolveAction: (
    callbackData: string | undefined,
    query?: TelegramButtonCallbackQuery,
  ) => TelegramOutboundButtonAction | undefined;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  enqueueButtonPrompt: (
    query: TelegramButtonCallbackQuery,
    action: TelegramOutboundButtonAction,
    ctx: TContext,
  ) => boolean | void;
  invokeBoundAction?: (
    query: TelegramButtonCallbackQuery,
    action: TelegramOutboundButtonAction,
    ctx: TContext,
  ) => Promise<false | "new" | "edit">;
  updateSelectionMessage?: (
    query: TelegramButtonCallbackQuery,
    markdown: string,
    rendering: "rich" | "html",
    replyMarkup: TelegramOutboundButtonMarkup,
    assertCurrent: () => void,
  ) => Promise<void>;
  updateSelectionKeyboard?: (
    query: TelegramButtonCallbackQuery,
    replyMarkup: TelegramOutboundButtonMarkup,
    assertCurrent: () => void,
  ) => Promise<void>;
  editMessageReplyMarkup?: (
    chatId: number,
    messageId: number,
    replyMarkup: TelegramOutboundButtonMarkup,
  ) => Promise<void>;
}

function nowMs(): number {
  return Date.now();
}

function normalizeMarkdownAfterButtonExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function parseTelegramButtonAction(
  payload: Record<string, unknown>,
): TelegramOutboundButtonAction | undefined {
  const value = getTelegramButtonString(payload, "value");
  const explicitLabel = getTelegramButtonString(payload, "label");
  const explicitPrompt = getTelegramButtonString(payload, "prompt");
  const label = explicitLabel ?? value ?? explicitPrompt;
  if (payload.disabled !== undefined && typeof payload.disabled !== "boolean") {
    return undefined;
  }
  if (payload.disabled === true) {
    return { text: label ?? "", prompt: "", disabled: true };
  }
  const prompt = explicitPrompt ?? value ?? explicitLabel;
  if (!label || !prompt) return undefined;
  const selectedStyle = payload.selected_style;
  return {
    text: label,
    prompt,
    ...(selectedStyle === "success" ||
    selectedStyle === "danger" ||
    selectedStyle === "primary"
      ? { selectedStyle }
      : {}),
  };
}

/** Only canonical compiler rows outside literal code are executable Rich controls. */
function mapTelegramRichCallbackRows(markdown: string, replace: (key: string, tag: string) => string): string {
  const lines = markdown.split("\n"), output: string[] = [];
  let fence: TelegramMarkdownFence | undefined, inlineCode = 0;
  const advanceInlineCode = (line: string): void => {
    for (const match of line.matchAll(/`+/g)) {
      let escapes = 0;
      for (let offset = match.index! - 1; offset >= 0 && line[offset] === "\\"; offset--) escapes++;
      if (escapes % 2) continue;
      if (!inlineCode) inlineCode = match[0].length;
      else if (inlineCode === match[0].length) inlineCode = 0;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      if (isTelegramMarkdownFenceClosing(line.replace(/\r$/, ""), fence)) fence = undefined;
      output.push(line); continue;
    }
    if (/^(?: {4}|\t)/.test(line)) { output.push(line); continue; }
    if (!line.trim()) inlineCode = 0;
    if (!inlineCode) fence = parseTelegramMarkdownFenceOpening(line);
    if (fence) { output.push(line); continue; }
    if (inlineCode || !line.startsWith("<tg-button-row>")) { advanceInlineCode(line); output.push(line); continue; }
    let end = index;
    while (!lines[end]!.includes("</tg-button-row>") && end + 1 < lines.length) end++;
    const row = lines.slice(index, end + 1).join("\n");
    if (!row.endsWith("</tg-button-row>") && !row.endsWith("</tg-button-row>\r")) { output.push(row); index = end; continue; }
    output.push(row.replace(/<tg-button type="callback_data" data="(tgbtn:[a-f0-9]{8})">/g, (tag, key: string) => replace(key, tag)));
    index = end;
  }
  return output.join("\n");
}

function cacheTelegramButtonRichMessage(value: unknown): TelegramButtonPublicationRichMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rich = value as Record<string, unknown>;
  if (typeof rich.markdown !== "string" || rich.markdown.length > 65_536 ||
      Object.keys(rich).some(key => !["markdown", "is_rtl", "skip_entity_detection"].includes(key)) ||
      ["is_rtl", "skip_entity_detection"].some(key => rich[key] !== undefined && typeof rich[key] !== "boolean")) return undefined;
  // A message ACK is not permission to replay media, HTML/blocks or other producer payloads.
  return { ...rich } as unknown as TelegramButtonPublicationRichMessage;
}

export function createTelegramButtonActionStore(
  options: { ttlMs?: number;
    /** Private native row-to-dispatch origin; no invocation, completion or consumed-edit grant. */
    ordinaryCallbackDispatch?: true | "qualified";
    /** Private one-row read-only transition with an unchanged complete original physical preimage. */
    ordinaryReadOnlyParent?: true;
    /** Private fully drained native HTML feedback projection, not legacy editor success. */
    ordinaryFeedbackParent?: true;
    /** Private whole Rich/keyboard projection through one original native text edit. */
    ordinaryRichFeedbackParent?: true;
    /** Private one queued original projection, fully drained by the native result ACK. */
    ordinaryQueuedFeedbackParent?: true;
    /** Private one native result ACK retained by its original still-running feedback editor. */
    ordinaryDeferredFeedbackParent?: true;
    /** Private one finite SDK admission while the original deferred editor still owns the result. */
    ordinaryDeferredSdkTail?: true;
    /** Original app origin at birth; independent mode keeps selection separate from SDK cohort eligibility. */
    questionAppOrigin?: true | "independent";
    /** Private one consumed read-only parent with a complete pure native question successor roster. */
    ordinaryQuestionParent?: true;
    /** Private one original retained group beside a fresh deferred read-only successor roster. */
    ordinaryRetainedQuestionParent?: true;
    captureSelectionAuthority?: () => (() => void) | undefined; recordFailure?: (error: unknown) => void;
    /** Original native question/publication membership, captured once at group birth. */
    captureQuestionLifetimeOwner?: () => Readonly<TelegramQuestionLifetimeOwner> | undefined;
    /** Private native app reader; omitted/foreign ordinary bindings stay outside coordinated membership. */
    captureOrdinaryBindingOwner?: (binding: unknown) => Readonly<GenerativeAppCallbackOwner> | undefined;
    recordRuntimeEvent?: (category: string, message: unknown, details?: Record<string, unknown>) => void } = {},
): TelegramButtonActionStore {
  const ordinaryCallbackDispatch = options.ordinaryCallbackDispatch;
  if (ordinaryCallbackDispatch !== undefined && ordinaryCallbackDispatch !== true && ordinaryCallbackDispatch !== "qualified") throw new TypeError("Ordinary callback dispatch must be true, qualified or omitted.");
  const ordinaryReadOnlyParent = options.ordinaryReadOnlyParent;
  if (ordinaryReadOnlyParent !== undefined && (ordinaryReadOnlyParent !== true || !ordinaryCallbackDispatch)) throw new TypeError("Read-only ordinary parent requires true and original native dispatch.");
  const ordinaryFeedbackParent = options.ordinaryFeedbackParent;
  if (ordinaryFeedbackParent !== undefined && (ordinaryFeedbackParent !== true || !ordinaryReadOnlyParent)) throw new TypeError("Feedback ordinary parent requires true and original read-only parent.");
  const ordinaryRichFeedbackParent = options.ordinaryRichFeedbackParent;
  if (ordinaryRichFeedbackParent !== undefined && (ordinaryRichFeedbackParent !== true || !ordinaryFeedbackParent)) throw new TypeError("Rich feedback ordinary parent requires true and original feedback ownership.");
  const ordinaryQueuedFeedbackParent = options.ordinaryQueuedFeedbackParent;
  if (ordinaryQueuedFeedbackParent !== undefined && (ordinaryQueuedFeedbackParent !== true || !ordinaryFeedbackParent)) throw new TypeError("Queued feedback ordinary parent requires true and original feedback ownership.");
  const ordinaryDeferredFeedbackParent = options.ordinaryDeferredFeedbackParent;
  if (ordinaryDeferredFeedbackParent !== undefined && (ordinaryDeferredFeedbackParent !== true || !ordinaryQueuedFeedbackParent)) throw new TypeError("Deferred feedback ordinary parent requires true and original queued ownership.");
  const ordinaryDeferredSdkTail = options.ordinaryDeferredSdkTail;
  if (ordinaryDeferredSdkTail !== undefined && (ordinaryDeferredSdkTail !== true || !ordinaryDeferredFeedbackParent)) throw new TypeError("Deferred SDK tail requires true and original deferred feedback ownership.");
  type AdmissionMatch = NonNullable<TelegramQuestionLifetimeOwner["matchAdmissionEvent"]>;
  const ttlMs = options.ttlMs ?? TELEGRAM_BUTTON_ACTION_TTL_MS;
  type OriginalAuthority = (() => void) & { readonly assertObservedCurrent: () => void };
  interface OrdinaryLifetime {
    readonly binding: TelegramOutboundButtonBinding; readonly owner: Readonly<TelegramQuestionLifetimeOwner>;
    readonly assertApp: () => void; readonly assertAppHistory: () => void; readonly assertSdkHistory: () => void;
    readonly invocationOwner?: Readonly<GenerativeAppCallbackOwner>;
    readonly createInvocation?: GenerativeAppCallbackOwner["createCallbackInvocation"];
    readonly captureSuccessor?: GenerativeAppCallbackOwner["captureReadOnlySuccessor"];
  }
  interface OrdinaryRecord { readonly key: string; readonly action: Stored; readonly lifetime: OrdinaryLifetime; }
  interface OrdinaryCompletion {
    readonly row: OrdinaryRecord; readonly successor: OrdinaryLifetime; readonly origin: object; readonly invocation: object; readonly history: () => void; readonly feedback?: OrdinaryFeedback; readonly projection?: OrdinaryProjection;
  }
  interface OrdinaryFeedback { readonly origin: object; readonly ordinary: readonly OrdinaryRecord[]; readonly frame: PublicationFrame; }
  interface OrdinaryProjection {
    readonly row: OrdinaryRecord; readonly origin: object; readonly ordinary: readonly OrdinaryRecord[];
    readonly members: readonly { key: string; action: Stored }[]; readonly questions: readonly QuestionTail[];
    readonly before: PublicationFrame; readonly markup?: TelegramOutboundButtonMarkup; readonly rich?: TelegramButtonPublicationRichMessage; readonly authority: OriginalAuthority;
    claimed: boolean; lost: boolean; after?: PublicationFrame; feedback?: OrdinaryFeedback;
    queuedClaimed?: true; queuedPending?: true; queuedLost?: true;
    queuedResult?: Readonly<{ assertCurrent: () => void; complete: () => void; admit?: (admission: unknown) => void }>;
  }
  interface PublicationFrame { readonly keyboard: Publication["keyboard"]; readonly richMessage: Publication["richMessage"]; readonly richKeys: Publication["richKeys"]; }
  interface Publication {
    chatId: number; messageId: number; threadId?: number; threadKnown: boolean; keyboard?: TelegramOutboundButtonMarkup;
    richMessage?: TelegramButtonPublicationRichMessage; richKeys: Set<string>;
    ordinary?: readonly OrdinaryRecord[];
    /** Certified first-wire ancestry only; never a question cohort or callback projection parent. */
    ordinarySource?: Readonly<{ rows: readonly OrdinaryRecord[]; frame: PublicationFrame }>;
    ordinaryProjection?: OrdinaryProjection;
    ordinaryParent?: { readonly rows: readonly OrdinaryRecord[]; readonly questions: readonly QuestionTail[]; readonly completed?: OrdinaryCompletion };
    assertAuthority: OriginalAuthority; tail: Promise<void>; busy: number; dirty: boolean; closing: boolean; lost: boolean;
    feedback: Map<string, { style?: TelegramInlineKeyboardButtonStyle; retirement?: "deadline" | "capacity" }>;
  }
  type Stored = TelegramOutboundButtonStoredAction & { ordinary?: OrdinaryLifetime;
    ordinaryDispatch?: object;
    ordinaryPublicationAttempt?: object;
    ordinaryInvocation?: WeakRef<object>;
    ordinaryInvocationHistory?: WeakRef<() => void>;
    ordinaryFeedback?: OrdinaryFeedback;
    ordinaryDeadline?: Readonly<{ key: string; lifetime: OrdinaryLifetime; publication: Publication }>;
    assertAuthority?: OriginalAuthority; publication?: Publication; retirement?: TelegramButtonRetirementReason };
  const actions = new Map<string, Stored>();
  // Metadata stays with this store, not a second interaction registry.
  // At most sixty indexed messages; actual I/O retains its own facts until settlement.
  const publications = new Set<Publication>(), publicationWork = new Set<Promise<void>>();
  let publicationEditor: TelegramButtonPublicationEditor | undefined, pumping = false;
  const authorities = new WeakMap<object, OriginalAuthority>();
  const captureAuthority = options.captureSelectionAuthority, captureQuestionOwner = options.captureQuestionLifetimeOwner;
  const captureOrdinaryOwner = captureQuestionOwner ? options.captureOrdinaryBindingOwner : undefined;
  if (captureOrdinaryOwner !== undefined && typeof captureOrdinaryOwner !== "function") throw new TypeError("Ordinary binding owner capture must be a function or omitted.");
  const questionAppOrigin = options.questionAppOrigin, ordinaryQuestionParent = options.ordinaryQuestionParent;
  if (ordinaryQuestionParent !== undefined && (ordinaryQuestionParent !== true || !ordinaryReadOnlyParent || !questionAppOrigin)) throw new TypeError("Question ordinary parent requires true and original read-only/question origins.");
  const ordinaryRetainedQuestionParent = options.ordinaryRetainedQuestionParent;
  if (ordinaryRetainedQuestionParent !== undefined && (ordinaryRetainedQuestionParent !== true || !ordinaryQuestionParent || !ordinaryDeferredFeedbackParent)) throw new TypeError("Retained question parent requires true and original deferred/question ownership.");
  if (questionAppOrigin !== undefined && (questionAppOrigin !== true && questionAppOrigin !== "independent" || typeof captureQuestionOwner !== "function" || typeof captureOrdinaryOwner !== "function" || typeof captureAuthority !== "function")) throw new TypeError("Question app origin requires true or independent and original question/app captures.");
  interface QuestionOrigin {
    readonly binding: unknown; owner?: Readonly<TelegramQuestionLifetimeOwner>; assertSdkHistory?: () => void; matchAdmissionEvent?: AdmissionMatch;
    assertApp?: () => void; assertAppHistory?: () => void; authority?: OriginalAuthority; lost: boolean;
    selectionAuthority?: OriginalAuthority; selectionLost?: boolean;
  }
  interface QuestionLifetime {
    readonly assertAuthority: OriginalAuthority;
    readonly origin?: QuestionOrigin;
    matchAdmissionEvent?: AdmissionMatch;
    owner?: Readonly<TelegramQuestionLifetimeOwner>;
    assertSdkHistory?: () => void;
    attempt?: object;
    published?: WeakRef<Publication>;
    /** The physical publication's original SDK scope, never a renewed view or co-head owner. */
    publicationScope?: object;
    publicationHistory?: () => void;
  }
  interface GroupFacts { birth: number; lifetime?: QuestionLifetime; origin?: QuestionOrigin; }
  const groupFacts = new WeakMap<object, GroupFacts>(), retiredGroups = new WeakSet<object>();
  const ensureGroupFacts = (group: object, birth: number): GroupFacts => {
    let facts = groupFacts.get(group);
    if (!facts) { facts = { birth }; groupFacts.set(group, facts); }
    return facts;
  };
  const deadlineOf = (action: Stored): number => {
    const owner = action.selection?.owner ?? action.completionGroup;
    const question = action.completionGroup && groupFacts.get(action.completionGroup);
    const birth = question?.origin ? question.birth : owner ? groupFacts.get(owner)?.birth ?? action.createdAt : action.createdAt;
    return Math.min(birth + ttlMs, action.expiresAt ?? Infinity, action.completionGroup?.deadline?.expiresAt ?? Infinity);
  };
  const captureQuestionTails = (excluded?: TelegramButtonCompletionGroup) => {
    const groups = new Set([...actions.values()].flatMap(action => action.completionGroup && action.completionGroup !== excluded ? [action.completionGroup] : []));
    return [...groups].flatMap(group => {
      const lifetime = groupFacts.get(group)?.lifetime, published = lifetime?.published?.deref(), owner = lifetime?.owner, deadline = group.deadline;
      return lifetime && published && owner && deadline ? [{ group, lifetime, published, owner, deadline, assertPublication: published.assertAuthority,
        members: [...actions].flatMap(([key, action]) => action.completionGroup === group ? [{ key, action }] : []) }] : [];
    });
  };
  type QuestionTail = ReturnType<typeof captureQuestionTails>[number];
  interface PublicationSourceFacts {
    readonly publication: Publication; readonly publisher: OriginalAuthority; readonly binding: unknown;
    readonly ordinary: readonly OrdinaryRecord[]; readonly questions: readonly QuestionTail[]; readonly frame: PublicationFrame;
    readonly assertCurrent: (busy: 0 | 1) => void;
  }
  // Each store owns its native brand. The constructor key and private attempt prevent reflection,
  // copied callbacks, another store or a later descriptor from manufacturing/reusing this source.
  class NativePublicationSource {
    readonly #facts: Readonly<PublicationSourceFacts>;
    #attempt?: object;
    readonly assertCurrent: () => void;
    constructor(key: symbol, facts: Readonly<PublicationSourceFacts>) {
      if (key !== PUBLICATION_SOURCE_KEY) throw new Error("Telegram original publication source is unavailable.");
      this.#facts = facts;
      this.assertCurrent = () => {
        if (this.#attempt) throw new Error("Telegram original publication source is unavailable.");
        facts.assertCurrent(0);
      };
      Object.freeze(this);
    }
    static take(key: symbol, value: unknown, attempt: object): Readonly<PublicationSourceFacts> | undefined {
      if (key !== PUBLICATION_SOURCE_KEY) return undefined;
      try {
        const source = value as NativePublicationSource;
        if (source.#attempt) return undefined;
        source.#attempt = attempt;
        return source.#facts;
      } catch { return undefined; }
    }
  }
  const takePublicationSource = NativePublicationSource.take;
  const questionTailCurrent = ({ group, lifetime, published, owner, members, assertPublication }: QuestionTail, completed?: OrdinaryCompletion) => {
    if (retiredGroups.has(group) || published.lost || !published.threadKnown || published.assertAuthority !== assertPublication ||
      published.chatId !== owner.target.chatId || published.threadId !== owner.target.threadId ||
      [...actions.values()].filter(action => action.completionGroup === group).length !== members.length || !members.length ||
      !members.every(({ key, action }) => actions.get(key) === action && action.publication === published && !action.retirement && nowMs() < deadlineOf(action))) return false;
    try {
      if (published.ordinary?.length || published.ordinaryParent) {
        assertOrdinaryData(published.ordinary ?? [], published, false, completed); lifetime.assertSdkHistory!(); lifetime.publicationHistory!();
        if (published.ordinaryParent) { assertOrdinaryData(published.ordinaryParent.rows, published, true, published.ordinaryParent.completed); assertParentHistory(published.ordinaryParent.questions); }
      }
      assertPublication.assertObservedCurrent(); lifetime.assertAuthority.assertObservedCurrent(); return true;
    }
    catch { return false; }
  };
  const shortenQuestionTails = (candidates: ReturnType<typeof captureQuestionTails>, assertHead: (owner: Readonly<TelegramQuestionLifetimeOwner>) => number,
    assertAvailable?: () => void, assertAuthority?: () => void) => {
    for (const candidate of candidates) {
      const { lifetime, owner, deadline, assertPublication } = candidate;
      try {
        if (!questionTailCurrent(candidate)) continue;
        const at = assertHead(owner);
        if (lifetime.publicationScope && lifetime.publicationScope !== owner.scope) owner.assertScope(lifetime.publicationScope);
        assertPublication(); lifetime.assertAuthority();
        assertHead(owner);
        if (lifetime.publicationScope && lifetime.publicationScope !== owner.scope) owner.assertScope(lifetime.publicationScope);
        assertPublication();
        const ordinary = [...(candidate.published.ordinary ?? []), ...(candidate.published.ordinaryParent?.rows ?? [])];
        for (const row of ordinary) { assertHead(row.lifetime.owner); row.action.assertAuthority!(); }
        assertOrdinaryAuthority(ordinary);
        assertAuthority?.();
        if (lifetime.origin) assertQuestionAppCurrent(lifetime.origin);
        if (questionTailCurrent(candidate)) { assertAvailable?.(); deadline.shorten(at + TELEGRAM_QUESTION_TAIL_MS); }
      } catch { /* Unknown scope cannot borrow a newer owner, row revision or publication. */ }
    }
  };
  let admitting = false, admissionPoisoned = false, clearing = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, expiryRevision = 0;
  const reportFailure = (error: unknown) => { try { options.recordFailure?.(error); } catch { /* Diagnostics cannot reopen retired work. */ } };
  const reportRetirement = (reason: TelegramButtonRetirementReason, count: number, first?: Stored) => {
    if (!count) return;
    try { options.recordRuntimeEvent?.("telegram", "Telegram button actions retired", { phase: "button-retirement", reason,
      count, createdAtMs: first!.createdAt, ttlMs, ageMs: Math.max(0, nowMs() - first!.createdAt), ...(first?.publication ? {
        messageId: first.publication.messageId, threadId: first.publication.threadId } : {}) }); }
    catch { /* Diagnostics cannot change spent callback authority. */ }
  };
  const reportUnavailable = (reason: "retired-status" | "capacity-status" | "unknown-history" | "publication-unavailable" | "publication-mismatch", query?: TelegramButtonCallbackQuery, action?: Stored) => {
    try { options.recordRuntimeEvent?.("telegram", "Telegram button callback unavailable", {
      phase: "button-callback-unavailable", reason,
      ...(action ? { createdAtMs: action.createdAt, ageMs: Math.max(0, nowMs() - action.createdAt), ttlMs } : {}),
      ...(Number.isSafeInteger(query?.message?.message_id) ? { messageId: query!.message!.message_id } : {}),
    }); } catch { /* Refusal diagnostics cannot spend or revive a callback. */ }
  };
  const retirementFeedback = (reason?: TelegramButtonRetirementReason, style?: TelegramInlineKeyboardButtonStyle) =>
    ({ ...(style ? { style } : {}), ...(reason === "deadline" || reason === "capacity" ? { retirement: reason } : {}) });
  const retiredButton = (text: string, reason: "deadline" | "capacity") => ({
    text: `${reason === "capacity" ? "Unavailable" : "Expired"}: ${text}`,
    callback_data: reason === "capacity" ? TELEGRAM_BUTTON_CAPACITY_CALLBACK : TELEGRAM_BUTTON_EXPIRED_CALLBACK,
  });
  const retiredRichTag = (reason: "deadline" | "capacity" | undefined) => {
    if (!reason) return '<tg-button type="disabled">';
    const button = retiredButton("", reason);
    return `<tg-button type="callback_data" data="${button.callback_data}">${button.text}`;
  };
  const getAuthority = (owner?: object): OriginalAuthority => {
    const previous = owner && authorities.get(owner);
    if (previous) return previous;
    const captured = captureAuthority?.();
    let lost = !!captureAuthority && !captured;
    const assertObservedCurrent = () => { if (lost) throw new Error("Telegram selection owner is unavailable."); };
    const guard = Object.freeze(Object.assign(() => {
      try { assertObservedCurrent(); captured?.(); }
      catch (error) { lost = true; throw error; }
    }, { assertObservedCurrent }));
    if (owner) authorities.set(owner, guard);
    return guard;
  };
  const dataFunction = (value: object | undefined, key: string): (() => void) | undefined => {
    const fn = value && Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
    return typeof fn === "function" ? fn as () => void : undefined;
  };
  const captureQuestionOrigin = (group: object, binding: unknown, producer: object): QuestionOrigin => {
    const facts = ensureGroupFacts(group, nowMs());
    if (facts.origin) { if (facts.origin.binding !== binding) { facts.origin.lost = true; facts.origin.selectionLost = true; } return facts.origin; }
    const origin: QuestionOrigin = { binding, lost: true, selectionLost: true }; facts.origin = origin;
    let base: OriginalAuthority | undefined;
    // Independent selection seals the original producer before either SDK/app capture can reenter.
    if (questionAppOrigin === "independent") try { base = getAuthority(producer); } catch { return origin; }
    try {
      const owner = Reflect.apply(captureQuestionOwner!, options, []), history = dataFunction(owner, "assertObservedCurrent");
      if (!admissionPoisoned && owner && history) {
        origin.owner = owner; origin.assertSdkHistory = history;
        if (ordinaryDeferredSdkTail) origin.matchAdmissionEvent = dataFunction(owner, "matchAdmissionEvent") as AdmissionMatch | undefined;
      } else if (owner !== undefined) void Promise.resolve(owner).catch(() => {});
    } catch { /* A missing original SDK birth never becomes a later-runtime lookup. */ }
    if (admissionPoisoned || !origin.owner && questionAppOrigin !== "independent") return origin;
    try {
      if (binding !== undefined) {
        const app = Reflect.apply(captureOrdinaryOwner!, options, [binding]), assertApp = dataFunction(app, "assertCurrent"), appHistory = dataFunction(app, "assertObservedCurrent");
        if (!assertApp || !appHistory || !binding || typeof binding !== "object" || !Object.isFrozen(binding) || dataFunction(binding, "assertCurrent") !== assertApp) {
          if (app !== undefined) void Promise.resolve(app).catch(() => {}); return origin;
        }
        origin.assertApp = assertApp; origin.assertAppHistory = appHistory;
      }
      origin.lost = !origin.owner || admissionPoisoned;
      if (base) {
        const originalProducer = base;
        origin.selectionLost = admissionPoisoned;
        const assertObservedCurrent = () => {
          if (origin.selectionLost || origin.binding !== undefined && (!origin.assertApp || !origin.assertAppHistory || dataFunction(origin.binding as object, "assertCurrent") !== origin.assertApp))
            throw new Error("Telegram question selection origin is unavailable.");
          originalProducer.assertObservedCurrent(); origin.assertAppHistory?.();
        };
        origin.selectionAuthority = Object.freeze(Object.assign(() => {
          try { assertObservedCurrent(); originalProducer(); origin.assertApp?.(); assertObservedCurrent(); }
          catch (error) { origin.selectionLost = true; origin.lost = true; throw error; }
        }, { assertObservedCurrent }));
      }
    } catch { /* Unavailable original app capture refuses both selection and coordination. */ }
    return origin;
  };
  const assertQuestionAppCurrent = (origin: QuestionOrigin) => {
    try { if (origin.lost) throw new Error("Telegram question app origin is unavailable."); origin.assertApp?.(); }
    catch (error) { origin.lost = true; throw error; }
  };
  const questionOriginAuthority = (origin: QuestionOrigin, owner?: object): OriginalAuthority => {
    if (origin.authority) return origin.authority;
    let base: OriginalAuthority | undefined;
    try { if (!origin.lost) base = getAuthority(owner); } catch { origin.lost = true; }
    const assertObservedCurrent = () => {
      try {
        if (origin.lost || !base || !origin.owner || !origin.assertSdkHistory || origin.binding !== undefined && (!origin.assertApp || !origin.assertAppHistory || dataFunction(origin.binding as object, "assertCurrent") !== origin.assertApp)) throw new Error("Telegram question app origin is unavailable.");
        base.assertObservedCurrent(); origin.assertSdkHistory(); origin.assertAppHistory?.();
      } catch (error) { origin.lost = true; throw error; }
    };
    origin.authority = Object.freeze(Object.assign(() => {
      try { assertObservedCurrent(); base!(); origin.owner!.assertCurrent(); base!(); assertQuestionAppCurrent(origin); assertObservedCurrent(); }
      catch (error) { origin.lost = true; throw error; }
    }, { assertObservedCurrent }));
    return origin.authority;
  };
  const captureOrdinary = (action: TelegramOutboundButtonAction) => {
    if (!captureOrdinaryOwner || action.promptKind !== undefined || action.selection || action.completionGroup || !action.binding) return undefined;
    const binding = action.binding;
    // Native SDK binding is captured before app/producer callbacks; no later registry or owner lookup.
    let owner: Readonly<TelegramQuestionLifetimeOwner> | undefined;
    try { owner = Reflect.apply(captureQuestionOwner!, options, []); } catch { return undefined; }
    const authority = getAuthority();
    let lifetime: OrdinaryLifetime | undefined;
    try {
      const assertSdkHistory = dataFunction(owner, "assertObservedCurrent");
      if (!owner || !assertSdkHistory) { if (owner !== undefined) void Promise.resolve(owner).catch(() => {}); return { authority }; }
      const app = Reflect.apply(captureOrdinaryOwner, options, [binding]), assertApp = dataFunction(app, "assertCurrent"), assertAppHistory = dataFunction(app, "assertObservedCurrent");
      if (!assertApp || !assertAppHistory ||
        !Object.isFrozen(binding) || dataFunction(binding, "assertCurrent") !== assertApp) {
        if (app !== undefined) void Promise.resolve(app).catch(() => {});
        return { authority };
      }
      authority(); owner.assertCurrent(); assertApp(); authority(); assertSdkHistory(); assertAppHistory();
      lifetime = Object.freeze({ binding, owner, assertApp, assertAppHistory, assertSdkHistory,
        ...(ordinaryCallbackDispatch ? { invocationOwner: app,
          createInvocation: dataFunction(app, "createCallbackInvocation") as unknown as GenerativeAppCallbackOwner["createCallbackInvocation"],
          captureSuccessor: dataFunction(app, "captureReadOnlySuccessor") as unknown as GenerativeAppCallbackOwner["captureReadOnlySuccessor"] } : {}) });
    } catch { /* Unavailable original ordinary authority is never renewed by a later row or ACK. */ }
    return { authority, lifetime };
  };
  const assertOrdinaryAuthority = (rows: readonly OrdinaryRecord[]) => { for (const row of rows) row.lifetime.assertApp(); };
  const assertOrdinaryCompletion = (completed: OrdinaryCompletion) => {
    const original = completed.row.lifetime;
    const next = original.captureSuccessor && Reflect.apply(original.captureSuccessor, original.invocationOwner, [completed.successor.binding, completed.invocation, completed.origin]);
    if (!next || dataFunction(next, "assertCurrent") !== completed.successor.assertApp || dataFunction(next, "assertObservedCurrent") !== completed.successor.assertAppHistory)
      throw new Error("Telegram ordinary roster is unavailable.");
  };
  const assertParentHistory = (parents: readonly QuestionTail[]) => {
    for (const { lifetime } of parents) { lifetime.assertSdkHistory!(); lifetime.publicationHistory!(); lifetime.assertAuthority.assertObservedCurrent(); }
  };
  const assertOrdinaryData = (rows: readonly OrdinaryRecord[], publication: Publication, superseded = false, completed?: OrdinaryCompletion) => {
    if (completed) {
      const action = completed.row.action;
      if (action.ordinaryDispatch !== completed.origin || !action.ordinaryInvocation || Reflect.apply(readDispatchWeakRef, action.ordinaryInvocation, []) !== completed.invocation ||
          !action.ordinaryInvocationHistory || Reflect.apply(readDispatchWeakRef, action.ordinaryInvocationHistory, []) !== completed.history) throw new Error("Telegram ordinary roster is unavailable.");
      const projection = completed.projection, feedback = completed.feedback ?? projection?.feedback;
      if (projection && (projection.lost || projection.queuedLost || !projection.queuedClaimed || projection.row !== completed.row || projection.origin !== completed.origin || projection.ordinary !== rows) ||
          feedback && action.ordinaryFeedback !== feedback) throw new Error("Telegram ordinary roster is unavailable.");
      completed.history(); completed.successor.assertAppHistory(); completed.successor.assertSdkHistory();
    }
    for (const { key, action, lifetime } of rows) {
      const unused = action.ordinaryDeadline;
      const expiredUnused = action.retirement === "deadline" && !actions.has(key) && unused?.key === key && unused.lifetime === lifetime && unused.publication === publication;
      const consumed = completed?.row.key === key && completed.row.action === action && completed.row.lifetime === lifetime && action.retirement === "consumed" && !actions.has(key) && nowMs() < deadlineOf(action);
      if (action.ordinary !== lifetime || action.binding !== lifetime.binding || action.publication !== publication || (superseded
        ? actions.has(key) || !consumed && action.retirement !== "superseded"
        : !consumed && !expiredUnused && (actions.get(key) !== action || action.retirement || nowMs() >= deadlineOf(action))) ||
        dataFunction(lifetime.binding, "assertCurrent") !== lifetime.assertApp) throw new Error("Telegram ordinary roster is unavailable.");
    }
    for (const { action, lifetime } of rows) {
      action.assertAuthority!.assertObservedCurrent(); lifetime.assertAppHistory(); lifetime.assertSdkHistory();
    }
  };
  const capturePublicationSource: NonNullable<TelegramButtonActionStore["capturePublicationSource"]> = (handle, binding) => {
    let nonData = false;
    const data = (value: unknown, key: PropertyKey): unknown => {
      const field = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
      if (field && !Object.hasOwn(field, "value")) nonData = true;
      return field?.value;
    };
    const target = data(handle, "target"), ids = data(handle, "messageIds"), chatId = data(target, "chatId"), threadId = data(target, "threadId"), messageId = data(ids, "0");
    if (nonData || !binding || !Array.isArray(ids) || data(ids, "length") !== 1 || !Number.isSafeInteger(chatId) || (chatId as number) <= 0 ||
        threadId !== undefined && (!Number.isSafeInteger(threadId) || (threadId as number) <= 0) || !Number.isSafeInteger(messageId) || (messageId as number) <= 0) return undefined;
    const matches = [...publications].filter(view => view.chatId === chatId && view.threadId === threadId && view.messageId === messageId);
    if (matches.length !== 1) return undefined;
    const publication = matches[0]!, publisher = publication.assertAuthority;
    const questions = captureQuestionTails().filter(parent => parent.published === publication), first = questions[0];
    const physicalScope = first?.owner.scope, physicalHistory = first?.lifetime.assertSdkHistory;
    const ordinarySource = !first ? publication.ordinarySource : undefined;
    const ordinary = ordinarySource?.rows ?? publication.ordinary, owner = first?.owner ?? ordinarySource?.rows[0]?.lifetime.owner;
    const keyboard = publication.keyboard, rich = publication.richMessage, richKeys = publication.richKeys;
    // Only unchanged first physical frames qualify. A question-free frame needs its own original
    // first-wire certificate, not a current SDK lookup or the disappearance of a mixed frame's questions.
    if (!owner || ordinary?.length !== 1 || ordinary[0]!.lifetime.binding !== binding || questions.some(parent =>
      parent.lifetime.origin?.binding !== binding || parent.lifetime.publicationScope !== physicalScope ||
      parent.lifetime.publicationHistory !== physicalHistory)) return undefined;
    const members = [...questions.flatMap(parent => parent.members), ...ordinary.map(row => ({ key: row.key, action: row.action }))];
    const visible = [...(keyboard?.inline_keyboard.flatMap(row => row.flatMap(cell => cell.callback_data?.startsWith("tgbtn:") ? [cell.callback_data] : [])) ?? []), ...richKeys];
    if (!members.length || visible.length !== members.length || members.some(member => visible.filter(key => key === member.key).length !== 1)) return undefined;
    let lost = false, checking = false;
    const unavailable = () => new Error("Telegram original publication source is unavailable.");
    const assertData = (busy: 0 | 1) => {
      if (lost || !publications.has(publication) || publication.lost || !publication.threadKnown || publication.busy !== busy || publication.dirty || publication.closing ||
          publication.chatId !== chatId || publication.threadId !== threadId || publication.messageId !== messageId || publication.assertAuthority !== publisher ||
          publication.keyboard !== keyboard || publication.richMessage !== rich || publication.richKeys !== richKeys ||
          (ordinarySource ? publication.ordinarySource !== ordinarySource || publication.ordinary !== undefined || !frameCurrent(publication, ordinarySource.frame) : publication.ordinary !== ordinary) ||
          publication.ordinaryParent || publication.ordinaryProjection || [...actions.values()].filter(action => action.publication === publication).length !== members.length ||
          questions.some(parent => Object.getOwnPropertyDescriptor(parent.group, "deadline")?.value !== parent.deadline || parent.lifetime.owner !== parent.owner ||
            parent.lifetime.origin?.binding !== binding || parent.lifetime.publicationScope !== physicalScope ||
            parent.lifetime.publicationHistory !== physicalHistory || !questionTailCurrent(parent))) throw unavailable();
      assertOrdinaryData(ordinary, publication);
    };
    const assertCurrent = (busy: 0 | 1 = 0) => {
      if (checking) { lost = true; throw unavailable(); }
      checking = true;
      try {
        assertData(busy);
        owner.assertCurrent();
        for (const parent of questions) owner.assertScope(parent.owner.scope);
        for (const row of ordinary) owner.assertScope(row.lifetime.owner.scope);
        publisher();
        for (const parent of questions) parent.lifetime.assertAuthority();
        for (const row of ordinary) row.action.assertAuthority!();
        assertOrdinaryAuthority(ordinary);
        for (const parent of questions) assertQuestionAppCurrent(parent.lifetime.origin!);
        assertData(busy);
      } catch { lost = true; throw unavailable(); }
      finally { checking = false; }
    };
    try {
      assertCurrent();
      return new NativePublicationSource(PUBLICATION_SOURCE_KEY, Object.freeze({ publication, publisher, binding, ordinary, questions,
        frame: Object.freeze({ keyboard, richMessage: rich, richKeys }), assertCurrent }));
    } catch { return undefined; }
  };
  const prepareOrdinaryDispatch = (key: string, action: Stored, query: TelegramButtonCallbackQuery | undefined) => {
    const lifetime = action.ordinary, publication = action.publication;
    const unavailable = Symbol("non-data callback field");
    const value = (object: object | undefined, field: string): unknown => {
      const descriptor = object && Object.getOwnPropertyDescriptor(object, field);
      return descriptor && !Object.hasOwn(descriptor, "value") ? unavailable : descriptor?.value;
    };
    const message = value(query, "message") as TelegramButtonCallbackQuery["message"], chat = value(message, "chat") as { id?: number } | undefined;
    const id = value(query, "id"), messageId = value(message, "message_id"), threadId = value(message, "message_thread_id");
    let physical: QuestionTail | undefined, originalRow = false;
    for (const candidate of captureQuestionTails()) if (candidate.published === publication) { physical = candidate; break; }
    for (const record of publication?.ordinary ?? []) if (record.key === key && record.action === action && record.lifetime === lifetime) { originalRow = true; break; }
    const physicalScope = physical?.lifetime.publicationScope, physicalHistory = physical?.lifetime.publicationHistory;
    if (!physicalScope || !physicalHistory || !lifetime || !publication || action.disabled || !query || typeof id !== "string" || !id || value(query, "data") !== key || !publication.threadKnown ||
        value(chat, "id") !== publication.chatId || messageId !== publication.messageId || threadId !== publication.threadId ||
        actions.get(key) !== action || action.retirement || !originalRow) return undefined;
    if (ordinaryCallbackDispatch === "qualified") {
      try { lifetime.assertSdkHistory(); physicalHistory(); }
      catch { return undefined; }
    }
    const marker = Object.freeze({}), rowRef = new NativeDispatchWeakRef(action), publicationRef = new NativeDispatchWeakRef(publication), lifetimeRef = new NativeDispatchWeakRef(lifetime);
    const binding = lifetime.binding, prompt = action.prompt, deadline = deadlineOf(action);
    action.ordinaryDispatch = marker;
    let lost = false, checking = false, attempted = false, invocationAttempted = false;
    let issuedInvocation: object | undefined;
    const facts = () => {
      const row = Reflect.apply(readDispatchWeakRef, rowRef, []) as Stored | undefined;
      const parent = Reflect.apply(readDispatchWeakRef, publicationRef, []) as Publication | undefined;
      const original = Reflect.apply(readDispatchWeakRef, lifetimeRef, []) as OrdinaryLifetime | undefined;
      if (lost || !row || !parent || !original || row.ordinaryDispatch !== marker || row.ordinary !== original || row.binding !== binding || row.prompt !== prompt ||
          row.publication !== parent || row.retirement !== "consumed" || issuedInvocation && (!row.ordinaryInvocation || Reflect.apply(readDispatchWeakRef, row.ordinaryInvocation, []) !== issuedInvocation) || actions.has(key) || parent.lost || !publications.has(parent) || nowMs() >= deadline ||
          !(parent.ordinary?.some(record => record.key === key && record.action === row && record.lifetime === original) ||
            parent.ordinaryParent?.completed?.row.action === row && parent.ordinaryParent.completed.row.key === key && parent.ordinaryParent.completed.row.lifetime === original &&
            parent.ordinaryParent.completed.origin === marker && parent.ordinaryParent.completed.invocation === issuedInvocation) ||
          dataFunction(binding, "assertCurrent") !== original.assertApp || value(query, "id") !== id || value(query, "data") !== key ||
          value(query, "message") !== message || value(message, "chat") !== chat || value(chat, "id") !== parent.chatId ||
          value(message, "message_id") !== messageId || value(message, "message_thread_id") !== threadId) throw new Error("Telegram ordinary callback dispatch is unavailable.");
      return { row, parent, original };
    };
    const history = () => {
      const { row, parent, original } = facts();
      row.assertAuthority!.assertObservedCurrent(); parent.assertAuthority.assertObservedCurrent(); original.assertAppHistory(); original.assertSdkHistory(); physicalHistory();
      if (lost) throw new Error("Telegram ordinary callback dispatch is unavailable.");
    };
    const assertObservedCurrent = () => {
      if (checking) lost = true;
      try { history(); } catch { lost = true; throw new Error("Telegram ordinary callback dispatch is unavailable."); }
    };
    const check = (native?: (original: OrdinaryLifetime) => object | undefined) => {
      if (checking) { lost = true; throw new Error("Telegram ordinary callback dispatch is unavailable."); }
      checking = true;
      try {
        const { row, parent, original } = facts();
        row.assertAuthority!(); parent.assertAuthority(); original.owner.assertCurrent(); original.owner.assertScope(physicalScope); row.assertAuthority!(); parent.assertAuthority();
        original.assertApp(); const result = native?.(original); history(); return { row, result };
      } catch { lost = true; throw new Error("Telegram ordinary callback dispatch is unavailable."); }
      finally { checking = false; }
    };
    const assertCurrent = () => { check(); };
    const takeInvocation = () => {
      if (invocationAttempted) { if (checking) lost = true; return undefined; }
      invocationAttempted = true;
      try {
        const { row, result } = check(original => original.createInvocation && Reflect.apply(original.createInvocation, original.invocationOwner, [prompt, marker, { assertCurrent, assertObservedCurrent }]));
        if (!result || typeof result !== "object") { lost = true; return undefined; }
        issuedInvocation = result; row.ordinaryInvocation = new NativeDispatchWeakRef(result);
        if (ordinaryReadOnlyParent) row.ordinaryInvocationHistory = new NativeDispatchWeakRef(assertObservedCurrent);
        return result;
      } catch { return undefined; }
    };
    const captureReadOnlySuccessor = (next: unknown, invocation: unknown): Readonly<GenerativeAppCallbackOwner> | undefined => {
      if (!issuedInvocation || invocation !== issuedInvocation) return undefined;
      try { return check(original => original.captureSuccessor && Reflect.apply(original.captureSuccessor, original.invocationOwner, [next, invocation, marker])).result as Readonly<GenerativeAppCallbackOwner> | undefined; }
      catch { return undefined; }
    };
    const dispatch = Object.freeze(Object.defineProperties({ binding, prompt, assertCurrent, assertObservedCurrent }, {
      takeInvocation: { value: takeInvocation }, captureReadOnlySuccessor: { value: captureReadOnlySuccessor } }));
    return (candidate: unknown) => {
      if (attempted) { lost = true; return undefined; }
      attempted = true;
      if (candidate !== query) { lost = true; return undefined; }
      try { assertCurrent(); assertObservedCurrent(); return dispatch; } catch { return undefined; }
    };
  };
  const hasActivePublication = (publication: Publication) => [...actions.values()].some(action => action.publication === publication);
  const discardPublication = (publication: Publication) => { publication.lost = true; publications.delete(publication); };
  const invalidatePublication = (publication: Publication) => {
    discardPublication(publication);
    for (const [key, action] of actions) if (action.publication === publication) expireGroup(groupOf(key, action), "publication-lost");
  };
  const frameCurrent = (publication: Publication, frame: PublicationFrame) => publication.keyboard === frame.keyboard && publication.richMessage === frame.richMessage && publication.richKeys === frame.richKeys;
  const projectionData = (publication: Publication, projection: OrdinaryProjection) => {
    if (projection.queuedResult) { projection.queuedResult.assertCurrent(); return; }
    const { row, ordinary, members, questions } = projection;
    if (projection.lost || publication.lost || publication.ordinaryProjection !== projection || !publication.threadKnown || publication.assertAuthority !== projection.authority ||
        publication.ordinary !== ordinary || !frameCurrent(publication, projection.after ?? projection.before) || row.action.ordinaryDispatch !== projection.origin ||
        row.action.retirement !== "consumed" || actions.has(row.key) || nowMs() >= deadlineOf(row.action) ||
        [...actions.values()].filter(action => action.publication === publication).length !== members.length ||
        members.some(({ key, action }) => actions.get(key) !== action || action.publication !== publication || action.retirement || nowMs() >= deadlineOf(action)) ||
        questions.some(question => retiredGroups.has(question.group))) throw new Error("Telegram callback publication is unavailable.");
    for (const record of ordinary) {
      const { action, lifetime } = record;
      if (action.ordinary !== lifetime || action.binding !== lifetime.binding || action.publication !== publication || dataFunction(lifetime.binding, "assertCurrent") !== lifetime.assertApp)
        throw new Error("Telegram ordinary roster is unavailable.");
      action.assertAuthority!.assertObservedCurrent(); lifetime.assertAppHistory(); lifetime.assertSdkHistory();
    }
    assertParentHistory(questions); projection.authority.assertObservedCurrent();
  };
  const captureQueuedHeadFence = (assertMatch: (owner: Readonly<TelegramQuestionLifetimeOwner>) => void, except?: OrdinaryProjection, admission?: unknown) => {
    const projections = ordinaryQueuedFeedbackParent ? [...publications].flatMap(publication => {
      const projection = publication.ordinaryProjection;
      return projection?.queuedClaimed ? [{ projection, result: projection.queuedResult, question: projection.questions[0]!, match: projection.questions[0]!.lifetime.matchAdmissionEvent }] : [];
    }) : [];
    return () => {
      for (const { projection, result, question, match } of projections) {
        if (projection === except || projection.queuedLost) continue;
        if (ordinaryDeferredSdkTail && admission !== undefined) {
          try {
            if (result?.admit) {
              if (projection.queuedResult !== result) throw new Error("Telegram queued result is unavailable.");
              result.admit(admission);
            } else if (!match || Reflect.apply(match, question.owner, [admission]) !== undefined) projection.queuedLost = true;
          } catch { projection.queuedLost = true; }
          continue;
        }
        try { assertMatch(question.owner); projection.queuedLost = true; } catch { /* Another original scope does not lend a matching head. */ }
      }
    };
  };
  const projectionKeys = (markup: TelegramOutboundButtonMarkup | undefined, rich: TelegramButtonPublicationRichMessage | undefined) => {
    const keys = markup?.inline_keyboard.flatMap(row => row.flatMap(button => button.callback_data ? [button.callback_data] : [])) ?? [];
    if (rich) mapTelegramRichCallbackRows(rich.markdown, (key, tag) => { keys.push(key); return tag; });
    return keys;
  };
  const captureProjection = (publication: Publication, markup: TelegramOutboundButtonMarkup | undefined, rich: TelegramButtonPublicationRichMessage | undefined): OrdinaryProjection | undefined => {
    if (publication.richMessage ? !ordinaryRichFeedbackParent || !rich || !!publication.keyboard && !markup : !markup || !!rich || publication.richKeys.size > 0) return undefined;
    const ordinary = publication.ordinary!, consumed = ordinary.filter(row => row.action.retirement === "consumed"), row = consumed.length === 1 ? consumed[0] : undefined;
    if (!row?.action.ordinaryDispatch || ordinary.some(record => record !== row && record.action.retirement)) return undefined;
    const members = [...actions].flatMap(([key, action]) => action.publication === publication ? [{ key, action }] : []);
    const questions = captureQuestionTails().filter(question => question.published === publication);
    const originalKeys = projectionKeys(publication.keyboard, publication.richMessage);
    if (!questions.length || originalKeys.length !== members.length + 1 || new Set(originalKeys).size !== originalKeys.length || !originalKeys.includes(row.key) ||
        !members.every(member => originalKeys.includes(member.key) && (questions.some(question => question.members.some(item => item.key === member.key && item.action === member.action)) || ordinary.some(record => record.key === member.key && record.action === member.action)))) return undefined;
    if (rich) {
      Object.freeze(rich);
      if (markup) { for (const line of markup.inline_keyboard) { for (const button of line) Object.freeze(button); Object.freeze(line); } Object.freeze(markup.inline_keyboard); Object.freeze(markup); }
    }
    return { row, origin: row.action.ordinaryDispatch, ordinary, members, questions, before: { keyboard: publication.keyboard, richMessage: publication.richMessage, richKeys: publication.richKeys }, markup, ...(rich ? { rich } : {}),
      authority: publication.assertAuthority, claimed: false, lost: false };
  };
  const pumpPublications = (): void => {
    if (pumping || !publicationEditor) return;
    pumping = true;
    const work = Promise.resolve().then(async () => {
      for (;;) {
        const publication = [...publications].find(view => view.dirty && !view.busy && !view.closing);
        if (!publication) break;
        publication.dirty = false;
        if (publication.lost) { publications.delete(publication); continue; }
        let changed = false;
        const keyboard = publication.keyboard;
        const replyMarkup = keyboard && { ...keyboard, inline_keyboard: keyboard.inline_keyboard.map(row => row.map(button => {
          const key = button.callback_data;
          if (key === TELEGRAM_BUTTON_EXPIRED_CALLBACK || key === TELEGRAM_BUTTON_CAPACITY_CALLBACK || !key?.startsWith("tgbtn:") || actions.get(key)?.publication === publication) return { ...button };
          changed = true;
          const { callback_data: _key, ...rest } = button;
          const feedback = publication.feedback.get(key);
          if (feedback?.retirement) return retiredButton(button.text, feedback.retirement);
          return { ...rest, disabled: {}, ...(feedback?.style ? { style: feedback.style } : {}) };
        })) };
        const previousRich = publication.richMessage;
        const markdown = previousRich && mapTelegramRichCallbackRows(previousRich.markdown,
          (key, tag) => actions.get(key)?.publication === publication ? tag : retiredRichTag(publication.feedback.get(key)?.retirement));
        const needsProjection = ordinaryFeedbackParent && publication.ordinary?.some(record => record.action.retirement === "consumed");
        const richMessage = previousRich && (markdown !== previousRich.markdown || needsProjection && ordinaryRichFeedbackParent) ? { ...previousRich, markdown: markdown! } : undefined;
        if (changed && replyMarkup || richMessage) {
          const projection = needsProjection ? captureProjection(publication, replyMarkup, richMessage) : undefined;
          if (needsProjection && !projection) { invalidatePublication(publication); continue; }
          if (projection) publication.ordinaryProjection = projection;
          const assertCurrent = () => {
            if (publication.lost) throw new Error("Telegram callback publication is unavailable.");
            publication.assertAuthority();
            if (projection) {
              for (const { action, lifetime } of projection.ordinary) { action.assertAuthority!(); lifetime.owner.assertCurrent(); }
              for (const question of projection.questions) { question.lifetime.assertAuthority(); question.owner.assertCurrent(); question.owner.assertScope(question.lifetime.publicationScope!); }
              assertOrdinaryAuthority(projection.ordinary); projectionData(publication, projection);
            }
          };
          try { assertCurrent(); } catch { if (projection) delete publication.ordinaryProjection; invalidatePublication(publication); continue; }
          publication.closing = true;
          try {
            await publicationEditor!({ chatId: publication.chatId, messageId: publication.messageId, ...(replyMarkup ? { replyMarkup } : {}), ...(richMessage ? { richMessage } : {}) }, assertCurrent); assertCurrent();
            if (projection) {
              if (!projection.after) throw new Error("Telegram feedback acknowledgement is unavailable.");
              projectionData(publication, projection);
              projection.feedback = projection.row.action.ordinaryFeedback ??= Object.freeze({ origin: projection.origin, ordinary: projection.ordinary, frame: projection.after });
              projection.queuedResult?.complete();
            }
          }
          catch (error) {
            invalidatePublication(publication);
            reportFailure(error);
          } finally {
            publication.closing = false;
            if (projection) delete projection.queuedResult;
            if (projection && publication.ordinaryProjection === projection && !projection.queuedPending) delete publication.ordinaryProjection;
          }
        }
        if (!hasActivePublication(publication) && !publication.busy) publications.delete(publication);
      }
    }).catch(reportFailure).finally(() => {
      publicationWork.delete(work); pumping = false; armExpiry();
      if ([...publications].some(view => view.dirty && !view.busy)) pumpPublications();
    });
    publicationWork.add(work);
  };
  const removeAction = (key: string, action: Stored, style?: TelegramInlineKeyboardButtonStyle, reason: TelegramButtonRetirementReason = "consumed"): void => {
    actions.delete(key);
    action.retirement = reason;
    if (action.publication) {
      action.publication.feedback.set(key, retirementFeedback(reason, style));
      action.publication.dirty = true;
      pumpPublications();
    }
  };
  const beginPublication: TelegramButtonPublicationObserver = (method, body) => {
    if (!["sendMessage", "sendRichMessage", "editMessageText", "editMessageReplyMarkup"].includes(method) ||
        !Number.isSafeInteger(body.chat_id)) return undefined;
    const chatId = body.chat_id as number, editing = method.startsWith("edit");
    const threadId = Number.isSafeInteger(body.message_thread_id) ? body.message_thread_id as number : undefined;
    const messageId = editing && Number.isSafeInteger(body.message_id) ? body.message_id as number : undefined;
    if (editing && (!messageId || messageId <= 0)) return undefined;
    const locators = ["chat_id", "message_id", "message_thread_id", "inline_message_id", "business_connection_id", "direct_messages_topic_id"].map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      return { key, value: descriptor?.value as unknown, accessor: !!(descriptor?.get || descriptor?.set) };
    });
    // Pin publication and question references before an original-view guard can reenter.
    const originals = messageId === undefined ? [] : [...publications].filter(view => view.chatId === chatId && view.messageId === messageId);
    const original = originals[0], firstSource = original?.ordinarySource;
    const parentOrdinary = original?.ordinary ?? firstSource?.rows ?? [];
    const pendingProjection = original?.ordinaryProjection && !original.ordinaryProjection.claimed ? original.ordinaryProjection : undefined;
    if (pendingProjection) pendingProjection.claimed = true;
    if (ordinaryDeferredFeedbackParent && original?.ordinaryProjection?.queuedClaimed) original.ordinaryProjection.lost = true;
    const queuedProjection = ordinaryQueuedFeedbackParent && !pendingProjection && original?.ordinaryProjection?.claimed && !original.ordinaryProjection.queuedClaimed ? original.ordinaryProjection : undefined;
    if (queuedProjection) queuedProjection.queuedClaimed = true;
    // Snapshot born identities before body/parent getters; callbacks cannot introduce a successor.
    const questionCandidates = ordinaryQuestionParent ? [...actions].flatMap(([key, action]) => {
      const group = action.completionGroup, lifetime = group && groupFacts.get(group)?.lifetime, origin = lifetime?.origin;
      return action.promptKind === "selection" && !action.publication && group && lifetime && origin && !origin.lost && origin.binding !== undefined &&
        origin.owner === lifetime.owner && origin.owner && origin.assertApp && origin.assertAppHistory && origin.assertSdkHistory ? [{ key, action, group, lifetime, origin,
          successor: Object.freeze({ binding: origin.binding as TelegramOutboundButtonBinding, owner: origin.owner, assertApp: origin.assertApp, assertAppHistory: origin.assertAppHistory, assertSdkHistory: origin.assertSdkHistory }) }] : [];
    }) : [];
    const ordinaryCandidates = !editing ? [...actions].flatMap(([key, action]) => action.ordinary && !action.publication && !action.completionGroup
      ? [{ key, action, lifetime: action.ordinary }] : []) : [];
    const parentCandidates = (method === "editMessageText" || method === "editMessageReplyMarkup") && originals.length === 1 ? captureQuestionTails().filter(candidate => candidate.published === original) : [];
    const retainedCandidates = ordinaryRetainedQuestionParent && queuedProjection ? queuedProjection.questions.flatMap(question => {
      const lifetime = question.lifetime, origin = lifetime.origin;
      return origin && !origin.lost && origin.binding === queuedProjection.row.lifetime.binding && origin.owner === lifetime.owner && origin.assertApp && origin.assertAppHistory && origin.assertSdkHistory
        ? [{ question, origin, birth: groupFacts.get(question.group)?.birth, attempt: lifetime.attempt, published: lifetime.published,
          scope: lifetime.publicationScope, history: lifetime.publicationHistory, sdkHistory: lifetime.assertSdkHistory,
          app: origin.assertApp, appHistory: origin.assertAppHistory, originSdkHistory: origin.assertSdkHistory, shorten: dataFunction(question.deadline, "shorten") }] : [];
    }) : [];
    let refreshSource: Readonly<PublicationSourceFacts> | undefined;
    const preimage: PublicationFrame | undefined = original && { keyboard: original.keyboard, richMessage: original.richMessage, richKeys: original.richKeys };
    const parentRows = [...actions].flatMap(([key, action]) => action.publication === original && original ? [{ key, action }] : []);
    const parentKeys = new Set(original?.richKeys);
    for (const row of original?.keyboard?.inline_keyboard ?? []) for (const button of row) if (button.callback_data) parentKeys.add(button.callback_data);
    let existing: Publication | undefined = original;
    const rawMarkup = body.reply_markup as TelegramOutboundButtonMarkup | undefined;
    const keys = new Set<string>(), occurrences: string[] = [];
    if (Array.isArray(rawMarkup?.inline_keyboard)) for (const row of rawMarkup.inline_keyboard)
      if (Array.isArray(row)) for (const button of row) if (typeof button?.callback_data === "string") { keys.add(button.callback_data); occurrences.push(button.callback_data); }
    const rich = body.rich_message as { markdown?: unknown } | undefined;
    if (typeof rich?.markdown === "string") mapTelegramRichCallbackRows(rich.markdown, (key, tag) => { keys.add(key); occurrences.push(key); return tag; });
    const records = [...keys].flatMap(key => {
      const action = actions.get(key);
      return action && (!action.publication || originals.includes(action.publication)) ? [{ key, action }] : [];
    });
    if (!existing && !records.length && ![...keys].some(key => key.startsWith("tgbtn:"))) return undefined;
    if (locators.some(({ value, accessor }) => accessor || value !== null && !["undefined", "string", "number", "boolean"].includes(typeof value)) ||
        locators[0]!.value !== chatId || editing && locators[1]!.value !== messageId)
      throw new Error("Telegram callback publication locator is unavailable.");
    const keyboard = rawMarkup === undefined ? undefined : structuredClone(rawMarkup);
    const richSnapshot = typeof rich?.markdown === "string" ? structuredClone(rich) : undefined;
    const editFields = ["chat_id", "message_id", "message_thread_id", "text", "rich_message", "parse_mode", "entities", "link_preview_options", "disable_web_page_preview", "reply_markup"];
    const parentThread = original?.threadId, parentGuard = original?.assertAuthority;
    const ordinary: readonly OrdinaryRecord[] = records.flatMap(({ key, action }) => action.ordinary && !action.completionGroup ? [{ key, action, lifetime: action.ordinary }] : []);
    const consumedRows = ordinaryReadOnlyParent && editing ? parentOrdinary.filter(row => row.action.retirement === "consumed") : [];
    const consumed = consumedRows.length === 1 ? consumedRows[0] : undefined;
    const invocation = consumed?.action.ordinaryInvocation && Reflect.apply(readDispatchWeakRef, consumed.action.ordinaryInvocation, []) as object | undefined;
    const history = consumed?.action.ordinaryInvocationHistory && Reflect.apply(readDispatchWeakRef, consumed.action.ordinaryInvocationHistory, []) as (() => void) | undefined;
    const feedback = ordinaryFeedbackParent && consumed?.action.ordinaryFeedback;
    const originalFeedback = feedback && feedback.origin === consumed?.action.ordinaryDispatch && feedback.ordinary === parentOrdinary && original && frameCurrent(original, feedback.frame) ? feedback : undefined;
    const retainedIncluded = retainedCandidates.filter(({ question }) => question.members.some(member => keys.has(member.key)));
    const retainedParent = retainedIncluded.length === 1 && retainedIncluded[0]!.question.members.every(member => occurrences.filter(key => key === member.key).length === 1) ? retainedIncluded[0] : undefined;
    const questionRows = ordinaryQuestionParent && !ordinary.length && records.length ? (retainedParent ? records.filter(record => record.action.completionGroup !== retainedParent.question.group) : records)
      .map(record => questionCandidates.find(candidate => candidate.key === record.key && candidate.action === record.action && candidate.group === record.action.completionGroup)) : [];
    const firstQuestion = questionRows[0];
    const successor: OrdinaryLifetime | undefined = ordinary.length && ordinary.every(row => !row.action.publication && row.lifetime.binding === ordinary[0]!.lifetime.binding) ? ordinary[0]!.lifetime :
      firstQuestion && questionRows.every(candidate => candidate && candidate.origin === candidate.lifetime.origin && !candidate.origin.lost && candidate.successor.binding === firstQuestion.successor.binding) ? firstQuestion.successor : undefined;
    const completed: OrdinaryCompletion | undefined = consumed && (parentKeys.has(consumed.key) || originalFeedback || queuedProjection?.row === consumed) && consumed.action.ordinaryDispatch && invocation && history && successor
      ? { row: consumed, successor, origin: consumed.action.ordinaryDispatch, invocation, history, ...(originalFeedback ? { feedback: originalFeedback } : {}), ...(queuedProjection ? { projection: queuedProjection } : {}) } : undefined;
    const projection = pendingProjection && method === (pendingProjection.rich ? "editMessageText" : "editMessageReplyMarkup") && rawMarkup === pendingProjection.markup && rich === pendingProjection.rich &&
      Object.keys(body).every(key => ["chat_id", "message_id", "reply_markup", "rich_message"].includes(key)) && original && frameCurrent(original, pendingProjection.before) &&
      occurrences.length === pendingProjection.members.length && new Set(occurrences).size === occurrences.length && pendingProjection.members.every(member => keys.has(member.key)) ? pendingProjection : undefined;
    if (pendingProjection && !projection) { pendingProjection.lost = true; invalidatePublication(original!); throw new Error("Telegram feedback projection is unavailable."); }
    const projectionPreimage = () => { if (projection && original && !frameCurrent(original, projection.before)) projection.lost = true; };
    const parents = parentCandidates.filter(candidate => questionTailCurrent(candidate, completed));
    const assertRetained = () => {
      if (!retainedParent) return;
      const { question, origin } = retainedParent, { group, lifetime, members } = question;
      const parent = parents.find(parent => parent.group === group);
      if (!queuedProjection || completed?.projection !== queuedProjection || !original || question.published !== original ||
          !parent || parent.lifetime !== lifetime || parent.members.length !== members.length || !parent.members.every(member => members.some(prior => prior.key === member.key && prior.action === member.action)) ||
          groupFacts.get(group)?.lifetime !== lifetime || groupFacts.get(group)?.birth !== retainedParent.birth || !Number.isFinite(retainedParent.birth) ||
          retiredGroups.has(group) || lifetime.origin !== origin || origin.lost || origin.binding !== completed.row.lifetime.binding ||
          lifetime.owner !== question.owner || origin.owner !== question.owner || !retainedParent.attempt || lifetime.attempt !== retainedParent.attempt ||
          !retainedParent.scope || !retainedParent.history || !retainedParent.sdkHistory || lifetime.publicationScope !== retainedParent.scope || lifetime.publicationHistory !== retainedParent.history ||
          lifetime.assertSdkHistory !== retainedParent.sdkHistory || lifetime.published !== retainedParent.published || !retainedParent.published || Reflect.apply(readDispatchWeakRef, retainedParent.published, []) !== original ||
          origin.assertApp !== retainedParent.app || origin.assertAppHistory !== retainedParent.appHistory || origin.assertSdkHistory !== retainedParent.originSdkHistory ||
          Object.getOwnPropertyDescriptor(group, "deadline")?.value !== question.deadline || !retainedParent.shorten || dataFunction(question.deadline, "shorten") !== retainedParent.shorten ||
          [...actions.values()].filter(action => action.completionGroup === group).length !== members.length ||
          members.some(({ key, action }) => actions.get(key) !== action || action.completionGroup !== group || action.publication !== original || action.retirement || nowMs() >= deadlineOf(action)))
        throw new Error("Telegram retained question parent is unavailable.");
      assertParentHistory([question]);
    };
    let preimageLost = false;
    const preimageCurrent = () => {
      const projection = completed?.projection;
      if (projection && (!original || original.ordinaryProjection !== projection || projection.lost || projection.queuedLost || projection.ordinary !== parentOrdinary || original.ordinary !== parentOrdinary ||
          !preimage || ![projection.before, projection.after].some(frame => frame && frame.keyboard === preimage.keyboard && frame.richMessage === preimage.richMessage && frame.richKeys === preimage.richKeys) ||
          !frameCurrent(original, projection.after ?? projection.before))) preimageLost = true;
      if ((completed && !projection || refreshSource) && (!original ||
          (ordinaryOnlyParent ? original.ordinary !== undefined || original.ordinarySource !== firstSource : original.ordinary !== parentOrdinary) ||
          original.keyboard !== preimage?.keyboard || original.richMessage !== preimage.richMessage || original.richKeys !== preimage.richKeys)) preimageLost = true;
      return !preimageLost;
    };
    // Authenticate and spend the original source before it can supply a question-free physical parent.
    const attempt = {}, refreshOrigin = successor && getGenerativeAppRefreshPublicationSource(successor.binding);
    const source = refreshOrigin && takePublicationSource(PUBLICATION_SOURCE_KEY, refreshOrigin.source, attempt);
    const ordinaryOnlyParent = !!source && editing && method === "editMessageText" && originals.length === 1 && !parents.length && !parentCandidates.length &&
      !!firstSource && original?.ordinary === undefined && original.ordinarySource === firstSource && firstSource.rows === parentOrdinary &&
      source.publication === original && source.publisher === parentGuard && source.ordinary === firstSource.rows && source.ordinary.length === 1 && !source.questions.length &&
      source.frame.keyboard === firstSource.frame.keyboard && source.frame.richMessage === firstSource.frame.richMessage && source.frame.richKeys === firstSource.frame.richKeys &&
      source.binding === parentOrdinary[0]!.lifetime.binding && refreshOrigin!.predecessor === parentOrdinary[0]!.lifetime.invocationOwner && frameCurrent(original, firstSource.frame);
    const editParents = editing && (parents.length > 0 || ordinaryOnlyParent) && Object.keys(body).every(key => editFields.includes(key)) &&
      (method === "editMessageReplyMarkup" || (typeof body.text === "string") !== (typeof rich?.markdown === "string")) &&
      (body.message_thread_id === undefined || threadId === parentThread) &&
      parentKeys.size === parentRows.length + (completed && parentKeys.has(completed.row.key) ? 1 : 0) &&
      (!parentOrdinary.length || (original?.ordinary === parentOrdinary || ordinaryOnlyParent) && parentOrdinary.every(row => !row.action.retirement || row === completed?.row)) &&
      parentRows.every(({ key, action }) => parentKeys.has(key) && (parents.some(parent => parent.members.some(member => member.key === key && member.action === action)) ||
        parentOrdinary.some(row => row.key === key && row.action === action && row.lifetime === action.ordinary))) ? parents : undefined;
    const physicalScope = editParents?.[0]?.lifetime.publicationScope ?? editParents?.[0]?.owner.scope ?? (ordinaryOnlyParent ? parentOrdinary[0]!.lifetime.owner.scope : undefined);
    const physicalHistory = editParents?.[0]?.lifetime.publicationHistory ?? (ordinaryOnlyParent ? parentOrdinary[0]!.lifetime.assertSdkHistory : undefined);
    const parentScopes = editParents?.flatMap(parent => [parent.owner.scope, parent.lifetime.publicationScope ?? parent.owner.scope]).concat(ordinaryOnlyParent ? [physicalScope!] : []);
    // Spend the first descriptor before original publisher callbacks, not merely before I/O.
    const questionGroups = new Set(records.flatMap(({ action }) =>
      action.promptKind === "selection" && action.completionGroup ? [action.completionGroup] : []));
    const completeQuestionRoster = [...keys].every(key => occurrences.filter(value => value === key).length === 1 && records.some(record => record.key === key)) &&
      records.every(({ action }) => !!action.completionGroup && questionGroups.has(action.completionGroup) ||
        !!action.ordinary && !action.publication && action.binding === action.ordinary.binding);
    const mixedEdit = editing && (ordinary.length > 0 || parentOrdinary.length > 0);
    const authorityRows = [...ordinary, ...(editing ? parentOrdinary : [])];
    const coheads: { group: TelegramButtonCompletionGroup; lifetime: QuestionLifetime; members: { key: string; action: Stored }[] }[] = [];
    for (const group of questionGroups) {
      const lifetime = groupFacts.get(group)?.lifetime;
      if (!lifetime || lifetime.attempt) continue;
      lifetime.attempt = attempt;
      if (editing && !editParents || !lifetime.owner ||
        body.message_thread_id !== undefined && (!Number.isSafeInteger(body.message_thread_id) || (body.message_thread_id as number) <= 0)) continue;
      const members = [...actions].flatMap(([key, action]) => action.completionGroup === group ? [{ key, action }] : []);
      if (members.length && members.every(({ key }) => keys.has(key)) &&
          (!editing || !parents.some(parent => parent.group === group) && members.every(({ key, action }) => !action.publication && occurrences.filter(value => value === key).length === 1))) {
        coheads.push({ group, lifetime, members });
      }
    }
    const batchBody = (value: Readonly<Record<string, unknown>>) =>
      Object.keys(value).every(key => (editing || key !== "message_id") && (editFields.includes(key) || !editing && key === "reply_parameters")) &&
      (method === "editMessageReplyMarkup" || (typeof value.text === "string") !== (typeof (value.rich_message as { markdown?: unknown } | undefined)?.markdown === "string")) &&
      (value.rich_message === undefined || !!cacheTelegramButtonRichMessage(value.rich_message));
    // Spend the existing descriptor before SDK/provider/FS callbacks, including refused first sends.
    if (!editing) for (const row of ordinary) row.action.ordinaryPublicationAttempt ??= attempt;
    let ordinaryFirst = !editing && ordinary.length === 1 && records.length === 1 && !questionGroups.size && completeQuestionRoster && batchBody(body) &&
      occurrences.length === 1 && ordinaryCandidates.some(row => row.key === ordinary[0]!.key && row.action === ordinary[0]!.action && row.lifetime === ordinary[0]!.lifetime);
    let ordinaryFirstPolicy = false;
    const assertOrdinaryFirst = (publication?: Publication) => {
      const data = () => {
        const row = ordinary[0];
        if (!ordinaryFirst || !row || row.action.ordinaryPublicationAttempt !== attempt || row.action.ordinary !== row.lifetime ||
            row.action.binding !== row.lifetime.binding || row.action.publication !== publication || actions.get(row.key) !== row.action ||
            row.action.retirement || nowMs() >= deadlineOf(row.action) || dataFunction(row.lifetime.binding, "assertCurrent") !== row.lifetime.assertApp ||
            row.lifetime.owner.target.chatId !== chatId || row.lifetime.owner.target.threadId !== threadId)
          throw new Error("Telegram original ordinary publication is unavailable.");
        row.action.assertAuthority!.assertObservedCurrent(); row.lifetime.assertSdkHistory(); row.lifetime.assertAppHistory();
      };
      try {
        data();
        const row = ordinary[0]!;
        row.lifetime.owner.assertCurrent(); row.lifetime.owner.assertScope(row.lifetime.owner.scope);
        row.action.assertAuthority!(); assertOrdinaryAuthority(ordinary); data();
      } catch { ordinaryFirst = false; }
    };
    let batch = coheads.length > 0 && coheads.length + (retainedParent ? 1 : 0) === questionGroups.size && (!editing || !!editParents) && batchBody(body) &&
      coheads.every(({ group, lifetime }) => !!group.deadline && (!authorityRows.length || !!lifetime.assertSdkHistory)) &&
      (!mixedEdit || !!physicalHistory && editParents?.every(parent => !!parent.lifetime.assertSdkHistory && !!parent.lifetime.publicationHistory)) && locators.every(({ key, value }) => ["chat_id", "message_thread_id"].includes(key) || editing && key === "message_id" || value === undefined) &&
      completeQuestionRoster ? coheads : undefined;
    // Native result association and native store issuance are independent proofs. Spend the source
    // with this first descriptor before callbacks, even if its target/roster/producer later refuses.
    if (refreshOrigin) {
      const sameParents = source && editParents?.length === source.questions.length && editParents.every(parent => source.questions.some(prior =>
        prior.group === parent.group && prior.lifetime === parent.lifetime && prior.owner === parent.owner && prior.members.length === parent.members.length &&
        prior.members.every(member => parent.members.some(current => current.key === member.key && current.action === member.action))));
      if (source && batch && editing && method === "editMessageText" && originals.length === 1 && source.publication === original && source.publisher === parentGuard &&
          preimage && source.frame.keyboard === preimage.keyboard && source.frame.richMessage === preimage.richMessage && source.frame.richKeys === preimage.richKeys &&
          source.ordinary === parentOrdinary && source.ordinary.length === 1 && source.binding === source.ordinary[0]!.lifetime.binding &&
          refreshOrigin.predecessor === source.ordinary[0]!.lifetime.invocationOwner && sameParents && ordinary.length <= 1 &&
          batch.every(head => head.lifetime.origin?.binding === successor!.binding) && ordinary.every(row => row.lifetime.binding === successor!.binding) &&
          !completed && !retainedParent && !pendingProjection && !queuedProjection && !original?.ordinaryParent) refreshSource = source;
      else batch = undefined;
    }
    if (batch) try {
      if (refreshSource) refreshSource.assertCurrent(0);
      // Common immutable SDK origin is proved before I/O, after every first descriptor was spent.
      const owner = batch[0]!.lifetime.owner!;
      assertRetained();
      for (const scope of parentScopes ?? []) owner.assertScope(scope);
      if (mixedEdit) {
        assertOrdinaryData(parentOrdinary, original!, false, completed); assertOrdinaryAuthority(parentOrdinary);
        // Native immutable row/cell/successor identity is captured before I/O, never reselected at ACK.
        if (completed) assertOrdinaryCompletion(completed);
      }
      for (const row of authorityRows) owner.assertScope(row.lifetime.owner.scope);
      for (const head of batch) {
        if (head.lifetime.owner!.target.chatId !== chatId || head.lifetime.owner!.target.threadId !== (editing ? parentThread : threadId))
          throw new Error("Telegram question head is unavailable.");
        owner.assertScope(head.lifetime.owner!.scope);
      }
      if (retainedParent) { retainedParent.question.lifetime.assertAuthority(); assertRetained(); }
    } catch { batch = undefined; }
    if (queuedProjection && (!batch || completed?.projection !== queuedProjection || !preimageCurrent())) { queuedProjection.lost = true; invalidatePublication(original!); throw new Error("Telegram queued feedback projection is unavailable."); }
    existing = originals.find(view => {
      try { view.assertAuthority(); return !view.lost && publications.has(view); }
      catch { invalidatePublication(view); return false; }
    });
    if (existing && existing.busy >= TELEGRAM_BUTTON_ACTION_CAPACITY) throw new Error("Telegram callback publication queue is full.");
    let membershipWithheld = false, followerEditObserved = false, nativeEditWithheld = false;
    const nativeParentEditMatches = (result: unknown) => {
      const data = (value: unknown, key: string): unknown => {
        const field = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
        if (field && !("value" in field)) throw new Error("Unconfirmed native parent edit");
        return field?.value;
      };
      try {
        return data(result, "message_id") === messageId && data(data(result, "chat"), "id") === chatId &&
          data(result, "message_thread_id") === parentThread && data(result, "business_connection_id") === undefined;
      } catch { return false; }
    };
    const applySdkTail = (publication: Publication, parentCurrent: boolean, postimage?: PublicationFrame) => {
      if (batch && !membershipWithheld) {
        if (editing && (!parentCurrent || publication !== original)) return;
        const heads = batch, owner = heads[0]!.lifetime.owner!, assertPublication = publication.assertAuthority, at = nowMs();
        const originBatch = heads.some(head => !!head.lifetime.origin);
        const origins = [...heads.flatMap(head => head.lifetime.origin?.assertApp ? [head.lifetime.origin] : []), ...(retainedParent ? [retainedParent.origin] : [])];
        const assertAppAuthority = authorityRows.length || origins.length ? () => { assertOrdinaryAuthority(authorityRows); for (const origin of origins) assertQuestionAppCurrent(origin); } : undefined;
        const deferred = ordinaryDeferredFeedbackParent && completed?.projection && !completed.projection.feedback ? completed.projection : undefined;
        const conditional = !!deferred && !!ordinaryDeferredSdkTail, matchAdmission = conditional ? heads[0]!.lifetime.matchAdmissionEvent : undefined;
        const cutHeads = conditional ? heads.map(head => ({ group: head.group, deadline: head.group.deadline!, shorten: dataFunction(head.group.deadline, "shorten") })) : [];
        let cutoff: number | undefined, matching = false, committing = false;
        const live = ({ group, lifetime, members }: typeof heads[number]) => lifetime.attempt === attempt && !retiredGroups.has(group) &&
          [...actions.values()].filter(action => action.completionGroup === group).length === members.length &&
          members.every(({ key, action }) => actions.get(key) === action && !action.retirement && action.publication === publication && nowMs() < deadlineOf(action));
        const terminal = ({ group, members }: typeof heads[number]) => retiredGroups.has(group) &&
          members.every(({ action }) => action.retirement === "deadline" || action.retirement === "consumed");
        const eligible = heads.filter(live);
        const assertAvailable = () => {
          assertRetained();
          if (conditional && (!matchAdmission || cutHeads.some(head => !head.shorten || Object.getOwnPropertyDescriptor(head.group, "deadline")?.value !== head.deadline || dataFunction(head.deadline, "shorten") !== head.shorten) || cutoff !== undefined && nowMs() >= cutoff)) throw new Error("Telegram conditional SDK tail is unavailable.");
          if (deferred && (publication.ordinaryProjection !== deferred || !publication.closing || !deferred.after || !deferred.queuedClaimed || deferred.lost || deferred.queuedLost ||
            deferred.ordinary !== parentOrdinary || publication.ordinary !== (committing ? ordinary : parentOrdinary) ||
            committing && publication.ordinaryParent !== transition || !heads.every(live))) throw new Error("Telegram queued result is unavailable.");
          if ((completed || refreshSource) && (!postimage || publication.keyboard !== postimage.keyboard || publication.richMessage !== postimage.richMessage || publication.richKeys !== postimage.richKeys) ||
            publication.lost || !publication.threadKnown || publication.assertAuthority !== assertPublication ||
            publication.chatId !== chatId || publication.threadId !== (editing ? parentThread : threadId) || !eligible.some(live) ||
            heads.some(head => !live(head) && !terminal(head)) || editing && (publication.assertAuthority !== parentGuard ||
              !editParents!.every(parent => parent.group === retainedParent?.question.group || retiredGroups.has(parent.group)) || parentRows.some(({ key, action }) =>
                retainedParent?.question.members.some(member => member.key === key && member.action === action) ? false : actions.has(key) || action.publication !== publication || action.retirement !== "superseded"))) throw new Error("Telegram question head is unavailable.");
          assertOrdinaryData(ordinary, publication);
          if (mixedEdit) { assertOrdinaryData(parentOrdinary, publication, true, completed); assertParentHistory(editParents!); physicalHistory!(); }
          for (const head of heads) if (authorityRows.length) head.lifetime.assertSdkHistory!();
          assertPublication.assertObservedCurrent();
          for (const head of heads) head.lifetime.assertAuthority.assertObservedCurrent();
        };
        const transition = mixedEdit ? { rows: parentOrdinary, questions: editParents!, ...(completed ? { completed } : {}) } : undefined;
        const publish = () => {
          if (authorityRows.length) publication.ordinary = ordinary;
          if (transition) publication.ordinaryParent = transition;
          assertAvailable();
          // Expose the whole certified batch before callbacks can admit a newer head.
          for (const { lifetime } of eligible) {
            lifetime.published = new WeakRef(publication); lifetime.publicationScope = editing ? physicalScope : owner.scope;
            lifetime.publicationHistory = editing ? physicalHistory : heads[0]!.lifetime.assertSdkHistory;
          }
        };
        try {
          if (!deferred) publish();
          const agentTails = captureQuestionTails().filter(candidate => !questionGroups.has(candidate.group) || candidate.group === retainedParent?.question.group);
          const fence = captureQueuedHeadFence(peer => owner.assertScope(peer.scope), completed?.projection);
          const apply = owner.captureTail({ scopes: [...heads.map(head => head.lifetime.owner!.scope), ...authorityRows.map(row => row.lifetime.owner.scope), ...(parentScopes ?? [])],
            ...(assertAppAuthority ? { assertAuthority: assertAppAuthority } : {}), assertCurrent: assertAvailable });
          if (!deferred) fence();
          const assertOriginal = () => {
            owner.assertCurrent(); assertPublication();
            for (const scope of parentScopes ?? []) owner.assertScope(scope);
            for (const head of heads) {
              owner.assertScope(head.lifetime.owner!.scope);
              if (live(head)) head.lifetime.assertAuthority(); else if (!terminal(head)) throw new Error("Telegram question head is unavailable.");
            }
            for (const row of authorityRows) { owner.assertScope(row.lifetime.owner.scope); row.action.assertAuthority!(); }
            if (retainedParent) retainedParent.question.lifetime.assertAuthority();
            owner.assertCurrent(); assertPublication(); assertAvailable();
          };
          let spent = false;
          const complete = () => {
            if (spent) throw new Error("Telegram queued result is unavailable.");
            spent = true;
            try {
              if (deferred) {
                if (!deferred.feedback || deferred.feedback !== completed!.row.action.ordinaryFeedback || deferred.feedback.frame !== deferred.after) throw new Error("Telegram queued result is unavailable.");
                fence(); assertAvailable(); committing = true; publish();
              }
              assertOriginal(); apply();
              shortenQuestionTails(agentTails, peer => { owner.assertScope(peer.scope); assertOriginal(); return at; }, assertAvailable,
                assertAppAuthority);
              if (cutoff !== undefined) {
                assertOriginal(); assertAppAuthority?.(); assertAvailable();
                for (const head of cutHeads) Reflect.apply(head.shorten!, head.deadline, [cutoff]);
              }
            } catch (error) {
              if (transition || originBatch) for (const { lifetime } of eligible) if (lifetime.attempt === attempt) lifetime.published = undefined;
              throw error;
            } finally { if (transition && publication.ordinaryParent === transition) delete publication.ordinaryParent; }
          };
          if (deferred) {
            const queuedResult = Object.freeze({ assertCurrent: () => {
              if (deferred.queuedResult !== queuedResult) throw new Error("Telegram queued result is unavailable.");
              assertAvailable();
            }, complete, ...(conditional ? { admit: (admission: unknown) => {
              if (matching || spent) { deferred.queuedLost = true; return; }
              matching = true;
              try {
                if (deferred.queuedResult !== queuedResult) throw new Error("Telegram queued result is unavailable.");
                const admittedAt = Reflect.apply(matchAdmission!, owner, [admission]) as number | undefined;
                if (admittedAt === undefined) return;
                assertAvailable();
                if (!Number.isFinite(admittedAt) || cutoff !== undefined) throw new Error("Telegram conditional SDK tail is unavailable.");
                assertOriginal();
                const confirmed = Reflect.apply(matchAdmission!, owner, [admission, {
                  ...(assertAppAuthority ? { assertAuthority: assertAppAuthority } : {}), assertCurrent: assertAvailable,
                }]) as number | undefined;
                if (confirmed !== admittedAt || nowMs() >= admittedAt + TELEGRAM_QUESTION_TAIL_MS) throw new Error("Telegram conditional SDK tail is unavailable.");
                cutoff = admittedAt + TELEGRAM_QUESTION_TAIL_MS;
              } catch { deferred.queuedLost = true; }
              finally { matching = false; }
            } } : {}) });
            deferred.queuedResult = queuedResult;
          } else complete();
        } catch {
          // Failed mixed-parent qualification cannot leave fresh weak facts that forget the unavailable parent.
          if (deferred) deferred.lost = true;
          if (transition || originBatch) for (const { lifetime } of eligible) if (lifetime.attempt === attempt) lifetime.published = undefined;
        } finally { if (transition && publication.ordinaryParent === transition) delete publication.ordinaryParent; }
      }
    };
    const retirementBeforeIssuance = (key: string) => existing?.feedback.get(key)?.retirement ??
      retirementFeedback(records.find(record => record.key === key)?.action.retirement).retirement;
    let publishedKeyboard = keyboard;
    let publishedRich = richSnapshot;
    const ready = existing?.tail.then(() => {
      if (existing.lost) throw new Error("Telegram callback publication is unavailable.");
      existing.assertAuthority(); preimageCurrent(); projectionPreimage();
    });
    const drain = Promise.withResolvers<void>();
    publicationWork.add(drain.promise);
    if (existing) { existing.busy++; existing.tail = drain.promise; }
    if (completed?.projection && batch) completed.projection.queuedPending = true;
    let settled = false;
    const finish: NonNullable<ReturnType<TelegramButtonPublicationObserver>> = (result, succeeded, rejected, nativeEditResult) => {
      if (settled) return;
      settled = true;
      const nativeEditAcknowledged = followerEditObserved && !nativeEditWithheld && nativeParentEditMatches(nativeEditResult);
      // Deferred follower results still need both native edit carriers; the original editor's completion
      // applies the already-captured cohort, never a pending head or a fresh settlement-time SDK lookup.
      if (followerEditObserved && !nativeEditAcknowledged) membershipWithheld = true;
      try {
        if (succeeded && refreshSource && batch && !membershipWithheld) try { refreshSource.assertCurrent(1); } catch { membershipWithheld = true; }
        if (succeeded) {
          const sentId = messageId ?? (result as { message_id?: unknown } | undefined)?.message_id;
          if (Number.isSafeInteger(sentId) && (sentId as number) > 0) {
            let publication = existing;
            const candidates = records.filter(({ action }) => !action.publication || action.publication === publication);
            if (!publication && candidates.length) {
              publication = { chatId, messageId: sentId as number, threadKnown: !editing || threadId !== undefined,
                ...(threadId !== undefined ? { threadId } : {}),
                richKeys: new Set(), assertAuthority: candidates[0]!.action.assertAuthority!, tail: Promise.resolve(), busy: 0, dirty: false, closing: false, lost: false, feedback: new Map() };
              publications.add(publication);
            }
            if (publication && !publication.lost) {
              // Feedback and head membership are separate: a held app cohort may still have a proven native edit.
              // A normalized follower outcome never certifies feedback; direct embeddings retain their native outcome contract.
              const edited = followerEditObserved ? nativeEditAcknowledged : result === "edited";
              const parentCurrent = !batch || !editing || edited &&
                publication === original && publication.assertAuthority === parentGuard && preimageCurrent() && (!completed?.projection || !!completed.projection.feedback &&
                  completed.projection.feedback === completed.row.action.ordinaryFeedback && completed.projection.feedback.frame === completed.projection.after ||
                  !!ordinaryDeferredFeedbackParent && !!completed.projection.after && publication.closing && publication.ordinaryProjection === completed.projection) && (!parentOrdinary.length || (ordinaryOnlyParent ? publication.ordinary === undefined && publication.ordinarySource === firstSource : publication.ordinary === parentOrdinary)) && editParents!.every(parent => questionTailCurrent(parent, completed)) &&
                [...actions.values()].filter(action => action.publication === publication).length === parentRows.length;
              projectionPreimage();
              const projectionAcknowledged = projection && !projection.lost && edited && publication === original && publication.assertAuthority === projection.authority;
              if (publishedKeyboard !== undefined) publication.keyboard = publishedKeyboard;
              if (method !== "editMessageReplyMarkup") {
                publication.richMessage = cacheTelegramButtonRichMessage(publishedRich);
                publication.richKeys = new Set();
                if (typeof publishedRich?.markdown === "string") mapTelegramRichCallbackRows(publishedRich.markdown, (key, tag) => {
                  publication!.richKeys.add(key); return tag;
                });
              }
              for (const key of publication.feedback.keys()) if (!keys.has(key)) publication.feedback.delete(key);
              for (const { key, action } of candidates) {
                action.publication = publication;
                if (actions.get(key) !== action) { publication.dirty = true; publication.feedback.set(key, retirementFeedback(action.retirement)); }
              }
              const visible = new Set(publication.richKeys);
              for (const row of publication.keyboard?.inline_keyboard ?? []) for (const button of row)
                if (button.callback_data) visible.add(button.callback_data);
              const retired: ReturnType<typeof captureGroupRetirement>[] = [];
              for (const [key, action] of actions) if (action.publication === publication && !visible.has(key)) retired.push(captureGroupRetirement(groupOf(key, action), "superseded"));
              if (projectionAcknowledged) {
                projection.after = { keyboard: publication.keyboard, richMessage: publication.richMessage, richKeys: publication.richKeys };
                try { projectionData(publication, projection); } catch { projection.lost = true; }
              }
              if (ordinaryFirst && ordinaryFirstPolicy && !nativeEditWithheld) {
                const frame = Object.freeze({ keyboard: publication.keyboard, richMessage: publication.richMessage, richKeys: publication.richKeys });
                assertOrdinaryFirst(publication);
                if (ordinaryFirst && !publication.lost && !publication.dirty && !publication.closing && !publication.busy && frameCurrent(publication, frame) &&
                    visible.size === 1 && visible.has(ordinary[0]!.key) && [...actions.values()].filter(action => action.publication === publication).length === 1)
                  publication.ordinarySource = Object.freeze({ rows: ordinary, frame });
              }
              const postimage = completed || refreshSource ? { keyboard: publication.keyboard, richMessage: publication.richMessage, richKeys: publication.richKeys } : undefined;
              try { applySdkTail(publication, parentCurrent, postimage); }
              finally { for (const fact of retired) notifyGroupRetirement(fact); }
              while (publications.size > TELEGRAM_BUTTON_ACTION_CAPACITY) {
                const abandoned = [...publications].find(view => !hasActivePublication(view));
                if (!abandoned) break;
                discardPublication(abandoned);
              }
            }
          }
        } else if (editing && !rejected) {
          // An unknown edit cannot authorize an old snapshot to overwrite a newer view.
          // A native method-bound rejection preserves the prior snapshot and unspent IDs.
          if (existing) invalidatePublication(existing);
          for (const { key, action } of records) if (actions.get(key) === action) expireGroup(groupOf(key, action), "publication-lost");
        }
      } catch (error) { reportFailure(error); }
      finally {
        if (existing) existing.busy--;
        if (completed?.projection) { delete completed.projection.queuedPending; if (existing?.ordinaryProjection === completed.projection && !existing.closing) delete existing.ordinaryProjection; }
        publicationWork.delete(drain.promise); drain.resolve();
        pumpPublications();
      }
    };
    finish.ready = ready;
    if (ordinaryFirst || editing && firstSource) Object.defineProperty(finish, "ordinarySource", {
      value: editing ? "known-parent-edit" : "first-send", enumerable: true,
    });
    // Refusal-only: retain native publication/selection and spent descriptors, never mint or rebase a head.
    finish.restrictQuestionMembership = policy => {
      followerEditObserved ||= policy === "known-parent-edit";
      nativeEditWithheld ||= policy === "none";
      ordinaryFirstPolicy ||= policy === "first-send";
      if (policy === "none") ordinaryFirst = false;
      // A mixed first send must be one original native app result, not merely equal app/revision or SDK fields.
      const binding = batch?.[0]?.lifetime.origin?.binding;
      const oneResult = binding !== undefined && batch?.every(head => head.lifetime.origin?.binding === binding) &&
        ordinary.every(row => row.lifetime.binding === binding);
      const mixedFirstSend = !editing && ordinary.length > 0 && oneResult;
      // Only one original read-only invocation/first-published parent, optionally queued behind its captured feedback.
      // The original projection/final-use gate owns deferred completion; pure questions need no dummy control.
      const appEdit = editing && method === "editMessageText" && completed &&
        (completed.feedback && !completed.projection || queuedProjection && completed.projection === queuedProjection) &&
        oneResult && binding === completed.successor.binding && parentOrdinary.length === 1 &&
        parentOrdinary.every(row => row.lifetime.binding === completed.row.lifetime.binding) && editParents?.every(parent =>
          parent.lifetime.origin?.binding === completed.row.lifetime.binding &&
          parent.lifetime.publicationScope === editParents[0]!.owner.scope &&
          parent.lifetime.publicationHistory === editParents[0]!.lifetime.assertSdkHistory);
      const refreshEdit = !!refreshSource && !!refreshOrigin && !completed && oneResult && editing && method === "editMessageText";
      // One retained original group needs both native Rich carriers and the existing exact-parent proof.
      // assertRetained owns its original birth/selection/publisher; this policy cannot recreate or promote it.
      const retainedEdit = !!retainedParent && !!appEdit && !!richSnapshot && !!original?.richMessage;
      membershipWithheld ||= policy === "none" || !batch || !!retainedParent && !retainedEdit ||
        (editing ? policy !== "known-parent-edit" || !editParents || !appEdit && !refreshEdit && (ordinary.length > 0 || authorityRows.length > 0 ||
          [...batch, ...editParents].some(head => head.lifetime.origin?.binding !== undefined)) :
          policy !== "first-send" || authorityRows.length > 0 && !mixedFirstSend);
    };
    finish.assertPublicationBody = publishedBody => {
      preimageCurrent(); projectionPreimage();
      if (refreshSource && batch && !membershipWithheld) try { refreshSource.assertCurrent(1); } catch { membershipWithheld = true; }
      if (ordinaryFirst && ordinaryFirstPolicy) {
        if (!batchBody(publishedBody)) ordinaryFirst = false;
        else assertOrdinaryFirst();
      }
      const projectedKeys = projection ? projectionKeys(publishedKeyboard, publishedRich as TelegramButtonPublicationRichMessage | undefined) : [];
      if (projection && (projection.lost || Object.keys(publishedBody).some(key => !["chat_id", "message_id", "reply_markup", "rich_message"].includes(key)) ||
          projectedKeys.length !== projection.members.length || new Set(projectedKeys).size !== projectedKeys.length || !projection.members.every(member => projectedKeys.includes(member.key)))) {
        projection.lost = true; throw new Error("Telegram callback publication is unavailable.");
      }
      if (batch && !batchBody(publishedBody))
        throw new Error("Telegram callback publication locator is unavailable.");
      if (typeof publishedBody.toJSON === "function") throw new Error("Telegram callback publication locator is unavailable.");
      if (batch || projection || ordinaryFirst && ordinaryFirstPolicy) {
        // Seal only store-produced callback carriers; caller markup and non-control rendering stay mutable.
        const sealSerializer = (value: object) => Object.defineProperty(value, "toJSON", { value: undefined, configurable: false, writable: false });
        for (const key of ["reply_markup", "rich_message"] as const) {
          const value = key === "reply_markup" ? publishedKeyboard : publishedRich;
          if (publishedBody[key] !== value) throw new Error("Telegram callback publication locator is unavailable.");
          Object.defineProperty(publishedBody, key, { value, configurable: false, writable: false, enumerable: Object.hasOwn(publishedBody, key) });
          if (value) sealSerializer(value);
        }
        if (publishedKeyboard) {
          for (const row of publishedKeyboard.inline_keyboard) {
            for (const button of row) { sealSerializer(button); Object.defineProperty(button, "callback_data", {
              value: button.callback_data, configurable: false, writable: false, enumerable: Object.hasOwn(button, "callback_data") }); }
            sealSerializer(row); Object.freeze(row);
          }
          sealSerializer(publishedKeyboard.inline_keyboard); Object.freeze(publishedKeyboard.inline_keyboard);
          Object.defineProperty(publishedKeyboard, "inline_keyboard", { value: publishedKeyboard.inline_keyboard, configurable: false, writable: false });
        }
        if (publishedRich && typeof publishedRich.markdown === "string") {
          let callbacks = false; mapTelegramRichCallbackRows(publishedRich.markdown, (_key, tag) => { callbacks = true; return tag; });
          if (callbacks || projection) Object.defineProperty(publishedRich, "markdown", { value: publishedRich.markdown, configurable: false, writable: false });
        }
      }
      for (const { key, value } of locators) {
        const actual = Object.getOwnPropertyDescriptor(publishedBody, key);
        if (actual?.get || actual?.set || !Object.is(actual?.value, value))
          throw new Error("Telegram callback publication locator is unavailable.");
      }
      // Whole-body serializers cannot replace the sealed identity during native JSON encoding.
      Object.defineProperty(publishedBody, "toJSON", { value: undefined, writable: false, configurable: false, enumerable: !!batch || !!projection });
      // Seal only routing identity on the actual post-spread carrier, not caller text or rendering data.
      for (const { key, value } of locators) Object.defineProperty(publishedBody, key,
        { value, writable: false, configurable: false, enumerable: Object.hasOwn(publishedBody, key) });
    };
    let bindingsChecked = false;
    const checkBindings = () => {
      if (bindingsChecked) return;
      bindingsChecked = true;
      for (const { key, action } of records) if (actions.get(key) === action && action.binding) {
        try { action.binding.assertCurrent?.(); } catch { retireBinding(action.binding); }
      }
    };
    if (keyboard) finish.prepareReplyMarkup = () => {
      // Project immediately before native issuance, not before an awaited predecessor.
      checkBindings();
      publishedKeyboard = { ...keyboard, inline_keyboard: keyboard.inline_keyboard.map(row => row.map(button => {
        const key = button.callback_data, action = key && actions.get(key);
        if (key === TELEGRAM_BUTTON_EXPIRED_CALLBACK || key === TELEGRAM_BUTTON_CAPACITY_CALLBACK || !key?.startsWith("tgbtn:") || action && (!action.publication || action.publication === existing)) return { ...button };
        const retirement = retirementBeforeIssuance(key);
        if (retirement) return retiredButton(button.text, retirement);
        const { callback_data: _key, ...rest } = button;
        const style = existing?.feedback.get(key)?.style;
        return { ...rest, disabled: {}, ...(style ? { style } : {}) };
      })) };
      return publishedKeyboard;
    };
    if (richSnapshot) finish.prepareRichMessage = () => {
      checkBindings();
      publishedRich = { ...richSnapshot, markdown: mapTelegramRichCallbackRows(richSnapshot.markdown as string, (key, tag) => {
        const action = actions.get(key);
        return action && (!action.publication || action.publication === existing) ? tag : retiredRichTag(retirementBeforeIssuance(key));
      }) };
      return publishedRich;
    };
    return finish;
  };
  const retireBinding = (binding: TelegramOutboundButtonBinding): void => {
    for (const [key, action] of actions) if (action.binding === binding) expireGroup(groupOf(key, action), "owner-lost");
  };
  const groupOf = (key: string, action: TelegramOutboundButtonAction): object | string =>
    action.selection?.owner ?? action.completionGroup ?? key;
  const captureGroupRetirement = (group: object | string, reason: TelegramButtonRetirementReason) => {
    const completions = new Set<TelegramButtonCompletionGroup>();
    let first: Stored | undefined, count = 0;
    if (typeof group === "object") retiredGroups.add(group);
    // Known semantic expiry is question-local; uncertain publication, authority and capacity remain footer-wide.
    for (const [key, action] of actions) if ((reason === "deadline" ? action.completionGroup ?? groupOf(key, action) : groupOf(key, action)) === group) {
      first ??= action; count++;
      removeAction(key, action, undefined, reason);
      if (action.completionGroup) completions.add(action.completionGroup);
    }
    for (const completion of completions) retiredGroups.add(completion);
    return { reason, count, first, completions };
  };
  const notifyGroupRetirement = ({ reason, count, first, completions }: ReturnType<typeof captureGroupRetirement>) => {
    reportRetirement(reason, count, first);
    for (const completion of completions) try { completion.retire?.(reason); } catch (error) { reportFailure(error); }
  };
  const expireGroup = (group: object | string, reason: TelegramButtonRetirementReason = "superseded"): void => {
    notifyGroupRetirement(captureGroupRetirement(group, reason));
  };
  const retireGroup = (group: object): void => {
    retiredGroups.add(group);
    for (const [key, action] of actions) if (action.completionGroup === group) removeAction(key, action);
    armExpiry();
  };
  const retireSelection = (owner: object): void => {
    retiredGroups.add(owner);
    for (const [key, action] of actions) if (action.selection?.owner === owner) {
      removeAction(key, action);
      if (action.completionGroup) retiredGroups.add(action.completionGroup);
    }
    armExpiry();
  };
  const capturePublicationAuthority = (stored: Stored): (() => void) => {
    const publication = stored.publication, publisher = publication?.assertAuthority;
    return () => {
      if (!publication) return;
      const current = () => stored.publication === publication && !publication.lost && publication.assertAuthority === publisher;
      try {
        if (!current()) throw new Error("Telegram callback publication is unavailable.");
        publisher!();
        if (!current()) throw new Error("Telegram callback publication is unavailable.");
      } catch (error) { invalidatePublication(publication); throw error; }
    };
  };
  const guardSelection = (selection: TelegramButtonSelectionAction, stored: Stored): TelegramButtonSelectionAction => {
    const assertAuthority = stored.assertAuthority ?? getAuthority(selection.owner), completionGroup = stored.completionGroup;
    let expired = false;
    const assertDeadline = () => {
      if (expired || nowMs() >= deadlineOf(stored)) {
        expired = true;
        expireGroup(completionGroup ?? selection.owner, "deadline");
        throw new Error("Telegram selection update is unavailable.");
      }
    };
    return { ...selection, prepare: query => {
      const assertPublication = capturePublicationAuthority(stored);
      try { assertPublication(); assertAuthority(); assertPublication(); } catch { retireSelection(selection.owner); return undefined; }
      try { assertDeadline(); } catch { return undefined; }
      const update = selection.prepare(query);
      if (!update) return undefined;
      try { assertDeadline(); } catch { update.fail(); return undefined; }
      if (update.prompt !== undefined) {
        if (completionGroup) retireGroup(completionGroup); else retireSelection(selection.owner);
      }
      const assertCurrent = () => { assertPublication(); assertAuthority(); assertDeadline(); update.assertCurrent(); assertPublication(); };
      return { ...update, assertCurrent,
        commit: () => { assertCurrent(); update.commit(); },
        fail: () => { try { update.fail(); } finally { retireSelection(selection.owner); } },
      };
    } };
  };
  const cleanup = (currentTime: number, selection?: TelegramButtonSelectionAction): void => {
    for (const [key, action] of actions) {
      if (currentTime >= deadlineOf(action)) {
        // Only this store's still-indexed row can acquire native deadline non-use.
        const publication = action.publication, lifetime = action.ordinary;
        if (lifetime && publication?.ordinary?.some(row => row.key === key && row.action === action && row.lifetime === lifetime) && !action.retirement)
          action.ordinaryDeadline = Object.freeze({ key, lifetime, publication });
        expireGroup(action.completionGroup ?? groupOf(key, action), "deadline");
      }
      else if (selection && action.selection?.owner === selection.owner && action.selection.revision !== selection.revision)
        actions.delete(key);
    }
  };
  const armExpiry = (): void => {
    const revision = ++expiryRevision;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (clearing || actions.size === 0) return;
    let next = Infinity;
    for (const action of actions.values()) next = Math.min(next, deadlineOf(action));
    expiryTimer = setTimeout(() => {
      if (revision !== expiryRevision) return;
      expiryTimer = undefined;
      try { cleanup(nowMs()); } catch (error) { reportFailure(error); }
      finally { armExpiry(); }
    }, Math.max(0, Math.min(2_147_483_647, next - nowMs())));
    expiryTimer.unref();
  };
  return {
    onQuestionAdmission: admission => {
      // Snapshot before either native SDK or original agent guards can reenter.
      const tails = captureQuestionTails();
      captureQueuedHeadFence(owner => { owner.assertAdmission(admission); }, undefined, admission)();
      shortenQuestionTails(tails, owner => owner.assertAdmission(admission));
    },
    observeAppOwner: owner => {
      if (questionAppOrigin) for (const [key, action] of actions) {
        const origin = action.completionGroup && groupFacts.get(action.completionGroup)?.origin;
        if (!origin || (questionAppOrigin === "independent" ? origin.selectionLost : origin.lost) || !origin.assertApp || !origin.binding) continue;
        const binding = origin.binding as object, field = (key: string) => Object.getOwnPropertyDescriptor(binding, key)?.value as unknown;
        if (field("app") !== owner.app) continue;
        let stale = owner.reset || field("generation") !== owner.generation || owner.revision !== undefined && field("revision") !== owner.revision;
        if (!stale) { try { if (questionAppOrigin === "independent") origin.selectionAuthority!(); else assertQuestionAppCurrent(origin); } catch { stale = true; } }
        if (stale) { origin.lost = true; origin.selectionLost = true; expireGroup(groupOf(key, action), "owner-lost"); }
      }
      for (const [key, action] of actions) if (action.binding?.app === owner.app) {
        let stale = owner.reset || action.binding.generation !== owner.generation || owner.revision !== undefined && action.binding.revision !== owner.revision;
        if (!stale) { try { action.binding.assertCurrent?.(); } catch { stale = true; } }
        if (stale) expireGroup(groupOf(key, action), "owner-lost");
      }
      armExpiry();
    },
    beginPublication,
    capturePublicationSource,
    bindPublicationEditor: editor => {
      if (publicationEditor) throw new Error("Telegram callback publication editor is already bound.");
      publicationEditor = editor; pumpPublications();
    },
    waitForPublicationIdle: async () => { while (publicationWork.size) await Promise.all([...publicationWork]); },
    clear: () => {
      if (clearing) return;
      clearing = true; expiryRevision++;
      if (ordinaryCallbackDispatch) for (const publication of publications) {
        if (publication.ordinaryProjection) publication.ordinaryProjection.lost = true;
        for (const record of [...(publication.ordinary ?? []), ...(publication.ordinaryParent?.rows ?? [])]) {
          delete record.action.ordinaryDispatch; delete record.action.ordinaryInvocation; delete record.action.ordinaryInvocationHistory; delete record.action.ordinaryFeedback;
        }
      }
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
      expiryTimer = undefined;
      try {
        while (actions.size) {
          const [key, action] = actions.entries().next().value!;
          expireGroup(groupOf(key, action), "clear");
        }
      } finally { clearing = false; }
    },
    register: (action, questionResultBinding) => {
      if (clearing) throw new Error("Telegram callback store is clearing.");
      if (admitting) { admissionPoisoned = true; throw new Error("Telegram callback admission reentered."); }
      admitting = true; admissionPoisoned = false;
      let reserved: string | undefined;
      try {
        const ordinary = captureOrdinary(action);
        const origin = questionAppOrigin && action.promptKind === "selection" && action.completionGroup ? captureQuestionOrigin(action.completionGroup, questionResultBinding, action.selection?.owner ?? action.completionGroup) : undefined;
        const currentTime = nowMs();
        cleanup(currentTime, action.selection);
        const key = `${TELEGRAM_BUTTON_CALLBACK_PREFIX}:${randomUUID().slice(0, 8)}`, group = groupOf(key, action);
        if (action.completionGroup && retiredGroups.has(action.completionGroup)) throw new Error("Telegram callback group is retired.");
        if (typeof group === "object") {
          if (retiredGroups.has(group)) throw new Error("Telegram callback group is retired.");
          ensureGroupFacts(group, currentTime);
        }
        if (action.binding) {
          action.binding.assertCurrent?.();
          if (admissionPoisoned) throw new Error("Telegram callback admission is unavailable.");
          for (const old of actions.values()) if (old.binding?.app === action.binding.app) {
            if (old.binding.generation === action.binding.generation && old.binding.revision > action.binding.revision)
              throw new Error("Telegram app callback revision is stale.");
          }
          for (const [oldKey, old] of actions) if (old.binding?.app === action.binding.app &&
              (old.binding.generation !== action.binding.generation || old.binding.revision !== action.binding.revision))
            expireGroup(groupOf(oldKey, old));
        }
        action.completionGroup?.deadline?.bindStore(armExpiry);
        while (actions.size >= TELEGRAM_BUTTON_ACTION_CAPACITY) {
          let oldest: object | string | undefined, oldestAt = Infinity;
          for (const [oldKey, old] of actions) {
            const candidate = groupOf(oldKey, old);
            const born = typeof candidate === "object" ? groupFacts.get(candidate)?.birth ?? old.createdAt : old.createdAt;
            if (candidate !== group && born < oldestAt) { oldest = candidate; oldestAt = born; }
          }
          if (oldest === undefined) {
            expireGroup(group, "capacity");
            throw new RangeError("Telegram callback group exceeds capacity.");
          }
          expireGroup(oldest, "capacity");
        }
        const stored: Stored = { ...action, createdAt: currentTime }; delete stored.ordinary; delete stored.ordinaryDeadline; delete stored.ordinaryDispatch; delete stored.ordinaryInvocation; delete stored.ordinaryInvocationHistory; delete stored.ordinaryFeedback;
        actions.set(key, stored); reserved = key;
        stored.assertAuthority = ordinary?.authority ?? (origin ? origin.selectionAuthority ?? questionOriginAuthority(origin, action.selection?.owner ?? action.completionGroup) : getAuthority(action.selection?.owner ?? action.completionGroup));
        if (ordinary?.lifetime && stored.binding === ordinary.lifetime.binding && stored.promptKind === undefined && !stored.selection && !stored.completionGroup) stored.ordinary = ordinary.lifetime;
        action.completionGroup?.deadline?.shorten(deadlineOf(stored));
        if (captureQuestionOwner && action.promptKind === "selection" && action.completionGroup) {
          const facts = ensureGroupFacts(action.completionGroup, currentTime);
          if (questionResultBinding !== undefined && !questionAppOrigin) {
            // A labeled app question must not masquerade as an unbound agent cohort before its original app capture is wired.
            facts.lifetime ??= { assertAuthority: stored.assertAuthority };
            delete facts.lifetime.owner; delete facts.lifetime.matchAdmissionEvent; delete facts.lifetime.assertSdkHistory;
          } else if (!facts.lifetime) {
            const lifetime: QuestionLifetime = { assertAuthority: origin ? questionOriginAuthority(origin, action.selection?.owner ?? action.completionGroup) : stored.assertAuthority, ...(origin ? { origin } : {}) }; facts.lifetime = lifetime;
            if (captureAuthority && !admissionPoisoned && actions.get(key) === stored) try {
              lifetime.assertAuthority();
              const owner = origin ? origin.owner : Reflect.apply(captureQuestionOwner, options, []);
              const match = ordinaryDeferredSdkTail ? origin ? origin.matchAdmissionEvent : dataFunction(owner, "matchAdmissionEvent") as AdmissionMatch | undefined : undefined;
              lifetime.assertAuthority(); owner?.assertCurrent(); lifetime.assertAuthority();
              if (!admissionPoisoned && actions.get(key) === stored) { lifetime.owner = owner; lifetime.matchAdmissionEvent = match; lifetime.assertSdkHistory = origin ? origin.assertSdkHistory : dataFunction(owner, "assertObservedCurrent"); }
            } catch { /* Unknown original SDK scope is sticky for this group, not a later-runtime lookup. */ }
          }
        }
        if (action.selection) stored.selection = guardSelection(action.selection, stored);
        if (admissionPoisoned || actions.get(key) !== stored) throw new Error("Telegram callback admission is unavailable.");
        return key;
      } catch (error) {
        if (reserved) {
          const stored = actions.get(reserved);
          if (stored) expireGroup(groupOf(reserved, stored), "admission-failed");
        }
        throw error;
      } finally { admitting = false; armExpiry(); }
    },
    resolve: (callbackData, query) => {
      if (!callbackData?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
        return undefined;
      }
      const currentTime = nowMs();
      cleanup(currentTime);
      armExpiry();
      const action = actions.get(callbackData);
      if (!action) {
        reportUnavailable(callbackData === TELEGRAM_BUTTON_EXPIRED_CALLBACK ? "retired-status" : callbackData === TELEGRAM_BUTTON_CAPACITY_CALLBACK ? "capacity-status" : "unknown-history", query);
        return undefined;
      }
      const first = action;
      let consumed = 1;
      const publication = action.publication;
      const assertPublisher = action.promptKind === "selection" && !action.selection ? capturePublicationAuthority(action) : undefined;
      if (query && publicationEditor && (!publication || publication.lost ||
          query.message?.chat?.id !== publication.chatId || query.message.message_id !== publication.messageId ||
          publication.threadKnown && query.message.message_thread_id !== publication.threadId)) {
        reportUnavailable(!publication || publication.lost ? "publication-unavailable" : "publication-mismatch", query, action);
        return undefined;
      }
      const dispatch = ordinaryCallbackDispatch ? prepareOrdinaryDispatch(callbackData, action, query) : undefined;
      removeAction(callbackData, action, action.selection ? undefined : action.selectedStyle ?? "primary");
      const completed = [callbackData];
      if (action.completionGroup && !action.selection) {
        retiredGroups.add(action.completionGroup);
        for (const [key, sibling] of actions) if (sibling.completionGroup === action.completionGroup) {
          removeAction(key, sibling); completed.push(key); consumed++;
        }
      }
      if (!action.selection) {
        try { assertPublisher?.(); action.assertAuthority?.(); action.binding?.assertCurrent?.(); assertPublisher?.(); }
        catch {
          reportRetirement("owner-lost", consumed, first);
          if (action.binding) retireBinding(action.binding);
          try { action.completionGroup?.retire?.(); } catch (error) { reportFailure(error); }
          armExpiry(); return undefined;
        }
        action.completionGroup?.complete?.(callbackData);
      }
      reportRetirement("consumed", consumed, first);
      armExpiry();
      // Completion/diagnostic callbacks may revoke the original publisher after the first authority barrier.
      try { assertPublisher?.(); } catch { return undefined; }
      const resolved: TelegramOutboundButtonAction = {
        text: action.text,
        ...(publication && publicationEditor ? { publicationManaged: true as const } : {}),
        ...(action.completionGroup && !action.selection ? { completedCallbacks: Object.freeze(completed) } : {}),
        prompt: action.prompt,
        ...(action.promptKind ? { promptKind: action.promptKind } : {}),
        ...(action.selection ? { selection: action.selection } : {}),
        ...(action.disabled ? { disabled: true as const } : {}),
        ...(action.binding ? { binding: action.binding } : {}),
        ...(action.selectedStyle
          ? { selectedStyle: action.selectedStyle }
          : {}),
      };
      return dispatch ? new NativeOrdinaryCallbackAction(ORDINARY_DISPATCH_KEY, resolved, dispatch) : resolved;
    },
  };
}

interface TelegramSelectionFooter {
  readonly owner: object;
  readonly rendering: "rich" | "html";
  readonly completedCallbacks: Map<string, TelegramInlineKeyboardButtonStyle | undefined>;
  revision: number;
  busy: boolean;
  lost: boolean;
  target?: string;
  markup: TelegramOutboundButtonMarkup;
  renderMarkdown?: () => string;
  readonly refresh: (() => { previous: TelegramOutboundButtonMarkup["inline_keyboard"]; next: TelegramOutboundButtonMarkup["inline_keyboard"] })[];
}

function formatTelegramChoiceHeading(question: string, step?: number, total?: number): string {
  const escaped = question.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_\[\]{}$~|]/g, "\\$&");
  return `**${escaped}**${total === undefined ? "" : `\n\n${step! + 1} / ${total}`}`;
}

function createTelegramChoiceSelection(
  questions: readonly TelegramUiChoiceQuestion[],
  batched: boolean,
  register: (action: TelegramOutboundButtonAction) => string,
  view: TelegramSelectionFooter,
): { rows: TelegramOutboundButtonMarkup["inline_keyboard"]; heading: () => string } {
  const deadline = createTelegramButtonQuestionDeadline(nowMs() + Math.min(...questions.map(question => question.timeoutMs)));
  const completionGroup = Object.freeze({ deadline, retire(reason?: TelegramButtonRetirementReason) {
    ended = true; if (reason === "deadline") expired = true; else view.lost = true; selected.clear(); answers.length = 0;
  } });
  const selected = new Set<number>(), answers: { question: string; answer: string | string[] }[] = [];
  let step = 0, ended = false, finishing = false, expired = false;
  let buttons = new Map<string, number>(), renderedRows: TelegramOutboundButtonMarkup["inline_keyboard"];
  const render = (terminal = false): TelegramOutboundButtonMarkup["inline_keyboard"] => {
    expired ||= !ended && !finishing && nowMs() >= deadline.expiresAt;
    const question = questions[step]!, cells = question.rows.flat(), count = question.select ?? 1;
    const keys = new Map<string, number>();
    const cell = (index: number) => {
      const option = index < 0 ? undefined : cells[index], marked = selected.has(index);
      const text = option ? `${marked ? "✓ " : ""}${option.label || "\u00a0"}` : `${question.cancelLabel} · ${selected.size}/${count}`;
      const style = marked ? option?.style ?? "primary" as const : undefined;
      if (terminal || expired || option?.disabled) return expired && !option?.disabled
        ? { text: `Expired: ${text}`, callback_data: TELEGRAM_BUTTON_EXPIRED_CALLBACK }
        : { text, disabled: {}, ...(style ? { style } : {}) };
      const capturedRevision = view.revision;
      const callback_data = register({ text, prompt: "", promptKind: "selection", expiresAt: deadline.expiresAt, completionGroup,
        selection: { owner: view.owner, revision: capturedRevision, requiresMessageUpdate: questions.length > 1,
          prepare: query => prepare(query, index, capturedRevision) } });
      keys.set(callback_data, index);
      return { text, callback_data, ...(style ? { style } : {}) };
    };
    let index = 0;
    const rows = question.rows.map(row => row.map(() => cell(index++)));
    rows.push([cell(-1)]);
    buttons = keys;
    return rows;
  };
  view.refresh.push(() => {
    const previous = renderedRows;
    renderedRows = render(ended || finishing || nowMs() >= deadline.expiresAt);
    return { previous, next: renderedRows };
  });
  const prepare = (query: TelegramButtonCallbackQuery, index: number, expected: number): TelegramButtonSelectionUpdate | undefined => {
    const message = query.message, keyboard = message?.reply_markup;
    expired ||= !ended && nowMs() >= deadline.expiresAt;
    if (ended || expired || view.lost || view.busy || view.revision !== expected ||
        typeof message?.chat?.id !== "number" || typeof message.message_id !== "number" || !keyboard) return undefined;
    const location = JSON.stringify([message.chat.id, message.message_thread_id ?? null, message.message_id]);
    if (view.target !== undefined && view.target !== location) return undefined;
    const occurrences = new Map<string, number>();
    for (const button of keyboard.inline_keyboard.flat()) {
      if (button.callback_data && buttons.has(button.callback_data))
        occurrences.set(button.callback_data, (occurrences.get(button.callback_data) ?? 0) + 1);
    }
    if ([...buttons.keys()].some(key => occurrences.get(key) !== 1)) return undefined;
    view.target = location;
    // One footer revision fences parallel collectors as well as stale sibling buttons.
    view.busy = true;
    view.revision++;
    const question = questions[step]!, cells = question.rows.flat(), count = question.select ?? 1;
    if (index >= 0) selected.has(index) ? selected.delete(index) : selected.add(index);
    const complete = index < 0 || selected.size === count;
    const labels = cells.filter((_cell, i) => selected.has(i)).map(cell => cell.label);
    if (complete) answers.push({ question: question.question,
      answer: index < 0 ? question.cancelLabel : count === 1 ? labels[0]! : labels });
    const advance = complete && index >= 0 && step < questions.length - 1;
    finishing = complete && !advance;
    if (advance) { step++; selected.clear(); }
    const replacements = new Map(view.refresh.map(refresh => {
      const replacement = refresh();
      return [replacement.previous[0]!, replacement] as const;
    }));
    const observed = new Map(keyboard.inline_keyboard.flat().filter(button => button.callback_data).map(button => [button.callback_data, button]));
    const rows: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
    for (let i = 0; i < view.markup.inline_keyboard.length; i++) {
      const row = view.markup.inline_keyboard[i]!, replacement = replacements.get(row);
      if (replacement) { rows.push(...replacement.next); i += replacement.previous.length - 1; continue; }
      rows.push(row.map(button => {
        if (button.callback_data && view.completedCallbacks.has(button.callback_data)) {
          const style = view.completedCallbacks.get(button.callback_data);
          return { text: button.text, disabled: {}, ...(style ? { style } : {}) };
        }
        const style = button.style ?? (button.callback_data ? observed.get(button.callback_data)?.style : undefined);
        return { ...button, ...(style ? { style } : {}) };
      }));
    }
    const replyMarkup = { inline_keyboard: rows };
    let settled = false;
    const capturedRevision = view.revision;
    const assertCurrent = () => {
      expired ||= !settled && !ended && nowMs() >= deadline.expiresAt;
      if (settled || ended || expired || view.lost || !view.busy || view.revision !== capturedRevision)
        throw new Error("Telegram selection update is unavailable.");
    };
    return Object.freeze({ replyMarkup,
      ...(advance ? { message: { markdown: view.renderMarkdown!(), rendering: view.rendering } } : {}),
      ...(finishing ? { prompt: JSON.stringify(batched ? answers : answers[0]) } : {}),
      assertCurrent,
      commit: () => { assertCurrent(); settled = true; view.markup = replyMarkup; view.busy = false; ended = finishing; },
      fail: () => { settled = true; view.busy = false; view.lost = true; ended = true; },
    });
  };
  renderedRows = render();
  return { rows: renderedRows,
    heading: () => formatTelegramChoiceHeading(questions[step]!.question, batched ? step : undefined, batched ? questions.length : undefined) };
}

const DEFAULT_TELEGRAM_BUTTON_REPLY_MARKDOWN = "☑️ **Choose an option:**";

function escapeTelegramRichButtonText(text: string): string {
  return text.replace(
    /[&<>"'`\\*_\[\]{}$~\r\n]/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

function renderTelegramRichButtonRow(
  row: TelegramOutboundButtonMarkup["inline_keyboard"][number],
): string {
  return `<tg-button-row>${row
    .map((button) => {
      const attributes = button.disabled
        ? 'type="disabled"'
        : `type="callback_data" data="${escapeTelegramRichButtonText(button.callback_data)}"`;
      return `<tg-button ${attributes}>${escapeTelegramRichButtonText(button.text)}</tg-button>`;
    })
    .join("")}</tg-button-row>`;
}

interface TelegramButtonPlannerDeps {
  /** Private omitted-deadline normalization only; not a shared-ownership or root activation grant. */
  questionHeadTail?: true;
  registerAction: (action: TelegramOutboundButtonAction) => string;
  binding?: TelegramOutboundButtonBinding;
  rendering?: "rich" | "html";
}

export function planTelegramButtonReply(markdown: string, deps: TelegramButtonPlannerDeps): TelegramButtonReplyPlan {
  const questionHeadTail = deps.questionHeadTail;
  if (questionHeadTail !== undefined && questionHeadTail !== true)
    throw new TypeError("Question head/tail policy must be true or omitted.");
  return compileTelegramButtonReply(markdown, deps, false, questionHeadTail).plan;
}

function compileTelegramButtonReply(markdown: string, deps: TelegramButtonPlannerDeps, projection: boolean, questionHeadTail?: true): { plan: TelegramButtonReplyPlan; publishable: boolean } {
  let callbackCount = 0, futureCallbacks = 0;
  const registerAction = projection ? (action: TelegramOutboundButtonAction) => { callbackCount++; return deps.registerAction(action); } : deps.registerAction;
  const keyboard: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
  const buildRows = (
    payloadRows: Record<string, unknown>[][],
    rich: boolean,
  ): TelegramOutboundButtonMarkup["inline_keyboard"] | undefined => {
    const actions = payloadRows.map((row) =>
      row.map(parseTelegramButtonAction),
    );
    if (actions.some((row) => row.some((action) => !action))) return undefined;
    if (
      rich &&
      actions.some((row) => {
        const projected = row.map((action) =>
          action!.disabled
            ? { text: action!.text || "\u00a0", disabled: {} }
            : { text: action!.text, callback_data: "x".repeat(64) },
        );
        return (
          row.length > 8 ||
          renderTelegramRichButtonRow(projected).length > 32768
        );
      })
    )
      return undefined;
    return actions.map((row) =>
      row.map((action) =>
        action!.disabled
          ? { text: action!.text || "\u00a0", disabled: {} }
          : {
              text: action!.text,
              callback_data: registerAction({
                ...action!,
                ...(deps.binding ? { binding: deps.binding } : {}),
              }),
            },
      ),
    );
  };
  const elements = ["telegram_button", "telegram_confirm", "telegram_choice"];
  const footerKeyboard: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
  const selectionFooter: TelegramSelectionFooter = { owner: Object.freeze({}), rendering: deps.rendering ?? "rich", revision: 0, busy: false, lost: false,
    markup: { inline_keyboard: keyboard }, refresh: [], completedCallbacks: new Map() };
  const fragments = new Map<string, { current: () => string; worst: string }>();
  let declarationCount = 0, selectionCellCount = 0;
  const readDeclarationComment = (content: string) => content.trimStart().replace(/^!/, "").match(/^(telegram_confirm|telegram_choice)(?=\s|\{|\[|$)([\s\S]*)$/);
  const inspectDeclaration = (element: string, payload: string) => {
    if (++declarationCount > 16) return;
    const parsed = parseTelegramUiDeclaration(element, payload.trim(), questionHeadTail);
    if (parsed.ok && parsed.declaration.kind === "confirm") selectionCellCount += 2;
    else if (parsed.ok && parsed.declaration.kind === "choice") {
      selectionCellCount += parsed.declaration.questions.reduce((count, question) => count + question.rows.reduce((size, row) => size + row.length, 0), 0);
    }
  };
  const fencePreflight = replaceTelegramHtmlComments(markdown, comment => {
    const declaration = readDeclarationComment(comment.content);
    if (declaration) { inspectDeclaration(declaration[1]!, declaration[2]!); return "\n\n"; }
    // Match the comment extraction before fence rendering, including a comment after a closing marker.
    return comment.content.replace(/^\s+/, "").replace(/^!/, "").startsWith("telegram_button") ? "" : comment.raw;
  });
  replaceTelegramButtonFences(fencePreflight, (payload, _closed, element) => {
    if (element !== "telegram_button") inspectDeclaration(element, payload);
    return "";
  }, elements);
  if (!projection) {
    // Project all callback kinds and future question widths before any real registration.
    const projected = compileTelegramButtonReply(markdown, { binding: deps.binding, rendering: deps.rendering,
      registerAction: () => "x".repeat(64) }, true, questionHeadTail);
    if (!projected.publishable) return projected;
  }
  const renderDeclaration = (element: string, payload: string): string => {
    const parsed = parseTelegramUiDeclaration(element, payload.trim(), questionHeadTail);
    if (declarationCount > 16 || selectionCellCount > 64 || !parsed.ok || (parsed.declaration.kind !== "confirm" && parsed.declaration.kind !== "choice"))
      return "\n\n**⚠️ Invalid Telegram selection declaration.**\n\n";
    const declaration = parsed.declaration;
    const questions = declaration.kind === "choice" ? declaration.questions : [declaration];
    if (declaration.kind === "choice" && (declaration.batched || (declaration.questions[0]!.select ?? 1) > 1)) {
      const widths = declaration.questions.map(question => question.rows.flat().filter(cell => !cell.disabled).length + 1);
      futureCallbacks += Math.max(...widths) - widths[0]!;
      const selection = createTelegramChoiceSelection(declaration.questions, declaration.batched, registerAction, selectionFooter);
      footerKeyboard.push(...selection.rows);
      if (!declaration.batched) return `\n\n${selection.heading()}\n\n`;
      const marker = `\uE000telegram-choice-${randomUUID()}\uE001`;
      const headings = declaration.questions.map((question, index) => formatTelegramChoiceHeading(question.question, index, declaration.questions.length));
      const score = (heading: string) => selectionFooter.rendering === "rich" ? heading.length :
        renderTelegramMessage(heading, { mode: "markdown" }).reduce((sum, chunk) => sum + chunk.text.length, 0);
      const worst = headings.reduce((longest, heading) => score(heading) > score(longest) ? heading : longest);
      fragments.set(marker, { current: selection.heading, worst });
      return `\n\n${marker}\n\n`;
    }
    const headings: string[] = [];
    for (const question of questions) {
      // Never rescan decoded question/value data as executable markup or app::method actions.
      const heading = question.question.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/[\\`*_\[\]{}$~|]/g, "\\$&");
      headings.push(`**${heading}**`);
      const expiresAt = nowMs() + question.timeoutMs;
      const keys = new Map<string, TelegramInlineKeyboardButtonStyle | undefined>();
      const completionGroup = Object.freeze({
        deadline: createTelegramButtonQuestionDeadline(expiresAt),
        retire() { for (const key of keys.keys()) selectionFooter.completedCallbacks.set(key, undefined); },
        complete(callbackData: string) {
          for (const [key, style] of keys) selectionFooter.completedCallbacks.set(key, key === callbackData ? style ?? "primary" : undefined);
        },
      });
      const rows = "rows" in question ? question.rows : [[
        { label: declaration.kind === "confirm" ? declaration.confirmLabel : "", value: "yes", disabled: false,
          style: declaration.kind === "confirm" ? declaration.confirmStyle : undefined },
        { label: question.cancelLabel, value: "no", disabled: false, style: undefined },
      ]];
      const markup = rows.map(row => row.map(cell => {
        if (cell.disabled) return { text: cell.label || "\u00a0", disabled: {} };
        const answer = { question: question.question, answer: cell.label };
        const callback_data = registerAction({ text: cell.label,
          prompt: JSON.stringify(answer), promptKind: "selection", expiresAt, completionGroup,
          ...(cell.style ? { selectedStyle: cell.style } : {}) });
        keys.set(callback_data, cell.style);
        return { text: cell.label, callback_data };
      }));
      // Footer keyboards already support post-click selection feedback in both rendering modes.
      footerKeyboard.push(...markup);
    }
    return `\n\n${headings.join("\n\n")}\n\n`;
  };
  const stripped = replaceTelegramHtmlComments(markdown, (comment) => {
    const declaration = readDeclarationComment(comment.content);
    if (declaration) return renderDeclaration(declaration[1]!, declaration[2]!);
    const command = "telegram_button";
    const normalizedContent = comment.content
      .replace(/^\s+/, "")
      .replace(/^!/, "");
    if (!normalizedContent.startsWith(command)) return comment.raw;
    const payloadRows = parseTelegramActionPayloadRows(comment, command);
    if (!payloadRows) return "";
    const rows = buildRows(payloadRows, false);
    if (rows) footerKeyboard.push(...rows);
    return "";
  });
  const withRichButtons = replaceTelegramButtonFences(
    stripped,
    (payload, closed, element) => {
      if (!closed) return "";
      if (element !== "telegram_button") return renderDeclaration(element, payload);
      const payloadRows = parseTelegramButtonPayloadRows(payload);
      if (!payloadRows) return "";
      const rich = deps.rendering !== "html";
      const rows = buildRows(payloadRows, rich);
      if (!rows) return "";
      if (!rich) {
        keyboard.push(...rows);
        return "";
      }
      return `\n${rows.map(renderTelegramRichButtonRow).join("\n\n")}\n`;
    },
    elements,
  );
  keyboard.push(...footerKeyboard);
  const materialize = (worst = false) => {
    const rendered = withRichButtons.replace(/\uE000telegram-choice-[0-9a-f-]{36}\uE001/g, marker => {
      const fragment = fragments.get(marker);
      return fragment ? worst ? fragment.worst : fragment.current() : marker;
    });
    return normalizeMarkdownAfterButtonExtraction(fragments.size ? stripTelegramCommentMarkupForDelivery(rendered) : rendered);
  };
  selectionFooter.renderMarkdown = () => materialize();
  const visibleMarkdown = materialize();
  const worstMarkdown = materialize(true);
  const wizardFits = !fragments.size || (selectionFooter.rendering === "rich" ?
    splitTelegramNativeMarkdown(worstMarkdown).length === 1 :
    renderTelegramMessage(worstMarkdown, { mode: "markdown" }).length === 1);
  if (!wizardFits) {
    selectionFooter.lost = true;
    return { publishable: false, plan: { markdown: "**⚠️ A Telegram wizard and its surrounding text must fit one message.**" } };
  }
  if (projection && callbackCount + futureCallbacks > TELEGRAM_BUTTON_ACTION_CAPACITY) {
    selectionFooter.lost = true;
    return { publishable: false, plan: { markdown: "**⚠️ Telegram controls exceed the 60-callback capacity.**" } };
  }
  return { publishable: true, plan: {
    markdown: keyboard.length > 0 && !visibleMarkdown ? DEFAULT_TELEGRAM_BUTTON_REPLY_MARKDOWN : visibleMarkdown,
    ...(keyboard.length > 0 ? { replyMarkup: { inline_keyboard: keyboard } } : {}),
  } };
}

export function createTelegramButtonReplyPlanner(
  store: Pick<TelegramButtonActionStore, "register">,
  getRenderingMode: () => "rich" | "html" = () => "rich",
  questionHeadTail?: true,
): (markdown: string) => TelegramButtonReplyPlan {
  if (questionHeadTail !== undefined && questionHeadTail !== true)
    throw new TypeError("Question head/tail policy must be true or omitted.");
  return (markdown) => planTelegramButtonReply(markdown, { registerAction: store.register, rendering: getRenderingMode(), questionHeadTail });
}

export function createTelegramButtonPromptTurn(options: {
  chatId: number;
  replyToMessageId: number;
  queueOrder: number;
  action: TelegramOutboundButtonAction;
  target?: TelegramQueueTarget;
  telegramPrefix?: string;
}): PendingTelegramTurn {
  const prompt = `${options.telegramPrefix ?? "[telegram]"} ${options.action.prompt}`;
  return {
    kind: "prompt",
    chatId: options.chatId,
    ...(options.target ? { target: options.target } : {}),
    replyToMessageId: options.replyToMessageId,
    sourceMessageIds: [options.replyToMessageId],
    queueOrder: options.queueOrder,
    queueLane: "priority",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content: [{ type: "text", text: prompt }],
    historyText: options.action.prompt,
    statusSummary: truncateTelegramQueueSummary(
      options.action.text || options.action.prompt,
    ),
  };
}

export function markTelegramButtonSelected(
  replyMarkup: TelegramOutboundButtonMarkup,
  callbackData: string,
  selectedStyle: TelegramInlineKeyboardButtonStyle = "primary",
): TelegramOutboundButtonMarkup | undefined {
  let matched = false;
  const inlineKeyboard = replyMarkup.inline_keyboard.map((row) =>
    row.map((button) => {
      if (button.disabled || button.callback_data !== callbackData)
        return { ...button };
      matched = true;
      return { ...button, style: selectedStyle };
    }),
  );
  return matched ? { inline_keyboard: inlineKeyboard } : undefined;
}

export async function handleTelegramButtonCallbackQuery<TContext = unknown>(
  query: TelegramButtonCallbackQuery,
  ctx: TContext,
  deps: TelegramButtonCallbackHandlerDeps<TContext>,
): Promise<boolean> {
  const action = deps.resolveAction(query.data, query);

  if (!action) {
    if (query.data?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
      await deps.answerCallbackQuery(query.id, query.data === TELEGRAM_BUTTON_EXPIRED_CALLBACK ? "Button action expired" :
        query.data === TELEGRAM_BUTTON_CAPACITY_CALLBACK ? "Button removed by the control limit" : "Button action unavailable");
      return true;
    }
    return false;
  }

  if (action.selection && !action.disabled) {
    if (!deps.updateSelectionKeyboard || action.selection.requiresMessageUpdate && !deps.updateSelectionMessage) {
      await deps.answerCallbackQuery(query.id, "Selection is unavailable");
      return true;
    }
    const update = action.selection.prepare(query);
    if (!update) {
      await deps.answerCallbackQuery(query.id, "Selection is no longer available");
      return true;
    }
    try {
      update.assertCurrent();
      if (update.message) await deps.updateSelectionMessage!(query, update.message.markdown, update.message.rendering, update.replyMarkup, update.assertCurrent);
      else await deps.updateSelectionKeyboard(query, update.replyMarkup, update.assertCurrent);
      update.commit();
    } catch (error) {
      update.fail();
      throw error;
    }
    const admitted = update.prompt === undefined ? undefined :
      deps.enqueueButtonPrompt(query, { text: action.text, prompt: update.prompt, promptKind: "selection" }, ctx) !== false;
    await deps.answerCallbackQuery(query.id, admitted === undefined ? "Selection updated" : admitted ? "Queued" : "Already queued");
    return true;
  }

  if (action.disabled) {
    await deps.answerCallbackQuery(query.id, "Button action unavailable");
    return true;
  }

  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id, "Button action unavailable");
    return true;
  }

  const retireKeyboard = async () => {
    if (action.publicationManaged) return;
    if (!query.data || !query.message?.reply_markup || !deps.editMessageReplyMarkup) return;
    const completed = new Set(action.completedCallbacks ?? [query.data]);
    let matched = false;
    const inline_keyboard = query.message.reply_markup.inline_keyboard.map(row => row.map(button => {
      if (!button.callback_data || !completed.has(button.callback_data)) return { ...button };
      matched = true;
      return { text: button.text, disabled: {},
        ...(button.callback_data === query.data ? { style: action.selectedStyle ?? "primary" as const } : {}) };
    }));
    if (!matched) return;
    try { await deps.editMessageReplyMarkup(chatId, messageId, { inline_keyboard }); }
    catch { /* Logical consumption precedes delivery; an uncertain edit cannot revive the action. */ }
  };

  if (deps.invokeBoundAction && action.promptKind !== "selection") {
    try {
      const viewMode = await deps.invokeBoundAction(query, action, ctx);
      if (viewMode) {
        if (viewMode === "new") await retireKeyboard();
        await deps.answerCallbackQuery(query.id, "Done");
        return true;
      }
    } catch (error) {
      await retireKeyboard();
      await deps.answerCallbackQuery(query.id, "Generative App action failed");
      throw error;
    }
  }

  let enqueued: boolean | void;
  try { enqueued = deps.enqueueButtonPrompt(query, action, ctx); }
  finally { await retireKeyboard(); }
  await deps.answerCallbackQuery(query.id, enqueued === false ? "Already queued" : "Queued");
  return true;
}
