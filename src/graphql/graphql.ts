// The mobile BFF's GraphQL surface (P3.1 exception, P4.5): graphql-yoga mounted on the member's Fastify instance
// at /graphql, persisted operations only, depth and cost limits, every resolver behind `guard(key, resolver)`,
// errors as `extensions = {code, reason, domain, metadata, request_id, trace_id}`.
import { trace } from "@opentelemetry/api";
import { EnvelopArmorPlugin } from "@escape.tech/graphql-armor";
import { usePersistedOperations, type UsePersistedOperationsOptions } from "@graphql-yoga/plugin-persisted-operations";
import { GraphQLError, type GraphQLFieldResolver, type GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { currentUnit } from "../context.js";
import { BeError, platformError, isBeError } from "../errors/beError.js";
import { httpStatus } from "../errors/codes.js";
import { publicError } from "../errors/problem.js";
import type { HttpServer } from "../http/server.js";

const MAX_DEPTH = 5;
const MAX_COST = 100;

export interface GraphQLOptions {
  schema: GraphQLSchema;
  context?: () => Record<string, unknown>;
  getPersistedOperation: UsePersistedOperationsOptions["getPersistedOperation"];
}

/** Wraps a resolver with the route decision chain of P6.2; `PUBLIC` is explicit, never implied. */
export function guard<S, C, A>(key: string, resolver: GraphQLFieldResolver<S, C, A>): GraphQLFieldResolver<S, C, A> {
  return async (source, args, ctx, info) => {
    const u = currentUnit();
    if (!u?.authorize) throw platformError("INTERNAL", undefined, "guard() outside a request");
    await u.authorize(key);
    return resolver(source, args, ctx, info);
  };
}

/** The GraphQL error a client sees for any thrown value. */
export function toGraphQLError(err: unknown, memberId: string): GraphQLError {
  // duck-typed: graphql-yoga and this module may load different builds of `graphql` (instanceof fails)
  const wrapped = err as { originalError?: unknown; locations?: unknown; extensions?: unknown };
  const original = wrapped?.originalError ?? err;
  if (wrapped?.originalError === undefined && wrapped?.extensions !== undefined) return err as GraphQLError; // a parse or validation error
  const e = publicError(isBeError(original) ? original : new Error(String(original)), memberId);
  const u = currentUnit();
  const status = httpStatus(e.code, e.reason, e.domain);
  return new GraphQLError(e.code === "INTERNAL" ? "internal error" : e.message, {
    extensions: {
      code: e.code, reason: e.reason, domain: e.domain, metadata: e.metadata,
      request_id: u?.requestId ?? "", trace_id: trace.getActiveSpan()?.spanContext().traceId ?? "",
      http: { status, headers: (original as { headers?: Record<string, string> })?.headers },
    },
  });
}

export function mountGraphQL(srv: HttpServer, o: GraphQLOptions): void {
  const memberId = srv.router.prefix.slice(1);
  srv.router.protectedRoutes++; // resolvers are guarded: readiness waits for the bundle
  const yoga = createYoga({
    schema: o.schema,
    context: o.context,
    graphqlEndpoint: "/graphql",
    logging: false,
    maskedErrors: { maskError: (error) => toGraphQLError(error, memberId) },
    plugins: [
      EnvelopArmorPlugin({ maxDepth: { enabled: true, n: MAX_DEPTH }, costLimit: { enabled: true, maxCost: MAX_COST } }),
      usePersistedOperations({ getPersistedOperation: o.getPersistedOperation, allowArbitraryOperations: false }),
    ],
  });
  srv.app.route({
    url: "/graphql",
    method: ["GET", "POST"],
    handler: async (req, reply) => {
      const res = await yoga.handleNodeRequestAndResponse(req, reply, {});
      res.headers.forEach((v, k) => void reply.header(k, v));
      reply.status(res.status);
      return reply.send(res.body);
    },
  });
}
