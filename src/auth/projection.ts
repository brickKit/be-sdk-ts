// The ACL projection (P6.12): direct tuples of the component's resource types (and the types they inherit from) in
// its own besdk_authz_acl, pulled from GET {AUTHZ_URL}/authz/v2/changes after the cursor every 5 s and on a poke;
// a 410 rebuilds from the GET /authz/v2/tuples snapshot and continues from its revision. Subject-side expansion
// happens at query time (P6.4). Relations the component owns go out through the outbox (P6.13).
import type { Logger } from "pino";
import { insertOutbox } from "../events/outbox.js";
import type { Store } from "../store/store.js";
import type { Tx } from "../store/tx.js";
import type { AclRow } from "./evaluate.js";

const FETCH_TIMEOUT_MS = 3_000;
const PAGE = 500;
const SNAPSHOT_PAGE = 1_000;

interface Tuple {
  object: { type: string; id: string };
  relation: string;
  subject: string;
  expires_at?: string | null;
}
interface Change {
  revision: string;
  op: "upsert" | "delete";
  tuple: Tuple;
}

const UPSERT = `INSERT INTO besdk_authz_acl (rtype, rid, relation, subject, expires_at, revision) VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (rtype, rid, relation, subject) DO UPDATE SET expires_at = EXCLUDED.expires_at, revision = EXCLUDED.revision`;
const DELETE = `DELETE FROM besdk_authz_acl WHERE rtype = $1 AND rid = $2 AND relation = $3 AND subject = $4`;
const CURSOR = `INSERT INTO besdk_authz_cursor (scope, revision) VALUES ($1, $2)
  ON CONFLICT (scope) DO UPDATE SET revision = EXCLUDED.revision`;

/** The AuthzGone signal of a changes request the provider can no longer serve (410). */
class Gone extends Error {}

export interface ProjectionOptions {
  store: Store;
  authzUrl: string;
  /** the component's resource types plus the types they inherit from */
  types: string[];
  logger: Logger;
}

export class Projection {
  private readonly o: ProjectionOptions;
  private readonly scope: string;

  constructor(o: ProjectionOptions) {
    this.o = o;
    this.scope = [...new Set(o.types)].sort().join(",");
  }

  /** The watermark: every change ≤ it is applied. */
  async watermark(): Promise<bigint> {
    const rows = await this.o.store.tx((tx) => tx.query<{ revision: string }>(`SELECT revision::text AS revision FROM besdk_authz_cursor WHERE scope = $1`, [this.scope]));
    return BigInt(rows[0]?.revision ?? "0");
  }

  /** Pulls until caught up; a 410 rebuilds from the snapshot (the next pull continues from its revision). */
  async pull(): Promise<void> {
    let after = await this.watermark();
    for (;;) {
      let page: { changes: Change[]; next: string; watermark: string };
      try {
        page = (await this.get(`/authz/v2/changes?types=${encodeURIComponent(this.scope)}&after=${after}&limit=${PAGE}`)) as typeof page;
      } catch (e) {
        if (!(e instanceof Gone)) throw e;
        this.o.logger.warn({ scope: this.scope, after: String(after) }, "authz_changes_gone_rebuilding");
        await this.rebuild();
        return;
      }
      const caughtUp = page.changes.length < PAGE;
      const to = BigInt(caughtUp ? page.watermark : page.next);
      await this.o.store.tx(async (tx) => {
        for (const c of page.changes) await apply(tx, c);
        await tx.query(CURSOR, [this.scope, (to > after ? to : after).toString()]);
      });
      if (caughtUp) return;
      after = to;
    }
  }

  /** Replaces the projection of every type with the provider's snapshot; the cursor becomes the oldest snapshot revision. */
  private async rebuild(): Promise<void> {
    const snapshots: { tuples: Tuple[]; revision: bigint }[] = [];
    for (const t of this.scope.split(",")) snapshots.push(await this.snapshot(t));
    const from = snapshots.reduce((m, s) => (s.revision < m ? s.revision : m), snapshots[0]?.revision ?? 0n);
    await this.o.store.tx(async (tx) => {
      await tx.query(`DELETE FROM besdk_authz_acl WHERE rtype = ANY($1::text[])`, [this.scope.split(",")]);
      for (const s of snapshots) for (const t of s.tuples) await apply(tx, { revision: s.revision.toString(), op: "upsert", tuple: t });
      await tx.query(CURSOR, [this.scope, from.toString()]);
      await tx.query(`UPDATE besdk_authz_cursor SET rebuilt_at = now() WHERE scope = $1`, [this.scope]);
    });
  }

  private async snapshot(type: string): Promise<{ tuples: Tuple[]; revision: bigint }> {
    const tuples: Tuple[] = [];
    let cursor = "";
    let revision = 0n;
    do {
      const page = (await this.get(`/authz/v2/tuples?type=${encodeURIComponent(type)}&cursor=${encodeURIComponent(cursor)}&page_size=${SNAPSHOT_PAGE}`)) as { tuples: Tuple[]; next_cursor: string; revision: string };
      tuples.push(...page.tuples);
      revision = BigInt(page.revision);
      cursor = page.next_cursor;
    } while (cursor !== "");
    return { tuples, revision };
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.o.authzUrl}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 410) throw new Gone();
    if (res.status !== 200) throw new Error(`${path.split("?")[0]} answered ${res.status}`);
    return res.json();
  }
}

async function apply(tx: Tx, c: Change): Promise<void> {
  const t = c.tuple;
  if (c.op === "delete") await tx.query(DELETE, [t.object.type, t.object.id, t.relation, t.subject]);
  else await tx.query(UPSERT, [t.object.type, t.object.id, t.relation, t.subject, t.expires_at ?? null, c.revision]);
}

/** The projection rows of one record, for a single-record decision (E10). */
export async function aclOf(tx: Tx, rtype: string, rid: string): Promise<AclRow[]> {
  const rows = await tx.query<{ rtype: string; rid: string; relation: string; subject: string; expires_at: Date | null }>(
    `SELECT rtype, rid, relation, subject, expires_at FROM besdk_authz_acl WHERE rtype = $1 AND rid = $2`, [rtype, rid]);
  return rows.map((r) => ({ rtype: r.rtype, rid: r.rid, relation: r.relation, subject: r.subject, expires_at: r.expires_at ? r.expires_at.toISOString() : null }));
}

/**
 * P6.13: replaces the group (type, id, relation) the component owns with `subjects`, through the outbox
 * (infra.authz.relation.sync.v1, aggregate infra.authz.relation_group, the group's monotonic version).
 */
export function syncRelation(tx: Tx, rtype: string, id: string, relation: string, subjects: string[], version: bigint): Promise<void> {
  const payload = { object: { type: rtype, id }, relation, subjects: subjects.map((subject) => ({ subject })) };
  return insertOutbox(tx, {
    subject: "infra.authz.relation.sync.v1", aggregateType: "infra.authz.relation_group", aggregateId: `${rtype}:${id}#${relation}`,
    version, payloadJson: JSON.stringify(payload),
  });
}
