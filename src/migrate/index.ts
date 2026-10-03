// The migrate entry point's building blocks (P11.1, P11.3): runMigrations for `migrate up|down|status`, and the
// outbox window helper the runtime's outbox pump reuses as the runtime role.
export { runMigrations, PLATFORM_VERSION, type MigrateOptions, type MigrateResult } from "./run.js";
export { ensureOutboxWindow, ensureRangeWindow, outboxWindow, weekStartUtc, OUTBOX_TABLE, type RangePartition } from "./window.js";
export { migrationLockValue, componentStateTable, platformStateTable } from "./lockKey.js";
export { SQL_ONLY_IGNORE } from "./sqlLoader.js";
