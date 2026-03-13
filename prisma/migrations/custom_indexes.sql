CREATE INDEX IF NOT EXISTS idx_tasks_search ON tasks USING gin(to_tsvector('english', title || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS idx_comments_search ON comments USING gin(to_tsvector('english', body));
CREATE INDEX IF NOT EXISTS idx_tasks_date_range ON tasks(start_date, due_date) WHERE deleted_at IS NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(next_fire_time) WHERE is_fired = false AND is_dismissed = false;
CREATE INDEX IF NOT EXISTS idx_tasks_overdue ON tasks(assignee_id, due_date) WHERE deleted_at IS NULL AND status NOT IN ('done') AND due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(recipient_id, created_at) WHERE is_read = false;
