/**
 * Telegram Thread manual-name dialog state
 * Zones: telegram, thread identity, runtime controls
 * Owns one expiring exact-target interaction per session scope.
 * Excludes Telegram transport, durable Workspace mutation, and name validation.
 */

import type { TelegramTarget } from "./target.ts";

export const TELEGRAM_THREAD_NAME_DIALOG_TTL_MS = 5 * 60_000;

export type TelegramThreadNameDialogAction = "reset" | "cancel";

export interface TelegramThreadNameDialogCandidate {
  scope: string;
  target: TelegramTarget;
  dialogMessageId: number;
  phase: "input";
  expiresAtMs: number;
}

function targetKey(target: TelegramTarget): string {
  return `${target.chatId}:${target.threadId ?? "chat"}`;
}

function sameTarget(left: TelegramTarget, right: TelegramTarget): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

function cloneCandidate(
  candidate: TelegramThreadNameDialogCandidate,
): TelegramThreadNameDialogCandidate {
  return { ...candidate, target: { ...candidate.target } };
}

export function createTelegramThreadNameDialogRuntime(options?: {
  ttlMs?: number;
  nowMs?: () => number;
}): {
  open(input: {
    scope: string;
    target: TelegramTarget;
    dialogMessageId: number;
  }): TelegramThreadNameDialogCandidate;
  select(input: {
    scope: string;
    target: TelegramTarget;
    dialogMessageId: number;
    action: TelegramThreadNameDialogAction;
  }): { kind: "reset" | "cancel" | "expired" };
  consumeName(input: {
    scope: string;
    target: TelegramTarget;
    text: string;
  }): { kind: "name"; name: string } | { kind: "none" | "empty" };
  clearScope(scope: string): void;
  inspect(target: TelegramTarget): TelegramThreadNameDialogCandidate | undefined;
} {
  const ttlMs = options?.ttlMs ?? TELEGRAM_THREAD_NAME_DIALOG_TTL_MS;
  const nowMs = options?.nowMs ?? Date.now;
  const candidates = new Map<string, TelegramThreadNameDialogCandidate>();
  const current = (
    scope: string,
    target: TelegramTarget,
  ): TelegramThreadNameDialogCandidate | undefined => {
    const key = targetKey(target);
    const candidate = candidates.get(key);
    if (!candidate || candidate.scope !== scope ||
        !sameTarget(candidate.target, target)) return undefined;
    if (candidate.expiresAtMs <= nowMs()) {
      candidates.delete(key);
      return undefined;
    }
    return candidate;
  };
  return {
    open(input) {
      const candidate: TelegramThreadNameDialogCandidate = {
        scope: input.scope,
        target: { ...input.target },
        dialogMessageId: input.dialogMessageId,
        phase: "input",
        expiresAtMs: nowMs() + ttlMs,
      };
      candidates.set(targetKey(input.target), candidate);
      return cloneCandidate(candidate);
    },
    select(input) {
      const candidate = current(input.scope, input.target);
      if (!candidate || candidate.dialogMessageId !== input.dialogMessageId) {
        return { kind: "expired" };
      }
      candidates.delete(targetKey(input.target));
      return { kind: input.action };
    },
    consumeName(input) {
      const candidate = current(input.scope, input.target);
      if (!candidate || candidate.phase !== "input") return { kind: "none" };
      const name = input.text.trim();
      if (!name) return { kind: "empty" };
      candidates.delete(targetKey(input.target));
      return { kind: "name", name };
    },
    clearScope(scope) {
      for (const [key, candidate] of candidates) {
        if (candidate.scope === scope) candidates.delete(key);
      }
    },
    inspect(target) {
      const candidate = candidates.get(targetKey(target));
      if (!candidate || candidate.expiresAtMs <= nowMs()) {
        candidates.delete(targetKey(target));
        return undefined;
      }
      return cloneCandidate(candidate);
    },
  };
}
