/**
 * A protocol rule broken by the caller of an SDK function (an unknown code name, a malformed subject):
 * a programming or configuration error, never an answer to a request. `reason` is the vector error class.
 */
export class SpecError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "SpecError";
    this.reason = reason;
  }
}
