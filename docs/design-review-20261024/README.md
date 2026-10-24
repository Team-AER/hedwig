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
