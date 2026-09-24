# Redesign build contract, 2026-09-24

Spec: `docs/hedwig/design/DESIGN-AUDIT-2026-09-24.md` (the look). Code brief: `docs/hedwig/audit/ui-2026-09-24.md`
(file:line targets). Product concepts are unchanged (`docs/hedwig/PRD-v2-product.md`). This file is the
contract the parallel build agents share: names, ownership, and rules.

## Rules
- No new npm dependencies. AGPL. Node 22 (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`).
- Frontend tests: `cd frontend && npm test` (node --test) and `npm run lint` with zero warnings. Update tests
  that pin the old look (listed in the code brief §9); never delete a test to make it pass.
- Keep the DOM hooks tests and other views rely on: `article#hw-msg-N`, `data-tldr`, `data-tier-note`,
  `data-lighter`, `data-row-button`, `[data-pane-key]`, `.hw-sheet`, `.hw-row`, `.hw-fill`, `.hw-v2`.
- Inline styles over `--hw-*` variables as before. Shared CSS only in `theme/styles.js`.
- Phone (<768px) must still work: 44px targets, 16px gutters, no horizontal scroll.
- Ownership (edit only your files; write requests for other areas into your report):
  - **Foundation (F)**: `frontend/src/hedwig/theme/*`, `frontend/src/fonts.js` (system set + effectiveFontSet
    only), `frontend/src/hedwig/icons.jsx`, `frontend/src/hedwig/v2/primitives.jsx`, `frontend/src/hedwig/shell/*`,
    `frontend/src/hedwig/v2/TierNote.jsx`, `docs/hedwig/V2-BUILD.md` (type/look paragraph).
  - **Reader (R)**: `frontend/src/hedwig/v2/Thread.jsx`, `threadData.js`, `format.js`, `mail.js`, `Cards.jsx`,
    `Question.jsx`, `WhyDoor.jsx`, new `frontend/src/components/AttachmentChips.jsx` (+ MessagePane import swap),
    `backend/scripts/hedwig-seed.mjs` (HTML fixtures), tests `v2.test.js`/`wave2.test.js`/`repair.test.js` parts about the thread.
  - **List and rail (L)**: `frontend/src/hedwig/v2/rows.jsx`, `StreamView.jsx`, `ListView.jsx`, `Rail.jsx`, `Screener.jsx`,
    `Ledger.jsx`, `Waiting.jsx`, `Today.jsx`, `state.js`/`nav.js` (only if needed), `format.js` additions only via R's report.
  - **Pages (P)**: `frontend/src/hedwig/v2/Brief.jsx`, `HedwigSettings.jsx`, `frontend/src/hedwig/views/*` (Ask, settings/*, ui.jsx),
    `frontend/src/hedwig/v2/i18n.js` and `frontend/src/locales/en.json` strings they add.

## Foundation contract (what F exports; R, L and P code against it)

`frontend/src/hedwig/theme/tokens.js`
- Palettes per spec §e (light and dark). New `--hw-*` names added: `--hw-content` (opaque sheet), `--hw-bar`
  (toolbar glass), `--hw-field`, `--hw-hover`, `--hw-select`, `--hw-attention`, `--hw-attention-ink`.
  `--hw-accent` becomes the blue; `--hw-accent-ink`, `--hw-accent-tint` follow. Old names stay resolvable
  (`--hw-amber` → attention, `--hw-teal` → accent, `--hw-glass`, `--hw-edge`, `--hw-line`, `--hw-line2`, `--hw-tint` = hover).
- `FONT_STACKS.sans` = system stack from spec; `--hw-font-display` and `--hw-font-why` = the body font. No serif, no
  mono in the UI; `--hw-font-mono` stays for tracking numbers/codes.
- `fonts.js`: new `system` set; `effectiveFontSet` returns `'system'` for the Hedwig themes when the saved font is
  default; Google Fonts link only when the effective set is `hedwig`.

`frontend/src/hedwig/v2/primitives.jsx` (all existing exports stay; new ones below)
- `V`: existing keys keep working. New keys: `content`, `bar`, `field`, `hover`, `select`, `attention`, `attentionInk`.
  `V.serif` and `V.why` now resolve to the body font (kept so old call sites do not break, but R/L/P remove them).
- `Avatar({ name, email, size = 36, dashed = false, src })`: circle, initials 13px/600 white on one of 8 hashed hues
  (each ≥4.5:1 on white), `dashed` = 1px dashed outline for Screener, `src` optional image.
- `IconButton({ icon, label, kbd, onClick, active, primary, disabled, size = 28, showLabel })`: 28×28 radius 6,
  16px `Icon`, `title`/`aria-label` = "label (kbd)"; `primary` = accent fill white glyph; `showLabel` adds a 13px/500 label.
- `Reason({ glyph = 'info' | 'sparkles' | 'alert', tone = 'muted' | 'attention', onOpen, label, children, as })`:
  12px muted sans text with a 12px glyph; a button when `onOpen`. `Why` stays as an alias of `Reason` (no italic,
  no serif) so untouched call sites still render correctly.
- `SectionLabel({ children })`: 11px/600 muted, sentence case, padding per spec (replaces GroupLabel's look;
  `GroupLabel` in rows.jsx should render it).
- `Tooltip` is `title` only (no new component).
- `Sheet` default radius 14; `material = 'glass' | 'content' | 'bar'` prop (default `'content'`).
- `LightFields`: one cool field per spec (no orange field).

`frontend/src/hedwig/icons.jsx`
- `Icon({ name, size = 16, strokeWidth = 1.5 })`. Names guaranteed: search, compose (square-pen), door-open, users,
  book-open, receipt, shopping-bag, repeat, plane, package, reply, reply-all, forward, alarm-clock, bookmark, hourglass,
  newspaper, history, settings, circle-check, folder-input, flag, ellipsis, sparkles, info, circle-alert, bolt, image-off,
  paperclip, list-filter, chevron-down, chevron-right, chevron-left, x, check, mail-open, mail, printer, ban, external,
  plus, minus, arrow-left, arrow-right, calendar, clock, download, file, image, more-horizontal, refresh, sync, user.

Shell materials (F): the rail pane is `glass`; every other pane is `content` (opaque). Window gutter 8px, sheet
radius 14, panes in one row sit 8px apart. The ground is `--hw-paper` with the one cool field.
