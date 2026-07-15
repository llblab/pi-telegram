---
name: telegram-bot
description: Local Telegram Bot API reference lookup for bot transport, updates, forum topics, Rich and Ephemeral Messages, Communities, media/files, callbacks, reactions, and Bot API method capability checks.
metadata:
  version: 1.1.0
---

# Telegram Bot API Reference Skill

Use this skill when implementation or review depends on Telegram Bot API details: update shapes, method parameters, response objects, forum topic/thread support, Rich Messages, files/media, callback queries, reactions, or Bot API error semantics.

The local reference is `api.md` in this skill directory. Treat it as vendored reference material: search it, cite the relevant anchor or section in reasoning, but do not reshape it for prose style.

The authoritative upstream surfaces are the full [Bot API reference](https://core.telegram.org/bots/api) and the complete [Bot API changelog](https://core.telegram.org/bots/api-changelog). Keep `api.md` structurally aligned with the full reference—recent release entries followed by API sections, object tables, and methods—and cross-check every freshness update against the changelog. Do not replace the established full-reference structure with a changelog-only excerpt.

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

- `L1-L130` — Recent Bot API changelog entries for 10.2, 10.1, and 10.0; useful for Rich Messages, Ephemeral Messages, Communities, and guest mode.
- `L131-L177` — Authorization, request formats, response envelope, and local Bot API server behavior.
- `L178-L278` — Updates, `Update`, subscriptions, `getUpdates`, webhooks, and webhook info.
- `L279-L386` — Start of available types: `User`, `Chat`, and `ChatFullInfo`, including community membership.
- `L387-L666` — `Message`, ephemeral/receiver fields, message ids, entities, quotes, replies, origins, and reply parameters.
- `L667-L804` — Core media message objects: photo, animation, audio, document, live photo, video, video note, voice.
- `L1119-L1149` — Subscription and dynamic poll-option update objects.
- `L1276-L1320` — Community and forum-topic service message objects.
- `L1514-L1589` — Link preview, direct-message/topic helpers, profiles, and `File`.
- `L1691-L1788` — Keyboards, inline keyboard buttons, callback queries, force replies, and `Community`.
- `L1851-L1990` — Chat member updates, members, join requests, permissions, and ephemeral command metadata.
- `L2172-L2250` — Reaction types/counts, reaction updates, and `ForumTopic`.
- `L2795-L2828` — Guest replies, prepared inline messages, and response parameters.
- `L2829-L3006` — `InputMedia*` variants, including `InputMediaVoiceNote`, and `InputFile`.
- `L3086-L3168` — Sending files notes, colors, and method prelude.
- `L3169-L3924` — Main send methods: `sendMessage`, ephemeral recipient parameters, media sends, albums, polls, drafts, chat actions, and reactions.
- `L3935-L4395` — File download, chat moderation/management, and forum topic lifecycle.
- `L4396-L4922` — Callback/guest answers, bot metadata, gifts/business/story/web app/prepared inline methods.
- `L4923-L5160` — Updating/deleting regular and ephemeral messages and reaction deletion.
- `L5161-L5384` — Stickers.
- `L5385-L6530` — Rich Message formatting, media references, send/draft methods, `RichText*`, `RichBlock*`, and `InputRichBlock*`.
- `L6531-L7074` — Inline mode, inline query answers/results, and `InputMessageContent` variants.
- `L7075-L7466` — Payments and stars.
- `L7467-L7642` — Telegram Passport.
- `L7643-L7730` — Games.

For exact section boundaries, run:

```bash
rg -n "^(###|####) " .agents/skills/telegram-bot/api.md
```

## Freshness-First Lens

The highest-value use of this skill is not generic Telegram bot knowledge. Models often already know older Bot API concepts. The local `api.md` is most valuable for **new or recently changed Bot API surface** that may be absent, stale, or hallucinated in model training data.

Before relying on prior knowledge, check the freshness layer when work touches newly evolving areas such as Rich Messages, guest mode, managed bots, forum/thread behavior, reactions, drafts, business/gift/story APIs, paid media, or new update fields.

### Freshness protocol

1. Read the recent changelog first: `L1-L130` (`offset: 1, limit: 130`).
2. Extract the exact new symbols mentioned there: method names, class names, fields, parameters.
3. Search each symbol in the full reference before designing code: `rg -n "InputRichBlock|ephemeral_message_id|Community|sendRichMessageDraft|guest_query_id|message_thread_id" .agents/skills/telegram-bot/api.md`.
4. Compare old intuition against the local reference. If they differ, trust `api.md` and note the delta.
5. When adding support for a fresh symbol, verify all three surfaces when applicable:
   - Changelog mention: what changed and in which Bot API version.
   - Type/method definition: exact field/parameter shape.
   - Runtime route: which `Update` or method response can carry it.
6. Treat unobserved client behavior as live-gated even when the Bot API surface is documented.

### Recent-surface index

- `L1-L37` — Bot API 10.2: outgoing Rich Message blocks/media, voice-note media, Ephemeral Messages, Communities, subscription updates, and Mini App origin hardening.
- `L38-L72` — Bot API 10.1: initial Rich Messages, join request queries, and poll media links.
- `L73-L130` — Bot API 10.0: guest mode, reaction deletion methods, live photos, managed bot access settings, and empty drafts.

Use this lens when a task asks “does Telegram support X now?”, “why is this update field unknown?”, “can we use this new method?”, or when a capability sounds newer than common bot knowledge.

## Task-Oriented Lookup Recipes

Use these recipes when the user asks a product/runtime question rather than naming an exact Bot API symbol.

### Preserve forum topic/thread routing

1. Search: `rg -n "message_thread_id|is_topic_message|ForumTopic" .agents/skills/telegram-bot/api.md`.
2. Read `Message`: `L387-L513` (`offset: 387, limit: 127`).
3. Read forum topic objects: `L1288-L1320` and `L2172-L2250`.
4. Read relevant outbound methods: `sendMessage` at `L3185`, media sends at `L3451-L3714`, drafts/actions at `L3866-L3907`, Rich sends at `L5713-L5749`.
5. Treat missing thread metadata on secondary update types as a reason to use stored message ownership rather than inventing fields.

### Route callbacks from inline buttons

1. Read inline keyboard/button types: `L1691-L1755`.
2. Read `CallbackQuery`: `L1756-L1780`.
3. Read `answerCallbackQuery`: `L4396-L4409`.
4. Cross-check whether callback `message` has enough chat/thread metadata; if not, join with local message ownership.

### Handle reactions safely

1. Read reaction types and updates: `L2172-L2250`.
2. Search: `rg -n "message_reaction|allowed_updates|deleteMessageReaction|setMessageReaction" .agents/skills/telegram-bot/api.md`.
3. Read `getUpdates` allowed updates: `L218-L230`.
4. Read reaction methods around `L3907` and `L5139`.
5. Check admin/allowed-update requirements before assuming reactions arrive.

### Send or download files/media

1. Read upload/download contracts: `L2997-L3025` and `L3935-L3947`.
2. Read local Bot API server limits: `L161-L177`.
3. Read the concrete send method: photos `L3451`, documents `L3534`, voice `L3623`, albums `L3696`, stickers around `L5219`.
4. For inbound attachments, map `Message` media fields to `File`/`getFile` before modeling download behavior.

### Use Rich Messages and drafts

1. Read Rich Message overview and formatting examples: `L5385-L5524`.
2. Read `InputRichMessage`, media references, and send/draft methods: `L5691-L5749`.
3. Read incoming `RichText`/`RichBlock` unions around `L5750-L6284` and outgoing `InputRichBlock*` at `L6285-L6530`.
4. Search for the exact primitive: `rg -n "InputRichBlockThinking|InputRichBlockMathematicalExpression|InputRichBlockPreformatted|InputRichBlockDetails|InputRichMessageMedia" .agents/skills/telegram-bot/api.md`.
5. Mark client rendering/draft UX as live verification unless already observed.

### Use Ephemeral Messages safely

1. Read the 10.2 changelog delta at `L13-L24`.
2. Read `Message.receiver_user` / `ephemeral_message_id` at `L387-L513` and `ReplyParameters` at `L598-L614`.
3. Verify recipient parameters on each concrete send method; do not assume every send method supports ephemeral delivery.
4. Read ephemeral edit methods at `L5040-L5094` and deletion at `L5130-L5138`.
5. Treat `message_id: 0` plus `ephemeral_message_id` as a distinct ownership identity; never route edit/delete through ordinary message-id ownership.

### Observe Communities without changing routing policy

1. Read the 10.2 changelog delta at `L25-L32`.
2. Read `ChatFullInfo.community` around `L327-L386`, service messages at `L1276-L1287`, and `Community` at `L1789-L1798`.
3. Treat community updates as observations until a product-level routing policy exists; a Community is not automatically a forum/thread target or a replacement for private-chat Threaded Mode.

### Answer guest or inline queries

1. Read guest message fields on `Message`: `L387-L513`, then search `guest_query_id`.
2. Read `SentGuestMessage`: `L2795-L2808`.
3. Read `answerGuestQuery`: `L4410-L4421`.
4. For inline mode, read `L6531-L6599` and search `InputMessageContent`.

## Cross-Cutting Field Matrix

| Field/capability | Read first | Then verify on methods |
| --- | --- | --- |
| `message_thread_id` | `Message` `L387-L513`, `ForumTopic` around `L2240` | `sendMessage`, media sends, `sendMediaGroup`, `sendMessageDraft`, `sendChatAction`, Rich sends/drafts |
| `reply_parameters` | `ReplyParameters` `L598-L614` | Send/copy/forward methods that attach replies |
| `reply_markup` | `InlineKeyboardMarkup` `L1691-L1698` | Send/edit methods and callback routing |
| `rich_message` | `Message` `L387-L513`, `RichMessage` `L5682-L5690` | `sendRichMessage`, `sendRichMessageDraft`, `editMessageText` |
| Rich outgoing blocks/media | `InputRichMessage` / `InputRichMessageMedia` `L5691-L5712`, `InputRichBlock*` `L6285-L6530` | `sendRichMessage`, `sendRichMessageDraft`, `editMessageText` |
| Ephemeral identity | `Message` `L387-L513`, `ReplyParameters` `L598-L614` | Supported send methods, `editEphemeralMessage*`, `deleteEphemeralMessage` |
| Community membership | `ChatFullInfo` `L327-L386`, `Community` `L1789-L1798` | `community_chat_added`, `community_chat_removed` observations |
| `guest_query_id` | `Message` `L387-L513`, `SentGuestMessage` `L2795-L2808` | `answerGuestQuery` |
| `allowed_updates` | `getUpdates` `L218-L230`, `setWebhook` `L231-L250` | Reaction/chat-member/subscription update assumptions |
| File id/path | `File` `L1581-L1590`, `InputFile` `L2997-L3006` | `getFile`, concrete send methods, local Bot API server limits |
| Reactions | `ReactionType*` / `MessageReaction*` `L2172-L2239` | `setMessageReaction`, `deleteMessageReaction`, `deleteAllMessageReactions` |

## Risk And Live-Verification Index

Treat these as high-friction zones where the reference is necessary but may not be sufficient:

- Polling/webhook exclusivity: `getUpdates` cannot run while a webhook is set.
- `allowed_updates`: reactions and chat-member style updates often require explicit opt-in and sometimes admin rights.
- Forum topics: documented `message_thread_id` support does not prove every update shape carries thread context.
- Deleted/stale topics: classify errors narrowly and keep live smoke coverage for actual Telegram error text.
- Rich drafts and blocks: Bot API method/type existence does not settle per-client rendering, editing, or media-composition UX.
- Ephemeral messages: ordinary `message_id` ownership does not substitute for receiver-scoped `ephemeral_message_id` ownership.
- Communities: community membership signals do not define bridge routing, authorization, or leader-election policy.
- File transport: cloud Bot API and local Bot API server have materially different upload/download limits.
- Callback/reaction routing: if an update lacks target metadata, prefer durable sent-message ownership over guessing.

## Search Synonym Index

- Topic/forum/thread: `ForumTopic`, `message_thread_id`, `is_topic_message`, `createForumTopic`.
- Button/menu/callback: `InlineKeyboardMarkup`, `InlineKeyboardButton`, `CallbackQuery`, `answerCallbackQuery`, `callback_data`.
- Attachment/file/download/upload: `InputFile`, `File`, `getFile`, `file_id`, `file_path`, `sendDocument`, `sendPhoto`.
- Draft/streaming preview: `sendMessageDraft`, `sendRichMessageDraft`, `RichBlockThinking`, `InputRichBlockThinking`.
- Rich Markdown/native rendering: `RichMessage`, `InputRichMessage`, `InputRichMessageMedia`, `RichText`, `RichBlock`, `InputRichBlock`, `sendRichMessage`.
- Ephemeral/private-to-user group response: `receiver_user`, `receiver_user_id`, `ephemeral_message_id`, `editEphemeralMessage`, `deleteEphemeralMessage`.
- Community: `Community`, `community`, `community_chat_added`, `community_chat_removed`.
- Subscription: `BotSubscriptionUpdated`, `subscription`.
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
- `#message` — Main message object; check `message_thread_id`, `is_topic_message`, media, `rich_message`, guest, receiver, ephemeral, and community service fields.
- `#botsubscriptionupdated` — User payment subscription update payload.
- `#callbackquery` — Button callback payload and callback message metadata.
- `#messagereactionupdated` / `#messagereactioncountupdated` — Reaction updates and their available routing fields.

### Chats, Forums, Communities, And Thread Targets

- `#chat` / `#chatfullinfo` — Chat shape, including forum and community fields.
- `#community`, `#communitychatadded`, `#communitychatremoved` — Community identity and membership service objects.
- `#forumtopic` — Forum topic response object.
- `#createforumtopic` — Topic provisioning and returned `message_thread_id`.
- `#editforumtopic`, `#closeforumtopic`, `#reopenforumtopic`, `#deleteforumtopic`, `#unpinallforumtopicmessages` — Topic lifecycle.
- Search `message_thread_id` — Thread target support across send, edit, media, draft, and action methods.

### Sending, Editing, Drafts, And Chat Actions

- `#sendmessage` — Text messages and thread targeting.
- `#editmessagetext` — Editing text/rich messages.
- `#editephemeralmessagetext`, `#editephemeralmessagemedia`, `#editephemeralmessagecaption`, `#editephemeralmessagereplymarkup` — Receiver-scoped ephemeral edits.
- `#deletemessage` / `#deletemessages` — Ordinary deletion semantics.
- `#deleteephemeralmessage` — Ephemeral deletion semantics.
- `#sendchataction` — Typing/upload action support, including thread targeting.
- `#sendmessagedraft` — Plain draft behavior.
- `#sendrichmessage` / `#sendrichmessagedraft` — Native Rich Message send/streaming draft APIs.

### Rich Messages

- `#rich-messages` — Bot API changelog entry for Rich Messages.
- `#richmessage` / `#inputrichmessage` / `#inputrichmessagecontent` — Rich message payload objects.
- `#inputrichmessagemedia` — Media referenced from Rich Markdown/HTML.
- `#richblock` / `#richtext` — Incoming rich block/text unions.
- `#inputrichblock` / `#inputrichblocklistitem` — Outgoing explicit block unions and list items.
- Search `InputRichBlockThinking`, `InputRichBlockMathematicalExpression`, `InputRichBlockPreformatted`, `InputRichBlockTable`, `InputRichBlockDetails` for outgoing rendering primitives.

### Files, Media, And Albums

- `#inputfile` — Upload contract.
- `#getfile` — File download metadata.
- `#sendphoto`, `#senddocument`, `#sendvoice`, `#sendaudio`, `#sendvideo`, `#sendanimation`, `#sendsticker` — Common media sends.
- `#sendmediagroup` — Album/grouped media behavior.
- Search `InputMedia` for per-media payload variants, including `InputMediaVoiceNote`.

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
