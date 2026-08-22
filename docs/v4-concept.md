# Quniverse V4 — Concept: Entity, Content, Capabilities, Slots

This document is the successor to `docs/v3-architecture-spec.md` and
`docs/v3-technical-concept.md` for the next generation of Quniverse. It does **not**
propose a rewrite. QuV3's Core (`@qu/core`), identity, sync and the Engine/Service split
already hold up; the app/UI layer already has a working Slot and App-Template mechanism.
What V4 adds is one missing layer — a generic **Entity + Content + Capability** model — and
uses it to turn Forum/Chat/Blog/CMS/Notifications from separately-built apps into
compositions of the same small parts, exactly as `docs/v3-technical-concept.md` §4.1's own
"one primitive per problem" principle already argues.

Where this document says "keep", "introduce", or "reconcile", that is a decision, not an
option to weigh later — matching this repo's existing style of writing design docs as
binding constraints (see `v3-technical-concept.md` §0).

## 0. The one sentence this document exists to justify

> **Data is composed from Entity + Content + Capabilities. Behavior is capability-based.
> Presentation is template- and slot-based. Apps declare intent; the Shell and Templates
> decide presentation.**

Every section below either grounds one clause of that sentence in code that already
exists, or specifies the small amount of new code needed to make it fully true.

### 0.1 What's already real (keep, cite, build on)

| Already real | File | What it proves |
|---|---|---|
| Slots (UI + data) | `packages/foundation/src/extension-points.js` (`ExtensionPointHost`), `packages/foundation/src/actions.js` (`actionsForSlot`/`resolveActionHref`) | A working, two-tier slot mechanism (live code via `contributes`, pure data via `actions`) already exists and is app-agnostic. |
| Apps declare intent, template decides presentation | `packages/ui/src/app-template.js` (`mountAppTemplate`) | An app hands over `{navigation, views, settings, primaryAction, render}`; the function alone decides sidebar-vs-bottom-bar-vs-FAB layout per viewport. |
| One primitive, many thin named wrappers | `packages/services/src/flag-service.js` (`FlagService`) → `BookmarksService`, `FavoritesService`, `ContactsService` | Exactly the "Capability" composition pattern V4 generalizes — already proven for one capability (flagging). |
| Config, not code, differentiates apps | `packages/services/src/message-service.js`'s `THREAD_PRESETS` (forum/chat/group/mail/notifications/activity) | Forum, Chat, Mail-inbox and Notifications are already one mechanism (`MessageService` + `ThreadEngine`) differing only in config — the exact outcome the brainstorming's "Thread → Topic + Comments + Features" section was reaching for. |
| Shared composer plugins across apps | `packages/thread-ui/src/{emoji,mention-autocomplete,composer-autogrow}.js`, used by Chat/Forum/Profile/Todo/GeoChase/Reactions | The "Editor Extension" idea already has a working precedent, just not yet formalized as a contract or extended past Thread messages. |
| Real attachments | `packages/engines/src/asset-engine.js`, `packages/services/src/asset-service.js` | Attachment is not a brainstorming aspiration, it's a shipped, chunked/resumable/dedup engine already usable by any Content. |

### 0.2 What's decided against, on the record (reconcile, don't reintroduce)

- **No "one Engine per capability."** `docs/v3-technical-concept.md` §4.1 already states
  that no new storage-pipeline Engine should be introduced for a text/formatting/UI-transform
  concern — those belong at the Service layer. QuV2's monolithic 778-line `ThreadService`
  was *already* split, in V3, into `MessageService` / `ReactionService` / `PinService` /
  `PresenceService` (`docs/v3-technical-concept.md` §4.3). So the brainstorming's "don't keep
  ThreadEngine monolithic, split into TopicEngine/CommentEngine/ReactionEngine/..." is a
  problem this codebase already solved — but the solution is **Services**, not **Engines**,
  in this codebase's vocabulary. V4 reuses that solved shape rather than re-solving it with
  a different, contradicting name for the same idea (see §2).
- **`registerCapability` in `packages/foundation/src/registry.js` has zero call sites today**
  (flagged as dead code in `v3-technical-concept.md` §2.2: "kept, `registerCapability` gets a
  real caller or gets cut"). V4's Capability layer (§3) is that real caller — this document
  resolves that open item rather than leaving it dangling or introducing a second, competing
  capability-registration mechanism.

### 0.3 What's a real, net-new gap (introduce)

- No generic `Entity`/`Content`/`EntityType` model. Every feature today reuses two generic
  storage shapes — "document" (`documentPath()`) and "derived/curated list"
  (`ListService.listDerived()`/`listCurated()`) — via the path conventions in
  `packages/services/src/paths.js`, but nothing named `Entity` or `Content` exists, so a
  Blog Article or CMS Page cannot yet be expressed the way a Forum Topic or Chat Message can.
- No `ContentEditor`/`ContentComposer`/`EditorExtension`/`ContentRenderer` contract. Today's
  formatting is a single bespoke module, `packages/services/src/thread-formatting.js` (a
  deliberately non-CommonMark regex markdown-lite renderer), applied only to Thread messages.
- No `Follow` capability, no `Tag` capability (hashtags are styled-only in
  `thread-formatting.js`, not linked/queryable), `Mention` is extraction-only (no
  routing/index).
- `app-template.js`'s `primaryAction` is a single static `{label, href, icon}` link — there is
  no resolver for "several candidate actions → FAB vs. expandable FAB vs. action sheet vs.
  toolbar," which the brainstorming's §17 ("Presentation Resolver") correctly identifies as
  missing.

## 1. Terminology — decided, not open

The brainstorming itself goes back and forth between "Topic," "Entry," and "Entity." This
section resolves each such back-and-forth as a decision, using whichever term is already
established in this codebase where one already is, so V4 vocabulary doesn't compete with
working code's own words for the same thing.

- **Thread** stays the name for the message/comment-bearing entity type. It is already
  established (`ThreadEngine`, `MessageService`, `THREAD_PRESETS`, `packages/thread-ui`) and
  already spans Forum/Chat/Notifications/Mail. Do **not** introduce a competing "Topic" —
  that would rename a concept that already works and is already documented across four
  docs and a dozen tests.
- **Entity** is introduced one level *below* Thread: the generic identifiable/persistable
  base every content-bearing thing composes from. A Thread *is* an Entity (with a
  Commentable capability built in by definition — a Thread without messages is just a
  Document). A Page, Article, Task, Event, or Notification *is* also an Entity. This
  matches the brainstorming's own conclusion in its "Entity vs Topic" section, adapted to
  this codebase's existing "Thread" name instead of inventing "Topic."
- **Content** is the universal persisted payload — `{ text, format, attachments[] }` today,
  `extensions[]` added only once a second real case needs it (see §4). Content is explicitly
  **not** the editor. `thread-formatting.js` is the existing, single-purpose precedent this
  generalizes away from — not deleted, but its markdown-lite renderer becomes one
  `ContentRenderer` implementation among others (see §5), and its `extractMentions` becomes
  the seed of a real `MentionEngine`... no — a real **Mention capability/Service** (see next
  bullet for why "Engine" is the wrong word here).
- **Engine** keeps its existing, narrow meaning: a trust-boundary `QuStore` pipeline
  participant registered via `qu.registerEngine({segment, order, put, get})` (see
  `packages/core/src/store.js`, and every existing Engine in `packages/engines/src/`). A
  new Engine is added only when a write genuinely needs a pipeline-level gate — e.g. a
  future `EntityEngine` stamping `_id`/`type` on generic entity writes, directly analogous
  to today's `DocumentEngine`/`ThreadEngine`. The brainstorming's `CommentEngine`,
  `ReactionEngine`, `FollowEngine`, `BookmarkEngine`, `MentionEngine`, `NotificationEngine`,
  `TagEngine` are **not** Engines in this codebase's sense — they are **Capabilities**,
  implemented as thin Services, exactly like `ReactionService`/`PinService`/`FlagService`
  already are. Calling them "Engines" would silently reintroduce the "one Engine per
  capability" sprawl §4.1 of `v3-technical-concept.md` already rejected, just with a V4
  document's authority behind it instead of a V2 mistake's.
- **Capability** (the brainstorming's "Feature") is the composition unit for optional
  behavior — Commentable, Reactable, Followable, Bookmarkable, Mentionable, Taggable,
  Attachable, Notifiable. Each is a thin Service over Entity, generalizing the
  `FlagService` → `BookmarksService`/`FavoritesService`/`ContactsService` wrapper pattern
  (§0.1) to the rest of this list.
- **Slot** and **Template** keep their existing meanings (`ExtensionPointHost`,
  `mountAppTemplate`). V4 extends the *set* of standardized slot points (§6); it does not
  replace or duplicate the mechanism.
- **CMS is an app, not a platform layer.** The brainstorming reaches this conclusion itself
  (§12/§19 of the brainstorming) and it is correct: once Entity + Content + EntityType exist,
  CMS is just an app that lets a user define EntityTypes and Pages through UI, the same way
  Forum is an app that composes Thread + Commentable + Reactable. No `CMSEngine` is ever
  introduced.

## 2. Engine vs. Service vs. Capability — one decision tree, not three vocabularies

To keep this unambiguous for anyone implementing against this document:

```
Does this write need a trust-boundary gate that must hold
no matter which caller invokes qu.put()/qu.get()?
  │
  ├── YES → it's an ENGINE (packages/engines), registered on QuStore's
  │         segment pipeline. Existing precedent: AccessEngine, DocumentEngine,
  │         ThreadEngine, CollectionEngine, AssetEngine. V4 adds at most one:
  │         a generic EntityEngine (stamps _id/type on entity writes) — see §3.
  │
  └── NO → is this a friendly API composing reads/writes/formatting/config
           around Engines and paths.js, callable by apps directly?
             │
             ├── Domain logic with real state machines/rules
             │   (Calendar, Task, Location/Game) → DOMAIN SERVICE
             │   (packages/services, kept as real fachliche logic —
             │    explicitly NOT flattened into generic Entity soup)
             │
             └── Optional behavior any Entity may or may not have
                 (comment, react, follow, bookmark, mention, tag,
                 notify, attach) → CAPABILITY, implemented as a thin
                 Service following the FlagService wrapper pattern
```

This directly answers the brainstorming's own §4/§20 worry about "engine sprawl": the
sprawl is avoided not by having fewer capabilities, but by keeping every capability a
Service, and reserving "Engine" for the one architectural question (pipeline trust
boundary) it actually answers in this codebase.

## 3. Layer 1 — Entity, Content, EntityType

### 3.1 Entity

The generic identifiable/persistable base:

```
Entity
├── id            // stable identifier, same convention as existing *Id params in paths.js
├── type           // e.g. "thread", "page", "article", "task", "event", "notification"
├── metadata       // author (pub), created, updated — same envelope fields QuBit already carries (ts, pub, sig)
└── fields         // type-specific structured data (e.g. Event.start/end/location, Task.status/dueDate)
```

An Entity is **not** a new storage shape competing with "document" or "derived list" — it is
a naming/typing convention layered on top of the existing `documentPath()`/list conventions
in `packages/services/src/paths.js`, the same way `ThreadEngine`'s message stamping is a thin
convention on top of the plain QuBit write pipeline.

**Resolved (Phase 1, implemented):** no new package — placement follows this codebase's own
Engine/Service split exactly, not a separate `packages/entity`. `EntityEngine`
(`packages/engines/src/entity-engine.js`) is a real `QuStore` pipeline Engine from day one
(see §10's superseded "conservative default" note): it stamps `_id`/`_created` exactly like
`DocumentEngine`, and additionally **requires `_type`** — the one field genuinely mandatory
for an Entity but optional for a plain Document, which is the concrete trust-boundary
justification for an Engine here rather than a Service-layer convention (§2's decision tree).
`@qu/engines`' `AccessEngine` gates an `entities` ACL kind the same way it already gates
`docs`/`collections`/`assets`/`threads`. `EntityService`/`entityPath()`
(`packages/services/src/entity-service.js`/`paths.js`) are the friendly API layer, the same
relationship `ChannelService`/`MessageService` have to `ThreadEngine`.

### 3.2 Content

The universal, persisted human-content payload:

```
Content
├── text
├── format          // "plain" | "markdown" | "richtext" | ...
├── attachments[]    // AssetEngine/AssetService references — already real, see §0.1
└── extensions[]     // added only once ≥2 real cases need it (see below)
```

Content is a **field** an EntityType may declare (see §3.3), not a wrapper around Entity.
A Thread's message, a Blog Article, a CMS Page, and a Chat message are all
"an Entity that has a `content` field" — they differ in which *other* fields and
Capabilities their EntityType declares, never in how Content itself is shaped.

`extensions[]` scope, decided now rather than left open (per the brainstorming's own §6
caution against over-abstracting): keep `Attachment` (a file) and `ContentExtension`
(inline semantic content — emoji, mention markers, link previews, location) as genuinely
separate concepts, per the brainstorming's §6 distinction, but do **not** build a generic
`extensions[]` registry until at least two of {location, link preview, poll} are real. Until
then, Content's `text`/`format`/`attachments[]` plus `MentionCapability`'s own extraction
(see §4) is enough — matching this codebase's existing discipline of not exporting a helper
ahead of a real caller (`paths.js`'s own doc comment: *"Only the helpers this round's code
actually needs are exported here"*).

### 3.3 EntityType — Drupal-inspired, deliberately shallow

An `EntityType` is a static composition record, not a persisted, admin-editable schema
store (that would be a CMS *app* concern, built later on top of this, not a Core/V4
concept — see §8 open decisions):

```js
// Illustrative — the actual shape lives in packages/entity once built.
const ForumTopicType = {
  type: 'topic',
  fields: { title: 'text' },
  content: true,               // has a Content field
  capabilities: ['commentable', 'reactable', 'followable', 'attachable'],
};

const ChatMessageType = {
  type: 'message',
  fields: {},
  content: true,
  capabilities: ['reactable', 'attachable', 'mentionable'],
};

const BlogArticleType = {
  type: 'article',
  fields: { title: 'text', coverImage: 'attachment' },
  content: true,
  capabilities: ['commentable', 'bookmarkable', 'taggable'],
};

const CmsPageType = {
  type: 'page',
  fields: { title: 'text', route: 'text' },
  content: true,
  capabilities: ['attachable'],
};

const NotificationType = {
  type: 'notification',
  fields: {},
  content: true,
  capabilities: ['notifiable'],
};

const TaskType = {
  type: 'task',
  fields: { status: 'enum', dueDate: 'datetime', assignee: 'ref:actor' },
  content: true,
  capabilities: ['commentable', 'attachable'],
};

const CalendarEventType = {
  type: 'event',
  fields: { title: 'text', start: 'datetime', end: 'datetime', location: 'text' },
  content: true,
  capabilities: ['reactable'],
};
```

| EntityType | Content | Title | Comments | Reactions | Attachments |
|---|---|---|---|---|---|
| Chat Message | ✓ | – | optional | optional | optional |
| Forum Topic | ✓ | ✓ | ✓ | optional | optional |
| Blog Article | ✓ | ✓ | optional | optional | optional |
| CMS Page | ✓ | ✓ | optional | optional | optional |
| Notification | ✓ | optional | – | – | optional |
| Task | optional | ✓ | optional | optional | optional |
| Calendar Event | optional | ✓ | optional | optional | optional |

This is the brainstorming's own matrix (§18), unchanged, because it was already correctly
grounded — the only correction is that "Comments"/"Reactions"/"Attachments" columns are
Capabilities (§4), realized as Services, not Engines.

## 4. Layer 2 — Capabilities

Each Capability is a thin Service over Entity, following the exact shape
`FlagService`/`BookmarksService`/`FavoritesService`/`ContactsService` already prove works
(`packages/services/src/flag-service.js` and its wrappers):

| Capability | Realized by | Status |
|---|---|---|
| Commentable | `CommentableService` (`packages/services/src/commentable-service.js`) — a thin `MessageService` wrapper using an Entity's own id as its attached comment Thread's `threadId`, the same "same id, no separate concept" convention `ChannelService` already established for Topic↔Thread, applied one layer up | **implemented (Forum-migration round)** |
| Reactable | `ReactionService.setEntityReaction()`/`getEntityReactions()` (`packages/services/src/reaction-service.js`), reusing the class's existing signing/actor-pub helpers via two new entity-scoped methods rather than overloading `setReaction()`'s thread-shaped signature | **implemented (Phase 2)** |
| Bookmarkable | `BookmarksService` (already an entity-kind-parametrized `FlagService` wrapper) | already generic — no change needed (Phase 1) |
| Followable | `FollowService` (`packages/services/src/follow-service.js`), same `FlagService`-wrapper shape as `BookmarksService`, `entityKind` required (no legacy caller to default for) | **implemented (Phase 2)** |
| Mentionable | `MentionService` (`packages/services/src/mention-service.js`): `mentionsOf(text)` is a stateless passthrough to `extractMentions()` (no stored forward index — stays correct after an edit); `indexMentions()`/`mentionedIn(actorPub)` add the one real gap, a stored reverse index (`paths.actorMentionPath()`, a GLOBAL per-actor derived list) | **implemented (Phase 2)** — mention-triggered notification delivery is still separate, later work |
| Taggable | `TagService` (`packages/services/src/tag-service.js`) — tagging + query only, explicitly **no** hierarchy/aliases (per brainstorming §20's own explicit scoping); two independent derived-list indexes (`tagPath()` forward, `entityTagPath()` reverse), scoped to one `entityKind` at a time, no cross-kind search | **implemented (Phase 2)** |
| Notifiable | existing `PushDeliveryService` (relay) + `NotificationPrefsService`, generalized so any Capability write (a comment, a reaction, a mention, a follow) can enqueue a notification through one shared call, instead of only Thread-message-driven pushes | still open — Phase 3+ |
| Attachable | `AssetEngine`/`AssetService` (already fully generic — takes any `spaceId`/entity reference) | already generic — no change needed |

No Capability introduces a new `QuStore` Engine. Where a Capability needs a derived-list
storage shape not yet covered by `paths.js`, it gets one new pair of path helpers
(`xParentPath()`/`xPath()`) added to that file, following its own stated convention of
adding helpers "alongside the Service that consumes them, not speculatively ahead of a real
caller." One subtlety worth recording for the next Capability that needs a derived list keyed
by more than one identifier: `QuStore.getChildren()`/`ListService.listDerived()` only ever
list **direct** (one level deep) children, so a compound key (e.g. `actorMentionPath()`'s
`spaceId`/`entityKind`/`entityId`) must be joined into one flat, single-segment key — the same
`~`-joining trick `webrtcPairKey()` already uses — never spread across nested path segments
under the list's own parent.

## 5. Content Editor architecture

The brainstorming's strongest single idea: **Content is what gets stored; the Editor is how
it gets produced; they must never know about each other's identity.**

```
Content  ←──────────────┐
   │                     │
   ├── ContentRenderer    │  (Content → HTML/DOM, format-driven)
   │                     │
   └── ContentEditor ─────┘  (produces compatible Content)
          │
          ├── EditorExtension[]   (Emoji, Attachments, Voice, Mention, Markdown toolbar, Location)
          └── submit → Content
```

- **ContentEditor** is the smallest reusable unit: a text input + submit + slots. It has no
  opinion about Chat vs. Forum vs. CMS.
- **ContentComposer** wraps a ContentEditor for an interactive posting context (a chat
  composer, a forum reply box, a comment box) — `packages/thread-ui` already *is* most of
  this (its `emoji.js`/`mention-autocomplete.js`/`composer-autogrow.js` are already
  context-agnostic composer plugins used by six different apps, per §0.1), it's just not yet
  named or formalized as a `ContentEditor`/`EditorExtension` contract with its own package.
- **EditorExtension** is the plugin contract a feature (Emoji, Attachments, Voice, Mention,
  Markdown, Location) implements against, independent of which app's Content it ends up
  producing for. `thread-formatting.js`'s markdown-lite becomes one `ContentRenderer`
  implementation (paired with a `MarkdownEditorExtension` supplying toolbar + serialization),
  not the only one.
- **Format selection is configuration, not app code**: `content.editor` resolves
  global default → per-EntityType override → per-device override → user preference, exactly
  the resolution order the brainstorming specifies in its §7. A Chat message can stay
  `plain`/`markdown` while a CMS Page defaults to `richtext`/`wysiwyg`, with zero app code
  change, because the app only ever asked for "a ContentEditor for this EntityType," never
  for a concrete editor implementation. **Not yet implemented** — see "Resolved" below for
  what's real today versus this eventual goal.
- Package placement: a new `packages/content-ui` sits beside existing `packages/thread-ui`
  and `packages/ui`; `packages/thread-ui`'s existing composer plugins are re-exported from
  (or migrated into) it as the first three `EditorExtension` implementations, so nothing
  built on them today breaks.

**Resolved (implemented):** `packages/content-ui` is real, with the exact `Content ↔
ContentRenderer`/`ContentEditor` split diagrammed above:

- `ContentRenderer` = `renderContent(content)` (`packages/services/src/content.js`) —
  deliberately DOM-free, living beside `createContent()` rather than in `content-ui`, same
  reasoning `thread-formatting.js`'s own `formatMarkdown()` is already DOM-free. Dispatches on
  `content.format`: `'plain'` (HTML-escape + `<br>`, reusing `thread-formatting.js`'s newly
  exported `escapeHtml()`), `'markdown'` (delegates to `formatMarkdown()`), `'richtext'`
  (throws a documented error — no WYSIWYG editor exists in this codebase yet to have produced
  richtext Content in the first place, an honest gap, not a silent wrong-looking fallback).
- `ContentEditor` = `mountContentEditor()` (`packages/content-ui/src/content-editor.js`) — a
  `<textarea>` (wired through `@qu/thread-ui`'s existing `mountComposerAutogrow()`, built in,
  not optional), a leading action slot AND the submit control both rendered through `@qu/ui`'s
  `mountResolvedSlot()` (§6 Presentation Resolver — implemented, see below), plus the
  unmanaged, raw-DOM trailing `actionsEl` slot from the first round. `requireText` (default
  `true`) generalizes `apps/chat/client.js`'s own already-proven "a caption is optional
  whenever there's an attachment to send instead" rule.
- `EditorExtension` contract, extended: `{id, mount(ctx) -> stopFn|void}`, `ctx = {textarea,
  actionsEl, insertText, registerAction, unregisterAction, registerSubmitCandidate,
  unregisterSubmitCandidate, contributeContent, retractContent, setChrome, submitNow}`.
  `registerAction()`/`registerSubmitCandidate()` contribute `SlotItem`s to the two resolved
  slots; `contributeContent()`/`retractContent()` carry non-text submission data
  (`{attachments?, location?}`), merged into `onSubmit(text, extras, meta)`; `setChrome()`
  temporarily replaces the whole editor row (Voice's recorder panel); `submitNow()` submits
  immediately with empty text and ONLY its own `extraPartial`, `meta.immediate = true`,
  never touching the typed draft or standing contributions (Voice's independent Send).
- Five real `EditorExtension`s (`packages/content-ui/src/`): `emojiExtension`/
  `mentionExtension` (unchanged, trailing `actionsEl`), and — **resolved, no longer
  deferred** — `attachmentExtension`/`locationExtension`/`voiceExtension`, all three
  generalized from `apps/chat/client.js`'s own already-proven implementations (its
  `<qu-asset-upload hide-picker>` usage, `shareLocation()`, and the complete
  Start→Pause⇄Resume→Finish→Preview→Send/Discard `MediaRecorder` state machine), not
  reinvented. `voiceExtension` registers BOTH a leading-slot trigger AND a
  `registerSubmitCandidate()` (`when: !hasText && !hasContribution`) — the mic-morph the
  brainstorming's original Voice discussion wanted, now a normal, general submit-slot
  candidate instead of a one-off boundary violation.
- `ContentComposer` = `mountContentComposer()` (`packages/content-ui/src/content-composer.js`)
  — wraps `mountContentEditor()`, builds `createContent({text, format, attachments:
  extras.attachments, location: extras.location})` on submit, calls `onSubmit(content)`, and
  clears the draft + contributions ONLY for a normal submit (`meta.immediate === false`) —
  never for a `submitNow()`-driven one, which has nothing of its own to clear. `format` is
  still a plain, explicit option a caller passes in — **now with one real rung of the
  resolution chain built**: `resolveContentFormat(type, registry = defaultEntityTypes)`
  (`packages/services/src/entity-types.js`, Forum-migration round) resolves an EntityType's
  own `contentFormat` (`'plain'` default, `'markdown'`/`'richtext'` settable per type — e.g.
  `topic`/`article`/`page` default to `'markdown'`, matching `THREAD_PRESETS.forum()`'s own
  `formatting: ['markdown', 'mentions']`). This is deliberately still just the
  per-EntityType rung, not the fuller global → per-EntityType → per-device → user-preference
  chain described above — there is still no persisted config store for per-device/user
  overrides to read from (`EntityType` is still static-only, §10) — but a caller no longer
  has to hard-code a format per app; `mountContentComposer({format: resolveContentFormat
  ('topic')})` is the real, current call shape.
- **Still not migrated**: `apps/chat/client.js` keeps its own hand-wired implementations —
  this round generalized their PROVEN LOGIC into `content-ui`, it did not yet swap Chat itself
  over to consume the generalized version. `apps/forum/client.js` likewise keeps its own
  composer. Both are real app-migration work, deliberately kept separate from proving the
  contracts themselves (same discipline every round has followed).
- **Deliberately not built**: a Markdown toolbar (blocked on a real gap — no precise
  caret/selection-coordinate measurement utility exists in this codebase yet, per
  `mention-autocomplete.js`'s own doc comment); a "+"-menu that groups Attachment/Location/
  Voice into one further-collapsed trigger beyond what `'inline-then-menu'` already gives —
  each is independently registered via `registerAction()`, deliberately not coupled to each
  other, so a future grouping change only touches call sites, not the extensions themselves.

## 6. Slot taxonomy — one consolidated table

The brainstorming's insight that Navigation and FAB are themselves just Slots with a
**Presentation Resolver** is correct and maps directly onto what's half-built already:

| Slot / Extension Point | Mechanism | Status |
|---|---|---|
| `shell.headerAction`, `shell.headerNavPoints` | `ExtensionPointHost` (`contributes`) | already real, see `apps/shell/src/header.js` |
| Per-app `contributes` points (e.g. `contact-row` action) | `ExtensionPointHost` / `actionsForSlot()` | already real |
| App navigation (`navigation`, `views`, `settings` sections) | `mountAppTemplate`'s `AppConfig` | already real, but currently a static link list, not ranked/grouped contributions from multiple sources |
| Primary create action (FAB) | `mountAppTemplate`'s `primaryAction` | already real for **one** static action; no resolver for multiple candidate actions |
| `content-editor` leading slot / submit control | `mountResolvedSlot()` (`@qu/ui`, see below) — **implemented** | `registerAction()`/`registerSubmitCandidate()` (§5) |
| `entity-item.actions`, `entity-detail.context` | new slots any EntityType's list/detail template exposes, generalizing the per-Thread-message context menu already in `packages/thread-ui/src/context-menu.js` | **new**, direct generalization of existing code |
| `content.entityFooter`, `content.entityMenu` | `ExtensionPointHost` (`contributes`) — the entity-scoped siblings of `content.messageFooter`/`content.messageMenu`, contributed by `apps/reactions`/`apps/bookmarks` alongside their existing message-level points; renders Reactions/Bookmarks on an Entity's own content (e.g. a Forum Topic's opening post) | **implemented (Forum-migration round)** — admin-configurable via the same `disabledApps` toggle already covering the message-level points; `apps/pins`' Pin capability is deliberately **not** given an entity-scoped sibling this round (documented scope cut, §10) |

**Presentation Resolver — implemented**: `mountResolvedSlot()`
(`packages/ui/src/slot-resolver.js`), exactly the concept §17 of the brainstorming named as
missing, now a real, reusable Core primitive rather than only a documented aspiration. Lives
in `packages/ui` beside `app-template.js` as originally planned. A consumer declares
candidate `SlotItem`s (`{id, icon?, label?, order?, onClick?, mount?, when?}`); the resolver
decides HOW they're presented:

- `'inline'` — every item its own button/widget.
- `'menu'` — all items collapse into one `@qu/thread-ui` `renderContextMenu()` trigger (not a
  second menu implementation — reuses the exact mechanism `apps/chat/client.js`'s own "+"
  button already uses).
- `'inline-then-menu'` — first `threshold` items inline, the rest collapse into one "More"
  trigger — the concrete answer to "ab X Items als Menü, Rest zusammengeklappt."
- `'switch'` — exactly one item renders, the first whose `when(state)` is true (IF/ELSE,
  generalized to N candidates) — what makes the ContentEditor's Send/Voice mic-morph (§5) a
  normal mechanism instead of a special case.

**First real consumer**: `ContentEditor`'s leading action slot (`'inline-then-menu'`,
configurable) and its submit control (`'switch'`) — see §5. **Scoped for now**: this round
wires the resolver into `ContentEditor` only; `app-template.js`'s FAB/Nav still use their
original mechanism (`primaryAction`'s single-link shape unchanged) — the resolver is built
generically enough to serve that later (same `SlotItem`/strategy shape), per this section's
original plan, but that wiring is separate, not-yet-done work.

## 7. Domain Services — kept as real domain logic

Per the brainstorming's own explicit caution (§24) and this document's decision tree (§2):
Calendar, Task/Todo, and Location/GeoChase keep real, non-generic domain logic. They are
built *from* Entity + Capabilities (a Calendar Event is an Entity with `start`/`end`/
`location` fields and a Reactable capability; a Task is an Entity with `status`/`dueDate`
fields and Commentable/Attachable capabilities) but their scheduling, recurrence, ordering,
and reminder logic stays in `CalendarService`/`TaskService`, not flattened into generic
Entity/Capability machinery. `GameEngine` for GeoChase is explicitly **not** abstracted now
— per the brainstorming's own §20 caveat, it only becomes a real, named Engine/Service once
a second game needs the same primitives; today `apps/geochase/src` stays app-local.

## 8. Documentation & test conventions (apply, don't invent)

Every new package this concept introduces (`packages/entity`, `packages/content-ui`, new
Capability Services) follows conventions already working in this repo, unchanged:

- a co-located `test/` directory using Node's built-in `node --test` (`packages/*/test/*.test.js`,
  DOM-facing tests via `packages/ui/src/testing.js`'s `installDom()` helper where relevant);
- an entry in `docs/api-reference.md` per package, in the same per-export style already used
  for `@qu/core`, `@qu/foundation`, `@qu/services`, `@qu/ui`, `@qu/thread-ui`;
- a `docs/building-an-app.md`-style guide once EntityType/Capability composition is real
  enough for third-party app authors to compose against, so app authors get the same
  "two-file shape + `ctx` contract" experience they already have.

This satisfies the requirement that Core/Services/Engines/Capabilities/Apps stay documented
and tested — as a standing convention this document commits new V4 code to, not as new
tooling to invent.

## 9. Build order

Adapting the brainstorming's own Level 0-6 build order (§"Und genau deshalb würde ich den
V4-Rewrite jetzt anders aufziehen") to what's already real in this repo:

1. **Stabilize contracts, not apps.** Build `packages/entity` (Entity/EntityType shapes,
   `EntityEngine` only if a real pipeline need appears) and `packages/content-ui`
   (`ContentEditor`/`ContentComposer`/`EditorExtension`/`ContentRenderer`, migrating
   `packages/thread-ui`'s existing plugins in as the first extensions) as the reference
   implementation, proven against one real existing case (Thread messages) before anything
   else changes.
2. **Generalize the Capabilities** already proven generic (`FlagService`'s wrappers,
   `AssetService`) to take an `EntityType`-agnostic entity reference instead of a
   Thread/message-specific one; add the two genuinely missing Capabilities (`FollowService`,
   `TagService`).
3. **Migrate one existing app** (Forum is the best candidate — already Thread + Comments +
   Reactions + Attachments, per §0.1) onto the Entity/Capability/ContentEditor contracts, to
   prove the composition holds under a real, already-shipped app before any other app moves.
4. **Migrate the remaining existing apps** (Chat, Notifications, Todo, Calendar) once step 3
   holds.
5. **Build the genuinely new apps** the model newly makes cheap — Blog, CMS/Pages, Stream —
   only after steps 1-4, since they were previously unbuildable without bespoke content
   storage and now cost only an EntityType definition plus templates/slots already proven
   by the migrated apps.

This is explicitly a separate future implementation task, not part of this document's
deliverable — this document specifies the contracts and order, not the code.

## 10. Decisions (resolved) and what's still open

The four items below were open when this document was first written. All four are now
decided (by the user) and, for the first three, **implemented** in Phase 1
(`packages/engines/src/entity-engine.js`, `packages/services/src/entity-service.js`,
`entity-types.js`, `content.js`, the generalized `bookmarks-service.js` — see
`docs/api-reference.md` §5's "Quniverse V4: the generic Entity layer" section for the full
API):

- **Package boundary — resolved:** no new package. `EntityEngine` lives in `packages/engines`
  (alongside `DocumentEngine`/`ThreadEngine`/`AssetEngine`/`AccessEngine`); `EntityService`/
  `EntityTypeRegistry`/`createContent`/`entityPath()` live in `packages/services` (already
  self-described as "the Entity API" in its own `package.json`). This follows the codebase's
  existing Engine/Service package split exactly, rather than introducing a parallel boundary.
- **`EntityEngine` timing — resolved: built now, as a real Engine.** Not the "conservative
  default" this document originally leaned toward — the user explicitly chose to build it
  immediately, and it earns Engine status on its own merits: unlike Document, an Entity has a
  genuinely mandatory field (`_type`) that must hold regardless of caller, which is exactly
  the kind of trust-boundary job §2's decision tree reserves for an Engine.
- **`EntityType` persistence — resolved: static now, explicitly designed for an easy later
  migration.** `EntityTypeRegistry` (`entity-types.js`) exposes only `register()`/`get()`/
  `list()` as its public surface, specifically so that swapping the `Map`-backed
  implementation for a persisted/admin-editable schema store later (a CMS app decision) never
  requires touching a call site — the narrow surface is the mechanism, not just a promise in
  a comment. Whether/when that persisted store gets built stays a later CMS-app decision, out
  of scope here.
- **`extensions[]` on Content — still open, deliberately.** Unchanged from the original
  framing: deferred until at least two real cases exist (location + link preview? location +
  poll?) — no app built in Phase 1 needed one, so there is still nothing to decide between.

Phase 1 explicitly did **not** migrate any app (Forum's `ChannelService` "a Topic IS its
Thread" pattern is untouched) — see the Phase 1 implementation plan's own Non-Goals for what
Phase 2+ still needs to cover (Follow/Tag/generalized-Reaction/Mention capabilities, the
Forum migration itself, and all `ContentEditor`/Slot/UI work from §5-§6 above).
