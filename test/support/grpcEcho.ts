// An in-process EchoService (test/proto/sdktest/v1/echo.proto) behind the runtime's gRPC server, and clients
// through the runtime's GrpcClients. Each harness has its own port, hence its own grpc-js retry budget (r1-03).
import { credentials, Metadata, type ServerUnaryCall } from "@grpc/grpc-js";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { deadline, requestId, signal, system } from "../../src/context.js";
import { BeError, platformError } from "../../src/errors/beError.js";
import { componentCatalog } from "../../src/errors/catalog.js";
import { GrpcClients } from "../../src/grpc/clients.js";
import { buildGrpcServer, type GrpcServer } from "../../src/grpc/server.js";
import { newMemberRegistry, type MemberRegistry } from "../../src/obs/metrics.js";
import { Telemetry } from "../../src/obs/telemetry.js";
import { EchoServiceClient, EchoServiceService, protoMetadata, type EchoReply } from "../gen/sdktest/v1/echo.js";
import { captureLogger } from "./capture.js";

export const SERVER_ID = "sdktest/echo";
export const CLIENT_ID = "sdktest/caller";

export interface EchoHarness {
  server: GrpcServer;
  port: number;
  /** attempts per request id */
  attempts: Map<string, number>;
  /** the client address of every call: one per TCP connection */
  peers: Set<string>;
  approveRan: { value: boolean };
  log: ReturnType<typeof captureLogger>;
  reg: MemberRegistry;
  spans: InMemorySpanExporter;
  /** flushes the server member's spans into `spans` */
  flushSpans(): Promise<void>;
  /** a member's GrpcClients whose `sdktest/echo` dependency points at this server */
  clients(memberId?: string): { clients: GrpcClients; reg: MemberRegistry };
  /** a plain grpc-js client: no runtime interceptors, so no be-caller unless the test sets it */
  raw(): InstanceType<typeof EchoServiceClient>;
  close(): Promise<void>;
}

const sleep = (ms: number, s?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    s?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

/** what the handler sees; deadlineRemainingMs is the unit of work's deadline (the call's, or the 10 s floor) */
function seen(call: ServerUnaryCall<any, any>, id = ""): EchoReply {
  const ms = deadline() ?? Infinity;
  const sys = system();
  return {
    id, caller: sys?.caller ?? "", actorSub: sys?.actorSub ?? "", actorAct: sys?.act ?? "", requestId: requestId(),
    traceparent: String(call.metadata.get("traceparent")[0] ?? ""),
    deadlineRemainingMs: Number.isFinite(ms) ? ms - Date.now() : -1, peer: call.getPeer(), attempts: 0, cancelled: false,
  };
}

export async function echoHarness(o: { maxConnectionAgeMs?: number; deadlineFloorMs?: number } = {}): Promise<EchoHarness> {
  const spans = new InMemorySpanExporter();
  const telemetry = Telemetry.withExporter(spans, { namespace: "t", environment: "test" });
  const log = captureLogger(SERVER_ID, "debug");
  const reg = newMemberRegistry(SERVER_ID);
  const member = telemetry.member(SERVER_ID, "3.0.0");
  const attempts = new Map<string, number>();
  const peers = new Set<string>();
  const approveRan = { value: false };
  const server = buildGrpcServer({
    memberId: SERVER_ID, locale: "en", catalog: componentCatalog(SERVER_ID, undefined), logger: log.logger, metrics: reg,
    tracer: member.tracer, maxConnectionAgeMs: o.maxConnectionAgeMs ?? 300_000,
    ...(o.deadlineFloorMs ? { deadlineFloorMs: o.deadlineFloorMs } : {}),
  });
  const count = (call: ServerUnaryCall<any, any>, id: string, failFirst: number) => {
    peers.add(call.getPeer());
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    if (n <= failFirst) throw platformError("NOT_READY", { waiting: "test" });
    return { ...seen(call, id), attempts: n };
  };
  server.addService(EchoServiceService, {
    // callback style, as grpc-js generated servers are written
    get: (call: ServerUnaryCall<any, any>, cb: (e: unknown, r?: EchoReply) => void) => {
      try { cb(null, count(call, call.request.id, call.request.failFirst)); } catch (e) { cb(e); }
    },
    // async style
    touch: async (call: ServerUnaryCall<any, any>) => count(call, call.request.id, 0),
    create: async (call: ServerUnaryCall<any, any>) => count(call, call.request.id, call.request.failFirst),
    batchGet: async (call: ServerUnaryCall<any, any>) => ({ count: call.request.ids.length }),
    slow: async (call: ServerUnaryCall<any, any>) => {
      peers.add(call.getPeer());
      const r = seen(call);
      const s = signal()!;
      await sleep(call.request.ms, s);
      return { ...r, cancelled: s.aborted };
    },
    fail: async (call: ServerUnaryCall<any, any>) => {
      const q = call.request;
      if (q.throwPlain) throw new Error("SELECT secret FROM vault failed at /srv/app.ts:12");
      throw new BeError(q.code, q.reason, {
        metadata: q.metadata, message: q.message || undefined,
        violations: q.violationField ? [{ field: q.violationField, reason: "MUST_BE_POSITIVE", description: "must be > 0" }] : [],
        retryAfterMs: q.retryAfterMs || undefined,
      });
    },
    approve: async () => {
      approveRan.value = true;
      return {};
    },
  }, { schema: protoMetadata, userFacing: ["Approve"] });
  const port = await server.listen(0);
  const made: GrpcClients[] = [];
  const opened: { close(): void }[] = [];
  return {
    server, port, attempts, peers, approveRan, log, reg, spans,
    flushSpans: () => member.provider.forceFlush(),
    clients(memberId = CLIENT_ID) {
      const creg = newMemberRegistry(memberId);
      const clients = new GrpcClients({
        memberId, metrics: creg,
        config: {
          endpoint: (dep, p = "") => (dep === SERVER_ID && p === "grpc" ? `127.0.0.1:${port}` : dep === "sdktest/dead" ? "127.0.0.1:1" : undefined),
          familyAddress: (k) => (k === "AUTHZ_GRPC_URL" ? `127.0.0.1:${port}` : undefined),
        },
      });
      made.push(clients);
      return { clients, reg: creg };
    },
    raw() {
      const c = new EchoServiceClient(`127.0.0.1:${port}`, credentials.createInsecure());
      opened.push(c);
      return c;
    },
    async close() {
      for (const c of made) c.close();
      for (const c of opened) c.close();
      await server.close(1000);
    },
  };
}

export function md(entries: Record<string, string>): Metadata {
  const m = new Metadata();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

export { EchoServiceClient, protoMetadata };
