PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cells (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  meta TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL REFERENCES cells(id),
  name TEXT NOT NULL,
  title TEXT DEFAULT '',
  role TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  home_phone TEXT DEFAULT '',
  birth TEXT DEFAULT '',
  registered_at TEXT DEFAULT '',
  address TEXT DEFAULT '',
  memo TEXT DEFAULT '',
  photo_key TEXT DEFAULT '',
  archived_at TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_members_cell_id ON members(cell_id);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
CREATE INDEX IF NOT EXISTS idx_members_home_phone ON members(home_phone);
CREATE INDEX IF NOT EXISTS idx_members_archived ON members(archived_at);

CREATE TABLE IF NOT EXISTS visit_notes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  visit_date TEXT NOT NULL,
  visit_type TEXT DEFAULT '심방',
  summary TEXT NOT NULL,
  prayer TEXT DEFAULT '',
  action TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  raw_payload TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_visit_notes_member_id ON visit_notes(member_id);
CREATE INDEX IF NOT EXISTS idx_visit_notes_visit_date ON visit_notes(visit_date);

CREATE TABLE IF NOT EXISTS call_note_imports (
  id TEXT PRIMARY KEY,
  member_id TEXT,
  phone TEXT DEFAULT '',
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT DEFAULT '',
  after_json TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
