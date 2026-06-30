/**
 * Telegram message ownership helpers
 * Zones: telegram routing, multi-instance bus, in-memory coordination
 * Owns live message-id ownership lookup so callbacks/reactions can resolve a Telegram UI surface back to the instance/target that produced it
 */

import { getTelegramTargetKey, type TelegramTarget } from "./target.ts";

export interface TelegramMessageOwnershipRecord {
  chatId: number;
  messageId: number;
  target: TelegramTarget;
  instanceId: string;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramMessageOwnershipStore {
  record: (input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
    instanceId: string;
    now?: number;
  }) => TelegramMessageOwnershipRecord;
  get: (
    chatId: number,
    messageId: number,
  ) => TelegramMessageOwnershipRecord | undefined;
  forget: (chatId: number, messageId: number) => boolean;
  forgetTarget: (target: TelegramTarget) => number;
  prune: (options: {
    now: number;
    maxAgeMs?: number;
    maxRecords?: number;
  }) => number;
  entries: () => TelegramMessageOwnershipRecord[];
  clear: () => void;
}

function getTelegramMessageOwnershipKey(
  chatId: number,
  messageId: number,
): string {
  return `${chatId}:${messageId}`;
}

function createTelegramMessageOwnershipRecord(input: {
  chatId: number;
  messageId: number;
  target?: TelegramTarget;
  instanceId: string;
  now: number;
  previous?: TelegramMessageOwnershipRecord;
}): TelegramMessageOwnershipRecord {
  return {
    chatId: input.chatId,
    messageId: input.messageId,
    target: input.target ?? { chatId: input.chatId },
    instanceId: input.instanceId,
    createdAt: input.previous?.createdAt ?? input.now,
    updatedAt: input.now,
  };
}

export function createTelegramMessageOwnershipStore(): TelegramMessageOwnershipStore {
  const records = new Map<string, TelegramMessageOwnershipRecord>();
  return {
    record: (input) => {
      const key = getTelegramMessageOwnershipKey(input.chatId, input.messageId);
      const now = input.now ?? Date.now();
      const record = createTelegramMessageOwnershipRecord({
        ...input,
        now,
        previous: records.get(key),
      });
      records.set(key, record);
      return record;
    },
    get: (chatId, messageId) =>
      records.get(getTelegramMessageOwnershipKey(chatId, messageId)),
    forget: (chatId, messageId) =>
      records.delete(getTelegramMessageOwnershipKey(chatId, messageId)),
    forgetTarget: (target) => {
      const targetKey = getTelegramTargetKey(target);
      let removed = 0;
      for (const [key, record] of records) {
        if (getTelegramTargetKey(record.target) !== targetKey) continue;
        records.delete(key);
        removed += 1;
      }
      return removed;
    },
    prune: ({ now, maxAgeMs, maxRecords }) => {
      let removed = 0;
      if (maxAgeMs !== undefined) {
        for (const [key, record] of records) {
          if (now - record.updatedAt <= maxAgeMs) continue;
          records.delete(key);
          removed += 1;
        }
      }
      if (maxRecords !== undefined && records.size > maxRecords) {
        const oldest = [...records.entries()].sort(
          (left, right) => left[1].updatedAt - right[1].updatedAt,
        );
        for (const [key] of oldest.slice(0, records.size - maxRecords)) {
          records.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    entries: () => [...records.values()],
    clear: () => {
      records.clear();
    },
  };
}
