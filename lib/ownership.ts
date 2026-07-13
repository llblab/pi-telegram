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
  profileKey?: string;
  ownerGeneration?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TelegramMessageOwnershipStore {
  record: (input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
    instanceId: string;
    profileKey?: string;
    ownerGeneration?: string;
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

export interface TelegramFollowerOwnershipView {
  instanceId: string;
  connectedAtMs: number;
  registrationGeneration?: string;
}

export interface TelegramBusMessageOwnershipRuntime {
  store: TelegramMessageOwnershipStore;
  recordLocal(input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
  }): TelegramMessageOwnershipRecord;
  recordRouted(input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
    instanceId: string;
  }): TelegramMessageOwnershipRecord;
  recordFollower(input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
    follower: TelegramFollowerOwnershipView;
  }): TelegramMessageOwnershipRecord;
  isOwnedByFollower(input: {
    chatId: number;
    messageId: number;
    follower: TelegramFollowerOwnershipView;
  }): boolean;
}

function getTelegramFollowerOwnershipGeneration(
  follower: TelegramFollowerOwnershipView,
): string {
  return (
    follower.registrationGeneration ??
    `${follower.instanceId}:${follower.connectedAtMs}`
  );
}

export function createTelegramBusMessageOwnershipRuntime(deps: {
  instanceId: string;
  getProfileKey(): string;
  listFollowers(): readonly TelegramFollowerOwnershipView[];
}): TelegramBusMessageOwnershipRuntime {
  const store = createTelegramMessageOwnershipStore({
    getProfileKey: deps.getProfileKey,
    isOwnerGenerationLive(record) {
      if (!record.ownerGeneration) return true;
      return deps.listFollowers().some((follower) => {
        return (
          follower.instanceId === record.instanceId &&
          getTelegramFollowerOwnershipGeneration(follower) ===
            record.ownerGeneration
        );
      });
    },
  });
  const recordFollower = function (input: {
    chatId: number;
    messageId: number;
    target?: TelegramTarget;
    follower: TelegramFollowerOwnershipView;
  }): TelegramMessageOwnershipRecord {
    return store.record({
      chatId: input.chatId,
      messageId: input.messageId,
      target: input.target,
      instanceId: input.follower.instanceId,
      ownerGeneration: getTelegramFollowerOwnershipGeneration(input.follower),
    });
  };
  return {
    store,
    recordLocal(input) {
      return store.record({ ...input, instanceId: deps.instanceId });
    },
    recordRouted(input) {
      const follower = deps
        .listFollowers()
        .find((candidate) => candidate.instanceId === input.instanceId);
      return follower
        ? recordFollower({ ...input, follower })
        : store.record(input);
    },
    recordFollower,
    isOwnedByFollower({ chatId, messageId, follower }) {
      const ownership = store.get(chatId, messageId);
      return (
        ownership?.instanceId === follower.instanceId &&
        ownership.ownerGeneration ===
          getTelegramFollowerOwnershipGeneration(follower)
      );
    },
  };
}

function getTelegramMessageOwnershipKey(
  chatId: number,
  messageId: number,
  profileKey?: string,
): string {
  return `${profileKey ?? ""}:${chatId}:${messageId}`;
}

function createTelegramMessageOwnershipRecord(input: {
  chatId: number;
  messageId: number;
  target?: TelegramTarget;
  instanceId: string;
  profileKey?: string;
  ownerGeneration?: string;
  now: number;
  previous?: TelegramMessageOwnershipRecord;
}): TelegramMessageOwnershipRecord {
  return {
    chatId: input.chatId,
    messageId: input.messageId,
    target: input.target ?? { chatId: input.chatId },
    instanceId: input.instanceId,
    ...(input.profileKey ? { profileKey: input.profileKey } : {}),
    ...(input.ownerGeneration
      ? { ownerGeneration: input.ownerGeneration }
      : {}),
    createdAt: input.previous?.createdAt ?? input.now,
    updatedAt: input.now,
  };
}

export function createTelegramMessageOwnershipStore(
  options: {
    getProfileKey?: () => string | undefined;
    isOwnerGenerationLive?: (record: TelegramMessageOwnershipRecord) => boolean;
  } = {},
): TelegramMessageOwnershipStore {
  const records = new Map<string, TelegramMessageOwnershipRecord>();
  return {
    record: (input) => {
      const profileKey = input.profileKey ?? options.getProfileKey?.();
      const key = getTelegramMessageOwnershipKey(
        input.chatId,
        input.messageId,
        profileKey,
      );
      const now = input.now ?? Date.now();
      const record = createTelegramMessageOwnershipRecord({
        ...input,
        profileKey,
        now,
        previous: records.get(key),
      });
      records.set(key, record);
      return record;
    },
    get: (chatId, messageId) => {
      const record = records.get(
        getTelegramMessageOwnershipKey(
          chatId,
          messageId,
          options.getProfileKey?.(),
        ),
      );
      if (!record) return undefined;
      if (
        record.ownerGeneration &&
        options.isOwnerGenerationLive &&
        !options.isOwnerGenerationLive(record)
      ) {
        return undefined;
      }
      return record;
    },
    forget: (chatId, messageId) =>
      records.delete(
        getTelegramMessageOwnershipKey(
          chatId,
          messageId,
          options.getProfileKey?.(),
        ),
      ),
    forgetTarget: (target) => {
      const targetKey = getTelegramTargetKey(target);
      const profileKey = options.getProfileKey?.();
      let removed = 0;
      for (const [key, record] of records) {
        if ((record.profileKey ?? undefined) !== profileKey) continue;
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
