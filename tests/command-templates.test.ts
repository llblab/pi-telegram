/**
 * Command-template regression tests
 * Covers shell-free splitting, executable expansion, defaults, inline placeholder resolution, and composition expansion
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommandTemplateInvocation,
  execCommandTemplate,
  expandCommandTemplateConfigs,
  getCommandTemplateRiskLabels,
  getCommandTemplateWarnings,
  shouldRunCommandTemplateNode,
  splitCommandTemplate,
} from "../lib/command-templates.ts";

test("Command templates split shell-like words without invoking a shell", () => {
  assert.deepEqual(
    splitCommandTemplate("tool 'literal words' --name hello\\ world"),
    ["tool", "literal words", "--name", "hello world"],
  );
});

test("Command templates accept shorthand string configs", () => {
  const invocation = buildCommandTemplateInvocation(
    "./tts --text {text} --lang {lang=ru}",
    { text: "hello world" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/tts",
    args: ["--text", "hello world", "--lang", "ru"],
  });
});

test("Command template arrays inherit only top-level args and defaults", () => {
  const steps = expandCommandTemplateConfigs({
    template: [
      "tts --text {text} --lang {lang} --out {mp3}",
      {
        template: "ffmpeg -i {mp3} {ogg} {codec}",
        defaults: { codec: "opus" },
        timeout: 123,
      },
    ],
    args: ["text", "lang", "mp3", "ogg"],
    defaults: { lang: "en" },
    output: "ogg",
    timeout: 999,
  });
  assert.deepEqual(steps, [
    {
      template: "tts --text {text} --lang {lang} --out {mp3}",
      args: ["text", "lang", "mp3", "ogg"],
      defaults: { lang: "en" },
      retry: undefined,
    },
    {
      template: "ffmpeg -i {mp3} {ogg} {codec}",
      args: ["text", "lang", "mp3", "ogg"],
      defaults: { lang: "en", codec: "opus" },
      timeout: 123,
      retry: undefined,
    },
  ]);
});

test("Template composition expansion preserves retry and failure scope on step objects", () => {
  const steps = expandCommandTemplateConfigs({
    template: [
      "scan --path {dir}",
      {
        template: "lint --strict {dir}",
        retry: 3,
        failure: "root",
      },
      {
        template: "deploy {dir}",
        failure: "root",
        timeout: 60000,
      },
    ],
    args: ["dir"],
    defaults: { dir: "./src" },
  });
  assert.deepEqual(steps, [
    {
      template: "scan --path {dir}",
      args: ["dir"],
      defaults: { dir: "./src" },
      retry: undefined,
    },
    {
      template: "lint --strict {dir}",
      args: ["dir"],
      defaults: { dir: "./src" },
      retry: 3,
      failure: "root",
    },
    {
      template: "deploy {dir}",
      args: ["dir"],
      defaults: { dir: "./src" },
      failure: "root",
      timeout: 60000,
      retry: undefined,
    },
  ]);
});

test("Command template repeat expands numbered defaults", () => {
  const steps = expandCommandTemplateConfigs({
    repeat: 3,
    template:
      "render page{_(index+1)}.html prev=page{_(prev+1)}.html next=page{_(next+1)}.html raw={index}/{repeat}",
  });
  assert.equal(steps.length, 3);
  assert.deepEqual(
    {
      index: steps[0].defaults?.index,
      next: steps[0].defaults?.next,
      prev: steps[0].defaults?.prev,
      repeat: steps[0].defaults?.repeat,
      _index: steps[0].defaults?._index,
      __index: steps[0].defaults?.__index,
      _prev: steps[0].defaults?._prev,
      _next: steps[0].defaults?._next,
    },
    {
      index: "0",
      next: "1",
      prev: "2",
      repeat: "3",
      _index: "00",
      __index: "000",
      _prev: "02",
      _next: "01",
    },
  );
  const invocation = buildCommandTemplateInvocation(steps[0], {}, "/work");
  assert.deepEqual(invocation.args, [
    "page01.html",
    "prev=page03.html",
    "next=page02.html",
    "raw=0/3",
  ]);
  assert.deepEqual(buildCommandTemplateInvocation(steps[2], {}, "/work").args, [
    "page03.html",
    "prev=page02.html",
    "next=page01.html",
    "raw=2/3",
  ]);
});

test("Command templates detect high-risk trusted executable shapes", () => {
  const config = {
    template: [
      "bash -c {script}",
      "node -e {code}",
      "rm -rf {work_dir}",
      "npm publish",
    ],
  };
  const warnings = getCommandTemplateWarnings(config);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /bash/);
  assert.match(warnings[1], /eval/);
  assert.match(warnings[2], /removes filesystem paths/);
  assert.deepEqual(getCommandTemplateRiskLabels(config), [
    "risk.shell",
    "risk.eval",
    "risk.destructive_fs",
    "risk.external_side_effect",
    "risk.network",
  ]);
});

test("Command templates resolve typed inline placeholders", () => {
  const invocation = buildCommandTemplateInvocation(
    "tool {file:path} {timeout:int=60000} {speed:number=1.5} {mode:enum(check,fix)=check}",
    { file: "/tmp/a.txt" },
    "/work",
  );
  assert.deepEqual(invocation.args, ["/tmp/a.txt", "60000", "1.5", "check"]);
});

test("Command templates resolve defaults and inline placeholder defaults", () => {
  const invocation = buildCommandTemplateInvocation(
    {
      template: "./tts --text {text} --lang {lang=ru} --rate {rate}",
      defaults: { rate: "+30%" },
    },
    { text: "hello world" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/tts",
    args: ["--text", "hello world", "--lang", "ru", "--rate", "+30%"],
  });
});

test("Command templates resolve modern placeholder operators and filter empty args", () => {
  assert.deepEqual(
    buildCommandTemplateInvocation(
      "tool --model {model??auto} {enabled?--enabled:} {missing?--missing:}",
      { enabled: true },
      "/work",
    ),
    { command: "tool", args: ["--model", "auto", "--enabled"] },
  );
});

test("Command templates resolve inherited default references and when guards", () => {
  const steps = expandCommandTemplateConfigs({
    defaults: { base: "parent" },
    template: [{ template: "echo {child}", defaults: { child: "{base}" } }],
  });
  assert.deepEqual(steps[0]?.defaults, { base: "parent", child: "parent" });
  assert.equal(
    shouldRunCommandTemplateNode("enabled", { enabled: "yes" }),
    true,
  );
  assert.equal(
    shouldRunCommandTemplateNode("!enabled", { enabled: "no" }),
    true,
  );
  assert.equal(
    shouldRunCommandTemplateNode("{enabled?yes:}", { enabled: false }),
    false,
  );
});

test("Command template arrays preserve modern control fields", () => {
  const steps = expandCommandTemplateConfigs({
    parallel: true,
    when: "enabled",
    timeout: "{timeout}",
    delay: "{delay}",
    retry: "{retry}",
    template: "run",
  });
  assert.deepEqual(steps, [
    {
      parallel: true,
      when: "enabled",
      timeout: "{timeout}",
      delay: "{delay}",
      retry: "{retry}",
      template: "run",
    },
  ]);
});

test("Command templates resolve array-index placeholders and recursive defaults", () => {
  const invocation = buildCommandTemplateInvocation(
    {
      defaults: { prompt: "{prompts[index]}" },
      template: "subagent {prompt}",
    },
    { index: "1", prompts: ["left", "right"] },
    "/work",
  );
  assert.deepEqual(invocation.args, ["right"]);
});

test("Command template execution writes stdin without invoking a shell", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    [
      "-e",
      "process.stdin.on('data', data => process.stdout.write(String(data).toUpperCase()))",
    ],
    { stdin: "hello" },
  );
  assert.deepEqual(result, {
    stdout: "HELLO",
    stderr: "",
    code: 0,
    killed: false,
  });
});

test("Command template timeout escalates when SIGTERM is ignored", async () => {
  const startedAt = Date.now();
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { timeout: 500, killGrace: 10 },
  );
  assert.equal(result.killed, true);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - startedAt < 2000);
});

test("Command template retry succeeds on second attempt", async () => {
  const counterFile = `/tmp/ct-retry-${process.pid}.txt`;
  const { writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(counterFile, "0");
  const script = `
    const fs = require("fs");
    const p = "${counterFile}";
    let n = parseInt(fs.readFileSync(p, "utf8"));
    n++;
    fs.writeFileSync(p, String(n));
    if (n < 2) process.exit(1);
  `;
  const result = await execCommandTemplate(process.execPath, ["-e", script], {
    retry: 2,
    killGrace: 10,
  });
  assert.equal(result.code, 0);
  assert.equal(readFileSync(counterFile, "utf8").trim(), "2");
  unlinkSync(counterFile);
});

test("Command template retry exhausts attempts and surfaces last failure", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "process.exit(3)"],
    { retry: 3, killGrace: 10 },
  );
  assert.notEqual(result.code, 0);
  assert.equal(result.killed, false);
});

test("Command template retry default is 1 (no retry)", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "process.exit(1)"],
    { killGrace: 10 },
  );
  assert.notEqual(result.code, 0);
});

test("Command templates leave timeout disabled by default", async () => {
  const result = await execCommandTemplate(
    process.execPath,
    ["-e", "setTimeout(() => {}, 100);"],
    { killGrace: 10 },
  );
  assert.equal(result.killed, false);
  assert.equal(result.code, 0);
});

test("Command templates report missing required placeholders", () => {
  assert.throws(
    () => buildCommandTemplateInvocation("tool {missing}", {}, "/work"),
    /Missing command template value: missing/,
  );
});
