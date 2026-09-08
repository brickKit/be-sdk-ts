/**
 * be-sdk-ts：TypeScript 横切基础库（总纲 §4 SOP-L，只有一半能力）。
 *
 * 顶层导出保持与 `be-sdk-go`/`be-sdk-python` 对应的能力名——`endpoint()`
 * 对应 Go 的 `Endpoint()`/Python 的 `endpoint()`，以此类推。两份 SDK
 * 已有的公开 API 要同名、同参数顺序、同语义（总纲 §3.5.1）；本文件是
 * 第三份，同样的约束。
 */

export { endpoint, mustEndpoint, storageEndpoint, type EndpointResult } from "./endpoint.js";
export { Config, configEnvVarName } from "./config.js";
export type { Runtime } from "./runtime.js";
export type { Module } from "./module.js";
export { bootstrap, runStandalone } from "./standalone.js";
export { newGraphQLServer, type GraphQLServerOptions } from "./graphqlServer.js";
export { createBatchGetLoader } from "./dataloader.js";
export { PUBLIC, requirePermission, type PermKey } from "./authz.js";
export { scopeOf, type ScopeFilter } from "./scope.js";
export { userClient, systemClient } from "./client.js";
