// An authorization member serving GET /authz/v2/bundle with ETag (contract-infra-authz authz/2, reduced).
import { createServer } from "node:http";

export interface FakeAuthz {
  url: string;
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
  const server = createServer((req, res) => {
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
