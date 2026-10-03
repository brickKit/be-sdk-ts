// Shapes of the data lifecycle (be-protocol P16): the declaration migrations/lifecycle.yaml v1, the deployment
// value DATA_LIFECYCLE, the units the engine tracks and the actions its planner emits.

export type TableClass = "master" | "reference" | "document" | "ledger" | "audit" | "queue" | "snapshot" | "platform";
export type Grain = "week" | "month" | "year";
export type Anchor = "created" | "closed" | "sealed" | "fiscal_year_end";
export type ErasureAction = "delete" | "anonymize" | "restrict";

export type RangePartitionDecl = { by: string; grain: Grain; ahead?: number };
export type ListPartitionDecl = { by: string; kind: "list"; opened_by: "command" };

export interface ClosedRule {
  column: string;
  in: string[];
  at: string;
}

export interface TableDecl {
  class?: TableClass;
  follows?: string;
  partition?: RangePartitionDecl | ListPartitionDecl;
  closed?: ClosedRule;
  tiers?: { hot?: string; seal?: string; cold?: string };
  retention?: { min?: string; basis?: string; end?: "keep" | "destroy" | "review" };
  erasure?:
    | { subject: string; key: string; columns: Record<string, ErasureAction> }
    | { subject: string; key: string; action: "delete" };
  pii?: string[];
  checkpoint?: string;
  guard?: { blocked_by: string };
  dataset?: { publish?: boolean; exclude?: string[]; pseudonymize?: string[] };
}

export interface Declaration {
  lifecycle: "v1";
  tenant_key?: string;
  requires?: string[];
  tables: Record<string, TableDecl>;
}

/** A table's declaration with `follows` resolved: class, partition and rules come from the parent. */
export interface EffectiveTable extends TableDecl {
  name: string;
  class: TableClass;
  /** tables that follow this one (same partition bounds; sealed, frozen, destroyed with it) */
  followers: string[];
}

export type Mode = "on" | "dry-run" | "off";

export interface LifecycleConfig {
  mode: Mode;
  cold_store: "none";
  cold_query: "none";
  publisher: "none";
  pii: "plain";
  dialect: "pg-native";
  /** per-table overrides, already checked against the declaration */
  tables: Record<string, { retention?: { min?: string }; tiers?: { hot?: string; seal?: string; cold?: string } }>;
}

export const UNIT_STATES = [
  "ACTIVE", "BLOCKED", "SEALED", "EXPORTING", "EXPORTED", "VERIFIED", "COLD_PENDING_DROP", "COLD", "THAWED", "DESTROYED",
] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/** States whose rows are sealed (immutable and part of the digest chain). */
export const SEALED_STATES: ReadonlySet<UnitState> = new Set([
  "SEALED", "EXPORTING", "EXPORTED", "VERIFIED", "COLD_PENDING_DROP", "COLD", "THAWED", "DESTROYED",
]);
/** States whose rows are no longer attached (read through the cold tier, P16.3). */
export const COLD_STATES: ReadonlySet<UnitState> = new Set(["COLD_PENDING_DROP", "COLD"]);

/** One attached partition of a table, with the statistics the planner needs (P0: past partitions only). */
export interface PartitionState {
  name: string;
  from?: Date;
  to?: Date;
  listValue?: string;
  /** the sealed-unit guard (besdk_sealed_rows) is installed */
  guarded: boolean;
  /** present for partitions whose range has ended; absent = not counted */
  stats?: { rows: number; openRows: number; maxClosedAt?: Date };
}

export interface UnitRecord {
  table: string;
  unitKey: string;
  state: UnitState;
  rangeFrom?: Date;
  rangeTo?: Date;
  sealedAt?: Date;
}

export interface HoldScope {
  tables?: string[];
  units?: { table: string; unit_key: string }[];
  subjects?: { subject: string; subject_id: string }[];
}

export interface HoldRecord {
  holdId: string;
  scope: HoldScope;
}

export interface PlannerState {
  /** attached partitions by table */
  partitions: Record<string, PartitionState[]>;
  /** besdk_lifecycle_units by table, then unit key */
  units: Record<string, Record<string, UnitRecord>>;
  /** holds in force */
  holds: HoldRecord[];
  /** "<table>/<unit>" of units already on a destruction list */
  proposed: ReadonlySet<string>;
}

export type Action =
  | { kind: "ensure_partition"; table: string; unit: string; from: Date; to: Date; followers: string[] }
  | { kind: "install_guard"; table: string; unit: string }
  | { kind: "seal"; table: string; unit: string; from?: Date; to?: Date }
  | { kind: "expire"; table: string; unit: string; class: "queue" | "platform" }
  | { kind: "propose_destruction"; table: string; unit: string; basis: string; end: "destroy" | "review" };

export type ActionKind = Action["kind"];
