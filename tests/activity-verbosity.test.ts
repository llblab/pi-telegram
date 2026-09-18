/**
 * Telegram activity verbosity projection regressions
 * Covers four activity modes, persistent reasoning, bounded tool disclosures, ordering, redaction, and authority fencing
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramActivityVerbosityBinding,
  createTelegramActivityVerbosityRuntime,
  renderTelegramThinkingActivityHtml,
  renderTelegramToolActivityHtml,
  renderTelegramToolActivityRichMessage,
  TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS,
  TELEGRAM_REASONING_BUFFER_MAX_CHARS,
  TELEGRAM_TOOL_UPDATE_MAX_ENTRIES,
} from "../lib/activity-verbosity.ts";
import type {
  TelegramActivityEvent,
  TelegramActivityPayload,
} from "../lib/activity.ts";
import type {
  TelegramEditMessageTextBody,
  TelegramSendMessageBody,
  TelegramSendRichMessageBody,
} from "../lib/telegram-api.ts";

test("Activity verbosity binding safely delegates after late composition", async () => {
  const calls: string[] = [];
  const binding = createTelegramActivityVerbosityBinding();
  binding.reset();
  await binding.waitForIdle();
  binding.bind({
    accept: () => calls.push("accept"),
    reset: () => calls.push("reset"),
    stop: () => calls.push("stop"),
    waitForIdle: async () => {
      calls.push("idle");
    },
  });
  binding.accept({} as TelegramActivityEvent);
  binding.reset();
  binding.stop();
  await binding.waitForIdle();
  assert.deepEqual(calls, ["accept", "reset", "stop", "idle"]);
});

function event(
  sequence: number,
  payload: TelegramActivityPayload,
): TelegramActivityEvent {
  return {
    ...payload,
    activityId: "session:1",
    sequence,
    source: "telegram",
    target: { chatId: 42, threadId: 7 },
    timestamp: sequence,
  } as TelegramActivityEvent;
}

type ActivityMode = "quiet" | "thinking" | "tools" | "verbose";

function createHarness(
  options: {
    mode?: ActivityMode;
    refreshedMode?: ActivityMode;
    refreshError?: Error;
    richSendError?: Error;
    fakeReasoningTimers?: boolean;
  } = {},
) {
  let mode = options.mode ?? "verbose";
  let authority = 1;
  let nowMs = 0;
  const sends: TelegramSendMessageBody[] = [];
  const richSends: TelegramSendRichMessageBody[] = [];
  const edits: TelegramEditMessageTextBody[] = [];
  const reasoningTimers: Array<() => void> = [];
  const runtime = createTelegramActivityVerbosityRuntime({
    getActivityMode: () => mode,
    refreshActivityMode: async () => {
      if (options.refreshError) throw options.refreshError;
      if (options.refreshedMode) mode = options.refreshedMode;
    },
    getNowMs: () => nowMs,
    ...(options.fakeReasoningTimers
      ? {
          setReasoningTimeout: (callback: () => void) => {
            reasoningTimers.push(callback);
            return { unref() {} } as ReturnType<typeof setTimeout>;
          },
          clearReasoningTimeout: () => {
            reasoningTimers.shift();
          },
        }
      : {}),
    resolveTarget: (activity) => activity.target,
    captureAuthority: () => authority,
    isAuthorityActive: (captured) => captured === authority,
    async sendMessage(body) {
      sends.push(body);
      return { message_id: sends.length };
    },
    async sendRichMessage(body) {
      if (options.richSendError) throw options.richSendError;
      richSends.push(body);
      return { message_id: 100 + richSends.length };
    },
    async editMessageText(body) {
      edits.push(body);
      return "edited";
    },
  });
  return {
    runtime,
    sends,
    richSends,
    edits,
    setMode(value: ActivityMode) {
      mode = value;
    },
    advanceNow(ms: number) {
      nowMs += ms;
    },
    replaceAuthority() {
      authority += 1;
    },
    flushReasoningTimer() {
      reasoningTimers.shift()?.();
    },
  };
}

test("Activity captures authority at admission rather than after queue delay", async () => {
  const harness = createHarness({ mode: "tools" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(event(2, { type: "tool-end", toolCallId: "read-1", toolName: "read", result: "old output", isError: false }));
  harness.replaceAuthority();
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
  assert.deepEqual(harness.richSends, []);
  assert.deepEqual(harness.edits, []);
});

for (const stage of ["refresh", "tool-send", "tool-edit", "reasoning-end", "agent-end"] as const) {
for (const outcome of ["resolve", "reject"] as const) {
  test(`Activity replacement survives late ${stage} ${outcome}`, async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pause = async () => {
      markStarted();
      await gate;
      if (outcome === "reject") throw new Error("HTTP 400: Bad Request: fixture rejection");
    };
    let refreshes = 0;
    let nextId = 0;
    let edits = 0;
    const effects: Array<Record<string, unknown>> = [];
    const runtime = createTelegramActivityVerbosityRuntime({
      getActivityMode: () => "verbose",
      getNowMs: () => 0,
      refreshActivityMode: async () => { if (++refreshes === 1 && stage === "refresh") await pause(); },
      resolveTarget: (input) => input.target,
      captureAuthority: () => 1,
      isAuthorityActive: () => true,
      sendRichMessage: async (body) => {
        const id = ++nextId;
        effects.push(body);
        if (id === 1 && stage === "tool-send") await pause();
        return { message_id: id };
      },
      sendMessage: async (body) => {
        const id = ++nextId;
        effects.push(body);
        if (id === 1 && (stage === "reasoning-end" || stage === "agent-end")) await pause();
        return { message_id: id };
      },
      editMessageText: async (body) => {
        effects.push(body);
        if (++edits === 1 && (stage === "tool-edit" || stage === "agent-end")) await pause();
        return "edited";
      },
      recordFailure: () => {},
    });
    let sequence = 0;
    const accept = (id: string, payload: TelegramActivityPayload) => runtime.accept({
      ...event(++sequence, payload), activityId: id,
      target: { chatId: id === "old" ? 7 : 8, threadId: id === "old" ? 42 : 43 },
    });
    const finishTool = (id: string, toolCallId: string) => accept(id, {
      type: "tool-end", toolCallId, toolName: "read", result: `${id} result`, isError: false,
    });
    let oldIdle: Promise<void> | undefined;
    try {
      accept("old", { type: "agent-start" });
      if (stage !== "refresh") await runtime.waitForIdle();
      if (stage === "tool-send") finishTool("old", "first");
      if (stage === "tool-edit") {
        finishTool("old", "first");
        await runtime.waitForIdle();
        finishTool("old", "second");
      }
      if (stage === "reasoning-end") accept("old", { type: "reasoning-end", contentIndex: 0, text: "old reasoning" });
      if (stage === "agent-end") {
        accept("old", { type: "reasoning-delta", contentIndex: 0, delta: "old reasoning more" });
        accept("old", { type: "agent-end" });
      }
      oldIdle = runtime.waitForIdle();
      await started;
      runtime.reset();
      accept("new", { type: "agent-start" });
      const thinking = stage === "reasoning-end" || stage === "agent-end";
      if (thinking) {
        accept("new", { type: "reasoning-delta", contentIndex: 0, delta: "new reasoning" });
      } else {
        accept("new", { type: "tool-start", toolCallId: "new-first", toolName: "read", args: { path: "must-survive.txt" } });
        if (stage !== "refresh") finishTool("new", "new-first");
      }
      await runtime.waitForIdle();
      const beforeRelease = effects.length;
      release();
      await oldIdle;
      if (thinking) {
        accept("new", { type: "reasoning-delta", contentIndex: 0, delta: " extra" });
        accept("new", { type: "reasoning-end", contentIndex: 0, text: "new reasoning extra" });
      } else {
        finishTool("new", stage === "refresh" ? "new-first" : "new-second");
      }
      await runtime.waitForIdle();
      const later = effects.slice(beforeRelease);
      assert.equal(later.length, 1);
      assert.equal(later[0]?.chat_id, 8);
      assert.doesNotMatch(JSON.stringify(later), /old (?:result|reasoning)/);
      assert.equal(nextId, stage === "refresh" ? 1 : 2);
      if (stage !== "refresh" && !thinking) assert.equal(later[0]?.message_id, 2);
      assert.ok(JSON.stringify(later).includes(thinking ? "new reasoning extra" : "must-survive.txt"));
    } finally {
      release();
      await oldIdle;
      runtime.stop();
    }
  });
}
}

for (const operation of ["send", "edit"] as const) {
  test(`Activity ${operation} rejection cannot fall back after transport authority loss`, async () => {
    let authority = 1;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const rejectLate = async (): Promise<never> => {
      markStarted(); await gate;
      throw new Error("HTTP 400: Bad Request: fixture rejection");
    };
    let fallbacks = 0;
    const runtime = createTelegramActivityVerbosityRuntime({
      getActivityMode: () => "tools",
      resolveTarget: (input) => input.target,
      captureAuthority: () => authority,
      isAuthorityActive: (captured) => captured === authority,
      sendRichMessage: async () => operation === "send" ? rejectLate() : { message_id: 1 },
      sendMessage: async () => { fallbacks += 1; return { message_id: 2 }; },
      editMessageText: async (body) => {
        if (body.rich_message) return rejectLate();
        fallbacks += 1; return "edited";
      },
    });
    try {
      runtime.accept(event(1, { type: "tool-end", toolCallId: "one", toolName: "read", result: "one", isError: false }));
      if (operation === "edit") {
        await runtime.waitForIdle();
        runtime.accept(event(2, { type: "tool-end", toolCallId: "two", toolName: "read", result: "two", isError: false }));
      }
      await started;
      authority += 1;
      release();
      await runtime.waitForIdle();
      assert.equal(fallbacks, 0);
    } finally {
      release();
      await runtime.waitForIdle();
      runtime.stop();
    }
  });
}

test("quiet activity emits no reasoning or tool messages", async () => {
  const harness = createHarness({ mode: "quiet" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, { type: "reasoning-delta", contentIndex: 0, delta: "secret" }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "done",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
});

test("tool Rich activity separates arguments, updates, and result details", () => {
  const rich = renderTelegramToolActivityRichMessage([
    {
      id: "tool-1",
      name: "bash",
      args: '{\n  "command": "npm test"\n}',
      updates: ['{\n  "line": 1\n}'],
      droppedUpdates: 2,
      result: '{\n  "ok": true\n}',
      isError: false,
      complete: true,
    },
  ]);
  assert.equal(rich.skip_entity_detection, true);
  assert.deepEqual(rich.blocks, [
    {
      type: "details",
      summary: [
        { type: "bold", text: "Bash:" },
        " ",
        { type: "code", text: "done" },
      ],
      blocks: [
        {
          type: "details",
          summary: { type: "code", text: "arguments" },
          blocks: [
            {
              type: "pre",
              text: '{\n  "command": "npm test"\n}',
              language: "json",
            },
          ],
          is_open: true,
        },
        {
          type: "details",
          summary: {
            type: "code",
            text: "update 3 (2 earlier omitted)",
          },
          blocks: [
            { type: "pre", text: '{\n  "line": 1\n}', language: "json" },
          ],
        },
        {
          type: "details",
          summary: { type: "code", text: "result" },
          blocks: [
            { type: "pre", text: '{\n  "ok": true\n}', language: "json" },
          ],
        },
      ],
    },
  ]);
});

test("tool root labels humanize snake case and preserve repeated prefixes", () => {
  const rich = renderTelegramToolActivityRichMessage(
    ["ffgrep", "fffind", "bash", "telegram_attach", "ff_find_items"].map((name, index) => ({
      id: `tool-${index}`,
      name,
      args: "{}",
      updates: [],
      droppedUpdates: 0,
      result: '"ok"',
      isError: false,
      complete: true,
    })),
  );
  assert.deepEqual(
    rich.blocks?.map((block) =>
      block.type === "details" && Array.isArray(block.summary)
        ? block.summary[0]
        : undefined,
    ),
    [
      { type: "bold", text: "FFgrep:" },
      { type: "bold", text: "FFFind:" },
      { type: "bold", text: "Bash:" },
      { type: "bold", text: "Telegram Attach:" },
      { type: "bold", text: "FF Find Items:" },
    ],
  );
});

test("tool evidence renders as ordinary expandable HTML fallback", () => {
  const html = renderTelegramToolActivityHtml([
    {
      id: "tool-1",
      name: "exec<script>",
      args: '{\n  "command": "npm run check -w @ail/web",\n  "url": "https://example.com/result",\n  "options": {\n    "timeout": 240\n  }\n}',
      updates: ['{\n  "content": []\n}'],
      droppedUpdates: 0,
      result: '{\n  "content": []\n}',
      isError: false,
      complete: true,
    },
  ]);

  assert.match(
    html,
    /^<b>Exec&lt;script&gt;:<\/b> <code>done<\/code>/,
  );
  assert.match(html, /<blockquote expandable>/);
  assert.match(html, /"arguments": \{\n  "command"/);
  assert.equal(html.includes("https://\u200bexample.com/result"), true);
  assert.equal(html.includes("https://example.com/result"), false);
  assert.match(html, /"update 1": \{\n  "content": \[\]/);
  assert.match(html, /"result": \{\n  "content": \[\]/);
  assert.doesNotMatch(html, /rich_message|<pre>/);

  const statuses = renderTelegramToolActivityHtml([
    {
      id: "running",
      name: "read",
      args: "{}",
      updates: [],
      droppedUpdates: 0,
      complete: false,
    },
    {
      id: "failed",
      name: "write",
      args: "{}",
      updates: [],
      droppedUpdates: 0,
      result: '"denied"',
      isError: true,
      complete: true,
    },
  ]);
  assert.match(statuses, /<code>running<\/code>/);
  assert.match(statuses, /<code>failed<\/code>/);
});

test("known-safe Rich rejection falls back to the HTML tool message", async () => {
  const harness = createHarness({
    mode: "tools",
    richSendError: new Error(
      "Telegram API sendRichMessage failed: HTTP 400: Bad Request: unsupported rich block",
    ),
  });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: "done",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.richSends.length, 0);
  assert.equal(harness.sends.length, 1);
  assert.match(harness.sends[0]?.text ?? "", /<b>Bash:<\/b>/);
  assert.match(harness.sends[0]?.text ?? "", /<blockquote expandable>/);
});

test("reasoning uses a persistent target-bound expandable HTML message", async () => {
  const harness = createHarness({ mode: "thinking" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "Checking ",
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "**state**",
    }),
  );
  harness.runtime.accept(
    event(4, {
      type: "reasoning-end",
      contentIndex: 0,
      text: "Checking **state**",
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0]?.chat_id, 42);
  assert.equal(harness.sends[0]?.message_thread_id, 7);
  assert.deepEqual(harness.sends[0]?.link_preview_options, {
    is_disabled: true,
  });
  assert.match(
    harness.sends[0]?.text ?? "",
    /^<blockquote expandable>/,
  );
  assert.equal(harness.edits.length, 0);
  assert.match(harness.sends[0]?.text ?? "", /Checking <b>state<\/b>/);
  assert.equal(harness.sends[0]?.parse_mode, "HTML");
});

test("agent end leaves an already current thinking message unchanged", async () => {
  const harness = createHarness({ mode: "thinking" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "still thinking",
    }),
  );
  harness.runtime.accept(event(3, { type: "agent-end" }));
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.edits.length, 0);
  assert.match(harness.sends[0]?.text ?? "", /^<blockquote expandable>/);
});

test("agent start refreshes file-backed mode before activity isolation", async () => {
  const harness = createHarness({ mode: "verbose", refreshedMode: "thinking" });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "reasoning-end",
      contentIndex: 0,
      text: "private thought",
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "done",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  const text = harness.sends.map((body) => body.text).join("\n");
  assert.equal(text.includes("<blockquote expandable>"), true);
  assert.equal(text.includes("<b>Read:</b>"), false);
});

test("activity fails closed when file-backed mode refresh fails", async () => {
  const harness = createHarness({
    mode: "verbose",
    refreshError: new Error("config unavailable"),
  });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "tool-end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "done",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.deepEqual(harness.sends, []);
});

test("thinking and tools modes isolate their activity classes", async () => {
  for (const mode of ["thinking", "tools"] as const) {
    const harness = createHarness({ mode });
    harness.runtime.accept(event(1, { type: "agent-start" }));
    harness.runtime.accept(
      event(2, {
        type: "reasoning-end",
        contentIndex: 0,
        text: "private thought",
      }),
    );
    harness.runtime.accept(
      event(3, {
        type: "tool-end",
        toolCallId: "tool-1",
        toolName: "read",
        result: "done",
        isError: false,
      }),
    );
    await harness.runtime.waitForIdle();
    const thinkingText = harness.sends.map((body) => body.text).join("\n");
    const toolText = JSON.stringify(harness.richSends);
    assert.equal(
      thinkingText.includes("<blockquote expandable>"),
      mode === "thinking",
    );
    assert.equal(toolText.includes("Read:"), mode === "tools");
  }
});

test("reasoning evidence renders inline HTML inside an expandable quote", () => {
  const html = renderTelegramThinkingActivityHtml(
    "**Reviewing data models**\na < b\n<https://example.com>",
  );
  assert.match(html, /^<blockquote expandable>/);
  assert.match(
    html,
    /<blockquote expandable><b>Reviewing data models<\/b>\na &lt; b/,
  );
  assert.equal(html.includes("https://\u200bexample.com"), true);
  assert.doesNotMatch(html, /<a |rich_message/);
});

test("completed consecutive tools coalesce as collapsed redacted details", async () => {
  const harness = createHarness();
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "tool-start",
      toolCallId: "one",
      toolName: "exec",
      args: { token: "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJK" },
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "one",
      toolName: "exec",
      result: "ok",
      isError: false,
    }),
  );
  harness.runtime.accept(
    event(4, {
      type: "tool-start",
      toolCallId: "two",
      toolName: "read",
      args: { path: "/tmp/a" },
    }),
  );
  harness.runtime.accept(
    event(5, {
      type: "tool-end",
      toolCallId: "two",
      toolName: "read",
      result: "failed",
      isError: true,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.richSends.length, 1);
  assert.equal(harness.edits.length, 1);
  const serialized = JSON.stringify(harness.edits[0]?.rich_message);
  assert.match(serialized, /Read:/);
  assert.match(serialized, /details/);
  assert.match(serialized, /REDACTED/);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyzABCDEFGHIJK/);
  assert.equal(harness.edits[0]?.text, undefined);
});

test("tool Rich details keep compact arrays of objects", async () => {
  const harness = createHarness();
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "tool-start",
      toolCallId: "compact",
      toolName: "ffgrep",
      args: { pattern: "CORE_SERVICE_URL", path: "apps/admin/", limit: 30 },
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-update",
      toolCallId: "compact",
      toolName: "ffgrep",
      update: {
        content: [
          { type: "text", text: "\n" },
          { type: "text", text: "\n" },
        ],
        details: {},
      },
    }),
  );
  harness.runtime.accept(
    event(4, {
      type: "tool-end",
      toolCallId: "compact",
      toolName: "ffgrep",
      result: { content: [] },
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();

  const rich = JSON.stringify(harness.richSends[0]?.rich_message);
  assert.match(rich, /arguments/);
  assert.match(rich, /update 1/);
  assert.match(rich, /result/);
  assert.match(rich, /\\"content\\":\s*\[/);
  assert.match(rich, /\\"result\\"|result/);
});

test("assistant boundaries, capacity, and authority replacement fence batches", async () => {
  const harness = createHarness();
  harness.runtime.accept(event(1, { type: "agent-start" }));
  let sequence = 2;
  for (let index = 0; index < TELEGRAM_ACTIVITY_MESSAGE_MAX_TOOLS + 1; index++) {
    harness.runtime.accept(
      event(sequence++, {
        type: "tool-end",
        toolCallId: `tool-${index}`,
        toolName: "read",
        result: index,
        isError: false,
      }),
    );
  }
  harness.runtime.accept(
    event(sequence++, {
      type: "assistant-segment",
      contentIndex: 0,
      text: "checkpoint",
      placement: "intermediate",
    }),
  );
  harness.runtime.accept(
    event(sequence++, {
      type: "tool-end",
      toolCallId: "after-boundary",
      toolName: "write",
      result: "ok",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.richSends.length, 3);

  harness.replaceAuthority();
  harness.runtime.accept(
    event(sequence, {
      type: "tool-end",
      toolCallId: "stale",
      toolName: "exec",
      result: "must not send",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.richSends.length, 3);
});

test("parallel tool completion preserves tool-start order", async () => {
  const harness = createHarness();
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "tool-start",
      toolCallId: "first",
      toolName: "first-tool",
      args: {},
    }),
  );
  harness.runtime.accept(
    event(3, {
      type: "tool-start",
      toolCallId: "second",
      toolName: "second-tool",
      args: {},
    }),
  );
  harness.runtime.accept(
    event(4, {
      type: "tool-end",
      toolCallId: "second",
      toolName: "second-tool",
      result: "second result",
      isError: false,
    }),
  );
  harness.runtime.accept(
    event(5, {
      type: "tool-end",
      toolCallId: "first",
      toolName: "first-tool",
      result: "first result",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.richSends.length, 1);
  assert.equal(harness.edits.length, 1);
  const text = JSON.stringify(harness.edits[0]?.rich_message);
  assert.ok(text.indexOf("First-tool") < text.indexOf("Second-tool"));
  assert.equal(harness.edits[0]?.text, undefined);
});

test("reasoning and tool updates retain bounded latest evidence", async () => {
  const harness = createHarness({ fakeReasoningTimers: true });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: `old-marker-${"x".repeat(TELEGRAM_REASONING_BUFFER_MAX_CHARS)}latest-marker`,
    }),
  );
  await harness.runtime.waitForIdle();
  harness.flushReasoningTimer();
  harness.runtime.accept(
    event(3, {
      type: "tool-start",
      toolCallId: "bounded",
      toolName: "exec",
      args: {},
    }),
  );
  for (let index = 0; index < TELEGRAM_TOOL_UPDATE_MAX_ENTRIES + 3; index++) {
    harness.runtime.accept(
      event(4 + index, {
        type: "tool-update",
        toolCallId: "bounded",
        toolName: "exec",
        update: `update-${index}`,
      }),
    );
  }
  harness.runtime.accept(
    event(20, {
      type: "tool-end",
      toolCallId: "bounded",
      toolName: "exec",
      result: "done",
      isError: false,
    }),
  );
  await harness.runtime.waitForIdle();

  const reasoning = harness.sends[0]?.text ?? "";
  assert.match(reasoning, /earlier chars omitted/);
  assert.match(reasoning, /latest-marker/);
  assert.doesNotMatch(reasoning, /old-marker/);
  const tool = JSON.stringify(harness.richSends[0]?.rich_message);
  assert.match(tool, /3 earlier omitted/);
  assert.doesNotMatch(tool, /update-0/);
  assert.match(tool, /update-6/);
});

test("reasoning waits for an accumulated first frame and throttles later edits", async () => {
  const harness = createHarness({ mode: "thinking", fakeReasoningTimers: true });
  harness.runtime.accept(event(1, { type: "agent-start" }));
  harness.runtime.accept(
    event(2, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "a".repeat(200),
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 0, "opening frame remains buffered");
  harness.runtime.accept(
    event(3, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "b".repeat(200),
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 0, "opening deltas accumulate together");
  harness.advanceNow(2_000);
  harness.flushReasoningTimer();
  await harness.runtime.waitForIdle();
  assert.equal(harness.sends.length, 1, "first frame publishes after two seconds");
  harness.runtime.accept(
    event(4, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "c".repeat(200),
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.edits.length, 0, "next frame is scheduled, not immediate");
  harness.advanceNow(2_000);
  harness.flushReasoningTimer();
  await harness.runtime.waitForIdle();
  assert.equal(harness.edits.length, 1, "next frame publishes after its interval");
  harness.runtime.accept(
    event(5, {
      type: "reasoning-delta",
      contentIndex: 0,
      delta: "d".repeat(200),
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(
    harness.edits.length,
    1,
    "delta inside the new interval stays throttled",
  );
  harness.runtime.accept(
    event(6, {
      type: "reasoning-end",
      contentIndex: 0,
      text: "done",
    }),
  );
  await harness.runtime.waitForIdle();
  assert.equal(harness.edits.length, 2, "final flush covers throttled chars");
});

test("reset drops accepted events that have not started processing", async () => {
  let releaseReasoning!: () => void;
  const reasoningBlocked = new Promise<void>((resolve) => {
    releaseReasoning = resolve;
  });
  const sends: TelegramSendMessageBody[] = [];
  const richSends: TelegramSendRichMessageBody[] = [];
  const runtime = createTelegramActivityVerbosityRuntime({
    getActivityMode: () => "verbose",
    resolveTarget: (activity) => activity.target,
    captureAuthority: () => 1,
    isAuthorityActive: () => true,
    async sendMessage(body) {
      if (body.text.includes("<blockquote expandable>")) {
        await reasoningBlocked;
      }
      sends.push(body);
      return { message_id: 1 };
    },
    async sendRichMessage(body) {
      richSends.push(body);
      return { message_id: 2 };
    },
    async editMessageText() {
      return "edited";
    },
  });
  runtime.accept(event(1, { type: "agent-start" }));
  runtime.accept(
    event(2, { type: "reasoning-end", contentIndex: 0, text: "working" }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.accept(
    event(3, {
      type: "tool-end",
      toolCallId: "stale",
      toolName: "exec",
      result: "must not send",
      isError: false,
    }),
  );
  runtime.reset();
  runtime.accept({
    ...event(4, { type: "agent-start" }),
    activityId: "session:2",
  });
  runtime.accept({
    ...event(5, {
      type: "tool-end",
      toolCallId: "fresh",
      toolName: "read",
      result: "new session",
      isError: false,
    }),
    activityId: "session:2",
  });
  await runtime.waitForIdle();
  assert.equal(sends.length, 0);
  assert.equal(richSends.length, 1);
  assert.match(JSON.stringify(richSends[0]), /new session/);
  assert.doesNotMatch(JSON.stringify(richSends[0]), /must not send/);
  releaseReasoning();
});
