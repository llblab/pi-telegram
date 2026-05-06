# Inbound Handlers

`pi-telegram` can run ordered inbound handlers before a Telegram turn enters the π queue. Inbound handlers are the provider-neutral Telegram → π transformation bus for raw text and downloaded media/files.

This document is the local inbound adaptation of the portable [Command Template Standard](./command-templates.md). It is also the canonical home for the legacy `attachmentHandlers` compatibility config.

## Config Shape

Prefer `inboundHandlers` for new configs:

```json
{
  "inboundHandlers": [
    {
      "type": "text",
      "template": "/path/to/translate --lang {lang=en} --text \"{text}\""
    },
    {
      "type": "voice",
      "template": [
        "/path/to/stt --file {file} --lang {lang=ru}",
        "/path/to/translate-stdin --lang {lang=en}"
      ]
    },
    {
      "mime": "application/pdf",
      "template": "/path/to/pdf-to-text --file {file}"
    }
  ]
}
```

Legacy `telegram.json` files may still define `attachmentHandlers` for media/file preprocessing:

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

At runtime, `attachmentHandlers` is appended after `inboundHandlers`. Existing configs continue to work, while new configs should use `inboundHandlers`.

Handlers match by optional `type`, `mime`, or `match`. `mime` and `type` are independent selectors: if `mime` is present, `type` is not required. Wildcards such as `audio/*` or `text/*` are accepted. Each matching handler must provide `template`; a string is one command, and an array is ordered composition. Top-level `args` and `defaults` apply to composed steps unless a step defines private values. The command-template default timeout applies automatically. Legacy configs may still use `pipe` as a local alias.

`defaults` may provide additional placeholder values such as `{lang}` or `{model}`. `args` is only a string-array declaration of supported placeholders; defaults belong in `defaults` or inline placeholders such as `{lang=ru}`. Examples prefer explicit flag-style CLIs such as `--file {file}` and `--lang {lang=ru}` for readability, but positional forms such as `/path/to/stt {file} {lang=ru} {model=voxtral-mini-latest}` are equally valid when the target script supports them.

## Text Handlers

`type: "text"` handlers transform raw Telegram text before prompt construction. Raw Telegram text also has synthetic `mime: "text/plain"`, so a handler can match it with `type: "text"`, `mime: "text/plain"`, `mime: "text/*"`, or `match: "text/plain"`. The source text is provided on stdin and as `{text}`. Successful non-empty stdout replaces the current text and is passed to the next matching text handler. Empty stdout, non-zero exit, or handler failure keeps the previous text and records diagnostics.

Built-in placeholders for text handlers:

| Placeholder | Value        |
| ----------- | ------------ |
| `{text}`    | Current text |
| `{mime}`    | `text/plain` |
| `{type}`    | `text`       |

## Media/File Handlers

Media/file handlers keep the legacy attachment-handler behavior: downloaded files are matched by `mime`, `type`, or `match`, then each file runs the first successful matching handler. Downloaded files with `mime: "text/plain"` or any `text/*` MIME type have a built-in fail-open handler that reads UTF-8 content into `[outputs]` when no configured handler produced output. Composition is useful for pipelines such as voice transcription followed by machine translation, so the agent receives translated `[outputs]` instead of the raw STT language.

Built-in placeholders for media/file handlers:

| Placeholder | Value                                                            |
| ----------- | ---------------------------------------------------------------- |
| `{file}`    | Full local path to the downloaded file                           |
| `{mime}`    | MIME type if known                                               |
| `{type}`    | Attachment kind such as `voice`, `audio`, `document`, or `photo` |
| `{text}`    | Empty string                                                     |

If a top-level one-step media handler template has no `{file}` placeholder, the downloaded file path is appended as the last command arg as a one-step handler convenience. Composition steps are plain command templates and do not receive implicit file-path args; include `{file}` explicitly where needed.

## Ordered Fallbacks

A handler list is ordered. For each downloaded file, matching media/file handlers run in list order and stop after the first successful handler. A composed handler counts as one handler for fallback purposes: if any step fails, the next matching handler is tried.

If a matching handler fails with a non-zero exit code, the runtime records diagnostics and tries the next matching handler. If every matching handler fails, the attachment remains visible in the prompt as a normal local file reference.

## Prompt Output

Local attachments stay in the prompt under `[attachments] <directory>` with relative file entries. Successful media/file handler stdout is added under `[outputs]`. For composed media/file handlers, each step receives the previous step's stdout on stdin by default, and stdout from the last successful step is used as the handler output. Empty output and failed handler output are omitted from the prompt text.

Text handler output replaces the prompt text directly and is not duplicated under `[outputs]`.
