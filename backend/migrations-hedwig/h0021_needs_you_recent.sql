-- Needs You is a People concept for recent mail (engine.js decideCheap, 2026-09-24). Clear the flag
-- the old heuristic left on list/records mail and on months-old messages; user decisions stay.
UPDATE hedwig_sort s SET needs_you = false, needs_you_reason = NULL
  FROM messages m
 WHERE m.id = s.message_id AND s.needs_you AND s.layer <> 'user'
   AND (s.stream IS DISTINCT FROM 'people' OR m.date < NOW() - INTERVAL '30 days');
