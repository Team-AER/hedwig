-- Stream C: sorting engine provenance (2026-09-24 audit). Additive and idempotent.
-- engine_version: the sorting engine + sort.reflex prompt version that produced the row
-- (sort/version.js engineStamp()). Rows decided by rules and the classifier carry no model or
-- prompt, so this is what says which code decided them.
ALTER TABLE hedwig_sort ADD COLUMN IF NOT EXISTS engine_version TEXT;
