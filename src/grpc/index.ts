// The system plane (P7): the member's gRPC server and its outbound clients.
export { buildGrpcServer, type GrpcRegistrar, type GrpcServer, type GrpcServerDeps, type ServiceOptions } from "./server.js";
export { GrpcClients, unary, type AddressSource, type ClientCtor, type FamilyGrpcKey, type GrpcClientsDeps } from "./clients.js";
export { DependencyAbsentError, isDependencyAbsent } from "../errors/dependencyAbsent.js";
export { fromStatus, toStatus, STATUS_DETAILS_KEY } from "./errors.js";
export { serviceConfig, type ProtoMetadataLike } from "./descriptors.js";
export { DEFAULT_MAX_ITEMS } from "./batchLimits.js";
