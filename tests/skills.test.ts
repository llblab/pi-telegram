/**
 * Bundled Telegram skill discovery regressions
 * Covers source/runtime path contribution and package publication metadata
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  getTelegramExtensionPackageRoot,
  isRawTelegramExtensionCheckout,
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

test("Local Bot API reference documents generation-stop controls on both draft methods", async () => {
  const reference = (await readFile(
    join(dirname(TELEGRAM_SKILLS_PATH), ".agents", "skills", "telegram-bot", "api.md"),
    "utf8",
  )).replace(/\r\n/g, "\n");
  const section = (name: string): string => {
    const start = reference.indexOf(`#### ${name}\n`);
    assert.ok(start >= 0, name);
    const end = reference.indexOf("\n#### ", start + 1);
    return reference.slice(start, end < 0 ? undefined : end);
  };
  const plain = section("sendMessageDraft");
  const rich = section("sendRichMessageDraft");
  for (const field of ["can\\_stop", "keep\\_on\\_stop"]) {
    const row = plain.split("\n").find((line) => line.startsWith(`| ${field} |`));
    assert.ok(row, `Missing plain-draft field: ${field}`);
    assert.ok(rich.split("\n").includes(row), `Missing or inconsistent rich-draft field: ${field}`);
  }
  assert.match(section("MessageGenerationStopped"), /draft\\_id/u);
});

test("Auto-discovered checkout contributes focused source Skills", async () => {
  const packageRoot = dirname(TELEGRAM_SKILLS_PATH);
  const sourceModule = join(packageRoot, "lib", "skills.ts");
  const compiledModule = join(packageRoot, "dist", "lib", "skills.js");
  const checkoutOptions = {
    agentDir: dirname(dirname(packageRoot)),
    cwd: join(packageRoot, "unrelated-cwd"),
  };
  let resourceHook: (() => { skillPaths: string[] }) | undefined;
  assert.equal(isRawTelegramExtensionCheckout(sourceModule, checkoutOptions), true);
  assert.equal(isRawTelegramExtensionCheckout(compiledModule, checkoutOptions), true);
  assert.equal(getTelegramExtensionPackageRoot(compiledModule), packageRoot);
  assert.equal(registerTelegramSkillDiscovery({
    on(name: string, hook: unknown) {
      assert.equal(name, "resources_discover");
      resourceHook = hook as () => { skillPaths: string[] };
    },
  } as never, compiledModule, checkoutOptions), true);

  assert.deepEqual(resourceHook?.(), { skillPaths: [TELEGRAM_SKILLS_PATH] });
  const skillNames = [
    "telegram-bridge",
    "show-me",
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
  assert.match(bridge, /\{\|Next\|\|1\}/u);
  assert.match(bridge, /Hidden comment for footer; `telegram_button` fence for in-body rows/u);
  assert.match(bridge, /singleton JSON\/CML cell or mixed matrix/u);
  assert.doesNotMatch(bridge, /only recognized top-level comments activate|one complete action in one comment/u);
  assert.match(bridge, /Disabled controls.*no callback, queued prompt, or bound-method invocation/u);
  assert.match(
    bridge,
    /removes every assistant-authored HTML comment.*only recognized top-level wrappers activate actions/su,
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

  const showMe = sources.get("show-me") ?? "";
  assert.ok(
    showMe.trim().split(/\s+/u).length <= 1_100,
    "show-me core exceeded its progressive-disclosure budget",
  );
  assert.match(showMe, /references\/telegram-surfaces\.md/u);
  assert.match(showMe, /retained diff, status, and validation evidence/u);
  assert.match(showMe, /Do not infer that an affordance is clickable/u);
  assert.match(showMe, /State: locally implemented \| validated \| not released \| not live/u);
  const telegramSurfaces = await readSkillReference(
    "show-me",
    "telegram-surfaces.md",
  );
  assert.match(telegramSurfaces, /Design for a phone before a desktop/u);
  assert.match(telegramSurfaces, /rendered Markdown in the current reply/u);
  assert.match(telegramSurfaces, /single self-contained file/u);
  assert.match(telegramSurfaces, /source shape does not prove native clickability/u);
  assert.match(telegramSurfaces, /Do not expose local paths/u);

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
  assert.match(generatedSurface, /disabled control is not an action/u);
  assert.match(generatedSurface, /at least one useful enabled action/u);
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

test("Manifest-loaded package leaves filtered Skill discovery to Pi", () => {
  const packageRoot = dirname(TELEGRAM_SKILLS_PATH);
  const compiledModule = join(packageRoot, "dist", "lib", "skills.js");
  let registered = false;
  assert.equal(registerTelegramSkillDiscovery({
    on() {
      registered = true;
    },
  } as never, compiledModule, {
    agentDir: join(packageRoot, "managed-agent"),
    cwd: join(packageRoot, "managed-cwd"),
  }), false);
  assert.equal(registered, false);
});

test("Pi resolver preserves checkout Skills and package filters with package provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-resolver-"));
  try {
    const packageManagerModule = await import(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js"
    );
    const settingsModule = await import(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js"
    );
    const cwd = join(root, "cwd");
    const agentDir = join(root, "agent");
    const checkoutRoot = join(agentDir, "extensions", "pi-telegram");
    const checkoutEntry = join(checkoutRoot, "dist", "pi-telegram", "index.js");
    const checkoutSkill = join(checkoutRoot, "skills", "telegram-bridge", "SKILL.md");
    await mkdir(dirname(checkoutEntry), { recursive: true });
    await mkdir(dirname(checkoutSkill), { recursive: true });
    await mkdir(join(checkoutRoot, "dist", "skills", "telegram-bridge"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(checkoutRoot, "package.json"), JSON.stringify({
      name: "@llblab/pi-telegram-checkout-fixture",
      pi: {
        extensions: ["./dist/pi-telegram/index.js"],
        skills: ["./dist/skills"],
      },
    }));
    await writeFile(checkoutEntry, "export default function () {}\n");
    await writeFile(checkoutSkill, "---\nname: telegram-bridge\ndescription: source fixture\n---\n");
    await writeFile(
      join(checkoutRoot, "dist", "skills", "telegram-bridge", "SKILL.md"),
      "---\nname: telegram-bridge\ndescription: dist fixture\n---\n",
    );
    const checkoutResolved = await new packageManagerModule.DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settingsModule.SettingsManager.inMemory(),
    }).resolve();
    assert.equal(checkoutResolved.extensions.some(
      (entry: { path: string }) => entry.path === checkoutEntry,
    ), true);
    assert.equal(checkoutResolved.skills.some(
      (entry: { path: string }) => entry.path.startsWith(checkoutRoot),
    ), false);
    assert.equal(isRawTelegramExtensionCheckout(
      join(checkoutRoot, "dist", "lib", "skills.js"),
      { agentDir, cwd },
    ), true);

    const managedRoot = join(root, "managed", "pi-telegram");
    const managedEntry = join(managedRoot, "dist", "pi-telegram", "index.js");
    const managedSkill = join(managedRoot, "dist", "skills", "telegram-bridge", "SKILL.md");
    await mkdir(dirname(managedEntry), { recursive: true });
    await mkdir(dirname(managedSkill), { recursive: true });
    await writeFile(join(managedRoot, "package.json"), JSON.stringify({
      name: "@llblab/pi-telegram-managed-fixture",
      pi: {
        extensions: ["./dist/pi-telegram/index.js"],
        skills: ["./dist/skills"],
      },
    }));
    await writeFile(managedEntry, "export default function () {}\n");
    await writeFile(managedSkill, "---\nname: telegram-bridge\ndescription: managed fixture\n---\n");
    const managedAgentDir = join(root, "managed-agent");
    const managedResolved = await new packageManagerModule.DefaultPackageManager({
      cwd,
      agentDir: managedAgentDir,
      settingsManager: settingsModule.SettingsManager.inMemory({
        packages: [{ source: managedRoot, skills: [] }],
      }),
    }).resolve();
    const filteredSkill = managedResolved.skills.find(
      (entry: { path: string }) => entry.path === managedSkill,
    );
    assert.ok(filteredSkill);
    assert.equal(filteredSkill.enabled, false);
    assert.equal(filteredSkill.metadata.origin, "package");
    assert.equal(isRawTelegramExtensionCheckout(
      join(managedRoot, "dist", "lib", "skills.js"),
      { agentDir: managedAgentDir, cwd },
    ), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Package metadata publishes only Pi-supported compiled resources", async () => {
  const packageRoot = dirname(TELEGRAM_SKILLS_PATH);
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as {
    files?: string[];
    pi?: { extensions?: string[]; skills?: string[]; sourceExtensions?: string[]; sourceSkills?: string[] };
  };

  assert.ok(manifest.files?.includes("skills/"));
  assert.ok(manifest.files?.includes("dist/"));
  assert.deepEqual(manifest.pi?.extensions, ["./dist/pi-telegram/index.js"]);
  assert.deepEqual(manifest.pi?.skills, ["./dist/skills"]);
  assert.equal("sourceExtensions" in (manifest.pi ?? {}), false);
  assert.equal("sourceSkills" in (manifest.pi ?? {}), false);
});
