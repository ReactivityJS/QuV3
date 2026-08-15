# Building an app for Quniverse

A practical, self-contained guide to writing a new app that mounts inside
`apps/shell`. It assumes nothing from prior conversation — everything here is
either quoted directly from real source in this repo, or is a real, working
example you can find under `apps/*`. For the full method-by-method reference
(every Service, every `@qu/ui` element, theming/styling/templating), see
[`docs/api-reference.md`](./api-reference.md); this guide is about *shape and
wiring*. For how navigation specifically should look and behave (back
buttons, "create new X" actions, switching between channels/calendars/
conversations), see [`docs/app-navigation-standard.md`](./app-navigation-standard.md)
and copy [`apps/_template/`](../apps/_template/) as your starting point.

## 1. The two-file shape

An app is a directory under `apps/<name>/` with a `manifest.quapp` (JSON) and
up to two JS entry points:

```
apps/<name>/
  manifest.quapp     # required — the one file @qu/loader reads to discover you
  index.js           # optional — server-side registration (Node)
  client.js          # optional — browser UI (mount() the shell calls)
  test/
    client.test.js   # your tests — see §9
```

Both `index.js`/`client.js` are **optional independently**:

- An app with no UI at all (a background service, a thread auto-provisioner)
  ships only `index.js` and omits `clientMain` from its manifest — `apps/forum`
  used to be exactly this before it grew a client.
- An app that's pure UI over Services other apps/Engines already provide
  ships only `client.js`, with `index.js` as a documented no-op (see
  `apps/bookmarks/index.js`, `apps/notifications/index.js` — both just log
  and return, because nothing needs server-side setup).
- Most apps ship both.

## 2. `manifest.quapp` — the full field reference

This is the ONE file `@qu/loader` reads to discover, validate, and load your
app; it also becomes (a subset of) what `/apps.json` and every mounted app's
own `ctx.apps` sees. Every field below is validated by
`packages/foundation/src/manifest.js`'s `validateManifest()` — get the shape
wrong and loading throws with a specific message, not a silent skip.

```json
{
  "name": "notifications",
  "version": "1.0.0",
  "kind": "app",
  "main": "./index.js",
  "clientMain": "./dist/client.js",
  "label": "Notifications",
  "icon": "🔔",
  "navOrder": 12,
  "requires": []
}
```

(This is the real `apps/notifications/manifest.quapp`, verbatim.)

| Field | Required? | Meaning |
|---|---|---|
| `name` | **yes** | Unique registry name. Also the route segment (`#/<name>`) and the value every `pushActions`/`contributes`/`definesExtensionPoints` lookup keys on. |
| `version` | **yes** | Semver string. Display-only today — the loader checks *presence* of a dependency, not version ranges. |
| `main` | **yes** | Path to the server-side module `@qu/loader` `import()`s in Node. Point it at a documented no-op if you have nothing to register (see `apps/bookmarks/index.js`). |
| `kind` | no (default `'app'`) | `'engine'` \| `'service'` \| `'app'`. Apps are UI-only by convention. |
| `requires` | no | Names that must already be registered before you load — see §2.1. |
| `clientMain` | no | Path to your **built** browser bundle (`./dist/client.js` by convention — see §8) that exports `mount(container, ctx) -> stopFn|void`. Omit this and you're server-only; nothing gets bundled, nothing appears in the nav. |
| `label` | no | Display name for the nav (defaults to `name`). |
| `icon` | no | An emoji for the nav. |
| `navOrder` | no | Sort hint in the nav (lower first). No app-list-registration step needed beyond this — see §5. |
| `spaceId` | no | **A fixed UUID, generated once and committed here** — your app's own permanent storage-space id (what you pass as `spaceId` to `paths.threadMetaPath()`, `paths.documentPath()`, etc., if you use `@qu/services`' Entity APIs). Never derive this from `name` — see §2.2. |
| `pushActions` | no | `{id, label, type?}[]` — notification categories your app can trigger. See §7. |
| `actions` | no | `{slot, id, label, hrefTemplate, icon?, order?}[]` — pure-data contributions to another app's link slot. See §6.1. |
| `contributes` | no | `{point, export, kind?, order?}[]` — live code you contribute to an extension point another app defines. See §6.2. |
| `definesExtensionPoints` | no | `{point, kind?, description?}[]` — extension points **your own** app exposes for others to contribute to. See §6.2. |

### 2.1 `requires`

Names (Engine/Service/App registry names, or another app's `name`) that must
already be registered before `@qu/loader` loads you. Real example —
`apps/forum/manifest.quapp`:

```json
"requires": ["message-service"]
```

The loader resolves dependency order across every local app automatically
(see `@qu/loader`'s `discoverLocalPackages()`); you never hand-order anything
yourself in `relay.js`.

### 2.2 `spaceId` — why it's a hardcoded UUID, not a string

Every `@qu/services` Entity API path (`threadMetaPath(spaceId, ...)`,
`documentPath(spaceId, ...)`, ...) takes a `spaceId` as its first argument.
Generate a real UUID **once**, commit it in your manifest, and use it
everywhere your app needs a space — never the literal app name. Two reasons:

1. **Collision safety.** `apps/forum` originally passed the literal string
   `'forum'` as its space id. If a second, independent app anywhere ever
   picked the same human word, their data would collide in the same storage
   space. A UUID can't collide by accident.
2. **Deployment portability.** The id is committed to source, not generated
   per-relay-boot — every relay that deploys your exact app source shares the
   *same* space id, so data stays addressable/mergeable regardless of which
   relay a user's client first talked to. Generating it fresh per deployment
   would give every independent relay running "the same" app its own
   isolated space, defeating the point.

Generate one with `node -e "console.log(crypto.randomUUID())"` and paste it
in. Omit the field entirely if your app has no space-scoped storage of its
own (e.g. `apps/app-list` only ever reads the shared, global app catalog).

## 3. `index.js` — server-side registration

Exports one function, `register(qu, manifest)`, called once when `@qu/loader`
loads your app on the relay (Node, never the browser). Use it to ensure any
one-time server-side state exists — e.g. `apps/forum/index.js` ensures its
public thread exists on every boot (idempotent — `MessageService.createThread()`
returns the existing config unchanged if one's already there):

```js
import { MessageService, ListService, AccessService, THREAD_PRESETS } from '@qu/services';

const SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1'; // this app's own manifest.spaceId
const THREAD_ID = 'general';

export async function register(qu, manifest) {
  const messages = new MessageService(qu, /* identity */ undefined, new ListService(qu), new AccessService(qu));
  await messages.createThread(SPACE_ID, THREAD_ID, THREAD_PRESETS.forum());
  console.log(`[${manifest.name}] registered (${manifest.name}@${manifest.version}) - ensured the public thread exists`);
}
```

(Simplified from the real `apps/forum/index.js` — the actual file resolves
`identity` off the relay's own `QuIdentityEngine` instance, not `undefined`.)

If your app needs no server-side setup at all (most content/UI apps don't),
`index.js` is still required (the manifest's `main` field is mandatory) —
make it a documented no-op:

```js
/** BOOKMARKS — purely a UI app; nothing to register server-side. */
export async function register(qu, manifest) {
  console.log(`[${manifest.name}] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
```

(Real `apps/bookmarks/index.js`, verbatim modulo the comment.)

## 4. `client.js` — the browser half

Exports `mount(container, ctx) -> stopFn | Promise<stopFn|void>`. `apps/shell`
calls this (see `apps/shell/client.js`'s `renderRoute()`) every time the hash
route resolves to your app, and calls the returned stop function before
mounting whatever's next.

**Write `mount()` as a plain (non-`async`) function that returns the stop
function synchronously**, deferring any async setup (`services.actors.whoAmI()`,
etc.) into an inner `(async () => { ... })()` IIFE. Every real app in this
repo does this — `apps/shell/client.js`'s own composition-root `mount()` is
the one deliberate exception, not a second precedent to copy. A test that
calls `const stop = mount(container, ctx)` (unawaited, matching every real
test in this repo) will break if your `mount()` is itself `async`.

```js
export function mount(container, { qu, identity, services, apps, segments, subscribe, syncFetch, extensionPoints }) {
  let stopped = false;
  let off = null;

  const heading = document.createElement('h1');
  heading.textContent = 'My App';
  container.appendChild(heading);

  (async () => {
    const myPub = await services.actors.whoAmI();
    if (stopped) return; // mount() may have already been torn down while we awaited
    // ... build the rest of your UI, wire up watch()/watchChildren() ...
  })();

  return () => {
    stopped = true;
    off?.();
  };
}
```

### 4.1 The `ctx` object, field by field

Exactly what `apps/shell/client.js` passes (`{ qu, identity, services, apps, segments, subscribe, syncFetch, extensionPoints }`):

| Field | Type | What it is |
|---|---|---|
| `qu` | `QuStore` | The one store instance for this whole page load. Set `.qu` on a container element (or an ancestor) before appending `<qu-view>`/`<qu-list>`/etc. children — see the templating section of `docs/api-reference.md`. |
| `identity` | `QuIdentityEngine` | Rarely needed directly — almost everything you need is already wrapped by a Service in `services`. |
| `services` | `object` | The full Services catalog — see §5 of `docs/api-reference.md` for every key. Always present, unconditionally, regardless of which app is mounted (see `apps/shell/src/services.js`'s own doc comment). |
| `apps` | `Array<object>` | The full, live app catalog (same shape `/apps.json` serves) — `{name, label, icon, navOrder, spaceId, clientMainUrl, pushActions, actions, contributes, definesExtensionPoints, enabled}` per entry. What `actionsForSlot()`/`ExtensionPointHost`/a manual catalog scan read. |
| `segments` | `string[]` | The full hash path, split on `/`, **including your own app id as `segments[0]`**. For `#/notes/inbox/42`, `segments = ['notes', 'inbox', '42']` — your own subpage logic reads `segments[1]`, `segments[2]`, ... See §5.1. |
| `subscribe` | `(prefix: string) => void` \| `undefined` | Best-effort: asks the live sync connection to subscribe to a path prefix. Always call this defensively (`subscribe?.(...)`, never assume it exists) — see §5.2. |
| `syncFetch` | `(prefix: string) => Promise<*>` \| `undefined` | Backfills data written *before* this session connected — pass it straight through to `watch()`/`watchChildren()`/`<qu-list syncFetch>` (via `.syncFetch` on an ancestor). Without it, a fresh browser only ever sees what a peer writes *after* this page loaded. |
| `extensionPoints` | `ExtensionPointHost` | Rebuilt fresh every route dispatch from the same `apps` array. Call `.renderSlot(point, container, payload)` to render every OTHER app's contribution to a point *you* define — see §6.2. |

### 4.2 Subpages via `segments`

There is no separate router per app — `segments[0]` is always your own app
id (redundant but consistent), so a subpage is just reading `segments[1]`
onward yourself. Real example, `apps/profile/client.js` (simplified):

```js
export function mount(container, { services, segments = [] }) {
  (async () => {
    const myPub = await services.actors.whoAmI();
    const rawFirst = segments[0]; // e.g. "~AbC123..." for #/~AbC123.../settings
    const isSettings = segments[1] === 'settings';
    // ... render the settings subpage, or the main profile view ...
  })();
  return () => {};
}
```

Build a link to a subpage the same way any other link works — a plain `<a
href="#/notes/inbox/42">` — real browser history, working back/forward, no
special JS needed (see `@qu/ui`'s `renderSubpage()` helper in
`docs/api-reference.md` for the shared content-area wrapper every subpage in
this repo uses — call it with `showBackLink: false`, per
[`docs/app-navigation-standard.md`](./app-navigation-standard.md)'s Rule 1:
the shell header's own Back/Forward already covers "return to where you
came from", so a subpage should not also render its own back link).

## 5. Appearing in the nav — nothing to register

Once your manifest declares `clientMain` + `label`/`icon`/`navOrder`, you are
**automatically**:

- **Discovered and bundled** by `npm run build` (`scripts/build-apps.mjs`
  scans every `apps/*` directory for a `manifest.quapp` with a `clientMain`
  field — no per-app registration in the build script itself).
- **Published into the app catalog** by the relay (`buildAppsCatalog()`,
  `packages/relay/src/apps-catalog.js`), served at `/apps.json` and mirrored
  into the store at `/store/apps/catalog/<name>` for `<qu-list parent="...">`
  consumers.
- **Listed in the shell's own top nav** (`apps/shell/src/nav.js`, a
  `<qu-list parent="...">` over that same catalog) — sorted by `navOrder`,
  showing your `icon`/`label`.

There is no separate "register this app in the nav" step anywhere in this
codebase. If your app doesn't show up, check: does `manifest.quapp` have a
`clientMain`? Did `npm run build` run since you added it? Is `enabled` false
(an admin disabled it via Relay Admin)?

### 5.1 A route to a specific app

`#/<name>` always resolves to whichever catalog entry has `name === <name>`
— `apps/shell/client.js`'s `renderRoute()` does the `fetch('/apps.json')` +
lookup + dynamic `import()` for you; you never write that code yourself.
The one reserved exception: `#/~<pub>` always dispatches to the `profile`
app regardless of the by-name lookup (the real Qu's own profile-link
convention) — irrelevant unless you're building something that specifically
needs to intercept that sigil, which no app besides `apps/profile` does.

### 5.2 `subscribe()` — defense in depth, not required

A shell *might* already subscribe broadly enough that your data arrives
without you calling `subscribe()` yourself — but never rely on that staying
true. Real convention, `apps/user-list/client.js`:

```js
export function mount(container, { qu, services, subscribe, syncFetch }) {
  subscribe?.('/store/directory'); // defense in depth - don't assume a shell subscribes to everything
  ...
}
```

## 6. Hooking into extension points

Two independent mechanisms exist, chosen by whether the point needs to run
someone else's **code** or just needs a **link**.

### 6.1 `actions` — pure-data link slots

For the common case: another app renders one row per item (e.g. a contact),
and you just want to add a link on that row (e.g. "Chat with them"). No
fetch, no module import — a slot consumer reads every loaded app's `actions`
straight off the catalog it already has:

```json
// your manifest.quapp
"actions": [
  { "slot": "contact-row", "id": "chat", "label": "Chat", "icon": "💬", "hrefTemplate": "#/chat/{pub}", "order": 5 }
]
```

The consumer (e.g. `apps/contact-list`) does:

```js
import { actionsForSlot, resolveActionHref } from '@qu/foundation';

const actions = actionsForSlot(apps, 'contact-row'); // every app's contribution to THIS slot, sorted
for (const action of actions) {
  const link = document.createElement('a');
  link.href = resolveActionHref(action, { pub: contactPub }); // fills in {pub}
  link.textContent = `${action.icon ?? ''} ${action.label}`;
  row.appendChild(link);
}
```

`apps/contact-list` never imports Chat; Chat never imports `apps/contact-list`
— they only agree on the slot id `"contact-row"` and the `{pub}` placeholder.

### 6.2 `contributes` / `definesExtensionPoints` — real, live code

For when a link isn't enough and the contribution genuinely needs to run
code — a Bookmark toggle that reads/writes its own storage, a content plugin
that renders its own DOM. This is the mechanism proven out end to end by the
REAL `apps/forum` (defines the point) / `apps/bookmarks` (contributes to it)
pair in this repo — read both files directly, they're short and real, not
excerpted-for-docs pseudocode.

**The host app** (`apps/forum/manifest.quapp`) declares the point exists:

```json
"definesExtensionPoints": [
  { "point": "content.messageActions", "kind": "ui", "description": "Extra action buttons per forum message - e.g. Bookmarks' toggle. Payload: {services, messageId, spaceId, threadId, body, author}." }
]
```

...and renders it, once per message, in `apps/forum/client.js`:

```js
const extensionSlot = document.createElement('span');
extensionSlot.className = 'qu-forum-message-extensions';
if (extensionPoints) {
  await extensionPoints.renderSlot('content.messageActions', extensionSlot, {
    services, messageId: message.id, spaceId: SPACE_ID, threadId: topicId, body: message.body, author: message.author,
  });
}
body.append(head, textWrap, actions, reactionsRoot, extensionSlot);
```

(`topicId` — as of Forum's Channels/Topics redesign, a Topic **is** its own
Thread, so `topicId` and `threadId` are literally the same value passed
through; a single-thread app without that concept would just use its own
fixed thread id here instead.)

Note what's in the payload: **`services`**, not raw `qu`/`identity` — so a
contributor never has to construct its own Service instances, it just reads
`services.whatever` off the payload it's handed.

**The contributor** (`apps/bookmarks/manifest.quapp`) declares what it
implements:

```json
"contributes": [
  { "point": "content.messageActions", "export": "renderBookmarkToggle", "kind": "ui", "order": 10 }
]
```

...and `apps/bookmarks/client.js` exports that named function (alongside its
own `mount`) — a plain `(container, payload) -> void|Promise<void>` that
mounts its own DOM into `container`:

```js
export async function renderBookmarkToggle(container, { services, messageId, spaceId, threadId, body, author }) {
  const snapshot = { spaceId, threadId, body, author };
  const flagsAdapter = {
    hasPrivate: () => services.bookmarks.isBookmarked(messageId),
    setPrivate: (_flagType, _entityKind, _entityRef, on) =>
      on ? services.bookmarks.add(messageId, snapshot) : services.bookmarks.remove(messageId),
  };
  const toggle = renderFlagToggle({
    flags: flagsAdapter, flagType: 'bookmark', entityKind: 'forumMessage', entityRef: messageId,
    icon: '🔖', activeIcon: '📑', title: t('bookmarkAdd'), activeTitle: t('bookmarkRemove'),
  });
  container.appendChild(toggle);
}
```

(Real `apps/bookmarks/client.js`, verbatim — `t(...)` is that file's own `createI18n()` instance.)

**Forum has never imported Bookmarks. Bookmarks has never imported Forum.**
`ExtensionPointHost` dynamically `import()`s Bookmarks' already-catalog-known,
already-integrity/signature-pinned `clientMainUrl` (the SAME URL the shell
would use to mount it directly, if you navigated to `#/bookmarks` — no new
trust surface), caches the module after the first import (so a slot rendered
once per row in a long list doesn't re-fetch/re-eval per row), and calls the
named export.

**Two `kind`s, two `ExtensionPointHost` methods:**

- `kind: 'ui'` + `renderSlot(point, container, payload)` — the
  `content.messageActions` shape above. Your export mounts DOM into a
  container.
- `kind: 'menu'` + `collect(point, payload)` — a context-menu-style
  extension: your export returns `Array<{id, label, icon?, onClick}>`
  (or a Promise of one), every contributor's results get concatenated back
  to the caller.

**There is deliberately no third `'hook'`-kind runtime mechanism.** A point
that's really "notify me when X is written" doesn't need `ExtensionPointHost`
at all — call `qu.onStorageChange(({path, quBit}) => {...})` directly
(filtered to your path prefix), the exact same primitive `@qu/reactive`'s
`watch()`/`watchChildren()` and `@qu/sync` already build on. A
`definesExtensionPoints` entry with `kind: 'hook'` exists purely so someone
reading the manifest catalog can *discover* that this reaction point exists
and how to subscribe to it, without grepping source:

```json
"definesExtensionPoints": [
  { "point": "thread.messagePosted", "kind": "hook", "description": "fires via qu.onStorageChange() on writes under a thread's messages path - see paths.threadMessagesParentPath()" }
]
```

## 7. Hooking into notifications

Your app can trigger real push/in-app notifications with **zero server-side
wiring** beyond declaring `pushActions` in your manifest — the relay
automatically builds notification titles/routing from it
(`createManifestNotificationResolver()`, `packages/relay/src/push-delivery.js`,
wired as `relay.js`'s default `resolveNotification`).

```json
"pushActions": [
  { "id": "newMessage", "label": "New posts", "type": "create" },
  { "id": "mention", "label": "Mentions", "type": "mention" }
]
```

- `id` is what a recipient's `NotificationPrefsService` per-app-per-function
  toggle checks against (`shouldNotify(prefs, {appId, mention, functionName})`)
  — the SAME id a settings UI shows next to your app's icon.
- `type` (`'create'` \| `'update'` \| `'delete'` \| `'mention'` \| `'custom'`)
  is what the manifest-driven resolver matches against: any thread message
  you post that mentions someone (`@<theirPub>` in the body, with
  `formatting: ['mentions']` on the thread) is auto-routed as `type:
  'mention'`; any other message as `type: 'create'`.

**You don't call anything to make this happen** — `@qu/relay`'s
`PushDeliveryService` already fires on every thread message write (an
`onStorageChange` listener wired in `relay.js`'s `boot()`). If you post
messages via `MessageService.postMessage()`/`.notify()` into a thread with
`formatting: ['mentions']`, mentions are detected and routed through your
`pushActions` automatically — the notification title becomes `"<your
pushAction's label> — <your app's label>"` instead of the generic fallback,
and the click-through URL is your app's real, routable `#/<name>`.

If you want to notify one specific actor directly (not via a public
mention), use `MessageService.notify(spaceId, recipientPub, body, extra)` —
creates (if needed) a private mail thread to them and posts one message; see
`docs/api-reference.md`'s `MessageService` section for the full signature.

Reading a recipient's own notification feed is `apps/notifications`' job,
not yours — you never write into `paths.notificationsSpaceId(...)` directly;
`PushDeliveryService` does that for you, from the message you already posted.

## 8. Building

```sh
npm run build   # scripts/build-apps.mjs
```

Bundles every `apps/*/client.js` whose manifest declares `clientMain` into
`apps/<name>/dist/client.js` — a fully self-contained ESM bundle (every bare
`@qu/*` import inlined, since a raw browser has no import map and the relay
serves whatever bytes are on disk, no server-side bundling). Your manifest's
`clientMain` should point at the **built** output (`"./dist/client.js"`), not
your source `client.js` directly — `scripts/build-apps.mjs` always compiles
from the fixed, unbundled `<appDir>/client.js` next to the manifest,
regardless of what `clientMain` says.

## 9. Testing your app

Every real app's test file in this repo follows the same shape — read
`apps/bookmarks/test/client.test.js` or `apps/notifications/test/client.test.js`
directly for a complete, current example. The essentials:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, ActorService /* , ...whatever Services your app needs */ } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom(); // MUST run before any @qu/ui import that touches customElements
const { mount } = await import('../client.js'); // dynamic import - AFTER installDom()

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const services = { actors: new ActorService(identity) /* , ... */ };
  return { qu, identity, services };
}

function noopSubscribe() {}

/** Must be attached to document.body - <qu-list>/<qu-view> only fire connectedCallback() once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('renders something', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.my-thing') !== null);
    assert.equal(container.querySelector('.my-thing').textContent, 'expected');
  } finally {
    stop();
  }
});
```

**Two documented gotchas, both real bugs caught in this exact codebase:**

1. `waitFor(check, {timeout, interval})` (`@qu/ui/testing.js`) does
   **`while (!check())`** — it never `await`s its predicate. Passing an
   `async` predicate resolves as truthy on the very first call, regardless
   of what it actually settles to. Use a real poll loop instead if what
   you're waiting for is itself async (e.g. an `await someService.get(...)`
   check), not `waitFor(async () => ...)`.
2. `watchChildren()`/`watch()` callbacks can legitimately fire twice in
   quick succession (an initial local read, then a fresher value moments
   later — a live relay, or a `syncFetch` backfill). A `render()` with real
   `await`s between being triggered and touching the DOM needs a monotonic
   token guard (`let renderToken = 0; const token = ++renderToken; ...; if
   (token !== renderToken) return;`) or an older, slower call can finish
   *after* a newer one and leave stale state on screen. Every real app in
   this repo that re-renders asynchronously has this guard — see
   `apps/profile/client.js`'s own `renderToken` or `apps/notifications/client.js`'s
   own copy of the same pattern (with the exact "why" spelled out in its own
   comment) for the canonical shape.

For multi-peer scenarios (two identities, one seeing the other's write),
mirror what `apps/user-list/test/client.test.js`'s `publishOtherUser()` /
`apps/forum/test/client.test.js`'s `mirrorThreadInto()` do: a **second**,
independent `QuStore`/`QuIdentityEngine` pair, with just the specific
documents the scenario needs copied across via `qu.putSealed(path, await
otherQu.get(path))` — simulating "this already synced in from a peer"
without spinning up a real relay.

For a genuine end-to-end check (real relay, real WebSocket, real browser),
see any of this repo's own live-verification passes described in the
[Status](#status) log at the bottom of the README — they all follow the same
shape: boot a real `QuRelay` on a random port, drive it with a headless
Chromium via Playwright, two independent browser identities. Not part of
`npm test` (no Playwright dependency in `package.json`) — a manual
verification step for a change that genuinely needs a real browser/relay to
prove, not something every PR needs to run.
