/**
 * Durable journal for Telegram channel posts authored by this agent path
 * Zones: telegram outbound, filesystem authority
 * Owns publication intent, outcome-unknown fencing, confirmed post identity, and bounded local listing
 */

import { chmodSync, closeSync, constants, createReadStream, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { Type } from "@sinclair/typebox";

import { renameTelegramPathWithRetry, withTelegramFileTransaction } from "./locks.ts";
import type { ExtensionAPI } from "./pi.ts";

const CHANNEL_POST_JOURNAL_VERSION = 1;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_CHANNEL_TITLE_LENGTH = 255;

export type TelegramChannelPostMediaKind = "photo" | "video";

export interface TelegramChannelPostMediaIntent {
  kind: TelegramChannelPostMediaKind;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export const TELEGRAM_CHANNEL_POST_MEDIA_MAX_BYTES: Record<TelegramChannelPostMediaKind, number> = {
  photo: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
};
export const TELEGRAM_CHANNEL_POST_CAPTION_MAX_LENGTH = 1024;
export const TELEGRAM_CHANNEL_POST_MEDIA_FILE_NAME_MAX_LENGTH = 255;

/** Safe, content-free local validation failure for channel media publication intent. */
export class TelegramChannelPostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramChannelPostValidationError";
  }
}

export function isTelegramChannelPostValidationError(
  error: unknown,
): error is TelegramChannelPostValidationError {
  return error instanceof TelegramChannelPostValidationError;
}

const TELEGRAM_CHANNEL_POST_PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const TELEGRAM_CHANNEL_POST_VIDEO_EXTENSIONS = new Set([".mp4"]);

export function resolveTelegramChannelPostMediaKind(
  path: string,
): TelegramChannelPostMediaKind | undefined {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot);
  if (TELEGRAM_CHANNEL_POST_PHOTO_EXTENSIONS.has(extension)) return "photo";
  if (TELEGRAM_CHANNEL_POST_VIDEO_EXTENSIONS.has(extension)) return "video";
  return undefined;
}

export function assertTelegramChannelPostMediaSize(
  kind: TelegramChannelPostMediaKind,
  sizeBytes: number,
): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new TelegramChannelPostValidationError("Channel media file is empty or unreadable.");
  }
  const limit = TELEGRAM_CHANNEL_POST_MEDIA_MAX_BYTES[kind];
  if (sizeBytes > limit) {
    throw new TelegramChannelPostValidationError(
      `Channel ${kind} exceeds the Telegram ${kind} upload limit of ${limit} bytes.`,
    );
  }
}

async function hashTelegramChannelPostMedia(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function inspectTelegramChannelPostMedia(
  path: string,
): Promise<TelegramChannelPostMediaIntent> {
  const kind = resolveTelegramChannelPostMediaKind(path);
  if (!kind) {
    throw new TelegramChannelPostValidationError(
      "Unsupported channel media type. Supported single files: .jpg, .jpeg, .png, .webp photos and .mp4 videos; albums are not supported.",
    );
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new TelegramChannelPostValidationError(
      "Channel media upload requires one readable regular local file.",
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TelegramChannelPostValidationError(
      "Channel media upload requires one regular local file without symbolic links.",
    );
  }
  assertTelegramChannelPostMediaSize(kind, stats.size);
  return { kind, fileName: basename(path), sizeBytes: stats.size,
    sha256: await hashTelegramChannelPostMedia(path) };
}

export function getTelegramChannelPostCaptionLength(caption: string): number {
  const visible = caption
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
  return visible.length;
}

export function assertTelegramChannelPostCaptionWithinLimit(caption: string): void {
  if (getTelegramChannelPostCaptionLength(caption) >
      TELEGRAM_CHANNEL_POST_CAPTION_MAX_LENGTH) {
    throw new TelegramChannelPostValidationError(
      `Channel media caption exceeds the Telegram limit of ${TELEGRAM_CHANNEL_POST_CAPTION_MAX_LENGTH} characters.`,
    );
  }
}

type ChannelPostJournalCode = "invalid" | "conflict" | "capacity" | "io";

export class TelegramChannelPostJournalError extends Error {
  readonly code: ChannelPostJournalCode;

  constructor(code: ChannelPostJournalCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TelegramChannelPostJournalError";
    this.code = code;
  }
}

export type TelegramChannelPostAddress = number | `@${string}`;

interface TelegramChannelPostRecordBase {
  operationId: string;
  requestedChannel: TelegramChannelPostAddress;
  markdown: string;
  media?: TelegramChannelPostMediaIntent;
  createdAtMs: number;
  updatedAtMs: number;
}

interface TelegramPublishedChannelPostIdentity {
  issuedAtMs: number;
  publishedAtMs: number;
  channelId: number;
  messageId: number;
  channelUsername?: `@${string}`;
  channelTitle?: string;
  lastMutationId?: string;
}

export type TelegramChannelPostRecord = TelegramChannelPostRecordBase & (
  | { state: "prepared" }
  | { state: "outcome-unknown"; issuedAtMs: number }
  | ({ state: "published" } & TelegramPublishedChannelPostIdentity)
  | ({ state: "edit-outcome-unknown"; mutationId: string; attemptedMarkdown: string;
      mutationIssuedAtMs: number } & TelegramPublishedChannelPostIdentity)
  | ({ state: "delete-outcome-unknown"; mutationId: string;
      mutationIssuedAtMs: number } & TelegramPublishedChannelPostIdentity)
  | ({ state: "deleted"; mutationId: string; deletedAtMs: number } &
      TelegramPublishedChannelPostIdentity)
);

interface TelegramChannelPostJournalFile {
  version: typeof CHANNEL_POST_JOURNAL_VERSION;
  profile: string;
  tokenSha256: string;
  records: TelegramChannelPostRecord[];
}

export interface TelegramChannelPostJournalStoreOptions {
  path: string;
  profileName: string;
  tokenSha256: string;
  maxRecords?: number;
  maxBytes?: number;
  getNowMs?: () => number;
}

export interface TelegramChannelPostJournalStore {
  prepare(input: { operationId: string; channel: TelegramChannelPostAddress; markdown: string;
    media?: TelegramChannelPostMediaIntent }):
    { prepared: boolean; record: TelegramChannelPostRecord };
  get(operationId: string): TelegramChannelPostRecord | undefined;
  beginPublication(operationId: string): { began: boolean; record: TelegramChannelPostRecord };
  confirmPublished(input: { operationId: string; channelId: number; messageId: number;
    channelUsername?: `@${string}`; channelTitle?: string }):
    { confirmed: boolean; record: TelegramChannelPostRecord };
  beginEdit(input: { operationId: string; mutationId: string; markdown: string }):
    { began: boolean; record: TelegramChannelPostRecord };
  confirmEdited(input: { operationId: string; mutationId: string }):
    { confirmed: boolean; record: TelegramChannelPostRecord };
  beginDelete(input: { operationId: string; mutationId: string }):
    { began: boolean; record: TelegramChannelPostRecord };
  confirmDeleted(input: { operationId: string; mutationId: string }):
    { confirmed: boolean; record: TelegramChannelPostRecord };
  list(input?: { channel?: TelegramChannelPostAddress; limit?: number }): TelegramChannelPostRecord[];
}

export async function publishTelegramChannelPost(input: {
  store: TelegramChannelPostJournalStore;
  operationId: string;
  channel: TelegramChannelPostAddress;
  markdown: string;
  media?: TelegramChannelPostMediaIntent;
  observeChannel(channel: TelegramChannelPostAddress): Promise<{
    id: number; type: string; username?: string; title?: string;
  }>;
  send(channel: TelegramChannelPostAddress, markdown: string): Promise<{
    messageId: number; chat: { id: number; type: string };
  }>;
}): Promise<TelegramChannelPostRecord> {
  const observed = await input.observeChannel(input.channel);
  if (observed.type !== "channel" || !Number.isSafeInteger(observed.id) || observed.id >= 0 ||
      (typeof input.channel === "number" && observed.id !== input.channel) ||
      (observed.username !== undefined && !/^[A-Za-z0-9_]{5,32}$/u.test(observed.username)) ||
      (observed.title !== undefined && (observed.title.length === 0 ||
        observed.title.length > MAX_CHANNEL_TITLE_LENGTH))) {
    throw new Error("Telegram channel delivery requires bounded exact getChat channel identity.");
  }
  input.store.prepare({ operationId: input.operationId, channel: input.channel,
    markdown: input.markdown, ...(input.media === undefined ? {} : { media: input.media }) });
  const issuance = input.store.beginPublication(input.operationId);
  if (!issuance.began) {
    if (issuance.record.state === "published") return issuance.record;
    throw new Error("Telegram channel post outcome is unknown; refusing automatic replay.");
  }
  const sent = await input.send(input.channel, input.markdown);
  if (sent.chat.type !== "channel" || sent.chat.id !== observed.id) {
    throw new Error("Telegram channel post response identity did not match the verified channel.");
  }
  return input.store.confirmPublished({ operationId: input.operationId,
    channelId: sent.chat.id, messageId: sent.messageId,
    ...(observed.username ? { channelUsername: `@${observed.username}` as `@${string}` } : {}),
    ...(observed.title ? { channelTitle: observed.title } : {}) }).record;
}

function formatTelegramChannelPostToolOutput(value: unknown): string {
  // Pi's compact tool rows need one leading newline to separate call and result.
  return `\n${JSON.stringify(value, null, 2)}`;
}

function formatTelegramChannelPostToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`\n${message.replace(/^\n+/u, "") || "Telegram channel post operation failed."}`);
}

export function registerTelegramChannelPostMutationTool(
  pi: ExtensionAPI,
  deps: { mutate(input: { action: "edit" | "delete"; operationId: string;
    mutationId: string; markdown?: string }): Promise<TelegramChannelPostRecord> },
): void {
  pi.registerTool({
    name: "telegram_channel_post",
    label: "Edit or Delete Telegram Channel Post",
    description: "Edit or delete one exact published post retained by telegram_channel_posts; a media post edit replaces its caption. Unknown outcomes are never replayed.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("edit"), Type.Literal("delete")]),
      operation_id: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH }),
      markdown: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_MARKDOWN_LENGTH })),
    }),
    async execute(toolCallId, params) {
      try {
        const record = await deps.mutate({ action: params.action, operationId: params.operation_id,
          mutationId: toolCallId, ...(params.markdown === undefined ? {} : { markdown: params.markdown }) });
        return { content: [{ type: "text" as const, text: formatTelegramChannelPostToolOutput(record) }],
          details: { record } };
      } catch (error) {
        if (isTelegramChannelPostValidationError(error)) {
          throw formatTelegramChannelPostToolError(error);
        }
        throw new Error("\nTelegram channel post mutation failed; inspect the retained local record before retrying.");
      }
    },
  });
}

export function registerTelegramChannelPostListTool(
  pi: ExtensionAPI,
  deps: { list: TelegramChannelPostJournalStore["list"] },
): void {
  pi.registerTool({
    name: "telegram_channel_posts",
    label: "Telegram Channel Posts",
    description: "List bounded local records for channel posts authored by this agent path. This does not read Telegram channel history.",
    parameters: Type.Object({
      chat_id: Type.Optional(Type.Union([
        Type.Number(), Type.String({ pattern: "^@[A-Za-z0-9_]{5,32}$" }),
      ])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_RECORDS })),
    }),
    async execute(_toolCallId, params) {
      try {
        const records = deps.list({
          channel: params.chat_id as TelegramChannelPostAddress | undefined,
          limit: params.limit,
        });
        return { content: [{ type: "text" as const, text: formatTelegramChannelPostToolOutput(records) }],
          details: { records } };
      } catch {
        throw new Error("\nTelegram channel post listing failed without exposing retained content or storage details.");
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizeChannel(value: unknown): TelegramChannelPostAddress {
  if (Number.isSafeInteger(value) && (value as number) < 0) return value as number;
  if (typeof value === "string" && /^@[A-Za-z0-9_]{5,32}$/u.test(value)) {
    return value as `@${string}`;
  }
  throw new TelegramChannelPostJournalError("invalid", "Telegram channel post requires an exact negative channel ID or public @username.");
}

function validateTelegramChannelPostMedia(value: unknown): TelegramChannelPostMediaIntent {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "fileName", "sizeBytes", "sha256"]) ||
      (value.kind !== "photo" && value.kind !== "video") ||
      typeof value.fileName !== "string" || value.fileName.length === 0 ||
      value.fileName.length > TELEGRAM_CHANNEL_POST_MEDIA_FILE_NAME_MAX_LENGTH ||
      !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) <= 0 ||
      (value.sizeBytes as number) > TELEGRAM_CHANNEL_POST_MEDIA_MAX_BYTES[value.kind] ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new TelegramChannelPostJournalError("invalid",
      "Telegram channel post journal contains an invalid media intent.");
  }
  return { kind: value.kind, fileName: value.fileName,
    sizeBytes: value.sizeBytes as number, sha256: value.sha256 };
}

function sameTelegramChannelPostMedia(
  left: TelegramChannelPostMediaIntent | undefined,
  right: TelegramChannelPostMediaIntent | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind && left.fileName === right.fileName &&
    left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}

function validateRecord(value: unknown): TelegramChannelPostRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ["operationId", "requestedChannel", "markdown",
    "media", "createdAtMs", "updatedAtMs", "state", "issuedAtMs", "publishedAtMs", "channelId",
    "messageId", "channelUsername", "mutationId", "attemptedMarkdown",
    "mutationIssuedAtMs", "deletedAtMs", "lastMutationId", "channelTitle"]) || typeof value.operationId !== "string" ||
    value.operationId.length === 0 || value.operationId.length > MAX_ID_LENGTH ||
    typeof value.markdown !== "string" || value.markdown.length === 0 ||
    value.markdown.length > MAX_MARKDOWN_LENGTH || !isSafeTime(value.createdAtMs) ||
    !isSafeTime(value.updatedAtMs) || value.updatedAtMs < value.createdAtMs) {
    throw new TelegramChannelPostJournalError("invalid", "Telegram channel post journal contains an invalid record.");
  }
  const base: TelegramChannelPostRecordBase = { operationId: value.operationId,
    requestedChannel: normalizeChannel(value.requestedChannel), markdown: value.markdown,
    createdAtMs: value.createdAtMs, updatedAtMs: value.updatedAtMs,
    ...(value.media === undefined ? {} : { media: validateTelegramChannelPostMedia(value.media) }) };
  if (value.state === "prepared" && value.issuedAtMs === undefined && value.publishedAtMs === undefined &&
      value.channelId === undefined && value.messageId === undefined && value.channelUsername === undefined &&
      value.mutationId === undefined && value.attemptedMarkdown === undefined &&
      value.mutationIssuedAtMs === undefined && value.deletedAtMs === undefined &&
      value.lastMutationId === undefined && value.channelTitle === undefined) {
    return { ...base, state: "prepared" };
  }
  if (!isSafeTime(value.issuedAtMs) || value.issuedAtMs < value.createdAtMs) {
    throw new TelegramChannelPostJournalError("invalid", "Telegram channel post journal contains invalid issuance evidence.");
  }
  if (value.state === "outcome-unknown" && value.publishedAtMs === undefined && value.channelId === undefined &&
      value.messageId === undefined && value.channelUsername === undefined && value.mutationId === undefined &&
      value.attemptedMarkdown === undefined && value.mutationIssuedAtMs === undefined &&
      value.deletedAtMs === undefined && value.lastMutationId === undefined &&
      value.channelTitle === undefined) {
    return { ...base, state: "outcome-unknown", issuedAtMs: value.issuedAtMs };
  }
  if (!isSafeTime(value.publishedAtMs) || value.publishedAtMs < value.issuedAtMs ||
      !Number.isSafeInteger(value.channelId) || (value.channelId as number) >= 0 ||
      !Number.isSafeInteger(value.messageId) || (value.messageId as number) <= 0 ||
      (value.channelUsername !== undefined && (typeof value.channelUsername !== "string" ||
        !/^@[A-Za-z0-9_]{5,32}$/u.test(value.channelUsername))) ||
      (value.channelTitle !== undefined && (typeof value.channelTitle !== "string" ||
        value.channelTitle.length === 0 || value.channelTitle.length > MAX_CHANNEL_TITLE_LENGTH))) {
    throw new TelegramChannelPostJournalError("invalid", "Telegram channel post journal contains invalid published identity.");
  }
  const identity: TelegramPublishedChannelPostIdentity = { issuedAtMs: value.issuedAtMs,
    publishedAtMs: value.publishedAtMs, channelId: value.channelId as number,
    messageId: value.messageId as number,
    ...(value.channelUsername ? { channelUsername: value.channelUsername as `@${string}` } : {}),
    ...(typeof value.channelTitle === "string" ? { channelTitle: value.channelTitle } : {}),
    ...(typeof value.lastMutationId === "string" && value.lastMutationId.length > 0 &&
      value.lastMutationId.length <= MAX_ID_LENGTH ? { lastMutationId: value.lastMutationId } : {}) };
  if (value.lastMutationId !== undefined && identity.lastMutationId === undefined) {
    throw new TelegramChannelPostJournalError("invalid", "Telegram channel post journal contains invalid mutation identity.");
  }
  if (value.state === "published" && value.mutationId === undefined &&
      value.attemptedMarkdown === undefined && value.mutationIssuedAtMs === undefined &&
      value.deletedAtMs === undefined) return { ...base, ...identity, state: "published" };
  const validMutation = typeof value.mutationId === "string" && value.mutationId.length > 0 &&
    value.mutationId.length <= MAX_ID_LENGTH && isSafeTime(value.mutationIssuedAtMs) &&
    value.mutationIssuedAtMs >= value.publishedAtMs &&
    value.mutationIssuedAtMs === value.updatedAtMs;
  if (value.state === "edit-outcome-unknown" && validMutation &&
      typeof value.attemptedMarkdown === "string" && value.attemptedMarkdown.length > 0 &&
      value.attemptedMarkdown.length <= MAX_MARKDOWN_LENGTH && value.deletedAtMs === undefined) {
    return { ...base, ...identity, state: "edit-outcome-unknown", mutationId: value.mutationId as string,
      attemptedMarkdown: value.attemptedMarkdown, mutationIssuedAtMs: value.mutationIssuedAtMs as number };
  }
  if (value.state === "delete-outcome-unknown" && validMutation &&
      value.attemptedMarkdown === undefined && value.deletedAtMs === undefined) {
    return { ...base, ...identity, state: "delete-outcome-unknown", mutationId: value.mutationId as string,
      mutationIssuedAtMs: value.mutationIssuedAtMs as number };
  }
  if (value.state === "deleted" && typeof value.mutationId === "string" &&
      value.mutationId.length > 0 && value.mutationId.length <= MAX_ID_LENGTH &&
      isSafeTime(value.deletedAtMs) && value.deletedAtMs >= value.publishedAtMs &&
      value.deletedAtMs === value.updatedAtMs &&
      value.mutationIssuedAtMs === undefined && value.attemptedMarkdown === undefined) {
    return { ...base, ...identity, state: "deleted", mutationId: value.mutationId,
      deletedAtMs: value.deletedAtMs };
  }
  throw new TelegramChannelPostJournalError("invalid", "Telegram channel post journal contains an invalid state.");
}

export function createTelegramChannelPostJournalStore(
  options: TelegramChannelPostJournalStoreOptions,
): TelegramChannelPostJournalStore {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.getNowMs ?? Date.now;
  if (!options.path || !options.profileName || !/^[a-f0-9]{64}$/u.test(options.tokenSha256) ||
      !Number.isSafeInteger(maxRecords) || maxRecords <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Telegram channel post journal options are invalid.");
  }
  const empty = (): TelegramChannelPostJournalFile => ({ version: CHANNEL_POST_JOURNAL_VERSION,
    profile: options.profileName, tokenSha256: options.tokenSha256, records: [] });
  const read = (): TelegramChannelPostJournalFile => {
    let before;
    try {
      before = lstatSync(options.path, { bigint: true });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return empty();
      throw new TelegramChannelPostJournalError("io", "Could not inspect Telegram channel post journal.", error);
    }
    const uid = process.getuid?.();
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || uid === undefined || !before.isFile() ||
        before.isSymbolicLink() || before.uid !== BigInt(uid) || before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n || before.size > BigInt(maxBytes)) {
      throw new TelegramChannelPostJournalError(before.size > BigInt(maxBytes) ? "capacity" : "invalid",
        "Telegram channel post journal is not a bounded no-follow regular file.");
    }
    let fd: number | undefined;
    try {
      fd = openSync(options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
          opened.uid !== before.uid || opened.nlink !== 1n || (opened.mode & 0o077n) !== 0n ||
          opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
        throw new TelegramChannelPostJournalError("conflict", "Telegram channel post journal changed during inspection.");
      }
      const value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
      if (!isRecord(value) || !hasOnlyKeys(value, ["version", "profile", "tokenSha256", "records"]) ||
          value.version !== CHANNEL_POST_JOURNAL_VERSION || value.profile !== options.profileName ||
          value.tokenSha256 !== options.tokenSha256 || !Array.isArray(value.records)) {
        throw new TelegramChannelPostJournalError("conflict", "Telegram channel post journal identity or schema does not match.");
      }
      const records = value.records.map(validateRecord);
      if (new Set(records.map(record => record.operationId)).size !== records.length) {
        throw new TelegramChannelPostJournalError("invalid", "Telegram channel post journal contains duplicate operation IDs.");
      }
      return { version: CHANNEL_POST_JOURNAL_VERSION, profile: options.profileName,
        tokenSha256: options.tokenSha256, records };
    } catch (error) {
      if (error instanceof TelegramChannelPostJournalError) throw error;
      throw new TelegramChannelPostJournalError("io", "Could not read Telegram channel post journal.", error);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const publish = (file: TelegramChannelPostJournalFile): void => {
    if (file.records.length > maxRecords) {
      throw new TelegramChannelPostJournalError("capacity", "Telegram channel post journal record limit reached.");
    }
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > maxBytes) {
      throw new TelegramChannelPostJournalError("capacity", "Telegram channel post journal byte limit reached.");
    }
    const temporaryPath = `${options.path}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      if (!renameTelegramPathWithRetry(temporaryPath, options.path)) {
        throw new Error("Telegram channel post journal staging file disappeared before publication.");
      }
      chmodSync(options.path, 0o600);
    } finally {
      try { unlinkSync(temporaryPath); } catch { /* Atomic rename consumes the temporary path. */ }
    }
  };
  const mutate = <T>(operation: (file: TelegramChannelPostJournalFile) => T): T => {
    try {
      return withTelegramFileTransaction(`${options.path}.transaction`, () => operation(read()));
    } catch (error) {
      if (error instanceof TelegramChannelPostJournalError) throw error;
      throw new TelegramChannelPostJournalError("io", "Telegram channel post journal mutation failed.", error);
    }
  };
  return {
    prepare(input) {
      const operationId = input.operationId;
      const channel = normalizeChannel(input.channel);
      const media = input.media === undefined ? undefined
        : validateTelegramChannelPostMedia(input.media);
      if (typeof operationId !== "string" || operationId.length === 0 || operationId.length > MAX_ID_LENGTH ||
          typeof input.markdown !== "string" || input.markdown.length === 0 ||
          input.markdown.length > MAX_MARKDOWN_LENGTH) {
        throw new TelegramChannelPostJournalError("invalid", "Telegram channel post intent is invalid.");
      }
      return mutate(file => {
        const existing = file.records.find(record => record.operationId === operationId);
        if (existing) {
          if (existing.requestedChannel !== channel || existing.markdown !== input.markdown ||
              !sameTelegramChannelPostMedia(existing.media, media)) {
            throw new TelegramChannelPostJournalError("conflict", "Telegram channel post operation conflicts with retained intent.");
          }
          return { prepared: false, record: structuredClone(existing) };
        }
        const atMs = now();
        if (!isSafeTime(atMs)) throw new TelegramChannelPostJournalError("invalid", "Telegram channel post clock is invalid.");
        const record: TelegramChannelPostRecord = { operationId, requestedChannel: channel,
          markdown: input.markdown, createdAtMs: atMs, updatedAtMs: atMs, state: "prepared",
          ...(media === undefined ? {} : { media }) };
        publish({ ...file, records: [...file.records, record] });
        return { prepared: true, record: structuredClone(record) };
      });
    },
    beginPublication(operationId) {
      return mutate(file => {
        const index = file.records.findIndex(record => record.operationId === operationId);
        if (index < 0) throw new TelegramChannelPostJournalError("conflict", "Telegram channel post intent is missing.");
        const current = file.records[index]!;
        if (current.state !== "prepared") return { began: false, record: structuredClone(current) };
        const atMs = now();
        if (!isSafeTime(atMs) || atMs < current.createdAtMs) {
          throw new TelegramChannelPostJournalError("invalid", "Telegram channel post clock is invalid.");
        }
        const record: TelegramChannelPostRecord = { ...current, state: "outcome-unknown",
          issuedAtMs: atMs, updatedAtMs: atMs };
        const records = [...file.records]; records[index] = record; publish({ ...file, records });
        return { began: true, record: structuredClone(record) };
      });
    },
    confirmPublished(input) {
      return mutate(file => {
        const index = file.records.findIndex(record => record.operationId === input.operationId);
        if (index < 0) throw new TelegramChannelPostJournalError("conflict", "Telegram channel post intent is missing.");
        const current = file.records[index]!;
        if (current.state === "published") {
          if (current.channelId !== input.channelId || current.messageId !== input.messageId ||
              current.channelUsername !== input.channelUsername ||
              current.channelTitle !== input.channelTitle) {
            throw new TelegramChannelPostJournalError("conflict", "Telegram channel post confirmation conflicts with retained identity.");
          }
          return { confirmed: false, record: structuredClone(current) };
        }
        if (current.state !== "outcome-unknown" || !Number.isSafeInteger(input.channelId) || input.channelId >= 0 ||
            !Number.isSafeInteger(input.messageId) || input.messageId <= 0 ||
            (input.channelUsername !== undefined && !/^@[A-Za-z0-9_]{5,32}$/u.test(input.channelUsername)) ||
            (input.channelTitle !== undefined && (input.channelTitle.length === 0 ||
              input.channelTitle.length > MAX_CHANNEL_TITLE_LENGTH))) {
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post confirmation is invalid or premature.");
        }
        const atMs = now();
        if (!isSafeTime(atMs) || atMs < current.issuedAtMs) {
          throw new TelegramChannelPostJournalError("invalid", "Telegram channel post clock is invalid.");
        }
        const record: TelegramChannelPostRecord = { ...current, state: "published",
          publishedAtMs: atMs, updatedAtMs: atMs, channelId: input.channelId,
          messageId: input.messageId, ...(input.channelUsername ? { channelUsername: input.channelUsername } : {}),
          ...(input.channelTitle ? { channelTitle: input.channelTitle } : {}) };
        const records = [...file.records]; records[index] = record; publish({ ...file, records });
        return { confirmed: true, record: structuredClone(record) };
      });
    },
    beginEdit(input) {
      return mutate(file => {
        const index = file.records.findIndex(record => record.operationId === input.operationId);
        if (index < 0) throw new TelegramChannelPostJournalError("conflict", "Telegram channel post is missing.");
        const current = file.records[index]!;
        if (current.state === "edit-outcome-unknown") {
          if (current.mutationId === input.mutationId && current.attemptedMarkdown === input.markdown)
            return { began: false, record: structuredClone(current) };
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post already has an unresolved mutation.");
        }
        if (current.state === "published" && current.lastMutationId === input.mutationId) {
          if (current.markdown === input.markdown) return { began: false, record: structuredClone(current) };
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post mutation identity conflicts with retained edit.");
        }
        if (current.state !== "published" || !input.mutationId || input.mutationId.length > MAX_ID_LENGTH ||
            !input.markdown || input.markdown.length > MAX_MARKDOWN_LENGTH) {
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post edit is invalid or unavailable.");
        }
        const atMs = now();
        if (!isSafeTime(atMs) || atMs < current.updatedAtMs) throw new TelegramChannelPostJournalError("invalid", "Telegram channel post clock is invalid.");
        const record: TelegramChannelPostRecord = { ...current, state: "edit-outcome-unknown",
          mutationId: input.mutationId, attemptedMarkdown: input.markdown,
          mutationIssuedAtMs: atMs, updatedAtMs: atMs };
        const records = [...file.records]; records[index] = record; publish({ ...file, records });
        return { began: true, record: structuredClone(record) };
      });
    },
    confirmEdited(input) {
      return mutate(file => {
        const index = file.records.findIndex(record => record.operationId === input.operationId);
        if (index < 0) throw new TelegramChannelPostJournalError("conflict", "Telegram channel post is missing.");
        const current = file.records[index]!;
        if (current.state === "published" && current.lastMutationId === input.mutationId)
          return { confirmed: false, record: structuredClone(current) };
        if (current.state !== "edit-outcome-unknown" || current.mutationId !== input.mutationId)
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post edit confirmation is stale.");
        const atMs = now();
        if (!isSafeTime(atMs) || atMs < current.mutationIssuedAtMs) throw new TelegramChannelPostJournalError("invalid", "Telegram channel post clock is invalid.");
        const { mutationId, attemptedMarkdown, mutationIssuedAtMs, ...prior } = current;
        const record: TelegramChannelPostRecord = { ...prior, state: "published", markdown: attemptedMarkdown,
          lastMutationId: mutationId, updatedAtMs: atMs };
        const records = [...file.records]; records[index] = record; publish({ ...file, records });
        return { confirmed: true, record: structuredClone(record) };
      });
    },
    beginDelete(input) {
      return mutate(file => {
        const index = file.records.findIndex(record => record.operationId === input.operationId);
        if (index < 0) throw new TelegramChannelPostJournalError("conflict", "Telegram channel post is missing.");
        const current = file.records[index]!;
        if (current.state === "delete-outcome-unknown") {
          if (current.mutationId === input.mutationId) return { began: false, record: structuredClone(current) };
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post already has an unresolved deletion.");
        }
        if (current.state === "deleted" && current.mutationId === input.mutationId)
          return { began: false, record: structuredClone(current) };
        if (current.state !== "published" || !input.mutationId || input.mutationId.length > MAX_ID_LENGTH)
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post deletion is invalid or unavailable.");
        const atMs = now();
        if (!isSafeTime(atMs) || atMs < current.updatedAtMs) throw new TelegramChannelPostJournalError("invalid", "Telegram channel post clock is invalid.");
        const record: TelegramChannelPostRecord = { ...current, state: "delete-outcome-unknown",
          mutationId: input.mutationId, mutationIssuedAtMs: atMs, updatedAtMs: atMs };
        const records = [...file.records]; records[index] = record; publish({ ...file, records });
        return { began: true, record: structuredClone(record) };
      });
    },
    confirmDeleted(input) {
      return mutate(file => {
        const index = file.records.findIndex(record => record.operationId === input.operationId);
        if (index < 0) throw new TelegramChannelPostJournalError("conflict", "Telegram channel post is missing.");
        const current = file.records[index]!;
        if (current.state === "deleted" && current.mutationId === input.mutationId)
          return { confirmed: false, record: structuredClone(current) };
        if (current.state !== "delete-outcome-unknown" || current.mutationId !== input.mutationId)
          throw new TelegramChannelPostJournalError("conflict", "Telegram channel post deletion confirmation is stale.");
        const atMs = now();
        if (!isSafeTime(atMs) || atMs < current.mutationIssuedAtMs) throw new TelegramChannelPostJournalError("invalid", "Telegram channel post clock is invalid.");
        const { mutationIssuedAtMs, ...prior } = current;
        const record: TelegramChannelPostRecord = { ...prior, state: "deleted", deletedAtMs: atMs, updatedAtMs: atMs };
        const records = [...file.records]; records[index] = record; publish({ ...file, records });
        return { confirmed: true, record: structuredClone(record) };
      });
    },
    get(operationId) {
      if (typeof operationId !== "string" || operationId.length === 0 || operationId.length > MAX_ID_LENGTH) {
        throw new TelegramChannelPostJournalError("invalid", "Telegram channel post operation ID is invalid.");
      }
      const record = read().records.find(candidate => candidate.operationId === operationId);
      return record === undefined ? undefined : structuredClone(record);
    },
    list(input = {}) {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxRecords) {
        throw new TelegramChannelPostJournalError("invalid", "Telegram channel post list limit is invalid.");
      }
      const channel = input.channel === undefined ? undefined : normalizeChannel(input.channel);
      return read().records.filter(record => channel === undefined || record.requestedChannel === channel)
        .slice(-limit).reverse().map(record => structuredClone(record));
    },
  };
}
