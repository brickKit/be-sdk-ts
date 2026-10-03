-- be-protocol 1.0 reference DDL: PostgreSQL queue bus adapter (P12.12)
--
-- NOT a platform table: schema be_bus belongs to the infrastructure, like NATS. The project's
-- database initialisation creates the schema and these tables and grants every component's role
-- SELECT, INSERT, UPDATE, DELETE on them (and USAGE on the sequence). Components never read each
-- other's schemas; only the SDK's pgqueue adapter touches be_bus. Names are schema-qualified here
-- because this file is run by the database initialisation, not by a component migration.

CREATE SCHEMA IF NOT EXISTS be_bus;

-- An identity column is not allowed on a partitioned table before PostgreSQL 17, so seq takes a sequence.
CREATE SEQUENCE IF NOT EXISTS be_bus.message_seq;

CREATE TABLE IF NOT EXISTS be_bus.message (
    stream       TEXT        NOT NULL,                   -- BE_<FIRST SEGMENT>
    seq          BIGINT      NOT NULL DEFAULT nextval('be_bus.message_seq'),
    tx_id        XID8        NOT NULL DEFAULT pg_current_xact_id(),
    msg_id       TEXT        NOT NULL,                   -- ce-id
    subject      TEXT        NOT NULL,
    headers      JSONB       NOT NULL,                   -- the CloudEvents headers (envelope.schema.json)
    data         BYTEA       NOT NULL,                   -- the JSON payload
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (seq, published_at)
) PARTITION BY RANGE (published_at);                     -- retention = dropping old partitions

CREATE INDEX IF NOT EXISTS message_stream_seq ON be_bus.message (stream, seq);

CREATE TABLE IF NOT EXISTS be_bus.msg_id (               -- the duplicate window, unpartitioned
    stream     TEXT        NOT NULL,
    msg_id     TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (stream, msg_id)
);

CREATE TABLE IF NOT EXISTS be_bus.durable (
    name        TEXT        PRIMARY KEY,                 -- the durable name (P12.5)
    stream      TEXT        NOT NULL,
    filter      TEXT        NOT NULL,                    -- subject filter
    last_tx_id  XID8,
    last_seq    BIGINT,
    last_active TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS be_bus.delivery (             -- in flight and waiting for redelivery
    durable       TEXT        NOT NULL,
    seq           BIGINT      NOT NULL,
    num_delivered INT         NOT NULL DEFAULT 0,
    next_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until   TIMESTAMPTZ,
    PRIMARY KEY (durable, seq)
);

-- Publish (one short transaction):
--   INSERT INTO be_bus.msg_id (stream, msg_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes')
--   ON CONFLICT DO NOTHING RETURNING 1;           -- only when a row was inserted:
--   INSERT INTO be_bus.message (stream, msg_id, subject, headers, data) VALUES (…);
-- Fan-out (under a row lock on the durable row): copy the next matching messages with
--   tx_id < pg_snapshot_xmin(pg_current_snapshot()) into be_bus.delivery, advance (last_tx_id, last_seq).
-- Consume: claim delivery rows with next_at <= now() and an expired lease, FOR UPDATE SKIP LOCKED;
--   ack deletes the row; nak sets next_at and increments num_delivered; in progress extends lease_until;
--   terminate deletes it.
-- Notify: NOTIFY be_bus, '<subject>' wakes consumers; best-effort signals use the same channel.
