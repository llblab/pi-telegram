#### June 11, 2026

**Bot API 10.1**

**Rich Messages**

- Added support for [Rich Messages](#rich-messages), allowing bots to send highly structured text and stream AI-generated replies with seamless rich formatting.
- Added the classes [RichTextBold](#richtextbold), [RichTextItalic](#richtextitalic), [RichTextUnderline](#richtextunderline), [RichTextStrikethrough](#richtextstrikethrough), [RichTextSpoiler](#richtextspoiler), [RichTextDateTime](#richtextdatetime), [RichTextTextMention](#richtexttextmention), [RichTextSubscript](#richtextsubscript), [RichTextSuperscript](#richtextsuperscript), [RichTextMarked](#richtextmarked), [RichTextCode](#richtextcode), [RichTextCustomEmoji](#richtextcustomemoji), [RichTextMathematicalExpression](#richtextmathematicalexpression), [RichTextUrl](#richtexturl), [RichTextEmailAddress](#richtextemailaddress), [RichTextPhoneNumber](#richtextphonenumber), [RichTextBankCardNumber](#richtextbankcardnumber), [RichTextMention](#richtextmention), [RichTextHashtag](#richtexthashtag), [RichTextCashtag](#richtextcashtag), [RichTextBotCommand](#richtextbotcommand), [RichTextAnchor](#richtextanchor), [RichTextAnchorLink](#richtextanchorlink), [RichTextReference](#richtextreference) and [RichTextReferenceLink](#richtextreferencelink), which represent different types of rich formatted text.
- Added the class [RichText](#richtext), which represents rich formatted text.
- Added the class [RichBlockCaption](#richblockcaption), which represents the caption of a rich formatted text.
- Added the class [RichBlockTableCell](#richblocktablecell), which represents a cell in a table.
- Added the class [RichBlockListItem](#richblocklistitem), which represents an item in a list.
- Added the classes [RichBlockParagraph](#richblockparagraph), [RichBlockSectionHeading](#richblocksectionheading), [RichBlockPreformatted](#richblockpreformatted), [RichBlockFooter](#richblockfooter), [RichBlockDivider](#richblockdivider), [RichBlockMathematicalExpression](#richblockmathematicalexpression), [RichBlockAnchor](#richblockanchor), [RichBlockList](#richblocklist), [RichBlockBlockQuotation](#richblockblockquotation), [RichBlockPullQuotation](#richblockpullquotation), [RichBlockCollage](#richblockcollage), [RichBlockSlideshow](#richblockslideshow), [RichBlockTable](#richblocktable), [RichBlockDetails](#richblockdetails), [RichBlockMap](#richblockmap), [RichBlockAnimation](#richblockanimation), [RichBlockAudio](#richblockaudio), [RichBlockPhoto](#richblockphoto), [RichBlockVideo](#richblockvideo), [RichBlockVoiceNote](#richblockvoicenote) and [RichBlockThinking](#richblockthinking), which represent different types of blocks in a rich formatted message.
- Added the class [RichBlock](#richblock), which represents a block in a rich formatted message.
- Added the class [RichMessage](#richmessage), which represents a rich formatted message.
- Added the field _rich\_message_ to the class [Message](#message).
- Added the class [InputRichMessage](#inputrichmessage), describing a rich message to send.
- Added the class [InputRichMessageContent](#inputrichmessagecontent) and allowed it to be used as [InputMessageContent](#inputmessagecontent) in results of inline, guest, and Web App queries.
- Added the method [sendRichMessage](#sendrichmessage), allowing bots to send rich messages.
- Added the method [sendRichMessageDraft](#sendrichmessagedraft), allowing bots to stream partial rich messages.
- Added the parameter _rich\_message_ to the method [editMessageText](#editmessagetext), allowing bots to edit rich messages.

**Join Request Queries**

- Added the field _supports\_join\_request\_queries_ to the class [User](#user).
- Added the field _guard\_bot_ to the class [ChatFullInfo](#chatfullinfo).
- Added the field _query\_id_ to the class [ChatJoinRequest](#chatjoinrequest).
- Added the method [answerChatJoinRequestQuery](#answerchatjoinrequestquery).
- Added the method [sendChatJoinRequestWebApp](#sendchatjoinrequestwebapp).

**Polls**

- Added the class [Link](#link) and the field _link_ to the class [PollMedia](#pollmedia).
- Added the class [InputMediaLink](#inputmedialink) and allowed it to be used as [InputPollOptionMedia](#inputpolloptionmedia).

#### May 8, 2026

**Bot API 10.0**

**Guest Mode**

- Introduced support for guest mode, allowing bots to receive certain messages and issue replies within chats they are not a member of.
- Added the field _supports\_guest\_queries_ to the class [User](#user).
- Added the fields _guest\_bot\_caller\_user_ and _guest\_bot\_caller\_chat_ to the class [Message](#message).
- Added the field _guest\_query\_id_ to the class [Message](#message).
- Added the field _guest\_message_ to the class [Update](#update).
- Added the class [SentGuestMessage](#sentguestmessage) and the method [answerGuestQuery](#answerguestquery).

**Chat Management**

- Added the field _can\_react\_to\_messages_ to the classes [ChatMemberRestricted](#chatmemberrestricted) and [ChatPermissions](#chatpermissions).
- Added the parameter _return\_bots_ to the method [getChatAdministrators](#getchatadministrators).
- Added the method [deleteAllMessageReactions](#deleteallmessagereactions).
- Added the method [deleteMessageReaction](#deletemessagereaction).
- Added the ability to see certain messages sent by other bots in groups.

**Polls**

- Added the classes [InputMediaSticker](#inputmediasticker), [InputMediaLocation](#inputmedialocation), and [InputMediaVenue](#inputmediavenue).
- Added the class [PollMedia](#pollmedia), representing a media in a poll.
- Added the field _media_ to the class [Poll](#poll), allowing bots to see media in polls.
- Added the field _explanation\_media_ to the class [Poll](#poll), allowing bots to see media in quiz explanations.
- Added the field _media_ to the class [PollOption](#polloption), allowing bots to see media in poll options.
- Added the class [InputPollMedia](#inputpollmedia) and the parameters _media_ and _explanation\_media_ to the method [sendPoll](#sendpoll), allowing bots to add media to polls.
- Added the class [InputPollOptionMedia](#inputpolloptionmedia) and the field _media_ to the class [InputPollOption](#inputpolloption), allowing bots to add media to poll options.
- Added the field _members\_only_ to the class [Poll](#poll).
- Added the parameter _members\_only_ to the method [sendPoll](#sendpoll).
- Added the field _country\_codes_ to the class [Poll](#poll).
- Added the parameter _country\_codes_ to the method [sendPoll](#sendpoll).
- Decreased the minimum number of poll options from 2 to 1.

**Live photos**

- Added the class [LivePhoto](#livephoto), which represents a photo with a short video.
- Added the class [InputMediaLivePhoto](#inputmedialivephoto).
- Added the field _live\_photo_ to the classes [Message](#message) and [ExternalReplyInfo](#externalreplyinfo).
- Added the method [sendLivePhoto](#sendlivephoto), allowing bots to send live photos.
- Added the class [PaidMediaLivePhoto](#paidmedialivephoto), which describes a paid media with a live photo.
- Added the class [InputPaidMediaLivePhoto](#inputpaidmedialivephoto), allowing bots to send live photos as paid media.
- Allowed to use live photos in [sendMediaGroup](#sendmediagroup) and [editMessageMedia](#editmessagemedia),

**General**

- Allowed Secretary Bots to manage accounts of users without a Telegram Premium subscription.
- Added the ability to send messages to other bots via username if both bots enabled bot-to-bot communication.
- Added the ability to reply to other bots from a business bot if the business bot enabled bot-to-bot communication.
- Allowed bots to pass an empty text in the method [sendMessageDraft](#sendmessagedraft).
- Added the class [BotAccessSettings](#botaccesssettings) and the method [getManagedBotAccessSettings](#getmanagedbotaccesssettings).
- Added the method [setManagedBotAccessSettings](#setmanagedbotaccesssettings).
- Added the method [getUserPersonalChatMessages](#getuserpersonalchatmessages).

#### April 3, 2026

**Bot API 9.6**

**Managed Bots**

- Added the field _can\_manage\_bots_ to the class [User](#user).
- Added the class [KeyboardButtonRequestManagedBot](#keyboardbuttonrequestmanagedbot) and the field _request\_managed\_bot_ to the class [KeyboardButton](#keyboardbutton).
- Added the class [ManagedBotCreated](#managedbotcreated) and the field _managed\_bot\_created_ to the class [Message](#message).
- Added updates about the creation of managed bots and the change of their token, represented by the class [ManagedBotUpdated](#managedbotupdated) and the field _managed\_bot_ in the class [Update](#update).
- Added the methods [getManagedBotToken](#getmanagedbottoken) and [replaceManagedBotToken](#replacemanagedbottoken).
- Added the class [PreparedKeyboardButton](#preparedkeyboardbutton) and the method [savePreparedKeyboardButton](#savepreparedkeyboardbutton), allowing bots to request users, chats and managed bots from Mini Apps.
- Added the method _requestChat_ to the class [WebApp](https://core.telegram.org/bots/webapps#initializing-mini-apps).
- Added support for `https://t.me/newbot/{manager_bot_username}/{suggested_bot_username}[?name={suggested_bot_name}]` links, allowing bots to request the creation of a managed bot via a link.

**Polls**

- Added support for quizzes with multiple correct answers.
- Replaced the field _correct\_option\_id_ with the field _correct\_option\_ids_ in the class [Poll](#poll).
- Replaced the parameter _correct\_option\_id_ with the parameter _correct\_option\_ids_ in the method [sendPoll](#sendpoll).
- Allowed to pass _allows\_multiple\_answers_ for quizzes in the method [sendPoll](#sendpoll).
- Increased the maximum time for automatic poll closure to 2628000 seconds.
- Added the field _allows\_revoting_ to the class [Poll](#poll).
- Added the parameter _allows\_revoting_ to the method [sendPoll](#sendpoll).
- Added the parameter _shuffle\_options_ to the method [sendPoll](#sendpoll).
- Added the parameter _allow\_adding\_options_ to the method [sendPoll](#sendpoll).
- Added the parameter _hide\_results\_until\_closes_ to the method [sendPoll](#sendpoll).
- Added the fields _description_ and _description\_entities_ to the class [Poll](#poll).
- Added the parameters _description_, _description\_parse\_mode_, and _description\_entities_ to the method [sendPoll](#sendpoll).
- Added the field _persistent\_id_ to the class [PollOption](#polloption), representing a persistent identifier for the option.
- Added the field _option\_persistent\_ids_ to the class [PollAnswer](#pollanswer).
- Added the fields _added\_by\_user_ and _added\_by\_chat_ to the class [PollOption](#polloption), denoting the user and the chat which added the option.
- Added the field _addition\_date_ to the class [PollOption](#polloption), describing the date when the option was added.
- Added the class [PollOptionAdded](#polloptionadded) and the field _poll\_option\_added_ to the class [Message](#message).
- Added the class [PollOptionDeleted](#polloptiondeleted) and the field _poll\_option\_deleted_ to the class [Message](#message).
- Added the field _poll\_option\_id_ to the class [ReplyParameters](#replyparameters), allowing bots to reply to a specific poll option.
- Added the field _reply\_to\_poll\_option\_id_ to the class [Message](#message).
- Allowed “date\_time” entities in [checklist](#inputchecklist) title, [checklist task](#inputchecklisttask) text, [TextQuote](#textquote), [ReplyParameters](#replyparameters) quote, [sendGift](#sendgift), and [giftPremiumSubscription](#giftpremiumsubscription).

**See earlier changes »**

### Authorizing your bot

Each bot is given a unique authentication token when it is created. The token looks something like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`, but we'll use simply **<token>** in this document instead. You can learn about obtaining tokens and generating new ones in this document.

### Making requests

All queries to the Telegram Bot API must be served over HTTPS and need to be presented in this form: `https://api.telegram.org/bot<token>/METHOD_NAME`. Like this for example:

```
https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/getMe
```

We support **GET** and **POST** HTTP methods. We support four ways of passing parameters in Bot API requests:

- [URL query string](https://en.wikipedia.org/wiki/Query_string)
- application/x-www-form-urlencoded
- application/json (except for uploading files)
- multipart/form-data (use to upload files)

The response contains a JSON object, which always has a Boolean field 'ok' and may have an optional String field 'description' with a human-readable description of the result. If 'ok' equals _True_, the request was successful and the result of the query can be found in the 'result' field. In case of an unsuccessful request, 'ok' equals false and the error is explained in the 'description'. An Integer 'error\_code' field is also returned, but its contents are subject to change in the future. Some errors may also have an optional field 'parameters' of the type [ResponseParameters](#responseparameters), which can help to automatically handle the error.

- All methods in the Bot API are case-insensitive.
- All queries must be made using UTF-8.

#### Making requests when getting updates

If you're using [**webhooks**](#getting-updates), you can perform a request to the Bot API while sending an answer to the webhook. Use either _application/json_ or _application/x-www-form-urlencoded_ or _multipart/form-data_ response content type for passing parameters. Specify the method to be invoked in the _method_ parameter of the request. It's not possible to know that such a request was successful or get its result.

> Please see our [FAQ](https://core.telegram.org/bots/faq#how-can-i-make-requests-in-response-to-updates) for examples.

### Using a Local Bot API Server

The Bot API server source code is available at [telegram-bot-api](https://github.com/tdlib/telegram-bot-api). You can run it locally and send the requests to your own server instead of `https://api.telegram.org`. If you switch to a local Bot API server, your bot will be able to:

- Download files without a size limit.
- Upload files up to 2000 MB.
- Upload files using their local path and [the file URI scheme](https://en.wikipedia.org/wiki/File_URI_scheme).
- Use an HTTP URL for the webhook.
- Use any local IP address for the webhook.
- Use any port for the webhook.
- Set _max\_webhook\_connections_ up to 100000.
- Receive the absolute local path as a value of the _file\_path_ field without the need to download the file after a [getFile](#getfile) request.

#### Do I need a Local Bot API Server

The majority of bots will be OK with the default configuration, running on our servers. But if you feel that you need one of [these features](#using-a-local-bot-api-server), you're welcome to switch to your own at any time.

### Getting updates

There are two mutually exclusive ways of receiving updates for your bot - the [getUpdates](#getupdates) method on one hand and [webhooks](#setwebhook) on the other. Incoming updates are stored on the server until the bot receives them either way, but they will not be kept longer than 24 hours.

Regardless of which option you choose, you will receive JSON-serialized [Update](#update) objects as a result.

#### Update

This [object](#available-types) represents an incoming update.  
At most **one** of the optional fields can be present in any given update.

| Field | Type | Description |
| --- | --- | --- |
| update\_id | Integer | The update's unique identifier. Update identifiers start from a certain positive number and increase sequentially. This identifier becomes especially handy if you're using [webhooks](#setwebhook), since it allows you to ignore repeated updates or to restore the correct update sequence, should they get out of order. If there are no new updates for at least a week, then identifier of the next update will be chosen randomly instead of sequentially. |
| message | [Message](#message) | _Optional_. New incoming message of any kind - text, photo, sticker, etc. |
| edited\_message | [Message](#message) | _Optional_. New version of a message that is known to the bot and was edited. This update may at times be triggered by changes to message fields that are either unavailable or not actively used by your bot. |
| channel\_post | [Message](#message) | _Optional_. New incoming channel post of any kind - text, photo, sticker, etc. |
| edited\_channel\_post | [Message](#message) | _Optional_. New version of a channel post that is known to the bot and was edited. This update may at times be triggered by changes to message fields that are either unavailable or not actively used by your bot. |
| business\_connection | [BusinessConnection](#businessconnection) | _Optional_. The bot was connected to or disconnected from a business account, or a user edited an existing connection with the bot |
| business\_message | [Message](#message) | _Optional_. New message from a connected business account |
| edited\_business\_message | [Message](#message) | _Optional_. New version of a message from a connected business account |
| deleted\_business\_messages | [BusinessMessagesDeleted](#businessmessagesdeleted) | _Optional_. Messages were deleted from a connected business account |
| guest\_message | [Message](#message) | _Optional_. New guest message. The bot can use the field _Message.guest\_query\_id_ and the method [answerGuestQuery](#answerguestquery) to send a message in response. |
| message\_reaction | [MessageReactionUpdated](#messagereactionupdated) | _Optional_. A reaction to a message was changed by a user. The bot must be an administrator in the chat and must explicitly specify `"message_reaction"` in the list of _allowed\_updates_ to receive these updates. The update isn't received for reactions set by bots. |
| message\_reaction\_count | [MessageReactionCountUpdated](#messagereactioncountupdated) | _Optional_. Reactions to a message with anonymous reactions were changed. The bot must be an administrator in the chat and must explicitly specify `"message_reaction_count"` in the list of _allowed\_updates_ to receive these updates. The updates are grouped and can be sent with delay up to a few minutes. |
| inline\_query | [InlineQuery](#inlinequery) | _Optional_. New incoming [inline](#inline-mode) query |
| chosen\_inline\_result | [ChosenInlineResult](#choseninlineresult) | _Optional_. The result of an [inline](#inline-mode) query that was chosen by a user and sent to their chat partner. Please see our documentation on the [feedback collecting](https://core.telegram.org/bots/inline#collecting-feedback) for details on how to enable these updates for your bot. |
| callback\_query | [CallbackQuery](#callbackquery) | _Optional_. New incoming callback query |
| shipping\_query | [ShippingQuery](#shippingquery) | _Optional_. New incoming shipping query. Only for invoices with flexible price. |
| pre\_checkout\_query | [PreCheckoutQuery](#precheckoutquery) | _Optional_. New incoming pre-checkout query. Contains full information about checkout. |
| purchased\_paid\_media | [PaidMediaPurchased](#paidmediapurchased) | _Optional_. A user purchased paid media with a non-empty payload sent by the bot in a non-channel chat |
| poll | [Poll](#poll) | _Optional_. New poll state. Bots receive only updates about manually stopped polls and polls, which are sent by the bot. |
| poll\_answer | [PollAnswer](#pollanswer) | _Optional_. A user changed their answer in a non-anonymous poll. Bots receive new votes only in polls that were sent by the bot itself. |
| my\_chat\_member | [ChatMemberUpdated](#chatmemberupdated) | _Optional_. The bot's chat member status was updated in a chat. For private chats, this update is received only when the bot is blocked or unblocked by the user. |
| chat\_member | [ChatMemberUpdated](#chatmemberupdated) | _Optional_. A chat member's status was updated in a chat. The bot must be an administrator in the chat and must explicitly specify `"chat_member"` in the list of _allowed\_updates_ to receive these updates. |
| chat\_join\_request | [ChatJoinRequest](#chatjoinrequest) | _Optional_. A request to join the chat has been sent. The bot must have the _can\_invite\_users_ administrator right in the chat to receive these updates. |
| chat\_boost | [ChatBoostUpdated](#chatboostupdated) | _Optional_. A chat boost was added or changed. The bot must be an administrator in the chat to receive these updates. |
| removed\_chat\_boost | [ChatBoostRemoved](#chatboostremoved) | _Optional_. A boost was removed from a chat. The bot must be an administrator in the chat to receive these updates. |
| managed\_bot | [ManagedBotUpdated](#managedbotupdated) | _Optional_. A new bot was created to be managed by the bot, or token or owner of a managed bot was changed |

#### getUpdates

Use this method to receive incoming updates using long polling ([wiki](https://en.wikipedia.org/wiki/Push_technology#Long_polling)). Returns an Array of [Update](#update) objects.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| offset | Integer | Optional | Identifier of the first update to be returned. Must be greater by one than the highest among the identifiers of previously received updates. By default, updates starting with the earliest unconfirmed update are returned. An update is considered confirmed as soon as [getUpdates](#getupdates) is called with an _offset_ higher than its _update\_id_. The negative offset can be specified to retrieve updates starting from _\-offset_ update from the end of the updates queue. All previous updates will be forgotten. |
| limit | Integer | Optional | Limits the number of updates to be retrieved. Values between 1-100 are accepted. Defaults to 100. |
| timeout | Integer | Optional | Timeout in seconds for long polling. Defaults to 0, i.e. usual short polling. Should be positive, short polling should be used for testing purposes only. |
| allowed\_updates | Array of String | Optional | A JSON-serialized list of the update types you want your bot to receive. For example, specify `["message", "edited_channel_post", "callback_query"]` to only receive updates of these types. See [Update](#update) for a complete list of available update types. Specify an empty list to receive all update types except _chat\_member_, _message\_reaction_, and _message\_reaction\_count_ (default). If not specified, the previous setting will be used.  <br>  <br>Please note that this parameter doesn't affect updates created before the call to getUpdates, so unwanted updates may be received for a short period of time. |

> **Notes**  
> **1.** This method will not work if an outgoing webhook is set up.  
> **2.** In order to avoid getting duplicate updates, recalculate _offset_ after each server response.

#### setWebhook

Use this method to specify a URL and receive incoming updates via an outgoing webhook. Whenever there is an update for the bot, we will send an HTTPS POST request to the specified URL, containing a JSON-serialized [Update](#update). In case of an unsuccessful request (a request with response [HTTP status code](https://en.wikipedia.org/wiki/List_of_HTTP_status_codes) different from `2XY`), we will repeat the request and give up after a reasonable amount of attempts. Returns _True_ on success.

If you'd like to make sure that the webhook was set by you, you can specify secret data in the parameter _secret\_token_. If specified, the request will contain a header “X-Telegram-Bot-Api-Secret-Token” with the secret token as content.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| url | String | Yes | HTTPS URL to send updates to. Use an empty string to remove webhook integration. |
| certificate | [InputFile](#inputfile) | Optional | Upload your public key certificate so that the root certificate in use can be checked. See our [self-signed guide](https://core.telegram.org/bots/self-signed) for details. |
| ip\_address | String | Optional | The fixed IP address which will be used to send webhook requests instead of the IP address resolved through DNS |
| max\_connections | Integer | Optional | The maximum allowed number of simultaneous HTTPS connections to the webhook for update delivery, 1-100. Defaults to _40_. Use lower values to limit the load on your bot's server, and higher values to increase your bot's throughput. |
| allowed\_updates | Array of String | Optional | A JSON-serialized list of the update types you want your bot to receive. For example, specify `["message", "edited_channel_post", "callback_query"]` to only receive updates of these types. See [Update](#update) for a complete list of available update types. Specify an empty list to receive all update types except _chat\_member_, _message\_reaction_, and _message\_reaction\_count_ (default). If not specified, the previous setting will be used.  <br>Please note that this parameter doesn't affect updates created before the call to the setWebhook, so unwanted updates may be received for a short period of time. |
| drop\_pending\_updates | Boolean | Optional | Pass _True_ to drop all pending updates |
| secret\_token | String | Optional | A secret token to be sent in a header “X-Telegram-Bot-Api-Secret-Token” in every webhook request, 1-256 characters. Only characters `A-Z`, `a-z`, `0-9`, `_` and `-` are allowed. The header is useful to ensure that the request comes from a webhook set by you. |

> **Notes**  
> **1.** You will not be able to receive updates using [getUpdates](#getupdates) for as long as an outgoing webhook is set up.  
> **2.** To use a self-signed certificate, you need to upload your [public key certificate](https://core.telegram.org/bots/self-signed) using _certificate_ parameter. Please upload as InputFile, sending a String will not work.  
> **3.** Ports currently supported _for webhooks_: **443, 80, 88, 8443**.
> 
> If you're having any trouble setting up webhooks, please check out this [amazing guide to webhooks](https://core.telegram.org/bots/webhooks).

#### deleteWebhook

Use this method to remove webhook integration if you decide to switch back to [getUpdates](#getupdates). Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| drop\_pending\_updates | Boolean | Optional | Pass _True_ to drop all pending updates |

#### getWebhookInfo

Use this method to get current webhook status. Requires no parameters. On success, returns a [WebhookInfo](#webhookinfo) object. If the bot is using [getUpdates](#getupdates), will return an object with the _url_ field empty.

#### WebhookInfo

Describes the current status of a webhook.

| Field | Type | Description |
| --- | --- | --- |
| url | String | Webhook URL, may be empty if webhook is not set up |
| has\_custom\_certificate | Boolean | _True_, if a custom certificate was provided for webhook certificate checks |
| pending\_update\_count | Integer | Number of updates awaiting delivery |
| ip\_address | String | _Optional_. Currently used webhook IP address |
| last\_error\_date | Integer | _Optional_. Unix time for the most recent error that happened when trying to deliver an update via webhook |
| last\_error\_message | String | _Optional_. Error message in human-readable format for the most recent error that happened when trying to deliver an update via webhook |
| last\_synchronization\_error\_date | Integer | _Optional_. Unix time of the most recent error that happened when trying to synchronize available updates with Telegram datacenters |
| max\_connections | Integer | _Optional_. The maximum allowed number of simultaneous HTTPS connections to the webhook for update delivery |
| allowed\_updates | Array of String | _Optional_. A list of update types the bot is subscribed to. Defaults to all update types except _chat\_member_, _message\_reaction_, and _message\_reaction\_count_. |

### Available types

All types used in the Bot API responses are represented as JSON-objects.

It is safe to use 32-bit signed integers for storing all **Integer** fields unless otherwise noted.

> **Optional** fields may be not returned when irrelevant.

#### User

This object represents a Telegram user or bot.

| Field | Type | Description |
| --- | --- | --- |
| id  | Integer | Unique identifier for this user or bot. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a 64-bit integer or double-precision float type are safe for storing this identifier. |
| is\_bot | Boolean | _True_, if this user is a bot |
| first\_name | String | User's or bot's first name |
| last\_name | String | _Optional_. User's or bot's last name |
| username | String | _Optional_. User's or bot's username |
| language\_code | String | _Optional_. [IETF language tag](https://en.wikipedia.org/wiki/IETF_language_tag) of the user's language |
| is\_premium | True | _Optional_. _True_, if this user is a Telegram Premium user |
| added\_to\_attachment\_menu | True | _Optional_. _True_, if this user added the bot to the attachment menu |
| can\_join\_groups | Boolean | _Optional_. _True_, if the bot can be invited to groups. Returned only in [getMe](#getme). |
| can\_read\_all\_group\_messages | Boolean | _Optional_. _True_, if privacy mode is disabled for the bot. Returned only in [getMe](#getme). |
| supports\_guest\_queries | Boolean | _Optional_. _True_, if the bot supports guest queries from chats it is not a member of. Returned only in [getMe](#getme). |
| supports\_inline\_queries | Boolean | _Optional_. _True_, if the bot supports inline queries. Returned only in [getMe](#getme). |
| can\_connect\_to\_business | Boolean | _Optional_. _True_, if the bot can be connected to a user account to manage it. Returned only in [getMe](#getme). |
| has\_main\_web\_app | Boolean | _Optional_. _True_, if the bot has a main Web App. Returned only in [getMe](#getme). |
| has\_topics\_enabled | Boolean | _Optional_. _True_, if the bot has forum topic mode enabled in private chats. Returned only in [getMe](#getme). |
| allows\_users\_to\_create\_topics | Boolean | _Optional_. _True_, if the bot allows users to create and delete topics in private chats. Returned only in [getMe](#getme). |
| can\_manage\_bots | Boolean | _Optional_. _True_, if other bots can be created to be controlled by the bot. Returned only in [getMe](#getme). |
| supports\_join\_request\_queries | Boolean | _Optional_. _True_, if the bot supports join request queries and can be assigned to process them. Returned only in [getMe](#getme). |

#### Chat

This object represents a chat.

| Field | Type | Description |
| --- | --- | --- |
| id  | Integer | Unique identifier for this chat. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this identifier. |
| type | String | Type of the chat, can be either “private”, “group”, “supergroup” or “channel” |
| title | String | _Optional_. Title, for supergroups, channels and group chats |
| username | String | _Optional_. Username, for private chats, supergroups and channels if available |
| first\_name | String | _Optional_. First name of the other party in a private chat |
| last\_name | String | _Optional_. Last name of the other party in a private chat |
| is\_forum | True | _Optional_. _True_, if the supergroup chat is a forum (has [topics](https://telegram.org/blog/topics-in-groups-collectible-usernames#topics-in-groups) enabled) |
| is\_direct\_messages | True | _Optional_. _True_, if the chat is the direct messages chat of a channel |

#### ChatFullInfo

This object contains full information about a chat.

| Field | Type | Description |
| --- | --- | --- |
| id  | Integer | Unique identifier for this chat. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this identifier. |
| type | String | Type of the chat, can be either “private”, “group”, “supergroup” or “channel” |
| title | String | _Optional_. Title, for supergroups, channels and group chats |
| username | String | _Optional_. Username, for private chats, supergroups and channels if available |
| first\_name | String | _Optional_. First name of the other party in a private chat |
| last\_name | String | _Optional_. Last name of the other party in a private chat |
| is\_forum | True | _Optional_. _True_, if the supergroup chat is a forum (has [topics](https://telegram.org/blog/topics-in-groups-collectible-usernames#topics-in-groups) enabled) |
| is\_direct\_messages | True | _Optional_. _True_, if the chat is the direct messages chat of a channel |
| accent\_color\_id | Integer | Identifier of the accent color for the chat name and backgrounds of the chat photo, reply header, and link preview. See [accent colors](#accent-colors) for more details. |
| max\_reaction\_count | Integer | The maximum number of reactions that can be set on a message in the chat |
| photo | [ChatPhoto](#chatphoto) | _Optional_. Chat photo |
| active\_usernames | Array of String | _Optional_. If non-empty, the list of all [active chat usernames](https://telegram.org/blog/topics-in-groups-collectible-usernames#collectible-usernames); for private chats, supergroups and channels |
| birthdate | [Birthdate](#birthdate) | _Optional_. For private chats, the date of birth of the user |
| business\_intro | [BusinessIntro](#businessintro) | _Optional_. For private chats with business accounts, the intro of the business |
| business\_location | [BusinessLocation](#businesslocation) | _Optional_. For private chats with business accounts, the location of the business |
| business\_opening\_hours | [BusinessOpeningHours](#businessopeninghours) | _Optional_. For private chats with business accounts, the opening hours of the business |
| personal\_chat | [Chat](#chat) | _Optional_. For private chats, the personal channel of the user |
| parent\_chat | [Chat](#chat) | _Optional_. Information about the corresponding channel chat; for direct messages chats only |
| available\_reactions | Array of [ReactionType](#reactiontype) | _Optional_. List of available reactions allowed in the chat. If omitted, then all [emoji reactions](#reactiontypeemoji) are allowed. |
| background\_custom\_emoji\_id | String | _Optional_. Custom emoji identifier of the emoji chosen by the chat for the reply header and link preview background |
| profile\_accent\_color\_id | Integer | _Optional_. Identifier of the accent color for the chat's profile background. See [profile accent colors](#profile-accent-colors) for more details. |
| profile\_background\_custom\_emoji\_id | String | _Optional_. Custom emoji identifier of the emoji chosen by the chat for its profile background |
| emoji\_status\_custom\_emoji\_id | String | _Optional_. Custom emoji identifier of the emoji status of the chat or the other party in a private chat |
| emoji\_status\_expiration\_date | Integer | _Optional_. Expiration date of the emoji status of the chat or the other party in a private chat, in Unix time, if any |
| bio | String | _Optional_. Bio of the other party in a private chat |
| has\_private\_forwards | True | _Optional_. _True_, if privacy settings of the other party in the private chat allows to use `tg://user?id=<user_id>` links only in chats with the user |
| has\_restricted\_voice\_and\_video\_messages | True | _Optional_. _True_, if the privacy settings of the other party restrict sending voice and video note messages in the private chat |
| join\_to\_send\_messages | True | _Optional_. _True_, if users need to join the supergroup before they can send messages |
| join\_by\_request | True | _Optional_. _True_, if all users directly joining the supergroup without using an invite link need to be approved by supergroup administrators |
| description | String | _Optional_. Description, for groups, supergroups and channel chats |
| invite\_link | String | _Optional_. Primary invite link, for groups, supergroups and channel chats |
| pinned\_message | [Message](#message) | _Optional_. The most recent pinned message (by sending date) |
| permissions | [ChatPermissions](#chatpermissions) | _Optional_. Default chat member permissions, for groups and supergroups |
| accepted\_gift\_types | [AcceptedGiftTypes](#acceptedgifttypes) | Information about types of gifts that are accepted by the chat or by the corresponding user for private chats |
| can\_send\_paid\_media | True | _Optional_. _True_, if paid media messages can be sent or forwarded to the channel chat. The field is available only for channel chats. |
| slow\_mode\_delay | Integer | _Optional_. For supergroups, the minimum allowed delay between consecutive messages sent by each unprivileged user; in seconds |
| unrestrict\_boost\_count | Integer | _Optional_. For supergroups, the minimum number of boosts that a non-administrator user needs to add in order to ignore slow mode and chat permissions |
| message\_auto\_delete\_time | Integer | _Optional_. The time after which all messages sent to the chat will be automatically deleted; in seconds |
| has\_aggressive\_anti\_spam\_enabled | True | _Optional_. _True_, if aggressive anti-spam checks are enabled in the supergroup. The field is only available to chat administrators. |
| has\_hidden\_members | True | _Optional_. _True_, if non-administrators can only get the list of bots and administrators in the chat |
| has\_protected\_content | True | _Optional_. _True_, if messages from the chat can't be forwarded to other chats |
| has\_visible\_history | True | _Optional_. _True_, if new chat members will have access to old messages; available only to chat administrators |
| sticker\_set\_name | String | _Optional_. For supergroups, name of the group sticker set |
| can\_set\_sticker\_set | True | _Optional_. _True_, if the bot can change the group sticker set |
| custom\_emoji\_sticker\_set\_name | String | _Optional_. For supergroups, the name of the group's custom emoji sticker set. Custom emoji from this set can be used by all users and bots in the group. |
| linked\_chat\_id | Integer | _Optional_. Unique identifier for the linked chat, i.e. the discussion group identifier for a channel and vice versa; for supergroups and channel chats. This identifier may be greater than 32 bits and some programming languages may have difficulty/silent defects in interpreting it. But it is smaller than 52 bits, so a signed 64 bit integer or double-precision float type are safe for storing this identifier. |
| location | [ChatLocation](#chatlocation) | _Optional_. For supergroups, the location to which the supergroup is connected |
| rating | [UserRating](#userrating) | _Optional_. For private chats, the rating of the user if any |
| first\_profile\_audio | [Audio](#audio) | _Optional_. For private chats, the first audio added to the profile of the user |
| unique\_gift\_colors | [UniqueGiftColors](#uniquegiftcolors) | _Optional_. The color scheme based on a unique gift that must be used for the chat's name, message replies and link previews |
| paid\_message\_star\_count | Integer | _Optional_. The number of Telegram Stars a general user has to pay to send a message to the chat |
| guard\_bot | [User](#user) | _Optional_. The bot that processes join request queries in the chat. The field is only available to chat administrators. |

#### Message

This object represents a message.

| Field | Type | Description |
| --- | --- | --- |
| message\_id | Integer | Unique message identifier inside this chat. In specific instances (e.g., message containing a video sent to a big chat), the server might automatically schedule a message instead of sending it immediately. In such cases, this field will be 0 and the relevant message will be unusable until it is actually sent. |
| message\_thread\_id | Integer | _Optional_. Unique identifier of a message thread or forum topic to which the message belongs; for supergroups and private chats only |
| direct\_messages\_topic | [DirectMessagesTopic](#directmessagestopic) | _Optional_. Information about the direct messages chat topic that contains the message |
| from | [User](#user) | _Optional_. Sender of the message; may be empty for messages sent to channels. For backward compatibility, if the message was sent on behalf of a chat, the field contains a fake sender user in non-channel chats. |
| sender\_chat | [Chat](#chat) | _Optional_. Sender of the message when sent on behalf of a chat. For example, the supergroup itself for messages sent by its anonymous administrators or a linked channel for messages automatically forwarded to the channel's discussion group. For backward compatibility, if the message was sent on behalf of a chat, the field _from_ contains a fake sender user in non-channel chats. |
| sender\_boost\_count | Integer | _Optional_. If the sender of the message boosted the chat, the number of boosts added by the user |
| sender\_business\_bot | [User](#user) | _Optional_. The bot that actually sent the message on behalf of the business account. Available only for outgoing messages sent on behalf of the connected business account. |
| sender\_tag | String | _Optional_. Tag or custom title of the sender of the message; for supergroups only |
| date | Integer | Date the message was sent in Unix time. It is always a positive number, representing a valid date. |
| guest\_query\_id | String | _Optional_. The unique identifier for the guest query. Use this identifier with the method [answerGuestQuery](#answerguestquery) to send a response message. If non-empty, the message belongs to the chat where the guest bot was summoned, which may not coincide with other existing bot chats sharing the same identifier. |
| business\_connection\_id | String | _Optional_. Unique identifier of the business connection from which the message was received. If non-empty, the message belongs to a chat of the corresponding business account that is independent from any potential bot chat which might share the same identifier. |
| chat | [Chat](#chat) | Chat the message belongs to |
| forward\_origin | [MessageOrigin](#messageorigin) | _Optional_. Information about the original message for forwarded messages |
| is\_topic\_message | True | _Optional_. _True_, if the message is sent to a topic in a forum supergroup or a private chat with the bot |
| is\_automatic\_forward | True | _Optional_. _True_, if the message is a channel post that was automatically forwarded to the connected discussion group |
| reply\_to\_message | [Message](#message) | _Optional_. For replies in the same chat and message thread, the original message. Note that the [Message](#message) object in this field will not contain further _reply\_to\_message_ fields even if it itself is a reply. |
| external\_reply | [ExternalReplyInfo](#externalreplyinfo) | _Optional_. Information about the message that is being replied to, which may come from another chat or forum topic |
| quote | [TextQuote](#textquote) | _Optional_. For replies that quote part of the original message, the quoted part of the message |
| reply\_to\_story | [Story](#story) | _Optional_. For replies to a story, the original story |
| reply\_to\_checklist\_task\_id | Integer | _Optional_. Identifier of the specific checklist task that is being replied to |
| reply\_to\_poll\_option\_id | String | _Optional_. Persistent identifier of the specific poll option that is being replied to |
| via\_bot | [User](#user) | _Optional_. Bot through which the message was sent |
| guest\_bot\_caller\_user | [User](#user) | _Optional_. For a message sent by a guest bot, this is the user whose original message triggered the bot's response |
| guest\_bot\_caller\_chat | [Chat](#chat) | _Optional_. For a message sent by a guest bot, this is the chat whose original message triggered the bot's response |
| edit\_date | Integer | _Optional_. Date the message was last edited in Unix time |
| has\_protected\_content | True | _Optional_. _True_, if the message can't be forwarded |
| is\_from\_offline | True | _Optional_. _True_, if the message was sent by an implicit action, for example, as an away or a greeting business message, or as a scheduled message |
| is\_paid\_post | True | _Optional_. _True_, if the message is a paid post. Note that such posts must not be deleted for 24 hours to receive the payment and can't be edited. |
| media\_group\_id | String | _Optional_. The unique identifier inside this chat of a media message group this message belongs to |
| author\_signature | String | _Optional_. Signature of the post author for messages in channels, or the custom title of an anonymous group administrator |
| paid\_star\_count | Integer | _Optional_. The number of Telegram Stars that were paid by the sender of the message to send it |
| text | String | _Optional_. For text messages, the actual UTF-8 text of the message |
| entities | Array of [MessageEntity](#messageentity) | _Optional_. For text messages, special entities like usernames, URLs, bot commands, etc. that appear in the text |
| link\_preview\_options | [LinkPreviewOptions](#linkpreviewoptions) | _Optional_. Options used for link preview generation for the message, if it is a text message and link preview options were changed |
| suggested\_post\_info | [SuggestedPostInfo](#suggestedpostinfo) | _Optional_. Information about suggested post parameters if the message is a suggested post in a channel direct messages chat. If the message is an approved or declined suggested post, then it can't be edited. |
| effect\_id | String | _Optional_. Unique identifier of the message effect added to the message |
| rich\_message | [RichMessage](#richmessage) | _Optional_. Message is a rich formatted message |
| animation | [Animation](#animation) | _Optional_. Message is an animation, information about the animation. For backward compatibility, when this field is set, the _document_ field will also be set. |
| audio | [Audio](#audio) | _Optional_. Message is an audio file, information about the file |
| document | [Document](#document) | _Optional_. Message is a general file, information about the file |
| live\_photo | [LivePhoto](#livephoto) | _Optional_. Message is a live photo, information about the live photo. For backward compatibility, when this field is set, the _photo_ field will also be set. |
| paid\_media | [PaidMediaInfo](#paidmediainfo) | _Optional_. Message contains paid media; information about the paid media |
| photo | Array of [PhotoSize](#photosize) | _Optional_. Message is a photo, available sizes of the photo |
| sticker | [Sticker](#sticker) | _Optional_. Message is a sticker, information about the sticker |
| story | [Story](#story) | _Optional_. Message is a forwarded story |
| video | [Video](#video) | _Optional_. Message is a video, information about the video |
| video\_note | [VideoNote](#videonote) | _Optional_. Message is a [video note](https://telegram.org/blog/video-messages-and-telescope), information about the video message |
| voice | [Voice](#voice) | _Optional_. Message is a voice message, information about the file |
| caption | String | _Optional_. Caption for the animation, audio, document, paid media, photo, video or voice |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. For messages with a caption, special entities like usernames, URLs, bot commands, etc. that appear in the caption |
| show\_caption\_above\_media | True | _Optional_. _True_, if the caption must be shown above the message media |
| has\_media\_spoiler | True | _Optional_. _True_, if the message media is covered by a spoiler animation |
| checklist | [Checklist](#checklist) | _Optional_. Message is a checklist |
| contact | [Contact](#contact) | _Optional_. Message is a shared contact, information about the contact |
| dice | [Dice](#dice) | _Optional_. Message is a dice with random value |
| game | [Game](#game) | _Optional_. Message is a game, information about the game. [More about games »](#games) |
| poll | [Poll](#poll) | _Optional_. Message is a native poll, information about the poll |
| venue | [Venue](#venue) | _Optional_. Message is a venue, information about the venue. For backward compatibility, when this field is set, the _location_ field will also be set. |
| location | [Location](#location) | _Optional_. Message is a shared location, information about the location |
| new\_chat\_members | Array of [User](#user) | _Optional_. New members that were added to the group or supergroup and information about them (the bot itself may be one of these members) |
| left\_chat\_member | [User](#user) | _Optional_. A member was removed from the group, information about them (this member may be the bot itself) |
| chat\_owner\_left | [ChatOwnerLeft](#chatownerleft) | _Optional_. Service message: chat owner has left |
| chat\_owner\_changed | [ChatOwnerChanged](#chatownerchanged) | _Optional_. Service message: chat owner has changed |
| new\_chat\_title | String | _Optional_. A chat title was changed to this value |
| new\_chat\_photo | Array of [PhotoSize](#photosize) | _Optional_. A chat photo was change to this value |
| delete\_chat\_photo | True | _Optional_. Service message: the chat photo was deleted |
| group\_chat\_created | True | _Optional_. Service message: the group has been created |
| supergroup\_chat\_created | True | _Optional_. Service message: the supergroup has been created. This field can't be received in a message coming through updates, because bot can't be a member of a supergroup when it is created. It can only be found in reply\_to\_message if someone replies to a very first message in a directly created supergroup. |
| channel\_chat\_created | True | _Optional_. Service message: the channel has been created. This field can't be received in a message coming through updates, because bot can't be a member of a channel when it is created. It can only be found in reply\_to\_message if someone replies to a very first message in a channel. |
| message\_auto\_delete\_timer\_changed | [MessageAutoDeleteTimerChanged](#messageautodeletetimerchanged) | _Optional_. Service message: auto-delete timer settings changed in the chat |
| migrate\_to\_chat\_id | Integer | _Optional_. The group has been migrated to a supergroup with the specified identifier. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this identifier. |
| migrate\_from\_chat\_id | Integer | _Optional_. The supergroup has been migrated from a group with the specified identifier. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this identifier. |
| pinned\_message | [MaybeInaccessibleMessage](#maybeinaccessiblemessage) | _Optional_. Specified message was pinned. Note that the [Message](#message) object in this field will not contain further _reply\_to\_message_ fields even if it itself is a reply. |
| invoice | [Invoice](#invoice) | _Optional_. Message is an invoice for a [payment](#payments), information about the invoice. [More about payments »](#payments) |
| successful\_payment | [SuccessfulPayment](#successfulpayment) | _Optional_. Message is a service message about a successful payment, information about the payment. [More about payments »](#payments) |
| refunded\_payment | [RefundedPayment](#refundedpayment) | _Optional_. Message is a service message about a refunded payment, information about the payment. [More about payments »](#payments) |
| users\_shared | [UsersShared](#usersshared) | _Optional_. Service message: users were shared with the bot |
| chat\_shared | [ChatShared](#chatshared) | _Optional_. Service message: a chat was shared with the bot |
| gift | [GiftInfo](#giftinfo) | _Optional_. Service message: a regular gift was sent or received |
| unique\_gift | [UniqueGiftInfo](#uniquegiftinfo) | _Optional_. Service message: a unique gift was sent or received |
| gift\_upgrade\_sent | [GiftInfo](#giftinfo) | _Optional_. Service message: upgrade of a gift was purchased after the gift was sent |
| connected\_website | String | _Optional_. The domain name of the website on which the user has logged in. [More about Telegram Login »](https://core.telegram.org/widgets/login) |
| write\_access\_allowed | [WriteAccessAllowed](#writeaccessallowed) | _Optional_. Service message: the user allowed the bot to write messages after adding it to the attachment or side menu, launching a Web App from a link, or accepting an explicit request from a Web App sent by the method [requestWriteAccess](https://core.telegram.org/bots/webapps#initializing-mini-apps) |
| passport\_data | [PassportData](#passportdata) | _Optional_. Telegram Passport data |
| proximity\_alert\_triggered | [ProximityAlertTriggered](#proximityalerttriggered) | _Optional_. Service message. A user in the chat triggered another user's proximity alert while sharing Live Location. |
| boost\_added | [ChatBoostAdded](#chatboostadded) | _Optional_. Service message: user boosted the chat |
| chat\_background\_set | [ChatBackground](#chatbackground) | _Optional_. Service message: chat background set |
| checklist\_tasks\_done | [ChecklistTasksDone](#checklisttasksdone) | _Optional_. Service message: some tasks in a checklist were marked as done or not done |
| checklist\_tasks\_added | [ChecklistTasksAdded](#checklisttasksadded) | _Optional_. Service message: tasks were added to a checklist |
| direct\_message\_price\_changed | [DirectMessagePriceChanged](#directmessagepricechanged) | _Optional_. Service message: the price for paid messages in the corresponding direct messages chat of a channel has changed |
| forum\_topic\_created | [ForumTopicCreated](#forumtopiccreated) | _Optional_. Service message: forum topic created |
| forum\_topic\_edited | [ForumTopicEdited](#forumtopicedited) | _Optional_. Service message: forum topic edited |
| forum\_topic\_closed | [ForumTopicClosed](#forumtopicclosed) | _Optional_. Service message: forum topic closed |
| forum\_topic\_reopened | [ForumTopicReopened](#forumtopicreopened) | _Optional_. Service message: forum topic reopened |
| general\_forum\_topic\_hidden | [GeneralForumTopicHidden](#generalforumtopichidden) | _Optional_. Service message: the 'General' forum topic hidden |
| general\_forum\_topic\_unhidden | [GeneralForumTopicUnhidden](#generalforumtopicunhidden) | _Optional_. Service message: the 'General' forum topic unhidden |
| giveaway\_created | [GiveawayCreated](#giveawaycreated) | _Optional_. Service message: a scheduled giveaway was created |
| giveaway | [Giveaway](#giveaway) | _Optional_. The message is a scheduled giveaway message |
| giveaway\_winners | [GiveawayWinners](#giveawaywinners) | _Optional_. A giveaway with public winners was completed |
| giveaway\_completed | [GiveawayCompleted](#giveawaycompleted) | _Optional_. Service message: a giveaway without public winners was completed |
| managed\_bot\_created | [ManagedBotCreated](#managedbotcreated) | _Optional_. Service message: user created a bot that will be managed by the current bot |
| paid\_message\_price\_changed | [PaidMessagePriceChanged](#paidmessagepricechanged) | _Optional_. Service message: the price for paid messages has changed in the chat |
| poll\_option\_added | [PollOptionAdded](#polloptionadded) | _Optional_. Service message: answer option was added to a poll |
| poll\_option\_deleted | [PollOptionDeleted](#polloptiondeleted) | _Optional_. Service message: answer option was deleted from a poll |
| suggested\_post\_approved | [SuggestedPostApproved](#suggestedpostapproved) | _Optional_. Service message: a suggested post was approved |
| suggested\_post\_approval\_failed | [SuggestedPostApprovalFailed](#suggestedpostapprovalfailed) | _Optional_. Service message: approval of a suggested post has failed |
| suggested\_post\_declined | [SuggestedPostDeclined](#suggestedpostdeclined) | _Optional_. Service message: a suggested post was declined |
| suggested\_post\_paid | [SuggestedPostPaid](#suggestedpostpaid) | _Optional_. Service message: payment for a suggested post was received |
| suggested\_post\_refunded | [SuggestedPostRefunded](#suggestedpostrefunded) | _Optional_. Service message: payment for a suggested post was refunded |
| video\_chat\_scheduled | [VideoChatScheduled](#videochatscheduled) | _Optional_. Service message: video chat scheduled |
| video\_chat\_started | [VideoChatStarted](#videochatstarted) | _Optional_. Service message: video chat started |
| video\_chat\_ended | [VideoChatEnded](#videochatended) | _Optional_. Service message: video chat ended |
| video\_chat\_participants\_invited | [VideoChatParticipantsInvited](#videochatparticipantsinvited) | _Optional_. Service message: new participants invited to a video chat |
| web\_app\_data | [WebAppData](#webappdata) | _Optional_. Service message: data sent by a Web App |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message. `login_url` buttons are represented as ordinary `url` buttons. |

#### MessageId

This object represents a unique message identifier.

| Field | Type | Description |
| --- | --- | --- |
| message\_id | Integer | Unique message identifier. In specific instances (e.g., message containing a video sent to a big chat), the server might automatically schedule a message instead of sending it immediately. In such cases, this field will be 0 and the relevant message will be unusable until it is actually sent. |

#### InaccessibleMessage

This object describes a message that was deleted or is otherwise inaccessible to the bot.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | Chat the message belonged to |
| message\_id | Integer | Unique message identifier inside the chat |
| date | Integer | Always 0. The field can be used to differentiate regular and inaccessible messages. |

#### MaybeInaccessibleMessage

This object describes a message that can be inaccessible to the bot. It can be one of

- [Message](#message)
- [InaccessibleMessage](#inaccessiblemessage)

#### MessageEntity

This object represents one special entity in a text message. For example, hashtags, usernames, URLs, etc.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the entity. Currently, can be “mention” (`@username`), “hashtag” (`#hashtag` or `#hashtag@chatusername`), “cashtag” (`$USD` or `$USD@chatusername`), “bot\_command” (`/start@jobs_bot`), “url” (`https://telegram.org`), “email” (`do-not-reply@telegram.org`), “phone\_number” (`+1-212-555-0123`), “bold” (**bold text**), “italic” (_italic text_), “underline” (underlined text), “strikethrough” (strikethrough text), “spoiler” (spoiler message), “blockquote” (block quotation), “expandable\_blockquote” (collapsed-by-default block quotation), “code” (monowidth string), “pre” (monowidth block), “text\_link” (for clickable text URLs), “text\_mention” (for users [without usernames](https://telegram.org/blog/edit#new-mentions)), “custom\_emoji” (for inline custom emoji stickers), or “date\_time” (for formatted date and time). |
| offset | Integer | Offset in [UTF-16 code units](https://core.telegram.org/api/entities#entity-length) to the start of the entity |
| length | Integer | Length of the entity in [UTF-16 code units](https://core.telegram.org/api/entities#entity-length) |
| url | String | _Optional_. For “text\_link” only, URL that will be opened after user taps on the text |
| user | [User](#user) | _Optional_. For “text\_mention” only, the mentioned user |
| language | String | _Optional_. For “pre” only, the programming language of the entity text |
| custom\_emoji\_id | String | _Optional_. For “custom\_emoji” only, unique identifier of the custom emoji. Use [getCustomEmojiStickers](#getcustomemojistickers) to get full information about the sticker. |
| unix\_time | Integer | _Optional_. For “date\_time” only, the Unix time associated with the entity |
| date\_time\_format | String | _Optional_. For “date\_time” only, the string that defines the formatting of the date and time. See [date-time entity formatting](#date-time-entity-formatting) for more details. |

#### TextQuote

This object contains information about the quoted part of a message that is replied to by the given message.

| Field | Type | Description |
| --- | --- | --- |
| text | String | Text of the quoted part of a message that is replied to by the given message |
| entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the quote. Currently, only _bold_, _italic_, _underline_, _strikethrough_, _spoiler_, _custom\_emoji_, and _date\_time_ entities are kept in quotes. |
| position | Integer | Approximate quote position in the original message in UTF-16 code units as specified by the sender |
| is\_manual | True | _Optional_. _True_, if the quote was chosen manually by the message sender. Otherwise, the quote was added automatically by the server. |

#### ExternalReplyInfo

This object contains information about a message that is being replied to, which may come from another chat or forum topic.

| Field | Type | Description |
| --- | --- | --- |
| origin | [MessageOrigin](#messageorigin) | Origin of the message replied to by the given message |
| chat | [Chat](#chat) | _Optional_. Chat the original message belongs to. Available only if the chat is a supergroup or a channel. |
| message\_id | Integer | _Optional_. Unique message identifier inside the original chat. Available only if the original chat is a supergroup or a channel. |
| link\_preview\_options | [LinkPreviewOptions](#linkpreviewoptions) | _Optional_. Options used for link preview generation for the original message, if it is a text message |
| animation | [Animation](#animation) | _Optional_. Message is an animation, information about the animation |
| audio | [Audio](#audio) | _Optional_. Message is an audio file, information about the file |
| document | [Document](#document) | _Optional_. Message is a general file, information about the file |
| live\_photo | [LivePhoto](#livephoto) | _Optional_. Message is a live photo, information about the live photo |
| paid\_media | [PaidMediaInfo](#paidmediainfo) | _Optional_. Message contains paid media; information about the paid media |
| photo | Array of [PhotoSize](#photosize) | _Optional_. Message is a photo, available sizes of the photo |
| sticker | [Sticker](#sticker) | _Optional_. Message is a sticker, information about the sticker |
| story | [Story](#story) | _Optional_. Message is a forwarded story |
| video | [Video](#video) | _Optional_. Message is a video, information about the video |
| video\_note | [VideoNote](#videonote) | _Optional_. Message is a [video note](https://telegram.org/blog/video-messages-and-telescope), information about the video message |
| voice | [Voice](#voice) | _Optional_. Message is a voice message, information about the file |
| has\_media\_spoiler | True | _Optional_. _True_, if the message media is covered by a spoiler animation |
| checklist | [Checklist](#checklist) | _Optional_. Message is a checklist |
| contact | [Contact](#contact) | _Optional_. Message is a shared contact, information about the contact |
| dice | [Dice](#dice) | _Optional_. Message is a dice with random value |
| game | [Game](#game) | _Optional_. Message is a game, information about the game. [More about games »](#games) |
| giveaway | [Giveaway](#giveaway) | _Optional_. Message is a scheduled giveaway, information about the giveaway |
| giveaway\_winners | [GiveawayWinners](#giveawaywinners) | _Optional_. A giveaway with public winners was completed |
| invoice | [Invoice](#invoice) | _Optional_. Message is an invoice for a [payment](#payments), information about the invoice. [More about payments »](#payments) |
| location | [Location](#location) | _Optional_. Message is a shared location, information about the location |
| poll | [Poll](#poll) | _Optional_. Message is a native poll, information about the poll |
| venue | [Venue](#venue) | _Optional_. Message is a venue, information about the venue |

#### ReplyParameters

Describes reply parameters for the message that is being sent.

| Field | Type | Description |
| --- | --- | --- |
| message\_id | Integer | Identifier of the message that will be replied to in the current chat, or in the chat _chat\_id_ if it is specified |
| chat\_id | Integer or String | _Optional_. If the message to be replied to is from a different chat, unique identifier for the chat or username of the bot, supergroup or channel in the format `@username`. Not supported for messages sent on behalf of a business account and messages from channel direct messages chats. |
| allow\_sending\_without\_reply | Boolean | _Optional_. Pass _True_ if the message should be sent even if the specified message to be replied to is not found. Always _False_ for replies in another chat or forum topic. Always _True_ for messages sent on behalf of a business account. |
| quote | String | _Optional_. Quoted part of the message to be replied to; 0-1024 characters after entities parsing. The quote must be an exact substring of the message to be replied to, including _bold_, _italic_, _underline_, _strikethrough_, _spoiler_, _custom\_emoji_, and _date\_time_ entities. The message will fail to send if the quote isn't found in the original message. |
| quote\_parse\_mode | String | _Optional_. Mode for parsing entities in the quote. See [formatting options](#formatting-options) for more details. |
| quote\_entities | Array of [MessageEntity](#messageentity) | _Optional_. A JSON-serialized list of special entities that appear in the quote. It can be specified instead of _quote\_parse\_mode_. |
| quote\_position | Integer | _Optional_. Position of the quote in the original message in UTF-16 code units |
| checklist\_task\_id | Integer | _Optional_. Identifier of the specific checklist task to be replied to |
| poll\_option\_id | String | _Optional_. Persistent identifier of the specific poll option to be replied to |

#### MessageOrigin

This object describes the origin of a message. It can be one of

- [MessageOriginUser](#messageoriginuser)
- [MessageOriginHiddenUser](#messageoriginhiddenuser)
- [MessageOriginChat](#messageoriginchat)
- [MessageOriginChannel](#messageoriginchannel)

#### MessageOriginUser

The message was originally sent by a known user.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the message origin, always “user” |
| date | Integer | Date the message was sent originally in Unix time |
| sender\_user | [User](#user) | User that sent the message originally |

#### MessageOriginHiddenUser

The message was originally sent by an unknown user.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the message origin, always “hidden\_user” |
| date | Integer | Date the message was sent originally in Unix time |
| sender\_user\_name | String | Name of the user that sent the message originally |

#### MessageOriginChat

The message was originally sent on behalf of a chat to a group chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the message origin, always “chat” |
| date | Integer | Date the message was sent originally in Unix time |
| sender\_chat | [Chat](#chat) | Chat that sent the message originally |
| author\_signature | String | _Optional_. For messages originally sent by an anonymous chat administrator, original message author signature |

#### MessageOriginChannel

The message was originally sent to a channel chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the message origin, always “channel” |
| date | Integer | Date the message was sent originally in Unix time |
| chat | [Chat](#chat) | Channel chat to which the message was originally sent |
| message\_id | Integer | Unique message identifier inside the chat |
| author\_signature | String | _Optional_. Signature of the original post author |

#### PhotoSize

This object represents one size of a photo or a [file](#document) / [sticker](#sticker) thumbnail.

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| width | Integer | Photo width |
| height | Integer | Photo height |
| file\_size | Integer | _Optional_. File size in bytes |

#### Animation

This object represents an animation file (GIF or H.264/MPEG-4 AVC video without sound).

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| width | Integer | Video width as defined by the sender |
| height | Integer | Video height as defined by the sender |
| duration | Integer | Duration of the video in seconds as defined by the sender |
| thumbnail | [PhotoSize](#photosize) | _Optional_. Animation thumbnail as defined by the sender |
| file\_name | String | _Optional_. Original animation filename as defined by the sender |
| mime\_type | String | _Optional_. MIME type of the file as defined by the sender |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |

#### Audio

This object represents an audio file to be treated as music by the Telegram clients.

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| duration | Integer | Duration of the audio in seconds as defined by the sender |
| performer | String | _Optional_. Performer of the audio as defined by the sender or by audio tags |
| title | String | _Optional_. Title of the audio as defined by the sender or by audio tags |
| file\_name | String | _Optional_. Original filename as defined by the sender |
| mime\_type | String | _Optional_. MIME type of the file as defined by the sender |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |
| thumbnail | [PhotoSize](#photosize) | _Optional_. Thumbnail of the album cover to which the music file belongs |

#### Document

This object represents a general file (as opposed to [photos](#photosize), [voice messages](#voice) and [audio files](#audio)).

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| thumbnail | [PhotoSize](#photosize) | _Optional_. Document thumbnail as defined by the sender |
| file\_name | String | _Optional_. Original filename as defined by the sender |
| mime\_type | String | _Optional_. MIME type of the file as defined by the sender |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |

#### LivePhoto

This object represents a live photo.

| Field | Type | Description |
| --- | --- | --- |
| photo | Array of [PhotoSize](#photosize) | _Optional_. Available sizes of the corresponding static photo |
| file\_id | String | Identifier for the video file which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for the video file which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| width | Integer | Video width as defined by the sender |
| height | Integer | Video height as defined by the sender |
| duration | Integer | Duration of the video in seconds as defined by the sender |
| mime\_type | String | _Optional_. MIME type of the file as defined by the sender |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |

#### Story

This object represents a story.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | Chat that posted the story |
| id  | Integer | Unique identifier for the story in the chat |

#### VideoQuality

This object represents a video file of a specific quality.

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| width | Integer | Video width |
| height | Integer | Video height |
| codec | String | Codec that was used to encode the video, for example, “h264”, “h265”, or “av01” |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |

#### Video

This object represents a video file.

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| width | Integer | Video width as defined by the sender |
| height | Integer | Video height as defined by the sender |
| duration | Integer | Duration of the video in seconds as defined by the sender |
| thumbnail | [PhotoSize](#photosize) | _Optional_. Video thumbnail |
| cover | Array of [PhotoSize](#photosize) | _Optional_. Available sizes of the cover of the video in the message |
| start\_timestamp | Integer | _Optional_. Timestamp in seconds from which the video will play in the message |
| qualities | Array of [VideoQuality](#videoquality) | _Optional_. List of available qualities of the video |
| file\_name | String | _Optional_. Original filename as defined by the sender |
| mime\_type | String | _Optional_. MIME type of the file as defined by the sender |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |

#### VideoNote

This object represents a [video message](https://telegram.org/blog/video-messages-and-telescope) (available in Telegram apps as of [v.4.0](https://telegram.org/blog/video-messages-and-telescope)).

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| length | Integer | Video width and height (diameter of the video message) as defined by the sender |
| duration | Integer | Duration of the video in seconds as defined by the sender |
| thumbnail | [PhotoSize](#photosize) | _Optional_. Video thumbnail |
| file\_size | Integer | _Optional_. File size in bytes |

#### Voice

This object represents a voice note.

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| duration | Integer | Duration of the audio in seconds as defined by the sender |
| mime\_type | String | _Optional_. MIME type of the file as defined by the sender |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |

#### PaidMediaInfo

Describes the paid media added to a message.

| Field | Type | Description |
| --- | --- | --- |
| star\_count | Integer | The number of Telegram Stars that must be paid to buy access to the media |
| paid\_media | Array of [PaidMedia](#paidmedia) | Information about the paid media |

#### PaidMedia

This object describes paid media. Currently, it can be one of

- [PaidMediaLivePhoto](#paidmedialivephoto)
- [PaidMediaPhoto](#paidmediaphoto)
- [PaidMediaPreview](#paidmediapreview)
- [PaidMediaVideo](#paidmediavideo)

#### PaidMediaLivePhoto

The paid media is a [live photo](#livephoto).

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the paid media, always “live\_photo” |
| live\_photo | [LivePhoto](#livephoto) | The photo |

#### PaidMediaPhoto

The paid media is a photo.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the paid media, always “photo” |
| photo | Array of [PhotoSize](#photosize) | The photo |

#### PaidMediaPreview

The paid media isn't available before the payment.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the paid media, always “preview” |
| width | Integer | _Optional_. Media width as defined by the sender |
| height | Integer | _Optional_. Media height as defined by the sender |
| duration | Integer | _Optional_. Duration of the media in seconds as defined by the sender |

#### PaidMediaVideo

The paid media is a video.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the paid media, always “video” |
| video | [Video](#video) | The video |

#### Contact

This object represents a phone contact.

| Field | Type | Description |
| --- | --- | --- |
| phone\_number | String | Contact's phone number |
| first\_name | String | Contact's first name |
| last\_name | String | _Optional_. Contact's last name |
| user\_id | Integer | _Optional_. Contact's user identifier in Telegram. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a 64-bit integer or double-precision float type are safe for storing this identifier. |
| vcard | String | _Optional_. Additional data about the contact in the form of a [vCard](https://en.wikipedia.org/wiki/VCard) |

#### Dice

This object represents an animated emoji that displays a random value.

| Field | Type | Description |
| --- | --- | --- |
| emoji | String | Emoji on which the dice throw animation is based |
| value | Integer | Value of the dice, 1-6 for “🎲”, “🎯” and “🎳” base emoji, 1-5 for “🏀” and “⚽” base emoji, 1-64 for “🎰” base emoji |

#### Link

Represents an HTTP link.

| Field | Type | Description |
| --- | --- | --- |
| url | String | URL of the link |

#### PollMedia

At most **one** of the optional fields can be present in any given object.

| Field | Type | Description |
| --- | --- | --- |
| animation | [Animation](#animation) | _Optional_. Media is an animation, information about the animation |
| audio | [Audio](#audio) | _Optional_. Media is an audio file, information about the file; currently, can't be received in a poll option |
| document | [Document](#document) | _Optional_. Media is a general file, information about the file; currently, can't be received in a poll option |
| link | [Link](#link) | _Optional_. The HTTP link attached to the poll option |
| live\_photo | [LivePhoto](#livephoto) | _Optional_. Media is a live photo, information about the live photo |
| location | [Location](#location) | _Optional_. Media is a shared location, information about the location |
| photo | Array of [PhotoSize](#photosize) | _Optional_. Media is a photo, available sizes of the photo |
| sticker | [Sticker](#sticker) | _Optional_. Media is a sticker, information about the sticker; currently, for poll options only |
| venue | [Venue](#venue) | _Optional_. Media is a venue, information about the venue |
| video | [Video](#video) | _Optional_. Media is a video, information about the video |

#### InputPollMedia

This object represents the content of a poll description or a quiz explanation to be sent. It should be one of

- [InputMediaAnimation](#inputmediaanimation)
- [InputMediaAudio](#inputmediaaudio)
- [InputMediaDocument](#inputmediadocument)
- [InputMediaLivePhoto](#inputmedialivephoto)
- [InputMediaLocation](#inputmedialocation)
- [InputMediaPhoto](#inputmediaphoto)
- [InputMediaVenue](#inputmediavenue)
- [InputMediaVideo](#inputmediavideo)

#### InputPollOptionMedia

This object represents the content of a poll option to be sent. It should be one of

- [InputMediaAnimation](#inputmediaanimation)
- [InputMediaLink](#inputmedialink)
- [InputMediaLivePhoto](#inputmedialivephoto)
- [InputMediaLocation](#inputmedialocation)
- [InputMediaPhoto](#inputmediaphoto)
- [InputMediaSticker](#inputmediasticker)
- [InputMediaVenue](#inputmediavenue)
- [InputMediaVideo](#inputmediavideo)

#### PollOption

This object contains information about one answer option in a poll.

| Field | Type | Description |
| --- | --- | --- |
| persistent\_id | String | Unique identifier of the option, persistent on option addition and deletion |
| text | String | Option text, 1-100 characters |
| text\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the option _text_. Currently, only custom emoji entities are allowed in poll option texts |
| media | [PollMedia](#pollmedia) | _Optional_. Media added to the poll option |
| voter\_count | Integer | Number of users who voted for this option; may be 0 if unknown |
| added\_by\_user | [User](#user) | _Optional_. User who added the option; omitted if the option wasn't added by a user after poll creation |
| added\_by\_chat | [Chat](#chat) | _Optional_. Chat that added the option; omitted if the option wasn't added by a chat after poll creation |
| addition\_date | Integer | _Optional_. Point in time (Unix timestamp) when the option was added; omitted if the option existed in the original poll |

#### InputPollOption

This object contains information about one answer option in a poll to be sent.

| Field | Type | Description |
| --- | --- | --- |
| text | String | Option text, 1-100 characters |
| text\_parse\_mode | String | _Optional_. Mode for parsing entities in the text. See [formatting options](#formatting-options) for more details. Currently, only custom emoji entities are allowed. |
| text\_entities | Array of [MessageEntity](#messageentity) | _Optional_. A JSON-serialized list of special entities that appear in the poll option text. It can be specified instead of _text\_parse\_mode_. |
| media | [InputPollOptionMedia](#inputpolloptionmedia) | _Optional_. Media added to the poll option |

#### PollAnswer

This object represents an answer of a user in a non-anonymous poll.

| Field | Type | Description |
| --- | --- | --- |
| poll\_id | String | Unique poll identifier |
| voter\_chat | [Chat](#chat) | _Optional_. The chat that changed the answer to the poll, if the voter is anonymous |
| user | [User](#user) | _Optional_. The user that changed the answer to the poll, if the voter isn't anonymous |
| option\_ids | Array of Integer | 0-based identifiers of chosen answer options. May be empty if the vote was retracted. |
| option\_persistent\_ids | Array of String | Persistent identifiers of the chosen answer options. May be empty if the vote was retracted. |

#### Poll

This object contains information about a poll.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique poll identifier |
| question | String | Poll question, 1-300 characters |
| question\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the _question_. Currently, only custom emoji entities are allowed in poll questions |
| options | Array of [PollOption](#polloption) | List of poll options |
| total\_voter\_count | Integer | Total number of users that voted in the poll |
| is\_closed | Boolean | _True_, if the poll is closed |
| is\_anonymous | Boolean | _True_, if the poll is anonymous |
| type | String | Poll type, currently can be “regular” or “quiz” |
| allows\_multiple\_answers | Boolean | _True_, if the poll allows multiple answers |
| allows\_revoting | Boolean | _True_, if the poll allows to change the chosen answer options |
| members\_only | Boolean | _True_ if voting is limited to users who have been members of the chat where the poll was originally sent for more than 24 hours |
| country\_codes | Array of String | _Optional_. A list of two-letter [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) country codes indicating the countries from which users can vote in the poll. The country code “FT” is used for users with anonymous numbers. If omitted, then users from any country can participate in the poll. |
| correct\_option\_ids | Array of Integer | _Optional_. Array of 0-based identifiers of the correct answer options. Available only for polls in quiz mode which are closed or were sent (not forwarded) by the bot or to the private chat with the bot. |
| explanation | String | _Optional_. Text that is shown when a user chooses an incorrect answer or taps on the lamp icon in a quiz-style poll, 0-200 characters |
| explanation\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities like usernames, URLs, bot commands, etc. that appear in the _explanation_ |
| explanation\_media | [PollMedia](#pollmedia) | _Optional_. Media added to the quiz explanation |
| open\_period | Integer | _Optional_. Amount of time in seconds the poll will be active after creation |
| close\_date | Integer | _Optional_. Point in time (Unix timestamp) when the poll will be automatically closed |
| description | String | _Optional_. Description of the poll; for polls inside the [Message](#message) object only |
| description\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities like usernames, URLs, bot commands, etc. that appear in the description |
| media | [PollMedia](#pollmedia) | _Optional_. Media added to the poll description; for polls inside the [Message](#message) object only |

#### ChecklistTask

Describes a task in a checklist.

| Field | Type | Description |
| --- | --- | --- |
| id  | Integer | Unique identifier of the task |
| text | String | Text of the task |
| text\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the task text |
| completed\_by\_user | [User](#user) | _Optional_. User that completed the task; omitted if the task wasn't completed by a user |
| completed\_by\_chat | [Chat](#chat) | _Optional_. Chat that completed the task; omitted if the task wasn't completed by a chat |
| completion\_date | Integer | _Optional_. Point in time (Unix timestamp) when the task was completed; 0 if the task wasn't completed |

#### Checklist

Describes a checklist.

| Field | Type | Description |
| --- | --- | --- |
| title | String | Title of the checklist |
| title\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the checklist title |
| tasks | Array of [ChecklistTask](#checklisttask) | List of tasks in the checklist |
| others\_can\_add\_tasks | True | _Optional_. _True_, if users other than the creator of the list can add tasks to the list |
| others\_can\_mark\_tasks\_as\_done | True | _Optional_. _True_, if users other than the creator of the list can mark tasks as done or not done |

#### InputChecklistTask

Describes a task to add to a checklist.

| Field | Type | Description |
| --- | --- | --- |
| id  | Integer | Unique identifier of the task; must be positive and unique among all task identifiers currently present in the checklist |
| text | String | Text of the task; 1-100 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the text. See [formatting options](#formatting-options) for more details. |
| text\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the text, which can be specified instead of parse\_mode. Currently, only _bold_, _italic_, _underline_, _strikethrough_, _spoiler_, _custom\_emoji_, and _date\_time_ entities are allowed. |

#### InputChecklist

Describes a checklist to create.

| Field | Type | Description |
| --- | --- | --- |
| title | String | Title of the checklist; 1-255 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the title. See [formatting options](#formatting-options) for more details. |
| title\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the title, which can be specified instead of parse\_mode. Currently, only _bold_, _italic_, _underline_, _strikethrough_, _spoiler_, _custom\_emoji_, and _date\_time_ entities are allowed. |
| tasks | Array of [InputChecklistTask](#inputchecklisttask) | List of 1-30 tasks in the checklist |
| others\_can\_add\_tasks | Boolean | _Optional_. Pass _True_ if other users can add tasks to the checklist |
| others\_can\_mark\_tasks\_as\_done | Boolean | _Optional_. Pass _True_ if other users can mark tasks as done or not done in the checklist |

#### ChecklistTasksDone

Describes a service message about checklist tasks marked as done or not done.

| Field | Type | Description |
| --- | --- | --- |
| checklist\_message | [Message](#message) | _Optional_. Message containing the checklist whose tasks were marked as done or not done. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| marked\_as\_done\_task\_ids | Array of Integer | _Optional_. Identifiers of the tasks that were marked as done |
| marked\_as\_not\_done\_task\_ids | Array of Integer | _Optional_. Identifiers of the tasks that were marked as not done |

#### ChecklistTasksAdded

Describes a service message about tasks added to a checklist.

| Field | Type | Description |
| --- | --- | --- |
| checklist\_message | [Message](#message) | _Optional_. Message containing the checklist to which the tasks were added. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| tasks | Array of [ChecklistTask](#checklisttask) | List of tasks added to the checklist |

#### Location

This object represents a point on the map.

| Field | Type | Description |
| --- | --- | --- |
| latitude | Float | Latitude as defined by the sender |
| longitude | Float | Longitude as defined by the sender |
| horizontal\_accuracy | Float | _Optional_. The radius of uncertainty for the location, measured in meters; 0-1500 |
| live\_period | Integer | _Optional_. Time relative to the message sending date, during which the location can be updated; in seconds. For active live locations only. |
| heading | Integer | _Optional_. The direction in which user is moving, in degrees; 1-360. For active live locations only. |
| proximity\_alert\_radius | Integer | _Optional_. The maximum distance for proximity alerts about approaching another chat member, in meters. For sent live locations only. |

#### Venue

This object represents a venue.

| Field | Type | Description |
| --- | --- | --- |
| location | [Location](#location) | Venue location. Can't be a live location. |
| title | String | Name of the venue |
| address | String | Address of the venue |
| foursquare\_id | String | _Optional_. Foursquare identifier of the venue |
| foursquare\_type | String | _Optional_. Foursquare type of the venue. (For example, “arts\_entertainment/default”, “arts\_entertainment/aquarium” or “food/icecream”.) |
| google\_place\_id | String | _Optional_. Google Places identifier of the venue |
| google\_place\_type | String | _Optional_. Google Places type of the venue. (See [supported types](https://developers.google.com/places/web-service/supported_types).) |

#### WebAppData

Describes data sent from a [Web App](https://core.telegram.org/bots/webapps) to the bot.

| Field | Type | Description |
| --- | --- | --- |
| data | String | The data. Be aware that a bad client can send arbitrary data in this field. |
| button\_text | String | Text of the _web\_app_ keyboard button from which the Web App was opened. Be aware that a bad client can send arbitrary data in this field. |

#### ProximityAlertTriggered

This object represents the content of a service message, sent whenever a user in the chat triggers a proximity alert set by another user.

| Field | Type | Description |
| --- | --- | --- |
| traveler | [User](#user) | User that triggered the alert |
| watcher | [User](#user) | User that set the alert |
| distance | Integer | The distance between the users |

#### MessageAutoDeleteTimerChanged

This object represents a service message about a change in auto-delete timer settings.

| Field | Type | Description |
| --- | --- | --- |
| message\_auto\_delete\_time | Integer | New auto-delete time for messages in the chat; in seconds |

#### ManagedBotCreated

This object contains information about the bot that was created to be managed by the current bot.

| Field | Type | Description |
| --- | --- | --- |
| bot | [User](#user) | Information about the bot. The bot's token can be fetched using the method [getManagedBotToken](#getmanagedbottoken). |

#### ManagedBotUpdated

This object contains information about the creation, token update, or owner update of a bot that is managed by the current bot.

| Field | Type | Description |
| --- | --- | --- |
| user | [User](#user) | User that created the bot |
| bot | [User](#user) | Information about the bot. Token of the bot can be fetched using the method [getManagedBotToken](#getmanagedbottoken). |

#### PollOptionAdded

Describes a service message about an option added to a poll.

| Field | Type | Description |
| --- | --- | --- |
| poll\_message | [MaybeInaccessibleMessage](#maybeinaccessiblemessage) | _Optional_. Message containing the poll to which the option was added, if known. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| option\_persistent\_id | String | Unique identifier of the added option |
| option\_text | String | Option text |
| option\_text\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the _option\_text_ |

#### PollOptionDeleted

Describes a service message about an option deleted from a poll.

| Field | Type | Description |
| --- | --- | --- |
| poll\_message | [MaybeInaccessibleMessage](#maybeinaccessiblemessage) | _Optional_. Message containing the poll from which the option was deleted, if known. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| option\_persistent\_id | String | Unique identifier of the deleted option |
| option\_text | String | Option text |
| option\_text\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the _option\_text_ |

#### ChatBoostAdded

This object represents a service message about a user boosting a chat.

| Field | Type | Description |
| --- | --- | --- |
| boost\_count | Integer | Number of boosts added by the user |

#### BackgroundFill

This object describes the way a background is filled based on the selected colors. Currently, it can be one of

- [BackgroundFillSolid](#backgroundfillsolid)
- [BackgroundFillGradient](#backgroundfillgradient)
- [BackgroundFillFreeformGradient](#backgroundfillfreeformgradient)

#### BackgroundFillSolid

The background is filled using the selected color.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the background fill, always “solid” |
| color | Integer | The color of the background fill in the RGB24 format |

#### BackgroundFillGradient

The background is a gradient fill.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the background fill, always “gradient” |
| top\_color | Integer | Top color of the gradient in the RGB24 format |
| bottom\_color | Integer | Bottom color of the gradient in the RGB24 format |
| rotation\_angle | Integer | Clockwise rotation angle of the background fill in degrees; 0-359 |

#### BackgroundFillFreeformGradient

The background is a freeform gradient that rotates after every message in the chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the background fill, always “freeform\_gradient” |
| colors | Array of Integer | A list of the 3 or 4 base colors that are used to generate the freeform gradient in the RGB24 format |

#### BackgroundType

This object describes the type of a background. Currently, it can be one of

- [BackgroundTypeFill](#backgroundtypefill)
- [BackgroundTypeWallpaper](#backgroundtypewallpaper)
- [BackgroundTypePattern](#backgroundtypepattern)
- [BackgroundTypeChatTheme](#backgroundtypechattheme)

#### BackgroundTypeFill

The background is automatically filled based on the selected colors.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the background, always “fill” |
| fill | [BackgroundFill](#backgroundfill) | The background fill |
| dark\_theme\_dimming | Integer | Dimming of the background in dark themes, as a percentage; 0-100 |

#### BackgroundTypeWallpaper

The background is a wallpaper in the JPEG format.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the background, always “wallpaper” |
| document | [Document](#document) | Document with the wallpaper |
| dark\_theme\_dimming | Integer | Dimming of the background in dark themes, as a percentage; 0-100 |
| is\_blurred | True | _Optional_. _True_, if the wallpaper is downscaled to fit in a 450x450 square and then box-blurred with radius 12 |
| is\_moving | True | _Optional_. _True_, if the background moves slightly when the device is tilted |

#### BackgroundTypePattern

The background is a .PNG or .TGV (gzipped subset of SVG with MIME type “application/x-tgwallpattern”) pattern to be combined with the background fill chosen by the user.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the background, always “pattern” |
| document | [Document](#document) | Document with the pattern |
| fill | [BackgroundFill](#backgroundfill) | The background fill that is combined with the pattern |
| intensity | Integer | Intensity of the pattern when it is shown above the filled background; 0-100 |
| is\_inverted | True | _Optional_. _True_, if the background fill must be applied only to the pattern itself. All other pixels are black in this case. For dark themes only. |
| is\_moving | True | _Optional_. _True_, if the background moves slightly when the device is tilted |

#### BackgroundTypeChatTheme

The background is taken directly from a built-in chat theme.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the background, always “chat\_theme” |
| theme\_name | String | Name of the chat theme, which is usually an emoji |

#### ChatBackground

This object represents a chat background.

| Field | Type | Description |
| --- | --- | --- |
| type | [BackgroundType](#backgroundtype) | Type of the background |

#### ForumTopicCreated

This object represents a service message about a new forum topic created in the chat.

| Field | Type | Description |
| --- | --- | --- |
| name | String | Name of the topic |
| icon\_color | Integer | Color of the topic icon in RGB format |
| icon\_custom\_emoji\_id | String | _Optional_. Unique identifier of the custom emoji shown as the topic icon |
| is\_name\_implicit | True | _Optional_. _True_, if the name of the topic wasn't specified explicitly by its creator and likely needs to be changed by the bot |

#### ForumTopicClosed

This object represents a service message about a forum topic closed in the chat. Currently holds no information.

#### ForumTopicEdited

This object represents a service message about an edited forum topic.

| Field | Type | Description |
| --- | --- | --- |
| name | String | _Optional_. New name of the topic, if it was edited |
| icon\_custom\_emoji\_id | String | _Optional_. New identifier of the custom emoji shown as the topic icon, if it was edited; an empty string if the icon was removed |

#### ForumTopicReopened

This object represents a service message about a forum topic reopened in the chat. Currently holds no information.

#### GeneralForumTopicHidden

This object represents a service message about General forum topic hidden in the chat. Currently holds no information.

#### GeneralForumTopicUnhidden

This object represents a service message about General forum topic unhidden in the chat. Currently holds no information.

#### SharedUser

This object contains information about a user that was shared with the bot using a [KeyboardButtonRequestUsers](#keyboardbuttonrequestusers) button.

| Field | Type | Description |
| --- | --- | --- |
| user\_id | Integer | Identifier of the shared user. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so 64-bit integers or double-precision float types are safe for storing these identifiers. The bot may not have access to the user and could be unable to use this identifier, unless the user is already known to the bot by some other means. |
| first\_name | String | _Optional_. First name of the user, if the name was requested by the bot |
| last\_name | String | _Optional_. Last name of the user, if the name was requested by the bot |
| username | String | _Optional_. Username of the user, if the username was requested by the bot |
| photo | Array of [PhotoSize](#photosize) | _Optional_. Available sizes of the chat photo, if the photo was requested by the bot |

#### UsersShared

This object contains information about the users whose identifiers were shared with the bot using a [KeyboardButtonRequestUsers](#keyboardbuttonrequestusers) button.

| Field | Type | Description |
| --- | --- | --- |
| request\_id | Integer | Identifier of the request |
| users | Array of [SharedUser](#shareduser) | Information about users shared with the bot |

#### ChatShared

This object contains information about a chat that was shared with the bot using a [KeyboardButtonRequestChat](#keyboardbuttonrequestchat) button.

| Field | Type | Description |
| --- | --- | --- |
| request\_id | Integer | Identifier of the request |
| chat\_id | Integer | Identifier of the shared chat. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a 64-bit integer or double-precision float type are safe for storing this identifier. The bot may not have access to the chat and could be unable to use this identifier, unless the chat is already known to the bot by some other means. |
| title | String | _Optional_. Title of the chat, if the title was requested by the bot |
| username | String | _Optional_. Username of the chat, if the username was requested by the bot and available |
| photo | Array of [PhotoSize](#photosize) | _Optional_. Available sizes of the chat photo, if the photo was requested by the bot |

#### WriteAccessAllowed

This object represents a service message about a user allowing a bot to write messages after adding it to the attachment menu, launching a Web App from a link, or accepting an explicit request from a Web App sent by the method [requestWriteAccess](https://core.telegram.org/bots/webapps#initializing-mini-apps).

| Field | Type | Description |
| --- | --- | --- |
| from\_request | Boolean | _Optional_. _True_, if the access was granted after the user accepted an explicit request from a Web App sent by the method [requestWriteAccess](https://core.telegram.org/bots/webapps#initializing-mini-apps) |
| web\_app\_name | String | _Optional_. Name of the Web App, if the access was granted when the Web App was launched from a link |
| from\_attachment\_menu | Boolean | _Optional_. _True_, if the access was granted when the bot was added to the attachment or side menu |

#### VideoChatScheduled

This object represents a service message about a video chat scheduled in the chat.

| Field | Type | Description |
| --- | --- | --- |
| start\_date | Integer | Point in time (Unix timestamp) when the video chat is supposed to be started by a chat administrator |

#### VideoChatStarted

This object represents a service message about a video chat started in the chat. Currently holds no information.

#### VideoChatEnded

This object represents a service message about a video chat ended in the chat.

| Field | Type | Description |
| --- | --- | --- |
| duration | Integer | Video chat duration in seconds |

#### VideoChatParticipantsInvited

This object represents a service message about new members invited to a video chat.

| Field | Type | Description |
| --- | --- | --- |
| users | Array of [User](#user) | New members that were invited to the video chat |

#### PaidMessagePriceChanged

Describes a service message about a change in the price of paid messages within a chat.

| Field | Type | Description |
| --- | --- | --- |
| paid\_message\_star\_count | Integer | The new number of Telegram Stars that must be paid by non-administrator users of the supergroup chat for each sent message |

#### DirectMessagePriceChanged

Describes a service message about a change in the price of direct messages sent to a channel chat.

| Field | Type | Description |
| --- | --- | --- |
| are\_direct\_messages\_enabled | Boolean | _True_, if direct messages are enabled for the channel chat; false otherwise |
| direct\_message\_star\_count | Integer | _Optional_. The new number of Telegram Stars that must be paid by users for each direct message sent to the channel. Does not apply to users who have been exempted by administrators. Defaults to 0. |

#### SuggestedPostApproved

Describes a service message about the approval of a suggested post.

| Field | Type | Description |
| --- | --- | --- |
| suggested\_post\_message | [Message](#message) | _Optional_. Message containing the suggested post. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| price | [SuggestedPostPrice](#suggestedpostprice) | _Optional_. Amount paid for the post |
| send\_date | Integer | Date when the post will be published |

#### SuggestedPostApprovalFailed

Describes a service message about the failed approval of a suggested post. Currently, only caused by insufficient user funds at the time of approval.

| Field | Type | Description |
| --- | --- | --- |
| suggested\_post\_message | [Message](#message) | _Optional_. Message containing the suggested post whose approval has failed. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| price | [SuggestedPostPrice](#suggestedpostprice) | Expected price of the post |

#### SuggestedPostDeclined

Describes a service message about the rejection of a suggested post.

| Field | Type | Description |
| --- | --- | --- |
| suggested\_post\_message | [Message](#message) | _Optional_. Message containing the suggested post. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| comment | String | _Optional_. Comment with which the post was declined |

#### SuggestedPostPaid

Describes a service message about a successful payment for a suggested post.

| Field | Type | Description |
| --- | --- | --- |
| suggested\_post\_message | [Message](#message) | _Optional_. Message containing the suggested post. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| currency | String | Currency in which the payment was made. Currently, one of “XTR” for Telegram Stars or “TON” for toncoins. |
| amount | Integer | _Optional_. The amount of the currency that was received by the channel in nanotoncoins; for payments in toncoins only |
| star\_amount | [StarAmount](#staramount) | _Optional_. The amount of Telegram Stars that was received by the channel; for payments in Telegram Stars only |

#### SuggestedPostRefunded

Describes a service message about a payment refund for a suggested post.

| Field | Type | Description |
| --- | --- | --- |
| suggested\_post\_message | [Message](#message) | _Optional_. Message containing the suggested post. Note that the [Message](#message) object in this field will not contain the _reply\_to\_message_ field even if it itself is a reply. |
| reason | String | Reason for the refund. Currently, one of “post\_deleted” if the post was deleted within 24 hours of being posted or removed from scheduled messages without being posted, or “payment\_refunded” if the payer refunded their payment. |

#### GiveawayCreated

This object represents a service message about the creation of a scheduled giveaway.

| Field | Type | Description |
| --- | --- | --- |
| prize\_star\_count | Integer | _Optional_. The number of Telegram Stars to be split between giveaway winners; for Telegram Star giveaways only |

#### Giveaway

This object represents a message about a scheduled giveaway.

| Field | Type | Description |
| --- | --- | --- |
| chats | Array of [Chat](#chat) | The list of chats which the user must join to participate in the giveaway |
| winners\_selection\_date | Integer | Point in time (Unix timestamp) when winners of the giveaway will be selected |
| winner\_count | Integer | The number of users which are supposed to be selected as winners of the giveaway |
| only\_new\_members | True | _Optional_. _True_, if only users who join the chats after the giveaway started should be eligible to win |
| has\_public\_winners | True | _Optional_. _True_, if the list of giveaway winners will be visible to everyone |
| prize\_description | String | _Optional_. Description of additional giveaway prize |
| country\_codes | Array of String | _Optional_. A list of two-letter [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) country codes indicating the countries from which eligible users for the giveaway must come. If empty, then all users can participate in the giveaway. Users with a phone number that was bought on Fragment can always participate in giveaways. |
| prize\_star\_count | Integer | _Optional_. The number of Telegram Stars to be split between giveaway winners; for Telegram Star giveaways only |
| premium\_subscription\_month\_count | Integer | _Optional_. The number of months the Telegram Premium subscription won from the giveaway will be active for; for Telegram Premium giveaways only |

#### GiveawayWinners

This object represents a message about the completion of a giveaway with public winners.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | The chat that created the giveaway |
| giveaway\_message\_id | Integer | Identifier of the message with the giveaway in the chat |
| winners\_selection\_date | Integer | Point in time (Unix timestamp) when winners of the giveaway were selected |
| winner\_count | Integer | Total number of winners in the giveaway |
| winners | Array of [User](#user) | List of up to 100 winners of the giveaway |
| additional\_chat\_count | Integer | _Optional_. The number of other chats the user had to join in order to be eligible for the giveaway |
| prize\_star\_count | Integer | _Optional_. The number of Telegram Stars that were split between giveaway winners; for Telegram Star giveaways only |
| premium\_subscription\_month\_count | Integer | _Optional_. The number of months the Telegram Premium subscription won from the giveaway will be active for; for Telegram Premium giveaways only |
| unclaimed\_prize\_count | Integer | _Optional_. Number of undistributed prizes |
| only\_new\_members | True | _Optional_. _True_, if only users who had joined the chats after the giveaway started were eligible to win |
| was\_refunded | True | _Optional_. _True_, if the giveaway was canceled because the payment for it was refunded |
| prize\_description | String | _Optional_. Description of additional giveaway prize |

#### GiveawayCompleted

This object represents a service message about the completion of a giveaway without public winners.

| Field | Type | Description |
| --- | --- | --- |
| winner\_count | Integer | Number of winners in the giveaway |
| unclaimed\_prize\_count | Integer | _Optional_. Number of undistributed prizes |
| giveaway\_message | [Message](#message) | _Optional_. Message with the giveaway that was completed, if it wasn't deleted |
| is\_star\_giveaway | True | _Optional_. _True_, if the giveaway is a Telegram Star giveaway. Otherwise, currently, the giveaway is a Telegram Premium giveaway. |

#### LinkPreviewOptions

Describes the options used for link preview generation.

| Field | Type | Description |
| --- | --- | --- |
| is\_disabled | Boolean | _Optional_. _True_, if the link preview is disabled |
| url | String | _Optional_. URL to use for the link preview. If empty, then the first URL found in the message text will be used. |
| prefer\_small\_media | Boolean | _Optional_. _True_, if the media in the link preview is supposed to be shrunk; ignored if the URL isn't explicitly specified or media size change isn't supported for the preview |
| prefer\_large\_media | Boolean | _Optional_. _True_, if the media in the link preview is supposed to be enlarged; ignored if the URL isn't explicitly specified or media size change isn't supported for the preview |
| show\_above\_text | Boolean | _Optional_. _True_, if the link preview must be shown above the message text; otherwise, the link preview will be shown below the message text |

#### SuggestedPostPrice

Describes the price of a suggested post.

| Field | Type | Description |
| --- | --- | --- |
| currency | String | Currency in which the post will be paid. Currently, must be one of “XTR” for Telegram Stars or “TON” for toncoins. |
| amount | Integer | The amount of the currency that will be paid for the post in the _smallest units_ of the currency, i.e. Telegram Stars or nanotoncoins. Currently, price in Telegram Stars must be between 5 and 100000, and price in nanotoncoins must be between 10000000 and 10000000000000. |

#### SuggestedPostInfo

Contains information about a suggested post.

| Field | Type | Description |
| --- | --- | --- |
| state | String | State of the suggested post. Currently, it can be one of “pending”, “approved”, “declined”. |
| price | [SuggestedPostPrice](#suggestedpostprice) | _Optional_. Proposed price of the post. If the field is omitted, then the post is unpaid. |
| send\_date | Integer | _Optional_. Proposed send date of the post. If the field is omitted, then the post can be published at any time within 30 days at the sole discretion of the user or administrator who approves it. |

#### SuggestedPostParameters

Contains parameters of a post that is being suggested by the bot.

| Field | Type | Description |
| --- | --- | --- |
| price | [SuggestedPostPrice](#suggestedpostprice) | _Optional_. Proposed price for the post. If the field is omitted, then the post is unpaid. |
| send\_date | Integer | _Optional_. Proposed send date of the post. If specified, then the date must be between 300 second and 2678400 seconds (30 days) in the future. If the field is omitted, then the post can be published at any time within 30 days at the sole discretion of the user who approves it. |

#### DirectMessagesTopic

Describes a topic of a direct messages chat.

| Field | Type | Description |
| --- | --- | --- |
| topic\_id | Integer | Unique identifier of the topic. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a 64-bit integer or double-precision float type are safe for storing this identifier. |
| user | [User](#user) | _Optional_. Information about the user that created the topic. Currently, it is always present. |

#### UserProfilePhotos

This object represent a user's profile pictures.

| Field | Type | Description |
| --- | --- | --- |
| total\_count | Integer | Total number of profile pictures the target user has |
| photos | Array of Array of [PhotoSize](#photosize) | Requested profile pictures (in up to 4 sizes each) |

#### UserProfileAudios

This object represents the audios displayed on a user's profile.

| Field | Type | Description |
| --- | --- | --- |
| total\_count | Integer | Total number of profile audios for the target user |
| audios | Array of [Audio](#audio) | Requested profile audios |

#### File

This object represents a file ready to be downloaded. The file can be downloaded via the link `https://api.telegram.org/file/bot<token>/<file_path>`. It is guaranteed that the link will be valid for at least 1 hour. When the link expires, a new one can be requested by calling [getFile](#getfile).

> The maximum file size to download is 20 MB

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| file\_size | Integer | _Optional_. File size in bytes. It can be bigger than 2^31 and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this value. |
| file\_path | String | _Optional_. File path. Use `https://api.telegram.org/file/bot<token>/<file_path>` to get the file. |

#### WebAppInfo

Describes a [Web App](https://core.telegram.org/bots/webapps).

| Field | Type | Description |
| --- | --- | --- |
| url | String | An HTTPS URL of a Web App to be opened with additional data as specified in [Initializing Web Apps](https://core.telegram.org/bots/webapps#initializing-mini-apps) |

#### ReplyKeyboardMarkup

This object represents a custom keyboard with reply options (see Introduction to bots for details and examples). Not supported in channels and for messages sent on behalf of a business account.

| Field | Type | Description |
| --- | --- | --- |
| keyboard | Array of Array of [KeyboardButton](#keyboardbutton) | Array of button rows, each represented by an Array of [KeyboardButton](#keyboardbutton) objects |
| is\_persistent | Boolean | _Optional_. Requests clients to always show the keyboard when the regular keyboard is hidden. Defaults to _false_, in which case the custom keyboard can be hidden and opened with a keyboard icon. |
| resize\_keyboard | Boolean | _Optional_. Requests clients to resize the keyboard vertically for optimal fit (e.g., make the keyboard smaller if there are just two rows of buttons). Defaults to _false_, in which case the custom keyboard is always of the same height as the app's standard keyboard. |
| one\_time\_keyboard | Boolean | _Optional_. Requests clients to hide the keyboard as soon as it's been used. The keyboard will still be available, but clients will automatically display the usual letter-keyboard in the chat - the user can press a special button in the input field to see the custom keyboard again. Defaults to _false_. |
| input\_field\_placeholder | String | _Optional_. The placeholder to be shown in the input field when the keyboard is active; 1-64 characters |
| selective | Boolean | _Optional_. Use this parameter if you want to show the keyboard to specific users only. Targets: 1) users that are @mentioned in the _text_ of the [Message](#message) object; 2) if the bot's message is a reply to a message in the same chat and forum topic, sender of the original message.  <br>  <br>_Example:_ A user requests to change the bot's language, bot replies to the request with a keyboard to select the new language. Other users in the group don't see the keyboard. |

#### KeyboardButton

This object represents one button of the reply keyboard. At most one of the fields other than _text_, _icon\_custom\_emoji\_id_, and _style_ must be used to specify the type of the button. For simple text buttons, _String_ can be used instead of this object to specify the button text.

| Field | Type | Description |
| --- | --- | --- |
| text | String | Text of the button. If none of the fields other than _text_, _icon\_custom\_emoji\_id_, and _style_ are used, it will be sent as a message when the button is pressed. |
| icon\_custom\_emoji\_id | String | _Optional_. Unique identifier of the custom emoji shown before the text of the button. Can only be used by bots that purchased additional usernames on [Fragment](https://fragment.com/) or in the messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription. |
| style | String | _Optional_. Style of the button. Must be one of “danger” (red), “success” (green) or “primary” (blue). If omitted, then an app-specific style is used. |
| request\_users | [KeyboardButtonRequestUsers](#keyboardbuttonrequestusers) | _Optional_. If specified, pressing the button will open a list of suitable users. Identifiers of selected users will be sent to the bot in a “users\_shared” service message. Available in private chats only. |
| request\_chat | [KeyboardButtonRequestChat](#keyboardbuttonrequestchat) | _Optional_. If specified, pressing the button will open a list of suitable chats. Tapping on a chat will send its identifier to the bot in a “chat\_shared” service message. Available in private chats only. |
| request\_managed\_bot | [KeyboardButtonRequestManagedBot](#keyboardbuttonrequestmanagedbot) | _Optional_. If specified, pressing the button will ask the user to create and share a bot that will be managed by the current bot. Available for bots that enabled management of other bots in the [@BotFather](https://t.me/BotFather) Mini App. Available in private chats only. |
| request\_contact | Boolean | _Optional_. If _True_, the user's phone number will be sent as a contact when the button is pressed. Available in private chats only. |
| request\_location | Boolean | _Optional_. If _True_, the user's current location will be sent when the button is pressed. Available in private chats only. |
| request\_poll | [KeyboardButtonPollType](#keyboardbuttonpolltype) | _Optional_. If specified, the user will be asked to create a poll and send it to the bot when the button is pressed. Available in private chats only. |
| web\_app | [WebAppInfo](#webappinfo) | _Optional_. If specified, the described [Web App](https://core.telegram.org/bots/webapps) will be launched when the button is pressed. The Web App will be able to send a “web\_app\_data” service message. Available in private chats only. |

#### KeyboardButtonRequestUsers

This object defines the criteria used to request suitable users. Information about the selected users will be shared with the bot when the corresponding button is pressed. More about requesting users »

| Field | Type | Description |
| --- | --- | --- |
| request\_id | Integer | Signed 32-bit identifier of the request that will be received back in the [UsersShared](#usersshared) object. Must be unique within the message. |
| user\_is\_bot | Boolean | _Optional_. Pass _True_ to request bots, pass _False_ to request regular users. If not specified, no additional restrictions are applied. |
| user\_is\_premium | Boolean | _Optional_. Pass _True_ to request premium users, pass _False_ to request non-premium users. If not specified, no additional restrictions are applied. |
| max\_quantity | Integer | _Optional_. The maximum number of users to be selected; 1-10. Defaults to 1. |
| request\_name | Boolean | _Optional_. Pass _True_ to request the users' first and last names |
| request\_username | Boolean | _Optional_. Pass _True_ to request the users' usernames |
| request\_photo | Boolean | _Optional_. Pass _True_ to request the users' photos |

#### KeyboardButtonRequestChat

This object defines the criteria used to request a suitable chat. Information about the selected chat will be shared with the bot when the corresponding button is pressed. The bot will be granted requested rights in the chat if appropriate. More about requesting chats ».

| Field | Type | Description |
| --- | --- | --- |
| request\_id | Integer | Signed 32-bit identifier of the request, which will be received back in the [ChatShared](#chatshared) object. Must be unique within the message. |
| chat\_is\_channel | Boolean | Pass _True_ to request a channel chat, pass _False_ to request a group or a supergroup chat |
| chat\_is\_forum | Boolean | _Optional_. Pass _True_ to request a forum supergroup, pass _False_ to request a non-forum chat. If not specified, no additional restrictions are applied. |
| chat\_has\_username | Boolean | _Optional_. Pass _True_ to request a supergroup or a channel with a username, pass _False_ to request a chat without a username. If not specified, no additional restrictions are applied. |
| chat\_is\_created | Boolean | _Optional_. Pass _True_ to request a chat owned by the user. Otherwise, no additional restrictions are applied. |
| user\_administrator\_rights | [ChatAdministratorRights](#chatadministratorrights) | _Optional_. A JSON-serialized object listing the required administrator rights of the user in the chat. The rights must be a superset of _bot\_administrator\_rights_. If not specified, no additional restrictions are applied. |
| bot\_administrator\_rights | [ChatAdministratorRights](#chatadministratorrights) | _Optional_. A JSON-serialized object listing the required administrator rights of the bot in the chat. The rights must be a subset of _user\_administrator\_rights_. If not specified, no additional restrictions are applied. |
| bot\_is\_member | Boolean | _Optional_. Pass _True_ to request a chat with the bot as a member. Otherwise, no additional restrictions are applied. |
| request\_title | Boolean | _Optional_. Pass _True_ to request the chat's title |
| request\_username | Boolean | _Optional_. Pass _True_ to request the chat's username |
| request\_photo | Boolean | _Optional_. Pass _True_ to request the chat's photo |

#### KeyboardButtonRequestManagedBot

This object defines the parameters for the creation of a managed bot. Information about the created bot will be shared with the bot using the update _managed\_bot_ and a [Message](#message) with the field _managed\_bot\_created_.

| Field | Type | Description |
| --- | --- | --- |
| request\_id | Integer | Signed 32-bit identifier of the request. Must be unique within the message. |
| suggested\_name | String | _Optional_. Suggested name for the bot |
| suggested\_username | String | _Optional_. Suggested username for the bot |

#### KeyboardButtonPollType

This object represents type of a poll, which is allowed to be created and sent when the corresponding button is pressed.

| Field | Type | Description |
| --- | --- | --- |
| type | String | _Optional_. If _quiz_ is passed, the user will be allowed to create only polls in the quiz mode. If _regular_ is passed, only regular polls will be allowed. Otherwise, the user will be allowed to create a poll of any type. |

#### ReplyKeyboardRemove

Upon receiving a message with this object, Telegram clients will remove the current custom keyboard and display the default letter-keyboard. By default, custom keyboards are displayed until a new keyboard is sent by a bot. An exception is made for one-time keyboards that are hidden immediately after the user presses a button (see [ReplyKeyboardMarkup](#replykeyboardmarkup)). Not supported in channels and for messages sent on behalf of a business account.

| Field | Type | Description |
| --- | --- | --- |
| remove\_keyboard | True | Requests clients to remove the custom keyboard (user will not be able to summon this keyboard; if you want to hide the keyboard from sight but keep it accessible, use _one\_time\_keyboard_ in [ReplyKeyboardMarkup](#replykeyboardmarkup)) |
| selective | Boolean | _Optional_. Use this parameter if you want to remove the keyboard for specific users only. Targets: 1) users that are @mentioned in the _text_ of the [Message](#message) object; 2) if the bot's message is a reply to a message in the same chat and forum topic, sender of the original message.  <br>  <br>_Example:_ A user votes in a poll, bot returns confirmation message in reply to the vote and removes the keyboard for that user, while still showing the keyboard with poll options to users who haven't voted yet. |

#### InlineKeyboardMarkup

This object represents an inline keyboard that appears right next to the message it belongs to.

| Field | Type | Description |
| --- | --- | --- |
| inline\_keyboard | Array of Array of [InlineKeyboardButton](#inlinekeyboardbutton) | Array of button rows, each represented by an Array of [InlineKeyboardButton](#inlinekeyboardbutton) objects |

#### InlineKeyboardButton

This object represents one button of an inline keyboard. Exactly one of the fields other than _text_, _icon\_custom\_emoji\_id_, and _style_ must be used to specify the type of the button.

| Field | Type | Description |
| --- | --- | --- |
| text | String | Label text on the button |
| icon\_custom\_emoji\_id | String | _Optional_. Unique identifier of the custom emoji shown before the text of the button. Can only be used by bots that purchased additional usernames on [Fragment](https://fragment.com/) or in the messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription. |
| style | String | _Optional_. Style of the button. Must be one of “danger” (red), “success” (green) or “primary” (blue). If omitted, then an app-specific style is used. |
| url | String | _Optional_. HTTP or tg:// URL to be opened when the button is pressed. Links `tg://user?id=<user_id>` can be used to mention a user by their identifier without using a username, if this is allowed by their privacy settings. |
| callback\_data | String | _Optional_. Data to be sent in a [callback query](#callbackquery) to the bot when the button is pressed, 1-64 bytes |
| web\_app | [WebAppInfo](#webappinfo) | _Optional_. Description of the [Web App](https://core.telegram.org/bots/webapps) that will be launched when the user presses the button. The Web App will be able to send an arbitrary message on behalf of the user using the method [answerWebAppQuery](#answerwebappquery). Available only in private chats between a user and the bot. Not supported for messages sent on behalf of a business account. |
| login\_url | [LoginUrl](#loginurl) | _Optional_. An HTTPS URL used to automatically authorize the user. Can be used as a replacement for the [Telegram Login Widget](https://core.telegram.org/widgets/login). |
| switch\_inline\_query | String | _Optional_. If set, pressing the button will prompt the user to select one of their chats, open that chat and insert the bot's username and the specified inline query in the input field. May be empty, in which case just the bot's username will be inserted. Not supported for messages sent in channel direct messages chats and on behalf of a business account. |
| switch\_inline\_query\_current\_chat | String | _Optional_. If set, pressing the button will insert the bot's username and the specified inline query in the current chat's input field. May be empty, in which case only the bot's username will be inserted.  <br>  <br>This offers a quick way for the user to open your bot in inline mode in the same chat - good for selecting something from multiple options. Not supported in channels and for messages sent in channel direct messages chats and on behalf of a business account. |
| switch\_inline\_query\_chosen\_chat | [SwitchInlineQueryChosenChat](#switchinlinequerychosenchat) | _Optional_. If set, pressing the button will prompt the user to select one of their chats of the specified type, open that chat and insert the bot's username and the specified inline query in the input field. Not supported for messages sent in channel direct messages chats and on behalf of a business account. |
| copy\_text | [CopyTextButton](#copytextbutton) | _Optional_. Description of the button that copies the specified text to the clipboard |
| callback\_game | [CallbackGame](#callbackgame) | _Optional_. Description of the game that will be launched when the user presses the button.  <br>  <br>**NOTE:** This type of button **must** always be the first button in the first row. |
| pay | Boolean | _Optional_. Specify _True_, to send a [Pay button](#payments). Substrings “⭐” and “XTR” in the buttons's text will be replaced with a Telegram Star icon.  <br>  <br>**NOTE:** This type of button **must** always be the first button in the first row and can only be used in invoice messages. |

#### LoginUrl

This object represents a parameter of the inline keyboard button used to automatically authorize a user. Serves as a great replacement for the [Telegram Login Widget](https://core.telegram.org/widgets/login) when the user is coming from Telegram. All the user needs to do is tap/click a button and confirm that they want to log in:

[TITLE](https://core.telegram.org/file/811140015/1734/8VZFkwWXalM.97872/6127fa62d8a0bf2b3c)

Telegram apps support these buttons as of [version 5.7](https://telegram.org/blog/privacy-discussions-web-bots#meet-seamless-web-bots).

> Sample bot: [@discussbot](https://t.me/discussbot)

| Field | Type | Description |
| --- | --- | --- |
| url | String | An HTTPS URL to be opened with user authorization data added to the query string when the button is pressed. If the user refuses to provide authorization data, the original URL without information about the user will be opened. The data added is the same as described in [Receiving authorization data](https://core.telegram.org/widgets/login#receiving-authorization-data).  <br>  <br>**NOTE:** You **must** always check the hash of the received data to verify the authentication and the integrity of the data as described in [Checking authorization](https://core.telegram.org/widgets/login#checking-authorization). |
| forward\_text | String | _Optional_. New text of the button in forwarded messages |
| bot\_username | String | _Optional_. Username of a bot, which will be used for user authorization. See [Setting up a bot](https://core.telegram.org/widgets/login#setting-up-a-bot) for more details. If not specified, the current bot's username will be assumed. The _url_'s domain must be the same as the domain linked with the bot. See [Linking your domain to the bot](https://core.telegram.org/widgets/login#linking-your-domain-to-the-bot) for more details. |
| request\_write\_access | Boolean | _Optional_. Pass _True_ to request the permission for your bot to send messages to the user |

#### SwitchInlineQueryChosenChat

This object represents an inline button that switches the current user to inline mode in a chosen chat, with an optional default inline query.

| Field | Type | Description |
| --- | --- | --- |
| query | String | _Optional_. The default inline query to be inserted in the input field. If left empty, only the bot's username will be inserted. |
| allow\_user\_chats | Boolean | _Optional_. _True_, if private chats with users can be chosen |
| allow\_bot\_chats | Boolean | _Optional_. _True_, if private chats with bots can be chosen |
| allow\_group\_chats | Boolean | _Optional_. _True_, if group and supergroup chats can be chosen |
| allow\_channel\_chats | Boolean | _Optional_. _True_, if channel chats can be chosen |

#### CopyTextButton

This object represents an inline keyboard button that copies specified text to the clipboard.

| Field | Type | Description |
| --- | --- | --- |
| text | String | The text to be copied to the clipboard; 1-256 characters |

#### CallbackQuery

This object represents an incoming callback query from a callback button in an inline keyboard. If the button that originated the query was attached to a message sent by the bot, the field _message_ will be present. If the button was attached to a message sent via the bot (in [inline mode](#inline-mode)), the field _inline\_message\_id_ will be present. Exactly one of the fields _data_ or _game\_short\_name_ will be present.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique identifier for this query |
| from | [User](#user) | Sender |
| message | [MaybeInaccessibleMessage](#maybeinaccessiblemessage) | _Optional_. Message sent by the bot with the callback button that originated the query |
| inline\_message\_id | String | _Optional_. Identifier of the message sent via the bot in inline mode, that originated the query |
| chat\_instance | String | Global identifier, uniquely corresponding to the chat to which the message with the callback button was sent. Useful for high scores in [games](#games). |
| data | String | _Optional_. Data associated with the callback button. Be aware that the message originated the query can contain no callback buttons with this data. |
| game\_short\_name | String | _Optional_. Short name of a [Game](#games) to be returned, serves as the unique identifier for the game |

> **NOTE:** After the user presses a callback button, Telegram clients will display a progress bar until you call [answerCallbackQuery](#answercallbackquery). It is, therefore, necessary to react by calling [answerCallbackQuery](#answercallbackquery) even if no notification to the user is needed (e.g., without specifying any of the optional parameters).

#### ForceReply

Upon receiving a message with this object, Telegram clients will display a reply interface to the user (act as if the user has selected the bot's message and tapped 'Reply'). This can be extremely useful if you want to create user-friendly step-by-step interfaces without having to sacrifice privacy mode. Not supported in channels and for messages sent on behalf of a user account.

| Field | Type | Description |
| --- | --- | --- |
| force\_reply | True | Shows reply interface to the user, as if they manually selected the bot's message and tapped 'Reply' |
| input\_field\_placeholder | String | _Optional_. The placeholder to be shown in the input field when the reply is active; 1-64 characters |
| selective | Boolean | _Optional_. Use this parameter if you want to force reply from specific users only. Targets: 1) users that are @mentioned in the _text_ of the [Message](#message) object; 2) if the bot's message is a reply to a message in the same chat and forum topic, sender of the original message. |

> **Example:** A [poll bot](https://t.me/PollBot) for groups runs in privacy mode (only receives commands, replies to its messages and mentions). There could be two ways to create a new poll:
> 
> - Explain the user how to send a command with parameters (e.g. /newpoll question answer1 answer2). May be appealing for hardcore users but lacks modern day polish.
> - Guide the user through a step-by-step process. 'Please send me your question', 'Cool, now let's add the first answer option', 'Great. Keep adding answer options, then send /done when you're ready'.
> 
> The last option is definitely more attractive. And if you use [ForceReply](#forcereply) in your bot's questions, it will receive the user's answers even if it only receives replies, commands and mentions - without any extra work for the user.

#### ChatPhoto

This object represents a chat photo.

| Field | Type | Description |
| --- | --- | --- |
| small\_file\_id | String | File identifier of small (160x160) chat photo. This file\_id can be used only for photo download and only for as long as the photo is not changed. |
| small\_file\_unique\_id | String | Unique file identifier of small (160x160) chat photo, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| big\_file\_id | String | File identifier of big (640x640) chat photo. This file\_id can be used only for photo download and only for as long as the photo is not changed. |
| big\_file\_unique\_id | String | Unique file identifier of big (640x640) chat photo, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |

#### ChatInviteLink

Represents an invite link for a chat.

| Field | Type | Description |
| --- | --- | --- |
| invite\_link | String | The invite link. If the link was created by another chat administrator, then the second part of the link will be replaced with “…”. |
| creator | [User](#user) | Creator of the link |
| creates\_join\_request | Boolean | _True_, if users joining the chat via the link need to be approved by chat administrators |
| is\_primary | Boolean | _True_, if the link is primary |
| is\_revoked | Boolean | _True_, if the link is revoked |
| name | String | _Optional_. Invite link name |
| expire\_date | Integer | _Optional_. Point in time (Unix timestamp) when the link will expire or has been expired |
| member\_limit | Integer | _Optional_. The maximum number of users that can be members of the chat simultaneously after joining the chat via this invite link; 1-99999 |
| pending\_join\_request\_count | Integer | _Optional_. Number of pending join requests created using this link |
| subscription\_period | Integer | _Optional_. The number of seconds the subscription will be active for before the next payment |
| subscription\_price | Integer | _Optional_. The amount of Telegram Stars a user must pay initially and after each subsequent subscription period to be a member of the chat using the link |

#### ChatAdministratorRights

Represents the rights of an administrator in a chat.

| Field | Type | Description |
| --- | --- | --- |
| is\_anonymous | Boolean | _True_, if the user's presence in the chat is hidden |
| can\_manage\_chat | Boolean | _True_, if the administrator can access the chat event log, get boost list, see hidden supergroup and channel members, report spam messages, ignore slow mode, and send messages to the chat without paying Telegram Stars. Implied by any other administrator privilege. |
| can\_delete\_messages | Boolean | _True_, if the administrator can delete messages of other users |
| can\_manage\_video\_chats | Boolean | _True_, if the administrator can manage video chats |
| can\_restrict\_members | Boolean | _True_, if the administrator can restrict, ban or unban chat members, or access supergroup statistics |
| can\_promote\_members | Boolean | _True_, if the administrator can add new administrators with a subset of their own privileges or demote administrators that they have promoted, directly or indirectly (promoted by administrators that were appointed by the user) |
| can\_change\_info | Boolean | _True_, if the user is allowed to change the chat title, photo and other settings |
| can\_invite\_users | Boolean | _True_, if the user is allowed to invite new users to the chat |
| can\_post\_stories | Boolean | _True_, if the administrator can post stories to the chat |
| can\_edit\_stories | Boolean | _True_, if the administrator can edit stories posted by other users, post stories to the chat page, pin chat stories, and access the chat's story archive |
| can\_delete\_stories | Boolean | _True_, if the administrator can delete stories posted by other users |
| can\_post\_messages | Boolean | _Optional_. _True_, if the administrator can post messages in the channel, approve suggested posts, or access channel statistics; for channels only |
| can\_edit\_messages | Boolean | _Optional_. _True_, if the administrator can edit messages of other users and can pin messages; for channels only |
| can\_pin\_messages | Boolean | _Optional_. _True_, if the user is allowed to pin messages; for groups and supergroups only |
| can\_manage\_topics | Boolean | _Optional_. _True_, if the user is allowed to create, rename, close, and reopen forum topics; for supergroups only |
| can\_manage\_direct\_messages | Boolean | _Optional_. _True_, if the administrator can manage direct messages of the channel and decline suggested posts; for channels only |
| can\_manage\_tags | Boolean | _Optional_. _True_, if the administrator can edit the tags of regular members; for groups and supergroups only. If omitted defaults to the value of can\_pin\_messages. |

#### ChatMemberUpdated

This object represents changes in the status of a chat member.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | Chat the user belongs to |
| from | [User](#user) | Performer of the action, which resulted in the change |
| date | Integer | Date the change was done in Unix time |
| old\_chat\_member | [ChatMember](#chatmember) | Previous information about the chat member |
| new\_chat\_member | [ChatMember](#chatmember) | New information about the chat member |
| invite\_link | [ChatInviteLink](#chatinvitelink) | _Optional_. Chat invite link, which was used by the user to join the chat; for joining by invite link events only |
| via\_join\_request | Boolean | _Optional_. _True_, if the user joined the chat after sending a direct join request without using an invite link and being approved by an administrator |
| via\_chat\_folder\_invite\_link | Boolean | _Optional_. _True_, if the user joined the chat via a chat folder invite link |

#### ChatMember

This object contains information about one member of a chat. Currently, the following 6 types of chat members are supported:

- [ChatMemberOwner](#chatmemberowner)
- [ChatMemberAdministrator](#chatmemberadministrator)
- [ChatMemberMember](#chatmembermember)
- [ChatMemberRestricted](#chatmemberrestricted)
- [ChatMemberLeft](#chatmemberleft)
- [ChatMemberBanned](#chatmemberbanned)

#### ChatMemberOwner

Represents a [chat member](#chatmember) that owns the chat and has all administrator privileges.

| Field | Type | Description |
| --- | --- | --- |
| status | String | The member's status in the chat, always “creator” |
| user | [User](#user) | Information about the user |
| is\_anonymous | Boolean | _True_, if the user's presence in the chat is hidden |
| custom\_title | String | _Optional_. Custom title for this user |

#### ChatMemberAdministrator

Represents a [chat member](#chatmember) that has some additional privileges.

| Field | Type | Description |
| --- | --- | --- |
| status | String | The member's status in the chat, always “administrator” |
| user | [User](#user) | Information about the user |
| can\_be\_edited | Boolean | _True_, if the bot is allowed to edit administrator privileges of that user |
| is\_anonymous | Boolean | _True_, if the user's presence in the chat is hidden |
| can\_manage\_chat | Boolean | _True_, if the administrator can access the chat event log, get boost list, see hidden supergroup and channel members, report spam messages, ignore slow mode, and send messages to the chat without paying Telegram Stars. Implied by any other administrator privilege. |
| can\_delete\_messages | Boolean | _True_, if the administrator can delete messages of other users |
| can\_manage\_video\_chats | Boolean | _True_, if the administrator can manage video chats |
| can\_restrict\_members | Boolean | _True_, if the administrator can restrict, ban or unban chat members, or access supergroup statistics |
| can\_promote\_members | Boolean | _True_, if the administrator can add new administrators with a subset of their own privileges or demote administrators that they have promoted, directly or indirectly (promoted by administrators that were appointed by the user) |
| can\_change\_info | Boolean | _True_, if the user is allowed to change the chat title, photo and other settings |
| can\_invite\_users | Boolean | _True_, if the user is allowed to invite new users to the chat |
| can\_post\_stories | Boolean | _True_, if the administrator can post stories to the chat |
| can\_edit\_stories | Boolean | _True_, if the administrator can edit stories posted by other users, post stories to the chat page, pin chat stories, and access the chat's story archive |
| can\_delete\_stories | Boolean | _True_, if the administrator can delete stories posted by other users |
| can\_post\_messages | Boolean | _Optional_. _True_, if the administrator can post messages in the channel, approve suggested posts, or access channel statistics; for channels only |
| can\_edit\_messages | Boolean | _Optional_. _True_, if the administrator can edit messages of other users and can pin messages; for channels only |
| can\_pin\_messages | Boolean | _Optional_. _True_, if the user is allowed to pin messages; for groups and supergroups only |
| can\_manage\_topics | Boolean | _Optional_. _True_, if the user is allowed to create, rename, close, and reopen forum topics; for supergroups only |
| can\_manage\_direct\_messages | Boolean | _Optional_. _True_, if the administrator can manage direct messages of the channel and decline suggested posts; for channels only |
| can\_manage\_tags | Boolean | _Optional_. _True_, if the administrator can edit the tags of regular members; for groups and supergroups only. If omitted defaults to the value of can\_pin\_messages. |
| custom\_title | String | _Optional_. Custom title for this user |

#### ChatMemberMember

Represents a [chat member](#chatmember) that has no additional privileges or restrictions.

| Field | Type | Description |
| --- | --- | --- |
| status | String | The member's status in the chat, always “member” |
| tag | String | _Optional_. Tag of the member |
| user | [User](#user) | Information about the user |
| until\_date | Integer | _Optional_. Date when the user's subscription will expire; Unix time |

#### ChatMemberRestricted

Represents a [chat member](#chatmember) that is under certain restrictions in the chat. Supergroups only.

| Field | Type | Description |
| --- | --- | --- |
| status | String | The member's status in the chat, always “restricted” |
| tag | String | _Optional_. Tag of the member |
| user | [User](#user) | Information about the user |
| is\_member | Boolean | _True_, if the user is a member of the chat at the moment of the request |
| can\_send\_messages | Boolean | _True_, if the user is allowed to send text messages, rich messages, contacts, giveaways, giveaway winners, invoices, locations and venues |
| can\_send\_audios | Boolean | _True_, if the user is allowed to send audios |
| can\_send\_documents | Boolean | _True_, if the user is allowed to send documents |
| can\_send\_photos | Boolean | _True_, if the user is allowed to send photos |
| can\_send\_videos | Boolean | _True_, if the user is allowed to send videos |
| can\_send\_video\_notes | Boolean | _True_, if the user is allowed to send video notes |
| can\_send\_voice\_notes | Boolean | _True_, if the user is allowed to send voice notes |
| can\_send\_polls | Boolean | _True_, if the user is allowed to send polls and checklists |
| can\_send\_other\_messages | Boolean | _True_, if the user is allowed to send animations, games, stickers and use inline bots |
| can\_add\_web\_page\_previews | Boolean | _True_, if the user is allowed to add web page previews to their messages |
| can\_react\_to\_messages | Boolean | _True_, if the user is allowed to react to messages |
| can\_edit\_tag | Boolean | _True_, if the user is allowed to edit their own tag |
| can\_change\_info | Boolean | _True_, if the user is allowed to change the chat title, photo and other settings |
| can\_invite\_users | Boolean | _True_, if the user is allowed to invite new users to the chat |
| can\_pin\_messages | Boolean | _True_, if the user is allowed to pin messages |
| can\_manage\_topics | Boolean | _True_, if the user is allowed to create forum topics |
| until\_date | Integer | Date when restrictions will be lifted for this user; Unix time. If 0, then the user is restricted forever. |

#### ChatMemberLeft

Represents a [chat member](#chatmember) that isn't currently a member of the chat, but may join it themselves.

| Field | Type | Description |
| --- | --- | --- |
| status | String | The member's status in the chat, always “left” |
| user | [User](#user) | Information about the user |

#### ChatMemberBanned

Represents a [chat member](#chatmember) that was banned in the chat and can't return to the chat or view chat messages.

| Field | Type | Description |
| --- | --- | --- |
| status | String | The member's status in the chat, always “kicked” |
| user | [User](#user) | Information about the user |
| until\_date | Integer | Date when restrictions will be lifted for this user; Unix time. If 0, then the user is banned forever. |

#### ChatJoinRequest

Represents a join request sent to a chat.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | Chat to which the request was sent |
| from | [User](#user) | User that sent the join request |
| user\_chat\_id | Integer | Identifier of a private chat with the user who sent the join request. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a 64-bit integer or double-precision float type are safe for storing this identifier. The bot can use this identifier for 5 minutes to send messages until the join request is processed, assuming no other administrator contacted the user. |
| date | Integer | Date the request was sent in Unix time |
| bio | String | _Optional_. Bio of the user |
| invite\_link | [ChatInviteLink](#chatinvitelink) | _Optional_. Chat invite link that was used by the user to send the join request |
| query\_id | String | _Optional_. Identifier of the join request query. If present, then the bot must call [sendChatJoinRequestWebApp](#sendchatjoinrequestwebapp) or directly call [answerChatJoinRequestQuery](#answerchatjoinrequestquery) within 10 seconds. |

#### ChatPermissions

Describes actions that a non-administrator user is allowed to take in a chat.

| Field | Type | Description |
| --- | --- | --- |
| can\_send\_messages | Boolean | _Optional_. _True_, if the user is allowed to send text messages, rich messages, contacts, giveaways, giveaway winners, invoices, locations and venues |
| can\_send\_audios | Boolean | _Optional_. _True_, if the user is allowed to send audios |
| can\_send\_documents | Boolean | _Optional_. _True_, if the user is allowed to send documents |
| can\_send\_photos | Boolean | _Optional_. _True_, if the user is allowed to send photos |
| can\_send\_videos | Boolean | _Optional_. _True_, if the user is allowed to send videos |
| can\_send\_video\_notes | Boolean | _Optional_. _True_, if the user is allowed to send video notes |
| can\_send\_voice\_notes | Boolean | _Optional_. _True_, if the user is allowed to send voice notes |
| can\_send\_polls | Boolean | _Optional_. _True_, if the user is allowed to send polls and checklists |
| can\_send\_other\_messages | Boolean | _Optional_. _True_, if the user is allowed to send animations, games, stickers and use inline bots |
| can\_add\_web\_page\_previews | Boolean | _Optional_. _True_, if the user is allowed to add web page previews to their messages |
| can\_react\_to\_messages | Boolean | _Optional_. _True_, if the user is allowed to react to messages. If omitted, defaults to the value of _can\_send\_messages_. |
| can\_edit\_tag | Boolean | _Optional_. _True_, if the user is allowed to edit their own tag. If omitted, defaults to the value of _can\_pin\_messages_. |
| can\_change\_info | Boolean | _Optional_. _True_, if the user is allowed to change the chat title, photo and other settings. Ignored in public supergroups. |
| can\_invite\_users | Boolean | _Optional_. _True_, if the user is allowed to invite new users to the chat |
| can\_pin\_messages | Boolean | _Optional_. _True_, if the user is allowed to pin messages. Ignored in public supergroups. |
| can\_manage\_topics | Boolean | _Optional_. _True_, if the user is allowed to create forum topics. If omitted defaults to the value of can\_pin\_messages. |

#### Birthdate

Describes the birthdate of a user.

| Field | Type | Description |
| --- | --- | --- |
| day | Integer | Day of the user's birth; 1-31 |
| month | Integer | Month of the user's birth; 1-12 |
| year | Integer | _Optional_. Year of the user's birth |

#### BusinessIntro

Contains information about the start page settings of a Telegram Business account.

| Field | Type | Description |
| --- | --- | --- |
| title | String | _Optional_. Title text of the business intro |
| message | String | _Optional_. Message text of the business intro |
| sticker | [Sticker](#sticker) | _Optional_. Sticker of the business intro |

#### BusinessLocation

Contains information about the location of a Telegram Business account.

| Field | Type | Description |
| --- | --- | --- |
| address | String | Address of the business |
| location | [Location](#location) | _Optional_. Location of the business |

#### BusinessOpeningHoursInterval

Describes an interval of time during which a business is open.

| Field | Type | Description |
| --- | --- | --- |
| opening\_minute | Integer | The minute's sequence number in a week, starting on Monday, marking the start of the time interval during which the business is open; 0 - 7 \* 24 \* 60 |
| closing\_minute | Integer | The minute's sequence number in a week, starting on Monday, marking the end of the time interval during which the business is open; 0 - 8 \* 24 \* 60 |

#### BusinessOpeningHours

Describes the opening hours of a business.

| Field | Type | Description |
| --- | --- | --- |
| time\_zone\_name | String | Unique name of the time zone for which the opening hours are defined |
| opening\_hours | Array of [BusinessOpeningHoursInterval](#businessopeninghoursinterval) | List of time intervals describing business opening hours |

#### UserRating

This object describes the rating of a user based on their Telegram Star spendings.

| Field | Type | Description |
| --- | --- | --- |
| level | Integer | Current level of the user, indicating their reliability when purchasing digital goods and services. A higher level suggests a more trustworthy customer; a negative level is likely reason for concern. |
| rating | Integer | Numerical value of the user's rating; the higher the rating, the better |
| current\_level\_rating | Integer | The rating value required to get the current level |
| next\_level\_rating | Integer | _Optional_. The rating value required to get to the next level; omitted if the maximum level was reached |

#### StoryAreaPosition

Describes the position of a clickable area within a story.

| Field | Type | Description |
| --- | --- | --- |
| x\_percentage | Float | The abscissa of the area's center, as a percentage of the media width |
| y\_percentage | Float | The ordinate of the area's center, as a percentage of the media height |
| width\_percentage | Float | The width of the area's rectangle, as a percentage of the media width |
| height\_percentage | Float | The height of the area's rectangle, as a percentage of the media height |
| rotation\_angle | Float | The clockwise rotation angle of the rectangle, in degrees; 0-360 |
| corner\_radius\_percentage | Float | The radius of the rectangle corner rounding, as a percentage of the media width |

#### LocationAddress

Describes the physical address of a location.

| Field | Type | Description |
| --- | --- | --- |
| country\_code | String | The two-letter ISO 3166-1 alpha-2 country code of the country where the location is located |
| state | String | _Optional_. State of the location |
| city | String | _Optional_. City of the location |
| street | String | _Optional_. Street address of the location |

#### StoryAreaType

Describes the type of a clickable area on a story. Currently, it can be one of

- [StoryAreaTypeLocation](#storyareatypelocation)
- [StoryAreaTypeSuggestedReaction](#storyareatypesuggestedreaction)
- [StoryAreaTypeLink](#storyareatypelink)
- [StoryAreaTypeWeather](#storyareatypeweather)
- [StoryAreaTypeUniqueGift](#storyareatypeuniquegift)

#### StoryAreaTypeLocation

Describes a story area pointing to a location. Currently, a story can have up to 10 location areas.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the area, always “location” |
| latitude | Float | Location latitude in degrees |
| longitude | Float | Location longitude in degrees |
| address | [LocationAddress](#locationaddress) | _Optional_. Address of the location |

#### StoryAreaTypeSuggestedReaction

Describes a story area pointing to a suggested reaction. Currently, a story can have up to 5 suggested reaction areas.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the area, always “suggested\_reaction” |
| reaction\_type | [ReactionType](#reactiontype) | Type of the reaction |
| is\_dark | Boolean | _Optional_. Pass _True_ if the reaction area has a dark background |
| is\_flipped | Boolean | _Optional_. Pass _True_ if reaction area corner is flipped |

#### StoryAreaTypeLink

Describes a story area pointing to an HTTP or tg:// link. Currently, a story can have up to 3 link areas.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the area, always “link” |
| url | String | HTTP or tg:// URL to be opened when the area is clicked |

#### StoryAreaTypeWeather

Describes a story area containing weather information. Currently, a story can have up to 3 weather areas.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the area, always “weather” |
| temperature | Float | Temperature, in degree Celsius |
| emoji | String | Emoji representing the weather |
| background\_color | Integer | A color of the area background in the ARGB format |

#### StoryAreaTypeUniqueGift

Describes a story area pointing to a unique gift. Currently, a story can have at most 1 unique gift area.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the area, always “unique\_gift” |
| name | String | Unique name of the gift |

#### StoryArea

Describes a clickable area on a story media.

| Field | Type | Description |
| --- | --- | --- |
| position | [StoryAreaPosition](#storyareaposition) | Position of the area |
| type | [StoryAreaType](#storyareatype) | Type of the area |

#### ChatLocation

Represents a location to which a chat is connected.

| Field | Type | Description |
| --- | --- | --- |
| location | [Location](#location) | The location to which the supergroup is connected. Can't be a live location. |
| address | String | Location address; 1-64 characters, as defined by the chat owner |

#### ReactionType

This object describes the type of a reaction. Currently, it can be one of

- [ReactionTypeEmoji](#reactiontypeemoji)
- [ReactionTypeCustomEmoji](#reactiontypecustomemoji)
- [ReactionTypePaid](#reactiontypepaid)

#### ReactionTypeEmoji

The reaction is based on an emoji.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the reaction, always “emoji” |
| emoji | String | Reaction emoji. Currently, it can be one of "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡". |

#### ReactionTypeCustomEmoji

The reaction is based on a custom emoji.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the reaction, always “custom\_emoji” |
| custom\_emoji\_id | String | Custom emoji identifier |

#### ReactionTypePaid

The reaction is paid.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the reaction, always “paid” |

#### ReactionCount

Represents a reaction added to a message along with the number of times it was added.

| Field | Type | Description |
| --- | --- | --- |
| type | [ReactionType](#reactiontype) | Type of the reaction |
| total\_count | Integer | Number of times the reaction was added |

#### MessageReactionUpdated

This object represents a change of a reaction on a message performed by a user.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | The chat containing the message the user reacted to |
| message\_id | Integer | Unique identifier of the message inside the chat |
| user | [User](#user) | _Optional_. The user that changed the reaction, if the user isn't anonymous |
| actor\_chat | [Chat](#chat) | _Optional_. The chat on behalf of which the reaction was changed, if the user is anonymous |
| date | Integer | Date of the change in Unix time |
| old\_reaction | Array of [ReactionType](#reactiontype) | Previous list of reaction types that were set by the user |
| new\_reaction | Array of [ReactionType](#reactiontype) | New list of reaction types that have been set by the user |

#### MessageReactionCountUpdated

This object represents reaction changes on a message with anonymous reactions.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | The chat containing the message |
| message\_id | Integer | Unique message identifier inside the chat |
| date | Integer | Date of the change in Unix time |
| reactions | Array of [ReactionCount](#reactioncount) | List of reactions that are present on the message |

#### ForumTopic

This object represents a forum topic.

| Field | Type | Description |
| --- | --- | --- |
| message\_thread\_id | Integer | Unique identifier of the forum topic |
| name | String | Name of the topic |
| icon\_color | Integer | Color of the topic icon in RGB format |
| icon\_custom\_emoji\_id | String | _Optional_. Unique identifier of the custom emoji shown as the topic icon |
| is\_name\_implicit | True | _Optional_. _True_, if the name of the topic wasn't specified explicitly by its creator and likely needs to be changed by the bot |

#### GiftBackground

This object describes the background of a gift.

| Field | Type | Description |
| --- | --- | --- |
| center\_color | Integer | Center color of the background in RGB format |
| edge\_color | Integer | Edge color of the background in RGB format |
| text\_color | Integer | Text color of the background in RGB format |

#### Gift

This object represents a gift that can be sent by the bot.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique identifier of the gift |
| sticker | [Sticker](#sticker) | The sticker that represents the gift |
| star\_count | Integer | The number of Telegram Stars that must be paid to send the sticker |
| upgrade\_star\_count | Integer | _Optional_. The number of Telegram Stars that must be paid to upgrade the gift to a unique one |
| is\_premium | True | _Optional_. _True_, if the gift can only be purchased by Telegram Premium subscribers |
| has\_colors | True | _Optional_. _True_, if the gift can be used (after being upgraded) to customize a user's appearance |
| total\_count | Integer | _Optional_. The total number of gifts of this type that can be sent by all users; for limited gifts only |
| remaining\_count | Integer | _Optional_. The number of remaining gifts of this type that can be sent by all users; for limited gifts only |
| personal\_total\_count | Integer | _Optional_. The total number of gifts of this type that can be sent by the bot; for limited gifts only |
| personal\_remaining\_count | Integer | _Optional_. The number of remaining gifts of this type that can be sent by the bot; for limited gifts only |
| background | [GiftBackground](#giftbackground) | _Optional_. Background of the gift |
| unique\_gift\_variant\_count | Integer | _Optional_. The total number of different unique gifts that can be obtained by upgrading the gift |
| publisher\_chat | [Chat](#chat) | _Optional_. Information about the chat that published the gift |

#### Gifts

This object represent a list of gifts.

| Field | Type | Description |
| --- | --- | --- |
| gifts | Array of [Gift](#gift) | The list of gifts |

#### UniqueGiftModel

This object describes the model of a unique gift.

| Field | Type | Description |
| --- | --- | --- |
| name | String | Name of the model |
| sticker | [Sticker](#sticker) | The sticker that represents the unique gift |
| rarity\_per\_mille | Integer | The number of unique gifts that receive this model for every 1000 gift upgrades. Always 0 for crafted gifts. |
| rarity | String | _Optional_. Rarity of the model if it is a crafted model. Currently, can be “uncommon”, “rare”, “epic”, or “legendary”. |

#### UniqueGiftSymbol

This object describes the symbol shown on the pattern of a unique gift.

| Field | Type | Description |
| --- | --- | --- |
| name | String | Name of the symbol |
| sticker | [Sticker](#sticker) | The sticker that represents the unique gift |
| rarity\_per\_mille | Integer | The number of unique gifts that receive this model for every 1000 gifts upgraded |

#### UniqueGiftBackdropColors

This object describes the colors of the backdrop of a unique gift.

| Field | Type | Description |
| --- | --- | --- |
| center\_color | Integer | The color in the center of the backdrop in RGB format |
| edge\_color | Integer | The color on the edges of the backdrop in RGB format |
| symbol\_color | Integer | The color to be applied to the symbol in RGB format |
| text\_color | Integer | The color for the text on the backdrop in RGB format |

#### UniqueGiftBackdrop

This object describes the backdrop of a unique gift.

| Field | Type | Description |
| --- | --- | --- |
| name | String | Name of the backdrop |
| colors | [UniqueGiftBackdropColors](#uniquegiftbackdropcolors) | Colors of the backdrop |
| rarity\_per\_mille | Integer | The number of unique gifts that receive this backdrop for every 1000 gifts upgraded |

#### UniqueGiftColors

This object contains information about the color scheme for a user's name, message replies and link previews based on a unique gift.

| Field | Type | Description |
| --- | --- | --- |
| model\_custom\_emoji\_id | String | Custom emoji identifier of the unique gift's model |
| symbol\_custom\_emoji\_id | String | Custom emoji identifier of the unique gift's symbol |
| light\_theme\_main\_color | Integer | Main color used in light themes; RGB format |
| light\_theme\_other\_colors | Array of Integer | List of 1-3 additional colors used in light themes; RGB format |
| dark\_theme\_main\_color | Integer | Main color used in dark themes; RGB format |
| dark\_theme\_other\_colors | Array of Integer | List of 1-3 additional colors used in dark themes; RGB format |

#### UniqueGift

This object describes a unique gift that was upgraded from a regular gift.

| Field | Type | Description |
| --- | --- | --- |
| gift\_id | String | Identifier of the regular gift from which the gift was upgraded |
| base\_name | String | Human-readable name of the regular gift from which this unique gift was upgraded |
| name | String | Unique name of the gift. This name can be used in `https://t.me/nft/...` links and story areas. |
| number | Integer | Unique number of the upgraded gift among gifts upgraded from the same regular gift |
| model | [UniqueGiftModel](#uniquegiftmodel) | Model of the gift |
| symbol | [UniqueGiftSymbol](#uniquegiftsymbol) | Symbol of the gift |
| backdrop | [UniqueGiftBackdrop](#uniquegiftbackdrop) | Backdrop of the gift |
| is\_premium | True | _Optional_. _True_, if the original regular gift was exclusively purchaseable by Telegram Premium subscribers |
| is\_burned | True | _Optional_. _True_, if the gift was used to craft another gift and isn't available anymore |
| is\_from\_blockchain | True | _Optional_. _True_, if the gift is assigned from the TON blockchain and can't be resold or transferred in Telegram |
| colors | [UniqueGiftColors](#uniquegiftcolors) | _Optional_. The color scheme that can be used by the gift's owner for the chat's name, replies to messages and link previews; for business account gifts and gifts that are currently on sale only |
| publisher\_chat | [Chat](#chat) | _Optional_. Information about the chat that published the gift |

#### GiftInfo

Describes a service message about a regular gift that was sent or received.

| Field | Type | Description |
| --- | --- | --- |
| gift | [Gift](#gift) | Information about the gift |
| owned\_gift\_id | String | _Optional_. Unique identifier of the received gift for the bot; only present for gifts received on behalf of business accounts |
| convert\_star\_count | Integer | _Optional_. Number of Telegram Stars that can be claimed by the receiver by converting the gift; omitted if conversion to Telegram Stars is impossible |
| prepaid\_upgrade\_star\_count | Integer | _Optional_. Number of Telegram Stars that were prepaid for the ability to upgrade the gift |
| is\_upgrade\_separate | True | _Optional_. _True_, if the gift's upgrade was purchased after the gift was sent |
| can\_be\_upgraded | True | _Optional_. _True_, if the gift can be upgraded to a unique gift |
| text | String | _Optional_. Text of the message that was added to the gift |
| entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the text |
| is\_private | True | _Optional_. _True_, if the sender and gift text are shown only to the gift receiver; otherwise, everyone will be able to see them |
| unique\_gift\_number | Integer | _Optional_. Unique number reserved for this gift when upgraded. See the _number_ field in [UniqueGift](#uniquegift). |

#### UniqueGiftInfo

Describes a service message about a unique gift that was sent or received.

| Field | Type | Description |
| --- | --- | --- |
| gift | [UniqueGift](#uniquegift) | Information about the gift |
| origin | String | Origin of the gift. Currently, either “upgrade” for gifts upgraded from regular gifts, “transfer” for gifts transferred from other users or channels, “resale” for gifts bought from other users, “gifted\_upgrade” for upgrades purchased after the gift was sent, or “offer” for gifts bought or sold through gift purchase offers. |
| last\_resale\_currency | String | _Optional_. For gifts bought from other users, the currency in which the payment for the gift was done. Currently, one of “XTR” for Telegram Stars or “TON” for toncoins. |
| last\_resale\_amount | Integer | _Optional_. For gifts bought from other users, the price paid for the gift in either Telegram Stars or nanotoncoins |
| owned\_gift\_id | String | _Optional_. Unique identifier of the received gift for the bot; only present for gifts received on behalf of business accounts |
| transfer\_star\_count | Integer | _Optional_. Number of Telegram Stars that must be paid to transfer the gift; omitted if the bot cannot transfer the gift |
| next\_transfer\_date | Integer | _Optional_. Point in time (Unix timestamp) when the gift can be transferred. If it is in the past, then the gift can be transferred now. |

#### OwnedGift

This object describes a gift received and owned by a user or a chat. Currently, it can be one of

- [OwnedGiftRegular](#ownedgiftregular)
- [OwnedGiftUnique](#ownedgiftunique)

#### OwnedGiftRegular

Describes a regular gift owned by a user or a chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the gift, always “regular” |
| gift | [Gift](#gift) | Information about the regular gift |
| owned\_gift\_id | String | _Optional_. Unique identifier of the gift for the bot; for gifts received on behalf of business accounts only |
| sender\_user | [User](#user) | _Optional_. Sender of the gift if it is a known user |
| send\_date | Integer | Date the gift was sent in Unix time |
| text | String | _Optional_. Text of the message that was added to the gift |
| entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in the text |
| is\_private | True | _Optional_. _True_, if the sender and gift text are shown only to the gift receiver; otherwise, everyone will be able to see them |
| is\_saved | True | _Optional_. _True_, if the gift is displayed on the account's profile page; for gifts received on behalf of business accounts only |
| can\_be\_upgraded | True | _Optional_. _True_, if the gift can be upgraded to a unique gift; for gifts received on behalf of business accounts only |
| was\_refunded | True | _Optional_. _True_, if the gift was refunded and isn't available anymore |
| convert\_star\_count | Integer | _Optional_. Number of Telegram Stars that can be claimed by the receiver instead of the gift; omitted if the gift cannot be converted to Telegram Stars; for gifts received on behalf of business accounts only |
| prepaid\_upgrade\_star\_count | Integer | _Optional_. Number of Telegram Stars that were paid for the ability to upgrade the gift |
| is\_upgrade\_separate | True | _Optional_. _True_, if the gift's upgrade was purchased after the gift was sent; for gifts received on behalf of business accounts only |
| unique\_gift\_number | Integer | _Optional_. Unique number reserved for this gift when upgraded. See the _number_ field in [UniqueGift](#uniquegift). |

#### OwnedGiftUnique

Describes a unique gift received and owned by a user or a chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the gift, always “unique” |
| gift | [UniqueGift](#uniquegift) | Information about the unique gift |
| owned\_gift\_id | String | _Optional_. Unique identifier of the received gift for the bot; for gifts received on behalf of business accounts only |
| sender\_user | [User](#user) | _Optional_. Sender of the gift if it is a known user |
| send\_date | Integer | Date the gift was sent in Unix time |
| is\_saved | True | _Optional_. _True_, if the gift is displayed on the account's profile page; for gifts received on behalf of business accounts only |
| can\_be\_transferred | True | _Optional_. _True_, if the gift can be transferred to another owner; for gifts received on behalf of business accounts only |
| transfer\_star\_count | Integer | _Optional_. Number of Telegram Stars that must be paid to transfer the gift; omitted if the bot cannot transfer the gift |
| next\_transfer\_date | Integer | _Optional_. Point in time (Unix timestamp) when the gift can be transferred. If it is in the past, then the gift can be transferred now. |

#### OwnedGifts

Contains the list of gifts received and owned by a user or a chat.

| Field | Type | Description |
| --- | --- | --- |
| total\_count | Integer | The total number of gifts owned by the user or the chat |
| gifts | Array of [OwnedGift](#ownedgift) | The list of gifts |
| next\_offset | String | _Optional_. Offset for the next request. If empty, then there are no more results. |

#### BotAccessSettings

This object describes the access settings of a bot.

| Field | Type | Description |
| --- | --- | --- |
| is\_access\_restricted | Boolean | _True_, if only selected users can access the bot. The bot's owner can always access it. |
| added\_users | Array of [User](#user) | _Optional_. The list of other users who have access to the bot if the access is restricted |

#### AcceptedGiftTypes

This object describes the types of gifts that can be gifted to a user or a chat.

| Field | Type | Description |
| --- | --- | --- |
| unlimited\_gifts | Boolean | _True_, if unlimited regular gifts are accepted |
| limited\_gifts | Boolean | _True_, if limited regular gifts are accepted |
| unique\_gifts | Boolean | _True_, if unique gifts or gifts that can be upgraded to unique for free are accepted |
| premium\_subscription | Boolean | _True_, if a Telegram Premium subscription is accepted |
| gifts\_from\_channels | Boolean | _True_, if transfers of unique gifts from channels are accepted |

#### StarAmount

Describes an amount of Telegram Stars.

| Field | Type | Description |
| --- | --- | --- |
| amount | Integer | Integer amount of Telegram Stars, rounded to 0; can be negative |
| nanostar\_amount | Integer | _Optional_. The number of 1/1000000000 shares of Telegram Stars; from -999999999 to 999999999; can be negative if and only if _amount_ is non-positive |

#### BotCommand

This object represents a bot command.

| Field | Type | Description |
| --- | --- | --- |
| command | String | Text of the command; 1-32 characters. Can contain only lowercase English letters, digits and underscores. |
| description | String | Description of the command; 1-256 characters |

#### BotCommandScope

This object represents the scope to which bot commands are applied. Currently, the following 7 scopes are supported:

- [BotCommandScopeDefault](#botcommandscopedefault)
- [BotCommandScopeAllPrivateChats](#botcommandscopeallprivatechats)
- [BotCommandScopeAllGroupChats](#botcommandscopeallgroupchats)
- [BotCommandScopeAllChatAdministrators](#botcommandscopeallchatadministrators)
- [BotCommandScopeChat](#botcommandscopechat)
- [BotCommandScopeChatAdministrators](#botcommandscopechatadministrators)
- [BotCommandScopeChatMember](#botcommandscopechatmember)

#### Determining list of commands

The following algorithm is used to determine the list of commands for a particular user viewing the bot menu. The first list of commands which is set is returned:

**Commands in the chat with the bot**

- botCommandScopeChat + language\_code
- botCommandScopeChat
- botCommandScopeAllPrivateChats + language\_code
- botCommandScopeAllPrivateChats
- botCommandScopeDefault + language\_code
- botCommandScopeDefault

**Commands in group and supergroup chats**

- botCommandScopeChatMember + language\_code
- botCommandScopeChatMember
- botCommandScopeChatAdministrators + language\_code (administrators only)
- botCommandScopeChatAdministrators (administrators only)
- botCommandScopeChat + language\_code
- botCommandScopeChat
- botCommandScopeAllChatAdministrators + language\_code (administrators only)
- botCommandScopeAllChatAdministrators (administrators only)
- botCommandScopeAllGroupChats + language\_code
- botCommandScopeAllGroupChats
- botCommandScopeDefault + language\_code
- botCommandScopeDefault

#### BotCommandScopeDefault

Represents the default [scope](#botcommandscope) of bot commands. Default commands are used if no commands with a [narrower scope](#determining-list-of-commands) are specified for the user.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Scope type, must be _default_ |

#### BotCommandScopeAllPrivateChats

Represents the [scope](#botcommandscope) of bot commands, covering all private chats.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Scope type, must be _all\_private\_chats_ |

#### BotCommandScopeAllGroupChats

Represents the [scope](#botcommandscope) of bot commands, covering all group and supergroup chats.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Scope type, must be _all\_group\_chats_ |

#### BotCommandScopeAllChatAdministrators

Represents the [scope](#botcommandscope) of bot commands, covering all group and supergroup chat administrators.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Scope type, must be _all\_chat\_administrators_ |

#### BotCommandScopeChat

Represents the [scope](#botcommandscope) of bot commands, covering a specific chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Scope type, must be _chat_ |
| chat\_id | Integer or String | Unique identifier for the target chat or username of the target supergroup in the format `@username`. Channel direct messages chats and channel chats aren't supported. |

#### BotCommandScopeChatAdministrators

Represents the [scope](#botcommandscope) of bot commands, covering all administrators of a specific group or supergroup chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Scope type, must be _chat\_administrators_ |
| chat\_id | Integer or String | Unique identifier for the target chat or username of the target supergroup in the format `@username`. Channel direct messages chats and channel chats aren't supported. |

#### BotCommandScopeChatMember

Represents the [scope](#botcommandscope) of bot commands, covering a specific member of a group or supergroup chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Scope type, must be _chat\_member_ |
| chat\_id | Integer or String | Unique identifier for the target chat or username of the target supergroup in the format `@username`. Channel direct messages chats and channel chats aren't supported. |
| user\_id | Integer | Unique identifier of the target user |

#### BotName

This object represents the bot's name.

| Field | Type | Description |
| --- | --- | --- |
| name | String | The bot's name |

#### BotDescription

This object represents the bot's description.

| Field | Type | Description |
| --- | --- | --- |
| description | String | The bot's description |

#### BotShortDescription

This object represents the bot's short description.

| Field | Type | Description |
| --- | --- | --- |
| short\_description | String | The bot's short description |

#### MenuButton

This object describes the bot's menu button in a private chat. It should be one of

- [MenuButtonCommands](#menubuttoncommands)
- [MenuButtonWebApp](#menubuttonwebapp)
- [MenuButtonDefault](#menubuttondefault)

If a menu button other than [MenuButtonDefault](#menubuttondefault) is set for a private chat, then it is applied in the chat. Otherwise the default menu button is applied. By default, the menu button opens the list of bot commands.

#### MenuButtonCommands

Represents a menu button, which opens the bot's list of commands.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the button, must be _commands_ |

#### MenuButtonWebApp

Represents a menu button, which launches a [Web App](https://core.telegram.org/bots/webapps).

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the button, must be _web\_app_ |
| text | String | Text on the button |
| web\_app | [WebAppInfo](#webappinfo) | Description of the Web App that will be launched when the user presses the button. The Web App will be able to send an arbitrary message on behalf of the user using the method [answerWebAppQuery](#answerwebappquery). Alternatively, a `t.me` link to a Web App of the bot can be specified in the object instead of the Web App's URL, in which case the Web App will be opened as if the user pressed the link. |

#### MenuButtonDefault

Describes that no specific value for the menu button was set.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the button, must be _default_ |

#### ChatBoostSource

This object describes the source of a chat boost. It can be one of

- [ChatBoostSourcePremium](#chatboostsourcepremium)
- [ChatBoostSourceGiftCode](#chatboostsourcegiftcode)
- [ChatBoostSourceGiveaway](#chatboostsourcegiveaway)

#### ChatBoostSourcePremium

The boost was obtained by subscribing to Telegram Premium or by gifting a Telegram Premium subscription to another user.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Source of the boost, always “premium” |
| user | [User](#user) | User that boosted the chat |

#### ChatBoostSourceGiftCode

The boost was obtained by the creation of Telegram Premium gift codes to boost a chat. Each such code boosts the chat 4 times for the duration of the corresponding Telegram Premium subscription.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Source of the boost, always “gift\_code” |
| user | [User](#user) | User for which the gift code was created |

#### ChatBoostSourceGiveaway

The boost was obtained by the creation of a Telegram Premium or a Telegram Star giveaway. This boosts the chat 4 times for the duration of the corresponding Telegram Premium subscription for Telegram Premium giveaways and _prize\_star\_count_ / 500 times for one year for Telegram Star giveaways.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Source of the boost, always “giveaway” |
| giveaway\_message\_id | Integer | Identifier of a message in the chat with the giveaway; the message could have been deleted already. May be 0 if the message isn't sent yet. |
| user | [User](#user) | _Optional_. User that won the prize in the giveaway if any; for Telegram Premium giveaways only |
| prize\_star\_count | Integer | _Optional_. The number of Telegram Stars to be split between giveaway winners; for Telegram Star giveaways only |
| is\_unclaimed | True | _Optional_. _True_, if the giveaway was completed, but there was no user to win the prize |

#### ChatBoost

This object contains information about a chat boost.

| Field | Type | Description |
| --- | --- | --- |
| boost\_id | String | Unique identifier of the boost |
| add\_date | Integer | Point in time (Unix timestamp) when the chat was boosted |
| expiration\_date | Integer | Point in time (Unix timestamp) when the boost will automatically expire, unless the booster's Telegram Premium subscription is prolonged |
| source | [ChatBoostSource](#chatboostsource) | Source of the added boost |

#### ChatBoostUpdated

This object represents a boost added to a chat or changed.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | Chat which was boosted |
| boost | [ChatBoost](#chatboost) | Information about the chat boost |

#### ChatBoostRemoved

This object represents a boost removed from a chat.

| Field | Type | Description |
| --- | --- | --- |
| chat | [Chat](#chat) | Chat which was boosted |
| boost\_id | String | Unique identifier of the boost |
| remove\_date | Integer | Point in time (Unix timestamp) when the boost was removed |
| source | [ChatBoostSource](#chatboostsource) | Source of the removed boost |

#### ChatOwnerLeft

Describes a service message about the chat owner leaving the chat.

| Field | Type | Description |
| --- | --- | --- |
| new\_owner | [User](#user) | _Optional_. The user who will become the new owner of the chat if the previous owner does not return to the chat |

#### ChatOwnerChanged

Describes a service message about an ownership change in the chat.

| Field | Type | Description |
| --- | --- | --- |
| new\_owner | [User](#user) | The new owner of the chat |

#### UserChatBoosts

This object represents a list of boosts added to a chat by a user.

| Field | Type | Description |
| --- | --- | --- |
| boosts | Array of [ChatBoost](#chatboost) | The list of boosts added to the chat by the user |

#### BusinessBotRights

Represents the rights of a business bot.

| Field | Type | Description |
| --- | --- | --- |
| can\_reply | True | _Optional_. _True_, if the bot can send and edit messages in the private chats that had incoming messages in the last 24 hours |
| can\_read\_messages | True | _Optional_. _True_, if the bot can mark incoming private messages as read |
| can\_delete\_sent\_messages | True | _Optional_. _True_, if the bot can delete messages sent by the bot |
| can\_delete\_all\_messages | True | _Optional_. _True_, if the bot can delete all private messages in managed chats |
| can\_edit\_name | True | _Optional_. _True_, if the bot can edit the first and last name of the business account |
| can\_edit\_bio | True | _Optional_. _True_, if the bot can edit the bio of the business account |
| can\_edit\_profile\_photo | True | _Optional_. _True_, if the bot can edit the profile photo of the business account |
| can\_edit\_username | True | _Optional_. _True_, if the bot can edit the username of the business account |
| can\_change\_gift\_settings | True | _Optional_. _True_, if the bot can change the privacy settings pertaining to gifts for the business account |
| can\_view\_gifts\_and\_stars | True | _Optional_. _True_, if the bot can view gifts and the amount of Telegram Stars owned by the business account |
| can\_convert\_gifts\_to\_stars | True | _Optional_. _True_, if the bot can convert regular gifts owned by the business account to Telegram Stars |
| can\_transfer\_and\_upgrade\_gifts | True | _Optional_. _True_, if the bot can transfer and upgrade gifts owned by the business account |
| can\_transfer\_stars | True | _Optional_. _True_, if the bot can transfer Telegram Stars received by the business account to its own account, or use them to upgrade and transfer gifts |
| can\_manage\_stories | True | _Optional_. _True_, if the bot can post, edit and delete stories on behalf of the business account |

#### BusinessConnection

Describes the connection of the bot with a business account.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique identifier of the business connection |
| user | [User](#user) | Business account user that created the business connection |
| user\_chat\_id | Integer | Identifier of a private chat with the user who created the business connection. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a 64-bit integer or double-precision float type are safe for storing this identifier. |
| date | Integer | Date the connection was established in Unix time |
| rights | [BusinessBotRights](#businessbotrights) | _Optional_. Rights of the business bot |
| is\_enabled | Boolean | _True_, if the connection is active |

#### BusinessMessagesDeleted

This object is received when messages are deleted from a connected business account.

| Field | Type | Description |
| --- | --- | --- |
| business\_connection\_id | String | Unique identifier of the business connection |
| chat | [Chat](#chat) | Information about a chat in the business account. The bot may not have access to the chat or the corresponding user. |
| message\_ids | Array of Integer | The list of identifiers of deleted messages in the chat of the business account |

#### SentWebAppMessage

Describes an inline message sent by a [Web App](https://core.telegram.org/bots/webapps) on behalf of a user.

| Field | Type | Description |
| --- | --- | --- |
| inline\_message\_id | String | _Optional_. Identifier of the sent inline message. Available only if there is an [inline keyboard](#inlinekeyboardmarkup) attached to the message. |

#### SentGuestMessage

Describes an inline message sent by a guest bot.

| Field | Type | Description |
| --- | --- | --- |
| inline\_message\_id | String | Identifier of the sent inline message |

#### PreparedInlineMessage

Describes an inline message to be sent by a user of a Mini App.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique identifier of the prepared message |
| expiration\_date | Integer | Expiration date of the prepared message, in Unix time. Expired prepared messages can no longer be used. |

#### PreparedKeyboardButton

Describes a keyboard button to be used by a user of a Mini App.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique identifier of the keyboard button |

#### ResponseParameters

Describes why a request was unsuccessful.

| Field | Type | Description |
| --- | --- | --- |
| migrate\_to\_chat\_id | Integer | _Optional_. The group has been migrated to a supergroup with the specified identifier. This number may have more than 32 significant bits and some programming languages may have difficulty/silent defects in interpreting it. But it has at most 52 significant bits, so a signed 64-bit integer or double-precision float type are safe for storing this identifier. |
| retry\_after | Integer | _Optional_. In case of exceeding flood control, the number of seconds left to wait before the request can be repeated |

#### InputMedia

This object represents the content of a media message to be sent. It should be one of

- [InputMediaAnimation](#inputmediaanimation)
- [InputMediaAudio](#inputmediaaudio)
- [InputMediaDocument](#inputmediadocument)
- [InputMediaLivePhoto](#inputmedialivephoto)
- [InputMediaPhoto](#inputmediaphoto)
- [InputMediaVideo](#inputmediavideo)

#### InputMediaAnimation

Represents an animation file (GIF or H.264/MPEG-4 AVC video without sound) to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _animation_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| thumbnail | String | _Optional_. Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| caption | String | _Optional_. Caption of the animation to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the animation caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| width | Integer | _Optional_. Animation width |
| height | Integer | _Optional_. Animation height |
| duration | Integer | _Optional_. Animation duration in seconds |
| has\_spoiler | Boolean | _Optional_. Pass _True_ if the animation needs to be covered with a spoiler animation |

#### InputMediaAudio

Represents an audio file to be treated as music to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _audio_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| thumbnail | String | _Optional_. Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| caption | String | _Optional_. Caption of the audio to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the audio caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| duration | Integer | _Optional_. Duration of the audio in seconds |
| performer | String | _Optional_. Performer of the audio |
| title | String | _Optional_. Title of the audio |

#### InputMediaDocument

Represents a general file to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _document_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| thumbnail | String | _Optional_. Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| caption | String | _Optional_. Caption of the document to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the document caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| disable\_content\_type\_detection | Boolean | _Optional_. Disables automatic server-side content type detection for files uploaded using multipart/form-data. Always _True_, if the document is sent as part of an album. |

#### InputMediaLink

Represents an HTTP link to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _link_ |
| url | String | HTTP URL of the link |

#### InputMediaLivePhoto

Represents a live photo to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _live\_photo_ |
| media | String | Video of the live photo to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended) or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files). Sending live photos by a URL is currently unsupported. |
| photo | String | The static photo to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended) or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files). Sending live photos by a URL is currently unsupported. |
| caption | String | _Optional_. Caption of the live photo to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the live photo caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| has\_spoiler | Boolean | _Optional_. Pass _True_ if the live photo needs to be covered with a spoiler animation |

#### InputMediaLocation

Represents a location to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _location_ |
| latitude | Float | Latitude of the location |
| longitude | Float | Longitude of the location |
| horizontal\_accuracy | Float | _Optional_. The radius of uncertainty for the location, measured in meters; 0-1500 |

#### InputMediaPhoto

Represents a photo to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _photo_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| caption | String | _Optional_. Caption of the photo to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the photo caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| has\_spoiler | Boolean | _Optional_. Pass _True_ if the photo needs to be covered with a spoiler animation |

#### InputMediaSticker

Represents a sticker file to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _sticker_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a .WEBP sticker from the Internet, or pass “attach://<file\_attach\_name>” to upload a new .WEBP, .TGS, or .WEBM sticker using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| emoji | String | _Optional_. Emoji associated with the sticker; only for just uploaded stickers |

#### InputMediaVenue

Represents a venue to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _venue_ |
| latitude | Float | Latitude of the location |
| longitude | Float | Longitude of the location |
| title | String | Name of the venue |
| address | String | Address of the venue |
| foursquare\_id | String | _Optional_. Foursquare identifier of the venue |
| foursquare\_type | String | _Optional_. Foursquare type of the venue, if known. (For example, “arts\_entertainment/default”, “arts\_entertainment/aquarium” or “food/icecream”.) |
| google\_place\_id | String | _Optional_. Google Places identifier of the venue |
| google\_place\_type | String | _Optional_. Google Places type of the venue. (See [supported types](https://developers.google.com/places/web-service/supported_types).) |

#### InputMediaVideo

Represents a video to be sent.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _video_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| thumbnail | String | _Optional_. Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| cover | String | _Optional_. Cover for the video in the message. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| start\_timestamp | Integer | _Optional_. Start timestamp for the video in the message |
| caption | String | _Optional_. Caption of the video to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the video caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| width | Integer | _Optional_. Video width |
| height | Integer | _Optional_. Video height |
| duration | Integer | _Optional_. Video duration in seconds |
| supports\_streaming | Boolean | _Optional_. Pass _True_ if the uploaded video is suitable for streaming |
| has\_spoiler | Boolean | _Optional_. Pass _True_ if the video needs to be covered with a spoiler animation |

#### InputFile

This object represents the contents of a file to be uploaded. Must be posted using multipart/form-data in the usual way that files are uploaded via the browser.

#### InputPaidMedia

This object describes the paid media to be sent. Currently, it can be one of

- [InputPaidMediaLivePhoto](#inputpaidmedialivephoto)
- [InputPaidMediaPhoto](#inputpaidmediaphoto)
- [InputPaidMediaVideo](#inputpaidmediavideo)

#### InputPaidMediaLivePhoto

The paid media to send is a live photo.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _live\_photo_ |
| media | String | Video of the live photo to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended) or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files). Sending live photos by a URL is currently unsupported. |
| photo | String | The static photo to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended) or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files). Sending live photos by a URL is currently unsupported. |

#### InputPaidMediaPhoto

The paid media to send is a photo.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _photo_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |

#### InputPaidMediaVideo

The paid media to send is a video.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the media, must be _video_ |
| media | String | File to send. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| thumbnail | String | _Optional_. Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| cover | String | _Optional_. Cover for the video in the message. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| start\_timestamp | Integer | _Optional_. Start timestamp for the video in the message |
| width | Integer | _Optional_. Video width |
| height | Integer | _Optional_. Video height |
| duration | Integer | _Optional_. Video duration in seconds |
| supports\_streaming | Boolean | _Optional_. Pass _True_ if the uploaded video is suitable for streaming |

#### InputProfilePhoto

This object describes a profile photo to set. Currently, it can be one of

- [InputProfilePhotoStatic](#inputprofilephotostatic)
- [InputProfilePhotoAnimated](#inputprofilephotoanimated)

#### InputProfilePhotoStatic

A static profile photo in the .JPG format.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the profile photo, must be _static_ |
| photo | String | The static profile photo. Profile photos can't be reused and can only be uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the photo was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |

#### InputProfilePhotoAnimated

An animated profile photo in the MPEG4 format.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the profile photo, must be _animated_ |
| animation | String | The animated profile photo. Profile photos can't be reused and can only be uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the photo was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| main\_frame\_timestamp | Float | _Optional_. Timestamp in seconds of the frame that will be used as the static profile photo. Defaults to 0.0. |

#### InputStoryContent

This object describes the content of a story to post. Currently, it can be one of

- [InputStoryContentPhoto](#inputstorycontentphoto)
- [InputStoryContentVideo](#inputstorycontentvideo)

#### InputStoryContentPhoto

Describes a photo to post as a story.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the content, must be _photo_ |
| photo | String | The photo to post as a story. The photo must be of the size 1080x1920 and must not exceed 10 MB. The photo can't be reused and can only be uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the photo was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |

#### InputStoryContentVideo

Describes a video to post as a story.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the content, must be _video_ |
| video | String | The video to post as a story. The video must be of the size 720x1280, streamable, encoded with H.265 codec, with key frames added each second in the MPEG4 format, and must not exceed 30 MB. The video can't be reused and can only be uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the video was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| duration | Float | _Optional_. Precise duration of the video in seconds; 0-60 |
| cover\_frame\_timestamp | Float | _Optional_. Timestamp in seconds of the frame that will be used as the static cover for the story. Defaults to 0.0. |
| is\_animation | Boolean | _Optional_. Pass _True_ if the video has no sound |

#### Sending files

There are three ways to send files (photos, stickers, audio, media, etc.):

1.  If the file is already stored somewhere on the Telegram servers, you don't need to reupload it: each file object has a **file\_id** field, simply pass this **file\_id** as a parameter instead of uploading. There are **no limits** for files sent this way.
2.  Provide Telegram with an HTTP URL for the file to be sent. Telegram will download and send the file. 5 MB max size for photos and 20 MB max for other types of content.
3.  Post the file using multipart/form-data in the usual way that files are uploaded via the browser. 10 MB max size for photos, 50 MB for other files.

**Sending by file\_id**

- It is not possible to change the file type when resending by **file\_id**. I.e. a [video](#video) can't be [sent as a photo](#sendphoto), a [photo](#photosize) can't be [sent as a document](#senddocument), etc.
- It is not possible to resend thumbnails.
- Resending a photo by **file\_id** will send all of its [sizes](#photosize).
- **file\_id** is unique for each individual bot and **can't** be transferred from one bot to another.
- **file\_id** uniquely identifies a file, but a file can have different valid **file\_id**s even for the same bot.

**Sending by URL**

- When sending by URL the target file must have the correct MIME type (e.g., audio/mpeg for [sendAudio](#sendaudio), etc.).
- In [sendDocument](#senddocument), sending by URL will currently only work for **.PDF** and **.ZIP** files.
- To use [sendVoice](#sendvoice), the file must have the type audio/ogg and be no more than 1MB in size. 1-20MB voice notes will be sent as files.
- Other configurations may work but we can't guarantee that they will.

#### Accent colors

Colors with identifiers 0 (red), 1 (orange), 2 (purple/violet), 3 (green), 4 (cyan), 5 (blue), 6 (pink) can be customized by app themes. Additionally, the following colors in RGB format are currently in use.

| Color identifier | Light colors | Dark colors |
| --- | --- | --- |
| 7   | E15052 F9AE63 | FF9380 992F37 |
| 8   | E0802B FAC534 | ECB04E C35714 |
| 9   | A05FF3 F48FFF | C697FF 5E31C8 |
| 10  | 27A910 A7DC57 | A7EB6E 167E2D |
| 11  | 27ACCE 82E8D6 | 40D8D0 045C7F |
| 12  | 3391D4 7DD3F0 | 52BFFF 0B5494 |
| 13  | DD4371 FFBE9F | FF86A6 8E366E |
| 14  | 247BED F04856 FFFFFF | 3FA2FE E5424F FFFFFF |
| 15  | D67722 1EA011 FFFFFF | FF905E 32A527 FFFFFF |
| 16  | 179E42 E84A3F FFFFFF | 66D364 D5444F FFFFFF |
| 17  | 2894AF 6FC456 FFFFFF | 22BCE2 3DA240 FFFFFF |
| 18  | 0C9AB3 FFAD95 FFE6B5 | 22BCE2 FF9778 FFDA6B |
| 19  | 7757D6 F79610 FFDE8E | 9791FF F2731D FFDB59 |
| 20  | 1585CF F2AB1D FFFFFF | 3DA6EB EEA51D FFFFFF |

#### Profile accent colors

Currently, the following colors in RGB format are in use for profile backgrounds.

| Color identifier | Light colors | Dark colors |
| --- | --- | --- |
| 0   | BA5650 | 9C4540 |
| 1   | C27C3E | 945E2C |
| 2   | 956AC8 | 715099 |
| 3   | 49A355 | 33713B |
| 4   | 3E97AD | 387E87 |
| 5   | 5A8FBB | 477194 |
| 6   | B85378 | 944763 |
| 7   | 7F8B95 | 435261 |
| 8   | C9565D D97C57 | 994343 AC583E |
| 9   | CF7244 CC9433 | 8F552F A17232 |
| 10  | 9662D4 B966B6 | 634691 9250A2 |
| 11  | 3D9755 89A650 | 296A43 5F8F44 |
| 12  | 3D95BA 50AD98 | 306C7C 3E987E |
| 13  | 538BC2 4DA8BD | 38618C 458BA1 |
| 14  | B04F74 D1666D | 884160 A65259 |
| 15  | 637482 7B8A97 | 53606E 384654 |

#### Inline mode objects

Objects and methods used in the inline mode are described in the [Inline mode section](#inline-mode).

### Available methods

> All methods in the Bot API are case-insensitive. We support **GET** and **POST** HTTP methods. Use either [URL query string](https://en.wikipedia.org/wiki/Query_string) or _application/json_ or _application/x-www-form-urlencoded_ or _multipart/form-data_ for passing parameters in Bot API requests.  
> On successful call, a JSON-object containing the result will be returned.

#### getMe

A simple method for testing your bot's authentication token. Requires no parameters. Returns basic information about the bot in form of a [User](#user) object.

#### logOut

Use this method to log out from the cloud Bot API server before launching the bot locally. You **must** log out the bot before running it locally, otherwise there is no guarantee that the bot will receive updates. After a successful call, you can immediately log in on a local server, but will not be able to log in back to the cloud Bot API server for 10 minutes. Returns _True_ on success. Requires no parameters.

#### close

Use this method to close the bot instance before moving it from one local server to another. You need to delete the webhook before calling this method to ensure that the bot isn't launched again after server restart. The method will return error 429 in the first 10 minutes after the bot is launched. Returns _True_ on success. Requires no parameters.

#### sendMessage

Use this method to send text messages. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| text | String | Yes | Text of the message to be sent, 1-4096 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the message text. See [formatting options](#formatting-options) for more details. |
| entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in message text, which can be specified instead of _parse\_mode_ |
| link\_preview\_options | [LinkPreviewOptions](#linkpreviewoptions) | Optional | Link preview generation options for the message |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### Formatting options

The Bot API supports basic formatting for messages. You can use bold, italic, underlined, strikethrough, spoiler text, block quotations as well as inline links and pre-formatted code in your bots' messages. Telegram clients will render them accordingly. You can specify text entities directly, or use markdown-style or HTML-style formatting.

Note that Telegram clients will display an **alert** to the user before opening an inline link ('Open this link?' together with the full URL).

Message entities can be nested, providing following restrictions are met:  
\- If two entities have common characters, then one of them is fully contained inside another.  
\- _bold_, _italic_, _underline_, _strikethrough_, and _spoiler_ entities can contain and can be part of any other entities, except _pre_ and _code_.  
\- _blockquote_ and _expandable\_blockquote_ entities can't be nested.  
\- All other entities can't contain each other.

Links `tg://user?id=<user_id>` can be used to mention a user by their identifier without using a username. Please note:

- These links will work **only** if they are used inside an inline link or in an inline keyboard button. For example, they will not work, when used in a message text.
- Unless the user is a member of the chat where they were mentioned, these mentions are only guaranteed to work if the user has contacted the bot in private in the past or has sent a callback query to the bot via an inline button and doesn't have Forwarded Messages privacy enabled for the bot.

You can find the list of programming and markup languages for which syntax highlighting is supported at [libprisma#supported-languages](https://github.com/TelegramMessenger/libprisma#supported-languages).

###### Date-time entity formatting

Date-time entity formatting is specified by a format string, which must adhere to the following regular expression: `r|w?[dD]?[tT]?`.

If the format string is empty, the underlying text is displayed as-is; however, the user can still receive the underlying date in their local format. When populated, the format string determines the output based on the presence of the following control characters:

- **`r`**: Displays the time relative to the current time. Cannot be combined with any other control characters.
- **`w`**: Displays the day of the week in the user's localized language.
- **`d`**: Displays the date in short form (e.g., “17.03.22”).
- **`D`**: Displays the date in long form (e.g., “March 17, 2022”).
- **`t`**: Displays the time in short form (e.g., “22:45”).
- **`T`**: Displays the time in long form (e.g., “22:45:00”).

###### MarkdownV2 style

To use this mode, pass _MarkdownV2_ in the _parse\_mode_ field. Use the following syntax in your message:

````
*bold \*text*
_italic \*text_
__underline__
~strikethrough~
||spoiler||
*bold _italic bold ~italic bold strikethrough ||italic bold strikethrough spoiler||~ __underline italic bold___ bold*
[inline URL](http://www.example.com/)
[inline mention of a user](tg://user?id=123456789)
![](tg://emoji?id=5368324170671202286)
![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)
![22:45 tomorrow](tg://time?unix=1647531900&format=t)
![22:45 tomorrow](tg://time?unix=1647531900&format=r)
![22:45 tomorrow](tg://time?unix=1647531900)
`inline fixed-width code`
```
pre-formatted fixed-width code block
```
```python
pre-formatted fixed-width code block written in the Python programming language
```
>Block quotation started
>Block quotation continued
>Block quotation continued
>Block quotation continued
>The last line of the block quotation
**>The expandable block quotation started right after the previous block quotation
>It is separated from the previous block quotation by an empty bold entity
>Expandable block quotation continued
>Hidden by default part of the expandable block quotation started
>Expandable block quotation continued
>The last line of the expandable block quotation with the expandability mark||
````

Please note:

- Any character with code between 1 and 126 inclusively can be escaped anywhere with a preceding '\\' character, in which case it is treated as an ordinary character and not a part of the markup. This implies that '\\' character usually must be escaped with a preceding '\\' character.
- Inside `pre` and `code` entities, all '\`' and '\\' characters must be escaped with a preceding '\\' character.
- Inside the `(...)` part of the inline link and custom emoji definition, all ')' and '\\' must be escaped with a preceding '\\' character.
- In all other places characters '\_', '\*', '\[', '\]', '(', ')', '~', '\`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!' must be escaped with the preceding character '\\'.
- In case of ambiguity between `italic` and `underline` entities `__` is always greedily treated from left to right as beginning or end of an `underline` entity, so instead of `___italic underline___` use `___italic underline_**__`, adding an empty bold entity as a separator.
- A valid emoji must be provided as an alternative value for the custom emoji. The emoji will be shown instead of the custom emoji in places where a custom emoji cannot be displayed (e.g., system notifications) or if the message is forwarded by a non-premium user. It is recommended to use the emoji from the **emoji** field of the custom emoji [sticker](#sticker).
- Custom emoji entities can only be used by bots that purchased additional usernames on [Fragment](https://fragment.com/) or in the messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription.
- See [date-time entity formatting](#date-time-entity-formatting) for more details about supported date-time formats.

###### HTML style

To use this mode, pass _HTML_ in the _parse\_mode_ field. The following tags are currently supported:

```
<b>bold</b>, <strong>bold</strong>
<i>italic</i>, <em>italic</em>
<u>underline</u>, <ins>underline</ins>
<s>strikethrough</s>, <strike>strikethrough</strike>, <del>strikethrough</del>
<span class="tg-spoiler">spoiler</span>, <tg-spoiler>spoiler</tg-spoiler>
<b>bold <i>italic bold <s>italic bold strikethrough <span class="tg-spoiler">italic bold strikethrough spoiler</span></s> <u>underline italic bold</u></i> bold</b>
<a href="http://www.example.com/">inline URL</a>
<a href="tg://user?id=123456789">inline mention of a user</a>
<tg-emoji emoji-id="5368324170671202286"></tg-emoji>
<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>
<tg-time unix="1647531900" format="t">22:45 tomorrow</tg-time>
<tg-time unix="1647531900" format="r">22:45 tomorrow</tg-time>
<tg-time unix="1647531900">22:45 tomorrow</tg-time>
<code>inline fixed-width code</code>
<pre>pre-formatted fixed-width code block</pre>
<pre><code class="language-python">pre-formatted fixed-width code block written in the Python programming language</code></pre>
<blockquote>Block quotation started\nBlock quotation continued\nThe last line of the block quotation</blockquote>
<blockquote expandable>Expandable block quotation started\nExpandable block quotation continued\nExpandable block quotation continued\nHidden by default part of the block quotation started\nExpandable block quotation continued\nThe last line of the block quotation</blockquote>
```

Please note:

- Only the tags mentioned above are currently supported.
- All `<`, `>` and `&` symbols that are not a part of a tag or an HTML entity must be replaced with the corresponding HTML entities (`<` with `&lt;`, `>` with `&gt;` and `&` with `&amp;`).
- All numerical HTML entities are supported.
- The API currently supports only the following named HTML entities: `&lt;`, `&gt;`, `&amp;` and `&quot;`.
- Use nested `pre` and `code` tags, to define programming language for `pre` entity.
- Programming language can't be specified for standalone `code` tags.
- A valid emoji must be used as the content of the `tg-emoji` tag. The emoji will be shown instead of the custom emoji in places where a custom emoji cannot be displayed (e.g., system notifications) or if the message is forwarded by a non-premium user. It is recommended to use the emoji from the **emoji** field of the custom emoji [sticker](#sticker).
- Custom emoji entities can only be used by bots that purchased additional usernames on [Fragment](https://fragment.com/) or in the messages directly sent by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription.
- See [date-time entity formatting](#date-time-entity-formatting) for more details about supported date-time formats.

###### Markdown style

This is a legacy mode, retained for backward compatibility. To use this mode, pass _Markdown_ in the _parse\_mode_ field. Use the following syntax in your message:

````
*bold text*
_italic text_
[inline URL](http://www.example.com/)
[inline mention of a user](tg://user?id=123456789)
`inline fixed-width code`
```
pre-formatted fixed-width code block
```
```python
pre-formatted fixed-width code block written in the Python programming language
```
````

Please note:

- Entities must not be nested, use parse mode [MarkdownV2](#markdownv2-style) instead.
- There is no way to specify “underline”, “strikethrough”, “spoiler”, “blockquote”, “expandable\_blockquote”, “custom\_emoji”, and “date\_time” entities, use parse mode [MarkdownV2](#markdownv2-style) instead.
- To escape characters '\_', '\*', '\`', '\[' outside of an entity, prepend the character '\\' before them.
- Escaping inside entities is not allowed, so entity must be closed first and reopened again: use `_snake_\__case_` for italic `snake_case` and `*2*\**2=4*` for bold `2*2=4`.

#### Paid Broadcasts

By default, all bots are able to broadcast up to [30 messages](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this) per second to their users. Developers can increase this limit by enabling _Paid Broadcasts_ in [@BotFather](https://t.me/botfather) - allowing their bot to broadcast **up to 1000 messages** per second.

Each message broadcasted over the free amount of 30 messages per second incurs a cost of 0.1 Stars per message, paid with Telegram Stars from the bot's balance. In order to use this feature, a bot must have at least _10,000 Stars_ on its balance.

> Bots with increased limits are only charged for messages that are broadcasted successfully.

#### forwardMessage

Use this method to forward messages of any kind. Service messages and messages with protected content can't be forwarded. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be forwarded; required if the message is forwarded to a direct messages chat |
| from\_chat\_id | Integer or String | Yes | Unique identifier for the chat where the original message was sent (or username of the target bot, supergroup or channel in the format `@username`) |
| video\_start\_timestamp | Integer | Optional | New start timestamp for the forwarded video in the message |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the forwarded message from forwarding and saving |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; only available when forwarding to private chats |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only |
| message\_id | Integer | Yes | Message identifier in the chat specified in _from\_chat\_id_ |

#### forwardMessages

Use this method to forward multiple messages of any kind. If some of the specified messages can't be found or forwarded, they are skipped. Service messages and messages with protected content can't be forwarded. Album grouping is kept for forwarded messages. On success, an array of [MessageId](#messageid) of the sent messages is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the messages will be forwarded; required if the messages are forwarded to a direct messages chat |
| from\_chat\_id | Integer or String | Yes | Unique identifier for the chat where the original messages were sent (or username of the target bot, supergroup or channel in the format `@username`) |
| message\_ids | Array of Integer | Yes | A JSON-serialized list of 1-100 identifiers of messages in the chat _from\_chat\_id_ to forward. The identifiers must be specified in a strictly increasing order. |
| disable\_notification | Boolean | Optional | Sends the messages [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the forwarded messages from forwarding and saving |

#### copyMessage

Use this method to copy messages of any kind. Service messages, paid media messages, giveaway messages, giveaway winners messages, and invoice messages can't be copied. A quiz [poll](#poll) can be copied only if the value of the field _correct\_option\_id_ is known to the bot. The method is analogous to the method [forwardMessage](#forwardmessage), but the copied message doesn't have a link to the original message. Returns the [MessageId](#messageid) of the sent message on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| from\_chat\_id | Integer or String | Yes | Unique identifier for the chat where the original message was sent (or username of the target bot, supergroup or channel in the format `@username`) |
| message\_id | Integer | Yes | Message identifier in the chat specified in _from\_chat\_id_ |
| video\_start\_timestamp | Integer | Optional | New start timestamp for the copied video in the message |
| caption | String | Optional | New caption for media, 0-1024 characters after entities parsing. If not specified, the original caption is kept. |
| parse\_mode | String | Optional | Mode for parsing entities in the new caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the new caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | Optional | Pass _True_, if the caption must be shown above the message media. Ignored if a new caption isn't specified. |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; only available when copying to private chats |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### copyMessages

Use this method to copy messages of any kind. If some of the specified messages can't be found or copied, they are skipped. Service messages, paid media messages, giveaway messages, giveaway winners messages, and invoice messages can't be copied. A quiz [poll](#poll) can be copied only if the value of the field _correct\_option\_id_ is known to the bot. The method is analogous to the method [forwardMessages](#forwardmessages), but the copied messages don't have a link to the original message. Album grouping is kept for copied messages. On success, an array of [MessageId](#messageid) of the sent messages is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the messages will be sent; required if the messages are sent to a direct messages chat |
| from\_chat\_id | Integer or String | Yes | Unique identifier for the chat where the original messages were sent (or username of the target bot, supergroup or channel in the format `@username`) |
| message\_ids | Array of Integer | Yes | A JSON-serialized list of 1-100 identifiers of messages in the chat _from\_chat\_id_ to copy. The identifiers must be specified in a strictly increasing order. |
| disable\_notification | Boolean | Optional | Sends the messages [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent messages from forwarding and saving |
| remove\_caption | Boolean | Optional | Pass _True_ to copy the messages without their captions |

#### sendPhoto

Use this method to send photos. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| photo | [InputFile](#inputfile) or String | Yes | Photo to send. Pass a file\_id as String to send a photo that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a photo from the Internet, or upload a new photo using multipart/form-data. The photo must be at most 10 MB in size. The photo's width and height must not exceed 10000 in total. Width and height ratio must be at most 20. [More information on Sending Files »](#sending-files) |
| caption | String | Optional | Photo caption (may also be used when resending photos by _file\_id_), 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the photo caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | Optional | Pass _True_, if the caption must be shown above the message media |
| has\_spoiler | Boolean | Optional | Pass _True_ if the photo needs to be covered with a spoiler animation |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendLivePhoto

Use this method to send live photos. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel (in the format `@channelusername`) |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| live\_photo | [InputFile](#inputfile) or String | Yes | Live photo video to send. The video must be no longer than 10 seconds and must not exceed 10 MB in size. Pass a file\_id as String to send a video that exists on the Telegram servers (recommended) or upload a new video using multipart/form-data. [More information on Sending Files »](#sending-files). Sending live photos by a URL is currently unsupported. |
| photo | [InputFile](#inputfile) or String | Yes | The static photo to send. Pass a file\_id as String to send a photo that exists on the Telegram servers (recommended) or upload a new video using multipart/form-data. [More information on Sending Files »](#sending-files). Sending live photos by a URL is currently unsupported. |
| caption | String | Optional | Video caption (may also be used when resending videos by _file\_id_), 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the video caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | Optional | Pass _True_, if the caption must be shown above the message media |
| has\_spoiler | Boolean | Optional | Pass _True_ if the video needs to be covered with a spoiler animation |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendAudio

Use this method to send audio files, if you want Telegram clients to display them in the music player. Your audio must be in the .MP3 or .M4A format. On success, the sent [Message](#message) is returned. Bots can currently send audio files of up to 50 MB in size, this limit may be changed in the future.

For sending voice messages, use the [sendVoice](#sendvoice) method instead.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| audio | [InputFile](#inputfile) or String | Yes | Audio file to send. Pass a file\_id as String to send an audio file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get an audio file from the Internet, or upload a new one using multipart/form-data. [More information on Sending Files »](#sending-files) |
| caption | String | Optional | Audio caption, 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the audio caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| duration | Integer | Optional | Duration of the audio in seconds |
| performer | String | Optional | Performer |
| title | String | Optional | Track name |
| thumbnail | [InputFile](#inputfile) or String | Optional | Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendDocument

Use this method to send general files. On success, the sent [Message](#message) is returned. Bots can currently send files of any type of up to 50 MB in size, this limit may be changed in the future.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| document | [InputFile](#inputfile) or String | Yes | File to send. Pass a file\_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data. [More information on Sending Files »](#sending-files) |
| thumbnail | [InputFile](#inputfile) or String | Optional | Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| caption | String | Optional | Document caption (may also be used when resending documents by _file\_id_), 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the document caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| disable\_content\_type\_detection | Boolean | Optional | Disables automatic server-side content type detection for files uploaded using multipart/form-data |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendVideo

Use this method to send video files, Telegram clients support MPEG4 videos (other formats may be sent as [Document](#document)). On success, the sent [Message](#message) is returned. Bots can currently send video files of up to 50 MB in size, this limit may be changed in the future.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| video | [InputFile](#inputfile) or String | Yes | Video to send. Pass a file\_id as String to send a video that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a video from the Internet, or upload a new video using multipart/form-data. [More information on Sending Files »](#sending-files) |
| duration | Integer | Optional | Duration of sent video in seconds |
| width | Integer | Optional | Video width |
| height | Integer | Optional | Video height |
| thumbnail | [InputFile](#inputfile) or String | Optional | Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| cover | [InputFile](#inputfile) or String | Optional | Cover for the video in the message. Pass a file\_id to send a file that exists on the Telegram servers (recommended), pass an HTTP URL for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new one using multipart/form-data under <file\_attach\_name> name. [More information on Sending Files »](#sending-files) |
| start\_timestamp | Integer | Optional | Start timestamp for the video in the message |
| caption | String | Optional | Video caption (may also be used when resending videos by _file\_id_), 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the video caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | Optional | Pass _True_, if the caption must be shown above the message media |
| has\_spoiler | Boolean | Optional | Pass _True_ if the video needs to be covered with a spoiler animation |
| supports\_streaming | Boolean | Optional | Pass _True_ if the uploaded video is suitable for streaming |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendAnimation

Use this method to send animation files (GIF or H.264/MPEG-4 AVC video without sound). On success, the sent [Message](#message) is returned. Bots can currently send animation files of up to 50 MB in size, this limit may be changed in the future.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| animation | [InputFile](#inputfile) or String | Yes | Animation to send. Pass a file\_id as String to send an animation that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get an animation from the Internet, or upload a new animation using multipart/form-data. [More information on Sending Files »](#sending-files) |
| duration | Integer | Optional | Duration of sent animation in seconds |
| width | Integer | Optional | Animation width |
| height | Integer | Optional | Animation height |
| thumbnail | [InputFile](#inputfile) or String | Optional | Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| caption | String | Optional | Animation caption (may also be used when resending animation by _file\_id_), 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the animation caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | Optional | Pass _True_, if the caption must be shown above the message media |
| has\_spoiler | Boolean | Optional | Pass _True_ if the animation needs to be covered with a spoiler animation |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendVoice

Use this method to send audio files, if you want Telegram clients to display the file as a playable voice message. For this to work, your audio must be in an .OGG file encoded with OPUS, or in .MP3 format, or in .M4A format (other formats may be sent as [Audio](#audio) or [Document](#document)). On success, the sent [Message](#message) is returned. Bots can currently send voice messages of up to 50 MB in size, this limit may be changed in the future.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| voice | [InputFile](#inputfile) or String | Yes | Audio file to send. Pass a file\_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data. [More information on Sending Files »](#sending-files) |
| caption | String | Optional | Voice message caption, 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the voice message caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| duration | Integer | Optional | Duration of the voice message in seconds |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendVideoNote

As of [v.4.0](https://telegram.org/blog/video-messages-and-telescope), Telegram clients support rounded square MPEG4 videos of up to 1 minute long. Use this method to send video messages. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| video\_note | [InputFile](#inputfile) or String | Yes | Video note to send. Pass a file\_id as String to send a video note that exists on the Telegram servers (recommended) or upload a new video using multipart/form-data. [More information on Sending Files »](#sending-files). Sending video notes by a URL is currently unsupported. |
| duration | Integer | Optional | Duration of sent video in seconds |
| length | Integer | Optional | Video width and height, i.e. diameter of the video message |
| thumbnail | [InputFile](#inputfile) or String | Optional | Thumbnail of the file sent; can be ignored if thumbnail generation for the file is supported server-side. The thumbnail should be in JPEG format and less than 200 kB in size. A thumbnail's width and height should not exceed 320. Ignored if the file is not uploaded using multipart/form-data. Thumbnails can't be reused and can be only uploaded as a new file, so you can pass “attach://<file\_attach\_name>” if the thumbnail was uploaded using multipart/form-data under <file\_attach\_name>. [More information on Sending Files »](#sending-files) |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendPaidMedia

Use this method to send paid media. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. If the chat is a channel, all Telegram Star proceeds from this media will be credited to the chat's balance. Otherwise, they will be credited to the bot's balance. |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| star\_count | Integer | Yes | The number of Telegram Stars that must be paid to buy access to the media; 1-25000 |
| media | Array of [InputPaidMedia](#inputpaidmedia) | Yes | A JSON-serialized array describing the media to be sent; up to 10 items |
| payload | String | Optional | Bot-defined paid media payload, 0-128 bytes. This will not be displayed to the user, use it for your internal processes. |
| caption | String | Optional | Media caption, 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the media caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | Optional | Pass _True_, if the caption must be shown above the message media |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendMediaGroup

Use this method to send a group of photos, live photos, videos, documents or audios as an album. Documents and audio files can be only grouped in an album with messages of the same type. On success, an array of [Message](#message) objects that were sent is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the messages will be sent; required if the messages are sent to a direct messages chat |
| media | Array of [InputMediaAudio](#inputmediaaudio), [InputMediaDocument](#inputmediadocument), [InputMediaLivePhoto](#inputmedialivephoto), [InputMediaPhoto](#inputmediaphoto) and [InputMediaVideo](#inputmediavideo) | Yes | A JSON-serialized array describing messages to be sent, must include 2-10 items |
| disable\_notification | Boolean | Optional | Sends messages [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent messages from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |

#### sendLocation

Use this method to send point on the map. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| latitude | Float | Yes | Latitude of the location |
| longitude | Float | Yes | Longitude of the location |
| horizontal\_accuracy | Float | Optional | The radius of uncertainty for the location, measured in meters; 0-1500 |
| live\_period | Integer | Optional | Period in seconds during which the location will be updated (see [Live Locations](https://telegram.org/blog/live-locations), should be between 60 and 86400, or 0x7FFFFFFF for live locations that can be edited indefinitely |
| heading | Integer | Optional | For live locations, a direction in which the user is moving, in degrees. Must be between 1 and 360 if specified. |
| proximity\_alert\_radius | Integer | Optional | For live locations, a maximum distance for proximity alerts about approaching another chat member, in meters. Must be between 1 and 100000 if specified. |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendVenue

Use this method to send information about a venue. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| latitude | Float | Yes | Latitude of the venue |
| longitude | Float | Yes | Longitude of the venue |
| title | String | Yes | Name of the venue |
| address | String | Yes | Address of the venue |
| foursquare\_id | String | Optional | Foursquare identifier of the venue |
| foursquare\_type | String | Optional | Foursquare type of the venue, if known. (For example, “arts\_entertainment/default”, “arts\_entertainment/aquarium” or “food/icecream”.) |
| google\_place\_id | String | Optional | Google Places identifier of the venue |
| google\_place\_type | String | Optional | Google Places type of the venue. (See [supported types](https://developers.google.com/places/web-service/supported_types).) |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendContact

Use this method to send phone contacts. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| phone\_number | String | Yes | Contact's phone number |
| first\_name | String | Yes | Contact's first name |
| last\_name | String | Optional | Contact's last name |
| vcard | String | Optional | Additional data about the contact in the form of a [vCard](https://en.wikipedia.org/wiki/VCard), 0-2048 bytes |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendPoll

Use this method to send a native poll. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. Polls can't be sent to channel direct messages chats. |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| question | String | Yes | Poll question, 1-300 characters |
| question\_parse\_mode | String | Optional | Mode for parsing entities in the question. See [formatting options](#formatting-options) for more details. Currently, only custom emoji entities are allowed. |
| question\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the poll question. It can be specified instead of _question\_parse\_mode_. |
| options | Array of [InputPollOption](#inputpolloption) | Yes | A JSON-serialized list of 1-12 answer options |
| is\_anonymous | Boolean | Optional | _True_, if the poll needs to be anonymous, defaults to _True_ |
| type | String | Optional | Poll type, “quiz” or “regular”, defaults to “regular” |
| allows\_multiple\_answers | Boolean | Optional | Pass _True_, if the poll allows multiple answers, defaults to _False_ |
| allows\_revoting | Boolean | Optional | Pass _True_, if the poll allows to change chosen answer options, defaults to _False_ for quizzes and to _True_ for regular polls |
| shuffle\_options | Boolean | Optional | Pass _True_, if the poll options must be shown in random order |
| allow\_adding\_options | Boolean | Optional | Pass _True_, if answer options can be added to the poll after creation; not supported for anonymous polls and quizzes |
| hide\_results\_until\_closes | Boolean | Optional | Pass _True_, if poll results must be shown only after the poll closes |
| members\_only | Boolean | Optional | Pass _True_, if voting is limited to users who have been members of the chat where the poll is being sent for more than 24 hours; for channel chats only |
| country\_codes | Array of String | Optional | A JSON-serialized list of 0-12 two-letter [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) country codes indicating the countries from which users can vote in the poll; for channel chats only. Use “FT” as a country code to allow users with anonymous numbers to vote. If omitted or empty, then users from any country can participate in the poll. |
| correct\_option\_ids | Array of Integer | Optional | A JSON-serialized list of monotonically increasing 0-based identifiers of the correct answer options, required for polls in quiz mode |
| explanation | String | Optional | Text that is shown when a user chooses an incorrect answer or taps on the lamp icon in a quiz-style poll, 0-200 characters with at most 2 line feeds after entities parsing |
| explanation\_parse\_mode | String | Optional | Mode for parsing entities in the explanation. See [formatting options](#formatting-options) for more details. |
| explanation\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the poll explanation. It can be specified instead of _explanation\_parse\_mode_. |
| explanation\_media | [InputPollMedia](#inputpollmedia) | Optional | Media added to the quiz explanation |
| open\_period | Integer | Optional | Amount of time in seconds the poll will be active after creation, 5-2628000. Can't be used together with _close\_date_. |
| close\_date | Integer | Optional | Point in time (Unix timestamp) when the poll will be automatically closed. Must be at least 5 and no more than 2628000 seconds in the future. Can't be used together with _open\_period_. |
| is\_closed | Boolean | Optional | Pass _True_ if the poll needs to be immediately closed. This can be useful for poll preview. |
| description | String | Optional | Description of the poll to be sent, 0-1024 characters after entities parsing |
| description\_parse\_mode | String | Optional | Mode for parsing entities in the poll description. See [formatting options](#formatting-options) for more details. |
| description\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the poll description, which can be specified instead of _description\_parse\_mode_ |
| media | [InputPollMedia](#inputpollmedia) | Optional | Media added to the poll description |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendChecklist

Use this method to send a checklist on behalf of a connected business account. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot in the format `@username` |
| checklist | [InputChecklist](#inputchecklist) | Yes | A JSON-serialized object for the checklist to send |
| disable\_notification | Boolean | Optional | Sends the message silently. Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | A JSON-serialized object for description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for an inline keyboard |

#### sendDice

Use this method to send an animated emoji that will display a random value. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| emoji | String | Optional | Emoji on which the dice throw animation is based. Currently, must be one of “🎲”, “🎯”, “🏀”, “⚽”, “🎳”, or “🎰”. Dice can have values 1-6 for “🎲”, “🎯” and “🎳”, values 1-5 for “🏀” and “⚽”, and values 1-64 for “🎰”. Defaults to “🎲”. |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendMessageDraft

Use this method to stream a partial message to a user while the message is being generated. Note that the streamed draft is ephemeral and acts as a temporary 30-second preview - once the output is finalized, you **must** call [sendMessage](#sendmessage) with the complete message to persist it in the user's chat. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer | Yes | Unique identifier for the target private chat |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread |
| draft\_id | Integer | Yes | Unique identifier of the message draft; must be non-zero. Changes to drafts with the same identifier are animated. |
| text | String | Optional | Text of the message to be sent, 0-4096 characters after entities parsing. Pass an empty text to show a “Thinking…” placeholder. |
| parse\_mode | String | Optional | Mode for parsing entities in the message text. See [formatting options](#formatting-options) for more details. |
| entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in message text, which can be specified instead of _parse\_mode_ |

#### sendChatAction

Use this method when you need to tell the user that something is happening on the bot's side. The status is set for 5 seconds or less (when a message arrives from your bot, Telegram clients clear its typing status). Returns _True_ on success.

> Example: The [ImageBot](https://t.me/imagebot) needs some time to process a request and upload the image. Instead of sending a text message along the lines of “Retrieving image, please wait…”, the bot may use [sendChatAction](#sendchataction) with _action_ = _upload\_photo_. The user will see a “sending photo” status for the bot.

We only recommend using this method when a response from the bot will take a **noticeable** amount of time to arrive.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the action will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot or supergroup in the format `@username`. Channel chats and channel direct messages chats aren't supported. |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread or topic of a forum; for supergroups and private chats of bots with forum topic mode enabled only |
| action | String | Yes | Type of action to broadcast. Choose one, depending on what the user is about to receive: _typing_ for [text messages](#sendmessage), _upload\_photo_ for [photos](#sendphoto), _record\_video_ or _upload\_video_ for [videos](#sendvideo), _record\_voice_ or _upload\_voice_ for [voice notes](#sendvoice), _upload\_document_ for [general files](#senddocument), _choose\_sticker_ for [stickers](#sendsticker), _find\_location_ for [location data](#sendlocation), _record\_video\_note_ or _upload\_video\_note_ for [video notes](#sendvideonote). |

#### setMessageReaction

Use this method to change the chosen reactions on a message. Service messages of some types can't be reacted to. Automatically forwarded messages from a channel to its discussion group have the same available reactions as messages in the channel. Bots can't use paid reactions. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_id | Integer | Yes | Identifier of the target message. If the message belongs to a media group, the reaction is set to the first non-deleted message in the group instead. |
| reaction | Array of [ReactionType](#reactiontype) | Optional | A JSON-serialized list of reaction types to set on the message. Currently, as non-premium users, bots can set up to one reaction per message. A custom emoji reaction can be used if it is either already present on the message or explicitly allowed by chat administrators. Paid reactions can't be used by bots. |
| is\_big | Boolean | Optional | Pass _True_ to set the reaction with a big animation |

#### getUserProfilePhotos

Use this method to get a list of profile pictures for a user. Returns a [UserProfilePhotos](#userprofilephotos) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user |
| offset | Integer | Optional | Sequential number of the first photo to be returned. By default, all photos are returned. |
| limit | Integer | Optional | Limits the number of photos to be retrieved. Values between 1-100 are accepted. Defaults to 100. |

#### getUserProfileAudios

Use this method to get a list of profile audios for a user. Returns a [UserProfileAudios](#userprofileaudios) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user |
| offset | Integer | Optional | Sequential number of the first audio to be returned. By default, all audios are returned. |
| limit | Integer | Optional | Limits the number of audios to be retrieved. Values between 1-100 are accepted. Defaults to 100. |

#### setUserEmojiStatus

Changes the emoji status for a given user that previously allowed the bot to manage their emoji status via the Mini App method [requestEmojiStatusAccess](https://core.telegram.org/bots/webapps#initializing-mini-apps). Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user |
| emoji\_status\_custom\_emoji\_id | String | Optional | Custom emoji identifier of the emoji status to set. Pass an empty string to remove the status. |
| emoji\_status\_expiration\_date | Integer | Optional | Expiration date of the emoji status, if any |

#### getFile

Use this method to get basic information about a file and prepare it for downloading. For the moment, bots can download files of up to 20MB in size. On success, a [File](#file) object is returned. The file can then be downloaded via the link `https://api.telegram.org/file/bot<token>/<file_path>`, where `<file_path>` is taken from the response. It is guaranteed that the link will be valid for at least 1 hour. When the link expires, a new one can be requested by calling [getFile](#getfile) again.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| file\_id | String | Yes | File identifier to get information about |

**Note:** This function may not preserve the original file name and MIME type. You should save the file's MIME type and name (if available) when the File object is received.

#### banChatMember

Use this method to ban a user in a group, a supergroup or a channel. In the case of supergroups and channels, the user will not be able to return to the chat on their own using invite links, etc., unless [unbanned](#unbanchatmember) first. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target group or username of the target supergroup or channel in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |
| until\_date | Integer | Optional | Date when the user will be unbanned; Unix time. If user is banned for more than 366 days or less than 30 seconds from the current time they are considered to be banned forever. Applied for supergroups and channels only. |
| revoke\_messages | Boolean | Optional | Pass _True_ to delete all messages from the chat for the user that is being removed. If _False_, the user will be able to see messages in the group that were sent before the user was removed. Always _True_ for supergroups and channels. |

#### unbanChatMember

Use this method to unban a previously banned user in a supergroup or channel. The user will **not** return to the group or channel automatically, but will be able to join via link, etc. The bot must be an administrator for this to work. By default, this method guarantees that after the call the user is not a member of the chat, but will be able to join it. So if the user is a member of the chat they will also be **removed** from the chat. If you don't want this, use the parameter _only\_if\_banned_. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target group or username of the target supergroup or channel in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |
| only\_if\_banned | Boolean | Optional | Do nothing if the user is not banned |

#### restrictChatMember

Use this method to restrict a user in a supergroup. The bot must be an administrator in the supergroup for this to work and must have the appropriate administrator rights. Pass _True_ for all permissions to lift restrictions from a user. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |
| permissions | [ChatPermissions](#chatpermissions) | Yes | A JSON-serialized object for new user permissions |
| use\_independent\_chat\_permissions | Boolean | Optional | Pass _True_ if chat permissions are set independently. Otherwise, the _can\_send\_other\_messages_ and _can\_add\_web\_page\_previews_ permissions will imply the _can\_send\_messages_, _can\_send\_audios_, _can\_send\_documents_, _can\_send\_photos_, _can\_send\_videos_, _can\_send\_video\_notes_, and _can\_send\_voice\_notes_ permissions; the _can\_send\_polls_ permission will imply the _can\_send\_messages_ permission. |
| until\_date | Integer | Optional | Date when restrictions will be lifted for the user; Unix time. If user is restricted for more than 366 days or less than 30 seconds from the current time, they are considered to be restricted forever. |

#### promoteChatMember

Use this method to promote or demote a user in a supergroup or a channel. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Pass _False_ for all boolean parameters to demote a user. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |
| is\_anonymous | Boolean | Optional | Pass _True_ if the administrator's presence in the chat is hidden |
| can\_manage\_chat | Boolean | Optional | Pass _True_ if the administrator can access the chat event log, get boost list, see hidden supergroup and channel members, report spam messages, ignore slow mode, and send messages to the chat without paying Telegram Stars. Implied by any other administrator privilege. |
| can\_delete\_messages | Boolean | Optional | Pass _True_ if the administrator can delete messages of other users |
| can\_manage\_video\_chats | Boolean | Optional | Pass _True_ if the administrator can manage video chats |
| can\_restrict\_members | Boolean | Optional | Pass _True_ if the administrator can restrict, ban or unban chat members, or access supergroup statistics. For backward compatibility, defaults to _True_ for promotions of channel administrators. |
| can\_promote\_members | Boolean | Optional | Pass _True_ if the administrator can add new administrators with a subset of their own privileges or demote administrators that they have promoted, directly or indirectly (promoted by administrators that were appointed by him) |
| can\_change\_info | Boolean | Optional | Pass _True_ if the administrator can change chat title, photo and other settings |
| can\_invite\_users | Boolean | Optional | Pass _True_ if the administrator can invite new users to the chat |
| can\_post\_stories | Boolean | Optional | Pass _True_ if the administrator can post stories to the chat |
| can\_edit\_stories | Boolean | Optional | Pass _True_ if the administrator can edit stories posted by other users, post stories to the chat page, pin chat stories, and access the chat's story archive |
| can\_delete\_stories | Boolean | Optional | Pass _True_ if the administrator can delete stories posted by other users |
| can\_post\_messages | Boolean | Optional | Pass _True_ if the administrator can post messages in the channel, approve suggested posts, or access channel statistics; for channels only |
| can\_edit\_messages | Boolean | Optional | Pass _True_ if the administrator can edit messages of other users and can pin messages; for channels only |
| can\_pin\_messages | Boolean | Optional | Pass _True_ if the administrator can pin messages; for supergroups only |
| can\_manage\_topics | Boolean | Optional | Pass _True_ if the user is allowed to create, rename, close, and reopen forum topics; for supergroups only |
| can\_manage\_direct\_messages | Boolean | Optional | Pass _True_ if the administrator can manage direct messages within the channel and decline suggested posts; for channels only |
| can\_manage\_tags | Boolean | Optional | Pass _True_ if the administrator can edit the tags of regular members; for groups and supergroups only |

#### setChatAdministratorCustomTitle

Use this method to set a custom title for an administrator in a supergroup promoted by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |
| custom\_title | String | Yes | New custom title for the administrator; 0-16 characters, emoji are not allowed |

#### setChatMemberTag

Use this method to set a tag for a regular member in a group or a supergroup. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_tags_ administrator right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |
| tag | String | Optional | New tag for the member; 0-16 characters, emoji are not allowed |

#### banChatSenderChat

Use this method to ban a channel chat in a supergroup or a channel. Until the chat is [unbanned](#unbanchatsenderchat), the owner of the banned chat won't be able to send messages on behalf of **any of their channels**. The bot must be an administrator in the supergroup or channel for this to work and must have the appropriate administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| sender\_chat\_id | Integer | Yes | Unique identifier of the target sender chat |

#### unbanChatSenderChat

Use this method to unban a previously banned channel chat in a supergroup or channel. The bot must be an administrator for this to work and must have the appropriate administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| sender\_chat\_id | Integer | Yes | Unique identifier of the target sender chat |

#### setChatPermissions

Use this method to set default chat permissions for all members. The bot must be an administrator in the group or a supergroup for this to work and must have the _can\_restrict\_members_ administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| permissions | [ChatPermissions](#chatpermissions) | Yes | A JSON-serialized object for new default chat permissions |
| use\_independent\_chat\_permissions | Boolean | Optional | Pass _True_ if chat permissions are set independently. Otherwise, the _can\_send\_other\_messages_ and _can\_add\_web\_page\_previews_ permissions will imply the _can\_send\_messages_, _can\_send\_audios_, _can\_send\_documents_, _can\_send\_photos_, _can\_send\_videos_, _can\_send\_video\_notes_, and _can\_send\_voice\_notes_ permissions; the _can\_send\_polls_ permission will imply the _can\_send\_messages_ permission. |

#### exportChatInviteLink

Use this method to generate a new primary invite link for a chat; any previously generated primary link is revoked. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the new invite link as _String_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |

> Note: Each administrator in a chat generates their own invite links. Bots can't use invite links generated by other administrators. If you want your bot to work with invite links, it will need to generate its own link using [exportChatInviteLink](#exportchatinvitelink) or by calling the [getChat](#getchat) method. If your bot needs to generate a new primary invite link replacing its previous one, use [exportChatInviteLink](#exportchatinvitelink) again.

#### createChatInviteLink

Use this method to create an additional invite link for a chat. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. The link can be revoked using the method [revokeChatInviteLink](#revokechatinvitelink). Returns the new invite link as [ChatInviteLink](#chatinvitelink) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| name | String | Optional | Invite link name; 0-32 characters |
| expire\_date | Integer | Optional | Point in time (Unix timestamp) when the link will expire |
| member\_limit | Integer | Optional | The maximum number of users that can be members of the chat simultaneously after joining the chat via this invite link; 1-99999 |
| creates\_join\_request | Boolean | Optional | _True_, if users joining the chat via the link need to be approved by chat administrators. If _True_, _member\_limit_ can't be specified. |

#### editChatInviteLink

Use this method to edit a non-primary invite link created by the bot. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the edited invite link as a [ChatInviteLink](#chatinvitelink) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| invite\_link | String | Yes | The invite link to edit |
| name | String | Optional | Invite link name; 0-32 characters |
| expire\_date | Integer | Optional | Point in time (Unix timestamp) when the link will expire |
| member\_limit | Integer | Optional | The maximum number of users that can be members of the chat simultaneously after joining the chat via this invite link; 1-99999 |
| creates\_join\_request | Boolean | Optional | _True_, if users joining the chat via the link need to be approved by chat administrators. If _True_, _member\_limit_ can't be specified. |

#### createChatSubscriptionInviteLink

Use this method to create a [subscription invite link](https://telegram.org/blog/superchannels-star-reactions-subscriptions#star-subscriptions) for a channel chat. The bot must have the _can\_invite\_users_ administrator rights. The link can be edited using the method [editChatSubscriptionInviteLink](#editchatsubscriptioninvitelink) or revoked using the method [revokeChatInviteLink](#revokechatinvitelink). Returns the new invite link as a [ChatInviteLink](#chatinvitelink) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target channel chat or username of the target channel in the format `@username` |
| name | String | Optional | Invite link name; 0-32 characters |
| subscription\_period | Integer | Yes | The number of seconds the subscription will be active for before the next payment. Currently, it must always be 2592000 (30 days). |
| subscription\_price | Integer | Yes | The amount of Telegram Stars a user must pay initially and after each subsequent subscription period to be a member of the chat; 1-10000 |

#### editChatSubscriptionInviteLink

Use this method to edit a subscription invite link created by the bot. The bot must have the _can\_invite\_users_ administrator rights. Returns the edited invite link as a [ChatInviteLink](#chatinvitelink) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| invite\_link | String | Yes | The invite link to edit |
| name | String | Optional | Invite link name; 0-32 characters |

#### revokeChatInviteLink

Use this method to revoke an invite link created by the bot. If the primary link is revoked, a new link is automatically generated. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns the revoked invite link as [ChatInviteLink](#chatinvitelink) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier of the target chat or username of the target channel in the format `@username` |
| invite\_link | String | Yes | The invite link to revoke |

#### approveChatJoinRequest

Use this method to approve a chat join request. The bot must be an administrator in the chat for this to work and must have the _can\_invite\_users_ administrator right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |

#### declineChatJoinRequest

Use this method to decline a chat join request. The bot must be an administrator in the chat for this to work and must have the _can\_invite\_users_ administrator right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |

#### answerChatJoinRequestQuery

Use this method to process a received chat join request query. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_join\_request\_query\_id | String | Yes | Unique identifier of the join request query |
| result | String | Yes | Result of the query. Must be either “approve” to allow the user to join the chat, “decline” to disallow the user to join the chat, or “queue” to leave the decision to other administrators. |

#### sendChatJoinRequestWebApp

Use this method to process a received chat join request query by showing a Mini App to the user before deciding the outcome. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_join\_request\_query\_id | String | Yes | Unique identifier of the join request query |
| web\_app\_url | String | Yes | The URL of the Mini App to be opened |

#### setChatPhoto

Use this method to set a new profile photo for the chat. Photos can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| photo | [InputFile](#inputfile) | Yes | New chat photo, uploaded using multipart/form-data |

#### deleteChatPhoto

Use this method to delete a chat photo. Photos can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |

#### setChatTitle

Use this method to change the title of a chat. Titles can't be changed for private chats. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| title | String | Yes | New chat title, 1-128 characters |

#### setChatDescription

Use this method to change the description of a group, a supergroup or a channel. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| description | String | Optional | New chat description, 0-255 characters |

#### pinChatMessage

Use this method to add a message to the list of pinned messages in a chat. In private chats and channel direct messages chats, all non-service messages can be pinned. Conversely, the bot must be an administrator with the 'can\_pin\_messages' right or the 'can\_edit\_messages' right to pin messages in groups and channels respectively. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be pinned |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| message\_id | Integer | Yes | Identifier of a message to pin |
| disable\_notification | Boolean | Optional | Pass _True_ if it is not necessary to send a notification to all chat members about the new pinned message. Notifications are always disabled in channels and private chats. |

#### unpinChatMessage

Use this method to remove a message from the list of pinned messages in a chat. In private chats and channel direct messages chats, all messages can be unpinned. Conversely, the bot must be an administrator with the 'can\_pin\_messages' right or the 'can\_edit\_messages' right to unpin messages in groups and channels respectively. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be unpinned |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| message\_id | Integer | Optional | Identifier of the message to unpin. Required if _business\_connection\_id_ is specified. If not specified, the most recent pinned message (by sending date) will be unpinned. |

#### unpinAllChatMessages

Use this method to clear the list of pinned messages in a chat. In private chats and channel direct messages chats, no additional rights are required to unpin all pinned messages. Conversely, the bot must be an administrator with the 'can\_pin\_messages' right or the 'can\_edit\_messages' right to unpin all pinned messages in groups and channels respectively. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |

#### leaveChat

Use this method for your bot to leave a group, supergroup or channel. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup or channel in the format `@username`. Channel direct messages chats aren't supported; leave the corresponding channel instead. |

#### getChat

Use this method to get up-to-date information about the chat. Returns a [ChatFullInfo](#chatfullinfo) object on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup or channel in the format `@username` |

#### getChatAdministrators

Use this method to get a list of administrators in a chat. Returns an Array of [ChatMember](#chatmember) objects.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup or channel in the format `@username` |
| return\_bots | Boolean | Optional | Pass _True_ to additionally receive all bots that are administrators of the chat. By default, bots other than the current bot are omitted. |

#### getChatMemberCount

Use this method to get the number of members in a chat. Returns _Int_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup or channel in the format `@username` |

#### getChatMember

Use this method to get information about a member of a chat. The method is only guaranteed to work for other users if the bot is an administrator in the chat. Returns a [ChatMember](#chatmember) object on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup or channel in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |

#### getUserPersonalChatMessages

Use this method to get the last messages from the personal chat (i.e., the chat currently added to their profile) of a given user. On success, an array of [Message](#message) objects is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier for the target user |
| limit | Integer | Yes | The maximum number of messages to return; 1-20 |

#### setChatStickerSet

Use this method to set a new group sticker set for a supergroup. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Use the field _can\_set\_sticker\_set_ optionally returned in [getChat](#getchat) requests to check if the bot can use this method. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| sticker\_set\_name | String | Yes | Name of the sticker set to be set as the group sticker set |

#### deleteChatStickerSet

Use this method to delete a group sticker set from a supergroup. The bot must be an administrator in the chat for this to work and must have the appropriate administrator rights. Use the field _can\_set\_sticker\_set_ optionally returned in [getChat](#getchat) requests to check if the bot can use this method. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |

#### getForumTopicIconStickers

Use this method to get custom emoji stickers, which can be used as a forum topic icon by any user. Requires no parameters. Returns an Array of [Sticker](#sticker) objects.

#### createForumTopic

Use this method to create a topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator right. Returns information about the created topic as a [ForumTopic](#forumtopic) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| name | String | Yes | Topic name, 1-128 characters |
| icon\_color | Integer | Optional | Color of the topic icon in RGB format. Currently, must be one of 7322096 (0x6FB9F0), 16766590 (0xFFD67E), 13338331 (0xCB86DB), 9367192 (0x8EEE98), 16749490 (0xFF93B2), or 16478047 (0xFB6F5F). |
| icon\_custom\_emoji\_id | String | Optional | Unique identifier of the custom emoji shown as the topic icon. Use [getForumTopicIconStickers](#getforumtopiciconstickers) to get all allowed custom emoji identifiers. |

#### editForumTopic

Use this method to edit name and icon of a topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights, unless it is the creator of the topic. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| message\_thread\_id | Integer | Yes | Unique identifier for the target message thread of the forum topic |
| name | String | Optional | New topic name, 0-128 characters. If not specified or empty, the current name of the topic will be kept. |
| icon\_custom\_emoji\_id | String | Optional | New unique identifier of the custom emoji shown as the topic icon. Use [getForumTopicIconStickers](#getforumtopiciconstickers) to get all allowed custom emoji identifiers. Pass an empty string to remove the icon. If not specified, the current icon will be kept. |

#### closeForumTopic

Use this method to close an open topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights, unless it is the creator of the topic. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| message\_thread\_id | Integer | Yes | Unique identifier for the target message thread of the forum topic |

#### reopenForumTopic

Use this method to reopen a closed topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights, unless it is the creator of the topic. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| message\_thread\_id | Integer | Yes | Unique identifier for the target message thread of the forum topic |

#### deleteForumTopic

Use this method to delete a forum topic along with all its messages in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the _can\_delete\_messages_ administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| message\_thread\_id | Integer | Yes | Unique identifier for the target message thread of the forum topic |

#### unpinAllForumTopicMessages

Use this method to clear the list of pinned messages in a forum topic in a forum supergroup chat or a private chat with a user. In the case of a supergroup chat the bot must be an administrator in the chat for this to work and must have the _can\_pin\_messages_ administrator right in the supergroup. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| message\_thread\_id | Integer | Yes | Unique identifier for the target message thread of the forum topic |

#### editGeneralForumTopic

Use this method to edit the name of the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| name | String | Yes | New topic name, 1-128 characters |

#### closeGeneralForumTopic

Use this method to close an open 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |

#### reopenGeneralForumTopic

Use this method to reopen a closed 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights. The topic will be automatically unhidden if it was hidden. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |

#### hideGeneralForumTopic

Use this method to hide the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights. The topic will be automatically closed if it was open. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |

#### unhideGeneralForumTopic

Use this method to unhide the 'General' topic in a forum supergroup chat. The bot must be an administrator in the chat for this to work and must have the _can\_manage\_topics_ administrator rights. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |

#### unpinAllGeneralForumTopicMessages

Use this method to clear the list of pinned messages in a General forum topic. The bot must be an administrator in the chat for this to work and must have the _can\_pin\_messages_ administrator right in the supergroup. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |

#### answerCallbackQuery

Use this method to send answers to callback queries sent from inline keyboards. The answer will be displayed to the user as a notification at the top of the chat screen or as an alert. On success, _True_ is returned.

> Alternatively, the user can be redirected to the specified Game URL. For this option to work, you must first create a game for your bot via [@BotFather](https://t.me/botfather) and accept the terms. Otherwise, you may use links like `t.me/your_bot?start=XXXX` that open your bot with a parameter.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| callback\_query\_id | String | Yes | Unique identifier for the query to be answered |
| text | String | Optional | Text of the notification. If not specified, nothing will be shown to the user, 0-200 characters. |
| show\_alert | Boolean | Optional | If _True_, an alert will be shown by the client instead of a notification at the top of the chat screen. Defaults to _false_. |
| url | String | Optional | URL that will be opened by the user's client. If you have created a [Game](#game) and accepted the conditions via [@BotFather](https://t.me/botfather), specify the URL that opens your game - note that this will only work if the query comes from a [_callback\_game_](#inlinekeyboardbutton) button.  <br>  <br>Otherwise, you may use links like `t.me/your_bot?start=XXXX` that open your bot with a parameter. |
| cache\_time | Integer | Optional | The maximum amount of time in seconds that the result of the callback query may be cached client-side. Telegram apps will support caching starting in version 3.14. Defaults to 0. |

#### answerGuestQuery

Use this method to reply to a received guest message. On success, a [SentGuestMessage](#sentguestmessage) object is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| guest\_query\_id | String | Yes | Unique identifier for the query to be answered |
| result | [InlineQueryResult](#inlinequeryresult) | Yes | A JSON-serialized object describing the message to be sent |

#### getUserChatBoosts

Use this method to get the list of boosts added to a chat by a user. Requires administrator rights in the chat. Returns a [UserChatBoosts](#userchatboosts) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the chat or username of the channel in the format `@username` |
| user\_id | Integer | Yes | Unique identifier of the target user |

#### getBusinessConnection

Use this method to get information about the connection of the bot with a business account. Returns a [BusinessConnection](#businessconnection) object on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |

#### getManagedBotToken

Use this method to get the token of a managed bot. Returns the token as _String_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of the managed bot whose token will be returned |

#### replaceManagedBotToken

Use this method to revoke the current token of a managed bot and generate a new one. Returns the new token as _String_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of the managed bot whose token will be replaced |

#### getManagedBotAccessSettings

Use this method to get the access settings of a managed bot. Returns a [BotAccessSettings](#botaccesssettings) object on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of the managed bot whose access settings will be returned |

#### setManagedBotAccessSettings

Use this method to change the access settings of a managed bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of the managed bot whose access settings will be changed |
| is\_access\_restricted | Boolean | Yes | Pass _True_, if only selected users can access the bot. The bot's owner can always access it. |
| added\_user\_ids | Array of Integer | Optional | A JSON-serialized list of up to 10 identifiers of users who will have access to the bot in addition to its owner. Ignored if _is\_access\_restricted_ is false. |

#### setMyCommands

Use this method to change the list of the bot's commands. See this manual for more details about bot commands. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| commands | Array of [BotCommand](#botcommand) | Yes | A JSON-serialized list of bot commands to be set as the list of the bot's commands. At most 100 commands can be specified. |
| scope | [BotCommandScope](#botcommandscope) | Optional | A JSON-serialized object, describing scope of users for which the commands are relevant. Defaults to [BotCommandScopeDefault](#botcommandscopedefault). |
| language\_code | String | Optional | A two-letter ISO 639-1 language code. If empty, commands will be applied to all users from the given scope, for whose language there are no dedicated commands. |

#### deleteMyCommands

Use this method to delete the list of the bot's commands for the given scope and user language. After deletion, [higher level commands](#determining-list-of-commands) will be shown to affected users. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| scope | [BotCommandScope](#botcommandscope) | Optional | A JSON-serialized object, describing scope of users for which the commands are relevant. Defaults to [BotCommandScopeDefault](#botcommandscopedefault). |
| language\_code | String | Optional | A two-letter ISO 639-1 language code. If empty, commands will be applied to all users from the given scope, for whose language there are no dedicated commands. |

#### getMyCommands

Use this method to get the current list of the bot's commands for the given scope and user language. Returns an Array of [BotCommand](#botcommand) objects. If commands aren't set, an empty list is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| scope | [BotCommandScope](#botcommandscope) | Optional | A JSON-serialized object, describing scope of users. Defaults to [BotCommandScopeDefault](#botcommandscopedefault). |
| language\_code | String | Optional | A two-letter ISO 639-1 language code or an empty string |

#### setMyName

Use this method to change the bot's name. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| name | String | Optional | New bot name; 0-64 characters. Pass an empty string to remove the dedicated name for the given language. |
| language\_code | String | Optional | A two-letter ISO 639-1 language code. If empty, the name will be shown to all users for whose language there is no dedicated name. |

#### getMyName

Use this method to get the current bot name for the given user language. Returns [BotName](#botname) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| language\_code | String | Optional | A two-letter ISO 639-1 language code or an empty string |

#### setMyDescription

Use this method to change the bot's description, which is shown in the chat with the bot if the chat is empty. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| description | String | Optional | New bot description; 0-512 characters. Pass an empty string to remove the dedicated description for the given language. |
| language\_code | String | Optional | A two-letter ISO 639-1 language code. If empty, the description will be applied to all users for whose language there is no dedicated description. |

#### getMyDescription

Use this method to get the current bot description for the given user language. Returns [BotDescription](#botdescription) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| language\_code | String | Optional | A two-letter ISO 639-1 language code or an empty string |

#### setMyShortDescription

Use this method to change the bot's short description, which is shown on the bot's profile page and is sent together with the link when users share the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| short\_description | String | Optional | New short description for the bot; 0-120 characters. Pass an empty string to remove the dedicated short description for the given language. |
| language\_code | String | Optional | A two-letter ISO 639-1 language code. If empty, the short description will be applied to all users for whose language there is no dedicated short description. |

#### getMyShortDescription

Use this method to get the current bot short description for the given user language. Returns [BotShortDescription](#botshortdescription) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| language\_code | String | Optional | A two-letter ISO 639-1 language code or an empty string |

#### setMyProfilePhoto

Changes the profile photo of the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| photo | [InputProfilePhoto](#inputprofilephoto) | Yes | The new profile photo to set |

#### removeMyProfilePhoto

Removes the profile photo of the bot. Requires no parameters. Returns _True_ on success.

#### setChatMenuButton

Use this method to change the bot's menu button in a private chat, or the default menu button. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer | Optional | Unique identifier for the target private chat. If not specified, the bot's default menu button will be changed. |
| menu\_button | [MenuButton](#menubutton) | Optional | A JSON-serialized object for the bot's new menu button. Defaults to [MenuButtonDefault](#menubuttondefault). |

#### getChatMenuButton

Use this method to get the current value of the bot's menu button in a private chat, or the default menu button. Returns [MenuButton](#menubutton) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer | Optional | Unique identifier for the target private chat. If not specified, the bot's default menu button will be returned. |

#### setMyDefaultAdministratorRights

Use this method to change the default administrator rights requested by the bot when it's added as an administrator to groups or channels. These rights will be suggested to users, but they are free to modify the list before adding the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| rights | [ChatAdministratorRights](#chatadministratorrights) | Optional | A JSON-serialized object describing new default administrator rights. If not specified, the default administrator rights will be cleared. |
| for\_channels | Boolean | Optional | Pass _True_ to change the default administrator rights of the bot in channels. Otherwise, the default administrator rights of the bot for groups and supergroups will be changed. |

#### getMyDefaultAdministratorRights

Use this method to get the current default administrator rights of the bot. Returns [ChatAdministratorRights](#chatadministratorrights) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| for\_channels | Boolean | Optional | Pass _True_ to get default administrator rights of the bot in channels. Otherwise, default administrator rights of the bot for groups and supergroups will be returned. |

#### getAvailableGifts

Returns the list of gifts that can be sent by the bot to users and channel chats. Requires no parameters. Returns a [Gifts](#gifts) object.

#### sendGift

Sends a gift to the given user or channel chat. The gift can't be converted to Telegram Stars by the receiver. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Optional | Required if _chat\_id_ is not specified. Unique identifier of the target user who will receive the gift. |
| chat\_id | Integer or String | Optional | Required if _user\_id_ is not specified. Unique identifier for the chat or username of the channel (in the format `@username`) that will receive the gift. |
| gift\_id | String | Yes | Identifier of the gift; limited gifts can't be sent to channel chats |
| pay\_for\_upgrade | Boolean | Optional | Pass _True_ to pay for the gift upgrade from the bot's balance, thereby making the upgrade free for the receiver |
| text | String | Optional | Text that will be shown along with the gift; 0-128 characters |
| text\_parse\_mode | String | Optional | Mode for parsing entities in the text. See [formatting options](#formatting-options) for more details. Entities other than “bold”, “italic”, “underline”, “strikethrough”, “spoiler”, “custom\_emoji”, and “date\_time” are ignored. |
| text\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the gift text. It can be specified instead of _text\_parse\_mode_. Entities other than “bold”, “italic”, “underline”, “strikethrough”, “spoiler”, “custom\_emoji”, and “date\_time” are ignored. |

#### giftPremiumSubscription

Gifts a Telegram Premium subscription to the given user. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user who will receive a Telegram Premium subscription |
| month\_count | Integer | Yes | Number of months the Telegram Premium subscription will be active for the user; must be one of 3, 6, or 12 |
| star\_count | Integer | Yes | Number of Telegram Stars to pay for the Telegram Premium subscription; must be 1000 for 3 months, 1500 for 6 months, and 2500 for 12 months |
| text | String | Optional | Text that will be shown along with the service message about the subscription; 0-128 characters |
| text\_parse\_mode | String | Optional | Mode for parsing entities in the text. See [formatting options](#formatting-options) for more details. Entities other than “bold”, “italic”, “underline”, “strikethrough”, “spoiler”, “custom\_emoji”, and “date\_time” are ignored. |
| text\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the gift text. It can be specified instead of _text\_parse\_mode_. Entities other than “bold”, “italic”, “underline”, “strikethrough”, “spoiler”, “custom\_emoji”, and “date\_time” are ignored. |

#### verifyUser

Verifies a user [on behalf of the organization](https://telegram.org/verify#third-party-verification) which is represented by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user |
| custom\_description | String | Optional | Custom description for the verification; 0-70 characters. Must be empty if the organization isn't allowed to provide a custom verification description. |

#### verifyChat

Verifies a chat [on behalf of the organization](https://telegram.org/verify#third-party-verification) which is represented by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. Channel direct messages chats can't be verified. |
| custom\_description | String | Optional | Custom description for the verification; 0-70 characters. Must be empty if the organization isn't allowed to provide a custom verification description. |

#### removeUserVerification

Removes verification from a user who is currently verified [on behalf of the organization](https://telegram.org/verify#third-party-verification) represented by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user |

#### removeChatVerification

Removes verification from a chat that is currently verified [on behalf of the organization](https://telegram.org/verify#third-party-verification) represented by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot or channel in the format `@username` |

#### readBusinessMessage

Marks incoming message as read on behalf of a business account. Requires the _can\_read\_messages_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection on behalf of which to read the message |
| chat\_id | Integer | Yes | Unique identifier of the chat in which the message was received. The chat must have been active in the last 24 hours. |
| message\_id | Integer | Yes | Unique identifier of the message to mark as read |

#### deleteBusinessMessages

Delete messages on behalf of a business account. Requires the _can\_delete\_sent\_messages_ business bot right to delete messages sent by the bot itself, or the _can\_delete\_all\_messages_ business bot right to delete any message. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection on behalf of which to delete the messages |
| message\_ids | Array of Integer | Yes | A JSON-serialized list of 1-100 identifiers of messages to delete. All messages must be from the same chat. See [deleteMessage](#deletemessage) for limitations on which messages can be deleted. |

#### setBusinessAccountName

Changes the first and last name of a managed business account. Requires the _can\_change\_name_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| first\_name | String | Yes | The new value of the first name for the business account; 1-64 characters |
| last\_name | String | Optional | The new value of the last name for the business account; 0-64 characters |

#### setBusinessAccountUsername

Changes the username of a managed business account. Requires the _can\_change\_username_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| username | String | Optional | The new value of the username for the business account; 0-32 characters |

#### setBusinessAccountBio

Changes the bio of a managed business account. Requires the _can\_change\_bio_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| bio | String | Optional | The new value of the bio for the business account; 0-140 characters |

#### setBusinessAccountProfilePhoto

Changes the profile photo of a managed business account. Requires the _can\_edit\_profile\_photo_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| photo | [InputProfilePhoto](#inputprofilephoto) | Yes | The new profile photo to set |
| is\_public | Boolean | Optional | Pass _True_ to set the public photo, which will be visible even if the main photo is hidden by the business account's privacy settings. An account can have only one public photo. |

#### removeBusinessAccountProfilePhoto

Removes the current profile photo of a managed business account. Requires the _can\_edit\_profile\_photo_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| is\_public | Boolean | Optional | Pass _True_ to remove the public photo, which is visible even if the main photo is hidden by the business account's privacy settings. After the main photo is removed, the previous profile photo (if present) becomes the main photo. |

#### setBusinessAccountGiftSettings

Changes the privacy settings pertaining to incoming gifts in a managed business account. Requires the _can\_change\_gift\_settings_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| show\_gift\_button | Boolean | Yes | Pass _True_, if a button for sending a gift to the user or by the business account must always be shown in the input field |
| accepted\_gift\_types | [AcceptedGiftTypes](#acceptedgifttypes) | Yes | Types of gifts accepted by the business account |

#### getBusinessAccountStarBalance

Returns the amount of Telegram Stars owned by a managed business account. Requires the _can\_view\_gifts\_and\_stars_ business bot right. Returns [StarAmount](#staramount) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |

#### transferBusinessAccountStars

Transfers Telegram Stars from the business account balance to the bot's balance. Requires the _can\_transfer\_stars_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| star\_count | Integer | Yes | Number of Telegram Stars to transfer; 1-10000 |

#### getBusinessAccountGifts

Returns the gifts received and owned by a managed business account. Requires the _can\_view\_gifts\_and\_stars_ business bot right. Returns [OwnedGifts](#ownedgifts) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| exclude\_unsaved | Boolean | Optional | Pass _True_ to exclude gifts that aren't saved to the account's profile page |
| exclude\_saved | Boolean | Optional | Pass _True_ to exclude gifts that are saved to the account's profile page |
| exclude\_unlimited | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased an unlimited number of times |
| exclude\_limited\_upgradable | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased a limited number of times and can be upgraded to unique |
| exclude\_limited\_non\_upgradable | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased a limited number of times and can't be upgraded to unique |
| exclude\_unique | Boolean | Optional | Pass _True_ to exclude unique gifts |
| exclude\_from\_blockchain | Boolean | Optional | Pass _True_ to exclude gifts that were assigned from the TON blockchain and can't be resold or transferred in Telegram |
| sort\_by\_price | Boolean | Optional | Pass _True_ to sort results by gift price instead of send date. Sorting is applied before pagination. |
| offset | String | Optional | Offset of the first entry to return as received from the previous request; use empty string to get the first chunk of results |
| limit | Integer | Optional | The maximum number of gifts to be returned; 1-100. Defaults to 100. |

#### getUserGifts

Returns the gifts owned and hosted by a user. Returns [OwnedGifts](#ownedgifts) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the user |
| exclude\_unlimited | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased an unlimited number of times |
| exclude\_limited\_upgradable | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased a limited number of times and can be upgraded to unique |
| exclude\_limited\_non\_upgradable | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased a limited number of times and can't be upgraded to unique |
| exclude\_from\_blockchain | Boolean | Optional | Pass _True_ to exclude gifts that were assigned from the TON blockchain and can't be resold or transferred in Telegram |
| exclude\_unique | Boolean | Optional | Pass _True_ to exclude unique gifts |
| sort\_by\_price | Boolean | Optional | Pass _True_ to sort results by gift price instead of send date. Sorting is applied before pagination. |
| offset | String | Optional | Offset of the first entry to return as received from the previous request; use an empty string to get the first chunk of results |
| limit | Integer | Optional | The maximum number of gifts to be returned; 1-100. Defaults to 100. |

#### getChatGifts

Returns the gifts owned by a chat. Returns [OwnedGifts](#ownedgifts) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target channel in the format `@username` |
| exclude\_unsaved | Boolean | Optional | Pass _True_ to exclude gifts that aren't saved to the chat's profile page. Always _True_, unless the bot has the _can\_post\_messages_ administrator right in the channel. |
| exclude\_saved | Boolean | Optional | Pass _True_ to exclude gifts that are saved to the chat's profile page. Always _False_, unless the bot has the _can\_post\_messages_ administrator right in the channel. |
| exclude\_unlimited | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased an unlimited number of times |
| exclude\_limited\_upgradable | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased a limited number of times and can be upgraded to unique |
| exclude\_limited\_non\_upgradable | Boolean | Optional | Pass _True_ to exclude gifts that can be purchased a limited number of times and can't be upgraded to unique |
| exclude\_from\_blockchain | Boolean | Optional | Pass _True_ to exclude gifts that were assigned from the TON blockchain and can't be resold or transferred in Telegram |
| exclude\_unique | Boolean | Optional | Pass _True_ to exclude unique gifts |
| sort\_by\_price | Boolean | Optional | Pass _True_ to sort results by gift price instead of send date. Sorting is applied before pagination. |
| offset | String | Optional | Offset of the first entry to return as received from the previous request; use an empty string to get the first chunk of results |
| limit | Integer | Optional | The maximum number of gifts to be returned; 1-100. Defaults to 100. |

#### convertGiftToStars

Converts a given regular gift to Telegram Stars. Requires the _can\_convert\_gifts\_to\_stars_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| owned\_gift\_id | String | Yes | Unique identifier of the regular gift that should be converted to Telegram Stars |

#### upgradeGift

Upgrades a given regular gift to a unique gift. Requires the _can\_transfer\_and\_upgrade\_gifts_ business bot right. Additionally requires the _can\_transfer\_stars_ business bot right if the upgrade is paid. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| owned\_gift\_id | String | Yes | Unique identifier of the regular gift that should be upgraded to a unique one |
| keep\_original\_details | Boolean | Optional | Pass _True_ to keep the original gift text, sender and receiver in the upgraded gift |
| star\_count | Integer | Optional | The amount of Telegram Stars that will be paid for the upgrade from the business account balance. If `gift.prepaid_upgrade_star_count > 0`, then pass 0, otherwise, the _can\_transfer\_stars_ business bot right is required and `gift.upgrade_star_count` must be passed. |

#### transferGift

Transfers an owned unique gift to another user. Requires the _can\_transfer\_and\_upgrade\_gifts_ business bot right. Requires _can\_transfer\_stars_ business bot right if the transfer is paid. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| owned\_gift\_id | String | Yes | Unique identifier of the regular gift that should be transferred |
| new\_owner\_chat\_id | Integer | Yes | Unique identifier of the chat which will own the gift. The chat must be active in the last 24 hours. |
| star\_count | Integer | Optional | The amount of Telegram Stars that will be paid for the transfer from the business account balance. If positive, then the _can\_transfer\_stars_ business bot right is required. |

#### postStory

Posts a story on behalf of a managed business account. Requires the _can\_manage\_stories_ business bot right. Returns [Story](#story) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| content | [InputStoryContent](#inputstorycontent) | Yes | Content of the story |
| active\_period | Integer | Yes | Period after which the story is moved to the archive, in seconds; must be one of `6 * 3600`, `12 * 3600`, `86400`, or `2 * 86400` |
| caption | String | Optional | Caption of the story, 0-2048 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the story caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| areas | Array of [StoryArea](#storyarea) | Optional | A JSON-serialized list of clickable areas to be shown on the story |
| post\_to\_chat\_page | Boolean | Optional | Pass _True_ to keep the story accessible after it expires |
| protect\_content | Boolean | Optional | Pass _True_ if the content of the story must be protected from forwarding and screenshotting |

#### repostStory

Reposts a story on behalf of a business account from another business account. Both business accounts must be managed by the same bot, and the story on the source account must have been posted (or reposted) by the bot. Requires the _can\_manage\_stories_ business bot right for both business accounts. Returns [Story](#story) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| from\_chat\_id | Integer | Yes | Unique identifier of the chat which posted the story that should be reposted |
| from\_story\_id | Integer | Yes | Unique identifier of the story that should be reposted |
| active\_period | Integer | Yes | Period after which the story is moved to the archive, in seconds; must be one of `6 * 3600`, `12 * 3600`, `86400`, or `2 * 86400` |
| post\_to\_chat\_page | Boolean | Optional | Pass _True_ to keep the story accessible after it expires |
| protect\_content | Boolean | Optional | Pass _True_ if the content of the story must be protected from forwarding and screenshotting |

#### editStory

Edits a story previously posted by the bot on behalf of a managed business account. Requires the _can\_manage\_stories_ business bot right. Returns [Story](#story) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| story\_id | Integer | Yes | Unique identifier of the story to edit |
| content | [InputStoryContent](#inputstorycontent) | Yes | Content of the story |
| caption | String | Optional | Caption of the story, 0-2048 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the story caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| areas | Array of [StoryArea](#storyarea) | Optional | A JSON-serialized list of clickable areas to be shown on the story |

#### deleteStory

Deletes a story previously posted by the bot on behalf of a managed business account. Requires the _can\_manage\_stories_ business bot right. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection |
| story\_id | Integer | Yes | Unique identifier of the story to delete |

#### answerWebAppQuery

Use this method to set the result of an interaction with a [Web App](https://core.telegram.org/bots/webapps) and send a corresponding message on behalf of the user to the chat from which the query originated. On success, a [SentWebAppMessage](#sentwebappmessage) object is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| web\_app\_query\_id | String | Yes | Unique identifier for the query to be answered |
| result | [InlineQueryResult](#inlinequeryresult) | Yes | A JSON-serialized object describing the message to be sent |

#### savePreparedInlineMessage

Stores a message that can be sent by a user of a Mini App. Returns a [PreparedInlineMessage](#preparedinlinemessage) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user that can use the prepared message |
| result | [InlineQueryResult](#inlinequeryresult) | Yes | A JSON-serialized object describing the message to be sent |
| allow\_user\_chats | Boolean | Optional | Pass _True_ if the message can be sent to private chats with users |
| allow\_bot\_chats | Boolean | Optional | Pass _True_ if the message can be sent to private chats with bots |
| allow\_group\_chats | Boolean | Optional | Pass _True_ if the message can be sent to group and supergroup chats |
| allow\_channel\_chats | Boolean | Optional | Pass _True_ if the message can be sent to channel chats |

#### savePreparedKeyboardButton

Stores a keyboard button that can be used by a user within a Mini App. Returns a [PreparedKeyboardButton](#preparedkeyboardbutton) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Unique identifier of the target user that can use the button |
| button | [KeyboardButton](#keyboardbutton) | Yes | A JSON-serialized object describing the button to be saved. The button must be of the type _request\_users_, _request\_chat_, or _request\_managed\_bot_. |

#### Inline mode methods

Methods and objects used in the inline mode are described in the [Inline mode section](#inline-mode).

### Updating messages

The following methods allow you to change an existing message in the message history instead of sending a new one with a result of an action. This is most useful for messages with inline keyboards using callback queries, but can also help reduce clutter in conversations with regular chat bots.

Please note, that it is currently only possible to edit messages without _reply\_markup_ or with inline keyboards.

#### editMessageText

Use this method to edit text, rich and [game](#games) messages. On success, if the edited message is not an inline message, the edited [Message](#message) is returned, otherwise _True_ is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within **48 hours** from the time they were sent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message to be edited was sent |
| chat\_id | Integer or String | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the message to edit. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |
| text | String | Optional | New text of the message, 1-4096 characters after entity parsing; required if _rich\_message_ isn't specified |
| parse\_mode | String | Optional | Mode for parsing entities in the message text. See [formatting options](#formatting-options) for more details. |
| entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in message text, which can be specified instead of _parse\_mode_ |
| link\_preview\_options | [LinkPreviewOptions](#linkpreviewoptions) | Optional | Link preview generation options for the message |
| rich\_message | [InputRichMessage](#inputrichmessage) | Optional | New rich content of the message; required if _text_ isn't specified |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for an inline keyboard |

#### editMessageCaption

Use this method to edit captions of messages. On success, if the edited message is not an inline message, the edited [Message](#message) is returned, otherwise _True_ is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within **48 hours** from the time they were sent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message to be edited was sent |
| chat\_id | Integer or String | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the message to edit. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |
| caption | String | Optional | New caption of the message, 0-1024 characters after entities parsing |
| parse\_mode | String | Optional | Mode for parsing entities in the message caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | Optional | A JSON-serialized list of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | Optional | Pass _True_, if the caption must be shown above the message media. Supported only for animation, photo and video messages. |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for an inline keyboard |

#### editMessageMedia

Use this method to edit animation, audio, document, live photo, photo, or video messages, or to replace a text or a rich message with a media. If a message is part of a message album, then it can be edited only to an audio for audio albums, only to a document for document albums and to a photo, a live photo, or a video otherwise. When an inline message is edited, a new file can't be uploaded; use a previously uploaded file via its file\_id or specify a URL. On success, if the edited message is not an inline message, the edited [Message](#message) is returned, otherwise _True_ is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within **48 hours** from the time they were sent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message to be edited was sent |
| chat\_id | Integer or String | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the message to edit. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |
| media | [InputMedia](#inputmedia) | Yes | A JSON-serialized object for a new media content of the message |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for a new inline keyboard |

#### editMessageLiveLocation

Use this method to edit live location messages. A location can be edited until its _live\_period_ expires or editing is explicitly disabled by a call to [stopMessageLiveLocation](#stopmessagelivelocation). On success, if the edited message is not an inline message, the edited [Message](#message) is returned, otherwise _True_ is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message to be edited was sent |
| chat\_id | Integer or String | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the message to edit. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |
| latitude | Float | Yes | Latitude of new location |
| longitude | Float | Yes | Longitude of new location |
| live\_period | Integer | Optional | New period in seconds during which the location can be updated, starting from the message send date. If 0x7FFFFFFF is specified, then the location can be updated forever. Otherwise, the new value must not exceed the current _live\_period_ by more than a day, and the live location expiration date must remain within the next 90 days. If not specified, then _live\_period_ remains unchanged. |
| horizontal\_accuracy | Float | Optional | The radius of uncertainty for the location, measured in meters; 0-1500 |
| heading | Integer | Optional | Direction in which the user is moving, in degrees. Must be between 1 and 360 if specified. |
| proximity\_alert\_radius | Integer | Optional | The maximum distance for proximity alerts about approaching another chat member, in meters. Must be between 1 and 100000 if specified. |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for a new inline keyboard |

#### stopMessageLiveLocation

Use this method to stop updating a live location message before _live\_period_ expires. On success, if the message is not an inline message, the edited [Message](#message) is returned, otherwise _True_ is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message to be edited was sent |
| chat\_id | Integer or String | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the message with live location to stop. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for a new inline keyboard |

#### editMessageChecklist

Use this method to edit a checklist on behalf of a connected business account. On success, the edited [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Yes | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot in the format `@username` |
| message\_id | Integer | Yes | Unique identifier for the target message |
| checklist | [InputChecklist](#inputchecklist) | Yes | A JSON-serialized object for the new checklist |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for the new inline keyboard for the message |

#### editMessageReplyMarkup

Use this method to edit only the reply markup of messages. On success, if the edited message is not an inline message, the edited [Message](#message) is returned, otherwise _True_ is returned. Note that business messages that were not sent by the bot and do not contain an inline keyboard can only be edited within **48 hours** from the time they were sent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message to be edited was sent |
| chat\_id | Integer or String | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username`. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the message to edit. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for an inline keyboard |

#### stopPoll

Use this method to stop a poll which was sent by the bot. On success, the stopped [Poll](#poll) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message to be edited was sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_id | Integer | Yes | Identifier of the original message with the poll |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for a new message inline keyboard |

#### approveSuggestedPost

Use this method to approve a suggested post in a direct messages chat. The bot must have the 'can\_post\_messages' administrator right in the corresponding channel chat. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer | Yes | Unique identifier for the target direct messages chat |
| message\_id | Integer | Yes | Identifier of a suggested post message to approve |
| send\_date | Integer | Optional | Point in time (Unix timestamp) when the post is expected to be published; omit if the date has already been specified when the suggested post was created. If specified, then the date must be not more than 2678400 seconds (30 days) in the future. |

#### declineSuggestedPost

Use this method to decline a suggested post in a direct messages chat. The bot must have the 'can\_manage\_direct\_messages' administrator right in the corresponding channel chat. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer | Yes | Unique identifier for the target direct messages chat |
| message\_id | Integer | Yes | Identifier of a suggested post message to decline |
| comment | String | Optional | Comment for the creator of the suggested post; 0-128 characters |

#### deleteMessage

Use this method to delete a message, including service messages, with the following limitations:  
\- A message can only be deleted if it was sent less than 48 hours ago.  
\- Service messages about a supergroup, channel, or forum topic creation can't be deleted.  
\- A dice message in a private chat can only be deleted if it was sent more than 24 hours ago.  
\- Bots can delete outgoing messages in private chats, groups, and supergroups.  
\- Bots can delete incoming messages in private chats.  
\- Bots granted _can\_post\_messages_ permissions can delete outgoing messages in channels.  
\- If the bot is an administrator of a group, it can delete any message there.  
\- If the bot has _can\_delete\_messages_ administrator right in a supergroup or a channel, it can delete any message there.  
\- If the bot has _can\_manage\_direct\_messages_ administrator right in a channel, it can delete any message in the corresponding direct messages chat.  
Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_id | Integer | Yes | Identifier of the message to delete |

#### deleteMessages

Use this method to delete multiple messages simultaneously. If some of the specified messages can't be found, they are skipped. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_ids | Array of Integer | Yes | A JSON-serialized list of 1-100 identifiers of messages to delete. See [deleteMessage](#deletemessage) for limitations on which messages can be deleted. |

#### deleteMessageReaction

Use this method to remove a reaction from a message in a group or a supergroup chat. The bot must have the 'can\_delete\_messages' administrator right in the chat. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| message\_id | Integer | Yes | Identifier of the target message |
| user\_id | Integer | Optional | Identifier of the user whose reaction will be removed, if the reaction was added by a user |
| actor\_chat\_id | Integer | Optional | Identifier of the chat whose reaction will be removed, if the reaction was added by a chat |

#### deleteAllMessageReactions

Use this method to remove up to 10000 recent reactions in a group or a supergroup chat added by a given user or chat. The bot must have the 'can\_delete\_messages' administrator right in the chat. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target supergroup in the format `@username` |
| user\_id | Integer | Optional | Identifier of the user whose reactions will be removed, if the reactions were added by a user |
| actor\_chat\_id | Integer | Optional | Identifier of the chat whose reactions will be removed, if the reactions were added by a chat |

### Stickers

The following methods and objects allow your bot to handle stickers and sticker sets.

#### Sticker

This object represents a sticker.

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| type | String | Type of the sticker, currently one of “regular”, “mask”, “custom\_emoji”. The type of the sticker is independent from its format, which is determined by the fields _is\_animated_ and _is\_video_. |
| width | Integer | Sticker width |
| height | Integer | Sticker height |
| is\_animated | Boolean | _True_, if the sticker is [animated](https://telegram.org/blog/animated-stickers) |
| is\_video | Boolean | _True_, if the sticker is a [video sticker](https://telegram.org/blog/video-stickers-better-reactions) |
| thumbnail | [PhotoSize](#photosize) | _Optional_. Sticker thumbnail in the .WEBP or .JPG format |
| emoji | String | _Optional_. Emoji associated with the sticker |
| set\_name | String | _Optional_. Name of the sticker set to which the sticker belongs |
| premium\_animation | [File](#file) | _Optional_. For premium regular stickers, premium animation for the sticker |
| mask\_position | [MaskPosition](#maskposition) | _Optional_. For mask stickers, the position where the mask should be placed |
| custom\_emoji\_id | String | _Optional_. For custom emoji stickers, unique identifier of the custom emoji |
| needs\_repainting | True | _Optional_. _True_, if the sticker must be repainted to a text color in messages, the color of the Telegram Premium badge in emoji status, white color on chat photos, or another appropriate color in other places |
| file\_size | Integer | _Optional_. File size in bytes |

#### StickerSet

This object represents a sticker set.

| Field | Type | Description |
| --- | --- | --- |
| name | String | Sticker set name |
| title | String | Sticker set title |
| sticker\_type | String | Type of stickers in the set, currently one of “regular”, “mask”, “custom\_emoji” |
| stickers | Array of [Sticker](#sticker) | List of all set stickers |
| thumbnail | [PhotoSize](#photosize) | _Optional_. Sticker set thumbnail in the .WEBP, .TGS, or .WEBM format |

#### MaskPosition

This object describes the position on faces where a mask should be placed by default.

| Field | Type | Description |
| --- | --- | --- |
| point | String | The part of the face relative to which the mask should be placed. One of “forehead”, “eyes”, “mouth”, or “chin”. |
| x\_shift | Float | Shift by X-axis measured in widths of the mask scaled to the face size, from left to right. For example, choosing -1.0 will place mask just to the left of the default mask position. |
| y\_shift | Float | Shift by Y-axis measured in heights of the mask scaled to the face size, from top to bottom. For example, 1.0 will place the mask just below the default mask position. |
| scale | Float | Mask scaling coefficient. For example, 2.0 means double size. |

#### InputSticker

This object describes a sticker to be added to a sticker set.

| Field | Type | Description |
| --- | --- | --- |
| sticker | String | The added sticker. Pass a _file\_id_ as a String to send a file that already exists on the Telegram servers, pass an HTTP URL as a String for Telegram to get a file from the Internet, or pass “attach://<file\_attach\_name>” to upload a new file using multipart/form-data under <file\_attach\_name> name. Animated and video stickers can't be uploaded via HTTP URL. [More information on Sending Files »](#sending-files) |
| format | String | Format of the added sticker, must be one of “static” for a **.WEBP** or **.PNG** image, “animated” for a **.TGS** animation, “video” for a **.WEBM** video |
| emoji\_list | Array of String | List of 1-20 emoji associated with the sticker |
| mask\_position | [MaskPosition](#maskposition) | _Optional_. Position where the mask should be placed on faces. For “mask” stickers only. |
| keywords | Array of String | _Optional_. List of 0-20 search keywords for the sticker with total length of up to 64 characters. For “regular” and “custom\_emoji” stickers only. |

#### sendSticker

Use this method to send static .WEBP, [animated](https://telegram.org/blog/animated-stickers) .TGS, or [video](https://telegram.org/blog/video-stickers-better-reactions) .WEBM stickers. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| sticker | [InputFile](#inputfile) or String | Yes | Sticker to send. Pass a file\_id as String to send a file that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a .WEBP sticker from the Internet, or upload a new .WEBP, .TGS, or .WEBM sticker using multipart/form-data. [More information on Sending Files »](#sending-files). Video and animated stickers can't be sent via an HTTP URL. |
| emoji | String | Optional | Emoji associated with the sticker; only for just uploaded stickers |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### getStickerSet

Use this method to get a sticker set. On success, a [StickerSet](#stickerset) object is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| name | String | Yes | Name of the sticker set |

#### getCustomEmojiStickers

Use this method to get information about custom emoji stickers by their identifiers. Returns an Array of [Sticker](#sticker) objects.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| custom\_emoji\_ids | Array of String | Yes | A JSON-serialized list of custom emoji identifiers. At most 200 custom emoji identifiers can be specified. |

#### uploadStickerFile

Use this method to upload a file with a sticker for later use in the [createNewStickerSet](#createnewstickerset), [addStickerToSet](#addstickertoset), or [replaceStickerInSet](#replacestickerinset) methods (the file can be used multiple times). Returns the uploaded [File](#file) on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of sticker file owner |
| sticker | [InputFile](#inputfile) | Yes | A file with the sticker in .WEBP, .PNG, .TGS, or .WEBM format. See [](https://core.telegram.org/stickers)[https://core.telegram.org/stickers](https://core.telegram.org/stickers) for technical requirements. [More information on Sending Files »](#sending-files) |
| sticker\_format | String | Yes | Format of the sticker, must be one of “static”, “animated”, “video” |

#### createNewStickerSet

Use this method to create a new sticker set owned by a user. The bot will be able to edit the sticker set thus created. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of created sticker set owner |
| name | String | Yes | Short name of sticker set, to be used in `t.me/addstickers/` URLs (e.g., _animals_). Can contain only English letters, digits and underscores. Must begin with a letter, can't contain consecutive underscores and must end in `"_by_<bot_username>"`. `<bot_username>` is case insensitive. 1-64 characters. |
| title | String | Yes | Sticker set title, 1-64 characters |
| stickers | Array of [InputSticker](#inputsticker) | Yes | A JSON-serialized list of 1-50 initial stickers to be added to the sticker set |
| sticker\_type | String | Optional | Type of stickers in the set, pass “regular”, “mask”, or “custom\_emoji”. By default, a regular sticker set is created. |
| needs\_repainting | Boolean | Optional | Pass _True_ if stickers in the sticker set must be repainted to the color of text when used in messages, the accent color if used as emoji status, white on chat photos, or another appropriate color based on context; for custom emoji sticker sets only |

#### addStickerToSet

Use this method to add a new sticker to a set created by the bot. Emoji sticker sets can have up to 200 stickers. Other sticker sets can have up to 120 stickers. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of sticker set owner |
| name | String | Yes | Sticker set name |
| sticker | [InputSticker](#inputsticker) | Yes | A JSON-serialized object with information about the added sticker. If exactly the same sticker had already been added to the set, then the set isn't changed. |

#### setStickerPositionInSet

Use this method to move a sticker in a set created by the bot to a specific position. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| sticker | String | Yes | File identifier of the sticker |
| position | Integer | Yes | New sticker position in the set, zero-based |

#### deleteStickerFromSet

Use this method to delete a sticker from a set created by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| sticker | String | Yes | File identifier of the sticker |

#### replaceStickerInSet

Use this method to replace an existing sticker in a sticker set with a new one. The method is equivalent to calling [deleteStickerFromSet](#deletestickerfromset), then [addStickerToSet](#addstickertoset), then [setStickerPositionInSet](#setstickerpositioninset). Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier of the sticker set owner |
| name | String | Yes | Sticker set name |
| old\_sticker | String | Yes | File identifier of the replaced sticker |
| sticker | [InputSticker](#inputsticker) | Yes | A JSON-serialized object with information about the added sticker. If exactly the same sticker had already been added to the set, then the set remains unchanged. |

#### setStickerEmojiList

Use this method to change the list of emoji assigned to a regular or custom emoji sticker. The sticker must belong to a sticker set created by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| sticker | String | Yes | File identifier of the sticker |
| emoji\_list | Array of String | Yes | A JSON-serialized list of 1-20 emoji associated with the sticker |

#### setStickerKeywords

Use this method to change search keywords assigned to a regular or custom emoji sticker. The sticker must belong to a sticker set created by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| sticker | String | Yes | File identifier of the sticker |
| keywords | Array of String | Optional | A JSON-serialized list of 0-20 search keywords for the sticker with total length of up to 64 characters |

#### setStickerMaskPosition

Use this method to change the [mask position](#maskposition) of a mask sticker. The sticker must belong to a sticker set that was created by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| sticker | String | Yes | File identifier of the sticker |
| mask\_position | [MaskPosition](#maskposition) | Optional | A JSON-serialized object with the position where the mask should be placed on faces. Omit the parameter to remove the mask position. |

#### setStickerSetTitle

Use this method to set the title of a created sticker set. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| name | String | Yes | Sticker set name |
| title | String | Yes | Sticker set title, 1-64 characters |

#### setStickerSetThumbnail

Use this method to set the thumbnail of a regular or mask sticker set. The format of the thumbnail file must match the format of the stickers in the set. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| name | String | Yes | Sticker set name |
| user\_id | Integer | Yes | User identifier of the sticker set owner |
| thumbnail | [InputFile](#inputfile) or String | Optional | A **.WEBP** or **.PNG** image with the thumbnail, must be up to 128 kilobytes in size and have a width and height of exactly 100px, or a **.TGS** animation with a thumbnail up to 32 kilobytes in size (see [](https://core.telegram.org/stickers#animation-requirements)[https://core.telegram.org/stickers#animation-requirements](https://core.telegram.org/stickers#animation-requirements) for animated sticker technical requirements), or a **.WEBM** video with the thumbnail up to 32 kilobytes in size; see [](https://core.telegram.org/stickers#video-requirements)[https://core.telegram.org/stickers#video-requirements](https://core.telegram.org/stickers#video-requirements) for video sticker technical requirements. Pass a _file\_id_ as a String to send a file that already exists on the Telegram servers, pass an HTTP URL as a String for Telegram to get a file from the Internet, or upload a new one using multipart/form-data. [More information on Sending Files »](#sending-files). Animated and video sticker set thumbnails can't be uploaded via HTTP URL. If omitted, then the thumbnail is dropped and the first sticker is used as the thumbnail. |
| format | String | Yes | Format of the thumbnail, must be one of “static” for a **.WEBP** or **.PNG** image, “animated” for a **.TGS** animation, or “video” for a **.WEBM** video |

#### setCustomEmojiStickerSetThumbnail

Use this method to set the thumbnail of a custom emoji sticker set. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| name | String | Yes | Sticker set name |
| custom\_emoji\_id | String | Optional | Custom emoji identifier of a sticker from the sticker set; pass an empty string to drop the thumbnail and use the first sticker as the thumbnail |

#### deleteStickerSet

Use this method to delete a sticker set that was created by the bot. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| name | String | Yes | Sticker set name |

### Rich messages

The following methods and objects allow your bot to handle and send rich messages.

#### Rich Message Formatting Options

[Rich messages](#inputrichmessage) support advanced structured formatting options like headings, lists, tables, media, block quotations, collapsible blocks, footnotes, and formulas. Telegram clients will render them accordingly. You can specify rich message content using [Markdown-style](#rich-markdown-style) or [HTML-style](#rich-html-style) formatting.

Plain URLs, e-mail addresses, username mentions, hashtags, cashtags, bot commands, phone numbers, and bank card numbers are detected automatically. To disable automatic entity detection, pass _True_ in the _skip\_entity\_detection_ field. Note that Telegram clients will display an alert to the user before opening an inline link ('Open this link?' together with the full URL).

###### Rich Message Limits

Rich messages are subject to the following limits:

- Up to **32768 UTF-8 characters** in the rich message text, including custom emoji alternative text and formula source.
- Up to **500 blocks**, including nested blocks, list items, ordered list items, table rows, quotation blocks, and details blocks.
- Up to **16 levels** of nested formatting and blocks.
- Up to **50 media attachments** in total, including photos, videos, and audio files.
- Up to **20 columns** in a table.

###### Rich Markdown style

To use this mode, pass rich message content in the _markdown_ field. Use the following syntax in your message:

````
**bold text**
__bold text__
*italic text*
_italic text_
~~strikethrough text~~
`inline fixed-width code`
==marked text==
||spoiler||

[inline URL](https://t.me/)
[inline e-mail](mailto:user@example.com)
[inline phone number](tel:+123456789)
[inline mention of a user](tg://user?id=123456789)
![](tg://emoji?id=5368324170671202286)
![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)
$x^2 + y^2$
\#hashtag $USD +12345678901, card: 4242 4242 4242 4242, https://t.me t.me a@t.me /command @username
all the text above was on the same line

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

Paragraph text

```python
  print('pre-formatted fixed-width code block written in the Python programming language')
```

---

- unordered list item
* unordered list item
+ unordered list item

1. ordered list item
2. ordered list item

- [ ] task list item
- [x] completed task list item

>Block quotation started
>
>Block quotation continued on the next line
>Block quotation continued on the same line
>
>The last line of the block quotation

![](https://telegram.org/example/photo.jpg)
![](https://telegram.org/example/video.mp4)
![](https://telegram.org/example/audio.mp3)
![](https://telegram.org/example/audio.ogg)
![](https://telegram.org/example/animation.gif)

![](https://telegram.org/example/photo.jpg "Photo caption")
![](https://telegram.org/example/video.mp4 "Video caption")
![](https://telegram.org/example/audio.mp3 "Audio caption")
![](https://telegram.org/example/audio.ogg "Voice note caption")
![](https://telegram.org/example/animation.gif "Animation caption")

| Header 1 | Header 2 |
|:---------|:--------:|
| left     | center   |

Text with a reference[^id1] and another one[^id2].

[^id1]: Definition of the first footnote.
[^id2]: Definition of the second footnote.

$$E = mc^2$$

```math
E = mc^2
```

## Example Nested Syntax Report for _Q1_
Intro with <u>underlined text</u>, ==marked text==, and $x^2 + y^2$.
**Bold _italic <u>underlined italic bold</u> italic_ bold**
<u>In inline tags, nested **markdown** is parsed</u>
>Quote with **bold text, ~~strikethrough, and <tg-spoiler>spoiler</tg-spoiler>~~**, plus [a link](https://t.me/).

- List item with `code`, <sup>superscript</sup>, <sub>subscript</sub>, and a footnote[^note]
- Another item with **bold <tg-spoiler><code>spoiler code</code></tg-spoiler>**
- Another item with ~~strikethrough and <ins>inserted text</ins>~~

| Metric | Value |
|:-------|------:|
| Speed  | **42** <sup>ms</sup> |
| Status | <tg-spoiler>ready</tg-spoiler> |

[^note]: Footnote with _italic text_ and <u>HTML underline</u>.

---

# Details blocks can contain Markdown content:

<details open><summary>Summary with **bold text**</summary>

### Details heading
- List item with _italic text_
- List item with <tg-spoiler>spoiler</tg-spoiler>

</details>

# Collages and slideshows can contain Markdown media blocks:

<tg-collage>

![](https://telegram.org/example/photo.jpg)
![](https://telegram.org/example/video.mp4)

</tg-collage>

<tg-slideshow>

![](https://telegram.org/example/photo.jpg)
![](https://telegram.org/example/video.mp4)

</tg-slideshow>
````

For formatting features that don't have Markdown syntax, use [HTML tags](#rich-html-style):

```
<u>underlined text</u>, <ins>underlined text</ins>
<sub>subscript text</sub>
<sup>superscript text</sup>
<a name="chapter-1"></a>
<aside>Pull quote<cite>The Author</cite></aside>
<details open><summary>Title</summary>Content</details>
<tg-map lat="41.9" long="12.5" zoom="14"/>
<tg-collage><img src="https://telegram.org/example/photo.jpg"/><figcaption>Caption<cite>The Author</cite></figcaption></tg-collage>
<tg-slideshow><img src="https://telegram.org/example/photo.jpg"/><video src="https://telegram.org/example/video.mp4"/><figcaption>Slideshow caption<cite>The Author</cite></figcaption></tg-slideshow>
```

Please note:

- Rich Markdown is compatible with GitHub Flavored Markdown where possible and can contain arbitrary HTML. Supported rich message HTML tags are parsed as described in [Rich HTML style](#rich-html-style).
- Media can be specified only as a separate block.
- Media blocks support only HTTP and HTTPS URLs.
- Media type is determined by the MIME type and the URL of the media.
- In media syntax, the optional title after the URL is used as the caption; for example,  displays “Photo caption” under the media.
- Table cells can contain only inline formatting.
- Formula source is treated as raw LaTeX.
- See [date-time entity formatting](#date-time-entity-formatting) for more details about supported date-time formats.

###### Rich HTML style

To use this mode, pass rich message content in the _html_ field. The following tags are currently supported:

```
<a name="chapter-0"></a>
<b>bold text</b>, <strong>bold text</strong>
<i>italic text</i>, <em>italic text</em>
<u>underlined text</u>, <ins>underlined text</ins>
<s>strikethrough text</s>, <strike>strikethrough text</strike>, <del>strikethrough text</del>
<code>inline fixed-width code</code>
<mark>marked text</mark>
<sub>subscript text</sub>
<sup>superscript text</sup>
<tg-spoiler>spoiler</tg-spoiler>

<a href="#note-1">Reference</a>
<a href="https://t.me/">inline URL</a>
<a href="mailto:user@example.com">inline e-mail</a>
<a href="tel:+123456789">inline phone number</a>
<a href="tg://user?id=123456789">inline mention of a user</a>
<a href="#chapter-1">in-document link</a>
<a name="chapter-1"></a>

<tg-reference name="note-1">Referenced text</tg-reference>
<tg-emoji emoji-id="5368324170671202286"></tg-emoji>
<img src="tg://emoji?id=5368324170671202286" alt=""/>
<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>
<tg-math>x^2 + y^2</tg-math>

#hashtag $USD +12345678901, card: 4242 4242 4242 4242, https://t.me t.me a@t.me /command @username

all the text above was on the same line

<h1>Heading 1</h1>
<h2>Heading 2</h2>
<h3>Heading 3</h3>
<h4>Heading 4</h4>
<h5>Heading 5</h5>
<h6>Heading 6</h6>

<a name="chapter-2"></a>

<p>Paragraph text</p>
<pre>pre-formatted fixed-width code block</pre>
<pre><code class="language-python">  print('pre-formatted fixed-width code block written in the Python programming language')</code></pre>
<footer>Footer text</footer>
<hr/>
<ul><li>unordered list item</li></ul>
<ol><li>ordered list item</li></ol>
<ol start="3" type="a" reversed><li>ordered list item</li></ol>
<ol><li value="7" type="i">ordered list item with explicit number</li></ol>
<ul>
<li><input type="checkbox" checked>Checked checkbox</li>
<li><input type="checkbox">Unchecked checkbox</li>
</ul>

<blockquote>Block quotation started<br>Block quotation continued<br>The last line of the block quotation<cite>The Author</cite></blockquote>
<aside>Pull quote<cite>The Author</cite></aside>

<img src="https://telegram.org/example/photo.jpg"/>
<video src="https://telegram.org/example/video.mp4"></video>
<audio src="https://telegram.org/example/audio.mp3"></audio>
<audio src="https://telegram.org/example/audio.ogg"></audio>
<video src="https://telegram.org/example/animation.gif"></video>

<figure><img src="https://telegram.org/example/photo.jpg" tg-spoiler/><figcaption>Photo caption<cite>Photo credit</cite></figcaption></figure>
<figure><video src="https://telegram.org/example/video.mp4" tg-spoiler></video><figcaption>Video caption</figcaption></figure>
<figure><audio src="https://telegram.org/example/audio.mp3"></audio><figcaption>Audio caption</figcaption></figure>
<figure><audio src="https://telegram.org/example/audio.ogg"></audio><figcaption>Voice note caption</figcaption></figure>
<figure><video src="https://telegram.org/example/animation.gif" tg-spoiler></video><figcaption>Animation caption</figcaption></figure>

<tg-map lat="41.9" long="12.5" zoom="14"/>
<figure><tg-map lat="41.9" long="12.5" zoom="14"/><figcaption>Map caption</figcaption></figure>

<tg-collage><img src="https://telegram.org/example/photo.jpg"/><video src="https://telegram.org/example/video.mp4"/></tg-collage>
<tg-collage><video src="https://telegram.org/example/video.mp4"/><img src="https://telegram.org/example/photo.jpg"/><figcaption>Collage caption</figcaption></tg-collage>
<tg-slideshow><img src="https://telegram.org/example/photo.jpg"/><video src="https://telegram.org/example/video.mp4"/></tg-slideshow>
<tg-slideshow><video src="https://telegram.org/example/video.mp4"/><img src="https://telegram.org/example/photo.jpg"/><figcaption>Slideshow caption</figcaption></tg-slideshow>

<table><tr><th>Header 1</th><th>Header 2</th></tr><tr><td>Value 1</td><td>Value 2</td></tr></table>
<table bordered striped><caption>Table caption</caption>
<tr><td colspan="2" rowspan="2" align="left">Value</td><td align="center">Value2</td><td align="right">Value3</td></tr>
<tr><td valign="top">Value4</td><td valign="middle">Value5</td><td valign="bottom">Value6</td></tr>
<tr><td>Value7</td></tr></table>

<details><summary>Title</summary>Content</details>
<details open><summary>Title</summary>Content</details>
<tg-math-block>E = mc^2</tg-math-block>
```

Please note:

- Only the tags mentioned above are currently supported.
- All numerical HTML entities are supported.
- The API currently supports only the following named HTML entities: `&lt;`, `&gt;`, `&amp;`, `&quot;`, `&apos;`, `&nbsp;`, `&hellip;`, `&mdash;`, `&ndash;`, `&lsquo;`, `&rsquo;`, `&ldquo;` and `&rdquo;`.
- Use nested `pre` and `code` tags to define the programming language for a pre-formatted block.
- Programming language can't be specified for standalone `code` tags.
- Links `mailto:...`, `tel:...`, and `tg://user?id=...` are rendered as e-mail links, phone links, and inline mentions respectively. Other supported links are rendered as regular inline links.
- Images, videos, and audio files can be specified only as separate media blocks.
- Media blocks support only HTTP and HTTPS URLs.
- An empty `<a name="..."></a>` on its own creates an anchor that can be linked to with `<a href="#...">...</a>`.
- In `<figcaption>`, you can use `<cite>` tags to specify caption credit.
- Use `<tg-reference name="...">...</tg-reference>` to define referenced text that can be linked to with `<a href="#...">...</a>`.
- The body of a `<details>` tag can contain rich message content. If the `open` attribute is specified, the block is expanded by default.
- Formula source is treated as raw LaTeX.
- See [date-time entity formatting](#date-time-entity-formatting) for more details about supported date-time formats.

#### RichMessage

Rich formatted message.

| Field | Type | Description |
| --- | --- | --- |
| blocks | Array of [RichBlock](#richblock) | Content of the message |
| is\_rtl | Boolean | _Optional_. _True_, if the rich message must be shown right-to-left |

#### InputRichMessage

Describes a rich message to be sent. Exactly **one** of the fields _html_ or _markdown_ must be used.

| Field | Type | Description |
| --- | --- | --- |
| html | String | _Optional_. Content of the rich message to send described using HTML formatting. See [rich message formatting options](#rich-message-formatting-options) for more details. |
| markdown | String | _Optional_. Content of the rich message to send described using Markdown formatting. See [rich message formatting options](#rich-message-formatting-options) for more details. |
| is\_rtl | Boolean | _Optional_. Pass _True_ if the rich message must be shown right-to-left |
| skip\_entity\_detection | Boolean | _Optional_. Pass _True_ to skip automatic detection of entities (e.g., URLs, email addresses, username mentions, hashtags, cashtags, bot commands, or phone numbers) in the text |

#### sendRichMessage

Use this method to send rich messages. If the message contains a block with a media element, then the bot must have the right to send the media to the chat. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| rich\_message | [InputRichMessage](#inputrichmessage) | Yes | The message to be sent |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) or [ReplyKeyboardMarkup](#replykeyboardmarkup) or [ReplyKeyboardRemove](#replykeyboardremove) or [ForceReply](#forcereply) | Optional | Additional interface options. A JSON-serialized object for an inline keyboard, custom reply keyboard, instructions to remove a reply keyboard or to force a reply from the user. |

#### sendRichMessageDraft

Use this method to stream a partial rich message to a user while the message is being generated. Note that the streamed draft is ephemeral and acts as a temporary 30-second preview - once the output is finalized, you **must** call [sendRichMessage](#sendrichmessage) with the complete message to persist it in the user's chat. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer | Yes | Unique identifier for the target private chat |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread |
| draft\_id | Integer | Yes | Unique identifier of the message draft; must be non-zero. Changes to drafts with the same identifier are animated. |
| rich\_message | [InputRichMessage](#inputrichmessage) | Yes | The partial message to be streamed |

#### RichText

This object represents a rich formatted text. Currently, it can be either a String for plain text, an Array of [RichText](#richtext), or any of the following types:

- [RichTextBold](#richtextbold)
- [RichTextItalic](#richtextitalic)
- [RichTextUnderline](#richtextunderline)
- [RichTextStrikethrough](#richtextstrikethrough)
- [RichTextSpoiler](#richtextspoiler)
- [RichTextDateTime](#richtextdatetime)
- [RichTextTextMention](#richtexttextmention)
- [RichTextSubscript](#richtextsubscript)
- [RichTextSuperscript](#richtextsuperscript)
- [RichTextMarked](#richtextmarked)
- [RichTextCode](#richtextcode)
- [RichTextCustomEmoji](#richtextcustomemoji)
- [RichTextMathematicalExpression](#richtextmathematicalexpression)
- [RichTextUrl](#richtexturl)
- [RichTextEmailAddress](#richtextemailaddress)
- [RichTextPhoneNumber](#richtextphonenumber)
- [RichTextBankCardNumber](#richtextbankcardnumber)
- [RichTextMention](#richtextmention)
- [RichTextHashtag](#richtexthashtag)
- [RichTextCashtag](#richtextcashtag)
- [RichTextBotCommand](#richtextbotcommand)
- [RichTextAnchor](#richtextanchor)
- [RichTextAnchorLink](#richtextanchorlink)
- [RichTextReference](#richtextreference)
- [RichTextReferenceLink](#richtextreferencelink)

#### RichTextBold

A bold text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “bold” |
| text | [RichText](#richtext) | The text |

#### RichTextItalic

An italicized text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “italic” |
| text | [RichText](#richtext) | The text |

#### RichTextUnderline

An underlined text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “underline” |
| text | [RichText](#richtext) | The text |

#### RichTextStrikethrough

A strikethrough text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “strikethrough” |
| text | [RichText](#richtext) | The text |

#### RichTextSpoiler

A text covered by a spoiler.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “spoiler” |
| text | [RichText](#richtext) | The text |

#### RichTextDateTime

Formatted date and time.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “date\_time” |
| text | [RichText](#richtext) | The text |
| unix\_time | Integer | The Unix time associated with the entity |
| date\_time\_format | String | The string that defines the formatting of the date and time. See [date-time entity formatting](#date-time-entity-formatting) for more details. |

#### RichTextTextMention

A mention of a Telegram user by their identifier.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “text\_mention” |
| text | [RichText](#richtext) | The text |
| user | [User](#user) | The mentioned user |

#### RichTextSubscript

A subscript text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “subscript” |
| text | [RichText](#richtext) | The text |

#### RichTextSuperscript

A superscript text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “superscript” |
| text | [RichText](#richtext) | The text |

#### RichTextMarked

A marked text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “marked” |
| text | [RichText](#richtext) | The text |

#### RichTextCode

A monowidth text.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “code” |
| text | [RichText](#richtext) | The text |

#### RichTextCustomEmoji

A custom emoji.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “custom\_emoji” |
| custom\_emoji\_id | String | Unique identifier of the custom emoji. Use [getCustomEmojiStickers](#getcustomemojistickers) to get full information about the sticker. |
| alternative\_text | String | Alternative emoji for the custom emoji |

#### RichTextMathematicalExpression

A mathematical expression.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “mathematical\_expression” |
| expression | String | The expression in LaTeX format |

#### RichTextUrl

A text with a link.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “url” |
| text | [RichText](#richtext) | The text |
| url | String | URL of the link |

#### RichTextEmailAddress

A text with an email address.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “email\_address” |
| text | [RichText](#richtext) | The text |
| email\_address | String | The email address |

#### RichTextPhoneNumber

A text with a phone number.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “phone\_number” |
| text | [RichText](#richtext) | The text |
| phone\_number | String | The phone number |

#### RichTextBankCardNumber

A text with a bank card number.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “bank\_card\_number” |
| text | [RichText](#richtext) | The text |
| bank\_card\_number | String | The bank card number |

#### RichTextMention

A mention by a username.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “mention” |
| text | [RichText](#richtext) | The text |
| username | String | The username |

#### RichTextHashtag

A hashtag.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “hashtag” |
| text | [RichText](#richtext) | The text |
| hashtag | String | The hashtag |

#### RichTextCashtag

A cashtag.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “cashtag” |
| text | [RichText](#richtext) | The text |
| cashtag | String | The cashtag |

#### RichTextBotCommand

A bot command.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “bot\_command” |
| text | [RichText](#richtext) | The text |
| bot\_command | String | The bot command |

#### RichTextAnchor

An anchor.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “anchor” |
| name | String | The name of the anchor |

#### RichTextAnchorLink

A link to an anchor.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “anchor\_link” |
| text | [RichText](#richtext) | The link text |
| anchor\_name | String | The name of the anchor. If the name is empty, then the link brings back to the top of the message. |

#### RichTextReference

A reference.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “reference” |
| text | [RichText](#richtext) | Text of the reference |
| name | String | The name of the reference |

#### RichTextReferenceLink

A link to a reference.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the rich text, always “reference\_link” |
| text | [RichText](#richtext) | The link text |
| reference\_name | String | The name of the reference |

#### RichBlockCaption

Caption of a rich formatted block.

| Field | Type | Description |
| --- | --- | --- |
| text | [RichText](#richtext) | Block caption |
| credit | [RichText](#richtext) | _Optional_. Block credit which corresponds to the HTML tag <cite> |

#### RichBlockTableCell

Cell in a table.

| Field | Type | Description |
| --- | --- | --- |
| text | [RichText](#richtext) | _Optional_. Text in the cell. If omitted, then the cell is invisible. |
| is\_header | True | _Optional_. _True_, if the cell is a header cell |
| colspan | Integer | _Optional_. The number of columns the cell spans if it is bigger than 1 |
| rowspan | Integer | _Optional_. The number of rows the cell spans if it is bigger than 1 |
| align | String | Horizontal cell content alignment. Currently, must be one of “left”, “center”, or “right”. |
| valign | String | Vertical cell content alignment. Currently, must be one of “top”, “middle”, or “bottom”. |

#### RichBlockListItem

An item of a list.

| Field | Type | Description |
| --- | --- | --- |
| label | String | Label of the item |
| blocks | Array of [RichBlock](#richblock) | The content of the item |
| has\_checkbox | True | _Optional_. _True_, if the item has a checkbox |
| is\_checked | True | _Optional_. _True_, if the item has a checked checkbox |
| value | Integer | _Optional_. For ordered lists, the numeric value of the item label |
| type | String | _Optional_. For ordered lists, the type of the item label; must be one of “a” for lowercase letters, “A” for uppercase letters, “i” for lowercase Roman numerals, “I” for uppercase Roman numerals, or “1” for decimal numbers |

#### RichBlock

This object represents a block in a rich formatted message. Currently, it can be any of the following types:

- [RichBlockParagraph](#richblockparagraph)
- [RichBlockSectionHeading](#richblocksectionheading)
- [RichBlockPreformatted](#richblockpreformatted)
- [RichBlockFooter](#richblockfooter)
- [RichBlockDivider](#richblockdivider)
- [RichBlockMathematicalExpression](#richblockmathematicalexpression)
- [RichBlockAnchor](#richblockanchor)
- [RichBlockList](#richblocklist)
- [RichBlockBlockQuotation](#richblockblockquotation)
- [RichBlockPullQuotation](#richblockpullquotation)
- [RichBlockCollage](#richblockcollage)
- [RichBlockSlideshow](#richblockslideshow)
- [RichBlockTable](#richblocktable)
- [RichBlockDetails](#richblockdetails)
- [RichBlockMap](#richblockmap)
- [RichBlockAnimation](#richblockanimation)
- [RichBlockAudio](#richblockaudio)
- [RichBlockPhoto](#richblockphoto)
- [RichBlockVideo](#richblockvideo)
- [RichBlockVoiceNote](#richblockvoicenote)
- [RichBlockThinking](#richblockthinking)

#### RichBlockParagraph

A text paragraph, corresponding to the HTML tag `<p>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “paragraph” |
| text | [RichText](#richtext) | Text of the block |

#### RichBlockSectionHeading

A section heading, corresponding to the HTML tags `<h1>`, `<h2>`, `<h3>`, `<h4>`, `<h5>`, or `<h6>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “heading” |
| text | [RichText](#richtext) | Text of the block |
| size | Integer | Relative size of the text font; 1-6, 1 is the largest, 6 is the smallest |

#### RichBlockPreformatted

A preformatted text block, corresponding to the nested HTML tags `<pre>` and `<code>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “pre” |
| text | [RichText](#richtext) | Text of the block |
| language | String | _Optional_. The programming language of the text |

#### RichBlockFooter

A footer, corresponding to the HTML tag `<footer>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “footer” |
| text | [RichText](#richtext) | Text of the block |

#### RichBlockDivider

A divider, corresponding to the HTML tag `<hr/>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “divider” |

#### RichBlockMathematicalExpression

A block with a mathematical expression in LaTeX format, corresponding to the custom HTML tag `<tg-math-block>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “mathematical\_expression” |
| expression | String | The mathematical expression in LaTeX format |

#### RichBlockAnchor

A block with an anchor, corresponding to the HTML tag `<a>` with the attribute `name`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “anchor” |
| name | String | The name of the anchor |

#### RichBlockList

A list of blocks, corresponding to the HTML tag `<ul>` or `<ol>` with multiple nested tags `<li>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “list” |
| items | Array of [RichBlockListItem](#richblocklistitem) | Items of the list |

#### RichBlockBlockQuotation

A block quotation, corresponding to the HTML tag `<blockquote>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “blockquote” |
| blocks | Array of [RichBlock](#richblock) | Content of the block |
| credit | [RichText](#richtext) | _Optional_. Credit of the block |

#### RichBlockPullQuotation

A quotation with centered text, loosely corresponding to the HTML tag `<aside>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “pullquote” |
| text | [RichText](#richtext) | Text of the block |
| credit | [RichText](#richtext) | _Optional_. Credit of the block |

#### RichBlockCollage

A collage, corresponding to the custom HTML tag `<tg-collage>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “collage” |
| blocks | Array of [RichBlock](#richblock) | Elements of the collage |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockSlideshow

A slideshow, corresponding to the custom HTML tag `<tg-slideshow>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “slideshow” |
| blocks | Array of [RichBlock](#richblock) | Elements of the slideshow |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockTable

A table, corresponding to the HTML tag `<table>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “table” |
| cells | Array of Array of [RichBlockTableCell](#richblocktablecell) | Cells of the table |
| is\_bordered | True | _Optional_. _True_, if the table has borders |
| is\_striped | True | _Optional_. _True_, if the table is striped |
| caption | [RichText](#richtext) | _Optional_. Caption of the table |

#### RichBlockDetails

An expandable block for details disclosure, corresponding to the HTML tag `<details>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “details” |
| summary | [RichText](#richtext) | Always shown summary of the block |
| blocks | Array of [RichBlock](#richblock) | Content of the block |
| is\_open | True | _Optional_. _True_, if the content of the block is visible by default |

#### RichBlockMap

A block with a map, corresponding to the custom HTML tag `<tg-map>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “map” |
| location | [Location](#location) | Location of the center of the map |
| zoom | Integer | Map zoom level; 13-20 |
| width | Integer | Expected width of the map |
| height | Integer | Expected height of the map |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockAnimation

A block with an animation, corresponding to the HTML tag `<video>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “animation” |
| animation | [Animation](#animation) | The animation |
| has\_spoiler | True | _Optional_. _True_, if the media preview is covered by a spoiler animation |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockAudio

A block with a music file, corresponding to the HTML tag `<audio>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “audio” |
| audio | [Audio](#audio) | The audio |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockPhoto

A block with a photo, corresponding to the HTML tag `<photo>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “photo” |
| photo | Array of [PhotoSize](#photosize) | Available sizes of the photo |
| has\_spoiler | True | _Optional_. _True_, if the media preview is covered by a spoiler animation |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockVideo

A block with a video, corresponding to the HTML tag `<video>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “video” |
| video | [Video](#video) | The video |
| has\_spoiler | True | _Optional_. _True_, if the media preview is covered by a spoiler animation |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockVoiceNote

A block with a voice note, corresponding to the HTML tag `<audio>`.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “voice\_note” |
| voice\_note | [Voice](#voice) | The voice note |
| caption | [RichBlockCaption](#richblockcaption) | _Optional_. Caption of the block |

#### RichBlockThinking

A block with a “Thinking…” placeholder, corresponding to the custom HTML tag `<tg-thinking>`. The block may be used only in [sendRichMessageDraft](#sendrichmessagedraft), therefore it can't be received in messages. See [](https://t.me/addemoji/AIActions)[https://t.me/addemoji/AIActions](https://t.me/addemoji/AIActions) for examples of custom emoji, which are recommended for usage in the block.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the block, always “thinking” |
| text | [RichText](#richtext) | Text of the block. See [](https://t.me/addemoji/AIActions)[https://t.me/addemoji/AIActions](https://t.me/addemoji/AIActions) for examples of custom emoji, which are recommended for usage in the block. |

### Inline mode

The following methods and objects allow your bot to work in [inline mode](https://core.telegram.org/bots/inline).  
Please see our [Introduction to Inline bots](https://core.telegram.org/bots/inline) for more details.

To enable this option, send the `/setinline` command to [@BotFather](https://t.me/botfather) and provide the placeholder text that the user will see in the input field after typing your bot's name.

#### InlineQuery

This object represents an incoming inline query. When the user sends an empty query, your bot could return some default or trending results.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique identifier for this query |
| from | [User](#user) | Sender |
| query | String | Text of the query (up to 256 characters) |
| offset | String | Offset of the results to be returned, can be controlled by the bot |
| chat\_type | String | _Optional_. Type of the chat from which the inline query was sent. Can be either “sender” for a private chat with the inline query sender, “private”, “group”, “supergroup”, or “channel”. The chat type should be always known for requests sent from official clients and most third-party clients, unless the request was sent from a secret chat. |
| location | [Location](#location) | _Optional_. Sender location, only for bots that request user location |

#### answerInlineQuery

Use this method to send answers to an inline query. On success, _True_ is returned.  
No more than **50** results per query are allowed.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| inline\_query\_id | String | Yes | Unique identifier for the answered query |
| results | Array of [InlineQueryResult](#inlinequeryresult) | Yes | A JSON-serialized array of results for the inline query |
| cache\_time | Integer | Optional | The maximum amount of time in seconds that the result of the inline query may be cached on the server. Defaults to 300. |
| is\_personal | Boolean | Optional | Pass _True_ if results may be cached on the server side only for the user that sent the query. By default, results may be returned to any user who sends the same query. |
| next\_offset | String | Optional | Pass the offset that a client should send in the next query with the same text to receive more results. Pass an empty string if there are no more results or if you don't support pagination. Offset length can't exceed 64 bytes. |
| button | [InlineQueryResultsButton](#inlinequeryresultsbutton) | Optional | A JSON-serialized object describing a button to be shown above inline query results |

#### InlineQueryResultsButton

This object represents a button to be shown above inline query results. You **must** use exactly one of the optional fields.

| Field | Type | Description |
| --- | --- | --- |
| text | String | Label text on the button |
| web\_app | [WebAppInfo](#webappinfo) | _Optional_. Description of the [Web App](https://core.telegram.org/bots/webapps) that will be launched when the user presses the button. The Web App will be able to switch back to the inline mode using the method [switchInlineQuery](https://core.telegram.org/bots/webapps#initializing-mini-apps) inside the Web App. |
| start\_parameter | String | _Optional_. Deep-linking parameter for the /start message sent to the bot when a user presses the button. 1-64 characters, only `A-Z`, `a-z`, `0-9`, `_` and `-` are allowed.  <br>  <br>_Example:_ An inline bot that sends YouTube videos can ask the user to connect the bot to their YouTube account to adapt search results accordingly. To do this, it displays a 'Connect your YouTube account' button above the results, or even before showing any. The user presses the button, switches to a private chat with the bot and, in doing so, passes a start parameter that instructs the bot to return an OAuth link. Once done, the bot can offer a [_switch\_inline_](#inlinekeyboardmarkup) button so that the user can easily return to the chat where they wanted to use the bot's inline capabilities. |

#### InlineQueryResult

This object represents one result of an inline query. Telegram clients currently support results of the following 20 types:

- [InlineQueryResultCachedAudio](#inlinequeryresultcachedaudio)
- [InlineQueryResultCachedDocument](#inlinequeryresultcacheddocument)
- [InlineQueryResultCachedGif](#inlinequeryresultcachedgif)
- [InlineQueryResultCachedMpeg4Gif](#inlinequeryresultcachedmpeg4gif)
- [InlineQueryResultCachedPhoto](#inlinequeryresultcachedphoto)
- [InlineQueryResultCachedSticker](#inlinequeryresultcachedsticker)
- [InlineQueryResultCachedVideo](#inlinequeryresultcachedvideo)
- [InlineQueryResultCachedVoice](#inlinequeryresultcachedvoice)
- [InlineQueryResultArticle](#inlinequeryresultarticle)
- [InlineQueryResultAudio](#inlinequeryresultaudio)
- [InlineQueryResultContact](#inlinequeryresultcontact)
- [InlineQueryResultGame](#inlinequeryresultgame)
- [InlineQueryResultDocument](#inlinequeryresultdocument)
- [InlineQueryResultGif](#inlinequeryresultgif)
- [InlineQueryResultLocation](#inlinequeryresultlocation)
- [InlineQueryResultMpeg4Gif](#inlinequeryresultmpeg4gif)
- [InlineQueryResultPhoto](#inlinequeryresultphoto)
- [InlineQueryResultVenue](#inlinequeryresultvenue)
- [InlineQueryResultVideo](#inlinequeryresultvideo)
- [InlineQueryResultVoice](#inlinequeryresultvoice)

**Note:** All URLs passed in inline query results will be available to end users and therefore must be assumed to be **public**.

#### InlineQueryResultArticle

Represents a link to an article or web page.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _article_ |
| id  | String | Unique identifier for this result, 1-64 Bytes |
| title | String | Title of the result |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | Content of the message to be sent |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| url | String | _Optional_. URL of the result |
| description | String | _Optional_. Short description of the result |
| thumbnail\_url | String | _Optional_. Url of the thumbnail for the result |
| thumbnail\_width | Integer | _Optional_. Thumbnail width |
| thumbnail\_height | Integer | _Optional_. Thumbnail height |

#### InlineQueryResultPhoto

Represents a link to a photo. By default, this photo will be sent by the user with optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the photo.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _photo_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| photo\_url | String | A valid URL of the photo. Photo must be in **JPEG** format. Photo size must not exceed 5MB. |
| thumbnail\_url | String | URL of the thumbnail for the photo |
| photo\_width | Integer | _Optional_. Width of the photo |
| photo\_height | Integer | _Optional_. Height of the photo |
| title | String | _Optional_. Title for the result |
| description | String | _Optional_. Short description of the result |
| caption | String | _Optional_. Caption of the photo to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the photo caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the photo |

#### InlineQueryResultGif

Represents a link to an animated GIF file. By default, this animated GIF file will be sent by the user with optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the animation.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _gif_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| gif\_url | String | A valid URL for the GIF file |
| gif\_width | Integer | _Optional_. Width of the GIF |
| gif\_height | Integer | _Optional_. Height of the GIF |
| gif\_duration | Integer | _Optional_. Duration of the GIF in seconds |
| thumbnail\_url | String | URL of the static (JPEG or GIF) or animated (MPEG4) thumbnail for the result |
| thumbnail\_mime\_type | String | _Optional_. MIME type of the thumbnail, must be one of “image/jpeg”, “image/gif”, or “video/mp4”. Defaults to “image/jpeg”. |
| title | String | _Optional_. Title for the result |
| caption | String | _Optional_. Caption of the GIF file to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the GIF animation |

#### InlineQueryResultMpeg4Gif

Represents a link to a video animation (H.264/MPEG-4 AVC video without sound). By default, this animated MPEG-4 file will be sent by the user with optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the animation.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _mpeg4\_gif_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| mpeg4\_url | String | A valid URL for the MPEG4 file |
| mpeg4\_width | Integer | _Optional_. Video width |
| mpeg4\_height | Integer | _Optional_. Video height |
| mpeg4\_duration | Integer | _Optional_. Video duration in seconds |
| thumbnail\_url | String | URL of the static (JPEG or GIF) or animated (MPEG4) thumbnail for the result |
| thumbnail\_mime\_type | String | _Optional_. MIME type of the thumbnail, must be one of “image/jpeg”, “image/gif”, or “video/mp4”. Defaults to “image/jpeg”. |
| title | String | _Optional_. Title for the result |
| caption | String | _Optional_. Caption of the MPEG-4 file to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the video animation |

#### InlineQueryResultVideo

Represents a link to a page containing an embedded video player or a video file. By default, this video file will be sent by the user with an optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the video.

> If an InlineQueryResultVideo message contains an embedded video (e.g., YouTube), you **must** replace its content using _input\_message\_content_.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _video_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| video\_url | String | A valid URL for the embedded video player or video file |
| mime\_type | String | MIME type of the content of the video URL, “text/html” or “video/mp4” |
| thumbnail\_url | String | URL of the thumbnail (JPEG only) for the video |
| title | String | Title for the result |
| caption | String | _Optional_. Caption of the video to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the video caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| video\_width | Integer | _Optional_. Video width |
| video\_height | Integer | _Optional_. Video height |
| video\_duration | Integer | _Optional_. Video duration in seconds |
| description | String | _Optional_. Short description of the result |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the video. This field is **required** if InlineQueryResultVideo is used to send an HTML-page as a result (e.g., a YouTube video). |

#### InlineQueryResultAudio

Represents a link to an MP3 audio file. By default, this audio file will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the audio.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _audio_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| audio\_url | String | A valid URL for the audio file |
| title | String | Title |
| caption | String | _Optional_. Caption, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the audio caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| performer | String | _Optional_. Performer |
| audio\_duration | Integer | _Optional_. Audio duration in seconds |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the audio |

#### InlineQueryResultVoice

Represents a link to a voice recording in an .OGG container encoded with OPUS. By default, this voice recording will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the the voice message.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _voice_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| voice\_url | String | A valid URL for the voice recording |
| title | String | Recording title |
| caption | String | _Optional_. Caption, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the voice message caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| voice\_duration | Integer | _Optional_. Recording duration in seconds |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the voice recording |

#### InlineQueryResultDocument

Represents a link to a file. By default, this file will be sent by the user with an optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the file. Currently, only **.PDF** and **.ZIP** files can be sent using this method.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _document_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| title | String | Title for the result |
| caption | String | _Optional_. Caption of the document to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the document caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| document\_url | String | A valid URL for the file |
| mime\_type | String | MIME type of the content of the file, either “application/pdf” or “application/zip” |
| description | String | _Optional_. Short description of the result |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the file |
| thumbnail\_url | String | _Optional_. URL of the thumbnail (JPEG only) for the file |
| thumbnail\_width | Integer | _Optional_. Thumbnail width |
| thumbnail\_height | Integer | _Optional_. Thumbnail height |

#### InlineQueryResultLocation

Represents a location on a map. By default, the location will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the location.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _location_ |
| id  | String | Unique identifier for this result, 1-64 Bytes |
| latitude | Float | Location latitude in degrees |
| longitude | Float | Location longitude in degrees |
| title | String | Location title |
| horizontal\_accuracy | Float | _Optional_. The radius of uncertainty for the location, measured in meters; 0-1500 |
| live\_period | Integer | _Optional_. Period in seconds during which the location can be updated, must be between 60 and 86400, or 0x7FFFFFFF for live locations that can be edited indefinitely |
| heading | Integer | _Optional_. For live locations, a direction in which the user is moving, in degrees. Must be between 1 and 360 if specified. |
| proximity\_alert\_radius | Integer | _Optional_. For live locations, a maximum distance for proximity alerts about approaching another chat member, in meters. Must be between 1 and 100000 if specified. |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the location |
| thumbnail\_url | String | _Optional_. Url of the thumbnail for the result |
| thumbnail\_width | Integer | _Optional_. Thumbnail width |
| thumbnail\_height | Integer | _Optional_. Thumbnail height |

#### InlineQueryResultVenue

Represents a venue. By default, the venue will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the venue.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _venue_ |
| id  | String | Unique identifier for this result, 1-64 Bytes |
| latitude | Float | Latitude of the venue location in degrees |
| longitude | Float | Longitude of the venue location in degrees |
| title | String | Title of the venue |
| address | String | Address of the venue |
| foursquare\_id | String | _Optional_. Foursquare identifier of the venue if known |
| foursquare\_type | String | _Optional_. Foursquare type of the venue, if known. (For example, “arts\_entertainment/default”, “arts\_entertainment/aquarium” or “food/icecream”.) |
| google\_place\_id | String | _Optional_. Google Places identifier of the venue |
| google\_place\_type | String | _Optional_. Google Places type of the venue. (See [supported types](https://developers.google.com/places/web-service/supported_types).) |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the venue |
| thumbnail\_url | String | _Optional_. Url of the thumbnail for the result |
| thumbnail\_width | Integer | _Optional_. Thumbnail width |
| thumbnail\_height | Integer | _Optional_. Thumbnail height |

#### InlineQueryResultContact

Represents a contact with a phone number. By default, this contact will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the contact.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _contact_ |
| id  | String | Unique identifier for this result, 1-64 Bytes |
| phone\_number | String | Contact's phone number |
| first\_name | String | Contact's first name |
| last\_name | String | _Optional_. Contact's last name |
| vcard | String | _Optional_. Additional data about the contact in the form of a [vCard](https://en.wikipedia.org/wiki/VCard), 0-2048 bytes |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the contact |
| thumbnail\_url | String | _Optional_. Url of the thumbnail for the result |
| thumbnail\_width | Integer | _Optional_. Thumbnail width |
| thumbnail\_height | Integer | _Optional_. Thumbnail height |

#### InlineQueryResultGame

Represents a [Game](#games).

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _game_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| game\_short\_name | String | Short name of the game |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |

#### InlineQueryResultCachedPhoto

Represents a link to a photo stored on the Telegram servers. By default, this photo will be sent by the user with an optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the photo.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _photo_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| photo\_file\_id | String | A valid file identifier of the photo |
| title | String | _Optional_. Title for the result |
| description | String | _Optional_. Short description of the result |
| caption | String | _Optional_. Caption of the photo to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the photo caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the photo |

#### InlineQueryResultCachedGif

Represents a link to an animated GIF file stored on the Telegram servers. By default, this animated GIF file will be sent by the user with an optional caption. Alternatively, you can use _input\_message\_content_ to send a message with specified content instead of the animation.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _gif_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| gif\_file\_id | String | A valid file identifier for the GIF file |
| title | String | _Optional_. Title for the result |
| caption | String | _Optional_. Caption of the GIF file to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the GIF animation |

#### InlineQueryResultCachedMpeg4Gif

Represents a link to a video animation (H.264/MPEG-4 AVC video without sound) stored on the Telegram servers. By default, this animated MPEG-4 file will be sent by the user with an optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the animation.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _mpeg4\_gif_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| mpeg4\_file\_id | String | A valid file identifier for the MPEG4 file |
| title | String | _Optional_. Title for the result |
| caption | String | _Optional_. Caption of the MPEG-4 file to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the video animation |

#### InlineQueryResultCachedSticker

Represents a link to a sticker stored on the Telegram servers. By default, this sticker will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the sticker.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _sticker_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| sticker\_file\_id | String | A valid file identifier of the sticker |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the sticker |

#### InlineQueryResultCachedDocument

Represents a link to a file stored on the Telegram servers. By default, this file will be sent by the user with an optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the file.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _document_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| title | String | Title for the result |
| document\_file\_id | String | A valid file identifier for the file |
| description | String | _Optional_. Short description of the result |
| caption | String | _Optional_. Caption of the document to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the document caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the file |

#### InlineQueryResultCachedVideo

Represents a link to a video file stored on the Telegram servers. By default, this video file will be sent by the user with an optional caption. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the video.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _video_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| video\_file\_id | String | A valid file identifier for the video file |
| title | String | Title for the result |
| description | String | _Optional_. Short description of the result |
| caption | String | _Optional_. Caption of the video to be sent, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the video caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| show\_caption\_above\_media | Boolean | _Optional_. Pass _True_, if the caption must be shown above the message media |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the video |

#### InlineQueryResultCachedVoice

Represents a link to a voice message stored on the Telegram servers. By default, this voice message will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the voice message.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _voice_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| voice\_file\_id | String | A valid file identifier for the voice message |
| title | String | Voice message title |
| caption | String | _Optional_. Caption, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the voice message caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the voice message |

#### InlineQueryResultCachedAudio

Represents a link to an MP3 audio file stored on the Telegram servers. By default, this audio file will be sent by the user. Alternatively, you can use _input\_message\_content_ to send a message with the specified content instead of the audio.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the result, must be _audio_ |
| id  | String | Unique identifier for this result, 1-64 bytes |
| audio\_file\_id | String | A valid file identifier for the audio file |
| caption | String | _Optional_. Caption, 0-1024 characters after entities parsing |
| parse\_mode | String | _Optional_. Mode for parsing entities in the audio caption. See [formatting options](#formatting-options) for more details. |
| caption\_entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in the caption, which can be specified instead of _parse\_mode_ |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | _Optional_. Inline keyboard attached to the message |
| input\_message\_content | [InputMessageContent](#inputmessagecontent) | _Optional_. Content of the message to be sent instead of the audio |

#### InputMessageContent

This object represents the content of a message to be sent as a result of an inline query. Telegram clients currently support the following types:

- [InputTextMessageContent](#inputtextmessagecontent)
- [InputRichMessageContent](#inputrichmessagecontent)
- [InputLocationMessageContent](#inputlocationmessagecontent)
- [InputVenueMessageContent](#inputvenuemessagecontent)
- [InputContactMessageContent](#inputcontactmessagecontent)
- [InputInvoiceMessageContent](#inputinvoicemessagecontent)

#### InputTextMessageContent

Represents the [content](#inputmessagecontent) of a text message to be sent as the result of an inline query.

| Field | Type | Description |
| --- | --- | --- |
| message\_text | String | Text of the message to be sent, 1-4096 characters |
| parse\_mode | String | _Optional_. Mode for parsing entities in the message text. See [formatting options](#formatting-options) for more details. |
| entities | Array of [MessageEntity](#messageentity) | _Optional_. List of special entities that appear in message text, which can be specified instead of _parse\_mode_ |
| link\_preview\_options | [LinkPreviewOptions](#linkpreviewoptions) | _Optional_. Link preview generation options for the message |

#### InputRichMessageContent

Represents the [content](#inputmessagecontent) of a rich message to be sent as the result of an inline query.

| Field | Type | Description |
| --- | --- | --- |
| rich\_message | [InputRichMessage](#inputrichmessage) | The message to be sent |

#### InputLocationMessageContent

Represents the [content](#inputmessagecontent) of a location message to be sent as the result of an inline query.

| Field | Type | Description |
| --- | --- | --- |
| latitude | Float | Latitude of the location in degrees |
| longitude | Float | Longitude of the location in degrees |
| horizontal\_accuracy | Float | _Optional_. The radius of uncertainty for the location, measured in meters; 0-1500 |
| live\_period | Integer | _Optional_. Period in seconds during which the location can be updated, must be between 60 and 86400, or 0x7FFFFFFF for live locations that can be edited indefinitely |
| heading | Integer | _Optional_. For live locations, a direction in which the user is moving, in degrees. Must be between 1 and 360 if specified. |
| proximity\_alert\_radius | Integer | _Optional_. For live locations, a maximum distance for proximity alerts about approaching another chat member, in meters. Must be between 1 and 100000 if specified. |

#### InputVenueMessageContent

Represents the [content](#inputmessagecontent) of a venue message to be sent as the result of an inline query.

| Field | Type | Description |
| --- | --- | --- |
| latitude | Float | Latitude of the venue in degrees |
| longitude | Float | Longitude of the venue in degrees |
| title | String | Name of the venue |
| address | String | Address of the venue |
| foursquare\_id | String | _Optional_. Foursquare identifier of the venue, if known |
| foursquare\_type | String | _Optional_. Foursquare type of the venue, if known. (For example, “arts\_entertainment/default”, “arts\_entertainment/aquarium” or “food/icecream”.) |
| google\_place\_id | String | _Optional_. Google Places identifier of the venue |
| google\_place\_type | String | _Optional_. Google Places type of the venue. (See [supported types](https://developers.google.com/places/web-service/supported_types).) |

#### InputContactMessageContent

Represents the [content](#inputmessagecontent) of a contact message to be sent as the result of an inline query.

| Field | Type | Description |
| --- | --- | --- |
| phone\_number | String | Contact's phone number |
| first\_name | String | Contact's first name |
| last\_name | String | _Optional_. Contact's last name |
| vcard | String | _Optional_. Additional data about the contact in the form of a [vCard](https://en.wikipedia.org/wiki/VCard), 0-2048 bytes |

#### InputInvoiceMessageContent

Represents the [content](#inputmessagecontent) of an invoice message to be sent as the result of an inline query.

| Field | Type | Description |
| --- | --- | --- |
| title | String | Product name, 1-32 characters |
| description | String | Product description, 1-255 characters |
| payload | String | Bot-defined invoice payload, 1-128 bytes. This will not be displayed to the user, use it for your internal processes. |
| provider\_token | String | _Optional_. Payment provider token, obtained via [@BotFather](https://t.me/botfather). Pass an empty string for payments in [Telegram Stars](https://t.me/BotNews/90). |
| currency | String | Three-letter ISO 4217 currency code, see [more on currencies](https://core.telegram.org/bots/payments#supported-currencies). Pass “XTR” for payments in [Telegram Stars](https://t.me/BotNews/90). |
| prices | Array of [LabeledPrice](#labeledprice) | Price breakdown, a JSON-serialized list of components (e.g. product price, tax, discount, delivery cost, delivery tax, bonus, etc.). Must contain exactly one item for payments in [Telegram Stars](https://t.me/BotNews/90). |
| max\_tip\_amount | Integer | _Optional_. The maximum accepted amount for tips in the _smallest units_ of the currency (integer, **not** float/double). For example, for a maximum tip of `US$ 1.45` pass `max_tip_amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). Defaults to 0. Not supported for payments in [Telegram Stars](https://t.me/BotNews/90). |
| suggested\_tip\_amounts | Array of Integer | _Optional_. A JSON-serialized array of suggested amounts of tip in the _smallest units_ of the currency (integer, **not** float/double). At most 4 suggested tip amounts can be specified. The suggested tip amounts must be positive, passed in a strictly increased order and must not exceed _max\_tip\_amount_. |
| provider\_data | String | _Optional_. A JSON-serialized object for data about the invoice, which will be shared with the payment provider. A detailed description of the required fields should be provided by the payment provider. |
| photo\_url | String | _Optional_. URL of the product photo for the invoice. Can be a photo of the goods or a marketing image for a service. |
| photo\_size | Integer | _Optional_. Photo size in bytes |
| photo\_width | Integer | _Optional_. Photo width |
| photo\_height | Integer | _Optional_. Photo height |
| need\_name | Boolean | _Optional_. Pass _True_ if you require the user's full name to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_phone\_number | Boolean | _Optional_. Pass _True_ if you require the user's phone number to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_email | Boolean | _Optional_. Pass _True_ if you require the user's email address to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_shipping\_address | Boolean | _Optional_. Pass _True_ if you require the user's shipping address to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| send\_phone\_number\_to\_provider | Boolean | _Optional_. Pass _True_ if the user's phone number should be sent to the provider. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| send\_email\_to\_provider | Boolean | _Optional_. Pass _True_ if the user's email address should be sent to the provider. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| is\_flexible | Boolean | _Optional_. Pass _True_ if the final price depends on the shipping method. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |

#### ChosenInlineResult

Represents a [result](#inlinequeryresult) of an inline query that was chosen by the user and sent to their chat partner.

| Field | Type | Description |
| --- | --- | --- |
| result\_id | String | The unique identifier for the result that was chosen |
| from | [User](#user) | The user that chose the result |
| location | [Location](#location) | _Optional_. Sender location, only for bots that require user location |
| inline\_message\_id | String | _Optional_. Identifier of the sent inline message. Available only if there is an [inline keyboard](#inlinekeyboardmarkup) attached to the message. Will be also received in [callback queries](#callbackquery) and can be used to [edit](#updating-messages) the message. |
| query | String | The query that was used to obtain the result |

**Note:** It is necessary to enable [inline feedback](https://core.telegram.org/bots/inline#collecting-feedback) via [@BotFather](https://t.me/botfather) in order to receive these objects in updates.

### Payments

Your bot can accept payments from Telegram users. Please see the [introduction to payments](https://core.telegram.org/bots/payments) for more details on the process and how to set up payments for your bot.

#### sendInvoice

Use this method to send invoices. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot, supergroup or channel in the format `@username` |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| direct\_messages\_topic\_id | Integer | Optional | Identifier of the direct messages topic to which the message will be sent; required if the message is sent to a direct messages chat |
| title | String | Yes | Product name, 1-32 characters |
| description | String | Yes | Product description, 1-255 characters |
| payload | String | Yes | Bot-defined invoice payload, 1-128 bytes. This will not be displayed to the user, use it for your internal processes. |
| provider\_token | String | Optional | Payment provider token, obtained via [@BotFather](https://t.me/botfather). Pass an empty string for payments in [Telegram Stars](https://t.me/BotNews/90). |
| currency | String | Yes | Three-letter ISO 4217 currency code, see [more on currencies](https://core.telegram.org/bots/payments#supported-currencies). Pass “XTR” for payments in [Telegram Stars](https://t.me/BotNews/90). |
| prices | Array of [LabeledPrice](#labeledprice) | Yes | Price breakdown, a JSON-serialized list of components (e.g. product price, tax, discount, delivery cost, delivery tax, bonus, etc.). Must contain exactly one item for payments in [Telegram Stars](https://t.me/BotNews/90). |
| max\_tip\_amount | Integer | Optional | The maximum accepted amount for tips in the _smallest units_ of the currency (integer, **not** float/double). For example, for a maximum tip of `US$ 1.45` pass `max_tip_amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). Defaults to 0. Not supported for payments in [Telegram Stars](https://t.me/BotNews/90). |
| suggested\_tip\_amounts | Array of Integer | Optional | A JSON-serialized array of suggested amounts of tips in the _smallest units_ of the currency (integer, **not** float/double). At most 4 suggested tip amounts can be specified. The suggested tip amounts must be positive, passed in a strictly increased order and must not exceed _max\_tip\_amount_. |
| start\_parameter | String | Optional | Unique deep-linking parameter. If left empty, **forwarded copies** of the sent message will have a _Pay_ button, allowing multiple users to pay directly from the forwarded message, using the same invoice. If non-empty, forwarded copies of the sent message will have a _URL_ button with a deep link to the bot (instead of a _Pay_ button), with the value used as the start parameter. |
| provider\_data | String | Optional | JSON-serialized data about the invoice, which will be shared with the payment provider. A detailed description of required fields should be provided by the payment provider. |
| photo\_url | String | Optional | URL of the product photo for the invoice. Can be a photo of the goods or a marketing image for a service. People like it better when they see what they are paying for. |
| photo\_size | Integer | Optional | Photo size in bytes |
| photo\_width | Integer | Optional | Photo width |
| photo\_height | Integer | Optional | Photo height |
| need\_name | Boolean | Optional | Pass _True_ if you require the user's full name to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_phone\_number | Boolean | Optional | Pass _True_ if you require the user's phone number to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_email | Boolean | Optional | Pass _True_ if you require the user's email address to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_shipping\_address | Boolean | Optional | Pass _True_ if you require the user's shipping address to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| send\_phone\_number\_to\_provider | Boolean | Optional | Pass _True_ if the user's phone number should be sent to the provider. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| send\_email\_to\_provider | Boolean | Optional | Pass _True_ if the user's email address should be sent to the provider. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| is\_flexible | Boolean | Optional | Pass _True_ if the final price depends on the shipping method. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| suggested\_post\_parameters | [SuggestedPostParameters](#suggestedpostparameters) | Optional | A JSON-serialized object containing the parameters of the suggested post to send; for direct messages chats only. If the message is sent as a reply to another suggested post, then that suggested post is automatically declined. |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for an inline keyboard. If empty, one 'Pay `total price`' button will be shown. If not empty, the first button must be a Pay button. |

#### createInvoiceLink

Use this method to create a link for an invoice. Returns the created invoice link as _String_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the link will be created. For payments in [Telegram Stars](https://t.me/BotNews/90) only. |
| title | String | Yes | Product name, 1-32 characters |
| description | String | Yes | Product description, 1-255 characters |
| payload | String | Yes | Bot-defined invoice payload, 1-128 bytes. This will not be displayed to the user, use it for your internal processes. |
| provider\_token | String | Optional | Payment provider token, obtained via [@BotFather](https://t.me/botfather). Pass an empty string for payments in [Telegram Stars](https://t.me/BotNews/90). |
| currency | String | Yes | Three-letter ISO 4217 currency code, see [more on currencies](https://core.telegram.org/bots/payments#supported-currencies). Pass “XTR” for payments in [Telegram Stars](https://t.me/BotNews/90). |
| prices | Array of [LabeledPrice](#labeledprice) | Yes | Price breakdown, a JSON-serialized list of components (e.g. product price, tax, discount, delivery cost, delivery tax, bonus, etc.). Must contain exactly one item for payments in [Telegram Stars](https://t.me/BotNews/90). |
| subscription\_period | Integer | Optional | The number of seconds the subscription will be active for before the next payment. The currency must be set to “XTR” (Telegram Stars) if the parameter is used. Currently, it must always be 2592000 (30 days) if specified. Any number of subscriptions can be active for a given bot at the same time, including multiple concurrent subscriptions from the same user. Subscription price must no exceed 10000 Telegram Stars. |
| max\_tip\_amount | Integer | Optional | The maximum accepted amount for tips in the _smallest units_ of the currency (integer, **not** float/double). For example, for a maximum tip of `US$ 1.45` pass `max_tip_amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). Defaults to 0. Not supported for payments in [Telegram Stars](https://t.me/BotNews/90). |
| suggested\_tip\_amounts | Array of Integer | Optional | A JSON-serialized array of suggested amounts of tips in the _smallest units_ of the currency (integer, **not** float/double). At most 4 suggested tip amounts can be specified. The suggested tip amounts must be positive, passed in a strictly increased order and must not exceed _max\_tip\_amount_. |
| provider\_data | String | Optional | JSON-serialized data about the invoice, which will be shared with the payment provider. A detailed description of required fields should be provided by the payment provider. |
| photo\_url | String | Optional | URL of the product photo for the invoice. Can be a photo of the goods or a marketing image for a service. |
| photo\_size | Integer | Optional | Photo size in bytes |
| photo\_width | Integer | Optional | Photo width |
| photo\_height | Integer | Optional | Photo height |
| need\_name | Boolean | Optional | Pass _True_ if you require the user's full name to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_phone\_number | Boolean | Optional | Pass _True_ if you require the user's phone number to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_email | Boolean | Optional | Pass _True_ if you require the user's email address to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| need\_shipping\_address | Boolean | Optional | Pass _True_ if you require the user's shipping address to complete the order. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| send\_phone\_number\_to\_provider | Boolean | Optional | Pass _True_ if the user's phone number should be sent to the provider. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| send\_email\_to\_provider | Boolean | Optional | Pass _True_ if the user's email address should be sent to the provider. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |
| is\_flexible | Boolean | Optional | Pass _True_ if the final price depends on the shipping method. Ignored for payments in [Telegram Stars](https://t.me/BotNews/90). |

#### answerShippingQuery

If you sent an invoice requesting a shipping address and the parameter _is\_flexible_ was specified, the Bot API will send an [Update](#update) with a _shipping\_query_ field to the bot. Use this method to reply to shipping queries. On success, _True_ is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| shipping\_query\_id | String | Yes | Unique identifier for the query to be answered |
| ok  | Boolean | Yes | Pass _True_ if delivery to the specified address is possible and _False_ if there are any problems (for example, if delivery to the specified address is not possible) |
| shipping\_options | Array of [ShippingOption](#shippingoption) | Optional | Required if _ok_ is _True_. A JSON-serialized array of available shipping options. |
| error\_message | String | Optional | Required if _ok_ is _False_. Error message in human readable form that explains why it is impossible to complete the order (e.g. “Sorry, delivery to your desired address is unavailable”). Telegram will display this message to the user. |

#### answerPreCheckoutQuery

Once the user has confirmed their payment and shipping details, the Bot API sends the final confirmation in the form of an [Update](#update) with the field _pre\_checkout\_query_. Use this method to respond to such pre-checkout queries. On success, _True_ is returned. **Note:** The Bot API must receive an answer within 10 seconds after the pre-checkout query was sent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| pre\_checkout\_query\_id | String | Yes | Unique identifier for the query to be answered |
| ok  | Boolean | Yes | Specify _True_ if everything is alright (goods are available, etc.) and the bot is ready to proceed with the order. Use _False_ if there are any problems. |
| error\_message | String | Optional | Required if _ok_ is _False_. Error message in human readable form that explains the reason for failure to proceed with the checkout (e.g. "Sorry, somebody just bought the last of our amazing black T-shirts while you were busy filling out your payment details. Please choose a different color or garment!"). Telegram will display this message to the user. |

#### getMyStarBalance

A method to get the current Telegram Stars balance of the bot. Requires no parameters. On success, returns a [StarAmount](#staramount) object.

#### getStarTransactions

Returns the bot's Telegram Star transactions in chronological order. On success, returns a [StarTransactions](#startransactions) object.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| offset | Integer | Optional | Number of transactions to skip in the response |
| limit | Integer | Optional | The maximum number of transactions to be retrieved. Values between 1-100 are accepted. Defaults to 100. |

#### refundStarPayment

Refunds a successful payment in [Telegram Stars](https://t.me/BotNews/90). Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Identifier of the user whose payment will be refunded |
| telegram\_payment\_charge\_id | String | Yes | Telegram payment identifier |

#### editUserStarSubscription

Allows the bot to cancel or re-enable extension of a subscription paid in Telegram Stars. Returns _True_ on success.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Identifier of the user whose subscription will be edited |
| telegram\_payment\_charge\_id | String | Yes | Telegram payment identifier for the subscription |
| is\_canceled | Boolean | Yes | Pass _True_ to cancel extension of the user subscription; the subscription must be active up to the end of the current subscription period. Pass _False_ to allow the user to re-enable a subscription that was previously canceled by the bot. |

#### LabeledPrice

This object represents a portion of the price for goods or services.

| Field | Type | Description |
| --- | --- | --- |
| label | String | Portion label |
| amount | Integer | Price of the product in the _smallest units_ of the [currency](https://core.telegram.org/bots/payments#supported-currencies) (integer, **not** float/double). For example, for a price of `US$ 1.45` pass `amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). |

#### Invoice

This object contains basic information about an invoice.

| Field | Type | Description |
| --- | --- | --- |
| title | String | Product name |
| description | String | Product description |
| start\_parameter | String | Unique bot deep-linking parameter that can be used to generate this invoice |
| currency | String | Three-letter ISO 4217 [currency](https://core.telegram.org/bots/payments#supported-currencies) code, or “XTR” for payments in [Telegram Stars](https://t.me/BotNews/90) |
| total\_amount | Integer | Total price in the _smallest units_ of the currency (integer, **not** float/double). For example, for a price of `US$ 1.45` pass `amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). |

#### ShippingAddress

This object represents a shipping address.

| Field | Type | Description |
| --- | --- | --- |
| country\_code | String | Two-letter [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) country code |
| state | String | State, if applicable |
| city | String | City |
| street\_line1 | String | First line for the address |
| street\_line2 | String | Second line for the address |
| post\_code | String | Address post code |

#### OrderInfo

This object represents information about an order.

| Field | Type | Description |
| --- | --- | --- |
| name | String | _Optional_. User name |
| phone\_number | String | _Optional_. User's phone number |
| email | String | _Optional_. User email |
| shipping\_address | [ShippingAddress](#shippingaddress) | _Optional_. User shipping address |

#### ShippingOption

This object represents one shipping option.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Shipping option identifier |
| title | String | Option title |
| prices | Array of [LabeledPrice](#labeledprice) | List of price portions |

#### SuccessfulPayment

This object contains basic information about a successful payment. Note that if the buyer initiates a chargeback with the relevant payment provider following this transaction, the funds may be debited from your balance. This is outside of Telegram's control.

| Field | Type | Description |
| --- | --- | --- |
| currency | String | Three-letter ISO 4217 [currency](https://core.telegram.org/bots/payments#supported-currencies) code, or “XTR” for payments in [Telegram Stars](https://t.me/BotNews/90) |
| total\_amount | Integer | Total price in the _smallest units_ of the currency (integer, **not** float/double). For example, for a price of `US$ 1.45` pass `amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). |
| invoice\_payload | String | Bot-specified invoice payload |
| subscription\_expiration\_date | Integer | _Optional_. Expiration date of the subscription, in Unix time; for recurring payments only |
| is\_recurring | True | _Optional_. _True_, if the payment is a recurring payment for a subscription |
| is\_first\_recurring | True | _Optional_. _True_, if the payment is the first payment for a subscription |
| shipping\_option\_id | String | _Optional_. Identifier of the shipping option chosen by the user |
| order\_info | [OrderInfo](#orderinfo) | _Optional_. Order information provided by the user |
| telegram\_payment\_charge\_id | String | Telegram payment identifier |
| provider\_payment\_charge\_id | String | Provider payment identifier |

#### RefundedPayment

This object contains basic information about a refunded payment.

| Field | Type | Description |
| --- | --- | --- |
| currency | String | Three-letter ISO 4217 [currency](https://core.telegram.org/bots/payments#supported-currencies) code, or “XTR” for payments in [Telegram Stars](https://t.me/BotNews/90). Currently, always “XTR”. |
| total\_amount | Integer | Total refunded price in the _smallest units_ of the currency (integer, **not** float/double). For example, for a price of `US$ 1.45`, `total_amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). |
| invoice\_payload | String | Bot-specified invoice payload |
| telegram\_payment\_charge\_id | String | Telegram payment identifier |
| provider\_payment\_charge\_id | String | _Optional_. Provider payment identifier |

#### ShippingQuery

This object contains information about an incoming shipping query.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique query identifier |
| from | [User](#user) | User who sent the query |
| invoice\_payload | String | Bot-specified invoice payload |
| shipping\_address | [ShippingAddress](#shippingaddress) | User specified shipping address |

#### PreCheckoutQuery

This object contains information about an incoming pre-checkout query.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique query identifier |
| from | [User](#user) | User who sent the query |
| currency | String | Three-letter ISO 4217 [currency](https://core.telegram.org/bots/payments#supported-currencies) code, or “XTR” for payments in [Telegram Stars](https://t.me/BotNews/90) |
| total\_amount | Integer | Total price in the _smallest units_ of the currency (integer, **not** float/double). For example, for a price of `US$ 1.45` pass `amount = 145`. See the _exp_ parameter in [currencies.json](https://core.telegram.org/bots/payments/currencies.json), it shows the number of digits past the decimal point for each currency (2 for the majority of currencies). |
| invoice\_payload | String | Bot-specified invoice payload |
| shipping\_option\_id | String | _Optional_. Identifier of the shipping option chosen by the user |
| order\_info | [OrderInfo](#orderinfo) | _Optional_. Order information provided by the user |

#### PaidMediaPurchased

This object contains information about a paid media purchase.

| Field | Type | Description |
| --- | --- | --- |
| from | [User](#user) | User who purchased the media |
| paid\_media\_payload | String | Bot-specified paid media payload |

#### RevenueWithdrawalState

This object describes the state of a revenue withdrawal operation. Currently, it can be one of

- [RevenueWithdrawalStatePending](#revenuewithdrawalstatepending)
- [RevenueWithdrawalStateSucceeded](#revenuewithdrawalstatesucceeded)
- [RevenueWithdrawalStateFailed](#revenuewithdrawalstatefailed)

#### RevenueWithdrawalStatePending

The withdrawal is in progress.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the state, always “pending” |

#### RevenueWithdrawalStateSucceeded

The withdrawal succeeded.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the state, always “succeeded” |
| date | Integer | Date the withdrawal was completed in Unix time |
| url | String | An HTTPS URL that can be used to see transaction details |

#### RevenueWithdrawalStateFailed

The withdrawal failed and the transaction was refunded.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the state, always “failed” |

#### AffiliateInfo

Contains information about the affiliate that received a commission via this transaction.

| Field | Type | Description |
| --- | --- | --- |
| affiliate\_user | [User](#user) | _Optional_. The bot or the user that received an affiliate commission if it was received by a bot or a user |
| affiliate\_chat | [Chat](#chat) | _Optional_. The chat that received an affiliate commission if it was received by a chat |
| commission\_per\_mille | Integer | The number of Telegram Stars received by the affiliate for each 1000 Telegram Stars received by the bot from referred users |
| amount | Integer | Integer amount of Telegram Stars received by the affiliate from the transaction, rounded to 0; can be negative for refunds |
| nanostar\_amount | Integer | _Optional_. The number of 1/1000000000 shares of Telegram Stars received by the affiliate; from -999999999 to 999999999; can be negative for refunds |

#### TransactionPartner

This object describes the source of a transaction, or its recipient for outgoing transactions. Currently, it can be one of

- [TransactionPartnerUser](#transactionpartneruser)
- [TransactionPartnerChat](#transactionpartnerchat)
- [TransactionPartnerAffiliateProgram](#transactionpartneraffiliateprogram)
- [TransactionPartnerFragment](#transactionpartnerfragment)
- [TransactionPartnerTelegramAds](#transactionpartnertelegramads)
- [TransactionPartnerTelegramApi](#transactionpartnertelegramapi)
- [TransactionPartnerOther](#transactionpartnerother)

#### TransactionPartnerUser

Describes a transaction with a user.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the transaction partner, always “user” |
| transaction\_type | String | Type of the transaction, currently one of “invoice\_payment” for payments via invoices, “paid\_media\_payment” for payments for paid media, “gift\_purchase” for gifts sent by the bot, “premium\_purchase” for Telegram Premium subscriptions gifted by the bot, “business\_account\_transfer” for direct transfers from managed business accounts |
| user | [User](#user) | Information about the user |
| affiliate | [AffiliateInfo](#affiliateinfo) | _Optional_. Information about the affiliate that received a commission via this transaction. Can be available only for “invoice\_payment” and “paid\_media\_payment” transactions. |
| invoice\_payload | String | _Optional_. Bot-specified invoice payload. Can be available only for “invoice\_payment” transactions. |
| subscription\_period | Integer | _Optional_. The duration of the paid subscription. Can be available only for “invoice\_payment” transactions. |
| paid\_media | Array of [PaidMedia](#paidmedia) | _Optional_. Information about the paid media bought by the user; for “paid\_media\_payment” transactions only |
| paid\_media\_payload | String | _Optional_. Bot-specified paid media payload. Can be available only for “paid\_media\_payment” transactions. |
| gift | [Gift](#gift) | _Optional_. The gift sent to the user by the bot; for “gift\_purchase” transactions only |
| premium\_subscription\_duration | Integer | _Optional_. Number of months the gifted Telegram Premium subscription will be active for; for “premium\_purchase” transactions only |

#### TransactionPartnerChat

Describes a transaction with a chat.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the transaction partner, always “chat” |
| chat | [Chat](#chat) | Information about the chat |
| gift | [Gift](#gift) | _Optional_. The gift sent to the chat by the bot |

#### TransactionPartnerAffiliateProgram

Describes the affiliate program that issued the affiliate commission received via this transaction.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the transaction partner, always “affiliate\_program” |
| sponsor\_user | [User](#user) | _Optional_. Information about the bot that sponsored the affiliate program |
| commission\_per\_mille | Integer | The number of Telegram Stars received by the bot for each 1000 Telegram Stars received by the affiliate program sponsor from referred users |

#### TransactionPartnerFragment

Describes a withdrawal transaction with Fragment.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the transaction partner, always “fragment” |
| withdrawal\_state | [RevenueWithdrawalState](#revenuewithdrawalstate) | _Optional_. State of the transaction if the transaction is outgoing |

#### TransactionPartnerTelegramAds

Describes a withdrawal transaction to the Telegram Ads platform.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the transaction partner, always “telegram\_ads” |

#### TransactionPartnerTelegramApi

Describes a transaction with payment for [paid broadcasting](#paid-broadcasts).

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the transaction partner, always “telegram\_api” |
| request\_count | Integer | The number of successful requests that exceeded regular limits and were therefore billed |

#### TransactionPartnerOther

Describes a transaction with an unknown source or recipient.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Type of the transaction partner, always “other” |

#### StarTransaction

Describes a Telegram Star transaction. Note that if the buyer initiates a chargeback with the payment provider from whom they acquired Stars (e.g., Apple, Google) following this transaction, the refunded Stars will be deducted from the bot's balance. This is outside of Telegram's control.

| Field | Type | Description |
| --- | --- | --- |
| id  | String | Unique identifier of the transaction. Coincides with the identifier of the original transaction for refund transactions. Coincides with _SuccessfulPayment.telegram\_payment\_charge\_id_ for successful incoming payments from users. |
| amount | Integer | Integer amount of Telegram Stars transferred by the transaction |
| nanostar\_amount | Integer | _Optional_. The number of 1/1000000000 shares of Telegram Stars transferred by the transaction; from 0 to 999999999 |
| date | Integer | Date the transaction was created in Unix time |
| source | [TransactionPartner](#transactionpartner) | _Optional_. Source of an incoming transaction (e.g., a user purchasing goods or services, Fragment refunding a failed withdrawal). Only for incoming transactions. |
| receiver | [TransactionPartner](#transactionpartner) | _Optional_. Receiver of an outgoing transaction (e.g., a user for a purchase refund, Fragment for a withdrawal). Only for outgoing transactions. |

#### StarTransactions

Contains a list of Telegram Star transactions.

| Field | Type | Description |
| --- | --- | --- |
| transactions | Array of [StarTransaction](#startransaction) | The list of transactions |

### Telegram Passport

**Telegram Passport** is a unified authorization method for services that require personal identification. Users can upload their documents once, then instantly share their data with services that require real-world ID (finance, ICOs, etc.). Please see the [manual](https://core.telegram.org/passport) for details.

#### PassportData

Describes Telegram Passport data shared with the bot by the user.

| Field | Type | Description |
| --- | --- | --- |
| data | Array of [EncryptedPassportElement](#encryptedpassportelement) | Array with information about documents and other Telegram Passport elements that was shared with the bot |
| credentials | [EncryptedCredentials](#encryptedcredentials) | Encrypted credentials required to decrypt the data |

#### PassportFile

This object represents a file uploaded to Telegram Passport. Currently all Telegram Passport files are in JPEG format when decrypted and don't exceed 10MB.

| Field | Type | Description |
| --- | --- | --- |
| file\_id | String | Identifier for this file, which can be used to download or reuse the file |
| file\_unique\_id | String | Unique identifier for this file, which is supposed to be the same over time and for different bots. Can't be used to download or reuse the file. |
| file\_size | Integer | File size in bytes |
| file\_date | Integer | Unix time when the file was uploaded |

#### EncryptedPassportElement

Describes documents or other Telegram Passport elements shared with the bot by the user.

| Field | Type | Description |
| --- | --- | --- |
| type | String | Element type. One of “personal\_details”, “passport”, “driver\_license”, “identity\_card”, “internal\_passport”, “address”, “utility\_bill”, “bank\_statement”, “rental\_agreement”, “passport\_registration”, “temporary\_registration”, “phone\_number”, “email”. |
| data | String | _Optional_. Base64-encoded encrypted Telegram Passport element data provided by the user; available only for “personal\_details”, “passport”, “driver\_license”, “identity\_card”, “internal\_passport” and “address” types. Can be decrypted and verified using the accompanying [EncryptedCredentials](#encryptedcredentials). |
| phone\_number | String | _Optional_. User's verified phone number; available only for “phone\_number” type |
| email | String | _Optional_. User's verified email address; available only for “email” type |
| files | Array of [PassportFile](#passportfile) | _Optional_. Array of encrypted files with documents provided by the user; available only for “utility\_bill”, “bank\_statement”, “rental\_agreement”, “passport\_registration” and “temporary\_registration” types. Files can be decrypted and verified using the accompanying [EncryptedCredentials](#encryptedcredentials). |
| front\_side | [PassportFile](#passportfile) | _Optional_. Encrypted file with the front side of the document, provided by the user; available only for “passport”, “driver\_license”, “identity\_card” and “internal\_passport”. The file can be decrypted and verified using the accompanying [EncryptedCredentials](#encryptedcredentials). |
| reverse\_side | [PassportFile](#passportfile) | _Optional_. Encrypted file with the reverse side of the document, provided by the user; available only for “driver\_license” and “identity\_card”. The file can be decrypted and verified using the accompanying [EncryptedCredentials](#encryptedcredentials). |
| selfie | [PassportFile](#passportfile) | _Optional_. Encrypted file with the selfie of the user holding a document, provided by the user; available if requested for “passport”, “driver\_license”, “identity\_card” and “internal\_passport”. The file can be decrypted and verified using the accompanying [EncryptedCredentials](#encryptedcredentials). |
| translation | Array of [PassportFile](#passportfile) | _Optional_. Array of encrypted files with translated versions of documents provided by the user; available if requested for “passport”, “driver\_license”, “identity\_card”, “internal\_passport”, “utility\_bill”, “bank\_statement”, “rental\_agreement”, “passport\_registration” and “temporary\_registration” types. Files can be decrypted and verified using the accompanying [EncryptedCredentials](#encryptedcredentials). |
| hash | String | Base64-encoded element hash for using in [PassportElementErrorUnspecified](#passportelementerrorunspecified) |

#### EncryptedCredentials

Describes data required for decrypting and authenticating [EncryptedPassportElement](#encryptedpassportelement). See the [Telegram Passport Documentation](https://core.telegram.org/passport#receiving-information) for a complete description of the data decryption and authentication processes.

| Field | Type | Description |
| --- | --- | --- |
| data | String | Base64-encoded encrypted JSON-serialized data with unique user's payload, data hashes and secrets required for [EncryptedPassportElement](#encryptedpassportelement) decryption and authentication |
| hash | String | Base64-encoded data hash for data authentication |
| secret | String | Base64-encoded secret, encrypted with the bot's public RSA key, required for data decryption |

#### setPassportDataErrors

Informs a user that some of the Telegram Passport elements they provided contains errors. The user will not be able to re-submit their Passport to you until the errors are fixed (the contents of the field for which you returned the error must change). Returns _True_ on success.

Use this if the data submitted by the user doesn't satisfy the standards your service requires for any reason. For example, if a birthday date seems invalid, a submitted document is blurry, a scan shows evidence of tampering, etc. Supply some details in the error message to make sure the user knows how to correct the issues.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier |
| errors | Array of [PassportElementError](#passportelementerror) | Yes | A JSON-serialized array describing the errors |

#### PassportElementError

This object represents an error in the Telegram Passport element which was submitted that should be resolved by the user. It should be one of:

- [PassportElementErrorDataField](#passportelementerrordatafield)
- [PassportElementErrorFrontSide](#passportelementerrorfrontside)
- [PassportElementErrorReverseSide](#passportelementerrorreverseside)
- [PassportElementErrorSelfie](#passportelementerrorselfie)
- [PassportElementErrorFile](#passportelementerrorfile)
- [PassportElementErrorFiles](#passportelementerrorfiles)
- [PassportElementErrorTranslationFile](#passportelementerrortranslationfile)
- [PassportElementErrorTranslationFiles](#passportelementerrortranslationfiles)
- [PassportElementErrorUnspecified](#passportelementerrorunspecified)

#### PassportElementErrorDataField

Represents an issue in one of the data fields that was provided by the user. The error is considered resolved when the field's value changes.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _data_ |
| type | String | The section of the user's Telegram Passport which has the error, one of “personal\_details”, “passport”, “driver\_license”, “identity\_card”, “internal\_passport”, “address” |
| field\_name | String | Name of the data field which has the error |
| data\_hash | String | Base64-encoded data hash |
| message | String | Error message |

#### PassportElementErrorFrontSide

Represents an issue with the front side of a document. The error is considered resolved when the file with the front side of the document changes.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _front\_side_ |
| type | String | The section of the user's Telegram Passport which has the issue, one of “passport”, “driver\_license”, “identity\_card”, “internal\_passport” |
| file\_hash | String | Base64-encoded hash of the file with the front side of the document |
| message | String | Error message |

#### PassportElementErrorReverseSide

Represents an issue with the reverse side of a document. The error is considered resolved when the file with reverse side of the document changes.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _reverse\_side_ |
| type | String | The section of the user's Telegram Passport which has the issue, one of “driver\_license”, “identity\_card” |
| file\_hash | String | Base64-encoded hash of the file with the reverse side of the document |
| message | String | Error message |

#### PassportElementErrorSelfie

Represents an issue with the selfie with a document. The error is considered resolved when the file with the selfie changes.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _selfie_ |
| type | String | The section of the user's Telegram Passport which has the issue, one of “passport”, “driver\_license”, “identity\_card”, “internal\_passport” |
| file\_hash | String | Base64-encoded hash of the file with the selfie |
| message | String | Error message |

#### PassportElementErrorFile

Represents an issue with a document scan. The error is considered resolved when the file with the document scan changes.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _file_ |
| type | String | The section of the user's Telegram Passport which has the issue, one of “utility\_bill”, “bank\_statement”, “rental\_agreement”, “passport\_registration”, “temporary\_registration” |
| file\_hash | String | Base64-encoded file hash |
| message | String | Error message |

#### PassportElementErrorFiles

Represents an issue with a list of scans. The error is considered resolved when the list of files containing the scans changes.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _files_ |
| type | String | The section of the user's Telegram Passport which has the issue, one of “utility\_bill”, “bank\_statement”, “rental\_agreement”, “passport\_registration”, “temporary\_registration” |
| file\_hashes | Array of String | List of base64-encoded file hashes |
| message | String | Error message |

#### PassportElementErrorTranslationFile

Represents an issue with one of the files that constitute the translation of a document. The error is considered resolved when the file changes.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _translation\_file_ |
| type | String | Type of element of the user's Telegram Passport which has the issue, one of “passport”, “driver\_license”, “identity\_card”, “internal\_passport”, “utility\_bill”, “bank\_statement”, “rental\_agreement”, “passport\_registration”, “temporary\_registration” |
| file\_hash | String | Base64-encoded file hash |
| message | String | Error message |

#### PassportElementErrorTranslationFiles

Represents an issue with the translated version of a document. The error is considered resolved when a file with the document translation change.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _translation\_files_ |
| type | String | Type of element of the user's Telegram Passport which has the issue, one of “passport”, “driver\_license”, “identity\_card”, “internal\_passport”, “utility\_bill”, “bank\_statement”, “rental\_agreement”, “passport\_registration”, “temporary\_registration” |
| file\_hashes | Array of String | List of base64-encoded file hashes |
| message | String | Error message |

#### PassportElementErrorUnspecified

Represents an issue in an unspecified place. The error is considered resolved when new data is added.

| Field | Type | Description |
| --- | --- | --- |
| source | String | Error source, must be _unspecified_ |
| type | String | Type of element of the user's Telegram Passport which has the issue |
| element\_hash | String | Base64-encoded element hash |
| message | String | Error message |

### Games

Your bot can offer users **HTML5 games** to play solo or to compete against each other in groups and one-on-one chats. Create games via [@BotFather](https://t.me/botfather) using the _/newgame_ command. Please note that this kind of power requires responsibility: you will need to accept the terms for each game that your bots will be offering.

- Games are a new type of content on Telegram, represented by the [Game](#game) and [InlineQueryResultGame](#inlinequeryresultgame) objects.
- Once you've created a game via [BotFather](https://t.me/botfather), you can send games to chats as regular messages using the [sendGame](#sendgame) method, or use [inline mode](#inline-mode) with [InlineQueryResultGame](#inlinequeryresultgame).
- If you send the game message without any buttons, it will automatically have a 'Play _GameName_' button. When this button is pressed, your bot gets a [CallbackQuery](#callbackquery) with the _game\_short\_name_ of the requested game. You provide the correct URL for this particular user and the app opens the game in the in-app browser.
- You can manually add multiple buttons to your game message. Please note that the first button in the first row **must always** launch the game, using the field _callback\_game_ in [InlineKeyboardButton](#inlinekeyboardbutton). You can add extra buttons according to taste: e.g., for a description of the rules, or to open the game's official community.
- To make your game more attractive, you can upload a GIF animation that demonstrates the game to the users via [BotFather](https://t.me/botfather) (see [Lumberjack](https://t.me/gamebot?game=lumberjack) for example).
- A game message will also display high scores for the current chat. Use [setGameScore](#setgamescore) to post high scores to the chat with the game, add the _disable\_edit\_message_ parameter to disable automatic update of the message with the current scoreboard.
- Use [getGameHighScores](#getgamehighscores) to get data for in-game high score tables.
- You can also add an extra [sharing button](https://core.telegram.org/bots/games#sharing-your-game-to-telegram-chats) for users to share their best score to different chats.
- For examples of what can be done using this new stuff, check the [@gamebot](https://t.me/gamebot) and [@gamee](https://t.me/gamee) bots.

#### sendGame

Use this method to send a game. On success, the sent [Message](#message) is returned.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| business\_connection\_id | String | Optional | Unique identifier of the business connection on behalf of which the message will be sent |
| chat\_id | Integer or String | Yes | Unique identifier for the target chat or username of the target bot in the format `@username`. Games can't be sent to channel direct messages chats and channel chats. |
| message\_thread\_id | Integer | Optional | Unique identifier for the target message thread (topic) of a forum; for forum supergroups and private chats of bots with forum topic mode enabled only |
| game\_short\_name | String | Yes | Short name of the game, serves as the unique identifier for the game. Set up your games via [@BotFather](https://t.me/botfather). |
| disable\_notification | Boolean | Optional | Sends the message [silently](https://telegram.org/blog/channels-2-0#silent-messages). Users will receive a notification with no sound. |
| protect\_content | Boolean | Optional | Protects the contents of the sent message from forwarding and saving |
| allow\_paid\_broadcast | Boolean | Optional | Pass _True_ to allow up to 1000 messages per second, ignoring [broadcasting limits](https://core.telegram.org/bots/faq#how-can-i-message-all-of-my-bot-39s-subscribers-at-once) for a fee of 0.1 Telegram Stars per message. The relevant Stars will be withdrawn from the bot's balance. |
| message\_effect\_id | String | Optional | Unique identifier of the message effect to be added to the message; for private chats only |
| reply\_parameters | [ReplyParameters](#replyparameters) | Optional | Description of the message to reply to |
| reply\_markup | [InlineKeyboardMarkup](#inlinekeyboardmarkup) | Optional | A JSON-serialized object for an inline keyboard. If empty, one 'Play game\_title' button will be shown. If not empty, the first button must launch the game. |

#### Game

This object represents a game. Use BotFather to create and edit games, their short names will act as unique identifiers.

| Field | Type | Description |
| --- | --- | --- |
| title | String | Title of the game |
| description | String | Description of the game |
| photo | Array of [PhotoSize](#photosize) | Photo that will be displayed in the game message in chats |
| text | String | _Optional_. Brief description of the game or high scores included in the game message. Can be automatically edited to include current high scores for the game when the bot calls [setGameScore](#setgamescore), or manually edited using [editMessageText](#editmessagetext). 0-4096 characters. |
| text\_entities | Array of [MessageEntity](#messageentity) | _Optional_. Special entities that appear in _text_, such as usernames, URLs, bot commands, etc. |
| animation | [Animation](#animation) | _Optional_. Animation that will be displayed in the game message in chats. Upload via [BotFather](https://t.me/botfather). |

#### CallbackGame

A placeholder, currently holds no information. Use [BotFather](https://t.me/botfather) to set up your game.

#### setGameScore

Use this method to set the score of the specified user in a game message. On success, if the message is not an inline message, the [Message](#message) is returned, otherwise _True_ is returned. Returns an error, if the new score is not greater than the user's current score in the chat and _force_ is _False_.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | User identifier |
| score | Integer | Yes | New score, must be non-negative |
| force | Boolean | Optional | Pass _True_ if the high score is allowed to decrease. This can be useful when fixing mistakes or banning cheaters. |
| disable\_edit\_message | Boolean | Optional | Pass _True_ if the game message should not be automatically edited to include the current scoreboard |
| chat\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the sent message. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |

#### getGameHighScores

Use this method to get data for high score tables. Will return the score of the specified user and several of their neighbors in a game. Returns an Array of [GameHighScore](#gamehighscore) objects.

> This method will currently return scores for the target user, plus two of their closest neighbors on each side. Will also return the top three users if the user and their neighbors are not among them. Please note that this behavior is subject to change.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| user\_id | Integer | Yes | Target user id |
| chat\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Unique identifier for the target chat. |
| message\_id | Integer | Optional | Required if _inline\_message\_id_ is not specified. Identifier of the sent message. |
| inline\_message\_id | String | Optional | Required if _chat\_id_ and _message\_id_ are not specified. Identifier of the inline message. |

#### GameHighScore

This object represents one row of the high scores table for a game.

| Field | Type | Description |
| --- | --- | --- |
| position | Integer | Position in high score table for the game |
| user | [User](#user) | User |
| score | Integer | Score |
