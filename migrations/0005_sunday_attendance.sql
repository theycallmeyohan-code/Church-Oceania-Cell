CREATE TABLE IF NOT EXISTS sunday_attendance_sessions (
  id TEXT PRIMARY KEY,
  attendance_date TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sunday_attendance_records (
  session_id TEXT NOT NULL REFERENCES sunday_attendance_sessions(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  member_title TEXT DEFAULT '',
  member_role TEXT DEFAULT '',
  cell_id TEXT NOT NULL,
  cell_name TEXT NOT NULL,
  cell_sort_order INTEGER DEFAULT 0,
  photo_key TEXT DEFAULT '',
  present INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_sessions_date
  ON sunday_attendance_sessions(attendance_date);

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_records_session
  ON sunday_attendance_records(session_id);

CREATE INDEX IF NOT EXISTS idx_sunday_attendance_records_member
  ON sunday_attendance_records(member_id);
