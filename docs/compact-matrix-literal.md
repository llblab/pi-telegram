# Adaptive Button Literal

> Status: Portable CML v4 button standard; `pi-telegram` also reuses its positional-cell mechanics for compact voice actions.

Adaptive Button Literal is one bounded-depth matrix grammar over a shared button AST. It accepts strict JSON button objects, positional Compact Matrix Literal (CML) cells, or both in the same matrix and row. Commas between completed matrix or row elements are optional, so producers can progressively compress representation without changing runtime meaning.

```text
full named JSON → comma-optional adjacency → mixed named/positional cells → compact CML
```

The compact form is not JSON: `{label|prompt|selected_style|disabled}` assigns meaning by position. The formats share semantics and topology, not syntax.

## Goals

- Preserve one ordered button matrix across multiple representation densities.
- Let producers compress individual cells without converting the whole surface.
- Preserve valid strict JSON behavior unchanged.
- Admit deterministic linear-time parsing without evaluation or partial recovery.
- Keep rendering, callback ownership, and application state outside the notation.

## Data Model

Every accepted payload normalizes to a non-empty ordered list of non-empty rows:

```text
Cell = { label?: string, prompt?: string, value?: string, selected_style?: string, disabled?: boolean }
Rows = Cell[][]
```

A top-level cell becomes a singleton row. A nested row preserves horizontal grouping.

These representations are semantically equivalent:

```text
[[{"label":"Pause","prompt":"music::pause"},{"value":"Next"}],{"value":"Status"}]
[[{"label":"Pause","prompt":"music::pause"}{"value":"Next"}]{"value":"Status"}]
[[{"label":"Pause","prompt":"music::pause"},{Next}],{Status}]
[[{Pause|music::pause}{Next}]{Status}]
```

Named JSON objects and positional cells may coexist within the same horizontal row:

```text
[[{"label":"Open","prompt":"/tmp"}{Back|/}]]
```

## Positional Cells

A one-atom cell copies its value into label and prompt through the existing button contract:

```text
{Next}
```

A two-atom cell separates label and prompt:

```text
{Pause|music::pause}
```

The first label position may be empty. Prompt-only `{|e2}` is equivalent to JSON `{"prompt":"e2"}`: the existing button fallback uses `e2` as both visible text and queued prompt without requiring a separately authored label.

A three-atom cell adds the selected style and retains the same optional-label form:

```text
{Stop|music::stop|danger}
{|e2|success}
```

In a three-atom cell, the prompt and style remain required; style accepts only `primary`, `success`, or `danger`.

A four-atom cell adds disabled state:

```text
{Next|||1}
{|||1}
{Next|counter::next|success|1}
{Next|counter::next||0}
```

The fourth atom accepts `1` or `true` (disabled), and `0` or `false` (enabled), with exact lowercase spelling; omitting the fourth position keeps the button enabled. The third atom may be empty in this form to retain the default selected style. Disabled cells may omit the prompt, label, and selected style: `{Next|||1}` is a label-only control and `{|||1}` is a blank disabled cell. Enabled CML cells still require a prompt. Telegram requires a `text` field, so its renderer sends a non-breaking space (`U+00A0`) for a blank disabled cell; the notation itself does not invent a label or action. Client rendering of blank cells requires live verification. JSON uses a boolean `disabled`; other value types are invalid. Disabled cells remain visible in their original row but register no action and carry no callback data.

## Adaptive Grammar

The structural grammar is:

```text
payload         := json-object | matrix | positional-cell
matrix          := "[" ws element (boundary element)* ws "]"
element         := cell | row
row             := "[" ws cell (boundary cell)* ws "]"
cell            := json-object | positional-cell
boundary        := ws [","] ws
positional-cell := "{" atom "}"
                 | "{" [atom] "|" atom "}"
                 | "{" [atom] "|" atom "|" atom "}"
                 | "{" [atom] "|" atom "|" [atom] "|" ("0" | "false") "}"
                 | "{" [atom] "|" [atom] "|" [atom] "|" ("1" | "true") "}"
atom            := atom-unit+
atom-unit       := ordinary | "\|" | "\}" | "\\"
ws              := *(SP | HTAB | CR | LF)
```

`boundary` occurs after one complete element. It may contain one comma or no comma; one trailing comma before a closing row or matrix delimiter is also tolerated. Element delimiters keep empty adjacency unambiguous. Leading and repeated commas remain invalid.

A `json-object` is one complete JSON object. Strict JSON is attempted first; a bounded recovery removes commas immediately before `}` or `]` outside strings and retries. Property names, strings, escaping, nested values, and all other internals remain strict; missing property commas are not invented.

Rows cannot contain rows. The grammar never recurses beyond one row inside the top-level matrix.

## Atoms, Whitespace, And Escapes

Leading and trailing whitespace in positional atoms is trimmed. Internal ordinary spaces are preserved. CR, LF, HTAB, C0 controls, DEL, and C1 controls remaining inside an atom after trimming are invalid.

Only three positional-cell escapes exist:

```text
\|  → literal |
\}  → literal }
\\  → literal \
```

Every other printable character is literal inside a positional cell, including commas, colons, quotes, square brackets, emoji, and ordinary spaces. A comma inside `{label|prompt}` is data; a comma after the closing `}` is an optional element separator.

## Deterministic Parsing

A conforming parser:

1. Attempts strict JSON first for sources beginning with `{` or `[`. Successful JSON is validated only against the existing button matrix schema and never reinterpreted.
2. If strict JSON parsing fails, parses the original source with the adaptive grammar.
3. Tries one complete strict JSON object, then bounded trailing-comma recovery, at each cell boundary before positional interpretation.
4. Keeps JSON-shaped named objects on the JSON path when validation fails instead of exposing their source as positional text.
5. Accepts at most one comma between elements or immediately before a closing row or matrix delimiter, while rejecting leading, repeated, or property-level omitted commas.
6. Rejects empty matrices, rows, one-atom cells, enabled-cell prompts, and nesting deeper than one row. The label may be empty in multi-atom cells; the style may additionally be empty in four-atom cells. Disabled four-atom cells may omit all first three atoms. Rejects unknown styles, invalid disabled values, and more than four button atoms.
7. Decodes only `\|`, `\}`, and `\\` in positional cells.
8. Extracts the first complete valid payload from a tolerant comment envelope and ignores unrelated text or isolated unmatched matrix brackets around it.
9. Returns no partial rows or cells from a balanced malformed candidate.
10. Runs over host-bounded payloads with fixed grammar depth.

Malformed JSON-looking input receives no generic recovery. It is accepted only if it independently forms a complete valid adaptive literal.

## Telegram Profiles

For `telegram_button` hidden comments and fenced blocks:

- JSON `value` keeps its existing label/prompt fallback semantics.
- Positional `{value}` is equivalent to JSON `{"value":"value"}`; a lone JSON `label` or `prompt` has the same both-fields shorthand semantics.
- Positional `{|prompt}` is equivalent to JSON `{"prompt":"prompt"}` and therefore uses the prompt as both visible text and queued prompt.
- Positional `{label|prompt}` is equivalent to JSON `{"label":"label","prompt":"prompt"}`.
- Positional `{label|prompt|selected_style}` and `{|prompt|selected_style}` are equivalent to their corresponding JSON objects.
- Positional `{label|prompt|selected_style|1}` is equivalent to JSON `{"label":"label","prompt":"prompt","selected_style":"selected_style","disabled":true}` with a valid selected style; `{|prompt||1}` is equivalent to `{"prompt":"prompt","disabled":true}`. Fourth-position `0` or `false` matches `disabled: false`; `true` is equivalent to `1`.
- `{label|||1}` matches JSON `{"label":"label","disabled":true}`; `{|||1}` matches `{"disabled":true}`. Disabled cells require no prompt and do not retain action or selected-style semantics.
- Disabled buttons serialize as `{ text, disabled: {} }`, without `callback_data`; they neither enqueue prompts nor invoke bound app methods. Enabled controls keep existing selection and callback behavior.
- Top-level cells become full-width rows.
- Nested rows become horizontal keyboard rows.
- Invalid payloads are stripped with their recognized action comment and register no callbacks.

The wrapper selects placement without changing cell semantics. A hidden `telegram_button` HTML comment builds the footer keyboard. A standalone column-zero fenced block opened by exactly three backticks plus `telegram_button` renders rows between paragraphs in Native Rich Markdown. A singleton JSON/CML object needs no array in either wrapper. Fenced content must be one complete payload without trailing envelope text. Larger outer fences and ordinary code blocks remain literal examples; unclosed action fences are withheld. Native Rich rows support at most eight buttons and must fit one message chunk; these are renderer constraints, not grammar limits. HTML compatibility places fenced controls in the footer. See [Outbound](./outbound.md) for delivery and callback behavior.

````markdown
Description.

```telegram_button
[{Details|Explain this section.}[{Choose|Choose this option.}{Unavailable|||true}]]
```

Next paragraph.
````

For `telegram_voice`, one positional cell maps `{text}`, `{text|lang}`, or `{text|lang|rate}` to one voice artifact. JSON object cells remain available for named fields, escaping, and multiline text. Voice comments do not accept matrix or row composition.

Example:

```html
<!-- telegram_button [{⬆️ Up|/},[{⬅️|page-1}{➡️|page-3}],{"label":"📁 etc","prompt":"/etc"}] -->
```

The enclosing HTML-comment transport owns its own delimiter boundary. Content containing the comment terminator must use another supported representation.

## Width Policy

The grammar imposes no visual row-width maximum. Renderer and interaction policy own width. The bundled Generated Control Surface Skill defaults to at most five short position-bearing controls per row, permits six to eight only when labels remain compact, and treats eight as the phone-width UX maximum.

## Conformance

Accepted classes include:

- Strict JSON objects and matrices.
- Positional singleton, two-atom, prompt-only `{|prompt}`, styled, and four-atom disabled-state cells.
- Matrices and rows with commas, without commas, or a mixture of boundaries.
- Named JSON and positional cells mixed in one matrix or row.
- Literal commas inside positional atoms and strict JSON strings.
- Unicode, defined escapes, structural whitespace, and rows at supported renderer widths.
- Semantic equivalence across every progressive-compression step.

Rejected classes include:

- Empty payloads, matrices, rows, one-atom cells, enabled-cell prompts, or three-atom styles; disabled four-atom cells may omit the first three atoms but not the disabled flag.
- Leading or repeated element commas.
- Missing commas between properties inside a JSON object.
- Deeper row nesting.
- Missing, crossed, or mismatched delimiters.
- A fourth positional separator, unknown style, invalid disabled flag, unknown escape, or trailing backslash.
- Internal control characters.
- Valid JSON that fails the existing JSON action schema.

Every rejected case proves zero callback registration.

## Versioning

This document defines CML v4. V4 adds a fourth button atom for disabled state, permits an empty third atom in that form, and makes labels and prompts optional for disabled cells. Existing one-, two-, and three-atom button cells, JSON/CML mixing, optional element-boundary commas, and prompt-only fallback semantics remain unchanged. Voice cells retain their three-atom maximum. JSON object internals and nesting depth remain unchanged. Future versions must preserve strict-JSON-first routing, bounded depth, atomic rejection, and an explicit discriminator for any new meaning at a security or ownership boundary.
