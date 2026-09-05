---
name: telegram-bot
description: Local Telegram Bot API reference lookup for bot transport, updates, forum topics, Rich and Ephemeral Messages, Communities, media/files, callbacks, reactions, and Bot API method capability checks.
metadata:
  version: 1.2.1
---

# Telegram Bot API Reference Skill

Use this skill when implementation or review depends on Telegram Bot API details: update shapes, method parameters, response objects, forum topic/thread support, Rich Messages, files/media, callback queries, reactions, or Bot API error semantics.

The local reference is `api.md` in this skill directory. Treat it as vendored reference material: search it, cite the relevant anchor or section in reasoning, but do not reshape it for prose style. Never read the complete file directly or load broad sequential chunks into model context; use this skill's indexes, exact-symbol search, anchors, and the smallest relevant line range.

The authoritative upstream surfaces are the full [Bot API reference](https://core.telegram.org/bots/api) and the complete [Bot API changelog](https://core.telegram.org/bots/api-changelog). Keep `api.md` structurally aligned with the full reference—recent release entries followed by API sections, object tables, and methods—and cross-check every freshness update against the changelog. Do not replace the established full-reference structure with a changelog-only excerpt.

## Lookup Protocol

Use the reference through multiple indexing dimensions. Do not rely on only one navigation mode.

1. Start with the task-shaped index below to choose a likely region. Do not begin by reading `api.md` itself.
2. Use line ranges when the region is known. Line references use an `L` prefix (`L434`, `L1770`) to make them visually distinct from anchors, ids, and limits. When calling `read`, drop the prefix: `L434` means `offset: 434`.
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

- `L1-L167` — Recent Bot API changelog entries for 10.3, 10.2, 10.1, and 10.0.
- `L168-L325` — Authorization, request formats, updates, polling, and webhooks.
- `L326-L685` — Core types: `User`, `Chat`, `ChatFullInfo`, `Message`, replies, and `EphemeralMessageParameters`.
- `L1175-L1405` — Subscription, generation-stopped, Community, checklist, and forum-topic service-update objects.
- `L1655-L1889` — `File`, keyboards, callbacks, disabled buttons, force replies, and `Community`.
- `L1918-L2035` — Administrator rights and members, including welcome-message permission.
- `L2265-L2342` — Reactions and `ForumTopic`.
- `L2925-L3115` — `InputMedia*` variants and `InputFile`.
- `L3265-L4028` — Main send methods, ephemeral parameters, drafts, chat actions, and reactions.
- `L4029-L4490` — File download, chat management, and forum topic lifecycle.
- `L4491-L5019` — Callback/guest answers, bot metadata, gifts/business/story/web app/prepared inline methods.
- `L5020-L5269` — Updating/deleting regular and ephemeral messages and reaction deletion.
- `L5270-L5496` — Stickers.
- `L5497-L6806` — Rich Message formatting, buttons/documents/expandable quotations, send/draft methods, `RichText*`, `RichBlock*`, and `InputRichBlock*`.
- `L6807-L7354` — Inline mode and `InputMessageContent` variants.
- `L7355-L7746` — Payments and stars.
- `L7747-L7922` — Telegram Passport.
- `L7923-L8011` — Games.

For exact section boundaries, run:

```bash
rg -n "^(###|####) " .agents/skills/telegram-bot/api.md
```

## Freshness-First Lens

The highest-value use of this skill is not generic Telegram bot knowledge. Models often already know older Bot API concepts. The local `api.md` is most valuable for **new or recently changed Bot API surface** that may be absent, stale, or hallucinated in model training data.

Before relying on prior knowledge, check the freshness layer when work touches newly evolving areas such as Rich Messages, guest mode, managed bots, forum/thread behavior, reactions, drafts, business/gift/story APIs, paid media, or new update fields.

### Freshness protocol

1. Read the recent changelog first: `L1-L167` (`offset: 1, limit: 167`).
2. Extract the exact new symbols mentioned there: method names, class names, fields, parameters.
3. Search each symbol in the full reference before designing code: `rg -n "EphemeralMessageParameters|MessageGenerationStopped|DisabledButton|InputRichBlock|CommunityChatJoined|sendRichMessageDraft|message_thread_id" .agents/skills/telegram-bot/api.md`.
4. Compare old intuition against the local reference. If they differ, trust `api.md` and note the delta.
5. When adding support for a fresh symbol, verify all three surfaces when applicable:
   - Changelog mention: what changed and in which Bot API version.
   - Type/method definition: exact field/parameter shape.
   - Runtime route: which `Update` or method response can carry it.
6. Treat unobserved client behavior as live-gated even when the Bot API surface is documented.
7. When a lookup reveals a concrete reference error, verify the exact upstream method/type and changelog, then correct the local section and affected line indexes. A current changelog header alone does not prove the method tables are current; keep fixes scoped to verified discrepancies.

### Recent-surface index

- `L1-L37` — Bot API 10.3: Rich Message buttons/documents/expandable quotations, consolidated ephemeral parameters, disabled/force-reply controls, generation-stop updates, and community joins.
- `L38-L74` — Bot API 10.2: outgoing Rich Message blocks/media, Ephemeral Messages, Communities, subscription updates, and Mini App origin hardening.
- `L75-L109` — Bot API 10.1: initial Rich Messages, join request queries, and poll media links.
- `L110-L167` — Bot API 10.0: guest mode, reaction deletion, poll media, live photos, managed bots, and empty drafts.

Use this lens when a task asks “does Telegram support X now?”, “why is this update field unknown?”, “can we use this new method?”, or when a capability sounds newer than common bot knowledge.

## Task-Oriented Lookup Recipes

Use these recipes when the user asks a product/runtime question rather than naming an exact Bot API symbol.

### Preserve forum topic/thread routing

1. Search: `rg -n "message_thread_id|is_topic_message|ForumTopic" .agents/skills/telegram-bot/api.md`.
2. Read `Message`: `L434-L645` (`offset: 434, limit: 212`).
3. Read forum topic service objects at `L1362-L1405` and `ForumTopic` at `L2333`.
4. Read relevant outbound methods: `sendMessage` at `L3282`, media sends at `L3554-L3791`, drafts/actions around `L3958`, Rich sends/drafts at `L5890-L5922`.
5. Treat missing thread metadata on secondary update types as a reason to use stored message ownership rather than inventing fields.

### Route callbacks from inline buttons

1. Read inline keyboard/button types: `L1770-L1846`.
2. Read `CallbackQuery`: `L1847-L1871`.
3. Read `answerCallbackQuery` at `L4491`.
4. Cross-check whether callback `message` has enough chat/thread metadata; if not, join with local message ownership.
5. Rich Message buttons also use `CallbackQuery.data`; do not require `message.reply_markup` as proof that a callback is valid. For in-body rows, look up `RichMessageButton` and `InputRichBlockButtons` by symbol: a native Rich row contains 1–8 buttons. Keep bridge JSON/CML wrappers and placement policy with the bridge Skill, not this API reference.

### Handle reactions safely

1. Read reaction types and updates: `L2265-L2332`.
2. Search: `rg -n "message_reaction|allowed_updates|deleteMessageReaction|setMessageReaction" .agents/skills/telegram-bot/api.md`.
3. Read `getUpdates` allowed updates at `L257-L273`.
4. Read reaction methods at `L3988-L4007` and around `L5249`.
5. Check admin/allowed-update requirements before assuming reactions arrive.

### Send or download files/media

1. Read upload/download contracts at `InputFile` `L3093-L3102` and `getFile` `L4029-L4041`.
2. Read local Bot API server limits: `L198-L214`.
3. Read the concrete send methods: photos `L3554`, documents `L3634`, voice `L3720`, albums `L3791`, stickers from `L5270`.
4. For inbound attachments, map `Message` media fields to `File`/`getFile` before modeling download behavior.

### Use Rich Messages and drafts

1. Read Rich Message overview and formatting examples: `L5497-L5640`.
2. Read `RichMessage`, `InputRichMessage`, media references, and send/draft methods: `L5859-L5922`.
3. Read incoming `RichText`/`RichBlock` unions around `L5941-L6538` and outgoing `InputRichBlock*` at `L6539-L6806`.
4. Search for the exact primitive: `rg -n "RichMessageButton|RichTextButton|InputRichBlockButtons|InputRichBlockDocument|InputRichBlockExpandableBlockQuotation|InputRichBlockThinking|InputRichMessageMedia" .agents/skills/telegram-bot/api.md`.
5. Mark client rendering/draft UX as live verification unless already observed.

### Use Ephemeral Messages safely

1. Read the 10.3 delta at `L13-L25` and the original 10.2 surface at `L49-L60`.
2. Read `Message.receiver_user` / `ephemeral_message_id` around `L434-L645`, `ReplyParameters` at `L646`, and `EphemeralMessageParameters` at `L663`.
3. Verify `ephemeral_message_parameters` on each concrete send method; the 10.3 object replaces the former top-level `receiver_user_id` and `callback_query_id` parameters.
4. Read ephemeral edit methods at `L5137-L5195` and deletion at `L5239`.
5. Treat `message_id: 0` plus `ephemeral_message_id` as a distinct ownership identity; never route edit/delete through ordinary message-id ownership.

### Handle generation-stop updates and draft controls

1. Read the 10.3 delta at `L31-L36`.
2. Read `Update.stopped_message_generation` around `L221-L256` and `MessageGenerationStopped` at `L1185-L1193`.
3. Verify `can_stop` and `keep_on_stop` independently on `sendMessageDraft` at `L3958` and `sendRichMessageDraft` at `L5910`.
4. Treat the stop update as user intent for the exact generation identified by the payload; do not infer cancellation of unrelated work.

### Use Bot API reply-markup controls

1. Read the 10.3 delta at `L27-L29`.
2. Read `ReplyKeyboardMarkup` at `L1676`, `InlineKeyboardMarkup` at `L1770`, `InlineKeyboardButton` at `L1779`, and `DisabledButton` at `L1843`.
3. Verify whether `force_reply` belongs on the selected markup and whether `disabled` is used instead of an actionable button field.
4. Treat visual behavior and client support as live verification.

### Observe Communities without changing routing policy

1. Read the 10.2 Community delta at `L61-L67` and the 10.3 join delta at `L34`.
2. Read `ChatFullInfo.community` around `L382-L433`, service messages at `L1342-L1365`, and `Community` at `L1880-L1889`.
3. Check all three service fields: `community_chat_added`, `community_chat_removed`, and `community_chat_joined`.
4. Treat community updates as observations until a product-level routing policy exists; a Community is not automatically a forum/thread target or a replacement for private-chat Threaded Mode.

### Answer guest or inline queries

1. Read guest message fields on `Message`: `L434-L645`, then search `guest_query_id`.
2. Read `SentGuestMessage` at `L2891`.
3. Read `answerGuestQuery` at `L4507-L4518`.
4. For inline mode, read `L6807-L7299` and search `InputMessageContent`.

## Cross-Cutting Field Matrix

| Field/capability | Read first | Then verify on methods |
| --- | --- | --- |
| `message_thread_id` | `Message` `L434-L645`, `ForumTopic` `L2333` | `sendMessage`, media sends, `sendMediaGroup`, `sendMessageDraft`, `sendChatAction`, Rich sends/drafts |
| `reply_parameters` | `ReplyParameters` `L646-L662` | Send/copy/forward methods that attach replies |
| `reply_markup` | Keyboard markups `L1676-L1778`, `InlineKeyboardButton` / `DisabledButton` `L1779-L1846` | Send/edit methods and callback routing |
| `rich_message` | `Message` `L434-L645`, `RichMessage` `L5859-L5867` | `sendRichMessage`, `sendRichMessageDraft`, `editMessageText` |
| Rich outgoing blocks/media | `InputRichMessage` / `InputRichMessageMedia` `L5868-L5889`, `InputRichBlock*` `L6539-L6806` | `sendRichMessage`, `sendRichMessageDraft`, `editMessageText` |
| Ephemeral identity | `Message` around `L434`, `ReplyParameters` `L646`, `EphemeralMessageParameters` `L663` | Supported send methods, `sendRichMessage`, `editEphemeralMessage*`, `deleteEphemeralMessage` |
| Draft stopping | `Update` `L221-L256`, `MessageGenerationStopped` `L1185-L1193` | `sendMessageDraft`, `sendRichMessageDraft` |
| Community membership | `ChatFullInfo` `L382-L433`, service objects `L1342-L1365`, `Community` `L1880-L1889` | Added, removed, and joined observations |
| `guest_query_id` | `Message` `L434-L645`, `SentGuestMessage` `L2891` | `answerGuestQuery` |
| `allowed_updates` | `getUpdates` `L257-L273`, `setWebhook` `L274-L305` | Reaction/chat-member/subscription update assumptions |
| File id/path | `File` around `L1655`, `InputFile` `L3093-L3102` | `getFile`, concrete send methods, local Bot API server limits |
| Reactions | `ReactionType*` / `MessageReaction*` `L2265-L2332` | `setMessageReaction`, `deleteMessageReaction`, `deleteAllMessageReactions` |

## Risk And Live-Verification Index

Treat these as high-friction zones where the reference is necessary but may not be sufficient:

- Polling/webhook exclusivity: `getUpdates` cannot run while a webhook is set.
- `allowed_updates`: reactions and chat-member style updates often require explicit opt-in and sometimes admin rights.
- Forum topics: documented `message_thread_id` support does not prove every update shape carries thread context.
- Deleted/stale topics: classify errors narrowly and keep live smoke coverage for actual Telegram error text.
- Rich drafts and blocks: Bot API method/type existence does not settle per-client rendering, editing, stopping, or media-composition UX.
- Ephemeral messages: ordinary `message_id` ownership does not substitute for receiver-scoped `ephemeral_message_id` ownership.
- Communities: added, removed, and joined service signals do not define bridge routing, authorization, or leader-election policy.
- Disabled and forced-reply markup: documented fields do not prove uniform rendering or interaction behavior across Telegram clients.
- File transport: cloud Bot API and local Bot API server have materially different upload/download limits.
- Callback/reaction routing: if an update lacks target metadata, prefer durable sent-message ownership over guessing.

## Search Synonym Index

- Topic/forum/thread: `ForumTopic`, `message_thread_id`, `is_topic_message`, `createForumTopic`.
- Button/menu/callback: `InlineKeyboardMarkup`, `InlineKeyboardButton`, `CallbackQuery`, `answerCallbackQuery`, `callback_data`.
- Attachment/file/download/upload: `InputFile`, `File`, `getFile`, `file_id`, `file_path`, `sendDocument`, `sendPhoto`.
- Draft/streaming preview: `sendMessageDraft`, `sendRichMessageDraft`, `RichBlockThinking`, `InputRichBlockThinking`.
- Rich Markdown/native rendering: `RichMessage`, `InputRichMessage`, `InputRichMessageMedia`, `RichText`, `RichBlock`, `InputRichBlock`, `sendRichMessage`.
- Ephemeral/private-to-user group response: `receiver_user`, `ephemeral_message_id`, `EphemeralMessageParameters`, `ephemeral_message_parameters`, `editEphemeralMessage`, `deleteEphemeralMessage`.
- Generation controls: `can_stop`, `keep_on_stop`, `MessageGenerationStopped`, `stopped_message_generation`.
- Welcome-message administration: `can_send_welcome_messages`, `ChatAdministratorRights`, `ChatMemberAdministrator`, `promoteChatMember`.
- Gift metadata: `UniqueGiftInfo`, `text`, `entities`, `is_private`.
- Rich buttons/documents: `RichMessageButton`, `RichTextButton`, `RichBlockButtons`, `InputRichBlockButtons`, `RichBlockDocument`, `InputRichBlockDocument`.
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
- `#messagegenerationstopped` — User-stopped generation update payload.

### Chats, Forums, Communities, And Thread Targets

- `#chat` / `#chatfullinfo` — Chat shape, including forum and community fields.
- `#community`, `#communitychatadded`, `#communitychatremoved`, `#communitychatjoined` — Community identity and membership service objects.
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
- `#sendrichmessage` / `#sendrichmessagedraft` — Native Rich Message send/streaming draft APIs; drafts expose `can_stop` and `keep_on_stop`.
- `#ephemeralmessageparameters` — Receiver/callback target and replacement behavior for supported sends.

### Rich Messages

- [Rich Messages](https://core.telegram.org/bots/features#rich-messages) — Upstream feature overview; use the local 10.1–10.3 changelog and type sections for exact Bot API shape.
- `#richmessage` / `#inputrichmessage` / `#inputrichmessagecontent` — Rich message payload objects.
- `#inputrichmessagemedia` — Media referenced from Rich Markdown/HTML.
- `#richblock` / `#richtext` — Incoming rich block/text unions.
- `#richmessagebutton` / `#richtextbutton` — Rich Message button payloads.
- `#richblockbuttons` / `#inputrichblockbuttons` — Incoming and outgoing button blocks.
- `#richblockdocument` / `#inputrichblockdocument` — Incoming and outgoing document blocks.
- `#richblockexpandableblockquotation` / `#inputrichblockexpandableblockquotation` — Expandable quotation blocks.
- `#inputrichblock` / `#inputrichblocklistitem` — Outgoing explicit block unions and list items.
- Search `InputRichBlockThinking`, `InputRichBlockMathematicalExpression`, `InputRichBlockPreformatted`, `InputRichBlockTable`, `InputRichBlockDetails` for outgoing rendering primitives.

### Files, Media, And Albums

- `#inputfile` — Upload contract.
- `#getfile` — File download metadata.
- `#sendphoto`, `#senddocument`, `#sendvoice`, `#sendaudio`, `#sendvideo`, `#sendanimation`, `#sendsticker` — Common media sends.
- `#sendmediagroup` — Album/grouped media behavior.
- Search `InputMedia` for per-media payload variants, including `InputMediaVoiceNote`.

### Buttons, Inline Mode, Guest Replies

- `#inlinekeyboardmarkup` / `#inlinekeyboardbutton` / `#disabledbutton` — Inline button markup, actions, and disabled state.
- `#replykeyboardmarkup` — Reply keyboard markup, including `force_reply`.
- `#answercallbackquery` — Callback acknowledgement.
- `#inlinequery`, `#answerinlinequery`, `#inputmessagecontent` — Inline mode.
- `#answerguestquery` / `#sentguestmessage` — Guest message replies.

### Errors And Edge Semantics

- `#responseparameters` — Retry/migration hints in failed responses.
- Search exact Telegram error text when modeling stale topic, deleted message, migration, or permission behavior.
- Prefer narrow error classification in code; broad string matching should be justified and covered by tests.

## Output Expectations

When this skill informs a code or documentation change, summarize the Bot API evidence in one sentence and name the anchor or symbol used. Example: `Bot API evidence: sendChatAction accepts message_thread_id, so chat actions can preserve forum targets.`
