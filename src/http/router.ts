// User-plane routes under /{domain}/{name} (P3.1). Every route declares exactly one guard (P6.2): a permission
// key, PUBLIC or AUTHENTICATED; a route's deadline and body limit default to HTTP_DEFAULT_TIMEOUT and 1 MiB (P3.4,
// P3.6, P3.13).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Guard } from "../auth/guard.js";

export interface RouteOptions {
  /** the route's deadline (x-be-deadline-seconds); orchestrating routes declare 15 s */
  timeoutMs?: number;
  /** the route's body limit (x-be-max-body-bytes) */
  bodyLimit?: number;
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class Router {
  private readonly app: FastifyInstance;
  readonly prefix: string;

  constructor(app: FastifyInstance, memberId: string) {
    this.app = app;
    this.prefix = `/${memberId}`;
  }

  get(path: string, guard: Guard, h: Handler, o?: RouteOptions): void {
    this.add("GET", path, guard, h, o);
  }
  post(path: string, guard: Guard, h: Handler, o?: RouteOptions): void {
    this.add("POST", path, guard, h, o);
  }
  put(path: string, guard: Guard, h: Handler, o?: RouteOptions): void {
    this.add("PUT", path, guard, h, o);
  }
  patch(path: string, guard: Guard, h: Handler, o?: RouteOptions): void {
    this.add("PATCH", path, guard, h, o);
  }
  delete(path: string, guard: Guard, h: Handler, o?: RouteOptions): void {
    this.add("DELETE", path, guard, h, o);
  }

  private add(method: Method, path: string, guard: Guard, handler: Handler, o: RouteOptions = {}): void {
    if (typeof guard !== "string" || guard === "") throw new Error(`route ${method} ${path}: a guard is required (a key, PUBLIC or AUTHENTICATED)`);
    if (!path.startsWith("/")) throw new Error(`route path ${path} must start with /`);
    this.app.route({
      method,
      url: this.prefix + path,
      handler,
      config: { guard },
      ...(o.timeoutMs ? { handlerTimeout: o.timeoutMs } : {}),
      ...(o.bodyLimit ? { bodyLimit: o.bodyLimit } : {}),
    });
  }
}
