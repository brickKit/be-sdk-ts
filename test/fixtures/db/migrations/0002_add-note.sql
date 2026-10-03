-- Up Migration
ALTER TABLE widgets ADD COLUMN note TEXT NOT NULL DEFAULT '';
-- Down Migration
ALTER TABLE widgets DROP COLUMN note;
