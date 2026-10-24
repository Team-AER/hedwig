# Ask drawer refinement

Ask uses the existing outer drawer heading and places history/new-question actions beside it. Standalone and docked views retain their own heading and close behavior. The introduction is shorter; indexing coverage, question scope, draft and mail/web controls remain visible.

A selected starter becomes the question through a 160ms spatial handoff. The request and logical question start immediately, before motion. Live reduced motion cancels the cosmetic clone and reveals the settled question. Initial reduced motion and unavailable/throwing animation APIs place it directly. Cancellation, scope/navigation cleanup and repeated reset preserve the real question.

Applied current-source fixtures were inspected at 1440, 390 and 320 pixels, including starter activation with keyboard, live reduced motion and API fallback. The runtime receipt records the request starting before the animation. Local lint/build, dedicated motion tests and focused frontend tests passed; full suites are recorded in the external check receipts. Backend validation uses current Node 22 (22.23.3); an older local 22.18 runtime misdecoded a Windows-1252 fixture and is not the CI runtime.

Mail, indexing and answers were synthetic, with all API requests intercepted. No account, real mailbox or model action was performed. Images/video remain outside Git under `output/design-refinement-20261024/workspace-apps/` in the review workspace.
