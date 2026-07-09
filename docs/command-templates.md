# Command Template Standard

Command templates are the portable integration format for deterministic local automation.

**Meta-contract:** transportable (bit-for-bit identical across projects), high-density (zero fluff), constant (evolve by crystallizing, not speculating), optimal minimum (add only when it hurts).

**Scope:** portable synchronous command execution format — shell-free exec, composition/pipes, optional timeout, delay-before-start, bounded retry, failure propagation, recover cleanup, output artifact selection, and handler-level fallback. Single JSON standard; no platform lock-in.

---

Extensions may choose their own config files, selectors, placeholder sources, and examples, but should preserve this core contract.

Layer boundary: command templates own only the synchronous execution graph. Recipe imports, import-reference expressions, recipe lookup, `async: true`, run ids, state dirs, FIFO controls, and outbox events are host/recipe/async-run configuration layers, not portable command-template syntax.

## Shape

A command template is either a command-line string or an ordered array of command-template leaves:

```json
{
  "template": "/path/to/stt --file {file} --lang {lang=ru}"
}
```

When the surrounding schema already implies a command template, the compact string form is equivalent:

```json
"/path/to/stt --file {file} --lang {lang=ru}"
```

There is no portable `command` field. The command is derived from `template`: after splitting, the first word is the executable and the remaining words are argv args. Templates do not infer flags: `{file}` is one positional arg; `--file {file}` is a flag arg plus its value.

Common object fields:

- `label`: Optional human label for diagnostics and parallel branch reports.
- `parallel`: Optional boolean execution flag for array templates. Default is sequential execution; `true` runs children concurrently when the host execution layer supports branch fanout.
- `when`: Optional boolean or condition string. Falsy values skip the node. String forms may reference a flag name, `!flag`, or a placeholder expression such as `{flag?yes:}`.
- `args`: Optional placeholder declarations. Untyped names remain valid; compact typed forms such as `file:path`, `timeout:int`, `speed:number`, `dry_run:bool`, `prompts:array`, and `mode:enum(check,fix)` are valid when the host supports typed tool schemas. Defaults belong in `defaults` or inline placeholder defaults; hosts may normalize interactive shorthand such as `timeout:int=60000` before persistence.
- `defaults`: Placeholder default values by name.
- `timeout`: Optional execution timeout in milliseconds, as a number or placeholder-resolved string. Omit it, or set `0`, to leave the command unbounded. Set an explicit positive timeout when a tool must fail closed instead of waiting indefinitely.
- `delay`: Optional wait in milliseconds before starting this node, as a number or placeholder-resolved string. Default is no delay.
- `output`: Optional result selector. Default is `"stdout"`; runtime values such as `"ogg"` are valid.
- `retry`: Optional max attempts including the first, as a number or placeholder-resolved string. Default is `1`.
- `failure`: Optional failure propagation scope: `continue`, `branch`, or `root`. Default is `continue`.
- `recover`: Optional command template run between failed retry attempts. Recovery output is ignored; recovery failure stops retries.
- `template`: Required command string or ordered composition array.

For object form, write `template` last. Read the node flags first, then the executable content. Storage paths, labels, selectors, descriptions, and registry-specific metadata belong to each extension's local schema.

## Execution

A runtime must:

1. Split the template into shell-like words with simple single quotes, double quotes, and backslash escapes
2. Substitute placeholders inside each split word
3. Execute command + args directly, without shell evaluation
4. Treat exit code `0` as success and non-zero as failure
5. Use stdout as the default result channel and stderr only for diagnostics

Implementations may expand `~` in command position and may resolve relative command paths against the caller cwd.

## Placeholders

Supported forms:

| Form | Meaning |
| --- | --- |
| `{name}` | Required value from runtime values or `defaults` |
| `{name=default}` | Inline default when no value is provided |
| `{items[index]}` | Array item selected by literal or repeat index |
| `{value??fallback}` | Fallback when the value is absent or falsy |
| `{flag?yes:no}` | Conditional text selected by flag truthiness |

Resolution order is runtime values → `defaults` → inline default → error. Default values that are themselves a single placeholder, such as `{prompt}` resolving to `{prompts[index]}`, are resolved recursively with a small depth guard. A repeat node may set `repeat` to `{items.length}` when an array arg should determine fanout width.

```json
{
  "template": "/path/to/tts --text {text} --lang {lang=ru} --rate {rate=+30%}"
}
```

With runtime values `{ "text": "hello" }`, argv is:

```text
["--text", "hello", "--lang", "ru", "--rate", "+30%"]
```

Use `defaults` for visible configuration data; use inline defaults for compact local literals. Prefer flag-style examples such as `/path/to/tool --file {file} --lang {lang=ru}` for readability, but positional forms such as `/path/to/tool {file} {lang=ru}` are valid when the invoked script defines that CLI contract.

Typed declarations annotate the public tool interface, not the shell command. They may live in `args` or inline placeholders such as `{timeout:int=60000}` and `{mode:enum(check,fix)=check}`. Use metadata-first authoring (`args` plus `defaults`) when long templates should stay visually short; use inline-first authoring when one self-contained `template` property is clearer. They do not sandbox or reinterpret the executable; they only let the host generate narrower input schemas and normalize runtime values before placeholder substitution. Untyped `args` and untyped placeholders continue to work unchanged.

## Quoting

Placeholder values are not shell-escaped because no shell is used. A value containing spaces remains one argv item when it replaces one split word:

```text
template="echo {text}"
text="hello world"
args=["hello world"]
```

A placeholder may also be embedded inside one word:

```text
template="/path/to/tool --file={file}"
file="/tmp/a b.ogg"
args=["--file=/tmp/a b.ogg"]
```

Use quotes only for literal template words that should contain spaces before placeholder substitution:

```text
template="echo 'literal words' {text}"
```

## Composition

`template: [...]` means sequential composition by default; each leaf is a command template executed with one shared runtime value map:

```json
{
  "template": [
    "/path/to/tts --text {text} --lang {lang=ru} --out {mp3}",
    "ffmpeg -y -i {mp3} -c:a libopus {ogg}"
  ],
  "output": "ogg"
}
```

Composition rules:

- Execute leaves in order by default
- Execute child templates concurrently when `parallel` is `true`
- Parallel composition uses soft-quorum semantics by default: failed children are reported as degraded branches unless failure propagation escalates
- Non-critical failures are recorded and execution continues, while `failure: "branch"` stops the current branch and `failure: "root"` aborts the root composition
- Treat the whole composition as one handler for selector matching and fallback
- Top-level `args` and `defaults` apply to every leaf unless the leaf defines private values
- Leaf `args` replace inherited `args`; leaf `defaults` merge over inherited defaults; `timeout` and `output` are not inherited into leaves
- Timeout is disabled by default; configure a positive `timeout` for bounded commands that should fail closed
- Each sequence leaf receives the previous leaf's stdout on stdin by default, while the final leaf stdout remains the default composition result
- Each parallel child receives the same stdin, and child stdout values are joined in stable array order before flowing to the next sequence leaf
- Parallel branch joins include branch label and status, and tool details include branch metadata plus coverage summary
- Each leaf still applies its own inline defaults

```json
{
  "template": [
    "/path/to/tts --text {text} --lang {lang} --out {mp3}",
    {
      "defaults": { "codec": "libopus" },
      "template": "ffmpeg -y -i {mp3} -c:a {codec} {ogg}"
    }
  ],
  "args": ["text", "lang", "mp3", "ogg"],
  "defaults": { "lang": "en" },
  "output": "ogg"
}
```

`output` selects the primary result channel. Omitted `output` means `"stdout"`, and explicitly writing `"output": "stdout"` is valid standard syntax. Artifact-producing handlers may instead name a runtime value or placeholder path, e.g. `"ogg"` or `"{ogg}"`.

### Repeat

`repeat` expands one command-template node N times before execution. It works with both sequence and parallel nodes and is useful when many branches differ only by a number.

```json
{
  "parallel": true,
  "repeat": 8,
  "template": "render page{_(index+1)}.html --prev page{_(prev+1)}.html --next page{_(next+1)}.html --zero page{_index}.html"
}
```

Reserved repeat placeholders are injected into each repeated node:

- `{index}`: current zero-based index, `0..repeat-1`
- `{prev}` / `{next}`: wrapped zero-based neighbors
- `{repeat}`: total repeat count

Human 1-based numbering is intentionally expressed as limited arithmetic: `{index+1}`, `{prev+1}`, `{next+1}`.

Leading underscores on repeat placeholders request zero padding. One underscore means width 2, two underscores mean width 3, and so on:

```text
{_index}      → 00, 01, ...
{_(index+1)}  → 01, 02, ...
{__(index+1)} → 001, 002, ...
{_(prev+1)}   → wrapped previous page number, padded to width 2
{_(next+1)}   → wrapped next page number, padded to width 2
```

Repeat expressions support only integers, `index`, `prev`, `next`, `repeat`, parentheses, and `+`, `-`, `*`, `/`, `%`. They are not JavaScript and cannot call functions or access properties.

Repeat placeholders are local generated values. Call-time args should not use these reserved names to override the repeat index.

Parallel nodes use the same object shape. Flags come first and `template` stays last:

```json
{
  "template": [
    "prepare {out_dir}",
    {
      "parallel": true,
      "template": [
        {
          "label": "gpt-5.5",
          "timeout": 300000,
          "template": "review-gpt {scope}"
        },
        {
          "label": "deepseek-pro",
          "timeout": 300000,
          "template": "review-deepseek {scope}"
        },
        {
          "label": "kimi",
          "timeout": 300000,
          "template": "review-kimi {scope}"
        }
      ]
    },
    "merge {out_dir}"
  ]
}
```

A degraded parallel join is still usable when at least one branch succeeds:

```text
--- branch: gpt-5.5 status: done ---
review text
--- branch: deepseek-pro status: failed ---
exit: 1
stderr: provider balance exhausted
```

Use `template: [...]` for ordered composition. Older local `pipe` aliases are not part of the 0.13.0 command-template standard.

## Fail-Open Default Policy

By default, composition continues on failure: the failed step is logged and the next step executes. This is analogous to `make -k` — the user sees all failures at once and decides what to fix.

## Failure Propagation

By default, failed steps use `failure: "continue"`: record the failure, clear stdout for that step, and continue the current sequence. This preserves the fail-open profile.

Use `failure` when a node should stop more aggressively:

- `"continue"`: record the failure and continue the current sequence.
- `"branch"`: stop the current sequence/subtree and return a failed branch to the nearest parent. In a parallel node, sibling branches keep running and the join becomes degraded. At the root, branch failure is still a tool failure.
- `"root"`: abort the outermost composition.

```json
{
  "parallel": true,
  "template": [
    {
      "label": "agent-a",
      "failure": "branch",
      "template": [
        "agent-a-work {scope}",
        "agent-a-validate {scope}",
        "agent-a-push {scope}"
      ]
    },
    {
      "label": "agent-b",
      "failure": "branch",
      "template": [
        "agent-b-work {scope}",
        "agent-b-validate {scope}",
        "agent-b-push {scope}"
      ]
    }
  ]
}
```

If `agent-a-validate` fails, `agent-a-push` is skipped, `agent-b` can still finish, and the parallel join reports degraded branch coverage.

Use `failure: "root"` to abort the root composition. Older local `critical: true` shapes are not part of the 0.13.0 command-template standard.

## Retry

Set `retry: N` to attempt execution up to `N` times including the first. The first successful attempt stops the retry loop.

On leaf commands, retry repeats that command. On sequence or parallel nodes, retry repeats the whole node. A retried group only retries when the group returns a failure, so validator checkpoints normally pair group retry with `failure: "branch"` or `failure: "root"`.

```json
{
  "failure": "branch",
  "retry": 3,
  "template": ["implement {scope}", "npm test", "git diff --check"]
}
```

Here the whole group runs again when a validator fails. Without `failure: "branch"`, the failed validator would be logged and the group would continue by default.

## Recover

Set `recover` on a retried node to run cleanup after a failed attempt and before the next attempt. `recover` is another command template: it can be a string command, sequence, or mode tree. Its output is ignored and the next retry receives the original stdin.

```json
{
  "failure": "branch",
  "retry": 3,
  "recover": "git -C {work_dir} reset --hard HEAD",
  "template": ["pi -p --tools read,edit,bash {scope_file}", "npm test"]
}
```

`recover` is not a fallback success path. It is cleanup between attempts. Practical uses include resetting a worktree, removing temp files, clearing generated output, releasing a local lock, or stopping a helper process before trying the node again. If recovery fails, retries stop and the recovery failure is returned. Recovery uses fail-closed semantics by default; set an explicit `failure` inside a recover template only when a softer cleanup failure is intentional.

## Delay

Set `delay` to wait before starting a node. The value is milliseconds. Delay is not inherited into child nodes, just like `timeout`.

```json
{
  "template": [
    "prepare {scope}",
    { "delay": 1000, "template": "review {scope}" }
  ]
}
```

On a sequence node, `delay` waits before the sequence begins. On a parallel node, `delay` waits before launching its children. On a branch, `delay` waits before that branch starts, without blocking sibling branches.

Use `delay` only for explicit backoff, rate pacing, or staged launch. Do not use it as a scheduler.

## Progressive Disclosure

The standard uses a single `template` field that grows with the user's needs:

```text
string           → leaf command
string[]         → sequential composition
{ template }     → leaf command object
{ parallel, template } → parallel subtree
{ parallel, when, args, defaults, delay, retry, failure, recover, output, template } → full node
```

Start with a string. Add composition when needed. Add `parallel: true` when independent work can run concurrently. Add `when` for conditional nodes. Add delay when launch pacing matters. Add retry when flaky. Add `failure` when propagation scope matters. Add `recover` when a retried node needs cleanup before another attempt. Same contract, growing capability, no dead weight.

`parallel: true` is the synchronous fanout shape. Saved JSON recipes and detached lifecycle concerns such as logs, cancellation, and durable state belong to host-specific recipe/async-run standards, not to command templates.

## Trust Boundary

Command templates avoid shell interpolation by splitting the template into argv first and substituting placeholders per arg. A placeholder value containing spaces remains one argv value, not a shell fragment.

This is not a sandbox. The executable still runs with the same user permissions as the host agent. Shells, interpreter eval modes, destructive filesystem commands, and local scripts remain trusted code. Examples that deserve extra operator attention:

- `bash`, `sh`, `zsh`, or `fish`, especially with `-c`.
- `node -e`, `python -c`, `ruby -e`, `perl -e`, or similar eval modes.
- `rm`, `mv`, `cp`, or `rsync` over broad paths or placeholder-derived paths.

Hosts may surface lightweight warnings for these obvious high-risk shapes. Warnings should inform review without blocking existing tools, because many trusted local wrappers intentionally use shells or filesystem mutation.

## Tool Boundary

Agent tools are a separate abstraction. A tool name is not a portable command template because the pi extension API exposes tool registration metadata, not a public extension-to-extension `executeTool(name, args)` contract. Until such an API exists, extensions should use command templates for deterministic local automation.

## Compatibility

Consumers should share this contract, not private registry fields or implementation details from any specific extension.
