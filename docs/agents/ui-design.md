# UI design

- **An element keeps the same font weight in every interaction state.** Inactive, active,
  selected, checked, open, hover, focus, disabled, loading and error never change it.
  Bold stays bold, normal stays normal. Put weight classes in the base style, never in
  conditional branches or state variants, and never animate font weight. Show state with
  colour, background, border, an indicator or an icon. Preserve the typography hierarchy
  between distinct elements and static layout variants.

- **ENV bulk actions use the shared floating `SelectionBar`**, matching Overview and Storage.
  Show it at the bottom of the viewport only while rows are selected, never as an inline toolbar.
  Keep only one ENV section selected at a time so App variables and preview overrides cannot overlap.

- **Default is RSC**; `"use client"` is leaf-ish (state/effects/forms). RSC pages `await`
  `lib/data`/`lib/auth`/`lib/membership` and pass plain props down.
- **Mutations go through GraphQL, not server actions.** Use `lib/graphql-client.ts` (`gql`,
  `gqlAction`) and the `useGraphqlMutation` hook (`useTransition` + auto `router.refresh()`).
  Inline the query string tagged `/* GraphQL */`. **No `revalidatePath`** - `router.refresh()`
  re-runs RSC reads; subscriptions via `gqlSubscribe` (SSE).
- **Toasts:** `import { toast } from "sonner"`; surface the server's message verbatim
  (`toast.error(res.error)`), don't invent generic copy.
- **Descriptive copy is SHORT and self-explanatory.** Every description, subtitle, empty state,
  tooltip and field help is one line a non-expert understands without stopping to parse it. Say
  what the thing does or what to do next; don't restate the control's own label, don't narrate
  implementation, don't explain Docker. If it needs a paragraph to make sense, the UI is wrong, not
  the copy. Errors and server messages are the exception: surface those verbatim.
- **The copy caps are a TEST, not a taste.** `copy-length.test.ts` fails the build over
  **120** characters in a modal description, **160** in an `info=` / `content=` tooltip and
  **200** in a muted paragraph - counted per BRANCH, so a ternary cannot hide a paragraph
  behind a condition. Over the cap means the sentence is carrying something the manual
  should: cut it and end the line with a `<DocsLink>`, never reword it to fit.
- **In a modal, the words that matter are WHITE.** `DialogDescription`, `SheetDescription`
  and a wizard's `lead` style their own `<strong>` as `text-foreground`, so the emphasis is
  a `<strong>` and nothing else - no `className="text-foreground"` at the call site, no
  second component. One phrase per description, the one the reader must not miss. This is
  a MODAL affordance: on a page the emphasis is the sentence being short.
- **A destructive confirm never puts the cost behind a link.** What the action destroys goes
  in the red box - `consequence=` on `ConfirmAction` / `DeleteWithArtifacts`, or
  `<ConsequenceNote>` in a hand-rolled dialog - in one concrete sentence. The description
  above it says what the action IS; the box says what it costs. Not both, and never the cost
  only in the manual.
- **The label names the thing; the tooltip carries the WHY.** Not "the tooltip carries everything":
  a tooltip does not exist on touch and screen readers lose it, and every major design system says
  so out loud - Vercel's own guidelines are "inline help first; tooltips last resort", Geist forbids
  wrapping a labelled input in one, Primer calls them "the last resort". So: the **label** is the
  noun. The **tooltip** (`FieldLabel info=` / `InfoTip`) carries the constraint, the limit or the
  reason - never a restatement of the label, never a description of an interaction. A **consequence
  of what you are about to do** stays VISIBLE (changing the server copies the data; this command
  will be detected, not skipped). Everything else is a docs page.
  What this kills is prose that explains a control the control could explain itself: "The archive is
  extracted and built with the Build & Output settings below. Use Save & Deploy to build and release
  it." Section hints, stage descriptions and "what this does" blurbs go in the title's tooltip.
  **The strongest version of this rule is not moving the words but removing the need for them** - an
  empty box behind an "(auto-detected)" placeholder needs a paragraph, and a plain field whose
  placeholder IS the default needs none - reference `components/apps/settings/build-output-card.tsx`,
  where plain fields replaced an override switch that hid the very command it was explaining.
- **Never invent a name for a thing the world already names.** If a control, pattern or concept
  already has a label every user has seen a hundred times, use THAT label - exactly, not a
  synonym you find tidier. It is **"Select all" / "Unselect all"**, never "Select these" /
  "Clear these"; **Save**, **Cancel**, **Delete**, **Search**, **Copy**, **Rename**, **Duplicate**,
  **Import** / **Export**, **Sign in** / **Sign out**. A familiar word costs the reader nothing;
  a fresh one costs them a pause on every encounter, and a screenful of them makes a product feel
  like it was written by someone who had never used software.
  **Before writing any button, menu item or column header, check whether the repo already spells
  it** (`grep` the string across `components/`) and match the existing spelling - the same control
  must not be called two things in two places. Only invent a word when the thing itself is genuinely
  new, and then put it in `CONTEXT.md` so it stays the only spelling.
- **Field help lives in the tooltip:** `FieldLabel info={…}` / `InfoTip` (`components/ui/info-tip.tsx`) -
  don't duplicate it as helper text below the input.
- **A description under a title always gets a gap.** Any muted description stacked under its own
  title (setting rows, card subtitles, list rows, empty states) carries **`mt-1`**, or its wrapper
  carries `space-y-1`, never both. Two stacked lines with no spacing read as one cramped block; the
  4px is what separates them. The rule is global, not per-screen: a card that skips it misaligns
  with every sibling in the same grid.
- **Controls that sit on the same row are the same height.** A `Button` next to an `Input`,
  `SelectTrigger`, or any other form control must match its height, and the mismatch is real:
  `Button size="sm"` is **h-8** while `Input` / `SelectTrigger` / the facet triggers are **h-9**, so
  the house default (`size="sm"`) is the WRONG one on a toolbar and lands the button 4px short.
  Use the default size there and keep `sm` for rows that hold no input (a section heading, a card
  header, a table cell). **Fix any height discrepancy you find between an input and a button** -
  it is never "close enough", it reads as a broken row, and one short control makes the whole
  toolbar look misaligned. Same button in two homes: take the size as an argument
  (`const addButton = (size: "sm" | "default") => …`) instead of writing it twice.
- **An empty state does not repeat an action the screen already shows.** If the section heading or
  the toolbar above it already carries the button, the empty state gets a graphic, a title and a
  description - and nothing else. Give it an `action` only when it is the ONLY way to act: a target
  whose toolbar is hidden while the list is empty puts the button in the heading row instead, so
  there is exactly one at any moment. Reference: `components/env/env-manager.tsx`.
- **Every dialog with fields is a real `<form>` - Enter submits.** Wrap the body + `DialogFooter`
  in `<form className="grid gap-4" onSubmit={…}>` (matching `DialogContent`'s own grid, so the
  layout is unchanged), `preventDefault()`, and give the primary button `type="submit"` instead of
  an `onClick`. Keep its `disabled` guard - a disabled default button is exactly what makes Enter a
  no-op while the form is invalid. **Never fake it** with `onKeyDown={(e) => e.key === "Enter" && …}`.
  `Button` defaults to `type="button"`, so Cancel never submits by accident; a raw `<button>` you
  add inside a form must spell out `type="button"` itself. Pattern reference:
  `components/apps/create-folder-dialog.tsx`.
- **A modal never jumps: its height animates.** Content that appears, disappears or arrives
  after a fetch (a field revealed by a choice, an error, a warning, a step) grows and shrinks the
  dialog smoothly. A plain `DialogContent` does it on its own (`AnimatedHeight` inside its scroll
  area), so nothing is needed there. A `selfManaged` dialog wraps the changing part in
  `AnimatedHeight`, or uses `SlidingPanels`, or has a fixed height - `dialog-height.test.ts` fails
  on one that does none of them. A nested `AnimatedHeight` steps aside, so wrapping twice is
  harmless.
- **A page that is a header plus a tab bar has ONE vertical rhythm: `space-y-3`,
  everywhere.** The page wrapper (`PageHeader` → the tab bar) and the `Tabs` root (tab
  bar → its content) both carry it, so the same three pages cannot drift apart - MCP,
  Migrations and Storage had 6/8/6 and 6/10/none, and the same tab bar sat at a
  different height on each. 24px is too much between a title and the tabs that belong
  to it; they are one control, not two sections. This measure is for THIS shape only -
  a page of stacked cards keeps its own spacing, and `TabsContent`'s internal
  `space-y-*` is the content's business, not the rhythm's.
- **A dialog footer with exactly two controls SPLITS: the secondary far left, the primary far
  right.** Cancel is not a peer of the thing it cancels, and sitting next to it is how a stray
  click lands on the wrong one. Any other footer - a third button, a hint beside the buttons -
  keeps them together on the right, where a row of peers belongs. **`DialogFooter` does this
  itself**, by counting its children (`React.Children.toArray`, so a `{cond && <Button/>}` that
  renders nothing does not count): never hand it `sm:justify-between`, and pass `sm:justify-end`
  only to opt a two-control footer out. A primary that appears on a condition would move the
  secondary across the footer, so mount it always and disable it instead.
- **Status is shown LIVE** via `AppStatusBadge`/`AppStatusDot` (a `useLiveStatus`
  subscription), not the raw stored `status`. `idle`/`stopped` render **grey ("Stopped")**; red is
  reserved for `error`/`failed`.
- **Tailwind v4 is CSS-first, no `tailwind.config`.** Add tokens in `app/globals.css`
  (`:root`/`.dark` + `@theme inline`); **never hardcode colors** - use token utilities
  (`bg-background`, `text-muted-foreground`). App defaults to dark; theme is a **custom provider**
  (`useTheme` from `@/components/theme-provider`, not next-themes), zero-flash via the `theme`
  cookie read in `app/layout.tsx`. `cn()` from `@/lib/utils`; the only path alias is `@/* → ./*`.
- **The dotted ground is the surface that ANSWERS THE MOUSE**, not a decoration: the three
  grids where cards drag and marquee-select (`/`, `/apps`, `/storage` - the homes of
  `use-card-selection`), and nowhere else (`isDottedRoute`,
  `components/layout/shell-frame.tsx`). A resource's own pages, lists, streams, forms and
  settings are reading surfaces and stay flat.
- **Every FILL is opaque - never `bg-<token>/<alpha>`.** A translucent surface lets that
  ground through it, and a veil over a plain page is a colour nobody chose. Neutral surfaces are
  `bg-surface` / `bg-surface-strong`, a tint is `bg-<colour>-wash` / `-wash-strong`
  (`primary`, `destructive`, `warning`, `success`, `info`, `violet`) - all composed onto
  `--background` with `color-mix` in `app/globals.css`, so they are real colours, not veils.
  The ONLY alpha backgrounds left are the ones that must show what they cover: `bg-black/*`
  (a dialog or sheet backdrop) and `bg-background/*` / `bg-popover/*` (a sticky bar behind
  `backdrop-blur`). `filled-backgrounds.test.ts` fails on anything else. Same rule for a
  container: a panel or a table on a page owns a background (`Table` carries `bg-card`
  itself), it does not borrow the page's.
- **An illustration NEVER draws a grey as white-with-alpha.** Every `*-graphic.tsx` and every
  animated or static illustration paints in **solid tokens at 100%**: if a grey is wanted, use the
  token that IS that grey. `foreground/40`, `primary/45`, `muted-foreground/25`, `bg-white/[0.04]`,
  `fillOpacity="0.65"` over a light fill - all forbidden, in both themes and in every state
  (`dim`, `off`, `done`, hover). It matters because `--foreground` and `--primary` are **near-white
  on the dark theme**: `stroke-primary/45` is not "a soft grey", it is white at 45%, and it renders
  as a washed-out smear that changes shade with whatever sits behind it. The three greys, recessive
  to prominent, are:
  **`--border`** furniture (floors, shelves, panes, tracks, vents) · **`--ring`** the drawn object
  that is not the subject (a machine, a socket, a crate, a clock face) · **`--muted-foreground`**
  the subject when it carries no colour. Colour beats stay what they were (`--success`, `--violet`,
  `--chart-*`, a brand gradient), and an alpha on a genuinely coloured token is fine - the ban is
  white and near-white only.
  **The one carve-out is MOTION:** an opacity that animates (a fade-in, a blink, a pulse, a packet
  arriving) is movement, not a colour choice, and stays. An opacity that is the element's resting
  shade is a colour choice, and gets replaced by the token for that shade.
