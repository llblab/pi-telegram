/**
 * Disconnected confirmed-quit foundation: scoped admission, consent, and settlement.
 * Zones: telegram, pi agent
 * Owns one session's one-use quit decision, not transport, journals, or deletion.
 */
import { randomUUID } from "node:crypto";

export interface TelegramQuitScope {
  readonly profileKey: string;
  readonly botId: number;
  readonly ownerUserId: number;
  readonly chatId: number;
  readonly threadId: number;
  readonly instanceId: string;
  readonly processBirthId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly transportGeneration: string;
}

const SCOPE_KEYS = ["profileKey", "botId", "ownerUserId", "chatId", "threadId",
  "instanceId", "processBirthId", "sessionId", "sessionGeneration", "transportGeneration"] as const;
const QUIESCENCE_KEYS = ["agent", "piMessages", "telegramQueue", "dispatch", "compaction",
  "groupedInput", "acceptedInput", "delivery"] as const;

type Quiescence = Record<typeof QUIESCENCE_KEYS[number], "clear" | "busy" | "unknown">;
export interface TelegramQuitSnapshot {
  readonly scope: TelegramQuitScope;
  readonly automaticCleanup: boolean;
  readonly quiescence: Readonly<Quiescence>;
  readonly transport: {
    readonly role: "leader" | "follower";
    readonly cohortKey: string;
    readonly survivorCount: number;
    readonly quitSupported: boolean;
    readonly failoverReady: boolean;
  };
}

function validScope(scope: TelegramQuitScope): boolean {
  return !!scope && SCOPE_KEYS.every((key) => {
    const value = scope[key];
    return key === "botId" || key === "ownerUserId" || key === "chatId" || key === "threadId" || key === "sessionGeneration"
      ? typeof value === "number" && Number.isSafeInteger(value) && value > 0
      : typeof value === "string" && value.trim().length > 0;
  });
}
function sameScope(a: TelegramQuitScope, b: TelegramQuitScope): boolean {
  return validScope(a) && validScope(b) && SCOPE_KEYS.every((key) => a[key] === b[key]);
}

interface QuitGateLease {
  isCurrent(): boolean;
  reopen(): void;
  seal(): boolean;
}
export interface TelegramQuitAdmissionGate {
  readonly scope: TelegramQuitScope;
  enter(scope: TelegramQuitScope): (() => void) | undefined;
  tryClose(scope: TelegramQuitScope): QuitGateLease | undefined;
  invalidate(): void;
  getPhase(): "open" | "closing" | "sealed" | "retired";
}

/** Local only. A future bus adapter must enforce this at the leader as well. */
export function createTelegramQuitAdmissionGate(scope: TelegramQuitScope): TelegramQuitAdmissionGate {
  if (!validScope(scope)) throw new Error("Quit admission requires an exact Thread scope.");
  const boundScope = Object.freeze({ ...scope });
  let phase: ReturnType<TelegramQuitAdmissionGate["getPhase"]> = "open";
  let admitted = 0;
  let owner: object | undefined;
  return {
    scope: boundScope,
    enter(candidate) {
      if (phase !== "open" || !sameScope(boundScope, candidate)) return undefined;
      admitted++;
      let released = false;
      return () => { if (!released) { released = true; admitted--; } };
    },
    tryClose(candidate) {
      if (phase !== "open" || admitted !== 0 || !sameScope(boundScope, candidate)) return undefined;
      phase = "closing";
      const claim = owner = {};
      const isCurrent = () => owner === claim && (phase === "closing" || phase === "sealed");
      return {
        isCurrent,
        reopen() { if (owner === claim && phase === "closing") { phase = "open"; owner = undefined; } },
        seal() { if (owner !== claim || phase !== "closing") return false; phase = "sealed"; return true; },
      };
    },
    invalidate() { phase = "retired"; owner = undefined; },
    getPhase: () => phase,
  };
}

export interface TelegramQuitSource {
  readonly scope: TelegramQuitScope;
  readonly actorUserId: number;
  readonly messageId: number;
}
export interface TelegramQuitConfirmation extends TelegramQuitSource {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly snapshot: TelegramQuitSnapshot;
}
export interface TelegramQuitCleanupConsent {
  readonly scope: TelegramQuitScope;
  readonly operationId: string;
  readonly updateId: number;
  readonly automaticCleanup: boolean;
}
export interface TelegramQuitExecutionFence {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export type TelegramQuitFailure = "unavailable" | "denied" | "busy" | "unknown"
  | "unsupported" | "changed" | "expired" | "stale" | "cancelled"
  | "refresh-failed" | "acknowledgement-failed" | "outcome-unknown";
type Failure = { ok: false; reason: TelegramQuitFailure };
type Phase = "offered" | "confirming" | "armed" | "finalizing" | "disconnecting" |
  "left-running" | "shutdown-requested" | "outcome-unknown";
interface Attempt {
  confirmation: TelegramQuitConfirmation;
  phase: Phase;
  abort: AbortController;
  cancelled: Promise<void>;
  cancel: () => void;
  timer: ReturnType<typeof setTimeout>;
  lease?: QuitGateLease;
  updateId?: number;
}

export type TelegramQuitDeleteFirstResult =
  | { readonly status: "deleted"; readonly deletion: TelegramQuitDeletionResult }
  | { readonly status: "refused"; readonly reason: "busy" | "unknown" | "changed" | "unsupported" }
  | { readonly status: "disconnected-unconfirmed" }
  | { readonly status: "outcome-unknown" };

export interface TelegramQuitFoundationDeps {
  gate: TelegramQuitAdmissionGate;
  /** Fresh synchronous projection; missing evidence fails closed. Never a diagnostic snapshot. */
  readSnapshot(): TelegramQuitSnapshot | undefined;
  /** Refresh asynchronous policy/peer sources without retaining obsolete runtime contexts. */
  refresh(fence: TelegramQuitExecutionFence): Promise<void>;
  acknowledge(confirmation: TelegramQuitConfirmation, fence: TelegramQuitExecutionFence): Promise<boolean>;
  /** Existing immediate path. A delete-first adapter leaves this as a non-effecting compatibility port. */
  shutdown(consent: TelegramQuitCleanupConsent): void;
  /** Optional v1 path: exact leader close/delete before any native shutdown decision. */
  deleteFirst?: (consent: TelegramQuitCleanupConsent, fence: TelegramQuitExecutionFence) => Promise<TelegramQuitDeleteFirstResult>;
  /** Synchronous final local evidence check after confirmed deletion. Must never schedule a later retry. */
  afterDeletion?: (consent: TelegramQuitCleanupConsent, deletion: TelegramQuitDeletionResult) => TelegramQuitExitResult;
  onFailure?: (reason: TelegramQuitFailure) => void;
  now?: () => number;
  confirmationTtlMs?: number;
}

function evidenceFailure(snapshot: TelegramQuitSnapshot | undefined): TelegramQuitFailure | undefined {
  if (!snapshot || !validScope(snapshot.scope) || typeof snapshot.automaticCleanup !== "boolean") return "unknown";
  const values = QUIESCENCE_KEYS.map((key) => snapshot.quiescence?.[key]);
  if (values.some((value) => value !== "clear" && value !== "busy")) return "unknown";
  if (values.includes("busy")) return "busy";
  const transport = snapshot.transport;
  if (!transport || !["leader", "follower"].includes(transport.role)
    || typeof transport.cohortKey !== "string" || !transport.cohortKey.trim()
    || !Number.isSafeInteger(transport.survivorCount) || transport.survivorCount < 0) return "unknown";
  if (transport.quitSupported !== true || (transport.role === "leader" && transport.survivorCount > 0
    && transport.failoverReady !== true)) return "unsupported";
  return undefined;
}
function sameDecision(a: TelegramQuitSnapshot, b: TelegramQuitSnapshot): boolean {
  return sameScope(a.scope, b.scope) && a.automaticCleanup === b.automaticCleanup
    && a.transport.role === b.transport.role && a.transport.cohortKey === b.transport.cohortKey
    && a.transport.survivorCount === b.transport.survivorCount;
}
function freezeSnapshot(snapshot: TelegramQuitSnapshot): TelegramQuitSnapshot {
  return Object.freeze({ scope: Object.freeze({ ...snapshot.scope }), automaticCleanup: snapshot.automaticCleanup,
    quiescence: Object.freeze({ ...snapshot.quiescence }), transport: Object.freeze({ ...snapshot.transport }) });
}

const EXIT_IDENTITY_KEYS = ["profileKey", "botId", "ownerUserId", "chatId", "instanceId",
  "processBirthId", "sessionId", "sessionGeneration"] as const;

export function resolveTelegramQuitFinalAcceptedInput(
  journalEntryCount: number | undefined,
  disconnected: boolean,
): "clear" | "busy" | "unknown" {
  if (journalEntryCount !== undefined) {
    if (!Number.isSafeInteger(journalEntryCount) || journalEntryCount < 0) return "unknown";
    return journalEntryCount === 0 ? "clear" : "busy";
  }
  // Exact-result follower disconnect returns only after its receiver has stopped.
  return disconnected ? "clear" : "unknown";
}

export interface TelegramQuitExitSnapshot {
  /** Fresh Pi/session identity; the deleted Thread and disconnected transport are deliberately absent. */
  readonly identity: Pick<TelegramQuitScope, typeof EXIT_IDENTITY_KEYS[number]>;
  readonly connection: "disconnected" | "connected" | "unknown";
  readonly quiescence: Readonly<Quiescence>;
}

/** Local evidence from the existing exact-operation cleanup adapter, not a new wire/persistence format. */
export interface TelegramQuitDeletionResult {
  readonly scope: TelegramQuitScope;
  readonly operationId: string;
  readonly confirmed: boolean;
}

export type TelegramQuitFollowerDisconnectAttempt =
  | { readonly status: "refused"; readonly reason: "busy" | "unknown" | "changed" | "unsupported" }
  | { readonly status: "disconnected"; readonly outcome: {
      readonly instanceId: string;
      readonly registrationGeneration: string;
      readonly target?: { readonly chatId: number; readonly threadId: number };
      readonly deletion?: { readonly kind: "follower-disconnect-result"; readonly instanceId: string;
        readonly registrationGeneration: string; readonly target: { readonly chatId: number; readonly threadId: number };
        readonly threadDeletion: "confirmed" | "unconfirmed" };
    } };

/** Adapt the already-correlated follower result into one exact consent-bound deletion decision. */
export function createTelegramFollowerDeleteFirstPort(deps: {
  scope: TelegramQuitScope;
  registrationGeneration: string;
  disconnect(): Promise<TelegramQuitFollowerDisconnectAttempt | undefined>;
}) {
  const scope = Object.freeze({ ...deps.scope });
  const registrationGeneration = deps.registrationGeneration;
  if (!validScope(scope) || !registrationGeneration.trim()) throw new Error("Delete-first follower authority is invalid.");
  return async (consent: TelegramQuitCleanupConsent, fence: TelegramQuitExecutionFence): Promise<TelegramQuitDeleteFirstResult> => {
    if (!sameScope(consent.scope, scope) || consent.automaticCleanup !== true || !consent.operationId.trim()) {
      return { status: "refused", reason: "changed" };
    }
    fence.assertCurrent();
    const attempt = await deps.disconnect();
    fence.assertCurrent();
    if (!attempt) return { status: "refused", reason: "changed" };
    if (attempt.status === "refused") return attempt;
    const outcome = attempt.outcome;
    if (outcome.instanceId !== scope.instanceId || outcome.registrationGeneration !== registrationGeneration ||
        outcome.target?.chatId !== scope.chatId || outcome.target.threadId !== scope.threadId) {
      return { status: "outcome-unknown" };
    }
    const deletion = outcome.deletion;
    if (!deletion || deletion.kind !== "follower-disconnect-result" || deletion.threadDeletion !== "confirmed" ||
        deletion.instanceId !== scope.instanceId || deletion.registrationGeneration !== registrationGeneration ||
        deletion.target.chatId !== scope.chatId || deletion.target.threadId !== scope.threadId) {
      return { status: "disconnected-unconfirmed" };
    }
    return { status: "deleted", deletion: Object.freeze({ scope, operationId: consent.operationId, confirmed: true }) };
  };
}

export type TelegramQuitExitResult =
  | { readonly status: "shutdown-requested" | "shutdown-outcome-unknown" }
  | { readonly status: "left-running"; readonly reason:
      "cleanup-unconfirmed" | "consent-unavailable" | "session-changed" | "connected" | "busy" | "unknown" };

/** One synchronous exit decision AFTER separately authorized deletion/disconnection.
 * Does not issue cleanup, establish remote admission/settlement, or schedule a later quit.
 * The same consent owner must survive cleanup; transport removal is not session replacement.
 */
export function createTelegramQuitAfterDeletion(deps: {
  consent: TelegramQuitCleanupConsent;
  getCleanupConsent(scope: TelegramQuitScope): TelegramQuitCleanupConsent | undefined;
  readExitSnapshot(): TelegramQuitExitSnapshot | undefined;
  /** Invoke only the public shutdown API of the captured Pi session. */
  shutdown(): void;
  onShutdownError?: (error: unknown) => void;
}) {
  const consent = deps.consent;
  if (!validScope(consent.scope) || consent.automaticCleanup !== true ||
      typeof consent.operationId !== "string" || !consent.operationId.trim() ||
      !Number.isSafeInteger(consent.updateId) || consent.updateId < 0) {
    throw new Error("Post-deletion exit requires exact delete-only consent.");
  }
  const scope = Object.freeze({ ...consent.scope });
  const operationId = consent.operationId, updateId = consent.updateId;
  let result: TelegramQuitExitResult | undefined;
  let checking = false;
  const stay = (reason: Extract<TelegramQuitExitResult, { status: "left-running" }>["reason"]): TelegramQuitExitResult =>
    result = Object.freeze({ status: "left-running", reason });
  return {
    finish(deletion: TelegramQuitDeletionResult | undefined): TelegramQuitExitResult {
      if (result) return result;
      if (checking) throw new Error("Post-deletion exit check is already in progress.");
      checking = true;
      try {
        if (deletion?.confirmed !== true || deletion.operationId !== operationId || !sameScope(deletion.scope, scope)) {
          return stay("cleanup-unconfirmed");
        }
        const hasConsent = () => {
          const current = deps.getCleanupConsent(scope);
          return !!current && sameScope(current.scope, scope) && current.operationId === operationId &&
            current.updateId === updateId && current.automaticCleanup === true;
        };
        if (!hasConsent()) return stay("consent-unavailable");
        const snapshot = deps.readExitSnapshot();
        if (!snapshot?.identity) return stay("unknown");
        if (!EXIT_IDENTITY_KEYS.every((key) => snapshot.identity[key] === scope[key])) return stay("session-changed");
        if (snapshot.connection === "connected") return stay("connected");
        if (snapshot.connection !== "disconnected") return stay("unknown");
        const values = QUIESCENCE_KEYS.map((key) => snapshot.quiescence?.[key]);
        if (values.some((value) => value !== "clear" && value !== "busy")) return stay("unknown");
        if (values.includes("busy")) return stay("busy");
        if (!hasConsent()) return stay("consent-unavailable");
        // No await, timer or retry between the final evidence check and native shutdown.
        result = Object.freeze({ status: "shutdown-requested" });
        try { deps.shutdown(); }
        catch (error) {
          try { deps.onShutdownError?.(error); } catch { /* Diagnostics cannot change authority. */ }
          result = Object.freeze({ status: "shutdown-outcome-unknown" });
        }
        return result;
      } catch {
        return stay("unknown");
      } finally {
        checking = false;
      }
    },
  };
}

/** No caller in extension.ts: this prepares Q1 without exposing a shutdown command. */
export function createTelegramQuitFoundation(deps: TelegramQuitFoundationDeps) {
  const now = deps.now ?? Date.now;
  const ttl = deps.confirmationTtlMs ?? 60_000;
  if (!!deps.deleteFirst !== !!deps.afterDeletion) throw new Error("Delete-first quit requires both cleanup and exit ports.");
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 60_000) throw new Error("Invalid quit confirmation lifetime.");
  let attempt: Attempt | undefined;
  let consent: TelegramQuitCleanupConsent | undefined;
  let committed = false;
  let effectUncertain = false;
  let exitResult: TelegramQuitExitResult | undefined;
  let disposed = false;
  const readCleanupConsent = (scope: TelegramQuitScope) =>
    !disposed && deps.gate.getPhase() === "sealed" && consent && sameScope(scope, consent.scope) ? consent : undefined;
  const report = (reason: TelegramQuitFailure) => { try { deps.onFailure?.(reason); } catch { /* Diagnostics cannot change authority. */ } };
  const read = () => { try { return deps.readSnapshot(); } catch { return undefined; } };
  const fail = (reason: TelegramQuitFailure, current?: Attempt): Failure => {
    if (current && attempt === current) {
      clearTimeout(current.timer);
      current.abort.abort();
      current.cancel();
      current.lease?.reopen();
      attempt = undefined;
      report(reason);
    }
    return { ok: false, reason };
  };
  const currentFailure = (current: Attempt): TelegramQuitFailure | undefined => {
    if (disposed || attempt !== current || current.abort.signal.aborted) return "stale";
    if (now() >= current.confirmation.expiresAtMs) return "expired";
    if (current.lease && !current.lease.isCurrent()) return "stale";
    const snapshot = read();
    return evidenceFailure(snapshot) ?? (snapshot && sameDecision(current.confirmation.snapshot, snapshot) ? undefined : "changed");
  };
  const matches = (source: TelegramQuitSource & { token: string }, current: Attempt) =>
    source.token === current.confirmation.token && source.actorUserId === current.confirmation.actorUserId
    && source.messageId === current.confirmation.messageId && sameScope(source.scope, current.confirmation.scope);

  async function runPort<T>(current: Attempt, port: (fence: TelegramQuitExecutionFence) => Promise<T>) {
    const fence: TelegramQuitExecutionFence = {
      signal: current.abort.signal,
      assertCurrent() {
        if (currentFailure(current)) throw new Error("Quit operation is no longer current.");
      },
    };
    const work = Promise.resolve().then(() => { fence.assertCurrent(); return port(fence); })
      .then((value) => ({ kind: "done" as const, value }), () => ({ kind: "failed" as const }));
    return Promise.race([work, current.cancelled.then(() => ({ kind: "cancelled" as const }))]);
  }

  async function finalize(current: Attempt): Promise<void> {
    const problem = currentFailure(current);
    if (problem) { fail(problem, current); return; }
    const refreshed = await runPort(current, deps.refresh);
    const changed = currentFailure(current);
    if (changed) { fail(changed, current); return; }
    if (refreshed.kind !== "done" || current.updateId === undefined) { fail("refresh-failed", current); return; }
    const candidate = Object.freeze({ scope: current.confirmation.scope, operationId: current.confirmation.token,
      updateId: current.updateId, automaticCleanup: current.confirmation.snapshot.automaticCleanup });
    if (deps.deleteFirst && deps.afterDeletion) {
      if (candidate.automaticCleanup !== true) { fail("unsupported", current); return; }
      clearTimeout(current.timer);
      current.phase = "disconnecting";
      const deleteFence: TelegramQuitExecutionFence = { signal: current.abort.signal,
        assertCurrent() {
          if (disposed || attempt !== current || current.abort.signal.aborted || !current.lease?.isCurrent()) {
            throw new Error("Quit delete-first authority is unavailable.");
          }
        } };
      let cleanup: { kind: "done"; value: TelegramQuitDeleteFirstResult } | { kind: "failed" | "cancelled" };
      try {
        deleteFence.assertCurrent();
        const work = Promise.resolve(deps.deleteFirst(candidate, deleteFence))
          .then((value) => ({ kind: "done" as const, value }), () => ({ kind: "failed" as const }));
        cleanup = await Promise.race([work, current.cancelled.then(() => ({ kind: "cancelled" as const }))]);
      } catch { cleanup = { kind: "failed" }; }
      if (disposed || attempt !== current || current.abort.signal.aborted || !current.lease?.isCurrent()) return;
      if (cleanup.kind !== "done") {
        current.lease.seal(); effectUncertain = true;
        current.phase = "outcome-unknown"; report("outcome-unknown"); return;
      }
      const outcome = cleanup.value;
      if (!outcome || typeof outcome !== "object") {
        current.lease.seal(); effectUncertain = true;
        current.phase = "outcome-unknown"; report("outcome-unknown"); return;
      }
      if (outcome.status === "refused") {
        if (["busy", "unknown", "changed", "unsupported"].includes(outcome.reason)) {
          fail(outcome.reason, current); return;
        }
        current.lease.seal(); effectUncertain = true;
        current.phase = "outcome-unknown"; report("outcome-unknown"); return;
      }
      const deletion = outcome.status === "deleted" ? outcome.deletion : undefined;
      if (!deletion || deletion.confirmed !== true || deletion.operationId !== candidate.operationId ||
          !sameScope(deletion.scope, candidate.scope)) {
        current.lease.seal(); effectUncertain = true;
        current.phase = "outcome-unknown"; report("outcome-unknown"); return;
      }
      if (!current.lease.seal()) {
        effectUncertain = true; current.phase = "outcome-unknown"; report("outcome-unknown"); return;
      }
      consent = candidate;
      committed = true;
      try { exitResult = deps.afterDeletion(candidate, deletion); }
      catch { exitResult = { status: "left-running", reason: "unknown" }; }
      current.phase = exitResult.status === "shutdown-requested" ? "shutdown-requested"
        : exitResult.status === "shutdown-outcome-unknown" ? "outcome-unknown" : "left-running";
      if (current.phase === "outcome-unknown") report("outcome-unknown");
      return;
    }
    if (!current.lease?.seal()) { fail("stale", current); return; }
    consent = candidate;
    committed = true;
    current.phase = "shutdown-requested";
    clearTimeout(current.timer);
    // Existing decision point. No await between the final check, consent, and shutdown.
    try { deps.shutdown(consent); }
    catch { current.phase = "outcome-unknown"; report("outcome-unknown"); }
  }

  return {
    prepare(source: TelegramQuitSource): { ok: true; confirmation: TelegramQuitConfirmation } | Failure {
      if (disposed || attempt || deps.gate.getPhase() !== "open") return { ok: false, reason: "unavailable" };
      if (!sameScope(source.scope, deps.gate.scope) || source.actorUserId !== source.scope.ownerUserId
        || !Number.isSafeInteger(source.messageId) || source.messageId <= 0) return { ok: false, reason: "denied" };
      const snapshot = read();
      const problem = evidenceFailure(snapshot);
      if (problem || !snapshot) return { ok: false, reason: problem ?? "unknown" };
      if (!sameScope(source.scope, snapshot.scope)) return { ok: false, reason: "changed" };
      const frozen = freezeSnapshot(snapshot);
      const confirmation = Object.freeze({ scope: frozen.scope, actorUserId: source.actorUserId,
        messageId: source.messageId, token: randomUUID(), expiresAtMs: now() + ttl, snapshot: frozen });
      let cancel!: () => void;
      const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
      const next: Attempt = { confirmation, phase: "offered", abort: new AbortController(), cancelled, cancel,
        timer: setTimeout(() => { fail("expired", next); }, ttl) };
      next.timer.unref();
      attempt = next;
      return { ok: true, confirmation };
    },
    async confirm(source: TelegramQuitSource & { token: string; updateId: number }): Promise<{ ok: true } | Failure> {
      const current = attempt;
      if (!current || current.phase !== "offered" || !matches(source, current)) return { ok: false, reason: "denied" };
      if (!Number.isSafeInteger(source.updateId) || source.updateId < 0) return { ok: false, reason: "denied" };
      const problem = currentFailure(current);
      if (problem) return fail(problem, current);
      current.lease = deps.gate.tryClose(current.confirmation.scope);
      if (!current.lease) return fail("busy", current);
      current.phase = "confirming";
      current.updateId = source.updateId;
      const refreshed = await runPort(current, deps.refresh);
      const changed = currentFailure(current);
      if (changed) return fail(changed, current);
      if (refreshed.kind !== "done") return fail("refresh-failed", current);
      const acknowledged = await runPort(current, (fence) => deps.acknowledge(current.confirmation, fence));
      const afterAck = currentFailure(current);
      if (afterAck) return fail(afterAck, current);
      if (acknowledged.kind !== "done" || acknowledged.value !== true) return fail("acknowledgement-failed", current);
      current.phase = "armed";
      return { ok: true };
    },
    /** Only the journal owner's exact post-completion hook may call this. Never await it in the worker. */
    onUpdateCompleted(updateId: number, scope: TelegramQuitScope): void {
      const current = attempt;
      if (!current || current.phase !== "armed" || updateId !== current.updateId
        || !sameScope(scope, current.confirmation.scope)) return;
      current.phase = "finalizing";
      queueMicrotask(() => { void finalize(current); });
    },
    cancel(source: TelegramQuitSource & { token: string }): boolean {
      const current = attempt;
      if (!current || !matches(source, current) || ["disconnecting", "left-running", "shutdown-requested", "outcome-unknown"].includes(current.phase)) return false;
      fail("cancelled", current);
      return true;
    },
    getCleanupConsent: readCleanupConsent,
    /** Bind this same resolver into local deletion and preservation before teardown.
     * Normal terminal quit retains its existing resolver. Lost committed consent is
     * unavailable, never permission to fall back to a more destructive live setting.
     */
    resolveAutomaticThreadCleanupEnabled(
      scope: TelegramQuitScope,
      resolveTerminalPolicy: () => boolean | Promise<boolean>,
    ): boolean | Promise<boolean> {
      const readCommittedPolicy = (): boolean | undefined => {
        if (disposed || deps.gate.getPhase() === "retired" || !sameScope(scope, deps.gate.scope)) {
          throw new Error("Quit cleanup authority is unavailable.");
        }
        if (effectUncertain) throw new Error("Quit cleanup outcome is uncertain.");
        if (!committed) return undefined;
        const captured = readCleanupConsent(scope);
        if (!captured) throw new Error("Quit cleanup authority is unavailable.");
        return captured.automaticCleanup;
      };
      const captured = readCommittedPolicy();
      if (captured !== undefined) return captured;
      const policy = resolveTerminalPolicy();
      return typeof policy === "boolean" ? readCommittedPolicy() ?? policy
        : policy.then((value) => readCommittedPolicy() ?? value);
    },
    getPhase(): Phase | "idle" | "disposed" { return disposed ? "disposed" : attempt?.phase ?? "idle"; },
    getExitResult(): TelegramQuitExitResult | undefined { return exitResult; },
    dispose(): void {
      disposed = true;
      if (attempt?.phase === "disconnecting") {
        clearTimeout(attempt.timer); attempt.abort.abort(); attempt.cancel(); attempt = undefined;
      } else if (attempt) fail("stale", attempt);
      consent = undefined;
      deps.gate.invalidate();
    },
  };
}

export interface TelegramQuitCommandMessage {
  readonly chatId: number;
  readonly threadId: number;
  readonly actorUserId: number;
}

export interface TelegramQuitCommandCallbackQuery {
  readonly id: string;
  readonly data?: string;
  readonly from?: { readonly id?: number };
  readonly message?: {
    readonly chat?: { readonly id?: number };
    readonly message_id?: number;
    readonly message_thread_id?: number;
  };
}

export interface TelegramQuitCommandReplyMarkup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly callback_data: string }>>;
}

export interface TelegramQuitCommandControllerDeps {
  readonly foundation: Omit<TelegramQuitFoundationDeps, "acknowledge" | "onFailure"> & {
    readonly onFailure?: (reason: TelegramQuitFailure) => void;
  };
  sendInteractiveMessage(
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramQuitCommandReplyMarkup,
    options: { target: { chatId: number; threadId: number } },
  ): Promise<number | undefined>;
  editInteractiveMessage(
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramQuitCommandReplyMarkup,
  ): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

const EMPTY_QUIT_MARKUP: TelegramQuitCommandReplyMarkup = Object.freeze({ inline_keyboard: [] });
const QUIT_CONFIRMATION_HTML = [
  "<b>🗑 Quit this Pi?</b>",
  "",
  "This permanently deletes this Thread and its messages.",
  "Pi exits only if it is still idle after deletion; otherwise it remains running with Telegram disconnected.",
  "",
  "Confirmation expires in 60 seconds.",
].join("\n");

function quitFailureHtml(reason: TelegramQuitFailure): string {
  const detail: Record<TelegramQuitFailure, string> = {
    unavailable: "Another quit attempt is already active.",
    denied: "This confirmation is not valid for the current Thread.",
    busy: "Pi is no longer idle. Nothing was deleted.",
    unknown: "Idle state could not be proven. Nothing was deleted.",
    unsupported: "This Pi cannot safely quit in its current transport role.",
    changed: "The Pi, session, or Thread changed. Nothing was deleted.",
    expired: "The confirmation expired. Nothing was deleted.",
    stale: "The confirmation is stale. Nothing was deleted.",
    cancelled: "Quit cancelled. Nothing was deleted.",
    "refresh-failed": "Current state could not be refreshed. Nothing was deleted.",
    "acknowledgement-failed": "Confirmation could not be safely settled. Nothing was deleted.",
    "outcome-unknown": "Quit outcome is uncertain. No further shutdown will be attempted.",
  };
  return `<b>${reason === "cancelled" ? "❌" : "🚫"} Quit not completed.</b>\n\n${detail[reason]}`;
}

/** Private UI/composition adapter. It does not register `/quit` or a callback route. */
export function createTelegramQuitCommandController(deps: TelegramQuitCommandControllerDeps) {
  const scope = deps.foundation.gate.scope;
  let active: TelegramQuitConfirmation | undefined;
  let disposed = false;
  const retireMessage = async (messageId: number): Promise<void> => {
    try {
      await deps.editInteractiveMessage(scope.chatId, messageId,
        "<b>🚫 Quit confirmation expired.</b>\n\nNo cleanup will be started from this confirmation.",
        "html", EMPTY_QUIT_MARKUP);
    } catch { /* Revoked local authority does not depend on UI cleanup. */ }
  };
  const editActive = async (text: string, markup = EMPTY_QUIT_MARKUP): Promise<boolean> => {
    const current = active;
    if (!current || disposed) return false;
    try {
      await deps.editInteractiveMessage(scope.chatId, current.messageId, text, "html", markup);
      if (disposed || active !== current) {
        await retireMessage(current.messageId);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const reportFailure = (reason: TelegramQuitFailure): void => {
    try { deps.foundation.onFailure?.(reason); } catch { /* Diagnostics cannot change authority. */ }
    const failed = active;
    void editActive(quitFailureHtml(reason)).finally(() => {
      if (reason !== "outcome-unknown" && active === failed) active = undefined;
    });
  };
  const foundation = createTelegramQuitFoundation({
    ...deps.foundation,
    acknowledge: async (confirmation, fence) => {
      fence.assertCurrent();
      if (active !== confirmation) return false;
      const edited = await editActive(
        "<b>🗑 Quit confirmed.</b>\n\nFinishing this update before deleting the Thread.",
      );
      fence.assertCurrent();
      return edited;
    },
    onFailure: reportFailure,
  });
  const exactCallback = (query: TelegramQuitCommandCallbackQuery, confirmation: TelegramQuitConfirmation): boolean =>
    query.from?.id === confirmation.actorUserId && query.message?.chat?.id === scope.chatId &&
    query.message.message_thread_id === scope.threadId && query.message.message_id === confirmation.messageId;
  const answer = async (id: string, text?: string): Promise<void> => {
    try { await deps.answerCallbackQuery(id, text); } catch { /* Callback acknowledgement has no authority. */ }
  };
  return {
    foundation,
    async open(message: TelegramQuitCommandMessage): Promise<{ ok: true } | Failure> {
      if (disposed || message.chatId !== scope.chatId || message.threadId !== scope.threadId ||
          message.actorUserId !== scope.ownerUserId) return { ok: false, reason: "denied" };
      let messageId: number | undefined;
      try {
        messageId = await deps.sendInteractiveMessage(scope.chatId, QUIT_CONFIRMATION_HTML, "html", EMPTY_QUIT_MARKUP,
          { target: { chatId: scope.chatId, threadId: scope.threadId } });
      } catch { return { ok: false, reason: "unavailable" }; }
      if (!Number.isSafeInteger(messageId) || (messageId ?? 0) <= 0) {
        return { ok: false, reason: "unavailable" };
      }
      if (disposed) {
        await retireMessage(messageId!);
        return { ok: false, reason: "unavailable" };
      }
      const prepared = foundation.prepare({ scope, actorUserId: message.actorUserId, messageId: messageId! });
      if (!prepared.ok) {
        try { await deps.editInteractiveMessage(scope.chatId, messageId!, quitFailureHtml(prepared.reason), "html", EMPTY_QUIT_MARKUP); }
        catch { /* A failed refusal notice cannot grant authority. */ }
        return prepared;
      }
      if (disposed) return { ok: false, reason: "unavailable" };
      const offered = prepared.confirmation;
      active = offered;
      const markup: TelegramQuitCommandReplyMarkup = { inline_keyboard: [[
        { text: "🗑 Yes, delete & quit", callback_data: `quit:confirm:${offered.token}` },
        { text: "❌ No", callback_data: `quit:cancel:${offered.token}` },
      ]] };
      if (!await editActive(QUIT_CONFIRMATION_HTML, markup)) {
        foundation.cancel({ ...offered, token: offered.token });
        if (active === offered) active = undefined;
        return { ok: false, reason: "acknowledgement-failed" };
      }
      return { ok: true };
    },
    async handleCallback(query: TelegramQuitCommandCallbackQuery, updateId: number): Promise<boolean> {
      if (!query.data?.startsWith("quit:")) return false;
      const current = active;
      if (disposed || !current || !exactCallback(query, current)) {
        await answer(query.id, "⌛ Quit confirmation expired.");
        return true;
      }
      const confirmData = `quit:confirm:${current.token}`;
      const cancelData = `quit:cancel:${current.token}`;
      if (query.data === cancelData) {
        const cancelled = foundation.cancel({ ...current, token: current.token });
        await answer(query.id, cancelled ? "Quit cancelled." : "⌛ Quit confirmation expired.");
        return true;
      }
      if (query.data !== confirmData || !Number.isSafeInteger(updateId) || updateId < 0) {
        await answer(query.id, "⌛ Quit confirmation expired.");
        return true;
      }
      const result = await foundation.confirm({ ...current, token: current.token, updateId });
      await answer(query.id, result.ok ? "Quit confirmed." : "Quit not started.");
      return true;
    },
    onUpdateCompleted(updateId: number): void { foundation.onUpdateCompleted(updateId, scope); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const retired = active;
      active = undefined;
      foundation.dispose();
      if (retired) void retireMessage(retired.messageId);
    },
  };
}

/**
 * Defers `/quit` UI publication until its command update is durably complete, then forwards
 * every later durable completion to the confirmation controller. Memory-only scheduling is
 * intentionally safe to lose: replay can request again, while no cleanup authority exists yet.
 */
export function createTelegramQuitLifecycleController(deps: {
  controller: ReturnType<typeof createTelegramQuitCommandController>;
  onOpenResult?: (result: { ok: true } | Failure) => void;
  recordError?: (error: unknown) => void;
}) {
  let pending: { updateId: number; message: TelegramQuitCommandMessage } | undefined;
  let opening = false;
  let disposed = false;
  return {
    requestOpen(message: TelegramQuitCommandMessage, updateId: number): boolean {
      if (disposed || pending || opening || !Number.isSafeInteger(updateId) || updateId < 0) return false;
      pending = { updateId, message: Object.freeze({ ...message }) };
      return true;
    },
    onUpdateCompleted(updateId: number): void {
      if (disposed) return;
      deps.controller.onUpdateCompleted(updateId);
      const requested = pending;
      if (!requested || requested.updateId !== updateId) return;
      pending = undefined;
      opening = true;
      queueMicrotask(() => {
        if (disposed) { opening = false; return; }
        void deps.controller.open(requested.message).then(
          (result) => { if (!disposed) deps.onOpenResult?.(result); },
          (error) => { if (!disposed) deps.recordError?.(error); },
        ).finally(() => { opening = false; });
      });
    },
    hasPendingOpen(): boolean { return !!pending || opening; },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending = undefined;
      deps.controller.dispose();
    },
  };
}

export interface TelegramQuitProductionRuntime<TMessage, TQuery, TContext> {
  request(message: TMessage, ctx: TContext): Promise<void>;
  handleCallback(query: TQuery, ctx: TContext, updateId: number | undefined): Promise<boolean>;
  onUpdateCompleted(updateId: number): void;
  resolveTerminalCleanup(fallback: () => boolean | Promise<boolean>): boolean | Promise<boolean>;
  dispose(): void;
}

export function createTelegramQuitProductionBinding<TMessage, TQuery, TContext>() {
  let runtime: TelegramQuitProductionRuntime<TMessage, TQuery, TContext> | undefined;
  return {
    bind(next: TelegramQuitProductionRuntime<TMessage, TQuery, TContext>): void {
      runtime?.dispose();
      runtime = next;
    },
    request(message: TMessage, ctx: TContext): Promise<void> {
      return runtime?.request(message, ctx) ?? Promise.resolve();
    },
    handleCallback(query: TQuery, ctx: TContext, updateId: number | undefined): Promise<boolean> {
      return runtime?.handleCallback(query, ctx, updateId) ?? Promise.resolve(false);
    },
    onUpdateCompleted(updateId: number): void { runtime?.onUpdateCompleted(updateId); },
    resolveTerminalCleanup(fallback: () => boolean | Promise<boolean>): boolean | Promise<boolean> {
      return runtime?.resolveTerminalCleanup(fallback) ?? fallback();
    },
    reset(): void { runtime?.dispose(); },
    dispose(): void { runtime?.dispose(); runtime = undefined; },
  };
}

/** Production-facing adapter; orchestration stays here while extension.ts supplies narrow owner ports. */
export function createTelegramQuitProductionRuntime<TMessage, TQuery extends TelegramQuitCommandCallbackQuery, TContext>(deps: {
  readScope(ctx: TContext): TelegramQuitScope | undefined;
  readQuiescence(ctx: TContext, target: { chatId: number; threadId: number },
    callbackUpdateId: number | undefined): TelegramQuitSnapshot["quiescence"];
  readExitSnapshot(ctx: TContext, scope: TelegramQuitScope): TelegramQuitExitSnapshot | undefined;
  readMessage(message: TMessage): TelegramQuitCommandMessage | undefined;
  getExecutionUpdateId(message: TMessage): number | undefined;
  disconnect(): Promise<TelegramQuitFollowerDisconnectAttempt | undefined>;
  shutdown(ctx: TContext): void;
  sendInteractiveMessage: TelegramQuitCommandControllerDeps["sendInteractiveMessage"];
  editInteractiveMessage: TelegramQuitCommandControllerDeps["editInteractiveMessage"];
  answerCallbackQuery: TelegramQuitCommandControllerDeps["answerCallbackQuery"];
  rejectCommand(message: TMessage, text: string): Promise<void>;
  recordError(error: unknown, phase: string): void;
}) {
  type Active = {
    scope: TelegramQuitScope;
    ctx: TContext;
    callbackUpdateId?: number;
    command: ReturnType<typeof createTelegramQuitCommandController>;
    lifecycle: ReturnType<typeof createTelegramQuitLifecycleController>;
  };
  let active: Active | undefined;
  const same = (left: TelegramQuitScope, right: TelegramQuitScope) =>
    SCOPE_KEYS.every((key) => left[key] === right[key]);
  const retire = () => { active?.lifecycle.dispose(); active = undefined; };
  const create = (scope: TelegramQuitScope, ctx: TContext): Active => {
    let runtime!: Active;
    const deleteFirst = createTelegramFollowerDeleteFirstPort({ scope,
      registrationGeneration: scope.transportGeneration, disconnect: deps.disconnect });
    const command = createTelegramQuitCommandController({
      foundation: {
        gate: createTelegramQuitAdmissionGate(scope),
        readSnapshot() {
          const current = deps.readScope(ctx);
          if (!current) return undefined;
          return { scope: current, automaticCleanup: true,
            quiescence: deps.readQuiescence(ctx, { chatId: current.chatId, threadId: current.threadId },
              runtime.callbackUpdateId),
            transport: { role: "follower", cohortKey: `follower:${current.transportGeneration}`,
              survivorCount: 1, quitSupported: true, failoverReady: true } };
        },
        async refresh(fence) { fence.assertCurrent(); },
        shutdown() { /* Delete-first composition owns native shutdown. */ },
        async deleteFirst(consent, fence) {
          try {
            const outcome = await deleteFirst(consent, fence);
            if (outcome.status !== "deleted") deps.recordError(`Delete-first result: ${outcome.status}.`, "delete-first-result");
            return outcome;
          } catch (error) {
            deps.recordError(error, "delete-first-error");
            throw error;
          }
        },
        afterDeletion(consent, deletion) {
          const result = createTelegramQuitAfterDeletion({ consent,
            getCleanupConsent: command.foundation.getCleanupConsent,
            readExitSnapshot: () => deps.readExitSnapshot(ctx, scope),
            shutdown: () => deps.shutdown(ctx),
            onShutdownError(error) { deps.recordError(error, "native-shutdown"); } }).finish(deletion);
          if (result.status === "left-running") {
            deps.recordError(`Post-deletion result: ${result.reason}.`, "post-deletion-left-running");
          }
          return result;
        },
        onFailure(reason) { deps.recordError(`Telegram quit ${reason}.`, reason); },
      },
      sendInteractiveMessage: deps.sendInteractiveMessage,
      editInteractiveMessage: deps.editInteractiveMessage,
      answerCallbackQuery: deps.answerCallbackQuery,
    });
    const lifecycle = createTelegramQuitLifecycleController({ controller: command,
      recordError(error) { deps.recordError(error, "open"); } });
    runtime = { scope, ctx, command, lifecycle };
    return runtime;
  };
  return {
    async request(message: TMessage, ctx: TContext): Promise<void> {
      const source = deps.readMessage(message);
      const scope = deps.readScope(ctx);
      const updateId = deps.getExecutionUpdateId(message);
      if (!source || !scope || updateId === undefined || source.actorUserId !== scope.ownerUserId ||
          source.chatId !== scope.chatId || source.threadId !== scope.threadId) {
        await deps.rejectCommand(message, "Quit is available only for this Pi's active follower Thread.");
        return;
      }
      if (!active || active.ctx !== ctx || !same(active.scope, scope)) {
        retire(); active = create(scope, ctx);
      }
      if (!active.lifecycle.requestOpen(source, updateId)) {
        await deps.rejectCommand(message, "A quit confirmation is already active.");
      }
    },
    async handleCallback(query: TQuery, ctx: TContext, updateId: number | undefined): Promise<boolean> {
      if (!query.data?.startsWith("quit:")) return false;
      const current = active;
      if (!current || current.ctx !== ctx) {
        await deps.answerCallbackQuery(query.id, "⌛ Quit confirmation expired.");
        return true;
      }
      current.callbackUpdateId = updateId;
      try { return await current.command.handleCallback(query, updateId ?? -1); }
      finally { current.callbackUpdateId = undefined; }
    },
    onUpdateCompleted(updateId: number): void { active?.lifecycle.onUpdateCompleted(updateId); },
    resolveTerminalCleanup(fallback: () => boolean | Promise<boolean>): boolean | Promise<boolean> {
      const current = active;
      if (!current) return fallback();
      if (current.command.foundation.getCleanupConsent(current.scope)) return false;
      return current.command.foundation.resolveAutomaticThreadCleanupEnabled(current.scope, fallback);
    },
    dispose: retire,
  };
}
