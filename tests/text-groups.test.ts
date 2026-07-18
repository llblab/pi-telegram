/**
 * Regression tests for Telegram text-group coalescing
 * Exercises conservative recovery of automatically split long Telegram messages
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractTelegramMessageText } from "../lib/media.ts";
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

test("Text group controller coalesces same-batch forward comments and bounds ordinary text delay", async () => {
  const timers: Array<{
    active: boolean;
    callback: () => void;
    delay: number;
  }> = [];
  const dispatched: string[] = [];
  const controller = TextGroups.createTelegramTextGroupController<
    TestMessage,
    string
  >({
    debounceMs: 1000,
    setTimer: (callback, delay) => {
      const timer = { active: true, callback, delay };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { active: boolean }).active = false;
    },
  });
  const comment = createMessage(10, "Посмотри на это");
  const forwarded = createMessage(11, "Пересланный текст", {
    forward_origin: { type: "user" },
  });
  controller.prepareUpdateBatch([
    { message: comment },
    { message: forwarded },
  ]);
  const dispatchMessages = (messages: TestMessage[]) => {
    dispatched.push(messages.map((message) => message.text).join("|"));
  };
  assert.equal(
    controller.queueMessage({
      message: comment,
      context: "ctx",
      dispatchMessages,
    }),
    true,
  );
  assert.equal(timers[0]?.delay, 1000);
  assert.equal(
    controller.queueMessage({
      message: forwarded,
      context: "ctx",
      dispatchMessages,
    }),
    true,
  );
  assert.equal(timers[0]?.active, false);
  assert.equal(timers[1]?.delay, 0);
  timers[1]?.callback();
  await Promise.resolve();
  assert.deepEqual(dispatched, ["Посмотри на это|Пересланный текст"]);

  assert.equal(
    controller.queueMessage({
      message: createMessage(20, "Обычный короткий текст"),
      context: "ctx",
      dispatchMessages,
    }),
    true,
  );
  assert.equal(timers.at(-1)?.delay, 1000);
});

test("Text group controller coalesces a cross-batch comment with a rich forwarded message", async () => {
  const timers: Array<{
    active: boolean;
    callback: () => void;
    delay: number;
  }> = [];
  const dispatched: string[] = [];
  const controller = TextGroups.createTelegramTextGroupController<
    TestMessage,
    string
  >({
    debounceMs: 1000,
    setTimer: (callback, delay) => {
      const timer = { active: true, callback, delay };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { active: boolean }).active = false;
    },
  });
  const dispatchMessages = (messages: TestMessage[]) => {
    dispatched.push(
      messages.map((message) => extractTelegramMessageText(message)).join("|"),
    );
  };
  const comment = createMessage(30, "Комментарий");
  const forwarded = createMessage(31, "", {
    text: undefined,
    rich_message: {
      blocks: [{ type: "paragraph", text: "Rich forward" }],
    },
    forward_origin: { type: "user" },
  });
  assert.equal(
    controller.queueMessage({ message: comment, context: "ctx", dispatchMessages }),
    true,
  );
  assert.equal(timers[0]?.delay, 1000);
  assert.equal(
    controller.queueMessage({ message: forwarded, context: "ctx", dispatchMessages }),
    true,
  );
  assert.equal(timers[0]?.active, false);
  assert.equal(timers[1]?.delay, 0);
  timers[1]?.callback();
  await Promise.resolve();
  assert.deepEqual(dispatched, ["Комментарий|Rich forward"]);
});

test("Text group controller coalesces media-only forwards and comments in either order", async () => {
  const runPair = async (
    messages: TestMessage[],
    flushRemainder = false,
  ): Promise<number[][]> => {
    const timers: Array<{
      active: boolean;
      callback: () => void;
      delay: number;
    }> = [];
    const dispatched: number[][] = [];
    const controller = TextGroups.createTelegramTextGroupController<
      TestMessage,
      string
    >({
      debounceMs: 1000,
      setTimer: (callback, delay) => {
        const timer = { active: true, callback, delay };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => {
        (timer as unknown as { active: boolean }).active = false;
      },
    });
    for (const message of messages) {
      assert.equal(
        controller.queueMessage({
          message,
          context: "ctx",
          dispatchMessages: (group) => {
            dispatched.push(group.map((item) => item.message_id));
          },
        }),
        true,
      );
    }
    assert.equal(timers[0]?.delay, 1000);
    assert.equal(timers[0]?.active, false);
    assert.equal(timers[1]?.delay, 0);
    timers[1]?.callback();
    await Promise.resolve();
    if (flushRemainder) {
      assert.equal(timers[2]?.delay, 1000);
      timers[2]?.callback();
      await Promise.resolve();
    }
    return dispatched;
  };
  const mediaForward = (messageId: number): TestMessage =>
    createMessage(messageId, "", {
      text: undefined,
      forward_origin: { type: "user" },
    });

  assert.deepEqual(
    await runPair([
      createMessage(40, "Комментарий"),
      mediaForward(41),
    ]),
    [[40, 41]],
  );
  assert.deepEqual(
    await runPair([
      mediaForward(50),
      createMessage(51, "Комментарий"),
    ]),
    [[50, 51]],
  );
  assert.deepEqual(
    await runPair([mediaForward(60), mediaForward(61)], true),
    [[60], [61]],
  );
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
