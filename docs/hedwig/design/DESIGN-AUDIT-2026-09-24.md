# Hedwig design audit and redesign spec

Sep 24, 2026. Scope: the v2 web client (`frontend/src/hedwig/v2`, `theme/`), the comps in `docs/hedwig/design/*.dc.html`, and the type/look rules in `docs/hedwig/V2-BUILD.md` (Frontend E). Reference: Apple Mail on macOS. This spec replaces the look rules in V2-BUILD.md; the product concepts in PRD-v2-product.md stay.

## Verdict

Ranked by how much each one costs the user.

1. **Mail does not render.** The reader shows every message as plain text in a `<p>` (`v2/threadData.js:35-38` runs `htmlToPlain` and drops quoted history; `v2/Thread.jsx:145` prints it), so newsletters, receipts and anything with a layout arrive as broken text. A mail client's first job is to show the message as the sender made it, in an isolated frame ([Close, "Rendering untrusted HTML email, safely"](https://making.close.com/posts/rendering-untrusted-html-email-safely/)), and the repo already has that frame in `frontend/src/components/MessageBodyView.jsx`.
2. **A display serif sets the tone of a utility.** Instrument Serif runs the wordmark, titles, the 30px subject and every italic "reason", so the app reads as a magazine, not a tool the owner trusts with his mail. macOS apps set UI in the system face at a 13pt default ([HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography)), and every client the owner would compare against (Apple Mail, Mimestream, Superhuman, Spark) uses a neutral sans.
3. **No icons, so nothing is findable at a glance.** The rail, toolbar and actions are words only, so each stream and action has to be read. Apple Mail's sidebar and toolbar are glyph-led, and macOS 27 put colour back into sidebar icons after users missed it ([MacRumors, Liquid Glass in macOS Golden Gate](https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/)).
4. **Reply, Forward, Archive are missing from the reader.** The header carries four text buttons (Done, Reply Later, Snooze, Set Aside) and the standard actions sit in menus or nowhere. Apple Mail keeps Archive, Delete, Junk, Reply, Reply All, Forward, Flag and Move in the toolbar ([TechRepublic on the Mail toolbar](https://www.techrepublic.com/article/customize-macos-mail-toolbar/)); users look for them there first.
5. **Everything is glass, including the content.** Rail, list and reader are all 52%-white blurred sheets over an orange field, so text sits on tinted, shifting colour. Apple's rule is "Don't use Liquid Glass in the content layer" and "always avoid glass on glass" ([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [WWDC25 Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)).
6. **Legibility is marginal where it matters.** `--hw-muted #66696D` on the glass over the orange field works out to about 4.6:1, which barely passes AA as a number, and a hairline italic serif at 15px reads lighter than the ratio says. Apple answered the same complaint in Tahoe with more opaque glass and an opacity slider ([TidBITS](https://tidbits.com/2025/10/09/how-to-turn-liquid-glass-into-a-solid-interface/), [MacRumors](https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/)).
7. **List rows lack avatars and a preview, so they are slow to scan.** A row is a dot, a 15px name, a mono time and one muted subject line, with 14px padding and a 12px radius, and nothing to recognise at a glance. Apple Mail shows contact photos and 1-5 preview lines ([Apple Support, contact photos](https://support.apple.com/guide/mail/show-peoples-pictures-mail28012/mac), [Apple Community, List Preview](https://discussions.apple.com/thread/254932987)); Spark and Hey rely on avatars the same way ([Spark avatars](https://sparkmailapp.com/help/manage-your-inbox/avatars-in-spark), [HEY](https://www.hey.com/features/the-imbox/)).
8. **Oversized radii and heavy chrome waste space.** 26px sheet radii, 30px serif titles and 38px nav rows fit about 40% fewer rows than Apple Mail in the same height. Tahoe's large corners drew complaints, and Apple reduced them in the next release ([MacRumors](https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/)).
9. **The rail is full of system chatter.** "Hedwig screened 0, bundled 4075, rescued 6 from spam, blocked 0. Review or undo", an italic tier notice, "1 accounts" and "Power" all compete with the streams. Navigation should hold only places, and status belongs in one quiet line.
10. **Mono ordinals and times look like debug output.** DM Mono for times, counts and per-message numbers makes the list look like a log. Tabular figures in the system face (`font-variant-numeric: tabular-nums`) align just as well without the noise.

## Direction

Hedwig becomes a calm, familiar mail reader built the way Apple Mail is: glass for navigation, solid paper for content. The window is a soft neutral ground with one faint cool light field. The rail and the reader's toolbar are frosted glass. The message list and the reader share one opaque content sheet split by a hairline, and HTML mail renders on white as its sender designed it. Type is the system stack and nothing else: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", InterVariable, Inter, Roboto, "Helvetica Neue", Arial, sans-serif`. Self-host InterVariable (woff2, `font-display: swap`); browsers download a font only when the stack actually falls through to it, so Mac and Windows users never fetch it. Drop Google Fonts entirely. Sizes: 11px meta and section headers, 12px previews and reasons, 13px list text and UI, 14px plain-text body and reader header name, 17px list title, 20px subject (22px on phone). Weights 400/500/600 only; figures in `tabular-nums`; mono only for tracking numbers, one-time codes and code. Hedwig's reasons remain its voice but lose the italic serif. A reason is 12px muted sans text behind a 12px glyph (sparkle for AI-written, info circle for a rule), always a button that opens the why door. One accent colour, blue, for selection, links, focus and the primary button. Orange stays only as the attention signal: unread dot, Needs you, deadlines. Icons are 16px line glyphs with a 1.5px stroke, drawn in the Lucide style ([lucide.dev](https://lucide.dev)) and added to `hedwig/icons.jsx`.

## Spec

### a) Rail (sidebar)

- Floating glass sheet. Width 232px, resizable 200-300px, collapses at <1100px viewport. Inset 8px from the window edges, radius 14px. Padding 8px horizontal, 10px top.
- Top row, 40px: owl glyph 18px plus "Hedwig" in 13px/600. A compose button (square-pen icon) sits at the right: 28×28, radius 6, 16px glyph, tooltip "New message (C)".
- Nav item: 28px tall, radius 6, padding 0 8px. A 20px icon box holds the 16px glyph, then an 8px gap and the label in 13px/400 ink. The count is right-aligned, 12px/500 muted, tabular. Needs-you counts use `--attention-ink`. No zero counts.
- Selected item: fill `--select` (neutral), label 600, icon in `--accent`. Hover: fill `--hover`. Glyphs render in `--accent` at rest (Apple's tinted sidebar style) and in `--muted` when the window is unfocused.
- Section headers: 11px/14 600 muted, sentence case, padding 14px 8px 4px. Each is a toggle with a 10px chevron shown on hover.
- Items and icons:
  - Search is removed from the rail (see list header).
  - Screener: `door-open`, count of waiting senders.
  - People: `users`, Needs-you count in orange.
  - Reading: `book-open`.
  - Records: `receipt`. Children indent 20px: Purchases `shopping-bag`, Subscriptions `repeat`, Travel `plane`, Deliveries `package`.
  - Section "Later":
    - Reply Later: `reply` with a small clock badge; plain `reply` is acceptable.
    - Set Aside: `bookmark`.
    - Snoozed: `alarm-clock`.
    - Waiting on: `hourglass`.
  - Section "Hedwig":
    - Daily Brief: `newspaper`.
    - Today (the undo log): `history`.
    - Settings: `settings`.
- Footer, pinned to the bottom with a hairline above it and 10px padding:
  - Account line, 32px: 20px avatar, the address in 12px/500 ink, truncated. For several accounts: "3 accounts". Click opens an account switcher popover.
  - Status line, 11px muted with a 12px glyph: "Up to date · 2 min" or "Syncing…". When degraded: bolt glyph and "Using the lighter model". Click opens Today.
- Removed from the rail: the "Hedwig screened…" paragraph (it moves to the top of Today as a four-figure strip), "Power" (moves to Settings and the palette), and the italic tier notice.

### b) Message list

- The list is the left part of the content sheet. Width 380px, resizable 300-520px. The content sheet is opaque: `--content` fill, radius 14px, inset 8px, with a 1px `--line` divider between list and reader.
- Header block, 88px:
  - Search field, 30px tall, radius 8, fill `--field`, margin 10px 12px 6px. Magnifier 14px, placeholder "Search or ask" 13px muted, `⌘K` hint on the right in 11px muted.
  - Title row, 36px: stream name 17px/22 600, then the count "24 · 3 unread" in 12px muted on the same baseline. On the right, a filter icon button (`list-filter`, 28×28) with a menu for Unread, Needs you, Has attachments and sort order.
- Date group header: 28px, 11px/600 muted ("Today", "Yesterday", "This week", "September"). Padding 0 16px. Sticky, with `--content` behind it at 92% opacity. No italic, no serif.
- Row: one density only, no compact mode in v2.
  - Grid: `8px | 36px | 1fr` with a 10px column gap. Padding 10px 14px 10px 8px. Minimum height 76px, radius 8. Rows are separated by a 1px `--line` inset 62px from the left, which is hidden next to hover and selected rows.
  - Column 1: unread dot, 8px circle in `--attention`, vertically aligned to line 1.
  - Column 2: avatar, a 36px circle. Initials in 13px/600 white on a colour hashed from the address (8 muted hues, each ≥4.5:1 against white). Use a BIMI or Gravatar image when cached. Screener rows show a dashed 1px outline instead of the fill.
  - Line 1, 16px line height: sender 13px/600 ink, truncated. Date right-aligned, 11px/400 muted, tabular: "09:14" today, "Yesterday", "Mon", "12 Sep", "12 Sep 2025". Flag, paperclip and a thread count ("3") sit left of the date as 12px muted glyphs.
  - Line 2: subject 13px/400 ink, one line.
  - Lines 3-4: preview in 12px/16 muted, clamped to two lines. When a TL;DR exists it replaces the preview and starts with an 11px `sparkles` glyph in `--muted`, the same pattern as Apple Mail's list summaries replacing first lines ([Apple Support, Apple Intelligence in Mail](https://support.apple.com/guide/mac-help/use-apple-intelligence-in-mail-mchlb2dbea8f/15.0/mac/15.0)).
- Reason ("why"): Needs-you, Screener and rescued rows put the reason on the last line, replacing preview line 2. It is 12px, with a 12px glyph (`circle-alert` for Needs you, in `--attention-ink`; `info` elsewhere, in muted), and is a button that opens the why door as a popover anchored to it. Other rows show no reason in the list; it lives in the reader.
- States:
  - Hover: fill `--hover` plus a trailing hover toolbar of three 24px icon buttons (Done, Snooze, Reply Later) on line 1, which replaces the date.
  - Selected: fill `--accent-tint` with ink text; unread dot stays.
  - Keyboard focus: 2px `--accent` inset ring.
  - Multi-select: the same tint, plus a count bar replacing the title row.
- Bundles (Records, Reading): one row with a 36px rounded-square icon tile (the bundle glyph on `--field`), the name 13px/600, the summary line "3 deliveries, 1 arriving today" 12px muted, and a chevron to expand in place.

### c) Reader toolbar and header

- Toolbar: 48px at the top of the reader column. Frosted as a thin overlay (`--bar` fill, blur 20px) so the message scrolls under it; this is the one glass element inside the content sheet. Padding 0 12px. Buttons are 28×28, radius 6, 16px glyph, tooltip "Name (key)". Groups are separated by 12px gaps, left to right:
  1. Done (`circle-check`, key E), shown with icon plus a 13px/500 "Done" label as the primary action.
  2. Reply Later (`reply`+clock, L), Snooze (`alarm-clock`, H), Set Aside (`bookmark`, S).
  3. Reply (`reply`, R), Reply all (`reply-all`, A), Forward (`forward`, F).
  4. Move (`folder-input`, V), which opens a stream and bundle picker and asks "Just this one / Always". Flag (`flag`, `--attention` when on), More (`ellipsis`: Print, View source, Unsubscribe, Block sender, Report spam, Open in new pane).
  - Amended 2026-09-24 (owner request): Done, Delete (`trash`, ⌫ / #), Junk (`alert-octagon`, !) and Flag (⇧S, filled accent when on) form the first group and always show. Hedwig never deletes on its own; the owner can delete (to Trash) and undo (PRD principle 4). Below 900px of reader width, group 2 and Move collapse into More; below 640px Reply all and Forward too. Every inbox action is optimistic with an Undo toast (`v2/actions.js`).
- Subject block, padding 20px 24px 0: subject in 20px/26 600 ink, wrapping. Under it, 12px muted: "3 messages" followed by the reason as a why button with glyph ("In People because you replied to Maria last week"), then a "Change" link in `--accent`.
- Summary block:
  - Margin 14px 24px 0. Radius 10, fill `--field`, 1px `--line`, padding 12px 14px.
  - Head row: `sparkles` 14px in `--accent`, then "Summary" (≤3 messages) or "Story so far" (longer threads) in 12px/600. On the right, 11px muted "Lighter model" with an `info` glyph when the tier fell back; its tooltip holds the full tier note.
  - Body 13px/19 ink, clamped to three lines with a "Show more" link. Citations are superscript 10px `--accent` numbers that scroll to the message.
  - Precedents: Superhuman's one-line summary above every conversation ([Superhuman](https://blog.superhuman.com/auto-summarize/)), Shortwave's tap-to-expand summary atop a thread ([TechCrunch](https://techcrunch.com/2024/01/29/shortwave-email-client-will-show-ai-powered-summaries-automatically)), Apple Mail's Summarize at the top of the message ([Apple Support](https://support.apple.com/guide/mac-help/use-apple-intelligence-in-mail-mchlb2dbea8f/15.0/mac/15.0)).
- Cards (receipt, delivery, flight): directly under the summary, same box style, key figure 17px/600, fields 12px.
- Message header, per message, padding 16px 24px 12px:
  - Grid `36px | 1fr | auto`, gap 12px. Avatar 36px.
  - Name 14px/600. The address appears in 12px muted after the name on hover, and click opens the person card popover.
  - Line 2: "To: Prakhar, Cc: Anna" 12px muted, truncated, click to expand.
  - Right column: date "Wed 24 Sep, 09:14" 12px muted, tabular, and under it a paperclip plus count when there are attachments. A per-message ellipsis (Reply, Forward, View source) shows on hover.
  - No mono ordinals.
- Thread layout: the newest message and every unread message are expanded. Older read messages collapse to 44px rows (24px avatar, name 13px/600, one-line snippet 12px muted, date), and more than 4 collapsed rows fold into one "5 earlier messages" row, the way Gmail and Apple Mail behave.
- Body:
  - HTML renders through `MessageBodyView` (sandboxed `srcdoc` iframe, `script-src 'none'` CSP, links to `_blank`, auto height, scale-to-fit for fixed 600-700px layouts) at full reader width minus 24px padding. No `ch` cap on HTML.
  - Plain text: 14px/21, max 68ch, `pre-wrap`.
  - The iframe background is always `#FFFFFF`. In dark mode it sits as a white paper card with a 10px radius, unless the message declares `color-scheme: light dark`, in which case pass `prefers-color-scheme` through ([Campaign Monitor, dark mode in email](https://www.campaignmonitor.com/resources/guides/dark-mode-in-email/)).
- Quoted history: collapsed, never deleted. Detect `blockquote[type=cite]`, `.gmail_quote`, `#divRplyFwdMsg` and "On … wrote:" blocks. Replace them with a 28×16 "•••" button (radius 4, `--field`), which expands in place, as Gmail's "Show trimmed content" does ([Allegheny College tech tip](https://sites.allegheny.edu/library/tech-tip-tuesday-show-trimmed-content-in-gmail/)). Signatures after "-- " collapse the same way.
- Remote images: blocked by default and requested through the server proxy only after consent. Show a banner above the body: 36px, 12px text, `image-off` glyph, "Remote images are hidden to protect your privacy.", then "Load images" and "Always for this sender". This mirrors Apple Mail's Load Remote Content banner ([Apple Support, Mail Privacy Protection](https://support.apple.com/en-ca/guide/mail/mlhl03be2866/mac)). CSP `img-src` allows `data:`, `cid:`-rewritten blobs and the proxy origin only.
- Attachments: a row under the body. Tiles are 220×48, radius 8, 1px `--line`, with a 20px file-type glyph, name 12px/500, size 11px muted, and a download button on hover.

### d) Reply bar and composer

- Inline, at the bottom of the thread: a 40px "Reply to Maria…" field (radius 10, `--field`). Above it sit up to three suggested replies as 28px text buttons with a hairline border and radius 8. When the field is focused it grows to at most 220px, with:
  - A left toolbar: "Draft in my voice" (`sparkles` plus label) and "Remind me if no reply" (`bell` toggle, tooltip explains it).
  - On the right, Send: a 28px `--accent` button with white 13px/600 text and ⌘↩.
  - Send-guard warnings appear as a 12px `--attention-ink` line above the field.
- Proper composer for Reply all with Cc/Bcc edits, Forward, New message, and any reply over 6 lines or with attachments. A "pop out" icon on the inline bar opens it. It is a centered panel 720×min(640, 90vh), radius 14, opaque `--content`, with a 44px header (To/Cc/Subject fields as 32px rows with hairlines) and a formatting toolbar that floats as a glass bar (Apple's Tahoe compose pattern, [OWC blog](https://eshop.macsales.com/blog/97650-blurry-or-beautiful-the-tweaks-and-tenets-of-apples-controversial-liquid-glass-design-in-macos-tahoe/)).

### e) Colours and materials

Light theme:

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#EEF0F3` plus one radial field `#9DB4D6` at 18%, blur 120px, top-left | Window ground |
| `--glass` | `rgba(248,248,250,.72)`, `blur(30px) saturate(1.8)` | Rail |
| `--bar` | `rgba(255,255,255,.78)`, `blur(20px) saturate(1.6)` | Reader toolbar, sticky headers |
| `--content` | `#FFFFFF` (list may use `rgba(255,255,255,.94)`) | List and reader sheet |
| `--edge` | `rgba(255,255,255,.6)` inner, plus `0 0 0 .5px rgba(0,0,0,.12)` | Sheet edge |
| `--line` | `rgba(0,0,0,.08)` | Hairlines |
| `--field` | `rgba(0,0,0,.045)` | Search, summary, chips |
| `--hover` | `rgba(0,0,0,.04)` | Hover fill |
| `--select` | `rgba(0,0,0,.07)` | Rail selected |
| `--ink` | `#1D1D1F` | Text |
| `--muted` | `#5E5E63` (≥5:1 on every surface above) | Secondary text |
| `--accent` | `#007AFF` | Fills, glyphs, focus |
| `--accent-ink` | `#0062CC` (5.8:1 on white) | Link text |
| `--accent-tint` | `rgba(0,122,255,.12)` | Selected row |
| `--attention` | `#E0561A` | Unread dot, flag |
| `--attention-ink` | `#A8420F` | Needs-you text |

Dark theme:

| Token | Value |
| --- | --- |
| `--paper` | `#161618`, field `#2B3F5E` at 30% |
| `--glass` | `rgba(40,40,44,.70)` |
| `--bar` | `rgba(30,30,32,.80)` |
| `--content` | `#1E1E20` |
| `--line` | `rgba(255,255,255,.09)` |
| `--field` | `rgba(255,255,255,.06)` |
| `--hover` | `rgba(255,255,255,.05)` |
| `--select` | `rgba(255,255,255,.10)` |
| `--ink` | `#F5F5F7` |
| `--muted` | `#A1A1A6` |
| `--accent` | `#0A84FF` |
| `--accent-ink` | `#4DA3FF` |
| `--accent-tint` | `rgba(10,132,255,.22)` |
| `--attention` | `#FF7A40` |
| `--attention-ink` | `#FF9A66` |

- Blue replaces orange as the accent because selection, links and primary buttons carry meaning users already read as "system". Blue is also calmer across a whole day of use, and it frees orange to mean "look at this" ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/): "When every element is tinted, nothing stands out"). `ui.accent` stays tweakable but now tints blue-family only.
- Contrast: every text token meets WCAG AA 4.5:1 and every glyph or dot meets 3:1, measured against the worst composited background (the glass over the light field), not over flat paper. Add a token test next to `tokens.test.js` that composites and asserts these ratios.
- Honour `@media (prefers-reduced-transparency: reduce)`: glass becomes opaque `#F5F5F7` / `#262628`. Under `prefers-contrast: more`, lines go to .20 and muted to ink at 80%.

### f) Radii, spacing, shadows

- Radii: sheets 14px, the composer and popovers 12px, controls, rows and tiles 8px, small buttons 6px, avatars and dots full circle. No other values.
- Spacing: 4px base with an 8px rhythm (4, 8, 12, 16, 24, 32). Window gutter 8px. Reader content padding 24px.
- Shadows: sheets `0 1px 2px rgba(0,0,0,.06), 0 8px 24px -12px rgba(0,0,0,.18)`. Popovers `0 12px 32px -8px rgba(0,0,0,.28)`. Rows and buttons have no shadows.

### g) Phone (<768px)

- One column: list, then a pushed reader. No floating sheets and no 28px radii. Content is full-bleed `--content`.
- Glass only on the top bar and the bottom bar, both `--bar`.
- Top bar: large title 28px/700, collapsing to 17px/600 on scroll. The search field sits under the title.
- Bottom tab bar, 49px plus safe area: icon plus 10px label for People, Reading, Records, Brief, Screener. Counts appear as badges, orange for Needs you.
- Rows: avatar 40px, sender 15px/600, date 13px, subject 15px, preview 14px/19 clamped to two lines. Minimum height 88px. Swipe right for Done, swipe left for Snooze or Reply Later.
- Reader: a bottom toolbar of five 44px targets (Done, Reply Later, Snooze, Reply, More). Subject 22px/28 600. HTML scales to the screen width. The reply field opens a full-screen composer.

## Cut list

- Instrument Serif and DM Mono everywhere, including the Google Fonts link. Drop the `--hw-font-display` / `--hw-font-why` serif defaults (`v2/primitives.jsx:25-26`, `theme/fontFaces.js`).
- Italic reason styling (`Why` in `primitives.jsx:78-83`, `rows.jsx:105`).
- Mono per-message numbers in the reader; mono times and counts.
- 26px and 28px radii, 38px nav rows, 30px and 40px serif titles and figures.
- The orange light field, especially where it bleeds behind the reader; the white third field.
- Glass on the list and reader content.
- The rail footer paragraph ("Hedwig screened…"), the italic tier notice in the rail, "1 accounts" and "Power" in the rail.
- The plain-text conversion of HTML bodies and the deletion of quoted history in `threadData.js`.
- The V2-BUILD.md rule "no avatars". "No uppercase eyebrow labels" and "no left-border cards" stay.

## Keep list

- **Streams** (People, Reading, Records, Bundles): the rail entries with glyphs and bundle rows as specified. Reading keeps its feed-style reader, now with rendered HTML.
- **Screener**: a list of 76px rows with dashed avatars and the proposed decision as the reason line. The reader for a Screener sender shows four 32px buttons with glyphs (People `users`, Reading `book-open`, Records `receipt`, Block `ban`), the proposed one filled `--accent`, and "Accept all" in the list header.
- **Why door**: every reason is a 12px glyph-plus-text button that opens a 320px popover (radius 12). It shows the decision, the layer that made it and "Change this" with the four scopes.
- **TL;DRs**: they replace the list preview, marked with a sparkle.
- **Story so far and Summary**: the compact block in the reader, with citations.
- **Cards**: boxed blocks under the summary, in Ledger tables, and in the Brief.
- **Daily Brief**: an opaque reading page in the reader column. Headline 22px/600, sections with 11px/600 headers, figures 20px/600 tabular (not serif), the Ask field styled as the search field at 36px.
- **Reply Later, Set Aside, Snoozed, Waiting on, Today**: rail items with glyphs. Today opens with the auto-action strip that replaces the old rail footer.
- **Keyboard first**: every tooltip names its key, the ⌘K palette stays and shows keys next to commands ([Superhuman on command palettes](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)), and there is a 24px hint bar at the bottom of the list in Simple mode ("E Done · R Reply · H Snooze · ⌘K Everything").
- **One accent, hairlines, restraint**: still the principle, now applied with a familiar system vocabulary.

Other sources: [WWDC25 Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/), [HEY Screener](https://www.hey.com/features/the-screener/), [Mimestream review, MacStories](https://www.macstories.net/reviews/mimestream-the-perfect-email-app-for-gmail-users-on-the-mac/), [Notion Mail](https://www.notion.com/blog/introducing-notion-mail), [MacRumors, Mail categories on Mac](https://www.macrumors.com/2025/02/21/revamped-mail-app-mac-ipad/), [MDN srcdoc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc).
