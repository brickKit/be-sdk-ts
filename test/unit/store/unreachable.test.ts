// A database that cannot be reached answers DEPENDENCY_UNAVAILABLE with metadata.dependency = "db" (stage-B
// ruling: one reason for every unreachable dependency; UPSTREAM_UNAVAILABLE is the edge's).
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Config } from "../../../src/config/config.js";
import { readManifest } from "../../../src/config/manifest.js";
import type { BeError } from "../../../src/errors/beError.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Store } from "../../../src/store/store.js";
import { captureLogger } from "../../support/capture.js";
import { DB_FIXTURE } from "../../support/pg.js";

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe("unreachable database", () => {
  it("answers UNAVAILABLE / DEPENDENCY_UNAVAILABLE with metadata.dependency db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "besdk-unreach-"));
    writeFileSync(join(dir, "pw"), "x\n");
    const env = { PG_HOST: "127.0.0.1", PG_PORT: String(await closedPort()), PG_DATABASE: "d", PG_USER: "u", PG_PASSWORD_FILE: join(dir, "pw"), PG_OWNER_USER: "o", PG_OWNER_PASSWORD_FILE: join(dir, "pw"), PG_SCHEMA: "s" };
    const config = Config.load(readManifest(join(DB_FIXTURE, "component.yaml")), env);
    const store = new Store({ memberId: "sdktest/db", config, logger: captureLogger().logger, metrics: newMemberRegistry("sdktest/db") });
    const e = (await store.tx(async (tx) => tx.query("SELECT 1")).catch((x: unknown) => x)) as BeError;
    await store.close();
    expect([e.code, e.reason, e.domain, e.metadata]).toEqual(["UNAVAILABLE", "DEPENDENCY_UNAVAILABLE", "be", { dependency: "db" }]);
  });
});
