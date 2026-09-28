# LOAM client design system

The contract for everything drawn in `apps/client`. Wave 1 of the redesign built the tokens, primitives,
shell, sidebar and the keyboard fix; wave 2 moves the conversation and the screens onto them. If you are
adding UI, use what is here before writing new CSS, and add to this file when you add a primitive.

Principles: calm and warm (linen paper in light mode, dark loam in dark mode), moss green for structure and
primary actions, the brand orange for the mark, send, unread badges, mentions and focus. Chat conventions
people already know (WhatsApp, Telegram, Signal, Slack). Fast on old phones: native fonts only, no web
fonts, no icon fonts, no `backdrop-filter`, no heavy shadows.

## Files

| File | Holds |
|---|---|
| `src/global.css` | Only `@import`s, in this order. Vite inlines them. |
| `src/styles/tokens.css` | Every colour, size, radius, duration and z-index, light + dark. |
| `src/styles/base.css` | Reset, typography, links, the global focus ring, `.sr-only`, scrollbars, the no-scroll document. |
| `src/styles/components.css` | Icons, buttons, fields, badges, status pill, avatar, menu, dialog/sheet, toast, error banner, notice, empty state, day divider, card, list row, and the COMPAT block. |
| `src/styles/shell.css` | App frame, pane grid and breakpoints, screen header, sidebar/Home, invite dialog, gate screens, dev-mode banner. |
| `src/styles/conversation.css` | Message list, bubbles, actions, composer, thread panel, members panel, report dialog. **Wave 2 rewrites.** |
| `src/styles/screens.css` | Settings, admin, people, search, mesh, avatar editor. **Wave 2 rewrites.** |
| `src/components/icons.tsx` | The icon set. |
| `src/components/Dialog.tsx`, `Menu.tsx`, `ScreenHeader.tsx`, `Avatar.tsx` | The component primitives. |
| `src/lib/viewport.ts` | Keyboard-aware viewport sync (`--vvh`) and `onViewportResize`. |

Built CSS is about 48 KB minified (9 KB gzip). Keep it under 50 KB: wave 2 should delete more than it adds.

## Browser floor

Old Android WebViews (Chrome ~80) must render the app. So: no `oklch()`, `color-mix()`, `:has()`,
container queries or `backdrop-filter`. `dvh` only after a `vh` fallback line. Prefer physical
`top/right/bottom/left` for full-bleed boxes (the `inset` shorthand is Chrome 87). Flex `gap` is Chrome 84;
where spacing really matters on old devices, use grid. Logical properties everywhere else (below).

## Tokens

All on `:root` in `tokens.css`. Dark values apply under `prefers-color-scheme: dark` unless the page sets
`data-theme="light"`; `data-theme="dark"` forces dark (useful when testing; keep the two dark blocks in sync).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-app` | `#f3f0e8` | `#111412` | Page / pane background behind content |
| `--bg-surface` | `#faf9f5` | `#171b18` | Sidebar, headers, composer bar, cards |
| `--bg-elevated` | `#ffffff` | `#20251f` | Inputs, dialogs, menus, toasts |
| `--bg-sunken` | `#ebe7dd` | `#0c0e0d` | Wells, neutral badges, default `.btn` |
| `--bg-hover` / `--bg-active` | 6% / 11% ink | 6% / 11% paper | Hover and pressed/selected overlays |
| `--overlay` | 45% ink | 60% black | Dialog backdrop |
| `--fg` | `#1d2622` | `#e9ebe6` | Body text |
| `--fg-muted` | `#5b6862` | `#a3aca6` | Secondary text |
| `--fg-faint` | `#75817b` | `#7a847e` | Timestamps, ids, hints. **Never body text** (3.9:1 / 4.5:1) |
| `--border` / `--border-strong` | `#e1dcd1` / `#c6bfb0` | `#2a302c` / `#3b433e` | Dividers / control outlines |
| `--accent` (+ `-hover`, `-fg`, `-soft`) | `#f26b1d` | same | Brand orange: mark, send, unread, mentions, focus |
| `--primary` (+ `-hover`, `-fg`, `-soft`) | `#2f5f4c` | `#3a745b` | Moss: primary buttons, active states. White on it 7.3 / 5.5 |
| `--link` | `#2f5f4c` | `#7cb79e` | Links and link-coloured text on tinted fills |
| `--bubble-theirs` (+ `-fg`, `-border`) | `#ffffff` + border | `#232925` | Other people's bubbles |
| `--bubble-mine` (+ `-fg`) | `#d9ecd8` | `#2e4c3b` | Own bubbles |
| `--success` | `#2f8f5b` | `#6fcf97` | |
| `--danger` / `--danger-bg` | `#c9302c` / `#fbeeed` | `#ff8a80` / `#2a1715` | Error text on surfaces / error wells |
| `--danger-solid` (+ `-hover`) | `#c9302c` | same | Fill behind white text (destructive buttons, error banner) |
| `--online` | `#33c27a` | same | Presence dot, live status |
| `--focus` | `var(--accent)` | | Focus rings |
| `--shadow-1` / `--shadow-2` | | | Resting surfaces / floating layers |
| `--code-bg` / `--code-fg` | `#16271f` / `#dce8dd` | same | Code blocks stay dark in both themes |

**Contrast.** Every text pair above passes WCAG AA. The orange with white on it is 3.05:1: fine for icons,
badges, focus rings and bold large text, **not** for body-size text. So `.btn-accent` carries an icon or a
one-word label; primary text buttons are moss. `--fg-faint` is for metadata only.

## Type, space, radii, motion

- Font: `--font-sans` = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
  `--font-mono` = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. No custom fonts, ever.
- Size scale (px): `--text-xs` 12 · `--text-sm` 13 · `--text-md` 14 · `--text-base` 15 (body) · `--text-lg`
  16 · `--text-xl` 18 · `--text-2xl` 22 · `--text-3xl` 28. Inputs, selects and textareas are 16px so iOS
  never zooms. `--leading` 1.45, `--leading-tight` 1.25.
- Weights: 400, 600, 700 only.
- Space: `--space-1` 4 … `--space-8` 32 (4px steps).
- Radii: `--radius-sm` 6 · `--radius` 10 · `--radius-lg` 14 · `--radius-xl` 18 · `--radius-full` 999.
- Motion: `--duration-fast` 120ms, `--duration` 160ms, `--ease-out`. Every transition and animation sits
  inside `@media (prefers-reduced-motion: no-preference)`.
- Layout: `--header-h` 56, `--control-h` 44, `--control-h-sm` 36, `--sidebar-w` 280 (260 on tablet),
  `--thread-w` 360 (320 on tablet).
- Z-index: `--z-popover` 70 < `--z-toast` 80 < `--z-banner` 90 < `--z-dialog` 100.
- Section headings use weight 600, `--fg-muted` and `letter-spacing: 0.02em`. Never `text-transform`
  (it breaks in several of our 15 locales).

## RTL

Arabic, Persian, Dari, Pashto and Urdu render right-to-left (`document.documentElement.dir`). Use logical
properties: `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-inline-start`,
`text-align: start`. Never `left`/`right` except for symmetric full-bleed boxes. Directional icons carry
`icon-flip-rtl` (back, chevron-right, send, reply) and mirror automatically.

## Breakpoints and panes

| Width | Layout |
|---|---|
| Phone `< 720px` | One pane at a time. Home is the sidebar as a full screen with an app bar. Everything else is full screen with a `ScreenHeader` whose back chevron returns Home. |
| Tablet `720–1023px` | Sidebar 260px + content. A thread shows beside the conversation from 900px; below that it replaces the conversation (close with ×). |
| Desktop `≥ 1024px` | Sidebar 280px + content + thread 360px. |

Media queries use `max-width: 719.98px` / `min-width: 720px` (and 899.98/900, 1023.98/1024). `app.tsx` sets
the pane classes on `.app-shell` and the CSS does the switching: `has-conversation`, `no-conversation`,
`settings-open` (settings, people, admin, search, mesh) and `thread-open`. Keep those names.

Every pane (`.sidebar`, `.conversation`, `.thread-panel`, `.settings-view`) is a **flex column** that fills
its grid cell with `overflow: hidden`. Exactly one child grows (`flex: 1 1 auto; min-height: 0`) and
scrolls; every other child is `flex: none`. Never give a pane a fixed row grid: an extra child (a typing
indicator, a banner) must not be able to push the composer off screen.

## Viewport and keyboard

The old layout used `100dvh` blocks, so when the on-screen keyboard opened the browser scrolled the whole
document to reveal the textarea: header gone, gap above the composer. Now:

1. `index.html` sets `interactive-widget=resizes-content` (and `viewport-fit=cover`), so Chrome 108+ shrinks
   the layout viewport with the keyboard.
2. `html, body { height: 100%; overflow: hidden; overscroll-behavior: none }`: the document can't scroll.
   The app lives in `.app-frame`, `position: fixed` to the edges, with `top: var(--vv-top)` and
   `height: var(--vvh)` (with `100vh`/`100dvh` fallbacks). The frame pads the top/side safe areas; bottom
   bars (composer, sidebar footer, sheets) pad `env(safe-area-inset-bottom)` themselves.
3. `src/lib/viewport.ts` (`installViewportSync()`, called in `main.tsx`) mirrors `visualViewport.height`
   into `--vvh` and `offsetTop` into `--vv-top` on every visual-viewport resize/scroll (window resize as a
   fallback), ignores a pinch-zoomed viewport, and calls `scrollTo(0, 0)` if the document scrolled anyway.
   This covers browsers that shrink only the visual viewport (iOS Safari, older WebViews).
4. `onViewportResize((height) => …)` returns an unsubscribe function. It fires after `--vvh` changes.
   **Wave 2:** the message list subscribes to it and re-pins to the bottom when it was at the bottom before
   the keyboard opened.

Only inner areas scroll: `.message-list`, `.thread-scroll`, `.sidebar-scroll`, a screen's body, a dialog's
body. Give each `overscroll-behavior: contain`.

## Icons (`components/icons.tsx`)

Inline SVG, 24×24 viewBox, 2px round strokes in `currentColor`, `aria-hidden`. Props: `size` (default 20),
`className`. The enclosing button or link carries the accessible name.

`IconBack` · `IconClose` · `IconSend` · `IconAttach` · `IconMore` (vertical kebab) · `IconReply` ·
`IconSmile` · `IconEdit` · `IconTrash` · `IconFlag` · `IconSearch` · `IconSettings` · `IconHash` ·
`IconLock` · `IconUsers` · `IconCheck` · `IconPlus` · `IconChevronRight` · `IconWifi` · `IconMail` ·
`IconShield` · `IconMapPin`.

`BackArrowIcon.tsx` is a thin re-export of `IconBack` for old imports. Sizes in use: 20 in buttons, 18 in
sidebar rows, 16 in dense per-message actions.

```tsx
<button aria-label={t("common.dismiss")} className="btn btn-icon btn-ghost" type="button">
  <IconClose />
</button>
```

## Buttons

`.btn` is the base (44px tall, `--radius`, 15px/600, icon + label with an 8px gap). Add one variant:

| Class | Look | Use |
|---|---|---|
| `.btn-primary` | Moss fill, white text | The main action of a form or screen |
| `.btn-secondary` | Elevated fill, strong border | Other actions |
| `.btn-ghost` | Transparent | Low-emphasis actions, toolbar icons |
| `.btn-danger` | `--danger-solid` fill, white text | Destructive confirmations |
| `.btn-accent` | Orange fill, white | Send, and icon/one-word actions only |

Modifiers: `.btn-sm` (36px, `--radius-sm`, 14px), `.btn-block` (full width), `.btn-icon` (round, 44px on
touch / 36px with a fine pointer; `.btn-icon.btn-sm` is 32px on desktop; needs `aria-label`), `.is-active`
(selected icon button). `:disabled` and `[aria-disabled="true"]` fade to 50%. Hover is a translucent
overlay, so it works on every fill in both themes. `.link-button` is a button that looks like a link.

```tsx
<div className="dialog-actions">
  <button className="btn btn-secondary" onClick={onCancel} type="button">{t("common.cancel")}</button>
  <button className="btn btn-primary" type="submit">{t("common.save")}</button>
</div>
```

`NavLink` accepts `className`, so a link can be a button: `<NavLink className="btn btn-icon btn-ghost" …>`.

## Fields

```tsx
<label className="field">
  <span className="field-label">{t("…label")}</span>
  <input className="input" … />
  <span className="field-hint">{t("…hint")}</span>
</label>
```

`.input`, `.select`, `.textarea` are 44px (textarea 88px, vertical resize), 16px text, `--bg-elevated`,
`--border-strong`. Focus is a 2px orange edge (border + 1px ring). `.field.has-error` turns the control's
border red; put the message in `.field-error` (`.form-error` / `.form-note` are the same styles and remain).
`.check-row` is a 44px checkbox or radio row whose whole label is the hit target. `<input type="checkbox"
className="toggle">` is a switch. The checkbox accent colour is moss.

## Badges and status

- `UnreadBadge` → `.unread-badge`: orange pill, white 12px bold, caps at 99+.
- `.badge` (neutral), `.badge-primary`, `.badge-accent`, `.badge-danger`: 22px pills for roles and states.
- `.status-pill.status-{live|connecting|offline}` with a `.status-dot` child: green / pulsing orange / red
  dot plus the word. Used under the node name and on the gate screens.

## Avatar (`components/Avatar.tsx`)

`<Avatar id avatar size presence />`. `size`: `xs` 20 · `sm` 28 · `md` 36 · `lg` 44 · `xl` 96 (adds
`.avatar-<size>`). One rounding for every mode: `border-radius: 23.4%`, the same as the pattern/initial
art's `rx 30/128`, so nothing is double-rounded; the face art is full-bleed and reads uncropped from 20px
to 96px. A 1px `--avatar-ring` is drawn on top via `::after`. `presence="online"` wraps it in
`.presence-anchor` with a green `.presence-dot` (role `img`, labelled "Online"); the dot's ring colour is
`--presence-ring` (set it to the row's background).

Use sizes, not context selectors: rows `sm`, headers and message authors `sm`/`md`, the sidebar footer
`md`, settings identity `xl`. Legacy context rules (`.message > .avatar` etc.) still size avatars that have
no `size` prop; wave 2 removes them as it adds sizes.

## Dialog (`components/Dialog.tsx`)

Render it conditionally (mounted = open):

```tsx
{open ? (
  <Dialog onClose={() => setOpen(false)} title={t("report.userTitle")}>
    …body…
    <div className="dialog-actions">…buttons…</div>
  </Dialog>
) : null}
```

Props: `onClose`, `title`, `variant` (`"auto"` default: a bottom sheet under 720px, a centred card above;
`"sheet"`; `"dialog"`), `hideTitle` (screen-reader-only heading), `showClose`, `closeLabel`,
`role="alertdialog"` for interrupting confirmations, `className` / `backdropClassName`, `titleId`.

What it does for you: `role="dialog"` + `aria-modal` + `aria-labelledby`; focus moves to the panel on open
(or stays on a child that focused itself); Tab cycles inside (`lib/focus-trap`); Escape, a backdrop tap,
the × and dragging the sheet's handle down all call `onClose`; focus returns to the element that had it
before. Only the top-most open dialog reacts to Escape. The sheet has a drag handle, rounded top corners
and bottom safe-area padding, and slides up (reduced-motion aware). It renders in place with
`position: fixed`, so never put `transform`, `filter` or `contain` on a pane that can host one.

## Menu (`components/Menu.tsx`)

```tsx
<Menu
  label={t("…moreActions")}
  items={[
    { label: t("block.block"), icon: <IconFlag />, onSelect: confirmBlock, danger: true },
    { label: t("report.userTitle"), icon: <IconFlag />, onSelect: () => setReportUserId(peer.id) },
  ]}
/>
```

A kebab trigger (`.btn.btn-icon.btn-ghost.menu-trigger`, `aria-haspopup="menu"`, `aria-expanded`) that
opens a `role="menu"` of `menuitem`s. Items: `{ label, icon?, onSelect, danger?, disabled? }`. Under 720px
it opens as a `Dialog` sheet with 52px rows; wider, a fixed-position popover under the trigger (flipped
above when there's no room below, aligned to the inline end). Keyboard: arrows/Home/End move (disabled
items skipped), Escape closes and refocuses the trigger, Tab closes; an outside press, scroll or resize
closes the popover. Choosing an item closes the menu first and then runs `onSelect`, so an action that
opens a dialog gets focus cleanly. `trigger` swaps the icon; `presentation` forces `"sheet"`/`"popover"`.

## ScreenHeader (`components/ScreenHeader.tsx`)

The 56px bar on every screen: `[back] [leading] title/subtitle … [actions] [⋮]`.

```tsx
<ScreenHeader
  leading={<Avatar id={peer.id} avatar={peer.avatar} size="md" />}
  title={peer.displayName}
  subtitle={online ? t("sidebar.online") : undefined}
  actions={<button aria-label={t("…")} className="btn btn-icon btn-ghost" type="button"><IconSearch /></button>}
  menuItems={[…]}
  menuLabel={t("…moreActions")}
/>
```

Props: `title`, `subtitle`, `backHref` (default `/channels`; `false` for none), `onBack` (a button instead
of a link, e.g. closing a thread), `alwaysShowBack` (show the back control at every width), `leading`,
`actions`, `menuItems` + `menuLabel`, `headingLevel` (1, or 2 beside a conversation), `titleId`,
`className`. The title is the only flexible column and ellipsizes; actions never shrink. So one or two
icon actions at most; everything else goes in `menuItems`. The back control (`.mobile-back`) is shown
only under 720px unless `alwaysShowBack`.

Search, Settings, People, Mesh and Admin already use it (title only; the old eyebrows were dropped).

## Other primitives

- **Toasts** (`components/ToastStack.tsx`): bottom inline-end corner on tablet/desktop; on phones just under
  the 56px screen header (the composer owns the bottom). Elevated card, 14px title, 13px two-line body.
  Messages in one conversation coalesce into one toast ("3 new messages in #general", the `toast.newMessages`
  plural, over the newest message) and at most two conversations show at once; tapping dismisses the group.
  `ToastItem.place` / `.author` feed the coalesced text.
- **Screen layout** (`screens.css`): under a `ScreenHeader`, one scrolling `.screen-body` holding a
  `.screen-column` (max 720px, centred, 16px gutters on phones, 16px gap) of `.card`s; cards get 20px
  padding from 720px up. `.empty-note` for "nothing here yet", `.screen-footnote` for a closing link.
- **Card parts** (`components/ScreenParts.tsx`): `CardHeader` (`title`, `description`, trailing `actions`,
  `level` 2 or 3) → `.card-header`; `.card-actions` (right-aligned button row; `.card-actions-start`),
  `.card-section` (a hairline-separated sub-part with a `.card-subtitle`), `.card-danger` (red border and
  title, for danger zones), `.field-grid`, `.inline-field` (input + button), `.mono-field`, `.select-sm`.
- **Switch rows**: `SwitchRow` (`label`, `description`, `checked`, `onChange`) is a 52px `label.switch-row`
  with the text on the start side and `input.toggle` on the end; stack them in `.switch-list` for
  hairlines between.
- **Row text**: inside a `.list-row`, `.row-text` > `.row-title` + `.row-meta`; `.row-actions` for trailing
  `.btn-sm`s; `.row-detail` spans the full width under the row (an error, an inline form).
- **ConfirmDialog** (`components/ConfirmDialog.tsx`): the `role="alertdialog"` confirmation for destructive
  actions (wipe, Emergency Reset, ban, delete channel, make admin). Title, consequence, optional typed-word
  guard (`confirmWord="wipe"`, passed back to `onConfirm(typed)`), Cancel + a danger (or `danger={false}`
  primary) button; focus lands on Cancel or the word field. No `window.confirm` in the screens any more.
- **Error banner** (`ErrorBanner`): top-centred, `--danger-solid` with white text, icon close button.
- **Notice**: `.notice` (neutral well) / `.notice-danger` for inline messages inside a screen.
- **Empty state**: `.empty-state > div` with an optional `.eyebrow`, a heading and muted copy.
- **Day divider**: `.day-divider > span`, a small centred pill.
- **Card**: `.card` (surface, border, `--radius-lg`, 16px padding, 12px gap) with `.card-title`.
- **List rows**: `ul.list > li.list-row` (auto | 1fr | auto grid, 52px, hairline between rows).
- **Gate screens** (`GateScreen` in `app.tsx`, and `ErrorBoundary`): `.gate-screen > .gate-card` with the
  56px mark (`.gate-mark`), heading, muted copy and an optional `.status-pill.gate-status`.
- **Dev-mode banner**: first child of `.app-frame`, red, above every screen.

## Sidebar / Home (`components/Sidebar.tsx`)

App bar: 28px mark, node name (18px on phones), `.status-pill` with the connection dot; trailing search
(and, on phones, settings) icon buttons. Scroll area: "Channels" (hash or lock glyph, name, unread badge;
`New channel` row with a plus), "Direct Messages" (28px avatar with presence, name, badge; hidden when you
are alone), then a tools group (Invite someone, People, Mesh mail, Admin, as permitted). Footer: your
avatar (`md`), name, id in `--fg-faint`, and a settings gear (hidden on phones, where the app bar has
one). Rows are 44px (52px on phones); the active row has `--bg-active` and a 3px orange bar on the
inline-start edge; rows with unread messages are semibold. It follows the theme (no longer a permanently
dark panel). DOM hooks the tests use: `.nav-link`, `.nav-label`, `.nav-glyph`, `.unread-badge`,
`.new-channel-toggle`, `.new-channel-form`, `.status-pill.status-*`, `.invite-trigger`, `.invite-modal*`.

## i18n

Every user-facing string goes through `t()`. New keys go in `src/i18n/en.ts` only; the other catalogs fall
back to English at runtime. **But** `i18n.test.ts` has a release gate, "every shipped locale covers every
en key", which fails as soon as `en.ts` gains a key the 14 other catalogs lack. Wave 1 added no keys (it
reused existing ones, made `Menu`'s label a required prop, and changed only the English *value* of
`newChannel.new` to drop its "+"; the sidebar strips a leading "+" from older translations). Wave 2 will
need new keys (e.g. "More actions", "Copy text"). The orchestrator must choose: run the batched translation
pass, or add an explicit, reviewed "pending translation" allowlist to that test. Don't quietly weaken it.

## COMPAT (delete in wave 2)

- No `--c-*` tokens remain; `conversation.css` and `screens.css` were moved onto the new tokens directly,
  so there is no token alias block to delete.
- `components.css` ends with a COMPAT block: unclassed `button`s, `.ghost-button`, `.danger-button`,
  `.close-button`, `.admin-toggle`, and `.invite-modal-backdrop` / `.invite-modal` / `.invite-modal-header`
  for `ReportDialog`'s hand-rolled overlay. `screens.css` has "Legacy button rows" (`.profile-actions
  button` and friends). Remove each as its last user moves to `.btn` / `Dialog` / `.check-row`.
- `.wiped-screen` stays as a second class on gate screens only for anything still selecting it.

## Wave 2 checklist

Conversation agent (`ConversationView`, `MessageItem`, `MessageComposer`, `ReportDialog`,
`ChannelMembersPanel`, `LocationCard`, `Attachment*`; rewrite `conversation.css`):

- [ ] Header → `ScreenHeader`: channel glyph or DM avatar as `leading`, the channel topic or presence as
      `subtitle`; "Report this user", "Block" and "Members" move into `menuItems` (the DM title must never
      be truncated by buttons again). Thread panel header → `ScreenHeader` with `onBack` + `headingLevel={2}`.
- [ ] Bubbles with the time inside (bottom inline-end corner, `--fg-faint`-ish on the bubble), not on a
      line above; author name only on the first bubble of a group.
- [ ] Group consecutive messages from the same author within a few minutes: one avatar (`sm`, aligned to
      the group's last bubble, not floating below it), tighter gaps, tail only on the last bubble.
- [ ] Hover actions on desktop (a small floating toolbar: react, reply, ⋮), long-press / ⋮ on touch opening
      the `Menu` sheet with react, reply, edit, delete, report. No permanently visible per-message icon row.
      The invisible quick-reaction buttons currently take space and push "Reply" off to the side.
- [ ] Reactions as compact pills under the bubble; reply count as a link-style pill.
- [ ] Pill composer: attach and location as `.btn-icon.btn-ghost` inside a rounded field, auto-growing
      textarea, `.btn-accent` round send button, all bottom-aligned; safe-area bottom padding.
- [ ] Typing indicator inside the list area (absolutely positioned just above the composer, or as the last
      list item), not a flex row between list and composer.
- [ ] Message list subscribes to `onViewportResize` and re-pins to the bottom when the keyboard opens.
- [ ] `ReportDialog` → `Dialog`; `ChannelMembersPanel` → a `Dialog` sheet or a card; blocked-DM banner →
      `.notice`; jumbo emoji, mentions (`--accent` edge), removed/edited states on tokens.
- [ ] Replace the remaining `.ghost-button` / `.danger-button` / `.close-button` / bare buttons with `.btn`
      classes, give message avatars a `size`, and delete the matching COMPAT rules.

Screens agent (`app.tsx` SettingsView / PeopleView / SearchView / MeshView, `AdminView` and its panels,
`BlockedUsersPanel`, `AvatarImageEditor`, `NodeLinkControl`, `AddSyncPeerControl`, `SyncStatusPanel`,
`LlmPanel`, `MeshPanel`, `GettingStartedPanel`, `SearchResult`; rewrite `screens.css`):

- [x] Settings, admin, people, search and mesh on the card system: `.card` sections with `.card-title`,
      `.field` / `.input` / `.select` / `.check-row` / `.toggle` controls, `.list` / `.list-row` for people,
      peers, blocked users and reports, `.badge-*` for roles/states, `.btn` variants for every button.
      (The views now live in `src/views/`; admin has a section-pill nav and a sticky Save bar.)
- [x] One column on phones, a comfortable max width (about 720px) centred on desktop instead of the old
      two-column grid.
- [x] Search: search field in or under the `ScreenHeader`, results as list rows.
- [x] Avatar editor and identity panel use `Avatar size="xl"`.
- [x] Destructive actions (wipe device, kill switch, ban) confirm with `Dialog role="alertdialog"`
      (`ConfirmDialog`; channel delete and make-admin too).
- [x] Strings: `invite.wifiButton` → "Open the host's share screen"; `invite.wifiHint` → "Shows the
      hotspot or Wi-Fi join QR from the host app." (All 15 catalogs updated.)
- [x] Delete the "Legacy button rows" section and the COMPAT rules this makes unused.
