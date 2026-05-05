# Attachment Handlers

`pi-telegram` can run ordered inbound attachment handlers after downloading files and before the Telegram turn enters the π queue.

This document is the local adaptation of the portable [Command Template Standard](./command-templates.md).

## Config Shape

`telegram.json` may define `attachmentHandlers`:

```json
{
  "attachmentHandlers": [
    {
      "type": "voice",
      "template": "/path/to/stt1 --file {file} --lang {lang=ru}"
    },
    {
      "mime": "audio/*",
      "template": "/path/to/stt2 --file {file} --lang {lang=ru}"
    }
  ]
}
```

Handlers match by `type`, `mime`, or `match`. Wildcards such as `audio/*` are accepted. Each matching handler must provide `template`; a string is one command, and an array is ordered composition. Top-level `args` and `defaults` apply to composed steps unless a step defines private values. The command-template default timeout applies automatically. Legacy configs may still use `pipe` as a local alias.

## Template Placeholders

Attachment handlers support these built-in placeholders:

| Placeholder | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| `{file}`    | Full local path to the downloaded file                           |
| `{mime}`    | MIME type if known                                               |
| `{type}`    | Attachment kind such as `voice`, `audio`, `document`, or `photo` |

`defaults` may provide additional placeholder values such as `{lang}` or `{model}`. `args` is only a string-array declaration of supported placeholders; defaults belong in `defaults` or inline placeholders such as `{lang=ru}`. Examples prefer explicit flag-style CLIs for readability, but positional forms such as `/path/to/stt {file} {lang=ru} {model=voxtral-mini-latest}` are equally valid when the target script supports them.

If a top-level one-step handler template has no `{file}` placeholder, the downloaded file path is appended as the last command arg as a one-step handler convenience. Composition steps are plain command templates and do not receive implicit file-path args; include `{file}` explicitly where needed.

## Ordered Fallbacks

A handler list is ordered. For each attachment, matching handlers run in list order and stop after the first successful handler. A composed handler counts as one handler for fallback purposes: if any step fails, the next matching handler is tried.

If a matching handler fails with a non-zero exit code, the runtime records diagnostics and tries the next matching handler. If every matching handler fails, the attachment remains visible in the prompt as a normal local file reference.

## Prompt Output

Local attachments stay in the prompt under `[attachments] <directory>` with relative file entries. Successful handler stdout is added under `[outputs]`. For composed handlers, each step receives the previous step's stdout on stdin by default, and stdout from the last successful step is used as the handler output. Empty output and failed handler output are omitted from the prompt text.
