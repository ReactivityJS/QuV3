# App Navigation Standard

A practical spec for how navigation looks and behaves the same way in every
app under `apps/*` — back-navigation, "create new X" actions, and switching
between a channel/calendar/conversation. Read this alongside
[`docs/building-an-app.md`](./building-an-app.md) (the general shape/wiring
guide); this one is about *navigation specifically*. If you're starting a new
app, copy [`apps/_template/`](../apps/_template/) — it implements every rule
below, working and tested.

## Why this exists

Calendar, Chat, and Forum were each built independently and grew their own,
slightly different navigation chrome: Calendar rendered its own "Zurück" link
on top of the shell's already-working Back button, plus a floating "+" button
that could sit in the way of content; Chat used a plain "Gruppe erstellen"
link buried in a list instead of a consistent action placement; Forum's
channel switcher was a one-off sidebar with its own responsive CSS. None of
this was wrong on its own, but together the apps didn't read as one product.
This doc — and the `@qu/ui` helpers it's built on — is the fix: **one**
answer for "how do I get back," "where does 'create new X' live," and "how
do I see/reach the other channels-or-calendars-or-conversations," so every
app (old and new) looks and behaves the same way.

## The five rules

### Rule 1 — Global chrome owns Back/Forward

The shell header (`apps/shell/src/header.js`) renders a real Back and
Forward button, mounted once for the whole session. Every route change in
this codebase is a plain `location.hash = ...` assignment, which the browser
already turns into a real `History` entry — so Back/Forward genuinely work
everywhere, for free.

**No app ever renders its own "back to X" control.** Every subpage goes
through `@qu/ui`'s `renderSubpage(container, { showBackLink: false, render })`
— never `showBackLink: true` (the default), and never a hand-rolled `<a>`
pointing back at the app's own list view. The one exception is a full-bleed,
fixed-position view (Chat's room view, Forum's topic/"room" view) that
doesn't use `renderSubpage()` at all — those simply have no back element
either, for the same reason.

```js
import { renderSubpage } from '@qu/ui';

function renderDetailPage(container, thing) {
  renderSubpage(container, {
    showBackLink: false, // the shell header's own Back/Forward already covers this
    render: (content) => {
      // build your subpage into `content`
    },
  });
}
```

Getting back to a list/parent view is either the global Back button, or — if
the app has a Context Switcher (Rule 3) — a real link to a sibling.

### Rule 2 — The App Navigation Points Slot

"Create new X" — an event, a group, a channel, a task, anything with **its
own dedicated route** — lives in the shell header's `shell.headerNavPoints`
extension point: on the **left**, right after the Back/Forward buttons,
visible **only while that app is the active one**. It is never a floating
action button, an inline link buried at the bottom of a list, or a second
element competing with the header.

This is a separate point from `shell.headerAction` (right side, next to the
bell) — that one is reserved for ALWAYS-VISIBLE, cross-app icons (Search's
🔍 is the one contributor today). `shell.headerNavPoints` is where every
per-app "create X" action lives instead.

```
Home  ←  →  [nav points]  ⋯spacer⋯  [always-visible actions]  🔔  👤
             shell.headerNavPoints                shell.headerAction
             (per-app, conditional)                (cross-app, always shown)
```

Something that's composed *inline*, in place, has no dedicated route — a
chat message, Chat's/Forum's composer "+" menu for attach/share-location —
stays inline. The rule is about *navigating to a new top-level page*, not
every form on screen.

An app can contribute **more than one** item — `@qu/ui`'s
`renderNavPointsMenu()` renders exactly 1 item as a plain icon link (the
common case: Calendar's "New event", Chat's "New chat group", ToDo's "New
task"), or 2+ items as a small dropdown menu, with a `▾` caret next to the
icon so it visibly reads as a MENU trigger rather than a direct-navigation
link (Forum: "New channel" always, plus "New topic" once a specific channel
is open). Always pass `menuLabel` for the 2+ case (Rule 4 - the trigger's
own tooltip should say what the menu is FOR, e.g. "Create new…", not just
repeat the icon glyph or an arbitrary item's label). `@qu/ui`'s
`mountAppHeaderAction()` still handles the "only show while my app is
active" boilerplate underneath it — nothing new there:

```js
// your app's client.js
import { mountAppHeaderAction, renderNavPointsMenu } from '@qu/ui';

export function renderHeaderNavPoints(container, { getContext, onContextChange, services }) {
  mountAppHeaderAction(container, {
    appId: 'yourapp', getContext, onContextChange,
    render: (wrap) => {
      renderNavPointsMenu(wrap, {
        // 1 item - a plain link, `label` doubles as the tooltip:
        items: [{ label: 'New thing', href: '#/yourapp/new' }],
        // 2+ items - a dropdown; always pass menuLabel too:
        // items: [{ label: 'New thing', href: '#/yourapp/new' }, { label: 'New other thing', href: '#/yourapp/new-other' }],
        // menuLabel: 'Create new…',
      });
      // return a cleanup function here if your setup needs one (an async
      // fetch, a subscription) - see apps/calendar/client.js's real one for
      // the shape when the target route itself needs resolving first.
    },
  });
}
```

```json
// your manifest.quapp
"contributes": [
  { "point": "shell.headerNavPoints", "export": "renderHeaderNavPoints", "kind": "ui", "order": 10 }
]
```

(`order: 0` is `apps/search`'s own always-visible `shell.headerAction` icon
— on the OTHER slot, so it never actually collides with `order: 10`+ here;
kept consistent anyway.)

If your items depend on more than just "is my app active" — e.g. an action
that only makes sense on a specific sub-route — register your own
`onContextChange` listener from inside `render()` to recompute and
re-render on every route change within your app (`mountAppHeaderAction()`
itself only re-renders on activate/deactivate, not on every internal route
change). `apps/todo/client.js`'s own `shell.headerNavPoints` contribution is
a working reference for this shape (Forum has since migrated its own
route-dependent actions onto `mountAppTemplate()`'s `primaryAction`/
`settings` instead - see Rule 5 below).

The contributor's payload carries `getContext`/`onContextChange` (the current
route) plus `services`/`qu`/`subscribe`/`syncFetch` — the same ones the
shell header itself was built with — so a contributor that needs real data
(Calendar's "+" needs to know which calendar is editable) can resolve it
without a second trust surface.

### Rule 3 — The Context Switcher

Any app with more than one sibling "place" to be — a channel, a calendar, a
conversation — shows the current one in its own in-content title row, and
lets the user reach every sibling from the same underlying list, via `@qu/ui`'s
`mountContextSwitcher()`. **Neither of its two shapes is ever a JS-toggled
overlay/drawer/scrim** — an overlay has no direct link and no Back/Forward
support of its own, exactly the same reasoning `renderSubpage()` is built on
(a real route beats a `<dialog>`). Pick the shape based on the list itself:

- **`variant: 'tabs'`** — persistent sidebar (≥ the breakpoint) that reflows
  into an **always-visible** horizontal, scrollable tab strip (below it).
  Nothing is ever hidden, so there's no "open" state to link to — right for
  short, stable lists. Forum's channel switcher uses this.
- **`variant: 'page'`** — persistent sidebar (≥ the breakpoint) that is
  **replaced**, below it, by a plain title-row link ("{current item} ›")
  pointing at a real, dedicated, hash-routed sub-page — rendered by
  `renderContextListPage()` — showing the exact same list content full-page.
  A genuine browser history entry: bookmarkable, shareable, works with the
  global Back button and the OS back gesture. Right for longer lists, or
  lists with their own per-item management UI that doesn't fit a simple
  link. Calendar's calendar list (multi-select show/hide + share/delete/
  rename) uses this.

```js
import { mountContextSwitcher, renderContextListPage } from '@qu/ui';

// variant: 'tabs' - a simple "pick one, navigate there" list
mountContextSwitcher(container, {
  items: channels.map((c) => ({ id: c.id, label: c.title, href: `#/yourapp/c/${c.id}` })),
  activeId: currentChannelId,
  variant: 'tabs',
  heading: 'Channels',
  newItem: { label: '+ New channel', href: '#/yourapp/new' }, // optional - only if it has its own route (Rule 2's test)
  render: (content) => { /* your app's own main view */ },
});

// variant: 'page' - a list with its own per-item UI (checkboxes, actions) -
// use `renderSidebar` instead of `items` when it isn't a simple link list.
mountContextSwitcher(container, {
  renderSidebar: (host) => { /* build your own list/management UI into `host` */ },
  variant: 'page',
  switchHref: '#/yourapp/manage',
  activeLabel: 'Current thing',
  heading: 'Manage',
  render: (content) => { /* your app's own main view */ },
});
// ...and the app's own routing calls this at `switchHref`'s route:
renderContextListPage(container, {
  renderSidebar: (host) => { /* the SAME callback as above */ },
  heading: 'Manage',
});
```

Both variants share the exact same sidebar content on wide screens; they
only differ in how that content is reached on narrow screens.

### Rule 4 — Icons always carry a tooltip

Every icon-only control — a header action, a switcher trigger, a per-row
button — sets both `title` and `aria-label` to the same human-readable
string. This is already this codebase's convention everywhere (the shell
header's own Back/Forward/bell, `apps/search`'s icon, every icon-only row
button in Calendar/Chat/Forum); it's now a hard requirement for any new
icon-only control, not optional polish.

### Rule 5 — The App Template / Footer-Sidebar Chrome

Beyond the global header (Rules 1-2) and the Context Switcher (Rule 3), most
apps eventually need some version of four more things: a way to switch
between "places" that's reachable without going through a header slot, a way
to switch how the current place is *displayed* (day/week/month, list/grid,
latest/top), one obvious spot to create something new, and a spot for
app-level settings. Building each of those by hand, per app, is exactly the
kind of drift this whole document exists to prevent — so `@qu/ui`'s
`mountAppTemplate()` does it once, as a second, **optional**, per-app-owned
chrome region: a left sidebar on wide screens, a fixed bottom bar on narrow
ones. An app hands it a plain data object (`AppConfig`) — navigation items, a
"views" list, a primary action, settings entries, plus a `render(content)`
callback for its own UI — and never writes footer/sidebar layout code
itself. The Core decides placement and sizing; the content element handed to
`render()` is already constrained to exactly the remaining space.

```js
import { mountAppTemplate } from '@qu/ui';

mountAppTemplate(container, {
  navigation: {
    items: channels.map((c) => ({ id: c.id, label: c.label, href: `#/yourapp/c/${c.id}` })),
    activeId: currentChannelId,
    heading: 'Channels',
  },
  views: {
    items: [{ id: 'latest', label: 'Latest', href: '#/yourapp/v/latest' }, { id: 'top', label: 'Top', href: '#/yourapp/v/top' }],
    activeId: currentView,
  },
  primaryAction: { label: 'New topic', href: '#/yourapp/new', icon: '✏️' },
  settings: { items: [{ label: 'Manage channels', href: '#/yourapp/manage' }] },
  render: (content) => { /* your app's own main view, full-width/full-height */ },
});
```

**Every section is optional, and an empty section renders nothing.** An app
that passes only `render` gets zero chrome — the content area is exactly
100% of the container. An app that passes only `primaryAction` gets a single
floating action button in the bottom-right corner instead of a full-width
bar, since there's no bar content to build one around.

**Why a FAB is fine here, when this document used to reject one outright:**
Calendar's *old* FAB (see the Before/After diagrams above) was a floating
button with no system behind it — every app that wanted one built its own,
inconsistently, and it could sit wherever it liked on top of content. This
FAB is different in kind: it's one field (`primaryAction`) in a single,
Core-owned, data-driven template that every app renders identically, exactly
the same reasoning that already justifies the App Navigation Points Slot
(Rule 2) existing as a fixed, predictable location. The two aren't
competing — `shell.headerNavPoints` remains valid for apps that already use
it (Calendar, Chat, ToDo, Forum are not required to migrate), but **new**
apps should reach for `mountAppTemplate()`'s `primaryAction` first: it keeps
the "create X" action next to the rest of that app's own chrome
(navigation/views/settings) instead of splitting it across the global header
and the app's own UI.

**No bottom sheet, no drawer/scrim** — same reasoning as Rule 3's rejection
of a JS-toggled overlay for the Context Switcher (no route, no Back/Forward
support of its own). A `navigation`/`views` pill with more than one item, and
the settings gear, open a small, anchored popup of real `<a href>` links —
the exact same shape `renderNavPointsMenu()`'s 2+-item dropdown and the shell
header's own user menu already use, not a full-screen overlay.

```
Mobile (<720px), fixed footer:
┌──────────────────────────────────────────────────┐
│ [💬 #general ▾]   [👁️ Latest ▾]        ⚙️   (✏️) │
└──────────────────────────────────────────────────┘
  navigation pill      views pill          settings  primaryAction
  (popup of real       (popup of real      gear      (a real link,
   links)                links)            (popup)    styled as a FAB)

Desktop (≥720px), left sidebar (content sits to its right, flex: 1):
┌────────────────────────┐
│ [ ✏️ New topic       ] │  <- primaryAction, prominent, top
├────────────────────────┤
│ CHANNELS                │
│  • # general             │  <- navigation
│  • # random            3 │
├────────────────────────┤
│ latest   top             │  <- views
├────────────────────────┤
│                          │
│ ⚙ Manage channels        │  <- settings, pinned to the bottom
└────────────────────────┘
```

See `apps/_template/`'s `renderFolderView()` for a complete, tested, working
example (`navigation` + `primaryAction`). `apps/notifications/client.js` is a
second real example, of `views` specifically: its old "Show all (incl. read)"
button (in-place JS state) is now two real routes, `#/notifications`
(unread-only, the default) and `#/notifications/all`, decided once at mount
time from `segments[1]` and rendered as the `views` pill — the exact "real
route instead of a toggle" trade-off Rule 2's own "New topic" migration
already made, applied here to a view switch instead of a create action.

Every app's MAIN view — even one with none of `navigation`/`views`/
`primaryAction`/`settings` today — should still go through
`mountAppTemplate()`, passing only `render`. `apps/app-list`,
`apps/contact-list`, `apps/user-list`, and `apps/bookmarks` do exactly this:
zero visible change today (an empty config renders zero chrome, content gets
100% of the container, same as calling `render()` directly), but the app is
already wired into the one Core-owned chrome entry point — adding
`primaryAction`/`navigation`/`views`/`settings` later is a config change, not
a rewrite of how the app boots.

`apps/phone/client.js` is the example for a MULTI-ROUTE app where none of
the four chrome fields fit any route: each of its 5 routes (call-starter,
caller/audio, caller/video, callee, decline) is still its own
chrome-less `mountAppTemplate(container, { render })` call — a real page with
a real route, exactly per this rule — but none contributes a `navigation`
item. `accept`/`decline` in particular are never reached through any menu at
all (only via a notification click, an in-app toast action, or another app's
`content.chatRoomMenu` contribution) — a route doesn't need a nav entry to
be a "real page" in this sense. The call view's own full-bleed, fixed-position
styling (`.qu-phone-call-view`) is untouched by the wrap — a chrome-less
`mountAppTemplate()` call adds no visible sidebar/footer, so a
`position: fixed` overlay inside its `content` element behaves exactly as
before. (Phone's own hand-rolled `position: fixed` predates the `fullHeight`
option below — `apps/chat/client.js` is the app that actually needed it,
since its room view ALSO needs a `navigation` sidebar alongside the fixed
box, which Phone's call view never does; migrating Phone's own CSS onto
`fullHeight: true` too is a reasonable follow-up, not required.)

**`fullHeight: true`** binds `content` (and the sidebar, if any) to exactly
the remaining VIEWPORT height below the shell header, real `position: fixed`
under the hood (see `@qu/ui`'s `app-template.js` own "FULL HEIGHT MODE" doc
comment for the full "why fixed, not `calc(100vh - ...)`" reasoning) — for a
messenger-style view with its own internal header/scroll-region/composer
structure. `apps/chat/client.js`'s `mountRoomView()` is the real example: an
open room mounts with `fullHeight: true` AND a `navigation` section listing
every room (1:1 + group), the current one active — a genuine room-switcher
sidebar on wide screens, so switching rooms no longer means going back to
`#/chat` first (this used to be an explicitly out-of-scope gap in this doc).

**`navigation`/`views`/`settings`' `desktopOnly: true`** keeps a section OUT
of the mobile footer entirely — no pill, and it doesn't count towards
deciding whether a footer bar exists at all — while it still shows normally
in the desktop sidebar. Two real uses in `apps/chat/client.js`, from actual
usability feedback on the first version of this migration: the room LIST
(`mountRoomListView()`) now also passes its own room list as a `desktopOnly`
`navigation` section, so the desktop sidebar matches an open room's (it felt
inconsistent that only an open room got one) — `desktopOnly` because the
room list is ALREADY that same list, full-width, as the page's own content
on narrow screens, so a mobile pill duplicating it would be pointless. An
open room (`mountRoomView()`) has NO `primaryAction` at all anymore ("+ New
group" lives on the room list only — rarely needed once already inside a
room) and its own `navigation` is `desktopOnly` too — with nothing left for
the mobile footer to show, `mountAppTemplate()` renders no footer there at
all, so the room's own composer bar is the only bottom bar on a phone,
instead of a second, duplicate-looking one sitting right above it.

**`navigation`/`views`/`settings`' `filter: true`** adds a live search input
above the list - both in the desktop sidebar and in the mobile pill's popup -
that hides any item whose `label` (plus `searchText`, if an item sets it)
doesn't match, case-insensitively, as substrings; empty input shows
everything again. Both Chat's room list and Forum's channel list set it on
their own `navigation` now: a channel's own name is already the whole
story, but a chat room's isn't always - a DM room's `label` already IS the
other participant's name, but a GROUP room's `label` is the group's own
name, so searching for a member who isn't in that name would otherwise find
nothing; `listRooms()` (`apps/chat/client.js`) resolves each group's member
names once and `roomsToNavItems()` carries them as `searchText`, purely for
matching - never shown on screen. Leave `filter` off for a short, stable
list where a search box would just be one more thing on screen.

Both views' `navigation` depends on an async fetch (contacts/groups, and -
room list only - a group-creation policy check) that isn't ready at the one
synchronous `mountAppTemplate()` call every app makes —
**`stopTemplate.update(partialConfig)`** (the function `mountAppTemplate()`
returns also carries this property — see that function's own "LATE-ARRIVING
CHROME DATA" doc comment) fills chrome in once that resolves, without
re-calling `render()` or disturbing the app's own already-mounted content.
`apps/chat/client.js`'s `listRooms()` is the one place that computes "what
rooms exist, in what order, with what unread/muted state", shared by both
the rich room-list view and the lightweight `navigation` items either view
builds from the same data via `roomsToNavItems()`.

## Building a new app? A checklist

1. Copy `apps/_template/` — it implements every rule above, working and
   tested. Rename the directory, `manifest.quapp`'s `name`/`label`/`icon`,
   and restore `"clientMain": "./dist/client.js"` (the template omits it on
   purpose, so it's never itself bundled/catalog-listed).
2. No custom back link, anywhere. `renderSubpage({ showBackLink: false })`
   for every subpage.
3. Route your app's MAIN view through `mountAppTemplate()` (Rule 5), even if
   you pass only `render` — that's the standard entry point now, chrome-less
   by default. Add `primaryAction`/`navigation`/`views`/`settings` (any
   combination, omit the rest) the moment your app actually has a "create new
   X" action, more than one sibling place to switch between, more than one
   way to view the current place, or app-level settings — never build that
   chrome by hand. `mountAppTemplate()`'s `primaryAction` is now the
   recommended home for a NEW app's "create new X" action; a plain
   `shell.headerNavPoints` contribution (`renderNavPointsMenu()` renders 1
   item as a plain link, 2+ as a dropdown) is still valid for apps that
   already use it.
4. `mountContextSwitcher()` if you need a channel/calendar-style switcher
   OUTSIDE of `mountAppTemplate()`'s own `navigation` section (e.g. a
   dedicated `variant: 'page'` management page) — `variant: 'tabs'` for a
   short/stable list, `variant: 'page'` for a longer one or one with its own
   management UI.
5. Every icon-only control gets a `title` + `aria-label`.
6. Read [`docs/building-an-app.md`](./building-an-app.md) for everything
   else — the `mount(container, ctx)` contract, Services, extension points,
   testing.

## Before/after: Calendar, Chat, Forum

Diagrams below use `≥720px` (desktop) / `<720px` (mobile) as the reference
breakpoint — the one Calendar and the shared `mountContextSwitcher()` both
default to.

### Calendar

```
BEFORE (mobile):
┌──────────────────────────────┐
│ ☰  Kalender                   │  <- own hamburger, own title
├──────────────────────────────┤
│  [Month grid ...]             │
│                          (+)  │  <- floating FAB, floats over content
└──────────────────────────────┘
Event detail / Share / New-event pages:
┌──────────────────────────────┐
│ ← Kalender                    │  <- app's OWN back link (redundant with
│  Event details...             │     the global header's Back button)
└──────────────────────────────┘

AFTER (mobile):
Global header:  🏠  ←  →  [+]  ⋯  🔔  👤   <- "+" lives here now, next to Back/Forward, only while Calendar is active
┌──────────────────────────────┐
│  „Kalender" ›                 │  <- tap opens the real #/calendar/manage page
├──────────────────────────────┤
│  [Month grid ...]             │
└──────────────────────────────┘
Event detail / Share / New-event pages:
┌──────────────────────────────┐
│  Event details...             │  <- no in-app back link; global ← handles it
└──────────────────────────────┘

AFTER (desktop, ≥720px): a persistent sidebar (checkboxes to show/hide each
calendar, share/delete/rename, "+ new calendar") sits beside the month/week/
day/list view - same content as the #/calendar/manage page, just inline.
```

### Chat

```
BEFORE:
Room list:
┌──────────────────────────────┐
│  Chats                        │
│  Alice           ●            │
│  Bob                          │
│  + Neue Gruppe                 │  <- plain link, buried at the bottom of the list
└──────────────────────────────┘
Room view:
┌──────────────────────────────┐
│ ←   Alice                     │  <- app's OWN back arrow (redundant)
│  [messages...]                │
└──────────────────────────────┘

AFTER:
Global header:  🏠  ←  →  [+]  ⋯  🔔  👤   <- "+" lives here now, next to Back/Forward, only while Chat is active
Room list:
┌──────────────────────────────┐
│  Chats                        │
│  Alice           ●            │
│  Bob                          │
└──────────────────────────────┘
Room view:
┌──────────────────────────────┐
│  Alice                        │  <- no back arrow; global ← handles it
│  [messages...]                │
└──────────────────────────────┘
```

### Forum

```
BEFORE (mobile, hand-rolled mini sidebar - the "before" for the Rule 5 migration):
┌──────────────────────────────┐
│ [General][Team][Support][Ops] │  <- own scroll strip / <select>, own CSS,
│ [Random][Off-topic][Archive]…│     nothing shared with mountAppTemplate()
├──────────────────────────────┤
│  Announcements                │
│  [topics...]                  │
├──────────────────────────────┤
│  + New channel  (header nav points, board view only)
└──────────────────────────────┘

AFTER (mobile) - board/channel views now go through mountAppTemplate() like
every other Rule-5 app: the channel list is `navigation` (NOT desktopOnly -
switching channels is a core action here, unlike Chat's open room), "+ New
topic" is the view's own `primaryAction` FAB, "+ New channel" moved into the
`settings` gear popup (freeing `primaryAction` from having to represent two
different actions):
┌──────────────────────────────┐
│  Announcements            ⚙️  │  <- ⚙️ opens "+ New channel"
│  [topics...]                  │
│         ▾ Announcements  (+)  │  <- channel pill (popup: all channels) + New-topic FAB
└──────────────────────────────┘

The topic ("room") view is the same `fullHeight: true` + `navigation`
`desktopOnly: true` shape as Chat's open room (see above) - no
`primaryAction`/`settings` there, so on mobile the topic's own composer is
the only bottom bar, no duplicate footer:
┌──────────────────────────────┐
│  Announcements                │
│  [messages...]                │
│  [composer]                    │  <- the ONLY bottom bar
└──────────────────────────────┘

AFTER (desktop, ≥720px) - a persistent `mountAppTemplate()` sidebar, present
on the board view, an open channel, AND an open topic (desktopOnly there):
┌────────────┬───────────────────┐
│ All chan.  │  Announcements    │
│ General    │  [topics/messages]│
│ Team       │                   │
│ [+New topic│ desktop-primary]  │
└────────────┴───────────────────┘
```

Forum was already compliant on Rule 1 (its subpages already used
`renderSubpage({ showBackLink: false })`). The Rule 5 migration retired the
app's own hand-rolled `mountMiniChannelSidebar()`/`shell.headerNavPoints`
contribution (`renderHeaderNavPoints()`) entirely in favor of
`mountAppTemplate()`, following the exact pattern this doc's Chat section
already established: `channelsToNavItems(channels)` is the one shared mapper
every view (board, channel, topic) builds its `navigation` items from, kept
in sync with the live channel list the same way Chat's `roomsToNavItems()`
does; `applyNewChannelSettings()` fills in the `settings` gear once the
channel-creation policy check resolves, via `stopTemplate.update(...)` (see
this doc's "LATE-ARRIVING CHROME DATA" reference above), reused by both the
board and channel views.

**"New topic" is now reached two ways**: the board view's own `primaryAction`
(`#/forum/new-topic` - no channel picked yet, so the form adds a `<select>`
that's disabled until the channel list resolves) and an open channel's own
`primaryAction` (`#/forum/c/<channelId>/new-topic` - channel already known,
no picker). Both routes share one `mountNewTopicView()`, and the form itself
now takes the topic's opening post right there too - title, content
textarea, and an optional attachment, the same upload lifecycle the topic
view's own composer uses - rather than creating an empty topic that still
needs its first reply typed separately.

## What's explicitly out of scope (for now)

- **ToDo and Calendar are now on `mountAppTemplate()` too** — ToDo's list
  picker/list page/"Mir zugewiesen" aggregate route through it with a
  `navigation` switcher (built from the same list-fetching logic every page
  already needed), a per-route `primaryAction` ("New list" everywhere, "New
  task" only once a specific editable list is open) replacing the older
  `shell.headerNavPoints` contribution entirely, and a `settings` entry for
  "Listen verwalten" (`#/todo/manage` — previously unreachable from any link
  in the app). Calendar's own calendars sidebar stays `mountContextSwitcher()`
  (its per-item show/hide+share+delete UI still doesn't fit a plain link
  list), but the whole view is now ALSO wrapped in `mountAppTemplate()` purely
  for its `settings` gear — "Kalender verwalten" reaches `#/calendar/manage`
  from there instead of the old inline "„Kalender" ›" title-row link, which is
  now suppressed via `mountContextSwitcher()`'s new `hideTitleLink` option.
- **Pins, Reactions, Search, Relay Admin** are unchanged. Pins/Reactions
  contribute to other apps' extension points and have no `mount()` UI of
  their own; Search's own `mount()` view and Relay Admin (a single settings
  form with no natural `navigation`/`views`/`primaryAction`) haven't been
  migrated yet — both are candidates whenever someone picks them up,
  following this doc and `apps/_template/`.
