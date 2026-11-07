/**
 * Telegram bus leader orchestration
 * Zones: multi-instance bus, leader polling/server lifecycle, follower routing
 * Owns leader-only runtime orchestration: follower registration envelopes, follower API proxying,
 * leader activation hot-switching, local bus server startup, and stale follower pruning.
 */

import { isDeepStrictEqual } from "node:util";

import { getTelegramBusTransportRetryPolicy } from "./bus-transport.ts";
import { getTelegramTextInputControlId, getTelegramAttachmentControlId, readTelegramTextInputReceiverBotId } from "./delivery.ts";
import type { TelegramOriginalPublicationWriter } from "./ownership.ts";
import {
  createTelegramBusLocalServer,
  parseTelegramBusArtifactDocument,
  TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT,
  TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION,
  TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY,
  TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY,
  TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT,
  parseTelegramBusAttachmentPublicationReceipt,
  createUnauthorizedBusAck,
  rejectTelegramBusRequest,
  getTelegramBusEnvelopeTrafficClass,
  getTelegramBusFollowerSocketPath,
  getTelegramBusProtocolCompatibility,
  hasTelegramBusCapability,
  isTelegramBusEnvelopeAuthorized,
  isSameTelegramBusFollowerRegistration,
  parseTelegramBusEnvelope,
  sendTelegramBusLocalEnvelope,
  stripTelegramBusApiMetadata,
  TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT,
  TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
  TELEGRAM_BUS_CAPABILITY_CONNECT_RECOVERY,
  hasTelegramBusSteerQueueHandoffCapability,
  TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
  TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
  TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
  type TelegramBusEnvelope,
  type TelegramBusLeaderQueueHandoffOffer,
  type TelegramBusFollowerRegistry,
  type TelegramBusFollowerView,
  type TelegramBusInstanceRegistration,
  type TelegramBusProtocolIdentity,
  type TelegramBusSelectedMenuDelivery,
  type TelegramBusSocketPathSource,
  TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE,
} from "./bus.ts";
import type { TelegramThreadDisplayMode } from "./config.ts";
import type { TelegramAttachmentSource } from "./media.ts";
import { TELEGRAM_ARTIFACT_MAX_BYTES } from "./wire.ts";
import { escapeHtml } from "./rendering.ts";
import * as Sync from "./sync.ts";
import {
  parseTelegramIntegerId as asInteger,
  type TelegramTarget,
} from "./target.ts";
import {
  getTelegramApiErrorRequestTarget,
  isTelegramApiCommitUnknownError,
  TelegramApiAuthorityError,
  TelegramApiCommitUnknownError,
  isTelegramApiRequestRejected,
  type TelegramApiCallOptions,
  type TelegramBridgeApiRuntime,
} from "./telegram-api.ts";
import {
  createTelegramThreadDisplayReconciler,
  resolveTelegramInitialWorkspaceDisplayName,
  resolveTelegramLiveWorkspaceBindingKeys,
} from "./thread-display.ts";
import * as ThreadNaming from "./thread-naming.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import * as Threads from "./threads.ts";
import {
  createTelegramWorkspaceAdmissionOperationId,
  runWithTelegramWorkspaceAdmissionsAsync,
  type TelegramWorkspaceAdmissionLedger,
} from "./workspace-admission.ts";
import * as WorkspaceIdentity from "./workspace-identity.ts";
import {
  createTelegramWorkspaceOperationRuntime,
  createTelegramWorkspaceSlotRotation,
  type TelegramWorkspaceCapacityRunner,
  type TelegramWorkspaceOperationRunner,
  type TelegramWorkspaceSlotRotationPorts,
} from "./workspace-retirement.ts";
import {
  TELEGRAM_WORKSPACE_SLOTS,
  TelegramWorkspaceSlotUnavailableError,
} from "./workspace-slots.ts";

export const TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS = 15_000;

export type TelegramBusWorkspaceAdmissionRunner =
  TelegramWorkspaceOperationRunner;

export interface TelegramBusLeaderRuntime<TContext> {
  runWorkspaceOperation?: TelegramBusWorkspaceAdmissionRunner;
  captureWorkspaceExternalProtection?: (
    binding: Threads.TelegramWorkspaceThreadBinding,
  ) => Threads.TelegramWorkspaceExternalProtectionEvidence;
  reconcileThreadDisplay?: () => Promise<{ changed: number }>;
  setThreadDisplayMode?: (mode: TelegramThreadDisplayMode) => Promise<void>;
  renameLeaderThread?: (
    threadName: string,
  ) => Promise<Threads.TelegramTopicTargetRecord>;
  startPolling: (ctx: TContext) => Promise<void>;
  stopPolling: () => Promise<void>;
  routeQueueHandoff: (
    input: TelegramBusLeaderQueueHandoffOffer,
  ) => Promise<TelegramBusEnvelope>;
}

export interface TelegramBusFollowerLifecycleAnnouncement {
  target: TelegramTarget & { threadId: number };
  text: string;
  parseMode: "HTML";
}

function formatTelegramBusInstanceLabel(input: {
  threadName?: string;
  slot?: string;
}): string {
  const threadName = input.threadName?.trim();
  if (threadName) return escapeHtml(threadName);
  return input.slot && /^[A-Z]$/.test(input.slot) ? input.slot : "?";
}

export interface TelegramBusLeaderTargetProvisionerDeps<TContext> {
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  getCwd?: (ctx: TContext) => string | undefined;
  getSessionId?: (ctx: TContext) => string | undefined;
  getTelegramProfile?: () => string | undefined;
  shouldForceFreshUnnamed?: () => boolean;
  getRequestedThreadName?: () => string | undefined;
  resolveInitialWorkspaceDisplayTitle?: (
    binding: Threads.TelegramWorkspaceDisplayBinding,
  ) => string | undefined;
  topicTargetStore: Threads.TelegramTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: () =>
    ThreadReconciler.ThreadReconciliationMachineState | undefined;
  recordThreadReconciliationPlan?: (
    plan: ThreadReconciler.ThreadReconciliationPlan,
  ) => void;
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  setLeaderTarget: (input: {
    target: TelegramTarget;
    slot?: string;
    threadName?: string;
  }) => void;
  onProvisioningStart?: () => void;
  onProvisioningEnd?: () => void;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  getNowMs?: () => number;
}

export interface TelegramBusFollowerTargetProvisionerDeps {
  getAllowedUserId: () => number | undefined;
  getLiveFollowers?: () => readonly TelegramBusFollowerView[];
  isFollowerProcessAlive?: (pid: number) => boolean;
  topicTargetStore: Threads.TelegramTopicTargetStore;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<TResponse>;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  onProvisioningStart?: () => void;
  onProvisioningEnd?: () => void;
  resolveInitialWorkspaceDisplayTitle?: (
    binding: Threads.TelegramWorkspaceDisplayBinding,
  ) => string | undefined;
  runWorkspaceOperation?: TelegramBusWorkspaceAdmissionRunner;
  getNowMs?: () => number;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusFollowerDisconnectHandlerDeps {
  topicTargetStore: Pick<
    Threads.TelegramTopicTargetStore,
    | "list"
    | "markStaleByTarget"
    | "persist"
    | "upsertPendingCleanup"
    | "removePendingCleanup"
  >;
  callApi: <TResponse>(
    method: string,
    body: Record<string, unknown>,
  ) => Promise<TResponse>;
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  getNowMs?: () => number;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramBusLeaderApiProxyDeps {
  call: (
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ) => Promise<unknown>;
  callMultipart: (
    method: string,
    fields: Record<string, string>,
    fieldName: string,
    filePath: string,
    fileName: string,
    options?: TelegramApiCallOptions,
  ) => Promise<unknown>;
  downloadFile: (
    fileId: string,
    suggestedName: string,
    source?: TelegramAttachmentSource,
  ) => Promise<unknown>;
  recoverStaleTargetError?: (
    apiBody: unknown,
    error: unknown,
  ) => Promise<unknown> | unknown;
}

export interface TelegramBusLeaderRuntimeAssemblyDeps<TContext> {
  getThreadDisplayMode?: () => TelegramThreadDisplayMode;
  persistThreadDisplayMode?: (
    mode: TelegramThreadDisplayMode,
    isCurrent: () => boolean,
  ) => Promise<void>;
  onThreadDisplayChanged?: () => void;
  runtime: Omit<
    TelegramBusLeaderRuntimeDeps<TContext>,
    | "callApi"
    | "onFollowerDisconnected"
    | "onFollowerConfirmedDead"
    | "onFollowerConfirmedDeadPreserved"
    | "getTelegramProfile"
    | "getAllowedUserId"
    | "provisionFollowerTarget"
    | "commitFollowerRegistration"
    | "provisionLeaderTarget"
    | "recordRuntimeEvent"
  >;
  getAllowedUserId: () => number | undefined;
  instanceId: string;
  getCwd?: (ctx: TContext) => string | undefined;
  getSessionId?: (ctx: TContext) => string | undefined;
  getTelegramProfile?: () => string | undefined;
  shouldForceFreshUnnamed?: () => boolean;
  getRequestedThreadName?: () => string | undefined;
  topicTargetStore: Threads.TelegramTopicTargetStore;
  callApi: TelegramBusLeaderTargetProvisionerDeps<TContext>["callApi"];
  callMultipart: TelegramBusLeaderApiProxyDeps["callMultipart"];
  downloadFile: TelegramBusLeaderApiProxyDeps["downloadFile"];
  recoverStaleTargetError?: TelegramBusLeaderApiProxyDeps["recoverStaleTargetError"];
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getThreadReconciliationMachineState?: TelegramBusLeaderTargetProvisionerDeps<TContext>["getThreadReconciliationMachineState"];
  recordThreadReconciliationPlan?: TelegramBusLeaderTargetProvisionerDeps<TContext>["recordThreadReconciliationPlan"];
  getSyncState: () => Sync.TelegramSyncState;
  setSyncState: (state: Sync.TelegramSyncState) => void;
  setLeaderTarget: TelegramBusLeaderTargetProvisionerDeps<TContext>["setLeaderTarget"];
  onProvisioningStart?: () => void;
  onProvisioningEnd?: () => void;
  recordRuntimeEvent: NonNullable<
    TelegramBusLeaderRuntimeDeps<TContext>["recordRuntimeEvent"]
  >;
  captureWorkspaceExternalProtection?: (
    binding: Threads.TelegramWorkspaceThreadBinding,
  ) => Threads.TelegramWorkspaceExternalProtectionEvidence;
  getWorkspaceAdmission?: () =>
    | Pick<
        TelegramWorkspaceAdmissionLedger,
        "acquireAdmission" | "releaseAdmission"
      >
    | undefined;
  runWorkspaceOperation?: TelegramBusWorkspaceAdmissionRunner;
  workspaceRotation?: TelegramWorkspaceSlotRotationPorts;
}

export type TelegramBusFollowerSessionReplacementOperation = (
  follower: TelegramBusFollowerView,
  intent: Threads.TelegramSessionReplacementIntent,
  isCurrent: () => boolean,
) => Promise<boolean>;

/**
 * Leader-owned durable session-replacement authority for registered followers.
 * Followers cannot persist `state.json`; the leader validates the request
 * against its live registry entry and authoritative Workspace binding before
 * one CAS publication or claim. Follower memory is never accepted as binding
 * evidence.
 */

/** Converts a throwing authority assertion into a liveness predicate. */
function doesAuthorityAssertionPass(assertAuthority: () => void): boolean {
  try {
    assertAuthority();
    return true;
  } catch {
    return false;
  }
}

export function createTelegramBusFollowerSessionReplacementAuthority(deps: {
  store: Pick<
    Threads.TelegramTopicTargetStore,
    | "load"
    | "getWorkspaceBindingByTarget"
    | "getSessionReplacementIntent"
    | "commitSessionReplacementIntent"
    | "removeSessionReplacementIntent"
  >;
  getTelegramProfile?: () => string | undefined;
  getNowMs?: () => number;
  ttlMs?: number;
}): {
  publish: TelegramBusFollowerSessionReplacementOperation;
  settle: TelegramBusFollowerSessionReplacementOperation;
} {
  const getNowMs = deps.getNowMs ?? Date.now;
  const ttlMs = deps.ttlMs ?? Threads.TELEGRAM_LEADER_SESSION_HANDOFF_TTL_MS;
  const assertCommon = (
    follower: TelegramBusFollowerView,
    intent: Threads.TelegramSessionReplacementIntent,
  ): { cwd: string; sessionId: string } => {
    const cwd = follower.cwd
      ? WorkspaceIdentity.normalizeTelegramWorkspacePath(follower.cwd)
      : undefined;
    const sessionId = follower.sessionId
      ? WorkspaceIdentity.normalizeTelegramSessionId(follower.sessionId)
      : undefined;
    const nowMs = getNowMs();
    if (
      intent.continuity !== "workspace-thread" ||
      typeof intent.target.threadId !== "number" ||
      follower.target?.chatId !== intent.target.chatId ||
      follower.target.threadId !== intent.target.threadId ||
      !cwd ||
      cwd !== intent.cwd ||
      !sessionId ||
      intent.profileName !== (deps.getTelegramProfile?.() ?? "default")
    ) {
      throw new Error(
        "Telegram session replacement does not match the current follower registration.",
      );
    }
    if (intent.expiresAtMs <= nowMs || intent.expiresAtMs > nowMs + ttlMs) {
      throw new Error(
        "Telegram session replacement intent is expired or unbounded.",
      );
    }
    return { cwd, sessionId };
  };
  return {
    async publish(follower, intent, isCurrent) {
      const { sessionId } = assertCommon(follower, intent);
      if (
        intent.sourceInstanceId !== follower.instanceId ||
        intent.sourceSessionId !== sessionId
      ) {
        throw new Error(
          "Telegram session replacement source does not match the current follower registration.",
        );
      }
      await deps.store.load();
      if (!isCurrent()) return false;
      const binding = deps.store.getWorkspaceBindingByTarget(intent.target);
      if (
        !binding ||
        binding.cwd !== intent.cwd ||
        binding.sessionId !== intent.sourceSessionId ||
        binding.slot !== intent.slot ||
        (binding.manualThreadName ?? binding.threadName) !== intent.threadName
      ) {
        throw new Error("Telegram session replacement binding is unavailable.");
      }
      return deps.store.commitSessionReplacementIntent(intent, isCurrent);
    },
    async settle(follower, intent, isCurrent) {
      const { sessionId } = assertCommon(follower, intent);
      if (
        !intent.sourceInstanceId ||
        (intent.sourceInstanceId !== follower.instanceId &&
          intent.sourceInstanceId !== follower.previousInstanceId) ||
        intent.sourceSessionId === sessionId
      ) {
        throw new Error(
          "Telegram session replacement successor does not match the current follower registration.",
        );
      }
      await deps.store.load();
      if (!isCurrent()) return false;
      if (
        deps.store.getWorkspaceBindingByTarget(intent.target, sessionId)
          ?.cwd !== intent.cwd
      ) {
        throw new Error(
          "Telegram session replacement successor binding is unavailable.",
        );
      }
      return deps.store.removeSessionReplacementIntent(intent, isCurrent);
    },
  };
}

export function createTelegramBusLeaderRuntimeAssembly<TContext>(
  deps: TelegramBusLeaderRuntimeAssemblyDeps<TContext>,
): TelegramBusLeaderRuntime<TContext> & {
  renameLeaderThreadAdmitted: (
    threadName: string,
    expectedTarget?: Threads.TelegramTopicTargetRecord["target"],
    assertRecipientAuthority?: () => void,
  ) => Promise<Threads.TelegramTopicTargetRecord>;
  resetLeaderThreadName: (
    expectedTarget: Threads.TelegramTopicTargetRecord["target"],
    assertRecipientAuthority?: () => void,
  ) => Promise<{ threadName: string }>;
  resetThreadNameAdmitted: (
    target: Threads.TelegramTopicTargetRecord["target"],
  ) => Promise<{ threadName: string }>;
} {
  const runWorkspaceAdmission: TelegramBusWorkspaceAdmissionRunner | undefined =
    deps.getWorkspaceAdmission
      ? (input, operation) => {
          const admission = deps.getWorkspaceAdmission?.();
          if (!admission) {
            throw new Error(
              "Telegram Workspace admission authority is unavailable.",
            );
          }
          return runWithTelegramWorkspaceAdmissionsAsync({
            ledger: admission,
            ...input,
            operation,
            onReleaseError(error) {
              deps.recordRuntimeEvent("bus", error, {
                phase: "workspace-admission-release",
                operationKind: input.operationKind,
              });
            },
          });
        }
      : undefined;
  const runWorkspaceOperation =
    deps.runWorkspaceOperation ??
    createTelegramWorkspaceOperationRuntime({
      getWorkspaceAdmission: deps.getWorkspaceAdmission,
      onReleaseError(error, operationKind) {
        deps.recordRuntimeEvent("bus", error, {
          phase: "workspace-admission-release",
          operationKind,
        });
      },
    }).run;
  const runWithWorkspaceCapacity =
    deps.workspaceRotation &&
    deps.captureWorkspaceExternalProtection &&
    deps.getCurrentLeaderEpoch
      ? createTelegramWorkspaceSlotRotation({
          ...deps.workspaceRotation,
          store: deps.topicTargetStore,
          getLeaderEpoch: deps.getCurrentLeaderEpoch,
          getExternalProtection: deps.captureWorkspaceExternalProtection,
          onSlotReused: (bindingKey, isCurrent) => display
            ? reconcileThreadDisplay(bindingKey, isCurrent).then(() => undefined)
            : Promise.resolve(),
          recordEvent(message, details) {
            deps.recordRuntimeEvent("bus", message, details);
          },
        })
      : undefined;
  const captureLiveBindingKeys = (
    bindings: readonly Threads.TelegramWorkspaceThreadBinding[],
  ): ReadonlySet<string> =>
    resolveTelegramLiveWorkspaceBindingKeys(
      bindings,
      deps.topicTargetStore.getActiveByInstanceId(deps.instanceId)?.target,
      deps.runtime.followerRegistry.list(),
    );
  const provisionerPorts = {
    getAllowedUserId: deps.getAllowedUserId,
    topicTargetStore: deps.topicTargetStore,
    callApi: deps.callApi,
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getSyncState: deps.getSyncState,
    setSyncState: deps.setSyncState,
    onProvisioningStart: deps.onProvisioningStart,
    onProvisioningEnd: deps.onProvisioningEnd,
    ...(deps.getThreadDisplayMode
      ? {
          resolveInitialWorkspaceDisplayTitle(
            binding: Threads.TelegramWorkspaceDisplayBinding,
          ) {
            return resolveTelegramInitialWorkspaceDisplayName({
              bindings: deps.topicTargetStore.listWorkspaceBindings(),
              binding,
              mode: deps.getThreadDisplayMode!(),
              liveBindingKeys: captureLiveBindingKeys(
                deps.topicTargetStore.listWorkspaceBindings(),
              ),
            });
          },
        }
      : {}),
    runWorkspaceOperation,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  };
  const display = deps.getThreadDisplayMode
    ? createTelegramThreadDisplayReconciler({
        store: deps.topicTargetStore,
        getMode: deps.getThreadDisplayMode,
        getProfileKey: () => deps.getTelegramProfile?.() ?? "default",
        getLeaderEpoch: () => deps.getCurrentLeaderEpoch?.(),
        captureLiveBindingKeys,
        captureBindingAuthority(binding) {
          const matches = (target: TelegramTarget | undefined) =>
            target?.chatId === binding.target.chatId &&
            target?.threadId === binding.target.threadId;
          const leader = deps.topicTargetStore.getActiveByInstanceId(
            deps.instanceId,
          );
          if (leader && matches(leader.target)) {
            return () =>
              matches(
                deps.topicTargetStore.getActiveByInstanceId(deps.instanceId)
                  ?.target,
              );
          }
          const follower = deps.runtime.followerRegistry.getByTarget(
            binding.target,
          );
          // Explicit retained repair is allowed without an owner; automatic passes select only live keys.
          // A live slotless binding must still retain its actual owner/generation fence above or below.
          if (!follower?.registrationGeneration) return binding.slot === undefined ? () => true : undefined;
          const generation = follower.registrationGeneration;
          return () => {
            const current = deps.runtime.followerRegistry.get(
              follower.instanceId,
            );
            return (
              current?.registrationGeneration === generation &&
              matches(current.target)
            );
          };
        },
        callApi: deps.callApi,
      })
    : undefined;
  const reconcileThreadDisplayOperation = async (bindingKey?: string, liveOnly = false) => {
    const result = await (liveOnly ? display!.reconcileLive() : display!.reconcile(bindingKey));
    deps.onThreadDisplayChanged?.();
    return result;
  };
  const reconcileThreadDisplay = (bindingKey?: string, isCurrent: () => boolean = () => true, liveOnly = false) =>
    runWorkspaceOperation(
      {
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind: "workspace.reconcile-display",
        scopes: [{ kind: "profile" }],
      },
      () => {
        if (!isCurrent()) throw new Error("Telegram Thread display update lost allocation authority.");
        return reconcileThreadDisplayOperation(bindingKey, liveOnly);
      },
    );
  let startupDisplayTimer: ReturnType<typeof setTimeout> | undefined;
  let startupDisplayGeneration = 0;
  let startupDisplaySettled = true;
  const cancelStartupDisplayStabilization = () => {
    startupDisplayGeneration += 1;
    startupDisplaySettled = true;
    if (startupDisplayTimer) clearTimeout(startupDisplayTimer);
    startupDisplayTimer = undefined;
  };
  const scheduleDisplay = () => {
    if (!display || !startupDisplaySettled) return;
    void reconcileThreadDisplay(undefined, () => true, true).catch((error) => {
      deps.recordRuntimeEvent("bus", error, {
        phase: "thread-display-reconcile",
      });
    });
  };
  /** Returns the stabilization this startup owns; a stop or a newer startup meanwhile makes it inert. */
  const beginStartupDisplayStabilization = (): number => {
    cancelStartupDisplayStabilization();
    startupDisplaySettled = false;
    return startupDisplayGeneration;
  };
  const armStartupDisplayReconciliation = (generation: number) => {
    if (startupDisplayGeneration !== generation) return;
    if (startupDisplayTimer) clearTimeout(startupDisplayTimer);
    const delayMs =
      deps.runtime.followerStaleAfterMs ?? TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS;
    startupDisplayTimer = setTimeout(() => {
      if (startupDisplayGeneration !== generation) return;
      startupDisplayTimer = undefined;
      startupDisplaySettled = true;
      scheduleDisplay();
    }, delayMs);
    startupDisplayTimer.unref?.();
  };
  let modeTail: Promise<void> = Promise.resolve();
  const applyThreadDisplayMode = (
    mode: TelegramThreadDisplayMode,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const epoch = deps.getCurrentLeaderEpoch?.();
    const profile = deps.getTelegramProfile?.();
    const current = () =>
      epoch !== undefined &&
      deps.getCurrentLeaderEpoch?.() === epoch &&
      deps.getTelegramProfile?.() === profile &&
      isCurrent();
    const run = modeTail.then(() =>
      runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.set-display-mode",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          if (!display || !deps.persistThreadDisplayMode || !current()) {
            throw new Error(
              "Telegram Thread display setting requires current leader authority.",
            );
          }
          const assertDisplayPeers = () => {
            const requiredCapability =
              mode === "directory-snake" || mode === "directory-title"
                ? TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT
                : TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE;
            if (
              mode !== "names" &&
              deps.runtime.followerRegistry
                .list()
                .some(
                  (follower) =>
                    !hasTelegramBusCapability(
                      follower.protocol,
                      requiredCapability,
                    ),
                )
            )
              throw new Error(
                "Update or restart all connected followers before changing Thread display mode.",
              );
          };
          assertDisplayPeers();
          await deps.persistThreadDisplayMode(mode, current);
          assertDisplayPeers();
          if (!current() || deps.getThreadDisplayMode?.() !== mode) {
            throw new Error(
              "Telegram Thread display preference changed before application.",
            );
          }
          await reconcileThreadDisplayOperation(undefined, true);
          if (!current() || deps.getThreadDisplayMode?.() !== mode) {
            throw new Error(
              "Telegram Thread display application lost its originating authority.",
            );
          }
        },
      ),
    );
    modeTail = run.catch(() => undefined);
    return run;
  };
  const provisionLeaderTarget = createTelegramBusLeaderTargetProvisioner({
    ...provisionerPorts,
    instanceId: deps.instanceId,
    getCwd: deps.getCwd,
    getSessionId: deps.getSessionId,
    getTelegramProfile: deps.getTelegramProfile,
    shouldForceFreshUnnamed: deps.shouldForceFreshUnnamed,
    getRequestedThreadName: deps.getRequestedThreadName,
    getThreadReconciliationMachineState:
      deps.getThreadReconciliationMachineState,
    recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
    setLeaderTarget: deps.setLeaderTarget,
  });
  const disconnectFollower = createTelegramBusFollowerDisconnectHandler({
    ...provisionerPorts,
  });
  const cleanupConfirmedDeadFollower =
    createTelegramBusFollowerConfirmedDeadHandler({
      ...provisionerPorts,
    });
  const provisionFollowerTarget = createTelegramBusFollowerTargetProvisioner({
    ...provisionerPorts,
    getLiveFollowers: deps.runtime.followerRegistry.list,
    isFollowerProcessAlive: deps.runtime.isFollowerProcessAlive,
  });
  const renameLeaderThreadAdmitted = async (
    threadName: string,
    expectedTarget?: Threads.TelegramTopicTargetRecord["target"],
    assertRecipientAuthority?: () => void,
  ) => {
    const store = deps.topicTargetStore,
      callApi = deps.callApi;
    const publishName = store.renameByTargetAndPersist.bind(store);
    const persist = store.persist.bind(store);
    const instanceId = deps.instanceId;
    const getProfile = deps.getTelegramProfile,
      getUser = deps.getAllowedUserId;
    const getEpoch = deps.getCurrentLeaderEpoch;
    const profile = getProfile?.(),
      user = getUser();
    const recipientAuthority = assertRecipientAuthority;
    recipientAuthority?.();
    const leaderEpoch = getEpoch?.();
    if (getEpoch && leaderEpoch === undefined) {
      throw new Error(
        "Telegram Workspace Thread rename requires leader ownership.",
      );
    }
    const record = Threads.findCurrentTelegramInstanceThreadRecord({
      records: store.list(),
      instanceId,
    });
    if (typeof record?.target.threadId !== "number") {
      throw new Error("No Workspace Thread is bound to this Pi instance.");
    }
    if (
      expectedTarget &&
      (record.target.chatId !== expectedTarget.chatId ||
        record.target.threadId !== expectedTarget.threadId)
    ) {
      throw new Error("Telegram Workspace Thread rename target changed.");
    }
    const target = { ...record.target },
      slot = record.slot,
      owner = structuredClone(record.owner);
    const bindingIdentity = (
      binding: Threads.TelegramWorkspaceThreadBinding,
    ) => ({
      bindingKey: binding.bindingKey,
      cwd: binding.cwd,
      workspaceKey: binding.workspaceKey,
      sessionId: binding.sessionId,
      sessionKey: binding.sessionKey,
      instanceSlot: binding.instanceSlot,
      slot: binding.slot,
      target: { ...binding.target },
    });
    const bindings = store
      .listWorkspaceBindings()
      .filter(
        (binding) =>
          binding.target.chatId === target.chatId &&
          binding.target.threadId === target.threadId,
      );
    if (
      recipientAuthority &&
      (bindings.length !== 1 ||
        !bindings[0]?.sessionId ||
        bindings[0].slot !== slot)
    )
      throw new Error(
        "Telegram Workspace Thread rename recipient binding authority is unavailable.",
      );
    const capturedBindings = bindings.map(bindingIdentity);
    const assertAuthority = () => {
      recipientAuthority?.();
      if (
        (getEpoch && getEpoch() !== leaderEpoch) ||
        getProfile?.() !== profile ||
        getUser() !== user ||
        deps.topicTargetStore !== store ||
        deps.instanceId !== instanceId
      )
        throw new Error(
          "Telegram Workspace Thread rename lost leader ownership.",
        );
      const current = Threads.findCurrentTelegramInstanceThreadRecord({
        records: store.list(),
        instanceId,
      });
      const currentBindings = store
        .listWorkspaceBindings()
        .filter(
          (binding) =>
            binding.target.chatId === target.chatId &&
            binding.target.threadId === target.threadId,
        )
        .map(bindingIdentity);
      if (
        current?.target.chatId !== target.chatId ||
        current.target.threadId !== target.threadId ||
        current.slot !== slot ||
        current.status !== record.status ||
        !isDeepStrictEqual(current.owner, owner) ||
        !isDeepStrictEqual(currentBindings, capturedBindings)
      )
        throw new Error(
          "Telegram Workspace Thread rename target changed or binding authority was lost.",
        );
    };
    assertAuthority();
    const current = () => doesAuthorityAssertionPass(assertAuthority);
    const rename = Threads.createTelegramTopicTargetRenamer({
      store: recipientAuthority
        ? {
            list: store.list.bind(store),
            listWorkspaceBindings: store.listWorkspaceBindings.bind(store),
            listPendingProvisions: store.listPendingProvisions.bind(store),
            renameByTarget: (target, name, options) =>
              publishName(
                target,
                name,
                { updateDisplayTitle: options?.updateDisplayTitle ?? true },
                current,
              ),
          }
        : store,
      callApi,
      assertAuthority,
    });
    const renamed = await rename({ target, threadName, slot });
    assertAuthority();
    if (!renamed) {
      throw new Error(
        ThreadNaming.getTelegramTopicThreadNameValidationError(
          threadName,
          slot,
        ) ?? "Telegram Workspace Thread name is already reserved.",
      );
    }
    if (!recipientAuthority) await persist(current);
    assertAuthority();
    return renamed;
  };
  const prepareThreadNameReset = (
    expectedTarget: Threads.TelegramTopicTargetRecord["target"],
    assertTargetCurrent: () => void,
    assertRecipientAuthority?: () => void,
  ): (() => Promise<{ threadName: string }>) => {
    const target = { ...expectedTarget },
      store = deps.topicTargetStore,
      callApi = deps.callApi;
    const publishReset = store.clearManualNameByTargetAndPersist.bind(store);
    const clearManualName = store.clearManualNameByTarget.bind(store),
      persist = store.persist.bind(store);
    const getEpoch = deps.getCurrentLeaderEpoch,
      getProfile = deps.getTelegramProfile;
    const getUser = deps.getAllowedUserId,
      getMode = deps.getThreadDisplayMode;
    const recipientAuthority = assertRecipientAuthority,
      targetAuthority = assertTargetCurrent;
    recipientAuthority?.();
    const leaderEpoch = getEpoch?.(),
      profile = getProfile?.(),
      user = getUser(),
      instanceId = deps.instanceId;
    const mode = getMode?.() ?? "letters";
    if (getEpoch && leaderEpoch === undefined) {
      throw new Error(
        "Telegram Workspace Thread reset requires leader ownership.",
      );
    }
    const matchingBindings = () =>
      store
        .listWorkspaceBindings()
        .filter(
          (candidate) =>
            candidate.target.chatId === target.chatId &&
            candidate.target.threadId === target.threadId,
        );
    const bindings = matchingBindings(),
      binding = bindings[0];
    if (!binding)
      throw new Error("No Workspace Thread binding is available to reset.");
    const record = Threads.findCurrentTelegramInstanceThreadRecord({
      records: store.list(),
      instanceId,
    });
    if (
      recipientAuthority &&
      (bindings.length !== 1 ||
        !binding.sessionId ||
        record?.status !== "active" ||
        record.owner?.kind !== "leader" ||
        record.owner.cwd !== binding.cwd ||
        record.target.chatId !== target.chatId ||
        record.target.threadId !== target.threadId ||
        record.slot !== binding.slot)
    )
      throw new Error(
        "Telegram Workspace Thread reset recipient binding authority is unavailable.",
      );
    const bindingIdentity = (
      value: Threads.TelegramWorkspaceThreadBinding,
    ) => ({
      bindingKey: value.bindingKey,
      cwd: value.cwd,
      workspaceKey: value.workspaceKey,
      sessionId: value.sessionId,
      sessionKey: value.sessionKey,
      instanceSlot: value.instanceSlot,
      slot: value.slot,
      target: { ...value.target },
    });
    const capturedBinding = bindingIdentity(binding),
      owner = record && structuredClone(record.owner);
    const resolveTitle = (value: Threads.TelegramWorkspaceThreadBinding) =>
      resolveTelegramInitialWorkspaceDisplayName({
        bindings: store.listWorkspaceBindings(),
        binding: { ...value, manualThreadName: undefined },
        mode,
        preserveRetainedManualName: false,
      });
    const automaticTitle = resolveTitle(binding);
    if (!automaticTitle)
      throw new Error("Telegram Workspace automatic title is unavailable.");
    const assertAuthority = () => {
      recipientAuthority?.();
      if (getEpoch && getEpoch() !== leaderEpoch)
        throw new Error(
          "Telegram Workspace Thread reset lost leader ownership.",
        );
      targetAuthority();
      if (!recipientAuthority) return;
      if (
        getProfile?.() !== profile ||
        getUser() !== user ||
        deps.topicTargetStore !== store ||
        deps.instanceId !== instanceId
      )
        throw new Error(
          "Telegram Workspace Thread reset lost recipient authority.",
        );
      const currentRecord = Threads.findCurrentTelegramInstanceThreadRecord({
        records: store.list(),
        instanceId,
      });
      const currentBindings = matchingBindings();
      if (
        currentRecord?.target.chatId !== target.chatId ||
        currentRecord.target.threadId !== target.threadId ||
        currentRecord.slot !== record!.slot ||
        currentRecord.status !== record!.status ||
        !isDeepStrictEqual(currentRecord.owner, owner) ||
        currentBindings.length !== 1 ||
        !isDeepStrictEqual(
          bindingIdentity(currentBindings[0]!),
          capturedBinding,
        )
      )
        throw new Error(
          "Telegram Workspace Thread reset target changed or binding authority was lost.",
        );
      if (
        (getMode?.() ?? "letters") !== mode ||
        resolveTitle(currentBindings[0]!) !== automaticTitle
      )
        throw new Error("Telegram Workspace automatic-title policy changed.");
    };
    assertAuthority();
    const current = () => doesAuthorityAssertionPass(assertAuthority);
    return async () => {
      assertAuthority();
      const body = {
        chat_id: target.chatId,
        message_thread_id: target.threadId,
        name: automaticTitle,
      };
      if (recipientAuthority)
        await callApi("editForumTopic", body, { assertAuthority });
      else await callApi("editForumTopic", body);
      assertAuthority();
      if (
        recipientAuthority &&
        (!isDeepStrictEqual(matchingBindings()[0], binding) ||
          !isDeepStrictEqual(
            Threads.findCurrentTelegramInstanceThreadRecord({
              records: store.list(),
              instanceId,
            }),
            record,
          ))
      )
        throw new Error(
          "Telegram Workspace Thread reset metadata changed before publication.",
        );
      const reset = recipientAuthority
        ? await publishReset(target, automaticTitle, current)
        : clearManualName(target, automaticTitle);
      if (!reset)
        throw new Error("Telegram Workspace Thread reset changed binding.");
      if (!recipientAuthority) await persist();
      assertAuthority();
      if (
        recipientAuthority &&
        (reset.manualThreadName !== undefined ||
          matchingBindings()[0]?.manualThreadName !== undefined ||
          matchingBindings()[0]?.displayTitle !== automaticTitle ||
          store.getActiveByInstanceId(instanceId)?.manualThreadName !==
            undefined)
      )
        throw new Error(
          "Telegram Workspace Thread reset result metadata changed.",
        );
      return { threadName: automaticTitle };
    };
  };
  const resetThreadNameAdmitted = async (
    target: Threads.TelegramTopicTargetRecord["target"],
    assertTargetCurrent: () => void = () => undefined,
  ): Promise<{ threadName: string }> =>
    prepareThreadNameReset(target, assertTargetCurrent)();
  const renameLeaderThread = async (threadName: string) => {
    const getEpoch = deps.getCurrentLeaderEpoch,
      getProfile = deps.getTelegramProfile;
    const getUser = deps.getAllowedUserId,
      store = deps.topicTargetStore;
    const epoch = getEpoch?.(),
      profile = getProfile?.(),
      user = getUser();
    return runWorkspaceOperation(
      {
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind: "workspace.rename-leader",
        scopes: [{ kind: "profile" }],
      },
      () => {
        if (
          getEpoch?.() !== epoch ||
          getProfile?.() !== profile ||
          getUser() !== user ||
          deps.topicTargetStore !== store
        )
          throw new Error(
            "Telegram Workspace Thread rename lost leader ownership during admission.",
          );
        return renameLeaderThreadAdmitted(threadName);
      },
    );
  };
  const resetLeaderThreadName = async (
    expectedTarget: Threads.TelegramTopicTargetRecord["target"],
    assertRecipientAuthority?: () => void,
  ): Promise<{ threadName: string }> => {
    const target = { ...expectedTarget },
      store = deps.topicTargetStore,
      instanceId = deps.instanceId;
    const assertTargetCurrent = () => {
      const record = Threads.findCurrentTelegramInstanceThreadRecord({
        records: store.list(),
        instanceId,
      });
      if (!record || typeof record.target.threadId !== "number")
        throw new Error("No Workspace Thread is bound to this Pi instance.");
      if (
        record.target.chatId !== target.chatId ||
        record.target.threadId !== target.threadId
      )
        throw new Error("Telegram Workspace Thread reset target changed.");
    };
    // Selected lifetimes are captured before admission; ordinary reset keeps its post-admission preparation.
    const prepared = assertRecipientAuthority
      ? prepareThreadNameReset(
          target,
          assertTargetCurrent,
          assertRecipientAuthority,
        )
      : undefined;
    return runWorkspaceOperation(
      {
        operationId: createTelegramWorkspaceAdmissionOperationId(),
        operationKind: "workspace.reset-leader-name",
        scopes: [{ kind: "profile" }],
      },
      () => {
        assertTargetCurrent();
        return prepared
          ? prepared()
          : resetThreadNameAdmitted(target, assertTargetCurrent);
      },
    );
  };
  const followerSessionReplacement =
    createTelegramBusFollowerSessionReplacementAuthority({
      store: deps.topicTargetStore,
      getTelegramProfile: deps.getTelegramProfile,
      getNowMs: deps.runtime.getNowMs,
    });
  const runtime = createTelegramBusLeaderRuntime({
    ...deps.runtime,
    applyThreadDisplayMode,
    getThreadDisplayMode: deps.getThreadDisplayMode,
    onFollowerRegistered: scheduleDisplay,
    provisionLeaderTarget: (ctx) => {
      const chatId = deps.getAllowedUserId();
      const provision = () =>
        runWorkspaceOperation(
          {
            operationId: `leader-provision:${deps.instanceId}`,
            operationKind: "workspace.provision-leader",
            scopes: [
              typeof chatId === "number"
                ? { kind: "chat", chatId }
                : { kind: "profile" },
            ],
          },
          () => provisionLeaderTarget(ctx),
        );
      return runWithWorkspaceCapacity
        ? runWithWorkspaceCapacity(provision)
        : provision();
    },
    getThreadCapability() {
      const mode = deps.topicTargetStore.getBotState().threadMode;
      return mode === "enabled" ? true : mode === "disabled" ? false : undefined;
    },
    getFollowerDisplayTitle(follower) {
      const binding = deps.topicTargetStore
        .listWorkspaceBindings()
        .find(
          (binding) =>
            binding.target.chatId === follower.target?.chatId &&
            binding.target.threadId === follower.target?.threadId,
        );
      return binding?.displayTitle ?? binding?.threadName;
    },
    onFollowerDisconnected: async (follower) => {
      await runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.disconnect-follower",
          scopes: [{ kind: "profile" }],
        },
        () => disconnectFollower(follower),
      );
      scheduleDisplay();
    },
    async renameFollowerThread(follower, threadName) {
      return runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.rename-follower",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          const leaderEpoch = deps.getCurrentLeaderEpoch?.();
          if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
            throw new Error(
              "Telegram Workspace Thread rename requires leader ownership.",
            );
          }
          if (typeof follower.target?.threadId !== "number") {
            throw new Error("Telegram follower has no bound Workspace Thread.");
          }
          const rename = Threads.createTelegramTopicTargetRenamer({
            store: deps.topicTargetStore,
            callApi: deps.callApi,
            assertAuthority() {
              if (
                deps.getCurrentLeaderEpoch &&
                deps.getCurrentLeaderEpoch() !== leaderEpoch
              ) {
                throw new Error(
                  "Telegram Workspace Thread rename lost leader ownership.",
                );
              }
              const current = deps.runtime.followerRegistry.get(
                follower.instanceId,
              );
              if (
                current?.registrationGeneration !==
                  follower.registrationGeneration ||
                current?.target?.chatId !== follower.target?.chatId ||
                current?.target?.threadId !== follower.target?.threadId
              ) {
                throw new Error(
                  "Telegram follower Workspace Thread target changed.",
                );
              }
            },
          });
          const renamed = await rename({
            target: {
              chatId: follower.target.chatId,
              threadId: follower.target.threadId,
            },
            threadName,
            slot: follower.slot,
          });
          if (
            deps.getCurrentLeaderEpoch &&
            deps.getCurrentLeaderEpoch() !== leaderEpoch
          ) {
            throw new Error(
              "Telegram Workspace Thread rename lost leader ownership.",
            );
          }
          if (!renamed) {
            throw new Error(
              ThreadNaming.getTelegramTopicThreadNameValidationError(
                threadName,
                follower.slot,
              ) ?? "Telegram Workspace Thread name is already reserved.",
            );
          }
          await deps.topicTargetStore.persist();
          return { threadName: renamed.manualThreadName ?? threadName };
        },
      );
    },
    resetFollowerThreadName: (follower) =>
      runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.reset-follower-name",
          scopes: [{ kind: "profile" }],
        },
        () => {
          if (
            !follower.target ||
            typeof follower.target.threadId !== "number"
          ) {
            throw new Error("Telegram follower has no bound Workspace Thread.");
          }
          const target = {
            chatId: follower.target.chatId,
            threadId: follower.target.threadId,
          };
          return resetThreadNameAdmitted(target, () => {
            const current = deps.runtime.followerRegistry.get(
              follower.instanceId,
            );
            if (
              current?.registrationGeneration !==
                follower.registrationGeneration ||
              current?.target?.chatId !== target.chatId ||
              current?.target?.threadId !== target.threadId
            ) {
              throw new Error(
                "Telegram follower Workspace Thread target changed.",
              );
            }
          });
        },
      ),
    publishFollowerSessionReplacement: (follower, intent, isCurrent) =>
      runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.publish-follower-session-replacement",
          scopes: [{ kind: "profile" }],
        },
        () => followerSessionReplacement.publish(follower, intent, isCurrent),
      ),
    settleFollowerSessionReplacement: (follower, intent, isCurrent) =>
      runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.settle-follower-session-replacement",
          scopes: [{ kind: "profile" }],
        },
        () => followerSessionReplacement.settle(follower, intent, isCurrent),
      ),
    onFollowerConfirmedDead: async (follower) => {
      await runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.cleanup-dead-follower",
          scopes: [{ kind: "profile" }],
        },
        () => cleanupConfirmedDeadFollower(follower),
      );
      scheduleDisplay();
    },
    async onFollowerConfirmedDeadPreserved(follower, isDetached, operationId) {
      const epoch = deps.getCurrentLeaderEpoch?.();
      const profile = deps.getTelegramProfile?.();
      if (
        epoch === undefined ||
        !follower.registrationGeneration ||
        typeof follower.target?.threadId !== "number"
      )
        return false;
      const isCurrent = () =>
        isDetached() &&
        deps.getCurrentLeaderEpoch?.() === epoch &&
        deps.getTelegramProfile?.() === profile;
      if (!isCurrent()) return false;
      const settled = await runWorkspaceOperation(
        {
          operationId,
          operationKind: "workspace.preserve-dead-follower",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          if (!isCurrent()) return false;
          await deps.topicTargetStore.load();
          if (!isCurrent()) return false;
          const record = deps.topicTargetStore.getActiveByInstanceId(
            follower.instanceId,
          );
          if (
            !record ||
            (follower.profileKey &&
              record.profileKey !== follower.profileKey) ||
            record.target.chatId !== follower.target!.chatId ||
            record.target.threadId !== follower.target!.threadId
          )
            return true;
          const committed = await deps.topicTargetStore.detachTargetOwner(
            record,
            isCurrent,
          );
          if (!committed && isCurrent()) {
            throw new Error(
              "Telegram preserved follower detachment was not committed.",
            );
          }
          return committed;
        },
      );
      if (settled && isCurrent()) scheduleDisplay();
      return settled;
    },
    provisionFollowerTarget: (registration, options) =>
      runWorkspaceOperation(
        {
          operationId: `follower-provision:${registration.instanceId}:${registration.registrationGeneration}`,
          operationKind: "workspace.provision-follower",
          scopes: [{ kind: "profile" }],
        },
        () => provisionFollowerTarget(registration, options),
      ),
    commitFollowerRegistration: (input, publish) =>
      runWorkspaceOperation(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.publish-follower-registration",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          if (!input.target) {
            publish();
            return;
          }
          await deps.topicTargetStore.load();
          const binding =
            input.registration.cwd && input.registration.sessionId
              ? deps.topicTargetStore.getWorkspaceBindingByTarget(
                  input.target,
                  input.registration.sessionId,
                )
              : undefined;
          const bindingKey =
            binding &&
            input.registration.cwd &&
            binding.cwd ===
              WorkspaceIdentity.normalizeTelegramWorkspacePath(
                input.registration.cwd,
              )
              ? binding.bindingKey
              : undefined;
          if (
            input.target.threadId !== undefined &&
            input.registration.cwd &&
            input.registration.sessionId &&
            !bindingKey
          )
            throw new Error(
              "Telegram follower Workspace binding changed before registration publication.",
            );
          deps.topicTargetStore.commitWorkspaceRestoreRegistration(
            { target: input.target, slot: input.slot, bindingKey },
            publish,
          );
        },
      ),
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getTelegramProfile: deps.getTelegramProfile,
    getAllowedUserId: deps.getAllowedUserId,
    runWorkspaceAdmission,
    runWithWorkspaceCapacity,
    callApi: createTelegramBusLeaderApiProxy({
      call: deps.callApi,
      callMultipart: deps.callMultipart,
      downloadFile: deps.downloadFile,
      recoverStaleTargetError: deps.recoverStaleTargetError,
    }),
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const assembled = {
    ...runtime,
    runWorkspaceOperation,
    renameLeaderThread,
    renameLeaderThreadAdmitted,
    resetLeaderThreadName,
    resetThreadNameAdmitted,
    captureWorkspaceExternalProtection: deps.captureWorkspaceExternalProtection,
    async startPolling(ctx: TContext) {
      const stabilization = display
        ? beginStartupDisplayStabilization()
        : undefined;
      try {
        await runtime.startPolling(ctx);
      } catch (error) {
        if (stabilization === startupDisplayGeneration)
          cancelStartupDisplayStabilization();
        throw error;
      }
      if (stabilization !== undefined)
        armStartupDisplayReconciliation(stabilization);
    },
    async stopPolling() {
      cancelStartupDisplayStabilization();
      await runtime.stopPolling();
    },
  };
  if (!display) return assembled;
  return {
    ...assembled,
    reconcileThreadDisplay,
    setThreadDisplayMode: (mode) => applyThreadDisplayMode(mode, () => true),
  };
}

export interface TelegramBusFollowerMessageOwnershipRecord {
  follower: TelegramBusFollowerView;
  chatId: number;
  messageId: number;
  target?: TelegramTarget;
}

export type TelegramBusFollowerMessageOwnershipRecorder = (
  record: TelegramBusFollowerMessageOwnershipRecord,
) => void;

export type TelegramBusFollowerRegistrationCommitter = (
  input: {
    registration: TelegramBusInstanceRegistration;
    target?: TelegramTarget;
    slot?: string;
  },
  publish: () => void,
) => Promise<void> | void;

export interface TelegramBusLeaderRuntimeDeps<TContext> extends Omit<
  TelegramBusLeaderEnvelopeHandlerDeps,
  "runFollowerMutation" | "getWorkspaceRestoreObservationGeneration"
> {
  socketPath: TelegramBusSocketPathSource;
  commitEndpointPublication?: (commit: () => void) => boolean;
  startPolling: (ctx: TContext) => void | Promise<void>;
  stopPolling: () => void | Promise<void>;
  provisionLeaderTarget?: (ctx: TContext) => Promise<void> | void;
  followerPruneIntervalMs?: number;
  /** Leader housekeeping after each current prune pass; throttling is the callee's concern. */
  afterFollowerPrune?: () => void;
  followerStaleAfterMs?: number;
  isFollowerProcessAlive?: (pid: number) => boolean;
  shouldCleanupConfirmedDeadFollower?: () => Promise<boolean> | boolean;
  onFollowerConfirmedDead?: (
    follower: TelegramBusFollowerView,
  ) => Promise<void> | void;
  /** True settles this observation; false needs fresh proof before another attempt. */
  onFollowerConfirmedDeadPreserved?: (
    follower: TelegramBusFollowerView,
    isDetached: () => boolean,
    operationId: string,
  ) => Promise<boolean> | boolean;
}

export function createTelegramBusInstanceLifecycleAnnouncement(input: {
  target: TelegramTarget & { threadId: number };
  threadName?: string;
  slot?: string;
  state: "connected";
}): TelegramBusFollowerLifecycleAnnouncement {
  return {
    target: { ...input.target },
    text: `<b>📡 Instance <i>${formatTelegramBusInstanceLabel(input)}</i> ${input.state}.</b>`,
    parseMode: "HTML",
  };
}

const TELEGRAM_BUS_SLOW_FOLLOWER_REGISTRATION_MS = 1000;

function scheduleTelegramBusLeaderBackgroundTask(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const timer = setTimeout(() => {
    void task().catch((error) => {
      try {
        onError(error);
      } catch {
        // Background diagnostics cannot create an unhandled timer rejection.
      }
    });
  }, 0);
  timer.unref?.();
}

function recordSlowTelegramBusFollowerRegistrationStep(
  deps: Pick<TelegramBusFollowerTargetProvisionerDeps, "recordRuntimeEvent">,
  input: {
    phase: string;
    elapsedMs: number;
    instanceId: string;
    target?: TelegramTarget;
    reused?: boolean;
  },
): void {
  if (input.elapsedMs < TELEGRAM_BUS_SLOW_FOLLOWER_REGISTRATION_MS) return;
  deps.recordRuntimeEvent(
    "bus",
    `Telegram bus follower registration step was slow (${input.elapsedMs}ms).`,
    {
      phase: input.phase,
      elapsedMs: input.elapsedMs,
      instanceId: input.instanceId,
      reused: input.reused,
      chatId: input.target?.chatId,
      threadId: input.target?.threadId,
    },
  );
}

export function createTelegramBusFollowerTargetProvisioner(
  deps: TelegramBusFollowerTargetProvisionerDeps,
): (
  registration: TelegramBusInstanceRegistration,
  options?: { existingWorkspaceBindingOnly?: boolean; recoverConnection?: boolean },
) => Promise<
  (TelegramTarget & { slot?: string; threadName?: string }) | undefined
> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const pendingRegistrations = new Map<
    string,
    Promise<
      (TelegramTarget & { slot?: string; threadName?: string }) | undefined
    >
  >();
  return async (registration, options) => {
    if (options?.existingWorkspaceBindingOnly && !registration.cwd) {
      return undefined;
    }
    const registrationStartedAtMs = Date.now();
    const chatId = deps.getAllowedUserId();
    if (typeof chatId !== "number") return registration.target;
    await deps.topicTargetStore.load();
    if (options?.recoverConnection && !options.existingWorkspaceBindingOnly) {
      const epoch = deps.getCurrentLeaderEpoch?.();
      await Threads.resetTelegramConnectionProvisioning({
        store: deps.topicTargetStore, owner: "manual-follower", instanceId: registration.instanceId,
        profileKey: registration.profileKey ?? `manual:${registration.instanceId}`,
        isCurrent: () => !deps.getCurrentLeaderEpoch ||
          (epoch !== undefined && deps.getCurrentLeaderEpoch() === epoch),
        recordEvent: deps.recordRuntimeEvent,
      });
    }
    let restoredPredecessor: Threads.TelegramTopicTargetRecord | undefined;
    if (options?.existingWorkspaceBindingOnly && registration.cwd && registration.sessionId &&
        !registration.previousInstanceId && deps.getLiveFollowers && deps.isFollowerProcessAlive) {
      const identity = Threads.createTelegramWorkspaceBindingIdentity(registration.cwd, 0, registration.sessionId);
      const records = deps.topicTargetStore.list(), liveFollowers = deps.getLiveFollowers();
      const candidates = deps.topicTargetStore.listWorkspaceBindings()
        .filter(binding => identity && binding.cwd === identity.cwd && binding.sessionId === identity.sessionId &&
          (!registration.target || (binding.target.chatId === registration.target.chatId && binding.target.threadId === registration.target.threadId)))
        .flatMap(binding => {
          const matches = records.filter(record => record.status === "active" && record.owner?.kind === "manual-follower" &&
            record.target.chatId === binding.target.chatId && record.target.threadId === binding.target.threadId);
          return matches.length === 1 ? matches : [];
        })
        .filter(record => {
          if (liveFollowers.some(peer => peer.instanceId === record.instanceId ||
            (peer.target?.chatId === record.target.chatId && peer.target.threadId === record.target.threadId))) return false;
          // A retained status is not current execution proof. Only an absent actual runtime PID grants this claim handoff.
          const match = /^([1-9][0-9]*):[0-9]+$/.exec(record.instanceId ?? ""), pid = match ? Number(match[1]) : undefined;
          if (pid === undefined || !Number.isSafeInteger(pid)) return false;
          try { return deps.isFollowerProcessAlive!(pid) === false; } catch { return false; }
        });
      if (candidates.length === 1) restoredPredecessor = candidates[0];
    }
    // A new session in a folder whose previous session is gone takes over that Thread: the tab keeps a single
    // owner and the retired binding is re-keyed instead of being left behind as an orphan.
    if (
      !restoredPredecessor &&
      registration.cwd &&
      registration.sessionId &&
      !registration.previousInstanceId &&
      deps.getLiveFollowers &&
      deps.isFollowerProcessAlive
    ) {
      const identity = Threads.createTelegramWorkspaceBindingIdentity(
        registration.cwd,
        0,
        registration.sessionId,
      );
      const liveFollowers = deps.getLiveFollowers();
      const candidates = deps.topicTargetStore
        .listWorkspaceBindings()
        .filter(
          (binding) =>
            !!(
              identity &&
              binding.cwd === identity.cwd &&
              binding.sessionId !== identity.sessionId
            ),
        )
        .flatMap((binding) => {
          const matches = deps.topicTargetStore
            .list()
            .filter(
              (record) =>
                record.status === "active" &&
                record.owner?.kind === "manual-follower" &&
                record.target.chatId === binding.target.chatId &&
                record.target.threadId === binding.target.threadId,
            );
          return matches.length === 1
            ? [{ binding, record: matches[0]! }]
            : [];
        })
        .filter(({ record }) => {
          if (
            liveFollowers.some(
              (peer) =>
                peer.instanceId === record.instanceId ||
                (peer.target?.chatId === record.target.chatId &&
                  peer.target.threadId === record.target.threadId),
            )
          )
            return false;
          const match = /^([1-9][0-9]*):[0-9]+$/.exec(record.instanceId ?? ""),
            pid = match ? Number(match[1]) : undefined;
          if (pid === undefined || !Number.isSafeInteger(pid)) return false;
          try {
            return deps.isFollowerProcessAlive!(pid) === false;
          } catch {
            return false;
          }
        });
      // Ambiguity keeps ordinary provisioning: never guess which retained tab a new session inherits.
      if (candidates.length === 1 && identity?.sessionId) {
        const candidate = candidates[0]!;
        if (
          candidate.binding.sessionId &&
          deps.topicTargetStore.adoptWorkspaceThreadBindingForSession(
            candidate.binding.cwd,
            candidate.binding.sessionId,
            identity.sessionId,
            candidate.binding.target,
          )
        )
          restoredPredecessor = candidate.record;
      }
    }
    let capacityUnavailable = false;
    const workspaceIdentity = registration.cwd
      ? deps.topicTargetStore.claimWorkspaceIdentity(
          registration.cwd,
          registration.instanceId,
          registration.previousInstanceId ?? restoredPredecessor?.instanceId,
          {
            existingBindingOnly: options?.existingWorkspaceBindingOnly === true,
            sessionId: registration.sessionId,
            sessionHandoff: registration.previousInstanceId !== undefined,
            provisionProfileKey: registration.profileKey ?? `manual:${registration.instanceId}`,
            onCapacityUnavailable() {
              capacityUnavailable = true;
            },
          },
        )
      : undefined;
    if (registration.cwd && !workspaceIdentity) {
      if (options?.existingWorkspaceBindingOnly) return undefined;
      if (capacityUnavailable) {
        throw new TelegramWorkspaceSlotUnavailableError();
      }
      throw new Error("Telegram Workspace identity is already claimed.");
    }
    const workspaceBinding = workspaceIdentity
      ? deps.topicTargetStore.getWorkspaceBinding(
          workspaceIdentity.cwd,
          workspaceIdentity.instanceSlot,
          workspaceIdentity.sessionId,
        )
      : undefined;
    const provision = Threads.createTelegramTopicTargetProvisioner({
      topicChatId: chatId,
      store: deps.topicTargetStore,
      getNowMs,
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      callApi: deps.callApi,
      // Manual follower registration should create a visible fresh topic unless
      // the same profile key already has a known live/reusable binding. Do not
      // silently claim old offline/failed tabs: they may be closed/deleted in
      // Telegram and therefore invisible to the operator.
      claimPendingTargets: false,
      resolveInitialWorkspaceDisplayTitle:
        deps.resolveInitialWorkspaceDisplayTitle,
    });
    const recordsBeforeProvision = deps.topicTargetStore.list();
    const followerProfileKey =
      registration.profileKey ?? `manual:${registration.instanceId}`;
    const requestedTarget = registration.target ?? workspaceBinding?.target;
    const reconnectRecord = recordsBeforeProvision.find((record) => {
      const matchesRequestedTarget =
        !requestedTarget ||
        (record.target.chatId === requestedTarget.chatId &&
          record.target.threadId === requestedTarget.threadId);
      const matchesCurrentIdentity =
        record.instanceId === registration.instanceId ||
        record.profileKey === followerProfileKey;
      const matchesSessionHandoff =
        !!requestedTarget &&
        !!registration.previousInstanceId &&
        record.instanceId === registration.previousInstanceId &&
        matchesRequestedTarget;
      const matchesWorkspaceRecovery =
        !!workspaceBinding &&
        record.status === "probe-required" &&
        matchesRequestedTarget;
      return (
        record.owner?.kind === "manual-follower" &&
        ((matchesCurrentIdentity && matchesRequestedTarget) ||
          matchesSessionHandoff ||
          (record.instanceId === restoredPredecessor?.instanceId && matchesRequestedTarget) ||
          matchesWorkspaceRecovery)
      );
    });
    const followerOwner =
      Threads.getTelegramThreadOwnerFromProfileKey(followerProfileKey);
    const recoverableTarget =
      !reconnectRecord &&
      requestedTarget?.chatId === chatId &&
      requestedTarget.threadId !== undefined &&
      !recordsBeforeProvision.some(
        (record) =>
          record.target.chatId === requestedTarget.chatId &&
          record.target.threadId === requestedTarget.threadId,
      )
        ? requestedTarget
        : undefined;
    const recoveryHint = recoverableTarget
      ? deps.topicTargetStore.getFollowerRecoveryHintByTarget?.(
          recoverableTarget,
        )
      : undefined;
    const registrationKey =
      workspaceIdentity?.bindingKey ||
      followerProfileKey ||
      registration.instanceId;
    const pendingRegistration = pendingRegistrations.get(registrationKey);
    if (pendingRegistration) return pendingRegistration;
    const provisionTarget = async () => {
      deps.onProvisioningStart?.();
      try {
        return await provision({
          instanceId: registration.instanceId,
          owner:
            followerOwner.kind === "manual-follower"
              ? followerOwner
              : {
                  kind: "manual-follower",
                  instanceId: registration.instanceId,
                },
          profileKey: followerProfileKey,
          threadName: workspaceBinding?.threadName ?? registration.threadName,
          preferredSlot:
            workspaceIdentity?.slot ??
            workspaceBinding?.slot ??
            registration.slot,
          ...(workspaceIdentity
            ? {
                workspaceBindingKey: workspaceIdentity.bindingKey,
                workspaceCwd: workspaceIdentity.cwd,
              }
            : {}),
        });
      } finally {
        deps.onProvisioningEnd?.();
      }
    };
    const recoverRequestedTarget = async () => {
      const nowMs = getNowMs();
      const carriedThreadName =
        workspaceBinding?.threadName ?? registration.threadName;
      const requestedThreadName =
        carriedThreadName &&
        ThreadNaming.isTelegramTopicThreadNameValidForSlot(
          carriedThreadName,
          registration.slot,
        )
          ? carriedThreadName
          : recoveryHint?.threadName &&
              ThreadNaming.isTelegramTopicThreadNameValidForSlot(
                recoveryHint.threadName,
                recoveryHint.slot,
              )
            ? recoveryHint.threadName
            : undefined;
      const requestedSlot =
        workspaceIdentity?.slot ??
        workspaceBinding?.slot ??
        registration.slot ??
        recoveryHint?.slot;
      const recoveredSlot = deps.topicTargetStore.allocateSlot(
        followerProfileKey,
        requestedSlot,
        workspaceIdentity?.bindingKey,
      );
      if (!recoveredSlot) {
        throw new TelegramWorkspaceSlotUnavailableError();
      }
      const recoveredRecord: Threads.TelegramTopicTargetRecord = {
        profileKey: followerProfileKey,
        owner:
          followerOwner.kind === "manual-follower"
            ? followerOwner
            : {
                kind: "manual-follower",
                instanceId: registration.instanceId,
              },
        target: {
          chatId: recoverableTarget!.chatId,
          threadId: recoverableTarget!.threadId!,
        },
        status: "active",
        createdAtMs: registration.connectedAtMs || nowMs,
        updatedAtMs: nowMs,
        instanceId: registration.instanceId,
        ...(requestedThreadName ? { threadName: requestedThreadName } : {}),
        slot: recoveredSlot,
        lastSyncObservedAtMs: nowMs,
        lastReconcileAction: "follower-live-target-recovery",
      };
      return {
        target: recoveredRecord.target,
        reused: true,
        record: recoveredRecord,
      };
    };
    const runRegistration = async (): Promise<
      (TelegramTarget & { slot?: string; threadName?: string }) | undefined
    > => {
      if (requestedTarget)
        deps.topicTargetStore.assertWorkspaceRestoreRegistration({
          target: requestedTarget,
          bindingKey: workspaceIdentity?.bindingKey,
          slot:
            workspaceIdentity?.slot ??
            workspaceBinding?.slot ??
            registration.slot,
        });
      const recoveryTarget = reconnectRecord?.target ?? recoverableTarget;
      if (recoveryTarget) {
        Threads.assertTelegramPendingTopicRecoveryAllowed(
          deps.topicTargetStore,
          recoveryTarget,
        );
      }
      const pendingTargetRecovery =
        recoverableTarget &&
        deps.topicTargetStore
          .listPendingProvisions()
          .some(
            (entry) =>
              entry.target?.chatId === recoverableTarget.chatId &&
              entry.target?.threadId === recoverableTarget.threadId &&
              (entry.instanceId === registration.instanceId ||
                entry.profileKey === followerProfileKey),
          );
      let result: Threads.TelegramTopicTargetProvisionResult = reconnectRecord
        ? {
            target: reconnectRecord.target,
            reused: true,
            record: reconnectRecord,
          }
        : recoverableTarget && !pendingTargetRecovery
          ? await recoverRequestedTarget()
          : await provisionTarget();
      const alignResultWithWorkspaceSlot = (): void => {
        if (!workspaceIdentity || result.record.slot === workspaceIdentity.slot)
          return;
        deps.recordRuntimeEvent(
          "bus",
          "Telegram follower record slot reconciled to its Workspace claim",
          {
            phase: "follower-register-slot-reconcile",
            instanceId: registration.instanceId,
            chatId: result.target.chatId,
            threadId: result.target.threadId,
            previousSlot: result.record.slot,
            slot: workspaceIdentity.slot,
          },
        );
        result = {
          ...result,
          record: { ...result.record, slot: workspaceIdentity.slot },
        };
      };
      alignResultWithWorkspaceSlot();
      const assertRestoreRegistration = (): void =>
        deps.topicTargetStore.assertWorkspaceRestoreRegistration({
          target: result.target,
          slot: result.record.slot,
          bindingKey: workspaceIdentity?.bindingKey,
        });
      assertRestoreRegistration();
      const crossSessionReuse =
        !!reconnectRecord &&
        reconnectRecord.instanceId !== registration.instanceId;
      if (reconnectRecord && !crossSessionReuse) {
        const nowMs = getNowMs();
        const refreshedRecord = deps.topicTargetStore.upsert({
          ...result.record,
          instanceId: registration.instanceId,
          updatedAtMs: nowMs,
          lastSyncObservedAtMs: nowMs,
          lastReconcileAction: "follower-register-reuse",
        });
        await deps.topicTargetStore.persist();
        result = {
          target: refreshedRecord.target,
          reused: true,
          record: refreshedRecord,
        };
      }
      const probeRequiredRecord = reconnectRecord?.status === "probe-required";
      // Pi /new or /fork inside one live process keeps its Thread; that process already proves the tab.
      const sameProcessSessionHandoff =
        crossSessionReuse &&
        reconnectRecord?.status === "active" &&
        registration.previousInstanceId === reconnectRecord.instanceId &&
        recoverableTarget === undefined &&
        Threads.isSameTelegramProcessInstance(
          reconnectRecord.instanceId,
          registration.instanceId,
        );
      const requiresVisibilityProbe =
        (crossSessionReuse && !sameProcessSessionHandoff) ||
        probeRequiredRecord ||
        recoverableTarget !== undefined;
      const transferSessionHandoffRecord = async (): Promise<void> => {
        const nowMs = getNowMs();
        const transferredRecord = deps.topicTargetStore.upsert({
          ...result.record,
          profileKey: followerProfileKey,
          owner:
            followerOwner.kind === "manual-follower"
              ? followerOwner
              : {
                  kind: "manual-follower",
                  instanceId: registration.instanceId,
                },
          instanceId: registration.instanceId,
          updatedAtMs: nowMs,
          lastSyncObservedAtMs: nowMs,
          lastReconcileAction: "follower-session-handoff",
        });
        await deps.topicTargetStore.persist();
        result = {
          target: transferredRecord.target,
          reused: true,
          record: transferredRecord,
        };
      };
      if (sameProcessSessionHandoff) {
        assertRestoreRegistration();
        await transferSessionHandoffRecord();
      }
      // A session handoff still owns the predecessor session's binding until the Workspace commit re-keys it.
      const retainedDisplayBinding =
        deps.topicTargetStore.getWorkspaceBindingByTarget(result.target, registration.sessionId) ??
        deps.topicTargetStore.getWorkspaceBindingByTarget(result.target);
      let connectedAnnouncement =
        !result.reused || requiresVisibilityProbe
          ? createTelegramBusInstanceLifecycleAnnouncement({
              target: result.target,
              threadName:
                result.displayTitle ??
                (retainedDisplayBinding?.cwd === workspaceIdentity?.cwd ? retainedDisplayBinding?.displayTitle : undefined) ??
                result.record.threadName,
              slot: result.record.slot,
              state: "connected",
            })
          : undefined;
      if (requiresVisibilityProbe && connectedAnnouncement) {
        try {
          assertRestoreRegistration();
          await deps.callApi(
            // Typing is presence, not evidence that a retained Thread still accepts messages.
            "sendMessage",
            {
              chat_id: connectedAnnouncement.target.chatId,
              message_thread_id: connectedAnnouncement.target.threadId,
              text: connectedAnnouncement.text,
              parse_mode: connectedAnnouncement.parseMode,
            },
            // A deleted Thread is this probe's expected answer; the recovery below records it.
            { isExpectedError: Threads.isTelegramTopicTargetStaleError },
          );
          assertRestoreRegistration();
          if (recoverableTarget || probeRequiredRecord) {
            const activatedRecord = deps.topicTargetStore.upsert({
              ...result.record,
              ...(probeRequiredRecord && crossSessionReuse
                ? {
                    profileKey: followerProfileKey,
                    owner:
                      followerOwner.kind === "manual-follower"
                        ? followerOwner
                        : {
                            kind: "manual-follower" as const,
                            instanceId: registration.instanceId,
                          },
                    instanceId: registration.instanceId,
                  }
                : {}),
              status: "active",
              updatedAtMs: getNowMs(),
              lastSyncObservedAtMs: getNowMs(),
              lastReconcileAction: "follower-live-target-recovery",
            });
            await deps.topicTargetStore.persist();
            result = {
              target: activatedRecord.target,
              reused: true,
              record: activatedRecord,
            };
          } else if (crossSessionReuse && reconnectRecord) {
            await transferSessionHandoffRecord();
          }
          connectedAnnouncement = undefined;
        } catch (error) {
          // Restore protection failures are not evidence that a Telegram topic is missing.
          assertRestoreRegistration();
          if (Threads.isTelegramTopicTargetStaleError(error)) {
            deps.topicTargetStore.markStaleByTarget(
              result.target,
              "deleted",
              error instanceof Error ? error.message : String(error),
            );
            await deps.topicTargetStore.persist();
            const staleTarget = result.target;
            result = await provisionTarget();
            deps.recordRuntimeEvent(
              "telegram",
              "Telegram follower restore probe found its Thread deleted; re-created it.",
              {
                phase: "topic-lifecycle-restore-probe-recreated",
                instanceId: registration.instanceId,
                chatId: staleTarget.chatId,
                staleThreadId: staleTarget.threadId,
                threadId: result.target.threadId,
              },
            );
            connectedAnnouncement =
              createTelegramBusInstanceLifecycleAnnouncement({
                target: result.target,
                threadName: result.displayTitle ?? result.record.threadName,
                slot: result.record.slot,
                state: "connected",
              });
          } else {
            deps.recordRuntimeEvent("telegram", error, {
              phase: "follower-topic-reuse-probe",
              instanceId: registration.instanceId,
              chatId: result.target.chatId,
              threadId: result.target.threadId,
            });
            if (recoverableTarget) {
              deps.topicTargetStore.upsert({
                ...result.record,
                status: "probe-required",
                updatedAtMs: getNowMs(),
                lastSyncError:
                  error instanceof Error ? error.message : String(error),
                lastReconcileAction: "follower-visibility-probe-required",
              });
              await deps.topicTargetStore.persist();
            }
            throw error;
          }
        }
      }
      if (workspaceIdentity) {
        alignResultWithWorkspaceSlot();
        const workspaceCommit = Threads.commitTelegramWorkspaceProvisionBinding(
          {
            store: deps.topicTargetStore,
            instanceId: registration.instanceId,
            profileKey: followerProfileKey,
            displayTitle: result.displayTitle,
            binding: {
              ...workspaceIdentity,
              target: { ...result.target },
              ...(result.record.threadName
                ? { threadName: result.record.threadName }
                : {}),
              slot: workspaceIdentity.slot,
              ...(workspaceIdentity.sessionId
                ? {
                    journalSources: [
                      {
                        sessionId: workspaceIdentity.sessionId,
                        recipientBindingKey: followerProfileKey,
                      },
                    ],
                    journalBindingKeys: [],
                  }
                : { journalBindingKeys: [followerProfileKey] }),
              journalBindingsComplete: true,
              updatedAtMs: getNowMs(),
            },
          },
        );
        // Same-target reuse can retain a different slot than the initial claim.
        if (result.record.slot !== workspaceCommit.slot) {
          result = {
            ...result,
            record: deps.topicTargetStore.upsert({
              ...result.record,
              slot: workspaceCommit.slot,
            }),
          };
        }
        if (connectedAnnouncement && workspaceCommit.displayTitle) {
          connectedAnnouncement =
            createTelegramBusInstanceLifecycleAnnouncement({
              target: result.target,
              threadName: workspaceCommit.displayTitle,
              slot: result.record.slot,
              state: "connected",
            });
        }
        deps.topicTargetStore.markWorkspaceBindingActiveByTarget(result.target);
        await deps.topicTargetStore.persist();
      }
      assertRestoreRegistration();
      deps.setSyncState(
        Sync.markTelegramSyncSliceFresh(
          deps.getSyncState(),
          "target-bindings",
          {
            nowMs: getNowMs(),
            action: "follower-register",
          },
        ),
      );
      recordSlowTelegramBusFollowerRegistrationStep(deps, {
        phase: "follower-register-critical",
        elapsedMs: Date.now() - registrationStartedAtMs,
        instanceId: registration.instanceId,
        target: result.target,
        reused: result.reused,
      });
      scheduleTelegramBusLeaderBackgroundTask(
        async () => {
          const backgroundStartedAtMs = Date.now();
          if (connectedAnnouncement) {
            try {
              await deps.callApi("sendMessage", {
                chat_id: connectedAnnouncement.target.chatId,
                message_thread_id: connectedAnnouncement.target.threadId,
                text: connectedAnnouncement.text,
                parse_mode: connectedAnnouncement.parseMode,
              });
            } catch (error) {
              deps.recordRuntimeEvent("telegram", error, {
                phase: "follower-topic-announce",
                instanceId: registration.instanceId,
                chatId: result.target.chatId,
                threadId: result.target.threadId,
              });
            }
          }
          const reconcile = async (): Promise<void> => {
            await ThreadReconciler.applyThreadReconciliationPlan(
              ThreadReconciler.planThreadReconciliation({
                nowMs: getNowMs(),
                currentLeaderEpoch: deps.getCurrentLeaderEpoch?.(),
                records: recordsBeforeProvision,
                pendingProvisions:
                  deps.topicTargetStore.listPendingProvisions(),
                replacedBindings: [
                  {
                    instanceId: registration.instanceId,
                    replacementTarget: result.target,
                  },
                ],
              }),
              {
                isCleanupTargetProtected:
                  Threads.createTelegramCleanupTargetProtection(
                    deps.topicTargetStore,
                  ),
                callApi: deps.callApi,
                markStaleByTarget: deps.topicTargetStore.markStaleByTarget,
                persist: deps.topicTargetStore.persist,
                removePendingProvisionById(id) {
                  return deps.topicTargetStore.removePendingProvision(id);
                },
                getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
                recordRuntimeEvent: deps.recordRuntimeEvent,
              },
            );
            await deps.topicTargetStore.persist();
          };
          try {
            if (deps.runWorkspaceOperation) {
              await deps.runWorkspaceOperation(
                {
                  operationId: createTelegramWorkspaceAdmissionOperationId(),
                  operationKind: "workspace.reconcile-follower-provision",
                  scopes: [{ kind: "profile" }],
                },
                reconcile,
              );
            } else {
              await reconcile();
            }
          } catch (error) {
            deps.recordRuntimeEvent("telegram", error, {
              phase: "follower-register-background-reconcile",
              instanceId: registration.instanceId,
              chatId: result.target.chatId,
              threadId: result.target.threadId,
            });
          }
          recordSlowTelegramBusFollowerRegistrationStep(deps, {
            phase: "follower-register-background",
            elapsedMs: Date.now() - backgroundStartedAtMs,
            instanceId: registration.instanceId,
            target: result.target,
            reused: result.reused,
          });
        },
        (error) => {
          deps.recordRuntimeEvent("bus", error, {
            phase: "follower-register-background-owner",
            instanceId: registration.instanceId,
          });
        },
      );
      return {
        ...result.target,
        slot: result.record.slot,
        threadName: result.record.threadName,
      };
    };
    const registrationPromise = runRegistration().finally(() => {
      pendingRegistrations.delete(registrationKey);
      deps.topicTargetStore.releaseWorkspaceClaim(registration.instanceId);
    });
    pendingRegistrations.set(registrationKey, registrationPromise);
    return registrationPromise;
  };
}

function createTelegramBusFollowerCleanupHandler(
  deps: TelegramBusFollowerDisconnectHandlerDeps,
  trigger: "graceful-disconnect" | "confirmed-dead",
): (follower: TelegramBusFollowerView) => Promise<void> {
  return async (follower) => {
    const target = follower.target;
    if (!target?.threadId) return;
    const leaderEpoch = deps.getCurrentLeaderEpoch?.();
    if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
      throw new Error("Follower disconnect cleanup requires leader ownership.");
    }
    if (!follower.registrationGeneration) {
      throw new Error(
        "Follower disconnect cleanup requires an exact registration generation.",
      );
    }
    const intent: ThreadReconciler.TelegramThreadCleanupIntent = {
      id: `cleanup:${follower.instanceId}:${follower.registrationGeneration}:${target.chatId}:${target.threadId}`,
      owner: "manual-follower",
      instanceId: follower.instanceId,
      runtimeGeneration: follower.registrationGeneration,
      ...(follower.profileKey ? { profileKey: follower.profileKey } : {}),
      target: { chatId: target.chatId, threadId: target.threadId },
      requestedAtMs: (deps.getNowMs ?? Date.now)(),
    };
    const departingRecord = deps.topicTargetStore
      .list()
      .find(
        (record) =>
          record.instanceId === follower.instanceId &&
          record.target.chatId === target.chatId &&
          record.target.threadId === target.threadId,
      );
    const isCleanupTargetProtected =
      Threads.createTelegramCleanupTargetProtection(
        deps.topicTargetStore,
        departingRecord,
      );
    deps.topicTargetStore.upsertPendingCleanup(intent);
    await deps.topicTargetStore.persist();
    const cleanupPlan = ThreadReconciler.planThreadReconciliation({
      nowMs: (deps.getNowMs ?? Date.now)(),
      currentLeaderEpoch: leaderEpoch,
      records: [],
      pendingCleanups: [intent],
    });
    const cleanup = await ThreadReconciler.applyThreadReconciliationPlan(
      cleanupPlan,
      {
        isCleanupTargetProtected,
        callApi: deps.callApi,
        markStaleByTarget: deps.topicTargetStore.markStaleByTarget,
        removeCleanupIntentById: deps.topicTargetStore.removePendingCleanup,
        persist: deps.topicTargetStore.persist,
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      },
    );
    if (
      cleanupPlan.actions.some((action) =>
        isCleanupTargetProtected(action.target, action),
      )
    )
      return;
    if (cleanup.incompleteActions?.length) {
      throw new Error(
        "Telegram follower thread deletion was not confirmed; reconnect the leader to retry cleanup.",
      );
    }
    if (
      deps.getCurrentLeaderEpoch &&
      deps.getCurrentLeaderEpoch() !== leaderEpoch
    ) {
      throw new Error("Follower disconnect cleanup lost leader ownership.");
    }
    deps.setSyncState(
      Sync.markTelegramSyncSliceFresh(deps.getSyncState(), "target-bindings", {
        nowMs: (deps.getNowMs ?? Date.now)(),
        action:
          trigger === "confirmed-dead"
            ? "manual-follower-confirmed-dead"
            : "manual-follower-disconnect",
      }),
    );
    deps.recordRuntimeEvent(
      "bus",
      trigger === "confirmed-dead"
        ? "Confirmed-dead Telegram bus follower thread cleaned up"
        : "Telegram bus follower disconnected",
      {
        phase:
          trigger === "confirmed-dead"
            ? "follower-confirmed-dead-cleanup"
            : "follower-disconnect",
        instanceId: follower.instanceId,
        chatId: target.chatId,
        threadId: target.threadId,
      },
    );
  };
}

export function createTelegramBusFollowerDisconnectHandler(
  deps: TelegramBusFollowerDisconnectHandlerDeps,
): (follower: TelegramBusFollowerView) => Promise<void> {
  return createTelegramBusFollowerCleanupHandler(deps, "graceful-disconnect");
}

export function createTelegramBusFollowerConfirmedDeadHandler(
  deps: TelegramBusFollowerDisconnectHandlerDeps,
): (follower: TelegramBusFollowerView) => Promise<void> {
  return createTelegramBusFollowerCleanupHandler(deps, "confirmed-dead");
}

export function createTelegramBusLeaderTargetProvisioner<TContext>(
  deps: TelegramBusLeaderTargetProvisionerDeps<TContext>,
): (ctx: TContext) => Promise<void> {
  const getNowMs = deps.getNowMs ?? Date.now;
  return async (ctx) => {
    const leaderEpoch = deps.getCurrentLeaderEpoch?.();
    if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
      throw new Error(
        "Telegram leader target provisioning requires ownership.",
      );
    }
    await deps.topicTargetStore.load();
    const cwd = deps.getCwd?.(ctx);
    const normalizedCwd = cwd
      ? WorkspaceIdentity.normalizeTelegramWorkspacePath(cwd)
      : undefined;
    const profileKey = Threads.getTelegramThreadOwnerKey({
      kind: "leader",
      cwd: normalizedCwd,
      instanceId: deps.instanceId,
      telegramProfile: deps.getTelegramProfile?.(),
    });
    const reusableOwnRecord = deps.topicTargetStore.getByProfileKey(profileKey);
    const pendingCleanups = deps.topicTargetStore.listPendingCleanups();
    const deferredOwnCleanups =
      reusableOwnRecord?.status === "active"
        ? pendingCleanups.filter(
            (cleanup) =>
              cleanup.owner === "leader" &&
              cleanup.target.chatId === reusableOwnRecord.target.chatId &&
              cleanup.target.threadId === reusableOwnRecord.target.threadId,
          )
        : [];
    const deferredOwnCleanupIds = new Set(
      deferredOwnCleanups.map((cleanup) => cleanup.id),
    );
    const pendingCleanupPlan = ThreadReconciler.planThreadReconciliation({
      nowMs: getNowMs(),
      currentLeaderEpoch: leaderEpoch,
      previousState: deps.getThreadReconciliationMachineState?.(),
      records: deps.topicTargetStore.list(),
      pendingCleanups: pendingCleanups.filter(
        (cleanup) => !deferredOwnCleanupIds.has(cleanup.id),
      ),
    });
    deps.recordThreadReconciliationPlan?.(pendingCleanupPlan);
    const cleanupPorts = {
      isCleanupTargetProtected: Threads.createTelegramCleanupTargetProtection(
        deps.topicTargetStore,
      ),
      callApi: deps.callApi,
      markStaleByTarget: deps.topicTargetStore.markStaleByTarget,
      removeCleanupIntentById: deps.topicTargetStore.removePendingCleanup,
      persist: deps.topicTargetStore.persist,
      getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    };
    await ThreadReconciler.applyThreadReconciliationPlan(
      pendingCleanupPlan,
      cleanupPorts,
    );
    deps.onProvisioningStart?.();
    let ownTarget: Threads.TelegramOwnTopicProvisionResult | undefined;
    try {
      ownTarget = await Sync.ensureTelegramLeaderThreadBinding({
        getAllowedUserId: deps.getAllowedUserId,
        instanceId: deps.instanceId,
        cwd: normalizedCwd,
        sessionId: deps.getSessionId?.(ctx),
        telegramProfile: deps.getTelegramProfile?.(),
        forceFreshUnnamed: deps.shouldForceFreshUnnamed?.(),
        requestedThreadName: deps.getRequestedThreadName?.(),
        resolveInitialWorkspaceDisplayTitle:
          deps.resolveInitialWorkspaceDisplayTitle,
        getNowMs,
        getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
        getThreadReconciliationMachineState:
          deps.getThreadReconciliationMachineState,
        recordThreadReconciliationPlan: deps.recordThreadReconciliationPlan,
        topicTargetStore: deps.topicTargetStore,
        callApi: deps.callApi,
        probeWorkspaceBinding: async (binding) => {
          const announcement = createTelegramBusInstanceLifecycleAnnouncement({
            target: binding.target,
            threadName: binding.displayTitle ?? binding.threadName,
            slot: binding.slot,
            state: "connected",
          });
          await deps.callApi("sendMessage", {
            chat_id: announcement.target.chatId,
            message_thread_id: announcement.target.threadId,
            text: announcement.text,
            parse_mode: announcement.parseMode,
          });
        },
        recordEvent: deps.recordRuntimeEvent,
      });
    } finally {
      deps.onProvisioningEnd?.();
    }
    if (deferredOwnCleanups.length > 0) {
      const supersededCleanupPlan = ThreadReconciler.planThreadReconciliation({
        nowMs: getNowMs(),
        currentLeaderEpoch: leaderEpoch,
        previousState: deps.getThreadReconciliationMachineState?.(),
        records: deps.topicTargetStore.list(),
        pendingCleanups: deferredOwnCleanups,
      });
      deps.recordThreadReconciliationPlan?.(supersededCleanupPlan);
      await ThreadReconciler.applyThreadReconciliationPlan(
        supersededCleanupPlan,
        cleanupPorts,
      );
    }
    if (
      deps.getCurrentLeaderEpoch &&
      deps.getCurrentLeaderEpoch() !== leaderEpoch
    ) {
      throw new Error("Telegram leader target provisioning lost ownership.");
    }
    if (!ownTarget) return;
    deps.setLeaderTarget({
      target: ownTarget.target,
      slot: ownTarget.slot,
      threadName: ownTarget.threadName,
    });
    const nowMs = getNowMs();
    let syncState = deps.getSyncState();
    syncState = Sync.markTelegramSyncSliceFresh(syncState, "target-bindings", {
      nowMs,
      action: "leader-startup",
    });
    syncState = Sync.markTelegramSyncSliceFresh(syncState, "reservations", {
      nowMs,
      action: "leader-startup",
    });
    syncState = Sync.markTelegramSyncSliceFresh(syncState, "topic-capability", {
      nowMs,
      action: "leader-startup",
    });
    deps.setSyncState(syncState);
    if (ownTarget.reused) return;
    const connectedAnnouncement =
      createTelegramBusInstanceLifecycleAnnouncement({
        target: ownTarget.target,
        threadName: ownTarget.displayTitle ?? ownTarget.threadName,
        slot: ownTarget.slot,
        state: "connected",
      });
    try {
      await deps.callApi("sendMessage", {
        chat_id: connectedAnnouncement.target.chatId,
        message_thread_id: connectedAnnouncement.target.threadId,
        text: connectedAnnouncement.text,
        parse_mode: connectedAnnouncement.parseMode,
      });
    } catch (error) {
      deps.recordRuntimeEvent("telegram", error, {
        phase: "leader-topic-announce",
        instanceId: deps.instanceId,
        chatId: ownTarget.target.chatId,
        threadId: ownTarget.target.threadId,
        slot: ownTarget.slot,
      });
    }
  };
}

/** Strict copy of a follower-supplied attachment source; anything malformed falls back to the plain generated name. */
function parseTelegramBusAttachmentSource(
  value: unknown,
): TelegramAttachmentSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>,
    chat = raw.chat as Record<string, unknown> | undefined;
  const text = (field: unknown) =>
    typeof field === "string" && field.length > 0 && field.length <= 256;
  if (
    !text(raw.kind) ||
    !Number.isSafeInteger(raw.messageId) ||
    (raw.index !== undefined && !Number.isSafeInteger(raw.index)) ||
    (raw.userFileName !== undefined && !text(raw.userFileName)) ||
    (raw.scope !== undefined && !text(raw.scope)) ||
    (chat !== undefined &&
      (!chat ||
        typeof chat !== "object" ||
        Array.isArray(chat) ||
        !Number.isSafeInteger(chat.id) ||
        (chat.type !== undefined && !text(chat.type)) ||
        (chat.username !== undefined && !text(chat.username))))
  )
    return undefined;
  return {
    kind: raw.kind as string,
    messageId: raw.messageId as number,
    ...(raw.index !== undefined ? { index: raw.index as number } : {}),
    ...(raw.userFileName !== undefined
      ? { userFileName: raw.userFileName as string }
      : {}),
    ...(raw.scope !== undefined ? { scope: raw.scope as string } : {}),
    ...(chat
      ? {
          chat: {
            id: chat.id as number,
            ...(chat.type !== undefined ? { type: chat.type as string } : {}),
            ...(chat.username !== undefined
              ? { username: chat.username as string }
              : {}),
          },
        }
      : {}),
  };
}

export function createTelegramBusLeaderApiProxy(
  deps: TelegramBusLeaderApiProxyDeps,
): (method: string, args: unknown[]) => Promise<unknown> {
  return async (method, args) => {
    if (method === "call") {
      const body = stripTelegramBusApiMetadata(
        args[1] as Record<string, unknown>,
      );
      try {
        return await deps.call(
          args[0] as string,
          body,
          args[2] as TelegramApiCallOptions | undefined,
        );
      } catch (error) {
        await deps.recoverStaleTargetError?.(body, error);
        throw error;
      }
    }
    if (method === "callMultipart") {
      const fields = args[1] as Record<string, string>;
      try {
        return await deps.callMultipart(
          args[0] as string,
          fields,
          args[2] as string,
          args[3] as string,
          args[4] as string,
          args[5] as TelegramApiCallOptions | undefined,
        );
      } catch (error) {
        await deps.recoverStaleTargetError?.(fields, error);
        throw error;
      }
    }
    if (method === "downloadFile") {
      // Follower IPC is a trust boundary: only an exact attachment-source shape reaches the file-name builder.
      const source = parseTelegramBusAttachmentSource(args[2]);
      return deps.downloadFile(
        args[0] as string,
        args[1] as string,
        ...(source ? [source] : []),
      );
    }
    throw new Error(`Unsupported Telegram bus API method: ${method}`);
  };
}

type TelegramBusFollowerMutationRunner = <T>(
  follower: { instanceId: string; profileKey?: string },
  operation: () => Promise<T>,
) => Promise<T>;

function createTelegramBusFollowerMutationRunner(): TelegramBusFollowerMutationRunner {
  const tails = new Map<string, Promise<void>>();
  return async (follower, operation) => {
    const key = follower.profileKey
      ? `profile:${follower.profileKey}`
      : `instance:${follower.instanceId}`;
    const previous = tails.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(key, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  };
}

/** One delegated text effect through existing Workspace/API owners; no closure transport, ordinary proxy or replay loop. */
export function createTelegramBusSelectedMenuDeliveryHandler(deps: {
  followerRegistry: TelegramBusFollowerRegistry;
  protocolIdentity: TelegramBusProtocolIdentity;
  workspace: {
    /** Exact active bot/profile namespace, independently captured by the leader; never follower-supplied. */
    getScopeKey(): string | undefined;
    captureAuthority(): Threads.TelegramWorkspaceRestoreAuthority | undefined;
    getStore(): Threads.TelegramWorkspaceRestore | undefined;
    threadStore: Pick<
      Threads.TelegramTopicTargetStore,
      "withWorkspaceLiveRebindSnapshot"
    >;
    getJournalBindingKey(follower: TelegramBusFollowerView): string | undefined;
    run: TelegramBusWorkspaceAdmissionRunner;
  };
  api: {
    runtime: Pick<TelegramBridgeApiRuntime, "call">;
    authorize(input: {
      follower: TelegramBusFollowerView;
      method: string;
      args: unknown[];
    }): boolean;
    /** Synchronous publication acceptance through the existing ownership owner, never delivery/cleanup permission. */
    record(
      record: TelegramBusFollowerMessageOwnershipRecord,
      assertCurrent: () => void,
    ): boolean;
  };
}) {
  return async (
    input: TelegramBusSelectedMenuDelivery,
    isCallerCurrent: () => boolean,
  ): Promise<TelegramBusEnvelope> => {
    let issued = false,
      method = "sendMessage";
    try {
      const decoded = parseTelegramBusEnvelope(JSON.stringify(input));
      if (decoded?.kind !== "follower.deliverSelectedMenu")
        throw new Error("Selected-menu wire is unavailable.");
      const expected = decoded,
        { recipient, executor, effect } = expected;
      method = effect.kind === "send-text" ? "sendMessage" : "editMessageText";
      const workspace = deps.workspace,
        api = deps.api,
        registry = deps.followerRegistry,
        protocol = structuredClone(deps.protocolIdentity);
      const scope = workspace?.getScopeKey,
        scopeKey = scope?.call(workspace);
      const capture = workspace?.captureAuthority,
        getStore = workspace?.getStore,
        threads = workspace?.threadStore,
        resolveJournal = workspace?.getJournalBindingKey,
        run = workspace?.run,
        runtime = api?.runtime,
        call = runtime?.call,
        authorize = api?.authorize,
        record = api?.record;
      const authority = capture?.call(workspace),
        store = getStore?.call(workspace),
        follower = registry.get(expected.instanceId);
      if (
        !scopeKey?.trim() ||
        !authority ||
        !isDeepStrictEqual(authority.executor, executor) ||
        authority.operatorUserId !== expected.operatorUserId ||
        !store ||
        typeof threads?.withWorkspaceLiveRebindSnapshot !== "function" ||
        typeof resolveJournal !== "function" ||
        typeof run !== "function" ||
        typeof call !== "function" ||
        typeof authorize !== "function" ||
        typeof record !== "function" ||
        !follower
      )
        throw new Error("Selected-menu proof/API owner is unavailable.");
      const retained = store
        .listLiveRebindings()
        .find((value) => value.request.operationId === expected.operationId);
      if (
        !retained ||
        !Threads.isTelegramLiveRebindInputAuthorized(retained) ||
        retained.request.source.updateIds.length !== 1 ||
        retained.recipient.kind !== "follower" ||
        !isDeepStrictEqual(retained.executor, executor) ||
        retained.operatorUserId !== expected.operatorUserId ||
        retained.recipient.instanceId !== expected.instanceId ||
        retained.recipient.sessionId !== recipient.sessionId ||
        retained.recipient.generation !== expected.registrationGeneration ||
        retained.request.owner.profileKey !== recipient.profileKey ||
        !isDeepStrictEqual(retained.request.target, recipient.target)
      )
        throw new Error("Selected-menu operation/recipient is unavailable.");
      const intent = structuredClone(retained),
        snapshot = threads.withWorkspaceLiveRebindSnapshot;
      const registered = structuredClone(follower);
      const body: Record<string, unknown> = {
        chat_id: recipient.target.chatId,
        text: effect.text,
        ...(effect.parseMode ? { parse_mode: effect.parseMode } : {}),
        ...(effect.replyMarkup
          ? { reply_markup: structuredClone(effect.replyMarkup) }
          : {}),
        ...(effect.kind === "send-text"
          ? {
              message_thread_id: recipient.target.threadId,
              ...(effect.replyToMessageId
                ? {
                    reply_parameters: {
                      message_id: effect.replyToMessageId,
                      allow_sending_without_reply: true,
                    },
                  }
                : {}),
            }
          : { message_id: effect.messageId }),
      };
      const assertRecipientCurrent = () => {
        const activeAuthority = capture.call(workspace),
          live = registry.get(expected.instanceId);
        if (
          !isCallerCurrent() ||
          deps.workspace !== workspace ||
          deps.api !== api ||
          deps.followerRegistry !== registry ||
          workspace.getScopeKey !== scope ||
          scope!.call(workspace) !== scopeKey ||
          workspace.captureAuthority !== capture ||
          workspace.getStore !== getStore ||
          workspace.threadStore !== threads ||
          workspace.getJournalBindingKey !== resolveJournal ||
          workspace.run !== run ||
          threads.withWorkspaceLiveRebindSnapshot !== snapshot ||
          api.runtime !== runtime ||
          runtime.call !== call ||
          api.authorize !== authorize ||
          api.record !== record ||
          !authority.isCurrent() ||
          !activeAuthority?.isCurrent() ||
          activeAuthority.operatorUserId !== expected.operatorUserId ||
          !isDeepStrictEqual(activeAuthority.executor, executor) ||
          getStore.call(workspace) !== store ||
          !isDeepStrictEqual(deps.protocolIdentity, protocol) ||
          !hasTelegramBusCapability(
            protocol,
            TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
          ) ||
          !live ||
          !getTelegramBusProtocolCompatibility({
            local: protocol,
            remote: live.protocol,
          }).compatible ||
          !hasTelegramBusCapability(
            live.protocol,
            TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
          ) ||
          !isDeepStrictEqual(live.protocol, registered.protocol) ||
          live.registrationGeneration !== expected.registrationGeneration ||
          live.sessionId !== recipient.sessionId ||
          live.sessionGeneration !== recipient.sessionGeneration ||
          live.pid !== recipient.processId ||
          live.processBirthId !== recipient.processBirthId ||
          live.profileKey !== recipient.profileKey ||
          live.cwd !== registered.cwd ||
          live.slot !== registered.slot ||
          live.busSocketPath !== registered.busSocketPath ||
          live.target?.chatId !== recipient.target.chatId ||
          live.target.threadId !== recipient.target.threadId ||
          resolveJournal.call(workspace, live) !== recipient.journalBindingKey
        )
          throw new Error("Selected-menu authority changed.");
        const latest = store.listLiveRebindings().find(value => value.request.operationId === intent.request.operationId);
        if (!latest || !Threads.isTelegramLiveRebindInputAuthorized(latest) ||
          !isDeepStrictEqual({ ...latest, ...(intent.inputRelease ? { inputRelease: intent.inputRelease } : {}), revision: intent.revision, updatedAtMs: intent.updatedAtMs }, intent) ||
          (latest.inputRelease !== intent.inputRelease && !(intent.inputRelease === "issued" && latest.inputRelease === "accepted")))
          throw new Error("Selected-menu input grant changed.");
        let confirmed = false;
        snapshot.call(threads, latest, (view) => {
          const bindings = (view.workspaceBindings ?? []).filter(
            (value) => value.bindingKey === intent.request.binding.bindingKey,
          );
          const owners = view.threads.filter(
            (value) =>
              value.status === "active" &&
              (value.slot === intent.request.binding.slot ||
                isDeepStrictEqual(value.target, recipient.target)),
          );
          const binding = bindings[0],
            owner = owners[0];
          confirmed =
            bindings.length === 1 &&
            binding?.sessionId === recipient.sessionId &&
            binding.cwd === intent.request.binding.cwd &&
            binding.workspaceKey === intent.request.binding.workspaceKey &&
            binding.slot === live.slot &&
            binding.inactiveSinceMs === undefined &&
            isDeepStrictEqual(binding.target, recipient.target) &&
            owners.length === 1 &&
            owner?.instanceId === expected.instanceId &&
            owner.slot === binding.slot &&
            owner.profileKey === recipient.profileKey &&
            isDeepStrictEqual(owner.owner, intent.request.owner.owner) &&
            isDeepStrictEqual(owner.target, recipient.target) &&
            !!live.cwd &&
            WorkspaceIdentity.normalizeTelegramWorkspacePath(live.cwd) ===
              binding.cwd;
        });
        if (!confirmed || !isCallerCurrent() || !authority.isCurrent())
          throw new Error("Selected-menu canonical recipient is unavailable.");
      };
      const assertCurrent = () => {
        assertRecipientCurrent();
        const live = registry.get(expected.instanceId);
        if (
          !live ||
          authorize.call(api, {
            follower: structuredClone(live),
            method: "call",
            args: [method, structuredClone(body)],
          }) !== true
        )
          throw new Error("Selected-menu API recipient is unavailable.");
        assertRecipientCurrent();
      };
      assertCurrent();
      const result = await run(
        {
          operationId: createTelegramWorkspaceAdmissionOperationId(),
          operationKind: "workspace.selected-menu-delivery",
          scopes: [{ kind: "profile" }],
        },
        async () => {
          assertCurrent();
          issued = true;
          const result = await call.call(runtime, method, body, {
            assertAuthority: assertCurrent,
            maxAttempts: 1,
            retryRateLimit: false,
            retrySafety: "non-idempotent",
          });
          assertCurrent();
          const value =
            result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : undefined;
          const messageId =
            effect.kind === "edit-text" ? effect.messageId : value?.message_id;
          if (
            !Number.isSafeInteger(messageId) ||
            (messageId as number) <= 0 ||
            (effect.kind === "edit-text" &&
              result !== true &&
              value?.message_id !== messageId)
          )
            throw new Error("Selected-menu API result is unconfirmed.");
          if (
            effect.kind === "send-text" &&
            record.call(
              api,
              {
                follower: structuredClone(registered),
                chatId: recipient.target.chatId,
                messageId: messageId as number,
                target: { ...recipient.target },
              },
              assertCurrent,
            ) !== true
          )
            throw new Error(
              "Selected-menu ownership publication is unconfirmed.",
            );
          assertCurrent();
          return {
            operationId: expected.operationId,
            recipient: structuredClone(recipient),
            registrationGeneration: expected.registrationGeneration,
            effect: effect.kind,
            messageId,
          };
        },
      );
      assertCurrent();
      return {
        kind: "bus.ack",
        requestId: expected.requestId,
        ok: true,
        result,
      };
    } catch (error) {
      const unknown =
        issued &&
        !(error instanceof TelegramApiAuthorityError && !error.requestIssued);
      return {
        kind: "bus.ack",
        requestId: input.requestId,
        ok: false,
        message: "Selected-menu delivery is refused or unconfirmed.",
        ...(unknown
          ? { error: { code: "commit-unknown" as const, method } }
          : {}),
      };
    }
  };
}

/** The current registration a follower request names, or the negative ack refusing an unknown or stale one. */
function resolveRegisteredTelegramBusFollower(
  registry: Pick<TelegramBusFollowerRegistry, "get">,
  requestId: string,
  instanceId: string,
  registrationGeneration: string | undefined,
):
  | { follower: TelegramBusFollowerView }
  | { rejection: Extract<TelegramBusEnvelope, { kind: "bus.ack" }> } {
  const follower = registry.get(instanceId);
  if (!follower) {
    return {
      rejection: rejectTelegramBusRequest(
        requestId,
        "Unknown Telegram bus follower instance.",
      ),
    };
  }
  if (
    !follower.registrationGeneration ||
    registrationGeneration !== follower.registrationGeneration
  ) {
    return {
      rejection: rejectTelegramBusRequest(
        requestId,
        "Stale Telegram bus follower registration generation.",
      ),
    };
  }
  return { follower };
}

export interface TelegramBusLeaderEnvelopeHandlerDeps {
  /** Ordinary locally guarded API wire authority only; not remote question membership. */
  captureApiTransport?: () => (() => boolean) | undefined;
  captureArtifactTransport?: () => (() => boolean) | undefined;
  artifactApi?: Pick<TelegramBridgeApiRuntime, "callArtifactBytes" | "reserveArtifact">;
  artifactMaxBytes?: number;
  followerRegistry: TelegramBusFollowerRegistry;
  authSecret?: string;
  protocolIdentity: TelegramBusProtocolIdentity;
  getNowMs?: () => number;
  timeoutMs?: number;
  selectedMenuDelivery?: ReturnType<
    typeof createTelegramBusSelectedMenuDeliveryHandler
  >;
  callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
  authorizeFollowerApiCall?: (input: {
    follower: TelegramBusFollowerView;
    method: string;
    args: unknown[];
  }) => boolean;
  recordFollowerMessageOwnership?: TelegramBusFollowerMessageOwnershipRecorder;
  captureInputPublication?: (follower: TelegramBusFollowerView, target: TelegramTarget) => (messageId: number) => void;
  getTextInputReceiverBotId?: (follower: Readonly<TelegramBusFollowerView>, target: Readonly<TelegramTarget>) => number | undefined;
  /** Private broker opt-in only; no production readiness or peer capability is advertised. */
  getAttachmentReceiverBotId?: (follower: Readonly<TelegramBusFollowerView>, target: Readonly<TelegramTarget>) => number | undefined;
  resolveAgentTarget?: (
    follower: TelegramBusFollowerView,
    selector: Extract<
      TelegramBusEnvelope,
      { kind: "follower.resolveAgentTarget" }
    >["selector"],
  ) => Promise<TelegramTarget | undefined> | TelegramTarget | undefined;
  routeAgentMessage?: (
    follower: TelegramBusFollowerView,
    message: Extract<
      TelegramBusEnvelope,
      { kind: "follower.routeAgentMessage" }
    >["message"],
  ) => Promise<void> | void;
  routeQueueHandoff?: (
    follower: TelegramBusFollowerView,
    envelope: Extract<
      TelegramBusEnvelope,
      { kind: "follower.offerQueueHandoff" }
    >,
  ) => Promise<unknown> | unknown;
  provisionFollowerTarget?: (
    registration: TelegramBusInstanceRegistration,
    options?: { existingWorkspaceBindingOnly?: boolean; recoverConnection?: boolean },
  ) =>
    | Promise<
        (TelegramTarget & { slot?: string; threadName?: string }) | undefined
      >
    | (TelegramTarget & { slot?: string; threadName?: string })
    | undefined;
  commitFollowerRegistration?: TelegramBusFollowerRegistrationCommitter;
  onFollowerDisconnected?: (
    follower: TelegramBusFollowerView,
  ) => Promise<void> | void;
  renameFollowerThread?: (
    follower: TelegramBusFollowerView,
    threadName: string,
  ) => Promise<{ threadName: string }> | { threadName: string };
  resetFollowerThreadName?: (
    follower: TelegramBusFollowerView,
  ) => Promise<{ threadName: string }> | { threadName: string };
  publishFollowerSessionReplacement?: TelegramBusFollowerSessionReplacementOperation;
  settleFollowerSessionReplacement?: TelegramBusFollowerSessionReplacementOperation;
  getFollowerDisplayTitle?: (
    follower: TelegramBusFollowerView,
  ) => string | undefined;
  /** The leader's own Thread capability, relayed on heartbeats so followers need not probe Telegram themselves. */
  getThreadCapability?: () => boolean | undefined;
  onFollowerRegistered?: () => void;
  /** Observation only: reacquire admission and inspect work, never infer completion.
   * Listener settlement ends its currentness fence; return asynchronous work to retain that fence. */
  onWorkspaceRestoreRecipientObserved?: (
    follower: TelegramBusFollowerView,
    isCurrent: () => boolean,
  ) => Promise<void> | void;
  getWorkspaceRestoreObservationGeneration?: () => number | undefined;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  applyThreadDisplayMode?: (
    mode: TelegramThreadDisplayMode,
    isCurrent: () => boolean,
  ) => Promise<void>;
  getThreadDisplayMode?: () => TelegramThreadDisplayMode;
  /** Fresh state-derived codec requirements, rechecked before provisioning and registration publication. */
  getRequiredWorkspaceReaderCapabilities?: () => readonly string[];
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getTelegramProfile?: () => string | undefined;
  getAllowedUserId?: () => number | undefined;
  runFollowerMutation?: TelegramBusFollowerMutationRunner;
  runWorkspaceAdmission?: TelegramBusWorkspaceAdmissionRunner;
  runWithWorkspaceCapacity?: TelegramWorkspaceCapacityRunner;
}

export function createTelegramBusArtifactAuthorityCapture(deps: TelegramBusLeaderEnvelopeHandlerDeps) {
  return (envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>): (() => boolean) | undefined => {
    if (!deps.authSecret || !isTelegramBusEnvelopeAuthorized(envelope, deps.authSecret) || envelope.method !== "sendArtifactDocument" ||
        !envelope.requestId.trim() || !envelope.requestId.isWellFormed() || !envelope.instanceId.isWellFormed() ||
        envelope.requestId.length > 512 || envelope.instanceId.length > 512 ||
        !envelope.registrationGeneration || envelope.registrationGeneration.length > 512) return undefined;
    const wire = parseTelegramBusArtifactDocument(envelope.args), follower = deps.followerRegistry.get(envelope.instanceId), operator = deps.getAllowedUserId?.();
    if (!wire || !follower || !follower.sessionId?.trim() || !follower.profileKey?.trim() ||
        !Number.isSafeInteger(follower.sessionGeneration) || follower.sessionGeneration! < 1 ||
        !deps.artifactApi?.callArtifactBytes || !deps.artifactApi.reserveArtifact || !deps.getTelegramProfile || operator !== wire.target.chatId ||
        !hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT) ||
        !hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT) ||
        follower.registrationGeneration !== envelope.registrationGeneration || follower.registrationIncarnation !== wire.registrationIncarnation ||
        follower.target?.chatId !== wire.target.chatId || follower.target.threadId !== wire.target.threadId ||
        wire.byteLength > Math.min(TELEGRAM_ARTIFACT_MAX_BYTES, deps.artifactMaxBytes ?? TELEGRAM_ARTIFACT_MAX_BYTES)) return undefined;
    const registration = deps.followerRegistry.captureArtifactRegistration?.(follower.instanceId, wire.registrationIncarnation), transport = deps.captureArtifactTransport?.();
    if (!registration || !transport) return undefined;
    const profile = deps.getTelegramProfile?.(), expiresAt = wire.expiresAt,
      nativeSend = deps.artifactApi.callArtifactBytes, reserveArtifact = deps.artifactApi.reserveArtifact, registry = deps.followerRegistry;
    let lost = false;
    const current = () => {
      try { lost ||= !registration() || !transport() || Date.now() >= expiresAt ||
        deps.getTelegramProfile?.() !== profile || deps.getAllowedUserId?.() !== operator ||
        deps.artifactApi?.callArtifactBytes !== nativeSend || deps.artifactApi.reserveArtifact !== reserveArtifact || deps.followerRegistry !== registry ||
        !hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT); }
      catch { lost = true; }
      return !lost;
    };
    return current() ? current : undefined;
  };
}

export function createTelegramBusLeaderEnvelopeHandler(
  deps: TelegramBusLeaderEnvelopeHandlerDeps,
): (
  envelope: TelegramBusEnvelope,
) => Promise<TelegramBusEnvelope> | TelegramBusEnvelope {
  const getNowMs = deps.getNowMs ?? Date.now;
  const captureArtifact = createTelegramBusArtifactAuthorityCapture(deps);
  const sendArtifact = async (envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>): Promise<TelegramBusEnvelope> => {
    const authority = captureArtifact(envelope), wire = parseTelegramBusArtifactDocument(envelope.args);
    if (!authority || !wire) return rejectTelegramBusRequest(envelope.requestId, "Artifact authority is unavailable.");
    let issued = false, messageId: number | undefined;
    const outcome = (effect: "not-issued" | "rejected" | "unknown" | "sent", reason: string, messageId?: number): TelegramBusEnvelope => ({
      kind: "bus.ack", requestId: Buffer.from(envelope.requestId, "utf8").toString("utf8"), ok: true,
      result: { version: 1, requestId: Buffer.from(envelope.requestId, "utf8").toString("utf8"), registrationIncarnation: Buffer.from(wire.registrationIncarnation, "utf8").toString("utf8"), effect, reason, httpIssued: issued, telegramRejected: effect === "rejected",
        ...(messageId !== undefined ? { messageId } : {}) },
    });
    const reservation = deps.artifactApi!.reserveArtifact!();
    if (!reservation) return outcome("not-issued", "capacity-exceeded");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(300_000, wire.expiresAt - Date.now())));
    timer.unref?.();
    const assertAuthority = () => { if (!authority() || controller.signal.aborted) throw new TelegramApiAuthorityError(issued); };
    try {
      assertAuthority();
      const bytes = Buffer.from(wire.bytesBase64, "base64");
      if (bytes.length !== wire.byteLength) return outcome("not-issued", "source-invalid");
      const result = await deps.artifactApi!.callArtifactBytes!<{ message_id?: number }>({
        chat_id: String(wire.target.chatId), ...(wire.target.threadId !== undefined ? { message_thread_id: String(wire.target.threadId) } : {}),
        ...(wire.caption !== undefined ? { caption: wire.caption } : {}),
      }, bytes, wire.fileName, { artifactReservation: reservation, assertAuthority, signal: controller.signal, onRequestIssued() { issued = true; }, onArtifactMessageId(id) { messageId = id; }, maxAttempts: 1, retryRateLimit: false, retrySafety: "non-idempotent" });
      if (Number.isSafeInteger(result?.message_id) && result.message_id! > 0) messageId = result.message_id;
      assertAuthority();
      if (!messageId) return outcome("unknown", "commit-unknown");
      deps.recordFollowerMessageOwnership?.({ follower: deps.followerRegistry.get(envelope.instanceId)!, chatId: wire.target.chatId, target: wire.target, messageId });
      assertAuthority();
      return outcome("sent", "sent", messageId);
    } catch (error) {
      if (messageId !== undefined) {
        try { const recorded: unknown = deps.recordRuntimeEvent?.("delivery", error, { operation: "artifact-ownership" }); if (recorded) void Promise.resolve(recorded).catch(() => undefined); } catch { /* Never retain raw errors in the ledger. */ }
      }
      return outcome(issued ? isTelegramApiRequestRejected(error, "sendDocument") ? "rejected" : "unknown" : "not-issued",
        issued ? isTelegramApiRequestRejected(error, "sendDocument") ? "transport-rejected" : "commit-unknown" : "invalidated", messageId);
    } finally { clearTimeout(timer); reservation.release(); }
  };
  const runFollowerMutation =
    deps.runFollowerMutation ?? createTelegramBusFollowerMutationRunner();
  const recipientObservations = new Map<
    string,
    {
      epoch: number | string;
      operator: number;
      profile: string | undefined;
      runtimeGeneration: number | undefined;
      follower: Omit<
        TelegramBusFollowerView,
        "lastHeartbeatMs" | "connectedAtMs" | "threadName"
      >;
    }
  >();
  /** Rename and reset share one generation- and target-fenced Workspace Thread name change. */
  const changeFollowerThreadName = (
    envelope: Extract<
      TelegramBusEnvelope,
      { kind: "follower.renameThread" | "follower.resetThreadName" }
    >,
    action: "rename" | "reset",
    apply:
      | ((
          follower: TelegramBusFollowerView,
        ) => Promise<{ threadName: string }> | { threadName: string })
      | undefined,
  ): Promise<TelegramBusEnvelope> =>
    runFollowerMutation(
      deps.followerRegistry.get(envelope.instanceId) ?? {
        instanceId: envelope.instanceId,
      },
      async (): Promise<TelegramBusEnvelope> => {
        const resolved = resolveRegisteredTelegramBusFollower(
          deps.followerRegistry,
          envelope.requestId,
          envelope.instanceId,
          envelope.registrationGeneration,
        );
        if ("rejection" in resolved) return resolved.rejection;
        const follower = resolved.follower;
        if (
          follower.target?.chatId !== envelope.target.chatId ||
          follower.target?.threadId !== envelope.target.threadId
        )
          return rejectTelegramBusRequest(
            envelope.requestId,
            "Stale Telegram bus follower registration generation.",
          );
        if (
          !hasTelegramBusCapability(
            deps.protocolIdentity,
            TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
          ) ||
          !hasTelegramBusCapability(
            follower.protocol,
            TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
          ) ||
          !apply
        )
          return rejectTelegramBusRequest(
            envelope.requestId,
            `Telegram Workspace Thread ${action} is unavailable.`,
          );
        try {
          const result = await apply(follower);
          const current = deps.followerRegistry.get(follower.instanceId);
          if (
            !current ||
            current.registrationGeneration !== follower.registrationGeneration
          )
            return rejectTelegramBusRequest(
              envelope.requestId,
              "Stale Telegram bus follower registration generation.",
            );
          deps.followerRegistry.register({
            ...current,
            threadName: result.threadName,
            connectedAtMs: current.connectedAtMs,
          });
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result,
          };
        } catch (error) {
          return rejectTelegramBusRequest(
            envelope.requestId,
            error instanceof Error
              ? error.message
              : `Telegram Workspace Thread ${action} failed.`,
          );
        }
      },
    );
  const observeRestoreRecipient = (follower: TelegramBusFollowerView): void => {
    if (
      !deps.authSecret ||
      !deps.onWorkspaceRestoreRecipientObserved ||
      !deps.getTelegramProfile ||
      !hasTelegramBusCapability(
        deps.protocolIdentity,
        TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
      ) ||
      !hasTelegramBusCapability(
        follower.protocol,
        TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
      )
    )
      return;
    const instanceId = follower.instanceId;
    const report = (error: unknown): void => {
      try {
        deps.recordRuntimeEvent?.("bus", error, {
          phase: "workspace-restore-recipient-observation",
          instanceId,
        });
      } catch {
        /* Optional observation diagnostics must not break transport liveness. */
      }
    };
    try {
      const epoch = deps.getCurrentLeaderEpoch?.(),
        operator = deps.getAllowedUserId?.();
      const runtimeGeneration =
        deps.getWorkspaceRestoreObservationGeneration?.();
      if (
        epoch === undefined ||
        operator === undefined ||
        (deps.getWorkspaceRestoreObservationGeneration &&
          runtimeGeneration === undefined)
      )
        return;
      const snapshot = structuredClone(follower);
      const observed = {
        epoch,
        operator,
        profile: deps.getTelegramProfile(),
        runtimeGeneration,
        follower: {
          ...snapshot,
          registrationIncarnation: undefined,
          lastHeartbeatMs: undefined,
          connectedAtMs: undefined,
          threadName: undefined,
        },
      };
      if (isDeepStrictEqual(recipientObservations.get(instanceId), observed))
        return;
      recipientObservations.set(instanceId, observed);
      const isCurrent = (): boolean => {
        const live = deps.followerRegistry.get(instanceId);
        return (
          recipientObservations.get(instanceId) === observed &&
          deps.getWorkspaceRestoreObservationGeneration?.() ===
            observed.runtimeGeneration &&
          hasTelegramBusCapability(
            deps.protocolIdentity,
            TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
          ) &&
          deps.getCurrentLeaderEpoch?.() === observed.epoch &&
          deps.getAllowedUserId?.() === observed.operator &&
          deps.getTelegramProfile?.() === observed.profile &&
          !!live &&
          hasTelegramBusCapability(
            live.protocol,
            TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
          ) &&
          isDeepStrictEqual(
            {
              ...live,
              registrationIncarnation: undefined,
              lastHeartbeatMs: undefined,
              connectedAtMs: undefined,
              threadName: undefined,
            },
            observed.follower,
          )
        );
      };
      // A heartbeat is a hint, not completion proof. Never await the listener before acknowledging it.
      void Promise.resolve()
        .then(() => {
          if (isCurrent())
            return deps.onWorkspaceRestoreRecipientObserved?.(
              structuredClone(snapshot),
              isCurrent,
            );
        })
        .catch(report)
        .finally(() => {
          if (recipientObservations.get(instanceId) === observed)
            recipientObservations.delete(instanceId);
        });
    } catch (error) {
      report(error);
    }
  };
  const handleAgentRequest = async (
    envelope: Extract<
      TelegramBusEnvelope,
      {
        kind: "follower.resolveAgentTarget" | "follower.routeAgentMessage";
      }
    >,
  ): Promise<TelegramBusEnvelope> => {
    const followerResolution = resolveRegisteredTelegramBusFollower(
      deps.followerRegistry,
      envelope.requestId,
      envelope.instanceId,
      envelope.registrationGeneration,
    );
    if ("rejection" in followerResolution) return followerResolution.rejection;
    const follower = followerResolution.follower;
    deps.followerRegistry.heartbeat(envelope.instanceId, getNowMs());
    if (envelope.kind === "follower.resolveAgentTarget") {
      const target = await deps.resolveAgentTarget?.(
        follower,
        envelope.selector,
      );
      return target
        ? {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result: target,
          }
        : rejectTelegramBusRequest(
            envelope.requestId,
            "Telegram agent target is unavailable or ambiguous.",
          );
    }
    if (!deps.routeAgentMessage) {
      return rejectTelegramBusRequest(
        envelope.requestId,
        "Telegram agent message routing is unavailable.",
      );
    }
    await deps.routeAgentMessage(follower, envelope.message);
    return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
  };
  const routeQueueHandoff = async (
    envelope: Extract<
      TelegramBusEnvelope,
      { kind: "follower.offerQueueHandoff" }
    >,
  ): Promise<TelegramBusEnvelope> => {
    const donorResolution = resolveRegisteredTelegramBusFollower(
      deps.followerRegistry,
      envelope.requestId,
      envelope.instanceId,
      envelope.registrationGeneration,
    );
    if ("rejection" in donorResolution) return donorResolution.rejection;
    const donor = donorResolution.follower;
    const recipient = deps.followerRegistry.get(envelope.recipientInstanceId);
    if (
      !hasTelegramBusCapability(
        deps.protocolIdentity,
        TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
      ) ||
      !hasTelegramBusCapability(
        donor.protocol,
        TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
      ) ||
      !hasTelegramBusCapability(
        recipient?.protocol,
        TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
      )
    ) {
      return rejectTelegramBusRequest(
        envelope.requestId,
        "Telegram queue handoff capability was not negotiated.",
      );
    }
    if (envelope.payload.queueLane === "steer" &&
        ![deps.protocolIdentity, donor.protocol, recipient?.protocol].every(hasTelegramBusSteerQueueHandoffCapability)) {
      return rejectTelegramBusRequest(envelope.requestId, "Steer queue handoff capability was not negotiated.");
    }
    if (
      !recipient?.registrationGeneration ||
      envelope.recipientRegistrationGeneration !==
        recipient.registrationGeneration
    ) {
      return rejectTelegramBusRequest(
        envelope.requestId,
        "Stale Telegram queue handoff recipient registration generation.",
      );
    }
    if (donor.instanceId === recipient.instanceId) {
      return rejectTelegramBusRequest(
        envelope.requestId,
        "Telegram queue handoff recipient must be another runtime.",
      );
    }
    if (deps.routeQueueHandoff) {
      const result = await deps.routeQueueHandoff(donor, envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        ...(result !== undefined ? { result } : {}),
      };
    }
    const recipientSocketPath =
      recipient.busSocketPath ??
      getTelegramBusFollowerSocketPath(recipient.instanceId);
    const response = await sendTelegramBusLocalEnvelope({
      socketPath: recipientSocketPath,
      timeoutMs: deps.timeoutMs,
      retry: getTelegramBusTransportRetryPolicy({
        endpoint: recipientSocketPath,
        operation: "operation",
      }),
      envelope: {
        kind: "leader.offerQueueHandoff",
        requestId: envelope.requestId,
        auth: envelope.auth,
        recipientInstanceId: recipient.instanceId,
        recipientRegistrationGeneration: recipient.registrationGeneration,
        donorInstanceId: donor.instanceId,
        donorProcessId: envelope.donorProcessId,
        donorProcessBirthId: envelope.donorProcessBirthId,
        donorSessionGeneration: envelope.donorSessionGeneration,
        donorAcquisitionId: envelope.donorAcquisitionId,
        donorAcquiredAtMs: envelope.donorAcquiredAtMs,
        handoffToken: envelope.handoffToken,
        payload: envelope.payload,
        sentAtMs: envelope.sentAtMs,
      },
    });
    if (response?.kind === "bus.ack" && response.ok) {
      deps.followerRegistry.heartbeat(donor.instanceId, getNowMs());
      deps.followerRegistry.heartbeat(recipient.instanceId, getNowMs());
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        ...(response.result !== undefined ? { result: response.result } : {}),
      };
    }
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message:
        response?.kind === "bus.ack"
          ? response.message
          : "Telegram queue handoff recipient did not acknowledge staging.",
    };
  };
  const forwardToFollower = async (
    envelope: Extract<
      TelegramBusEnvelope,
      {
        kind:
          | "leader.forwardCallback"
          | "leader.forwardReaction"
          | "leader.forwardMessage"
          | "leader.forwardEditedMessage";
      }
    >,
  ): Promise<TelegramBusEnvelope> => {
    const followerResolution = resolveRegisteredTelegramBusFollower(
      deps.followerRegistry,
      envelope.requestId,
      envelope.recipientInstanceId,
      envelope.recipientRegistrationGeneration,
    );
    if ("rejection" in followerResolution) return followerResolution.rejection;
    const follower = followerResolution.follower;
    const followerSocketPath =
      follower.busSocketPath ??
      getTelegramBusFollowerSocketPath(envelope.recipientInstanceId);
    deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
    try {
      const response = await sendTelegramBusLocalEnvelope({
        socketPath: followerSocketPath,
        envelope,
        timeoutMs: deps.timeoutMs,
        retry: getTelegramBusTransportRetryPolicy({
          endpoint: followerSocketPath,
          operation: "operation",
        }),
      });
      if (response?.kind === "bus.ack" && response.ok) {
        deps.followerRegistry.heartbeat(follower.instanceId, getNowMs());
        return {
          kind: "bus.ack",
          requestId: envelope.requestId,
          ok: true,
          ...(response.result !== undefined ? { result: response.result } : {}),
        };
      }
      const message =
        response?.kind === "bus.ack" ? response.message : undefined;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: false,
        message: message ?? "Telegram bus follower rejected forwarded update.",
      };
    } catch (error) {
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "Telegram bus follower forwarding failed.",
      };
    }
  };
  return async (envelope) => {
    const trafficClass = getTelegramBusEnvelopeTrafficClass(envelope);
    if (trafficClass === "response") {
      return rejectTelegramBusRequest(
        envelope.requestId,
        "Telegram bus response envelope cannot be used as a request.",
      );
    }
    if (!isTelegramBusEnvelopeAuthorized(envelope, deps.authSecret)) {
      return createUnauthorizedBusAck(envelope.requestId);
    }
    switch (envelope.kind) {
      case "bus.probe":
        // Liveness only: no registry, routing, journal or Bot API effect.
        return {
          kind: "bus.ack" as const,
          requestId: envelope.requestId,
          ok: true,
          protocol: deps.protocolIdentity,
        };
      case "follower.register":
      case "follower.restoreWorkspace": {
        const compatibility = getTelegramBusProtocolCompatibility({
          local: deps.protocolIdentity,
          remote: envelope.registration.protocol,
        });
        const readerCompatible = () => (deps.getRequiredWorkspaceReaderCapabilities?.() ?? []).every(capability =>
          hasTelegramBusCapability(deps.protocolIdentity, capability) &&
          hasTelegramBusCapability(envelope.registration.protocol, capability));
        const displayCompatible = () =>
          (deps.getThreadDisplayMode?.() ?? "names") === "names" ||
          (hasTelegramBusCapability(
            deps.protocolIdentity,
            TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
          ) &&
            hasTelegramBusCapability(
              envelope.registration.protocol,
              TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
            ));
        const restoringWorkspace =
          envelope.kind === "follower.restoreWorkspace";
        const recoverConnection = envelope.kind === "follower.register" && envelope.recoverConnection === true;
        const supportsConnectionRecovery = [deps.protocolIdentity, envelope.registration.protocol]
          .every(identity => hasTelegramBusCapability(identity, TELEGRAM_BUS_CAPABILITY_CONNECT_RECOVERY));
        const supportsWorkspaceAutoConnect =
          hasTelegramBusCapability(
            deps.protocolIdentity,
            TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
          ) &&
          hasTelegramBusCapability(
            envelope.registration.protocol,
            TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
          );
        if (
          !compatibility.compatible ||
          !displayCompatible() ||
          !readerCompatible() ||
          (envelope.registration.cwd !== undefined &&
            envelope.registration.sessionId === undefined) ||
          (restoringWorkspace && !supportsWorkspaceAutoConnect) ||
          (recoverConnection && !supportsConnectionRecovery)
        ) {
          return {
            kind: "bus.ack" as const,
            requestId: envelope.requestId,
            ok: false,
            protocol: deps.protocolIdentity,
            error: { code: "incompatible-protocol" as const },
            message: `Incompatible Telegram bus protocol: ${
              compatibility.reason ??
              (envelope.registration.cwd !== undefined &&
              envelope.registration.sessionId === undefined
                ? "missing-session-identity"
                : "missing-capability")
            }.`,
          };
        }
        if (!envelope.registration.registrationGeneration) {
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            protocol: deps.protocolIdentity,
            message:
              "Telegram follower registration requires an exact generation.",
          };
        }
        const registrationOperation = () =>
          runFollowerMutation(envelope.registration, async () => {
            try {
              const leaderEpoch = deps.getCurrentLeaderEpoch?.();
              const telegramProfile = deps.getTelegramProfile?.();
              const operatorUserId = deps.getAllowedUserId?.();
              const registrationCurrent = (): boolean =>
                readerCompatible() &&
                (!deps.getCurrentLeaderEpoch ||
                  deps.getCurrentLeaderEpoch() === leaderEpoch) &&
                (!deps.getTelegramProfile ||
                  deps.getTelegramProfile() === telegramProfile) &&
                (!deps.getAllowedUserId ||
                  deps.getAllowedUserId() === operatorUserId);
              if (deps.getCurrentLeaderEpoch && leaderEpoch === undefined) {
                throw new Error(
                  "Telegram follower registration requires leader ownership.",
                );
              }
              if (
                hasTelegramBusCapability(
                  deps.protocolIdentity,
                  TELEGRAM_BUS_CAPABILITY_WORKSPACE_RESTORE,
                ) &&
                !deps.commitFollowerRegistration
              )
                throw new Error(
                  "Workspace Restore registration publication protection is unavailable.",
                );
              // Admission may have waited behind a first schema write after the bootstrap's optimistic check.
              if (!registrationCurrent()) throw new Error("Telegram follower registration lost leader ownership.");
              const target = await deps.provisionFollowerTarget?.(
                envelope.registration,
                { existingWorkspaceBindingOnly: restoringWorkspace, ...(recoverConnection ? { recoverConnection: true } : {}) },
              );
              if (restoringWorkspace && !target) {
                return {
                  kind: "bus.ack" as const,
                  requestId: envelope.requestId,
                  ok: false,
                  protocol: deps.protocolIdentity,
                  error: { code: "workspace-binding-unavailable" as const },
                  message:
                    "No remembered Telegram Workspace Thread is available.",
                };
              }
              if (!registrationCurrent())
                throw new Error(
                  "Telegram follower registration lost leader ownership.",
                );
              if (!displayCompatible()) {
                throw new Error(
                  "Thread display mode changed; update or restart this follower before connecting.",
                );
              }
              const registeredTarget = target ?? envelope.registration.target;
              const registeredSlot = target?.slot ?? envelope.registration.slot;
              if (
                deps.provisionFollowerTarget &&
                registeredTarget?.threadId !== undefined &&
                (!registeredSlot || !/^[A-Z]$/u.test(registeredSlot))
              ) {
                throw new Error(
                  "Telegram Thread slot authority is unavailable.",
                );
              }
              const assertRegistrationPublishable = (): void => {
                if (!registrationCurrent())
                  throw new Error(
                    "Telegram follower registration lost leader ownership.",
                  );
                if (!displayCompatible())
                  throw new Error(
                    "Thread display mode changed; update or restart this follower before connecting.",
                  );
              };
              let publicationOpen = true;
              let published: TelegramBusFollowerView | undefined;
              const publish = (): void => {
                if (!publicationOpen)
                  throw new Error(
                    "Telegram follower registration publication is no longer available.",
                  );
                publicationOpen = false;
                assertRegistrationPublishable();
                published = deps.followerRegistry.register({
                  ...envelope.registration,
                  connectedAtMs: getNowMs(),
                  target: registeredTarget,
                  ...(registeredSlot ? { slot: registeredSlot } : {}),
                  ...((target?.threadName ?? envelope.registration.threadName)
                    ? {
                        threadName:
                          target?.threadName ??
                          envelope.registration.threadName,
                      }
                    : {}),
                });
              };
              try {
                if (deps.commitFollowerRegistration)
                  await deps.commitFollowerRegistration(
                    {
                      registration: envelope.registration,
                      target: registeredTarget,
                      slot: registeredSlot,
                    },
                    publish,
                  );
                else publish();
              } finally {
                publicationOpen = false;
              }
              if (!published)
                throw new Error(
                  "Telegram follower registration publication was not confirmed.",
                );
              assertRegistrationPublishable();
              const follower = deps.followerRegistry.get(
                envelope.registration.instanceId,
              );
              if (!follower)
                throw new Error(
                  "Telegram follower registration changed before acknowledgement.",
                );
              const {
                registrationIncarnation: _publishedArtifactIncarnation,
                lastHeartbeatMs: _publishedHeartbeat,
                connectedAtMs: _publishedAt,
                threadName: _publishedName,
                ...publishedIdentity
              } = published;
              const {
                registrationIncarnation: _artifactIncarnation,
                lastHeartbeatMs: _heartbeat,
                connectedAtMs: _connectedAt,
                threadName: _threadName,
                ...identity
              } = follower;
              if (!isDeepStrictEqual(publishedIdentity, identity))
                throw new Error(
                  "Telegram follower registration changed before acknowledgement.",
                );
              const apiIdentity = hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY) &&
                hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY);
              const registry = deps.followerRegistry, capture = registry.captureRegistration, get = registry.get, protocol = deps.protocolIdentity;
              const protocolSnapshot = apiIdentity ? structuredClone(protocol) : undefined, apiIncarnation = apiIdentity ? follower.registrationIncarnation : undefined, publishedIncarnation = published.registrationIncarnation;
              const apiRegistration = apiIdentity ? capture?.call(registry, follower.instanceId, envelope.requestId) : undefined;
              const assertApiRegistration = () => {
                if (apiIdentity && (!apiIncarnation || publishedIncarnation !== apiIncarnation || deps.followerRegistry !== registry || registry.captureRegistration !== capture || registry.get !== get ||
                  deps.protocolIdentity !== protocol || !isDeepStrictEqual(protocol, protocolSnapshot) || !apiRegistration || apiRegistration() !== true || get.call(registry, follower.instanceId)?.registrationIncarnation !== apiIncarnation))
                  throw new Error("Telegram API registration changed before acknowledgement.");
              };
              assertApiRegistration();
              const displayTitle = deps.getFollowerDisplayTitle?.(follower);
              deps.onFollowerRegistered?.();
              assertApiRegistration();
              return {
                kind: "bus.ack" as const,
                requestId: envelope.requestId,
                ok: true,
                protocol: deps.protocolIdentity,
                ...(registeredTarget
                  ? {
                      result: {
                        ...registeredTarget,
                        ...(apiIncarnation ? { apiRegistrationIncarnation: apiIncarnation } : {}),
                        ...((hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT) && hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT) ||
                          hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION) && hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION))
                          ? { registrationIncarnation: follower.registrationIncarnation } : {}),
                        ...(displayTitle !== undefined ? { displayTitle } : {}),
                      },
                    }
                  : {}),
              };
            } catch (error) {
              if (
                !restoringWorkspace &&
                deps.runWithWorkspaceCapacity &&
                error instanceof TelegramWorkspaceSlotUnavailableError
              )
                throw error;
              return {
                kind: "bus.ack" as const,
                requestId: envelope.requestId,
                ok: false,
                protocol: deps.protocolIdentity,
                message:
                  error instanceof Error
                    ? error.message
                    : "Telegram bus follower target provisioning failed.",
              };
            }
          });
        const register = () =>
          deps.runWorkspaceAdmission
            ? deps.runWorkspaceAdmission(
                {
                  operationId: `follower-registration:${envelope.requestId}`,
                  operationKind: "workspace.register-follower",
                  scopes: [{ kind: "profile" }],
                },
                registrationOperation,
              )
            : registrationOperation();
        try {
          return await (!restoringWorkspace && deps.runWithWorkspaceCapacity
            ? deps.runWithWorkspaceCapacity(register)
            : register());
        } catch (error) {
          return {
            kind: "bus.ack" as const,
            requestId: envelope.requestId,
            ok: false,
            protocol: deps.protocolIdentity,
            message:
              error instanceof Error
                ? error.message
                : "Telegram bus follower registration admission failed.",
          };
        }
      }
      case "follower.offerQueueHandoff":
        return routeQueueHandoff(envelope);
      case "follower.setThreadDisplayMode": {
        const epoch = deps.getCurrentLeaderEpoch?.();
        const current = () =>
          epoch !== undefined &&
          deps.getCurrentLeaderEpoch?.() === epoch &&
          deps.followerRegistry.get(envelope.instanceId)
            ?.registrationGeneration === envelope.registrationGeneration;
        const follower = deps.followerRegistry.get(envelope.instanceId);
        const requiredCapability =
          envelope.mode === "directory-snake" ||
          envelope.mode === "directory-title"
            ? TELEGRAM_BUS_CAPABILITY_DIRECTORY_DISPLAY_FORMAT
            : TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE;
        if (
          !current() ||
          !follower?.registrationGeneration ||
          !deps.applyThreadDisplayMode ||
          !hasTelegramBusCapability(
            deps.protocolIdentity,
            requiredCapability,
          ) ||
          !hasTelegramBusCapability(follower.protocol, requiredCapability)
        ) {
          return rejectTelegramBusRequest(
            envelope.requestId,
            "Thread display settings require current registration and compatible leader authority.",
          );
        }
        try {
          await deps.applyThreadDisplayMode(envelope.mode, current);
          if (!current())
            throw new Error(
              "Thread display setting completed for a stale registration.",
            );
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: true,
            result: { mode: envelope.mode },
          };
        } catch (error) {
          return {
            kind: "bus.ack",
            requestId: envelope.requestId,
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Thread display setting was not fully applied.",
          };
        }
      }
      case "follower.renameThread":
        return changeFollowerThreadName(
          envelope,
          "rename",
          deps.renameFollowerThread &&
            ((follower) =>
              deps.renameFollowerThread!(follower, envelope.threadName)),
        );
      case "follower.resetThreadName":
        return changeFollowerThreadName(
          envelope,
          "reset",
          deps.resetFollowerThreadName,
        );
      case "follower.publishSessionReplacement":
      case "follower.settleSessionReplacement": {
        const registeredFollower = deps.followerRegistry.get(
          envelope.instanceId,
        );
        return runFollowerMutation(
          registeredFollower ?? { instanceId: envelope.instanceId },
          async () => {
            const publish =
              envelope.kind === "follower.publishSessionReplacement";
            const operation = publish
              ? deps.publishFollowerSessionReplacement
              : deps.settleFollowerSessionReplacement;
            const epoch = deps.getCurrentLeaderEpoch?.();
            const follower = deps.followerRegistry.get(envelope.instanceId);
            const isCurrent = () =>
              epoch !== undefined &&
              deps.getCurrentLeaderEpoch?.() === epoch &&
              deps.followerRegistry.get(envelope.instanceId)
                ?.registrationGeneration === envelope.registrationGeneration;
            if (
              !follower?.registrationGeneration ||
              follower.registrationGeneration !==
                envelope.registrationGeneration ||
              !isCurrent() ||
              !operation ||
              !hasTelegramBusCapability(
                deps.protocolIdentity,
                TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
              ) ||
              !hasTelegramBusCapability(
                follower.protocol,
                TELEGRAM_BUS_CAPABILITY_SESSION_REPLACEMENT_INTENT,
              )
            ) {
              return rejectTelegramBusRequest(
                envelope.requestId,
                "Telegram session replacement requires current follower registration and compatible leader authority.",
              );
            }
            try {
              const committed = await operation(
                follower,
                envelope.intent,
                isCurrent,
              );
              if (!committed || !isCurrent()) {
                return {
                  kind: "bus.ack" as const,
                  requestId: envelope.requestId,
                  ok: false,
                  message: publish
                    ? "Telegram session replacement intent was not persisted."
                    : "Telegram session replacement intent was not claimed.",
                };
              }
              return {
                kind: "bus.ack" as const,
                requestId: envelope.requestId,
                ok: true,
                result: { committed: true },
              };
            } catch (error) {
              return {
                kind: "bus.ack" as const,
                requestId: envelope.requestId,
                ok: false,
                message:
                  error instanceof Error
                    ? error.message
                    : "Telegram session replacement request failed.",
              };
            }
          },
        );
      }
      case "follower.disconnect": {
        const registeredFollower = deps.followerRegistry.get(
          envelope.instanceId,
        );
        return runFollowerMutation(
          registeredFollower ?? { instanceId: envelope.instanceId },
          async () => {
            const follower = deps.followerRegistry.get(envelope.instanceId);
            if (!follower) {
              return rejectTelegramBusRequest(
                envelope.requestId,
                "Unknown Telegram bus follower instance.",
              );
            }
            if (
              !follower.registrationGeneration ||
              !envelope.registrationGeneration ||
              envelope.registrationGeneration !==
                follower.registrationGeneration
            ) {
              return rejectTelegramBusRequest(
                envelope.requestId,
                "Stale Telegram bus follower registration generation.",
              );
            }
            await deps.onFollowerDisconnected?.(follower);
            const current = deps.followerRegistry.get(follower.instanceId);
            if (
              current?.registrationGeneration !==
              follower.registrationGeneration
            ) {
              return rejectTelegramBusRequest(
                envelope.requestId,
                "Stale Telegram bus follower registration generation.",
              );
            }
            deps.followerRegistry.remove(follower.instanceId);
            return {
              kind: "bus.ack" as const,
              requestId: envelope.requestId,
              ok: true,
            };
          },
        );
      }
      case "follower.heartbeat": {
        const current = resolveRegisteredTelegramBusFollower(
          deps.followerRegistry,
          envelope.requestId,
          envelope.instanceId,
          envelope.registrationGeneration,
        );
        if ("rejection" in current) return current.rejection;
        const follower = deps.followerRegistry.heartbeat(
          envelope.instanceId,
          getNowMs(),
        );
        if (follower) observeRestoreRecipient(follower);
        const displayTitle = follower
          ? deps.getFollowerDisplayTitle?.(follower)
          : undefined;
        const threadCapability = follower ? deps.getThreadCapability?.() : undefined;
        return follower
          ? {
              kind: "bus.ack",
              requestId: envelope.requestId,
              ok: true,
              result: {
                ...(displayTitle !== undefined ? { displayTitle } : {}),
                ...(threadCapability !== undefined ? { threadCapability } : {}),
                eligibleElectionSlots: deps.followerRegistry
                  .list()
                  .filter(
                    (candidate) =>
                      !deps.protocolIdentity.capabilities.includes(
                        TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
                      ) ||
                      candidate.protocol?.capabilities.includes(
                        TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
                      ),
                  )
                  .map((candidate) => candidate.slot)
                  .filter(
                    (slot): slot is string =>
                      typeof slot === "string" && /^[A-Z]$/.test(slot),
                  )
                  .sort(),
              },
            }
          : rejectTelegramBusRequest(
              envelope.requestId,
              "Unknown Telegram bus follower instance.",
            );
      }
      case "follower.resolveAgentTarget":
      case "follower.routeAgentMessage":
        return handleAgentRequest(envelope);
      case "leader.forwardCallback":
      case "leader.forwardReaction":
      case "leader.forwardMessage":
      case "leader.forwardEditedMessage":
        return forwardToFollower(envelope);
      case "follower.deliverSelectedMenu": {
        const deliver = deps.selectedMenuDelivery,
          secret = deps.authSecret,
          protocol = structuredClone(deps.protocolIdentity);
        const current = () =>
          !!secret &&
          deps.authSecret === secret &&
          deps.selectedMenuDelivery === deliver &&
          isDeepStrictEqual(deps.protocolIdentity, protocol) &&
          hasTelegramBusCapability(
            protocol,
            TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
          );
        if (!deliver || !current())
          return rejectTelegramBusRequest(
            envelope.requestId,
            "Selected-menu delivery is unavailable.",
          );
        return deliver(structuredClone(envelope), current);
      }
      case "follower.callApi":
        if (envelope.method === "sendArtifactDocument") return sendArtifact(envelope);
        return handleFollowerApiCall(envelope, deps, getNowMs);
      default:
        return rejectTelegramBusRequest(
          envelope.requestId,
          "Telegram bus envelope is not handled by this leader.",
        );
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getFollowerApiMethodAndBody(
  envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>,
): {
  apiMethod: string;
  body?: Record<string, unknown>;
} {
  if (envelope.method === "call" || envelope.method === "callMultipart") {
    return {
      apiMethod: typeof envelope.args[0] === "string" ? envelope.args[0] : "",
      body: asRecord(envelope.args[1]),
    };
  }
  return { apiMethod: envelope.method, body: asRecord(envelope.args[0]) };
}

function getSentMessageIds(result: unknown): number[] {
  const values = Array.isArray(result) ? result : [result];
  return values
    .map((value) => asInteger(asRecord(value)?.message_id))
    .filter((messageId): messageId is number => messageId !== undefined);
}

function recordFollowerApiMessageOwnership(input: {
  envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>;
  follower: TelegramBusFollowerView;
  result: unknown;
  record?: TelegramBusFollowerMessageOwnershipRecorder;
}): void {
  if (!input.record) return;
  const { apiMethod, body } = getFollowerApiMethodAndBody(input.envelope);
  if (
    apiMethod !== "sendMessage" &&
    apiMethod !== "sendRichMessage" &&
    apiMethod !== "sendPhoto" &&
    apiMethod !== "sendDocument" &&
    apiMethod !== "sendVoice" &&
    apiMethod !== "sendMediaGroup"
  ) {
    return;
  }
  // Business messages have a separate namespace even when all numeric locators equal a bot-chat message.
  if (body && Object.hasOwn(body, "business_connection_id") || (Array.isArray(input.result) ? input.result : [input.result]).some(value => {
    const message = asRecord(value); return message && Object.hasOwn(message, "business_connection_id");
  })) return;
  const chatId = asInteger(body?.chat_id) ?? input.follower.target?.chatId;
  if (chatId === undefined) return;
  const threadId =
    asInteger(body?.message_thread_id) ?? input.follower.target?.threadId;
  const target = threadId !== undefined ? { chatId, threadId } : { chatId };
  for (const messageId of getSentMessageIds(input.result)) {
    input.record({
      follower: input.follower,
      chatId,
      messageId,
      target,
    });
  }
}

async function handleFollowerApiCall(
  envelope: Extract<TelegramBusEnvelope, { kind: "follower.callApi" }>,
  deps: TelegramBusLeaderEnvelopeHandlerDeps,
  getNowMs: () => number,
): Promise<TelegramBusEnvelope> {
  const initial = getFollowerApiMethodAndBody(envelope);
  const attachment = initial.apiMethod === "sendMessage" && getTelegramAttachmentControlId(initial.body?.reply_markup);
  const input = attachment || initial.apiMethod === "sendMessage" && getTelegramTextInputControlId(initial.body?.reply_markup);
  const wireOptions = asRecord(envelope.args[2]);
  const scopedApi = !!deps.captureApiTransport && !input && envelope.method === "call" && envelope.args.length === 3 &&
    wireOptions?.maxAttempts === 1 && wireOptions.retrySafety === "non-idempotent";
  if (envelope.apiRegistrationIncarnation !== undefined && !scopedApi)
    return rejectTelegramBusRequest(envelope.requestId, "Original API registration is unavailable.");
  if (attachment && (!deps.authSecret || !isTelegramBusEnvelopeAuthorized(envelope, deps.authSecret) || !deps.authorizeFollowerApiCall))
    return rejectTelegramBusRequest(envelope.requestId, "Attachment publication authority is unavailable.");
  const originalBody = attachment ? structuredClone(initial.body) : undefined;
  const attachmentScope = { registry: deps.followerRegistry, get: deps.followerRegistry.get, query: deps.getAttachmentReceiverBotId,
    capture: deps.captureInputPublication, authorize: deps.authorizeFollowerApiCall, call: deps.callApi, secret: deps.authSecret,
    epoch: deps.getCurrentLeaderEpoch, profile: deps.getTelegramProfile, operator: deps.getAllowedUserId,
    protocol: deps.protocolIdentity, protocolSnapshot: attachment ? structuredClone(deps.protocolIdentity) : undefined };
  let attachmentEpoch: number | string | undefined, attachmentProfile: string | undefined, attachmentOperator: number | undefined;
  try {
    if (attachment) {
      attachmentEpoch = attachmentScope.epoch?.(); attachmentProfile = attachmentScope.profile?.(); attachmentOperator = attachmentScope.operator?.();
    }
  } catch { return rejectTelegramBusRequest(envelope.requestId, "Attachment publication scope is unavailable."); }
  const attachmentBindingsCurrent = () => deps.followerRegistry === attachmentScope.registry && attachmentScope.registry.get === attachmentScope.get &&
    deps.getAttachmentReceiverBotId === attachmentScope.query && deps.captureInputPublication === attachmentScope.capture &&
    deps.authorizeFollowerApiCall === attachmentScope.authorize && deps.callApi === attachmentScope.call && deps.authSecret === attachmentScope.secret &&
    deps.getCurrentLeaderEpoch === attachmentScope.epoch && deps.getTelegramProfile === attachmentScope.profile && deps.getAllowedUserId === attachmentScope.operator &&
    deps.protocolIdentity === attachmentScope.protocol && isDeepStrictEqual(deps.protocolIdentity, attachmentScope.protocolSnapshot) &&
    attachmentEpoch !== undefined && !!attachmentProfile && Number.isSafeInteger(attachmentOperator) && attachmentOperator! > 0 &&
    attachmentScope.epoch?.() === attachmentEpoch && attachmentScope.profile?.() === attachmentProfile && attachmentScope.operator?.() === attachmentOperator;
  let attachmentInvoked = false, attachmentIssued = false;
  // Guarded ordinary calls snapshot their wire descriptor; omitted/legacy calls keep prior semantics.
  if (input || scopedApi) envelope = structuredClone(envelope);
  const followerResolution = resolveRegisteredTelegramBusFollower(
    deps.followerRegistry,
    envelope.requestId,
    envelope.instanceId,
    envelope.registrationGeneration,
  );
  if ("rejection" in followerResolution) return followerResolution.rejection;
  const follower = followerResolution.follower;
  const originalFollower = attachment ? structuredClone(follower) : undefined;
  let assertBroker: ((authorize?: boolean) => void) | undefined, brokerArgs: unknown[] | undefined, brokerIssued = false, brokerInvoked = false, brokerCompleted = false;
  let brokerProtocol: TelegramBusProtocolIdentity | undefined;
  if (scopedApi) {
    const ports = { registry: deps.followerRegistry, capture: deps.followerRegistry.captureRegistration, transport: deps.captureApiTransport,
      authorize: deps.authorizeFollowerApiCall, call: deps.callApi, record: deps.recordFollowerMessageOwnership, secret: deps.authSecret,
      epoch: deps.getCurrentLeaderEpoch, profile: deps.getTelegramProfile, operator: deps.getAllowedUserId, protocol: deps.protocolIdentity };
    try {
      if (!ports.secret || !isTelegramBusEnvelopeAuthorized(envelope, ports.secret) || !ports.authorize) throw new Error("Original follower API authority is unavailable.");
      const registration = ports.capture?.call(ports.registry, follower.instanceId, envelope.registrationGeneration!), transport = ports.transport?.();
      const epoch = ports.epoch?.(), profile = ports.profile?.() ?? "default", operator = ports.operator?.(), protocol = structuredClone(ports.protocol);
      if (!registration || !transport || !ports.profile || epoch === undefined || !profile || !Number.isSafeInteger(operator) || operator! <= 0 || follower.target?.chatId !== operator)
        throw new Error("Original follower API authority is unavailable.");
      if (hasTelegramBusCapability(protocol, TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY) && hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_GUARDED_API_AUTHORITY)) brokerProtocol = protocol;
      const registeredApi = hasTelegramBusCapability(protocol, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY) && hasTelegramBusCapability(follower.protocol, TELEGRAM_BUS_CAPABILITY_API_REGISTRATION_AUTHORITY);
      const apiIncarnation = follower.registrationIncarnation;
      if (registeredApi && (!brokerProtocol || !apiIncarnation || envelope.apiRegistrationIncarnation !== apiIncarnation) ||
        !registeredApi && envelope.apiRegistrationIncarnation !== undefined) throw new Error("Original API registration is unavailable.");
      const originalArgs = structuredClone(envelope.args), original = structuredClone(follower);
      brokerArgs = structuredClone(envelope.args);
      const nativeArgs = brokerArgs;
      let lost = false, checking = false;
      const bound = () => !lost && deps.followerRegistry === ports.registry && ports.registry.captureRegistration === ports.capture && deps.captureApiTransport === ports.transport &&
        deps.authorizeFollowerApiCall === ports.authorize && deps.callApi === ports.call && deps.recordFollowerMessageOwnership === ports.record && deps.authSecret === ports.secret &&
        deps.getCurrentLeaderEpoch === ports.epoch && deps.getTelegramProfile === ports.profile && deps.getAllowedUserId === ports.operator && deps.protocolIdentity === ports.protocol;
      const current = () => bound() && (!registeredApi || envelope.apiRegistrationIncarnation === apiIncarnation) && ports.epoch?.() === epoch && (ports.profile?.() ?? "default") === profile && ports.operator?.() === operator &&
        isDeepStrictEqual(ports.protocol, protocol) && nativeArgs.length === originalArgs.length && isDeepStrictEqual(nativeArgs.slice(0, 2), originalArgs.slice(0, 2)) && bound();
      assertBroker = (authorize = true) => {
        if (lost || checking) { lost = true; throw new TelegramApiAuthorityError(brokerIssued); }
        checking = true;
        try {
          if (!current() || registration() !== true || transport() !== true || authorize && !ports.authorize!({ follower: structuredClone(original), method: envelope.method, args: structuredClone(originalArgs) }))
            throw new TelegramApiAuthorityError(brokerIssued);
          if (transport() !== true || !current() || registration() !== true || !bound()) throw new TelegramApiAuthorityError(brokerIssued);
        } catch (error) { lost = true; throw error; }
        finally { checking = false; }
      };
      nativeArgs[2] = { ...asRecord(nativeArgs[2]), assertAuthority: assertBroker, onRequestIssued() { brokerIssued = true; },
        maxAttempts: 1, retryRateLimit: false, retrySafety: "non-idempotent" };
      assertBroker(false);
    } catch { return rejectTelegramBusRequest(envelope.requestId, "Original follower API authority is unavailable."); }
  }
  deps.followerRegistry.heartbeat(envelope.instanceId, getNowMs());
  if (
    deps.authorizeFollowerApiCall &&
    !deps.authorizeFollowerApiCall({
      follower: scopedApi ? structuredClone(follower) : follower,
      method: envelope.method,
      args: scopedApi ? structuredClone(envelope.args) : envelope.args,
    })
  ) {
    if (assertBroker) {
      try { assertBroker(false); }
      catch { return rejectTelegramBusRequest(envelope.requestId, "Original follower API authority is unavailable."); }
    }
    const apiMethod = getFollowerApiMethodAndBody(envelope).apiMethod;
    return {
      ...rejectTelegramBusRequest(
        envelope.requestId,
        TELEGRAM_BUS_FOLLOWER_API_NOT_ALLOWED_MESSAGE,
      ),
      ...(brokerProtocol ? { protocol: brokerProtocol } : {}),
      // Only this pre-dispatch authorizer refusal certifies that the API method was not called.
      ...(/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(apiMethod)
        ? { error: { code: "follower-api-not-allowed" as const, method: apiMethod } }
        : {}),
    };
  }
  if (!deps.callApi) {
    return rejectTelegramBusRequest(
      envelope.requestId,
      "Telegram bus leader does not expose API calling.",
    );
  }
  try {
    let recordInput: ((messageId: number) => void) | undefined, assertInputReceiver: (() => void) | undefined;
    let attachmentPublication: { botId: number; target: TelegramTarget } | undefined;
    if (attachment && (!hasTelegramBusCapability(deps.protocolIdentity, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION) ||
      !hasTelegramBusCapability(originalFollower?.protocol, TELEGRAM_BUS_CAPABILITY_ATTACHMENT_PUBLICATION) ||
      !originalFollower?.registrationIncarnation || envelope.attachmentRegistrationIncarnation !== originalFollower.registrationIncarnation))
      throw new Error("Attachment publication peer contract is unavailable.");
    if (input) {
      const { apiMethod, body } = getFollowerApiMethodAndBody(envelope);
      const label = attachment ? "Attachment" : "Text Input";
      const readControl = attachment ? getTelegramAttachmentControlId : getTelegramTextInputControlId;
      if (apiMethod !== "sendMessage" || readControl(body?.reply_markup) !== input || !Number.isSafeInteger(body?.chat_id) || (body!.chat_id as number) <= 0 ||
          (body?.message_thread_id !== undefined && (!Number.isSafeInteger(body.message_thread_id) || (body.message_thread_id as number) <= 0))) {
        throw new Error(`${label} publication target is unavailable.`);
      }
      const target = Object.freeze({ chatId: body!.chat_id as number,
        ...(body?.message_thread_id !== undefined ? { threadId: body.message_thread_id as number } : {}) });
      if (attachment && (!attachmentBindingsCurrent() || target.chatId !== attachmentOperator)) throw new Error("Attachment publication scope is unavailable.");
      const query = attachment ? attachmentScope.query : deps.getTextInputReceiverBotId;
      const read = query ? (candidate: Readonly<TelegramTarget>) => query(attachment ? structuredClone(originalFollower!) : follower, candidate) : undefined;
      const botId = readTelegramTextInputReceiverBotId(read, target);
      if (botId === undefined) throw new Error(`${label} receiver is unavailable.`);
      assertInputReceiver = () => {
        if (readTelegramTextInputReceiverBotId(read, target) !== botId) throw new Error(`${label} receiver changed during publication.`);
      };
      if (attachment && !attachmentBindingsCurrent()) throw new Error("Attachment publication scope is unavailable.");
      recordInput = deps.captureInputPublication?.(attachment ? structuredClone(originalFollower!) : follower, target);
      if (!recordInput) throw new Error(`${label} publication ownership is unavailable.`);
      if (attachment) {
        attachmentPublication = { botId, target };
        if (envelope.method !== "call" || envelope.args.length !== 2 || !isDeepStrictEqual(body, originalBody))
          throw new Error("Attachment publication descriptor is unavailable.");
        const original = recordInput as Partial<TelegramOriginalPublicationWriter>, assertOrigin = original.assertCurrent;
        if (!assertOrigin) throw new Error("Attachment publication scope is unavailable.");
        const captured = originalFollower!, { registry, get, authorize } = attachmentScope;
        let live = true, checking = false;
        const bound = () => live && attachmentBindingsCurrent() && original.assertCurrent === assertOrigin &&
          envelope.attachmentRegistrationIncarnation === captured.registrationIncarnation && isDeepStrictEqual(getFollowerApiMethodAndBody(envelope).body, originalBody) &&
          getFollowerApiMethodAndBody(envelope).apiMethod === "sendMessage";
        assertInputReceiver = () => {
          if (checking) { live = false; throw new Error("Attachment publication scope is unavailable."); }
          checking = true;
          try {
            const current = get.call(registry, captured.instanceId);
            if (!bound() || !current || current.registrationIncarnation !== captured.registrationIncarnation || !isSameTelegramBusFollowerRegistration(current, captured) ||
              current.target?.chatId !== captured.target?.chatId || current.target?.threadId !== captured.target?.threadId ||
              !authorize?.({ follower: structuredClone(captured), method: envelope.method, args: envelope.args }) ||
              readTelegramTextInputReceiverBotId(read, target) !== botId) throw new Error("Attachment publication scope is unavailable.");
            assertOrigin.call(original);
            if (!bound() || get.call(registry, captured.instanceId)?.registrationIncarnation !== captured.registrationIncarnation)
              throw new Error("Attachment publication scope is unavailable.");
          } catch (error) { live = false; throw error; }
          finally { checking = false; }
        };
      }
    }
    if (attachment) assertInputReceiver!();
    const args = attachment ? ["sendMessage", getFollowerApiMethodAndBody(envelope).body, {
      assertAuthority: assertInputReceiver, onRequestIssued() { attachmentIssued = true; }, maxAttempts: 1,
      retryRateLimit: false, retrySafety: "non-idempotent" as const,
    }] : envelope.args;
    assertBroker?.();
    attachmentInvoked = !!attachment;
    brokerInvoked = !!assertBroker;
    const result = await deps.callApi(envelope.method, brokerArgs ?? args);
    brokerCompleted = !!assertBroker;
    assertBroker?.();
    if (assertBroker && (initial.apiMethod === "sendMessage" || initial.apiMethod === "sendRichMessage")) {
      const body = getFollowerApiMethodAndBody(envelope).body, chatId = asInteger(body?.chat_id), threadId = asInteger(body?.message_thread_id);
      const message = asRecord(result), id = message && Object.getOwnPropertyDescriptor(message, "message_id")?.value;
      const chat = message && Object.getOwnPropertyDescriptor(message, "chat"), thread = message && Object.getOwnPropertyDescriptor(message, "message_thread_id");
      const business = message && Object.getOwnPropertyDescriptor(message, "business_connection_id");
      const echoedChat = asRecord(chat?.value), echoedChatId = echoedChat && Object.getOwnPropertyDescriptor(echoedChat, "id")?.value;
      // Legacy missing target echoes remain independent; explicit contradictory locators cannot own this namespace.
      if (chatId === undefined || body?.message_thread_id !== undefined && (threadId === undefined || threadId <= 0) ||
        !Number.isSafeInteger(id) || id <= 0 || chat && echoedChatId !== chatId ||
        thread && (!Number.isSafeInteger(thread.value) || thread.value <= 0 || thread.value !== threadId) ||
        business && (typeof business.value !== "string" || business.value !== body?.business_connection_id))
        throw new TelegramApiCommitUnknownError(initial.apiMethod, new Error("Original follower publication acknowledgement is unavailable."));
      assertBroker();
    }
    if (recordInput) {
      try {
        assertInputReceiver?.();
        const messageId = asRecord(result)?.message_id;
        if (!Number.isSafeInteger(messageId) || (messageId as number) <= 0) throw new Error("Publication receipt is unavailable.");
        recordInput(messageId as number);
        if (attachment) assertInputReceiver!();
      } catch (error) {
        throw new TelegramApiCommitUnknownError("sendMessage", error);
      }
    } else recordFollowerApiMessageOwnership({ envelope, follower, result, record: deps.recordFollowerMessageOwnership });
    assertBroker?.();
    const receipt = attachment ? parseTelegramBusAttachmentPublicationReceipt({ version: 1, requestId: envelope.requestId,
      nonce: attachment, instanceId: originalFollower!.instanceId, registrationGeneration: originalFollower!.registrationGeneration,
      registrationIncarnation: originalFollower!.registrationIncarnation,
      ...attachmentPublication, messageId: asRecord(result)?.message_id }) : undefined;
    if (attachment && !receipt) throw new TelegramApiCommitUnknownError("sendMessage", new Error("Attachment publication receipt is unavailable."));
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      ...(brokerProtocol ? { protocol: brokerProtocol } : attachment ? { protocol: structuredClone(deps.protocolIdentity) } : {}),
      result: attachment ? { ...asRecord(result), [TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT]: receipt } : result,
    };
  } catch (error) {
    if (brokerInvoked && !isTelegramApiCommitUnknownError(error) && (brokerIssued || brokerCompleted || !(error instanceof TelegramApiAuthorityError && !error.requestIssued)) &&
      !isTelegramApiRequestRejected(error, initial.apiMethod)) error = new TelegramApiCommitUnknownError(initial.apiMethod, error);
    if ((attachment && attachmentInvoked && !isTelegramApiCommitUnknownError(error) &&
      (attachmentIssued || !(error instanceof TelegramApiAuthorityError && !error.requestIssued)) && !isTelegramApiRequestRejected(error, "sendMessage")) ||
      (input && error instanceof TelegramApiAuthorityError && error.requestIssued)) {
      error = new TelegramApiCommitUnknownError("sendMessage", error);
    }
    const staleTarget = Threads.isTelegramTopicTargetStaleError(error)
      ? getTelegramApiErrorRequestTarget(error)
      : undefined;
    return {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Telegram bus API call failed.",
      ...(brokerProtocol ? { protocol: brokerProtocol } : {}),
      ...(staleTarget
        ? {
            error: {
              code: "stale-target" as const,
              chatId: staleTarget.chatId,
              threadId: staleTarget.threadId,
            },
          }
        : isTelegramApiCommitUnknownError(error)
          ? {
              error: {
                code: "commit-unknown" as const,
                method: error.method,
              },
            }
          : {}),
    };
  }
}

export function createTelegramBusLeaderRuntime<TContext>(
  deps: TelegramBusLeaderRuntimeDeps<TContext>,
): TelegramBusLeaderRuntime<TContext> {
  const getNowMs = deps.getNowMs ?? Date.now;
  const followerPruneIntervalMs = deps.followerPruneIntervalMs ?? 1000;
  const followerStaleAfterMs =
    deps.followerStaleAfterMs ?? TELEGRAM_BUS_FOLLOWER_STALE_AFTER_MS;
  const runFollowerMutation = createTelegramBusFollowerMutationRunner();
  let pruneInterval: ReturnType<typeof setInterval> | undefined;
  let pruneGeneration = 0;
  let prunePromise: Promise<void> | undefined;
  type PreservationObservation = {
    follower: TelegramBusFollowerView;
    operationId: string;
    registration: ReturnType<
      TelegramBusFollowerRegistry["observeUnregistered"]
    >;
    isCurrent: () => boolean;
  };
  const pendingPreservations = new Map<string, PreservationObservation>();
  const forgetPreservation = (
    observation: PreservationObservation | undefined,
  ) => {
    if (!observation) return;
    if (
      pendingPreservations.get(observation.follower.instanceId) === observation
    ) {
      pendingPreservations.delete(observation.follower.instanceId);
    }
    observation.registration.release();
  };
  const stopPruning = () => {
    pruneGeneration += 1;
    for (const observation of pendingPreservations.values())
      forgetPreservation(observation);
    if (pruneInterval) clearInterval(pruneInterval);
    pruneInterval = undefined;
    prunePromise = undefined;
  };
  const recordPruneEvent = (
    error: unknown,
    details: Record<string, unknown>,
  ): void => {
    try {
      deps.recordRuntimeEvent?.("bus", error, details);
    } catch {
      // Prune diagnostics cannot replace lifecycle-owned reconciliation.
    }
  };
  const pruneFollowers = async (expectedGeneration: number) => {
    const epoch = deps.getCurrentLeaderEpoch?.();
    const profile = deps.getTelegramProfile?.();
    const isCurrent = (): boolean =>
      pruneGeneration === expectedGeneration &&
      deps.getTelegramProfile?.() === profile &&
      (!deps.getCurrentLeaderEpoch ||
        (epoch !== undefined && deps.getCurrentLeaderEpoch() === epoch));
    try {
      await localServer.ensureEndpoint();
    } catch (error) {
      recordPruneEvent(error, { phase: "leader-endpoint-recovery" });
    }
    if (pruneGeneration !== expectedGeneration) return;
    for (const observation of pendingPreservations.values()) {
      if (!observation.isCurrent()) forgetPreservation(observation);
    }
    if (!isCurrent()) return;
    const attempts: {
      follower: TelegramBusFollowerView;
      observation?: PreservationObservation;
      fresh: boolean;
    }[] = [...pendingPreservations.values()].map((observation) => ({
      follower: observation.follower,
      observation,
      fresh: false,
    }));
    const removed = deps.followerRegistry.pruneStale(
      getNowMs(),
      followerStaleAfterMs,
    );
    for (const follower of removed) {
      forgetPreservation(pendingPreservations.get(follower.instanceId));
      let observation: PreservationObservation | undefined;
      if (
        deps.onFollowerConfirmedDeadPreserved &&
        epoch !== undefined &&
        follower.registrationGeneration &&
        Number.isSafeInteger(follower.pid) &&
        follower.pid! > 0 &&
        Number.isSafeInteger(follower.target?.threadId) &&
        follower.target!.threadId! > 0
      ) {
        if (pendingPreservations.size < TELEGRAM_WORKSPACE_SLOTS.length) {
          const registration =
            deps.followerRegistry.observeUnregistered(follower);
          let current = true;
          observation = {
            follower,
            registration,
            // Reuse exact admission authority after a lost acquisition acknowledgement.
            operationId: createTelegramWorkspaceAdmissionOperationId(),
            isCurrent() {
              current = current && isCurrent() && registration.isCurrent();
              return current;
            },
          };
          pendingPreservations.set(follower.instanceId, observation);
        } else {
          recordPruneEvent(
            "Telegram follower preservation observation capacity exhausted; retaining binding",
            {
              phase: "follower-preservation-capacity",
              instanceId: follower.instanceId,
            },
          );
        }
      }
      attempts.push({ follower, observation, fresh: true });
    }
    for (const { follower, observation, fresh } of attempts) {
      if (!isCurrent()) return;
      if (observation && !observation.isCurrent()) {
        forgetPreservation(observation);
        continue;
      }
      let processConfirmedDead = false;
      if (
        follower.pid !== undefined &&
        Number.isSafeInteger(follower.pid) &&
        follower.pid > 0 &&
        deps.isFollowerProcessAlive
      ) {
        try {
          processConfirmedDead =
            deps.isFollowerProcessAlive(follower.pid) === false;
        } catch (error) {
          if (fresh)
            recordPruneEvent(error, {
              phase: "follower-process-liveness",
              instanceId: follower.instanceId,
              pid: follower.pid,
            });
        }
      }
      if (!processConfirmedDead) {
        if (fresh)
          recordPruneEvent(
            "Telegram bus follower heartbeat stale; preserving thread binding",
            {
              phase: "follower-pruned",
              instanceId: follower.instanceId,
              processLiveness:
                follower.pid === undefined || !deps.isFollowerProcessAlive
                  ? "unknown"
                  : "alive-or-unknown",
            },
          );
        continue;
      }
      let cleanupEnabled: boolean | undefined;
      try {
        cleanupEnabled = await deps.shouldCleanupConfirmedDeadFollower?.();
      } catch (error) {
        recordPruneEvent(error, {
          phase: "follower-confirmed-dead-cleanup-policy",
          instanceId: follower.instanceId,
          pid: follower.pid,
        });
      }
      if (!isCurrent()) {
        forgetPreservation(observation);
        return;
      }
      const recordPreserved = () =>
        recordPruneEvent(
          "Telegram bus follower process confirmed dead; preserving thread binding",
          {
            phase: "follower-confirmed-dead-preserved",
            instanceId: follower.instanceId,
            pid: follower.pid,
            cleanupEnabled,
          },
        );
      // Deferred observations authorize only non-destructive publication, never deletion retries.
      if (cleanupEnabled === true && !fresh) {
        forgetPreservation(observation);
        recordPreserved();
        continue;
      }
      const onConfirmedDead =
        cleanupEnabled === true
          ? deps.onFollowerConfirmedDead
          : cleanupEnabled === false && observation
            ? deps.onFollowerConfirmedDeadPreserved
            : undefined;
      if (!onConfirmedDead) {
        if (cleanupEnabled === true) forgetPreservation(observation);
        if (fresh) recordPreserved();
        continue;
      }
      const findReplacement = () =>
        deps.followerRegistry
          .list()
          .find(
            (candidate) =>
              candidate.instanceId === follower.instanceId ||
              (!!follower.profileKey &&
                candidate.profileKey === follower.profileKey) ||
              (!!follower.target &&
                candidate.target?.chatId === follower.target.chatId &&
                candidate.target?.threadId === follower.target.threadId),
          );
      let settled = false;
      try {
        await runFollowerMutation(follower, async () => {
          const isDetached = () =>
            isCurrent() &&
            (!observation || observation.isCurrent()) &&
            !findReplacement() &&
            deps.isFollowerProcessAlive?.(follower.pid!) === false;
          if (!isDetached()) return;
          if (cleanupEnabled === true)
            await deps.onFollowerConfirmedDead!(follower);
          else
            settled = await deps.onFollowerConfirmedDeadPreserved!(
              follower,
              isDetached,
              observation!.operationId,
            );
        });
        if (!cleanupEnabled) recordPreserved();
      } catch (error) {
        recordPruneEvent(error, {
          phase: cleanupEnabled
            ? "follower-confirmed-dead-cleanup"
            : "follower-confirmed-dead-preserve",
          instanceId: follower.instanceId,
          pid: follower.pid,
          chatId: follower.target?.chatId,
          threadId: follower.target?.threadId,
        });
      } finally {
        if (
          settled ||
          cleanupEnabled === true ||
          (observation && !observation.isCurrent())
        ) {
          forgetPreservation(observation);
        }
      }
    }
  };
  const requestPrune = (): Promise<void> => {
    if (prunePromise) return prunePromise;
    const expectedGeneration = pruneGeneration;
    let tracked: Promise<void>;
    tracked = pruneFollowers(expectedGeneration)
      .then(() => {
        if (pruneGeneration === expectedGeneration) deps.afterFollowerPrune?.();
      })
      .catch((error) => {
        if (pruneGeneration === expectedGeneration) {
          recordPruneEvent(error, { phase: "follower-prune-owner" });
        }
      })
      .finally(() => {
        if (prunePromise === tracked) prunePromise = undefined;
      });
    prunePromise = tracked;
    return tracked;
  };
  const startPruning = () => {
    stopPruning();
    pruneInterval = setInterval(() => {
      void requestPrune();
    }, followerPruneIntervalMs);
    pruneInterval.unref?.();
  };
  const selectedMenuDelivery = deps.selectedMenuDelivery,
    selectedMenuProtocol = deps.protocolIdentity,
    selectedMenuRegistry = deps.followerRegistry,
    selectedMenuSecret = deps.authSecret;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    selectedMenuDelivery: selectedMenuDelivery
      ? (input, isCallerCurrent) => {
          const generation = pruneGeneration;
          return selectedMenuDelivery.call(
            deps,
            input,
            () =>
              !!pruneInterval &&
              pruneGeneration === generation &&
              deps.selectedMenuDelivery === selectedMenuDelivery &&
              deps.protocolIdentity === selectedMenuProtocol &&
              deps.followerRegistry === selectedMenuRegistry &&
              deps.authSecret === selectedMenuSecret &&
              isCallerCurrent(),
          );
        }
      : undefined,
    followerRegistry: deps.followerRegistry,
    authSecret: deps.authSecret,
    protocolIdentity: deps.protocolIdentity,
    getNowMs,
    captureApiTransport: deps.captureApiTransport,
    captureArtifactTransport: deps.captureArtifactTransport,
    artifactApi: deps.artifactApi,
    artifactMaxBytes: deps.artifactMaxBytes,
    callApi: deps.callApi,
    authorizeFollowerApiCall: deps.authorizeFollowerApiCall,
    recordFollowerMessageOwnership: deps.recordFollowerMessageOwnership,
    captureInputPublication: deps.captureInputPublication,
    getTextInputReceiverBotId: deps.getTextInputReceiverBotId,
    getAttachmentReceiverBotId: deps.getAttachmentReceiverBotId,
    resolveAgentTarget: deps.resolveAgentTarget,
    routeAgentMessage: deps.routeAgentMessage,
    routeQueueHandoff: deps.routeQueueHandoff,
    provisionFollowerTarget: deps.provisionFollowerTarget
      ? (registration, options) => {
          // Same-instance ownership can change in the store before registry publication.
          forgetPreservation(pendingPreservations.get(registration.instanceId));
          return deps.provisionFollowerTarget!(registration, options);
        }
      : undefined,
    commitFollowerRegistration: deps.commitFollowerRegistration,
    onFollowerDisconnected: deps.onFollowerDisconnected,
    renameFollowerThread: deps.renameFollowerThread,
    resetFollowerThreadName: deps.resetFollowerThreadName,
    publishFollowerSessionReplacement: deps.publishFollowerSessionReplacement,
    settleFollowerSessionReplacement: deps.settleFollowerSessionReplacement,
    getFollowerDisplayTitle: deps.getFollowerDisplayTitle,
    getThreadCapability: deps.getThreadCapability,
    onFollowerRegistered: deps.onFollowerRegistered,
    onWorkspaceRestoreRecipientObserved:
      deps.onWorkspaceRestoreRecipientObserved,
    getWorkspaceRestoreObservationGeneration: () =>
      pruneInterval ? pruneGeneration : undefined,
    recordRuntimeEvent: deps.recordRuntimeEvent,
    applyThreadDisplayMode: deps.applyThreadDisplayMode,
    getThreadDisplayMode: deps.getThreadDisplayMode,
    getRequiredWorkspaceReaderCapabilities: deps.getRequiredWorkspaceReaderCapabilities,
    getCurrentLeaderEpoch: deps.getCurrentLeaderEpoch,
    getTelegramProfile: deps.getTelegramProfile,
    getAllowedUserId: deps.getAllowedUserId,
    runFollowerMutation,
    runWorkspaceAdmission: deps.runWorkspaceAdmission,
    runWithWorkspaceCapacity: deps.runWithWorkspaceCapacity,
  });
  const routeQueueHandoffEnvelope = async (
    input: Parameters<
      TelegramBusLeaderRuntime<TContext>["routeQueueHandoff"]
    >[0],
  ): Promise<TelegramBusEnvelope> => {
    const recipient = deps.followerRegistry.get(input.recipientInstanceId);
    if (
      !hasTelegramBusCapability(
        deps.protocolIdentity,
        TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
      ) ||
      !hasTelegramBusCapability(
        recipient?.protocol,
        TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
      )
    ) {
      return rejectTelegramBusRequest(
        input.requestId,
        "Telegram queue handoff capability was not negotiated.",
      );
    }
    if (input.payload.queueLane === "steer" &&
        ![deps.protocolIdentity, recipient?.protocol].every(hasTelegramBusSteerQueueHandoffCapability)) {
      return rejectTelegramBusRequest(input.requestId, "Steer queue handoff capability was not negotiated.");
    }
    if (
      !recipient?.registrationGeneration ||
      input.recipientRegistrationGeneration !== recipient.registrationGeneration
    ) {
      return rejectTelegramBusRequest(
        input.requestId,
        "Stale Telegram queue handoff recipient registration generation.",
      );
    }
    const recipientSocketPath =
      recipient.busSocketPath ??
      getTelegramBusFollowerSocketPath(recipient.instanceId);
    const response = await sendTelegramBusLocalEnvelope({
      socketPath: recipientSocketPath,
      timeoutMs: deps.timeoutMs,
      retry: getTelegramBusTransportRetryPolicy({
        endpoint: recipientSocketPath,
        operation: "operation",
      }),
      envelope: {
        kind: "leader.offerQueueHandoff",
        requestId: input.requestId,
        auth: input.auth,
        recipientInstanceId: recipient.instanceId,
        recipientRegistrationGeneration: recipient.registrationGeneration,
        donorInstanceId: input.donorInstanceId,
        donorProcessId: input.donorProcessId,
        donorProcessBirthId: input.donorProcessBirthId,
        donorSessionGeneration: input.donorSessionGeneration,
        donorAcquisitionId: input.donorAcquisitionId,
        donorAcquiredAtMs: input.donorAcquiredAtMs,
        handoffToken: input.handoffToken,
        payload: input.payload,
        sentAtMs: input.sentAtMs,
      },
    });
    if (response?.kind === "bus.ack" && response.ok) {
      deps.followerRegistry.heartbeat(recipient.instanceId, getNowMs());
      return {
        kind: "bus.ack",
        requestId: input.requestId,
        ok: true,
        ...(response.result !== undefined ? { result: response.result } : {}),
      };
    }
    return {
      kind: "bus.ack",
      requestId: input.requestId,
      ok: false,
      message:
        response?.kind === "bus.ack"
          ? response.message
          : "Telegram queue handoff recipient did not acknowledge staging.",
    };
  };
  const localServer = createTelegramBusLocalServer({
    socketPath: deps.socketPath,
    commitEndpointPublication: deps.commitEndpointPublication,
    recordTransportEvent(phase, details) {
      deps.recordRuntimeEvent?.("bus", `Telegram bus ${phase}`, {
        phase: `leader-${phase}`,
        ...details,
      });
    },
    handleEnvelope,
    captureArtifactAuthority: createTelegramBusArtifactAuthorityCapture(deps),
  });
  // The start that owns the endpoint and pruning. A stop clears it; a start that loses it mid-await undoes only what
  // nobody newer owns, so a stop during startup never leaves a stopped leader's endpoint listening.
  let activeStart: object | undefined;
  const releaseSupersededStart = async (): Promise<void> => {
    if (activeStart !== undefined) return;
    stopPruning();
    await localServer
      .stop()
      .catch((error) =>
        deps.recordRuntimeEvent?.("bus", error, { phase: "stop" }),
      );
  };
  return {
    routeQueueHandoff: (envelope) => routeQueueHandoffEnvelope(envelope),
    startPolling: async (ctx) => {
      const start = {};
      activeStart = start;
      // Replay durable cleanup before publishing the follower endpoint so a
      // replacement registration cannot reclaim a target while it is deleted.
      await deps.provisionLeaderTarget?.(ctx);
      if (activeStart !== start) return;
      await localServer.start();
      if (activeStart !== start) return releaseSupersededStart();
      startPruning();
      try {
        await deps.startPolling(ctx);
      } catch (error) {
        if (activeStart !== start) return releaseSupersededStart();
        activeStart = undefined;
        stopPruning();
        await localServer.stop();
        throw error;
      }
      if (activeStart !== start) return releaseSupersededStart();
    },
    stopPolling: async () => {
      activeStart = undefined;
      stopPruning();
      try {
        await deps.stopPolling();
      } finally {
        await localServer
          .stop()
          .catch((error) =>
            deps.recordRuntimeEvent?.("bus", error, { phase: "stop" }),
          );
        deps.followerRegistry.clear();
      }
    },
  };
}
