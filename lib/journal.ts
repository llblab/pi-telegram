/**
 * Telegram durable inbound update journal
 * Zones: telegram inbound, filesystem authority, crash recovery
 * Owns profile/bot-scoped raw updates, schema validation, deduplication,
 * bounded atomic publication, durable queue-receipt/failure state, and compaction.
 * It does not own polling, update execution, queue admission, or follower routing.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type BigIntStats,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  renameTelegramPathWithRetry,
  withTelegramFileTransaction,
} from "./locks.ts";
import {
  getTelegramProcessLiveness,
  type TelegramProcessLiveness,
} from "./bus.ts";
import {
  getTelegramProfilePathSuffix,
  TELEGRAM_DEFAULT_PROFILE_NAME,
} from "./paths.ts";
import {
  runWithTelegramWorkspaceAdmissions,
  type TelegramWorkspaceAdmissionLedger,
  type TelegramWorkspaceAdmissionScope,
} from "./workspace-admission.ts";

export const TELEGRAM_UPDATE_JOURNAL_VERSION = 1 as const;
export const TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION = 2 as const;
export const TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION = 3 as const;
// Receipt and binding identities survive storage-schema upgrades.
const TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION = 1 as const;
export const TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES = 10_000;
export const TELEGRAM_UPDATE_JOURNAL_MAX_BYTES = 32 * 1024 * 1024;
export const TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH = 128;
export const TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH = 256;
export const TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH = 256;
const TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES = 4 * 1024;
const TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES = 64;
export const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH = 128;
export const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MIN_LENGTH = 32;
export const TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MAX_LENGTH = 256;
export const TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH = 128;
export const TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH = 512;

export interface TelegramFollowerJournalDiscovery {
  paths: string[];
  complete: boolean;
}

function escapeTelegramJournalPathPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Read-only discovery for canonical follower journal snapshots and segment roots. */
export function discoverTelegramFollowerJournalPaths(input: {
  directory: string;
  profileName?: string;
}): TelegramFollowerJournalDiscovery {
  const suffix = escapeTelegramJournalPathPattern(
    getTelegramProfilePathSuffix(input.profileName),
  );
  const pattern = new RegExp(
    `^(follower-inbox-[a-f0-9]{16}${suffix}\\.json)(?:\\.segments)?$`,
    "u",
  );
  let entries: Dirent[];
  try {
    entries = readdirSync(input.directory, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { paths: [], complete: true }
      : { paths: [], complete: false };
  }
  const paths = new Set<string>();
  let complete = true;
  for (const entry of entries) {
    const match = pattern.exec(entry.name);
    if (!match) continue;
    const candidatePath = join(input.directory, entry.name);
    const expectsDirectory = entry.name.endsWith(".segments");
    try {
      const stat = statSync(candidatePath);
      if (expectsDirectory ? !stat.isDirectory() : !stat.isFile()) {
        complete = false;
        continue;
      }
      paths.add(join(input.directory, match[1]!));
    } catch {
      complete = false;
    }
  }
  return { paths: Array.from(paths).sort(), complete };
}
export const TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH = 256;
export const TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT = 256;
export const TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES = 4 * 1024 * 1024;

export type TelegramUpdateJournalErrorCode =
  | "capacity"
  | "conflict"
  | "identity-mismatch"
  | "invalid"
  | "io"
  | "unsupported-version"
  | "pairing-evidence"
  | "sender-denied";

export class TelegramUpdateJournalError extends Error {
  readonly code: TelegramUpdateJournalErrorCode;
  readonly path: string;

  constructor(
    code: TelegramUpdateJournalErrorCode,
    path: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "TelegramUpdateJournalError";
    this.code = code;
    this.path = path;
  }
}

export interface TelegramUpdateJournalBotIdentity {
  botId?: number;
  tokenSha256: string;
}

export interface TelegramUpdateJournalInput {
  update_id: number;
}

export type TelegramJournaledUpdate = TelegramUpdateJournalInput &
  Record<string, unknown>;

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

function getUpdateCarrierScope(
  value: unknown,
): TelegramWorkspaceAdmissionScope | undefined {
  if (!isRecord(value) || !isRecord(value.chat)) return undefined;
  const chatId = value.chat.id;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return undefined;
  const threadId = value.message_thread_id;
  if (threadId === undefined) return { kind: "chat", chatId: chatId as number };
  if (!Number.isSafeInteger(threadId) || (threadId as number) <= 0) {
    return undefined;
  }
  return {
    kind: "target",
    target: { chatId: chatId as number, threadId: threadId as number },
  };
}

function getUpdateAdmissionScope(
  update: TelegramUpdateJournalInput & Record<string, unknown>,
): TelegramWorkspaceAdmissionScope {
  const payloadKeys = Object.keys(update).filter((key) => key !== "update_id");
  if (payloadKeys.length !== 1) return { kind: "profile" };
  const payloadKey = payloadKeys[0];
  if (TELEGRAM_UPDATE_CHAT_CARRIERS.has(payloadKey)) {
    return getUpdateCarrierScope(update[payloadKey]) ?? { kind: "profile" };
  }
  if (payloadKey === "callback_query") {
    const query = update.callback_query;
    return isRecord(query)
      ? getUpdateCarrierScope(query.message) ?? { kind: "profile" }
      : { kind: "profile" };
  }
  return { kind: "profile" };
}

function getWorkspaceAdmissionScopeKey(
  scope: TelegramWorkspaceAdmissionScope,
): string {
  if (scope.kind === "profile") return "profile";
  if (scope.kind === "chat") return `chat:${scope.chatId}`;
  return `target:${scope.target.chatId}:${scope.target.threadId}`;
}

export function getTelegramUpdateJournalAdmissionScopes(
  updates: readonly (TelegramUpdateJournalInput & Record<string, unknown>)[],
): TelegramWorkspaceAdmissionScope[] {
  if (updates.length === 0) return [{ kind: "profile" }];
  const scopes = updates.map(getUpdateAdmissionScope);
  if (scopes.some((scope) => scope.kind === "profile")) {
    return [{ kind: "profile" }];
  }
  const chatIds = new Set(
    scopes
      .filter((scope): scope is { kind: "chat"; chatId: number } => scope.kind === "chat")
      .map((scope) => scope.chatId),
  );
  const unique = new Map<string, TelegramWorkspaceAdmissionScope>();
  for (const scope of scopes) {
    if (scope.kind === "target" && chatIds.has(scope.target.chatId)) continue;
    unique.set(getWorkspaceAdmissionScopeKey(scope), scope);
  }
  return Array.from(unique.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
}

export type TelegramUpdateJournalEntryState =
  | "pending"
  | "retry-wait"
  | "queued"
  | "failed";
export type TelegramUpdateJournalQueueKind = "prompt" | "control";

export interface TelegramUpdateJournalQueueProcessIdentity {
  processId: number;
  processBirthId: string;
}

export interface TelegramUpdateJournalQueueRuntimeIdentity
  extends TelegramUpdateJournalQueueProcessIdentity {
  instanceId: string;
}

export interface TelegramUpdateJournalQueueOwnerIdentity
  extends TelegramUpdateJournalQueueRuntimeIdentity {
  sessionGeneration: number;
}

export interface TelegramUpdateJournalQueueOwner
  extends TelegramUpdateJournalQueueOwnerIdentity {
  acquisitionId: string;
  acquiredAtMs: number;
  handoffId?: string;
}

export interface TelegramUpdateJournalQueueHandoff {
  handoffId: string;
  offeredAtMs: number;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
}

export type TelegramUpdateJournalInputHandoff = TelegramUpdateJournalQueueHandoff;

/** V3 evidence; decoding it grants neither live execution nor Pi queue authority. */
export interface TelegramUpdateJournalInputClaim {
  phase: "ready" | "running";
  owner: TelegramUpdateJournalQueueOwner;
  recipientBindingKey: string;
  /** Present freezes ready donor execution until exact acceptance or cancellation. */
  handoff?: TelegramUpdateJournalInputHandoff;
  /** Absent means the original update; present preserves an exact routed projection. */
  executionUpdate?: TelegramJournaledUpdate;
}

/** Immutable transition evidence, never concurrent raw-input execution authority. */
export interface TelegramUpdateJournalInputProvenance {
  owner: TelegramUpdateJournalQueueOwner;
  recipientBindingKey: string;
  executionUpdate?: TelegramJournaledUpdate;
}

export interface TelegramUpdateJournalFailure {
  attemptCount: number;
  failedAtMs: number;
  failureClass: string;
  summary: string;
}

export type TelegramUpdateJournalOperatorDispositionAction =
  | "retry"
  | "discard";

export interface TelegramUpdateJournalLegacyCustodyEvidence {
  updateId: number;
  state: "retry-wait" | "failed";
  attemptCount: number;
  failedAtMs: number;
  failureClass: string;
  summary: string;
  nextRetryAtMs?: number;
  terminalAtMs?: number;
  terminalReason?: string;
  terminalFailureId?: string;
  evidenceSha256: string;
}

export interface TelegramUpdateJournalLegacyCustodyCandidate {
  updateId: number;
  state: "retry-wait" | "failed";
  attemptCount: number;
  failureClass: string;
  evidenceSha256: string;
}

export function listTelegramUpdateJournalLegacyCustodyCandidates(
  snapshot: Pick<TelegramUpdateJournalSnapshot, "entries">,
): TelegramUpdateJournalLegacyCustodyCandidate[] {
  return snapshot.entries.flatMap(entry => {
    const evidence = createTelegramUpdateJournalLegacyCustodyEvidence(entry);
    return evidence ? [{ updateId: evidence.updateId, state: evidence.state,
      attemptCount: evidence.attemptCount, failureClass: evidence.failureClass,
      evidenceSha256: evidence.evidenceSha256 }] : [];
  }).sort((left, right) => left.updateId - right.updateId);
}

export interface TelegramUpdateJournalLegacyCustodyDispositionAuthority {
  version: 1;
  dispositionId: string;
  updateId: number;
  evidenceSha256: string;
  action: "requeue-v3" | "discard";
  operatorAuthorityId: string;
  authorizedAtMs: number;
}

export function createTelegramUpdateJournalLegacyCustodyEvidence(
  entry: TelegramUpdateJournalEntry,
): TelegramUpdateJournalLegacyCustodyEvidence | undefined {
  if ((entry.state !== "retry-wait" && entry.state !== "failed") || !entry.failure ||
      entry.inputClaim || entry.inputProvenance) return undefined;
  const base = { updateId: entry.updateId, state: entry.state,
    attemptCount: entry.failure.attemptCount, failedAtMs: entry.failure.failedAtMs,
    failureClass: entry.failure.failureClass, summary: entry.failure.summary,
    ...(entry.nextRetryAtMs === undefined ? {} : { nextRetryAtMs: entry.nextRetryAtMs }),
    ...(entry.terminalAtMs === undefined ? {} : { terminalAtMs: entry.terminalAtMs }),
    ...(entry.terminalReason === undefined ? {} : { terminalReason: entry.terminalReason }),
    ...(entry.terminalFailureId === undefined ? {} : { terminalFailureId: entry.terminalFailureId }) };
  return { ...base, evidenceSha256: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
}

export function normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(
  value: unknown,
  expected: TelegramUpdateJournalLegacyCustodyEvidence,
): TelegramUpdateJournalLegacyCustodyDispositionAuthority | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["version", "dispositionId", "updateId", "evidenceSha256", "action",
    "operatorAuthorityId", "authorizedAtMs"];
  if (Object.keys(value).some(key => !keys.includes(key)) || value.version !== 1 ||
    !isBoundedString(value.dispositionId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
    value.updateId !== expected.updateId || value.evidenceSha256 !== expected.evidenceSha256 ||
    (value.action !== "requeue-v3" && value.action !== "discard") ||
    !isBoundedString(value.operatorAuthorityId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
    !isSafeNonNegativeInteger(value.authorizedAtMs)) return undefined;
  return { version: 1, dispositionId: value.dispositionId, updateId: expected.updateId,
    evidenceSha256: expected.evidenceSha256, action: value.action,
    operatorAuthorityId: value.operatorAuthorityId, authorizedAtMs: value.authorizedAtMs };
}

export interface TelegramUpdateJournalTerminalOperatorDisposition {
  failureId: string;
  updateId: number;
  action: TelegramUpdateJournalOperatorDispositionAction;
  committedAtMs: number;
  attemptCount: number;
  failureClass: string;
  terminalAtMs: number;
  terminalReason: string;
}

export interface TelegramUpdateJournalLegacyCustodyDisposition {
  dispositionKind: "legacy-custody";
  failureId: string;
  updateId: number;
  action: "requeue-v3" | "discard";
  committedAtMs: number;
  evidenceSha256: string;
  operatorAuthorityId: string;
  authorizedAtMs: number;
}

export type TelegramUpdateJournalOperatorDisposition =
  | TelegramUpdateJournalTerminalOperatorDisposition
  | TelegramUpdateJournalLegacyCustodyDisposition;

export interface TelegramUpdateJournalEntry {
  updateId: number;
  update: TelegramJournaledUpdate;
  /** Mandatory in v2/v3; immutable veto, never sender authorization. Absent only in legacy v1. */
  preApprovalExcluded?: boolean;
  admittedAtMs: number;
  state: TelegramUpdateJournalEntryState;
  queueKind?: TelegramUpdateJournalQueueKind;
  queueReceiptId?: string;
  queueOwner?: TelegramUpdateJournalQueueOwner;
  queueHandoff?: TelegramUpdateJournalQueueHandoff;
  inputClaim?: TelegramUpdateJournalInputClaim;
  inputProvenance?: TelegramUpdateJournalInputProvenance;
  failure?: TelegramUpdateJournalFailure;
  nextRetryAtMs?: number;
  terminalAtMs?: number;
  terminalReason?: string;
  terminalFailureId?: string;
}

export interface TelegramUpdateJournalFile {
  version: typeof TELEGRAM_UPDATE_JOURNAL_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION | typeof TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION;
  revision?: number;
  acceptedThroughUpdateId?: number;
  profile: string;
  botIdentity: TelegramUpdateJournalBotIdentity;
  entries: TelegramUpdateJournalEntry[];
  operatorDispositions?: TelegramUpdateJournalOperatorDisposition[];
}

export interface TelegramUpdateJournalSnapshot
  extends TelegramUpdateJournalFile {
  exists: boolean;
  serializedBytes: number;
}

export interface TelegramUpdateJournalAppendResult {
  /** Retained batch sources without the immutable veto; not sender authorization. */
  nonExcludedUpdateIds: number[];
  addedUpdateIds: number[];
  duplicateUpdateIds: number[];
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalRemoveResult {
  removedUpdateIds: number[];
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalQueueReceipt {
  queueKind: TelegramUpdateJournalQueueKind;
  receiptId: string;
  sourceUpdateIds: readonly number[];
  owner: TelegramUpdateJournalQueueOwnerIdentity;
}

export interface TelegramUpdateJournalQueueResult {
  queuedUpdateIds: number[];
  duplicateUpdateIds: number[];
  queueOwner?: TelegramUpdateJournalQueueOwner;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalQueuedCompletion {
  queueKind: TelegramUpdateJournalQueueKind;
  receiptId: string;
  sourceUpdateIds: readonly number[];
  queueOwner: TelegramUpdateJournalQueueOwner;
}

export interface TelegramUpdateJournalQueueHandoffInput {
  queueKind: TelegramUpdateJournalQueueKind;
  receiptId: string;
  sourceUpdateIds: readonly number[];
  expectedOwner: TelegramUpdateJournalQueueOwner;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
  handoffToken: string;
}

export interface TelegramUpdateJournalQueueHandoffOfferResult {
  handoff: TelegramUpdateJournalQueueHandoff;
  previousOwner: TelegramUpdateJournalQueueOwner;
  offeredUpdateIds: number[];
  duplicate: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalQueueHandoffAcceptResult {
  handoffId: string;
  previousOwner?: TelegramUpdateJournalQueueOwner;
  queueOwner: TelegramUpdateJournalQueueOwner;
  acceptedUpdateIds: number[];
  duplicate: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalQueueHandoffCancelResult {
  handoffId: string;
  previousOwner: TelegramUpdateJournalQueueOwner;
  cancelledUpdateIds: number[];
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalQueueDiscardInput {
  queueKind: TelegramUpdateJournalQueueKind;
  receiptId: string;
  sourceUpdateIds: readonly number[];
  expectedOwner: TelegramUpdateJournalQueueOwner;
}

export interface TelegramUpdateJournalQueueDiscardResult {
  previousOwner: TelegramUpdateJournalQueueOwner;
  removedUpdateIds: number[];
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalDeadQueueOwnerRecoveryInput {
  queueKind: TelegramUpdateJournalQueueKind;
  receiptId: string;
  sourceUpdateIds: readonly number[];
  deadOwner: TelegramUpdateJournalQueueOwner;
  recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
}

export type TelegramUpdateJournalDeadQueueOwnerRecoveryResult =
  | {
      status: "owner-alive" | "owner-unverifiable";
      previousOwner: TelegramUpdateJournalQueueOwner;
      recoveredUpdateIds: [];
      entryCount: number;
      serializedBytes: number;
    }
  | {
      status: "recovered";
      previousOwner: TelegramUpdateJournalQueueOwner;
      recoveredUpdateIds: number[];
      entryCount: number;
      serializedBytes: number;
    };

export interface TelegramUpdateJournalFailureInput {
  updateId: number;
  expectedAttemptCount: number;
  failedAtMs: number;
  failureClass: string;
  summary: string;
  disposition: "retry-wait" | "failed";
  nextRetryAtMs?: number;
  terminalReason?: string;
}

export interface TelegramUpdateJournalFailureResult {
  entry: TelegramUpdateJournalEntry;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalOperatorDispositionInput {
  updateId: number;
  failureId: string;
  action: TelegramUpdateJournalOperatorDispositionAction;
}

export interface TelegramUpdateJournalLegacyCustodyDispositionResult {
  disposition: TelegramUpdateJournalLegacyCustodyDisposition;
  duplicate: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalOperatorDispositionResult {
  disposition: TelegramUpdateJournalTerminalOperatorDisposition;
  duplicate: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramUpdateJournalStore {
  read(): TelegramUpdateJournalSnapshot;
  appendBatch<TUpdate extends TelegramUpdateJournalInput>(
    updates: readonly TUpdate[],
    acceptedThroughUpdateId?: number,
  ): TelegramUpdateJournalAppendResult;
  markQueued(
    receipt: TelegramUpdateJournalQueueReceipt,
  ): TelegramUpdateJournalQueueResult;
  markExecutionFailure(
    input: TelegramUpdateJournalFailureInput,
  ): TelegramUpdateJournalFailureResult;
  applyOperatorDisposition(
    input: TelegramUpdateJournalOperatorDispositionInput,
  ): TelegramUpdateJournalOperatorDispositionResult;
  applyLegacyCustodyDisposition(
    authority: TelegramUpdateJournalLegacyCustodyDispositionAuthority,
  ): TelegramUpdateJournalLegacyCustodyDispositionResult;
  offerQueuedHandoff(
    input: TelegramUpdateJournalQueueHandoffInput,
  ): TelegramUpdateJournalQueueHandoffOfferResult;
  acceptQueuedHandoff(
    input: TelegramUpdateJournalQueueHandoffInput,
  ): TelegramUpdateJournalQueueHandoffAcceptResult;
  cancelQueuedHandoff(
    input: TelegramUpdateJournalQueueHandoffInput,
  ): TelegramUpdateJournalQueueHandoffCancelResult;
  completeQueued(
    receipts: readonly TelegramUpdateJournalQueuedCompletion[],
  ): TelegramUpdateJournalRemoveResult;
  discardQueued(
    input: TelegramUpdateJournalQueueDiscardInput,
  ): TelegramUpdateJournalQueueDiscardResult;
  recoverDeadQueueOwner(
    input: TelegramUpdateJournalDeadQueueOwnerRecoveryInput,
  ): TelegramUpdateJournalDeadQueueOwnerRecoveryResult;
  removeCompleted(
    updateIds: readonly number[],
  ): TelegramUpdateJournalRemoveResult;
}

export type TelegramUpdateJournalPublicationBoundary =
  | "before-write"
  | "after-write-before-rename";

export interface TelegramUpdateJournalRecoveryEvent {
  kind: "repaired" | "reset";
  path: string;
  revision?: number;
  quarantinePath?: string;
  reason: string;
}

export interface TelegramUpdateJournalStoreOptions {
  path: string;
  profileName?: string;
  botIdentity: TelegramUpdateJournalBotIdentity;
  maxEntries?: number;
  maxBytes?: number;
  getNowMs?: () => number;
  onRecovery?: (event: TelegramUpdateJournalRecoveryEvent) => void;
  queueRuntimeIdentity?: TelegramUpdateJournalQueueRuntimeIdentity;
  getQueueProcessLiveness?: (
    owner: TelegramUpdateJournalQueueProcessIdentity,
  ) => TelegramProcessLiveness;
  /** Optional outer writer fence. Must authorize before source serialization/journal locking and must not perform journal I/O. */
  withWriterAdmission?: <T>(operation: () => T) => T;
  /** Explicit operator authority for quarantined legacy retry/failure disposition. Production omission disables mutation. */
  authorizeLegacyCustodyDisposition?: (
    authority: TelegramUpdateJournalLegacyCustodyDispositionAuthority,
  ) => boolean;
  /** Lock-only synchronous serialization, not source authorization or schema selection. Use the same config resource as admission hooks. */
  withSourceSerialization?: <T>(operation: () => T) => T;
  /** Opt-in strict consumption. Caller binds all gates to the same config resource and excludes other writers. */
  sourceAccess?: {
    directory: string;
    limits: { maxFiles: number; maxBytes: number; maxEntries: number; maxWork: number };
  };
  /** Opt-in v2 for cursor-ordered polling admission only. Must hold config authority through synchronous publish. */
  withPairingAdmission?: <T>(publish: (preApprovalExcluded: boolean) => T) => T;
  /** Paired-only v1 gate over canonical inputs. Runs inside Workspace admission, before journal locking. */
  withPairedAdmission?: <T>(
    updates: readonly TelegramJournaledUpdate[],
    publish: () => T,
  ) => { admitted: false } | { admitted: true; value: T };
  workspaceAdmission?: Pick<
    TelegramWorkspaceAdmissionLedger,
    "acquireAdmission" | "releaseAdmission"
  >;
  onPublicationBoundary?: (
    boundary: TelegramUpdateJournalPublicationBoundary,
    publicationPath: string,
  ) => void;
}

export interface TelegramInputJournalSourceReference {
  journalBindingKey: string;
  tokenSha256: string;
  updateId: number;
}

export interface TelegramInputJournalReceipt extends TelegramInputJournalSourceReference {
  owner: TelegramUpdateJournalQueueOwner;
}

export interface TelegramInputJournalReleaseResult {
  released: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramInputJournalRecoveryInput {
  receipt: TelegramInputJournalReceipt;
  recoveryOwner: TelegramUpdateJournalQueueOwnerIdentity;
}

export interface TelegramInputJournalRecoveryResult {
  status: "owner-alive" | "owner-unverifiable" | "unclaimed" | "recovered";
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramInputJournalHandoffOfferInput {
  receipt: TelegramInputJournalReceipt;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
  handoffToken: string;
}

export interface TelegramInputJournalHandoffAcceptInput {
  source: TelegramInputJournalSourceReference;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
  handoffId: string;
}

export interface TelegramInputJournalHandoffCancelInput {
  receipt: TelegramInputJournalReceipt;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
  handoffId: string;
}

export interface TelegramInputJournalQueueInput {
  queueKind: TelegramUpdateJournalQueueKind;
  receiptId: string;
  receipts: readonly TelegramInputJournalReceipt[];
}

export interface TelegramInputJournalQueueResult {
  queued: boolean;
  queueReceipt: TelegramUpdateJournalQueuedCompletion;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramInputJournalHandoffOfferResult {
  source: TelegramInputJournalSourceReference;
  handoff: TelegramUpdateJournalInputHandoff;
  previousOwner: TelegramUpdateJournalQueueOwner;
  duplicate: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramInputJournalHandoffAcceptResult {
  handoffId: string;
  previousOwner?: TelegramUpdateJournalQueueOwner;
  receipt: TelegramInputJournalReceipt;
  duplicate: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramInputJournalHandoffCancelResult {
  handoffId: string;
  previousOwner: TelegramUpdateJournalQueueOwner;
  cancelled: boolean;
  entryCount: number;
  serializedBytes: number;
}

export interface TelegramInputJournalStore {
  read: TelegramUpdateJournalStore["read"];
  appendBatch: TelegramUpdateJournalStore["appendBatch"];
  listLegacyCustodyCandidates(): TelegramUpdateJournalLegacyCustodyCandidate[];
  applyLegacyCustodyDisposition: TelegramUpdateJournalStore["applyLegacyCustodyDisposition"];
  /** Removes vetoed input only; an absent ID inside the retained cursor is a no-op, not completion evidence. */
  removeExcluded(updateIds: readonly number[]): TelegramUpdateJournalRemoveResult;
  acquireInput(input: {
    updateId: number;
    recipientBindingKey: string;
    executionUpdate?: TelegramJournaledUpdate;
  }): { acquired: boolean; receipt: TelegramInputJournalReceipt };
  /** Returns this process's exact ready authority to the same unclaimed input. */
  releaseInput(receipt: TelegramInputJournalReceipt): TelegramInputJournalReleaseResult;
  /** Releases exact ready authority only after process-birth liveness proves its owner dead. */
  recoverReadyInput(input: TelegramInputJournalRecoveryInput): TelegramInputJournalRecoveryResult;
  /** Freezes exact ready donor authority around one persisted recipient offer. */
  offerInputHandoff(input: TelegramInputJournalHandoffOfferInput): TelegramInputJournalHandoffOfferResult;
  /** Replaces the offered donor with one exact ready recipient acquisition. */
  acceptInputHandoff(input: TelegramInputJournalHandoffAcceptInput): TelegramInputJournalHandoffAcceptResult;
  /** Unfreezes only the exact unaccepted donor offer. */
  cancelInputHandoff(input: TelegramInputJournalHandoffCancelInput): TelegramInputJournalHandoffCancelResult;
  /** Atomically replaces exact running raw acquisitions with one grouped Pi queue receipt. */
  queueInputs(input: TelegramInputJournalQueueInput): TelegramInputJournalQueueResult;
  completeQueued: TelegramUpdateJournalStore["completeQueued"];
  discardQueued: TelegramUpdateJournalStore["discardQueued"];
  recoverDeadQueueOwner: TelegramUpdateJournalStore["recoverDeadQueueOwner"];
  offerQueuedHandoff: TelegramUpdateJournalStore["offerQueuedHandoff"];
  acceptQueuedHandoff: TelegramUpdateJournalStore["acceptQueuedHandoff"];
  cancelQueuedHandoff: TelegramUpdateJournalStore["cancelQueuedHandoff"];
  /** One durable start transition, not proof that an external effect ran. Publication errors may be commit-unknown. */
  startInput(receipt: TelegramInputJournalReceipt):
    { started: false } | { started: true; update: TelegramJournaledUpdate };
  completeInput(receipt: TelegramInputJournalReceipt): TelegramUpdateJournalRemoveResult;
}

export interface TelegramInputJournalContext {
  owner: TelegramUpdateJournalQueueOwnerIdentity;
  recipientBindingKey: string;
}

export type TelegramInputJournalStoreOptions = Omit<TelegramUpdateJournalStoreOptions, "withPairedAdmission"> &
  Required<Pick<TelegramUpdateJournalStoreOptions,
    "sourceAccess" | "withSourceSerialization" | "withPairingAdmission" | "queueRuntimeIdentity">> & {
    /** Bound originating profile/token/session/recipient context, not transport role; undefined revokes acquisition/start/transfer. */
    getInputContext: () => TelegramInputJournalContext | undefined;
  };

interface ReadTelegramUpdateJournalResult {
  file: TelegramUpdateJournalFile;
  exists: boolean;
  serializedBytes: number;
  source?: JournalSourceAcquisition;
}

interface JournalSourceAcquisition {
  evidence: ReturnType<typeof inspectTelegramUpdateJournalFamily>;
  snapshotRevision: number;
  segments: { name: string; bytes: number; work: number; botId?: number }[];
}

export interface TelegramUpdateJournalSegment {
  version: TelegramUpdateJournalFile["version"];
  revision: number;
  previousRevision: number;
  acceptedThroughUpdateId?: number;
  profile: string;
  botIdentity: TelegramUpdateJournalBotIdentity;
  upsertedEntries: TelegramUpdateJournalEntry[];
  removedUpdateIds: number[];
  operatorDispositions?: TelegramUpdateJournalOperatorDisposition[];
}

export interface TelegramUpdateJournalSegmentPublicationResult {
  path: string;
  revision: number;
  serializedBytes: number;
}

function createJournalError(
  code: TelegramUpdateJournalErrorCode,
  path: string,
  detail: string,
  cause?: unknown,
): TelegramUpdateJournalError {
  return new TelegramUpdateJournalError(
    code,
    path,
    `Telegram update journal ${detail}: ${path}`,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return isNonEmptyString(value) && value.length <= maxLength;
}

function validateBotIdentity(
  value: unknown,
  path: string,
): TelegramUpdateJournalBotIdentity {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["botId", "tokenSha256"]) ||
    !isNonEmptyString(value.tokenSha256) ||
    !/^[a-f0-9]{64}$/u.test(value.tokenSha256) ||
    (value.botId !== undefined && !isSafePositiveInteger(value.botId))
  ) {
    throw createJournalError("invalid", path, "has invalid bot identity");
  }
  return {
    ...(value.botId !== undefined ? { botId: value.botId } : {}),
    tokenSha256: value.tokenSha256,
  };
}

function validateJournaledUpdate(
  value: unknown,
  path: string,
): TelegramJournaledUpdate {
  if (!isRecord(value) || !isSafeNonNegativeInteger(value.update_id)) {
    throw createJournalError(
      "invalid",
      path,
      "contains an update without a safe integer update_id",
    );
  }
  return value as TelegramJournaledUpdate;
}

function normalizeIncomingJournaledUpdate(
  value: unknown,
  path: string,
): TelegramJournaledUpdate {
  let normalized: unknown;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Update is not JSON serializable.");
    }
    normalized = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw createJournalError(
      "invalid",
      path,
      "received a non-JSON update",
      error,
    );
  }
  return validateJournaledUpdate(normalized, path);
}

function validateJournalQueueOwnerIdentity(
  value: unknown,
  path: string,
): TelegramUpdateJournalQueueOwnerIdentity {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "instanceId",
      "processId",
      "processBirthId",
      "sessionGeneration",
    ]) ||
    !isBoundedString(
      value.instanceId,
      TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH,
    ) ||
    !isSafePositiveInteger(value.processId) ||
    !isBoundedString(
      value.processBirthId,
      TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH,
    ) ||
    !isSafePositiveInteger(value.sessionGeneration)
  ) {
    throw createJournalError(
      "invalid",
      path,
      "contains invalid queue owner identity",
    );
  }
  return {
    instanceId: value.instanceId,
    processId: value.processId,
    processBirthId: value.processBirthId,
    sessionGeneration: value.sessionGeneration,
  };
}

function validateJournalQueueOwner(
  value: unknown,
  path: string,
): TelegramUpdateJournalQueueOwner {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "instanceId",
      "processId",
      "processBirthId",
      "sessionGeneration",
      "acquisitionId",
      "acquiredAtMs",
      "handoffId",
    ]) ||
    !isBoundedString(
      value.acquisitionId,
      TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH,
    ) ||
    !isSafeNonNegativeInteger(value.acquiredAtMs) ||
    (value.handoffId !== undefined &&
      !isBoundedString(
        value.handoffId,
        TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH,
      ))
  ) {
    throw createJournalError(
      "invalid",
      path,
      "contains invalid queue receipt acquisition",
    );
  }
  const identity = validateJournalQueueOwnerIdentity(
    {
      instanceId: value.instanceId,
      processId: value.processId,
      processBirthId: value.processBirthId,
      sessionGeneration: value.sessionGeneration,
    },
    path,
  );
  return {
    ...identity,
    acquisitionId: value.acquisitionId,
    acquiredAtMs: value.acquiredAtMs,
    ...(typeof value.handoffId === "string"
      ? { handoffId: value.handoffId }
      : {}),
  };
}

export function parseTelegramUpdateJournalQueueOwner(
  value: unknown,
): TelegramUpdateJournalQueueOwner | undefined {
  try {
    return validateJournalQueueOwner(value, "Telegram queue handoff acknowledgement");
  } catch {
    return undefined;
  }
}

export function isTelegramUpdateJournalQueueOwnerProcess(
  owner: TelegramUpdateJournalQueueOwner,
  identity: TelegramUpdateJournalQueueOwnerIdentity,
): boolean {
  return (
    owner.instanceId === identity.instanceId &&
    owner.processId === identity.processId &&
    owner.processBirthId === identity.processBirthId
  );
}

export function areTelegramUpdateJournalQueueOwnersEqual(
  left: TelegramUpdateJournalQueueOwner,
  right: TelegramUpdateJournalQueueOwner,
): boolean {
  return (
    isTelegramUpdateJournalQueueOwnerProcess(left, right) &&
    left.sessionGeneration === right.sessionGeneration &&
    left.acquisitionId === right.acquisitionId &&
    left.acquiredAtMs === right.acquiredAtMs &&
    left.handoffId === right.handoffId
  );
}

function cloneJournalQueueOwner(
  owner: TelegramUpdateJournalQueueOwner,
): TelegramUpdateJournalQueueOwner {
  return { ...owner };
}

function createTelegramUpdateQueueHandoffId(input: {
  handoffToken: string;
  queueKind: TelegramUpdateJournalQueueKind;
  receiptId: string;
  sourceUpdateIds: readonly number[];
  expectedOwner: TelegramUpdateJournalQueueOwner;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
}): string {
  return `handoff-${createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        token: input.handoffToken,
        queueKind: input.queueKind,
        receiptId: input.receiptId,
        sourceUpdateIds: [...input.sourceUpdateIds].sort((a, b) => a - b),
        donorAcquisitionId: input.expectedOwner.acquisitionId,
        recipientOwner: input.recipientOwner,
      }),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

function isTelegramInputHandoffId(value: unknown): value is string {
  return isBoundedString(value, TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH) &&
    /^input-handoff-[a-f0-9]{32}$/u.test(value);
}

function createTelegramInputHandoffId(input: {
  handoffToken: string;
  journalBindingKey: string;
  updateId: number;
  donorOwner: TelegramUpdateJournalQueueOwner;
  recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
  recipientBindingKey: string;
}): string {
  return `input-handoff-${createHash("sha256").update(JSON.stringify({
    version: 1,
    token: input.handoffToken,
    source: input.journalBindingKey,
    updateId: input.updateId,
    donorOwner: input.donorOwner,
    recipientOwner: input.recipientOwner,
    recipientBindingKey: input.recipientBindingKey,
  })).digest("hex").slice(0, 32)}`;
}

function validateJournalHandoff(
  value: unknown,
  path: string,
  kind: "queue" | "input",
): TelegramUpdateJournalQueueHandoff {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["handoffId", "offeredAtMs", "recipientOwner"]) ||
    !isBoundedString(
      value.handoffId,
      TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH,
    ) ||
    !isSafeNonNegativeInteger(value.offeredAtMs)
  ) {
    throw createJournalError(
      "invalid",
      path,
      `contains invalid ${kind} handoff metadata`,
    );
  }
  return {
    handoffId: value.handoffId,
    offeredAtMs: value.offeredAtMs,
    recipientOwner: validateJournalQueueOwnerIdentity(
      value.recipientOwner,
      path,
    ),
  };
}

function cloneJournalQueueHandoff(
  handoff: TelegramUpdateJournalQueueHandoff,
): TelegramUpdateJournalQueueHandoff {
  return {
    ...handoff,
    recipientOwner: { ...handoff.recipientOwner },
  };
}

function validateJournalFailure(
  value: unknown,
  path: string,
): TelegramUpdateJournalFailure {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "attemptCount",
      "failedAtMs",
      "failureClass",
      "summary",
    ]) ||
    !isSafePositiveInteger(value.attemptCount) ||
    !isSafeNonNegativeInteger(value.failedAtMs) ||
    !isBoundedString(
      value.failureClass,
      TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH,
    ) ||
    !isBoundedString(
      value.summary,
      TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH,
    )
  ) {
    throw createJournalError(
      "invalid",
      path,
      "contains invalid execution failure metadata",
    );
  }
  return {
    attemptCount: value.attemptCount,
    failedAtMs: value.failedAtMs,
    failureClass: value.failureClass,
    summary: value.summary,
  };
}

function createTelegramUpdateTerminalFailureId(input: {
  updateId: number;
  attemptCount: number;
  failedAtMs: number;
  failureClass: string;
  terminalAtMs: number;
  terminalReason: string;
}): string {
  return `failure-${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 32)}`;
}

function validateJournalOperatorDisposition(
  value: unknown,
  path: string,
): TelegramUpdateJournalOperatorDisposition {
  if (isRecord(value) && value.dispositionKind === "legacy-custody") {
    if (!hasOnlyKeys(value, ["dispositionKind", "failureId", "updateId", "action",
      "committedAtMs", "evidenceSha256", "operatorAuthorityId", "authorizedAtMs"]) ||
      !isBoundedString(value.failureId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
      !isSafeNonNegativeInteger(value.updateId) ||
      (value.action !== "requeue-v3" && value.action !== "discard") ||
      !isSafeNonNegativeInteger(value.committedAtMs) ||
      typeof value.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.evidenceSha256) ||
      !isBoundedString(value.operatorAuthorityId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
      !isSafeNonNegativeInteger(value.authorizedAtMs) || value.committedAtMs < value.authorizedAtMs)
      throw createJournalError("invalid", path,
        "contains invalid legacy custody disposition metadata");
    return { dispositionKind: "legacy-custody", failureId: value.failureId,
      updateId: value.updateId, action: value.action, committedAtMs: value.committedAtMs,
      evidenceSha256: value.evidenceSha256, operatorAuthorityId: value.operatorAuthorityId,
      authorizedAtMs: value.authorizedAtMs };
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["failureId", "updateId", "action",
    "committedAtMs", "attemptCount", "failureClass", "terminalAtMs", "terminalReason"]) ||
    !isBoundedString(value.failureId, TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH) ||
    !isSafeNonNegativeInteger(value.updateId) ||
    (value.action !== "retry" && value.action !== "discard") ||
    !isSafeNonNegativeInteger(value.committedAtMs) || !isSafePositiveInteger(value.attemptCount) ||
    !isBoundedString(value.failureClass, TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH) ||
    !isSafeNonNegativeInteger(value.terminalAtMs) || value.committedAtMs < value.terminalAtMs ||
    !isBoundedString(value.terminalReason, TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH))
    throw createJournalError("invalid", path, "contains invalid operator disposition metadata");
  return { failureId: value.failureId, updateId: value.updateId, action: value.action,
    committedAtMs: value.committedAtMs, attemptCount: value.attemptCount,
    failureClass: value.failureClass, terminalAtMs: value.terminalAtMs,
    terminalReason: value.terminalReason };
}

function journalRequiresExclusion(version: TelegramUpdateJournalFile["version"]): boolean {
  return version === TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION ||
    version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION;
}

function validateJournalInputClaim(
  value: unknown, path: string, updateId: number,
): TelegramUpdateJournalInputClaim {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["phase", "owner", "recipientBindingKey", "handoff", "executionUpdate"]) ||
      (value.phase !== "ready" && value.phase !== "running") ||
      !isBoundedString(value.recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
      !value.recipientBindingKey.trim()) {
    throw createJournalError("invalid", path, "contains invalid input claim metadata");
  }
  const owner = validateJournalQueueOwner(value.owner, path);
  const handoff = value.handoff === undefined ? undefined : validateJournalHandoff(value.handoff, path, "input");
  if ((owner.handoffId !== undefined && !isTelegramInputHandoffId(owner.handoffId)) ||
      (handoff && (!isTelegramInputHandoffId(handoff.handoffId) || value.phase !== "ready" ||
      isTelegramUpdateJournalQueueOwnerProcess(owner, handoff.recipientOwner)))) {
    throw createJournalError("invalid", path, "contains conflicting input handoff metadata");
  }
  const executionUpdate = value.executionUpdate === undefined
    ? undefined : validateJournaledUpdate(value.executionUpdate, path);
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

function validateJournalInputProvenance(
  value: unknown, path: string, updateId: number,
): TelegramUpdateJournalInputProvenance {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["owner", "recipientBindingKey", "executionUpdate"]) ||
      !isBoundedString(value.recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
      !value.recipientBindingKey.trim()) {
    throw createJournalError("invalid", path, "contains invalid input queue provenance");
  }
  const owner = validateJournalQueueOwner(value.owner, path);
  if (owner.handoffId !== undefined && !isTelegramInputHandoffId(owner.handoffId)) {
    throw createJournalError("invalid", path, "contains invalid input queue provenance");
  }
  const executionUpdate = value.executionUpdate === undefined
    ? undefined : validateJournaledUpdate(value.executionUpdate, path);
  if (executionUpdate && executionUpdate.update_id !== updateId) {
    throw createJournalError("invalid", path, "contains an input provenance/update id mismatch");
  }
  return { owner, recipientBindingKey: value.recipientBindingKey,
    ...(executionUpdate ? { executionUpdate } : {}) };
}

function validateJournalEntry(
  value: unknown,
  path: string,
  version: TelegramUpdateJournalFile["version"],
): TelegramUpdateJournalEntry {
  if (journalRequiresExclusion(version) &&
      (!isRecord(value) || typeof value.preApprovalExcluded !== "boolean" ||
        (value.preApprovalExcluded && value.state === "queued"))) {
    throw createJournalError("pairing-evidence", path, "contains missing, malformed, or queued exclusion evidence");
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "updateId",
      "update",
      "admittedAtMs",
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
      ...(version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION
        ? ["inputClaim", "inputProvenance"] : []),
    ]) ||
    !isSafeNonNegativeInteger(value.updateId) ||
    !isSafeNonNegativeInteger(value.admittedAtMs) ||
    (value.state !== "pending" &&
      value.state !== "retry-wait" &&
      value.state !== "queued" &&
      value.state !== "failed")
  ) {
    throw createJournalError("invalid", path, "contains an invalid entry");
  }
  const update = validateJournaledUpdate(value.update, path);
  if (update.update_id !== value.updateId) {
    throw createJournalError(
      "invalid",
      path,
      "contains an entry/update id mismatch",
    );
  }
  const queueKind = value.queueKind;
  const queueReceiptId = value.queueReceiptId;
  const hasQueueMetadata =
    queueKind !== undefined ||
    queueReceiptId !== undefined ||
    value.queueOwner !== undefined ||
    value.queueHandoff !== undefined;
  const hasFailureMetadata =
    value.failure !== undefined ||
    value.nextRetryAtMs !== undefined ||
    value.terminalAtMs !== undefined ||
    value.terminalReason !== undefined ||
    value.terminalFailureId !== undefined;
  if (value.state === "pending" && (hasQueueMetadata || hasFailureMetadata)) {
    throw createJournalError(
      "invalid",
      path,
      "contains metadata on a pending entry",
    );
  }
  if (
    value.state === "queued" &&
    ((queueKind !== "prompt" && queueKind !== "control") ||
      !isNonEmptyString(queueReceiptId) ||
      value.queueOwner === undefined ||
      hasFailureMetadata)
  ) {
    throw createJournalError(
      "invalid",
      path,
      "contains invalid queued entry metadata",
    );
  }
  const queueOwner =
    value.state === "queued" && value.queueOwner !== undefined
      ? validateJournalQueueOwner(value.queueOwner, path)
      : undefined;
  const queueHandoff =
    value.state === "queued" && value.queueHandoff !== undefined
      ? validateJournalHandoff(value.queueHandoff, path, "queue")
      : undefined;
  if (queueHandoff && !queueOwner) {
    throw createJournalError(
      "invalid",
      path,
      "contains a queue handoff without donor authority",
    );
  }
  if (value.preApprovalExcluded === true &&
      (value.inputClaim !== undefined || value.inputProvenance !== undefined)) {
    throw createJournalError("pairing-evidence", path, "contains claimed exclusion evidence");
  }
  const inputClaim = value.inputClaim === undefined
    ? undefined : validateJournalInputClaim(value.inputClaim, path, value.updateId);
  const inputProvenance = value.inputProvenance === undefined
    ? undefined : validateJournalInputProvenance(value.inputProvenance, path, value.updateId);
  if ((inputClaim && (value.state === "queued" ||
      (inputClaim.phase === "running" && value.state !== "pending"))) ||
      (inputProvenance && (value.state !== "queued" || inputClaim))) {
    throw createJournalError("invalid", path, "contains conflicting input claim state");
  }
  let failure: TelegramUpdateJournalFailure | undefined;
  if (value.state === "retry-wait" || value.state === "failed") {
    if (hasQueueMetadata) {
      throw createJournalError(
        "invalid",
        path,
        "contains queue metadata on a failed execution entry",
      );
    }
    failure = validateJournalFailure(value.failure, path);
  }
  if (
    value.state === "retry-wait" &&
    (!isSafeNonNegativeInteger(value.nextRetryAtMs) ||
      value.nextRetryAtMs < failure!.failedAtMs ||
      value.terminalAtMs !== undefined ||
      value.terminalReason !== undefined ||
      value.terminalFailureId !== undefined)
  ) {
    throw createJournalError(
      "invalid",
      path,
      "contains invalid retry-wait metadata",
    );
  }
  if (
    value.state === "failed" &&
    (!isSafeNonNegativeInteger(value.terminalAtMs) ||
      value.terminalAtMs < failure!.failedAtMs ||
      !isBoundedString(
        value.terminalReason,
        TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH,
      ) ||
      (value.terminalFailureId !== undefined &&
        !isBoundedString(
          value.terminalFailureId,
          TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH,
        )) ||
      value.nextRetryAtMs !== undefined)
  ) {
    throw createJournalError(
      "invalid",
      path,
      "contains invalid terminal failure metadata",
    );
  }
  return {
    updateId: value.updateId,
    update,
    ...(journalRequiresExclusion(version)
      ? { preApprovalExcluded: value.preApprovalExcluded as boolean } : {}),
    ...(inputClaim ? { inputClaim } : {}),
    ...(inputProvenance ? { inputProvenance } : {}),
    admittedAtMs: value.admittedAtMs,
    state: value.state,
    ...(queueKind === "prompt" || queueKind === "control"
      ? { queueKind }
      : {}),
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
          terminalFailureId:
            isBoundedString(
              value.terminalFailureId,
              TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH,
            )
              ? value.terminalFailureId
              : createTelegramUpdateTerminalFailureId({
                  updateId: value.updateId,
                  attemptCount: failure!.attemptCount,
                  failedAtMs: failure!.failedAtMs,
                  failureClass: failure!.failureClass,
                  terminalAtMs: value.terminalAtMs as number,
                  terminalReason: value.terminalReason as string,
                }),
        }
      : {}),
  };
}

function assertSupportedJournalVersion(
  value: unknown, path: string,
  version: TelegramUpdateJournalFile["version"] = TELEGRAM_UPDATE_JOURNAL_VERSION,
): void {
  if (isRecord(value) && Number.isSafeInteger(value.version) &&
      value.version !== version) {
    throw createJournalError("unsupported-version", path, `uses unsupported version ${String(value.version)}`);
  }
}

function parseJournalFile(
  value: unknown,
  path: string,
  version: TelegramUpdateJournalFile["version"] = TELEGRAM_UPDATE_JOURNAL_VERSION,
): TelegramUpdateJournalFile {
  assertSupportedJournalVersion(value, path, version);
  if (journalRequiresExclusion(version) &&
      (!isRecord(value) || !isSafeNonNegativeInteger(value.acceptedThroughUpdateId))) {
    throw createJournalError("pairing-evidence", path, "is missing its exclusion-mode admission cursor");
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "revision",
      "acceptedThroughUpdateId",
      "profile",
      "botIdentity",
      "entries",
      "operatorDispositions",
    ]) ||
    !Number.isSafeInteger(value.version) ||
    (value.revision !== undefined &&
      (!isSafeNonNegativeInteger(value.revision) || value.revision === 0)) ||
    (value.acceptedThroughUpdateId !== undefined &&
      !isSafeNonNegativeInteger(value.acceptedThroughUpdateId)) ||
    !isNonEmptyString(value.profile) ||
    !Array.isArray(value.entries) ||
    (value.operatorDispositions !== undefined &&
      !Array.isArray(value.operatorDispositions))
  ) {
    throw createJournalError("invalid", path, "has a malformed schema");
  }
  const entries = value.entries.map((entry) =>
    validateJournalEntry(entry, path, version),
  );
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]!.updateId <= entries[index - 1]!.updateId) {
      throw createJournalError(
        "invalid",
        path,
        "contains duplicate or unordered entry ids",
      );
    }
  }
  if (
    entries.length > 0 &&
    value.acceptedThroughUpdateId !== undefined &&
    value.acceptedThroughUpdateId < entries.at(-1)!.updateId
  ) {
    throw createJournalError(
      "invalid",
      path,
      "has an admission cursor behind its active entries",
    );
  }
  const queuedReceipts = new Map<
    string,
    {
      queueKind: TelegramUpdateJournalQueueKind;
      queueOwner?: TelegramUpdateJournalQueueOwner;
      queueHandoff?: TelegramUpdateJournalQueueHandoff;
    }
  >();
  for (const entry of entries) {
    if (
      entry.state !== "queued" ||
      !entry.queueKind ||
      !entry.queueReceiptId
    ) {
      continue;
    }
    const existing = queuedReceipts.get(entry.queueReceiptId);
    if (
      existing &&
      (existing.queueKind !== entry.queueKind ||
        (existing.queueOwner === undefined) !==
          (entry.queueOwner === undefined) ||
        (existing.queueOwner !== undefined &&
          entry.queueOwner !== undefined &&
          !areTelegramUpdateJournalQueueOwnersEqual(
            existing.queueOwner,
            entry.queueOwner,
          )) ||
        (existing.queueHandoff === undefined) !==
          (entry.queueHandoff === undefined) ||
        (existing.queueHandoff !== undefined &&
          entry.queueHandoff !== undefined &&
          !isDeepStrictEqual(existing.queueHandoff, entry.queueHandoff)))
    ) {
      throw createJournalError(
        "invalid",
        path,
        `contains inconsistent queued receipt ${entry.queueReceiptId}`,
      );
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
  const operatorDispositions = (
    (value.operatorDispositions as unknown[] | undefined) ?? []
  ).map((disposition) =>
    validateJournalOperatorDisposition(disposition, path),
  );
  const dispositionFailureIds = new Set<string>();
  const entriesByUpdateId = new Map(
    entries.map((entry) => [entry.updateId, entry]),
  );
  for (const disposition of operatorDispositions) {
    if (dispositionFailureIds.has(disposition.failureId)) {
      throw createJournalError(
        "invalid",
        path,
        "contains duplicate operator disposition failure ids",
      );
    }
    const currentEntry = entriesByUpdateId.get(disposition.updateId);
    if (
      currentEntry?.terminalFailureId === disposition.failureId ||
      (disposition.action === "discard" && currentEntry !== undefined)
    ) {
      throw createJournalError(
        "invalid",
        path,
        "contains operator-disposed active authority",
      );
    }
    dispositionFailureIds.add(disposition.failureId);
  }
  return {
    version,
    ...(value.revision !== undefined
      ? { revision: value.revision as number }
      : {}),
    ...(value.acceptedThroughUpdateId !== undefined
      ? { acceptedThroughUpdateId: value.acceptedThroughUpdateId as number }
      : {}),
    profile: value.profile,
    botIdentity: validateBotIdentity(value.botIdentity, path),
    entries,
    ...(operatorDispositions.length > 0 ? { operatorDispositions } : {}),
  };
}

function parseJournalSegment(
  value: unknown,
  path: string,
  version: TelegramUpdateJournalFile["version"] = TELEGRAM_UPDATE_JOURNAL_VERSION,
): TelegramUpdateJournalSegment {
  assertSupportedJournalVersion(value, path, version);
  if (journalRequiresExclusion(version) &&
      (!isRecord(value) || !isSafeNonNegativeInteger(value.acceptedThroughUpdateId))) {
    throw createJournalError("pairing-evidence", path, "is missing its exclusion-mode admission cursor");
  }
  if (
    !isRecord(value) ||
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
      !Array.isArray(value.operatorDispositions))
  ) {
    throw createJournalError("invalid", path, "has a malformed segment schema");
  }
  const upsertedEntries = value.upsertedEntries.map((entry) =>
    validateJournalEntry(entry, path, version),
  );
  const upsertedIds = new Set<number>();
  for (const entry of upsertedEntries) {
    if (upsertedIds.has(entry.updateId)) {
      throw createJournalError("invalid", path, "has duplicate segment upserts");
    }
    upsertedIds.add(entry.updateId);
  }
  if (
    upsertedEntries.length > 0 &&
    value.acceptedThroughUpdateId !== undefined &&
    value.acceptedThroughUpdateId <
      upsertedEntries.reduce((maximum, entry) => Math.max(maximum, entry.updateId), 0)
  ) {
    throw createJournalError(
      "invalid",
      path,
      "has an admission cursor behind its segment upserts",
    );
  }
  const removedUpdateIds: number[] = [];
  const removedIds = new Set<number>();
  for (const updateId of value.removedUpdateIds) {
    if (
      !isSafeNonNegativeInteger(updateId) ||
      removedIds.has(updateId) ||
      upsertedIds.has(updateId)
    ) {
      throw createJournalError("invalid", path, "has invalid segment removals");
    }
    removedIds.add(updateId);
    removedUpdateIds.push(updateId);
  }
  const operatorDispositions = (
    (value.operatorDispositions as unknown[] | undefined) ?? []
  ).map((disposition) =>
    validateJournalOperatorDisposition(disposition, path),
  );
  return {
    version,
    revision: value.revision,
    previousRevision: value.previousRevision,
    ...(value.acceptedThroughUpdateId !== undefined
      ? { acceptedThroughUpdateId: value.acceptedThroughUpdateId as number }
      : {}),
    profile: value.profile,
    botIdentity: validateBotIdentity(value.botIdentity, path),
    upsertedEntries,
    removedUpdateIds,
    ...(value.operatorDispositions !== undefined
      ? { operatorDispositions }
      : {}),
  };
}

/**
 * Isolated evidence only: caller must serialize/quiesce writers before inspection
 * and consumption. Metadata checks detect observable changes, not hostile same-user
 * swaps or whole-profile completeness. No locks, recovery, or publication occurs.
 * maxFiles counts snapshot + every enumerated segment entry (one overflow witness).
 * maxBytes aggregates all retained bytes. maxEntries bounds each raw collection and
 * reconstructed collection; maxWork charges each raw/revalidated collection element.
 * JSON allocation is bounded by maxBytes before decoding; collections before codecs.
 */
export function inspectTelegramInputCustodySourceStatus(
  input: Parameters<typeof inspectTelegramUpdateJournalFamily>[0],
): "absent" | "v3" | "legacy" | "unsupported" | "ambiguous" {
  try {
    const evidence = inspectTelegramUpdateJournalFamily(input);
    if (evidence.kind === "absent") return "absent";
    if (evidence.file.version === 3) return "v3";
    if (evidence.file.version === 1 || evidence.file.version === 2) return "legacy";
    return "unsupported";
  } catch {
    return "ambiguous";
  }
}

export function inspectTelegramUpdateJournalFamily(input: {
  directory: string;
  path: string;
  profile: string;
  botIdentity: TelegramUpdateJournalBotIdentity;
  limits: { maxFiles: number; maxBytes: number; maxEntries: number; maxWork: number };
}): { kind: "absent" } | {
  kind: "present";
  file: TelegramUpdateJournalFile;
  /** Validation constraint includes the caller's input, not only observed IDs. */
  knownBotId?: number;
  accounting: { files: number; bytes: number; work: number };
} {
  return acquireTelegramUpdateJournalFamily(input).evidence;
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
export function readTelegramUpdateJournalSource(
  input: Parameters<typeof inspectTelegramUpdateJournalFamily>[0] & { version: TelegramUpdateJournalFile["version"] },
): ReturnType<typeof inspectTelegramUpdateJournalFamily> {
  const version = input.version;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw createJournalError("unsupported-version", input.path, "requires a selected source version");
  }
  return acquireTelegramUpdateJournalFamily({
    ...input,
    botIdentity: { ...input.botIdentity },
    limits: { ...input.limits },
  }, version).evidence;
}

function acquireTelegramUpdateJournalFamily(
  input: Parameters<typeof inspectTelegramUpdateJournalFamily>[0],
  selectedVersion?: TelegramUpdateJournalFile["version"],
): JournalSourceAcquisition {
  const { path, limits } = input;
  const acquiredSegments: JournalSourceAcquisition["segments"] = [];
  let snapshotRevision = 0;
  const fail = (message: string): never => { throw createJournalError("invalid", path, message); };
  const capacity = (): never => { throw createJournalError("capacity", path, "exceeds inspection resource limits"); };
  for (const key of ["maxFiles", "maxBytes", "maxEntries", "maxWork"] as const) {
    if (!isSafePositiveInteger(limits[key])) fail("requires positive safe-integer limits");
  }
  const expected = validateBotIdentity(input.botIdentity, path);
  if (!isNonEmptyString(input.profile)) fail("requires an exact profile");
  const anchor = input.directory;
  const contained = relative(anchor, path);
  if (!isAbsolute(anchor) || resolve(anchor) !== anchor || !isAbsolute(path) ||
      resolve(path) !== path || !contained || contained === ".." ||
      contained.startsWith(`..${sep}`) || isAbsolute(contained)) fail("escapes its canonical directory anchor");
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) fail("platform lacks no-follow nonblocking open evidence");
  let files = 0;
  let bytes = 0;
  let work = 0;
  const observed = new Map<string, BigIntStats | undefined>();
  const ancestors = new Set<string>();
  const sameAncestor = (a: BigIntStats, b: BigIntStats) =>
    b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino &&
    a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
  const same = (a: BigIntStats, b: BigIntStats) =>
    a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const status = (target: string): BigIntStats | undefined => {
    try { return lstatSync(target, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const observe = (target: string, directory: boolean, optional = false) => {
    const value = status(target);
    if (!value && !optional) fail("has a missing path component");
    if (value && (value.isSymbolicLink() || !(directory ? value.isDirectory() : value.isFile()))) fail("has a linked or unexpected file type");
    observed.set(target, value);
    return value;
  };
  const charge = (value: unknown) => {
    if (!isRecord(value)) return;
    for (const key of ["entries", "upsertedEntries", "removedUpdateIds", "operatorDispositions"]) {
      const collection = value[key];
      if (!Array.isArray(collection)) continue;
      if (collection.length > limits.maxEntries || collection.length > limits.maxWork - work) capacity();
      work += collection.length;
    }
  };
  const read = (target: string, before: BigIntStats): unknown => {
    if (before.size > BigInt(limits.maxBytes - bytes)) capacity();
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !same(before, opened)) fail("changed before handle acquisition");
      const length = Number(opened.size);
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const count = readSync(fd, buffer, offset, length - offset, offset);
        if (!count) fail("disappeared or shrank during read");
        offset += count;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, length) !== 0 ||
          !same(opened, fstatSync(fd, { bigint: true }))) fail("changed during handle read");
      const after = status(target);
      if (!after || !same(opened, after)) fail("changed path during read");
      bytes += length;
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer));
      charge(value);
      return value;
    } finally { closeSync(fd); }
  };
  const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
  const enumerate = (): string[] => {
    const names: string[] = [];
    const directory = opendirSync(segmentDirectory, { bufferSize: 1 });
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (names.length >= limits.maxFiles - files) capacity();
        if (!/^\d{16}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) fail("has an unexpected segment entry");
        names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    return names.sort();
  };
  try {
    observe(anchor, true);
    ancestors.add(anchor);
    if (realpathSync(anchor) !== anchor) fail("requires a canonical directory anchor");
    let parent = anchor;
    for (const component of relative(anchor, dirname(path)).split(sep).filter(Boolean)) {
      parent = join(parent, component);
      observe(parent, true);
      ancestors.add(parent);
    }
    const snapshot = observe(path, false, true);
    const segments = observe(segmentDirectory, true, true);
    if (!snapshot && segments) fail("retains segments without a snapshot");
    files = snapshot ? 1 : 0;
    const names = segments ? enumerate() : [];
    let file: TelegramUpdateJournalFile | undefined;
    let knownBotId = expected.botId;
    const identity = (value: { profile: string; botIdentity: TelegramUpdateJournalBotIdentity }) => {
      if (value.profile !== input.profile || value.botIdentity.tokenSha256 !== expected.tokenSha256 ||
          (knownBotId !== undefined && value.botIdentity.botId !== undefined && knownBotId !== value.botIdentity.botId)) {
        throw createJournalError("identity-mismatch", path, "belongs to another exact journal identity");
      }
      knownBotId ??= value.botIdentity.botId;
    };
    if (snapshot) {
      const raw = read(path, snapshot);
      if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3)) {
        throw createJournalError("unsupported-version", path, "has an unsupported snapshot version");
      }
      file = parseJournalFile(raw, path, raw.version);
      snapshotRevision = file.revision ?? 0;
      identity(file);
      for (const name of names) {
        const target = join(segmentDirectory, name);
        const metadata = observe(target, false)!;
        const previousWork = work;
        const segment = parseJournalSegment(read(target, metadata), target, file.version);
        acquiredSegments.push({ name, bytes: Number(metadata.size), work: work - previousWork,
          ...(segment.botIdentity.botId !== undefined ? { botId: segment.botIdentity.botId } : {}) });
        files += 1;
        identity(segment);
        if (segment.revision !== Number(name.slice(0, 16)) || segment.previousRevision !== segment.revision - 1) fail("has an invalid intrinsic segment revision");
        const dispositionIds = new Set<string>();
        for (const disposition of segment.operatorDispositions ?? []) {
          if (dispositionIds.has(disposition.failureId)) fail("has duplicate segment disposition failure ids");
          dispositionIds.add(disposition.failureId);
        }
        const revision = file.revision ?? 0;
        if (segment.revision <= revision) continue;
        if (segment.revision !== revision + 1 || segment.previousRevision !== revision) fail("has a newer revision gap");
        if (segment.acceptedThroughUpdateId !== undefined && file.acceptedThroughUpdateId !== undefined &&
            segment.acceptedThroughUpdateId < file.acceptedThroughUpdateId) fail("regresses the admission cursor");
        const entries = new Map(file.entries.map(entry => [entry.updateId, entry]));
        for (const id of segment.removedUpdateIds) entries.delete(id);
        for (const entry of segment.upsertedEntries) {
          const previous = entries.get(entry.updateId);
          if (journalRequiresExclusion(file.version) && ((previous && previous.preApprovalExcluded !== entry.preApprovalExcluded) ||
              (!previous && entry.updateId <= (file.acceptedThroughUpdateId ?? -1)))) {
            throw createJournalError("pairing-evidence", target, "changes exclusion evidence or resurrects a settled source");
          }
          if (!entries.has(entry.updateId) && entries.size >= limits.maxEntries) capacity();
          entries.set(entry.updateId, entry);
        }
        const next = {
          ...file,
          revision: segment.revision,
          ...(segment.acceptedThroughUpdateId !== undefined ? { acceptedThroughUpdateId: segment.acceptedThroughUpdateId } : {}),
          entries: [...entries.values()].sort((a, b) => a.updateId - b.updateId),
          operatorDispositions: segment.operatorDispositions ?? file.operatorDispositions,
        };
        charge(next);
        file = parseJournalFile(next, target, file.version);
      }
    }
    // Re-enumeration has the same bound, rather than allocating an unbounded census.
    files = snapshot ? 1 : 0;
    if (segments && !isDeepStrictEqual(names, enumerate())) fail("changed segment namespace");
    files += names.length;
    for (const [target, before] of observed) {
      const after = status(target);
      const compare = selectedVersion !== undefined && ancestors.has(target) ? sameAncestor : same;
      if (before ? !after || !compare(before, after) : after !== undefined) fail("changed observed namespace or file");
    }
    if (selectedVersion !== undefined) {
      if (realpathSync(anchor) !== anchor) fail("requires a canonical directory anchor");
      if (file) {
        if (file.version !== selectedVersion) {
          throw createJournalError("unsupported-version", path, "does not match the selected source version");
        }
        if (createTelegramUpdateJournalReceiptScope({ profileName: input.profile, botIdentity: expected }) !==
            createTelegramUpdateJournalReceiptScope({ profileName: file.profile, botIdentity: file.botIdentity })) {
          throw createJournalError("identity-mismatch", path, "does not retain the expected receipt scope");
        }
      }
    }
    return {
      evidence: file ? { kind: "present", file, ...(knownBotId !== undefined ? { knownBotId } : {}), accounting: { files, bytes, work } } : { kind: "absent" },
      snapshotRevision,
      segments: acquiredSegments,
    };
  } catch (error) {
    if (error instanceof TelegramUpdateJournalError) throw error;
    throw createJournalError("io", path, "could not establish strict journal evidence", error);
  }
}

/**
 * Canonical namespace evidence only, never source readiness or authorization.
 * Caller-proven serialization/quiescence is mandatory through consumption.
 * Recensus detects observable changes, not hostile same-user path swaps; arbitrary
 * consumer references and archive consumption require separate audits.
 */
export function inspectTelegramProfileJournalNamespace(input: {
  directory: string;
  profile: string;
  botIdentity: TelegramUpdateJournalBotIdentity;
  limits: { maxDirectoryEntries: number; maxFiles: number; maxBytes: number; maxEntries: number; maxWork: number };
}): {
  sources: { role: "polling" | "follower"; path: string; evidence: ReturnType<typeof inspectTelegramUpdateJournalFamily> }[];
  accounting: { directoryEntries: number; files: number; bytes: number; work: number };
  knownBotId?: number;
} {
  const { directory, profile, limits } = input;
  const fail = (message: string): never => { throw createJournalError("invalid", directory, message); };
  const capacity = (): never => { throw createJournalError("capacity", directory, "exceeds namespace inspection resource limits"); };
  for (const key of ["maxDirectoryEntries", "maxFiles", "maxBytes", "maxEntries", "maxWork"] as const) {
    if (!isSafePositiveInteger(limits[key])) fail("requires positive safe-integer limits");
  }
  if (!/^[a-z0-9]{1,32}$/u.test(profile)) fail("requires a canonical profile namespace");
  const expected = validateBotIdentity(input.botIdentity, directory);
  if (!isAbsolute(directory) || resolve(directory) !== directory) fail("requires a canonical directory anchor");
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) fail("platform lacks no-follow nonblocking open evidence");
  const metadata = (target: string) => {
    const value = lstatSync(target, { bigint: true });
    return { dev: value.dev, ino: value.ino, mode: value.mode, nlink: value.nlink,
      size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
  };
  const suffix = profile === "default" ? "" : `.${profile}`;
  const polling = `inbox${suffix}.json`;
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(directory) !== directory) fail("requires a canonical directory anchor");
    const beforeRoot = metadata(directory);
    const census = () => {
      const entries = new Map<string, ReturnType<typeof metadata>>();
      const followers = new Set<string>();
      const handle = opendirSync(directory, { bufferSize: 1 });
      try {
        for (;;) {
          const entry = handle.readSync();
          if (!entry) break;
          if (entries.size >= limits.maxDirectoryEntries) capacity();
          if (entry.name.toLowerCase() === "recovery") fail("retains unclassified recovery storage");
          const target = join(directory, entry.name);
          entries.set(entry.name, metadata(target));
          if (!/inbox/iu.test(entry.name)) continue;
          const match = /^(inbox|follower-inbox-[a-f0-9]{16})(?:\.([a-z0-9]{1,32}))?\.json(\.segments)?$/u.exec(entry.name);
          if (!match || match[2] === "default") fail("has a noncanonical journal-like entry");
          const value = lstatSync(target);
          if (value.isSymbolicLink() || !(match![3] ? value.isDirectory() : value.isFile())) fail("has a linked or unexpected journal type");
          if ((match![2] ?? "default") !== profile) continue;
          if (match![1] !== "inbox") followers.add(entry.name.replace(/\.segments$/u, ""));
        }
      } finally { handle.closeSync(); }
      return { entries: [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), followers: [...followers].sort() };
    };
    const before = census();
    const sources: { role: "polling" | "follower"; path: string; evidence: ReturnType<typeof inspectTelegramUpdateJournalFamily> }[] = [];
    const accounting = { directoryEntries: before.entries.length, files: 0, bytes: 0, work: 0 };
    let knownBotId = expected.botId;
    for (const name of [polling, ...before.followers]) {
      const remaining = { maxFiles: limits.maxFiles - accounting.files, maxBytes: limits.maxBytes - accounting.bytes,
        maxWork: limits.maxWork - accounting.work, maxEntries: limits.maxEntries };
      if (remaining.maxFiles <= 0 || remaining.maxBytes <= 0 || remaining.maxWork <= 0) capacity();
      const path = join(directory, name);
      const evidence = inspectTelegramUpdateJournalFamily({ directory, path, profile,
        botIdentity: { ...expected, ...(knownBotId !== undefined ? { botId: knownBotId } : {}) }, limits: remaining });
      if (evidence.kind === "absent" && (name !== polling || before.entries.some(([entry]) => entry === polling || entry === `${polling}.segments`))) {
        fail("lost a discovered journal family");
      }
      if (evidence.kind === "present") {
        knownBotId = evidence.knownBotId;
        accounting.files += evidence.accounting.files;
        accounting.bytes += evidence.accounting.bytes;
      }
      accounting.work += evidence.kind === "present" ? Math.max(1, evidence.accounting.work) : 1;
      sources.push({ role: name === polling ? "polling" : "follower", path, evidence });
    }
    if (!isDeepStrictEqual(before, census()) || !isDeepStrictEqual(beforeRoot, metadata(directory))) fail("changed observed root namespace or identity");
    return { sources, accounting, ...(knownBotId !== undefined ? { knownBotId } : {}) };
  } catch (error) {
    if (error instanceof TelegramUpdateJournalError) throw error;
    throw createJournalError("io", directory, "could not establish canonical namespace evidence", error);
  }
}

function cloneEntry(entry: TelegramUpdateJournalEntry): TelegramUpdateJournalEntry {
  return {
    ...entry,
    update: structuredClone(entry.update),
    ...(entry.inputClaim ? { inputClaim: structuredClone(entry.inputClaim) } : {}),
    ...(entry.inputProvenance
      ? { inputProvenance: structuredClone(entry.inputProvenance) } : {}),
    ...(entry.queueOwner
      ? { queueOwner: cloneJournalQueueOwner(entry.queueOwner) }
      : {}),
    ...(entry.queueHandoff
      ? { queueHandoff: cloneJournalQueueHandoff(entry.queueHandoff) }
      : {}),
    ...(entry.failure ? { failure: { ...entry.failure } } : {}),
  };
}

function cloneFile(file: TelegramUpdateJournalFile): TelegramUpdateJournalFile {
  return {
    version: file.version,
    ...(file.revision !== undefined ? { revision: file.revision } : {}),
    ...(file.acceptedThroughUpdateId !== undefined
      ? { acceptedThroughUpdateId: file.acceptedThroughUpdateId }
      : {}),
    profile: file.profile,
    botIdentity: { ...file.botIdentity },
    entries: file.entries.map(cloneEntry),
    ...(file.operatorDispositions?.length
      ? {
          operatorDispositions: file.operatorDispositions.map(
            (disposition) => ({ ...disposition }),
          ),
        }
      : {}),
  };
}

function serializeJournalFile(file: TelegramUpdateJournalFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function getTelegramUpdateJournalSegmentDirectory(path: string): string {
  return `${path}.segments`;
}

function getTelegramUpdateJournalSegmentPath(
  path: string,
  revision: number,
): string {
  return join(
    getTelegramUpdateJournalSegmentDirectory(path),
    `${String(revision).padStart(16, "0")}.json`,
  );
}

function publishTelegramUpdateJournalSegmentUnlocked(
  path: string,
  segment: TelegramUpdateJournalSegment,
  onPublicationBoundary?: TelegramUpdateJournalStoreOptions["onPublicationBoundary"],
): TelegramUpdateJournalSegmentPublicationResult {
  const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
  const segmentPath = getTelegramUpdateJournalSegmentPath(
    path,
    segment.revision,
  );
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
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      snapshotRevision = parseJournalFile(parsed, path, segment.version).revision ?? 0;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ENOENT") throw error;
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
      } catch {
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

export function publishTelegramUpdateJournalSegment(
  path: string,
  segment: TelegramUpdateJournalSegment,
): TelegramUpdateJournalSegmentPublicationResult {
  if (
    segment.version !== TELEGRAM_UPDATE_JOURNAL_VERSION ||
    !isSafePositiveInteger(segment.revision) ||
    segment.previousRevision !== segment.revision - 1 ||
    !isNonEmptyString(segment.profile) ||
    !Array.isArray(segment.upsertedEntries) ||
    !Array.isArray(segment.removedUpdateIds)
  ) {
    throw new Error("Telegram update journal segment is invalid.");
  }
  return withTelegramFileTransaction(`${path}.transaction`, () =>
    publishTelegramUpdateJournalSegmentUnlocked(path, segment),
  );
}

function normalizeCapacityLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`Telegram update journal ${label} must be a positive integer.`);
  }
  return resolved;
}

function identitiesMatch(
  left: TelegramUpdateJournalBotIdentity,
  right: TelegramUpdateJournalBotIdentity,
): boolean {
  if (
    left.botId !== undefined &&
    right.botId !== undefined &&
    left.botId !== right.botId
  ) {
    return false;
  }
  return (
    (left.botId !== undefined && left.botId === right.botId) ||
    left.tokenSha256 === right.tokenSha256
  );
}

function mergeBotIdentity(
  stored: TelegramUpdateJournalBotIdentity,
  current: TelegramUpdateJournalBotIdentity,
): TelegramUpdateJournalBotIdentity {
  return {
    ...(current.botId !== undefined
      ? { botId: current.botId }
      : stored.botId !== undefined
        ? { botId: stored.botId }
        : {}),
    tokenSha256: current.tokenSha256,
  };
}

function writeJournalFile(
  path: string,
  serialized: string,
  onPublicationBoundary?: TelegramUpdateJournalStoreOptions["onPublicationBoundary"],
  stagingPath = path,
): void {
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
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // The successful atomic rename already consumed the temporary path.
    }
  }
}

export function createTelegramUpdateQueueHandoffToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createTelegramUpdateJournalBotIdentity(input: {
  botToken: string;
  botId?: number;
}): TelegramUpdateJournalBotIdentity {
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

export function createTelegramUpdateJournalReceiptScope(input: {
  profileName?: string;
  botIdentity: TelegramUpdateJournalBotIdentity;
}): string {
  const profile = (input.profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME).trim();
  if (!profile) {
    throw new Error("Telegram update journal receipt scope requires a profile.");
  }
  if (
    input.botIdentity.botId !== undefined &&
    !isSafePositiveInteger(input.botIdentity.botId)
  ) {
    throw new Error("Telegram update journal bot id must be a safe integer.");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.botIdentity.tokenSha256)) {
    throw new Error(
      "Telegram update journal receipt scope requires a SHA-256 token fingerprint.",
    );
  }
  return JSON.stringify({
    version: TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION,
    profile,
    bot:
      input.botIdentity.botId === undefined
        ? { tokenSha256: input.botIdentity.tokenSha256 }
        : { botId: input.botIdentity.botId },
  });
}

export function createTelegramUpdateJournalBindingKey(input: {
  path: string;
  profileName?: string;
  botIdentity: TelegramUpdateJournalBotIdentity;
}): string {
  if (!input.path) {
    throw new Error("Telegram update journal binding requires a path.");
  }
  return JSON.stringify({
    version: TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION,
    path: input.path,
    receiptScope: createTelegramUpdateJournalReceiptScope(input),
  });
}

export function getTelegramUpdateJournalBindingPath(
  journalBindingKey: string,
): string | undefined {
  try {
    const value = JSON.parse(journalBindingKey) as Record<string, unknown>;
    return value.version === TELEGRAM_UPDATE_JOURNAL_IDENTITY_VERSION &&
      typeof value.path === "string" &&
      value.path.length > 0 &&
      typeof value.receiptScope === "string"
      ? value.path
      : undefined;
  } catch {
    return undefined;
  }
}

export function createTelegramUpdateJournalReceiptScopeResolver(deps: {
  getProfileName: () => string | undefined;
  getBotToken: () => string | undefined;
  getBotId: () => number | undefined;
}): () => string | undefined {
  let identityKey: string | undefined;
  let receiptScope: string | undefined;
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
    if (nextIdentityKey === identityKey && receiptScope) return receiptScope;
    identityKey = nextIdentityKey;
    receiptScope = createTelegramUpdateJournalReceiptScope({
      profileName,
      botIdentity,
    });
    return receiptScope;
  };
}

export interface TelegramUpdateJournalRuntimeBinding {
  runtimeKey: string;
  recoveryKey: string;
  journal: TelegramUpdateJournalStore;
}

export interface TelegramUpdateJournalRuntimeBindingResolverDeps {
  getProfileName: () => string | undefined;
  getBotToken: () => string | undefined;
  getBotId: () => number | undefined;
  getJournalPath: (profileName?: string) => string;
  getQueueRuntimeIdentity?: () => TelegramUpdateJournalQueueRuntimeIdentity;
  withWriterAdmission?: <T>(operation: () => T) => T;
  getWorkspaceAdmission?: () => Pick<
    TelegramWorkspaceAdmissionLedger,
    "acquireAdmission" | "releaseAdmission"
  > | undefined;
  onRecovery?: (event: TelegramUpdateJournalRecoveryEvent) => void;
}

export function createTelegramUpdateJournalRuntimeBindingResolver(
  deps: TelegramUpdateJournalRuntimeBindingResolverDeps,
): () => TelegramUpdateJournalRuntimeBinding | undefined {
  return () => {
    const botToken = deps.getBotToken();
    if (!botToken) return undefined;
    const configuredProfileName = deps.getProfileName();
    const profileName =
      configuredProfileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
    const botIdentity = createTelegramUpdateJournalBotIdentity({
      botToken,
      botId: deps.getBotId(),
    });
    const path = deps.getJournalPath(configuredProfileName);
    const workspaceAdmission = deps.getWorkspaceAdmission?.();
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
      journal: createTelegramUpdateJournalStore({
        path,
        profileName,
        botIdentity,
        ...(deps.getQueueRuntimeIdentity
          ? { queueRuntimeIdentity: deps.getQueueRuntimeIdentity() }
          : {}),
        ...(workspaceAdmission ? { workspaceAdmission } : {}),
        ...(deps.withWriterAdmission ? { withWriterAdmission: deps.withWriterAdmission } : {}),
        ...(deps.onRecovery ? { onRecovery: deps.onRecovery } : {}),
      }),
    };
  };
}

export type TelegramUpdateJournalReferenceClass =
  | "leader-lifecycle"
  | "follower-lifecycle"
  | "polling-cursor"
  | "polling-bootstrap"
  | "workspace-retirement"
  | "operator-disposition";

export function createTelegramUpdateJournalReferenceRegistry(input: {
  maxActive?: number;
} = {}) {
  const maxActive = input.maxActive ?? 64;
  let sequence = 0;
  const active = new Map<number, { referenceClass: TelegramUpdateJournalReferenceClass;
    recoveryKey: string }>();
  return {
    acquire(reference: { referenceClass: TelegramUpdateJournalReferenceClass;
      recoveryKey: string }): () => void {
      if (!reference.recoveryKey || active.size >= maxActive) throw new Error(
        "Telegram update journal reference registry is unavailable or full.",
      );
      const id = ++sequence;
      active.set(id, { ...reference });
      let released = false;
      return () => {
        if (released || !active.delete(id)) throw new Error(
          "Telegram update journal reference lease is stale.",
        );
        released = true;
      };
    },
    list: () => [...active.values()].map(reference => ({ ...reference })),
    withReference<T>(reference: { referenceClass: TelegramUpdateJournalReferenceClass;
      recoveryKey: string }, operation: () => T): T {
      const release = this.acquire(reference);
      try {
        const result = operation();
        if (result && typeof (result as { finally?: unknown }).finally === "function")
          return ((result as unknown) as Promise<unknown>).finally(release) as T;
        release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}

export function withTelegramResolvedUpdateJournalReference<T>(input: {
  registry: ReturnType<typeof createTelegramUpdateJournalReferenceRegistry>;
  resolveBinding(): TelegramUpdateJournalRuntimeBinding | undefined;
  referenceClass: TelegramUpdateJournalReferenceClass;
  operation(binding: TelegramUpdateJournalRuntimeBinding): T;
}): T | undefined {
  const binding = input.resolveBinding();
  if (!binding) return undefined;
  return input.registry.withReference({ referenceClass: input.referenceClass,
    recoveryKey: binding.recoveryKey }, () => input.operation(binding));
}

export interface TelegramUpdateJournalBindingRuntime {
  resolveLeader: () => TelegramUpdateJournalRuntimeBinding | undefined;
  resolveFollower: () => TelegramUpdateJournalRuntimeBinding | undefined;
  resolveActive: () => TelegramUpdateJournalRuntimeBinding | undefined;
  getActiveRecoveryKey: () => string | undefined;
  createRecipientResolver: (
    recipientBindingKey: string,
  ) => () => TelegramUpdateJournalRuntimeBinding | undefined;
  createPathResolver: (
    path: string,
  ) => () => TelegramUpdateJournalRuntimeBinding | undefined;
}

export function createTelegramUpdateJournalBindingRuntime(deps: {
  base: Omit<TelegramUpdateJournalRuntimeBindingResolverDeps, "getJournalPath">;
  getLeaderJournalPath: (profileName?: string) => string;
  getFollowerJournalPath: (
    bindingKey: string,
    profileName?: string,
  ) => string;
  getActiveFollowerBindingKey: () => string;
  isFollowerRegistered: () => boolean;
}): TelegramUpdateJournalBindingRuntime {
  const resolveLeader = createTelegramUpdateJournalRuntimeBindingResolver({
    ...deps.base,
    getJournalPath: deps.getLeaderJournalPath,
  });
  const createFollowerResolver = (
    bindingKey: string,
    includeQueueRuntimeIdentity: boolean,
  ) =>
    createTelegramUpdateJournalRuntimeBindingResolver({
      getProfileName: deps.base.getProfileName,
      getBotToken: deps.base.getBotToken,
      getBotId: deps.base.getBotId,
      ...(includeQueueRuntimeIdentity && deps.base.getQueueRuntimeIdentity
        ? { getQueueRuntimeIdentity: deps.base.getQueueRuntimeIdentity }
        : {}),
      ...(deps.base.withWriterAdmission
        ? { withWriterAdmission: deps.base.withWriterAdmission } : {}),
      ...(deps.base.getWorkspaceAdmission
        ? { getWorkspaceAdmission: deps.base.getWorkspaceAdmission }
        : {}),
      ...(deps.base.onRecovery ? { onRecovery: deps.base.onRecovery } : {}),
      getJournalPath(profileName) {
        return deps.getFollowerJournalPath(bindingKey, profileName);
      },
    });
  const resolveFollower = () =>
    createFollowerResolver(deps.getActiveFollowerBindingKey(), true)();
  const resolveActive = () =>
    deps.isFollowerRegistered() ? resolveFollower() : resolveLeader();
  return {
    resolveLeader,
    resolveFollower,
    resolveActive,
    getActiveRecoveryKey: () => resolveActive()?.recoveryKey,
    createRecipientResolver: (bindingKey) =>
      createFollowerResolver(bindingKey, false),
    createPathResolver: (path) =>
      createTelegramUpdateJournalRuntimeBindingResolver({
        getProfileName: deps.base.getProfileName,
        getBotToken: deps.base.getBotToken,
        getBotId: deps.base.getBotId,
        ...(deps.base.withWriterAdmission
          ? { withWriterAdmission: deps.base.withWriterAdmission } : {}),
        ...(deps.base.getWorkspaceAdmission
          ? { getWorkspaceAdmission: deps.base.getWorkspaceAdmission }
          : {}),
        ...(deps.base.onRecovery ? { onRecovery: deps.base.onRecovery } : {}),
        getJournalPath: () => path,
      }),
  };
}

export function createTelegramUpdateJournalStore(
  options: TelegramUpdateJournalStoreOptions,
): TelegramUpdateJournalStore {
  return createJournalStoreCore(options).journal;
}

/** Opt-in v3 only; does not migrate old files or expose legacy unowned mutation ports. */
export function createTelegramInputJournalStore(
  options: TelegramInputJournalStoreOptions,
): TelegramInputJournalStore {
  const captured = { ...options };
  if (!captured.sourceAccess || !captured.queueRuntimeIdentity ||
      typeof captured.withSourceSerialization !== "function" ||
      typeof captured.withPairingAdmission !== "function" ||
      typeof captured.getInputContext !== "function" ||
      ("withPairedAdmission" in captured && captured.withPairedAdmission !== undefined)) {
    throw new Error("Telegram input custody requires strict serialized polling admission and runtime identity.");
  }
  return createJournalStoreCore({ ...captured, queueRuntimeIdentity: { ...captured.queueRuntimeIdentity } },
    captured.getInputContext).input!;
}

function createJournalStoreCore(
  options: TelegramUpdateJournalStoreOptions,
  getInputContext?: TelegramInputJournalStoreOptions["getInputContext"],
): { journal: TelegramUpdateJournalStore; input?: TelegramInputJournalStore } {
  const path = options.path;
  const profile = options.profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
  if (!path) throw new Error("Telegram update journal path is required.");
  if (!profile) throw new Error("Telegram update journal profile is required.");
  const expectedIdentity = validateBotIdentity(options.botIdentity, path);
  const queueRuntimeIdentity = options.queueRuntimeIdentity;
  if (
    queueRuntimeIdentity !== undefined &&
    (!isBoundedString(
      queueRuntimeIdentity.instanceId,
      TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH,
    ) ||
      !isSafePositiveInteger(queueRuntimeIdentity.processId) ||
      !isBoundedString(
        queueRuntimeIdentity.processBirthId,
        TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH,
      ))
  ) {
    throw new Error(
      "Telegram update journal queue process identity is invalid.",
    );
  }
  const maxEntries = normalizeCapacityLimit(
    options.maxEntries,
    TELEGRAM_UPDATE_JOURNAL_MAX_ENTRIES,
    "entry limit",
  );
  const maxBytes = normalizeCapacityLimit(
    options.maxBytes,
    TELEGRAM_UPDATE_JOURNAL_MAX_BYTES,
    "byte limit",
  );
  const getNowMs = options.getNowMs ?? Date.now;
  const onPublicationBoundary = options.onPublicationBoundary;
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
  const version = getInputContext ? TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION
    : withPairingAdmission ? TELEGRAM_UPDATE_JOURNAL_EXCLUSION_VERSION : TELEGRAM_UPDATE_JOURNAL_VERSION;
  const notifyRecovery = (event: TelegramUpdateJournalRecoveryEvent): void => {
    try {
      options.onRecovery?.(event);
    } catch {
      // Recovery diagnostics must not break recovered journal authority.
    }
  };
  const getQueueProcessLiveness =
    options.getQueueProcessLiveness ?? getTelegramProcessLiveness;

  const validateQueueHandoffInput = (
    input: TelegramUpdateJournalQueueHandoffInput,
    operation: "offer" | "accept" | "cancel",
  ): {
    expectedOwner: TelegramUpdateJournalQueueOwner;
    recipientOwner: TelegramUpdateJournalQueueOwnerIdentity;
    requestedIds: Set<number>;
    handoffId: string;
  } => {
    if (
      (input.queueKind !== "prompt" && input.queueKind !== "control") ||
      !isNonEmptyString(input.receiptId) ||
      !Array.isArray(input.sourceUpdateIds) ||
      input.sourceUpdateIds.length === 0 ||
      !isBoundedString(
        input.handoffToken,
        TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MAX_LENGTH,
      ) ||
      input.handoffToken.length <
        TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MIN_LENGTH
    ) {
      throw createJournalError(
        "invalid",
        path,
        `received an invalid queue handoff ${operation}`,
      );
    }
    const expectedOwner = validateJournalQueueOwner(input.expectedOwner, path);
    const recipientOwner = validateJournalQueueOwnerIdentity(
      input.recipientOwner,
      path,
    );
    const runtimeIdentity = operation === "accept" ? recipientOwner : expectedOwner;
    if (
      queueRuntimeIdentity &&
      (runtimeIdentity.instanceId !== queueRuntimeIdentity.instanceId ||
        runtimeIdentity.processId !== queueRuntimeIdentity.processId ||
        runtimeIdentity.processBirthId !== queueRuntimeIdentity.processBirthId)
    ) {
      throw createJournalError(
        "conflict",
        path,
        operation === "accept"
          ? `cannot accept queue receipt ${input.receiptId} for another runtime`
          : `cannot ${operation} foreign queue receipt ${input.receiptId}`,
      );
    }
    const requestedIds = new Set<number>();
    for (const updateId of input.sourceUpdateIds) {
      if (!isSafeNonNegativeInteger(updateId) || requestedIds.has(updateId)) {
        throw createJournalError(
          "invalid",
          path,
          `received invalid queue handoff ${operation} update ids`,
        );
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

  const getExactQueuedReceiptEntries = (
    current: ReadTelegramUpdateJournalResult,
    input: Pick<
      TelegramUpdateJournalQueueHandoffInput,
      "queueKind" | "receiptId"
    >,
    requestedIds: ReadonlySet<number>,
  ): TelegramUpdateJournalEntry[] => {
    const receiptEntries = current.file.entries.filter(
      (entry) => entry.queueReceiptId === input.receiptId,
    );
    if (
      receiptEntries.length !== requestedIds.size ||
      receiptEntries.some(
        (entry) =>
          !requestedIds.has(entry.updateId) ||
          entry.state !== "queued" ||
          entry.queueKind !== input.queueKind,
      )
    ) {
      throw createJournalError(
        "conflict",
        path,
        `cannot hand off stale queue receipt ${input.receiptId}`,
      );
    }
    return receiptEntries;
  };

  const assertCapacity = (
    file: TelegramUpdateJournalFile,
    serialized = serializeJournalFile(file),
  ): number => {
    if (file.entries.length > maxEntries) {
      throw createJournalError(
        "capacity",
        path,
        `exceeds its ${maxEntries}-entry limit`,
      );
    }
    if ((file.operatorDispositions?.length ?? 0) > maxEntries) {
      throw createJournalError(
        "capacity",
        path,
        `exceeds its ${maxEntries}-operator-disposition limit`,
      );
    }
    const serializedBytes = Buffer.byteLength(serialized);
    if (serializedBytes > maxBytes) {
      throw createJournalError(
        "capacity",
        path,
        `exceeds its ${maxBytes}-byte limit`,
      );
    }
    return serializedBytes;
  };

  const emptyFile = (): TelegramUpdateJournalFile => ({
    version,
    profile,
    botIdentity: { ...expectedIdentity },
    entries: [],
  });

  const readCurrentStrict = (): ReadTelegramUpdateJournalResult => {
    let source: string;
    let recoveringMissingSnapshot = false;
    try {
      const size = statSync(path).size;
      if (size > maxBytes) {
        throw createJournalError(
          "capacity",
          path,
          `exceeds its ${maxBytes}-byte limit`,
        );
      }
      source = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof TelegramUpdateJournalError) throw error;
      if ((error as { code?: unknown })?.code === "ENOENT") {
        const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
        let orphanedSegmentNames: string[];
        try {
          orphanedSegmentNames = readdirSync(segmentDirectory).filter((name) =>
            /^\d{16}\.json$/u.test(name),
          );
        } catch (segmentError) {
          if ((segmentError as { code?: unknown })?.code === "ENOENT") {
            return { file: emptyFile(), exists: false, serializedBytes: 0 };
          }
          throw createJournalError(
            "io",
            segmentDirectory,
            "could not be read while the journal snapshot is missing",
            segmentError,
          );
        }
        if (orphanedSegmentNames.length > 0) {
          if (withPairingAdmission) throw createJournalError("pairing-evidence", path, "requires explicit missing-snapshot reconciliation");
          recoveringMissingSnapshot = true;
          source = serializeJournalFile(emptyFile());
        } else {
          return { file: emptyFile(), exists: false, serializedBytes: 0 };
        }
      } else {
        throw createJournalError("io", path, "could not be read", error);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw createJournalError("invalid", path, "contains invalid JSON", error);
    }
    let file = parseJournalFile(parsed, path, version);
    const storedProfile = file.profile;
    const storedIdentity = file.botIdentity;
    const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
    let segmentNames: string[] = [];
    try {
      segmentNames = readdirSync(segmentDirectory).filter((name) =>
        /^\d{16}\.json$/u.test(name),
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ENOENT") {
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
      if (nameRevision <= revision) continue;
      const segmentPath = join(segmentDirectory, name);
      let segment: TelegramUpdateJournalSegment;
      try {
        const segmentSize = statSync(segmentPath).size;
        if (segmentSize > maxBytes) {
          throw createJournalError(
            "capacity",
            segmentPath,
            `exceeds its ${maxBytes}-byte limit`,
          );
        }
        unappliedSegmentBytes += segmentSize;
        if (unappliedSegmentBytes > maxBytes) {
          throw createJournalError(
            "capacity",
            segmentDirectory,
            `exceeds its ${maxBytes}-byte unapplied-segment limit`,
          );
        }
        segment = parseJournalSegment(
          JSON.parse(readFileSync(segmentPath, "utf8")) as unknown,
          segmentPath,
          version,
        );
      } catch (error) {
        if (error instanceof TelegramUpdateJournalError) throw error;
        throw createJournalError(
          "invalid",
          segmentPath,
          "contains invalid JSON",
          error,
        );
      }
      if (segment.revision !== nameRevision) {
        throw createJournalError(
          "invalid",
          segmentPath,
          "revision does not match its file name",
        );
      }
      if (segment.previousRevision !== revision) {
        throw createJournalError(
          "invalid",
          segmentPath,
          `has a revision gap after ${revision}`,
        );
      }
      if (
        segment.acceptedThroughUpdateId !== undefined &&
        file.acceptedThroughUpdateId !== undefined &&
        segment.acceptedThroughUpdateId < file.acceptedThroughUpdateId
      ) {
        throw createJournalError(
          "invalid",
          segmentPath,
          "regresses the admission cursor",
        );
      }
      if (
        segment.profile !== storedProfile ||
        !identitiesMatch(segment.botIdentity, storedIdentity) ||
        (withPairingAdmission && segment.botIdentity.tokenSha256 !== storedIdentity.tokenSha256)
      ) {
        throw createJournalError(
          "identity-mismatch",
          segmentPath,
          "belongs to another journal identity",
        );
      }
      const entriesById = new Map(
        file.entries.map((entry) => [entry.updateId, entry]),
      );
      for (const updateId of segment.removedUpdateIds) {
        if (recoveringMissingSnapshot && !entriesById.has(updateId)) {
          orphanRecoverySawBaseRemoval = true;
          if (orphanRecoverySawUpsert) orphanRecoveryUnsafe = true;
        }
        entriesById.delete(updateId);
      }
      for (const entry of segment.upsertedEntries) {
        const previous = entriesById.get(entry.updateId);
        if (withPairingAdmission &&
            ((previous && previous.preApprovalExcluded !== entry.preApprovalExcluded) ||
              (!previous && entry.updateId <= (file.acceptedThroughUpdateId ?? -1)))) {
          throw createJournalError("pairing-evidence", segmentPath, "changes exclusion evidence or resurrects a settled source");
        }
        entriesById.set(entry.updateId, entry);
      }
      if (segment.upsertedEntries.length > 0) orphanRecoverySawUpsert = true;
      file = parseJournalFile(
        {
          version,
          revision: segment.revision,
          ...(segment.acceptedThroughUpdateId !== undefined
            ? { acceptedThroughUpdateId: segment.acceptedThroughUpdateId }
            : file.acceptedThroughUpdateId !== undefined
              ? { acceptedThroughUpdateId: file.acceptedThroughUpdateId }
              : {}),
          profile: storedProfile,
          botIdentity: mergeBotIdentity(file.botIdentity, segment.botIdentity),
          entries: [...entriesById.values()].sort(
            (left, right) => left.updateId - right.updateId,
          ),
          ...(segment.operatorDispositions !== undefined
            ? { operatorDispositions: segment.operatorDispositions }
            : file.operatorDispositions?.length
              ? { operatorDispositions: file.operatorDispositions }
              : {}),
        },
        segmentPath,
        version,
      );
      revision = segment.revision;
    }
    const identityChanged =
      storedProfile !== profile ||
      !identitiesMatch(file.botIdentity, expectedIdentity) ||
      (withPairingAdmission && file.botIdentity.tokenSha256 !== expectedIdentity.tokenSha256);
    if (identityChanged) {
      if (file.entries.length > 0 || withPairingAdmission) {
        throw createJournalError(
          "identity-mismatch",
          path,
          storedProfile !== profile
            ? `belongs to profile ${storedProfile}, not ${profile}`
            : "belongs to another Telegram bot identity",
        );
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
          } catch {
            // The rebound snapshot owns the current revision and no old
            // identity authority; redundant cleanup remains best-effort.
          }
        }
      }
      try {
        rmdirSync(segmentDirectory);
      } catch {
        // Redundant old segments are ignored at or below the snapshot revision.
      }
      return { file, exists: true, serializedBytes: reboundBytes };
    }
    if (recoveringMissingSnapshot) {
      if (
        orphanRecoveryUnsafe ||
        !orphanRecoverySawBaseRemoval ||
        file.entries.length > 0
      ) {
        throw createJournalError(
          "invalid",
          path,
          `is missing while ${segmentDirectory} retains revision segments`,
        );
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

  const readCurrent = (): ReadTelegramUpdateJournalResult => {
    try {
      return readCurrentStrict();
    } catch (error) {
      if (
        withPairingAdmission ||
        !(error instanceof TelegramUpdateJournalError) ||
        error.code !== "invalid"
      ) {
        throw error;
      }
      let snapshotExists = false;
      try {
        statSync(path);
        snapshotExists = true;
      } catch (snapshotError) {
        if ((snapshotError as { code?: unknown })?.code !== "ENOENT") throw error;
      }
      const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
      let segmentNames: string[];
      try {
        segmentNames = readdirSync(segmentDirectory)
          .filter((name) => /^\d{16}\.json$/u.test(name))
          .sort();
      } catch {
        throw error;
      }
      if (segmentNames.length === 0) throw error;

      // Earlier corruption must not hide a newer schema behind repair or reset.
      let recoverySegmentBytes = 0;
      for (const candidatePath of [
        ...(snapshotExists ? [path] : []),
        ...segmentNames.map((name) => join(segmentDirectory, name)),
      ]) {
        const size = statSync(candidatePath).size;
        if (candidatePath !== path) recoverySegmentBytes += size;
        if (size > maxBytes || recoverySegmentBytes > maxBytes) {
          throw createJournalError("capacity", candidatePath, "exceeds the recovery inspection byte limit");
        }
        try {
          assertSupportedJournalVersion(JSON.parse(readFileSync(candidatePath, "utf8")), candidatePath);
        } catch (inspectionError) {
          if (!(inspectionError instanceof SyntaxError)) throw inspectionError;
        }
      }

      if (snapshotExists) {
        try {
          const snapshot = parseJournalFile(
            JSON.parse(readFileSync(path, "utf8")) as unknown,
            path,
          );
          const firstSegmentPath = join(segmentDirectory, segmentNames[0]);
          const firstSegment = parseJournalSegment(
            JSON.parse(readFileSync(firstSegmentPath, "utf8")) as unknown,
            firstSegmentPath,
          );
          if (
            snapshot.revision === undefined &&
            firstSegment.previousRevision > 0 &&
            snapshot.profile === firstSegment.profile &&
            identitiesMatch(snapshot.botIdentity, firstSegment.botIdentity)
          ) {
            writeJournalFile(
              path,
              serializeJournalFile({
                ...snapshot,
                revision: firstSegment.previousRevision,
              }),
              onPublicationBoundary,
            );
            const repaired = readCurrentStrict();
            notifyRecovery({
              kind: "repaired",
              path,
              revision: repaired.file.revision,
              reason: `Recovered a revisionless snapshot from segment revision ${firstSegment.revision}.`,
            });
            return repaired;
          }
        } catch (recoveryError) {
          if (recoveryError instanceof TelegramUpdateJournalError) {
            if (recoveryError.code !== "invalid") throw recoveryError;
          } else if (!(recoveryError instanceof SyntaxError)) {
            throw recoveryError;
          }
          // Only known schema/JSON corruption may fall through to reset.
        }
      }

      const recoveryDirectory = join(
        dirname(path),
        "recovery",
        `${getNowMs()}-${process.pid}-${randomUUID()}`,
      );
      mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
      const snapshotQuarantinePath = join(recoveryDirectory, basename(path));
      const segmentQuarantinePath = join(
        recoveryDirectory,
        basename(segmentDirectory),
      );
      if (
        snapshotExists &&
        !renameTelegramPathWithRetry(path, snapshotQuarantinePath)
      ) {
        throw createJournalError(
          "io",
          path,
          "could not quarantine an unrecoverable journal snapshot",
          error,
        );
      }
      if (!renameTelegramPathWithRetry(segmentDirectory, segmentQuarantinePath)) {
        if (snapshotExists) {
          renameTelegramPathWithRetry(snapshotQuarantinePath, path);
        }
        throw createJournalError(
          "io",
          segmentDirectory,
          "could not quarantine an unrecoverable journal segment history",
          error,
        );
      }
      const reset = emptyFile();
      const serialized = serializeJournalFile(reset);
      const serializedBytes = assertCapacity(reset, serialized);
      try {
        writeJournalFile(path, serialized, onPublicationBoundary);
      } catch (publicationError) {
        const segmentsRestored = renameTelegramPathWithRetry(
          segmentQuarantinePath,
          segmentDirectory,
        );
        const snapshotRestored =
          !snapshotExists ||
          renameTelegramPathWithRetry(snapshotQuarantinePath, path);
        if (!segmentsRestored || !snapshotRestored) {
          throw createJournalError(
            "io",
            path,
            "reset publication failed after journal evidence was quarantined",
            publicationError,
          );
        }
        throw publicationError;
      }
      notifyRecovery({
        kind: "reset",
        path,
        quarantinePath: recoveryDirectory,
        reason: error.message,
      });
      return { file: reset, exists: true, serializedBytes };
    }
  };

  const runJournalTransaction = <T>(operation: (read: typeof readCurrent) => T): T => {
    try {
      // Acquire before the transaction helper can create parents or staging names.
      // The config continuation excludes participating writers through consumption.
      const source = sourceAccess ? acquireTelegramUpdateJournalFamily({
        ...sourceAccess, path, profile, botIdentity: expectedIdentity,
      }, version) : undefined;
      const readSource = (): ReadTelegramUpdateJournalResult => {
        if (!source) return readCurrent();
        const file = source.evidence.kind === "present" ? source.evidence.file : emptyFile();
        return { file, exists: source.evidence.kind === "present",
          serializedBytes: assertCapacity(file), source };
      };
      return withTelegramFileTransaction(`${path}.transaction`, () => operation(readSource));
    } catch (error) {
      if (error instanceof TelegramUpdateJournalError) throw error;
      throw createJournalError("io", path, "mutation failed", error);
    }
  };

  const runMutationCore = <T>(operation: (read: typeof readCurrent) => T): T =>
    withSourceSerialization
      ? withSourceSerialization(() => runJournalTransaction(operation))
      : runJournalTransaction(operation);
  const runMutation = <T>(operation: (read: typeof readCurrent) => T): T =>
    options.withWriterAdmission
      ? options.withWriterAdmission(() => runMutationCore(operation))
      : runMutationCore(operation);

  const assertSourceResources = (files: number, bytes: number, work: number,
    collections: readonly number[]): void => {
    if (!sourceAccess) return;
    const limits = sourceAccess.limits;
    if (files > limits.maxFiles || bytes > limits.maxBytes || work > limits.maxWork ||
        collections.some((length) => length > limits.maxEntries)) {
      throw createJournalError("capacity", path, "publication would exceed source inspection resource limits");
    }
  };

  type InputHeadroomState = { file: TelegramUpdateJournalFile; projectionSlack: number };
  const inputHeadroomText = "\0".repeat(TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH);
  const inputBindingHeadroomText = "\0".repeat(TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH);
  const inputHandoffHeadroomText = "\0".repeat(TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_ID_MAX_LENGTH);
  const getFileWork = (file: TelegramUpdateJournalFile): number =>
    file.entries.length + (file.operatorDispositions?.length ?? 0);
  const advanceInputHeadroomState = (state: InputHeadroomState,
    entries: TelegramUpdateJournalEntry[], projectionSlack: number): InputHeadroomState => {
    const revision = (state.file.revision ?? 0) + 1;
    if (!isSafePositiveInteger(revision)) throw createJournalError("capacity", path, "exhausted input custody revisions");
    return { file: { ...state.file, revision, entries }, projectionSlack };
  };
  const replaceInputHeadroomEntry = (file: TelegramUpdateJournalFile, updateId: number,
    replacement?: TelegramUpdateJournalEntry): TelegramUpdateJournalEntry[] => file.entries.flatMap(entry =>
      entry.updateId === updateId ? (replacement ? [replacement] : []) : [entry]);
  const createInputHeadroomClaim = (entry: TelegramUpdateJournalEntry,
    phase: TelegramUpdateJournalInputClaim["phase"]): TelegramUpdateJournalInputClaim => ({
    phase,
    owner: { instanceId: inputHeadroomText, processId: Number.MAX_SAFE_INTEGER,
      processBirthId: inputHeadroomText, sessionGeneration: Number.MAX_SAFE_INTEGER,
      acquisitionId: inputHeadroomText, acquiredAtMs: Number.MAX_SAFE_INTEGER,
      handoffId: inputHandoffHeadroomText },
    recipientBindingKey: inputBindingHeadroomText,
    executionUpdate: structuredClone(entry.update),
  });
  const largestInputHeadroomEntry = (entries: TelegramUpdateJournalEntry[],
    project: (entry: TelegramUpdateJournalEntry) => TelegramUpdateJournalEntry) => entries.reduce<
      { entry: TelegramUpdateJournalEntry; bytes: number } | undefined
    >((selected, entry) => {
      const bytes = Buffer.byteLength(JSON.stringify(project(entry), null, 2));
      return !selected || bytes > selected.bytes ? { entry, bytes } : selected;
    }, undefined)?.entry;
  const smallestInputHeadroomEntry = (entries: TelegramUpdateJournalEntry[]) => entries.reduce<
    { entry: TelegramUpdateJournalEntry; bytes: number } | undefined
  >((selected, entry) => {
    const bytes = Buffer.byteLength(JSON.stringify(entry, null, 2));
    return !selected || bytes < selected.bytes ? { entry, bytes } : selected;
  }, undefined)?.entry;
  const createInputHeadroomTransitionPlan = (file: TelegramUpdateJournalFile,
    entry: TelegramUpdateJournalEntry): InputHeadroomState[] => {
    const initial: InputHeadroomState = { file, projectionSlack: 0 };
    if (entry.inputClaim?.phase === "running") return [advanceInputHeadroomState(initial,
      replaceInputHeadroomEntry(file, entry.updateId), TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES)];
    if (entry.state === "pending" && entry.inputClaim?.phase === "ready" && entry.inputClaim.handoff) {
      const acceptedClaim = { ...entry.inputClaim,
        owner: { ...entry.inputClaim.handoff.recipientOwner, acquisitionId: inputHeadroomText,
          acquiredAtMs: Number.MAX_SAFE_INTEGER, handoffId: inputHandoffHeadroomText } };
      delete acceptedClaim.handoff;
      const acceptedEntry = { ...entry, inputClaim: acceptedClaim };
      const acceptedState = advanceInputHeadroomState(initial,
        replaceInputHeadroomEntry(file, entry.updateId, acceptedEntry),
        TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
      return [acceptedState, ...createInputHeadroomTransitionPlan(acceptedState.file, acceptedEntry)];
    }
    if (entry.state === "pending" && entry.inputClaim?.phase === "ready") {
      const runningEntry = { ...entry, inputClaim: { ...entry.inputClaim, phase: "running" as const } };
      const runningState = advanceInputHeadroomState(initial,
        replaceInputHeadroomEntry(file, entry.updateId, runningEntry),
        TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
      return [runningState, advanceInputHeadroomState(runningState,
        replaceInputHeadroomEntry(runningState.file, entry.updateId),
        TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES)];
    }
    if (entry.state === "pending" && entry.preApprovalExcluded === false && !entry.inputClaim) {
      const readyEntry = { ...entry, inputClaim: createInputHeadroomClaim(entry, "ready") };
      const readyState = advanceInputHeadroomState(initial,
        replaceInputHeadroomEntry(file, entry.updateId, readyEntry),
        TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES);
      const runningEntry = { ...readyEntry, inputClaim: { ...readyEntry.inputClaim, phase: "running" as const } };
      const runningState = advanceInputHeadroomState(readyState,
        replaceInputHeadroomEntry(readyState.file, entry.updateId, runningEntry),
        TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES);
      return [readyState, runningState, advanceInputHeadroomState(runningState,
        replaceInputHeadroomEntry(runningState.file, entry.updateId),
        TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES)];
    }
    return entry.preApprovalExcluded === true ? [advanceInputHeadroomState(initial,
      replaceInputHeadroomEntry(file, entry.updateId),
      TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES)] : [];
  };
  const createInputHeadroomCancelPlan = (file: TelegramUpdateJournalFile,
    entry: TelegramUpdateJournalEntry): InputHeadroomState[] => {
    if (!entry.inputClaim?.handoff) return [];
    const claim = structuredClone(entry.inputClaim);
    delete claim.handoff;
    const cancelledEntry = { ...entry, inputClaim: claim };
    const initial: InputHeadroomState = { file, projectionSlack: 0 };
    const cancelledState = advanceInputHeadroomState(initial,
      replaceInputHeadroomEntry(file, entry.updateId, cancelledEntry),
      TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
    return [cancelledState, ...createInputHeadroomTransitionPlan(cancelledState.file, cancelledEntry)];
  };
  const createInputHeadroomReleasePlan = (file: TelegramUpdateJournalFile,
    entry: TelegramUpdateJournalEntry, allowOffered = false): InputHeadroomState[] => {
    if (entry.inputClaim?.handoff && !allowOffered) return [];
    const normal = createInputHeadroomTransitionPlan(file, entry);
    const readyState = entry.inputClaim?.phase === "ready" ? { file, projectionSlack: 0 } : normal[0];
    if (!readyState) return [];
    const readyEntry = readyState.file.entries.find(candidate => candidate.updateId === entry.updateId);
    if (readyEntry?.inputClaim?.phase !== "ready") return [];
    const releasedEntry = cloneEntry(readyEntry);
    delete releasedEntry.inputClaim;
    const releasedState = advanceInputHeadroomState(readyState,
      replaceInputHeadroomEntry(readyState.file, entry.updateId, releasedEntry),
      TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES);
    const reacquisition = createInputHeadroomTransitionPlan(releasedState.file, releasedEntry);
    return [...(readyState.file === file ? [] : [readyState]), releasedState, ...reacquisition];
  };
  const createInputHeadroomQueueCompletionPlan = (file: TelegramUpdateJournalFile,
    entries: TelegramUpdateJournalEntry[]): InputHeadroomState[] => {
    if (entries.length === 0 || entries.some(entry => entry.state !== "queued" || entry.queueHandoff)) return [];
    const requestedIds = new Set(entries.map(entry => entry.updateId));
    const initial: InputHeadroomState = { file, projectionSlack: 0 };
    return [advanceInputHeadroomState(initial,
      file.entries.filter(entry => !requestedIds.has(entry.updateId)),
      TELEGRAM_UPDATE_JOURNAL_INPUT_TRANSITION_HEADROOM_BYTES)];
  };
  const getInputHeadroomTransitionPlans = (file: TelegramUpdateJournalFile,
    updateId: number | readonly number[] | "all"): InputHeadroomState[][] => {
    if (updateId !== "all") {
      const requestedIds = new Set<number>(typeof updateId === "number" ? [updateId] : [...updateId]);
      const requestedEntries = file.entries.filter(entry => requestedIds.has(entry.updateId));
      const queuedReceiptId = requestedEntries[0]?.queueReceiptId;
      if (requestedEntries.length === requestedIds.size && queuedReceiptId &&
          requestedEntries.every(entry => entry.state === "queued" &&
            entry.queueReceiptId === queuedReceiptId) &&
          file.entries.filter(entry => entry.queueReceiptId === queuedReceiptId).length === requestedIds.size) {
        const completion = createInputHeadroomQueueCompletionPlan(file, requestedEntries);
        return completion.length > 0 ? [completion] : [];
      }
      if (typeof updateId !== "number") return [];
      const entry = requestedEntries[0];
      const plan = entry ? createInputHeadroomTransitionPlan(file, entry) : [];
      const cancel = entry ? createInputHeadroomCancelPlan(file, entry) : [];
      const recover = entry?.inputClaim?.handoff
        ? createInputHeadroomReleasePlan(file, entry, true) : [];
      return [plan, cancel, recover].filter(candidate => candidate.length > 0);
    }
    const running = smallestInputHeadroomEntry(file.entries.filter(entry =>
      entry.inputClaim?.phase === "running"));
    const offered = largestInputHeadroomEntry(file.entries.filter(entry =>
      entry.state === "pending" && entry.inputClaim?.phase === "ready" && entry.inputClaim.handoff), entry =>
      ({ ...entry, inputClaim: { ...entry.inputClaim!, owner: {
        ...entry.inputClaim!.handoff!.recipientOwner, acquisitionId: inputHeadroomText,
        acquiredAtMs: Number.MAX_SAFE_INTEGER, handoffId: inputHandoffHeadroomText }, handoff: undefined } }));
    const ready = largestInputHeadroomEntry(file.entries.filter(entry =>
      entry.state === "pending" && entry.inputClaim?.phase === "ready" && !entry.inputClaim.handoff), entry =>
      ({ ...entry, inputClaim: { ...entry.inputClaim!, phase: "running" as const } }));
    const unclaimed = largestInputHeadroomEntry(file.entries.filter(entry =>
      entry.state === "pending" && entry.preApprovalExcluded === false && !entry.inputClaim), entry =>
      ({ ...entry, inputClaim: createInputHeadroomClaim(entry, "running") }));
    const excluded = smallestInputHeadroomEntry(file.entries.filter(entry =>
      entry.preApprovalExcluded === true));
    const representatives = [running, offered, ready, unclaimed, excluded].filter(
      (entry): entry is TelegramUpdateJournalEntry => entry !== undefined);
    const plans = representatives.map(entry => createInputHeadroomTransitionPlan(file, entry));
    if (offered) {
      plans.push(createInputHeadroomCancelPlan(file, offered));
      plans.push(createInputHeadroomReleasePlan(file, offered, true));
    }
    for (const entry of [ready, unclaimed]) {
      if (entry) plans.push(createInputHeadroomReleasePlan(file, entry));
    }
    const queuedReceipts = new Map<string, TelegramUpdateJournalEntry[]>();
    for (const entry of file.entries) {
      if (entry.state !== "queued" || !entry.queueReceiptId || entry.queueHandoff) continue;
      const grouped = queuedReceipts.get(entry.queueReceiptId) ?? [];
      grouped.push(entry);
      queuedReceipts.set(entry.queueReceiptId, grouped);
    }
    for (const entries of queuedReceipts.values()) {
      const completion = createInputHeadroomQueueCompletionPlan(file, entries);
      if (completion.length > 0) plans.push(completion);
    }
    return plans;
  };
  const createInputHeadroomSegment = (
    previous: TelegramUpdateJournalFile, next: TelegramUpdateJournalFile,
  ): TelegramUpdateJournalSegment => {
    const previousEntries = new Map(previous.entries.map(entry => [entry.updateId, entry]));
    const nextEntries = new Map(next.entries.map(entry => [entry.updateId, entry]));
    return { version: TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION,
      revision: next.revision!, previousRevision: next.revision! - 1,
      profile: next.profile, botIdentity: next.botIdentity,
      upsertedEntries: next.entries.filter(entry =>
        !previousEntries.has(entry.updateId) || !isDeepStrictEqual(previousEntries.get(entry.updateId), entry)),
      removedUpdateIds: previous.entries.filter(entry => !nextEntries.has(entry.updateId)).map(entry => entry.updateId),
      ...(next.acceptedThroughUpdateId !== undefined ? { acceptedThroughUpdateId: next.acceptedThroughUpdateId } : {}) };
  };
  const assertInputHeadroomCapacity = (file: TelegramUpdateJournalFile, extraBytes: number): number => {
    const bytes = assertCapacity(file);
    if (bytes > maxBytes - extraBytes) {
      throw createJournalError("capacity", path, "does not retain logical input transition headroom");
    }
    return bytes + extraBytes;
  };
  const assertInputProgressHeadroom = (current: ReadTelegramUpdateJournalResult,
    publishedFile: TelegramUpdateJournalFile, updateId: number | readonly number[] | "all",
    publishedSegment?: TelegramUpdateJournalSegment): void => {
    const plans = getInputHeadroomTransitionPlans(publishedFile, updateId);
    if (plans.length === 0) return;
    const sourceSegments = current.source?.segments ?? [];
    let baseRetainedCount = sourceSegments.length;
    let baseRetainedBytes = sourceSegments.reduce((sum, segment) => sum + segment.bytes, 0);
    let baseRetainedWork = sourceSegments.reduce((sum, segment) => sum + segment.work, 0);
    const publishedBytes = assertInputHeadroomCapacity(publishedFile, 0);
    let baseAccounting = current.source?.evidence.kind === "present"
      ? { ...current.source.evidence.accounting }
      : { files: 1, bytes: publishedBytes, work: getFileWork(publishedFile) };
    if (publishedSegment) {
      const segmentWork = publishedSegment.upsertedEntries.length + publishedSegment.removedUpdateIds.length +
        (publishedSegment.operatorDispositions?.length ?? 0);
      const segmentBytes = Buffer.byteLength(`${JSON.stringify(publishedSegment, null, 2)}\n`);
      baseRetainedCount += 1;
      baseRetainedBytes += segmentBytes;
      baseRetainedWork += segmentWork;
      const segmentFirst = { files: baseAccounting.files + 1, bytes: baseAccounting.bytes + segmentBytes,
        work: baseAccounting.work + segmentWork + getFileWork(publishedFile) };
      const compactResidue = { files: 1 + baseRetainedCount,
        bytes: publishedBytes + baseRetainedBytes, work: getFileWork(publishedFile) + baseRetainedWork };
      baseAccounting = { files: Math.max(segmentFirst.files, compactResidue.files),
        bytes: Math.max(segmentFirst.bytes, compactResidue.bytes),
        work: Math.max(segmentFirst.work, compactResidue.work) };
    }
    for (const transitions of plans) {
      let retainedCount = baseRetainedCount;
      let retainedBytes = baseRetainedBytes;
      let retainedWork = baseRetainedWork;
      let accounting = { ...baseAccounting };
      let state: InputHeadroomState = { file: publishedFile, projectionSlack: 0 };
      for (const next of transitions) {
        const segment = createInputHeadroomSegment(state.file, next.file);
        const segmentCollections = [segment.upsertedEntries.length, segment.removedUpdateIds.length,
          segment.operatorDispositions?.length ?? 0, next.file.entries.length,
          next.file.operatorDispositions?.length ?? 0];
        const segmentWork = segmentCollections[0]! + segmentCollections[1]! + segmentCollections[2]!;
        const segmentBytes = Buffer.byteLength(`${JSON.stringify(segment, null, 2)}\n`) + next.projectionSlack;
        const nextBytes = assertInputHeadroomCapacity(next.file, next.projectionSlack);
        const segmentFirst = { files: accounting.files + 1, bytes: accounting.bytes + segmentBytes,
          work: accounting.work + segmentWork + getFileWork(next.file) };
        assertSourceResources(segmentFirst.files, segmentFirst.bytes, segmentFirst.work, segmentCollections);
        retainedCount += 1;
        retainedBytes += segmentBytes;
        retainedWork += segmentWork;
        const compactResidue = { files: 1 + retainedCount, bytes: nextBytes + retainedBytes,
          work: getFileWork(next.file) + retainedWork };
        assertSourceResources(compactResidue.files, compactResidue.bytes, compactResidue.work, segmentCollections);
        accounting = { files: Math.max(segmentFirst.files, compactResidue.files),
          bytes: Math.max(segmentFirst.bytes, compactResidue.bytes),
          work: Math.max(segmentFirst.work, compactResidue.work) };
        state = next;
      }
    }
  };

  const publishSourceSegment = (
    current: ReadTelegramUpdateJournalResult,
    file: TelegramUpdateJournalFile,
    segment: TelegramUpdateJournalSegment,
    publicationBoundary: TelegramUpdateJournalStoreOptions["onPublicationBoundary"],
    forceCompact: boolean,
  ): { file: TelegramUpdateJournalFile; serializedBytes: number } => {
    const source = current.source!;
    if (source.evidence.kind !== "present") throw createJournalError("invalid", path, "requires existing source evidence");
    const revisedFile = { ...file, revision: segment.revision };
    const serialized = serializeJournalFile(revisedFile);
    const serializedBytes = assertCapacity(revisedFile, serialized);
    const segmentText = `${JSON.stringify(segment, null, 2)}\n`;
    const segmentBytes = Buffer.byteLength(segmentText);
    const collections = [segment.upsertedEntries.length, segment.removedUpdateIds.length,
      segment.operatorDispositions?.length ?? 0, file.entries.length, file.operatorDispositions?.length ?? 0];
    const segmentWork = collections[0]! + collections[1]! + collections[2]!;
    const fileWork = collections[3]! + collections[4]!;
    const accounting = source.evidence.accounting;
    // Both the segment-first state and snapshot-first cleanup residue must fit.
    assertSourceResources(accounting.files + 1, accounting.bytes + segmentBytes,
      accounting.work + segmentWork + fileWork, collections);
    const unapplied = source.segments.filter((item) => Number(item.name.slice(0, 16)) > source.snapshotRevision);
    const compact = forceCompact ||
      unapplied.length + 1 >= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT ||
      unapplied.reduce((sum, item) => sum + item.bytes, segmentBytes) >= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES;
    if (compact) {
      assertSourceResources(accounting.files + 1,
        serializedBytes + source.segments.reduce((sum, item) => sum + item.bytes, segmentBytes),
        fileWork + source.segments.reduce((sum, item) => sum + item.work, segmentWork), collections);
    }
    const segmentPath = getTelegramUpdateJournalSegmentPath(path, segment.revision);
    // A crash may retain staging, so keep it outside the strictly enumerated segment directory.
    writeJournalFile(segmentPath, segmentText, publicationBoundary, path);
    if (compact) {
      writeJournalFile(path, serialized, publicationBoundary);
      // Snapshot scope must not change. Preserve a validated redundant ID witness instead.
      const witness = file.botIdentity.botId === undefined
        ? source.segments.find((item) => item.botId !== undefined)?.name : undefined;
      const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
      const names = [...source.segments.map((item) => item.name), basename(segmentPath)];
      for (const name of names) {
        if (name === witness) continue;
        try { unlinkSync(join(segmentDirectory, name)); } catch {
          // Every subset of redundant cleanup residue was admitted above.
        }
      }
      try { rmdirSync(segmentDirectory); } catch { /* Retained witness or cleanup residue. */ }
    }
    return { file: revisedFile, serializedBytes };
  };

  const publishMutation = (
    current: ReadTelegramUpdateJournalResult,
    entries: TelegramUpdateJournalEntry[],
    contentChanged: boolean,
    operatorDispositions = current.file.operatorDispositions,
    acceptedThroughUpdateId = current.file.acceptedThroughUpdateId,
    publicationBoundary = onPublicationBoundary,
    inputHeadroom: number | readonly number[] | "all" | false =
      version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION ? "all" : false,
  ): { file: TelegramUpdateJournalFile; serializedBytes: number } => {
    const botIdentity = current.source ? current.file.botIdentity : mergeBotIdentity(
      current.file.botIdentity,
      expectedIdentity,
    );
    if (
      !contentChanged &&
      isDeepStrictEqual(current.file.botIdentity, botIdentity) &&
      isDeepStrictEqual(
        current.file.operatorDispositions ?? [],
        operatorDispositions ?? [],
      ) &&
      current.file.acceptedThroughUpdateId === acceptedThroughUpdateId
    ) {
      return { file: current.file, serializedBytes: current.serializedBytes };
    }
    const file: TelegramUpdateJournalFile = {
      version,
      profile,
      botIdentity,
      entries,
      ...(acceptedThroughUpdateId !== undefined
        ? { acceptedThroughUpdateId }
        : {}),
      ...(operatorDispositions?.length
        ? { operatorDispositions }
        : {}),
    };
    if (withPairingAdmission || current.source) parseJournalFile(file, path, version);
    const serialized = serializeJournalFile(file);
    const serializedBytes = assertCapacity(file, serialized);
    const changed =
      contentChanged ||
      current.file.acceptedThroughUpdateId !== acceptedThroughUpdateId ||
      !isDeepStrictEqual(current.file.botIdentity, file.botIdentity);
    if (!changed) {
      return { file, serializedBytes: current.serializedBytes };
    }
    if (!current.exists) {
      if (current.source) {
        const collections = [file.entries.length, file.operatorDispositions?.length ?? 0];
        assertSourceResources(1, serializedBytes, collections[0]! + collections[1]!, collections);
      }
      if (inputHeadroom !== false) assertInputProgressHeadroom(current, file, inputHeadroom);
      writeJournalFile(path, serialized, publicationBoundary);
      return { file, serializedBytes };
    }
    const previousEntries = new Map(
      current.file.entries.map((entry) => [entry.updateId, entry]),
    );
    if (withPairingAdmission && entries.some((entry) => {
      const previous = previousEntries.get(entry.updateId);
      return previous && previous.preApprovalExcluded !== entry.preApprovalExcluded;
    })) {
      throw createJournalError("pairing-evidence", path, "changes immutable exclusion evidence");
    }
    const nextEntries = new Map(entries.map((entry) => [entry.updateId, entry]));
    const upsertedEntries = entries.filter(
      (entry) =>
        !previousEntries.has(entry.updateId) ||
        !isDeepStrictEqual(previousEntries.get(entry.updateId), entry),
    );
    const removedUpdateIds = current.file.entries
      .filter((entry) => !nextEntries.has(entry.updateId))
      .map((entry) => entry.updateId);
    const revision = (current.file.revision ?? 0) + 1;
    const segment: TelegramUpdateJournalSegment = {
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
      ...(!isDeepStrictEqual(
        current.file.operatorDispositions ?? [],
        operatorDispositions ?? [],
      )
        ? { operatorDispositions: operatorDispositions ?? [] }
        : {}),
    };
    if (current.source) {
      if (!isSafePositiveInteger(revision)) throw createJournalError("capacity", path, "exhausted source revisions");
      const revisedFile = { ...file, revision };
      if (inputHeadroom !== false) assertInputProgressHeadroom(current, revisedFile, inputHeadroom, segment);
      return publishSourceSegment(current, file, segment, publicationBoundary,
        version === TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION);
    }
    publishTelegramUpdateJournalSegmentUnlocked(path, segment, publicationBoundary);
    const revisedFile: TelegramUpdateJournalFile = { ...file, revision };
    const segmentDirectory = getTelegramUpdateJournalSegmentDirectory(path);
    const segmentNames = readdirSync(segmentDirectory).filter((name) =>
      /^\d{16}\.json$/u.test(name),
    );
    let snapshotRevision = 0;
    try {
      snapshotRevision = parseJournalFile(
        JSON.parse(readFileSync(path, "utf8")) as unknown,
        path,
        version,
      ).revision ?? 0;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ENOENT") throw error;
    }
    const unappliedSegmentNames = segmentNames.filter(
      (name) => Number(name.slice(0, 16)) > snapshotRevision,
    );
    const segmentBytes = unappliedSegmentNames.reduce(
      (total, name) => total + statSync(join(segmentDirectory, name)).size,
      0,
    );
    if (
      unappliedSegmentNames.length >=
        TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_COUNT ||
      segmentBytes >= TELEGRAM_UPDATE_JOURNAL_COMPACTION_SEGMENT_BYTES
    ) {
      const compacted = serializeJournalFile(revisedFile);
      const compactedBytes = assertCapacity(revisedFile, compacted);
      writeJournalFile(path, compacted, publicationBoundary);
      for (const name of segmentNames) {
        if (Number(name.slice(0, 16)) <= revision) {
          try {
            unlinkSync(join(segmentDirectory, name));
          } catch {
            // The published snapshot already owns this revision; redundant
            // segments are safe and will be ignored on reconstruction.
          }
        }
      }
      try {
        rmdirSync(segmentDirectory);
      } catch {
        // Interrupted cleanup may leave an empty directory or old segments.
      }
      return { file: revisedFile, serializedBytes: compactedBytes };
    }
    return { file: revisedFile, serializedBytes };
  };

  const journal: TelegramUpdateJournalStore = {
    read() {
      return runMutation((readCurrent) => {
        const current = readCurrent();
        return {
          ...cloneFile(current.file),
          exists: current.exists,
          serializedBytes: current.serializedBytes,
        };
      });
    },
    appendBatch(updates, requestedAcceptedThroughUpdateId) {
      const canonicalUpdates = updates.map((update) => normalizeIncomingJournaledUpdate(update, path));
      const normalizedUpdates: TelegramJournaledUpdate[] = [];
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
      const appendWithEvidence = (preApprovalExcluded?: boolean) => runJournalTransaction((readCurrent) => {
        if (withPairingAdmission && (typeof preApprovalExcluded !== "boolean" || requestedAcceptedThroughUpdateId === undefined)) {
          throw createJournalError("pairing-evidence", path, "requires exclusion evidence and an admission cursor");
        }
        if (
          requestedAcceptedThroughUpdateId !== undefined &&
          !isSafeNonNegativeInteger(requestedAcceptedThroughUpdateId)
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received an invalid admission cursor",
          );
        }
        const current = readCurrent();
        const entriesById = new Map(
          current.file.entries.map((entry) => [entry.updateId, entry]),
        );
        const previousAcceptedThroughUpdateId =
          current.file.acceptedThroughUpdateId;
        const discardedUpdateIds = new Set(
          (current.file.operatorDispositions ?? [])
            .filter((disposition) => disposition.action === "discard")
            .map((disposition) => disposition.updateId),
        );
        let admittedAtMs: number | undefined;
        const addedUpdateIds: number[] = [];
        const duplicateUpdateIds: number[] = [];
        for (const update of normalizedUpdates) {
          if (discardedUpdateIds.has(update.update_id)) {
            duplicateUpdateIds.push(update.update_id);
            continue;
          }
          const existing = entriesById.get(update.update_id);
          if (existing) {
            if (!isDeepStrictEqual(existing.update, update)) {
              throw createJournalError(
                "conflict",
                path,
                `received conflicting update ${update.update_id}`,
              );
            }
            duplicateUpdateIds.push(update.update_id);
            continue;
          }
          if (withPairingAdmission && previousAcceptedThroughUpdateId !== undefined && update.update_id <= previousAcceptedThroughUpdateId) {
            duplicateUpdateIds.push(update.update_id);
            continue;
          }
          if (admittedAtMs === undefined) {
            admittedAtMs = getNowMs();
            if (!isSafeNonNegativeInteger(admittedAtMs)) {
              throw createJournalError(
                "invalid",
                path,
                "received an invalid admission timestamp",
              );
            }
          }
          const entry: TelegramUpdateJournalEntry = {
            updateId: update.update_id,
            update,
            ...(withPairingAdmission ? { preApprovalExcluded: preApprovalExcluded! } : {}),
            admittedAtMs,
            state: "pending",
          };
          entriesById.set(entry.updateId, entry);
          addedUpdateIds.push(entry.updateId);
        }

        const batchLastUpdateId = normalizedUpdates.at(-1)?.update_id;
        if (
          requestedAcceptedThroughUpdateId !== undefined &&
          batchLastUpdateId !== undefined &&
          requestedAcceptedThroughUpdateId < batchLastUpdateId
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received an admission cursor behind its batch",
          );
        }
        if (
          requestedAcceptedThroughUpdateId !== undefined &&
          previousAcceptedThroughUpdateId !== undefined &&
          requestedAcceptedThroughUpdateId < previousAcceptedThroughUpdateId
        ) {
          throw createJournalError(
            "conflict",
            path,
            "received a regressing admission cursor",
          );
        }
        const acceptedThroughUpdateId =
          requestedAcceptedThroughUpdateId ?? previousAcceptedThroughUpdateId;
        const contentChanged = addedUpdateIds.length > 0;
        const published = publishMutation(
          current,
          contentChanged
            ? Array.from(entriesById.values()).sort(
                (left, right) => left.updateId - right.updateId,
              )
            : current.file.entries,
          contentChanged,
          current.file.operatorDispositions,
          acceptedThroughUpdateId,
        );
        return {
          nonExcludedUpdateIds: normalizedUpdates.flatMap((update) => {
            const entry = entriesById.get(update.update_id);
            return entry && entry.preApprovalExcluded !== true ? [entry.updateId] : [];
          }),
          addedUpdateIds,
          duplicateUpdateIds,
          entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes,
        };
      });
      const append = () => {
        if (withPairedAdmission) {
          const result = withPairedAdmission(normalizedUpdates, () => appendWithEvidence());
          if (!result.admitted) throw createJournalError("sender-denied", path, "refused paired-only sender admission");
          return result.value;
        }
        if (withPairingAdmission) return withPairingAdmission(appendWithEvidence);
        return withSourceSerialization
          ? withSourceSerialization(() => appendWithEvidence())
          : appendWithEvidence();
      };
      const admittedAppend = () => {
        if (!workspaceAdmission) return append();
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
        ? options.withWriterAdmission(admittedAppend) : admittedAppend();
    },
    markQueued(receipt) {
      return runMutation((readCurrent) => {
        if (
          (receipt.queueKind !== "prompt" &&
            receipt.queueKind !== "control") ||
          !isNonEmptyString(receipt.receiptId) ||
          !Array.isArray(receipt.sourceUpdateIds) ||
          receipt.sourceUpdateIds.length === 0
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received an invalid queue receipt",
          );
        }
        const requestedOwner = validateJournalQueueOwnerIdentity(
          receipt.owner,
          path,
        );
        if (
          queueRuntimeIdentity &&
          (requestedOwner.instanceId !== queueRuntimeIdentity.instanceId ||
            requestedOwner.processId !== queueRuntimeIdentity.processId ||
            requestedOwner.processBirthId !==
              queueRuntimeIdentity.processBirthId)
        ) {
          throw createJournalError(
            "conflict",
            path,
            "cannot acquire a queue receipt for another runtime process generation",
          );
        }
        const requestedIds = new Set<number>();
        for (const updateId of receipt.sourceUpdateIds) {
          if (
            !isSafeNonNegativeInteger(updateId) ||
            requestedIds.has(updateId)
          ) {
            throw createJournalError(
              "invalid",
              path,
              "received invalid or duplicate queue receipt update ids",
            );
          }
          requestedIds.add(updateId);
        }
        const current = readCurrent();
        const existingReceiptEntries: TelegramUpdateJournalEntry[] = [];
        const entriesById = new Map<number, TelegramUpdateJournalEntry>();
        for (const entry of current.file.entries) {
          entriesById.set(entry.updateId, entry);
          if (entry.queueReceiptId === receipt.receiptId) {
            existingReceiptEntries.push(entry);
          }
        }
        const existingReceiptIds = new Set(
          existingReceiptEntries.map((entry) => entry.updateId),
        );
        if (
          existingReceiptIds.size > 0 &&
          (existingReceiptIds.size !== requestedIds.size ||
            [...existingReceiptIds].some(
              (updateId) => !requestedIds.has(updateId),
            ))
        ) {
          throw createJournalError(
            "conflict",
            path,
            `has a conflicting queue receipt ${receipt.receiptId}`,
          );
        }
        let queueOwner = existingReceiptEntries[0]?.queueOwner;
        if (existingReceiptEntries.length === 0) {
          const acquiredAtMs = getNowMs();
          if (!isSafeNonNegativeInteger(acquiredAtMs)) {
            throw createJournalError(
              "invalid",
              path,
              "received an invalid queue acquisition timestamp",
            );
          }
          queueOwner = {
            ...requestedOwner,
            acquisitionId: randomUUID(),
            acquiredAtMs,
          };
        }
        const queuedUpdateIds: number[] = [];
        const duplicateUpdateIds: number[] = [];
        for (const updateId of receipt.sourceUpdateIds) {
          const entry = entriesById.get(updateId);
          if (!entry) {
            throw createJournalError(
              "conflict",
              path,
              `cannot queue missing update ${updateId}`,
            );
          }
          if (entry.preApprovalExcluded) {
            throw createJournalError("pairing-evidence", path, `cannot queue excluded update ${updateId}`);
          }
          if (entry.state === "queued") {
            if (
              entry.queueKind !== receipt.queueKind ||
              entry.queueReceiptId !== receipt.receiptId
            ) {
              throw createJournalError(
                "conflict",
                path,
                `update ${updateId} belongs to another queue receipt`,
              );
            }
            duplicateUpdateIds.push(updateId);
            continue;
          }
          if (entry.state === "failed") {
            throw createJournalError(
              "conflict",
              path,
              `cannot queue failed update ${updateId}`,
            );
          }
          entriesById.set(updateId, {
            updateId: entry.updateId,
            update: entry.update,
            admittedAtMs: entry.admittedAtMs,
            ...(entry.preApprovalExcluded !== undefined ? { preApprovalExcluded: entry.preApprovalExcluded } : {}),
            state: "queued",
            queueKind: receipt.queueKind,
            queueReceiptId: receipt.receiptId,
            queueOwner: cloneJournalQueueOwner(queueOwner!),
          });
          queuedUpdateIds.push(updateId);
        }
        const contentChanged = queuedUpdateIds.length > 0;
        const published = publishMutation(
          current,
          contentChanged
            ? current.file.entries.map(
                (entry) => entriesById.get(entry.updateId)!,
              )
            : current.file.entries,
          contentChanged,
        );
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
        if (
          !isSafeNonNegativeInteger(input.updateId) ||
          !isSafeNonNegativeInteger(input.expectedAttemptCount) ||
          !isSafeNonNegativeInteger(input.failedAtMs) ||
          !isBoundedString(
            input.failureClass,
            TELEGRAM_UPDATE_JOURNAL_FAILURE_CLASS_MAX_LENGTH,
          ) ||
          !isBoundedString(
            input.summary,
            TELEGRAM_UPDATE_JOURNAL_FAILURE_SUMMARY_MAX_LENGTH,
          ) ||
          (input.disposition !== "retry-wait" &&
            input.disposition !== "failed")
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received invalid execution failure metadata",
          );
        }
        if (
          input.disposition === "retry-wait" &&
          (!isSafeNonNegativeInteger(input.nextRetryAtMs) ||
            input.nextRetryAtMs < input.failedAtMs ||
            input.terminalReason !== undefined)
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received invalid retry-wait disposition",
          );
        }
        if (
          input.disposition === "failed" &&
          (!isBoundedString(
            input.terminalReason,
            TELEGRAM_UPDATE_JOURNAL_TERMINAL_REASON_MAX_LENGTH,
          ) ||
            input.nextRetryAtMs !== undefined)
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received invalid terminal failure disposition",
          );
        }
        const current = readCurrent();
        const entry = current.file.entries.find(
          (candidate) => candidate.updateId === input.updateId,
        );
        if (!entry) {
          throw createJournalError(
            "conflict",
            path,
            `cannot fail missing update ${input.updateId}`,
          );
        }
        if (entry.state !== "pending" && entry.state !== "retry-wait") {
          throw createJournalError(
            "conflict",
            path,
            `cannot fail ${entry.state} update ${input.updateId}`,
          );
        }
        const previousAttemptCount = entry.failure?.attemptCount ?? 0;
        if (previousAttemptCount !== input.expectedAttemptCount) {
          throw createJournalError(
            "conflict",
            path,
            `update ${input.updateId} execution attempt changed`,
          );
        }
        const failure: TelegramUpdateJournalFailure = {
          attemptCount: previousAttemptCount + 1,
          failedAtMs: input.failedAtMs,
          failureClass: input.failureClass,
          summary: input.summary,
        };
        const terminalFailureId =
          input.disposition === "failed"
            ? createTelegramUpdateTerminalFailureId({
                updateId: entry.updateId,
                attemptCount: failure.attemptCount,
                failedAtMs: failure.failedAtMs,
                failureClass: failure.failureClass,
                terminalAtMs: input.failedAtMs,
                terminalReason: input.terminalReason!,
              })
            : undefined;
        const nextEntry: TelegramUpdateJournalEntry = {
          updateId: entry.updateId,
          update: entry.update,
          admittedAtMs: entry.admittedAtMs,
          ...(entry.preApprovalExcluded !== undefined ? { preApprovalExcluded: entry.preApprovalExcluded } : {}),
          state: input.disposition,
          failure,
          ...(input.disposition === "retry-wait"
            ? { nextRetryAtMs: input.nextRetryAtMs! }
            : {
                terminalAtMs: input.failedAtMs,
                terminalReason: input.terminalReason!,
                terminalFailureId: terminalFailureId!,
              }),
        };
        const published = publishMutation(
          current,
          current.file.entries.map((candidate) =>
            candidate.updateId === input.updateId ? nextEntry : candidate,
          ),
          true,
        );
        return {
          entry: cloneEntry(nextEntry),
          entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes,
        };
      });
    },
    applyOperatorDisposition(input) {
      return runMutation((readCurrent) => {
        if (
          !isSafeNonNegativeInteger(input.updateId) ||
          !isBoundedString(
            input.failureId,
            TELEGRAM_UPDATE_JOURNAL_FAILURE_ID_MAX_LENGTH,
          ) ||
          (input.action !== "retry" && input.action !== "discard")
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received an invalid operator disposition",
          );
        }
        const current = readCurrent();
        const existingDisposition = current.file.operatorDispositions?.find(
          (candidate) => candidate.failureId === input.failureId,
        );
        if (existingDisposition) {
          if ("dispositionKind" in existingDisposition)
            throw createJournalError("conflict", path,
              `terminal failure ${input.failureId} collides with legacy custody authority`);
          if (
            existingDisposition.updateId !== input.updateId ||
            existingDisposition.action !== input.action
          ) {
            throw createJournalError(
              "conflict",
              path,
              `terminal failure ${input.failureId} already has another operator disposition`,
            );
          }
          return {
            disposition: { ...existingDisposition },
            duplicate: true,
            entryCount: current.file.entries.length,
            serializedBytes: current.serializedBytes,
          };
        }
        const entry = current.file.entries.find(
          (candidate) => candidate.updateId === input.updateId,
        );
        if (
          entry?.state !== "failed" ||
          !entry.failure ||
          entry.terminalAtMs === undefined ||
          !entry.terminalReason ||
          entry.terminalFailureId !== input.failureId
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot apply a stale disposition to terminal failure ${input.failureId}`,
          );
        }
        const nowMs = getNowMs();
        if (!isSafeNonNegativeInteger(nowMs)) {
          throw createJournalError(
            "invalid",
            path,
            "received an invalid operator disposition timestamp",
          );
        }
        const disposition: TelegramUpdateJournalOperatorDisposition = {
          failureId: entry.terminalFailureId,
          updateId: entry.updateId,
          action: input.action,
          committedAtMs: Math.max(nowMs, entry.terminalAtMs),
          attemptCount: entry.failure.attemptCount,
          failureClass: entry.failure.failureClass,
          terminalAtMs: entry.terminalAtMs,
          terminalReason: entry.terminalReason,
        };
        const nextEntries =
          input.action === "retry"
            ? current.file.entries.map((candidate) =>
                candidate.updateId === entry.updateId
                  ? {
                      updateId: entry.updateId,
                      update: entry.update,
                      admittedAtMs: entry.admittedAtMs,
                      ...(entry.preApprovalExcluded !== undefined ? { preApprovalExcluded: entry.preApprovalExcluded } : {}),
                      state: "retry-wait" as const,
                      failure: entry.failure,
                      nextRetryAtMs: disposition.committedAtMs,
                    }
                  : candidate,
              )
            : current.file.entries.filter(
                (candidate) => candidate.updateId !== entry.updateId,
              );
        const published = publishMutation(
          current,
          nextEntries,
          true,
          [...(current.file.operatorDispositions ?? []), disposition],
        );
        return {
          disposition: { ...disposition },
          duplicate: false,
          entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes,
        };
      });
    },
    applyLegacyCustodyDisposition(authority) {
      return runMutation((readCurrent) => {
        const current = readCurrent();
        if (current.file.version !== TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION)
          throw createJournalError("conflict", path,
            "legacy custody disposition requires a v3 journal");
        const existing = current.file.operatorDispositions?.find(
          candidate => candidate.failureId === authority.dispositionId);
        if (existing) {
          if (!("dispositionKind" in existing) || existing.dispositionKind !== "legacy-custody")
            throw createJournalError("conflict", path,
              `legacy custody disposition ${authority.dispositionId} already has another authority`);
          const normalizedDuplicate = normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(
            authority, { updateId: existing.updateId, state: "retry-wait", attemptCount: 1,
              failedAtMs: 0, failureClass: "retained-audit", summary: "retained-audit",
              evidenceSha256: existing.evidenceSha256 });
          if (!normalizedDuplicate || existing.action !== normalizedDuplicate.action ||
              existing.operatorAuthorityId !== normalizedDuplicate.operatorAuthorityId ||
              existing.authorizedAtMs !== normalizedDuplicate.authorizedAtMs)
            throw createJournalError("conflict", path,
              `legacy custody disposition ${authority.dispositionId} already has another authority`);
          let authorized = false;
          try { authorized = options.authorizeLegacyCustodyDisposition?.(normalizedDuplicate) === true; }
          catch { authorized = false; }
          if (!authorized) throw createJournalError("conflict", path,
            "legacy custody disposition is unauthorized");
          return { disposition: { ...existing }, duplicate: true,
            entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        }
        const entry = current.file.entries.find(candidate => candidate.updateId === authority.updateId);
        const evidence = entry && createTelegramUpdateJournalLegacyCustodyEvidence(entry);
        if (!evidence) throw createJournalError("conflict", path,
          `cannot dispose non-quarantined update ${authority.updateId}`);
        const normalized = normalizeTelegramUpdateJournalLegacyCustodyDispositionAuthority(
          authority, evidence);
        if (!normalized) throw createJournalError("conflict", path,
          `legacy custody evidence changed for update ${authority.updateId}`);
        let authorized = false;
        try { authorized = options.authorizeLegacyCustodyDisposition?.(normalized) === true; }
        catch { authorized = false; }
        if (!authorized) throw createJournalError("conflict", path,
          "legacy custody disposition is unauthorized");
        const nowMs = getNowMs();
        if (!isSafeNonNegativeInteger(nowMs)) throw createJournalError("invalid", path,
          "received an invalid legacy custody disposition timestamp");
        const disposition: TelegramUpdateJournalLegacyCustodyDisposition = {
          dispositionKind: "legacy-custody", failureId: normalized.dispositionId,
          updateId: normalized.updateId, action: normalized.action,
          committedAtMs: Math.max(nowMs, normalized.authorizedAtMs),
          evidenceSha256: normalized.evidenceSha256,
          operatorAuthorityId: normalized.operatorAuthorityId,
          authorizedAtMs: normalized.authorizedAtMs };
        const nextEntries = normalized.action === "discard"
          ? current.file.entries.filter(candidate => candidate.updateId !== entry.updateId)
          : current.file.entries.map(candidate => candidate.updateId === entry.updateId
            ? { updateId: entry.updateId, update: entry.update,
                admittedAtMs: entry.admittedAtMs,
                ...(entry.preApprovalExcluded === undefined ? {} :
                  { preApprovalExcluded: entry.preApprovalExcluded }), state: "pending" as const }
            : candidate);
        const published = publishMutation(current, nextEntries, true,
          [...(current.file.operatorDispositions ?? []), disposition]);
        return { disposition: { ...disposition }, duplicate: false,
          entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
      });
    },
    offerQueuedHandoff(input) {
      return runMutation((readCurrent) => {
        const { expectedOwner, recipientOwner, requestedIds, handoffId } =
          validateQueueHandoffInput(input, "offer");
        if (isTelegramUpdateJournalQueueOwnerProcess(expectedOwner, recipientOwner)) {
          throw createJournalError(
            "conflict",
            path,
            `cannot hand queue receipt ${input.receiptId} to the same runtime process`,
          );
        }
        const current = readCurrent();
        const receiptEntries = getExactQueuedReceiptEntries(
          current,
          input,
          requestedIds,
        );
        if (
          receiptEntries.some(
            (entry) =>
              !entry.queueOwner ||
              !areTelegramUpdateJournalQueueOwnersEqual(
                entry.queueOwner,
                expectedOwner,
              ),
          )
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot offer stale queue receipt ${input.receiptId}`,
          );
        }
        const existingHandoff = receiptEntries[0]?.queueHandoff;
        if (existingHandoff) {
          if (
            existingHandoff.handoffId !== handoffId ||
            !isDeepStrictEqual(existingHandoff.recipientOwner, recipientOwner)
          ) {
            throw createJournalError(
              "conflict",
              path,
              `queue receipt ${input.receiptId} already has another handoff offer`,
            );
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
          throw createJournalError(
            "invalid",
            path,
            "received an invalid queue handoff offer timestamp",
          );
        }
        const handoff: TelegramUpdateJournalQueueHandoff = {
          handoffId,
          offeredAtMs,
          recipientOwner,
        };
        const published = publishMutation(
          current,
          current.file.entries.map((entry) =>
            requestedIds.has(entry.updateId)
              ? { ...entry, queueHandoff: cloneJournalQueueHandoff(handoff) }
              : entry,
          ),
          true,
        );
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
        const { expectedOwner, recipientOwner, requestedIds, handoffId } =
          validateQueueHandoffInput(input, "accept");
        const current = readCurrent();
        const receiptEntries = getExactQueuedReceiptEntries(
          current,
          input,
          requestedIds,
        );
        const existingOwner = receiptEntries[0]?.queueOwner;
        if (
          existingOwner &&
          existingOwner.handoffId === handoffId &&
          isTelegramUpdateJournalQueueOwnerProcess(existingOwner, recipientOwner)
        ) {
          if (
            receiptEntries.some(
              (entry) =>
                !entry.queueOwner ||
                !areTelegramUpdateJournalQueueOwnersEqual(
                  entry.queueOwner,
                  existingOwner,
                ) ||
                entry.queueHandoff !== undefined,
            )
          ) {
            throw createJournalError(
              "conflict",
              path,
              `queue receipt ${input.receiptId} has inconsistent accepted handoff authority`,
            );
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
        if (
          receiptEntries.some(
            (entry) =>
              !entry.queueOwner ||
              !areTelegramUpdateJournalQueueOwnersEqual(
                entry.queueOwner,
                expectedOwner,
              ) ||
              entry.queueHandoff?.handoffId !== handoffId ||
              !isDeepStrictEqual(
                entry.queueHandoff.recipientOwner,
                recipientOwner,
              ),
          )
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot accept stale or unauthenticated queue handoff ${input.receiptId}`,
          );
        }
        const acquiredAtMs = getNowMs();
        if (!isSafeNonNegativeInteger(acquiredAtMs)) {
          throw createJournalError(
            "invalid",
            path,
            "received an invalid queue handoff acquisition timestamp",
          );
        }
        const queueOwner: TelegramUpdateJournalQueueOwner = {
          ...recipientOwner,
          acquisitionId: randomUUID(),
          acquiredAtMs,
          handoffId,
        };
        const published = publishMutation(
          current,
          current.file.entries.map((entry) =>
            requestedIds.has(entry.updateId)
              ? {
                  updateId: entry.updateId,
                  update: entry.update,
                  admittedAtMs: entry.admittedAtMs,
                  ...(entry.preApprovalExcluded !== undefined ? { preApprovalExcluded: entry.preApprovalExcluded } : {}),
                  state: "queued" as const,
                  queueKind: input.queueKind,
                  queueReceiptId: input.receiptId,
                  queueOwner: cloneJournalQueueOwner(queueOwner),
                  ...(entry.inputProvenance
                    ? { inputProvenance: structuredClone(entry.inputProvenance) } : {}),
                }
              : entry,
          ),
          true,
        );
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
        const { expectedOwner, recipientOwner, requestedIds, handoffId } =
          validateQueueHandoffInput(input, "cancel");
        const current = readCurrent();
        const receiptEntries = getExactQueuedReceiptEntries(
          current,
          input,
          requestedIds,
        );
        if (
          receiptEntries.some(
            (entry) =>
              !entry.queueOwner ||
              !areTelegramUpdateJournalQueueOwnersEqual(
                entry.queueOwner,
                expectedOwner,
              ),
          )
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot cancel stale queue handoff ${input.receiptId}`,
          );
        }
        const existingHandoff = receiptEntries[0]?.queueHandoff;
        if (!existingHandoff) {
          throw createJournalError(
            "conflict",
            path,
            `cannot cancel missing queue handoff offer ${input.receiptId}`,
          );
        }
        if (
          existingHandoff.handoffId !== handoffId ||
          !isDeepStrictEqual(existingHandoff.recipientOwner, recipientOwner)
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot cancel another queue handoff offer ${input.receiptId}`,
          );
        }
        const published = publishMutation(
          current,
          current.file.entries.map((entry) => {
            if (!requestedIds.has(entry.updateId)) return entry;
            const { queueHandoff: _queueHandoff, ...retained } = entry;
            return retained;
          }),
          true,
        );
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
      return runMutation((readCurrent) => {
        if (!Array.isArray(receipts) || receipts.length === 0) {
          throw createJournalError(
            "invalid",
            path,
            "received no queued receipts to complete",
          );
        }
        const current = readCurrent();
        const receiptIds = new Set<string>();
        const requestedUpdateIds = new Set<number>();
        for (const receipt of receipts) {
          if (
            (receipt.queueKind !== "prompt" &&
              receipt.queueKind !== "control") ||
            !isNonEmptyString(receipt.receiptId) ||
            receiptIds.has(receipt.receiptId) ||
            !Array.isArray(receipt.sourceUpdateIds) ||
            receipt.sourceUpdateIds.length === 0
          ) {
            throw createJournalError(
              "invalid",
              path,
              "received an invalid queued completion receipt",
            );
          }
          receiptIds.add(receipt.receiptId);
          const queueOwner = validateJournalQueueOwner(
            receipt.queueOwner,
            path,
          );
          if (
            queueRuntimeIdentity &&
            (queueOwner.instanceId !== queueRuntimeIdentity.instanceId ||
              queueOwner.processId !== queueRuntimeIdentity.processId ||
              queueOwner.processBirthId !==
                queueRuntimeIdentity.processBirthId)
          ) {
            throw createJournalError(
              "conflict",
              path,
              `cannot complete foreign queue receipt ${receipt.receiptId}`,
            );
          }
          const sourceUpdateIds = new Set<number>();
          for (const updateId of receipt.sourceUpdateIds) {
            if (
              !isSafeNonNegativeInteger(updateId) ||
              sourceUpdateIds.has(updateId) ||
              requestedUpdateIds.has(updateId)
            ) {
              throw createJournalError(
                "invalid",
                path,
                "received overlapping queued completion update ids",
              );
            }
            sourceUpdateIds.add(updateId);
            requestedUpdateIds.add(updateId);
          }
          const persistedReceiptEntries = current.file.entries.filter(
            (entry) => entry.queueReceiptId === receipt.receiptId,
          );
          if (
            persistedReceiptEntries.length !== sourceUpdateIds.size ||
            persistedReceiptEntries.some(
              (entry) =>
                !sourceUpdateIds.has(entry.updateId) ||
                entry.state !== "queued" ||
                entry.queueKind !== receipt.queueKind ||
                !entry.queueOwner ||
                entry.queueHandoff !== undefined ||
                !areTelegramUpdateJournalQueueOwnersEqual(
                  entry.queueOwner,
                  queueOwner,
                ),
            )
          ) {
            throw createJournalError(
              "conflict",
              path,
              `cannot complete stale or foreign queue receipt ${receipt.receiptId}`,
            );
          }
        }
        const removedUpdateIds = current.file.entries
          .filter((entry) => requestedUpdateIds.has(entry.updateId))
          .map((entry) => entry.updateId);
        if (removedUpdateIds.length !== requestedUpdateIds.size) {
          throw createJournalError(
            "conflict",
            path,
            "queued completion did not resolve every source update",
          );
        }
        const published = publishMutation(
          current,
          current.file.entries.filter(
            (entry) => !requestedUpdateIds.has(entry.updateId),
          ),
          true,
        );
        return {
          removedUpdateIds,
          entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes,
        };
      });
    },
    discardQueued(input) {
      return runMutation((readCurrent) => {
        if (
          (input.queueKind !== "prompt" &&
            input.queueKind !== "control") ||
          !isNonEmptyString(input.receiptId) ||
          !Array.isArray(input.sourceUpdateIds) ||
          input.sourceUpdateIds.length === 0
        ) {
          throw createJournalError(
            "invalid",
            path,
            "received an invalid queue discard",
          );
        }
        const expectedOwner = validateJournalQueueOwner(
          input.expectedOwner,
          path,
        );
        if (
          queueRuntimeIdentity &&
          (expectedOwner.instanceId !== queueRuntimeIdentity.instanceId ||
            expectedOwner.processId !== queueRuntimeIdentity.processId ||
            expectedOwner.processBirthId !==
              queueRuntimeIdentity.processBirthId)
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot discard foreign queue receipt ${input.receiptId}`,
          );
        }
        const requestedIds = new Set<number>();
        for (const updateId of input.sourceUpdateIds) {
          if (
            !isSafeNonNegativeInteger(updateId) ||
            requestedIds.has(updateId)
          ) {
            throw createJournalError(
              "invalid",
              path,
              "received invalid queue discard update ids",
            );
          }
          requestedIds.add(updateId);
        }
        const current = readCurrent();
        const receiptEntries = current.file.entries.filter(
          (entry) => entry.queueReceiptId === input.receiptId,
        );
        if (
          receiptEntries.length !== requestedIds.size ||
          receiptEntries.some(
            (entry) =>
              !requestedIds.has(entry.updateId) ||
              entry.state !== "queued" ||
              entry.queueKind !== input.queueKind ||
              !entry.queueOwner ||
              entry.queueHandoff !== undefined ||
              !areTelegramUpdateJournalQueueOwnersEqual(
                entry.queueOwner,
                expectedOwner,
              ),
          )
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot discard stale queue receipt ${input.receiptId}`,
          );
        }
        const removedUpdateIds = [...requestedIds].sort((a, b) => a - b);
        const published = publishMutation(
          current,
          current.file.entries.filter(
            (entry) => !requestedIds.has(entry.updateId),
          ),
          true,
        );
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
          throw createJournalError(
            "conflict",
            path,
            "cannot recover queue authority without a process-liveness proof",
          );
        }
        const deadOwner = validateJournalQueueOwner(input.deadOwner, path);
        let ownerLiveness: TelegramProcessLiveness;
        try {
          ownerLiveness = getQueueProcessLiveness({
            processId: deadOwner.processId,
            processBirthId: deadOwner.processBirthId,
          });
        } catch (error) {
          throw createJournalError(
            "io",
            path,
            "could not prove queued owner liveness",
            error,
          );
        }
        const recoveryOwner = validateJournalQueueOwnerIdentity(
          input.recoveryOwner,
          path,
        );
        if (
          queueRuntimeIdentity &&
          (recoveryOwner.instanceId !== queueRuntimeIdentity.instanceId ||
            recoveryOwner.processId !== queueRuntimeIdentity.processId ||
            recoveryOwner.processBirthId !==
              queueRuntimeIdentity.processBirthId)
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot recover queue receipt ${input.receiptId} for another runtime`,
          );
        }
        const requestedIds = new Set<number>();
        for (const updateId of input.sourceUpdateIds) {
          if (
            !isSafeNonNegativeInteger(updateId) ||
            requestedIds.has(updateId)
          ) {
            throw createJournalError(
              "invalid",
              path,
              "received invalid queue recovery update ids",
            );
          }
          requestedIds.add(updateId);
        }
        const current = readCurrent();
        const receiptEntries = current.file.entries.filter(
          (entry) => entry.queueReceiptId === input.receiptId,
        );
        if (
          (input.queueKind !== "prompt" &&
            input.queueKind !== "control") ||
          !isNonEmptyString(input.receiptId) ||
          requestedIds.size === 0 ||
          receiptEntries.length !== requestedIds.size ||
          receiptEntries.some(
            (entry) =>
              !requestedIds.has(entry.updateId) ||
              entry.state !== "queued" ||
              entry.queueKind !== input.queueKind ||
              !entry.queueOwner ||
              entry.queueHandoff !== undefined ||
              !areTelegramUpdateJournalQueueOwnersEqual(
                entry.queueOwner,
                deadOwner,
              ),
          )
        ) {
          throw createJournalError(
            "conflict",
            path,
            `cannot recover stale queue receipt ${input.receiptId}`,
          );
        }
        if (ownerLiveness !== "dead") {
          return {
            status:
              ownerLiveness === "alive"
                ? ("owner-alive" as const)
                : ("owner-unverifiable" as const),
            previousOwner: cloneJournalQueueOwner(deadOwner),
            recoveredUpdateIds: [] as [],
            entryCount: current.file.entries.length,
            serializedBytes: current.serializedBytes,
          };
        }
        const recoveredUpdateIds = [...requestedIds].sort((a, b) => a - b);
        const published = publishMutation(
          current,
          current.file.entries.filter(
            (entry) => !requestedIds.has(entry.updateId),
          ),
          true,
        );
        return {
          status: "recovered" as const,
          previousOwner: cloneJournalQueueOwner(deadOwner),
          recoveredUpdateIds,
          entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes,
        };
      });
    },
    removeCompleted(updateIds) {
      return runMutation((readCurrent) => {
        const current = readCurrent();
        const requestedIds = new Set<number>();
        for (const updateId of updateIds) {
          if (!isSafeNonNegativeInteger(updateId)) {
            throw createJournalError(
              "invalid",
              path,
              "received an invalid removal update id",
            );
          }
          requestedIds.add(updateId);
        }
        const requestedEntries = current.file.entries.filter((entry) =>
          requestedIds.has(entry.updateId),
        );
        const protectedEntry = requestedEntries.find(
          (entry) => entry.state === "failed" || entry.state === "queued",
        );
        if (protectedEntry) {
          throw createJournalError(
            "conflict",
            path,
            protectedEntry.state === "failed"
              ? `cannot complete terminal update ${protectedEntry.updateId} without an operator disposition`
              : `cannot complete queued update ${protectedEntry.updateId} without its exact owner receipt`,
          );
        }
        const removedUpdateIds = requestedEntries.map(
          (entry) => entry.updateId,
        );
        const published = publishMutation(
          current,
          current.file.entries.filter(
            (entry) => !requestedIds.has(entry.updateId),
          ),
          removedUpdateIds.length > 0,
        );
        return {
          removedUpdateIds,
          entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes,
        };
      });
    },
  };
  if (!getInputContext) return { journal };
  // Strict source acquisition already requires this exact stored receipt scope.
  const bindingKey = createTelegramUpdateJournalBindingKey({ path, profileName: profile, botIdentity: expectedIdentity });
  const createInputSourceReference = (updateId: number): TelegramInputJournalSourceReference => ({
    journalBindingKey: bindingKey,
    tokenSha256: expectedIdentity.tokenSha256,
    updateId,
  });
  const createInputReceipt = (updateId: number,
    owner: TelegramUpdateJournalQueueOwner): TelegramInputJournalReceipt => ({
    ...createInputSourceReference(updateId),
    owner: cloneJournalQueueOwner(owner),
  });
  const assertInputProcess = (identity: TelegramUpdateJournalQueueOwnerIdentity): void => {
    if (!queueRuntimeIdentity ||
        identity.instanceId !== queueRuntimeIdentity.instanceId ||
        identity.processId !== queueRuntimeIdentity.processId ||
        identity.processBirthId !== queueRuntimeIdentity.processBirthId) {
      throw createJournalError("conflict", path, "input custody belongs to another runtime");
    }
  };
  const inputOwnerMatchesIdentity = (owner: TelegramUpdateJournalQueueOwner,
    identity: TelegramUpdateJournalQueueOwnerIdentity): boolean =>
    isTelegramUpdateJournalQueueOwnerProcess(owner, identity) &&
      owner.sessionGeneration === identity.sessionGeneration;
  const currentInputContext = (): TelegramInputJournalContext => {
    const observed = getInputContext();
    if (observed === undefined) throw createJournalError("conflict", path, "input execution context is unavailable");
    const owner = validateJournalQueueOwnerIdentity(observed.owner, path);
    const recipientBindingKey = observed.recipientBindingKey;
    if (!isBoundedString(recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
        !recipientBindingKey.trim()) {
      throw createJournalError("invalid", path, "input execution binding is invalid");
    }
    assertInputProcess(owner);
    return { owner, recipientBindingKey };
  };
  const runInputAdmission = <T>(kind: string, operation: () => T): T =>
    workspaceAdmission ? runWithTelegramWorkspaceAdmissions({
      ledger: workspaceAdmission, operationId: `input:${randomUUID()}`, operationKind: `journal.input.${kind}`,
      scopes: [{ kind: "profile" }], operation,
    }) : operation();
  const runInputMutation = <T>(kind: string, operation: (read: typeof readCurrent) => T): T =>
    runInputAdmission(kind, () => runMutation(operation));
  const publishInputMutation = (current: ReadTelegramUpdateJournalResult,
    entries: TelegramUpdateJournalEntry[], updateId: number | readonly number[],
    context: TelegramInputJournalContext) =>
    publishMutation(current, entries, true, current.file.operatorDispositions, current.file.acceptedThroughUpdateId,
      (boundary, publicationPath) => {
        onPublicationBoundary?.(boundary, publicationPath);
        if (!isDeepStrictEqual(currentInputContext(), context)) {
          throw createJournalError("conflict", path, "input execution context changed before publication");
        }
      }, updateId);
  const publishInputSettlement = (current: ReadTelegramUpdateJournalResult,
    entries: TelegramUpdateJournalEntry[], contentChanged: boolean) => publishMutation(current, entries,
      contentChanged, current.file.operatorDispositions, current.file.acceptedThroughUpdateId,
      onPublicationBoundary, false);
  const normalizeInputSourceReference = (value: TelegramInputJournalSourceReference,
    operation: string): TelegramInputJournalSourceReference => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["journalBindingKey", "tokenSha256", "updateId"])) {
      throw createJournalError("invalid", path, `received invalid input handoff ${operation} source`);
    }
    const journalBindingKey = value.journalBindingKey;
    const updateId = value.updateId;
    if (journalBindingKey !== bindingKey || value.tokenSha256 !== expectedIdentity.tokenSha256 ||
        !isSafeNonNegativeInteger(updateId)) {
      throw createJournalError("conflict", path, "input receipt does not match its source identity");
    }
    return { journalBindingKey, tokenSha256: expectedIdentity.tokenSha256, updateId };
  };
  const normalizeInputReceipt = (value: TelegramInputJournalReceipt,
    requireCurrentProcess = true): TelegramInputJournalReceipt => {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["journalBindingKey", "tokenSha256", "updateId", "owner"])) {
      throw createJournalError("invalid", path, "received an invalid input receipt");
    }
    const source = normalizeInputSourceReference({ journalBindingKey: value.journalBindingKey,
      tokenSha256: value.tokenSha256, updateId: value.updateId }, "receipt");
    const owner = validateJournalQueueOwner(value.owner, path);
    if (requireCurrentProcess) assertInputProcess(owner);
    return { ...source, owner };
  };
  const normalizeInputHandoffOffer = (value: TelegramInputJournalHandoffOfferInput) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["receipt", "recipientOwner", "handoffToken"]) ||
        !isBoundedString(value.handoffToken, TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MAX_LENGTH) ||
        value.handoffToken.length < TELEGRAM_UPDATE_JOURNAL_QUEUE_HANDOFF_TOKEN_MIN_LENGTH) {
      throw createJournalError("invalid", path, "received invalid input handoff offer");
    }
    const receipt = normalizeInputReceipt(value.receipt as TelegramInputJournalReceipt);
    const recipientOwner = validateJournalQueueOwnerIdentity(value.recipientOwner, path);
    if (isTelegramUpdateJournalQueueOwnerProcess(receipt.owner, recipientOwner)) {
      throw createJournalError("conflict", path, "cannot transfer input custody to the same runtime process");
    }
    return { receipt, recipientOwner, handoffToken: value.handoffToken };
  };
  const normalizeInputHandoffId = (value: unknown, operation: "accept" | "cancel") => {
    if (!isTelegramInputHandoffId(value)) {
      throw createJournalError("invalid", path, `received invalid input handoff ${operation}`);
    }
    return value;
  };
  const normalizeInputHandoffAccept = (value: TelegramInputJournalHandoffAcceptInput) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["source", "recipientOwner", "handoffId"])) {
      throw createJournalError("invalid", path, "received invalid input handoff accept");
    }
    const source = normalizeInputSourceReference(
      value.source as TelegramInputJournalSourceReference, "accept");
    const recipientOwner = validateJournalQueueOwnerIdentity(value.recipientOwner, path);
    assertInputProcess(recipientOwner);
    return { source, recipientOwner, handoffId: normalizeInputHandoffId(value.handoffId, "accept") };
  };
  const normalizeInputHandoffCancel = (value: TelegramInputJournalHandoffCancelInput) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["receipt", "recipientOwner", "handoffId"])) {
      throw createJournalError("invalid", path, "received invalid input handoff cancel");
    }
    return { receipt: normalizeInputReceipt(value.receipt as TelegramInputJournalReceipt),
      recipientOwner: validateJournalQueueOwnerIdentity(value.recipientOwner, path),
      handoffId: normalizeInputHandoffId(value.handoffId, "cancel") };
  };
  const normalizeInputQueue = (value: TelegramInputJournalQueueInput) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["queueKind", "receiptId", "receipts"]) ||
        (value.queueKind !== "prompt" && value.queueKind !== "control") ||
        !isBoundedString(value.receiptId, TELEGRAM_UPDATE_JOURNAL_QUEUE_OWNER_ID_MAX_LENGTH) ||
        !value.receiptId.trim() || !Array.isArray(value.receipts) || value.receipts.length === 0) {
      throw createJournalError("invalid", path, "received invalid input queue transition");
    }
    const receipts = value.receipts.map(receipt =>
      normalizeInputReceipt(receipt as TelegramInputJournalReceipt)).sort((left, right) => left.updateId - right.updateId);
    if (receipts.some((receipt, index) => index > 0 && receipt.updateId === receipts[index - 1]!.updateId)) {
      throw createJournalError("invalid", path, "received duplicate input queue transition receipts");
    }
    return { queueKind: value.queueKind, receiptId: value.receiptId, receipts };
  };
  const ownedInput = (current: ReadTelegramUpdateJournalResult, receipt: TelegramInputJournalReceipt): TelegramUpdateJournalEntry => {
    const entry = current.file.entries.find(candidate => candidate.updateId === receipt.updateId);
    if (!entry?.inputClaim || entry.state !== "pending" ||
        !areTelegramUpdateJournalQueueOwnersEqual(entry.inputClaim.owner, receipt.owner)) {
      throw createJournalError("conflict", path, "input receipt lost its exact acquisition or phase");
    }
    return entry;
  };
  const getReadyInputRelease = (current: ReadTelegramUpdateJournalResult,
    receipt: TelegramInputJournalReceipt, allowOffered = false): {
      entry: TelegramUpdateJournalEntry; unclaimed: boolean;
    } => {
    const entry = current.file.entries.find(candidate => candidate.updateId === receipt.updateId);
    if (!entry || entry.state !== "pending" || entry.preApprovalExcluded !== false) {
      throw createJournalError("conflict", path, "input is unavailable for ready-claim release");
    }
    if (!entry.inputClaim) return { entry, unclaimed: true };
    if (!areTelegramUpdateJournalQueueOwnersEqual(entry.inputClaim.owner, receipt.owner) ||
        entry.inputClaim.phase !== "ready" || (!allowOffered && entry.inputClaim.handoff !== undefined)) {
      throw createJournalError("conflict", path, "cannot release stale, running, or offered input authority");
    }
    return { entry, unclaimed: false };
  };
  const publishReadyInputRelease = (current: ReadTelegramUpdateJournalResult,
    entry: TelegramUpdateJournalEntry) => {
    const released = cloneEntry(entry);
    delete released.inputClaim;
    return publishMutation(current, current.file.entries.map(candidate =>
      candidate.updateId === entry.updateId ? released : candidate), true,
      current.file.operatorDispositions, current.file.acceptedThroughUpdateId,
      onPublicationBoundary, entry.updateId);
  };
  const input: TelegramInputJournalStore = {
    read: journal.read,
    appendBatch: journal.appendBatch,
    listLegacyCustodyCandidates() {
      const sourceAccess = options.sourceAccess!;
      const evidence = readTelegramUpdateJournalSource({
        directory: sourceAccess.directory, path, profile,
        botIdentity: expectedIdentity, limits: sourceAccess.limits,
        version: TELEGRAM_UPDATE_JOURNAL_CUSTODY_VERSION,
      });
      return evidence.kind === "present"
        ? listTelegramUpdateJournalLegacyCustodyCandidates(evidence.file) : [];
    },
    applyLegacyCustodyDisposition(value) {
      return runInputAdmission("legacy-custody-disposition", () =>
        journal.applyLegacyCustodyDisposition(value));
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
      const requestedIds = new Set<number>();
      for (const updateId of updateIds) {
        if (!isSafeNonNegativeInteger(updateId)) {
          throw createJournalError("invalid", path, "received an invalid exclusion removal update id");
        }
        requestedIds.add(updateId);
      }
      return runInputMutation("remove-excluded", read => {
        const current = read();
        if (!current.exists || [...requestedIds].some(id => id > (current.file.acceptedThroughUpdateId ?? -1))) {
          throw createJournalError("conflict", path, "exclusion removal lacks retained source admission evidence");
        }
        const selected = current.file.entries.filter(entry => requestedIds.has(entry.updateId));
        if (selected.some(entry => entry.preApprovalExcluded !== true)) {
          throw createJournalError("conflict", path, "cannot remove input without immutable exclusion evidence");
        }
        // Strict v3 decoding already excludes raw claims and queued authority on vetoed entries.
        const removedUpdateIds = selected.map(entry => entry.updateId);
        const published = publishInputSettlement(current,
          current.file.entries.filter(entry => !requestedIds.has(entry.updateId)), removedUpdateIds.length > 0);
        return { removedUpdateIds, entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
      });
    },
    releaseInput(value) {
      const receipt = normalizeInputReceipt(value);
      return runInputMutation("release", read => {
        const current = read();
        const release = getReadyInputRelease(current, receipt);
        if (release.unclaimed) return { released: false,
          entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        const published = publishReadyInputRelease(current, release.entry);
        return { released: true, entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes };
      });
    },
    recoverReadyInput(value) {
      if (!isRecord(value) || !hasOnlyKeys(value, ["receipt", "recoveryOwner"])) {
        throw createJournalError("invalid", path, "received invalid ready-input recovery authority");
      }
      const receipt = normalizeInputReceipt(value.receipt as TelegramInputJournalReceipt, false);
      const recoveryOwner = validateJournalQueueOwnerIdentity(value.recoveryOwner, path);
      assertInputProcess(recoveryOwner);
      return runInputMutation("recover-ready", read => {
        const current = read();
        const release = getReadyInputRelease(current, receipt, true);
        if (release.unclaimed) return { status: "unclaimed" as const,
          entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        let liveness: TelegramProcessLiveness;
        try {
          liveness = getQueueProcessLiveness({ processId: receipt.owner.processId,
            processBirthId: receipt.owner.processBirthId });
        } catch (error) {
          throw createJournalError("io", path, "could not prove ready input owner liveness", error);
        }
        if (liveness !== "dead") return { status: liveness === "alive" ? "owner-alive" as const : "owner-unverifiable" as const,
          entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        const published = publishReadyInputRelease(current, release.entry);
        return { status: "recovered" as const, entryCount: published.file.entries.length,
          serializedBytes: published.serializedBytes };
      });
    },
    offerInputHandoff(value) {
      const { receipt, recipientOwner, handoffToken } = normalizeInputHandoffOffer(value);
      return runInputMutation("offer", read => {
        const context = currentInputContext();
        const current = read();
        const entry = ownedInput(current, receipt);
        const claim = entry.inputClaim!;
        if (claim.phase !== "ready" || !inputOwnerMatchesIdentity(receipt.owner, context.owner) ||
            claim.recipientBindingKey !== context.recipientBindingKey) {
          throw createJournalError("conflict", path, "input handoff donor authority is stale or running");
        }
        if (claim.handoff) {
          if (!isDeepStrictEqual(claim.handoff.recipientOwner, recipientOwner)) {
            throw createJournalError("conflict", path, "input already has another handoff offer");
          }
          return { source: createInputSourceReference(receipt.updateId),
            handoff: cloneJournalQueueHandoff(claim.handoff),
            previousOwner: cloneJournalQueueOwner(receipt.owner), duplicate: true,
            entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        }
        const handoffId = createTelegramInputHandoffId({ handoffToken, journalBindingKey: bindingKey,
          updateId: receipt.updateId, donorOwner: receipt.owner, recipientOwner,
          recipientBindingKey: claim.recipientBindingKey });
        const offeredAtMs = getNowMs();
        if (!isSafeNonNegativeInteger(offeredAtMs)) {
          throw createJournalError("invalid", path, "received an invalid input handoff offer timestamp");
        }
        const handoff: TelegramUpdateJournalInputHandoff = { handoffId, offeredAtMs,
          recipientOwner: { ...recipientOwner } };
        const offeredClaim = { ...claim, handoff };
        const published = publishInputMutation(current, current.file.entries.map(candidate =>
          candidate.updateId === receipt.updateId ? { ...candidate, inputClaim: offeredClaim } : candidate),
        receipt.updateId, context);
        return { source: createInputSourceReference(receipt.updateId),
          handoff: cloneJournalQueueHandoff(handoff),
          previousOwner: cloneJournalQueueOwner(receipt.owner), duplicate: false,
          entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
      });
    },
    acceptInputHandoff(value) {
      const { source, recipientOwner, handoffId } = normalizeInputHandoffAccept(value);
      return runInputMutation("accept", read => {
        const context = currentInputContext();
        const current = read();
        const entry = current.file.entries.find(candidate => candidate.updateId === source.updateId);
        const claim = entry?.inputClaim;
        if (!entry || entry.state !== "pending" || entry.preApprovalExcluded !== false || !claim ||
            !isDeepStrictEqual(context.owner, recipientOwner) ||
            context.recipientBindingKey !== claim.recipientBindingKey) {
          throw createJournalError("conflict", path, "input handoff recipient authority is unavailable or changed");
        }
        if (claim.owner.handoffId === handoffId && inputOwnerMatchesIdentity(claim.owner, recipientOwner)) {
          return { handoffId, receipt: createInputReceipt(source.updateId, claim.owner), duplicate: true,
            entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        }
        if (claim.phase !== "ready" || claim.handoff?.handoffId !== handoffId ||
            !isDeepStrictEqual(claim.handoff.recipientOwner, recipientOwner)) {
          throw createJournalError("conflict", path, "cannot accept stale or unauthenticated input handoff");
        }
        const acquiredAtMs = getNowMs();
        if (!isSafeNonNegativeInteger(acquiredAtMs)) {
          throw createJournalError("invalid", path, "received an invalid input handoff acquisition timestamp");
        }
        const previousOwner = cloneJournalQueueOwner(claim.owner);
        const owner: TelegramUpdateJournalQueueOwner = { ...recipientOwner,
          acquisitionId: randomUUID(), acquiredAtMs, handoffId };
        const acceptedClaim = structuredClone(claim);
        acceptedClaim.owner = owner;
        delete acceptedClaim.handoff;
        const publishedEntries = current.file.entries.map(candidate =>
          candidate.updateId === source.updateId ? { ...candidate, inputClaim: acceptedClaim } : candidate);
        const published = publishInputMutation(current, publishedEntries, source.updateId, context);
        return { handoffId, previousOwner, receipt: createInputReceipt(source.updateId, owner), duplicate: false,
          entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
      });
    },
    cancelInputHandoff(value) {
      const { receipt, recipientOwner, handoffId } = normalizeInputHandoffCancel(value);
      return runInputMutation("cancel", read => {
        const context = currentInputContext();
        const current = read();
        const entry = ownedInput(current, receipt);
        const claim = entry.inputClaim!;
        if (claim.phase !== "ready" || !inputOwnerMatchesIdentity(receipt.owner, context.owner) ||
            claim.recipientBindingKey !== context.recipientBindingKey) {
          throw createJournalError("conflict", path, "input handoff donor authority is stale or running");
        }
        if (!claim.handoff) return { handoffId, previousOwner: cloneJournalQueueOwner(receipt.owner),
          cancelled: false, entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        if (claim.handoff.handoffId !== handoffId ||
            !isDeepStrictEqual(claim.handoff.recipientOwner, recipientOwner)) {
          throw createJournalError("conflict", path, "cannot cancel another input handoff offer");
        }
        const cancelledClaim = structuredClone(claim);
        delete cancelledClaim.handoff;
        const publishedEntries = current.file.entries.map(candidate =>
          candidate.updateId === receipt.updateId ? { ...candidate, inputClaim: cancelledClaim } : candidate);
        const published = publishInputMutation(current, publishedEntries, receipt.updateId, context);
        return { handoffId, previousOwner: cloneJournalQueueOwner(receipt.owner), cancelled: true,
          entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
      });
    },
    queueInputs(value) {
      const { queueKind, receiptId, receipts } = normalizeInputQueue(value);
      return runInputMutation("queue", read => {
        const context = currentInputContext();
        if (receipts.some(receipt => !inputOwnerMatchesIdentity(receipt.owner, context.owner))) {
          throw createJournalError("conflict", path, "input queue transition belongs to another session");
        }
        const current = read();
        const receiptsById = new Map(receipts.map(receipt => [receipt.updateId, receipt]));
        const requestedIds = receipts.map(receipt => receipt.updateId);
        const existingReceiptEntries = current.file.entries.filter(entry => entry.queueReceiptId === receiptId);
        if (existingReceiptEntries.length > 0) {
          const queueOwner = existingReceiptEntries[0]?.queueOwner;
          if (existingReceiptEntries.length !== receipts.length || !queueOwner ||
              !inputOwnerMatchesIdentity(queueOwner, context.owner) ||
              existingReceiptEntries.some(entry => {
                const receipt = receiptsById.get(entry.updateId);
                return !receipt || entry.state !== "queued" || entry.queueKind !== queueKind ||
                  entry.queueHandoff !== undefined || !entry.inputProvenance ||
                  !areTelegramUpdateJournalQueueOwnersEqual(entry.inputProvenance.owner, receipt.owner) ||
                  entry.inputProvenance.recipientBindingKey !== context.recipientBindingKey;
              })) {
            throw createJournalError("conflict", path, "input queue transition conflicts with queued authority");
          }
          return { queued: false, queueReceipt: { queueKind, receiptId,
            sourceUpdateIds: requestedIds, queueOwner: cloneJournalQueueOwner(queueOwner) },
          entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        }
        for (const receipt of receipts) {
          const entry = current.file.entries.find(candidate => candidate.updateId === receipt.updateId);
          if (!entry || entry.state !== "pending" || entry.preApprovalExcluded !== false ||
              !entry.inputClaim || entry.inputClaim.phase !== "running" || entry.inputClaim.handoff ||
              !areTelegramUpdateJournalQueueOwnersEqual(entry.inputClaim.owner, receipt.owner) ||
              entry.inputClaim.recipientBindingKey !== context.recipientBindingKey) {
            throw createJournalError("conflict", path, "input queue transition lost exact running authority");
          }
        }
        const acquiredAtMs = getNowMs();
        if (!isSafeNonNegativeInteger(acquiredAtMs)) {
          throw createJournalError("invalid", path, "received an invalid input queue acquisition timestamp");
        }
        const queueOwner: TelegramUpdateJournalQueueOwner = { ...context.owner,
          acquisitionId: randomUUID(), acquiredAtMs };
        const queuedEntries = current.file.entries.map(entry => {
          const receipt = receiptsById.get(entry.updateId);
          if (!receipt) return entry;
          const claim = entry.inputClaim!;
          return { updateId: entry.updateId, update: entry.update,
            admittedAtMs: entry.admittedAtMs, preApprovalExcluded: false, state: "queued" as const,
            queueKind, queueReceiptId: receiptId, queueOwner: cloneJournalQueueOwner(queueOwner),
            inputProvenance: { owner: cloneJournalQueueOwner(claim.owner),
              recipientBindingKey: claim.recipientBindingKey,
              ...(claim.executionUpdate
                ? { executionUpdate: structuredClone(claim.executionUpdate) } : {}) } };
        });
        const published = publishInputMutation(current, queuedEntries, requestedIds, context);
        return { queued: true, queueReceipt: { queueKind, receiptId,
          sourceUpdateIds: requestedIds, queueOwner: cloneJournalQueueOwner(queueOwner) },
        entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
      });
    },
    acquireInput(value) {
      const updateId = value.updateId;
      const recipientBindingKey = value.recipientBindingKey;
      const executionUpdate = value.executionUpdate === undefined ? undefined : normalizeIncomingJournaledUpdate(value.executionUpdate, path);
      if (!isSafeNonNegativeInteger(updateId) ||
          !isBoundedString(recipientBindingKey, TELEGRAM_UPDATE_JOURNAL_INPUT_BINDING_MAX_LENGTH) ||
          !recipientBindingKey.trim() || (executionUpdate && executionUpdate.update_id !== updateId)) {
        throw createJournalError("invalid", path, "received invalid input acquisition identity");
      }
      return runInputMutation("acquire", read => {
        const context = currentInputContext();
        const identity = context.owner;
        if (recipientBindingKey !== context.recipientBindingKey) {
          throw createJournalError("conflict", path, "input acquisition targets another execution binding");
        }
        const current = read();
        const entry = current.file.entries.find(candidate => candidate.updateId === updateId);
        if (!entry || entry.state !== "pending" || entry.preApprovalExcluded !== false) {
          throw createJournalError("conflict", path, "input is not eligible for acquisition");
        }
        const projected = executionUpdate ?? entry.update;
        const existing = entry.inputClaim;
        if (existing) {
          if (!isTelegramUpdateJournalQueueOwnerProcess(existing.owner, identity) ||
              existing.owner.sessionGeneration !== identity.sessionGeneration || existing.recipientBindingKey !== recipientBindingKey ||
              !isDeepStrictEqual(existing.executionUpdate ?? entry.update, projected)) {
            throw createJournalError("conflict", path, "input already has another owner or execution projection");
          }
          return { acquired: false, receipt: createInputReceipt(updateId, existing.owner) };
        }
        const claim: TelegramUpdateJournalInputClaim = { phase: "ready", recipientBindingKey,
          owner: { ...identity, acquisitionId: randomUUID(), acquiredAtMs: getNowMs() },
          ...(!isDeepStrictEqual(projected, entry.update) ? { executionUpdate: projected } : {}) };
        const claimedEntries = current.file.entries.map(candidate =>
          candidate.updateId === updateId ? { ...candidate, inputClaim: claim } : candidate);
        const reservedEntry = { ...entry, inputClaim: createInputHeadroomClaim(entry, "ready") };
        const reservedEntries = replaceInputHeadroomEntry(current.file, updateId, reservedEntry);
        const actualBytes = Buffer.byteLength(serializeJournalFile({ ...current.file, entries: claimedEntries }));
        const reservedBytes = Buffer.byteLength(serializeJournalFile({ ...current.file, entries: reservedEntries })) +
          TELEGRAM_UPDATE_JOURNAL_INPUT_PROJECTION_HEADROOM_BYTES;
        if (actualBytes > reservedBytes) {
          throw createJournalError("capacity", path, "execution projection exceeds reserved input headroom");
        }
        publishInputMutation(current, claimedEntries, updateId, context);
        return { acquired: true, receipt: createInputReceipt(updateId, claim.owner) };
      });
    },
    startInput(value) {
      const receipt = normalizeInputReceipt(value);
      return runInputMutation("start", read => {
        const context = currentInputContext();
        const current = read();
        const entry = ownedInput(current, receipt);
        const claim = entry.inputClaim!;
        if (context.owner.sessionGeneration !== receipt.owner.sessionGeneration ||
            context.recipientBindingKey !== claim.recipientBindingKey) {
          throw createJournalError("conflict", path, "input belongs to another execution session or binding");
        }
        if (claim.phase === "running") return { started: false as const };
        if (claim.handoff) throw createJournalError("conflict", path, "input handoff freezes donor execution");
        publishInputMutation(current, current.file.entries.map(candidate =>
          candidate.updateId === receipt.updateId
            ? { ...candidate, inputClaim: { ...claim, phase: "running" as const } } : candidate),
          receipt.updateId, context);
        return { started: true as const, update: structuredClone(claim.executionUpdate ?? entry.update) };
      });
    },
    completeInput(value) {
      const receipt = normalizeInputReceipt(value);
      return runInputMutation("complete", read => {
        const current = read();
        const exists = current.file.entries.some(entry => entry.updateId === receipt.updateId);
        if (!exists && current.exists && receipt.updateId <= (current.file.acceptedThroughUpdateId ?? -1)) {
          return { removedUpdateIds: [], entryCount: current.file.entries.length, serializedBytes: current.serializedBytes };
        }
        const entry = ownedInput(current, receipt);
        if (entry.inputClaim!.phase !== "running") throw createJournalError("conflict", path, "input has not started");
        const published = publishInputSettlement(current,
          current.file.entries.filter(candidate => candidate.updateId !== receipt.updateId), true);
        return { removedUpdateIds: [receipt.updateId], entryCount: published.file.entries.length, serializedBytes: published.serializedBytes };
      });
    },
  };
  return { journal, input };
}
