/**
 * Telegram Workspace display projection
 * Zones: telegram, tui, thread identity
 * Owns mode-specific labels and serialized, authority-fenced title application.
 * Excludes routing, name allocation, profile mutation, and live-owner discovery.
 */
import { isDeepStrictEqual } from "node:util";
import type { TelegramThreadDisplayMode } from "./config.ts";
import type {
  TelegramTopicTargetStore,
  TelegramWorkspaceDisplayBinding,
  TelegramWorkspaceThreadBinding,
} from "./threads.ts";
import type { TelegramApiCallOptions } from "./telegram-api.ts";

function labelText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function boundedLabel(base: string, suffix = ""): string {
  let prefix = "";
  for (const character of base) {
    if (prefix.length + character.length + suffix.length > 128) break;
    prefix += character;
  }
  return `${prefix}${suffix}`;
}

function directoryLabel(cwd: string, directories: readonly string[]): string {
  const parts = cwd.split("/").filter(Boolean);
  if (!parts.length) return "/";
  for (let depth = 1; depth <= parts.length; depth++) {
    const candidate = labelText(parts.slice(-depth).join("/"));
    const collides = directories.some((other) => other !== cwd &&
      labelText(other.split("/").filter(Boolean).slice(-depth).join("/")).toLowerCase() ===
        candidate.toLowerCase(),
    );
    if (!collides) return candidate;
  }
  return labelText(cwd);
}

/** Missing or ambiguous metadata yields no label rather than inventing identity. */
export function resolveTelegramWorkspaceDisplayNames(
  bindings: readonly TelegramWorkspaceDisplayBinding[],
  mode: TelegramThreadDisplayMode,
): Map<string, string> {
  const labels = new Map<string, string>();
  const directories = Array.from(new Set(bindings.map((binding) => binding.cwd)));
  const directoryCounts = new Map<string, number>();
  for (const binding of bindings) {
    directoryCounts.set(binding.cwd, (directoryCounts.get(binding.cwd) ?? 0) + 1);
  }
  const bases = new Map<string, string>();
  for (const binding of bindings) {
    const slot = binding.slot && /^[A-Z]$/u.test(binding.slot) ? binding.slot : undefined;
    const manualName = binding.manualThreadName
      ? labelText(binding.manualThreadName)
      : undefined;
    if (manualName) {
      labels.set(binding.bindingKey, boundedLabel(manualName));
    } else if (mode === "letters") {
      if (slot) labels.set(binding.bindingKey, slot);
    } else if (mode === "names") {
      const name = binding.threadName ? labelText(binding.threadName) : slot;
      if (name) labels.set(binding.bindingKey, boundedLabel(name));
    } else {
      const base = directoryLabel(binding.cwd, directories);
      bases.set(binding.bindingKey, base);
      const showSuffix = binding.showSlotSuffix ||
        (directoryCounts.get(binding.cwd) ?? 0) > 1;
      if (showSuffix && !slot) continue;
      labels.set(binding.bindingKey, boundedLabel(base, showSuffix ? `_${slot!.toLowerCase()}` : ""));
    }
  }
  // Long or whitespace-normalized paths can collide even after qualification.
  if (mode === "directories") {
    const counts = new Map<string, number>();
    for (const label of labels.values()) {
      const key = label.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const binding of bindings) {
      const label = labels.get(binding.bindingKey);
      if (binding.manualThreadName || !label ||
          (counts.get(label.toLowerCase()) ?? 0) < 2) continue;
      if (!binding.slot || !/^[A-Z]$/u.test(binding.slot)) {
        labels.delete(binding.bindingKey);
        continue;
      }
      labels.set(binding.bindingKey, boundedLabel(bases.get(binding.bindingKey)!,
        `_${binding.slot.toLowerCase()}`));
    }
  }
  const counts = new Map<string, number>();
  for (const label of labels.values()) {
    const key = label.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, label] of labels) {
    if ((counts.get(label.toLowerCase()) ?? 0) > 1) labels.delete(key);
  }
  return labels;
}

export function resolveTelegramInitialWorkspaceDisplayName(input: {
  bindings: readonly TelegramWorkspaceDisplayBinding[];
  binding: TelegramWorkspaceDisplayBinding;
  mode: TelegramThreadDisplayMode;
  preserveRetainedManualName?: boolean;
}): string | undefined {
  const retained = input.bindings.find((binding) =>
    binding.bindingKey === input.binding.bindingKey,
  );
  const binding = retained
    ? {
      ...input.binding,
      ...(retained.showSlotSuffix ? { showSlotSuffix: true as const } : {}),
      ...(input.preserveRetainedManualName !== false && retained.manualThreadName
        ? { manualThreadName: retained.manualThreadName }
        : {}),
    }
    : input.binding;
  return resolveTelegramWorkspaceDisplayNames([
    ...input.bindings.filter((candidate) =>
      candidate.bindingKey !== binding.bindingKey,
    ),
    binding,
  ], input.mode).get(binding.bindingKey);
}

export async function applyTelegramThreadDisplaySetting(
  mode: TelegramThreadDisplayMode,
  deps: {
    getProfileKey(): string | undefined;
    ownsLeader(): boolean;
    getLeaderSetter(): ((mode: TelegramThreadDisplayMode) => Promise<void>) | undefined;
    getFollowerSetter(): ((mode: TelegramThreadDisplayMode) => Promise<void>) | undefined;
    reloadConfig(): Promise<void>;
  },
): Promise<void> {
  const profile = deps.getProfileKey();
  const setter = deps.ownsLeader() ? deps.getLeaderSetter() : deps.getFollowerSetter();
  if (!setter) throw new Error("Thread display settings require a connected compatible instance.");
  await setter(mode);
  if (deps.getProfileKey() !== profile) throw new Error("Telegram Thread display setting changed profile.");
  await deps.reloadConfig();
  if (deps.getProfileKey() !== profile) throw new Error("Telegram Thread display setting changed profile.");
}

export interface TelegramThreadDisplayReconcilerDeps {
  store: Pick<TelegramTopicTargetStore,
    "listWorkspaceBindings" | "setWorkspaceDisplayTitle" | "persist">;
  getMode(): TelegramThreadDisplayMode;
  getProfileKey(): string;
  getLeaderEpoch(): string | number | undefined;
  captureBindingAuthority(binding: TelegramWorkspaceThreadBinding): (() => boolean) | undefined;
  callApi<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramApiCallOptions,
  ): Promise<TResponse>;
}

/** Caller owns triggering and reporting; no timer or background retry is created. */
export function createTelegramThreadDisplayReconciler(
  deps: TelegramThreadDisplayReconcilerDeps,
): { reconcile(): Promise<{ changed: number }> } {
  let tail: Promise<unknown> = Promise.resolve();
  const apply = async (): Promise<{ changed: number }> => {
    const epoch = deps.getLeaderEpoch();
    const profile = deps.getProfileKey();
    const mode = deps.getMode();
    const assertAuthority = (): void => {
      if (epoch === undefined || deps.getLeaderEpoch() !== epoch ||
          deps.getProfileKey() !== profile || deps.getMode() !== mode) {
        throw new Error("Telegram Thread display update lost profile, mode, or leader authority.");
      }
    };
    assertAuthority();
    const bindings = deps.store.listWorkspaceBindings();
    const titles = resolveTelegramWorkspaceDisplayNames(bindings, mode);
    let changed = 0;
    for (const binding of bindings) {
      const isBindingCurrent = deps.captureBindingAuthority(binding);
      if (!isBindingCurrent) continue;
      const title = titles.get(binding.bindingKey);
      if (!title) throw new Error("Telegram Thread display identity is missing or ambiguous.");
      const assertBinding = (expected: TelegramWorkspaceThreadBinding): void => {
        assertAuthority();
        const current = deps.store.listWorkspaceBindings().find((candidate) =>
          candidate.bindingKey === expected.bindingKey,
        );
        if (!isDeepStrictEqual(current, expected) || !isBindingCurrent()) {
          throw new Error("Telegram Thread display binding changed.");
        }
      };
      assertBinding(binding);
      if ((binding.displayTitle ?? binding.threadName) === title) continue;
      await deps.callApi("editForumTopic", {
        chat_id: binding.target.chatId,
        message_thread_id: binding.target.threadId,
        name: title,
      }, { maxAttempts: 1 });
      assertBinding(binding);
      if (!deps.store.setWorkspaceDisplayTitle(binding, title)) {
        throw new Error("Telegram Thread display binding changed before title commit.");
      }
      await deps.store.persist();
      assertBinding({ ...binding, displayTitle: title });
      changed++;
    }
    // A prior acknowledged edit may still have dirty metadata after a failed persist.
    assertAuthority();
    if (changed === 0) await deps.store.persist();
    assertAuthority();
    return { changed };
  };
  return {
    reconcile() {
      const run = tail.then(apply);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
