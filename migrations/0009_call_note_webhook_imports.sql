ALTER TABLE call_note_imports ADD COLUMN source_id TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN visit_id TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN name TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN cell_hint TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN summary TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN candidate_members TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN match_reason TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN resolved_at TEXT DEFAULT '';
ALTER TABLE call_note_imports ADD COLUMN updated_at TEXT DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_note_imports_source_id
  ON call_note_imports(source_id)
  WHERE source_id <> '';

CREATE INDEX IF NOT EXISTS idx_call_note_imports_status ON call_note_imports(status);
CREATE INDEX IF NOT EXISTS idx_call_note_imports_created_at ON call_note_imports(created_at);
