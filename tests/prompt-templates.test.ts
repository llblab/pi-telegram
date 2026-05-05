/**
 * Regression tests for Telegram prompt-template bridge helpers
 * Covers π prompt-template discovery filtering and command expansion
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramPromptTemplateCommandGetter,
  expandTelegramPromptTemplateCommand,
  getTelegramPromptTemplateCommands,
  mapPiPromptTemplateNameToTelegramCommandName,
  parsePromptTemplateArgs,
  substitutePromptTemplateArgs,
} from "../lib/prompt-templates.ts";
import { TELEGRAM_RESERVED_COMMAND_NAMES } from "../lib/commands.ts";
import type { PiSlashCommandInfo } from "../lib/pi.ts";

function createCommand(
  name: string,
  source: PiSlashCommandInfo["source"],
  description?: string,
): PiSlashCommandInfo {
  return {
    name,
    description,
    source,
    sourceInfo: {
      path: `/prompts/${name}.md`,
      source: "local",
      scope: "project",
      origin: "top-level",
    },
  };
}

test("Prompt-template helpers expose valid Telegram command templates", () => {
  const commands = getTelegramPromptTemplateCommands(
    [
      createCommand("review", "prompt", "Review changes"),
      createCommand("fix-tests", "prompt", "Fix failing tests"),
      createCommand("status", "prompt", "Reserved hidden command"),
      createCommand("start", "prompt", "Reserved visible command"),
      createCommand("skill", "skill", "Not a prompt"),
      createCommand("review", "prompt", "Duplicate"),
    ],
    new Set(TELEGRAM_RESERVED_COMMAND_NAMES),
  );
  assert.deepEqual(commands, [
    {
      command: "fix_tests",
      description: "Fix failing tests",
      path: "/prompts/fix-tests.md",
    },
    {
      command: "review",
      description: "Review changes",
      path: "/prompts/review.md",
    },
  ]);
});

test("Prompt-template helpers map pi template names to Telegram commands", () => {
  assert.equal(
    mapPiPromptTemplateNameToTelegramCommandName("fix-tests"),
    "fix_tests",
  );
  assert.equal(
    mapPiPromptTemplateNameToTelegramCommandName("Review PR"),
    "review_pr",
  );
  assert.equal(mapPiPromptTemplateNameToTelegramCommandName("---"), undefined);
});

test("Prompt-template command getter hides extension command conflicts", () => {
  const getCommands = () => [
    createCommand("review", "prompt", "Review changes"),
    createCommand("start", "prompt", "Conflicts with built-in"),
    createCommand("status", "prompt", "Conflicts with hidden shortcut"),
  ];
  const getPromptTemplateCommands = createTelegramPromptTemplateCommandGetter({
    getCommands,
    reservedCommandNames: TELEGRAM_RESERVED_COMMAND_NAMES,
  });
  assert.deepEqual(getPromptTemplateCommands().map((command) => command.command), [
    "review",
  ]);
});

test("Prompt-template helpers parse and substitute arguments like pi templates", () => {
  const args = parsePromptTemplateArgs("one 'two words' \"three words\"");
  assert.deepEqual(args, ["one", "two words", "three words"]);
  assert.equal(
    substitutePromptTemplateArgs("$1 | $2 | $@ | $ARGUMENTS | ${@:2} | ${@:2:1}", args),
    "one | two words | one two words three words | one two words three words | two words three words | two words",
  );
});

test("Prompt-template helpers expand command content from template files", () => {
  const expanded = expandTelegramPromptTemplateCommand(
    "review",
    "staged changes",
    [{ command: "review", description: "Review", path: "/prompts/review.md" }],
    () => "---\ndescription: Review\n---\nReview $@",
  );
  assert.equal(expanded, "Review staged changes");
  assert.equal(
    expandTelegramPromptTemplateCommand("missing", "", [], () => "unused"),
    undefined,
  );
});
