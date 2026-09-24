/**
 * Command-template execution standard.
 * Zones: shell-free command parsing, placeholder expansion, local process execution, composition semantics
 * Owns portable command-template parsing, expansion, risk checks, retries, timeouts, and direct execution.
 */
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
export type CommandTemplateValue = string | CommandTemplateConfig[] | CommandTemplateObjectConfig;
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
export type CommandTemplateRiskLabel = "risk.shell" | "risk.eval" | "risk.broad_fs_write" | "risk.destructive_fs" | "risk.network" | "risk.external_side_effect" | "risk.long_running" | "risk.platform_specific" | "risk.secret_touching";
export declare function normalizeCommandTemplateConfig(config: CommandTemplateConfig): CommandTemplateObjectConfig;
export declare function resolveInheritedDefaultReferences(ownDefaults: Record<string, unknown> | undefined, inheritedDefaults: Record<string, unknown> | undefined, runtimeValues?: Record<string, unknown>): Record<string, unknown> | undefined;
export declare function resolveCommandTemplateRepeat(value: number | string | undefined, values?: Record<string, unknown>): number | undefined;
export declare function getCommandTemplateRepeatDefaults(index: number, repeat: number): Record<string, string>;
export declare function expandCommandTemplateConfigs(config: CommandTemplateConfig, inherited?: Pick<CommandTemplateObjectConfig, "args" | "defaults">): CommandTemplateLeafConfig[];
export declare function getCommandTemplateWarnings(config: CommandTemplateConfig): string[];
export declare function getCommandTemplateRiskLabels(config: CommandTemplateConfig): CommandTemplateRiskLabel[];
export declare function getCommandTemplateDefaults(config: CommandTemplateConfig | undefined): Record<string, string>;
export declare function splitCommandTemplate(input: string): string[];
export declare function expandCommandTemplateExecutable(command: string, cwd: string): string;
export declare function shouldRunCommandTemplateNode(value: boolean | string | undefined, values: Record<string, unknown>): boolean;
export declare function substituteCommandTemplateToken(token: string, values: Record<string, unknown>, missingLabel?: string, depth?: number): string;
export declare function execCommandTemplate(command: string, args: string[], options?: CommandTemplateExecOptions): Promise<CommandTemplateExecResult>;
export declare function buildCommandTemplateInvocation(config: CommandTemplateConfig, values: Record<string, unknown>, cwd: string, options?: {
    emptyMessage?: string;
    missingLabel?: string;
}): CommandTemplateInvocation;
