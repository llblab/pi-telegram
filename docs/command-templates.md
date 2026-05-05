# Command Template Standard

Command templates are the portable integration format for deterministic local automation.

**Meta-contract:** transportable (bit-for-bit identical across projects), high-density (zero fluff), constant (evolve by crystallizing, not speculating), optimal minimum (add only when it hurts).

**Scope:** portable command execution format — shell-free exec, composition/pipes, default timeout, critical-step branching, output artifact selection, handler-level fallback. Single JSON standard; no platform lock-in.

---

Extensions may choose their own config files, selectors, placeholder sources, and examples, but should preserve this core contract.

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

| Field      | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `template` | Required command string or ordered composition array                                       |
| `args`     | Optional placeholder-name declarations only; never stores defaults                         |
| `defaults` | Placeholder default values by name                                                         |
| `timeout`  | Optional execution timeout override in milliseconds; default `30000` (30s)                 |
| `output`   | Optional result selector; default `"stdout"`, or a "runtime value", e.g. `"ogg"`           |
| `critical` | Optional boolean; default `false`. When `true`, failure aborts the entire root composition |

Storage paths, labels, selectors, descriptions, and registry-specific metadata belong to each extension's local schema.

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

| Form             | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `{name}`         | Required value from runtime values or `defaults` |
| `{name=default}` | Inline default when no value is provided         |

Resolution order is runtime values → `defaults` → inline default → error.

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

`template: [...]` means sequential composition; each leaf is a command template executed with one shared runtime value map:

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

- Execute leaves in order and stop on the first non-zero exit
- Treat the whole composition as one handler for selector matching and fallback
- Top-level `args` and `defaults` apply to every leaf unless the leaf defines private values
- Leaf `args` replace inherited `args`; leaf `defaults` merge over inherited defaults; `timeout` and `output` are not inherited into leaves
- Default `30000` (30s) timeout applies automatically; configure `timeout` only for exceptional long-running commands
- Each leaf receives the previous leaf's stdout on stdin by default, while the final leaf stdout remains the default composition result
- Each leaf still applies its own inline defaults

```json
{
  "template": [
    "/path/to/tts --text {text} --lang {lang} --out {mp3}",
    {
      "template": "ffmpeg -y -i {mp3} -c:a {codec} {ogg}",
      "defaults": { "codec": "libopus" }
    }
  ],
  "args": ["text", "lang", "mp3", "ogg"],
  "defaults": { "lang": "en" },
  "output": "ogg"
}
```

`output` selects the primary result channel. Omitted `output` means `"stdout"`, and explicitly writing `"output": "stdout"` is valid standard syntax. Artifact-producing handlers may instead name a runtime value or placeholder path, e.g. `"ogg"` or `"{ogg}"`.

Legacy local schemas may accept `pipe` as an alias, but the portable standard is `template: [...]`.

## Fail-Open Default Policy

By default, composition continues on failure: the failed step is logged and the next step executes. This is analogous to `make -k` — the user sees all failures at once and decides what to fix.

## Critical Steps

Set `critical: true` on any leaf to abort the entire root composition on failure. One `critical` leaf can halt the whole pipeline.

```json
{
  "template": [
    { "template": "cargo build" },
    { "template": "cargo fmt --check" },
    { "template": "cargo test", "critical": true }
  ]
}
```

`build` / `fmt` failures are logged, execution continues. `test` failure aborts the root composition immediately.

A `critical` leaf in a nested composition still aborts the outermost root `template: [...]`. There is no per-branch scoping in the current standard.

## Progressive Disclosure

The standard uses a single `template` field that grows with the user's needs:

```text
string           → leaf command
string[]         → sequential composition
{ template }     → leaf with defaults
{ template, critical, output } → full leaf
```

Start with a string. Add composition when needed. Add critical when safety matters. Same contract, growing capability, no dead weight.

## Tool Boundary

Agent tools are a separate abstraction. A tool name is not a portable command template because the pi extension API exposes tool registration metadata, not a public extension-to-extension `executeTool(name, args)` contract. Until such an API exists, extensions should use command templates for deterministic local automation.

## Compatibility

Consumers should share this contract, not private registry fields or implementation details from any specific extension.
