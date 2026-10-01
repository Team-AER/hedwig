-- Sorting gains a 'decision' layer (2026-10-01): a System One decision model (Laya via Avifors,
-- Ollama/Nimble-compatible /v1/systemone through llm-proxy) settles stream / spam / needs-you for
-- messages the cheap layers left unsure, before the Reflex LLM. Idempotent: the layer check is
-- replaced with the wider one.
ALTER TABLE hedwig_sort DROP CONSTRAINT IF EXISTS hedwig_sort_layer_check;
ALTER TABLE hedwig_sort ADD CONSTRAINT hedwig_sort_layer_check
  CHECK (layer IN ('rule','classifier','decision','reflex','reasoning','user'));
