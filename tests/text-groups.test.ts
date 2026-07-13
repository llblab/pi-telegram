/**
 * Regression tests for Telegram text-group coalescing
 * Exercises conservative recovery of automatically split long Telegram messages
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as TextGroups from "../lib/text-groups.ts";

type TestMessage = TextGroups.TelegramTextGroupMessage;

function createMessage(
  messageId: number,
  text: string,
  overrides: Partial<TestMessage> = {},
): TestMessage {
  return {
    message_id: messageId,
    chat: { id: 99 },
    from: { id: 77, is_bot: false },
    text,
    ...overrides,
  };
}

test("Text group helper delays likely split messages and appends quick continuations", () => {
  const groups = new Map<
    string,
    TextGroups.TelegramTextGroupState<TestMessage, string>
  >();
  const timers: Array<() => void> = [];
  const dispatched: string[] = [];
  const queue = (message: TestMessage) =>
    TextGroups.queueTelegramTextGroupMessage({
      message,
      context: "ctx",
      groups,
      debounceMs: 10,
      minSplitLength: 8,
      setTimer: (callback) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      dispatchMessages: (messages, ctx) => {
        dispatched.push(
          `${ctx}:${messages.map((item) => item.text).join("|")}`,
        );
      },
    });
  assert.equal(queue(createMessage(1, "short")), false);
  assert.equal(queue(createMessage(2, "long-enough")), true);
  assert.equal(queue(createMessage(3, "tail")), true);
  assert.deepEqual(dispatched, []);
  timers.at(-1)?.();
  assert.deepEqual(dispatched, ["ctx:long-enough|tail"]);
});

test("Text group keeps split messages until asynchronous dispatch succeeds", async () => {
  const groups = new Map<
    string,
    TextGroups.TelegramTextGroupState<TestMessage, string>
  >();
  const timers: Array<() => void> = [];
  let attempts = 0;
  TextGroups.queueTelegramTextGroupMessage({
    message: createMessage(1, "long-enough"),
    context: "ctx",
    groups,
    debounceMs: 10,
    minSplitLength: 8,
    setTimer: (callback) => {
      timers.push(callback);
      return callback as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    dispatchMessages: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("queue admission failed");
    },
  });

  timers[0]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(groups.size, 1);
  assert.equal(timers.length, 2);
  timers[1]?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(groups.size, 0);
});

test("Text group controller clears pending timers without stale dispatch", () => {
  const dispatched: string[] = [];
  const timers: Array<{ active: boolean; callback: () => void }> = [];
  const controller = TextGroups.createTelegramTextGroupController<
    TestMessage,
    string
  >({
    debounceMs: 10,
    minSplitLength: 8,
    setTimer: (callback) => {
      const timer = { active: true, callback };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { active: boolean }).active = false;
    },
  });
  const dispatchMessages = (messages: TestMessage[], ctx: string) => {
    dispatched.push(`${ctx}:${messages.map((item) => item.text).join("|")}`);
  };
  assert.equal(
    controller.queueMessage({
      message: createMessage(1, "long-enough"),
      context: "ctx",
      dispatchMessages,
    }),
    true,
  );
  controller.clear();
  for (const timer of timers) {
    if (timer.active) timer.callback();
  }
  assert.deepEqual(dispatched, []);
});

test("Text group suspension resumes admitted input in the replacement context", async () => {
  const timers: Array<{ active: boolean; callback: () => void }> = [];
  const dispatched: string[] = [];
  const controller = TextGroups.createTelegramTextGroupController<
    TestMessage,
    string
  >({
    debounceMs: 10,
    minSplitLength: 8,
    setTimer: (callback) => {
      const timer = { active: true, callback };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { active: boolean }).active = false;
    },
  });
  controller.queueMessage({
    message: createMessage(1, "long-enough"),
    context: "old-session",
    dispatchMessages: (messages, ctx) => {
      dispatched.push(`${ctx}:${messages.map((item) => item.text).join("|")}`);
    },
  });

  controller.suspend();
  controller.resume("new-session");
  for (const timer of timers) {
    if (timer.active) timer.callback();
  }
  await Promise.resolve();

  assert.deepEqual(dispatched, ["new-session:long-enough"]);
});

test("Text group helper uses 3600 as the default near-limit threshold", () => {
  const groups = new Map<
    string,
    TextGroups.TelegramTextGroupState<TestMessage, string>
  >();
  const timers: Array<() => void> = [];
  const queue = (message: TestMessage) =>
    TextGroups.queueTelegramTextGroupMessage({
      message,
      context: "ctx",
      groups,
      debounceMs: 10,
      minSplitLength: 3600,
      setTimer: (callback) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      dispatchMessages: () => {},
    });
  assert.equal(queue(createMessage(1, "x".repeat(3599))), false);
  assert.equal(queue(createMessage(2, "x".repeat(3600))), true);
});

test("Text group helper ignores commands, bots, media groups, and non-contiguous tails", () => {
  const groups = new Map<
    string,
    TextGroups.TelegramTextGroupState<TestMessage, string>
  >();
  const timers: Array<() => void> = [];
  const base = {
    context: "ctx",
    groups,
    debounceMs: 10,
    minSplitLength: 8,
    setTimer: (callback: () => void) => {
      timers.push(callback);
      return callback as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    dispatchMessages: () => {},
  };
  assert.equal(
    TextGroups.queueTelegramTextGroupMessage({
      ...base,
      message: createMessage(1, "/template lots of text"),
    }),
    false,
  );
  assert.equal(
    TextGroups.queueTelegramTextGroupMessage({
      ...base,
      message: createMessage(2, "long-enough", {
        from: { id: 77, is_bot: true },
      }),
    }),
    false,
  );
  assert.equal(
    TextGroups.queueTelegramTextGroupMessage({
      ...base,
      message: createMessage(3, "long-enough", { media_group_id: "album" }),
    }),
    false,
  );
  assert.equal(
    TextGroups.queueTelegramTextGroupMessage({
      ...base,
      message: createMessage(4, "long-enough"),
    }),
    true,
  );
  assert.equal(
    TextGroups.queueTelegramTextGroupMessage({
      ...base,
      message: createMessage(30, "tail"),
    }),
    false,
  );
});

test("Text group helper scopes split recovery by thread target", () => {
  const groups = new Map<
    string,
    TextGroups.TelegramTextGroupState<TestMessage, string>
  >();
  const timers: Array<() => void> = [];
  const dispatched: string[] = [];
  const queue = (message: TestMessage) =>
    TextGroups.queueTelegramTextGroupMessage({
      message,
      context: "ctx",
      groups,
      debounceMs: 10,
      minSplitLength: 8,
      setTimer: (callback) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      dispatchMessages: (messages, ctx) => {
        dispatched.push(
          `${ctx}:${messages.map((item) => item.text).join("|")}`,
        );
      },
    });

  assert.equal(
    queue(createMessage(1, "long-enough", { message_thread_id: 10 })),
    true,
  );
  assert.equal(
    queue(createMessage(2, "other-thread", { message_thread_id: 11 })),
    true,
  );
  assert.equal(
    queue(createMessage(3, "tail", { message_thread_id: 10 })),
    true,
  );
  assert.deepEqual(dispatched, []);
  timers.at(-1)?.();
  timers.at(-2)?.();
  assert.deepEqual(dispatched.sort(), [
    "ctx:long-enough|tail",
    "ctx:other-thread",
  ]);
});

test("Text group helper appends many split tails with wider id gaps", () => {
  const groups = new Map<
    string,
    TextGroups.TelegramTextGroupState<TestMessage, string>
  >();
  const timers: Array<() => void> = [];
  const dispatched: string[] = [];
  const queue = (message: TestMessage) =>
    TextGroups.queueTelegramTextGroupMessage({
      message,
      context: "ctx",
      groups,
      debounceMs: 10,
      minSplitLength: 8,
      setTimer: (callback) => {
        timers.push(callback);
        return callback as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      dispatchMessages: (messages, ctx) => {
        dispatched.push(
          `${ctx}:${messages.map((item) => item.text).join("|")}`,
        );
      },
    });

  assert.equal(queue(createMessage(1, "long-enough")), true);
  assert.equal(queue(createMessage(8, "tail-1")), true);
  assert.equal(queue(createMessage(18, "tail-2")), true);
  assert.equal(queue(createMessage(28, "tail-3")), true);
  assert.deepEqual(dispatched, []);
  timers.at(-1)?.();
  assert.deepEqual(dispatched, ["ctx:long-enough|tail-1|tail-2|tail-3"]);
});
