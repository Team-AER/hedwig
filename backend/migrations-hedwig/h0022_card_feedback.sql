-- Card feedback (audit 2026-09-24): every Correct, Dismiss, "Not a subscription" and "Not a <kind>"
-- the owner gives a card is kept, by merchant and sender, so the subscription finder, the detectors
-- and the cards.extract prompt learn from it. Owned by backend/src/hedwig/cards/feedback.js.
-- Additive and idempotent, plus one repair (below).

CREATE TABLE IF NOT EXISTS hedwig_card_feedback (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id       UUID,                     -- a hedwig_cards id, or a commitment id for a deadline card; no FK
  kind          TEXT NOT NULL,            -- the card's kind when the owner acted on it
  merchant_key  TEXT,                     -- kinds.js merchantKey of the merchant / issuer / provider / sender
  sender        TEXT,                     -- the lower-cased address of the card's first message
  verdict       TEXT NOT NULL CHECK (verdict IN ('not_this_kind','not_recurring','wrong_field','dismissed','confirmed')),
  field         TEXT,
  before        JSONB,
  after         JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hedwig_card_feedback_merchant ON hedwig_card_feedback(user_id, merchant_key);
CREATE INDEX IF NOT EXISTS idx_hedwig_card_feedback_sender ON hedwig_card_feedback(user_id, sender);
CREATE INDEX IF NOT EXISTS idx_hedwig_card_feedback_card ON hedwig_card_feedback(card_id);

-- Why a card was hidden: 'not_recurring' (the subscription finder no longer finds it; it comes back
-- if the charges do), 'owner:dismissed', 'owner:not_recurring', 'owner:not_this_kind'.
ALTER TABLE hedwig_cards ADD COLUMN IF NOT EXISTS dismissed_reason TEXT;

-- Repair: subscriptions derived from fewer than 3 charges (the old minimum was 2, and two charges
-- cannot show a cadence; BookMyShow movie tickets were listed as a monthly subscription). Hidden
-- whether or not the owner edited them. Where the owner had already corrected one (user_edited),
-- that was the owner saying it is wrong: a 'not_recurring' feedback row keeps the merchant from
-- being derived again. The others can come back only if their charges meet the new rule.
WITH bad AS (
  SELECT c.id, c.user_id, c.fields, c.user_edited, c.message_id,
         NULLIF(regexp_replace(c.dedupe_key, '^merchant:(.*):[^:]*$', '\1'), '') AS merchant_key
    FROM hedwig_cards c
   WHERE c.kind = 'subscription' AND c.layer = 'derived'
     AND COALESCE(CASE WHEN c.fields->>'charges' ~ '^[0-9]+(\.[0-9]+)?$' THEN (c.fields->>'charges')::numeric END, 0) < 3
), hidden AS (
  UPDATE hedwig_cards c
     SET dismissed_at = COALESCE(c.dismissed_at, NOW()),
         dismissed_reason = COALESCE(c.dismissed_reason, CASE WHEN bad.user_edited THEN 'owner:not_recurring' ELSE 'not_recurring' END),
         updated_at = NOW()
    FROM bad WHERE c.id = bad.id
  RETURNING c.id
)
INSERT INTO hedwig_card_feedback (user_id, card_id, kind, merchant_key, sender, verdict, before, after)
SELECT bad.user_id, bad.id, 'subscription', bad.merchant_key, LOWER(m.from_email), 'not_recurring', bad.fields,
       jsonb_build_object('repair', 'h0022', 'reason', 'fewer than 3 charges; the owner had corrected it')
  FROM bad LEFT JOIN messages m ON m.id = bad.message_id
 WHERE bad.user_edited AND bad.merchant_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM hedwig_card_feedback f WHERE f.card_id = bad.id AND f.verdict = 'not_recurring');
