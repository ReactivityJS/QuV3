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

If your items depend on more than just "is my app active" — e.g. Forum's
"New topic" only makes sense once a specific channel is open — register your
own `onContextChange` listener from inside `render()` to recompute and
re-render on every route change within your app (`mountAppHeaderAction()`
itself only re-renders on activate/deactivate, not on every internal route
change). `apps/forum/client.js`'s real `renderHeaderNavPoints()` is the
working reference for this shape.

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
BEFORE (mobile, v1 of the migration - a real regression, since fixed):
┌──────────────────────────────┐
│ [General][Team][Support][Ops] │  <- horizontal scroll, forced sideways
│ [Random][Off-topic][Archive]…│     scrolling once there were more than
├──────────────────────────────┤     a handful of channels
│  Announcements                │
│  [topics...]                  │
└──────────────────────────────┘

AFTER (mobile) - the shared sidebar list (mountContextSwitcher, variant:
'tabs') collapses to a native <select> below 720px instead of a
horizontally-scrolling strip - shows the active channel/"All channels" as
its current value, no width problem at any channel count, no custom
open/close/positioning code. The board view (no channel open) contributes
just 1 nav-points item, a plain "+" (New channel):
Global header:  🏠  ←  →  [+]  ⋯  🔔  👤   <- "+" = New channel only, next to Back/Forward
┌──────────────────────────────┐
│  ▾ All channels                │
├──────────────────────────────┤
│  Announcements                │
│  [topics...]                  │
└──────────────────────────────┘

Opening a channel adds a SECOND nav-points item ("New topic" - its own
route now, `#/forum/c/<id>/new-topic`, replacing the old inline title field
at the bottom of the topic list), so the header shows a dropdown instead of
a plain link:
Global header:  🏠  ←  →  [⋯▾]  ⋯  🔔  👤   <- 2 items now → a small dropdown, not a plain "+"
                          ├ New channel
                          └ New topic
┌──────────────────────────────┐
│  Announcements                 │  <- no inline "new topic" form here anymore
│  [topics...]                   │
└──────────────────────────────┘

AFTER (desktop, ≥720px) - unchanged, a persistent vertical sidebar:
┌────────────┬───────────────────┐
│ Channels   │  Announcements    │
│  All chan. │  [topics...]      │
│  General   │                   │
│  Team      │                   │
└────────────┴───────────────────┘
```

Forum was already compliant on Rule 1 (its subpages already used
`renderSubpage({ showBackLink: false })`). The migration moved its channel
list onto the shared `mountContextSwitcher()` shell (`variant: 'tabs'`, via
a `renderSidebar` override — its channel-list data fetch/live-watch logic is
non-trivial enough, like Calendar's calendars, to keep self-managed rather
than flattened into a plain `items` array) so it shares real CSS/layout with
Calendar's sidebar instead of a parallel, hand-maintained copy — and moved
"+ New channel" (and later, "New topic") into the global header's App
Navigation Points Slot (Rule 2), matching Calendar's/Chat's own shape for
"New channel" alone, and becoming the first REAL 2-item dropdown once "New
topic" joined it — rather than leaving either as an inline entry.

**A real bug shipped in the first version of this migration**, since fixed:
the reused `mountMiniChannelSidebar()` did `root.className = '...'` — a
blind assignment that silently wiped the `.qu-ctxswitch-sidebar` class
`mountContextSwitcher()` had already put on that same element, breaking its
own responsive CSS and producing exactly the "too wide, forces horizontal
scrolling" symptom shown above. **Lesson for any future `renderSidebar`
override**: only ever `classList.add()` your own class onto the `host`
element you're handed — never reassign `className` wholesale, since the
host is already carrying the shared component's own class.

**"New topic" trades one step of convenience for consistency**: it used to
be a title field right at the bottom of the open channel's topic list — type
a title, hit enter, done, no page change. It's now a real subpage
(`#/forum/c/<channelId>/new-topic`, reached via the header's Nav Points
dropdown) like every other "create X" in this codebase, which costs one
extra step (open the dropdown → New topic → the page → submit) in exchange
for a shareable/bookmarkable creation URL and the same shape Rule 2 already
gives every other dedicated-route action.

## What's explicitly out of scope (for now)

- **Chat has no Context Switcher yet.** It has no sidebar of any kind today
  — switching rooms means going back to `#/chat` and picking a different
  row. Building one is new functionality, not cleanup of existing chrome;
  the natural shape once someone picks it up is
  `mountContextSwitcher(..., variant: 'page')` (a room list can grow long —
  DMs plus groups — so `'page'`, not `'tabs'`).
- **ToDo has no Context Switcher either** — the exact same gap as Chat's,
  one level up: switching lists means going back to `#/todo` and picking a
  different row, with no way to jump straight from one open list to a
  sibling. ToDo IS on Rule 2 (`shell.headerNavPoints`, its "+ New task" icon)
  — only Rule 3 is unbuilt. It's a strong `variant: 'page'` candidate: its
  existing `#/todo` (list picker + create form) and `#/todo/manage`
  (rename/share/delete/leave) pages are already almost exactly the
  `renderSidebar`/`renderContextListPage()` shape Calendar's own calendar
  list uses — the natural next step is consolidating those two into one
  `renderSidebar` callback shared between a persistent sidebar (desktop,
  alongside an open list's tasks) and the full `/manage` page (mobile),
  the same way Calendar's migration did it.
- **Apps with no navigation chrome of their own** — Bookmarks, Notifications,
  Pins, Reactions, Contact List, User List, App List, Search, Relay Admin —
  are unchanged. They comply automatically, by following this doc and
  `apps/_template/`, whenever they grow a subpage or a create action.
