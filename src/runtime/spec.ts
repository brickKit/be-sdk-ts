// What a component declares (sdk-redesign-apis §4): `defineComponent({id, migrations, contracts, create})` and
// the Module its `create` returns. Names are the cross-language nouns of sdk-redesign §5.2.
import type { Runtime } from "./runtime.js";
import type { Router } from "../http/router.js";
import type { EventsDeclaration } from "../events/types.js";

export interface ComponentSpec {
  /** "erp/sales"; checked against COMPONENT_ID at start (exit 78 when they differ) */
  id: string;
  /** directory of node-pg-migrate SQL files + lifecycle.yaml; absent = no database */
  migrations?: string;
  /** directory of contracts/ (errors.yaml, events/*.events.json) */
  contracts?: string;
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
  /** one-time initialisation, at most 30 s, never a loop (P1.10) */
  start?: (signal: AbortSignal) => Promise<void>;
  stop?: () => Promise<void>;
}

/** What Module.grpc receives: the member's server, every method wrapped by the SDK's interceptor chain. */
export interface GrpcRegistrar {
  addService(definition: object, implementation: object, options?: { userFacing?: string[] }): void;
}

export function defineComponent(spec: ComponentSpec): Spec {
  if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(spec.id)) throw new Error(`not a component ID: ${spec.id}`);
  return { ...spec, kind: "be.component" };
}
