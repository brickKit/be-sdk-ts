// "Not installed" is a value, not an empty string (sdk-redesign-apis §1.3, P2.5): asking for a connection to an
// optional dependency whose address variable does not exist throws this error, and only this one, so a module
// can catch it and degrade. A required dependency is always present: brickKit refuses to start without it.
export class DependencyAbsentError extends Error {
  readonly dependency: string;
  readonly port: string;

  constructor(dependency: string, port: string) {
    super(`dependency ${dependency} (port ${port || "main"}) is not installed: its address variable does not exist`);
    this.name = "DependencyAbsentError";
    this.dependency = dependency;
    this.port = port;
  }
}

export function isDependencyAbsent(e: unknown): e is DependencyAbsentError {
  return e instanceof Error && e.name === "DependencyAbsentError";
}
