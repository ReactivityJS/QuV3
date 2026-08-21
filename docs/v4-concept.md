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
convention on top of the plain QuBit write pipeline. Placement: a new small package,
`packages/entity`, holding the `Entity`/`EntityType` shape helpers and (if built) the
`EntityEngine`; existing `paths.js` gains entity-oriented helpers (`entityPath()`,
`entityChildrenPath()`) alongside, not instead of, its current thread/doc/list helpers.

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
| Commentable | `MessageService` (a Thread's `postMessage`/`listReplies`) reused for any Entity, not just Thread | reuse existing |
| Reactable | `ReactionService` generalized from `threadReactionPath()` to `entityReactionPath()` | reuse existing, generalize path helper |
| Bookmarkable | `BookmarksService` (already an entity-kind-parametrized `FlagService` wrapper) | already generic — no change needed |
| Followable | new `FollowService`, same `FlagService`-wrapper shape as `BookmarksService` | **new**, smallest possible: one wrapper, no new storage shape |
| Mentionable | generalize `thread-formatting.js`'s `extractMentions()` into a small `MentionService` that both extracts and indexes (`mentionsOf(entityRef)` / `mentionedIn(actorPub)`), reusing the derived-list pattern | **new** indexing half; extraction already exists |
| Taggable | new `TagService` — tagging + query only, explicitly **no** hierarchy/aliases at launch (per brainstorming §20's own explicit scoping) | **new**, deliberately minimal |
| Notifiable | existing `PushDeliveryService` (relay) + `NotificationPrefsService`, generalized so any Capability write (a comment, a reaction, a mention, a follow) can enqueue a notification through one shared call, instead of only Thread-message-driven pushes | reuse existing delivery machinery, generalize the trigger surface |
| Attachable | `AssetEngine`/`AssetService` (already fully generic — takes any `spaceId`/entity reference) | already generic — no change needed |

No Capability introduces a new `QuStore` Engine. Where a Capability needs a derived-list
storage shape not yet covered by `paths.js`, it gets one new pair of path helpers
(`xParentPath()`/`xPath()`) added to that file, following its own stated convention of
adding helpers "alongside the Service that consumes them, not speculatively ahead of a real
caller."

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
  for a concrete editor implementation.
- Package placement: a new `packages/content-ui` sits beside existing `packages/thread-ui`
  and `packages/ui`; `packages/thread-ui`'s existing composer plugins are re-exported from
  (or migrated into) it as the first three `EditorExtension` implementations, so nothing
  built on them today breaks.

## 6. Slot taxonomy — one consolidated table

The brainstorming's insight that Navigation and FAB are themselves just Slots with a
**Presentation Resolver** is correct and maps directly onto what's half-built already:

| Slot / Extension Point | Mechanism | Status |
|---|---|---|
| `shell.headerAction`, `shell.headerNavPoints` | `ExtensionPointHost` (`contributes`) | already real, see `apps/shell/src/header.js` |
| Per-app `contributes` points (e.g. `contact-row` action) | `ExtensionPointHost` / `actionsForSlot()` | already real |
| App navigation (`navigation`, `views`, `settings` sections) | `mountAppTemplate`'s `AppConfig` | already real, but currently a static link list, not ranked/grouped contributions from multiple sources |
| Primary create action (FAB) | `mountAppTemplate`'s `primaryAction` | already real for **one** static action; no resolver for multiple candidate actions |
| `content-editor.actions`, `content-editor.attachments` | new `ExtensionPointHost`-style slots inside `ContentEditor` (§5) | **new** |
| `entity-item.actions`, `entity-detail.context` | new slots any EntityType's list/detail template exposes, generalizing the per-Thread-message context menu already in `packages/thread-ui/src/context-menu.js` | **new**, direct generalization of existing code |

**Presentation Resolver (new, §17 of the brainstorming, correctly identified as missing):**
an app declares one or more candidate primary actions with a `priority`/`preferred`
hint (`fab`, `toolbar`, `menu`); a resolver — living in `packages/ui` beside
`app-template.js`, not a new package — decides, from viewport/device/action count, whether
to render a single FAB, an expandable FAB, an action sheet, or a desktop toolbar/menu. This
replaces `app-template.js`'s current single-`primaryAction` link with a list-aware version;
existing single-action callers keep working unchanged (a list of one collapses to today's
behavior exactly).

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

## 10. Open decisions for the next task (flagged, not resolved here)

- Exact package boundary: does `Entity`/`EntityType` live in a new `packages/entity`, or as
  an addition to `packages/services` (where `paths.js`/`ListService` already live)? This
  document assumes a new package to keep Core-adjacent concerns out of the growing
  `packages/services`, but this is a call for whoever writes the code, not settled here.
- Does `EntityEngine` get built as a real `QuStore` pipeline Engine on day one (stamping
  `_id`/`type`, mirroring `DocumentEngine`), or does `Entity` stay a pure Service-layer
  convention (like today's "document"/"list" shapes) until a real pipeline-trust need
  appears? Given §2's decision tree, the latter is the more conservative default — an Engine
  should be added only once a concrete write needs the pipeline gate, not preemptively.
- `EntityType` is specified here as static, code-defined composition (§3.3). Whether a CMS
  app later needs a *persisted, admin-editable* EntityType/schema store is explicitly a CMS
  app-layer decision, out of scope for this Core/Capability concept.
- `extensions[]` on Content (§3.2) is deliberately deferred until ≥2 real cases exist —
  which two (location + link preview? location + poll?) is an open call for whichever app
  needs the first one.
