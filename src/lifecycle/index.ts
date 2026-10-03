// The data lifecycle engine (be-protocol P16), phase P0: hot and warm tiers, every cold adapter `none`.
export { LifecycleEngine, type EngineOptions, type RunReport } from "./engine.js";
export { parseDataLifecycle, DATA_LIFECYCLE } from "./config.js";
export {
  loadDeclaration, parseDeclaration, effectiveTables, checkAllDeclared, checkNumericPrecision, checkWorm, readTables, readColumnTypes,
  LifecycleDeclarationError, DECLARATION_FILE,
} from "./declaration.js";
export { plan, type PlanOptions } from "./planner.js";
export { UnitDigest, chainDigest, computeDigest } from "./digest.js";
export { readWindow, windowCondition, type ReadRange } from "./window.js";
export { LIFECYCLE_ROUTES, permissionKey, type LifecycleRoute, type LifecycleRequest, type LifecycleResponse } from "./routes.js";
export { lifecycleSubject, type EmitFn } from "./context.js";
export type { SealOutcome, VerifyReport } from "./seal.js";
export type { ActionResult, Outcome } from "./executor.js";
export type { FiscalCalendar } from "./rules.js";
export type * from "./types.js";
