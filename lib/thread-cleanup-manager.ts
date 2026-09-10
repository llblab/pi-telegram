/**
 * Proof-only candidate planning for inactive Telegram Workspace Thread cleanup
 * Zones: telegram threads, workspace lifecycle
 * Owns fail-closed cleanup eligibility projection without persistence or Bot API effects
 */

import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { renameTelegramPathWithRetry, withTelegramFileTransaction } from "./locks.ts";
import type { TelegramWorkspaceDeletionPermit,
  TelegramWorkspaceDestructiveFence,
  TelegramWorkspaceRetirementFence } from "./workspace-admission.ts";

export interface TelegramThreadCleanupBindingSnapshot {
  cwd: string;
  workspaceKey: string;
  instanceSlot: string;
  slot?: string;
  bindingKey: string;
  target: { chatId: number; threadId: number };
  inactiveSinceMs?: number;
  updatedAtMs: number;
}

export type TelegramThreadCleanupProtectionState = "clear" | "protected" | "unknown";

export interface TelegramThreadCleanupProtectionEvidence {
  bindingKey: string;
  target: { chatId: number; threadId: number };
  liveOwner: TelegramThreadCleanupProtectionState;
  acceptedWork: TelegramThreadCleanupProtectionState;
  deliveryAuthority: TelegramThreadCleanupProtectionState;
}

export interface TelegramThreadCleanupCandidate {
  profileName: string;
  bindingKey: string;
  cwd: string;
  workspaceKey: string;
  instanceSlot: string;
  slot: string;
  target: { chatId: number; threadId: number };
  inactiveSinceMs: number;
  bindingUpdatedAtMs: number;
}

function targetKey(target: { chatId: number; threadId: number }): string {
  return `${target.chatId}:${target.threadId}`;
}

function validTarget(target: { chatId: number; threadId: number }): boolean {
  return Number.isSafeInteger(target.chatId) && Number.isSafeInteger(target.threadId) &&
    target.threadId > 0;
}

/** Returns no candidates when any identity/evidence ambiguity exists. */
export function planTelegramInactiveThreadCleanup(input: {
  profileName: string;
  bindings: readonly TelegramThreadCleanupBindingSnapshot[];
  protection: readonly TelegramThreadCleanupProtectionEvidence[];
  reservedTargets?: readonly { chatId: number; threadId: number }[];
  provisioningTargets?: readonly { chatId: number; threadId: number }[];
  cleanupTargets?: readonly { chatId: number; threadId: number }[];
}): TelegramThreadCleanupCandidate[] {
  if (!input.profileName) return [];
  const bindingKeys = new Set<string>();
  const bindingTargets = new Set<string>();
  for (const binding of input.bindings) {
    const key = targetKey(binding.target);
    const slot = binding.slot;
    if (!binding.bindingKey || !binding.cwd || !binding.workspaceKey || !binding.instanceSlot ||
        typeof slot !== "string" || !slot ||
        !validTarget(binding.target) || bindingKeys.has(binding.bindingKey) || bindingTargets.has(key)) return [];
    bindingKeys.add(binding.bindingKey);
    bindingTargets.add(key);
  }
  const evidenceByBinding = new Map<string, TelegramThreadCleanupProtectionEvidence>();
  for (const evidence of input.protection) {
    if (!evidence.bindingKey || evidenceByBinding.has(evidence.bindingKey) || !validTarget(evidence.target)) return [];
    evidenceByBinding.set(evidence.bindingKey, evidence);
  }
  const competingTargets = [
    ...(input.reservedTargets ?? []),
    ...(input.provisioningTargets ?? []),
    ...(input.cleanupTargets ?? []),
  ];
  if (competingTargets.some(target => !validTarget(target))) return [];
  const competing = new Set(competingTargets.map(targetKey));
  const candidates: TelegramThreadCleanupCandidate[] = [];
  for (const binding of input.bindings) {
    const inactiveSinceMs = binding.inactiveSinceMs;
    const slot = binding.slot;
    if (typeof slot !== "string" || !slot || !Number.isSafeInteger(inactiveSinceMs) ||
        inactiveSinceMs === undefined || inactiveSinceMs < 0 ||
        !Number.isSafeInteger(binding.updatedAtMs) || binding.updatedAtMs < inactiveSinceMs) continue;
    const evidence = evidenceByBinding.get(binding.bindingKey);
    if (!evidence || targetKey(evidence.target) !== targetKey(binding.target) ||
        evidence.liveOwner !== "clear" || evidence.acceptedWork !== "clear" ||
        evidence.deliveryAuthority !== "clear" || competing.has(targetKey(binding.target))) continue;
    candidates.push({ profileName: input.profileName, bindingKey: binding.bindingKey,
      cwd: binding.cwd, workspaceKey: binding.workspaceKey, instanceSlot: binding.instanceSlot,
      slot, target: { ...binding.target }, inactiveSinceMs,
      bindingUpdatedAtMs: binding.updatedAtMs });
  }
  return candidates.sort((left, right) => left.bindingKey.localeCompare(right.bindingKey));
}

export function captureTelegramInactiveThreadCleanupEvidence<
  TBinding extends TelegramThreadCleanupBindingSnapshot,
>(input: {
  profileName: string;
  listBindings(): readonly TBinding[];
  getProtection(binding: TBinding): {
    liveOwner: TelegramThreadCleanupProtectionState;
    acceptedWork: TelegramThreadCleanupProtectionState;
    deliveryAuthority: TelegramThreadCleanupProtectionState;
  };
  listReservations(): readonly { target: { chatId: number; threadId: number } }[];
  listPendingProvisions(): readonly { target?: { chatId: number; threadId: number } }[];
  listPendingCleanups(): readonly { target: { chatId: number; threadId: number } }[];
}): Parameters<typeof planTelegramInactiveThreadCleanup>[0] {
  const sourceBindings = input.listBindings();
  const bindings = sourceBindings.map(binding => ({
    cwd: binding.cwd, workspaceKey: binding.workspaceKey, instanceSlot: binding.instanceSlot,
    ...(binding.slot === undefined ? {} : { slot: binding.slot }), bindingKey: binding.bindingKey, target: { ...binding.target },
    ...(binding.inactiveSinceMs === undefined ? {} : { inactiveSinceMs: binding.inactiveSinceMs }),
    updatedAtMs: binding.updatedAtMs,
  }));
  const protection = sourceBindings.map((source, index) => {
    const binding = bindings[index]!;
    try { return { bindingKey: binding.bindingKey, target: { ...binding.target },
      ...input.getProtection(source) }; }
    catch { return { bindingKey: binding.bindingKey, target: { ...binding.target },
      liveOwner: "unknown" as const, acceptedWork: "unknown" as const,
      deliveryAuthority: "unknown" as const }; }
  });
  return {
    profileName: input.profileName,
    bindings,
    protection,
    reservedTargets: input.listReservations().map(entry => ({ ...entry.target })),
    provisioningTargets: input.listPendingProvisions().flatMap(entry =>
      entry.target ? [{ ...entry.target }] : []),
    cleanupTargets: input.listPendingCleanups().map(entry => ({ ...entry.target })),
  };
}

export function createTelegramInactiveThreadCleanupReviewRuntime<
  TBinding extends TelegramThreadCleanupBindingSnapshot,
>(deps: {
  getProfileName(): string;
  listBindings(): readonly TBinding[];
  getProtection(binding: TBinding): {
    liveOwner: TelegramThreadCleanupProtectionState;
    acceptedWork: TelegramThreadCleanupProtectionState;
    deliveryAuthority: TelegramThreadCleanupProtectionState;
  };
  listReservations(): readonly { target: { chatId: number; threadId: number } }[];
  listPendingProvisions(): readonly { target?: { chatId: number; threadId: number } }[];
  listPendingCleanups(): readonly { target: { chatId: number; threadId: number } }[];
  getWorkStore(): TelegramThreadCleanupWorkStore;
  runWorkspaceOperation<T>(input: { operationId: string; operationKind: string;
    scopes: readonly [{ kind: "profile" }] }, operation: () => Promise<T>): Promise<T>;
}): { review(): Promise<{ count: number; operationId?: string }> } {
  return {
    review() {
      return deps.runWorkspaceOperation({ operationId: `thread-cleanup-review:${randomUUID()}`,
        operationKind: "thread-cleanup-review", scopes: [{ kind: "profile" }] }, async () => {
        const evidence = captureTelegramInactiveThreadCleanupEvidence({
          profileName: deps.getProfileName(), listBindings: deps.listBindings,
          getProtection: deps.getProtection, listReservations: deps.listReservations,
          listPendingProvisions: deps.listPendingProvisions,
          listPendingCleanups: deps.listPendingCleanups,
        });
        const candidates = planTelegramInactiveThreadCleanup(evidence);
        if (candidates.length === 0) return { count: 0 };
        const digest = createHash("sha256").update(JSON.stringify(candidates)).digest("hex").slice(0, 32);
        const operationId = `thread-cleanup:${digest}`;
        deps.getWorkStore().prepare(operationId, candidates);
        return { count: candidates.length, operationId };
      });
    },
  };
}

export type TelegramThreadCleanupWorkState = "prepared" | "outcome-unknown" | "deleted";
export type TelegramThreadCleanupWorkEntry = TelegramThreadCleanupCandidate & {
  state: TelegramThreadCleanupWorkState;
  updatedAtMs: number;
  issuedAtMs?: number;
  permitOperationId?: string;
  permitIntentId?: string;
  permitLeaderEpoch?: number | string;
  deletedAtMs?: number;
};
export interface TelegramThreadCleanupWorkSet {
  operationId: string;
  createdAtMs: number;
  entries: TelegramThreadCleanupWorkEntry[];
}
interface TelegramThreadCleanupWorkFile {
  version: 1;
  profileName: string;
  tokenSha256: string;
  workSets: TelegramThreadCleanupWorkSet[];
}
export type TelegramThreadCleanupDeletionPermit = TelegramWorkspaceDeletionPermit;
export type TelegramThreadCleanupFence = TelegramWorkspaceRetirementFence;

export interface TelegramThreadCleanupWorkStore {
  prepare(operationId: string, candidates: readonly TelegramThreadCleanupCandidate[]):
    { prepared: boolean; workSet: TelegramThreadCleanupWorkSet };
  recordDeletionIssued(input: { operationId: string; bindingKey: string; bindingUpdatedAtMs: number;
    permit: TelegramThreadCleanupDeletionPermit }):
    { recorded: boolean; entry: TelegramThreadCleanupWorkEntry };
  confirmDeleted(input: { operationId: string; bindingKey: string }):
    { confirmed: boolean; entry: TelegramThreadCleanupWorkEntry };
  list(): TelegramThreadCleanupWorkSet[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys); return Object.keys(value).every(key => allowed.has(key));
}
function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function validateWorkSet(value: unknown, profileName: string): TelegramThreadCleanupWorkSet {
  if (!isObject(value) || !onlyKeys(value, ["operationId", "createdAtMs", "entries"]) ||
      typeof value.operationId !== "string" || !value.operationId || !safeTime(value.createdAtMs) ||
      !Array.isArray(value.entries) || value.entries.length === 0) throw new Error("Telegram Thread cleanup work-set schema is invalid.");
  const createdAtMs = value.createdAtMs as number;
  const entries = value.entries.map(raw => {
    if (!isObject(raw) || !onlyKeys(raw, ["profileName", "bindingKey", "cwd", "workspaceKey",
      "instanceSlot", "slot", "target", "inactiveSinceMs", "bindingUpdatedAtMs", "state", "updatedAtMs",
      "issuedAtMs", "permitOperationId", "permitIntentId", "permitLeaderEpoch", "deletedAtMs"]) || raw.profileName !== profileName || typeof raw.bindingKey !== "string" ||
      !raw.bindingKey || typeof raw.cwd !== "string" || !raw.cwd || typeof raw.workspaceKey !== "string" ||
      !raw.workspaceKey || typeof raw.instanceSlot !== "string" || !raw.instanceSlot ||
      typeof raw.slot !== "string" || !raw.slot || !isObject(raw.target) ||
      !onlyKeys(raw.target, ["chatId", "threadId"]) || !validTarget(raw.target as unknown as { chatId: number; threadId: number }) ||
      !safeTime(raw.inactiveSinceMs) || !safeTime(raw.bindingUpdatedAtMs) ||
      (raw.bindingUpdatedAtMs as number) < (raw.inactiveSinceMs as number) || !safeTime(raw.updatedAtMs))
      throw new Error("Telegram Thread cleanup entry schema is invalid.");
    const base = { profileName, bindingKey: raw.bindingKey, cwd: raw.cwd, workspaceKey: raw.workspaceKey,
      instanceSlot: raw.instanceSlot, slot: raw.slot, target: { chatId: raw.target.chatId as number,
        threadId: raw.target.threadId as number }, inactiveSinceMs: raw.inactiveSinceMs as number,
      bindingUpdatedAtMs: raw.bindingUpdatedAtMs as number, updatedAtMs: raw.updatedAtMs as number };
    if (base.updatedAtMs < base.bindingUpdatedAtMs) throw new Error("Telegram Thread cleanup entry clock is invalid.");
    const noPermit = raw.permitOperationId === undefined && raw.permitIntentId === undefined &&
      raw.permitLeaderEpoch === undefined;
    if (raw.state === "prepared" && raw.issuedAtMs === undefined && raw.deletedAtMs === undefined && noPermit)
      return { ...base, state: "prepared" as const };
    const validPermit = typeof raw.permitOperationId === "string" && !!raw.permitOperationId &&
      typeof raw.permitIntentId === "string" && !!raw.permitIntentId &&
      (typeof raw.permitLeaderEpoch === "string" || Number.isSafeInteger(raw.permitLeaderEpoch));
    if (raw.state === "outcome-unknown" && safeTime(raw.issuedAtMs) && validPermit &&
        raw.issuedAtMs === base.updatedAtMs && raw.deletedAtMs === undefined)
      return { ...base, state: "outcome-unknown" as const, issuedAtMs: raw.issuedAtMs,
        permitOperationId: raw.permitOperationId as string, permitIntentId: raw.permitIntentId as string,
        permitLeaderEpoch: raw.permitLeaderEpoch as number | string };
    if (raw.state === "deleted" && safeTime(raw.issuedAtMs) && validPermit && safeTime(raw.deletedAtMs) &&
        raw.deletedAtMs === base.updatedAtMs && raw.deletedAtMs >= raw.issuedAtMs)
      return { ...base, state: "deleted" as const, issuedAtMs: raw.issuedAtMs,
        permitOperationId: raw.permitOperationId as string, permitIntentId: raw.permitIntentId as string,
        permitLeaderEpoch: raw.permitLeaderEpoch as number | string, deletedAtMs: raw.deletedAtMs };
    throw new Error("Telegram Thread cleanup entry state is invalid.");
  });
  if (entries.some(entry => entry.updatedAtMs < createdAtMs) ||
      new Set(entries.map(entry => entry.bindingKey)).size !== entries.length ||
      new Set(entries.map(entry => targetKey(entry.target))).size !== entries.length)
    throw new Error("Telegram Thread cleanup work-set identity is ambiguous.");
  return { operationId: value.operationId, createdAtMs, entries };
}

function sameCandidates(left: readonly TelegramThreadCleanupCandidate[], right: readonly TelegramThreadCleanupCandidate[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createTelegramThreadCleanupWorkStore(options: {
  path: string; profileName: string; tokenSha256: string; maxWorkSets?: number;
  maxBytes?: number; getNowMs?: () => number;
  onPublicationBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void;
}): TelegramThreadCleanupWorkStore {
  const maxWorkSets = options.maxWorkSets ?? 32;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const now = options.getNowMs ?? Date.now;
  if (!options.path || !options.profileName || !/^[a-f0-9]{64}$/u.test(options.tokenSha256) ||
      !Number.isSafeInteger(maxWorkSets) || maxWorkSets <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Telegram Thread cleanup store options are invalid.");
  const empty = (): TelegramThreadCleanupWorkFile => ({ version: 1, profileName: options.profileName,
    tokenSha256: options.tokenSha256, workSets: [] });
  const read = (): TelegramThreadCleanupWorkFile => {
    let before;
    try { before = lstatSync(options.path, { bigint: true }); }
    catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return empty();
      throw error;
    }
    const uid = process.getuid?.();
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || uid === undefined || !before.isFile() ||
        before.isSymbolicLink() || before.uid !== BigInt(uid) || before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n || before.size > BigInt(maxBytes))
      throw new Error("Telegram Thread cleanup store is not a bounded private regular file.");
    const fd = openSync(options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: unknown;
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
          opened.mtimeNs !== before.mtimeNs) throw new Error("Telegram Thread cleanup store changed during inspection.");
      value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    } finally { closeSync(fd); }
    if (!isObject(value) || !onlyKeys(value, ["version", "profileName", "tokenSha256", "workSets"]) ||
        value.version !== 1 || value.profileName !== options.profileName ||
        value.tokenSha256 !== options.tokenSha256 || !Array.isArray(value.workSets))
      throw new Error("Telegram Thread cleanup store identity or schema does not match.");
    const workSets = value.workSets.map(workSet => validateWorkSet(workSet, options.profileName));
    if (new Set(workSets.map(workSet => workSet.operationId)).size !== workSets.length)
      throw new Error("Telegram Thread cleanup operation identity is ambiguous.");
    return { version: 1, profileName: options.profileName, tokenSha256: options.tokenSha256, workSets };
  };
  const publish = (file: TelegramThreadCleanupWorkFile): void => {
    if (file.workSets.length > maxWorkSets) throw new Error("Telegram Thread cleanup work-set capacity reached.");
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > maxBytes) throw new Error("Telegram Thread cleanup byte capacity reached.");
    const temporaryPath = `${options.path}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporaryPath, serialized, { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      options.onPublicationBoundary?.("after-write-before-rename");
      if (!renameTelegramPathWithRetry(temporaryPath, options.path))
        throw new Error("Telegram Thread cleanup staging file disappeared.");
      chmodSync(options.path, 0o600);
      options.onPublicationBoundary?.("after-rename");
    } finally { try { unlinkSync(temporaryPath); } catch { /* rename consumed it */ } }
  };
  const mutate = <T>(operation: (file: TelegramThreadCleanupWorkFile) => T): T =>
    withTelegramFileTransaction(`${options.path}.transaction`, () => operation(read()));
  return {
    prepare(operationId, candidates) {
      if (!operationId || candidates.length === 0 || candidates.some(candidate => candidate.profileName !== options.profileName))
        throw new Error("Telegram Thread cleanup work-set is invalid.");
      return mutate(file => {
        const existing = file.workSets.find(workSet => workSet.operationId === operationId);
        if (existing) {
          const projected = existing.entries.map(({ state: _state, updatedAtMs: _updated,
            issuedAtMs: _issued, permitOperationId: _permitOperation,
            permitIntentId: _permitIntent, permitLeaderEpoch: _permitEpoch,
            deletedAtMs: _deleted, ...candidate }) => candidate);
          if (!sameCandidates(projected, candidates)) throw new Error("Telegram Thread cleanup operation conflicts.");
          return { prepared: false, workSet: structuredClone(existing) };
        }
        const atMs = now();
        if (!safeTime(atMs)) throw new Error("Telegram Thread cleanup clock is invalid.");
        const workSet = validateWorkSet({ operationId, createdAtMs: atMs,
          entries: candidates.map(candidate => ({ ...structuredClone(candidate), state: "prepared", updatedAtMs: atMs })) },
        options.profileName);
        publish({ ...file, workSets: [...file.workSets, workSet] });
        return { prepared: true, workSet: structuredClone(workSet) };
      });
    },
    recordDeletionIssued(input) {
      return mutate(file => {
        const workSet = file.workSets.find(candidate => candidate.operationId === input.operationId);
        const entry = workSet?.entries.find(candidate => candidate.bindingKey === input.bindingKey);
        const permit = input.permit;
        if (!workSet || !entry || entry.bindingUpdatedAtMs !== input.bindingUpdatedAtMs ||
            permit.destructiveKind !== "manual-thread-cleanup" || permit.profileKey !== entry.profileName || permit.bindingKey !== entry.bindingKey ||
            permit.slot !== entry.slot || targetKey(permit.target) !== targetKey(entry.target) ||
            !permit.operationId || !permit.retirementIntentId || !safeTime(permit.issuedAtMs))
          throw new Error("Telegram Thread cleanup entry or deletion permit is stale or mismatched.");
        if (entry.state !== "prepared") {
          const exact = entry.permitOperationId === permit.operationId &&
            entry.permitIntentId === permit.retirementIntentId &&
            entry.permitLeaderEpoch === permit.leaderEpoch;
          if (!exact) throw new Error("Telegram Thread cleanup deletion permit conflicts with retained work.");
          return { recorded: false, entry: structuredClone(entry) };
        }
        const atMs = now();
        if (!safeTime(atMs) || atMs < entry.updatedAtMs || atMs < permit.issuedAtMs)
          throw new Error("Telegram Thread cleanup clock is invalid.");
        entry.state = "outcome-unknown"; entry.issuedAtMs = atMs; entry.updatedAtMs = atMs;
        entry.permitOperationId = permit.operationId; entry.permitIntentId = permit.retirementIntentId;
        entry.permitLeaderEpoch = permit.leaderEpoch;
        publish(file); return { recorded: true, entry: structuredClone(entry) };
      });
    },
    confirmDeleted(input) {
      return mutate(file => {
        const entry = file.workSets.find(candidate => candidate.operationId === input.operationId)
          ?.entries.find(candidate => candidate.bindingKey === input.bindingKey);
        if (!entry) throw new Error("Telegram Thread cleanup entry is missing.");
        if (entry.state === "deleted") return { confirmed: false, entry: structuredClone(entry) };
        if (entry.state !== "outcome-unknown") throw new Error("Telegram Thread cleanup deletion confirmation is premature.");
        const atMs = now();
        if (!safeTime(atMs) || atMs < entry.updatedAtMs) throw new Error("Telegram Thread cleanup clock is invalid.");
        entry.state = "deleted"; entry.deletedAtMs = atMs; entry.updatedAtMs = atMs;
        publish(file); return { confirmed: true, entry: structuredClone(entry) };
      });
    },
    list() { return structuredClone(read().workSets); },
  };
}

export async function commitTelegramInactiveThreadCleanup(input: {
  store: TelegramThreadCleanupWorkStore;
  operationId: string;
  bindingKey: string;
  commitBinding(): Promise<boolean>;
}): Promise<boolean> {
  if (!await input.commitBinding()) return false;
  input.store.confirmDeleted({ operationId: input.operationId, bindingKey: input.bindingKey });
  return true;
}

export async function executeTelegramInactiveThreadCleanup(input: {
  store: TelegramThreadCleanupWorkStore;
  operationId: string;
  bindingKey: string;
  withWorkspaceDeletionBoundary<T>(operation: () => Promise<T>): Promise<T>;
  loadFreshEvidence(): Promise<Parameters<typeof planTelegramInactiveThreadCleanup>[0]>;
  acquireDeletionPermit(candidate: TelegramThreadCleanupCandidate): Promise<
    | { kind: "issued"; permit: TelegramThreadCleanupDeletionPermit }
    | { kind: "blocked" | "already-issued" }
  >;
  deleteWithPermit(permit: TelegramThreadCleanupDeletionPermit,
    candidate: TelegramThreadCleanupCandidate): Promise<void>;
}): Promise<{ status: "deleted" | "blocked" | "outcome-unknown";
  entry?: TelegramThreadCleanupWorkEntry }> {
  return input.withWorkspaceDeletionBoundary(async () => {
    const workSet = input.store.list().find(candidate => candidate.operationId === input.operationId);
    const retained = workSet?.entries.find(candidate => candidate.bindingKey === input.bindingKey);
    if (!retained) return { status: "blocked" };
    if (retained.state === "deleted") return { status: "deleted", entry: retained };
    if (retained.state === "outcome-unknown") return { status: "outcome-unknown", entry: retained };
    const planned = planTelegramInactiveThreadCleanup(await input.loadFreshEvidence());
    const fresh = planned.find(candidate => candidate.bindingKey === retained.bindingKey);
    const retainedCandidate = (({ state: _state, updatedAtMs: _updated, issuedAtMs: _issued,
      permitOperationId: _permitOperation, permitIntentId: _permitIntent,
      permitLeaderEpoch: _permitEpoch, deletedAtMs: _deleted, ...candidate }) => candidate)(retained);
    if (!fresh || !sameCandidates([fresh], [retainedCandidate])) return { status: "blocked" };
    const permitResult = await input.acquireDeletionPermit(fresh);
    if (permitResult.kind !== "issued") return { status: "blocked" };
    const recorded = input.store.recordDeletionIssued({ operationId: input.operationId,
      bindingKey: input.bindingKey, bindingUpdatedAtMs: retained.bindingUpdatedAtMs,
      permit: permitResult.permit });
    if (!recorded.recorded) return { status: "outcome-unknown", entry: recorded.entry };
    await input.deleteWithPermit(permitResult.permit, fresh);
    const confirmed = input.store.confirmDeleted({ operationId: input.operationId,
      bindingKey: input.bindingKey });
    return { status: "deleted", entry: confirmed.entry };
  });
}

export function createTelegramThreadCleanupPermitRuntime(deps: {
  ledger: {
    read(): { fence?: TelegramWorkspaceDestructiveFence };
    acquireThreadCleanupFence(input: { operationId: string; cleanupWorkSetId: string;
      bindingKey: string; slot: string; target: { chatId: number; threadId: number };
      leaderEpoch: number | string; cleanupRequestedAtMs: number }):
      | { kind: "acquired"; fence: TelegramThreadCleanupFence; resumed: boolean }
      | { kind: "blocked"; reason: string };
    adoptThreadCleanupFence(fence: TelegramThreadCleanupFence, replacement: {
      owner: { processId: number; processBirthId: string }; leaderEpoch: number | string;
    }): TelegramThreadCleanupFence;
    issueThreadCleanupDeletionPermit(fence: TelegramThreadCleanupFence):
      | { kind: "issued"; fence: TelegramThreadCleanupFence; permit: TelegramThreadCleanupDeletionPermit }
      | { kind: "already-issued"; fence: TelegramThreadCleanupFence };
    confirmThreadCleanupAbsence(fence: TelegramThreadCleanupFence): TelegramThreadCleanupFence;
    releaseUnissuedThreadCleanupFence(fence: TelegramThreadCleanupFence): boolean;
    completeThreadCleanupFence(fence: TelegramThreadCleanupFence): boolean;
  };
  getLeaderEpoch(): number | string | undefined;
  getProfileName(): string;
  getOwner(): { processId: number; processBirthId: string };
  canAdoptFence(fence: TelegramThreadCleanupFence): boolean;
  revalidateUnderFence(candidate: TelegramThreadCleanupCandidate): Promise<boolean>;
  getNowMs?: () => number;
}): {
  acquire(candidate: TelegramThreadCleanupCandidate, workSetId: string): Promise<
    | { kind: "issued"; fence: TelegramThreadCleanupFence; permit: TelegramThreadCleanupDeletionPermit }
    | { kind: "blocked" }
    | { kind: "already-issued" }
  >;
  diagnoseRecovery(candidate: TelegramThreadCleanupCandidate, workSetId: string):
    "none" | "fenced" | "deletion-issued" | "commit-ready" | "authority-blocked";
  findCommitReady(candidate: TelegramThreadCleanupCandidate,
    workSetId: string): TelegramThreadCleanupFence | undefined;
  settleDeleted(fence: TelegramThreadCleanupFence,
    commit: () => Promise<boolean>): Promise<"completed" | "commit-pending">;
} {
  const now = deps.getNowMs ?? Date.now;
  const findExactFence = (candidate: TelegramThreadCleanupCandidate, workSetId: string) => {
    const operationId = `thread-cleanup-fence:${createHash("sha256").update(
      `${workSetId}\u0000${candidate.bindingKey}`, "utf8").digest("hex")}`;
    const fence = deps.ledger.read().fence;
    return fence?.operationId === operationId && fence.destructiveKind === "manual-thread-cleanup" &&
      fence.profileKey === candidate.profileName && fence.retirementIntentId === workSetId && fence.bindingKey === candidate.bindingKey &&
      fence.slot === candidate.slot && targetKey(fence.target) === targetKey(candidate.target)
      ? fence : undefined;
  };
  const adoptExactFence = (candidate: TelegramThreadCleanupCandidate, workSetId: string) => {
    let fence = findExactFence(candidate, workSetId);
    const leaderEpoch = deps.getLeaderEpoch();
    if (!fence || leaderEpoch === undefined) return undefined;
    const owner = deps.getOwner();
    if (fence.leaderEpoch !== leaderEpoch || fence.owner.processId !== owner.processId ||
        fence.owner.processBirthId !== owner.processBirthId) {
      if (!deps.canAdoptFence(fence)) return undefined;
      try { fence = deps.ledger.adoptThreadCleanupFence(fence,
        { owner, leaderEpoch }); } catch { return undefined; }
    }
    return deps.getLeaderEpoch() === leaderEpoch ? fence : undefined;
  };
  return {
    diagnoseRecovery(candidate, workSetId) {
      const fence = deps.ledger.read().fence;
      if (!fence) return "none";
      const exact = findExactFence(candidate, workSetId);
      if (!exact) return "authority-blocked";
      const owner = deps.getOwner();
      const leaderEpoch = deps.getLeaderEpoch();
      const owns = exact.owner.processId === owner.processId &&
        exact.owner.processBirthId === owner.processBirthId && exact.leaderEpoch === leaderEpoch;
      return owns || deps.canAdoptFence(exact) ? exact.phase : "authority-blocked";
    },
    findCommitReady(candidate, workSetId) {
      const fence = adoptExactFence(candidate, workSetId);
      return fence?.phase === "commit-ready" ? fence : undefined;
    },
    async acquire(candidate, workSetId) {
      const leaderEpoch = deps.getLeaderEpoch();
      if (leaderEpoch === undefined || candidate.profileName.length === 0 ||
          candidate.profileName !== deps.getProfileName()) return { kind: "blocked" };
      const operationId = `thread-cleanup-fence:${createHash("sha256")
        .update(workSetId).update("\0").update(candidate.bindingKey).digest("hex")}`;
      const existing = adoptExactFence(candidate, workSetId) ?? deps.ledger.read().fence;
      if (existing && existing.operationId === operationId &&
          existing.destructiveKind === "manual-thread-cleanup" &&
          existing.retirementIntentId === workSetId && existing.bindingKey === candidate.bindingKey &&
          existing.slot === candidate.slot && targetKey(existing.target) === targetKey(candidate.target) &&
          existing.leaderEpoch === leaderEpoch && existing.phase !== "fenced") {
        return { kind: "already-issued" };
      }
      let acquired;
      try {
        acquired = deps.ledger.acquireThreadCleanupFence({ operationId,
          cleanupWorkSetId: workSetId, bindingKey: candidate.bindingKey, slot: candidate.slot,
          target: candidate.target, leaderEpoch, cleanupRequestedAtMs: now() });
      } catch { return { kind: "blocked" }; }
      if (acquired.kind === "blocked") return { kind: "blocked" };
      if (deps.getLeaderEpoch() !== leaderEpoch || !await deps.revalidateUnderFence(candidate)) {
        if (acquired.fence.phase === "fenced") deps.ledger.releaseUnissuedThreadCleanupFence(acquired.fence);
        return { kind: "blocked" };
      }
      const issued = deps.ledger.issueThreadCleanupDeletionPermit(acquired.fence);
      return issued.kind === "issued"
        ? { kind: "issued", fence: issued.fence, permit: issued.permit }
        : { kind: "already-issued" };
    },
    async settleDeleted(fence, commit) {
      const ready = deps.ledger.confirmThreadCleanupAbsence(fence);
      if (!await commit()) return "commit-pending";
      deps.ledger.completeThreadCleanupFence(ready);
      return "completed";
    },
  };
}


export interface TelegramInactiveThreadCleanupCoordinatorDeps<TBinding> {
  store: TelegramThreadCleanupWorkStore;
  permitRuntime: ReturnType<typeof createTelegramThreadCleanupPermitRuntime>;
  resolveFullBinding(candidate: TelegramThreadCleanupCandidate): Promise<TBinding | undefined>;
  deleteWithPermit(permit: TelegramThreadCleanupDeletionPermit,
    candidate: TelegramThreadCleanupCandidate): Promise<void>;
  commitBinding(candidate: TelegramThreadCleanupCandidate,
    currentBinding?: TBinding): Promise<boolean>;
}

export function createTelegramInactiveThreadCleanupSettingsPort<TBinding>(
  deps: TelegramInactiveThreadCleanupCoordinatorDeps<TBinding>,
): (operationId: string) => Promise<TelegramInactiveThreadCleanupResult> {
  return operationId => cleanReviewedInactiveThreads({ ...deps, operationId });
}

export interface TelegramInactiveThreadCleanupResult {
  deleted: number;
  outcomeUnknown: number;
  blocked: number;
  recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
}

export async function cleanReviewedInactiveThreads<TBinding>(input: {
  operationId: string;
} & TelegramInactiveThreadCleanupCoordinatorDeps<TBinding>): Promise<TelegramInactiveThreadCleanupResult> {
  if (!/^thread-cleanup:[a-f0-9]{32}$/u.test(input.operationId))
    throw new Error("Telegram Thread cleanup confirmation identity is invalid.");
  const workSet = input.store.list().find(candidate => candidate.operationId === input.operationId);
  if (!workSet) throw new Error("Telegram Thread cleanup review is missing.");
  let deleted = 0;
  let outcomeUnknown = 0;
  let blocked = 0;
  for (const entry of workSet.entries) {
    if (entry.state === "deleted") {
      const ready = input.permitRuntime.findCommitReady(entry, input.operationId);
      if (ready) await input.permitRuntime.settleDeleted(ready, async () => true);
      deleted += 1;
      continue;
    }
    if (entry.state === "outcome-unknown") {
      const ready = input.permitRuntime.findCommitReady(entry, input.operationId);
      if (!ready) { outcomeUnknown += 1; continue; }
      const settlement = await input.permitRuntime.settleDeleted(ready, () =>
        commitTelegramInactiveThreadCleanup({ store: input.store, operationId: input.operationId,
          bindingKey: entry.bindingKey, commitBinding: () => input.commitBinding(entry) }));
      if (settlement === "completed") deleted += 1;
      else outcomeUnknown += 1;
      continue;
    }
    const fullBinding = await input.resolveFullBinding(entry);
    if (!fullBinding) { blocked += 1; continue; }
    const authority = await input.permitRuntime.acquire(entry, input.operationId);
    if (authority.kind === "blocked") { blocked += 1; continue; }
    if (authority.kind === "already-issued") { outcomeUnknown += 1; continue; }
    try {
      const recorded = input.store.recordDeletionIssued({ operationId: input.operationId,
        bindingKey: entry.bindingKey, bindingUpdatedAtMs: entry.bindingUpdatedAtMs,
        permit: authority.permit,
      });
      if (!recorded.recorded) {
        if (recorded.entry.state === "deleted") {
          const settlement = await input.permitRuntime.settleDeleted(authority.fence, async () => true);
          if (settlement === "completed") deleted += 1;
          else outcomeUnknown += 1;
        } else outcomeUnknown += 1;
        continue;
      }
      await input.deleteWithPermit(authority.permit, entry);
      const settlement = await input.permitRuntime.settleDeleted(authority.fence, () =>
        commitTelegramInactiveThreadCleanup({ store: input.store, operationId: input.operationId,
          bindingKey: entry.bindingKey, commitBinding: () => input.commitBinding(entry, fullBinding) }));
      if (settlement === "completed") deleted += 1;
      else outcomeUnknown += 1;
    } catch {
      outcomeUnknown += 1;
    }
  }
  const retainedEntries = input.store.list().find(
    candidate => candidate.operationId === input.operationId)?.entries ?? [];
  if (outcomeUnknown > 0) {
    const diagnosis = retainedEntries.map(entry =>
      input.permitRuntime.diagnoseRecovery(entry, input.operationId)).find(value => value !== "none") ?? "none";
    const recovery = diagnosis === "commit-ready" ? "commit-ready"
      : diagnosis === "deletion-issued" ? "deletion-outcome-unknown" : "authority-blocked";
    return { deleted, outcomeUnknown, blocked, recovery };
  }
  return { deleted, outcomeUnknown, blocked };
}
