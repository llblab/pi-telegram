/**
 * Telegram thread binding helpers
 * Zones: multi-instance bus, Telegram UI threads, volatile extension state
 * Owns current live instance-binding to Telegram UI thread mappings backed by Bot API ForumTopic/message_thread_id transport
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  isTelegramApiCommitUnknownError,
  TelegramApiCommitUnknownError,
  type TelegramApiCallOptions,
} from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import { withTelegramFileTransaction } from "./locks.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import {
  planTelegramWorkspaceSlotAllocation,
  TELEGRAM_WORKSPACE_SLOTS,
  type TelegramWorkspaceSlotOccupancy,
} from "./workspace-slots.ts";
import {
  resolveAgentDir,
  resolveTelegramProfileTempFilePath,
} from "./paths.ts";

export interface TelegramThreadNameInput {
  seed: string;
  cwd?: string;
  role?: "leader" | "follower";
  peers?: readonly string[];
  slot?: string;
}

export interface TelegramWorkspaceBindingIdentity {
  cwd: string;
  workspaceKey: string;
  /** Immutable legacy binding-key component, not the displayed global letter. */
  instanceSlot: string;
  bindingKey: string;
  /** Profile-wide letter reserved by the transient claim. */
  slot?: string;
}

const TELEGRAM_WORKSPACE_KEY_MAX_LENGTH = 180;

export function normalizeTelegramWorkspacePath(
  cwd: string,
): string | undefined {
  const trimmed = cwd.trim();
  if (!trimmed) return undefined;
  const normalized = (trimmed.startsWith("/")
    ? posix.normalize(trimmed)
    : resolve(trimmed).replaceAll("\\", "/"));
  const withoutTrailingSeparators =
    normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
  return process.platform === "win32"
    ? withoutTrailingSeparators.replace(/^([A-Z]):/u, (_, drive: string) =>
        `${drive.toLowerCase()}:`,
      )
    : withoutTrailingSeparators;
}

export function createTelegramWorkspaceDirectoryKey(
  cwd: string,
): string | undefined {
  const normalized = normalizeTelegramWorkspacePath(cwd);
  if (!normalized) return undefined;
  const readable =
    normalized
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "root";
  const candidate = `--${readable}--`;
  if (candidate.length <= TELEGRAM_WORKSPACE_KEY_MAX_LENGTH) return candidate;
  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
  const prefixLength =
    TELEGRAM_WORKSPACE_KEY_MAX_LENGTH - digest.length - 5;
  return `--${readable.slice(0, prefixLength)}-${digest}--`;
}

function createTelegramWorkspaceInstanceSlot(
  ordinal: number,
): string | undefined {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) return undefined;
  let value = ordinal + 1;
  let slot = "";
  while (value > 0) {
    value -= 1;
    slot = String.fromCharCode(97 + (value % 26)) + slot;
    value = Math.floor(value / 26);
  }
  return slot;
}

function createTelegramWorkspaceBindingIdentityWithKey(
  cwd: string,
  workspaceKey: string,
  ordinal: number,
): TelegramWorkspaceBindingIdentity | undefined {
  const instanceSlot = createTelegramWorkspaceInstanceSlot(ordinal);
  if (!instanceSlot) return undefined;
  return {
    cwd,
    workspaceKey,
    instanceSlot,
    bindingKey:
      instanceSlot === "a" ? workspaceKey : `${workspaceKey}${instanceSlot}`,
  };
}

export function createTelegramWorkspaceBindingIdentity(
  cwd: string,
  ordinal = 0,
): TelegramWorkspaceBindingIdentity | undefined {
  const normalized = normalizeTelegramWorkspacePath(cwd);
  const workspaceKey = normalized
    ? createTelegramWorkspaceDirectoryKey(normalized)
    : undefined;
  if (!normalized || !workspaceKey) return undefined;
  return createTelegramWorkspaceBindingIdentityWithKey(
    normalized,
    workspaceKey,
    ordinal,
  );
}

export type TelegramTopicTargetStatus =
  | "active"
  | "offline"
  | "stale"
  | "pending"
  | "starting"
  | "probe-required"
  | "failed";

export type TelegramTopicSyncStatus = "open" | "closed" | "deleted" | "unknown";

export type TelegramThreadOwner =
  | {
      kind: "leader";
      cwd?: string;
      instanceId?: string;
      telegramProfile?: string;
    }
  | { kind: "manual-follower"; instanceId: string; telegramProfile?: string }
  | { kind: "pending-topic"; chatId: number; threadId: number }
  | { kind: "legacy"; key: string };

const TELEGRAM_THREAD_RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface TelegramThreadReservation {
  target: TelegramTarget & { threadId: number };
  slot: string;
  reason: string;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs?: number;
  instanceId?: string;
  lastReconcileAction?: string;
}

export interface TelegramThreadPendingProvision {
  id: string;
  owner: "leader" | "manual-follower";
  instanceId: string;
  profileKey?: string;
  status?: "in-flight" | "ambiguous";
  threadName?: string;
  displayTitle?: string;
  slot?: string;
  target?: TelegramTarget & { threadId: number };
  startedAtMs: number;
  expiresAtMs?: number;
  leaderEpoch?: number | string;
}

export type TelegramThreadCleanupIntent =
  ThreadReconciler.TelegramThreadCleanupIntent;

type TelegramProvisionRecoveryFile = Record<
  string,
  {
    instanceId: string;
    profileKey?: string;
    leaderEpoch?: number | string;
    target: TelegramTarget & { threadId: number };
  }
>;

export interface TelegramTopicSyncObservation {
  target: TelegramTarget & { threadId: number };
  syncStatus: TelegramTopicSyncStatus;
  observedAtMs: number;
  instanceId?: string;
  slot?: string;
  lastSyncError?: string;
  lastReconcileAction?: string;
}

export interface TelegramTopicTargetRecord {
  /** Legacy string key derived from `owner`; always present in memory, never persisted. */
  profileKey: string;
  owner?: TelegramThreadOwner;
  target: TelegramTarget & { threadId: number };
  status: TelegramTopicTargetStatus;
  createdAtMs: number;
  updatedAtMs: number;
  threadName?: string;
  /** Explicit per-Workspace display override set by the operator. */
  manualThreadName?: string;
  instanceId?: string;
  slot?: string;
  lastError?: string;
  syncStatus?: TelegramTopicSyncStatus;
  lastSyncObservedAtMs?: number;
  lastSyncProbeAtMs?: number;
  lastSyncError?: string;
  lastReconcileAction?: string;
  rerouteConfirmedAtMs?: number;
}

export interface TelegramThreadIdentityRecord {
  profileKey: string;
  threadName?: string;
  slot?: string;
  updatedAtMs: number;
}

export interface TelegramWorkspaceThreadBinding {
  cwd: string;
  workspaceKey: string;
  instanceSlot: string;
  bindingKey: string;
  target: TelegramTarget & { threadId: number };
  /** Stable generated identity retained for compatibility and recovery. */
  threadName?: string;
  /** Explicit display override; absence selects the profile's automatic mode. */
  manualThreadName?: string;
  slot?: string;
  /** Last title acknowledged by Telegram; never replaces the stable name. */
  displayTitle?: string;
  /** Historical follower-journal routing keys that may retain accepted work. */
  journalBindingKeys?: string[];
  /** True only when the historical journal-key set is proven complete. */
  journalBindingsComplete?: true;
  /** Sticky once this directory has multiple retained bindings. */
  showSlotSuffix?: boolean;
  /** First continuously proven no-owner transition; absent means active or unproven. */
  inactiveSinceMs?: number;
  updatedAtMs: number;
}

export type TelegramWorkspaceDisplayBinding = Pick<
  TelegramWorkspaceThreadBinding,
  "bindingKey" | "cwd" | "slot" | "threadName" | "manualThreadName" |
    "showSlotSuffix"
>;

export interface TelegramWorkspaceRetirementIntent {
  id: string;
  reason: "pressure";
  profileKey: string;
  binding: TelegramWorkspaceThreadBinding;
  leaderEpoch: number | string;
  requestedAtMs: number;
}

export type TelegramWorkspaceProtectionState =
  | "clear"
  | "protected"
  | "unknown";

export interface TelegramWorkspaceExternalProtectionEvidence {
  liveOwner: TelegramWorkspaceProtectionState;
  acceptedWork: TelegramWorkspaceProtectionState;
  deliveryAuthority: TelegramWorkspaceProtectionState;
}

export interface TelegramWorkspaceSlotOccupancySnapshot {
  bindings: TelegramWorkspaceSlotOccupancy[];
  reservedSlots: string[];
}

export type TelegramBotThreadMode = "unknown" | "enabled" | "disabled";

export interface TelegramBotStateSnapshot {
  threadMode: TelegramBotThreadMode;
  updatedAtMs?: number;
  lastSlot?: string;
  lastReconcileAction?: string;
}

export interface TelegramTopicTargetFile {
  version: 1;
  source: "snapshot";
  writtenAtMs: number;
  bot: TelegramBotStateSnapshot;
  runtime?: Record<string, unknown>;
  liveRoster?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
  threads: TelegramTopicTargetRecord[];
  identities?: TelegramThreadIdentityRecord[];
  workspaceBindings?: TelegramWorkspaceThreadBinding[];
  workspaceRetirements?: TelegramWorkspaceRetirementIntent[];
  reservations?: TelegramThreadReservation[];
  pendingProvisions?: TelegramThreadPendingProvision[];
  pendingCleanups?: TelegramThreadCleanupIntent[];
  syncObservations?: TelegramTopicSyncObservation[];
}

function getNextMonotonicSlot(
  records: Map<string, TelegramTopicTargetRecord>,
  reservations: readonly TelegramThreadReservation[],
  pendingProvisions: readonly TelegramThreadPendingProvision[],
  nowMs: number,
  lastSlot?: string,
): string | undefined {
  let cursorCode: number | undefined;
  if (lastSlot && /^[A-Z]$/.test(lastSlot)) {
    cursorCode = lastSlot.charCodeAt(0);
  } else {
    cursorCode = "A".charCodeAt(0) - 1;
    for (const record of records.values()) {
      if (!record.slot || !isCurrentThreadRecord(record)) continue;
      cursorCode = Math.max(cursorCode, record.slot.charCodeAt(0));
    }
    for (const reservation of reservations) {
      if (
        reservation.expiresAtMs !== undefined &&
        reservation.expiresAtMs <= nowMs
      )
        continue;
      if (!reservation.slot) continue;
      cursorCode = Math.max(cursorCode, reservation.slot.charCodeAt(0));
    }
    for (const provision of pendingProvisions) {
      if (
        provision.status !== "ambiguous" &&
        provision.expiresAtMs !== undefined &&
        provision.expiresAtMs <= nowMs
      )
        continue;
      if (!provision.slot) continue;
      cursorCode = Math.max(cursorCode, provision.slot.charCodeAt(0));
    }
  }
  let code = cursorCode + 1;
  if (code > "Z".charCodeAt(0)) code = "A".charCodeAt(0);
  for (let attempt = 0; attempt < 26; attempt++) {
    const candidate = String.fromCharCode(code);
    if (
      !isTelegramTopicTargetSlotOccupied(
        candidate,
        records,
        reservations,
        pendingProvisions,
        nowMs,
      )
    ) {
      return candidate;
    }
    code += 1;
    if (code > "Z".charCodeAt(0)) code = "A".charCodeAt(0);
  }
  return undefined;
}

export interface TelegramTopicTargetStore {
  load: () => Promise<void>;
  /** Discard process-local projections and reload owner-published state. */
  refresh?: () => Promise<void>;
  persist: () => Promise<void>;
  invalidateTarget: (
    target: TelegramTarget,
    isCurrent: () => boolean,
    lastSyncError: string,
  ) => Promise<boolean>;
  list: () => TelegramTopicTargetRecord[];
  getFollowerRecoveryHintByTarget?: (
    target: TelegramTarget,
  ) => { slot?: string; threadName?: string } | undefined;
  listReservations: () => TelegramThreadReservation[];
  listPendingProvisions: () => TelegramThreadPendingProvision[];
  listPendingCleanups: () => TelegramThreadCleanupIntent[];
  listSyncObservations: () => TelegramTopicSyncObservation[];
  reserveThread: (reservation: TelegramThreadReservation) => void;
  upsertPendingProvision: (provision: TelegramThreadPendingProvision) => void;
  recordPendingProvisionTargetRecovery: (
    provision: TelegramThreadPendingProvision,
    target: TelegramTarget & { threadId: number },
  ) => Promise<boolean>;
  removePendingProvision: (id: string) => boolean;
  upsertPendingCleanup: (intent: TelegramThreadCleanupIntent) => void;
  removePendingCleanup: (id: string) => boolean;
  getBotState: () => TelegramBotStateSnapshot;
  setBotState: (state: Partial<TelegramBotStateSnapshot>) => void;
  setStatusSnapshot: (snapshot: {
    runtime?: Record<string, unknown>;
    liveRoster?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  }) => void;
  getByProfileKey: (
    profileKey: string,
  ) => TelegramTopicTargetRecord | undefined;
  getActiveByInstanceId: (
    instanceId: string,
  ) => TelegramTopicTargetRecord | undefined;
  getIdentityByProfileKey: (
    profileKey: string,
  ) => TelegramThreadIdentityRecord | undefined;
  forgetIdentityByProfileKey: (profileKey: string) => boolean;
  listWorkspaceBindings: () => TelegramWorkspaceThreadBinding[];
  listWorkspaceRetirementIntents: () => TelegramWorkspaceRetirementIntent[];
  commitWorkspaceJournalEvidence: (
    expected: TelegramWorkspaceThreadBinding,
    journalBindingKeys: readonly string[],
    complete: boolean,
  ) => TelegramWorkspaceThreadBinding | undefined;
  upsertWorkspaceRetirementIntent: (
    intent: TelegramWorkspaceRetirementIntent,
  ) => boolean;
  removeWorkspaceRetirementIntent: (
    expected: TelegramWorkspaceRetirementIntent,
  ) => boolean;
  replaceWorkspaceRetirementIntent: (
    expected: TelegramWorkspaceRetirementIntent,
    replacement: TelegramWorkspaceRetirementIntent,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  commitWorkspaceRetirement: (
    expected: TelegramWorkspaceRetirementIntent,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  commitInactiveWorkspaceCleanup: (
    expected: TelegramWorkspaceThreadBinding | {
      cwd: string; workspaceKey: string; instanceSlot: string; slot: string; bindingKey: string;
      target: { chatId: number; threadId: number }; inactiveSinceMs: number; bindingUpdatedAtMs: number;
    },
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  /** Caller must separately prove no external live owner, accepted work, or delivery authority. */
  captureWorkspaceSlotOccupancy: (
    getExternalProtection: (
      binding: TelegramWorkspaceThreadBinding,
    ) => TelegramWorkspaceExternalProtectionEvidence,
    options?: { expectedRetirement?: TelegramWorkspaceRetirementIntent },
  ) => TelegramWorkspaceSlotOccupancySnapshot;
  hasWorkspaceBinding: (cwd: string) => boolean;
  setWorkspaceDisplayTitle: (
    expected: TelegramWorkspaceThreadBinding,
    title: string,
  ) => boolean;
  markWorkspaceBindingInactiveByTarget: (
    target: TelegramTarget,
    inactiveSinceMs?: number,
  ) => boolean;
  markWorkspaceBindingActiveByTarget: (target: TelegramTarget) => boolean;
  getWorkspaceBinding: (
    cwd: string,
    instanceSlot?: string,
  ) => TelegramWorkspaceThreadBinding | undefined;
  claimWorkspaceIdentity: (
    cwd: string,
    instanceId: string,
    previousInstanceId?: string,
    options?: {
      existingBindingOnly?: boolean;
      onCapacityUnavailable?: () => void;
    },
  ) => TelegramWorkspaceBindingIdentity | undefined;
  releaseWorkspaceClaim: (instanceId: string) => boolean;
  upsertWorkspaceBinding: (
    binding: TelegramWorkspaceThreadBinding,
    claimInstanceId?: string,
  ) => TelegramWorkspaceThreadBinding | undefined;
  upsert: (record: TelegramTopicTargetRecord) => TelegramTopicTargetRecord;
  markOfflineByInstanceId: (instanceId: string) => number;
  markStaleByTarget: (
    target: TelegramTarget,
    syncStatus?: TelegramTopicSyncStatus,
    lastSyncError?: string,
  ) => boolean;
  markActiveByTarget: (target: TelegramTarget) => boolean;
  renameByTarget: (
    target: TelegramTarget,
    threadName: string,
    options?: { updateDisplayTitle: boolean },
  ) => TelegramTopicTargetRecord | undefined;
  clearManualNameByTarget: (
    target: TelegramTarget,
    automaticTitle: string,
  ) => TelegramTopicTargetRecord | undefined;
  allocateSlot: (
    profileKey: string,
    preferredSlot?: string,
    workspaceBindingKey?: string,
    options?: { excludeCurrentRecord?: boolean },
  ) => string | undefined;
  /** Claim the first reusable inactive thread for an instance, linking it to instanceId. */
  claimReusableTarget: (
    instanceId: string,
    threadName?: string,
  ) => TelegramTopicTargetRecord | undefined;
}

export function reconcileTelegramFreshAllocationCursor(
  store: Pick<TelegramTopicTargetStore, "getBotState" | "list" | "setBotState">,
  nowMs = Date.now(),
): boolean {
  const currentCursor = store.getBotState().lastSlot;
  const slottedRecords = store
    .list()
    .filter((record) => !!record.slot && /^[A-Z]$/.test(record.slot));
  if (slottedRecords.some((record) => record.slot === currentCursor)) {
    return false;
  }
  const latestLiveRecord = slottedRecords.reduce<
    TelegramTopicTargetRecord | undefined
  >((latest, record) => {
    if (!latest) return record;
    if (record.createdAtMs !== latest.createdAtMs) {
      return record.createdAtMs > latest.createdAtMs ? record : latest;
    }
    return record.updatedAtMs > latest.updatedAtMs ? record : latest;
  }, undefined);
  const nextCursor = latestLiveRecord?.slot;
  if (nextCursor === currentCursor) return false;
  store.setBotState({
    lastSlot: nextCursor,
    updatedAtMs: nowMs,
    lastReconcileAction: "live-cursor-realignment",
  });
  return true;
}

export function createTelegramCleanupTargetProtection(
  store: Pick<TelegramTopicTargetStore, "list"> & Partial<Pick<TelegramTopicTargetStore, "listReservations" | "listPendingProvisions" | "listPendingCleanups">>,
  departingRecord?: TelegramTopicTargetRecord,
): NonNullable<ThreadReconciler.ThreadReconciliationApplyPorts["isCleanupTargetProtected"]> {
  const records = store.list();
  const reservations = store.listReservations?.() ?? [];
  const provisions = store.listPendingProvisions?.() ?? [];
  const intents = store.listPendingCleanups?.() ?? [];
  // Persistence may reconstruct keys in another order and omit undefined
  // optional fields; neither changes the authority represented by a snapshot.
  const sameSnapshot = (left: unknown, right: unknown): boolean =>
    isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
  return (target, action) => {
    for (const record of store.list()) {
      if (!targetMatches(record.target, target)) continue;
      // A persisted shutdown intent may retire only its original pre-intent
      // binding. Registration/rebinding after that intent supersedes it.
      const intent = action.kind === "close-delete-graceful-shutdown-topic"
        ? intents.find((candidate) => candidate.id === action.cleanupIntentId && candidate.runtimeGeneration === action.runtimeGeneration)
        : undefined;
      const expectedDeparting = departingRecord ?? (intent && records.find((candidate) =>
        candidate.instanceId === intent.instanceId && targetMatches(candidate.target, intent.target) &&
        candidate.updatedAtMs <= intent.requestedAtMs));
      if (expectedDeparting && "instanceId" in action &&
        (action.kind === "close-delete-previous-leader-topic" || action.instanceId === expectedDeparting.instanceId) &&
        sameSnapshot(record, expectedDeparting)) {
        if (action.kind === "close-delete-previous-leader-topic" || action.kind === "close-stale-replaced-topic") continue;
        if (action.kind === "close-delete-graceful-shutdown-topic" &&
          store.listPendingCleanups?.().some((intent) => intent.id === action.cleanupIntentId &&
            intent.instanceId === action.instanceId && intent.runtimeGeneration === action.runtimeGeneration &&
            targetMatches(intent.target, target))) continue;
      }
      if (record.status === "active" || record.status === "starting" || record.status === "pending" || record.status === "probe-required") return true;
    }
    for (const reservation of store.listReservations?.() ?? []) {
      if (!targetMatches(reservation.target, target)) continue;
      if (action.kind !== "close-delete-reserved-topic" || !reservations.some((initial) => sameSnapshot(initial, reservation))) return true;
    }
    for (const provision of store.listPendingProvisions?.() ?? []) {
      if (!provision.target || !targetMatches(provision.target, target)) continue;
      if (action.kind !== "close-delete-expired-pending-provision-topic" || provision.id !== action.pendingProvisionId ||
        !provisions.some((initial) => sameSnapshot(initial, provision))) return true;
    }
    return false;
  };
}

export interface TelegramTopicTargetStoreOptions {
  path: string | (() => string);
  telegramProfile?: string | (() => string | undefined);
  getNowMs?: () => number;
  canPersist?: () => boolean;
  commitPersist?: (commit: () => void) => boolean;
  getExternalReservedSlots?: () => readonly string[];
}

export interface TelegramTopicTargetProvisionerDeps {
  topicChatId: number;
  store: Pick<
    TelegramTopicTargetStore,
    | "list"
    | "getByProfileKey"
    | "getActiveByInstanceId"
    | "getIdentityByProfileKey"
    | "forgetIdentityByProfileKey"
    | "upsert"
    | "markStaleByTarget"
    | "allocateSlot"
    | "claimReusableTarget"
    | "listWorkspaceBindings"
    | "listPendingProvisions"
    | "upsertPendingProvision"
    | "recordPendingProvisionTargetRecovery"
    | "removePendingProvision"
    | "listSyncObservations"
    | "listPendingCleanups"
    | "persist"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  topicNameTemplate?: string;
  resolveInitialWorkspaceDisplayTitle?: (
    binding: TelegramWorkspaceDisplayBinding,
  ) => string | undefined;
  getNowMs?: () => number;
  getRandom?: () => number;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  claimPendingTargets?: boolean;
}

export interface TelegramTopicTargetRenamerDeps {
  store: Pick<
    TelegramTopicTargetStore,
    | "renameByTarget"
    | "list"
    | "listWorkspaceBindings"
    | "listPendingProvisions"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  assertAuthority?: () => void;
  shouldRenameDisplayedTitle?: () => boolean;
  topicNameTemplate?: string;
}

export interface TelegramTopicTargetProvisionRequest {
  instanceId: string;
  owner?: TelegramThreadOwner;
  /** Legacy string key derived from `owner`; always present in memory. */
  profileKey: string;
  threadName?: string;
  preferredSlot?: string;
  workspaceBindingKey?: string;
  workspaceCwd?: string;
}

/** Pending creation evidence cannot bypass an exact target's unresolved cleanup or closure. */
export function assertTelegramPendingTopicRecoveryAllowed(
  store: Pick<TelegramTopicTargetStore,
    "listPendingProvisions" | "listPendingCleanups" | "listSyncObservations">,
  target: TelegramTarget,
): void {
  if (!store.listPendingProvisions().some((entry) =>
    entry.target && targetMatches(entry.target, target),
  )) return;
  if (store.listPendingCleanups().some((entry) => targetMatches(entry.target, target)) ||
      store.listSyncObservations().some((entry) =>
        targetMatches(entry.target, target) && entry.syncStatus === "closed",
      )) {
    throw new Error("Telegram pending topic requires reconciliation before recovery.");
  }
}

/** Settle creation-title evidence with the exact Workspace claim; caller fences and persists. */
export function commitTelegramWorkspaceProvisionBinding(input: {
  store: Pick<TelegramTopicTargetStore,
    "upsertWorkspaceBinding" | "setWorkspaceDisplayTitle" |
    "listPendingProvisions" | "removePendingProvision" |
    "listPendingCleanups" | "listSyncObservations">;
  binding: TelegramWorkspaceThreadBinding;
  instanceId: string;
  profileKey: string;
  displayTitle?: string;
}): TelegramWorkspaceThreadBinding {
  assertTelegramPendingTopicRecoveryAllowed(input.store, input.binding.target);
  const pending = input.store.listPendingProvisions().filter((provision) =>
    provision.target && targetMatches(provision.target, input.binding.target) &&
    provision.slot === input.binding.slot &&
    (provision.instanceId === input.instanceId || provision.profileKey === input.profileKey),
  );
  const titles = new Set(pending.map((provision) => provision.displayTitle)
    .filter((title) => title !== undefined));
  if (input.displayTitle !== undefined) titles.add(input.displayTitle);
  if (titles.size > 1) throw new Error("Telegram Workspace creation title evidence conflicts.");
  const displayTitle = titles.values().next().value;
  const committed = input.store.upsertWorkspaceBinding(input.binding, input.instanceId);
  if (!committed) throw new Error("Telegram Workspace binding claim changed.");
  if (displayTitle !== undefined &&
      !input.store.setWorkspaceDisplayTitle(committed, displayTitle)) {
    throw new Error("Telegram Workspace display title commit changed binding.");
  }
  for (const provision of pending) input.store.removePendingProvision(provision.id);
  return displayTitle === undefined ? committed : { ...committed, displayTitle };
}

export interface TelegramTopicTargetRenameRequest {
  target: TelegramTarget & { threadId: number };
  threadName: string;
  slot?: string;
}

export interface TelegramTopicTargetProvisionResult {
  target: TelegramTarget & { threadId: number };
  reused: boolean;
  record: TelegramTopicTargetRecord;
  displayTitle?: string;
}

interface TelegramTopicResult {
  message_thread_id?: number;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getWorkspaceHint(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split("/").filter(Boolean);
  const last = parts.at(-1)?.trim();
  if (!last) return undefined;
  return (
    last
      .replace(/[^\p{L}\p{N}._-]+/gu, " ")
      .trim()
      .slice(0, 32) || undefined
  );
}

export function createTelegramThreadName(
  input: TelegramThreadNameInput,
): string {
  const workspace = getWorkspaceHint(input.cwd);
  const roleMark =
    input.role === "leader"
      ? "Leader"
      : input.role === "follower"
        ? "Follower"
        : undefined;
  const slot = input.slot ? `Thread ${input.slot}` : undefined;
  const peerSalt = input.peers?.slice().sort().join("|") ?? "";
  const fallback = `Instance ${hashString(
    `${input.seed}|${input.cwd ?? ""}|${input.role ?? ""}|${peerSalt}|${input.slot ?? ""}`,
  )
    .toString(36)
    .slice(0, 4)}`;
  return (
    [slot, workspace, roleMark].filter(Boolean).join(" ").slice(0, 96) ||
    fallback
  );
}

export function getTelegramStatePath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return resolveTelegramProfileTempFilePath(
    "state",
    "json",
    agentDir,
    profileName,
  );
}

export function getTelegramTopicTargetsPath(
  agentDir = resolveAgentDir(),
  profileName?: string,
): string {
  return getTelegramStatePath(agentDir, profileName);
}

const TELEGRAM_LEADER_SESSION_HANDOFF_KEY = "__piTelegramLeaderSessionHandoff";
export const TELEGRAM_LEADER_SESSION_HANDOFF_TTL_MS = 30_000;

export interface TelegramLeaderSessionHandoff {
  pid: number;
  instanceId: string;
  createdAtMs: number;
  profileKey: string;
  target: TelegramTarget & { threadId: number };
  slot?: string;
  threadName?: string;
}

export function getTelegramLeaderSessionHandoff():
  TelegramLeaderSessionHandoff | undefined {
  const value = (globalThis as Record<string, unknown>)[
    TELEGRAM_LEADER_SESSION_HANDOFF_KEY
  ];
  if (!value || typeof value !== "object") return undefined;
  const handoff = value as Partial<TelegramLeaderSessionHandoff>;
  if (
    typeof handoff.pid !== "number" ||
    typeof handoff.instanceId !== "string" ||
    typeof handoff.createdAtMs !== "number" ||
    typeof handoff.profileKey !== "string" ||
    typeof handoff.target?.chatId !== "number" ||
    typeof handoff.target.threadId !== "number"
  ) {
    return undefined;
  }
  return handoff as TelegramLeaderSessionHandoff;
}

export function setTelegramLeaderSessionHandoff(
  handoff: TelegramLeaderSessionHandoff | undefined,
): void {
  const store = globalThis as Record<string, unknown>;
  if (!handoff) delete store[TELEGRAM_LEADER_SESSION_HANDOFF_KEY];
  else store[TELEGRAM_LEADER_SESSION_HANDOFF_KEY] = handoff;
}

export function isTelegramLeaderSessionHandoffFresh(
  handoff: TelegramLeaderSessionHandoff | undefined,
  options: { pid?: number; nowMs?: number; ttlMs?: number } = {},
): handoff is TelegramLeaderSessionHandoff {
  if (!handoff) return false;
  const pid = options.pid ?? process.pid;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? TELEGRAM_LEADER_SESSION_HANDOFF_TTL_MS;
  return handoff.pid === pid && nowMs - handoff.createdAtMs <= ttlMs;
}

export function getTelegramThreadOwnerKey(owner: TelegramThreadOwner): string {
  switch (owner.kind) {
    case "leader": {
      const base = owner.cwd
        ? `cwd:${owner.cwd}`
        : `leader:${owner.instanceId ?? "default"}`;
      return owner.telegramProfile
        ? `profile:${owner.telegramProfile}:${base}`
        : base;
    }
    case "manual-follower":
      return owner.telegramProfile
        ? `profile:${owner.telegramProfile}:manual:${owner.instanceId}`
        : `manual:${owner.instanceId}`;
    case "pending-topic":
      return `topic:${owner.chatId}:${owner.threadId}`;
    case "legacy":
      return `legacy:${owner.key}`;
  }
}

export function getTelegramThreadOwnerFromProfileKey(
  profileKey: string,
): TelegramThreadOwner {
  if (profileKey.startsWith("profile:")) {
    const [, telegramProfile, ownerKind, ...rest] = profileKey.split(":");
    const value = rest.join(":");
    if (ownerKind === "cwd")
      return { kind: "leader", cwd: value, telegramProfile };
    if (ownerKind === "leader")
      return { kind: "leader", instanceId: value, telegramProfile };
    if (ownerKind === "manual")
      return { kind: "manual-follower", instanceId: value, telegramProfile };
  }
  if (profileKey.startsWith("cwd:"))
    return { kind: "leader", cwd: profileKey.slice(4) };
  if (profileKey.startsWith("manual:")) {
    return { kind: "manual-follower", instanceId: profileKey.slice(7) };
  }
  if (profileKey.startsWith("topic:")) {
    const [, chatIdText, threadIdText] = profileKey.split(":");
    const chatId = Number(chatIdText);
    const threadId = Number(threadIdText);
    if (Number.isInteger(chatId) && Number.isInteger(threadId)) {
      return { kind: "pending-topic", chatId, threadId };
    }
  }
  if (profileKey.startsWith("leader:")) {
    return { kind: "leader", instanceId: profileKey.slice(7) };
  }
  return { kind: "legacy", key: profileKey };
}

function parseThreadOwner(value: unknown): TelegramThreadOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "leader") {
    return {
      kind: "leader",
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      instanceId:
        typeof record.instanceId === "string" ? record.instanceId : undefined,
      ...(typeof record.telegramProfile === "string"
        ? { telegramProfile: record.telegramProfile }
        : {}),
    };
  }
  if (
    record.kind === "manual-follower" &&
    typeof record.instanceId === "string"
  ) {
    return {
      kind: "manual-follower",
      instanceId: record.instanceId,
      ...(typeof record.telegramProfile === "string"
        ? { telegramProfile: record.telegramProfile }
        : {}),
    };
  }
  if (
    record.kind === "pending-topic" &&
    typeof record.chatId === "number" &&
    typeof record.threadId === "number" &&
    Number.isInteger(record.threadId)
  ) {
    return {
      kind: "pending-topic",
      chatId: record.chatId,
      threadId: record.threadId,
    };
  }
  if (record.kind === "legacy" && typeof record.key === "string") {
    return { kind: "legacy", key: record.key };
  }
  return undefined;
}

function getRecordOwner(
  record: TelegramTopicTargetRecord,
): TelegramThreadOwner {
  return (
    record.owner ?? getTelegramThreadOwnerFromProfileKey(record.profileKey)
  );
}

function getRecordOwnerKey(record: TelegramTopicTargetRecord): string {
  return getTelegramThreadOwnerKey(getRecordOwner(record));
}

function cloneRecord(
  record: TelegramTopicTargetRecord,
): TelegramTopicTargetRecord {
  const owner = getRecordOwner(record);
  return {
    ...record,
    owner: { ...owner },
    profileKey: getTelegramThreadOwnerKey(owner),
    target: { ...record.target },
  };
}

function getPersistedThreadName(
  record: Record<string, unknown>,
): string | undefined {
  const value =
    typeof record.threadName === "string"
      ? record.threadName
      : typeof record.displayName === "string"
        ? record.displayName
        : undefined;
  return value ? normalizeTelegramTopicTargetThreadName(value) : undefined;
}

function normalizeRecord(
  value: unknown,
): TelegramTopicTargetRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const target = record.target;
  const owner =
    parseThreadOwner(record.owner) ??
    (typeof record.profileKey === "string" && record.profileKey.length > 0
      ? getTelegramThreadOwnerFromProfileKey(record.profileKey)
      : undefined);
  if (!owner) return undefined;
  if (!target || typeof target !== "object" || Array.isArray(target))
    return undefined;
  const targetRecord = target as Record<string, unknown>;
  if (
    typeof targetRecord.chatId !== "number" ||
    typeof targetRecord.threadId !== "number" ||
    !Number.isInteger(targetRecord.threadId)
  ) {
    return undefined;
  }
  const status = record.status;
  if (
    status !== "active" &&
    status !== "offline" &&
    status !== "stale" &&
    status !== "pending" &&
    status !== "starting" &&
    status !== "probe-required" &&
    status !== "failed"
  )
    return undefined;
  if (
    typeof record.createdAtMs !== "number" ||
    typeof record.updatedAtMs !== "number"
  )
    return undefined;
  const normalized: TelegramTopicTargetRecord = {
    profileKey: getTelegramThreadOwnerKey(owner),
    owner,
    target: { chatId: targetRecord.chatId, threadId: targetRecord.threadId },
    status,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    threadName: getPersistedThreadName(record),
    ...(typeof record.manualThreadName === "string" &&
      normalizeTelegramTopicTargetThreadName(record.manualThreadName)
      ? { manualThreadName:
          normalizeTelegramTopicTargetThreadName(record.manualThreadName) }
      : {}),
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    slot: typeof record.slot === "string" ? record.slot : undefined,
  };
  const syncStatus = record.syncStatus ?? record.twinStatus;
  if (
    syncStatus === "open" ||
    syncStatus === "closed" ||
    syncStatus === "deleted" ||
    syncStatus === "unknown"
  ) {
    normalized.syncStatus = syncStatus;
  }
  if (typeof record.lastError === "string")
    normalized.lastError = record.lastError;
  const lastSyncObservedAtMs =
    record.lastSyncObservedAtMs ?? record.lastTwinObservedAtMs;
  if (typeof lastSyncObservedAtMs === "number") {
    normalized.lastSyncObservedAtMs = lastSyncObservedAtMs;
  }
  const lastSyncProbeAtMs =
    record.lastSyncProbeAtMs ?? record.lastTwinProbeAtMs;
  if (typeof lastSyncProbeAtMs === "number") {
    normalized.lastSyncProbeAtMs = lastSyncProbeAtMs;
  }
  const lastSyncError = record.lastSyncError ?? record.lastTwinError;
  if (typeof lastSyncError === "string") {
    normalized.lastSyncError = lastSyncError;
  }
  if (typeof record.lastReconcileAction === "string") {
    normalized.lastReconcileAction = record.lastReconcileAction;
  }
  if (typeof record.rerouteConfirmedAtMs === "number") {
    normalized.rerouteConfirmedAtMs = record.rerouteConfirmedAtMs;
  }
  return normalized;
}

function isCurrentThreadRecord(record: TelegramTopicTargetRecord): boolean {
  return (
    record.status === "active" ||
    record.status === "starting" ||
    record.status === "pending"
  );
}

function isPersistedThreadRecord(record: TelegramTopicTargetRecord): boolean {
  return isCurrentThreadRecord(record) || record.status === "probe-required";
}

function normalizeIdentityRecord(
  value: unknown,
): TelegramThreadIdentityRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.profileKey !== "string" || record.profileKey.length === 0)
    return undefined;
  if (typeof record.updatedAtMs !== "number") return undefined;
  const identity: TelegramThreadIdentityRecord = {
    profileKey: record.profileKey,
    updatedAtMs: record.updatedAtMs,
  };
  const persistedThreadName = getPersistedThreadName(record);
  if (persistedThreadName) {
    const threadName =
      normalizeTelegramTopicTargetThreadName(persistedThreadName);
    if (threadName) identity.threadName = threadName;
  }
  if (typeof record.slot === "string" && /^[A-Z]$/.test(record.slot)) {
    identity.slot = record.slot;
  }
  return identity.threadName || identity.slot ? identity : undefined;
}

function cloneIdentityRecord(
  identity: TelegramThreadIdentityRecord,
): TelegramThreadIdentityRecord {
  return { ...identity };
}

function getWorkspaceBindingMapKey(
  binding: Pick<TelegramWorkspaceThreadBinding, "cwd" | "instanceSlot">,
): string {
  return `${binding.cwd}\u0000${binding.instanceSlot}`;
}

function normalizeWorkspaceBindingRecord(
  value: unknown,
): TelegramWorkspaceThreadBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.cwd !== "string" ||
    typeof record.workspaceKey !== "string" ||
    typeof record.instanceSlot !== "string" ||
    typeof record.bindingKey !== "string" ||
    typeof record.updatedAtMs !== "number"
  ) {
    return undefined;
  }
  const cwd = normalizeTelegramWorkspacePath(record.cwd);
  if (
    !cwd ||
    cwd !== record.cwd ||
    !record.workspaceKey ||
    !/^[a-z]+$/u.test(record.instanceSlot) ||
    record.bindingKey !==
      (record.instanceSlot === "a"
        ? record.workspaceKey
        : `${record.workspaceKey}${record.instanceSlot}`)
  ) {
    return undefined;
  }
  const targetValue = record.target;
  if (
    !targetValue ||
    typeof targetValue !== "object" ||
    Array.isArray(targetValue)
  ) {
    return undefined;
  }
  const target = targetValue as Record<string, unknown>;
  if (
    typeof target.chatId !== "number" ||
    typeof target.threadId !== "number" ||
    !Number.isInteger(target.threadId)
  ) {
    return undefined;
  }
  const threadName = getPersistedThreadName(record);
  const manualThreadName =
    typeof record.manualThreadName === "string"
      ? normalizeTelegramTopicTargetThreadName(record.manualThreadName)
      : undefined;
  const slot =
    typeof record.slot === "string" && /^[A-Z]$/u.test(record.slot)
      ? record.slot
      : undefined;
  const journalBindingKeys = Array.isArray(record.journalBindingKeys) &&
    record.journalBindingKeys.every((key) =>
      typeof key === "string" && key.length > 0 && key.length <= 512,
    )
    ? Array.from(new Set(record.journalBindingKeys as string[]))
    : undefined;
  return {
    cwd,
    workspaceKey: record.workspaceKey,
    instanceSlot: record.instanceSlot,
    bindingKey: record.bindingKey,
    ...(record.showSlotSuffix === true ? { showSlotSuffix: true } : {}),
    ...(typeof record.displayTitle === "string" && record.displayTitle.trim()
      ? { displayTitle: record.displayTitle }
      : {}),
    ...(typeof record.inactiveSinceMs === "number" &&
      Number.isFinite(record.inactiveSinceMs) && record.inactiveSinceMs >= 0
      ? { inactiveSinceMs: record.inactiveSinceMs }
      : {}),
    ...(journalBindingKeys ? { journalBindingKeys } : {}),
    ...(record.journalBindingsComplete === true && journalBindingKeys
      ? { journalBindingsComplete: true as const }
      : {}),
    target: { chatId: target.chatId, threadId: target.threadId },
    ...(threadName ? { threadName } : {}),
    ...(manualThreadName ? { manualThreadName } : {}),
    ...(slot ? { slot } : {}),
    updatedAtMs: record.updatedAtMs,
  };
}

function cloneWorkspaceBinding(
  binding: TelegramWorkspaceThreadBinding,
): TelegramWorkspaceThreadBinding {
  return { ...binding, target: { ...binding.target } };
}

function normalizeWorkspaceRetirementIntent(
  value: unknown,
): TelegramWorkspaceRetirementIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const binding = normalizeWorkspaceBindingRecord(record.binding);
  if (
    typeof record.id !== "string" || !record.id ||
    record.reason !== "pressure" ||
    typeof record.profileKey !== "string" || !record.profileKey ||
    !binding?.slot || binding.inactiveSinceMs === undefined ||
    !((typeof record.leaderEpoch === "number" && Number.isFinite(record.leaderEpoch)) ||
      (typeof record.leaderEpoch === "string" && record.leaderEpoch.length > 0)) ||
    typeof record.requestedAtMs !== "number" || !Number.isFinite(record.requestedAtMs) ||
    record.requestedAtMs < 0
  ) return undefined;
  return {
    id: record.id,
    reason: record.reason,
    profileKey: record.profileKey,
    binding,
    leaderEpoch: record.leaderEpoch,
    requestedAtMs: record.requestedAtMs,
  };
}

function cloneWorkspaceRetirementIntent(
  intent: TelegramWorkspaceRetirementIntent,
): TelegramWorkspaceRetirementIntent {
  return { ...intent, binding: cloneWorkspaceBinding(intent.binding) };
}

function normalizeBotStateSnapshot(value: unknown): TelegramBotStateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { threadMode: "unknown" };
  }
  const record = value as Record<string, unknown>;
  const threadMode =
    record.threadMode === "enabled" || record.threadMode === "disabled"
      ? record.threadMode
      : "unknown";
  return {
    threadMode,
    updatedAtMs:
      typeof record.updatedAtMs === "number" ? record.updatedAtMs : undefined,
    lastSlot:
      typeof record.lastSlot === "string" && /^[A-Z]$/.test(record.lastSlot)
        ? record.lastSlot
        : undefined,
    lastReconcileAction:
      typeof record.lastReconcileAction === "string"
        ? record.lastReconcileAction
        : undefined,
  };
}

function normalizeSyncObservation(
  value: unknown,
): TelegramTopicSyncObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const targetValue = record.target;
  if (
    !targetValue ||
    typeof targetValue !== "object" ||
    Array.isArray(targetValue)
  ) {
    return undefined;
  }
  const targetRecord = targetValue as Record<string, unknown>;
  const target =
    typeof targetRecord.chatId === "number" &&
    typeof targetRecord.threadId === "number" &&
    Number.isInteger(targetRecord.threadId)
      ? { chatId: targetRecord.chatId, threadId: targetRecord.threadId }
      : undefined;
  const syncStatus = record.syncStatus;
  if (
    !target ||
    (syncStatus !== "open" &&
      syncStatus !== "closed" &&
      syncStatus !== "deleted" &&
      syncStatus !== "unknown")
  ) {
    return undefined;
  }
  return {
    target,
    syncStatus,
    observedAtMs:
      typeof record.observedAtMs === "number" ? record.observedAtMs : 0,
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    slot: typeof record.slot === "string" ? record.slot : undefined,
    lastSyncError:
      typeof record.lastSyncError === "string"
        ? record.lastSyncError
        : undefined,
    lastReconcileAction:
      typeof record.lastReconcileAction === "string"
        ? record.lastReconcileAction
        : undefined,
  };
}

function normalizePendingProvision(
  value: unknown,
): TelegramThreadPendingProvision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const owner = record.owner;
  if (owner !== "leader" && owner !== "manual-follower") return undefined;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (typeof record.instanceId !== "string" || record.instanceId.length === 0)
    return undefined;
  if (typeof record.startedAtMs !== "number") return undefined;
  let target: (TelegramTarget & { threadId: number }) | undefined;
  const targetValue = record.target;
  if (
    targetValue &&
    typeof targetValue === "object" &&
    !Array.isArray(targetValue)
  ) {
    const targetRecord = targetValue as Record<string, unknown>;
    if (
      typeof targetRecord.chatId === "number" &&
      typeof targetRecord.threadId === "number" &&
      Number.isInteger(targetRecord.threadId)
    ) {
      target = { chatId: targetRecord.chatId, threadId: targetRecord.threadId };
    }
  }
  return {
    id: record.id,
    owner,
    instanceId: record.instanceId,
    ...(typeof record.profileKey === "string"
      ? { profileKey: record.profileKey }
      : {}),
    ...(record.status === "in-flight" || record.status === "ambiguous"
      ? { status: record.status }
      : {}),
    ...(typeof record.threadName === "string"
      ? { threadName: record.threadName }
      : {}),
    ...(typeof record.displayTitle === "string" && record.displayTitle.trim()
      ? { displayTitle: record.displayTitle }
      : {}),
    ...(typeof record.slot === "string" ? { slot: record.slot } : {}),
    ...(target ? { target } : {}),
    startedAtMs: record.startedAtMs,
    ...(typeof record.expiresAtMs === "number"
      ? { expiresAtMs: record.expiresAtMs }
      : {}),
    ...(typeof record.leaderEpoch === "number" ||
    typeof record.leaderEpoch === "string"
      ? { leaderEpoch: record.leaderEpoch }
      : {}),
  };
}

function normalizePendingCleanup(
  value: unknown,
): TelegramThreadCleanupIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const targetValue = record.target;
  if (
    !targetValue ||
    typeof targetValue !== "object" ||
    Array.isArray(targetValue)
  ) {
    return undefined;
  }
  const targetRecord = targetValue as Record<string, unknown>;
  const owner = record.owner;
  if (owner !== "leader" && owner !== "manual-follower") return undefined;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (typeof record.instanceId !== "string" || record.instanceId.length === 0)
    return undefined;
  if (
    typeof record.runtimeGeneration !== "string" ||
    record.runtimeGeneration.length === 0
  ) {
    return undefined;
  }
  if (
    typeof targetRecord.chatId !== "number" ||
    typeof targetRecord.threadId !== "number" ||
    !Number.isInteger(targetRecord.threadId) ||
    typeof record.requestedAtMs !== "number"
  ) {
    return undefined;
  }
  return {
    id: record.id,
    owner,
    instanceId: record.instanceId,
    runtimeGeneration: record.runtimeGeneration,
    ...(typeof record.profileKey === "string"
      ? { profileKey: record.profileKey }
      : {}),
    target: {
      chatId: targetRecord.chatId,
      threadId: targetRecord.threadId,
    },
    requestedAtMs: record.requestedAtMs,
  };
}

function normalizeReservation(
  value: unknown,
): TelegramThreadReservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const targetValue = record.target;
  if (
    !targetValue ||
    typeof targetValue !== "object" ||
    Array.isArray(targetValue)
  ) {
    return undefined;
  }
  const targetRecord = targetValue as Record<string, unknown>;
  const target =
    typeof targetRecord.chatId === "number" &&
    typeof targetRecord.threadId === "number" &&
    Number.isInteger(targetRecord.threadId)
      ? { chatId: targetRecord.chatId, threadId: targetRecord.threadId }
      : undefined;
  const slot = typeof record.slot === "string" ? record.slot : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  if (!target || !slot || !reason) return undefined;
  return {
    target,
    slot,
    reason,
    createdAtMs:
      typeof record.createdAtMs === "number" ? record.createdAtMs : 0,
    updatedAtMs:
      typeof record.updatedAtMs === "number" ? record.updatedAtMs : 0,
    expiresAtMs:
      typeof record.expiresAtMs === "number" ? record.expiresAtMs : undefined,
    instanceId:
      typeof record.instanceId === "string" ? record.instanceId : undefined,
    lastReconcileAction:
      typeof record.lastReconcileAction === "string"
        ? record.lastReconcileAction
        : undefined,
  };
}

function parseTopicTargetFile(value: unknown): TelegramTopicTargetFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      version: 1,
      source: "snapshot",
      writtenAtMs: 0,
      bot: { threadMode: "unknown" },
      threads: [],
    };
  }
  const file = value as Record<string, unknown>;
  if (file.version !== 1) {
    return {
      version: 1,
      source: "snapshot",
      writtenAtMs: 0,
      bot: { threadMode: "unknown" },
      threads: [],
    };
  }
  const rawThreads = Array.isArray(file.threads) ? file.threads : [];
  const threads = rawThreads
    .map((record) => normalizeRecord(record))
    .filter(
      (record): record is TelegramTopicTargetRecord =>
        !!record && isPersistedThreadRecord(record),
    );
  return {
    version: 1,
    source: "snapshot",
    writtenAtMs: typeof file.writtenAtMs === "number" ? file.writtenAtMs : 0,
    bot: normalizeBotStateSnapshot(file.bot),
    threads,
    identities: Array.isArray(file.identities)
      ? file.identities.flatMap((identity) => {
          const normalized = normalizeIdentityRecord(identity);
          return normalized ? [normalized] : [];
        })
      : [],
    workspaceBindings: Array.isArray(file.workspaceBindings)
      ? file.workspaceBindings.flatMap((binding) => {
          const normalized = normalizeWorkspaceBindingRecord(binding);
          return normalized ? [normalized] : [];
        })
      : [],
    workspaceRetirements: Array.isArray(file.workspaceRetirements)
      ? file.workspaceRetirements.flatMap((intent) => {
          const normalized = normalizeWorkspaceRetirementIntent(intent);
          return normalized ? [normalized] : [];
        })
      : [],
    reservations: Array.isArray(file.reservations)
      ? file.reservations.flatMap((reservation) => {
          const normalized = normalizeReservation(reservation);
          return normalized ? [normalized] : [];
        })
      : [],
    pendingProvisions: Array.isArray(file.pendingProvisions)
      ? file.pendingProvisions.flatMap((provision) => {
          const normalized = normalizePendingProvision(provision);
          return normalized ? [normalized] : [];
        })
      : [],
    pendingCleanups: Array.isArray(file.pendingCleanups)
      ? file.pendingCleanups.flatMap((intent) => {
          const normalized = normalizePendingCleanup(intent);
          return normalized ? [normalized] : [];
        })
      : [],
    syncObservations: Array.isArray(file.syncObservations)
      ? file.syncObservations.flatMap((observation) => {
          const normalized = normalizeSyncObservation(observation);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

function getTelegramStateSemanticSnapshot(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { writtenAtMs: _writtenAtMs, ...semantic } = value as Record<
    string,
    unknown
  >;
  return semantic;
}

function targetMatches(left: TelegramTarget, right: TelegramTarget): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

function getTargetRecoveryHintKey(target: TelegramTarget): string {
  return `${target.chatId}:${target.threadId ?? "private"}`;
}

function parseFollowerRecoveryHints(
  value: unknown,
): Map<string, { slot?: string; threadName?: string }> {
  const hints = new Map<string, { slot?: string; threadName?: string }>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return hints;
  const liveRoster = (value as Record<string, unknown>).liveRoster;
  if (
    !liveRoster ||
    typeof liveRoster !== "object" ||
    Array.isArray(liveRoster)
  )
    return hints;
  const followers = (liveRoster as Record<string, unknown>).busFollowers;
  if (!Array.isArray(followers)) return hints;
  for (const follower of followers) {
    if (!follower || typeof follower !== "object" || Array.isArray(follower))
      continue;
    const record = follower as Record<string, unknown>;
    const target = record.target;
    if (!target || typeof target !== "object" || Array.isArray(target))
      continue;
    const targetRecord = target as Record<string, unknown>;
    if (typeof targetRecord.chatId !== "number") continue;
    const normalizedTarget: TelegramTarget = {
      chatId: targetRecord.chatId,
      ...(typeof targetRecord.threadId === "number"
        ? { threadId: targetRecord.threadId }
        : {}),
    };
    const slot =
      typeof targetRecord.slot === "string" && /^[A-Z]$/.test(targetRecord.slot)
        ? targetRecord.slot
        : typeof record.slot === "string" && /^[A-Z]$/.test(record.slot)
          ? record.slot
          : undefined;
    const threadName =
      typeof targetRecord.threadName === "string"
        ? targetRecord.threadName
        : typeof record.threadName === "string"
          ? record.threadName
          : undefined;
    hints.set(getTargetRecoveryHintKey(normalizedTarget), {
      ...(slot ? { slot } : {}),
      ...(threadName ? { threadName } : {}),
    });
  }
  return hints;
}

function getInstanceProcessKey(
  instanceId: string | undefined,
): string | undefined {
  if (!instanceId) return undefined;
  const [pid] = instanceId.split(":", 1);
  return pid && /^\d+$/.test(pid) ? pid : undefined;
}

export function isSameTelegramProcessInstance(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const leftProcess = getInstanceProcessKey(left);
  return !!leftProcess && leftProcess === getInstanceProcessKey(right);
}

function isPendingProvisionLiveOrTargeted(
  provision: TelegramThreadPendingProvision,
  nowMs: number,
): boolean {
  if (provision.status === "ambiguous") return true;
  if (provision.expiresAtMs === undefined || provision.expiresAtMs > nowMs) {
    return true;
  }
  return !!provision.target;
}

export function createTelegramTopicTargetStore(
  options: TelegramTopicTargetStoreOptions,
): TelegramTopicTargetStore {
  const getNowMs = options.getNowMs ?? Date.now;
  const captureExternalReservedSlots = (): string[] | undefined => {
    try {
      const slots = options.getExternalReservedSlots?.() ?? [];
      if (!Array.isArray(slots) ||
          slots.some((slot) => typeof slot !== "string" || !/^[A-Z]$/u.test(slot))) {
        return undefined;
      }
      return Array.from(new Set(slots));
    } catch {
      return undefined;
    }
  };
  let botState: TelegramBotStateSnapshot = { threadMode: "unknown" };
  let records = new Map<string, TelegramTopicTargetRecord>();
  let identities = new Map<string, TelegramThreadIdentityRecord>();
  let workspaceBindings = new Map<string, TelegramWorkspaceThreadBinding>();
  let workspaceRetirements: TelegramWorkspaceRetirementIntent[] = [];
  let workspaceRetirementCommitInFlight = false;
  const hasWorkspaceRetirementConflict = (input: {
    bindingKey?: string;
    cwd?: string;
    target?: TelegramTarget;
    slot?: string;
  }): boolean => workspaceRetirements.some((intent) =>
    (input.bindingKey !== undefined && intent.binding.bindingKey === input.bindingKey) ||
    (input.cwd !== undefined && intent.binding.cwd === input.cwd) ||
    (input.target !== undefined && targetMatches(intent.binding.target, input.target)) ||
    (input.slot !== undefined && intent.binding.slot === input.slot),
  );
  let workspaceClaims = new Map<
    string,
    { identity: TelegramWorkspaceBindingIdentity; instanceId: string }
  >();
  let reservations: TelegramThreadReservation[] = [];
  let pendingProvisions: TelegramThreadPendingProvision[] = [];
  let pendingCleanups: TelegramThreadCleanupIntent[] = [];
  let syncObservations: TelegramTopicSyncObservation[] = [];
  let followerRecoveryHints = new Map<
    string,
    { slot?: string; threadName?: string }
  >();
  let loaded = false;
  let loadedPath: string | undefined;
  let dirty = false;
  let mutationRevision = 0;
  let statusRevision = 0;
  let persistQueue: Promise<void> = Promise.resolve();
  let statusSnapshot: {
    runtime?: Record<string, unknown>;
    liveRoster?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  } = {};

  const reconcileWorkspaceSuffixExposure = (): void => {
    const directoryCounts = new Map<string, number>();
    const exposed = new Set<string>();
    for (const binding of workspaceBindings.values()) {
      directoryCounts.set(binding.cwd, (directoryCounts.get(binding.cwd) ?? 0) + 1);
      if (binding.showSlotSuffix) exposed.add(binding.cwd);
    }
    for (const binding of workspaceBindings.values()) {
      if ((directoryCounts.get(binding.cwd) ?? 0) > 1 || exposed.has(binding.cwd)) {
        binding.showSlotSuffix = true;
      }
    }
  };
  const rememberSlot = (slot: string | undefined, nowMs = getNowMs()) => {
    if (!slot || !/^[A-Z]$/.test(slot)) return;
    botState = { ...botState, lastSlot: slot, updatedAtMs: nowMs };
  };
  const rememberIdentity = (record: TelegramTopicTargetRecord) => {
    const profileKey = getRecordOwnerKey(record);
    if (!record.threadName && !record.slot) return;
    identities.set(profileKey, {
      profileKey,
      ...(record.threadName ? { threadName: record.threadName } : {}),
      ...(record.slot ? { slot: record.slot } : {}),
      updatedAtMs: record.updatedAtMs,
    });
  };
  const resolveWorkspaceKey = (cwd: string): string | undefined => {
    const known = [
      ...Array.from(workspaceBindings.values()),
      ...Array.from(workspaceClaims.values()).map((claim) => claim.identity),
    ];
    const existing = known.find((binding) => binding.cwd === cwd);
    if (existing) return existing.workspaceKey;
    const readable = createTelegramWorkspaceDirectoryKey(cwd);
    if (!readable) return undefined;
    const collision = known.some(
      (binding) =>
        binding.workspaceKey === readable && binding.cwd !== cwd,
    );
    if (!collision) return readable;
    const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const prefix = readable.endsWith("--") ? readable.slice(0, -2) : readable;
    return `${prefix.slice(0, TELEGRAM_WORKSPACE_KEY_MAX_LENGTH - digest.length - 3)}-${digest}--`;
  };
  const isWorkspaceTargetLive = (
    binding: TelegramWorkspaceThreadBinding,
  ): TelegramTopicTargetRecord | undefined =>
    Array.from(records.values()).find(
      (record) =>
        isCurrentThreadRecord(record) &&
        targetMatches(record.target, binding.target),
    );
  const findLegacyWorkspaceMigrationRecord = (
    cwd: string,
    instanceId: string,
    previousInstanceId?: string,
  ): TelegramTopicTargetRecord | undefined => {
    const processIds = new Set(
      [instanceId, previousInstanceId].filter(
        (value): value is string => !!value,
      ),
    );
    return Array.from(records.values())
      .filter((record) => {
        const owner = getRecordOwner(record);
        const belongsToWorkspace =
          owner.kind === "leader"
            ? owner.cwd
              ? normalizeTelegramWorkspacePath(owner.cwd) === cwd
              : !!record.instanceId && Array.from(processIds).some((processId) =>
                  isSameTelegramProcessInstance(record.instanceId, processId),
                )
            : owner.kind === "manual-follower" &&
              (processIds.has(owner.instanceId) ||
                (!!record.instanceId && processIds.has(record.instanceId)));
        if (!belongsToWorkspace) return false;
        const targetBinding = Array.from(workspaceBindings.values()).find(
          (binding) => targetMatches(binding.target, record.target),
        );
        return !targetBinding || targetBinding.cwd === cwd;
      })
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  };

  const getPath = () =>
    typeof options.path === "function" ? options.path() : options.path;
  const getTelegramProfile = () =>
    typeof options.telegramProfile === "function"
      ? options.telegramProfile()
      : options.telegramProfile;
  const scopeOwnerToActiveProfile = (
    owner: TelegramThreadOwner,
  ): TelegramThreadOwner => {
    const telegramProfile = getTelegramProfile();
    if (
      !telegramProfile ||
      owner.kind === "pending-topic" ||
      owner.kind === "legacy" ||
      owner.telegramProfile
    ) {
      return owner;
    }
    return { ...owner, telegramProfile };
  };
  const getRecoveryPath = (path: string) => `${path}.provision-recovery.json`;
  const readProvisionRecoveries = (
    path: string,
  ): TelegramProvisionRecoveryFile => {
    const recoveryPath = getRecoveryPath(path);
    if (!existsSync(recoveryPath)) return {};
    try {
      const value = JSON.parse(readFileSync(recoveryPath, "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as TelegramProvisionRecoveryFile)
        : {};
    } catch {
      return {};
    }
  };
  const resetForPath = (path: string) => {
    if (loadedPath === path) return;
    botState = { threadMode: "unknown" };
    records = new Map();
    identities = new Map();
    workspaceBindings = new Map();
    workspaceRetirements = [];
    workspaceRetirementCommitInFlight = false;
    workspaceClaims = new Map();
    reservations = [];
    pendingProvisions = [];
    pendingCleanups = [];
    syncObservations = [];
    followerRecoveryHints = new Map();
    statusSnapshot = {};
    loaded = false;
    dirty = false;
    loadedPath = path;
  };

  const loadFromDisk = async () => {
    const path = getPath();
    resetForPath(path);
    if (!existsSync(path)) {
      botState = { threadMode: "unknown" };
      records = new Map();
      identities = new Map();
      workspaceBindings = new Map();
      workspaceRetirements = [];
      workspaceRetirementCommitInFlight = false;
      reservations = [];
      pendingProvisions = [];
      pendingCleanups = [];
      syncObservations = [];
      followerRecoveryHints = new Map();
      loaded = true;
      return;
    }
    const revision = mutationRevision;
    const content = await readFile(path, "utf8");
    // A read begun before a local mutation must not replace the newly admitted
    // binding/cleanup state with its older disk snapshot.
    if (mutationRevision !== revision || getPath() !== path) return;
    const rawFile: unknown = JSON.parse(content);
    const file = parseTopicTargetFile(rawFile);
    followerRecoveryHints = parseFollowerRecoveryHints(rawFile);
    botState = file.bot;
    const scopedRecords = file.threads.map((record) =>
      cloneRecord({
        ...record,
        owner: scopeOwnerToActiveProfile(getRecordOwner(record)),
      }),
    );
    records = new Map(
      scopedRecords.map((record) => [getRecordOwnerKey(record), record]),
    );
    identities = new Map(
      (file.identities ?? []).map((identity) => {
        const owner = scopeOwnerToActiveProfile(
          getTelegramThreadOwnerFromProfileKey(identity.profileKey),
        );
        const profileKey = getTelegramThreadOwnerKey(owner);
        return [
          profileKey,
          cloneIdentityRecord({ ...identity, profileKey }),
        ];
      }),
    );
    workspaceBindings = new Map(
      (file.workspaceBindings ?? []).map((binding) => [
        getWorkspaceBindingMapKey(binding),
        cloneWorkspaceBinding(binding),
      ]),
    );
    workspaceRetirements = (file.workspaceRetirements ?? []).map(
      cloneWorkspaceRetirementIntent,
    );
    reconcileWorkspaceSuffixExposure();
    for (const record of records.values()) rememberIdentity(record);
    const nowMs = getNowMs();
    reservations = (file.reservations ?? [])
      .filter(
        (reservation) =>
          reservation.expiresAtMs === undefined ||
          reservation.expiresAtMs > nowMs,
      )
      .map((reservation) => ({ ...reservation }));
    const recoveries = readProvisionRecoveries(path);
    pendingProvisions = (file.pendingProvisions ?? [])
      .filter((provision) => isPendingProvisionLiveOrTargeted(provision, nowMs))
      .map((provision) => {
        const recovery = recoveries[provision.id];
        const recoveryMatches =
          recovery?.instanceId === provision.instanceId &&
          recovery.profileKey === provision.profileKey &&
          recovery.leaderEpoch === provision.leaderEpoch &&
          Number.isInteger(recovery.target?.threadId);
        return {
          ...provision,
          ...(recoveryMatches
            ? { target: { ...recovery.target }, status: "ambiguous" as const }
            : provision.target
              ? { target: { ...provision.target } }
              : {}),
        };
      });
    pendingCleanups = (file.pendingCleanups ?? []).map((intent) => ({
      ...intent,
      target: { ...intent.target },
    }));
    syncObservations = (file.syncObservations ?? []).map((observation) => ({
      ...observation,
      target: { ...observation.target },
    }));
    loaded = true;
    dirty = false;
  };

  const markDirty = (): void => {
    loaded = true;
    dirty = true;
    mutationRevision += 1;
  };

  const persistSnapshot = (invalidation?: {
    target: TelegramTarget;
    isCurrent: () => boolean;
    lastSyncError: string;
  }): Promise<boolean> => {
      const persist = persistQueue.then(async () => {
        const path = getPath();
        if (loadedPath !== path && !dirty) resetForPath(path);
        if (options.canPersist && !options.canPersist()) {
          if (!invalidation) await loadFromDisk();
          return false;
        }
        if (!dirty || !loaded) await loadFromDisk();
        if (invalidation && !invalidation.isCurrent()) return false;
        const nowMs = getNowMs();
        reservations = reservations.filter(
          (reservation) =>
            reservation.expiresAtMs === undefined ||
            reservation.expiresAtMs > nowMs,
        );
        pendingProvisions = pendingProvisions.filter((provision) =>
          isPendingProvisionLiveOrTargeted(provision, nowMs),
        );
        const currentRecords = Array.from(records.values())
          .filter(isPersistedThreadRecord)
          .map(cloneRecord);
        records = new Map(
          currentRecords.map((record) => [
            getRecordOwnerKey(record),
            cloneRecord(record),
          ]),
        );
        const persistedRevision = mutationRevision;
        const persistedStatusRevision = statusRevision;
        const file = {
          version: 1,
          source: "snapshot",
          writtenAtMs: nowMs,
          bot: botState,
          ...statusSnapshot,
          identities: Array.from(identities.values()).map(cloneIdentityRecord),
          workspaceBindings: Array.from(workspaceBindings.values()).map(
            cloneWorkspaceBinding,
          ),
          workspaceRetirements: workspaceRetirements.map(
            cloneWorkspaceRetirementIntent,
          ),
          reservations: reservations.map((reservation) => ({ ...reservation })),
          pendingProvisions: pendingProvisions.map((provision) => ({
            ...provision,
            ...(provision.target ? { target: { ...provision.target } } : {}),
          })),
          pendingCleanups: pendingCleanups.map((intent) => ({
            ...intent,
            target: { ...intent.target },
          })),
          syncObservations: syncObservations.map((observation) => ({
            ...observation,
            target: { ...observation.target },
          })),
          threads: currentRecords.map((record) => {
            const { profileKey: _profileKey, ...serialized } = record;
            return serialized;
          }),
        };
        if (invalidation) {
          const record = file.threads.find((record) => targetMatches(record.target, invalidation.target));
          if (!record) return false;
          file.threads = file.threads.filter((candidate) => candidate !== record);
          file.syncObservations = file.syncObservations.filter((observation) => !targetMatches(observation.target, record.target));
          file.syncObservations.push({
            target: { ...record.target },
            syncStatus: "deleted",
            observedAtMs: nowMs,
            ...(record.instanceId ? { instanceId: record.instanceId } : {}),
            ...(record.slot ? { slot: record.slot } : {}),
            lastSyncError: invalidation.lastSyncError,
            lastReconcileAction: "mark-stale",
          });
        }
        let persistedSemanticSnapshot: Record<string, unknown> | undefined;
        try {
          persistedSemanticSnapshot = getTelegramStateSemanticSnapshot(
            JSON.parse(await readFile(path, "utf8")),
          );
        } catch {
          /* missing or invalid snapshots must be replaced */
        }
        // Normalize optional fields to wire JSON; object key order is not a state change.
        if (
          isDeepStrictEqual(
            persistedSemanticSnapshot,
            getTelegramStateSemanticSnapshot(JSON.parse(JSON.stringify(file))),
          ) &&
          mutationRevision === persistedRevision &&
          statusRevision === persistedStatusRevision
        ) {
          loadedPath = path;
          loaded = true;
          dirty = false;
          return true;
        }
        await mkdir(dirname(path), { recursive: true });
        const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(tempPath, 0o600);
        try {
          if (invalidation) {
            let applied = false;
            const commit = () => {
              if (getPath() !== path || mutationRevision !== persistedRevision ||
                statusRevision !== persistedStatusRevision || !invalidation.isCurrent()) return;
              // Fence and rename share one synchronous commit boundary. No stale
              // invalidation enters the live projection before durable commit.
              renameSync(tempPath, path);
              loadedPath = path;
              records = new Map(Array.from(records).filter(([, record]) => !targetMatches(record.target, invalidation.target)));
              syncObservations = file.syncObservations;
              mutationRevision += 1;
              dirty = false;
              applied = true;
            };
            if (options.commitPersist) options.commitPersist(commit);
            else if (!options.canPersist || options.canPersist()) commit();
            if (!applied) await unlink(tempPath).catch(() => undefined);
            return applied;
          }
          if (options.commitPersist) {
            const committed = options.commitPersist(() => {
              renameSync(tempPath, path);
              chmodSync(path, 0o600);
            });
            if (!committed) {
              await loadFromDisk();
              throw new Error(
                "Telegram thread snapshot lost exact transport ownership before commit.",
              );
            }
          } else {
            await rename(tempPath, path);
            await chmod(path, 0o600);
          }
        } catch (error) {
          await unlink(tempPath).catch(() => undefined);
          throw error;
        }
        loadedPath = path;
        loaded = true;
        if (mutationRevision === persistedRevision) dirty = false;
        return true;
      });
      persistQueue = persist.then(() => undefined, () => undefined);
      return persist;
  };

  return {
    async load() {
      if (dirty) return;
      await loadFromDisk();
    },
    refresh() {
      const refresh = persistQueue.then(loadFromDisk);
      persistQueue = refresh.catch(() => undefined);
      return refresh;
    },
    async persist() {
      await persistSnapshot();
    },
    invalidateTarget(target, isCurrent, lastSyncError) {
      return persistSnapshot({ target, isCurrent, lastSyncError });
    },
    list() {
      return Array.from(records.values()).map(cloneRecord);
    },
    getFollowerRecoveryHintByTarget(target) {
      const hint = followerRecoveryHints.get(getTargetRecoveryHintKey(target));
      return hint ? { ...hint } : undefined;
    },
    listReservations() {
      const nowMs = getNowMs();
      return reservations
        .filter(
          (reservation) =>
            reservation.expiresAtMs === undefined ||
            reservation.expiresAtMs > nowMs,
        )
        .map((reservation) => ({ ...reservation }));
    },
    listPendingProvisions() {
      const nowMs = getNowMs();
      return pendingProvisions
        .filter((provision) =>
          isPendingProvisionLiveOrTargeted(provision, nowMs),
        )
        .map((provision) => ({
          ...provision,
          ...(provision.target ? { target: { ...provision.target } } : {}),
        }));
    },
    listPendingCleanups() {
      return pendingCleanups.map((intent) => ({
        ...intent,
        target: { ...intent.target },
      }));
    },
    listSyncObservations() {
      return syncObservations.map((observation) => ({
        ...observation,
        target: { ...observation.target },
      }));
    },
    reserveThread(reservation) {
      const next = { ...reservation };
      reservations = reservations.filter(
        (existing) =>
          existing.slot !== next.slot &&
          !targetMatches(existing.target, next.target),
      );
      reservations.push(next);
      markDirty();
    },
    upsertPendingProvision(provision) {
      const next = {
        ...provision,
        ...(provision.target ? { target: { ...provision.target } } : {}),
      };
      pendingProvisions = pendingProvisions.filter(
        (existing) => existing.id !== next.id,
      );
      pendingProvisions.push(next);
      markDirty();
    },
    async recordPendingProvisionTargetRecovery(provision, target) {
      const path = getPath();
      const recoveryPath = getRecoveryPath(path);
      await mkdir(dirname(recoveryPath), { recursive: true });
      withTelegramFileTransaction(`${recoveryPath}.transaction`, () => {
        const recoveries = readProvisionRecoveries(path);
        recoveries[provision.id] = {
          instanceId: provision.instanceId,
          ...(provision.profileKey ? { profileKey: provision.profileKey } : {}),
          ...(provision.leaderEpoch !== undefined
            ? { leaderEpoch: provision.leaderEpoch }
            : {}),
          target: { ...target },
        };
        const tempPath = `${recoveryPath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(tempPath, `${JSON.stringify(recoveries, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        renameSync(tempPath, recoveryPath);
        chmodSync(recoveryPath, 0o600);
      });
      const current = pendingProvisions.find(
        (entry) =>
          entry.id === provision.id &&
          entry.instanceId === provision.instanceId &&
          entry.profileKey === provision.profileKey &&
          entry.leaderEpoch === provision.leaderEpoch,
      );
      if (!current) return false;
      current.target = { ...target };
      current.status = "ambiguous";
      return true;
    },
    removePendingProvision(id) {
      const before = pendingProvisions.length;
      pendingProvisions = pendingProvisions.filter(
        (provision) => provision.id !== id,
      );
      const changed = pendingProvisions.length !== before;
      if (changed) markDirty();
      return changed;
    },
    upsertPendingCleanup(intent) {
      const next = { ...intent, target: { ...intent.target } };
      pendingCleanups = pendingCleanups.filter(
        (existing) => existing.id !== next.id,
      );
      pendingCleanups.push(next);
      markDirty();
    },
    removePendingCleanup(id) {
      const before = pendingCleanups.length;
      pendingCleanups = pendingCleanups.filter((intent) => intent.id !== id);
      const changed = pendingCleanups.length !== before;
      if (changed) markDirty();
      return changed;
    },
    getBotState() {
      return Object.fromEntries(
        Object.entries(botState).filter(([, value]) => value !== undefined),
      ) as TelegramBotStateSnapshot;
    },
    setBotState(state) {
      botState = { ...botState, ...state };
      markDirty();
    },
    setStatusSnapshot(snapshot) {
      if (!loadedPath) loadedPath = getPath();
      statusSnapshot = { ...snapshot };
      statusRevision += 1;
    },
    getByProfileKey(profileKey) {
      const ownerKey = getTelegramThreadOwnerKey(
        getTelegramThreadOwnerFromProfileKey(profileKey),
      );
      const record = records.get(ownerKey) ?? records.get(profileKey);
      return record ? cloneRecord(record) : undefined;
    },
    getActiveByInstanceId(instanceId) {
      for (const record of records.values()) {
        if (record.instanceId !== instanceId) continue;
        if (record.status !== "active" && record.status !== "starting")
          continue;
        return cloneRecord(record);
      }
      return undefined;
    },
    getIdentityByProfileKey(profileKey) {
      const ownerKey = getTelegramThreadOwnerKey(
        getTelegramThreadOwnerFromProfileKey(profileKey),
      );
      const identity = identities.get(ownerKey) ?? identities.get(profileKey);
      return identity ? cloneIdentityRecord(identity) : undefined;
    },
    forgetIdentityByProfileKey(profileKey) {
      const ownerKey = getTelegramThreadOwnerKey(
        getTelegramThreadOwnerFromProfileKey(profileKey),
      );
      const removedOwner = identities.delete(ownerKey);
      const removedProfile = identities.delete(profileKey);
      if (!removedOwner && !removedProfile) return false;
      markDirty();
      return true;
    },
    listWorkspaceBindings() {
      return Array.from(workspaceBindings.values()).map(cloneWorkspaceBinding);
    },
    listWorkspaceRetirementIntents() {
      return workspaceRetirements.map(cloneWorkspaceRetirementIntent);
    },
    commitWorkspaceJournalEvidence(expected, journalBindingKeys, complete) {
      if (workspaceRetirementCommitInFlight || hasWorkspaceRetirementConflict(expected)) {
        return undefined;
      }
      const key = getWorkspaceBindingMapKey(expected);
      const current = workspaceBindings.get(key);
      if (!current || !isDeepStrictEqual(current, expected) ||
          !journalBindingKeys.every((bindingKey) =>
            typeof bindingKey === "string" && bindingKey.length > 0 && bindingKey.length <= 512,
          )) return undefined;
      const keys = Array.from(new Set(journalBindingKeys));
      if ((current.journalBindingsComplete === true) === complete &&
          isDeepStrictEqual(current.journalBindingKeys ?? [], keys)) {
        return cloneWorkspaceBinding(current);
      }
      const next = { ...current, updatedAtMs: getNowMs() };
      if (keys.length) next.journalBindingKeys = keys;
      else delete next.journalBindingKeys;
      if (complete) next.journalBindingsComplete = true;
      else delete next.journalBindingsComplete;
      workspaceBindings.set(key, next);
      markDirty();
      return cloneWorkspaceBinding(next);
    },
    upsertWorkspaceRetirementIntent(intent) {
      const next = normalizeWorkspaceRetirementIntent(intent);
      if (!next) return false;
      const current = workspaceBindings.get(getWorkspaceBindingMapKey(next.binding));
      if (!current || !isDeepStrictEqual(current, next.binding)) return false;
      const sameId = workspaceRetirements.find((candidate) => candidate.id === next.id);
      if (sameId) return isDeepStrictEqual(sameId, next);
      if (workspaceRetirements.some((candidate) =>
        candidate.binding.bindingKey === next.binding.bindingKey ||
        candidate.binding.slot === next.binding.slot ||
        targetMatches(candidate.binding.target, next.binding.target),
      )) return false;
      workspaceRetirements.push(cloneWorkspaceRetirementIntent(next));
      markDirty();
      return true;
    },
    removeWorkspaceRetirementIntent(expected) {
      const index = workspaceRetirements.findIndex((candidate) =>
        isDeepStrictEqual(candidate, expected),
      );
      if (index < 0) return false;
      workspaceRetirements.splice(index, 1);
      markDirty();
      return true;
    },
    async replaceWorkspaceRetirementIntent(expected, replacement, isCurrent) {
      if (workspaceRetirementCommitInFlight || !isCurrent()) return false;
      const previous = normalizeWorkspaceRetirementIntent(expected);
      const next = normalizeWorkspaceRetirementIntent(replacement);
      if (!previous || !next || previous.id !== next.id ||
          previous.reason !== next.reason || previous.profileKey !== next.profileKey ||
          previous.requestedAtMs !== next.requestedAtMs ||
          !isDeepStrictEqual(previous.binding, next.binding)) return false;
      const binding = workspaceBindings.get(getWorkspaceBindingMapKey(previous.binding));
      const intentIndex = workspaceRetirements.findIndex((candidate) =>
        isDeepStrictEqual(candidate, previous),
      );
      if (!binding || !isDeepStrictEqual(binding, previous.binding) || intentIndex < 0) {
        return false;
      }
      if (isDeepStrictEqual(previous, next)) return true;
      workspaceRetirementCommitInFlight = true;
      workspaceRetirements[intentIndex] = cloneWorkspaceRetirementIntent(next);
      markDirty();
      const restoreInMemory = () => {
        workspaceRetirements = workspaceRetirements.filter(
          (candidate) => candidate.id !== previous.id,
        );
        workspaceRetirements.push(cloneWorkspaceRetirementIntent(previous));
        markDirty();
      };
      try {
        if (!isCurrent()) {
          restoreInMemory();
          return false;
        }
        const persisted = await persistSnapshot();
        if (!persisted) {
          restoreInMemory();
          return false;
        }
        return true;
      } catch (error) {
        try {
          await loadFromDisk();
        } catch {
          restoreInMemory();
          throw error;
        }
        if (workspaceRetirements.some((candidate) => isDeepStrictEqual(candidate, next))) {
          return true;
        }
        if (!workspaceRetirements.some((candidate) => isDeepStrictEqual(candidate, previous))) {
          restoreInMemory();
        }
        throw error;
      } finally {
        workspaceRetirementCommitInFlight = false;
      }
    },
    async commitInactiveWorkspaceCleanup(expected, isCurrent) {
      if (workspaceRetirementCommitInFlight || !isCurrent()) return false;
      const cleanupSnapshot = "bindingUpdatedAtMs" in expected ? expected : undefined;
      const normalized = cleanupSnapshot ? undefined : normalizeWorkspaceBindingRecord(expected);
      if (cleanupSnapshot && (!cleanupSnapshot.cwd || !cleanupSnapshot.workspaceKey ||
          !cleanupSnapshot.instanceSlot || !cleanupSnapshot.slot || !cleanupSnapshot.bindingKey ||
          !Number.isSafeInteger(cleanupSnapshot.inactiveSinceMs) ||
          !Number.isSafeInteger(cleanupSnapshot.bindingUpdatedAtMs) ||
          !Number.isSafeInteger(cleanupSnapshot.target.chatId) ||
          !Number.isSafeInteger(cleanupSnapshot.target.threadId) || cleanupSnapshot.target.threadId <= 0)) return false;
      if (!cleanupSnapshot && (!normalized?.slot || normalized.inactiveSinceMs === undefined)) return false;
      const mapKey = getWorkspaceBindingMapKey((cleanupSnapshot ?? normalized)!);
      const binding = workspaceBindings.get(mapKey);
      if (!binding) return isCurrent();
      const exact = cleanupSnapshot ? binding.cwd === cleanupSnapshot.cwd &&
        binding.workspaceKey === cleanupSnapshot.workspaceKey &&
        binding.instanceSlot === cleanupSnapshot.instanceSlot && binding.slot === cleanupSnapshot.slot &&
        binding.bindingKey === cleanupSnapshot.bindingKey && targetMatches(binding.target, cleanupSnapshot.target) &&
        binding.inactiveSinceMs === cleanupSnapshot.inactiveSinceMs &&
        binding.updatedAtMs === cleanupSnapshot.bindingUpdatedAtMs : isDeepStrictEqual(binding, normalized);
      if (!exact) return false;
      const nowMs = getNowMs();
      const targetOrSlotMatches = (candidate: { target?: TelegramTarget; slot?: string }) =>
        (candidate.target && targetMatches(candidate.target, binding.target)) || candidate.slot === binding.slot;
      const protectedLocally = Array.from(records.values()).some((record) =>
        isCurrentThreadRecord(record) && targetOrSlotMatches(record)) ||
        Array.from(workspaceClaims.values()).some((claim) =>
          claim.identity.bindingKey === binding.bindingKey || claim.identity.slot === binding.slot) ||
        reservations.some((reservation) =>
          (reservation.expiresAtMs === undefined || reservation.expiresAtMs > nowMs) && targetOrSlotMatches(reservation)) ||
        pendingProvisions.some((provision) =>
          isPendingProvisionLiveOrTargeted(provision, nowMs) && targetOrSlotMatches(provision)) ||
        pendingCleanups.some(targetOrSlotMatches) || workspaceRetirements.some((intent) =>
          intent.binding.bindingKey === binding.bindingKey || targetOrSlotMatches(intent.binding));
      if (protectedLocally) return false;
      workspaceRetirementCommitInFlight = true;
      workspaceBindings.delete(mapKey);
      markDirty();
      const restore = () => { workspaceBindings.set(mapKey, cloneWorkspaceBinding(binding)); markDirty(); };
      try {
        if (!isCurrent()) { restore(); return false; }
        if (!await persistSnapshot()) { restore(); return false; }
        return true;
      } catch (error) {
        try { await loadFromDisk(); } catch { restore(); throw error; }
        if (!workspaceBindings.has(mapKey)) return true;
        if (!isDeepStrictEqual(workspaceBindings.get(mapKey), binding)) restore();
        throw error;
      } finally { workspaceRetirementCommitInFlight = false; }
    },
    async commitWorkspaceRetirement(expected, isCurrent) {
      if (workspaceRetirementCommitInFlight || !isCurrent()) return false;
      const normalized = normalizeWorkspaceRetirementIntent(expected);
      if (!normalized) return false;
      const mapKey = getWorkspaceBindingMapKey(normalized.binding);
      const binding = workspaceBindings.get(mapKey);
      const intentIndex = workspaceRetirements.findIndex((candidate) =>
        isDeepStrictEqual(candidate, normalized),
      );
      if (!binding || !isDeepStrictEqual(binding, normalized.binding) || intentIndex < 0) {
        return false;
      }
      const nowMs = getNowMs();
      const targetOrSlotMatches = (candidate: {
        target?: TelegramTarget;
        slot?: string;
      }) =>
        (candidate.target && targetMatches(candidate.target, binding.target)) ||
        candidate.slot === binding.slot;
      const locallyProtected =
        Array.from(records.values()).some((record) =>
          isCurrentThreadRecord(record) && targetOrSlotMatches(record),
        ) ||
        Array.from(workspaceClaims.values()).some((claim) =>
          claim.identity.bindingKey === binding.bindingKey ||
          claim.identity.slot === binding.slot,
        ) ||
        reservations.some((reservation) =>
          (reservation.expiresAtMs === undefined || reservation.expiresAtMs > nowMs) &&
          targetOrSlotMatches(reservation),
        ) ||
        pendingProvisions.some((provision) =>
          isPendingProvisionLiveOrTargeted(provision, nowMs) &&
          targetOrSlotMatches(provision),
        ) ||
        pendingCleanups.some(targetOrSlotMatches) ||
        workspaceRetirements.some((candidate, index) =>
          index !== intentIndex &&
          (candidate.binding.bindingKey === binding.bindingKey ||
            targetOrSlotMatches(candidate.binding)),
        );
      if (locallyProtected) return false;
      const previousRetirements = workspaceRetirements.map(
        cloneWorkspaceRetirementIntent,
      );
      workspaceRetirementCommitInFlight = true;
      workspaceBindings.delete(mapKey);
      workspaceRetirements.splice(intentIndex, 1);
      markDirty();
      const restoreInMemory = () => {
        workspaceBindings.set(mapKey, cloneWorkspaceBinding(binding));
        workspaceRetirements = previousRetirements.map(
          cloneWorkspaceRetirementIntent,
        );
        markDirty();
      };
      try {
        if (!isCurrent()) {
          restoreInMemory();
          return false;
        }
        const persisted = await persistSnapshot();
        if (!persisted) {
          restoreInMemory();
          return false;
        }
        return true;
      } catch (error) {
        try {
          await loadFromDisk();
        } catch {
          restoreInMemory();
          throw error;
        }
        const committed = !workspaceBindings.has(mapKey) &&
          !workspaceRetirements.some((candidate) => candidate.id === normalized.id);
        if (committed) return true;
        if (!workspaceBindings.has(mapKey) ||
            !workspaceRetirements.some((candidate) => candidate.id === normalized.id)) {
          restoreInMemory();
        }
        throw error;
      } finally {
        workspaceRetirementCommitInFlight = false;
      }
    },
    captureWorkspaceSlotOccupancy(getExternalProtection, options) {
      const nowMs = getNowMs();
      const bindings = Array.from(workspaceBindings.values()).map((binding) => {
        const slot = binding.slot?.toLowerCase() ?? "";
        const targetOrSlotMatches = (candidate: {
          target?: TelegramTarget;
          slot?: string;
        }) =>
          (candidate.target && targetMatches(candidate.target, binding.target)) ||
          (!!binding.slot && candidate.slot === binding.slot);
        const locallyProtected =
          Array.from(records.values()).some((record) =>
            isCurrentThreadRecord(record) && targetOrSlotMatches(record),
          ) ||
          Array.from(workspaceClaims.values()).some((claim) =>
            claim.identity.bindingKey === binding.bindingKey ||
            (!!binding.slot && claim.identity.slot === binding.slot),
          ) ||
          reservations.some((reservation) =>
            (reservation.expiresAtMs === undefined || reservation.expiresAtMs > nowMs) &&
            targetOrSlotMatches(reservation),
          ) ||
          pendingProvisions.some((provision) =>
            isPendingProvisionLiveOrTargeted(provision, nowMs) &&
            targetOrSlotMatches(provision),
          ) ||
          pendingCleanups.some((intent) => targetOrSlotMatches(intent)) ||
          workspaceRetirements.some((intent) =>
            !isDeepStrictEqual(intent, options?.expectedRetirement) &&
            (intent.binding.bindingKey === binding.bindingKey ||
              targetOrSlotMatches(intent.binding)),
          );
        const externalProtection = getExternalProtection(cloneWorkspaceBinding(binding));
        const externalStates = [
          externalProtection.liveOwner,
          externalProtection.acceptedWork,
          externalProtection.deliveryAuthority,
        ];
        const hasValidInactivity = binding.inactiveSinceMs !== undefined &&
          Number.isFinite(binding.inactiveSinceMs) &&
          binding.inactiveSinceMs >= 0 && binding.inactiveSinceMs <= nowMs;
        const protection: TelegramWorkspaceSlotOccupancy["protection"] =
          locallyProtected || externalStates.includes("protected")
          ? "protected"
          : externalStates.every((state) => state === "clear") && hasValidInactivity
            ? "eligible"
            : "unknown";
        return {
          bindingKey: binding.bindingKey,
          slot,
          ...(binding.inactiveSinceMs !== undefined
            ? { inactiveSinceMs: binding.inactiveSinceMs }
            : {}),
          protection,
        };
      });
      const localReservedSlots = [
        ...Array.from(workspaceClaims.values()).map((claim) => claim.identity.slot),
        ...Array.from(records.values()).filter(isCurrentThreadRecord).map((record) => record.slot),
        ...reservations.filter((reservation) =>
          reservation.expiresAtMs === undefined || reservation.expiresAtMs > nowMs,
        ).map((reservation) => reservation.slot),
        ...pendingProvisions.filter((provision) =>
          isPendingProvisionLiveOrTargeted(provision, nowMs),
        ).map((provision) => provision.slot),
      ].filter((slot): slot is string => !!slot && /^[A-Z]$/u.test(slot))
        .map((slot) => slot.toLowerCase());
      const externalReservedSlots = captureExternalReservedSlots();
      const reservedSlots = externalReservedSlots
        ? [
            ...localReservedSlots,
            ...externalReservedSlots.map((slot) => slot.toLowerCase()),
          ]
        : [...localReservedSlots, "invalid"];
      return { bindings, reservedSlots };
    },
    hasWorkspaceBinding(cwd) {
      const normalizedCwd = normalizeTelegramWorkspacePath(cwd);
      return !!normalizedCwd && Array.from(workspaceBindings.values()).some(
        (binding) => binding.cwd === normalizedCwd,
      );
    },
    setWorkspaceDisplayTitle(expected, title) {
      if (hasWorkspaceRetirementConflict(expected)) return false;
      const key = getWorkspaceBindingMapKey(expected);
      const current = workspaceBindings.get(key);
      if (!current || !isDeepStrictEqual(current, expected) || !title.trim() ||
          title.length > 128) return false;
      if (current.displayTitle === title) return true;
      workspaceBindings.set(key, { ...current, displayTitle: title });
      markDirty();
      return true;
    },
    markWorkspaceBindingInactiveByTarget(target, inactiveSinceMs = getNowMs()) {
      if (!Number.isFinite(inactiveSinceMs) || inactiveSinceMs < 0) return false;
      for (const [key, binding] of workspaceBindings) {
        if (!targetMatches(binding.target, target) || binding.inactiveSinceMs !== undefined) continue;
        workspaceBindings.set(key, { ...binding, inactiveSinceMs });
        markDirty();
        return true;
      }
      return false;
    },
    markWorkspaceBindingActiveByTarget(target) {
      if (hasWorkspaceRetirementConflict({ target })) return false;
      for (const [key, binding] of workspaceBindings) {
        if (!targetMatches(binding.target, target) || binding.inactiveSinceMs === undefined) continue;
        const next = { ...binding };
        delete next.inactiveSinceMs;
        workspaceBindings.set(key, next);
        markDirty();
        return true;
      }
      return false;
    },
    getWorkspaceBinding(cwd, instanceSlot = "a") {
      const normalizedCwd = normalizeTelegramWorkspacePath(cwd);
      if (!normalizedCwd || !/^[a-z]+$/u.test(instanceSlot)) return undefined;
      const binding = workspaceBindings.get(
        getWorkspaceBindingMapKey({ cwd: normalizedCwd, instanceSlot }),
      );
      return binding ? cloneWorkspaceBinding(binding) : undefined;
    },
    claimWorkspaceIdentity(cwd, instanceId, previousInstanceId, options) {
      if (workspaceRetirementCommitInFlight) return undefined;
      const normalizedCwd = normalizeTelegramWorkspacePath(cwd);
      if (!normalizedCwd || !instanceId ||
          hasWorkspaceRetirementConflict({ cwd: normalizedCwd })) return undefined;
      const externalReservedSlots = captureExternalReservedSlots();
      if (!externalReservedSlots) {
        options?.onCapacityUnavailable?.();
        return undefined;
      }
      const externalReservedSlotKeys = externalReservedSlots.map((slot) =>
        slot.toLowerCase(),
      );
      for (const claim of workspaceClaims.values()) {
        if (claim.instanceId !== instanceId) continue;
        if (claim.identity.cwd !== normalizedCwd || !claim.identity.slot ||
            externalReservedSlotKeys.includes(claim.identity.slot.toLowerCase())) {
          return undefined;
        }
        if (
          options?.existingBindingOnly &&
          !workspaceBindings.has(getWorkspaceBindingMapKey(claim.identity))
        ) return undefined;
        return { ...claim.identity };
      }
      const workspaceKey = resolveWorkspaceKey(normalizedCwd);
      if (!workspaceKey) return undefined;
      let legacyRecord = findLegacyWorkspaceMigrationRecord(
        normalizedCwd,
        instanceId,
        previousInstanceId,
      );
      const legacyTarget = legacyRecord?.target;
      const targetBinding = legacyTarget
        ? Array.from(workspaceBindings.values()).find(
            (binding) =>
              binding.cwd === normalizedCwd &&
              targetMatches(binding.target, legacyTarget),
          )
        : undefined;
      let capacityUnavailable = false;
      const claimIdentity = (
        identity: TelegramWorkspaceBindingIdentity,
      ): TelegramWorkspaceBindingIdentity | undefined => {
        const mapKey = getWorkspaceBindingMapKey(identity);
        const existingClaim = workspaceClaims.get(mapKey);
        if (existingClaim) {
          return existingClaim.instanceId === instanceId
            ? { ...existingClaim.identity }
            : undefined;
        }
        const binding = workspaceBindings.get(mapKey);
        const liveRecord = binding
          ? isWorkspaceTargetLive(binding)
          : undefined;
        if (
          liveRecord &&
          liveRecord.instanceId !== instanceId &&
          liveRecord.instanceId !== previousInstanceId
        ) {
          return undefined;
        }
        const retainedTarget = binding?.target ?? legacyRecord?.target;
        const retainedSlot = binding?.slot ?? legacyRecord?.slot;
        const otherBindings = Array.from(workspaceBindings.values())
          .filter((other) => other.bindingKey !== identity.bindingKey && other.slot)
          .map((other) => ({
            bindingKey: other.bindingKey,
            slot: other.slot!.toLowerCase(),
            protection: "unknown" as const,
          }));
        const nowMs = getNowMs();
        const reservedSlots = [
          ...Array.from(workspaceClaims.values()).map((claim) => claim.identity.slot),
          ...Array.from(records.values())
            .filter((record) => isCurrentThreadRecord(record) &&
              !(retainedTarget && targetMatches(record.target, retainedTarget)))
            .map((record) => record.slot),
          ...reservations.filter((reservation) =>
            reservation.expiresAtMs === undefined || reservation.expiresAtMs > nowMs,
          ).map((reservation) => reservation.slot),
          ...pendingProvisions.filter((provision) =>
            isPendingProvisionLiveOrTargeted(provision, nowMs),
          ).map((provision) => provision.slot),
          ...externalReservedSlots,
        ].filter((slot): slot is string => !!slot).map((slot) => slot.toLowerCase());
        const retainedSlotKey = retainedSlot?.toLowerCase();
        if (retainedSlotKey && reservedSlots.includes(retainedSlotKey)) return undefined;
        const retainedSlotConflicts = !!retainedSlotKey &&
          otherBindings.some((other) => other.slot === retainedSlotKey);
        let slot = retainedSlotConflicts
          ? Array.from(TELEGRAM_WORKSPACE_SLOTS).find((candidate) =>
              !reservedSlots.includes(candidate) &&
              !otherBindings.some((other) => other.slot === candidate),
            )?.toUpperCase()
          : retainedSlot;
        if (!slot) {
          const allocation = planTelegramWorkspaceSlotAllocation({
            bindings: otherBindings,
            reservedSlots,
            nowMs,
          });
          if (allocation.kind === "blocked" && allocation.reason === "invalid-state") {
            return undefined;
          }
          if (allocation.kind !== "free") {
            capacityUnavailable = true;
            return undefined;
          }
          slot = allocation.slot.toUpperCase();
        }
        if (!slot || !/^[A-Z]$/u.test(slot)) return undefined;
        const claimedIdentity = { ...identity, slot };
        workspaceClaims.set(mapKey, { identity: claimedIdentity, instanceId });
        return { ...claimedIdentity };
      };
      if (options?.existingBindingOnly) {
        const candidates = Array.from(workspaceBindings.values())
          .filter((binding) => binding.cwd === normalizedCwd)
          .sort((left, right) =>
            left.instanceSlot.length - right.instanceSlot.length ||
            left.instanceSlot.localeCompare(right.instanceSlot),
          );
        for (const binding of candidates) {
          const claimed = claimIdentity({
            cwd: binding.cwd,
            workspaceKey: binding.workspaceKey,
            instanceSlot: binding.instanceSlot,
            bindingKey: binding.bindingKey,
          });
          if (claimed) return claimed;
        }
        if (!legacyRecord) return undefined;
      }
      if (targetBinding) {
        const claimed = claimIdentity({
          cwd: targetBinding.cwd,
          workspaceKey: targetBinding.workspaceKey,
          instanceSlot: targetBinding.instanceSlot,
          bindingKey: targetBinding.bindingKey,
        });
        if (claimed) return claimed;
        if (options?.existingBindingOnly) return undefined;
        // A migrated live peer is not a handoff or a target for another slot.
        legacyRecord = undefined;
      }
      const attemptLimit = workspaceBindings.size + workspaceClaims.size + 1;
      for (let ordinal = 0; ordinal < attemptLimit; ordinal += 1) {
        const identity = createTelegramWorkspaceBindingIdentityWithKey(
          normalizedCwd,
          workspaceKey,
          ordinal,
        );
        if (!identity) return undefined;
        const mapKey = getWorkspaceBindingMapKey(identity);
        const binding = workspaceBindings.get(mapKey);
        if (legacyRecord && binding) continue;
        const claimed = claimIdentity(identity);
        if (!claimed) continue;
        if (legacyRecord && !binding) {
          workspaceBindings.set(mapKey, {
            ...identity,
            target: { ...legacyRecord.target },
            ...(legacyRecord.threadName
              ? { threadName: legacyRecord.threadName }
              : {}),
            ...(legacyRecord.slot ? { slot: legacyRecord.slot } : {}),
            updatedAtMs: getNowMs(),
          });
          reconcileWorkspaceSuffixExposure();
          markDirty();
        }
        return claimed;
      }
      if (capacityUnavailable) options?.onCapacityUnavailable?.();
      return undefined;
    },
    releaseWorkspaceClaim(instanceId) {
      let released = false;
      for (const [key, claim] of workspaceClaims) {
        if (claim.instanceId !== instanceId) continue;
        workspaceClaims.delete(key);
        released = true;
      }
      return released;
    },
    upsertWorkspaceBinding(binding, claimInstanceId) {
      if (workspaceRetirementCommitInFlight) return undefined;
      const next = normalizeWorkspaceBindingRecord(binding);
      if (next && hasWorkspaceRetirementConflict(next)) return undefined;
      if (!next) return undefined;
      if (next.slot && Array.from(workspaceBindings.values()).some((existing) =>
        existing.bindingKey !== next.bindingKey && existing.slot === next.slot,
      )) return undefined;
      for (const existing of workspaceBindings.values()) {
        if (
          existing.workspaceKey === next.workspaceKey &&
          existing.cwd !== next.cwd
        ) {
          return undefined;
        }
      }
      const nextMapKey = getWorkspaceBindingMapKey(next);
      const previous = workspaceBindings.get(nextMapKey);
      if (previous?.showSlotSuffix) next.showSlotSuffix = true;
      if (previous?.manualThreadName && !next.manualThreadName) {
        next.manualThreadName = previous.manualThreadName;
      }
      if (previous) {
        const journalBindingKeys = Array.from(new Set([
          ...(previous.journalBindingKeys ?? []),
          ...(next.journalBindingKeys ?? []),
        ]));
        if (journalBindingKeys.length) next.journalBindingKeys = journalBindingKeys;
        else delete next.journalBindingKeys;
        if (previous.journalBindingsComplete) next.journalBindingsComplete = true;
        else delete next.journalBindingsComplete;
      }
      if (previous && !targetMatches(previous.target, next.target)) {
        delete next.displayTitle;
        delete next.inactiveSinceMs;
      } else if (previous) {
        if (previous.displayTitle) next.displayTitle = previous.displayTitle;
        if (previous.inactiveSinceMs !== undefined) next.inactiveSinceMs = previous.inactiveSinceMs;
      }
      const claim = workspaceClaims.get(nextMapKey);
      if (claimInstanceId) {
        if (claim?.instanceId !== claimInstanceId) return undefined;
        if (next.slot !== undefined && claim.identity.slot !== next.slot) return undefined;
        next.slot = claim.identity.slot;
      } else if (claim) {
        return undefined;
      }
      for (const [key, existing] of workspaceBindings) {
        if (key === nextMapKey) continue;
        if (targetMatches(existing.target, next.target)) {
          workspaceBindings.delete(key);
        }
      }
      workspaceBindings.set(nextMapKey, next);
      reconcileWorkspaceSuffixExposure();
      if (claim) workspaceClaims.delete(nextMapKey);
      markDirty();
      return cloneWorkspaceBinding(next);
    },
    upsert(record) {
      const next = cloneRecord(record);
      const nextOwnerKey = getRecordOwnerKey(next);
      const previousRecord = records.get(nextOwnerKey);
      if (isCurrentThreadRecord(next)) {
        for (const existing of Array.from(records.values())) {
          const existingOwnerKey = getRecordOwnerKey(existing);
          if (existingOwnerKey === nextOwnerKey) continue;
          if (!targetMatches(existing.target, next.target)) continue;
          records.delete(existingOwnerKey);
        }
      }
      if (
        next.instanceId &&
        (next.status === "active" || next.status === "starting")
      ) {
        for (const existing of records.values()) {
          if (existing.instanceId !== next.instanceId) continue;
          if (getRecordOwnerKey(existing) === nextOwnerKey) continue;
          if (targetMatches(existing.target, next.target)) continue;
          if (existing.status !== "active" && existing.status !== "starting")
            continue;
          records.delete(getRecordOwnerKey(existing));
        }
      }
      if (!isPersistedThreadRecord(next)) {
        rememberIdentity(next);
        records.delete(nextOwnerKey);
        markDirty();
        return cloneRecord(next);
      }
      records.set(nextOwnerKey, next);
      if (
        !previousRecord ||
        !targetMatches(previousRecord.target, next.target)
      ) {
        rememberSlot(next.slot, next.updatedAtMs);
      }
      rememberIdentity(next);
      markDirty();
      return cloneRecord(next);
    },
    markOfflineByInstanceId(instanceId) {
      let count = 0;
      for (const record of Array.from(records.values())) {
        if (
          record.instanceId !== instanceId ||
          (record.status !== "active" && record.status !== "starting")
        )
          continue;
        records.delete(getRecordOwnerKey(record));
        count += 1;
      }
      if (count > 0) markDirty();
      return count;
    },
    markStaleByTarget(target, syncStatus = "unknown", lastSyncError) {
      const record = Array.from(records.values()).find((entry) => targetMatches(entry.target, target));
      const pending = syncStatus === "deleted" ? pendingProvisions.find((entry) =>
        entry.target && targetMatches(entry.target, target),
      ) : undefined;
      const source = record ?? pending;
      if (!source?.target) return false;
      syncObservations = syncObservations.filter((entry) => !targetMatches(entry.target, target));
      syncObservations.push({
        target: { ...source.target }, syncStatus, observedAtMs: getNowMs(),
        ...(source.instanceId ? { instanceId: source.instanceId } : {}),
        ...(source.slot ? { slot: source.slot } : {}),
        ...(lastSyncError ? { lastSyncError } : {}),
        lastReconcileAction: "mark-stale",
      });
      if (record) {
        rememberIdentity(record);
        records.delete(getRecordOwnerKey(record));
      }
      if (syncStatus === "deleted") {
        pendingProvisions = pendingProvisions.filter((entry) =>
          !entry.target || !targetMatches(entry.target, target),
        );
      }
      markDirty();
      return true;
    },
    markActiveByTarget(target) {
      const nowMs = getNowMs();
      for (const record of records.values()) {
        if (!targetMatches(record.target, target)) continue;
        record.status = "active";
        record.updatedAtMs = nowMs;
        record.syncStatus = "open";
        record.lastSyncObservedAtMs = nowMs;
        record.lastReconcileAction = "mark-active";
        delete record.lastError;
        delete record.lastSyncError;
        markDirty();
        return true;
      }
      return false;
    },
    renameByTarget(target, threadName, options) {
      if (hasWorkspaceRetirementConflict({ target })) return undefined;
      const nowMs = getNowMs();
      const normalizedThreadName =
        normalizeTelegramTopicTargetThreadName(threadName);
      if (!normalizedThreadName) return undefined;
      for (const record of records.values()) {
        if (!targetMatches(record.target, target)) continue;
        record.manualThreadName = normalizedThreadName;
        record.updatedAtMs = nowMs;
        for (const binding of workspaceBindings.values()) {
          if (!targetMatches(binding.target, target)) continue;
          const previousTitle = binding.displayTitle ?? binding.manualThreadName ??
            binding.threadName;
          binding.manualThreadName = normalizedThreadName;
          binding.displayTitle = options?.updateDisplayTitle === false
            ? previousTitle : normalizedThreadName;
          binding.updatedAtMs = nowMs;
        }
        markDirty();
        return cloneRecord(record);
      }
      return undefined;
    },
    clearManualNameByTarget(target, automaticTitle) {
      if (hasWorkspaceRetirementConflict({ target })) return undefined;
      const title = normalizeTelegramTopicTargetThreadName(automaticTitle);
      if (!title) return undefined;
      const nowMs = getNowMs();
      for (const record of records.values()) {
        if (!targetMatches(record.target, target)) continue;
        delete record.manualThreadName;
        record.updatedAtMs = nowMs;
        for (const binding of workspaceBindings.values()) {
          if (!targetMatches(binding.target, target)) continue;
          delete binding.manualThreadName;
          binding.displayTitle = title;
          binding.updatedAtMs = nowMs;
        }
        markDirty();
        return cloneRecord(record);
      }
      return undefined;
    },
    claimReusableTarget(instanceId, threadName) {
      const nowMs = getNowMs();
      const candidates = Array.from(records.values())
        .filter((record) => {
          if (record.instanceId) return false;
          if (!record.slot || !/^[A-Z]$/u.test(record.slot)) return false;
          if (record.slot === "A") return false;
          if (record.status !== "pending") return false;
          return !Array.from(records.values()).some(
            (other) =>
              other !== record &&
              other.slot === record.slot &&
              (other.status === "active" || other.status === "starting"),
          );
        })
        .sort((left, right) => {
          const leftSlot = left.slot ?? "Z";
          const rightSlot = right.slot ?? "Z";
          if (leftSlot !== rightSlot) return leftSlot.localeCompare(rightSlot);
          return left.createdAtMs - right.createdAtMs;
        });
      const record = candidates[0];
      if (!record) return undefined;
      record.status = "active";
      record.instanceId = instanceId;
      record.updatedAtMs = nowMs;
      if (
        !record.threadName &&
        threadName &&
        isTelegramTopicThreadNameValidForSlot(threadName, record.slot)
      )
        record.threadName = threadName;
      delete record.lastError;
      rememberIdentity(record);
      markDirty();
      return cloneRecord(record);
    },
    allocateSlot(profileKey, preferredSlot, workspaceBindingKey, options) {
      if (workspaceRetirementCommitInFlight) return undefined;
      const externalReservedSlots = captureExternalReservedSlots();
      if (!externalReservedSlots) return undefined;
      const isExternalSlotOccupied = (slot: string): boolean =>
        externalReservedSlots.includes(slot);
      const ownerKey = getTelegramThreadOwnerKey(
        getTelegramThreadOwnerFromProfileKey(profileKey),
      );
      const existing = records.get(ownerKey) ?? records.get(profileKey);
      const nowMs = getNowMs();
      const isWorkspaceSlotOccupied = (slot: string): boolean =>
        Array.from(workspaceBindings.values()).some((binding) =>
          binding.bindingKey !== workspaceBindingKey && binding.slot === slot,
        );
      const isWorkspaceClaimSlotOccupied = (slot: string): boolean =>
        Array.from(workspaceClaims.values()).some((claim) =>
          claim.identity.bindingKey !== workspaceBindingKey &&
          claim.identity.slot === slot,
        );
      if (existing?.slot && isCurrentThreadRecord(existing) &&
          !options?.excludeCurrentRecord) {
        const bindingConflict = Array.from(workspaceBindings.values()).some(
          (binding) => binding.bindingKey !== workspaceBindingKey &&
            binding.slot === existing.slot &&
            !targetMatches(binding.target, existing.target),
        );
        const claimConflict = Array.from(workspaceClaims.values()).some(
          (claim) => claim.identity.bindingKey !== workspaceBindingKey &&
            claim.identity.slot === existing.slot &&
            claim.instanceId !== existing.instanceId,
        );
        return bindingConflict || claimConflict ||
          isExternalSlotOccupied(existing.slot) ? undefined : existing.slot;
      }
      if (workspaceBindingKey) {
        const claim = Array.from(workspaceClaims.values()).find((claim) =>
          claim.identity.bindingKey === workspaceBindingKey,
        );
        const slot = claim?.identity.slot;
        if (!slot) return undefined;
        const foreignClaim = Array.from(workspaceClaims.values()).some((other) =>
          other !== claim && other.identity.slot === slot,
        );
        const foreignBinding = Array.from(workspaceBindings.values()).some((binding) =>
          binding.bindingKey !== workspaceBindingKey && binding.slot === slot,
        );
        if (foreignClaim || foreignBinding || isExternalSlotOccupied(slot) ||
            isTelegramTopicTargetSlotOccupied(
              slot, records, reservations, pendingProvisions, nowMs,
            )) return undefined;
        return slot;
      }
      if (
        preferredSlot &&
        !isExternalSlotOccupied(preferredSlot) &&
        !isWorkspaceSlotOccupied(preferredSlot) &&
        !isWorkspaceClaimSlotOccupied(preferredSlot) &&
        !isTelegramTopicTargetSlotOccupied(
          preferredSlot,
          records,
          reservations,
          pendingProvisions,
          nowMs,
        )
      ) {
        return preferredSlot;
      }
      const next = getNextMonotonicSlot(
        records,
        reservations,
        pendingProvisions,
        nowMs,
        botState.lastSlot,
      );
      if (next && !isExternalSlotOccupied(next) &&
          !isWorkspaceSlotOccupied(next) &&
          !isWorkspaceClaimSlotOccupied(next)) return next;
      return Array.from(TELEGRAM_WORKSPACE_SLOTS, (slot) => slot.toUpperCase())
        .find((slot) =>
          !isExternalSlotOccupied(slot) &&
          !isWorkspaceSlotOccupied(slot) &&
          !isWorkspaceClaimSlotOccupied(slot) &&
          !isTelegramTopicTargetSlotOccupied(
            slot, records, reservations, pendingProvisions, nowMs,
          ),
        );
    },
  };
}

function isTelegramTopicTargetSlotOccupied(
  slot: string,
  records: Map<string, TelegramTopicTargetRecord>,
  reservations: readonly TelegramThreadReservation[] = [],
  pendingProvisions: readonly TelegramThreadPendingProvision[] = [],
  nowMs = Date.now(),
): boolean {
  for (const record of records.values()) {
    if (record.slot === slot && isCurrentThreadRecord(record)) return true;
  }
  for (const reservation of reservations) {
    if (
      reservation.expiresAtMs !== undefined &&
      reservation.expiresAtMs <= nowMs
    )
      continue;
    if (reservation.slot === slot) return true;
  }
  for (const provision of pendingProvisions) {
    if (
      provision.status !== "ambiguous" &&
      provision.expiresAtMs !== undefined &&
      provision.expiresAtMs <= nowMs
    )
      continue;
    if (provision.slot === slot) return true;
  }
  return false;
}

export function normalizeTelegramTopicTargetThreadName(
  threadName: string,
): string {
  return threadName.replace(/\s+/g, " ").trim().slice(0, 96);
}

function getGraphemeSegments(value: string): string[] {
  const segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: "grapheme" },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!segmenter) return Array.from(value);
  return Array.from(
    new segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (part) => part.segment,
  );
}

export function getTelegramTopicIdentityName(threadName: string): string {
  return getGraphemeSegments(normalizeTelegramTopicTargetThreadName(threadName))
    .join("")
    .trim();
}

const TELEGRAM_THREAD_NAME_PALETTE: Record<string, readonly string[]> = {
  A: ["Atlas", "Aster", "Aurora", "Anchor", "Ashen"],
  B: ["Beacon", "Briar", "Boreal", "Birch", "Bison"],
  C: ["Cedar", "Comet", "Cipher", "Coral", "Cinder"],
  D: ["Delta", "Dawn", "Drift", "Dune", "Dagger"],
  E: ["Ember", "Echo", "Eagle", "Eden", "Elder"],
  F: ["Falcon", "Fjord", "Flint", "Forest", "Fable"],
  G: ["Grove", "Glade", "Glyph", "Garnet", "Gale"],
  H: ["Harbor", "Hawk", "Hazel", "Helix", "Haven"],
  I: ["Iris", "Ivory", "Iron", "Isle", "Idea"],
  J: ["Jade", "Juno", "Jolt", "Jewel", "Jasper"],
  K: ["Kite", "Karma", "Kernel", "Kodiak", "Kelp"],
  L: ["Lumen", "Laurel", "Lynx", "Lotus", "Lagoon"],
  M: ["Maple", "Meteor", "Meadow", "Marble", "Moss"],
  N: ["Nimbus", "Nova", "Nectar", "North", "Noble"],
  O: ["Orion", "Onyx", "Opal", "Orbit", "Olive"],
  P: ["Pine", "Pulse", "Praxis", "Pebble", "Prism"],
  Q: ["Quartz", "Quill", "Quasar", "Quest", "Quiver"],
  R: ["River", "Raven", "Rune", "Reef", "Ridge"],
  S: ["Spruce", "Solar", "Signal", "Stone", "Sable"],
  T: ["Timber", "Talon", "Terra", "Torch", "Tide"],
  U: ["Umber", "Unity", "Ursa", "Uplink", "Ulmus"],
  V: ["Violet", "Vector", "Vista", "Vale", "Vortex"],
  W: ["Willow", "Warden", "Wave", "Winter", "Wisp"],
  X: ["Xenon", "Xylem", "Xavier", "Xylo", "Xerus"],
  Y: ["Yarrow", "Yonder", "Yukon", "Yale", "Yogi"],
  Z: ["Zenith", "Zephyr", "Zircon", "Zebra", "Zion"],
};

export function listOccupiedTelegramThreadIdentities(input: {
  records: readonly TelegramTopicTargetRecord[];
  workspaceBindings?: readonly TelegramWorkspaceThreadBinding[];
  pendingProvisions?: readonly TelegramThreadPendingProvision[];
  exceptTarget?: TelegramTarget;
  exceptWorkspaceBindingKey?: string;
}): string[] {
  const occupied = new Set<string>();
  const add = (threadName: string | undefined): void => {
    if (!threadName) return;
    occupied.add(getTelegramTopicIdentityName(threadName));
  };
  for (const record of input.records) {
    if (!isCurrentThreadRecord(record)) continue;
    if (input.exceptTarget && targetMatches(record.target, input.exceptTarget))
      continue;
    add(record.manualThreadName);
    add(record.threadName);
  }
  for (const binding of input.workspaceBindings ?? []) {
    if (binding.bindingKey === input.exceptWorkspaceBindingKey) continue;
    if (input.exceptTarget && targetMatches(binding.target, input.exceptTarget))
      continue;
    add(binding.manualThreadName);
    add(binding.threadName);
  }
  for (const pending of input.pendingProvisions ?? []) {
    if (
      input.exceptTarget &&
      pending.target &&
      targetMatches(pending.target, input.exceptTarget)
    ) {
      continue;
    }
    add(pending.threadName);
  }
  return Array.from(occupied);
}

export function chooseTelegramThreadName(input: {
  slot: string | undefined;
  entropy?: number | string;
  getRandom?: () => number;
  occupied?: readonly string[];
}): string | undefined {
  if (!input.slot || !/^[A-Z]$/.test(input.slot)) return undefined;
  const names = TELEGRAM_THREAD_NAME_PALETTE[input.slot];
  if (!names || names.length === 0) return undefined;
  const occupied = new Set(
    (input.occupied ?? []).map((name) => getTelegramTopicIdentityName(name)),
  );
  const start = input.getRandom
    ? Math.max(
        0,
        Math.min(
          names.length - 1,
          Math.floor(input.getRandom() * names.length),
        ),
      )
    : getTelegramThreadNameEntropyIndex(input.entropy, names.length);
  for (let offset = 0; offset < names.length; offset += 1) {
    const name = names[(start + offset) % names.length];
    if (!occupied.has(getTelegramTopicIdentityName(name))) return name;
  }
  for (const paletteSlot of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    for (const name of TELEGRAM_THREAD_NAME_PALETTE[paletteSlot] ?? []) {
      if (!occupied.has(getTelegramTopicIdentityName(name))) return name;
    }
  }
  return undefined;
}

function getTelegramThreadNameLeadingSlot(
  threadName: string | undefined,
): string | undefined {
  if (!threadName) return undefined;
  const first = getTelegramTopicIdentityName(threadName)[0];
  return first && /^[A-Z]$/.test(first) ? first : undefined;
}

function getNextTelegramThreadNamePaletteSlot(
  records: readonly TelegramTopicTargetRecord[],
  fallbackSlot: string | undefined,
): string | undefined {
  let maxCode = "A".charCodeAt(0) - 1;
  for (const record of records) {
    if (!isCurrentThreadRecord(record) || !record.threadName) continue;
    const identity = getTelegramTopicIdentityName(record.threadName);
    const first = identity[0];
    if (!first || !/^[A-Z]$/.test(first)) continue;
    maxCode = Math.max(maxCode, first.charCodeAt(0));
  }
  if (maxCode < "A".charCodeAt(0)) return fallbackSlot;
  let code = maxCode + 1;
  if (code > "Z".charCodeAt(0)) code = "A".charCodeAt(0);
  return String.fromCharCode(code);
}

function getTelegramThreadNameEntropyIndex(
  entropy: number | string | undefined,
  length: number,
): number {
  if (length <= 1) return 0;
  if (typeof entropy === "number" && entropy < 1_000_000_000_000) return 0;
  const value = entropy === undefined ? "0" : String(entropy);
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % length;
}

export function getTelegramTopicThreadNameValidationError(
  threadName: string,
  _slot: string | undefined,
): string | undefined {
  const identity = getTelegramTopicIdentityName(threadName);
  const reasons: string[] = [];
  if (!identity) reasons.push("it is empty after trimming");
  if (/\s/.test(identity)) reasons.push("it contains spaces");
  if (/[^A-Za-z]/.test(identity)) {
    reasons.push("it contains characters outside Latin A-Z letters");
  }
  if (!/^[A-Z]/.test(identity)) {
    reasons.push("it does not start with an uppercase Latin letter");
  }
  const genericLabels = new Set(["telegram", "leader", "follower"]);
  if (genericLabels.has(identity.toLowerCase())) {
    reasons.push("it is a generic role label");
  }
  if (/^[A-Z]$/.test(identity)) reasons.push("it is only a bare slot letter");
  if (reasons.length === 0) return undefined;
  return `Invalid Telegram instance name: ${reasons.join("; ")}. Use exactly one capitalized Latin word with no spaces, punctuation, emoji, non-Latin letters, or digits; it must not be a generic role label or only a bare slot letter.`;
}

export function getTelegramManualThreadDisplayNameValidationError(
  threadName: string,
): string | undefined {
  const trimmed = threadName.trim();
  const normalized = trimmed.replace(/\s+/g, " ");
  const reasons: string[] = [];
  if (!trimmed) reasons.push("it is empty after trimming");
  if (trimmed && /[^\x20-\x7E]/.test(trimmed)) {
    reasons.push("it contains characters outside printable ASCII");
  }
  if (normalized.length > 96) reasons.push("it is longer than 96 characters");
  if (/^[A-Z]$/.test(normalized)) {
    reasons.push("a bare slot letter is reserved for reset to automatic");
  }
  if (reasons.length === 0) return undefined;
  return `Invalid Telegram Thread display name: ${reasons.join("; ")}. Use 1–96 printable ASCII characters.`;
}

export function isTelegramTopicThreadNameValidForSlot(
  threadName: string,
  slot: string | undefined,
): boolean {
  return !getTelegramTopicThreadNameValidationError(threadName, slot);
}

function applyTopicNameTemplate(
  template: string,
  request: TelegramTopicTargetProvisionRequest,
  slot?: string,
): string {
  const threadName =
    request.threadName?.replace(/\s+/g, " ").trim() || request.profileKey;
  let result = template
    .replaceAll("{threadName}", threadName)
    .replaceAll("{profileKey}", request.profileKey)
    .replaceAll("{instanceId}", request.instanceId);
  if (slot) result = result.replaceAll("{slot}", slot);
  return result;
}

export function getTelegramTopicName(
  request: TelegramTopicTargetProvisionRequest,
  template = "{slot}",
  slot?: string,
): string {
  const name = applyTopicNameTemplate(template, request, slot)
    .replace(/\s+/g, " ")
    .trim();
  return (name || slot || "Pi").slice(0, 128);
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export interface TelegramPromoteFollowerBindingToLeaderDeps {
  store: TelegramTopicTargetStore;
  instanceId: string;
  cwd?: string;
  telegramProfile?: string;
  target?: TelegramTarget;
  slot?: string;
  threadName?: string;
  nowMs?: number;
}

export async function promoteTelegramFollowerBindingToLeader(
  deps: TelegramPromoteFollowerBindingToLeaderDeps,
): Promise<TelegramTopicTargetRecord | undefined> {
  const target = deps.target;
  if (typeof target?.threadId !== "number") return undefined;
  await deps.store.load();
  const nowMs = deps.nowMs ?? Date.now();
  const existing = deps.store
    .list()
    .find(
      (record) =>
        record.target.chatId === target.chatId &&
        record.target.threadId === target.threadId,
    );
  const workspaceIdentity = deps.cwd
    ? deps.store.claimWorkspaceIdentity(deps.cwd, deps.instanceId,
        existing?.instanceId, { existingBindingOnly: true })
    : undefined;
  const workspaceBinding = workspaceIdentity
    ? deps.store.getWorkspaceBinding(
        workspaceIdentity.cwd, workspaceIdentity.instanceSlot,
      )
    : undefined;
  const exactWorkspaceBinding = workspaceBinding &&
    targetMatches(workspaceBinding.target, target)
    ? workspaceBinding : undefined;
  const slot = existing
    ? deps.store.allocateSlot(existing.profileKey)
    : exactWorkspaceBinding ? workspaceIdentity?.slot : undefined;
  if (!slot || (deps.slot && deps.slot !== slot)) {
    deps.store.releaseWorkspaceClaim(deps.instanceId);
    return undefined;
  }
  if (exactWorkspaceBinding && exactWorkspaceBinding.slot !== slot) {
    const committed = deps.store.upsertWorkspaceBinding({
      ...exactWorkspaceBinding, slot, updatedAtMs: nowMs,
    }, deps.instanceId);
    if (!committed) {
      deps.store.releaseWorkspaceClaim(deps.instanceId);
      return undefined;
    }
    await deps.store.persist();
  }
  const owner: TelegramThreadOwner = {
    kind: "leader",
    cwd: deps.cwd,
    instanceId: deps.instanceId,
    ...(deps.telegramProfile ? { telegramProfile: deps.telegramProfile } : {}),
  };
  const record = deps.store.upsert({
    profileKey: getTelegramThreadOwnerKey(owner),
    owner,
    target: { chatId: target.chatId, threadId: target.threadId },
    status: "active",
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
    ...((existing?.threadName ?? deps.threadName)
      ? { threadName: existing?.threadName ?? deps.threadName }
      : {}),
    instanceId: deps.instanceId,
    slot,
    ...(existing?.syncStatus ? { syncStatus: existing.syncStatus } : {}),
    ...(existing?.lastSyncObservedAtMs !== undefined
      ? { lastSyncObservedAtMs: existing.lastSyncObservedAtMs }
      : {}),
    lastReconcileAction: "follower-promoted-to-leader",
    ...(existing?.rerouteConfirmedAtMs !== undefined
      ? { rerouteConfirmedAtMs: existing.rerouteConfirmedAtMs }
      : {}),
  });
  await deps.store.persist();
  deps.store.releaseWorkspaceClaim(deps.instanceId);
  return record;
}

export interface TelegramOwnTopicProvisionDeps {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  cwd?: string;
  telegramProfile?: string;
  requestedThreadName?: string;
  preferredSlot?: string;
  workspaceBindingKey?: string;
  resolveInitialWorkspaceDisplayTitle?: (
    binding: TelegramWorkspaceDisplayBinding,
  ) => string | undefined;
  getNowMs?: () => number;
  getRandom?: () => number;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  store: TelegramTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  recordEvent: (
    category: string,
    message: string,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramOwnTopicProvisionResult {
  target: TelegramTarget & { threadId: number };
  slot: string;
  threadName?: string;
  displayTitle?: string;
  reused: boolean;
}

/**
 * Provision a topic for the bus leader's own use (slot A).
 * This is a thread-binding primitive; sync policy decides when startup/connect
 * should call it to ensure the leader has a visible working thread.
 */
export async function provisionOwnBusTopic(
  deps: TelegramOwnTopicProvisionDeps,
): Promise<TelegramOwnTopicProvisionResult | undefined> {
  const chatId = deps.getAllowedUserId();
  let profileKey = getTelegramThreadOwnerKey({
    kind: "leader",
    cwd: deps.cwd,
    instanceId: deps.instanceId,
    telegramProfile: deps.telegramProfile,
  });
  if (typeof chatId !== "number") return undefined;
  await deps.store.load();
  const reservationCleanupPorts = {
    isCleanupTargetProtected: createTelegramCleanupTargetProtection(deps.store),
    callApi: deps.callApi,
    markStaleByTarget: (
      target: TelegramTarget & { threadId: number },
      syncStatus?: "closed" | "deleted",
      lastSyncError?: string,
    ) => deps.store.markStaleByTarget(target, syncStatus, lastSyncError),
    removePendingProvisionById: (id: string) =>
      deps.store.removePendingProvision(id),
    persist: () => deps.store.persist(),
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    recordRuntimeEvent(
      category: string,
      error: unknown,
      details?: Record<string, unknown>,
    ) {
      deps.recordEvent(
        category,
        error instanceof Error ? error.message : String(error),
        details,
      );
    },
  };
  const reservationCleanupNowMs = Date.now();
  const reservationsBeforeCleanup = deps.store.listReservations();
  const reservationCleanupPlan = ThreadReconciler.planThreadReconciliation({
    nowMs: reservationCleanupNowMs,
    currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
    previousState: deps.getThreadReconciliationMachineState?.(),
    records: deps.store.list(),
    reservations: reservationsBeforeCleanup,
    pendingProvisions: deps.store.listPendingProvisions(),
    proactiveReservationCleanup: true,
  });
  deps.recordThreadReconciliationPlan?.(reservationCleanupPlan);
  const reservationCleanupApplyStartedAtMs = Date.now();
  await ThreadReconciler.applyThreadReconciliationPlan(
    reservationCleanupPlan,
    reservationCleanupPorts,
  );
  deps.recordEvent("bus", "Bus leader reservation cleanup reconciled", {
    phase: "leader-topic-reservation-cleanup-duration",
    durationMs: Date.now() - reservationCleanupApplyStartedAtMs,
    actions: reservationCleanupPlan.actions.length,
  });
  const nowMs = Date.now();
  const currentLeaderOwner: TelegramThreadOwner = {
    kind: "leader",
    cwd: deps.cwd,
    instanceId: deps.instanceId,
    ...(deps.telegramProfile ? { telegramProfile: deps.telegramProfile } : {}),
  };
  const leaderSessionHandoff = getTelegramLeaderSessionHandoff();
  if (
    isTelegramLeaderSessionHandoffFresh(leaderSessionHandoff) &&
    leaderSessionHandoff.profileKey === profileKey
  ) {
    const existingHandoffRecord = deps.store
      .list()
      .find((record) =>
        targetMatches(record.target, leaderSessionHandoff.target),
      );
    deps.store.upsert({
      profileKey,
      owner: currentLeaderOwner,
      target: { ...leaderSessionHandoff.target },
      status: "active",
      createdAtMs:
        existingHandoffRecord?.createdAtMs ?? leaderSessionHandoff.createdAtMs,
      updatedAtMs: nowMs,
      threadName:
        existingHandoffRecord?.threadName ?? leaderSessionHandoff.threadName,
      instanceId: deps.instanceId,
      slot: existingHandoffRecord?.slot ?? leaderSessionHandoff.slot,
      ...(existingHandoffRecord?.syncStatus
        ? { syncStatus: existingHandoffRecord.syncStatus }
        : {}),
      ...(existingHandoffRecord?.lastSyncObservedAtMs !== undefined
        ? {
            lastSyncObservedAtMs: existingHandoffRecord.lastSyncObservedAtMs,
          }
        : {}),
      lastReconcileAction: "leader-session-handoff-restored",
    });
    await deps.store.persist();
    setTelegramLeaderSessionHandoff(undefined);
    deps.recordEvent("bus", "Bus leader session handoff restored", {
      phase: "leader-session-handoff-restore",
      chatId: leaderSessionHandoff.target.chatId,
      threadId: leaderSessionHandoff.target.threadId,
      slot: existingHandoffRecord?.slot ?? leaderSessionHandoff.slot,
      threadName:
        existingHandoffRecord?.threadName ?? leaderSessionHandoff.threadName,
      previousInstanceId: leaderSessionHandoff.instanceId,
      instanceId: deps.instanceId,
    });
  } else if (leaderSessionHandoff) {
    setTelegramLeaderSessionHandoff(undefined);
  }
  const recordsBeforePreviousLeaderCleanup = deps.store.list();
  const previousLeaderCleanupPlan = ThreadReconciler.planThreadReconciliation({
    nowMs,
    currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
    previousState: deps.getThreadReconciliationMachineState?.(),
    records: recordsBeforePreviousLeaderCleanup.map((record) => ({
      ...record,
      ownerKind: record.owner?.kind,
    })),
    pendingProvisions: deps.store.listPendingProvisions(),
    previousLeaderCleanup: { currentInstanceId: deps.instanceId },
  });
  deps.recordThreadReconciliationPlan?.(previousLeaderCleanupPlan);
  for (const action of previousLeaderCleanupPlan.actions) {
    if (action.kind !== "close-delete-previous-leader-topic") continue;
    const record = recordsBeforePreviousLeaderCleanup.find((candidate) =>
      targetMatches(candidate.target, action.target),
    );
    if (!record) continue;
    const isSameProfile = record.profileKey === profileKey;
    if (isSameProfile) {
      deps.recordEvent("bus", "Bus leader same-profile topic preserved", {
        phase: "leader-topic-same-profile-preserve",
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
        previousInstanceId: record.instanceId,
        instanceId: deps.instanceId,
        profileKey,
      });
      continue;
    }
    if (isSameTelegramProcessInstance(record.instanceId, deps.instanceId)) {
      deps.store.upsert({
        ...record,
        profileKey,
        owner: currentLeaderOwner,
        status: "active",
        instanceId: deps.instanceId,
        updatedAtMs: nowMs,
        lastError: undefined,
        lastReconcileAction: "leader-topic-same-process-preserve",
      });
      deps.recordEvent("bus", "Bus leader same-process topic preserved", {
        phase: "leader-topic-same-process-preserve",
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
        previousInstanceId: record.instanceId,
        instanceId: deps.instanceId,
        profileKey,
      });
      continue;
    }
    const previousLeaderCleanupStartedAtMs = Date.now();
    const isCleanupTargetProtected = createTelegramCleanupTargetProtection(deps.store, record);
    const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(
      { actions: [action] },
      {
        isCleanupTargetProtected,
        callApi: deps.callApi,
        markStaleByTarget: (target, syncStatus, lastSyncError) =>
          deps.store.markStaleByTarget(target, syncStatus, lastSyncError),
        persist: () => deps.store.persist(),
        removePendingProvisionById: (id) =>
          deps.store.removePendingProvision(id),
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        recordRuntimeEvent(category, error, details) {
          deps.recordEvent(
            category,
            error instanceof Error ? error.message : String(error),
            details,
          );
        },
      },
    );
    deps.recordEvent("bus", "Bus leader previous-topic cleanup applied", {
      phase: "leader-topic-previous-cleanup-duration",
      durationMs: Date.now() - previousLeaderCleanupStartedAtMs,
      chatId: record.target.chatId,
      threadId: record.target.threadId,
      slot: record.slot,
    });
    if (
      deps.getCurrentLeaderEpoch &&
      (action.leaderEpoch === undefined ||
        deps.getCurrentLeaderEpoch() !== action.leaderEpoch)
    ) {
      deps.recordEvent(
        "bus",
        "Skipped previous-topic local cleanup after leader epoch loss",
        {
          phase: "leader-topic-previous-cleanup-stale-epoch-skip",
          actionLeaderEpoch: action.leaderEpoch,
          currentLeaderEpoch: deps.getCurrentLeaderEpoch(),
          chatId: record.target.chatId,
          threadId: record.target.threadId,
        },
      );
      throw new Error(
        "Telegram leader ownership changed during topic reconciliation.",
      );
    }
    if (cleanup.incompleteActions?.length) {
      throw new Error(
        "Previous Telegram leader topic deletion was not confirmed.",
      );
    }
    if (isCleanupTargetProtected(action.target, action)) continue;
    deps.store.markStaleByTarget(record.target);
    if (record.slot) {
      deps.store.reserveThread({
        target: record.target,
        slot: record.slot,
        reason: "previous-process-cleaned-without-visible-probe",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + TELEGRAM_THREAD_RESERVATION_TTL_MS,
        instanceId: record.instanceId,
        lastReconcileAction: "leader-topic-previous-instance-cleaned-no-probe",
      });
    }
    deps.store.setBotState({
      threadMode: "enabled",
      updatedAtMs: nowMs,
      lastReconcileAction: "leader-topic-next-slot-after-unprobed-previous",
    });
    deps.recordEvent(
      "bus",
      "Bus leader previous-process topic reserved after cleanup without visible probe",
      {
        phase: "leader-topic-previous-instance-reserve-no-probe",
        chatId: record.target.chatId,
        threadId: record.target.threadId,
        slot: record.slot,
        previousInstanceId: record.instanceId,
        instanceId: deps.instanceId,
      },
    );
  }
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: chatId,
    store: deps.store,
    callApi: deps.callApi,
    getNowMs: deps.getNowMs,
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getRandom: deps.getRandom,
    resolveInitialWorkspaceDisplayTitle:
      deps.resolveInitialWorkspaceDisplayTitle,
    claimPendingTargets: false,
  });
  let result = await provision({
    instanceId: deps.instanceId,
    owner: currentLeaderOwner,
    profileKey,
    ...(deps.requestedThreadName
      ? { threadName: deps.requestedThreadName }
      : {}),
    ...(deps.preferredSlot ? { preferredSlot: deps.preferredSlot } : {}),
    ...(deps.workspaceBindingKey
      ? {
          workspaceBindingKey: deps.workspaceBindingKey,
          ...(deps.cwd ? { workspaceCwd: deps.cwd } : {}),
        }
      : {}),
  });
  if (result.reused) {
    // Reused topics may already have a human-chosen Telegram title. Do not edit
    // them during leader startup: startup reconciliation must not reset a named
    // topic back to its bare slot or create redundant "renamed the thread" service
    // messages. Also do not probe with Bot API chat actions: every chat action is
    // user-visible as native typing/activity, so reload would falsely signal that
    // the agent is working. Treat the reused binding as optimistically open;
    // ordinary target-scoped sends still detect stale topics and trigger the
    // stale-api-error reconciliation path when real delivery happens.
    const nowMs = Date.now();
    deps.store.upsert({
      ...result.record,
      syncStatus: "open",
      lastSyncObservedAtMs: nowMs,
      lastReconcileAction: "leader-startup-skip-probe",
    });
  }
  deps.store.setBotState({
    threadMode: "enabled",
    updatedAtMs: Date.now(),
    lastReconcileAction: result.reused
      ? "leader-startup-skip-probe"
      : "leader-topic-created",
  });
  await deps.store.persist();
  deps.recordEvent("bus", "Bus leader own topic assigned", {
    phase: "leader-topic",
    chatId: result.target.chatId,
    threadId: result.target.threadId,
    slot: result.record.slot,
    threadName: result.record.threadName,
    reused: result.reused,
  });
  if (!result.record.slot) {
    throw new Error("Telegram Thread slot authority is unavailable.");
  }
  return {
    target: result.target,
    slot: result.record.slot,
    ...(result.record.threadName
      ? { threadName: result.record.threadName }
      : {}),
    ...(result.displayTitle ? { displayTitle: result.displayTitle } : {}),
    reused: result.reused,
  };
}

export interface TelegramInstanceThreadIdentityCandidate {
  target?: TelegramTarget;
  slot?: string;
  threadName?: string;
}

export function resolveTelegramInstanceThreadIdentity(options: {
  target?: TelegramTarget;
  follower?: TelegramInstanceThreadIdentityCandidate;
  leader?: TelegramInstanceThreadIdentityCandidate;
  record?: TelegramTopicTargetRecord;
}): TelegramInstanceThreadIdentityCandidate {
  const targetMatchesCandidate = (
    candidate: TelegramInstanceThreadIdentityCandidate | undefined,
  ) => {
    if (!candidate) return false;
    if (!options.target) return true;
    return (
      !!candidate.target && targetMatches(candidate.target, options.target)
    );
  };
  const local = targetMatchesCandidate(options.follower)
    ? options.follower
    : targetMatchesCandidate(options.leader)
      ? options.leader
      : undefined;
  const record =
    options.record &&
    (!options.target || targetMatches(options.record.target, options.target))
      ? options.record
      : undefined;
  return {
    ...((local?.target ?? record?.target)
      ? { target: local?.target ?? record?.target }
      : {}),
    ...((local?.slot ?? record?.slot)
      ? { slot: local?.slot ?? record?.slot }
      : {}),
    ...((local?.threadName ?? record?.threadName)
      ? { threadName: local?.threadName ?? record?.threadName }
      : {}),
  };
}

export interface TelegramLeaderThreadStateRuntime {
  getTarget(): TelegramTarget | undefined;
  getIdentity(): TelegramInstanceThreadIdentityCandidate | undefined;
  set(
    input: TelegramInstanceThreadIdentityCandidate & { target: TelegramTarget },
  ): void;
  clear(): void;
}

export function createTelegramLeaderThreadStateRuntime(): TelegramLeaderThreadStateRuntime {
  let identity:
    | (TelegramInstanceThreadIdentityCandidate & { target: TelegramTarget })
    | undefined;
  return {
    getTarget: () => identity?.target,
    getIdentity: () => identity,
    set(input) {
      identity = { ...input, target: { ...input.target } };
    },
    clear() {
      identity = undefined;
    },
  };
}

export interface TelegramCurrentInstanceThreadRuntime {
  findRecord(): TelegramTopicTargetRecord | undefined;
  getRecord(): TelegramTopicTargetRecord | undefined;
  getIdentity(target?: TelegramTarget): TelegramInstanceThreadIdentityCandidate;
  getRestorationIdentity(): TelegramInstanceThreadIdentityCandidate;
}

export interface TelegramCurrentInstanceThreadRuntimeDeps {
  instanceId: string;
  listRecords(): readonly TelegramTopicTargetRecord[];
  getPreferredTarget(): TelegramTarget | undefined;
  getFollower():
    | (TelegramInstanceThreadIdentityCandidate & { registered: boolean })
    | undefined;
  getLeader(): TelegramInstanceThreadIdentityCandidate | undefined;
}

export function createTelegramCurrentInstanceThreadRuntime(
  deps: TelegramCurrentInstanceThreadRuntimeDeps,
): TelegramCurrentInstanceThreadRuntime {
  const findRecord = function (): TelegramTopicTargetRecord | undefined {
    return findCurrentTelegramInstanceThreadRecord({
      records: deps.listRecords(),
      instanceId: deps.instanceId,
      preferredTarget: deps.getPreferredTarget(),
    });
  };
  const getRecord = function (): TelegramTopicTargetRecord | undefined {
    const record = findRecord();
    const follower = deps.getFollower();
    if (record?.owner?.kind === "manual-follower" && !follower?.registered) {
      return undefined;
    }
    return record;
  };
  return {
    findRecord,
    getRecord,
    getIdentity(target) {
      const follower = deps.getFollower();
      const record = target
        ? findCurrentTelegramInstanceThreadRecord({
            records: deps.listRecords(),
            instanceId: deps.instanceId,
            preferredTarget: target,
          })
        : getRecord();
      return resolveTelegramInstanceThreadIdentity({
        target,
        follower: follower?.registered ? follower : undefined,
        leader: deps.getLeader(),
        record,
      });
    },
    getRestorationIdentity() {
      const follower = deps.getFollower();
      return resolveTelegramInstanceThreadIdentity({
        follower: follower?.registered ? follower : undefined,
        leader: deps.getLeader(),
        record: findRecord(),
      });
    },
  };
}

export function findCurrentTelegramInstanceThreadRecord(options: {
  records: readonly TelegramTopicTargetRecord[];
  instanceId: string;
  preferredTarget?: TelegramTarget;
}): TelegramTopicTargetRecord | undefined {
  const target = options.preferredTarget;
  if (typeof target?.threadId === "number") {
    const targetRecord = options.records.find((record) => {
      return (
        record.target.chatId === target.chatId &&
        record.target.threadId === target.threadId
      );
    });
    if (targetRecord) return targetRecord;
  }
  return options.records.find((record) => {
    return (
      record.instanceId === options.instanceId && record.status === "active"
    );
  });
}

export function resolveTelegramInstanceThreadTarget(options: {
  followerTarget?: TelegramTarget;
  leaderTarget?: TelegramTarget;
  currentRecord?: TelegramTopicTargetRecord;
}): (TelegramTarget & { threadId: number }) | undefined {
  const raw =
    typeof options.followerTarget?.threadId === "number"
      ? options.followerTarget
      : (options.currentRecord?.target ?? options.leaderTarget);
  return raw &&
    typeof raw.chatId === "number" &&
    typeof raw.threadId === "number"
    ? { chatId: raw.chatId, threadId: raw.threadId }
    : undefined;
}

export interface TelegramThreadStatusProjectionRuntime {
  getBusRole(): "leader" | "follower" | undefined;
  getBusFollowers(): ReturnType<typeof listTelegramThreadStatusFollowers>;
  getLocalBus(): {
    leaderSocketPath: string;
    leaderTransport: "socket" | "pipe";
    followerSocketPath: string;
    followerTransport: "socket" | "pipe";
    followerRegistered: boolean;
    followerTarget?: TelegramTarget;
    followerSlot?: string;
    followerThreadName?: string;
    leaderProtocol?: {
      protocolVersion: number;
      runtimeBuild: string;
      capabilities: string[];
    };
  };
  getTopicTargets(): ReturnType<typeof listTelegramThreadStatusTargets>;
  getThreadReservations(): ReturnType<
    typeof listTelegramThreadStatusReservations
  >;
  getTopicSyncObservations(): ReturnType<
    typeof listTelegramThreadStatusObservations
  >;
  getInstanceSlot(): string | undefined;
  getInstanceThreadName(): string | undefined;
}

export interface TelegramThreadStatusProjectionRuntimeDeps {
  getThreadMode(): "unknown" | "enabled" | "disabled";
  isBusPollingStarted(): boolean;
  isFollowerRegistered(): boolean;
  listFollowers(): readonly TelegramThreadStatusFollowerView[];
  listRecords(): readonly TelegramTopicTargetRecord[];
  listReservations(): readonly TelegramThreadReservation[];
  listSyncObservations(): readonly TelegramTopicSyncObservation[];
  getLeaderSocketPath(): string;
  getFollowerSocketPath(): string;
  getTransportKind(path: string): "socket" | "pipe";
  getFollowerTarget(): TelegramTarget | undefined;
  getFollowerSlot(): string | undefined;
  getFollowerThreadName(): string | undefined;
  getLeaderProtocol?():
    | {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
      }
    | undefined;
  getCurrentIdentity(): TelegramInstanceThreadIdentityCandidate;
  getDisplayTitle?: (target: TelegramTarget) => string | undefined;
}

export function createTelegramThreadStatusProjectionRuntime(
  deps: TelegramThreadStatusProjectionRuntimeDeps,
): TelegramThreadStatusProjectionRuntime {
  return {
    getBusRole() {
      if (deps.getThreadMode() === "disabled") return undefined;
      if (deps.isBusPollingStarted()) return "leader";
      return deps.isFollowerRegistered() ? "follower" : undefined;
    },
    getBusFollowers() {
      return listTelegramThreadStatusFollowers({
        followers: deps.listFollowers(),
        records: deps.listRecords(),
      }).map((follower) => ({
        ...follower,
        threadName: (follower.target ? deps.getDisplayTitle?.(follower.target) : undefined) ?? follower.threadName,
      }));
    },
    getLocalBus() {
      const leaderSocketPath = deps.getLeaderSocketPath();
      const followerSocketPath = deps.getFollowerSocketPath();
      const leaderProtocol = deps.getLeaderProtocol?.();
      const followerTarget = deps.getFollowerTarget();
      return {
        leaderSocketPath,
        leaderTransport: deps.getTransportKind(leaderSocketPath),
        followerSocketPath,
        followerTransport: deps.getTransportKind(followerSocketPath),
        followerRegistered: deps.isFollowerRegistered(),
        followerTarget,
        followerSlot: deps.getFollowerSlot(),
        followerThreadName: (followerTarget ? deps.getDisplayTitle?.(followerTarget) : undefined) ??
          deps.getFollowerThreadName(),
        ...(leaderProtocol ? { leaderProtocol } : {}),
      };
    },
    getTopicTargets: () => listTelegramThreadStatusTargets(deps.listRecords()).map((record) => ({
      ...record, threadName: deps.getDisplayTitle?.(record.target) ?? record.threadName,
    })),
    getThreadReservations: () =>
      listTelegramThreadStatusReservations(deps.listReservations()),
    getTopicSyncObservations: () =>
      listTelegramThreadStatusObservations(deps.listSyncObservations()),
    getInstanceSlot() {
      if (deps.getThreadMode() === "disabled") return undefined;
      return deps.getCurrentIdentity().slot;
    },
    getInstanceThreadName() {
      if (deps.getThreadMode() === "disabled") return undefined;
      return deps.getCurrentIdentity().threadName;
    },
  };
}

export interface TelegramCurrentThreadAssemblyDeps {
  instanceId: string;
  listRecords: TelegramCurrentInstanceThreadRuntimeDeps["listRecords"];
  listWorkspaceBindings?: () => readonly TelegramWorkspaceThreadBinding[];
  getFollowerDisplayTitle?: () => string | undefined;
  getActiveTurnTarget(): TelegramTarget | undefined;
  getFollowerTarget(): TelegramTarget | undefined;
  isFollowerRegistered(): boolean;
  getFollowerSlot(): string | undefined;
  getFollowerThreadName(): string | undefined;
  getLeaderIdentity(): TelegramInstanceThreadIdentityCandidate | undefined;
  getLeaderTarget(): TelegramTarget | undefined;
  getLeaderProtocol?: TelegramThreadStatusProjectionRuntimeDeps["getLeaderProtocol"];
  status: Pick<
    TelegramThreadStatusProjectionRuntimeDeps,
    | "getThreadMode"
    | "isBusPollingStarted"
    | "listFollowers"
    | "listReservations"
    | "listSyncObservations"
    | "getLeaderSocketPath"
    | "getFollowerSocketPath"
    | "getTransportKind"
  >;
}

export interface TelegramCurrentThreadAssembly {
  getDisplayTitle: (target: TelegramTarget) => string | undefined;
  current: TelegramCurrentInstanceThreadRuntime;
  status: TelegramThreadStatusProjectionRuntime;
}

/** Own current-thread preference and its matching status projection. */
export function createTelegramCurrentThreadAssembly(
  deps: TelegramCurrentThreadAssemblyDeps,
): TelegramCurrentThreadAssembly {
  const getFollower = () => {
    const target = deps.getFollowerTarget();
    if (!target) return undefined;
    return {
      registered: deps.isFollowerRegistered(),
      target,
      slot: deps.getFollowerSlot(),
      threadName: deps.getFollowerThreadName(),
    };
  };
  const namedCurrent = createTelegramCurrentInstanceThreadRuntime({
    instanceId: deps.instanceId,
    listRecords: deps.listRecords,
    getPreferredTarget: () =>
      deps.getActiveTurnTarget() ??
      deps.getFollowerTarget() ??
      deps.getLeaderTarget(),
    getFollower,
    getLeader: deps.getLeaderIdentity,
  });
  const getDisplayTitle = (target: TelegramTarget): string | undefined => {
    const followerTarget = deps.getFollowerTarget();
    if (followerTarget && targetMatches(followerTarget, target) && deps.isFollowerRegistered()) {
      return deps.getFollowerDisplayTitle?.();
    }
    return deps.listWorkspaceBindings?.().find((binding) =>
      targetMatches(binding.target, target),
    )?.displayTitle;
  };
  const displayIdentity = (identity: TelegramInstanceThreadIdentityCandidate) => {
    const title = identity.target ? getDisplayTitle(identity.target) : undefined;
    return title ? { ...identity, threadName: title } : identity;
  };
  const current = {
    ...namedCurrent,
    getIdentity: (target?: TelegramTarget) => displayIdentity(namedCurrent.getIdentity(target)),
  };
  return {
    getDisplayTitle,
    current,
    status: createTelegramThreadStatusProjectionRuntime({
      ...deps.status,
      isFollowerRegistered: deps.isFollowerRegistered,
      listRecords: deps.listRecords,
      getFollowerTarget: deps.getFollowerTarget,
      getFollowerSlot: deps.getFollowerSlot,
      getFollowerThreadName: deps.getFollowerThreadName,
      getLeaderProtocol: deps.getLeaderProtocol,
      getDisplayTitle,
      getCurrentIdentity: () => displayIdentity(namedCurrent.getRestorationIdentity()),
    }),
  };
}

export interface TelegramThreadStatusFollowerView {
  instanceId: string;
  cwd?: string;
  lastHeartbeatMs: number;
  target?: TelegramTarget;
  protocol?: {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
}

function getTelegramThreadStatusName(
  record: TelegramTopicTargetRecord | undefined,
): string | undefined {
  if (!record) return undefined;
  if (
    record.threadName &&
    isTelegramTopicThreadNameValidForSlot(record.threadName, record.slot)
  )
    return record.threadName;
  return chooseTelegramThreadName({ slot: record.slot });
}

export function listTelegramThreadStatusFollowers(options: {
  followers: readonly TelegramThreadStatusFollowerView[];
  records: readonly TelegramTopicTargetRecord[];
}): Array<{
  instanceId: string;
  cwd?: string;
  lastHeartbeatMs: number;
  target?: TelegramTarget;
  protocol?: {
    protocolVersion: number;
    runtimeBuild: string;
    capabilities: string[];
  };
  slot?: string;
  threadName?: string;
  status?: string;
}> {
  return options.followers.map((follower) => {
    const record = options.records.find((record) => {
      return (
        record.target.chatId === follower.target?.chatId &&
        record.target.threadId === follower.target?.threadId
      );
    });
    return {
      instanceId: follower.instanceId,
      cwd: follower.cwd,
      lastHeartbeatMs: follower.lastHeartbeatMs,
      target: follower.target,
      ...(follower.protocol ? { protocol: follower.protocol } : {}),
      slot: record?.slot,
      threadName: getTelegramThreadStatusName(record),
      status: record?.status,
    };
  });
}

export function listTelegramThreadStatusTargets(
  records: readonly TelegramTopicTargetRecord[],
): Array<{
  instanceId?: string;
  status: TelegramTopicTargetStatus;
  target: TelegramTarget & { threadId: number };
  slot?: string;
  threadName?: string;
  syncStatus?: TelegramTopicSyncStatus;
  lastSyncObservedAtMs?: number;
  lastSyncProbeAtMs?: number;
  lastSyncError?: string;
  lastReconcileAction?: string;
}> {
  return records.map((record) => {
    return {
      instanceId: record.instanceId,
      status: record.status,
      target: record.target,
      slot: record.slot,
      threadName: getTelegramThreadStatusName(record),
      syncStatus: record.syncStatus,
      lastSyncObservedAtMs: record.lastSyncObservedAtMs,
      lastSyncProbeAtMs: record.lastSyncProbeAtMs,
      lastSyncError: record.lastSyncError,
      lastReconcileAction: record.lastReconcileAction,
    };
  });
}

export function listTelegramThreadStatusReservations(
  reservations: readonly TelegramThreadReservation[],
): Array<{
  target: TelegramTarget & { threadId: number };
  slot: string;
  reason: string;
  instanceId?: string;
  expiresAtMs?: number;
  lastReconcileAction?: string;
}> {
  return reservations.map((reservation) => {
    return {
      target: reservation.target,
      slot: reservation.slot,
      reason: reservation.reason,
      instanceId: reservation.instanceId,
      expiresAtMs: reservation.expiresAtMs,
      lastReconcileAction: reservation.lastReconcileAction,
    };
  });
}

export function listTelegramThreadStatusObservations(
  observations: readonly TelegramTopicSyncObservation[],
): Array<{
  target: TelegramTarget & { threadId: number };
  syncStatus: TelegramTopicSyncStatus;
  observedAtMs: number;
  instanceId?: string;
  slot?: string;
  lastSyncError?: string;
  lastReconcileAction?: string;
}> {
  return observations.map((observation) => {
    return {
      target: observation.target,
      syncStatus: observation.syncStatus,
      observedAtMs: observation.observedAtMs,
      instanceId: observation.instanceId,
      slot: observation.slot,
      lastSyncError: observation.lastSyncError,
      lastReconcileAction: observation.lastReconcileAction,
    };
  });
}

export function getTelegramTargetFromApiBody(
  body: unknown,
): (TelegramTarget & { threadId: number }) | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const record = body as Record<string, unknown>;
  const chatId = asInteger(record.chat_id);
  const threadId = asInteger(record.message_thread_id);
  return chatId !== undefined && threadId !== undefined
    ? { chatId, threadId }
    : undefined;
}

export function isTelegramTopicTargetStaleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  if (status !== undefined && status !== 400) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("topic_id_invalid") ||
    message.includes("message thread not found") ||
    message.includes("thread not found") ||
    message.includes("topic not found") ||
    message.includes("topic deleted") ||
    message.includes("topic closed") ||
    message.includes("thread closed") ||
    message.includes("forum topic closed") ||
    message.includes("message thread closed")
  );
}

export function isTelegramTopicModeUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not a forum") ||
    message.includes("forum topic") ||
    message.includes("topics are disabled") ||
    message.includes("threaded mode") ||
    message.includes("method is available only for")
  );
}

export function getTelegramTopicTitleForThreadName(
  threadName: string,
  slot: string,
  template = "{threadName}",
): string {
  return getTelegramTopicName(
    {
      instanceId: "",
      profileKey: normalizeTelegramTopicTargetThreadName(threadName) || "Pi",
      threadName,
    },
    template,
    slot,
  );
}

export function createTelegramTopicTargetRenamer(
  deps: TelegramTopicTargetRenamerDeps,
): (
  request: TelegramTopicTargetRenameRequest,
) => Promise<TelegramTopicTargetRecord | undefined> {
  return async (request) => {
    const threadName = normalizeTelegramTopicTargetThreadName(
      request.threadName,
    );
    if (
      !threadName ||
      !!getTelegramManualThreadDisplayNameValidationError(threadName)
    )
      return undefined;
    const occupied = new Set(
      listOccupiedTelegramThreadIdentities({
        records: deps.store.list(),
        workspaceBindings: deps.store.listWorkspaceBindings(),
        pendingProvisions: deps.store.listPendingProvisions(),
        exceptTarget: request.target,
      }),
    );
    if (occupied.has(getTelegramTopicIdentityName(threadName))) return undefined;
    const name = getTelegramTopicTitleForThreadName(
      threadName,
      request.slot ?? "",
      deps.topicNameTemplate,
    );
    deps.assertAuthority?.();
    const updateDisplayTitle = deps.shouldRenameDisplayedTitle?.() ?? true;
    if (updateDisplayTitle) {
      await deps.callApi("editForumTopic", {
        chat_id: request.target.chatId,
        message_thread_id: request.target.threadId,
        name,
      });
    }
    deps.assertAuthority?.();
    if ((deps.shouldRenameDisplayedTitle?.() ?? true) !== updateDisplayTitle) {
      throw new Error("Telegram display mode changed during Workspace rename.");
    }
    return deps.store.renameByTarget(request.target, threadName, { updateDisplayTitle });
  };
}

export function createTelegramTopicTargetProvisioner(
  deps: TelegramTopicTargetProvisionerDeps,
): (
  request: TelegramTopicTargetProvisionRequest,
) => Promise<TelegramTopicTargetProvisionResult> {
  const getNowMs = deps.getNowMs ?? (() => 0);
  const getRandom = deps.getRandom;
  return async (request) => {
    const leaderEpoch = deps.getCurrentLeaderEpoch?.();
    const assertLeaderEpoch = (phase: string): void => {
      if (
        deps.getCurrentLeaderEpoch &&
        (leaderEpoch === undefined ||
          deps.getCurrentLeaderEpoch() !== leaderEpoch)
      ) {
        throw new Error(
          `Telegram topic provisioning lost leader ownership (${phase}).`,
        );
      }
    };
    assertLeaderEpoch("start");
    const isManualFollowerRequest = request.owner?.kind === "manual-follower";
    const identity = deps.store.getIdentityByProfileKey(request.profileKey);
    const nowMs = getNowMs();
    let pendingForRequest = deps.store
      .listPendingProvisions()
      .find((pending) =>
        pending.profileKey === request.profileKey ||
        pending.instanceId === request.instanceId,
      );
    if (pendingForRequest?.target) {
      const target = pendingForRequest.target;
      const observation = deps.store.listSyncObservations().find((entry) =>
        targetMatches(entry.target, target),
      );
      assertTelegramPendingTopicRecoveryAllowed(deps.store, target);
      if (observation?.syncStatus === "deleted") {
        assertLeaderEpoch("before-deleted-provision-settlement");
        deps.store.markStaleByTarget(target, "deleted");
        await deps.store.persist();
        assertLeaderEpoch("after-deleted-provision-settlement");
        pendingForRequest = undefined;
      }
    }
    const existing = deps.store.getByProfileKey(request.profileKey);
    if (existing && isCurrentThreadRecord(existing)) {
      const slot = existing.slot ?? deps.store.allocateSlot(request.profileKey);
      if (!slot) {
        throw new Error("Telegram Workspace slot reservation is unavailable.");
      }
      const occupied = listOccupiedTelegramThreadIdentities({
        records: deps.store.list(),
        workspaceBindings: deps.store.listWorkspaceBindings(),
        pendingProvisions: deps.store.listPendingProvisions(),
        exceptTarget: existing.target,
        exceptWorkspaceBindingKey: request.workspaceBindingKey,
      });
      const identityThreadName =
        identity?.threadName &&
        isTelegramTopicThreadNameValidForSlot(identity.threadName, slot) &&
        !occupied.includes(getTelegramTopicIdentityName(identity.threadName))
          ? identity.threadName
          : undefined;
      const bakedThreadName = chooseTelegramThreadName({
        slot: getNextTelegramThreadNamePaletteSlot(deps.store.list(), slot),
        entropy: nowMs,
        getRandom,
        occupied,
      });
      const record = deps.store.upsert({
        ...existing,
        status: "active",
        updatedAtMs: nowMs,
        threadName:
          existing.threadName ?? identityThreadName ?? bakedThreadName,
        instanceId: request.instanceId,
        slot,
        owner: request.owner ?? existing.owner,
        lastError: undefined,
      });
      const recoveredTitle = pendingForRequest?.target &&
        targetMatches(pendingForRequest.target, record.target)
        ? pendingForRequest.displayTitle : undefined;
      if (pendingForRequest?.target && targetMatches(pendingForRequest.target, record.target)) {
        if (!request.workspaceBindingKey) deps.store.removePendingProvision(pendingForRequest.id);
        await deps.store.persist();
        assertLeaderEpoch("after-recovered-current-binding");
      }
      return {
        target: record.target, reused: true, record,
        ...(recoveredTitle ? { displayTitle: recoveredTitle } : {}),
      };
    }
    if (pendingForRequest?.target) {
      if (!pendingForRequest.slot) {
        throw new Error("Telegram Workspace slot reservation is unavailable.");
      }
      const record = deps.store.upsert({
        profileKey: request.profileKey,
        owner: request.owner,
        target: pendingForRequest.target,
        status: "active",
        createdAtMs: pendingForRequest.startedAtMs,
        updatedAtMs: nowMs,
        threadName: pendingForRequest.threadName,
        instanceId: request.instanceId,
        slot: pendingForRequest.slot,
      });
      if (!request.workspaceBindingKey) deps.store.removePendingProvision(pendingForRequest.id);
      await deps.store.persist();
      assertLeaderEpoch("after-recovered-binding");
      return {
        target: record.target,
        reused: true,
        record,
        ...(pendingForRequest.displayTitle
          ? { displayTitle: pendingForRequest.displayTitle }
          : {}),
      };
    }
    if (pendingForRequest) {
      throw new Error(
        `Telegram topic provisioning remains ${pendingForRequest.status ?? "in-flight"} for this instance.`,
      );
    }
    const activeForInstance = deps.store.getActiveByInstanceId(
      request.instanceId,
    );
    if (activeForInstance) {
      if (!activeForInstance.slot) {
        throw new Error("Telegram Workspace slot reservation is unavailable.");
      }
      return {
        target: activeForInstance.target,
        reused: true,
        record: activeForInstance,
      };
    }
    // No profileKey match — try to claim an existing inactive thread before creating another Telegram tab.
    if (deps.claimPendingTargets !== false) {
      const claimed = deps.store.claimReusableTarget(
        request.instanceId,
        identity?.threadName,
      );
      if (claimed) {
        return { target: claimed.target, reused: true, record: claimed };
      }
    }
    const occupied = listOccupiedTelegramThreadIdentities({
      records: deps.store.list(),
      workspaceBindings: deps.store.listWorkspaceBindings(),
      pendingProvisions: deps.store.listPendingProvisions(),
      exceptWorkspaceBindingKey: request.workspaceBindingKey,
    });
    const requestedThreadName =
      request.threadName &&
      isTelegramTopicThreadNameValidForSlot(request.threadName, undefined) &&
      !occupied.includes(getTelegramTopicIdentityName(request.threadName))
        ? normalizeTelegramTopicTargetThreadName(request.threadName)
        : undefined;
    const candidateThreadName = requestedThreadName ?? identity?.threadName;
    const preferredNameSlot =
      getTelegramThreadNameLeadingSlot(candidateThreadName) ??
      getNextTelegramThreadNamePaletteSlot(deps.store.list(), undefined) ??
      request.preferredSlot;
    const slot =
      existing?.slot ??
      deps.store.allocateSlot(
        request.profileKey,
        isManualFollowerRequest
          ? request.preferredSlot
          : (request.preferredSlot ??
            (candidateThreadName ? undefined : identity?.slot) ??
            preferredNameSlot),
        request.workspaceBindingKey,
      );
    if (!slot) {
      throw new Error("Telegram Workspace slot reservation is unavailable.");
    }
    const uniqueCandidate =
      candidateThreadName &&
      isTelegramTopicThreadNameValidForSlot(candidateThreadName, slot) &&
      !occupied.includes(getTelegramTopicIdentityName(candidateThreadName))
        ? candidateThreadName
        : undefined;
    const requestThreadName =
      uniqueCandidate ??
      chooseTelegramThreadName({ slot, entropy: nowMs, getRandom, occupied });
    let displayTitle: string | undefined;
    if (
      deps.resolveInitialWorkspaceDisplayTitle &&
      request.workspaceBindingKey &&
      request.workspaceCwd
    ) {
      const projectedTitle = deps.resolveInitialWorkspaceDisplayTitle({
        bindingKey: request.workspaceBindingKey,
        cwd: request.workspaceCwd,
        slot,
        threadName: requestThreadName,
      });
      if (!projectedTitle?.trim()) {
        throw new Error("Telegram Thread display identity is missing or ambiguous.");
      }
      displayTitle = getTelegramTopicName(
        { ...request, threadName: projectedTitle },
        "{threadName}",
        slot,
      );
    }
    const pendingId = `provision:${request.instanceId}:${slot}:${nowMs}`;
    const pendingOwner =
      request.owner?.kind === "leader" ? "leader" : "manual-follower";
    assertLeaderEpoch("before-pending-intent");
    const pendingBase: TelegramThreadPendingProvision = {
      id: pendingId,
      owner: pendingOwner,
      instanceId: request.instanceId,
      profileKey: request.profileKey,
      threadName: requestThreadName,
      ...(displayTitle ? { displayTitle } : {}),
      slot,
      startedAtMs: nowMs,
      ...(leaderEpoch !== undefined ? { leaderEpoch } : {}),
    };
    deps.store.upsertPendingProvision(pendingBase);
    await deps.store.persist();
    assertLeaderEpoch("after-pending-intent");
    let threadId: number | undefined;
    try {
      assertLeaderEpoch("before-createForumTopic");
      const topic = await deps.callApi<TelegramTopicResult>(
        "createForumTopic",
        {
          chat_id: deps.topicChatId,
          name: displayTitle ?? getTelegramTopicName(
            {
              ...request,
              ...(requestThreadName ? { threadName: requestThreadName } : {}),
            },
            deps.topicNameTemplate ??
              (requestThreadName ? "{threadName}" : "{slot}"),
            slot,
          ),
        },
        { maxAttempts: 1 },
      );
      threadId = topic.message_thread_id;
      if (typeof threadId !== "number" || !Number.isInteger(threadId)) {
        throw new TelegramApiCommitUnknownError(
          "createForumTopic",
          new Error("Telegram createForumTopic returned no message_thread_id."),
        );
      }
      assertLeaderEpoch("after-createForumTopic");
      const target = { chatId: deps.topicChatId, threadId };
      deps.store.upsertPendingProvision({ ...pendingBase, target });
      await deps.store.persist();
      assertLeaderEpoch("after-pending-target");
      deps.store.upsert({
        profileKey: request.profileKey,
        owner: request.owner,
        target,
        status: "starting",
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
        threadName: requestThreadName,
        instanceId: request.instanceId,
        slot,
      });
      await deps.store.persist();
      assertLeaderEpoch("after-starting-binding");
      const record = deps.store.upsert({
        profileKey: request.profileKey,
        owner: request.owner,
        target,
        status: "active",
        createdAtMs: existing?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
        threadName: requestThreadName,
        instanceId: request.instanceId,
        slot,
      });
      // Workspace commit consumes the exact title evidence in the same publication.
      if (!request.workspaceBindingKey) deps.store.removePendingProvision(pendingId);
      await deps.store.persist();
      assertLeaderEpoch("after-active-binding");
      return {
        target: record.target,
        reused: false,
        record,
        ...(displayTitle ? { displayTitle } : {}),
      };
    } catch (error) {
      if (
        threadId !== undefined &&
        deps.getCurrentLeaderEpoch &&
        deps.getCurrentLeaderEpoch() !== leaderEpoch
      ) {
        await deps.store.recordPendingProvisionTargetRecovery(pendingBase, {
          chatId: deps.topicChatId,
          threadId,
        });
        throw error;
      }
      assertLeaderEpoch("failure-cleanup");
      if (threadId === undefined) {
        if (isTelegramApiCommitUnknownError(error)) {
          deps.store.upsertPendingProvision({
            ...pendingBase,
            status: "ambiguous",
          });
        } else {
          deps.store.removePendingProvision(pendingId);
        }
        await deps.store.persist();
      } else {
        try {
          await deps.store.persist();
        } catch {
          // Keep the original post-create failure visible to the caller.
        }
      }
      throw error;
    }
  };
}
