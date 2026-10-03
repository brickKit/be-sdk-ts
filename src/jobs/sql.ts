// The statements of P14 "Statements", on the member's own besdk_job_* tables (ddl/05-jobs.sql).

export const LEASE_ROW = `INSERT INTO besdk_job_lease (name, holder, epoch, expires_at) VALUES ($1, '', 0, now())
  ON CONFLICT (name) DO NOTHING`;
export const LEASE_TAKE = `UPDATE besdk_job_lease
   SET holder = $2, epoch = CASE WHEN holder = $2 THEN epoch ELSE epoch + 1 END,
       expires_at = now() + make_interval(secs => $3::double precision / 1000)
 WHERE name = $1 AND (expires_at < now() OR holder = $2)
 RETURNING epoch`;
export const LEASE_RENEW = `UPDATE besdk_job_lease SET expires_at = now() + make_interval(secs => $3::double precision / 1000)
 WHERE name = $1 AND holder = $2 AND epoch = $4 RETURNING 1`;
export const LEASE_RELEASE = `UPDATE besdk_job_lease SET expires_at = now() WHERE name = $1 AND holder = $2`;

export const SLOT_CLAIM = `INSERT INTO besdk_job_slot (name, slot_at, holder) VALUES ($1, $2, $3)
  ON CONFLICT (name, slot_at) DO NOTHING RETURNING 1`;
export const SLOT_DONE = `UPDATE besdk_job_slot SET done_at = now(), result = $3 WHERE name = $1 AND slot_at = $2`;

export const QUEUE_INSERT = `INSERT INTO besdk_job_queue (id, kind, args, unique_key, run_at, max_attempts, traceparent, causation_id, hop_count)
  VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8, $9)
  ON CONFLICT (kind, unique_key) WHERE unique_key IS NOT NULL AND state <> 'done' DO NOTHING`;
export const QUEUE_CLAIM = `UPDATE besdk_job_queue q
   SET state = 'running', attempts = q.attempts + 1, lease_until = now() + make_interval(secs => $3::double precision / 1000)
 WHERE q.id IN (SELECT id FROM besdk_job_queue
                 WHERE kind = $1 AND ((state = 'ready' AND run_at <= now()) OR (state = 'running' AND lease_until < now()))
                 ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED)
 RETURNING q.id::text AS id, q.kind, q.args, q.attempts, q.max_attempts, q.unique_key, q.causation_id, q.hop_count`;
export const QUEUE_DONE = `UPDATE besdk_job_queue SET state = 'done', finished_at = now(), lease_until = NULL WHERE id = $1 AND state = 'running'`;
export const QUEUE_RETRY = `UPDATE besdk_job_queue SET state = 'ready', lease_until = NULL, last_error = $2,
  run_at = now() + make_interval(secs => $3::double precision / 1000) WHERE id = $1 AND state = 'running'`;
export const QUEUE_DEAD = `UPDATE besdk_job_queue SET state = 'dead', lease_until = NULL, last_error = $2, finished_at = now()
  WHERE id = $1 AND state = 'running' RETURNING 1`;
export const QUEUE_STATS = `SELECT kind, state, count(*)::int AS n,
  COALESCE(EXTRACT(EPOCH FROM now() - min(run_at) FILTER (WHERE state = 'ready' AND run_at <= now())), 0)::float8 AS oldest
  FROM besdk_job_queue WHERE state <> 'done' GROUP BY kind, state`;

export const RECONCILE_CLAIM = `INSERT INTO besdk_reconcile (name, item_id, lease_until) VALUES ($1, $2, now() + make_interval(secs => $3::double precision / 1000))
  ON CONFLICT (name, item_id) DO UPDATE SET lease_until = now() + make_interval(secs => $3::double precision / 1000)
   WHERE (besdk_reconcile.lease_until IS NULL OR besdk_reconcile.lease_until < now())
     AND besdk_reconcile.next_at <= now()
  RETURNING attempts`;
export const RECONCILE_DONE = `DELETE FROM besdk_reconcile WHERE name = $1 AND item_id = $2`;
export const RECONCILE_FAILED = `UPDATE besdk_reconcile SET attempts = attempts + 1, lease_until = NULL, last_error = $3
  WHERE name = $1 AND item_id = $2 RETURNING attempts`;
export const RECONCILE_NEXT = `UPDATE besdk_reconcile SET next_at = now() + make_interval(secs => $3::double precision / 1000) WHERE name = $1 AND item_id = $2`;
export const RECONCILE_STATS = `SELECT count(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - min(next_at)), 0)::float8 AS oldest
  FROM besdk_reconcile WHERE name = $1`;

export const CLEANUP = [
  `DELETE FROM besdk_idempotency WHERE expires_at < now()`,
  `DELETE FROM besdk_job_queue WHERE state = 'done' AND finished_at < now() - interval '7 days'`,
  `DELETE FROM besdk_job_slot WHERE slot_at < now() - interval '30 days'`,
];
