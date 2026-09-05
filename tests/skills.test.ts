/**
 * Bundled Telegram skill discovery regressions
 * Covers source/runtime path contribution and package publication metadata
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  registerTelegramSkillDiscovery,
  TELEGRAM_SKILLS_PATH,
} from "../lib/skills.ts";

async function readSkillReference(
  skill: string,
  reference: string,
): Promise<string> {
  return readFile(
    join(TELEGRAM_SKILLS_PATH, skill, "references", reference),
    "utf8",
  );
}

test("Telegram extension contributes focused bundled skills", async () => {
  let resourceHook: (() => { skillPaths: string[] }) | undefined;
  registerTelegramSkillDiscovery({
    on(name: string, hook: unknown) {
      assert.equal(name, "resources_discover");
      resourceHook = hook as () => { skillPaths: string[] };
    },
  } as never);

  assert.deepEqual(resourceHook?.(), { skillPaths: [TELEGRAM_SKILLS_PATH] });
  const skillNames = [
    "telegram-bridge",
    "generated-control-surface",
    "generative-apps",
  ];
  const sources = new Map<string, string>();
  for (const name of skillNames) {
    const source = await readFile(
      join(TELEGRAM_SKILLS_PATH, name, "SKILL.md"),
      "utf8",
    );
    sources.set(name, source);
    assert.match(source, new RegExp(`^name: ${name}$`, "m"));
    assert.match(source, /^description: .+$/m);
  }

  const bridge = sources.get("telegram-bridge") ?? "";
  assert.ok(
    bridge.trim().split(/\s+/u).length <= 1_100,
    "telegram-bridge core exceeded its progressive-disclosure budget",
  );
  assert.match(bridge, /capability, not user intent/u);
  assert.match(bridge, /Never call `telegram_message` for the current active target/u);
  assert.match(bridge, /Positional CML — default/u);
  assert.match(bridge, /JSON — only when multiline content, named fields, or escaping earns it/u);
  assert.match(bridge, /\{text\|lang\|rate\}/u);
  assert.match(bridge, /voice does not use matrix composition/u);
  assert.match(bridge, /emoji \+ space \+ text/u);
  assert.match(bridge, /\{\|prompt\}.*prompt as both visible text and queued prompt/u);
  assert.match(bridge, /click creates an ordinary user request/u);
  assert.match(
    bridge,
    /removes every assistant-authored HTML comment.*only recognized top-level comments activate actions/su,
  );
  assert.match(
    bridge,
    /Proactively use `generated-control-surface`.*must emit useful buttons/su,
  );
  assert.match(bridge, /dangerous button opens a consequence\/confirmation step/u);
  assert.match(bridge, /Serialize|serialization/u);
  assert.doesNotMatch(bridge, /telegram_buttons/u);
  assert.doesNotMatch(bridge, /telegram_button label=/u);
  assert.ok(bridge.indexOf("<!-- telegram_button [") < bridge.indexOf("<!-- telegram_button {\""));

  for (const reference of [
    "delivery-and-threads.md",
    "configuration.md",
    "diagnosis.md",
  ]) {
    assert.match(bridge, new RegExp(reference.replace(".", "\\."), "u"));
    assert.ok((await readSkillReference("telegram-bridge", reference)).length > 200);
  }

  const generatedSurface = sources.get("generated-control-surface") ?? "";
  assert.ok(
    generatedSurface.trim().split(/\s+/u).length <= 1_100,
    "generated-control-surface core exceeded its progressive-disclosure budget",
  );
  assert.match(generatedSurface, /Proactively use controls/u);
  assert.match(generatedSurface, /every response.*must include at least one useful button/su);
  assert.match(generatedSurface, /2–6 safe concrete actions/u);
  assert.doesNotMatch(generatedSurface, /may produce zero buttons/u);
  assert.match(generatedSurface, /ordered ragged sequence/u);
  assert.match(generatedSurface, /emoji \+ space \+ text/u);
  assert.match(generatedSurface, /emoji-free text labels are invalid/u);
  assert.match(generatedSurface, /one full-width row/u);
  assert.match(generatedSurface, /two columns only/u);
  assert.match(generatedSurface, /three through eight columns/u);
  assert.match(generatedSurface, /active transport contract/u);
  assert.match(generatedSurface, /does not own.*transport syntax/su);
  assert.match(generatedSurface, /High-impact actions use two stages/u);
  assert.match(generatedSurface, /follow `generative-apps`/u);
  assert.doesNotMatch(generatedSurface, /telegram_button/u);
  assert.doesNotMatch(generatedSurface, /Compact Matrix Literal/u);

  const layoutReference = await readSkillReference(
    "generated-control-surface",
    "layout-and-state.md",
  );
  assert.match(layoutReference, /Never exceed eight columns/u);
  assert.match(layoutReference, /Rectangular grids require genuine spatial/u);
  assert.match(layoutReference, /repeated clicks against current state/u);
  assert.match(layoutReference, /Preserve tap-ahead/u);

  const adapterReference = await readSkillReference(
    "generated-control-surface",
    "capability-adapters.md",
  );
  assert.match(adapterReference, /visible directories, hidden directories/u);
  assert.match(adapterReference, /stable 10-entry page/u);
  assert.match(adapterReference, /Actor Runs/u);
  assert.match(adapterReference, /Never preview credential stores/u);

  const generativeApps = sources.get("generative-apps") ?? "";
  assert.match(generativeApps, /complement `generated-control-surface`/u);
  assert.match(generativeApps, /Standalone deterministic application/u);
  assert.match(generativeApps, /View\/controller adapter/u);
  assert.match(generativeApps, /bound method.*ordinary prompt/su);
  assert.match(generativeApps, /Compile only the stable transitions/su);
  assert.match(generativeApps, /transport-independent concept/u);
  assert.match(generativeApps, /replace: true/u);
  assert.match(generativeApps, /generic remote terminals/u);
  assert.doesNotMatch(generativeApps, /states\.jsonl|worker-isolated|transition lock/u);

  const generativeAppsDoc = await readFile(
    join(dirname(TELEGRAM_SKILLS_PATH), "docs", "generative-apps.md"),
    "utf8",
  );
  assert.match(
    generativeAppsDoc,
    /concrete Generative App runtime implemented by `pi-telegram`/u,
  );
  assert.match(generativeAppsDoc, /states\.jsonl/u);
  assert.match(generativeAppsDoc, /worker-isolated/u);
});

test("Generated filesystem reference preserves bounded structural navigation", async () => {
  const source = await readSkillReference(
    "generated-control-surface",
    "capability-adapters.md",
  );
  const lfSource = source.replaceAll("\r\n", "\n");
  for (const candidate of [lfSource, lfSource.replaceAll("\n", "\r\n")]) {
    const normalized = candidate.replaceAll("\r\n", "\n");
    const section =
      normalized.match(/## Filesystem\n([\s\S]*?)(?=\n## )/u)?.[1] ?? "";
    const rules = section.match(/^\d+\. .+$/gmu) ?? [];
    assert.equal(rules.length, 5);
    assert.match(rules[0] ?? "", /⬆️ Up.*root/u);
    assert.match(rules[1] ?? "", /⬅️ Previous.*➡️ Next/u);
    assert.match(
      rules[2] ?? "",
      /visible directories, hidden directories, visible files, then hidden files/u,
    );
    assert.match(rules[3] ?? "", /at most 10 entries/u);
    assert.match(rules[4] ?? "", /Path and Entries.*Refresh/u);
    assert.match(section, /numbered fallback/u);
  }
});

test("Bridge diagnosis distinguishes Pi commands from the agent file fallback", async () => {
  const diagnosis = await readSkillReference("telegram-bridge", "diagnosis.md");
  assert.match(diagnosis, /`\/telegram-status`/u);
  assert.match(diagnosis, /`\/telegram-status --debug`/u);
  assert.match(diagnosis, /not shell executables or agent tools/u);
  assert.match(diagnosis, /read the diagnostic files directly/u);
  assert.match(diagnosis, /state\.json.*logs\.jsonl/u);
});

test("Package metadata publishes the bundled skill root", async () => {
  const packageRoot = dirname(TELEGRAM_SKILLS_PATH);
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[]; pi?: { skills?: string[] } };

  assert.ok(manifest.files?.includes("skills/"));
  assert.deepEqual(manifest.pi?.skills, ["./skills"]);
});
