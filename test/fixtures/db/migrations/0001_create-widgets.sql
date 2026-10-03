-- Up Migration
CREATE TABLE widgets (
    id         uuid        PRIMARY KEY,
    name       TEXT        NOT NULL,
    created_at timestamptz NOT NULL
);
-- Down Migration
DROP TABLE widgets;
