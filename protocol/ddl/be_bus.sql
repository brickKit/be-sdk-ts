-- be-protocol 1.0 reference DDL: PostgreSQL queue bus adapter (P12.12)
--
-- NOT a platform table: schema be_bus belongs to the infrastructure, like NATS. The project's
-- database initialisation runs this file as a superuser: it creates the NOLOGIN role be_bus_owner,
-- which owns the schema, the tables and the partition functions, and grants every component's
-- runtime role (PG_USER: the adapter connects with the component's own PG_USER / PG_PASSWORD_FILE)
-- USAGE on the schema, SELECT, INSERT, UPDATE, DELETE on the tables, USAGE on the sequence and
-- EXECUTE on the two functions. Components never read each other's schemas; only the SDK's pgqueue
-- adapter touches be_bus. Names are schema-qualified here because this file is not a component
-- migration. A DEFAULT partition catches any row no range partition covers, so a publish never fails
-- for want of a partition; the adapter keeps range partitions ahead of now, so it stays empty.

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'be_bus_owner') THEN
        CREATE ROLE be_bus_owner NOLOGIN;
    END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS be_bus AUTHORIZATION be_bus_owner;
SET ROLE be_bus_owner;   -- everything below is owned by be_bus_owner; RESET ROLE at the end

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

-- the safety net: rows outside every range partition (P12.12); kept empty by the adapter's window
CREATE TABLE IF NOT EXISTS be_bus.message_default PARTITION OF be_bus.message DEFAULT;

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

-- Partition maintenance by the adapter, at run time, as the component's runtime role: the role has no
-- DDL of its own, so it goes through these SECURITY DEFINER functions owned by be_bus_owner (the same
-- pattern as ddl/10-lifecycle-functions.sql). Partitions are weekly, named
-- be_bus.message_<ISO week-year>w<WW> (P16.10), e.g. message_2026w40.

-- create the weekly partition that contains p_at, unless it exists; true when created
CREATE OR REPLACE FUNCTION be_bus.ensure_partition(p_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
    v_from timestamptz := date_trunc('week', p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_name text := 'message_' || to_char(v_from AT TIME ZONE 'UTC', 'IYYY') || 'w' || to_char(v_from AT TIME ZONE 'UTC', 'IW');
BEGIN
    IF to_regclass(format('be_bus.%I', v_name)) IS NOT NULL THEN
        RETURN false;
    END IF;
    EXECUTE format('CREATE TABLE be_bus.%I PARTITION OF be_bus.message FOR VALUES FROM (%L) TO (%L)',
                   v_name, v_from, v_from + interval '7 days');
    RETURN true;
END $fn$;

-- detach and drop one weekly partition older than p_before (retention); true when dropped
CREATE OR REPLACE FUNCTION be_bus.drop_partition(p_name text, p_before timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
    v_upper timestamptz;
BEGIN
    IF p_name !~ '^message_[0-9]{4}w[0-9]{2}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s is not a be_bus.message partition name', p_name);
    END IF;
    IF to_regclass(format('be_bus.%I', p_name)) IS NULL THEN
        RETURN false;
    END IF;
    v_upper := (to_date(substr(p_name, 9, 4) || '-' || substr(p_name, 14, 2) || '-1', 'IYYY-IW-ID')::timestamp
                AT TIME ZONE 'UTC') + interval '7 days';
    IF v_upper > p_before THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s is still inside the retention window', p_name);
    END IF;
    EXECUTE format('ALTER TABLE be_bus.message DETACH PARTITION be_bus.%I', p_name);
    EXECUTE format('DROP TABLE be_bus.%I', p_name);
    RETURN true;
END $fn$;

REVOKE ALL ON FUNCTION be_bus.ensure_partition(timestamptz), be_bus.drop_partition(text, timestamptz) FROM PUBLIC;
RESET ROLE;
-- per component, by the database initialisation:
--   GRANT USAGE ON SCHEMA be_bus TO <PG_USER>;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA be_bus TO <PG_USER>;
--   GRANT USAGE ON SEQUENCE be_bus.message_seq TO <PG_USER>;
--   GRANT EXECUTE ON FUNCTION be_bus.ensure_partition(timestamptz), be_bus.drop_partition(text, timestamptz) TO <PG_USER>;
