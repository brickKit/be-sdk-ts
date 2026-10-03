// What a component declares (sdk-redesign-apis §4): `defineComponent({id, migrations, contracts, create})` and
// the Module its `create` returns. Names are the cross-language nouns of sdk-redesign §5.2.
import type { Runtime } from "./runtime.js";
import type { Router } from "../http/router.js";
import type { EventsDeclaration } from "../events/types.js";
import type { GrpcRegistrar } from "../grpc/server.js";
import type { Job, Reconciler, Worker } from "../jobs/types.js";
import type { ResourceType } from "../auth/evaluate.js";
import type { RecordLoader } from "./resources.js";

export interface ComponentSpec {
  /** "erp/sales"; checked against COMPONENT_ID at start (exit 78 when they differ) */
  id: string;
  /** directory of node-pg-migrate SQL files + lifecycle.yaml; absent = no database */
  migrations?: string;
  /** directory of contracts/ (errors.yaml, events/*.events.json) */
  contracts?: string;
  /** the domain of the component's own errors; default `id`. A slot-family member gives its family's ID (P4.1) */
  errorDomain?: string;
  /**
   * The resource types this component owns (assembly.yaml `resources`, catalogue shape): the migrate step creates
   * the ACL projection, the runtime pulls it and mounts the resource contract (P6.10, P6.12)
   */
  resources?: ResourceType[];
  /** the image's component.yaml; default `component.yaml` in the working directory */
  manifest?: string;
  create: (rt: Runtime) => Promise<Module>;
}

export interface Spec extends ComponentSpec {
  readonly kind: "be.component";
}

export interface Module {
  /** user-plane routes under /{domain}/{name}; the SDK owns the Fastify instance */
  http?: (r: Router) => void;
  /** system-plane services; the SDK owns the server and its interceptors */
  grpc?: (s: GrpcRegistrar) => void;
  events?: EventsDeclaration;
  /** per declared resource type, how to read one record for _authz/check and _authz/explain */
  records?: Record<string, RecordLoader>;
  /** background work (P14): every / singleton / cron jobs, queue workers, reconcilers */
  jobs?: Job[];
  workers?: Worker[];
  reconcilers?: Reconciler[];
  /** one-time initialisation, at most 30 s, never a loop (P1.10) */
  start?: (signal: AbortSignal) => Promise<void>;
  stop?: () => Promise<void>;
}

export type { GrpcRegistrar };

export function defineComponent(spec: ComponentSpec): Spec {
  if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(spec.id)) throw new Error(`not a component ID: ${spec.id}`);
  return { ...spec, kind: "be.component" };
}
