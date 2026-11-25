-- Arrive-by access analyses (BRD access-analysis 1.1 FR-21, D40): each pair's early wait, the
-- seconds between its journey arriving and the arrive-by time. Null for depart-at analyses and
-- for pairs with no journey. Whether an analysis is arrive-by is in its settings (jsonb), so no
-- other column is needed.
-- Only adds a column that may be null. To take it back by hand: alter table analysis_results
-- drop column early_wait_secs, and delete version 0011 from schema_migrations. The runner has no
-- down step.
alter table analysis_results add column if not exists early_wait_secs int;
