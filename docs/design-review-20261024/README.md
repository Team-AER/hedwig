# Question scope verification · 24 October 2026

The existing question sheet, buttons, palette and typography remain. For rule-capable two-choice questions, each choice now says whether it applies to this message or always to this sender. The existing answer, `always` payload, rule creation and non-rule choices are unchanged. All ten shipped locales include the distinction.

## Local evidence

Screenshots are retained outside Git. No review images are included in this branch.

The original UI is `before-wide.png` / `before-phone.png`. The updated main UI is `after-1440.png`, `after-390.png`, and `after-320.png`. The equivalent Decision checkout is recorded in `decision-after-1440.png`, `decision-after-390.png`, and `decision-after-320.png`. These are actual source renderings with intercepted synthetic account, thread and learning-question API data, not a live mailbox. Desktop is 1440×1000; phones are 390×844 and 320×844.


## Verification

- Main frontend suite: 3,198 tests passed; locale checks, ESLint and production build passed.
- Backend under the repository CI's Node 22 runtime: 2,750 passed, 105 skipped; lint and plugin-boundary checks passed. The host Node 26 runner initially hit Undici compatibility errors; no dependency or compatibility source patch was made.
- Decision uses the same shared source commit, built and passed lint plus the scope regression. One main PR covers both checkouts.
- Browser at all three widths: no page overflow; message/sender labels are visible, phone choice buttons are at least 44 px high; keyboard Space sends the unchanged `always: false` answer payload.
- Existing reduced-motion behavior and question selection transitions remain in place; this patch adds no animation or delay.

No email was sent, classified or changed in a real account. Existing feature branches were retained.


---

# Research search scope verification · 24 October 2026

The existing drawer, palette, typography and globe interaction remain. The source toggle now visibly says **Mail + web** or **Mail only**, matching its existing pressed state and accessible label. The button has a 44 px target on phones. All ten locales have the source labels. Draft text and existing research request semantics are preserved.

## Supporting integration

The deployed research/backend baseline was integrated into main through #6 before this UI update, preserving the running `811dcff` backend. Main's learning-question scope change and audited dependency fixes from #5 are retained. The original dirty Research checkout was preserved; this release uses the isolated source-only UI patch.

## Local evidence

Screenshots are retained outside Git. No review images are included in this branch.

`before-research-wide.png` shows the original globe-only toggle. `after-research-1440.png`, `after-research-390.png`, and `after-research-320.png` show the actual updated source with intercepted synthetic mailbox/research APIs. Desktop is 1440×1000; phones are 390×844 and 320×844.


## Verification

- Frontend suite: 3,204 tests passed; locale validation, lint and production build passed. The isolated publication worktree also passed its focused wave2 regression, lint and build.
- Browser at all three widths has no page overflow. Space switches the native toggle and updates visible text, retains the draft, and sends no question merely because the source changes.
- Existing drawer transition is 180 ms; reduced-motion emulation suppresses it to 0.01 ms. Escape closes the drawer.

Existing limitation observed: closing the drawer with Escape returns focus to the document body in this baseline. This UI patch does not change drawer focus management. No real mailbox or web research query was submitted. Supporting backend behavior is not claimed as live-verified.
