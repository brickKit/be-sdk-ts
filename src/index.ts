// @brickkit/be-sdk-ts — the official TypeScript runtime of the BrickEnterprise component protocol, be-protocol 1.0.
// A component is `main(defineComponent({ id, migrations, contracts, create }))`; everything else it touches is
// exported here. Names follow sdk-redesign §5.2 (the same nouns as be-sdk-go and be-sdk-python).

// entry point and module
export { defineComponent, type ComponentSpec, type Module, type Spec } from "./runtime/spec.js";
export { main, runMain, type MainIO, type MainResult, type ServeHandle } from "./runtime/main.js";
export { Runtime, type Clock } from "./runtime/runtime.js";

// configuration
export { Config } from "./config/config.js";
export { Secret } from "./config/secret.js";

// unit of work, access, errors
export { deadline, signal, requestId, system, callerOf, type SystemPrincipal } from "./context.js";
export { access, Access, type User } from "./auth/access.js";
export { PUBLIC, AUTHENTICATED, type Guard, type PermKey } from "./auth/guard.js";
export { BeError, beError, platformError, isBeError, type Violation } from "./errors/beError.js";
export { DependencyAbsentError, isDependencyAbsent } from "./errors/dependencyAbsent.js";

// HTTP
export { Router, type Handler, type RouteOptions } from "./http/router.js";
export { UserHttp, ExternalHttp } from "./outbound/http.js";

// database
export { Store, Tx, isLockTimeout, isUniqueViolation, type TxOptions, type Isolation, type DbIdentity } from "./store/index.js";

// command idempotency
export { idempotent, commandKey, fingerprint, type Command, type Prior } from "./idempotency/index.js";

// events
export { permanent, PermanentError, type EventInput, type EventsDeclaration, type Subscription, type ConsumedEvent } from "./events/types.js";

// gRPC
export { unary, fromStatus, type GrpcRegistrar, type ServiceOptions, type ClientCtor, type ProtoMetadataLike } from "./grpc/index.js";

// identifiers
export { newId, idTime } from "./ids.js";

// the mobile BFF
export { guard, mountGraphQL, type GraphQLOptions } from "./graphql/graphql.js";
export { createBatchGetLoader } from "./dataloader.js";
