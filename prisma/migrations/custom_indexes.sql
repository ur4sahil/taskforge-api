-- Hand-maintained indexes that Prisma's schema cannot express (expression /
-- partial / GIN). Every statement is idempotent so the file can be re-run.
--
-- IMPORTANT: `prisma db push` DROPS indexes it does not know about, so this
-- file must be re-applied after every db push (test/global-setup.ts does this
-- for the test DB; on prod run:  psql "$DIRECT_URL" -f prisma/migrations/custom_indexes.sql).

-- Trigram indexes back the ILIKE '%q%' search in search.module.ts. Prisma's
-- `contains` + mode:'insensitive' compiles to ILIKE, which GIN gin_trgm_ops
-- serves directly (BitmapOr over title + description). Without them every
-- search is a sequential scan of the whole tasks / comments table.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tasks_description_trgm ON tasks USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_comments_body_trgm ON comments USING gin (body gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_tasks_search ON tasks USING gin(to_tsvector('english', title || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS idx_comments_search ON comments USING gin(to_tsvector('english', body));
CREATE INDEX IF NOT EXISTS idx_tasks_date_range ON tasks(start_date, due_date) WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(next_fire_time) WHERE is_fired = false AND is_dismissed = false;
CREATE INDEX IF NOT EXISTS idx_tasks_overdue ON tasks(assignee_id, due_date) WHERE deleted_at IS NULL AND status NOT IN ('done') AND due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(recipient_id, created_at) WHERE is_read = false;
-- Task activity feed (GET /tasks/:tid/activity) walks audit rows for one entity newest-first.
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created ON audit_logs(entity_type, entity_id, created_at DESC);
