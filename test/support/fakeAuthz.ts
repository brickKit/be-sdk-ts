// An authorization member serving GET /authz/v2/bundle with ETag (contract-infra-authz authz/2, reduced).
import { createServer } from "node:http";

export interface FakeAuthz {
  url: string;
  /** the changefeed GET /authz/v2/changes serves (contract-infra-authz changefeed.schema.json) */
  changes: { revision: string; op: "upsert" | "delete"; tuple: Record<string, unknown> }[];
  requests: { inm?: string }[];
  setBundle(b: unknown): void;
  down(d: boolean): void;
  close(): Promise<void>;
}

export function bundle(roles: Record<string, string[]>, extra: Record<string, unknown> = {}) {
  return {
    contract: "authz/2.0", revision: "1", roles, grants: {}, profiles: {}, delegations: [], stale_since: {}, revoked_grants: {},
    capabilities: { core: true, delegation: true, agents: false, impersonation: false, sharing: false, graph: false }, ...extra,
  };
}

export async function fakeAuthz(initial: unknown = bundle({ rep: ["sdktest.basic.view"] })): Promise<FakeAuthz> {
  let body = JSON.stringify(initial);
  let version = 1;
  let isDown = false;
  const requests: { inm?: string }[] = [];
  const changes: FakeAuthz["changes"] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/authz/v2/changes") {
      const after = BigInt(u.searchParams.get("after") ?? "0");
      const page = changes.filter((c) => BigInt(c.revision) > after);
      const head = changes.at(-1)?.revision ?? "0";
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ changes: page, next: page.at(-1)?.revision ?? String(after), watermark: BigInt(head) > after ? head : String(after) }));
    }
    if (req.url !== "/authz/v2/bundle") return void res.writeHead(404).end();
    requests.push({ inm: req.headers["if-none-match"] });
    if (isDown) return void res.writeHead(503).end();
    const etag = `"v${version}"`;
    if (req.headers["if-none-match"] === etag) return void res.writeHead(304, { etag }).end();
    res.writeHead(200, { etag, "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    changes,
    requests,
    setBundle(b) {
      body = JSON.stringify(b);
      version++;
    },
    down(d) {
      isDown = d;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
