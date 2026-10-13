-- New mail accounts start with antispam on (2026-10-13). Upstream's 0054 made it opt-in so nobody
-- was surprised by mail moving, and nothing in Add account turns it on, so every new account went
-- unscreened. With it on, incoming mail is tagged; it moves to the Junk folder only when the
-- owner's own model has learned from at least 50 spam/ham marks, is at least 95% sure, and the
-- account has a Junk folder mapped (services/spamPipeline.js). Existing accounts keep their setting.
ALTER TABLE email_accounts ALTER COLUMN antispam_enabled SET DEFAULT true;

COMMENT ON COLUMN email_accounts.antispam_enabled IS
  'When TRUE, incoming messages on this account are classified by the per-user spam model, tagged, and auto-moved to Junk at confidence >= AUTO_MOVE_THRESHOLD once the model is trained. Default TRUE for accounts added after Hedwig migration h0025. Manual spam/ham marks feed the per-user training data regardless of this flag.';
