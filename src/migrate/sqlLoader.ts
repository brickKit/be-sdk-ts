// The loader node-pg-migrate uses for a component's `.sql` migrations. It reads files exactly as the tool's
// own SQL loader does (`-- Up Migration` / `-- Down Migration` sections; a file without markers is all "up"
// and cannot be reverted) and adds the protocol's header `-- be:no-transaction` (P11.4): such a file runs
// outside a transaction, as `CREATE INDEX CONCURRENTLY` requires.
import { readFile } from "node:fs/promises";
import type { MigrationBuilder } from "node-pg-migrate/migrationBuilder";
import type { MigrationLoaderStrategy, MigrationUnit } from "node-pg-migrate/migrationLoader";

const NO_TX = /^--\s*be:no-transaction\s*$/;
const marker = (dir: string) => new RegExp(`^\\s*--[\\s-]*${dir}\\s+migration`, "im");

export interface SqlActions {
  up: { sql: string };
  down: { sql: string } | undefined;
  noTransaction: boolean;
}

export function sqlActions(content: string): SqlActions {
  const upAt = content.search(marker("up"));
  const downAt = content.search(marker("down"));
  const up = upAt >= 0 ? content.slice(upAt, downAt < upAt ? undefined : downAt) : content;
  const down = downAt >= 0 ? content.slice(downAt, upAt < downAt ? undefined : upAt) : undefined;
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  return { up: { sql: up }, down: down === undefined ? undefined : { sql: down }, noTransaction: NO_TX.test(firstLine.trimEnd()) };
}

function action(sql: string, noTransaction: boolean) {
  return (pgm: MigrationBuilder) => {
    if (noTransaction) pgm.noTransaction();
    pgm.sql(sql);
  };
}

async function load(filePaths: string[]): Promise<MigrationUnit[]> {
  const units: MigrationUnit[] = [];
  for (const filePath of filePaths) {
    const a = sqlActions(await readFile(filePath, "utf8"));
    units.push({
      id: filePath,
      filePaths: [filePath],
      // `down: false` is the tool's "this migration cannot be reverted"
      actions: { up: action(a.up.sql, a.noTransaction), down: a.down ? action(a.down.sql, a.noTransaction) : false },
    });
  }
  return units;
}

export const sqlLoaderStrategies: MigrationLoaderStrategy[] = [{ extensions: [".sql"], loader: load }];

/** node-pg-migrate's ignorePattern (a whole-name regex): everything but `*.sql`, so lifecycle.yaml is skipped. */
export const SQL_ONLY_IGNORE = String.raw`(\..*)|(.*(?<!\.sql))`;
