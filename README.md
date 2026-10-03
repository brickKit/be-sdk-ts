[English](README.md) · [中文](README.zh.md)

# be-sdk-ts

The official TypeScript runtime of the BrickEnterprise component protocol, **be-protocol 1.0** (`brickKit/be-protocol`, pinned at `v1.0.0-rc.1`). A component written with it meets the protocol's requirements on the wire; the black-box suite `conformance/component/` of `brickKit/be-acceptance` checks that. It is not a brickKit component and holds no business logic.

The same nouns as `be-sdk-go` and `be-sdk-python`, in camelCase: `defineComponent`, `main`, `Module`, `Runtime`, `rt.store()`, `store.tx`, `tx.publish`, `access()`, `rt.conn` / `rt.client`, `rt.userHttp`, `beError`.

## A component

```ts
import { main, defineComponent, PUBLIC, access, beError } from "@brickkit/be-sdk-ts";

main(defineComponent({
  id: "erp/sales",
  migrations: "migrations",          // node-pg-migrate SQL files + lifecycle.yaml
  contracts: "contracts",            // errors.yaml, events/*.events.json
  create: async (rt) => ({
    http: (r) => {
      r.post("/orders", "erp.sales.create", async (req) => {
        const id = await rt.store().tx(async (tx) => {
          // … business writes with tx.query(sql, params, zodRow?) …
          await tx.publish({ subject: "sales.order.created.v1", aggregateId: orderId, version: 1, payload });
          return orderId;
        });
        return { id };
      }, { timeoutMs: 15_000 });
      r.get("/me", PUBLIC, async () => ({ ok: true }));
    },
    grpc: (s) => s.addService(SalesServiceService, impl, { schema: protoMetadata }),
    events: {
      publishes: ["sales.order.created.v1"],
      subscribe: [{ subject: "finance.credit.rejected.v1", apply: async (tx, ev) => { /* local writes */ } }],
    },
  }),
}));
```

The image's entry points (P1.1): no argument serves; `migrate up | down <n> | status` migrates (`component.yaml` `migration.command: [node, main.js, migrate, up]`); `job run <name>` is reserved (P14.8, see *Not yet*). Exit codes: 0 clean stop or migration done (also when the schema is newer than the image), 1 a failed initialisation or migration, 64 an unknown argument or job, 78 a configuration error (one JSON line per key).

## What it implements

| Area | Requirements | Notes |
|---|---|---|
| Process | P1.1–P1.8, P1.13 | start order, `/healthz`, `/readyz` (bundle, `db_identity`, `migrations`; latched), SIGTERM drains within `SHUTDOWN_GRACE`, supervised background work (1 s → 5 min), dual-stack listen |
| Configuration | P2 | only `configSchema` keys, strict types by the catalogue (`schemas/config-keys.yaml`), all errors at once, `_FILE` secrets read and re-read by mtime/size, `*_ENDPOINT` and family addresses (`$endpoint:` values, no port arithmetic); the serve entry point never opens `PG_OWNER_PASSWORD_FILE` |
| HTTP | P3.1–P3.6, P3.10, P3.12 | one Fastify 5 instance per member; `headersTimeout` 5000 + `connectionsCheckingInterval` 1000, `requestTimeout` 30000, `keepAliveTimeout` 120000, `bodyLimit` 1 MiB, `handlerTimeout` = route deadline answered 504 |
| Errors | P4 | problem+json, gRPC status + `google.rpc` details, relaying a dependency's reason, the 33 reasons of `errors-be.yaml` |
| Identity, authorization | P5, P6.1, P6.2 | JWT (RS256/ES256/EdDSA, `typ=access`, iss/aud/exp/iat/jti, JWKS cache), bundle `authz/2.x` (E1–E5: stale, revoked grants, delegation, windows, ceilings, keys), `access().user()` / `.has(k)` |
| System plane | P7 | server chain, batch limits from ts-proto `protoMetadata`, channel per dependency, retry service config from `idempotency_level`, outbound deadline, bulkhead 64 |
| Outbound HTTP | P8 | `rt.userHttp(dep)` forwards the caller's token; `rt.externalHttp(name)` forwards nothing internal; both refuse inside a transaction |
| Database | P10 | `Store` / `Tx`, the `SET LOCAL` block, `/* be:<schema> */` prefix with unnamed statements, timeouts, retries, SQLSTATE mapping, member budget, start-up probe |
| Migrations | P11.1–P11.3 | owner login, per-schema lock, state tables `pgmigrations_<schema>` / `besdk_migrations_<schema>`, the platform migration (reference DDL), the outbox window, streams and durables |
| Events | P12 | outbox, pump (PubAck), JetStream durables created never updated, runtime-side redelivery and dead letters, aggregate-stream cursor, causation and hop count |
| Observability | P18 (partly), P20 | per-member tracer provider over a shared exporter, W3C propagator, JSON logs with redaction and 2 KiB lines, `be_` metrics with `component`, `/_be/info` |
| Mobile BFF | P4.5 | `mountGraphQL` (persisted operations, depth and cost limits), `guard(key, resolver)`, `createBatchGetLoader` |

## Migrations directory

Only `*.sql` files and `lifecycle.yaml`. A file name starts with a number (`0001_create-orders.sql`); the file has a `-- Up Migration` section and an optional `-- Down Migration` section (node-pg-migrate's SQL format); one transaction per file, except a file whose first line is `-- be:no-transaction` (a lone `CREATE INDEX CONCURRENTLY`, P11.4). Names are unqualified (P11.2).

## Notes for this runtime

- **grpc-js** cannot enforce the server keepalive policy (`MinTime`, P7.5); clients keep P7.6. Its retry budget is shared per process and target and does not refill on re-resolution (P7.8): members of a TypeScript shell calling one dependency share it.
- **`rt.client(Ctor, dep, protoMetadata)`** takes the generated `protoMetadata` (ts-proto `outputServices=grpc-js,esModuleInterop=true,outputSchema=true,importSuffix=.js,enumsAsLiterals=true`): retries and batch limits come from it.
- **Node quirks handled here**: `close()` of an HTTP server keeps the connection of a request that was in flight, so idle connections are closed while draining; `request.signal` aborts once a POST body has been read, so a unit's cancellation is the route deadline or a client that went away; `BeError` is recognised by a brand, not `instanceof`, because two copies of a module graph do not share classes.

## Not yet (later tasks of v0.6.0)

Idempotency (`idempotent`, `tx.idem*`, P13), jobs and reconcilers and `job run` (P14), scopes, record decisions, projection and the resource contract (P6.3–P6.15), the lifecycle engine and business partition windows (P16), calendar, money, numbering, object storage, caches, snapshots (P11.6–P11.10, P15, P17), the authz poke subscription (P12.10), an OTel MeterProvider exported on `/metrics` (`rt.meter` is a no-op meter today), the PostgreSQL bus adapter (P12.12), the testing package and the shell launcher (P19).

## Development

```sh
make sync-protocol      # copy schemas/, ddl/, proto/, vectors/ of be-protocol (and the authz decision vectors) at the pinned tags into protocol/
make test               # typecheck + unit tests: the protocol vectors, pure logic, in-process servers
make test-integration   # throwaway postgres:16, postgres:14, nats:2.12 containers (prefix sdkb-ts-), then removed
make build              # dist/
```

`protocol/` is committed: the runtime ships `protocol/schemas` and `protocol/ddl`, the tests read `protocol/vectors`; `protocol/PINNED` names the commits. `platform-migrations/` is generated from `protocol/ddl` by `scripts/gen-platform-migration.mjs` (`--check` verifies it).
