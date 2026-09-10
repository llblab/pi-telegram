/**
 * Workspace retirement preparation
 * Zones: telegram, workspace identity, lifecycle
 * Owns fail-closed protection composition, pressure selection, exact-intent admission,
 * successor adoption, and gated mocked deletion with durable retirement commit.
 */

import { isDeepStrictEqual } from "node:util";

import type { TelegramTarget } from "./target.ts";
import type {
  TelegramTopicTargetStore,
  TelegramWorkspaceExternalProtectionEvidence,
  TelegramWorkspaceRetirementIntent,
  TelegramWorkspaceProtectionState,
  TelegramWorkspaceThreadBinding,
} from "./threads.ts";
import {
  planTelegramWorkspaceSlotAllocation,
  type TelegramWorkspaceSlotOccupancy,
} from "./workspace-slots.ts";
import {
  createTelegramWorkspaceAdmissionOperationId,
  isTelegramWorkspaceRetirementFence,
  runWithTelegramWorkspaceAdmissionsAsync,
  type TelegramWorkspaceAdmissionLedger,
  type TelegramWorkspaceAdmissionScope,
  type TelegramWorkspaceDeletionPermit,
  type TelegramWorkspaceRetirementFence,
} from "./workspace-admission.ts";

export interface TelegramWorkspaceOperationGate {
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function createTelegramWorkspaceOperationGate(): TelegramWorkspaceOperationGate {
  let tail: Promise<void> = Promise.resolve();
  return {
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      const run = tail.then(operation);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

export type TelegramWorkspaceOperationRunner = <T>(
  input: {
    operationId: string;
    operationKind: string;
    scopes: readonly TelegramWorkspaceAdmissionScope[];
  },
  operation: () => Promise<T>,
) => Promise<T>;

export interface TelegramWorkspaceOperationRuntime
  extends TelegramWorkspaceOperationGate {
  run: TelegramWorkspaceOperationRunner;
}

export function createTelegramWorkspaceOperationRuntime(input: {
  getWorkspaceAdmission?: () => Pick<
    TelegramWorkspaceAdmissionLedger,
    "acquireAdmission" | "releaseAdmission"
  > | undefined;
  onReleaseError?: (error: unknown, operationKind: string) => void;
} = {}): TelegramWorkspaceOperationRuntime {
  const gate = createTelegramWorkspaceOperationGate();
  const run: TelegramWorkspaceOperationRunner = (metadata, operation) => {
    const gated = () => gate.runExclusive(operation);
    if (!input.getWorkspaceAdmission) return gated();
    const admission = input.getWorkspaceAdmission();
    if (!admission) {
      throw new Error("Telegram Workspace admission authority is unavailable.");
    }
    return runWithTelegramWorkspaceAdmissionsAsync({
      ledger: admission,
      ...metadata,
      operation: gated,
      onReleaseError(error) {
        input.onReleaseError?.(error, metadata.operationKind);
      },
    });
  };
  return { run, runExclusive: gate.runExclusive };
}

export interface TelegramWorkspaceJournalProtectionCapture {
  sources: TelegramWorkspaceJournalProtectionSource[];
  complete: boolean;
}

interface TelegramWorkspaceJournalReader {
  recoveryKey?: string;
  journal: { read: () => { entries: readonly { update: unknown }[] } };
}

export function captureTelegramWorkspaceJournalProtectionSources(input: {
  binding: TelegramWorkspaceThreadBinding;
  resolveLeader: () => TelegramWorkspaceJournalReader | undefined;
  createFollowerResolver: (
    journalBindingKey: string,
  ) => () => TelegramWorkspaceJournalReader | undefined;
  withJournalReference?: <T>(binding: TelegramWorkspaceJournalReader,
    operation: () => T) => T;
  discovery?: {
    paths: readonly string[];
    complete: boolean;
    createResolver: (path: string) => () => TelegramWorkspaceJournalReader | undefined;
  };
}): TelegramWorkspaceJournalProtectionCapture {
  const sources: TelegramWorkspaceJournalProtectionSource[] = [];
  let complete = input.binding.journalBindingsComplete === true ||
    input.discovery?.complete === true;
  const capture = (
    scope: TelegramWorkspaceJournalProtectionSource["scope"],
    resolve: () => TelegramWorkspaceJournalReader | undefined,
  ): void => {
    try {
      const binding = resolve();
      if (!binding) {
        complete = false;
        sources.push({ kind: "unknown", scope });
        return;
      }
      const snapshot = input.withJournalReference
        ? input.withJournalReference(binding, binding.journal.read)
        : binding.journal.read();
      sources.push({ kind: "available", scope, entries: snapshot.entries });
    } catch {
      complete = false;
      sources.push({ kind: "unknown", scope });
    }
  };
  capture({ kind: "shared" }, input.resolveLeader);
  for (const journalBindingKey of input.binding.journalBindingKeys ?? []) {
    capture(
      {
        kind: "binding",
        bindingKey: input.binding.bindingKey,
        journalBindingKey,
      },
      input.createFollowerResolver(journalBindingKey),
    );
  }
  for (const path of input.discovery?.paths ?? []) {
    capture({ kind: "discovered", path }, input.discovery!.createResolver(path));
  }
  return { sources, complete };
}

export type TelegramWorkspaceJournalProtectionSource =
  | {
      kind: "available";
      scope:
        | { kind: "shared" }
        | { kind: "binding"; bindingKey: string; journalBindingKey: string }
        | { kind: "discovered"; path: string };
      entries: readonly { update: unknown }[];
    }
  | {
      kind: "unknown";
      scope:
        | { kind: "shared" }
        | { kind: "binding"; bindingKey: string; journalBindingKey: string }
        | { kind: "discovered"; path: string };
    };

function getJournalUpdateTarget(update: unknown):
  | { chatId: number; threadId?: number }
  | undefined {
  if (!update || typeof update !== "object" || Array.isArray(update)) return undefined;
  const record = update as Record<string, unknown>;
  if (record.message_reaction !== undefined) return undefined;
  const direct = record.message ?? record.edited_message ?? record.guest_message;
  const callback = record.callback_query;
  const message = direct ?? (
    callback && typeof callback === "object" && !Array.isArray(callback)
      ? (callback as Record<string, unknown>).message
      : undefined
  );
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const messageRecord = message as Record<string, unknown>;
  const chat = messageRecord.chat;
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) return undefined;
  const chatId = (chat as Record<string, unknown>).id;
  if (typeof chatId !== "number") return undefined;
  const threadId = messageRecord.message_thread_id;
  return {
    chatId,
    ...(typeof threadId === "number" ? { threadId } : {}),
  };
}

function sameTarget(
  left: { chatId: number; threadId?: number },
  right: { chatId: number; threadId?: number },
): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

export function resolveTelegramWorkspaceAcceptedWorkProtection(input: {
  binding: TelegramWorkspaceThreadBinding;
  localAcceptedTargets: readonly { chatId: number; threadId?: number }[];
  journalSources: readonly TelegramWorkspaceJournalProtectionSource[];
  sourcesComplete: boolean;
}): TelegramWorkspaceProtectionState {
  if (input.localAcceptedTargets.some((target) => sameTarget(target, input.binding.target))) {
    return "protected";
  }
  let unknown = !input.sourcesComplete;
  for (const source of input.journalSources) {
    const relevant = source.scope.kind !== "binding" ||
      source.scope.bindingKey === input.binding.bindingKey;
    if (!relevant) continue;
    if (source.kind === "unknown") {
      unknown = true;
      continue;
    }
    if (source.scope.kind === "binding" && source.entries.length > 0) {
      return "protected";
    }
    for (const entry of source.entries) {
      const target = getJournalUpdateTarget(entry.update);
      if (!target) {
        unknown = true;
        continue;
      }
      if (sameTarget(target, input.binding.target)) return "protected";
    }
  }
  return unknown ? "unknown" : "clear";
}

export type TelegramWorkspaceJournalPruneResult =
  | {
      kind: "committed";
      binding: TelegramWorkspaceThreadBinding;
      removedKeys: string[];
    }
  | {
      kind: "blocked";
      reason: "incomplete-evidence" | "writer-not-quiescent" | "state-changed";
    };

export async function pruneTelegramWorkspaceJournalEvidence(input: {
  store: Pick<
    TelegramTopicTargetStore,
    "commitWorkspaceJournalEvidence" | "persist"
  >;
  binding: TelegramWorkspaceThreadBinding;
  capture: TelegramWorkspaceJournalProtectionCapture;
  getJournalWriterProtection: (
    journalBindingKey: string,
  ) => TelegramWorkspaceProtectionState;
  getLeaderEpoch: () => number | string | undefined;
  getProfileKey: () => string;
  admission: Pick<
    TelegramWorkspaceAdmissionLedger,
    "acquireAdmission" | "releaseAdmission"
  >;
  isCurrent?: () => boolean;
  onAdmissionReleaseError?: (error: unknown) => void;
}): Promise<TelegramWorkspaceJournalPruneResult> {
  const operation = async (): Promise<TelegramWorkspaceJournalPruneResult> => {
    const leaderEpoch = input.getLeaderEpoch();
    const profileKey = input.getProfileKey();
    const isCurrent = () =>
      leaderEpoch !== undefined &&
      input.getLeaderEpoch() === leaderEpoch &&
      input.getProfileKey() === profileKey &&
      input.isCurrent?.() !== false;
    if (!isCurrent()) {
      throw new Error(
        "Telegram Workspace journal pruning requires current leader authority.",
      );
    }
    const shared = input.capture.sources.filter(
      (source) => source.scope.kind === "shared",
    );
    const bindingSources = input.capture.sources.filter(
      (source) =>
        source.scope.kind === "binding" &&
        source.scope.bindingKey === input.binding.bindingKey,
    );
    const sourceByKey = new Map(
      bindingSources.flatMap((source) =>
        source.scope.kind === "binding"
          ? [[source.scope.journalBindingKey, source] as const]
          : [],
      ),
    );
    if (
      !input.capture.complete ||
      shared.length !== 1 ||
      shared[0]?.kind !== "available" ||
      bindingSources.length !==
        (input.binding.journalBindingKeys ?? []).length ||
      sourceByKey.size !== (input.binding.journalBindingKeys ?? []).length ||
      Array.from(sourceByKey.values()).some(
        (source) => source.kind !== "available",
      )
    ) {
      return { kind: "blocked", reason: "incomplete-evidence" };
    }
    const emptyKeys = (input.binding.journalBindingKeys ?? []).filter((key) => {
      const source = sourceByKey.get(key);
      return source?.kind === "available" && source.entries.length === 0;
    });
    if (
      emptyKeys.some(
        (key) => input.getJournalWriterProtection(key) !== "clear",
      )
    ) {
      return { kind: "blocked", reason: "writer-not-quiescent" };
    }
    const retainedKeys = (input.binding.journalBindingKeys ?? []).filter(
      (key) => !emptyKeys.includes(key),
    );
    if (!isCurrent()) {
      throw new Error("Telegram Workspace journal pruning lost leader authority.");
    }
    const binding = input.store.commitWorkspaceJournalEvidence(
      input.binding,
      retainedKeys,
      input.binding.journalBindingsComplete === true,
    );
    if (!binding) return { kind: "blocked", reason: "state-changed" };
    const removedKeys = (input.binding.journalBindingKeys ?? []).filter(
      (key) => !retainedKeys.includes(key),
    );
    if (removedKeys.length > 0) await input.store.persist();
    if (!isCurrent()) {
      throw new Error("Telegram Workspace journal pruning lost leader authority.");
    }
    return { kind: "committed", binding, removedKeys };
  };
  return runWithTelegramWorkspaceAdmissionsAsync({
    ledger: input.admission,
    operationId: createTelegramWorkspaceAdmissionOperationId(),
    operationKind: "workspace.prune-journal-evidence",
    scopes: [{ kind: "target", target: input.binding.target }],
    operation,
    onReleaseError(error) {
      input.onAdmissionReleaseError?.(error);
    },
  });
}

export function captureTelegramWorkspaceExternalProtection(input: {
  binding: TelegramWorkspaceThreadBinding;
  getLiveOwnerProtection: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceProtectionState;
  getLocalAcceptedTargets: (
    binding: TelegramWorkspaceThreadBinding,
  ) => { targets: readonly TelegramTarget[]; complete: boolean };
  captureJournalSources: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceJournalProtectionCapture;
  getDeliveryAuthorityProtection?: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceProtectionState;
}): TelegramWorkspaceExternalProtectionEvidence {
  let liveOwner: TelegramWorkspaceProtectionState = "unknown";
  let acceptedWork: TelegramWorkspaceProtectionState = "unknown";
  let deliveryAuthority: TelegramWorkspaceProtectionState = "unknown";
  try {
    liveOwner = input.getLiveOwnerProtection(input.binding);
  } catch {
    // Unavailable registry/process evidence must not clear a binding.
  }
  try {
    const journals = input.captureJournalSources(input.binding);
    const local = input.getLocalAcceptedTargets(input.binding);
    acceptedWork = resolveTelegramWorkspaceAcceptedWorkProtection({
      binding: input.binding,
      localAcceptedTargets: local.targets,
      journalSources: journals.sources,
      sourcesComplete: journals.complete && local.complete,
    });
  } catch {
    // Unavailable queue or journal evidence must not clear accepted work.
  }
  try {
    deliveryAuthority = input.getDeliveryAuthorityProtection?.(input.binding) ?? "unknown";
  } catch {
    // Unavailable delivery evidence must not clear a binding.
  }
  return { liveOwner, acceptedWork, deliveryAuthority };
}

export function createTelegramWorkspaceExternalProtectionCapture(deps: {
  listFollowers: () => readonly { target?: TelegramTarget }[];
  getActiveTurnTarget: () => TelegramTarget | undefined;
  getQueuedItems: () => readonly { chatId: number; target?: TelegramTarget }[];
  resolveLeaderJournal: () => TelegramWorkspaceJournalReader | undefined;
  createFollowerJournalResolver: (
    journalBindingKey: string,
  ) => () => TelegramWorkspaceJournalReader | undefined;
  discoverFollowerJournals?: () => { paths: readonly string[]; complete: boolean };
  createJournalPathResolver?: (
    path: string,
  ) => () => TelegramWorkspaceJournalReader | undefined;
  withJournalReference?: <T>(binding: TelegramWorkspaceJournalReader,
    operation: () => T) => T;
  getJournalWriterProtection?: (
    journalBindingKey: string,
  ) => TelegramWorkspaceProtectionState;
  getDeliveryAuthorityProtection?: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceProtectionState;
}): (
  binding: TelegramWorkspaceThreadBinding,
) => TelegramWorkspaceExternalProtectionEvidence {
  return function (binding) {
    return captureTelegramWorkspaceExternalProtection({
      binding,
      getLiveOwnerProtection(candidate) {
        if (deps.listFollowers().some((follower) =>
          !!follower.target && sameTarget(follower.target, candidate.target),
        )) return "protected";
        if (!deps.getJournalWriterProtection) return "unknown";
        let unknown = candidate.journalBindingsComplete !== true;
        for (const journalBindingKey of candidate.journalBindingKeys ?? []) {
          const protection = deps.getJournalWriterProtection(journalBindingKey);
          if (protection === "protected") return "protected";
          if (protection === "unknown") unknown = true;
        }
        return unknown ? "unknown" : "clear";
      },
      getLocalAcceptedTargets(candidate) {
        const items = deps.getQueuedItems();
        const targets: TelegramTarget[] = [];
        const activeTarget = deps.getActiveTurnTarget();
        if (activeTarget) targets.push(activeTarget);
        let complete = true;
        for (const item of items) {
          if (item.target) targets.push(item.target);
          else if (item.chatId === candidate.target.chatId) complete = false;
        }
        return { targets, complete };
      },
      captureJournalSources(candidate) {
        const discovery = candidate.journalBindingsComplete === true
          ? undefined
          : deps.discoverFollowerJournals?.();
        return captureTelegramWorkspaceJournalProtectionSources({
          binding: candidate,
          resolveLeader: deps.resolveLeaderJournal,
          createFollowerResolver: deps.createFollowerJournalResolver,
          ...(deps.withJournalReference
            ? { withJournalReference: deps.withJournalReference } : {}),
          ...(discovery && deps.createJournalPathResolver
            ? { discovery: {
                ...discovery,
                createResolver: deps.createJournalPathResolver,
              } }
            : {}),
        });
      },
      ...(deps.getDeliveryAuthorityProtection
        ? { getDeliveryAuthorityProtection: deps.getDeliveryAuthorityProtection }
        : {}),
    });
  };
}

export type TelegramWorkspaceRetirementAdoption =
  | { kind: "adopted"; intent: TelegramWorkspaceRetirementIntent }
  | {
      kind: "blocked";
      reason:
        | "intent-conflict"
        | "profile-changed"
        | "binding-changed"
        | "protection-changed"
        | "commit-rejected";
    };

export async function adoptTelegramWorkspaceRetirementIntent(input: {
  store: Pick<
    TelegramTopicTargetStore,
    | "captureWorkspaceSlotOccupancy"
    | "listWorkspaceBindings"
    | "listWorkspaceRetirementIntents"
    | "replaceWorkspaceRetirementIntent"
  >;
  intent: TelegramWorkspaceRetirementIntent;
  getExternalProtection: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceExternalProtectionEvidence;
  getLeaderEpoch: () => number | string | undefined;
  getProfileKey: () => string;
  isCurrent?: () => boolean;
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<TelegramWorkspaceRetirementAdoption> {
  return input.runExclusive(async () => {
    const leaderEpoch = input.getLeaderEpoch();
    const profileKey = input.getProfileKey();
    const isCurrent = () =>
      leaderEpoch !== undefined && input.getLeaderEpoch() === leaderEpoch &&
      input.getProfileKey() === profileKey && input.isCurrent?.() !== false;
    if (!isCurrent()) throw new Error("Telegram Workspace retirement adoption requires current leader authority.");
    const intents = input.store.listWorkspaceRetirementIntents();
    if (intents.length !== 1 || !isDeepStrictEqual(intents[0], input.intent)) {
      return { kind: "blocked", reason: "intent-conflict" };
    }
    if (input.intent.profileKey !== profileKey) {
      return { kind: "blocked", reason: "profile-changed" };
    }
    const binding = input.store.listWorkspaceBindings().find((candidate) =>
      candidate.bindingKey === input.intent.binding.bindingKey,
    );
    if (!binding || !isDeepStrictEqual(binding, input.intent.binding)) {
      return { kind: "blocked", reason: "binding-changed" };
    }
    const eligible = input.store.captureWorkspaceSlotOccupancy(
      input.getExternalProtection,
      { expectedRetirement: input.intent },
    ).bindings.find((candidate) =>
      candidate.bindingKey === binding.bindingKey,
    )?.protection === "eligible";
    if (!eligible) return { kind: "blocked", reason: "protection-changed" };
    const replacement = { ...input.intent, leaderEpoch: leaderEpoch! };
    if (!isCurrent()) throw new Error("Telegram Workspace retirement adoption lost leader authority.");
    if (!await input.store.replaceWorkspaceRetirementIntent(
      input.intent,
      replacement,
      isCurrent,
    )) return { kind: "blocked", reason: "commit-rejected" };
    return { kind: "adopted", intent: replacement };
  });
}

function isTelegramWorkspaceDeletionConfirmedAbsent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = "status" in error && typeof error.status === "number"
    ? error.status : undefined;
  if (status !== undefined && status !== 400) return false;
  const message = error.message.toLowerCase();
  return message.includes("topic_id_invalid") ||
    message.includes("message thread not found") ||
    message.includes("thread not found") ||
    message.includes("topic not found") ||
    message.includes("topic deleted");
}

export type TelegramWorkspaceRetirementExecution =
  | { kind: "retired"; bindingKey: string; slot: string }
  | {
      kind: "retained";
      reason:
        | "stale-intent"
        | "protection-changed"
        | "admission-active"
        | "fence-conflict"
        | "delete-unconfirmed"
        | "authority-changed"
        | "commit-rejected"
        | "fence-release-unconfirmed";
    };

export type TelegramWorkspaceRetirementAbsence =
  | "absent"
  | "present"
  | "unknown";

function matchesTelegramWorkspaceRetirementFence(
  fence: TelegramWorkspaceRetirementFence,
  intent: TelegramWorkspaceRetirementIntent,
): boolean {
  return (
    fence.retirementIntentId === intent.id &&
    fence.profileKey === intent.profileKey &&
    fence.bindingKey === intent.binding.bindingKey &&
    fence.slot === intent.binding.slot &&
    fence.target.chatId === intent.binding.target.chatId &&
    fence.target.threadId === intent.binding.target.threadId &&
    fence.retirementRequestedAtMs === intent.requestedAtMs
  );
}

export async function executeTelegramWorkspaceRetirement(input: {
  store: Pick<
    TelegramTopicTargetStore,
    | "captureWorkspaceSlotOccupancy"
    | "listWorkspaceBindings"
    | "listWorkspaceRetirementIntents"
    | "commitWorkspaceRetirement"
  >;
  admission: Pick<
    TelegramWorkspaceAdmissionLedger,
    | "getOwner"
    | "read"
    | "acquireRetirementFence"
    | "adoptRetirementFence"
    | "issueDeletionPermit"
    | "confirmRetirementAbsence"
    | "releaseUnissuedRetirementFence"
    | "completeRetirementFence"
  >;
  intent: TelegramWorkspaceRetirementIntent;
  getExternalProtection: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceExternalProtectionEvidence;
  getLeaderEpoch: () => number | string | undefined;
  getProfileKey: () => string;
  isCurrent?: () => boolean;
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  deleteForumTopic: (
    permit: TelegramWorkspaceDeletionPermit,
    body: { chat_id: number; message_thread_id: number },
    options: { maxAttempts: 1 },
  ) => Promise<unknown>;
  confirmTargetAbsent?: (
    target: TelegramTarget & { threadId: number },
  ) => Promise<TelegramWorkspaceRetirementAbsence>;
}): Promise<TelegramWorkspaceRetirementExecution> {
  return input.runExclusive(async () => {
    const isCurrent = () =>
      input.getLeaderEpoch() === input.intent.leaderEpoch &&
      input.getProfileKey() === input.intent.profileKey &&
      input.isCurrent?.() !== false;
    if (!isCurrent()) return { kind: "retained", reason: "authority-changed" };
    if (!input.intent.binding.slot || !/^[A-Z]$/u.test(input.intent.binding.slot)) {
      return { kind: "retained", reason: "stale-intent" };
    }
    const owner = input.admission.getOwner();
    const storedFence = input.admission.read().fence;
    if (storedFence && !isTelegramWorkspaceRetirementFence(storedFence)) {
      return { kind: "retained", reason: "fence-conflict" };
    }
    let fence: TelegramWorkspaceRetirementFence | undefined = storedFence;
    if (fence && !matchesTelegramWorkspaceRetirementFence(fence, input.intent)) {
      return { kind: "retained", reason: "fence-conflict" };
    }
    if (
      fence &&
      (fence.leaderEpoch !== input.intent.leaderEpoch ||
        fence.owner.processId !== owner.processId ||
        fence.owner.processBirthId !== owner.processBirthId)
    ) {
      fence = input.admission.adoptRetirementFence(fence, {
        owner,
        leaderEpoch: input.intent.leaderEpoch,
      });
    }
    const intent = input.store.listWorkspaceRetirementIntents().find((candidate) =>
      isDeepStrictEqual(candidate, input.intent),
    );
    const binding = input.store.listWorkspaceBindings().find((candidate) =>
      candidate.bindingKey === input.intent.binding.bindingKey,
    );
    if (!intent || !binding || !isDeepStrictEqual(binding, input.intent.binding)) {
      if (!intent && !binding && fence?.phase === "commit-ready") {
        try {
          input.admission.completeRetirementFence(fence);
        } catch {
          if (input.admission.read().fence) {
            return { kind: "retained", reason: "fence-release-unconfirmed" };
          }
        }
        return {
          kind: "retired",
          bindingKey: input.intent.binding.bindingKey,
          slot: input.intent.binding.slot,
        };
      }
      return { kind: "retained", reason: "stale-intent" };
    }
    const eligible = () => input.store.captureWorkspaceSlotOccupancy(
      input.getExternalProtection,
      { expectedRetirement: input.intent },
    ).bindings.find((candidate) =>
      candidate.bindingKey === input.intent.binding.bindingKey,
    )?.protection === "eligible";
    if (!eligible()) return { kind: "retained", reason: "protection-changed" };
    if (!fence) {
      const acquired = input.admission.acquireRetirementFence({
        operationId: `workspace-retirement:${input.intent.id}`,
        retirementIntentId: input.intent.id,
        bindingKey: binding.bindingKey,
        slot: binding.slot!,
        target: binding.target,
        leaderEpoch: input.intent.leaderEpoch,
        retirementRequestedAtMs: input.intent.requestedAtMs,
      });
      if (acquired.kind === "blocked") {
        return {
          kind: "retained",
          reason:
            acquired.reason === "admission-active"
              ? "admission-active"
              : "fence-conflict",
        };
      }
      fence = acquired.fence;
    }
    if (!isCurrent()) return { kind: "retained", reason: "authority-changed" };
    if (fence.phase === "fenced" && !eligible()) {
      input.admission.releaseUnissuedRetirementFence(fence);
      return { kind: "retained", reason: "protection-changed" };
    }
    if (fence.phase === "fenced") {
      const issued = input.admission.issueDeletionPermit(fence);
      if (issued.kind !== "issued") {
        return { kind: "retained", reason: "delete-unconfirmed" };
      }
      fence = issued.fence;
      try {
        await input.deleteForumTopic(
          issued.permit,
          {
            chat_id: binding.target.chatId,
            message_thread_id: binding.target.threadId,
          },
          { maxAttempts: 1 },
        );
      } catch (error) {
        if (!isTelegramWorkspaceDeletionConfirmedAbsent(error)) {
          return { kind: "retained", reason: "delete-unconfirmed" };
        }
      }
      fence = input.admission.confirmRetirementAbsence(fence);
    } else if (fence.phase === "deletion-issued") {
      const absence = await input.confirmTargetAbsent?.(binding.target);
      if (absence !== "absent") {
        return { kind: "retained", reason: "delete-unconfirmed" };
      }
      fence = input.admission.confirmRetirementAbsence(fence);
    }
    if (!isCurrent()) return { kind: "retained", reason: "authority-changed" };
    if (!eligible()) return { kind: "retained", reason: "protection-changed" };
    if (!await input.store.commitWorkspaceRetirement(input.intent, isCurrent)) {
      return { kind: "retained", reason: "commit-rejected" };
    }
    try {
      input.admission.completeRetirementFence(fence);
    } catch {
      if (input.admission.read().fence) {
        return { kind: "retained", reason: "fence-release-unconfirmed" };
      }
    }
    return {
      kind: "retired",
      bindingKey: binding.bindingKey,
      slot: binding.slot!,
    };
  });
}

export type TelegramWorkspaceRetirementPreparation =
  | { kind: "ready"; intent: TelegramWorkspaceRetirementIntent }
  | { kind: "not-needed"; reason: "free-capacity" }
  | {
      kind: "blocked";
      reason:
        | "invalid-state"
        | "protected-capacity"
        | "state-changed"
        | "existing-intent-conflict"
        | "stale-intent";
    };

export interface TelegramWorkspaceRetirementPreparationDeps {
  store: Pick<
    TelegramTopicTargetStore,
    | "captureWorkspaceSlotOccupancy"
    | "listWorkspaceBindings"
    | "listWorkspaceRetirementIntents"
    | "upsertWorkspaceRetirementIntent"
    | "removeWorkspaceRetirementIntent"
    | "persist"
  >;
  getExternalProtection: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceExternalProtectionEvidence;
  getLeaderEpoch: () => number | string | undefined;
  getProfileKey: () => string;
  isCurrent?: () => boolean;
  getNowMs?: () => number;
}

function findEligibleCandidate(
  occupancy: readonly TelegramWorkspaceSlotOccupancy[],
  reservedSlots: readonly string[],
  nowMs: number,
):
  | { kind: "candidate"; candidate: TelegramWorkspaceSlotOccupancy }
  | Exclude<TelegramWorkspaceRetirementPreparation, { kind: "ready" }> {
  const allocation = planTelegramWorkspaceSlotAllocation({
    bindings: occupancy,
    reservedSlots,
    nowMs,
  });
  if (allocation.kind === "free") {
    return { kind: "not-needed", reason: "free-capacity" };
  }
  if (allocation.kind === "blocked") return allocation;
  return { kind: "candidate", candidate: allocation.candidate };
}

export async function prepareTelegramWorkspaceRetirement(
  deps: TelegramWorkspaceRetirementPreparationDeps,
): Promise<TelegramWorkspaceRetirementPreparation> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const leaderEpoch = deps.getLeaderEpoch();
  const profileKey = deps.getProfileKey();
  const isCurrent = () =>
    leaderEpoch !== undefined &&
    deps.getLeaderEpoch() === leaderEpoch &&
    deps.getProfileKey() === profileKey &&
    deps.isCurrent?.() !== false;
  if (!isCurrent()) throw new Error("Telegram Workspace retirement requires current leader authority.");

  const existing = deps.store.listWorkspaceRetirementIntents();
  if (existing.length > 1) {
    return { kind: "blocked", reason: "existing-intent-conflict" };
  }
  if (existing.length === 1) {
    const intent = existing[0]!;
    const binding = deps.store.listWorkspaceBindings().find((candidate) =>
      candidate.bindingKey === intent.binding.bindingKey,
    );
    const snapshot = deps.store.captureWorkspaceSlotOccupancy(
      deps.getExternalProtection,
      { expectedRetirement: intent },
    );
    const candidate = snapshot.bindings.find((entry) =>
      entry.bindingKey === intent.binding.bindingKey,
    );
    if (
      intent.profileKey !== profileKey ||
      intent.leaderEpoch !== leaderEpoch ||
      !binding || !isDeepStrictEqual(binding, intent.binding) ||
      candidate?.protection !== "eligible"
    ) {
      return { kind: "blocked", reason: "stale-intent" };
    }
    if (!isCurrent()) throw new Error("Telegram Workspace retirement lost leader authority.");
    await deps.store.persist();
    if (!isCurrent()) throw new Error("Telegram Workspace retirement lost leader authority.");
    return { kind: "ready", intent };
  }

  const nowMs = getNowMs();
  const snapshot = deps.store.captureWorkspaceSlotOccupancy(
    deps.getExternalProtection,
  );
  const selection = findEligibleCandidate(
    snapshot.bindings,
    snapshot.reservedSlots,
    nowMs,
  );
  if (selection.kind !== "candidate") return selection;
  const selected = selection.candidate;
  const binding = deps.store.listWorkspaceBindings().find((candidate) =>
    candidate.bindingKey === selected.bindingKey,
  );
  if (
    !binding?.slot ||
    binding.slot.toLowerCase() !== selected.slot ||
    binding.inactiveSinceMs !== selected.inactiveSinceMs
  ) {
    return { kind: "blocked", reason: "state-changed" };
  }
  const intent: TelegramWorkspaceRetirementIntent = {
    id: `workspace-retirement:pressure:${binding.bindingKey}:${binding.slot}:${binding.inactiveSinceMs}`,
    reason: "pressure",
    profileKey,
    binding,
    leaderEpoch: leaderEpoch!,
    requestedAtMs: nowMs,
  };
  if (!isCurrent()) throw new Error("Telegram Workspace retirement lost leader authority.");
  if (!deps.store.upsertWorkspaceRetirementIntent(intent)) {
    return { kind: "blocked", reason: "state-changed" };
  }
  const rechecked = deps.store.captureWorkspaceSlotOccupancy(
    deps.getExternalProtection,
    { expectedRetirement: intent },
  ).bindings.find((candidate) => candidate.bindingKey === binding.bindingKey);
  if (rechecked?.protection !== "eligible" || !isCurrent()) {
    deps.store.removeWorkspaceRetirementIntent(intent);
    if (!isCurrent()) throw new Error("Telegram Workspace retirement lost leader authority.");
    return { kind: "blocked", reason: "state-changed" };
  }
  await deps.store.persist();
  if (!isCurrent()) throw new Error("Telegram Workspace retirement lost leader authority.");
  return { kind: "ready", intent };
}

export type TelegramWorkspaceRetirementLifecycleResult =
  | TelegramWorkspaceRetirementExecution
  | Extract<TelegramWorkspaceRetirementPreparation, { kind: "not-needed" }>
  | {
      kind: "blocked";
      stage: "preparation" | "adoption";
      reason: string;
    };

export async function runTelegramWorkspaceRetirementLifecycle(input: {
  store: TelegramWorkspaceRetirementPreparationDeps["store"] & Pick<
    TelegramTopicTargetStore,
    "replaceWorkspaceRetirementIntent" | "commitWorkspaceRetirement"
  >;
  getExternalProtection: (
    binding: TelegramWorkspaceThreadBinding,
  ) => TelegramWorkspaceExternalProtectionEvidence;
  getLeaderEpoch: () => number | string | undefined;
  getProfileKey: () => string;
  isCurrent?: () => boolean;
  getNowMs?: () => number;
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  admission: Parameters<typeof executeTelegramWorkspaceRetirement>[0]["admission"];
  deleteForumTopic: Parameters<
    typeof executeTelegramWorkspaceRetirement
  >[0]["deleteForumTopic"];
  confirmTargetAbsent?: Parameters<
    typeof executeTelegramWorkspaceRetirement
  >[0]["confirmTargetAbsent"];
}): Promise<TelegramWorkspaceRetirementLifecycleResult> {
  let intent = input.store.listWorkspaceRetirementIntents()[0];
  if (intent) {
    const adoption = await adoptTelegramWorkspaceRetirementIntent({
      store: input.store,
      intent,
      getExternalProtection: input.getExternalProtection,
      getLeaderEpoch: input.getLeaderEpoch,
      getProfileKey: input.getProfileKey,
      isCurrent: input.isCurrent,
      runExclusive: input.runExclusive,
    });
    if (adoption.kind !== "adopted") {
      return { kind: "blocked", stage: "adoption", reason: adoption.reason };
    }
    intent = adoption.intent;
  } else {
    const preparation = await prepareTelegramWorkspaceRetirement(
      {
        store: input.store,
        getExternalProtection: input.getExternalProtection,
        getLeaderEpoch: input.getLeaderEpoch,
        getProfileKey: input.getProfileKey,
        isCurrent: input.isCurrent,
        getNowMs: input.getNowMs,
      },
    );
    if (preparation.kind === "not-needed") return preparation;
    if (preparation.kind === "blocked") {
      return { kind: "blocked", stage: "preparation", reason: preparation.reason };
    }
    intent = preparation.intent;
  }
  return executeTelegramWorkspaceRetirement({
    store: input.store,
    intent,
    getExternalProtection: input.getExternalProtection,
    getLeaderEpoch: input.getLeaderEpoch,
    getProfileKey: input.getProfileKey,
    isCurrent: input.isCurrent,
    runExclusive: input.runExclusive,
    admission: input.admission,
    deleteForumTopic: input.deleteForumTopic,
    confirmTargetAbsent: input.confirmTargetAbsent,
  });
}
