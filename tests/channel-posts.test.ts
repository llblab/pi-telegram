/**
 * Agent-owned Telegram channel post journal regressions
 * Zones: telegram outbound, filesystem authority
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import assert from "node:assert/strict";
import nodeTest from "node:test";

import {
  assertTelegramChannelPostCaptionWithinLimit,
  assertTelegramChannelPostMediaSize,
  createTelegramChannelPostJournalStore,
  getTelegramChannelPostCaptionLength,
  inspectTelegramChannelPostMedia,
  publishTelegramChannelPost,
  registerTelegramChannelPostListTool,
  registerTelegramChannelPostMutationTool,
  resolveTelegramChannelPostMediaKind,
  TelegramChannelPostJournalError,
  TelegramChannelPostValidationError,
} from "../lib/channel-posts.ts";
import type { ExtensionAPI } from "../lib/pi.ts";

const tokenSha256 = "a".repeat(64);
const execFileAsync = promisify(execFile);
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

async function withStore(run: (input: { path: string; now: (value: number) => void;
  store: ReturnType<typeof createTelegramChannelPostJournalStore> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-channel-posts-"));
  const path = join(dir, "channel-posts.work.json");
  let current = 100;
  try {
    const store = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256,
      getNowMs: () => current });
    await run({ path, store, now: value => { current = value; } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function isCode(error: unknown, code: TelegramChannelPostJournalError["code"]): boolean {
  return error instanceof TelegramChannelPostJournalError && error.code === code;
}

test("Channel post journal fences publication before issuance and confirms one exact post", async () => {
  await withStore(async ({ path, store, now }) => {
    const prepared = store.prepare({ operationId: "post-1", channel: "@public_channel",
      markdown: "**Release**" });
    assert.equal(prepared.prepared, true);
    assert.equal(store.prepare({ operationId: "post-1", channel: "@public_channel",
      markdown: "**Release**" }).prepared, false);
    assert.throws(() => store.prepare({ operationId: "post-1", channel: "@other_channel",
      markdown: "**Release**" }), error => isCode(error, "conflict"));
    now(110);
    const issued = store.beginPublication("post-1");
    assert.equal(issued.began, true);
    assert.equal(issued.record.state, "outcome-unknown");
    assert.equal(store.beginPublication("post-1").began, false);
    now(120);
    const confirmed = store.confirmPublished({ operationId: "post-1", channelId: -100123,
      messageId: 42, channelUsername: "@public_channel", channelTitle: "Public Channel" });
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.record.state === "published" && confirmed.record.channelTitle, "Public Channel");
    assert.equal(store.confirmPublished({ operationId: "post-1", channelId: -100123,
      messageId: 42, channelUsername: "@public_channel", channelTitle: "Public Channel" }).confirmed, false);
    assert.throws(() => store.confirmPublished({ operationId: "post-1", channelId: -100123,
      messageId: 43, channelUsername: "@public_channel", channelTitle: "Public Channel" }),
      error => isCode(error, "conflict"));
    assert.deepEqual(store.list(), [confirmed.record]);
    const restarted = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    assert.deepEqual(restarted.list({ channel: "@public_channel", limit: 1 }), [confirmed.record]);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  });
});

test("Replacement publication helper does not resend after lost success or outcome acknowledgement", async () => {
  await withStore(async ({ path, store }) => {
    let successfulSends = 0;
    const successInput = {
      store, operationId: "success", channel: -1001 as const, markdown: "Post",
      async observeChannel() { return { id: -1001, type: "channel", title: "Channel" }; },
      async send() { successfulSends += 1; return { messageId: 7, chat: { id: -1001, type: "channel" } }; },
    };
    await publishTelegramChannelPost(successInput); // Caller loses this successful acknowledgement.
    const replacement = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    const replay = await publishTelegramChannelPost({ ...successInput, store: replacement });
    assert.equal(replay.state, "published");
    assert.equal(successfulSends, 1);

    let ambiguousSends = 0;
    const ambiguousInput = {
      store, operationId: "ambiguous", channel: -1002 as const, markdown: "Post",
      async observeChannel() { return { id: -1002, type: "channel" }; },
      async send(): Promise<never> { ambiguousSends += 1; throw new Error("lost Bot API acknowledgement"); },
    };
    await assert.rejects(publishTelegramChannelPost(ambiguousInput));
    const nextReplacement = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    await assert.rejects(publishTelegramChannelPost({ ...ambiguousInput, store: nextReplacement }),
      /outcome is unknown/u);
    assert.equal(ambiguousSends, 1);
    assert.equal(store.list({ channel: -1002 })[0]?.state, "outcome-unknown");
  });
});

test("Channel post journal grants one cross-process publication, edit, and delete issuance", async () => {
  await withStore(async ({ path, store }) => {
    store.prepare({ operationId: "shared", channel: "@public_channel", markdown: "Post" });
    const args = ["--experimental-strip-types", "tests/fixtures/channel-post-worker.ts",
      path, "work", tokenSha256, "begin", "shared"];
    const results = await Promise.all([
      execFileAsync(process.execPath, args, { cwd: process.cwd() }),
      execFileAsync(process.execPath, args, { cwd: process.cwd() }),
    ]);
    const began = results.map(result => (JSON.parse(result.stdout) as { began: boolean }).began).sort();
    assert.deepEqual(began, [false, true]);
    const restarted = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    assert.equal(restarted.list()[0]?.state, "outcome-unknown");
    assert.equal(restarted.beginPublication("shared").began, false);
    restarted.confirmPublished({ operationId: "shared", channelId: -1001, messageId: 7 });
    const editArgs = ["--experimental-strip-types", "tests/fixtures/channel-post-worker.ts",
      path, "work", tokenSha256, "begin-edit", "shared", "edit-shared", "Edited"];
    const edits = await Promise.all([
      execFileAsync(process.execPath, editArgs, { cwd: process.cwd() }),
      execFileAsync(process.execPath, editArgs, { cwd: process.cwd() }),
    ]);
    assert.deepEqual(edits.map(result =>
      (JSON.parse(result.stdout) as { began: boolean }).began).sort(), [false, true]);
    assert.equal(restarted.list()[0]?.state, "edit-outcome-unknown");
    restarted.confirmEdited({ operationId: "shared", mutationId: "edit-shared" });
    const deleteArgs = ["--experimental-strip-types", "tests/fixtures/channel-post-worker.ts",
      path, "work", tokenSha256, "begin-delete", "shared", "delete-shared"];
    const deletions = await Promise.all([
      execFileAsync(process.execPath, deleteArgs, { cwd: process.cwd() }),
      execFileAsync(process.execPath, deleteArgs, { cwd: process.cwd() }),
    ]);
    assert.deepEqual(deletions.map(result =>
      (JSON.parse(result.stdout) as { began: boolean }).began).sort(), [false, true]);
    const afterDeleteRace = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    assert.equal(afterDeleteRace.list()[0]?.state, "delete-outcome-unknown");
    assert.equal(afterDeleteRace.beginDelete({ operationId: "shared",
      mutationId: "delete-shared" }).began, false);
  });
});

test("Channel post journal fences exact edit and delete mutations", async () => {
  await withStore(async ({ store, now }) => {
    store.prepare({ operationId: "post", channel: "@public_channel", markdown: "Old" });
    now(110); store.beginPublication("post");
    now(120); store.confirmPublished({ operationId: "post", channelId: -1001, messageId: 7 });
    now(130);
    assert.equal(store.beginEdit({ operationId: "post", mutationId: "edit-1", markdown: "New" }).began, true);
    assert.equal(store.beginEdit({ operationId: "post", mutationId: "edit-1", markdown: "New" }).began, false);
    assert.throws(() => store.beginDelete({ operationId: "post", mutationId: "delete-early" }),
      error => isCode(error, "conflict"));
    now(140);
    const edited = store.confirmEdited({ operationId: "post", mutationId: "edit-1" });
    assert.equal(edited.confirmed, true);
    assert.equal(edited.record.markdown, "New");
    assert.equal(store.confirmEdited({ operationId: "post", mutationId: "edit-1" }).confirmed, false);
    now(150);
    assert.equal(store.beginDelete({ operationId: "post", mutationId: "delete-1" }).began, true);
    assert.equal(store.beginDelete({ operationId: "post", mutationId: "delete-1" }).began, false);
    now(160);
    assert.equal(store.confirmDeleted({ operationId: "post", mutationId: "delete-1" }).confirmed, true);
    assert.equal(store.confirmDeleted({ operationId: "post", mutationId: "delete-1" }).confirmed, false);
    assert.equal(store.list()[0]?.state, "deleted");
  });
});

test("Channel post mutation tool binds the tool call to one exact mutation", async () => {
  let tool: { execute: (id: string, params: { action: "edit"; operation_id: string;
    markdown: string }) => Promise<unknown> } | undefined;
  let observed: unknown;
  registerTelegramChannelPostMutationTool({ registerTool(definition: unknown) {
    tool = definition as typeof tool;
  } } as unknown as ExtensionAPI, { async mutate(input) {
    if (input.markdown === "SECRET") throw new Error("transport leaked SECRET token");
    observed = input;
    return { operationId: input.operationId, requestedChannel: "@public_channel", markdown: input.markdown!,
      createdAtMs: 1, updatedAtMs: 2, state: "published", issuedAtMs: 1, publishedAtMs: 2,
      channelId: -1001, messageId: 7 };
  } });
  assert.ok(tool);
  const result = await tool.execute("mutation-call", {
    action: "edit", operation_id: "post", markdown: "New",
  }) as { content: Array<{ type: "text"; text: string }> };
  assert.equal(result.content[0]?.text.startsWith("\n"), true);
  assert.deepEqual(observed, { action: "edit", operationId: "post", mutationId: "mutation-call", markdown: "New" });
  await assert.rejects(tool.execute("secret-call", {
    action: "edit", operation_id: "post", markdown: "SECRET",
  }), error => error instanceof Error && error.message.startsWith("\n") &&
    !error.message.includes("SECRET") && !error.message.includes("token"));
});

test("Channel post list tool returns only bounded local journal records", async () => {
  await withStore(async ({ store }) => {
    store.prepare({ operationId: "post", channel: "@public_channel", markdown: "Post" });
    let tool: { execute: (id: string, params: { chat_id?: string; limit?: number }) => Promise<unknown> } | undefined;
    registerTelegramChannelPostListTool({ registerTool(definition: unknown) {
      tool = definition as typeof tool;
    } } as unknown as ExtensionAPI, { list: store.list });
    assert.ok(tool);
    const result = await tool.execute("read", { chat_id: "@public_channel", limit: 1 }) as {
      content: Array<{ type: "text"; text: string }>;
      details: { records: Array<{ operationId: string }> };
    };
    assert.equal(result.content[0]?.text.startsWith("\n"), true);
    assert.deepEqual(result.details.records.map(record => record.operationId), ["post"]);
  });
});

test("Channel post journal retains unknown outcomes and refuses invalid identity or capacity", async () => {
  await withStore(async ({ path, store }) => {
    store.prepare({ operationId: "unknown", channel: -1007, markdown: "Post" });
    store.beginPublication("unknown");
    assert.equal(store.list()[0]!.state, "outcome-unknown");
    assert.throws(() => store.confirmPublished({ operationId: "unknown", channelId: -1007,
      messageId: 1, channelTitle: "x".repeat(256) }), error => isCode(error, "conflict"));
    assert.throws(() => store.prepare({ operationId: "bad", channel: "channel" as never,
      markdown: "Post" }), error => isCode(error, "invalid"));
    const full = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256,
      maxRecords: 1 });
    assert.throws(() => full.prepare({ operationId: "second", channel: -1008, markdown: "Post" }),
      error => isCode(error, "capacity"));
    const tiny = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256,
      maxBytes: 32 });
    assert.throws(() => tiny.list(), error => isCode(error, "capacity"));
    await writeFile(path, JSON.stringify({ version: 2, profile: "work", tokenSha256, records: [] }));
    assert.throws(() => store.list(), error => isCode(error, "conflict"));
    await writeFile(path, JSON.stringify({ version: 1, profile: "work", tokenSha256,
      records: [], unknown: true }));
    assert.throws(() => store.list(), error => isCode(error, "conflict"));
    await writeFile(path, JSON.stringify({ version: 1, profile: "other", tokenSha256, records: [] }));
    assert.throws(() => store.list(), error => isCode(error, "conflict"));
    await rm(path);
    await symlink("/etc/passwd", path);
    assert.throws(() => store.list(), error => isCode(error, "invalid"));
    await rm(path);
    await writeFile(path, JSON.stringify({ version: 1, profile: "work", tokenSha256, records: [] }),
      { mode: 0o644 });
    assert.throws(() => store.list(), error => isCode(error, "invalid"));
  });
});

test("Channel post journal binds one exact media intent to publication and retains it", async () => {
  await withStore(async ({ path, store, now }) => {
    const media = { kind: "photo" as const, fileName: "cover.jpg", sizeBytes: 4,
      sha256: "b".repeat(64) };
    assert.equal(store.prepare({ operationId: "media-1", channel: "@public_channel",
      markdown: "Cover", media }).prepared, true);
    assert.equal(store.prepare({ operationId: "media-1", channel: "@public_channel",
      markdown: "Cover", media }).prepared, false);
    assert.throws(() => store.prepare({ operationId: "media-1", channel: "@public_channel",
      markdown: "Cover", media: { ...media, sha256: "c".repeat(64) } }),
      error => isCode(error, "conflict"));
    assert.throws(() => store.prepare({ operationId: "media-1", channel: "@public_channel",
      markdown: "Cover", media: { ...media, kind: "video" } }),
      error => isCode(error, "conflict"));
    assert.throws(() => store.prepare({ operationId: "media-1", channel: "@public_channel",
      markdown: "Other caption", media }), error => isCode(error, "conflict"));
    assert.throws(() => store.prepare({ operationId: "media-bad", channel: "@public_channel",
      markdown: "Cover", media: { ...media, fileName: "" } }),
      error => isCode(error, "invalid"));
    assert.throws(() => store.prepare({ operationId: "media-bad", channel: "@public_channel",
      markdown: "Cover", media: { ...media, sha256: "nope" } }),
      error => isCode(error, "invalid"));
    assert.equal(store.get("missing"), undefined);
    now(110);
    assert.equal(store.beginPublication("media-1").began, true);
    now(120);
    store.confirmPublished({ operationId: "media-1", channelId: -1001, messageId: 7 });
    const restarted = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    assert.deepEqual(restarted.get("media-1")?.media, media);
  });
});

test("Channel media inspection resolves supported kinds and binds content identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-channel-media-"));
  try {
    const photoPath = join(dir, "Cover.JPG");
    await writeFile(photoPath, Buffer.from("image-bytes"));
    const photo = await inspectTelegramChannelPostMedia(photoPath);
    assert.equal(photo.kind, "photo");
    assert.equal(photo.fileName, "Cover.JPG");
    assert.equal(photo.sizeBytes, 11);
    assert.match(photo.sha256, /^[a-f0-9]{64}$/u);
    const videoPath = join(dir, "clip.mp4");
    await writeFile(videoPath, Buffer.from("video-bytes"));
    assert.equal((await inspectTelegramChannelPostMedia(videoPath)).kind, "video");
    assert.equal(resolveTelegramChannelPostMediaKind("no-extension"), undefined);
    assert.equal(resolveTelegramChannelPostMediaKind("cover.gif"), undefined);
    await assert.rejects(inspectTelegramChannelPostMedia(join(dir, "clip.gif")),
      error => error instanceof TelegramChannelPostValidationError &&
        /Unsupported channel media type/u.test(error.message));
    const linkPath = join(dir, "linked.png");
    await symlink(photoPath, linkPath);
    await assert.rejects(inspectTelegramChannelPostMedia(linkPath),
      error => error instanceof TelegramChannelPostValidationError &&
        /without symbolic links/u.test(error.message));
    await assert.rejects(inspectTelegramChannelPostMedia(join(dir, "missing.png")),
      error => error instanceof TelegramChannelPostValidationError &&
        /readable regular local file/u.test(error.message));
    const emptyPath = join(dir, "empty.png");
    await writeFile(emptyPath, Buffer.alloc(0));
    await assert.rejects(inspectTelegramChannelPostMedia(emptyPath),
      error => error instanceof TelegramChannelPostValidationError && /empty/u.test(error.message));
    assertTelegramChannelPostMediaSize("photo", 10 * 1024 * 1024);
    assertTelegramChannelPostMediaSize("video", 50 * 1024 * 1024);
    assert.throws(() => assertTelegramChannelPostMediaSize("photo", 10 * 1024 * 1024 + 1),
      error => error instanceof TelegramChannelPostValidationError && /upload limit/u.test(error.message));
    assert.throws(() => assertTelegramChannelPostMediaSize("video", 50 * 1024 * 1024 + 1),
      error => error instanceof TelegramChannelPostValidationError && /upload limit/u.test(error.message));
    assert.throws(() => assertTelegramChannelPostMediaSize("photo", 0),
      error => error instanceof TelegramChannelPostValidationError && /empty/u.test(error.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Channel media caption validation counts visible characters only", () => {
  assert.equal(
    getTelegramChannelPostCaptionLength(
      "<b>Bold</b> &amp; <tg-spoiler>hidden</tg-spoiler><br>tail"),
    "Bold & hidden\ntail".length,
  );
  assertTelegramChannelPostCaptionWithinLimit("x".repeat(1024));
  assert.throws(() => assertTelegramChannelPostCaptionWithinLimit("x".repeat(1025)),
    error => error instanceof TelegramChannelPostValidationError &&
      /limit of 1024/u.test(error.message));
  assertTelegramChannelPostCaptionWithinLimit(`<b>${"x".repeat(1024)}</b>`);
});

test("Channel media publication does not resend after lost success or ambiguous acknowledgement", async () => {
  await withStore(async ({ path, store }) => {
    const media = { kind: "photo" as const, fileName: "cover.jpg", sizeBytes: 4,
      sha256: "d".repeat(64) };
    let sends = 0;
    const successInput = {
      store, operationId: "media-success", channel: -1001 as const, markdown: "Cover", media,
      async observeChannel() { return { id: -1001, type: "channel" }; },
      async send() { sends += 1; return { messageId: 8, chat: { id: -1001, type: "channel" } }; },
    };
    await publishTelegramChannelPost(successInput);
    const replacement = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    const replay = await publishTelegramChannelPost({ ...successInput, store: replacement });
    assert.equal(replay.state, "published");
    assert.equal(sends, 1);
    assert.deepEqual(replay.media, media);

    let ambiguous = 0;
    const ambiguousInput = {
      store, operationId: "media-ambiguous", channel: -1002 as const, markdown: "Cover", media,
      async observeChannel() { return { id: -1002, type: "channel" }; },
      async send(): Promise<never> { ambiguous += 1; throw new Error("lost Bot API acknowledgement"); },
    };
    await assert.rejects(publishTelegramChannelPost(ambiguousInput));
    const next = createTelegramChannelPostJournalStore({ path, profileName: "work", tokenSha256 });
    await assert.rejects(publishTelegramChannelPost({ ...ambiguousInput, store: next }),
      /outcome is unknown/u);
    assert.equal(ambiguous, 1);
    assert.equal(store.list({ channel: -1002 })[0]?.media?.sha256, media.sha256);
  });
});
