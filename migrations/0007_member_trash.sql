ALTER TABLE members ADD COLUMN trashed_at TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_members_trashed_at ON members(trashed_at);
