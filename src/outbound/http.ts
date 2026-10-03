// Outbound HTTP (P8): `UserHttp` calls another component's user plane with the caller's own token; `ExternalHttp`
// calls a third party with no internal header. Both are undici-based, counted in be_http_client_*, guarded by
// P8.4, and (user plane) bounded by the outbound deadline and the bulkhead.
import { context, propagation } from "@opentelemetry/api";
import { Agent, fetch as ufetch, type RequestInit as URequestInit, type Response as UResponse } from "undici";
import { currentUnit } from "../context.js";
import { BeError, isBeError, platformError } from "../errors/beError.js";
import { restoreHttp } from "../errors/problem.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { Bulkhead, outboundTimeoutMs, refuseInTx } from "./guards.js";

export interface UserHttpOptions {
  memberId: string;
  dependency: string;
  /** host:port of the dependency's main port (its `*_ENDPOINT`) */
  address: string;
  metrics: MemberRegistry;
}

const RESET = new Set(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]);

export class UserHttp {
  private readonly o: UserHttpOptions;
  private readonly agent: Agent;
  private readonly bulkhead: Bulkhead;

  constructor(o: UserHttpOptions) {
    this.o = o;
    this.agent = new Agent({ keepAliveTimeout: 30_000, connections: 64 });
    this.bulkhead = new Bulkhead(64, (n) => o.metrics.be.outboundInflight.set({ target: o.dependency }, n));
  }

  /** Sends one request; a non-2xx answer becomes the dependency's BeError (problem+json restored). */
  async request(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<UResponse> {
    refuseInTx();
    const u = currentUnit();
    const token = u?.rawToken();
    if (!u?.user || !token) throw platformError("TOKEN_INVALID", undefined, "user-plane HTTP needs a user in the context (P8.1)");
    const timeout = outboundTimeoutMs();
    const leave = this.bulkhead.enter();
    try {
      const headers: Record<string, string> = { ...init.headers, authorization: `Bearer ${token}`, "x-request-id": u.requestId };
      propagation.inject(context.active(), headers);
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const attempt = () => this.send(method, path, { method, headers, body, dispatcher: this.agent, signal: AbortSignal.any([u.signal, AbortSignal.timeout(timeout)]) });
      let res: UResponse;
      try {
        res = await attempt();
      } catch (e) {
        if (method !== "GET" || !RESET.has(causeCode(e))) throw e;
        res = await attempt(); // P8.2: GET only, once, on a reset connection
      }
      if (res.status >= 400) throw await restored(res);
      return res;
    } catch (e) {
      throw outboundError(e);
    } finally {
      leave();
    }
  }

  async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, { body });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private async send(method: string, path: string, init: URequestInit): Promise<UResponse> {
    const start = performance.now();
    let status = "error";
    try {
      const res = await ufetch(`http://${this.o.address}${path}`, init);
      status = String(res.status);
      return res;
    } finally {
      this.o.metrics.be.httpClientRequests.inc({ target: this.o.dependency, method, status_code: status });
      this.o.metrics.be.httpClientDuration.observe({ target: this.o.dependency, method }, (performance.now() - start) / 1000);
    }
  }

  close(): Promise<void> {
    return this.agent.close();
  }
}

export interface ExternalHttpOptions {
  memberId: string;
  name: string;
  metrics: MemberRegistry;
  timeoutMs?: number;
  maxConns?: number;
}

/** A named third-party client (P8.3): 10 s default timeout, traced and counted, no internal header forwarded. */
export class ExternalHttp {
  private readonly o: ExternalHttpOptions;
  private readonly agent: Agent;

  constructor(o: ExternalHttpOptions) {
    this.o = o;
    this.agent = new Agent({ connections: o.maxConns ?? 32 });
  }

  async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<UResponse> {
    refuseInTx();
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) {
      const lk = k.toLowerCase();
      if (lk === "authorization" || lk.startsWith("be-") || lk.startsWith("x-authz-") || lk === "x-request-id") continue;
      headers[k] = v;
    }
    const start = performance.now();
    let status = "error";
    try {
      const res = await ufetch(url, { method, headers, body: init.body, dispatcher: this.agent, signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
      status = String(res.status);
      return res;
    } finally {
      this.o.metrics.be.httpClientRequests.inc({ target: this.o.name, method, status_code: status });
      this.o.metrics.be.httpClientDuration.observe({ target: this.o.name, method }, (performance.now() - start) / 1000);
    }
  }

  close(): Promise<void> {
    return this.agent.close();
  }
}

function causeCode(e: unknown): string {
  const c = (e as { cause?: { code?: string } })?.cause;
  return c?.code ?? (e as { code?: string })?.code ?? "";
}

async function restored(res: UResponse): Promise<BeError> {
  const ct = res.headers.get("content-type") ?? "";
  let problem: Record<string, unknown> | null = null;
  if (ct.includes("json")) problem = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  else await res.text().catch(() => "");
  return restoreHttp(res.status, problem);
}

function outboundError(e: unknown): unknown {
  if (isBeError(e)) return e;
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return platformError("DEADLINE_BUDGET_EXHAUSTED", undefined, "the outbound deadline passed");
  return new BeError("UNAVAILABLE", "", { message: `user-plane call failed: ${(e as Error)?.message}`, cause: e });
}
