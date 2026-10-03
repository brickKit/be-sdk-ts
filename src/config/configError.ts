/** A configuration problem found at start (P1.2, P2.3): reported one log line per key, exit 78. */
export class ConfigError extends Error {
  readonly reason: string;
  readonly key: string;
  constructor(reason: string, key: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
    this.key = key;
  }
}

/** Every configuration problem of one start, collected before the process exits 78. */
export class ConfigErrors extends Error {
  readonly errors: ConfigError[];
  constructor(errors: ConfigError[]) {
    super(errors.map((e) => `${e.key}: ${e.message}`).join("; "));
    this.name = "ConfigErrors";
    this.errors = errors;
  }
}
