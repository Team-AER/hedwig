-- Two more lists a thread can be on, kept in Hedwig and never as folders or labels on the mail
-- server (2026-10-01: GTD's label folders are not how Hedwig organises mail): Delegated (someone
-- else is doing it; marking the thread done closes it) and Reference (kept to look up; Done leaves
-- it, like a pin). Idempotent: the kind check is replaced with the wider one.
ALTER TABLE hedwig_work_items DROP CONSTRAINT IF EXISTS hedwig_work_items_kind_check;
ALTER TABLE hedwig_work_items ADD CONSTRAINT hedwig_work_items_kind_check
  CHECK (kind IN ('reply_later','set_aside','pin','reminder','done','snoozed','delegated','reference'));
