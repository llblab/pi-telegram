/**
 * Command-template execution standard.
 * Zones: shell-free command parsing, placeholder expansion, local process execution, composition semantics
 * Owns portable command-template parsing, expansion, risk checks, retries, timeouts, and direct execution.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type CommandTemplateFailureScope = "continue" | "branch" | "root";

export interface CommandTemplateActorRecipeContext {
  alias?: string;
  file?: string;
  name?: string;
  path?: string;
  role?: string;
}

export interface CommandTemplateObjectConfig {
  actorRecipeContext?: CommandTemplateActorRecipeContext;
  label?: string;
  parallel?: boolean;
  when?: boolean | string;
  template?: CommandTemplateValue;
  args?: string[];
  defaults?: Record<string, unknown>;
  timeout?: number | string;
  delay?: number | string;
  output?: string;
  retry?: number | string;
  failure?: CommandTemplateFailureScope;
  recover?: CommandTemplateValue;
  repeat?: number | string;
}

export type CommandTemplateValue =
  string | CommandTemplateConfig[] | CommandTemplateObjectConfig;

export type CommandTemplateConfig = string | CommandTemplateObjectConfig;

export interface CommandTemplateLeafConfig extends CommandTemplateObjectConfig {
  template: string;
}

export interface CommandTemplateInvocation {
  command: string;
  args: string[];
}

export interface CommandTemplateExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  killGrace?: number;
  retry?: number;
}

export interface CommandTemplateExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type CommandTemplateRiskLabel =
  | "risk.shell"
  | "risk.eval"
  | "risk.broad_fs_write"
  | "risk.destructive_fs"
  | "risk.network"
  | "risk.external_side_effect"
  | "risk.long_running"
  | "risk.platform_specific"
  | "risk.secret_touching";

const COMMAND_TEMPLATE_RISK_LABEL_ORDER: CommandTemplateRiskLabel[] = [
  "risk.shell",
  "risk.eval",
  "risk.destructive_fs",
  "risk.broad_fs_write",
  "risk.external_side_effect",
  "risk.secret_touching",
  "risk.network",
  "risk.long_running",
  "risk.platform_specific",
];

function normalizeCommandTemplateArgs(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim());
}

export function normalizeCommandTemplateConfig(
  config: CommandTemplateConfig,
): CommandTemplateObjectConfig {
  return typeof config === "string" ? { template: config } : config;
}

function normalizeRecoverConfig(
  config: CommandTemplateValue | undefined,
): CommandTemplateConfig | undefined {
  if (config === undefined) return undefined;
  return Array.isArray(config) ? { template: config } : config;
}

function normalizeCommandTemplateDefaults(
  defaults: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!defaults) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    normalized[key] = Array.isArray(value)
      ? value
      : value === undefined || value === null
        ? ""
        : String(value);
  }
  return normalized;
}

export function resolveInheritedDefaultReferences(
  ownDefaults: Record<string, unknown> | undefined,
  inheritedDefaults: Record<string, unknown> | undefined,
  runtimeValues: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  if (!ownDefaults || !inheritedDefaults) return ownDefaults;
  const resolved = { ...ownDefaults };
  for (const [key, value] of Object.entries(ownDefaults)) {
    if (typeof value !== "string") continue;
    const exact = /^\{([A-Za-z_][A-Za-z0-9_-]*)\}$/.exec(value);
    if (
      !exact ||
      Object.hasOwn(runtimeValues, exact[1]) ||
      !Object.hasOwn(inheritedDefaults, exact[1])
    )
      continue;
    resolved[key] = inheritedDefaults[exact[1]];
  }
  return resolved;
}

export function resolveCommandTemplateRepeat(
  value: number | string | undefined,
  values: Record<string, unknown> = {},
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1)
      throw new Error("Command template repeat must be a positive integer.");
    return value;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const lengthMatch = trimmed.match(
    /^\{?([A-Za-z_][A-Za-z0-9_-]*)\.length\}?$/,
  );
  if (lengthMatch) {
    const source = values[lengthMatch[1]];
    if (Array.isArray(source)) return source.length;
    if (source === undefined) return undefined;
  }
  throw new Error(
    "Command template repeat must be a positive integer or {array.length}.",
  );
}

function getExecutableName(command: string | undefined): string {
  if (!command) return "";
  return command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function matchesFlag(arg: string, flag: string): boolean {
  if (arg === flag) return true;
  if (/^-[A-Za-z]$/.test(flag) && /^-[A-Za-z]+$/.test(arg))
    return arg.slice(1).includes(flag.slice(1));
  return false;
}

function hasAnyFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => matchesFlag(arg, flag)));
}

function hasRiskyPathArg(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "/" ||
      arg === "~" ||
      arg === "./" ||
      arg === "../" ||
      arg.includes("{") ||
      arg.startsWith("~/") ||
      arg.startsWith("/"),
  );
}

function sortRiskLabels(
  labels: Iterable<CommandTemplateRiskLabel>,
): CommandTemplateRiskLabel[] {
  const unique = new Set(labels);
  return COMMAND_TEMPLATE_RISK_LABEL_ORDER.filter((label) => unique.has(label));
}

function hasAnyArg(args: string[], values: string[]): boolean {
  return args.some((arg) => values.includes(arg.toLowerCase()));
}

function hasSecretTouchingText(parts: string[]): boolean {
  return parts.some((part) =>
    /(^|[{}._\-\s/])(?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|\.env|ssh[_-]?key)(?:[{}._\-\s/]|$)/i.test(
      part,
    ),
  );
}

function getLeafCommandTemplateRiskLabels(
  config: CommandTemplateLeafConfig,
): CommandTemplateRiskLabel[] {
  const parts = splitCommandTemplate(config.template);
  const command = getExecutableName(parts[0]);
  const args = parts.slice(1);
  const labels = new Set<CommandTemplateRiskLabel>();
  if (["bash", "sh", "zsh", "fish"].includes(command)) {
    labels.add("risk.shell");
    if (hasAnyFlag(args, ["-c"])) labels.add("risk.eval");
  }
  if (
    ["node", "deno", "bun"].includes(command) &&
    hasAnyFlag(args, ["-e", "--eval"])
  ) {
    labels.add("risk.eval");
  }
  if (
    ["python", "python3", "perl", "ruby"].includes(command) &&
    hasAnyFlag(args, ["-c", "-e"])
  ) {
    labels.add("risk.eval");
  }
  if (
    command === "rm" &&
    (args.some((arg) => /^-[^-]*r/.test(arg) || /^-[^-]*f/.test(arg)) ||
      hasRiskyPathArg(args))
  ) {
    labels.add("risk.destructive_fs");
  }
  if (["mv", "cp", "rsync"].includes(command) && hasRiskyPathArg(args)) {
    labels.add("risk.broad_fs_write");
  }
  if (
    [
      "curl",
      "wget",
      "ssh",
      "scp",
      "sftp",
      "rsync",
      "nc",
      "ncat",
      "telnet",
      "ftp",
    ].includes(command) ||
    (command === "git" &&
      hasAnyArg(args, ["clone", "fetch", "pull", "push", "ls-remote"])) ||
    ["npm", "pnpm", "yarn", "pip", "cargo"].includes(command)
  ) {
    labels.add("risk.network");
  }
  if (
    ["gh", "glab", "hub", "kubectl", "terraform"].includes(command) ||
    (command === "git" && hasAnyArg(args, ["push"])) ||
    (["npm", "pnpm", "yarn"].includes(command) &&
      hasAnyArg(args, ["publish", "login", "logout", "deprecate"]))
  ) {
    labels.add("risk.external_side_effect");
  }
  if (
    command === "sleep" ||
    command === "watch" ||
    (command === "tail" && hasAnyFlag(args, ["-f"])) ||
    hasAnyArg(args, ["--watch", "--serve", "serve"])
  ) {
    labels.add("risk.long_running");
  }
  if (
    [
      "systemctl",
      "launchctl",
      "osascript",
      "open",
      "xdg-open",
      "powershell",
      "pwsh",
      "cmd.exe",
      "apt",
      "apt-get",
      "dnf",
      "yum",
      "brew",
      "pacman",
      "apk",
      "xclip",
      "wl-copy",
    ].includes(command)
  ) {
    labels.add("risk.platform_specific");
  }
  if (
    ["pass", "gpg", "ssh-add"].includes(command) ||
    hasSecretTouchingText(parts)
  ) {
    labels.add("risk.secret_touching");
  }
  return sortRiskLabels(labels);
}

function getLeafCommandTemplateWarnings(
  config: CommandTemplateLeafConfig,
): string[] {
  const parts = splitCommandTemplate(config.template);
  const command = getExecutableName(parts[0]);
  const args = parts.slice(1);
  const warnings: string[] = [];
  if (["bash", "sh", "zsh", "fish"].includes(command)) {
    const shellContent = hasAnyFlag(args, ["-c"])
      ? "shell command strings"
      : "shell scripts";
    warnings.push(
      `${config.label ?? command}: invokes ${command}; ${shellContent} are trusted executable content and are not sandboxed by command-template argv splitting. Mitigation: keep scripts local, reviewed, and parameterized with explicit placeholders.`,
    );
  }
  if (
    ["node", "deno", "bun"].includes(command) &&
    hasAnyFlag(args, ["-e", "--eval"])
  ) {
    warnings.push(
      `${config.label ?? command}: invokes ${command} eval mode; code strings are trusted executable content and are not sandboxed. Mitigation: prefer a checked-in script file or keep eval input fixed and reviewed.`,
    );
  }
  if (
    ["python", "python3", "perl", "ruby"].includes(command) &&
    hasAnyFlag(args, ["-c", "-e"])
  ) {
    warnings.push(
      `${config.label ?? command}: invokes ${command} code-eval mode; code strings are trusted executable content and are not sandboxed. Mitigation: prefer a checked-in script file or keep eval input fixed and reviewed.`,
    );
  }
  if (
    command === "rm" &&
    (args.some((arg) => /^-[^-]*r/.test(arg) || /^-[^-]*f/.test(arg)) ||
      hasRiskyPathArg(args))
  ) {
    warnings.push(
      `${config.label ?? command}: removes filesystem paths; verify placeholders and paths before running trusted destructive commands. Mitigation: constrain path placeholders and consider dry-run or explicit confirmation.`,
    );
  }
  if (["mv", "cp", "rsync"].includes(command) && hasRiskyPathArg(args)) {
    warnings.push(
      `${config.label ?? command}: mutates broad filesystem paths; verify placeholders and paths before running trusted commands. Mitigation: constrain path placeholders and prefer narrow source/destination paths.`,
    );
  }
  return warnings;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function getCommandTemplateRepeatDefaults(
  index: number,
  repeat: number,
): Record<string, string> {
  const prev = (index - 1 + repeat) % repeat;
  const next = (index + 1) % repeat;
  const values: Record<string, string> = {
    index: String(index),
    next: String(next),
    prev: String(prev),
    repeat: String(repeat),
  };
  for (const name of ["index", "prev", "next", "repeat"]) {
    const numeric = Number(values[name]);
    for (let underscores = 1; underscores <= 6; underscores += 1) {
      values[`${"_".repeat(underscores)}${name}`] = pad(
        numeric,
        underscores + 1,
      );
    }
  }
  return values;
}

function expandRepeatConfig(
  config: CommandTemplateObjectConfig,
  context: Pick<CommandTemplateObjectConfig, "args" | "defaults">,
): CommandTemplateObjectConfig[] | undefined {
  const repeat = resolveCommandTemplateRepeat(
    config.repeat,
    context.defaults ?? {},
  );
  if (repeat === undefined) return undefined;
  return Array.from({ length: repeat }, (_unused, index0) => {
    const { repeat: _repeat, ...rest } = config;
    return {
      ...rest,
      defaults: {
        ...(context.defaults ?? {}),
        ...(rest.defaults ?? {}),
        ...getCommandTemplateRepeatDefaults(index0, repeat),
      },
    };
  });
}

export function expandCommandTemplateConfigs(
  config: CommandTemplateConfig,
  inherited: Pick<CommandTemplateObjectConfig, "args" | "defaults"> = {},
): CommandTemplateLeafConfig[] {
  const normalizedConfig = normalizeCommandTemplateConfig(config);
  const inheritedDefaults = normalizeCommandTemplateDefaults(
    inherited.defaults,
  );
  const ownDefaults = resolveInheritedDefaultReferences(
    normalizeCommandTemplateDefaults(normalizedConfig.defaults),
    inheritedDefaults,
  );
  const context = {
    ...(inherited.args !== undefined ? { args: inherited.args } : {}),
    ...(inheritedDefaults ? { defaults: inheritedDefaults } : {}),
    ...(normalizedConfig.args !== undefined
      ? { args: normalizedConfig.args }
      : {}),
    ...(ownDefaults
      ? { defaults: { ...(inheritedDefaults ?? {}), ...ownDefaults } }
      : {}),
  };
  const repeated = expandRepeatConfig(normalizedConfig, context);
  if (repeated) {
    return repeated.flatMap((step) =>
      expandCommandTemplateConfigs(step, context),
    );
  }
  const recoverConfig = normalizeRecoverConfig(normalizedConfig.recover);
  const recoverSteps = recoverConfig
    ? expandCommandTemplateConfigs(recoverConfig, context)
    : [];
  if (Array.isArray(normalizedConfig.template)) {
    return [
      ...normalizedConfig.template.flatMap((step) =>
        expandCommandTemplateConfigs(step, context),
      ),
      ...recoverSteps,
    ];
  }
  if (typeof normalizedConfig.template !== "string") return recoverSteps;
  return [
    {
      ...normalizedConfig,
      ...context,
      template: normalizedConfig.template,
      retry: normalizedConfig.retry,
    },
    ...recoverSteps,
  ];
}

export function getCommandTemplateWarnings(
  config: CommandTemplateConfig,
): string[] {
  return [
    ...new Set(
      expandCommandTemplateConfigs(config).flatMap((leaf) =>
        getLeafCommandTemplateWarnings(leaf),
      ),
    ),
  ];
}

export function getCommandTemplateRiskLabels(
  config: CommandTemplateConfig,
): CommandTemplateRiskLabel[] {
  return sortRiskLabels(
    expandCommandTemplateConfigs(config).flatMap((leaf) =>
      getLeafCommandTemplateRiskLabels(leaf),
    ),
  );
}

function parseCommandTemplateArgToken(value: string): {
  name: string;
  defaultValue?: string;
} {
  const separatorIndex = value.indexOf("=");
  const rawName =
    separatorIndex === -1 ? value : value.slice(0, separatorIndex);
  const colonIndex = rawName.indexOf(":");
  return {
    name: (colonIndex === -1 ? rawName : rawName.slice(0, colonIndex)).trim(),
    ...(separatorIndex === -1
      ? {}
      : { defaultValue: value.slice(separatorIndex + 1).trim() }),
  };
}

function parseCommandTemplatePlaceholderContent(
  content: string,
): { name: string; inlineDefault?: string } | undefined {
  const match = content.match(
    /^([A-Za-z_][A-Za-z0-9_-]*)(?::(?:string|path|int|number|bool|array|enum\([^)]*\)))?(?:=([^}]*))?$/,
  );
  if (!match) return undefined;
  return {
    name: match[1],
    ...(match[2] !== undefined ? { inlineDefault: match[2] } : {}),
  };
}

export function getCommandTemplateDefaults(
  config: CommandTemplateConfig | undefined,
): Record<string, string> {
  const normalizedConfig = config
    ? normalizeCommandTemplateConfig(config)
    : undefined;
  const defaults: Record<string, string> = {};
  for (const item of normalizeCommandTemplateArgs(normalizedConfig?.args)) {
    if (!item) continue;
    const parsed = parseCommandTemplateArgToken(item);
    if (!parsed.name || parsed.defaultValue === undefined) continue;
    defaults[parsed.name] = parsed.defaultValue;
  }
  for (const [key, value] of Object.entries(normalizedConfig?.defaults ?? {})) {
    defaults[key] = value === undefined || value === null ? "" : String(value);
  }
  return defaults;
}

export function splitCommandTemplate(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let active = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      active = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (active) words.push(current);
      if (active) current = "";
      active = false;
      continue;
    }
    current += char;
    active = true;
  }
  if (escaped) current += "\\";
  if (active || current) words.push(current);
  return words;
}

export function expandCommandTemplateExecutable(
  command: string,
  cwd: string,
): string {
  if (command === "~") return homedir();
  if (command.startsWith("~/")) return resolve(homedir(), command.slice(2));
  if (command.includes("/") && !isAbsolute(command))
    return resolve(cwd, command);
  return command;
}

function evaluateCommandTemplateExpression(
  expression: string,
  values: Record<string, unknown>,
): number {
  let index = 0;
  const source = expression.replace(/\s+/g, "");
  const peek = (): string | undefined => source[index];
  const consume = (char: string): boolean => {
    if (peek() !== char) return false;
    index += 1;
    return true;
  };
  const parsePrimary = (): number => {
    if (consume("(")) {
      const value = parseExpression();
      if (!consume(")"))
        throw new Error(`Invalid command template expression: ${expression}`);
      return value;
    }
    const numberMatch = source.slice(index).match(/^\d+/);
    if (numberMatch) {
      index += numberMatch[0].length;
      return Number(numberMatch[0]);
    }
    const nameMatch = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (nameMatch) {
      index += nameMatch[0].length;
      const value = values[nameMatch[0]];
      if (value === undefined || !/^-?\d+$/.test(String(value)))
        throw new Error(
          `Invalid command template expression variable: ${nameMatch[0]}`,
        );
      return Number(value);
    }
    throw new Error(`Invalid command template expression: ${expression}`);
  };
  const parseTerm = (): number => {
    let value = parsePrimary();
    while (true) {
      if (consume("*")) value *= parsePrimary();
      else if (consume("/")) value = Math.trunc(value / parsePrimary());
      else if (consume("%")) value %= parsePrimary();
      else return value;
    }
  };
  const parseExpression = (): number => {
    let value = parseTerm();
    while (true) {
      if (consume("+")) value += parseTerm();
      else if (consume("-")) value -= parseTerm();
      else return value;
    }
  };
  const value = parseExpression();
  if (index !== source.length)
    throw new Error(`Invalid command template expression: ${expression}`);
  return value;
}

function substituteCommandTemplateExpression(
  content: string,
  values: Record<string, unknown>,
): string | undefined {
  const padded = content.match(/^(_{1,6})\((.+)\)$/);
  if (padded) {
    return pad(
      evaluateCommandTemplateExpression(padded[2], values),
      padded[1].length + 1,
    );
  }
  if (!/[()+\-*\/%]/.test(content)) return undefined;
  return String(evaluateCommandTemplateExpression(content, values));
}

function shouldResolveEmbeddedCommandTemplateToken(
  token: string,
  values: Record<string, unknown>,
): boolean {
  const matches = [...token.matchAll(/\{([^{}]+)\}/g)];
  if (matches.length === 0) return false;
  return matches.every((match) => {
    const content = match[1];
    if (resolveCommandTemplateNullish(content, values) !== undefined)
      return true;
    if (resolveCommandTemplateTernary(content, values) !== undefined)
      return true;
    const indexed = content.match(
      /^([A-Za-z_][A-Za-z0-9_-]*)\[([A-Za-z_][A-Za-z0-9_-]*|\d+)\]$/,
    );
    if (indexed) return Object.hasOwn(values, indexed[1]);
    const simple = parseCommandTemplatePlaceholderContent(content);
    if (simple)
      return (
        Object.hasOwn(values, simple.name) || simple.inlineDefault !== undefined
      );
    try {
      return substituteCommandTemplateExpression(content, values) !== undefined;
    } catch {
      return false;
    }
  });
}

function isFalsyCommandTemplateValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return true;
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no"
  );
}

function resolveCommandTemplateCondition(
  condition: string,
  values: Record<string, unknown>,
): unknown {
  const trimmed = condition.trim();
  const negated = trimmed.startsWith("!");
  const name = negated ? trimmed.slice(1).trim() : trimmed;
  const value = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)
    ? values[name]
    : undefined;
  return negated ? isFalsyCommandTemplateValue(value) : value;
}

export function shouldRunCommandTemplateNode(
  value: boolean | string | undefined,
  values: Record<string, unknown>,
): boolean {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const exact = /^\{([^{}]+)\}$/.exec(trimmed);
  const resolved = exact
    ? resolveCommandTemplateValue(exact[1], values, "command template when")
    : resolveCommandTemplateCondition(trimmed, values);
  return !isFalsyCommandTemplateValue(resolved);
}

function resolveCommandTemplateNullish(
  content: string,
  values: Record<string, unknown>,
): string | undefined {
  const coalescing = content.match(/^([A-Za-z_][A-Za-z0-9_-]*)\?\?(.*)$/);
  if (!coalescing) return undefined;
  const value = values[coalescing[1]];
  return isFalsyCommandTemplateValue(value) ? coalescing[2] : String(value);
}

function resolveCommandTemplateTernary(
  content: string,
  values: Record<string, unknown>,
): string | undefined {
  const ternary = content.match(/^([^?:]+)\?([^:]*):(.*)$/);
  if (!ternary) return undefined;
  const condition = resolveCommandTemplateCondition(ternary[1], values);
  return isFalsyCommandTemplateValue(condition) ? ternary[3] : ternary[2];
}

function resolveCommandTemplateValue(
  content: string,
  values: Record<string, unknown>,
  missingLabel: string,
  depth = 0,
): string | undefined {
  if (depth > 5)
    throw new Error(`Command template value recursion exceeded: ${content}`);
  const nullish = resolveCommandTemplateNullish(content, values);
  if (nullish !== undefined) return nullish;
  const ternary = resolveCommandTemplateTernary(content, values);
  if (ternary !== undefined) return ternary;
  const indexed = content.match(
    /^([A-Za-z_][A-Za-z0-9_-]*)\[([A-Za-z_][A-Za-z0-9_-]*|\d+)\]$/,
  );
  if (indexed) {
    const source = values[indexed[1]];
    const indexValue = /^\d+$/.test(indexed[2])
      ? indexed[2]
      : values[indexed[2]];
    const index = Number(indexValue);
    if (
      !Array.isArray(source) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= source.length
    ) {
      throw new Error(`Missing ${missingLabel} value: ${content}`);
    }
    return String(source[index] ?? "");
  }
  const simple = parseCommandTemplatePlaceholderContent(content);
  if (simple) {
    if (Object.hasOwn(values, simple.name)) {
      const raw = values[simple.name] ?? "";
      if (
        typeof raw === "string" &&
        shouldResolveEmbeddedCommandTemplateToken(raw, values)
      ) {
        return substituteCommandTemplateToken(
          raw,
          values,
          missingLabel,
          depth + 1,
        );
      }
      return Array.isArray(raw) ? JSON.stringify(raw) : String(raw);
    }
    if (simple.inlineDefault !== undefined) return simple.inlineDefault;
  }
  const expression = substituteCommandTemplateExpression(content, values);
  if (expression !== undefined) return expression;
  return undefined;
}

export function substituteCommandTemplateToken(
  token: string,
  values: Record<string, unknown>,
  missingLabel = "command template",
  depth = 0,
): string {
  return token.replace(/\{([^{}]+)\}/g, (_match, content: string) => {
    const resolved = resolveCommandTemplateValue(
      content,
      values,
      missingLabel,
      depth,
    );
    if (resolved !== undefined) return resolved;
    throw new Error(`Missing ${missingLabel} value: ${content}`);
  });
}

export async function execCommandTemplate(
  command: string,
  args: string[],
  options: CommandTemplateExecOptions = {},
): Promise<CommandTemplateExecResult> {
  const maxAttempts = options.retry ?? 1;
  let lastResult: CommandTemplateExecResult = {
    stdout: "",
    stderr: "",
    code: 1,
    killed: false,
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await execCommandTemplateOnce(command, args, options);
    if (result.code === 0) return result;
    lastResult = result;
  }
  return lastResult;
}

function execCommandTemplateOnce(
  command: string,
  args: string[],
  options: CommandTemplateExecOptions = {},
): Promise<CommandTemplateExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let killTimeoutId: NodeJS.Timeout | undefined;
    const killProcess = (): void => {
      if (killed) return;
      killed = true;
      proc.kill("SIGTERM");
      killTimeoutId = setTimeout(() => {
        if (!settled) proc.kill("SIGKILL");
      }, options.killGrace ?? 5000);
    };
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      if (options.signal)
        options.signal.removeEventListener("abort", killProcess);
      resolve({ stdout, stderr, code, killed });
    };
    if (options.signal) {
      if (options.signal.aborted) killProcess();
      else
        options.signal.addEventListener("abort", killProcess, { once: true });
    }
    if (options.timeout !== undefined && options.timeout > 0)
      timeoutId = setTimeout(killProcess, options.timeout);
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    proc.stdin?.on("error", () => {});
    if (options.stdin !== undefined) proc.stdin?.end(options.stdin);
    proc.on("error", (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      settle(1);
    });
    proc.on("close", (code) => {
      settle(code ?? (killed ? 1 : 0));
    });
  });
}

export function buildCommandTemplateInvocation(
  config: CommandTemplateConfig,
  values: Record<string, unknown>,
  cwd: string,
  options: { emptyMessage?: string; missingLabel?: string } = {},
): CommandTemplateInvocation {
  const normalizedConfig = normalizeCommandTemplateConfig(config);
  if (Array.isArray(normalizedConfig.template)) {
    throw new Error(
      options.emptyMessage ??
        "Command template sequence cannot be executed as one command",
    );
  }
  if (!normalizedConfig.template)
    throw new Error(options.emptyMessage ?? "Command template is required");
  if (typeof normalizedConfig.template !== "string") {
    throw new Error(
      options.emptyMessage ??
        "Command template object cannot be executed as one command",
    );
  }
  const parts = splitCommandTemplate(normalizedConfig.template);
  const commandPart = parts[0];
  if (!commandPart)
    throw new Error(options.emptyMessage ?? "Command template is empty");
  const resolvedValues = {
    ...getCommandTemplateDefaults(normalizedConfig),
    ...values,
  };
  const command = expandCommandTemplateExecutable(
    substituteCommandTemplateToken(
      commandPart,
      resolvedValues,
      options.missingLabel,
    ),
    cwd,
  );
  const args = parts
    .slice(1)
    .map((part) =>
      substituteCommandTemplateToken(
        part,
        resolvedValues,
        options.missingLabel,
      ),
    )
    .filter((part) => part !== "");
  return { command, args };
}
