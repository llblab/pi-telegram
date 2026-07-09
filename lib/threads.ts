/**
 * Telegram thread binding helpers
 * Zones: multi-instance bus, Telegram UI threads, volatile extension state
 * Owns current live instance-binding to Telegram UI thread mappings backed by Bot API ForumTopic/message_thread_id transport
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TelegramApiCallOptions } from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
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

export type TelegramTopicTargetStatus =
  "active" | "offline" | "stale" | "pending" | "starting" | "failed";

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
  slot?: string;
  target?: TelegramTarget & { threadId: number };
  startedAtMs: number;
  expiresAtMs?: number;
  leaderEpoch?: number | string;
}

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
  reservations?: TelegramThreadReservation[];
  pendingProvisions?: TelegramThreadPendingProvision[];
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
      if (provision.expiresAtMs !== undefined && provision.expiresAtMs <= nowMs)
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
  persist: () => Promise<void>;
  list: () => TelegramTopicTargetRecord[];
  listReservations: () => TelegramThreadReservation[];
  listPendingProvisions: () => TelegramThreadPendingProvision[];
  listSyncObservations: () => TelegramTopicSyncObservation[];
  reserveThread: (reservation: TelegramThreadReservation) => void;
  upsertPendingProvision: (provision: TelegramThreadPendingProvision) => void;
  removePendingProvision: (id: string) => boolean;
  removeReservationByTarget: (target: TelegramTarget) => boolean;
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
  ) => TelegramTopicTargetRecord | undefined;
  allocateSlot: (
    profileKey: string,
    preferredSlot?: string,
  ) => string | undefined;
  /** Claim the first reusable inactive thread for an instance, linking it to instanceId. */
  claimReusableTarget: (
    instanceId: string,
    threadName?: string,
  ) => TelegramTopicTargetRecord | undefined;
}

export function reconcileTelegramFreshAllocationCursor(
  store: Pick<
    TelegramTopicTargetStore,
    "getBotState" | "list" | "setBotState"
  >,
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

export interface TelegramTopicTargetStoreOptions {
  path: string | (() => string);
  getNowMs?: () => number;
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
    | "upsertPendingProvision"
    | "removePendingProvision"
    | "persist"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  topicNameTemplate?: string;
  getNowMs?: () => number;
  getRandom?: () => number;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  claimPendingTargets?: boolean;
}

export interface TelegramTopicTargetRenamerDeps {
  store: Pick<TelegramTopicTargetStore, "renameByTarget">;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  topicNameTemplate?: string;
}

export interface TelegramTopicTargetProvisionRequest {
  instanceId: string;
  owner?: TelegramThreadOwner;
  /** Legacy string key derived from `owner`; always present in memory. */
  profileKey: string;
  threadName?: string;
  preferredSlot?: string;
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
    };
  }
  if (
    record.kind === "manual-follower" &&
    typeof record.instanceId === "string"
  ) {
    return { kind: "manual-follower", instanceId: record.instanceId };
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
        !!record && isCurrentThreadRecord(record),
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
    syncObservations: Array.isArray(file.syncObservations)
      ? file.syncObservations.flatMap((observation) => {
          const normalized = normalizeSyncObservation(observation);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

function targetMatches(left: TelegramTarget, right: TelegramTarget): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

function getInstanceProcessKey(
  instanceId: string | undefined,
): string | undefined {
  if (!instanceId) return undefined;
  const [pid] = instanceId.split(":", 1);
  return pid && /^\d+$/.test(pid) ? pid : undefined;
}

function isSameProcessInstance(
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
  if (provision.expiresAtMs === undefined || provision.expiresAtMs > nowMs) {
    return true;
  }
  return !!provision.target;
}

export function createTelegramTopicTargetStore(
  options: TelegramTopicTargetStoreOptions,
): TelegramTopicTargetStore {
  const getNowMs = options.getNowMs ?? Date.now;
  let botState: TelegramBotStateSnapshot = { threadMode: "unknown" };
  let records = new Map<string, TelegramTopicTargetRecord>();
  let identities = new Map<string, TelegramThreadIdentityRecord>();
  let reservations: TelegramThreadReservation[] = [];
  let pendingProvisions: TelegramThreadPendingProvision[] = [];
  let syncObservations: TelegramTopicSyncObservation[] = [];
  let loaded = false;
  let loadedPath: string | undefined;
  let dirty = false;
  let statusSnapshot: {
    runtime?: Record<string, unknown>;
    liveRoster?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  } = {};

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

  const getPath = () =>
    typeof options.path === "function" ? options.path() : options.path;
  const resetForPath = (path: string) => {
    if (loadedPath === path) return;
    botState = { threadMode: "unknown" };
    records = new Map();
    identities = new Map();
    reservations = [];
    pendingProvisions = [];
    syncObservations = [];
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
      reservations = [];
      pendingProvisions = [];
      syncObservations = [];
      loaded = true;
      return;
    }
    const content = await readFile(path, "utf8");
    const file = parseTopicTargetFile(JSON.parse(content));
    botState = file.bot;
    records = new Map(
      file.threads.map((record) => [
        getRecordOwnerKey(record),
        cloneRecord(record),
      ]),
    );
    identities = new Map(
      (file.identities ?? []).map((identity) => [
        identity.profileKey,
        cloneIdentityRecord(identity),
      ]),
    );
    for (const record of records.values()) rememberIdentity(record);
    const nowMs = getNowMs();
    reservations = (file.reservations ?? [])
      .filter(
        (reservation) =>
          reservation.expiresAtMs === undefined ||
          reservation.expiresAtMs > nowMs,
      )
      .map((reservation) => ({ ...reservation }));
    pendingProvisions = (file.pendingProvisions ?? [])
      .filter((provision) => isPendingProvisionLiveOrTargeted(provision, nowMs))
      .map((provision) => ({
        ...provision,
        ...(provision.target ? { target: { ...provision.target } } : {}),
      }));
    syncObservations = (file.syncObservations ?? []).map((observation) => ({
      ...observation,
      target: { ...observation.target },
    }));
    loaded = true;
  };

  return {
    async load() {
      if (dirty) return;
      await loadFromDisk();
    },
    async persist() {
      const path = getPath();
      if (loadedPath !== path && !dirty) resetForPath(path);
      if (!loaded && !dirty) await loadFromDisk();
      await mkdir(dirname(path), { recursive: true });
      const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
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
        .filter(isCurrentThreadRecord)
        .map(cloneRecord);
      records = new Map(
        currentRecords.map((record) => [
          getRecordOwnerKey(record),
          cloneRecord(record),
        ]),
      );
      const file = {
        version: 1,
        source: "snapshot",
        writtenAtMs: nowMs,
        bot: botState,
        ...statusSnapshot,
        identities: Array.from(identities.values()).map(cloneIdentityRecord),
        reservations: reservations.map((reservation) => ({ ...reservation })),
        pendingProvisions: pendingProvisions.map((provision) => ({
          ...provision,
          ...(provision.target ? { target: { ...provision.target } } : {}),
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
      await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(tempPath, 0o600);
      await rename(tempPath, path);
      await chmod(path, 0o600);
      loaded = true;
      dirty = false;
    },
    list() {
      return Array.from(records.values()).map(cloneRecord);
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
      loaded = true;
      dirty = true;
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
      loaded = true;
      dirty = true;
    },
    removePendingProvision(id) {
      const before = pendingProvisions.length;
      pendingProvisions = pendingProvisions.filter(
        (provision) => provision.id !== id,
      );
      const changed = pendingProvisions.length !== before;
      if (changed) {
        loaded = true;
        dirty = true;
      }
      return changed;
    },
    removeReservationByTarget(target) {
      const before = reservations.length;
      reservations = reservations.filter(
        (reservation) => !targetMatches(reservation.target, target),
      );
      const changed = reservations.length !== before;
      if (changed) {
        loaded = true;
        dirty = true;
      }
      return changed;
    },
    getBotState() {
      return Object.fromEntries(
        Object.entries(botState).filter(([, value]) => value !== undefined),
      ) as TelegramBotStateSnapshot;
    },
    setBotState(state) {
      botState = { ...botState, ...state };
      loaded = true;
      dirty = true;
    },
    setStatusSnapshot(snapshot) {
      if (!loadedPath) loadedPath = getPath();
      statusSnapshot = { ...snapshot };
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
      loaded = true;
      dirty = true;
      return true;
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
      if (!isCurrentThreadRecord(next)) {
        rememberIdentity(next);
        records.delete(nextOwnerKey);
        loaded = true;
        dirty = true;
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
      loaded = true;
      dirty = true;
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
      if (count > 0) {
        loaded = true;
        dirty = true;
      }
      return count;
    },
    markStaleByTarget(target, syncStatus = "unknown", lastSyncError) {
      for (const record of Array.from(records.values())) {
        if (!targetMatches(record.target, target)) continue;
        const nowMs = getNowMs();
        syncObservations = syncObservations.filter(
          (observation) => !targetMatches(observation.target, record.target),
        );
        syncObservations.push({
          target: record.target,
          syncStatus,
          observedAtMs: nowMs,
          ...(record.instanceId ? { instanceId: record.instanceId } : {}),
          ...(record.slot ? { slot: record.slot } : {}),
          ...(lastSyncError ? { lastSyncError } : {}),
          lastReconcileAction: "mark-stale",
        });
        rememberIdentity(record);
        records.delete(getRecordOwnerKey(record));
        loaded = true;
        dirty = true;
        return true;
      }
      return false;
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
        loaded = true;
        dirty = true;
        return true;
      }
      return false;
    },
    renameByTarget(target, threadName) {
      const nowMs = getNowMs();
      const normalizedThreadName =
        normalizeTelegramTopicTargetThreadName(threadName);
      if (!normalizedThreadName) return undefined;
      for (const record of records.values()) {
        if (!targetMatches(record.target, target)) continue;
        record.threadName = normalizedThreadName;
        record.updatedAtMs = nowMs;
        rememberIdentity(record);
        loaded = true;
        dirty = true;
        return cloneRecord(record);
      }
      return undefined;
    },
    claimReusableTarget(instanceId, threadName) {
      const nowMs = getNowMs();
      const candidates = Array.from(records.values())
        .filter((record) => {
          if (record.instanceId) return false;
          if (record.slot === "A") return false;
          if (record.status !== "pending") return false;
          if (!record.slot) return true;
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
      loaded = true;
      dirty = true;
      return cloneRecord(record);
    },
    allocateSlot(profileKey, preferredSlot) {
      const ownerKey = getTelegramThreadOwnerKey(
        getTelegramThreadOwnerFromProfileKey(profileKey),
      );
      const existing = records.get(ownerKey) ?? records.get(profileKey);
      if (existing?.slot && isCurrentThreadRecord(existing)) {
        return existing.slot;
      }
      const nowMs = getNowMs();
      if (
        preferredSlot &&
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
      return getNextMonotonicSlot(
        records,
        reservations,
        pendingProvisions,
        nowMs,
        botState.lastSlot,
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
    if (provision.expiresAtMs !== undefined && provision.expiresAtMs <= nowMs)
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

export function chooseTelegramThreadName(input: {
  slot: string | undefined;
  entropy?: number | string;
  getRandom?: () => number;
}): string | undefined {
  if (!input.slot || !/^[A-Z]$/.test(input.slot)) return undefined;
  const names = TELEGRAM_THREAD_NAME_PALETTE[input.slot];
  if (!names || names.length === 0) return undefined;
  const index = input.getRandom
    ? Math.max(
        0,
        Math.min(
          names.length - 1,
          Math.floor(input.getRandom() * names.length),
        ),
      )
    : getTelegramThreadNameEntropyIndex(input.entropy, names.length);
  return names[index];
}

function getTelegramThreadNameLeadingSlot(
  threadName: string | undefined,
): string | undefined {
  if (!threadName) return undefined;
  const first = getTelegramTopicIdentityName(threadName)[0];
  return first && /^[A-Z]$/.test(first) ? first : undefined;
}

function isTelegramSlotOccupiedByOtherCurrentRecord(
  records: readonly TelegramTopicTargetRecord[],
  slot: string,
  currentRecord: TelegramTopicTargetRecord,
): boolean {
  return records.some(
    (record) =>
      !targetMatches(record.target, currentRecord.target) &&
      isCurrentThreadRecord(record) &&
      record.slot === slot,
  );
}

function normalizeCurrentThreadNameSlots(
  store: Pick<TelegramTopicTargetStore, "list" | "upsert">,
): void {
  for (const record of store.list()) {
    if (!isCurrentThreadRecord(record)) continue;
    const slot = getTelegramThreadNameLeadingSlot(record.threadName);
    if (!slot || record.slot === slot) continue;
    if (isTelegramSlotOccupiedByOtherCurrentRecord(store.list(), slot, record))
      continue;
    store.upsert({ ...record, slot });
  }
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
  if (/^[A-Z]$/.test(identity)) {
    reasons.push("it is only a bare slot letter");
  }
  if (reasons.length === 0) return undefined;
  return `Invalid Telegram instance name: ${reasons.join("; ")}. Use exactly one capitalized Latin word with no spaces, punctuation, emoji, non-Latin letters, or digits; it must not be a generic role label or only a bare slot letter.`;
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
    ...((existing?.slot ?? deps.slot)
      ? { slot: existing?.slot ?? deps.slot }
      : {}),
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
  return record;
}

export interface TelegramOwnTopicProvisionDeps {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  cwd?: string;
  telegramProfile?: string;
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
    callApi: deps.callApi,
    markStaleByTarget: (
      target: TelegramTarget & { threadId: number },
      syncStatus?: "closed" | "deleted",
      lastSyncError?: string,
    ) => deps.store.markStaleByTarget(target, syncStatus, lastSyncError),
    removeReservationByTarget: (
      target: TelegramTarget & { threadId: number },
    ) => deps.store.removeReservationByTarget(target),
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
  const reservationProbeResults: ThreadReconciler.ThreadReservationProbeResult[] =
    [];
  deps.recordEvent("bus", "Bus leader reservation probes skipped", {
    phase: "leader-topic-reservation-probe-skipped",
    reservations: reservationsBeforeCleanup.length,
  });
  const reservationProbePlan = ThreadReconciler.planThreadReconciliation({
    nowMs: Date.now(),
    currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
    previousState: deps.getThreadReconciliationMachineState?.(),
    records: deps.store.list(),
    reservations: deps.store.listReservations(),
    pendingProvisions: deps.store.listPendingProvisions(),
    reservationProbeResults,
  });
  deps.recordThreadReconciliationPlan?.(reservationProbePlan);
  const reservationProbeApplyStartedAtMs = Date.now();
  await ThreadReconciler.applyThreadReconciliationPlan(
    reservationProbePlan,
    reservationCleanupPorts,
  );
  deps.recordEvent(
    "bus",
    "Bus leader reservation probe reconciliation applied",
    {
      phase: "leader-topic-reservation-probe-apply-duration",
      durationMs: Date.now() - reservationProbeApplyStartedAtMs,
      actions: reservationProbePlan.actions.length,
    },
  );
  const nowMs = Date.now();
  const currentLeaderOwner: TelegramThreadOwner = {
    kind: "leader",
    cwd: deps.cwd,
    instanceId: deps.instanceId,
    ...(deps.telegramProfile ? { telegramProfile: deps.telegramProfile } : {}),
  };
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
    if (isSameProcessInstance(record.instanceId, deps.instanceId)) {
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
    await ThreadReconciler.applyThreadReconciliationPlan(
      { actions: [action] },
      {
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
    deps.store.markStaleByTarget(record.target);
    deps.store.reserveThread({
      target: record.target,
      slot: record.slot ?? "A",
      reason: "previous-process-cleaned-without-visible-probe",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + TELEGRAM_THREAD_RESERVATION_TTL_MS,
      instanceId: record.instanceId,
      lastReconcileAction: "leader-topic-previous-instance-cleaned-no-probe",
    });
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
    claimPendingTargets: false,
  });
  let result = await provision({
    instanceId: deps.instanceId,
    owner: currentLeaderOwner,
    profileKey,
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
  return {
    target: result.target,
    slot: result.record.slot ?? "A",
    ...(result.record.threadName
      ? { threadName: result.record.threadName }
      : {}),
    reused: result.reused,
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

export interface TelegramThreadStatusFollowerView {
  instanceId: string;
  cwd?: string;
  lastHeartbeatMs: number;
  target?: TelegramTarget;
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
      !isTelegramTopicThreadNameValidForSlot(threadName, request.slot)
    )
      return undefined;
    const name = getTelegramTopicTitleForThreadName(
      threadName,
      request.slot ?? "",
      deps.topicNameTemplate,
    );
    await deps.callApi("editForumTopic", {
      chat_id: request.target.chatId,
      message_thread_id: request.target.threadId,
      name,
    });
    return deps.store.renameByTarget(request.target, threadName);
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
    normalizeCurrentThreadNameSlots(deps.store);
    let existing = deps.store.getByProfileKey(request.profileKey);
    const isManualFollowerRequest = request.owner?.kind === "manual-follower";
    if (isManualFollowerRequest && existing && isCurrentThreadRecord(existing)) {
      deps.store.markStaleByTarget(
        existing.target,
        "unknown",
        "Manual follower runtime was replaced before reconnect.",
      );
      deps.store.forgetIdentityByProfileKey(request.profileKey);
      existing = undefined;
    }
    const identity = isManualFollowerRequest && !existing
      ? undefined
      : deps.store.getIdentityByProfileKey(request.profileKey);
    const nowMs = getNowMs();
    if (existing && isCurrentThreadRecord(existing)) {
      const slot = existing.slot ?? deps.store.allocateSlot(request.profileKey);
      const identityThreadName =
        identity?.threadName &&
        isTelegramTopicThreadNameValidForSlot(identity.threadName, slot)
          ? identity.threadName
          : undefined;
      const bakedThreadName = chooseTelegramThreadName({
        slot: getNextTelegramThreadNamePaletteSlot(deps.store.list(), slot),
        entropy: nowMs,
        getRandom,
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
      return { target: record.target, reused: true, record };
    }
    const activeForInstance = deps.store.getActiveByInstanceId(
      request.instanceId,
    );
    if (activeForInstance) {
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
    const candidateThreadName = identity?.threadName;
    const preferredNameSlot =
      getTelegramThreadNameLeadingSlot(candidateThreadName) ??
      getNextTelegramThreadNamePaletteSlot(deps.store.list(), undefined) ??
      request.preferredSlot;
    const slot =
      existing?.slot ??
      (candidateThreadName ? undefined : identity?.slot) ??
      deps.store.allocateSlot(
        request.profileKey,
        isManualFollowerRequest
          ? request.preferredSlot
          : request.preferredSlot ?? preferredNameSlot,
      );
    const requestThreadName =
      candidateThreadName &&
      isTelegramTopicThreadNameValidForSlot(candidateThreadName, slot)
        ? candidateThreadName
        : chooseTelegramThreadName({ slot, entropy: nowMs, getRandom });
    const pendingId = `provision:${request.instanceId}:${slot}:${nowMs}`;
    const pendingOwner =
      request.owner?.kind === "leader" ? "leader" : "manual-follower";
    const leaderEpoch = deps.getCurrentLeaderEpoch?.();
    const pendingBase: TelegramThreadPendingProvision = {
      id: pendingId,
      owner: pendingOwner,
      instanceId: request.instanceId,
      slot,
      startedAtMs: nowMs,
      expiresAtMs: nowMs + TELEGRAM_THREAD_RESERVATION_TTL_MS,
      ...(leaderEpoch !== undefined ? { leaderEpoch } : {}),
    };
    deps.store.upsertPendingProvision(pendingBase);
    await deps.store.persist();
    let threadId: number | undefined;
    try {
      const topic = await deps.callApi<TelegramTopicResult>(
        "createForumTopic",
        {
          chat_id: deps.topicChatId,
          name: getTelegramTopicName(
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
        throw new Error(
          "Telegram createForumTopic returned no message_thread_id.",
        );
      }
      const target = { chatId: deps.topicChatId, threadId };
      deps.store.upsertPendingProvision({ ...pendingBase, target });
      await deps.store.persist();
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
      deps.store.removePendingProvision(pendingId);
      await deps.store.persist();
      return { target: record.target, reused: false, record };
    } catch (error) {
      if (threadId === undefined) {
        deps.store.removePendingProvision(pendingId);
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
