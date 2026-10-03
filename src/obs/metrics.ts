// One Prometheus registry per member (P18.3), every series labelled `component`; the protocol's `be_` metrics.
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function beMetrics(r: Registry) {
  const reg = { registers: [r] };
  const c = (name: string, help: string, labelNames: string[] = []) => new Counter({ name, help, labelNames, ...reg });
  const g = (name: string, help: string, labelNames: string[] = []) => new Gauge({ name, help, labelNames, ...reg });
  const h = (name: string, help: string, labelNames: string[] = []) => new Histogram({ name, help, labelNames, buckets: SECONDS, ...reg });
  return {
    httpServerRequests: c("be_http_server_requests_total", "HTTP requests served", ["method", "route", "status_code"]),
    httpServerDuration: h("be_http_server_duration_seconds", "HTTP request duration", ["method", "route"]),
    httpClientRequests: c("be_http_client_requests_total", "outbound HTTP requests", ["target", "method", "status_code"]),
    httpClientDuration: h("be_http_client_duration_seconds", "outbound HTTP duration", ["target", "method"]),
    grpcServerHandled: c("be_grpc_server_handled_total", "gRPC calls served", ["service", "method", "code"]),
    grpcServerDuration: h("be_grpc_server_duration_seconds", "gRPC call duration", ["service", "method"]),
    grpcClientHandled: c("be_grpc_client_handled_total", "outbound gRPC calls", ["target", "method", "code"]),
    grpcClientDuration: h("be_grpc_client_duration_seconds", "outbound gRPC duration", ["target", "method"]),
    outboundInflight: g("be_outbound_inflight", "outbound calls in flight", ["target"]),
    dbPoolInUse: g("be_db_pool_in_use", "connections held by this member"),
    dbPoolWait: h("be_db_pool_wait_seconds", "wait for a connection"),
    txRetries: c("be_tx_retries_total", "transaction re-runs", ["reason"]),
    dbIdentityOk: g("be_db_identity_ok", "1 when the database identity probe passed"),
    secretReloadFailures: c("be_secret_reload_failures_total", "failed re-reads of a secret file", ["key"]),
    outboxPending: g("be_outbox_pending", "outbox rows not yet published"),
    outboxOldestAge: g("be_outbox_oldest_age_seconds", "age of the oldest unpublished outbox row"),
    eventsPublished: c("be_events_published_total", "events acknowledged by the bus", ["subject"]),
    consumerHandled: c("be_consumer_handled_total", "deliveries handled", ["subject", "result"]),
    consumerLag: g("be_consumer_lag_seconds", "age of the last handled event", ["subject"]),
    dlqMessages: c("be_dlq_messages_total", "messages dead-lettered", ["subject"]),
    authzBundleAge: g("be_authz_bundle_age_seconds", "age of the loaded authorization bundle"),
    authzDenied: c("be_authz_denied_total", "requests refused by authentication or authorization", ["reason"]),
  };
}

export type BeMetrics = ReturnType<typeof beMetrics>;

export interface MemberRegistry {
  registry: Registry;
  be: BeMetrics;
}

export function newMemberRegistry(componentId: string): MemberRegistry {
  const registry = new Registry();
  registry.setDefaultLabels({ component: componentId });
  return { registry, be: beMetrics(registry) };
}
