ALTER TABLE members
  ADD COLUMN long_absent INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sunday_attendance_records
  ADD COLUMN member_long_absent INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_members_long_absent
  ON members(long_absent);
