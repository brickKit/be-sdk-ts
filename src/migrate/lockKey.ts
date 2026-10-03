// The migration lock id (P11.1, r1-06): node-pg-migrate's default lock id is one constant for every database
// user, so two components migrating the same database would refuse each other. The id is derived from the
// schema and the component state table instead, as FNV-1a 64 truncated to 53 bits (exact in a JS number).

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;
const MASK53 = (1n << 53n) - 1n;

export function fnv1a53(text: string): number {
  let h = OFFSET;
  for (const byte of Buffer.from(text, "utf8")) {
    h ^= BigInt(byte);
    h = (h * PRIME) & MASK64;
  }
  return Number(h & MASK53);
}

export function componentStateTable(schema: string): string {
  return `pgmigrations_${schema}`;
}

export function platformStateTable(schema: string): string {
  return `besdk_migrations_${schema}`;
}

/** One lock per schema, held for the whole migration step (component + platform migration). */
export function migrationLockValue(schema: string): number {
  return fnv1a53(`${schema}:${componentStateTable(schema)}`);
}
