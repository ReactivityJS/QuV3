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

## The four rules

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

### Rule 2 — The App Action Slot

"Create new X" — an event, a group, a channel, anything with **its own
dedicated route** — is a single icon in the shell header's existing
`shell.headerAction` extension point, visible **only while that app is the
active one**. It is never a floating action button, an inline link buried at
the bottom of a list, or a second element competing with the header.

Something that's composed *inline*, in place, has no dedicated route — a
chat message, Chat's/Forum's composer "+" menu for attach/share-location,
Forum's "new topic" title field at the bottom of an already-open channel —
stays inline. The rule is about *navigating to a new top-level page*, not
every form on screen.

`@qu/ui`'s `mountAppHeaderAction()` handles the "only show while my app is
active" boilerplate, so every app's contributor looks the same:

```js
// your app's client.js
import { mountAppHeaderAction } from '@qu/ui';

export function renderHeaderAction(container, { getContext, onContextChange, services }) {
  mountAppHeaderAction(container, {
    appId: 'yourapp', getContext, onContextChange,
    render: (wrap) => {
      const link = document.createElement('a');
      link.className = 'qu-app-action-btn'; // shared icon styling, injected by mountAppHeaderAction itself
      link.textContent = '+';
      link.title = 'New thing';             // Rule 4 - always a real tooltip
      link.setAttribute('aria-label', 'New thing');
      link.href = '#/yourapp/new';
      wrap.appendChild(link);
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
  { "point": "shell.headerAction", "export": "renderHeaderAction", "kind": "ui", "order": 10 }
]
```

(`order: 0` is `apps/search`'s own always-visible icon — use `order: 10` or
higher so Search's icon stays leftmost/consistent across apps.)

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

## Building a new app? A checklist

1. Copy `apps/_template/` — it implements all four rules above, working and
   tested. Rename the directory, `manifest.quapp`'s `name`/`label`/`icon`,
   and restore `"clientMain": "./dist/client.js"` (the template omits it on
   purpose, so it's never itself bundled/catalog-listed).
2. No custom back link, anywhere. `renderSubpage({ showBackLink: false })`
   for every subpage.
3. One `shell.headerAction` contribution if you have a "create new X" action
   that navigates to its own route. Nothing if every create action is
   composed inline (a form at the bottom of a list, a composer).
4. `mountContextSwitcher()` if you have more than one sibling place to be —
   `variant: 'tabs'` for a short/stable list, `variant: 'page'` for a longer
   one or one with its own management UI.
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
Global header:  ←  →  🏠 …  [+]  🔔  👤   <- "+" lives here now, only while Calendar is active
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
Global header:  ←  →  🏠 …  [+]  🔔  👤   <- "+" lives here now, only while Chat is active
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
BEFORE (mobile, already close to the standard):
┌──────────────────────────────┐
│ [General] [Team] [Support] +  │  <- own tab-strip CSS, own sidebar CSS
├──────────────────────────────┤
│  Announcements                │
│  [topics...]                  │
└──────────────────────────────┘

AFTER (mobile) - same look, now the SHARED component (mountContextSwitcher,
variant: 'tabs') instead of Forum's own bespoke sidebar/media-query CSS -
the exact same component Calendar's desktop sidebar shell is built from:
┌──────────────────────────────┐
│ [General] [Team] [Support] +  │
├──────────────────────────────┤
│  Announcements                │
│  [topics...]                  │
└──────────────────────────────┘
```

Forum was already compliant on Rule 1 (its subpages already used
`renderSubpage({ showBackLink: false })`) — the only change was moving its
channel list onto the shared `mountContextSwitcher()` shell and its "+ New
channel" link into that component's `newItem` slot, so it shares real CSS
with Calendar's sidebar instead of a parallel, hand-maintained copy.

## What's explicitly out of scope (for now)

- **Chat has no Context Switcher yet.** It has no sidebar of any kind today
  — switching rooms means going back to `#/chat` and picking a different
  row. Building one is new functionality, not cleanup of existing chrome;
  the natural shape once someone picks it up is
  `mountContextSwitcher(..., variant: 'page')` (a room list can grow long —
  DMs plus groups — so `'page'`, not `'tabs'`).
- **Apps with no navigation chrome of their own** — Bookmarks, Notifications,
  Pins, Reactions, Contact List, User List, App List, Search, Relay Admin —
  are unchanged. They comply automatically, by following this doc and
  `apps/_template/`, whenever they grow a subpage or a create action.
