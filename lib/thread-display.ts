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

function directorySegments(cwd: string): string[] {
  return cwd.split("/").filter(Boolean);
}

function distinguishingDirectorySegments(cwd: string, directories: readonly string[]): string[] {
  const parts = directorySegments(cwd);
  if (!parts.length) return [];
  for (let depth = 1; depth <= parts.length; depth++) {
    const candidate = labelText(parts.slice(-depth).join("/"));
    const collides = directories.some((other) => other !== cwd &&
      labelText(directorySegments(other).slice(-depth).join("/")).toLowerCase() ===
        candidate.toLowerCase(),
    );
    if (!collides) return parts.slice(-depth);
  }
  return parts;
}

function directoryLabel(cwd: string, directories: readonly string[]): string {
  const parts = distinguishingDirectorySegments(cwd, directories);
  return parts.length ? labelText(parts.join("/")) : "/";
}

/** Pure directory tokenization shared by previews, initial titles, and reconciliation. */
export function tokenizeTelegramDirectorySegment(segment: string): string[] {
  return segment
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1\u0000$2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1\u0000$2")
    .split(/[^\p{L}\p{N}]+|\u0000/gu)
    .filter(Boolean);
}

function formatDirectoryLabel(
  cwd: string,
  directories: readonly string[],
  mode: "directory-snake" | "directory-title",
): string {
  const segments = distinguishingDirectorySegments(cwd, directories);
  if (!segments.length) return "/";
  const formatted = segments.map((segment) => {
    const tokens = tokenizeTelegramDirectorySegment(segment);
    if (!tokens.length) return "";
    if (mode === "directory-snake") return tokens.map((token) => token.toLowerCase()).join("_");
    return tokens.map((token) => /\p{L}/u.test(token) && token === token.toUpperCase()
      ? token
      : `${token.slice(0, 1).toUpperCase()}${token.slice(1).toLowerCase()}`).join(" ");
  }).filter(Boolean);
  if (!formatted.length) return directoryLabel(cwd, directories);
  return formatted.join(mode === "directory-snake" ? "_" : " / ");
}

/** Maps one leader-captured authenticated owner roster onto retained binding identities. */
export function resolveTelegramLiveWorkspaceBindingKeys(
  bindings: readonly TelegramWorkspaceThreadBinding[],
  leaderTarget: { chatId: number; threadId?: number } | undefined,
  followers: readonly { target?: { chatId: number; threadId?: number } }[],
): ReadonlySet<string> {
  const targets = new Set<string>();
  const add = (target: { chatId: number; threadId?: number } | undefined) => {
    if (target && typeof target.threadId === "number") {
      targets.add(`${target.chatId}:${target.threadId}`);
    }
  };
  add(leaderTarget);
  for (const follower of followers) add(follower.target);
  return new Set(bindings.filter((binding) =>
    targets.has(`${binding.target.chatId}:${binding.target.threadId}`),
  ).map((binding) => binding.bindingKey));
}

/** Missing or ambiguous metadata yields no label rather than inventing identity. */
export function resolveTelegramWorkspaceDisplayNames(
  bindings: readonly TelegramWorkspaceDisplayBinding[],
  mode: TelegramThreadDisplayMode,
  liveBindingKeys: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const labels = new Map<string, string>();
  const directories = Array.from(new Set(bindings.map((binding) => binding.cwd)));
  const liveDirectoryCounts = new Map<string, number>();
  for (const binding of bindings) {
    if (!liveBindingKeys.has(binding.bindingKey)) continue;
    liveDirectoryCounts.set(binding.cwd, (liveDirectoryCounts.get(binding.cwd) ?? 0) + 1);
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
      const base = mode === "directories"
        ? directoryLabel(binding.cwd, directories)
        : formatDirectoryLabel(binding.cwd, directories, mode);
      bases.set(binding.bindingKey, base);
      const showSuffix = mode === "directories"
        ? binding.showSlotSuffix || bindings.filter((candidate) => candidate.cwd === binding.cwd).length > 1
        : (liveDirectoryCounts.get(binding.cwd) ?? 0) > 1;
      if (showSuffix && !slot) continue;
      const suffix = !showSuffix ? "" : mode === "directory-title"
        ? ` ${slot}`
        : `_${slot!.toLowerCase()}`;
      labels.set(binding.bindingKey, boundedLabel(base, suffix));
    }
  }
  // Long or whitespace-normalized paths can collide even after qualification.
  if (mode === "directories" || mode === "directory-snake" || mode === "directory-title") {
    const counts = new Map<string, number>();
    for (const binding of bindings) {
      const label = labels.get(binding.bindingKey);
      if (!label || ((mode === "directory-snake" || mode === "directory-title") &&
          !liveBindingKeys.has(binding.bindingKey))) continue;
      const key = label.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const binding of bindings) {
      const label = labels.get(binding.bindingKey);
      if (binding.manualThreadName || !label ||
          (counts.get(label.toLowerCase()) ?? 0) < 2) continue;
      if ((mode === "directory-snake" || mode === "directory-title") &&
          (liveDirectoryCounts.get(binding.cwd) ?? 0) < 2) {
        labels.delete(binding.bindingKey);
        continue;
      }
      if (!binding.slot || !/^[A-Z]$/u.test(binding.slot)) {
        labels.delete(binding.bindingKey);
        continue;
      }
      labels.set(binding.bindingKey, boundedLabel(bases.get(binding.bindingKey)!,
        mode === "directory-title" ? ` ${binding.slot}` : `_${binding.slot.toLowerCase()}`));
    }
  }
  const counts = new Map<string, number>();
  for (const binding of bindings) {
    const label = labels.get(binding.bindingKey);
    if (!label || ((mode === "directory-snake" || mode === "directory-title") &&
        !liveBindingKeys.has(binding.bindingKey))) continue;
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
  liveBindingKeys?: ReadonlySet<string>;
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
  ], input.mode, new Set([...(input.liveBindingKeys ?? []), binding.bindingKey])).get(binding.bindingKey);
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
  captureLiveBindingKeys(bindings: readonly TelegramWorkspaceThreadBinding[]): ReadonlySet<string>;
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
    const liveBindingKeys = deps.captureLiveBindingKeys(bindings);
    const titles = resolveTelegramWorkspaceDisplayNames(bindings, mode, liveBindingKeys);
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
