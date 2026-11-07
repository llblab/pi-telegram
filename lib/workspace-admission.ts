/**
 * Durable Telegram Workspace admission and retirement fencing
 * Zones: telegram workspace identity, filesystem authority, process recovery
 * Owns profile-scoped admission leases, destructive fences, and deletion permits
 * Excludes journal/API operations, retirement policy, and binding persistence
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  mutateTelegramRuntimeStateSection,
  readTelegramRuntimeState,
  renameTelegramPathWithRetry,
  TelegramRuntimeStateError,
  withTelegramFileTransaction,
} from "./locks.ts";
import {
  getTelegramProcessLiveness,
  type TelegramProcessLiveness,
} from "./process-identity.ts";
import {
  areTelegramTargetsEqual as areTargetsEqual,
  type TelegramTarget,
} from "./target.ts";
import {
  isWireRecord as isRecord,
  isNonNegativeWireInteger as isSafeTimestamp,
} from "./wire.ts";

const TELEGRAM_WORKSPACE_ADMISSION_VERSION = 1;
const TELEGRAM_WORKSPACE_ADMISSION_MAX_LEASES = 4096;
const TELEGRAM_WORKSPACE_ADMISSION_MAX_TEXT = 512;
const activeTelegramWorkspaceAdmissionOperationIds = new Set<string>();

export interface TelegramWorkspaceAdmissionOwner {
  processId: number;
  processBirthId: string;
}

export type TelegramWorkspaceAdmissionScope =
  | { kind: "target"; target: TelegramTarget & { threadId: number } }
  | { kind: "chat"; chatId: number }
  | { kind: "profile" };

interface TelegramWorkspaceAdmissionLease {
  operationId: string;
  operationKind: string;
  profileKey: string;
  scope: TelegramWorkspaceAdmissionScope;
  owner: TelegramWorkspaceAdmissionOwner;
  acquiredAtMs: number;
}

type TelegramWorkspaceDestructiveFenceKind =
  "pressure-retirement" | "manual-thread-cleanup" | "journal-writer-closure";

export type TelegramWorkspaceDeletionFenceKind = Exclude<
  TelegramWorkspaceDestructiveFenceKind,
  "journal-writer-closure"
>;

interface TelegramWorkspaceJournalWriterClosureFence {
  destructiveKind: "journal-writer-closure";
  phase: "fenced";
  operationId: string;
  profileKey: string;
  recoveryKey: string;
  owner: TelegramWorkspaceAdmissionOwner;
  requestedAtMs: number;
  acquiredAtMs: number;
}

export function normalizeTelegramWorkspaceJournalWriterClosureFence(
  value: unknown,
  profileKey: string,
): TelegramWorkspaceJournalWriterClosureFence | undefined {
  if (
    !isRecord(value) ||
    value.destructiveKind !== "journal-writer-closure" ||
    value.phase !== "fenced" ||
    !isBoundedText(value.operationId) ||
    value.profileKey !== profileKey ||
    !isBoundedText(value.recoveryKey) ||
    !isSafeTimestamp(value.requestedAtMs) ||
    !isSafeTimestamp(value.acquiredAtMs)
  )
    return undefined;
  const owner = normalizeOwner(value.owner);
  if (
    !owner ||
    Object.keys(value).some(
      (key) =>
        ![
          "destructiveKind",
          "phase",
          "operationId",
          "profileKey",
          "recoveryKey",
          "owner",
          "requestedAtMs",
          "acquiredAtMs",
        ].includes(key),
    )
  )
    return undefined;
  return {
    destructiveKind: "journal-writer-closure",
    phase: "fenced",
    operationId: value.operationId,
    profileKey,
    recoveryKey: value.recoveryKey,
    owner,
    requestedAtMs: value.requestedAtMs,
    acquiredAtMs: value.acquiredAtMs,
  };
}

interface TelegramWorkspaceJournalWriterProtocolMode {
  version: 1;
  protocol: "custody-v3";
  profileKey: string;
  recoveryKey: string;
  startupAuthorityId: string;
  closureOperationId: string;
  writerInventorySha256: string;
  installedBy: TelegramWorkspaceAdmissionOwner;
  installedAtMs: number;
}

export function normalizeTelegramWorkspaceJournalWriterProtocolMode(
  value: unknown,
  profileKey: string,
): TelegramWorkspaceJournalWriterProtocolMode | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    "version",
    "protocol",
    "profileKey",
    "recoveryKey",
    "startupAuthorityId",
    "closureOperationId",
    "writerInventorySha256",
    "installedBy",
    "installedAtMs",
  ];
  const installedBy = normalizeOwner(value.installedBy);
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.version !== 1 ||
    value.protocol !== "custody-v3" ||
    value.profileKey !== profileKey ||
    !isBoundedText(value.recoveryKey) ||
    !isBoundedText(value.startupAuthorityId) ||
    !isBoundedText(value.closureOperationId) ||
    typeof value.writerInventorySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.writerInventorySha256) ||
    !installedBy ||
    !isSafeTimestamp(value.installedAtMs)
  )
    return undefined;
  return {
    version: 1,
    protocol: "custody-v3",
    profileKey,
    recoveryKey: value.recoveryKey,
    startupAuthorityId: value.startupAuthorityId,
    closureOperationId: value.closureOperationId,
    writerInventorySha256: value.writerInventorySha256,
    installedBy,
    installedAtMs: value.installedAtMs,
  };
}

interface TelegramWorkspaceRetirementFenceBase {
  destructiveKind?: TelegramWorkspaceDeletionFenceKind;
  operationId: string;
  retirementIntentId: string;
  profileKey: string;
  bindingKey: string;
  /** Null is admitted only for explicit manual cleanup of a slotless binding. */
  slot: string | null;
  target: TelegramTarget & { threadId: number };
  leaderEpoch: number | string;
  retirementRequestedAtMs: number;
  owner: TelegramWorkspaceAdmissionOwner;
  acquiredAtMs: number;
}

export type TelegramWorkspaceRetirementFence =
  | (TelegramWorkspaceRetirementFenceBase & { phase: "fenced" })
  | (TelegramWorkspaceRetirementFenceBase & {
      phase: "deletion-issued";
      deletionIssuedAtMs: number;
    })
  | (TelegramWorkspaceRetirementFenceBase & {
      destructiveKind?: "pressure-retirement";
      phase: "deletion-rejected";
      deletionIssuedAtMs: number;
      rejectionConfirmedAtMs: number;
    })
  | (TelegramWorkspaceRetirementFenceBase & {
      phase: "commit-ready";
      absenceConfirmedAtMs: number;
      deletionIssuedAtMs?: number;
    });

export type TelegramWorkspaceDestructiveFence =
  TelegramWorkspaceRetirementFence | TelegramWorkspaceJournalWriterClosureFence;

export function isTelegramWorkspaceRetirementFence(
  fence: TelegramWorkspaceDestructiveFence,
): fence is TelegramWorkspaceRetirementFence {
  return fence.destructiveKind !== "journal-writer-closure";
}

export interface TelegramWorkspaceDeletionPermit {
  readonly destructiveKind?: TelegramWorkspaceDeletionFenceKind;
  readonly operationId: string;
  readonly retirementIntentId: string;
  readonly profileKey: string;
  readonly bindingKey: string;
  readonly slot: string | null;
  readonly target: TelegramTarget & { threadId: number };
  readonly leaderEpoch: number | string;
  readonly issuedAtMs: number;
}

interface TelegramWorkspaceAdmissionState {
  version: 1;
  profileKey: string;
  leases: TelegramWorkspaceAdmissionLease[];
  fence?: TelegramWorkspaceDestructiveFence;
  writerProtocolMode?: TelegramWorkspaceJournalWriterProtocolMode;
}

type TelegramWorkspaceAdmissionAcquireResult =
  | {
      kind: "acquired";
      lease: TelegramWorkspaceAdmissionLease;
      resumed: boolean;
    }
  | { kind: "blocked"; reason: "retirement-fenced" };

type TelegramWorkspaceRetirementFenceAcquireResult =
  | {
      kind: "acquired";
      fence: TelegramWorkspaceRetirementFence;
      resumed: boolean;
    }
  | {
      kind: "blocked";
      reason: "admission-active" | "retirement-active";
    };

type TelegramWorkspaceJournalWriterProtocolInstallResult = {
  mode: TelegramWorkspaceJournalWriterProtocolMode;
  resumed: boolean;
};

type TelegramWorkspaceJournalWriterClosureAcquireResult =
  | {
      kind: "acquired";
      fence: TelegramWorkspaceJournalWriterClosureFence;
      resumed: boolean;
    }
  | { kind: "blocked"; reason: "admission-active" | "retirement-active" };

type TelegramWorkspaceDeletionPermitResult =
  | {
      kind: "issued";
      fence: TelegramWorkspaceRetirementFence;
      permit: TelegramWorkspaceDeletionPermit;
    }
  | { kind: "already-issued"; fence: TelegramWorkspaceRetirementFence };

interface TelegramWorkspaceAdmissionLedgerSnapshot {
  profileKey: string;
  leases: TelegramWorkspaceAdmissionLease[];
  fence?: TelegramWorkspaceDestructiveFence;
  writerProtocolMode?: TelegramWorkspaceJournalWriterProtocolMode;
}

type TelegramWorkspaceAdmissionPublicationBoundary =
  "before-write" | "after-write-before-rename";

interface TelegramWorkspaceAdmissionLedgerOptions {
  path: string;
  /** Explicit logical section identity for the consolidated root; absent means the standalone ledger adapter. */
  stateProfile?: string;
  profileKey: string;
  owner: TelegramWorkspaceAdmissionOwner;
  getNowMs?: () => number;
  getProcessLiveness?: (
    owner: TelegramWorkspaceAdmissionOwner,
  ) => TelegramProcessLiveness;
  publishRename?: (sourcePath: PathLike, destinationPath: PathLike) => void;
  onPublicationBoundary?: (
    boundary: TelegramWorkspaceAdmissionPublicationBoundary,
    path: string,
  ) => void;
  authorizeJournalWriterProtocolClosure?: (input: {
    mode: TelegramWorkspaceJournalWriterProtocolMode;
    closure: TelegramWorkspaceJournalWriterClosureFence;
  }) => boolean;
}

export class TelegramWorkspaceAdmissionError extends Error {
  readonly code:
    | "invalid-input"
    | "invalid-state"
    | "state-unavailable"
    | "authority-changed"
    | "admission-blocked"
    | "publication-unknown";

  constructor(
    code: TelegramWorkspaceAdmissionError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelegramWorkspaceAdmissionError";
    this.code = code;
  }
}

export interface TelegramWorkspaceAdmissionLedger {
  getProfileKey: () => string;
  getOwner: () => TelegramWorkspaceAdmissionOwner;
  listReservedSlots: () => string[];
  read: () => TelegramWorkspaceAdmissionLedgerSnapshot;
  acquireAdmission: (input: {
    operationId: string;
    operationKind: string;
    scope: TelegramWorkspaceAdmissionScope;
  }) => TelegramWorkspaceAdmissionAcquireResult;
  releaseAdmission: (expected: TelegramWorkspaceAdmissionLease) => boolean;
  acquireJournalWriterClosure: (input: {
    operationId: string;
    recoveryKey: string;
    requestedAtMs: number;
  }) => TelegramWorkspaceJournalWriterClosureAcquireResult;
  releaseJournalWriterClosure: (
    expected: TelegramWorkspaceJournalWriterClosureFence,
  ) => boolean;
  installJournalWriterProtocolMode: (
    expected: TelegramWorkspaceJournalWriterClosureFence,
    input: { startupAuthorityId: string; writerInventorySha256: string },
  ) => TelegramWorkspaceJournalWriterProtocolInstallResult;
  acquireJournalWriterAdmission: (input: {
    operationId: string;
    recoveryKey: string;
    startupAuthorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
  }) => TelegramWorkspaceAdmissionAcquireResult;
  acquireRetirementFence: (input: {
    operationId: string;
    retirementIntentId: string;
    bindingKey: string;
    slot: string;
    target: TelegramTarget & { threadId: number };
    leaderEpoch: number | string;
    retirementRequestedAtMs: number;
  }) => TelegramWorkspaceRetirementFenceAcquireResult;
  acquireThreadCleanupFence: (input: {
    operationId: string;
    cleanupWorkSetId: string;
    bindingKey: string;
    slot: string | null;
    target: TelegramTarget & { threadId: number };
    leaderEpoch: number | string;
    cleanupRequestedAtMs: number;
  }) => TelegramWorkspaceRetirementFenceAcquireResult;
  adoptRetirementFence: (
    expected: TelegramWorkspaceRetirementFence,
    replacement: {
      owner: TelegramWorkspaceAdmissionOwner;
      leaderEpoch: number | string;
    },
  ) => TelegramWorkspaceRetirementFence;
  adoptThreadCleanupFence: TelegramWorkspaceAdmissionLedger["adoptRetirementFence"];
  issueDeletionPermit: (
    expected: TelegramWorkspaceRetirementFence,
  ) => TelegramWorkspaceDeletionPermitResult;
  issueThreadCleanupDeletionPermit: TelegramWorkspaceAdmissionLedger["issueDeletionPermit"];
  confirmRetirementAbsence: (
    expected: TelegramWorkspaceRetirementFence,
  ) => TelegramWorkspaceRetirementFence;
  confirmThreadCleanupAbsence: TelegramWorkspaceAdmissionLedger["confirmRetirementAbsence"];
  /** Caller must have exact transport proof of rejection, never merely target presence. */
  confirmRetirementRejection: (
    expected: TelegramWorkspaceRetirementFence,
  ) => TelegramWorkspaceRetirementFence;
  /** Caller must first durably withdraw the exact rejected intent, retaining its binding. */
  completeRejectedRetirementFence: (
    expected: TelegramWorkspaceRetirementFence,
  ) => boolean;
  releaseUnissuedRetirementFence: (
    expected: TelegramWorkspaceRetirementFence,
  ) => boolean;
  releaseUnissuedThreadCleanupFence: TelegramWorkspaceAdmissionLedger["releaseUnissuedRetirementFence"];
  completeRetirementFence: (
    expected: TelegramWorkspaceRetirementFence,
  ) => boolean;
  completeThreadCleanupFence: TelegramWorkspaceAdmissionLedger["completeRetirementFence"];
}

function invalidInput(message: string): never {
  throw new TelegramWorkspaceAdmissionError("invalid-input", message);
}

function invalidState(message: string, cause?: unknown): never {
  throw new TelegramWorkspaceAdmissionError("invalid-state", message, {
    cause,
  });
}

function authorityChanged(message: string): never {
  throw new TelegramWorkspaceAdmissionError("authority-changed", message);
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= TELEGRAM_WORKSPACE_ADMISSION_MAX_TEXT
  );
}

function isLeaderEpoch(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    isBoundedText(value)
  );
}

function normalizeTarget(
  value: unknown,
): (TelegramTarget & { threadId: number }) | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.chatId) ||
    value.chatId === 0 ||
    !Number.isSafeInteger(value.threadId) ||
    (value.threadId as number) <= 0
  ) {
    return undefined;
  }
  return { chatId: value.chatId as number, threadId: value.threadId as number };
}

function normalizeOwner(
  value: unknown,
): TelegramWorkspaceAdmissionOwner | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    !isBoundedText(value.processBirthId) ||
    !value.processBirthId.startsWith(`${value.processId}:`)
  ) {
    return undefined;
  }
  return {
    processId: value.processId as number,
    processBirthId: value.processBirthId,
  };
}

function normalizeScope(
  value: unknown,
): TelegramWorkspaceAdmissionScope | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "profile") return { kind: "profile" };
  if (value.kind === "chat") {
    if (!Number.isSafeInteger(value.chatId) || value.chatId === 0)
      return undefined;
    return { kind: "chat", chatId: value.chatId as number };
  }
  if (value.kind === "target") {
    const target = normalizeTarget(value.target);
    return target ? { kind: "target", target } : undefined;
  }
  return undefined;
}

function normalizeLease(
  value: unknown,
  profileKey: string,
): TelegramWorkspaceAdmissionLease | undefined {
  if (!isRecord(value)) return undefined;
  const scope = normalizeScope(value.scope);
  const owner = normalizeOwner(value.owner);
  if (
    !isBoundedText(value.operationId) ||
    !isBoundedText(value.operationKind) ||
    value.profileKey !== profileKey ||
    !scope ||
    !owner ||
    !isSafeTimestamp(value.acquiredAtMs)
  ) {
    return undefined;
  }
  return {
    operationId: value.operationId,
    operationKind: value.operationKind,
    profileKey,
    scope,
    owner,
    acquiredAtMs: value.acquiredAtMs,
  };
}

function normalizeFence(
  value: unknown,
  profileKey: string,
): TelegramWorkspaceDestructiveFence | undefined {
  if (!isRecord(value)) return undefined;
  if (value.destructiveKind === "journal-writer-closure")
    return normalizeTelegramWorkspaceJournalWriterClosureFence(
      value,
      profileKey,
    );
  const target = normalizeTarget(value.target);
  const owner = normalizeOwner(value.owner);
  if (
    !isBoundedText(value.operationId) ||
    !isBoundedText(value.retirementIntentId) ||
    value.profileKey !== profileKey ||
    !isBoundedText(value.bindingKey) ||
    !((typeof value.slot === "string" && /^[A-Z]$/u.test(value.slot)) ||
      (value.destructiveKind === "manual-thread-cleanup" && value.slot === null)) ||
    !target ||
    !isLeaderEpoch(value.leaderEpoch) ||
    !isSafeTimestamp(value.retirementRequestedAtMs) ||
    !owner ||
    !isSafeTimestamp(value.acquiredAtMs)
  ) {
    return undefined;
  }
  if (
    value.destructiveKind !== undefined &&
    value.destructiveKind !== "pressure-retirement" &&
    value.destructiveKind !== "manual-thread-cleanup"
  )
    return undefined;
  const base: TelegramWorkspaceRetirementFenceBase = {
    ...(value.destructiveKind === undefined
      ? {}
      : { destructiveKind: value.destructiveKind }),
    operationId: value.operationId,
    retirementIntentId: value.retirementIntentId,
    profileKey,
    bindingKey: value.bindingKey,
    slot: value.slot,
    target,
    leaderEpoch: value.leaderEpoch,
    retirementRequestedAtMs: value.retirementRequestedAtMs,
    owner,
    acquiredAtMs: value.acquiredAtMs,
  };
  if (value.phase === "fenced") return { ...base, phase: "fenced" };
  if (
    value.phase === "deletion-issued" &&
    isSafeTimestamp(value.deletionIssuedAtMs)
  ) {
    return {
      ...base,
      phase: "deletion-issued",
      deletionIssuedAtMs: value.deletionIssuedAtMs,
    };
  }
  if (
    value.phase === "deletion-rejected" &&
    (value.destructiveKind === undefined ||
      value.destructiveKind === "pressure-retirement") &&
    isSafeTimestamp(value.deletionIssuedAtMs) &&
    isSafeTimestamp(value.rejectionConfirmedAtMs)
  ) {
    const { destructiveKind: _kind, ...pressureBase } = base;
    return {
      ...pressureBase,
      ...(value.destructiveKind === "pressure-retirement"
        ? { destructiveKind: "pressure-retirement" as const }
        : {}),
      phase: "deletion-rejected",
      deletionIssuedAtMs: value.deletionIssuedAtMs,
      rejectionConfirmedAtMs: value.rejectionConfirmedAtMs,
    };
  }
  if (
    value.phase === "commit-ready" &&
    isSafeTimestamp(value.absenceConfirmedAtMs) &&
    (value.deletionIssuedAtMs === undefined ||
      isSafeTimestamp(value.deletionIssuedAtMs))
  ) {
    return {
      ...base,
      phase: "commit-ready",
      absenceConfirmedAtMs: value.absenceConfirmedAtMs,
      ...(value.deletionIssuedAtMs === undefined
        ? {}
        : { deletionIssuedAtMs: value.deletionIssuedAtMs }),
    };
  }
  return undefined;
}

function cloneScope(
  scope: TelegramWorkspaceAdmissionScope,
): TelegramWorkspaceAdmissionScope {
  return scope.kind === "target"
    ? { kind: "target", target: { ...scope.target } }
    : { ...scope };
}

function cloneLease(
  lease: TelegramWorkspaceAdmissionLease,
): TelegramWorkspaceAdmissionLease {
  return {
    ...lease,
    scope: cloneScope(lease.scope),
    owner: { ...lease.owner },
  };
}

export function resolveTelegramWorkspaceDestructiveFenceKind(fence: {
  destructiveKind?: TelegramWorkspaceDestructiveFenceKind;
}): TelegramWorkspaceDestructiveFenceKind {
  return fence.destructiveKind ?? "pressure-retirement";
}

function cloneFence(
  fence: TelegramWorkspaceRetirementFence,
): TelegramWorkspaceRetirementFence;
function cloneFence(
  fence: TelegramWorkspaceJournalWriterClosureFence,
): TelegramWorkspaceJournalWriterClosureFence;
function cloneFence(
  fence: TelegramWorkspaceDestructiveFence,
): TelegramWorkspaceDestructiveFence;
function cloneFence(
  fence: TelegramWorkspaceDestructiveFence,
): TelegramWorkspaceDestructiveFence {
  return isTelegramWorkspaceRetirementFence(fence)
    ? { ...fence, target: { ...fence.target }, owner: { ...fence.owner } }
    : { ...fence, owner: { ...fence.owner } };
}

function readState(
  path: string,
  profileKey: string,
): TelegramWorkspaceAdmissionState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return {
        version: TELEGRAM_WORKSPACE_ADMISSION_VERSION,
        profileKey,
        leases: [],
      };
    }
    throw new TelegramWorkspaceAdmissionError(
      "state-unavailable",
      "Telegram Workspace admission state is unavailable.",
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    invalidState("Telegram Workspace admission state is malformed.", error);
  }
  return normalizeAdmissionState(parsed, profileKey);
}

function isConsolidatedAdmissionKey(value: unknown, profile: string): boolean {
  if (!isBoundedText(value)) return false;
  try {
    const key: unknown = JSON.parse(value);
    return (
      isRecord(key) &&
      Object.keys(key).length === 3 &&
      key.version === TELEGRAM_WORKSPACE_ADMISSION_VERSION &&
      key.profile === profile &&
      isRecord(key.bot) &&
      Object.keys(key.bot).length === 1 &&
      typeof key.bot.tokenSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(key.bot.tokenSha256)
    );
  } catch {
    return false;
  }
}
/** Pure damage check for one consolidated admission section under its own stored profile key; throws when invalid. */
export function assertTelegramConsolidatedAdmissionSection(
  value: unknown,
  stateProfile: string,
): void {
  if (value === undefined) return;
  normalizeAdmissionState(
    value,
    isRecord(value) && typeof value.profileKey === "string"
      ? value.profileKey
      : "",
    stateProfile,
  );
}

function normalizeAdmissionState(
  parsed: unknown,
  profileKey: string,
  stateProfile?: string,
): TelegramWorkspaceAdmissionState {
  if (parsed === undefined)
    return {
      version: TELEGRAM_WORKSPACE_ADMISSION_VERSION,
      profileKey,
      leases: [],
    };
  if (!isRecord(parsed))
    invalidState("Telegram Workspace admission state is invalid.");
  if (
    stateProfile !== undefined &&
    (Object.keys(parsed).some(
      (key) =>
        ![
          "version",
          "profileKey",
          "leases",
          "fence",
          "writerProtocolMode",
        ].includes(key),
    ) ||
      !isConsolidatedAdmissionKey(parsed.profileKey, stateProfile))
  )
    invalidState(
      "Telegram consolidated admission section identity is invalid.",
    );
  if (
    parsed.version !== TELEGRAM_WORKSPACE_ADMISSION_VERSION ||
    !Array.isArray(parsed.leases) ||
    parsed.leases.length > TELEGRAM_WORKSPACE_ADMISSION_MAX_LEASES
  ) {
    invalidState("Telegram Workspace admission state authority is invalid.");
  }
  if (parsed.profileKey !== profileKey) {
    if (
      parsed.leases.length === 0 &&
      parsed.fence === undefined &&
      parsed.writerProtocolMode === undefined
    ) {
      return {
        version: TELEGRAM_WORKSPACE_ADMISSION_VERSION,
        profileKey,
        leases: [],
      };
    }
    invalidState("Telegram Workspace admission profile authority changed.");
  }
  const leases = parsed.leases.map((value) =>
    normalizeLease(value, profileKey),
  );
  if (leases.some((lease) => lease === undefined)) {
    invalidState("Telegram Workspace admission lease is invalid.");
  }
  const normalizedLeases = leases as TelegramWorkspaceAdmissionLease[];
  if (
    new Set(normalizedLeases.map((lease) => lease.operationId)).size !==
    normalizedLeases.length
  ) {
    invalidState("Telegram Workspace admission lease identity is duplicated.");
  }
  const fence =
    parsed.fence === undefined
      ? undefined
      : normalizeFence(parsed.fence, profileKey);
  if (parsed.fence !== undefined && !fence) {
    invalidState("Telegram Workspace retirement fence is invalid.");
  }
  const writerProtocolMode =
    parsed.writerProtocolMode === undefined
      ? undefined
      : normalizeTelegramWorkspaceJournalWriterProtocolMode(
          parsed.writerProtocolMode,
          profileKey,
        );
  if (parsed.writerProtocolMode !== undefined && !writerProtocolMode)
    invalidState("Telegram Workspace writer protocol mode is invalid.");
  if (fence && writerProtocolMode)
    invalidState(
      "Telegram Workspace destructive fence conflicts with writer protocol mode.",
    );
  if (
    stateProfile !== undefined &&
    (!isDeepStrictEqual(parsed.leases, normalizedLeases) ||
      !isDeepStrictEqual(parsed.fence, fence) ||
      !isDeepStrictEqual(parsed.writerProtocolMode, writerProtocolMode))
  )
    invalidState(
      "Telegram consolidated admission evidence cannot drop unknown fields.",
    );
  return {
    version: TELEGRAM_WORKSPACE_ADMISSION_VERSION,
    profileKey,
    leases: normalizedLeases,
    ...(fence ? { fence } : {}),
    ...(writerProtocolMode ? { writerProtocolMode } : {}),
  };
}

function writeState(
  path: string,
  state: TelegramWorkspaceAdmissionState,
  options: Pick<
    TelegramWorkspaceAdmissionLedgerOptions,
    "publishRename" | "onPublicationBoundary"
  >,
): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    options.onPublicationBoundary?.("before-write", path);
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tempPath, 0o600);
    options.onPublicationBoundary?.("after-write-before-rename", path);
    try {
      if (
        !renameTelegramPathWithRetry(tempPath, path, {
          ...(options.publishRename ? { rename: options.publishRename } : {}),
        })
      ) {
        throw new Error(
          "Temporary admission state disappeared before publication.",
        );
      }
      chmodSync(path, 0o600);
    } catch (error) {
      throw new TelegramWorkspaceAdmissionError(
        "publication-unknown",
        "Telegram Workspace admission publication outcome is unknown.",
        { cause: error },
      );
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // A successful atomic rename consumes the temporary path.
    }
  }
}

function scopesConflict(
  scope: TelegramWorkspaceAdmissionScope,
  target: TelegramTarget & { threadId: number },
): boolean {
  if (scope.kind === "profile") return true;
  if (scope.kind === "chat") return scope.chatId === target.chatId;
  return areTargetsEqual(scope.target, target);
}

function areOwnersEqual(
  left: TelegramWorkspaceAdmissionOwner,
  right: TelegramWorkspaceAdmissionOwner,
): boolean {
  return (
    left.processId === right.processId &&
    left.processBirthId === right.processBirthId
  );
}

function areScopesEqual(
  left: TelegramWorkspaceAdmissionScope,
  right: TelegramWorkspaceAdmissionScope,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "profile" && right.kind === "profile") return true;
  if (left.kind === "chat" && right.kind === "chat") {
    return left.chatId === right.chatId;
  }
  return (
    left.kind === "target" &&
    right.kind === "target" &&
    areTargetsEqual(left.target, right.target)
  );
}

function areLeasesEqual(
  left: TelegramWorkspaceAdmissionLease,
  right: TelegramWorkspaceAdmissionLease,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.operationKind === right.operationKind &&
    left.profileKey === right.profileKey &&
    areScopesEqual(left.scope, right.scope) &&
    areOwnersEqual(left.owner, right.owner) &&
    left.acquiredAtMs === right.acquiredAtMs
  );
}

function areFenceBasesEqual(
  left: TelegramWorkspaceRetirementFence,
  right: TelegramWorkspaceRetirementFence,
): boolean {
  return (
    resolveTelegramWorkspaceDestructiveFenceKind(left) ===
      resolveTelegramWorkspaceDestructiveFenceKind(right) &&
    left.operationId === right.operationId &&
    left.retirementIntentId === right.retirementIntentId &&
    left.profileKey === right.profileKey &&
    left.bindingKey === right.bindingKey &&
    left.slot === right.slot &&
    areTargetsEqual(left.target, right.target) &&
    left.leaderEpoch === right.leaderEpoch &&
    left.retirementRequestedAtMs === right.retirementRequestedAtMs &&
    areOwnersEqual(left.owner, right.owner) &&
    left.acquiredAtMs === right.acquiredAtMs
  );
}

function areWriterProtocolModesEqual(
  left: TelegramWorkspaceJournalWriterProtocolMode,
  right: TelegramWorkspaceJournalWriterProtocolMode,
): boolean {
  return (
    left.protocol === right.protocol &&
    left.profileKey === right.profileKey &&
    left.recoveryKey === right.recoveryKey &&
    left.startupAuthorityId === right.startupAuthorityId &&
    left.closureOperationId === right.closureOperationId &&
    left.writerInventorySha256 === right.writerInventorySha256 &&
    areOwnersEqual(left.installedBy, right.installedBy) &&
    left.installedAtMs === right.installedAtMs
  );
}

function areWriterClosureFencesEqual(
  left: TelegramWorkspaceJournalWriterClosureFence,
  right: TelegramWorkspaceJournalWriterClosureFence,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.profileKey === right.profileKey &&
    left.recoveryKey === right.recoveryKey &&
    areOwnersEqual(left.owner, right.owner) &&
    left.requestedAtMs === right.requestedAtMs &&
    left.acquiredAtMs === right.acquiredAtMs
  );
}

function areFencesEqual(
  left: TelegramWorkspaceRetirementFence,
  right: TelegramWorkspaceRetirementFence,
): boolean {
  if (!areFenceBasesEqual(left, right) || left.phase !== right.phase)
    return false;
  if (left.phase === "fenced" && right.phase === "fenced") return true;
  if (left.phase === "deletion-issued" && right.phase === "deletion-issued") {
    return left.deletionIssuedAtMs === right.deletionIssuedAtMs;
  }
  if (
    left.phase === "deletion-rejected" &&
    right.phase === "deletion-rejected"
  ) {
    return (
      left.deletionIssuedAtMs === right.deletionIssuedAtMs &&
      left.rejectionConfirmedAtMs === right.rejectionConfirmedAtMs
    );
  }
  return (
    left.phase === "commit-ready" &&
    right.phase === "commit-ready" &&
    left.absenceConfirmedAtMs === right.absenceConfirmedAtMs &&
    left.deletionIssuedAtMs === right.deletionIssuedAtMs
  );
}

function validateOptions(
  options: TelegramWorkspaceAdmissionLedgerOptions,
): void {
  if (!isBoundedText(options.path)) {
    invalidInput("Telegram Workspace admission path is required.");
  }
  if (!isBoundedText(options.profileKey)) {
    invalidInput("Telegram Workspace admission profile authority is required.");
  }
  if (!normalizeOwner(options.owner)) {
    invalidInput("Telegram Workspace admission owner is invalid.");
  }
  if (
    options.stateProfile !== undefined &&
    (!isBoundedText(options.stateProfile) ||
      !isConsolidatedAdmissionKey(options.profileKey, options.stateProfile))
  )
    invalidInput(
      "Telegram consolidated admission requires an exact bot/profile section identity.",
    );
}

function validateOperationId(operationId: string): void {
  if (!isBoundedText(operationId)) {
    invalidInput("Telegram Workspace admission operation identity is invalid.");
  }
}

function validateScope(scope: TelegramWorkspaceAdmissionScope): void {
  if (!normalizeScope(scope)) {
    invalidInput("Telegram Workspace admission scope is invalid.");
  }
}

function validateExpectedLease(
  lease: TelegramWorkspaceAdmissionLease,
  profileKey: string,
): void {
  if (!normalizeLease(lease, profileKey)) {
    invalidInput("Telegram Workspace admission lease authority is invalid.");
  }
}

function validateExpectedFence(
  fence: TelegramWorkspaceRetirementFence,
  profileKey: string,
): void {
  if (!normalizeFence(fence, profileKey)) {
    invalidInput("Telegram Workspace retirement fence authority is invalid.");
  }
}

export function createTelegramWorkspaceAdmissionOperationId(): string {
  return randomUUID();
}

export function createTelegramWorkspaceAdmissionProfileKey(input: {
  profileName?: string;
  botToken: string;
}): string {
  const profileName = (input.profileName ?? "default").trim();
  if (!isBoundedText(profileName) || !isBoundedText(input.botToken)) {
    invalidInput(
      "Telegram Workspace admission bot/profile identity is invalid.",
    );
  }
  return JSON.stringify({
    version: TELEGRAM_WORKSPACE_ADMISSION_VERSION,
    profile: profileName,
    bot: {
      tokenSha256: createHash("sha256").update(input.botToken).digest("hex"),
    },
  });
}

interface TelegramWorkspaceAdmissionRuntimeBinding {
  resolve: () => TelegramWorkspaceAdmissionLedger | undefined;
}

export function createTelegramWorkspaceAdmissionRuntimeBinding(
  input: {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    owner: TelegramWorkspaceAdmissionOwner;
    getNowMs?: () => number;
    getProcessLiveness?: (
      owner: TelegramWorkspaceAdmissionOwner,
    ) => TelegramProcessLiveness;
  } & (
    | { getPath: (profileName?: string) => string; getStatePath?: never }
    | { getStatePath: () => string; getPath?: never }
  ),
): TelegramWorkspaceAdmissionRuntimeBinding {
  const { getProfileName, getBotToken, getPath, getStatePath } = input;
  if ((getPath === undefined) === (getStatePath === undefined))
    invalidInput(
      "Telegram admission binding must select one storage identity.",
    );
  let current: {
    ledger: TelegramWorkspaceAdmissionLedger;
    options: TelegramWorkspaceAdmissionLedgerOptions;
    authority: TelegramWorkspaceAdmissionLedgerOptions;
    botToken: string;
  } | undefined;
  return {
    resolve() {
      try {
        const botToken = getBotToken();
        if (!botToken) {
          current = undefined;
          return undefined;
        }
        const configuredProfileName = getProfileName();
        const profileKey = createTelegramWorkspaceAdmissionProfileKey({
          profileName: configuredProfileName ?? "default",
          botToken,
        });
        const options: TelegramWorkspaceAdmissionLedgerOptions = {
          path: getStatePath ? getStatePath() : getPath!(configuredProfileName),
          ...(getStatePath
            ? { stateProfile: configuredProfileName ?? "default" }
            : {}),
          profileKey,
          owner: input.owner,
          getNowMs: input.getNowMs,
          getProcessLiveness: input.getProcessLiveness,
        };
        // Validate even on reuse; snapshot metadata separately from the ledger's live owner fence.
        validateOptions(options);
        const authority = { ...options, owner: { ...options.owner },
          getNowMs: options.getNowMs ?? Date.now,
          getProcessLiveness: options.getProcessLiveness ?? getTelegramProcessLiveness };
        if (current && current.botToken === botToken &&
          current.authority.path === authority.path &&
          current.authority.stateProfile === authority.stateProfile &&
          current.authority.profileKey === authority.profileKey &&
          areOwnersEqual(current.authority.owner, authority.owner) &&
          areOwnersEqual(current.options.owner, current.authority.owner) &&
          current.authority.getNowMs === authority.getNowMs &&
          current.authority.getProcessLiveness === authority.getProcessLiveness)
          return current.ledger;
        current = undefined;
        const ledger = createTelegramWorkspaceAdmissionLedger(options);
        current = { ledger, options, authority, botToken };
        return ledger;
      } catch (error) {
        current = undefined;
        throw error;
      }
    },
  };
}

/** Stable admission-scope identity used by leases and admission-gated journal operations. */
export function getTelegramWorkspaceAdmissionScopeKey(
  scope: TelegramWorkspaceAdmissionScope,
): string {
  if (scope.kind === "profile") return "profile";
  if (scope.kind === "chat") return `chat:${scope.chatId}`;
  return `target:${scope.target.chatId}:${scope.target.threadId}`;
}

function reserveTelegramWorkspaceAdmissionOperationId(
  operationId: string,
): () => void {
  if (activeTelegramWorkspaceAdmissionOperationIds.has(operationId)) {
    invalidState("Telegram Workspace admission operation is already active.");
  }
  activeTelegramWorkspaceAdmissionOperationIds.add(operationId);
  return () => {
    activeTelegramWorkspaceAdmissionOperationIds.delete(operationId);
  };
}

/** Validated, de-duplicated scopes in the stable key order every admitted operation acquires. */
function normalizeTelegramWorkspaceAdmittedScopes(input: {
  operationId: string;
  operationKind: string;
  scopes: readonly TelegramWorkspaceAdmissionScope[];
}): TelegramWorkspaceAdmissionScope[] {
  validateOperationId(input.operationId);
  if (!isBoundedText(input.operationKind) || input.scopes.length === 0) {
    invalidInput("Telegram Workspace admitted operation is invalid.");
  }
  const uniqueScopes = new Map<string, TelegramWorkspaceAdmissionScope>();
  for (const scope of input.scopes) {
    validateScope(scope);
    uniqueScopes.set(
      getTelegramWorkspaceAdmissionScopeKey(scope),
      cloneScope(scope),
    );
  }
  return Array.from(uniqueScopes.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
}

/** Appends each lease as it is acquired so a blocked or failed scope leaves earlier leases releasable. */
function acquireTelegramWorkspaceAdmittedScopes(
  input: {
    ledger: Pick<TelegramWorkspaceAdmissionLedger, "acquireAdmission">;
    operationId: string;
    operationKind: string;
  },
  scopes: readonly TelegramWorkspaceAdmissionScope[],
  acquired: TelegramWorkspaceAdmissionLease[],
): void {
  for (const scope of scopes) {
    const scopeOperationId = `admission:${createHash("sha256")
      .update(input.operationId)
      .update("\0")
      .update(getTelegramWorkspaceAdmissionScopeKey(scope))
      .digest("hex")}`;
    const result = input.ledger.acquireAdmission({
      operationId: scopeOperationId,
      operationKind: input.operationKind,
      scope,
    });
    if (result.kind === "blocked") {
      throw new TelegramWorkspaceAdmissionError(
        "admission-blocked",
        "Telegram Workspace operation is blocked by retirement.",
      );
    }
    acquired.push(result.lease);
  }
}

export function runWithTelegramWorkspaceAdmissions<T>(input: {
  ledger: Pick<
    TelegramWorkspaceAdmissionLedger,
    "acquireAdmission" | "releaseAdmission"
  >;
  operationId: string;
  operationKind: string;
  scopes: readonly TelegramWorkspaceAdmissionScope[];
  operation: () => T;
}): T {
  const scopes = normalizeTelegramWorkspaceAdmittedScopes(input);
  const releaseActiveOperation = reserveTelegramWorkspaceAdmissionOperationId(
    input.operationId,
  );
  const acquired: TelegramWorkspaceAdmissionLease[] = [];
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    acquireTelegramWorkspaceAdmittedScopes(input, scopes, acquired);
    outcome = { ok: true, value: input.operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const releaseErrors: unknown[] = [];
  for (const lease of acquired.reverse()) {
    try {
      input.ledger.releaseAdmission(lease);
    } catch (error) {
      releaseErrors.push(error);
    }
  }
  releaseActiveOperation();
  if (releaseErrors.length > 0) {
    throw new AggregateError(
      outcome.ok ? releaseErrors : [outcome.error, ...releaseErrors],
      "Telegram Workspace admission release failed.",
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export async function runWithTelegramWorkspaceAdmissionsAsync<T>(input: {
  ledger: Pick<
    TelegramWorkspaceAdmissionLedger,
    "acquireAdmission" | "releaseAdmission"
  >;
  operationId: string;
  operationKind: string;
  scopes: readonly TelegramWorkspaceAdmissionScope[];
  operation: () => Promise<T>;
  onReleaseError?: (error: unknown) => void;
}): Promise<T> {
  const scopes = normalizeTelegramWorkspaceAdmittedScopes(input);
  const releaseActiveOperation = reserveTelegramWorkspaceAdmissionOperationId(
    input.operationId,
  );
  const acquired: TelegramWorkspaceAdmissionLease[] = [];
  const releaseAll = (): void => {
    for (const lease of acquired.reverse()) {
      try {
        if (!input.ledger.releaseAdmission(lease)) {
          throw new TelegramWorkspaceAdmissionError(
            "authority-changed",
            "Telegram Workspace admission lease disappeared before release.",
          );
        }
      } catch (error) {
        try {
          input.onReleaseError?.(error);
        } catch {
          // Diagnostics cannot change the settled admitted operation.
        }
      }
    }
  };
  try {
    acquireTelegramWorkspaceAdmittedScopes(input, scopes, acquired);
  } catch (error) {
    releaseAll();
    releaseActiveOperation();
    throw error;
  }
  try {
    return await input.operation();
  } finally {
    releaseAll();
    releaseActiveOperation();
  }
}

export function createTelegramWorkspaceAdmissionLedger(
  options: TelegramWorkspaceAdmissionLedgerOptions,
): TelegramWorkspaceAdmissionLedger {
  validateOptions(options);
  const suppliedOptions = options;
  if (options.stateProfile !== undefined)
    options = { ...options, owner: { ...options.owner } };
  const getNowMs = options.getNowMs ?? Date.now;
  const getProcessLiveness =
    options.getProcessLiveness ??
    ((owner: TelegramWorkspaceAdmissionOwner) =>
      getTelegramProcessLiveness(owner));
  const transactionPath = `${options.path}.transaction`;
  const path = options.path,
    profileKey = options.profileKey,
    stateProfile = options.stateProfile,
    boundOwner = { ...options.owner };
  const publication = {
    publishRename: options.publishRename,
    onPublicationBoundary: options.onPublicationBoundary,
  };
  const isStorageCurrent = (): boolean =>
    suppliedOptions.path === path &&
    suppliedOptions.profileKey === profileKey &&
    suppliedOptions.stateProfile === stateProfile &&
    areOwnersEqual(suppliedOptions.owner, boundOwner);
  const mapStateError = (error: unknown): never => {
    if (error instanceof TelegramRuntimeStateError)
      throw new TelegramWorkspaceAdmissionError(
        error.code === "invalid" ? "invalid-state" : error.code,
        "Telegram consolidated admission state operation failed.",
        { cause: error },
      );
    throw error;
  };

  function transact<T>(
    operation: (state: TelegramWorkspaceAdmissionState) => {
      result: T;
      changed: boolean;
    },
  ): T {
    if (stateProfile !== undefined) {
      try {
        return mutateTelegramRuntimeStateSection(
          path,
          stateProfile,
          "admission",
          (current) => {
            const state = normalizeAdmissionState(
              current,
              profileKey,
              stateProfile,
            );
            const retained = state.leases.filter(
              (lease) => getProcessLiveness(lease.owner) !== "dead",
            );
            const pruned = retained.length !== state.leases.length;
            state.leases = retained;
            const outcome = operation(state);
            return {
              value:
                pruned || outcome.changed
                  ? normalizeAdmissionState(state, profileKey, stateProfile)
                  : current,
              result: outcome.result,
            };
          },
          {
            isCurrent: isStorageCurrent,
            publishRename: publication.publishRename,
            onPublicationBoundary(boundary) {
              if (boundary !== "after-rename")
                publication.onPublicationBoundary?.(boundary, path);
            },
          },
        );
      } catch (error) {
        return mapStateError(error);
      }
    }
    return withTelegramFileTransaction(transactionPath, () => {
      const state = readState(options.path, options.profileKey);
      const retainedLeases = state.leases.filter(
        (lease) => getProcessLiveness(lease.owner) !== "dead",
      );
      const pruned = retainedLeases.length !== state.leases.length;
      if (pruned) state.leases = retainedLeases;
      const outcome = operation(state);
      if (pruned || outcome.changed) writeState(options.path, state, options);
      return outcome.result;
    });
  }

  function read(): TelegramWorkspaceAdmissionLedgerSnapshot {
    let state: TelegramWorkspaceAdmissionState;
    if (stateProfile !== undefined) {
      if (!isStorageCurrent())
        authorityChanged(
          "Telegram consolidated admission storage authority changed.",
        );
      try {
        const file = readTelegramRuntimeState(path);
        const value = Object.hasOwn(file.profiles, stateProfile)
          ? file.profiles[stateProfile]?.admission
          : undefined;
        state = normalizeAdmissionState(value, profileKey, stateProfile);
        if (!isStorageCurrent())
          authorityChanged(
            "Telegram consolidated admission storage authority changed.",
          );
      } catch (error) {
        return mapStateError(error);
      }
    } else state = readState(options.path, options.profileKey);
    return {
      profileKey: state.profileKey,
      leases: state.leases.map(cloneLease),
      ...(state.fence ? { fence: cloneFence(state.fence) } : {}),
      ...(state.writerProtocolMode
        ? {
            writerProtocolMode: {
              ...state.writerProtocolMode,
              installedBy: { ...state.writerProtocolMode.installedBy },
            },
          }
        : {}),
    };
  }

  function acquireAdmission(input: {
    operationId: string;
    operationKind: string;
    scope: TelegramWorkspaceAdmissionScope;
  }): TelegramWorkspaceAdmissionAcquireResult {
    validateOperationId(input.operationId);
    if (!isBoundedText(input.operationKind)) {
      invalidInput("Telegram Workspace admission operation kind is invalid.");
    }
    validateScope(input.scope);
    return transact<TelegramWorkspaceAdmissionAcquireResult>((state) => {
      const journalOperation =
        input.operationKind === "journal-write" ||
        input.operationKind.startsWith("journal.");
      const protocolWriterHeld = state.leases.some(
        (lease) =>
          lease.operationKind === "journal-write:custody-v3" &&
          lease.scope.kind === "profile" &&
          areOwnersEqual(lease.owner, options.owner),
      );
      if (state.writerProtocolMode && journalOperation && !protocolWriterHeld)
        authorityChanged(
          "Telegram Workspace journal writer requires protocol authority.",
        );
      const existing = state.leases.find(
        (lease) => lease.operationId === input.operationId,
      );
      if (existing) {
        const retried: TelegramWorkspaceAdmissionLease = {
          operationId: input.operationId,
          operationKind: input.operationKind,
          profileKey: options.profileKey,
          scope: cloneScope(input.scope),
          owner: { ...options.owner },
          acquiredAtMs: existing.acquiredAtMs,
        };
        if (!areLeasesEqual(existing, retried)) {
          authorityChanged(
            "Telegram Workspace admission operation identity changed.",
          );
        }
        return {
          result: {
            kind: "acquired",
            lease: cloneLease(existing),
            resumed: true,
          },
          changed: false,
        };
      }
      if (
        state.fence &&
        (!isTelegramWorkspaceRetirementFence(state.fence) ||
          scopesConflict(input.scope, state.fence.target))
      ) {
        return {
          result: { kind: "blocked", reason: "retirement-fenced" },
          changed: false,
        };
      }
      if (state.leases.length >= TELEGRAM_WORKSPACE_ADMISSION_MAX_LEASES) {
        invalidState(
          "Telegram Workspace admission lease capacity is exhausted.",
        );
      }
      const lease: TelegramWorkspaceAdmissionLease = {
        operationId: input.operationId,
        operationKind: input.operationKind,
        profileKey: options.profileKey,
        scope: cloneScope(input.scope),
        owner: { ...options.owner },
        acquiredAtMs: getNowMs(),
      };
      state.leases.push(lease);
      return {
        result: { kind: "acquired", lease: cloneLease(lease), resumed: false },
        changed: true,
      };
    });
  }

  function releaseAdmission(
    expected: TelegramWorkspaceAdmissionLease,
  ): boolean {
    validateExpectedLease(expected, options.profileKey);
    if (!areOwnersEqual(expected.owner, options.owner)) {
      authorityChanged(
        "Telegram Workspace admission release requires lease owner authority.",
      );
    }
    return transact((state) => {
      const index = state.leases.findIndex(
        (lease) => lease.operationId === expected.operationId,
      );
      if (index < 0) return { result: false, changed: false };
      const current = state.leases[index];
      if (!areLeasesEqual(current, expected)) {
        authorityChanged(
          "Telegram Workspace admission lease authority changed.",
        );
      }
      state.leases.splice(index, 1);
      return { result: true, changed: true };
    });
  }

  function acquireJournalWriterClosure(input: {
    operationId: string;
    recoveryKey: string;
    requestedAtMs: number;
  }): TelegramWorkspaceJournalWriterClosureAcquireResult {
    validateOperationId(input.operationId);
    const candidate = normalizeTelegramWorkspaceJournalWriterClosureFence(
      {
        destructiveKind: "journal-writer-closure",
        phase: "fenced",
        ...input,
        profileKey: options.profileKey,
        owner: options.owner,
        acquiredAtMs: getNowMs(),
      },
      options.profileKey,
    );
    if (!candidate)
      invalidInput("Telegram Workspace writer closure input is invalid.");
    return transact<TelegramWorkspaceJournalWriterClosureAcquireResult>(
      (state) => {
        if (state.writerProtocolMode) {
          if (state.leases.length > 0)
            return {
              result: { kind: "blocked", reason: "admission-active" },
              changed: false,
            };
          let authorized = false;
          if (state.writerProtocolMode.recoveryKey === candidate.recoveryKey) {
            try {
              authorized =
                options.authorizeJournalWriterProtocolClosure?.({
                  mode: {
                    ...state.writerProtocolMode,
                    installedBy: { ...state.writerProtocolMode.installedBy },
                  },
                  closure: cloneFence(candidate),
                }) === true;
            } catch {
              authorized = false;
            }
          }
          if (!authorized)
            return {
              result: { kind: "blocked", reason: "retirement-active" },
              changed: false,
            };
          delete state.writerProtocolMode;
          state.fence = candidate;
          return {
            result: {
              kind: "acquired",
              fence: cloneFence(candidate),
              resumed: false,
            },
            changed: true,
          };
        }
        if (state.fence) {
          if (state.fence.destructiveKind === "journal-writer-closure") {
            const resumed = {
              ...candidate,
              acquiredAtMs: state.fence.acquiredAtMs,
            };
            if (areWriterClosureFencesEqual(state.fence, resumed))
              return {
                result: {
                  kind: "acquired",
                  fence: cloneFence(state.fence),
                  resumed: true,
                },
                changed: false,
              };
            if (state.fence.operationId === candidate.operationId)
              authorityChanged(
                "Telegram Workspace writer closure authority changed.",
              );
          }
          return {
            result: { kind: "blocked", reason: "retirement-active" },
            changed: false,
          };
        }
        if (state.leases.length > 0)
          return {
            result: { kind: "blocked", reason: "admission-active" },
            changed: false,
          };
        state.fence = candidate;
        return {
          result: {
            kind: "acquired",
            fence: cloneFence(candidate),
            resumed: false,
          },
          changed: true,
        };
      },
    );
  }

  function releaseJournalWriterClosure(
    expected: TelegramWorkspaceJournalWriterClosureFence,
  ): boolean {
    const normalized = normalizeTelegramWorkspaceJournalWriterClosureFence(
      expected,
      options.profileKey,
    );
    if (!normalized)
      invalidInput("Telegram Workspace writer closure authority is invalid.");
    if (!areOwnersEqual(expected.owner, options.owner))
      authorityChanged(
        "Telegram Workspace writer closure release requires owner authority.",
      );
    return transact((state) => {
      if (!state.fence) return { result: false, changed: false };
      if (
        state.fence.destructiveKind !== "journal-writer-closure" ||
        !areWriterClosureFencesEqual(state.fence, expected)
      )
        authorityChanged(
          "Telegram Workspace writer closure authority changed.",
        );
      delete state.fence;
      return { result: true, changed: true };
    });
  }

  function installJournalWriterProtocolMode(
    expected: TelegramWorkspaceJournalWriterClosureFence,
    input: { startupAuthorityId: string; writerInventorySha256: string },
  ): TelegramWorkspaceJournalWriterProtocolInstallResult {
    const normalizedClosure =
      normalizeTelegramWorkspaceJournalWriterClosureFence(
        expected,
        options.profileKey,
      );
    if (!normalizedClosure || !areOwnersEqual(expected.owner, options.owner))
      authorityChanged(
        "Telegram Workspace writer protocol installation requires closure owner authority.",
      );
    const candidate = normalizeTelegramWorkspaceJournalWriterProtocolMode(
      {
        version: 1,
        protocol: "custody-v3",
        profileKey: options.profileKey,
        recoveryKey: expected.recoveryKey,
        startupAuthorityId: input.startupAuthorityId,
        closureOperationId: expected.operationId,
        writerInventorySha256: input.writerInventorySha256,
        installedBy: options.owner,
        installedAtMs: getNowMs(),
      },
      options.profileKey,
    );
    if (!candidate)
      invalidInput("Telegram Workspace writer protocol mode input is invalid.");
    return transact<TelegramWorkspaceJournalWriterProtocolInstallResult>(
      (state) => {
        if (state.writerProtocolMode) {
          const resumed = {
            ...candidate,
            installedAtMs: state.writerProtocolMode.installedAtMs,
          };
          if (
            areWriterProtocolModesEqual(state.writerProtocolMode, resumed) &&
            !state.fence
          )
            return {
              result: {
                mode: {
                  ...state.writerProtocolMode,
                  installedBy: { ...state.writerProtocolMode.installedBy },
                },
                resumed: true,
              },
              changed: false,
            };
          authorityChanged(
            "Telegram Workspace writer protocol mode authority changed.",
          );
        }
        if (
          !state.fence ||
          state.fence.destructiveKind !== "journal-writer-closure" ||
          !areWriterClosureFencesEqual(state.fence, expected) ||
          state.leases.length !== 0
        )
          authorityChanged(
            "Telegram Workspace writer closure authority changed before protocol installation.",
          );
        state.writerProtocolMode = candidate;
        delete state.fence;
        return {
          result: {
            mode: { ...candidate, installedBy: { ...candidate.installedBy } },
            resumed: false,
          },
          changed: true,
        };
      },
    );
  }

  function acquireJournalWriterAdmission(input: {
    operationId: string;
    recoveryKey: string;
    startupAuthorityId: string;
    closureOperationId: string;
    writerInventorySha256: string;
  }): TelegramWorkspaceAdmissionAcquireResult {
    validateOperationId(input.operationId);
    if (
      !isBoundedText(input.recoveryKey) ||
      !isBoundedText(input.startupAuthorityId) ||
      !isBoundedText(input.closureOperationId) ||
      !/^[a-f0-9]{64}$/u.test(input.writerInventorySha256)
    )
      invalidInput(
        "Telegram Workspace journal writer protocol authority is invalid.",
      );
    return transact<TelegramWorkspaceAdmissionAcquireResult>((state) => {
      const mode = state.writerProtocolMode;
      if (
        !mode ||
        mode.recoveryKey !== input.recoveryKey ||
        mode.startupAuthorityId !== input.startupAuthorityId ||
        mode.closureOperationId !== input.closureOperationId ||
        mode.writerInventorySha256 !== input.writerInventorySha256
      )
        authorityChanged(
          "Telegram Workspace journal writer protocol authority changed.",
        );
      const existing = state.leases.find(
        (lease) => lease.operationId === input.operationId,
      );
      const operationKind = "journal-write:custody-v3";
      if (existing) {
        const retried: TelegramWorkspaceAdmissionLease = {
          operationId: input.operationId,
          operationKind,
          profileKey: options.profileKey,
          scope: { kind: "profile" },
          owner: { ...options.owner },
          acquiredAtMs: existing.acquiredAtMs,
        };
        if (!areLeasesEqual(existing, retried))
          authorityChanged(
            "Telegram Workspace journal writer operation identity changed.",
          );
        return {
          result: {
            kind: "acquired",
            lease: cloneLease(existing),
            resumed: true,
          },
          changed: false,
        };
      }
      if (state.fence)
        return {
          result: { kind: "blocked", reason: "retirement-fenced" },
          changed: false,
        };
      if (state.leases.length >= TELEGRAM_WORKSPACE_ADMISSION_MAX_LEASES)
        invalidState(
          "Telegram Workspace admission lease capacity is exhausted.",
        );
      const lease: TelegramWorkspaceAdmissionLease = {
        operationId: input.operationId,
        operationKind,
        profileKey: options.profileKey,
        scope: { kind: "profile" },
        owner: { ...options.owner },
        acquiredAtMs: getNowMs(),
      };
      state.leases.push(lease);
      return {
        result: { kind: "acquired", lease: cloneLease(lease), resumed: false },
        changed: true,
      };
    });
  }

  function acquireDestructiveFence(
    input: {
      operationId: string;
      retirementIntentId: string;
      bindingKey: string;
      slot: string | null;
      target: TelegramTarget & { threadId: number };
      leaderEpoch: number | string;
      retirementRequestedAtMs: number;
    },
    destructiveKind?: TelegramWorkspaceDeletionFenceKind,
  ): TelegramWorkspaceRetirementFenceAcquireResult {
    validateOperationId(input.operationId);
    const candidate = normalizeFence(
      {
        ...input,
        ...(destructiveKind === undefined ? {} : { destructiveKind }),
        profileKey: options.profileKey,
        owner: options.owner,
        acquiredAtMs: getNowMs(),
        phase: "fenced",
      },
      options.profileKey,
    );
    if (!candidate || !isTelegramWorkspaceRetirementFence(candidate)) {
      invalidInput("Telegram Workspace retirement fence input is invalid.");
    }
    return transact<TelegramWorkspaceRetirementFenceAcquireResult>((state) => {
      if (state.fence) {
        if (!isTelegramWorkspaceRetirementFence(state.fence)) {
          return {
            result: { kind: "blocked", reason: "retirement-active" },
            changed: false,
          };
        }
        if (
          state.fence.phase === "fenced" &&
          areFenceBasesEqual(state.fence, {
            ...candidate,
            acquiredAtMs: state.fence.acquiredAtMs,
          })
        ) {
          return {
            result: {
              kind: "acquired",
              fence: cloneFence(state.fence),
              resumed: true,
            },
            changed: false,
          };
        }
        if (state.fence.operationId === candidate.operationId) {
          authorityChanged(
            "Telegram Workspace retirement fence authority changed.",
          );
        }
        return {
          result: { kind: "blocked", reason: "retirement-active" },
          changed: false,
        };
      }
      if (
        state.leases.some((lease) =>
          scopesConflict(lease.scope, candidate.target),
        )
      ) {
        return {
          result: { kind: "blocked", reason: "admission-active" },
          changed: false,
        };
      }
      state.fence = candidate;
      return {
        result: {
          kind: "acquired",
          fence: cloneFence(candidate),
          resumed: false,
        },
        changed: true,
      };
    });
  }

  function acquireRetirementFence(
    input: Parameters<
      TelegramWorkspaceAdmissionLedger["acquireRetirementFence"]
    >[0],
  ) {
    return acquireDestructiveFence(input);
  }

  function acquireThreadCleanupFence(
    input: Parameters<
      TelegramWorkspaceAdmissionLedger["acquireThreadCleanupFence"]
    >[0],
  ): TelegramWorkspaceRetirementFenceAcquireResult {
    return acquireDestructiveFence(
      {
        operationId: input.operationId,
        retirementIntentId: input.cleanupWorkSetId,
        bindingKey: input.bindingKey,
        slot: input.slot,
        target: input.target,
        leaderEpoch: input.leaderEpoch,
        retirementRequestedAtMs: input.cleanupRequestedAtMs,
      },
      "manual-thread-cleanup",
    );
  }

  // Exact profile/kind/owner preflight shared by owner-held fence transitions; the transaction still rechecks state.
  function assertOwnedFence(
    expected: TelegramWorkspaceRetirementFence,
    expectedKind: TelegramWorkspaceDeletionFenceKind,
    ownerMessage: string,
  ): void {
    validateExpectedFence(expected, options.profileKey);
    if (resolveTelegramWorkspaceDestructiveFenceKind(expected) !== expectedKind)
      authorityChanged("Telegram Workspace destructive fence kind changed.");
    if (!areOwnersEqual(expected.owner, options.owner))
      authorityChanged(ownerMessage);
  }

  function adoptRetirementFence(
    expected: TelegramWorkspaceRetirementFence,
    replacement: {
      owner: TelegramWorkspaceAdmissionOwner;
      leaderEpoch: number | string;
    },
    expectedKind: TelegramWorkspaceDeletionFenceKind = "pressure-retirement",
  ): TelegramWorkspaceRetirementFence {
    validateExpectedFence(expected, options.profileKey);
    if (resolveTelegramWorkspaceDestructiveFenceKind(expected) !== expectedKind)
      authorityChanged("Telegram Workspace destructive fence kind changed.");
    if (
      !normalizeOwner(replacement.owner) ||
      !isLeaderEpoch(replacement.leaderEpoch)
    ) {
      invalidInput(
        "Telegram Workspace retirement successor authority is invalid.",
      );
    }
    if (!areOwnersEqual(replacement.owner, options.owner)) {
      authorityChanged(
        "Telegram Workspace retirement adoption requires successor owner authority.",
      );
    }
    const adopted = {
      ...cloneFence(expected),
      owner: { ...replacement.owner },
      leaderEpoch: replacement.leaderEpoch,
    } satisfies TelegramWorkspaceRetirementFence;
    return transact((state) => {
      if (!state.fence || !isTelegramWorkspaceRetirementFence(state.fence)) {
        authorityChanged(
          "Telegram Workspace retirement fence is absent or has another kind.",
        );
      }
      if (areFencesEqual(state.fence, adopted)) {
        return { result: cloneFence(state.fence), changed: false };
      }
      if (!areFencesEqual(state.fence, expected)) {
        authorityChanged(
          "Telegram Workspace retirement fence authority changed.",
        );
      }
      state.fence = adopted;
      return { result: cloneFence(adopted), changed: true };
    });
  }

  function issueDeletionPermit(
    expected: TelegramWorkspaceRetirementFence,
    expectedKind: TelegramWorkspaceDeletionFenceKind = "pressure-retirement",
  ): TelegramWorkspaceDeletionPermitResult {
    assertOwnedFence(
      expected,
      expectedKind,
      "Telegram Workspace deletion permit requires fence owner authority.",
    );
    return transact<TelegramWorkspaceDeletionPermitResult>((state) => {
      if (!state.fence || !isTelegramWorkspaceRetirementFence(state.fence)) {
        authorityChanged(
          "Telegram Workspace retirement fence is absent or has another kind.",
        );
      }
      if (
        state.fence.operationId === expected.operationId &&
        areFenceBasesEqual(state.fence, expected) &&
        state.fence.phase !== "fenced"
      ) {
        return {
          result: { kind: "already-issued", fence: cloneFence(state.fence) },
          changed: false,
        };
      }
      if (!areFencesEqual(state.fence, expected)) {
        authorityChanged(
          "Telegram Workspace retirement fence authority changed.",
        );
      }
      if (state.fence.phase !== "fenced") {
        return {
          result: { kind: "already-issued", fence: cloneFence(state.fence) },
          changed: false,
        };
      }
      const deletionIssuedAtMs = getNowMs();
      const issued: TelegramWorkspaceRetirementFence = {
        ...state.fence,
        phase: "deletion-issued",
        deletionIssuedAtMs,
      };
      state.fence = issued;
      return {
        result: {
          kind: "issued",
          fence: cloneFence(issued),
          permit: {
            ...(issued.destructiveKind === undefined
              ? {}
              : { destructiveKind: issued.destructiveKind }),
            operationId: issued.operationId,
            retirementIntentId: issued.retirementIntentId,
            profileKey: issued.profileKey,
            bindingKey: issued.bindingKey,
            slot: issued.slot,
            target: { ...issued.target },
            leaderEpoch: issued.leaderEpoch,
            issuedAtMs: deletionIssuedAtMs,
          },
        },
        changed: true,
      };
    });
  }

  function confirmRetirementAbsence(
    expected: TelegramWorkspaceRetirementFence,
    expectedKind: TelegramWorkspaceDeletionFenceKind = "pressure-retirement",
  ): TelegramWorkspaceRetirementFence {
    assertOwnedFence(
      expected,
      expectedKind,
      "Telegram Workspace absence confirmation requires fence owner authority.",
    );
    if (expected.phase === "deletion-rejected") {
      authorityChanged(
        "Rejected Telegram Workspace deletion cannot confirm absence.",
      );
    }
    return transact((state) => {
      if (!state.fence || !isTelegramWorkspaceRetirementFence(state.fence)) {
        authorityChanged(
          "Telegram Workspace retirement fence is absent or has another kind.",
        );
      }
      if (
        state.fence.operationId === expected.operationId &&
        areFenceBasesEqual(state.fence, expected) &&
        state.fence.phase === "commit-ready"
      ) {
        return { result: cloneFence(state.fence), changed: false };
      }
      if (!areFencesEqual(state.fence, expected)) {
        authorityChanged(
          "Telegram Workspace retirement fence authority changed.",
        );
      }
      const ready: TelegramWorkspaceRetirementFence = {
        ...state.fence,
        phase: "commit-ready",
        absenceConfirmedAtMs: getNowMs(),
        ...(state.fence.phase === "deletion-issued"
          ? { deletionIssuedAtMs: state.fence.deletionIssuedAtMs }
          : {}),
      };
      state.fence = ready;
      return { result: cloneFence(ready), changed: true };
    });
  }

  function releaseUnissuedRetirementFence(
    expected: TelegramWorkspaceRetirementFence,
    expectedKind: TelegramWorkspaceDeletionFenceKind = "pressure-retirement",
  ): boolean {
    assertOwnedFence(
      expected,
      expectedKind,
      "Telegram Workspace fence release requires owner authority.",
    );
    return transact((state) => {
      if (!state.fence) return { result: false, changed: false };
      if (!isTelegramWorkspaceRetirementFence(state.fence))
        authorityChanged(
          "Telegram Workspace retirement fence has another kind.",
        );
      if (!areFencesEqual(state.fence, expected)) {
        authorityChanged(
          "Telegram Workspace retirement fence authority changed.",
        );
      }
      if (state.fence.phase !== "fenced") {
        authorityChanged(
          "Issued Telegram Workspace retirement fence cannot be released.",
        );
      }
      delete state.fence;
      return { result: true, changed: true };
    });
  }

  function completeDestructiveFence(
    expected: TelegramWorkspaceRetirementFence,
    expectedKind: TelegramWorkspaceDeletionFenceKind,
    requiredPhase: "commit-ready" | "deletion-rejected",
  ): boolean {
    assertOwnedFence(
      expected,
      expectedKind,
      "Telegram Workspace fence completion requires owner authority.",
    );
    return transact((state) => {
      if (!state.fence) return { result: false, changed: false };
      if (!isTelegramWorkspaceRetirementFence(state.fence))
        authorityChanged(
          "Telegram Workspace retirement fence has another kind.",
        );
      if (!areFencesEqual(state.fence, expected)) {
        authorityChanged(
          "Telegram Workspace retirement fence authority changed.",
        );
      }
      if (state.fence.phase !== requiredPhase) {
        authorityChanged(
          requiredPhase === "commit-ready"
            ? "Telegram Workspace retirement commit is not ready."
            : "Telegram Workspace retirement rejection is not confirmed.",
        );
      }
      delete state.fence;
      return { result: true, changed: true };
    });
  }

  function confirmRetirementRejection(
    expected: TelegramWorkspaceRetirementFence,
  ): TelegramWorkspaceRetirementFence {
    validateExpectedFence(expected, options.profileKey);
    if (
      resolveTelegramWorkspaceDestructiveFenceKind(expected) !==
        "pressure-retirement" ||
      !areOwnersEqual(expected.owner, options.owner) ||
      (expected.phase !== "deletion-issued" &&
        expected.phase !== "deletion-rejected")
    ) {
      authorityChanged(
        "Telegram Workspace rejection requires exact issued retirement authority.",
      );
    }
    return transact((state) => {
      const current = state.fence;
      if (
        !current ||
        !isTelegramWorkspaceRetirementFence(current) ||
        !areFenceBasesEqual(current, expected) ||
        (current.phase !== "deletion-issued" &&
          current.phase !== "deletion-rejected") ||
        current.deletionIssuedAtMs !== expected.deletionIssuedAtMs ||
        (expected.phase === "deletion-rejected" &&
          !areFencesEqual(current, expected))
      ) {
        authorityChanged(
          "Telegram Workspace retirement fence authority changed.",
        );
      }
      if (current.phase === "deletion-rejected")
        return { result: cloneFence(current), changed: false };
      const rejected: TelegramWorkspaceRetirementFence = {
        ...current,
        destructiveKind: "pressure-retirement",
        phase: "deletion-rejected",
        rejectionConfirmedAtMs: getNowMs(),
      };
      state.fence = rejected;
      return { result: cloneFence(rejected), changed: true };
    });
  }

  function completeRetirementFence(
    expected: TelegramWorkspaceRetirementFence,
    expectedKind: TelegramWorkspaceDeletionFenceKind = "pressure-retirement",
  ) {
    return completeDestructiveFence(expected, expectedKind, "commit-ready");
  }
  function completeRejectedRetirementFence(
    expected: TelegramWorkspaceRetirementFence,
  ) {
    return completeDestructiveFence(
      expected,
      "pressure-retirement",
      "deletion-rejected",
    );
  }

  function adoptThreadCleanupFence(
    expected: TelegramWorkspaceRetirementFence,
    replacement: {
      owner: TelegramWorkspaceAdmissionOwner;
      leaderEpoch: number | string;
    },
  ) {
    return adoptRetirementFence(expected, replacement, "manual-thread-cleanup");
  }
  function issueThreadCleanupDeletionPermit(
    expected: TelegramWorkspaceRetirementFence,
  ) {
    return issueDeletionPermit(expected, "manual-thread-cleanup");
  }
  function confirmThreadCleanupAbsence(
    expected: TelegramWorkspaceRetirementFence,
  ) {
    return confirmRetirementAbsence(expected, "manual-thread-cleanup");
  }
  function releaseUnissuedThreadCleanupFence(
    expected: TelegramWorkspaceRetirementFence,
  ) {
    return releaseUnissuedRetirementFence(expected, "manual-thread-cleanup");
  }
  function completeThreadCleanupFence(
    expected: TelegramWorkspaceRetirementFence,
  ) {
    return completeRetirementFence(expected, "manual-thread-cleanup");
  }

  return {
    getProfileKey: () =>
      stateProfile === undefined ? options.profileKey : profileKey,
    getOwner: () => ({
      ...(stateProfile === undefined ? options.owner : boundOwner),
    }),
    listReservedSlots: () => {
      const fence = read().fence;
      return fence && isTelegramWorkspaceRetirementFence(fence) && fence.slot !== null
        ? [fence.slot]
        : [];
    },
    read,
    acquireAdmission,
    releaseAdmission,
    acquireJournalWriterClosure,
    releaseJournalWriterClosure,
    installJournalWriterProtocolMode,
    acquireJournalWriterAdmission,
    acquireRetirementFence,
    acquireThreadCleanupFence,
    adoptRetirementFence,
    adoptThreadCleanupFence,
    issueDeletionPermit,
    issueThreadCleanupDeletionPermit,
    confirmRetirementAbsence,
    confirmThreadCleanupAbsence,
    confirmRetirementRejection,
    completeRejectedRetirementFence,
    releaseUnissuedRetirementFence,
    releaseUnissuedThreadCleanupFence,
    completeRetirementFence,
    completeThreadCleanupFence,
  };
}
