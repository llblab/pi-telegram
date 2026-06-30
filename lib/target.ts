/**
 * Telegram transport destination value helpers
 * Zones: Bot API transport, routing, replies/previews, ownership, multi-instance bus
 * Owns the minimal `{ chatId, threadId? }` address shape shared by classic private chats
 * and Telegram UI threads mapped through Bot API `message_thread_id`.
 */

export interface TelegramTarget {
  chatId: number;
  threadId?: number;
}

const PRIVATE_TARGET_THREAD_KEY = "private";

export function createTelegramPrivateTarget(chatId: number): TelegramTarget {
  return { chatId };
}

export function createTelegramThreadTarget(
  chatId: number,
  threadId: number,
): TelegramTarget {
  return { chatId, threadId };
}

export function getTelegramTargetKey(target: TelegramTarget): string {
  return `${target.chatId}:${target.threadId ?? PRIVATE_TARGET_THREAD_KEY}`;
}

export function isTelegramThreadTarget(
  target: TelegramTarget,
): target is TelegramTarget & { threadId: number } {
  return Number.isInteger(target.threadId);
}

export function areTelegramTargetsEqual(
  left: TelegramTarget,
  right: TelegramTarget,
): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

export function getTelegramTargetThreadParams(
  target: TelegramTarget,
): { message_thread_id?: number } {
  return isTelegramThreadTarget(target)
    ? { message_thread_id: target.threadId }
    : {};
}
