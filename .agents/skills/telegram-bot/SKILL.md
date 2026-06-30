---
name: telegram-bot
description: Local Telegram Bot API reference lookup for bot transport, updates, forum topics, Rich Messages, media/files, callbacks, reactions, and Bot API method capability checks.
metadata:
  version: 1.0.0
---

# Telegram Bot API Reference Skill

Use this skill when implementation or review depends on Telegram Bot API details: update shapes, method parameters, response objects, forum topic/thread support, Rich Messages, files/media, callback queries, reactions, or Bot API error semantics.

The local reference is `api.md` in this skill directory. Treat it as vendored reference material: search it, cite the relevant anchor or section in reasoning, but do not reshape it for prose style.

## Lookup Protocol

Use the reference through multiple indexing dimensions. Do not rely on only one navigation mode.

1. Start with the task-shaped index below to choose a likely region.
2. Use line ranges when the region is known. Line references use an `L` prefix (`L393`, `L1000`) to make them visually distinct from anchors, ids, and limits. When calling `read`, drop the prefix: `L393` means `offset: 393`.
3. Use substring search for exact fields, methods, and error text. Prefer exact symbols with `rg`, for example `rg "message_thread_id|sendChatAction|ForumTopic" .agents/skills/telegram-bot/api.md`.
4. Use anchors as a semantic cross-check. Bot API method/type names usually map to Markdown anchors by lowercasing the name: `sendRichMessageDraft` -> `#sendrichmessagedraft`, `MessageReactionUpdated` -> `#messagereactionupdated`.
5. Read only the relevant section around the match. If a section is large, read the first lines for the field table, then search inside the section for the exact field.
6. Verify both sides of a feature:
   - Inbound shape: `Update`, `Message`, `CallbackQuery`, reaction/update object, etc.
   - Outbound capability: send/edit/delete/answer method parameters and return type.
7. Distinguish documented capability from live-client behavior. If the reference says a parameter exists but client UX is uncertain, mark it as a live/manual verification item.
8. Keep project docs concise. Link to this skill/reference for capability evidence; do not duplicate large Bot API tables in operator docs.

## Reading By Line Range

`api.md` is large vendored reference material. Use these line bands to jump directly to useful blocks:

- `L1-L132` — Recent Bot API changelog entries; useful for new capabilities such as Rich Messages and guest mode.
- `L133-L179` — Authorization, request formats, response envelope, and local Bot API server behavior.
- `L180-L285` — Updates, `Update`, `getUpdates`, webhooks, and webhook info.
- `L286-L318` — Start of available types, including `User`.
- `L319-L392` — `Chat` and `ChatFullInfo`.
- `L393-L614` — `Message`, message ids, inaccessible messages, entities, quotes, replies, origins, and reply parameters.
- `L668-L805` — Core media message objects: photo, animation, audio, document, live photo, video, video note, voice.
- `L1267-L1302` — Forum-topic service message objects.
- `L1493-L1569` — Link preview, direct-message/topic helpers, profiles, and `File`.
- `L1573-L1751` — Keyboards, inline keyboard buttons, callback queries, force replies.
- `L1821-L1957` — Chat member updates, members, join requests, permissions.
- `L2142-L2219` — Reaction types/counts, reaction updates, and `ForumTopic`.
- `L2764-L2797` — Guest replies, prepared inline messages, response parameters.
- `L2798-L2956` — `InputMedia*` variants and `InputFile`.
- `L3054-L3124` — Sending files notes, colors, and inline mode object prelude.
- `L3125-L3836` — Main send methods: `sendMessage`, formatting, media sends, albums, polls, drafts, chat actions, reactions.
- `L3847-L4307` — File download, chat moderation/management, forum topic lifecycle.
- `L4308-L4834` — Callback/guest answers, bot metadata, gifts/business/story/web app/prepared inline methods.
- `L4835-L5020` — Updating/deleting messages and reaction deletion.
- `L5021-L5242` — Stickers.
- `L5243-L6116` — Rich Messages formatting, send/draft methods, `RichText*`, and `RichBlock*`.
- `L6117-L6662` — Inline mode, inline query answers/results, and `InputMessageContent` variants.
- `L6663-L7054` — Payments and stars.
- `L7055-L7230` — Telegram Passport.
- `L7231-L7306` — Games.

For exact section boundaries, run:

```bash
rg -n "^(###|####) " .agents/skills/telegram-bot/api.md
```

## Freshness-First Lens

The highest-value use of this skill is not generic Telegram bot knowledge. Models often already know older Bot API concepts. The local `api.md` is most valuable for **new or recently changed Bot API surface** that may be absent, stale, or hallucinated in model training data.

Before relying on prior knowledge, check the freshness layer when work touches newly evolving areas such as Rich Messages, guest mode, managed bots, forum/thread behavior, reactions, drafts, business/gift/story APIs, paid media, or new update fields.

### Freshness protocol

1. Read the recent changelog first: `L1-L132` (`offset: 1, limit: 132`).
2. Extract the exact new symbols mentioned there: method names, class names, fields, parameters.
3. Search each symbol in the full reference before designing code: `rg -n "sendRichMessageDraft|guest_query_id|message_thread_id" .agents/skills/telegram-bot/api.md`.
4. Compare old intuition against the local reference. If they differ, trust `api.md` and note the delta.
5. When adding support for a fresh symbol, verify all three surfaces when applicable:
   - Changelog mention: what changed and in which Bot API version.
   - Type/method definition: exact field/parameter shape.
   - Runtime route: which `Update` or method response can carry it.
6. Treat unobserved client behavior as live-gated even when the Bot API surface is documented.

### Recent-surface index

- `L1-L35` — Bot API 10.1, Rich Messages, join request queries, poll media links.
- `L36-L91` — Bot API 10.0, guest mode, reaction deletion methods, live photos, managed bot access settings, empty drafts.
- `L92-L132` — Bot API 9.6, managed bots, prepared keyboard buttons, poll/checklist/date-time changes.

Use this lens when a task asks “does Telegram support X now?”, “why is this update field unknown?”, “can we use this new method?”, or when a capability sounds newer than common bot knowledge.

## Task-Oriented Lookup Recipes

Use these recipes when the user asks a product/runtime question rather than naming an exact Bot API symbol.

### Preserve forum topic/thread routing

1. Search: `rg -n "message_thread_id|is_topic_message|ForumTopic" .agents/skills/telegram-bot/api.md`.
2. Read `Message`: `L393-L532` (`offset: 393, limit: 140`).
3. Read forum topic objects: `L1267-L1306` and `L2142-L2231`.
4. Read relevant outbound methods: `sendMessage` at `L3142`, media sends at `L3385-L3630`, drafts/actions at `L3778-L3805`, Rich sends at `L5545-L5574`.
5. Treat missing thread metadata on secondary update types as a reason to use stored message ownership rather than inventing fields.

### Route callbacks from inline buttons

1. Read inline keyboard/button types: `L1670-L1739`.
2. Read `CallbackQuery`: `L1735-L1759`.
3. Read `answerCallbackQuery`: `L4308-L4327`.
4. Cross-check whether callback `message` has enough chat/thread metadata; if not, join with local message ownership.

### Handle reactions safely

1. Read reaction types and updates: `L2142-L2221`.
2. Search: `rg -n "message_reaction|allowed_updates|deleteMessageReaction|setMessageReaction" .agents/skills/telegram-bot/api.md`.
3. Read `getUpdates` allowed updates: `L220-L234`.
4. Read reaction methods: `L3806-L3825` and `L5000-L5021`.
5. Check admin/allowed-update requirements before assuming reactions arrive.

### Send or download files/media

1. Read upload/download contracts: `L2953-L2977` and `L3847-L3858`.
2. Read local Bot API server limits: `L163-L179`.
3. Read the concrete send method: photos `L3385`, documents `L3462`, voice `L3545`, albums `L3614`, stickers `L5082`.
4. For inbound attachments, map `Message` media fields to `File`/`getFile` before modeling download behavior.

### Use Rich Messages and drafts

1. Read Rich Message overview and formatting examples: `L5243-L5352`.
2. Read send/draft methods: `L5545-L5574`.
3. Read `RichText`/`RichBlock` unions: `L5575-L5619` and `L5880-L5924`.
4. Search for the exact primitive: `rg -n "RichBlockThinking|RichBlockMathematicalExpression|RichBlockPreformatted|RichBlockDetails" .agents/skills/telegram-bot/api.md`.
5. Mark client rendering/draft UX as live verification unless already observed.

### Answer guest or inline queries

1. Read guest message fields on `Message`: `L393-L532`, then search `guest_query_id`.
2. Read `SentGuestMessage`: `L2764-L2778`.
3. Read `answerGuestQuery`: `L4322-L4331`.
4. For inline mode, read `L6117-L6186` and `InputMessageContent` at `L6553`.

## Cross-Cutting Field Matrix

| Field/capability | Read first | Then verify on methods |
| --- | --- | --- |
| `message_thread_id` | `Message` `L393-L514`, `ForumTopic` `L2210-L2219` | `sendMessage`, media sends, `sendMediaGroup`, `sendMessageDraft`, `sendChatAction`, Rich sends/drafts |
| `reply_parameters` | `ReplyParameters` `L600-L615` | Send/copy/forward methods that attach replies |
| `reply_markup` | `InlineKeyboardMarkup` `L1670-L1677` | Send/edit methods and callback routing |
| `rich_message` | `Message` `L393-L514`, `RichMessage` `L5525-L5533` | `sendRichMessage`, `sendRichMessageDraft`, `editMessageText` |
| `guest_query_id` | `Message` `L393-L514`, `SentGuestMessage` `L2764-L2771` | `answerGuestQuery` |
| `allowed_updates` | `getUpdates` `L220-L234`, `setWebhook` `L235-L257` | Reaction/chat-member update assumptions |
| File id/path | `File` `L1560-L1569`, `InputFile` `L2953-L2956` | `getFile`, concrete send methods, local Bot API server limits |
| Reactions | `ReactionType*` / `MessageReaction*` `L2142-L2209` | `setMessageReaction`, `deleteMessageReaction`, `deleteAllMessageReactions` |

## Risk And Live-Verification Index

Treat these as high-friction zones where the reference is necessary but may not be sufficient:

- Polling/webhook exclusivity: `getUpdates` cannot run while a webhook is set.
- `allowed_updates`: reactions and chat-member style updates often require explicit opt-in and sometimes admin rights.
- Forum topics: documented `message_thread_id` support does not prove every update shape carries thread context.
- Deleted/stale topics: classify errors narrowly and keep live smoke coverage for actual Telegram error text.
- Rich drafts: Bot API method existence does not settle per-client draft UX.
- File transport: cloud Bot API and local Bot API server have materially different upload/download limits.
- Callback/reaction routing: if an update lacks target metadata, prefer durable sent-message ownership over guessing.

## Search Synonym Index

- Topic/forum/thread: `ForumTopic`, `message_thread_id`, `is_topic_message`, `createForumTopic`.
- Button/menu/callback: `InlineKeyboardMarkup`, `InlineKeyboardButton`, `CallbackQuery`, `answerCallbackQuery`, `callback_data`.
- Attachment/file/download/upload: `InputFile`, `File`, `getFile`, `file_id`, `file_path`, `sendDocument`, `sendPhoto`.
- Draft/streaming preview: `sendMessageDraft`, `sendRichMessageDraft`, `RichBlockThinking`.
- Rich Markdown/native rendering: `RichMessage`, `InputRichMessage`, `RichText`, `RichBlock`, `sendRichMessage`.
- Reaction/emoji shortcut: `ReactionType`, `MessageReactionUpdated`, `setMessageReaction`, `deleteMessageReaction`.
- Guest/inline response: `guest_message`, `guest_query_id`, `answerGuestQuery`, `InlineQuery`, `InputMessageContent`.

## Anchor And Topic Index

### Transport And Request Basics

- `#authorizing-your-bot` — Bot token basics.
- `#making-requests` — HTTP methods, JSON/form/multipart request formats, response envelope.
- `#using-a-local-bot-api-server` — Local server behavior, larger upload/download limits, local file paths.

### Updates And Routing

- `#getting-updates` — Long polling vs webhooks.
- `#update` — Top-level inbound update union.
- `#getupdates` — Long polling method and `allowed_updates`.
- `#setwebhook` / `#deletewebhook` — Webhook setup and removal.
- `#message` — Main message object; check `message_thread_id`, `is_topic_message`, media, `rich_message`, guest fields.
- `#callbackquery` — Button callback payload and callback message metadata.
- `#messagereactionupdated` / `#messagereactioncountupdated` — Reaction updates and their available routing fields.

### Chats, Forums, And Thread Targets

- `#chat` / `#chatfullinfo` — Chat shape, including forum-related fields.
- `#forumtopic` — Forum topic response object.
- `#createforumtopic` — Topic provisioning and returned `message_thread_id`.
- `#editforumtopic`, `#closeforumtopic`, `#reopenforumtopic`, `#deleteforumtopic`, `#unpinallforumtopicmessages` — Topic lifecycle.
- Search `message_thread_id` — Thread target support across send, edit, media, draft, and action methods.

### Sending, Editing, Drafts, And Chat Actions

- `#sendmessage` — Text messages and thread targeting.
- `#editmessagetext` — Editing text/rich messages.
- `#deletemessage` / `#deletemessages` — Deletion semantics.
- `#sendchataction` — Typing/upload action support, including thread targeting.
- `#sendmessagedraft` — Plain draft behavior.
- `#sendrichmessage` / `#sendrichmessagedraft` — Native Rich Message send/streaming draft APIs.

### Rich Messages

- `#rich-messages` — Bot API changelog entry for Rich Messages.
- `#richmessage` / `#inputrichmessage` / `#inputrichmessagecontent` — Rich message payload objects.
- `#richblock` / `#richtext` — Rich block/text unions.
- Search `RichBlockThinking`, `RichBlockMathematicalExpression`, `RichBlockPreformatted`, `RichBlockTable`, `RichBlockDetails` for specific rendering primitives.

### Files, Media, And Albums

- `#inputfile` — Upload contract.
- `#getfile` — File download metadata.
- `#sendphoto`, `#senddocument`, `#sendvoice`, `#sendaudio`, `#sendvideo`, `#sendanimation`, `#sendsticker` — Common media sends.
- `#sendmediagroup` — Album/grouped media behavior.
- Search `InputMedia` for per-media payload variants.

### Buttons, Inline Mode, Guest Replies

- `#inlinekeyboardmarkup` / `#inlinekeyboardbutton` — Inline button markup.
- `#answercallbackquery` — Callback acknowledgement.
- `#inlinequery`, `#answerinlinequery`, `#inputmessagecontent` — Inline mode.
- `#answerguestquery` / `#sentguestmessage` — Guest message replies.

### Errors And Edge Semantics

- `#responseparameters` — Retry/migration hints in failed responses.
- Search exact Telegram error text when modeling stale topic, deleted message, migration, or permission behavior.
- Prefer narrow error classification in code; broad string matching should be justified and covered by tests.

## Output Expectations

When this skill informs a code or documentation change, summarize the Bot API evidence in one sentence and name the anchor or symbol used. Example: `Bot API evidence: sendChatAction accepts message_thread_id, so chat actions can preserve forum targets.`
